// Review comments in the Files preview (board #434, files-review.md): the
// real Files page, its real FileReview, over a mocked transport. Selection →
// ＋ → card; stale; the card states; the highlight registry with and without
// the Custom Highlight API; resolve and delete; the feedback hand-off to the
// room's draft; one draft per project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Files.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });

const CODE = 'fn main() {\n    let answer = 42;\n}\n';
type Ann = Record<string, unknown>;
const ann = (id: string, at: unknown, extra: Ann = {}): Ann => ({
  id, line: 2, col: 9, end_line: 2, end_col: 15, quote: 'answer', pre: '', suf: '', note: `note ${id}`, status: 'open',
  revision: 'r1', created: 1, updated: 1, by: 'human', at, ...extra,
});
const located = (line = 2, col = 9, endCol = 15) => ({ state: 'located', range: { line, col, end_line: line, end_col: endCol } });

function rpc(opts: { content?: string; projects?: unknown[]; annotations?: () => Ann[]; extra?: Record<string, (...a: any[]) => unknown> } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const log = (method: string, fn: (...a: any[]) => unknown) => (...args: unknown[]) => { calls.push({ method, args }); return fn(...args); };
  const projects = opts.projects ?? [{ project: { id: 'p1', name: 'One', session: 'fixture', path: '/w' }, live: true, slots: [] }];
  const modules = {
    fsCwd: async () => ({ path: '/w' }),
    fsList: async () => ({ path: '/w', entries: [{ name: 'main.rs', path: '/w/main.rs', type: 'file', size: 40 }, { name: 'other.rs', path: '/w/other.rs', type: 'file', size: 40 }] }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 40, mime_hint: 'text/rust' }),
    fsRead: async () => ({ content: opts.content ?? CODE, revision: 'r1' }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}), saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 1, stdout: '' }),
    projectList: log('projectList', async () => ({ projects })),
    reviewList: log('reviewList', async (target: { project_id: string; path: string }) => ({ ...target, revision: 'r1', annotations: opts.annotations?.() ?? [] })),
    reviewAdd: log('reviewAdd', async () => ann('new', located())),
    reviewUpdate: log('reviewUpdate', async () => ann('a', located())),
    reviewDelete: log('reviewDelete', async () => ({ ok: true })),
    reviewFeedback: log('reviewFeedback', async () => ({ project_id: 'p1', path: '/w/main.rs', revision: 'r1', text: '[Document feedback on /w/main.rs — 1 comment]\n1. (line 2, col 9, "answer" in "    let answer = 42;"): "rename"', count: 1 })),
    ...opts.extra,
  };
  return { modules, calls };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
type MountOptions = Parameters<Awaited<typeof compiled>['mount']>[1];
/** The code view loads its highlighter lazily; here it never arrives. */
const mount = async (context: Parameters<Awaited<typeof compiled>['mount']>[0], options: MountOptions) =>
  (await compiled).mount(context, { pendingImports: ['highlight.js'], ...options });
