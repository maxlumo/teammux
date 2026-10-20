import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Files.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
const entries = [
  { name: 'AGENTS.md', path: '/fixture/AGENTS.md', type: 'file', size: 1200 },
  { name: 'next.md', path: '/fixture/next.md', type: 'file', size: 100 },
];
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    fsCwd: async () => ({ path: '/fixture' }),
    fsList: async () => ({ path: '/fixture', entries }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' }),
    fsRead: async (path: string) => ({ content: path.endsWith('AGENTS.md') ? '# Rules\n\n[Next](next.md)' : '# Next' }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
    saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 0, stdout: '.git' }),
    ...extra,
  };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function settle(app: App) { for (let i = 0; i < 8; i++) await app.flush(); }
function button(app: App, label: string) {
  const element = app.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(element, label); return element;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('rejected Files delete retains its dialog/error and retries the captured target (#167)', async context => {
  const first = deferred<object>();
  const deletes: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsDelete: (path: string) => {
      deletes.push(path); return deletes.length === 1 ? first.promise : Promise.resolve({});
    } })],
  });
  try {
    await settle(app);
    button(app, 'Delete: next.md').click(); await app.flush();
    button(app, 'Delete').click(); await app.flush();
    first.reject(new Error('permission denied')); await settle(app);
    const dialog = app.document.querySelector('[role=alertdialog]');
    assert.ok(dialog, 'a rejected delete must not close its confirmation');
    assert.match(dialog.querySelector('[role=alert]')?.textContent ?? '', /permission denied/);
    assert.match(dialog.textContent ?? '', /next\.md/);
    assert.equal(button(app, 'Delete').disabled, false);
    button(app, 'Delete').click(); await settle(app);
    assert.deepEqual(deletes, ['/fixture/next.md', '/fixture/next.md']);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { first.resolve({}); await app.close(); }
});

test('Files delete is single-flight before paint and pending Cancel/Escape/backdrop/Back are consumed (#167)', async context => {
  const pending = deferred<object>();
  let calls = 0;
  let back!: () => boolean;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture', onGoBack: (fn: typeof back) => { back = fn; } },
    modules: [rpc({ fsDelete: () => { calls++; return pending.promise; } })],
  });
  try {
    await settle(app);
    button(app, 'Delete: next.md').click(); await app.flush();
    const confirm = button(app, 'Delete');
    const cancel = button(app, 'Cancel');
    confirm.click(); confirm.click();
    cancel.click();
    app.document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
    assert.equal(back(), true);
    await app.flush();
    assert.equal(calls, 1, 'executor guards before disabled reaches the DOM');
    const escape = new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    app.window.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'pending Back cannot dismiss or navigate');
    assert.equal(button(app, 'Cancel').disabled, true);
    assert.equal(app.document.querySelector('.bc-scroll')?.textContent?.includes('fixture'), true);
    pending.resolve({}); await settle(app);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { pending.resolve({}); await app.close(); }
});

test('Files mutation success closes confirmation even when listing refresh fails (#167)', async context => {
  let deleted = false;
  let calls = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({
      fsDelete: async () => { deleted = true; calls++; return {}; },
      fsList: async () => { if (deleted) throw new Error('refresh unavailable'); return { path: '/fixture', entries }; },
    })],
  });
  try {
    await settle(app);
    button(app, 'Delete: next.md').click(); await app.flush();
    button(app, 'Delete').click(); await settle(app);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'a refresh failure cannot offer another delete');
    assert.match(app.document.querySelector('.error')?.textContent ?? '', /refresh unavailable/);
    assert.equal(app.document.querySelector('[aria-label="Delete: next.md"]'), null, 'the confirmed-deleted row cannot invite a retry');
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`stale Files delete ${outcome} cannot replace a newer session/view/dialog (#167)`, async context => {
    const pending = deferred<object>();
    const deletes: string[] = [];
    const listed: string[] = [];
    let update!: (next: Record<string, unknown>) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, session: 'fixture', register: (fn: typeof update) => { update = fn; } },
      modules: [rpc({
        fsDelete: (path: string) => { deletes.push(path); return pending.promise; },
        fsList: async (path: string) => { listed.push(path); return { path, entries: path === '/fixture' ? entries : [
          { name: 'new.md', path: '/new/new.md', type: 'file', size: 100 },
        ] }; },
      })],
    });
    try {
      await settle(app);
      button(app, 'Delete: next.md').click(); await app.flush();
      button(app, 'Delete').click(); await app.flush();
      update({ session: 'new', root: '/new', navRequest: { path: '/new', n: 1 } }); await settle(app);
      assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'old confirmation belongs to its old view');
      button(app, 'Delete: new.md').click(); await app.flush();
      const before = listed.length;
      if (outcome === 'success') pending.resolve({}); else pending.reject(new Error('old failure'));
      await settle(app);
      assert.match(app.document.querySelector('[role=alertdialog]')?.textContent ?? '', /new\.md/);
      assert.doesNotMatch(app.document.body.textContent ?? '', /old failure/);
      assert.equal(listed.length, before, 'old completion cannot refresh the new listing');
      assert.deepEqual(deletes, ['/fixture/next.md']);
    } finally { pending.resolve({}); await app.close(); }
  });
}

test('every Files toolbar action has a localized accessible name (#157)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc()] });
  try {
    await settle(app);
    const buttons = [...app.document.querySelectorAll<HTMLButtonElement>('.toolbar button')];
    assert.equal(buttons.length, 10, 'Downloads is a tool in the browser too (#308)');
    assert.ok(buttons.every(b => !!b.getAttribute('aria-label')), 'no unnamed tool');
    for (const label of ['Session directory', 'Refresh', 'New item', 'Upload files', 'Show hidden files', 'Bookmark directory', 'Bookmarks', 'Recent files', 'Git', 'Downloads']) {
      button(app, label);
    }
  } finally { await app.close(); }
});

test('Files toggle/disclosure tools announce state, including empty panels (#157)', async context => {
  const hidden: boolean[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsList: async (_path: string, show: boolean) => { hidden.push(show); return { path: '/fixture', entries }; } })],
  });
  try {
    await settle(app);
    button(app, 'Show hidden files').click(); await settle(app);
    assert.equal(button(app, 'Show hidden files').getAttribute('aria-pressed'), 'true');
    assert.equal(hidden.at(-1), true);
    button(app, 'Bookmarks').click(); await app.flush();
    const bookmarks = button(app, 'Bookmarks');
    assert.equal(bookmarks.getAttribute('aria-expanded'), 'true');
    assert.match(app.document.getElementById(bookmarks.getAttribute('aria-controls')!)?.textContent ?? '', /No bookmarks/);
    button(app, 'Recent files').click(); await app.flush();
    assert.equal(bookmarks.getAttribute('aria-expanded'), 'false');
    assert.match(app.document.querySelector('.bookmarks-panel')?.textContent ?? '', /No recent files/);
  } finally { await app.close(); }
});

test('Files shared Back keeps the existing linked-preview history (#157)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc()] });
  try {
    await settle(app);
    app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle(app);
    assert.equal(app.document.querySelector('.preview-name')?.textContent, 'AGENTS.md');
    app.document.querySelector<HTMLAnchorElement>('.md-render a')!.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(app);
    assert.equal(app.document.querySelector('.preview-name')?.textContent, 'next.md');
    button(app, 'Back').click(); await settle(app);
    assert.equal(app.document.querySelector('.preview-name')?.textContent, 'AGENTS.md');
    button(app, 'Back').click(); await settle(app);
    assert.equal(app.document.querySelector('.preview-header'), null);
    assert.ok(app.document.querySelector('.file-list'));
  } finally { await app.close(); }
});

test('a failed bookmark read is not presented as an empty collection (#157)', async context => {
  let reject!: (reason: Error) => void;
  let calls = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ getBookmarks: () => ++calls === 1 ? new Promise((_, no) => reject = no) : Promise.resolve({ bookmarks: [] }) })],
  });
  try {
    await settle(app);
    button(app, 'Bookmarks').click(); await app.flush();
    assert.match(app.document.querySelector('.bookmarks-panel')?.textContent ?? '', /Loading/);
    reject(new Error('Read failed')); await settle(app);
    assert.match(app.document.querySelector('[role=alert]')?.textContent ?? '', /Read failed/);
    assert.doesNotMatch(app.document.querySelector('.bookmarks-panel')?.textContent ?? '', /No bookmarks/);
    app.document.querySelector<HTMLButtonElement>('.bookmarks-panel [aria-label="Refresh"]')!.click(); await settle(app);
    assert.match(app.document.querySelector('.bookmarks-panel')?.textContent ?? '', /No bookmarks/);
  } finally { await app.close(); }
});

