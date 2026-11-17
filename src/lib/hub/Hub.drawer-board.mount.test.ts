// Board #147: the Hub drawer's board offers the Dashboard, through the real Hub wiring (the
// drawer-fit test's fixture shape; jsdom has no layout, a ResizeObserver says 1234 px).
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

let compilation: ReturnType<typeof compileMount> | undefined;
const compiledHub = () => compilation ??= compileMount(new URL('./Hub.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<ReturnType<typeof compiledHub>>['mount']>>;
async function flush(app: App, n = 12) { for (let i = 0; i < n; i++) await app.flush(); }

const counts = { todo: 1, doing: 0, review: 0, done: 0, total: 1 };
const issue = { id: 1, title: 'one', body: '', status: 'todo', assignee: '', created_by: 'human', notes: [] };
const page = (html: string) => ({ rev: 1, by: 'dev', at: 1000, html, dir: '/fixture/.tmm/dashboard/1', base: '/dl/s/9999999999/1.2/sig/L2Y/.tmm/dashboard/1/', scope: { url: 'http://gw.test/dl/s/9999999999/1.2/sig/L2Y/.tmm/dashboard/1/', prefix: 'http://gw.test/dl/s/' } });

async function mountHub(context: test.TestContext, over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  let back: (() => boolean) | null = null;
  const projects = ['fixture', 'other'].map((s) => ({ project: { id: s, name: s, session: s, path: `/${s}`, room: `proj:${s}` }, live: true, slots: [] }));
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: false, onGoBack: (fn: () => boolean) => { back = fn; }, ...props },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      // jsdom has no canvas; a room switch here may draw an avatar or a terminal glyph.
      window.HTMLCanvasElement.prototype.getContext = (() => null) as never;
      window.localStorage.setItem('tmux_hub_sidebar', '1');
      // jsdom keeps no joint history for a frame: its back is what Chromium and WebKit measured
      // (#111 note 19): the frame's fragment entry is popped, the frame's hash returns.
      window.history.back = () => { for (const f of window.document.querySelectorAll('iframe')) { const d = (f as HTMLIFrameElement).contentDocument; if (d?.location.hash.startsWith('#tmm-link-')) (f as HTMLIFrameElement).contentWindow!.location.hash = ''; } };
      window.ResizeObserver = class { cb: (e: unknown[]) => void; constructor(cb: (e: unknown[]) => void) { this.cb = cb; } observe(el: Element) { this.cb([{ target: el, contentRect: { width: 1234, height: 700 } }]); } unobserve() {} disconnect() {} } as never;
    },
    modules: [{
      projectList: async () => ({ projects }), boardCounts: async () => ({ counts: { fixture: counts, other: counts } }), askCounts: async () => ({ counts: {} }),
      listSessionsWithPanes: async () => ({ panes: [] }), hubRooms: async () => ({ rooms: {}, states: {} }), hubUnread: async () => ({ rooms: {}, marks: {} }), hubRead: async () => ({ rooms: {} }),
      registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }),
      hubAgents: async () => ({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' }] }),
      hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
      addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined, addAgentRenamedListener: () => undefined, removeAgentRenamedListener: () => undefined,
      getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team', 'dashboard', 'dashboard_page'], onCaps: () => undefined,
      boardList: async () => ({ issues: [issue] }), boardGet: async () => issue,
      dashboard: async (s: string) => ({ session: s, asks: [], board: { counts, oldest_doing: null }, agents: [], stopped: 0, finished: [], labels: [], generated_at: 1, page: { rev: 1, by: 'dev', at: 1000 } }),
      pageLoad: async () => page('<h1>page</h1><a href="../../../docs">docs</a><textarea id=t></textarea>'),
      fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }), fsStat: async (p: string) => ({ name: p.split('/').pop(), path: p, size: 0, is_dir: true }),
      fsRead: async () => ({ content: 'abc' }), getPrefs: async () => ({}), setPref: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }),
      ...over,
    }],
  });
  await flush(app);
  for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
  return { app, back: () => back!() };
}
const headBtn = (app: App, label: string) => app.document.querySelector<HTMLButtonElement>(`.page-head [aria-label="${label}"]`)!;
const frame = (app: App) => app.document.querySelector<HTMLIFrameElement>('.drawer .page-frame');
const boardBody = (app: App) => app.document.querySelector<HTMLElement>('.drawer .board-body');

