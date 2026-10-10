// The shell a person meets before there is a server (board #335 ②b-1,
// reviewer P1-1 and the orchestrator's ruling, 2026-10-10).
//
// This mounts the REAL App, not a fixture of it, and that is the point: the
// rule is about App's own markup. With no runtime bound the server-bound
// subtree renders nothing, and the two surfaces that belong to the PERSON —
// the Connection card and Preferences — must still be there and still work.
// A fixture of the shell would be my own construction of the thing under
// test, which is how the first version of this hid a real bug: the provider
// was rendering an unbound subtree and the fixture's own guard covered for it.
//
// The transport is mocked, so nothing dials and every RPC a page might make is
// recorded instead. A fresh client must make none: with nothing bound there is
// no page to make one.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from './lib/test/mount.ts';

/** The harness types a mocked module as functions only, and `ADDRESS_LABELS`
 * is a constant the facade exports. Mocked modules are replaced wholesale, so
 * the constant has to travel with them. */
const asModule = (mock: Record<string, unknown>) => mock as Record<string, (...args: any[]) => unknown>;

const compiled = compileMount(new URL('./App.svelte', import.meta.url), [
  new URL('./lib/core/ws.ts', import.meta.url),
  // The real Terminal needs xterm, which this tier does not paint; the stub
  // records the target it was handed, which is exactly what a restore test
  // wants to see (the same strategy as ScratchPanel.mount.test.ts).
  new URL('./lib/terminal/Terminal.svelte', import.meta.url),
]);

/** Records the target at MOUNT only: it does not follow a prop change, so a
 * case that changes the pane afterwards reads the saved record instead. */
const terminalStub = {
  default: (anchor: Comment, props: { target: string }) => {
    const el = anchor.ownerDocument.createElement('div');
    el.className = 'xterm-wrap';
    el.dataset.target = props.target;
    anchor.before(el);
  },
};

function transport(calls: string[]) {
  const rpc = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error('not connected'));
  };
  return {
    connect: rpc('connect'),
    disconnect: () => {},
    isConnected: () => false,
    getMachineId: () => '',
    getHostname: () => '',
    setOnDisconnect: () => {},
    subscribe: () => {}, unsubscribe: () => {}, resubscribeActive: () => {},
    addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
    addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
    findBestAddress: async () => null,
    classifyAddress: () => 0,
    isAddressViable: () => true,
    noteAddressUnreachable: () => {},
    ADDRESS_LABELS: ['LAN', 'Tailscale', 'WAN'],
    hubRooms: rpc('hub_rooms'),
    systemStatus: rpc('system_status'),
    listSessions: rpc('list_sessions'),
    listPanes: rpc('list_panes'),
    backendsList: rpc('backends_list'),
    setSocket: rpc('set_socket'),
  };
}

async function mount(context: TestContext) {
  const calls: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {},
    modules: [asModule(transport(calls)), terminalStub],
    setup(window) {
      // A fresh client: no saved server, no token, nothing parked.
      window.localStorage.clear();
      window.localStorage.setItem('tmux_locale', 'en');
      // jsdom has no canvas, and the font previews draw on one. An
      // environment stub, not a production bypass: nothing under test paints.
      (window as any).HTMLCanvasElement.prototype.getContext = () => new Proxy({
        font: '', measureText: () => ({ width: 0 }),
      } as Record<string, unknown>, {
        get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
        set: (target, prop, value) => { target[prop as string] = value; return true; },
      });
    },
    pendingImports: ['@tauri-apps/'],
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await app.flush(); };
  await settle();
  return { ...app, calls, settle };
}

test('a fresh client sees the Connection card, and its own settings behind the gear', async (context) => {
  const app = await mount(context);

  // The person-level connect surface, with no server at all.
  assert.ok(app.document.querySelector('.card .fields input[type="text"]'),
    'the Connection card rendered');
  // And nothing server-bound: no runtime is bound, so the subtree is empty.
  // (The Connection card's own layer is the person's, outside the subtree.)
  assert.equal(app.document.querySelector('.page-layer:not(.connect-layer)'), null, 'no resident page layer exists');
  assert.equal(app.document.querySelector('.term-page'), null, 'no Terminal page');
  assert.deepEqual(app.calls, [], 'and nothing reached for the wire');

  // The gear is reachable whenever the shell is — including now.
  const gear = app.document.querySelector<HTMLButtonElement>('.gear-btn');
  assert.ok(gear, 'the gear is on screen');
  gear.click();
  await app.settle();

  // Preferences renders with a NULL runtime, because it is the person's.
  const prefs = app.document.querySelector('.page-layer:not(.hidden) .preferences');
  assert.ok(prefs, 'Preferences rendered with no server bound');
  assert.deepEqual(app.calls, [], 'still nothing on the wire');

  // Visible AND usable: the theme is the person's setting, so it changes here
  // with no server in sight.
  const before = app.window.localStorage.getItem('tmux_theme');
  const themes = [...prefs.querySelectorAll<HTMLButtonElement>('[aria-label="Theme"] button')];
  assert.ok(themes.length >= 2, `the theme control is there: ${themes.length} options`);
  const other = themes.find((b) => !b.className.includes('on')) ?? themes[1]!;
  other.click();
  await app.settle();
  const after = app.window.localStorage.getItem('tmux_theme');
  assert.notEqual(after, before, `the setting changed (${before} → ${after})`);
  assert.deepEqual(app.calls, [], 'changing a person-level setting is not a server call');

  // Closing again is the shell's existing prefs toggle (board #155's history
  // dance on touch, the gear on desktop), which this commit does not touch and
  // which its own pins cover; what matters here is that the whole walk never
  // produced a server-bound page or a server call.
  assert.equal(app.document.querySelector('.term-page'), null, 'no Terminal page appeared');
  assert.equal(app.document.querySelector('.preferences ~ .page-layer'), null,
    'and no second layer came up behind it');
  assert.deepEqual(app.calls, [], 'the whole walk touched no server');
});

/** The facade's ONE connection and the api bound to it, which the Single
 * runtime borrows (single-runtime.ts): the same functions, so a call made
 * through the runtime is a call on this transport. */
function withSlot<M extends Record<string, any>>(module: M): M {
  const m = module as Record<string, any>;
  m.compatSlotApi = m;
  m.connection = {
    connect: (url: string, token: string) => m.connect(url, token), disconnect: m.disconnect,
    isConnected: m.isConnected, getMachineId: m.getMachineId, getHostname: m.getHostname,
  };
  return module;
}

/** A transport that can actually connect, as one machine or another. */
function liveTransport(calls: string[], machine: () => string) {
  let connected = false;
  const rpc = (name: string, result: unknown = []) => () => {
    calls.push(name);
    return connected ? Promise.resolve(result) : Promise.reject(new Error('not connected'));
  };
  return withSlot({
    connect: async (url: string) => { calls.push(`connect:${url}`); connected = true; return machine(); },
    disconnect: () => { connected = false; },
    isConnected: () => connected,
    getMachineId: () => (connected ? machine() : ''),
    getHostname: () => (connected ? `${machine()}.host` : ''),
    setOnDisconnect: () => {},
    subscribe: () => {}, unsubscribe: () => {}, resubscribeActive: () => {},
    addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
    addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
    findBestAddress: async () => null,
    classifyAddress: () => 0,
    isAddressViable: () => true,
    noteAddressUnreachable: () => {},
    ADDRESS_LABELS: ['LAN', 'Tailscale', 'WAN'],
    hubRooms: () => { calls.push('hub_rooms'); return Promise.reject(Object.assign(new Error('no hub'), { code: -32601 })); },
    systemStatus: rpc('system_status', {}),
    listSessions: rpc('list_sessions', [{ name: 'work' }]),
    listPanes: rpc('list_panes', [{ session: 'work', window: 1, pane: 0 }]),
    // The desktop layout mounts the session sidebar, which asks for these.
    listSessionsWithPanes: rpc('list_sessions_with_panes', { sessions: [{ name: 'work', panes: [] }] }),
    projectList: rpc('project_list', { projects: [] }),
    backendsList: rpc('backends_list', { backends: [] }),
    setSocket: rpc('set_socket'),
    fsCwd: rpc('fs_cwd', { path: '/home' }),
    fsList: rpc('fs_list', { entries: [] }),
    getPrefs: rpc('get_prefs', {}),
    getBookmarks: rpc('get_bookmarks', { bookmarks: [] }),
  });
}

