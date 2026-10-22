import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileMount } from '../test/mount.ts';

// Board #453: the Files player over a scripted media element. jsdom plays
// nothing, so the element is a stand-in whose play() promises the test
// settles, and whose state (paused, time, ranges, error) the test sets.

const compiled = compileMount(new URL('./MediaPlayer.svelte', import.meta.url), []);

type Pending = { resolve: () => void; reject: (name: string) => void };
type Media = { paused: boolean; t: number; d: number; buf: number[][]; seek: number[][]; err: number | null; muted: boolean;
  plays: Pending[]; pauses: number; seeks: number[] };

function stubMedia(win: any, opts: { fullscreen?: boolean; pip?: boolean } = {}) {
  const P = win.HTMLMediaElement.prototype;
  const states = new WeakMap<object, Media>();
  const s = (el: object): Media => {
    if (!states.has(el)) states.set(el, { paused: true, t: 0, d: NaN, buf: [], seek: [], err: null, muted: false, plays: [], pauses: 0, seeks: [] });
    return states.get(el)!;
  };
  const ranges = (a: number[][]) => ({ length: a.length, start: (i: number) => a[i]![0], end: (i: number) => a[i]![1] });
  const prop = (name: string, get: (m: Media) => unknown, set?: (m: Media, v: any, el: any) => void) =>
    Object.defineProperty(P, name, { configurable: true, get() { return get(s(this)); }, set(v) { set?.(s(this), v, this); } });
  prop('paused', (m) => m.paused);
  prop('currentTime', (m) => m.t, (m, v) => { m.t = v; m.seeks.push(v); });
  prop('duration', (m) => m.d);
  prop('buffered', (m) => ranges(m.buf));
  prop('seekable', (m) => ranges(m.seek));
  prop('error', (m) => (m.err == null ? null : { code: m.err }));
  prop('muted', (m) => m.muted, (m, v, el) => { m.muted = v; el.dispatchEvent(new win.Event('volumechange')); });
  P.play = function (this: any) {
    const m = s(this), el = this;
    return new win.Promise((res: () => void, rej: (e: Error) => void) => m.plays.push({
      resolve: () => { m.paused = false; el.dispatchEvent(new win.Event('play')); res(); },
      reject: (name: string) => { const e = new win.Error(name); e.name = name; rej(e); },
    }));
  };
  P.pause = function (this: any) { const m = s(this); m.pauses++; if (!m.paused) { m.paused = true; this.dispatchEvent(new win.Event('pause')); } };
  P.load = () => {};
  // Layout: the picture is 300 px wide at x = 0.
  win.HTMLVideoElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0 });
  win.Element.prototype.getAnimations = () => [];
  const exits = { fs: 0, pip: 0 };
  if (opts.fullscreen) {
    Object.defineProperty(win.document, 'fullscreenEnabled', { value: true, configurable: true });
    let fsEl: Element | null = null;
    Object.defineProperty(win.document, 'fullscreenElement', { get: () => fsEl, configurable: true });
    win.__fsRequests = [] as Pending[];
    win.HTMLElement.prototype.requestFullscreen = function (this: Element) {
      const el = this;
      return new win.Promise((res: () => void, rej: (e: Error) => void) => win.__fsRequests.push({
        resolve: () => { fsEl = el; win.document.dispatchEvent(new win.Event('fullscreenchange')); res(); },
        reject: () => rej(new win.Error('denied')),
      }));
    };
    win.document.exitFullscreen = () => { exits.fs++; fsEl = null; win.document.dispatchEvent(new win.Event('fullscreenchange')); return win.Promise.resolve(); };
    win.__setFs = (el: Element | null) => { fsEl = el; };
  }
  if (opts.pip) {
    Object.defineProperty(win.document, 'pictureInPictureEnabled', { value: true, configurable: true });
    let pipEl: Element | null = null;
    Object.defineProperty(win.document, 'pictureInPictureElement', { get: () => pipEl, configurable: true });
    win.__pipRequests = [] as Pending[];
    win.HTMLVideoElement.prototype.requestPictureInPicture = function (this: Element) {
      const el = this;
      return new win.Promise((res: () => void) => win.__pipRequests.push({ resolve: () => { pipEl = el; res(); }, reject: () => {} }));
    };
    win.document.exitPictureInPicture = () => { exits.pip++; pipEl = null; return win.Promise.resolve(); };
    win.__setPip = (el: Element | null) => { pipEl = el; };
  }
  win.__media = s;
  win.__exits = exits;
}

