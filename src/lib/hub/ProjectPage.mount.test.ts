import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #111: the project page as the Dashboard's last section, mounted in
// the Board as App mounts it. jsdom loads no srcdoc and enforces no policy:
// what a real frame does is measured in Chromium and WebKit (the issue's rig
// notes); here are the wiring, the lifetimes and the frame's identity.
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }

const counts = { todo: 1, doing: 0, review: 0, done: 0, total: 1 };
const head = (rev: number, by = 'dev') => ({ rev, by, at: 1_000 });
const dash = (page: unknown, extra: Record<string, unknown> = {}) => ({
  session: 'fixture', asks: [], board: { counts, oldest_doing: null }, agents: [], stopped: 0, finished: [],
  labels: [{ agent: 'dev', label: 'robin', aliases: [] }], generated_at: 1, page, ...extra,
});
const loaded = (rev: number, html = `<h1>rev ${rev}</h1>`, by = 'dev') => ({
  rev, by, at: 1_000, html, dir: `/w/.tmm/dashboard/${rev}`, base: `/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/${rev}/`,
  scope: { url: `http://gw.test/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/${rev}/`, prefix: 'http://gw.test/dl/s/' },
});

function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    getCaps: () => ['board_dispatch', 'dashboard', 'dashboard_page'], onCaps: () => undefined,
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    projectList: async () => ({ projects: ['fixture', 'other'].map((s) => ({ project: { id: s, session: s, name: s, room: `proj:${s}` }, live: true })) }),
    hubRooms: async () => ({ rooms: {} }),
    boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
    askCounts: async () => ({ counts: {} }),
    hubAgents: async () => ({ agents: [] }),
    boardList: async () => ({ issues: [{ id: 1, title: 'one', body: '', status: 'todo', assignee: '', created_by: 'human', notes: [] }] }),
    boardGet: async () => ({ id: 1, title: 'one', body: '', status: 'todo', assignee: '', created_by: 'human', notes: [] }),
    dashboard: async () => dash(head(1)),
    hubLog: async () => ({ messages: [], has_more: false }),
    hubUnread: async () => ({ rooms: {}, marks: {} }),
    pageLoad: async () => loaded(1),
    ...extra,
  };
}
const setup = () => (w: { Element: { prototype: object } }) => {
  (w.Element.prototype as unknown as { getAnimations: () => [] }).getAnimations = () => [];
};
const frame = (app: App) => app.document.querySelector<HTMLIFrameElement>('.page-frame');
const heading = (app: App) => app.document.querySelector('.page-sec > h2')?.textContent ?? '';

test('a published page is the last section: the preview frame, its policy and the app sheet (#111 AC3/AC4/AC5)', async (context) => {
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    const f = frame(app)!;
    assert.ok(f, 'the frame is drawn');
    assert.equal(f.getAttribute('sandbox'), 'allow-same-origin', 'the preview frame: same origin, NO scripts');
    const srcdoc = f.getAttribute('srcdoc')!;
    assert.ok(srcdoc.indexOf('Content-Security-Policy') < srcdoc.indexOf('<base href="http://gw.test/dl/s/9999999999/'), 'the policy, then the door');
    assert.ok(srcdoc.indexOf('data-tmm-base') > srcdoc.indexOf('<base') && srcdoc.indexOf('data-tmm-base') < srcdoc.indexOf('<h1>rev 1</h1>'), 'the app sheet before the author');
    const sections = [...app.document.querySelectorAll('.dash > section')];
    assert.ok(sections.at(-1)!.classList.contains('page-sec'), 'the LAST section');
    assert.match(heading(app), /^Project page · by robin · /u, 'the publisher by its label');
  } finally { await app.close(); }
});

test('no capability, or no page, or the read could not say: no section and no load (#111 AC7)', async (context) => {
  for (const [name, over] of [
    ['no cap', { getCaps: () => ['board_dispatch', 'dashboard'] }],
    ['no page', { dashboard: async () => dash(null) }],
    ['page_error first', { dashboard: async () => dash(undefined, { page_error: 'page.json is not readable' }) }],
  ] as const) {
    let loads = 0;
    const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ ...over, pageLoad: async () => { loads++; return loaded(1); } })] });
    try {
      await flush(app);
      assert.equal(app.document.querySelector('.page-sec'), null, name);
      assert.equal(loads, 0, name);
    } finally { await app.close(); }
  }
});

