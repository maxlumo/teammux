import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { feedBlocks } from './hub.ts';

// Board #295 (validator P1): a run riding in its reply's bubble is part of
// the card, but reading it is not a tap on the message. A click on its head,
// a row, or "show all" must never open (or close) the message's action row.
const compiled = compileMount(new URL('./Feed.svelte', import.meta.url), []);

test('clicks inside a reply\u2019s run never reach the bubble; the bubble itself still opens its row (#295)', async (context) => {
  const tool = (ts: number, text: string) => ({ id: ts, ts, window: 'dev', kind: 'tool' as const, tool: 'Read', text });
  const blocks = feedBlocks([{ id: 'r', ts: 100, from: 'dev', body: 'fixed it' }],
    Array.from({ length: 8 }, (_, i) => tool(10 + i, `f${i}.rs`)), 'tools', (n) => n);
  const app = await (await compiled).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev'], stepsRows: 3,
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }] },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [],
  });
  try {
    const q = (s: string) => app.document.querySelector<HTMLElement>(s);
    const acts = () => app.document.querySelectorAll('.m-acts').length;
    for (let i = 0; i < 4; i++) await app.flush();
    q('.bubble .steps .s-head')!.click(); await app.flush();
    assert.ok(q('.bubble .steps.open'), 'the head unfolds the run');
    assert.equal(acts(), 0, 'the head is not a tap on the message');
    q('.bubble .steps .step')!.click(); await app.flush();
    assert.equal(acts(), 0, 'a row is not a tap on the message');
    q('.bubble .steps .s-all')!.click(); await app.flush();
    assert.equal(acts(), 0, '"show all" is not a tap on the message');
    q('.bubble .m-body')!.click(); await app.flush();
    assert.equal(acts(), 1, 'the words still open the action row');
  } finally { await app.close(); }
});

// Board #304 (owner 2026-10-03: "双击钉住的用户消息 可以跳到那个消息的位置"):
// a HELD user bubble, double-clicked (mouse) or double-tapped (touch, the
// terminal's createDoubleTapDetector), jumps the feed to the message's natural
// position. It neither expands nor unpins it; a single tap still opens the row.
test('double-click / double-tap on the held user bubble jumps to its natural position (#304)', async (context) => {
  const blocks = feedBlocks([
    { id: 'a', ts: 100, from: 'dev', body: 'earlier reply' },
    { id: 'q', ts: 200, from: 'human', body: 'the question' },
    { id: 'b', ts: 300, from: 'dev', body: 'later reply' },
  ], [], 'chat', (n) => n);
  const app = await (await compiled).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev'],
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }] },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [],
  });
  try {
    const q = (s: string) => app.document.querySelector<HTMLElement>(s);
    const frames = async () => { for (let i = 0; i < 4; i++) { await app.advance(20); await app.flush(); } };
    await frames();
    const feed = q('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 3000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => 500, configurable: true });
    const ask = q('[data-ask]')!;
    Object.defineProperty(ask, 'offsetTop', { get: () => 2000, configurable: true });
    Object.defineProperty(ask, 'offsetHeight', { get: () => 60, configurable: true });
    // Read upward from below: the question is caught at the bottom edge.
    const scrollTo = async (top: number) => { feed.scrollTop = top; feed.dispatchEvent(new app.window.Event('scroll')); await frames(); };
    await scrollTo(1200); await scrollTo(800); await scrollTo(400);
    assert.ok(q('.msg.held.ask-bottom'), 'the question is held at the bottom edge');
    const bubble = q('.msg.held .bubble')!;
    bubble.click(); await app.flush();
    assert.equal(app.document.querySelectorAll('.m-acts').length, 1, 'a single tap on a held bubble still opens its row');
    bubble.click(); await app.flush();
    bubble.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
    await frames();
    assert.equal(feed.scrollTop, 1992, 'double-click lands on the natural position (8px above)');
    assert.ok(!q('.m-unfold[aria-expanded="true"]'), 'nothing was expanded');
    assert.equal(app.document.querySelectorAll('.m-acts').length, 0, 'no action row is left open');
    // Touch: two quick taps through the shared detector.
    await scrollTo(800); await scrollTo(400);
    const held = q('.msg.held .bubble')!;
    const tap = (t: number) => {
      const e = new app.window.MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 50 });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      Object.defineProperty(e, 'timeStamp', { value: t });
      held.dispatchEvent(e);
      held.click();
    };
    tap(1000); await app.flush();
    tap(1150); await frames();
    assert.equal(feed.scrollTop, 1992, 'a double-tap lands on the same position');
    assert.equal(app.document.querySelectorAll('.m-acts').length, 0, 'the pair\u2019s second click does not reopen the row');
  } finally { await app.close(); }
});