async function settle(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }
function button(app: App, label: string | RegExp) {
  const all = [...app.document.querySelectorAll<HTMLButtonElement>('button')];
  const el = all.find((b) => typeof label === 'string' ? b.getAttribute('aria-label') === label || b.textContent?.trim() === label : label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  assert.ok(el, `button ${label}`);
  return el;
}
async function open(app: App, name = 'main.rs') {
  const row = [...app.document.querySelectorAll<HTMLButtonElement>('.file-list .file-main')].find((b) => b.querySelector('.file-name')?.textContent?.trim() === name);
  assert.ok(row, `row ${name}`);
  row.click();
  await settle(app);
}
/** Select `[from, to)` UTF-16 units of code row `row` (0-based) and say so. */
async function selectCode(app: App, row: number, from: number, to: number) {
  const code = app.document.querySelectorAll('.cl-row .cl-code')[row]!;
  const walker = app.document.createTreeWalker(code, 4);
  const node = walker.nextNode()!;
  const r = app.document.createRange();
  r.setStart(node, from); r.setEnd(node, to);
  const sel = app.window.getSelection()!;
  sel.removeAllRanges(); sel.addRange(r);
  app.document.dispatchEvent(new app.window.Event('selectionchange'));
  await settle(app);
}
async function type(app: App, el: HTMLTextAreaElement, text: string) {
  el.value = text;
  el.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle(app);
}
/** A value from the page's realm, as plain data. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const cards = (app: App) => [...app.document.querySelectorAll<HTMLElement>('.rv-card[data-review-id]')];
/** A stand-in Custom Highlight API: a Set per name, as the real one is. */
function fakeHighlights(win: any) {
  const reg = new Map<string, Set<unknown>>();
  win.Highlight = class extends Set { constructor(...r: unknown[]) { super(r); } };
  win.CSS = { highlights: reg };
  return reg;
}

test('select → ＋ → note → saved against the revision on screen; the card follows (#434)', async (context) => {
  let saved: Ann[] = [];
  const { modules, calls } = rpc({ annotations: () => saved, extra: {} });
  modules.reviewAdd = (async (...args: unknown[]) => { calls.push({ method: 'reviewAdd', args }); saved = [ann('n1', located(), { note: 'rename it' })]; return saved[0]; }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    assert.ok(calls.some((c) => c.method === 'reviewList'), 'the cards are read for the open file');
    await selectCode(app, 1, 8, 14); // "answer"
    button(app, 'Comment').click(); await settle(app);
    const input = app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!;
    assert.ok(input, 'the note editor is the card itself');
    assert.equal(button(app, 'Save comment').disabled, true, 'an empty note cannot be saved');
    await type(app, input, 'rename it');
    button(app, 'Save comment').click(); await settle(app);
    const add = calls.find((c) => c.method === 'reviewAdd')!;
    assert.deepEqual(plain(add.args), [{ project_id: 'p1', path: '/w/main.rs' }, { line: 2, col: 9, end_line: 2, end_col: 15 }, 'rename it', 'r1']);
    assert.equal(app.document.querySelector('.rv-new'), null, 'the editor closes once saved');
    assert.equal(button(app, 'Comments (1)').getAttribute('aria-expanded'), 'true', 'the list opened with the editor and stays open');
    assert.equal(cards(app).length, 1);
    assert.match(cards(app)[0]!.textContent ?? '', /answer[\s\S]*rename it[\s\S]*Line 2/u);
  } finally { await app.close(); }
});

test('a stale add keeps the note and says why; nothing is saved (#434 P1-A)', async (context) => {
  const { modules, calls } = rpc();
  modules.reviewAdd = (async (...args: unknown[]) => { calls.push({ method: 'reviewAdd', args }); return { stale: true, revision: 'r2' }; }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'keep me');
    button(app, 'Save comment').click(); await settle(app);
    assert.match(app.document.querySelector('.rv-new [role=alert]')?.textContent ?? '', /changed after you selected/u);
    assert.equal(app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!.value, 'keep me');
  } finally { await app.close(); }
});

test('card states: located, missing, ambiguous, and beyond the 3000-line preview — never "missing" (#434)', async (context) => {
  const big = Array.from({ length: 3005 }, (_, i) => `line ${i + 1}`).join('\n');
  const { modules } = rpc({ content: big, annotations: () => [
    ann('a', located(2, 1, 5), { quote: 'line' }), ann('b', { state: 'missing' }), ann('c', { state: 'ambiguous' }), ann('d', located(3002, 1, 5), { quote: 'line' }),
  ] });
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    button(app, 'Comments (4)').click(); await settle(app);
    const text = cards(app).map((c) => c.querySelector('.rv-meta')?.textContent?.trim());
    assert.deepEqual(text, ['Line 2', 'Beyond the preview (line 3002)', 'The quoted text is no longer in the file', 'The quoted text is in the file more than once; no position']);
  } finally { await app.close(); }
});

test('highlights: this instance adds and removes only its own ranges; without the API the cards still work (#434 P2)', async (context) => {
  let reg: Map<string, Set<unknown>> | null = null;
  const foreign = {};
  const { modules } = rpc({ annotations: () => [ann('a', located())] });
  const app = await mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules],
    setup(win) { reg = fakeHighlights(win); reg.set('review', new (win as any).Highlight(foreign)); },
  });
  try {
    await settle(app);
    await open(app);
    const ranges = [...reg!.get('review')!];
    assert.equal(ranges.length, 2, 'the other instance\u2019s range and ours');
    const mine = ranges.find((r) => r !== foreign) as Range;
    assert.equal(mine.toString(), 'answer', 'the highlight is exactly the commented text');
    await app.unmount();
    assert.deepEqual([...reg!.get('review')!], [foreign], 'unmounting clears ours and nobody else\u2019s');
  } finally { await app.close(); }

  const bare = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc({ annotations: () => [ann('a', located())] }).modules] });
  try {
    await settle(bare);
    await open(bare);
    button(bare, 'Comments (1)').click(); await settle(bare);
    assert.equal(cards(bare).length, 1, 'no Highlight API: the card is listed all the same');
  } finally { await bare.close(); }
});

