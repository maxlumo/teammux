// The status corner's ownership (board #335 ③c-5; reviewer P1-C2 on
// 018d4fa5): a reading belongs to the handle that asked for it. A late answer
// after the owner changed, or after the component is gone, writes nothing.
// The App tests cover the live shapes (A late over B; A→B→A fast); this one
// pins the unmount case the App harness cannot observe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

let compiled: ReturnType<typeof compileMount> | undefined;
const fixture = () => compiled ??= compileMount(new URL('./SystemStatus.test.svelte', import.meta.url), []);
const until = async (app: { flush: () => Promise<void> }, ok: () => boolean, n = 30) => { for (let i = 0; i < n && !ok(); i++) await app.flush(); };

test('a late answer after UNMOUNT writes nothing; a late answer of a replaced same-id handle is dropped', { timeout: 60000 }, async (context) => {
  const f = await fixture();
  const app = await f.mount(context, { modules: [], setup(w) { w.Element.prototype.getAnimations = () => []; } });
  try {
    const sys = app.window.__sys as { owner: unknown; tag: string; mounted: boolean; release(all?: boolean): void; pending: number };
    const vitals = () => app.document.querySelector('.sysvitals')?.textContent ?? '';
    await until(app, () => sys.pending >= 1);
    sys.release();
    await until(app, () => vitals() !== '');
    assert.match(vitals(), /10/u, `A s reading: ${vitals()}`);
    assert.equal(app.document.querySelector('.sysvitals .server-tag')?.textContent, 'alpha', 'named beside the number');
    // A fresh handle for the SAME id (a reconnect replaced the runtime): the
    // old reading goes, the request in flight on the old handle is dropped.
    context.mock.timers.tick(20_000);
    await until(app, () => sys.pending >= 1);
    const stale = sys.pending;
    sys.owner = { id: 'a' };
    await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'a new handle: no reading until it answers');
    assert.ok(sys.pending > stale, 'the new handle asked at once');
    sys.release(false);                         // the OLD handle s answer lands first
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'the old handle s late answer is dropped');
    sys.release();
    await until(app, () => vitals() !== '');
    assert.match(vitals(), /10/u, 'the new handle s answer lands');
    // Unmount with a request in flight; its answer arrives after.
    context.mock.timers.tick(20_000);
    await until(app, () => sys.pending >= 1);
    sys.mounted = false;
    await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'gone');
    sys.release();
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'nothing is written into a destroyed corner (no error either)');
  } finally {
    await app.unmount();
  }
});

// Board #102 (owner 2026-11-10 17:15: "系统资源状态那里如果是我们这种gpu机器要显示状态 显存利用率"): the GPU is
// in the strip in place of DISK (24 px x 201 px hold three: leader note 5), VRAM only; DISK and the
// utilization are the hover card's, one line per GPU; without one the corner is today's three.
let gpuCompiled: ReturnType<typeof compileMount> | undefined;
const gpuFixture = () => gpuCompiled ??= compileMount(new URL('./SystemStatusGpu.test.svelte', import.meta.url), []);
const G = 1024 ** 3;
const LONG = 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition';
const base = { cpu_pct: 12, mem_used: 11 * G, mem_total: 60 * G, disk_used: 900 * G, disk_total: 1900 * G };

