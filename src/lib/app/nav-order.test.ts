import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_DEFAULT_ORDER,
  RAIL_DRAG_THRESHOLD,
  RAIL_GAP,
  RAIL_PAGES,
  groupDropAt,
  isDefaultRailOrder,
  listDropAt,
  moveBefore,
  moveRailItem,
  normalizeRailOrder,
  parseRailOrder,
  railDropAt,
  railDropIndex,
  railDropOffset,
  railOrderToStore,
  visibleRailSlots,
  type RailPage,
  type RailSlot,
} from './nav-order.ts';

const ALL: RailSlot[] = [...RAIL_DEFAULT_ORDER];

test('the shipped order is the two documented groups, gap included', () => {
  assert.deepEqual(ALL, ['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs']);
  // The gap is a member, not a special case in the renderer — that is what lets
  // a drag cross it instead of being silently refused.
  assert.equal(ALL.filter((s) => s === RAIL_GAP).length, 1);
  // Every other slot is a page, so every icon is draggable — including the gear.
  assert.deepEqual([...RAIL_PAGES], ['hub', 'terminal', 'files', 'board', 'agents', 'prefs']);
  assert.ok(RAIL_PAGES.includes('prefs'), 'the gear is a rail page icon like any other');
});

test('normalize returns every slot exactly once, whatever it is handed', () => {
  const cases: unknown[] = [
    null, undefined, 'terminal', 42, {}, [], [null, 7, {}],
    ['files', 'files', 'files'],
    ['files', 'nope', 'sessions', 'settings', 'team'],   // real pages, not rail pages
  ];
  for (const input of cases) {
    const out = normalizeRailOrder(input);
    assert.deepEqual(
      [...out].sort(), [...ALL].sort(),
      `normalize(${JSON.stringify(input)}) must yield the full slot set once each`,
    );
  }
});

test('a saved order is honoured, and junk inside it is dropped', () => {
  const out = normalizeRailOrder(['prefs', 'files', 'ghost', 'files', RAIL_GAP, 'terminal', 'hub', 'board', 'agents']);
  assert.deepEqual(out, ['prefs', 'files', RAIL_GAP, 'terminal', 'hub', 'board', 'agents']);
});

test('a page the saved order never heard of arrives beside its DEFAULT neighbour', () => {
  // The board shipped after the rail did. A saved order from that build has no
  // 'board', and appending it would bury a new page at the bottom of every
  // custom rail instead of putting it where it was designed to sit (after
  // 'files', which is its default predecessor).
  const preBoard = ['hub', 'terminal', 'files', RAIL_GAP, 'agents', 'prefs'];
  assert.deepEqual(
    normalizeRailOrder(preBoard),
    ['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs'],
  );
  // It follows the neighbour, not the index: with 'files' moved to the bottom,
  // 'board' goes with it.
  assert.deepEqual(
    normalizeRailOrder(['hub', 'terminal', RAIL_GAP, 'agents', 'prefs', 'files']),
    ['hub', 'terminal', RAIL_GAP, 'agents', 'prefs', 'files', 'board'],
  );
  // Nothing earlier survives → it lands BEFORE its closest later neighbour, so
  // a missing first item stays first rather than falling to the end.
  assert.deepEqual(
    normalizeRailOrder(['terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs']),
    ['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs'],
  );
});

test('the default order stores NOTHING; a custom one round-trips', () => {
  assert.ok(isDefaultRailOrder(ALL));
  assert.equal(railOrderToStore(ALL), null, 'a key repeating the shipped order would pin it for a user with no preference');

  const custom: RailSlot[] = ['terminal', 'hub', 'files', 'board', RAIL_GAP, 'agents', 'prefs'];
  assert.ok(!isDefaultRailOrder(custom));
  const raw = railOrderToStore(custom);
  assert.ok(raw);
  assert.deepEqual(parseRailOrder(raw), custom, 'what was written is what comes back');

  // Untrusted read side: absent, empty and corrupt all fall back to the default.
  for (const raw2 of [null, undefined, '', 'not json', '{"a":1}', '[1,2,3]']) {
    assert.deepEqual(parseRailOrder(raw2), ALL, `parseRailOrder(${JSON.stringify(raw2)})`);
  }
});

