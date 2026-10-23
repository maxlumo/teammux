// One server, as something the app can hold (board #335 ②).
//
// Phase ① made the transport an object; a connection still knows nothing about
// WHICH server it reaches — deliberately, because identity is storage's and
// `app/servers.ts` is its authority. A runtime is the join: a saved
// `ServerEntry` plus the connection and bound API that serve it, plus the
// capabilities that server answered for itself.
//
// Three identity rules, which are the reason this module exists rather than a
// field on Connection:
//
//   - `id` is `ServerEntry.id`, always, and it is IMMUTABLE for the object's
//     lifetime. Every view, store slot and persisted key in phase ② keys off
//     it, so a runtime whose id could change under its holders would quietly
//     re-point them at another machine.
//   - an address is a candidate ROUTE to a server, never a second identity
//     (board #55: one machine is one entry, however many addresses answer for
//     it). Nothing here keys anything by URL or host.
//   - the server that answers decides. If the machine that authenticates is not
//     this entry's machine, the dial does not become a connected runtime under
//     this id — it reports the canonical entry for the machine that DID answer
//     and closes the socket, because a live link routing another machine's
//     panes into this entry's views is the multi-server version of the bug
//     #335 ① fixed inside one connection.
//
// What a runtime deliberately does NOT own yet:
//
//   - RECONNECT. `app/reconnect.ts` is told where by `server-target.ts`,
//     which reads the entry by id; App still runs the one machine, for
//     CURRENT.
//   - FOCUS. There is no "current" here, exactly as in the connection
//     registry. Which runtime a page looks at is the context provider's (②a-3)
//     and App's (②b-1).
import type { BuildInfo } from '../core/build-info.ts';
import type { Connection } from '../core/connection.ts';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import { RPC_KIND, type WsApi } from '../core/ws-api.ts';
import type { BackendInfo } from '../core/agents.ts';
import type { ServerId } from './refs.ts';
import { adoptHostname, loadServers, observe, recordServer, saveServers, type ServerEntry } from './servers.ts';
import { targetOf } from './server-target.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** What this server answered about itself. `null` means "not answered yet",
 * which is not the same as "no" — the Hub tabs may not be hidden on a timeout.
 * Both survive a reconnect of the same server: a runtime's server cannot
 * change, so the reset App does today (the module socket could move to another
 * server between connects) is not needed, and each successful dial re-probes
 * anyway, so an upgraded or downgraded server self-heals. */
export interface ServerCaps {
  /** Does this server have the Hub (the desktop half)? */
  hub: boolean | null;
  /** The backends it can spawn, normalized the way `agents.ts` normalizes
   * them: a present but empty list counts as unknown, not as "none". */
  backends: BackendInfo[] | null;
}

export type DialResult =
  /** Authenticated, and the machine that answered is this entry's. `entry` is
   * the canonical entry as `recordServer` left it (fresh address and token). */
  | { ok: true; entry: ServerEntry }
  /** Authenticated — but as a DIFFERENT server. `entry` is the canonical entry
   * for the machine that answered, so the caller can include that one instead;
   * this runtime's socket is already closed and its entry untouched. */
  | { ok: false; reason: 'elsewhere'; entry: ServerEntry; machineId: string; hostname: string }
  /** Never got there: no socket, no auth, a timeout. `tried` is the address
   * and token THIS attempt sent (captured before its first await, never
   * re-read from the entry): a token refusal belongs to that attempt, not to
   * whatever the entry holds when the answer comes back (#458). Internal only
   * — never logged or put in a message. */
  | { ok: false; reason: 'failed'; error: unknown; tried?: { address: string; token: string } }
  /** A LATER dial (or a dispose) took over while this one was in flight. The
   * attempt touched nothing: it did not record, adopt, disconnect or report an
   * identity, because by the time it came back the socket it dialled had
   * already been replaced by the one that superseded it. */
  | { ok: false; reason: 'superseded' }
  /** The runtime was dropped, or there is no saved entry to dial any more —
   * including an entry removed WHILE this dial was in flight, which must not
   * be resurrected by recording the connection that just succeeded. */
  | { ok: false; reason: 'gone' };

