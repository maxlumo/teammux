import test from 'node:test';
import assert from 'node:assert/strict';
// The record is a runes module; outside the compiler $state is the value itself.
(globalThis as any).$state = (value: unknown) => value;
const { createDownloads } = await import('./downloads.svelte.ts');
const { createFilesMemory } = await import('./files-memory.ts');
const { saveServerFile, realmReady } = await import('./save-file.ts');
const { SUSPEND } = await import('./download.ts');
import type { SaveDeps, SaveOutcome } from './save-file.ts';

// Under node this is the plain-browser realm (no Tauri): no part id, a web row id.
function rig(over: Partial<SaveDeps> = {}) {
  const memory = createFilesMemory();
  const store = createDownloads();
  const said: string[] = [];
  const say: SaveOutcome = {
    inProgress: (p) => said.push(`inProgress ${p}`),
    saved: (p) => said.push(`saved ${p}`),
    kept: (n) => said.push(`kept ${n}`),
    requested: (n) => said.push(`requested ${n}`),
    error: (m, p) => said.push(`error ${m} ${p}`),
  };
  const deps: SaveDeps = {
    memory, store,
    fsDownload: async () => ({ data: '' }),
    fsDownloadHttp: async () => ({ url: 'http://h/dl?x' }),
    getMachineId: () => 'machine-1',
    ...over,
  };
  return { deps, memory, store, said, say };
}

test('a record being released refuses the attempt: no row, no RPC, nothing said (#335 2b-2-3, #447)', async () => {
  let asked = 0;
  const r = rig({ fsDownloadHttp: async () => { asked++; return { url: 'x' }; } });
  r.memory.seal('release');
  await saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  assert.equal(asked, 0);
  assert.deepEqual(r.store.rows, []);
  assert.deepEqual(r.said, []);
});

test('a failed signature is one error to the asker, a failed row, and nothing left tracked (#447)', async () => {
  const r = rig({ fsDownloadHttp: async () => { throw new Error('no such file'); } });
  await saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  assert.deepEqual(r.said, ['error no such file /srv/a.png']);
  assert.equal(r.store.rows.length, 1);
  assert.equal(r.store.rows[0]!.state, 'failed');
  assert.equal(r.store.rows[0]!.name, 'a.png');
  // The attempt untracked itself: a suspend has nothing to wait for.
  await r.memory.suspend('switch');
});

test('a cancel while the signature is pending says nothing and takes the row with it (#447)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const r = rig({ fsDownloadHttp: async () => { await gate; return { url: 'http://h/dl?x' }; } });
  const attempt = saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  await realmReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(r.store.rows.length, 1, 'the row exists while the signature is asked for');
  r.memory.abort(r.store.rows[0]!.id);
  release();
  await attempt;
  assert.deepEqual(r.said, []);
  assert.deepEqual(r.store.rows, []);
});

// Board #447 review P1-B: the attempt awaits a preparation (realmReady) AFTER it is tracked. A runtime's
// suspend or a Cancel that arrives while it is held must end the attempt there, before any RPC or fetch.
function counted() {
  const seen = { http: 0, rpc: 0, fetch: 0 };
  (globalThis as any).fetch = async () => { seen.fetch++; return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-length': '1' } }); };
  (globalThis as any).document ??= { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } };
  return {
    seen,
    over: {
      fsDownloadHttp: async () => { seen.http++; return { url: 'http://h/dl?x' }; },
      fsDownload: async () => { seen.rpc++; return { data: '' }; },
    } as Partial<SaveDeps>,
  };
}
const flush = () => new Promise<void>((ok) => setTimeout(ok, 5));

test('a runtime suspend while the preparation is held: no signature, no RPC, no fetch, and the attempt settles silently (#447)', async () => {
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const c = counted();
  const r = rig({ ...c.over, ready: () => held });
  const attempt = saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  await flush();
  assert.equal(r.store.rows.length, 1, 'tracked and rowed before the preparation');
  const suspended = r.memory.suspend(SUSPEND);      // the removal waits for the attempt to settle
  release();
  await Promise.all([attempt, suspended]);
  assert.deepEqual(c.seen, { http: 0, rpc: 0, fetch: 0 });
  assert.deepEqual(r.said, [], 'no Saved, no error');
  assert.deepEqual(r.store.rows, [], 'a suspend takes the row with the rest of the server\'s memory');
});

test('a Cancel while the preparation is held ends the attempt before any RPC or fetch (#447)', async () => {
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const c = counted();
  const r = rig({ ...c.over, ready: () => held });
  const attempt = saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  await flush();
  r.memory.abort(r.store.rows[0]!.id);
  release();
  await attempt;
  assert.deepEqual(c.seen, { http: 0, rpc: 0, fetch: 0 });
  assert.deepEqual(r.said, []);
  assert.deepEqual(r.store.rows, []);
});

test('the control: the same held preparation with nobody stopping it goes on to sign, fetch and finish (#447)', async () => {
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const c = counted();
  const r = rig({ ...c.over, ready: () => held });
  const attempt = saveServerFile(r.deps, '/srv/a.png', {}, r.say);
  await flush();
  release();
  await attempt;
  assert.equal(c.seen.http, 1);
  assert.equal(c.seen.fetch, 1);
  assert.deepEqual(r.said, ['requested a.png']);
});