test('a reconnect to the SAME server through the form keeps the handle and the tree', async (context) => {
  // The ②b promise, through the real form (reviewer P1-2): an ordinary
  // reconnect — the same address, the same machine — must not replace the
  // handle. If it does, the key changes, every always-mounted page is rebuilt,
  // and the state those pages exist to keep is gone, with no leave guard
  // asked. Revoking in `beforeConnect` did exactly that; suspending does not.
  const calls: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {},
    modules: [asModule(liveTransport(calls, () => 'm-a')), terminalStub],
    setup(window) {
      window.localStorage.clear();
      window.localStorage.setItem('tmux_locale', 'en');
      window.localStorage.setItem('tmux_address', 'ws://a:9899');
      window.localStorage.setItem('tmux_token', 'tokA');
      window.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      ]));
      window.localStorage.setItem('tmux_server_current', 'a');
      window.localStorage.setItem('tmux_state', JSON.stringify({ page: 'terminal' }));
      (window as any).HTMLCanvasElement.prototype.getContext = () => new Proxy({
        font: '', measureText: () => ({ width: 0 }),
      } as Record<string, unknown>, {
        get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
        set: (target, prop, value) => { target[prop as string] = value; return true; },
      });
    },
    pendingImports: ['@tauri-apps/'],
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await app.flush(); };
  await settle();

  // The boot connected, so the server-bound subtree is up.
  const termPage = app.document.querySelector('.term-page');
  assert.ok(termPage, `the resident tree mounted: ${calls.join(',')}`);
  const layers = [...app.document.querySelectorAll('.page-layer')];
  assert.ok(layers.length > 0, 'and its page layers exist');

  // Now go through the REAL form. Connected, the only way to it is the one a
  // person has: Settings → Connection → Disconnect, which leaves the resident
  // tree mounted (hidden) and the handle alive, and then the connect card.
  const settings = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  assert.ok(settings, 'the settings entry is on screen');
  settings.click();
  await settle();
  const connection = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')]
    .find((b) => /connection/iu.test(b.textContent ?? ''));
  assert.ok(connection, 'the Connection category is in Preferences');
  connection.click();
  await settle();
  const disconnect = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')]
    .find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()));
  assert.ok(disconnect, 'and it offers Disconnect');
  disconnect.click();
  await settle();
  assert.ok(app.document.querySelector('.card .fields input[type="text"]'), 'the connect card is up');
  assert.equal(app.document.querySelector('.term-page'), termPage,
    'disconnecting alone does not rebuild the tree — the handle is still A s');

  // Submit the same address: the same machine answers, so this is the
  // ordinary reconnect the handle must survive.
  const before = calls.length;
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://a:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  const submit = [...app.document.querySelectorAll<HTMLButtonElement>('.card button')]
    .find((b) => /connect/iu.test(b.textContent ?? ''));
  assert.ok(submit, `the card has a connect button: ${
    [...app.document.querySelectorAll('.card button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  submit.click();
  await settle();
  assert.ok(calls.slice(before).some((c) => c.startsWith('connect:')),
    `the form dialled again: ${calls.slice(before).join(',')}`);

  // Same server, so the SAME tree: the same DOM nodes, never rebuilt. A
  // replaced handle would have changed the key and these would be new objects.
  assert.equal(app.document.querySelector('.term-page'), termPage,
    `the Terminal page was not rebuilt (calls since: ${calls.slice(before).join(',')})`);
  assert.deepEqual([...app.document.querySelectorAll('.page-layer')], layers,
    'and neither was any other resident layer');
});

/** A PRE-#335 record: bare targets, with no server of its own. This is the
 * shape the attribution rules are about — a v2 record names its server, so it
 * cannot tell whether the rules work. `cells` seeds the desktop split, whose
 * cells are the same two bare strings again. */
const legacyNav = (target: string, cells: readonly string[] = []) => JSON.stringify({
  page: 'terminal',
  terminalTarget: target,
  terminalSession: target.split(':')[0],
  ...(cells.length ? {
    splitLayout: cells.length,
    splitCells: cells.map((t, i) => ({ id: i + 1, target: t, session: t.split(':')[0] })),
  } : {}),
});

/** A #335 record, which NAMES its server in every reference it holds. */
const savedNav = (serverId: string, target: string, cells: readonly string[] = []) => JSON.stringify({
  v: 2,
  page: 'terminal',
  pane: { kind: 'pane', serverId, session: target.split(':')[0], target },
  splitLayout: cells.length || 1,
  splitCells: cells.map((t, i) => ({
    id: i + 1, pane: { kind: 'pane', serverId, session: t.split(':')[0], target: t },
  })),
});

/** Which machine answers on `url`, at the `n`th connect (1-based). */
type MachineAt = (url: string, n: number) => string;
const byAddress: MachineAt = (url) => (url.includes('//b') ? 'm-b' : 'm-a');

/** A transport that answers as whichever machine the address belongs to, and
 * that a case can DROP — which is how a failover begins. */
/** Hold a dial before it answers: resolve the returned promise to let it. */
type DialGate = (url: string, n: number) => Promise<void> | null;

function twoServerTransport(calls: string[], machineAt: MachineAt = byAddress, extra: Record<string, unknown> = {}, gate: DialGate = () => null,
  /** What a dial a later one REPLACED does when it is let go: answer anyway
   * (a slow socket's late auth), or fail as `Connection` fails a superseded
   * dial. */
  stale: 'answer' | 'reject' = 'answer') {
  let connected = false;
  let machine = '';
  let dials = 0;
  let onDrop: (() => void) | null = null;
  const rpc = (name: string, result: unknown = []) => () => {
    calls.push(name);
    return connected ? Promise.resolve(result) : Promise.reject(new Error('not connected'));
  };
  const net = {
    /** The socket closed under the app: the reconnect machine takes over. */
    drop() { connected = false; onDrop?.(); },
  };
  const module = {
    connect: async (url: string) => {
      calls.push(`connect:${url}`);
      const n = ++dials;
      const mine = machineAt(url, n);
      const held = gate(url, n);
      if (held) await held;
      if (stale === 'reject' && n !== dials) { calls.push(`superseded:${url}#${n}`); throw new Error('superseded by a newer connect'); }
      calls.push(`answered:${url}#${n}`);
      // A dial a later one replaced still answers, as a slow socket can — but
      // it is not the connection any more, so it changes nothing here.
      if (n === dials) { machine = mine; connected = true; }
      return mine;
    },
    disconnect: () => { connected = false; },
    isConnected: () => connected,
    getMachineId: () => (connected ? machine : ''),
    getHostname: () => (connected ? `${machine || 'anon'}.host` : ''),
    setOnDisconnect: (fn: () => void) => { onDrop = fn; },
    subscribe: () => {}, unsubscribe: () => {}, resubscribeActive: () => {},
    addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
    addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
    addTeamMessageListener: () => {}, removeTeamMessageListener: () => {},
    findBestAddress: async () => null,
    classifyAddress: () => 0,
    isAddressViable: () => true,
    noteAddressUnreachable: () => {},
    ADDRESS_LABELS: ['LAN', 'Tailscale', 'WAN'],
    hubRooms: () => { calls.push('hub_rooms'); return Promise.reject(Object.assign(new Error('no hub'), { code: -32601 })); },
    systemStatus: rpc('system_status', {}),
    // The session the saved panes name exists on both servers, which is the
    // whole point: a name alone cannot tell them apart.
    listSessions: rpc('list_sessions', [{ name: 'work' }]),
    listPanes: rpc('list_panes', [{ session: 'work', window: 1, pane: 0 }]),
    // The desktop layout mounts the session sidebar, which asks for these.
    // `other` is a session a case can OPEN from the sidebar, which is how a
    // person changes the navigation the shell then has to save.
    listSessionsWithPanes: rpc('list_sessions_with_panes', {
      sessions: [{ name: 'work', windows: 1 }, { name: 'other', windows: 1 }],
      panes: [{ session: 'work', window: 1, pane: 0 }, { session: 'other', window: 3, pane: 0 }],
    }),
    projectList: rpc('project_list', { projects: [] }),
    backendsList: rpc('backends_list', { backends: [] }),
    setSocket: rpc('set_socket'),
    fsCwd: rpc('fs_cwd', { path: '/home' }),
    fsList: rpc('fs_list', { entries: [] }),
    getPrefs: rpc('get_prefs', {}),
    getBookmarks: rpc('get_bookmarks', { bookmarks: [] }),
    ...extra,
  };
  return { module: withSlot(module), net };
}

/** The app booted on a seeded storage, with the transport mocked: ONE harness,
 * and each case says what the client wakes up with. */
