import assert from 'node:assert/strict';
import test from 'node:test';
import { createRailVisibility, cssMilliseconds, railVisible } from './hub-turn-visibility.ts';

const DWELL = 1500;

/** A fake clock and a fake timer wheel: nothing here waits. */
function rig(dwell = DWELL) {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const log: boolean[] = [];
  const vis = createRailVisibility({
    dwell: () => dwell,
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    onChange: (shown) => log.push(shown),
  });
  const advance = (ms: number) => {
    const to = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = to;
  };
  return { vis, advance, log, timers, at: () => clock };
}

test('the rule: shown while active, and for one dwell after the last activity; never active is not shown', () => {
  assert.equal(railVisible({ active: false, lastActive: null }, 0, DWELL), false, 'a clock that starts at 0 does not light it');
  assert.equal(railVisible({ active: false, lastActive: null }, 99999, DWELL), false);
  assert.equal(railVisible({ active: true, lastActive: null }, 5, DWELL), true);
  assert.equal(railVisible({ active: false, lastActive: 1000 }, 1000, DWELL), true);
  assert.equal(railVisible({ active: false, lastActive: 1000 }, 2499, DWELL), true);
  assert.equal(railVisible({ active: false, lastActive: 1000 }, 2500, DWELL), false, 'exactly one dwell later it is hidden');
  assert.equal(railVisible({ active: true, lastActive: 0 }, 99999, DWELL), true, 'a hold outlasts any dwell');
});

test('CSS times parse to milliseconds, and anything else is NaN', () => {
  assert.equal(cssMilliseconds('1500ms'), 1500);
  assert.equal(cssMilliseconds(' 1.5s '), 1500);
  assert.equal(cssMilliseconds('200ms'), 200);
  assert.ok(Number.isNaN(cssMilliseconds('')));
  assert.ok(Number.isNaN(cssMilliseconds('soon')));
  assert.ok(Number.isNaN(cssMilliseconds('12px')));
});

test('nothing is shown until something happens, even when the clock is at 0', () => {
  const { vis, log } = rig();
  assert.equal(vis.shown, false);
  assert.deepEqual(log, []);
  vis.reset();                         // an entry that evaluates with no activity at all, on a clock that reads 0
  vis.clear();
  assert.equal(vis.shown, false, 'reset and clear leave never-active as null, not 0: 0 - 0 is inside every dwell');
  assert.deepEqual(log, []);
});

test('a scroll shows it at once and the dwell hides it, counted from the LAST scroll', () => {
  const { vis, advance, log } = rig();
  vis.nudge();
  assert.equal(vis.shown, true);
  advance(1000);
  vis.nudge();                         // the dwell restarts, it does not run on from the first scroll
  advance(1499);
  assert.equal(vis.shown, true);
  advance(1);
  assert.equal(vis.shown, false);
  assert.deepEqual(log, [true, false], 'one show, one hide: no flicker in between');
});

test('a hold keeps it shown for as long as it lasts, then a FULL dwell runs from its end', () => {
  const { vis, advance, log } = rig();
  vis.nudge();
  vis.hold('probe', true);
  advance(60_000);
  assert.equal(vis.shown, true, 'a long gesture is not timed out');
  vis.hold('probe', false);
  advance(1499);
  assert.equal(vis.shown, true, 'the dwell starts when the hold ENDS, not when the activity began');
  advance(1);
  assert.equal(vis.shown, false);
  assert.deepEqual(log, [true, false]);
});

test('a hold that starts during the dwell cancels the pending hide: the class never leaves', () => {
  const { vis, advance, log, timers } = rig();
  vis.nudge();
  advance(1400);
  vis.hold('focus', true);
  assert.equal(timers.size, 0, 'the pending hide is gone');
  advance(10_000);
  assert.equal(vis.shown, true);
  assert.deepEqual(log, [true], 'never hidden, so never re-shown: no remount, no flicker');
});

test('several holds: shown until the LAST one ends, then one full dwell', () => {
  const { vis, advance } = rig();
  vis.hold('entered', true);
  vis.hold('probe', true);
  vis.hold('entered', false);
  advance(5000);
  assert.equal(vis.shown, true);
  vis.hold('probe', false);
  advance(1499);
  assert.equal(vis.shown, true);
  advance(1);
  assert.equal(vis.shown, false);
});

test('a pulse during a hold changes nothing; a pulse after it extends the dwell', () => {
  const { vis, advance } = rig();
  vis.hold('focus', true);
  vis.nudge();
  vis.hold('focus', false);
  advance(1000);
  vis.nudge();
  advance(1499);
  assert.equal(vis.shown, true);
  advance(1);
  assert.equal(vis.shown, false);
});

test('reset() drops the old pulse and timer; a live hold survives it', () => {
  const { vis, advance, timers } = rig();
  vis.nudge();
  vis.reset();
  assert.equal(vis.shown, false, 'the old reading\'s activity decides nothing for the new one');
  assert.equal(timers.size, 0);
  vis.hold('entered', true);
  vis.reset();
  assert.equal(vis.shown, true, 'the pointer is still in the column: that is a fact, not a pulse');
  vis.hold('entered', false);
  advance(1499);
  assert.equal(vis.shown, true);
  advance(1);
  assert.equal(vis.shown, false);
});

test('clear() is the host going away: no hold, no pulse, no timer', () => {
  const { vis, timers } = rig();
  vis.hold('focus', true);
  vis.nudge();
  vis.clear();
  assert.equal(vis.shown, false);
  assert.equal(timers.size, 0);
  vis.hold('focus', false);              // a late blur of the old state is harmless: there is no hold to end
  assert.equal(vis.shown, false, 'and it does not start a dwell');
});

test('dispose() leaves no timer, so an old room\'s timer cannot decide the new room\'s visibility', () => {
  const { vis, advance, timers, log } = rig();
  vis.nudge();
  vis.dispose();
  assert.equal(timers.size, 0);
  advance(60_000);
  assert.deepEqual(log, [true], 'nothing fired after dispose');
  assert.equal(vis.shown, false);
});

test('the same hold twice is one hold; ending one that is not on is ignored', () => {
  const { vis, advance } = rig();
  vis.hold('probe', true);
  vis.hold('probe', true);
  vis.hold('probe', false);
  advance(1499);
  assert.equal(vis.shown, true);
  vis.hold('probe', false);              // already off
  advance(1);
  assert.equal(vis.shown, false);
});

test('one dwell token: a changed value is read when the hide is scheduled, with no second idle timer', () => {
  let dwell = 1500;
  let clock = 0;
  const timers: number[] = [];
  const vis = createRailVisibility({
    dwell: () => dwell, now: () => clock, setTimer: (_fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {}, onChange: () => {},
  });
  vis.nudge();
  dwell = 2000;
  clock = 500;
  vis.nudge();
  assert.deepEqual(timers, [1500, 2000]);
});
