// Where a popover goes next to the control that opened it.
//
// UI-level on purpose: both the Hub's agent menu and the shared Select need it,
// and a `ui/` component importing from `hub/` would be a layering inversion.
// Pure, so the clamp/flip is testable without a browser.

export interface AnchorRect { left: number; right: number; top: number; bottom: number }
export const POPOVER_GAP = 6;
export const POPOVER_EDGE = 8;

/** Only scrolling a container of the trigger changes its viewport anchor.
 * Structural Node.contains also works across document realms; non-node event
 * targets do not move a DOM trigger. */
export function scrollMovesTrigger(scroller: EventTarget | null, trigger: Node | null): boolean {
  const node = scroller as Node | null;
  return !!trigger && typeof node?.contains === 'function' && node.contains(trigger);
}

/** Opt-in cap for menus whose trigger must remain clickable (e.g. dblclick).
 * The menu scrolls on whichever side has room; menuPlacement still owns the flip. */
export function menuHeightLimit(
  anchor: AnchorRect,
  view: { h: number },
  gap = POPOVER_GAP,
  edge = POPOVER_EDGE,
): number {
  // offsetHeight rounds to integer CSS pixels; never round into the trigger.
  return Math.floor(Math.min(
    Math.max(0, view.h - 2 * edge),
    Math.max(0, anchor.top - gap - edge, view.h - anchor.bottom - gap - edge),
  ));
}

/**
 * Where a popover goes, AND how much room it has there — one contract, so a
 * caller can never place a popover somewhere it does not fit (board #326).
 *
 * `x`/`y` are the fixed layer's coordinates; `maxW`/`maxH` are the room left
 * for it at that position, which a caller caps itself with (`--pop-maxw` /
 * `--pop-maxh`, then its own overflow). Returning them is what makes
 * `side: 'right'` a guarantee instead of a preference: when the room beside
 * the anchor is narrower than the popover, the popover gets narrower — it
 * never slides back over the box it was told to clear.
 */
export interface Placed { x: number; y: number; maxW: number; maxH: number }

/**
 * Right-aligned to the trigger and below it, because the triggers are dot menus
 * and field-width buttons whose right edge is where the chevron sits; flipped
 * above when the menu is taller than the room left underneath; clamped to the
 * viewport on both axes so it is never partly off screen. A zero height means
 * "not measured yet", and then the flip is skipped rather than guessed — the
 * caller keeps the menu invisible for that one frame.
 *
 * `align: 'left'` is the dropdown reading (board #32): the menu's LEFT edge
 * sits on the anchor's left edge — a menu that expands a NAME downward starts
 * where the name starts. Same flip, same clamp; only the wanted x differs, so
 * the two alignments cannot drift apart.
 *
 * `side: 'right'` is BESIDE the anchor instead of under it (board #326, owner
 * 2026-10-09: "弹出的那个小窗口应该再往右一点 偏移开左边的侧边栏 现在经常点击
 * 按钮之后 小窗口就把上面的区域覆盖住了"). The desktop rail's bell and server
 * switcher sit at the bottom-left corner, so a menu placed under them flipped
 * up and clamped to the 8px margin — i.e. ON TOP of the rail, over the very
 * buttons the reader wanted next. Beside it, `x` is the anchor's right edge
 * plus the gap and is NEVER clamped back: the horizontal room becomes `maxW`
 * instead. The caller passes the box to clear, which for a rail control is the
 * button's vertical span with the RAIL's right edge — the popover then clears
 * the whole rail, not just the icon. No flip: the side is explicit, and `y`
 * aligns with the anchor's top, clamped into the viewport (so a tall popover
 * beside a bottom-corner control ends up resting on the bottom margin).
 *
 * Everything is in CSS pixels of the fixed layer's coordinate space; a caller
 * under CSS `zoom` must divide the trigger's client rect first (a client rect is
 * in visual pixels, a fixed child's `left` is in its own zoomed pixels).
 */
