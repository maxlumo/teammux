// Every bound page speaks to ITS scope's server (board #335 ②b-3), area by
// area: terminal/sessions, files, hub.
//
// Every other mount test binds the scope to the mocked facade, so a page that
// still called `core/ws.ts` directly would pass them all: in Single mode the
// facade IS the scope's transport. Here the two are different objects. The
// scope's transport answers; the facade records whatever reaches it and
// refuses. A page that is bound sends nothing of its own to the facade —
// which is also what b3-4 relies on when it deletes the facade's RPCs, since
// after that a missing binding is a runtime failure the compiler cannot see.
//
// Terminal itself needs xterm, which this tier does not paint; it is bound in
// the same commit (its init read is pinned by server-context.source.test.ts
// and rendered inside a scope by Drawer.render.ts), and ScratchPanel's stub
// stands in for it here.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DOMWindow } from 'jsdom';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./ScopeBound.test.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
  new URL('../terminal/Terminal.svelte', import.meta.url),
]);
const terminalStub = {
  default: (anchor: Comment, props: { target: string }) => {
    const el = anchor.ownerDocument.createElement('div');
    el.className = 'xterm-wrap';
    el.dataset.target = props.target;
    anchor.before(el);
  },
};
const pane = (session: string, window: number) => ({ session, window, pane: 0, window_name: `w${window}`,
  current_command: 'zsh', current_path: '/b', width: 80, height: 24, active: false, pane_title: '' });

/** The scope's server: answers, and records what it was asked. */
function scopeServer(win: DOMWindow, calls: string[]) {
  const answer = (name: string, value: unknown) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    return Promise.resolve(value === undefined ? undefined : win.JSON.parse(JSON.stringify(value)));
  };
  let windows = 1;
  return {
    listSessionsWithPanes: (...a: unknown[]) => answer('listSessionsWithPanes', {
      sessions: [{ name: 'on-b', windows }], panes: Array.from({ length: windows }, (_, i) => pane('on-b', i)),
    })(...a),
    listPanes: answer('listPanes', [pane('on-b', 0)]),
    newWindow: (...a: unknown[]) => { windows++; return answer('newWindow', {})(...a); },
    killSession: answer('killSession', {}),
    killWindow: answer('killWindow', {}),
    scratchSession: answer('scratchSession', { session: 'tmm-scratch', target: 'tmm-scratch:1.1' }),
    scratchKill: answer('scratchKill', { killed: true }),
    scratchRelease: answer('scratchRelease', { released: true }),
    gitCmd: (...a: unknown[]) => answer('gitCmd', { code: 0, stdout: a[0] === 'rev-parse' ? '/b/repo\n' : '', stderr: '' })(a[0]),
    fsList: answer('fsList', { path: '/b', entries: [{ name: 'src', type: 'dir', path: '/b/src' }, { name: 'a.md', type: 'file', path: '/b/a.md', size: 3 }] }),
    fsMkdir: answer('fsMkdir', {}),
    fsCwd: answer('fsCwd', { path: '/b' }),
    fsStat: answer('fsStat', { path: '/b/a.md', is_text: true, writable: true, readable: true, size: 3, mime_hint: 'text/markdown' }),
    fsRead: answer('fsRead', { content: '# B' }),
    fsWrite: answer('fsWrite', {}),
    fsDelete: answer('fsDelete', {}),
    getBookmarks: answer('getBookmarks', { bookmarks: [] }), saveBookmarks: answer('saveBookmarks', {}),
    getPrefs: answer('getPrefs', {}), setPref: answer('setPref', {}),
    getMachineId: () => 'm-b',
    // A project of its own, on a session that is NOT the plain one Sessions
    // lists (a tracked session moves under its project).
    projectList: answer('projectList', { projects: [{ project: { id: 'proj-b', name: 'Proj B', session: 'proj-b', path: '/b' }, live: true, slots: [] }] }),
    hubRooms: answer('hubRooms', { rooms: {}, states: {} }),
    hubUnread: answer('hubUnread', { rooms: {} }),
    hubRead: answer('hubRead', { rooms: {} }),
    hubAgents: answer('hubAgents', { agents: [] }),
    hubLog: answer('hubLog', { messages: [], has_more: false }),
    hubActivity: answer('hubActivity', { events: [], has_more: false }),
    registryList: answer('registryList', { agents: [] }),
    skillsList: answer('skillsList', { skills: [] }),
    mcpList: answer('mcpList', { mcp: [] }),
    globalPromptGet: answer('globalPromptGet', { text: '', path: '/b/AGENTS.md', max_bytes: 1 }),
    teamsList: answer('teamsList', { teams: [] }),
    boardCounts: answer('boardCounts', { counts: { 'proj-b': { todo: 1, doing: 0, review: 0, done: 0, total: 1 } } }),
    boardList: answer('boardList', { issues: [{ id: 7, title: 'on B', body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] }] }),
    fsDownloadHttp: answer('fsDownloadHttp', { url: 'https://b.example/dl/x.png', name: 'x.png' }),
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
    projectRename: answer('projectRename', { session: 'proj-b2' }),
    hubLogAround: answer('hubLogAround', { messages: [], has_more_before: false, has_more_after: false }),
    subscribe: () => {}, unsubscribe: () => {}, capturePane: answer('capturePane', { output: '' }),
    addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
    addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
  };
}

