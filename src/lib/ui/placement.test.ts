// The popover placement contract — pure geometry, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectRects, menuHeightLimit, menuPlacement, menuPlacementIn, pointAnchor, popOrigin, scrollMovesTrigger, type AnchorRect } from './placement.ts';

test('only a trigger-containing scroller moves an anchored popup (#180)', () => {
  // DOM containment itself is the platform boundary; the menu mount suite
  // exercises real Nodes. These doubles pin null/non-node and delegation.
  const trigger = {} as Node;
  const ancestor = { contains: (node: Node) => node === trigger } as unknown as EventTarget;
  const sibling = { contains: () => false } as unknown as EventTarget;
  assert.equal(scrollMovesTrigger(ancestor, trigger), true);
  assert.equal(scrollMovesTrigger(sibling, trigger), false);
  assert.equal(scrollMovesTrigger(new EventTarget(), trigger), false);
  assert.equal(scrollMovesTrigger(null, trigger), false);
  assert.equal(scrollMovesTrigger(ancestor, null), false);
});

test('an opt-in trigger-clear cap keeps a tall menu on one side even in a short viewport (#173)', () => {
  for (const [top, bottom, height, expected] of [
    [90, 118, 200, 76], [20, 48, 200, 138], [164, 192, 200, 150],
    [300, 328, 800, 458], [0, 200, 200, 0],
    [20.25, 48.25, 200, 137],
  ]) {
    const anchor = { left: 40, right: 150, top: top!, bottom: bottom! };
    const view = { w: 390, h: height! };
    const limit = menuHeightLimit(anchor, view);
    assert.equal(limit, expected);
    if (!limit) continue; // No room on either side is physically unsatisfiable.
    const h = Math.round(Math.min(500, limit)); // offsetHeight reports integer CSS pixels.
    const pos = menuPlacement(anchor, { w: 180, h }, view);
    assert.ok(pos.y + h <= anchor.top - 6 || pos.y >= anchor.bottom + 6);
    assert.ok(pos.y >= 8 && pos.y + h <= view.h - 8);
  }
  const anchor = { left: 40, right: 150, top: 90, bottom: 118 };
  const legacy = menuPlacement(anchor, { w: 180, h: 184 }, { w: 390, h: 200 });
  assert.ok(legacy.y < anchor.bottom && legacy.y + 184 > anchor.top,
    'negative control: viewport-only clamping covers the second click');
});

test('menuPlacement puts a context menu beside its trigger, inside the viewport', () => {
  const view = { w: 1200, h: 800 };
  const size = { w: 180, h: 200 };
  // Normal case: below the trigger, right edges aligned (the trigger is a dot
  // menu at a chip's right edge).
  const mid = { left: 420, right: 460, top: 300, bottom: 330 };
  const at = (a: typeof mid, s = size, v = view) => { const p = menuPlacement(a, s, v); return { x: p.x, y: p.y }; };
  assert.deepEqual(at(mid), { x: 280, y: 336 });
  // Not enough room below → flip above, keeping the same 6px gap.
  const low = { left: 420, right: 460, top: 700, bottom: 730 };
  assert.deepEqual(at(low), { x: 280, y: 494 });
  // A trigger near the left edge would put a right-aligned menu off screen.
  const left = { left: 10, right: 40, top: 100, bottom: 130 };
  assert.deepEqual(at(left), { x: 8, y: 136 });
  // …and near the right edge it must not overflow either.
  const right = { left: 1180, right: 1198, top: 100, bottom: 130 };
  assert.equal(menuPlacement(right, size, view).x, 1012, 'clamped to view.w - w - 8');
  // Taller than the viewport: pinned to the top edge rather than pushed off it.
  assert.equal(menuPlacement(low, { w: 180, h: 900 }, view).y, 8);
  // Unmeasured height (first frame) must not trigger a flip on a guess.
  assert.equal(menuPlacement(low, { w: 180, h: 0 }, view).y, 736);
});

