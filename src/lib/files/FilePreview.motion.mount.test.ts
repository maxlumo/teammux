// Board #133 (leader's ruling, note 2): a Motion Photo previews as its still with one Live
// control at the pane's top-left; pressed, it plays the embedded video ONCE, with sound, in a
// bare <video> over the still; on 'ended', on Stop or on leaving the file the still returns.
// The stream URL is minted lazily on the first press; a failed stream returns the still and
// reports through the preview's existing error path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./FilePreview.svelte', import.meta.url), []);
const noop = () => {};
const still = 'data:image/jpeg;base64,AA==';
const photo = (path: string, motion: object | null) => ({
  path, name: path.slice(path.lastIndexOf('/') + 1), dataUrl: still,
  stat: { mime_hint: 'image/jpeg', ...(motion ? { motion } : {}) },
});

/** The still's natural size (jsdom decodes no image; the preview reads it at `load`). */
const natural = { width: 1200, height: 1600 };
type Play = (el: HTMLMediaElement, win: Window & typeof globalThis) => Promise<void>;

/** The next mount runs as the Android app (board #139). */
let androidApp = false;

async function mount(context: test.TestContext, file: object, extra: Record<string, unknown> = {}, play: Play = () => Promise.resolve()) {
  const plays: HTMLMediaElement[] = [];
  const app = await (await compiled).mount(context, {
    modules: [],
    setup(win) {
      if (androidApp) {
        Object.defineProperty(win.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36', configurable: true });
        (win as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
      }
      win.HTMLMediaElement.prototype.play = function () { plays.push(this); return play(this, win as never); };
      win.HTMLMediaElement.prototype.pause = function () {};
      Object.defineProperty(win.HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => natural.width });
      Object.defineProperty(win.HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => natural.height });
    },
    props: {
      currentFile: file, fontSize: 14, wrapLines: false, hljs: null, showAllLines: false,
      previewLinkClick: noop, attachHtmlPreviewLinks: noop,
      previewBodyEl: null, previewEl: null, htmlPreviewEl: null, pdfContainer: null,
      onview: noop, onpreviewerror: noop, openMotion: null, ...extra,
    },
  });
  await loaded(app);
  return { app, plays };
}

/** The still decoded: the browser's `load`, which jsdom never fires for a data URL. */
async function loaded(app: { document: Document; window: { Event: typeof Event }; flush: () => Promise<void> }) {
  app.document.querySelector('.image-open img')?.dispatchEvent(new app.window.Event('load'));
  await app.flush();
}

const live = (d: Document) => d.querySelector<HTMLButtonElement>('.motion-live button, button.motion-live');
const settle = async (app: { flush: () => Promise<void> }) => { for (let i = 0; i < 6; i++) await app.flush(); };

test('a plain JPEG has no Live control', async (context) => {
  const { app } = await mount(context, photo('/p/plain.jpg', null), { openMotion: () => Promise.resolve('u') });
  assert.equal(live(app.document), null);
  assert.ok(app.document.querySelector('.image-open img'), 'the still as before');
});

test('Live mints lazily, plays once with sound in the still\'s box, and the still returns on ended', async (context) => {
  const asked: string[] = [];
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 401655, length: 2093316 }), {
    openMotion: (path: string) => { asked.push(path); return Promise.resolve('https://h/dl?path=%2Fp%2Flive.jpg&motion=401655-2093316'); },
  });
  const button = live(app.document)!;
  assert.ok(button, 'the Live control');
  assert.match(button.textContent ?? '', /Live/u, 'the visible word, not only an icon');
  assert.equal(button.closest('.image-open'), null, 'outside the picture\'s zoom target');
  assert.deepEqual(asked, [], 'nothing minted before the first press');
  button.click(); await settle(app);
  assert.deepEqual(asked, ['/p/live.jpg']);
  const video = app.document.querySelector<HTMLVideoElement>('.image-preview video')!;
  assert.ok(video, 'a bare video over the still');
  assert.equal(video.getAttribute('src'), 'https://h/dl?path=%2Fp%2Flive.jpg&motion=401655-2093316');
  assert.ok(video.hasAttribute('playsinline'));
  assert.equal(video.muted, false, 'sound on');
  assert.equal(video.loop, false, 'once');
  assert.equal(video.hasAttribute('controls'), false, 'no player bar over the moment');
  assert.deepEqual(plays, [video]);
  assert.ok(app.document.querySelector('.image-open img'), 'the still stays underneath');
  assert.match(live(app.document)!.textContent ?? '', /Stop/u);
  video.dispatchEvent(new app.window.Event('ended')); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'ended: the still again');
  assert.match(live(app.document)!.textContent ?? '', /Live/u, 'and the control replays');
  live(app.document)!.click(); await settle(app);
  assert.ok(app.document.querySelector('.image-preview video'), 'replayed');
  assert.deepEqual(asked, ['/p/live.jpg'], 'the minted URL is reused for this file');
  live(app.document)!.click(); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'Stop: the still again');
});

