// The Terminal's window strip is the shared TAB STRIP (#365, owner
// 2026-10-14: "Terminal 上方的 Tab 栏和 Chat 上方的 Tab 栏，样式需要做得更加一致
// 一些"): one `.strip-tab` per window, ONE travelling marker, and the current
// tab follows the window — through a pick, an added window and a closed one.
// Geometry and the glide are the real browser's (jsdom has no layout); here
// the marker's identity (one element, never re-made) and its target (the
// one `.sel` tab slideIndicator measures) are what can be held.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DOMWindow } from 'jsdom';
import { compileMount } from '../test/mount.ts';

const standIn = new URL('../test/xterm-stand-in.ts', import.meta.url);
const compiled = compileMount(new URL('./TerminalStrip.test.svelte', import.meta.url), [], {
  standIns: { '@xterm/xterm': standIn, '@xterm/addon-web-links': standIn },
});

type Frame = { id?: number; method: string; params?: Record<string, unknown> };

/** The server's end: plain-token auth, and a tmux with a mutable window list. */
function socketClass(win: DOMWindow, windows: number[]) {
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
      if (frame.method === 'auth') { this.deliver({ result: { authenticated: true, machine_id: 'm-a', hostname: 'a.host' } }); return; }
      if (frame.id == null) return;
      const pane = (w: number) => ({ session: 'app', window: w, pane: 0, window_name: `w${w}`, current_command: 'zsh', current_path: '/', width: 80, height: 24, active: w === 0, pane_title: '' });
      if (frame.method === 'new_window') windows.push(Math.max(...windows) + 1);
      const result = frame.method === 'capture_pane' ? { output: '' }
        : frame.method === 'list_panes' ? windows.map(pane) : {};
      this.deliver({ id: frame.id, result });
    }
    close() { this.readyState = 3; }
  };
}

async function mount(context: TestContext, opts: { tag?: string; phone?: boolean } = {}) {
  const windows = [0, 1];
  const app = await (await compiled).mount(context, {
    modules: [],
    pendingImports: ['@xterm/addon-webgl'],
    setup(win) {
      win.localStorage.setItem('tmux_locale', 'en');
      win.localStorage.setItem('tmux_winswitcher', '1');
      win.localStorage.setItem('tmux_servers', JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true }]));
      win.Element.prototype.getAnimations = () => [];
      Object.defineProperty(win, 'crypto', { configurable: true, value: { getRandomValues: (a: Uint8Array) => a } });
      (win as unknown as { WebSocket: unknown }).WebSocket = socketClass(win, windows);
    },
  });
  const host = (app.window as unknown as { __strip: { dial(): Promise<{ ok: boolean }>; show(): void; retarget(t: string): void; setTag(n: string | null): void; setPhone(on: boolean): void; target: string; switches: string[] } }).__strip;
  host.setTag(opts.tag ?? null);
  host.setPhone(opts.phone ?? false);
  const flushAll = async () => { for (let i = 0; i < 12; i++) await app.flush(); };
  const dialled = host.dial();
  await flushAll();
  assert.equal((await dialled).ok, true);
  host.show();
  await flushAll();
  const strip = () => app.document.querySelector<HTMLElement>('.win-bar.tab-strip')!;
  const tabs = () => [...strip().querySelectorAll<HTMLButtonElement>('.strip-tab')];
  const lit = () => tabs().filter((t) => t.classList.contains('sel')).map((t) => t.textContent?.trim());
  const marker = () => strip().querySelectorAll('.tab-group .slide-pill.tab');
  return { app, host, windows, flushAll, strip, tabs, lit, marker };
}

test('#365: the window strip is the shared tab strip — one .strip-tab per window, ONE marker, AgentChip gone from it', async (context) => {
  const { strip, tabs, lit, marker } = await mount(context);
  assert.ok(strip(), 'the expanded bar wears .tab-strip');
  assert.deepEqual(tabs().map((t) => t.textContent?.trim()), ['0:zsh', '1:zsh'], 'index:name, as the drawer pills read');
  assert.deepEqual(lit(), ['0:zsh'], 'the current window is the one lit tab');
  assert.equal(tabs()[0]!.getAttribute('aria-current'), 'page');
  assert.equal(tabs()[1]!.getAttribute('aria-current'), null);
  assert.equal(marker().length, 1, 'one marker');
  assert.ok(marker()[0]!.querySelector('.tab-shape svg .tab-fill') && marker()[0]!.querySelector('.tab-edge'), 'the one-path outline');
  assert.equal(strip().querySelector('.win-bar-scroll .chip'), null, 'no AgentChip in the strip');
});

