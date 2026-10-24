import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileMount } from '../test/mount.ts';
import { feedBlocks } from './hub.ts';

// Board #461: the turn rail wired into the Feed. jsdom has no layout, so the
// geometry the browser would measure is stated here (the band, the asks' natural
// tops, the feed's scroll size); the real pixels are the Chromium measurements
// on the issue. What is pinned is the WIRING: which turn a pointer names, where
// the ONE jump lands, and what a retirement leaves behind.
const compiled = compileMount(new URL('./TurnRail.test.svelte', import.meta.url), []);

// The dwell is the CSS token, defined once in app.css; the rail reads it from computed style, so the
// fixture hands the same text to jsdom instead of repeating the figure.
const DWELL_TOKEN = /--turn-rail-dwell:\s*([^;]+);/u.exec(readFileSync(new URL('../../app.css', import.meta.url), 'utf8'))![1]!;
const DWELL = Number.parseFloat(DWELL_TOKEN) * (DWELL_TOKEN.trim().endsWith('ms') ? 1 : 1000);
/** The rail's inert column (the reveal zone): x 346..390, y 70..660, beside the 100..400 band. */
const COLUMN = { left: 346, top: 70, right: 390, bottom: 660 };

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
/** A rail at the RIGHT edge of a 390px screen. */
const BAND0 = { left: 346, top: 100, right: 390, bottom: 400 };
const BAND = { ...BAND0 };
const TOPS: Record<string, number> = { h1: 1000, h2: 2000, h3: 2800, h0: 200 };
const topOf = (id: string) => TOPS[id] ?? (/^w(\d+)$/u.test(id) ? Number(id.slice(1)) * 120 + 100 : 0);
const agents = [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }];

const room = (extra: Array<{ id: string; ts: number; from: string; body: string }> = []) => feedBlocks([
  { id: 'h1', ts: NOW - 50 * HOUR, from: 'human', body: 'first question\nwith a second line' },
  { id: 'a1', ts: NOW - 49 * HOUR, from: 'dev', body: 'first answer' },
  { id: 'h2', ts: NOW - 30 * HOUR, from: 'human', body: '@dev second question' },
  { id: 'a2', ts: NOW - 29 * HOUR, from: 'dev', body: 'second answer' },
  { id: 'h3', ts: NOW - 2 * HOUR, from: 'human', body: 'third question' },
  { id: 'a3', ts: NOW - 1 * HOUR, from: 'dev', body: 'third answer' },
  ...extra,
], [], 'chat', (n) => n);

const base = (blocks: unknown, other: unknown = []) => ({
  a: blocks, b: other, roomReady: true, managedNames: ['dev'], agents,
});

/** The feed's classic scrollbar width (px), read by the rail as offsetWidth - clientWidth. */
const SCROLLBAR = { w: 0 };
async function open(context: import('node:test').TestContext, props: Record<string, unknown>, options: { wake?: boolean; dwell?: string } = {}) {
  Object.assign(BAND, BAND0);
  SCROLLBAR.w = 0;
  const captured: number[] = [];
  const released: number[] = [];
  const app = await (await compiled).mount(context, {
    props,
    setup(window) {
      const proto = window.Element.prototype as any;
      proto.getAnimations = () => [];
      const style = window.document.createElement('style');
      style.textContent = `:root { --turn-rail-dwell: ${options.dwell ?? DWELL_TOKEN}; }`;
      window.document.head.append(style);
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });   // the 390px phone the band's x values describe
      (window.HTMLCanvasElement.prototype as any).getContext = () => null;
      const rect = (r: typeof BAND) => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON() {} });
      const orig = proto.getBoundingClientRect;
      proto.getBoundingClientRect = function (this: Element) {
        if (this.classList.contains('tr-band')) return rect(BAND);
        if (this.classList.contains('turn-rail')) return rect(COLUMN);
        if (this.classList.contains('feed-wrap')) return rect({ left: 0, top: 0, right: 390, bottom: 700 });
        return orig.call(this);
      };
      Object.defineProperty(proto, 'clientHeight', {
        configurable: true,
        get(this: Element) { return this.classList?.contains('turn-rail') ? 340 : 0; },
      });
      Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: Element) { return this.classList?.contains('feed') ? 390 : 0; } });
      const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
      Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: Element) { return this.classList?.contains('feed') ? 390 - SCROLLBAR.w : (clientWidth?.get?.call(this) ?? 0); } });
      proto.setPointerCapture = function (id: number) { captured.push(id); };
      proto.hasPointerCapture = function (id: number) { return captured.includes(id) && !released.includes(id); };
      proto.releasePointerCapture = function (id: number) { released.push(id); };
    },
    modules: [],
  });
  const q = (s: string) => app.document.querySelector<HTMLElement>(s);
  const qa = (s: string) => [...app.document.querySelectorAll<HTMLElement>(s)];
  const frames = async () => { for (let i = 0; i < 4; i++) { await app.advance(20); await app.flush(); } };
  /** The feed's scroll size and every ask's natural place, re-stated after any re-render. */
  const geometry = () => {
    const feed = q('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 70000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => 500, configurable: true });
    for (const ask of qa('[data-ask]')) {
      const top = topOf(ask.dataset.ask!);
      Object.defineProperty(ask, 'offsetTop', { get: () => top, configurable: true });
      Object.defineProperty(ask, 'offsetHeight', { get: () => 60, configurable: true });
    }
    return feed;
  };
  const ev = (type: string, el: Element, y: number, o: { id?: number; kind?: string; x?: number; button?: number } = {}) =>
    el.dispatchEvent(new app.window.PointerEvent(type, {
      bubbles: true, cancelable: true, button: o.button ?? 0, pointerType: o.kind ?? 'mouse',
      pointerId: o.id ?? 1, clientX: o.x ?? 370, clientY: y,
    }));
  /** The y of the middle of turn i of 3 on the 300px band. */
  const yOf = (i: number) => 100 + i * 100 + 50;
  const rows = () => qa('.tr-pop .tr-label').map((e) => e.textContent);
  await frames();
  geometry();
  await frames();
  geometry();
  /** A mouse moves inside the rail's column: the desktop way to wake a hidden rail. */
  const hover = async (x: number, y: number, kind = 'mouse', buttons = 0) => {
    q('.feed-wrap')!.dispatchEvent(new app.window.PointerEvent('pointermove', { bubbles: true, pointerType: kind, pointerId: 31, clientX: x, clientY: y, buttons }));
    await frames();
  };
  /** The reader scrolls away from the tail (the feed reports it once per frame). */
  const scrollAway = async (top = 1200) => {
    const feed = geometry();
    feed.scrollTop = top; feed.dispatchEvent(new app.window.Event('scroll')); await frames();
  };
  const shown = () => !!q('.turn-rail')?.classList.contains('shown');
  // Most rows are about the rail's behaviour once it is shown; the visibility rows ask for { wake: false }.
  if (options.wake !== false && q('.turn-rail')) await hover(370, 300);
  return { app, q, qa, frames, geometry, ev, yOf, rows, captured, released, BAND, hover, scrollAway, shown };
}

