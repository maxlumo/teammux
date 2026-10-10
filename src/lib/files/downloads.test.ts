import test from 'node:test';
import assert from 'node:assert/strict';
// The store is a runes module; outside the compiler $state is the value
// itself (the i18n.test.ts convention).
(globalThis as any).$state = (value: unknown) => value;
const { createDownloads, speed, feedbackOf } = await import('./downloads.svelte.ts');
// ONE server's record, the way a runtime's bundle holds it (board #335 ②b-2-1).
// Rebuilt per case, which is what the old `resetForTests` did to the module one.
let record = createDownloads();
const resetForTests = () => { record = createDownloads(); };
const downloads = { get rows() { return record.rows; }, get active() { return record.active; } };
const begin = (...a: Parameters<typeof record.begin>) => record.begin(...a);
const progress = (...a: Parameters<typeof record.progress>) => record.progress(...a);
const restarted = (...a: Parameters<typeof record.restarted>) => record.restarted(...a);
const saving = (...a: Parameters<typeof record.saving>) => record.saving(...a);
const done = (...a: Parameters<typeof record.done>) => record.done(...a);
const paused = (...a: Parameters<typeof record.paused>) => record.paused(...a);
const failed = (...a: Parameters<typeof record.failed>) => record.failed(...a);
const forget = (...a: Parameters<typeof record.forget>) => record.forget(...a);
const rowOf = (...a: Parameters<typeof record.rowOf>) => record.rowOf(...a);

const S = { downloading: 'Downloading', changed: 'File changed', saving: 'Saving' };

test('an attempt moves downloading → saving → done, and the slot value is read from the row (#308)', () => {
  resetForTests();
  const row = begin('a', 'v.mp4', '/srv/v.mp4', 1000);
  assert.equal(downloads.active, 1);
  progress('a', 0, 100, 1000);
  progress('a', 40, 100, 2000);
  assert.deepEqual(feedbackOf(row, S), { kind: 'progress', glyph: 'download', message: 'Downloading', detail: '/srv/v.mp4', progress: 40 });
  saving('a');
  assert.deepEqual([feedbackOf(row, S).message, feedbackOf(row, S).progress], ['Saving', null]);
  done('a', '/dl/v.mp4', 3000);
  assert.equal(row.state, 'done');
  assert.equal(row.savedPath, '/dl/v.mp4');
  assert.equal(downloads.active, 0);
});

test('a resume or a retry reuses the row: one file is one row, back on top (#308)', () => {
  resetForTests();
  begin('a', 'a.bin', '/a', 1); begin('b', 'b.bin', '/b', 2);
  paused('a', 'network down', 3);
  assert.equal(rowOf('a')!.state, 'paused');
  begin('a', 'a.bin', '/a', 4);
  assert.deepEqual(downloads.rows.map((r) => [r.id, r.state]), [['a', 'downloading'], ['b', 'downloading']]);
  failed('b', 'HTTP 404', 5);
  begin('b', 'b.bin', '/b', 6);
  assert.equal(downloads.rows.length, 2);
  assert.equal(rowOf('b')!.error, null, 'a retry starts clean');
  forget('a');
  assert.deepEqual(downloads.rows.map((r) => r.id), ['b']);
});

test('speed counts only what this attempt moved; a restart says why (#308)', () => {
  resetForTests();
  const row = begin('a', 'a.bin', '/a', 0);
  assert.equal(speed(row, 0), null);
  progress('a', 5000, 10000, 1000);           // a resume: the part had 5000 bytes
  progress('a', 7000, 10000, 3000);
  assert.equal(speed(row, 3000), 1000, '2000 bytes in 2 s, not 7000');
  restarted('a');
  assert.equal(feedbackOf(row, S).message, 'File changed');
  assert.equal(speed(row, 3000), null);
});
