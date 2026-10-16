// Named server configurations — the multi-server registry (board #55).
//
// The client always had exactly ONE server in its keys (`tmux_address` /
// `tmux_token` / `tmux_socket`), with `tmux_address_history` as an unnamed
// recents list behind the Settings form. This module makes the servers a
// first-class REGISTRY (`tmux_servers`, named entries with stable ids), the
// ONLY list of remembered connections: the history key is folded in once and
// retired (board #400), and the connect form's suggestions are read off the
// registry (`rememberedAddresses`), so a server deleted in Settings is gone
// from the form too. The old single-server keys stay as the ACTIVE MIRROR (the
// connection CURRENT names, not a list): everything that
// already reads them — ws.ts, the reconnect machine, deep links, the Settings
// form, the boot auto-connect — keeps working unchanged, and a downgraded
// client sees exactly the single-server world it expects.
//
// Switching servers happens in place (board 315; it was a reload until then):
// App's switchTo owns the order, and this module owns its storage half,
// which since board #335 ②b-4 is only MOVING CURRENT. Every per-server key
// (RESIDENT_KEYS) lives in its server's own slot, `<key>::<id>`, all the
// time — the server-store view reads and writes there — so a switch has
// nothing to file away and nothing to surface: what you were looking at on
// server A is in A's slot when you come back from server B (the "恢复目标
// 不能串" half). Until ②b-4 a switch PARKED the leaving server's live keys
// and POINTED the target's slot into them; the one-time fold
// (server-state-migration.ts) is what remains of that. The in-memory half
// (component trees, module caches) is the runtime's server state and the
// keyed content remount. `tmux_machines` itself stays GLOBAL — it is keyed by
// machineId, so entries cannot contaminate each other by design.
//
// Framework-free and storage-injected so migration, upsert and the switch
// plan are unit-testable without a browser.

import { fingerprint, mergeSlot, recordLost } from './slot-merge.ts';

export interface ServerEntry {
  id: string;
  name: string;
  /** The ACTIVE address — the one the last successful connect used. The same
   *  machine's other addresses stay in `tmux_machines[machineId]`, which is
   *  the existing failover set; this entry only picks the starting point. */
  address: string;
  token: string;
  socket?: string;
  /** The server's machine identity (ws.ts `getMachineId()` after connect).
   *  One machine = ONE entry, however many LAN/Tailscale/WAN addresses it
   *  answers on — address is how you REACH a server, machineId is WHICH
   *  server it is (lead review, board #55). Absent until first connect. */
  machineId?: string;
  /** The user typed this name (renameServer). Without it the name is the
   *  DEFAULT: the server's own hostname once an auth has reported it, and
   *  hostLabel(address) only as the pre-auth placeholder (board #310). */
  named?: true;
  /** The hostname this entry last adopted as its name, so a later auth can
   *  tell an adopted name (follow the server) from an old hand rename. */
  hostname?: string;
}

export const SERVERS_KEY = 'tmux_servers';
export const CURRENT_KEY = 'tmux_server_current';
/** The recents list the registry replaced (board #400). Nothing reads or
 * writes it any more; `migrateServers` folds it once and removes it. */
export const HISTORY_KEY = 'tmux_address_history';
export const MAX_SERVERS = 16;
/** Which entry each ABSORBED entry was folded into, `{ [absorbed]: survivor }`
 * (board #335 ②b-2, reviewer P1-a, 2026-10-10). Written only where an
 * absorption happens (`forgetDropped`), so it is the identity layer's own
 * record of the merges it actually made — the one thing that lets a holder of
 * an old id follow it to the survivor. An id that is merely ABSENT from the
 * registry proves nothing: it may have been forgotten, or never saved. */
export const MERGES_KEY = 'tmux_server_merges';
/** Merges kept. Ids are never reused, so an old row cannot misdirect anything;
 * the cap only bounds the key. */
const MAX_MERGES = 32;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** What a function that only READS the registry needs. */
type Reader = Pick<Storage, 'getItem'>;

export function serverId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** A short human name out of a ws address: host without scheme/port/path.
 *  `ws://192.168.1.5:9899` → `192.168.1.5`; `wss://mac.tail.ts.net/ws` →
 *  `mac.tail.ts.net`. The fallback keeps whatever was typed. */
export function hostLabel(address: string): string {
  const m = /^wss?:\/\/([^/:?#]+)/.exec(address.trim());
  return m?.[1] || address.trim();
}

/** What the CURRENT server is called outside the list (rail hover card, the
 *  phone's Settings row, the switch panel): the saved entry's name — the
 *  same name its row shows, the hostname unless the user renamed it (board
 *  #319, owner 2026-10-08: "设置显示当前连接的名字，不是列表里的那个名字").
 *  The entry is this machine's, else the current one, the same lookup the
 *  hostname adoption uses. With no entry yet: hostname, then the URL host. */
export function currentServerName(
  servers: ServerEntry[], currentId: string,
  info: { hostname?: string; machineId?: string }, address: string,
): string {
  const entry = (info.machineId && servers.find((s) => s.machineId === info.machineId))
    || servers.find((s) => s.id === currentId);
  return entry?.name || info.hostname || hostLabel(address);
}

function sanitize(raw: unknown): ServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ServerEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { id, name, address, token, socket, machineId, named, hostname } = e as Record<string, unknown>;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (typeof address !== 'string' || !address) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof name === 'string' && name ? name : hostLabel(address),
      address,
      token: typeof token === 'string' ? token : '',
      ...(typeof socket === 'string' && socket ? { socket } : {}),
      ...(typeof machineId === 'string' && machineId ? { machineId } : {}),
      ...(named === true ? { named: true as const } : {}),
      ...(typeof hostname === 'string' && hostname ? { hostname } : {}),
    });
  }
  return out.slice(0, MAX_SERVERS);
}

