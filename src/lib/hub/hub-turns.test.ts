import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeedBlock } from './hub.ts';
import {
  askTurns, blockKey, isAskBlock, previewRows, scrubDown, scrubFactor, scrubIndex, scrubMaxFactor,
  scrubMove, stepTurn, tickCapacity, tickCount, tickOf, turnIndex, turnLabel, turnsSig,
} from './hub-turns.ts';
import type { ScrubGeom } from './hub-turns.ts';

const msg = (id: string | undefined, from: string, body: string, ts = 1): FeedBlock =>
  ({ type: 'msg', ts, msg: { id, from, body }, delivered: true });
const sys = (key: string): FeedBlock => ({ type: 'sys', ts: 1, key, items: [] });

test('a turn is a message the person sent: agent bubbles, steps and system rows never are', () => {
  const blocks = [
    msg('a', 'human', 'one'), msg('b', 'kiro', 'reply'), sys('s1'),
    { type: 'steps', ts: 1, window: 'w', key: 'st', events: [] } as FeedBlock,
    msg('c', 'human', 'two'), msg('d', 'human', 'three'),
  ];
  assert.deepEqual(askTurns(blocks).map((t) => t.key), ['a', 'c', 'd']);
  assert.equal(isAskBlock(blocks[1]), false);
  assert.equal(isAskBlock(undefined), false);
});

test('the key is the feed identity: the id, else the time and position of the row', () => {
  const blocks = [sys('s'), msg(undefined, 'human', 'x', 77), msg('id9', 'human', 'y')];
  assert.equal(blockKey(blocks[0]!, 0), 's');
  assert.equal(blockKey(blocks[1]!, 1), 'm77-1');
  assert.deepEqual(askTurns(blocks).map((t) => t.key), ['m77-1', 'id9']);
});

test('the turn set identity is the ordered keys only: new bodies do not change it', () => {
  const a = askTurns([msg('a', 'human', 'one'), msg('b', 'kiro', 'r'), msg('c', 'human', 'two')]);
  const b = askTurns([msg('a', 'human', 'ONE EDITED'), msg('b', 'kiro', 'a streamed reply'), msg('c', 'human', 'two')]);
  assert.equal(turnsSig(a), turnsSig(b));
  const prepended = askTurns([msg('z', 'human', 'older'), msg('a', 'human', 'one'), msg('c', 'human', 'two')]);
  assert.notEqual(turnsSig(a), turnsSig(prepended));
  assert.equal(turnIndex(a, 'c'), 1);
  assert.equal(turnIndex(a, 'nope'), -1);
  assert.equal(turnIndex(a, ''), -1);
});

test('the label is the first line the bubble would show', () => {
  const label = (body: string, command?: { to: string[]; name: string; args: string }) => {
    const b = msg('k', 'human', body) as Extract<FeedBlock, { type: 'msg' }>;
    if (command) b.command = command;
    return turnLabel({ block: b });
  };
  assert.deepEqual(label('  \n\n  hello   there\nsecond line'), { text: 'hello there', image: false });
  assert.deepEqual(label('![shot](/f/a.png)'), { text: '', image: true });
  assert.deepEqual(label('look ![shot](/f/a.png)'), { text: 'look', image: false });
  assert.deepEqual(label('[tmm status working] drafting the plan'), { text: 'drafting the plan', image: false });
  assert.deepEqual(label('@kiro [re kiro 10:02: 「the old words」] and the new ones'), { text: '@kiro and the new ones', image: false });
  assert.deepEqual(label('[tmm] /goal ship it → kiro', { to: ['kiro'], name: 'goal', args: '\n\nship it\nmore' }),
    { text: '/goal ship it', image: false });
  assert.deepEqual(label('[tmm] /clear → kiro', { to: ['kiro'], name: 'clear', args: '' }), { text: '/clear', image: false });
  assert.deepEqual(label(''), { text: '', image: false });
});

test('arrow stepping walks real turns and starts at the newest from nothing', () => {
  assert.equal(stepTurn(0, -1, 1), -1);
  assert.equal(stepTurn(5, -1, -1), 4);
  assert.equal(stepTurn(5, -1, 1), 4);
  assert.equal(stepTurn(5, 4, 1), 4);
  assert.equal(stepTurn(5, 0, -1), 0);
  assert.equal(stepTurn(5, 2, -1), 1);
  assert.equal(stepTurn(5, 9, -1), 4);
});