test('a hidden page keeps its saved position — only the rendering is filtered', () => {
  // No bus → hub/board/agents are not rendered. The order still carries them.
  const custom = normalizeRailOrder(['agents', 'terminal', 'hub', RAIL_GAP, 'files', 'board', 'prefs']);
  const noBus = (p: RailPage) => p !== 'hub' && p !== 'board' && p !== 'agents';
  assert.deepEqual(visibleRailSlots(custom, noBus), ['terminal', RAIL_GAP, 'files', 'prefs']);
  assert.deepEqual(custom, ['agents', 'terminal', 'hub', RAIL_GAP, 'files', 'board', 'prefs'], 'filtering must not mutate');
  // Turned back on, they are exactly where the user left them.
  assert.deepEqual(visibleRailSlots(custom, () => true), custom);
  // The gap always renders: it is the rail's own geometry, not a page.
  assert.deepEqual(visibleRailSlots(ALL, () => false), [RAIL_GAP]);
});

test('a drag moves one slot and leaves the hidden ones where they were', () => {
  const order: RailSlot[] = ['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs'];

  assert.deepEqual(moveRailItem(order, 'files', 'hub'), ['files', 'hub', 'terminal', 'board', RAIL_GAP, 'agents', 'prefs']);
  assert.deepEqual(moveRailItem(order, 'hub', null), ['terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs', 'hub'], 'null anchor = last');
  // Across the gap, both ways — the grouping is a default, not a cage.
  assert.deepEqual(moveRailItem(order, 'hub', 'prefs'), ['terminal', 'files', 'board', RAIL_GAP, 'agents', 'hub', 'prefs']);
  assert.deepEqual(moveRailItem(order, 'prefs', 'terminal'), ['hub', 'prefs', 'terminal', 'files', 'board', RAIL_GAP, 'agents']);
  // Dropping just above the gap is an ordinary drop.
  assert.deepEqual(moveRailItem(order, 'agents', RAIL_GAP), ['hub', 'terminal', 'files', 'board', 'agents', RAIL_GAP, 'prefs']);

  // No-ops, each returning a copy rather than mutating.
  for (const [slot, before] of [['files', 'files'], ['files', 'board'], ['ghost', 'hub'], ['files', 'ghost'], [RAIL_GAP, 'hub']] as [RailSlot, RailSlot][]) {
    const out = moveRailItem(order, slot, before);
    assert.deepEqual(out, order, `move(${slot} before ${before}) must be a no-op`);
    assert.notEqual(out, order, 'always a new array');
  }
  // The dragged slot never duplicates, whatever the anchor.
  for (const slot of RAIL_PAGES) {
    for (const before of [...ALL, null]) {
      const out = moveRailItem(order, slot, before);
      assert.deepEqual([...out].sort(), [...order].sort(), `move(${slot} before ${before}) changed the slot set`);
    }
  }
});

test('a drag reorders the FULL order, so a hidden neighbour is not rewritten', () => {
  // 'board' is hidden (no bus) and sits between two visible icons. Dropping
  // 'prefs' before 'files' must not disturb it.
  const order: RailSlot[] = ['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs'];
  const next = moveRailItem(order, 'prefs', 'files');
  assert.deepEqual(next, ['hub', 'terminal', 'prefs', 'files', 'board', RAIL_GAP, 'agents']);
  assert.equal(next.indexOf('board'), next.indexOf('files') + 1, 'the hidden page keeps its neighbour');
});

test('the drop index is decided by MIDPOINTS, so there is no dead zone', () => {
  // Three 32px icons with 4px gaps, as the rail lays them out.
  const slots = [{ top: 10, bottom: 42 }, { top: 46, bottom: 78 }, { top: 82, bottom: 114 }];
  assert.equal(railDropIndex(slots, 0), 0, 'above everything');
  assert.equal(railDropIndex(slots, 25), 0, 'top half of the first icon');
  assert.equal(railDropIndex(slots, 26), 1, 'its exact midpoint already means below');
  assert.equal(railDropIndex(slots, 44), 1, 'the 4px gap between two icons resolves, never dangles');
  assert.equal(railDropIndex(slots, 61), 1);
  assert.equal(railDropIndex(slots, 63), 2);
  assert.equal(railDropIndex(slots, 500), 3, 'past the end clamps to the end');
  assert.equal(railDropIndex([], 40), 0, 'an empty rail has one insertion point');

  // Every y maps to a real insertion point.
  for (let y = -20; y < 200; y++) {
    const i = railDropIndex(slots, y);
    assert.ok(i >= 0 && i <= slots.length, `y=${y} gave ${i}`);
  }
});