async function player(context: TestContext, props: Record<string, unknown> = {}, opts: { fullscreen?: boolean; pip?: boolean } = {}, extra?: (win: any) => void) {
  const app = await (await compiled).mount(context, {
    props: { kind: 'video', src: 'https://h/dl?path=%2Fa.mp4&stream=1', name: 'a.mp4', visible: true, ...props },
    setup: (win) => { stubMedia(win, opts); extra?.(win); },
    modules: [],
  });
  const w = app.window as any;
  const video = () => app.document.querySelector('video, audio') as HTMLMediaElement;
  const m = () => w.__media(video()) as Media;
  const ev = (type: string) => video().dispatchEvent(new w.Event(type));
  const loaded = async (d = 600, seek: number[][] = [[0, d]], buf: number[][] = [[0, 60]]) => {
    Object.assign(m(), { d, seek, buf }); ev('loadedmetadata'); ev('progress'); await app.flush();
  };
  const button = (label: string) => app.document.querySelector<HTMLButtonElement>(`.mp-bar [aria-label="${label}"]`);
  const range = () => app.document.querySelector<HTMLInputElement>('.mp-bar input[type="range"]')!;
  const fireRange = (type: string) => range().dispatchEvent(new w.Event(type, { bubbles: true }));
  const bar = () => app.document.querySelector<HTMLElement>('.mp-bar')!;
  const tap = async (x: number) => {
    video().dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: 100 }));
    video().dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: 100 }));
    await app.flush();
  };
  const settlePlay = async (i: number, how: 'resolve' | string = 'resolve') => {
    const p = m().plays[i]!;
    if (how === 'resolve') p.resolve(); else p.reject(how);
    await app.flush(); await app.flush();
  };
  return { app, w, video, m, ev, loaded, button, range, fireRange, bar, tap, settlePlay };
}

test('the element has no native controls; the bar names its controls; nothing seeks before metadata', async (context) => {
  const p = await player(context);
  try {
    assert.equal(p.video().hasAttribute('controls'), false);
    assert.equal(p.video().getAttribute('preload'), 'metadata');
    assert.equal(p.video().hasAttribute('playsinline'), true);
    assert.equal(p.video().getAttribute('src'), 'https://h/dl?path=%2Fa.mp4&stream=1', 'the stream URL is untouched');
    assert.ok(p.button('Play') && p.button('Mute') && p.button('More'));
    assert.equal(p.range().disabled, true, 'NaN duration: nothing to seek');
    assert.equal(p.range().getAttribute('aria-valuetext'), '--:-- of --:--');
    Object.assign(p.m(), { d: Infinity, seek: [] }); p.ev('durationchange'); await p.app.flush();
    assert.equal(p.range().disabled, true, 'Infinity with nothing seekable');
    Object.assign(p.m(), { seek: [[0, 30]] }); p.ev('progress'); await p.app.flush();
    assert.equal(p.range().disabled, false, 'Infinity with seekable');
    assert.equal(p.range().max, '30');
  } finally { await p.app.close(); }
});

test('a drag previews without seeking, ignores timeupdate, commits once; a cancel seeks nothing; a seek may go past the buffer', async (context) => {
  const p = await player(context);
  try {
    await p.loaded(600, [[0, 600]], [[0, 60]]);
    p.fireRange('pointerdown');
    p.range().value = '450'; p.fireRange('input'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'input previews, it does not seek');
    p.m().t = 5; p.ev('timeupdate'); await p.app.flush();
    assert.equal(p.range().valueAsNumber, 450, 'a timeupdate during the drag does not pull the thumb back');
    assert.match(p.app.document.querySelector('.mp-time')!.textContent!, /^7:30 /u, 'the time follows the drag');
    p.fireRange('pointerup'); p.fireRange('change'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [450], 'one seek, into the unbuffered part');
    p.fireRange('pointerdown'); p.range().value = '100'; p.fireRange('input'); p.fireRange('pointercancel'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [450], 'a cancelled drag seeks nothing');
  } finally { await p.app.close(); }
});

test('the keyboard commits on change; the player\'s own arrows do not fire on top', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.range().dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    p.range().value = '1'; p.fireRange('input'); p.fireRange('change'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [1], 'the range\'s step, and no extra +5 s');
  } finally { await p.app.close(); }
});