/** Where a dial goes (board #335 ②b-4, reviewer P1-A on cc45d7d1). By
 * default the entry's active address; `via` is another address of THIS
 * server's machine — a failover, the address optimizer, a Connection-page
 * row — dialled with the entry's own token, never a mirror's. Either way the
 * answer is checked against this server's identity before anything trusts
 * the connection. */
export interface DialOptions {
  via?: string;
  /** The token the caller decided to send with `via` (#458 ruling on
   * 77e1185d): the checked pair is the dialled pair, never the entry's token
   * re-read after the caller's check. Absent: the entry's own. */
  token?: string;
  timeoutMs?: number;
}

export interface ServerRuntime {
  /** `ServerEntry.id`, immutable for this object's lifetime. */
  readonly id: ServerId;
  /** This runtime's connection and its bound RPCs — the only transport it
   * has, so a call made through a runtime cannot land on another server. */
  readonly connection: Connection;
  readonly api: WsApi;
  /** The saved entry, read fresh so a rename or a new active address shows
   * through. Falls back to the last known one if it has been removed. */
  entry(): ServerEntry;
  /** Connect and authenticate, then canonicalize the identity.
   *
   * `owns` is the HOST's answer to "is the app still waiting on this dial?"
   * (board #335 ②b-2-2, reviewer P1-b). The runtime knows only its own dials;
   * the shared socket has other owners — the connect form, the reconnect
   * loop — that replace it without dialling through this runtime. A dial whose
   * host has moved on records nothing and reports `superseded`, even when its
   * own connect had already resolved. */
  dial(owns?: () => boolean, how?: DialOptions): Promise<DialResult>;
  /** Ask the server what it can do. Safe to call repeatedly. `each` is called
   * with the caps as EACH answer lands (the newest round only), so a quick
   * Hub answer is not held behind a slow backends one (reviewer P2,
   * 2026-10-10). Resolves once both have. */
  probeCaps(each?: (caps: ServerCaps) => void): Promise<ServerCaps>;
  caps(): ServerCaps;
  /** The machine the live socket reported, else the entry's saved stamp. */
  machineId(): string;
  /** The hostname the live socket reported, else the entry's adopted one. */
  hostname(): string;
  /** The build the live socket's server reported (board #368): undefined
   * while there is no authenticated socket, null when the server named none
   * (an older one). Never remembered: a build is a fact about the process
   * answering NOW, unlike the hostname an entry adopts. */
  build(): BuildInfo | null | undefined;
  /** Is this handle still the one serving its server? False once it has been
   * released or detached, which a caller must check before REUSING a handle
   * it is holding: a failed switch's Back finds the same entry id, but the
   * handle whose lease was revoked on the way out cannot serve it again. */
  alive(): boolean;
  /** Refuse NEW write RPCs through `api`, reversibly, with the reason; reads
   * go on (board #335 ③a: the app is blocked on its storage, and Retry thaws
   * it). Calls already sent complete. */
  setFrozen(on: boolean): void;
  frozen(): boolean;
  /** Stop serving NOW, for good: every call through `api` refuses from here
   * on, a method captured before included, while the connection is left for
   * `dispose` (board #335 ②b-4). A host's end calls this first, releases the
   * server's state, and disposes last. */
  detach(): void;
  /** Be told when this handle stops serving (board #357): `listener` runs
   * once, right after `alive()` turns false — by `detach()` or by `dispose()`,
   * whoever calls them (fleet drop, absorb, release). `alive()` is a plain read
   * and cannot wake anything; this is the edge a reactive host turns into a
   * signal. Returns the unsubscribe. The runtime stays rune-free. */
  onDetach(listener: () => void): () => void;
  /** Terminal, like `Connection.dispose`: the connection is released and every
   * answer still in flight is dropped instead of being published. Idempotent,
   * and it touches no other runtime. */
  dispose(): void;
}

