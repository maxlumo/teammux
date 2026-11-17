import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #150 (the owner, 2026-11-17 03:13 and 03:14): the Dashboard's status block (Needs you,
// Now, Notes for you) folds to one line so the project page gets the room, and every item in
// it is a door. Mounted in the Board, as App and the Hub drawer mount it.
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }

const counts = { todo: 1, doing: 1, review: 0, done: 1, total: 3 };
const issue = (id: number) => ({ id, title: `issue ${id}`, body: '', status: 'doing', assignee: 'dev', created_by: 'human', notes: [] });
const dash = (over: Record<string, unknown> = {}) => ({
  session: 'fixture', asks: [{ seq: 9, asker: 'lead', question: 'Which way?' }],
  board: { counts, oldest_doing: { id: 4, title: 'wire it', assignee: 'dev', last_change: 100 } },
  agents: [{ name: 'dev', state: 'running', detail: '', since: 1, issue: null, status: null }, { name: 'qa', state: 'idle', detail: '', since: 1, issue: null, status: null }],
  stopped: 0, finished: [{ id: 7, title: 'shipped', assignee: 'dev', done_at: 200 }], labels: [], generated_at: 1, page: { rev: 1, by: 'dev', at: 1000 }, ...over,
});
const msg = (seq: number, body: string) => ({ seq, id: `m${seq}`, ts: seq * 1000, from: 'dev', to: ['human'], body, kind: 'msg' });
const askRow = { seq: 9, room: 'proj:fixture', ts: 1, asker: 'lead', question: 'Which way?', options: [{ key: 'a', label: 'this' }], recommend: 'a', issue: null, state: 'open', closed_seq: null, closed_at: null, answer_key: null, said: null, closing: null, delivery: null };
const page = { rev: 1, by: 'dev', at: 1000, html: '<h1>page</h1><textarea id=t></textarea>', dir: '/w/.tmm/dashboard/1', base: '/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/1/', scope: { url: 'http://gw.test/dl/s/9999999999/1.2/sig/L3c/.tmm/dashboard/1/', prefix: 'http://gw.test/dl/s/' } };

function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    getCaps: () => ['board_dispatch', 'dashboard', 'dashboard_page', 'asks'], onCaps: () => undefined,
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    projectList: async () => ({ projects: [{ project: { id: 'fixture', session: 'fixture', name: 'Fixture', room: 'proj:fixture' }, live: true }] }),
    hubRooms: async () => ({ rooms: {} }), boardCounts: async () => ({ counts: { fixture: counts } }), askCounts: async () => ({ counts: {} }),
    hubAgents: async () => ({ agents: [] }), boardList: async () => ({ issues: [issue(4), issue(7)] }), boardGet: async (_s: string, id: number) => issue(id),
    dashboard: async () => dash(),
    hubLog: async () => ({ messages: [msg(3, 'note A'), msg(5, 'note B')], has_more: false }),
    hubUnread: async () => ({ rooms: {}, marks: { 'proj:fixture': { seq: 3, ts: 0 } } }),
    hubAskList: async () => ({ asks: [askRow] }),
    pageLoad: async () => page,
    ...extra,
  };
}
const setup = (store: Record<string, string> = {}) => (w: { Element: { prototype: object }; localStorage: Storage }) => {
  (w.Element.prototype as unknown as { getAnimations: () => [] }).getAnimations = () => [];
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
};
const details = (app: App) => app.document.querySelector<HTMLDetailsElement>('details.dash-block')!;
const line = (app: App) => (app.document.querySelector('.dash-fold-line')?.textContent ?? '').replace(/\s+/gu, ' ').trim();
const toggle = async (app: App) => { details(app).open = !details(app).open; details(app).dispatchEvent(new app.window.Event('toggle')); await flush(app); };