test('a drag is cancelled by a new source and by hiding; a late release seeks nothing', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.fireRange('pointerdown'); p.range().value = '300'; p.fireRange('input'); await p.app.flush();
    await p.app.setProps({ src: 'https://h/dl?path=%2Fb.mp4&stream=1' });
    p.fireRange('pointerup'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'A\'s release does not seek B');
    await p.loaded();
    p.fireRange('pointerdown'); p.range().value = '200'; p.fireRange('input'); await p.app.flush();
    await p.app.setProps({ visible: false });
    p.fireRange('pointerup'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'hidden mid-drag: nothing sought');
  } finally { await p.app.close(); }
});

test('a tap only shows or hides the controls; a double tap seeks by side and never toggles playback', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.m().t = 100;
    // Play first, so the bar can hide.
    p.button('Play')!.click(); await p.settlePlay(0);
    assert.equal(p.m().paused, false);
    await p.tap(20); await p.app.advance(100); await p.tap(20);
    assert.deepEqual(p.m().seeks, [90], 'left third: -10 s');
    assert.equal(p.m().paused, false, 'the double tap never paused');
    await p.app.advance(300);
    await p.tap(280); await p.app.advance(100); await p.tap(280);
    assert.deepEqual(p.m().seeks, [90, 100], 'right third: +10 s');
    assert.equal(p.m().plays.length, 1, 'no play was asked by a tap');
    await p.app.advance(300);
    await p.tap(20); await p.app.advance(100); await p.tap(280); await p.app.advance(300);
    assert.deepEqual(p.m().seeks, [90, 100], 'a second tap on the OTHER side is not a double tap');
    await p.tap(150); await p.app.advance(100); await p.tap(150); await p.app.advance(300);
    assert.deepEqual(p.m().seeks, [90, 100], 'a double tap in the middle third seeks nothing');
    await p.app.advance(3100);
    const before = p.bar().classList.contains('hidden');
    await p.tap(150); await p.app.advance(300);
    assert.notEqual(p.bar().classList.contains('hidden'), before, 'a single tap toggles the controls');
    assert.equal(p.m().paused, false, 'and nothing else');
    assert.equal(p.m().pauses, 0);
  } finally { await p.app.close(); }
});

test('a tap on the hidden bar shows it, also when the tap is what moves focus into the player', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.settlePlay(0);
    (p.app.document.activeElement as HTMLElement | null)?.blur();
    await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true);
    // A real browser focuses the (focusable) player between pointerdown and
    // pointerup, and the focus pokes the bar shown: the tap still means SHOW.
    const el = p.app.document.querySelector<HTMLElement>('.media-player')!;
    p.video().dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 100 }));
    el.focus();
    p.video().dispatchEvent(new p.w.MouseEvent('pointerup', { bubbles: true, clientX: 150, clientY: 100 }));
    await p.app.flush(); await p.app.advance(300);
    assert.equal(p.bar().classList.contains('hidden'), false, 'one tap shows the bar');
  } finally { await p.app.close(); }
});

test('auto-hide: 3 s into playback; never while paused, dragging, a menu is open, or keyboard focus is in the player', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    assert.equal(p.bar().classList.contains('hidden'), false);
    await p.app.advance(4000);
    assert.equal(p.bar().classList.contains('hidden'), false, 'paused: stays');
    p.button('Play')!.click(); await p.settlePlay(0);
    await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true, 'playing: hides after 3 s');
    assert.ok((p.bar() as HTMLElement & { inert?: boolean }).inert === true || p.bar().hasAttribute('inert'), 'a hidden bar has no activatable control');
    await p.tap(150); await p.app.advance(300);
    assert.equal(p.bar().classList.contains('hidden'), false);
    // A drag holds it.
    p.fireRange('pointerdown'); p.range().value = '10'; p.fireRange('input'); await p.app.flush();
    await p.app.advance(7000);
    assert.equal(p.bar().classList.contains('hidden'), false, 'a drag holds the bar');
    p.fireRange('pointerup'); await p.app.flush();
    // A menu holds it.
    p.button('More')!.click(); await p.app.flush();
    await p.app.advance(7000);
    assert.equal(p.bar().classList.contains('hidden'), false, 'an open menu holds the bar');
    p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await p.app.flush();
    // The pointer resting on the bar holds it.
    p.bar().dispatchEvent(new p.w.Event('pointerenter')); await p.app.flush();
    await p.app.advance(7000);
    assert.equal(p.bar().classList.contains('hidden'), false, 'the pointer on the bar holds it');
    p.bar().dispatchEvent(new p.w.Event('pointerleave')); await p.app.flush();
    // Keyboard focus (the UA's :focus-visible; jsdom has no heuristic, so it is stubbed) holds it.
    const playerEl = p.app.document.querySelector<HTMLElement>('.media-player')!;
    playerEl.matches = ((sel: string) => sel === ':focus-visible') as never;
    await p.app.advance(7000);
    assert.equal(p.bar().classList.contains('hidden'), false, 'keyboard focus on the player holds the bar');
    playerEl.matches = (() => false) as never;
    await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true, 'a mouse-focused player still hides');
    // Waiting shows it.
    p.ev('waiting'); await p.app.flush();
    assert.equal(p.bar().classList.contains('hidden'), false, 'waiting keeps the bar shown');
  } finally { await p.app.close(); }
});