test('the card menu resolves, and deletes only through the one confirm (#434)', async (context) => {
  const { modules, calls } = rpc({ annotations: () => [ann('a', located())] });
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    button(app, 'Comments (1)').click(); await settle(app);
    const menuOf = async () => { cards(app)[0]!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); await settle(app); };
    await menuOf();
    [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Resolve'))!.click(); await settle(app);
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewUpdate').map((c) => c.args)), [[{ project_id: 'p1', path: '/w/main.rs' }, 'a', { status: 'resolved' }]]);
    await menuOf();
    [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Delete'))!.click(); await settle(app);
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'Delete asks first');
    assert.equal(calls.filter((c) => c.method === 'reviewDelete').length, 0);
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((b) => b.textContent?.trim() === 'Delete')!.click(); await settle(app);
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewDelete').map((c) => c.args)), [[{ project_id: 'p1', path: '/w/main.rs' }, 'a']]);
  } finally { await app.close(); }
});

test('Send as feedback lands once in the room\u2019s latest draft, following a rename; a removed project lands nothing (#434 P1-C)', async (context) => {
  let rename = false;
  const renamed = [{ project: { id: 'p1', name: 'One', session: 'renamed', path: '/w' }, live: true, slots: [] }];
  const { modules } = rpc({ annotations: () => [ann('a', located())] });
  const first = modules.projectList;
  modules.projectList = (async () => (rename ? { projects: renamed } : first())) as never;
  const landed: string[] = [];
  const app = await mount(context, {
    props: { visible: true, session: 'fixture', onfeedback: (s: string) => landed.push(s) }, modules: [modules],
    setup(win) { win.localStorage.clear(); },
  });
  try {
    await settle(app);
    const state = (app.window as any).__serverState;
    state.prefs.setDraft('renamed', 'typed before');
    await open(app);
    rename = true; // renamed while the block is asked for: the id is followed
    button(app, 'Send as feedback').click(); await settle(app);
    assert.equal(state.prefs.draft('renamed'), 'typed before\n\n[Document feedback on /w/main.rs — 1 comment]\n1. (line 2, col 9, "answer" in "    let answer = 42;"): "rename"');
    assert.equal(state.prefs.draft('fixture'), '', 'the old session name gets nothing');
    assert.deepEqual(landed, ['renamed']);
    assert.match(app.document.querySelector('.rv-status[role=status]')?.textContent ?? '', /not sent/u);
  } finally { await app.close(); }

  const gone = rpc({ annotations: () => [ann('a', located())] });
  let removed = false;
  const firstGone = gone.modules.projectList;
  gone.modules.projectList = (async () => (removed ? { projects: [] } : firstGone())) as never;
  const app2 = await mount(context, { props: { visible: true, session: 'fixture', onfeedback: (s: string) => landed.push(s) }, modules: [gone.modules] });
  try {
    await settle(app2);
    await open(app2);
    removed = true; // the project is removed while the block is asked for
    button(app2, 'Send as feedback').click(); await settle(app2);
    assert.equal((app2.window as any).__serverState.prefs.draft('fixture'), '');
    assert.deepEqual(landed, ['renamed'], 'no second landing');
    assert.match(app2.document.querySelector('.rv-status[role=status]')?.textContent ?? '', /project or file changed/u);
  } finally { await app2.close(); }
});

test('two projects at one root: the person picks, and each keeps its own unsaved note (#434 P1-C)', async (context) => {
  const projects = [
    { project: { id: 'p1', name: 'One', session: 'one', path: '/w' }, live: true, slots: [] },
    { project: { id: 'p2', name: 'Two', session: 'two', path: '/w/' }, live: true, slots: [] },
  ];
  const { modules, calls } = rpc({ projects });
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    assert.equal(calls.filter((c) => c.method === 'reviewList').length, 0, 'nothing is read before a project is picked');
    const pickProject = async (name: string) => {
      app.document.querySelector<HTMLButtonElement>('.rv-project button')!.click(); await settle(app);
      [...app.document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.includes(name))!.click(); await settle(app);
    };
    await pickProject('One');
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewList').at(-1)!.args), [{ project_id: 'p1', path: '/w/main.rs' }]);
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'for one');
    await pickProject('Two');
    assert.equal(app.document.querySelector('.rv-new'), null, 'project Two has no unsaved note');
    await pickProject('One');
    assert.equal(app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')?.value, 'for one', 'project One\u2019s note came back');
  } finally { await app.close(); }
});

test('a file in no project has no review affordance (#434)', async (context) => {
  const { modules, calls } = rpc({ projects: [{ project: { id: 'p9', name: 'Else', session: 'else', path: '/elsewhere' }, live: true, slots: [] }] });
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    assert.equal(app.document.querySelector('.rv-fold, .rv-column'), null);
    await selectCode(app, 1, 8, 14);
    assert.equal(app.document.querySelector('.rv-pick'), null);
    assert.equal(calls.filter((c) => c.method === 'reviewList').length, 0);
  } finally { await app.close(); }
});

