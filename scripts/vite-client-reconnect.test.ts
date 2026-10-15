// The dev-client patch RUN, not read (board #393, reviewer P1-A on 08293c0e).
//
// vite.config.js patches Vite's own dev client (`quietDevReconnect`) so a lost HMR
// socket reconnects instead of ending in location.reload(). The string tests in
// vite-config.test.ts prove the text is where it should be; this file executes the
// real, patched client.mjs of the installed Vite in Node against a fake WebSocket,
// fetch, document and location, with mocked timers, and drives the sequences that
// matter on Vite's REAL transport state machine:
//
//   ping answers -> the first HMR dial FAILS -> the same server comes back
//
// must re-dial the page's own proxied address (never the server's direct one),
// deliver later hot updates to the modules registered BEFORE the drop, and recover
// a second drop too; the old transport's ping timer must be gone; a failed dial is
// not evidence of a restart (only a changed server identity is), and only a
// confirmed restart reloads a page on the loopback. The UNPATCHED client is run
// through the first sequence as the control: it reloads, so the harness is faithful.
//
// This file replaces globals (WebSocket, fetch, document, location, timers): it is
// its own file so `node --test` gives it its own process.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quietDevReconnect } from '../vite.config.js';

const CLIENT = new URL('../node_modules/vite/dist/client/client.mjs', import.meta.url);
const PAGE = 'http://app.test:5173/@vite/client';
const PROXIED = 'ws://app.test:5173/?token=tok-A';
const DIRECT = 'ws://localhost:5173/?token=tok-A';

/** What Vite's clientInjections plugin does to the served client, for a default config. */
function served(): string {
  const values: Record<string, string> = {
    __BASE__: '"/"', __HMR_CONFIG_NAME__: '"vite.config.js"', __SERVER_HOST__: '"app.test:5173/"',
    __HMR_PROTOCOL__: 'null', __HMR_HOSTNAME__: 'null', __HMR_PORT__: 'null',
    __HMR_DIRECT_TARGET__: '"localhost:5173/"', __HMR_BASE__: '"/"', __HMR_TIMEOUT__: '30000',
    __HMR_ENABLE_OVERLAY__: 'true', __WS_TOKEN__: '"tok-A"',
  };
  let code = readFileSync(CLIENT, 'utf8');
  for (const [name, value] of Object.entries(values)) code = code.replaceAll(name, value);
  // `@vite/env` only seeds `define` globals (none in a default config); it is a virtual module.
  return code.replace("import '@vite/env';", '').replaceAll('import.meta.url', JSON.stringify(PAGE));
}

type Listener = { fn: (e: any) => void; once: boolean };

