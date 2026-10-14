// THE server switch (board 315), framework-free so its contract is testable
// against fake servers. App wires the effects; this owns the ORDER, the
// one-intent rule and the source/candidate split. No reload: the shell stays,
// the caller hides the server-bound tree while `onstate` reports a switch.
// Nothing in memory crosses (the state-ownership table is
// websocket-client.md §#55).
//
// Order, each step finished before the next (board #335 ②b-4; orchestrator's
// ruling 2026-10-11 04:04, order (a)):
//   1. leave guards (unsaved editors ask in their own dialogs; a save or
//      delete in flight finishes first) — a cancel changes nothing at all;
//   2. one intent: the reconnect loop stops, the content tree hides
//      (onstate), every older async loses ownership (`owns(intent)`). The
//      server being left is NOT ended: its runtime, its socket and its
//      downloads keep running, each server has a connection of its own;
//   3. dial the target as a CANDIDATE, without touching CURRENT;
//   4. only after auth: record by the identity the server reported, point
//      CURRENT at that canonical entry, then `comeUp` — the target's OWN
//      runtime dials and is bound, and only then is the server left ended
//      (the swap releases its state, then disposes it).
// A failure at any step leaves the server left INTACT: CURRENT goes back to
// it, `from` (its identity) stays frozen for Retry and Back, and its state,
// in its own slots, was never touched.

import { activateSwitched, restoreCurrent, type ServerEntry } from './servers.ts';
import { isReachabilityFailure } from './dial-order.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A saved entry, or a candidate from Add server (`id: ''` until auth). */
export type SwitchTarget = Pick<ServerEntry, 'address' | 'token' | 'socket'> & {
  id: string;
  name: string;
  /** Dial exactly `address` and no other (a person's pick from the failed
   * panel, board #353): no fall-over to the server's other addresses. */
  only?: boolean;
};

export interface SwitchState {
  intent: number;
  /** The server the user was connected to when this switch began (frozen). */
  from: { id: string; name: string } | null;
  /** What was asked for; Retry runs it again from its first address. */
  target: SwitchTarget;
  /** The address in flight, or the last one tried when it failed (board #353). */
  address: string;
  phase: 'connecting' | 'failed';
  error: string;
  /** All of the server's addresses, in the order a switch tries them: the
   * failed panel offers each. One entry when the server has no other. */
  addresses: string[];
}

export interface SwitchDeps {
  storage: Store;
  /** Connected to a server right now (not mid-switch). */
  connected(): boolean;
  currentId(): string;
  currentName(): string;
  /** Ask every leave guard; false = stay. */
  confirmLeave(): Promise<boolean>;
  /** Claim the app's activation (app/activation.ts): an address connect
   * makes every older attempt stale, and loses to a later one. */
  claim(): { current(): boolean };
  /** Is the socket's owner frozen — CURRENT must not move (the boot
   * migration is blocked, board #335 ②b-4)? Then no switch and no address
   * connect starts. */
  frozen(): boolean;
  /** A connect or identity write failed: the host's one gate decides
   * whether it was storage (board #335 ②b-4). Given the target, so a gate
   * that blocks can keep it and resume this switch after its Retry. Optional
   * for a host with no migration. */
  identityFailed?(target: SwitchTarget): void;
  stopReconnect(): void;
  /** Start the CURRENT server's reconnect loop. */
  startReconnect(): void;
  /** The switch state changed: non-null = the content tree must be hidden. */
  onstate(state: SwitchState | null): void;
  /** The candidate's teardown: a failed or abandoned switch closes it. */
  disconnect(): void;
  /** Dial the switch's TARGET as a candidate of its own (board #335 ②b-4).
   * `timeoutMs` bounds THIS dial (board #353: one address must not use up the
   * whole switch). */
  connect(address: string, token: string, timeoutMs?: number): Promise<unknown>;
  /** The addresses a switch to `target` may dial, in the order to try them
   * (board #353): the target's own first. Omitted, only its own address. */
  addresses?(target: SwitchTarget): string[];
  /** How long one dial of `address` may take. Omitted, the connection's own default. */
  dialTimeout?(address: string): number | undefined;
  /** `address` could not be reached: the host remembers it for the cooldown. */
  unreachable?(address: string): void;
  setSocket(socket: string): Promise<unknown>;
  machineId(): string;
  /** Another address of the CURRENT server, dialled by its OWN runtime and
   * checked against its identity (reviewer P1-A on cc45d7d1): 'up' when it
   * answered as this server, 'handled' when it answered as another one and
   * the host took that over; a rejection is a dial that got nowhere.
   * `owns` is THIS attempt's whole ownership — its intent, no switch, its
   * activation claim — and the host asks it inside the dial, before the
   * identity record (reviewer P1-2 on 341554b3); `owner` is the claim alone,
   * which an arrival keeps across its own leave walk. */
  redial(address: string, owns: () => boolean, owner: { current(): boolean }): Promise<'up' | 'handled'>;
  /** Authenticated and activated: the target's OWN runtime dials and the app
   * comes up on it. Resolves null once it is bound, or the reason it is not;
   * the server left is ended only on success. */
  comeUp(target: SwitchTarget, entry: ServerEntry): Promise<string | null>;
  /** Another address of the CURRENT server answered (connectAddress). */
  addressUp(address: string): void;
  /** The WINDOW went quiet (board #335 ③b; reviewer P1-B and P2 on
   * e0dafe3c): a walk ended, a switch concluded or an address connect
   * settled, and nothing of this module's is in flight any more. Called
   * AFTER the caller's own completion — the walk's answer has been returned
   * to whoever asked, the switch has bound or failed, the address change has
   * published — so a host that owes a question (an orphan's) asks it from
   * here, never over an operation that is still committing. */
  onidle?(): void;
}

