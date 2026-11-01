import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { E2E_OVERHEAD_BYTES, WS_MAX_MESSAGE_BYTES, maxUploadBytes, uploadProgress, uploadSizeError, uploadSummary } from './file-upload.ts';

// Owner 2026-09-20 (board #214): "文件上传要有个进度或者提示，让我知道传上去了没有".
const s = {
  uploading: 'Uploading {name} ({index}/{total})', uploadReading: 'Reading', uploadSending: 'Sending',
  uploaded: 'Uploaded {name}', uploadedMany: 'Uploaded {count} files',
  uploadFailed: 'Upload failed: {names}', uploadPartial: '{ok} uploaded, {failed} failed: {names}',
};

test('reading shows real bytes; sending is a discrete beat with no invented percentage', () => {
  const step = { name: 'a.bin', index: 2, total: 3, phase: 'reading' as const, loaded: 25, size: 100 };
  assert.deepEqual(uploadProgress(step, '/w', s),
    { kind: 'progress', message: 'Uploading a.bin (2/3)', detail: 'Reading · /w', progress: 25 });
  // One fs_upload RPC carries the whole file: nothing observes the send.
  assert.deepEqual(uploadProgress({ ...step, phase: 'sending', loaded: 100 }, '/w', s),
    { kind: 'progress', message: 'Uploading a.bin (2/3)', detail: 'Sending · /w', progress: null });
  // Unknown size (a native path read whole) has no percentage to show either.
  assert.equal(uploadProgress({ ...step, size: 0 }, '/w', s).progress, null);
  assert.equal(uploadProgress({ ...step, loaded: 400 }, '/w', s).progress, 100, 'never past the end');
});

test('the closing line counts a clean batch and NAMES every failed file', () => {
  assert.deepEqual(uploadSummary({ ok: ['a.bin'], failed: [] }, '/w', s),
    { kind: 'success', message: 'Uploaded a.bin', detail: '/w' });
  assert.deepEqual(uploadSummary({ ok: ['a', 'b', 'c'], failed: [] }, '/w', s),
    { kind: 'success', message: 'Uploaded 3 files', detail: '/w' });
  assert.deepEqual(uploadSummary({ ok: ['a'], failed: [{ name: 'b', error: 'EACCES' }, { name: 'c', error: 'EIO' }] }, '/w', s),
    { kind: 'error', message: '1 uploaded, 2 failed: b, c', detail: 'EACCES' });
  assert.deepEqual(uploadSummary({ ok: [], failed: [{ name: 'b', error: 'cannot read: b' }] }, '/w', s),
    { kind: 'error', message: 'Upload failed: b', detail: 'cannot read: b' });
});

// Board #498: a file at the old fixed 60 MiB cap was refused by the server
// ("Message too long: 83886203 > 83886080", #497's rig) because 60 MiB of
// base64 IS the 80 MiB limit before the JSON around it. The cap is now the
// limit less the worst-case message for THIS path.
const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** The largest message a file of `size` bytes can become, built the way
 * call() builds it, plus the uncompressed E2E framing and tag. */
const worstMessage = (path: string, size: number) =>
  utf8(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method: 'fs_upload', params: { path, data: 'A'.repeat(4 * Math.ceil(size / 3)) } })) + E2E_OVERHEAD_BYTES;

test('the client s message limit is the server s, one number in two languages (#498)', () => {
  const rust = readFileSync(new URL('../../../src-tauri/src/server/connection.rs', import.meta.url), 'utf8');
  const m = /const WS_MAX_MESSAGE_BYTES: usize = (\d+) \* (\d+) \* (\d+);/u.exec(rust);
  assert.ok(m, 'connection.rs declares the limit');
  assert.equal(WS_MAX_MESSAGE_BYTES, Number(m[1]) * Number(m[2]) * Number(m[3]));
  assert.equal(E2E_OVERHEAD_BYTES, 17, 'one framing byte and the 16-byte AES-GCM tag');
});

for (const [kind, path] of [
  ['ASCII', '/home/me/work/upload/f60.bin'],
  ['CJK', '/home/我/文件/上传的大文件.bin'],
  ['escaped', '/tmp/a"b\\c\u0001\u001f\n.bin'],
] as const) {
  test(`the largest accepted file fits the server s limit, one byte more is refused up front (${kind} path, #498)`, () => {
    const max = maxUploadBytes(path)!;
    assert.ok(max > 59 * 1024 * 1024 && max < 60 * 1024 * 1024, `about 59.99 MiB: ${max}`);
    assert.equal(uploadSizeError(max, path, 'max {size}'), null, 'the largest file goes');
    assert.ok(worstMessage(path, max) <= WS_MAX_MESSAGE_BYTES, `its worst message fits: ${worstMessage(path, max)}`);
    assert.notEqual(uploadSizeError(max + 1, path, 'max {size}'), null, 'one byte more is refused');
    // The cap is not merely low: max is a multiple of 3, so max+1 starts the
    // next 4-byte base64 quantum, and that worst message would not fit (P2-B).
    assert.equal(max % 3, 0);
    assert.ok(worstMessage(path, max + 1) > WS_MAX_MESSAGE_BYTES, `max+1 would overflow: ${worstMessage(path, max + 1)}`);
  });
}

test('the path is priced in UTF-8 bytes of its JSON, not JS string length (#498)', () => {
  const ascii = maxUploadBytes('/a/b.bin')!;
  assert.ok(maxUploadBytes('/a/我.bin')! < ascii, 'a CJK character is 3 bytes');
  assert.ok(maxUploadBytes('/a/\u0001.bin')! < maxUploadBytes('/a/x.bin')!, 'a control character escapes to 6 bytes');
});

test('the refusal says the real limit without rounding it up, and refuses nonsense sizes (#498)', () => {
  const path = '/home/me/f.bin';
  assert.equal(uploadSizeError(0, path, 'max {size}'), null, 'an empty file goes');
  assert.equal(uploadSizeError(1024, path, 'max {size}'), null);
  assert.equal(uploadSizeError(60 * 1024 * 1024, path, 'max {size}'), 'max 59.99 MiB', 'the old cap is now refused, and the limit is not shown as 60');
  assert.equal(uploadSizeError(-1, path, 'max {size}'), 'max 59.99 MiB');
  assert.equal(uploadSizeError(Number.NaN, path, 'max {size}'), 'max 59.99 MiB');
  // A wrapper that does not fit at all refuses every size, an empty file
  // included; it is not a capacity of 0 (review P2-A).
  const huge = 'x'.repeat(WS_MAX_MESSAGE_BYTES);
  assert.equal(maxUploadBytes(huge), null);
  assert.equal(uploadSizeError(0, huge, 'max {size}'), 'max 0.00 MiB', 'an empty file is refused, no negative size shown');
  // The edge itself: a path that leaves exactly room for an empty file.
  const fixed = utf8(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method: 'fs_upload', params: { path: '', data: '' } }));
  const exact = 'x'.repeat(WS_MAX_MESSAGE_BYTES - fixed - E2E_OVERHEAD_BYTES);
  assert.equal(maxUploadBytes(exact), 0, 'room for nothing but the wrapper');
  assert.equal(uploadSizeError(0, exact, 'max {size}'), null, 'an empty file fits there');
  assert.equal(worstMessage(exact, 0), WS_MAX_MESSAGE_BYTES, 'exactly at the limit');
  assert.equal(maxUploadBytes(`${exact}x`), null, 'one byte more of path and nothing fits');
  assert.notEqual(uploadSizeError(0, `${exact}x`, 'max {size}'), null);
});
