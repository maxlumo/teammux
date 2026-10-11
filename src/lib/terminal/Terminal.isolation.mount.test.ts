// Two servers' terminals on the SAME target never see each other's stream
// (board #335 ③a; validator P2-b on ea56861b, orchestrator 07:36).
//
// Before this, the claim rested on structure: Terminal takes its listeners
// from its scope's connection, connection.test proves two connections keep
// separate listener tables, and the App harness's subscribe/listen were
// no-ops. Here both halves are real at once: two runtimes from a real fleet,
// each a real `createConnection` dialled over its own socket, and a real
// Terminal bound to each through its own ServerScope, both showing `app:0.0`.
// The test owns only the sockets (the server's side of the wire) and a
// stand-in xterm that records what it is asked to write. Plain-token auth:
// the handshake's Web Crypto is connection.test's subject, not this one's.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DOMWindow } from 'jsdom';
import { compileMount } from '../test/mount.ts';

const standIn = new URL('../test/xterm-stand-in.ts', import.meta.url);
const compiled = compileMount(new URL('./TerminalPair.test.svelte', import.meta.url), [], {
  standIns: { '@xterm/xterm': standIn, '@xterm/addon-web-links': standIn },
});

const TARGET = 'app:0.0';

type Frame = { id?: number; method: string; params?: Record<string, unknown> };
/** The server's end of one socket: what it was sent, and a way to push. */
interface Wire { server: string; url: string; frames: Frame[]; push(msg: unknown): void }

/** A WebSocket whose other end is this test: it opens, offers a plain-token
 * handshake, authenticates as the machine its address belongs to, and
 * answers every RPC — `capture_pane` with a frame that names its server. */
function socketClass(win: DOMWindow, wires: Wire[]) {
  return class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    url: string; readyState = 0; binaryType = '';
    onopen: ((e?: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e?: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    wire: Wire;
    constructor(url: string) {
      this.url = url;
      const server = url.includes('//b') ? 'b' : 'a';
      this.wire = { server, url, frames: [], push: (msg) => this.deliver(msg) };
      wires.push(this.wire);
      win.queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        this.deliver({ server_nonce: '00'.repeat(16) });
      });
    }
    deliver(msg: unknown) {
      const data = JSON.stringify(msg);
      win.queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
    }
    send(text: string) {
      if (this.readyState !== 1) throw new Error('socket is not open');
      const frame = JSON.parse(text) as Frame;
      this.wire.frames.push(frame);
      if (frame.method === 'auth') {
        this.deliver({ result: { authenticated: true, machine_id: `m-${this.wire.server}`, hostname: `${this.wire.server}.host` } });
      } else if (frame.id != null) {
        const pane = (w: number) => ({ session: 'app', window: w, pane: 0, window_name: `w${w}`, current_command: 'zsh', current_path: '/', width: 80, height: 24, active: w === 0, pane_title: '' });
        const result = frame.method === 'capture_pane' ? { output: `screen of ${this.wire.server}` }
          : frame.method === 'list_panes' ? [pane(0), pane(1)] : {};
        this.deliver({ id: frame.id, result });
      }
    }
    close() { this.readyState = 3; }
  };
}

async function mount(context: TestContext) {
  const wires: Wire[] = [];
  const app = await (await compiled).mount(context, {
    modules: [],
    pendingImports: ['@xterm/addon-webgl'],
    setup(win) {
      win.localStorage.setItem('tmux_locale', 'en');
      win.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
        { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
      ]));
      win.Element.prototype.getAnimations = () => [];
      // No Web Crypto: the plain-token handshake (connection.ts's fallback).
      Object.defineProperty(win, 'crypto', { configurable: true, value: { getRandomValues: (a: Uint8Array) => a } });
      (win as unknown as { WebSocket: unknown }).WebSocket = socketClass(win, wires);
    },
  });
  const pair = (app.window as unknown as { __pair: {
    runtimes: { id: string }[]; exits: string[]; switched: string[]; dial(): Promise<{ ok: boolean }[]>; show(): void; hide(id: string): void; focus(id: string | null): void;
  } }).__pair;
  const flushAll = async () => { for (let i = 0; i < 12; i++) await app.flush(); };
  const dialled = pair.dial();
  await flushAll();
  assert.deepEqual([...(await dialled)].map((r) => r.ok), [true, true], 'both runtimes authenticated, each on its own socket');
  assert.deepEqual(wires.map((w) => w.server), ['a', 'b']);
  pair.show();
  await flushAll();
  const wire = (server: string) => wires.find((w) => w.server === server)!;
  const xterms = () => (app.window as unknown as { __xterms: { element: HTMLElement | null; written: string; disposed: boolean }[] }).__xterms;
  const screen = (server: string) => xterms()
    .filter((x) => !x.disposed && x.element?.closest('.cell')?.getAttribute('data-server') === server)
    .map((x) => x.written).join('');
  const pushOutput = (server: string, content: string) =>
    wire(server).push({ method: 'pane_output', params: { target: TARGET, content } });
  const sent = (server: string, method: string) => wire(server).frames
    .filter((f) => f.method === method && (f.params?.target ?? TARGET) === TARGET).length;
  return { app, pair, wires, flushAll, screen, pushOutput, sent };
}

