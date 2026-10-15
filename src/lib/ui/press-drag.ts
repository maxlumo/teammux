// The ONE press-to-drag mechanism (board #384). It was written twice inline,
// the same way each time: the desktop rail's icon reorder (App.svelte, owner
// 2026-08-29) and the Connection page's failover-address reorder
// (Preferences.svelte, board #222); the roster's drag of an agent onto a team
// is its third user. What it owns is the PRESS, not the geometry:
//
//   - a press is recorded and the pointer CAPTURED at once, so a fast drag
//     leaving a small handle keeps reporting to it instead of to whatever it
//     passes over;
//   - it becomes a drag only after `RAIL_DRAG_THRESHOLD` of travel, so mouse
//     jitter on a click is never a drag;
//   - the drag state lives in the CALLER's `$state` (read and written through
//     `get` / `set`), so the caller's own updates to it stay reactive;
//   - a release commits; Escape, a resize (the snapshotted rects are stale)
//     or `pointercancel` abandon it; a window-level pointerup is the safety
//     net for a handle that stops existing mid-drag;
//   - a drag that travelled, committed or abandoned, arms a one-shot CLICK
//     GUARD, so the click that follows a drag is never also a pick; every
//     fresh press clears it, so a stale guard cannot swallow the next click.
//
//   - the travel `track` receives is in LAYOUT units, the ones a CSS
//     `translate` speaks: client px divided by the root's CSS zoom (the
//     web/Android interface scale, `uiZoom`), so a carried element follows
//     the pointer at 150% or 180% too (reviewer P2-2: it moved 1.5× too far,
//     on the rail and the address list as well). The threshold and every
//     hit-test stay in client units, the ones the pointer and the snapshotted
//     rects are in.
//
// What a drop MEANS (an insertion index, a team under the pointer) stays with
// the caller and the pure geometry in app/nav-order.ts.
import { RAIL_DRAG_THRESHOLD } from '../app/nav-order.ts';
import { uiZoom } from './placement.ts';

/** Where a press started. */
export interface PressAt {
  x: number;
  y: number;
  el: HTMLElement;
}

export interface PressDragOptions<P, D> {
  /** The live drag, in the caller's reactive state. */
  get(): D | null;
  set(drag: D | null): void;
  /** The press has travelled the threshold: build the drag (snapshot the
   * geometry it will drop on), or null to leave it a press. */
  begin(press: P & PressAt, e: PointerEvent): D | null;
  /** Each move while dragging, with the travel from the press in LAYOUT
   * units (for a CSS translate); hit-test with `e.clientX/Y`. */
  track(drag: D, e: PointerEvent, travel: { dx: number; dy: number }): void;
  /** A release while dragging. */
  commit(drag: D): void;
  /** Which travel counts toward the threshold: one axis for a vertical list,
   * either for a 2D drop. */
  axis?: 'y' | 'xy';
  /** Whether a touch press may start it. A handle that opts out of scrolling
   * (`touch-action: none`) may; a navigation button or a card in a scrolled
   * strip may not, since there press-and-drag is the page's scroll. */
  touch?: boolean;
  /** The root's CSS zoom; `uiZoom` (a test passes its own). */
  zoom?: () => number;
}

export interface PressDrag<P> {
  /** pointerdown on a handle. False when the press is not one this drag takes. */
  down(e: PointerEvent, press: P): boolean;
  /** pointermove on the captured element. */
  move(e: PointerEvent): void;
  /** pointerup: commit a drag in flight. */
  up(): void;
  /** Abandon without committing. */
  cancel(): void;
  /** The click after a drag: true (and disarmed) when it must be swallowed. */
  consumeClick(): boolean;
  /** While a drag is live, Escape and a resize abandon it and a window-level
   * pointerup releases it. Call from an effect that runs while dragging; the
   * return value removes the listeners. */
  listen(win?: Window): () => void;
}

export function createPressDrag<P extends object, D>(options: PressDragOptions<P, D>): PressDrag<P> {
  const { get, set, begin, track, commit, axis = 'y', touch = false, zoom = uiZoom } = options;
  let press: (P & PressAt) | null = null; // pre-threshold bookkeeping; deliberately not reactive
  let guard = false; // a drag must not ALSO click on release
  const drag: PressDrag<P> = {
    down(e, p) {
      if (e.button !== 0 || (!touch && e.pointerType === 'touch')) return false;
      // Cleared on every fresh press, so a guard left behind by a drag whose
      // click never arrived cannot swallow the NEXT click.
      guard = false;
      const el = e.currentTarget as HTMLElement;
      press = { ...p, x: e.clientX, y: e.clientY, el };
      el.setPointerCapture?.(e.pointerId);
      return true;
    },
    move(e) {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      let live = get();
      if (!live) {
        const travel = axis === 'y' ? Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
        if (travel < RAIL_DRAG_THRESHOLD) return;
        const started = begin(press, e);
        if (!started) return;
        set(started);
        live = get();
        if (!live) return;
      }
      const z = zoom() || 1;
      track(live, e, { dx: dx / z, dy: dy / z });
    },
    up() {
      const live = get();
      if (live) {
        commit(live);
        guard = true;
      }
      press = null;
      set(null);
    },
    cancel() {
      // The pointer travelled, so it was not a pick: the click is swallowed.
      if (get()) guard = true;
      press = null;
      set(null);
    },
    consumeClick() {
      if (!guard) return false;
      guard = false;
      return true;
    },
    listen(win = window) {
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); drag.cancel(); } };
      const cancel = () => drag.cancel();
      const up = () => drag.up();
      win.addEventListener('keydown', onKey, true);
      win.addEventListener('resize', cancel);
      win.addEventListener('pointerup', up, true);
      return () => {
        win.removeEventListener('keydown', onKey, true);
        win.removeEventListener('resize', cancel);
        win.removeEventListener('pointerup', up, true);
      };
    },
  };
  return drag;
}
