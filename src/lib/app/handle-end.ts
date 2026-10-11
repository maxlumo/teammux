// Ending a runtime handle, the one way (board #335 ②b-2-3, reviewer P1-a on
// 48b40082).
//
// A handle that is going away owes its server's state a release — seal,
// suspend and await every download it started — and that has to be OVER
// before the handle is disposed: work the state started must finish or stop
// while its owner still exists. Before this, three paths disposed first and
// released later (or never): `revokeScope`, the handover's terminal verdict,
// and the swap's invalidate before it learned to await.
//
// So ending is two steps, and they are not the same step:
//
//   1. STOP NOW. The handle refuses new calls at once (`detach`), and the
//      host stops treating it as reusable (`ending`), so nothing new starts
//      on it while the release runs.
//   2. END WHEN RELEASED. Release its state, then dispose it.
//
// The state is NOT released when another handle has adopted it — a
// same-machine merge, the same server, whose downloads keep running.
//
// Idempotent per handle: every path may call it, and they all wait on the
// same end.

/** What ending needs from a handle. */
export interface EndableHandle {
  /** Stop serving at once (board #335 ②b-4: a runtime's `detach`). */
  detach(): void;
  dispose(): void;
}

export interface HandleEndsDeps<H extends EndableHandle, S> {
  /** The state this handle holds, if any. */
  stateOf(handle: H): S | undefined;
  /** Is `state` now held by a handle OTHER than `handle`? Then it was
   * adopted, and is not released. */
  adoptedElsewhere(state: S, handle: H): boolean;
  release(state: S): Promise<void>;
}

export interface HandleEnds<H> {
  /** Stop `handle` now and end it once its state is released. */
  end(handle: H | null | undefined): Promise<void>;
  /** Is `handle` being ended (or ended)? It must not be reused. */
  ending(handle: H | null | undefined): boolean;
}

export function createHandleEnds<H extends EndableHandle, S>(deps: HandleEndsDeps<H, S>): HandleEnds<H> {
  const ends = new WeakMap<H, Promise<void>>();
  return {
    end(handle) {
      if (!handle) return Promise.resolve();
      const already = ends.get(handle);
      if (already) return already;
      handle.detach();
      const state = deps.stateOf(handle);
      // The release starts SYNCHRONOUSLY (its seal is its first step), so a
      // merge discovered a moment later cannot adopt a state on its way out.
      const releasing = state && !deps.adoptedElsewhere(state, handle) ? deps.release(state) : Promise.resolve();
      const done = releasing.catch(() => {}).then(() => { handle.dispose(); });
      ends.set(handle, done);
      return done;
    },
    ending: (handle) => !!handle && ends.has(handle),
  };
}