function makeWorld(context: TestContext, hostname: string) {
  const world: any = {
    sockets: [] as any[], reloads: 0, logs: [] as string[], token: 'tok-A', serverUp: true, fetchThrows: false, fetchHangs: false, fetches: 0,
    // What the server does with each HMR dial: 'open' | 'refuse'. Default: open.
    hmrDial: (_socket: any) => 'open',
    liveIntervals: new Set<unknown>(),
  };
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0; sent: string[] = []; listeners: Record<string, Listener[]> = {};
    url: string; protocol: string;
    constructor(url: string, protocol: string) {
      this.url = String(url); this.protocol = protocol; world.sockets.push(this);
      queueMicrotask(() => {
        const answer = protocol === 'vite-ping' ? (world.serverUp ? 'open' : 'refuse') : world.hmrDial(this);
        if (answer === 'open') this.serverOpen(); else if (answer === 'refuse') this.serverRefuse(); // 'hang': neither, until the test says

      });
    }
    addEventListener(type: string, fn: (e: any) => void, options?: { once?: boolean }) { (this.listeners[type] ??= []).push({ fn, once: !!options?.once }); }
    removeEventListener(type: string, fn: (e: any) => void) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn); }
    dispatch(type: string, event: any = {}) {
      for (const l of [...(this.listeners[type] ?? [])]) { if (l.once) this.removeEventListener(type, l.fn); l.fn(event); }
    }
    send(data: string) { this.sent.push(data); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatch('close', { wasClean: true }); }
    serverOpen() { this.readyState = 1; this.dispatch('open'); }
    serverMessage(payload: unknown) { this.dispatch('message', { data: JSON.stringify(payload) }); }
    serverDrop() { this.readyState = 3; this.dispatch('close', { wasClean: false }); }
    serverRefuse() { this.readyState = 3; this.dispatch('error'); this.dispatch('close', { wasClean: false }); }
  }
  const g = globalThis as any;
  const saved = { WebSocket: g.WebSocket, fetch: g.fetch, document: g.document, window: g.window, location: g.location, setInterval: g.setInterval, clearInterval: g.clearInterval, console: g.console };
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const mockSetInterval = g.setInterval, mockClearInterval = g.clearInterval;
  g.setInterval = (fn: () => void, ms: number) => { const id = mockSetInterval(fn, ms); world.liveIntervals.add(id); return id; };
  g.clearInterval = (id: unknown) => { world.liveIntervals.delete(id); return mockClearInterval(id); };
  g.WebSocket = FakeWebSocket;
  g.fetch = (_url: string, init?: { signal?: AbortSignal }) => {
    world.fetches++;
    if (world.fetchThrows) return Promise.reject(new Error('network down'));
    if (world.fetchHangs) {
      // A pending response: it ends only when the client’s own deadline aborts it.
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve({ ok: true, text: async () => `const x = 1;\nconst wsToken = "${world.token}";\n` });
  };
  g.document = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  g.window = { addEventListener() {} };
  g.location = { hostname, reload: () => { world.reloads++; } };
  const quiet = (kind: string) => (...args: unknown[]) => { world.logs.push(`${kind}: ${args.map(String).join(' ')}`); };
  g.console = { ...saved.console, log: quiet('log'), info: quiet('info'), debug: quiet('debug'), error: quiet('error'), warn: quiet('warn') };
  context.after(() => { for (const [k, v] of Object.entries(saved)) g[k] = v; });
  return world;
}

/** Let promise chains run. */
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

/** Advance the mocked clock in small steps until `done()`, up to `maxMs`. */
async function until(context: TestContext, done: () => boolean, maxMs = 120000, step = 50) {
  let t = 0;
  for (; t <= maxMs && !done(); t += step) { await settle(); context.mock.timers.tick(step); }
  await settle();
  return t;
}

let counter = 0;
async function loadClient(context: TestContext, patched: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'tmm-vite-client-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = served();
  const code = patched ? (quietDevReconnect().transform(raw, '/x/node_modules/vite/dist/client/client.mjs') as string) : raw;
  const file = join(dir, 'client.mjs');
  writeFileSync(file, code);
  return import(`${pathToFileURL(file).href}?n=${++counter}`);
}

const hmrUrls = (world: any) => world.sockets.filter((s: any) => s.protocol === 'vite-hmr').map((s: any) => s.url);
const newest = (world: any) => world.sockets.filter((s: any) => s.protocol === 'vite-hmr').at(-1);

