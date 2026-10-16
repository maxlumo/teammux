import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QR_QUIET, qrMatrix } from './qr.ts';
import { buildConnectionLink } from './connection-link.ts';
import { CameraError, decodeFrame, decodePhoto, openCamera, type Frame } from './qr-scan.ts';

// Fixture credentials are fake.
function raster(matrix: boolean[][], scale = 4): Frame {
  const side = (matrix.length + 2 * QR_QUIET) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = ((QR_QUIET + y) * scale + dy) * side * 4 + ((QR_QUIET + x) * scale + dx) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }));
  return { width: side, height: side, data };
}
const LINK = buildConnectionLink({ address: 'wss://mac.tail.ts.net/ws', token: '0123456789abcdef0123456789abcdef', socket: '/tmp/tmux-1000/default' })!;
const blank = (side = 120): Frame => ({ width: side, height: side, data: new Uint8ClampedArray(side * side * 4).fill(255) });

test('a live frame and a photo both decode the link the code carries; a frame with no code is null, not an error', () => {
  const frame = raster(qrMatrix(LINK));
  assert.equal(decodeFrame(frame), LINK, 'live');
  assert.equal(decodeFrame(frame, true), LINK, 'photo');
  assert.equal(decodeFrame(blank()), null);
  assert.equal(decodeFrame({ width: 0, height: 0, data: new Uint8ClampedArray(0) }), null, 'a degenerate frame is a miss');
});

test('a photo is read through the injected reader, and a file that is not an image is a miss', async () => {
  const file = new Blob(['x'], { type: 'image/png' });
  assert.equal(await decodePhoto(file, async () => raster(qrMatrix(LINK))), LINK);
  assert.equal(await decodePhoto(file, async () => blank()), null, 'an image with no code');
  assert.equal(await decodePhoto(file, async () => { throw new Error('not an image'); }), null, 'a file the browser cannot read');
});

test('with no secure page there is no camera: the reason is "insecure", and nothing was asked of the device', async () => {
  await assert.rejects(openCamera({} as HTMLVideoElement), (error) => error instanceof CameraError && error.reason === 'insecure');
});

test('the module keeps nothing and says nothing about what it reads', async () => {
  const source = await readFile(new URL('./qr-scan.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/u);
});