test('markdown: a selection in the rendered view maps to its raw source range, and its highlight is found again (#434)', async (context) => {
  const md = '# Title\n\nSome **bold** words here.\n';
  let saved: Ann[] = [];
  const { modules, calls } = rpc({ content: md, annotations: () => saved });
  modules.fsStat = (async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 40, mime_hint: 'text/markdown' })) as never;
  modules.reviewAdd = (async (...args: unknown[]) => {
    calls.push({ method: 'reviewAdd', args });
    saved = [ann('m1', located(3, 8, 12), { quote: 'bold' })];
    return saved[0];
  }) as never;
  let reg: Map<string, Set<unknown>> | null = null;
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules], setup(win) { reg = fakeHighlights(win); } });
  try {
    await settle(app);
    await open(app);
    const strong = app.document.querySelector('.md-render p[data-src="3-3"] strong')!;
    assert.ok(strong, 'the preview is the span render');
    const r = app.document.createRange();
    r.selectNodeContents(strong.firstChild!);
    const sel = app.window.getSelection()!;
    sel.removeAllRanges(); sel.addRange(r);
    app.document.dispatchEvent(new app.window.Event('selectionchange'));
    await settle(app);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'why bold');
    button(app, 'Save comment').click(); await settle(app);
    assert.deepEqual(plain(calls.find((c) => c.method === 'reviewAdd')!.args[1]), { line: 3, col: 8, end_line: 3, end_col: 12 },
      'the raw range of the shown words, inside their markup');
    const painted = [...(reg!.get('review') ?? [])] as Range[];
    assert.deepEqual(painted.map((x) => x.toString()), ['bold'], 'the highlight is the shown text');
  } finally { await app.close(); }
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test('a pending feedback is bound to the preview: Back, hide, a server switch or another file lands nothing and navigates nowhere (#434 P1-B)', async (context) => {
  const block = { project_id: 'p1', path: '/w/main.rs', revision: 'r1', text: 'BLOCK', count: 1 };
  const walks: [string, (app: App) => Promise<void>, (app: App) => Promise<void>][] = [
    ['Back', async (app) => { button(app, 'Back').click(); await settle(app); }, async (app) => { await open(app); }],
    ['hide', async (app) => { await app.setProps({ visible: false }); await settle(app); }, async (app) => { await app.setProps({ visible: true }); await settle(app); }],
    ['server switch', async (app) => { await app.setScope({ eligible: false }); await settle(app); }, async (app) => { await app.setScope({ eligible: true }); await settle(app); }],
    ['another file', async (app) => { await app.setProps({ navRequest: { file: '/w/other.rs', n: 1 } }); await settle(app); }, async () => {}],
  ];
  for (const pending of ['review_feedback', 'the second project_list'] as const) {
    for (const [name, walk, back] of walks) {
      const held = deferred<unknown>();
      let hold = false;
      const { modules } = rpc({ annotations: () => [ann('a', located())] });
      const list = modules.projectList;
      modules.reviewFeedback = (async () => (pending === 'review_feedback' && hold ? held.promise : block)) as never;
      modules.projectList = (async () => (pending !== 'review_feedback' && hold ? held.promise : list())) as never;
      const landed: string[] = [];
      const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null, onfeedback: (s: string) => landed.push(s) }, modules: [modules], setup(win) { win.localStorage.clear(); } });
      try {
        await settle(app);
        await app.setScope({ eligible: true });
        const state = (app.window as any).__serverState;
        await open(app);
        hold = true;
        button(app, 'Send as feedback').click(); await settle(app);
        await walk(app);
        hold = false;
        const why = `${pending} pending, then ${name}`;
        if (name === 'another file') {
          // The new file is not stuck behind the old request still in flight.
          button(app, 'Send as feedback').click(); await settle(app);
          assert.equal(state.prefs.draft('fixture'), 'BLOCK', `${why}: the new file sends while the old request is pending`);
          state.prefs.setDraft('fixture', '');
          landed.length = 0;
        }
        held.resolve(pending === 'review_feedback' ? block : await list());
        await settle(app);
        assert.equal(state.prefs.draft('fixture'), '', `${why}: no draft written`);
        assert.deepEqual(landed, [], `${why}: no navigation asked`);
        assert.equal([...state.review.composers].length, 0);
        // The page it went to (or came back to) still sends, never stuck.
        await back(app);
        button(app, 'Send as feedback').click(); await settle(app);
        assert.equal(state.prefs.draft('fixture'), 'BLOCK', `${why}: the next send lands`);
        assert.deepEqual(landed, ['fixture']);
      } finally { await app.close(); }
    }
  }
});

