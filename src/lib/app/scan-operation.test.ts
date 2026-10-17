import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanHost, type ScanOp } from './scan-operation.ts';

test('an operation is registered synchronously, before anything can be awaited, and ends once with the text it was given', async () => {
  const seen: Array<ScanOp | null> = [];
  const host = new ScanHost((op) => seen.push(op));
  const { op, result } = host.begin();
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
  const { op } = host.begin();
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
  const first = host.begin();
  const released: string[] = [];
  first.op.onEnd(() => released.push('first'));
  const second = host.begin();
  assert.equal(await first.result, null, 'the first settled with nothing');
  assert.deepEqual(released, ['first']);
  assert.equal(host.current, second.op);
  first.op.end('LATE-TEXT');                       // a slow permission answer arriving after the second tap
  assert.equal(host.current, second.op, 'the stale end did not clear its successor');
  second.op.end('second');
  assert.equal(await second.result, 'second', 'and returned nothing into it');
  assert.deepEqual(seen, [first.op, null, second.op, null]);
});

test('the consumer form\u2019s lifetime ends its scan wherever the page is, once, with nothing; a consumer already gone gets an operation that never ran; Back or the background (end) ends whoever is running', async () => {
  const host = new ScanHost();
  const form = new AbortController();
  const a = host.begin(form.signal);
  const released: string[] = [];
  a.op.onEnd(() => released.push('camera'));
  form.abort();                                      // the form unmounted, though the page name did not change
  assert.equal(a.op.ended, true);
  assert.equal(await a.result, null, 'the promise settled with nothing');
  assert.deepEqual(released, ['camera'], 'and, separately, the resource was released');
  assert.equal(host.current, null);
  a.op.end('LATE');                                  // a result that arrives after the form is gone
  assert.equal(await a.result, null, 'a stale consumer never receives a result');

  const gone = new AbortController();
  gone.abort();
  const b = host.begin(gone.signal);
  assert.equal(b.op.ended, true, 'begun for a consumer that no longer exists: already over');
  assert.equal(await b.result, null);
  assert.equal(host.current, null);

  const alive = new AbortController();
  const c = host.begin(alive.signal);
  host.end();
  assert.equal(c.op.ended, true);
  alive.abort();                                     // the form going away later has nothing left to end
  host.end();
  assert.equal(host.current, null);
});

test('a photo picker hold is the operation\u2019s own flag and starts false', () => {
  const host = new ScanHost();
  const { op } = host.begin();
  assert.equal(op.picking, false);
  op.picking = true;
  assert.equal(op.picking, true);
});
