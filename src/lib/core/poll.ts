// The one rule for repeated reads (board #444, owner 2026-10-20: chat typing
// stuttered on a bad phone link): ONE read of a kind in flight per context.
//
// Why: an RPC read can take longer than its poll interval (a mobile link that
// stalls for seconds). setInterval kept firing, so the stalled link carried two
// hub_agents and two hub_activity requests at once (measured on the #444 rig,
// 8 s stalls), and recovery delivered both answers together, decoded and
// dispatched back to back on the main thread the person was typing on.
//
// The in-flight state belongs to the READ, not to a timer (#444 review P1-A):
// the poll's ticks, a timer that stops and starts again (the page hidden and
// shown), the first read on entering a room, a push and a refresh after an
// action all go through the same loader, so none of them starts a second read
// of the same context while one is out.
//
//   single(task, key)  wraps a read. `key()` names its context (the room) and
//                      the task reads the CURRENT context when it starts, so a
//                      read always runs for the key it is filed under. A read
//                      for another context starts at once: a room switch never
//                      waits behind the old room's answer, which the task's own
//                      generation checks drop. No lock spans rooms.
//   loader(opts)       a read that must see what happened before it was asked:
//                      an entry, a push (a turn edge), a refresh after an action.
//                      If a read of the context is pending, it may predate the
//                      change, so the callers that come meanwhile share ONE
//                      follow-up read, started when the pending one settles.
//                      Never dropped, never doubled.
//                      A follow-up whose context is no longer current when its
//                      turn comes (the room was left) or whose loader was
//                      disposed (the page went) is RETIRED, not run: nothing is
//                      read, and its callers resolve. It must not read the room
//                      that is current now under the old room's key (#444
//                      review P1-A residual): that room has its own read.
//   failures           the task throws when its read fails. Every caller of a
//                      shared read gets that read's outcome, and each decides
//                      for itself: `{ report: true }` rejects with it, anything
//                      else swallows it. One caller's policy never replaces
//                      another's (#444 review P1-B: a refresh after an action
//                      must still see its failure when a push joined it).
//   loader.tick()      a poll tick: skipped while a read of the context is
//                      pending, never queued, because the next tick asks again.
//   loader.dispose()   the owner is gone: no new read starts, queued ones retire.
//   poll(tick, ms)     the timer: `tick` every `ms`, once at once with `now`.

export interface Loader {
  (opts?: { report?: boolean }): Promise<void>;
  tick(): void;
  dispose(): void;
}

type FollowUp = { settle: (run: Promise<void>) => void; done: Promise<void> };

export function single(task: () => unknown, key: () => string = () => ''): Loader {
  const pending = new Map<string, { followUp: FollowUp | null }>();
  let disposed = false;

  const start = (k: string): Promise<void> => {
    const slot: { followUp: FollowUp | null } = { followUp: null };
    pending.set(k, slot);
    const run = (async () => { await task(); })();
    run.catch(() => {}).finally(() => {
      if (pending.get(k) === slot) pending.delete(k);
      const next = slot.followUp;
      if (!next) return;
      if (disposed || key() !== k) next.settle(Promise.resolve());
      else next.settle(start(k));
    });
    return run;
  };

  const loader = ((opts?: { report?: boolean }): Promise<void> => {
    if (disposed) return Promise.resolve();
    const k = key();
    const slot = pending.get(k);
    let read: Promise<void>;
    if (!slot) read = start(k);
    else {
      if (!slot.followUp) {
        let settle!: (run: Promise<void>) => void;
        const done = new Promise<void>((resolve) => { settle = resolve as (run: Promise<void>) => void; });
        slot.followUp = { settle, done };
      }
      read = slot.followUp.done;
    }
    return opts?.report ? read : read.catch(() => {});
  }) as Loader;

  loader.tick = () => {
    if (disposed) return;
    const k = key();
    if (pending.has(k)) return;
    start(k).catch(() => {});
  };
  loader.dispose = () => { disposed = true; };
  return loader;
}

/** The timer: `tick` every `ms`, and once at once with `now: true`. Whether a
 * tick reads is the loader's decision (`Loader.tick`), not the timer's. */
export function poll(tick: () => void, ms: number, { now = false }: { now?: boolean } = {}): () => void {
  if (now) tick();
  const id = setInterval(tick, ms);
  return () => clearInterval(id);
}
