import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { feedBlocks } from './hub.ts';

// Board #461: the turn rail wired into the Feed. jsdom has no layout, so the
// geometry the browser would measure is stated here (the band, the asks' natural
// tops, the feed's scroll size); the real pixels are the Chromium measurements
// on the issue. What is pinned is the WIRING: which turn a pointer names, where
// the ONE jump lands, and what a retirement leaves behind.
const compiled = compileMount(new URL('./TurnRail.test.svelte', import.meta.url), []);

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const BAND0 = { left: 0, top: 100, right: 44, bottom: 400 };
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

async function open(context: import('node:test').TestContext, props: Record<string, unknown>) {
  Object.assign(BAND, BAND0);
  const captured: number[] = [];
  const released: number[] = [];
  const app = await (await compiled).mount(context, {
    props,
    setup(window) {
      const proto = window.Element.prototype as any;
      proto.getAnimations = () => [];
      (window.HTMLCanvasElement.prototype as any).getContext = () => null;
      const rect = (r: typeof BAND) => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON() {} });
      const orig = proto.getBoundingClientRect;
      proto.getBoundingClientRect = function (this: Element) {
        if (this.classList.contains('tr-band')) return rect(BAND);
        if (this.classList.contains('feed-wrap')) return rect({ left: 0, top: 0, right: 390, bottom: 700 });
        return orig.call(this);
      };
      Object.defineProperty(proto, 'clientHeight', {
        configurable: true,
        get(this: Element) { return this.classList?.contains('turn-rail') ? 340 : 0; },
      });
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
      pointerId: o.id ?? 1, clientX: o.x ?? 20, clientY: y,
    }));
  /** The y of the middle of turn i of 3 on the 300px band. */
  const yOf = (i: number) => 100 + i * 100 + 50;
  const rows = () => qa('.tr-pop .tr-label').map((e) => e.textContent);
  await frames();
  geometry();
  await frames();
  geometry();
  return { app, q, qa, frames, geometry, ev, yOf, rows, captured, released, BAND };
}

test('the rail is absent with one turn, appears with the second, and takes its width from the leading padding (#461)', async (context) => {
  const one = feedBlocks([{ id: 'h1', ts: NOW, from: 'human', body: 'only' }, { id: 'a1', ts: NOW, from: 'dev', body: 'reply' }], [], 'chat', (n) => n);
  const t = await open(context, base(one, room()));
  try {
    assert.equal(t.q('.turn-rail'), null, 'a single turn is not a rail');
    assert.equal(t.q('.feed-wrap.railed'), null);
    t.q('.t-set-b')!.click(); await t.frames();
    assert.ok(t.q('.turn-rail'), 'the second human message brings it');
    assert.ok(t.q('.feed-wrap.railed'), 'and the class that makes the feed\'s padding hold its column');
    assert.equal(t.qa('.turn-rail .tr-tick').length, 3, 'one tick per turn while the band has room');
    assert.equal(t.q('.tr-band')!.getAttribute('aria-valuemax'), '3');
    assert.ok(t.q('.feed') && t.q('.feed')!.parentElement === t.q('.feed-wrap'), 'laid over the scroller\'s padding as its sibling');
    assert.equal(t.q('.feed .turn-rail'), null, 'never inside it');
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

test('hovering names the turn under the pointer with its neighbours and where it sits; moving changes it (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    assert.deepEqual(t.rows(), ['first question', '@dev second question', 'third question']);
    assert.equal(t.qa('.tr-pop .tr-row.cur').length, 1);
    assert.equal(t.q('.tr-pop .tr-row.cur .tr-label')!.textContent, '@dev second question');
    assert.match(t.q('.tr-pop .tr-foot')!.textContent!, /^Turn 2 of 3 · 1d$/u);
    assert.equal(t.qa('.tr-pop').length, 1, 'ONE popover');
    assert.ok(t.q('.tr-pop')!.classList.contains('menu-surface') && t.q('.tr-pop')!.classList.contains('pop-layer'));
    assert.ok(t.q('.tr-tick.probe'));
    t.ev('pointermove', band, t.yOf(2)); await t.frames();
    assert.deepEqual(t.rows(), ['@dev second question', 'third question']);
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

test('a row of the popover jumps to its own turn, once (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    t.ev('pointermove', band, t.yOf(1)); await t.frames();
    const third = t.qa('.tr-pop .tr-row')[2]!;
    third.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 2792);
    third.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 2792, 'a second click finds nothing to commit');
  } finally { await t.app.close(); }
});

