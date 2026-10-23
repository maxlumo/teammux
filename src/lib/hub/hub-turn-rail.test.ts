import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnRail } from './hub-turn-rail.ts';
import type { Landing, Rect } from './hub-turn-rail.ts';

const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ key: `k${from + i}` }));

/** A host with a 300px band at y 100..400 and ten turns, and a log of what it was asked to do. */
function rig(count = 10) {
  const h = {
    turns: keys(count) as { key: string }[],
    current: '',
    live: true,
    band: { left: 0, top: 100, right: 44, bottom: 400 } as Rect | null,
    landing: 'moved' as Landing,
    jumps: [] as string[],
    captured: [] as number[],
    released: [] as number[],
    changes: 0,
  };
  const rail = createTurnRail({
    turns: () => h.turns,
    current: () => h.current,
    live: () => h.live,
    band: () => h.band,
    reach: () => 88,
    jump: (k) => { h.jumps.push(k); return h.landing; },
    capture: (id) => h.captured.push(id),
    release: (id) => h.released.push(id),
  }, () => { h.changes++; });
  /** The y that lands in turn i's slice (the band is 300px for ten turns). */
  const yOf = (i: number) => 100 + (i + 0.5) * 30;
  const mouse = (y: number, x = 20) => ({ id: 1, type: 'mouse', x, y });
  const touch = (y: number, x = 20, id = 7) => ({ id, type: 'touch', x, y });
  return { h, rail, yOf, mouse, touch };
}

test('hovering names the turn under the pointer and follows it; leaving closes; nothing jumps', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerMove(mouse(yOf(3)));
  assert.deepEqual(rail.view(), { open: true, key: 'k3', kind: 'hover' });
  rail.pointerMove(mouse(yOf(7)));
  assert.equal(rail.view().key, 'k7');
  rail.leave();
  assert.equal(rail.view().open, false);
  assert.deepEqual(h.jumps, []);
});

test('a touch has no hover; a pen does', () => {
  const { rail, yOf, touch } = rig();
  rail.pointerMove(touch(yOf(3)));
  assert.equal(rail.view().open, false);
  rail.pointerMove({ id: 2, type: 'pen', x: 20, y: yOf(3) });
  assert.equal(rail.view().key, 'k3');
});

test('a mouse click (down, up) jumps once to the turn it pressed on', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerMove(mouse(yOf(4)));
  rail.pointerDown({ ...mouse(yOf(4)), button: 0 });
  assert.equal(rail.view().kind, 'press');
  assert.deepEqual(h.captured, [1]);
  assert.equal(rail.pointerUp(mouse(yOf(4))), 'moved');
  assert.deepEqual(h.jumps, ['k4']);
  assert.deepEqual(h.released, [1]);
  assert.equal(rail.view().open, false);
  assert.equal(rail.pointerUp(mouse(yOf(4))), null, 'a second release finds nothing');
  assert.deepEqual(h.jumps, ['k4']);
});

test('a secondary button does not start a press', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerDown({ ...mouse(yOf(2)), button: 2 });
  assert.equal(rail.view().open, false);
  assert.deepEqual(h.captured, []);
});

test('touch: press, scrub, release jumps to the turn under the finger at release', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(1)));
  assert.equal(rail.view().key, 'k1');
  rail.pointerMove(touch(yOf(5)));
  assert.equal(rail.view().key, 'k5');
  rail.pointerMove(touch(yOf(8)));
  rail.pointerUp(touch(yOf(8)));
  assert.deepEqual(h.jumps, ['k8']);
});

test('a short tap jumps to the tick under it', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(6)));
  rail.pointerUp(touch(yOf(6)));
  assert.deepEqual(h.jumps, ['k6']);
});

test('sliding away from the band slows the scrub (fine adjust) and keeps the position', () => {
  const { h, rail, yOf, touch } = rig(1000);
  rail.pointerDown(touch(250));                         // slice 500 of 1000 on a 300px band
  assert.equal(rail.view().key, 'k500');
  rail.pointerMove(touch(250, 44 + 88));                // slide to the far end: no movement yet
  assert.equal(rail.view().key, 'k500');
  rail.pointerMove(touch(251, 44 + 88));                // one pixel at the far end: at most one turn
  assert.ok(Math.abs(Number(rail.view().key.slice(1)) - 500) <= 1);
  rail.pointerMove(touch(251, 20));                     // slide back: no jump of the probe
  assert.ok(Math.abs(Number(rail.view().key.slice(1)) - 500) <= 1);
  rail.pointerUp(touch(251, 20));
  assert.equal(h.jumps.length, 1);
  void yOf;
});