test('the File/Folder choice reaches the existing create path and preserves its IME guard (#157)', async context => {
  const writes: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsMkdir: async (path: string) => { writes.push(path); return {}; } })],
  });
  try {
    await settle(app); button(app, 'New item').click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.segmented button')].find(b => b.textContent === 'Folder')!.click();
    const input = app.document.querySelector<HTMLInputElement>('.new-item input')!;
    input.value = 'fresh';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    assert.deepEqual(writes, []);
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(app);
    assert.deepEqual(writes, ['/fixture/fresh']);
    assert.equal(app.document.querySelector('.new-item'), null);
  } finally { await app.close(); }
});

test('a row action retains its row path, not the open preview path (#157)', async context => {
  const renames: string[][] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsRename: async (from: string, to: string) => { renames.push([from, to]); return {}; } })],
    setup(window) { window.localStorage.setItem('tmux_layout_mode', 'desktop'); },
  });
  try {
    await settle(app); app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle(app);
    button(app, 'Rename: next.md').click(); await app.flush();
    const input = app.document.querySelector<HTMLInputElement>('.new-item input')!;
    input.value = 'renamed.md';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    button(app, 'Rename').click(); await settle(app);
    assert.deepEqual(renames, [['/fixture/next.md', '/fixture/renamed.md']]);
  } finally { await app.close(); }
});

function contextMenu(app: App, element: Element) {
  element.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 50 }));
}
function menuAction(app: App, label: string) {
  const element = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')].find(b => b.textContent?.trim() === label);
  assert.ok(element, `context action: ${label}`); return element;
}

async function copyRow(app: App, index = 0) {
  contextMenu(app, app.document.querySelectorAll('.file-row')[index]!);
  await app.flush();
  menuAction(app, 'Copy path').click();
  await settle(app);
}
const copySuccess = (app: App) => [...app.document.querySelectorAll('.copy-toast, [role=status]')]
  .some(node => node.textContent?.trim() === 'Copied');

for (const copied of [true, false]) {
  test(`Files copy ${copied ? 'success has no actions' : 'error has a working Close'} (#167 review)`, async context => {
    const app = await (await compiled).mount(context, {
      props: { visible: true, session: 'fixture' }, modules: [rpc()],
      setup(window) {
        window.document.execCommand = () => false;
        Object.defineProperty(window.navigator, 'clipboard', { value: {
          writeText: async () => { if (!copied) throw Error('denied'); },
        } });
      },
    });
    try {
      await settle(app); await copyRow(app);
      const feedback = app.document.querySelector('.operation-feedback')!;
      assert.ok(feedback);
      assert.equal(feedback.querySelectorAll('.feedback-actions').length, copied ? 0 : 1);
      if (!copied) {
        button(app, 'Close').click(); await settle(app);
        assert.equal(app.document.querySelector('.operation-feedback'), null);
      }
    } finally { await app.close(); }
  });
}

test('Files download progress offers only its Cancel, never a dismissal; failure has Close (#167 review, #420)', async context => {
  const pending = deferred<object>();
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsDownloadHttp: () => pending.promise })],
  });
  try {
    await settle(app); button(app, 'Download: AGENTS.md').click(); await settle(app);
    const actions = [...app.document.querySelectorAll('.operation-feedback button')].map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(actions, ['Cancel: AGENTS.md'], 'hiding progress is not offered; the card\u2019s one action is the real Cancel (#420)');
    pending.reject(Error('download failed')); await settle(app);
    const feedback = app.document.querySelector('.operation-feedback');
    assert.match(feedback?.textContent ?? '', /download failed/);
    assert.equal(feedback?.querySelectorAll('button').length, 1, 'no empty Open action');
    button(app, 'Close').click(); await settle(app);
    assert.equal(app.document.querySelector('.operation-feedback'), null);
  } finally { pending.reject(Error('fixture closed')); await app.close(); }
});

test('old copy completion cannot replace a newer failed copy (#167)', async context => {
  const old = deferred<void>();
  let calls = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) {
      window.document.execCommand = () => false;
      Object.defineProperty(window.navigator, 'clipboard', { value: {
        writeText: () => ++calls === 1 ? old.promise : Promise.reject(Error('denied')),
      } });
    },
  });
  try {
    await settle(app);
    await copyRow(app);
    await copyRow(app, 1);
    old.resolve(); await settle(app);
    assert.equal(copySuccess(app), false, 'A success must not replace B failure');
    assert.match(app.document.body.textContent ?? '', /Copy failed/);
    await app.advance(10000);
    assert.match(app.document.body.textContent ?? '', /Copy failed/, 'errors persist');
  } finally { old.resolve(); await app.close(); }
});

test('copy success expires at 1500ms and its old expiry cannot clear a newer completion (#167)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) {
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
    },
  });
  try {
    await settle(app);
    await copyRow(app);
    await app.advance(1000);
    await copyRow(app, 1);
    await app.advance(500);
    assert.equal(copySuccess(app), true, 'A expiry leaves B visible');
    await app.advance(999);
    assert.equal(copySuccess(app), true, 'B retains the full completion lifetime');
    await app.advance(1);
    assert.equal(copySuccess(app), false);
  } finally { await app.close(); }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`copy ${outcome} from a hidden Files context never reappears (#167)`, async context => {
    const old = deferred<void>();
    let update!: (next: Record<string, unknown>) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, session: 'fixture', register: (fn: typeof update) => { update = fn; } },
      modules: [rpc()],
      setup(window) {
        window.document.execCommand = () => false;
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => old.promise } });
      },
    });
    try {
      await settle(app); await copyRow(app);
      update({ visible: false }); await settle(app);
      update({ visible: true }); await settle(app);
      if (outcome === 'success') old.resolve(); else old.reject(Error('denied'));
      await settle(app);
      assert.equal(copySuccess(app), false);
      assert.doesNotMatch(app.document.body.textContent ?? '', /Copy failed/);
    } finally { old.resolve(); await app.close(); }
  });
}

test('measured overflow retains the same trailing disclosure action and controlled state (#164)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) {
      // Synthetic layout outputs exercise wiring only; Chromium owns geometry.
      Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
        configurable: true, get() { return this.classList.contains('toolbar') ? 390 : 0; },
      });
      const computed = window.getComputedStyle.bind(window);
      window.getComputedStyle = element => {
        const style = computed(element);
        return element.classList.contains('toolbar') ? new Proxy(style, {
          get(target, key) {
            if (key === 'paddingLeft' || key === 'paddingRight') return '6px';
            if (key === 'columnGap') return '2px';
            if (key === 'getPropertyValue') return (name: string) => name === '--control-height' ? '44px' : target.getPropertyValue(name);
            return Reflect.get(target, key);
          },
        }) : style;
      };
    },
  });
  try {
    await settle(app);
    const more = button(app, 'More file actions');
    assert.equal(app.document.querySelector('.toolbar [aria-label="Recent files"]'), null);
    more.click(); await app.flush();
    assert.ok(app.document.getElementById(more.getAttribute('aria-controls')!));
    assert.equal(menuAction(app, 'Recent files').getAttribute('aria-checked'), 'false');
    menuAction(app, 'Recent files').click(); await app.flush();
    assert.match(app.document.querySelector('.bookmarks-panel')?.textContent ?? '', /No recent files/);
    more.click(); await app.flush();
    assert.equal(menuAction(app, 'Recent files').getAttribute('aria-checked'), 'true');
  } finally { await app.close(); }
});

test('row context actions use the clicked file even beside another preview (#164)', async context => {
  const renames: string[][] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsRename: async (from: string, to: string) => { renames.push([from, to]); return {}; } })],
    setup(window) { window.localStorage.setItem('tmux_layout_mode', 'desktop'); },
  });
  try {
    await settle(app);
    app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle(app);
    contextMenu(app, app.document.querySelectorAll('.file-row')[1]!); await app.flush();
    assert.equal(app.document.querySelector('.ctx-who')?.textContent, 'next.md');
    menuAction(app, 'Rename').click(); await app.flush();
    const input = app.document.querySelector<HTMLInputElement>('.new-item input')!;
    input.value = 'renamed.md'; input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush(); button(app, 'Rename').click(); await settle(app);
    assert.deepEqual(renames, [['/fixture/next.md', '/fixture/renamed.md']]);
  } finally { await app.close(); }
});

