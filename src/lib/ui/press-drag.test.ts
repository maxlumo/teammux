// The one press-to-drag mechanism (board #384): what its three users (the
// rail, the failover-address list, the roster) rely on, executed rather than
// matched in their source.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPressDrag } from './press-drag.ts';
import { RAIL_DRAG_THRESHOLD } from '../app/nav-order.ts';

type Drag = { id: string; dx: number; dy: number };

function harness(opts: { axis?: 'y' | 'xy'; touch?: boolean; refuse?: boolean; zoom?: number } = {}) {
  let live: Drag | null = null;
  const log: string[] = [];
  const captured: number[] = [];
  const drag = createPressDrag<{ id: string }, Drag>({
    get: () => live,
    set: (d) => { live = d; },
    begin: (press) => { log.push(`begin:${press.id}@${press.x},${press.y}`); return opts.refuse ? null : { id: press.id, dx: 0, dy: 0 }; },
    track: (d, _e, { dx, dy }) => { d.dx = dx; d.dy = dy; },
    commit: (d) => log.push(`commit:${d.id}:${d.dx},${d.dy}`),
    axis: opts.axis,
    touch: opts.touch,
    zoom: () => opts.zoom ?? 1,
  });
  const el = { setPointerCapture: (id: number) => captured.push(id) } as unknown as HTMLElement;
  const ev = (x: number, y: number, extra: Partial<PointerEvent> = {}) =>
    ({ button: 0, pointerType: 'mouse', pointerId: 7, clientX: x, clientY: y, currentTarget: el, ...extra }) as unknown as PointerEvent;
  return { drag, log, captured, ev, live: () => live };
}

test('a press becomes a drag only past the threshold, and its pointer is captured at once', () => {
  const h = harness();
  assert.equal(h.drag.down(h.ev(10, 10), { id: 'a' }), true);
  assert.deepEqual(h.captured, [7], 'captured on the press, before any travel');
  h.drag.move(h.ev(10, 10 + RAIL_DRAG_THRESHOLD - 1));
  assert.equal(h.live(), null, 'jitter below the threshold is still a click');
  h.drag.move(h.ev(10, 10 + RAIL_DRAG_THRESHOLD));
  assert.deepEqual(h.live(), { id: 'a', dx: 0, dy: RAIL_DRAG_THRESHOLD });
  h.drag.move(h.ev(13, 40));
  h.drag.up();
  assert.deepEqual(h.log, ['begin:a@10,10', 'commit:a:3,30']);
  assert.equal(h.live(), null);
});

test('the axis decides which travel counts: a vertical list ignores sideways travel, a 2D drop does not', () => {
  const y = harness();
  y.drag.down(y.ev(0, 0), { id: 'v' });
  y.drag.move(y.ev(40, 2));
  assert.equal(y.live(), null, 'axis y: sideways is not a drag');
  const xy = harness({ axis: 'xy' });
  xy.drag.down(xy.ev(0, 0), { id: 'p' });
  xy.drag.move(xy.ev(40, 2));
  assert.deepEqual(xy.live(), { id: 'p', dx: 40, dy: 2 });
});

test('only a primary press starts it, and touch only where the handle opts in', () => {
  const h = harness();
  assert.equal(h.drag.down(h.ev(0, 0, { button: 2 }), { id: 'r' }), false, 'not a secondary button');
  assert.equal(h.drag.down(h.ev(0, 0, { pointerType: 'touch' }), { id: 't' }), false, 'not a finger by default');
  h.drag.move(h.ev(0, 50));
  assert.equal(h.live(), null, 'and a refused press leaves nothing to drag');
  const t = harness({ touch: true });
  assert.equal(t.drag.down(t.ev(0, 0, { pointerType: 'touch' }), { id: 't' }), true, 'a grip that opts out of scrolling may');
});

test('a begin that declines leaves it a press', () => {
  const h = harness({ refuse: true });
  h.drag.down(h.ev(0, 0), { id: 'n' });
  h.drag.move(h.ev(0, 50));
  assert.equal(h.live(), null);
  h.drag.up();
  assert.equal(h.drag.consumeClick(), false, 'no drag, so the click is an ordinary click');
});

test('a drag, committed or abandoned, swallows the one click after it; a fresh press clears a stale guard', () => {
  const h = harness();
  h.drag.down(h.ev(0, 0), { id: 'a' });
  h.drag.move(h.ev(0, 50));
  h.drag.up();
  assert.equal(h.drag.consumeClick(), true, 'the click that follows a committed drag is swallowed');
  assert.equal(h.drag.consumeClick(), false, 'once');
  h.drag.down(h.ev(0, 0), { id: 'b' });
  h.drag.move(h.ev(0, 50));
  h.drag.cancel();
  assert.deepEqual(h.log.filter((l) => l.startsWith('commit')), ['commit:a:0,50'], 'an abandoned drag commits nothing');
  h.drag.down(h.ev(0, 0), { id: 'c' });
  assert.equal(h.drag.consumeClick(), false, 'the guard the abandoned drag armed is cleared by the next press, whose click is a click');
  h.drag.up();
  assert.equal(h.drag.consumeClick(), false, 'a plain click arms nothing');
});

test('while dragging, Escape and a resize abandon it and a window pointerup releases it; the listeners go with the drag', () => {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.get(type)?.delete(fn); },
  } as unknown as Window;
  const fire = (type: string, e: unknown = {}) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(e); };
  const start = (h: ReturnType<typeof harness>) => { h.drag.down(h.ev(0, 0), { id: 'a' }); h.drag.move(h.ev(0, 50)); };

  const esc = harness();
  start(esc);
  let off = esc.drag.listen(win);
  let prevented = false;
  fire('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(esc.live(), null);
  assert.ok(prevented, 'Escape is consumed by the drag');
  assert.deepEqual(esc.log.filter((l) => l.startsWith('commit')), []);
  off();
  assert.equal([...listeners.values()].reduce((n, s) => n + s.size, 0), 0, 'every listener removed');

  const resize = harness();
  start(resize);
  off = resize.drag.listen(win);
  fire('resize');
  assert.equal(resize.live(), null, 'the snapshotted rects are stale');
  off();

  const lost = harness();
  start(lost);
  off = lost.drag.listen(win);
  fire('pointerup');
  assert.deepEqual(lost.log.filter((l) => l.startsWith('commit')), ['commit:a:0,50'], 'the window pointerup releases a drag whose handle vanished');
  off();
});

test('the travel a carried element is translated by is in layout units: client px over the root zoom (reviewer P2-2)', () => {
  // At 150% a 30 px pointer travel is 20 CSS px of translate; the threshold
  // is still measured in client px, where the pointer is.
  const h = harness({ zoom: 1.5, axis: 'xy' });
  h.drag.down(h.ev(0, 0), { id: 'z' });
  h.drag.move(h.ev(RAIL_DRAG_THRESHOLD - 1, 0));
  assert.equal(h.live(), null, 'the threshold is in client px, unscaled');
  h.drag.move(h.ev(30, -15));
  assert.deepEqual(h.live(), { id: 'z', dx: 20, dy: -10 });
  // No zoom reading (0, NaN from an unset property) is 1, never a division by zero.
  const flat = harness({ zoom: 0 });
  flat.drag.down(flat.ev(0, 0), { id: 'f' });
  flat.drag.move(flat.ev(0, 30));
  assert.deepEqual(flat.live(), { id: 'f', dx: 0, dy: 30 });
});