test('a save retired by a file switch still forgets its note, and the next file saves (#434 P1-B)', async (context) => {
  const held = deferred<unknown>();
  let hold = true;
  const { modules, calls } = rpc();
  modules.reviewAdd = (async (...args: unknown[]) => { calls.push({ method: 'reviewAdd', args }); return hold ? held.promise : ann('n2', located()); }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'first');
    button(app, 'Save comment').click(); await settle(app);
    await app.setProps({ navRequest: { file: '/w/other.rs', n: 1 } }); await settle(app);
    held.resolve(ann('n1', located()));
    await settle(app);
    hold = false;
    // The new file is not stuck behind the old save.
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'second');
    assert.equal(button(app, 'Save comment').disabled, false);
    button(app, 'Save comment').click(); await settle(app);
    assert.deepEqual(calls.filter((c) => c.method === 'reviewAdd').map((c) => plain(c.args)[0].path), ['/w/main.rs', '/w/other.rs']);
    // Back to the first file: its stored note is not offered again as unsaved.
    await app.setProps({ navRequest: { file: '/w/main.rs', n: 2 } }); await settle(app);
    assert.equal(app.document.querySelector('.rv-new'), null);
  } finally { await app.close(); }
});

test('a failed project list is an error with a retry, not "not in a project"; nothing is read meanwhile (#434 P2)', async (context) => {
  let fail = true;
  const { modules, calls } = rpc({ annotations: () => [ann('a', located())] });
  const list = modules.projectList;
  modules.projectList = (async () => { if (fail) throw new Error('socket closed'); return list(); }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    assert.match(app.document.querySelector('.rv-warn[role=alert]')?.textContent ?? '', /Could not read the projects: socket closed/u);
    assert.equal(calls.filter((c) => c.method === 'reviewList').length, 0, 'no project, no read');
    await selectCode(app, 1, 8, 14);
    assert.equal(app.document.querySelector('.rv-pick'), null, 'no ＋ on an unverified project');
    fail = false;
    button(app, 'Retry').click(); await settle(app);
    assert.equal(app.document.querySelector('.rv-warn[role=alert]'), null);
    assert.ok(calls.some((c) => c.method === 'reviewList'));
  } finally { await app.close(); }
});

/** A layout for jsdom (it measures nothing): the preview is wide, each code
 * row is 20px tall from the scroller's top, every card is 100px tall, and
 * the scroller can be scrolled. */
function fakeLayout(win: any, state: { scroll: number }) {
  win.ResizeObserver = class {
    cb: (e: unknown[]) => void;
    constructor(cb: (e: unknown[]) => void) { this.cb = cb; }
    observe(el: Element) { if (el.classList.contains('rv-wrap')) this.cb([{ contentRect: { width: 1200 } }]); }
    unobserve() {} disconnect() {}
  };
  const rowTop = (n: Node) => {
    const row = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('.cl-row');
    const rows = [...win.document.querySelectorAll('.cl-row')];
    return 300 + rows.indexOf(row) * 20 - state.scroll;
  };
  win.Range.prototype.getBoundingClientRect = function () { const t = rowTop(this.startContainer); return { top: t, bottom: t + 20, left: 0, right: 10 }; };
  const proto = win.HTMLElement.prototype;
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('code-lined')) return { top: 100, bottom: 700, left: 0, right: 900 };
    if (this.classList.contains('rv-lane')) return { top: 160, bottom: 700, left: 900, right: 1160 };
    return orig.call(this);
  };
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return this.classList.contains('rv-card') ? 100 : 0; } });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return this.classList.contains('code-lined') ? 2000 : 0; } });
}

test('wide column: cards are placed on every change, never overlap, and stay reachable past the preview (#434 P1-C)', async (context) => {
  const layout = { scroll: 0 };
  let saved: Ann[] = [ann('a', located(2, 5, 8), { quote: 'let' }), ann('m', { state: 'missing' })];
  const { modules, calls } = rpc({ annotations: () => saved });
  modules.reviewAdd = (async (...args: unknown[]) => {
    calls.push({ method: 'reviewAdd', args });
    saved = [...saved, ann('b', located(2, 9, 15), { note: 'a second, longer comment on the same short line' })];
    return saved.at(-1);
  }) as never;
  let reg: Map<string, Set<unknown>> | null = null;
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules], setup(win) { reg = fakeHighlights(win); fakeLayout(win, layout); } });
  try {
    await settle(app);
    await open(app);
    assert.ok(app.document.querySelector('.rv-column'), 'wide: the column');
    const top = (id: string) => parseFloat(app.document.querySelector<HTMLElement>(`.rv-lane-inner [data-review-id="${id}"]`)!.style.top);
    // Line 2's highlight is at 320 on screen and the lane's top at 160: the
    // card sits at 160 in the lane, level with its text.
    assert.equal(top('a'), 160);
    assert.ok(top('m') >= top('a') + 100, 'the missing card follows below, no overlap');
    // An add on the SAME line, saved without a Reload: placed at once, under the first.
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!, 'second');
    button(app, 'Save comment').click(); await settle(app);
    assert.ok(top('b') >= top('a') + 100, `the new card is pushed below the first: ${top('a')} / ${top('b')}`);
    assert.ok(top('m') >= Math.max(top('a'), top('b')) + 100, 'the missing card stays after both');
    const inner = app.document.querySelector<HTMLElement>('.rv-lane-inner')!;
    assert.ok(parseFloat(inner.style.height) >= top('m') + 100, 'the lane holds the whole stack: every card is reachable by scrolling it');
    // A scroll of the preview moves the lane with it, and the cards keep their places.
    layout.scroll = 40;
    const sc = app.document.querySelector<HTMLElement>('.code-lined')!;
    Object.defineProperty(sc, 'scrollTop', { configurable: true, get: () => 40, set() {} });
    sc.dispatchEvent(new app.window.Event('scroll'));
    await settle(app);
    assert.equal(app.document.querySelector<HTMLElement>('.rv-lane')!.scrollTop, 40, 'the lane follows the preview');
    assert.equal(top('a'), 160, 'content coordinates: unchanged by the scroll');
    void reg;
  } finally { await app.close(); }
});