// Board #298: a run its reply has not ended is the reply's shape without
// words — head outside, bubble, the same lane — open only while it runs.
test('a standalone run is an agent bubble holding the lane; it is open while running, folded once stopped (#298)', async (context) => {
  const tool = (ts: number, text: string) => ({ id: ts, ts, window: 'dev', kind: 'tool' as const, tool: 'Read', text });
  const blocks = feedBlocks([], [tool(10, 'a.rs'), tool(11, 'b.rs')], 'tools', (n) => n);
  const mount = async (state: string) => (await compiled).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev'], stepsRows: 3,
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'codex', state, model: 'gpt-6' }] },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [],
  });
  const running = await mount('running');
  try {
    for (let i = 0; i < 4; i++) await running.flush();
    const q = (s: string) => running.document.querySelector<HTMLElement>(s);
    assert.equal(q('.msg > .m-head .m-who')?.textContent, 'dev', 'the name heads it from outside, as on a reply');
    assert.ok(q('.msg > .bubble > .steps.open .s-live'), 'inside an agent bubble, open, pulsing while it runs');
    assert.ok(!q('.m-body'), 'and no words');
  } finally { await running.close(); }
  const idle = await mount('idle');
  try {
    for (let i = 0; i < 4; i++) await idle.flush();
    const q = (s: string) => idle.document.querySelector<HTMLElement>(s);
    assert.ok(q('.msg > .bubble > .steps:not(.open) .chev'), 'a stopped run folds like a carried one');
    q('.steps .s-head')!.click(); await idle.flush();
    assert.ok(q('.steps.open'), 'and opens on its head');
  } finally { await idle.close(); }
});

// Board #331: one sender's consecutive bubbles show the name once; each
// bubble keeps its own time and action row.
test('a run of one sender shows its header once; every bubble keeps its own actions (#331)', async (context) => {
  const t0 = new Date(2026, 9, 9, 12, 0).getTime();
  const blocks = feedBlocks([
    { id: 'a', ts: t0, from: 'dev', body: 'one' },
    { id: 'b', ts: t0 + 1_000, from: 'dev', body: 'two' },
    { id: 'c', ts: t0 + 2_000, from: 'dev', body: 'three' },
    { id: 'd', ts: t0 + 3_000, from: 'qa', body: 'mine now' },
    { id: 'e', ts: t0 + 4_000, from: 'dev', body: 'back' },
  ], [], 'chat', (n) => n);
  const app = await (await compiled).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev', 'qa'],
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }, { name: 'qa', window: 1, managed: true, agent: 'codex', state: 'idle' }] },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [],
  });
  try {
    for (let i = 0; i < 4; i++) await app.flush();
    const msgs = [...app.document.querySelectorAll<HTMLElement>('.msg')];
    assert.deepEqual(msgs.map((m) => m.dataset.msg), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(msgs.map((m) => m.querySelector('.m-who')?.textContent ?? ''), ['dev', '', '', 'qa', 'dev'], 'the name once per run');
    assert.deepEqual(msgs.map((m) => m.classList.contains('cont')), [false, true, true, false, false]);
    assert.ok(msgs.every((m) => m.querySelector('.m-meta, .bubble')), 'every bubble is still a bubble');
    msgs[2]!.querySelector<HTMLElement>('.m-body')!.click(); await app.flush();
    assert.equal(app.document.querySelectorAll('.m-acts').length, 1, 'a continued bubble opens its own action row');
  } finally { await app.close(); }
});