/**
 * The name a server reports for itself replaces a DEFAULT name (board #310,
 * owner 2026-10-05: "显示的名称应该默认是主机的名称，不是连接的url"). A name
 * the user typed (`named`) is never touched. Entries from before #310 carry
 * no flag, so their name counts as default only while it still equals the
 * URL host it was derived from; a hand-renamed entry keeps its name. Once
 * adopted the hostname follows the server (a renamed host is renamed here)
 * and survives an address change. Pure; returns the same array when nothing
 * changed, so the caller can skip the write.
 */
export function adoptHostname(servers: ServerEntry[], id: string, hostname: string): ServerEntry[] {
  const host = hostname.trim();
  const at = servers.findIndex((s) => s.id === id);
  if (!host || at < 0) return servers;
  const entry = servers[at]!;
  if (entry.named || (entry.name === host && entry.hostname === host)) return servers;
  const isDefault = entry.name === hostLabel(entry.address) || entry.name === entry.hostname;
  if (!isDefault) return servers;
  const next = servers.slice();
  next[at] = { ...entry, name: host, hostname: host };
  return next;
}

export function loadServers(storage: Reader): ServerEntry[] {
  try { return sanitize(JSON.parse(storage.getItem(SERVERS_KEY) || '[]')); }
  catch { return []; }
}

export function saveServers(storage: Store, servers: ServerEntry[]): void {
  storage.setItem(SERVERS_KEY, JSON.stringify(servers.slice(0, MAX_SERVERS)));
}

export function currentServerId(storage: Reader): string {
  return storage.getItem(CURRENT_KEY) || '';
}

/**
 * One-time, idempotent migration from the single-server keys.
 *
 * Runs before the boot auto-connect. If the registry already exists nothing
 * is rebuilt (re-running must never duplicate or reorder): the retired
 * recents list is dropped unread, and identity repair runs. Otherwise the
 * CURRENT connection (`tmux_address`/`tmux_token`/`tmux_socket`) becomes the
 * first, current entry — the "don't lose the current user" clause — stamped
 * with `tmux_machine_id`, and the Settings recents (`tmux_address_history`)
 * follow as additional named entries, after which that key is removed
 * (board #400: the registry is the only list of remembered connections) —
 * EXCEPT addresses `tmux_machines` attributes to a machine that already has
 * an entry: those are the SAME server's LAN/Tailscale/WAN alternates (the
 * failover set), and splitting them into "servers" would break the
 * multi-address semantics this feature must not touch (lead review). A
 * history machine seen for the first time yields one entry (its first-seen
 * address as the active one); unattributed addresses dedupe by address as
 * before. A client with no stored connection at all migrates to an empty
 * registry and the Settings form remains the front door.
 */
export function migrateServers(storage: Store): ServerEntry[] {
  // A client that already has a registry has nothing to fold: every connect
  // that wrote a history row also recorded its server, so a row the registry
  // does not hold is a server the person deleted here, or an attempt that
  // never connected. Either way it is not a remembered connection.
  if (storage.getItem(SERVERS_KEY) != null) {
    retireHistory(storage);
    const repaired = repairServers(storage);
    reconcileMirror(storage);
    return repaired;
  }
  const servers: ServerEntry[] = [];
  // machineId → its addresses (the failover map is the identity authority).
  let machines: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(storage.getItem('tmux_machines') || '{}');
    if (raw && typeof raw === 'object') machines = raw;
  } catch { /* unreadable map — address-level dedupe still applies */ }
  const ownerOf = (addr: string): string => {
    for (const [mid, addrs] of Object.entries(machines)) {
      if (Array.isArray(addrs) && addrs.includes(addr)) return mid;
    }
    return '';
  };
  const covered = (addr: string): boolean => {
    const mid = ownerOf(addr);
    return servers.some((s) => s.address === addr || (mid && s.machineId === mid));
  };

  const addr = storage.getItem('tmux_address') || '';
  if (addr) {
    const mid = storage.getItem('tmux_machine_id') || ownerOf(addr);
    const cur: ServerEntry = {
      id: serverId(),
      name: hostLabel(addr),
      address: addr,
      token: storage.getItem('tmux_token') || '',
      ...(mid ? { machineId: mid } : {}),
    };
    const socket = storage.getItem('tmux_socket') || '';
    if (socket) cur.socket = socket;
    servers.push(cur);
    storage.setItem(CURRENT_KEY, cur.id);
  }
  try {
    const hist = JSON.parse(storage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(hist)) {
      for (const h of hist) {
        const a = typeof h === 'string' ? h : (h && typeof h.address === 'string' ? h.address : '');
        if (!a || covered(a)) continue;
        const mid = ownerOf(a);
        servers.push({
          id: serverId(), name: hostLabel(a), address: a,
          token: typeof h?.token === 'string' ? h.token : '',
          ...(mid ? { machineId: mid } : {}),
        });
      }
    }
  } catch { /* malformed history — the current entry alone is the migration */ }
  saveServers(storage, servers.slice(0, MAX_SERVERS));
  retireHistory(storage);
  reconcileMirror(storage);
  return loadServers(storage);
}

