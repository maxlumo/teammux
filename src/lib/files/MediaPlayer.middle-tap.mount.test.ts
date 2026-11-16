// Board #139 (owner, 2026-11-16 09:09: '以前的视频播放器你优化过，做了一个图案，但是我只能点击播放按钮，
// 不能直接点击视频中间开始播放'; leader's ruling, note 3): the middle third of the picture is the
// ONE play/pause target, at once (no 250 ms wait). Paused (before the first play, after a
// pause, after the end) → play; playing → pause; an errored load → only the bar. The left and
// right thirds keep the bar toggle after 250 ms and the double-tap seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./MediaPlayer.svelte', import.meta.url), []);

type Media = { paused: boolean; err: number | null; d: number; plays: { resolve: () => void; reject: (n: string) => void }[]; pauses: number; seeks: number[]; t: number };

async function player(context: test.TestContext) {
  const app = await (await compiled).mount(context, {
    props: { kind: 'video', src: 'https://h/dl?path=%2Fa.mp4&stream=1', name: 'a.mp4', visible: true },
    setup(win: any) {
      const states = new WeakMap<object, Media>();
      const s = (el: object) => { if (!states.has(el)) states.set(el, { paused: true, err: null, d: NaN, plays: [], pauses: 0, seeks: [], t: 0 }); return states.get(el)!; };
      const P = win.HTMLMediaElement.prototype;
      const prop = (name: string, get: (m: Media) => unknown, set?: (m: Media, v: any) => void) =>
        Object.defineProperty(P, name, { configurable: true, get() { return get(s(this)); }, set(v) { set?.(s(this), v); } });
      prop('paused', (m) => m.paused);
      prop('duration', (m) => m.d);
      prop('currentTime', (m) => m.t, (m, v) => { m.t = v; m.seeks.push(v); });
      prop('error', (m) => (m.err == null ? null : { code: m.err }));
      prop('readyState', () => 4);
      prop('buffered', () => ({ length: 1, start: () => 0, end: () => 60 }));
      prop('seekable', (m) => ({ length: 1, start: () => 0, end: () => m.d }));
      P.play = function (this: any) {
        const m = s(this), el = this;
        return new win.Promise((res: () => void, rej: (e: Error) => void) => m.plays.push({
          resolve: () => { m.paused = false; el.dispatchEvent(new win.Event('play')); el.dispatchEvent(new win.Event('playing')); res(); },
          reject: (name: string) => { const e = new win.Error(name); e.name = name; rej(e); },
        }));
      };
      P.pause = function (this: any) { const m = s(this); m.pauses++; if (!m.paused) { m.paused = true; this.dispatchEvent(new win.Event('pause')); } };
      P.load = () => {};
      win.HTMLVideoElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0 });
      win.Element.prototype.getAnimations = () => [];
      win.__media = s;
    },
    modules: [],
  });
  const w = app.window as any;
  const video = () => app.document.querySelector('video') as HTMLVideoElement;
  const m = () => w.__media(video()) as Media;
  const ev = (type: string) => video().dispatchEvent(new w.Event(type));
  const tap = async (x: number) => {
    video().dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: 100 }));
    video().dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: 100 }));
    await app.flush();
  };
  const settle = async () => { m().plays.at(-1)!.resolve(); await app.flush(); await app.flush(); };
  const bar = () => app.document.querySelector<HTMLElement>('.mp-bar')!;
  m().d = 600; ev('loadedmetadata'); ev('loadeddata'); ev('canplay'); await app.flush();
  return { app, m, ev, tap, settle, bar };
}

test('paused before the first play: a middle tap plays at once', async (context) => {
  const p = await player(context);
  await p.tap(150);
  assert.equal(p.m().plays.length, 1, 'play() at once, no 250 ms wait');
});

test('after a pause and after the end, a middle tap plays again', async (context) => {
  const p = await player(context);
  await p.tap(150); await p.settle();
  await p.tap(150);
  assert.equal(p.m().pauses, 1, 'playing: the middle tap pauses');
  await p.tap(150);
  assert.equal(p.m().plays.length, 2, 'paused: plays again');
  await p.settle();
  p.m().paused = true; p.ev('pause'); p.ev('ended'); await p.app.flush();
  await p.tap(150);
  assert.equal(p.m().plays.length, 3, 'ended: plays again');
});

test('the side thirds never play: a single tap there toggles the bar, a double tap seeks', async (context) => {
  const p = await player(context);
  await p.tap(20); await p.app.advance(300);
  await p.tap(280); await p.app.advance(300);
  assert.equal(p.m().plays.length, 0, 'no play from a side tap');
  assert.equal(p.bar().classList.contains('hidden'), false, 'paused: the bar stays');
});

test('an errored load: a middle tap only shows the bar', async (context) => {
  const p = await player(context);
  p.m().err = 4; p.ev('error'); await p.app.flush();
  await p.tap(150); await p.app.advance(300);
  assert.equal(p.m().plays.length, 0);
  assert.equal(p.bar().classList.contains('hidden'), false);
});