/** The facade: every call is recorded and refused. Nothing a bound page
 * makes may land here. */
function facade(calls: string[]) {
  const names = ['listSessions', 'listPanes', 'listSessionsWithPanes', 'killSession', 'newWindow', 'killWindow',
    'scratchSession', 'scratchKill', 'scratchRelease', 'subscribe', 'unsubscribe', 'capturePane',
    'addPaneOutputListener', 'removePaneOutputListener', 'addPaneClosedListener', 'removePaneClosedListener',
    'gitCmd', 'fsList', 'fsMkdir', 'fsCwd', 'fsStat', 'fsRead', 'fsWrite', 'fsDelete', 'getBookmarks', 'saveBookmarks',
    'getPrefs', 'setPref', 'getMachineId', 'projectList', 'hubRooms', 'hubUnread', 'hubRead', 'hubAgents', 'hubLog',
    'hubActivity', 'registryList', 'teamsList', 'skillsList', 'mcpList', 'globalPromptGet', 'boardCounts', 'boardList', 'fsDownloadHttp',
    'addTeamMessageListener', 'removeTeamMessageListener', 'projectRename', 'hubLogAround'];
  return Object.fromEntries(names.map((n) => [n, () => { calls.push(n); return Promise.reject(new Error('facade')); }]));
}

async function mount(context: TestContext, props: Record<string, unknown>) {
  const onScope: string[] = [];
  const onFacade: string[] = [];
  const app = await (await compiled).mount(context, {
    props,
    modules: [facade(onFacade), terminalStub as unknown as Record<string, (...a: any[]) => unknown>],
    setup(win) {
      win.localStorage.setItem('tmux_locale', 'en');
      win.Element.prototype.getAnimations = () => [];
      (win as unknown as { __scopeTransport: unknown }).__scopeTransport = scopeServer(win, onScope);
    },
  });
  const until = async (ok: () => boolean) => { for (let i = 0; i < 30 && !ok(); i++) await app.flush(); };
  return { app, onScope, onFacade, until };
}