test('the block is unfolded by default; its line says what matters; folding is remembered per host (#150 AC1)', async (context) => {
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    assert.ok(details(app).open, 'unfolded by default');
    assert.equal(line(app), 'Status · 1 ask · 1 working · 1 idle · 1 unread', 'asks, the agents\u2019 line, unread notes');
    assert.ok(app.document.querySelector('.dash-fold-line .fold-asks .b-count.side-unread'), 'the ask count wears the unread ink');
    await toggle(app);
    assert.equal(details(app).open, false);
    assert.equal(app.window.localStorage.getItem('tmux_dash_folded'), '1');
    assert.equal(app.window.localStorage.getItem('tmux_drawer_dash_folded'), null, 'the drawer\u2019s own memory untouched');
    assert.equal(line(app), 'Status · 1 ask · 1 working · 1 idle · 1 unread', 'the same line folded: nothing jumps');
  } finally { await app.close(); }
  for (const [props, store, open] of [[{}, { tmux_dash_folded: '1' }, false], [{ embedded: true }, { tmux_dash_folded: '1' }, true], [{ embedded: true }, { tmux_drawer_dash_folded: '1' }, false]] as const) {
    const again = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, ...props }, setup: setup(store), modules: [rpc()] });
    try { await flush(again); assert.equal(details(again).open, open, JSON.stringify({ props, store })); } finally { await again.close(); }
  }
});

test('folding and unfolding never touch the project page: the same frame, a typed field kept (#150 condition 1)', async (context) => {
  let loads = 0;
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true }, setup: setup(), modules: [rpc({ pageLoad: async () => { loads++; return page; } })] });
  try {
    await flush(app);
    const f = app.document.querySelector<HTMLIFrameElement>('.page-frame')!;
    assert.ok(f && !details(app).contains(f), 'the page is outside the block');
    f.contentDocument!.body.innerHTML = '<textarea id=t></textarea>';
    f.dispatchEvent(new app.window.Event('load'));
    (f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value = 'typed';
    await toggle(app); await toggle(app);
    assert.equal(app.document.querySelector('.page-frame'), f, 'the same element');
    assert.equal((f.contentDocument!.getElementById('t') as HTMLTextAreaElement).value, 'typed');
    assert.equal(loads, 1, 'nothing reloaded');
  } finally { await app.close(); }
});

test('folded, the ask rows are not read; a new ask changes the line and does not unfold; unfolding reads them (#150 AC2/AC3)', async (context) => {
  const listeners: ((m: unknown) => void)[] = [];
  let asks = [{ seq: 9, asker: 'lead', question: 'Which way?' }], rowReads = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup({ tmux_dash_folded: '1' }),
    modules: [rpc({ addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); }, dashboard: async () => dash({ asks }), hubAskList: async () => { rowReads++; return { asks: [askRow, { ...askRow, seq: 11, question: 'And this?' }].filter((r) => asks.some((a) => a.seq === r.seq)) }; } })],
  });
  try {
    await flush(app);
    assert.equal(details(app).open, false);
    assert.equal(rowReads, 0, 'folded: no ask rows read');
    assert.match(line(app), /· 1 ask ·/u);
    asks = [...asks, { seq: 11, asker: 'qa', question: 'And this?' }];
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'ask', id: 'ask:11', seq: 11, from: 'qa', body: 'And this?' });
    await flush(app);
    assert.match(line(app), /· 2 asks/u, 'the line follows the new ask');
    assert.equal(details(app).open, false, 'and stays folded');
    assert.equal(rowReads, 0, 'still no rows');
    await toggle(app);
    assert.ok(rowReads >= 1, 'unfolded: the rows are read');
    assert.equal(app.document.querySelectorAll('.dash-asks .ask-card').length, 2);
  } finally { await app.close(); }
});

test('every item is a door: the ask, the oldest doing, a finished issue, and Back returns to the Dashboard (#150 AC4)', async (context) => {
  const jumps: unknown[] = [];
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, onJumpMessage: (_s: string, m: unknown) => jumps.push(m) }, setup: setup(), modules: [rpc()] });
  try {
    await flush(app);
    app.document.querySelector<HTMLElement>('.ask-card .ask-open')!.click(); await flush(app);
    assert.equal(JSON.stringify(jumps.at(-1)), '{"seq":9}', 'the ask: its bubble in the chat');
    const dashShown = () => { const d = app.document.querySelector('.dash'); return !!d && !d.closest('[hidden]'); };
    for (const [label, id] of [['oldest doing', 4], ['finished', 7]] as const) {
      if (label === 'finished') { app.document.querySelector<HTMLDetailsElement>('.dash-finished')!.open = true; await flush(app); }
      const door = [...app.document.querySelectorAll<HTMLElement>('.dash-door')].find((b) => (b.textContent ?? '').includes(label === 'finished' ? '#7 shipped' : 'wire it'))!;
      assert.ok(door, label);
      door.click(); await flush(app);
      assert.ok(app.document.querySelector('.detail'), `${label}: the issue is open`);
      assert.match(app.document.querySelector('.detail .d-id')?.textContent ?? '', new RegExp(`#${id}`, 'u'));
      assert.ok(!dashShown());
      app.document.querySelector<HTMLElement>('.d-head .icon-btn')!.click(); await flush(app);
      assert.ok(dashShown(), `${label}: Back returns to the Dashboard`);
    }
    // Today's doors, asserted: a note jumps to its message, an agent row to the chat with it.
    app.document.querySelector<HTMLElement>('.dash-note-row')!.click(); await flush(app);
    assert.equal((jumps.at(-1) as { seq: number }).seq, 5);
  } finally { await app.close(); }
});

