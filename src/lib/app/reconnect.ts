// Reconnect state machine, extracted from App.svelte.
//
// Framework-free and fully dependency-injected so the whole strategy —
// parallel probe on the first attempt, viability-filtered round-robin,
// class-scaled connect timeouts, capped backoff, give-up, watchdog — is
// unit-testable without a browser or a server.
//
// The host (App.svelte) owns the UI consequences: it mirrors state via
// onStateChange, runs post-success work in onSuccess, and decides what
// "give up" looks like (drop to settings). The machine owns every timer
// and never touches the DOM.
//
// It does not know what a server is, either (board #335 ②b-2-2): WHERE to
// reconnect is the host's `target()` — `app/server-target.ts`, asked for one
// entry — read afresh at every attempt, because an address can change while
// the loop runs (a failover just proved another one).

import type { ServerTarget } from './server-target.ts';
import { dialTimeoutMs, isAuthRefusal, isReachabilityFailure } from './dial-order.ts';
import { candidateVerdict, type Eligibility } from './refused-attempts.ts';

export interface ReconnectState {
  reconnecting: boolean;
  /** 1-indexed while attempting; 0 means idle. */
  attempt: number;
  /** Address-class label of the current try ('LAN' | 'Tailscale' | 'WAN' | ''). */
  label: string;
}