test('Sessions lists, opens and kills on its scope s server, never the facade s', async (context) => {
  const opened: string[] = [];
  const { app, onScope, onFacade, until } = await mount(context, {
    which: 'sessions', openTerminal: (session: string, target: string) => opened.push(`${session} ${target}`),
  });
  await until(() => !!app.document.querySelector('.session-row'));
  assert.ok(onScope.includes('listSessionsWithPanes()'), `listed on the scope: ${onScope.join(' ')}`);
  app.document.querySelector<HTMLButtonElement>('.kill')!.click();
  await app.flush();
  app.document.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
  await app.flush();
  app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
  await until(() => onScope.some((c) => c.startsWith('killSession')));
  assert.ok(onScope.includes('killSession("on-b")'), `killed on the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'nothing reached the facade, its Projects child included');
});

test('PanePicker lists and adds a window on its scope s server', async (context) => {
  const picked: string[] = [];
  const { app, onScope, onFacade, until } = await mount(context, {
    which: 'picker', onPick: (p: { session: string; window: number }) => picked.push(`${p.session}:${p.window}`),
  });
  await until(() => !!app.document.querySelector('.picker-add'));
  assert.deepEqual(onScope, ['listSessionsWithPanes()']);
  app.document.querySelector<HTMLButtonElement>('.picker-add')!.click();
  await until(() => picked.length > 0);
  assert.deepEqual(onScope, ['listSessionsWithPanes()', 'newWindow("on-b")', 'listSessionsWithPanes()']);
  assert.deepEqual(picked, ['on-b:1'], 'and picks the window the scope s server made');
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('ScratchPanel ensures and kills its session on its scope s server', { timeout: 60000 }, async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'scratch' });
  await until(() => !!app.document.querySelector('.scratch .xterm-wrap'));
  assert.deepEqual(onScope, ['scratchSession()']);
  assert.equal(app.document.querySelector<HTMLElement>('.scratch .xterm-wrap')!.dataset.target, 'tmm-scratch:1.1');
  app.document.querySelector<HTMLButtonElement>('.scratch-head [aria-label="Kill scratch session"]')!.click();
  await until(() => !!app.document.querySelector('[role="alertdialog"]'));
  [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.includes('Kill scratch session') && !b.closest('.scratch-head'))!.click();
  await until(() => onScope.includes('scratchKill()'));
  assert.deepEqual(onScope, ['scratchSession()', 'scratchKill()']);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('GitPanel runs git on its scope s server', async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'git', cwd: '/b/repo', onOpenFile() {}, onClose() {} });
  await until(() => onScope.filter((c) => c.startsWith('gitCmd')).length >= 3);
  assert.ok(onScope.includes('gitCmd("rev-parse")'), `git asked the scope: ${onScope.join(' ')}`);
  for (let i = 0; i < 4; i++) await app.flush();
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('DirPicker browses and makes a folder on its scope s server', async (context) => {
  const { onScope, onFacade, until } = await mount(context, { which: 'dir', start: '/b', onpick() {}, oncancel() {} });
  await until(() => onScope.includes('fsList("/b",false)'));
  assert.deepEqual(onScope, ['fsList("/b",false)']);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('Files lists, reads and deletes on its scope s server', async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'files', session: 'on-b' });
  await until(() => onScope.some((c) => c.startsWith('fsList')));
  assert.ok(onScope.includes('fsCwd("on-b")'), `the cwd came from the scope: ${onScope.join(' ')}`);
  assert.ok(onScope.some((c) => c.startsWith('fsList("/b"')), 'and the listing');
  await until(() => !!app.document.querySelector('button[aria-label="Delete: a.md"]'));
  app.document.querySelector<HTMLButtonElement>('button[aria-label="Delete: a.md"]')!.click(); await app.flush();
  app.document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.click();
  await until(() => onScope.includes('fsDelete("/b/a.md")'));
  assert.ok(onScope.includes('fsDelete("/b/a.md")'), 'the delete went to the scope');
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('Hub lists its projects and rooms on its scope s server', { timeout: 60000 }, async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'hub' });
  await until(() => onScope.includes('projectList()') && onScope.some((c) => c.startsWith('hubRooms')));
  for (let i = 0; i < 4; i++) await app.flush();
  assert.ok(onScope.some((c) => c.startsWith('projectList(')), `projects from the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('Board lists its issues on its scope s server', async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'board', session: 'proj-b' });
  await until(() => !!app.document.querySelector('.card'));
  assert.ok(onScope.some((c) => c.startsWith('boardList("proj-b"')), `issues from the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('ChatImage signs its reference on its scope s server', async (context) => {
  // jsdom has no IntersectionObserver, and ChatImage treats that as "near"
  // and signs at once, so the signature itself is observable here (reviewer
  // P2 on the binding range: a zero-facade assertion alone proved nothing).
  const { app, onScope, onFacade, until } = await mount(context, { which: 'image', src: '/b/x.png', alt: 'x' });
  await until(() => onScope.includes('fsDownloadHttp("/b/x.png")') && !!app.document.querySelector('img[src^="https://b.example"]'));
  assert.ok(onScope.includes('fsDownloadHttp("/b/x.png")'), `signed by the scope: ${onScope.join(' ')}`);
  assert.ok(app.document.querySelector('img[src="https://b.example/dl/x.png"]'), 'and the image shows the scope s URL');
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('Projects lists on its scope s server', async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'projects', visible: true, openTerminal() {} });
  await until(() => !!app.document.querySelector('.proj'));
  assert.ok(onScope.includes('projectList()'), `projects from the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('CreateProjectDialog reads the registry and browses on its scope s server', async (context) => {
  const { onScope, onFacade, until } = await mount(context, { which: 'create', oncreated() {}, oncancel() {} });
  await until(() => onScope.includes('registryList()'));
  assert.ok(onScope.includes('registryList()'), `the registry from the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('AgentsPage reads its registry on its scope s server', async (context) => {
  const { onScope, onFacade, until } = await mount(context, { which: 'agents', section: 'agents' });
  await until(() => onScope.includes('registryList()'));
  assert.ok(onScope.includes('registryList()'), `the registry from the scope: ${onScope.join(' ')}`);
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('a Hub rename names ITS scope s server, not whichever one is current (reviewer P1 on the binding range)', { timeout: 60000 }, async (context) => {
  const { app, onScope, onFacade, until } = await mount(context, { which: 'hub' });
  // Another server is CURRENT: the Hub must not take its id from there.
  app.window.localStorage.setItem('tmux_server_current', 'somewhere-else');
  const renamed: unknown[] = [];
  app.window.addEventListener('project-renamed', (e) => renamed.push((e as CustomEvent).detail));
  await until(() => !!app.document.querySelector('.proj-row'));
  app.document.querySelector('.proj-row')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
  await app.flush();
  const items = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button, [role=menuitem]')];
  const rename = items.find((b) => b.textContent?.trim() === 'Project name');
  assert.ok(rename, `the row menu offers Rename: ${items.map((b) => b.textContent?.trim()).join(' | ')}`);
  rename.click();
  // The editor opens on the next task (timers are mocked).
  await app.advance(1);
  await until(() => !!app.document.querySelector<HTMLInputElement>('input.h1-edit'));
  const input = app.document.querySelector<HTMLInputElement>('input.h1-edit')!;
  input.value = 'Proj B2';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => renamed.length > 0);
  assert.ok(onScope.some((c) => c.startsWith('projectRename(')), `renamed on the scope: ${onScope.join(' ')}`);
  assert.deepEqual(JSON.parse(JSON.stringify(renamed)), [{ serverId: 'b', from: 'proj-b', to: 'proj-b2' }], 'the event names the Hub s own server');
  assert.deepEqual(onFacade, [], 'the facade was never asked');
});

test('a Hub jumps to an alert of ITS scope s server while another one is current (reviewer P1 on the binding range)', { timeout: 60000 }, async (context) => {
  const { app, onScope, until } = await mount(context, { which: 'hub' });
  app.window.localStorage.setItem('tmux_server_current', 'somewhere-else');
  await until(() => !!app.document.querySelector('.proj-row'));
  const centre = (app.window as unknown as { __scopeState: { centre: {
    record(a: unknown): void; requestJump(a: unknown): void; items: { key: string; failed?: string }[];
  } } }).__scopeState.centre;
  const alert = { key: 'proj-b|1', server: 'b', room: 'proj-b', session: 'proj-b', project: 'Proj B', seq: 1, id: '1', ts: 1,
    from: 'alice', toHuman: true, kind: 'message', excerpt: 'hi', viewed: false };
  centre.record(alert);
  centre.requestJump(alert);
  await until(() => onScope.some((c) => c.startsWith('hubLogAround(')));
  const row = centre.items.find((a) => a.key === 'proj-b|1');
  assert.notEqual(row?.failed, 'On another server', 'the alert is this Hub s, whatever CURRENT says');
  assert.ok(onScope.some((c) => c.startsWith('hubLogAround(')), 'and the jump went on to open it, on the scope');
  await app.close();
});
