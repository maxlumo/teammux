// Board #434, reviewer P1-B on 3a33f2ea: the Files page and the Hub drawer
// share one server's review notes, so two editors can hold drafts on one
// key. A save sends the draft ITS editor displays and forgets only that
// object: the other editor's draft, its text and its selection survive and
// can be saved, also after its editor is rebuilt. Two real Files instances,
// one server scope (Files.two.test.svelte).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const two = compileMount(new URL('./Files.two.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof two>['mount']>>;
const CODE = 'fn main() {\n    let answer = 42;\n}\n';
const located = (line = 2, col = 9, end = 15) => ({ state: 'located', range: { line, col, end_line: line, end_col: end } });
const ann = (id: string, note = 'old note') => ({
  id, line: 2, col: 9, end_line: 2, end_col: 15, quote: 'answer', pre: '', suf: '', note, status: 'open',
  revision: 'r1', created: 1, updated: 1, by: 'human', at: located(),
});
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function rpc() {
  const calls: { method: string; args: unknown[] }[] = [];
  const log = (method: string, fn: (...a: any[]) => unknown) => (...args: unknown[]) => { calls.push({ method, args }); return fn(...args); };
  const modules = {
    fsCwd: async () => ({ path: '/w' }),
    fsList: async () => ({ path: '/w', entries: [{ name: 'main.rs', path: '/w/main.rs', type: 'file', size: 40 }] }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 40, mime_hint: 'text/rust' }),
    fsRead: async () => ({ content: CODE, revision: 'r1' }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}), saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 1, stdout: '' }),
    projectList: async () => ({ projects: [{ project: { id: 'p1', name: 'One', session: 'fixture', path: '/w' }, live: true, slots: [] }] }),
    reviewList: async (target: object) => ({ ...target, revision: 'r1', annotations: [ann('e')] }),
    reviewAdd: log('reviewAdd', async () => ann('n')),
    reviewUpdate: log('reviewUpdate', async () => ann('e')),
  };
  return { modules, calls };
}
async function settle(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }
const side = (app: App, which: '.page' | '.drawer') => app.document.querySelector<HTMLElement>(which)!;
function btn(root: Element, label: string | RegExp) {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => typeof label === 'string'
    ? x.getAttribute('aria-label') === label || x.textContent?.trim() === label
    : label.test(x.getAttribute('aria-label') ?? x.textContent ?? ''));
  assert.ok(b, `button ${label}`);
  return b;
}
async function open(app: App, which: '.page' | '.drawer') {
  const row = [...side(app, which).querySelectorAll<HTMLButtonElement>('.file-list .file-main')].find((b) => b.textContent?.includes('main.rs'))!;
  row.click(); await settle(app);
}
async function select(app: App, which: '.page' | '.drawer', row: number, from: number, to: number) {
  const code = side(app, which).querySelectorAll('.cl-row .cl-code')[row]!;
  const node = app.document.createTreeWalker(code, 4).nextNode()!;
  const r = app.document.createRange();
  r.setStart(node, from); r.setEnd(node, to);
  const sel = app.window.getSelection()!;
  sel.removeAllRanges(); sel.addRange(r);
  app.document.dispatchEvent(new app.window.Event('selectionchange'));
  await settle(app);
}
async function type(app: App, el: HTMLTextAreaElement, text: string) {
  el.value = text; el.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle(app);
}
const pendingImports = ['highlight.js'];

test('two editors on one key: A saves without typing again — A\u2019s text is sent, B\u2019s draft survives and saves (add)', async (context) => {
  const { modules, calls } = rpc();
  const app = await (await two).mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules], pendingImports });
  try {
    await settle(app);
    await open(app, '.page'); await open(app, '.drawer');
    const editor = (w: '.page' | '.drawer') => side(app, w).querySelector<HTMLTextAreaElement>('.rv-new textarea');
    // A: a draft on "answer".
    await select(app, '.page', 1, 8, 14);
    btn(app.document.body, 'Comment').click(); await settle(app);
    await type(app, editor('.page')!, 'from A');
    // B, the drawer, the same file: its own draft on "fn".
    await select(app, '.drawer', 0, 0, 2);
    btn(app.document.body, 'Comment').click(); await settle(app);
    await type(app, editor('.drawer')!, 'from B');
    // A saves, without typing again.
    btn(side(app, '.page'), 'Save comment').click(); await settle(app);
    const adds = () => calls.filter((c) => c.method === 'reviewAdd').map((c) => plain(c.args));
    assert.deepEqual([adds()[0][1], adds()[0][2]], [{ line: 2, col: 9, end_line: 2, end_col: 15 }, 'from A'], 'the request is A\u2019s text and A\u2019s selection');
    assert.equal(editor('.page'), null, 'A\u2019s editor closes');
    assert.equal(editor('.drawer')?.value, 'from B', 'B\u2019s draft is still open');
    const state = (app.window as any).__serverState;
    assert.deepEqual([...state.review.notes.values()].map((d: { text: string }) => d.text), ['from B'], 'and still in the shared notes');
    // B saves its own.
    btn(side(app, '.drawer'), 'Save comment').click(); await settle(app);
    assert.deepEqual([adds()[1][1], adds()[1][2]], [{ line: 1, col: 1, end_line: 1, end_col: 3 }, 'from B']);
  } finally { await app.close(); }
});

