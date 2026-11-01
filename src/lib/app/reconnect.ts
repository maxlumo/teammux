// Reconnect state machine, extracted from App.svelte.
//
// Framework-free and fully dependency-injected so the whole strategy —
// one ordered round over the candidate set per attempt (board #495: the
// address round the server switch walks too, dial-order.ts), class-scaled
// connect timeouts, capped backoff, give-up, watchdog — is unit-testable
// without a browser or a server.
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
import { dialOrder, dialTimeoutMs, isAuthRefusal, pairKey, runRound } from './dial-order.ts';
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
  /** The device's soft preference (ws.ts's cooldown memory): an address
   * that just failed is dialled LAST in a round, never left out. */
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
   * may this (address, token) be sent at all? Only 'ok' is a candidate, in
   * every round, and the loop never falls back to the others. The loop reads the whole candidate set
   * through `candidateVerdict` at every point it chooses again; while the
   * set is 'pending' it waits, inside the same watchdog budget, for `wake()`.
   * Absent: every pair is ok. */
  eligible?: (address: string, token: string) => Eligibility;
  /** The host's wait before any dial — a walk asking the person something.
   * The round's last await: the pair is picked after it, from the set as it
   * is then, and dialled in that turn. */
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
    connect, isAddressViable, noteAddressUnreachable,
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
  // says WHICH. Every async continuation (the host's wait, connect, retry timer,
  // watchdog) captures the generation it was started under and bails when it
  // is not the current one — a boolean cannot tell "cancelled" from
  // "cancelled and restarted", so a superseded chain's late timeout used to
  // continue the NEW loop's counter and mark a reachable address unreachable.
  let gen = 0;
  /** The handover this CHAIN took the socket with last (reviewer P1-a on
   * 372cb4af). The chain owns the socket only while that is still the host's
   * latest: every phase — the host's wait, the dial, the backoff, the next
   * round, the watchdog — asks it, and a chain that lost it yields. A new
   * attempt opens its own handover only while the previous one still holds,
   * so a retry can never take back what the form took in the gap. */
  let held: { current(): boolean } | null = null;
  const chainOwns = () => !held || held.current();
  /** This chain waits while its candidate set is 'pending' (#458): `wake()`
   * asks the set again, in a new round of the same budget. */
  let parked = false;
  /** A round's pick has seen 'pending' and its result is on the way to the
   * chain (board #495, reviewer P1-D): a `wake()` in that gap is kept in
   * `woken` and consumed when the chain reads the result, never dropped. */
  let waiting = false;
  let woken = false;
  /** The dials this chain has sent: the attempt the person sees, the
   * optional `maxAttempts` and the backoff all count dials (board #495). */
  let dials = 0;
  /** The pairs a server refused in THIS chain (address \0 token): out of its
   * candidate set whatever the host's `eligible` says, so a refusal is never
   * sent again by the loop that received it. */
  const refusedHere = new Set<string>();
  const stateOf = (address: string, token: string): Eligibility =>
    refusedHere.has(pairKey({ address, token })) ? 'refused' : (eligible ? eligible(address, token) : 'ok');
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
    parked = false;
    waiting = false;
    woken = false;
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
      parked = false;
      emit();
      onGiveUp();
    }, watchdogMs);
  }

  /** ONE round over the current candidate set (board #495, dial-order.ts):
   * the pairs that may be sent, in dialOrder (the entry's own address first,
   * the ones in cooldown last, never removed), one dial at a time, until one
   * answers, the set says wait or stop, or every pair has been tried — then
   * the backoff, and another round. The attempt the person sees is a DIAL. */
  async function tryAttempt(myGen: number): Promise<void> {
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
    const giveUp = (reason?: 'auth' | 'unknown') => {
      reconnecting = false;
      clearTimers();
      emit();
      onGiveUp(reason);
    };
    // The round takes the socket NOW, before anything is read or awaited: a
    // loop waiting on a 'pending' set is still this round, so a join or a form
    // that claims meanwhile ends it quietly — its wake and its watchdog are
    // then nobody's (#458).
    const handover = takeSocket?.() ?? null;
    if (handover) held = handover;
    const owned = () => live() && (handover?.current() ?? true);
    /** The target the last pick read: the primary handed to `onSuccess`. */
    let primary = '';

    const round = await runRound({
      ...(beforeDial ? { before: beforeDial } : {}),
      // Read at every pick, from the target's CURRENT declaration (ruling on
      // 77e1185d): the verdict over the WHOLE current set first (#458) — only
      // an 'ok' pair is a candidate; none ok but one still compared waits for
      // it in this budget; every pair refused is the server refusing us;
      // otherwise nothing can be decided — and only then the pairs this round
      // has not sent. So an ok pair that just failed beside a pending one is
      // the end of the round (backoff, then that pair again), never a wait.
      pick: (sent) => {
        const now = target();
        if (!now?.address) return { kind: 'end', reason: 'gone' };
        primary = now.address;
        const { configured, states, verdict } = readSet(now);
        if (verdict === 'pending') { waiting = true; woken = false; return { kind: 'wait' }; }
        if (verdict !== 'ok') return { kind: 'end', reason: verdict === 'refused' ? 'auth' : 'unknown' };
        if (dials >= maxAttempts) return { kind: 'end', reason: 'spent' };
        const ok = configured.filter((_, i) => states[i] === 'ok');
        for (const address of dialOrder(ok, isAddressViable)) {
          const pair = { address, token: now.token };
          if (!sent.has(pairKey(pair))) return { kind: 'dial', pair };
        }
        return { kind: 'exhausted' };
      },
      onDial: ({ address }) => {
        dials++;
        attempt = dials;
        label = addressLabels[classifyAddress(address)] || '';
        emit();
      },
      // The attempt keeps the socket only until somebody takes it back; its
      // timeout scales with the address class (LAN fails fast, WAN needs a
      // handshake's worth).
      dial: ({ address, token }, timeoutMs) => connect(address, token, timeoutMs ?? dialTimeoutMs(classifyAddress(address)), handover),
      live: owned,
      // The server ANSWERED and refused the credentials: that PAIR is out of
      // this chain's set (#458 validator V3); the next pick reads the set
      // again, so a sibling still ok is dialled and every pair refused is the
      // server refusing us. Anything else goes on to the next pair.
      failed: (pair, e) => {
        if (isAuthRefusal(e)) refusedHere.add(pairKey(pair));
        return 'next';
      },
      timeoutOf: (address) => dialTimeoutMs(classifyAddress(address)),
      // Only a reachability failure feeds the cooldown memory.
      unreachable: noteAddressUnreachable,
    });

    // The round's result reaches this chain one handoff after the round's
    // own last check (reviewer P1-C): ask the generation and this round's
    // claim AGAIN before consuming any result. A chain that lost either ends
    // here and touches nothing — not a newer chain's watchdog, not the host,
    // not the machine's wait flags (a newer chain may be in its own pending
    // gap; reviewer P1-C residual on b99ca858). They were reset already:
    // by cancel() when the generation moved, by yieldLoop when only the
    // claim did.
    if (!owned()) { yieldLoop(); return; }
    switch (round.kind) {
      case 'ok':
        reconnecting = false;
        clearTimers();
        emit();
        onSuccess(round.pair.address, primary, handover, round.answer);
        return;
      case 'abandoned':
        yieldLoop();
        return;
      case 'wait':
        waiting = false;
        // A decision that arrived while the result was on its way: one new
        // round now, in the same budget (no timer, no new watchdog).
        if (woken) { woken = false; void tryAttempt(myGen); return; }
        parked = true;
        return;
      case 'end':
        giveUp(round.reason === 'auth' || round.reason === 'unknown' ? round.reason : undefined);
        return;
      default:
        // Every pair this round could send has failed: the backoff, by the
        // dials sent so far, then another round in the same budget.
        retryTimer = setTimeoutFn(() => { void tryAttempt(myGen); }, Math.min(500 * Math.max(dials, 1), RETRY_GAP_CAP_MS));
    }
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
      dials = 0;
      reconnecting = true;
      emit();
      armWatchdog();
      void tryAttempt(gen);
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
      if (!reconnecting) return;
      if (waiting) { woken = true; return; }
      if (!parked) return;
      parked = false;
      void tryAttempt(gen);
    },
  };
}