test('the bar\'s touches and taps never reach the picture or a page swipe', async (context) => {
  const p = await player(context);
  try {
    let reached = 0;
    for (const type of ['touchstart', 'touchmove', 'pointerdown', 'pointerup', 'click']) p.w.addEventListener(type, () => { reached++; });
    for (const type of ['touchstart', 'touchmove', 'pointerdown', 'pointerup', 'click']) p.bar().dispatchEvent(new p.w.Event(type, { bubbles: true }));
    assert.equal(reached, 0, 'a touch at x < 40 on the bar never starts Files\' edge swipe');
    // The browser's own sideways swipe (Chrome's overscroll history back) is
    // not an event a handler can stop: the bar takes no horizontal pan.
    const css = readFileSync(new URL('./MediaPlayer.svelte', import.meta.url), 'utf8');
    assert.match(css.match(/\.mp-bar \{[^}]*\}/u)![0], /touch-action: pan-y;/u);
    // Narrow, the time yields its "/ duration" (wrapped onto a hidden line)
    // before any 44px control leaves the bar (rig: 347px at uiZoom 1.2).
    const narrowTime = css.match(/\.narrow \.mp-time \{[^}]*\}/u)![0];
    for (const rule of ['min-width: 0', 'flex-wrap: wrap', 'overflow: hidden', 'height: var(--control-line-height)']) assert.ok(narrowTime.includes(rule), rule);
  } finally { await p.app.close(); }
});

test('errors: unplayable disables play; NotAllowed is shown and play works again; AbortError is silent', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.settlePlay(0, 'NotAllowedError');
    assert.match(p.app.document.querySelector('.mp-error')!.textContent!, /not allowed/u);
    assert.equal(p.button('Play')!.disabled, false, 'another try is open');
    p.button('Play')!.click(); await p.settlePlay(1, 'AbortError');
    assert.equal(p.app.document.querySelector('.mp-error'), null, 'AbortError is silent');
    p.m().err = 4; p.ev('error'); await p.app.flush();
    assert.match(p.app.document.querySelector('.mp-error')!.textContent!, /cannot be played here/u);
    assert.equal(p.button('Play')!.disabled, true);
    assert.equal(p.range().disabled, true);
  } finally { await p.app.close(); }
});

test('R1 pending -> hide -> show -> R2 playing -> R1 resolves: R2 keeps playing; with no R2, R1 is paused (#453 P1-C)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.app.flush();             // R1 pending
    await p.app.setProps({ visible: false }); await p.app.setProps({ visible: true });
    p.button('Play')!.click(); await p.settlePlay(1);            // R2 in effect
    const pausesBefore = p.m().pauses;
    await p.settlePlay(0);                                       // R1 late
    assert.equal(p.m().paused, false, 'R2 is still playing');
    assert.equal(p.m().pauses, pausesBefore, 'R1 never paused it');
    // No R2: R3 pending, hidden, resolves late.
    p.button('Pause')!.click(); await p.app.flush();
    p.button('Play')!.click(); await p.app.flush();             // R3
    await p.app.setProps({ visible: false });
    await p.settlePlay(2);
    assert.equal(p.m().paused, true, 'a late play after the life ended is paused');
    await p.app.setProps({ visible: true });
    assert.equal(p.m().plays.length, 3, 'coming back resumes nothing');
  } finally { await p.app.close(); }
});

test('a play rejected after the player was hidden shows no error, and coming back resumes nothing', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.app.flush();
    await p.app.setProps({ visible: false });
    await p.settlePlay(0, 'NotAllowedError');
    await p.app.setProps({ visible: true });
    assert.equal(p.app.document.querySelector('.mp-error'), null, 'a stale rejection shows no error');
    assert.equal(p.m().plays.length, 1, 'and nothing was asked again');
  } finally { await p.app.close(); }
});