async function bootApp(
  context: TestContext, seed: Record<string, string>, machineAt?: MachineAt,
  more: { rpc?: Record<string, unknown>; setup?: (window: any) => void; calls?: string[]; gate?: DialGate; stale?: 'answer' | 'reject' } = {},
) {
  const calls: string[] = more.calls ?? [];
  const transport = twoServerTransport(calls, machineAt, more.rpc, more.gate, more.stale);
  const app = await (await compiled).mount(context, {
    props: {},
    modules: [asModule(transport.module), terminalStub],
    setup(window) {
      window.localStorage.clear();
      window.localStorage.setItem('tmux_locale', 'en');
      for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
      more.setup?.(window);
      (window as any).HTMLCanvasElement.prototype.getContext = () => new Proxy({
        font: '', measureText: () => ({ width: 0 }),
      } as Record<string, unknown>, {
        get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
        set: (target, prop, value) => { target[prop as string] = value; return true; },
      });
    },
    // The editor's highlighter loads lazily; this tier cannot paint it.
    pendingImports: ['@tauri-apps/', 'highlight.js/'],
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await app.flush(); };
  await settle();

  /** What the shell restored, seen twice over: the target the Terminal was
   * actually handed, and the record the shell saves back. */
  const onScreen = () =>
    app.document.querySelector<HTMLElement>('.term-main .xterm-wrap')?.dataset.target ?? 'none';
  // The CURRENT server's own slot: where its navigation lives since board
  // #335 ②b-4. (The seeds are pre-#335 fixtures — a live record and parked
  // slots — which the boot's fold turns into exactly this.)
  const record = () => {
    const id = app.window.localStorage.getItem('tmux_server_current');
    return JSON.parse((id && app.window.localStorage.getItem(`tmux_state::${id}`)) || 'null');
  };
  const restored = () => {
    const pane = record()?.pane ?? null;
    return pane ? `${pane.serverId}:${pane.target}` : 'none';
  };
  /** The split as it stands on screen: the cell's own id, and the target the
   * Terminal in it was handed. */
  const cellsOnScreen = () => [...app.document.querySelectorAll<HTMLElement>('.split-grid .cell')]
    .map((c) => `${c.dataset.cellId}:${c.querySelector<HTMLElement>('.xterm-wrap')?.dataset.target ?? ''}`);
  /** Switch through the real switcher: Settings → Connection → the row. */
  const switchTo = async (name: string) => {
    const entry = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
    assert.ok(entry, `an entry into Settings exists: ${
      [...app.document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent?.trim()).join(' | ')}`);
    entry.click();
    await settle();
    const connection = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')]
      .find((b) => /connection/iu.test(b.textContent ?? ''));
    connection!.click();
    await settle();
    const row = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')]
      .find((b) => new RegExp(`^${name}\\b`, 'iu').test((b.textContent ?? '').trim()));
    assert.ok(row, `the switcher offers ${name}: ${
      [...app.document.querySelectorAll('.preferences button')].map((b) => b.textContent?.trim()).join(' | ')}`);
    row.click();
    await settle();
    await settle();
  };
  /** Open the session `name` from the Terminal page's sidebar: a person
   * changing the navigation. */
  const openSession = async (name: string) => {
    const tab = [...app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
      .find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
    assert.ok(tab, `the Terminal tab is on screen: ${
      [...app.document.querySelectorAll('.rail-btn, .tabbar button')].map((b) => b.getAttribute('aria-label')).join(' | ')}`);
    tab.click();
    await settle();
    const row = [...app.document.querySelectorAll<HTMLElement>('.session-row')]
      .find((r) => r.querySelector('.name')?.textContent?.trim() === name);
    assert.ok(row, `the sidebar lists ${name}: ${
      [...app.document.querySelectorAll('.session-row .name')].map((n) => n.textContent).join(' | ')}`);
    row.click();
    await settle();
  };
  /** Disconnect through Settings, then connect again through the card. */
  const reconnectThroughForm = async (address: string) => {
    const gear = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
    gear!.click();
    await settle();
    [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')]
      .find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
    await settle();
    [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')]
      .find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
    await settle();
    const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
    field.value = address;
    field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await settle();
    [...app.document.querySelectorAll<HTMLButtonElement>('.card button')]
      .find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
    await settle();
    await settle();
  };
  return { app, calls, settle, onScreen, record, restored, cellsOnScreen, switchTo, openSession, reconnectThroughForm, net: transport.net };
}

/** Two named servers on two machines, the app current on A. */
const twoServers = (nav: { live: string; parked: string }) => ({
  tmux_servers: JSON.stringify([
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
  ]),
  tmux_server_current: 'a',
  tmux_address: 'ws://a:9899',
  tmux_token: 'tokA',
  tmux_machine_id: 'm-a',
  tmux_state: nav.live,
  'tmux_state::b': nav.parked,
});

const twoServerApp = (context: TestContext, nav: { live: string; parked: string }) =>
  bootApp(context, twoServers({ live: legacyNav(nav.live), parked: legacyNav(nav.parked) }));

test('A→B→A through the switcher restores each server s own navigation', async (context) => {
  // The regression that would have caught P1-a (reviewer, 2026-10-10): the
  // restore used to run in the swap's gap, where nothing is shown, so every
  // saved pane was filtered out as belonging to "no server" — and an ordinary
  // round trip lost both sides' layout. Two servers, each with a saved pane on
  // a session of the SAME name. Both records are v1, so each one's owner has
  // to be WORKED OUT: A's from what CURRENT said at boot, B's from the fact
  // that arriving at B is what put its bytes in the live key.
  const { calls, onScreen, restored, switchTo, app } =
    await twoServerApp(context, { live: 'work:1.0', parked: 'work:2.0' });

  assert.equal(onScreen(), 'work:1.0', `boot put A s pane on screen: ${calls.join(',')}`);
  assert.equal(restored(), 'a:work:1.0', 'and saved it as A s');

  await switchTo('beta');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'the switch arrived');
  assert.equal(onScreen(), 'work:2.0', 'B came up on B s own pane, not on nothing');
  assert.equal(restored(), 'b:work:2.0', 'and saved it as B s');
  const parkedA = JSON.parse(app.window.localStorage.getItem('tmux_state::a')!);
  assert.equal(parkedA.pane?.target ?? parkedA.terminalTarget, 'work:1.0',
    'and A s record was parked, not lost');

  await switchTo('alpha');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a');
  assert.equal(onScreen(), 'work:1.0', 'and coming back puts A s pane up again');
  assert.equal(restored(), 'a:work:1.0', 'saved as A s, not as B s');
});

test('two servers can hold the SAME legacy bytes, and each one is still its own', async (context) => {
  // The orchestrator's P1 (2026-10-10): provenance cannot be derived by
  // comparing the live record with the one read at boot, because `work:1.0`
  // on A is byte-identical to `work:1.0` on B. Under that rule B's record
  // "looked like" A's, so arriving at B was read as still showing A's
  // navigation — B's pane was filtered out of its own restore and the record
  // A came back to was B's write. Here the two records are the same bytes
  // from the start; only WHERE each was read can tell them apart.
  const { onScreen, restored, switchTo, app } =
    await twoServerApp(context, { live: 'work:1.0', parked: 'work:1.0' });

  assert.equal(restored(), 'a:work:1.0', 'at boot the record is the one CURRENT names');

  await switchTo('beta');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b');
  assert.equal(onScreen(), 'work:1.0', 'B restores its own identical record');
  assert.equal(restored(), 'b:work:1.0', 'and it is B s, by where it was read — not by its bytes');

  await switchTo('alpha');
  assert.equal(restored(), 'a:work:1.0', 'and A s is A s again');
});

test('a split comes back whole, and every cell of it names its own server', async (context) => {
  // The round trip has to cover the SPLIT, not just the top pane (reviewer
  // P2-b, 2026-10-10): the cells are the second half of what a desktop client
  // comes back to, and they are the references most easily filtered away,
  // being one per cell. Desktop mode, because a split is restored only on a
  // client that can show one.
  const { onScreen, record, cellsOnScreen, switchTo, app } = await bootApp(context, {
    ...twoServers({
      live: legacyNav('work:1.0', ['work:1.0', 'work:2.0']),
      parked: legacyNav('work:9.0'),
    }),
    tmux_layout_mode: 'desktop',
  });

  assert.equal(onScreen(), 'work:1.0');
  assert.deepEqual(cellsOnScreen(), ['1:work:1.0', '2:work:2.0'], 'both cells came up with their panes');
  assert.equal(record().splitLayout, 2, 'and the record keeps the layout');
  assert.deepEqual(record().splitCells.map((c: any) => `${c.id}:${c.pane?.serverId}:${c.pane?.target}`),
    ['1:a:work:1.0', '2:a:work:2.0'], 'every cell is A s, by its own reference');

  await switchTo('beta');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b');
  assert.equal(onScreen(), 'work:9.0', 'B has no split of its own');
  assert.equal(record().splitLayout, 1);
  const parkedA = JSON.parse(app.window.localStorage.getItem('tmux_state::a')!);
  assert.equal(parkedA.splitLayout, 2, 'A s split is in its own slot, whole');

  await switchTo('alpha');
  assert.equal(onScreen(), 'work:1.0');
  assert.deepEqual(cellsOnScreen(), ['1:work:1.0', '2:work:2.0'], 'and A s split came back whole');
  assert.deepEqual(record().splitCells.map((c: any) => `${c.id}:${c.pane?.serverId}:${c.pane?.target}`),
    ['1:a:work:1.0', '2:a:work:2.0'], 'still A s, with the same cell ids');
});

/** The shape identity repair merges: the entry the app is CURRENT on knows
 * only an address, and the machine it reaches is already saved under another
 * entry. `recordServer` folds the first into the second and deletes it. */
const aliasAndCanonical = (nav: string) => ({
  tmux_servers: JSON.stringify([
    { id: 'alias', name: 'home', address: 'ws://a:9899', token: 'tok', named: true },
    { id: 'canon', name: 'canonical', address: 'ws://b:9899', token: 'tok', machineId: 'm-a', named: true },
  ]),
  tmux_server_current: 'alias',
  tmux_address: 'ws://a:9899',
  tmux_token: 'tok',
  tmux_state: nav,
});

test('the entry the app was on is absorbed, and its navigation comes with it', async (context) => {
  // reviewer P1, 2026-10-10. Dialling the alias authenticates as m-a, which
  // the canonical entry already claims, so `recordServer` updates that entry
  // and ABSORBS the alias: the alias is deleted and CURRENT moves to the
  // canonical id. The provenance of the legacy record was still the alias, so
  // the restore filtered out every pane of the machine we had just connected
  // to — and then saved that emptiness over it. Before #335 the same record
  // had no server in it and was simply restored, which is what makes this a
  // Single-mode regression.
  const { onScreen, restored, app, calls } =
    await bootApp(context, aliasAndCanonical(legacyNav('work:1.0', ['work:1.0', 'work:2.0'])));

  const ids = JSON.parse(app.window.localStorage.getItem('tmux_servers')!).map((s: any) => s.id);
  assert.deepEqual(ids, ['canon'], `the alias was absorbed: ${JSON.stringify(ids)}`);
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'and CURRENT moved');
  assert.equal(onScreen(), 'work:1.0', `the navigation came with it: ${calls.join(',')}`);
  assert.equal(restored(), 'canon:work:1.0', 'and it is the survivor s now');
});

test('a v2 record written by the absorbed entry is rebound, not dropped', async (context) => {
  // The same merge, one boot later: the record is already v2 and NAMES the
  // alias, an id no entry claims any more. Attribution cannot save it — a v2
  // record carries its own server — so the references themselves are rebound
  // to the survivor.
  const { onScreen, record, restored } = await bootApp(context, {
    ...aliasAndCanonical(savedNav('alias', 'work:1.0', ['work:1.0', 'work:2.0'])),
    tmux_layout_mode: 'desktop',
  });

  assert.equal(onScreen(), 'work:1.0');
  assert.equal(restored(), 'canon:work:1.0');
  assert.deepEqual(record().splitCells.map((c: any) => c.pane?.serverId), ['canon', 'canon'],
    'every cell followed the merge');
});

test('an id nothing shows to be merged is not handed to the current server', async (context) => {
  // reviewer P1-a, 2026-10-10. No merge happens here at all: the registry
  // holds only B, and the record names A — forgotten, or a server this client
  // never saved. Treating "absent" as "absorbed into whoever is current"
  // rewrote it to B and opened B's same-named `work:1.0`: a stranger's pane.
  // It is another server's record, and the restore filters it out.
  const { onScreen, restored, app } = await bootApp(context, {
    tmux_servers: JSON.stringify([
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    ]),
    tmux_server_current: 'b',
    tmux_address: 'ws://b:9899',
    tmux_token: 'tokB',
    tmux_machine_id: 'm-b',
    tmux_state: savedNav('a', 'work:1.0'),
  });
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b');
  assert.equal(onScreen(), 'none', 'B did not open A s pane by its name');
  assert.notEqual(restored(), 'b:work:1.0', 'and the record was not re-filed under B');
});

test('a real merge moves only the merged ids: a third server s ref stays its own', async (context) => {
  // The other half of P1-a: the alias IS absorbed into the canonical entry,
  // and the record also holds a cell naming C, which nobody merged. The
  // alias's refs follow the merge; C's must not ride along with it.
  const { record, cellsOnScreen, onScreen } = await bootApp(context, {
    ...aliasAndCanonical(JSON.stringify({
      v: 2, page: 'terminal',
      pane: { kind: 'pane', serverId: 'alias', session: 'work', target: 'work:1.0' },
      splitLayout: 2,
      splitCells: [
        { id: 1, pane: { kind: 'pane', serverId: 'alias', session: 'work', target: 'work:1.0' } },
        { id: 2, pane: { kind: 'pane', serverId: 'c', session: 'work', target: 'work:2.0' } },
      ],
    })),
    tmux_layout_mode: 'desktop',
  });
  assert.equal(onScreen(), 'work:1.0', 'the alias s pane followed the merge');
  assert.deepEqual(cellsOnScreen(), ['1:work:1.0', '2:'], 'C s cell was not opened on the survivor');
  assert.deepEqual(record().splitCells.map((c: any) => c.pane?.serverId ?? null), ['canon', null],
    'and nothing of C was re-filed under the survivor');
});

/** The alias's machine answers WITHOUT an id on the first connect, so boot
 * cannot merge; it reports itself on the next one, and THAT connect absorbs
 * the alias. Which connect it is is the case's whole point. */
const learnsItsMachineLater: MachineAt = (_url, n) => (n === 1 ? '' : 'm-a');

test('a merge on the connect page s same-server return keeps saving', async (context) => {
  // reviewer P1-b, 2026-10-10. `activateConnected` absorbs the alias and
  // finds the survivor already CURRENT, so it reports `reload: false` and
  // the app takes the same-server path: the handle is replaced, the refs are
  // rebound — and the save gate, opened only by a restore, stayed shut on the
  // replaced handle. The pane on screen was right, and nothing after it was
  // ever saved.
  const { app, restored, openSession, reconnectThroughForm } =
    await bootApp(context, { ...aliasAndCanonical(legacyNav('work:1.0')), tmux_layout_mode: 'desktop' }, learnsItsMachineLater);
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'alias', 'boot could not merge');
  assert.equal(restored(), 'alias:work:1.0');

  await reconnectThroughForm('ws://a:9899');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the form s connect absorbed it');
  assert.equal(restored(), 'canon:work:1.0', 'the navigation followed, and was saved as the survivor s');

  await openSession('other');
  assert.equal(restored(), 'canon:other:3.0', 'and what the person does next is saved too');
});

test('a merge on a failover keeps saving', async (context) => {
  // The same contract on the reconnect machine's success path: the socket
  // drops, the retry reaches the same machine and is the first connect to
  // report its id, so `recordServer` absorbs the alias there.
  const { app, onScreen, restored, openSession, settle, net } =
    await bootApp(context, { ...aliasAndCanonical(legacyNav('work:1.0')), tmux_layout_mode: 'desktop' }, learnsItsMachineLater);
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'alias');

  net.drop();
  await settle();
  await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the failover absorbed it');
  assert.equal(onScreen(), 'work:1.0', 'the pane on screen is the same machine s');
  assert.equal(restored(), 'canon:work:1.0', 'and it was saved as the survivor s');

  await openSession('other');
  assert.equal(restored(), 'canon:other:3.0', 'and so is what comes after it');
});

test('a same-machine merge keeps a download in flight, and the next switch aborts it before dialling', async (context) => {
  // reviewer P1 on bdac94bd. The alias's Files record — rows, browse
  // positions, and the attempt table — was replaced by a fresh one when
  // identity repair folded the alias into its canonical entry, so the attempt
  // already running outlived every component that knew about it. A later
  // switch to another server suspended only the new, empty record, and the
  // orphan kept going over whatever the socket reached next.
  // ONE ordered trace: the transport writes its dials into it, the transfer
  // its start and its stop, so "stopped BEFORE the next server was dialled"
  // is an order in a list rather than two separate facts.
  const events: string[] = [];
  const machineAt: MachineAt = (url, n) => (url.includes('//c') ? 'm-c' : n === 1 ? '' : 'm-a');
  const { app, settle, switchTo, reconnectThroughForm } = await bootApp(context, {
    ...aliasAndCanonical(legacyNav('work:1.0')),
    tmux_servers: JSON.stringify([
      { id: 'alias', name: 'home', address: 'ws://a:9899', token: 'tok', named: true },
      { id: 'canon', name: 'canonical', address: 'ws://b:9899', token: 'tok', machineId: 'm-a', named: true },
      { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
    ]),
  }, machineAt, {
    calls: events,
    rpc: {
      fsList: async () => ({ path: '/home', entries: [{ name: 'big.bin', path: '/home/big.bin', type: 'file', size: 9e9 }] }),
      fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 9e9 }),
      fsDownloadHttp: async () => ({ url: 'https://a/dl?path=%2Fhome%2Fbig.bin&sig=s' }),
      gitCmd: async () => ({ code: 1, stdout: '' }),
    },
    setup(window) {
      // A transfer that never finishes on its own: it ends only when its
      // signal says so, and records WHY — which is the observable that a
      // suspend reached it.
      window.fetch = (_url: string, init: { signal?: AbortSignal } = {}) => new window.Promise((_resolve: unknown, reject: (e: unknown) => void) => {
        events.push('fetch');
        init.signal?.addEventListener('abort', () => { events.push('aborted'); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    },
  });
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^files$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  assert.ok(files, 'the Files tab is on screen');
  files.click();
  await settle();
  const download = app.document.querySelector<HTMLButtonElement>('button[aria-label="Download: big.bin"]');
  assert.ok(download, `Files offers the download: ${[...app.document.querySelectorAll('.files-page button[aria-label]')].map((b) => b.getAttribute('aria-label')).join(' | ')}`);
  download.click();
  await settle();
  const transfer = () => events.filter((e) => e === 'fetch' || e === 'aborted' || e.startsWith('connect:'));
  assert.deepEqual(transfer(), ['connect:ws://a:9899', 'fetch'], 'the transfer is running');

  await reconnectThroughForm('ws://a:9899');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the reconnect absorbed the alias');
  assert.deepEqual(transfer(), ['connect:ws://a:9899', 'fetch', 'connect:ws://a:9899'],
    'a same-machine merge does not stop it: it is still this machine s download');

  await switchTo('charlie');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'c', 'the switch arrived');
  assert.deepEqual(transfer(), ['connect:ws://a:9899', 'fetch', 'connect:ws://a:9899', 'aborted', 'connect:ws://c:9899'],
    'and the switch away from it aborted it — before the next server was dialled');
  // What this trace proves is ABORT before dial. That the attempt also
  // SETTLED before the dial is `memory.suspend`'s own await chain (its unit
  // tests), not something this stub can show: it rejects the moment it is
  // aborted (reviewer P2, 2026-10-10).
});

test('a capability answer lands only for the runtime still bound (board #335 ②b-2-2)', async (context) => {
  // The handshake is the runtime's now. A's Hub probe is still in flight when
  // the switch takes the app to B, which has no Hub; A's late "yes" must not
  // put a Hub bell on B's shell.
  const events: string[] = [];
  const answer: { a: (() => void) | null } = { a: null };
  const { app, switchTo } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, {
    calls: events,
    rpc: {
      hubRooms: () => {
        const on = events.filter((e) => e.startsWith('connect:')).at(-1) ?? '';
        if (on.includes('//a')) return new Promise((resolve) => { answer.a = () => resolve({ rooms: {} }); });
        return Promise.reject(Object.assign(new Error('no hub'), { code: -32601 }));
      },
    },
  });
  const bell = () => !!app.document.querySelector('.rail-bell');
  assert.equal(bell(), false, 'A has not answered yet');
  await switchTo('beta');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b');
  assert.equal(bell(), false, 'B answered: no Hub');
  assert.ok(answer.a, 'A was asked');
  answer.a();
  for (let i = 0; i < 10; i++) await app.flush();
  assert.equal(bell(), false, 'and A s late answer did not land on B');
  // Which guard holds this: the runtime's own. A's handle was detached by
  // the switch, and a detached runtime drops its answers; App's two checks
  // (the intent, the bound runtime) are the second line, held by source pins
  // — a negative control removing them both leaves this case green.
});

test('the handshake reaches the shell: a Hub server gets its bell', async (context) => {
  const { app } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, { rpc: { hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }), hubAgents: async () => ({ agents: [] }), registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }), hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }) } });
  assert.equal(!!app.document.querySelector('.rail-bell'), true);
});

