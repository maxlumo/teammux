import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #109: the Dashboard view inside the Board tab, mounted in its server's
// scope as App mounts the Board.
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }

const counts = { todo: 2, doing: 1, review: 0, done: 5, total: 8 };
const dash = (over: Record<string, unknown> = {}) => ({
  session: 'fixture', asks: [{ seq: 9, asker: 'lead', question: 'Which?' }],
  board: { counts, oldest_doing: { id: 4, title: 'wire it', assignee: 'dev', last_change: 100 } },
  agents: [
    { name: 'dev', state: 'running', detail: '', since: 1, issue: { id: 4, title: 'wire it' }, status: { text: 'compiling', ts: 1000 } },
    { name: 'idle1', state: 'idle', detail: '', since: 1, issue: null, status: null },
    { name: 'ops', state: 'idle', detail: 'auth_expired', since: 1, issue: null, status: null },
    { name: 'qa', state: 'waiting', detail: '', since: 1, issue: null, status: null },
  ],
  stopped: 2, finished: [{ id: 7, title: 'shipped', assignee: 'dev', done_at: 200 }], labels: [{ agent: 'dev', label: 'robin', aliases: [] }], generated_at: 1,
  ...over,
});
const msg = (seq: number, from: string, to: string[], body: string, kind = 'msg') => ({ seq, id: `m${seq}`, ts: seq * 1000, from, to, body, kind });

function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    getCaps: () => ['board_dispatch', 'dashboard'], onCaps: () => undefined,
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    projectList: async () => ({ projects: [{ project: { id: 'fixture', session: 'fixture', name: 'Fixture', room: 'proj:fixture' }, live: true }] }),
    hubRooms: async () => ({ rooms: {} }),
    boardCounts: async () => ({ counts: { fixture: counts } }),
    askCounts: async () => ({ counts: {} }),
    hubAgents: async () => ({ agents: [] }),
    boardList: async () => ({ issues: [] }),
    dashboard: async () => dash(),
    hubLog: async () => ({ messages: [msg(1, 'dev', ['human'], 'old note'), msg(2, 'dev', ['lead'], 'chatter'), msg(3, 'lead', ['human'], '@human pick', 'ask'), msg(4, 'dev', ['human'], 'note B'), msg(5, 'qa', ['human'], 'note C')], has_more: false }),
    hubUnread: async () => ({ rooms: {}, marks: { 'proj:fixture': { seq: 4, ts: 0 } } }),
    hubRead: async () => { throw new Error('the dashboard must never move the read mark'); },
    ...extra,
  };
}
const setup = (store: Record<string, string> = {}) => (w: { Element: { prototype: object }; localStorage: Storage }) => {
  (w.Element.prototype as unknown as { getAnimations: () => [] }).getAnimations = () => [];
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
};