test('the insertion line sits on the edge it would push, and the end edge last', () => {
  const slots = [{ top: 10, bottom: 42 }, { top: 46, bottom: 78 }];
  assert.equal(railDropOffset(slots, 0), 10);
  assert.equal(railDropOffset(slots, 1), 46);
  assert.equal(railDropOffset(slots, 2), 78, 'landing last draws under the last icon');
  assert.equal(railDropOffset(slots, 99), 78, 'an out-of-range index clamps');
  assert.equal(railDropOffset(slots, -1), 10);
  assert.equal(railDropOffset([], 0), null, 'nothing to insert between');
});

test('a click is not a drag: the threshold absorbs mouse jitter', () => {
  // A press that moves 2–3px is an ordinary click, and a click must switch
  // pages — that is what the icon is for almost every time it is pressed.
  assert.ok(RAIL_DRAG_THRESHOLD >= 4, 'below ~4px ordinary clicks would start dragging');
  assert.ok(RAIL_DRAG_THRESHOLD <= 10, 'above ~10px the drag feels stuck before it starts');
});

test('a whole gesture: the icon lands where the line was drawn', () => {
  // The rail as the DOM reports it, with the bus off: hub, board and agents are
  // in the order but not on screen, so they have no rects. 34px buttons, 4px
  // gaps, then the flex gap, then the gear at the bottom.
  const order = normalizeRailOrder(['hub', 'terminal', 'files', 'board', RAIL_GAP, 'agents', 'prefs']);
  const rects = [
    { slot: 'terminal', top: 40, bottom: 72 },
    { slot: 'files', top: 76, bottom: 108 },
    { slot: RAIL_GAP, top: 112, bottom: 700 },
    { slot: 'prefs', top: 704, bottom: 736 },
  ];

  // Drag 'files' up over the top half of 'terminal' and release.
  const idx = railDropIndex(rects, 50);
  assert.equal(idx, 0);
  assert.equal(railDropOffset(rects, idx), 40, 'the line is drawn on terminal’s top edge');
  const after = railDropAt(order, 'files', rects, idx);
  assert.deepEqual(after, ['hub', 'files', 'terminal', 'board', RAIL_GAP, 'agents', 'prefs'],
    'it lands above terminal — and hub/board/agents, which had no rects, keep their places');

  // Drag the gear up out of the bottom group, into the gap's top half.
  const gapIdx = railDropIndex(rects, 200);
  assert.equal(gapIdx, 2, 'the top half of the gap means "above the gap"');
  assert.deepEqual(
    railDropAt(order, 'prefs', rects, gapIdx),
    ['hub', 'terminal', 'files', 'board', 'prefs', RAIL_GAP, 'agents'],
    'crossing the gap is an ordinary drop',
  );

  // Release past the last rect: the one drop with no anchor.
  const endIdx = railDropIndex(rects, 900);
  assert.equal(endIdx, rects.length);
  assert.deepEqual(
    railDropAt(order, 'terminal', rects, endIdx),
    ['hub', 'files', 'board', RAIL_GAP, 'agents', 'prefs', 'terminal'],
  );

  // Released where it started: nothing moves, whichever half it sits over.
  // The bottom half is the trap — resolved through the anchor it would mean
  // "before the next VISIBLE slot", stepping 'files' over the hidden 'board'
  // for a rail that looked completely untouched.
  for (const y of [80, 100]) {
    assert.deepEqual(railDropAt(order, 'files', rects, railDropIndex(rects, y)), order,
      `a release at y=${y} must not shuffle the rail`);
  }
  assert.deepEqual(railDropAt(order, 'files', rects, 2), order, 'the insertion point just below the icon is a no-op');
  assert.deepEqual(railDropAt(order, 'files', rects, 1), order, 'and so is the one just above it');
  // The same release when nothing is hidden is equally a no-op.
  const shown = [
    { slot: 'hub', top: 40, bottom: 72 }, { slot: 'terminal', top: 76, bottom: 108 },
    { slot: 'files', top: 112, bottom: 144 }, { slot: 'board', top: 148, bottom: 180 },
    { slot: RAIL_GAP, top: 184, bottom: 700 }, { slot: 'agents', top: 704, bottom: 736 },
    { slot: 'prefs', top: 740, bottom: 772 },
  ];
  for (const y of [116, 140]) {
    assert.deepEqual(railDropAt(order, 'files', shown, railDropIndex(shown, y)), order);
  }

  // A stale index (rects from an aborted drag) can only mean "last", never a
  // corrupt order.
  for (const bad of [rects.length + 5, 99]) {
    assert.deepEqual([...railDropAt(order, 'files', rects, bad)].sort(), [...order].sort());
  }
});

