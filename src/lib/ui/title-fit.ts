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
// once per trigger, never polled. It judges from the same posture (the class
// off) every time, so a repeat on an unchanged layout reads the same.
//
// Triggers, and nothing else — each one something that changes the width the
// stack is GIVEN, or its words:
//   · a size change of the stack's parent or of the head (viewport, the Files
//     drawer): one ResizeObserver;
//   · a change in the CHILD SET of either (a control in the head appearing or
//     disappearing — the Board's "new" button toggles with `!sel && !creating`
//     — changes the room without resizing the head or the group: #369 review
//     P1): one MutationObserver, `childList` only, no subtree;
//   · a changed `key` (a rename, a new tag) through Svelte's `update`, because
//     in the column form a changed word may not change any box an observer sees.
//     `update` with the SAME key and `active` is not a trigger: Svelte calls it
//     whenever the options object is rebuilt (the Hub's 20 s list refresh does).
// Every trigger goes through `schedule()` (one rAF-coalesced test); the only
// synchronous test is the first one and `update`'s, and each cancels a frame
// still pending, so a torn-down stack is never written to (#369 review P2-A).
// `active: false` is the phone: the stack is unconditionally stacked there
// (`.stacked`) and the action is a no-op that takes its class off.

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
  let { active = true, key } = options;
  const view = stack.ownerDocument.defaultView!;
  let frame = 0;
  let ended = false;
  const cancel = () => {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
  };
  /** The test itself. Cancels a frame still queued first: this reading
   * supersedes it, and its handle must not be lost (the queued one would
   * otherwise outlive `destroy`). */
  const test = () => {
    cancel();
    if (ended) return;
    stack.classList.remove(FIT_CLASS);
    if (active && overflowsItself(stack)) stack.classList.add(FIT_CLASS);
  };
  const schedule = () => {
    if (ended || frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      test();
    });
  };
  const resize = new view.ResizeObserver(schedule);
  const children = new view.MutationObserver(schedule);
  const observe = () => {
    resize.disconnect();
    children.disconnect();
    if (!active) return;
    // The head carries the width the row is judged against; the parent is the
    // group whose own size follows the stack's (the Board's stack sits straight
    // in the head: the two are one element and the Set keeps one).
    for (const el of new Set([stack.parentElement, stack.closest('.page-head')])) {
      if (!el) continue;
      resize.observe(el);
      children.observe(el, { childList: true });
    }
  };
  observe();
  test();
  return {
    update(next: TitleFitOptions = {}) {
      // Svelte calls this whenever the options OBJECT is rebuilt — every 20 s
      // list refresh rebuilds the Hub's, measured in the real browser — so it
      // acts only on a real change of `active` or `key`. Anything else is not
      // a trigger (and would force a layout for nothing).
      const wasActive = active, wasKey = key;
      ({ active = true, key } = next);
      if (active !== wasActive) observe();
      if (active !== wasActive || key !== wasKey) test();
    },
    destroy() {
      ended = true;
      cancel();
      resize.disconnect();
      children.disconnect();
      stack.classList.remove(FIT_CLASS);
    },
  };
}