test('the Board tab opens on the Dashboard: Now, Notes for you, and never the read mark (#109)', async (context) => {
  let reads = 0;
  const jumps: unknown[] = [], agents: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true, onJumpMessage: (_s: string, m: unknown) => jumps.push(m), onOpenAgent: (_s: string, a: string) => agents.push(a) },
    setup: setup(), modules: [rpc({ hubRead: async () => { reads++; return { rooms: {} }; } })],
  });
  try {
    await flush(app);
    const d = app.document;
    assert.ok(d.querySelector('.dash'), 'Dashboard is the default view (D2)');
    assert.ok(d.querySelector('.page-head [role=radiogroup], .page-head .segmented, .page-head .seg'), 'the Segmented is in the page head');
    // Now: the counts line, then rows only for failed, waiting, working.
    assert.deepEqual([...d.querySelectorAll('.dash-agent .side-win-name')].map((e) => e.textContent), ['ops', 'qa', 'robin'], 'failed, waiting, working; labels shown');
    assert.match(d.querySelector('[data-counts]')?.textContent?.trim() ?? '', /^1 working · 1 waiting · 1 idle · 1 need you · 2 stopped$/u);
    assert.match(d.querySelector('.dash-agent:last-of-type')?.textContent ?? '', /#4 wire it[\s\S]*compiling/u);
    // Notes: the three newest To-me lines, the ask left out, unread after the mark (seq 4).
    const notes = [...d.querySelectorAll<HTMLElement>('.dash-note-row')];
    assert.deepEqual(notes.map((n) => n.querySelector('.dash-text')?.textContent), ['note C', 'note B', 'old note']);
    assert.deepEqual(notes.map((n) => n.classList.contains('fresh')), [true, false, false]);
    notes[0]!.click(); await flush(app);
    assert.equal((jumps[0] as { seq: number }).seq, 5, 'a note opens the chat at it');
    d.querySelector<HTMLElement>('.dash-agent')!.click(); await flush(app);
    assert.deepEqual(agents, ['ops'], 'a row opens the chat with that agent');
    await app.advance(20_000); await flush(app);
    assert.equal(reads, 0, 'open, poll and a Notes tap never call hub_read');
    // The count line opens the Board view, and the choice is remembered. The
    // Dashboard is HIDDEN, the same element, never torn down (#111, leader Q5):
    // its project page's frame must not reload.
    const view = d.querySelector('.dash');
    d.querySelector<HTMLElement>('.dash-line')!.click(); await flush(app);
    assert.equal(d.querySelector('.dash'), view, 'the same Dashboard element');
    assert.ok(view!.closest('[hidden]'), 'hidden under the Board view');
    assert.equal(app.window.localStorage.getItem('tmux_board_view'), 'board');
  } finally { await app.close(); }
});

test('no dashboard capability: no switch, the Board as today (#109 L1); the embedded board offers it too (#147, was L7)', async (context) => {
  // #109 L7 said the Hub drawer's embedded board never shows the Dashboard; the owner asked
  // for it there (2026-11-17 02:10), so L7 is now: the embedded board offers it, in a row of
  // its own body (it has no page head), and an older server still shows neither.
  for (const [props, caps, shown] of [
    [{}, ['board_dispatch'], false],
    [{ embedded: true }, ['board_dispatch'], false],
    [{ embedded: true }, ['board_dispatch', 'dashboard'], true],
  ] as const) {
    let asked = 0;
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true, ...props }, setup: setup(),
      modules: [rpc({ getCaps: () => caps, dashboard: async () => { asked++; return dash(); } })],
    });
    try {
      await flush(app);
      const what = JSON.stringify({ props, caps });
      assert.equal(!!app.document.querySelector('.dash'), shown, what);
      assert.equal(asked > 0, shown, what);
      if ('embedded' in props) {
        assert.equal(app.document.querySelector('.page-head'), null, `${what}: the embedded board still has no page head`);
        assert.equal(!!app.document.querySelector('.embedded-switch'), shown, `${what}: the switch is the body's top row`);
      }
    } finally { await app.close(); }
  }
});

test('a failed read keeps the last complete dashboard, muted; a first failure draws nothing (#109 L2/L5)', async (context) => {
  let fail = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: async () => { if (fail) throw new Error('down'); return dash(); } })],
  });
  try {
    await flush(app);
    assert.equal(app.document.querySelectorAll('.dash-agent').length, 3);
    fail = true;
    await app.advance(20_000); await flush(app);
    assert.ok(app.document.querySelector('.dash.muted'), 'muted');
    assert.equal(app.document.querySelectorAll('.dash-agent').length, 3, 'the last complete data stays');
  } finally { await app.close(); }
  const first = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: async () => { throw new Error('down'); } })],
  });
  try {
    await flush(first);
    assert.equal(first.document.querySelectorAll('.dash-agent, .dash-note-row').length, 0, 'nothing before a first success');
    assert.ok(first.document.querySelector('.dash.muted'));
  } finally { await first.close(); }
});

test('hidden, the view reads nothing; shown, it reads at once (#109 L6)', async (context) => {
  let asked = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: async () => { asked++; return dash(); } })],
  });
  try {
    await flush(app);
    const after = asked;
    await app.setProps({ visible: false });
    await app.advance(60_000); await flush(app);
    assert.equal(asked, after, 'no read while hidden');
    await app.setProps({ visible: true }); await flush(app);
    assert.equal(asked, after + 1, 'one read on return');
  } finally { await app.close(); }
});