test('context Delete still requires confirmation and a stale menu cannot act after Back (#164)', async context => {
  const deletes: string[] = [];
  let back!: () => boolean;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture', onGoBack: (fn: () => boolean) => back = fn },
    modules: [rpc({ fsDelete: async (path: string) => { deletes.push(path); return {}; } })],
  });
  try {
    await settle(app);
    const origin = app.document.querySelectorAll<HTMLButtonElement>('.file-main')[1]!;
    origin.focus();
    contextMenu(app, app.document.querySelectorAll('.file-row')[1]!); await app.flush();
    const oldDelete = menuAction(app, 'Delete');
    assert.equal(back(), true); await app.flush();
    // Reattach the old node so Svelte's delegated handler actually executes.
    // A click on a detached node would be a false-positive stale-action test.
    app.document.querySelector('.files')!.append(oldDelete);
    oldDelete.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
    oldDelete.remove();
    contextMenu(app, app.document.querySelectorAll('.file-row')[1]!); await app.flush();
    menuAction(app, 'Delete').click(); await app.flush();
    assert.deepEqual(deletes, []);
    assert.match(app.document.querySelector('[role=alertdialog]')?.textContent ?? '', /next\.md/);
    button(app, 'Cancel').click(); await app.flush();
    assert.deepEqual(deletes, []);
    assert.equal(app.document.activeElement, origin, 'Cancel returns past the dismissed menu to the row');
  } finally { await app.close(); }
});

test('blank-directory context reuses toolbar modes and native preview selection is untouched (#164)', async context => {
  const hidden: boolean[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsList: async (_path: string, show: boolean) => { hidden.push(show); return { path: '/fixture', entries }; } })],
  });
  try {
    await settle(app);
    contextMenu(app, app.document.querySelector('.file-list')!); await app.flush();
    const toggle = menuAction(app, 'Show hidden files');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    toggle.click(); await settle(app);
    assert.equal(hidden.at(-1), true);
    assert.equal(button(app, 'Show hidden files').getAttribute('aria-pressed'), 'true');
    const rowHold = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(rowHold, 'pointerType', { value: 'touch' });
    app.document.querySelector('.file-row')!.dispatchEvent(rowHold);
    assert.equal(rowHold.defaultPrevented, true, 'the list hold is the shared app gesture, not browser chrome');
    app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle(app);
    const event = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    app.document.querySelector('.md-render')!.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(app.document.querySelector('.ctx'), null);
  } finally { await app.close(); }
});

test('Copy path cannot report success when both clipboard paths fail (#164)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) {
      window.document.execCommand = () => false;
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => { throw Error('denied'); } } });
    },
  });
  try {
    await settle(app);
    contextMenu(app, app.document.querySelector('.file-row')!); await app.flush();
    menuAction(app, 'Copy path').click(); await settle(app);
    assert.equal(copySuccess(app), false);
    assert.match(app.document.body.textContent ?? '', /Copy failed/);
  } finally { await app.close(); }
});

test('without a declared root Files follows the pane cwd; with one it starts there and never asks fs_cwd (board #181)', async context => {
  const fixture = await compiled;
  const listed: string[] = [];
  let cwdAsked = 0;
  const modules = () => [rpc({
    fsCwd: async () => { cwdAsked++; return { path: '/pane' }; },
    fsList: async (path: string) => { listed.push(path); return { path, entries: [] }; },
  })];
  // No project declaration (a direct/adopted session): the pane cwd is the fallback.
  const loose = await fixture.mount(context, { props: { visible: true, session: 'loose' }, modules: modules() });
  try {
    await settle(loose);
    assert.equal(listed[0], '/pane');
    assert.ok(cwdAsked >= 1);
  } finally { await loose.close(); }
  listed.length = 0; cwdAsked = 0;
  // A project: its declared path is the start, and fs_cwd is not consulted.
  const declared = await fixture.mount(context, { props: { visible: true, session: 'proj', root: '/declared' }, modules: modules() });
  try {
    await settle(declared);
    assert.equal(listed[0], '/declared');
    assert.equal(cwdAsked, 0, 'the declaration is the truth; the pane is not asked');
  } finally { await declared.close(); }
});

test('a video previews as a stream: one stream-signed /dl URL, no bytes through the RPC, no size gate (board #182)', async context => {
  // Owner 2026-09-12: "文件的预览里边，应该加入视频的流式播放的预览能力". A 2 GB
  // film is far over PREVIEW_SIZE_LIMIT and MAX_READ_SIZE; it must never be
  // read — the <video> element streams ranges from /dl itself.
  const signed: unknown[][] = [];
  const bytes: string[] = [];
  const videoEntries = [{ name: 'demo.mp4', path: '/fixture/demo.mp4', type: 'file', size: 2 * 1024 ** 3 }];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc({
    fsList: async () => ({ path: '/fixture', entries: videoEntries }),
    fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 2 * 1024 ** 3, mime_hint: 'video/mp4' }),
    fsDownloadHttp: async (...args: unknown[]) => { signed.push(args); return { url: 'https://h/dl?path=%2Ffixture%2Fdemo.mp4&exp=9&sig=s&stream=1', name: 'demo.mp4' }; },
    fsDownload: async (path: string) => { bytes.push(path); return { data: '' }; },
    fsRead: async (path: string) => { bytes.push(path); return { content: '' }; },
  })] });
  try {
    await settle(app);
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(app);
    const video = app.document.querySelector<HTMLVideoElement>('.preview-body video, .media-preview video');
    assert.ok(video, 'the preview is a <video>, not the info page');
    assert.equal(video.getAttribute('src'), 'https://h/dl?path=%2Ffixture%2Fdemo.mp4&exp=9&sig=s&stream=1');
    assert.equal(JSON.stringify(signed), JSON.stringify([['/fixture/demo.mp4', { stream: true }]]), 'signed once, for a stream lifetime');
    assert.deepEqual(bytes, [], 'no fs_download / fs_read for a stream');
    // The same pause-on-hide policy as the sound's (board #416 review): hidden pauses, shown never plays.
    const calls: string[] = [];
    video.pause = () => { calls.push('pause'); };
    video.play = () => { calls.push('play'); return Promise.resolve(); };
    await app.setProps({ visible: false });
    await app.setProps({ visible: true });
    assert.deepEqual(calls, ['pause']);
  } finally { await app.close(); }
});

test('a sound previews as a stream too: one stream-signed /dl URL into an <audio>, no bytes through the RPC, no size gate (board #416)', async context => {
  // Owner 2026-10-17: "文件预览除了视频播放外，还应该加上音频播放". A 300 MB track is far
  // over PREVIEW_SIZE_LIMIT and MAX_READ_SIZE; it is never read — the <audio>
  // element fetches its own ranges from /dl, exactly as the <video> does.
  const signed: unknown[][] = [];
  const bytes: string[] = [];
  const size = 300 * 1024 ** 2;
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc({
    fsList: async () => ({ path: '/fixture', entries: [{ name: 'demo.mp3', path: '/fixture/demo.mp3', type: 'file', size }] }),
    fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size, mime_hint: 'audio/mpeg' }),
    fsDownloadHttp: async (...args: unknown[]) => { signed.push(args); return { url: 'https://h/dl?path=%2Ffixture%2Fdemo.mp3&exp=9&sig=s&stream=1', name: 'demo.mp3' }; },
    fsDownload: async (path: string) => { bytes.push(path); return { data: '' }; },
    fsRead: async (path: string) => { bytes.push(path); return { content: '' }; },
  })] });
  try {
    await settle(app);
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(app);
    const audio = app.document.querySelector<HTMLAudioElement>('.preview-body audio, .media-preview audio');
    assert.ok(audio, 'the preview is an <audio>, not the info page');
    assert.equal(audio.getAttribute('src'), 'https://h/dl?path=%2Ffixture%2Fdemo.mp3&exp=9&sig=s&stream=1');
    assert.equal(audio.getAttribute('preload'), 'metadata');
    assert.equal(JSON.stringify(signed), JSON.stringify([['/fixture/demo.mp3', { stream: true }]]), 'signed once, for a stream lifetime');
    assert.deepEqual(bytes, [], 'no fs_download / fs_read for a stream');

    // Review: Files stays mounted and hidden on a tab or server switch, so hiding it pauses the
    // track; showing it again changes nothing (same element, same signed URL, no play).
    const calls: string[] = [];
    audio.pause = () => { calls.push('pause'); };
    audio.play = () => { calls.push('play'); return Promise.resolve(); };
    await app.setProps({ visible: false });
    assert.deepEqual(calls, ['pause'], 'hiding the page pauses the media');
    await app.setProps({ visible: true });
    assert.deepEqual(calls, ['pause'], 'showing it never plays');
    assert.equal(app.document.querySelector('.preview-body audio, .media-preview audio'), audio, 'the same element: the position is kept');
    assert.equal(audio.getAttribute('src'), 'https://h/dl?path=%2Ffixture%2Fdemo.mp3&exp=9&sig=s&stream=1', 'and the signed URL');
  } finally { await app.close(); }
});

