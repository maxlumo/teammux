import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadProgress, uploadSummary } from './file-upload.ts';

// Owner 2026-09-20 (board #214): "文件上传要有个进度或者提示，让我知道传上去了没有".
// Board #23: the file goes over HTTP in chunks, so the line shows the bytes
// the server holds, of the total, with a percentage.
const s = {
  uploading: 'Uploading {name} ({index}/{total})', uploadBytes: '{sent} of {size}',
  uploaded: 'Uploaded {name}', uploadedMany: 'Uploaded {count} files',
  uploadFailed: 'Upload failed: {names}', uploadPartial: '{ok} uploaded, {failed} failed: {names}',
};
const fmt = (n: number) => `${n} B`;

test('the line shows bytes sent of total; the percentage is the progress value the shared atom draws, once', () => {
  const step = { name: 'a.bin', index: 2, total: 3, sent: 25, size: 100 };
  assert.deepEqual(uploadProgress(step, '/w', s, fmt),
    { kind: 'progress', message: 'Uploading a.bin (2/3)', detail: '25 B of 100 B · /w', progress: 25 });
  assert.equal(uploadProgress({ ...step, sent: 100 }, '/w', s, fmt).progress, 100);
  assert.equal(uploadProgress({ ...step, sent: 400 }, '/w', s, fmt).progress, 100, 'never past the end');
  assert.equal(uploadProgress({ ...step, sent: 1, size: 3 }, '/w', s, fmt).detail, '1 B of 3 B · /w', 'no second percentage: OperationFeedback shows it');
});

test('an empty file is complete, not divided by zero', () => {
  assert.deepEqual(uploadProgress({ name: 'e', index: 1, total: 1, sent: 0, size: 0 }, '/w', s, fmt),
    { kind: 'progress', message: 'Uploading e (1/1)', detail: '0 B of 0 B · /w', progress: 100 });
});

test('the closing line counts a clean batch and NAMES every failed file', () => {
  assert.deepEqual(uploadSummary({ ok: ['a.bin'], failed: [] }, '/w', s),
    { kind: 'success', message: 'Uploaded a.bin', detail: '/w' });
  assert.deepEqual(uploadSummary({ ok: ['a', 'b', 'c'], failed: [] }, '/w', s),
    { kind: 'success', message: 'Uploaded 3 files', detail: '/w' });
  assert.deepEqual(uploadSummary({ ok: ['a'], failed: [{ name: 'b', error: 'EACCES' }, { name: 'c', error: 'EIO' }] }, '/w', s),
    { kind: 'error', message: '1 uploaded, 2 failed: b, c', detail: 'b: EACCES' });
  assert.deepEqual(uploadSummary({ ok: [], failed: [{ name: 'b', error: 'cannot read: b' }] }, '/w', s),
    { kind: 'error', message: 'Upload failed: b', detail: 'b: cannot read: b' });
});
