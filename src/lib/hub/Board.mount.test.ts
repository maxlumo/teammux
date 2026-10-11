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