test('a page_error keeps the page on screen and loads nothing; an unpublish removes the section (#111, R6)', async (context) => {
  let read: unknown = dash(head(1)), loads = 0;
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ dashboard: async () => read, pageLoad: async () => { loads++; return loaded(1); } })] });
  try {
    await flush(app);
    const f = frame(app);
    read = dash(undefined, { page_error: 'busy disk' });
    await app.advance(20_000); await flush(app);
    assert.equal(frame(app), f, 'the same frame stays');
    assert.equal(loads, 1);
    read = dash(null);
    await app.advance(20_000); await flush(app);
    assert.equal(app.document.querySelector('.page-sec'), null, 'taken down: the section is gone at the next read');
  } finally { await app.close(); }
});

// AC6 / § 9: the frame is never moved or unmounted to hide it.
test('Dashboard ⇄ Board, an issue, the create form and another tab keep the SAME frame where it was (#111 AC6)', async (context) => {
  let loads = 0;
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ pageLoad: async () => { loads++; return loaded(1); } })] });
  try {
    await flush(app);
    const f = frame(app)!, parent = f.parentElement;
    const same = (why: string) => {
      assert.equal(frame(app), f, `${why}: the same element`);
      assert.ok(f.isConnected && f.parentElement === parent, `${why}: never moved`);
    };
    const seg = () => app.document.querySelectorAll<HTMLElement>('.page-head .segmented button');
    seg()[1]!.click(); await flush(app);
    same('the Board view');
    assert.ok(f.closest('[hidden]'), 'hidden, not removed');
    app.document.querySelector<HTMLElement>('button.card')!.click(); await flush(app);
    assert.ok(app.document.querySelector('.detail'), 'the issue is open');
    same('an issue open');
    app.document.querySelector<HTMLElement>('.d-head .icon-btn')!.click(); await flush(app);
    assert.equal(app.document.querySelector('.detail'), null, 'back on the list');
    seg()[0]!.click(); await flush(app);
    assert.equal(f.closest('[hidden]'), null, 'the Dashboard is shown again');
    app.document.querySelector<HTMLElement>('.page-head button[aria-label="New issue"]')!.click(); await flush(app);
    assert.ok(f.closest('[hidden]'), 'the create form hides it');
    same('the create form');
    await app.setProps({ visible: false }); await flush(app);
    same('another tab');
    await app.setProps({ visible: true }); await flush(app);
    same('back');
    assert.equal(loads, 1, 'nothing reloaded the page');
  } finally { await app.close(); }
});

test('a newer revision is adopted when nothing is in progress, and offered with Refresh while a field is edited (#111 AC6)', async (context) => {
  let read: unknown = dash(head(1)), next = loaded(1);
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ dashboard: async () => read, pageLoad: async () => next })] });
  try {
    await flush(app);
    const f = frame(app)!;
    read = dash(head(2, 'qa')); next = loaded(2, '<h1>rev 2</h1>', 'qa');
    await app.advance(20_000); await flush(app);
    assert.ok(frame(app)!.getAttribute('srcdoc')!.includes('<h1>rev 2</h1>'), 'idle: adopted');
    assert.equal(frame(app), f, 'in the same frame');
    assert.match(heading(app), /by qa/u);
    // A field typed in the kept document (the frame's document, as the app reads it).
    const d = f.contentDocument!;
    d.body.innerHTML = '<input id=n>';
    f.dispatchEvent(new app.window.Event('load'));
    const input = d.getElementById('n') as HTMLInputElement;
    input.value = 'typed';
    read = dash(head(3, 'ops')); next = loaded(3, '<h1>rev 3</h1>', 'ops');
    await app.advance(20_000); await flush(app);
    assert.ok(frame(app)!.getAttribute('srcdoc')!.includes('<h1>rev 2</h1>'), 'in progress: kept');
    assert.match(heading(app), /by qa/u, 'the header names the LOADED revision\u2019s publisher');
    assert.match(app.document.querySelector('.page-line')?.textContent ?? '', /A newer page by ops is waiting\.[\s\S]*Refresh/u);
    // Refresh with an edited field asks through the discard confirm first.
    app.document.querySelector<HTMLElement>('.page-refresh')!.click(); await flush(app);
    assert.match(app.document.body.textContent ?? '', /What you typed in the project page will be lost\./u);
    assert.ok(frame(app)!.getAttribute('srcdoc')!.includes('<h1>rev 2</h1>'), 'nothing replaced before the answer');
    [...app.document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Discard')!.click(); await flush(app);
    assert.ok(frame(app)!.getAttribute('srcdoc')!.includes('<h1>rev 3</h1>'), 'discarded: the newest loads');
  } finally { await app.close(); }
});

