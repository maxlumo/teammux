/**
 * The sliding indicator (motion.md §2, board #86): a tab bar, a rail or a
 * segmented control keeps ONE moving highlight that glides to the chosen
 * item instead of each item lighting up in place.
 *
 * Usage — the container is `position: relative` (or fixed) and holds one
 * indicator element wearing `.slide-pill` (the filled wash behind the item —
 * the owner retired the 2px bar, 2026-09-04: "线条都去掉，直接用 icon 上面的
 * 背景阴影来滑动"); the action measures the active descendant and writes the
 * geometry as CSS variables the atom's transform reads:
 *
 *   <nav class="tabbar" use:slideIndicator={{ key: page, active: '.active' }}>
 *     <span class="slide-pill" aria-hidden="true"></span>
 *     <button class:active={…}>…</button>
 *   </nav>
 *
 * `key` is any value that changes when the selection does (the action
 * re-measures on update); `active` is the selector of the chosen descendant
 * (default `[aria-current], .active, .on, .sel`) — it need not be a direct
 * child (the rail's buttons sit in a `.rail-slot` wrapper). `hidden` collapses
 * the indicator while the container is being rearranged (the rail's icon drag)
 * and re-measures when it turns false again. A ResizeObserver re-measures on
 * layout change (rotation, split drag, font size) — and it watches more than
 * the container: the active item and the container's direct children too
 * (board #345). A scroll container (the sidebars' `.side-scroll`) keeps its
 * own box when its content changes, so a row that grew by two agent chips, or
 * a row above it that did, moved the active item's box while nothing the
 * container-only observer watched had resized, and the wash kept the old one
 * (owner: it "did not grow or shrink with the agents"). The observer's calls
 * are coalesced to one frame (one write per frame however many rows move). The atom only transitions
 * once `.ready` is set — after the first measure — so the indicator is born in
 * place and never slides in from the corner.
 *
 * Geometry is LAYOUT (the `offsetParent` chain walked from both the item and
 * the container, see `boxFromOffsets`), never a client rect: a rect carries
 * every transform on the way — the tab's press scale, a slot mid-flip, the
 * root zoom — and the marker glided wrong and corrected itself. An update
 * still measures twice — now, and once the move tempo has elapsed — for a
 * layout that is itself still settling.
 */
import { moveMs } from './motion.ts';

export interface IndicatorParams { key?: unknown; active?: string; hidden?: boolean }

export interface IndicatorBox { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number }

export const DEFAULT_ACTIVE = '[aria-current], .active, .on, .sel, [aria-selected="true"]';

/** The four variables for an active box (pure, tested). `null` collapses the indicator. */
export function indicatorVars(box: IndicatorBox | null): Record<string, string> {
  if (!box) return { '--ind-x': '0px', '--ind-y': '0px', '--ind-w': '0px', '--ind-h': '0px' };
  return {
    '--ind-x': `${box.offsetLeft}px`,
    '--ind-y': `${box.offsetTop}px`,
    '--ind-w': `${box.offsetWidth}px`,
    '--ind-h': `${box.offsetHeight}px`,
  };
}

/** The offset-chain face of an element (what `offsetParent` walks). */
export interface OffsetLike {
  offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number;
  offsetParent: OffsetLike | null;
}

/**
 * The active item's LAYOUT box inside the container, walking `offsetParent`
 * from both ends up to their common ancestor (or the root). Offsets, not
 * client rects, on purpose: a rect is distorted by whatever transform is on
 * the way — the tab's press `scale(0.95)` while the finger is still down, a
 * rail slot mid-`animate:flip`, the root's CSS `zoom` — and a marker measured
 * through one of those glided somewhere wrong and then corrected itself (the
 * "乱滑" the owner saw on the phone, 2026-09-04). The layout box is where the
 * item WILL rest, so the pill goes straight there.
 */