test('touch: press and drag scrubs with the same popover; release lands; pointercancel does not (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    const kind = { kind: 'touch', id: 7 };
    t.ev('pointerdown', band, t.yOf(0), kind); await t.frames();
    assert.deepEqual(t.captured, [7], 'the press captures its pointer');
    assert.equal(t.q('.tr-pop .tr-row.cur .tr-label')!.textContent, 'first question');
    t.ev('pointermove', band, t.yOf(1), kind);
    t.ev('pointermove', band, t.yOf(2), kind); await t.frames();
    assert.equal(t.q('.tr-pop .tr-row.cur .tr-label')!.textContent, 'third question', 'the popover follows the finger');
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

test('the lit tick is the anchor\u2019s turn, and the preview is a different tick (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const feed = t.geometry();
    feed.scrollTop = 1200; feed.dispatchEvent(new t.app.window.Event('scroll')); await t.frames();
    const lit = t.qa('.tr-tick').findIndex((e) => e.classList.contains('cur'));
    assert.ok(lit >= 0, 'an anchor exists once the feed can scroll');
    t.ev('pointermove', t.q('.tr-band')!, t.yOf(2)); await t.frames();
    assert.equal(t.qa('.tr-tick').findIndex((e) => e.classList.contains('probe')), 2);
    assert.equal(t.qa('.tr-tick').findIndex((e) => e.classList.contains('cur')), lit, 'previewing does not move the current mark');
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
    const row = t.qa('.tr-pop .tr-row')[1]!;
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

test('the pointer can leave the band into the corridor and the popover without closing the preview, and the row it reaches jumps once (#461)', async (context) => {
  const t = await open(context, base(room()));
  try {
    const band = t.q('.tr-band')!;
    // From the LOWEST tick: the popover sits at the band's top, so the way there is along the corridor.
    t.ev('pointermove', band, t.yOf(2)); await t.frames();
    assert.ok(t.q('.tr-pop') && withBridge(t), 'the preview and its corridor are open');
    const bridge = withBridge(t), pop = t.q('.tr-pop')!;
    const leave = (el: Element, to: Element | null) => el.dispatchEvent(new t.app.window.PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse', pointerId: 1, relatedTarget: to } as PointerEventInit));
    leave(band, bridge); await t.frames();
    assert.ok(t.q('.tr-pop'), 'band to corridor: still open');
    leave(bridge, pop); await t.frames();
    assert.ok(t.q('.tr-pop'), 'corridor to popover: still open');
    assert.equal(t.q('.tr-pop .tr-row.cur .tr-label')!.textContent, 'third question', 'and the probed turn was not swapped on the way');
    leave(pop, band); await t.frames();
    assert.ok(t.q('.tr-pop'), 'popover back to the band: still open');
    leave(band, bridge); leave(bridge, pop); await t.frames();
    t.qa('.tr-pop .tr-row')[0]!.click(); await t.frames();
    assert.equal(t.geometry().scrollTop, 1992, 'the neighbour row jumped to its own turn');
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
    const at = () => Number(/turn (\d+)/u.exec(t.q('.tr-pop .tr-row.cur .tr-label')!.textContent!)![1]);
    const start = at();
    assert.ok(Math.abs(start - 300) <= 2, `coarse press names about turn 300, got ${start}`);
    // 300px for 500 turns is under 2 turns per pixel: a slide away from the band never skips one.
    let y = y0, last = start;
    for (let i = 0; i < 40; i++) {
      y += 1;
      t.ev('pointermove', band, y, { kind: 'touch', id: 7, x: 44 + 88 });
      await t.frames();
      const now = at();
      assert.ok(now - last >= 0 && now - last <= 1, `a pixel at the far end moves at most one turn (${last} to ${now})`);
      last = now;
    }
    assert.ok(last > start, 'and it did move');
    t.ev('pointerup', band, y, { kind: 'touch', id: 7, x: 44 + 88 }); await t.frames();
    assert.equal(t.geometry().scrollTop, topOf(`w${last}`) - 8, `landed on turn ${last}`);
  } finally { await t.app.close(); }
});
