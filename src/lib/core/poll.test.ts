import test from 'node:test';
import assert from 'node:assert/strict';
import { poll, single } from './poll.ts';

// Board #444: ONE read of a kind in flight per context, owned by the read
// (#444 review P1-A), a queued read never runs for a context it was not asked
// for (P1-A residual), and every caller decides for itself what a failure means
// (P1-B).

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

/** A read whose answers the test releases. `room()` is what the task would
 * read as the current context when it starts. */
function held(room: () => string = () => '') {
  const answers: { room: string; answer: () => void; fail: () => void }[] = [];
  const task = () => new Promise<void>((resolve, reject) => answers.push({ room: room(), answer: resolve, fail: () => reject(new Error('read failed')) }));
  return { answers, task };
}

test('a tick while the read is pending is skipped, never queued', async () => {
  const { answers, task } = held();
  const load = single(task);
  load.tick(); load.tick(); load.tick();
  assert.equal(answers.length, 1, 'two ticks during a stall send nothing more');
  answers[0]!.answer(); await flush();
  assert.equal(answers.length, 1, 'and nothing was queued behind it');
  load.tick();
  assert.equal(answers.length, 2, 'the first tick after the answer reads again');
});

test('reads asked while one is pending share ONE follow-up after it: never dropped, never doubled', async () => {
  const { answers, task } = held();
  const load = single(task);
  const first = load();
  let a = false, b = false;
  const second = load().then(() => { a = true; });
  const third = load().then(() => { b = true; });
  assert.equal(answers.length, 1, 'never two reads of the context at once');
  answers[0]!.answer(); await first; await flush();
  assert.equal(answers.length, 2, 'the follow-up starts when the pending read settles');
  assert.equal(a || b, false, 'its callers wait for the follow-up, not the stale read');
  answers[1]!.answer(); await second; await third;
  assert.ok(a && b);
  await flush();
  assert.equal(answers.length, 2, 'not doubled');
});

test('a queued read whose room was left retires: it never reads the new room under the old key (P1-A residual)', async () => {
  let room = 'a';
  const { answers, task } = held(() => room);
  const load = single(task, () => room);
  load.tick();                             // A pending
  let queuedDone = false;
  void load().then(() => { queuedDone = true; }); // A's follow-up (a push)
  room = 'b';
  void load();                             // B's first read, at once
  assert.deepEqual(answers.map((x) => x.room), ['a', 'b']);
  answers[0]!.answer(); await flush();     // A answers
  assert.deepEqual(answers.map((x) => x.room), ['a', 'b'], 'A\'s follow-up did not read B beside B\'s own read');
  assert.ok(queuedDone, 'its caller resolves: the read was retired, not left hanging');
  load.tick();
  assert.equal(answers.length, 2, 'B still has exactly one read in flight');
  answers[1]!.answer(); await flush();
  load.tick();
  assert.deepEqual(answers.map((x) => x.room), ['a', 'b', 'b']);
});

test('A -> B -> A: back in A before A answers, A\'s follow-up reads A', async () => {
  let room = 'a';
  const { answers, task } = held(() => room);
  const load = single(task, () => room);
  load.tick();
  void load();
  room = 'b'; void load();
  room = 'a';
  answers[0]!.answer(); await flush();
  assert.deepEqual(answers.map((x) => x.room), ['a', 'b', 'a'], 'the queued read runs for the room it is filed under');
});

test('dispose: a queued read retires and nothing starts after the owner is gone', async () => {
  const { answers, task } = held();
  const load = single(task);
  load.tick();
  let done = false;
  void load().then(() => { done = true; });
  load.dispose();
  answers[0]!.answer(); await flush();
  assert.equal(answers.length, 1, 'no read after the tree went');
  assert.ok(done, 'the waiting caller resolves');
  load.tick(); await load();
  assert.equal(answers.length, 1);
});

test('a failure reaches exactly the callers that asked to see it, in either order (P1-B)', async () => {
  for (const order of ['report first', 'push first']) {
    const { answers, task } = held();
    const load = single(task);
    load.tick();                                         // pending
    const report = () => load({ report: true });
    const background = () => load();
    const [r, b] = order === 'report first' ? [report(), background()] : (() => { const x = background(); return [report(), x]; })();
    answers[0]!.answer(); await flush();                 // the pending read succeeds
    answers[1]!.fail(); await flush();                   // the shared follow-up fails
    await assert.rejects(r, /read failed/u, `${order}: the explicit refresh still sees its failure`);
    await b;                                             // and the push never rejects
  }
});

test('a tick never queues a follow-up, and a follow-up survives a failed read', async () => {
  const { answers, task } = held();
  const load = single(task);
  void load();
  load.tick();
  const after = load();
  answers[0]!.fail(); await flush();
  assert.equal(answers.length, 2, 'the needed read still runs after a failure');
  answers[1]!.answer(); await after;
  await flush();
  assert.equal(answers.length, 2);
});

test('the read outlives its timer: stop and start again does not reset it (hide -> show)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { answers, task } = held();
  const load = single(task);
  let stop = poll(load.tick, 5000);
  t.mock.timers.tick(5000);
  assert.equal(answers.length, 1);
  stop();                                      // hidden
  stop = poll(load.tick, 5000, { now: true }); // shown again
  t.mock.timers.tick(5000);
  assert.equal(answers.length, 1, 'the new timer finds the read still pending');
  answers[0]!.answer(); await flush();
  t.mock.timers.tick(5000);
  assert.equal(answers.length, 2);
  stop();
  answers[1]!.answer(); await flush();
  t.mock.timers.tick(20000);
  assert.equal(answers.length, 2, 'stopped: no more ticks');
});

test('a throwing task frees the context and reports only when asked', async () => {
  let calls = 0;
  const load = single(() => { calls++; throw new Error('sync'); });
  await assert.rejects(load({ report: true }), /sync/u);
  await load();
  load.tick(); await flush();
  assert.equal(calls, 3);
});