test('a Hub probe that fails without an answer leaves the Hub page where it is', async (context) => {
  // Only a definitive "no Hub" (method not found) may flip the flag: false
  // redirects the Hub page to Terminal and unmounts the always-mounted Hub, so
  // a timeout must not be read as one.
  const { record } = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: legacyNav('work:2.0') }),
  }, undefined, { rpc: { hubRooms: () => Promise.reject(new Error('rpc timeout')) } });
  assert.equal(record()?.page, 'hub', 'still on the Hub: nothing said it is not there');
});

test('the boot dial is the bound runtime s, and records the machine it reached (board #335 ②b-2-2)', async (context) => {
  // The runtime dials the route the reader names (the mirror, for the
  // server the app is on) and records identity itself: the address-only
  // alias learns its machine and is folded into the canonical entry by the
  // dial, before bringUp runs.
  const events: string[] = [];
  const { app, onScreen } = await bootApp(context, aliasAndCanonical(legacyNav('work:1.0')), undefined, { calls: events });
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://a:9899'], 'one dial, to the mirror s address');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the dial folded the alias');
  assert.equal(onScreen(), 'work:1.0', 'and the app came up on that machine s navigation');
});

test('a boot dial that reaches ANOTHER known machine arrives there; it never binds A over B s socket', async (context) => {
  // reviewer P1-a on cc5e517e. A and B are both known machines, and the
  // address saved for A answers as B. recordServer keeps both entries, so
  // CURRENT still names A — and bringing the app up there rebuilt A's runtime
  // over B's socket. The socket is B's: the app arrives at B.
  const { app, onScreen, restored } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url) => (url.includes('//a') ? 'm-b' : 'm-b'));
  const servers = JSON.parse(app.window.localStorage.getItem('tmux_servers')!);
  assert.deepEqual(servers.map((e: any) => `${e.id}:${e.machineId}`), ['a:m-a', 'b:m-b'], 'both entries stay, A s identity untouched');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'the app is on B');
  assert.equal(onScreen(), 'work:2.0', 'with B s own navigation');
  assert.equal(restored(), 'b:work:2.0');
  const parkedA = JSON.parse(app.window.localStorage.getItem('tmux_state::a')!);
  assert.equal(parkedA.pane?.target ?? parkedA.terminalTarget, 'work:1.0', 'and A s is in its own slot, not lost');
});

test('a boot dial that answers after the connect form took the socket records nothing and brings nothing up', async (context) => {
  // reviewer P1-b on cc5e517e. The boot dial D1 is still out when the person
  // connects through the card (D2). D1 then answers — as a machine nobody
  // saved, so ANY identity write would show as a new entry, and any bringUp
  // as the app moving off D2's server.
  const events: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { app, settle, onScreen } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 1 ? 'm-x' : url.includes('//b') ? 'm-b' : 'm-a'),
    { calls: events, gate: (_url, n) => (n === 1 ? held : null) });
  // The boot gives a slow dial five seconds, then shows the connect page —
  // which is where a person types a different address.
  await app.advance(5000); await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]');
  assert.ok(field, 'the connect card is up while the boot dial is still out');
  field.value = 'ws://b:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle(); await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'D2 arrived at B');
  const before = app.window.localStorage.getItem('tmux_servers');

  release();
  await settle(); await settle();
  assert.ok(events.includes('answered:ws://a:9899#1'), 'D1 did answer, late');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), before, 'and recorded nothing — no entry for m-x, no address moved');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'nothing brought A back up');
  assert.equal(onScreen(), 'work:2.0', 'the app is still on B s navigation');
});

test('the Hub shows when its own probe answers, not after a slow backends list', async (context) => {
  // reviewer P2 on cc5e517e: Promise.all held the Hub behind backends_list.
  let release: () => void = () => {};
  const slow = new Promise<{ backends: never[] }>((resolve) => { release = () => resolve({ backends: [] }); });
  const { app, settle } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, { rpc: {
    hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }),
    hubAgents: async () => ({ agents: [] }), registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }),
    hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
    backendsList: () => slow,
  } });
  assert.equal(!!app.document.querySelector('.rail-bell'), true, 'the Hub is up while backends_list is still out');
  release(); await settle();
});

test('a late boot dial records nothing after a SAME-server reconnect through the card either', async (context) => {
  // The case where the runtime's own check is the only guard: the form
  // reconnects to A's own address, so the handle is suspended and RESUMED,
  // not ended, and is still alive when the boot dial answers. Without the
  // host's claim the runtime would record that stale answer.
  const events: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { app, settle } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (_url, n) => (n === 1 ? 'm-x' : 'm-a'),
    { calls: events, gate: (_url, n) => (n === 1 ? held : null) });
  await app.advance(5000); await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://a:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle(); await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a', 'the form reconnected A');
  const before = app.window.localStorage.getItem('tmux_servers');
  release();
  await settle(); await settle();
  assert.ok(events.includes('answered:ws://a:9899#1'), 'the boot dial did answer, late');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), before, 'and recorded no machine nobody dialled for');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a');
});

test('a reconnect attempt the connect form took over does nothing when it answers late (reviewer P1 on c5487bef)', async (context) => {
  // The boot dial fails and the connect card is up. Coming back to the app
  // (a visibility resume) starts the reconnect loop: R1 is out. The person
  // then connects through the card (D2, to B) — the form does NOT cancel the
  // loop; only the handover can tell R1 it has lost the socket. R1 answers
  // while D2 is still authenticating, as a machine nobody saved, so any
  // identity write shows; no retry may take D2's socket either.
  const events: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let releaseForm: () => void = () => {};
  const formHeld = new Promise<void>((resolve) => { releaseForm = resolve; });
  const { app, settle, onScreen } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 2 ? 'm-x' : url.includes('//b') ? 'm-b' : 'm-a'),
    { calls: events, gate: (_url, n) => (n === 1 ? Promise.reject(new Error('refused')) : n === 2 ? held : n === 3 ? formHeld : null), stale: 'reject' });
  await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]');
  assert.ok(field, 'the boot failed: the connect card is up');
  app.document.dispatchEvent(new app.window.Event('visibilitychange'));
  await settle();
  assert.ok(events.includes('connect:ws://a:9899') && events.filter((e) => e.startsWith('connect:')).length === 2, `R1 is out: ${events.filter((e) => e.startsWith('connect:')).join(',')}`);
  field.value = 'ws://b:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle();
  assert.ok(events.includes('connect:ws://b:9899'), 'D2 is out');
  const before = app.window.localStorage.getItem('tmux_servers');
  const dials = events.filter((e) => e.startsWith('connect:')).length;
  release();
  await settle(); await app.advance(10_000); await settle();
  assert.ok(events.includes('superseded:ws://a:9899#2'), 'R1 came back — failed, as a dial a newer connect replaced does');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), before, 'and recorded nothing');
  assert.equal(events.filter((e) => e.startsWith('connect:')).length, dials, 'and no retry took D2 s socket');
  releaseForm();
  await settle(); await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'D2 arrived at B');
  assert.equal(onScreen(), 'work:2.0');
});

test('a reconnect that takes over a suspended form leaves the handle working (reviewer P1 on c5487bef)', async (context) => {
  // The form suspends A's handle for its attempt; the reconnect loop then
  // takes the socket, reaches A again, and succeeds. The handle must be
  // usable afterwards — a suspended one refuses every call for good.
  const events: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { app, settle, net, openSession, restored } = await bootApp(context,
    { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, { calls: events, gate: (_url, n) => (n === 2 ? held : null) });
  // The form's dial (n = 2) hangs, with A's handle suspended for it.
  const gear = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  gear!.click(); await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://a:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle();
  // Now the reconnect loop takes the socket (n = 3) and reaches A.
  const since = events.length;
  net.drop();
  await settle(); await settle();
  release(); await settle(); await settle();
  // The handle works: the success's capability probe goes out THROUGH the
  // runtime's api, which a suspended handle refuses before the transport.
  assert.ok(events.slice(since).includes('hub_rooms'), `the runtime s api reached the transport: ${events.slice(since).join(',')}`);
  await openSession('other');
  assert.equal(restored(), 'a:other:3.0');
});

test('a connect to another server through the card asks an unsaved editor first (reviewer P1-c on 0b8b9038)', async (context) => {
  // A has a dirty Files editor; the person disconnects (the tree stays) and
  // connects to B through the card. B would destroy A's tree, so A's editor
  // asks in its own dialog BEFORE anything is dialled; "keep editing" means
  // nothing happens at all.
  const events: string[] = [];
  const { app, settle } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, {
      calls: events,
      rpc: {
        fsList: async () => ({ path: '/home', entries: [{ name: 'notes.md', path: '/home/notes.md', type: 'file', size: 10 }] }),
        fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 10, mime_hint: 'text/markdown' }),
        fsRead: async () => ({ content: '# notes' }),
        gitCmd: async () => ({ code: 1, stdout: '' }),
        setPref: async () => ({}), saveBookmarks: async () => ({}),
      },
    });
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^files$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  files!.click(); await settle();
  app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle();
  app.document.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click(); await settle();
  const area = app.document.querySelector<HTMLTextAreaElement>('.editor-layer textarea')!;
  area.value = '# notes\n\nunsaved'; area.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle();

  const gear = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  gear!.click(); await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://b:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  const dials = events.filter((e) => e.startsWith('connect:')).length;
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle();
  const dialog = app.document.querySelector('[role=alertdialog]');
  assert.ok(dialog, 'the editor s own discard confirmation is asked');
  assert.equal(events.filter((e) => e.startsWith('connect:')).length, dials, 'and nothing was dialled yet');
  [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /keep editing/iu.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!.click();
  await settle(); await settle();
  assert.equal(events.filter((e) => e.startsWith('connect:')).length, dials, 'keep editing: no dial at all');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a');
  assert.equal(area.isConnected && area.value, '# notes\n\nunsaved', 'and the text is still there');
});