test('a late answer for the project left behind is dropped (#109 L4)', async (context) => {
  let release!: () => void;
  const answers: Record<string, () => Promise<unknown>> = {
    fixture: () => new Promise((ok) => { release = () => ok(dash({ agents: [{ name: 'stale', state: 'running', detail: '', issue: null, status: null }] })); }),
    other: async () => dash({ session: 'other', agents: [{ name: 'fresh', state: 'running', detail: '', issue: null, status: null }] }),
  };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      projectList: async () => ({ projects: [
        { project: { id: 'fixture', session: 'fixture', name: 'Fixture', room: 'proj:fixture' }, live: true },
        { project: { id: 'other', session: 'other', name: 'Other', room: 'proj:other' }, live: true },
      ] }),
      boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
      dashboard: (s: string) => answers[s]!(),
    })],
  });
  try {
    await flush(app);
    await app.setProps({ session: 'other' }); await flush(app);
    release(); await flush(app);
    assert.deepEqual([...app.document.querySelectorAll('.dash-agent .side-win-name')].map((e) => e.textContent), ['fresh']);
  } finally { await app.close(); }
});

test('Notes pages back until three To-me lines, and says when it stopped at the cap (#109)', async (context) => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ messages: [msg(1000 - i * 10, 'dev', ['lead'], 'chatter')], has_more: true, oldest_seq: 1000 - i * 10 }));
  let calls = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ hubLog: async () => pages[Math.min(calls++, pages.length - 1)] })],
  });
  try {
    await flush(app);
    assert.equal(calls, 10, 'at most 10 pages');
    assert.ok(app.document.querySelector('.dash-sec:last-of-type .dash-meta'), 'the cap is said');
  } finally { await app.close(); }
});

test('a socket close keeps the Dashboard, muted as not connected; the offer follows the last login answer (#109 S1)', async (context) => {
  const listeners: ((caps: string[] | undefined) => void)[] = [];
  let up = true;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      onCaps: (fn: (caps: string[] | undefined) => void) => { listeners.push(fn); },
      dashboard: async () => { if (!up) throw new Error('socket closed'); return dash(); },
    })],
  });
  try {
    await flush(app);
    assert.equal(app.document.querySelectorAll('.dash-agent').length, 3);
    up = false;
    for (const fn of listeners) fn(undefined); // the real close edge (connection.ts onCaps(undefined))
    await flush(app);
    assert.ok(app.document.querySelector('.dash.muted'), 'still the Dashboard, muted');
    assert.equal(app.document.querySelectorAll('.dash-agent').length, 3, 'the last data stays');
    assert.ok(app.document.querySelector('.page-head .segmented'), 'the switch stays');
    up = true;
    for (const fn of listeners) fn(['board_dispatch', 'dashboard']); // the redial's login
    await flush(app);
    assert.equal(app.document.querySelector('.dash.muted'), null, 'live again at once, with no poll waited for');
    for (const fn of listeners) fn(['board_dispatch']); // a login that no longer offers it
    await flush(app);
    assert.equal(app.document.querySelector('.dash'), null, 'a server without the capability: the Board');
  } finally { await app.close(); }
});

test('while three To-me lines are held, a poll re-reads the newest page only (#109 S2)', async (context) => {
  const before: (number | undefined)[] = [];
  const page0 = { messages: [msg(204, 'dev', ['human'], 'n2'), msg(205, 'dev', ['human'], 'n3')], has_more: true, oldest_seq: 201 };
  const page1 = { messages: [msg(150, 'qa', ['human'], 'n1')], has_more: false, oldest_seq: 101 };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ hubLog: async (_s: string, _t: number, _l: number, b?: number) => { before.push(b); return b ? page1 : page0; } })],
  });
  try {
    await flush(app);
    assert.deepEqual(before, [undefined, 201], 'the first read pages back to three');
    before.length = 0;
    await app.advance(20_000); await flush(app);
    assert.deepEqual(before, [undefined], 'the poll reads page 0 only');
    assert.deepEqual([...app.document.querySelectorAll('.dash-note-row .dash-text')].map((e) => e.textContent), ['n3', 'n2', 'n1'], 'the held older line still counts');
  } finally { await app.close(); }
});

