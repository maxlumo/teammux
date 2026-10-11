// Every bound page speaks to ITS scope's server (board #335 ②b-3), area by
// area: terminal/sessions, files.
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
    subscribe: () => {}, unsubscribe: () => {}, capturePane: answer('capturePane', { output: '' }),
    addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
    addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
  };
}

/** The facade: every call is recorded and refused. Projects (a child of
 * Sessions, bound in b3-3 with the hub area) still lists through it, so its
 * two calls are the only ones allowed to land here for now. */
function facade(calls: string[]) {
  const names = ['listSessions', 'listPanes', 'listSessionsWithPanes', 'killSession', 'newWindow', 'killWindow',
    'scratchSession', 'scratchKill', 'scratchRelease', 'subscribe', 'unsubscribe', 'capturePane',
    'addPaneOutputListener', 'removePaneOutputListener', 'addPaneClosedListener', 'removePaneClosedListener',
    'gitCmd', 'fsList', 'fsMkdir', 'fsCwd', 'fsStat', 'fsRead', 'fsWrite', 'fsDelete', 'getBookmarks', 'saveBookmarks',
    'getPrefs', 'setPref', 'getMachineId', 'projectList', 'hubRooms'];
  return Object.fromEntries(names.map((n) => [n, () => { calls.push(n); return Promise.reject(new Error('facade')); }]));
}
const LATER = new Set(['projectList', 'hubRooms']);

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
const own = (calls: string[]) => calls.filter((c) => !LATER.has(c));

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
  assert.deepEqual(own(onFacade), [], 'nothing of Sessions own reached the facade');
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
