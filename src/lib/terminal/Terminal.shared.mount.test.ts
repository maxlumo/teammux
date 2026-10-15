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

/** The server's end of the one socket: every frame it was sent, and its
 * capture replies, which the test can hold and release in any order. */
interface Wire {
  frames: Frame[];
  holdCaptures: boolean;
  held: { id: number; target: string }[];
  /** Answer a held capture with `output`. */
  release(i: number, output: string): void;
  push(msg: unknown): void;
}
function socketClass(win: DOMWindow, wire: Wire) {
  return class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    url: string; readyState = 0; binaryType = '';
    onopen: ((e?: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e?: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      wire.push = (msg) => this.deliver(msg);
      wire.release = (i, output) => { const h = wire.held.splice(i, 1)[0]!; this.deliver({ id: h.id, result: { output } }); };
      win.queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.deliver({ server_nonce: '00'.repeat(16) }); });
    }
    deliver(msg: unknown) {
      const data = JSON.stringify(msg);
      win.queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
    }
    send(text: string) {
      const frame = JSON.parse(text) as Frame;
      wire.frames.push(frame);
      if (frame.method === 'auth') this.deliver({ result: { authenticated: true, machine_id: 'm-a', hostname: 'a.host' } });
      else if (frame.id != null) {
        if (frame.method === 'capture_pane' && wire.holdCaptures) {
          wire.held.push({ id: frame.id, target: String(frame.params?.target) });
          return;
        }
        const pane = (w: number) => ({ session: 'app', window: w, pane: 0, window_name: `w${w}`, current_command: 'zsh', current_path: '/', width: 80, height: 24, active: w === 0, pane_title: '' });
        const result = frame.method === 'capture_pane' ? { output: 'screen' } : frame.method === 'list_panes' ? [pane(0), pane(1)] : {};
        this.deliver({ id: frame.id, result });
      }
    }
    close() { this.readyState = 3; }
  };
}

