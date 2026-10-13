import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Bound to one server's scope, as App's provider binds it (board #335 ②b).
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
const issue = { id: 1, title: 'Keep this issue', body: 'Body', status: 'todo', assignee: '', editable: true,
  created_at: 100, updated_at: 100, notes: [] };
const counts = { todo: 1, doing: 0, review: 0, done: 0, total: 1 };
function rpc(extra: Record<string, (...args: any[]) => unknown>) {
  return {
    projectList: async () => ({ projects: [{ project: { id: 'fixture', session: 'fixture', name: 'Fixture' }, live: true }] }),
    hubRooms: async () => ({ rooms: {} }),
    boardCounts: async () => ({ counts: { fixture: counts } }),
    hubAgents: async () => ({ agents: [] }),
    boardList: async () => ({ issues: [issue] }),
    boardGet: async () => issue,
    ...extra,
  };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 8; i++) await app.flush(); }
async function askDelete(app: App) {
  await flush(app);
  app.document.querySelector<HTMLButtonElement>('.card')!.click(); await flush(app);
  app.document.querySelector<HTMLButtonElement>('[aria-label="Delete issue"]')!.click(); await app.flush();
}
const confirm = (app: App) => app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;

test('Board deletion stays retryable after rejection and pending Back cannot dismiss it (#167)', async context => {
  let reject!: (error: Error) => void, back!: () => boolean;
  let deletes = 0;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true, onGoBack: (fn: typeof back) => back = fn },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({ boardDelete: () => ++deletes === 1 ? new Promise((_, no) => reject = no) : Promise.resolve({}) })],
  });
  try {
    await askDelete(app);
    confirm(app).click(); confirm(app).click(); await app.flush();
    assert.equal(deletes, 1);
    assert.equal(back(), true); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'pending Back is consumed by the dialog');
    reject(new Error('Delete denied')); await flush(app);
    assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Delete denied/);
    confirm(app).click(); await flush(app);
    assert.equal(deletes, 2);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
    assert.equal(app.document.querySelector('.detail'), null);
  } finally { await app.close(); }
});

test('a Board refresh failure after deletion cannot offer the destructive request again (#167)', async context => {
  let deletes = 0, failRead = true;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      boardDelete: async () => { deletes++; return {}; },
      boardList: async () => { if (deletes && failRead) throw new Error('Refresh denied'); return { issues: deletes ? [] : [issue] }; },
    })],
  });
  try {
    await askDelete(app); confirm(app).click(); await flush(app);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
    assert.equal(app.document.querySelector('.detail'), null);
    assert.match(app.document.querySelector('.err')?.textContent ?? '', /Refresh denied/);
    failRead = false;
    await app.advance(8000); await flush(app);
    assert.equal(deletes, 1);
    assert.equal(app.document.querySelector('.err'), null);
  } finally { await app.close(); }
});

test('discarding a Board draft offers Keep editing, not Delete (#167)', async context => {
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({})],
  });
  try {
    await flush(app);
    app.document.querySelector<HTMLButtonElement>('.card')!.click(); await flush(app);
    const title = app.document.querySelector<HTMLInputElement>('.d-title-input')!;
    title.value = 'Unsaved';
    title.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.d-head [aria-label="Back"], .detail [aria-label="Back"]')!.click();
    await app.flush();
    assert.equal(app.document.querySelector('.dlg-actions button:first-child')?.textContent?.trim(), 'Keep editing');
    assert.equal(app.document.querySelector('.dlg-actions button:last-child')?.textContent?.trim(), 'Discard');
  } finally { await app.close(); }
});

test('a late Board deletion cannot close a newer visit to the same room (#167)', async context => {
  let finish!: () => void;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      projectList: async () => ({ projects: ['fixture', 'other'].map(session => ({
        project: { id: session, name: session, session }, live: true,
      })) }),
      boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
      boardDelete: () => new Promise<void>(yes => finish = yes),
    })],
  });
  try {
    await askDelete(app); confirm(app).click(); await app.flush();
    for (const name of ['other', 'fixture']) {
      [...app.document.querySelectorAll<HTMLButtonElement>('button.proj-row')]
        .find(row => row.querySelector('.p-name')?.textContent === name)!.click();
      await flush(app);
    }
    app.document.querySelector<HTMLButtonElement>('.card')!.click(); await flush(app);
    finish(); await flush(app);
    assert.ok(app.document.querySelector('.detail'), 'completion does not navigate the newer visit');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('an older Board refresh cannot resurrect a subsequently deleted issue (#167)', async context => {
  const second = { ...issue, id: 2, title: 'Second issue' };
  let deletes = 0;
  const reads: ((value: unknown) => void)[] = [];
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      boardList: () => deletes ? new Promise(yes => reads.push(yes)) : Promise.resolve({ issues: [issue, second] }),
      boardGet: async (_session: string, id: number) => id === 1 ? issue : second,
      boardDelete: async () => { deletes++; return {}; },
    })],
  });
  try {
    await askDelete(app); confirm(app).click(); await flush(app);
    [...app.document.querySelectorAll<HTMLButtonElement>('.card')]
      .find(card => card.textContent?.includes('Second issue'))!.click(); await flush(app);
    app.document.querySelector<HTMLButtonElement>('[aria-label="Delete issue"]')!.click(); await app.flush();
    confirm(app).click(); await flush(app);
    assert.equal(reads.length, 2);
    reads[1]!({ issues: [] }); await flush(app);
    reads[0]!({ issues: [second] }); await flush(app);
    assert.equal(deletes, 2);
    assert.equal(app.document.querySelectorAll('.card').length, 0, 'old read cannot resurrect the deleted issue');
  } finally { await app.close(); }
});