test('the generic list drop is the same drag the rail speaks (board #222)', () => {
  // The Connection page's failover addresses reorder through moveBefore /
  // listDropAt — the rail's commit rules with no rail vocabulary: no gap, no
  // hidden slots, every rendered row has a rect.
  const list = ['ws://lan:1', 'ws://tail:2', 'wss://wan:3'];
  assert.deepEqual(moveBefore(list, 'wss://wan:3', 'ws://lan:1'), ['wss://wan:3', 'ws://lan:1', 'ws://tail:2']);
  assert.deepEqual(moveBefore(list, 'ws://lan:1', null), ['ws://tail:2', 'wss://wan:3', 'ws://lan:1'],
    'a null anchor lands last');
  assert.deepEqual(moveBefore(list, 'ws://lan:1', 'ws://lan:1'), list, 'dropping on itself is a no-op');
  assert.deepEqual(moveBefore(list, 'ws://ghost:9', 'ws://lan:1'), list, 'an item the list never had moves nothing');
  assert.deepEqual(moveBefore(list, 'ws://lan:1', 'ws://ghost:9'), list, 'a stale anchor refuses rather than guesses');

  const rects = [
    { slot: 'ws://lan:1', top: 10, bottom: 46 },
    { slot: 'ws://tail:2', top: 54, bottom: 90 },
    { slot: 'wss://wan:3', top: 98, bottom: 134 },
  ];
  assert.deepEqual(listDropAt(list, 'wss://wan:3', rects, 0), ['wss://wan:3', 'ws://lan:1', 'ws://tail:2']);
  assert.deepEqual(listDropAt(list, 'ws://lan:1', rects, 3), ['ws://tail:2', 'wss://wan:3', 'ws://lan:1'],
    'an index past the last rect is the one drop with no anchor');
  // The insertion points touching the dragged row — just above and just below
  // it — both mean UNCHANGED, said explicitly rather than falling out of the move.
  assert.deepEqual(listDropAt(list, 'ws://tail:2', rects, 1), list);
  assert.deepEqual(listDropAt(list, 'ws://tail:2', rects, 2), list);
});

test('a group drop is the box under the pointer, edges included, else nothing (board #384)', () => {
  // The roster's team clusters on one row, snapshotted at drag start; the
  // keys are what the drop means ('' = standalone).
  const rects = [
    { key: 'squad', left: 0, top: 0, right: 200, bottom: 60 },
    { key: '', left: 210, top: 0, right: 300, bottom: 60 },
    { key: 'ops', left: 310, top: 0, right: 420, bottom: 60 },
  ];
  assert.equal(groupDropAt(rects, 100, 30), 'squad');
  assert.equal(groupDropAt(rects, 250, 59), '', 'the standalone key is a target, not "nothing"');
  assert.equal(groupDropAt(rects, 420, 0), 'ops', 'an edge belongs to its box');
  assert.equal(groupDropAt(rects, 205, 30), null, 'the gap between two boxes drops nowhere');
  assert.equal(groupDropAt(rects, 100, 61), null, 'below the strip drops nowhere');
  assert.equal(groupDropAt([], 0, 0), null);
});
