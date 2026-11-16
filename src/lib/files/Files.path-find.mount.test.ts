// Board #144 through the real Files wiring: a chat reference that Files does not find where it
// resolves is searched where it ends (fs_find_tail); one opens, several ask, none says so; an
// existing path asks nothing more; a newer request drops an old answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Files.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function settle(app: App) { for (let i = 0; i < 10; i++) await app.flush(); }

const FOUND = new Set(['/fixture/worktree/b/temp/111/out.md', '/fixture/worktree/c/temp/111/out.md', '/fixture/README.md']);
function rpc(answer: () => Promise<{ root: string; matches: string[]; more: boolean; stopped?: string }>, asked: string[][], caps = ['path_find']) {
  return {
    getCaps: () => caps, onCaps: () => () => {},
    fsCwd: async () => ({ path: '/fixture' }),
    fsList: async (path: string) => ({ path, entries: [] }),
    fsStat: async (path: string) => {
      if (!FOUND.has(path)) throw new Error(`No such file or directory (os error 2): ${path}`);
      return { path, is_text: true, writable: true, readable: true, size: 10, mime_hint: 'text/markdown' };
    },
    fsRead: async (path: string) => ({ content: `# ${path}` }),
    fsFindTail: async (session: string, ref: string) => { asked.push([session, ref]); return answer(); },
    projectList: async () => ({ projects: [] }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
    saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 0, stdout: '.git' }),
  };
}
const req = (file: string, n: number) => ({ file, find: { session: 'fixture', ref: file.slice('/fixture/'.length) }, n });
const name = (app: App) => app.document.querySelector('.preview-name')?.textContent ?? '';
const err = (app: App) => app.document.querySelector('.error')?.textContent ?? '';

test('a path that exists opens as today and asks nothing more', async (context) => {
  const asked: string[][] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [rpc(async () => ({ root: '/fixture', matches: [], more: false }), asked)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: req('/fixture/README.md', 1) }); await settle(app);
    assert.match(name(app), /README\.md/u);
    assert.deepEqual(asked, [], 'no search for a path that exists');
  } finally { await app.close(); }
});

test('one match opens it; while searching no not-found shows', async (context) => {
  const asked: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null },
    modules: [rpc(async () => { await gate; return { root: '/fixture', matches: ['worktree/b/temp/111/out.md'], more: false }; }, asked)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: req('/fixture/temp/111/out.md', 1) }); await settle(app);
    assert.deepEqual(asked, [['fixture', 'temp/111/out.md']], 'the original reference and its session');
    assert.equal(err(app), '', 'no not-found flash while the search runs');
    release(); await settle(app);
    assert.match(name(app), /out\.md/u);
    assert.equal(err(app), '');
    assert.match(app.document.body.textContent ?? '', /Found and opened: worktree\/b\/temp\/111\/out\.md/u, 'the person sees which file it was');
  } finally { await app.close(); }
});

test('several ask: a pick opens that one; none says not-found, with "stopped early" when it was', async (context) => {
  const asked: string[][] = [];
  let answer = { root: '/fixture', matches: ['worktree/b/temp/111/out.md', 'worktree/c/temp/111/out.md'], more: false } as { root: string; matches: string[]; more: boolean; stopped?: string };
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [rpc(async () => answer, asked)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: req('/fixture/temp/111/out.md', 1) }); await settle(app);
    const rows = [...app.document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .choices button')];
    assert.deepEqual(rows.map((b) => b.textContent?.trim()), ['worktree/b/temp/111/out.md', 'worktree/c/temp/111/out.md']);
    rows[1]!.click(); await settle(app);
    assert.equal(app.document.querySelector('[role="dialog"] .choices'), null, 'the chooser closed');
    answer = { root: '/fixture', matches: [], more: false, stopped: 'time' };
    await app.setProps({ navRequest: req('/fixture/temp/111/gone.md', 2) }); await settle(app);
    assert.match(err(app), /stopped early/u);
  } finally { await app.close(); }
});

test('a newer request drops the old answer', async (context) => {
  const asked: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null },
    modules: [rpc(async () => { if (first) { first = false; await gate; return { root: '/fixture', matches: ['worktree/b/temp/111/out.md'], more: false }; } return { root: '/fixture', matches: [], more: false }; }, asked)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: req('/fixture/temp/111/out.md', 1) }); await settle(app);
    await app.setProps({ navRequest: req('/fixture/README.md', 2) }); await settle(app);
    release(); await settle(app);
    assert.match(name(app), /README\.md/u, 'the old answer did not replace the newer file');
  } finally { await app.close(); }
});