test('A → B → A with A s read in flight: A is read again at once, never left to the next poll (#109 L4)', async (context) => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      projectList: async () => ({ projects: [
        { project: { id: 'fixture', session: 'fixture', name: 'Fixture', room: 'proj:fixture' }, live: true },
        { project: { id: 'other', session: 'other', name: 'Other', room: 'proj:other' }, live: true },
      ] }),
      boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
      dashboard: (s: string) => {
        calls.push(s);
        if (s === 'fixture' && calls.filter((c) => c === 'fixture').length === 1) return new Promise((ok) => { releaseFirst = () => ok(dash()); });
        return Promise.resolve(dash({ agents: [{ name: s === 'fixture' ? 'again' : 'b', state: 'running', detail: '', issue: null, status: null }] }));
      },
    })],
  });
  try {
    await flush(app);
    await app.setProps({ session: 'other' }); await flush(app);
    await app.setProps({ session: 'fixture' }); await flush(app);
    releaseFirst(); await flush(app);
    assert.deepEqual([...app.document.querySelectorAll('.dash-agent .side-win-name')].map((e) => e.textContent), ['again'], 'A s own fresh read, before any poll');
  } finally { await app.close(); }
});

test('a 250-message burst with a To-me line in its middle: the unseen gap is read down to topSeen, never past it (#109 note 29)', async (context) => {
  const before: (number | undefined)[] = [];
  let burst = false;
  // Held: three lines up to seq 300 (topSeen 300).
  const first = { messages: [msg(298, 'dev', ['human'], 'a'), msg(299, 'dev', ['human'], 'b'), msg(300, 'dev', ['human'], 'c')], has_more: true, oldest_seq: 201 };
  // Then 250 rows arrive (301-550); a To-me line sits at 400.
  const chatter = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, 'dev', ['lead'], 'x'));
  const pages: Record<string, { messages: unknown[]; has_more: boolean; oldest_seq: number }> = {
    top: { messages: chatter(451, 550), has_more: true, oldest_seq: 451 },
    451: { messages: [...chatter(351, 399), msg(400, 'qa', ['human'], 'in the gap'), ...chatter(401, 450)], has_more: true, oldest_seq: 351 },
    351: { messages: chatter(251, 350), has_more: true, oldest_seq: 251 },
  };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ hubLog: async (_s: string, _t: number, _l: number, b?: number) => { before.push(b); return burst ? pages[b ?? 'top'] : first; } })],
  });
  try {
    await flush(app);
    assert.deepEqual(before, [undefined], 'three lines on page 0');
    before.length = 0; burst = true;
    await app.advance(20_000); await flush(app);
    assert.deepEqual(before, [undefined, 451, 351], 'the gap is read down to topSeen (300) and no further');
    assert.deepEqual([...app.document.querySelectorAll('.dash-note-row .dash-text')].map((e) => e.textContent), ['in the gap', 'c', 'b']);
    before.length = 0; burst = false;
    pages.top = { messages: [...chatter(452, 550), msg(551, 'dev', ['lead'], 'one more')], has_more: true, oldest_seq: 452 };
    burst = true;
    await app.advance(20_000); await flush(app);
    assert.deepEqual(before, [undefined], 'a one-row advance: page 0 only');
  } finally { await app.close(); }
});

test('hidden → shown with a read still in flight: the entry reads again, and the earlier answer never lands (#109 S4)', async (context) => {
  let release!: () => void, n = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: () => { n++; return n === 1 ? new Promise((ok) => { release = () => ok(dash({ agents: [{ name: 'before', state: 'running', detail: '', issue: null, status: null }] })); }) : Promise.resolve(dash({ agents: [{ name: 'after', state: 'running', detail: '', issue: null, status: null }] })); } })],
  });
  try {
    await flush(app);
    await app.setProps({ visible: false }); await flush(app);
    await app.setProps({ visible: true }); await flush(app);
    release(); await flush(app);
    assert.equal(n, 2, 'one read per entry, the second queued behind the first');
    assert.deepEqual([...app.document.querySelectorAll('.dash-agent .side-win-name')].map((e) => e.textContent), ['after']);
  } finally { await app.close(); }
});