/** Remove the retired list. Best effort and idempotent: a key that cannot be
 * removed is read by nothing and must not freeze the registry, and the next
 * boot tries again. Called only once the registry is on disk. */
function retireHistory(storage: Store): void {
  try { if (storage.getItem(HISTORY_KEY) != null) storage.removeItem(HISTORY_KEY); } catch { /* retried at the next boot */ }
}

/** machineId → addresses, read off the failover map (identity authority). */
export function machinesMap(storage: Reader): Record<string, string[]> {
  try {
    const raw = JSON.parse(storage.getItem('tmux_machines') || '{}');
    if (raw && typeof raw === 'object') return raw;
  } catch { /* unreadable map — address-level matching still applies */ }
  return {};
}

/** Every address a saved server answers on: the active one first, then its
 * machine's failover set in priority order. The ONE definition of "this
 * server's addresses" — the connect form's suggestions and the mirror's
 * clean-up on removal both ask it. */
function addressesOf(storage: Reader, entry: ServerEntry): string[] {
  const set = entry.machineId ? machinesMap(storage)[entry.machineId] : undefined;
  const all = [entry.address, ...(Array.isArray(set) ? set : [])];
  return all.filter((a, i) => typeof a === 'string' && a && all.indexOf(a) === i);
}

/**
 * What the connect form offers to dial (board #400): the saved servers'
 * addresses, each with its server's token, and nothing else — the registry
 * is the only list of remembered connections. CURRENT's first, then the
 * registry's order; one row per address (an address two machines share —
 * a tunnel — is offered once, as the first of them has it). An attempt that
 * never connected is not here: only a connect that succeeded is recorded.
 */
export function rememberedAddresses(storage: Reader): { address: string; token: string }[] {
  const servers = loadServers(storage);
  const current = currentServerId(storage);
  const seen = new Set<string>();
  const rows: { address: string; token: string }[] = [];
  for (const entry of [...servers.filter((s) => s.id === current), ...servers.filter((s) => s.id !== current)]) {
    for (const address of addressesOf(storage, entry)) {
      if (seen.has(address)) continue;
      seen.add(address);
      rows.push({ address, token: entry.token });
    }
  }
  return rows;
}

/**
 * The ONE writer for a machine's failover address set (board #222): the
 * Connection page's remove and drag-reorder both reduce to saving the new
 * list, whose order IS the failover priority the reconnect round-robin walks.
 * Sanitized at the door (non-empty strings, deduped, order kept); an empty
 * set drops the key — the map holds only machines with addresses worth
 * failing over to. Returns the list as written.
 */
export function saveMachineAddresses(storage: Store, machineId: string, addresses: string[]): string[] {
  if (!machineId) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const a of addresses) {
    if (typeof a !== 'string' || !a || seen.has(a)) continue;
    seen.add(a);
    clean.push(a);
  }
  const machines = machinesMap(storage);
  if (clean.length) machines[machineId] = clean;
  else delete machines[machineId];
  storage.setItem('tmux_machines', JSON.stringify(machines));
  reconcileMirror(storage);       // an address dropped from the set may have been the mirror's
  return clean;
}

function ownerOfAddr(machines: Record<string, string[]>, addr: string): string {
  for (const [mid, addrs] of Object.entries(machines)) {
    if (Array.isArray(addrs) && addrs.includes(addr)) return mid;
  }
  return '';
}

/** Is this entry's name still a default (not typed by the user)? */
const defaultName = (e: ServerEntry) => !e.named && (e.name === hostLabel(e.address) || e.name === e.hostname);

/**
 * THE invariant (board 318, identity is the MACHINE per #55): one entry per
 * known machine, and an address names one entry unless two different known
 * machines have used it. A twin — another entry with the survivor's machine
 * id, or with its address and no machine id of its own (or the same one) — is
 * folded into the survivor and dropped; two entries whose known machine ids
 * differ both stay, whatever their addresses. The survivor keeps its identity
 * (id, machine, address, token); it takes the twin's name only when its own
 * is still a default and the twin's was typed. The twin's per-server slots
 * go with it — unless the twin was CURRENT: then CURRENT moves to the
 * survivor and so do the twin's slots, which hold the state the person was
 * just using on that machine, so nothing is lost. Before board 318 a
 * machine-id-less entry (migrated from the address history, or recorded
 * before the id was learned) holding the same address as the authenticated
 * entry could never merge: recordServer matched the machine id first and
 * never looked at the rest — the owner's "two same addresses, two servers".
 * Pure on the array; returns the survivor's slot list and what was dropped.
 */