test('an image preview opens the one Lightbox; Back closes it; a trackpad pinch zooms the image, not the page (board #188)', async context => {
  // Owner 2026-09-12: "预览图片的时候，要能够点击图片全屏放大，最好图片这种增加在图片上的
  // 触摸板两指放大手势，不是把整个页面放大".
  const chain: { back: (() => boolean) | null } = { back: null };
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture', onGoBack: (fn: () => boolean) => { chain.back = fn; } }, modules: [rpc({
    fsList: async () => ({ path: '/fixture', entries: [{ name: 'shot.png', path: '/fixture/shot.png', type: 'file', size: 10 }] }),
    fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 10, mime_hint: 'image/png' }),
    fsDownload: async () => ({ data: 'eA==' }),
  })] });
  try {
    await settle(app);
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(app);
    const open = app.document.querySelector<HTMLButtonElement>('.image-open')!;
    assert.ok(open, 'the picture is a button');
    assert.equal(app.document.querySelector('.lb'), null);
    open.click(); await settle(app);
    const lb = app.document.querySelector<HTMLImageElement>('.lb .lb-img');
    assert.ok(lb, 'the Lightbox opened');
    assert.equal(lb.getAttribute('src'), 'data:image/png;base64,eA==');
    assert.ok(chain.back, 'Files registered its Back chain');
    assert.equal(chain.back!(), true, 'Back closes the viewer first');
    await settle(app);
    assert.equal(app.document.querySelector('.lb'), null);
    assert.ok(app.document.querySelector('.image-open'), 'and the preview is still there');
    // A trackpad pinch arrives as ctrl+wheel: the image takes it, the page does not zoom.
    const pinch = new app.window.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    app.document.querySelector('.image-open')!.dispatchEvent(pinch);
    await settle(app);
    assert.equal(pinch.defaultPrevented, true, 'the page keeps its zoom');
    assert.ok(app.document.querySelector('.lb'), 'the viewer takes the gesture');
  } finally { await app.close(); }
});

test('Back/Forward: the browser pair heads the path row, disabled at the ends (board #187)', async context => {
  // Owner 2026-09-12: "文件夹浏览的能不能加一个类似浏览器后退前进的按钮，方便我跳转位置后快速回来".
  const listed: string[] = [];
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc({
    fsList: async (path: string) => { listed.push(path); return { path, entries: path === '/fixture'
      ? [{ name: 'docs', path: '/fixture/docs', type: 'dir', size: 0 }] : [] }; },
  })] });
  try {
    await settle(app);
    const back = () => button(app, 'Back'), fwd = () => button(app, 'Forward');
    assert.ok(back().closest('.bc-path-row') && fwd().closest('.bc-path-row'), 'the pair lives at the head of the path row, not in the tools bar (#164 overflow)');
    assert.equal(app.document.querySelectorAll('.toolbar button').length, 10, 'the tools bar is untouched (Downloads joined it in #308)');
    assert.equal(back().disabled, true, 'nothing behind at the entry point');
    assert.equal(fwd().disabled, true, 'nothing ahead');
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(app);
    assert.equal(listed.at(-1), '/fixture/docs');
    assert.equal(back().disabled, false, 'a step to retrace');
    assert.equal(fwd().disabled, true);
    back().click(); await settle(app);
    assert.equal(listed.at(-1), '/fixture', 'Back retraces the step');
    assert.equal(back().disabled, true);
    assert.equal(fwd().disabled, false, 'the place we left is ahead');
    fwd().click(); await settle(app);
    assert.equal(listed.at(-1), '/fixture/docs', 'Forward returns there');
    assert.equal(fwd().disabled, true);
    assert.equal(back().disabled, false);
  } finally { await app.close(); }
});

test('a path segment has the one context menu (Copy path) and a text selection does not navigate (board #187)', async context => {
  // Owner 2026-09-12: "这个路径最好可以复制，包括文件夹文件的名字我也可以选中复制".
  const copied: string[] = [];
  const listed: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsList: async (path: string) => { listed.push(path); return { path, entries }; } })],
    setup(window) {
      window.localStorage.setItem('tmux_layout_mode', 'desktop');
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text); } } });
    },
  });
  try {
    await settle(app);
    const segs = app.document.querySelectorAll<HTMLButtonElement>('.bc-path-row .bc-seg');
    assert.equal(segs.length, 2, 'root + fixture');
    // Right-click the "fixture" crumb: the same context-menu mechanism as a row, offering Copy path of THAT segment.
    contextMenu(app, segs[1]!); await app.flush();
    assert.equal(app.document.querySelector('.ctx-who')?.textContent, 'fixture');
    menuAction(app, 'Copy path').click(); await settle(app);
    assert.deepEqual(copied, ['/fixture']);
    assert.equal(app.document.querySelectorAll('.ctx-item, .menu-item').length, 0, 'the menu closed');
    // A tap that ends a text selection is a copy gesture, not a navigation.
    const before = listed.length;
    const name = app.document.querySelector('.file-row .file-name')!;
    const range = app.document.createRange(); range.selectNodeContents(name);
    const sel = app.window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    assert.equal(sel.isCollapsed, false);
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click(); await settle(app);
    assert.equal(app.document.querySelector('.preview-header'), null, 'no preview opened over a selection');
    segs[1]!.click(); await settle(app);
    assert.equal(listed.length, before, 'no directory navigation over a selection');
    sel.removeAllRanges();
    segs[1]!.click(); await settle(app);
    assert.equal(listed.length, before + 1, 'without a selection the crumb navigates');
  } finally { await app.close(); }
});

test('crumb and row menus copy the NAME or the full PATH (board #191)', async context => {
  const copied: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) {
      window.localStorage.setItem('tmux_layout_mode', 'desktop');
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text); } } });
    },
  });
  try {
    await settle(app);
    const crumb = app.document.querySelectorAll<HTMLButtonElement>('.bc-path-row .bc-seg')[1]!;
    contextMenu(app, crumb); await app.flush();
    menuAction(app, 'Copy name').click(); await settle(app);
    contextMenu(app, crumb); await app.flush();
    menuAction(app, 'Copy path').click(); await settle(app);
    contextMenu(app, app.document.querySelector('.file-row')!); await app.flush();
    menuAction(app, 'Copy name').click(); await settle(app);
    assert.deepEqual(copied, ['fixture', '/fixture', 'AGENTS.md']);
  } finally { await app.close(); }
});


test('an upload reports each file, counts it uploaded only when the server answers, and names failures (board #214)', async context => {
  // Owner 2026-09-20: "文件上传要有个进度或者提示，让我知道传上去了没有". Before, a
  // successful upload only refreshed the listing; the user could not tell.
  const uploads: { path: string; done: ReturnType<typeof deferred<object>> }[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsUpload: (path: string) => { const done = deferred<object>(); uploads.push({ path, done }); return done.promise; } })],
    setup(window) {
      window.localStorage.setItem('tmux_layout_mode', 'desktop');
      // A file input cannot be driven in a test; the batch is handed to the
      // picker's onchange with the files defined on it.
      const click = window.HTMLInputElement.prototype.click;
      window.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type !== 'file') return click.call(this);
        const files = [new window.File(['abc'], 'one.txt'), new window.File(['defg'], 'two.txt')];
        Object.defineProperty(this, 'files', { value: files });
        this.onchange?.(new window.Event('change'));
      };
    },
  });
  const feedback = () => app.document.querySelector('.files-feedback [role=status], .files-feedback [role=alert]')?.textContent ?? '';
  try {
    await settle(app);
    button(app, 'Upload files').click();
    // jsdom's FileReader completes over setImmediate hops (a macrotask each).
    const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20 && uploads.length < 1; i++) { await macrotask(); await app.flush(); }
    assert.equal(uploads.length, 1, 'files go one at a time');
    assert.equal(uploads[0]!.path, '/fixture/one.txt');
    assert.match(feedback(), /Uploading one\.txt \(1\/2\)/);
    assert.match(feedback(), /Sending/, 'the read is done; the send is a discrete beat');
    assert.equal(app.document.querySelector('.files-feedback progress'), null, 'no invented percentage while sending');
    uploads[0]!.done.resolve({});
    for (let i = 0; i < 20 && uploads.length < 2; i++) { await macrotask(); await app.flush(); }
    assert.match(feedback(), /Uploading two\.txt \(2\/2\)/, 'the first is counted only after the server answered');
    uploads[1]!.done.reject(new Error('disk full'));
    await settle(app);
    const alert = app.document.querySelector('.files-feedback [role=alert]');
    assert.ok(alert, 'a failure is an alert, not a silent refresh');
    assert.match(alert.textContent ?? '', /1 uploaded, 1 failed: two\.txt/, 'the failed file is named');
    assert.match(alert.textContent ?? '', /disk full/);
  } finally { for (const u of uploads) u.done.resolve({}); await app.close(); }
});