test('fullscreen and PiP: offered by capability; a late request after hide is undone only for THIS player, never a newer one', async (context) => {
  const p = await player(context, {}, { fullscreen: true, pip: true });
  try {
    await p.loaded();
    const fs = () => p.button('Full screen');
    assert.ok(fs(), 'fullscreen offered where the host and the API allow it');
    assert.ok(p.button('Picture in picture'), 'PiP offered by the API');
    // R1 fullscreen pending -> hide -> R1 resolves: exited.
    fs()!.click(); await p.app.flush();
    await p.app.setProps({ visible: false });
    p.w.__fsRequests[0].resolve(); await p.app.flush(); await p.app.flush();
    assert.equal(p.w.__exits.fs, 1, 'the late fullscreen of a retired request is exited');
    await p.app.setProps({ visible: true });
    // R1 pending -> hide -> show -> R2 in effect -> R1 resolves: R2 kept.
    fs()!.click(); await p.app.flush();                          // R1
    await p.app.setProps({ visible: false }); await p.app.setProps({ visible: true });
    fs()!.click(); await p.app.flush();                          // R2
    p.w.__fsRequests[2].resolve(); await p.app.flush();
    const exitsBefore = p.w.__exits.fs;
    p.w.__fsRequests[1].resolve(); await p.app.flush(); await p.app.flush();
    assert.equal(p.w.__exits.fs, exitsBefore, 'R1 never exits R2\'s fullscreen');
    // Another element in fullscreen at life end: left alone.
    p.w.document.exitFullscreen(); await p.app.flush();
    const exits = p.w.__exits.fs;
    p.w.__setFs(p.w.document.createElement('div'));
    await p.app.setProps({ visible: false });
    assert.equal(p.w.__exits.fs, exits, 'another element\'s fullscreen is left alone at life end');
    // Another video in PiP at life end: left alone.
    await p.app.setProps({ visible: true }); p.w.__setFs(null);
    p.w.__setPip(p.w.document.createElement('video'));
    await p.app.setProps({ visible: false });
    assert.equal(p.w.__exits.pip, 0, 'another element\'s PiP is left alone at life end');
    // PiP: a late request after hide is exited.
    await p.app.setProps({ visible: true }); p.w.__setPip(null);
    p.button('Picture in picture')!.click(); await p.app.flush();
    await p.app.setProps({ visible: false });
    p.w.__pipRequests[0].resolve(); await p.app.flush(); await p.app.flush();
    assert.equal(p.w.__exits.pip, 1, 'the late PiP of a retired request is exited');
  } finally { await p.app.close(); }
});

test('fullscreen and PiP stay hidden without the API', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    assert.equal(p.button('Full screen'), null);
    assert.equal(p.button('Picture in picture'), null);
  } finally { await p.app.close(); }
});

test('the player\'s keys act only on the container, never with modifiers or while composing', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.m().t = 100;
    const el = p.app.document.querySelector<HTMLElement>('.media-player')!;
    const key = (init: KeyboardEventInit, target: Element = el) => target.dispatchEvent(new p.w.KeyboardEvent('keydown', { bubbles: true, ...init }));
    key({ key: 'ArrowRight', ctrlKey: true }); key({ key: 'ArrowRight', isComposing: true }); key({ key: 'ArrowRight' }, p.button('Mute')!);
    await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'modifiers, IME and a child target are not the player\'s');
    key({ key: 'ArrowRight' }); key({ key: 'm' }); await p.app.flush();
    assert.deepEqual(p.m().seeks, [105]);
    assert.equal(p.m().muted, true);
    key({ key: ' ' }); await p.app.flush();
    assert.equal(p.m().plays.length, 1, 'Space plays');
  } finally { await p.app.close(); }
});