async function mount(context: TestContext) {
  const wire: Wire = { frames: [], holdCaptures: false, held: [], release() {}, push() {} };
  const frames = wire.frames;
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
      (win as unknown as { WebSocket: unknown }).WebSocket = socketClass(win, wire);
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
  const shared = (app.window as unknown as { __shared: { dial(): Promise<{ ok: boolean }>; mount(): void; show(which: string, on: boolean): void; retarget(which: string, t: string): void } }).__shared;
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
  /** Fire a box change WITHOUT advancing the clock past the 120 ms send. */
  const boxChangedNow = async (cell: string, px: number) => {
    width[cell] = px;
    for (const o of observers) if (o.el.closest(`[data-cell="${cell}"]`)) o.cb();
    await flushAll();
  };
  /** What a cell's CURRENT xterm (the newest, not disposed) was asked to write. */
  const screen = (cell: string) => {
    const xs = (app.window as unknown as { __xterms: { element: HTMLElement | null; written: string; disposed: boolean }[] }).__xterms
      .filter((x) => !x.disposed && x.element?.closest('[data-cell]')?.getAttribute('data-cell') === cell);
    return xs.at(-1)?.written ?? '';
  };
  const reconnect = async () => {
    app.window.dispatchEvent(new app.window.CustomEvent('ws-reconnected', { detail: { serverId: 'a' } }));
    await flushAll();
  };
  /** Set a box's width without telling its observer (a layout moment the
   * terminal has not measured yet, e.g. a box that is briefly 0). */
  const setWidth = (cell: string, px: number) => { width[cell] = px; };
  return { app, shared, wire, flushAll, settle, boxChanged, boxChangedNow, setWidth, resizes, screen, reconnect };
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

test('a size queued while shown is not sent once the terminal is hidden, nor after a hidden reconnect (board #395 review P1-a)', async (context) => {
  const { app, shared, flushAll, settle, boxChangedNow, resizes, reconnect } = await mount(context);
  const start = resizes().length;
  // The drawer's box changes while it is shown: 71x43 is QUEUED (120 ms).
  await boxChangedNow('drawer', 600);
  assert.deepEqual(resizes().slice(start), [], 'not sent yet');
  // Within 120 ms the Terminal tab is opened: the drawer is hidden, the page
  // shown; then the clock passes the drawer's timer.
  shared.show('drawer', false);
  shared.show('page', true);
  await settle();
  assert.ok(!resizes().slice(start).includes('71x43'), `the hidden drawer s queued size never reached tmux: ${resizes().slice(start)}`);
  assert.equal(resizes().at(-1), PAGE, 'the page asserted its box on show');

  // Back to Chat; the drawer queues a size, is hidden again before it is
  // sent, and the gateway reconnects while it is hidden.
  shared.show('page', false);
  shared.show('drawer', true);
  await settle();
  const mark = resizes().length;
  await boxChangedNow('drawer', 520);
  shared.show('drawer', false);
  await flushAll();
  await reconnect();
  await app.advance(300); await flushAll();
  assert.deepEqual(resizes().slice(mark), [], 'no queued size, no 0x0 and no reconnect size from a hidden terminal');
});

test('a capture reply for a pane the terminal has left changes neither its cache nor its screen (board #395 review P1-b)', async (context) => {
  const { shared, wire, settle, screen, reconnect } = await mount(context);
  const B = 'app:1.0';
  // The page shows another pane here, so every request for A or B below is
  // the drawer's own.
  shared.retarget('page', 'app:9.0');
  await settle();
  wire.holdCaptures = true;
  // A reconnect asks for A's screen; the reply is late.
  await reconnect();
  assert.equal(wire.held.filter((h) => h.target === TARGET).length, 1, 'the reconnect asked for A, once');
  const late = wire.held.find((h) => h.target === TARGET)!;
  // The drawer moves to B, and B's first frame arrives.
  shared.retarget('drawer', B);
  await settle();
  wire.push({ method: 'pane_output', params: { target: B, content: 'B frame' } });
  await settle();
  assert.match(screen('drawer'), /B frame/u);
  // A's late reply lands now.
  wire.release(wire.held.indexOf(late), 'A stale');
  await settle();
  assert.doesNotMatch(screen('drawer'), /A stale/u, 'B s screen is not overwritten by A s reply');
  // B's cache too: hidden and shown again, the replay is B's frame.
  shared.show('drawer', false); await settle();
  const before = screen('drawer').length;
  shared.show('drawer', true); await settle();
  const replay = screen('drawer').slice(before);
  assert.match(replay, /B frame/u, 'the replay is B s frame');
  assert.doesNotMatch(replay, /A stale/u, 'and B s cache does not hold A s reply');

  // A → B → A: an A request from the FIRST visit, answered after the
  // terminal is back on A, is not this visit's.
  shared.retarget('drawer', TARGET); await settle();
  while (wire.held.length) wire.release(0, 'first visit, answered in time');
  await settle();
  await reconnect();
  assert.equal(wire.held.filter((h) => h.target === TARGET).length, 1, 'one A request from this visit');
  const firstVisit = wire.held.find((h) => h.target === TARGET)!;
  shared.retarget('drawer', B); await settle();
  shared.retarget('drawer', TARGET); await settle();
  wire.push({ method: 'pane_output', params: { target: TARGET, content: 'A new' } });
  await settle();
  wire.release(wire.held.indexOf(firstVisit), 'A old');
  await settle();
  assert.match(screen('drawer'), /A new/u);
  assert.doesNotMatch(screen('drawer'), /A old/u, 'a request from an earlier visit to A is dropped');

  // The current visit's reply while hidden is recorded and drawn on show.
  while (wire.held.length) wire.release(0, 'drop');
  await settle();
  shared.show('drawer', false); await settle();
  await reconnect();
  assert.equal(wire.held.filter((h) => h.target === TARGET).length, 1);
  wire.release(wire.held.findIndex((h) => h.target === TARGET), 'A hidden capture');
  await settle();
  assert.doesNotMatch(screen('drawer'), /A hidden capture/u, 'hidden: recorded, not drawn');
  shared.show('drawer', true); await settle();
  assert.match(screen('drawer'), /A hidden capture/u, 'shown: the recorded capture is drawn');
});

test('a reconnect withdraws a size still waiting, so a shown terminal with no box never sends 0x0 (board #397, the #395 review P2)', async (context) => {
  const { app, flushAll, boxChangedNow, setWidth, resizes, reconnect } = await mount(context);
  const start = resizes().length;
  // The shown drawer queues 71x43; before it is sent its box measures 0 and
  // the gateway reconnects: the fit finds nothing to send.
  await boxChangedNow('drawer', 600);
  setWidth('drawer', 0);
  await reconnect();
  await app.advance(300); await flushAll();
  const sent = resizes().slice(start);
  assert.ok(!sent.some((r) => /^0x|x0$/u.test(r)), `no 0-sized resize: ${sent}`);
  assert.deepEqual(sent, [], `the queued size was withdrawn by the reconnect, and nothing else was sent: ${sent}`);
  // The box comes back, at another width: the drawer sizes the pane again.
  await boxChangedNow('drawer', 520);
  await app.advance(200); await flushAll();
  assert.equal(resizes().at(-1), '61x43');
});