export function menuPlacement(
  anchor: AnchorRect,
  size: { w: number; h: number },
  view: { w: number; h: number },
  gap = POPOVER_GAP,
  edge = POPOVER_EDGE,
  align: 'right' | 'left' = 'right',
  side: 'below' | 'right' = 'below',
): Placed {
  const maxH = Math.max(0, view.h - 2 * edge);
  if (side === 'right') {
    const x = anchor.right + gap;
    const h = Math.min(size.h, maxH);
    const y = Math.max(edge, h ? Math.min(anchor.top, view.h - h - edge) : anchor.top);
    return { x, y, maxW: Math.max(0, view.w - x - edge), maxH };
  }
  const want = align === 'left' ? anchor.left : anchor.right - size.w;
  const x = Math.max(edge, Math.min(want, view.w - size.w - edge));
  let y = anchor.bottom + gap;
  if (size.h && y + size.h > view.h - edge) y = Math.max(edge, anchor.top - size.h - gap);
  return { x, y, maxW: Math.max(0, view.w - 2 * edge), maxH };
}

/** The overlap of two rects (empty when they do not meet: right/bottom clamp to left/top). */
export function intersectRects(a: AnchorRect, b: AnchorRect): AnchorRect {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  return { left, top, right: Math.max(left, Math.min(a.right, b.right)), bottom: Math.max(top, Math.min(a.bottom, b.bottom)) };
}

/**
 * `menuPlacement` inside a box that does not start at the origin: a popover
 * that must stay out of the composer or under a header (board #461). The
 * placement rules take a zero-origin view `{w, h}`, so the anchor is moved into
 * the box's own coordinates, placed by the SAME function, and moved back —
 * there is no second placement rule to drift. `maxW`/`maxH` are sizes, so they
 * need no shift. `bounds` and `anchor` are in the same space (the fixed
 * layer's, i.e. `anchorOf`/`viewBox()`, already divided by the UI zoom).
 */
export function menuPlacementIn(
  bounds: AnchorRect,
  anchor: AnchorRect,
  size: { w: number; h: number },
  gap = POPOVER_GAP,
  edge = POPOVER_EDGE,
  align: 'right' | 'left' = 'right',
  side: 'below' | 'right' = 'below',
): Placed {
  const local = {
    left: anchor.left - bounds.left, right: anchor.right - bounds.left,
    top: anchor.top - bounds.top, bottom: anchor.bottom - bounds.top,
  };
  const view = { w: Math.max(0, bounds.right - bounds.left), h: Math.max(0, bounds.bottom - bounds.top) };
  const p = menuPlacement(local, size, view, gap, edge, align, side);
  return { x: p.x + bounds.left, y: p.y + bounds.top, maxW: p.maxW, maxH: p.maxH };
}

/**
 * Where a placed popover GROWS from (motion.md §2 "popover intro"): the corner
 * that touches its anchor. Below the anchor it grows from its top edge, flipped
 * above it grows from its bottom edge; the horizontal side follows `align` —
 * or, for a popover placed BESIDE its anchor, its left edge, which is the edge
 * touching the anchor.
 * Pure, so the intro's origin is tested with the placement it belongs to.
 */
export function popOrigin(
  anchor: AnchorRect,
  pos: { x: number; y: number },
  align: 'right' | 'left' = 'right',
  side: 'below' | 'right' = 'below',
): string {
  const v = pos.y < anchor.top ? 'bottom' : 'top';
  return `${v} ${side === 'right' ? 'left' : align}`;
}

/** The root's CSS `zoom` (the web/Android interface scaling). 1 on the Tauri
 * desktop path, where the webview zooms instead and rects need no correction. */
export function uiZoom(): number {
  if (typeof document === 'undefined') return 1;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
}

/**
 * A POINT as an anchor, for a menu opened by a right-click or a long press.
 *
 * The pointer is a zero-size rect, so `menuPlacement` treats it exactly like a
 * trigger — one rule for both kinds of menu instead of two placement functions
 * that drift apart. ContextMenu aligns a point LEFT by default (the click is
 * the menu's top-left corner, the OS convention; owner, 2026-09-07), while a
 * trigger rect keeps its right-aligned dot-menu dialect; both flip above when
 * there is no room below.
 *
 * `x`/`y` are client coordinates (a pointer event gives visual pixels, the same
 * as a client rect), so they take the same zoom correction.
 */
export function pointAnchor(x: number, y: number): AnchorRect {
  const z = uiZoom();
  return { left: x / z, right: x / z, top: y / z, bottom: y / z };
}

/** The trigger's rect in the fixed layer's coordinate space. */
export function anchorOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  const z = uiZoom();
  return { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z };
}

/** The viewport in the same space. */
export function viewBox(): { w: number; h: number } {
  const z = uiZoom();
  return { w: window.innerWidth / z, h: window.innerHeight / z };
}
