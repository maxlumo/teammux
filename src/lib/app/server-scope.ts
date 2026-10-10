// Handing the server-bound subtree a different server (board #335 ②b-1).
//
// The subtree that holds every server-bound page is keyed on the runtime
// HANDLE, so a replacement runtime rebuilds it while an ordinary reconnect —
// the same object, a new socket inside it — remounts nothing. That is the
// right key, and it is not enough on its own: Svelte creates the new branch
// BEFORE destroying the old one (measured in `server-context.mount.test.ts`),
// so with the handle alone the new pages would mount while the old server's
// pages, listeners and in-flight landings were still alive. This module owns
// the ORDER, framework-free so the order is a test rather than a comment:
//
//   1. the subtree is unbound — nothing is shown;
//   2. the host settles, which is where the old subtree's teardown runs
//      (App: Svelte's `tick`);
//   3. what was aimed at the old subtree is invalidated;
//   4. only then is the new runtime shown.
//
// A FIRST bind skips all four: with nothing bound there is nothing to tear
// down, and deferring the bind by a tick would mount every page without a
// server and then rebuild them — which is the remount this exists to avoid.
//
// Two rules fall out of having an await in the middle, and each was a real bug
// in the paths this replaces:
//
//   - THE SAME HANDLE IS NOT A DIFFERENT SERVER. A reconnect must not remount
//     the always-mounted pages, since keeping their state across a blip is
//     why they are always mounted.
//   - A SUPERSEDED SWAP OWNS NOTHING. The later swap decides what is shown —
//     an older one resuming must not mount its own target over it — but the
//     orphans it left behind are still owed an `invalidate`, so they are
//     carried to whoever finishes rather than dropped with the attempt. A
//     generation counter alone loses them: the superseding swap starts when
//     nothing is shown and so has no orphan of its own to find.
import type { ServerRuntime } from './server-runtime.ts';

export interface ScopeSwapDeps {
  /** Bind the subtree to `runtime`, or to nothing. The host assigns the state
   * its keyed subtree reads; `null` means no server-bound subtree exists. */
  show(runtime: ServerRuntime | null): void;
  /** Resolves once `show` has been applied and the unbound subtree's teardown
   * has run. */
  settle(): Promise<void>;
  /** The subtree bound to `runtime` is gone: drop what was aimed at it. */
  invalidate(runtime: ServerRuntime): void;
}

export interface ScopeSwap {
  /** The runtime the subtree is bound to right now, or null mid-swap. */
  shown(): ServerRuntime | null;
  /** Bind the subtree to `next`, in the order above. */
  swap(next: ServerRuntime | null): Promise<void>;
}

export function createScopeSwap({ show, settle, invalidate }: ScopeSwapDeps): ScopeSwap {
  let shown: ServerRuntime | null = null;
  /** Which swap owns the outcome. */
  let seq = 0;
  /** Unbound and not yet invalidated. */
  const orphans = new Set<ServerRuntime>();

  async function swap(next: ServerRuntime | null): Promise<void> {
    // Already there, with nothing owed: a reconnect, not a server.
    if (next === shown && orphans.size === 0) return;
    const mine = ++seq;
    if (shown) orphans.add(shown);
    // Nothing is bound and nothing is owed: there is no teardown to order, so
    // the bind happens AT ONCE. Deferring it would leave the tree unbound for
    // a tick, and at boot that mounts every page without a server and then
    // rebuilds them — the remount this mechanism exists to avoid.
    if (!shown && orphans.size === 0) {
      shown = next;
      show(next);
      return;
    }
    shown = null;
    show(null);
    await settle();
    // A later swap is showing something else by now; its own completion
    // invalidates the orphans this one left, because they are still ours to
    // clear and nobody else will find them.
    if (mine !== seq) return;
    for (const gone of orphans) invalidate(gone);
    orphans.clear();
    shown = next;
    show(next);
  }

  return { shown: () => shown, swap };
}