test('Board note copy uses the shared insecure-context fallback and exact body (#167 batch2)', async context => {
  const body = '  **Raw note**\n';
  const written: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.document.execCommand = () => {
        written.push((window.document.activeElement as HTMLTextAreaElement).value); return true;
      };
    },
    modules: [rpc({ boardGet: async () => ({ ...issue, notes: [{ from: 'alice', at: 100, body }] }) })],
  });
  try {
    await flush(app);
    app.document.querySelector<HTMLButtonElement>('.card')!.click(); await flush(app);
    app.document.querySelector<HTMLButtonElement>('.n-at')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await flush(app);
    assert.deepEqual(written, [body], 'only core/clipboard owns the fallback');
    assert.equal(app.document.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copied');
    await app.advance(1500);
    assert.equal(app.document.querySelector('.m-acts'), null);
  } finally { await app.close(); }
});

test('Board copy failure is persistent and retryable without a false Copied state (#167 batch2)', async context => {
  let allowed = false;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.document.execCommand = () => false;
      Object.defineProperty(window.navigator, 'clipboard', { value: {
        writeText: async () => { if (!allowed) throw Error('denied'); },
      } });
    },
    modules: [rpc({ boardGet: async () => ({ ...issue, notes: [{ from: 'alice', at: 100, body: 'Note' }] }) })],
  });
  try {
    await flush(app);
    app.document.querySelector<HTMLButtonElement>('.card')!.click(); await flush(app);
    app.document.querySelector<HTMLButtonElement>('.n-at')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await flush(app);
    assert.match(app.document.querySelector('.note-feedback [role=alert]')?.textContent ?? '', /Copy failed/);
    await app.advance(2000);
    assert.ok(app.document.querySelector('.note-feedback [role=alert]'));
    assert.equal(app.document.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copy');
    allowed = true;
    app.document.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await flush(app);
    assert.equal(app.document.querySelector('.note-feedback [role=alert]'), null);
    assert.equal(app.document.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copied');
  } finally { await app.close(); }
});

test('a card shows its assignee\u2019s backend icon, lit only in doing while that agent runs, and follows the poll (board #293, #327)', async context => {
  let state = 'working';
  const assigned = { ...issue, assignee: 'builder', status: 'doing' };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      boardList: async () => ({ issues: [assigned] }),
      hubAgents: async () => ({ agents: [{ window: 1, name: 'builder', command: 'kiro', agent: 'kiro', managed: true, state, detail: '', since: 0 }] }),
    })],
  });
  try {
    await flush(app);
    const who = () => app.document.querySelector('.card .c-who');
    assert.equal(who()?.querySelector('.c-assignee')?.textContent, 'builder');
    assert.equal(who()?.querySelector('.c-tile img.ava')?.getAttribute('src'), '/assets/kiro.svg', 'the kiro icon, not a letter');
    assert.equal(who()?.querySelector('.c-tile')?.textContent?.trim(), '', 'no invented lettered avatar');
    assert.ok(who()?.querySelector('.c-live.live-dot'), 'running in DOING: the dot is lit');
    state = 'idle';
    await app.advance(8000); await flush(app);
    assert.equal(who()?.querySelector('.c-live'), null, 'idle after the next poll: no dot');
  } finally { await app.close(); }
});

