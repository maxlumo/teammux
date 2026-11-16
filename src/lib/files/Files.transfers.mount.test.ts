// Board #134 (owner 2026-11-16: '如果同时多个文件下载上传之类的 控制并发数量 比如3'): at most N transfers run;
// the rest wait in order, each on its own card saying Waiting, with Cancel; a freed slot starts the next;
// the limit applies at once. Real Files page, real store and limiter; the network is a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { partId } from './download.ts';

const compiled = compileMount(new URL('./FilesTransfers.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
// The Android shell's variant: the native bridge is a module the test hands in (validator's #134 probe).
const nativeCompiled = compileMount(new URL('./FilesTransfers.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url), new URL('../core/native.ts', import.meta.url)], { serverScope: true });
const names = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt'];
const entries = names.map((name) => ({ name, path: `/fixture/${name}`, type: 'file', size: 1000 }));
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    fsCwd: async () => ({ path: '/fixture' }),
    fsList: async () => ({ path: '/fixture', entries }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 1000, mime_hint: 'text/plain' }),
    fsRead: async () => ({ content: 'x' }),
    projectList: async () => ({ projects: [] }),
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
    saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 0, stdout: '.git' }),
    ...extra,
  };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function settle(app: App) { for (let i = 0; i < 8; i++) await app.flush(); }
function button(app: App, label: string) {
  const el = app.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(el, `button ${label}`);
  return el;
}

test('five downloads at limit 3: three run, two wait in order with Cancel; a finish starts the next; a cancelled waiter never starts; a raised limit starts the rest (#134)', async (context) => {
  const feeds = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const signed: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    setup(window) {
      window.localStorage.setItem('tmux_transfer_limit', '3');
      (window.URL as any).createObjectURL = () => 'blob:fixture';
      (window.URL as any).revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {};
      (window as any).fetch = async (url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({ start(c) {
          feeds.set(url, c);
          init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        } });
        return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
      };
    },
    // Signing is what expires (the 60 s /dl URL): a waiting download must not have asked for one yet.
    modules: [rpc({ fsDownloadHttp: async (path: string) => { signed.push(path); return { url: `http://h/dl?p=${path}`, name: path.split('/').pop() }; } })],
  });
  const cards = () => [...app.document.querySelectorAll('.files-feedback .operation-feedback')].map((e) => e.textContent?.replace(/\s+/gu, ' ').trim() ?? '');
  const waiting = () => cards().filter((t) => /Waiting/u.test(t));
  const until = async (ok: () => boolean) => { for (let i = 0; i < 30 && !ok(); i++) await settle(app); };
  try {
    await settle(app);
    for (const name of names) { button(app, `Download: ${name}`).click(); await settle(app); }
    await until(() => feeds.size >= 3);
    await settle(app);
    assert.deepEqual([...feeds.keys()].map((u) => u.split('p=')[1]), ['/fixture/f1.txt', '/fixture/f2.txt', '/fixture/f3.txt'], 'the first three run');
    assert.deepEqual(signed, ['/fixture/f1.txt', '/fixture/f2.txt', '/fixture/f3.txt'], 'a waiting download has signed no URL');
    assert.equal(waiting().length, 2, `two wait: ${cards().join(' | ')}`);
    assert.ok(waiting().every((t) => !/Downloading/u.test(t)), 'a waiting card says Waiting, not Downloading');
    assert.ok(button(app, 'Cancel: f5.txt'), 'a waiting download has its Cancel');

    // Cancelled while waiting: its card goes and it never starts.
    button(app, 'Cancel: f5.txt').click();
    await until(() => waiting().length === 1);
    assert.equal(waiting().length, 1);

    // f1 finishes: the slot goes to f4, the first in line.
    feeds.get('http://h/dl?p=/fixture/f1.txt')!.enqueue(new Uint8Array(1000));
    feeds.get('http://h/dl?p=/fixture/f1.txt')!.close();
    await until(() => feeds.size >= 4);
    assert.ok(feeds.has('http://h/dl?p=/fixture/f4.txt'), 'the next in line started');
    assert.equal(waiting().length, 0);
    assert.ok(!signed.includes('/fixture/f5.txt'), 'the cancelled one never asked for a URL');

    // Start f5 again, at the limit: it waits; raising the limit starts it at once.
    button(app, 'Download: f5.txt').click();
    await until(() => waiting().length === 1);
    assert.equal(waiting().length, 1, `f5 waits behind three: ${cards().join(' | ')}`);
    (app.window as unknown as { __transferLimit: (n: number) => void }).__transferLimit(4);
    await until(() => feeds.has('http://h/dl?p=/fixture/f5.txt'));
    assert.ok(feeds.has('http://h/dl?p=/fixture/f5.txt'), 'a raised limit starts the waiting one');
    assert.equal(waiting().length, 0);
    assert.equal(app.window.localStorage.getItem('tmux_transfer_limit'), '4', 'the setting is kept per device');

    // Lowered below what runs: nothing running stops.
    (app.window as unknown as { __transferLimit: (n: number) => void }).__transferLimit(1);
    await settle(app);
    assert.equal(cards().filter((t) => /%|Downloading/u.test(t) && !/Waiting/u.test(t)).length, 4, `four still run: ${cards().join(' | ')}`);
  } finally { for (const f of feeds.values()) { try { f.close(); } catch {} } await app.close(); }
});