test('a right-click or a long press anchors the menu on the pointer', () => {
  const view = { w: 1200, h: 800 };
  const size = { w: 180, h: 200 };
  // A pointer is a zero-size rect, so the ONE placement rule applies: the menu's
  // right edge lands on the pointer, 6px below it.
  const at = pointAnchor(500, 300);
  assert.deepEqual(at, { left: 500, right: 500, top: 300, bottom: 300 });
  const xy = (a: AnchorRect) => { const p = menuPlacement(a, size, view); return { x: p.x, y: p.y }; };
  assert.deepEqual(xy(at), { x: 320, y: 306 });
  // Near the bottom it flips above the pointer instead of hanging off screen.
  assert.deepEqual(xy(pointAnchor(500, 780)), { x: 320, y: 574 });
  // Near the left edge it is clamped, not right-aligned into the void.
  assert.deepEqual(xy(pointAnchor(40, 300)), { x: 8, y: 306 });
});

test('left alignment expands a NAME downward — same clamp, same flip (board #32)', async () => {
  const view = { w: 1200, h: 800 };
  const size = { w: 260, h: 200 };
  // The menu's LEFT edge sits on the name's left edge, 6px below it.
  const name = { left: 300, right: 420, top: 50, bottom: 78 };
  const xy = (a: AnchorRect, al: 'left' | 'right' = 'left') => { const p = menuPlacement(a, size, view, 6, 8, al); return { x: p.x, y: p.y }; };
  assert.deepEqual(xy(name), { x: 300, y: 84 });
  // Near the right viewport edge the clamp still wins — the menu is never
  // clipped, which is the bug this alignment exists to fix.
  const tight = { left: 1100, right: 1190, top: 50, bottom: 78 };
  assert.deepEqual(xy(tight), { x: 932, y: 84 }, 'clamped to view.w - w - 8');
  // Near the left edge it cannot go under the 8px margin either.
  assert.equal(menuPlacement({ left: 2, right: 60, top: 50, bottom: 78 }, size, view, 6, 8, 'left').x, 8);
  // The flip above is shared verbatim with the right alignment.
  const low = { left: 300, right: 420, top: 700, bottom: 730 };
  assert.deepEqual(xy(low), { x: 300, y: 494 });
  // And the DEFAULT stays right-aligned: every existing caller, unchanged.
  assert.deepEqual(xy(name, 'right'), { x: 160, y: 84 });

  // The anchor is zoom-compatible: anchorOf divides the element's client rect
  // (visual px) by --ui-zoom, landing in the fixed layer's own pixel space —
  // the 46px-drift class of bug (board #21's lesson) cannot come back through
  // this entry. Simulated DOM: a rect at 2x zoom halves.
  const g = globalThis as Record<string, unknown>;
  const hadDoc = 'document' in g, oldDoc = g.document;
  const hadGcs = 'getComputedStyle' in g, oldGcs = g.getComputedStyle;
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => '2' });
  try {
    const { anchorOf } = await import('./placement.ts');
    const el = { getBoundingClientRect: () => ({ left: 600, right: 840, top: 100, bottom: 128 }) } as unknown as Element;
    assert.deepEqual(anchorOf(el), { left: 300, right: 420, top: 50, bottom: 64 });
  } finally {
    if (hadDoc) g.document = oldDoc; else delete g.document;
    if (hadGcs) g.getComputedStyle = oldGcs; else delete g.getComputedStyle;
  }
});

test('popOrigin names the corner a popover grows from', () => {
  const anchor = { left: 420, right: 460, top: 300, bottom: 330 };
  assert.equal(popOrigin(anchor, { x: 280, y: 336 }), 'top right', 'below, right-aligned → grows from its top right');
  assert.equal(popOrigin(anchor, { x: 420, y: 336 }, 'left'), 'top left');
  assert.equal(popOrigin(anchor, { x: 280, y: 94 }), 'bottom right', 'flipped above → grows from its bottom edge');
  assert.equal(popOrigin(anchor, { x: 420, y: 94 }, 'left'), 'bottom left');
});