test('the popover rows are the probed turn with the neighbours that exist', () => {
  assert.deepEqual(previewRows(5, 0), [0, 1]);
  assert.deepEqual(previewRows(5, 2), [1, 2, 3]);
  assert.deepEqual(previewRows(5, 4), [3, 4]);
  assert.deepEqual(previewRows(5, -1), []);
  assert.deepEqual(previewRows(5, 5), []);
});

test('ticks compress the drawing and never the turns', () => {
  assert.equal(tickCapacity(300, 10), 30);
  assert.equal(tickCapacity(5, 10), 2);
  assert.equal(tickCapacity(300, 0), 2);
  assert.equal(tickCount(7, 30), 7);
  assert.equal(tickCount(500, 30), 30);
  for (const [count, ticks] of [[7, 7], [30, 30], [31, 30], [500, 30], [100000, 17]] as const) {
    let last = -1;
    const used = new Set<number>();
    for (let i = 0; i < count; i++) {
      const t = tickOf(i, count, ticks);
      assert.ok(t >= last && t < ticks, `monotonic and in range at ${i}`);
      last = t; used.add(t);
    }
    assert.equal(used.size, ticks, 'every drawn tick holds at least one turn');
  }
  assert.equal(tickOf(-1, 5, 5), -1);
});

// -- scrubbing ---------------------------------------------------------------

const geom = (height: number, reach = 88): ScrubGeom => ({ top: 100, height, edge: 44, reach });

test('a press maps to the slice under the finger and the ends clamp', () => {
  const g = geom(250);
  assert.equal(scrubIndex(scrubDown(100, 10, g), 10), 0);
  assert.equal(scrubIndex(scrubDown(350, 10, g), 10), 9);
  assert.equal(scrubIndex(scrubDown(225, 10, g), 10), 5);
  assert.equal(scrubIndex(scrubDown(-9000, 10, g), 10), 0);
  assert.equal(scrubIndex(scrubDown(9000, 10, g), 10), 9);
  assert.equal(scrubIndex(0, 0), -1);
});

test('on the band the scrub is 1:1 with the slices; away from it, finer', () => {
  const g = geom(200), M = 1000;
  assert.equal(scrubMaxFactor(M, 200), 5);
  assert.equal(scrubFactor(44, M, g), 1);
  assert.equal(scrubFactor(10, M, g), 1);
  assert.equal(scrubFactor(44 + 88, M, g), 5);
  assert.equal(scrubFactor(9000, M, g), 5);
  assert.equal(scrubFactor(44 + 44, M, g), 3);
  assert.equal(scrubMaxFactor(3, 200), 1);
  assert.equal(scrubFactor(9000, 3, g), 1);
  assert.equal(scrubFactor(9000, M, { ...g, reach: 0 }), 5);
});

test('at the far end one pixel moves at most one turn, so no turn is skipped', () => {
  for (const [M, h] of [[500, 120], [2000, 40], [100000, 250], [77, 600]] as const) {
    const g = geom(h), x = g.edge + g.reach;
    let q = scrubDown(g.top + h / 2, M, g);
    for (let i = 0; i < 2000; i++) {
      const dy = i % 400 < 200 ? 1 : -1;
      const next = scrubMove(q, dy, x, M, g);
      assert.ok(Math.abs(scrubIndex(next, M) - scrubIndex(q, M)) <= 1, `M=${M} h=${h} step ${i}`);
      q = next;
    }
  }
});

test('moving across the band edge and the reach never jumps the probe', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const [M, h] of [[500, 120], [2000, 40], [100000, 250]] as const) {
    const g = geom(h);
    let q = scrubDown(g.top + h / 2, M, g);
    let x = g.edge;
    for (let i = 0; i < 5000; i++) {
      x = Math.max(0, Math.min(320, x + Math.round((rnd() - 0.5) * 30)));
      const dy = Math.round((rnd() - 0.5) * 10);
      const next = scrubMove(q, dy, x, M, g);
      assert.ok(Math.abs(next - q) <= Math.abs(dy) * (M / h) + 1e-9, 'a move is never worth more than its coarse travel');
      q = next;
    }
  }
  // The factor itself is continuous across the edge and across the reach.
  const g = geom(120), M = 2000, max = scrubMaxFactor(M, 120);
  for (let x = 30; x < 200; x++) {
    assert.ok(Math.abs(scrubFactor(x + 1, M, g) - scrubFactor(x, M, g)) <= (max - 1) / g.reach + 1e-9, `x=${x}`);
  }
});