test('the rail is absent with one turn and appears with the second WITHOUT touching the feed\'s layout or reading position (#463)', async (context) => {
  const one = feedBlocks([{ id: 'h1', ts: NOW, from: 'human', body: 'only' }, { id: 'a1', ts: NOW, from: 'dev', body: 'reply' }], [], 'chat', (n) => n);
  const t = await open(context, base(one, room()));
  try {
    assert.equal(t.q('.turn-rail'), null, 'a single turn is not a rail');
    const feed = t.geometry();
    feed.scrollTop = 800; feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    const feedBefore = feed.getAttribute('class'), wrapBefore = t.q('.feed-wrap')!.getAttribute('class');
    t.q('.t-set-b')!.click(); await t.frames();
    assert.ok(t.q('.turn-rail'), 'the second human message brings it');
    assert.equal(t.geometry().scrollTop, 800, 'the reader did not move: appearing is not a layout mutation');
    assert.equal(t.q('.feed')!.getAttribute('class')!.replace(/\s*reveal-tail/u, ''), feedBefore!.replace(/\s*reveal-tail/u, ''), 'the feed gained no class');
    assert.equal(t.q('.feed-wrap')!.getAttribute('class'), wrapBefore, 'nor the wrap');
    assert.equal(t.q('.feed')!.getAttribute('style'), null, 'nor an inline padding');
    assert.equal(t.qa('.turn-rail .tr-tick').length, 3, 'one tick per turn while the band has room');
    assert.equal(t.q('.tr-band')!.getAttribute('aria-valuemax'), '3');
    assert.ok(t.q('.feed') && t.q('.feed')!.parentElement === t.q('.feed-wrap'), 'a sibling of the scroller inside the wrap');
    assert.equal(t.q('.feed .turn-rail'), null, 'never inside it');
    t.q('.t-set-a')!.click(); await t.frames();
    t.q('.t-set-b')!.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 800, 'and coming and going leaves the position alone');
  } finally { await t.app.close(); }
});

test('an agent bubble is never a turn: the rail counts the human messages the anchor tracks (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    assert.equal(t.qa('[data-ask]').length, 3);
    assert.equal(t.q('.tr-band')!.getAttribute('aria-valuemax'), '3');
    assert.equal(t.qa('.tr-tick').length, 3);
  } finally { await t.app.close(); }
});

test('hovering previews ONLY the probed turn, larger, with where it sits; moving changes it (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    assert.deepEqual(t.rows(), ['@dev second question'], 'one row: no neighbours');
    assert.equal(t.qa('.tr-pop .tr-row').length, 1);
    assert.match(t.q('.tr-pop .tr-foot')!.textContent!, /^Turn 2 of 3 · 1d$/u);
    assert.equal(t.qa('.tr-pop').length, 1, 'ONE popover');
    assert.ok(t.q('.tr-pop')!.classList.contains('menu-surface') && t.q('.tr-pop')!.classList.contains('pop-layer'));
    assert.equal(t.qa('.tr-tick.probe').length, 1);
    const card = t.q('.tr-pop') as HTMLElement;
    assert.equal(card.style.top, '250px', 'the card is centred on the probed tick (turn 2 of 3 on the 100..400 band)');
    t.ev('pointermove', band, t.yOf(2)); await t.frames();
    assert.equal(t.q('.tr-pop'), card, 'the SAME element follows the probe: no remount, so no pop-in replay');
    assert.equal(card.style.top, '350px', 'and it moved to the new probed tick');
    assert.deepEqual(t.rows(), ['third question']);
    assert.match(t.q('.tr-pop .tr-foot')!.textContent!, /^Turn 3 of 3/u);
    assert.equal(band.getAttribute('aria-valuetext'), 'Turn 3 of 3: third question', 'the slider speaks the PREVIEW');
    t.ev('pointerleave', band, 0); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'leaving closes it');
    assert.equal(t.geometry().scrollTop, 0, 'previewing never moved the feed');
  } finally { await t.app.close(); }
});

