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
  assert.equal(app.document.querySelector('.page-layer'), null, 'no resident page layer exists');
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

/** A transport that can actually connect, as one machine or another. */
function liveTransport(calls: string[], machine: () => string) {
  let connected = false;
  const rpc = (name: string, result: unknown = []) => () => {
    calls.push(name);
    return connected ? Promise.resolve(result) : Promise.reject(new Error('not connected'));
  };
  return {
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
  };
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
function twoServerTransport(calls: string[], machineAt: MachineAt = byAddress, extra: Record<string, unknown> = {}) {
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
      machine = machineAt(url, ++dials);
      connected = true;
      return machine;
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
  return { module, net };
}

/** The app booted on a seeded storage, with the transport mocked: ONE harness,
 * and each case says what the client wakes up with. */
async function bootApp(
  context: TestContext, seed: Record<string, string>, machineAt?: MachineAt,
  more: { rpc?: Record<string, unknown>; setup?: (window: any) => void; calls?: string[] } = {},
) {
  const calls: string[] = more.calls ?? [];
  const transport = twoServerTransport(calls, machineAt, more.rpc);
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
    pendingImports: ['@tauri-apps/'],
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await app.flush(); };
  await settle();

  /** What the shell restored, seen twice over: the target the Terminal was
   * actually handed, and the record the shell saves back. */
  const onScreen = () =>
    app.document.querySelector<HTMLElement>('.term-main .xterm-wrap')?.dataset.target ?? 'none';
  const record = () => JSON.parse(app.window.localStorage.getItem('tmux_state') || 'null');
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
  assert.equal(parkedA.splitLayout, 2, 'A s split was parked whole');

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

test('a same-machine merge keeps a download in flight, and the next switch still stops it before dialling', async (context) => {
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
    'and the switch away from it stopped it — before the next server was dialled');
});
