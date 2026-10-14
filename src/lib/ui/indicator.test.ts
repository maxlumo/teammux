// The sliding indicator's geometry is pure: an active box → four CSS variables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indicatorVars, boxFromOffsets, DEFAULT_ACTIVE } from './indicator.ts';

test('indicatorVars maps the active child’s offset box to the atom’s variables', () => {
  assert.deepEqual(indicatorVars({ offsetLeft: 96, offsetTop: 4, offsetWidth: 72, offsetHeight: 28 }), {
    '--ind-x': '96px', '--ind-y': '4px', '--ind-w': '72px', '--ind-h': '28px',
  });
});

test('no active child collapses the indicator instead of leaving it stranded', () => {
  assert.deepEqual(indicatorVars(null), { '--ind-x': '0px', '--ind-y': '0px', '--ind-w': '0px', '--ind-h': '0px' });
});

test('the default active selector covers the app’s selected-state spellings', () => {
  for (const s of ['[aria-current]', '.active', '.on', '.sel', '[aria-selected="true"]']) assert.ok(DEFAULT_ACTIVE.includes(s), s);
});

test('boxFromOffsets walks offsetParent from both ends, so a nested item and a transformed one measure the same', () => {
  const root = { offsetLeft: 0, offsetTop: 0, offsetWidth: 400, offsetHeight: 800, offsetParent: null };
  const nav = { offsetLeft: 0, offsetTop: 100, offsetWidth: 46, offsetHeight: 600, offsetParent: root };
  // The rail button sits inside a .rail-slot wrapper (its offsetParent when the slot is positioned).
  const slot = { offsetLeft: 6, offsetTop: 52, offsetWidth: 34, offsetHeight: 32, offsetParent: nav };
  const btn = { offsetLeft: 0, offsetTop: 0, offsetWidth: 34, offsetHeight: 32, offsetParent: slot };
  assert.deepEqual(boxFromOffsets(btn, nav), { offsetLeft: 6, offsetTop: 52, offsetWidth: 34, offsetHeight: 32 });
  // A direct child of a bordered container (the tab bar's 1px top border): the
  // absolute pill's origin is the padding box, so the border comes off.
  const bar = { offsetLeft: 0, offsetTop: 700, offsetWidth: 400, offsetHeight: 56, offsetParent: root };
  const tab = { offsetLeft: 80, offsetTop: 1, offsetWidth: 80, offsetHeight: 55, offsetParent: bar };
  assert.deepEqual(boxFromOffsets(tab, bar, { left: 0, top: 1 }), { offsetLeft: 80, offsetTop: 0, offsetWidth: 80, offsetHeight: 55 });
  // Offsets are layout: a press scale or a mid-flip transform on the item does
  // not enter the answer (a client rect would have shrunk or lagged).
});

// The action itself (board #345). jsdom has no layout, so the container, its
// rows and the observer are fakes the test drives by hand: what is pinned is
// WHAT the action watches, WHEN it measures (one frame per burst) and what the
// pill is told — the pixels are the real browser's (the measurement on #345:
// a row grown from 51px to 87px by four agent chips, the wash stayed 51px).
import { slideIndicator } from './indicator.ts';

type Box = { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number };
function sidebar(rows = 3, active = 1) {
  const cls = (...c: string[]) => ({ contains: (n: string) => c.includes(n) });
  const node: any = { clientLeft: 0, clientTop: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 240, offsetHeight: 700, offsetParent: null, style: { vars: new Map<string, string>(), setProperty(k: string, v: string) { this.vars.set(k, v); } } };
  const pill: any = { classList: { ...cls('slide-pill'), add() {} } };
  const head: any = { classList: cls('side-head') };
  const list: any[] = Array.from({ length: rows }, (_, i) => ({ classList: cls('proj-row'), offsetParent: node, offsetLeft: 0, offsetTop: 40 + i * 52, offsetWidth: 232, offsetHeight: 51 }));
  node.children = [pill, head, ...list];
  node.querySelector = (sel: string) => (sel === ':scope > .slide-pill' ? pill : sel === '.proj-row.open' ? list[active] ?? null : null);
  const vars = () => ({ y: node.style.vars.get('--ind-y'), h: node.style.vars.get('--ind-h') });
  return { node, pill, head, list, vars };
}
function observers() {
  const observed = new Set<unknown>();
  const callbacks: (() => void)[] = [];
  let disconnects = 0;
  const frames = new Map<number, () => void>();
  let next = 1;
  const g = globalThis as any;
  const saved = { ResizeObserver: g.ResizeObserver, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };
  g.ResizeObserver = class { constructor(fn: () => void) { callbacks.push(fn); } observe(e: unknown) { observed.add(e); } unobserve(e: unknown) { observed.delete(e); } disconnect() { observed.clear(); disconnects++; } };
  g.requestAnimationFrame = (fn: () => void) => { frames.set(next, fn); return next++; };
  g.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  // Every frame that is pending, and the ones those schedule (the first placement queues the pill's `ready` frame).
  const flush = () => { for (let i = 0; i < 4 && frames.size; i++) { const run = [...frames.values()]; frames.clear(); run.forEach((fn) => fn()); } };
  return { observed, callbacks, frames, flush, disconnects: () => disconnects, restore: () => Object.assign(g, saved) };
}