test('pointercancel never jumps and its release is not ours', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.pointerCancel(7);
  assert.equal(rail.view().open, false);
  assert.equal(rail.pointerUp(touch(yOf(3))), null);
  assert.deepEqual(h.jumps, []);
});

test('lost capture before our own release cancels, and that release does not jump', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.lostCapture(7);
  rail.pointerMove(touch(yOf(5)));
  assert.equal(rail.view().open, false, 'the pointer is still down but the transaction is over');
  assert.equal(rail.pointerUp(touch(yOf(5))), null);
  assert.deepEqual(h.jumps, []);
});

test('our own release before the lost capture it causes: one jump, the lost capture is a no-op', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.pointerUp(touch(yOf(3)));
  rail.lostCapture(7);
  assert.deepEqual(h.jumps, ['k3']);
});

test('a second finger can neither start, steer nor commit the first', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(2), 20, 7));
  rail.pointerDown(touch(yOf(9), 20, 8));
  assert.deepEqual(h.captured, [7]);
  rail.pointerMove(touch(yOf(9), 20, 8));
  assert.equal(rail.view().key, 'k2');
  assert.equal(rail.pointerUp(touch(yOf(9), 20, 8)), null);
  assert.equal(rail.view().kind, 'press', 'the first finger still holds the transaction');
  rail.pointerUp(touch(yOf(2), 20, 7));
  assert.deepEqual(h.jumps, ['k2']);
});

test('a jump that finds its target gone reports missing and leaves nothing open', () => {
  const { h, rail, yOf, touch } = rig();
  h.landing = 'missing';
  rail.pointerDown(touch(yOf(3)));
  assert.equal(rail.pointerUp(touch(yOf(3))), 'missing');
  assert.equal(rail.view().open, false);
});

// -- retirement: the reading context changed under an intent ------------------

test('retire() during a held press: the release and every later event do nothing', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.retire();
  assert.equal(rail.view().open, false);
  rail.pointerMove(touch(yOf(5)));
  assert.equal(rail.pointerUp(touch(yOf(5))), null);
  assert.deepEqual(h.jumps, []);
});

test('retire() with a hover open: a click on its row commits nothing', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerMove(mouse(yOf(4)));
  rail.retire();
  assert.equal(rail.rowClick('k4'), null);
  assert.deepEqual(h.jumps, []);
});

test('retire() with a key preview open: Enter opens a fresh preview and does not jump', () => {
  const { h, rail } = rig();
  h.current = 'k2';
  rail.focus();
  assert.equal(rail.view().key, 'k2');
  rail.retire();
  assert.equal(rail.view().open, false);
  assert.equal(rail.key('Enter'), true);
  assert.deepEqual(h.jumps, []);
  assert.equal(rail.view().key, 'k2', 'a fresh preview at the current turn, not the old target');
});

test('a round trip A to B to A inside one flush (equal keys, several retires) still kills the old intent', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  const a = h.turns;
  h.turns = keys(4, 100); rail.retire();       // room B ...
  h.turns = a; rail.retire();                  // ... and back to A, same keys
  assert.equal(rail.pointerUp(touch(yOf(3))), null);
  assert.deepEqual(h.jumps, []);
});

test('an agent-only update (a new array, the same keys) retires nothing', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  h.turns = keys(10);
  rail.pointerMove(touch(yOf(4)));
  assert.equal(rail.view().key, 'k4');
  rail.pointerUp(touch(yOf(4)));
  assert.deepEqual(h.jumps, ['k4']);
});

test('a prepend, an append or a removal under a held press cancels it without retire() being called', () => {
  for (const change of [
    (h: ReturnType<typeof rig>['h']) => { h.turns = [{ key: 'k-1' }, ...h.turns]; },
    (h: ReturnType<typeof rig>['h']) => { h.turns = [...h.turns, { key: 'k10' }]; },
    (h: ReturnType<typeof rig>['h']) => { h.turns = h.turns.filter((t) => t.key !== 'k3'); },
  ]) {
    const { h, rail, yOf, touch } = rig();
    rail.pointerDown(touch(yOf(3)));
    change(h);
    rail.pointerMove(touch(yOf(4)));
    assert.equal(rail.view().open, false);
    assert.equal(rail.pointerUp(touch(yOf(4))), null);
    assert.deepEqual(h.jumps, []);
  }
});

