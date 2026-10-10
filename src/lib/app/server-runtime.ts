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
import type { Connection } from '../core/connection.ts';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import type { WsApi } from '../core/ws-api.ts';
import type { BackendInfo } from '../core/agents.ts';
import type { ServerId } from './refs.ts';
import { adoptHostname, loadServers, recordServer, saveServers, type ServerEntry } from './servers.ts';
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
  /** Never got there: no socket, no auth, a timeout. */
  | { ok: false; reason: 'failed'; error: unknown }
  /** A LATER dial (or a dispose) took over while this one was in flight. The
   * attempt touched nothing: it did not record, adopt, disconnect or report an
   * identity, because by the time it came back the socket it dialled had
   * already been replaced by the one that superseded it. */
  | { ok: false; reason: 'superseded' }
  /** The runtime was dropped, or there is no saved entry to dial any more —
   * including an entry removed WHILE this dial was in flight, which must not
   * be resurrected by recording the connection that just succeeded. */
  | { ok: false; reason: 'gone' };

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
  dial(owns?: () => boolean): Promise<DialResult>;
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
  /** Is this handle still the one serving its server? False once it has been
   * released or detached, which a caller must check before REUSING a handle
   * it is holding: a failed switch's Back finds the same entry id, but the
   * handle whose lease was revoked on the way out cannot serve it again.
   *
   * A SUSPENDED handle is still alive: it is the same handle, waiting out a
   * socket handover that may well land on its own server. */
  alive(): boolean;
  /**
   * Stop using the slot, WITHOUT giving the handle up (board #335 ②b-1,
   * reviewer 2026-10-10).
   *
   * The connect form can re-dial the shared socket at an address that turns
   * out to be this very server — the ordinary reconnect — or at another one,
   * and nobody knows which until it authenticates. Revoking the lease
   * outright for that would replace the handle on every reconnect, remount
   * every always-mounted page and throw away the state they are mounted for,
   * without asking a single leave guard. So the handle is suspended for the
   * length of the handover: calls are refused (the socket is mid-flight
   * anyway), and then it either resumes as the same handle or is ended for
   * good by the host, once someone finds out the server changed.
   *
   * Returns a TICKET, and that is not bookkeeping — it is the whole
   * correctness of the thing. Handovers overlap: a form can be unmounted
   * mid-dial and a new instance start its own, and the first one's completion
   * then arrives while the second is still authenticating. A boolean would let
   * that stale completion lift the live attempt's protection, which is the
   * same class of bug as a superseded dial recording its result. Only the
   * ticket of the CURRENT suspension may resume.
   */
  suspend(): number;
  /**
   * End the handover `ticket` opened, with its verdict:
   *
   *   `resume`  — still serving its own server: use the slot again.
   *   `hold`    — nothing was established: keep refusing, stay available.
   *
   * There is no terminal verdict here (board #335 ②b-2-3, reviewer P1-a on
   * 48b40082): "another server owns the slot" ends the handle, and ending is
   * the HOST's — its server's state released first, `dispose` after — so
   * that conclusion goes to the host's end, never into a dispose here.
   *
   * Honoured only for the suspension in force. A stale ticket (a superseded,
   * cancelled or unmounted attempt reporting late) is a no-op, so a caller
   * can report its conclusion without first proving it still matters.
   */
  settle(ticket: number, verdict: 'resume' | 'hold'): void;
  /** Terminal, like `Connection.dispose`: the connection is released and every
   * answer still in flight is dropped instead of being published. Idempotent,
   * and it touches no other runtime.
   *
   * On a BORROWED slot (see `ServerRuntimeDeps.borrowed`) it DETACHES instead:
   * the handle goes terminal and its api starts refusing, while the
   * connection — somebody else's — is left alive. */
  dispose(): void;
}