test('a click on the band lands the feed on the turn\u2019s natural position, the one jump (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    t.ev('pointerdown', band, t.yOf(1));
    t.ev('pointerup', band, t.yOf(1)); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'rowTop of the 2nd turn, 8px above — the same landing as the double-tap jump');
    assert.equal(t.q('.tr-pop'), null, 'the preview closes on the jump');
  } finally { await t.app.close(); }
});

test('the popover\'s one row jumps to the probed turn, once (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    const row = t.q('.tr-pop .tr-row')!;
    row.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'the probed (2nd) turn');
    row.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'a second click finds nothing to commit');
  } finally { await t.app.close(); }
});

test('touch: press and drag scrubs with the same popover; release lands; pointercancel does not (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    const kind = { kind: 'touch', id: 7 };
    t.ev('pointerdown', band, t.yOf(0), kind); await t.frames();
    assert.deepEqual(t.captured, [7], 'the press captures its pointer');
    assert.equal(t.q('.tr-pop .tr-label')!.textContent, 'first question');
    t.ev('pointermove', band, t.yOf(1), kind);
    t.ev('pointermove', band, t.yOf(2), kind); await t.frames();
    assert.equal(t.q('.tr-pop .tr-label')!.textContent, 'third question', 'the popover follows the finger');
    assert.equal(t.geometry().scrollTop, 0, 'nothing moves until the release');
    t.ev('pointerup', band, t.yOf(2), kind); await t.frames();
    assert.equal(t.geometry().scrollTop, 2792);
    // A second gesture cancelled by the system lands nowhere.
    t.geometry().scrollTop = 0;
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 8 }); await t.frames();
    t.ev('pointercancel', band, t.yOf(1), { kind: 'touch', id: 8 }); await t.frames();
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 8 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'pointercancel never jumps');
    assert.equal(t.q('.tr-pop'), null);
    // A touch hovering opens nothing.
    t.ev('pointermove', band, t.yOf(1), kind); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'a touch has no hover');
  } finally { await t.app.close(); }
});

test('keyboard: arrows preview, Enter lands once, Escape closes, Tab is left alone (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    const key = (k: string) => band.dispatchEvent(new t.app.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    assert.equal(key('ArrowUp'), false, 'a handled key is cancelled so the feed does not scroll');
    await t.frames();
    assert.equal(band.getAttribute('aria-valuenow'), '3', 'with nothing lit the first press lands on the newest');
    key('ArrowUp'); await t.frames();
    assert.equal(band.getAttribute('aria-valuenow'), '2');
    assert.equal(band.getAttribute('aria-valuetext'), 'Turn 2 of 3: @dev second question');
    assert.equal(t.geometry().scrollTop, 0);
    assert.equal(key('Tab'), true, 'Tab is not the rail\u2019s');
    key('Escape'); await t.frames();
    assert.equal(t.q('.tr-pop'), null);
    key('Enter'); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'Enter after Escape only reopens a preview');
    key('ArrowUp'); key('Enter'); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'a preview of the 2nd turn, committed');
  } finally { await t.app.close(); }
});

test('ONE tick is emphasised: the anchor\'s when idle, the probe\'s while one is open, the anchor\'s again after (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const feed = t.geometry();
    feed.scrollTop = 1200; feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    const idx = (cls: string) => t.qa('.tr-tick').findIndex((e) => e.classList.contains(cls));
    const emphasised = () => t.qa('.tr-tick.cur, .tr-tick.probe').length;
    const anchor = idx('cur');
    assert.ok(anchor >= 0, 'an anchor exists once the feed can scroll');
    assert.equal(emphasised(), 1);
    const band = t.q('.tr-band')!;
    // Hover: the emphasis is the probe\'s and moves with the pointer like a wheel.
    t.ev('pointermove', band, t.yOf(0)); await t.frames();
    assert.equal(idx('probe'), 0); assert.equal(idx('cur'), -1); assert.equal(emphasised(), 1);
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    assert.equal(idx('probe'), 1); assert.equal(emphasised(), 1);
    t.ev('pointermove', band, t.yOf(2)); await t.frames();
    assert.equal(idx('probe'), 2); assert.equal(emphasised(), 1);
    // leave / cancel / commit / retire each hand the emphasis back to the anchor
    t.ev('pointerleave', band, 0); await t.frames();
    assert.equal(idx('cur'), anchor); assert.equal(idx('probe'), -1);
    t.ev('pointerdown', band, t.yOf(2), { kind: 'touch', id: 7 }); await t.frames();
    t.ev('pointermove', band, t.yOf(0), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(idx('probe'), 0, 'a scrub moves it');
    t.ev('pointercancel', band, t.yOf(0), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(idx('cur'), anchor, 'cancel returns it'); assert.equal(emphasised(), 1);
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    t.q('.t-aba')!.click(); await t.frames();
    assert.equal(idx('probe'), -1, 'retire returns it'); assert.equal(emphasised(), 1);
    // the preview is state of the rail only: the anchor\'s key was never written
    assert.equal(feed.scrollTop, 1200);
    // a commit hands it to whatever the anchor says next
    t.ev('pointerdown', band, t.yOf(1)); t.ev('pointerup', band, t.yOf(1)); await t.frames();
    assert.equal(idx('probe'), -1); assert.equal(emphasised(), 1);
  } finally { await t.app.close(); }
});

