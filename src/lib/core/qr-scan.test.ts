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

// ─── the camera is owned from the moment it is acquired (review P1-C) ─────

function stage(over: { createElement?: () => unknown } = {}) {
  const track = { stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let giveStream!: (s: MediaStream) => void;
  const acquiring = new Promise<MediaStream>((resolve) => { giveStream = resolve; });
  let letPlay!: () => void;
  const playing = new Promise<void>((resolve) => { letPlay = resolve; });
  const video = { srcObject: null as unknown, muted: false, videoWidth: 0, videoHeight: 0, setAttribute() {}, play: () => playing } as unknown as HTMLVideoElement;
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  g.window = { isSecureContext: true };
  g.document = { createElement: over.createElement ?? (() => ({ getContext: () => ({}) })) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => acquiring } } });
  const restore = () => {
    g.window = saved.window; g.document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator); else delete g.navigator;
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { track, stream, video, giveStream, letPlay, restore, settle };
}
const reasonOf = (error: unknown) => (error as { reason?: string }).reason;

test('a stream that arrives after the scan ended is stopped and never attached', async () => {
  const s = stage();
  try {
    const lifetime = new AbortController();
    const opening = openCamera(s.video, lifetime.signal);
    lifetime.abort();
    s.giveStream(s.stream);
    await assert.rejects(opening, (e) => reasonOf(e) === 'cancelled');
    assert.equal(s.track.stopped, 1, 'the late stream was stopped');
    assert.equal(s.video.srcObject, null, 'and never attached to the video');
  } finally { s.restore(); }
});

test('ending the scan while playback is still pending stops the tracks at once, without waiting for playback', async () => {
  const s = stage();
  try {
    const lifetime = new AbortController();
    const opening = openCamera(s.video, lifetime.signal);
    s.giveStream(s.stream);
    await s.settle();
    assert.equal(s.track.stopped, 0, 'playing: the stream is in use');
    assert.equal(s.video.srcObject, s.stream);
    lifetime.abort();
    assert.equal(s.track.stopped, 1, 'stopped before play() settled');
    assert.equal(s.video.srcObject, null);
    s.letPlay();
    await assert.rejects(opening, (e) => reasonOf(e) === 'cancelled');
    assert.equal(s.track.stopped, 1, 'and only once');
  } finally { s.restore(); }
});

test('a failure after acquisition releases the stream', async () => {
  const s = stage({ createElement: () => { throw new Error('no canvas'); } });
  try {
    const opening = openCamera(s.video, new AbortController().signal);
    s.giveStream(s.stream);
    s.letPlay();
    await assert.rejects(opening, (e) => reasonOf(e) === 'failed');
    assert.equal(s.track.stopped, 1);
    assert.equal(s.video.srcObject, null);
  } finally { s.restore(); }
});

test('an open camera stops once on stop(), and a later abort has nothing left to stop; no frame is read after the abort', async () => {
  const s = stage();
  try {
    const lifetime = new AbortController();
    const opening = openCamera(s.video, lifetime.signal);
    s.giveStream(s.stream);
    s.letPlay();
    const camera = await opening;
    Object.assign(s.video, { videoWidth: 10, videoHeight: 10 });
    camera.stop();
    lifetime.abort();
    assert.equal(s.track.stopped, 1);
    assert.equal(camera.readFrame(), null, 'a stopped camera reads nothing');
  } finally { s.restore(); }
});