test('a failed switch s Back that discovers a merge can still start a download (reviewer P1-b on 0b8b9038)', async (context) => {
  // The switch to C releases the alias's state (sealed for good) on the way
  // out; C fails; Back reconnects the alias, and that authentication is the
  // first to report its machine, so the alias is absorbed into canonical. A
  // sealed state handed to the canonical runtime could never start a
  // download again.
  const events: string[] = [];
  const machineAt: MachineAt = (url, n) => (url.includes('//c') ? '' : n === 1 ? '' : 'm-a');
  const { app, settle, switchTo } = await bootApp(context, {
    ...aliasAndCanonical(legacyNav('work:1.0')),
    tmux_servers: JSON.stringify([
      { id: 'alias', name: 'home', address: 'ws://a:9899', token: 'tok', named: true },
      { id: 'canon', name: 'canonical', address: 'ws://b:9899', token: 'tok', machineId: 'm-a', named: true },
      { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
    ]),
  }, machineAt, {
    calls: events,
    gate: (url) => (url.includes('//c') ? Promise.reject(new Error('refused')) : null),
    rpc: {
      fsList: async () => { events.push('fs_list'); return { path: '/home', entries: [{ name: 'big.bin', path: '/home/big.bin', type: 'file', size: 9e9 }] }; },
      fsCwd: async () => { events.push('fs_cwd'); return { path: '/home' }; },
      fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 9e9 }),
      fsDownloadHttp: async () => { events.push('fs_download_http'); return { url: 'https://a/dl?path=x&sig=s' }; },
      gitCmd: async () => ({ code: 1, stdout: '' }),
    },
    setup(window) { window.fetch = () => new window.Promise(() => {}); },
  });
  await switchTo('charlie');
  const back = [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^back to/iu.test((b.textContent ?? '').trim()));
  assert.ok(back, `the switch failed and offers Back: ${[...app.document.querySelectorAll('.switch-panel button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  back.click();
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'Back absorbed the alias');
  // Files is one tab away; the page slide from the switch's return ends first.
  await app.advance(1000);
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button')]
    .find((b) => /^files$/iu.test((b.textContent ?? '').trim()));
  assert.ok(files, 'the Files tab');
  files.click(); await settle(); await settle();
  const download = app.document.querySelector<HTMLButtonElement>('button[aria-label="Download: big.bin"]');
  assert.ok(download, 'Files offers the download');
  download.click(); await settle();
  assert.ok(events.includes('fs_download_http'), 'and the download started: the canonical runtime s record is not sealed');
});

test('a reconnect that reaches ANOTHER known machine arrives there; A s api never resumes over B s socket (reviewer P1-b on 372cb4af)', async (context) => {
  // A was connected; the socket drops and the retry to A's address answers
  // as known B. Both entries stay, CURRENT still names A — and "CURRENT did
  // not move" used to read as "the same server", resuming A's handle on B.
  const events: string[] = [];
  const { app, settle, net, onScreen, restored } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events });
  assert.equal(onScreen(), 'work:1.0');
  net.drop();
  await settle(); await settle(); await settle();
  const servers = JSON.parse(app.window.localStorage.getItem('tmux_servers')!);
  assert.deepEqual(servers.map((e: any) => `${e.id}:${e.machineId}`), ['a:m-a', 'b:m-b'], 'both stay, A s identity untouched');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'the app is on B');
  assert.equal(onScreen(), 'work:2.0', 'with B s navigation');
  assert.equal(restored(), 'b:work:2.0');
  const parkedA = JSON.parse(app.window.localStorage.getItem('tmux_state::a')!);
  assert.equal(parkedA.pane?.target ?? parkedA.terminalTarget, 'work:1.0', 'and A s is in its own slot');
});

test('a reconnect whose identity cannot be recorded is not a same-server success', async (context) => {
  // The peer authenticated, and writing the registry failed: nobody knows
  // which server this is, so the handle keeps refusing and the person is
  // told — the connect form's rule.
  const { app, settle, net } = await bootApp(context,
    twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }));
  const setItem = app.window.Storage.prototype.setItem;
  app.window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    if (k === 'tmux_servers') throw new Error('QuotaExceededError');
    return setItem.call(this, k, v);
  };
  net.drop();
  await settle(); await settle(); await settle();
  app.window.Storage.prototype.setItem = setItem;
  const error = app.document.querySelector('.card .error');
  assert.match(error?.textContent ?? '', /could not be identified/iu, 'the person is told on the connect page');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a', 'nothing moved');
});

// ── Board #335 ②b-2-3, reviewer's G1/G2 on 48b40082 (and the 18:54 addition).

/** A Files editor on A with unsaved text in it. */
const editorRpc = {
  fsList: async () => ({ path: '/home', entries: [{ name: 'notes.md', path: '/home/notes.md', type: 'file', size: 10 }] }),
  fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 10, mime_hint: 'text/markdown' }),
  fsRead: async () => ({ content: '# notes' }),
  gitCmd: async () => ({ code: 1, stdout: '' }),
  setPref: async () => ({}), saveBookmarks: async () => ({}),
};
async function dirtyEditor(app: Awaited<ReturnType<typeof bootApp>>['app'], settle: () => Promise<void>) {
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^files$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  files!.click(); await settle();
  app.document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle();
  app.document.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click(); await settle();
  const area = app.document.querySelector<HTMLTextAreaElement>('.editor-layer textarea')!;
  area.value = '# notes\n\nunsaved'; area.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle();
  return area;
}
const answerDialog = (app: Awaited<ReturnType<typeof bootApp>>['app'], name: RegExp) => {
  const button = [...app.document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')]
    .find((b) => name.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  assert.ok(button, `the dialog offers ${name}: ${[...app.document.querySelectorAll('[role=alertdialog] button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  button.click();
};
/** Settings → Connection → Disconnect, and type `address` into the card. */
async function toTheCard(app: Awaited<ReturnType<typeof bootApp>>['app'], settle: () => Promise<void>, address: string) {
  const gear = [...app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  gear!.click(); await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  await settle();
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = address;
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  return {
    field,
    submit: async () => {
      [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
      await settle();
    },
  };
}

test('the card s connect to another server, accepted in the editor s dialog, dials exactly once — what was submitted (G2-a/c)', async (context) => {
  // Accepting reveals Files, which used to UNMOUNT the connect form that was
  // waiting on the walk: its attempt died at `!mounted`, and the approved
  // connect never happened. The host now holds the form for the walk.
  const events: string[] = [];
  const { app, settle, onScreen, restored } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, { calls: events, rpc: editorRpc });
  await dirtyEditor(app, settle);
  const { field, submit } = await toTheCard(app, settle, 'ws://b:9899');
  const dials = () => events.filter((e) => e.startsWith('connect:')).slice(1);   // after the boot dial
  await submit();
  assert.ok(app.document.querySelector('[role=alertdialog]'), 'the editor asks, in its own dialog');
  assert.deepEqual(dials(), [], 'nothing dialled yet');
  // The person (or a late autofill) changes the field while the dialog is up.
  field.value = 'ws://elsewhere:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  answerDialog(app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await settle();
  assert.deepEqual(dials(), ['connect:ws://b:9899'], 'accept dials once, to the address that was approved');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'and the app is on B');
  await app.advance(1000);
  assert.equal(onScreen(), 'work:2.0', 'with B s navigation');
  assert.equal(restored(), 'b:work:2.0');
});

test('A s own address is asked about too: it can answer as another machine now (G2-b)', async (context) => {
  // An address is not an identity. The card dials A's saved address, the
  // machine there is B now — the boot and the reconnect have both met this —
  // and the old exemption for "an address this machine answers on" let it
  // tear A's tree down with no question asked.
  const events: string[] = [];
  const { app, settle } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events, rpc: editorRpc });
  const area = await dirtyEditor(app, settle);
  const { submit } = await toTheCard(app, settle, 'ws://a:9899');
  const dials = () => events.filter((e) => e.startsWith('connect:')).slice(1);
  await submit();
  assert.ok(app.document.querySelector('[role=alertdialog]'), 'the editor asks before A s own address is dialled');
  assert.deepEqual(dials(), [], 'nothing dialled yet');
  answerDialog(app, /keep editing/iu);
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(dials(), [], 'keep editing: no dial');
  assert.equal(area.isConnected && area.value, '# notes\n\nunsaved');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a');
});

test('a reconnect that reaches another known machine asks A s editor first; "keep editing" keeps A (G2, reviewer 18:54)', async (context) => {
  // The socket dropped and the retry to A's address answered as known B.
  // Losing the socket is not consent to discard A's unsaved text.
  const events: string[] = [];
  const { app, settle, net } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events, rpc: editorRpc });
  const area = await dirtyEditor(app, settle);
  net.drop();
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(app.document.querySelector('[role=alertdialog]'), 'A s editor asks, in its own dialog');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a', 'nothing moved while it asks');
  const slotA = app.window.localStorage.getItem('tmux_state::a');
  answerDialog(app, /keep editing/iu);
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a', 'the app stays on A');
  assert.equal(app.window.localStorage.getItem('tmux_state::a'), slotA, 'A s navigation untouched');
  assert.equal(area.isConnected && area.value, '# notes\n\nunsaved', 'and A s text is still there');
  assert.match(app.document.querySelector('.card .error')?.textContent ?? '', /now reaches beta/iu,
    'the connect page says why, and nothing retries on its own');
  const reconnects = events.filter((e) => e.startsWith('connect:')).length;
  await app.advance(60_000);
  assert.equal(events.filter((e) => e.startsWith('connect:')).length, reconnects, 'no retry behind the person s back');
});

test('a reconnect that reaches another known machine, accepted in A s dialog, arrives at B (G2, reviewer 18:54)', async (context) => {
  const events: string[] = [];
  const { app, settle, net, onScreen } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events, rpc: editorRpc });
  await dirtyEditor(app, settle);
  net.drop();
  for (let i = 0; i < 4; i++) await settle();
  answerDialog(app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b', 'the app arrived at B');
  await app.advance(1000);
  assert.equal(onScreen(), 'work:2.0', 'with B s navigation');
});

/** A transfer that ignores its abort: it records it, and ends only when the
 * case lets it — a download whose cleanup takes a while. */