export interface ReconnectDeps {
  /** Dial one attempt. `handover` is THIS attempt's claim (`attempt()`),
   * frozen when the attempt took the socket: a host that checks ownership
   * deeper down — the runtime's dial, the identity record, an arrival — asks
   * that one claim all the way, never a variable a later attempt has since
   * overwritten (reviewer P1-2 on 341554b3). What it resolves with is handed
   * to `onSuccess` as this attempt's own answer. */
  connect: (url: string, token: string, timeoutMs: number, handover: { current(): boolean } | null) => Promise<unknown>;
  findBestAddress: (addresses: string[]) => Promise<string | null>;
  isAddressViable: (url: string) => boolean;
  noteAddressUnreachable: (url: string) => void;
  classifyAddress: (url: string) => number;
  addressLabels: readonly string[];
  /** Where to reach the server this machine reconnects, or null when nothing
   * is saved for it (which gives up). */
  target: () => ServerTarget | null;
  onStateChange: (state: ReconnectState) => void;
  /** Claim the app's activation for ONE attempt (board #335 ②b-2-2,
   * reviewer P1 on c5487bef; app/activation.ts since ②b-4). The attempt is
   * the app's only while `current()` holds — another attempt (the connect
   * form, a switch) claiming after it makes this one stale, and then its late
   * success, failure or retry is nobody's. A success hands the claim to
   * `onSuccess`. Omitted, the machine owns every attempt itself, as before. */
  attempt?: () => { current(): boolean };
  /** An attempt authenticated. The machine is already idle when this runs;
   * `handover` is that attempt's claim and `answer` what ITS connect
   * resolved with. */
  onSuccess: (useAddr: string, primaryAddr: string, handover?: unknown, answer?: unknown) => void;
  /** Max attempts exhausted, no stored address, or watchdog fired — or
   * (`'auth'`) the server answered and refused the credentials, which no
   * further dial can change (#458: the caller must not dial it again), or
   * (`'unknown'`) every address is held because whether it was refused
   * cannot be known. */
  onGiveUp: (reason?: 'auth' | 'unknown') => void;
  /** A HARD rule, apart from the soft `isAddressViable` preference (#458):
   * may this (address, token) be sent at all? Only 'ok' is a candidate —
   * for the first round's probe and every later round alike — and the loop
   * never falls back to the others. The loop reads the whole candidate set
   * through `candidateVerdict` at every point it chooses again; while the
   * set is 'pending' it waits, inside the same watchdog budget, for `wake()`.
   * Absent: every pair is ok. */
  eligible?: (address: string, token: string) => Eligibility;
  /** The host's wait before any dial — a walk asking the person something.
   * The loop asks the set again AFTER it, as after the probe: the chosen
   * pair is decided at the last await, by the loop itself. */
  beforeDial?: () => Promise<unknown>;
  maxAttempts?: number;
  watchdogMs?: number;
  /** Injectable for tests; default to the real timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** The longest wait between two attempts (the backoff grows 0.5 s per attempt up to this). */
export const RETRY_GAP_CAP_MS = 3000;
/**
 * How long a lost connection is retried before the person lands on the connect
 * card: the loop's watchdog, by ELAPSED TIME (docs/design-docs/features/
 * disconnect-grace.md § The client's side). There is no attempt count: a count
 * has to be sized from the backoff sequence (0.5 + 1 + 1.5 + 2 + 2.5 s, then
 * 3 s gaps) and any rounding ends the loop early — the first cut, 180 s over
 * the 3 s cap = 60 attempts, calculated by the reviewer to give up at 169.5 s — so the clock decides, and
 * `maxAttempts` stays only as an optional bound a caller may add. (Board #393:
 * a fixed 10 attempts gave up after ~25 s, measured live.)
 */
export const RECONNECT_WATCHDOG_MS = 180000;

export function createReconnectMachine(deps: ReconnectDeps) {
  const {
    connect, findBestAddress, isAddressViable, noteAddressUnreachable,
    classifyAddress, addressLabels, target, onStateChange, onSuccess, onGiveUp, attempt: takeSocket, eligible, beforeDial,
    maxAttempts = Infinity,
    watchdogMs = RECONNECT_WATCHDOG_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  let reconnecting = false;
  let attempt = 0;
  let label = '';
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  // Loop identity. `reconnecting` says whether SOME loop is running; `gen`
  // says WHICH. Every async continuation (probe, connect, retry timer,
  // watchdog) captures the generation it was started under and bails when it
  // is not the current one — a boolean cannot tell "cancelled" from
  // "cancelled and restarted", so a superseded chain's late timeout used to
  // continue the NEW loop's counter and mark a reachable address unreachable.
  let gen = 0;
  /** The handover this CHAIN took the socket with last (reviewer P1-a on
   * 372cb4af). The chain owns the socket only while that is still the host's
   * latest: every phase — the address probe, the dial, the backoff, the next
   * attempt, the watchdog — asks it, and a chain that lost it yields. A new
   * attempt opens its own handover only while the previous one still holds,
   * so a retry can never take back what the form took in the gap. */
  let held: { current(): boolean } | null = null;
  const chainOwns = () => !held || held.current();
  /** The attempt this chain waits at while its candidate set is 'pending'
   * (#458): `wake()` asks the set again; null when not waiting. */
  let parked: number | null = null;
  /** The pairs a server refused in THIS chain (address \0 token): out of its
   * candidate set whatever the host's `eligible` says, so a refusal is never
   * sent again by the loop that received it. */
  const refusedHere = new Set<string>();
  const pairOf = (address: string, token: string) => `${address}\u0000${token}`;
  const stateOf = (address: string, token: string): Eligibility =>
    refusedHere.has(pairOf(address, token)) ? 'refused' : (eligible ? eligible(address, token) : 'ok');
  /** The candidate set of a target and its one verdict: every point the loop
   * chooses again reads it, never a single pair's state. */
  function readSet(where: Pick<ServerTarget, 'address' | 'token' | 'alternates'>) {
    const configured = [where.address, ...(where.alternates ?? [])];
    const states = configured.map((a) => stateOf(a, where.token));
    return { configured, states, verdict: candidateVerdict(states) };
  }

  function emit() {
    onStateChange({ reconnecting, attempt, label });
  }

  function clearTimers() {
    if (retryTimer) clearTimeoutFn(retryTimer);
    if (watchdog) clearTimeoutFn(watchdog);
    retryTimer = null;
    watchdog = null;
    parked = null;
    attempt = 0;
    label = '';
  }

  function armWatchdog() {
    // Hard cap: if reconnecting never finishes (stuck promise, platform
    // WebSocket hang), force-reset so the user can escape without killing
    // the app.
    if (watchdog) clearTimeoutFn(watchdog);
    const myGen = gen;
    watchdog = setTimeoutFn(() => {
      if (!reconnecting || gen !== myGen) return;
      // Superseded: somebody else is connecting. That is not a give-up.
      if (!chainOwns()) { reconnecting = false; clearTimers(); emit(); return; }
      reconnecting = false;
      if (retryTimer) clearTimeoutFn(retryTimer);
      retryTimer = null;
      parked = null;
      emit();
      onGiveUp();
    }, watchdogMs);
  }

  async function tryAttempt(n: number, myGen: number): Promise<void> {
    const live = () => reconnecting && gen === myGen;
    if (!live()) return;
    /** The loop stops quietly — no give-up, no cooldown — because nothing
     * failed: somebody else took the socket. */
    const yieldLoop = () => {
      if (!live()) return;
      reconnecting = false;
      clearTimers();
      emit();
    };
    // A retry continues THIS chain only while it still owns the socket.
    if (!chainOwns()) { yieldLoop(); return; }
    const where = target();
    const primary = where?.address ?? '';
    const token = where?.token ?? '';
    if (!primary) {
      reconnecting = false;
      clearTimers();
      emit();
      onGiveUp();
      return;
    }
    const giveUp = (reason?: 'auth' | 'unknown') => {
      reconnecting = false;
      clearTimers();
      emit();
      onGiveUp(reason);
    };

    // The attempt takes the socket NOW, before the address probe: a probe is
    // part of the attempt, and one still out when the form takes over must
    // not go on to dial (reviewer P1-a on 372cb4af). Before the set is read,
    // too: a loop waiting on a 'pending' set is still this attempt, so a
    // join or a form that claims meanwhile ends it quietly — its wake and its
    // watchdog are then nobody's (#458).
    const handover = takeSocket?.() ?? null;
    if (handover) held = handover;
    const owned = () => live() && (handover?.current() ?? true);

    // The hard rule first, over the WHOLE candidate set (#458): only an 'ok'
    // pair is a candidate; none ok but one still compared waits for it in
    // this budget; every pair refused is the server refusing us; otherwise
    // nothing can be decided. Neither of the last two dials.
    const { configured, states, verdict } = readSet({ address: primary, token, alternates: where?.alternates ?? [] });
    if (verdict === 'pending') { parked = n; return; }
    if (verdict !== 'ok') { giveUp(verdict === 'refused' ? 'auth' : 'unknown'); return; }
    const allAddrs = configured.filter((_, i) => states[i] === 'ok');
    let useAddr: string;

    // First attempt with multiple candidates: parallel probe → pick first
    // reachable. Avoids burning 3s × N timeouts cycling through dead
    // addresses serially.
    if (n === 0 && allAddrs.length > 1) {
      try {
        const best = await findBestAddress(allAddrs);
        if (!live()) return; // cancelled (or restarted) mid-probe
        if (!owned()) { yieldLoop(); return; }
        useAddr = best || allAddrs[0]!;
      } catch {
        if (!owned()) { yieldLoop(); return; }
        useAddr = allAddrs[0]!;
      }
    } else {
      // Round-robin, but skip addresses that recently failed a probe or
      // connect (LAN/Tailscale IPs while on cellular keep failing until a
      // network change, which clears the memory in ws.ts). If everything
      // is in cooldown, fall back to plain round-robin — a total outage
      // shouldn't stop us from retrying at all.
      const viable = allAddrs.filter(isAddressViable);
      const pool = viable.length > 0 ? viable : allAddrs;
      useAddr = pool[n % pool.length]!;
    }

    // The host's wait (a walk asking the person) comes last before the dial.
    if (beforeDial) {
      try { await beforeDial(); } catch { /* the wait ended either way */ }
      if (!live()) return;
      if (!owned()) { yieldLoop(); return; }
    }
    // After every await, the loop asks again, from the target's CURRENT
    // declaration (ruling on 77e1185d): the target gone stops, as at the
    // start; a changed token, or a chosen address no longer in the current
    // set or no longer 'ok', is never sent — this attempt chooses again from
    // the whole current set (an 'ok' sibling is dialled, a 'pending' set
    // waits). The pair checked here is the pair `connect` sends, in this turn.
    const now = target();
    if (!now?.address) { giveUp(); return; }
    const current = readSet(now);
    const at = current.configured.indexOf(useAddr);
    if (now.token !== token || at < 0 || current.states[at] !== 'ok') { void tryAttempt(n, myGen); return; }
    attempt = n + 1;
    label = addressLabels[classifyAddress(useAddr)] || '';
    emit();

    // Per-attempt connect timeout scales with address class: LAN is fast and
    // should fail fast; WAN (public internet, slow cellular, far regions)
    // legitimately needs more time for TCP + TLS handshake.
    const cls = classifyAddress(useAddr);
    const attemptTimeout = dialTimeoutMs(cls);

    // The attempt keeps the socket only until somebody takes it back. When
    // that happens the LOOP is over, not just this attempt: a retry would
    // take the socket from the owner that superseded it.
    connect(useAddr, token, attemptTimeout, handover).then((answer) => {
      if (!owned()) { yieldLoop(); return; }
      reconnecting = false;
      clearTimers();
      emit();
      onSuccess(useAddr, primary, handover, answer);
    }).catch((e: Error) => {
      if (!owned()) { yieldLoop(); return; }
      // The server ANSWERED and refused the credentials: that is not a drop, and
      // retrying for the whole window would repeat the same answer for three
      // minutes. Stop at once; the connect card shows the stored address and
      // token to correct (board #393 review P2-2).
      if (isAuthRefusal(e)) {
        // That PAIR is refused, never the member while another pair is still
        // 'ok' or 'pending' (#458 validator V3; ruling on f20d1ea0): the set
        // is read again, and the next attempt — same loop, same budget —
        // dials an ok sibling or waits for a pending one. Every pair refused:
        // the server refused us.
        refusedHere.add(pairOf(useAddr, token));
        const left = readSet(target() ?? { address: primary, token, alternates: configured.slice(1) }).verdict;
        if (left === 'refused' || left === 'unknown') { giveUp(left === 'refused' ? 'auth' : 'unknown'); return; }
        if (n + 1 < maxAttempts) {
          retryTimer = setTimeoutFn(() => { void tryAttempt(n + 1, myGen); }, Math.min(500 * (n + 1), RETRY_GAP_CAP_MS));
          return;
        }
        giveUp();
        return;
      }
      // Reachability failures (timeout / refused, NOT auth errors) feed the
      // same cooldown memory the prober uses, so the next attempts skip
      // this address instead of re-burning its timeout.
      if (isReachabilityFailure(e)) {
        noteAddressUnreachable(useAddr);
      }
      if (n + 1 < maxAttempts) {
        const delay = Math.min(500 * (n + 1), RETRY_GAP_CAP_MS); // tighter backoff since timeouts are short
        retryTimer = setTimeoutFn(() => { void tryAttempt(n + 1, myGen); }, delay);
      } else {
        reconnecting = false;
        clearTimers();
        emit();
        onGiveUp();
      }
    });
  }

  return {
    /**
     * Begin the reconnect loop. Arms the watchdog. A no-op while a loop is
     * already running: the disconnect callback, a foreground check and a
     * failed address switch can all fire during one outage, and a second
     * chain would race the first for the single socket — each superseding
     * the other's connect(), each timing out, each marking a live address
     * unreachable. To start over, cancel() first.
     */
    start(): boolean {
      if (reconnecting) {
        return false;
      }
      gen++;
      held = null;      // an explicit start is a new chain, owning nothing yet
      refusedHere.clear();
      reconnecting = true;
      emit();
      armWatchdog();
      void tryAttempt(0, gen);
      return true;
    },
    /** User-initiated abort. Resets all internal state and timers; any
     *  continuation of the old loop that lands later is discarded. */
    cancel() {
      gen++;
      reconnecting = false;
      clearTimers();
      emit();
    },
    isActive(): boolean {
      return reconnecting;
    },
    /** A comparison the candidate set waited on has been decided: a loop
     * waiting on 'pending' asks the set again now (#458). Otherwise a no-op. */
    wake() {
      if (!reconnecting || parked === null) return;
      const n = parked;
      parked = null;
      void tryAttempt(n, gen);
    },
  };
}