test('a network error retries by re-opening the file as one intent; another file meanwhile drops it', async (context) => {
  let opens = 0;
  let release!: (url: string) => void;
  const p = await player(context, { reopen: () => { opens++; return new Promise<string>((r) => { release = r; }); } });
  try {
    await p.loaded();
    p.m().err = 2; p.ev('error'); await p.app.flush();
    assert.equal(p.button('Play')!.disabled, false);
    p.button('Play')!.click(); await p.app.flush();
    assert.equal(opens, 1, 'Play re-opens the file');
    release('https://h/dl?path=%2Fa.mp4&exp=99&stream=1'); await p.app.flush(); await p.app.flush();
    assert.equal(p.video().getAttribute('src'), 'https://h/dl?path=%2Fa.mp4&exp=99&stream=1', 'the fresh signature');
    assert.equal(p.m().plays.length, 1, 'and it plays');
    // Again, but another file is chosen while the re-open is pending.
    p.m().err = 2; p.ev('error'); await p.app.flush();
    p.button('Play')!.click(); await p.app.flush();
    await p.app.setProps({ src: 'https://h/dl?path=%2Fb.mp4&stream=1' });
    release('https://h/dl?path=%2Fa.mp4&exp=100&stream=1'); await p.app.flush(); await p.app.flush();
    assert.equal(p.video().getAttribute('src'), 'https://h/dl?path=%2Fb.mp4&stream=1', 'the other file stays');
    assert.equal(p.m().plays.length, 1, 'and nothing plays');
  } finally { await p.app.close(); }
});

test('audio: the bar is always shown and there is no picture to tap', async (context) => {
  const p = await player(context, { kind: 'audio', src: 'https://h/dl?path=%2Fs.mp3&stream=1' });
  try {
    await p.loaded(180);
    assert.equal(p.video().tagName, 'AUDIO');
    p.button('Play')!.click(); await p.settlePlay(0);
    await p.app.advance(5000);
    assert.equal(p.bar().classList.contains('hidden'), false);
    assert.equal(p.button('Full screen'), null);
  } finally { await p.app.close(); }
});

// ---- #453 review round 4 (P1-A/B/C, P2) ----

test('an old finger that keeps dragging after a new source or a hide seeks nothing, not even on the next file (#453 review P1-A)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.fireRange('pointerdown'); p.range().value = '300'; p.fireRange('input'); await p.app.flush();
    await p.app.setProps({ src: 'https://h/dl?path=%2Fb.mp4&stream=1' });
    await p.loaded();
    p.range().value = '320'; p.fireRange('input'); await p.app.flush();
    assert.equal(p.app.document.querySelector('.mp-time')!.textContent, '0:00 / 10:00', 'the old finger previews nothing on B');
    // Its capture is lost while it is still held (review round 5): its next
    // input and change are still its own, not a new AT adjust on B.
    p.fireRange('lostpointercapture');
    p.range().value = '340'; p.fireRange('input'); p.fireRange('change'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'a lost capture does not turn the held finger into an AT adjust');
    p.fireRange('change'); p.fireRange('pointerup'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'and its release does not seek B');
    // Hide -> show while the same finger keeps going.
    p.fireRange('pointerdown'); p.range().value = '200'; p.fireRange('input'); await p.app.flush();
    await p.app.setProps({ visible: false }); await p.app.setProps({ visible: true });
    p.range().value = '250'; p.fireRange('input'); p.fireRange('pointerup'); p.fireRange('change'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'a drag from before the hide is dead after the show');
    // A new gesture works.
    p.fireRange('pointerdown'); p.range().value = '100'; p.fireRange('input'); p.fireRange('pointerup'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [100]);
  } finally { await p.app.close(); }
});

test('a closed gate refuses every forward entry; reopened while mounted, the old menu and gestures are gone (#453 review P1-B)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.m().t = 100;
    const el = p.app.document.querySelector<HTMLElement>('.media-player')!;
    const key = (k: string) => el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    p.button('More')!.click(); await p.app.flush();
    const oldItem = p.app.document.querySelector<HTMLButtonElement>('.menu-item');
    assert.ok(oldItem, 'the menu is open');
    p.video().dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true, clientX: 280, clientY: 100 }));
    await p.app.setProps({ visible: false });
    assert.equal(p.app.document.querySelector('.menu-item'), null, 'the end of life closes the menu');
    key(' '); key('ArrowRight'); key('m');
    p.button('Play')!.click();
    await p.app.flush();
    assert.equal(p.m().plays.length, 0, 'no play while the gate is closed');
    assert.deepEqual(p.m().seeks, [], 'no seek');
    assert.equal(p.m().muted, false, 'no mute');
    p.button('More')!.click(); await p.app.flush();
    assert.equal(p.app.document.querySelector('.menu-item'), null, 'no menu');
    await p.app.setProps({ visible: true });
    // The picture's pointerdown from before the hide is not half of a tap now.
    p.video().dispatchEvent(new p.w.MouseEvent('pointerup', { bubbles: true, clientX: 280, clientY: 100 }));
    await p.app.advance(100);
    p.video().dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true, clientX: 280, clientY: 100 }));
    p.video().dispatchEvent(new p.w.MouseEvent('pointerup', { bubbles: true, clientX: 280, clientY: 100 }));
    await p.app.advance(300);
    assert.deepEqual(p.m().seeks, [], 'an old pointerdown plus a new tap is not a double tap');
    oldItem!.click(); await p.app.flush();
    assert.equal(p.video().playbackRate, 1, 'the old menu\'s item does nothing');
    p.button('Play')!.click(); await p.settlePlay(0);
    assert.equal(p.m().paused, false, 'the reopened gate plays on a new request');
  } finally { await p.app.close(); }
});

