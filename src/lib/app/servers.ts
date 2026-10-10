// Named server configurations — the multi-server registry (board #55).
//
// The client always had exactly ONE server in its keys (`tmux_address` /
// `tmux_token` / `tmux_socket`), with `tmux_address_history` as an unnamed
// recents list behind the Settings form. This module makes the servers a
// first-class REGISTRY (`tmux_servers`, named entries with stable ids) while
// deliberately keeping the old keys as the ACTIVE MIRROR: everything that
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
 * Runs before the boot auto-connect. If the registry already exists it is a
 * no-op (re-running must never duplicate or reorder). Otherwise the CURRENT
 * connection (`tmux_address`/`tmux_token`/`tmux_socket`) becomes the first,
 * current entry — the "don't lose the current user" clause — stamped with
 * `tmux_machine_id`, and the Settings recents (`tmux_address_history`) follow
 * as additional named entries — EXCEPT addresses `tmux_machines` attributes
 * to a machine that already has an entry: those are the SAME server's
 * LAN/Tailscale/WAN alternates (the failover set), and splitting them into
 * "servers" would break the multi-address semantics this feature must not
 * touch (lead review). A history machine seen for the first time yields one
 * entry (its first-seen address as the active one); unattributed addresses
 * dedupe by address as before. A client with no stored connection at all
 * migrates to an empty registry and the Settings form remains the front door.
 */
export function migrateServers(storage: Store): ServerEntry[] {
  if (storage.getItem(SERVERS_KEY) != null) return repairServers(storage);
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
    const hist = JSON.parse(storage.getItem('tmux_address_history') || '[]');
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
  return loadServers(storage);
}

/** machineId → addresses, read off the failover map (identity authority). */
export function machinesMap(storage: Reader): Record<string, string[]> {
  try {
    const raw = JSON.parse(storage.getItem('tmux_machines') || '{}');
    if (raw && typeof raw === 'object') return raw;
  } catch { /* unreadable map — address-level matching still applies */ }
  return {};
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

function forgetDropped(storage: Store, dropped: string[], survivorId: string): void {
  if (!dropped.length) return;
  const current = currentServerId(storage);
  // The CURRENT twin's slots are the newest state of this machine — the one
  // the person was just using — so they BECOME the survivor's, whole: an
  // absent key clears the survivor's too (board #335 ②b-4; before it the
  // live keys simply stayed live). Any other twin's slots go with it.
  if (dropped.includes(current)) moveSlots(storage, current, survivorId);
  for (const id of dropped) for (const key of RESIDENT_KEYS) storage.removeItem(residentKey(key, id));
  if (dropped.includes(current)) storage.setItem(CURRENT_KEY, survivorId);
  noteMerges(storage, dropped, survivorId);
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
  const servers = loadServers(storage);
  const cur = currentServerId(storage);
  const rank = (e: ServerEntry) => (e.id === cur ? 2 : e.machineId ? 1 : 0);
  let changed = false;
  for (const e of [...servers].sort((a, b) => rank(b) - rank(a))) {
    if (!servers.includes(e)) continue;          // already absorbed into a better survivor
    const dropped = absorbTwins(servers, e);
    if (!dropped.length) continue;
    forgetDropped(storage, dropped, e.id);
    changed = true;
  }
  if (changed) saveServers(storage, servers);
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
  forgetDropped(storage, absorbTwins(servers, entry), entry.id);
  saveServers(storage, servers);
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

/** Hand every slot of `fromId` to `toId`, replacing what `toId` had.
 *
 * While pre-#335 inputs are PENDING, the move is first RECORDED on the
 * pending record (reviewer P1s on cde052f7 and 4ef4dd07): a slot the identity
 * layer moved is not a slot its owner wrote, and the claim needs to know
 * which baselines a slot of `toId` may now carry. The record is one write,
 * made before any slot moves, and it is never undone — so a move that fails
 * part-way, and is never retried, still leaves a claim able to tell every
 * slot of `toId` (its own old value, or the one moved from `fromId`) from an
 * edit. If even that write fails, nothing has moved. */
function moveSlots(storage: Store, fromId: string, toId: string): void {
  if (!fromId || fromId === toId) return;
  noteRelocation(storage, fromId, toId);
  for (const key of RESIDENT_KEYS) {
    const value = storage.getItem(residentKey(key, fromId));
    if (value != null) storage.setItem(residentKey(key, toId), value);
    else storage.removeItem(residentKey(key, toId));
  }
}

function noteRelocation(storage: Store, fromId: string, toId: string): void {
  let mark: { state?: unknown; moved?: unknown } | null = null;
  try { mark = JSON.parse(storage.getItem(LAYOUT_KEY) || 'null'); } catch { return; }
  if (!mark || mark.state !== 'pending') return;
  const moved = Array.isArray(mark.moved) ? mark.moved : [];
  if (moved.some((m) => m?.from === fromId && m?.to === toId)) return;
  storage.setItem(LAYOUT_KEY, JSON.stringify({ ...mark, moved: [...moved, { from: fromId, to: toId }] }));
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

export function renameServer(storage: Store, id: string, name: string): ServerEntry[] {
  const servers = loadServers(storage);
  const entry = servers.find((s) => s.id === id);
  const trimmed = name.trim();
  if (entry && trimmed) { entry.name = trimmed; entry.named = true; saveServers(storage, servers); }
  return servers;
}

/** Remove an entry and its per-server state. The CURRENT entry is not
 *  removable — the switcher offers removal only on the others, and refusing
 *  here keeps a stale UI honest. */
export function removeServer(storage: Store, id: string): ServerEntry[] {
  if (id === currentServerId(storage)) return loadServers(storage);
  const servers = loadServers(storage).filter((s) => s.id !== id);
  saveServers(storage, servers);
  for (const key of RESIDENT_KEYS) storage.removeItem(residentKey(key, id));
  return servers;
}
