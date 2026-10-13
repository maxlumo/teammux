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
import { recordServer } from './lib/app/servers.ts';
import { migrateServerState } from './lib/app/server-state-migration.ts';

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
  default: (anchor: Comment, props: { target: string; visible?: boolean; active?: boolean }) => {
    const el = anchor.ownerDocument.createElement('div');
    el.className = 'xterm-wrap';
    el.dataset.target = props.target;
    // What the tree told it at mount: a held tree's Terminal is neither
    // visible nor active (#335 ③b-1).
    el.dataset.visible = String(!!props.visible);
    el.dataset.active = String(!!props.active);
    anchor.before(el);
  },
};

function transport(calls: string[]) {
  const rpc = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error('not connected'));
  };
  return {
    createConnectionRegistry: () => ({ ensure: () => { throw new Error('no runtime on a fresh client'); }, get: () => undefined, take: () => undefined, remove: () => {}, disposeAll: () => {} }),
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

/** The lifecycle members of a mocked transport; every OTHER function on it is
 * an RPC, answered over whichever connection it is called through. */
const LIFECYCLE = new Set([
  'connect', 'disconnect', 'dispose', 'isConnected', 'getMachineId', 'getHostname', 'setOnDisconnect',
  'subscribe', 'unsubscribe', 'resubscribeActive', 'addPaneOutputListener', 'removePaneOutputListener',
  'addPaneClosedListener', 'removePaneClosedListener', 'addTeamMessageListener', 'removeTeamMessageListener',
  'findBestAddress', 'classifyAddress', 'isAddressViable', 'noteAddressUnreachable',
  'createConnection', 'createWsApi', 'createConnectionRegistry',
]);

/** One fake connection the fleet's registry hands out (board #335 ②b-4,
 * reviewer P2-2 on cc45d7d1): its OWN connected flag, machine and dial
 * sequence, a terminal dispose, and an api that answers only while it is
 * connected. The transport's `connect` decides which machine answers (and
 * records `connect:<url>`); this object decides which connection it was. */
type FakeConnection = {
  key: string; drop(): void; disposed(): boolean; isConnected(): boolean; getMachineId(): string;
  /** A team message on THIS connection's stream, to the listeners its own
   * pages registered (③a: per-connection, never a shared table). */
  push(message: unknown): void;
  /** The api this connection hands its runtime: a case can hold a method the
   * way a page does, and call it later. */
  api: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

/** The mocked transport as the connection layer App wires: the fleet's
 * registry gives every key an INDEPENDENT fake connection with a real
 * dispose, and the connect form's candidates are fakes of their own. A case
 * can therefore see an idle connection, a destroyed one, and which one an
 * RPC went over (`rpc@<key>:<name>`). */
/** The registry key of the connection whose api is being called right now
 * (set around each mocked RPC): a mock that answers PER SERVER reads it. */
let askingKey = '';
const asking = () => askingKey;
function withSlot<M extends Record<string, any>>(module: M, candidateAt?: (url: string) => Promise<string> | string): M {
  const m = module as Record<string, any>;
  const calls: string[] | undefined = m.__calls;
  const conns: FakeConnection[] = [];
  m.__conns = conns;
  // The connect form's CANDIDATE: its own socket. It answers as the machine
  // the address belongs to and records `candidate:<url>`; closing it is
  // `candidate-closed`.
  m.createConnection = () => {
    let machine = '';
    let disposed = false;
    return {
      connect: async (url: string) => {
        calls?.push(`candidate:${url}`);
        const answered = await (candidateAt ? candidateAt(url) : (url.includes('//b') ? 'm-b' : 'm-a'));
        if (disposed) throw new Error('connection disposed');
        machine = answered;
        return machine;
      },
      setOnDisconnect: () => {},
      getMachineId: () => machine,
      dispose: () => { if (!disposed) { disposed = true; calls?.push('candidate-closed'); } },
    };
  };
  m.createWsApi = () => ({ setSocket: async () => ({}) });
  const make = (key: string) => {
    let connected = false;
    let machine = '';
    let disposed = false;
    let seq = 0;
    let onDrop: (() => void) | null = null;
    const noop = () => {};
    const team = new Set<(m: unknown) => void>();
    // A dial in flight is REJECTED by dispose, as the real Connection s
    // `cancelDialing` does: a continuation waiting on it runs then.
    const dialing = new Set<(e: Error) => void>();
    const connection = {
      async connect(url: string, token: string) {
        if (disposed) throw new Error('connection disposed');
        const mine = ++seq;
        connected = false;
        calls?.push(`dial@${key}:${url}|${token}`);
        let cancel!: (e: Error) => void;
        const cancelled = new Promise<never>((_r, rej) => { cancel = rej; });
        dialing.add(cancel);
        let answered: string;
        try { answered = await Promise.race([m.connect(url, token), cancelled]); } finally { dialing.delete(cancel); }
        if (disposed) throw new Error('connection disposed');
        if (mine !== seq) throw new Error('superseded by a newer connect');
        machine = answered || '';
        connected = true;
        return answered;
      },
      disconnect() { seq++; connected = false; },
      dispose() { if (!disposed) { disposed = true; seq++; connected = false; calls?.push(`disposed:${key}`); for (const c of [...dialing]) c(new Error('connection disposed')); } },
      isConnected: () => connected,
      getMachineId: () => (connected ? machine : ''),
      getHostname: () => (connected ? `${machine || 'anon'}.host` : ''),
      setOnDisconnect: (fn: () => void) => { onDrop = fn; },
      subscribe: noop, unsubscribe: noop, resubscribeActive: noop,
      addPaneOutputListener: noop, removePaneOutputListener: noop,
      addPaneClosedListener: noop, removePaneClosedListener: noop,
      addTeamMessageListener: (fn: (m: unknown) => void) => { team.add(fn); },
      removeTeamMessageListener: (fn: (m: unknown) => void) => { team.delete(fn); },
      url: () => null,
    };
    const api: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(m)) {
      if (typeof fn !== 'function' || LIFECYCLE.has(name) || name.startsWith('__')) continue;
      api[name] = (...args: unknown[]) => {
        if (disposed) return Promise.reject(new Error('connection disposed'));
        if (!connected) return Promise.reject(new Error('not connected'));
        calls?.push(`rpc@${key}:${name}`);
        // Which connection is asking (③c: a mock answering per server).
        askingKey = key;
        try { return fn(...args); } finally { askingKey = ''; }
      };
    }
    conns.push({
      key, api: api as FakeConnection['api'], disposed: () => disposed, isConnected: () => connected, getMachineId: () => machine,
      drop() { if (connected && !disposed) { connected = false; onDrop?.(); } },
      push(message) { if (connected && !disposed) for (const fn of [...team]) fn(message); },
    });
    return { connection, api };
  };
  m.createConnectionRegistry = () => {
    const slots = new Map<string, ReturnType<typeof make>>();
    return {
      ensure: (key: string) => { let slot = slots.get(key); if (!slot) { slot = make(key); slots.set(key, slot); } return slot; },
      get: (key: string) => slots.get(key),
      take: (key: string) => { const slot = slots.get(key); slots.delete(key); return slot; },
      remove: (key: string) => { slots.get(key)?.connection.dispose(); slots.delete(key); },
      disposeAll: () => { for (const slot of slots.values()) slot.connection.dispose(); slots.clear(); },
    };
  };
  return module;
}

/** A transport that can actually connect, as one machine or another. */
function liveTransport(calls: string[], machine: () => string) {
  let connected = false;
  const rpc = (name: string, result: unknown = []) => () => {
    calls.push(name);
    return Promise.resolve(result);
  };
  return withSlot({
    __calls: calls,
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
    return Promise.resolve(result);
  };
  let wrapped: Record<string, any> | null = null;
  const net = {
    /** The socket closed under the app: every live connection drops, and
     * each one's runtime decides whether its reconnect loop takes over. */
    drop() { connected = false; onDrop?.(); for (const c of (wrapped?.__conns ?? []) as FakeConnection[]) c.drop(); },
    /** The independent connections the fleet made, in the order it made them. */
    conns: () => ((wrapped?.__conns ?? []) as FakeConnection[]),
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
  // The candidate is dial number 0 of an address: the same machine answers
  // and the same gate applies (a refused address refuses the candidate too).
  wrapped = withSlot({ __calls: calls, ...module }, async (url) => { const held = gate(url, 0); if (held) await held; return machineAt(url, 0); });
  return { module: wrapped, net };
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
  // Order (a), 04:04: C's own runtime dials and comes up FIRST, and only then
  // is the server left ended — its download suspended (part kept) on the
  // way. Until C is up, A's download is still A's, over A's own socket.
  assert.deepEqual(transfer(), ['connect:ws://a:9899', 'fetch', 'connect:ws://a:9899', 'connect:ws://c:9899', 'aborted'],
    'the switch away from it suspended it — once C was up');
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

test('a switch to a hubless server starts from ITS view: A s Hub answer does not come along (#335 ③a-4)', async (context) => {
  // Before ③a-4 the window held one view, reset by hand on a switch; the
  // Hub-answer line in that reset had no test (the a4 negative control did
  // not bite). Now each runtime has its own view, and B s is empty until B
  // answers for itself.
  let lastDial = '';
  const hubIfA = (value: unknown) => async () => (lastDial.includes('//a') ? value : Promise.reject(Object.assign(new Error('method not found'), { code: -32601 })));
  const { app, settle, switchTo } = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, (url) => { lastDial = url; return url.includes('//b') ? 'm-b' : 'm-a'; }, { rpc: {
    hubRooms: hubIfA({ rooms: {} }), hubUnread: hubIfA({ rooms: {} }), hubRead: hubIfA({ rooms: {} }), hubAgents: hubIfA({ agents: [] }),
    registryList: hubIfA({ agents: [] }), teamsList: hubIfA({ teams: [] }), hubLog: hubIfA({ messages: [], has_more: false }),
    hubActivity: hubIfA({ events: [], has_more: false }),
  }, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  assert.ok(app.document.querySelector('.rail-bell'), 'A has the Hub');
  await switchTo('beta');
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(app.document.querySelector('.rail-bell'), null, 'B answered for itself: no Hub, no bell');
  assert.equal(app.document.querySelector('.hub-root'), null, 'and no Hub page is mounted on B');
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

test('a boot dial that finds its alias absorbed brings the CANONICAL runtime up on its own connection (reviewer P1-B on cc45d7d1)', async (context) => {
  // The alias's own dial authenticates as m-a, whose canonical entry exists:
  // identity repair absorbs the alias and moves CURRENT. Knowing the
  // canonical id is not the canonical connection being up — every runtime
  // owns its socket — so canonical dials before anything comes up on it, the
  // app's RPCs go over THAT connection, and the alias's is ended.
  const events: string[] = [];
  const { app, onScreen, settle, net } = await bootApp(context, { ...aliasAndCanonical(legacyNav('work:1.0')), tmux_layout_mode: 'desktop' }, undefined, { calls: events });
  await settle();
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://a:9899', 'connect:ws://a:9899'],
    'two dials: the alias s, then the canonical runtime s own');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the dial folded the alias');
  assert.equal(onScreen(), 'work:1.0', 'and the app came up on that machine s navigation');
  const byKey = Object.fromEntries(net.conns().map((c) => [c.key, c]));
  assert.ok(byKey.canon?.isConnected(), 'canonical s OWN connection is the one up');
  assert.equal(byKey.alias?.disposed(), true, 'the alias s connection is ended');
  const rpcs = events.filter((e) => e.startsWith('rpc@'));
  assert.ok(rpcs.length > 0 && rpcs.every((e) => e.startsWith('rpc@canon:')), `every RPC went over canonical s connection: ${rpcs.join(' ')}`);
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
  // In the tree in FRONT: with Aggregate members, every tree has a Files page.
  const tree = () => app.document.querySelector('.scope-tree:not(.held)') ?? app.document;
  const row = tree().querySelector<HTMLButtonElement>('.file-main');
  assert.ok(row, 'the Files page in front lists a file');
  row.click(); await settle();
  tree().querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click(); await settle();
  const area = tree().querySelector<HTMLTextAreaElement>('.editor-layer textarea')!;
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
  // Through its own candidate since board #335 ②b-4.
  assert.ok(events.includes('candidate:ws://dead:9899'), 'the person s connect went out');
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

test('a switch while A s reconnect dial hangs: B dials and comes up first, A s download is suspended only then, and the late A dial changes nothing (ruling (a), 04:04)', async (context) => {
  // A is on screen with a download running. The socket drops and A's
  // reconnect dial hangs. The person picks beta. Each server has its own
  // connection, so B's candidate and B's own runtime dial at once; A keeps
  // its download until B is up — a failure would have returned to it intact
  // — and then the swap suspends it (part kept) before A is disposed. A's
  // hung dial, answering late, is nobody's: no identity, no tree.
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
  assert.deepEqual(trace().slice(4), ['connect:ws://b:9899', 'answered:ws://b:9899#3', 'aborted'],
    'B s own runtime dialled and answered, and only then was A s download suspended');
  assert.equal(h.net.conns().find((c) => c.key === 'a')?.disposed(), false, 'A is not disposed while its download settles');
  transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.net.conns().find((c) => c.key === 'a')?.disposed(), true, 'and is, once it has');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the app is on B');
  await h.app.advance(1000);
  assert.equal(h.onScreen(), 'work:2.0', 'with B s navigation');
  const servers = h.app.window.localStorage.getItem('tmux_servers');

  releaseR1();                                   // the hung dial answers, late
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(10_000);
  assert.ok(!trace().slice(8).some((e) => e.startsWith('connect:')), `nothing dialled after it: ${trace().slice(8).join(',')}`);
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

/** Is an absorption's slot move open (board #335 ③b: `tmux_slot_moves`,
 * one intent per pair, on every client)? */
const movesOpen = (ls: Storage) => (JSON.parse(ls.getItem('tmux_slot_moves') ?? '[]') as unknown[]).length > 0;
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
/** While the app is blocked on its storage, the server tree is HELD, not
 * gone (board #335 ③a; orchestrator 08:17, one mechanism, Single included):
 * every server page that is mounted sits inside the inert, hidden wrapper,
 * where no input reaches it and the write gate holds what it writes. Before
 * ③a these cases asserted that no server page was mounted at all. */
/** `inert`, however Svelte set it: jsdom has no `inert` property of its own,
 * so it may land as an attribute or as the property. */
const isInert = (el: any) => el.hasAttribute('inert') || el.inert === true;
const assertHeldTree = (app: any, what: string, opts: { source?: boolean; fresh?: boolean } = {}) => {
  const pages = [...app.document.querySelectorAll('.term-page, .files-page, .file-main')];
  // A first boot that never passed its gates has nothing to hold: no server
  // page at all (reviewer non-blocking 2 on 9958bbfd).
  if (opts.fresh) assert.equal(pages.length, 0, `${what}: no server page was mounted`);
  // Where the block came with a source tree (ruling K keeps it), that tree is
  // still there — an empty DOM must not pass for "held" (reviewer P2-4).
  if (opts.source) assert.ok(pages.length > 0, `${what}: the source tree is still mounted`);
  for (const el of pages) {
    const held = el.closest('.scope-tree.held');
    assert.ok(held, `${what}: ${el.className} is mounted outside the held tree`);
    assert.ok(isInert(held), `${what}: the held tree takes no input`);
  }
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
  assertHeldTree(h.app, 'no server page mounted', { fresh: true });
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

test('a deferred deep link that blocks again on its own Retry is still there for the next one (validator P2-a on ea56861b)', async (context) => {
  // Retry #1's preparation records A's fold, then APPLYING the link fails,
  // and the gate's own preparation cannot even read the marker: blocked
  // again in that same Retry. The link is consumed only once applying it did
  // not block (reviewer P1 on fedd17eb), so Retry #2 still has it.
  const store = { failing: true, trip: false, down: false };
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, {
    calls: events,
    setup(window: any) {
      const set = window.Storage.prototype.setItem;
      const get = window.Storage.prototype.getItem;
      window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (store.failing && k === 'tmux_state_layout') throw new Error('QuotaExceededError');
        if (store.trip && k === 'tmux_address') { store.trip = false; store.down = true; throw new Error('QuotaExceededError'); }
        return set.call(this, k, v);
      };
      window.Storage.prototype.getItem = function (this: Storage, k: string) {
        if (store.down && k === 'tmux_state_layout') throw new Error('SecurityError');
        return get.call(this, k);
      };
      window.history.replaceState(null, '', '/?addr=ws://b:9899&token=tokB');
    },
  });
  await h.app.advance(6000);
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'blocked at boot: the link waits');

  store.failing = false;
  store.trip = true;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(store.down, true, 'applying the link failed, and the gate could not read the marker');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the link was not applied');
  assert.ok(cardButton(h.app, /retry/iu), 'blocked again: Retry is offered');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'nothing dialled');

  store.down = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the second Retry applies the link it kept');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://b:9899'], 'and dials B');
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
  assertHeldTree(h.app, 'the claim could not be recorded: no server page', { source: true });
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

test('Retry after a mid-session block: A s own runtime dials once, and A comes up on it', async (context) => {
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
  assertHeldTree(h.app, 'blocked', { source: true });
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
  // Since board #335 ②b-4 the switch's candidate closed once identity was
  // recorded, and the block stopped A's OWN runtime before its dial: Retry
  // dials it once (the boot dial, re-armed), and nothing else.
  for (let i = 0; i < 4; i++) await h.settle();
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')).slice(n), ['connect:ws://a:9899'], 'A s own runtime dialled, once');
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

test('③d-3: Settings › Connection shows the pending inputs with ONE action, Discard — it asks first, Cancel changes nothing, confirming closes only that record; the owner arriving later folds nothing; the row is gone', async (context) => {
  // B is connected and current; the inputs (m-a's) are pending, nobody's.
  const first = await bootApp(context, danglingSeed(), undefined, { setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  await connectCard(first.app, first.settle, 'ws://b:9899');
  const ls = first.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending');
  const h = { app: first.app, settle: first.settle } as any;
  await toConnection(h);
  const row = () => first.app.document.querySelector<HTMLElement>('.preferences .pending-inputs');
  assert.ok(row(), 'the pending state is shown in Connection');
  assert.match(row()!.textContent ?? '', /m-a/u, 'named by the machine the legacy mirror named');
  const discard = () => [...row()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!;
  const before = { layout: ls.getItem('tmux_state_layout'), drafts: ls.getItem('tmux_hub_drafts'), quarantine: ls.getItem('tmux_state::unattributed'), b: ls.getItem('tmux_hub_drafts::b') };
  // Asks first; Cancel: nothing written.
  discard().click();
  for (let i = 0; i < 3; i++) await first.settle();
  assert.ok(first.app.document.querySelector('[role=alertdialog]'), 'a discard asks first');
  answerDialog(first.app, /^cancel$/iu);
  for (let i = 0; i < 3; i++) await first.settle();
  assert.equal(first.app.document.querySelector('[role=alertdialog]'), null);
  assert.equal(ls.getItem('tmux_state_layout'), before.layout, 'Cancel: the marker is as it was');
  assert.ok(row(), 'and the row stays');
  // Confirm: one write — the marker — and nothing else moves.
  discard().click();
  for (let i = 0; i < 3; i++) await first.settle();
  answerDialog(first.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await first.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'discarded' }, 'the record is closed');
  assert.equal(ls.getItem('tmux_hub_drafts'), before.drafts, 'the unprefixed inputs are left (a rolled-back build finds its state)');
  assert.equal(ls.getItem('tmux_state::unattributed'), before.quarantine, 'and the quarantine copy');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), before.b, 'B s own slot untouched');
  assert.equal(row(), null, 'the row is gone: nothing is pending');
  assert.equal(cardButton(first.app, /retry/iu), undefined, 'not a block');
  const after = dumpStorage(first.app);
  await first.app.close();
  // The owner (m-a) connects later: nothing folds — the person decided.
  const second = await bootApp(context, after, undefined, { setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  const ls2 = second.app.window.localStorage;
  await second.app.advance(1000);
  const h2 = { app: second.app, settle: second.settle, switchTo: second.switchTo } as any;
  await toConnection(h2);
  await pickServer(h2, 'alpha');
  for (let i = 0; i < 10 && ls2.getItem('tmux_server_current') !== 'a'; i++) { await second.app.advance(300); await second.settle(); }
  await second.app.advance(1000);
  assert.equal(ls2.getItem('tmux_server_current'), 'a');
  assert.deepEqual(JSON.parse(ls2.getItem('tmux_state_layout')!), { v: '335', state: 'discarded' }, 'still closed');
  assert.equal(ls2.getItem('tmux_hub_drafts::a'), null, 'the owner got nothing of the discarded inputs');
  assert.equal(second.app.document.querySelector('.preferences .pending-inputs'), null);
});

test('③d-3/P1-D1: a storage whose MARKER cannot be read at boot still mounts the shell, blocked with Retry and no dial — the pending row s read goes through the same gate, never a throw out of the component; Retry after the read recovers shows the row', async (context) => {
  const store = { down: true };
  const events: string[] = [];
  const h = await bootApp(context, { ...danglingSeed(), tmux_state_layout: JSON.stringify({ v: '335', state: 'pending', machineId: 'm-a' }) }, undefined, {
    calls: events,
    setup(window: any) {
      const get = window.Storage.prototype.getItem;
      window.Storage.prototype.getItem = function (this: Storage, k: string) {
        if (store.down && k === 'tmux_state_layout') throw new Error('SecurityError');
        return get.call(this, k);
      };
      window.Element.prototype.getAnimations = () => [];
    },
  });
  await h.app.advance(3000);
  assert.ok(h.app.document.querySelector('main'), 'the shell mounted');
  assert.ok(cardButton(h.app, /retry/iu), 'blocked: Retry offered');
  assert.deepEqual(events.filter((e) => e.startsWith('connect:') || e.startsWith('dial@')), [], 'nothing dialled');
  store.down = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  await toConnection({ app: h.app, settle: h.settle } as any);
  assert.ok(h.app.document.querySelector('.preferences .pending-inputs'), 'the pending row appears once the marker can be read');
});

test('③d-3/P1-D1 (residual): the projection s own read failing AFTER a successful claim is the gate s failure — blocked, no tree bound to the target, the server left intact, no further dial; Retry resumes', async (context) => {
  // The fold (migrate + claim) succeeds and writes the marker `folded`; the
  // very next read of the marker — the pending projection's — throws.
  const events: string[] = [];
  const state = { armed: false, folded: false, failed: 0 };
  const h = await bootApp(context, danglingSeed(), undefined, {
    calls: events,
    setup(window: any) {
      const set = window.Storage.prototype.setItem;
      const get = window.Storage.prototype.getItem;
      window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (state.armed && k === 'tmux_state_layout' && /"folded"/u.test(v)) state.folded = true;
        return set.call(this, k, v);
      };
      window.Storage.prototype.getItem = function (this: Storage, k: string) {
        if (state.armed && state.folded && k === 'tmux_state_layout') { state.failed++; state.armed = false; throw new Error('SecurityError'); }
        return get.call(this, k);
      };
      window.Element.prototype.getAnimations = () => [];
    },
  });
  await connectCard(h.app, h.settle, 'ws://b:9899');
  const ls = h.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending');
  const b = conn(h, 'b')!;
  const bApi = b.api;
  // Arm, then switch to A — the owner: A's bind claims the inputs (the fold
  // succeeds) and the projection read right after fails.
  state.armed = true;
  await h.switchTo('alpha');
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(state.failed, 1, 'exactly the post-fold projection read failed');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'folded', 'the claim itself was recorded');
  // Blocked: no tree bound to A, Retry offered, nothing more dialled. (The
  // server LEFT keeps serving reads — the K contract; this test does not
  // claim the write api is frozen, see the write-gate tests for that.)
  assert.ok(retryButton(h.app), 'blocked with Retry');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held)'), null, 'no tree is shown as the front');
  // B, the server left, keeps running (ruling (a): the source is given up
  // only once the target is bound — and nothing was bound).
  assert.ok(b.isConnected() && !b.disposed(), 'B is intact');
  await bApi.fsList!('/home');
  const dials = events.filter((e) => e.startsWith('dial@a:')).length;
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(events.filter((e) => e.startsWith('dial@a:')).length, dials, 'no further dial while blocked');
  // Retry: the read works now; A comes up.
  retryButton(h.app)!.click();
  for (let i = 0; i < 10; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)'), 'A s tree is the front after Retry');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft of m-a' }), 'the claimed inputs are A s');
});

test('③d-3/P1-D2 (residual): the confirmation is for ONE set — inputs rewritten by an old build meanwhile are not closed by it; the dialog is withdrawn and the new set asks afresh', async (context) => {
  const first = await bootApp(context, danglingSeed(), undefined, { setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  await connectCard(first.app, first.settle, 'ws://b:9899');
  const ls = first.app.window.localStorage;
  const h = { app: first.app, settle: first.settle } as any;
  await toConnection(h);
  const discard = () => [...first.app.document.querySelectorAll<HTMLButtonElement>('.preferences .pending-inputs button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!;
  discard().click();
  for (let i = 0; i < 3; i++) await first.settle();
  const dialog = () => first.app.document.querySelector('[role=alertdialog]');
  assert.ok(dialog(), 'asked for A s (m-a s) inputs');
  const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!;
  // An old build on the same origin rewrites the inputs as B's meanwhile;
  // B's own gate re-reads the evidence (still pending, now m-b's).
  ls.setItem('tmux_hub_drafts', JSON.stringify({ work: 'typed on B by the old build' }));
  ls.setItem('tmux_machine_id', 'm-c');   // (a THIRD machine: B cannot claim either, so the record stays pending for the rest of the test)
  // NO gate runs (reviewer P1-D2 on 30dcc2ad): no claim, no mode change, no
  // reconnect. The person presses the old Confirm: refused as stale; the
  // host re-reads the projection — which must now show the CURRENT evidence
  // (m-c's inputs), not the old marker's machine with the new set's key.
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).machineId, 'm-a', 'the marker itself still says m-a: nothing re-attributed it');
  confirm.click();
  for (let i = 0; i < 4; i++) await first.settle();
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the stale confirmation closed nothing');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).machineId, 'm-a', 'and wrote no marker');
  assert.equal(dialog(), null);
  // The row shows the CURRENT set; a fresh confirmation closes it.
  assert.match(first.app.document.querySelector('.preferences .pending-inputs')?.textContent ?? '', /m-c/u, 'the row names the current machine');
  discard().click();
  for (let i = 0; i < 3; i++) await first.settle();
  answerDialog(first.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await first.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'discarded' });
});

test('③d-3/P1-D2: a block that begins while the Discard confirmation waits withdraws it — the stale Confirm writes no marker; the record is still pending for Retry', async (context) => {
  // Single on B with m-a's inputs pending. While the confirmation waits, the
  // mode goes to Aggregate: A joins, its bind claims the pending inputs (A IS
  // m-a) — and that fold's write FAILS, so the gate blocks the app. The
  // dialog must go with the freeze, and its Confirm must write nothing.
  const store = refusing(['tmux_hub_drafts::a']);
  store.state.failing = false;
  const first = await bootApp(context, danglingSeed(), undefined, { setup(window: any) { store.setup(window); window.Element.prototype.getAnimations = () => []; } });
  await connectCard(first.app, first.settle, 'ws://b:9899');
  const ls = first.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending');
  const h = { app: first.app, settle: first.settle } as any;
  await toConnection(h);
  [...first.app.document.querySelectorAll<HTMLButtonElement>('.preferences .pending-inputs button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!.click();
  for (let i = 0; i < 3; i++) await first.settle();
  const dialog = () => first.app.document.querySelector('[role=alertdialog]');
  assert.ok(dialog(), 'the confirmation is up');
  const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!;
  store.state.failing = true;
  const toAggregate = modeButton(h, /all included|aggregate/iu);
  assert.ok(toAggregate, 'the mode control is on the page');
  toAggregate.click();
  for (let i = 0; i < 10; i++) { await first.app.advance(500); await first.settle(); }
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'the mode was written; A joined');
  assert.ok(first.app.document.querySelector('.preferences .pending-inputs button[disabled]'), 'blocked (A s claim could not be recorded): the row is frozen');
  assert.equal(dialog(), null, 'and the confirmation was withdrawn with the freeze');
  // The stale button, pressed anyway: the host refuses at the commit.
  confirm.click();
  for (let i = 0; i < 4; i++) await first.settle();
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the stale Confirm wrote no marker');
  assert.ok(first.app.document.querySelector('.preferences .pending-inputs'), 'the record is still shown, pending, for Retry');
});

test('③d-3: a discard whose marker write fails blocks like any migration write — Retry; the record stays pending', async (context) => {
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const first = await bootApp(context, danglingSeed(), undefined, { setup(window: any) { store.setup(window); window.Element.prototype.getAnimations = () => []; } });
  await connectCard(first.app, first.settle, 'ws://b:9899');
  const ls = first.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending');
  await toConnection({ app: first.app, settle: first.settle } as any);
  store.state.failing = true;
  [...first.app.document.querySelectorAll<HTMLButtonElement>('.preferences .pending-inputs button')].find((b) => /^discard$/iu.test(b.textContent?.trim() ?? ''))!.click();
  for (let i = 0; i < 3; i++) await first.settle();
  answerDialog(first.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await first.settle();
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'still pending: the write failed');
  assert.ok(first.app.document.querySelector('.preferences .pending-inputs'), 'the row stays (frozen with the registry)');
  assert.ok(first.app.document.querySelector('.preferences .pending-inputs button[disabled]'), 'and its Discard is frozen like the registry');
  // Back out of Settings: the content area's Retry panel is the block's.
  [...first.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')].find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
  for (let i = 0; i < 3; i++) await first.settle();
  assert.ok(retryButton(first.app), 'blocked, Retry offered');
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
  assertHeldTree(h.app, 'no server page');
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

test('pending → a link to the address-only alias → it answers as m-a and merges into canonical → the claim lands the latest legacy draft (reviewer P1 on cde052f7)', async (context) => {
  const { app } = await bootApp(context, {
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    ]),
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::a': JSON.stringify({ work: 'OLD-ALIAS' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  }, () => 'm-a', { setup(window) { window.history.replaceState(null, '', '/?addr=ws://alias:9899&token=tok'); } });
  await app.advance(1000);
  for (let i = 0; i < 4; i++) await app.flush();
  const ls = app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the alias was absorbed into canonical');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' }, 'and canonical claimed');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'LATEST' }, 'the latest legacy draft, not a moved park');
});

test('while blocked, rename and remove are refused with the reason, not ignored (reviewer P2 on cde052f7)', async (context) => {
  const store = refusing(['tmux_state_layout']);
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, { setup: store.setup });
  await h.app.advance(6000);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
  const list = h.app.document.querySelector('.preferences .server-list');
  assert.ok(list, 'the server list');
  assert.match(list.querySelector('[role=alert]')?.textContent ?? '', /could not write its storage/iu, 'the reason, on the list');
  const rename = list.querySelector<HTMLButtonElement>('button[aria-label^="Rename"]');
  const remove = list.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]');
  assert.ok(rename?.disabled, 'rename is disabled');
  assert.ok(remove?.disabled, 'and remove');
});

/** Storage as a failed alias→canonical slot move leaves it (reviewer's
 * fixture on 4807242f): m-a's inputs pending, the alias edited after that,
 * and the drafts slot write failing mid-move. Built with the real identity
 * and migration functions, then handed to a fresh App — a reload. */
function afterFailedMove(failKey = 'tmux_hub_drafts::c'): Record<string, string> {
  const m = new Map<string, string>(Object.entries({
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    ]),
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::a': JSON.stringify({ work: 'OLD-ALIAS' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  }));
  let failing = false;
  const store = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (failing && k === failKey) throw new Error('QuotaExceededError'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
  assert.equal(migrateServerState(store).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  failing = true;
  assert.throws(() => recordServer(store, { address: 'ws://alias:9899', token: 'tok', machineId: 'm-a' }), /Quota/u);
  if (failKey === 'tmux_hub_drafts::c') m.set('tmux_server_current', 'ghost');
  if (failKey === 'tmux_server_current') m.set('tmux_address', 'ws://alias:9899');
  if (failKey !== 'tmux_server_current') { m.set('tmux_address', ''); m.set('tmux_token', ''); }
  return Object.fromEntries(m);
}

test('a reload after a failed slot move finishes it; a connect straight to canonical then claims with the alias s edit (reviewer P1-A on 4807242f)', async (context) => {
  const seed = afterFailedMove();
  assert.ok((JSON.parse(seed.tmux_slot_moves ?? '[]') as unknown[]).length, 'the move is open in the seed');
  const { app, settle } = await bootApp(context, seed);
  const ls = app.window.localStorage;
  assert.equal(movesOpen(ls), false, 'the boot finished it');
  await connectCard(app, settle, 'ws://canonical:9899');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' });
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' }, 'the alias s real edit, not LATEST');
});

test('a reload after a failed slot move that still cannot finish it is blocked, and Retry finishes it (reviewer P1-A on 4807242f)', async (context) => {
  const store = refusing(['tmux_hub_drafts::c']);
  const { app, settle } = await bootApp(context, afterFailedMove(), undefined, { setup: store.setup });
  await app.advance(1000);
  const ls = app.window.localStorage;
  assert.ok(cardButton(app, /retry/iu), 'blocked: the card offers only Retry');
  assert.ok(movesOpen(ls), 'the intent is still open');
  store.state.failing = false;
  cardButton(app, /retry/iu)!.click();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(movesOpen(ls), false, 'Retry finished it');
  await connectCard(app, settle, 'ws://canonical:9899');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' });
});

test('a reload after an absorption whose registry commit failed: CURRENT is canonical, the boot dials it, and TYPED is what it claims (reviewer P1 on 6a2ba341)', async (context) => {
  const seed = afterFailedMove('tmux_servers');
  assert.equal(seed.tmux_server_current, 'c', 'CURRENT moved before the commit');
  assert.ok(JSON.parse(seed.tmux_servers!).some((e: any) => e.id === 'a'), 'the registry still lists the alias');
  const events: string[] = [];
  const { app } = await bootApp(context, seed, undefined, { calls: events });
  await app.advance(1000);
  const ls = app.window.localStorage;
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://canonical:9899'], 'the boot dials canonical, not a ghost');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' });
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' });
});

test('a reload after an absorption whose CURRENT write failed: CURRENT is the alias, the boot dials it, and the merge completes with TYPED (reviewer P2 on b5adcb3b)', async (context) => {
  const seed = afterFailedMove('tmux_server_current');
  assert.equal(seed.tmux_server_current, 'a');
  const events: string[] = [];
  const { app } = await bootApp(context, seed, () => 'm-a', { calls: events });
  await app.advance(1000);
  for (let i = 0; i < 4; i++) await app.flush();
  const ls = app.window.localStorage;
  // The alias's own dial, then canonical's OWN (reviewer P1-B on cc45d7d1:
  // the survivor dials before anything comes up on it).
  // (The merge made the address that just answered canonical's active one,
  // so its own dial goes there too.)
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://alias:9899', 'connect:ws://alias:9899'], 'the boot dials the alias, then canonical over its own connection');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'which answers as m-a and is merged into canonical');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' });
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' });
});

// ── The gate in production (reviewer P1 on 23879812): a write that fails
// inside a real connect blocks the app in that turn — no reload, nothing
// called by hand.

const aliasRegistry = JSON.stringify([
  { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
  { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
]);
const blockedNow = (app: any) => {
  const ls = app.window.localStorage;
  return { current: ls.getItem('tmux_server_current'), servers: ls.getItem('tmux_servers') };
};

test('the boot dial s identity write fails mid-handoff: blocked at once, frozen, and Retry finishes it and reconnects (reviewer P1 on 23879812)', async (context) => {
  // Pending first, then TYPED written to the alias: an edit, not an old park.
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry,
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::a': JSON.stringify({ work: 'OLD-ALIAS' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const store = refusing(['tmux_hub_drafts::c']);
  const events: string[] = [];
  const h = await bootApp(context, Object.fromEntries(m), () => 'm-a', { calls: events, setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://alias:9899&token=tok'); } });
  await h.app.advance(1000);
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://alias:9899'], 'the boot dialled the alias');
  assert.ok(movesOpen(ls), 'its merge left the handoff open');
  assert.ok(cardButton(h.app, /retry/iu), 'blocked in this turn: the card offers only Retry');
  assert.equal(cardButton(h.app, /^connect$/iu), undefined);
  assertHeldTree(h.app, 'no server tree');
  const frozen = blockedNow(h.app);
  const n = events.filter((e) => e.startsWith('connect:')).length;
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  await h.app.advance(30_000);
  assert.deepEqual(blockedNow(h.app), frozen, 'CURRENT and the registry frozen');
  assert.equal(events.filter((e) => e.startsWith('connect:')).length, n, 'and nothing dials');
  // Storage works again: Retry finishes the handoff and the boot dial runs again.
  store.state.failing = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(6000);
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(events.filter((e) => e.startsWith('connect:')).length > n, 'Retry reconnected');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the alias merged into canonical');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' });
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' }, 'TYPED kept');
  assert.ok(h.app.document.querySelector('.term-page'), 'and the server is up');
});

test('the connect form s identity write fails mid-handoff: blocked at once, the form offers only Retry, and after it the form connects (reviewer P1 on 23879812)', async (context) => {
  // Pending with the alias current and the person disconnected: the form is
  // what connects.
  const seed: Record<string, string> = {
    tmux_servers: aliasRegistry,
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  };
  const m = new Map(Object.entries(seed));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  m.set('tmux_disconnected', '1');
  const store = refusing(['tmux_hub_drafts::c']);
  store.state.failing = false;
  const events: string[] = [];
  const h = await bootApp(context, Object.fromEntries(m), () => 'm-a', { calls: events, setup: store.setup });
  await h.app.advance(1000);
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), [], 'disconnected: no boot dial');
  store.state.failing = true;
  await connectCard(h.app, h.settle, 'ws://alias:9899');
  const ls = h.app.window.localStorage;
  assert.ok(movesOpen(ls), 'the form s merge left the handoff open');
  assert.ok(cardButton(h.app, /retry/iu), 'blocked in this turn: the form offers only Retry');
  assert.equal(cardButton(h.app, /^connect$/iu), undefined, 'no Connect');
  assert.match(h.app.document.querySelector('.card .error')?.textContent ?? '', /could not write its storage/iu, 'and says why');
  store.state.failing = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(movesOpen(ls), false, 'Retry finished the handoff');
  await connectCard(h.app, h.settle, 'ws://alias:9899');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' }, 'TYPED kept');
});

test('a switch whose identity write fails mid-handoff: the migration Retry is the one exit, and it resumes the switch to its target (reviewer P1 on af59fb5d)', async (context) => {
  // m-a's inputs pending; the address-only alias is current, its boot dial
  // hangs; the person picks the alias in the switcher. Its auth reports m-a,
  // so the switch's activateSwitched absorbs it into canonical, and the slot
  // copy fails: the switch's own catch, not a fold after comeUp.
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry,
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_address', 'ws://alias:9899'); m.set('tmux_token', 'tok');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const store = refusing(['tmux_hub_drafts::c']);
  store.state.failing = false;
  const events: string[] = [];
  const h = await bootApp(context, Object.fromEntries(m), () => 'm-a',
    { calls: events, setup: store.setup, gate: (_url, n) => (n === 1 ? new Promise<void>(() => {}) : null) });
  assert.deepEqual(events.filter((e) => e.startsWith('connect:')), ['connect:ws://alias:9899'], 'the boot dial hangs');
  store.state.failing = true;
  await h.switchTo('alias');
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.ok(movesOpen(ls), 'the switch s merge left the handoff open');
  assert.equal([...h.app.document.querySelectorAll('.switch-panel')].length, 0, 'no switch-failed panel over it');
  assert.ok(cardButton(h.app, /retry/iu), 'the migration Retry is on screen');
  assertHeldTree(h.app, 'no server tree');
  // Retry while storage still fails: the same blocked exit.
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(cardButton(h.app, /retry/iu), 'still the one Retry');
  // Storage works again.
  store.state.failing = false;
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the switch resumed and arrived (the alias is canonical now)');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'c' });
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' }, 'TYPED kept');
  assert.ok(h.app.document.querySelector('.term-page'), 'and the server is up');
});

test('a Retry whose bind blocks again keeps the switch it owes: the next Retry still arrives (reviewer P1 on fedd17eb)', async (context) => {
  // Reviewer's switcher path, then a second failure during Retry's own bind:
  // the navigation's merge rewrite for the bound server cannot be written.
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry,
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    tmux_layout_mode: 'desktop',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_address', 'ws://alias:9899'); m.set('tmux_token', 'tok');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const refused = new Set<string>();
  const events: string[] = [];
  const h = await bootApp(context, Object.fromEntries(m), () => 'm-a', {
    calls: events,
    gate: (_url, n) => (n === 1 ? new Promise<void>(() => {}) : null),
    setup(window) {
      const set = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (refused.has(k)) throw new Error('QuotaExceededError');
        return set.call(this, k, v);
      };
    },
  });
  const ls = h.app.window.localStorage;
  refused.add('tmux_hub_drafts::c');
  await h.switchTo('alias');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(cardButton(h.app, /retry/iu), 'blocked by the switch s merge');
  // The handoff can finish now, but the bind's nav rewrite cannot: the bound
  // alias's record names an id the identity layer merged into it.
  refused.delete('tmux_hub_drafts::c');
  ls.setItem('tmux_server_merges', JSON.stringify({ zz: 'a' }));
  ls.setItem('tmux_state::a', savedNav('zz', 'work:1.0'));
  refused.add('tmux_state::a');
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(cardButton(h.app, /retry/iu), 'the bind blocked again: the same one Retry');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'and the switch did not run under the freeze');
  // Storage works: the next Retry still owes the switch, and makes it.
  refused.clear();
  cardButton(h.app, /retry/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the kept switch arrived');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED' });
  assert.ok(h.app.document.querySelector('.term-page'), 'and the server is up');
});

// ─── The connect form's candidate (board #335 ②b-4) ─────────────────────
// The form dials a candidate of its own; once identity is recorded it closes
// it, and the server's own runtime dials. That second handshake is the
// identity of record (orchestrator's addendum, 01:46), and nothing of the new
// server mounts before it answers.

test('a form connect to another server: candidate, close, then B s own dial; no B page before that dial answers', async (context) => {
  const calls: string[] = [];
  let letB: (() => void) | null = null;
  const { app, settle, reconnectThroughForm, net } = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    calls,
    // B's OWN dial is held; the candidate is not.
    gate: (url, n) => (n > 0 && url.includes('//b') ? new Promise<void>((r) => { letB = r; }) : null),
  });
  await reconnectThroughForm('ws://b:9899');
  const seq = calls.filter((c) => /^(candidate|candidate-closed|connect:)/u.test(c));
  assert.deepEqual(seq.slice(-3), ['candidate:ws://b:9899', 'candidate-closed', 'connect:ws://b:9899'],
    `the candidate answered and closed before B s own dial: ${seq.join(' → ')}`);
  // While B's own dial is out, nothing of B is bound: no RPC over B's
  // connection, and A's runtime has not been ended (ruling (a), 04:04).
  assert.deepEqual(calls.filter((c) => c.startsWith('rpc@b:')), [], 'nothing talks to B before its own handshake');
  const a = net.conns().find((c) => c.key === 'a')!;
  assert.equal(a.disposed(), false, 'and A is intact');
  letB!();
  await settle(); await settle();
  assert.ok(app.document.querySelector('.term-page'), 'B comes up once its own handshake answered');
  assert.ok(calls.some((c) => c.startsWith('rpc@b:')), 'over B s own connection');
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'b');
  assert.equal(a.disposed(), true, 'and only then is A ended');
});

test('B s own dial reaching ANOTHER machine is believed over the candidate (the runtime s handshake is the identity of record)', async (context) => {
  const calls: string[] = [];
  // The candidate reaches B; the runtime's own dial at the same address then
  // reaches A — an address can change hands between two handshakes.
  const machineAt: MachineAt = (url, n) => (n === 0 ? (url.includes('//b') ? 'm-b' : 'm-a') : 'm-a');
  const { app, settle, reconnectThroughForm } = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), machineAt, { calls });
  await reconnectThroughForm('ws://b:9899');
  await settle(); await settle();
  assert.ok(calls.includes('connect:ws://b:9899'), 'B s own dial ran');
  // That dial found A, so the app ARRIVES at A (as a boot dial that reaches
  // another known machine does), never comes up as B on A's socket.
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'a', 'the app follows what its own dial reached');
  const servers = JSON.parse(app.window.localStorage.getItem('tmux_servers') ?? '[]') as { id: string; machineId?: string }[];
  assert.equal(servers.find((s) => s.id === 'b')?.machineId, 'm-b', 'and B is not stamped with A s machine');
});

test('a form connect superseded while the server s own dial is out brings nothing up (the host activation generation)', async (context) => {
  const calls: string[] = [];
  let letB: (() => void) | null = null;
  const { app, settle, switchTo, reconnectThroughForm } = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
      { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
    ]),
  }, (url) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? 'm-c' : 'm-a'), {
    calls,
    gate: (url, n) => (n > 0 && url.includes('//b') && !letB ? new Promise<void>((r) => { letB = r; }) : null),
  });
  await reconnectThroughForm('ws://b:9899');               // B's own dial is held
  assert.ok(calls.includes('connect:ws://b:9899'), 'B s own dial is out');
  await switchTo('charlie');                                // a newer activation
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'c');
  letB!();                                                  // B's dial answers late
  await settle(); await settle();
  assert.equal(app.window.localStorage.getItem('tmux_server_current'), 'c', 'the late B answer moved nothing');
});

// ─── Reviewer on cc45d7d1: every server dials on its OWN connection ─────
// These run on the independent fake connections above (P2-2): a dial, an
// RPC and a dispose name the connection they happened on.

const dialsOf = (events: string[], key: string) => events.filter((e) => e.startsWith(`dial@${key}:`));
/** The LATEST connection made for `key` (a runtime let go of and minted
 * again gets a new one). */
const conn = (h: { net: { conns(): FakeConnection[] } }, key: string) => h.net.conns().filter((c) => c.key === key).at(-1);

test('P1-A: A s reconnect answering as B while A s leave dialog is open — a call A s page captured never reaches B', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    (_url, n) => (n === 1 ? 'm-a' : 'm-b'), { calls: events, rpc: editorRpc });
  await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  // What a page of A's holds for its whole life: a method of A's api.
  const captured = a.api.listSessions!;
  h.net.drop();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'A s editor asks about arriving at B');
  assert.deepEqual(dialsOf(events, 'a').slice(-1), ['dial@a:ws://a:9899|tokA'], 'A s loop dialled A s own address with A s own token');
  assert.equal(a.isConnected(), false, 'the socket that answered as B was closed by A s own dial');
  const before = events.length;
  await assert.rejects(captured(), /not connected/u, 'the captured call is refused');
  assert.ok(!events.slice(before).some((e) => e.startsWith('rpc@')), `and nothing went over any connection: ${events.slice(before).join(',')}`);
  assert.equal(conn(h, 'b'), undefined, 'B has no connection yet: nothing dialled it while the person is asked');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the arrival went to B');
  assert.ok(conn(h, 'b')?.isConnected(), 'over B s own connection');
  assert.equal(a.disposed(), true, 'and A s is ended');
});

test('P1-A: A s reconnect authenticating while the registry write fails closes that socket — nothing of A s reaches it', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, { calls: events });
  const a = conn(h, 'a')!;
  const captured = a.api.listSessions!;
  const setItem = h.app.window.Storage.prototype.setItem;
  h.app.window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    if (k === 'tmux_servers') throw new Error('QuotaExceededError');
    return setItem.call(this, k, v);
  };
  h.net.drop();
  for (let i = 0; i < 3; i++) await h.settle();
  h.app.window.Storage.prototype.setItem = setItem;
  assert.ok(dialsOf(events, 'a').length >= 2, 'A s loop dialled');
  assert.equal(a.isConnected(), false, 'the unidentified peer s socket is closed');
  await assert.rejects(captured(), /not connected/u, 'so a call captured earlier cannot reach it');
  assert.match(h.app.document.querySelector('.card .error')?.textContent ?? '', /could not be identified/iu);
});

test('P1-A: a failed connect to B that wrote the mirror does not hand A B s address or token', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    calls: events,
    // B refuses the candidate.
    gate: (url, n) => (n === 0 && url.includes('//b') ? Promise.reject(new Error('refused')) : null),
  });
  const gear = [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!;
  gear.click(); await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  await h.settle();
  const set = (selector: string, value: string) => {
    const input = h.app.document.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  };
  set('.card .fields input[type="text"]', 'ws://b:9899');
  set('.card input[type="password"]', 'tokEvil');
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_address'), 'ws://b:9899', 'the form wrote the mirror before its dial failed');
  assert.equal(h.app.window.localStorage.getItem('tmux_token'), 'tokEvil');
  // Coming back to the app reconnects A — from A's entry.
  const before = dialsOf(events, 'a').length;
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await h.settle();
  const after = dialsOf(events, 'a').slice(before);
  assert.ok(after.length > 0, 'A reconnected');
  assert.deepEqual([...new Set(after)], ['dial@a:ws://a:9899|tokA'], `with A s own address and token, never the mirror s: ${after.join(',')}`);
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a');
});

test('P1-B: a failover that absorbs the alias brings canonical up on ITS connection, and the alias s is ended', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, { ...aliasAndCanonical(legacyNav('work:1.0')), tmux_layout_mode: 'desktop' }, learnsItsMachineLater, { calls: events });
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'alias');
  const before = events.length;
  h.net.drop();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'canon', 'the failover absorbed the alias');
  assert.ok(dialsOf(events, 'canon').length >= 1, 'canonical dialled on its own connection');
  assert.ok(conn(h, 'canon')?.isConnected(), 'and that connection is the one up');
  assert.equal(conn(h, 'alias')?.disposed(), true, 'the alias s is ended');
  await h.openSession('other');
  const rpcs = events.slice(before).filter((e) => e.startsWith('rpc@'));
  assert.ok(rpcs.length > 0 && rpcs.every((e) => e.startsWith('rpc@canon:')), `the app talks over canonical s connection: ${rpcs.join(' ')}`);
});

test('P1-C: a bring-up that reuses B s runtime is not ended by the stale one that minted it', async (context) => {
  // H1: the form's connect to B — B's own dial held. H2: A's reconnect,
  // reaching B's machine, arrives at B and REUSES that runtime with a dial of
  // its own (held too). H1 is then cancelled; H2 answers. B stays, alive
  // and serving, and is the one bound.
  const events: string[] = [];
  const held = new Map<number, () => void>();
  const hold = (n: number) => new Promise<void>((resolve) => { held.set(n, resolve); });
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 1 ? 'm-a' : n === 0 ? (url.includes('//b') ? 'm-b' : 'm-a') : 'm-b'),
    { calls: events, gate: (_url, n) => (n === 2 || n === 4 ? hold(n) : null) });
  await h.reconnectThroughForm('ws://b:9899');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the form recorded B');
  assert.equal(dialsOf(events, 'b').length, 1, 'H1: B s own dial is out');
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(dialsOf(events, 'b').length, 2, 'H2: A s reconnect reached B s machine, and B s runtime dials again');
  const b = conn(h, 'b')!;
  assert.equal(h.net.conns().filter((c) => c.key === 'b').length, 1, 'the SAME runtime — one connection for B');
  const cancel = [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()));
  assert.ok(cancel, 'the form is still busy with H1');
  cancel.click();
  await h.settle();
  assert.equal(b.disposed(), false, 'cancelling H1 does not end the runtime H2 is dialling');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'nor does it put CURRENT back: H2 owns that');
  held.get(4)!();                                          // H2 answers
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(b.isConnected() && !b.disposed(), 'B is up on its connection');
  held.get(2)!();                                          // H1, late
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(b.isConnected() && !b.disposed(), 'and still is after H1 s late answer');
  await assert.doesNotReject(b.api.listSessions!(), 'B serves RPCs');
  assert.equal(conn(h, 'a')?.disposed(), true, 'A was ended once B was bound');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b');
});

test('P1-C: a boot dial with nothing bound yet mints its runtime first and is still the latest — it comes up', async (context) => {
  // The boot's FALLBACK (reviewer P1-C on cc45d7d1): the migration blocked
  // the boot, so nothing is bound when Retry re-arms the dial. That dial
  // mints CURRENT's runtime, and the mint ends every attempt in flight; a
  // claim taken before it was ended by it, and the boot never came up.
  const store = refusing(['tmux_state_layout']);
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_layout_mode: 'desktop',
  }, undefined, { calls: events, setup: store.setup });
  await h.app.advance(6000);
  assertHeldTree(h.app, 'blocked: nothing is bound', { fresh: true });
  store.state.failing = false;
  const retry = cardButton(h.app, /retry/iu);
  assert.ok(retry, 'the card offers Retry');
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.deepEqual(dialsOf(events, 'a'), ['dial@a:ws://a:9899|tokA'], 'ONE dial, on A s own connection');
  assert.equal(h.onScreen(), 'work:1.0', 'and the boot came up on it');
  assert.ok(events.some((e) => e.startsWith('rpc@a:')), 'talking over that connection');
});

test('P1-D: Cancel while B s own dial is out binds nothing when it answers, leaves no B connection, and keeps A', async (context) => {
  const events: string[] = [];
  let letB: () => void = () => {};
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    calls: events,
    gate: (url, n) => (n > 0 && url.includes('//b') ? new Promise<void>((r) => { letB = r; }) : null),
  });
  await h.reconnectThroughForm('ws://b:9899');
  assert.equal(dialsOf(events, 'b').length, 1, 'B s own dial is out');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()))!.click();
  await h.settle();
  assert.equal(conn(h, 'b')?.disposed(), true, 'the cancelled bring-up s connection is ended at once');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'CURRENT is back on A');
  letB();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(!events.some((e) => e.startsWith('rpc@b:')), 'nothing was ever bound to B');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is intact');
  assert.ok([...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].some((x) => /^connect$/iu.test((x.textContent ?? '').trim())),
    'and the form offers Connect again');
});

test('P1-D: B s own dial failing shows its error on the form, leaves A as it was, and Connect works again', async (context) => {
  const events: string[] = [];
  let refuse = true;
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    calls: events,
    gate: (url, n) => (n > 0 && url.includes('//b') && refuse ? Promise.reject(new Error('B refused its own dial')) : null),
  });
  await h.reconnectThroughForm('ws://b:9899');
  assert.match(h.app.document.querySelector('.card .error')?.textContent ?? '', /B refused its own dial/u, 'the second handshake s failure is shown');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'CURRENT is back on A');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is intact');
  refuse = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^connect$/iu.test((x.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'b', 'the retry arrived at B');
  assert.ok(conn(h, 'b')?.isConnected(), 'on B s own connection');
});

test('P2-1: the App s own end disposes every connection it holds, the one bound to nothing included', async (context) => {
  // A switch to B is out with B's own dial held, so B's runtime is in the
  // fleet and bound to nothing. The shell goes away.
  const events: string[] = [];
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    calls: events,
    gate: (url, n) => (n > 0 && url.includes('//b') ? new Promise<void>(() => {}) : null),
  });
  await h.switchTo('beta');
  assert.equal(dialsOf(events, 'b').length, 1, 'B s own dial is out');
  await h.app.unmount();
  assert.deepEqual(h.net.conns().filter((c) => !c.disposed()).map((c) => c.key), [], 'every connection is disposed');
});

test('P2-1: the App s own end stops every reconnect loop', async (context) => {
  // A's socket dropped and every reconnect fails, so its loop keeps
  // retrying. A loop asks how to classify the address it is about to dial
  // on every attempt: that is how a case sees it still running.
  let attempts = 0;
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    rpc: { classifyAddress: () => { attempts++; return 2; } },
    gate: (_url, n) => (n > 1 ? Promise.reject(new Error('down')) : null),
  });
  h.net.drop();
  for (let i = 0; i < 3; i++) { await h.app.advance(5_000); await h.settle(); }
  assert.ok(attempts > 0, 'A s loop is retrying');
  await h.app.unmount();
  const before = attempts;
  for (let i = 0; i < 6; i++) await h.app.advance(30_000);
  assert.equal(attempts, before, 'and stops with the shell');
});

test('order (a): a failed switch s Back returns to A on the SAME connection, with A s latest navigation from its slot (reviewer 04:05)', async (context) => {
  // A's runtime, connection and — since #335 ③b (reviewer P1-1 on 99566068:
  // nothing a switch does not replace goes with it) — its tree survive a
  // failed switch: Back is A as it was, on the same connection, and its
  // record is still A's latest navigation.
  const events: string[] = [];
  const h = await bootApp(context,
    { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, { calls: events, gate: (url, n) => (n > 0 && url.includes('//b') ? Promise.reject(new Error('B refused')) : null) });
  await h.openSession('other');                            // A's latest navigation
  assert.equal(h.restored(), 'a:other:3.0');
  const a = conn(h, 'a')!;
  await h.switchTo('beta');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'B did not come up: CURRENT is back on A');
  assert.equal(conn(h, 'b')?.disposed() ?? true, true, 'B left no live connection');
  assert.ok(a.isConnected() && !a.disposed(), 'A s connection was never touched');
  const back = [...h.app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^back to/iu.test((b.textContent ?? '').trim()));
  assert.ok(back, 'the failed switch offers Back');
  back.click();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(conn(h, 'a'), a, 'Back is A on the same connection, not a new one');
  assert.ok(a.isConnected() && !a.disposed());
  assert.equal(trees(h.app).length, 1, 'one tree, A s');
  assert.ok(!trees(h.app)[0]!.held, 'in front again');
  assert.equal(h.restored(), 'a:other:3.0', 'with A s latest navigation in A s slot');
});

// ─── Reviewer's re-review of 341554b3: the four boundaries ──────────────

const cardHas = (app: any, name: RegExp) => !!cardButton(app, name);

test('P1-1: Cancel while a KEPT A s second handshake is out — when it answers as B, A s api reaches nobody, and A can dial again', async (context) => {
  const events: string[] = [];
  let letA2: () => void = () => {};
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 2 ? 'm-b' : url.includes('//b') ? 'm-b' : 'm-a'),
    { calls: events, gate: (url, n) => (n === 2 && url.includes('//a') ? new Promise<void>((r) => { letA2 = r; }) : null) });
  const a = conn(h, 'a')!;
  const captured = a.api.listSessions!;
  const { submit } = await toTheCard(h.app, h.settle, 'ws://a:9899');
  await submit();
  assert.equal(dialsOf(events, 'a').length, 2, 'the candidate confirmed A, and A s own (kept) runtime dials');
  assert.ok(cardHas(h.app, /^cancel$/iu), 'the form is busy with that second handshake');
  cardButton(h.app, /^cancel$/iu)!.click();
  await h.settle();
  letA2();                                                  // it answers — as B
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(a.isConnected(), false, 'the unverified peer s socket is closed');
  const before = events.length;
  await assert.rejects(captured(), /not connected/u, 'a call A s page captured is refused');
  assert.ok(!events.slice(before).some((e) => e.startsWith('rpc@')), 'and reached no connection');
  assert.equal(conn(h, 'a'), a, 'A is still A s handle and connection');
  // A legitimate connect to A later reuses it.
  cardButton(h.app, /^connect$/iu)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(a.isConnected() && !a.disposed(), 'A dialled again on the same connection');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a');
});

test('P1-1: a kept A s second handshake that another candidate takes over — not a dial on A s connection — closes when it answers as B', async (context) => {
  const events: string[] = [];
  let letA2: () => void = () => {};
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    (url, n) => (n === 2 ? 'm-b' : url.includes('//b') ? 'm-b' : 'm-a'),
    { calls: events, gate: (url, n) => (n === 2 && url.includes('//a') ? new Promise<void>((r) => { letA2 = r; })
      : n > 2 && url.includes('//b') ? new Promise<void>(() => {}) : null) });
  const a = conn(h, 'a')!;
  const { submit } = await toTheCard(h.app, h.settle, 'ws://a:9899');
  await submit();
  assert.equal(dialsOf(events, 'a').length, 2, 'A s second handshake is out');
  await h.switchTo('beta');                                 // another candidate claims the app
  assert.ok(events.includes('candidate:ws://b:9899'), 'the switch dialled its own candidate');
  const aDials = dialsOf(events, 'a').length;
  letA2();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(dialsOf(events, 'a').length, aDials, 'nothing dialled A s connection again');
  assert.equal(a.isConnected(), false, 'and the peer A s stale handshake reached is closed');
  const captured = a.api.listSessions!;
  await assert.rejects(captured(), /not connected/u, 'a call of A s reaches nobody');
});

test('P1-2: an address change still out when a newer activation takes over records nothing and opens no arrival when it answers as another machine', async (context) => {
  const events: string[] = [];
  let letLan: () => void = () => {};
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }, (url) => (url.includes('//b') || url.includes('a-lan') ? 'm-b' : 'm-a'), {
    calls: events,
    rpc: { classifyAddress: (x: string) => (x.includes('lan') ? 0 : 2), findBestAddress: async () => 'ws://a-lan:9899' },
    gate: (url, n) => (url.includes('a-lan') ? new Promise<void>((r) => { letLan = r; })
      : n > 0 && url.includes('//b') ? new Promise<void>(() => {}) : null),
  });
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(events.includes('dial@a:ws://a-lan:9899|tokA'), 'the optimizer s redial of A is out');
  await h.switchTo('beta');                                 // a newer activation; A stays bound
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is still bound while B s own dial is out');
  const registry = h.app.window.localStorage.getItem('tmux_servers');
  letLan();                                                 // the old redial answers — as B
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_servers'), registry, 'it recorded nothing');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'and opened no arrival');
  assert.equal(conn(h, 'a')?.isConnected(), false, 'its unverified socket is closed');
});

test('P1-3 (ruling K): a dial whose post-dial claim cannot be written publishes nothing, keeps A running, mounts no server tree; Retry finishes the switch', async (context) => {
  // A is current and knows its machine; the legacy inputs are pending for
  // m-x, the machine B turns out to be. B's entry does not know it yet, and
  // the switch's candidate learns nothing — only B's OWN dial proves m-x,
  // and that is when the claim runs. Its marker write fails.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = JSON.parse(twoServers({ live: '', parked: '' }).tmux_servers);
  delete servers[1].machineId;
  const events: string[] = [];
  const transfer = slowTransfer(events);
  const h = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers),
    tmux_machine_id: 'm-x',
    tmux_server_current: 'gone',
    tmux_hub_drafts: JSON.stringify({ work: 'draft of m-x' }),
    tmux_layout_mode: 'desktop',
  }, (url, n) => (n === 0 ? '' : url.includes('//b') ? 'm-x' : 'm-a'), {
    calls: events, rpc: transfer.rpc,
    setup(window) { store.setup(window); transfer.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  await h.app.advance(1000);
  const ls = h.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the inputs wait for m-x');
  await startDownload(h.app, h.settle);
  const a = conn(h, 'a')!;
  store.state.failing = true;
  await h.switchTo('beta');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_servers')!.includes('m-x'), true, 'B s own dial proved m-x');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'and the claim s marker could not be written');
  assertHeldTree(h.app, 'no writable server tree is mounted', { source: true });
  assert.ok(!events.some((e) => e.startsWith('rpc@b:')), 'nothing of B was published');
  assert.ok(a.isConnected() && !a.disposed(), 'A was not ended by the block');
  assert.ok(!events.includes('aborted'), 'and A s download is still running');
  // Storage recovers; Retry, from the blocked panel.
  store.state.failing = false;
  const retry = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry, 'Retry is offered');
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'b' }, 'Retry folded the inputs into B');
  assert.ok(events.includes('aborted'), 'only then is A given up: its download suspended');
  transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.equal(a.disposed(), true, 'and A ended, once B passed every gate');
  assert.ok(conn(h, 'b')?.isConnected(), 'B is up on its own connection');
  assert.equal(ls.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft of m-x' }));
});

test('P1-3: a form connect to another server is not DONE before B is bound — the form stays busy while A s download settles', async (context) => {
  const events: string[] = [];
  const transfer = slowTransfer(events);
  const h = await bootApp(context,
    { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, { calls: events, rpc: transfer.rpc, setup: transfer.setup });
  await startDownload(h.app, h.settle);
  const { submit } = await toTheCard(h.app, h.settle, 'ws://b:9899');
  await submit();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(events.includes('aborted'), 'B passed its gates and A was given up');
  const busy = () => !!h.app.document.querySelector('.card .connect-btn.connecting');
  assert.ok(busy(), 'but the activation is not done: the bind waits on A s release');
  // Past its point of no return a cancel undoes nothing, so none is offered
  // (reviewer P2 on 027d1a92).
  assert.ok(!cardHas(h.app, /^cancel$/iu), 'and the form offers no Cancel it could not honour');
  transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(!busy(), 'once B is bound, the form is free');
  assert.equal(h.app.document.querySelector('.card .error'), null, 'with no error');
});

test('P1-4: a form connect redirected to ANOTHER server keeps the form busy through that server s own dial; Cancel there binds nothing', async (context) => {
  const events: string[] = [];
  let letC: () => void = () => {};
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
      { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
    ]),
  }, (url, n) => (url.includes('//c') ? 'm-c' : url.includes('//b') ? (n === 0 ? 'm-b' : 'm-c') : 'm-a'), {
    calls: events,
    // C's own dial is the third: the address that answered as m-c is where
    // C is reached now (the dial recorded it on C's entry).
    gate: (_url, n) => (n === 3 ? new Promise<void>((r) => { letC = r; }) : null),
  });
  const { submit } = await toTheCard(h.app, h.settle, 'ws://b:9899');
  await submit();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(dialsOf(events, 'c').length, 1, 'B s own dial reached C, and C s own runtime dials');
  assert.ok(cardHas(h.app, /^cancel$/iu), 'the form is still busy: the activation is not over');
  cardButton(h.app, /^cancel$/iu)!.click();
  await h.settle();
  assert.equal(conn(h, 'c')?.disposed(), true, 'the redirect s runtime is let go of');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'CURRENT back on A');
  letC();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(!events.some((e) => e.startsWith('rpc@c:')), 'nothing was bound to C');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is intact (disconnected only by the form s own Disconnect)');
});

test('P1-4: a redirect whose own dial FAILS reports on the form and returns to A', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
      { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
    ]),
  }, (url, n) => (url.includes('//c') ? 'm-c' : url.includes('//b') ? (n === 0 ? 'm-b' : 'm-c') : 'm-a'), {
    calls: events,
    gate: (_url, n) => (n === 3 ? Promise.reject(new Error('C refused its own dial')) : null),
  });
  const { submit } = await toTheCard(h.app, h.settle, 'ws://b:9899');
  await submit();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.match(h.app.document.querySelector('.card .error')?.textContent ?? '', /C refused its own dial/u, 'the last link s failure is the form s');
  assert.ok(cardHas(h.app, /^connect$/iu), 'and the form is free');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'CURRENT is back on A');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is intact (disconnected only by the form s own Disconnect)');
});

test('P1-4: a form connect whose dial teaches the gate a claim keeps the form busy through the fresh runtime s dial; Cancel there binds nothing', async (context) => {
  // A does not know its machine; the inputs wait for m-a. The boot dial and
  // the candidate learn nothing; A's own (kept) dial in the form's activation
  // proves m-a, the claim files the inputs into A's slots, and a fresh A
  // runtime — one that reads them — dials as the next link.
  const servers = JSON.parse(twoServers({ live: '', parked: '' }).tmux_servers);
  delete servers[0].machineId;
  const events: string[] = [];
  let letA3: () => void = () => {};
  const h = await bootApp(context, danglingSeed({ tmux_servers: JSON.stringify(servers) }),
    (url, n) => (n < 2 ? '' : url.includes('//b') ? 'm-b' : 'm-a'), {
      calls: events,
      gate: (url, n) => (n === 3 && url.includes('//a') ? new Promise<void>((r) => { letA3 = r; }) : null),
      setup(window) { window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
    });
  await h.app.advance(1000);
  const ls = h.app.window.localStorage;
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'boot could not prove m-a');
  const first = conn(h, 'a')!;
  const { submit } = await toTheCard(h.app, h.settle, 'ws://a:9899');
  await submit();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'a' }, 'the dial s gate claimed the inputs');
  const fresh = conn(h, 'a')!;
  assert.notEqual(fresh, first, 'a fresh A runtime, on a connection of its own, dials as the next link');
  assert.ok(cardHas(h.app, /^cancel$/iu), 'and the form is still busy with it');
  cardButton(h.app, /^cancel$/iu)!.click();
  await h.settle();
  assert.equal(fresh.disposed(), true, 'Cancel let go of that runtime');
  letA3();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(fresh.isConnected(), false, 'its late answer bound nothing: the connection stays ended');
  assert.ok(!cardHas(h.app, /^cancel$/iu), 'and the form is free');
});

test('P2: the App s end clears every reconnect timer at once, not at its next tick', async (context) => {
  const h = await bootApp(context, twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), undefined, {
    gate: (_url, n) => (n > 1 ? Promise.reject(new Error('down')) : null),
  });
  // Track the timers the reconnect machine arms. The app runs in the
  // window's context, and the machine reads that context's timers when a
  // runtime's loop is first built — which the drop below does.
  const win = h.app.window as any;
  const live = new Set<unknown>();
  const set = win.setTimeout;
  const clear = win.clearTimeout;
  const owner = new Map<unknown, string>();
  win.setTimeout = (fn: () => void, ms?: number) => {
    const stack = new Error().stack ?? '';
    let id: unknown;
    id = set(() => { live.delete(id); fn(); }, ms);
    live.add(id);
    owner.set(id, stack.split('\n').slice(2, 3).join('').trim());
    return id;
  };
  win.clearTimeout = (id: unknown) => { live.delete(id); clear(id); };
  h.net.drop();
  for (let i = 0; i < 2; i++) { await h.app.advance(600); await h.settle(); }
  assert.ok([...live].some((id) => /armWatchdog/u.test(owner.get(id) ?? '')), 'the loop has its watchdog armed');
  await h.app.unmount();
  assert.deepEqual([...live].map((id) => owner.get(id)), [], 'and no timer armed since the drop survives the shell');
});

test('P1-2: a reconnect dial a form TOOK OVER (its candidate claimed the app) records nothing when it answers late as another machine', async (context) => {
  // R1 hangs. The person connects to B through the card and lets A's editor
  // go: B's candidate claims the app, and B's own dial is held, so A is
  // still bound and its connection alive. R1 then answers — as B. It is
  // not the app's attempt any more, and its dial must know that ITSELF.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = await gaveUpOnA(context, (url, n) => (url.includes('//a') ? held : n > 0 && url.includes('//b') ? new Promise<void>(() => {}) : null));
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));
  await h.settle();
  assert.equal(h.dials().at(-1), 'connect:ws://a:9899', 'R1 is out');
  h.field.value = 'ws://b:9899';
  h.field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /connect/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(h.events.includes('candidate:ws://b:9899'), 'the form s candidate took over');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is still bound: B s own dial is out');
  const registry = h.app.window.localStorage.getItem('tmux_servers');
  release();                                       // R1 answers — as B
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_servers'), registry, 'it recorded nothing');
  assert.equal(h.dialogs(), 0, 'and opened no arrival');
  assert.equal(conn(h, 'a')?.isConnected(), false, 'its unverified socket is closed');
});

// ─── Reviewer on 027d1a92: every way into the blocked state keeps the
// source (ruling K), and no editor of it mounts while blocked.

/** A on screen and running, pending inputs for m-x, B the m-x server. */
async function aRunningWithInputsFor(context: TestContext, bKnowsItsMachine: boolean, more: { rpc?: Record<string, unknown>; layout?: string } = {}) {
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = JSON.parse(twoServers({ live: '', parked: '' }).tmux_servers);
  if (bKnowsItsMachine) servers[1].machineId = 'm-x'; else delete servers[1].machineId;
  const events: string[] = [];
  const transfer = slowTransfer(events);
  const h = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers),
    tmux_machine_id: 'm-x',
    tmux_server_current: 'gone',
    tmux_hub_drafts: JSON.stringify({ work: 'draft of m-x' }),
    tmux_layout_mode: more.layout ?? 'desktop',
  }, (url, n) => (url.includes('//b') ? (n === 0 && !bKnowsItsMachine ? '' : 'm-x') : 'm-a'), {
    calls: events, rpc: { ...transfer.rpc, ...more.rpc },
    setup(window) { store.setup(window); transfer.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  await h.app.advance(1000);
  return { ...h, store, events, transfer, ls: h.app.window.localStorage };
}
const retryButton = (app: any) => [...app.document.querySelectorAll('.switch-panel button, .card button')]
  .find((b: any) => /retry/iu.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

test('K, the PRE-dial entry: B s claim fails when B is minted — A keeps running with its download, no tree, and Retry ends A only once B is bound (reviewer on 027d1a92)', async (context) => {
  const h = await aRunningWithInputsFor(context, true);
  assert.equal(JSON.parse(h.ls.getItem('tmux_state_layout')!).state, 'pending', 'the inputs wait for m-x');
  await startDownload(h.app, h.settle);
  const a = conn(h, 'a')!;
  h.store.state.failing = true;
  await h.switchTo('beta');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(dialsOf(h.events, 'b').length, 0, 'B was blocked before its own dial');
  assertHeldTree(h.app, 'no writable server tree is mounted', { source: true });
  assert.ok(a.isConnected() && !a.disposed(), 'A was not ended by the block');
  assert.ok(!h.events.includes('aborted'), 'and A s download was not released');
  h.store.state.failing = false;
  const retry = retryButton(h.app);
  assert.ok(retry, 'Retry is offered');
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.deepEqual(JSON.parse(h.ls.getItem('tmux_state_layout')!), { v: '335', state: 'folded', into: 'b' }, 'Retry folded the inputs into B');
  assert.ok(h.events.includes('aborted'), 'only then is A given up');
  h.transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.equal(a.disposed(), true, 'and ended, once B passed every gate');
  assert.ok(conn(h, 'b')?.isConnected(), 'B is up on its own connection');
});

test('K, the HOST-GATE entry: the form s candidate identity write fails mid-handoff — the source keeps running, no tree, and it ends only once the survivor is bound (reviewer on 027d1a92)', async (context) => {
  // The alias is current and connected, a download running; the inputs wait
  // for m-a. The person connects through the card: the candidate reports
  // m-a, `activateConnected` absorbs the alias into canonical, and the slot
  // copy fails — the form reports it, and the host gate blocks.
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry,
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'),
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    tmux_layout_mode: 'desktop',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_address', 'ws://alias:9899'); m.set('tmux_token', 'tok');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const store = refusing(['tmux_hub_drafts::c']);
  store.state.failing = false;
  const events: string[] = [];
  const transfer = slowTransfer(events);
  const h = await bootApp(context, Object.fromEntries(m), (_url, n) => (n === 1 ? '' : 'm-a'),
    { calls: events, rpc: transfer.rpc, setup(window) { store.setup(window); transfer.setup(window); } });
  await startDownload(h.app, h.settle);
  const alias = conn(h, 'a')!;
  store.state.failing = true;
  const { submit } = await toTheCard(h.app, h.settle, 'ws://alias:9899');
  await submit();
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.ok(movesOpen(ls), 'the absorption left the handoff open');
  assert.ok(retryButton(h.app), 'blocked: the migration Retry is offered');
  assertHeldTree(h.app, 'no writable server tree is mounted', { source: true });
  assert.equal(alias.disposed(), false, 'the source was not ended by the block');
  assert.ok(!events.includes('aborted'), 'and its download was not released');
  store.state.failing = false;
  retryButton(h.app)!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  // The registry write never committed, so the handoff resumes on the
  // alias side: CURRENT stays the alias, the move is closed.
  assert.equal(movesOpen(ls), false, 'Retry closed the open handoff');
  assert.equal(alias.disposed(), false, 'and still ended nothing');
  // The person connects again: the survivor's own runtime dials and is bound.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  assert.ok(conn(h, 'c')?.isConnected(), 'the survivor is up on its own connection');
  assert.equal(alias.disposed(), true, 'and only then is the source ended');
  assert.ok(!events.includes('aborted'), 'the same machine adopted its download');
});

for (const keep of [false, true]) test(`a block keeps an unsaved editor: held mounted with its text, it saves nothing, is there after Retry, and is asked before Retry s re-dial replaces it — ${keep ? 'Keep editing' : 'Discard'} (#335 ③a; orchestrator 08:17, 16:12)`, async (context) => {
  // The alias is current with an unsaved Files editor; its boot dial did not
  // learn a machine. The socket drops, the reconnect proves m-a, the identity
  // layer absorbs the alias into canonical, the slot copy fails, and the host
  // gate blocks. Before ③a the tree unmounted here and the text was gone.
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry, tmux_server_current: 'ghost', tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'), tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }), tmux_layout_mode: 'desktop',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_address', 'ws://alias:9899'); m.set('tmux_token', 'tok');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const store = refusing(['tmux_hub_drafts::c']);
  store.state.failing = false;
  const events: string[] = [];
  let proves = false;   // the alias answers without a machine until the drop
  const h = await bootApp(context, Object.fromEntries(m), () => (proves ? 'm-a' : ''),
    { calls: events, rpc: { ...editorRpc, fsWrite: async () => ({}) }, setup: store.setup });
  const area = await dirtyEditor(h.app, h.settle);
  store.state.failing = true;
  proves = true;
  h.net.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(movesOpen(ls), 'the reconnect s absorption left the handoff open: blocked');
  assert.equal(area.isConnected, true, 'the editor is still mounted');
  assert.equal(area.value, '# notes\n\nunsaved', 'with what the person typed');
  assertHeldTree(h.app, 'blocked', { source: true });
  assert.ok(!events.some((e) => /^rpc@[a-z]+:fsWrite/u.test(e)), 'and nothing saved it to the server');
  store.state.failing = false;
  const retry = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry, 'Retry is offered');
  retry.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(movesOpen(ls), false, 'Retry closed the handoff');
  assert.equal(area.isConnected, true, 'after Retry the same editor is there');
  assert.equal(area.value, '# notes\n\nunsaved', 'and so is the text');
  // Retry owes the reconnect the absorption interrupted (orchestrator 16:12),
  // and arriving at the survivor replaces this tree: the editor is asked
  // first, on screen, and nothing is dialled past it until it answers.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked, 'Retry s re-dial asks the editor before the survivor s tree replaces it');
  assert.ok(!asked.closest('.scope-tree.held, .hidden, [inert]'), 'where the person can answer it');
  if (keep) {
    answerDialog(h.app, /keep editing/iu);
    for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
    assert.equal(area.isConnected && area.value, '# notes\n\nunsaved', 'Keep editing: the same editor, with its text');
    assert.equal(conn(h, 'c')?.isConnected() ?? false, false, 'and nothing came up over it');
    return;
  }
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'Discard: the app arrives at the survivor');
  assert.ok(conn(h, 'c')?.isConnected(), 'on its own connection, with nobody touching the card');
});

/** A Hub with one project, `work`, whose room holds message 1. */
const oneRoomHub = (extra: Record<string, unknown> = {}, log: unknown[] = [{ id: '1', seq: 1, ts: 1_800_000_000_000, from: 'dev', to: ['human'], body: 'hello', room: 'proj:work' }]) => ({
  projectList: async () => ({ projects: [{ project: { id: 'p-work', name: 'work', session: 'work', path: '/w', room: 'proj:work' }, live: true, slots: [] }] }),
  listSessionsWithPanes: async () => ({ sessions: [{ name: 'work', windows: 1 }], panes: [] }),
  hubRooms: async () => ({ rooms: {}, states: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }),
  hubAgents: async () => ({ agents: [] }), registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }),
  // The server's room log: a case that pushes a message appends it here too.
  hubLog: async () => ({ messages: [...log], has_more: false }),
  hubActivity: async () => ({ events: [], has_more: false }),
  ...editorRpc,
  ...extra,
});

test('a held Hub is not a read Hub: a message that arrived unseen stays unread through a block (#335 ③a, reviewer P1-2)', async (context) => {
  // On B, connected, with a Hub: the person reads room `work`, then goes to
  // Files. A message for them arrives on B: unread. They switch to alpha
  // (m-a, which owns pending inputs) and the claim's marker write fails:
  // blocked, B kept bound and RUNNING (ruling K), its tree held, and the
  // page is the default, Chat. Behind the Retry panel B's Hub is held
  // — it must not take the tail it never showed, nor mark the message read
  // (reviewer P1-2: it was still told `visible`).
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const log: unknown[] = [{ id: '1', seq: 1, ts: 1_800_000_000_000, from: 'dev', to: ['human'], body: 'hello', room: 'proj:work' }];
  const h = await bootApp(context, {
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_server_current: 'gone',
    tmux_layout_mode: 'desktop',
  }, undefined, { rpc: oneRoomHub({}, log), setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; } });
  const ls = h.app.window.localStorage;
  await connectCard(h.app, h.settle, 'ws://b:9899');
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'on B');
  const rail = (name: RegExp) => [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn, .tabbar button')]
    .find((b) => name.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))!;
  for (let i = 0; i < 4; i++) await h.app.advance(500);
  assert.ok(rail(/^chat$/iu), `B has the Hub: ${[...h.app.document.querySelectorAll('.rail-btn')].map((x: any) => x.getAttribute('aria-label')).join(',')}`);
  rail(/^chat$/iu).click();
  for (let i = 0; i < 6; i++) await h.app.advance(200);
  assert.equal(JSON.parse(ls.getItem('tmux_hub_seen::b') ?? '{}').work?.seq, 1, 'B s room was read up to message 1');
  rail(/^files$/iu).click();
  for (let i = 0; i < 3; i++) await h.settle();
  const second = { id: '2', seq: 2, ts: 1_800_000_001_000, from: 'dev', to: ['human'], body: 'are you there?', room: 'proj:work' };
  log.push(second);
  conn(h, 'b')!.push(second);
  for (let i = 0; i < 3; i++) await h.settle();
  store.state.failing = true;
  await h.switchTo('alpha');
  await h.app.advance(1000);
  assert.ok(conn(h, 'b')?.isConnected(), 'B is kept, connected');
  // The block moved the page to the default, Chat: the shell is gone
  // (disconnected), the content area shows the Retry panel, and behind it
  // B's tree is held — its Hub on the page that is "current".
  for (let i = 0; i < 6; i++) await h.app.advance(200);
  assertHeldTree(h.app, 'blocked', { source: true });
  // Retry lands every held write synchronously, before any frame of a Hub
  // shown again could legitimately mark anything: what it writes is what
  // the held Hub did.
  store.state.failing = false;
  const retry = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry, 'Retry is offered');
  retry.click();
  assert.equal(JSON.parse(ls.getItem('tmux_hub_seen::b') ?? '{}').work?.seq, 1, 'held, the Hub did not move the read mark past message 1');
  const pushed = (JSON.parse(ls.getItem('tmux_hub_alerts::b') ?? '[]') as { key: string; viewed: boolean }[]).filter((x) => x.key === 'proj:work|2');
  assert.ok(pushed.length && pushed.every((x) => !x.viewed), `and the alert is still unread: ${JSON.stringify(pushed)}`);
});

test('K on touch with a Hub: while blocked no new guest editor mounts, the reason is shown, nothing is written; Retry brings it back for the server bound (reviewer on 027d1a92; ③a)', async (context) => {
  const hub = { hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }), hubAgents: async () => ({ agents: [] }), registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }), hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }) };
  const h = await aRunningWithInputsFor(context, false, { rpc: hub, layout: 'mobile' });
  const openPrefs = async () => {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
  };
  const categories = () => [...h.app.document.querySelectorAll('.preferences .side-row')].map((r) => (r.textContent ?? '').trim());
  await openPrefs();
  assert.ok(categories().some((c) => /^agents/iu.test(c)), `A hosts the Hub: the Agents category is offered: ${categories().join(' | ')}`);
  h.store.state.failing = true;
  await h.switchTo('beta');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(dialsOf(h.events, 'b').length, 1, 'B s own dial proved m-x, and its claim could not be written');
  assert.equal(conn(h, 'a')?.disposed(), false, 'A is kept');
  const before = h.events.length;
  await openPrefs();
  assert.ok(h.app.document.querySelector('.preferences'), 'Preferences still works while blocked');
  // A guest that is not mounted when the block comes is NEW work, and new
  // work waits for Retry (reviewer P1-2 residual on 9958bbfd: a held guest
  // takes no input, a lazy mount included). A switch shows its panel in
  // place of Preferences, so A's guest is not mounted here; a guest that IS
  // mounted through a block is held — `touch: a dirty guest editor survives…`.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /^agents/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(h.app.document.querySelector('.agents-embed .guest'), null, 'no guest editor mounts while blocked');
  assert.match(h.app.document.querySelector('.preferences [role=status]')?.textContent ?? '', /storage|retry/iu, 'the reason is shown');
  assert.ok(!h.events.slice(before).some((e) => /^rpc@a:(registryList|teamsList)/u.test(e)), 'and nothing asked A s registry');
  const written = h.events.slice(before).filter((e) => /^rpc@a:(registrySave|registryDelete|teamsSave|teamsDelete|globalPromptSet|skillsSave|mcpSave)/u.test(e));
  assert.deepEqual(written, [], 'and nothing was written to A s registry');
  h.store.state.failing = false;
  // Disconnected, the person reaches Retry through Connection (the card).
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))?.click();
  for (let i = 0; i < 3; i++) await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /open connection setup/iu.test(b.textContent ?? ''))?.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const retry = retryButton(h.app);
  assert.ok(retry, `Retry is reachable: ${[...h.app.document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean).join(' | ')}`);
  retry.click();
  for (let i = 0; i < 6; i++) await h.settle();
  h.transfer.finish();
  for (let i = 0; i < 6; i++) await h.settle();
  await h.app.advance(1000);
  assert.ok(conn(h, 'b')?.isConnected(), 'Retry brought B up');
  await openPrefs();
  assert.ok(categories().some((c) => /^agents/iu.test(c)), `and the Agents category is back, for B: ${categories().join(' | ')}`);
});

test('touch: a dirty guest editor survives an automatic block that moves the page away, through Retry (#335 ③a, reviewer P1-1(a))', async (context) => {
  // The alias is current (touch, Hub). The person edits an agent's prompt in
  // Preferences › Agents and does not save. The socket drops; the reconnect
  // proves m-a, absorbs the alias into canonical, and the slot copy fails:
  // blocked by the host gate, the page moved away. Before ③a's fix
  // Preferences unmounted with the page and took the draft with it.
  const saved: string[] = [];
  const m = new Map(Object.entries({
    tmux_servers: aliasRegistry, tmux_server_current: 'ghost', tmux_machine_id: 'm-a',
    tmux_state: legacyNav('work:1.0'), tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }), tmux_layout_mode: 'mobile',
  }));
  assert.equal(migrateServerState({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }).reason, 'pending');
  m.set('tmux_server_current', 'a');
  m.set('tmux_address', 'ws://alias:9899'); m.set('tmux_token', 'tok');
  m.set('tmux_hub_drafts::a', JSON.stringify({ work: 'TYPED' }));
  const store = refusing(['tmux_hub_drafts::c']);
  store.state.failing = false;
  let proves = false;
  const events: string[] = [];
  const h = await bootApp(context, Object.fromEntries(m), () => (proves ? 'm-a' : ''), {
    calls: events,
    rpc: {
      hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }), hubAgents: async () => ({ agents: [] }),
      registryList: async () => ({ agents: [{ name: 'alpha', backend: 'codex', model: '', system: 'Original', skills: '[]', mcp: '[]' }] }),
      registrySave: async (def: { system?: string }) => { saved.push(String(def.system)); return {}; },
      teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }), modelsList: async () => ({ models: [] }),
      hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
    },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
  });
  for (let i = 0; i < 4; i++) await h.app.advance(500);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /^agents/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.agents-embed .guest:not(.off) .side-row')].find((b) => /alpha/u.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const prompt = h.app.document.querySelector<HTMLTextAreaElement>('.agents-embed .editor textarea')!;
  prompt.value = 'Unsaved'; prompt.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  for (let i = 0; i < 2; i++) await h.settle();
  store.state.failing = true;
  proves = true;
  h.net.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(movesOpen(ls), 'blocked mid-handoff');
  assert.equal(prompt.isConnected, true, 'the guest editor is still mounted');
  assert.equal(prompt.value, 'Unsaved', 'with the draft');
  assert.deepEqual(saved, [], 'nothing saved while blocked');
  // Retry closes the handoff, and the same editor, with its text, is still
  // mounted. (Saving it after the person reconnects is not exercised here.)
  store.state.failing = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button, .switch-panel button')].find((b) => /retry/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(movesOpen(ls), false, 'Retry closed the handoff');
  assert.equal(prompt.isConnected, true, 'the editor is still mounted after Retry');
  assert.equal(prompt.value, 'Unsaved', 'the draft is still there after Retry');
});

/** A switch that REPLACES the tree in Aggregate too: Settings › Connection ›
 * Add a server, with an address (a known one is that entry). A saved row's
 * pick is a focus move or nothing there (reviewer P1-1 on 99566068). */
async function switchByAddress(h: Awaited<ReturnType<typeof bootApp>>, address: string, token = '') {
  const shown = h.app.document.querySelector('.preferences .server-list');
  if (!shown || shown.closest('.page-layer.hidden')) {
    const gear = [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
    gear!.click(); await h.settle();
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
    await h.settle();
  }
  h.app.document.querySelector<HTMLButtonElement>('.preferences .server-list .sm-add')!.click(); await h.settle();
  const inputs = [...h.app.document.querySelectorAll<HTMLInputElement>('[role=dialog] input')];
  inputs[0]!.value = address; inputs[0]!.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  if (token && inputs[1]) { inputs[1].value = token; inputs[1].dispatchEvent(new h.app.window.Event('input', { bubbles: true })); }
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 2; i++) await h.settle();
}

// ─── #335 ③b-1: background members ─────────────────────────────────────
// Aggregate holds every included server besides the focused one as a
// BACKGROUND member: its own runtime, its own connection, its own tree —
// held, inert and hidden — and none of them writes CURRENT. These are the
// two-live-tree cases ③a owed (orchestrator 10:51).

const aggregateOn = (seed: Record<string, string>, excluded: string[] = []) => ({
  ...seed, tmux_connection_mode: 'aggregate', ...(excluded.length ? { tmux_excluded_servers: JSON.stringify(excluded) } : {}),
});
/** Every tree the app holds mounted, by what its Terminal was handed. */
const trees = (app: any) => [...app.document.querySelectorAll('.scope-tree')].map((el: any) => ({
  el, held: el.classList.contains('held'), inert: isInert(el),
  target: el.querySelector('.term-main .xterm-wrap')?.dataset.target ?? 'none',
  terminal: (({ visible, active }) => `${visible}/${active}`)(el.querySelector('.term-main .xterm-wrap')?.dataset ?? {}),
}));

test('③b-1: an included B joins on its own connection, its tree held and inert, and CURRENT stays A', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { calls: events });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus is A');
  assert.deepEqual(dialsOf(events, 'b'), ['dial@b:ws://b:9899|tokB'], 'B dialled its own address with its own token');
  assert.ok(conn(h, 'b')?.isConnected() && conn(h, 'a')?.isConnected(), 'both are up, each on its own connection');
  const t = trees(h.app);
  assert.equal(t.length, 2, `one tree per member: ${t.map((x) => x.target).join(',')}`);
  assert.deepEqual(t.map((x) => [x.target, x.held, x.inert]), [['work:1.0', false, false], ['work:2.0', true, true]],
    'A s tree is shown on A s pane; B s holds B s own pane, inert and hidden');
  assert.deepEqual(t.map((x) => x.terminal), ['true/true', 'false/false'], 'and only A s Terminal is visible and active: B s takes no keys, renders nothing');
  assert.equal(h.onScreen(), 'work:1.0');
  assert.equal(h.restored(), 'a:work:1.0', 'and the record CURRENT names is still A s');
});

for (const [label, seed] of [
  ['Single', twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') })],
  ['B excluded', aggregateOn(twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), ['b'])],
] as const) {
  test(`③b-1: ${label} holds one tree and never dials B`, async (context) => {
    const events: string[] = [];
    const h = await bootApp(context, { ...seed, tmux_layout_mode: 'desktop' }, undefined, { calls: events });
    for (let i = 0; i < 4; i++) await h.settle();
    assert.ok(conn(h, 'a')?.isConnected(), 'A is up');
    assert.deepEqual(dialsOf(events, 'b'), [], 'B was not dialled');
    assert.equal(trees(h.app).length, 1, 'one tree');
  });
}

test('③b-1 (owed P1-3): a block while B s own dial is out records nothing of B; Retry joins B and records it', async (context) => {
  // The legacy inputs are pending for m-x. B's entry does not know its
  // machine, so B's own answer is what would record it — and that dial is
  // held. Meanwhile the person switches to C (excluded, so not a member),
  // whose own dial proves m-x; the claim's marker cannot be written and the
  // app blocks with B's dial still out (the 3110 pattern).
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
  ];
  const b = { let: null as (() => void) | null };
  let held = true;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }, ['c']), (url, n) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? (n === 0 ? '' : 'm-x') : 'm-a'), {
    calls: events,
    gate: (url, n) => (url.includes('//b') && n > 0 && held ? new Promise<void>((r) => { b.let = () => { held = false; r(); }; }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'on A');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the inputs wait for m-x');
  assert.ok(b.let, `B s own dial is out: ${dialsOf(events, 'b').join(',')}`);
  store.state.failing = true;
  await switchByAddress(h, 'ws://c:9899', 'tokC');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok([...h.app.document.querySelectorAll('.switch-panel button, .card button')].some((b: any) => /retry/iu.test(b.textContent ?? '')),
    'C s claim could not be recorded: the app is blocked, Retry offered');
  store.state.failing = false;                                // storage works again — but the block stands
  b.let!();                                                   // B s dial answers late
  for (let i = 0; i < 4; i++) await h.settle();
  const beta = () => JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.id === 'b');
  assert.equal(beta().machineId, undefined, 'B s late answer recorded no identity while blocked');
  assert.ok(!events.some((e) => e.startsWith('rpc@b:')), 'and nothing was asked of B');
  assert.equal(trees(h.app).filter((x) => x.target === 'work:2.0').length, 0, 'B published no tree');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'Retry finished the switch to C');
  assert.equal(beta().machineId, 'm-b', 'and B joined again, recording its own machine');
  assert.ok(conn(h, 'b')?.isConnected(), 'on its own connection');
  assert.ok(trees(h.app).some((x) => x.target === 'work:2.0' && x.held), 'with its own tree, held behind C s');
});

test('③b-1: each member reconnects on its own loop — B dropping never touches A, and A dropping never touches B', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { calls: events });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, b = conn(h, 'b')!;
  const n = { a: dialsOf(events, 'a').length, b: dialsOf(events, 'b').length };
  b.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(dialsOf(events, 'b').length, n.b + 1, `B s own loop redialled B: ${dialsOf(events, 'b').join(',')}`);
  assert.equal(dialsOf(events, 'a').length, n.a, 'A was not dialled');
  assert.ok(a.isConnected(), 'A s connection untouched');
  assert.equal(h.app.document.querySelector('.reconnect-cancel'), null, 'and the window shows no reconnect: B s is its own');
  assert.ok(b.isConnected(), 'B is back');
  assert.equal(trees(h.app).length, 2, 'both trees still mounted');
  a.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(dialsOf(events, 'a').length, n.a + 1, 'A s loop redialled A');
  assert.equal(dialsOf(events, 'b').length, n.b + 1, 'B was not dialled again');
  assert.ok(a.isConnected() && b.isConnected());
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'CURRENT stayed A throughout');
  assert.equal(h.onScreen(), 'work:1.0');
});

test('③b-1 (reviewer P1 on 453f02b8): B s gate blocks in a sync, and C s gate in the same sync does not open it again — only Retry does', async (context) => {
  // The inputs are pending for m-b, and B's entry knows it is m-b, so B's
  // FIRST gate claims them — and writing B's slot fails. C (m-c) joins in
  // the same sync; its gate must not prepare the block open behind B.
  const store = refusing(['tmux_hub_drafts::b']);
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
  ];
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-b', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
    tmux_hub_drafts: JSON.stringify({ work: 'draft of m-b' }),
  }), (url) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? 'm-c' : 'm-a'), {
    calls: events,
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'A is up');
  assert.ok(retry(), `B s claim could not be written: blocked, Retry offered (${dialsOf(events, 'b').length} B dials)`);
  assert.deepEqual(dialsOf(events, 'b'), [], 'B did not dial');
  assert.deepEqual(dialsOf(events, 'c'), [], 'and C s gate kept the block: C did not dial either');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the inputs are still pending');
  store.state.failing = false;
  for (let i = 0; i < 3; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(retry(), 'storage recovering is not Retry: still blocked');
  retry()!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(ls.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft of m-b' }), 'Retry claimed the inputs into B');
  assert.ok(conn(h, 'b')?.isConnected() && conn(h, 'c')?.isConnected(), 'and both joined');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
});

test('③b-1 (reviewer P1 on 453f02b8): a published member whose socket closed during a block is redialled by Retry', async (context) => {
  // As the owed P1-3 case: pending for m-x, a switch to C (excluded) whose
  // own dial proves m-x, and the claim's marker cannot be written. B is a
  // published member, and its socket closes while the app is blocked.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
  ];
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }, ['c']), (url, n) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? (n === 0 ? '' : 'm-x') : 'm-a'), {
    calls: events,
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const b = conn(h, 'b')!;
  assert.ok(b.isConnected(), 'B joined');
  store.state.failing = true;
  await switchByAddress(h, 'ws://c:9899', 'tokC');
  for (let i = 0; i < 4; i++) await h.settle();
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((x) => /retry/iu.test(x.textContent ?? ''));
  assert.ok(retry(), 'blocked');
  const n = dialsOf(events, 'b').length;
  b.drop();                                                   // B s socket closes during the block
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(dialsOf(events, 'b').length, n, 'nothing dials B while blocked');
  store.state.failing = false;
  retry()!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'Retry finished the switch');
  assert.ok(dialsOf(events, 'b').length > n, `and redialled B: ${dialsOf(events, 'b').join(',')}`);
  assert.ok(conn(h, 'b')?.isConnected(), 'which is back');
});

test('P1-4 (reviewer 15:06; orchestrator 16:32): an alert on a live background alias, absorbed into the canonical while the merge write fails — Retry re-dials C, and the alert opens from C s centre onto its message', async (context) => {
  // C (m-a) is the focus. The alias A is a background member: its server
  // answered without a machine id, so it stayed an entry of its own, and it
  // holds an alert. Later C's machine reports A's address as one of its own,
  // and C's reconnect lands on it: recording that absorbs A into C, and the
  // merge of A's alerts into C's slot fails. Blocked; Retry; the alert is C's.
  const store = refusing(['tmux_hub_alerts::c']);
  store.state.failing = false;
  const alertA = { key: 'proj:work|7', room: 'proj:work', server: 'a', session: 'work', project: 'work', seq: 7, id: '7', ts: 1_800_000_000_000, from: 'dev', toHuman: true, kind: 'reply', excerpt: 'from the alias', viewed: false };
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    tmux_servers: JSON.stringify([
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
    ]),
    tmux_server_current: 'c', tmux_address: 'ws://canonical:9899', tmux_token: 'tok', tmux_machine_id: 'm-a',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'c' }),
    'tmux_hub_alerts::a': JSON.stringify([alertA]),
    tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events,
    rpc: { ...oneRoomHub({}, [{ id: '7', seq: 7, ts: 1_800_000_000_000, from: 'dev', to: ['human'], body: 'from the alias', room: 'proj:work' }]), findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(conn(h, 'a')?.isConnected(), `the alias is a live background member: ${dialsOf(events, 'a').join(',')}`);
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!).length, 2, 'and still an entry of its own');
  // C's machine reports the alias's address as its own.
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  store.state.failing = true;
  conn(h, 'c')!.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(dialsOf(events, 'c').some((d) => d.includes('ws://alias')), `C s reconnect dialled the alias s address: ${dialsOf(events, 'c').join(',')}`);
  assert.ok(movesOpen(ls), 'the absorption s move is open');
  assert.ok(retry(), 'the merge write failed: blocked, Retry offered');
  store.state.failing = false;
  retry()!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(movesOpen(ls), false, 'Retry finished the move');
  // The registry commit never happened, so the alias is still an entry: the
  // resume merged its slots into C and closed the move, and the registry
  // decides again the next time C's machine answers on the alias's address
  // (servers.ts `resumeSlotMove`). What matters is where the alert is.
  const onDisk = (JSON.parse(ls.getItem('tmux_hub_alerts::c') ?? '[]') as { key: string; server: string }[]).find((x) => x.key === 'proj:work|7');
  assert.equal(onDisk?.server, 'c', `the alert is C s, naming C: ${ls.getItem('tmux_hub_alerts::c')}`);
  // Retry owes C the reconnect the absorption interrupted (orchestrator
  // 16:12): C comes back on its own, nobody touches the card.
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'on C');
  assert.ok(conn(h, 'c')?.isConnected(), `Retry re-dialled C: ${dialsOf(events, 'c').slice(-3).join(',')}`);
  // C's centre shows it, from C's own slot. (The alias, whose registry
  // commit never happened, is still a live member with its own copy — the
  // bell is the UNION since ③c-4, so it counts both until the registry
  // decides; C's row is the one that matters here.)
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell');
  assert.ok(bell, 'C has the Hub');
  assert.match(bell.getAttribute('aria-label') ?? '', /· [12]\b/u, `C s bell counts it: ${bell.getAttribute('aria-label')}`);
  bell.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const item = [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-list .nc-row')]
    .find((el) => /from the alias/u.test(el.textContent ?? '') && el.dataset.server === 'c');
  assert.ok(item, `C s centre lists it as C s: ${h.app.document.querySelector('.nc-list')?.textContent ?? 'no list'}`);
  // And picking it LANDS: C's Hub opens the room on that message — not the
  // "another server" refusal an alert still naming the alias would get.
  item.click();
  // The highlight is brief (Feed's 1.6 s): look for it as the jump lands.
  let hit: Element | null = null;
  for (let i = 0; i < 12 && !hit; i++) { await h.app.advance(100); await h.settle(); hit = h.app.document.querySelector('.jump-hit[data-msg="7"]'); }
  assert.ok(hit, `the jump landed on message 7: ${h.app.document.querySelector('.nc-fail')?.textContent ?? 'no failure shown'}`);
  assert.ok(!hit.closest('.scope-tree.held'), 'in C s own, shown tree');
  assert.equal((JSON.parse(ls.getItem('tmux_hub_alerts::c') ?? '[]') as { key: string; viewed: boolean }[]).find((x) => x.key === 'proj:work|7')?.viewed, true, 'and seen there, C s alert counts no more');
  assert.ok(conn(h, 'c')!.isConnected() && !events.some((e) => e.startsWith('rpc@a:hubLog')), 'asked of C, never of the alias');
});

// ─── #335 ③b-2: the focus moves between members; a leave walk asks the
// member being destroyed, on its own tree ──────────────────────────────

/** Pick `name` from the server list in Settings → Connection, opening it
 * first unless it is already on screen (a focus move leaves the page where
 * it was). */
async function pickServer(h: Awaited<ReturnType<typeof bootApp>>, name: string) {
  const row = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')]
    .find((b) => new RegExp(`^${name}\\b`, 'iu').test((b.textContent ?? '').trim()));
  const r = row();
  if (!r) { await h.switchTo(name); return; }
  r.click();
  for (let i = 0; i < 2; i++) await h.settle();
}

test('③b-2 (D2): in Aggregate, picking a connected member moves the focus — no dial, no teardown, A s tree and draft stay mounted', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { calls: events, rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  const area = await dirtyEditor(h.app, h.settle);              // A s unsaved edit
  const a = conn(h, 'a')!, b = conn(h, 'b')!;
  const dials = events.filter((e) => e.startsWith('dial@') || e.startsWith('candidate:')).length;
  await pickServer(h, 'beta');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing is destroyed, so nothing asks');
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'CURRENT is B');
  assert.equal(ls.getItem('tmux_address'), 'ws://b:9899', 'and so is the mirror');
  assert.equal(events.filter((e) => e.startsWith('dial@') || e.startsWith('candidate:')).length, dials, 'nothing dialled');
  assert.ok(a.isConnected() && !a.disposed() && b.isConnected(), 'both stay up');
  const t = trees(h.app);
  assert.equal(t.length, 2, 'both trees mounted');
  assert.deepEqual(t.filter((x) => !x.held).length, 1, 'one in front');
  assert.equal(area.isConnected && area.value, '# notes\n\nunsaved', 'A s draft is still mounted, in A s tree');
  assert.ok(area.closest('.scope-tree.held'), 'which is held behind B s now');
  // And back: A comes to the front with its editor as it was.
  await pickServer(h, 'alpha');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.ok(!area.closest('.scope-tree.held'), 'A in front again');
  assert.equal(area.value, '# notes\n\nunsaved');
  assert.equal(events.filter((e) => e.startsWith('dial@') || e.startsWith('candidate:')).length, dials, 'still nothing dialled');
});

test('③b-2 (D2): Single switches as before — the leave walk asks A s editor', async (context) => {
  const h = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }, undefined, { rpc: editorRpc });
  for (let i = 0; i < 4; i++) await h.settle();
  await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'beta');
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'A s editor is asked: Single destroys A s tree');
});


test('③b-2 (D2, orchestrator 02:28/03:23): picking a member that is not connected is not a focus change — the app stays, nothing is asked or torn down', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, {
    calls: events, rpc: editorRpc,
    gate: (url, n) => (url.includes('//b') && n > 0 ? new Promise<void>(() => {}) : null),   // B never answers its own dial
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.equal(conn(h, 'b')?.isConnected() ?? false, false, 'B is a member still dialling');
  const area = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus did not move');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing is asked: nothing is replaced');
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'and no switch runs');
  assert.ok(!events.some((e) => e.startsWith('candidate:')), 'no candidate dial');
  assert.equal(area.isConnected && area.value, '# notes\n\nunsaved');
});

for (const keep of [true, false]) test(`③b-2: removing a background member asks ITS editor, on its own tree in front, and only it — ${keep ? 'Keep editing keeps B and every draft' : 'Discard removes B, A s draft untouched'}`, async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { calls: events, rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  // Both trees hold an unsaved edit of the same file name: B s made while B
  // had the focus, then the focus came back to A.
  await pickServer(h, 'beta');
  const draftB = await dirtyEditor(h.app, h.settle);
  draftB.value = '# notes\n\nB unsaved'; draftB.dispatchEvent(new h.app.window.Event('input', { bubbles: true })); await h.settle();
  await pickServer(h, 'alpha');
  const draftA = await dirtyEditor(h.app, h.settle);
  assert.notEqual(draftA, draftB, 'two editors, one per tree');
  assert.ok(draftB.closest('.scope-tree.held'), 'B s is behind A s');
  // Remove beta from the list: its own confirmation first.
  await pickServer(h, 'alpha');                                    // opens Settings › Connection
  const remove = h.app.document.querySelector<HTMLButtonElement>('.preferences .server-list button[aria-label="Remove beta"]');
  assert.ok(remove, `the list offers to remove beta: ${[...h.app.document.querySelectorAll('.preferences .server-list button')].map((b: any) => b.getAttribute('aria-label') || b.textContent?.trim()).join(' | ')}`);
  remove.click(); await h.settle();
  answerDialog(h.app, /^remove$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  // B s editor asks — in B s tree, brought in front for the walk.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked, 'B s editor is asked');
  assert.ok(!asked.closest('.scope-tree.held, [inert], .hidden'), 'on screen, answerable');
  assert.ok(draftB.closest('.scope-tree') === asked.closest('.scope-tree'), 'in B s own tree');
  assert.ok(draftA.closest('.scope-tree.held'), 'while A s tree is held behind it');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'B was not made CURRENT to ask (D2)');
  answerDialog(h.app, keep ? /keep editing/iu : /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'one dialog: A s editor is not asked');
  assert.ok(!draftA.closest('.scope-tree.held'), 'A is in front again');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'with its draft');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.ok(h.app.document.querySelector('.preferences'), 'back on the page the person started from');
  const saved = () => JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id);
  if (keep) {
    assert.deepEqual(saved(), ['a', 'b'], 'Keep editing: B is not removed');
    assert.equal(draftB.isConnected && draftB.value, '# notes\n\nB unsaved', 'and its draft is there, behind A');
    assert.ok(conn(h, 'b')!.isConnected(), 'still up');
  } else {
    assert.deepEqual(saved(), ['a'], 'Discard: B is removed');
    assert.equal(draftB.isConnected, false, 'its tree is gone');
    assert.ok(conn(h, 'b')!.disposed(), 'and its connection ended');
    assert.ok(conn(h, 'a')!.isConnected(), 'A untouched');
  }
});

test('③b-2: on a phone, Back answers the dialog of the member being removed — in ITS tree, as Keep editing — and nothing of A s moves', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'mobile',
  }), undefined, { calls: events, rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.equal(trees(h.app).length, 2, `B is a member: ${dialsOf(events, 'b').join(',')}`);
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b', `the focus moved: ${events.filter((e) => /dial@|candidate/u.test(e)).join(',')}`);
  assert.equal(trees(h.app).length, 2, 'without a teardown');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }   // B s page settles in front
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  await pickServer(h, 'alpha');                                    // Settings › Connection
  h.app.document.querySelector<HTMLButtonElement>('.preferences .server-list button[aria-label="Remove beta"]')!.click(); await h.settle();
  answerDialog(h.app, /^remove$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'B s editor asks, in B s tree');
  assert.ok(!asked.closest('.scope-tree.held, [inert]'), 'answerable');
  h.app.window.history.pushState({ app: true }, '');
  h.app.window.dispatchEvent(new h.app.window.PopStateEvent('popstate', { state: { app: true } }));
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'Back answered it');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['a', 'b'], 'as Keep editing: B is kept');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'with its draft, behind A again');
  assert.ok(draftB.closest('.scope-tree.held'));
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'and the focus never moved');
});

test('an unreadable move journal blocks the boot s absorption; once it reads again, Retry finishes it (reviewer P1 on 97824925; validator 02:26)', async (context) => {
  const h = await bootApp(context, {
    tmux_servers: JSON.stringify([
      { id: 'c', name: 'canon', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'a', name: 'alias', address: 'ws://a:9899', token: 'tokA', named: true },
    ]),
    tmux_server_current: 'c', tmux_address: 'ws://a:9899', tmux_token: 'tokA', tmux_machine_id: 'm-a',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'c' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'TYPED on canonical' }),
    'tmux_hub_drafts::a': JSON.stringify({ ops: 'typed on the alias' }),
    tmux_slot_moves: '{not json',
    tmux_layout_mode: 'desktop',
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry(), 'blocked, Retry offered');
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!).length, 2, 'the absorption did not run');
  assert.equal(ls.getItem('tmux_hub_drafts::a'), JSON.stringify({ ops: 'typed on the alias' }), 'and the alias s slot is untouched');
  assert.equal(ls.getItem('tmux_slot_moves'), '{not json', 'nor was the journal written over');
  retry()!.click();
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(retry(), 'Retry on the same journal blocks again');
  ls.setItem('tmux_slot_moves', '[]');                          // repaired
  retry()!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(retry(), undefined, 'unblocked');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the absorption finished');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_hub_drafts::c')!), { work: 'TYPED on canonical', ops: 'typed on the alias' }, 'merged by room');
  assert.equal(ls.getItem('tmux_slot_moves'), null, 'its move closed');
  assert.ok(conn(h, 'c')?.isConnected(), 'and C is up');
});

for (const keep of [true, false]) test(`Retry whose CURRENT already names the canonical asks the alias tree s editor before replacing it — ${keep ? 'Keep editing' : 'Discard'} (reviewer P1 on 97824925)`, async (context) => {
  // The reconnect absorbs the alias: the registry and CURRENT are committed
  // (CURRENT = c), and then the merge note cannot be written. Blocked with
  // the alias s tree still bound and an unsaved editor in it.
  const store = refusing(['tmux_server_merges']);
  store.state.failing = false;
  const events: string[] = [];
  let proves = false;
  const h = await bootApp(context, {
    tmux_servers: aliasRegistry, tmux_server_current: 'a', tmux_machine_id: 'm-a',
    tmux_address: 'ws://alias:9899', tmux_token: 'tok',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'a' }),
    tmux_state: JSON.stringify({ page: 'files' }), tmux_layout_mode: 'desktop',
  }, () => (proves ? 'm-a' : ''), { calls: events, rpc: { ...editorRpc, fsWrite: async () => ({}) }, setup: store.setup });
  const area = await dirtyEditor(h.app, h.settle);
  store.state.failing = true;
  proves = true;
  h.net.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry(), 'blocked');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT already names the canonical');
  assert.equal(area.isConnected, true, 'the alias s editor is held, mounted');
  store.state.failing = false;
  retry()!.click();
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked, 'Retry asks before the canonical s tree replaces the alias s');
  assert.ok(!asked.closest('.scope-tree.held, [inert], .hidden'), 'where it can be answered');
  assert.equal(conn(h, 'c')?.isConnected() ?? false, false, 'and nothing is dialled past it while it asks');
  answerDialog(h.app, keep ? /keep editing/iu : /^discard$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  if (keep) {
    assert.equal(area.isConnected && area.value, '# notes\n\nunsaved', 'Keep editing: the editor and its text stay');
    assert.equal(conn(h, 'c')?.isConnected() ?? false, false, 'nothing came up over it');
  } else {
    assert.equal(area.isConnected, false, 'Discard: the alias s tree is replaced');
    assert.ok(conn(h, 'c')?.isConnected(), 'by the canonical, on its own connection');
  }
});

test('Retry before a blocked member s stale join answers: the member joins again and comes up; the late answer undoes nothing (reviewer P1 on 97824925)', async (context) => {
  // As the owed P1-3 case: B s dial is held while C s claim blocks the app.
  // This time Retry comes FIRST, and only then does B s old dial answer.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
  ];
  const lets: (() => void)[] = [];
  let holdB = true;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }, ['c']), (url, n) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? (n === 0 ? '' : 'm-x') : 'm-a'), {
    calls: events,
    gate: (url, n) => (url.includes('//b') && n > 0 && holdB ? new Promise<void>((r) => { lets.push(r); }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(lets.length, 1, 'B s first join dial is out');
  store.state.failing = true;
  await switchByAddress(h, 'ws://c:9899', 'tokC');
  for (let i = 0; i < 4; i++) await h.settle();
  const retry = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry(), 'blocked');
  store.state.failing = false;
  holdB = false;                                          // B answers its NEW dial at once
  retry()!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'Retry finished the switch');
  assert.ok(dialsOf(events, 'b').length >= 2, `B was dialled again: ${dialsOf(events, 'b').join(',')}`);
  assert.ok(conn(h, 'b')?.isConnected(), 'B is up');
  assert.ok(trees(h.app).some((x) => x.target === 'work:2.0'), 'with its tree');
  lets[0]!();                                             // the OLD dial answers, late
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(conn(h, 'b')?.isConnected() && !conn(h, 'b')!.disposed(), 'and undid nothing');
  assert.ok(trees(h.app).some((x) => x.target === 'work:2.0'), 'B s tree is still there');
});

// ─── #335 ③b-3: the mode and the include switches ─────────────────────

async function toConnection(h: Awaited<ReturnType<typeof bootApp>>) {
  // Already on it (the gear toggles Preferences, so it is not pressed twice).
  const shown = h.app.document.querySelector('.preferences .server-list');
  if (shown && !shown.closest('.page-layer.hidden')) return;
  const gear = [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
    .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  gear!.click(); await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => /connection/iu.test(b.textContent ?? ''))!.click();
  await h.settle();
}
const modeButton = (h: Awaited<ReturnType<typeof bootApp>>, name: RegExp) =>
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .segmented button')].find((b) => name.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
const includeSwitch = (h: Awaited<ReturnType<typeof bootApp>>, name: string) =>
  h.app.document.querySelector<HTMLButtonElement>(`.preferences .server-list [role=switch][aria-label="Include ${name}"]`);
const sandbox = { setup(window: any) { window.Element.prototype.getAnimations = () => []; } };

test('③b-3: Single → Aggregate keeps A s connection and joins B; Single shows no include switches', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' },
    undefined, { calls: events, ...sandbox });
  for (let i = 0; i < 4; i++) await h.settle();
  await toConnection(h);
  assert.equal(includeSwitch(h, 'beta'), null, 'Single: no include switches');
  const a = conn(h, 'a')!;
  const dialsA = dialsOf(events, 'a').length;
  modeButton(h, /^all included$/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate');
  assert.equal(conn(h, 'a'), a, 'A s connection is the one it had');
  assert.equal(dialsOf(events, 'a').length, dialsA, 'and A was not dialled again');
  assert.ok(conn(h, 'b')?.isConnected(), 'B joined');
  assert.equal(trees(h.app).length, 2);
  assert.equal(includeSwitch(h, 'beta')?.getAttribute('aria-checked'), 'true', 'B s row: an include switch, on');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
});

for (const keep of [true, false]) test(`③b-3: Aggregate → Single asks each member s tree first — ${keep ? 'Keep editing changes neither the mode nor a connection' : 'Discard lets B go, A untouched'}`, async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { rpc: editorRpc, ...sandbox });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  await toConnection(h);
  modeButton(h, /^one server$/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'B s editor asks, in B s tree');
  assert.ok(!asked.closest('.scope-tree.held, [inert]'), 'answerable');
  answerDialog(h.app, keep ? /keep editing/iu : /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  if (keep) {
    assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'still Aggregate');
    assert.ok(conn(h, 'b')!.isConnected(), 'B still up');
    assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'with its draft');
  } else {
    assert.equal(ls.getItem('tmux_connection_mode'), 'single');
    assert.ok(conn(h, 'b')!.disposed(), 'B let go of');
    assert.equal(trees(h.app).length, 1, 'one tree');
  }
  assert.ok(conn(h, 'a')!.isConnected(), 'A untouched');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
});

test('③b-3: excluding a member asks only its tree; including it again joins it', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { rpc: editorRpc, ...sandbox });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  const draftA = await dirtyEditor(h.app, h.settle);
  await toConnection(h);
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'B s editor asks, in B s tree');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'A s editor is not asked');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), ['b']);
  const b = conn(h, 'b')!;
  assert.ok(b.disposed(), 'B let go of');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft untouched');
  assert.equal(includeSwitch(h, 'beta')?.getAttribute('aria-checked'), 'false');
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), [], 'included again');
  assert.ok(conn(h, 'b') !== b && conn(h, 'b')!.isConnected(), 'B joins on a fresh connection');
  assert.equal(trees(h.app).length, 2);
});

test('③b-3: excluding the focus moves the focus to the next connected member first, after asking the focus s tree', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { rpc: editorRpc, ...sandbox });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  const draftA = await dirtyEditor(h.app, h.settle);
  await toConnection(h);
  includeSwitch(h, 'alpha')!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A s editor asks');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), ['a'], 'and A is excluded');
  assert.ok(conn(h, 'a')!.disposed(), 'A let go of');
  assert.ok(conn(h, 'b')!.isConnected());
  assert.equal(trees(h.app).length, 1);
  // B is the only connected server now: excluding it is refused, with why.
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing is asked');
  assert.equal(includeSwitch(h, 'beta')?.getAttribute('aria-checked'), 'true', 'B stays included');
  assert.match(h.app.document.querySelector('.preferences .server-list [role=alert]')?.textContent ?? '', /only connected server/iu, 'and the list says why');
});

test('③b-3: picking an excluded server includes it — it joins as a member; the app stays on A until it is up, then the pick focuses it', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }, ['b']), undefined, sandbox);
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await h.switchTo('beta');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), [], 'B is included now');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the app stays on A');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(conn(h, 'b')?.isConnected(), 'B joined');
  assert.equal(trees(h.app).length, 2);
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'now the pick focuses it');
  assert.ok(conn(h, 'a')?.isConnected(), 'and A stays up, a member');
});

test('③b-3: while blocked the mode and the include switches are frozen', async (context) => {
  const store = refusing(['tmux_state_layout']);
  const h = await bootApp(context, aggregateOn({ ...danglingSeed() }), undefined, { setup(window) { store.setup(window); sandbox.setup(window); } });
  await h.app.advance(6000);
  await toConnection(h);
  const seg = modeButton(h, /^one server$/iu);
  assert.ok(seg?.disabled, 'the mode is frozen');
  const switches = [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .server-list [role=switch]')];
  assert.ok(switches.length > 0, 'the rows carry their switches');
  for (const sw of switches) assert.ok(sw.disabled, 'every include switch is frozen');
});

test('③b-3: a member s row wears its own status: B reaching A s machine says so, with the failed dot', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), () => 'm-a', sandbox);
  for (let i = 0; i < 4; i++) await h.settle();
  await toConnection(h);
  const row = [...h.app.document.querySelectorAll<HTMLElement>('.preferences .server-list .sm-row')].find((r) => /beta/u.test(r.textContent ?? ''))!;
  assert.match(row.querySelector('.sm-addr')?.textContent ?? '', /reaches alpha/iu, `the reason is on the row: ${row.textContent}`);
  assert.ok(conn(h, 'a')?.isConnected(), 'A is untouched by it');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a');
});

// ─── reviewer P1s on 99566068 ─────────────────────────────────────────

/** A Hub with an agent registry: the touch guest's Agents editor has a row. */
const guestRpc = (extra: Record<string, unknown> = {}) => ({
  hubRooms: async () => ({ rooms: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }), hubAgents: async () => ({ agents: [] }),
  registryList: async () => ({ agents: [{ name: 'alpha', backend: 'codex', model: '', system: 'Original', skills: '[]', mcp: '[]' }] }),
  registrySave: async () => ({}),
  teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }), mcpList: async () => ({ mcp: [] }), modelsList: async () => ({ models: [] }),
  hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
  ...editorRpc, ...extra,
});
const settingsTab = async (h: Awaited<ReturnType<typeof bootApp>>, name: RegExp) => {
  if (!h.app.document.querySelector('.page-layer:not(.hidden) .preferences')) {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
  }
  // On a phone a category is a drilled page, and an open editor may answer
  // first: click the category; if the page did not take it, Back and again.
  const want = (() => { const m = /connection|agents|teams|appearance/iu.exec(name.source); return m ? m[0].toLowerCase() : ''; })();
  for (let i = 0; i < 4; i++) {
    const row = [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .side-row')].find((b) => name.test((b.textContent ?? '').trim()) && !b.closest('.agents-embed'));
    assert.ok(row, `Settings offers ${name}`);
    row.click();
    for (let j = 0; j < 6; j++) await h.settle();
    if (h.app.window.localStorage.getItem('tmux_settings_tab') === want) return;
    h.app.window.history.pushState({ app: true }, '');
    h.app.window.dispatchEvent(new h.app.window.PopStateEvent('popstate', { state: { app: true } }));
    for (let j = 0; j < 3; j++) await h.settle();
  }
  assert.fail(`Settings did not open ${name}`);
};
const reachable = (el: Element | null) => {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList.contains('off') || n.classList.contains('hidden') || n.classList.contains('held') || isInert(n)) return false;
  }
  return !!el;
};

for (const answer of ['keep', 'discard', 'back'] as const) test(`P1-2: on touch, removing B whose guest Agents editor is dirty reveals B s guest on its section, asks there — ${answer} (reviewer on 99566068)`, async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'mobile',
  }), undefined, { rpc: guestRpc(), setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; } });
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(trees(h.app).length, 2, 'B is a member');
  // B focused; its guest Agents editor gets an unsaved prompt.
  await settingsTab(h, /^connection/iu);
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b');
  await settingsTab(h, /^agents/iu);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.agents-embed .guest:not(.off) .side-row')].find((b) => /alpha/u.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const prompt = h.app.document.querySelector<HTMLTextAreaElement>('.agents-embed .guest:not(.off) .editor textarea')!;
  prompt.value = 'Unsaved on B'; prompt.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  for (let i = 0; i < 2; i++) await h.settle();
  // Focus A from the phone's server row, staying on Agents (B s guest goes
  // behind A s), then Connection (A s guest is clean), and remove B there.
  const pop = async (name: string) => {
    h.app.document.querySelector<HTMLButtonElement>('.preferences .server-row')!.click(); await h.settle();
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.server-menu .sm-pick, .pop-layer .sm-pick')].find((b) => new RegExp(`^${name}\\b`, 'iu').test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 4; i++) await h.settle();
  };
  await pop('alpha');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'focused on A');
  assert.ok(!reachable(prompt), 'B s guest is hidden now');
  await settingsTab(h, /^connection/iu);
  h.app.document.querySelector<HTMLButtonElement>('.preferences .server-list button[aria-label="Remove beta"]')!.click(); await h.settle();
  answerDialog(h.app, /^remove$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked, 'B s guest editor is asked');
  assert.ok(reachable(asked), 'its confirmation is on screen: no ancestor off, hidden, held or inert');
  assert.ok(reachable(prompt) && prompt.value === 'Unsaved on B', 'B s guest is shown on its own section, with its draft');
  if (answer === 'back') {
    h.app.window.history.pushState({ app: true }, '');
    h.app.window.dispatchEvent(new h.app.window.PopStateEvent('popstate', { state: { app: true } }));
  } else answerDialog(h.app, answer === 'keep' ? /keep editing/iu : /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null);
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus never moved');
  assert.ok(h.app.document.querySelector('.preferences .server-list') && reachable(h.app.document.querySelector('.preferences .server-list')), 'back on Connection, where the person was');
  const ids = JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id);
  if (answer === 'discard') assert.deepEqual(ids, ['a'], 'Discard: B removed');
  else {
    assert.deepEqual(ids, ['a', 'b'], 'kept: B stays');
    assert.equal(prompt.isConnected && prompt.value, 'Unsaved on B', 'with its draft');
    assert.ok(!reachable(prompt), 'hidden again');
  }
});

test('P1-1: Aggregate, picking a member that is not connected moves nothing and unmounts nothing — C s background draft stays, the row says why', async (context) => {
  const events: string[] = [];
  let bUp = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
  ];
  const lets: (() => void)[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), 'tmux_state::c': JSON.stringify({ page: 'files' }), tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? 'm-c' : 'm-a'), {
    calls: events, rpc: editorRpc,
    gate: (url, n) => (url.includes('//b') && n > 0 && !bUp ? new Promise<void>((r) => { lets.push(r); }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  // C focused, its Files edited; back on A (clean).
  await pickServer(h, 'charlie');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftC = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  const before = events.filter((e) => e.startsWith('candidate:')).length;
  await pickServer(h, 'beta');                                // B: still dialling
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'CURRENT stays A');
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'no switch panel');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing is asked: nothing is destroyed');
  assert.equal(events.filter((e) => e.startsWith('candidate:')).length, before, 'no candidate switch');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s background draft: the same editor, as typed');
  assert.match(h.app.document.querySelector('.preferences .server-list [role=alert]')?.textContent ?? '', /beta is not connected yet/iu, 'the list says why');
  // B comes up on its own; now the pick focuses it.
  bUp = true; lets.forEach((r) => r());
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.ok(conn(h, 'b')?.isConnected(), 'B up');
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'focused once connected');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s draft still the same');
});

test('P1-1: an Aggregate switch through Add-a-server keeps every member s tree mounted while it runs, and after', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//b') ? 'm-b' : url.includes('//n') ? 'm-n' : 'm-a'), { rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  // A brand-new server, through the switch (not a saved member).
  await switchByAddress(h, 'ws://n:9899');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'during the switch: B s tree stays mounted with its draft');
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current') !== 'b', true);
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'and after it: the same editor');
});

for (const key of ['tmux_address', 'tmux_token', 'tmux_server_current'] as const) test(`P1-3(a): a focus move whose ${key} write fails moves nothing — CURRENT, the mirror and the front all stay on A, both drafts kept`, async (context) => {
  const store = refusing([key]);
  store.state.failing = false;
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { rpc: editorRpc, setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  const draftA = await dirtyEditor(h.app, h.settle);
  const mirror = () => [ls.getItem('tmux_server_current'), ls.getItem('tmux_address'), ls.getItem('tmux_token')];
  assert.deepEqual(mirror(), ['a', 'ws://a:9899', 'tokA']);
  store.state.failing = true;
  await pickServer(h, 'beta');
  assert.deepEqual(mirror(), ['a', 'ws://a:9899', 'tokA'], 'storage is all A s');
  assert.ok(!draftA.closest('.scope-tree.held'), 'A is still in front');
  assert.ok(draftB.closest('.scope-tree.held'), 'B behind it');
  assert.equal(draftA.value, '# notes\n\nunsaved');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'B kept as a member, its draft mounted');
  assert.equal(trees(h.app).length, 2);
});

test('P1-3(b): a probe A s optimizer started before a focus move to B answers late — B dials nothing and stays up, CURRENT stays B', async (context) => {
  const probe = { let: null as ((v: string | null) => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }), (url) => (url.includes('//b') ? 'm-b' : 'm-a'), {
    calls: events,
    rpc: { classifyAddress: (a: string) => (a.includes('lan') ? 0 : 2), findBestAddress: () => new Promise((r) => { probe.let = r; }) },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));   // A s optimizer probes
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(probe.let, 'A s probe is out');
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved');
  const b = conn(h, 'b')!;
  const n = events.filter((e) => e.startsWith('dial@')).length;
  probe.let!('ws://a-lan:9899');                                // A s better address answers late
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(events.filter((e) => e.startsWith('dial@')).length, n, `nothing dialled: ${events.filter((e) => e.startsWith('dial@')).slice(-2).join(',')}`);
  assert.ok(b.isConnected() && !b.disposed(), 'B stays up');
  assert.equal(ls.getItem('tmux_server_current'), 'b');
  assert.ok(conn(h, 'a')!.isConnected(), 'A, a member now, untouched');
});

// ─── reviewer P1-4 / P1-5 on 3a0b4feb ─────────────────────────────────

for (const answer of ['keep', 'discard'] as const) test(`P1-5: a background alias with a dirty Files draft is absorbed by the focus s handshake — detached now, tree kept, asked in its tree; ${answer}`, async (context) => {
  // C (m-a) and the alias A, which answers without a machine id. Aggregate:
  // both up. D2: focus A, type in Files, focus C again. Then C's reconnect
  // lands on A's address and proves it is m-a too: identity absorbs A.
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    tmux_servers: JSON.stringify([
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
    ]),
    tmux_server_current: 'c', tmux_address: 'ws://canonical:9899', tmux_token: 'tok', tmux_machine_id: 'm-a',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'c' }),
    'tmux_state::c': JSON.stringify({ page: 'files' }), 'tmux_state::a': JSON.stringify({ page: 'files' }),
    tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(conn(h, 'a')?.isConnected(), 'the alias is a live member');
  await pickServer(h, 'alias');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftA = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'canon');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  const a = conn(h, 'a')!;
  const capturedA = a.api.listSessions!;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  conn(h, 'c')!.drop();
  // Advance only until the registry has absorbed the alias — then stop,
  // before any further settle: the detach must already have happened AT that
  // boundary (reviewer R1 on aed2f654), not in a later sync or effect.
  for (let i = 0; i < 40 && JSON.parse(ls.getItem('tmux_servers')!).length > 1; i++) await h.app.advance(250);
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'identity absorbed the alias');
  // Identity gone NOW: the alias s api refuses, its socket is closed.
  assert.equal(a.isConnected(), false, 'its socket is closed, at the boundary');
  await assert.rejects(capturedA(), /not connected|disposed|is not serving/u, 'the alias s captured call reaches nobody, with nothing settled since');
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(a.disposed(), false, 'but the runtime is not ENDED yet: its state is not released, its tree is still its own, until the person answers');
  // Its editor is not: held, mounted, with the draft — and asked, in its tree.
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'the alias s draft is kept');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'asked, in the alias s own tree');
  assert.ok(!asked.closest('.scope-tree.held, [inert]'), 'answerable');
  assert.ok(conn(h, 'c')?.isConnected(), 'C, the focus, is up and untouched');
  answerDialog(h.app, answer === 'keep' ? /keep editing/iu : /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is C throughout');
  if (answer === 'discard') {
    assert.equal(draftA.isConnected, false, 'Discard: the tree goes');
    assert.ok(a.disposed(), 'and the runtime is ended');
  } else {
    assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'Keep editing: the tree stays, detached');
    assert.ok(draftA.closest('.scope-tree.held'), 'behind C');
    // The list offers the one way on: Dismiss, which asks again.
    await toConnection(h);
    const dismiss = h.app.document.querySelector<HTMLButtonElement>('.preferences .server-list button[aria-label^="Dismiss"]');
    assert.ok(dismiss, `the orphan is listed with Dismiss: ${[...h.app.document.querySelectorAll('.preferences .server-list button')].map((b: any) => b.getAttribute('aria-label') || b.textContent?.trim()).join('|')}`);
    dismiss.click();
    for (let i = 0; i < 4; i++) await h.settle();
    assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'asked again');
    answerDialog(h.app, /^discard$/iu);
    for (let i = 0; i < 4; i++) await h.settle();
    assert.equal(draftA.isConnected, false, 'now it goes');
    assert.ok(a.disposed());
  }
});

test('P1-5: a background member whose own reconnect reaches another KNOWN server keeps its tree and draft; both entries stay; asked in its tree', async (context) => {
  let bAnswersAs = 'm-b';
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : 'm-a'), {
    rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  const b = conn(h, 'b')!;
  bAnswersAs = 'm-d';                                          // B's address now reaches D
  b.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['a', 'b', 'd'], 'both entries stay');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'A untouched');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'B s draft kept');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'asked in B s tree');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'kept');
  assert.ok(!conn(h, 'b')!.isConnected(), 'B s socket to D is closed');
  await toConnection(h);
  assert.match(h.app.document.querySelector('.preferences .server-list')?.textContent ?? '', /reaches delta/iu, 'the row says where it went');
});

for (const change of ['mode', 'exclude'] as const) test(`P1-4 (${change}): a change waiting on B s guard while a block begins writes nothing when B s in-flight Save ends the guard — the declaration is frozen until Retry`, async (context) => {
  // Desktop, Aggregate, Hub on every server. B's Agents editor has a Save
  // in flight (hanging). The person switches to Single / excludes B: the walk
  // waits on B's guard, which waits for the Save. Meanwhile C's own join
  // records its machine and the claim's marker write FAILS: blocked. Then
  // B's Save answers, the guard resolves true — and the change must NOT be
  // written: the mode and the exclusions are frozen with the registry.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const saves: ((v: unknown) => void)[] = [];
  const cLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }), (url, n) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? (n === 0 ? '' : 'm-x') : 'm-a'), {
    rpc: guestRpc({ registrySave: () => new Promise((r) => { saves.push(r); }) }),
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'the inputs wait for m-x (C)');
  assert.ok(cLet.let, 'C s join dial is held');
  // B focused: open its Agents page, edit alpha, Save (hangs).
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^agents$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const inB = (sel: string) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) ' + sel)];
  inB('.side-row').find((b) => /^agents/iu.test((b.textContent ?? '').trim()))?.click();
  for (let i = 0; i < 4; i++) await h.settle();
  inB('.side-row, button').find((b) => /alpha/u.test(b.textContent ?? '') && !/^agents/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const prompt = inB('.editor textarea')[0] as HTMLTextAreaElement;
  assert.ok(prompt, 'B s editor is open');
  prompt.value = 'Changed on B'; prompt.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  for (let i = 0; i < 2; i++) await h.settle();
  inB('button[aria-label="Save"]')[0]!.click();
  for (let i = 0; i < 6 && saves.length === 0; i++) await h.settle();
  assert.equal(saves.length, 1, 'B s Save is in flight');
  // Back to A; start the change: it waits on B s guard.
  await pickServer(h, 'alpha');
  await toConnection(h);
  if (change === 'mode') modeButton(h, /^one server$/iu)!.click();
  else includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 8 && prompt.closest('.scope-tree.held'); i++) await h.settle();
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'nothing written while the guard waits');
  assert.equal(ls.getItem('tmux_excluded_servers'), null);
  for (let i = 0; i < 8 && prompt.closest('.scope-tree.held'); i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(prompt.closest('.scope-tree') && !prompt.closest('.scope-tree.held'), 'the walk revealed B s tree: its guard is the one waiting (on the Save)');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'no dialog yet: the guard waits for the Save first');
  // C s join answers: its claim cannot be recorded — the app blocks.
  store.state.failing = true;
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'C s claim could not be recorded');
  assert.match(h.app.document.querySelector('.preferences .server-list')?.textContent ?? '', /paused: storage/iu, 'blocked: C s row says so');
  // B s Save finishes (an in-flight write may complete): the guard resolves.
  saves[0]!({});
  // The walk is over once B s tree is back behind A s.
  for (let i = 0; i < 12 && !prompt.closest('.scope-tree.held') && prompt.isConnected; i++) { await h.app.advance(500); await h.settle(); }
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'the mode was NOT written under the block');
  assert.equal(ls.getItem('tmux_excluded_servers'), null, 'nor the exclusions');
  assert.ok(conn(h, 'b')?.isConnected() && !conn(h, 'b')!.disposed(), 'B is not ended');
  assert.equal(trees(h.app).length, 2, 'both trees still mounted');
  // After Retry nothing happens on its own: the person decides again.
  store.state.failing = false;
  // (Retry sits on the content area, behind Preferences: leave the page.)
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 2; i++) await h.settle();
  const retryBtn = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retryBtn, 'still blocked, Retry offered');
  retryBtn.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'Retry executes no stale decision');
  assert.equal(ls.getItem('tmux_excluded_servers'), null);
});

test('P1-4: a focus exclusion whose walk ends after a block moves nothing and writes nothing', async (context) => {
  // A focused with an Agents Save in flight; the person excludes A. The walk
  // waits on A's guard; C's claim blocks the app; A's Save finishes and the
  // guard resolves — and neither the focus nor the exclusion may move.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const saves: ((v: unknown) => void)[] = [];
  const cLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }), (url, n) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? (n === 0 ? '' : 'm-x') : 'm-a'), {
    rpc: guestRpc({ registrySave: () => new Promise((r) => { saves.push(r); }) }),
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(conn(h, 'b')?.isConnected(), 'B is a connected member: somewhere the focus could go');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^agents$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const inA = (sel: string) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) ' + sel)];
  inA('.side-row').find((b) => /^agents/iu.test((b.textContent ?? '').trim()))?.click();
  for (let i = 0; i < 4; i++) await h.settle();
  inA('.side-row, button').find((b) => /alpha/u.test(b.textContent ?? '') && !/^agents/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const prompt = inA('.editor textarea')[0] as HTMLTextAreaElement;
  prompt.value = 'Changed on A'; prompt.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  for (let i = 0; i < 2; i++) await h.settle();
  inA('button[aria-label="Save"]')[0]!.click();
  for (let i = 0; i < 6 && saves.length === 0; i++) await h.settle();
  assert.equal(saves.length, 1, 'A s Save is in flight');
  await toConnection(h);
  includeSwitch(h, 'alpha')!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus has not moved: the walk waits');
  store.state.failing = true;
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'blocked');
  saves[0]!({});
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus did not move under the block');
  assert.equal(ls.getItem('tmux_excluded_servers'), null, 'nothing excluded');
  assert.equal(trees(h.app).length, 2, 'nothing ended');
});

test('P1-1: picking an excluded row while blocked (a tree bound) writes nothing — it is an include, with the include s own refusal', async (context) => {
  // A bound and up; C's join blocks the app; D is excluded. Picking D's row
  // is an include, and an include is frozen with the registry.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const cLet = { let: null as (() => void) | null };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }, ['d']), (url, n) => (url.includes('//c') ? (n === 0 ? '' : 'm-x') : url.includes('//d') ? 'm-d' : 'm-a'), {
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  store.state.failing = true;
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'blocked, with A s tree bound');
  await toConnection(h);
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), ['d']);
  const row = [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .server-list .sm-pick')].find((b) => /^delta\b/iu.test((b.textContent ?? '').trim()));
  assert.ok(row, 'D s row');
  row.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.deepEqual(JSON.parse(ls.getItem('tmux_excluded_servers')!), ['d'], 'blocked: the exclusions are not written');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'and nothing switched');
  assert.equal(h.app.document.querySelector('.switch-panel'), null);
});

test('P1-4: a focus exclusion whose exclusion write fails moves the focus BACK — never half done', async (context) => {
  const store = refusing(['tmux_excluded_servers']);
  store.state.failing = false;
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await toConnection(h);
  // The stored set cannot be READ now (setExcluded refuses rather than
  // writing over it): the exclusion fails after the focus moved.
  const get = h.app.window.Storage.prototype.getItem;
  h.app.window.Storage.prototype.getItem = function (this: Storage, k: string) { if (k === 'tmux_excluded_servers') throw new Error('SecurityError'); return get.call(this, k); };
  includeSwitch(h, 'alpha')!.click();
  for (let i = 0; i < 6; i++) await h.settle();
  h.app.window.Storage.prototype.getItem = get;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the focus is back on A');
  assert.equal(ls.getItem('tmux_excluded_servers'), null, 'nothing excluded');
  assert.equal(trees(h.app).length, 2, 'both trees up');
  assert.ok(!trees(h.app).find((x) => x.target === 'work:1.0')!.held, 'A in front');
  assert.match(h.app.document.querySelector('.preferences .server-list [role=alert]')?.textContent ?? '', /storage|retry/iu, `the refusal is said: ${h.app.document.querySelector('.preferences .server-list')?.textContent}`);
});

// ─── #335 ③c-1: the server tag ────────────────────────────────────────

test('③c-1: with two included members every tree s page head names its server; excluding one takes every tag away', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: oneRoomHub() });
  // Both members up, both Hubs probed: a head per tree.
  for (let i = 0; i < 20 && h.app.document.querySelectorAll('.scope-tree .page-head').length < 2; i++) { await h.app.advance(500); await h.settle(); }
  // Every head in a tree (Hub's, Board's) wears the SAME name: its tree's.
  const tags = () => [...new Set([...h.app.document.querySelectorAll<HTMLElement>('.scope-tree .page-head .server-tag')].map((el) => `${el.closest('.scope-tree.held') ? 'held' : 'front'}:${el.textContent}`))];
  assert.ok(h.app.document.querySelectorAll('.scope-tree .page-head .server-tag').length >= 2, 'tags are on the heads');
  assert.deepEqual(tags().sort(), ['front:alpha', 'held:beta'], `each tree names ITS server: ${tags().join(',')}`);
  // One included server: nothing is named — health is not the criterion, the set is.
  await toConnection(h);
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 10 && tags().length; i++) await h.settle();
  assert.deepEqual(tags(), [], 'one included: no tag anywhere');
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 20 && tags().length < 2; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(tags().sort(), ['front:alpha', 'held:beta'], 'included again: named again');
});

test('③c-1: a member that is offline is still included, so the tags stay (the source set, not health)', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: oneRoomHub(), gate: (url, n) => (url.includes('//b') && n > 0 ? new Promise<void>(() => {}) : null) });
  for (let i = 0; i < 20 && !h.app.document.querySelector('.scope-tree .page-head .server-tag'); i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(conn(h, 'b')?.isConnected() ?? false, false, 'B never answers');
  const tags = [...new Set([...h.app.document.querySelectorAll<HTMLElement>('.scope-tree .page-head .server-tag')].map((el) => el.textContent))];
  assert.deepEqual(tags, ['alpha'], 'A s tree names A: two servers are included even though one is down');
});

test('③c-1: Single names nothing', async (context) => {
  const h = await bootApp(context, { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'desktop' }, undefined, { ...sandbox, rpc: oneRoomHub() });
  for (let i = 0; i < 20 && !h.app.document.querySelector('.scope-tree .page-head'); i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(h.app.document.querySelector('.scope-tree .page-head'), 'a head is on screen');
  assert.equal(h.app.document.querySelector('.server-tag'), null);
});

// ─── #335 ③c-2: the Hub sidebar union ─────────────────────────────────

/** Two Hubs with different projects: A has `app` and `old`; B has `app` (a
 * different, more recent project of the same name) and `other`. */
const twoHubs = (extra: Record<string, unknown> = {}) => {
  const proj = (id: string, name: string, live: boolean, at: number) => ({ project: { id, name, session: name, path: `/${name}`, room: `proj:${name}`, updated_at: at }, live, slots: [] });
  const byServer: Record<string, { projects: unknown[]; rooms: Record<string, number> }> = {
    a: { projects: [proj('a-app', 'app', true, 1000), proj('a-old', 'old', false, 10)], rooms: { 'proj:app': 1000 } },
    b: { projects: [proj('b-app', 'app', true, 9000), proj('b-other', 'other', true, 50)], rooms: { 'proj:app': 9000, 'proj:other': 50 } },
  };
  const mine = () => byServer[asking()] ?? { projects: [], rooms: {} };
  return {
    ...oneRoomHub(),
    projectList: async () => ({ projects: mine().projects }),
    hubRooms: async () => ({ rooms: mine().rooms, states: {} }),
    listSessionsWithPanes: async () => ({ sessions: mine().projects.map((p: any) => ({ name: p.project.session, windows: 1 })), panes: [] }),
    projectDown: async () => ({}), projectUp: async () => ({}), projectDelete: async () => ({}),
    ...extra,
  };
};
const sideRows = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row:not(.missing)')]
  .filter((r) => r.querySelector('.p-name'))
  .map((r) => `${r.querySelector('.server-tag')?.textContent ?? '-'}:${r.querySelector('.p-name')?.textContent}${r.classList.contains('open') ? '*' : ''}`);

test('③c-2: the focused Hub s sidebar is the UNION of every included server s projects — merged by the one rule on each server s clock, tagged, keyed by ref', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: twoHubs() });
  // Both lists AND both clocks (hub_rooms answers on its own): the merge is
  // final once every slice has published with its talk map.
  const settledUnion = () => sideRows(h).length === 4 && sideRows(h)[0] === 'beta:app';
  for (let i = 0; i < 40 && !settledUnion(); i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(sideRows(h), ['beta:app', 'alpha:app*', 'beta:other', 'alpha:old'],
    'live first; B s app ahead of A s by B s own clock; A s open; every row tagged');
  assert.equal(h.app.document.querySelectorAll('.scope-tree:not(.held) .hub-root .sidebar .proj-row.missing').length, 0, 'both lists arrived');
  // No second poller: B s list came from B s own Hub (D4).
  assert.ok(events.some((e) => e === 'rpc@b:projectList'), 'B s Hub asked B');
});

test('③c-2: picking another server s row moves the focus there (D2) and selects THAT project in its Hub; nothing is torn down', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs() });
  for (let i = 0; i < 40 && !(sideRows(h).length === 4 && sideRows(h)[0] === 'beta:app'); i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, b = conn(h, 'b')!;
  const rowB = [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row')].find((r) => r.dataset.server === 'b' && r.querySelector('.p-name')?.textContent === 'other')!;
  rowB.querySelector<HTMLButtonElement>('.proj-pick')!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) await h.settle();
  for (let i = 0; i < 10 && !sideRows(h).includes('beta:other*'); i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  assert.ok(sideRows(h).includes('beta:other*'), `B s Hub selected other: ${sideRows(h).join(',')}`);
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .chat-head .h1-text')?.textContent, 'other', 'B s head names it');
  assert.ok(a.isConnected() && b.isConnected() && !a.disposed(), 'both up, nothing torn down');
  assert.deepEqual(sideRows(h), ['beta:app', 'alpha:app', 'beta:other*', 'alpha:old'], 'the same union, now from B s Hub, with B s row open');
  // The landing was B s alone: A s Hub, behind, still has its own room open.
  assert.equal(h.app.document.querySelector('.scope-tree.held .hub-root .chat-head .h1-text')?.textContent, 'app', 'A s Hub did not read a landing aimed at B');
  // And back on A, A s Hub is as it was — no landing replays.
  await pickServer(h, 'alpha');
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .hub-root .chat-head .h1-text')?.textContent, 'app');
});

test('③c-2/P1-C1: another server s row Close/Delete is the ONE project-action flow — confirmed, by B s project ID, on B s api frozen at the ask; Delete is close + archive, never purge; a focus move during the confirm does not change the target; a server with no live runtime offers nothing; a server whose list has not come is listed as missing', async (context) => {
  const events: string[] = [];
  const args: string[] = [];
  const cLet = { let: null as (() => void) | null };
  let bRefuses = false;
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', machineId: 'm-c', named: true },
  ];
  // A and B both have a project named `app` whose id ≠ session (`a-app` / `b-app`).
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//b') ? 'm-b' : url.includes('//c') ? 'm-c' : 'm-a'), {
    ...sandbox, calls: events, rpc: twoHubs({
      projectDown: async (id: string) => { args.push(`${asking()}:down:${id}`); if (bRefuses && asking() === 'b') throw new Error('B refused'); return {}; },
      projectArchive: async (id: string, archived: boolean) => { args.push(`${asking()}:archive:${id}:${archived}`); return {}; },
      projectDelete: async (id: string) => { args.push(`${asking()}:PURGE:${id}`); return {}; },
    }),
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window: any) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const missing = [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row.missing .p-name')].map((n) => n.textContent);
  assert.deepEqual(missing, ['charlie'], 'C, included but not answering, is listed as missing — not silently absent');
  const menuOf = async (server: string, name: string) => {
    const row = [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row')].find((r) => r.dataset.server === server && r.querySelector('.p-name')?.textContent === name)!;
    row.querySelector<HTMLButtonElement>('.row-menu')!.click();
    for (let i = 0; i < 3; i++) await h.settle();
    return (re: RegExp) => [...h.app.document.querySelectorAll<HTMLButtonElement>('[role=menu] button, .ctx-menu button, .menu-item')].find((b) => re.test(b.textContent ?? ''))!;
  };
  const dialog = () => h.app.document.querySelector('[role=alertdialog]');
  // Close B's `app` (same name as A's): confirmed first, zero mutation until then.
  let pick = await menuOf('b', 'app');
  pick(/close/iu).click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(dialog(), 'a cross-server Close asks first, like a local one');
  assert.match(dialog()!.textContent ?? '', /app.*beta|beta.*app/su, `the confirmation names project AND server: ${dialog()!.textContent}`);
  assert.deepEqual(args, [], 'zero mutation before the confirm');
  // Cancel: zero calls.
  answerDialog(h.app, /^cancel$/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(dialog(), null);
  assert.deepEqual(args, [], 'Cancel: zero calls');
  // Ask again; move the FOCUS to B while the dialog is open (the target is
  // frozen: still B's `app`, by B's id, on B's api); confirm.
  pick = await menuOf('b', 'app');
  pick(/close/iu).click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(dialog());
  await pickServer(h, 'beta');
  for (let i = 0; i < 4; i++) await h.settle();
  // (the dialog belongs to A's Hub, now held; answer it there)
  answerDialog(h.app, /^close$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(50); await h.settle(); }
  assert.deepEqual(args, ['b:down:b-app'], `confirmed: only B, by B s project ID, not the session name: ${args.join(',')}`);
  assert.ok(!events.some((e) => e === 'rpc@a:projectDown'), 'never to A');
  // Back on A; Delete B's `other`: close + archive on B, never projectDelete.
  await pickServer(h, 'alpha');
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  args.length = 0;
  pick = await menuOf('b', 'other');
  pick(/delete/iu).click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(dialog(), 'Delete asks');
  assert.match(dialog()!.textContent ?? '', /recycle bin|回收站/iu, 'and it is the recoverable archive, not a purge');
  answerDialog(h.app, /^delete$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(50); await h.settle(); }
  assert.deepEqual(args, ['b:down:b-other', 'b:archive:b-other:true'], `close then archive, on B, by id: ${args.join(',')}`);
  assert.ok(!args.some((a: string) => a.includes('PURGE')), 'projectDelete (irreversible) is never called from a row menu');
  // B refuses: the error is shown on the same target, and Retry does not
  // redo the completed step.
  args.length = 0; bRefuses = true;
  pick = await menuOf('b', 'app');
  pick(/close/iu).click();
  for (let i = 0; i < 3; i++) await h.settle();
  answerDialog(h.app, /^close$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(50); await h.settle(); }
  assert.ok(dialog(), 'the dialog stays on the failed target');
  assert.match(dialog()!.textContent ?? '', /B refused/u, `the error is visible: ${dialog()!.textContent}`);
  assert.deepEqual(args, ['b:down:b-app']);
  bRefuses = false;
  answerDialog(h.app, /^close$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(50); await h.settle(); }
  assert.equal(dialog(), null, 'retried and done');
  assert.deepEqual(args, ['b:down:b-app', 'b:down:b-app'], 'the retry runs the failed step on the same target');
});

// What this proves is the USER-visible half: once B is excluded, B is asked
// nothing more by either page. It cannot see a leaked timer (a detached
// runtime refuses the call before it is recorded), so the timer's clearing is
// held by the Board.source pin, with its own negative control.
test('#357 (D4, leave): once a hidden member is excluded, its server is asked no more list or count reads by the Hub or the Board', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: twoHubs({ boardCounts: async () => ({ counts: {} }), boardList: async () => ({ issues: [], statuses: [] }) }) });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const countOf = (n: string) => events.filter((e) => e === `rpc@b:${n}`).length;
  const mark0 = countOf('boardCounts');
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  assert.ok(countOf('boardCounts') - mark0 >= 2, `hidden B s Board refreshes its counts while included: ${countOf('boardCounts') - mark0}`);
  await toConnection(h);
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
  const mark = { counts: countOf('boardCounts'), lists: countOf('projectList') };
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  assert.equal(countOf('boardCounts'), mark.counts, 'excluded: no more Board count refreshes of B');
  assert.equal(countOf('projectList'), mark.lists, 'excluded: no more list refreshes of B at all (Hub or Board)');
});

test('③c-2 (D4): a hidden member s Hub refreshes only its list — no room is opened, no feed/roster/activity polled — until it is shown', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: twoHubs({ boardCounts: async () => ({ counts: {} }), boardList: async () => ({ issues: [], statuses: [] }) }) });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  // A minute hidden: B s list refreshed (20 s cadence) and nothing else.
  const before = events.length;
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  const b = events.slice(before).filter((e) => e.startsWith('rpc@b:')).map((e) => e.slice('rpc@b:'.length));
  const room = b.filter((n) => /^hub(Log|Agents|Activity|Read)$/u.test(n));
  assert.deepEqual(room, [], `hidden B opened no room and polled nothing of one: ${b.join(',')}`);
  // Two pages publish a project list from a hidden member since #357 — the
  // Hub's and the Board's — each on its own 20 s cadence (~3 a minute apiece),
  // so the member's list reads are the SUM, not one. What D4 forbids is room
  // and board-DETAIL work: no issue list, no issue, no note while hidden.
  const lists = b.filter((n) => n === 'projectList').length;
  assert.ok(lists >= 4 && lists <= 8, `B s Hub and Board lists refreshed on their cadence (~3 in a minute each): ${lists}`);
  assert.ok(b.filter((n) => n === 'boardCounts').length >= 2, `the hidden Board refreshes its counts: ${b.join(',')}`);
  assert.deepEqual(b.filter((n) => /^board(List|Get|Save|Note|Delete)$/u.test(n)), [], 'and nothing of a board s issues while hidden');
  // Shown (focus B, back on the Hub page): B s room opens.
  await pickServer(h, 'beta');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^chat$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 10; i++) { await h.app.advance(300); await h.settle(); }
  const after = events.filter((e) => e.startsWith('rpc@b:')).map((e) => e.slice('rpc@b:'.length));
  assert.ok(after.includes('hubLog') && after.includes('hubAgents'), 'shown: B s room is open');
  // Back to A: B, with a room OPEN, is hidden again — its room polls stop,
  // its list refresh goes on.
  await pickServer(h, 'alpha');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^chat$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const mark = events.length;
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  const hidden = events.slice(mark).filter((e) => e.startsWith('rpc@b:')).map((e) => e.slice('rpc@b:'.length));
  assert.deepEqual(hidden.filter((n) => /^hub(Log|Agents|Activity)$/u.test(n)), [], `hidden again, room open: no room poll of B: ${hidden.join(',')}`);
  assert.ok(hidden.filter((n) => n === 'projectList').length >= 2, 'but its list still refreshes');
  // The PUSH path (reviewer P2-1 on 018d4fa5): a turn message arrives on
  // hidden B's OPEN room. List work only — the unread badge (`hubUnread`) and
  // the notification record — never the room's: no feed scroll, no
  // `hubAgents` roster refresh. Exact counts per method, not only projectList.
  const pushMark = events.length;
  conn(h, 'b')!.push({ id: '501', seq: 501, ts: 1_800_000_020_000, from: 'ops', to: ['human'], body: 'turn on hidden B', room: 'proj:app' });
  for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
  const afterPush = events.slice(pushMark).filter((e) => e.startsWith('rpc@b:')).map((e) => e.slice('rpc@b:'.length));
  const count = (n: string) => afterPush.filter((x) => x === n).length;
  assert.deepEqual({ hubAgents: count('hubAgents'), hubLog: count('hubLog'), hubActivity: count('hubActivity') }, { hubAgents: 0, hubLog: 0, hubActivity: 0 }, `a push on hidden B does no room work: ${afterPush.join(',')}`);
  // `hubRead` MAY appear once: it is the #334 re-send of a read mark made
  // while B was SHOWN (the tail was on screen then) that the unread refresh
  // retries until the server ACKs it — a read that happened, not new room work.
  assert.ok(count('hubRead') <= 1 && count('hubUnread') <= 1 && count('projectList') <= 1 && count('listSessionsWithPanes') <= 1 && count('hubRooms') <= 1, `list work only, once at most each: ${afterPush.join(',')}`);
});

// ─── reviewer R1 / R2 on aed2f654 ─────────────────────────────────────

test('R1: an alias absorbed while the post-dial gate then BLOCKS — the alias sends no RPC during the block, its tree and draft stay, and after Retry it is still an orphan to ask', async (context) => {
  // As P1-5: C focused, alias A a live member with a draft. C s reconnect
  // lands on A s address and absorbs A; this time the claim s marker write
  // fails right after, so the app blocks with the orphan just made.
  // The merge NOTE write fails right after the registry commits the absorption
  // (the fixture 'Retry whose CURRENT already names the canonical' uses).
  const store = refusing(['tmux_server_merges']);
  store.state.failing = false;
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    tmux_servers: JSON.stringify([
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
    ]),
    tmux_server_current: 'c', tmux_address: 'ws://canonical:9899', tmux_token: 'tok', tmux_machine_id: 'm-a',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'c' }),
    'tmux_state::c': JSON.stringify({ page: 'files' }), 'tmux_state::a': JSON.stringify({ page: 'files' }),
    tmux_layout_mode: 'desktop',
  }), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(conn(h, 'a')?.isConnected(), 'the alias is a live member');
  await pickServer(h, 'alias');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftA = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'canon');
  const a = conn(h, 'a')!;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  // The reconnect records (absorbing A) and then the gate's claim write fails.
  store.state.failing = true;
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.ok(movesOpen(ls), 'and the merge could not be finished: blocked');
  const mark = events.length;
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'during the block the alias sends NO RPC: detached at the boundary');
  assert.equal(a.isConnected(), false, 'its socket is closed');
  assert.equal(a.disposed(), false, 'but not ended: its tree is still its own');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'its tree and draft are kept');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'and it is not asked while blocked (the tree is held)');
  // Retry: unblocked; now the orphan is asked, in its tree.
  store.state.failing = false;
  // The block put the connect card up (the focus's reconnect could not be
  // recorded); Preferences, where the pick was made, is off screen — nothing
  // was asked or revealed inside the reconcile (P1-B). The Retry is the
  // card's.
  const prefs = h.app.document.querySelector('.preferences');
  if (prefs && !prefs.closest('.page-layer.hidden')) {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();   // the gear toggles Preferences off
    for (let i = 0; i < 3; i++) await h.settle();
  }
  const retry = [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button, .connect-layer button')].find((b) => /retry/iu.test(b.textContent ?? ''));
  assert.ok(retry, `Retry offered: ${[...h.app.document.querySelectorAll('button')].map((b: any) => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 16).join('|')}`);
  retry.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'after Retry the orphan is asked, in its own tree');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'kept');
});

for (const dirty of [true, false]) test(`R2(a): a member orphaned while a switch to C is in flight does not pre-empt the switch — C completes; ${dirty ? 'B s draft is intact and asked afterwards' : 'a clean B is dismissed without ever ending C s intent'}`, async (context) => {
  let bAnswersAs = 'm-b';
  const cLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : url.includes('//c') ? 'm-c' : 'm-a'), {
    rpc: editorRpc,
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  let draftB: HTMLTextAreaElement | null = null;
  if (dirty) {
    await pickServer(h, 'beta');
    for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
    draftB = await dirtyEditor(h.app, h.settle);
    await pickServer(h, 'alpha');
  }
  // A switch to a NEW server C, whose own dial hangs.
  await switchByAddress(h, 'ws://c:9899', 'tokC');
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(cLet.let, 'C s own dial is out');
  assert.ok(h.app.document.querySelector('.switch-panel'), 'the switch is in flight');
  // B s reconnect reaches D: B is orphaned mid-switch.
  bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'no question over the switch');
  assert.ok(h.app.document.querySelector('.switch-panel'), 'the switch is still in flight: not pre-empted');
  // C answers: the switch completes.
  cLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  const cId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://c:9899')?.id;
  assert.ok(cId && ls.getItem('tmux_server_current') === cId, `C came up and is CURRENT: ${ls.getItem('tmux_server_current')}`);
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'the panel is gone');
  if (dirty) {
    assert.equal(draftB!.isConnected && draftB!.value, '# notes\n\nunsaved', 'B s draft is intact');
    const asked = h.app.document.querySelector('[role=alertdialog]');
    assert.ok(asked && asked.closest('.scope-tree') === draftB!.closest('.scope-tree'), 'now B is asked, in its tree');
    assert.ok(!asked.closest('.scope-tree.held, [inert]'), 'answerable');
    answerDialog(h.app, /keep editing/iu);
    for (let i = 0; i < 3; i++) await h.settle();
    assert.equal(draftB!.isConnected && draftB!.value, '# notes\n\nunsaved', 'kept');
  } else {
    assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'a clean orphan asks nothing');
    assert.ok(conn(h, 'b')!.disposed(), 'and is dismissed');
  }
});

test('R2(b): a block between the orphan s confirmation and its dismissal keeps the tree — the stale answer destroys nothing; after Retry it can be handled again', async (context) => {
  // B is orphaned (reaches D) with a dirty Files draft; its ask is up. The
  // person answers Discard — but C s join blocks the app in the same turn
  // the walk is winding down: the stale true must not end B.
  const store = refusing(['tmux_state_layout']);
  store.state.failing = false;
  let bAnswersAs = 'm-b';
  const cLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'c', name: 'charlie', address: 'ws://c:9899', token: 'tokC', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_machine_id: 'm-x', tmux_server_current: 'gone', tmux_layout_mode: 'desktop',
  }, ['d']), (url, n) => (url.includes('//b') ? bAnswersAs : url.includes('//c') ? (n === 0 ? '' : 'm-x') : url.includes('//d') ? 'm-d' : 'm-a'), {
    rpc: editorRpc,
    gate: (url, n) => (url.includes('//c') && n > 0 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { store.setup(window); window.history.replaceState(null, '', '/?addr=ws://a:9899&token=tokA'); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(cLet.let, 'C s join is held');
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'B is asked');
  // Discard — and C s claim blocks before the walk has wound down.
  store.state.failing = true;
  answerDialog(h.app, /^discard$/iu);
  cLet.let!();
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_state_layout')!).state, 'pending', 'blocked');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'the stale Discard destroyed nothing: B s tree is kept');
  assert.ok(!conn(h, 'b')!.disposed(), 'B s runtime is not ended');
  // Retry: B is asked again, and this time Discard lands.
  store.state.failing = false;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^terminal$/iu.test((b.getAttribute('aria-label') ?? '').trim()))?.click();
  for (let i = 0; i < 2; i++) await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.switch-panel button, .card button')].find((b) => /retry/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  const again = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(again && again.closest('.scope-tree') === draftB.closest('.scope-tree'), 'asked again after Retry');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(draftB.isConnected, false, 'now it goes');
  assert.ok(conn(h, 'b')!.disposed());
});

// ─── reviewer P1-A / P1-B / P2 on e0dafe3c ─────────────────────────────

/** C canonical (m-a) and A, an address-only alias of the same machine, both
 * saved and both included; which is focused is the case's. A's address
 * answers with no machine id until `aliasProves` is set. */
const canonAndAlias = (current: 'c' | 'a') => ({
  tmux_servers: JSON.stringify([
    { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
  ]),
  tmux_server_current: current, tmux_address: current === 'c' ? 'ws://canonical:9899' : 'ws://alias:9899', tmux_token: 'tok', tmux_machine_id: 'm-a',
  tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'c' }),
  'tmux_state::c': JSON.stringify({ page: 'files' }), 'tmux_state::a': JSON.stringify({ page: 'files' }),
  tmux_layout_mode: 'desktop',
});
test('P1-A: a background canonical absorbs the FOCUSED alias — the alias s captured api refuses at once, its draft stays, and CURRENT, the mirror and the front all hand over to the canonical; then a post-commit block, and Retry asks the orphan', async (context) => {
  // The REVERSE of R1: A (alias) is the focus with a Files draft, C (canonical)
  // a background member. C s own reconnect takes the failover to A s address,
  // which now proves m-a: recordServer absorbs A into C and moves CURRENT to C
  // — with no window activation anywhere to bring C to the front.
  const store = refusing(['tmux_server_merges']);
  store.state.failing = false;
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the alias is the focus');
  assert.ok(conn(h, 'c')?.isConnected(), 'the canonical is a live member');
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  const aApi = a.api;                                        // a method A s page captured
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  // ── (1) the merge commits: C s reconnect absorbs A.
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.ok(!movesOpen(ls), 'the merge finished');
  // The vanishing handle refuses from the boundary: a captured call is refused, no RPC goes out.
  const mark = events.length;
  await assert.rejects(() => aApi.fsList!('/home'), 'A s captured api refuses');
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'nothing of A s reached the wire');
  assert.equal(a.isConnected(), false, 'A s socket is closed');
  assert.equal(a.disposed(), false, 'but A is not ended: its tree is kept');
  // The focus handed over to the canonical, consistently.
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT names the canonical');
  assert.equal(ls.getItem('tmux_address'), 'ws://alias:9899', 'the mirror follows C s entry — whose active address is the one that just answered');
  assert.ok(conn(h, 'c')!.isConnected(), 'C is up');
  assert.equal(trees(h.app).length, 2, 'two trees: C s and A s, kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft is kept');
  // Once C s own bring-up had settled, A — an orphan — was asked, in its own
  // tree (revealed for the walk, as every member s ask is).
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the orphan is asked in its tree');
  assert.ok(!asked.closest('.scope-tree.held, [inert]'), 'answerable');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'kept');
  // The walk over: the front is the canonical s tree, A s held behind it.
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the focus is C');
  assert.ok(draftA.closest('.scope-tree.held'), 'A s tree is behind');
  const frontTree = h.app.document.querySelector('.scope-tree:not(.held)');
  assert.ok(frontTree && frontTree !== draftA.closest('.scope-tree'), 'the front is C s tree');
  // C s list row is the focus; A is listed as an orphan with Dismiss.
  await toConnection(h);
  const prefsRows = [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].map((b) => (b.textContent ?? '').trim());
  assert.ok(prefsRows.some((r) => /^canon/iu.test(r)), `the list shows canon: ${prefsRows.join('|')}`);
  assert.ok(h.app.document.querySelector('.preferences button[aria-label^="Dismiss"]'), `A is listed with Dismiss: ${[...h.app.document.querySelectorAll('.preferences button')].map((b: any) => b.getAttribute('aria-label') ?? b.textContent?.trim()).join('|')}`);
});

test('P1-A (blocked): the canonical absorbs the focused alias and the merge NOTE then fails — A refuses and is kept, the app blocks on C as the focus, nothing is asked while blocked, Retry asks A', async (context) => {
  const store = refusing(['tmux_server_merges']);
  store.state.failing = false;
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  store.state.failing = true;                               // the registry commits, the note fails
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.ok(movesOpen(ls), 'and the merge could not be finished: blocked');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is the canonical');
  const mark = events.length;
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'during the block A sends NO RPC');
  assert.equal(a.isConnected(), false);
  assert.equal(a.disposed(), false, 'not ended');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'draft kept');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'not asked while blocked');
  store.state.failing = false;
  const prefs = h.app.document.querySelector('.preferences');
  if (prefs && !prefs.closest('.page-layer.hidden')) {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
  }
  const retry = retryButton(h.app);
  assert.ok(retry, `Retry offered: ${[...h.app.document.querySelectorAll('button')].map((b: any) => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 16).join('|')}`);
  retry.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(!movesOpen(ls), 'the merge finished on Retry');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'after Retry the orphan is asked, in its own tree');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(draftA.isConnected, false, 'discarded: the tree goes');
  assert.ok(a.disposed(), 'and A is ended');
  assert.ok(conn(h, 'c')!.isConnected(), 'C, the focus, is untouched');
});

test('P1-B(a): C s address row dials the alias s address (a WINDOW owner) and absorbs A — the address change completes (addressUp) BEFORE A is asked, and the ask does not expire it', async (context) => {
  // C is the focus, A the alias a background member. On C s Connection page
  // the alias address is one of m-a s rows: picking it redials C there,
  // which proves m-a and absorbs A inside C s own dial.
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('c')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(conn(h, 'a')?.isConnected(), 'the alias is a live member');
  await pickServer(h, 'alias');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftA = await dirtyEditor(h.app, h.settle);
  // m-a learns the alias address as one of its own (a failover set edit);
  // the next dial there proves it. Learned while A is the focus, so C s
  // Connection page, once C is, lists it among C s rows.
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  await pickServer(h, 'canon');
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  await toConnection(h);
  for (let i = 0; i < 3; i++) await h.settle();
  const row = h.app.document.querySelector<HTMLButtonElement>('[data-addr-row="ws://alias:9899"] .address-choice');
  assert.ok(row, `the alias address is a row of C s: ${[...h.app.document.querySelectorAll('[data-addr-row]')].map((r: any) => r.dataset.addrRow).join(',')}`);
  const dialsBefore = events.filter((e) => e.startsWith('dial@c:')).length;
  row.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the redial absorbed the alias');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  // The address change COMPLETED: C s entry is on the alias address and the shell followed.
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!)[0].address, 'ws://alias:9899', 'C s active address moved');
  assert.ok(c.isConnected(), 'C is up on it');
  assert.equal(events.filter((e) => e.startsWith('dial@c:')).length, dialsBefore + 1, 'one dial, not a reconnect loop after a superseded one');
  const active = h.app.document.querySelector<HTMLElement>('[data-addr-row="ws://alias:9899"] .address-choice.active');
  assert.ok(active, 'the row is the active one: addressUp ran');
  // And the orphan: detached at the boundary, kept, asked only now.
  assert.equal(a.isConnected(), false, 'A s socket closed');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A is asked, in its tree, after the address change');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(c.isConnected() && ls.getItem('tmux_server_current') === 'c', 'C untouched by the answer');
});

test('P1-B(b): the connect form s owned second handshake — the candidate s record absorbs the alias member, C s own runtime then dials — completes and binds before A is asked', async (context) => {
  // C focus, A alias member. The person disconnects C and connects the form
  // to the alias address: the candidate proves m-a, and its record folds the
  // address into C (same machine, no switch) and absorbs A. Then C s OWN
  // runtime dials — the owned second handshake, a window activation — and
  // the orphan s ask waits for it to bind.
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('c')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  await pickServer(h, 'alias');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftA = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'canon');
  const a = conn(h, 'a')!;
  aliasProves = true;
  // Disconnect C: the connect card is up, C s tree bound and kept.
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]');
  assert.ok(field, 'the connect card is up');
  field.value = 'ws://alias:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  const mark = events.length;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 10; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'the same machine: C stays the focus');
  const c = conn(h, 'c')!;
  assert.ok(c.isConnected(), 'C came up through its own handshake');
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!)[0].address, 'ws://alias:9899', 'on the address the form dialled');
  // The activation COMPLETED — its `up` ran (the caps probe is its first
  // call): the ask did not expire the owned second handshake.
  assert.ok(events.slice(mark).includes('rpc@c:hubRooms'), `C s bring-up published: ${events.slice(mark).filter((e) => e.startsWith('rpc@c:')).join(',')}`);
  // The form is done — the app is on C; the connect layer is off screen
  // (held mounted only while the orphan s walk reveals A s page).
  assert.ok(h.app.document.querySelector('.connect-layer')?.classList.contains('hidden'), 'the connect card is off screen');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)'), 'a tree is in front');
  assert.equal(a.isConnected(), false); assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A asked in its tree once the form s activation is done');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(c.isConnected(), 'C untouched');
  assert.equal(h.app.document.querySelector('.connect-layer'), null, 'the walk over, the app is on C: no connect card');
  await toConnection(h);
  assert.ok([...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].some((b) => /^disconnect$/iu.test((b.textContent ?? '').trim())), 'connected, as Preferences shows');
});

test('P1-B(c): the connect form s CANDIDATE is a window owner too — B orphaned while the form dials N is not asked over the candidate, nor over N s own handshake; N comes up, then B is asked once', async (context) => {
  // A focus, B member with a draft. The person disconnects A and connects the
  // form to a new server N: its candidate dial is held; meanwhile B s
  // reconnect reaches D and B is orphaned. Asking now would claim the window
  // and kill the form s attempt. Then N s own runtime dials (held again): the
  // same. Only once N is bound is B asked.
  let bAnswersAs = 'm-b';
  const nLet: ((() => void) | null)[] = [null, null];
  let nDials = 0;
  const events: string[] = [];
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: editorRpc,
    gate: (url) => (url.includes('//n') ? new Promise<void>((r) => { nLet[nDials++] = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6 && !nLet[0]; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(nLet[0], 'the candidate s dial is out');
  // B is orphaned while the candidate dials.
  bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B detached at the boundary');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'not asked over the candidate');
  assert.ok(h.app.document.querySelector('.card .fields input[type="text"]'), 'the form is still at it');
  // The candidate answers: recorded (N is new, CURRENT moves), and N s OWN
  // runtime dials — held too.
  nLet[0]!();
  for (let i = 0; i < 6 && !nLet[1]; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(nLet[1], 'N s own dial is out');
  const nId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://n:9899')?.id;
  assert.ok(nId && ls.getItem('tmux_server_current') === nId, 'CURRENT names N');
  for (let i = 0; i < 3; i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'not asked over N s own handshake either');
  nLet[1]!();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  const n = h.net.conns().find((c) => c.key === nId);
  assert.ok(n?.isConnected(), 'N is up');
  assert.ok(events.some((e) => e === `rpc@${nId}:hubRooms`), 'and published: the activation completed');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'B s draft intact');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), 'now B is asked, in its tree');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'asked once');
  assert.ok(n!.isConnected() && ls.getItem('tmux_server_current') === nId, 'N untouched');
});

test('P1-A (Single): a connect whose record absorbs the FOCUS — the focus handle refuses at the fleet boundary while the target still dials; the target comes up and the swap ends it', async (context) => {
  // Single mode: nobody can take the absorbed focus over, so there is no
  // handover — but the vanishing handle refuses at once all the same. A
  // (alias) is the focus, C (canonical) saved but not a member; the connect
  // card with the alias address (the address IS A s own, so the switcher
  // would refuse it as "already current"): the candidate proves m-a, the
  // record folds the address into C and absorbs A, CURRENT moves to C, and
  // C s own runtime dials (held).
  let aliasProves = false;
  let aliasDials = 0;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, { ...canonAndAlias('a'), tmux_connection_mode: 'single' }, (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: editorRpc,
    // Alias dials: 1 the boot, 2 the form s candidate, 3 C s own — held.
    gate: (url) => (url.includes('//alias') && ++aliasDials === 3 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  const a = conn(h, 'a')!;
  const aApi = a.api;
  const draftA = await dirtyEditor(h.app, h.settle);
  aliasProves = true;
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://alias:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  // The form s own walk asks A s draft first (any address can be another
  // server): discard — the handle s refusal is what this case is about.
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'the form asks A s tree before dialling');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 8 && !cLet.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(cLet.let, `C s own dial is out: ${events.filter((e) => /^(dial|answered)/u.test(e)).join(' ')}`);
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the form s record absorbed A');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  // A: out of the fleet, out of service — now, not when C is bound.
  const mark = events.length;
  await assert.rejects(() => aApi.fsList!('/home'), 'A s captured api refuses');
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'nothing of A s reached the wire');
  assert.equal(a.disposed(), false, 'A s tree is still bound until C is bound');
  assert.equal(draftA.isConnected, true, 'its tree still mounted (the discard lands with the swap)');
  cLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(conn(h, 'c')!.isConnected(), 'C is up');
  assert.ok(a.disposed(), 'and the swap ended A');
  assert.equal(draftA.isConnected, false, 'A s tree went with it, as the person answered');
});

test('P1-A (mid-switch): a member absorbing the focus WHILE a switch to N is in flight hands nothing over — A refuses, the switch is not pre-empted, N comes up, C stays a member', async (context) => {
  // A alias focus, C canonical member, a switch to a new server N whose own
  // dial hangs. C s reconnect reaches A s address and absorbs A: CURRENT is
  // C for a moment, then the switch s record makes it N. A handover to C
  // would supersede the switch mid-flight and leave its panel up for good.
  let aliasProves = false;
  const nLet = { let: null as (() => void) | null };
  const events: string[] = [];
  // A s tree has a Hub with a room open: hidden under the panel it still
  // polls its list (D4) — through its runtime s gated api, which is what a
  // detached runtime refuses.
  const h = await bootApp(context, aggregateOn({ ...canonAndAlias('a'), 'tmux_state::a': JSON.stringify({ page: 'hub' }) }), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, ...oneRoomHub(), findBestAddress: async () => 'ws://alias:9899' },
    gate: (url, n) => (url.includes('//n') && n > 0 && !nLet.let ? new Promise<void>((r) => { nLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.ok(conn(h, 'c')?.isConnected(), 'the canonical is a live member');
  assert.ok(events.includes('rpc@a:projectList'), 'A s Hub is up');
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  // The switch: its confirm walk asks A s draft — discard — then N s dial hangs.
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  if (h.app.document.querySelector('[role=alertdialog]')) { answerDialog(h.app, /^discard$/iu); for (let i = 0; i < 3; i++) await h.settle(); }
  for (let i = 0; i < 6 && !nLet.let; i++) { await h.app.advance(300); await h.settle(); }
  assert.ok(nLet.let, 'N s dial is out');
  assert.ok(h.app.document.querySelector('.switch-panel'), 'the switch is in flight');
  // C absorbs A meanwhile.
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.ok(!JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'a'), 'the alias was absorbed');
  assert.ok(h.app.document.querySelector('.switch-panel'), 'the switch is still in flight: not pre-empted');
  // A is detached at the boundary — socket closed, api refusing — though a
  // switch closes nothing of its source s otherwise (P1-B on 4c7cd64c: the
  // detach is unconditional); its hidden Hub s list poll never reaches the
  // wire.
  assert.equal(a.isConnected(), false, 'A s socket is closed');
  const mark = events.length;
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'a minute on: A s Hub poll never reaches the wire — the runtime refuses');
  assert.equal(a.disposed(), false, 'A s tree still bound under the panel');
  // N answers: the switch completes onto N; C is a member of N s set.
  nLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  const nId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://n:9899')?.id;
  assert.ok(nId && ls.getItem('tmux_server_current') === nId, `N is CURRENT: ${ls.getItem('tmux_server_current')}`);
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'the panel is gone');
  assert.ok(a.disposed(), 'the swap ended A');
  assert.equal(draftA.isConnected, false, 'as the person answered');
  assert.ok(conn(h, 'c')!.isConnected(), 'C is up, a member');
  assert.equal(trees(h.app).length, 2, 'N s tree and C s');
});



test('P1-A (beneath a walk): the canonical absorbs the focus WHILE a switch s confirm walk asks A s tree — no handover beneath the walk; Discard lets the switch go on to N; C stays a member', async (context) => {
  // A alias focus with a draft, C canonical member whose reconnect (to A s
  // address) hangs. The person switches to N: the confirm walk asks A s
  // draft. C answers mid-walk and absorbs A — CURRENT moves to C (the
  // absorbed id WAS current). A handover here would put C in front beneath
  // the switch s own question; instead A refuses and the walk goes on.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the switch s walk asks A s tree');
  // C answers beneath the walk.
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.ok(!JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'a'), 'the alias was absorbed');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT moved to the canonical (the record s doing)');
  assert.ok(c.isConnected(), 'C is up');
  assert.equal(a.disposed(), false, 'A still bound');
  assert.ok(!draftA.closest('.scope-tree.held'), 'A s tree is still the one in front, its question up: no handover beneath the walk');
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the question still stands');
  // Discard: the switch goes on to N, binds it, the swap ends A; C a member.
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 10; i++) { await h.app.advance(500); await h.settle(); }
  const nId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://n:9899')?.id;
  assert.ok(nId && ls.getItem('tmux_server_current') === nId, `N is CURRENT: ${ls.getItem('tmux_server_current')}`);
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'the switch is done');
  assert.ok(a.disposed(), 'the swap ended A');
  assert.ok(c.isConnected() && !c.disposed(), 'C, a member, never bound and never ended');
  assert.equal(trees(h.app).length, 2, 'N s tree and C s');
});

test('P1-A (owed): the canonical absorbs the focus beneath a switch s confirm walk; Keep editing ends the switch — the OWED handover then completes: A s draft kept, old api refusing, CURRENT, mirror and front on the canonical, A asked as an orphan', async (context) => {
  // reviewer P1-A on 4c7cd64c: a handover deferred under a window operation
  // is owed work, not dropped. The operation here ends with nothing bound
  // (Keep editing refuses the switch), so the handover completes on the
  // window s own turn — no third server, no reload.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const aApi = a.api;
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the switch s walk asks A s tree');
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses at the boundary, walk or no walk');
  assert.ok(!draftA.closest('.scope-tree.held'), 'A s tree still in front under its question: nothing handed over beneath the walk');
  // Keep editing: the switch ends with nothing bound. The owed handover
  // completes on the next turn.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(events.filter((e) => e === 'connect:ws://n:9899').length, 0, 'N was never dialled');
  assert.equal(h.app.document.querySelector('.switch-panel'), null, 'no switch panel');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is the canonical');
  assert.equal(ls.getItem('tmux_address'), 'ws://alias:9899', 'the mirror is C s');
  assert.ok(c.isConnected(), 'C is up');
  assert.equal(a.disposed(), false, 'A is kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft is mounted');
  // The handover done, A is an orphan: asked, in its own tree.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A is asked as an orphan: ${asked ? 'elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind');
  const front = h.app.document.querySelector('.scope-tree:not(.held)');
  assert.ok(front && front !== draftA.closest('.scope-tree'), 'C s tree in front');
  assert.equal(trees(h.app).length, 2);
  // C is the focus: picking it is a no-op, A is listed with Dismiss.
  await toConnection(h);
  assert.ok(h.app.document.querySelector('.preferences button[aria-label^="Dismiss"]'), 'A listed as an orphan');
  const mark = events.length;
  await pickServer(h, 'canon');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('dial@')), [], 'nothing dialled');
});

test('P1-A (owed, cancelled form): the canonical absorbs the focus beneath the form s candidate to N; Cancel ends the attempt with nothing bound — the owed handover completes to the canonical', async (context) => {
  // The other exit the ruling names: the window operation is a form attempt
  // whose candidate is cancelled. Nothing bound; the handover is still owed.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const nLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; })
      : url.includes('//n') && !nLet.let ? new Promise<void>((r) => { nLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  // The form s walk asks A: discard (the candidate then dials and hangs).
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6 && !nLet.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(nLet.let, 'the candidate s dial to N is out');
  // C answers beneath it: A absorbed, CURRENT = C, A detached, handover owed.
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c']);
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  await assert.rejects(() => a.api.fsList!('/home'), 'A refuses');
  assert.ok(h.app.document.querySelector('.card .fields input[type="text"]'), 'the form is still at it');
  assert.equal(a.disposed(), false);
  // Cancel: nothing bound. The owed handover completes.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is the canonical');
  assert.equal(ls.getItem('tmux_address'), 'ws://alias:9899', 'the mirror is C s');
  assert.ok(c.isConnected(), 'C is up');
  assert.equal(trees(h.app).length, 2, 'C s tree and A s');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft mounted');
  // A, an orphan, is asked in its tree (revealed for the walk; the discard
  // above was the FORM s walk — the handover owes its own).
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A asked as an orphan: ${asked ? 'elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(a.disposed(), 'discarded: A ends');
  assert.equal(h.app.document.querySelector('.card .fields input[type="text"]'), null, 'the connect card is gone: the app is on C');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)'), 'C s tree in front');
  assert.ok(c.isConnected() && ls.getItem('tmux_server_current') === 'c', 'C untouched');
});

test('P1-B (mirror fails → block): the canonical absorbs the focus and the mirror write then fails — A s pre-captured api refuses at once with zero wire calls, its draft is kept, and Retry completes the handover', async (context) => {
  // reviewer P1-B on 4c7cd64c. The merge note and every write after it are
  // refused: recordServer commits CURRENT=C and the registry, the note
  // fails (reconcile → focusAbsorbed), refocus succeeds, the mirror write
  // (`focusServer`) throws → storageFailed → block. A was dropped from the
  // fleet, so holdStorage freezes nothing of it: it must already refuse.
  const store = refusing(['tmux_server_merges', 'tmux_address']);
  store.state.failing = false;
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, fsWrite: async () => ({}), findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  const aApi = a.api;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  store.state.failing = true;
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.ok(movesOpen(ls), 'the merge could not be finished: blocked');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.equal(ls.getItem('tmux_address'), 'ws://alias:9899', 'the mirror never moved (A s entry address: the alias s)');
  // Blocked. A s captured api: immediate refusal, zero wire calls.
  const mark = events.length;
  await assert.rejects(() => aApi.fsWrite!('/home/notes.md', 'x'), 'a captured write refuses');
  await assert.rejects(() => aApi.fsList!('/home'), 'a captured read refuses');
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'zero wire calls of A s during the block');
  assert.equal(a.isConnected(), false, 'A s socket closed');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'draft kept');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing asked while blocked');
  // Retry: the merge finishes, the handover completes to C, A is asked.
  store.state.failing = false;
  const prefs = h.app.document.querySelector('.preferences');
  if (prefs && !prefs.closest('.page-layer.hidden')) {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
  }
  const retry = retryButton(h.app);
  assert.ok(retry, `Retry offered: ${[...h.app.document.querySelectorAll('button')].map((b: any) => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 16).join('|')}`);
  retry.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(!movesOpen(ls), 'the merge finished');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.ok(conn(h, 'c')!.isConnected(), 'C is up, the focus');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A asked as an orphan after Retry');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind, kept');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)') !== draftA.closest('.scope-tree'), 'C s tree in front');
});

test('P2 (NC shape): C s address-row redial HANGS while B s earlier reconnect answers as another machine — B is not asked until C s addressUp completes', async (context) => {
  // reviewer P2 on 4c7cd64c: an address connect is held by the switch
  // module s count alone (no activation, no candidate). The orphan must wait
  // for its completion — `busy`, not `guarding`.
  let bAnswersAs = 'm-b';
  let bHangs = false, cHangs = false;
  const bLet = { let: null as (() => void) | null };
  const cLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async (addrs: string[]) => addrs[0] ?? null },
    gate: (url) => (url.includes('//b') && bHangs ? new Promise<void>((r) => { bLet.let = r; })
      : url.includes('//a-lan') && cHangs ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  // B s reconnect goes out and hangs.
  bHangs = true; bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 6 && !bLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(bLet.let, 'B s dial is out');
  // A s address row: a second address of m-a, whose dial hangs.
  cHangs = true;
  await toConnection(h);
  for (let i = 0; i < 3; i++) await h.settle();
  const row = h.app.document.querySelector<HTMLButtonElement>('[data-addr-row="ws://a-lan:9899"] .address-choice');
  assert.ok(row, `the LAN address is a row: ${[...h.app.document.querySelectorAll('[data-addr-row]')].map((r: any) => r.dataset.addrRow).join(',')}`);
  row.click();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(cLet.let, 'A s redial is out and hanging');
  // B answers as D: orphaned beneath the hanging redial. Time passes; the
  // redial is NOT released.
  bLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B detached at the boundary');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'B is NOT asked while the address connect is in flight');
  // Release the redial: it completes (addressUp), then B is asked.
  cLet.let!();
  for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.id === 'a').address, 'ws://a-lan:9899', 'A s address moved: the redial completed');
  assert.ok(conn(h, 'a')!.isConnected(), 'A is up on it');
  assert.ok(h.app.document.querySelector('[data-addr-row="ws://a-lan:9899"] .address-choice.active'), 'addressUp ran');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), `then B is asked: ${asked ? 'elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(conn(h, 'a')!.isConnected() && ls.getItem('tmux_server_current') === 'a', 'A untouched');
});

// ─── M1: the F fixture, parameterised by the in-flight operation s EXIT ──
//
// A (alias) is the focus with a draft; C (canonical) is a background member
// whose reconnect to A s address is OUT and hanging. A window operation
// towards N begins; C answers beneath it and absorbs A (CURRENT = C). The
// operation then ends by the named exit WITHOUT binding N. The owed handover
// must complete: CURRENT/mirror/front on C, A kept and refusing, A asked
// once as an orphan, C never ended.
type FExit = 'switch-walk-keep' | 'switch-dial-fail' | 'form-candidate-fail' | 'form-candidate-cancel' | 'form-owned-fail' | 'form-owned-cancel' | 'form-newer-target';
async function fAbsorbUnder(context: TestContext, exit: FExit, seed: Record<string, string> = {}, before?: (h: Awaited<ReturnType<typeof bootApp>>) => void) {
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const n = { let: null as (() => void) | null, fail: null as ((e: Error) => void) | null, dials: 0 };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({ ...canonAndAlias('a'), ...seed }), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : url.includes('//p') ? 'm-p' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => {
      if (url.includes('//alias') && cHangs && !cLet.let) return new Promise<void>((r) => { cLet.let = r; });
      if (url.includes('//n')) {
        n.dials++;
        // Held: the FIRST N dial of each kind (the candidate s, then N s own);
        // a held dial is released or failed by the exit. Later dials (a
        // reconnect loop s) are refused.
        if (n.dials > 2) return Promise.reject(new Error('N down'));
        return new Promise<void>((r, rej) => { n.let = r; n.fail = rej; });
      }
      return null;
    },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  before?.(h);
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const aApi = a.api;
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  const form = exit.startsWith('form');
  const buttons = () => [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')];
  if (form) {
    await toConnection(h);
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
    const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
    field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
    await h.settle();
    buttons().find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  } else {
    await switchByAddress(h, 'ws://n:9899', 'tokN');
  }
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the operation s walk asks A s tree');
  // Where the absorption lands: under the walk, or after D-W under the
  // candidate / owned dial.
  if (exit === 'switch-walk-keep') {
    cLet.let!();
    for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  } else {
    answerDialog(h.app, /^discard$/iu);
    for (let i = 0; i < 6 && !n.let; i++) { await h.app.advance(200); await h.settle(); }
    assert.ok(n.let, `N s ${form ? 'candidate' : 'candidate'} dial is out (${n.dials})`);
    if (exit === 'form-owned-fail' || exit === 'form-owned-cancel') {
      // The candidate answers; N is recorded (CURRENT = N briefly) and N s
      // OWN dial goes out and hangs.
      const first = n.let; n.let = null; first();
      for (let i = 0; i < 6 && !n.let; i++) { await h.app.advance(200); await h.settle(); }
      assert.ok(n.let, 'N s own dial is out');
    }
    cLet.let!();
    for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id).filter((id: string) => id === 'a' || id === 'c'), ['c'], 'the alias was absorbed');
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses at the boundary');
  assert.equal(a.disposed(), false, 'A still bound under the operation');
  assert.ok(c.isConnected(), 'C is up');
  // The EXIT.
  const markN = events.filter((e) => e.startsWith(`rpc@`) && !e.startsWith('rpc@a:') && !e.startsWith('rpc@c:')).length;
  switch (exit) {
    case 'switch-walk-keep': answerDialog(h.app, /keep editing/iu); break;
    case 'switch-dial-fail': case 'form-candidate-fail': case 'form-owned-fail': { const fail = n.fail!; n.let = null; n.fail = null; fail(new Error('N refused')); break; }
    case 'form-candidate-cancel': case 'form-owned-cancel': buttons().find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()))!.click(); break;
    case 'form-newer-target': {
      // A NEWER user operation replaces the pending one while N s candidate
      // still hangs: Add-a-server to P, which answers at once. Its candidate
      // claims the window; N s attempt is nobody s from here.
      await switchByAddress(h, 'ws://p:9899', 'tokP');
      break;
    }
  }
  for (let i = 0; i < 10; i++) { await h.app.advance(300); await h.settle(); }
  return { h, ls, a, c, aApi, draftA, events, markN };
}

const fExits: FExit[] = ['switch-walk-keep', 'switch-dial-fail', 'form-candidate-fail', 'form-candidate-cancel', 'form-owned-fail', 'form-owned-cancel'];
for (const exit of fExits) test(`M1 F (owed handover, exit=${exit}): the operation ends with nothing bound — the handover completes to C once: CURRENT/mirror/front on C, A kept and refusing, A asked once as an orphan, C never ended`, async (context) => {
  const { h, ls, a, c, draftA, aApi } = await fAbsorbUnder(context, exit);
  if (exit === 'switch-dial-fail') {
    // The switch s failed panel is a resting state: the handover completes
    // under it and puts it away, its reason kept as the notice.
    assert.equal(h.app.document.querySelector('.switch-panel'), null, 'the failed panel is put away: the focus is bound by another path');
  }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is the canonical');
  assert.equal(ls.getItem('tmux_address'), 'ws://alias:9899', 'the mirror is C s entry s');
  assert.ok(c.isConnected() && !c.disposed(), 'C is up, never ended');
  assert.equal(a.disposed(), false, 'A is kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft is mounted');
  await assert.rejects(() => aApi.fsList!('/home'), 'A still refuses');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A is asked as an orphan in its tree: ${asked ? 'elsewhere' : 'nothing asked'}`);
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'once');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'and not again: the debt was consumed once');
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)') !== draftA.closest('.scope-tree'), 'C s tree in front');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.equal(trees(h.app).length, 2);
  // The connect card (if the exit was the form s) is gone: the app is on C.
  assert.equal(h.app.document.querySelector('.card .fields input[type="text"]'), null, 'no connect card');
});

/** The handed-to tree adopts the MOVED record whole (reviewer P1-NAV on
 * 7e0f69de; orchestrator 04:17: the full-snapshot rule is the contract): C's
 * pre-merge navigation (its own slot's, superseded by the merge) never
 * survives A's explicit choice — empty or a single pane — and an A with
 * navigation lands it on an empty C. C's old panes name the session `work`,
 * the one the fixture's `list_sessions` answers (reviewer P2 on a036a84a):
 * a pane whose session is gone is dropped by the restore's existence check
 * at JOIN, before the handover, which would make the "cleared" case pass for
 * the wrong reason. `work:9.0` ≠ A's `work:1.0`, so the two are told apart. */
const cPane = (target: string) => ({ kind: 'pane', serverId: 'c', session: 'work', target });
const navCases: Array<[string, string, string, (slot: any) => void, string]> = [
  ['A cleared → stays cleared (C had a pane)',
    JSON.stringify({ v: 2, page: 'files', pane: null, splitLayout: 1, splitCells: [] }),
    JSON.stringify({ v: 2, page: 'files', pane: cPane('work:9.0'), splitLayout: 1, splitCells: [] }),
    (slot) => { assert.equal(slot.pane, null, `C s old pane did not come back: ${JSON.stringify(slot)}`); assert.deepEqual(slot.splitCells, []); }, 'work:9.0'],
  ['A single pane → stays single (C had a 2-cell split)',
    JSON.stringify({ v: 2, page: 'files', pane: { kind: 'pane', serverId: 'a', session: 'work', target: 'work:1.0' }, splitLayout: 1, splitCells: [] }),
    JSON.stringify({ v: 2, page: 'files', pane: cPane('work:9.0'), splitLayout: 2, splitCells: [{ id: 1, pane: cPane('work:9.0') }, { id: 2, pane: cPane('work:8.0') }] }),
    (slot) => { assert.equal(slot.pane?.target, 'work:1.0'); assert.equal(slot.pane?.serverId, 'c', 're-owned'); assert.equal(slot.splitLayout, 1); assert.deepEqual(slot.splitCells, [], 'C s split is gone'); }, 'work:9.0'],
  ['A unset → takes nothing, C stays empty (no invented pane)',
    JSON.stringify({ page: 'files' }),
    JSON.stringify({ page: 'files' }),
    (slot) => { assert.ok(!slot.pane, `no pane: ${JSON.stringify(slot)}`); }, ''],
  ['A with a pane → lands on an empty C (the P1-2 shape)',
    JSON.stringify({ v: 2, page: 'files', pane: { kind: 'pane', serverId: 'a', session: 'work', target: 'work:1.0' }, splitLayout: 1, splitCells: [] }),
    JSON.stringify({ page: 'files' }),
    (slot) => { assert.equal(slot.pane?.target, 'work:1.0'); assert.equal(slot.pane?.serverId, 'c'); }, ''],
];
for (const [name, aNav, cNav, check, cBefore] of navCases) test(`P1-NAV (handover refill): ${name}`, async (context) => {
  // The premise is asserted BEFORE the absorb (reviewer P2-NAV on 18a3bff4):
  // C's held tree really shows its old pane (and split) from its own slot.
  const { h, ls, draftA } = await fAbsorbUnder(context, 'switch-walk-keep', { 'tmux_state::a': aNav, 'tmux_state::c': cNav, tmux_layout_mode: 'desktop' }, (hh) => {
    const held = trees(hh.app).find((x) => x.held);
    assert.ok(held, 'C s tree is mounted, held');
    assert.equal(held.target, cBefore || 'none', `C s old terminal before the absorb: ${held.target}`);
    const cNavParsed = JSON.parse(cNav);
    const cellsBefore = held.el.querySelectorAll('.terminal-body .cell').length;
    assert.equal(cellsBefore, (cNavParsed.splitLayout ?? 1) > 1 ? cNavParsed.splitCells.length : 0, `C s old split before the absorb: ${cellsBefore}`);
  });
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'handed over to C');
  // A's orphan ask (the fixture leaves it open): answer it, so C is the
  // front and A is behind — then read the front.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A is asked as an orphan');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind');
  const slot = JSON.parse(ls.getItem('tmux_state::c') ?? 'null');
  assert.ok(slot, 'C s slot exists');
  check(slot);
  // The FRONT (C's tree) agrees with the slot: its terminal target and the
  // real SplitView cells (`.cell`), not a vacuous selector.
  const front = trees(h.app).find((x) => !x.held);
  assert.ok(front && front.el !== draftA.closest('.scope-tree'), 'C s tree is the front');
  assert.equal(front.target, slot.pane?.target ?? 'none', `the front terminal is the slot s pane: ${front.target}`);
  const cells = front.el.querySelectorAll('.terminal-body .cell').length;
  if (slot.splitLayout === 1) assert.equal(cells, 0, `no split in front: ${cells}`);
  else assert.equal(cells, slot.splitCells.length, 'the split in front is the slot s');
});

for (const exit of ['form-owned-cancel', 'form-owned-fail'] as const) test(`M1 F5 (bound runtime never joined as a member of its own set, exit=${exit}): while the form s connect has moved CURRENT to N and A is still BOUND, the member sync dials and joins nothing of A s — zero dial of the alias from the form connect to the exit`, async (context) => {
  // Aggregate, A (alias) focus and bound, C a member. The form connects to N:
  // the candidate answers (CURRENT = N), N's own dial hangs. A is now bound
  // but not CURRENT — exactly the state in which a sync that forgot `held`
  // would list A as a member and dial it over its live socket (M1 F5). The
  // events log must carry no `dial@a:` after the form connect, and A's
  // connection must be the same one, never replaced. (The validator's bisect
  // on fd6083f6: the guard was unheld since 1125b5f4 because the robust
  // handover masked the harm; this asserts the harm's absence directly.)
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const n = { let: null as (() => void) | null, fail: null as ((e: Error) => void) | null, dials: 0 };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') ? 'm-x' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc },
    gate: (url) => {
      if (url.includes('//alias') && cHangs && !cLet.let) return new Promise<void>((r) => { cLet.let = r; });
      if (url.includes('//n')) {
        n.dials++;
        if (n.dials > 2) return Promise.reject(new Error('N down'));
        return new Promise<void>((r, rej) => { n.let = r; n.fail = rej; });
      }
      return null;
    },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  // (the alias answers as its OWN machine m-x here: no absorb, no handover —
  // the test is about the bound runtime alone)
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!;
  assert.ok(a.isConnected(), 'A bound and up');
  assert.equal(trees(h.app).length, 2, 'A and C');
  // Form connect to N.
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  const mark = events.length;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 6 && !n.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(n.let, 'N s candidate dial is out');
  const first = n.let; n.let = null; first();
  for (let i = 0; i < 6 && !n.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(n.let, 'N s own dial is out');
  const nId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://n:9899')?.id;
  assert.ok(nId && ls.getItem('tmux_server_current') === nId, 'CURRENT is N while A is still bound');
  // Several sync rounds pass (registry change, the 20 s cadence, the window
  // going quiet): A, bound, must not be joined.
  for (let i = 0; i < 12; i++) { await h.app.advance(2000); await h.settle(); }
  // The EXIT.
  if (exit === 'form-owned-cancel') [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()))!.click();
  else { const fail = n.fail!; n.let = null; n.fail = null; fail(new Error('N refused')); }
  for (let i = 0; i < 10; i++) { await h.app.advance(300); await h.settle(); }
  const since = events.slice(mark);
  assert.deepEqual(since.filter((e) => e.startsWith('dial@a:')), [], `no dial of the bound alias from the form connect to the exit: ${since.filter((e) => e.startsWith('dial@')).join(', ')}`);
  // (Disconnect closed A's socket for the form — the connect card's path —
  // so A is bound and OFFLINE here; a join would have been a fresh dial on
  // a new connection object, which is what the two assertions exclude.)
  assert.equal(conn(h, 'a'), a, 'A s connection is the same object: never replaced by a join');
  assert.equal(a.disposed(), false, 'and not disposed');
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the exit put CURRENT back on A');
  assert.equal(trees(h.app).length, 2, 'A and C, as before');
});

test('M1 F5/X2 (newer target): the pending target N is replaced by a NEWER user target P that succeeds — P binds, A ends by the swap as answered, C stays a member, the owed handover is void (never writes C back over P)', async (context) => {
  const { h, ls, a, c, draftA } = await fAbsorbUnder(context, 'form-newer-target');
  const pId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://p:9899')?.id;
  assert.ok(pId && ls.getItem('tmux_server_current') === pId, `P is CURRENT: ${ls.getItem('tmux_server_current')}`);
  assert.ok(h.net.conns().find((x) => x.key === pId)?.isConnected(), 'P is up');
  assert.ok(a.disposed(), 'A ended by the swap (the person discarded its draft for the form)');
  assert.equal(draftA.isConnected, false);
  assert.ok(c.isConnected() && !c.disposed(), 'C is a member of P s set, never ended');
  assert.equal(trees(h.app).length, 2, 'P s tree and C s');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing owed');
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), pId, 'the stale debt never wrote C back');
});

test('M1 F7/X1 (Retry fails again): mirror + note fail → block; Retry fails again (still blocked, the debt is NOT consumed, A still refuses, nothing asked); the next Retry completes the handover', async (context) => {
  const store = refusing(['tmux_server_merges', 'tmux_address']);
  store.state.failing = false;
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) { store.setup(window); window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!;
  const aApi = a.api;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  store.state.failing = true;
  conn(h, 'c')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.ok(movesOpen(ls), 'blocked');
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses');
  const retry = async () => {
    const prefs = h.app.document.querySelector('.preferences');
    if (prefs && !prefs.closest('.page-layer.hidden')) {
      [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
        .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
      for (let i = 0; i < 3; i++) await h.settle();
    }
    const b = retryButton(h.app);
    assert.ok(b, 'Retry offered');
    b.click();
    for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  };
  // Retry while storage still fails: still blocked, nothing consumed.
  await retry();
  assert.ok(movesOpen(ls), 'still blocked');
  const mark = events.length;
  await assert.rejects(() => aApi.fsList!('/home'), 'A still refuses');
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'zero wire calls of A s');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'draft kept');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing asked while blocked');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  // Storage works: Retry completes the merge and the handover, A is asked.
  store.state.failing = false;
  await retry();
  assert.ok(!movesOpen(ls), 'the merge finished');
  assert.ok(conn(h, 'c')!.isConnected(), 'C up, the focus');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A asked once, after');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 0, 'once');
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind, kept');
});

test('M1 F6 (membership op): the canonical absorbs the focus while the mode change s walk asks C s tree — the op s commit is refused (registry changed, nothing written or left), the owed handover completes to C, A asked once; a fresh op then commits', async (context) => {
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  // C s tree gets a draft too: Aggregate → Single asks C s tree (the member).
  await pickServer(h, 'canon');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftC = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alias');
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  await toConnection(h);
  modeButton(h, /one server|single/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftC.closest('.scope-tree'), 'the mode change asks C s tree (the member)');
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'A absorbed beneath the walk');
  // C s answer is C s own reconnect landing: its Files page refreshes, which
  // ends its open leave question as a stay. The mode change s walk is over
  // with no answer from the person — its commit is refused anyway (the
  // registry changed since it was asked): nothing written, nothing left.
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'the stale op wrote nothing');
  assert.ok(c.isConnected() && !c.disposed(), 'C was not left (the op s leave never ran)');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s draft intact');
  // The window free again, the owed handover completed: C is the focus; A
  // is an orphan, asked in its own tree, once.
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  assert.equal(a.disposed(), false, 'A kept, refusing');
  await assert.rejects(() => a.api.fsList!('/home'));
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A asked as an orphan: ${asked ? 'elsewhere' : 'nothing asked'}`);
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'one question');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'once');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A kept');
  assert.ok(!draftC.closest('.scope-tree.held'), 'C s tree in front');
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind');
  // A fresh mode change now asks C s tree and commits: the stale op left no
  // half-state behind.
  await toConnection(h);
  modeButton(h, /one server|single/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'Aggregate → Single asks the member tree (the orphan A s)');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(ls.getItem('tmux_connection_mode'), 'single', 'committed');
  assert.ok(a.disposed(), 'A let go');
  assert.ok(c.isConnected() && ls.getItem('tmux_server_current') === 'c', 'C the one server');
});

test('M1 F3 (constraint): an alias focus has no address rows to redial — its machine is unknown until a dial proves it, and a focus whose machine IS known never coexists with a twin to be absorbed into (repairServers merges them at boot)', async (context) => {
  // F × address redial cannot be reached through the UI: the F shape needs
  // the focus to be an ALIAS (machine unknown) of a saved canonical, and the
  // Connection page lists addresses only for a known machine. The moment a
  // dial proves the alias s machine, recordServer absorbs it (F0/F1…), so
  // there is never a focus with rows AND a canonical twin. Pinned here so
  // the gap is a constraint, not an omission.
  let aliasProves = false;
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a', 'the alias is the focus');
  // Even with the canonical s failover set naming the alias address, the
  // alias entry itself knows no machine: the Connection page reads the
  // FOCUS s machine, which is none.
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  assert.ok(conn(h, 'c')?.isConnected(), 'the canonical is a member');
  await toConnection(h);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.deepEqual([...h.app.document.querySelectorAll<HTMLElement>('[data-addr-row]')].map((r) => r.dataset.addrRow), ['ws://alias:9899'],
    'the alias focus shows only its active address: no row to redial');
});

test('M1 F3 (constraint, other half): two saved entries of ONE known machine never boot as two — the registry repair folds them, the focus surviving', async (context) => {
  const twins = { ...canonAndAlias('a'), tmux_servers: JSON.stringify([
    { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', machineId: 'm-a', named: true },
  ]) };
  const h = await bootApp(context, aggregateOn(twins), () => 'm-a', { rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  assert.deepEqual(JSON.parse(h.app.window.localStorage.getItem('tmux_servers')!).map((e: any) => e.id), ['a'], 'one entry: the focus survived, the twin was folded at boot');
  assert.equal(trees(h.app).length, 1, 'one tree');
});

test('M1 B3b (failure exit): C s address redial HANGS while B loses identity; the redial then FAILS — the window frees, the loop restarts, and B is asked once', async (context) => {
  let bAnswersAs = 'm-b';
  let bHangs = false, cHangs = false;
  const bLet = { let: null as (() => void) | null };
  const cFail = { fail: null as ((e: Error) => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899', 'ws://a-lan:9899'] }),
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : 'm-a'), {
    rpc: { ...editorRpc, findBestAddress: async (addrs: string[]) => addrs[0] ?? null },
    gate: (url) => (url.includes('//b') && bHangs ? new Promise<void>((r) => { bLet.let = r; })
      : url.includes('//a-lan') && cHangs ? new Promise<void>((_r, rej) => { cFail.fail = rej; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  bHangs = true; bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 6 && !bLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(bLet.let, 'B s dial is out');
  cHangs = true;
  await toConnection(h);
  for (let i = 0; i < 3; i++) await h.settle();
  h.app.document.querySelector<HTMLButtonElement>('[data-addr-row="ws://a-lan:9899"] .address-choice')!.click();
  for (let i = 0; i < 6 && !cFail.fail; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(cFail.fail, 'A s redial is out');
  bLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B detached');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'B not asked under the hanging redial');
  // The redial FAILS: the window frees; A s loop restarts (it dials A back).
  cHangs = false;
  cFail.fail!(new Error('lan down'));
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.id === 'a').address, 'ws://a:9899', 'A s address did not move');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), `B asked once the redial concluded: ${asked ? 'elsewhere' : 'nothing asked'}`);
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'once');
  assert.ok(conn(h, 'a')!.isConnected(), 'A is back up on its own address');
  assert.equal(ls.getItem('tmux_server_current'), 'a');
});

test('M1 X4 (two orphans): B and E lose identity together — asked one at a time, in each s own tree; Keep on the first does not re-ask it, Discard on the second ends only the second; the list keeps the kept one with Dismiss', async (context) => {
  let bAs = 'm-b', eAs = 'm-e';
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'e', name: 'echo', address: 'ws://e:9899', token: 'tokE', machineId: 'm-e', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), 'tmux_state::e': JSON.stringify({ page: 'files' }), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAs : url.includes('//e') ? eAs : url.includes('//d') ? 'm-d' : 'm-a'), {
    rpc: editorRpc, setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'echo');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftE = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  // Both reach D on their reconnects.
  bAs = 'm-d'; eAs = 'm-d';
  conn(h, 'b')!.drop(); conn(h, 'e')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false); assert.equal(conn(h, 'e')!.isConnected(), false);
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'one question at a time');
  const first = h.app.document.querySelector('[role=alertdialog]')!.closest('.scope-tree');
  const firstIsB = first === draftB.closest('.scope-tree');
  assert.ok(firstIsB || first === draftE.closest('.scope-tree'), 'asked in an orphan s tree');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'then the other');
  const second = h.app.document.querySelector('[role=alertdialog]')!.closest('.scope-tree');
  assert.ok(second !== first && (second === draftB.closest('.scope-tree') || second === draftE.closest('.scope-tree')), 'the OTHER orphan, not the kept one again');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'no third question: the kept one is not re-asked');
  const kept = firstIsB ? draftB : draftE, gone = firstIsB ? draftE : draftB;
  assert.equal(kept.isConnected && kept.value, '# notes\n\nunsaved', 'the kept draft is mounted');
  assert.equal(gone.isConnected, false, 'the discarded tree is gone');
  assert.ok(conn(h, firstIsB ? 'e' : 'b')!.disposed(), 'and its runtime ended');
  assert.equal(conn(h, firstIsB ? 'b' : 'e')!.disposed(), false, 'the kept one not');
  await toConnection(h);
  assert.equal(h.app.document.querySelectorAll('.preferences button[aria-label^="Dismiss"]').length, 1, 'one orphan listed with Dismiss');
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'the kept orphan is never re-asked on its own');
});

test('M1 X5 (lifecycle): the App is destroyed while an orphan s ask is scheduled and a handover is owed — nothing drains, nothing is asked, no RPC goes out after the end', async (context) => {
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'the walk asks A');
  cLet.let!();
  // The absorption lands synchronously; the owed handover is pending behind
  // the walk. Destroy the App now, before any turn drains it.
  await h.app.flush();
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'absorbed');
  await h.app.unmount();
  const mark = events.length;
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@') || e.startsWith('dial@')), [], 'nothing dialled or called after the end');
  assert.ok(a.disposed() && c.disposed(), 'every runtime ended with the shell');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing asked');
  assert.equal(draftA.isConnected, false, 'the tree went with the shell');
});

test('M1 F4/F5 (Single, nobody to hand to): the form s candidate absorbs the focus alias into C, then the owned handshake is CANCELLED — no member to hand to: the owed handover activates CURRENT through the one road, asking A s tree first; Discard → C up, A ends', async (context) => {
  // X3: no connected member named by CURRENT (Single has none). The debt is
  // still owed and settles by the one defined path — Retry s own road
  // (`arriveOn`): ask the kept tree s guards, then bind through the swap.
  let aliasProves = false;
  let aliasDials = 0;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const h = await bootApp(context, { ...canonAndAlias('a'), tmux_connection_mode: 'single' }, (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: editorRpc,
    // Alias dials: 1 the boot, 2 the form s candidate, 3 C s own — held;
    // later ones (the owed arrival s) answer.
    gate: (url) => (url.includes('//alias') && ++aliasDials === 3 ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!;
  const aApi = a.api;
  const draftA = await dirtyEditor(h.app, h.settle);
  aliasProves = true;
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://alias:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  // The form s own walk: keep editing would stay; this case needs the dial.
  // Discard here is the FORM s answer (D-W); the owed handover asks again.
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'the form asks A s tree before dialling');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 8 && !cLet.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(cLet.let, 'C s own (owned) dial is out');
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the candidate s record absorbed A');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses at the boundary');
  assert.equal(a.disposed(), false, 'A still bound under the form');
  // Cancel the owned handshake: nothing bound, no member to hand to.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((x) => /^cancel$/iu.test((x.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(300); await h.settle(); }
  // The owed handover: CURRENT (C) is activated through the one road, which
  // asks A s kept tree first — the person is asked again, in A s tree.
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT stays the canonical');
  assert.equal(a.disposed(), false, 'A kept until asked');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `the arrival asks A s tree: ${asked ? 'elsewhere' : 'nothing asked'}`);
  assert.equal(conn(h, 'c')?.isConnected() ?? false, false, 'nothing dialled past the question');
  answerDialog(h.app, /^discard$/iu);
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(conn(h, 'c')?.isConnected(), 'C came up on its own runtime');
  assert.ok(a.disposed(), 'A ended by the swap');
  assert.equal(draftA.isConnected, false);
  assert.equal(h.app.document.querySelector('.card .fields input[type="text"]'), null, 'the app is on C');
  assert.equal(trees(h.app).length, 1);
});

// ─── reviewer P1-1 / P1-2 / P1-3 on 9c1f757c ────────────────────────────

test('P1-1 (own dial, arrival refused): the focus alias s OWN reconnect — out, hanging — proves the canonical s machine while the form s walk asks its tree; the arrival is refused by the open guard; Keep editing on the form: the OWED handover still completes to C', async (context) => {
  // The absorber is A s own handshake (server-runtime detaches A itself);
  // the arrival (`arrivedElsewhere` → `askToReplace`) finds a guard open and
  // returns null, concluding nothing. The debt must not have been skipped on
  // the strength of "A is already detached". Shape: A s loop gave up, the
  // connect card is up (A s tree bound and kept); coming back starts a loop
  // whose dial hangs; the form connects to N, its walk asks A s draft.
  let aliasProves = false;
  let aHangs = false;
  const aLet = { let: null as (() => void) | null };
  const events: string[] = [];
  let failing = false;
  let aliasDials = 0;
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: editorRpc,
    gate: (url) => {
      if (url.includes('//n')) return new Promise<void>(() => {});
      if (!url.includes('//alias') || ++aliasDials <= 1) return null;
      if (failing) return Promise.reject(new Error('refused'));
      if (aHangs && !aLet.let) return new Promise<void>((r) => { aLet.let = r; });
      return null;
    },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const aApi = a.api;
  const draftA = await dirtyEditor(h.app, h.settle);
  failing = true;
  a.drop();
  for (let i = 0; i < 30; i++) { await h.app.advance(5_000); await h.settle(); }
  assert.ok(h.app.document.querySelector('.card .fields input[type="text"]'), 'A s loop gave up: the connect card is up');
  assert.ok(c.isConnected(), 'C, a member, is untouched');
  failing = false; aHangs = true; aliasProves = true;
  h.app.document.dispatchEvent(new h.app.window.Event('visibilitychange'));   // A s loop starts again; its dial hangs
  for (let i = 0; i < 8 && !aLet.let; i++) { await h.app.advance(500); await h.settle(); }
  assert.ok(aLet.let, 'A s own reconnect dial is out');
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the form s walk asks A s tree');
  // A s own dial answers as m-a: recordServer absorbs A into C. A is
  // detached by its own dial; the arrival is refused by the open guard.
  aLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], `A s own handshake absorbed A: ${ls.getItem('tmux_servers')}`);
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses');
  assert.equal(a.disposed(), false, 'A bound still');
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'no overlapping question');
  // Keep editing: the form dials nothing. The owed handover completes.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 8; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(events.filter((e) => e === 'connect:ws://n:9899' || e === 'candidate:ws://n:9899').length, 0, 'N never dialled');
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'CURRENT is C');
  assert.ok(c.isConnected() && !c.disposed(), 'C up, never ended');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft mounted');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A asked as an orphan: ${asked ? 'elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) { await h.app.advance(10); await h.settle(); }
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)') !== draftA.closest('.scope-tree'), 'C s tree in front');
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind, kept');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'once');
  assert.equal(h.app.document.querySelector('.card .fields input[type="text"]'), null, 'the app is on C: no connect card');
});

test('P1-2 (publish gate): the canonical absorbs the focus alias whose v2 navigation must be rebound for the survivor — the merge-nav rewrite FAILS: the app blocks, C is NOT shown as the front, A refuses and is kept; Retry rebinds, then hands over', async (context) => {
  // The handover s publish passes the same storage gate as every bind
  // (`foldCurrent`: attribution + `followMerges`). Here the registry, the
  // slot move and the note all succeed; only the survivor s rewritten
  // navigation write fails.
  // The survivor s navigation slot refuses writes only AFTER the merge has
  // committed (the slot move is a write to the same key, and must land): the
  // write that then fails is the publish gate s rewrite of the alias s v2
  // refs onto the survivor (`followMerges` → `reownSavedNav`).
  const state = { failing: false };
  let aliasProves = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...canonAndAlias('a'),
    'tmux_state::a': JSON.stringify({ v: 2, page: 'files', pane: { kind: 'pane', serverId: 'a', session: 'work', target: 'work:1.0' } }),
  }), (url) => (url.includes('//alias') && !aliasProves ? '' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    setup(window) {
      const set = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (state.failing && k === 'tmux_state::c' && (this.getItem('tmux_slot_moves') ?? '[]') === '[]' && !this.getItem('tmux_servers')?.includes('"id":"a"')) throw new Error('QuotaExceededError');
        return set.call(this, k, v);
      };
      window.Element.prototype.getAnimations = () => [];
    },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const draftA = await dirtyEditor(h.app, h.settle);
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  const aApi = a.api;
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  state.failing = true;                       // C s navigation slot refuses writes once the merge is committed
  c.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['c'], 'the alias was absorbed');
  assert.ok(!movesOpen(ls), 'the merge itself finished');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  // The publish gate failed: blocked. A refuses; C is not the front.
  const mark = events.length;
  await assert.rejects(() => aApi.fsList!('/home'), 'A refuses');
  assert.deepEqual(events.slice(mark).filter((e) => e.startsWith('rpc@a:')), [], 'zero wire calls of A s');
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft kept');
  assert.ok(h.app.document.querySelector('.switch-panel, .connect-layer'), 'blocked: the Retry surface is up');
  const front = h.app.document.querySelector('.scope-tree:not(.held)');
  assert.equal(front, null, 'no tree is shown as the front while blocked: C was not published past the failed gate');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing asked');
  assert.ok(c.isConnected(), 'C itself is up, a member');
  // Retry: the gate passes, the handover completes, A is asked.
  state.failing = false;
  const prefs = h.app.document.querySelector('.preferences');
  if (prefs && !prefs.closest('.page-layer.hidden')) {
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button, .gear-btn, .rail-btn')]
      .find((b) => /settings/iu.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
  }
  const retry = retryButton(h.app);
  assert.ok(retry, 'Retry offered');
  retry.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A asked as an orphan after Retry');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) { await h.app.advance(10); await h.settle(); }
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)') !== draftA.closest('.scope-tree'), 'C s tree is the front');
  assert.ok(draftA.closest('.scope-tree.held'), 'A behind, kept');
  // The survivor's slot, PARSED (reviewer P2 on 1125b5f4: a stringified
  // string hides the refs): the pane A's slot carried now names C and is
  // the handed-to tree's, and no ref — pane or cell — still names the
  // alias. A positive ref, so an empty record cannot pass as "rebound".
  const slotC = JSON.parse(ls.getItem('tmux_state::c') ?? 'null');
  assert.equal(slotC?.pane?.serverId, 'c', `the moved pane names the canonical: ${ls.getItem('tmux_state::c')}`);
  assert.equal(slotC?.pane?.target, 'work:1.0', 'and is the pane A s slot carried');
  const refsC = [slotC?.pane, ...((slotC?.splitCells ?? []) as Array<{ pane?: { serverId?: string } }>).map((cell) => cell.pane)].filter(Boolean) as Array<{ serverId?: string }>;
  assert.ok(refsC.length >= 1 && refsC.every((r) => r.serverId === 'c'), `every ref in the survivor s slot names the canonical: ${JSON.stringify(refsC)}`);
});

for (const phase of ['timer-pending', 'drain-saw-busy', 'release-after-end'] as const) test(`P1-3 (lifecycle, ${phase}): the App ends with a handover owed and an orphan ask pending — nothing is minted, dialled, asked or called afterwards`, async (context) => {
  // Three phases of the queue at the end: the drain s timer still pending;
  // the drain already ran and saw the window busy (no timer, debt kept); a
  // window lease released only AFTER the end — the owned activation s
  // `done.finally(release)`, which settles when the teardown disposes the
  // hanging dial s connection, after `onDestroy` has run.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  let holdC = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    // N: the candidate answers at once; N s OWN dial (the second) hangs.
    // release-after-end: C s reconnect (held, released below) and then C s
    // owned dial at the alias address (held for good) — the candidate s own
    // dial is not a runtime dial and is not gated.
    // release-after-end: every RUNTIME dial at the alias address once `holdC`
    // is set (the switch s owned dial of C) hangs for good; the switch s
    // candidate (n = 0) answers.
    gate: (url, n) => (url.includes('//alias') && n > 0 && holdC ? new Promise<void>(() => {})
      : url.includes('//alias') && n > 0 && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; })
      : url.includes('//n') ? new Promise<void>(() => {}) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true;
  if (phase !== 'release-after-end') {
    cHangs = true;
    c.drop();
    for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  }
  if (phase === 'release-after-end') {
    // The form connects to the ALIAS ADDRESS: its candidate proves m-a, the
    // record folds the alias into C (A absorbed, CURRENT = C — the survivor
    // the debt names) and C s OWN dial, the owned second handshake, hangs
    // inside the form s activation: a lease nothing cancels in the teardown;
    // it settles only when the teardown disposes C s connection — AFTER
    // `onDestroy` ran. (`cHangs` is already set: C s reconnect to the alias
    // address is the held dial; the owned dial is the next one, held too.)
    // The connect form with the ALIAS ADDRESS: its candidate proves m-a, the
    // record folds the alias into C (A absorbed, CURRENT = C — the survivor
    // the debt names; same entry, so no switch) and C s OWN dial, the form s
    // owned second handshake, hangs: a lease nothing cancels in the teardown
    // (the form s own teardown cancels the chain, but the lease is the
    // activation s and releases only when its dial SETTLES — which the
    // teardown s dispose of C s connection does, after `onDestroy`).
    holdC = true;
    await toConnection(h);
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
    const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
    field.value = 'ws://alias:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
    await h.settle();
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 4; i++) await h.settle();
    if (h.app.document.querySelector('[role=alertdialog]')) answerDialog(h.app, /^discard$/iu);
    for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
    assert.ok(events.includes('candidate:ws://alias:9899'), 'the candidate dialled the alias address');
    assert.ok(events.filter((e) => e.startsWith('dial@c:ws://alias')).length >= 1, `C s owned dial is out and hanging under the form: ${events.filter((e) => /^(dial|candidate)/u.test(e)).slice(-4).join(' ')}`);
  } else {
    await toConnection(h);
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 3; i++) await h.settle();
    const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
    field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
    await h.settle();
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 4; i++) await h.settle();
    answerDialog(h.app, /^discard$/iu);
    for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
    assert.ok(events.includes('candidate:ws://n:9899'), 'the candidate dial is out and hanging');
  }
  // C absorbs A beneath it: debt owed, window busy.
  if (phase === 'release-after-end') {
    for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
    assert.equal(ls.getItem('tmux_server_current'), 'c', 'absorbed into the survivor the debt names');
  } else {
    cLet.let!();
    if (phase === 'timer-pending') {
      await h.app.flush();
    } else {
      for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
      assert.equal(ls.getItem('tmux_server_current'), 'c', 'absorbed');
      for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
    }
  }
  assert.ok(!JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'a'), 'absorbed');
  assert.equal(a.disposed(), false, 'A still bound under the operation');
  // THE END. The teardown disposes the hanging dial s connection, whose
  // activation then settles and releases its lease — after onDestroy.
  await h.app.unmount();
  const mark = events.length;
  const conns = h.net.conns().length;
  const cur = ls.getItem('tmux_server_current');
  for (let i = 0; i < 8; i++) { await h.app.advance(1000); await h.settle(); }
  assert.deepEqual(events.slice(mark).filter((e) => /^(rpc@|dial@|candidate:|connect:)/u.test(e)), [], `nothing dialled or called after the end: ${events.slice(mark).join(',')}`);
  assert.equal(h.net.conns().length, conns, 'no new connection minted');
  assert.ok(a.disposed() && c.disposed(), 'every runtime ended with the shell');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing asked');
  assert.equal(ls.getItem('tmux_server_current'), cur, 'no identity write after the end');
});

test('X2 (another member bound): a legitimate focus move onto another member while the handover is owed VOIDS the debt — nothing hands over to C afterwards, nothing is activated', async (context) => {
  // Named for what it proves (reviewer P2 on 1125b5f4): the pick binds B,
  // so the debt is voided by the `bound() !== leaving` branch. The separate
  // CURRENT-only branch (`currentServerId() !== to` with the leaving tree
  // still bound) has no App path that reaches it with the window free — every
  // operation that moves CURRENT without binding holds a lease until it binds
  // or restores CURRENT — so it is pinned at the source, not claimed here.
  // Three servers: A alias focus, C canonical member, B another member. C
  // absorbs A beneath a switch walk; the person answers Keep editing — but
  // before the drain, picks B in the list (a legitimate window op moving
  // CURRENT). The debt is void: B is the focus; C stays a member; A is an
  // orphan, asked once.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const servers = [
    { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
  ];
  const h = await bootApp(context, aggregateOn({ ...canonAndAlias('a'), tmux_servers: JSON.stringify(servers), 'tmux_state::b': JSON.stringify({ page: 'files' }) }), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//b') ? 'm-b' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!, b = conn(h, 'b')!;
  assert.ok(b.isConnected(), 'B is a member');
  const draftA = await dirtyEditor(h.app, h.settle);
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]'), 'the switch s walk asks A');
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'c', 'absorbed; debt owed under the walk');
  // Keep editing, and IN THE SAME TURN pick B (before the drain s timer).
  answerDialog(h.app, /keep editing/iu);
  await h.app.flush();
  await pickServer(h, 'beta');
  for (let i = 0; i < 8; i++) { await h.app.advance(50); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'B is the focus: the legitimate move stands');
  assert.ok(c.isConnected() && !c.disposed(), 'C stays a member');
  assert.ok(b.isConnected(), 'B up');
  assert.equal(a.disposed(), false, 'A kept');
  const dialsBefore = events.filter((e) => e.startsWith('dial@')).length;
  for (let i = 0; i < 6; i++) { await h.app.advance(1000); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the debt never wrote C back, nothing was activated');
  assert.equal(events.filter((e) => e.startsWith('dial@')).length, dialsBefore, `no dial after the move settled (an activation would dial): ${events.slice(-5).join(', ')}`);
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), `A asked as an orphan: ${asked ? 'elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved');
  assert.equal(trees(h.app).length, 3, 'B s, C s and A s trees');
});

test('X3 (orphan canonical, P2 gap): C absorbs the focus A beneath a switch walk, then C s OWN reconnect reaches another known machine D — C is an orphan; the owed handover does not hand over to it: both trees kept, A refuses, C asked as an orphan; the survivor is activated through the one road', async (context) => {
  // The journal still names saved C; `handOverFocus` must not treat an
  // orphan C as the member to hand to (its api refuses, its tree is kept for
  // the person). Nobody to hand to → the one road, which dials C s entry.
  let aliasProves = false;
  let cHangs = false;
  let cAnswersAs = 'm-a';
  const cLet = { let: null as (() => void) | null };
  const events: string[] = [];
  const servers = [
    { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 'tok', machineId: 'm-a', named: true },
    { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 'tok', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({ ...canonAndAlias('a'), tmux_servers: JSON.stringify(servers) }, ['d']), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//d') ? 'm-d' : url.includes('//n') ? 'm-n' : cAnswersAs), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async (addrs: string[]) => (addrs.includes('ws://alias:9899') && !cLet.let ? 'ws://alias:9899' : addrs[0] ?? null) },
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; }) : url.includes('//n') ? new Promise<void>(() => {}) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!;
  let c = conn(h, 'c')!;
  const draftA = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'canon');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftC = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alias');
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial (to the alias address) is out');
  await switchByAddress(h, 'ws://n:9899', 'tokN');
  for (let i = 0; i < 3; i++) await h.settle();
  assert.ok(h.app.document.querySelector('[role=alertdialog]')?.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the switch s walk asks A');
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.ok(!JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'a'), 'A absorbed; handover owed beneath the walk');
  assert.ok(c.isConnected(), 'C up on the alias address');
  // Now C drops and its reconnect reaches D: C is an orphan (still saved).
  cAnswersAs = 'm-d';
  c = conn(h, 'c')!;
  c.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(3000); await h.settle(); }
  assert.ok(JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'c'), 'C s entry is still saved (elsewhere: both kept)');
  // C's socket is down here; whether the fleet has ORPHANED it yet is not
  // claimed (reviewer P2 on 1125b5f4: the reconnector waits for the switch
  // to be idle, so a drop alone is not "elsewhere"). What the test proves
  // is the outcome below — the debt does not hand over to C, and C is asked
  // as an orphan when the walk ends.
  assert.equal(c.isConnected(), false, 'C s socket is down');
  // Keep editing ends the switch; the debt settles — NOT to orphan C.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 8; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s draft kept too (an orphan s tree)');
  await assert.rejects(() => a.api.fsList!('/home'), 'A refuses');
  await assert.rejects(() => c.api.fsList!('/home'), 'orphan C refuses: it was not handed the focus');
  // Orphan C was NOT handed the focus: its tree is not the front, and it is
  // still an orphan of the set (a handover would have taken it out as the
  // focus: no Dismiss row, its tree in front with no socket).
  assert.ok(draftC.closest('.scope-tree.held'), 'C s orphan tree is not the front');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held)') === draftA.closest('.scope-tree') || h.app.document.querySelector('.scope-tree:not(.held)') === null, 'the front is A s kept tree (or nothing, mid-swap), never orphan C s');
  // The one road activates C s ENTRY on a fresh runtime, asking A s tree first.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the arrival asks A s tree (the bound one)');
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'one at a time');
  assert.equal(ls.getItem('tmux_server_current'), 'c');
  // Answer the arrival s question: Keep editing — A stays bound, offline;
  // the orphan C is still an orphan, listed with Dismiss.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(a.disposed(), false, 'A kept');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s draft kept');
  // Keep editing on an arrival is a stay: A offline, the connect card up.
  // Then C the orphan gets ITS ask, in its own tree (revealed for the walk).
  const askedC = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(askedC && askedC.closest('.scope-tree') === draftC.closest('.scope-tree'), 'C, the orphan, is asked in its tree');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'both answered');
  assert.ok(draftC.closest('.scope-tree.held'), 'C s tree behind again: never handed the focus');
  assert.equal(c.isConnected(), false, 'and C is still detached');
  assert.equal(draftC.isConnected && draftC.value, '# notes\n\nunsaved', 'C s draft kept');
});

test('P1-A (beneath an activation): the canonical absorbs the focus WHILE the form s second handshake to N is out — no handover; A refuses and stays bound under the form; N binds and replaces A; C stays a member', async (context) => {
  // A alias focus (clean), C canonical member. The person connects the form
  // to N: the candidate answers, N s own runtime dials and hangs. C s
  // reconnect — out before, hanging too — then answers at A s address and
  // absorbs A. A handover to C here would bind C beneath the form s
  // activation, whose swap would then END C, a member, on binding N.
  let aliasProves = false;
  let cHangs = false;
  const cLet = { let: null as (() => void) | null };
  const nLet = { let: null as (() => void) | null };
  let nDials = 0;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn(canonAndAlias('a')), (url) => (url.includes('//alias') && !aliasProves ? '' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: { ...editorRpc, findBestAddress: async () => 'ws://alias:9899' },
    // Held: C s one dial at the alias address (the first alias dial once
    // `cHangs`; A s own rejoin as a member under the switch dials it too, and
    // answers), and N s second dial (its own runtime s; the first is the candidate).
    gate: (url) => (url.includes('//alias') && cHangs && !cLet.let ? new Promise<void>((r) => { cLet.let = r; })
      : url.includes('//n') && ++nDials === 2 ? new Promise<void>((r) => { nLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!, c = conn(h, 'c')!;
  // C s reconnect goes out to the alias address and hangs.
  ls.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://canonical:9899', 'ws://alias:9899'] }));
  aliasProves = true; cHangs = true;
  c.drop();
  for (let i = 0; i < 6 && !cLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(cLet.let, 'C s dial is out');
  // The form: disconnect A, connect to N; N s own (second) dial hangs.
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 8 && !nLet.let; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(nLet.let, 'N s own dial is out');
  const nId = JSON.parse(ls.getItem('tmux_servers')!).find((e: any) => e.address === 'ws://n:9899')?.id;
  assert.ok(nId && ls.getItem('tmux_server_current') === nId, 'CURRENT names N');
  // C answers: A is absorbed beneath the form s activation.
  cLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(300); await h.settle(); }
  assert.ok(!JSON.parse(ls.getItem('tmux_servers')!).some((e: any) => e.id === 'a'), 'the alias was absorbed');
  assert.equal(ls.getItem('tmux_server_current'), nId, 'CURRENT still names N: no handover moved it');
  assert.ok(c.isConnected(), 'C is up');
  await assert.rejects(() => a.api.fsList!('/home'), 'A refuses');
  assert.equal(a.disposed(), false, 'A still bound, under the form');
  assert.ok(h.app.document.querySelector('.card .fields input[type="text"]'), 'the form is still at it');
  // N answers: the form s activation binds N; the swap ends A; C a member.
  nLet.let!();
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  const n = h.net.conns().find((x) => x.key === nId);
  assert.ok(n?.isConnected(), 'N is up');
  assert.ok(a.disposed(), 'the swap ended A');
  assert.ok(c.isConnected() && !c.disposed(), 'C, a member, was never bound and never ended');
  assert.equal(trees(h.app).length, 2, 'N s tree and C s');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nothing to ask: A was clean');
});

test('P2: B is orphaned while an ORDINARY walk is pending — its reconnect, out before the mode change asked E s tree, answers as another machine mid-walk; Keep editing ends the walk, and B is asked next with no other event', async (context) => {
  // No switch, no block: the mode change s walk is the only thing holding the
  // window. B s dial was already out when the walk began (a dial never
  // STARTS over a walk — `serverSwitch.idle()` — but one out already answers
  // when it answers), so B is orphaned while the walk asks; the drain must
  // follow the walk s end, after the operation has concluded.
  let bAnswersAs = 'm-b';
  let bHangs = false;
  const bLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'e', name: 'echo', address: 'ws://e:9899', token: 'tokE', machineId: 'm-e', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), 'tmux_state::e': JSON.stringify({ page: 'files' }), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : url.includes('//e') ? 'm-e' : 'm-a'), {
    rpc: editorRpc, gate: (url) => (url.includes('//b') && bHangs ? new Promise<void>((r) => { bLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'echo');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftE = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  // B drops; its reconnect dial goes out and hangs.
  bHangs = true; bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 6 && !bLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(bLet.let, 'B s dial is out');
  // Aggregate → Single asks every member s tree, E (first in saved order) first.
  await toConnection(h);
  modeButton(h, /one server|single/iu)!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const first = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(first && first.closest('.scope-tree') === draftE.closest('.scope-tree'), 'the mode change asks E s tree');
  // B s dial answers as D mid-walk: B is orphaned while the walk is pending.
  bLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B detached at the boundary');
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'no second question over the walk');
  assert.ok(h.app.document.querySelector('[role=alertdialog]')!.closest('.scope-tree') === draftE.closest('.scope-tree'), 'E s question still stands');
  // Keep editing: the mode change is refused and concludes; nothing else
  // happens — no event, no socket, no Retry: only the clock moves.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(ls.getItem('tmux_connection_mode'), 'aggregate', 'the mode did not change');
  assert.equal(draftE.isConnected && draftE.value, '# notes\n\nunsaved', 'E kept');
  // The queue drained on the walk s end: B (orphan) is asked now, in its tree.
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), `the orphan is asked next, with no other event: ${asked ? 'asked elsewhere' : 'nothing asked'}`);
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved');
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(draftE.isConnected && draftE.value, '# notes\n\nunsaved', 'E untouched throughout');
});

test('P2(b): B is orphaned while the connect FORM s walk asks A — its dial, out before, answers mid-walk; Keep editing ends the walk with nothing else to follow (no candidate, no activation, no membership op), and B is asked next', async (context) => {
  // The one walk whose caller schedules nothing of its own: the form s
  // confirmLeave. A "stay" leaves the form where it was, and the only wake
  // for the queue is the window going quiet.
  let bAnswersAs = 'm-b';
  let bHangs = false;
  const bLet = { let: null as (() => void) | null };
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
  }, ['d']), (url) => (url.includes('//b') ? bAnswersAs : url.includes('//d') ? 'm-d' : url.includes('//n') ? 'm-n' : 'm-a'), {
    calls: events, rpc: editorRpc, gate: (url) => (url.includes('//b') && bHangs ? new Promise<void>((r) => { bLet.let = r; }) : null),
    setup(window) { window.Element.prototype.getAnimations = () => []; },
  });
  for (let i = 0; i < 4; i++) await h.settle();
  await pickServer(h, 'beta');
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const draftB = await dirtyEditor(h.app, h.settle);
  await pickServer(h, 'alpha');
  const draftA = await dirtyEditor(h.app, h.settle);
  bHangs = true; bAnswersAs = 'm-d';
  conn(h, 'b')!.drop();
  for (let i = 0; i < 6 && !bLet.let; i++) { await h.app.advance(1000); await h.settle(); }
  assert.ok(bLet.let, 'B s dial is out');
  await toConnection(h);
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /^disconnect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  const field = h.app.document.querySelector<HTMLInputElement>('.card .fields input[type="text"]')!;
  field.value = 'ws://n:9899'; field.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.card button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  const first = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(first && first.closest('.scope-tree') === draftA.closest('.scope-tree'), 'the form asks A s tree before dialling');
  bLet.let!();
  for (let i = 0; i < 4; i++) { await h.app.advance(200); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B detached at the boundary');
  assert.equal(h.app.document.querySelectorAll('[role=alertdialog]').length, 1, 'no second question over the form s walk');
  assert.ok(h.app.document.querySelector('[role=alertdialog]')!.closest('.scope-tree') === draftA.closest('.scope-tree'), 'A s question still stands');
  // Keep editing: a stay — the form dials nothing, nothing else happens.
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 6; i++) { await h.app.advance(10); await h.settle(); }
  assert.equal(events.filter((e) => e === 'connect:ws://n:9899').length, 0, 'the form dialled nothing');
  const asked = h.app.document.querySelector('[role=alertdialog]');
  assert.ok(asked && asked.closest('.scope-tree') === draftB.closest('.scope-tree'), `the orphan is asked next, on the window going quiet: ${asked ? 'asked elsewhere' : 'nothing asked'}`);
  answerDialog(h.app, /keep editing/iu);
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A untouched');
  assert.equal(draftB.isConnected && draftB.value, '# notes\n\nunsaved', 'B kept');
});

// ─── #335 ③c-4: the bell s union ─────────────────────────────────────────

/** Two servers, each with a stored alert on a room NOT open at boot (the Hub
 * opens `app` first and reading marks it); B s is newer. A s is seeded under
 * the pre-#335 LIVE key, which the boot folds into A s slot (`twoServers`
 * seeds A s navigation the same way). */
const twoAlerts = () => ({
  tmux_hub_alerts: JSON.stringify([{ key: 'proj:old|1', room: 'proj:old', server: 'a', session: 'old', project: 'old', seq: 1, id: '1', ts: 1_800_000_000_000, from: 'dev', toHuman: true, kind: 'reply', excerpt: 'from alpha', viewed: false }]),
  'tmux_hub_alerts::b': JSON.stringify([{ key: 'proj:other|9', room: 'proj:other', server: 'b', session: 'other', project: 'other', seq: 9, id: '9', ts: 1_800_000_005_000, from: 'ops', toHuman: true, kind: 'reply', excerpt: 'from beta', viewed: false }]),
});
const bellRows = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.nc-list .nc-row')]
  .map((r) => `${r.dataset.server}:${r.querySelector('.server-tag')?.textContent ?? '-'}:${r.querySelector('.nc-text')?.textContent}${r.classList.contains('unavailable') ? '!' : ''}`);
const openBell = async (h: Awaited<ReturnType<typeof bootApp>>) => {
  h.app.document.querySelector<HTMLButtonElement>('.rail-bell')!.click();
  for (let i = 0; i < 3; i++) await h.settle();
};

test('③c-4: the bell is the UNION of every included server s alerts — newest first across servers, each row tagged, the badge the sum; Single shows one server s list untagged', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs() });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell')!;
  assert.match(bell.getAttribute('aria-label') ?? '', /· 2\b/u, `both unviewed: ${bell.getAttribute('aria-label')}`);
  await openBell(h);
  assert.deepEqual(bellRows(h), ['b:beta:from beta', 'a:alpha:from alpha'], 'B s newer alert first, every row tagged');
  assert.ok(h.app.document.querySelector('.nc-foot .command-button'), 'Clear offered');
});

test('#356: a notification row is three fixed lines — a long sender and an old date never cost the project its name; the tag and "to you" sit on the meta line; the time is tiered', async (context) => {
  // Mock-timer clock: 2027-01-15 (1_800_000_000_000 ms) — A's alert is from
  // today, B's is from last year (older tier) with a long sender.
  const old = { key: 'proj:tmux-mobile|9', room: 'proj:tmux-mobile', server: 'b', session: 'tmux-mobile', project: 'tmux-mobile', seq: 9, id: '9', ts: Date.UTC(2026, 9, 11, 10, 57), from: 'orchestrator-of-everything', toHuman: true, kind: 'reply', excerpt: 'a long excerpt that will be cut at one line', viewed: false };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
    'tmux_hub_alerts::b': JSON.stringify([old]),
  }), undefined, { ...sandbox, rpc: twoHubs() });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  await openBell(h);
  const row = [...h.app.document.querySelectorAll<HTMLElement>('.nc-list .nc-row')].find((r) => r.dataset.server === 'b')!;
  assert.ok(row);
  const top = row.querySelector('.nc-top')!, meta = row.querySelector('.nc-meta')!;
  assert.equal(top.querySelector('.nc-project')?.textContent, 'tmux-mobile', 'the project name is intact');
  assert.deepEqual([...top.children].map((c) => c.className.split(' ')[0]), ['unread-dot', 'nc-project', 'nc-time'], 'identity line: dot, project, time — nothing else competes');
  assert.deepEqual([...meta.children].map((c) => c.className.split(' ')[0]), ['server-tag', 'nc-who', 'nc-tag'], 'meta line: tag, who, to-you');
  assert.equal(meta.querySelector('.nc-who')?.textContent, 'orchestrator-of-everything');
  assert.match(top.querySelector('.nc-time')?.textContent ?? '', /^\d{4}-\d{2}-\d{2}$/u, `older than this year: the date alone, ${top.querySelector('.nc-time')?.textContent}`);
  const rowA = [...h.app.document.querySelectorAll<HTMLElement>('.nc-list .nc-row')].find((r) => r.dataset.server === 'a')!;
  assert.match(rowA.querySelector('.nc-time')?.textContent ?? '', /^\d{2}:\d{2}$/u, 'today: HH:MM only');
  assert.equal(row.querySelector('.nc-text')?.textContent, old.excerpt, 'the excerpt is its own line');
});

test('#356 (phone, Aggregate): the Hub header stacks the server tag under the project name — one stack element, name on top, tag tight under it', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'mobile',
  }), undefined, { ...sandbox, rpc: twoHubs(), setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 30 && !h.app.document.querySelector('.scope-tree:not(.held) .hub-root .chat-head .server-tag'); i++) { await h.app.advance(500); await h.settle(); }
  const stack = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .hub-root .chat-head .title-stack')!;
  assert.ok(stack, 'the name and tag share one stack');
  assert.ok(stack.classList.contains('stacked'), 'phone: stacked');
  assert.deepEqual([...stack.children].map((c) => c.classList.contains('name-line') ? 'name-line' : c.classList.contains('server-tag') ? 'server-tag' : c.tagName), ['name-line', 'server-tag'], 'the name line (name + chevron) on top, the tag under it');
  assert.ok(stack.children[0]?.querySelector('button[aria-haspopup="menu"]'), 'the chevron sits with the name, not beside the two-line block');
  assert.equal(stack.querySelector('.h1-text')?.textContent, 'app');
  assert.equal(stack.querySelector('.server-tag')?.textContent, 'alpha');
});

// (Single has no tag on either screen — held by `③c-1: Single names nothing`
// and `③c-4 (Single)…`, not re-tested here.)
test('#359 (desktop, Aggregate): the header stack is NOT mode-driven — no `stacked` class on the desktop; the name and the tag are both in one wrapping stack, so a name that does not fit beside the tag pushes the tag under it (pixel truth: validator at 1280; jsdom has no layout)', async (context) => {
  const long = 'a-forty-character-project-name-for-the-fit-test';
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs({ projectList: async () => ({ projects: [{ project: { id: `${asking()}-long`, name: long, session: long, path: `/${long}`, room: `proj:${long}`, updated_at: 9000 }, live: true, slots: [] }] }) }) });
  for (let i = 0; i < 30 && !h.app.document.querySelector('.scope-tree:not(.held) .hub-root .chat-head .title-stack .server-tag'); i++) { await h.app.advance(500); await h.settle(); }
  const stack = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .hub-root .chat-head .title-stack')!;
  assert.ok(stack && !stack.classList.contains('stacked'), 'desktop: no mode class — CSS wrap decides');
  assert.equal(stack.querySelector('.h1-text')?.textContent, long, 'the whole name is in the DOM (nothing truncates it before paint)');
  assert.equal(stack.querySelector('.server-tag')?.textContent, 'alpha', 'the tag is in the same wrapping stack, after the name');
  // The chevron lives in the NAME LINE with the name (owner 22:57: it must
  // never float beside a two-line block): the stack's children are the name
  // line and the tag; the name line holds the h1 and the menu button.
  assert.equal(stack.children.length, 2);
  const line = stack.children[0] as HTMLElement;
  assert.ok(line.classList.contains('name-line'));
  assert.ok(line.querySelector('h1 .h1-text'), 'the name is in the line');
  const chevron = line.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  assert.ok(chevron, 'the chevron is in the line, after the name');
  assert.equal(line.lastElementChild, chevron, 'glued at the name s right edge');
  assert.ok(stack.children[1]?.classList.contains('server-tag'), 'the tag is the second item: it alone wraps');
  // Geometry (chevron on the name's line within 8px; tag below) is the
  // validator's at 1280 and in split-screen; jsdom has no layout.
});

test('#356 (desktop, Aggregate): the header tag stays inline', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs() });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const stack = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .hub-root .chat-head .title-stack')!;
  assert.ok(stack && !stack.classList.contains('stacked'), 'desktop: inline');
  assert.equal(stack.querySelector('.server-tag')?.textContent, 'alpha');
});

// #360 (owner 2026-10-13 22:58: sidebar rows read "laminar-…", "tmux-m…",
// "Ling…"): a tagged row is TWO lines — identity (name · unread · age) on
// .p-top, the server tag alone on .p-source under it. One fixture: a long
// name on both servers, 8 unread each.
const LONG_360 = 'tmux-mobile-long-project-name';
const rpc360 = () => ({
  ...twoHubs(),
  projectList: async () => ({ projects: [{ project: { id: `${asking()}-long`, name: LONG_360, session: LONG_360, path: `/${LONG_360}`, room: `proj:${LONG_360}`, updated_at: 9000 }, live: true, slots: [] }] }),
  hubRooms: async () => ({ rooms: { [`proj:${LONG_360}`]: 9000 }, states: {} }),
  hubUnread: async () => ({ rooms: { [`proj:${LONG_360}`]: { count: 8, first_seq: 1, last_seq: 8 } } }),
});
const rows360 = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row:not(.missing)')].filter((r) => r.querySelector('.p-name'));
async function twoLineRows360(context: any, mode: 'mobile' | 'desktop') {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: mode,
  }), undefined, { ...sandbox, rpc: rpc360(), setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 30 && !(rows360(h).length === 2 && rows360(h).every((r) => r.querySelector('.side-unread'))); i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(rows360(h).length, 2, `${mode}: both servers' rows`);
  for (const row of rows360(h)) {
    const top = row.querySelector('.p-top')!;
    assert.deepEqual([...top.children].map((c) => c.className.split(' ')[0]), ['p-name', 'side-unread', 'side-age'], `${mode}: identity line — name, unread, age, nothing else`);
    assert.equal(top.querySelector('.p-name')?.textContent, LONG_360, `${mode}: the whole name is in the DOM`);
    assert.equal(top.querySelector('.server-tag'), null, `${mode}: no tag on the identity line`);
    assert.equal(top.nextElementSibling?.className, 'p-source', `${mode}: the source line directly under it`);
    assert.match(top.nextElementSibling?.querySelector('.server-tag')?.textContent ?? '', /^(alpha|beta)$/u, `${mode}: the tag alone on it`);
    assert.match(top.querySelector('.side-unread')?.textContent ?? '', /8/u, `${mode}: unread stays on the identity line`);
  }
}
test('#360 (phone, Aggregate): a tagged sidebar row is TWO lines — identity (name · unread · age) on .p-top, the server tag alone on .p-source under it; the long name is whole in the DOM', (context) => twoLineRows360(context, 'mobile'));
test('#360 (desktop, Aggregate): the same two lines — not a compact rule', (context) => twoLineRows360(context, 'desktop'));
test('#360 (Single): no tag, no source line — one line as before #335', async (context) => {
  const h = await bootApp(context, { ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop' }, undefined, { ...sandbox, rpc: rpc360() });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const row = rows360(h)[0]!;
  assert.ok(row, 'A s row');
  assert.equal(row.querySelector('.p-source'), null, 'Single: no source line');
  assert.equal(row.querySelector('.server-tag'), null, 'Single: no tag');
});

test('③c-4 (Single): one server, one list, no tag, Clear as before', async (context) => {
  const h = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }, undefined, { ...sandbox, rpc: twoHubs() });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell')!;
  assert.match(bell.getAttribute('aria-label') ?? '', /· 1\b/u, 'A s alone');
  await openBell(h);
  assert.deepEqual(bellRows(h), ['a:-:from alpha'], 'A s list, untagged');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-foot button')].find((b) => /clear/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 2; i++) await h.settle();
  assert.equal(h.app.window.localStorage.getItem('tmux_hub_alerts::a'), '[]', 'A s list cleared');
  assert.ok(JSON.parse(h.app.window.localStorage.getItem('tmux_hub_alerts::b')!).length === 1, 'B s, not included in Single, untouched');
});

test('③c-4: picking ANOTHER server s alert focuses that server (D2) and lands in ITS Hub on the message; hub_read goes to that server only — A s same-named room is untouched', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: twoHubs({ hubLog: async (session: string) => ({ messages: asking() === 'b' && session === 'other' ? [{ id: '9', seq: 9, ts: 1_800_000_005_000, from: 'ops', to: ['human'], body: 'from beta', room: 'proj:other' }] : [], has_more: false }) }) });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  await openBell(h);
  const rowB = [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-list .nc-row')].find((r) => r.dataset.server === 'b')!;
  const mark = events.length;
  rowB.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  let hit: Element | null = null;
  for (let i = 0; i < 16 && !hit; i++) { await h.app.advance(100); await h.settle(); hit = h.app.document.querySelector('.scope-tree:not(.held) .jump-hit[data-msg="9"]'); }
  assert.ok(hit, `the jump landed on B s message in B s Hub: ${h.app.document.querySelector('.nc-fail')?.textContent ?? 'no failure shown'}`);
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  // The jump marked B s entry viewed in B s list; A s list is untouched. A
  // room read mark (hub_read) is the Hub s own and goes to the room s server
  // only — here the reader is on B s room, so nothing of A s is read.
  assert.equal((JSON.parse(ls.getItem('tmux_hub_alerts::b')!) as { viewed: boolean }[])[0]!.viewed, true, 'B s alert viewed');
  assert.equal((JSON.parse(ls.getItem('tmux_hub_alerts::a')!) as { viewed: boolean }[])[0]!.viewed, false, 'A s alert not');
  const reads = events.slice(mark).filter((e) => /^rpc@[ab]:hubRead$/u.test(e));
  assert.ok(!reads.includes('rpc@a:hubRead'), `no hub_read to A: ${reads.join(',')}`);
  assert.ok(conn(h, 'a')!.isConnected() && !conn(h, 'a')!.disposed(), 'A stays a member');
  // The room the jump opened is B s, read through B s own Hub (its
  // hub_log went to B); the read mark that follows reading it is that Hub s
  // (`markSeen` → `hubRead` on ITS scope.runtime.api — the ②b-4 rule pinned
  // in App.source), so it can only ever reach B. jsdom does not scroll, so
  // the Feed s own at-tail read is not driven here.
  assert.ok(events.slice(mark).includes('rpc@b:hubLog'), 'B s room log was asked of B');
  assert.ok(!events.slice(mark).includes('rpc@a:hubLog'), 'nothing of the jump asked A');
});

test('③c-4 (D6): a member that is not connected is listed unavailable — its alerts shown muted and named in the foot, not counted, and Clear leaves them; the reachable list is cleared', async (context) => {
  let bDown = false;
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs(), gate: (url) => (url.includes('//b') && bDown ? Promise.reject(new Error('down')) : null) });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  // B drops and its reconnect fails for good.
  bDown = true;
  conn(h, 'b')!.drop();
  for (let i = 0; i < 4; i++) { await h.app.advance(3000); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B is down');
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell')!;
  assert.match(bell.getAttribute('aria-label') ?? '', /· 1\b/u, `only A s counts: ${bell.getAttribute('aria-label')}`);
  await openBell(h);
  assert.deepEqual(bellRows(h), ['b:beta:from beta!', 'a:alpha:from alpha'], 'B s row shown, marked unavailable');
  assert.match(h.app.document.querySelector('.nc-foot')?.textContent ?? '', /beta/u, 'the foot names the unreachable server');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-foot button')].find((b) => /clear/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 2; i++) await h.settle();
  assert.equal(ls.getItem('tmux_hub_alerts::a'), '[]', 'A s list cleared');
  assert.equal(JSON.parse(ls.getItem('tmux_hub_alerts::b')!).length, 1, 'B s list untouched');
  assert.equal(JSON.parse(ls.getItem('tmux_hub_alerts::b')!)[0].viewed, false, 'and not counted read');
  assert.deepEqual(bellRows(h), ['b:beta:from beta!'], 'B s row remains, muted');
  assert.equal(h.app.document.querySelector('.nc-foot .command-button'), null, 'nothing left to clear');
});

test('③c-4/P1-C3 (a): the bell is the WINDOW s — a focus without a Hub does not take the entry away from a member that has one: B s alerts are counted and reachable', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'terminal' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs({
    // A has NO Hub: its bus answers method-not-found; B's is as before.
    hubRooms: async () => { if (asking() === 'a') throw Object.assign(new Error('no hub'), { code: -32601 }); return { rooms: { 'proj:app': 9000, 'proj:other': 50 }, states: {} }; },
  }) });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .hub-root'), null, 'A has no Hub');
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell');
  assert.ok(bell, 'the bell is reachable: B has a Hub and alerts');
  // Both indexes count: B's (its Hub feeds it) and A's (A is connected; its
  // index exists and is reachable to clear, Hub or no Hub).
  assert.match(bell.getAttribute('aria-label') ?? '', /· 2\b/u, `both unviewed alerts count: ${bell.getAttribute('aria-label')}`);
  await openBell(h);
  assert.deepEqual(bellRows(h), ['b:beta:from beta', 'a:alpha:from alpha'], 'both rows, neither unavailable');
});

test('③c-4/P1-C3 (a, touch): on a phone the window s bell is reachable without a focus Hub — the Hub tab s slot carries the notification door; it opens the union and picking B s row focuses B', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'terminal' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'mobile',
  }), undefined, { ...sandbox, rpc: twoHubs({
    hubRooms: async () => { if (asking() === 'a') throw Object.assign(new Error('no hub'), { code: -32601 }); return { rooms: { 'proj:app': 9000, 'proj:other': 50 }, states: {} }; },
    hubLog: async (session: string) => ({ messages: asking() === 'b' && session === 'other' ? [{ id: '9', seq: 9, ts: 1_800_000_005_000, from: 'ops', to: ['human'], body: 'from beta', room: 'proj:other' }] : [], has_more: false }),
    hubLogAround: async () => ({ messages: [{ id: '9', seq: 9, ts: 1_800_000_005_000, from: 'ops', to: ['human'], body: 'from beta', room: 'proj:other' }], has_more: false }),
  }), setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .hub-root'), null, 'A has no Hub');
  assert.equal(h.app.document.querySelector('.rail-bell'), null, 'no rail on a phone');
  assert.equal([...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button')].find((b) => /^chat$/iu.test(b.textContent?.trim() ?? '')), undefined, 'no Chat tab is pretended for A');
  const door = h.app.document.querySelector<HTMLButtonElement>('.tabbar .tab-bell');
  assert.ok(door, 'the tab bar carries the window s notification door');
  assert.ok(reachable(door), 'and it is on screen');
  assert.match(door.getAttribute('aria-label') ?? '', /· 2\b/u, `the badge: ${door.getAttribute('aria-label')}`);
  door.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.deepEqual(bellRows(h), ['b:beta:from beta', 'a:alpha:from alpha'], 'the union opened from the door');
  // Pick B's row: the focus moves to B (D2) and B's Hub lands.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-list .nc-row')].find((r) => r.dataset.server === 'b')!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) { await h.app.advance(200); await h.settle(); }
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'focused B');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held) .hub-root'), 'B s Hub in front');
  assert.ok([...h.app.document.querySelectorAll<HTMLButtonElement>('.tabbar button')].some((b) => /^chat$/iu.test(b.textContent?.trim() ?? '')), 'B has a Hub: the Chat tab is back, the door gone');
  assert.equal(h.app.document.querySelector('.tabbar .tab-bell'), null);
});

test('③c-4/P1-C3 (b): a member that NEVER came up (refuses from boot) still has its index shown — read-only, unavailable, not counted, untouched by Clear', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), ...twoAlerts(), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs(), gate: (url) => (url.includes('//b') ? Promise.reject(new Error('unauthorized')) : null) });
  for (let i = 0; i < 12; i++) { await h.app.advance(1000); await h.settle(); }
  const ls = h.app.window.localStorage;
  assert.equal(conn(h, 'b')?.isConnected() ?? false, false, 'B never connected');
  const bell = h.app.document.querySelector<HTMLButtonElement>('.rail-bell')!;
  assert.match(bell.getAttribute('aria-label') ?? '', /· 1\b/u, `only A counts: ${bell.getAttribute('aria-label')}`);
  await openBell(h);
  assert.deepEqual(bellRows(h), ['b:beta:from beta!', 'a:alpha:from alpha'], 'B s persisted index is shown, muted');
  assert.match(h.app.document.querySelector('.nc-foot')?.textContent ?? '', /beta/u, 'and named unreachable');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.nc-foot button')].find((b) => /clear/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 2; i++) await h.settle();
  assert.equal(ls.getItem('tmux_hub_alerts::a'), '[]', 'A s list cleared');
  assert.equal(JSON.parse(ls.getItem('tmux_hub_alerts::b')!).length, 1, 'B s index untouched: no runtime ever owned it, and the union never writes an unavailable one');
  assert.deepEqual(bellRows(h), ['b:beta:from beta!']);
});

test('③c-4: a system notification s tag names the room ON ITS SERVER, and the title names the server when more than one is included', async (context) => {
  const sys: { title: string; tag?: string }[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop', tmux_notify_level: 'replies',
  }), undefined, { ...sandbox, rpc: twoHubs(), setup(window: any) {
    window.Element.prototype.getAnimations = () => [];
    window.Notification = class { static permission = 'granted'; constructor(title: string, opts: any) { sys.push({ title, tag: opts?.tag }); } };
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  } });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  // A message arrives on B s room `app` while the window is hidden (away).
  conn(h, 'b')!.push({ id: '77', seq: 77, ts: 1_800_000_009_000, from: 'ops', to: ['human'], body: 'ping from beta', room: 'proj:app' });
  for (let i = 0; i < 6; i++) { await h.app.advance(300); await h.settle(); }
  const card = sys.find((s) => /ping|ops/u.test(s.title) || (s.tag ?? '').includes('proj:app'));
  assert.ok(card, `a tray card: ${JSON.stringify(sys)}`);
  assert.equal(card.tag, 'tmm:b|proj:app', 'the tag is the room on its server');
  assert.match(card.title, /beta/u, 'the title names the server');
});

// ─── #335 ③c-5: system status and the "current server" actions ───────────

const hoverOn = async (h: Awaited<ReturnType<typeof bootApp>>, el: Element) => {
  const event = new h.app.window.Event('pointerenter', { bubbles: false });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  el.dispatchEvent(event);
  for (let i = 0; i < 4; i++) { await h.app.advance(400); await h.settle(); }
};
const cardText = (h: Awaited<ReturnType<typeof bootApp>>) => h.app.document.querySelector('.hover-card')?.textContent ?? '';

test('③c-5: the system status is the FOCUSED server s reading, named beside the number, never a sum — a focus move drops the old reading and reads the new server at once; a LATE answer of the old owner s is dropped (P1-C2)', async (context) => {
  const events: string[] = [];
  // Both servers answer only when released: the window between a focus move
  // and the new owner's answer is where a stale reading would show, and an
  // old owner's answer arriving AFTER the new one is the late-overwrite.
  const pending: Record<string, Array<() => void>> = { a: [], b: [] };
  const release = (id: string) => { for (const r of pending[id]!.splice(0)) r(); };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: { ...twoHubs(), systemStatus: async () => {
    const id = asking();
    await new Promise<void>((r) => { pending[id]!.push(r); });
    return id === 'b' ? { cpu_pct: 90, mem_used: 9, mem_total: 10, disk_used: 1, disk_total: 10 } : { cpu_pct: 10, mem_used: 1, mem_total: 10, disk_used: 1, disk_total: 10 };
  } } });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  const vitals = () => h.app.document.querySelector('.sysvitals')?.textContent ?? '';
  release('a');
  for (let i = 0; i < 4; i++) { await h.app.advance(50); await h.settle(); }
  assert.match(vitals(), /10\s*%|CPU10/u, `A s reading: ${vitals()}`);
  assert.ok(!events.some((e) => e === 'rpc@b:systemStatus'), 'only the focus is polled (D4): B never asked');
  assert.equal(h.app.document.querySelector('.sysvitals .server-tag')?.textContent, 'alpha', 'the name sits BESIDE the reading (not hover-only: coarse input has no hover)');
  await hoverOn(h, h.app.document.querySelector('.sysvitals')!);
  assert.match(cardText(h), /alpha/u, `and the card names it too: ${cardText(h)}`);
  // Let A's interval fire once more so an A request is IN FLIGHT when the
  // focus moves (the late answer the P1 is about).
  for (let i = 0; i < 2; i++) { await h.app.advance(20_000); await h.settle(); }
  assert.ok(pending.a!.length >= 1, `an A request is in flight: ${pending.a!.length}`);
  // Focus B: A s numbers go at once, B is read at once.
  const mark = events.length;
  await pickServer(h, 'beta');
  for (let i = 0; i < 4; i++) { await h.app.advance(100); await h.settle(); }
  assert.ok(events.slice(mark).includes('rpc@b:systemStatus'), 'B read at once on focus');
  assert.doesNotMatch(vitals(), /10\s*%|CPU10/u, `A s reading is gone before B answers: ${vitals()}`);
  assert.equal(h.app.document.querySelector('.sysvitals'), null, 'unanswered = no reading (nothing is relabelled)');
  release('b');
  for (let i = 0; i < 4; i++) { await h.app.advance(50); await h.settle(); }
  assert.match(vitals(), /90\s*%|CPU90/u, `B s reading, not A s or a sum: ${vitals()}`);
  assert.equal(h.app.document.querySelector('.sysvitals .server-tag')?.textContent, 'beta', 'named B');
  // NOW A's old request answers, late: dropped, B's reading stands.
  release('a');
  for (let i = 0; i < 4; i++) { await h.app.advance(50); await h.settle(); }
  assert.match(vitals(), /90\s*%|CPU90/u, `A s late answer did not overwrite B s: ${vitals()}`);
  assert.doesNotMatch(vitals(), /100|50/u, 'not summed or averaged');
  // A→B→A fast: two moves before either answers; only the LAST owner's
  // answer lands, the stale middle one is dropped.
  await pickServer(h, 'alpha');
  for (let i = 0; i < 2; i++) { await h.app.advance(50); await h.settle(); }
  await pickServer(h, 'beta');
  for (let i = 0; i < 2; i++) { await h.app.advance(50); await h.settle(); }
  await pickServer(h, 'alpha');
  for (let i = 0; i < 2; i++) { await h.app.advance(50); await h.settle(); }
  assert.equal(h.app.document.querySelector('.sysvitals'), null, 'nothing shown until the final owner answers');
  release('b');
  for (let i = 0; i < 2; i++) { await h.app.advance(50); await h.settle(); }
  assert.equal(h.app.document.querySelector('.sysvitals'), null, 'the middle owner s answer is dropped');
  release('a');
  for (let i = 0; i < 4; i++) { await h.app.advance(50); await h.settle(); }
  assert.match(vitals(), /10\s*%|CPU10/u, `the final owner s answer lands: ${vitals()}`);
  assert.equal(h.app.document.querySelector('.sysvitals .server-tag')?.textContent, 'alpha');
});

test('③c-5 (Aggregate, one included member): the reading is still named — the name is the identity of the number, not the >1 tag rule', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }, ['b']), undefined, { ...sandbox, rpc: { ...twoHubs(), systemStatus: async () => ({ cpu_pct: 10, mem_used: 1, mem_total: 10, disk_used: 1, disk_total: 10 }) } });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(h.app.document.querySelector('.sysvitals .server-tag')?.textContent, 'alpha', 'named with B excluded');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .chat-head .server-tag'), null, 'while the page heads follow the >1 rule and are untagged');
});

test('③c-5 (Single): the status card names no server', async (context) => {
  const h = await bootApp(context, {
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }, undefined, { ...sandbox, rpc: { ...twoHubs(), systemStatus: async () => ({ cpu_pct: 10, mem_used: 1, mem_total: 10, disk_used: 1, disk_total: 10 }) } });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(h.app.document.querySelector('.sysvitals .server-tag'), null, 'no name beside the reading');
  await hoverOn(h, h.app.document.querySelector('.sysvitals')!);
  assert.doesNotMatch(cardText(h), /alpha|beta/u, `no server in the card: ${cardText(h)}`);
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .scratch-head .server-tag'), null, 'nor on the scratch head');
});

test('③c-5: the switcher row s hover carries only what the row hides — the machine, a connecting/reconnecting word, Excluded — never the name or address again, and no other server s readings', async (context) => {
  let bDown = false;
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
      { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
    ]),
  }, ['d']), (url) => (url.includes('//b') ? 'm-b' : url.includes('//d') ? 'm-d' : 'm-a'), { ...sandbox, rpc: twoHubs(), gate: (url) => (url.includes('//b') && bDown ? new Promise<void>(() => {}) : null) });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  await toConnection(h);
  const row = (name: string) => [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences .server-list .sm-pick')].find((b) => new RegExp(`^${name}\\b`, 'iu').test((b.textContent ?? '').trim()))!;
  assert.equal(row('beta').getAttribute('title'), null, 'no native title beside the card');
  await hoverOn(h, row('beta'));
  let card = cardText(h);
  assert.match(card, /m-b/u, `the machine, which the row hides: ${card}`);
  assert.doesNotMatch(card, /beta|ws:\/\/b/u, 'not the name or address the row shows');
  assert.doesNotMatch(card, /CPU|MEM/u, 'no readings of another server');
  // Excluded D: the card says so.
  await hoverOn(h, row('delta'));
  card = cardText(h);
  assert.match(card, /Excluded/u, `excluded: ${card}`);
  // B reconnecting: the status word behind the breathing dot.
  bDown = true;
  conn(h, 'b')!.drop();
  for (let i = 0; i < 3; i++) { await h.app.advance(1000); await h.settle(); }
  await hoverOn(h, row('beta'));
  card = cardText(h);
  assert.match(card, /Reconnecting|Connecting/u, `the status word: ${card}`);
});

test('③c-5: the owner-bound surfaces say whose they are when several servers are included — the scratch head, the Agents page head, the Connection title — and the copy-link acts on the FOCUSED server, frozen at the click', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs(), setup(window: any) { window.Element.prototype.getAnimations = () => []; window.navigator.clipboard = { writeText: async (t: string) => { (window as any).__copied = t; } }; } });
  for (let i = 0; i < 30 && sideRows(h).length < 4; i++) { await h.app.advance(500); await h.settle(); }
  // The scratch head, in the focused tree.
  // (The held tree mounts no scratch panel — it is shown only in the connected, focused tree.)
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .scratch-head .server-tag')?.textContent, 'alpha', 'the scratch head names its owner');
  // The Agents page head.
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^agents$/iu.test((b.getAttribute('aria-label') ?? '').trim()))?.click();
  for (let i = 0; i < 4; i++) await h.settle();
  // The Agents page's own head (`.config-page-head`), not the Hub's chat
  // head or the Board's, which are tagged since ③c-1/③c-2.
  const agentsHead = h.app.document.querySelector('.scope-tree:not(.held) .config-page-head');
  assert.match(agentsHead?.querySelector('h1')?.textContent ?? '', /agents/iu, 'the Agents page is open');
  assert.equal(agentsHead?.querySelector('.server-tag')?.textContent, 'alpha', `the Agents head names its owner: ${agentsHead?.textContent}`);
  // Connection: the title is tagged; copy-link copies A s link.
  await toConnection(h);
  assert.equal(h.app.document.querySelector('.preferences .connection-title .server-tag')?.textContent, 'alpha', 'the Connection title names the focus');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /share connection link/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.match((h.app.window as any).__copied ?? '', /addr=ws%3A%2F%2Fa%3A9899/u, `A s link: ${(h.app.window as any).__copied}`);
  // Focus B: the title follows; the link is B s.
  await pickServer(h, 'beta');
  for (let i = 0; i < 4; i++) await h.settle();
  await toConnection(h);
  assert.equal(h.app.document.querySelector('.preferences .connection-title .server-tag')?.textContent, 'beta');
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.preferences button')].find((b) => /share connection link/iu.test(b.textContent ?? ''))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.match((h.app.window as any).__copied ?? '', /addr=ws%3A%2F%2Fb%3A9899/u, `B s link: ${(h.app.window as any).__copied}`);
});

test('③c-5 (touch): the guest Agents editor names its server too — the same tag answer App hands every tree, including a revealed OTHER member s guest, never CURRENT s name', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:2.0') }), tmux_layout_mode: 'mobile',
  }), undefined, { rpc: guestRpc(), setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; } });
  for (let i = 0; i < 4; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  await settingsTab(h, /^agents/iu);
  const shownTag = () => h.app.document.querySelector('.agents-embed .guest:not(.off) .mid .page-head .server-tag')?.textContent;
  assert.equal(shownTag(), 'alpha', 'A s guest head names A');
  // Focus B: its guest comes forward, named B.
  await settingsTab(h, /^connection/iu);
  await pickServer(h, 'beta');
  assert.equal(ls.getItem('tmux_server_current'), 'b');
  await settingsTab(h, /^agents/iu);
  assert.equal(shownTag(), 'beta', 'B s guest head names B');
  // Both guests are mounted; the hidden one still carries ITS name (not CURRENT s).
  const tags = [...h.app.document.querySelectorAll('.agents-embed .guest .mid .page-head .server-tag')].map((e) => e.textContent).sort();
  assert.deepEqual(tags, ['alpha', 'beta'], 'each guest names its own server');
});

// ─── #335 ③d-2: the r1 §F acceptance matrix — rows no earlier test holds ──

test('§F reload (Aggregate): mode, excluded set, focus, each tree s draft and view come back; every ref keeps its own serverId; an excluded server is listed excluded, not resolved by a same-named session on another server', async (context) => {
  // A focus (work:1.0), B member with its own `work:2.0`, D excluded. All
  // three have a session named `work`; a reload must restore each tree from
  // ITS slot — never B's `work` for A, never a tree for D.
  const servers = [
    { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    { id: 'd', name: 'delta', address: 'ws://d:9899', token: 'tokD', machineId: 'm-d', named: true },
  ];
  const rpc = { ...editorRpc, listSessions: async () => [{ name: 'work' }, { name: 'other' }], listSessionsWithPanes: async () => ({ sessions: [{ name: 'work', windows: 1 }, { name: 'other', windows: 1 }], panes: [{ session: 'work', window: 1, pane: 0 }, { session: 'other', window: 3, pane: 0 }] }) };
  const machine = (url: string) => (url.includes('//b') ? 'm-b' : url.includes('//d') ? 'm-d' : 'm-a');
  const first = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ v: 2, page: 'terminal', pane: { kind: 'pane', serverId: 'a', session: 'work', target: 'work:1.0' }, splitLayout: 1, splitCells: [] }), parked: JSON.stringify({ v: 2, page: 'terminal', pane: { kind: 'pane', serverId: 'b', session: 'work', target: 'work:2.0' }, splitLayout: 1, splitCells: [] }) }),
    tmux_servers: JSON.stringify(servers), tmux_layout_mode: 'desktop',
    // A is the pre-#335 LIVE server here (`twoServers` seeds unprefixed live
    // keys for A), so its draft is the legacy key the boot folds into A's slot.
    tmux_hub_drafts: JSON.stringify({ work: 'draft on A' }), 'tmux_hub_drafts::b': JSON.stringify({ work: 'draft on B' }),
  }, ['d']), machine, { ...sandbox, rpc });
  for (let i = 0; i < 8; i++) { await first.app.advance(500); await first.settle(); }
  assert.equal(trees(first.app).length, 2, 'A and B mounted; D excluded has no tree');
  // An edit on A (a Files draft) and on B's view (focus B, open `other`), then back to A.
  const draftA = await dirtyEditor(first.app, first.settle);
  const h1 = { app: first.app, settle: first.settle, switchTo: first.switchTo } as any;
  await pickServer(h1, 'beta');
  for (let i = 0; i < 4; i++) { await first.app.advance(300); await first.settle(); }
  await first.openSession('other');
  assert.equal(first.restored(), 'b:other:3.0', 'B s edit saved as B s');
  await pickServer(h1, 'alpha');
  for (let i = 0; i < 4; i++) { await first.app.advance(300); await first.settle(); }
  const ls = first.app.window.localStorage;
  assert.equal(ls.getItem('tmux_server_current'), 'a');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved', 'A s draft still mounted');
  const after = dumpStorage(first.app);
  await first.app.close();

  // Reload.
  const second = await bootApp(context, after, machine, { ...sandbox, rpc });
  for (let i = 0; i < 10; i++) { await second.app.advance(500); await second.settle(); }
  const ls2 = second.app.window.localStorage;
  assert.equal(ls2.getItem('tmux_connection_mode'), 'aggregate', 'mode');
  assert.deepEqual(JSON.parse(ls2.getItem('tmux_excluded_servers')!), ['d'], 'excluded set');
  assert.equal(ls2.getItem('tmux_server_current'), 'a', 'focus');
  assert.equal(trees(second.app).length, 2, 'A and B back, D still not mounted');
  assert.equal(second.onScreen(), 'work:1.0', 'A s own view, not B s same-named `work:2.0`');
  const slotB = JSON.parse(ls2.getItem('tmux_state::b')!);
  assert.equal(slotB.pane?.target, 'other:3.0', 'B s edit survived the reload');
  assert.equal(slotB.pane?.serverId, 'b', 'with B s own serverId');
  assert.equal(JSON.parse(ls2.getItem('tmux_state::a')!).pane?.serverId, 'a');
  assert.equal(ls2.getItem('tmux_hub_drafts::a'), JSON.stringify({ work: 'draft on A' }));
  assert.equal(ls2.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'draft on B' }));
  // D: listed as excluded (an explicit state), not absent and not substituted.
  const h2 = { app: second.app, settle: second.settle } as any;
  await toConnection(h2);
  const rowD = [...second.app.document.querySelectorAll<HTMLButtonElement>('.preferences .server-list .sm-pick')].find((b) => /^delta\b/iu.test((b.textContent ?? '').trim()));
  assert.ok(rowD, 'D is listed');
  assert.equal(includeSwitch(h2, 'delta')?.getAttribute('aria-checked'), 'false', 'as excluded');
  assert.equal(second.app.document.querySelector('.scope-tree .term-side .session.foreign[data-server="d"]'), null, 'and contributes no sessions to any union');
});

test('§F isolation: a background member drops and reconnects while the focus is typing in an editor — the focus s draft, its connection and its dial count are untouched, nobody is asked; the member comes back on its own', async (context) => {
  let bDown = false;
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: { ...editorRpc, ...twoHubs() }, gate: (url) => (url.includes('//b') && bDown ? Promise.reject(new Error('B down')) : null) });
  for (let i = 0; i < 8; i++) { await h.app.advance(500); await h.settle(); }
  const a = conn(h, 'a')!;
  const draftA = await dirtyEditor(h.app, h.settle);
  draftA.value = '# notes\n\nunsaved, still typing'; draftA.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await h.settle();
  const dialsA = events.filter((e) => e.startsWith('dial@a:')).length;
  // B drops; its reconnect fails for a while; then it is allowed back.
  bDown = true;
  conn(h, 'b')!.drop();
  for (let i = 0; i < 6; i++) { await h.app.advance(2000); await h.settle(); }
  assert.equal(conn(h, 'b')!.isConnected(), false, 'B is down');
  assert.ok(a.isConnected() && !a.disposed(), 'A s connection untouched');
  assert.equal(events.filter((e) => e.startsWith('dial@a:')).length, dialsA, 'A was not re-dialled');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved, still typing', 'A s draft, with the text typed meanwhile');
  assert.equal(h.app.window.localStorage.getItem('tmux_server_current'), 'a', 'the focus did not move');
  assert.equal(h.app.document.querySelector('[role=alertdialog]'), null, 'nobody was asked anything');
  bDown = false;
  for (let i = 0; i < 12 && !(conn(h, 'b')?.isConnected()); i++) { await h.app.advance(3000); await h.settle(); }
  assert.ok(conn(h, 'b')!.isConnected(), 'B came back on its own loop');
  assert.equal(draftA.isConnected && draftA.value, '# notes\n\nunsaved, still typing', 'and A s draft is still there');
  assert.equal(trees(h.app).length, 2);
});

test('§F unavailable, not substituted: a saved pane ref whose server was REMOVED does not open a same-named pane on the focus; the union shows the removed server nowhere, and the refs of the remaining servers keep their ids', async (context) => {
  // A and B both have `work:1.0`. B's slot names B's pane; B is removed
  // while the app runs; after a reload nothing of B's is resolved on A.
  const rpc = { ...editorRpc, listSessions: async () => [{ name: 'work' }], listSessionsWithPanes: async () => ({ sessions: [{ name: 'work', windows: 1 }], panes: [{ session: 'work', window: 1, pane: 0 }] }) };
  const first = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ v: 2, page: 'terminal', pane: { kind: 'pane', serverId: 'a', session: 'work', target: 'work:1.0' }, splitLayout: 1, splitCells: [] }), parked: JSON.stringify({ v: 2, page: 'terminal', pane: { kind: 'pane', serverId: 'b', session: 'work', target: 'work:1.0' }, splitLayout: 1, splitCells: [] }) }),
    tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc });
  for (let i = 0; i < 8; i++) { await first.app.advance(500); await first.settle(); }
  assert.equal(trees(first.app).length, 2);
  const h1 = { app: first.app, settle: first.settle } as any;
  await toConnection(h1);
  first.app.document.querySelector<HTMLButtonElement>('.preferences .server-list button[aria-label="Remove beta"]')!.click(); await first.settle();
  answerDialog(first.app, /^remove$/iu);
  for (let i = 0; i < 6; i++) { await first.app.advance(300); await first.settle(); }
  const ls = first.app.window.localStorage;
  assert.deepEqual(JSON.parse(ls.getItem('tmux_servers')!).map((e: any) => e.id), ['a'], 'B removed');
  assert.equal(trees(first.app).length, 1, 'B s tree gone');
  assert.equal(first.onScreen(), 'work:1.0', 'A still on ITS work:1.0');
  assert.equal(JSON.parse(ls.getItem('tmux_state::a')!).pane?.serverId, 'a');
  const after = dumpStorage(first.app);
  await first.app.close();
  const second = await bootApp(context, after, undefined, { ...sandbox, rpc });
  for (let i = 0; i < 8; i++) { await second.app.advance(500); await second.settle(); }
  assert.equal(trees(second.app).length, 1, 'only A');
  assert.equal(second.onScreen(), 'work:1.0', 'A s own pane');
  assert.equal(second.app.document.querySelector('.scope-tree .term-side .session.foreign'), null, 'no foreign row for a server that is gone');
  assert.equal(second.app.document.querySelector('.scope-tree .hub-root .sidebar .proj-row.missing'), null, 'and not listed as missing either: it is not included');
});

// ─── #358: the Files page s server door ─────────────────────────────────

test('#358: Files carries the one server door when more than one server is included — it opens App s server popover; picking another server is the ordinary focus move and Files then shows THAT server s own tree', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: { ...twoHubs(), fsList: async (path: string) => ({ path, entries: [{ name: `on-${asking()}.txt`, path: `${path}/on-${asking()}.txt`, type: 'file', size: 1 }] }) } });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  const front = () => h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held)')!;
  const door = () => front().querySelector<HTMLButtonElement>('.files-left .server-door, .server-door');
  assert.ok(door(), 'the door is on the Files page');
  assert.equal(door()!.querySelector('.server-tag')?.textContent, 'alpha', 'named by the one tag rule');
  assert.equal(door()!.getAttribute('aria-haspopup'), 'dialog');
  assert.match([...front().querySelectorAll('.file-row')].map((r) => r.textContent).join('|'), /on-a\.txt/u, 'A s tree');
  door()!.click();
  for (let i = 0; i < 3; i++) await h.settle();
  assert.equal(door()!.getAttribute('aria-expanded'), 'true');
  const popover = h.app.document.querySelector('.server-menu, .pop-layer .server-list, .pop-layer');
  assert.ok(popover, 'App s ONE server popover opened (the rail s and Settings )');
  // Pick B: the ordinary focus move (D2) — no dial, no teardown.
  const dials = events.filter((e) => e.startsWith('dial@')).length;
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.server-menu .sm-pick, .pop-layer .sm-pick')].find((b) => /^beta\b/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) { await h.app.advance(200); await h.settle(); }
  for (let i = 0; i < 6; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'focus moved to B');
  assert.equal(events.filter((e) => e.startsWith('dial@')).length, dials, 'no dial: a focus move');
  assert.equal(trees(h.app).length, 2, 'both trees kept');
  assert.equal(door()!.querySelector('.server-tag')?.textContent, 'beta', 'B s Files, B s door');
  assert.match([...front().querySelectorAll('.file-row')].map((r) => r.textContent).join('|'), /on-b\.txt/u, 'B s own tree — nothing merged');
  assert.doesNotMatch([...front().querySelectorAll('.file-row')].map((r) => r.textContent).join('|'), /on-a\.txt/u);
});

test('#358: each server s Files keeps its OWN parked cwd across the door — A browsed into /dir-a, B into /dir-b, back to A: A is still in /dir-a, B still in /dir-b (D3: one ServerState, one Files memory per server)', async (context) => {
  // Every list answer is stamped with the asking server and the asked path,
  // so a row s text names its source AND its directory.
  const tree = (path: string) => {
    const who = asking();
    if (path === '/') return [{ name: `dir-${who}`, path: `/dir-${who}`, type: 'dir', size: 0 }];
    return [{ name: `leaf-${who}-in${path.replace(/\//gu, '-')}.txt`, path: `${path}/leaf.txt`, type: 'file', size: 1 }];
  };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: { ...twoHubs(), fsCwd: async () => ({ path: '/' }), fsList: async (path: string) => ({ path, entries: tree(path) }) } });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  const front = () => h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held)')!;
  const rows = () => [...front().querySelectorAll('.file-row .file-name')].map((r) => r.textContent).join('|');
  const descend = async (name: string) => {
    [...front().querySelectorAll<HTMLButtonElement>('.file-row .file-main')].find((b) => (b.textContent ?? '').includes(name))!.click();
    for (let i = 0; i < 8; i++) { await h.app.advance(200); await h.settle(); }
  };
  const pickServer358 = async (id: string, label: RegExp) => {
    front().querySelector<HTMLButtonElement>('.server-door')!.click();
    for (let i = 0; i < 3; i++) await h.settle();
    [...h.app.document.querySelectorAll<HTMLButtonElement>('.server-menu .sm-pick, .pop-layer .sm-pick')].find((b) => label.test((b.textContent ?? '').trim()))!.click();
    for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== id; i++) { await h.app.advance(200); await h.settle(); }
    for (let i = 0; i < 6; i++) { await h.app.advance(300); await h.settle(); }
    assert.equal(ls.getItem('tmux_server_current'), id);
  };
  assert.match(rows(), /dir-a/u, `A at its root: ${rows()}`);
  await descend('dir-a');
  assert.match(rows(), /leaf-a-in-dir-a/u, `A now in /dir-a: ${rows()}`);
  await pickServer358('b', /^beta\b/iu);
  assert.match(rows(), /dir-b/u, `B at ITS root — A s navigation did not move B: ${rows()}`);
  assert.doesNotMatch(rows(), /-a-/u, 'nothing of A s in B s list');
  await descend('dir-b');
  assert.match(rows(), /leaf-b-in-dir-b/u, `B now in /dir-b: ${rows()}`);
  await pickServer358('a', /^alpha\b/iu);
  assert.match(rows(), /leaf-a-in-dir-a/u, `back on A: still /dir-a, its own parked cwd: ${rows()}`);
  assert.doesNotMatch(rows(), /-b-/u);
  await pickServer358('b', /^beta\b/iu);
  assert.match(rows(), /leaf-b-in-dir-b/u, `and B still /dir-b: ${rows()}`);
  assert.equal(trees(h.app).length, 2, 'both trees alive throughout — the parked cwd is each instance s own state');
});

test('#358 (phone): the door is the PAGE s, above every view — still there while a file is previewed, so the person reading on A switches to B without walking back to the list (orchestrator 2026-10-13 23:17); reading mode alone hides it', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'mobile',
  }), undefined, { ...sandbox, rpc: { ...twoHubs(), ...editorRpc }, setup(window: any) { window.Element.prototype.getAnimations = () => []; } });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const front = () => h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held)')!;
  const files = () => front().querySelector<HTMLElement>('.files')!;
  assert.ok(front().querySelector('.file-row'), 'the list view');
  assert.equal(files().querySelectorAll('.server-door').length, 1, 'one door');
  assert.equal(files().firstElementChild?.classList.contains('server-door'), true, 'the page s first row, not the list panel s');
  [...front().querySelectorAll<HTMLButtonElement>('.file-row .file-main')].find((b) => (b.textContent ?? '').includes('notes.md'))!.click();
  for (let i = 0; i < 8; i++) { await h.app.advance(200); await h.settle(); }
  assert.ok(front().querySelector('.preview-header'), 'the phone shows the preview alone');
  assert.equal(front().querySelector('.file-row'), null, 'the list panel is gone (single-pane chain)');
  assert.equal(files().querySelectorAll('.server-door').length, 1, 'the SAME door is still on the page');
  assert.equal(files().querySelector('.server-door .server-tag')?.textContent, 'alpha');
});

test('#358 (Single): no server door', async (context) => {
  const h = await bootApp(context, { ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop' }, undefined, { ...sandbox, rpc: { ...twoHubs(), ...editorRpc } });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(h.app.document.querySelector('.server-door'), null, 'Single: no door');
});

test('#358 (Aggregate, one included): no server door — the tag rule, not the mode, decides; including the other brings it', async (context) => {
  const h = await bootApp(context, aggregateOn({ ...twoServers({ live: JSON.stringify({ page: 'files' }), parked: JSON.stringify({ page: 'files' }) }), tmux_layout_mode: 'desktop' }, ['b']), undefined, { ...sandbox, rpc: { ...twoHubs(), ...editorRpc } });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.equal(h.app.document.querySelector('.server-door'), null, 'one included: nothing to switch to');
  await toConnection(h);
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  [...h.app.document.querySelectorAll<HTMLButtonElement>('.rail-btn')].find((b) => /^files$/iu.test((b.getAttribute('aria-label') ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held) .server-door'), 'two included: the door appears');
});

// ─── #335 ③c-3: the Terminal sidebar s sessions union ─────────────────

/** Per-server session lists: A has `work`; B has `work` and `deploy`. */
const twoSessionLists = () => {
  const byServer: Record<string, { sessions: any[]; panes: any[] }> = {
    a: { sessions: [{ name: 'work', windows: 1 }], panes: [{ session: 'work', window: 1, pane: 0 }] },
    b: { sessions: [{ name: 'work', windows: 1 }, { name: 'deploy', windows: 2 }], panes: [{ session: 'work', window: 1, pane: 0 }, { session: 'deploy', window: 1, pane: 0 }, { session: 'deploy', window: 2, pane: 0 }] },
  };
  const mine = () => byServer[asking()] ?? { sessions: [], panes: [] };
  const rpc = {
    listSessionsWithPanes: async () => ({ sessions: [...mine().sessions], panes: [...mine().panes] }),
    listSessions: async () => [...mine().sessions],
    listPanes: async (session: string) => (mine().panes as any[]).filter((p) => p.session === session),
    projectList: async () => ({ projects: [] }),
  };
  return { rpc, byServer };
};
const foreignRows = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .term-side .session.foreign:not(.missing)')]
  .map((r) => `${r.querySelector('.server-tag')?.textContent ?? '-'}:${r.querySelector('.name')?.textContent}`);
const ownRows = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .term-side .session:not(.foreign) .session-row .name')].map((n) => n.textContent);

test('③c-3/P1-C4: the focused Terminal sidebar lists the other included servers sessions as a tagged selector under its own; a hidden member keeps its list CURRENT on the 20 s list cadence and stops when excluded', async (context) => {
  const events: string[] = [];
  const lists = twoSessionLists();
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: lists.rpc });
  for (let i = 0; i < 30 && foreignRows(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(ownRows(h), ['work'], 'A s own list, untagged, as before');
  assert.deepEqual(foreignRows(h), ['beta:work', 'beta:deploy'], 'B s sessions, tagged, below');
  const count = () => events.filter((e) => e === 'rpc@b:listSessionsWithPanes').length;
  const before = count();
  assert.equal(before, 1, 'B s hidden Sessions loaded its list once at join');
  // B gains a session while hidden: within the cadence the selector shows it.
  lists.byServer.b!.sessions.push({ name: 'ci', windows: 1 });
  lists.byServer.b!.panes.push({ session: 'ci', window: 1, pane: 0 });
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  const after = count();
  assert.ok(after - before >= 2 && after - before <= 4, `~3 list refreshes in a minute (the Hub s cadence), not zero and not a hot loop: ${after - before}`);
  assert.deepEqual(foreignRows(h), ['beta:work', 'beta:deploy', 'beta:ci'], 'the new session is in the selector');
  // Exclude B: its tree goes and its list work stops.
  await toConnection(h);
  includeSwitch(h, 'beta')!.click();
  for (let i = 0; i < 6; i++) { await h.app.advance(200); await h.settle(); }
  const mark = count();
  for (let i = 0; i < 12; i++) { await h.app.advance(5000); await h.settle(); }
  assert.equal(count(), mark, 'excluded: no more list refreshes of B');
});

test('P1-C4: a member whose Hub answered the handshake but whose FIRST project list fails stays listed as missing — not as an empty list; a later success lists it; a later failure keeps the last good list and names it unavailable', async (context) => {
  let bListFails = true;
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'hub' }), parked: JSON.stringify({ page: 'hub' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoHubs({ projectList: async () => { if (asking() === 'b' && bListFails) throw new Error('B list failed'); return { projects: asking() === 'b' ? [{ project: { id: 'b-app', name: 'app', session: 'app', path: '/app', room: 'proj:app', updated_at: 9000 }, live: true, slots: [] }] : [{ project: { id: 'a-app', name: 'app', session: 'app', path: '/app', room: 'proj:app', updated_at: 1000 }, live: true, slots: [] }] }; } }) });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  const missing = () => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row.missing .p-name')].map((n) => n.textContent);
  assert.deepEqual(missing(), ['beta'], 'B s Hub is up but its list has not answered: missing');
  assert.deepEqual(sideRows(h), ['alpha:app*'], 'not an empty B list');
  // B's list answers on its next refresh.
  bListFails = false;
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(missing(), []);
  assert.deepEqual(sideRows(h), ['beta:app', 'alpha:app*']);
  // B's list fails again: the last good row stays, muted; B is named.
  bListFails = true;
  for (let i = 0; i < 6; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(sideRows(h), ['beta:app', 'alpha:app*'], 'the last good list is kept');
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held) .hub-root .sidebar .proj-row.unavailable[data-server="b"]'), 'B s row is muted');
  assert.match([...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .hub-root .sidebar .proj-row.missing')].map((r) => r.textContent).join('|'), /beta.*not connected|beta.*未连接/iu, 'B named unavailable');
});

test('P1-C4: another server s sessions are pickable while THIS server s first Projects request still hangs', async (context) => {
  let aHangs = true;
  const lists = twoSessionLists();
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: { ...lists.rpc, projectList: async () => { if (asking() === 'a' && aHangs) await new Promise<void>(() => {}); return { projects: [] }; } } });
  for (let i = 0; i < 30 && foreignRows(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(foreignRows(h), ['beta:work', 'beta:deploy'], 'B s selector is shown though A s Projects never reported');
});

test('③c-3: picking another server s session focuses that server and opens the pane THERE — A s terminal is untouched', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoSessionLists().rpc });
  for (let i = 0; i < 30 && foreignRows(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  const a = conn(h, 'a')!;
  const row = [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .term-side .session.foreign')].find((r) => r.querySelector('.name')?.textContent === 'deploy')!;
  row.querySelector<HTMLElement>('.session-row')!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) await h.settle();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  const front = trees(h.app).find((x) => !x.held)!;
  assert.equal(h.restored(), 'b:deploy:1.0', 'B s record: deploy, as B s own ref');
  assert.ok(a.isConnected() && !a.disposed(), 'A untouched');
  const parkedA = JSON.parse(ls.getItem('tmux_state::a')!);
  assert.equal(parkedA.pane?.target, 'work:1.0', 'A s own terminal still on work');
  assert.ok(front, 'B in front');
  // B s sidebar now lists A s sessions as the foreign section.
  for (let i = 0; i < 20 && foreignRows(h).length < 1; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(foreignRows(h), ['alpha:work']);
});

test('③c-3: Single lists no other servers', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, { ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'desktop' }, undefined, { ...sandbox, calls: events, rpc: twoSessionLists().rpc });
  for (let i = 0; i < 6; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(foreignRows(h), []);
  assert.equal(h.app.document.querySelector('.term-side .group-label .server-tag'), null);
});

// ─── #357: Board and Terminal lists are the union too ─────────────────────
// Owner 2026-10-13 22:34: "在 Terminal 页面和 Board 页面，都没有整合两种或几种
// 不同连接里的所有项目." The Board's sidebar is the Hub's projection
// (`createProjectsUnion`, one merge); the phone's Terminal picker lists the
// other servers' sessions IN its main list.
const twoBoards = () => {
  const cnt = (total: number) => ({ todo: total, doing: 0, review: 0, done: 0, total });
  const proj = (id: string, name: string, at: number) => ({ project: { id, name, session: name, path: `/${name}`, room: `proj:${name}`, updated_at: at }, live: true, slots: [] });
  const byServer: Record<string, { projects: unknown[]; rooms: Record<string, number>; counts: Record<string, unknown> }> = {
    a: { projects: [proj('a-app', 'app', 1000), proj('a-empty', 'empty', 500)], rooms: { 'proj:app': 1000, 'proj:empty': 500 }, counts: { app: cnt(2), empty: cnt(0) } },
    b: { projects: [proj('b-ops', 'ops', 9000), proj('b-app', 'app', 50)], rooms: { 'proj:ops': 9000, 'proj:app': 50 }, counts: { ops: cnt(3), app: cnt(1) } },
  };
  const mine = () => byServer[asking()] ?? { projects: [], rooms: {}, counts: {} };
  return {
    byServer,
    counts: () => mine().counts,
    rpc: {
      ...oneRoomHub(),
      projectList: async () => ({ projects: mine().projects }),
      hubRooms: async () => ({ rooms: mine().rooms, states: {} }),
      boardCounts: async () => ({ counts: mine().counts }),
      boardList: async (session: string) => ({ issues: [{ id: 1, title: `${asking()} ${session} issue`, body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] }], statuses: ['todo', 'doing', 'review', 'done'] }),
      boardGet: async () => ({ id: 1, title: 'x', body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] }),
      listSessionsWithPanes: async () => ({ sessions: [], panes: [] }),
    },
  };
};
const boardRowsOf = (h: Awaited<ReturnType<typeof bootApp>>) => boardRows(h).join(',');
const boardRows = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row:not(.mirror):not(.missing)')]
  .map((r) => `${r.querySelector('.server-tag')?.textContent ?? '-'}:${r.querySelector('.p-name')?.textContent}${r.classList.contains('open') ? '*' : ''}`);

test('#357 (Board): the sidebar is the UNION of every included server s boards — merged by the one rule on each server s clock, each row tagged (on its own line) and filtered by ITS server s counts; missing while a server has not answered', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: twoBoards().rpc });
  for (let i = 0; i < 30 && boardRows(h).length < 3; i++) { await h.app.advance(500); await h.settle(); }
  // B s ops (9000) first, A s app (1000), B s app (50); A s `empty` board has
  // no issues and is hidden by A s counts; B s `app` (total 1) is shown by B s.
  assert.deepEqual(boardRows(h), ['beta:ops', 'alpha:app*', 'beta:app'], `the union, A s board open: ${boardRows(h).join(',')}`);
  const row = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row[data-server="b"]')!;
  assert.equal(row.querySelector('.p-top .server-tag'), null, 'the tag is not on the identity line (#360 grammar)');
  assert.ok(row.querySelector('.p-source .server-tag'), 'the tag on its own line');
  assert.ok(row.classList.contains('foreign'));
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .board-root .page-head .server-tag')?.textContent, 'alpha', 'the body is A s (D3)');
  const stack = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .board-root .page-head .title-stack')!;
  assert.deepEqual([...stack.children].map((c) => c.classList.contains('name-line') ? 'name-line' : c.classList.contains('server-tag') ? 'server-tag' : c.tagName), ['name-line', 'server-tag'], 'the Hub head s Name + tag stack: name line, then the tag');
  assert.match(stack.querySelector('.name-line h1')?.textContent ?? '', /app/u);
});

test('#357 (Board): picking another server s board focuses that server (D2, no dial) and lands on THAT project s board; the body is then B s', async (context) => {
  const events: string[] = [];
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, calls: events, rpc: twoBoards().rpc });
  for (let i = 0; i < 30 && boardRows(h).length < 3; i++) { await h.app.advance(500); await h.settle(); }
  const ls = h.app.window.localStorage;
  const dials = events.filter((e) => e.startsWith('dial@')).length;
  [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row[data-server="b"]')].find((r) => r.querySelector('.p-name')?.textContent === 'ops')!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) { await h.app.advance(200); await h.settle(); }
  for (let i = 0; i < 8; i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'focus moved to B');
  assert.equal(events.filter((e) => e.startsWith('dial@')).length, dials, 'no dial: a focus move');
  assert.equal(trees(h.app).length, 2, 'both trees kept');
  for (let i = 0; i < 20 && !boardRows(h).includes('beta:ops*'); i++) { await h.app.advance(300); await h.settle(); }
  assert.deepEqual(boardRows(h), ['beta:ops', 'alpha:app', 'beta:app'].map((r) => r === 'beta:ops' ? 'beta:ops*' : r), `the same union from B s Board, ops open: ${boardRows(h).join(',')}`);
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .board-root .page-head .server-tag')?.textContent, 'beta', 'B s body (D3)');
  assert.match(h.app.document.querySelector('.scope-tree:not(.held) .board-root .page-head h1')?.textContent ?? '', /ops/u, 'landed on ops');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .board-root .issue-detail, .scope-tree:not(.held) .board-root .detail'), null, 'a landing opens no issue');
});

test('#357 (Board, P1-A): a boardCounts failure is NOT an answer — B is missing until BOTH reads succeed, then its rows appear; a later failure keeps the last complete list, muted, and names B unavailable (through the real Board producer)', async (context) => {
  const boards = twoBoards();
  let bCountsFail = true;
  const rpc = { ...boards.rpc, boardCounts: async () => {
    if (asking() === 'b' && bCountsFail) throw new Error('B counts failed');
    return { counts: boards.counts() };
  } };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc });
  const missing = () => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row.missing')].map((r) => r.textContent!.replace(/\s+/gu, ' ').trim());
  for (let i = 0; i < 30 && !boardRows(h).includes('-:app*') && !boardRows(h).some((r) => r.endsWith(':app*')); i++) { await h.app.advance(500); await h.settle(); }
  // B's projectList answered, its counts did not: A's boards only, and B is SAID to be missing.
  assert.deepEqual(boardRows(h), ['alpha:app*'], `B contributes nothing yet: ${boardRows(h).join(',')}`);
  assert.equal(missing().length, 1, `B is named: ${missing().join('|')}`);
  assert.match(missing()[0]!, /beta.*no list yet/u, 'first failure = NO LIST YET (unknown), not "not connected"');
  // B recovers within the 20 s cadence: its rows appear, the missing row goes.
  bCountsFail = false;
  for (let i = 0; i < 12 && boardRows(h).length < 3; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(boardRows(h), ['beta:ops', 'alpha:app*', 'beta:app'], `B s rows appear: ${boardRows(h).join(',')}`);
  assert.deepEqual(missing(), [], 'no longer missing');
  // A later failure: the last complete list stays, muted; B is named unavailable.
  bCountsFail = true;
  for (let i = 0; i < 12 && missing().length < 1; i++) { await h.app.advance(5000); await h.settle(); }
  assert.deepEqual(boardRows(h), ['beta:ops', 'alpha:app*', 'beta:app'], `the last complete list is kept: ${boardRows(h).join(',')}`);
  assert.equal(missing().length, 1, `B named unavailable: ${missing().join('|')}`);
  assert.match(missing()[0]!, /beta.*not connected/u, 'a later failure = not connected, with the last list kept');
  const bRows = [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row[data-server="b"]:not(.missing)')];
  assert.ok(bRows.length === 2 && bRows.every((r) => r.classList.contains('unavailable')), 'B s kept rows wear the Hub s muted style');
  const aRow = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .board-root .sidebar .proj-row[data-server="a"]:not(.missing)')!;
  assert.ok(!aRow.classList.contains('unavailable'), 'A is untouched');
});

// P1-B (reviewer on 390ba4dd): a cross-server pick aimed at a board whose own
// request is RUNNING was consumed on arrival and dropped by the guard — the
// focus had moved to B, but the board the person chose never opened.
async function pendingSaveOnB(context: any) {
  const boards = twoBoards();
  const saves: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const rpc = { ...boards.rpc,
    boardSave: async (session: string) => { saves.push(`${asking()}:${session}`); await held; return { id: 1 }; },
    boardList: async (session: string) => ({ issues: [{ id: 1, title: `${asking()} ${session} issue`, body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] }], statuses: ['todo', 'doing', 'review', 'done'] }),
    boardGet: async (session: string) => ({ id: 1, title: `${asking()} ${session} issue`, body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] }),
  };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc });
  const ls = h.app.window.localStorage;
  const settleFor = async (n: number) => { for (let i = 0; i < n; i++) { await h.app.advance(300); await h.settle(); } };
  const front = () => h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .board-root')!;
  const open = () => boardRows(h).find((r) => r.endsWith('*'));
  const pickB = async (name: string) => {
    [...front().querySelectorAll<HTMLElement>('.sidebar .proj-row[data-server="b"]:not(.missing)')].find((r) => r.querySelector('.p-name')?.textContent === name)!.click();
    for (let i = 0; i < 12 && ls.getItem('tmux_server_current') !== 'b'; i++) await settleFor(1);
    await settleFor(6);
  };
  for (let i = 0; i < 30 && boardRows(h).length < 3; i++) { await h.app.advance(500); await h.settle(); }
  // B s ops board, an issue edited and its Save left running.
  await pickB('ops');
  assert.equal(open(), 'beta:ops*', `B on ops: ${boardRows(h).join(',')}`);
  front().querySelector<HTMLElement>('.card')!.click();
  await settleFor(4);
  const title = front().querySelector<HTMLInputElement>('.d-title-input')!;
  title.value = 'edited title'; title.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
  await settleFor(2);
  front().querySelector<HTMLButtonElement>('button.go[aria-label="Save"]')!.click();
  await settleFor(3);
  assert.deepEqual(saves, ['b:ops'], 'the save is running on B s ops board');
  return { h, saves, release: () => release(), pickB, open, settleFor, front, ls };
}

test('#357 (Board, P1-B): picking another board of B from A while B is mid-save moves the focus AND the chosen board opens once the save is done — the old save applies to its own board', async (context) => {
  const f = await pendingSaveOnB(context);
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  assert.equal(f.ls.getItem('tmux_server_current'), 'a');
  await f.pickB('app');
  assert.equal(f.ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  assert.equal(f.open(), 'beta:ops*', 'B is still committing ops: nothing leaves under the running request');
  f.release();
  await f.settleFor(12);
  assert.equal(f.open(), 'beta:app*', `the chosen board opens after the save: ${boardRowsOf(f.h)}`);
  assert.deepEqual(f.saves, ['b:ops'], 'the old save ran once, on its own board');
});

test('#357 (Board, P1-B): a newer pick replaces an older held one — the person s LAST choice is where B ends', async (context) => {
  const f = await pendingSaveOnB(context);
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  await f.pickB('app');                       // held: B is committing
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  await f.pickB('ops');                       // newer; same board B is on
  f.release();
  await f.settleFor(12);
  assert.equal(f.open(), 'beta:ops*', `the newest choice wins, the older (app) is void: ${boardRowsOf(f.h)}`);
});

// P2 (reviewer on 390ba4dd): an id-0 landing is "that project's board LIST".
// When the target already sits in an issue DETAIL of that same project, the
// detail is left through the existing guard — clean: straight to the list;
// dirty: the Keep/Discard dialog, Keep leaves everything as it was.
async function detailOnB(context: any) {
  const boards = twoBoards();
  const issue = (session: string) => ({ id: 1, title: `${asking()} ${session} issue`, body: '', status: 'todo', assignee: '', editable: true, created_at: 1, updated_at: 1, notes: [] });
  const rpc = { ...boards.rpc,
    boardList: async (session: string) => ({ issues: [issue(session)], statuses: ['todo', 'doing', 'review', 'done'] }),
    boardGet: async (session: string) => issue(session) };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc });
  const ls = h.app.window.localStorage;
  const settleFor = async (n: number) => { for (let i = 0; i < n; i++) { await h.app.advance(300); await h.settle(); } };
  const front = () => h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .board-root')!;
  const pickB = async (name: string) => {
    [...front().querySelectorAll<HTMLElement>('.sidebar .proj-row[data-server="b"]:not(.missing)')].find((r) => r.querySelector('.p-name')?.textContent === name)!.click();
    for (let i = 0; i < 12 && ls.getItem('tmux_server_current') !== 'b'; i++) await settleFor(1);
    await settleFor(6);
  };
  for (let i = 0; i < 30 && boardRows(h).length < 3; i++) { await h.app.advance(500); await h.settle(); }
  await pickB('ops');
  front().querySelector<HTMLElement>('.card')!.click();
  await settleFor(4);
  assert.ok(front().querySelector('.detail'), 'B s ops board is in an issue detail');
  return { h, ls, settleFor, front, pickB, detail: () => !!front().querySelector('.detail'), dirty: async () => {
    const title = front().querySelector<HTMLInputElement>('.d-title-input')!;
    title.value = 'unsaved edit'; title.dispatchEvent(new h.app.window.Event('input', { bubbles: true }));
    await settleFor(2);
  } };
}

test('#357 (Board, id 0): picking B s SAME board from A while B sits in a clean issue detail lands on the board LIST — the detail is left', async (context) => {
  const f = await detailOnB(context);
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  await f.pickB('ops');
  assert.equal(f.detail(), false, 'the detail is gone: the landing is the list');
  assert.equal(boardRows(f.h).find((r) => r.endsWith('*')), 'beta:ops*');
});

test('#357 (Board, id 0): with an UNSAVED edit in that detail the existing Keep/Discard dialog stands in between — Keep leaves the draft as it was, Discard lands on the list', async (context) => {
  const f = await detailOnB(context);
  await f.dirty();
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  await f.pickB('ops');
  assert.ok(f.h.app.document.querySelector('[role=alertdialog]'), 'the guard asks');
  answerDialog(f.h.app, /keep editing/iu);
  await f.settleFor(4);
  assert.equal(f.h.app.document.querySelector('[role=alertdialog]'), null);
  assert.equal(f.detail(), true, 'Keep: still in the detail');
  assert.equal(f.front().querySelector<HTMLInputElement>('.d-title-input')!.value, 'unsaved edit', 'and the draft is untouched');
});

test('#357 (Board, id 0): Discard on that dialog drops the draft and lands on the board list', async (context) => {
  const f = await detailOnB(context);
  await f.dirty();
  await pickServer(f.h, 'alpha');
  await f.settleFor(6);
  await f.pickB('ops');
  answerDialog(f.h.app, /discard/iu);
  await f.settleFor(4);
  assert.equal(f.detail(), false, 'Discard: the list');
});

test('#357 (Board): the width ghost carries the widest count of ALL rendered rows — B s 1200 prices the chips even though A s own counts are tiny', async (context) => {
  const boards = twoBoards();
  boards.byServer.b!.counts = { ops: { todo: 1200, doing: 0, review: 0, done: 0, total: 1200 }, app: { todo: 1, doing: 0, review: 0, done: 0, total: 1 } };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: boards.rpc });
  for (let i = 0; i < 30 && boardRows(h).length < 3; i++) { await h.app.advance(500); await h.settle(); }
  const ghost = h.app.document.querySelector('.scope-tree:not(.held) .board-root .sidebar .proj-row.mirror .b-count');
  assert.equal(ghost?.textContent, '1200', 'A is focused with counts of 2; the ghost is priced by B s 1200');
});

test('#357 (Board, Single): one server s boards, untagged, no source line — as before', async (context) => {
  const h = await bootApp(context, { ...twoServers({ live: JSON.stringify({ page: 'board' }), parked: JSON.stringify({ page: 'board' }) }), tmux_layout_mode: 'desktop' }, undefined, { ...sandbox, rpc: twoBoards().rpc });
  for (let i = 0; i < 12; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(boardRows(h), ['-:app*'], 'A s one non-empty board, no tag');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .board-root .sidebar .p-source'), null);
});

const inlineForeign = (h: Awaited<ReturnType<typeof bootApp>>) => [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .term-side .proj-row.foreign')]
  .map((r) => `${r.querySelector('.p-source .server-tag')?.textContent ?? '-'}:${r.querySelector('.p-name')?.textContent}`);

test('#357 (Terminal, phone): the other servers sessions are IN the main list under this server s projects, tagged on their own line — no separate bottom section; pick = focus + open there', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'mobile',
  }), undefined, { ...sandbox, rpc: { ...oneRoomHub(), ...twoSessionLists().rpc,
    // A s `work` is a PROJECT here, so the PROJECTS section renders and the
    // order claim below is about real rows.
    projectList: async () => ({ projects: asking() === 'a'
      ? [{ project: { id: 'a-work', name: 'work', session: 'work', path: '/work', room: 'proj:work', updated_at: 1 }, live: true, slots: [] }]
      : [{ project: { id: 'b-deploy', name: 'Deploy', session: 'deploy', path: '/deploy', room: 'proj:deploy', updated_at: 5 }, live: true, slots: [] }] }),
    hubRooms: async () => ({ rooms: {}, states: {} }),
  }, setup(window: any) {
    // The phone's picker is the SHEET form: App's `.side-sheet` condition is
    // touch + the 760px viewport query, which the harness answers here.
    const mm = window.matchMedia;
    window.matchMedia = (q: string) => Object.assign(mm(q), { matches: /760px/u.test(q) });
    window.Element.prototype.getAnimations = () => [];
  } });
  for (let i = 0; i < 30 && inlineForeign(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(inlineForeign(h), ['beta:work', 'beta:Deploy'], 'B s sessions as rows of the main list — a declared project by its NAME (the local row s identity), a bare session by its session');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .term-side .foreign-rows'), null, 'no "Other servers" section on the phone');
  // Open the sheet as a person does on the phone — the Back gesture at the
  // Terminal s floor lifts the drawer (board #58). This server s PROJECTS
  // section loads on show and heads the list.
  const openSheet = async () => {
    h.app.window.dispatchEvent(new h.app.window.PopStateEvent('popstate', { state: { app: true } }));
    for (let i = 0; i < 12 && !h.app.document.querySelector('.scope-tree:not(.held) .term-side .projects'); i++) { await h.app.advance(300); await h.settle(); }
  };
  await openSheet();
  assert.ok(h.app.document.querySelector('.scope-tree:not(.held) .term-side.open'), 'the sheet is open');
  const side = h.app.document.querySelector<HTMLElement>('.scope-tree:not(.held) .term-side .list')!;
  const order = [...side.querySelectorAll<HTMLElement>('.projects, .proj-row.foreign')].map((el) => el.classList.contains('foreign') ? 'foreign' : 'projects');
  assert.equal(order[0], 'projects', 'this server s projects section first');
  assert.ok(order.indexOf('foreign') > 0 && order.lastIndexOf('projects') < order.indexOf('foreign'), 'the foreign rows follow it, in the same list');
  const ls = h.app.window.localStorage;
  [...h.app.document.querySelectorAll<HTMLElement>('.scope-tree:not(.held) .term-side .proj-row.foreign')].find((r) => r.querySelector('.p-name')?.textContent === 'Deploy')!.click();
  for (let i = 0; i < 10 && ls.getItem('tmux_server_current') !== 'b'; i++) await h.settle();
  for (let i = 0; i < 4; i++) await h.settle();
  assert.equal(ls.getItem('tmux_server_current'), 'b', 'the focus moved to B');
  assert.equal(h.restored(), 'b:deploy:1.0', 'opened THERE, by the SESSION — never by the label');
  assert.equal(h.app.document.querySelector('.scope-tree:not(.held) .term-side.open'), null, 'the pick closed the sheet');
  for (let i = 0; i < 20 && inlineForeign(h).length < 1; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(inlineForeign(h), ['alpha:work'], 'B s picker now lists A s session inline');
});

test('#357 (Terminal, phone): with another server s sessions listed, an empty THIS server says "No sessions on this server" — never a bare "No sessions" above a B row', async (context) => {
  const lists = twoSessionLists();
  lists.byServer.a = { sessions: [], panes: [] };
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: JSON.stringify({ page: 'terminal' }), parked: JSON.stringify({ page: 'terminal' }) }), tmux_layout_mode: 'mobile',
  }), undefined, { ...sandbox, rpc: { ...oneRoomHub(), ...lists.rpc, projectList: async () => ({ projects: [] }), hubRooms: async () => ({ rooms: {}, states: {} }) }, setup(window: any) {
    const mm = window.matchMedia;
    window.matchMedia = (q: string) => Object.assign(mm(q), { matches: /760px/u.test(q) });
    window.Element.prototype.getAnimations = () => [];
  } });
  for (let i = 0; i < 30 && inlineForeign(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  const empty = () => h.app.document.querySelector('.scope-tree:not(.held) .term-side .empty')?.textContent?.trim();
  assert.deepEqual(inlineForeign(h), ['beta:work', 'beta:deploy'], 'B s sessions are listed');
  // The sheet opens as a person opens it (the Back gesture at the floor), so
  // this server s Projects reports and the list stops being "not asked yet".
  h.app.window.dispatchEvent(new h.app.window.PopStateEvent('popstate', { state: { app: true } }));
  for (let i = 0; i < 12 && !empty(); i++) { await h.app.advance(300); await h.settle(); }
  assert.equal(empty(), 'No sessions on this server', `the claim is about THIS server: ${empty()}`);
});

test('#357 (Terminal, desktop): the sidebar keeps its "Other servers" group — the tall column reads whole and the grouping tells the two apart', async (context) => {
  const h = await bootApp(context, aggregateOn({
    ...twoServers({ live: legacyNav('work:1.0'), parked: legacyNav('work:1.0') }), tmux_layout_mode: 'desktop',
  }), undefined, { ...sandbox, rpc: { ...oneRoomHub(), ...twoSessionLists().rpc,
    projectList: async () => ({ projects: asking() === 'b' ? [{ project: { id: 'b-deploy', name: 'Deploy', session: 'deploy', path: '/deploy', room: 'proj:deploy', updated_at: 5 }, live: true, slots: [] }] : [] }),
    hubRooms: async () => ({ rooms: {}, states: {} }) } });
  for (let i = 0; i < 30 && foreignRows(h).length < 2; i++) { await h.app.advance(500); await h.settle(); }
  assert.deepEqual(foreignRows(h), ['beta:work', 'beta:Deploy'], 'the grouped section shows the project NAME too');
  assert.equal(inlineForeign(h).length, 0, 'no inline rows on the desktop');
});
