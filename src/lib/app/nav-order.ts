// The desktop rail's ICON ORDER — the user's, and remembered (owner,
// 2026-08-29: "在桌面版的左侧侧边栏 可以鼠标长按页面 icon 来调整上下顺序 这个
// 顺序也会在客户端记录下来"). Framework-free so the rules that regress silently
// are testable: what a saved array is allowed to say, where a page the saved
// array never heard of goes, and what a drop actually moves.
//
// Scope is the DESKTOP rail only. The phone's bottom bar keeps the shipped
// order — it is thumb geography, not a preference, and the reorder gesture it
// would need (press-and-drag) is the one the terminal already spends on
// scrolling.
//
// The module also hosts the GENERIC vertical-list drop geometry
// (`moveBefore` / `listDropAt`, and `railDropIndex` / `railDropOffset` below
// are already shape-generic): the rail's icon order and the Connection
// page's failover-address order (board #222) are the same drag, so the drop
// rules live here once rather than as a second reorder dialect.
import type { Page } from './nav-state.ts';

/** The gap between the rail's two groups, as a MEMBER of the order.
 *
 *  The rail ships in two groups — where you WORK (chat, terminal, files, board)
 *  above a `flex: 1` spacer, where you CONFIGURE (agents, the gear) below it
 *  (owner, 2026-08-19) — and that grouping is worth keeping as the DEFAULT
 *  without making it a cage. Carrying the gap in the order does both: it moves
 *  as items move around it, so a drag across it is an ordinary drop rather than
 *  a silent refusal, and nothing has to special-case "which group is this in".
 *  It is not a page, so it is never a drag HANDLE — only an anchor to drop at.
 */
export const RAIL_GAP = '|';

/** A rail slot: one of the pages the rail can show, or the gap.
 *
 *  `RailPage` is EXTRACTED from nav-state's `Page` rather than spelled
 *  independently: a name that is not a real page drops out of the union, and
 *  `RAIL_DEFAULT_ORDER` below then fails to type-check — so a page renamed in
 *  nav-state cannot leave a rail icon pointing at nothing. */
export type RailPage = Extract<Page, 'hub' | 'terminal' | 'files' | 'board' | 'agents' | 'prefs'>;
export type RailSlot = RailPage | typeof RAIL_GAP;

/** The shipped order. Also the vocabulary: a saved array may only name these,
 *  so a retired page from an older build cannot resurrect a dead icon. */
export const RAIL_DEFAULT_ORDER: readonly RailSlot[] = [
  'hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs',
];

/** Every rail slot is a real page (`prefs` is the gear = Settings), so each one
 *  is draggable and each one is restorable. */
export const RAIL_PAGES: readonly RailPage[] = RAIL_DEFAULT_ORDER
  .filter((s): s is RailPage => s !== RAIL_GAP);

export const RAIL_ORDER_KEY = 'tmux_rail_order';

/** Pointer travel, in px, before a press becomes a drag. A click that moves
 *  2–3px is an ordinary click (mouse jitter, a trackpad tap); below this the
 *  press still switches pages, which is what the icon is for 99% of the time. */
export const RAIL_DRAG_THRESHOLD = 6;

/**
 * A trusted order out of an untrusted one.
 *
 * `saved` is whatever localStorage handed back, so it may be any shape, name
 * slots twice, name slots that no longer exist, or — the case that matters most
 * — be MISSING a slot a later build added. The result always contains every
 * known slot exactly once:
 *
 * - unknown names and duplicates are dropped;
 * - a slot the saved order never mentioned is spliced in beside its DEFAULT
 *   neighbour rather than appended, so a new page arrives where it was designed
 *   to sit instead of at the bottom of somebody's custom rail.
 */
export function normalizeRailOrder(saved: unknown): RailSlot[] {
  const known = new Set<string>(RAIL_DEFAULT_ORDER);
  const out: RailSlot[] = [];
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      if (typeof raw !== 'string' || !known.has(raw) || out.includes(raw as RailSlot)) continue;
      out.push(raw as RailSlot);
    }
  }
  for (let i = 0; i < RAIL_DEFAULT_ORDER.length; i++) {
    const slot = RAIL_DEFAULT_ORDER[i] as RailSlot;
    if (out.includes(slot)) continue;
    let at = -1;
    // After the closest EARLIER default neighbour that survived …
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const k = out.indexOf(RAIL_DEFAULT_ORDER[j] as RailSlot);
      if (k >= 0) at = k + 1;
    }
    // … else before the closest LATER one, so a new first item stays first.
    for (let j = i + 1; j < RAIL_DEFAULT_ORDER.length && at < 0; j++) {
      const k = out.indexOf(RAIL_DEFAULT_ORDER[j] as RailSlot);
      if (k >= 0) at = k;
    }
    out.splice(at < 0 ? out.length : at, 0, slot);
  }
  return out;
}

/** The order as stored. Read side of `normalizeRailOrder`, so a corrupt or
 *  absent value is the default rather than an exception. */
export function parseRailOrder(raw: string | null | undefined): RailSlot[] {
  if (!raw) return [...RAIL_DEFAULT_ORDER];
  try {
    return normalizeRailOrder(JSON.parse(raw));
  } catch {
    return [...RAIL_DEFAULT_ORDER];
  }
}

/** True when an order is the shipped one, member for member. */
export function isDefaultRailOrder(order: readonly RailSlot[]): boolean {
  return order.length === RAIL_DEFAULT_ORDER.length
    && order.every((slot, i) => slot === RAIL_DEFAULT_ORDER[i]);
}