test('an ask not loaded yet is a door too, never dead text (#150 AC4)', async (context) => {
  const jumps: unknown[] = [];
  const app = await (await compiled).mount(context, { props: { session: 'fixture', visible: true, onJumpMessage: (_s: string, m: unknown) => jumps.push(m) }, setup: setup(), modules: [rpc({ hubAskList: () => new Promise(() => {}) })] });
  try {
    await flush(app);
    const fallback = app.document.querySelector<HTMLElement>('.dash-asks .dash-door')!;
    assert.match(fallback.textContent ?? '', /lead: Which way\?/u);
    fallback.click(); await flush(app);
    assert.equal(JSON.stringify(jumps.at(-1)), '{"seq":9}');
  } finally { await app.close(); }
});

// ── Validator-2's pre-base HOLD at ecaf25f1 (note 10), ruled in leader note 14 ──

test('R1: a rows read queued while unfolded never starts after folding; the next unfold reads them (#150 AC3)', async (context) => {
  const listeners: ((m: unknown) => void)[] = [];
  let release!: () => void, rowReads = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); },
      hubAskList: () => { rowReads++; return rowReads === 1 ? new Promise((ok) => { release = () => ok({ asks: [askRow] }); }) : Promise.resolve({ asks: [askRow] }); },
    })],
  });
  try {
    await flush(app);
    assert.equal(rowReads, 1, 'the first unfolded read in flight');
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'ask', id: 'ask:11', seq: 11, from: 'qa', body: 'new ask' });
    await flush(app);
    assert.equal(rowReads, 1, 'a second read queued behind it');
    const f = app.document.querySelector('.page-frame');
    await toggle(app);
    assert.equal(details(app).open, false, 'folded');
    release(); await flush(app);
    assert.equal(rowReads, 1, 'the queued read retired unrun on folding');
    await toggle(app);
    assert.equal(rowReads, 2, 'the next unfold reads the stale rows');
    assert.equal(app.document.querySelector('.page-frame'), f, 'the page frame untouched');
  } finally { await app.close(); }
});

// openIssue's door table (testing.md § Rules for the next async operation; leader note 19): the
// answer of an issue read belongs to the open that asked and the owner it was asked FOR. Each door
// acts while the first await (boardGet) is pending, then the answer lands; away-and-back rows
// return BEFORE the answer, so nothing may revive it.
const twoProjects = {
  projectList: async () => ({ projects: ['fixture', 'other'].map((s) => ({ project: { id: s, session: s, name: s === 'fixture' ? 'Fixture' : 'Other', room: `proj:${s}` }, live: true })) }),
  boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
};
const head = (app: App) => app.document.querySelector('.page-head h1')?.textContent;
const doors: [string, (app: App) => Promise<void>][] = [
  ['the project changes', async (app) => { await app.setProps({ session: 'other' }); await flush(app); assert.equal(head(app), 'Other', 'control: Other is really shown'); }],
  ['the project changes and comes back', async (app) => { await app.setProps({ session: 'other' }); await flush(app); assert.equal(head(app), 'Other'); await app.setProps({ session: 'fixture' }); await flush(app); assert.equal(head(app), 'Fixture'); }],
  ['the server focus leaves (scope ineligible, hidden)', async (app) => { await app.setScope({ eligible: false }); await app.setProps({ visible: false }); await flush(app); }],
  ['the server focus leaves and returns', async (app) => { await app.setScope({ eligible: false }); await app.setProps({ visible: false }); await flush(app); await app.setScope({ eligible: true }); await app.setProps({ visible: true }); await flush(app); }],
  ['the tab is left and shown again', async (app) => { await app.setProps({ visible: false }); await flush(app); await app.setProps({ visible: true }); await flush(app); }],
  ['a newer open', async (app) => {
    app.document.querySelector<HTMLDetailsElement>('.dash-finished')!.open = true; await flush(app);
    [...app.document.querySelectorAll<HTMLElement>('.dash-door')].find((b) => (b.textContent ?? '').includes('#7 shipped'))!.click(); await flush(app);
  }],
];
for (const [door, act] of doors) {
  test(`S1: a late issue-door answer is a no-op when ${door} (#150 door table)`, async (context) => {
    const releases: Record<number, () => void> = {};
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true }, setup: setup(),
      modules: [rpc({ ...twoProjects, dashboard: async (s: string) => dash({ session: s }), boardGet: (_s: string, id: number) => new Promise((ok) => { releases[id] = () => ok({ ...issue(id), title: id === 4 ? 'OLD ANSWER' : 'NEWER ANSWER' }); }) })],
    });
    try {
      await flush(app);
      [...app.document.querySelectorAll<HTMLElement>('.dash-door')].find((b) => (b.textContent ?? '').includes('wire it'))!.click(); await flush(app);
      assert.ok(releases[4], 'the first issue read in flight');
      await act(app);
      if (door === 'a newer open') { releases[7]!(); await flush(app); }
      releases[4]!(); await flush(app);
      if (!app.document.querySelector('.page-head')) { await app.setScope({ eligible: true }); await app.setProps({ visible: true }); await flush(app); }
      const detail = app.document.querySelector('.detail')?.textContent ?? '';
      assert.ok(!detail.includes('OLD ANSWER'), `${door}: the late answer must not become the open issue`);
      if (door === 'a newer open') assert.match(detail, /NEWER ANSWER/u, 'the newer open stands');
    } finally { await app.close(); }
  });
}