test('an edited page field holds the Board\u2019s project pick behind the existing discard confirm (#111 AC6)', async (context) => {
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    const f = frame(app)!;
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    const ta = f.contentDocument!.getElementById('t') as HTMLTextAreaElement;
    ta.value = 'half a thought'; // no event: WebKit delivers none to the app; the page clock reads the DOM
    await app.advance(1000); await flush(app);
    const other = [...app.document.querySelectorAll<HTMLElement>('.p-row, .side-row, [data-session]')].find((r) => (r.textContent ?? '').includes('other'));
    assert.ok(other, 'the sidebar row of the other project');
    other!.click(); await flush(app);
    assert.match(app.document.body.textContent ?? '', /Discard unsaved changes\?[\s\S]*What you typed in the project page will be lost\./u, 'the existing discard confirm asks, naming what is lost');
    assert.equal(frame(app), f, 'still this project\u2019s page');
    await app.setProps({ session: 'other' }); await flush(app);
    assert.equal(frame(app), f, 'the follow of the last-touched session waits too');
  } finally { await app.close(); }
});

test('a late load for a project left behind is dropped (#111 AC7)', async (context) => {
  let release!: (v: unknown) => void;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ pageLoad: (s: string) => (s === 'fixture' ? new Promise((ok) => { release = ok; }) : Promise.resolve(loaded(7, '<p>other</p>'))) })],
  });
  try {
    await flush(app);
    assert.equal(frame(app), null, 'nothing before the first success');
    await app.setProps({ session: 'other' }); await flush(app);
    release(loaded(1, '<p>fixture</p>')); await flush(app);
    const srcdoc = frame(app)?.getAttribute('srcdoc') ?? '';
    assert.ok(!srcdoc.includes('<p>fixture</p>'), 'the old project\u2019s page never lands');
  } finally { await app.close(); }
});

test('a link opens its file in the app, resolved from the revision folder, through the frame\u2019s hash (#111 AC3, W1)', async (context) => {
  const opened: [string, string][] = [];
  const html = '<a href="report.html">r</a><a href="../../../EP/out/mix.mp3">m</a><a href="javascript:alert(1)">j</a>';
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, onOpenFile: (s: string, p: string) => opened.push([s, p]) }, setup: setup(), modules: [rpc({ pageLoad: async () => loaded(1, html) })] });
  try {
    await flush(app);
    const f = frame(app)!;
    const srcdoc = f.getAttribute('srcdoc')!;
    assert.ok(!srcdoc.includes('report.html') && !srcdoc.includes('mix.mp3'), 'the page holds no target: the parent keeps the table');
    const nonce = /about:srcdoc#tmm-link-([0-9a-f]+)-0/u.exec(srcdoc)![1];
    f.dispatchEvent(new app.window.Event('load'));
    for (const n of [0, 1, 2]) {
      f.contentWindow!.location.hash = `#tmm-link-${nonce}-${n}`;
      await app.advance(600); await flush(app);
    }
    assert.deepEqual(opened, [['fixture', '/w/.tmm/dashboard/1/report.html'], ['fixture', '/w/EP/out/mix.mp3']], 'a javascript: link is dead');
    // Hidden, the watcher reads nothing.
    app.document.querySelector<HTMLElement>('.page-head .segmented')!.querySelectorAll('button')[1]!.click(); await flush(app);
    f.contentWindow!.location.hash = `#tmm-link-${nonce}-0`;
    await app.advance(600); await flush(app);
    assert.equal(opened.length, 2, 'nothing routed while the page is hidden');
  } finally { await app.close(); }
});