// Board #372 (owner 2026-10-14: a long or picture-bearing human message that
// is scrolled to expanded in full and flashed; "scrolled to, keep it folded").
// The cause was `.msg.held .shots { display: none }`: a held bubble was 112px,
// the same message in flow 322px. Now the picture is behind the fold in EVERY
// state, so what the bubble holds does not depend on the pin. jsdom has no
// layout, so what is pinned is the CONTENT (identical held or not, no strip
// for the pin to hide) and the explicit unfold being the only way it grows;
// the pixels are the real browser's (the measurements on #372).
// (Bound to one server's scope: the strip's ChatImage signs through the scope's API.)
const compiledScoped = compileMount(new URL('./Feed.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
test('a folded picture message has the same content held and in flow; only Expand brings the strip (#372)', async (context) => {
  const blocks = feedBlocks([
    { id: 'a', ts: 100, from: 'dev', body: 'earlier reply' },
    { id: 'q', ts: 200, from: 'human', body: 'what is this?\n![](/work/fixture/.tmm/uploads/a-12345678.webp)' },
    { id: 'b', ts: 300, from: 'dev', body: 'later reply' },
  ], [], 'chat', (n) => n);
  const app = await (await compiledScoped).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev'],
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }] },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{ fsDownloadHttp: async (path: string) => ({ url: `https://dl.test/?p=${encodeURIComponent(path)}` }) }],
  });
  try {
    const q = (s: string) => app.document.querySelector<HTMLElement>(s);
    const frames = async () => { for (let i = 0; i < 4; i++) { await app.advance(20); await app.flush(); } };
    await frames();
    const feed = q('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 3000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => 500, configurable: true });
    const ask = q('[data-ask]')!;
    Object.defineProperty(ask, 'offsetTop', { get: () => 2000, configurable: true });
    Object.defineProperty(ask, 'offsetHeight', { get: () => 60, configurable: true });
    const scrollTo = async (top: number) => { feed.scrollTop = top; feed.dispatchEvent(new app.window.Event('scroll')); await frames(); };
    const content = () => q('[data-ask] .bubble')!.innerHTML;
    const inFlow = content();
    assert.ok(!q('[data-ask].held'), 'in flow: not held');
    assert.equal(q('[data-ask] .shots'), null, 'the picture is behind the fold');
    assert.equal(q('[data-ask] .m-imgs')?.textContent, '[Image]', 'and the bubble says it is there');
    assert.ok(q('[data-ask] .m-unfold'), 'with the control that opens it');
    await scrollTo(1200); await scrollTo(800); await scrollTo(400);
    assert.ok(q('.msg.held.ask-bottom'), 'now the question is held at the bottom edge');
    assert.equal(content(), inFlow, 'held or in flow the bubble holds exactly the same content: nothing for the pin to hide or reveal');
    // The one way it grows: the reader's Expand. It unpins the message and brings the strip.
    q('.msg.held .m-unfold')!.click(); await frames();
    assert.ok(q('[data-ask] .shots'), 'Expand shows the strip');
    assert.equal(q('[data-ask] .m-imgs'), null, 'and the marker line goes');
    assert.ok(!q('.msg.held'), 'an expanded message is never pinned');
  } finally { await app.close(); }
});

// Board #467: the feed follows its OWN size. Whatever shrinks its box (the
// composer growing under it, a chip row, the keyboard), its ResizeObserver
// runs the reading transaction, and a follower re-takes the tail — the one
// mechanism since Hub's shell-height notification was deleted.
test('a follower whose feed box shrinks re-takes the tail through the feed\u2019s own ResizeObserver; an unchanged size writes nothing (#467)', async (context) => {
  const blocks = feedBlocks([
    { id: 'a', ts: 100, from: 'dev', body: 'one' },
    { id: 'q', ts: 200, from: 'human', body: 'two' },
    { id: 'b', ts: 300, from: 'dev', body: 'three' },
  ], [], 'chat', (n) => n);
  const observed: { el: Element; cb: () => void }[] = [];
  const app = await (await compiled).mount(context, {
    props: { selected: 'fixture', roomReady: true, visible: true, blocks, managedNames: ['dev'],
      agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }] },
    setup(window: any) {
      window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null;
      window.ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; }
        observe(el: Element) { observed.push({ el, cb: this.cb }); }
        unobserve() {} disconnect() {}
      };
    },
    modules: [],
  });
  try {
    const frames = async () => { for (let i = 0; i < 4; i++) { await app.advance(20); await app.flush(); } };
    await frames();
    const feed = app.document.querySelector<HTMLElement>('.feed')!;
    let height = 500;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 3000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => height, configurable: true });
    Object.defineProperty(feed, 'clientWidth', { get: () => 390, configurable: true });
    const resize = async () => { for (const o of observed) if (o.el === feed) o.cb(); await frames(); };
    assert.ok(observed.some((o) => o.el === feed), 'the feed observes its own box');
    // At the tail, and the reading size recorded.
    feed.scrollTop = 2500; feed.dispatchEvent(new app.window.Event('scroll')); await frames();
    await resize();
    feed.scrollTop = 2500;
    await resize();
    assert.equal(feed.scrollTop, 2500, 'the same size again: no tail write');
    // The composer grows under the feed: the box is 100px shorter.
    height = 400;
    await resize();
    assert.equal(feed.scrollTop, 3000, 'the follower is back at the tail, by the feed\u2019s own observer');
  } finally { await app.close(); }
});