test('with no anchor nothing is emphasised until a probe opens, and the first arrow lands on the newest (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const feed = t.q('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 400, configurable: true });
    feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    t.q('.t-set-a')!.click(); await t.frames();
    assert.equal(t.qa('.tr-tick.cur').length, 0);
    t.ev('pointermove', t.q('.tr-band')!, t.yOf(0)); await t.frames();
    assert.equal(t.qa('.tr-tick.probe').length, 1, 'a probe still lights the tick it is on');
  } finally { await t.app.close(); }
});

test('a held press ends without a jump when the reading context is replaced under it (#461)', async (context) => {
  for (const [name, change] of [
    ['cached room A to B to A, roomReady true throughout, the same keys', '.t-aba'],
    ['a filter on and off in one change, the same keys', '.t-filter'],
  ] as const) {
    const t = await open(context, base(room(), room().slice(0, 4)));
    try {
      const band = t.q('.tr-band')!;
      t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      assert.ok(t.q('.tr-pop'), `${name}: the press is open`);
      t.q(change)!.click(); await t.frames();
      assert.equal(t.q('.tr-pop'), null, `${name}: it is gone`);
      t.ev('pointerup', t.q('.tr-band')!, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      assert.equal(t.geometry().scrollTop, 0, `${name}: the old release lands nowhere`);
    } finally { await t.app.close(); }
  }
});

test('the same retirements end a hover and a key preview: the old click and the old Enter commit nothing (#461)', async (context) => {
  const t = await open(context, base(room(), room().slice(0, 4)));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    const row = t.q('.tr-pop .tr-row')!;
    t.q('.t-aba')!.click(); await t.frames();
    row.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'the row of a retired hover finds no intent');
    const key = (k: string) => t.q('.tr-band')!.dispatchEvent(new t.app.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowUp'); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.q('.t-filter')!.click(); await t.frames();
    key('Enter'); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'Enter after a retirement opens a fresh preview and does not jump');
  } finally { await t.app.close(); }
});

test('a real hide then show ends a held press; an agent-only update does not; a new human message does (#461)', async (context) => {
  {
    const t = await open(context, base(room(), room()));
    try {
      const band = t.q('.tr-band')!;
      t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      t.q('.t-hide')!.click(); await t.frames();
      t.q('.t-show')!.click(); await t.frames();
      const parked = t.geometry().scrollTop;     // the feed re-parks the tail when its page comes back
      t.ev('pointerup', t.q('.tr-band')!, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      assert.equal(t.geometry().scrollTop, parked, 'across two tasks: the old release lands nowhere');
      assert.notEqual(parked, 1992);
    } finally { await t.app.close(); }
  }
  {
    const withAgent = room([{ id: 'a4', ts: NOW, from: 'dev', body: 'one more streamed reply' }]);
    const t = await open(context, base(room(), withAgent));
    try {
      const band = t.q('.tr-band')!;
      t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      t.q('.t-set-b')!.click(); await t.frames();
      t.geometry();
      t.ev('pointerup', t.q('.tr-band')!, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      assert.equal(t.geometry().scrollTop, 1992, 'agent-only update: the press survives and lands');
    } finally { await t.app.close(); }
  }
  {
    const withHuman = room([{ id: 'h4', ts: NOW, from: 'human', body: 'a fourth' }]);
    const t = await open(context, base(room(), withHuman));
    try {
      const band = t.q('.tr-band')!;
      t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      t.q('.t-set-b')!.click(); await t.frames();
      t.geometry();
      t.ev('pointerup', t.q('.tr-band')!, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
      assert.equal(t.geometry().scrollTop, 0, 'the turn set changed under the finger: no remap, no jump');
    } finally { await t.app.close(); }
  }
});

test('a hide then show inside ONE flush is the stated limit: the commit resolves against the current turns and lands (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    t.q('.t-hide-show')!.click(); await t.frames();
    t.ev('pointerup', t.q('.tr-band')!, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'nothing painted, nothing changed: the key still names a current turn');
  } finally { await t.app.close(); }
});

test('the Hub\u2019s back stack closes an open preview and reports it (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    t.ev('pointermove', t.q('.tr-band')!, t.yOf(1)); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.q('.t-close')!.click(); await t.frames();
    assert.equal((t.app.window as any).__closed, true);
    assert.equal(t.q('.tr-pop'), null);
    t.q('.t-close')!.click(); await t.frames();
    assert.equal((t.app.window as any).__closed, false, 'nothing open: Back is not ours');
  } finally { await t.app.close(); }
});