test('the board partition mounts at its first showing and is kept, hidden, across partition changes (#147 Q2)', { timeout: 60000 }, async (context) => {
  let loads = 0;
  const { app } = await mountHub(context, { pageLoad: async () => { loads++; return page('<h1>page</h1>'); } });
  try {
    headBtn(app, 'Files').click(); await flush(app);
    assert.ok(app.document.querySelector('.drawer'), 'the drawer opened on Files');
    assert.equal(boardBody(app), null, 'a drawer opened on Files alone mounts no board, no Dashboard, no frame');
    assert.equal(loads, 0);
    headBtn(app, 'Board').click(); await flush(app, 20);
    const f = frame(app)!;
    assert.ok(f, 'the board partition shows the Dashboard with its page');
    assert.equal(app.document.querySelector('.drawer .embedded-switch .segmented, .drawer .embedded-switch [role=radiogroup]') !== null, true, 'the switch at the top of its body');
    headBtn(app, 'Files').click(); await flush(app);
    assert.ok(boardBody(app)!.hidden, 'another partition: kept, hidden');
    assert.equal(frame(app), f, 'the same frame element');
    headBtn(app, 'Board').click(); await flush(app);
    assert.equal(frame(app), f, 'shown again: still the same');
    assert.ok(!boardBody(app)!.hidden);
    assert.equal(loads, 1, 'nothing reloaded');
  } finally { await app.close(); }
});

test('a page link opens the drawer\u2019s Files, and Back returns to the SAME Dashboard (#147 (3))', { timeout: 60000 }, async (context) => {
  const { app, back } = await mountHub(context);
  try {
    headBtn(app, 'Board').click(); await flush(app, 20);
    const f = frame(app)!;
    f.dispatchEvent(new app.window.Event('load'));
    const nonce = /about:srcdoc#tmm-link-([0-9a-f]+)-0/u.exec(f.getAttribute('srcdoc')!)![1];
    f.contentWindow!.location.hash = `#tmm-link-${nonce}-0`;
    for (let i = 0; i < 10; i++) { await app.advance(100); await flush(app, 4); }
    assert.ok(app.document.querySelector('.drawer .files-body'), 'the drawer shows its Files partition');
    assert.ok(boardBody(app)!.hidden, 'the board kept behind it');
    for (let i = 0; i < 4 && boardBody(app)!.hidden; i++) { assert.equal(back(), true, 'each Back is consumed by the drawer'); await flush(app); }
    assert.ok(!boardBody(app)!.hidden, 'Back returned to the board partition');
    assert.equal(frame(app), f, 'the SAME kept Dashboard and frame');
    assert.ok(app.document.querySelector('.drawer'), 'the drawer did not close');
  } finally { await app.close(); }
});

