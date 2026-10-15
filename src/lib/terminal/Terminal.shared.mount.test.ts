// Two Terminals on ONE pane — the Terminal page's and the Hub drawer's —
// share one tmux size, so only the one on screen may set it (board #395).
//
// Owner: "terminal侧边栏经常没有刷新 我点放大到全屏可能会好". Measured in a real
// browser on an own gateway: with the pane opened once in the Terminal tab
// and the Chat drawer showing it, narrowing the window resized the HIDDEN
// page's box, its ResizeObserver sent that box's 114 columns, tmux took them,
// and the visible drawer's 519 px box drew only the left part of them — the
// newest output (an agent's right-aligned status line) never entered it,
// so the drawer looked frozen until a box of that size was shown again.
//
// The mount tier has no layout, so the test gives each cell's terminal box a
// width and owns the observers: it fires a box change on one cell and reads
// the `resize_pane` frames on the wire. Everything from the connection up is
// production code; xterm is the recording stand-in.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DOMWindow } from 'jsdom';
import { compileMount } from '../test/mount.ts';

const standIn = new URL('../test/xterm-stand-in.ts', import.meta.url);
const compiled = compileMount(new URL('./TerminalShared.test.svelte', import.meta.url), [], {
  standIns: { '@xterm/xterm': standIn, '@xterm/addon-web-links': standIn },
});

const TARGET = 'app:0.0';
type Frame = { id?: number; method: string; params?: Record<string, unknown> };

/** The server's end of the one socket: every frame it was sent. */
function socketClass(win: DOMWindow, frames: Frame[]) {
  return class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    url: string; readyState = 0; binaryType = '';
    onopen: ((e?: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e?: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      win.queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.deliver({ server_nonce: '00'.repeat(16) }); });
    }
    deliver(msg: unknown) {
      const data = JSON.stringify(msg);
      win.queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
    }
    send(text: string) {
      const frame = JSON.parse(text) as Frame;
      frames.push(frame);
      if (frame.method === 'auth') this.deliver({ result: { authenticated: true, machine_id: 'm-a', hostname: 'a.host' } });
      else if (frame.id != null) {
        const pane = { session: 'app', window: 0, pane: 0, window_name: 'w0', current_command: 'zsh', current_path: '/', width: 80, height: 24, active: true, pane_title: '' };
        const result = frame.method === 'capture_pane' ? { output: 'screen' } : frame.method === 'list_panes' ? [pane] : {};
        this.deliver({ id: frame.id, result });
      }
    }
    close() { this.readyState = 3; }
  };
}

async function mount(context: TestContext) {
  const frames: Frame[] = [];
  /** Each cell's terminal-box width in px (height fixed): the "layout". */
  const width: Record<string, number> = { page: 1152, drawer: 488 };
  const observers: { cb: () => void; el: Element }[] = [];
  const app = await (await compiled).mount(context, {
    modules: [],
    pendingImports: ['@xterm/addon-webgl'],
    setup(win) {
      win.localStorage.setItem('tmux_locale', 'en');
      win.localStorage.setItem('tmux_servers', JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true }]));
      win.Element.prototype.getAnimations = () => [];
      Object.defineProperty(win, 'crypto', { configurable: true, value: { getRandomValues: (a: Uint8Array) => a } });
      (win as unknown as { WebSocket: unknown }).WebSocket = socketClass(win, frames);
      const box = (el: Element, axis: 'w' | 'h') => {
        if (!el.classList.contains('xterm-wrap')) return 0;
        const cell = el.closest('[data-cell]')?.getAttribute('data-cell') ?? '';
        return axis === 'w' ? width[cell] ?? 0 : 736;
      };
      Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return box(this, 'w'); } });
      Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return box(this, 'h'); } });
      (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; }
        observe(el: Element) { observers.push({ cb: this.cb, el }); }
        unobserve() {}
        disconnect() {}
      };
    },
  });
  const shared = (app.window as unknown as { __shared: { dial(): Promise<{ ok: boolean }>; mount(): void; show(which: string, on: boolean): void } }).__shared;
  const flushAll = async () => { for (let i = 0; i < 12; i++) await app.flush(); };
  const settle = async () => { await flushAll(); await app.advance(200); await flushAll(); };
  const dialled = shared.dial();
  await flushAll();
  assert.equal((await dialled).ok, true);
  shared.mount();
  await settle();
  /** The box of `cell` changed: fire its observer, as the browser would. */
  const boxChanged = async (cell: string, px: number) => {
    width[cell] = px;
    for (const o of observers) if (o.el.closest(`[data-cell="${cell}"]`)) o.cb();
    await settle();
  };
  const resizes = () => frames.filter((f) => f.method === 'resize_pane' && f.params?.target === TARGET)
    .map((f) => `${f.params!.cols}x${f.params!.rows}`);
  return { app, shared, settle, boxChanged, resizes };
}

// The stand-in's cell is fontSize 14 × the CELL ratios: 1152 px → 137 cols,
// 488 px → 58, 600 px → 71; 736 px → 43 rows.
const PAGE = '137x43';

test('a hidden terminal never sizes the pane it shares; the one on screen does, and the page asserts on show (board #395)', async (context) => {
  const { app, shared, settle, boxChanged, resizes } = await mount(context);
  const sizedAtMount = resizes();
  assert.ok(!sizedAtMount.includes(PAGE), `the hidden page sent nothing at mount: ${sizedAtMount}`);

  // The window narrows while Chat is on screen: both boxes change.
  await boxChanged('page', 1000);
  assert.deepEqual(resizes().filter((r) => !sizedAtMount.includes(r)), [], 'the hidden page s box change sends no size');
  await boxChanged('drawer', 600);
  assert.equal(resizes().at(-1), '71x43', 'the visible drawer s does');

  // A gateway restart: only the shown terminal re-sends its size.
  const before = resizes().length;
  app.window.dispatchEvent(new app.window.CustomEvent('ws-reconnected', { detail: { serverId: 'a' } }));
  await settle();
  assert.deepEqual(resizes().slice(before), ['71x43'], 'the reconnect re-sends the drawer s size only');

  // The Terminal tab is opened: the page asserts its own, current box.
  shared.show('drawer', false);
  shared.show('page', true);
  await settle();
  assert.equal(resizes().at(-1), '119x43', 'shown again, the page sizes the pane to its box (1000 px)');
});
