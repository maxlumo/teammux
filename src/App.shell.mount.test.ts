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
]);

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
    modules: [asModule(transport(calls))],
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
    modules: [asModule(liveTransport(calls, () => 'm-a'))],
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
