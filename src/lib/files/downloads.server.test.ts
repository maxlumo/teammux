// Two servers' downloads, held at once (board #335 ②a-4).
//
// `downloads.test.ts` covers the rules of ONE record (since ②b-2-1 through a
// record built per case, as each runtime builds its own). This file adds the only thing a factory buys:
// two records that cannot reach each other.
import test from 'node:test';
import assert from 'node:assert/strict';
// The store is a runes module; outside the compiler $state is the value
// itself (the downloads.test.ts / i18n.test.ts convention).
(globalThis as any).$state = (value: unknown) => value;
const { createDownloads } = await import('./downloads.svelte.ts');

test('two servers keep separate records of the same file', () => {
  // The collision this exists for: the same path on two machines. A row's
  // `path` means nothing without the machine it is on, so one `/etc/hosts`
  // download is not the other.
  const a = createDownloads();
  const b = createDownloads();
  a.begin('p1', 'hosts', '/etc/hosts', 1000);
  b.begin('p1', 'hosts', '/etc/hosts', 1000);

  a.progress('p1', 500, 1000, 2000);
  b.progress('p1', 10, 1000, 2000);
  assert.equal(a.rowOf('p1')?.received, 500);
  assert.equal(b.rowOf('p1')?.received, 10, 'B s transfer is its own');

  a.done('p1', '/tmp/hosts', 3000);
  assert.equal(a.rowOf('p1')?.state, 'done');
  assert.equal(b.rowOf('p1')?.state, 'downloading', 'finishing on A does not finish B');
  assert.equal(a.active, 0);
  assert.equal(b.active, 1);
});

test('forgetting one server s record leaves the other s', () => {
  // Before #335 this was `forgetAll` on a switch, because the one record held
  // the server being left. With one record per server it is just that server's
  // record going away — which is what ②b will do by dropping the instance.
  const a = createDownloads();
  const b = createDownloads();
  a.begin('p1', 'one', '/a/one');
  b.begin('p2', 'two', '/b/two');

  a.forgetAll();
  assert.deepEqual(a.rows.map((r) => r.id), []);
  assert.deepEqual(b.rows.map((r) => r.id), ['p2'], 'B still has its row');

  b.forget('p2');
  assert.deepEqual(b.rows.map((r) => r.id), []);
});

test('a row of one record cannot be reached through another', () => {
  const a = createDownloads();
  const b = createDownloads();
  a.begin('p1', 'one', '/a/one');
  // Every mutator looks the row up in its OWN rows, so B's calls for A's id
  // are no-ops rather than cross-writes.
  for (const call of [
    () => b.progress('p1', 1, 2),
    () => b.restarted('p1'),
    () => b.saving('p1'),
    () => b.done('p1', '/tmp/x'),
    () => b.paused('p1', 'stopped'),
    () => b.failed('p1', 'broken'),
    () => b.forget('p1'),
  ]) {
    call();
    assert.equal(b.rowOf('p1'), undefined, 'B never acquires a row it did not begin');
    assert.equal(a.rowOf('p1')?.state, 'downloading', 'and A s row is untouched');
    assert.equal(a.rowOf('p1')?.received, 0);
  }
});