test('ping answers, the FIRST HMR dial fails, the same server comes back: it reconnects to the page’s own address, later hot updates still arrive, a second drop recovers, the old timers are gone (#393 P1-A)', async (context) => {
  const world = makeWorld(context, 'app.example');
  const client = await loadClient(context, true);
  await settle();
  assert.deepEqual(hmrUrls(world), [PROXIED], 'the page dials its own proxied address first');
  newest(world).serverMessage({ type: 'connected' });

  // A module registered BEFORE the drop listens for a hot event.
  const seen: unknown[] = [];
  const hot = client.createHotContext('/m.js');
  hot.on('app:event', (data: unknown) => seen.push(data));
  newest(world).serverMessage({ type: 'custom', event: 'app:event', data: 1 });
  await settle();
  assert.deepEqual(seen, [1], 'baseline: the event reaches the module');
  context.mock.timers.tick(30000);
  assert.equal(world.sockets[0].sent.length, 1, 'the client pings every 30 s');
  assert.equal(world.liveIntervals.size, 1);

  // The drop. The proxied handshake and the server's direct address both fail once.
  let refusals = 2;
  world.hmrDial = () => (refusals-- > 0 ? 'refuse' : 'open');
  world.sockets[0].serverDrop();
  await until(context, () => world.logs.some((l: string) => l.includes('connection restored')));
  assert.equal(world.reloads, 0, 'no reload');
  assert.ok(world.logs.some((l: string) => l.includes('connection restored; the page was not reloaded')), world.logs.join('\n'));
  const urls = hmrUrls(world);
  assert.deepEqual(urls.slice(0, 4), [PROXIED, PROXIED, DIRECT, PROXIED],
    'the failed first dial fell back to the direct address once, and the retry went back to the page’s OWN address');
  assert.equal(urls.length, 4, 'and stopped as soon as it was connected');

  // Hot updates reach the modules registered before the drop: the same HMRClient.
  newest(world).serverMessage({ type: 'connected' });
  newest(world).serverMessage({ type: 'custom', event: 'app:event', data: 2 });
  await settle();
  assert.deepEqual(seen, [1, 2], 'a hot update after the reconnect still reaches the module');
  // And the module can SEND again: the HMRClient talks through the NEW transport.
  hot.send('app:ping', { n: 1 });
  await settle();
  assert.ok(newest(world).sent.some((m: string) => m.includes('app:ping')), 'a module’s hot.send goes out on the live socket');

  // A second drop recovers too, straight away.
  const before = hmrUrls(world).length;
  newest(world).serverDrop();
  await until(context, () => world.logs.filter((l: string) => l.includes('connection restored')).length === 2);
  assert.equal(world.reloads, 0);
  assert.equal(hmrUrls(world).length, before + 1, 'one dial');
  newest(world).serverMessage({ type: 'custom', event: 'app:event', data: 3 });
  await settle();
  assert.deepEqual(seen, [1, 2, 3]);

  // The old transports' ping timers are gone: only the live socket's remains.
  for (let i = 0; i < 3; i++) { context.mock.timers.tick(30000); await settle(); }
  assert.equal(world.liveIntervals.size, 1, `one ping timer for one open socket (${world.liveIntervals.size})`);
  assert.ok(world.sockets.filter((s: any) => s.protocol === 'vite-hmr').filter((s: any) => s.readyState === 1).length === 1);
  assert.ok(newest(world).sent.length >= 1, 'and it is the live socket that pings');
});

test('CONTROL: the unpatched client reloads on the same sequence, so this harness reproduces the original failure (#393)', async (context) => {
  const world = makeWorld(context, 'app.example');
  await loadClient(context, false);
  await settle();
  newest(world).serverMessage({ type: 'connected' });
  world.sockets[0].serverDrop();
  await until(context, () => world.reloads > 0, 5000);
  assert.equal(world.reloads, 1, 'Vite’s own client reloads the page once the ping answers');
  assert.ok(world.logs.some((l: string) => l.includes('server connection lost. Polling for restart')));
});

test('a failed re-dial is NOT a restart: a changed server identity is, and only on the loopback does it reload (#393 P1-A)', async (context) => {
  // 1. The same server refuses every dial (a proxy blocking the upgrade): no reload anywhere,
  //    and after about a minute it says HMR is off.
  for (const [hostname, fetchThrows] of [['localhost', false], ['app.example', false], ['localhost', true]] as const) {
    await context.test(`${hostname}${fetchThrows ? ', identity unreadable' : ''}: refused dials with an unchanged or unknown identity never reload`, async (t) => {
      const world = makeWorld(t, hostname);
      world.fetchThrows = fetchThrows;
      await loadClient(t, true);
      await settle();
      newest(world).serverMessage({ type: 'connected' });
      world.hmrDial = () => 'refuse';
      world.sockets[0].serverDrop();
      await until(t, () => world.logs.some((l: string) => l.includes('could not re-establish HMR')), 200000, 100);
      assert.equal(world.reloads, 0);
      assert.ok(world.logs.some((l: string) => l.includes('could not re-establish HMR; it is off until this page is reloaded')), world.logs.join('\n'));
      assert.ok(world.sockets.filter((s: any) => s.protocol === 'vite-hmr').length >= 12, 'it kept trying');
    });
  }
  // 2. The server RESTARTED (a new token): a loopback page reloads once; any other host stays put.
  for (const [hostname, reloads] of [['localhost', 1], ['127.0.0.1', 1], ['[::1]', 1], ['app.example', 0], ['app.localhost', 0]] as const) {
    await context.test(`${hostname}: a confirmed restart reloads ${reloads} time(s)`, async (t) => {
      const world = makeWorld(t, hostname);
      await loadClient(t, true);
      await settle();
      newest(world).serverMessage({ type: 'connected' });
      world.token = 'tok-B';
      world.hmrDial = () => 'refuse';
      world.sockets[0].serverDrop();
      await until(t, () => world.reloads > 0 || world.logs.some((l: string) => l.includes('dev server restarted')), 60000);
      assert.equal(world.reloads, reloads);
      if (!reloads) assert.ok(world.logs.some((l: string) => l.includes('the dev server restarted; HMR is off until this page is reloaded')), world.logs.join('\n'));
    });
  }
});