test('with no anchor (a feed too short to scroll) nothing is lit, and the first arrow lands on the newest (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const feed = t.q('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 400, configurable: true });   // shorter than the 500px viewport
    feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    t.q('.t-set-a')!.click(); await t.frames();
    assert.equal(t.qa('.tr-tick.cur').length, 0, 'the rail makes up no current turn of its own');
    assert.equal(t.q('.tr-band')!.getAttribute('aria-valuetext'), '3 turns');
    t.q('.tr-band')!.dispatchEvent(new t.app.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); await t.frames();
    assert.equal(t.q('.tr-band')!.getAttribute('aria-valuenow'), '3');
  } finally { await t.app.close(); }
});

test('a turn already on screen is not scrolled to: the jump only re-seeds the anchor (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const feed = t.geometry();
    feed.scrollTop = 1900; feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    t.ev('pointerdown', t.q('.tr-band')!, t.yOf(1));
    t.ev('pointerup', t.q('.tr-band')!, t.yOf(1)); await t.frames();
    assert.equal(feed.scrollTop, 1900, 'the 2nd turn starts at 2000, inside the viewport: nothing moves');
  } finally { await t.app.close(); }
});

const withBridge = (t: Awaited<ReturnType<typeof open>>) => t.q('.tr-bridge')!;

test('the pointer can leave the band into the corridor (on its LEFT) and the popover without closing the preview, and the row jumps once (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    // From the LOWEST tick: the card is centred on the probed tick, the corridor spans the band.
    t.ev('pointermove', band, t.yOf(2)); await t.frames();
    assert.ok(t.q('.tr-pop') && withBridge(t), 'the preview and its corridor are open');
    const bridge = withBridge(t), pop = t.q('.tr-pop')!;
    assert.equal(bridge.style.left, '340px', 'the gap, immediately left of the band (x 346)');
    assert.equal(bridge.style.top, '100px'); assert.equal(bridge.style.height, '300px', 'over the band\'s whole height');
    const leave = (el: Element, to: Element | null) => el.dispatchEvent(new t.app.window.PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse', pointerId: 1, relatedTarget: to } as PointerEventInit));
    leave(band, bridge); await t.frames();
    assert.ok(t.q('.tr-pop'), 'band to corridor: still open');
    leave(bridge, pop); await t.frames();
    assert.ok(t.q('.tr-pop'), 'corridor to popover: still open');
    assert.equal(t.q('.tr-pop .tr-label')!.textContent, 'third question', 'and the probed turn was not swapped on the way');
    leave(pop, band); await t.frames();
    assert.ok(t.q('.tr-pop'), 'popover back to the band: still open');
    leave(band, bridge); leave(bridge, pop); await t.frames();
    t.q('.tr-pop .tr-row')!.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 2792, 'the row jumped to the probed (3rd) turn');
    assert.equal(t.q('.tr-pop'), null);
    // and a pointer that goes anywhere else ends the hover
    t.ev('pointermove', t.q('.tr-band')!, t.yOf(1)); await t.frames();
    leave(t.q('.tr-band')!, t.app.document.body); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'out of the cluster: closed');
  } finally { await t.app.close(); }
});

test('the window or the band moving closes the preview without a pointer move, and a press does not survive it (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.BAND.top = 130; t.BAND.bottom = 430;                        // a header appeared, the keyboard rose ...
    t.app.window.dispatchEvent(new t.app.window.Event('resize')); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'a stale popover is not left where it was');
    t.BAND.top = 100; t.BAND.bottom = 400;
    // A held press: the geometry changes and changes BACK before the release.
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.BAND.top = 130; t.BAND.bottom = 430;
    t.app.window.dispatchEvent(new t.app.window.Event('resize')); await t.frames();
    t.BAND.top = 100; t.BAND.bottom = 400;
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'equal again at the release is not enough: the press was retired at the change');
    // The interface zoom is the same kind of change.
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.app.window.dispatchEvent(new t.app.window.CustomEvent('app-zoom-change', { detail: { scale: 1.25 } })); await t.frames();
    assert.equal(t.q('.tr-pop'), null);
  } finally { await t.app.close(); }
});