export interface ServerRuntimeDeps {
  /** The identity authority. Every write here goes through `servers.ts`. */
  storage: Store;
  /** From the connection registry, which owns this object's lifetime. */
  slot: ConnectionSlot;
  /**
   * The slot is BORROWED: its connection belongs to someone else — ②b's
   * `ws.ts` facade, whose socket every un-migrated module is still using — so
   * this runtime may end its own USE of the slot but never the object
   * (reviewer P1-a, 2026-10-10; orchestrator's ruling the same day).
   *
   * Three paths inside this module end a runtime, and each of them would
   * otherwise reach through to a connection it does not own:
   *
   *   - the entry removed while this dial was authenticating,
   *   - this id absorbed into the canonical entry of the machine that
   *     answered — the ORDINARY outcome for an old address-only history
   *     entry, which would therefore close the legacy transport for good,
   *   - the wrong machine answering, which disconnects the socket the app is
   *     about to come up on.
   *
   * So for a borrowed slot those three DETACH instead: the handle goes
   * terminal, the loss is reported through `onRegistryChanged` (the one edge
   * ②a chose for it, rather than a second hook saying the same thing), and
   * the connection is left alive for its owner. Detaching is also what makes
   * two generations of handles over ONE slot safe: the handle App replaced
   * is detached by the swap, so its late continuations record nothing and the
   * api it handed out refuses rather than sending over a slot that now serves
   * another server.
   *
   * The borrow — and this flag — end in b3-4, when the fleet owns connections
   * and `dispose` becomes real everywhere.
   */
  borrowed?: boolean;
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
 * Wrap every method of a BORROWED slot's api so the call is refused once the
 * handle that handed it out is detached.
 *
 * One wrapper per method, built once: the object keeps the shape and the
 * identity callers expect, and the liveness question is asked when the call
 * is MADE. A gate on the property read instead would miss both ways a page
 * actually calls — holding `api` for its whole life, and reading a method
 * before an `await` that finishes after the handover.
 */
function gateApi(api: WsApi, state: () => 'live' | 'suspended' | 'detached', id: ServerId): WsApi {
  const gated: Record<string, unknown> = {};
  const refuse = (why: string) =>
    Promise.reject(new Error(`server runtime ${why}: ${id} is not serving this subtree right now`));
  for (const [name, value] of Object.entries(api as unknown as Record<string, unknown>)) {
    gated[name] = typeof value === 'function'
      ? (...args: unknown[]) => {
        const now = state();
        return now === 'live'
          ? (value as (...a: unknown[]) => unknown).apply(api, args)
          : refuse(now);
      }
      : value;
  }
  return gated as unknown as WsApi;
}

export function createServerRuntime(entry: ServerEntry, deps: ServerRuntimeDeps): ServerRuntime {
  const { storage, slot, borrowed = false, onRegistryChanged, connectTimeoutMs } = deps;
  const { connection } = slot;
  const id = entry.id;
  let known: ServerEntry = entry;
  let caps: ServerCaps = { hub: null, backends: null };
  let dead = false;
  /** Waiting out a socket handover: the same handle, not using the slot. */
  let suspended = false;
  /** The ticket of the handover in force, or 0 when none is owed a verdict.
   * Separate from `suspended` because a verdict is CONSUMED — after `hold`
   * the handle is still suspended but that attempt has had its say, so the
   * same ticket cannot come back and resume it. */
  let open = 0;
  /** Tickets issued, so each handover has its own. */
  let handovers = 0;
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
   * An OWNED slot needs no gate: ending the runtime disposes its connection,
   * and the transport itself then refuses every call ("connection disposed").
   * A BORROWED slot cannot be made to refuse — it is the live transport of
   * every module that has not moved yet — so each method is wrapped once and
   * checks the handle's liveness AT CALL TIME.
   *
   * Call time, not property-read time, and that is the whole point (reviewer
   * P1-a1): a page holds `api` and calls `api.listSessions()` long after init,
   * and a call like `api.fsWrite(path, await body)` reads the method BEFORE
   * the await and sends AFTER it. A gate that fired on the property read
   * would pass both of those straight through to a slot that by then serves
   * another server. The wrappers are built once and are stable, so a caller
   * that captured a method still holds the gate rather than the raw call.
   */
  const api: WsApi = borrowed
    ? gateApi(slot.api, () => (dead ? 'detached' : suspended ? 'suspended' : 'live'), id)
    : slot.api;

  /** End this runtime's USE of the slot. A borrowed connection outlives every
   * runtime that borrows it (see `borrowed`), so the handle goes terminal and
   * the object is left to its owner. */
  function releaseSlot() {
    if (!borrowed) connection.dispose();
  }

  /** Close the socket — but only if it is ours to close. The app is coming up
   * on the machine that just answered, and cutting that socket from inside a
   * dial that is reporting `elsewhere` would take the connection away from
   * the caller that has to recover. */
  function endSocket() {
    if (!borrowed) connection.disconnect();
  }

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

  async function dial(owns: () => boolean = () => true): Promise<DialResult> {
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
    const address = route?.address || target.address;
    const token = route ? route.token : target.token;
    let reported: string | null;
    try {
      reported = await connection.connect(address, token, connectTimeoutMs);
    } catch (error) {
      // A superseded attempt reports neither the failure nor the success it
      // might otherwise have: whoever took over owns the outcome now.
      if (!mine()) return { ok: false, reason: 'superseded' };
      return { ok: false, reason: 'failed', error };
    }
    if (!mine()) {
      // Deliberately touches nothing — in particular it does NOT disconnect.
      // The newer attempt's `connect` already replaced the socket this one
      // dialled, so this attempt has no socket of its own left to close, and
      // closing the connection's CURRENT socket would cut the attempt that
      // superseded it.
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
      dispose();
      onRegistryChanged?.();
      return { ok: false, reason: 'gone' };
    }
    // RECORD, never activate: `recordServer` folds this connection into the
    // machine's canonical entry (and absorbs the twin an address-only entry
    // leaves behind) without moving CURRENT — recording and activating are
    // different acts, and a runtime is never allowed to steal the focus.
    const { entry: canonical } = recordServer(storage, {
      address,
      token,
      ...(target.socket ? { socket: target.socket } : {}),
      ...(machine ? { machineId: machine } : {}),
    });
    if (canonical.id !== id) {
      // Either this entry knew its machine and a different one answered, or it
      // knew none and the machine that answered already has an entry. Both are
      // the same fact: this is not the server this runtime is for.
      endSocket();
      adopt(machine, host);
      // Two unknown entries racing to the same machine is the ordinary way
      // this happens, in either auth order: whichever authenticates first
      // becomes the machine's canonical entry and `recordServer` absorbs the
      // other. If this id is one of the absorbed, it can never become valid
      // again, so the handle must be terminal rather than merely
      // disconnected — a disconnected one can dial back, keeps its liveness
      // clock, and anything holding the dead id goes on addressing it.
      //
      // A BORROWED handle detaches whether or not its entry survived
      // (reviewer P1-a2). Both entries staying is the ordinary known-A →
      // known-B case: the dial was A's, the socket it got now reaches B, and
      // the socket is not ours to close — so this handle is provably no
      // longer serving A, and anything still holding its api would be sending
      // A's work to B. An OWNED handle keeps the narrower rule, because it
      // closed its own socket and its slot is idle: it is still A's handle,
      // and it can dial A again.
      if (borrowed || !loadServers(storage).some((s) => s.id === id)) dispose();
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

  function dispose() {
    dead = true;
    releaseSlot();
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
    alive: () => !dead,
    suspend: () => {
      const ticket = ++handovers;
      if (!dead) {
        suspended = true;
        open = ticket;
      }
      return ticket;
    },
    settle: (ticket: number, verdict: 'resume' | 'hold') => {
      // A stale attempt's conclusion says nothing about the handover that is
      // actually in force. And a verdict is spent when it is given: `hold` is
      // a conclusion, not a deferral.
      if (dead || !ticket || ticket !== open) return;
      open = 0;
      if (verdict === 'resume') suspended = false;
      // `hold`: still suspended, still available to the attempt that works
      // out whose socket this is — but not to this one again.
    },
    dispose,
  };
}
