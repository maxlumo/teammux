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
    // ③a (reviewer P1-1 on 6b923c0d): the guest's life is its member's, so
    // leaving the category hides it — inert — instead of destroying it.
    const embed = app.document.querySelector('.agents-embed');
    assert.ok(embed?.classList.contains('off') && (embed.hasAttribute('inert') || (embed as unknown as { inert?: boolean }).inert === true), `the editor is kept, hidden and inert: ${embed?.className}`);
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

test('an edit request opens in the guest of the server it names, and never moves to the next one shown (#335 ③a)', async context => {
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
    realm.__guestProps({ openRequest: { tab: 'agents', n: 1 }, agentsEditRequest: { serverId: 'a', name: 'alpha', n: 1 } });
    await flush();
    const open = () => [...app.document.querySelectorAll('.agents-embed .editor')].map((e) => e.closest('.guest')?.classList.contains('off') ? 'hidden' : 'shown');
    assert.deepEqual(open(), ['shown'], `one editor opened, in the shown guest: ${open().join(',')}`);
    // The request was A's (serverId 'a'): showing B never replays it on B s
    // same-named agent (reviewer P1-1(c) on 6b923c0d).
    realm.__showGuest('b'); await flush();
    assert.deepEqual(open(), ['hidden'], `B opened nothing; A s editor is kept hidden: ${open().join(',')}`);
  } finally { await app.close(); }
});

test('A s draft survives B leaving the category, and a hidden guest keeps its own section (#335 ③a, reviewer P1-1(a))', async context => {
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
  const show = async (id: string) => { (app.window as unknown as { __showGuest(id: string): void }).__showGuest(id); for (let i = 0; i < 6; i++) await app.flush(); };
  try {
    await edit(app);                                 // A dirty, on Agents
    const draftA = app.document.querySelector<HTMLTextAreaElement>('.guest:not(.off) .editor textarea')!;
    await show('b');
    category(app, 'Teams'); for (let i = 0; i < 4; i++) await app.flush();      // B moves to Teams
    category(app, 'Appearance'); for (let i = 0; i < 4; i++) await app.flush(); // and leaves the agent categories
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance', 'B s exits asked only B (clean)');
    assert.equal(draftA.isConnected, true, 'A s editor was not destroyed');
    category(app, 'Agents'); for (let i = 0; i < 4; i++) await app.flush();
    await show('a');
    assert.equal(draftA.isConnected, true);
    assert.equal(draftA.value, 'Unsaved', 'back on A, on Agents: the draft is there');
    assert.ok(draftA.closest('.guest:not(.off)'), 'and shown');
  } finally { await app.close(); }
});

/** Two guests over two transports, on the agents category. */
async function twoGuests(context: import('node:test').TestContext, props: Record<string, unknown> = {}) {
  const server = (id: string) => ({
    registryList: async () => ({ agents: [{ ...alpha, system: `prompt on ${id}` }] }), registrySave: async () => ({}),
    teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }),
    modelsList: async () => ({ models: [] }), backendsList: async () => ({ backends: [] }),
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
  });
  const app = await (await guests).mount(context, {
    props: { showAgents: true, ...props }, modules: [],
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
  const flush = async () => { for (let i = 0; i < 6; i++) await app.flush(); };
  return { app, flush, show: async (id: string) => { realm.__showGuest(id); await flush(); }, props: async (p: unknown) => { realm.__guestProps(p); await flush(); } };
}

test('each member keeps its OWN section: A dirty on Agents, B picks Teams, focus straight back to A — A is on Agents with its draft (#335 ③a, reviewer P1-1 residual)', async context => {
  const { app, flush, show } = await twoGuests(context);
  try {
    await edit(app);
    const draftA = app.document.querySelector<HTMLTextAreaElement>('.guest:not(.off) .editor textarea')!;
    await show('b');
    category(app, 'Teams'); await flush();                       // B s choice, B is clean
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'teams');
    await show('a');                                              // straight back, no Agents click
    assert.equal(draftA.isConnected, true, 'A s editor is the same one');
    assert.equal(draftA.value, 'Unsaved', 'its draft is untouched — B s Teams never reached A');
    assert.ok(draftA.closest('.guest:not(.off)'), 'shown, on A s own Agents');
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents', 'the page follows A s section');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'nothing was asked: nothing of A moved');
    // A changing its OWN category still asks its guard.
    category(app, 'Teams'); await flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'A s own move to Teams asks A');
  } finally { await app.close(); }
});

/** The open confirmation, and whether a person could answer it: no ancestor
 * hidden (`.off`, `.hidden`, display:none) or inert. */
function reachableDialog(app: App) {
  const dialog = app.document.querySelector('[role=alertdialog]');
  if (!dialog) return { dialog: null, reachable: false };
  for (let el: Element | null = dialog; el; el = el.parentElement) {
    if (el.classList.contains('off') || el.classList.contains('hidden') || el.hasAttribute('inert') || (el as unknown as { inert?: boolean }).inert === true) return { dialog, reachable: false };
  }
  return { dialog, reachable: true };
}

