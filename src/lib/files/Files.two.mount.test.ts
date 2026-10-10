import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #305 (validator's probe, kept as a test): the in-flight guard must
// span Files instances. Start a download in the page's Files, then the same file in the
// drawer's Files, in ONE realm against ONE fake part store (downloads.rs
// semantics: one append-only part per id).
// One server's scope around both instances: the page and the drawer share that
// server's Files record, which is what this file is about (②b-2-1).
const two = compileMount(new URL('./Files.two.test.svelte', import.meta.url),
  [new URL('../core/ws.ts', import.meta.url), new URL('../core/native.ts', import.meta.url)], { serverScope: true });
const entries = [{ name: 'AGENTS.md', path: '/fixture/AGENTS.md', type: 'file', size: 1200 }];

test('two Files instances downloading one file write one part once', async context => {
  const size = 4 * 1024 * 1024;
  const feeds: ReadableStreamDefaultController<Uint8Array>[] = [];
  const parts = new Map<string, number[]>();
  const saved: number[][] = [];
  const file = new Uint8Array(size).map((_, i) => (i * 7) & 0xff);
  const opens: string[] = [];
  const app = await (await two).mount(context, {
    props: { visible: true, session: 'fixture' },
    pendingImports: ['@tauri-apps/'],
    setup(window) {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
      Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) fixture' });
      (window as any).fetch = async () => {
        const body = new ReadableStream<Uint8Array>({ start(c) { feeds.push(c); } });
        return new Response(body, { status: 200, headers: { etag: '"v1"', 'content-length': String(size) } });
      };
    },
    modules: [
      {
        fsCwd: async () => ({ path: '/fixture' }),
        fsList: async () => ({ path: '/fixture', entries }),
        fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 100, mime_hint: 'text/markdown' }),
        fsRead: async () => ({ content: '# Rules' }),
        getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}),
        saveBookmarks: async () => ({}), setPref: async () => ({}),
        gitCmd: async () => ({ code: 0, stdout: '.git' }),
        getMachineId: () => 'machine-1',
        fsDownloadHttp: async () => ({ url: 'http://h/dl?path=x', name: 'AGENTS.md' }),
      },
      { invokeNative: async (cmd: string, args: Record<string, any> = {}) => {
        const id = args.id as string;
        if (cmd === 'download_open') { opens.push(id); return { received: parts.get(id)?.length ?? 0, etag: parts.has(id) ? '"v1"' : null }; }
        if (cmd === 'download_reset') { parts.set(id, []); return null; }
        if (cmd === 'download_chunk') { if (!parts.has(id)) throw new Error('open part: not found'); const p = parts.get(id)!; const raw = atob(args.data); for (let i = 0; i < raw.length; i++) p.push(raw.charCodeAt(i)); return null; }
        if (cmd === 'download_finish') { if (!parts.has(id)) throw new Error('save: not found'); saved.push(parts.get(id)!); parts.delete(id); return '/storage/emulated/0/Download/TmuxMobile/AGENTS.md'; }
        if (cmd === 'download_abort') { parts.delete(id); return null; }
        return [];
      } },
    ],
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await app.flush(); };
  const btn = (root: string) => app.document.querySelector<HTMLButtonElement>(`${root} button[aria-label="Download: AGENTS.md"]`);
  try {
    for (let i = 0; i < 20 && !(btn('.page') && btn('.drawer')); i++) await settle();
    assert.ok(btn('.page') && btn('.drawer'), 'both instances list the file');
    btn('.page')!.click();
    for (let i = 0; i < 20 && feeds.length < 1; i++) await settle();
    feeds[0]!.enqueue(file.slice(0, size / 2)); await settle();
    btn('.drawer')!.click();                       // same file, the other Files
    for (let i = 0; i < 20 && feeds.length < 2; i++) await settle();
    assert.match(app.document.querySelector('.drawer .operation-feedback')?.textContent ?? '', /Already downloading/u,
      'the other Files says so instead of starting a second writer');
    feeds[0]!.enqueue(file.slice(size / 2)); feeds[0]!.close(); for (const f of feeds.slice(1)) { f.enqueue(file); f.close(); }
    for (let i = 0; i < 60; i++) await settle();
    assert.equal(feeds.length, 1, 'one transfer for one file');
    assert.equal(opens.length, 1, 'one download_open: one writer');
    assert.equal(saved.length, 1);
    assert.ok(saved[0]!.length === size && saved[0]!.every((x, i) => x === file[i]), `the saved file is intact (${saved[0]!.length} bytes)`);
    assert.match(app.document.querySelector('.page .operation-feedback')?.textContent ?? '', /Saved/u, 'the page that started it reports the save');

  } finally { for (const f of feeds) { try { f.close(); } catch {} } await app.close(); }
});
