import { mount, tick, unmount } from 'svelte';
import '../../app.css';

// Browser-only test fixture: real Files, editor/highlighter and ConfirmDialog; only transport boundaries
// are fake. Every unlisted call throws. No compileMount guard is overridden.
const scenario = new URLSearchParams(location.search).get('case') || 'dirty';
const feedback = scenario.startsWith('feedback');
if (scenario.includes('local') || (feedback && scenario !== 'feedback-browser')) Object.assign(window, { __TAURI_INTERNALS__: {} });
if (scenario === 'feedback-android') Object.defineProperty(navigator, 'userAgent', { value: 'Android controlled fixture' });
const entries = [
  { name: 'AGENTS.md', path: '/fixture/AGENTS.md', type: 'file', size: 100 },
  { name: 'next.md', path: '/fixture/next.md', type: 'file', size: 100 },
];
let reject!: (error: Error) => void;
let resolve!: (value: unknown) => void;
let pending = new Promise((yes, no) => { resolve = yes; reject = no; });
const deletes: string[] = [];
let back!: () => boolean;
let update!: (props: Record<string, unknown>) => void;
let result = '';
const errors: string[] = [];
const fail = (message: string): never => { errors.push(message); throw Error(message); };
function check(value: unknown, message: string): asserts value { if (!value) fail(message); }
const button = (label: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label);
  check(el, `Missing button: ${label}`); return el;
};
const dialog = () => document.querySelector('[role=alertdialog]');
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const rpc: Record<string, (...args: any[]) => unknown> = {
  fsCwd: async () => ({ path: '/fixture' }),
  fsList: async (path: string) => ({ path, entries }),
  fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' }),
  fsRead: async () => ({ content: '# Original' }),
  getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
  saveBookmarks: async () => ({}), setPref: async () => ({}),
  gitCmd: async () => ({ code: 0, stdout: '.git' }),
  fsDelete: (path: string) => { deletes.push(path); return pending; },
};
const requests: { kind: string; args: unknown[]; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const gate = (kind: string, args: unknown[]) => new Promise((resolve, reject) => requests.push({ kind, args, resolve, reject }));
let nativeOpenResult = 'ok';
const opened: string[] = [];
if (feedback) {
  rpc.fsDownloadHttp = (...args) => gate('sign', args);
  rpc.fsDownload = (...args) => gate('fallback', args);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: (...args: unknown[]) => gate('copy', args) } });
  document.execCommand = () => false;
  Object.assign(window, { AndroidFileOpener: {
    ping: () => 'ok', openFile: (path: string) => { opened.push(path); return nativeOpenResult; },
  } });
}
Object.assign(window, { filesFixture: {
  rpc(name: string, args: unknown[]) { return (rpc[name] ?? (() => fail(`Unexpected RPC: ${name}`)))(...args); },
  invoke(name: string, args?: { name: string }) {
    if (name === 'list_downloads') return Promise.resolve([{ name: 'copy.md', modified: 0 }]);
    if (name === 'delete_download') { deletes.push(args!.name); return pending; }
    // Board #305: every native download is written in pieces; the gate
    // stands at the step that saves it.
    if (feedback && name === 'download_open') return Promise.resolve({ received: 0, etag: null });
    if (feedback && ['download_reset', 'download_chunk', 'download_abort', 'download_release'].includes(name)) return Promise.resolve(null);
    if (feedback && name === 'download_finish') return gate(scenario === 'feedback-android' ? 'android-save' : 'desktop-finish', [args]);
    return fail(`Unexpected IPC: ${name}`);
  },
  native(name: string, args: unknown[]) {
    if (feedback && ['save', 'writeFile', 'openPath'].includes(name)) return gate(name, args);
    return fail(`Unexpected native call: ${name}`);
  },
  get requests() { return requests.map(({ kind, args }) => ({ kind, args })); },
  complete(index: number, value: unknown) { requests[index]!.resolve(value); },
  reject(index: number, message: string) { requests[index]!.reject(Error(message)); },
  chunk(url: string, bytes: number[] | null) {
    const controller = streams.get(url);
    check(controller, `Missing stream: ${url}`);
    if (bytes === null) controller.close(); else controller.enqueue(new Uint8Array(bytes));
  },
  update(props: Record<string, unknown>) { update(props); },
  setNativeOpen(result: string) { nativeOpenResult = result; },
  opened,
  settle,
  get result() { return result; }, errors,
} });
window.addEventListener('error', event => errors.push(String(event.error)));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
window.fetch = feedback ? async input => {
  const url = String(input);
  check(url.startsWith('/controlled-download/'), `Unexpected fetch: ${url}`);
  const total = new URL(url, location.href).searchParams.get('total');
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.set(url, controller); } }),
    { headers: total ? { 'Content-Length': total } : {} });
} : () => fail('Unexpected fetch');
if (scenario === 'dirty' || scenario === 'discard') localStorage.setItem('tmux_layout_mode', 'desktop');
localStorage.setItem('tmux_locale', 'en');
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';
document.body.style.height = '100vh';
document.body.style.display = 'flex';
document.body.style.flexDirection = 'column';
const { default: Files } = await import('./Files.test.svelte');
// Files reads its server from its scope (board #335 ②b); the scope speaks
// through whatever `core/ws.ts` resolves to in this build — the controlled
// transport.
const { testScopeContext } = await import('../test/server-scope-host.ts');
const scopeContext = testScopeContext(await import('../core/ws.ts'));
const app = mount(Files, { target: document.body, context: scopeContext, props: {
  visible: true, session: 'fixture',
  register: (fn: typeof update) => { update = fn; },
  onGoBack: (fn: typeof back) => { back = fn; },
} });
async function run() {
  await settle();
  if (feedback) return;
  if (scenario.includes('local')) {
    const downloads = document.querySelector<HTMLButtonElement>('[aria-label="Downloads"]');
    if (downloads) downloads.click();
    else {
      button('More file actions').click(); await settle();
      const action = [...document.querySelectorAll<HTMLButtonElement>('.ctx button')]
        .find(el => el.textContent?.trim() === 'Downloads');
      check(action, 'Downloads remains reachable through #164 overflow');
      action.click();
    }
    // The native package is a real dynamic import in this browser build.
    for (let i = 0; i < 100 && !document.querySelector('[aria-label="Delete: copy.md"]'); i++) {
      await new Promise(requestAnimationFrame);
    }
    button('Delete: copy.md').click(); await settle();
    if (scenario === 'local-wording') {
      check(/local|downloaded/i.test(dialog()?.textContent ?? ''), 'title identifies the downloaded/local copy');
      check(/server/i.test(dialog()?.textContent ?? ''), 'consequence says the server original survives');
      return;
    }
    const confirm = button('Delete');
    confirm.click(); confirm.click(); await settle();
    for (let i = 0; i < 100 && !deletes.length; i++) await new Promise(requestAnimationFrame);
    check(deletes.join() === 'copy.md', 'one delete_download before paint');
    if (scenario === 'stale-local') {
      update({ visible: false }); await settle();
      update({ visible: true }); await settle();
      button('Delete: copy.md').click(); await settle();
      resolve({}); await settle();
      check(!!dialog(), 'stale local completion must not dismiss the new confirmation');
      check(!!document.querySelector('[aria-label="Delete: copy.md"]'), 'stale local completion must not remove the new row');
      return;
    }
    if (scenario === 'local-busy') {
      check(back(), 'Back is consumed while busy'); await settle();
      check(!!dialog(), 'busy Back preserves local confirmation');
      button('Cancel').click();
      document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(escape); await settle();
      check(escape.defaultPrevented && !!dialog(), 'busy Escape/Cancel/backdrop are consumed');
    }
    reject(Error('local permission denied')); await settle();
    check(!!dialog(), 'rejected delete_download must not close the confirmation');
    check(dialog()!.querySelector('[role=alert]')?.textContent?.includes('local permission denied'), 'local failure remains in dialog');
    pending = Promise.resolve({});
    button('Delete').click(); await settle();
    for (let i = 0; i < 100 && deletes.length < 2; i++) await new Promise(requestAnimationFrame);
    await settle();
    check(deletes.join() === 'copy.md,copy.md', 'retry uses the captured downloaded-copy name');
    check(!dialog() && !document.querySelector('[aria-label="Delete: copy.md"]'), 'only success removes the local row');
    return;
  }
  document.querySelector<HTMLButtonElement>('.file-main')!.click(); await settle();
  button('Edit').click(); await settle();
  const editor = document.querySelector<HTMLTextAreaElement>('textarea.editor')!;
  editor.value = '# Unsaved draft';
  editor.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  if (scenario === 'discard') {
    back(); await settle();
    check(!button('Discard').classList.contains('danger'), 'Discard is neutral, not danger');
    button('Keep editing').click(); await settle();
    check(document.querySelector<HTMLTextAreaElement>('textarea.editor')?.value === '# Unsaved draft', 'Keep editing preserves the draft');
    back(); await settle();
    return;
  }
  button('Delete: next.md').click(); await settle();
  button('Delete').click(); await settle();
  resolve({}); await settle();
  check(deletes.join() === '/fixture/next.md', 'delete targets the other row');
  check(document.querySelector<HTMLTextAreaElement>('textarea.editor')?.value === '# Unsaved draft', 'deleting another row must preserve the unrelated dirty editor');
  back(); await settle();
  check(!!dialog(), 'the preserved draft is still dirty and guarded');
}
run().then(() => {
  check(errors.length === 0, errors.join('\n'));
  result = `PASS ${scenario}`;
}).catch(error => { result = `FAIL ${scenario}: ${error.message}`; console.error(error); });
window.addEventListener('pagehide', () => { resolve({}); void unmount(app); }, { once: true });