// ── Validator's HOLD at 8a4c9a1e (note 30), ruled in leader note 31 ──

const solo = compileMount(new URL('./ProjectPage.svelte', import.meta.url), []);
const wireFrame = (app: App) => {
  const f = frame(app)!;
  f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
  f.dispatchEvent(new app.window.Event('load'));
  return { f, ta: f.contentDocument!.getElementById('t') as HTMLTextAreaElement };
};

test('F1: a field edited, then hidden before the page clock read it, still asks before the project is left', async (context) => {
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    const { f, ta } = wireFrame(app);
    ta.value = 'a fast draft'; // no clock tick between the typing and the hide
    app.document.querySelectorAll<HTMLElement>('.page-head .segmented button')[1]!.click(); await flush(app);
    assert.ok(f.closest('[hidden]'));
    await app.advance(5000); await flush(app);
    const other = [...app.document.querySelectorAll<HTMLElement>('.p-row, .side-row, [data-session]')].find((r) => (r.textContent ?? '').includes('other'))!;
    other.click(); await flush(app);
    assert.match(app.document.body.textContent ?? '', /What you typed in the project page will be lost\./u, 'the leave door read the live document');
    assert.equal(frame(app), f, 'the edited document stays until the answer');
  } finally { await app.close(); }
});

test('F2: an edit begun while an adoption\u2019s load is in flight keeps the page; the newer one is offered', async (context) => {
  let read: unknown = dash(head(1)), calls = 0, release!: (v: unknown) => void;
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ dashboard: async () => read, pageLoad: () => { calls++; return calls === 1 ? Promise.resolve(loaded(1)) : new Promise((ok) => { release = ok; }); } })] });
  try {
    await flush(app);
    const { f, ta } = wireFrame(app);
    const before = f.getAttribute('srcdoc');
    read = dash(head(2, 'qa'));
    await app.advance(20_000); await flush(app);
    assert.equal(calls, 2, 'requested while idle');
    ta.value = 'started after the request';
    release(loaded(2, '<h1>rev 2</h1>', 'qa')); await flush(app);
    assert.equal(f.getAttribute('srcdoc'), before, 'the apply edge read the live document: not replaced');
    await app.advance(1000); await flush(app);
    assert.match(app.document.querySelector('.page-line')?.textContent ?? '', /A newer page by qa is waiting\./u, 'offered instead');
  } finally { await app.close(); }
});

test('S1: a link seen in the OLD owner\u2019s frame is never routed after the owner changes', async (context) => {
  const opened: string[] = [];
  const first = { ...loaded(1, '<a href="clip.md">open</a>'), dir: '/owner-a/.tmm/dashboard/1' };
  const app = await (await solo).mount(context, { props: { api: { pageLoad: async () => first }, session: 'fixture', head: head(1), visible: true, onOpenFile: (p: string) => opened.push(`A:${p}`) }, setup: setup(), modules: [] });
  try {
    await flush(app);
    const f = frame(app)!;
    f.dispatchEvent(new app.window.Event('load'));
    const nonce = /about:srcdoc#tmm-link-([0-9a-f]+)-0/u.exec(f.getAttribute('srcdoc')!)![1];
    f.contentWindow!.location.hash = `#tmm-link-${nonce}-0`;
    await app.advance(50); await flush(app); // seen, waiting for its own back
    await app.setProps({ api: { pageLoad: () => new Promise(() => {}) }, onOpenFile: (p: string) => opened.push(`B:${p}`) }); await flush(app);
    // A removed frame has no document in real Chromium and WebKit (validator, note 30: both measured null).
    Object.defineProperty(f, 'contentDocument', { configurable: true, get: () => null });
    await app.advance(500); await flush(app);
    assert.deepEqual(opened, [], 'the old intent is retired with its frame');
  } finally { await app.close(); }
});