export interface ServerRuntimeDeps {
  /** The identity authority. Every write here goes through `servers.ts`. */
  storage: Store;
  /** From the connection registry, which owns this object's lifetime. */
  slot: ConnectionSlot;
  /**
   * Called after every `recordServer`, whatever the outcome, because that call
   * is the one moment the saved entry SET can change: it stamps a machine onto
   * an entry and absorbs every twin of the survivor, which may delete entries
   * belonging to OTHER runtimes.
   *
   * The layer that holds the membership reconciles against `servers.ts`'s set
   * (the fleet's `reconcile`). One edge, rather than each runtime discovering
   * its own loss: a runtime that has not dialled yet — or is still
   * authenticating — has no occasion to discover anything, and would sit in
   * the fleet holding a socket for a server that no longer exists (reviewer
   * P1-c).
   */
  onRegistryChanged?: () => void;
  connectTimeoutMs?: number;
}

/**
 * Wrap every method of the slot's api so the call is refused once the handle
 * that handed it out is detached (board #335 ②b-4: a detached runtime's
 * connection lives on until its host disposes it).
 *
 * One wrapper per method, built once: the object keeps the shape and the
 * identity callers expect, and the liveness question is asked when the call
 * is MADE. A gate on the property read instead would miss both ways a page
 * actually calls — holding `api` for its whole life, and reading a method
 * before an `await` that finishes after the handover.
 *
 * `frozen` is the reversible third state (board #335 ③a, orchestrator's
 * P1-D ruling): while the app is blocked on its storage, a WRITE is refused
 * with the reason and a read goes through — the lists, a download's re-sign —
 * by `RPC_KIND`, the one table. A name the table does not know is refused
 * like a write: there is no default to "read". A call already on the wire is
 * not this gate's to stop, and nothing refused is replayed.
 */
function gateApi(api: WsApi, state: () => 'live' | 'detached' | 'frozen', id: ServerId): WsApi {
  const gated: Record<string, unknown> = {};
  const kinds = RPC_KIND as Record<string, 'read' | 'write' | undefined>;
  const refuse = (why: string) =>
    Promise.reject(new Error(why === 'frozen'
      ? `server runtime frozen: ${id} writes nothing until the app's storage is recorded (Retry)`
      : `server runtime ${why}: ${id} is not serving this subtree right now`));
  const allowed = (name: string) => {
    const now = state();
    return now === 'live' || (now === 'frozen' && kinds[name] === 'read');
  };
  for (const [name, value] of Object.entries(api as unknown as Record<string, unknown>)) {
    gated[name] = typeof value === 'function'
      ? (...args: unknown[]) => {
        const send = () => (value as (...a: unknown[]) => unknown).apply(api, args);
        if (!allowed(name)) return refuse(state());
        // A method may have to WAIT before it can be sent (a flagged board save
        // waits for the socket's login, board #377). The right to write is
        // asked again when the wait ends, in the SAME synchronous step that
        // sends: a runtime detached or frozen meanwhile sends nothing and the
        // caller gets the refusal. A refused write is never retried.
        const hold = (value as { hold?: (...a: unknown[]) => Promise<void> | undefined }).hold?.(...args);
        return hold ? hold.then(() => (allowed(name) ? send() : refuse(state()))) : send();
      }
      : value;
  }
  return gated as unknown as WsApi;
}