test('a 1250-row unseen gap is read to topSeen, past the first fill s 10-page stop (#109 S2, leader note 30)', async (context) => {
  const before: (number | undefined)[] = [];
  let burst = false;
  const first = { messages: [msg(298, 'dev', ['human'], 'a'), msg(299, 'dev', ['human'], 'b'), msg(300, 'dev', ['human'], 'c')], has_more: true, oldest_seq: 201 };
  const chatter = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, 'dev', ['lead'], 'x'));
  // Rows 301-1550 in pages of 100, newest first; a To-me line at 500.
  const page = (top: number) => { const lo = Math.max(301, top - 99); const rows = chatter(lo, top).map((m) => (m.seq === 500 ? msg(500, 'qa', ['human'], 'deep in the gap') : m)); return { messages: rows, has_more: true, oldest_seq: lo }; };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ hubLog: async (_s: string, _t: number, _l: number, b?: number) => { before.push(b); return burst ? page(b ? b - 1 : 1550) : first; } })],
  });
  try {
    await flush(app);
    before.length = 0; burst = true;
    await app.advance(20_000); await flush(app);
    assert.deepEqual(before, [undefined, 1451, 1351, 1251, 1151, 1051, 951, 851, 751, 651, 551, 451, 351], 'page 0, then back to the page holding 301 (topSeen 300 + 1), thirteen pages, past the first fill s 10');
    assert.equal(app.document.querySelector('.dash-note-row .dash-text')?.textContent, 'deep in the gap');
  } finally { await app.close(); }
});

test('the Dashboard s teardown retires a queued entry read: settling the old read starts none (#109 S4)', async (context) => {
  let release!: () => void, n = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: () => { n++; return n === 1 ? new Promise((ok) => { release = () => ok(dash()); }) : Promise.resolve(dash()); } })],
  });
  try {
    await flush(app);
    await app.setProps({ visible: false }); await flush(app);
    await app.setProps({ visible: true }); await flush(app); // an entry read queued behind the held one
    app.document.querySelector<HTMLElement>('.page-head .segmented button:last-child')!.click(); await flush(app); // the Board view: the Dashboard is hidden (#111)
    assert.ok(app.document.querySelector('.dash')!.closest('[hidden]'), 'kept, hidden');
    release(); await flush(app);
    assert.equal(n, 1, 'no read starts after the view is left');
  } finally { await app.close(); }
});

test('hide → show → hide with a read held: the queued entry retires, zero new reads; hide → show alone: exactly one (#109 L6, leader note 62)', async (context) => {
  for (const [steps, want] of [[[false, true, false], 1], [[false, true], 2]] as const) {
    let release!: () => void, n = 0;
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true }, setup: setup(),
      modules: [rpc({ dashboard: () => { n++; return n === 1 ? new Promise((ok) => { release = () => ok(dash()); }) : Promise.resolve(dash()); } })],
    });
    try {
      await flush(app);
      for (const v of steps) await app.setProps({ visible: v });
      await flush(app);
      release(); await flush(app);
      assert.equal(n, want, JSON.stringify(steps));
    } finally { await app.close(); }
  }
});

test('an age runs on the Board s clock, also on a row kept muted after a failed poll (#109 S5, leader note 64)', async (context) => {
  let fail = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({ dashboard: async () => { if (fail) throw new Error('read failed'); return dash({ agents: [{ name: 'dev', state: 'running', detail: '', issue: null, status: { text: 'kept', ts: 1_800_000_000_000 - 30_000 } }] }); } })],
  });
  try {
    await flush(app);
    const age = () => app.document.querySelector('.dash-status .side-age')?.textContent;
    assert.equal(age(), 'now', '30 s old: the formatter s word for under a minute');
    fail = true;
    await app.advance(60_000); await flush(app);
    assert.ok(app.document.querySelector('.dash.muted'), 'the poll failed: muted');
    assert.equal(age(), '1m', 'the age kept moving against the current clock');
  } finally { await app.close(); }
});