test('ABA: a request that saw the preview leave stays dead when the same preview comes back first (#434 P1-B on 93c1b929)', async (context) => {
  const block = { project_id: 'p1', path: '/w/main.rs', revision: 'r1', text: 'BLOCK', count: 1 };
  const trips: [string, (app: App) => Promise<void>][] = [
    ['hide, then show', async (app) => { await app.setProps({ visible: false }); await settle(app); await app.setProps({ visible: true }); await settle(app); }],
    ['server away, then back', async (app) => { await app.setScope({ eligible: false }); await settle(app); await app.setScope({ eligible: true }); await settle(app); }],
  ];
  for (const pending of ['review_feedback', 'the second project_list'] as const) {
    for (const [name, trip] of trips) {
      const held = deferred<unknown>();
      let hold = false;
      const { modules } = rpc({ annotations: () => [ann('a', located())] });
      const list = modules.projectList;
      modules.reviewFeedback = (async () => (pending === 'review_feedback' && hold ? held.promise : block)) as never;
      modules.projectList = (async () => (pending !== 'review_feedback' && hold ? held.promise : list())) as never;
      const landed: string[] = [];
      const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null, onfeedback: (s: string) => landed.push(s) }, modules: [modules], setup(win) { win.localStorage.clear(); } });
      try {
        await settle(app);
        await app.setScope({ eligible: true });
        const state = (app.window as any).__serverState;
        await open(app);
        hold = true;
        button(app, 'Send as feedback').click(); await settle(app);
        await trip(app); // left AND came back, before the answer
        hold = false;
        held.resolve(pending === 'review_feedback' ? block : await list());
        await settle(app);
        const why = `${pending} pending, ${name}, then the answer`;
        assert.equal(state.prefs.draft('fixture'), '', `${why}: no draft`);
        assert.deepEqual(landed, [], `${why}: no navigation`);
        assert.equal(button(app, 'Send as feedback').getAttribute('aria-busy') === 'true', false, `${why}: not left pending`);
        button(app, 'Send as feedback').click(); await settle(app);
        assert.equal(state.prefs.draft('fixture'), 'BLOCK', `${why}: the next send lands`);
        assert.deepEqual(landed, ['fixture']);
      } finally { await app.close(); }
    }
  }
});

