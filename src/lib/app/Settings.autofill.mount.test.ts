import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { removeServer } from './servers.ts';

// Board #323 (reviewer P1): the desktop app fills this machine's gateway
// into Settings — and its token/socket NEVER end up next to another
// server's address. The real Settings, a desktop platform, and a
// get_local_config whose answer the test releases when it wants. The shell
// is the real platform detection (a `__TAURI__` global, desktop UA).
const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/clipboard.ts', import.meta.url),
]);

const LOCAL = { url: 'ws://[::1]:19900', token: 'LOCAL-TOKEN', tmux_socket: '/local/sock', host: '::', port: 19900 };
const ADDR = 'input[placeholder="ws://host:port"]';
const TOKEN = 'input[placeholder="auth token"]';
const SOCKET = 'input[placeholder="/tmp/tmux-1000/default"]';

/** Saved servers (the registry is the only list the form suggests from, #400). */
const saved = (...servers: { address: string; token: string }[]) => ({
  tmux_servers: JSON.stringify(servers.map((s, i) => ({ id: `s${i}`, name: `s${i}`, address: s.address, token: s.token }))),
});

async function mount(context: TestContext, saved: Record<string, string>, userAgent?: string) {
  const calls: string[] = [];
  let release!: (cfg: typeof LOCAL) => void;
  const answer = new Promise<typeof LOCAL>(yes => { release = yes; });
  const app = await (await compiled).mount(context, {
    props: { onConnected() {} },
    modules: [
      { copyText: () => true },
    ],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      for (const [k, v] of Object.entries(saved)) window.localStorage.setItem(k, v);
      if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent });
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: { invoke: (cmd: string) => { calls.push(cmd); return cmd === 'get_local_config' ? answer : Promise.reject(new Error(cmd)); } },
      };
    },
  });
  const field = (sel: string) => app.document.querySelector<HTMLInputElement>(sel)!;
  return {
    ...app,
    calls,
    value: (sel: string) => field(sel).value,
    async edit(sel: string, value: string) {
      field(sel).value = value;
      field(sel).dispatchEvent(new app.window.Event('input', { bubbles: true }));
      await app.flush();
    },
    async pick(address: string) {
      app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
      await app.flush();
      const row = [...app.document.querySelectorAll<HTMLButtonElement>('.hist-item')].find(b => b.textContent === address);
      assert.ok(row, `the suggestions have ${address}`);
      row!.click();
      await app.flush();
    },
    async answer() {
      release(LOCAL);
      for (let i = 0; i < 6; i++) await app.flush();
    },
  };
}

test('a fresh desktop app is filled with this machine\'s gateway', async context => {
  const app = await mount(context, {});
  await app.answer();
  assert.equal(app.value(ADDR), LOCAL.url);
  assert.equal(app.value(TOKEN), LOCAL.token);
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket);
});

test('a saved remote address with no token gets no local token or socket', async context => {
  const app = await mount(context, { tmux_address: 'ws://remote.example:9899' });
  await app.answer();
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '');
  assert.equal(app.value(SOCKET), '');
});

test('a remote address typed while the config loads gets no local credentials', async context => {
  const app = await mount(context, {});
  await app.edit(ADDR, 'ws://remote.example:9899');
  await app.answer();
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '');
  assert.equal(app.value(SOCKET), '');
});

test('auto-filled local credentials do not follow the address to a remote; typed ones stay', async context => {
  const app = await mount(context, {});
  await app.answer();
  assert.equal(app.value(TOKEN), LOCAL.token);
  await app.edit(ADDR, 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '', 'the local token is gone');
  assert.equal(app.value(SOCKET), '', 'the local socket is gone');
  await app.edit(TOKEN, 'REMOTE-TOKEN');
  await app.edit(ADDR, 'ws://other.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN', 'what the person typed is never cleared');
});

test('the Android app never fills a phone with its own loopback config', async context => {
  const app = await mount(context, {}, 'Mozilla/5.0 (Linux; Android 14) AppleWebKit');
  await app.answer();
  assert.deepEqual(app.calls, [], 'get_local_config is not even asked');
  assert.equal(app.value(TOKEN), '');
});

test('a pick keeps its own token, and the auto-filled local socket does not follow it', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN' },
    { address: 'ws://other.example:9899', token: '' },
  ));
  await app.answer();
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'filled for the local gateway');
  await app.pick('ws://remote.example:9899');
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN', "the entry's own token stays");
  assert.equal(app.value(SOCKET), '', 'the local socket does not ride along to the remote');
});

test('picking the local gateway from the suggestions keeps its socket', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN' },
    { address: LOCAL.url, token: 'OLD-LOCAL-TOKEN' },
  ));
  await app.answer();
  await app.pick(LOCAL.url);
  assert.equal(app.value(TOKEN), 'OLD-LOCAL-TOKEN', "the entry's token is the person's choice");
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'still the local gateway: its socket stays');
  await app.pick('ws://remote.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN');
  assert.equal(app.value(SOCKET), '', 'then a remote pick: the local socket still does not follow');
});

test('the suggestions are the saved servers, re-read each time the list opens, and a row has no forget button (#400)', async context => {
  const app = await mount(context, {
    ...saved(
      { address: 'ws://one.example:9899', token: 'ONE' },
      { address: 'ws://two.example:9899', token: 'TWO' },
      { address: 'ws://three.example:9899', token: 'THREE' },
    ),
    tmux_server_current: 's0',
    // Left over from before the registry was the only list: not offered.
    tmux_address_history: JSON.stringify([{ address: 'ws://stale.example:9899', token: 'STALE' }]),
  });
  const rows = async () => {
    app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
    await app.flush();
    const out = [...app.document.querySelectorAll('.hist-item')].map(b => b.textContent);
    const forget = app.document.querySelector('.hist-del');
    app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
    await app.flush();
    assert.equal(forget, null, 'forgetting is Settings › Connection\u2019s, not the form\u2019s');
    return out;
  };
  assert.deepEqual(await rows(), ['ws://one.example:9899', 'ws://two.example:9899', 'ws://three.example:9899']);
  // Another page deletes a server while this form stays mounted.
  removeServer(app.window.localStorage, 's1');
  assert.deepEqual(await rows(), ['ws://one.example:9899', 'ws://three.example:9899']);
});