test('a part of the snapshot that fails early holds the read until every part settles: one dashboard read in flight (#109 S4, validator note 49)', async (context) => {
  let active = 0, peak = 0, logs = 0;
  const releases: (() => void)[] = [];
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      dashboard: () => { active++; peak = Math.max(peak, active); return new Promise((ok) => releases.push(() => { active--; ok(dash()); })); },
      hubLog: async () => { if (++logs === 1) throw new Error('page 0 failed while the dashboard read is pending'); return { messages: [], has_more: false }; },
    })],
  });
  try {
    await flush(app);
    await app.setProps({ visible: false }); await app.setProps({ visible: true }); await flush(app);
    assert.equal(peak, 1, 'the early failure did not free the lock');
    for (const release of releases.splice(0)) release();
    await flush(app);
    for (const release of releases.splice(0)) release(); // the entry read queued behind it
    await flush(app);
    assert.equal(peak, 1, 'still one at a time');
  } finally { await app.close(); }
});

const askRow = (over: Record<string, unknown> = {}) => ({
  seq: 9, room: 'proj:fixture', ts: 1, asker: 'lead', question: 'Which **way**?', options: [{ key: 'a', label: 'own row' }, { key: 'b', label: 'the card' }],
  recommend: 'a', issue: null, state: 'open', closed_seq: null, closed_at: null, answer_key: null, said: null, closing: null, delivery: null, ...over,
});
const askCaps = () => ['board_dispatch', 'dashboard', 'asks'];

test('Needs you is #107 s AskCard: answered in place, and the open list is read again (#109 AC2)', async (context) => {
  const answers: unknown[] = [];
  let open = true, dashReads = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      getCaps: askCaps,
      dashboard: async () => { dashReads++; return dash({ asks: open ? [{ seq: 9, asker: 'lead', question: 'Which **way**?' }] : [] }); },
      hubAskList: async () => ({ asks: [askRow(open ? {} : { state: 'answered', answer_key: 'a', closed_at: 2000, said: 'a · own row' })] }),
      hubAskAnswer: async (_s: string, seq: number, option?: string) => { answers.push([seq, option]); open = false; return { applied: true, ask: askRow({ state: 'answered', answer_key: option, closed_at: 2000, said: 'a · own row' }) }; },
    })],
  });
  try {
    await flush(app);
    const d = app.document;
    const card = d.querySelector('.dash-asks .ask-card');
    assert.ok(card, 'the one ask component');
    assert.match(card!.innerHTML, /<strong>way<\/strong>/u, 'its question through markdown');
    const before = dashReads;
    [...d.querySelectorAll<HTMLButtonElement>('.dash-asks .ask-opt button')][0]!.click(); await flush(app);
    assert.deepEqual(answers, [[9, 'a']], 'hub_ask_answer, as the chat s card calls it');
    assert.ok(dashReads > before, 'the open list is the server s: read again');
    assert.equal(d.querySelectorAll('.dash-asks .ask-card').length, 0, 'answered: no longer open, gone from Needs you');
    assert.match(d.querySelector('.dash-sec h2')?.textContent ?? '', /· 0$/u);
  } finally { await app.close(); }
});

test('an ask closed elsewhere (the chat, another client) repaints here on the server s push; a disconnect keeps the card (#109 AC2)', async (context) => {
  const listeners: ((m: unknown) => void)[] = [];
  const caps: ((c: string[] | undefined) => void)[] = [];
  let closed = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      getCaps: askCaps,
      onCaps: (fn: (c: string[] | undefined) => void) => { caps.push(fn); },
      addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); },
      removeTeamMessageListener: () => undefined,
      dashboard: async () => dash({ asks: [{ seq: 9, asker: 'lead', question: 'Which?' }] }),
      hubAskList: async () => ({ asks: [askRow(closed ? { state: 'answered', answer_key: 'b', closed_at: 2000, said: 'b · the card' } : {})] }),
    })],
  });
  try {
    await flush(app);
    const d = app.document;
    assert.ok(d.querySelector('.dash-asks .ask-opt button'), 'open, with its options');
    for (const fn of caps) fn(undefined); await flush(app);
    assert.ok(d.querySelector('.dash-asks .ask-card'), 'a closed socket keeps the card');
    for (const fn of caps) fn(askCaps()); await flush(app);
    closed = true;
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'msg', id: 'ask:9:close', seq: 12, from: 'human', body: 'answered' });
    await flush(app);
    assert.equal(d.querySelector('.dash-asks .ask-opt button'), null, 'the close made in the chat repaints here: no live controls');
    assert.match(d.querySelector('.dash-asks .ask-card')?.textContent ?? '', /Answered/u);
  } finally { await app.close(); }
});