test('#365: the marker follows the current window — a pick, an added window, a closed window — and is never re-made', async (context) => {
  const { app, host, windows, flushAll, tabs, lit, marker } = await mount(context);
  const pill = marker()[0];
  tabs()[1]!.click();
  await flushAll();
  assert.equal(host.target, 'app:1.0', 'a pick switches the pane');
  assert.deepEqual(lit(), ['1:zsh'], 'and lights its tab');
  // Add: the + creates a window and switches to it.
  app.document.querySelector<HTMLButtonElement>('.win-add')!.click();
  for (let i = 0; i < 3; i++) await flushAll();
  assert.deepEqual(windows, [0, 1, 2]);
  assert.deepEqual(tabs().map((t) => t.textContent?.trim()), ['0:zsh', '1:zsh', '2:zsh'], 'the new window has its tab');
  assert.deepEqual(lit(), ['2:zsh'], 'the marker moves to it');
  // Close: window 2 goes away, the host moves to window 1 (App's exit path).
  windows.splice(windows.indexOf(2), 1);
  host.retarget('app:1.0');
  await app.advance(6000);
  await flushAll();
  assert.deepEqual(tabs().map((t) => t.textContent?.trim()), ['0:zsh', '1:zsh'], 'the closed window s tab is gone');
  assert.deepEqual(lit(), ['1:zsh'], 'the marker moved back');
  assert.equal(marker().length, 1);
  assert.equal(marker()[0], pill, 'the SAME marker element throughout — it travels, it is not re-born');
});

test('#365: tapping the CURRENT tab switches nothing — only another window s tab does (the !isCurrent guard, validator NC survivor)', async (context) => {
  const { host, flushAll, tabs, lit } = await mount(context);
  assert.deepEqual(lit(), ['0:zsh']);
  tabs()[0]!.click();
  await flushAll();
  assert.deepEqual([...host.switches], [], 'the lit tab is where you are: no pane switch, no re-capture');
  tabs()[1]!.click();
  await flushAll();
  assert.deepEqual([...host.switches], ['app:1.0'], 'another tab switches once');
  tabs()[1]!.click();
  await flushAll();
  assert.deepEqual([...host.switches], ['app:1.0'], 'and tapping it again, now current, does nothing');
});

// ── The head names its server the way Chat and Board do (board #390) ──
//
// Owner, multi-server mode: the tag sat to the right of the name and was drawn very large. It was a
// bare <ServerTag> in the strip's flex row: this page's scoped `align-self: center` does not reach a
// child component's span, so in the tab strip it stretched to the strip's height (34px against its
// own 14px, measured in a browser), and nothing ever put it under the name. jsdom has no layout, so
// what can be held here is the STRUCTURE the browser then draws: the tag lives in the shared
// `.title-stack` (app.css; the Hub's and the Board's atom) and is no longer a child of the strip.
const stackShape = (stack: Element) => [...stack.children].map((c) => (c.classList.contains('name-line') ? 'name-line' : c.classList.contains('server-tag') ? 'server-tag' : c.tagName));

test('#390 (phone, several servers): the tag is the second item of the head\'s Name + tag stack, stacked under the name, and no bare tag is left in the strip', async (context) => {
  const { strip } = await mount(context, { tag: 'alpha', phone: true });
  const stack = strip().querySelector<HTMLElement>(':scope > .title-stack')!;
  assert.ok(stack, 'the name and tag share one stack, a direct child of the head');
  assert.ok(stack.classList.contains('stacked'), 'phone: stacked unconditionally, like Chat');
  assert.deepEqual(stackShape(stack), ['name-line', 'server-tag'], 'name line on top, the tag after it');
  assert.equal(stack.querySelector('.name-line > h1.win-title')?.textContent, 'app');
  assert.equal(stack.querySelector('.server-tag')?.textContent, 'alpha');
  assert.equal(strip().querySelector(':scope > .server-tag'), null, 'the tag is not a flex child of the strip (that is what stretched it to the strip\'s height)');
  assert.ok(strip().querySelector('.ham'), 'the phone lead-in is the hamburger, then the stack');
});

test('#390 (desktop, several servers): the same stack, not forced into its column form — the fit action decides, as on Chat', async (context) => {
  const { strip } = await mount(context, { tag: 'alpha', phone: false });
  const stack = strip().querySelector<HTMLElement>(':scope > .title-stack')!;
  assert.ok(stack && !stack.classList.contains('stacked'), 'desktop: no mode class');
  assert.deepEqual(stackShape(stack), ['name-line', 'server-tag']);
  assert.equal(strip().querySelector(':scope > .server-tag'), null);
});

for (const phone of [true, false]) {
  test(`#390 (Single, ${phone ? 'phone' : 'desktop'}): no tag, and the stack is the name alone — the head reads as it did`, async (context) => {
    const { strip } = await mount(context, { phone });
    const stack = strip().querySelector<HTMLElement>(':scope > .title-stack')!;
    assert.deepEqual(stackShape(stack), ['name-line'], 'the name line only');
    assert.equal(strip().querySelector('.server-tag'), null, 'no tag');
    assert.equal(stack.querySelector('h1.win-title')?.textContent, 'app');
  });
}
