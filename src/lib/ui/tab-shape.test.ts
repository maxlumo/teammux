// The lit tab's outline is one path; its joints are pure geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabPaths } from './tab-shape.ts';

const cmds = (d: string) => [...d.matchAll(/([MLAZ])([^MLAZ]*)/gu)].map((m) => [m[1] ?? '', ...(m[2] ?? '').trim().split(/[\s,]+/u).filter(Boolean).map(Number)] as [string, ...number[]]);
const ends = (d: string) => cmds(d).filter((c) => c[0] !== 'Z').map((c) => c.slice(-2) as number[]);

test('the edge is ONE open stroke: foot, side, top corners, side, foot', () => {
  const p = tabPaths(100, 31, 12, 8)!;
  const c = cmds(p.edge);
  assert.equal(c.map((x) => x[0]).join(''), 'MALALALA', 'one M, no second subpath: two feet, two top corners');
});

test('the side meets the floor tangentially on half-pixel centres', () => {
  const [w, h, r, f] = [100, 31, 12, 8];
  const pts = ends(tabPaths(w, h, r, f)!.edge);
  const yf = h - 1.5;
  assert.deepEqual(pts[0], [0.5, yf], 'the left foot starts ON the floor row');
  assert.deepEqual(pts[1], [f + 0.5, yf - f], 'and turns straight up the side stroke column');
  assert.deepEqual(pts[2], [f + 0.5, 0.5 + r], 'the side is vertical, one column');
  assert.deepEqual(pts[3], [f + 0.5 + r, 0.5], 'the top is one row');
  assert.deepEqual(pts.at(-1), [w - 0.5, yf], 'the right foot ends ON the floor row');
  const arcs = cmds(tabPaths(w, h, r, f)!.edge).filter((x) => x[0] === 'A');
  assert.deepEqual(arcs.map((a) => a[5]), [0, 1, 1, 0], 'feet are concave, top corners convex');
});

test('the fill is the stroke offset half a pixel outward and closed into the band', () => {
  const [w, h, r, f] = [100, 31, 12, 8];
  const c = cmds(tabPaths(w, h, r, f)!.fill);
  assert.equal(c.at(-1)![0], 'Z');
  const pts = ends(tabPaths(w, h, r, f)!.fill);
  assert.deepEqual(pts[0], [0.5, h - 2], 'starts at the top of the floor row, where the foot stroke begins');
  assert.deepEqual(pts[1], [f, h - 1.5 - f], 'the side fill reaches the stroke\'s outer edge');
  assert.deepEqual(pts[4], [w - f - 0.5 - r, 0], 'the top fill reaches the stroke\'s outer edge');
  assert.ok(pts.some(([, y]) => y === h), 'one pixel into the band');
  const arcs = c.filter((x) => x[0] === 'A');
  assert.deepEqual(arcs.map((a) => a[1]), [f - 0.5, r + 0.5, r + 0.5, f - 0.5], 'concentric with the stroke\'s arcs');
});

test('a box too small to draw draws nothing; a narrow one clamps its corners', () => {
  assert.equal(tabPaths(0, 0, 12, 8), null);
  assert.equal(tabPaths(17, 31, 12, 8), null);
  const narrow = cmds(tabPaths(30, 31, 12, 8)!.edge).filter((x) => x[0] === 'A');
  assert.ok((narrow[1]?.[1] ?? Infinity) <= (30 - 16 - 1) / 2, 'the top corners never overlap');
});