// The mount harness lays nothing out: a question is made to overflow its clamp, or not.
const overflowing = (cut: boolean) => (w: { Element: { prototype: object }; HTMLElement: { prototype: object }; localStorage: Storage }) => {
  setup()(w);
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('ask-q') && cut ? 200 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('ask-q') ? 60 : 0; } });
};

test('the Dashboard s card is AskCard s compact form: asker and age on it, the question clamped and opened by a tap (#109 AC2, leader note 88)', async (context) => {
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: overflowing(true),
    modules: [rpc({
      getCaps: askCaps,
      dashboard: async () => dash({ asks: [{ seq: 9, asker: 'dev', question: 'Which?' }] }),
      hubAskList: async () => ({ asks: [askRow({ asker: 'dev', ts: 1_800_000_000_000 - 5 * 60_000, question: 'Which **way**, [see](https://example.com)?' })] }),
    })],
  });
  try {
    await flush(app);
    const card = app.document.querySelector<HTMLElement>('.dash-asks .ask-card')!;
    assert.equal(card.querySelector('.ask-meta .ask-who')?.textContent, 'robin', 'the asker, by its label');
    assert.equal(card.querySelector('.ask-meta .side-age')?.textContent, '5m', 'the ask s age');
    const q = card.querySelector<HTMLElement>('.ask-q')!;
    assert.ok(q.classList.contains('clamp') && !q.classList.contains('open'), 'clamped');
    q.querySelector<HTMLElement>('a')!.click(); await flush(app);
    assert.ok(!q.classList.contains('open'), 'a tap on a link inside is the link s');
    q.click(); await flush(app);
    assert.ok(q.classList.contains('open') && q.getAttribute('aria-expanded') === 'true', 'a tap opens it');
    q.click(); await flush(app);
    assert.ok(!q.classList.contains('open'), 'a second tap closes it');
    assert.ok(card.querySelector('.ask-opt button') && card.querySelector('.ask-acts'), 'options and acts as in the chat');
  } finally { await app.close(); }
});

test('a close pushed while the Dashboard is hidden reads nothing; the next showing reads it, and the close lands (#109 S8, L6)', async (context) => {
  const listeners: ((m: unknown) => void)[] = [];
  let reads = 0, closed = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      getCaps: askCaps,
      addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); },
      dashboard: async () => dash({ asks: closed ? [] : [{ seq: 9, asker: 'lead', question: 'Which?' }] }),
      hubAskList: async () => { reads++; return { asks: [askRow(closed ? { state: 'answered', answer_key: 'a', closed_at: 2000, said: 'a · own row' } : {})] }; },
    })],
  });
  try {
    await flush(app);
    await app.setProps({ visible: false }); await flush(app);
    const before = reads;
    closed = true;
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'msg', id: 'ask:9:close', seq: 12, from: 'human', body: 'answered' });
    await flush(app);
    assert.equal(reads, before, 'hidden: no ask read on a push');
    await app.setProps({ visible: true }); await flush(app);
    assert.ok(reads > before, 'shown: the stale book is read');
    assert.equal(app.document.querySelectorAll('.dash-asks .ask-card').length, 0, 'the close made while away has landed');
  } finally { await app.close(); }
});