test('two editors on one key: an edit saved in A keeps B\u2019s edit draft, also when B\u2019s editor is rebuilt (edit)', async (context) => {
  const { modules, calls } = rpc();
  const app = await (await two).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules], pendingImports });
  try {
    await settle(app);
    await open(app, '.page'); await open(app, '.drawer');
    const card = (w: '.page' | '.drawer') => side(app, w).querySelector<HTMLElement>('[data-review-id="e"]');
    const reveal = async (w: '.page' | '.drawer') => {
      const fold = btn(side(app, w), /Comments \(\d\)/u);
      if (fold.getAttribute('aria-expanded') !== 'true') { fold.click(); await settle(app); }
    };
    const edit = async (w: '.page' | '.drawer') => {
      await reveal(w);
      card(w)!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); await settle(app);
      [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Edit'))!.click(); await settle(app);
    };
    await edit('.page');
    await type(app, card('.page')!.querySelector('textarea')!, 'edit A');
    await edit('.drawer');
    await type(app, card('.drawer')!.querySelector('textarea')!, 'edit B');
    btn(card('.page')!, 'Save comment').click(); await settle(app);
    const updates = () => calls.filter((c) => c.method === 'reviewUpdate').map((c) => plain(c.args)[2]);
    assert.deepEqual(updates(), [{ note: 'edit A' }], 'A sent its own text');
    assert.equal(card('.drawer')!.querySelector('textarea')?.value, 'edit B', 'B\u2019s edit stays open');
    // B's editor rebuilt from the shared notes (its file opened again).
    await app.setProps({ navRequest: { file: '/w/main.rs', n: 1 } }); await settle(app);
    await reveal('.drawer');
    assert.equal(card('.drawer')!.querySelector('textarea')?.value, 'edit B', 'B\u2019s draft is restored from the shared notes');
    btn(card('.drawer')!, 'Save comment').click(); await settle(app);
    assert.deepEqual(updates(), [{ note: 'edit A' }, { note: 'edit B' }]);
  } finally { await app.close(); }
});

test('two editors on one key: A\u2019s Cancel closes A only; B\u2019s draft stays in the shared notes and comes back rebuilt', async (context) => {
  const { modules, calls } = rpc();
  const app = await (await two).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules], pendingImports });
  try {
    await settle(app);
    await open(app, '.page'); await open(app, '.drawer');
    const editor = (w: '.page' | '.drawer') => side(app, w).querySelector<HTMLTextAreaElement>('.rv-new textarea');
    await select(app, '.page', 1, 8, 14);
    btn(app.document.body, 'Comment').click(); await settle(app);
    await type(app, editor('.page')!, 'from A');
    await select(app, '.drawer', 0, 0, 2);
    btn(app.document.body, 'Comment').click(); await settle(app);
    await type(app, editor('.drawer')!, 'from B');
    btn(side(app, '.page'), 'Cancel').click(); await settle(app);
    assert.equal(editor('.page'), null);
    const state = (app.window as any).__serverState;
    assert.deepEqual([...state.review.notes.values()].map((d: { text: string }) => d.text), ['from B'], 'A\u2019s Cancel removed nothing of B\u2019s');
    await app.setProps({ navRequest: { file: '/w/main.rs', n: 1 } }); await settle(app);
    assert.equal(editor('.drawer')?.value, 'from B', 'B rebuilt gets its draft back');
    btn(side(app, '.drawer'), 'Save comment').click(); await settle(app);
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewAdd').map((c) => [c.args[1], c.args[2]])), [[{ line: 1, col: 1, end_line: 1, end_col: 3 }, 'from B']]);
  } finally { await app.close(); }
});