test('a menu open on one file is gone on the next; a choice there never changes the new media (#453 review P1-B)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('More')!.click(); await p.app.flush();
    const item = [...p.app.document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('2'))!;
    await p.app.setProps({ src: 'https://h/dl?path=%2Fb.mp4&stream=1' });
    assert.equal(p.app.document.querySelector('.menu-item'), null);
    item.click(); await p.app.flush();
    assert.equal(p.video().playbackRate, 1);
  } finally { await p.app.close(); }
});

test('keys and the double tap obey the range\'s limits: nothing to seek before metadata or on an unplayable file (#453 review P1-B)', async (context) => {
  const p = await player(context);
  try {
    const el = p.app.document.querySelector<HTMLElement>('.media-player')!;
    el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await p.tap(280); await p.app.advance(100); await p.tap(280); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'no metadata yet: no seek');
    await p.loaded();
    p.m().err = 4; p.ev('error'); await p.app.flush();
    el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await p.app.advance(300); await p.tap(20); await p.app.advance(100); await p.tap(20); await p.app.flush();
    assert.deepEqual(p.m().seeks, [], 'unplayable: no seek');
  } finally { await p.app.close(); }
});

test('the error table: playing -> network error is ONE click to retry; playing -> fatal shows a disabled Play, never Pause (#453 review P1-C)', async (context) => {
  let opens = 0;
  const p = await player(context, { reopen: async () => { opens++; return 'https://h/dl?path=%2Fa.mp4&exp=99&stream=1'; } });
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.settlePlay(0);
    assert.ok(p.button('Pause'));
    p.m().err = 2; p.ev('error'); await p.app.flush();
    assert.equal(p.button('Pause'), null, 'an error is never "playing"');
    p.button('Play')!.click(); await p.app.flush(); await p.app.flush();
    assert.equal(opens, 1, 'the first click is the retry');
    assert.equal(p.m().pauses, 0, 'not a pause');
    // playing -> fatal
    await p.settlePlay(1);
    p.m().err = null; p.ev('playing'); await p.app.flush();
    assert.ok(p.button('Pause'));
    p.m().err = 3; p.ev('error'); await p.app.flush();
    assert.equal(p.button('Pause'), null);
    assert.equal(p.button('Play')!.disabled, true, 'a disabled Play');
  } finally { await p.app.close(); }
});

test('the error table: fatal -> emptied -> metadata plays again; waiting -> pause is paused, not waiting (#453 review P1-C)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.m().err = 4; p.ev('error'); await p.app.flush();
    assert.equal(p.button('Play')!.disabled, true);
    p.m().err = null; p.ev('emptied'); await p.loaded();
    assert.equal(p.app.document.querySelector('.mp-error'), null, 'a new load forgets the old source\'s error');
    assert.equal(p.button('Play')!.disabled, false);
    assert.equal(p.range().disabled, false);
    p.button('Play')!.click(); await p.settlePlay(0);
    p.ev('waiting'); await p.app.flush();
    assert.ok(p.app.document.querySelector('.media-range.waiting'), 'waiting while playing');
    p.button('Pause')!.click(); await p.app.flush();
    assert.ok(p.button('Play'), 'paused');
    assert.equal(p.app.document.querySelector('.media-range.waiting'), null, 'a paused element is not waiting');
  } finally { await p.app.close(); }
});

test('focus leaving the player kills the open drag: the same finger seeks nothing after (#453 review P1-A)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    const outside = p.app.document.createElement('button'); p.app.document.body.append(outside);
    p.fireRange('pointerdown'); p.range().value = '300'; p.fireRange('input'); await p.app.flush();
    p.range().dispatchEvent(new p.w.FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await p.app.flush();
    p.range().value = '310'; p.fireRange('input'); p.fireRange('pointerup'); p.fireRange('change'); await p.app.flush();
    assert.deepEqual(p.m().seeks, []);
  } finally { await p.app.close(); }
});

