// The window's drain scheduler (board #335 ③b; reviewer P1-3 on 9c1f757c,
// evidence P2 on 1125b5f4). The App harness could not order the third
// phase — the shell ends, THEN a release lands late, THEN the timers run —
// because its fake layer's clearTimeout always followed the late schedule.
// Here the order is explicit on the real scheduler (the one App uses), with
// node's mock timers, and every phase records what ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowDrain } from './window-drain.ts';

/** A drain that records when it runs, and a scheduler over it. */
const harness = () => {
  const ran: string[] = [];
  let n = 0;
  const drain = createWindowDrain(() => { ran.push(`drain#${++n}`); });
  return { ran, drain };
};

test('a schedule runs the drain once, on its own turn, however many asked while it was pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ran, drain } = harness();
  drain.schedule();
  drain.schedule();
  drain.schedule();
  assert.deepEqual(ran, [], 'not synchronously: the caller whose end freed the window finishes its own continuation first');
  t.mock.timers.runAll();
  assert.deepEqual(ran, ['drain#1'], 'one timer, whoever asked');
  drain.schedule();
  t.mock.timers.runAll();
  assert.deepEqual(ran, ['drain#1', 'drain#2'], 'and the next ask after it ran is a new turn');
});

test('a lease holds the window and its release schedules the drain once; a second release of the same lease is nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ran, drain } = harness();
  const releaseA = drain.lease();
  const releaseB = drain.lease();
  assert.equal(drain.leases, 2);
  releaseA();
  assert.equal(drain.leases, 1);
  releaseA();
  assert.equal(drain.leases, 1, 'idempotent: an activation s finally and its explicit done release once');
  t.mock.timers.runAll();
  assert.deepEqual(ran, ['drain#1'], 'the release scheduled the drain (which finds the window still held by B and decides for itself)');
  releaseB();
  assert.equal(drain.leases, 0);
  t.mock.timers.runAll();
  assert.deepEqual(ran, ['drain#1', 'drain#2']);
});

test('third phase, in order: end → a release lands late → the timers run: the drain runs ZERO times and nothing is scheduled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ran, drain } = harness();
  const log: string[] = [];
  const release = drain.lease();           // an activation in flight when the shell ends
  // Phase 1: the shell ends FIRST.
  drain.end();
  log.push('ended');
  assert.equal(drain.ended, true);
  // Phase 2: the activation's finally releases its lease AFTER the end
  // (its dial was rejected by the teardown's dispose; the continuation
  // runs on a later microtask).
  release();
  log.push('late release');
  assert.equal(drain.leases, 0, 'the count is kept honest even after the end');
  // Phase 3: the timers run.
  t.mock.timers.runAll();
  log.push('timers ran');
  assert.deepEqual(log, ['ended', 'late release', 'timers ran'], 'the order this test is about');
  assert.deepEqual(ran, [], 'zero drains: nothing owed is settled, asked or minted after the end');
  // And a direct ask after the end is refused the same way.
  drain.schedule();
  t.mock.timers.runAll();
  assert.deepEqual(ran, []);
});

test('a drain already pending when the shell ends is cleared: it does not run on the next tick', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ran, drain } = harness();
  drain.schedule();                         // a walk ended just before the teardown
  drain.end();
  t.mock.timers.runAll();
  assert.deepEqual(ran, [], 'the pending timer was cleared by the end, not left to fire into a destroyed root');
  drain.end();                              // idempotent
  assert.equal(drain.ended, true);
});

test('the drain is guarded at its own turn too: an end between the schedule and the timer firing stops it even if the timer is not cleared', (t) => {
  // Belt and braces for a host whose clearTimeout is a no-op (the fake layer
  // the App harness runs on): the timer callback checks `ended` itself.
  const timers: Array<() => void> = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  const { ran, drain } = harness();
  drain.schedule();
  drain.end();
  for (const fn of timers.splice(0)) fn();
  assert.deepEqual(ran, [], 'the uncleared timer fired and the drain still did not run');
});