test('an older server without the capability shows today\'s not-found and asks nothing', async (context) => {
  const asked: string[][] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [rpc(async () => ({ root: '/fixture', matches: ['x'], more: false }), asked, ['asks'])] });
  try {
    await settle(app);
    await app.setProps({ navRequest: req('/fixture/temp/111/out.md', 1) }); await settle(app);
    assert.deepEqual(asked, []);
    assert.match(err(app), /temp\/111\/out\.md/u);
  } finally { await app.close(); }
});

// Validator-2, #144 note 14 (ruled, note 15): the pending find and the chooser belong to the
// reference that raised them and are retired with it (an unmount, a session or server change,
// a newer reference). Its owner cases, as the regressions.
const missingReq = (n: number) => ({ file: '/fixture/missing.md', find: { session: 'fixture', ref: 'missing.md' }, n });
function owned(answer: () => Promise<{ root: string; matches: string[]; more: boolean; stopped?: string }>, stats: string[], missGate?: Promise<void>, finds: string[] = []) {
  const r = rpc(answer, []);
  const stat = r.fsStat;
  return { ...r, fsFindTail: async (...a: Parameters<typeof answer>) => { finds.push('find'); return answer(...a); }, fsStat: async (path: string) => { stats.push(path); if (missGate && path === '/fixture/missing.md') await missGate; if (path === '/fixture/old/out.md') return { path, is_text: true, writable: true, readable: true, size: 10, mime_hint: 'text/markdown' }; return stat(path); } };
}

test('a find answering after Files was unmounted opens nothing and asks nothing (F2)', async (context) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const stats: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => { await gate; return { root: '/fixture', matches: ['old/out.md'], more: false }; }, stats)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    assert.deepEqual(stats, ['/fixture/missing.md']);
    await app.unmount(); release(); await settle(app);
    assert.deepEqual(stats, ['/fixture/missing.md'], 'no stat of the old match after the owner is gone');
  } finally { release(); await app.close(); }
});

test('a chooser closes when a newer reference opens (F3)', async (context) => {
  const stats: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['worktree/b/temp/111/out.md', 'worktree/c/temp/111/out.md'], more: false }), stats)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    assert.ok(app.document.querySelector('[role="dialog"] .choices'));
    await app.setProps({ navRequest: { file: '/fixture/README.md', n: 2 } }); await settle(app);
    assert.match(name(app), /README\.md/u);
    assert.equal(app.document.querySelector('[role="dialog"] .choices'), null, 'the newer reference retired the stale chooser');
  } finally { await app.close(); }
});

// Leader's ruling (note 16): a search that STOPPED EARLY never counts as exactly one: one match
// or more open the chooser with a line saying it stopped early; none says not-found so.
test('a search that stopped early opens the chooser even for one match, and says so', async (context) => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['worktree/b/temp/111/out.md'], more: false, stopped: 'time' }), [])] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    const rows = [...app.document.querySelectorAll('[role="dialog"] .choices button')].map((b) => b.textContent?.trim());
    assert.deepEqual(rows, ['worktree/b/temp/111/out.md'], 'one match, but the search did not finish: the person picks');
    assert.match(app.document.querySelector('[role="dialog"]')?.textContent ?? '', /stopped early/u);
  } finally { await app.close(); }
});

test('a find answering after this server\'s scope went to the background opens nothing (F2, validator-2)', async (context) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const stats: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => { await gate; return { root: '/fixture', matches: ['old/out.md'], more: false }; }, stats)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    await app.setScope({ eligible: false }); release(); await settle(app);
    assert.deepEqual(stats, ['/fixture/missing.md'], 'a background server consumes no old answer');
  } finally { release(); await app.close(); }
});

// Leader's ruling (#144 note 24): ONE permanent retirement. A table walks every door Files has
// while a find is pending and while its chooser is open; through each, the late answer opens
// and asks nothing, and the chooser closes and stays closed.
type Door = [string, (app: App) => Promise<void>];
const DOORS: Door[] = [
  ['unmount', async (app) => { await app.unmount(); }],
  ['a session change', async (app) => { await app.setProps({ session: 'other', navRequest: null }); }],
  ['the scope going to the background', async (app) => { await app.setScope({ eligible: false }); }],
  ['the scope away and back', async (app) => { await app.setScope({ eligible: false }); await settle(app); await app.setScope({ eligible: true }); }],
  ['a newer file request', async (app) => { await app.setProps({ navRequest: { file: '/fixture/README.md', n: 9 } }); }],
  ['a directory navigation request', async (app) => { await app.setProps({ navRequest: { path: '/fixture/other', n: 9 } }); }],
];

