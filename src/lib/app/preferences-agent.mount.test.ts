import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Through the host that gives the embedded editor its guest scope, as App
// does (board #335 ②b-3): the editor's RPCs are that scope's.
const compiled = compileMount(new URL('./Preferences.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)]);
const alpha = { name: 'alpha', backend: 'codex', model: '', system: 'Original', skills: '[]', mcp: '[]' };
const rpc = {
  registryList: async () => ({ agents: [alpha] }),
  teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }),
  mcpList: async () => ({ mcp: [] }), modelsList: async () => ({ models: [] }),
};
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function edit(app: App) {
  for (let i = 0; i < 8; i++) await app.flush();
  const row = [...app.document.querySelectorAll<HTMLButtonElement>('.agents-embed .guest:not(.off) .side-row, .agents-embed > .side-row')]
    .find(button => button.querySelector('.r-name')?.textContent === 'alpha')
    ?? [...app.document.querySelectorAll<HTMLButtonElement>('.agents-embed .guest:not(.off) .side-row')].find(button => /alpha/u.test(button.textContent ?? ''));
  assert.ok(row); row.click(); await app.flush();
  const prompt = app.document.querySelector<HTMLTextAreaElement>('.editor textarea')!;
  prompt.value = 'Unsaved';
  prompt.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
}
function category(app: App, name: string) {
  const button = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences > .sidebar .side-row')]
    .find(button => button.textContent?.trim() === name);
  assert.ok(button); button.click();
}