function absorbTwins(servers: ServerEntry[], survivor: ServerEntry): string[] {
  const dropped: string[] = [];
  // How many different KNOWN machines have used the survivor's address. A
  // machine-less entry on that address can be attributed only when there is
  // exactly one; with several it is ambiguous and every entry stays as it is
  // (validator, board 318: attributing by array order took one machine's
  // token and parked state, from either direction).
  const known = new Set(servers.filter((t) => t.address === survivor.address && t.machineId).map((t) => t.machineId));
  const attributable = known.size <= 1;
  for (let i = servers.length - 1; i >= 0; i--) {
    const twin = servers[i]!;
    if (twin === survivor) continue;
    // Identity is the machine (#55): an address is shared by two entries
    // honestly when it reached two different known machines (a loopback
    // tunnel, ws://127.0.0.1:9899, leads wherever the tunnel goes).
    const sameMachine = !!survivor.machineId && twin.machineId === survivor.machineId;
    const byAddress = twin.address === survivor.address && attributable
      && (!twin.machineId || !survivor.machineId || twin.machineId === survivor.machineId);
    if (!sameMachine && !byAddress) continue;
    if (defaultName(survivor) && twin.named) { survivor.name = twin.name; survivor.named = true; }
    if (!survivor.machineId && twin.machineId) survivor.machineId = twin.machineId;
    servers.splice(i, 1);
    dropped.push(twin.id);
  }
  return dropped;
}

/**
 * Absorb `dropped` into `survivorId`, and `commit()` the registry without
 * them — in the ONE order that a failure at any step leaves recoverable
 * (board #335 ②b-4; reviewer P1s on 4807242f and 6a2ba341, orchestrator
 * 23:19; ③b: every twin, not only CURRENT, orchestrator 15:02/15:04):
 *
 *   1. one intent per (twin, survivor) is written, in ONE write, before any
 *      slot moves (`beginMoves`) — on every client, folded or pending;
 *   2. every twin's slots are MERGED into the survivor's (`slot-merge.ts`:
 *      a missing source never deletes, collections merge, a real conflict
 *      keeps the CURRENT twin's value — the state the person was just
 *      using — else the survivor's, and the loser is recorded);
 *   3. CURRENT moves to the survivor if a twin was current;
 *   4. the registry is committed without the twins, and the merges noted;
 *   5. only then are the twins' slots removed;
 *   6. last, each intent is closed (`completeMove`).
 *
 * Sources are removed only once the registry no longer lists them, and the
 * merge is idempotent, so a resume at any point merges again and finishes.
 */
function forgetDropped(storage: Store, dropped: string[], survivorId: string, commit: () => void): void {
  if (!dropped.length) { commit(); return; }
  const current = currentServerId(storage);
  beginMoves(storage, dropped.map((from) => ({ from, to: survivorId, wins: from === current ? 'source' as const : 'target' as const })));
  for (const move of loadMoves(storage).filter((m) => m.to === survivorId && dropped.includes(m.from))) mergeSlots(storage, move);
  if (dropped.includes(current)) storage.setItem(CURRENT_KEY, survivorId);
  commit();
  noteMerges(storage, dropped, survivorId);
  for (const id of dropped) for (const key of RESIDENT_KEYS) storage.removeItem(residentKey(key, id));
  for (const from of dropped) completeMove(storage, from, survivorId);
}

function loadMerges(storage: Store): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(MERGES_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([from, to]) => from && typeof to === 'string' && to));
  } catch { return {}; }
}

