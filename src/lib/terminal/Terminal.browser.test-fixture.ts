// Real Terminal/xterm browser fixture. Only RPC and clipboard boundaries are
// controlled; the build wrapper traces public xterm APIs without replacing them.
import { mount, tick, unmount } from 'svelte';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@xterm/xterm/css/xterm.css';
import '../../app.css';
import type { Terminal } from '@xterm/xterm';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') || 'dark';
localStorage.setItem('tmux_locale', 'en');
const errors: string[] = [];
const outputs = new Map<string, Set<(...args: unknown[]) => void>>();
const closed = new Map<string, Set<(...args: unknown[]) => void>>();
const calls: { method: string; args: unknown[] }[] = [];
const terminals: (Terminal & { fixtureWrites: number; fixtureDisposed: boolean })[] = [];
const copies: { text: string; resolve: () => void; reject: () => void }[] = [];
const frames = new Map<string, string>();
const initial = Array.from({ length: 100 }, (_, i) =>
  `${String(i).padStart(3, '0')} alpha bravo charlie delta echo`).join('\n');
let failSend = false;
let controls: Record<string, (value: any) => void> = {};
const fail = (message: string): never => { errors.push(message); throw Error(message); };
const on = (map: typeof outputs, target: string, cb: (...args: unknown[]) => void) => {
  if (!map.has(target)) map.set(target, new Set());
  map.get(target)!.add(cb);
};
const off = (map: typeof outputs, target: string, cb: (...args: unknown[]) => void) => map.get(target)?.delete(cb);
const rpc: Record<string, (...args: any[]) => unknown> = {
  listPanes: () => [],
  capturePane: target => ({ output: frames.get(target) ?? initial }),
  subscribe: () => ({}), unsubscribe: () => ({}),
  addPaneOutputListener: (target, cb) => on(outputs, target, cb),
  removePaneOutputListener: (target, cb) => off(outputs, target, cb),
  addPaneClosedListener: (target, cb) => on(closed, target, cb),
  removePaneClosedListener: (target, cb) => off(closed, target, cb),
  resizePane: () => ({}),
  sendKeys: () => { if (failSend) throw Error('fixture connection failure'); return {}; },
  pasteText: () => fail('Paste transport is not part of this fixture'),
};
const fixture = {
  errors, calls, terminals, copies,
  term: () => terminals.at(-1)!,
  control: (name: string, value: unknown) => (controls[name] ?? (() => fail(`Unknown control: ${name}`)))(value),
  failSend: (value: boolean) => { failSend = value; },
  async call(method: string, args: unknown[]) {
    calls.push({ method, args });
    const result = await (rpc[method] ?? (() => fail(`Unexpected RPC: ${method}`)))(...args);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  },
  async settle() {
    for (let i = 0; i < 5; i++) { await tick(); await new Promise(requestAnimationFrame); }
  },
  select(col = 10, length = 5) {
    const term = this.term();
    term.scrollToLine(20);
    term.select(col, term.buffer.active.viewportY + 8, length);
    return term.getSelection();
  },
  push(label: string) {
    const target = calls.findLast(c => c.method === 'subscribe')!.args[0] as string;
    const content = `${initial}\n${label}`;
    frames.set(target, content);
    for (const cb of outputs.get(target) ?? []) cb(target, content, null, undefined);
  },
  text() {
    const term = this.term();
    return Array.from({ length: term.buffer.active.length }, (_, i) =>
      term.buffer.active.getLine(i)?.translateToString(true)).join('\n');
  },
  listeners: () => [...outputs.values(), ...closed.values()].reduce((sum, group) => sum + group.size, 0),
};
Object.assign(window, { terminalFeedbackFixture: fixture });
window.addEventListener('error', event => errors.push(String(event.error)));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
window.fetch = () => fail('Unexpected fetch');
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: (text: string) => new Promise<void>((resolve, reject) => {
    copies.push({ text, resolve, reject: () => reject(Error('fixture clipboard denied')) });
  }),
} });
// A rejected modern API must pass through the real copyText fallback as well.
document.execCommand = command => command === 'copy' ? false : fail(`Unexpected execCommand: ${command}`);
const { default: Fixture } = await import('./Terminal.test.svelte');
// Terminal reads its server from its scope (board #335 ②b). The transport is
// whatever `core/ws.ts` resolves to in this build — the controlled one — so
// the scope speaks through exactly the boundary this fixture controls.
const transport = await import('../core/ws.ts');
const { scopeContext } = await import('../app/server-context.ts');
const { createServerState } = await import('../app/server-state.ts');
const app = mount(Fixture, { target: document.body, props: {
  register: (value: typeof controls) => { controls = value; },
}, context: scopeContext({
  runtime: { id: 'fixture', api: transport, connection: transport } as never,
  state: createServerState(localStorage),
}) });
Object.assign(fixture, { unmount: () => unmount(app) });
