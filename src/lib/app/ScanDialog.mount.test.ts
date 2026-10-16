// The browser/PWA scan dialog (board #403): the camera and the photo reader are
// injected, so this proves the dialog's own behaviour — what it says before the
// camera is asked, that a read hands back the text once and releases the camera,
// that a refused camera still leaves the photo path, and that it leaves nothing
// running when it closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { CameraError, type Camera, type Frame } from '../core/qr-scan.ts';
import { QR_QUIET, qrMatrix } from '../core/qr.ts';
import { buildConnectionLink } from '../core/connection-link.ts';

const compiled = compileMount(new URL('./ScanDialog.svelte', import.meta.url), []);
const LINK = buildConnectionLink({ address: 'wss://h.example/ws', token: 'FAKE-TOKEN', socket: '' })!;

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

function fakeCamera(readsUntil: number) {
  const calls = { opened: 0, reads: 0, stopped: 0 };
  const open = async (): Promise<Camera> => {
    calls.opened++;
    return { readFrame: () => (++calls.reads >= readsUntil ? LINK : null), stop: () => { calls.stopped++; } };
  };
  return { open, calls };
}

async function mountDialog(context: import('node:test').TestContext, props: Record<string, unknown>) {
  const app = await (await compiled).mount(context, {
    props, setup(window) { window.localStorage.setItem('tmux_locale', 'en'); }, modules: [],
  });
  for (let i = 0; i < 6 && !app.document.querySelector('.dlg video'); i++) await app.flush();
  return app;
}
// The dialog runs in the mounted window's realm, where a typed array made by the test
// is a foreign object; the decoder insists on its own realm's Uint8ClampedArray.
const inRealm = (app: { window: unknown } | undefined, frame: Frame): Frame => {
  const Clamped = (app?.window as { Uint8ClampedArray: Uint8ClampedArrayConstructor }).Uint8ClampedArray;
  return { width: frame.width, height: frame.height, data: new Clamped(frame.data) };
};
const settle = async (app: Awaited<ReturnType<typeof mountDialog>>, times = 24) => { for (let i = 0; i < times; i++) await app.flush(); };

test('it says what the camera is for before it asks, reads the code once, hands back only the text, and releases the camera', async context => {
  const camera = fakeCamera(3);
  const scanned: string[] = [];
  const app = await mountDialog(context, { camera: camera.open, onscanned: (text: string) => scanned.push(text), oncancel: () => {} });
  try {
    assert.match(app.document.querySelector('.dlg')!.textContent ?? '', /The camera is only used to read a connection QR code\. Nothing is recorded or sent\./u);
    await settle(app);
    assert.deepEqual(scanned, [LINK], 'handed back once');
    assert.equal(camera.calls.opened, 1);
    assert.equal(camera.calls.stopped, 1, 'and the camera was released');
    const reads = camera.calls.reads;
    await settle(app, 12);
    assert.equal(camera.calls.reads, reads, 'no frame is read after the code was found');
  } finally { await app.close(); }
});

test('a camera that cannot be used says why, and the photo path is still there', async context => {
  for (const [reason, text] of [['denied', 'Camera access is off'], ['none', 'No camera is available here'], ['insecure', 'The camera needs a secure (https) page'], ['failed', 'The camera could not be started']] as const) {
    const scanned: string[] = [];
    let app!: Awaited<ReturnType<typeof mountDialog>>;
    app = await mountDialog(context, {
      camera: async () => { throw new CameraError(reason); },
      toFrame: async () => inRealm(app, raster(qrMatrix(LINK))),
      onscanned: (value: string) => scanned.push(value), oncancel: () => {},
    });
    try {
      await settle(app, 4);
      assert.equal(app.document.querySelector('.scan-status')?.textContent?.trim(), text, reason);
      assert.ok(app.document.querySelector('.scan-view')!.classList.contains('off'), 'no empty video box');
      const input = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
      let picked = 0;
      input.addEventListener('click', () => { picked++; });
      [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /photo/iu.test(b.textContent ?? ''))!.click();
      assert.equal(picked, 1, 'a Photo command is there and opens the picker');
      assert.equal(input.getAttribute('accept'), 'image/*');
      assert.equal(input.getAttribute('capture'), 'environment', 'the photo opens the rear camera app where there is one');
      Object.defineProperty(input, 'files', { configurable: true, value: [new app.window.Blob(['x'], { type: 'image/png' })] });
      input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
      await settle(app, 4);
            assert.deepEqual(scanned, [LINK], `a photo still works with the camera ${reason}`);
    } finally { await app.close(); }
  }
});

test('a photo with no code says so and keeps the dialog open; the camera keeps looking', async context => {
  const camera = fakeCamera(1_000_000);
  const scanned: string[] = [];
  const app = await mountDialog(context, {
    camera: camera.open, toFrame: async () => ({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }),
    onscanned: (value: string) => scanned.push(value), oncancel: () => {},
  });
  try {
    await settle(app, 4);
    const input = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new app.window.Blob(['x'], { type: 'image/png' })] });
    input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app, 4);
    assert.equal(app.document.querySelector('.config-error[role=alert]')?.textContent, 'No code was found in that photo');
    assert.deepEqual(scanned, []);
    assert.equal(camera.calls.stopped, 0, 'the live view is still on');
  } finally { await app.close(); }
});