test('a push on B s connection reaches B s terminal only, on the same target as A s', async (context) => {
  const { flushAll, screen, pushOutput, sent } = await mount(context);
  assert.equal(sent('a', 'subscribe'), 1, 'A s terminal subscribed on A s socket');
  assert.equal(sent('b', 'subscribe'), 1, 'and B s on B s');
  assert.match(screen('a'), /screen of a/u, 'each painted its own capture');
  assert.match(screen('b'), /screen of b/u);
  assert.doesNotMatch(screen('a'), /screen of b/u);

  pushOutput('b', 'B-ONLY frame');
  await flushAll();
  assert.match(screen('b'), /B-ONLY frame/u, 'B s frame painted on B');
  assert.doesNotMatch(screen('a'), /B-ONLY/u, 'and never on A, though the target is the same');

  pushOutput('a', 'A-ONLY frame');
  await flushAll();
  assert.match(screen('a'), /A-ONLY frame/u);
  assert.doesNotMatch(screen('b'), /A-ONLY/u);
});

test('a pane closed on B ends B s terminal only', async (context) => {
  const { pair, wires, flushAll } = await mount(context);
  wires.find((w) => w.server === 'b')!.push({ method: 'pane_closed', params: { target: TARGET } });
  await flushAll();
  assert.deepEqual([...pair.exits], [`b:${TARGET}`]);
});

test('B s terminal leaving unsubscribes on B s socket; A keeps its subscription and its stream', async (context) => {
  const { pair, flushAll, screen, pushOutput, sent } = await mount(context);
  pair.hide('b');
  await flushAll();
  assert.equal(sent('b', 'unsubscribe'), 1, 'B s last subscriber left: B s server is told');
  assert.equal(sent('a', 'unsubscribe'), 0, 'A s server is not');
  pushOutput('a', 'A after B left');
  await flushAll();
  assert.match(screen('a'), /A after B left/u, 'A s stream still arrives');
});

test('a reconnect of B re-captures B s terminal, not A s', async (context) => {
  const { app, flushAll, sent } = await mount(context);
  const before = { a: sent('a', 'capture_pane'), b: sent('b', 'capture_pane') };
  app.window.dispatchEvent(new app.window.CustomEvent('ws-reconnected', { detail: { serverId: 'b' } }));
  await flushAll();
  assert.equal(sent('b', 'capture_pane'), before.b + 1, 'B re-captured over B s socket');
  assert.equal(sent('a', 'capture_pane'), before.a, 'A did not');
});

test('a window shortcut moves the FOCUSED tree s terminal only, though both show the same target (#335 ③a-4, reviewer P1-B)', async (context) => {
  const { app, pair, flushAll } = await mount(context);
  pair.focus('a');
  await flushAll();
  app.window.dispatchEvent(new app.window.CustomEvent('terminal-window-shortcut', { detail: { direction: 1 } }));
  await flushAll();
  assert.deepEqual([...pair.switched], ['a:app:1.0'], 'only A s terminal moved to the next window');
  pair.focus('b');
  await flushAll();
  app.window.dispatchEvent(new app.window.CustomEvent('terminal-window-shortcut', { detail: { direction: 1 } }));
  await flushAll();
  assert.deepEqual([...pair.switched], ['a:app:1.0', 'b:app:1.0'], 'focus moved: now only B s');
});