test('a rail popover opens BESIDE the rail and never slides back over it (#326)', () => {
  // Owner, 2026-10-09: "弹出的那个小窗口应该再往右一点 偏移开左边的侧边栏 现在
  // 经常点击按钮之后 小窗口就把上面的区域覆盖住了 导致我没办法再去点其他按钮".
  // The rail is 46px wide and its bell / server switcher sit in the BOTTOM
  // corner, so the old placement flipped the menu above them and clamped it
  // to the 8px margin — on top of the rail.
  const RAIL = 46;
  // The box a rail popover must clear: the control's vertical span with the
  // rail's right edge (App composes this; placement only honours it).
  const bell = { left: 6, right: RAIL, top: 880, bottom: 920 };
  const clears = (pos: { x: number }) => pos.x >= RAIL + 6;

  // Desktop, room to spare: beside the rail, aligned with the control's top.
  const wide = menuPlacement(bell, { w: 360, h: 520 }, { w: 1440, h: 960 }, 6, 8, 'right', 'right');
  assert.deepEqual(wide, { x: 52, y: 432, maxW: 1380, maxH: 944 },
    'x = rail right + gap; y clamps a tall popover onto the bottom margin');
  assert.ok(clears(wide));

  // The regression itself, as a negative control: the DEFAULT side puts the
  // same menu on the rail.
  const old = menuPlacement(bell, { w: 360, h: 520 }, { w: 1440, h: 960 }, 6, 8);
  assert.equal(old.x, 8, 'negative control: below+clamp is the bug being fixed');
  assert.ok(!clears(old));

  // A FORCED-Desktop narrow window (layout.svelte.ts lets a phone or a small
  // window run the rail layout, so 760px is not a floor): the popover gets
  // LESS ROOM, never a position over the rail. The caller caps itself with
  // maxW and scrolls inside.
  const narrow = menuPlacement(bell, { w: 360, h: 520 }, { w: 280, h: 620 }, 6, 8, 'right', 'right');
  assert.equal(narrow.x, 52, 'still beside the rail');
  assert.equal(narrow.maxW, 220, 'the room is what shrinks: 280 - 52 - 8');
  assert.ok(clears(narrow));
  // Even absurdly narrow: zero room is reported, the position never regresses.
  const squeezed = menuPlacement(bell, { w: 360, h: 520 }, { w: 54, h: 620 }, 6, 8, 'right', 'right');
  assert.equal(squeezed.x, 52);
  assert.equal(squeezed.maxW, 0);

  // Zoom: anchorOf already divides by --ui-zoom, so the rects arriving here
  // are in the fixed layer's own pixels and the same guarantee holds.
  const zoomed = menuPlacement(
    { left: 3, right: RAIL / 2, top: 440, bottom: 460 },
    { w: 180, h: 260 }, { w: 720, h: 480 }, 6, 8, 'right', 'right',
  );
  assert.equal(zoomed.x, RAIL / 2 + 6);
  assert.equal(zoomed.y, 212, 'y still clamps inside the zoomed viewport');

  // An unmeasured height does not guess a clamp (the caller hides that frame).
  assert.equal(menuPlacement(bell, { w: 360, h: 0 }, { w: 1440, h: 960 }, 6, 8, 'right', 'right').y, 880);
  // A short popover keeps the control's top edge.
  assert.equal(menuPlacement(bell, { w: 360, h: 40 }, { w: 1440, h: 960 }, 6, 8, 'right', 'right').y, 880);

  // The Hub header's bell is NOT in the rail, so it keeps the dropdown
  // reading — the same centre store, one branch in App, no second rule here.
  const header = { left: 300, right: 340, top: 60, bottom: 92 };
  const below = menuPlacement(header, { w: 360, h: 520 }, { w: 420, h: 900 }, 6, 8);
  assert.deepEqual({ x: below.x, y: below.y }, { x: 8, y: 98 },
    'under the trigger, right-aligned and clamped — the phone reading, untouched');

  // And it grows from the edge that touches the anchor.
  assert.equal(popOrigin(bell, wide, 'right', 'right'), 'bottom left', 'clamped above its anchor top');
  assert.equal(popOrigin(bell, { x: 52, y: 880 }, 'right', 'right'), 'top left');
  assert.equal(popOrigin(header, below), 'top right', 'the dropdown reading is unchanged');
});