export function createServerSwitch(d: SwitchDeps) {
  let seq = 0;
  /** A leave walk is open — this module's own or the host's (the connect
   * form, an arrival elsewhere). ONE QUESTION AT A TIME: no switch, no
   * address change and no automatic dial starts while the person is being
   * asked, and an optimizer probe begun before it is not current after it.
   * That is all a walk does: it takes no socket and stops no loop — every
   * server has its own connection (board #335 ②b-4; orchestrator 04:03). */
  let guarding = false;
  let idleWaiters: (() => void)[] = [];
  let state: SwitchState | null = null;
  const set = (next: SwitchState | null) => { state = next; d.onstate(next); };
  /** The window operations this module has in flight — a switch from its
   * confirm walk to its conclusion, an address connect until it has
   * published or failed, a walk until it has answered. The host owes a
   * question only when this is zero (board #335 ③b; reviewer P1-B and P2 on
   * e0dafe3c): `onidle` fires when the LAST one ends, after its own
   * completion, so a switch that ended on `onstate(null)` and an address
   * change that ended on `addressUp` have committed before anyone is asked. */
  let inflight = 0;
  const begin = () => { inflight++; };
  const end = () => { if (--inflight === 0) d.onidle?.(); };

  async function switchTo(target: SwitchTarget): Promise<void> {
    if (state?.phase === 'connecting' || guarding || d.frozen()) return; // one intent at a time
    begin();
    try { await run(target); } finally { end(); }
  }
  async function run(target: SwitchTarget): Promise<void> {
    const fromConnected = d.connected() && !state;
    if (fromConnected && target.id && target.id === d.currentId()) return;
    if (fromConnected && !(await guard(() => d.confirmLeave()))) return;
    const intent = ++seq;
    d.stopReconnect();
    const from = fromConnected ? { id: d.currentId(), name: d.currentName() } : state?.from ?? null;
    const left = d.currentId();
    // The server's addresses, the target's own first (board #353). A person's
    // pick from the failed panel is exactly that one.
    const all = d.addresses?.(target) ?? [target.address];
    const addresses = all.length ? all : [target.address];
    const order = target.only ? [target.address] : addresses;
    set({ intent, from, target, address: order[0]!, phase: 'connecting', error: '', addresses });
    let moved = false;
    let used = target.address;
    /** The address in flight; the failed panel names the last one tried. */
    let tried = order[0]!;
    try {
      // Walk the addresses: one that cannot be reached (a timeout, a refusal,
      // a socket closed during auth — the address that answered the probe and
      // then stayed silent is this) hands over to the next, inside the SAME
      // switch. An AUTH refusal stops the walk: the server answered.
      for (let i = 0; ; i++) {
        const address = order[i]!;
        tried = address;
        if (i > 0) set({ intent, from, target, address, phase: 'connecting', error: '', addresses });
        try {
          await d.connect(address, target.token, d.dialTimeout?.(address));
          used = address;
          break;
        } catch (e) {
          if (intent !== seq) return;
          if (i + 1 >= order.length || !isReachabilityFailure(e)) {
            if (isReachabilityFailure(e)) d.unreachable?.(address);
            throw e;
          }
          d.unreachable?.(address);
          d.disconnect(); // this candidate is dead: the next dial opens its own
        }
      }
      if (intent !== seq) return;
      if (target.socket) await d.setSocket(target.socket).catch(() => {});
      if (intent !== seq) return;
      const mid = d.machineId();
      const entry = activateSwitched(d.storage, {
        address: used, token: target.token,
        ...(target.socket ? { socket: target.socket } : {}),
        ...(mid ? { machineId: mid } : {}),
      });
      moved = true;
      const failure = await d.comeUp(target, entry);
      if (intent !== seq) return;
      if (failure === null) { set(null); return; }
      throw new Error(failure);
    } catch (e) {
      if (intent !== seq) return;
      d.disconnect();
      d.identityFailed?.(target);
      // The target's own runtime did not come up: CURRENT goes back to the
      // server left, which is still running (ruling (a)) — unless the
      // migration is blocked, when CURRENT and the registry are frozen and
      // the gate owns what happens next.
      if (moved && left && !d.frozen()) {
        try { restoreCurrent(d.storage, left); } catch { d.identityFailed?.(target); }
      }
      // The host's gate blocked the migration (reviewer P1 on af59fb5d): it
      // OWNS the outcome now — its Retry, the target it kept — and a failed
      // panel here would cover that Retry with one the freeze refuses.
      if (d.frozen()) { set(null); return; }
      set({ intent, from, target, address: tried, phase: 'failed', error: String((e as Error)?.message || e), addresses });
    }
  }

  /**
   * Move the CURRENT server to another of its addresses (the Connection
   * page's address rows, the periodic optimizer). Its OWN runtime dials it
   * and checks the answer is still this server (reviewer P1-A on cc45d7d1);
   * it claims the app's activation, so an attempt the host was waiting on is
   * stale, and a later one makes this stale. A stale attempt neither
   * publishes nor restarts the reconnect loop. Resolves true when the
   * address answered as this server.
   */
  function connectAddress(address: string): Promise<boolean> {
    if (state || guarding || d.frozen()) return Promise.resolve(false);
    const intent = ++seq;
    const owner = d.claim();
    const mine = () => intent === seq && !state && owner.current();
    d.stopReconnect();
    begin();
    return d.redial(address, mine, owner).then(
      (how) => {
        if (!mine() || how === 'handled') return false;
        d.addressUp(address);
        return true;
      },
      () => {
        if (mine()) d.startReconnect();
        return false;
      },
    ).finally(end);
  }

  /** Run a leave walk: one at a time, and a refused one is a stay — its
   * callback never runs. */
  async function guard(walk: () => Promise<boolean>): Promise<boolean> {
    if (guarding) return false;
    guarding = true;
    seq++;
    begin();
    try { return await walk(); } finally {
      guarding = false;
      const waiting = idleWaiters;
      idleWaiters = [];
      for (const go of waiting) go();
      end();
    }
  }
  /** Resolves once no walk is asking. */
  function idle(): Promise<void> {
    return guarding ? new Promise<void>((go) => { idleWaiters.push(go); }) : Promise.resolve();
  }

  return {
    switchTo,
    connectAddress,
    guard,
    idle,
    /** Is a leave walk asking right now? */
    get guarding() { return guarding; },
    /** Is any window operation of this module's in flight — a walk, a
     * switch (from its confirm walk on), an address connect? */
    get busy() { return inflight > 0; },
    get state() { return state; },
    /** The current intent: an async begun under it compares on resolve. */
    get intent() { return seq; },
    owns(intent: number) { return intent === seq && !state; },
    /** Another path (the connect page) took the socket: older asyncs lose it. */
    supersede() { seq++; },
    retry() { if (state?.phase === 'failed') return switchTo(state.target); },
    /** Dial exactly `address` of the failed target's server (board #353): a
     * person's pick from the panel, no fall-over to the others. */
    retryAt(address: string) { if (state?.phase === 'failed') return switchTo({ ...state.target, address, only: true }); },
    /** A failed switch's panel is put away without a new intent: the host
     * bound the focus by another path (an owed handover, #335 ③b) while the
     * server the panel would go Back to is gone. A switch in flight is not
     * dismissed. */
    dismiss() { if (state?.phase === 'failed') set(null); },
    /** Back to the server the switch left, from its frozen identity. */
    back(entries: readonly ServerEntry[]) {
      const id = state?.phase === 'failed' ? state.from?.id : '';
      const entry = id ? entries.find((s) => s.id === id) : undefined;
      if (entry) return switchTo(entry);
    },
  };
}
