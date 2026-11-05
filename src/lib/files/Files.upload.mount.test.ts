import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #474 (owner 2026-10-27: "安卓下面上传文件时，传上去的文件原始文件名都没有了，
// 好像都被重写了，包括后缀也没有了"): the Android app's dialog plugin returns
// content:// URIs, and the upload was named by the URI's last segment, an
// opaque document id. The Android app now picks through the WebView's own
// chooser (File objects named by DISPLAY_NAME); only the desktop app picks
// paths through the plugin. The Tauri packages are one recording stand-in.
const standIn = new URL('../test/tauri-stand-in.ts', import.meta.url);
const compiled = compileMount(new URL('./Files.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], {
  serverScope: true,
  standIns: Object.fromEntries(['@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs', '@tauri-apps/plugin-opener', '@tauri-apps/api/path', '@tauri-apps/api/webview']
    .map((s) => [s, standIn])),
});
const entries = [{ name: 'AGENTS.md', path: '/fixture/AGENTS.md', type: 'file', size: 1200 }];
// The HTTP upload channel (board #23), recorded: begin names the destination,
// each PUT appends at its offset, the last byte commits `{path, data}`.
type Uploads = { path: string; data: string }[];
function channel(uploads: Uploads) {
  const live = new Map<string, { path: string; size: number; bytes: number[] }>();
  let n = 0;
  return {
    rpc: {
      fsUploadBegin: async (path: string, size: number) => {
        const id = `u${++n}`;
        live.set(id, { path, size, bytes: [] });
        return { id, url: `http://gw/up/${id}`, chunk: 4 * 1024 * 1024, received: 0 };
      },
      fsUploadResume: async () => { throw new Error('no resume expected'); },
      fsUploadAbort: async () => ({ ok: true }),
    },
    fetch: async (url: string, init: RequestInit) => {
      const id = url.split('/').pop()!;
      const u = live.get(id)!;
      // A File's slice is the realm's Blob; a native read is a Uint8Array.
      const raw = init.body as Blob | Uint8Array;
      const body = typeof (raw as Blob).arrayBuffer === "function" ? new Uint8Array(await (raw as Blob).arrayBuffer()) : Uint8Array.from(raw as Uint8Array);
      u.bytes.push(...body);
      if (u.bytes.length === u.size) uploads.push({ path: u.path, data: Buffer.from(u.bytes).toString('base64') });
      return new Response(null, { status: u.bytes.length === u.size ? 201 : 204, headers: { 'Upload-Offset': String(u.bytes.length) } });
    },
  };
}
const rpc = (uploads: Uploads, extra: Record<string, unknown>) => ({
  fsCwd: async () => ({ path: '/fixture' }),
  fsList: async () => ({ path: '/fixture', entries }),
  fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' }),
  fsRead: async () => ({ content: '# Rules' }),
  projectList: async () => ({ projects: [] }),
  getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
  saveBookmarks: async () => ({}), setPref: async () => ({}),
  gitCmd: async () => ({ code: 0, stdout: '.git' }),
  ...extra,
});
type Realm = { calls: { fn: string; args: unknown[] }[]; pick: unknown; files: Record<string, Uint8Array> };
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** What the WebView's chooser hands back: Files named by the provider's
 * DISPLAY_NAME. `null` is a cancelled chooser (no change event at all). */
function picker(window: any, picks: () => File[] | null) {
  const click = window.HTMLInputElement.prototype.click;
  window.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (this.type !== 'file') return click.call(this);
    const files = picks();
    if (!files) return;
    Object.defineProperty(this, 'files', { value: files, configurable: true });
    this.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
}

async function mount(context: any, host: 'android' | 'desktop', picks: (w: any) => File[] | null, uploads: { path: string; data: string }[]) {
  const ch = channel(uploads);
  return (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' },
    // The native bridge (downloads, the file opener) is not this test's: it stays pending.
    pendingImports: ['@tauri-apps/api/core'],
    modules: [rpc(uploads, ch.rpc)],
    setup(window: any) {
      window.fetch = ch.fetch;
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      if (host === 'android') Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      window.localStorage.setItem('tmux_layout_mode', 'desktop');
      window.localStorage.setItem('tmux_locale', 'en');
      picker(window, () => picks(window));
    },
  });
}
const settle = async (app: any) => { for (let i = 0; i < 8; i++) await app.flush(); };
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(app: any, ok: () => boolean) { for (let i = 0; i < 60 && !ok(); i++) { await macrotask(); await app.flush(); } }
const upload = (app: any) => app.document.querySelector('button[aria-label="Upload files"]') as HTMLButtonElement;
const feedback = (app: any) => app.document.querySelector('.files-feedback [role=status], .files-feedback [role=alert]')?.textContent ?? '';