for (const [door, go] of DOORS) {
  test(`through ${door}, a pending find's late answer opens and asks nothing`, async (context) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const stats: string[] = [];
    const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => { await gate; return { root: '/fixture', matches: ['old/out.md'], more: false }; }, stats)] });
    try {
      await settle(app);
      await app.setProps({ navRequest: missingReq(1) }); await settle(app);
      await go(app); await settle(app);
      const before = stats.length;
      release(); await settle(app);
      assert.ok(!stats.slice(before).includes('/fixture/old/out.md'), `${door}: nothing stats or opens the old match`);
      assert.equal(stats.includes('/fixture/old/out.md'), false);
    } finally { release(); await app.close(); }
  });
  // Validator-2, note 29: the door taken BEFORE the first await (Files' own stat still pending);
  // its late not-found must not even start a search.
  test(`through ${door} while Files' own stat is pending, the late miss searches and opens nothing`, async (context) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const stats: string[] = [], finds: string[] = [];
    const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['old/out.md'], more: false }), stats, gate, finds)] });
    try {
      await settle(app);
      await app.setProps({ navRequest: missingReq(1) }); await settle(app);
      assert.equal(stats[0], '/fixture/missing.md');
      await go(app); await settle(app);
      release(); await settle(app);
      assert.deepEqual([finds, stats.includes('/fixture/old/out.md')], [[], false], `${door}: no search, no open`);
    } finally { release(); await app.close(); }
  });
  if (door === 'unmount') continue;
  test(`through ${door}, an open chooser closes`, async (context) => {
    const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['worktree/b/temp/111/out.md', 'worktree/c/temp/111/out.md'], more: false }), [])] });
    try {
      await settle(app);
      await app.setProps({ navRequest: missingReq(1) }); await settle(app);
      assert.ok(app.document.querySelector('[role="dialog"] .choices'));
      await go(app); await settle(app);
      assert.equal(app.document.querySelector('[role="dialog"] .choices'), null, `${door} closed the chooser`);
    } finally { await app.close(); }
  });
}

// A reference that comes WITH the mount (the Hub opening Files on a path) holds its token: the
// owner effect's first run is no change and retires nothing (found by the Hub mount test on the
// rebase onto #111).
test('a reference that arrives with the mount is searched and opened', async (context) => {
  const stats: string[] = [], finds: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: missingReq(1) }, modules: [owned(async () => ({ root: '/fixture', matches: ['old/out.md'], more: false }), stats, undefined, finds)] });
  try {
    await settle(app);
    assert.deepEqual([finds.length, stats], [1, ['/fixture/missing.md', '/fixture/old/out.md']]);
  } finally { await app.close(); }
});

// Leader's ruling (#144 note 40): a folder that could not be read makes the answer incomplete,
// like the other early stops: any matches → the chooser with its own line, never an auto-open;
// none → the not-found line that says some folders could not be read.
test('an answer with an unreadable folder opens the chooser for one match, and says so', async (context) => {
  const stats: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['b/missing.md'], more: false, stopped: 'unreadable' }), stats)] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    assert.deepEqual(stats, ['/fixture/missing.md'], 'nothing auto-opened');
    const dialog = app.document.querySelector('[role="dialog"]');
    assert.ok(dialog?.querySelector('.choices'));
    assert.match(dialog?.textContent ?? '', /could not be read/u);
    assert.doesNotMatch(dialog?.textContent ?? '', /stopped early/u);
  } finally { await app.close(); }
});

test('an answer with an unreadable folder and no match says so in the not-found line', async (context) => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: [], more: false, stopped: 'unreadable' }), [])] });
  try {
    await settle(app);
    await app.setProps({ navRequest: missingReq(1) }); await settle(app);
    assert.match(app.document.body.textContent ?? '', /could not be read/u);
  } finally { await app.close(); }
});

// Validator-2, note 44: a reference that arrives in the SAME frame as a project switch (the Hub
// search's other-project result) belongs to the new project; the owner change retires only
// what was raised under the old one.
test('a reference arriving together with a project switch is searched in the new project', async (context) => {
  const stats: string[] = [], finds: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', navRequest: null }, modules: [owned(async () => ({ root: '/fixture', matches: ['old/out.md'], more: false }), stats, undefined, finds)] });
  try {
    await settle(app);
    await app.setProps({ session: 'other', navRequest: { file: '/fixture/missing.md', find: { session: 'other', ref: 'missing.md' }, n: 1 } }); await settle(app);
    assert.deepEqual([finds.length, stats], [1, ['/fixture/missing.md', '/fixture/old/out.md']]);
  } finally { await app.close(); }
});
