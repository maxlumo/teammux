import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import type { TestContext } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { DOMWindow } from 'jsdom';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Mocked module exports cross the test/window boundary; production types stay
// with the fixture that supplies them, not this small runtime adapter.
type MockExport = (...args: any[]) => unknown;
interface MountOptions {
  props?: Record<string, unknown>;
  modules: Record<string, MockExport>[];
  setup?: (window: DOMWindow) => void;
  /** Lazy package imports that may stay PENDING instead of failing the mount,
   * by specifier prefix (board #305: a Tauri-shell fixture loads its plugin
   * modules at init). Every other lazy import still fails. */
  pendingImports?: string[];
}
interface ClientApi {
  start(props: Record<string, unknown>): void;
  tick(): Promise<void>;
  flushSync(): void;
  stop(): Promise<void>;
}

/** Compile once, then execute each scenario in a fresh browser-like realm.
 * This is a client bundle, never Vite SSR, and it opens no server or socket. */
export async function compileMount(component: URL, mockedModules: readonly URL[]) {
  const started = performance.now();
  const scratch = await mkdtemp(join(tmpdir(), 'tmm-mount-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const paths = mockedModules.map((url) => fileURLToPath(url));
  const entry = join(root, '__mount-entry.js');
  let code: string;
  try {
    const result = await build({
      configFile: false, root, publicDir: false, logLevel: 'error',
      cacheDir: join(scratch, 'cache'),
      resolve: { conditions: ['browser'] },
      plugins: [
        {
          name: 'mount-fixture',
          enforce: 'pre',
          async resolveId(source, importer) {
            if (source === entry) return entry;
            if (/^(?:katex|mermaid|pdfjs-dist|highlight\.js|@xterm\/[^/]+)(?:\/|$)/u.test(source)) {
              return `\0mount-heavy:${source}`;
            }
            if (!importer || !source.startsWith('.')) return;
            const resolved = await this.resolve(source, importer, { skipSelf: true });
            const index = resolved ? paths.indexOf(resolved.id) : -1;
            if (index >= 0) return `\0mount-mock:${index}`;
          },
          // Keep lazy renderer/platform packages lazy: this tier cannot paint
          // them, and inlining them changed cold compilation from seconds to 20s.
          resolveDynamicImport(source) {
            if (typeof source === 'string' && !source.startsWith('.') && !source.startsWith('/')) {
              return { id: source, external: true };
            }
          },
          renderDynamicImport({ targetModuleId }) {
            if (targetModuleId && !targetModuleId.startsWith('/')) {
              return { left: 'globalThis.__mountUnexpectedImport(', right: ')' };
            }
          },
          load(id) {
            if (id.startsWith('\0mount-heavy:')) {
              const name = JSON.stringify(id.slice('\0mount-heavy:'.length));
              return {
                code: `const fail = () => globalThis.__mountUnexpectedImport(${name});
                  export const unavailable = new Proxy(fail, { get: fail });
                  export default unavailable;`,
                syntheticNamedExports: 'unavailable',
              };
            }
            if (id === entry) return `
              import Component from ${JSON.stringify(fileURLToPath(component))};
              import { mount, unmount, tick, flushSync } from 'svelte';
              let instance;
              globalThis.__mountClient = {
                start(props) { instance = mount(Component, { target: document.body, props }); },
                tick, flushSync,
                async stop() { const held = instance; instance = undefined; if (held) await unmount(held); }
              };
            `;
            if (id.startsWith('\0mount-mock:')) return {
              code: `export const mocks = globalThis.__mountModules[${Number(id.split(':')[1])}];`,
              syntheticNamedExports: 'mocks',
            };
          },
        },
        svelte({ configFile: false }),
      ],
      build: {
        write: false, minify: false, reportCompressedSize: false,
        lib: { entry, name: 'MountFixture', formats: ['iife'] },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    if ('on' in result) throw new Error('Mount compilation must not start a watcher');
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => output.output).filter((output) => output.type === 'chunk');
    if (chunks.length !== 1) throw new Error(`Expected one client bundle, got ${chunks.length}`);
    code = chunks[0]!.code;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const script = new Script(code, { filename: 'mount-client.js' });
  const compileMs = performance.now() - started;

  return {
    compileMs,
    async mount(context: TestContext, options: MountOptions) {
      const errors: unknown[] = [];
      const console = new VirtualConsole();
      console.on('jsdomError', (error) => errors.push(error));
      const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://mount.test/', runScripts: 'outside-only',
        pretendToBeVisual: true, virtualConsole: console,
      });
      const win = dom.window;
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      let closed = false;
      let api: ClientApi | undefined;
      const fail = (message: string): never => {
        const error = new Error(message);
        errors.push(error);
        throw error;
      };
      const assertHealthy = () => {
        if (errors.length) throw new AggregateError(errors,
          `Client mount encountered unexpected errors:\n${errors.map(String).join('\n')}`);
      };
      const clone = (value: unknown) => value === undefined
        ? undefined : win.JSON.parse(JSON.stringify(value));
      win.__mountModules = paths.map((path, index) => new Proxy({}, {
        get(_target, key) {
          if (typeof key !== 'string') return undefined;
          return (...args: unknown[]) => {
            const fn = options.modules[index]?.[key];
            if (!fn) return fail(`Unexpected mocked export: ${path}:${key}`);
            const result = fn(...args);
            // RPCs are JSON on the wire; clone replies into the client realm
            // so Svelte sees that realm's Object/Array prototypes.
            return result instanceof Promise ? result.then(clone) : clone(result);
          };
        },
      }));
      win.addEventListener('error', (event) => {
        errors.push(event.error ?? new Error(event.message));
        event.preventDefault();
      });
      Object.assign(win, {
        __mountUnexpectedImport: (id: string) => options.pendingImports?.some((prefix) => id.startsWith(prefix))
          ? new win.Promise(() => {})
          : fail(`Unexpected lazy import in a mounted fixture: ${id}`),
        fetch: () => fail('Unexpected fetch in a mounted fixture'),
        WebSocket: class { constructor() { fail('Unexpected WebSocket in a mounted fixture'); } },
        XMLHttpRequest: class { constructor() { fail('Unexpected XMLHttpRequest in a mounted fixture'); } },
        // No layout is simulated: these observers never invent a measurement.
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        matchMedia: (media: string) => Object.assign(new win.EventTarget(), {
          media, matches: false, onchange: null, addListener() {}, removeListener() {},
        }),
      });
      context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_800_000_000_000 });
      Object.assign(win, {
        Date, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
      });
      async function flush() {
        await api!.tick();
        api!.flushSync();
        const ready = [...frames.values()];
        frames.clear();
        for (const fn of ready) fn(win.performance.now());
        await api!.tick();
        assertHealthy();
      }
      async function close() {
        if (closed) return;
        closed = true;
        try { await api?.stop(); }
        finally {
          frames.clear();
          win.close();
          context.mock.timers.reset();
        }
        assertHealthy();
      }
      try {
        options.setup?.(win);
        script.runInContext(dom.getInternalVMContext());
        api = win.__mountClient as ClientApi;
        api.start(options.props ?? {});
        await flush();
      } catch (error) {
        await close();
        throw error;
      }
      context.after(close);
      return {
        window: win, document: win.document, flush, close,
        async advance(ms: number) { context.mock.timers.tick(ms); await flush(); },
        /** Destroy the component but keep the realm, so a test can observe
         * what its teardown did — and what work it had in flight still does.
         * `close` remains idempotent after it. */
        async unmount() { await api?.stop(); await flush(); },
      };
    },
  };
}