for (const [label, reading, parts, ...rest] of [
  ['no GPU', { ...base, gpu: null, gpus: null }, ['CPU', 'MEM', 'DISK'], '', []],
  ['one GPU', { ...base, gpu: { name: 'NVIDIA L4', count: 1, util_pct: 100, mem_used: 16 * G, mem_total: 22 * G }, gpus: [{ name: 'NVIDIA L4', util_pct: 100, mem_used: 16 * G, mem_total: 22 * G }] }, ['CPU', 'MEM', 'GPU'],
    '73%', [['GPU', '100.0% · 16.00/22.00G (73%) · NVIDIA L4']]],
  // Two cards with the SAME name (validator note 19: one shared label made the card's keyed rows collide,
  // each_key_duplicate, and the card never opened): each line is named by its position in the reading.
  ['two identical GPUs', { ...base, gpu: { name: 'NVIDIA L4', count: 2, util_pct: 90, mem_used: 14 * G, mem_total: 44 * G }, gpus: [{ name: 'NVIDIA L4', util_pct: 90, mem_used: 10 * G, mem_total: 22 * G }, { name: 'NVIDIA L4', util_pct: 10, mem_used: 4 * G, mem_total: 22 * G }] }, ['CPU', 'MEM', 'GPU'],
    '32%', [['GPU 0', '90.0% · 10.00/22.00G (45%) · NVIDIA L4'], ['GPU 1', '10.0% · 4.00/22.00G (18%) · NVIDIA L4']]],
  // A long model name (validator note 31: 53 chars pushed the numbers past the card's ellipsis): the
  // numbers come first, so the shared InfoRows ellipsis can only eat the name's tail (leader note 33).
  ['two long-named GPUs', { ...base, gpu: { name: LONG, count: 2, util_pct: 100, mem_used: 50 * G, mem_total: 190 * G }, gpus: [{ name: LONG, util_pct: 100, mem_used: 48 * G, mem_total: 95 * G }, { name: LONG, util_pct: 3, mem_used: 2 * G, mem_total: 95 * G }] }, ['CPU', 'MEM', 'GPU'],
    '26%', [['GPU 0', `100.0% · 48.00/95.00G (51%) · ${LONG}`], ['GPU 1', `3.0% · 2.00/95.00G (2%) · ${LONG}`]]],
] as const) {
  const [strip, gpuRows] = rest;
  // Touch (round 4, reviewer note 42): no hover card there, so the drawer's strip keeps DISK and adds the GPU.
  test(`on touch the strip with ${label} keeps DISK (#102)`, { timeout: 60000 }, async (context) => {
    const f = await gpuFixture();
    const app = await f.mount(context, { modules: [], setup(w) {
      w.Element.prototype.getAnimations = () => [];
      w.localStorage.setItem('tmux_layout_mode', 'mobile');
    } });
    try {
      (app.window as unknown as { __gpu: { reading: unknown } }).__gpu.reading = reading;
      context.mock.timers.tick(20_000);
      await until(app, () => !!app.document.querySelector('.sysvitals'));
      const sv = [...app.document.querySelectorAll<HTMLElement>('.sysvitals .sv')];
      const gpu = (parts as readonly string[]).includes('GPU');
      assert.deepEqual(sv.map((e) => e.querySelector('.sv-k')?.textContent), gpu ? ['CPU', 'MEM', 'DISK', 'GPU'] : ['CPU', 'MEM', 'DISK']);
      if (gpu) assert.equal(sv[3]!.querySelector('.sv-v')?.textContent, strip);
    } finally { await app.unmount(); }
  });
  test(`the strip with ${label}: its metrics in order, the GPU with its own dot (#102)`, { timeout: 60000 }, async (context) => {
    const f = await gpuFixture();
    const app = await f.mount(context, { modules: [], setup(w) {
      w.Element.prototype.getAnimations = () => [];
      w.localStorage.setItem('tmux_layout_mode', 'desktop'); // a pointer device: the hover card opens
    } });
    try {
      (app.window as unknown as { __gpu: { reading: unknown } }).__gpu.reading = reading;
      context.mock.timers.tick(20_000);
      await until(app, () => !!app.document.querySelector('.sysvitals'));
      const sv = [...app.document.querySelectorAll<HTMLElement>('.sysvitals .sv')];
      assert.deepEqual(sv.map((e) => e.querySelector('.sv-k')?.textContent), parts);
      if ((parts as readonly string[]).includes('GPU')) {
        assert.ok(sv[2]!.classList.contains('gpu'), 'its own category class');
        assert.equal(sv[2]!.querySelector('.sv-v')?.textContent, strip);
        // The hover card: one line per GPU, spelled out.
        const enter = new app.window.Event('pointerenter');
        Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
        app.document.querySelector('.sysvitals')!.dispatchEvent(enter);
        context.mock.timers.tick(500);
        await until(app, () => !!app.document.querySelector('.hover-card'));
        const hc = app.document.querySelector('.hover-card')!;
        const dt = [...hc.querySelectorAll('dt')].map((e) => e.textContent);
        const dd = [...hc.querySelectorAll('dd')].map((e) => e.textContent);
        assert.ok(dt.some((t) => /Disk|磁盘/u.test(t ?? '')), `DISK is in the card: ${dt}`);
        assert.deepEqual(dt.slice(-gpuRows!.length).map((t, i) => [t, dd.at(-gpuRows!.length + i)]), gpuRows, 'one line per GPU');
        for (const v of dd.slice(-gpuRows!.length)) {
          const name = (reading as unknown as { gpus: { name: string }[] }).gpus[0]!.name;
          assert.ok(/^\d/u.test(v ?? '') && v!.indexOf('%') < v!.indexOf(name), `the numbers precede the name: ${v}`);
        }
      } else {
        assert.equal(app.document.querySelector('.sv.gpu'), null, 'no GPU: nothing new in the corner');
      }
    } finally { await app.unmount(); }
  });
}