test('a clean upload batch ends in a success line that names the file (board #214)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsUpload: async () => ({ ok: true }) })],
    setup(window) {
      window.localStorage.setItem('tmux_layout_mode', 'desktop');
      window.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        Object.defineProperty(this, 'files', { value: [new window.File(['abc'], 'one.txt')] });
        this.onchange?.(new window.Event('change'));
      };
    },
  });
  try {
    await settle(app);
    button(app, 'Upload files').click();
    for (let i = 0; i < 20 && !/Uploaded one\.txt/.test(app.document.querySelector('.files-feedback')?.textContent ?? ''); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve)); await app.flush();
    }
    const status = app.document.querySelector('.files-feedback [role=status]');
    assert.match(status?.textContent ?? '', /Uploaded one\.txt/);
    assert.match(status?.textContent ?? '', /\/fixture/, 'and where it landed');
  } finally { await app.close(); }
});

test('reading mode: the header and the tab bar step away, one floating control or Back returns (board #226)', async context => {
  // Owner 2026-09-20: "在手机文件预览md等文件的时候，可以有一个放大按钮全屏显示，上下向上和
  // 向下隐藏起来，悬浮一个按钮，在回到普通模式".
  const chain: { back: (() => boolean) | null } = { back: null };
  const immersive: boolean[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture', onGoBack: (fn: () => boolean) => { chain.back = fn; }, onimmersive: (on: boolean) => { immersive.push(on); } },
    modules: [rpc()],
    setup(window) { window.localStorage.setItem('tmux_layout_mode', 'mobile'); },
  });
  try {
    await settle(app);
    assert.deepEqual(immersive, [false], 'a fresh page is not immersive');
    app.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(app);
    assert.ok(app.document.querySelector('.md-render'), 'the markdown preview is open');
    const enter = button(app, 'Reading mode');
    assert.ok(app.document.querySelector('.preview-header'), 'the header is there in normal mode');
    assert.equal(app.document.querySelector('.reading-exit'), null);
    enter.click(); await settle(app);
    const files = app.document.querySelector('.files')!;
    assert.ok(files.classList.contains('reading'), 'the page wears the reading class (Files.source pins the header hide)');
    assert.ok(app.document.querySelector('.md-render'), 'the content stays');
    const exit = button(app, 'Exit reading mode');
    assert.ok(exit.closest('.reading-exit'), 'the floating control');
    assert.equal(immersive.at(-1), true, 'the host was told to hide its chrome');
    // Back is the gesture way out: reading mode is the layer above the preview.
    assert.equal(chain.back!(), true, 'Back exits reading mode first');
    await settle(app);
    assert.ok(!files.classList.contains('reading'), 'the header is back');
    assert.equal(app.document.querySelector('.reading-exit'), null);
    assert.equal(immersive.at(-1), false, 'and the chrome returns');
    assert.ok(app.document.querySelector('.md-render'), 'still on the preview, not back in the list');
    // The floating control is the tap way out.
    button(app, 'Reading mode').click(); await settle(app);
    assert.equal(immersive.at(-1), true);
    button(app, 'Exit reading mode').click(); await settle(app);
    assert.ok(!files.classList.contains('reading'));
    assert.equal(immersive.at(-1), false);
    // Leaving the preview while reading resets it: the tab bar must be back
    // before the list shows.
    button(app, 'Reading mode').click(); await settle(app);
    button(app, 'Back').click(); await settle(app);
    assert.ok(app.document.querySelector('.file-row'), 'back in the list');
    assert.equal(immersive.at(-1), false, 'reading mode did not outlive the preview');
    assert.ok(!files.classList.contains('reading'));
  } finally { await app.close(); }
});

test('reading mode is not offered for an image (the Lightbox is its fullscreen) nor on the desktop layout (board #226)', async context => {
  const image = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc({
    fsList: async () => ({ path: '/fixture', entries: [{ name: 'shot.png', path: '/fixture/shot.png', type: 'file', size: 10 }] }),
    fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 10, mime_hint: 'image/png' }),
    fsDownload: async () => ({ data: 'eA==' }),
  })], setup(window) { window.localStorage.setItem('tmux_layout_mode', 'mobile'); } });
  try {
    await settle(image);
    image.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(image);
    assert.ok(image.document.querySelector('.image-open'));
    assert.equal(image.document.querySelector('button[aria-label="Reading mode"]'), null, 'an image has the Lightbox');
  } finally { await image.close(); }
  const desktop = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [rpc()],
    setup(window) { window.localStorage.setItem('tmux_layout_mode', 'desktop'); } });
  try {
    await settle(desktop);
    desktop.document.querySelector<HTMLButtonElement>('.file-row .file-main')!.click();
    await settle(desktop);
    assert.ok(desktop.document.querySelector('.md-render'));
    assert.equal(desktop.document.querySelector('button[aria-label="Reading mode"]'), null, 'the desktop keeps its chrome');
  } finally { await desktop.close(); }
});

// Board #420 (owner 2026-10-18: "如果点了多个下载，应该有一个下载文件列表，而不是
// 之前的显示看不到了"): every download in progress keeps its own card, newest
// first, read from the store; a newer one never hides an older one.
test('several downloads show one card each, newest first; cancel and finish touch only their own (#420)', async context => {
  const feeds = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const handed: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    setup(window) {
      (window.URL as any).createObjectURL = () => 'blob:fixture';
      (window.URL as any).revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { handed.push((this as HTMLAnchorElement).download); };
      (window as any).fetch = async (url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({ start(c) {
          feeds.set(url, c);
          init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        } });
        return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
      };
    },
    modules: [rpc({ fsDownloadHttp: async (path: string) => ({ url: `http://h/dl?p=${path}`, name: path.split('/').pop() }) })],
  });
  const cards = () => [...app.document.querySelectorAll('.files-feedback .operation-feedback')].map((e) => e.textContent?.replace(/\s+/gu, ' ').trim() ?? '');
  const feed = (path: string, n: number) => feeds.get(`http://h/dl?p=${path}`)!.enqueue(new Uint8Array(n));
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 20 && feeds.size < 1; i++) await settle(app);
    feed('/fixture/AGENTS.md', 250); await settle(app);
    await app.advance(1000);
    button(app, 'Download: next.md').click();
    for (let i = 0; i < 20 && feeds.size < 2; i++) await settle(app);
    feed('/fixture/next.md', 500); await settle(app);
    let now = cards();
    assert.equal(now.length, 2, `two downloads, two cards: ${now.join(' | ')}`);
    assert.match(now[0]!, /next\.md/u, 'newest first');
    assert.match(now[0]!, /50%/u);
    assert.match(now[1]!, /AGENTS\.md/u, 'the first is still on screen');
    assert.match(now[1]!, /25%/u, 'with its own percent');

    // Cancelled from its own card: the other stays, with its progress.
    button(app, 'Cancel: next.md').click();
    for (let i = 0; i < 20 && cards().length > 1; i++) await settle(app);
    now = cards();
    assert.equal(now.length, 1, `cancelling one leaves the other: ${now.join(' | ')}`);
    assert.match(now[0]!, /AGENTS\.md.*25%/u);

    button(app, 'Download: next.md').click();
    for (let i = 0; i < 20 && cards().length < 2; i++) await settle(app);
    // The first finishes: its card leaves, its outcome is told, the other runs on.
    feed('/fixture/AGENTS.md', 750); feeds.get('http://h/dl?p=/fixture/AGENTS.md')!.close();
    for (let i = 0; i < 20 && !handed.includes('AGENTS.md'); i++) await settle(app);
    await settle(app);
    now = cards();
    assert.deepEqual(handed, ['AGENTS.md']);
    assert.ok(now.some((t) => /Download requested.*AGENTS\.md/u.test(t)), `the outcome is told: ${now.join(' | ')}`);
    assert.ok(now.some((t) => /next\.md/u.test(t) && /Cancel|%|Downloading/u.test(t) && !/requested/u.test(t)), `next.md still runs: ${now.join(' | ')}`);
    assert.ok(!now.some((t) => /AGENTS\.md.*%/u.test(t)), 'the finished download has no progress card');
  } finally { for (const f of feeds.values()) { try { f.close(); } catch {} } await app.close(); }
});