test('a full ask read a push queued while shown is retired when the view hides; the next showing reads it (#109 S8, leader note 80)', async (context) => {
  const listeners: ((m: unknown) => void)[] = [];
  let calls = 0;
  const releases: (() => void)[] = [];
  let hold = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: setup(),
    modules: [rpc({
      getCaps: askCaps,
      addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); },
      dashboard: async () => dash({ asks: [{ seq: 9, asker: 'lead', question: 'Which?' }] }),
      hubAskList: async () => { calls++; if (hold) await new Promise<void>((r) => releases.push(r)); return { asks: [askRow()] }; },
    })],
  });
  try {
    await flush(app);
    hold = true;
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'ask', id: 'q10', seq: 10, from: 'lead', body: 'another' });
    await flush(app);
    const held = calls;
    for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'msg', id: 'ask:9:close', seq: 12, from: 'human', body: 'answered' });
    await flush(app); // queued behind the held read
    await app.setProps({ visible: false }); await flush(app);
    hold = false;
    for (const r of releases.splice(0)) r();
    await flush(app);
    assert.equal(calls, held, 'hidden: the queued read never started');
    await app.setProps({ visible: true }); await flush(app);
    assert.ok(calls > held, 'shown: read in full');
  } finally { await app.close(); }
});

test('a queued ask read never starts after the Dashboard is gone, or after its project is left (#109 T3/S8, leader note 85)', async (context) => {
  for (const leave of ['board view', 'other project'] as const) {
    const listeners: ((m: unknown) => void)[] = [];
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    let hold = true, releaseOther: (() => void) | null = null;
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true }, setup: setup(),
      modules: [rpc({
        getCaps: askCaps,
        projectList: async () => ({ projects: ['fixture', 'other'].map((s) => ({ project: { id: s, session: s, name: s, room: `proj:${s}` }, live: true })) }),
        boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
        addTeamMessageListener: (fn: (m: unknown) => void) => { listeners.push(fn); },
        dashboard: (s: string) => (s === 'other' ? new Promise((ok) => { releaseOther = () => ok(dash({ asks: [] })); }) : Promise.resolve(dash({ asks: [{ seq: 9, asker: 'lead', question: 'Which?' }] }))),
        hubAskList: (s: string) => { calls.push(s); return hold ? new Promise((ok) => releases.push(() => ok({ asks: [askRow()] }))) : Promise.resolve({ asks: [askRow()] }); },
      })],
    });
    try {
      await flush(app);
      for (const fn of listeners) fn({ room: 'proj:fixture', kind: 'msg', id: 'ask:9:close', seq: 12, from: 'human', body: 'answered' });
      await flush(app); // a full read queued behind the held first one
      if (leave === 'board view') {
        app.document.querySelector<HTMLElement>('.page-head .segmented button:last-child')!.click(); await flush(app);
        assert.ok(app.document.querySelector('.dash')!.closest('[hidden]'), 'kept, hidden (#111)');
      } else {
        await app.setProps({ session: 'other' }); await flush(app);
        assert.ok(releaseOther, 'the other project s snapshot is still pending');
      }
      hold = false;
      for (const r of releases.splice(0)) r();
      await flush(app);
      assert.deepEqual(calls, ['fixture'], `${leave}: the queued read retired unrun`);
    } finally { hold = false; for (const r of releases.splice(0)) r(); (releaseOther as (() => void) | null)?.(); await flush(app); await app.close(); }
  }
});

test('a compact question that fits its clamp is plain text, not a control: no role, no tab stop, no toggle (#109, leader note 87)', async (context) => {
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true }, setup: overflowing(false),
    modules: [rpc({ getCaps: askCaps, dashboard: async () => dash({ asks: [{ seq: 9, asker: 'dev', question: 'Short?' }] }), hubAskList: async () => ({ asks: [askRow({ question: 'Short?' })] }) })],
  });
  try {
    await flush(app);
    const q = app.document.querySelector<HTMLElement>('.dash-asks .ask-q')!;
    assert.equal(q.getAttribute('role'), null);
    assert.equal(q.getAttribute('tabindex'), null);
    assert.equal(q.getAttribute('aria-expanded'), null);
    q.click(); await flush(app);
    assert.ok(!q.classList.contains('open'), 'a tap does nothing');
  } finally { await app.close(); }
});