test('a 500-turn feed through pointer events: ticks compress, the far end is reachable, a fine slide lands on the exact turn (#461)', async (context) => {
  const many = feedBlocks(Array.from({ length: 500 }, (_, i) => ({ id: `w${i}`, ts: NOW - (500 - i) * 60_000, from: 'human', body: `turn ${i}` })), [], 'chat', (n) => n);
  const t = await open(context, { a: many, b: [], roomReady: true, managedNames: ['dev'], agents });
  try {
    const band = t.q('.tr-band')!;
    assert.equal(t.qa('.tr-tick').length, 34, '340px of column at the tick pitch: 500 turns are DRAWN as 34 ticks');
    assert.equal(band.getAttribute('aria-valuemax'), '500', 'but all 500 stay selectable');
    // A press at 60% of the band: the slice under the finger.
    const y0 = 100 + 300 * 0.6;
    t.ev('pointerdown', band, y0, { kind: 'touch', id: 7 }); await t.frames();
    const at = () => Number(/turn (\d+)/u.exec(t.q('.tr-pop .tr-label')!.textContent!)![1]);
    const start = at();
    assert.ok(Math.abs(start - 300) <= 2, `coarse press names about turn 300, got ${start}`);
    // 300px for 500 turns is under 2 turns per pixel: a slide away from the band never skips one.
    let y = y0, last = start;
    for (let i = 0; i < 40; i++) {
      y += 1;
      t.ev('pointermove', band, y, { kind: 'touch', id: 7, x: 346 - 88 });
      await t.frames();
      const now = at();
      assert.ok(now - last >= 0 && now - last <= 1, `a pixel at the far end moves at most one turn (${last} to ${now})`);
      assert.equal(t.qa('.tr-tick.cur, .tr-tick.probe').length, 1, 'exactly ONE tick is emphasised, also when several turns share a drawn tick');
      last = now;
    }
    assert.ok(last > start, 'and it did move');
    t.ev('pointerup', band, y, { kind: 'touch', id: 7, x: 346 - 88 }); await t.frames();
    assert.equal(t.geometry().scrollTop, topOf(`w${last}`) - 8, `landed on turn ${last}`);
  } finally { await t.app.close(); }
});

test('a classic scrollbar is stood clear of, read from the scroller, and its going retires the rail (#463)', async (context) => {
  const t = await open(context, base(room()));
  try {
    assert.equal(t.q('.turn-rail')!.getAttribute('style'), '--turn-rail-edge: 0px;', 'overlay scrollbars take no width');
    SCROLLBAR.w = 8;
    t.ev('pointermove', t.q('.tr-band')!, t.yOf(1)); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.app.window.dispatchEvent(new t.app.window.Event('resize')); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'the rail moved sideways: the old preview is gone');
    assert.equal(t.q('.turn-rail')!.getAttribute('style'), '--turn-rail-edge: 8px;', 'the scrollbar\'s width, measured not assumed');
    SCROLLBAR.w = 0;
    t.app.window.dispatchEvent(new t.app.window.Event('resize')); await t.frames();
    assert.equal(t.q('.turn-rail')!.getAttribute('style'), '--turn-rail-edge: 0px;');
  } finally { await t.app.close(); }
});

test('the fine adjust is GRADED by how far left of the band the finger is, through the real wiring (#463)', async (context) => {
  const many = feedBlocks(Array.from({ length: 500 }, (_, i) => ({ id: `w${i}`, ts: NOW - (500 - i) * 60_000, from: 'human', body: `turn ${i}` })), [], 'chat', (n) => n);
  const slide = async (x: number) => {
    const t = await open(context, { a: many, b: [], roomReady: true, managedNames: ['dev'], agents });
    try {
      const band = t.q('.tr-band')!;
      const at = () => Number(/turn (\d+)/u.exec(t.q('.tr-pop .tr-label')!.textContent!)![1]);
      const y0 = 100 + 300 * 0.3;
      t.ev('pointerdown', band, y0, { kind: 'touch', id: 7, x: 370 }); await t.frames();
      const start = at();
      if (x !== 370) { t.ev('pointermove', band, y0, { kind: 'touch', id: 7, x }); await t.frames(); }
      t.ev('pointermove', band, y0 + 40, { kind: 'touch', id: 7, x }); await t.frames();
      const covered = at() - start;
      t.ev('pointercancel', band, y0 + 40, { kind: 'touch', id: 7, x }); await t.frames();
      return covered;
    } finally { await t.app.close(); }
  };
  // 500 turns on a 300px band: a pixel is 5/3 of a turn on the band, and the slowest it gets is
  // 5/6 of a turn (the factor 2). 40px: 66 turns coarse, 33 at the slowest.
  const onBand = await slide(370);
  const part = await slide(346 - 20);           // 20px left of the band: one quarter of the way to the slowest
  const far = await slide(346 - 88);            // the whole reach
  assert.ok(onBand >= 65 && onBand <= 68, `coarse on the band: ${onBand}`);
  assert.ok(part >= 52 && part <= 57, `GRADED 20px out (1.23x slower, about 54): ${part}`);
  assert.ok(far >= 32 && far <= 35, `the slowest at the full reach: ${far}`);
  assert.ok(onBand > part && part > far, 'monotonic: the further left, the finer');
});

// -- board #465: the rail is not always on ---------------------------------------------------------

const tick = async (t: Awaited<ReturnType<typeof open>>, ms: number) => { await t.app.advance(ms); };
/** Every awaited gesture spends up to 80ms of the mock clock on animation frames, so a dwell edge is probed with margins:
 * still shown a little BEFORE it, hidden a little AFTER it. */
const dwellEdge = async (t: Awaited<ReturnType<typeof open>>, what: string) => {
  await tick(t, DWELL - 200);
  assert.equal(t.shown(), true, `${what}: still shown just before a dwell has passed`);
  await tick(t, 250);
  assert.equal(t.shown(), false, `${what}: hidden once a dwell has passed`);
};

