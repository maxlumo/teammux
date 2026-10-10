// The ONE way a render test compiles a component through Vite SSR
// (docs/conventions/testing.md § render tests; boards #177, #178).
//
// Vite 6's `createServer` in middleware mode opens its OWN http server for
// the HMR websocket on the fixed default port 24678 — even with
// `server.hmr: false`, which only stops the update messages. Two `npm test`
// runs on one machine (the launch checkout and a worktree, lead 2026-09-12)
// fought over that port and one of them stalled: every render/mount case
// timed out at 60 s behind "WebSocket server error: Port 24678 is already in
// use". `server.ws: false` is what stops the socket. A node --test run needs
// neither, and concurrent suites are normal on a shared host, so no harness
// may hold a fixed port; `harness.source.test.ts` pins that every render
// suite comes through here.
//
// Board #178: seven `*.render.test.ts` files were seven PROCESSES, and each
// paid the same fixed cost before its one test could start — measured on
// this host (16 cores, load ~20): import jsdom 1.1 s CPU, import vite 0.3 s,
// createServer 0.7–0.9 s, the component graph 1.9–2.6 s (56 of its 80
// modules are the svelte runtime, identical in every process), render +
// parse 0.25 s — 5.1 s CPU per file, 44 s CPU for the tier, 2.5–5.4 s wall
// alone and 8 s inside the parallel suite. A busy host (load 54 from leaked
// browsers) stretched that to 35–42 s against a 60 s budget and all seven
// timed out together. The tier is now ONE process: `renderHarness()` builds
// one environment and one warm server at import time — outside any test's
// timer — and every `<Component>.render.ts` suite, collected by
// `render.test.ts`, loads its component through it.
import { after } from 'node:test';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { DOMWindow } from 'jsdom';

/** Options a render test may add: a private optimizer cache (never the live
 * `node_modules/.vite`), `configFile`/`plugins` when the fixture compiles
 * Svelte itself, `ssr.noExternal` for packages Node cannot load as CJS. */
export type SsrOptions = Pick<InlineConfig, 'cacheDir' | 'configFile' | 'plugins' | 'ssr'> & { cacheDir: string };

export async function ssrServer(options: SsrOptions): Promise<ViteDevServer> {
  const { createServer } = await import('vite');
  return createServer({
    ...options,
    appType: 'custom', logLevel: 'error',
    // No listener at all: middleware mode has no http server, `hmr: false`
    // sends no updates, `ws: false` opens no websocket server.
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}

/** What the SLOWEST render suite takes behind the warm harness — compile its
 * own component files and render — MEASURED inside the parallel `npm test`
 * on this host at load ~5 (2026-09-12): Drawer 3.4 s (xterm through
 * noExternal), Board 2.6 s, every other suite 0.04–0.5 s; alone the tier is
 * 5.9 s wall / 9.8 s CPU for all seven. The budget below is the contract
 * every suite runs under: 5× that slowest typical (≥ 3× is the rule), so a
 * host four times as busy as that still lands inside it, and never the 60 s
 * the incident proved was no budget at all. */
export const RENDER_TYPICAL_MS = 4_000;
export const RENDER_TIMEOUT_MS = 20_000;

export interface RenderHarness {
  /** `ssrLoadModule` on the one warm server. */
  load<T = any>(id: string): Promise<T>;
  /** Svelte's server `render`, from the same runtime instance the components
   * use — inside ONE server's scope, as App's provider renders every
   * server-bound page (board #335 ②b-2-1). */
  render: (component: any, options?: { props?: Record<string, unknown> }) => { body: string; head: string };
  /** Parse emitted markup for querySelector assertions. */
  fragment(html: string): DocumentFragment;
  /** The one browser-like window every suite shares (jsdom). */
  window: DOMWindow;
}

let harness: Promise<RenderHarness> | null = null;

/** The one environment + warm server of the render tier, built on first use
 * (at import time of the suites, so no test's timer pays for it) and closed
 * after the root test. */
export function renderHarness(): Promise<RenderHarness> {
  return (harness ??= build());
}

async function build(): Promise<RenderHarness> {
  const { JSDOM } = await import('jsdom');
  // Node lacks the browser globals a few modules touch at import time; ONE
  // real jsdom window is a superset of every stub the seven files used to
  // install, plus the two things jsdom lacks (matchMedia, canvas contexts —
  // SSR emits markup, never terminal pixels).
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://render.test/' });
  const noop = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) });
  Object.assign(globalThis, {
    localStorage: dom.window.localStorage, window: dom.window, document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  // Node 22 exposes its own read-only `navigator`; the components read the
  // browser one (language, userAgent).
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  const vite = await ssrServer({
    cacheDir: 'node_modules/.vite-render-test',
    // Vite must load their ESM entry; Node cannot infer named exports from
    // xterm's minified CommonJS facade (the Drawer suite). Production imports
    // remain unchanged.
    ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-web-links'] },
  });
  // Warm the runtime every component shares, so a suite's timer only sees
  // its own files.
  const { render: renderBare } = await vite.ssrLoadModule('svelte/server');
  const { testScopeContext } = await vite.ssrLoadModule('/src/lib/test/server-scope-host.ts');
  const render = (component: any, options: { props?: Record<string, unknown> } = {}) =>
    renderBare(component, { ...options, context: testScopeContext() });
  after(async () => { await vite.close(); dom.window.close(); });
  return {
    load: <T = any>(id: string) => vite.ssrLoadModule(id) as Promise<T>,
    render,
    fragment: (html) => JSDOM.fragment(html),
    window: dom.window,
  };
}