test('Cancel and closing the dialog both stop the camera and leave nothing running', async context => {
  const camera = fakeCamera(1_000_000);
  let cancelled = 0;
  const app = await mountDialog(context, { camera: camera.open, onscanned: () => assert.fail('nothing was scanned'), oncancel: () => { cancelled++; } });
  await settle(app, 4);
  [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^cancel$/iu.test((b.textContent ?? '').trim()))!.click();
  await settle(app, 2);
  assert.equal(cancelled, 1);
  await app.unmount();
  assert.equal(camera.calls.stopped, 1, 'unmounting released the camera');
  const reads = camera.calls.reads;
  await settle(app, 12);
  assert.equal(camera.calls.reads, reads, 'and no frame loop is left running');
});

// ─── the dialog's lifetime reaches the camera while it is still opening (review P1-C) ──

test('closing the dialog while the camera is still opening aborts the signal the camera got, and a camera that opens afterwards is stopped', async context => {
  let signal: AbortSignal | undefined;
  let open!: (camera: Camera) => void;
  const opening = new Promise<Camera>((resolve) => { open = resolve; });
  let stopped = 0;
  const app = await mountDialog(context, {
    camera: (_video: HTMLVideoElement, given: AbortSignal) => { signal = given; return opening; },
    onscanned: () => assert.fail('nothing was scanned'), oncancel: () => {},
  });
  await settle(app, 3);
  assert.ok(signal && !signal.aborted, 'the camera was given the dialog\u2019s lifetime');
  await app.close();
  assert.equal(signal!.aborted, true, 'closing ended it while the camera was still opening');
  open({ readFrame: () => assert.fail('no frame is read after the close'), stop: () => { stopped++; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopped, 1, 'and the camera that arrived late was stopped');
});

test('a photo is reachable while the camera is still starting and never settles, hands back the tuple, and releases the camera', async context => {
  let signal: AbortSignal | undefined;
  const scanned: string[] = [];
  let app!: Awaited<ReturnType<typeof mountDialog>>;
  app = await mountDialog(context, {
    camera: (_video: HTMLVideoElement, given: AbortSignal) => { signal = given; return new Promise<Camera>(() => {}); },
    toFrame: async () => inRealm(app, raster(qrMatrix(LINK))),
    onscanned: (text: string) => scanned.push(text), oncancel: () => {},
  });
  try {
    await settle(app, 3);
    assert.equal(app.document.querySelector('.scan-status')?.textContent?.trim(), 'Starting the camera…', 'still starting');
    const input = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new app.window.Blob(['x'], { type: 'image/png' })] });
    input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app, 4);
    assert.deepEqual(scanned, [LINK], 'the photo gave the link');
    assert.equal(signal!.aborted, true, 'and the camera that never opened was released');
  } finally { await app.close(); }
});

test('on the Android app a refused camera says where to allow it, and a browser keeps the short sentence; the photo command is there either way', async context => {
  for (const [android, text] of [[true, 'Camera access is off. Allow it in Android Settings > Apps > tmux-mobile > Permissions'], [false, 'Camera access is off']] as const) {
    const app = await (await compiled).mount(context, {
      props: { camera: async () => { throw new CameraError('denied'); }, onscanned: () => {}, oncancel: () => {} },
      setup(window) {
        window.localStorage.setItem('tmux_locale', 'en');
        if (android) {
          Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' });
          (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
        }
      },
      modules: [],
    });
    try {
      await settle(app, 4);
      assert.equal(app.document.querySelector('.scan-status')?.textContent?.trim(), text, android ? 'the Android app' : 'a browser');
      assert.ok([...app.document.querySelectorAll('.dlg button')].some((b) => /photo/iu.test(b.textContent ?? '')));
    } finally { await app.close(); }
  }
});

test('a camera that is still opening when a photo finishes the scan reports nothing: its cancellation is no failure to show', async context => {
  let app!: Awaited<ReturnType<typeof mountDialog>>;
  const scanned: string[] = [];
  app = await mountDialog(context, {
    camera: (_video: HTMLVideoElement, signal: AbortSignal) => new Promise<Camera>((_, no) => { signal.addEventListener('abort', () => no(new CameraError('cancelled'))); }),
    toFrame: async () => inRealm(app, raster(qrMatrix(LINK))),
    onscanned: (text: string) => scanned.push(text), oncancel: () => {},
  });
  try {
    await settle(app, 3);
    const input = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new app.window.Blob(['x'], { type: 'image/png' })] });
    input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await settle(app, 6);
    assert.deepEqual(scanned, [LINK]);
    assert.equal(app.document.querySelector('.scan-status')?.textContent?.trim(), 'Starting the camera…', 'no "could not be started" for a camera we stopped ourselves');
  } finally { await app.close(); }
});