test('a loaded feed with several turns shows no rail until the reader scrolls away; the tail park and tail-follow never flash it (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    assert.ok(t.q('.turn-rail'), 'it is mounted');
    assert.equal(t.shown(), false, 'hidden on load: the park at the tail is the feed scrolling itself');
    const feed = t.geometry();
    feed.scrollTop = 70000 - 500; feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    assert.equal(t.shown(), false, 'a scroll that lands in the tail zone is tail-follow, not the reader');
    await tick(t, 20_000);
    assert.equal(t.shown(), false);
  } finally { await t.app.close(); }
});

test('scrolling away from the tail shows it at once; a full dwell after the LAST scroll hides it (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    await t.scrollAway(1200);
    assert.equal(t.shown(), true, 'a scroll shows it within the frame');
    await tick(t, DWELL - 300);
    await t.scrollAway(1300);                     // another scroll: the dwell restarts from THIS one
    await dwellEdge(t, 'after the last scroll');
    await t.scrollAway(1400);
    assert.equal(t.shown(), true, 'and a scroll brings it back');
  } finally { await t.app.close(); }
});

test('the dwell is the CSS token and nothing else: a different token value moves the edge, a missing one hides at once (#465)', async (context) => {
  for (const [dwell, ms] of [['3s', 3000], ['400ms', 400]] as const) {
    const t = await open(context, base(room()), { wake: false, dwell });
    try {
      await t.scrollAway(1200);
      assert.equal(t.shown(), true, `${dwell}: a scroll shows it`);
      await tick(t, ms - 200);
      assert.equal(t.shown(), true, `${dwell}: still shown just before the token's dwell`);
      await tick(t, 250);
      assert.equal(t.shown(), false, `${dwell}: hidden just after it, not at some other figure`);
    } finally { await t.app.close(); }
  }
  const t = await open(context, base(room()), { wake: false, dwell: 'soon' });
  try {
    await t.scrollAway(1200);
    await tick(t, 50);
    assert.equal(t.shown(), false, 'a token that is not a time hides at once: the failure is visible');
  } finally { await t.app.close(); }
});

test('a hidden rail takes no input: a press does not start, capture or jump (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.deepEqual(t.captured, [], 'no capture');
    assert.equal(t.q('.tr-pop'), null, 'no preview');
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 0, 'a tap on the hidden column never jumps');
    assert.equal(band.getAttribute('tabindex'), '0', 'but the band stays in the tab order');
  } finally { await t.app.close(); }
});

test('a tap during the fade-OUT is the feed\'s, and one during the fade-IN is the rail\'s: nothing waits for a transition (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band')!;
    await t.scrollAway(1200);
    // The class is on the moment the rail is shown, so a press begun while the paint is still fading in finishes.
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 });
    t.ev('pointermove', band, t.yOf(2), { kind: 'touch', id: 7 });
    t.ev('pointerup', band, t.yOf(2), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 2792, 'committed mid-fade-in');
    await tick(t, DWELL);
    assert.equal(t.shown(), false);
    const top = t.geometry().scrollTop;
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 8 });
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 8 }); await t.frames();
    assert.equal(t.geometry().scrollTop, top, 'the class is already gone when the paint is still fading out: the tap does nothing');
    assert.deepEqual(t.captured.filter((id) => id === 8), []);
  } finally { await t.app.close(); }
});

test('a probe during the dwell keeps it, a long gesture is not timed out, and the dwell restarts from its end (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band')!;
    await t.scrollAway(1200);
    await tick(t, DWELL - 100);
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    await tick(t, 60_000);
    assert.equal(t.shown(), true, 'a held gesture keeps it shown for as long as it lasts');
    assert.ok(t.q('.tr-pop'), 'and its preview');
    t.ev('pointercancel', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    await dwellEdge(t, 'a FULL dwell runs from the end of the gesture, not from when the scroll began');
    assert.equal(t.geometry().scrollTop, 1200, 'a cancelled gesture jumped nowhere');
  } finally { await t.app.close(); }
});

test('hovering a hidden rail\'s column with a mouse shows it without a jump; a touch or a pressed button does not (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    await t.hover(370, 300, 'touch');
    assert.equal(t.shown(), false, 'a touch has no hover');
    await t.hover(370, 300, 'mouse', 1);
    assert.equal(t.shown(), false, 'a pressed button is a drag, not a hover');
    await t.hover(200, 300);
    assert.equal(t.shown(), false, 'outside the column');
    await t.hover(370, 300);
    assert.equal(t.shown(), true, 'inside the column');
    assert.equal(t.geometry().scrollTop, 0, 'nothing jumped');
    await tick(t, 60_000);
    assert.equal(t.shown(), true, 'while the pointer rests in the column it stays');
    await t.hover(200, 300);                                 // out of the column: a dwell begins
    await dwellEdge(t, 'leaving the column');
    await t.hover(370, 300);
    t.q('.feed-wrap')!.dispatchEvent(new t.app.window.PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse', pointerId: 31 }));
    await tick(t, DWELL);
    assert.equal(t.shown(), false, 'leaving the feed releases the hold');
    await t.hover(370, 300, 'pen');
    assert.equal(t.shown(), true, 'a hovering pen wakes it like a mouse');
    await t.hover(370, 300, 'pen', 1);
    await tick(t, DWELL);
    assert.equal(t.shown(), false, 'a pen that is pressing releases it');
  } finally { await t.app.close(); }
});

