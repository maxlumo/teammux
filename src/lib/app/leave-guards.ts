// Leave guards for a server switch (board 315).
//
// An in-place switch DESTROYS every server-bound component, so an unsaved
// editor or a dirty agent draft would be thrown away without a word. Each
// such component already owns its exit guard (Files' discard dialog, the
// Agents editor's leave confirmation); it registers it here, and the switch
// asks them all BEFORE anything changes. There is no second confirmation
// flow: the question is the component's own, in its own dialog.
//
// Only the guards of what is being DESTROYED are asked (board #335 ②b-2-3):
// each guard names the runtime handle whose subtree holds it, and a leave
// names the handle it ends. In Single mode that is every guard.
//
// A guard on a page the user is not looking at is asked on THAT page: the
// switch reveals it first, so the dialog is seen next to what it would
// discard. Revealing must not destroy anything that has not answered yet
// (board 315 review P1): the host HOLDS every conditionally mounted page
// (Settings, which carries an Agents editor) for the whole walk, guards on
// the current page are asked before any navigation, and when the walk ends —
// either way — the user is put back on the page they started from. A cancel
// therefore loses nothing anywhere; a guard that disappears mid-walk did so
// on its own, never because the walk navigated it away.

// Framework-free and module-level: the instances live in different subtrees
// (the Files page, the Hub drawer's Files, the Agents page on the rail or
// inside Settings), and threading a callback through each host would be
// plumbing that a new host forgets.

export interface LeaveGuard {
  /** The runtime HANDLE whose subtree holds this instance (board #335
   * ②b-2-3), or null for one outside any server's subtree. A leave asks only
   * the guards of the handle it destroys — by identity, never by server id: a
   * new handle for the same id is a different owner, and must neither answer
   * for the old one's editors nor be asked about them. A null owner is asked
   * on every leave, which is what every guard was before; since ②b-3 every
   * production guard has one (Preferences' Agents editor is bound by its
   * guest scope). */
  runtime: object | null;
  /** The page whose layer holds this instance ('' = always visible). */
  page: string;
  /** Something would be lost, or a mutation is still in flight. */
  dirty(): boolean;
  /** Ask in the component's own dialog. Resolves true to leave (a pending
   * save/delete has finished first), false to stay. */
  ask(): Promise<boolean>;
}

const guards = new Set<LeaveGuard>();

/** Register from a component's $effect; the returned cleanup unregisters. */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export interface LeaveWalk {
  /** The runtime handle being destroyed: only its guards (and owner-less
   * ones) are asked. Another handle's editors are not being thrown away. */
  leaving: object | null;
  /** The page the user is on: its guards ask first, without navigating. */
  current: string;
  /** Show a page so its guard's dialog is visible. */
  reveal(page: string): Promise<void>;
  /** Keep (true) / release (false) every conditionally mounted page. */
  hold(on: boolean): void;
}

/** Ask every dirty guard in turn, one dialog at a time. Resolves true to
 * leave, false to stay; either way the user ends on `current`. */
export async function confirmLeave(walk: LeaveWalk): Promise<boolean> {
  const asked = (g: LeaveGuard) => g.runtime === null || g.runtime === walk.leaving;
  const order = [...guards].filter(asked).sort((a, b) => Number(b.page === walk.current) - Number(a.page === walk.current));
  if (!order.some((g) => g.dirty())) return true;
  walk.hold(true);
  try {
    for (const guard of order) {
      if (!guards.has(guard) || !guard.dirty()) continue;
      if (guard.page && guard.page !== walk.current) await walk.reveal(guard.page);
      if (!(await guard.ask())) return false;
    }
    return true;
  } finally {
    await walk.reveal(walk.current);
    walk.hold(false);
  }
}

/** Test seam: the registry is module state. */
export function clearLeaveGuardsForTests(): void { guards.clear(); }