test('the auto-hide hands a pressed control\'s focus to the player, so inert never drops it to the page (validator V2)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.settlePlay(0);
    p.button('Mute')!.focus();
    await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true, 'hidden at 3 s');
    assert.equal(p.app.document.activeElement, p.app.document.querySelector('.media-player'), 'focus is on the player, not the page');
    await p.app.advance(500);
    assert.equal(p.bar().classList.contains('hidden'), true, 'and it stays hidden: no focusout re-shows it');
  } finally { await p.app.close(); }
});

test('a press on a bar control restarts the countdown; Tab from the player into a hidden bar lands on its first control (validator V2/V3)', async (context) => {
  const p = await player(context);
  try {
    await p.loaded();
    p.button('Play')!.click(); await p.settlePlay(0);
    await p.app.advance(2500);
    p.bar().dispatchEvent(new p.w.Event('pointerdown', { bubbles: true })); await p.app.flush();
    await p.app.advance(2500);
    assert.equal(p.bar().classList.contains('hidden'), false, 'pressed at 2.5 s: still shown at 5 s');
    await p.app.advance(600);
    assert.equal(p.bar().classList.contains('hidden'), true);
    // The player holds (mouse) focus while the bar hides, as after a click on the picture.
    const el = p.app.document.querySelector<HTMLElement>('.media-player')!;
    el.focus(); await p.app.flush(); await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true);
    el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    assert.equal(p.bar().hasAttribute('inert') || (p.bar() as HTMLElement & { inert?: boolean }).inert === true, false, 'inert is lifted before the browser moves focus');
    assert.equal(p.bar().classList.contains('hidden'), false);
    // And focusable at once in a real browser: a visibility TRANSITION from
    // hidden starts at hidden, so Tab skipped the bar on the rig (Chrome 152).
    const css = readFileSync(new URL('./MediaPlayer.svelte', import.meta.url), 'utf8');
    assert.match(css, /\.mp-bar \{[^}]*transition: opacity var\(--t-fast\), visibility 0s;/u, 'showing: visibility is instant');
    assert.match(css, /\.mp-bar\.hidden \{[^}]*visibility 0s var\(--t-fast\)/u, 'hiding: visible until the fade ends');
  } finally { await p.app.close(); }
});

test('the narrow/wide switch mid-drag destroys the range: its drag is retired, so the time and the auto-hide are free again (review P2 after #453)', async (context) => {
  // jsdom has no layout: the player's width and the size observer are driven by hand.
  const p = await player(context, {}, {}, (win: any) => {
    win.__width = 800;
    const observers: { cb: (entries: { target: Element }[]) => void; els: Element[] }[] = [];
    win.ResizeObserver = class { cb: any; els: Element[] = []; constructor(cb: any) { this.cb = cb; observers.push(this); } observe(el: Element) { this.els.push(el); } unobserve() {} disconnect() {} };
    Object.defineProperty(win.HTMLDivElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('media-player') ? win.__width : 0; } });
    win.__resize = () => { for (const o of observers) o.cb(o.els.map((target) => ({ target }))); };
  });
  try {
    await p.loaded();
    assert.equal(p.bar().classList.contains('narrow'), false, 'wide: one row');
    p.button('Play')!.click(); await p.settlePlay(0);
    const wideRange = p.range();
    p.fireRange('pointerdown'); wideRange.value = '300'; p.fireRange('input'); await p.app.flush();
    assert.match(p.app.document.querySelector('.mp-time')!.textContent!, /^5:00 /u, 'the drag previews');
    p.w.__width = 400; p.w.__resize(); await p.app.flush();
    assert.equal(p.bar().classList.contains('narrow'), true, 'narrow: the range moved to its own row');
    assert.notEqual(p.range(), wideRange, 'a new range instance');
    assert.match(p.app.document.querySelector('.mp-time')!.textContent!, /^0:00 /u, 'the old drag\'s preview is gone');
    await p.app.advance(3100);
    assert.equal(p.bar().classList.contains('hidden'), true, 'and it no longer holds the bar');
    assert.deepEqual(p.m().seeks, [], 'nothing was sought');
    // The new range works on its own.
    await p.tap(150); await p.app.advance(300);
    p.fireRange('pointerdown'); p.range().value = '120'; p.fireRange('input'); p.fireRange('pointerup'); await p.app.flush();
    assert.deepEqual(p.m().seeks, [120]);
  } finally { await p.app.close(); }
});
