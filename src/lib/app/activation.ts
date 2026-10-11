// The app's ACTIVATION generation (board #335 ②b-4; reviewer and
// orchestrator, 2026-10-11 01:46).
//
// Every attempt to bring the app up on a server — the connect form's
// candidate, a switch, the boot dial, a reconnect attempt, an address change,
// a leave walk holding the socket — claims the generation, and the latest
// claim is the only one the app is waiting on. A late result from one that
// was superseded is a no-op: it records no identity, brings nothing up and
// concludes nothing.
//
// Until ②b-4 this was app/handover.ts, which also stood the bound runtime
// down for the length of an attempt (suspend, then a verdict). That existed
// because every attempt re-dialled the ONE socket the server's pages were
// using; each runtime owns its connection now and an attempt dials its own,
// so the suspension went. The generation stayed: it is what makes "late"
// mean anything.
export interface Activation {
  /** Is the app still waiting on THIS attempt? */
  current(): boolean;
}

export interface Activations {
  /** Claim the generation for an attempt starting now. */
  claim(): Activation;
  /** Nothing in flight is the app's any more (a revoke, a swap). */
  endAll(): void;
}

export function createActivations(): Activations {
  let latest = 0;
  return {
    claim() {
      const mine = ++latest;
      return { current: () => mine === latest };
    },
    endAll() { latest++; },
  };
}