test('keyboard focus shows it and keeps it, a blur starts the dwell (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band') as HTMLElement;
    (band as any).matches = (selector: string) => selector === ':focus-visible';
    band.dispatchEvent(new t.app.window.FocusEvent('focus')); await t.frames();
    assert.equal(t.shown(), true, 'Tab to a hidden rail brings it back');
    await tick(t, 60_000);
    assert.equal(t.shown(), true, 'while it has focus it stays');
    const key = (k: string) => band.dispatchEvent(new t.app.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowUp'); key('Enter'); await t.frames();
    assert.notEqual(t.geometry().scrollTop, 0, 'and its keys work at once (no transition to wait for)');
    band.dispatchEvent(new t.app.window.FocusEvent('blur')); await t.frames();
    await dwellEdge(t, 'after a blur');
    // A mouse press focuses the band too, but that is not a keyboard focus.
    (band as any).matches = () => false;
    band.dispatchEvent(new t.app.window.FocusEvent('focus')); await t.frames();
    assert.equal(t.shown(), false);
  } finally { await t.app.close(); }
});

test('a band that kept focus while hidden wakes on a navigating key, keeps the rail while it holds focus, and lets go on blur (#465 P1-A)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band') as HTMLElement;
    const key = (k: string) => band.dispatchEvent(new t.app.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    // A mouse focused it while it was visible: the focus is real but never :focus-visible, so no hold.
    await t.scrollAway(1200);
    (band as any).matches = () => false;
    band.dispatchEvent(new t.app.window.FocusEvent('focus')); await t.frames();
    await tick(t, DWELL + 300);
    assert.equal(t.shown(), false, 'the dwell ran out while the band is still the focused element');
    // Keys that are not navigation wake nothing.
    key('Tab'); key('Escape'); key('a'); await t.frames();
    assert.equal(t.shown(), false, 'Tab, Escape and letters do not claim the rail');
    // A pointer is still refused while hidden.
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 9 });
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 9 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 1200, 'the pointer gate is unchanged');
    key('ArrowUp'); await t.frames();
    assert.equal(t.shown(), true, 'the arrow wakes it with no focus event');
    assert.ok(t.q('.tr-pop'), 'and the same key already previews');
    key('Enter'); await t.frames();
    assert.notEqual(t.geometry().scrollTop, 1200, 'and Enter commits');
    await tick(t, DWELL * 3);
    assert.equal(t.shown(), true, 'the commit closed the probe, but the keyboard still holds the band: it stays');
    band.dispatchEvent(new t.app.window.FocusEvent('blur')); await t.frames();
    await dwellEdge(t, 'after the blur');
    // Space and Home/End wake it the same way.
    for (const k of [' ', 'Home', 'End']) {
      band.dispatchEvent(new t.app.window.FocusEvent('blur')); await tick(t, DWELL + 300);
      assert.equal(t.shown(), false);
      key(k); await t.frames();
      assert.equal(t.shown(), true, `${JSON.stringify(k)} wakes it`);
    }
  } finally { await t.app.close(); }
});

test('a new reading context drops the old activity; the gate falling clears every hold (#465)', async (context) => {
  {
    const t = await open(context, base(room(), room().slice(0, 4)), { wake: false });
    try {
      await t.scrollAway(1200);
      assert.equal(t.shown(), true);
      t.q('.t-aba')!.click(); await t.frames();          // the Hub's select path: resetForRoom
      assert.equal(t.shown(), false, 'the previous room\'s scroll does not decide the new room\'s visibility');
      await tick(t, 60_000);
      assert.equal(t.shown(), false, 'and its timer never fires');
    } finally { await t.app.close(); }
  }
  {
    const t = await open(context, base(room()), { wake: true });
    try {
      assert.equal(t.shown(), true, 'woken by the mouse');
      t.q('.t-hide')!.click(); await t.frames();           // the host is hidden: the gate falls
      t.q('.t-show')!.click(); await t.frames();
      assert.equal(t.shown(), false, 'the pointer hold did not survive the gate');
    } finally { await t.app.close(); }
  }
});

test('hiding changes nothing the rail measures: the column and the band keep their rectangles, and a real resize still retires (#465)', async (context) => {
  const t = await open(context, base(room()), { wake: false });
  try {
    const band = t.q('.tr-band')!;
    await t.scrollAway(1200);
    t.ev('pointerdown', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.ok(t.q('.tr-pop'));
    t.BAND.top = 130; t.BAND.bottom = 430;
    t.app.window.dispatchEvent(new t.app.window.Event('resize')); await t.frames();
    assert.equal(t.q('.tr-pop'), null, 'a real resize still cancels the gesture');
    t.BAND.top = 100; t.BAND.bottom = 400;
    t.ev('pointerup', band, t.yOf(1), { kind: 'touch', id: 7 }); await t.frames();
    assert.equal(t.geometry().scrollTop, 1200, 'and restoring the rectangle does not bring the press back');
  } finally { await t.app.close(); }
});