// Board #301, kept: a download that ends while Files is HIDDEN tells its
// outcome once when Files is seen again. Review P1-B (#420): the outcome is
// HELD while hidden, so its 1500 ms life starts on return, not at the end.
test('a download that ends while Files is hidden is told once on return, however late (#301, #420)', async context => {
  const first = deferred<object>();
  const feeds = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const calls: string[] = [];
  let set!: (next: Record<string, unknown>) => void;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture', register: (fn: typeof set) => { set = fn; } },
    setup(window) {
      (window.URL as any).createObjectURL = () => 'blob:fixture';
      (window.URL as any).revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { calls.push((this as HTMLAnchorElement).download); };
      (window as any).fetch = async (url: string) => {
        const body = new ReadableStream<Uint8Array>({ start(c) { feeds.set(url, c); } });
        return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
      };
    },
    modules: [rpc({ fsDownloadHttp: (path: string) => (path.endsWith('AGENTS.md') ? first.promise : Promise.resolve({ url: `http://h/dl?p=${path}`, name: 'next.md' })) })],
  });
  const notices = () => [...app.document.querySelectorAll('.operation-feedback')].map((e) => e.textContent?.replace(/\s+/gu, ' ').trim() ?? '');
  const told = () => notices().filter((n) => /Download requested.*AGENTS\.md/u.test(n));
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click(); await settle(app);
    button(app, 'Download: next.md').click();
    for (let i = 0; i < 20 && feeds.size < 1; i++) await settle(app);
    set({ visible: false }); await settle(app);
    first.resolve({ base64: 'eA==' }); await settle(app);
    assert.deepEqual(calls, ['AGENTS.md'], 'the file was handed to the browser');
    await app.advance(5000); await settle(app);         // far past COMPLETION_FEEDBACK_MS
    set({ visible: true }); await settle(app);
    assert.equal(told().length, 1, `held while hidden, told on return: ${notices().join(' | ')}`);
    assert.ok(notices().some((n) => /next\.md/u.test(n) && !/requested/u.test(n)), 'the other download keeps its card');
    await app.advance(1600); await settle(app);
    assert.equal(told().length, 0, 'then it expires like any success');
    assert.ok(notices().some((n) => /next\.md/u.test(n)), 'and the running card stays');
    set({ visible: false }); await settle(app);
    set({ visible: true }); await settle(app);
    assert.equal(told().length, 0, 'told once: no replay on the next return');
  } finally { first.reject(Error('fixture closed')); for (const f of feeds.values()) { try { f.close(); } catch {} } await app.close(); }
});

// Review P2-C (#420): the card offers Cancel only while a Cancel is honored.
// Through the whole-file fallback, a Cancel before the bytes arrive means
// nothing is handed to the browser and nothing more is said.
test('a Cancel through the whole-file fallback is honored: nothing is saved (#420)', async context => {
  const pending = deferred<object>();
  const calls: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    setup(window) {
      (window.URL as any).createObjectURL = () => 'blob:fixture';
      (window.URL as any).revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { calls.push((this as HTMLAnchorElement).download); };
    },
    modules: [rpc({ fsDownloadHttp: () => pending.promise })],
  });
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click(); await settle(app);
    button(app, 'Cancel: AGENTS.md').click(); await settle(app);
    pending.resolve({ base64: 'eA==' });               // the bytes arrive after the Cancel
    for (let i = 0; i < 5; i++) await settle(app);
    assert.deepEqual(calls, [], 'nothing was handed to the browser');
    assert.equal(app.document.querySelector('.files-feedback .operation-feedback'), null, 'no card, no outcome');
  } finally { pending.reject(Error('fixture closed')); await app.close(); }
});

test('a download\u2019s failure is reported, closable, while another keeps its card (#301, #420)', async context => {
  const first = deferred<object>(), second = deferred<object>();
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsDownloadHttp: (path: string) => (path.endsWith('AGENTS.md') ? first.promise : second.promise) })],
  });
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click(); await settle(app);
    button(app, 'Download: next.md').click(); await settle(app);
    first.reject(Error('first failed')); await settle(app);
    const all = [...app.document.querySelectorAll('.operation-feedback')];
    assert.equal(all.length, 2, 'the running card stays, the failure joins it');
    const failed = all.find((e) => /first failed/u.test(e.textContent ?? ''))!;
    assert.ok(failed, 'the earlier failure is shown');
    assert.ok(all.some((e) => /next\.md/u.test(e.textContent ?? '') && !/first failed/u.test(e.textContent ?? '')), 'next.md is still downloading');
    failed.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); await settle(app);
    assert.equal(app.document.querySelectorAll('.operation-feedback').length, 1);
  } finally { first.reject(Error('fixture closed')); second.reject(Error('fixture closed')); await app.close(); }
});

// Board #305: on Android the bytes leave in ≤4 MiB base64 pieces through the
// download_* commands while they arrive. The whole buffer never crosses the
// bridge (the JSON-per-byte encoding behind the owner's "invalid array length").
const shell = compileMount(new URL('./Files.test.svelte', import.meta.url),
  [new URL('../core/ws.ts', import.meta.url), new URL('../core/native.ts', import.meta.url)], { serverScope: true });
test('Android saves a download through download_chunk pieces, never one buffer (#305)', async context => {
  const size = 7 * 1024 * 1024 + 123;           // three pieces: 3 MiB, 3 MiB, the rest
  const file = new Uint8Array(size).map((_, i) => i & 0xff);
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let releasedAll = 0;
  const app = await (await shell).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async (_url: string, init: RequestInit) => {
        assert.equal(JSON.stringify(init.headers), '{}', 'nothing on disk: a fresh request');
        return new Response(file, { status: 200, headers: { etag: '"v1"', 'content-length': String(size) } });
      };
    },
    modules: [
      rpc({ getMachineId: () => 'machine-1', fsDownloadHttp: async () => ({ url: 'http://h/dl?path=x', name: 'AGENTS.md' }) }),
      { invokeNative: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'download_release_all') { releasedAll++; return null; }   // the page start
        calls.push({ cmd, args });
        if (cmd === 'download_open') return { received: 0, etag: null };
        if (cmd === 'download_finish') return '/storage/emulated/0/Download/TmuxMobile/AGENTS.md';
        return null;
      } },
    ],
  });
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 40 && !calls.some((c) => c.cmd === 'download_finish'); i++) await settle(app);
    assert.equal(releasedAll, 1, 'a new page drops stale Rust claims once');
    const id = calls[0]!.args.id as string;
    assert.match(id, /^[0-9a-f]{16}$/u);
    assert.deepEqual(calls.map((c) => c.cmd), ['download_open', 'download_reset', 'download_chunk', 'download_chunk', 'download_chunk', 'download_finish']);
    assert.ok(calls.every((c) => c.args.id === id), 'one part for the whole download');
    assert.equal(calls[1]!.args.etag, '"v1"', 'the part is tagged with the version it holds');
    const pieces = calls.filter((c) => c.cmd === 'download_chunk').map((c) => atob(c.args.data as string).length);
    assert.deepEqual(pieces, [3 * 1024 * 1024, 3 * 1024 * 1024, 1024 * 1024 + 123]);
    assert.ok(calls.every((c) => !('bytes' in c.args) && !(c.args.data instanceof Uint8Array)), 'no raw buffer crosses');
    assert.equal(JSON.stringify(calls.at(-1)!.args), JSON.stringify({ id, name: 'AGENTS.md', dest: null }), 'Android needs no destination');
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /TmuxMobile\/AGENTS\.md/u);
  } finally { await app.close(); }
});

// Review P2-C (#420): while a download is SAVING (here Android's finish),
// a Cancel would not be honored, so its card offers none.
test('a saving download offers no Cancel; it ends Saved (#420)', async context => {
  const finish = deferred<string>();
  const app = await (await shell).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async () => new Response(new Uint8Array(10), { status: 200, headers: { etag: '"v1"', 'content-length': '10' } });
    },
    modules: [
      rpc({ getMachineId: () => 'machine-1', fsDownloadHttp: async () => ({ url: 'http://h/dl?path=x', name: 'AGENTS.md' }) }),
      { invokeNative: async (cmd: string) => {
        if (cmd === 'download_open') return { received: 0, etag: null };
        if (cmd === 'download_finish') return finish.promise;
        return null;
      } },
    ],
  });
  const card = () => app.document.querySelector('.files-feedback .operation-feedback');
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 40 && !/Saving/u.test(card()?.textContent ?? ''); i++) await settle(app);
    assert.match(card()?.textContent ?? '', /Saving.*AGENTS\.md/u, 'the row is saving');
    assert.equal(app.document.querySelector('button[aria-label="Cancel: AGENTS.md"]'), null, 'no Cancel that would not happen');
    finish.resolve('/storage/emulated/0/Download/TmuxMobile/AGENTS.md');
    for (let i = 0; i < 20 && !/Saved/u.test(card()?.textContent ?? ''); i++) await settle(app);
    assert.match(card()?.textContent ?? '', /Saved/u);
  } finally { finish.resolve(''); await app.close(); }
});