test('PENDING is not the same as refused (#393, reviewer P2)', async (context) => {
  // 1. The first HMR upgrade never answers. The loop must not wait for it: after its 8 s it dials
  //    again, restores on the next, and when the hung socket finally opens it is CLOSED and silent.
  await context.test('a hung upgrade is given up on after 8 s; its late socket is shut and never touches the new transport', async (t) => {
    const world = makeWorld(t, 'app.example');
    const client = await loadClient(t, true);
    await settle();
    newest(world).serverMessage({ type: 'connected' });
    const seen: unknown[] = [];
    const hot = client.createHotContext('/m.js');
    hot.on('app:event', (data: unknown) => seen.push(data));
    let hung: any = null;
    world.hmrDial = (socket: any) => { if (!hung) { hung = socket; return 'hang'; } return 'open'; };
    world.sockets[0].serverDrop();
    const waited = await until(t, () => world.logs.some((l: string) => l.includes('connection restored')));
    assert.ok(hung, 'the first dial is the one that hangs');
    assert.ok(waited >= 8000 && waited < 20000, `it gave up on the pending upgrade after its 8 s, not before and not never (${waited} ms)`);
    assert.equal(world.reloads, 0);
    const live = newest(world);
    assert.notEqual(live, hung, 'and restored on a LATER socket');
    live.serverMessage({ type: 'connected' });
    // The hung socket answers LATE. It is shut, and what it says reaches nobody.
    hung.serverOpen();
    await settle();
    assert.equal(hung.readyState, 3, 'the late socket is closed by the client');
    hung.serverMessage({ type: 'custom', event: 'app:event', data: 'from the abandoned attempt' });
    live.serverMessage({ type: 'custom', event: 'app:event', data: 'live' });
    await settle();
    assert.deepEqual(seen, ['live'], 'only the live transport delivers');
    hot.send('app:ping', {});
    await settle();
    assert.ok(live.sent.some((m: string) => m.includes('app:ping')) && !hung.sent.some((m: string) => m.includes('app:ping')), 'and sends go out on the live socket, not the abandoned one');
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(30000); await settle(); }
    assert.equal(world.liveIntervals.size, 1, 'the abandoned attempt left no ping timer behind');
  });
  // 2. The identity read hangs too: it is aborted at 5 s and read as unknown, so the loop goes on
  //    to the next dial (twelve of them, then the console says HMR is off) and nothing reloads.
  await context.test('a hung identity read is "unknown" after 5 s: the loop goes on and nothing reloads', async (t) => {
    const world = makeWorld(t, 'localhost');
    world.fetchHangs = true;
    await loadClient(t, true);
    await settle();
    newest(world).serverMessage({ type: 'connected' });
    world.hmrDial = () => 'refuse';
    world.sockets[0].serverDrop();
    const waited = await until(t, () => world.logs.some((l: string) => l.includes('could not re-establish HMR')), 400000, 100);
    assert.equal(world.reloads, 0, 'an identity read that never answers is unknown, not a restart');
    assert.equal(world.fetches, 12, 'one identity read per attempt, each given up on');
    assert.ok(waited < 12 * (5000 + 5000 + 100) + 5000, `bounded: ${waited} ms for 12 attempts with a hung identity read each`);
  });
});