export function boxFromOffsets(item: OffsetLike, container: OffsetLike, border: { left: number; top: number } = { left: 0, top: 0 }): IndicatorBox {
  const abs = (el: OffsetLike) => {
    let x = 0, y = 0;
    for (let e: OffsetLike | null = el; e; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y };
  };
  const a = abs(item);
  const c = abs(container);
  return {
    offsetLeft: a.x - c.x - border.left,
    offsetTop: a.y - c.y - border.top,
    offsetWidth: item.offsetWidth,
    offsetHeight: item.offsetHeight,
  };
}

export function slideIndicator(node: HTMLElement, params: IndicatorParams = {}) {
  let sel = params.active ?? DEFAULT_ACTIVE;
  let hidden = !!params.hidden;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  // `ended` closes the action: after `destroy` no late frame, timer or
  // observer delivery may measure, because a measure RE-REGISTERS the watched
  // elements (board #345 review P1). Cancelling the frame handles is the first
  // layer, the flag the second for a callback the browser already took. The
  // first placement rides the same `frame` handle as every other measure; the
  // pill's `ready` mark is the one frame of its own.
  let readyFrame = 0;
  let ended = false;
  const ind = () => node.querySelector<HTMLElement>(':scope > .slide-pill');
  // What the pill's box depends on (board #345): the container, the active
  // item, and every sibling (a row above it that grows moves it). The set is
  // re-read at each measure, so a row added, removed or re-selected is
  // watched from the next frame; the pill itself is not, it is OUR output.
  const watched = new Set<Element>();
  const watch = (el: HTMLElement | null) => {
    if (!ro) return;
    const want = new Set<Element>([node]);
    if (el) {
      want.add(el);
      for (const c of Array.from(node.children)) if (!c.classList.contains('slide-pill')) want.add(c);
    }
    for (const e of watched) if (!want.has(e)) { ro.unobserve(e); watched.delete(e); }
    for (const e of want) if (!watched.has(e)) { ro.observe(e); watched.add(e); }
  };
  const measure = () => {
    if (ended) return;
    const el = hidden ? null : node.querySelector<HTMLElement>(sel);
    watch(el);
    // Offsets are relative to the CONTAINER's padding box once the border is
    // taken off; `offsetParent` is null for a display:none item.
    const box = el && el.offsetParent
      ? boxFromOffsets(el as unknown as OffsetLike, node as unknown as OffsetLike, { left: node.clientLeft, top: node.clientTop })
      : null;
    // No active item while NOT hidden is a moment between two template
    // effects (the old tab has dropped `.active`, the new one has not gained
    // it yet) — hold the last box rather than collapse to the origin, which
    // read as the pill darting to the first tab (owner, 2026-09-04: "board 到
    // file 从 chat 跳了一下").
    if (!box && !hidden) return;
    for (const [k, v] of Object.entries(indicatorVars(box))) node.style.setProperty(k, v);
    // Enable the glide only after the first placement (the next frame, so the
    // first vars are painted without a transition).
    const i = ind();
    if (i && !i.classList.contains('ready') && !readyFrame) readyFrame = requestAnimationFrame(() => { readyFrame = 0; i.classList.add('ready'); });
  };
  // One frame answers any number of observer calls, and an `update` frame in
  // flight is that same frame (it measures after every sibling effect landed).
  const queue = () => {
    if (ended) return;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(queue) : null;
  if (ro) { ro.observe(node); watched.add(node); }
  queue();
  return {
    update(p: IndicatorParams = {}) {
      if (ended) return;
      sel = p.active ?? DEFAULT_ACTIVE;
      hidden = !!p.hidden;
      // Measure on the next frame, after every sibling's class/attribute effect
      // for this change has landed — an action's update is not ordered after
      // them, so a same-tick read can still see the OLD active item.
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
      // A second read after the move tempo: a layout that is still settling
      // (a slot added by a flip, a label that wrapped) answers its final box
      // only then.
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => { settle = null; measure(); }, moveMs() + 20);
    },
    destroy() {
      ended = true;
      if (settle) clearTimeout(settle);
      for (const h of [frame, readyFrame]) if (h) cancelAnimationFrame(h);
      frame = readyFrame = 0;
      ro?.disconnect();
      watched.clear();
    },
  };
}
