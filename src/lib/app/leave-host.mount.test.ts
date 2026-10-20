// Two dirty editors on two pages, asked by the real leave walk (board 315
// review P1): a cancel at EITHER loses nothing, the editor not on screen is
// never unmounted before it answered, and a save in flight is waited for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import type { DOMWindow } from 'jsdom';
import type { TestContext } from 'node:test';

const compiled = compileMount(new URL('./LeaveHost.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
const alpha = { name: 'alpha', backend: 'codex', model: '', effort: '', system: 'Original', skills: '[]', mcp: '[]' };
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    fsCwd: async () => ({ path: '/fixture' }),
    fsList: async () => ({ path: '/fixture', entries: [{ name: 'notes.md', path: '/fixture/notes.md', type: 'file', size: 10 }] }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 10, mime_hint: 'text/markdown' }),
    fsRead: async () => ({ content: '# Notes' }),
    // A text preview asks which project holds it (review comments, #434): none here.
    projectList: async () => ({ projects: [] }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
    saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 0, stdout: '.git' }),
    registryList: async () => ({ agents: [alpha] }),
    teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }),
    mcpList: async () => ({ mcp: [] }), modelsList: async () => ({ models: [] }),
    ...extra,
  };
}
type Api = { go: (p: string) => void; page: () => string; leave: () => Promise<boolean> };
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function settle(app: App, n = 10) { for (let i = 0; i < n; i++) await app.flush(); }
function button(app: App, label: string, scope = '') {
  const el = app.document.querySelector<HTMLButtonElement>(`${scope} button[aria-label="${label}"]`);
  assert.ok(el, label); return el;
}
function type(win: DOMWindow, field: HTMLTextAreaElement, value: string) {
  field.value = value; field.dispatchEvent(new win.Event('input', { bubbles: true }));
}
/** Files: open notes.md and edit it. Agents: open alpha and edit its prompt. */
async function dirtyBoth(app: App, api: Api) {
  api.go('files'); await settle(app);
  app.document.querySelector<HTMLButtonElement>('.layer-files .file-main')!.click(); await settle(app);
  button(app, 'Edit', '.layer-files').click(); await settle(app);
  type(app.window, app.document.querySelector('.layer-files .editor-layer textarea')!, '# Notes, unsaved');
  api.go('prefs'); await settle(app, 14);
  [...app.document.querySelectorAll<HTMLButtonElement>('.layer-prefs .side-row')].find((b) => b.querySelector('.r-name')?.textContent === 'alpha')!.click();
  await settle(app);
  type(app.window, app.document.querySelector('.layer-prefs .editor textarea')!, 'Agent draft');
  await settle(app);
}
const filesText = (app: App) => app.document.querySelector<HTMLTextAreaElement>('.layer-files .editor-layer textarea')?.value;
const agentText = (app: App) => app.document.querySelector<HTMLTextAreaElement>('.layer-prefs .editor textarea')?.value;
const mountHost = (context: TestContext, extra = {}) => {
  let api!: Api;
  return compiled.then((c) => c.mount(context, {
    props: { expose: (a: Api) => { api = a; } }, modules: [rpc(extra)], pendingImports: ['highlight.js/'],
  })).then((app) => ({ app, api: () => api }));
};

test('cancel at the editor on screen (Agents): nothing asked elsewhere, nothing lost', async (context) => {
  const { app, api } = await mountHost(context);
  try {
    await dirtyBoth(app, api());
    const answer = api().leave(); await settle(app);
    assert.equal(api().page(), 'prefs', 'the current page asks first, without navigating');
    button(app, 'Keep editing', '.layer-prefs').click(); await settle(app);
    assert.equal(await answer, false);
    assert.equal(agentText(app), 'Agent draft');
    assert.equal(filesText(app), '# Notes, unsaved');
  } finally { await app.close(); }
});

test('cancel at the hidden editor (Files): the Agents draft that already answered is still mounted', async (context) => {
  const { app, api } = await mountHost(context);
  try {
    await dirtyBoth(app, api());
    const answer = api().leave(); await settle(app);
    button(app, 'Discard', '.layer-prefs').click(); await settle(app); // Agents: may leave
    assert.equal(api().page(), 'files', 'Files is revealed to ask');
    assert.equal(agentText(app), 'Agent draft', 'revealing Files did not unmount Settings');
    button(app, 'Keep editing', '.layer-files').click(); await settle(app);
    assert.equal(await answer, false);
    assert.equal(api().page(), 'prefs', 'back where the user started');
    assert.equal(agentText(app), 'Agent draft', 'nothing lost: no switch happened');
    assert.equal(filesText(app), '# Notes, unsaved');
  } finally { await app.close(); }
});

test('an Agents save in flight is waited for before the walk goes on', async (context) => {
  let finish!: () => void;
  const { app, api } = await mountHost(context, { registrySave: () => new Promise<void>((ok) => { finish = ok; }) });
  try {
    await dirtyBoth(app, api());
    button(app, 'Save', '.layer-prefs').click(); await settle(app);
    let done: boolean | null = null;
    void api().leave().then((v) => { done = v; }); await settle(app);
    assert.equal(done, null, 'held while the save is in flight');
    assert.equal(app.document.querySelector('.layer-files [role=alertdialog]'), null, 'Files not asked yet');
    finish(); await settle(app, 16);
    assert.equal(api().page(), 'files', 'then the walk moves on to Files');
    button(app, 'Discard', '.layer-files').click(); await settle(app);
    assert.equal(done, true);
  } finally { await app.close(); }
});
