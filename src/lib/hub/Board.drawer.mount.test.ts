import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { boardViewOf, rememberBoardView, BOARD_VIEW_KEY, DRAWER_VIEW_KEY } from './dashboard.ts';

// Board #147 (the owner, 2026-11-17 02:10): the Hub drawer's embedded board offers the
// Dashboard too. The embedded Board as the Drawer mounts it.
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }

const counts = { todo: 1, doing: 0, review: 0, done: 0, total: 1 };
const issue = { id: 1, title: 'one', body: '', status: 'todo', assignee: '', created_by: 'human', notes: [] };
const dash = () => ({ session: 'fixture', asks: [], board: { counts, oldest_doing: null }, agents: [], stopped: 0, finished: [], labels: [], generated_at: 1, page: { rev: 1, by: 'dev', at: 1000 } });
const loaded = () => ({ rev: 1, by: 'dev', at: 1000, html: '<h1>page</h1><textarea id=t></textarea>', dir: '/w/.tmm/dashboard/1', base: '/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/1/', scope: { url: 'http://gw.test/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/1/', prefix: 'http://gw.test/dl/s/' } });
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    getCaps: () => ['board_dispatch', 'dashboard', 'dashboard_page'], onCaps: () => undefined,
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    projectList: async () => ({ projects: ['fixture', 'other'].map((s) => ({ project: { id: s, session: s, name: s, room: `proj:${s}` }, live: true })) }),
    hubRooms: async () => ({ rooms: {} }), boardCounts: async () => ({ counts: { fixture: counts, other: counts } }), askCounts: async () => ({ counts: {} }),
    hubAgents: async () => ({ agents: [] }), boardList: async () => ({ issues: [issue] }), boardGet: async () => issue,
    dashboard: async () => dash(), hubLog: async () => ({ messages: [], has_more: false }), hubUnread: async () => ({ rooms: {}, marks: {} }),
    pageLoad: async () => loaded(),
    ...extra,
  };
}
const setup = (store: Record<string, string> = {}) => (w: { Element: { prototype: object }; localStorage: Storage }) => {
  (w.Element.prototype as unknown as { getAnimations: () => [] }).getAnimations = () => [];
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
};
type Guard = { ask: (a: () => void) => void; dirty: () => boolean };
const seg = (app: App) => [...app.document.querySelectorAll<HTMLElement>('.embedded-switch .segmented button, .embedded-switch [role=radio]')];
const dashShown = (app: App) => { const d = app.document.querySelector('.dash'); return !!d && !d.closest('[hidden]'); };

test('the view memory is one function pair, keyed per host (#147)', () => {
  const store = new Map<string, string>();
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(boardViewOf(s, DRAWER_VIEW_KEY), 'dashboard', 'Dashboard by default (D2)');
  rememberBoardView('board', s, DRAWER_VIEW_KEY);
  assert.equal(boardViewOf(s, DRAWER_VIEW_KEY), 'board');
  assert.equal(boardViewOf(s, BOARD_VIEW_KEY), 'dashboard', 'the Board tab keeps its own');
  assert.deepEqual([BOARD_VIEW_KEY, DRAWER_VIEW_KEY], ['tmux_board_view', 'tmux_drawer_board_view']);
});

test('the drawer board offers the switch in its body, Dashboard by default, remembering its OWN choice (#147 AC1)', async (context) => {
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true }, setup: setup({ tmux_board_view: 'board' }), modules: [rpc()] });
  try {
    await flush(app);
    assert.ok(dashShown(app), 'Dashboard by default, whatever the Board tab chose');
    assert.ok(app.document.querySelector('.page-frame'), 'the same Dashboard, with its project page');
    assert.equal(seg(app).length, 2);
    seg(app).find((b) => b.textContent?.trim() === 'Board')!.click(); await flush(app);
    assert.ok(!dashShown(app), 'the Board view');
    assert.equal(app.window.localStorage.getItem('tmux_drawer_board_view'), 'board');
    assert.equal(app.window.localStorage.getItem('tmux_board_view'), 'board', 'the tab\u2019s own choice untouched');
  } finally { await app.close(); }
  const again = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true }, setup: setup({ tmux_drawer_board_view: 'board' }), modules: [rpc()] });
  try {
    await flush(again);
    assert.ok(!dashShown(again), 'its own memory comes back');
  } finally { await again.close(); }
});