// The same owner's newer navigation (validator-2 S3/R3, leader note 30): every action that
// changes the Board's main pane retires the pending open, so neither its late answer nor its late
// error is shown over the newer pane. Tab and drawer; the original read is held throughout. The
// first rows are validator-2's two probes (New issue on the tab, the drawer's create request).
const byText = (app: App, sel: string, text: string) => [...app.document.querySelectorAll<HTMLElement>(sel)].find((b) => (b.textContent ?? '').trim() === text);
const typeTitle = async (app: App, text: string) => { const f = app.document.querySelector<HTMLTextAreaElement>('.n-title')!; f.value = text; f.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush(app); };
const boardPressed = (app: App) => byText(app, '.view-switch button', 'Board')?.getAttribute('aria-pressed');
type Pane = { from: 'dashboard' | 'issue'; act: (app: App, drawer: boolean) => Promise<void>; check: (app: App) => void };
const panes: [string, Pane][] = [
  ['New issue', { from: 'dashboard', act: async (app, drawer) => {
    if (drawer) await app.setProps({ createRequest: { n: 1 } }); else app.document.querySelector<HTMLElement>('.page-head [aria-label="New issue"]')!.click();
    await flush(app); assert.ok(app.document.querySelector('.n-title'), 'control: the newer form is shown'); await typeTitle(app, 'NEW DRAFT');
  }, check: (app) => assert.equal(app.document.querySelector<HTMLTextAreaElement>('.n-title')?.value, 'NEW DRAFT', 'the newer form and its typed text stand') }],
  ['the switch to the Board view', { from: 'dashboard', act: async (app) => { byText(app, '.view-switch button', 'Board')!.click(); await flush(app); assert.equal(boardPressed(app), 'true', 'control: the Board view is chosen'); },
    check: (app) => { assert.equal(boardPressed(app), 'true', 'the Board view stands'); assert.ok(!app.document.querySelector('.detail'), 'with no issue over it'); } }],
  ['Back from the shown issue', { from: 'issue', act: async (app) => { app.document.querySelector<HTMLElement>('.detail [aria-label="Back"]')!.click(); await flush(app); },
    check: (app) => assert.ok(app.document.querySelector('.dash-block'), 'the Dashboard it went back to stands') }],
  ['Escape from the shown issue', { from: 'issue', act: async (app) => { app.document.querySelector('.detail')!.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(app); },
    check: (app) => assert.ok(app.document.querySelector('.dash-block'), 'the Dashboard it went back to stands') }],
];
for (const drawer of [false, true]) for (const [name, pane] of panes) for (const ends of ['answer', 'error'] as const) {
  test(`S3: a pending issue open's late ${ends} does not replace ${name} (${drawer ? 'drawer' : 'tab'}) (#150 door table)`, async (context) => {
    let release!: () => void;
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true, embedded: drawer, createRequest: null, issueRequest: null }, setup: setup(),
      modules: [rpc({ ...twoProjects, dashboard: async (s: string) => dash({ session: s }), boardGet: (_s: string, id: number) => id === 7 ? Promise.resolve({ ...issue(7), title: 'SHOWN' })
        : new Promise((ok, no) => { release = () => (ends === 'answer' ? ok({ ...issue(id), title: 'OLD ANSWER' }) : no(new Error('OLD ERROR'))); }) })],
    });
    try {
      await flush(app);
      if (pane.from === 'issue') {
        app.document.querySelector<HTMLDetailsElement>('.dash-finished')!.open = true; await flush(app);
        byText(app, '.dash-door', '#7 shipped')?.click() ?? [...app.document.querySelectorAll<HTMLElement>('.dash-door')].find((b) => (b.textContent ?? '').includes('#7 shipped'))!.click();
        await flush(app); assert.match(app.document.querySelector('.detail')?.textContent ?? '', /SHOWN/u, 'control: issue 7 is shown');
        await app.setProps({ issueRequest: { session: 'fixture', id: 4, n: 1 } }); await flush(app);
      } else {
        [...app.document.querySelectorAll<HTMLElement>('.dash-door')].find((b) => (b.textContent ?? '').includes('wire it'))!.click(); await flush(app);
      }
      assert.ok(release, 'the older issue read is in flight');
      await pane.act(app, drawer);
      release(); await flush(app);
      assert.ok(!(app.document.querySelector('.detail')?.textContent ?? '').includes('OLD ANSWER'), 'the late answer is not shown');
      assert.ok(!(app.document.querySelector('.err')?.textContent ?? '').includes('OLD ERROR'), 'the late error is not shown');
      pane.check(app);
    } finally { await app.close(); }
  });
}