// Board #103 (leader note 13): a server name puts itself on row 1 and the readings on row 2, on every
// layout, GPU or not; Single (no name) is one row. The strip reports its row count to its host (App
// reserves the bar's height from it, desktop sidebars and the phone drawer alike).
for (const [label, reading, mode, tag, rows] of [
  ['touch, a GPU', { ...base, gpu: { name: 'NVIDIA L4', count: 1, util_pct: 100, mem_used: 16 * G, mem_total: 22 * G }, gpus: null }, 'mobile', 'remote-a', 2],
  ['touch, no GPU', { ...base, gpu: null, gpus: null }, 'mobile', 'remote-a', 2],
  ['desktop, no GPU', { ...base, gpu: null, gpus: null }, 'desktop', 'remote-a', 2],
  ['desktop, Single', { ...base, gpu: null, gpus: null }, 'desktop', null, 1],
] as const) {
  test(`${label}: the strip is ${rows} row(s) (#103)`, { timeout: 60000 }, async (context) => {
    const f = await gpuFixture();
    const app = await f.mount(context, { modules: [], setup(w) {
      w.Element.prototype.getAnimations = () => [];
      w.localStorage.setItem('tmux_layout_mode', mode);
    } });
    try {
      const host = (app.window as unknown as { __gpu: { reading: unknown; tag: unknown; rows: number } }).__gpu;
      host.tag = tag;
      host.reading = reading;
      context.mock.timers.tick(20_000);
      await until(app, () => !!app.document.querySelector('.sysvitals'));
      const v = app.document.querySelector<HTMLElement>('.sysvitals')!;
      // The readings are ONE line (validator note 82: a wrapping flex row let the worst reading's GPU part
      // fall to a third line); the tag is the line above it.
      const kids = [...v.children].map((e) => e.classList.contains('server-tag') ? 'tag' : e.classList.contains('sv-line') ? [...e.querySelectorAll('.sv-k')].map((k) => k.textContent) : '?');
      const readings = mode === 'mobile' && reading.gpu ? ['CPU', 'MEM', 'DISK', 'GPU'] : mode === 'mobile' ? ['CPU', 'MEM', 'DISK'] : reading.gpu ? ['CPU', 'MEM', 'GPU'] : ['CPU', 'MEM', 'DISK'];
      assert.deepEqual(kids, [...(tag ? ['tag'] : []), readings]);
      assert.equal(v.classList.contains('two-rows'), rows === 2);
      assert.equal(host.rows, rows, 'the host is told the row count');
    } finally { await app.unmount(); }
  });
}

// Validator, #103 note 16: a reading with nothing to show (every value unavailable) draws no strip, so
// with a server name the host is told ONE row (its bar stays 24 px), never a blank 48.
test('a named reading with nothing to show draws no strip and reports one row (#103)', { timeout: 60000 }, async (context) => {
  const f = await gpuFixture();
  const app = await f.mount(context, { modules: [], setup(w) {
    w.Element.prototype.getAnimations = () => [];
    w.localStorage.setItem('tmux_layout_mode', 'desktop');
  } });
  try {
    const host = (app.window as unknown as { __gpu: { reading: unknown; tag: unknown; rows: number } }).__gpu;
    host.tag = 'a';
    host.reading = { cpu_pct: null, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0, gpu: null, gpus: null };
    context.mock.timers.tick(20_000);
    for (let i = 0; i < 20; i++) await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'nothing drawn');
    assert.equal(host.rows, 1, 'the host is told one row');
  } finally { await app.unmount(); }
});