test('a note typed while its first version is saving survives that save and is saveable: add and edit (#434 P1-B on 93c1b929)', async (context) => {
  const held = deferred<unknown>();
  let hold = true;
  let saved: Ann[] = [ann('e', located())];
  const { modules, calls } = rpc({ annotations: () => saved });
  modules.reviewAdd = (async (...args: unknown[]) => {
    calls.push({ method: 'reviewAdd', args });
    if (hold) return held.promise;
    return ann('n2', located());
  }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    // ADD: N1 saving, N2 typed in the same editor, N1 answers.
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    const input = () => app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea');
    await type(app, input()!, 'N1');
    button(app, 'Save comment').click(); await settle(app);
    await type(app, input()!, 'N2');
    held.resolve(ann('n1', located()));
    await settle(app);
    assert.equal(input()?.value, 'N2', 'N2 is still there after N1 was stored');
    hold = false;
    const save = [...app.document.querySelectorAll<HTMLButtonElement>('.rv-new button')].find((b) => b.textContent?.includes('Save comment'))!;
    assert.equal(save.disabled, false, 'and saveable');
    save.click(); await settle(app);
    assert.deepEqual(calls.filter((c) => c.method === 'reviewAdd').map((c) => plain(c.args)[2]), ['N1', 'N2']);
    assert.equal(input(), null, 'N2 stored: the editor closes');

    // EDIT: the same for an existing card.
    const heldEdit = deferred<unknown>();
    let holdEdit = true;
    modules.reviewUpdate = (async (...args: unknown[]) => { calls.push({ method: 'reviewUpdate', args }); return holdEdit ? heldEdit.promise : ann('e', located()); }) as never;
    button(app, /Comments \(\d\)/u).getAttribute('aria-expanded') === 'true' || button(app, /Comments \(\d\)/u).click();
    await settle(app);
    const card = () => app.document.querySelector<HTMLElement>('[data-review-id="e"]')!;
    card().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); await settle(app);
    [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Edit'))!.click(); await settle(app);
    const edit = () => card().querySelector<HTMLTextAreaElement>('textarea');
    await type(app, edit()!, 'E1');
    [...card().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Save comment'))!.click(); await settle(app);
    await type(app, edit()!, 'E2');
    heldEdit.resolve(ann('e', located()));
    await settle(app);
    assert.equal(edit()?.value, 'E2', 'E2 survives E1\u2019s save');
    holdEdit = false;
    [...card().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Save comment'))!.click(); await settle(app);
    assert.deepEqual(calls.filter((c) => c.method === 'reviewUpdate').map((c) => plain(c.args)[2]), [{ note: 'E1' }, { note: 'E2' }]);
    saved = [ann('e', located(), { note: 'E2' })];
  } finally { await app.close(); }
});

test('N1 saving, away and back, N2 written: N1\u2019s answer keeps N2 (#434 P1-B on 93c1b929)', async (context) => {
  const held = deferred<unknown>();
  const { modules, calls } = rpc();
  let hold = true;
  modules.reviewAdd = (async (...args: unknown[]) => { calls.push({ method: 'reviewAdd', args }); return hold ? held.promise : ann('n2', located()); }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    const input = () => app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea');
    await type(app, input()!, 'N1');
    button(app, 'Save comment').click(); await settle(app);
    await app.setProps({ navRequest: { file: '/w/other.rs', n: 1 } }); await settle(app);
    await app.setProps({ navRequest: { file: '/w/main.rs', n: 2 } }); await settle(app);
    assert.equal(input()?.value, 'N1', 'back on A, the unsaved note is restored');
    await type(app, input()!, 'N2');
    held.resolve(ann('n1', located()));
    await settle(app);
    hold = false;
    assert.equal(input()?.value, 'N2', 'N1 stored; N2, written later, is kept');
    button(app, 'Save comment').click(); await settle(app);
    assert.deepEqual(calls.filter((c) => c.method === 'reviewAdd').map((c) => plain(c.args)[2]), ['N1', 'N2']);
  } finally { await app.close(); }
});

test('a lane the person scrolled stays where they put it when a hover or focus re-places the cards (#434 P1-C on 93c1b929)', async (context) => {
  const layout = { scroll: 0 };
  const many = Array.from({ length: 6 }, (_v, i) => ann(`c${i}`, located(2, 5, 8), { quote: 'let', note: `long comment ${i}` }));
  const { modules, calls } = rpc({ annotations: () => many });
  const app = await mount(context, { props: { visible: true, session: 'fixture' }, modules: [modules], setup(win) { fakeHighlights(win); fakeLayout(win, layout); } });
  try {
    await settle(app);
    await open(app);
    const inner = app.document.querySelector<HTMLElement>('.rv-lane-inner')!;
    const lane = app.document.querySelector<HTMLElement>('.rv-lane')!;
    const tops = () => [...inner.querySelectorAll<HTMLElement>('[data-review-id]')].map((el) => el.style.top);
    const before = { tops: tops(), height: inner.style.height };
    assert.equal(new Set(before.tops).size, 6, 'six cards, six places, stacked');
    // The preview stays still; the person scrolls the lane to its end.
    lane.scrollTop = 520;
    const cards = [...inner.querySelectorAll<HTMLElement>('[data-review-id]')];
    cards[5]!.dispatchEvent(new app.window.MouseEvent('mouseenter')); await settle(app);
    cards[2]!.dispatchEvent(new app.window.FocusEvent('focusin', { bubbles: true })); await settle(app);
    assert.deepEqual({ tops: tops(), height: inner.style.height }, before, 'a re-place reads no lane scroll: nothing drifts');
    assert.equal(lane.scrollTop, 520, 'and the lane is left where the person put it');
    // The last card works from there.
    cards[5]!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); await settle(app);
    [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Resolve'))!.click(); await settle(app);
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewUpdate').map((c) => c.args[1])), ['c5']);
  } finally { await app.close(); }
});

test('a draft cancelled while its save is pending and made again under the same key survives that save: add and edit (#434 P1-B on 58df654c)', async (context) => {
  const heldAdd = deferred<unknown>(), heldEdit = deferred<unknown>();
  let holdAdd = true, holdEdit = true;
  const { modules, calls } = rpc({ annotations: () => [ann('e', located())] });
  modules.reviewAdd = (async (...args: unknown[]) => { calls.push({ method: 'reviewAdd', args }); return holdAdd ? heldAdd.promise : ann('n2', located()); }) as never;
  modules.reviewUpdate = (async (...args: unknown[]) => { calls.push({ method: 'reviewUpdate', args }); return holdEdit ? heldEdit.promise : ann('e', located()); }) as never;
  const app = await mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [modules] });
  try {
    await settle(app);
    await open(app);
    const input = () => app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea');
    const inNew = (label: string) => [...app.document.querySelectorAll<HTMLButtonElement>('.rv-new button')].find((b) => b.textContent?.includes(label))!;
    // ADD: one keystroke, save N1 (pending), Cancel, a NEW selection, one keystroke.
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    await type(app, input()!, 'a');
    inNew('Save comment').click(); await settle(app);
    inNew('Cancel').click(); await settle(app);
    assert.equal(input(), null, 'Cancel is still allowed while the save is pending');
    await selectCode(app, 0, 0, 2); // "fn"
    button(app, 'Comment').click(); await settle(app);
    await type(app, input()!, 'b');
    heldAdd.resolve(ann('n1', located()));
    await settle(app);
    holdAdd = false;
    assert.equal(input()?.value, 'b', 'N2 is not the draft N1 submitted: kept');
    assert.equal(inNew('Save comment').disabled, false);
    inNew('Save comment').click(); await settle(app);
    const adds = calls.filter((c) => c.method === 'reviewAdd').map((c) => plain(c.args));
    assert.deepEqual(adds.map((a) => a[2]), ['a', 'b']);
    assert.deepEqual(adds[1][1], { line: 1, col: 1, end_line: 1, end_col: 3 }, 'and its own selection');

    // EDIT: the same on an existing card.
    if (button(app, /Comments \(\d\)/u).getAttribute('aria-expanded') !== 'true') { button(app, /Comments \(\d\)/u).click(); await settle(app); }
    const card = () => app.document.querySelector<HTMLElement>('[data-review-id="e"]')!;
    const editIt = async () => {
      card().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); await settle(app);
      [...app.document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((b) => b.textContent?.includes('Edit'))!.click(); await settle(app);
    };
    const inCard = (label: string) => [...card().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))!;
    await editIt();
    await type(app, card().querySelector<HTMLTextAreaElement>('textarea')!, 'x');
    inCard('Save comment').click(); await settle(app);
    inCard('Cancel').click(); await settle(app);
    await editIt();
    await type(app, card().querySelector<HTMLTextAreaElement>('textarea')!, 'y');
    heldEdit.resolve(ann('e', located()));
    await settle(app);
    holdEdit = false;
    assert.equal(card().querySelector<HTMLTextAreaElement>('textarea')?.value, 'y', 'the re-opened edit survives the old save');
    inCard('Save comment').click(); await settle(app);
    assert.deepEqual(plain(calls.filter((c) => c.method === 'reviewUpdate').map((c) => c.args[2])), [{ note: 'x' }, { note: 'y' }]);
  } finally { await app.close(); }
});