test('the picture keeps its zoom tap beside the control', async (context) => {
  const viewed: string[] = [];
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: () => Promise.resolve('u'), onview: (s: string) => viewed.push(s) });
  app.document.querySelector<HTMLButtonElement>('.image-open')!.click();
  assert.deepEqual(viewed, [still]);
});

test('a failed mint or a failed stream returns the still and says so', async (context) => {
  const errors: string[] = [];
  let fail = true;
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: () => fail ? Promise.reject(new Error('stream: not a Motion Photo')) : Promise.resolve('https://h/v'),
    onpreviewerror: (m: string) => errors.push(m),
  });
  live(app.document)!.click(); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null);
  assert.equal(errors.length, 1, 'reported, not a silent nothing');
  assert.match(errors[0]!, /motion/iu);
  fail = false;
  live(app.document)!.click(); await settle(app);
  const video = app.document.querySelector<HTMLVideoElement>('.image-preview video')!;
  video.dispatchEvent(new app.window.Event('error')); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'a stream error: the still');
  assert.equal(errors.length, 2);
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
});

test('leaving the file stops the motion, and a late mint for it never plays on the next', async (context) => {
  let release: (u: string) => void = noop;
  const { app, plays } = await mount(context, photo('/p/a.jpg', { offset: 1, length: 2 }), {
    openMotion: () => new Promise<string>((r) => { release = r; }),
  });
  live(app.document)!.click(); await settle(app);
  await app.setProps({ currentFile: photo('/p/b.jpg', { offset: 1, length: 2 }) }); await loaded(app); await settle(app);
  release('https://h/a'); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'A\'s late URL never plays on B');
  assert.deepEqual(plays, []);
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
});

test('reading mode is unaffected: it is never offered for a picture, so a Motion Photo has none (#133 ruling)', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = await readFile(new URL('./Files.svelte', import.meta.url), 'utf8');
  assert.match(files, /let readingEligible = \$derived\(layout\.phone && view === 'preview' && !!currentFile\s*&& !\['image', 'video', 'audio'\]\.includes\(mimeCategory\(currentFile\.stat\?\.mime_hint\)\)\);/u);
});

// Validator-2, #133 notes 13 and 27 (leader's ruling): a REJECTED play() is a failure (the
// still and a report), an AbortError too while the motion is still meant to play; only a
// rejection caused by our own Stop or leaving is not. Each attempt has ITS video: a retired
// video's late rejection neither stops a new replay nor reports.
const deferred = () => { let reject: (e: unknown) => void = noop; const p = new Promise<void>((_, r) => { reject = r; }); return { p, reject }; };

test('a refused play returns the still and says so', async (context) => {
  const errors: string[] = [];
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: () => Promise.resolve('https://h/v'), onpreviewerror: (m: string) => errors.push(m),
  }, (_el, win) => Promise.reject(new win.DOMException('refused', 'NotAllowedError')));
  live(app.document)!.click(); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'refused: the still');
  assert.equal(errors.length, 1);
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
});