// Board #124 (leader notes 14, 17): under a finger in the DESKTOP layout (a foldable's inner screen) the strip
// keeps its desktop form, CPU MEM GPU, and DISK stays on the card; a finger cannot hover, so a TAP opens the
// card the strip declares tap-free, and the next press anywhere else closes it. No touch screen: a click is a
// click and opens nothing.
for (const touch of [true, false]) {
  test(`desktop layout, ${touch ? 'a touch screen: a tap opens the strip\'s card' : 'no touch screen: a click opens nothing'} (#124)`, { timeout: 60000 }, async (context) => {
    const f = await gpuFixture();
    const app = await f.mount(context, { modules: [], setup(w) {
      w.Element.prototype.getAnimations = () => [];
      w.localStorage.setItem('tmux_layout_mode', 'desktop');
      // jsdom's window has `ontouchstart`, i.e. a touch screen; a mouse-only computer has not.
      if (!touch) delete (w as { ontouchstart?: unknown }).ontouchstart;
    } });
    try {
      (app.window as unknown as { __gpu: { reading: unknown } }).__gpu.reading = { ...base, gpu: { name: 'NVIDIA L4', count: 1, util_pct: 100, mem_used: 16 * G, mem_total: 22 * G }, gpus: null };
      context.mock.timers.tick(20_000);
      await until(app, () => !!app.document.querySelector('.sysvitals'));
      assert.deepEqual([...app.document.querySelectorAll('.sysvitals .sv-k')].map((e) => e.textContent), ['CPU', 'MEM', 'GPU'], 'the desktop form');
      app.document.querySelector<HTMLElement>('.sysvitals')!.click();
      await app.flush(); await app.flush();
      if (!touch) { assert.equal(app.document.querySelector('.hover-card'), null); return; }
      const hc = app.document.querySelector('.hover-card');
      assert.ok(hc, 'the tap opened the card');
      assert.ok([...hc!.querySelectorAll('dt')].some((t) => /Disk|磁盘/u.test(t.textContent ?? '')), 'DISK is reachable by touch');
      app.document.body.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
      await app.flush(); await app.flush();
      assert.equal(app.document.querySelector('.hover-card'), null, 'a press elsewhere closed it');
    } finally { await app.unmount(); }
  });
}

// Board #124 note 26 (validator, real Chromium finger): a tap is pointerdown, pointerup, pointerLEAVE (the finger
// lifted), then click. The leave of a lifted finger is not the pointer moving away, so it must not close the card
// the tap opened; else the second tap's click finds it closed and opens it again instead of closing it.
test('desktop layout under a finger: the second tap on the strip closes its card; Escape-free, in the real event order (#124)', { timeout: 60000 }, async (context) => {
  const f = await gpuFixture();
  const app = await f.mount(context, { modules: [], setup(w) {
    w.Element.prototype.getAnimations = () => [];
    w.localStorage.setItem('tmux_layout_mode', 'desktop');
  } });
  try {
    (app.window as unknown as { __gpu: { reading: unknown } }).__gpu.reading = { ...base, gpu: null, gpus: null };
    context.mock.timers.tick(20_000);
    await until(app, () => !!app.document.querySelector('.sysvitals'));
    const strip = app.document.querySelector<HTMLElement>('.sysvitals')!;
    const touch = (type: string, Ctor: typeof Event = app.window.Event) => {
      const e = new Ctor(type, { bubbles: type !== 'pointerleave', cancelable: true });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      strip.dispatchEvent(e);
    };
    const tap = async () => {
      touch('pointerdown'); touch('pointerup'); touch('pointerleave'); touch('click', app.window.MouseEvent as unknown as typeof Event);
      await app.flush(); await app.flush();
    };
    await tap();
    assert.ok(app.document.querySelector('.hover-card'), 'the first tap opened the card, and the lifted finger\u2019s leave kept it');
    await tap();
    assert.equal(app.document.querySelector('.hover-card'), null, 'the second tap closed it');
    await tap();
    assert.ok(app.document.querySelector('.hover-card'), 'a third opens it again');
    // Closed by the card's own dismissals (a key, a scroll, a resize), the next tap OPENS it: the strip asks
    // the one card what is on screen, it does not trust its own memory of having opened it.
    for (const close of ['keydown', 'scroll', 'resize']) {
      app.window.dispatchEvent(new app.window.Event(close));
      await app.flush(); await app.flush();
      assert.equal(app.document.querySelector('.hover-card'), null, `${close} closed it`);
      await tap();
      assert.ok(app.document.querySelector('.hover-card'), `after ${close}, one tap opens it`);
    }
  } finally { await app.unmount(); }
});