test('a done card keeps the face and never the working dot (board #327)', async context => {
  const done = { ...issue, assignee: 'builder', status: 'done' };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      boardList: async () => ({ issues: [done] }),
      boardCounts: async () => ({ counts: { fixture: { todo: 0, doing: 0, review: 0, done: 1, total: 1 } } }),
      hubAgents: async () => ({ agents: [{ window: 1, name: 'builder', command: 'kiro', agent: 'kiro', managed: true, state: 'working', detail: '', since: 0 }] }),
    })],
  });
  try {
    await flush(app);
    const who = app.document.querySelector('.card .c-who');
    assert.equal(who?.querySelector('img.ava')?.getAttribute('src'), '/assets/kiro.svg');
    assert.equal(who?.querySelector('.c-live'), null, 'busy elsewhere is not working on THIS done issue');
  } finally { await app.close(); }
});

// ─── A held landing's eligibility (board #357, R2 on c728ac80) ─────────────
// A cross-server pick is a request the PARENT hands this board. It is held
// while the board is committing and acts only while the board is displayed ∧
// focused ∧ serving (the HOST's word, `scope.eligible`) ∧ it is still the same
// request ∧ the board is not destroyed — at the hold, when the board frees,
// and right before the continuation runs. These cells drive the real Board
// with a parent that changes `issueRequest` / `visible` and a host that takes
// the focus away (`setScope({ eligible: false })` is "a leave question merely
// REVEALED this background tree" and "the runtime was detached under a still
// mounted tree" alike: the host answers both with one boolean).
async function landingBoard(context: any, opts: { failSave?: boolean } = {}) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const saves: string[] = [];
  const two = { fixture: counts, other: counts };
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true, guardPage: 'board', issueRequest: null },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      projectList: async () => ({ projects: [
        { project: { id: 'fixture', session: 'fixture', name: 'Fixture' }, live: true },
        { project: { id: 'other', session: 'other', name: 'Other' }, live: true },
      ] }),
      boardCounts: async () => ({ counts: two }),
      boardSave: async (session: string) => { saves.push(session); await held; if (opts.failSave) throw new Error('save refused'); return { id: 1 }; },
    })],
  });
  const q = <E extends Element>(sel: string) => app.document.querySelector<E>(sel);
  const title = () => q('.page-head h1')?.textContent?.trim();
  const dialogs = () => app.document.querySelectorAll('[role=alertdialog]').length;
  const land = (session: string, n: number) => app.setProps({ issueRequest: { session, id: 0, n } });
  const open = async () => { q<HTMLElement>('.card')!.click(); await flush(app); };
  const edit = async (value: string) => {
    const input = q<HTMLInputElement>('.d-title-input')!;
    input.value = value; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush(app);
  };
  const save = async () => { q<HTMLButtonElement>('button.go[aria-label="Save"]')!.click(); await flush(app); };
  await flush(app);
  return { app, q, title, dialogs, land, open, edit, save, saves, release: async () => { release(); await flush(app); } };
}

test('landing cell — hold + free, eligible: held behind the running save, lands once it ends (and the save ran once, on its own board)', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('changed'); await f.save();
  await f.land('other', 1);
  assert.equal(f.title(), 'Fixture', 'nothing leaves under the running request');
  await f.release();
  assert.equal(f.title(), 'Other', 'then it lands');
  assert.deepEqual(f.saves, ['fixture']);
});

test('landing cell — newer request: the newest replaces the held one, whatever order they arrived in', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('changed'); await f.save();
  await f.land('other', 1);
  await f.land('fixture', 2);
  await f.release();
  assert.equal(f.title(), 'Fixture', 'the last pick wins; the older (other) is void');
});

test('landing cell — hold while displayed but NOT the focus (a leave question revealed a background tree): never taken, and not replayed when the focus arrives later', async (context) => {
  const f = await landingBoard(context);
  await f.app.setScope({ eligible: false });
  await f.land('other', 1);
  assert.equal(f.title(), 'Fixture', 'a displayed board that is not the focus does not act');
  await f.app.setScope({ eligible: true });
  assert.equal(f.title(), 'Fixture', 'and the pick, void at the hold, does not replay once it is the focus');
});

test('landing cell — free after detach/absorb with the component still mounted and displayed: the held landing is void, no edit, no question, the draft kept', async (context) => {
  for (const failSave of [false, true]) {
    const f = await landingBoard(context, { failSave });
    await f.open(); await f.edit('my draft'); await f.save();
    await f.land('other', 1);                         // held behind the running save
    await f.app.setScope({ eligible: false });        // the host: no longer the focus / runtime no longer serves
    await f.release();                                // the save settles (ok / refused) on the still-mounted tree
    assert.equal(f.title(), 'Fixture', `save ${failSave ? 'refused' : 'ok'}: the old landing did not move the board`);
    assert.equal(f.dialogs(), 0, 'and asked nothing');
    if (failSave) assert.equal(f.q<HTMLInputElement>('.d-title-input')!.value, 'my draft', 'the refused save keeps the typed draft');
    await f.app.setScope({ eligible: true });
    assert.equal(f.title(), 'Fixture', 'no replay when it is eligible again');
    await f.app.close();
  }
});