// Validator #305 P1: a second Download of a file still downloading reused its
// part id and appended to the same .part (7340032 bytes for a 4 MiB file,
// reported "Saved"). It now takes the running attempt back into the slot.
test('a second Download of a file in flight starts no second writer (#305)', async context => {
  const size = 4 * 1024 * 1024;
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let fetches = 0;
  const written: number[] = [];
  const calls: string[] = [];
  const app = await (await shell).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async () => {
        fetches++;
        const body = new ReadableStream<Uint8Array>({ start(c) { feed = c; } });
        return new Response(body, { status: 200, headers: { etag: '"v1"', 'content-length': String(size) } });
      };
    },
    modules: [
      rpc({ getMachineId: () => 'machine-1', fsDownloadHttp: async () => ({ url: 'http://h/dl?path=x', name: 'AGENTS.md' }) }),
      { invokeNative: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push(cmd);
        if (cmd === 'download_open') return { received: 0, etag: null };
        if (cmd === 'download_chunk') written.push(atob(args.data as string).length);
        if (cmd === 'download_finish') return '/storage/emulated/0/Download/TmuxMobile/AGENTS.md';
        return null;
      } },
    ],
  });
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 20 && !feed; i++) await settle(app);
    feed.enqueue(new Uint8Array(size / 2));
    await settle(app);
    // Board #307: the download path asks for the download glyph, whose ring
    // keeps turning while the percent is known.
    const icon = app.document.querySelector('.operation-feedback .feedback-icon');
    assert.ok(icon?.classList.contains('downloading') && icon.querySelector('.dl-ring'), 'Files passes glyph: download');
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /50%/u, 'at a known percent');
    button(app, 'Download: AGENTS.md').click();      // the second click, mid-transfer
    await settle(app);
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /Downloading/u,
      'the slot shows the running attempt again');
    feed.enqueue(new Uint8Array(size / 2)); feed.close();
    for (let i = 0; i < 40 && !calls.includes('download_finish'); i++) await settle(app);
    assert.equal(calls.filter((c) => c === 'download_open').length, 1, 'one attempt opened the part');
    assert.equal(fetches, 1, 'one transfer');
    assert.equal(written.reduce((a, b) => a + b, 0), size, 'the part holds the file exactly once');
    assert.equal(calls.filter((c) => c === 'download_finish').length, 1);
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /Saved/u);
    // Done: the same file may be downloaded again.
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 20 && fetches < 2; i++) await settle(app);
    assert.equal(fetches, 2, 'a finished download releases its id');
  } finally { try { feed.close(); } catch {} await app.close(); }
});

// Validator #306 P1: Files must not abort (or release) a part whose claim
// Rust refused; the other writer owns it. The notice is the JS guard's.
test('a claim Rust refuses leaves the other writer\u2019s part alone and says it is downloading (#306)', async context => {
  const calls: string[] = [];
  let fetched = 0;
  const app = await (await shell).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async () => { fetched++; return new Response(new Uint8Array(1), { status: 200 }); };
    },
    modules: [
      rpc({ getMachineId: () => 'machine-1', fsDownloadHttp: async () => ({ url: 'http://h/dl?path=x', name: 'AGENTS.md' }) }),
      { invokeNative: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'download_open') throw new Error('this file is already downloading');
        return null;
      } },
    ],
  });
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    for (let i = 0; i < 20 && !calls.includes('download_open'); i++) await settle(app);
    await settle(app);
    assert.ok(!calls.includes('download_abort'), 'the other writer\u2019s part is not deleted');
    assert.ok(!calls.includes('download_release'), 'nor its claim released');
    assert.equal(fetched, 0);
    const notice = app.document.querySelector('.operation-feedback')?.textContent ?? '';
    assert.match(notice, /Already downloading/u, 'the localized notice, not the Rust text');
    assert.doesNotMatch(notice, /this file is already downloading/u);
  } finally { await app.close(); }
});

// Board #308: the Downloads view reads the one store plus the shell's disk.
test('the Downloads view: two running rows, Cancel aborts its part, a part on disk is resumable (#308)', async context => {
  const feeds = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const app = await (await shell).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async (url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({ start(c) {
          feeds.set(url, c);
          init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        } });
        return new Response(body, { status: 200, headers: { etag: '"v1"', 'content-length': '1000' } });
      };
    },
    modules: [
      rpc({ getMachineId: () => 'machine-1', fsDownloadHttp: async (path: string) => ({ url: `http://h/dl?p=${path}`, name: path.split('/').pop() }) }),
      { invokeNative: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd === 'download_open') return { received: 0, etag: null };
        if (cmd === 'list_downloads') return [{ name: 'old.mp4', modified: 1 }];
        if (cmd === 'download_list_parts') return [{ id: '0123456789abcdef', received: 2048, name: 'half.bin', path: '/fixture/half.bin', server: 'machine-1' }];
        return null;
      } },
    ],
  });
  const q = (s: string) => app.document.querySelector<HTMLElement>(s);
  const rows = (s: string) => [...app.document.querySelectorAll<HTMLElement>(s)].map((e) => e.textContent?.replace(/\s+/gu, ' ').trim());
  try {
    await settle(app);
    button(app, 'Download: AGENTS.md').click();
    button(app, 'Download: next.md').click();
    for (let i = 0; i < 20 && feeds.size < 2; i++) await settle(app);
    for (const f of feeds.values()) f.enqueue(new Uint8Array(250));
    await settle(app);
    button(app, 'Downloads').click();
    for (let i = 0; i < 20 && !q('.downloads-list .dl-active'); i++) await settle(app);
    const active = rows('.downloads-list .dl-active');
    assert.equal(active.length, 2, 'two downloads, two rows');
    assert.ok(active.some((t) => /next\.md.*25%/u.test(t ?? '')) && active.some((t) => /AGENTS\.md.*25%/u.test(t ?? '')), active.join(' | '));
    assert.ok(rows('.downloads-list .file-row').some((t) => /half\.bin.*2\.0 KB/u.test(t ?? '')), 'the part on disk is resumable');
    assert.ok(rows('.downloads-list .file-row').some((t) => /old\.mp4/u.test(t ?? '')), 'and Android lists what it saved');
    const nextId = calls.find((c) => c.cmd === 'download_open' && calls.some((d) => d.cmd === 'download_reset' && d.args.id === c.args.id && (d.args.about as any)?.name === 'next.md'))!.args.id;
    button(app, 'Cancel: next.md').click();
    for (let i = 0; i < 20 && !calls.some((c) => c.cmd === 'download_abort'); i++) await settle(app);
    assert.deepEqual(calls.filter((c) => c.cmd === 'download_abort').map((c) => c.args.id), [nextId], 'Cancel aborts that part only');
    await settle(app);
    assert.equal(rows('.downloads-list .dl-active').length, 1, 'and its row goes');
    button(app, 'Download again: half.bin').click();
    for (let i = 0; i < 20 && feeds.size < 3; i++) await settle(app);
    assert.ok([...feeds.keys()].some((u) => u.endsWith('/fixture/half.bin')), 'resume starts from the part\u2019s server path');
  } finally { for (const f of feeds.values()) { try { f.close(); } catch {} } await app.close(); }
});

const guarded = compileMount(new URL('./Files.guard.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });

test('a server switch asks an unsaved editor through its own discard dialog (board 315)', async context => {
  let api!: { confirmLeave: () => Promise<boolean> };
  const app = await (await guarded).mount(context, {
    props: { visible: true, session: 'fixture', guardPage: 'files', expose: (a: typeof api) => { api = a; } },
    modules: [rpc()],
    pendingImports: ['highlight.js/'], // the editor's highlighter loads lazily; this tier cannot paint it
  });
  try {
    await settle(app);
    // Clean list: nothing to ask, the switch may go.
    assert.equal(await api.confirmLeave(), true);
    app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle(app);
    button(app, 'Edit').click(); await settle(app);
    const area = app.document.querySelector<HTMLTextAreaElement>('.editor-layer textarea')!;
    area.value = '# Rules\n\nchanged'; area.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle(app);
    // Dirty: the discard dialog asks; Cancel keeps the switch from happening.
    let answer = api.confirmLeave(); await settle(app);
    const dialog = app.document.querySelector('[role=alertdialog]');
    assert.ok(dialog, 'the editor’s own discard confirmation');
    button(app, 'Keep editing').click(); await settle(app);
    assert.equal(await answer, false);
    assert.equal(area.isConnected && area.value, '# Rules\n\nchanged', 'the text is still there');
    // Discard: the switch may go.
    answer = api.confirmLeave(); await settle(app);
    button(app, 'Discard').click(); await settle(app);
    assert.equal(await answer, true);
  } finally { await app.close(); }
});

test('a download on a released server s record sends nothing (board #335 ②b-2-3, reviewer P1-a)', async context => {
  // The record is sealed while the page is still on screen — a release is
  // under way. A click on Download must not reach the server at all.
  const asked: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [rpc({ fsDownloadHttp: async () => { asked.push('fs_download_http'); return { base64: 'eA==' }; },
      fsDownload: async () => { asked.push('fs_download'); return { data: 'eA==' }; } })],
  });
  try {
    await settle(app);
    (app.window as any).__serverState.files.memory.seal('released');
    button(app, 'Download: AGENTS.md').click(); await settle(app);
    assert.deepEqual(asked, [], 'no RPC from a sealed record');
    assert.equal((app.window as any).__serverState.files.downloads.rows.length, 0, 'and no row');
  } finally { await app.close(); }
});