function slowTransfer(events: string[]) {
  let finish: () => void = () => {};
  return {
    finish: () => finish(),
    rpc: {
      fsList: async () => ({ path: '/home', entries: [{ name: 'big.bin', path: '/home/big.bin', type: 'file', size: 9e9 }] }),
      fsStat: async (path: string) => ({ path, is_text: false, writable: true, readable: true, size: 9e9 }),
      fsDownloadHttp: async () => ({ url: 'https://a/dl?path=%2Fhome%2Fbig.bin&sig=s' }),
      gitCmd: async () => ({ code: 1, stdout: '' }),
    },
    setup(window: any) {
      window.fetch = (_url: string, init: { signal?: AbortSignal } = {}) => new window.Promise((_resolve: unknown, reject: (e: unknown) => void) => {
        events.push('fetch');
        init.signal?.addEventListener('abort', () => { events.push('aborted'); });
        finish = () => { events.push('settled'); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      });
    },
  };
}
async function startDownload(app: Awaited<ReturnType<typeof bootApp>>['app'], settle: () => Promise<void>) {
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^files$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  files!.click(); await settle();
  app.document.querySelector<HTMLButtonElement>('button[aria-label="Download: big.bin"]')!.click();
  await settle();
}

for (const [path, start] of [
  ['the card s connect to another server', async (h: Awaited<ReturnType<typeof bootApp>>) => {
    const { submit } = await toTheCard(h.app, h.settle, 'ws://b:9899');
    await submit();
  }],
  ['a reconnect that reaches another known machine', async (h: Awaited<ReturnType<typeof bootApp>>) => {
    h.net.drop();
  }],
] as const) {
  test(`${path} ends A only after A s download has settled (G1)`, async (context) => {
    // The verdict ("another server") and the revoke used to DISPOSE A on the
    // spot; the release came later, from the swap. Now each of them hands A
    // to the one end: stopped at once (the transfer is aborted right there),
    // and B comes up only once A's work has finished stopping.
    const events: string[] = [];
    const transfer = slowTransfer(events);
    const h = await bootApp(context,
      { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
      (url, n) => (url.includes('//b') || n > 1 ? 'm-b' : 'm-a'), { calls: events, rpc: transfer.rpc, setup: transfer.setup });
    await startDownload(h.app, h.settle);
    assert.deepEqual(events.filter((e) => ['fetch', 'aborted', 'settled'].includes(e)), ['fetch'], 'the transfer is running');
    await start(h);
    for (let i = 0; i < 6; i++) await h.settle();
    assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'B authenticated');
    assert.deepEqual(events.filter((e) => ['fetch', 'aborted', 'settled'].includes(e)), ['fetch', 'aborted'],
      'A was stopped the moment it was given up');
    await h.app.advance(1000);
    assert.equal(h.onScreen(), 'none', 'and B waits: A s download has not finished stopping');
    transfer.finish();
    for (let i = 0; i < 6; i++) await h.settle();
    await h.app.advance(1000);
    assert.equal(h.onScreen(), 'work:2.0', 'once it has, B comes up');
  });
}

test('a merge on a failover keeps a download in flight: no verdict releases what the survivor adopts', async (context) => {
  // The reconnect is the first connect to learn the machine, and identity
  // repair folds the alias into canonical. The swap hands the alias's state
  // to the survivor; a verdict ending the alias first would have released it.
  const events: string[] = [];
  const transfer = slowTransfer(events);
  const { app, settle, net } = await bootApp(context,
    { ...aliasAndCanonical(legacyNav('work:1.0')), tmux_layout_mode: 'desktop' }, learnsItsMachineLater,
    { calls: events, rpc: transfer.rpc, setup: transfer.setup });
  await startDownload(app, settle);
  net.drop();
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the failover absorbed the alias');
  assert.deepEqual(events.filter((e) => ['fetch', 'aborted', 'settled'].includes(e)), ['fetch'], 'and the download is still running');
});

// ── Reviewer on 085b0e70: while A's leave dialog asks, nothing else takes
// the socket, and a "stay" means nothing dials until the person does.

/** A on two addresses, the optimizer's probe for the faster one held until
 * the case lets it answer, and the reconnect after a drop reaching B. */
async function arrivalWithAProbeOut(context: TestContext, probeAnswers: 'during the dialog' | 'later' = 'during the dialog') {
  const events: string[] = [];
  let answerProbe: (best: string | null) => void = () => {};
  let probes = 0;
  const h = await bootApp(context,
    {
      ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }),
      tmux_layout_mode: 'desktop',
      tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
    },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'),
    {
      calls: events,
      rpc: {
        ...editorRpc,
        classifyAddress: (a: string) => (a.includes('lan') ? 0 : 2),
        // The optimizer's probe is the first; the reconnect loop's own
        // address probes answer at once, with nothing better.
        findBestAddress: () => (++probes === 1
          ? new Promise<string | null>((resolve) => { answerProbe = resolve; })
          : Promise.resolve(null)),
      },
    });
  const area = await dirtyEditor(h.app, h.settle);
  // Coming back to the app starts the optimizer: its probe is out.
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  await h.settle();
  assert.equal(probes, 1, 'the optimizer s probe is out');
  h.net.drop();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'A s editor asks about arriving at B');
  // The probe answers while the dialog is open: a faster address of A.
  if (probeAnswers === 'during the dialog') {
    answerProbe('ws://a-lan:9899');
    for (let i = 0; i < 4; i++) await h.settle();
  }
  return { ...h, events, area, answerProbe, dials: () => events.filter((e) => e.startsWith('connect:')) };
}

test('a probe that answers while A s leave dialog is open takes nothing; "keep editing" then keeps A and the socket alone (reviewer P1 on 085b0e70)', async (context) => {
  const h = await arrivalWithAProbeOut(context);
  assert.ok(!h.dials().includes('connect:ws://a-lan:9899'), `the optimizer did not move the socket: ${h.dials().join(',')}`);
  assert.equal(h.app.window.localStorage.getItem('tmux_address'), 'ws://a:9899', 'nor the address the app dials');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'the app stays on A');
  assert.equal(h.area.isConnected && h.area.value, '# notes\n\nunsaved');
});

test('a probe that answers while A s leave dialog is open takes nothing; "discard" then arrives at B (reviewer P1 on 085b0e70)', async (context) => {
  const h = await arrivalWithAProbeOut(context);
  assert.ok(!h.dials().includes('connect:ws://a-lan:9899'), `the optimizer did not move the socket: ${h.dials().join(',')}`);
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the arrival is still the app s, and it arrives at B');
  await h.app.advance(1000);
  assert.equal(h.onScreen(), 'work:2.0');
});

test('after "keep editing", coming back to the app dials nothing until the person connects (reviewer P2 on 085b0e70)', async (context) => {
  const events: string[] = [];
  const { app, settle, net } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events, rpc: editorRpc });
  await dirtyEditor(app, settle);
  net.drop();
  for (let i = 0; i < 4; i++) await settle();
  answerDialog(app, /keep editing/iu);
  for (let i = 0; i < 6; i++) await settle();
  const dials = () => events.filter((e) => e.startsWith('connect:')).length;
  const before = dials();
  app.document.dispatchEvent(new app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await settle();
  await app.advance(60_000);
  assert.equal(dials(), before, 'a foreground resume does not dial B again behind the person s back');
  assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'and asks nothing again');
  // The person connects: that is theirs to do, and it works.
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://a:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle();
  assert.ok(app.document.querySelector('[role=alertdialog]'), 'the explicit connect asks A s editor, as a connect to another server does');
  assert.equal(dials(), before, 'and dials only once the person answers');
});

test('after "keep editing", the person s own connect lifts the stay: a failed one hands back to the automatic reconnect', async (context) => {
  const events: string[] = [];
  const { app, settle, net } = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'),
    { calls: events, rpc: editorRpc, gate: (url) => (url.includes('//dead') ? Promise.reject(new Error('refused')) : null) });
  await dirtyEditor(app, settle);
  net.drop();
  for (let i = 0; i < 4; i++) await settle();
  answerDialog(app, /keep editing/iu);
  for (let i = 0; i < 6; i++) await settle();
  // The person connects somewhere that does not answer; the editor asks,
  // and they let it go.
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://dead:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await settle();
  answerDialog(app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await settle();
  assert.ok(events.includes('connect:ws://dead:9899'), 'the person s connect went out');
  const dials = events.filter((e) => e.startsWith('connect:')).length;
  app.document.dispatchEvent(new app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(events.filter((e) => e.startsWith('connect:')).length > dials, 'coming back to the app reconnects again: the stay was lifted');
});

test('a probe that answers only AFTER "keep editing" moves nothing and lifts no stay (reviewer P2 on 4fbce02e)', async (context) => {
  const h = await arrivalWithAProbeOut(context, 'later');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) await h.settle();
  const dials = h.dials().length;
  h.answerProbe('ws://a-lan:9899');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.dials().length, dials, `the late probe dialled nothing: ${h.dials().join(',')}`);
  assert.equal(h.app.window.localStorage.getItem('tmux_address'), 'ws://a:9899', 'and did not move the mirror');
  // The stay still holds: coming back to the app dials nothing either.
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await h.settle();
  await h.app.advance(60_000);
  assert.equal(h.dials().length, dials, 'the stay is still in force');
  assert.equal(h.area.isConnected && h.area.value, '# notes\n\nunsaved');
});

/** A on screen with an unsaved editor; the socket drops and every reconnect
 * fails until the loop gives up, which puts the connect card up over A's
 * tree. `next` decides what the dials after that do. */
async function gaveUpOnA(context: TestContext, next: (url: string, n: number) => Promise<void> | null) {
  const events: string[] = [];
  let failing = true;
  const h = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (url, n) => (n === 1 ? 'm-a' : url.includes('//b') ? 'm-b' : 'm-b'),
    { calls: events, rpc: editorRpc, gate: (url, n) => (n === 1 ? null : failing ? Promise.reject(new Error('refused')) : next(url, n)) });
  const area = await dirtyEditor(h.app, h.settle);
  h.net.drop();
  for (let i = 0; i < 30; i++) { await h.app.advance(5_000); await h.settle(); }
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]');
  assert.ok(field, `the loop gave up: the connect card is up (${events.filter((e) => e.startsWith('connect:')).length} dials)`);
  failing = false;
  const dials = () => events.filter((e) => e.startsWith('connect:'));
  const dialogs = () => h.app.document.querySelectorAll('[role=alertdialog]').length;
  return { ...h, events, area, field, dials, dialogs };
}

test('a form walk freezes a reconnect loop in its backoff: no dial while it asks, and a stay starts the loop again (reviewer P1 on 4fbce02e)', async (context) => {
  const h = await gaveUpOnA(context, () => Promise.reject(new Error('refused')));
  // Coming back to the app starts a loop; its first dial fails and it waits.
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  await h.settle();
  const out = h.dials().length;
  h.field.value = 'ws://b:9899';
  h.field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
  assert.equal(h.dialogs(), 1, 'A s editor asks');
  for (let i = 0; i < 6; i++) { await h.app.advance(5_000); await h.settle(); }
  assert.equal(h.dials().length, out, `nothing dialled while it asks: ${h.dials().slice(out).join(',')}`);
  assert.equal(h.dialogs(), 1, 'and no second dialog opened');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.dials().length > out, 'the stay started the frozen loop again');
  assert.ok(!h.dials().slice(out).includes('connect:ws://b:9899'), 'and never dialled what was declined');
  assert.equal(h.area.isConnected && h.area.value, '# notes\n\nunsaved');
});

test('a reconnect dial out when a form walk opens cannot open a second walk when it answers as another machine (reviewer P1 on 4fbce02e)', async (context) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = await gaveUpOnA(context, (url) => (url.includes('//a') ? held : null));
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  await h.settle();
  assert.ok(h.dials().at(-1) === 'connect:ws://a:9899', 'R1 is out');
  h.field.value = 'ws://b:9899';
  h.field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
  assert.equal(h.dialogs(), 1, 'A s editor asks about the form s connect');
  const slotA = h.app.window.localStorage.getItem('tmux_state::a');
  release();                                     // R1 answers — as B
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.dialogs(), 1, 'its late success opened no arrival walk of its own');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'and moved nothing');
  assert.equal(h.app.window.localStorage.getItem('tmux_state::a'), slotA, 'A s navigation untouched');
});

// ── The last ②b case before the flip (orchestrator, 08:29): a real switch
// through the switcher while another dial is still out.

test('a switch while a reconnect dial hangs: A s download settles before B is dialled, and the late dial changes nothing', async (context) => {
  // A is on screen with a download running. The socket drops and the
  // reconnect's dial to A hangs. The person picks beta in the switcher. The
  // switch must take the socket from that dial, stop A's download and wait
  // for it, and only then dial B. When the hung dial finally answers, it is
  // nobody's: no identity, no reconnect, no tree.
  const events: string[] = [];
  const transfer = slowTransfer(events);
  let releaseR1: () => void = () => {};
  const r1 = new Promise<void>((resolve) => { releaseR1 = resolve; });
  const h = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (url) => (url.includes('//b') ? 'm-b' : 'm-a'),
    { calls: events, rpc: transfer.rpc, setup: transfer.setup, gate: (_url, n) => (n === 2 ? r1 : null) });
  await startDownload(h.app, h.settle);
  const trace = () => events.filter((e) => ['fetch', 'aborted', 'settled'].includes(e) || e.startsWith('connect:') || e.startsWith('answered:'));
  h.net.drop();
  await h.settle();
  assert.deepEqual(trace(), ['connect:ws://a:9899', 'answered:ws://a:9899#1', 'fetch', 'connect:ws://a:9899'], 'the reconnect s dial to A is out, and hangs');

  await h.switchTo('beta');
  assert.deepEqual(trace().slice(4), ['aborted'], 'the switch stopped A s download — and dials nothing until it has settled');
  transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.deepEqual(trace().slice(4), ['aborted', 'settled', 'connect:ws://b:9899', 'answered:ws://b:9899#3'], 'then B');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the app is on B');
  await h.app.advance(1000);
  assert.equal(h.onScreen(), 'work:2.0', 'with B s navigation');
  const servers = h.app.window.localStorage.getItem('tmux_servers');

  releaseR1();                                   // the hung dial answers, late
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(10_000);
  assert.deepEqual(trace().slice(8), ['answered:ws://a:9899#2'], 'it answered — and nothing dialled after it');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'CURRENT stayed on B');
  assert.equal(h.app.window.localStorage.getItem('tmux_servers'), servers, 'no identity was recorded');
  assert.equal(h.onScreen(), 'work:2.0', 'and B s tree is the one on screen');
  assert.equal(h.app.document.querySelector('.reconnect-cancel'), null, 'no reconnect banner');
});