test('landing cell — run: a Keep/Discard the landing parked is withdrawn the moment the host takes eligibility away; it does not come back', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('unsaved');
  await f.land('other', 1);
  assert.equal(f.dialogs(), 1, 'the existing guard asks');
  await f.app.setScope({ eligible: false });
  assert.equal(f.dialogs(), 0, 'withdrawn with the landing');
  await f.app.setScope({ eligible: true });
  assert.equal(f.dialogs(), 0, 'and not asked again');
  assert.equal(f.q<HTMLInputElement>('.d-title-input')!.value, 'unsaved', 'the draft is untouched');
});

test('landing cell — leave (not displayed after the hold): void, no replay on return', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('changed'); await f.save();
  await f.land('other', 1);
  await f.app.setProps({ visible: false });
  await f.release();
  await f.app.setProps({ visible: true });
  assert.equal(f.title(), 'Fixture');
});

test('landing cell — null request: the parent clears what it asked, the held landing goes with it', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('changed'); await f.save();
  await f.land('other', 1);
  await f.app.setProps({ issueRequest: null });
  await f.release();
  assert.equal(f.title(), 'Fixture');
});

test('landing cell — destroy while held: nothing runs afterwards (the fixture asserts no async activity after the test)', async (context) => {
  const f = await landingBoard(context);
  await f.open(); await f.edit('changed'); await f.save();
  await f.land('other', 1);
  await f.app.unmount();
  await f.release();
  assert.deepEqual(f.saves, ['fixture']);
});

// ─── The REAL runtime's detach reaches a held landing (board #357, round 5) ─
// `alive()` is a plain read: only the runtime's `onDetach`, turned into a
// stamp by ServerScope, can wake the effect that withdraws a parked question.
// These cells use the real `createServerRuntime` under the real `ServerScope`
// and end the handle with its own `detach()` — no `setScope`.
const compiledReal = compileMount(new URL('./BoardUnderScope.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], {});
async function realLanding(context: any) {
  const app = await (await compiledReal).mount(context, {
    props: { session: 'fixture', visible: true, guardPage: 'board', issueRequest: null },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [rpc({
      projectList: async () => ({ projects: [
        { project: { id: 'fixture', session: 'fixture', name: 'Fixture' }, live: true },
        { project: { id: 'other', session: 'other', name: 'Other' }, live: true },
      ] }),
      boardCounts: async () => ({ counts: { fixture: counts, other: counts } }),
    })],
  });
  const q = <E extends Element>(sel: string) => app.document.querySelector<E>(sel);
  const runtime = () => (app.window as unknown as { __serverRuntime: { detach(): void; alive(): boolean } }).__serverRuntime;
  await flush(app);
  q<HTMLElement>('.card')!.click(); await flush(app);
  const input = q<HTMLInputElement>('.d-title-input')!;
  input.value = 'unsaved edit'; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush(app);
  await app.setProps({ issueRequest: { session: 'other', id: 0, n: 1 } });      // the landing parks the existing Keep/Discard
  return { app, q, runtime, title: () => q('.page-head h1')?.textContent?.trim(), dialogs: () => app.document.querySelectorAll('[role=alertdialog]').length };
}

test('real runtime.detach() withdraws the question a landing parked, voids the landing, keeps the draft — through the production notification, no setScope', async (context) => {
  const f = await realLanding(context);
  assert.equal(f.dialogs(), 1, 'the existing guard asks (dirty draft, eligible landing)');
  assert.equal(f.runtime().alive(), true);
  f.runtime().detach();                       // the call fleet / absorb makes; nothing else changes
  await flush(f.app);
  assert.equal(f.runtime().alive(), false);
  assert.equal(f.dialogs(), 0, 'withdrawn by the runtime s own notification');
  assert.equal(f.title(), 'Fixture', 'the board did not move');
  assert.equal(f.q<HTMLInputElement>('.d-title-input')!.value, 'unsaved edit', 'and the draft is untouched');
});

test('an old Discard clicked after the runtime detached — before anything re-rendered — clears NOTHING: the check is before the discard transaction, not only before the navigation', async (context) => {
  const f = await realLanding(context);
  const discard = [...f.app.document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((b) => /discard/iu.test(b.textContent ?? ''))!;
  f.runtime().detach();
  discard.click();                            // same tick: no flush between the detach and the click
  await flush(f.app);
  assert.equal(f.q<HTMLInputElement>('.d-title-input')!.value, 'unsaved edit', 'the draft survives a stale Discard');
  assert.equal(f.title(), 'Fixture', 'and nothing navigated');
  assert.equal(f.dialogs(), 0);
});