// Board #431: a bare directory path in a document or a chat bubble is a link
// now, and a DIRECTORY link lists the directory. It used to land on the file
// info card, because a link always opened as a file. Its way back is a REAL
// history entry (#431 review P1): every sequence below unwinds in order.
const tree: Record<string, { name: string; path: string; type: string; size: number }[]> = {
  '/fixture': entries,
  '/fixture/sub': [
    { name: 'deep', path: '/fixture/sub/deep', type: 'dir', size: 0 },
    { name: 'inside.md', path: '/fixture/sub/inside.md', type: 'file', size: 10 },
  ],
  '/fixture/sub/deep': [{ name: 'bottom.md', path: '/fixture/sub/deep/bottom.md', type: 'file', size: 10 }],
  '/fixture/other': [{ name: 'other.md', path: '/fixture/other/other.md', type: 'file', size: 10 }],
};
const docs: Record<string, string> = {
  'AGENTS.md': '# Rules\n\nLogs in /fixture/sub/ and [Next](next.md), here /fixture/',
  'next.md': '# Next\n\nsee /fixture/sub/',
  'inside.md': '# Inside\n\nhere /fixture/sub/ and there /fixture/other/',
};
const dirOf = (path: string) => path.replace(/\/+$/u, '');
function dirRpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return rpc({
    fsList: async (path: string) => ({ path, entries: tree[dirOf(path)] ?? [] }),
    fsStat: async (path: string) => (tree[dirOf(path)]
      ? { path, type: 'dir', is_text: false, writable: true, readable: true, size: 0, mime_hint: '' }
      : { path, type: 'file', is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' }),
    fsRead: async (path: string) => ({ content: docs[path.slice(path.lastIndexOf('/') + 1)] ?? '# Doc' }),
    ...extra,
  });
}
function link(app: App, href: string) {
  const a = [...app.document.querySelectorAll<HTMLAnchorElement>('.md-render a')].find((el) => el.getAttribute('href') === href);
  assert.ok(a, `a link to ${href}`);
  a.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
/** Where the page is: the open preview's name, or the listing's entries. */
function at(app: App): string {
  const name = app.document.querySelector('.preview-name')?.textContent;
  if (name) return `preview ${name}`;
  return `list ${[...app.document.querySelectorAll('.file-list .file-name')].map((el) => el.textContent?.trim()).join(',')}`;
}
function row(app: App, name: string) {
  const el = [...app.document.querySelectorAll<HTMLButtonElement>('.file-list .file-main')]
    .find((b) => b.querySelector('.file-name')?.textContent?.trim() === name);
  assert.ok(el, `row ${name} in ${at(app)}`); el.click();
}
async function back(app: App) { button(app, 'Back').click(); await settle(app); }
const ROOT = 'list AGENTS.md,next.md';
const SUB = 'list deep,inside.md';

test('a directory link lists the directory, and Back returns to the preview that held the link (#431)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    assert.equal(at(app), SUB, 'no info card: the directory is listed');
    await back(app); assert.equal(at(app), 'preview AGENTS.md', 'Back returns to the document that held the link');
    await back(app); assert.equal(at(app), ROOT, 'and then to the list it was opened from');
  } finally { await app.close(); }
});

test('a link to the directory already listed is a step of its own, on an empty or a full history (#431 review P1)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
  try {
    await settle(app);
    // Empty history: the link is the only step.
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/'); await settle(app);
    assert.equal(at(app), ROOT);
    assert.equal(button(app, 'Back').disabled, false, 'Back is offered: the link pushed a step');
    await back(app); assert.equal(at(app), 'preview AGENTS.md');
    await back(app); assert.equal(at(app), ROOT);
    // A full history: AGENTS.md -> /fixture/sub (a link), inside.md, then a
    // link to /fixture/sub, the directory already listed. Nothing that link
    // did not push is popped: the earlier link's preview is still reached.
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    row(app, 'inside.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview inside.md');
    await back(app); assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview AGENTS.md');
    await back(app); assert.equal(at(app), ROOT);
  } finally { await app.close(); }
});

test('preview -> linked preview -> directory unwinds through both previews (#431 review P1)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, 'next.md'); await settle(app);
    assert.equal(at(app), 'preview next.md');
    link(app, '/fixture/sub/'); await settle(app);
    assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview next.md');
    await back(app); assert.equal(at(app), 'preview AGENTS.md', 'the linked-file history survived the directory link');
    await back(app); assert.equal(at(app), ROOT);
  } finally { await app.close(); }
});

test('preview -> directory -> preview -> directory unwinds each step once (#431 review P1)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    row(app, 'inside.md'); await settle(app);
    assert.equal(at(app), 'preview inside.md');
    link(app, '/fixture/other/'); await settle(app);
    assert.equal(at(app), 'list other.md');
    await back(app); assert.equal(at(app), 'preview inside.md');
    await back(app); assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview AGENTS.md', 'the first link\u2019s preview is still reached');
    await back(app); assert.equal(at(app), ROOT);
  } finally { await app.close(); }
});

test('a link, then a directory by hand, then Back twice reaches the preview once (#431 review P1)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    row(app, 'deep'); await settle(app);
    assert.equal(at(app), 'list bottom.md');
    await back(app); assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview AGENTS.md');
    await back(app); assert.equal(at(app), ROOT, 'not the preview a second time');
  } finally { await app.close(); }
});

test('a second link while the first listing is open is an ordinary directory step (#431 review P1)', async context => {
  let update!: (next: Record<string, unknown>) => void;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture', register: (fn: typeof update) => { update = fn; } },
    modules: [dirRpc()],
  });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    update({ navRequest: { file: '/fixture/other/', n: 1 } }); await settle(app);
    assert.equal(at(app), 'list other.md');
    await back(app); assert.equal(at(app), SUB);
    await back(app); assert.equal(at(app), 'preview AGENTS.md');
  } finally { await app.close(); }
});

test('a directory answer that arrives after the target changed is dropped (#431)', async context => {
  const late = deferred<object>();
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [dirRpc({ fsStat: (path: string) => (path.startsWith('/fixture/sub')
      ? late.promise
      : Promise.resolve({ path, type: 'file', is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' })) })],
  });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await app.flush();
    link(app, 'next.md'); await settle(app);
    assert.equal(at(app), 'preview next.md');
    late.resolve({ path: '/fixture/sub/', type: 'dir', is_text: false, writable: true, readable: true, size: 0, mime_hint: '' });
    await settle(app);
    assert.equal(at(app), 'preview next.md', 'the newer target keeps the page');
  } finally { late.resolve({}); await app.close(); }
});

test('a listing that answers after Back does not cover the preview Back returned to (#431 review P1)', async context => {
  const late = deferred<object>();
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    modules: [dirRpc({ fsList: (path: string) => (dirOf(path) === '/fixture/sub' ? late.promise : Promise.resolve({ path, entries: tree[dirOf(path)] ?? [] })) })],
  });
  try {
    await settle(app);
    row(app, 'AGENTS.md'); await settle(app);
    link(app, '/fixture/sub/'); await settle(app);
    await back(app);
    assert.equal(at(app), 'preview AGENTS.md');
    late.resolve({ path: '/fixture/sub/', entries: tree['/fixture/sub'] }); await settle(app);
    assert.equal(at(app), 'preview AGENTS.md', 'the late listing is dropped');
  } finally { late.resolve({ path: '/fixture/sub/', entries: [] }); await app.close(); }
});

// #431 review P1 residual: browsing INSIDE the linked directory (a plain file
// open, a subdirectory) must not cut the preview the link came from off from
// its own origin. The link entry carries that preview's linked-file history.
for (const browse of ['a file', 'a subdirectory'] as const) {
  test(`preview -> linked preview -> directory -> ${browse} -> Back still reaches the first preview (#431 review P1)`, async context => {
    const app = await (await compiled).mount(context, { props: { visible: true, session: 'fixture' }, modules: [dirRpc()] });
    try {
      await settle(app);
      row(app, 'AGENTS.md'); await settle(app);
      link(app, 'next.md'); await settle(app);
      link(app, '/fixture/sub/'); await settle(app);
      assert.equal(at(app), SUB);
      if (browse === 'a file') {
        row(app, 'inside.md'); await settle(app);
        assert.equal(at(app), 'preview inside.md');
      } else {
        row(app, 'deep'); await settle(app);
        assert.equal(at(app), 'list bottom.md');
      }
      await back(app); assert.equal(at(app), SUB, `${browse}: Back returns to the linked listing`);
      await back(app); assert.equal(at(app), 'preview next.md');
      await back(app); assert.equal(at(app), 'preview AGENTS.md', `${browse}: the linked preview still reaches its origin`);
      await back(app); assert.equal(at(app), ROOT, 'and only then the original list');
    } finally { await app.close(); }
  });
}