test('from a non-agent category, a choice that would move A s editor reveals A and asks there; Keep editing goes back, Discard moves (#335 ③a, reviewer P1 on c0969d20)', async context => {
  const { app, flush, show } = await twoGuests(context);
  try {
    await edit(app);                                  // A dirty on Agents
    const draftA = app.document.querySelector<HTMLTextAreaElement>('.guest:not(.off) .editor textarea')!;
    await show('b');
    category(app, 'Appearance'); await flush();       // B, clean, leaves the agent categories
    await show('a');                                  // the page stays on Appearance
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance');
    category(app, 'Teams'); await flush();            // would move A from Agents to Teams
    const asked = reachableDialog(app);
    assert.ok(asked.dialog, 'A s guard is asked');
    assert.ok(asked.reachable, 'and its confirmation is on screen, in A s revealed editor — not in a hidden, inert container');
    assert.ok(draftA.closest('.guest:not(.off)') && !draftA.closest('.agents-embed.off'), 'A s editor is shown, on its own section');
    assert.equal(draftA.value, 'Unsaved', 'the draft is untouched while it asks');
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((b) => /keep editing/iu.test(b.textContent ?? ''))!.click();
    await flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance', 'Keep editing: back on Appearance');
    assert.ok(app.document.querySelector('.agents-embed.off'), 'A s editor hidden again');
    assert.equal(draftA.isConnected && draftA.value, 'Unsaved', 'with its draft');
    category(app, 'Teams'); await flush();
    assert.ok(reachableDialog(app).reachable, 'asked again, reachably');
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((b) => /discard/iu.test(b.textContent ?? ''))!.click();
    await flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'teams', 'Discard: A moves to Teams');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('while held, an agent category lands on the held guest s own section; unheld, it is shown with its draft (#335 ③a, reviewer P2 on c0969d20)', async context => {
  const { app, flush, props } = await twoGuests(context);
  try {
    await edit(app);                                  // A dirty on Agents
    const draftA = app.document.querySelector<HTMLTextAreaElement>('.guest:not(.off) .editor textarea')!;
    await props({ guestHeld: 'blocked' });
    category(app, 'Teams'); await flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents', 'the page stays on A s section: A cannot be asked while held');
    await props({ guestHeld: '' });
    assert.ok(draftA.closest('.guest:not(.off)') && !draftA.closest('.agents-embed.off'), 'unheld: A s editor is shown, not a blank pane');
    assert.equal(draftA.value, 'Unsaved');
  } finally { await app.close(); }
});

test('a guest hidden with its page, or held by a block, takes no Back (#335 ③a, reviewer P1-2 residual)', async context => {
  let back: (() => boolean) | null = null;
  const { app, flush, props } = await twoGuests(context, { onGoBack: (fn: () => boolean) => { back = fn; } });
  try {
    await edit(app);                                     // A s editor open: its Back would close it
    const draftA = app.document.querySelector<HTMLTextAreaElement>('.guest:not(.off) .editor textarea')!;
    await props({ visible: false });                     // the person left Preferences (kept mounted)
    assert.equal(back!(), false, 'hidden page: Back does not reach the guest');
    assert.equal(draftA.isConnected, true);
    assert.ok(app.document.querySelector('.guest .editor'), 'its editor is still open');
    await props({ visible: true, guestHeld: 'blocked' }); // back on Preferences, but blocked
    assert.equal(back!(), false, 'held: Back does not reach the guest either');
    assert.ok(app.document.querySelector('.guest .editor'), 'the editor is still open');
    assert.equal(draftA.value, 'Unsaved');
    await props({ guestHeld: '' });
    assert.equal(back!(), true, 'shown and free again: Back peels the guest s editor');
  } finally { await app.close(); }
});

test('only a shown, free guest is visible: a request waits while its guest is hidden or held, and lands once it is shown and free (#335 ③a, validator NO BITEs on 9958bbfd)', async context => {
  const { app, flush, show, props } = await twoGuests(context);
  const editorIn = (id: 'a' | 'b') => [...app.document.querySelectorAll('.agents-embed .guest')]
    .filter((g) => (g.querySelector('.editor textarea') as HTMLTextAreaElement | null)?.value === `prompt on ${id}`).length;
  try {
    await show('b'); await show('a');                 // both mounted, A shown
    await props({ openRequest: { tab: 'agents', n: 1 }, agentsEditRequest: { serverId: 'b', name: 'alpha', n: 1 } });
    assert.equal(editorIn('b'), 0, 'B is hidden: B s request waits');
    await show('b');
    assert.equal(editorIn('b'), 1, 'shown, B takes it');
    await props({ guestHeld: 'blocked' });
    await props({ openRequest: { tab: 'agents', n: 2 }, agentsEditRequest: { serverId: 'b', name: 'alpha', n: 2 } });
    // (B is already on alpha; a held guest must not re-run anything either.)
    await show('a');
    await props({ agentsEditRequest: { serverId: 'a', name: 'alpha', n: 3 }, openRequest: { tab: 'agents', n: 3 } });
    assert.equal(editorIn('a'), 0, 'A is held: A s request waits');
    await props({ guestHeld: '' });
    assert.equal(editorIn('a'), 1, 'free again, A takes it');
  } finally { await app.close(); }
});