test('one number for downloads and uploads: at limit 1 an upload waits behind a running download, then lands (#134)', async (context) => {
  let feed = null as ReadableStreamDefaultController<Uint8Array> | null;
  const begun: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    setup(window: any) {
      window.localStorage.setItem('tmux_transfer_limit', '1');
      window.URL.createObjectURL = () => 'blob:fixture';
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {};
      const click = window.HTMLInputElement.prototype.click;
      window.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type !== 'file') return click.call(this);
        Object.defineProperty(this, 'files', { value: [new window.File(['abc'], 'a.txt')], configurable: true });
        this.dispatchEvent(new window.Event('change', { bubbles: true }));
      };
      window.fetch = async (url: string, init: RequestInit) => {
        if (url.startsWith('http://gw/up/')) return new Response(null, { status: 201, headers: { 'Upload-Offset': '3' } });
        const body = new ReadableStream<Uint8Array>({ start(c) { feed = c; init.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); } });
        return new Response(body, { status: 200, headers: { 'content-length': '1000' } });
      };
    },
    modules: [rpc({
      fsDownloadHttp: async (path: string) => ({ url: `http://h/dl?p=${path}`, name: path.split('/').pop() }),
      fsUploadBegin: async (path: string) => { begun.push(path); return { id: 'u1', url: 'http://gw/up/u1', chunk: 1 << 20, received: 0 }; },
      fsUploadResume: async () => { throw new Error('no resume expected'); },
      fsUploadAbort: async () => ({ ok: true }),
    })],
  });
  const cards = () => [...app.document.querySelectorAll('.files-feedback .operation-feedback')].map((e) => e.textContent?.replace(/\s+/gu, ' ').trim() ?? '');
  const until = async (ok: () => boolean) => { for (let i = 0; i < 30 && !ok(); i++) await settle(app); };
  try {
    await settle(app);
    button(app, 'Download: f1.txt').click();
    await until(() => feed !== null);
    button(app, 'Upload files').click();
    await until(() => cards().some((t) => /Waiting a\.txt \(1\/1\)/u.test(t)));
    assert.ok(cards().some((t) => /Waiting a\.txt \(1\/1\)/u.test(t)), `the upload line says it waits: ${cards().join(' | ')}`);
    assert.deepEqual([...begun], [], 'no upload session while it waits');
    feed!.enqueue(new Uint8Array(1000)); feed!.close();
    await until(() => cards().some((t) => /Uploaded a\.txt/u.test(t)));
    assert.deepEqual([...begun], ['/fixture/a.txt']);
    assert.ok(cards().some((t) => /Uploaded a\.txt/u.test(t)), `the upload landed once the download freed the slot: ${cards().join(' | ')}`);
  } finally { try { feed?.close(); } catch {} await app.close(); }
});

// Reviewer #134 R2 (validator's probe, note 25; leader note 28): 'in progress' is ONE definition, running +
// waiting. The Downloads view re-reads its on-disk parts whenever a row leaves that group, so a waiting
// resume that is cancelled (its part deleted) is never listed as Resumable from a stale read.
test('Android Downloads: a cancelled waiting resume deletes its part and is not listed as Resumable again (#134)', async (context) => {
  const id = partId('machine-1', '/fixture/half.bin');
  const calls: string[] = [];
  let exists = true;
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
  const app = await (await nativeCompiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(w: any) {
      w.localStorage.setItem('tmux_transfer_limit', '1');
      w.__TAURI_INTERNALS__ = {};
      Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      w.fetch = async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(c) { feed = c; init.signal!.addEventListener('abort', () => c.error(init.signal!.reason)); } }),
        { status: 200, headers: { etag: '"v1"', 'content-length': '1000' } });
    },
    modules: [rpc({
      fsList: async () => ({ path: '/fixture', entries: [{ name: 'running.bin', path: '/fixture/running.bin', type: 'file', size: 1000 }] }),
      fsStat: async (path: string) => ({ path, size: 1000, is_text: false, mime_hint: 'application/octet-stream' }),
      getMachineId: () => 'machine-1',
      fsDownloadHttp: async (path: string) => ({ url: `http://h/dl?p=${path}` }),
    }), {
      invokeNative: async (cmd: string, args: { id?: string } = {}) => {
        calls.push(cmd);
        if (cmd === 'download_open') return { received: 0, etag: null };
        if (cmd === 'list_downloads') return [];
        if (cmd === 'download_list_parts') return exists ? [{ id, name: 'half.bin', path: '/fixture/half.bin', server: 'machine-1', received: 2048 }] : [];
        if (cmd === 'download_abort' && args.id === id) exists = false;
        return null;
      },
    }],
  });
  const flush = async () => { for (let i = 0; i < 15; i++) await app.flush(); };
  try {
    await flush();
    button(app, 'Download: running.bin').click();
    await flush();
    assert.ok(feed, 'the first download runs and holds the one slot');
    button(app, 'Downloads').click();
    await flush();
    button(app, 'Download again: half.bin').click();
    await flush();
    assert.equal(app.document.querySelectorAll('.downloads-list .dl-active').length, 2, 'the resume waits, in progress');
    button(app, 'Cancel: half.bin').click();
    await flush();
    assert.equal(exists, false, 'its part is deleted');
    assert.equal(app.document.querySelectorAll('.downloads-list .dl-active').length, 1);
    assert.equal(app.document.querySelector('button[aria-label="Download again: half.bin"]'), null, 'not listed as Resumable from a stale read');
  } finally { try { feed?.close(); } catch {} await app.close(); }
});