test('losing the host gate mid-press, or the band moving, cancels it', () => {
  {
    const { h, rail, yOf, touch } = rig();
    rail.pointerDown(touch(yOf(3)));
    h.live = false;
    assert.equal(rail.pointerUp(touch(yOf(3))), null);
    assert.deepEqual(h.jumps, []);
  }
  {
    const { h, rail, yOf, touch } = rig();
    rail.pointerDown(touch(yOf(3)));
    h.band = { left: 0, top: 130, right: 44, bottom: 430 };       // a resize / keyboard / uiZoom
    assert.equal(rail.pointerUp(touch(yOf(3))), null);
    assert.deepEqual(h.jumps, []);
  }
  {
    const { h, rail, yOf, touch } = rig();
    rail.pointerDown(touch(yOf(3)));
    h.band = { left: 0, top: 100.4, right: 44, bottom: 400.4 };   // sub-pixel noise is not a change
    rail.pointerUp(touch(yOf(3)));
    assert.deepEqual(h.jumps, ['k3']);
  }
});

test('destroy during a press: nothing jumps afterwards', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.dispose();
  assert.equal(rail.pointerUp(touch(yOf(3))), null);
  assert.deepEqual(h.jumps, []);
  assert.deepEqual(h.released, [7]);
});

test('Escape cancels a held press; the pointer is still down, so its events stay dead until it lifts', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerDown({ ...mouse(yOf(3)), button: 0 });
  assert.equal(rail.key('Escape'), true);
  rail.pointerMove(mouse(yOf(6)));
  assert.equal(rail.view().open, false, 'no hover reopens under a dead pointer');
  assert.equal(rail.pointerUp(mouse(yOf(6))), null);
  rail.pointerMove(mouse(yOf(6)));
  assert.equal(rail.view().key, 'k6', 'after its release the mouse hovers again');
  assert.deepEqual(h.jumps, []);
});

test('a pointer id that is pressed again clears what the id left behind', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerDown({ ...mouse(yOf(3)), button: 0 });
  rail.lostCapture(1);                                           // dead, and its release never arrives
  rail.pointerDown({ ...mouse(yOf(5)), button: 0 });
  rail.pointerUp(mouse(yOf(5)));
  assert.deepEqual(h.jumps, ['k5']);
});

// -- keyboard and the popover -------------------------------------------------

test('keyboard: focus previews the current turn, arrows step, Enter commits the preview once', () => {
  const { h, rail } = rig();
  h.current = 'k5';
  rail.focus();
  assert.deepEqual(rail.view(), { open: true, key: 'k5', kind: 'key' });
  assert.equal(rail.key('ArrowUp'), true);
  assert.equal(rail.view().key, 'k4');
  rail.key('ArrowDown'); rail.key('ArrowDown');
  assert.equal(rail.view().key, 'k6');
  assert.equal(h.jumps.length, 0, 'previewing never moves the feed');
  rail.key('Enter');
  assert.deepEqual(h.jumps, ['k6']);
  assert.equal(rail.view().open, false);
  rail.key('Enter', true);
  rail.key('Enter', true);
  assert.deepEqual(h.jumps, ['k6'], 'a repeating Enter does not jump again');
  assert.equal(rail.view().open, false, 'nor does it open a fresh preview that the next repeat would commit');
});

test('keyboard: Home/End, the ends hold, Space commits, no current turn starts at the newest', () => {
  const { h, rail } = rig();
  rail.key('End');
  assert.equal(rail.view().key, 'k9');
  rail.key('ArrowDown');
  assert.equal(rail.view().key, 'k9');
  rail.key('Home');
  assert.equal(rail.view().key, 'k0');
  rail.key('ArrowUp');
  assert.equal(rail.view().key, 'k0');
  rail.key(' ');
  assert.deepEqual(h.jumps, ['k0']);
  rail.key('ArrowUp');
  assert.equal(rail.view().key, 'k9', 'with nothing to start from the first press lands on the newest');
});

test('keyboard: Escape closes (and says it handled the key), then Enter does not reach the old target', () => {
  const { h, rail } = rig();
  h.current = 'k2';
  rail.focus();
  rail.key('ArrowDown');
  assert.equal(rail.key('Escape'), true);
  assert.equal(rail.view().open, false);
  assert.equal(rail.key('Escape'), false, 'nothing open: Escape is not ours');
  rail.key('Enter');
  assert.deepEqual(h.jumps, []);
  assert.equal(rail.view().key, 'k2');
});

test('keys that are not the rail\'s are left alone (Tab leaves)', () => {
  const { rail } = rig();
  assert.equal(rail.key('Tab'), false);
  assert.equal(rail.key('a'), false);
  assert.equal(rail.key('PageDown'), false);
});

