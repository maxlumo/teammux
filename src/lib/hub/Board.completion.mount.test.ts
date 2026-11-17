import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #152 (validator-2's #150 round-3 audit; leader #150 note 35, #152 notes 2-3): a save or a
// delete returning the Board to the list is a COMPLETION, not the person's navigation, so a
// pending issue open still lands (the last thing the person asked for), with one exception: a
// delete retires a pending open of the very issue it deleted, so an old read cannot reopen it.
// Mounted in the Board as App mounts it. Issue #7 is shown; a landing for the target is held.
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

const shown = (app: App) => app.document.querySelector<HTMLInputElement>('.detail .d-title-input')?.value ?? '';
const error = (app: App) => app.document.querySelector('.err')?.textContent ?? '';
const dashVisible = (app: App) => { const d = app.document.querySelector('.dash'); return !!d && !d.closest('[hidden]'); };
// [door, pending target, does the pending open land?]
const rows: ['save' | 'delete', 4 | 7, boolean][] = [
  ['save', 4, true], ['save', 7, true], // a save never retires (ruling 35)
  ['delete', 4, true],                   // a delete leaves another issue's open alone
  ['delete', 7, false],                  // and retires the open of the issue it deleted (#152)
];
for (const [door, target, lands] of rows) for (const end of ['answer', 'error'] as const) {
  test(`#152: after a ${door} of #7, a pending open of #${target} ${lands ? 'lands' : 'is retired'} (late ${end})`, async (context) => {
    let release!: () => void, reads = 0, writes = 0, deleted = false;
    const app = await (await compiled).mount(context, {
      props: { session: 'fixture', visible: true, issueRequest: { session: 'fixture', id: 7, n: 1 } }, setup: setup(),
      modules: [rpc({
        boardGet: (s: string, id: number) => {
          assert.equal(s, 'fixture');
          if (id === 7 && reads++ === 0) return Promise.resolve({ ...issue(7), editable: true, assignee: '', title: 'SHOWN' });
          return new Promise((ok, no) => { release = () => (end === 'answer' ? ok({ ...issue(id), editable: true, title: 'PENDING ANSWER' }) : no(new Error('PENDING ERROR'))); });
        },
        boardSave: async () => { writes++; return {}; },
        boardDelete: async (s: string, id: number) => { assert.deepEqual([s, id], ['fixture', 7]); writes++; deleted = true; return {}; },
        boardList: async () => ({ issues: deleted ? [issue(4)] : [issue(4), issue(7)] }),
      })],
    });
    try {
      await flush(app);
      assert.match(shown(app), /SHOWN/u, 'control: #7 is shown');
      await app.setProps({ issueRequest: { session: 'fixture', id: target, n: 2 } }); await flush(app);
      assert.ok(release, `control: the open of #${target} is pending while #7 stays shown`);
      if (door === 'save') {
        const title = app.document.querySelector<HTMLInputElement>('.d-title-input')!;
        title.value = 'SAVED'; title.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush(app);
        app.document.querySelector<HTMLElement>('.detail [aria-label="Save"]')!.click(); await flush(app);
      } else {
        app.document.querySelector<HTMLElement>('.detail [aria-label="Delete issue"]')!.click(); await flush(app);
        app.document.querySelector<HTMLElement>('.dlg-actions button:last-child')!.click(); await flush(app);
      }
      assert.equal(writes, 1, 'control: the mutation completed');
      assert.ok(dashVisible(app), 'control: the completion returned to the Dashboard');
      release(); await flush(app);
      if (lands && end === 'answer') assert.match(shown(app), /PENDING ANSWER/u, 'the person\u2019s last ask still opens');
      if (lands && end === 'error') assert.match(error(app), /PENDING ERROR/u, 'and its own error is said');
      if (!lands) {
        assert.ok(!shown(app).includes('PENDING ANSWER'), 'an old read cannot reopen the issue just deleted');
        assert.ok(!error(app).includes('PENDING ERROR'), 'nor speak for it');
        assert.ok(dashVisible(app), 'the Dashboard stands');
      }
    } finally { await app.close(); }
  });
}

// The same id in ANOTHER project cannot be pending beside this delete (a project change retires
// every pending open as an owner change, #150, and a delete whose project was left writes nothing),
// so the target check is pinned in the source: project AND id, and only while that open lives.
test('#152: the two completions say why they are not toList(), and the delete retires only its own target', async () => {
  const { readFile } = await import('node:fs/promises');
  const board = await readFile(new URL('./Board.svelte', import.meta.url), 'utf8');
  assert.match(board, /const token = opens\.begin\(issueOwner\(\)\), session = cur;\n\s*opening = \{ token, session, id \};/u, 'an open records what it is for');
  assert.match(board, /A completion, not toList\(\): a\n\s*\/\/ pending open is the person's last ask and still lands \(#150 ruling 35\)\.\n\s*sel = null;\n\s*await load\(\);/u, 'save success: a completion, no retire');
  assert.match(board, /\/\/ A completion, not toList\(\) \(#150 ruling 35\): only a pending open of THIS issue retires \(#152\)\.\n\s*if \(sel\?\.id === cap\.id\) sel = null;\n\s*if \(opening && opens\.live\(opening\.token\) && opening\.session === cap\.session && opening\.id === cap\.id\) \{\n\s*opens\.retire\(\);\n\s*\}/u, 'delete success retires only the open of the deleted issue, in its project');
  const save = board.slice(board.indexOf('async function saveDraft'), board.indexOf('async function createIssue'));
  assert.ok(!save.includes('opens.retire'), 'a save never retires a pending open');
});
