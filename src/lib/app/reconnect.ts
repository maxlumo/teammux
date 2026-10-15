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
import { dialTimeoutMs, isReachabilityFailure } from './dial-order.ts';

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
  /** Max attempts exhausted, no stored address, or watchdog fired. */
  onGiveUp: () => void;
  maxAttempts?: number;
  watchdogMs?: number;
  /** Injectable for tests; default to the real timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** The longest wait between two attempts (the backoff grows 0.5 s per attempt up to this). */
export const RETRY_GAP_CAP_MS = 3000;
/** The hard cap on one reconnect loop: still reconnecting after this, force a reset. */
export const RECONNECT_WATCHDOG_MS = 180000;
/**
 * How many attempts a loop makes before it gives up — DERIVED, the one place
 * (docs/design-docs/features/disconnect-grace.md § The client's side): the
 * watchdog window over the longest retry gap, so the count can never end the
 * loop before the window does. A connection that drops reconnects quietly for
 * that whole window; only then does the person land on the connect card.
 * (Board #393: a fixed 10 gave up after ~25 s, measured live.)
 */
export const RECONNECT_MAX_ATTEMPTS = RECONNECT_WATCHDOG_MS / RETRY_GAP_CAP_MS;

export function createReconnectMachine(deps: ReconnectDeps) {
  const {
    connect, findBestAddress, isAddressViable, noteAddressUnreachable,
    classifyAddress, addressLabels, target, onStateChange, onSuccess, onGiveUp, attempt: takeSocket,
    maxAttempts = RECONNECT_MAX_ATTEMPTS,
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

  function emit() {
    onStateChange({ reconnecting, attempt, label });
  }

  function clearTimers() {
    if (retryTimer) clearTimeoutFn(retryTimer);
    if (watchdog) clearTimeoutFn(watchdog);
    retryTimer = null;
    watchdog = null;
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

    const allAddrs = [primary, ...(where?.alternates ?? [])];
    let useAddr: string;

    // First attempt with multiple candidates: parallel probe → pick first
    // reachable. Avoids burning 3s × N timeouts cycling through dead
    // addresses serially.
    // The attempt takes the socket NOW, before the address probe: a probe is
    // part of the attempt, and one still out when the form takes over must
    // not go on to dial (reviewer P1-a on 372cb4af).
    const handover = takeSocket?.() ?? null;
    if (handover) held = handover;
    const owned = () => live() && (handover?.current() ?? true);

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
  };
}
