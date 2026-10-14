// The Name + tag stack's ONE fit test (#369, owner 2026-10-14 17:10: "收回去的
// 时候名称右边还是空白"). A head that wears a `ServerTag` draws the tag inline
// beside the name while the two fit, and UNDER the name when they do not
// (#356, #359). CSS alone cannot do that without a hole: a container's used
// width is fixed before its lines are broken, so a wrapping stack keeps the
// width it had on one line and the path starts a tag's width to the right of
// the chevron — measured 16 of 260 widths over 8px with the stack as a
// flex-wrap row, and every pure-CSS form failed for the same structural
// reason (the matrix is on #369: inline-grid, min-content, auto-fit).
//
// So the stack is an ordinary nowrap flex row (`app.css .title-stack`) and
// this action decides which of its TWO forms it wears: it toggles ONE class,
// `fit-wrapped`, and CSS draws it (the column form `.stacked` already is). It
// stores no width and writes no style. The test: take the class off, ask
// whether the row overflows itself, put the class back if it does — measured
// once per trigger, never polled. The answer is a function of the layout alone,
// so a re-run gives the same answer: no flip-flop, no loop.
//
// Triggers, and nothing else: the head's size (viewport, the Files drawer, the
// buttons beside the title) and the stack's parent's size, one rAF-coalesced
// ResizeObserver; and a changed `key` (a rename, a new tag) through Svelte's
// `update`, because in the column form a changed word may not change any box
// the observer sees. `active: false` is the phone: the stack is unconditionally
// stacked there (`.stacked`) and the action is a no-op that takes its class off.

export const FIT_CLASS = 'fit-wrapped';

/** Sub-pixel layout rounding is not an overflow: the title group shrinks at
 * weight 1 against the path's 1000 (Hub.svelte), a few hundredths of a pixel
 * while the path still has room to give. */
export const OVERFLOW_TOLERANCE_PX = 1;

export interface TitleFitOptions {
  /** False on the phone, where the stack is always stacked. */
  active?: boolean;
  /** Any value that changes with the stack's words (name, tag, rename state). */
  key?: unknown;
}

/** Does the stack's content run past the stack's own box? (pure) */
export function overflowsItself(stack: { scrollWidth: number; clientWidth: number }): boolean {
  return stack.scrollWidth - stack.clientWidth > OVERFLOW_TOLERANCE_PX;
}

export function titleFit(stack: HTMLElement, options: TitleFitOptions = {}) {
  let { active = true } = options;
  const view = stack.ownerDocument.defaultView!;
  let frame = 0;
  const test = () => {
    frame = 0;
    stack.classList.remove(FIT_CLASS);
    if (active && overflowsItself(stack)) stack.classList.add(FIT_CLASS);
  };
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(test);
  };
  const resize = new view.ResizeObserver(schedule);
  const observe = () => {
    resize.disconnect();
    if (!active) return;
    // The head carries the width the row is judged against; the parent is the
    // group whose own size follows the stack's. Either changing is a reason to
    // ask again.
    for (const el of new Set([stack.parentElement, stack.closest('.page-head')])) if (el) resize.observe(el);
  };
  observe();
  test();
  return {
    update(next: TitleFitOptions = {}) {
      const was = active;
      ({ active = true } = next);
      if (active !== was) observe();
      test();
    },
    destroy() {
      if (frame) view.cancelAnimationFrame(frame);
      resize.disconnect();
      stack.classList.remove(FIT_CLASS);
    },
  };
}