test('an AbortError while the motion is still meant to play is a failure too', async (context) => {
  const errors: string[] = [];
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: () => Promise.resolve('https://h/v'), onpreviewerror: (m: string) => errors.push(m),
  }, (_el, win) => Promise.reject(new win.DOMException('aborted', 'AbortError')));
  live(app.document)!.click(); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'the still');
  assert.equal(errors.length, 1, 'not exempt: we did not stop it');
});

test('a play our own Stop aborts is not a failure', async (context) => {
  const errors: string[] = [];
  const d = deferred();
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: () => Promise.resolve('https://h/v'), onpreviewerror: (m: string) => errors.push(m),
  }, () => d.p);
  live(app.document)!.click(); await settle(app);
  live(app.document)!.click(); await settle(app);              // Stop
  d.reject(new app.window.DOMException('aborted', 'AbortError')); await settle(app);
  assert.deepEqual(errors, []);
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
});

test('a retired video\'s late rejection neither stops the replay nor reports', async (context) => {
  const errors: string[] = [];
  const first = deferred();
  let calls = 0;
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: () => Promise.resolve('https://h/v'), onpreviewerror: (m: string) => errors.push(m),
  }, () => (calls++ === 0 ? first.p : Promise.resolve()));
  live(app.document)!.click(); await settle(app);              // attempt 1, pending
  live(app.document)!.click(); await settle(app);              // Stop
  live(app.document)!.click(); await settle(app);              // attempt 2, playing
  assert.equal(plays.length, 2);
  assert.notEqual(plays[0], plays[1], 'each attempt has its own video');
  first.reject(new app.window.DOMException('late', 'NotAllowedError')); await settle(app);
  assert.ok(app.document.querySelector('.image-preview video'), 'the replay plays on');
  assert.match(live(app.document)!.textContent ?? '', /Stop/u);
  assert.deepEqual(errors, []);
  plays[0]!.dispatchEvent(new app.window.Event('ended')); await settle(app);
  assert.ok(app.document.querySelector('.image-preview video'), 'and a retired video\'s ended does nothing');
});

// Validator-2, #133 notes 22 and 28 (leader's ruling): the video's box comes from the SAME
// layout as the still's, never from a measured rect (which went 50 px off after a resize): the
// still's natural size under the same max-only constraints, in the same container.
test('the motion is laid out from the still\'s natural size, in the still\'s container', async (context) => {
  natural.width = 80; natural.height = 80;
  try {
    const { app } = await mount(context, photo('/p/tiny.jpg', { offset: 1, length: 2 }), { openMotion: () => Promise.resolve('https://h/v') });
    live(app.document)!.click(); await settle(app);
    const video = app.document.querySelector<HTMLVideoElement>('.image-preview video')!;
    assert.equal(video.style.getPropertyValue('--still-w'), '80');
    assert.equal(video.style.getPropertyValue('--still-h'), '80');
    assert.equal(video.style.getPropertyValue('left'), '', 'no measured position');
    assert.ok(app.document.querySelector('.image-preview.motion'), 'the pane is the size container both are laid out in');
  } finally { natural.width = 1200; natural.height = 1600; }
});

// Reviewer, #133 note 42 (leader's ruling): the Live INTENT owns mint → playback. One mint per
// file (single flight); Stop, hide and leaving retire the intent; only the CURRENT intent
// consumes the mint or reports it. A late answer for a retired intent is silent.
function pendingMint() {
  let resolve: (u: string) => void = noop, reject: (e: Error) => void = noop;
  const asked: string[] = [];
  const open = (path: string) => { asked.push(path); return new Promise<string>((ok, no) => { resolve = ok; reject = no; }); };
  return { asked, open, resolve: (u: string) => resolve(u), reject: (e: Error) => reject(e) };
}

test('Live → Stop → Live shares ONE mint, and its success plays once for the current intent', async (context) => {
  const m = pendingMint();
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: m.open });
  live(app.document)!.click(); await settle(app);
  live(app.document)!.click(); await settle(app);              // Stop: retires the first intent
  live(app.document)!.click(); await settle(app);              // a new intent waits on the same mint
  assert.deepEqual(m.asked, ['/p/live.jpg'], 'one mint');
  m.resolve('https://h/a'); await settle(app);
  const videos = app.document.querySelectorAll('.image-preview video');
  assert.equal(videos.length, 1);
  assert.equal(videos[0]!.getAttribute('src'), 'https://h/a');
  assert.equal(plays.length, 1, 'played once');
});