export function createServerRuntime(entry: ServerEntry, deps: ServerRuntimeDeps): ServerRuntime {
  const { storage, slot, onRegistryChanged, connectTimeoutMs } = deps;
  const { connection } = slot;
  const id = entry.id;
  let known: ServerEntry = entry;
  let caps: ServerCaps = { hub: null, backends: null };
  let dead = false;
  /** Reversibly refusing writes (`setFrozen`, board #335 ③a). */
  let frozen = false;
  /** How many dials this runtime has started. The counter IS the attempt
   * identity: only the latest may record, adopt, disconnect or report ok. */
  let dialled = 0;
  /** Same idea for capabilities: a slower probe must not overwrite a newer
   * one's answer, or an old `method not found` can unmount a Hub a later
   * probe has confirmed (reviewer P2). */
  let probed = 0;

  /**
   * The api this runtime hands out.
   *
   * Each method is wrapped once and checks the handle's liveness AT CALL
   * TIME: a detached runtime's connection lives until its host disposes it
   * (board #335 ②b-4), and nothing may reach it through this api meanwhile.
   *
   * Call time, not property-read time, and that is the whole point (reviewer
   * P1-a1): a page holds `api` and calls `api.listSessions()` long after init,
   * and a call like `api.fsWrite(path, await body)` reads the method BEFORE
   * the await and sends AFTER it. A gate that fired on the property read
   * would pass both of those straight through to a slot that by then serves
   * another server. The wrappers are built once and are stable, so a caller
   * that captured a method still holds the gate rather than the raw call.
   */
  const api: WsApi = gateApi(slot.api, () => (dead ? 'detached' : frozen ? 'frozen' : 'live'), id);

  /** The saved entry for this id. A removed entry leaves the last known one,
   * so a caller still has a name to show while it tears the runtime down. */
  function current(): ServerEntry {
    const found = loadServers(storage).find((s) => s.id === id);
    if (found) known = found;
    return known;
  }

  /** Board #310's rule, for a server that is not necessarily the current one:
   * the entry of the machine that just authenticated adopts its hostname as a
   * DEFAULT name. App's version falls back to "the current entry" because a
   * pre-#55 entry might not know its machine yet; here the fallback is this
   * runtime's own entry, since "current" is meaningless for a runtime that
   * nobody is looking at. */
  function adopt(machine: string, host: string) {
    if (!host) return;
    const servers = loadServers(storage);
    const target = (machine && servers.find((s) => s.machineId === machine))
      || servers.find((s) => s.id === id);
    if (!target) return;
    const next = adoptHostname(servers, target.id, host);
    if (next === servers) return;
    saveServers(storage, next);
    if (target.id === id) known = next.find((s) => s.id === id) ?? known;
  }

  async function dial(owns: () => boolean = () => true, how: DialOptions = {}): Promise<DialResult> {
    if (dead) return { ok: false, reason: 'gone' };
    // This attempt's identity, captured before the first await. A runtime may
    // dial more than once, and `Connection` can only reject a dial that has
    // not SETTLED — it cannot un-resolve a promise whose continuation has not
    // run yet. Without this, an older attempt that authenticated just before a
    // newer one started would come back and record its stale target, adopt its
    // hostname, close the socket the new attempt is using, or return a
    // long-expired `ok` (reviewer P1-b; the same kind of ownership bug as
    // #315's old onAddress continuation reconnecting to another machine).
    // `dead` cannot stand in for it: being alive says nothing about WHICH
    // attempt is current.
    const attempt = ++dialled;
    /** Is this still the attempt that owns the runtime? */
    const mine = () => !dead && attempt === dialled && owns();
    const target = loadServers(storage).find((s) => s.id === id);
    // Nothing saved under this id: the entry was removed (or merged away)
    // while the runtime was idle. Dialling the last known address would mint a
    // connection to a server the registry no longer lists.
    if (!target) return { ok: false, reason: 'gone' };
    known = target;
    // WHERE to dial is the one reader's answer, the entry (server-target.ts;
    // board #335 ②b-4 retired the mirror it read for the current server).
    const route = targetOf(storage, id);
    const address = how.via || route?.address || target.address;
    const token = how.token ?? (route ? route.token : target.token);
    // What this dial read, for the commit below: an edit of the token or the
    // addresses made while it awaits wins over it (board #402 review P1-A).
    const seen = observe(storage);
    // Owned at the moment it sends, or nothing is sent (#458 ruling on 77e1185d).
    if (!owns()) return { ok: false, reason: 'superseded' };
    let reported: string | null;
    try {
      reported = await connection.connect(address, token, how.timeoutMs ?? connectTimeoutMs);
    } catch (error) {
      // A superseded attempt reports neither the failure nor the success it
      // might otherwise have: whoever took over owns the outcome now.
      if (!mine()) return { ok: false, reason: 'superseded' };
      return { ok: false, reason: 'failed', error, tried: { address, token } };
    }
    if (!mine()) {
      // Two different facts, and they need opposite answers (reviewer P1-1
      // on 341554b3):
      //  - a NEWER dial of this runtime started since: its `connect` has
      //    already replaced the socket this one dialled, so this attempt
      //    has no socket of its own left, and closing the connection's
      //    CURRENT socket would cut the attempt that superseded it — touch
      //    nothing;
      //  - this is still the connection's latest dial, and only its HOST
      //    moved on (a cancel, another candidate, a switch): the socket that
      //    just authenticated is this attempt's, and nobody will ever check
      //    who it is. Left open it would serve every api call of this
      //    handle — a method a page captured earlier included — to an
      //    unidentified peer. Close it; the handle stays this server's and
      //    can dial again.
      if (!dead && attempt === dialled) connection.disconnect();
      return { ok: false, reason: 'superseded' };
    }
    // This attempt's own answer. The machine id is what ITS connect resolved
    // with, never "whatever the current socket says"; the hostname has to come
    // off the connection because `Connection` does not return it per dial, and
    // that is sound only because there is no await between the check above and
    // this read — a superseded attempt never gets here at all.
    const machine = reported || connection.getMachineId() || '';
    const host = connection.getHostname() || '';
    // The entry must still be there. A removal while we were authenticating is
    // a decision; recording the connection that just succeeded would undo it
    // and resurrect the entry through `recordServer`.
    if (!loadServers(storage).some((s) => s.id === id)) {
      detach();
      onRegistryChanged?.();
      return { ok: false, reason: 'gone' };
    }
    // RECORD, never activate: `recordServer` folds this connection into the
    // machine's canonical entry (and absorbs the twin an address-only entry
    // leaves behind) without moving CURRENT — recording and activating are
    // different acts, and a runtime is never allowed to steal the focus.
    // A peer authenticated, and until it is recorded nobody knows which
    // server it is: a record that FAILS leaves the socket closed (reviewer
    // P1-A on cc45d7d1), so nothing of this server's — a method a page
    // captured earlier included — can reach an unidentified peer. The
    // handle stays this server's, free to dial again; the failure is the
    // caller's to report.
    let canonical: ServerEntry;
    try {
      ({ entry: canonical } = recordServer(storage, {
        address,
        token,
        ...(target.socket ? { socket: target.socket } : {}),
        ...(machine ? { machineId: machine } : {}),
      }, seen));
    } catch (error) {
      connection.disconnect();
      // The record may have COMMITTED the registry before it threw (a merge
      // note or slot move after the entry set changed): whoever follows the
      // registry still has to learn that now (board #335 ③b, reviewer R1 on
      // aed2f654) — an absorbed member's identity ends at this boundary,
      // block or no block, not at some later sync.
      onRegistryChanged?.();
      throw error;
    }
    if (canonical.id !== id) {
      // Either this entry knew its machine and a different one answered, or it
      // knew none and the machine that answered already has an entry. Both are
      // the same fact: this is not the server this runtime is for.
      // Its socket reaches someone else: close it. The app arrives there
      // through a runtime of THAT server (board #335 ②b-4), never this one.
      connection.disconnect();
      adopt(machine, host);
      // Two unknown entries racing to the same machine is the ordinary way
      // this happens, in either auth order: whichever authenticates first
      // becomes the machine's canonical entry and `recordServer` absorbs the
      // other. If this id is one of the absorbed, it can never become valid
      // again, so the handle must be terminal rather than merely
      // disconnected — a disconnected one can dial back, keeps its liveness
      // clock, and anything holding the dead id goes on addressing it.
      //
      // When both entries stay (known A's address now reaching known B), the
      // handle is still A's: it closed its own socket, and it can dial A
      // again. Since the borrowed slot is gone (②b-4) that is every handle.
      //
      // DETACH, never dispose (board #335 ②b-4; the gap recorded at b2-4's
      // 085b0e70): the host ends a runtime — release its server's state, then
      // dispose — and a runtime that disposed itself here skipped the release.
      if (!loadServers(storage).some((s) => s.id === id)) detach();
      // Whatever happened to this runtime, the entry SET may have changed:
      // the membership layer reconciles, which is how a runtime absorbed
      // while idle or mid-auth is released too.
      onRegistryChanged?.();
      return { ok: false, reason: 'elsewhere', entry: canonical, machineId: machine, hostname: host };
    }
    known = canonical;
    adopt(machine, host);
    onRegistryChanged?.();
    // Reconciling may have dropped this runtime (its entry absorbed by a
    // concurrent dial), and a disposed runtime must not report success.
    if (!mine()) return { ok: false, reason: 'superseded' };
    return { ok: true, entry: canonical };
  }

  async function probeHub(round: number): Promise<void> {
    const mine = () => !dead && round === probed;
    try {
      await api.hubRooms();
      if (mine()) caps = { ...caps, hub: true };
    } catch (e: any) {
      // Only a definitive server answer (method not found: no Hub) may flip
      // the flag off. A timeout or a reconnect blip keeps the current value,
      // because false unmounts the always-mounted Hub and destroys the state
      // it exists to preserve.
      //
      // Two guards, and they answer different questions. `dead`: is this
      // runtime still held? `round === probed`: is this the newest answer?
      // App needs neither of ours and one of its own (`serverSwitch.owns`),
      // because its module socket could move to another server mid-probe; a
      // runtime's answer always came over its OWN connection, so it cannot be
      // about another server — but it can be about an older moment of this
      // one, and an old `method not found` must not unmount a Hub that a later
      // probe confirmed after an upgrade or a reconnect (reviewer P2).
      if (mine() && e?.code === -32601) caps = { ...caps, hub: false };
    }
  }

  async function probeBackends(round: number): Promise<void> {
    const mine = () => !dead && round === probed;
    try {
      const r = await api.backendsList();
      const list = r?.backends;
      // A present but EMPTY list is the server saying nothing useful, which
      // `agents.ts` also reads as unknown rather than "this server has none".
      if (mine()) caps = { ...caps, backends: Array.isArray(list) && list.length > 0 ? list : null };
    } catch {
      // A failure is not an answer, so it leaves the last one standing — the
      // same rule as the Hub flag, and what "caps survive a reconnect of the
      // same server" has to mean if it is to mean anything. Wiping to null on
      // a blip made the list vanish from a page that had it a moment ago.
    }
  }

  async function probeCaps(each?: (caps: ServerCaps) => void): Promise<ServerCaps> {
    const round = ++probed;
    const publish = () => { if (!dead && round === probed) each?.(caps); };
    await Promise.all([probeHub(round).then(publish), probeBackends(round).then(publish)]);
    return caps;
  }

  /** Stop serving: every call through `api` refuses from now on. The
   * connection is left for the host's end (release, then `dispose`). */
  function detach() {
    if (dead) return;
    dead = true;
    for (const listener of [...detachListeners]) {
      try { listener(); } catch { /* a listener's failure must not undo the detach */ }
    }
  }
  const detachListeners = new Set<() => void>();
  function onDetach(listener: () => void): () => void {
    detachListeners.add(listener);
    return () => { detachListeners.delete(listener); };
  }

  function dispose() {
    detach();
    connection.dispose();
  }

  return {
    id,
    connection,
    api,
    entry: current,
    dial,
    probeCaps,
    caps: () => caps,
    machineId: () => connection.getMachineId() || current().machineId || '',
    hostname: () => connection.getHostname() || current().hostname || '',
    build: () => connection.getBuild(),
    alive: () => !dead,
    setFrozen: (on: boolean) => { frozen = on; },
    frozen: () => frozen,
    detach,
    onDetach,
    dispose,
  };
}