test('hitting an end and reversing does not wind up', () => {
  const g = geom(200), M = 1000, x = g.edge;
  let q = scrubDown(g.top + 100, M, g);
  q = scrubMove(q, -100000, x, M, g);
  assert.equal(scrubIndex(q, M), 0);
  q = scrubMove(q, 1, x, M, g);
  assert.equal(scrubIndex(q, M), 5, 'one pixel off the top moves one coarse step, not minus the overshoot');
  q = scrubMove(q, 100000, x, M, g);
  assert.equal(scrubIndex(q, M), M - 1);
  q = scrubMove(q, -1, x, M, g);
  assert.equal(scrubIndex(q, M), M - 6);
});

/**
 * A planner over what a real touch can do: INTEGER pixel positions, the finger
 * inside the band vertically and inside a 320px-wide viewport horizontally. It
 * presses at the best integer y, then repeatedly picks the one-pixel vertical
 * step and integer x whose result lands closest to the target. Everything goes
 * through scrubDown/scrubMove, so it cannot write the position directly.
 */
function reach(M: number, h: number, target: number, viewport = 320): { moves: number; ok: boolean } {
  const g = geom(h, Math.min(88, viewport - 44));
  const aim = target + 0.5;
  let y = g.top, best = Infinity;
  for (let yy = g.top; yy <= g.top + h; yy++) {
    const e = Math.abs(scrubDown(yy, M, g) - aim);
    if (e < best) { best = e; y = yy; }
  }
  let q = scrubDown(y, M, g);
  let moves = 0;
  while (scrubIndex(q, M) !== target && moves < 6000) {
    let pick: { y: number; q: number; e: number } | null = null;
    for (const dy of [-1, 1]) {
      const ny = y + dy;
      if (ny < g.top || ny > g.top + h) continue;
      for (let x = 0; x <= g.edge + g.reach; x++) {
        const nq = scrubMove(q, dy, x, M, g);
        const e = Math.abs(nq - aim);
        if (!pick || e < pick.e) pick = { y: ny, q: nq, e };
      }
    }
    if (!pick) break;
    y = pick.y; q = pick.q; moves++;
  }
  return { moves, ok: scrubIndex(q, M) === target };
}

test('every turn of a feed is reachable by integer pointer positions alone', () => {
  const cases: Array<[number, number, number]> = [
    [3, 120, 1], [29, 120, 1], [30, 120, 1], [31, 120, 1],
    [500, 120, 1], [500, 250, 1], [500, 600, 1],
    [2000, 40, 1],          // M above h squared: needs the pump of repeated strokes
    [2000, 120, 1],
  ];
  for (const [M, h, stride] of cases) {
    for (let target = 0; target < M; target += stride) {
      const r = reach(M, h, target);
      assert.ok(r.ok, `M=${M} h=${h} target=${target} not reached in ${r.moves} moves`);
    }
  }
});

test('a very large feed is reachable too (the ends and a sweep across it)', () => {
  // [20000, 40] and [5000, 40] are far above h squared: a one-stroke reach cannot cover them.
  for (const [M, h] of [[20000, 40], [5000, 40], [20000, 120], [100000, 120], [100000, 250]] as const) {
    const targets = new Set([0, 1, 2, M - 3, M - 2, M - 1, Math.floor(M / 2)]);
    for (let t = 7; t < M; t += 1013) targets.add(t);
    for (const target of targets) {
      const r = reach(M, h, target);
      assert.ok(r.ok, `M=${M} h=${h} target=${target} not reached in ${r.moves} moves`);
    }
  }
});

test('a narrow viewport leaves less room to slide and every turn is still reachable', () => {
  for (const target of [0, 1, 17, 250, 498, 499]) {
    assert.ok(reach(500, 120, target, 60).ok, `target ${target}`);
  }
});