test('an issue request or a create request from the chat still shows the issue or the form (#147 AC1)', async (context) => {
  for (const props of [{ issueRequest: { session: 'fixture', id: 1, n: 1 } }, { createRequest: { n: 1 } }]) {
    // As the drawer sends them: after the board is up (the head's +, a feed board line).
    const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true, issueRequest: null, createRequest: null }, setup: setup(), modules: [rpc()] });
    try {
      await flush(app);
      assert.ok(dashShown(app), 'the Dashboard first');
      await app.setProps(props); await flush(app);
      assert.ok(!dashShown(app), JSON.stringify(props));
      assert.ok(app.document.querySelector('.detail, .create, form, [class*=create]'), `${JSON.stringify(props)}: the issue or the form`);
      assert.equal(app.document.querySelector('.embedded-switch'), null, 'and no switch over it');
    } finally { await app.close(); }
  }
});

test('hidden (another partition, the drawer closed), the drawer board reads nothing (#147 AC5)', async (context) => {
  let asked = 0, loads = 0;
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: false, embedded: true }, setup: setup(), modules: [rpc({ dashboard: async () => { asked++; return dash(); }, pageLoad: async () => { loads++; return loaded(); } })] });
  try {
    await flush(app);
    await app.advance(60_000); await flush(app);
    assert.deepEqual([asked, loads], [0, 0], 'nothing read while hidden');
    await app.setProps({ visible: true }); await flush(app);
    assert.ok(asked >= 1 && loads === 1, 'shown: it reads');
    const f = app.document.querySelector('.page-frame');
    await app.setProps({ visible: false }); await flush(app);
    const before = asked;
    await app.advance(60_000); await flush(app);
    assert.equal(asked, before, 'hidden again: no poll');
    assert.equal(app.document.querySelector('.page-frame'), f, 'the frame kept, the same element');
  } finally { await app.close(); }
});

test('the close guard: clean closes at once; an edited page field or an issue draft asks Keep/Discard (#147 Q3)', async (context) => {
  const held: { guard: Guard | null } = { guard: null };
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true, onCloseGuard: (g: Guard | null) => { held.guard = g; } }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    assert.ok(held.guard);
    let closed = 0;
    assert.equal(held.guard!.dirty(), false);
    held.guard!.ask(() => { closed++; });
    assert.equal(closed, 1, 'clean: closes at once');
    const f = app.document.querySelector<HTMLIFrameElement>('.page-frame')!;
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'half a thought';
    assert.equal(held.guard!.dirty(), true, 'the live document, no clock needed');
    held.guard!.ask(() => { closed++; }); await flush(app);
    assert.equal(closed, 1, 'edited: nothing closed yet');
    assert.match(app.document.body.textContent ?? '', /Discard unsaved changes\?[\s\S]*What you typed in the project page will be lost\./u);
    [...app.document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Discard')!.click(); await flush(app);
    assert.equal(closed, 2, 'Discard: the close runs');
  } finally { await app.close(); }
});

test('while something is edited the drawer board keeps its project and says which (#147 (4))', async (context) => {
  const showing: string[] = [];
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true, onShowing: (s: string) => showing.push(s) }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    const f = app.document.querySelector<HTMLIFrameElement>('.page-frame')!;
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'draft';
    await app.setProps({ session: 'other' }); await flush(app);
    assert.equal(showing.at(-1), 'fixture', 'the board did not follow the room, and says so');
    assert.equal(app.document.querySelector('.page-frame'), f, 'the edited page stays');
  } finally { await app.close(); }
});

test('the same close guard covers an unsaved issue edit in the drawer board (#147 Q3)', async (context) => {
  const held: { guard: Guard | null } = { guard: null };
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, embedded: true, onCloseGuard: (g: Guard | null) => { held.guard = g; } }, setup: setup({ tmux_drawer_board_view: 'board' }), modules: [rpc()] });
  try {
    await flush(app);
    app.document.querySelector<HTMLElement>('button.card')!.click(); await flush(app);
    const field = app.document.querySelector<HTMLTextAreaElement | HTMLInputElement>('.detail textarea, .detail input[type=text], .detail input:not([type])');
    assert.ok(field, 'an issue field to edit');
    field!.value = 'an unsaved edit'; field!.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush(app);
    assert.equal(held.guard!.dirty(), true);
    let closed = 0;
    held.guard!.ask(() => { closed++; }); await flush(app);
    assert.equal(closed, 0, 'not closed under the edit');
    assert.match(app.document.body.textContent ?? '', /Discard unsaved changes\?/u);
    [...app.document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Discard')!.click(); await flush(app);
    assert.equal(closed, 1);
  } finally { await app.close(); }
});
