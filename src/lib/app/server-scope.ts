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
  /** This runtime will not be shown (again): release it, and drop what was
   * aimed at the subtree it had. May return a promise — a release that has
   * to WAIT for work it started (board #335 ②b-2-3, reviewer P1-a) — and no
   * runtime is shown until every invalidation in flight has finished. */
  invalidate(runtime: ServerRuntime): void | Promise<void>;
}

export interface ScopeSwap {
  /** The runtime the subtree is bound to right now, or null mid-swap. */
  shown(): ServerRuntime | null;
  /**
   * What the subtree is bound to, or is already on its way to being bound to.
   *
   * A caller deciding whether a swap is NEEDED must ask this rather than
   * `shown` (reviewer P2, 2026-10-10): during the gap `shown` is null, so
   * comparing against it mints a second handle for a server a swap is already
   * heading for — and that handle, never shown, would be a lease on the
   * borrowed slot that nobody releases. One success path comes through here
   * twice (the switch's `comeUp`, then `bringUp`), so this is the ordinary
   * case rather than a race.
   */
  bound(): ServerRuntime | null;
  /** Bind the subtree to `next`, in the order above. */
  swap(next: ServerRuntime | null): Promise<void>;
  /** Resolves once the swap in flight has finished — immediately when none
   * is. What a caller awaits before doing anything that must see the subtree
   * actually bound, like restoring that server's navigation. */
  settled(): Promise<void>;
}

export function createScopeSwap({ show, settle, invalidate }: ScopeSwapDeps): ScopeSwap {
  let shown: ServerRuntime | null = null;
  /** The target of a swap that has not finished. */
  let pending: ServerRuntime | null = null;
  /** Which swap owns the outcome. */
  let seq = 0;
  /** Handles that will not be shown (again) and are owed a release. */
  const orphans = new Set<ServerRuntime>();

  const bound = () => pending ?? shown;
  /** Invalidations still finishing. A swap that would bind while one is
   * running waits for it, whichever swap started it: the work a released
   * runtime started must be over before ANY runtime is shown. */
  const draining = new Set<Promise<void>>();
  const drained = async () => { while (draining.size) await Promise.allSettled([...draining]); };
  /** The swap in flight, with the target it is heading for — `pending` cannot
   * answer that: it is null both when no swap is running and when a swap has
   * just bound its target, so comparing against it reads an unbind request
   * (`swap(null)`) as a repeat of whatever is in flight. */
  let inFlight: Promise<void> | null = null;
  let flying: ServerRuntime | null = null;

  function swap(next: ServerRuntime | null): Promise<void> {
    // A REPEAT of the swap in flight is that swap, not a new one that is
    // already over (reviewer P2-a, 2026-10-10): `doSwap` would see its own
    // target already bound and return at once, and the caller — who asked in
    // order to wait for the bind — would be handed a resolved promise while
    // nothing is shown. Settling is what it is waiting for.
    if (inFlight && next === flying) return inFlight;
    const run = doSwap(next);
    // Track the promise the caller gets, so the cleanup compares the same
    // object it stored: `run.finally(...)` is a DIFFERENT promise, and an
    // identity check against `run` can never match.
    const tracked: Promise<void> = run.finally(() => {
      if (inFlight === tracked) { inFlight = null; flying = null; }
    });
    inFlight = tracked;
    flying = next;
    return tracked;
  }

  async function doSwap(next: ServerRuntime | null): Promise<void> {
    // Already there, with nothing owed — or already on its way, in which case
    // the swap in flight is the current one (a superseded swap's target has
    // been replaced by whoever superseded it) and it will pay every debt.
    if (next === bound() && (pending === next || orphans.size === 0)) return;
    const mine = ++seq;
    // A target this swap replaces before it was ever shown is still a handle
    // somebody has to release: the superseded swap cannot do it, because the
    // later one owns the outcome.
    if (pending && pending !== next) orphans.add(pending);
    pending = next;
    const settled = shown;
    // Nothing bound and nothing owed: there is no teardown to order, so the
    // bind happens AT ONCE. Deferring it would leave the tree with no
    // server-bound subtree for a tick and then build the whole thing — at
    // boot, every page.
    if (!settled && orphans.size === 0 && draining.size === 0) {
      shown = next;
      pending = null;
      show(next);
      return;
    }
    if (settled) {
      orphans.add(settled);
      shown = null;
      show(null);
    }
    await settle();
    // A later swap is showing something else by now; its own completion
    // releases the orphans this one left, because they are still ours to clear
    // and nobody else will find them.
    if (mine !== seq) return;
    const gone = [...orphans];
    orphans.clear();
    for (const runtime of gone) {
      const done = Promise.resolve(invalidate(runtime)).catch(() => {});
      draining.add(done);
      void done.then(() => draining.delete(done));
    }
    await drained();
    // Superseded while the releases ran: the later swap shows its own target,
    // and it waited on these too.
    if (mine !== seq) return;
    shown = next;
    pending = null;
    show(next);
  }

  return {
    shown: () => shown,
    bound,
    swap,
    settled: () => inFlight ?? Promise.resolve(),
  };
}