test('the Android app (isAndroid and isTauri both true) uploads through the WebView picker: names with CJK, spaces and several dots keep their extension; the plugin is never asked (#474)', async (context) => {
  const uploads: { path: string; data: string }[] = [];
  const app = await mount(context, 'android', (w) => [
    new w.File(['abc'], '会议纪要 第2版.docx'), new w.File(['defg'], 'notes v2.tar.gz'), new w.File(['h'], 'IMG_20261027_182501.jpg'),
  ], uploads);
  try {
    await settle(app);
    const realm = (app.window as any).__tauri as Realm;
    assert.ok(upload(app)); upload(app).click();
    await until(app, () => uploads.length === 3 && /uploaded/i.test(feedback(app)));
    assert.deepEqual(uploads.map((u) => u.path), ['/fixture/会议纪要 第2版.docx', '/fixture/notes v2.tar.gz', '/fixture/IMG_20261027_182501.jpg'],
      'each upload is named by the picked File.name, extension included');
    assert.deepEqual(uploads.map((u) => u.data), [b64('abc'), b64('defg'), b64('h')], 'the content is the file\u2019s, unchanged');
    assert.match(feedback(app), /Uploaded 3 files/, 'the batch\u2019s own success line');
    assert.deepEqual([...realm.calls.filter((c) => /^(dialog|fs)\./u.test(c.fn))], [], 'no native dialog, no native file read on Android');
    assert.equal(realm.calls.some((c) => c.fn === 'webview.onDragDropEvent'), false, 'no native drop listener on Android');
  } finally { await app.close(); }
});

test('the Android app: cancelled choosers upload nothing and leave nothing behind; a pick after them uploads, and the same file twice uploads twice (#474 review P2-A)', async (context) => {
  const uploads: { path: string; data: string }[] = [];
  let next: (w: any) => File[] | null = () => null;
  const app = await mount(context, 'android', (w) => next(w), uploads);
  try {
    await settle(app);
    const inputs = () => app.document.querySelectorAll('input[type=file]').length;
    const before = inputs();
    for (let i = 0; i < 3; i++) { upload(app).click(); await settle(app); }
    for (let i = 0; i < 10; i++) { await macrotask(); await app.flush(); }
    assert.equal(uploads.length, 0, 'a cancel uploads nothing');
    assert.equal(feedback(app), '', 'no line for a pick that never happened');
    assert.equal(inputs(), before, 'three cancels add no input: the one hidden input is reused');
    next = (w) => [new w.File(['x'], 'report.pdf')];
    upload(app).click();
    await until(app, () => uploads.length === 1);
    upload(app).click();
    await until(app, () => uploads.length === 2);
    assert.deepEqual(uploads.map((u) => u.path), ['/fixture/report.pdf', '/fixture/report.pdf'], 'after the cancels a pick uploads; the same file again uploads again');
    assert.equal(inputs(), before, 'and still no input was added');
  } finally { await app.close(); }
});

test('the desktop app keeps the dialog plugin: a picked PATH uploads under its own file name, read through the fs plugin in chunks (#474, #23)', async (context) => {
  const uploads: { path: string; data: string }[] = [];
  const app = await mount(context, 'desktop', () => { throw new Error('the desktop app must not use the HTML picker'); }, uploads);
  try {
    await settle(app);
    const realm = (app.window as any).__tauri as Realm;
    realm.pick = ['/Users/me/Docs/报告 v1.final.pdf'];
    realm.files['/Users/me/Docs/报告 v1.final.pdf'] = new TextEncoder().encode('pdf');
    upload(app).click();
    await until(app, () => uploads.length === 1);
    assert.deepEqual(uploads, [{ path: '/fixture/报告 v1.final.pdf', data: b64('pdf') }]);
    assert.deepEqual([...realm.calls.filter((c) => /^(dialog|fs)\./u.test(c.fn)).map((c) => c.fn)], ['dialog.open', 'fs.stat', 'fs.open', 'fs.seek', 'fs.close'],
      'the size from a stat, the bytes from a positioned read of a handle: never a whole-file readFile (#23)');
  } finally { await app.close(); }
});