// ── b2-4, the flip (board #335 ②b-4): every server's state lives in its own
// slot, the boot folds the pre-#335 live keys into one once, and nothing
// parks or points again.

/** Every key, as a plain object: what a reload boots from. */
const dumpStorage = (app: { window: any }) => {
  const out: Record<string, string> = {};
  const st = app.window.localStorage;
  for (let i = 0; i < st.length; i++) { const k = st.key(i)!; out[k] = st.getItem(k)!; }
  return out;
};
const LEGACY_KEYS = ['tmux_state', 'tmux_machine_id', 'tmux_hub_project', 'tmux_hub_drafts', 'tmux_hub_seen',
  'tmux_hub_lead', 'tmux_hub_drawer', 'tmux_hub_roster_expanded', 'tmux_hub_alerts'];

test('acceptance: a pre-#335 client migrates, is edited, goes A→B→A, and a reload finds every server s own state', async (context) => {
  // The fixture is what a pre-#335 build leaves: A live (unprefixed), B
  // parked under its id, a Hub draft for the same project name on each.
  const seed = {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
    tmux_hub_drafts: JSON.stringify({ work: 'draft on A' }),
    'tmux_hub_drafts::b': JSON.stringify({ work: 'draft on B' }),
  };
  // `other` exists on both servers, so a restore keeps it (the shell drops a
  // restored pane whose session is gone).
  const rpc = { listSessions: async () => [{ name: 'work' }, { name: 'other' }] };
  const first = await bootApp(context, seed, undefined, { rpc });
  const ls = first.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).into, 'a', 'the boot folded the live keys into A');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft on A' }), 'A s draft is in A s slot');
  assert.equal(first.onScreen(), 'work:1.0', 'and A s navigation came up');
  const legacy = Object.fromEntries(LEGACY_KEYS.map((k) => [k, ls.getItem(k)]));

  await first.openSession('other');                     // an edit on A
  assert.equal(first.restored(), 'a:other:3.0', 'written into A s slot');
  await first.switchTo('beta');
  await first.app.advance(1000);
  assert.equal(first.onScreen(), 'work:2.0', 'B s own navigation');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft on B' }), 'B s draft untouched');
  await first.switchTo('alpha');
  await first.app.advance(1000);
  assert.equal(first.onScreen(), 'other:3.0', 'A as it was left');
  assert.deepEqual(Object.fromEntries(LEGACY_KEYS.map((k) => [k, ls.getItem(k)])), legacy,
    'nothing wrote a legacy key, through an edit and two switches');
  const after = dumpStorage(first.app);
  await first.app.close();

  // Reload.
  const second = await bootApp(context, after, undefined, { rpc });
  assert.equal(second.onScreen(), 'other:3.0', 'the reload restores A s latest navigation');
  assert.equal(second.app.window.localStorage.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft on A' }),
    'and the fold did not run again over A s slot');
  const b = JSON.parse(second.app.window.localStorage.getItem('tmux_state::b')!);
  assert.equal(b.pane?.target ?? b.terminalTarget, 'work:2.0', 'and B s slot still holds B s');
  assert.equal(second.app.window.localStorage.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft on B' }));
});

test('a deep link to B on a client that is on A: A s live state goes to A s slot, B s is untouched', async (context) => {
  // Fold before the link: the link makes B current, and a fold after it
  // would have filed A's live state into B's slot.
  const { app, onScreen } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
    tmux_hub_drafts: JSON.stringify({ work: 'draft on A' }),
  }, undefined, { setup(window) { window.history.replaceState(null, '', '/?addr=ws://b:9899&token=tokB'); } });
  const ls = app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the link made B current');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).into, 'a');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft on A' }));
  assert.equal(ls.getItem('tmux_hub_drafts::b'), null, 'B never got A s draft');
  const b = JSON.parse(ls.getItem('tmux_state::b')!);
  assert.equal(b.pane?.target ?? b.terminalTarget, 'work:2.0', 'B s navigation is B s');
  await app.advance(1000);
  assert.equal(onScreen(), 'work:2.0');
  assert.equal(app.window.location.search, '', 'and the token left the address bar');
});

test('a fresh client opens the connect card, and a first connect folds and brings the server up', async (context) => {
  const events: string[] = [];
  const { app, settle, onScreen } = await bootApp(context, { tmux_layout_mode: 'desktop' }, undefined, { calls: events });
  assert.ok(app.document.querySelector('.card .fields input[type="text"]'), 'the connect card');
  assert.equal(app.window.localStorage.getItem('tmux_state_layout'), null, 'nothing to fold into yet');
  const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://a:9899';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 4; i++) await settle();
  const id = app.window.localStorage.getItem('tmux_server_current')!;
  assert.ok(id, 'the connect made a server current');
  assert.equal(JSON.parse(app.window.localStorage.getItem('tmux_state_layout')!).into, id, 'and folded for it');
  assert.ok(app.document.querySelector('.term-page'), 'the server pages mounted');
  void onScreen;
});

test('a deep link on a fresh client: the linked server is current, folded, and up', async (context) => {
  const { app } = await bootApp(context, { tmux_layout_mode: 'desktop' }, undefined,
    { setup(window) { window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); } });
  const ls = app.window.localStorage;
  const id = ls.getItem('tmux_server_current')!;
  assert.ok(id);
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).into, id);
  assert.ok(app.document.querySelector('.term-page'), 'the server pages mounted');
});

test('pre-#335 inputs left under a dangling CURRENT go only to the machine that proves them (reviewer P1-c)', async (context) => {
  for (const [answers, claimed] of [['m-a', true], ['m-x', false]] as const) {
    const { app, onScreen } = await bootApp(context, {
      tmux_servers: JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', named: true }]),
      tmux_server_current: 'gone',
      tmux_address: 'ws://a:9899', tmux_token: 'tokA', tmux_machine_id: 'm-a',
      tmux_state: legacyNav('work:1.0'),
      tmux_hub_drafts: JSON.stringify({ work: 'draft of m-a' }),
      tmux_layout_mode: 'desktop',
    }, () => answers);
    const ls = app.window.localStorage;
    assert.ok(ls.getItem('tmux_state::unattributed'), 'the legacy navigation was copied aside at boot');
    // The form connects; the server becomes current and must prove itself.
    const field = app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
    field.value = 'ws://a:9899';
    field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    for (let i = 0; i < 2; i++) await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
    for (let i = 0; i < 20; i++) await app.flush();
    const id = ls.getItem('tmux_server_current')!;
    assert.equal(ls.getItem(`tmux_hub_drafts::${id}`), claimed ? JSON.stringify({ work: 'draft of m-a' }) : null,
      claimed ? 'm-a proved it: the draft is its' : 'm-x could not: nothing of m-a s is its');
    await app.advance(1000);
    if (claimed) assert.equal(onScreen(), 'work:1.0', 'and its navigation came up');
    else assert.equal(onScreen(), 'none', 'and no pane of m-a s opened on m-x');
    await app.close();
  }
});

/** Storage that refuses writes to `keys` until the case says otherwise. */
const refusing = (keys: string[]) => {
  const state = { failing: true };
  return {
    state,
    setup(window: any) {
      const set = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (state.failing && keys.includes(k)) throw new Error('QuotaExceededError');
        return set.call(this, k, v);
      };
    },
  };
};
const cardButton = (app: any, name: RegExp) => [...app.document.querySelectorAll('.card button')]
  .find((b: any) => name.test((b.textContent ?? '').trim())) as HTMLButtonElement | undefined;

