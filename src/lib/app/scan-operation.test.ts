import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanHost, type ScanOp } from './scan-operation.ts';

test('an operation is registered synchronously, before anything can be awaited, and ends once with the text it was given', async () => {
  const seen: Array<ScanOp | null> = [];
  const host = new ScanHost((op) => seen.push(op));
  const { op, result } = host.begin('settings');
  assert.equal(host.current, op, 'current the moment begin returns');
  assert.deepEqual(seen, [op]);
  op.end('first');
  op.end('second');
  assert.equal(await result, 'first', 'the first end wins');
  assert.equal(host.current, null);
  assert.deepEqual(seen, [op, null]);
  assert.equal(op.ended, true);
});

test('resources registered with onEnd are released once on end, in order, even if one throws, and at once when registered late', () => {
  const host = new ScanHost();
  const { op } = host.begin('addServer');
  const log: string[] = [];
  op.onEnd(() => log.push('camera'));
  op.onEnd(() => { throw new Error('boom'); });
  op.onEnd(() => log.push('stream'));
  op.end(null);
  op.end(null);
  assert.deepEqual(log, ['camera', 'stream']);
  op.onEnd(() => log.push('late'));
  assert.deepEqual(log, ['camera', 'stream', 'late'], 'a release registered after the end runs now: nothing is acquired for an ended operation and left');
});

test('a second request ends the first with nothing; a late result of the first can neither return text nor clear or fill the second', async () => {
  const seen: Array<ScanOp | null> = [];
  const host = new ScanHost((op) => seen.push(op));
  const first = host.begin('settings');
  const released: string[] = [];
  first.op.onEnd(() => released.push('first'));
  const second = host.begin('settings');
  assert.equal(await first.result, null, 'the first settled with nothing');
  assert.deepEqual(released, ['first']);
  assert.equal(host.current, second.op);
  first.op.end('LATE-TEXT');                       // a slow permission answer arriving after the second tap
  assert.equal(host.current, second.op, 'the stale end did not clear its successor');
  second.op.end('second');
  assert.equal(await second.result, 'second', 'and returned nothing into it');
  assert.deepEqual(seen, [first.op, null, second.op, null]);
});

test('only the owner form\u2019s teardown ends its scan; Back or the background (end) ends whoever is running', async () => {
  const host = new ScanHost();
  const a = host.begin('addServer');
  host.endOwner('settings');
  assert.equal(a.op.ended, false, 'another form going away does not end it');
  host.endOwner('addServer');
  assert.equal(a.op.ended, true);
  assert.equal(await a.result, null);
  const b = host.begin('settings');
  host.end();
  assert.equal(b.op.ended, true);
  host.end();
  host.endOwner('settings');                        // nothing running: harmless
  assert.equal(host.current, null);
});
