// A runtime's liveness as a signal (board #357, reviewer on 0b50b8c7).
//
// `ServerRuntime.alive()` is a plain read of a plain `let`: when `detach()`
// flips it nothing reactive learns about it, so an effect that asked "may I
// still act?" would sleep through the very event it was asking about. The
// runtime stays rune-free and offers an edge instead (`onDetach`); this turns
// that edge into a stamp an effect can read. One stamp per runtime, bumped
// once, when it stops serving — no polling, no timer.
import type { ServerRuntime } from './server-runtime.ts';

export function observeLiveness(runtime: Pick<ServerRuntime, 'onDetach'> | null | undefined) {
  let stamp = $state(0);
  const off = runtime?.onDetach?.(() => { stamp++; });
  return {
    /** Read inside an effect/derived to be re-run when the runtime detaches. */
    read: () => stamp,
    stop: () => off?.(),
  };
}