test('closing the drawer with an edited page field asks Keep/Discard; Keep keeps it, Discard closes (#147 Q3)', { timeout: 60000 }, async (context) => {
  const { app } = await mountHub(context);
  try {
    headBtn(app, 'Board').click(); await flush(app, 20);
    const f = frame(app)!;
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'half a thought';
    app.document.querySelector<HTMLElement>('.drawer .drawer-head [aria-label="Close"]')!.click(); await flush(app);
    assert.match(app.document.body.textContent ?? '', /What you typed in the project page will be lost\./u, 'the existing discard confirm asks');
    assert.equal(frame(app), f, 'nothing closed yet');
    const open = () => headBtn(app, 'Board').getAttribute('aria-expanded');
    assert.equal(open(), 'true');
    [...app.document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Keep editing')!.click(); await flush(app);
    assert.equal(frame(app), f, 'Keep: the drawer and its page stay');
    assert.equal(open(), 'true');
    app.document.querySelector<HTMLElement>('.drawer .drawer-head [aria-label="Close"]')!.click(); await flush(app);
    [...app.document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Discard')!.click();
    await flush(app, 20);
    // jsdom does not finish the drawer's withdraw motion, so the unmount after it is not seen
    // here; the close itself is: the toggle no longer says open (termOpen false).
    assert.equal(open(), 'false', 'Discard: the drawer closes');
  } finally { await app.close(); }
});

test('a room switch while the drawer board holds an edit: the drawer stays and names the project it shows (#147 (4))', { timeout: 60000 }, async (context) => {
  const { app } = await mountHub(context);
  try {
    headBtn(app, 'Board').click(); await flush(app, 20);
    const label = () => app.document.querySelector('.drawer .drawer-head .d-files')?.textContent ?? '';
    assert.match(label(), /fixture$/u);
    const f = frame(app)!;
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'draft';
    const other = [...app.document.querySelectorAll<HTMLElement>('.side-row, [data-session], .p-row')].find((r) => /other/u.test(r.textContent ?? ''));
    assert.ok(other, 'the other room in the Hub sidebar');
    // The row's own pick button, the control a person taps (validator #147 note 16: the row's
    // group alone switches nothing), and proof that the gesture applied: the chat is Other.
    other!.querySelector<HTMLButtonElement>('.proj-pick')!.click(); await flush(app, 20);
    assert.match(app.document.querySelector('.h1-text')?.textContent ?? '', /other/u, 'precondition: the chat really changed rooms');
    assert.ok(app.document.querySelector('.drawer'), 'the drawer was not closed under the edit');
    assert.equal(frame(app), f, 'the edited page stays');
    assert.match(label(), /fixture$/u, 'and the head names the project the board shows, not the room');
  } finally { await app.close(); }
});

// Validator #147 note 15 (F1, leader note 18): while the drawer holds the OLD project's board, a
// door of its Dashboard that lands in the chat first selects the item's own project.
async function holdOldProject(app: App) {
  headBtn(app, 'Board').click(); await flush(app, 20);
  const f = frame(app)!;
  f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
  f.dispatchEvent(new app.window.Event('load'));
  (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'held';
  const row = [...app.document.querySelectorAll<HTMLElement>('.side-row, [data-session], .p-row')].find((e) => /other/u.test(e.textContent ?? ''))!;
  row.querySelector<HTMLButtonElement>('.proj-pick')!.click(); await flush(app, 20);
  assert.match(app.document.querySelector('.h1-text')?.textContent ?? '', /other/u, 'precondition: the chat really changed rooms');
  assert.match(app.document.querySelector('.drawer-head .d-files')?.textContent ?? '', /fixture$/u, 'precondition: the drawer holds the old project');
}
const withAgent = { dashboard: async (s: string) => ({ session: s, asks: [{ seq: 9, asker: 'alice', question: 'Which?' }], board: { counts, oldest_doing: null }, agents: [{ name: 'alice', state: 'running', detail: '', since: 1000, managed: true, window: 0 }], stopped: 0, finished: [], labels: [], generated_at: 1, page: { rev: 1, by: 'dev', at: 1000 } }),
  hubLog: async () => ({ messages: [{ seq: 5, id: 'm5', ts: 5000, from: 'alice', to: ['human'], body: 'a note for you', kind: 'msg' }], has_more: false }) };

for (const [door, pick] of [
  ['an agent row', (app: App) => app.document.querySelector<HTMLElement>('.drawer .dash-agent')],
  ['a note', (app: App) => app.document.querySelector<HTMLElement>('.drawer .dash-note-row')],
  ['All in chat', (app: App) => app.document.querySelector<HTMLElement>('.drawer .dash-more')],
] as const) {
  test(`${door} of the held old project's Dashboard lands the chat in THAT project (#147 F1)`, { timeout: 60000 }, async (context) => {
    const { app } = await mountHub(context, withAgent);
    try {
      await holdOldProject(app);
      const el = pick(app);
      assert.ok(el, door);
      el!.click(); await flush(app, 20);
      assert.match(app.document.querySelector('.h1-text')?.textContent ?? '', /fixture/u, `${door}: the chat selects the item's own project`);
    } finally { await app.close(); }
  });
}
