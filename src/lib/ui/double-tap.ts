// A double TAP: the touch half of a double-click. One detector and one
// action, beside `ui/longpress` and on its timing vocabulary.
//
// The detector (moved here from terminal-keyboard.ts, board #484) is the one
// pair rule every double-tap in the app uses: the terminal's keyboard open
// (terminal-keyboard.md "Double-tap to open"), the Feed's held bubble (#304)
// and, through `doubletap` below, the Roster card's "show only" (#484, owner
// 2026-10-30: "双击 Agent 的卡片显示或不显示 在手机上也要支持 现在手机上只能长按 然后在
// 菜单里选择；双击的话 好像就是触屏双击 不太顶用"). A later viewer (the Lightbox) takes
// the same action rather than a recogniser of its own.

import { HOLD_MS, SLOP_PX } from './longpress.ts';

// Two CLEAN taps within a short delay and a small distance make a pair.
// Anything that is not a clean tap breaks the pair, so a tap that lands right
// after a scroll cannot complete one.
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 40;

export interface TapPoint {
  x: number;
  y: number;
  /** Timestamp in ms (any monotonic clock, compared only to the previous tap). */
  t: number;
}

export interface DoubleTapDetector {
  /** Feed one clean tap. True when it completes a pair (the pair is then consumed). */
  tap(p: TapPoint): boolean;
  /** Forget the pending first tap — call for every non-tap gesture end. */
  reset(): void;
}

export function createDoubleTapDetector(
  maxDelayMs: number = DOUBLE_TAP_MS,
  maxDistancePx: number = DOUBLE_TAP_SLOP_PX,
): DoubleTapDetector {
  let last: TapPoint | null = null;
  return {
    tap(p) {
      if (last && p.t - last.t <= maxDelayMs && Math.hypot(p.x - last.x, p.y - last.y) <= maxDistancePx) {
        last = null;
        return true;
      }
      last = p;
      return false;
    },
    reset() {
      last = null;
    },
  };
}

export interface DoubleTapOptions {
  /** Fired on the second tap's release, before its click. */
  ondoubletap?: () => void;
  /** What the element MEANS (the Roster card: its room). A pair is one
   * person's two taps on one thing: a change of scope retires a pending
   * press or first tap, and a pair completes only in the scope its first tap
   * had, even when the element survives the change (#484 review P1-B). A
   * callback's identity is not a scope: tap 1 may change state and re-render,
   * and tap 2 must still pair. */
  scope?: unknown;
}

/**
 * Svelte action: `<button use:doubletap={{ ondoubletap: () => toggle() }}>`.
 *
 * A FINGER only (`pointerType === 'touch'`). A mouse and a pen keep the
 * platform's `dblclick`: a pen also drags cards (`ui/press-drag`, which
 * starts at 6px, inside this slop), so a pen pair could both drag and fire
 * (#484 review P1-A). A browser may also send a `dblclick` for two taps
 * (Chromium's touch emulation does); an element taking both ignores that one
 * on a touch device.
 *
 * A tap is a press released within longpress's slop and before its hold, so
 * a scroll, a long press, a cancelled pointer or a second finger between two
 * taps breaks the pair. Pairs are per element, and what happens OUTSIDE the
 * element breaks them too (#484 review P1-A): a press anywhere else (another
 * card, the blank strip), a second finger on another target, and a scroll of
 * the page or of any ancestor, seen through window capture listeners that
 * the action removes on teardown. The first tap is an ordinary
 * tap, untouched; the second tap's compatibility `click` is swallowed once,
 * so the pair is one act and never also a second single tap. If no such click
 * comes (an engine may skip it), the next press or key clears the guard, so it
 * can never eat a later, unrelated activation.
 */
export function doubletap(node: HTMLElement, options: DoubleTapOptions = {}) {
  let opts = options;
  const pair = createDoubleTapDetector();
  let down: TapPoint | null = null;
  let swallow = false;
  let pairScope: unknown;
  const breakPair = () => { down = null; pair.reset(); };
  const win = (node.ownerDocument?.defaultView ?? null) as Window | null;

  const onDown = (e: PointerEvent) => {
    swallow = false; // a new press: an old guard never outlives it
    if (e.pointerType !== 'touch') { down = null; pair.reset(); return; }
    if (!e.isPrimary) { down = null; pair.reset(); return; }
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  const onMove = (e: PointerEvent) => {
    if (!down || e.pointerType !== 'touch' || !e.isPrimary) return;
    if (Math.abs(e.clientX - down.x) > SLOP_PX || Math.abs(e.clientY - down.y) > SLOP_PX) { down = null; pair.reset(); }
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const from = down;
    down = null;
    if (!from || !e.isPrimary || e.timeStamp - from.t >= HOLD_MS) { pair.reset(); return; }
    if (!pair.tap({ x: e.clientX, y: e.clientY, t: e.timeStamp })) { pairScope = opts.scope; return; }
    if (pairScope !== opts.scope) return; // its first tap belonged to another scope
    swallow = true;
    opts.ondoubletap?.();
  };
  const onCancel = () => { down = null; pair.reset(); };
  const onKey = () => { swallow = false; };
  // Outside the element: a press elsewhere or a second finger anywhere, and a
  // scroll of the page or of an ancestor of the element.
  const onAnyDown = (e: PointerEvent) => {
    const inside = node.contains(e.target as Node | null);
    if (!inside) { swallow = false; breakPair(); } else if (!e.isPrimary) breakPair();
  };
  const onAnyScroll = (e: Event) => {
    const t = e.target as (Node & { contains?: (n: Node) => boolean }) | Document | Window | null;
    if (t === win || t === node.ownerDocument || (t && typeof (t as Node).contains === 'function' && (t as Node).contains(node))) breakPair();
  };
  // The second tap's click. Capture phase and immediate, so it never reaches
  // the element's own handler, delegated or attached to the element itself.
  const onClick = (e: MouseEvent) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onCancel);
  node.addEventListener('keydown', onKey);
  node.addEventListener('click', onClick, true);
  win?.addEventListener('pointerdown', onAnyDown, true);
  win?.addEventListener('scroll', onAnyScroll, true);
  return {
    update(next: DoubleTapOptions) {
      if ((next ?? {}).scope !== opts.scope) { swallow = false; breakPair(); }
      opts = next ?? {};
    },
    destroy() {
      win?.removeEventListener('pointerdown', onAnyDown, true);
      win?.removeEventListener('scroll', onAnyScroll, true);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('click', onClick, true);
    },
  };
}