function noteMerges(storage: Store, dropped: string[], survivorId: string): void {
  const merges = loadMerges(storage);
  for (const id of dropped) { delete merges[id]; merges[id] = survivorId; }
  const kept = Object.entries(merges).slice(-MAX_MERGES);
  storage.setItem(MERGES_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/**
 * The saved entry `id` now IS, by the merges identity repair actually made:
 * `id` itself while it is saved, the survivor it was folded into (following a
 * chain of later merges), or '' when nothing shows it to be any saved entry.
 *
 * The '' case is the point (reviewer P1-a, 2026-10-10): an id absent from the
 * registry may have been forgotten, or belong to a record written by a server
 * this client never saved, and re-pointing it at whichever server is current
 * would open that server's same-named pane — a stranger's terminal.
 */
/** The survivor an absorbed `id` is being folded into, even while the
 * absorption is still OPEN — its registry committed but its merge note not
 * yet written (board #335 ③b, reviewer P1-B on 4c7cd64c): the move journal
 * names the destination from the moment the move began. `mergedInto` for a
 * finished merge; '' when `id` is neither saved nor being absorbed. */
export function absorbedInto(storage: Store, id: string): string {
  const done = mergedInto(storage, id);
  if (done) return done;
  const open = loadMoves(storage).find((m) => m.from === id);
  return open ? mergedInto(storage, open.to) : '';
}

export function mergedInto(storage: Store, id: string): string {
  if (!id) return '';
  const saved = new Set(loadServers(storage).map((s) => s.id));
  const merges = loadMerges(storage);
  let at = id;
  for (let hops = 0; hops <= MAX_MERGES; hops++) {
    if (saved.has(at)) return at;
    const next = merges[at];
    if (!next) return '';
    at = next;
  }
  return '';
}

/**
 * Heal a registry written before the invariant held (board 318): runs on
 * every boot through migrateServers, idempotent (a healthy list is returned
 * untouched and not rewritten). In each group of twins the survivor is the
 * CURRENT entry if it is in the group, else the one that knows its machine,
 * else the first.
 */
export function repairServers(storage: Store): ServerEntry[] {
  // An absorption a failure left open is finished FIRST, or this throws and
  // writes nothing (see `recordServer`). The repair itself never begins one
  // — the CURRENT entry is always the survivor of its group, so no slot of
  // CURRENT's moves — and this keeps it from committing a registry over a
  // handoff that is still owed.
  resumeSlotMove(storage);
  const servers = loadServers(storage);
  const cur = currentServerId(storage);
  const rank = (e: ServerEntry) => (e.id === cur ? 2 : e.machineId ? 1 : 0);
  for (const e of [...servers].sort((a, b) => rank(b) - rank(a))) {
    if (!servers.includes(e)) continue;          // already absorbed into a better survivor
    const dropped = absorbTwins(servers, e);
    if (!dropped.length) continue;
    forgetDropped(storage, dropped, e.id, () => saveServers(storage, servers));
  }
  return servers;
}

/**
 * RECORD a connection in the registry — and nothing else (lead review #2:
 * recording and ACTIVATING are different acts; the first must never move
 * CURRENT, or a Settings connect would arrive somewhere without the arrival).
 *
 * Identity is the machine when known: an explicit `machineId` (or, absent
 * that, the failover map's attribution of the address) matches that entry —
 * a new address of a known machine updates it in place. Otherwise address
 * match, then a new entry. Names survive (a rename outlives reconnects).
 */
export function recordServer(
  storage: Store,
  conn: { address: string; token: string; socket?: string; machineId?: string },
): { servers: ServerEntry[]; entry: ServerEntry } {
  // A handoff a failure left open is finished BEFORE any new identity is
  // written (reviewer P1 on b5adcb3b, orchestrator 23:31): a new absorption
  // of the same source must not replace its intent and then delete the only
  // copy the old one still owes its destination. If it cannot be finished,
  // this throws and writes nothing — the identity write is refused, and the
  // migration's next run reports it blocked, with Retry.
  resumeSlotMove(storage);
  const servers = loadServers(storage);
  const mid = conn.machineId || ownerOfAddr(machinesMap(storage), conn.address);
  let entry = mid ? servers.find((s) => s.machineId === mid) : undefined;
  // By address only when that entry is not ANOTHER known machine: a tunnel
  // address that now reaches B must not rename A's entry into B.
  if (!entry) entry = servers.find((s) => s.address === conn.address && (!mid || !s.machineId || s.machineId === mid));
  if (entry) {
    entry.address = conn.address;               // the address that just worked is the active one
    entry.token = conn.token;
    if (conn.socket) entry.socket = conn.socket; else delete entry.socket;
    if (mid) entry.machineId = mid;
  } else {
    entry = {
      id: serverId(), name: hostLabel(conn.address),
      address: conn.address, token: conn.token,
      ...(conn.socket ? { socket: conn.socket } : {}),
      ...(mid ? { machineId: mid } : {}),
    };
    servers.push(entry);
  }
  forgetDropped(storage, absorbTwins(servers, entry), entry.id, () => saveServers(storage, servers));
  return { servers, entry };
}

/** Everything that is "where I was on THIS server", resident per server id
 * as `<key>::<id>` (board #335 ②b-4; until then it was parked there while
 * another server was current, and live unprefixed while its own was).
 * `tmux_state` is the nav state (tab, terminal target, split),
 * `tmux_machine_id` the machine, and the Hub keys are per-PROJECT maps keyed
 * by tmux session name — a project called `app` on server A is not `app` on
 * server B, so its draft, read marker, chosen lead, drawer and roster
 * disclosure must not follow the user across (board 315). Keys must match
 * hub-prefs.svelte.ts; a test pins it. The unprefixed spellings are the
 * pre-#335 LEGACY inputs: read once by the fold, written by nothing. */
export const RESIDENT_KEYS = [
  'tmux_state', 'tmux_machine_id',
  'tmux_hub_project', 'tmux_hub_drafts', 'tmux_hub_seen', 'tmux_hub_lead',
  'tmux_hub_drawer', 'tmux_hub_roster_expanded', 'tmux_hub_alerts',
] as const;

/** Where a per-server key lives. The ONE place that spells the layout, so
 * nothing reconstructs `${key}::${id}` by hand. */
export function residentKey(key: string, serverId: string): string {
  return `${key}::${serverId}`;
}

/** The migration's one marker (server-state-migration.ts owns its meaning).
 * Spelled here because moving a slot has to move its bookkeeping too. */
export const LAYOUT_KEY = 'tmux_state_layout';

/** The open slot moves, one per (from, to) (board #335 ③b): their own key,
 * so a folded client records them as a pending one does. Everything a move
 * decides is fixed when it BEGINS, from the values before any write, so a
 * resume after a partial move decides the same: `wins`, the conflict rule;
 * and, while pre-#335 inputs are pending, `base` (the survivor slot's new
 * claim baseline per key, null = none) and `clear` (keys the CURRENT twin
 * provably cleared since — see `planMove`). */
export const MOVES_KEY = 'tmux_slot_moves';
type Move = { from: string; to: string; wins: 'source' | 'target'; base?: Record<string, string | null>; clear?: string[] };

/** The open moves. A journal that cannot be read — unparsable, not a list,
 * or a row that does not name its pair — THROWS rather than reading as "no
 * move open" (reviewer P1 on 97824925, orchestrator 02:21): an unfinished
 * handoff skipped that way lets the next absorption merge destructively over
 * it. The throw reaches the caller's host gate, which blocks until Retry. */
function loadMoves(storage: Pick<Storage, 'getItem'>): Move[] {
  const raw: unknown = JSON.parse(storage.getItem(MOVES_KEY) || '[]');
  if (!Array.isArray(raw)) throw new Error(`${MOVES_KEY} is not a list`);
  return raw.map((m) => {
    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string' || !m.from || !m.to) throw new Error(`${MOVES_KEY} holds a row without its pair`);
    return {
      from: m.from, to: m.to, wins: m.wins === 'source' ? 'source' as const : 'target' as const,
      ...(m.base && typeof m.base === 'object' ? { base: m.base as Record<string, string | null> } : {}),
      ...(Array.isArray(m.clear) ? { clear: (m.clear as unknown[]).filter((k): k is string => typeof k === 'string') } : {}),
    };
  });
}
function saveMoves(storage: Store, moves: Move[]): void {
  if (moves.length) storage.setItem(MOVES_KEY, JSON.stringify(moves)); else storage.removeItem(MOVES_KEY);
}

/** What a move owes a PENDING claim, decided from the values before it.
 * The claim keeps a slot that changed since the inputs went pending (an
 * owner's write) and folds the inputs over one that did not; a move is not
 * a write, so per key:
 *
 *   - both sides unchanged since: the merged value is not an edit either —
 *     its fingerprint is the new baseline, and the claim folds over it;
 *   - either side changed since: the merge carries an edit — no baseline,
 *     so the claim keeps it;
 *   - the CURRENT twin CLEARED the key since (it had a value when the inputs
 *     went pending, none now) and the survivor's did not change: that clear
 *     is the person's, so the survivor's old value goes too, and the twin's
 *     baseline marks the slot "cleared since" — the claim keeps it cleared
 *     (reviewer P1-B on 4807242f). Without that proof a missing source
 *     never deletes. */
function planMove(storage: Store, m: { from: string; to: string; wins: 'source' | 'target' }, slots: Record<string, string>): Pick<Move, 'base' | 'clear'> {
  const base: Record<string, string | null> = {};
  const clear: string[] = [];
  const same = (print: string | undefined, value: string | null) => (value == null ? print === undefined : print === fingerprint(value));
  for (const key of RESIDENT_KEYS) {
    const fromKey = residentKey(key, m.from);
    const toKey = residentKey(key, m.to);
    const src = storage.getItem(fromKey);
    const dst = storage.getItem(toKey);
    const srcSame = same(slots[fromKey], src);
    const dstSame = same(slots[toKey], dst);
    if (src == null) {
      if (!srcSame && dstSame && m.wins === 'source') {
        if (dst != null) clear.push(key);
        base[key] = slots[fromKey] ?? null;
      }
      continue;
    }
    const merged = mergeSlot(key, dst, src, m.from, m.to, m.wins).value;
    base[key] = srcSame && dstSame && merged != null ? fingerprint(merged) : null;
  }
  return { base, clear };
}

/** Step 1: record every move's intent in one write; if it fails, nothing has
 * moved. A pair already open keeps its intent — it was decided from the
 * values before ITS start. */
function beginMoves(storage: Store, moves: { from: string; to: string; wins: 'source' | 'target' }[]): void {
  const open = loadMoves(storage);
  const mark = pendingMark(storage);
  const slots = mark?.slots && typeof mark.slots === 'object' ? mark.slots as Record<string, string> : null;
  const next = [...open];
  for (const m of moves) {
    if (!m.from || m.from === m.to || next.some((o) => o.from === m.from && o.to === m.to)) continue;
    next.push({ ...m, ...(mark ? planMove(storage, m, slots ?? {}) : {}) });
  }
  if (next.length !== open.length) saveMoves(storage, next);
}

/** Step 2, idempotent: merge every slot of `move.from` into `move.to`'s. */
function mergeSlots(storage: Store, move: Move): void {
  const { from, to, wins } = move;
  for (const key of RESIDENT_KEYS) {
    const target = storage.getItem(residentKey(key, to));
    if (move.clear?.includes(key)) { if (target != null) storage.removeItem(residentKey(key, to)); continue; }
    const source = storage.getItem(residentKey(key, from));
    if (source == null) continue;                                  // a missing source never deletes
    const { value, lost } = mergeSlot(key, target, source, from, to, wins);
    if (lost != null) recordLost(storage, { from, to, key, value: lost });
    if (value !== target) {
      if (value == null) storage.removeItem(residentKey(key, to)); else storage.setItem(residentKey(key, to), value);
    }
  }
}

/** Finish every absorption a failure left open (see `forgetDropped`), each
 * on its own: one that cannot finish does not hold the others, and the first
 * failure is thrown after all were tried, its intent still open. Which half
 * a move is in is the REGISTRY's to say:
 *
 *   - `from` still saved: the registry was never committed — the merge is
 *     re-run (idempotent) and the intent closed; the registry decides again;
 *   - `from` gone: the merge is committed — re-run it for whatever slots
 *     remain (a missing source writes nothing), then finish what follows:
 *     CURRENT off the absorbed id, the merge note, the cleanup.
 *
 * A pre-③b intent on the pending record (`moving`) is resumed the same way,
 * as the whole move it was. Returns whether one was open. */
export function resumeSlotMove(storage: Store): boolean {
  const moves = loadMoves(storage);
  const legacy = pendingMark(storage)?.moving as { from?: unknown; to?: unknown } | undefined;
  if (legacy && typeof legacy.from === 'string' && typeof legacy.to === 'string' && !moves.some((m) => m.from === legacy.from && m.to === legacy.to)) {
    moves.push({ from: legacy.from, to: legacy.to, wins: 'source' });
  }
  if (!moves.length) return false;
  let failed: unknown = null;
  for (const move of moves) {
    const { from, to } = move;
    try {
      mergeSlots(storage, move);
      if (!loadServers(storage).some((s) => s.id === from)) {
        if (currentServerId(storage) === from) storage.setItem(CURRENT_KEY, to);
        if (mergedInto(storage, from) !== to) noteMerges(storage, [from], to);
        for (const key of RESIDENT_KEYS) storage.removeItem(residentKey(key, from));
      }
      completeMove(storage, from, to);
    } catch (e) { failed ??= e; }
  }
  if (failed) throw failed;
  return true;
}

/** Step 6: close the intent — and, while pre-#335 inputs are pending, give
 * the survivor's slots the baselines the move decided (`planMove`), in the
 * pending record's own write. A pre-③b intent, which decided none, hands
 * the twin's baselines over as its whole copy did. */
function completeMove(storage: Store, fromId: string, toId: string): void {
  const intent = loadMoves(storage).find((m) => m.from === fromId && m.to === toId);
  const mark = pendingMark(storage);
  if (mark) {
    const slots: Record<string, string> = { ...(mark.slots && typeof mark.slots === 'object' ? mark.slots as Record<string, string> : {}) };
    for (const key of RESIDENT_KEYS) {
      const to = residentKey(key, toId);
      if (intent?.base) {
        if (!(key in intent.base)) continue;
        const print = intent.base[key];
        if (print == null) delete slots[to]; else slots[to] = print;
        continue;
      }
      const from = residentKey(key, fromId);
      if (from in slots) slots[to] = slots[from]!; else delete slots[to];
    }
    const { moving: _done, ...rest } = mark;
    storage.setItem(LAYOUT_KEY, JSON.stringify({ ...rest, slots }));
  }
  if (intent) saveMoves(storage, loadMoves(storage).filter((m) => !(m.from === fromId && m.to === toId)));
}

/** The pending record, raw, or null. */
function pendingMark(storage: Store): Record<string, unknown> | null {
  try {
    const mark = JSON.parse(storage.getItem(LAYOUT_KEY) || 'null');
    return mark && typeof mark === 'object' && mark.state === 'pending' ? mark : null;
  } catch { return null; }
}

/**
 * A connect just succeeded (the Settings form, a deep link) — record it and
 * say whether the app must come up as a DIFFERENT server.
 *
 * Same server as current (same entry — machine alternates fold into one by
 * recordServer): nothing to activate; the socket swap was the whole event
 * and the failover semantics own it. Returns `{ reload: false }`.
 *
 * A DIFFERENT server: CURRENT moves to it, and the caller brings the app up
 * as a switch (App's onConnected(true): content remount — board 315; a deep
 * link runs pre-boot, so the boot itself is that). Nothing is filed or
 * surfaced: each server's state is in its own slot already (②b-4). The
 * mirror keys already point at the new server — the connect path wrote them
 * before dialing.
 */
export function activateConnected(
  storage: Store,
  conn: { address: string; token: string; socket?: string; machineId?: string },
): { reload: boolean } {
  const { entry } = recordServer(storage, conn);
  if (entry.id === currentServerId(storage)) return { reload: false };
  storage.setItem(CURRENT_KEY, entry.id);
  storage.removeItem('tmux_disconnected');
  return { reload: true };
}

/**
 * An in-place switch just AUTHENTICATED (board 315) — the only moment a
 * target becomes current. Until here the mirror keys and CURRENT still name
 * the server the user left, so a reload mid-switch boots that one.
 *
 * Records the connection by the machine identity the server reported (a new
 * address of a known machine folds into that machine's entry; a new machine
 * gets a new entry — an address alone never guesses a machine when the
 * server told us which it is), adds the address to that machine's failover
 * set, moves CURRENT to the canonical entry, and writes the active-mirror
 * keys. Returns the entry.
 */
export function activateSwitched(
  storage: Store,
  conn: { address: string; token: string; socket?: string; machineId?: string },
): ServerEntry {
  const { entry } = recordServer(storage, conn);
  if (conn.machineId) {
    const map = machinesMap(storage);
    const addrs = Array.isArray(map[conn.machineId]) ? map[conn.machineId]! : [];
    if (!addrs.includes(conn.address)) addrs.push(conn.address);
    map[conn.machineId] = addrs.slice(-8);
    storage.setItem('tmux_machines', JSON.stringify(map));
  }
  storage.setItem(CURRENT_KEY, entry.id);
  storage.setItem('tmux_address', conn.address);
  storage.setItem('tmux_token', conn.token);
  if (conn.socket) storage.setItem('tmux_socket', conn.socket);
  else storage.removeItem('tmux_socket');
  storage.removeItem('tmux_disconnected');
  return entry;
}

/** Make the saved entry `id` CURRENT, with its active mirror, and record
 * nothing else (#335 D2): an Aggregate focus change between members that are
 * already connected and recorded. False when no such entry is saved.
 *
 * ATOMIC as far as storage allows (reviewer P1-3 on 99566068): the mirror is
 * written first and CURRENT LAST — CURRENT is the commit point every reader
 * of "which server is focused" asks. A write that throws before it restores
 * what it had already changed (best effort) and rethrows, so CURRENT never
 * names a server whose mirror half-landed, and the caller moves nothing. */
export function focusServer(storage: Store, id: string): boolean {
  const entry = loadServers(storage).find((s) => s.id === id);
  if (!entry) return false;
  const keys = ['tmux_address', 'tmux_token', 'tmux_socket', 'tmux_disconnected'];
  const before = keys.map((k) => [k, storage.getItem(k)] as const);
  try {
    storage.setItem('tmux_address', entry.address);
    storage.setItem('tmux_token', entry.token);
    if (entry.socket) storage.setItem('tmux_socket', entry.socket);
    else storage.removeItem('tmux_socket');
    storage.removeItem('tmux_disconnected');
    storage.setItem(CURRENT_KEY, entry.id);
  } catch (error) {
    for (const [k, v] of before) {
      try { if (v == null) storage.removeItem(k); else storage.setItem(k, v); } catch { /* best effort */ }
    }
    throw error;
  }
  return true;
}

/** Point CURRENT back at `id` — a switch whose target did not come up
 * returns to the server it left (board #335 ②b-4, ruling (a)). Only to an
 * entry that still exists — or to the entry identity repair folded it into
 * meanwhile (board #335 ③b, M1 F2/F4): the server left IS that survivor
 * now, and a focus handover owed to it must find CURRENT naming it. */
export function restoreCurrent(storage: Store, id: string): void {
  const to = mergedInto(storage, id);
  if (to) storage.setItem(CURRENT_KEY, to);
}

export function renameServer(storage: Store, id: string, name: string): ServerEntry[] {
  const servers = loadServers(storage);
  const entry = servers.find((s) => s.id === id);
  const trimmed = name.trim();
  if (entry && trimmed) { entry.name = trimmed; entry.named = true; saveServers(storage, servers); }
  return servers;
}

/** Remove an entry and its per-server state. The CURRENT entry is not
 *  removable — the switcher offers removal only on the others, and refusing
 *  here keeps a stale UI honest. The mirror keys are reconciled in the same
 *  step (`reconcileMirror`), so no credential of the removed server stays. */
export function removeServer(storage: Store, id: string): ServerEntry[] {
  if (id === currentServerId(storage)) return loadServers(storage);
  const servers = loadServers(storage).filter((s) => s.id !== id);
  saveServers(storage, servers);
  reconcileMirror(storage);
  for (const key of RESIDENT_KEYS) storage.removeItem(residentKey(key, id));
  return servers;
}

const MIRROR_KEYS = ['tmux_address', 'tmux_token', 'tmux_socket'] as const;

/**
 * The mirror keys are a projection of the registry, never a connection of
 * their own (board #400, orchestrator's ruling on the review): they are kept
 * only while the WHOLE tuple — address, token and socket — is one the registry
 * holds, an entry's active address or one of its failover addresses with that
 * entry's token and socket. Anything else is cleared: a server deleted on an
 * older build, a server deleted just now, an address dropped from a failover
 * set, a token or socket that belongs to another server at a shared URL, an
 * attempt the connect form wrote before it dialled and never finished. An
 * address is reachability, not credential ownership, so it is never matched
 * alone. Runs wherever the registry can lose a tuple (`removeServer`,
 * `saveMachineAddresses`) and at every boot (`migrateServers`); idempotent.
 * What the connect form pre-fills is `currentConnection`, not these keys.
 */
export function reconcileMirror(storage: Store): void {
  const address = storage.getItem('tmux_address') || '';
  const token = storage.getItem('tmux_token') || '';
  const socket = storage.getItem('tmux_socket') || '';
  if (!address && !token && !socket) return;
  const held = address !== '' && loadServers(storage).some((s) =>
    s.token === token && (s.socket ?? '') === socket && addressesOf(storage, s).includes(address));
  if (!held) for (const key of MIRROR_KEYS) storage.removeItem(key);
}

/** The connection the connect form opens with: CURRENT's saved entry, as one
 * tuple, or null when there is none. The registry is authoritative (board
 * #400): the form pre-fills nothing it cannot find here, and a draft lives
 * only for the open form. */
export function currentConnection(storage: Reader): { address: string; token: string; socket: string } | null {
  const id = currentServerId(storage);
  const entry = id ? loadServers(storage).find((s) => s.id === id) : undefined;
  return entry ? { address: entry.address, token: entry.token, socket: entry.socket ?? '' } : null;
}