test('a blocked migration freezes CURRENT: no boot dial, no switch, the card offers only Retry, and Retry brings A up (board #335 ②b-4)', async (context) => {
  const store = refusing(['tmux_state_layout']);
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, { calls: events, setup: store.setup });
  await h.app.advance(6000);
  const ls = h.app.window.localStorage;
  const frozen = () => [ls.getItem('tmux_server_current'), ls.getItem('tmux_servers')];
  const before = frozen();
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'the boot did not dial');
  assert.equal(h.app.document.querySelector('.term-page'), null, 'no server page mounted');
  assert.match(h.app.document.querySelector('.card .error')?.textContent ?? '', /could not write its storage/iu, 'the card says why');
  assert.equal(cardButton(h.app, /^connect$/iu), undefined, 'and has no Connect');
  // A switch does nothing while it is blocked.
  await h.switchTo('beta');
  assert.deepEqual(frozen(), before, 'no switch: CURRENT and the registry as they were');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'nothing dialled');
  // Storage works again; Retry, from the card.
  store.state.failing = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))?.click();
  await h.settle();
  const retry = cardButton(h.app, /retry/iu);
  assert.ok(retry, `the card offers Retry: ${[...h.app.document.querySelectorAll('.card button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).into, 'a', 'the fold is recorded');
  assert.equal(h.onScreen(), 'work:1.0', 'and A came up with its navigation');
});

test('a deep link that arrives while the migration is blocked is applied only after Retry records A s fold (reviewer P1-a on cf7e7957)', async (context) => {
  const store = refusing(['tmux_state_layout']);
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
    tmux_hub_drafts: JSON.stringify({ work: 'draft on A' }),
    'tmux_hub_drafts::b': JSON.stringify({ work: 'draft on B' }),
  }, undefined, { calls: events, setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://b:9899&token=tokB'); } });
  await h.app.advance(6000);
  const ls = h.app.window.localStorage;
  assert.equal(h.app.window.location.search, '', 'the token left the address bar at once');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'but the link was not applied');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft on B' }), 'B s slot untouched');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'nothing dialled');
  store.state.failing = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'a' }, 'A s fold first');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft on A' }));
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'then the link');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft on B' }), 'and B is B s');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://b:9899'], 'and B is dialled');
});

for (const [what, key] of [['the registry', 'tmux_servers'], ['the quarantine copy', 'tmux_state::unattributed']] as const) {
  test(`a failure writing ${what} before the fold is the same blocked state, not a crash (reviewer P1-d on cf7e7957)`, async (context) => {
    const store = refusing([key]);
    const seed: Record<string, string> = key === 'tmux_servers'
      // A pre-registry client: the registry has to be written first.
      ? { tmux_address: 'ws://a:9899', tmux_token: 'tokA', tmux_machine_id: 'm-a', tmux_state: legacyNav('work:1.0'), tmux_layout_mode: 'desktop' }
      // A dangling CURRENT: the navigation has to be set aside first.
      : { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_server_current: 'gone', tmux_layout_mode: 'desktop' };
    const events: string[] = [];
    const h = await bootApp(context, seed, undefined, { calls: events, setup: store.setup });
    await h.app.advance(6000);
    assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'nothing dialled');
    assert.ok(cardButton(h.app, /retry/iu), 'the card offers Retry');
    store.state.failing = false;
    cardButton(h.app, /retry/iu)!.click();
    for (let i = 0; i < 6; i++) await h.settle();
    const mark = JSON.parse(h.app.window.localStorage.getItem('tmux_state_layout')!);
    assert.equal(mark.state, key === 'tmux_servers' ? 'folded' : 'pending', 'Retry finished what had failed');
    assert.ok(cardButton(h.app, /^connect$/iu) || h.app.document.querySelector('.term-page'), 'and the app is usable again');
  });
}

test('blocked mid-session (a claim that cannot be recorded): the optimizer and the reconnect loop move nothing, and Retry lands the claim (orchestrator, 21:45)', async (context) => {
  // m-a's inputs are pending (CURRENT dangled at boot). The person is on B,
  // switches to alpha — m-a, the owner — and the claim's marker write fails.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_server_current: 'gone',
    tmux_layout_mode: 'desktop',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }, undefined, {
    calls: events, setup: store.setup,
    rpc: { classifyAddress: (a: string) => (a.includes('lan') ? 0 : 2), findBestAddress: async () => 'ws://a-lan:9899' },
  });
  const ls = h.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending');
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://b:9899';
  field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  cardButton(h.app, /^connect$/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'on B');
  store.state.failing = true;
  await h.app.advance(1000);
  await h.switchTo('alpha');
  await h.app.advance(1000);
  assert.equal(h.app.document.querySelector('.term-page'), null, 'the claim could not be recorded: no server page');
  const frozen = () => [ls.getItem('tmux_server_current'), ls.getItem('tmux_servers'), ls.getItem('tmux_address')];
  const before = frozen();
  const dials = () => events.filter((e) => e.startsWith('connect:')).length;
  const n = dials();
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));   // the optimizer s entry
  for (let i = 0; i < 4; i++) await h.settle();
  await h.app.advance(400_000);                                               // and its timer
  assert.equal(dials(), n, 'the optimizer dialled nothing');
  h.net.drop();                                                               // the reconnect loop s entry
  for (let i = 0; i < 4; i++) await h.settle();
  await h.app.advance(30_000);
  assert.equal(dials(), n, 'nor did a reconnect');
  assert.deepEqual(frozen(), before, 'CURRENT, the registry and the mirror as they were');
  // Retry, once storage works: the claim lands and A comes up.
  store.state.failing = false;
  // Connected, so the reason and Retry are on the content area's panel.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))?.click();
  await h.settle();
  const retry = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry, 'Retry is offered');
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'a' }, 'm-a claimed its inputs');
  // Storage is not the socket (reviewer P1-2 on 08fdb6ba): the drop while
  // blocked is reconnected now, and A comes up on it.
  await h.app.advance(5000);
  for (let i = 0; i < 4; i++) await h.settle();
  const after = events.filter((e) => e.startsWith('answered:')).slice(-1)[0] ?? '';
  assert.ok(dials() > n, `Retry reconnected: ${events.filter((e) => e.startsWith('connect:')).slice(-3).join(',')}`);
  assert.match(after, /ws:\/\/a(-lan)?:9899/u, 'to alpha');
  assert.equal(h.app.document.querySelector('.reconnect-cancel'), null, 'and the reconnect is over');
  assert.equal(h.onScreen(), 'work:1.0', 'with m-a s navigation');
});

test('Retry after a mid-session block with the socket still up: A comes up on it, nothing is dialled again', async (context) => {
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_server_current: 'gone',
    tmux_layout_mode: 'desktop',
  }, undefined, { calls: events, setup: store.setup });
  const ls = h.app.window.localStorage;
  await connectCard(h.app, h.settle, 'ws://b:9899');
  store.state.failing = true;
  await h.app.advance(1000);
  await h.switchTo('alpha');
  await h.app.advance(1000);
  assert.equal(h.app.document.querySelector('.term-page'), null, 'blocked');
  const dials = () => events.filter((e) => e.startsWith('connect:')).length;
  const n = dials();
  store.state.failing = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))?.click();
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button')].find((b) => /retry/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).into, 'a');
  assert.equal(dials(), n, 'no new dial: the socket was up');
  assert.equal(h.onScreen(), 'work:1.0', 'and m-a s navigation came up on it');
});

test('the boot dials the CURRENT entry s address, not a mirror an unanswered form left behind (board #335 ②b-4)', async (context) => {
  // A connect form that never got an answer wrote its address into the
  // mirror; the entry still names where the server is.
  const events: string[] = [];
  const { app } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_address: 'ws://typed-never-answered:9899',
  }, undefined, { calls: events });
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://a:9899'], 'the entry s address');
  const a = JSON.parse(app.window.localStorage.getItem('tmux_servers')!).find((e: any) => e.id === 'a');
  assert.equal(a.address, 'ws://a:9899', 'and that is what is recorded');
});

test('an address the optimizer moved to is recorded on the entry, where a reconnect reads it (board #335 ②b-4)', async (context) => {
  const events: string[] = [];
  const { app, settle } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }, (url) => (url.includes('//b') ? 'm-b' : 'm-a'), {
    calls: events,
    rpc: { classifyAddress: (a: string) => (a.includes('lan') ? 0 : 2), findBestAddress: async () => 'ws://a-lan:9899' },
  });
  app.document.dispatchEvent(new app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(events.includes('connect:ws://a-lan:9899'), `the optimizer moved the socket: ${events.filter((e) => e.startsWith('connect:')).join(',')}`);
  const a = JSON.parse(app.window.localStorage.getItem('tmux_servers')!).find((e: any) => e.id === 'a');
  assert.equal(a.address, 'ws://a-lan:9899', 'and the entry knows it');
});

test('each server s stored Hub state is read from its own slot: the bell counts only that server s alerts (board #335 ②b-4)', async (context) => {
  // The alert list is one of the resident keys, built into the runtime's
  // state over its server's store: a bundle over the bare storage would read
  // A's legacy list on B too.
  const alert = (id: string) => ({ key: `proj:work|${id}`, room: 'proj:work', server: '', session: 'work', seq: 1, id, ts: 1, from: 'lead', toHuman: true, kind: 'reply', excerpt: 'x' });
  const hub = { hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }), hubAgents: async () => ({ agents: [] }), registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }), hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }) };
  const { app, switchTo } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
    tmux_hub_alerts: JSON.stringify([alert('a1'), alert('a2')]),           // A's, live
    'tmux_hub_alerts::b': JSON.stringify([alert('b1')]),                   // B's, parked
  }, undefined, { rpc: hub, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  const bell = () => app.document.querySelector('.rail-bell')?.getAttribute('aria-label') ?? '';
  assert.match(bell(), /· 2\b/u, `A s two alerts: ${bell()}`);
  await switchTo('beta');
  await app.advance(1000);
  assert.match(bell(), /· 1\b/u, `B s one alert, not A s: ${bell()}`);
});

// ── Pending inputs (reviewer P1-b/P1-c on cf7e7957): a server that cannot
// prove the inputs are its own leaves them pending; the owner claims them
// whenever it shows up, across reloads.

/** m-a's pre-#335 client, whose CURRENT dangled: A's navigation and draft
 * are live, and the registry knows alpha (m-a) and beta (m-b). */
const danglingSeed = (over: Record<string, string> = {}) => ({
  ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
  tmux_server_current: 'gone',
  tmux_hub_drafts: JSON.stringify({ work: 'draft of m-a' }),
  tmux_layout_mode: 'desktop',
  ...over,
});
async function connectCard(app: any, settle: () => Promise<void>, address: string) {
  const field = app.document.querySelector('.card .fields input[type="text"]') as HTMLInputElement;
  field.value = address;
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await settle();
  cardButton(app, /^connect$/iu)!.click();
  for (let i = 0; i < 4; i++) await settle();
}

test('a deep link to the owner before it has reported its machine: it claims the inputs once it does', async (context) => {
  // alpha's entry does not know its machine yet; the link makes it current
  // before any auth, and only the authentication can prove it is m-a.
  const servers = JSON.parse(twoServers({ live: '', parked: '' }).tmux_servers);
  delete servers[0].machineId;
  const { app, onScreen } = await bootApp(context, danglingSeed({ tmux_servers: JSON.stringify(servers) }), undefined,
    { setup(window) { window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); } });
  await app.advance(1000);
  const ls = app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'a' }, 'claimed after the auth');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft of m-a' }));
  assert.equal(onScreen(), 'work:1.0', 'and its navigation came up');
});

test('another server first leaves the inputs pending; the owner later claims them — across a reload (reviewer P1-c)', async (context) => {
  const first = await bootApp(context, danglingSeed());
  await connectCard(first.app, first.settle, 'ws://b:9899');
  const ls = first.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'on B');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'B could not prove the inputs: still pending');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), null, 'B got nothing of m-a s');
  const after = dumpStorage(first.app);
  await first.app.close();

  // Reload with B legitimately current: B is NOT the owner because it is current.
  const second = await bootApp(context, after);
  const ls2 = second.app.window.localStorage;
  assert.equal(JSON.parse(ls2.getItem('tmux_state_layout')!).state, 'pending', 'still pending after the reload');
  assert.equal(ls2.getItem('tmux_hub_drafts::b'), null, 'and B still has nothing of m-a s');
  await second.app.advance(1000);
  await second.switchTo('alpha');
  await second.app.advance(1000);
  assert.deepEqual(JSON.parse(ls2.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'a' }, 'the owner claimed them');
  assert.equal(ls2.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft of m-a' }));
  assert.equal(second.onScreen(), 'work:1.0', 'and m-a s navigation came up on alpha');
});

test('a pending marker that cannot be written at boot blocks before any server can become current (reviewer P1-c)', async (context) => {
  const store = refusing(['tmux_state_layout']);
  const first = await bootApp(context, danglingSeed(), undefined, { setup: store.setup });
  await first.app.advance(6000);
  assert.equal(cardButton(first.app, /^connect$/iu), undefined, 'the card offers no Connect: B cannot become current');
  const after = dumpStorage(first.app);
  assert.equal(after.tmux_server_current, 'gone');
  await first.app.close();
  const second = await bootApp(context, after);
  assert.equal(JSON.parse(second.app.window.localStorage.getItem('tmux_state_layout')!).state, 'pending', 'the next boot records it');
});

test('a saved entry boots even when an unanswered form left the mirror empty (reviewer P2 on cf7e7957)', async (context) => {
  const events: string[] = [];
  const { onScreen, app } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_address: '', tmux_token: '',
  }, undefined, { calls: events });
  await app.advance(1000);
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://a:9899'], 'the entry s address and token');
  assert.equal(onScreen(), 'work:1.0');
});

test('a merge rewrite of the navigation that cannot be written blocks with Retry, keeps the record, and Retry restores the layout (reviewer P1-3 on 08fdb6ba)', async (context) => {
  // canon is current; its slot's v2 record still names the absorbed alias,
  // and the merge record says alias → canon. Rewriting the slot fails.
  const store = refusing(['tmux_state::canon']);
  const record = savedNav('alias', 'work:1.0');
  const h = await bootApp(context, {
    tmux_servers: JSON.stringify([{ id: 'canon', name: 'canonical', address: 'ws://a:9899', token: 'tok', machineId: 'm-a', named: true }]),
    tmux_server_current: 'canon',
    tmux_server_merges: JSON.stringify({ alias: 'canon' }),
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'canon' }),
    'tmux_state::canon': record,
    tmux_address: 'ws://a:9899', tmux_token: 'tok',
    tmux_layout_mode: 'desktop',
  }, undefined, { setup: store.setup });
  await h.app.advance(6000);
  const ls = h.app.window.localStorage;
  assert.equal(h.app.document.querySelector('.term-page'), null, 'no server page');
  assert.ok(cardButton(h.app, /retry/iu), 'the card offers Retry');
  assert.equal(ls.getItem('tmux_state::canon'), record, 'the record is as it was');
  store.state.failing = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(JSON.parse(ls.getItem('tmux_state::canon')!).pane.serverId, 'canon', 'Retry rewrote it');
  assert.equal(h.onScreen(), 'work:1.0', 'and the layout came back');
});

test('while blocked the registry is frozen: an unnamed entry adopts no hostname until Retry (reviewer P2-b)', async (context) => {
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = JSON.parse(twoServers({ live: '', parked: '' }).tmux_servers);
  delete servers[0].named;
  servers[0].name = 'a';
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers),
    tmux_server_current: 'gone',
    tmux_address: '', tmux_token: '',                // no boot dial: alpha has not answered yet
    tmux_layout_mode: 'desktop',
  }, undefined, { setup: store.setup });
  const ls = h.app.window.localStorage;
  await connectCard(h.app, h.settle, 'ws://b:9899');
  store.state.failing = true;
  await h.app.advance(1000);
  await h.switchTo('a');                           // its auth reports m-a.host; the claim fails
  await h.app.advance(1000);
  const alpha = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.id === 'a');
  assert.notEqual(alpha.name, 'm-a.host', 'the unnamed entry did not adopt the hostname while blocked');
  store.state.failing = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))?.click();
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button')].find((b) => /retry/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.id === 'a').name, 'm-a.host', 'and adopts it once unblocked');
});