test('Live → Stop → Live, then the shared mint fails: ONE report for the current intent, Live again', async (context) => {
  const m = pendingMint();
  const errors: string[] = [];
  const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: m.open, onpreviewerror: (e: string) => errors.push(e) });
  live(app.document)!.click(); await settle(app);
  live(app.document)!.click(); await settle(app);
  live(app.document)!.click(); await settle(app);
  m.reject(new Error('mint failed')); await settle(app);
  assert.equal(errors.length, 1, 'reported once, not once per press');
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
  live(app.document)!.click(); await settle(app);
  assert.equal(m.asked.length, 2, 'a failed mint is not kept: the next press mints again');
});

test('Live → Stop, then the mint settles: nothing plays and nothing is reported', async (context) => {
  const m = pendingMint();
  const errors: string[] = [];
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: m.open, onpreviewerror: (e: string) => errors.push(e) });
  live(app.document)!.click(); await settle(app);
  live(app.document)!.click(); await settle(app);              // Stop
  m.reject(new Error('mint failed')); await settle(app);
  assert.deepEqual(errors, [], 'a retired intent is silent');
  assert.equal(app.document.querySelector('.image-preview video'), null);
  assert.deepEqual(plays, []);
});

test('hiding the page retires the intent: a mint answering afterwards never plays', async (context) => {
  const m = pendingMint();
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: m.open, visible: true });
  live(app.document)!.click(); await settle(app);
  await app.setProps({ visible: false }); await settle(app);
  await app.setProps({ visible: true }); await settle(app);
  m.resolve('https://h/a'); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'the page came back, the intent did not');
  assert.deepEqual(plays, []);
  assert.match(live(app.document)!.textContent ?? '', /Live/u);
});

// Reviewer, #133 note 52 (leader's ruling): a STREAM failure drops the cached URL as a failed
// mint does. The owner rewrites these files while previewing them, and a rewritten file's URL
// answers 404: replaying it on every press would report again until he left the file.
test('a stream error drops the cached URL: the next press mints afresh and plays', async (context) => {
  const asked: string[] = [];
  const errors: string[] = [];
  const { app, plays } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), {
    openMotion: (path: string) => { asked.push(path); return Promise.resolve(`https://h/v${asked.length}`); },
    onpreviewerror: (e: string) => errors.push(e),
  });
  live(app.document)!.click(); await settle(app);
  app.document.querySelector('.image-preview video')!.dispatchEvent(new app.window.Event('error')); await settle(app);
  assert.equal(app.document.querySelector('.image-preview video'), null, 'the still');
  assert.equal(errors.length, 1);
  live(app.document)!.click(); await settle(app);
  assert.equal(asked.length, 2, 'a NEW mint');
  assert.equal(app.document.querySelector('.image-preview video')!.getAttribute('src'), 'https://h/v2');
  assert.equal(plays.length, 2);
});

// Board #139 (owner, 2026-11-16 09:09: '点击播放按钮的时候，会出现一个很丑的大大的播放器播放按键图案在图片中间'):
// the motion's <video> carries the transparent poster in the Android app, so WebView never
// paints its stock one over the still before the first frame; none on the desktop.
for (const android of [true, false]) {
  test(`the motion's video poster: ${android ? 'transparent in the Android app' : 'none on the desktop'} (#139)`, async (context) => {
    androidApp = android;
    try {
      const { app } = await mount(context, photo('/p/live.jpg', { offset: 1, length: 2 }), { openMotion: () => Promise.resolve('https://h/v') });
      live(app.document)!.click(); await settle(app);
      const poster = app.document.querySelector('.image-preview video')!.getAttribute('poster');
      if (android) assert.match(poster ?? '', /^data:image\/gif;base64,/u);
      else assert.equal(poster, null);
      assert.ok(app.document.querySelector('.image-open img'), 'the still stays underneath');
    } finally { androidApp = false; }
  });
}