test('a key preview survives the mouse leaving; the mouse takes ownership when it moves in', () => {
  const { h, rail, yOf, mouse } = rig();
  h.current = 'k2';
  rail.focus();
  rail.leave();
  assert.equal(rail.view().kind, 'key');
  rail.pointerMove(mouse(yOf(7)));
  assert.deepEqual(rail.view(), { open: true, key: 'k7', kind: 'hover' });
  rail.leave();
  assert.equal(rail.view().open, false);
});

test('blur closes a key preview; an outside press closes any preview but a held press', () => {
  const { h, rail, yOf, mouse, touch } = rig();
  h.current = 'k2';
  rail.focus();
  rail.blur();
  assert.equal(rail.view().open, false);
  rail.pointerMove(mouse(yOf(3)));
  rail.blur();
  assert.equal(rail.view().kind, 'hover', 'blur is the keyboard\'s');
  rail.outsidePress();
  assert.equal(rail.view().open, false);
  rail.pointerDown(touch(yOf(3)));
  rail.outsidePress();
  assert.equal(rail.view().kind, 'press');
});

test('a popover row jumps to its own turn, the probed one or a neighbour, and only once', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerMove(mouse(yOf(4)));
  assert.equal(rail.rowClick('k5'), 'moved');
  assert.deepEqual(h.jumps, ['k5']);
  assert.equal(rail.rowClick('k5'), null);
  assert.deepEqual(h.jumps, ['k5']);
  rail.pointerMove(mouse(yOf(4)));
  assert.equal(rail.rowClick('k8'), null, 'a turn that is not one of the listed rows');
  assert.deepEqual(h.jumps, ['k5']);
  assert.equal(rail.view().open, false);
});

test('a touch release then its compat click: only the release commits', () => {
  const { h, rail, yOf, touch } = rig();
  rail.pointerDown(touch(yOf(3)));
  rail.pointerUp(touch(yOf(3)));
  assert.equal(rail.rowClick('k3'), null, 'no intent is left for a click to find');
  assert.deepEqual(h.jumps, ['k3']);
});

test('every handler is inert while the gate is closed', () => {
  const { h, rail, yOf, mouse, touch } = rig();
  h.live = false;
  rail.pointerMove(mouse(yOf(3)));
  rail.pointerDown(touch(yOf(3)));
  rail.focus();
  assert.equal(rail.view().open, false);
  assert.deepEqual(h.captured, []);
  assert.equal(rail.key('Enter'), true, 'the key is still the rail\'s, so the feed does not scroll');
  assert.deepEqual(h.jumps, []);
});

test('a real 500-turn feed through pointer events only: every far turn is reachable by a touch path', () => {
  const { h, rail, touch } = rig(500);
  // press at the coarse slice, slide right to the far end, then step one pixel at a time
  rail.pointerDown(touch(100 + 300 * (300 / 500)));
  const start = Number(rail.view().key.slice(1));
  assert.ok(Math.abs(start - 300) <= 2);
  rail.pointerMove(touch(100 + 300 * (300 / 500), 44 + 88));
  let y = 100 + 300 * (300 / 500);
  const target = start + 1;
  let guard = 0;
  while (Number(rail.view().key.slice(1)) < target && guard++ < 50) { y += 1; rail.pointerMove(touch(y, 44 + 88)); }
  assert.equal(Number(rail.view().key.slice(1)), target);
  rail.pointerUp(touch(y, 44 + 88));
  assert.deepEqual(h.jumps, [`k${target}`]);
});

test('a release that finds the ground moved ends the press cleanly: the same mouse hovers again at once', () => {
  const { h, rail, yOf, mouse } = rig();
  rail.pointerDown({ ...mouse(yOf(3)), button: 0 });
  h.turns = [{ key: 'k-1' }, ...h.turns];                          // a prepend under the held mouse
  assert.equal(rail.pointerUp(mouse(yOf(3))), null);
  assert.deepEqual(h.jumps, []);
  rail.pointerMove(mouse(yOf(5)));
  assert.equal(rail.view().kind, 'hover', 'its release was seen, so nothing of it stays dead');
});

test('a jump that re-enters the rail while it moves the feed still jumps once', () => {
  const { h, rail, yOf, touch } = rig();
  const again: Array<() => unknown> = [];
  const original = h.jumps.push.bind(h.jumps);
  h.jumps.push = (...keys: string[]) => { for (const run of again) run(); return original(...keys); };
  again.push(() => rail.pointerUp(touch(yOf(3))), () => rail.rowClick('k3'), () => rail.key('Enter'));
  rail.pointerDown(touch(yOf(3)));
  rail.pointerUp(touch(yOf(3)));
  assert.deepEqual([...h.jumps], ['k3'], 'every intent was gone before the host moved, so nothing re-entered can commit');
});