test('real Settings and Agent share one confirmation when changing an edited category (#156)', async context => {
  const app = await (await compiled).mount(context, {
    props: { showAgents: true }, modules: [rpc],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      // The font-availability sweep (#233) runs at mount; jsdom's canvas
      // fallback reports "not implemented" through the virtual console.
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  try {
    await edit(app);
    category(app, 'Teams'); await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    assert.ok(app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[aria-label="Discard"]')!.click();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'teams');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'an accepted section is not guarded a second time');
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('real Settings defers its category exit until the Agent Save completes (#156)', async context => {
  let finish!: () => void;
  const app = await (await compiled).mount(context, {
    props: { showAgents: true },
    modules: [{ ...rpc, registrySave: () => new Promise<void>(yes => finish = yes) }],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      window.HTMLCanvasElement.prototype.getContext = () => null; // see above
    },
  });
  try {
    await edit(app);
    app.document.querySelector<HTMLButtonElement>('[aria-label="Save"]')!.click(); await app.flush();
    category(app, 'Appearance'); await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    finish();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance');
    assert.equal(app.document.querySelector('.agents-embed'), null);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

// ③a, reviewer P1-C: each member keeps its own guest editor. A focus change
// shows another member's and never destroys one with a draft in it.
const guests = compileMount(new URL('./PreferencesGuests.test.svelte', import.meta.url), []);

test('a focus change keeps A s guest editor and its draft; B s editor is its own, and A s save goes to A (#335 ③a)', async context => {
  const sent: string[] = [];
  const server = (id: string) => ({
    registryList: async () => { sent.push(`${id}:registryList`); return { agents: [{ ...alpha, system: `prompt on ${id}` }] }; },
    registrySave: async (def: { system?: string }) => { sent.push(`${id}:registrySave:${def.system}`); return {}; },
    teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }),
    modelsList: async () => ({ models: [] }), backendsList: async () => ({ backends: [] }),
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
  });
  const app = await (await guests).mount(context, {
    props: { showAgents: true }, modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      window.HTMLCanvasElement.prototype.getContext = () => null;
      const realm = window as unknown as Record<string, unknown>;
      // Replies are JSON in the client realm (the mount harness's rule).
      const cloned = (o: Record<string, (...a: any[]) => unknown>) => Object.fromEntries(Object.entries(o).map(([k, f]) =>
        [k, (...a: unknown[]) => { const r = f(...a); return r instanceof Promise ? r.then((v) => (v === undefined ? v : window.JSON.parse(JSON.stringify(v)))) : r; }]));
      // Any method the fake lacks is recorded, so a missing one shows.
      const loud = (id: string, o: Record<string, (...a: any[]) => unknown>) => new Proxy(cloned(o), {
        get: (t, k) => (typeof k === 'string' && !(k in t) ? (() => { sent.push(`${id}:MISSING:${k}`); return Promise.reject(new Error('missing')); }) : t[k as string]),
      });
      realm.__guestA = loud('a', server('a'));
      realm.__guestB = loud('b', server('b'));
    },
  });
  const show = async (id: string) => { (app.window as unknown as { __showGuest(id: string): void }).__showGuest(id); for (let i = 0; i < 6; i++) await app.flush(); };
  const editors = () => [...app.document.querySelectorAll<HTMLTextAreaElement>('.agents-embed .editor textarea')];
  try {
    for (let i = 0; i < 8; i++) await app.flush();
    assert.ok(sent.includes('a:registryList'), 'A s guest listed A s registry');
    await edit(app);
    const draftA = editors()[0]!;
    assert.equal(draftA.value, 'Unsaved', 'A s guest has a draft');
    await show('b');
    assert.equal(draftA.isConnected, true, 'focus moved to B: A s editor is still mounted');
    assert.equal(draftA.value, 'Unsaved', 'with its draft');
    assert.ok(draftA.closest('.guest.off'), 'hidden');
    assert.ok(sent.includes('b:registryList'), 'B s guest asked B s registry');
    await show('a');
    assert.equal(editors().includes(draftA), true, 'back on A: the SAME editor');
    assert.equal(draftA.value, 'Unsaved', 'and the draft');
    app.document.querySelector<HTMLButtonElement>('.guest:not(.off) [aria-label="Save"]')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.ok(sent.includes('a:registrySave:Unsaved'), `A s save went to A: ${sent.join(' ')}`);
    assert.ok(!sent.some((s) => s.startsWith('b:registrySave')), 'and nothing reached B');
  } finally { await app.close(); }
});

test('the page asks the SHOWN guest: its exit guard and its Back, never the last to register (#335 ③a)', async context => {
  // B mounts after A, so "the last registered" is B; A is shown and dirty.
  const server = (id: string) => ({
    registryList: async () => ({ agents: [{ ...alpha, system: `prompt on ${id}` }] }), registrySave: async () => ({}),
    teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }),
    modelsList: async () => ({ models: [] }), backendsList: async () => ({ backends: [] }),
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
  });
  let back: (() => boolean) | null = null;
  const app = await (await guests).mount(context, {
    props: { showAgents: true, onGoBack: (fn: () => boolean) => { back = fn; } }, modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      window.HTMLCanvasElement.prototype.getContext = () => null;
      const realm = window as unknown as Record<string, unknown>;
      const cloned = (o: Record<string, (...a: any[]) => unknown>) => Object.fromEntries(Object.entries(o).map(([k, f]) =>
        [k, (...a: unknown[]) => { const r = f(...a); return r instanceof Promise ? r.then((v) => (v === undefined ? v : window.JSON.parse(JSON.stringify(v)))) : r; }]));
      realm.__guestA = cloned(server('a'));
      realm.__guestB = cloned(server('b'));
    },
  });
  const show = async (id: string) => { (app.window as unknown as { __showGuest(id: string): void }).__showGuest(id); for (let i = 0; i < 6; i++) await app.flush(); };
  try {
    await show('b'); await show('a');            // both mounted; B registered last
    await edit(app);                               // A dirty
    category(app, 'Teams'); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'A s guard asked before the category changed');
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    app.document.querySelector<HTMLButtonElement>('[aria-label="Keep editing"]')?.click();
    for (let i = 0; i < 3; i++) await app.flush();
    const editor = app.document.querySelector('.guest:not(.off) .editor');
    assert.ok(editor, 'A s editor is open');
    assert.equal(back!(), true, 'Back is consumed by the shown guest');
  } finally { await app.close(); }
});

test('an edit request opens in the SHOWN guest, never in a hidden one (#335 ③a)', async context => {
  const server = (id: string) => ({
    registryList: async () => ({ agents: [{ ...alpha, system: `prompt on ${id}` }] }), registrySave: async () => ({}),
    teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }),
    modelsList: async () => ({ models: [] }), backendsList: async () => ({ backends: [] }),
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
  });
  const app = await (await guests).mount(context, {
    props: { showAgents: true }, modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      window.HTMLCanvasElement.prototype.getContext = () => null;
      const realm = window as unknown as Record<string, unknown>;
      const cloned = (o: Record<string, (...a: any[]) => unknown>) => Object.fromEntries(Object.entries(o).map(([k, f]) =>
        [k, (...a: unknown[]) => { const r = f(...a); return r instanceof Promise ? r.then((v) => (v === undefined ? v : window.JSON.parse(JSON.stringify(v)))) : r; }]));
      realm.__guestA = cloned(server('a'));
      realm.__guestB = cloned(server('b'));
    },
  });
  const realm = app.window as unknown as { __showGuest(id: string): void; __guestProps(p: unknown): void };
  const flush = async () => { for (let i = 0; i < 8; i++) await app.flush(); };
  try {
    realm.__showGuest('b'); await flush();
    realm.__showGuest('a'); await flush();
    realm.__guestProps({ openRequest: { tab: 'agents', n: 1 }, agentsEditRequest: { name: 'alpha', n: 1 } });
    await flush();
    const open = [...app.document.querySelectorAll('.agents-embed .editor')].map((e) => e.closest('.guest')?.classList.contains('off') ? 'hidden' : 'shown');
    assert.deepEqual(open, ['shown'], `one editor opened, in the shown guest: ${open.join(',')}`);
  } finally { await app.close(); }
});
