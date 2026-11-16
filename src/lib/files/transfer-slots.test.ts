// The one limit on file transfers in flight (board #134; owner 2026-11-16: '下载的时候，如果同时多个文件下载上传
// 之类的 控制并发数量 比如3 避免太多了异常。可以在设置里设定最大并发数量'). Pure: no DOM, no timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransferSlots, TransferWaitCancelled } from './transfer-slots.ts';

const tick = () => new Promise((r) => setImmediate(r));

test('up to the limit start at once; the rest wait in the order they asked', async () => {
  const slots = createTransferSlots(2);
  const started: string[] = [];
  const releases: (() => void)[] = [];
  for (const name of ['a', 'b', 'c', 'd']) void slots.acquire().then((release) => { started.push(name); releases.push(release); });
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(slots.running, 2);
  assert.equal(slots.waiting, 2);
  releases[0]!();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c'], 'a freed slot goes to the first in line');
  releases[1]!();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  assert.equal(slots.waiting, 0);
});

test('a release frees exactly one slot, however often it is called', async () => {
  const slots = createTransferSlots(1);
  const release = await slots.acquire();
  let second = false;
  void slots.acquire().then(() => { second = true; });
  release(); release(); release();
  await tick();
  assert.equal(second, true);
  assert.equal(slots.running, 1, 'the second holds the one slot; the repeated releases freed nothing more');
});

test('a transfer cancelled while it waits never starts and takes no slot', async () => {
  const slots = createTransferSlots(1);
  const first = await slots.acquire();
  const control = new AbortController();
  const waiting = slots.acquire(control.signal);
  let third = false;
  void slots.acquire().then(() => { third = true; });
  control.abort();
  await assert.rejects(waiting, TransferWaitCancelled);
  assert.equal(slots.waiting, 1, 'it left the line');
  first();
  await tick();
  assert.equal(third, true, 'the next in line got the slot');
  assert.equal(slots.running, 1);
});

test('a signal already aborted is refused at once, and its reason is kept', async () => {
  const slots = createTransferSlots(3);
  const control = new AbortController();
  control.abort('switch');
  const err = await slots.acquire(control.signal).catch((e: unknown) => e);
  assert.ok(err instanceof TransferWaitCancelled);
  assert.equal((err as TransferWaitCancelled).reason, 'switch');
  assert.equal(slots.running, 0);
});

test('raising the limit starts waiting transfers at once', async () => {
  const slots = createTransferSlots(1);
  await slots.acquire();
  let started = 0;
  for (let i = 0; i < 3; i++) void slots.acquire().then(() => { started += 1; });
  slots.setLimit(3);
  await tick();
  assert.equal(started, 2);
  assert.equal(slots.running, 3);
  assert.equal(slots.waiting, 1);
});

test('lowering the limit stops nothing that runs; new ones wait until running drops below it', async () => {
  const slots = createTransferSlots(3);
  const held = [await slots.acquire(), await slots.acquire(), await slots.acquire()];
  slots.setLimit(1);
  assert.equal(slots.running, 3, 'running transfers are never interrupted');
  let next = false;
  void slots.acquire().then(() => { next = true; });
  held[0]!(); held[1]!();
  await tick();
  assert.equal(next, false, 'one still runs, the limit is 1');
  held[2]!();
  await tick();
  assert.equal(next, true);
});

test('the limit is a whole number of at least one', () => {
  assert.equal(createTransferSlots(0).limit, 1);
  assert.equal(createTransferSlots(2.7).limit, 2);
  const slots = createTransferSlots(3);
  slots.setLimit(Number.NaN);
  assert.equal(slots.limit, 3, 'a nonsense value changes nothing');
});

test('tryAcquire takes a free slot now, and never jumps the line', async () => {
  const slots = createTransferSlots(1);
  const first = slots.tryAcquire();
  assert.ok(first, 'a free slot');
  assert.equal(slots.tryAcquire(), null, 'full');
  let queued = false;
  void slots.acquire().then(() => { queued = true; });
  slots.setLimit(2);
  await tick();
  assert.equal(queued, true, 'the raise went to the one in line');
  assert.equal(slots.tryAcquire(), null, 'full again at 2');
});
