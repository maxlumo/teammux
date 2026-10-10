// Handing the shared socket from one server to another, as bookkeeping
// (board #335 ②b-1, reviewer P1 of 2026-10-10).
//
// The connect form can re-dial the one socket at an address that turns out to
// be the server the app is already on — the ordinary reconnect — or at another
// one, and nobody knows which until it authenticates. So the handle the pages
// are bound to STANDS DOWN for the length of the attempt and what happens to
// it next is decided by what that attempt established. Three rules make that
// safe, and each of them was a hole first:
//
//   - ONE TICKET PER ATTEMPT, and only the current attempt may decide.
//     Handovers overlap: a form unmounted mid-dial and a new instance
//     starting its own are two instances, and to the first one its dial is
//     still its latest. A stale attempt must not lift the protection of the
//     live one — and must not END the handle the live one is protecting,
//     which is the verdict it would be worst to accept late.
//   - A VERDICT IS CONSUMED ONCE. A second `settle` on the same ticket is a
//     no-op, `hold` included: an attempt that has already concluded cannot
//     change its mind, and `hold` is a conclusion like the others rather
//     than "nothing happened yet".
//   - THE HOST CAN END THEM ALL. When the app revokes the handle itself — a
//     server switch, where leaving is already decided — every open handover
//     stops being current, so an attempt that comes back afterwards writes no
//     identity and brings nothing up.
//
// This module holds no runtime and no storage: it answers "is this attempt
// still the one" and "what did it decide", which is why it can be tested
// without a browser.
import type { ServerRuntime } from './server-runtime.ts';

/** What a connect attempt established about the peer on the other end. */
export type HandoverOutcome = 'same-server' | 'other-server' | 'no-peer' | 'unresolved';

export interface Handover {
  /** Is the app still waiting on THIS attempt? False once another handover
   * opened or the host ended them all. A caller asks before it writes
   * identity or brings the app up, not only when it concludes. */
  current(): boolean;
  /** Report what this attempt established. The first call decides; later ones
   * and stale ones do nothing. */
  settle(outcome: HandoverOutcome): void;
}

export interface Handovers {
  /** Stand `runtime` down and open a handover for the attempt about to dial.
   * A null runtime (no server bound) still gets a handover, so the caller has
   * one shape to deal with. */
  open(runtime: ServerRuntime | null): Handover;
  /** Take the socket for an attempt that does NOT stand the handle down —
   * the boot dial, a reconnect attempt (board #335 ②b-2-2, reviewer P1-b).
   * It shares the one ownership counter with `open`, so whichever attempt
   * starts later owns the outcome: a boot dial is no longer current once the
   * connect form opens its handover, and the reverse. */
  claim(): { current(): boolean };
  /** End every open handover: none of them is current any more. What the host
   * calls when it revokes the handle itself. */
  endAll(): void;
}

/** The verdict a conclusion carries to the runtime. */
function verdictOf(outcome: HandoverOutcome): 'resume' | 'release' | 'hold' {
  // Only the two conclusions that leave the handle serving its own server
  // resume it. `unresolved` — a peer authenticated and the registry write
  // failed — HOLDS: refusing is required, releasing would make the next
  // attempt that does establish this is our server rebuild every page, when
  // the handle it needs is right there.
  if (outcome === 'same-server' || outcome === 'no-peer') return 'resume';
  if (outcome === 'other-server') return 'release';
  return 'hold';
}

export function createHandovers(): Handovers {
  let open = 0;

  return {
    open(runtime) {
      const mine = ++open;
      const ticket = runtime?.suspend() ?? 0;
      let spent = false;
      const current = () => mine === open;
      return {
        current,
        settle(outcome) {
          if (spent || !current()) return;
          spent = true;
          runtime?.settle(ticket, verdictOf(outcome));
        },
      };
    },
    claim() {
      const mine = ++open;
      return { current: () => mine === open };
    },
    endAll() {
      open++;
    },
  };
}