test('slideIndicator: the wash follows the active row when ITS height changes, though the scroll container never resizes (board #345)', () => {
  const o = observers();
  try {
    const s = sidebar();
    const action = slideIndicator(s.node, { key: 'a', active: '.proj-row.open' });
    o.flush();
    assert.deepEqual(s.vars(), { y: '92px', h: '51px' }, 'placed on the active row');
    assert.ok(o.observed.has(s.list[1]), 'the active row is watched, not only the container');
    // Two lines of agent chips: the row grows. Its container is a scroll area, so its own box does not move.
    s.list[1].offsetHeight = 87;
    o.callbacks[0]!();
    o.flush();
    assert.deepEqual(s.vars(), { y: '92px', h: '87px' }, 'the wash is as tall as the row now');
    s.list[1].offsetHeight = 51; // the agents leave again
    o.callbacks[0]!(); o.flush();
    assert.equal(s.vars().h, '51px', 'and shrinks with it');
    action.destroy();
  } finally { o.restore(); }
});

test('slideIndicator: a row ABOVE the active one growing moves the wash down with it', () => {
  const o = observers();
  try {
    const s = sidebar();
    const action = slideIndicator(s.node, { key: 'a', active: '.proj-row.open' });
    o.flush();
    for (const r of s.list) assert.ok(o.observed.has(r), 'every row is watched: a sibling that grows moves the active one');
    assert.ok(!o.observed.has(s.pill), 'the pill is our output, never an input');
    s.list[0].offsetHeight = 87; s.list[1].offsetTop += 36; s.list[2].offsetTop += 36;
    o.callbacks[0]!(); o.flush();
    assert.deepEqual(s.vars(), { y: '128px', h: '51px' });
    action.destroy();
  } finally { o.restore(); }
});

test('slideIndicator: a burst of observer calls is ONE frame; selecting another row re-points the watch', () => {
  const o = observers();
  try {
    const s = sidebar(3, 0);
    const action = slideIndicator(s.node, { key: 'a', active: '.proj-row.open' });
    o.flush();
    const writes: string[] = [];
    const set = s.node.style.setProperty.bind(s.node.style);
    s.node.style.setProperty = (k: string, v: string) => { writes.push(k); set(k, v); };
    o.callbacks[0]!(); o.callbacks[0]!(); o.callbacks[0]!();
    assert.equal(o.frames.size, 1, 'one frame however many rows moved');
    assert.equal(writes.length, 0, 'nothing measured before the frame');
    o.flush();
    assert.equal(writes.length, 4, 'and the frame writes the four variables once');
    // Another row becomes the open one.
    s.node.querySelector = (sel: string) => (sel === ':scope > .slide-pill' ? s.pill : s.list[2]);
    action.update({ key: 'b', active: '.proj-row.open' });
    o.flush();
    assert.equal(s.vars().y, String(40 + 2 * 52) + 'px');
    assert.ok(o.observed.has(s.list[2]) && o.observed.has(s.node), 'still watching the new active row and the container');
    action.destroy();
    assert.equal(o.disconnects(), 1, 'the observer is released with the node');
  } finally { o.restore(); }
});

test('slideIndicator: hidden watches only the container; showing again watches the rows', () => {
  const o = observers();
  try {
    const s = sidebar();
    const action = slideIndicator(s.node, { key: 'a', active: '.proj-row.open', hidden: true });
    o.flush();
    assert.deepEqual([...o.observed], [s.node], 'nothing to follow while the indicator is collapsed');
    action.update({ key: 'b', active: '.proj-row.open', hidden: false });
    o.flush();
    assert.ok(o.observed.has(s.list[1]), 'the active row is watched again');
    assert.ok(o.observed.has(s.node), 'and the container still is');
    action.update({ key: 'c', active: '.proj-row.open', hidden: true });
    o.flush();
    assert.deepEqual([...o.observed], [s.node], 'collapsed again: the rows are let go');
    action.destroy();
  } finally { o.restore(); }
});

test('slideIndicator: an active item NESTED in a wrapper (the rail\u2019s slot) is watched itself, not only its slot', () => {
  const o = observers();
  try {
    const cls = (...c: string[]) => ({ contains: (n: string) => c.includes(n) });
    const node: any = { clientLeft: 0, clientTop: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 46, offsetHeight: 600, offsetParent: null, style: { setProperty() {} } };
    const pill: any = { classList: { ...cls('slide-pill'), add() {} } };
    const slot: any = { classList: cls('rail-slot'), offsetParent: node, offsetLeft: 6, offsetTop: 10, offsetWidth: 34, offsetHeight: 32 };
    const btn: any = { classList: cls('rail-btn', 'active'), offsetParent: slot, offsetLeft: 0, offsetTop: 0, offsetWidth: 34, offsetHeight: 32 };
    node.children = [pill, slot];
    node.querySelector = (sel: string) => (sel === ':scope > .slide-pill' ? pill : btn);
    const action = slideIndicator(node, { key: 'a', active: '.rail-btn.active' });
    o.flush();
    assert.ok(o.observed.has(btn), 'the item itself');
    assert.ok(o.observed.has(slot), 'and its slot');
    action.destroy();
  } finally { o.restore(); }
});
