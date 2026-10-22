import test from 'node:test';
import assert from 'node:assert/strict';
// Board #447: the cross-entry rules that only exist where a part id does — a Tauri shell. node runs each
// test file in its own process, so this file can BE an Android shell: the marker globals are set before
// the platform module is first read, and the Rust commands are a fake behind the shell's own `invoke`.
const nativeCalls: string[] = [];
(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string) => {
      nativeCalls.push(cmd);
      if (cmd === 'download_open') return { received: 0, etag: null };
      if (cmd === 'download_finish') return '/storage/emulated/0/Download/TmuxMobile/a.png';
      return null;
    },
  },
};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)' }, configurable: true });
(globalThis as any).$state = Object.assign((value: unknown) => value, { raw: (value: unknown) => value });
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
(globalThis as any).document = { documentElement: { lang: 'en' } };
(globalThis as any).fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3', etag: '"v1"' } });

const { isAndroid, isTauri } = await import('../core/platform.ts');
const { createDownloads } = await import('./downloads.svelte.ts');
const { createFilesMemory } = await import('./files-memory.ts');
const { createViewerDownload, viewerOpen } = await import('./viewer-download.svelte.ts');
const { saveServerFile } = await import('./save-file.ts');

const later = (ms = 0) => new Promise<void>((ok) => setTimeout(ok, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await later(5);
  assert.ok(check(), what);
}
function rig() {
  const memory = createFilesMemory();
  const downloads = createDownloads();
  const signed: string[] = [];
  let hold: Promise<void> | null = null;
  const api = {
    fsDownload: async () => ({ data: '' }),
    fsDownloadHttp: async (path: string) => { signed.push(path); await hold; return { url: `http://h/dl?p=${encodeURIComponent(path)}` }; },
  };
  const scope = { state: { files: { memory, downloads } }, runtime: { api, connection: { getMachineId: () => 'machine-1' } } };
  const said: string[] = [];
  const files = {
    inProgress: (p: string) => said.push(`inProgress ${p}`), saved: (p: string) => said.push(`saved ${p}`),
    kept: (n: string) => said.push(`kept ${n}`), requested: (n: string) => said.push(`requested ${n}`),
    error: (m: string) => said.push(`error ${m}`),
  };
  return {
    memory, downloads, signed, said, files, scope,
    dl: createViewerDownload(scope as never),
    deps: { memory, store: downloads, fsDownload: api.fsDownload, fsDownloadHttp: api.fsDownloadHttp, getMachineId: () => 'machine-1' },
    holdSignatures: () => { let release!: () => void; hold = new Promise<void>((ok) => { release = ok; }); return () => { hold = null; release(); }; },
  };
}

test('the fixture really is an Android shell (so the writer claim exists)', () => {
  assert.equal(isTauri, true);
  assert.equal(isAndroid, true);
});

test('Files holds a file, the viewer asks for the same file: "Already downloading" in the viewer, one signature, one row (#447)', async () => {
  const r = rig();
  const release = r.holdSignatures();
  const filesOwner = {};
  const first = saveServerFile(r.deps, '/srv/a.png', filesOwner, r.files);
  await later(5);
  const open = viewerOpen('u', '/srv/a.png');
  r.dl.start(open);
  await later(10);
  assert.equal(r.dl.status?.message, 'Already downloading', 'the second caller is told, where it asked');
  assert.equal(r.signed.length, 1, 'only the first attempt signed');
  assert.equal(r.downloads.rows.length, 1, 'one transfer, one row');
  release();
  await first;
  assert.deepEqual(r.said, ['saved /storage/emulated/0/Download/TmuxMobile/a.png'], 'and the first caller still gets its own outcome');
});

test('the same image after close and reopen is a different owner: the new viewer says it is already downloading (#447)', async () => {
  const r = rig();
  const release = r.holdSignatures();
  const one = viewerOpen('u1', '/srv/a.png');
  r.dl.start(one);
  await later(5);
  r.dl.retire();                                   // the viewer is closed; the transfer is the runtime's and runs on
  const two = viewerOpen('u2', '/srv/a.png');
  assert.equal(r.dl.busy(two), false, 'a reopened viewer is offered the control');
  r.dl.start(two);
  await later(10);
  assert.equal(r.dl.status?.message, 'Already downloading');
  assert.equal(r.signed.length, 1, 'no second transfer of the same part');
  assert.equal(r.downloads.rows.length, 1);
  release();
  await until(() => r.downloads.rows[0]?.state === 'done', 'the first attempt finishes into the record');
});

test('the same owner asking twice starts nothing and says nothing; and the saved path reaches the viewer that asked (#447)', async () => {
  const r = rig();
  const owner = {};
  await saveServerFile(r.deps, '/srv/b.png', owner, r.files);
  assert.deepEqual(r.said, ['saved /storage/emulated/0/Download/TmuxMobile/a.png']);
  const release = r.holdSignatures();
  const held = saveServerFile(r.deps, '/srv/b.png', owner, r.files);
  await later(5);
  const before = r.said.length;
  await saveServerFile(r.deps, '/srv/b.png', owner, r.files);
  assert.equal(r.said.length, before, 'the same owner\'s repeat is silent');
  release();
  await held;
  const open = viewerOpen('u', '/srv/c.png');
  r.dl.start(open);
  await until(() => r.dl.status?.kind === 'result', 'the viewer\'s own attempt ends with the saved path');
  assert.equal(r.dl.status?.detail, '/storage/emulated/0/Download/TmuxMobile/a.png');
});