test('every placement reports the room it found, so no caller has to guess (#326)', () => {
  // The room is the same contract for both sides: a below-placed popover is
  // capped by the viewport margins it was already clamped into.
  const anchor = { left: 420, right: 460, top: 300, bottom: 330 };
  const pos = menuPlacement(anchor, { w: 180, h: 200 }, { w: 1200, h: 800 });
  assert.deepEqual(pos, { x: 280, y: 336, maxW: 1184, maxH: 784 });
});

test('placement inside a box with a non-zero origin is the zero-origin rule, shifted (#461)', () => {
  const size = { w: 200, h: 120 };
  // At the origin the wrapper IS menuPlacement.
  const flush: AnchorRect = { left: 0, top: 0, right: 390, bottom: 700 };
  const rail: AnchorRect = { left: 0, right: 44, top: 250, bottom: 450 };
  for (const side of ['right', 'below'] as const) {
    assert.deepEqual(menuPlacementIn(flush, rail, size, 8, 8, 'right', side), menuPlacement(rail, size, { w: 390, h: 700 }, 8, 8, 'right', side));
  }
  // Under a 56px header and above a 80px composer: the box is 56..620.
  const box: AnchorRect = { left: 0, top: 56, right: 390, bottom: 620 };
  const lowRail: AnchorRect = { left: 0, right: 44, top: 540, bottom: 600 };
  const at = menuPlacementIn(box, lowRail, size, 8, 8, 'right', 'right');
  assert.equal(at.x, 52);
  assert.ok(at.y >= 56 + 8, 'never under the header');
  assert.ok(at.y + size.h <= 620 - 8, 'never over the composer');
  assert.equal(at.maxH, 564 - 16);
  assert.equal(at.maxW, 390 - 52 - 8);
  // A tall popover rests on the box's top margin, not on the viewport's.
  const tall = menuPlacementIn(box, lowRail, { w: 200, h: 600 }, 8, 8, 'right', 'right');
  assert.equal(tall.y, 56 + 8, 'taller than the room: clamped to the box top margin');
  assert.equal(tall.maxH, 564 - 16);
});

test('a keyboard-shrunk bottom, a narrow column and a left offset all move the box, not the rule (#461)', () => {
  const size = { w: 260, h: 90 };
  // Visual viewport cut to 300px tall by the keyboard, composer 70px of that.
  const keyboard: AnchorRect = { left: 0, top: 50, right: 390, bottom: 230 };
  const rail: AnchorRect = { left: 0, right: 44, top: 150, bottom: 225 };
  const k = menuPlacementIn(keyboard, rail, size, 8, 8, 'right', 'right');
  assert.ok(k.y + size.h <= 230 - 8, 'inside the shrunk box');
  // A drawer column that starts at x=300 and is 180 wide: the popover takes what is left of it.
  const column: AnchorRect = { left: 300, top: 0, right: 480, bottom: 600 };
  const colRail: AnchorRect = { left: 300, right: 344, top: 100, bottom: 200 };
  const c = menuPlacementIn(column, colRail, size, 8, 8, 'right', 'right');
  assert.equal(c.x, 352);
  assert.equal(c.maxW, 480 - 352 - 8, 'the room left in the column, so it narrows instead of leaving it');
});

test('two rects intersect, and disjoint ones collapse to an empty rect (#461)', () => {
  assert.deepEqual(intersectRects({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 20, top: 30, right: 200, bottom: 60 }),
    { left: 20, top: 30, right: 100, bottom: 60 });
  const e = intersectRects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 50, top: 50, right: 80, bottom: 80 });
  assert.equal(e.right - e.left, 0);
  assert.equal(e.bottom - e.top, 0);
});