/** What to write, or `null` to REMOVE the key.
 *
 *  The default order stores nothing: a key that merely repeats the shipped
 *  order is a future migration hazard — it would pin today's arrangement for a
 *  user who never expressed a preference (the same rule `draftUpdate` follows
 *  for an empty draft). */
export function railOrderToStore(order: readonly RailSlot[]): string | null {
  return isDefaultRailOrder(order) ? null : JSON.stringify(order);
}

/**
 * The slots to RENDER: the saved order filtered by what is actually available.
 *
 * The stored order keeps every page, including the ones a feature toggle is
 * currently hiding (no bus → no hub/board/agents), because a hidden page must
 * not lose the position the user gave it — it comes back where they put it.
 * Only the rendering is filtered.
 */
export function visibleRailSlots(
  order: readonly RailSlot[],
  available: (page: RailPage) => boolean,
): RailSlot[] {
  return order.filter((slot) => slot === RAIL_GAP || available(slot as RailPage));
}

/**
 * Move `item` so it lands directly before `before` (or last, when `before`
 * is null), and return a NEW list. Generic over any vertical drag list.
 * Refuses rather than guesses: an anchor that is not in the list (a stale
 * rect from an aborted drag) leaves the list untouched.
 */
export function moveBefore<T>(list: readonly T[], item: T, before: T | null): T[] {
  if (item === before || !list.includes(item)) return [...list];
  const rest = list.filter((x) => x !== item);
  if (before == null) return [...rest, item];
  const at = rest.indexOf(before);
  if (at < 0) return [...list];
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/**
 * Move `slot` so it lands directly before `before` (or last, when `before` is
 * null), and return a NEW order.
 *
 * It operates on the FULL order, not the rendered subset, so the slots a
 * feature toggle is hiding keep their relative places instead of being
 * rewritten by a drag that could not see them. Refuses rather than guesses:
 * the gap is not a draggable, and an anchor that is not in the order (a stale
 * rect from an aborted drag) leaves the order untouched.
 */
export function moveRailItem(
  order: readonly RailSlot[],
  slot: RailSlot,
  before: RailSlot | null,
): RailSlot[] {
  if (slot === RAIL_GAP) return [...order];
  return moveBefore(order, slot, before);
}

/**
 * Which insertion point a pointer at `y` is over: the number of slots whose
 * MIDPOINT it has passed, i.e. 0 … slots.length.
 *
 * Midpoints, not edges, so every slot has a top half meaning "above me" and a
 * bottom half meaning "below me" and there is no dead zone between two icons.
 * The rects are snapshotted at drag start on purpose — the dragged icon is
 * carried by a `transform`, which reflows nothing, so re-measuring mid-drag
 * could only introduce jitter.
 */
export function railDropIndex(
  slots: readonly { top: number; bottom: number }[],
  y: number,
): number {
  let idx = 0;
  for (const r of slots) {
    if (y >= (r.top + r.bottom) / 2) idx++;
    else break;
  }
  return Math.min(idx, slots.length);
}

/**
 * Where the insertion line goes for `index`: the top edge of the slot it would
 * push down, or the bottom of the last slot when it lands at the end.
 * Returns null for an empty rail — there is nothing to insert between.
 */
export function railDropOffset(
  slots: readonly { top: number; bottom: number }[],
  index: number,
): number | null {
  if (!slots.length) return null;
  const at = Math.max(0, Math.min(index, slots.length));
  const edge = at < slots.length ? slots[at]?.top : slots[slots.length - 1]?.bottom;
  return edge ?? null;
}

/**
 * The list a release at insertion point `index` produces — the whole commit
 * path in one place, so what ships is what the tests exercise. Generic over
 * any vertical drag list whose rows were snapshotted as `rects` at drag start.
 *
 * An index past the last rect means "last", which is the one drop that has no
 * anchor to sit before.
 *
 * The two insertion points touching the dragged row — just above it and just
 * below it — both mean UNCHANGED, and that has to be said explicitly rather
 * than falling out of the move. Resolved through the anchor, "just below me"
 * reads as "before the next VISIBLE row", which steps over any unrendered
 * entry in between: the list looked untouched while the stored order quietly
 * swapped the dragged row with an entry the drag could not see.
 */
export function listDropAt<T>(
  order: readonly T[],
  item: T,
  rects: readonly { slot: T; top: number; bottom: number }[],
  index: number,
): T[] {
  const own = rects.findIndex((r) => r.slot === item);
  if (own >= 0 && (index === own || index === own + 1)) return [...order];
  const anchor = index < rects.length ? rects[index]!.slot : null;
  return moveBefore(order, item, anchor);
}

/** A drop TARGET under the pointer (board #384: an agent card dropped on a
 *  team group), from rects snapshotted at drag start: the first whose box
 *  holds the point, else null (nothing happens). 2D where the list drops
 *  above are 1D insertion points. Pure. */
export function groupDropAt<K>(
  rects: readonly { key: K; left: number; top: number; right: number; bottom: number }[],
  x: number,
  y: number,
): K | null {
  return rects.find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)?.key ?? null;
}

/**
 * The rail's drop commit: `listDropAt` plus the rail-only rules — the gap is
 * never a draggable, and `rects` are the RENDERED slots (hidden pages have
 * none), so the anchor is resolved through what the user can see while the
 * move is applied to the FULL order and hidden pages keep their places.
 */
export function railDropAt(
  order: readonly RailSlot[],
  slot: RailSlot,
  rects: readonly { slot: string; top: number; bottom: number }[],
  index: number,
): RailSlot[] {
  if (slot === RAIL_GAP) return [...order];
  return listDropAt(order, slot, rects as readonly { slot: RailSlot; top: number; bottom: number }[], index);
}