// The arrival (validator-2 R2): a landing that comes WITH its new project, in one update, in
// either order of the two props, and with the board becoming visible in the same update (App's
// openBoardTab), is the open's own owner: it opens.
for (const [label, props] of [
  ['session then issue', { session: 'other', issueRequest: { session: 'other', id: 7, n: 1 } }],
  ['issue then session', { issueRequest: { session: 'other', id: 7, n: 1 }, session: 'other' }],
  ['and the board becomes visible', { visible: true, session: 'other', issueRequest: { session: 'other', id: 7, n: 1 } }],
] as const) {
  test(`R2: an issue landing arriving with its new project opens (${label}) (#150)`, async (context) => {
    let release!: () => void;
    const calls: unknown[] = [];
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: label !== 'and the board becomes visible', issueRequest: null }, setup: setup(),
      modules: [rpc({ ...twoProjects, dashboard: async (s: string) => dash({ session: s }), boardGet: (s: string, id: number) => { calls.push([s, id]); return new Promise((ok) => { release = () => ok({ ...issue(id), title: 'VALID ARRIVAL' }); }); } })],
    });
    try {
      await flush(app);
      await app.setProps(props); await flush(app);
      assert.equal(head(app), 'Other');
      assert.equal(JSON.stringify(calls), '[["other",7]]', 'it asked the NEW project for the NEW issue');
      release(); await flush(app);
      assert.match(app.document.querySelector('.detail')?.textContent ?? '', /VALID ARRIVAL/u, 'a current owner\u2019s arrival is not a stale answer');
    } finally { await app.close(); }
  });
}

// The unmount row cannot be observed in a mount (nothing renders after it), so it is pinned in
// the source: the one issue-opening function writes only for its live token, and the board's end
// retires it.
test('S1: openIssue is minted for its owner and writes only while that token lives (#150)', async () => {
  const { readFile } = await import('node:fs/promises');
  const board = await readFile(new URL('./Board.svelte', import.meta.url), 'utf8');
  assert.match(board, /const token = opens\.begin\(issueOwner\(\)\), session = cur;\n\s*opening = \{ token, session, id \};\n\s*const current = \(\) => alive && opens\.live\(token\);/u);
  assert.match(board, /const got = await boardGet\(session, id\);\n\s*if \(!current\(\)\) return;\n\s*sel = got;/u);
  assert.match(board, /catch \(e\) \{ if \(current\(\)\) err = /u);
  assert.match(board, /\$effect\(\(\) => \{ const now = issueOwner\(\); untrack\(\(\) => \{ opens\.own\(now\); \}\); \}\);/u);
  assert.match(board, /onDestroy\(\(\) => \{ alive = false; opGen\+\+; opens\.retire\(\);/u);
});