test('the editor being typed in is scrolled into view when a re-place moves it, and never by a mere scroll (#434 validator observation)', async (context) => {
  const layout = { scroll: 0 };
  let revision = 'r1';
  const { modules } = rpc({ annotations: () => [] });
  modules.fsRead = (async () => ({ content: CODE, revision })) as never;
  const scrolled: string[] = [];
  const app = await mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules],
    setup(win) { fakeHighlights(win); fakeLayout(win, layout); win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.className); }; },
  });
  try {
    await settle(app);
    await open(app);
    await selectCode(app, 1, 8, 14);
    button(app, 'Comment').click(); await settle(app);
    const editor = app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!;
    editor.focus(); await settle(app);
    const card = app.document.querySelector<HTMLElement>('.rv-new')!;
    assert.equal(card.style.top, '160px', 'at its selection');
    scrolled.length = 0;
    // A scroll of the preview moves no card: no pull.
    const sc = app.document.querySelector<HTMLElement>('.code-lined')!;
    sc.dispatchEvent(new app.window.Event('scroll')); await settle(app);
    assert.equal(scrolled.length, 0, `no pull: ${scrolled}`);
    // The file changes and is re-read: the selection is no longer on screen,
    // the editor moves to the lane top, and is brought into view.
    revision = 'r2';
    button(app, 'Refresh').click(); await settle(app);
    assert.equal(card.style.top, '0px');
    assert.ok(scrolled.some((c) => c.includes('rv-new')), `the moved editor was scrolled into view: ${scrolled}`);
    assert.equal(app.document.activeElement, editor, 'still focused');
  } finally { await app.close(); }
});
