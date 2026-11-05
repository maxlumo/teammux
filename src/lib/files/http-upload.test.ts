import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile, UploadCancelled, UploadFailed, type UploadApi } from './http-upload.ts';

// A fake gateway with the server's rules (src-tauri/src/server/upload.rs):
// only the next offset is accepted, a 409 names where to resume, the last
// byte commits with 201. `faults` lets a test cut the connection.
function gateway(size: number, opts: { chunk?: number } = {}) {
  const chunk = opts.chunk ?? 4;
  const g = {
    bytes: [] as number[],
    received: 0,
    committed: false,
    aborted: false,
    urlSerial: 0,
    puts: [] as { offset: number; len: number }[],
    /** Called before each PUT is answered; return 'drop' to fail it as a network error
     * after keeping `keep` of its bytes, as a cut body does on the server. */
    fault: null as null | ((n: number) => { drop: true; keep: number } | null),
    api: null as unknown as UploadApi,
    fetch: null as unknown as typeof fetch,
  };
  g.api = {
    begin: async (_path, s) => { assert.equal(s, size); return { id: 'u1', url: `http://gw/up/u1?v=${g.urlSerial++}`, chunk, received: 0 }; },
    resume: async (id) => { assert.equal(id, 'u1'); return { url: `http://gw/up/u1?v=${g.urlSerial++}`, received: g.received }; },
    abort: async () => { g.aborted = true; g.bytes = []; return { ok: true }; },
  };
  g.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'PUT');
    if (g.aborted) return new Response(null, { status: 403 });
    const offset = Number((init.headers as Record<string, string>)['Upload-Offset']);
    const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    g.puts.push({ offset, len: body.length });
    const f = g.fault?.(g.puts.length);
    if (f) {
      if (offset === g.received) { g.bytes.push(...body.slice(0, f.keep)); g.received += f.keep; }
      throw new TypeError('Failed to fetch');
    }
    if (offset !== g.received) return new Response(null, { status: 409, headers: { 'Upload-Offset': String(g.received) } });
    g.bytes.push(...body);
    g.received += body.length;
    if (g.received === size) g.committed = true;
    return new Response(null, { status: g.committed ? 201 : 204, headers: { 'Upload-Offset': String(g.received) } });
  }) as unknown as typeof fetch;
  return g;
}

const file = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const sourceOf = (bytes: Uint8Array) => async (start: number, end: number) => bytes.slice(start, end);
const noSleep = async () => {};

test('the file goes in chunks, and progress moves by the bytes the server holds', async () => {
  const src = file(10);
  const g = gateway(10);
  const seen: [number, number][] = [];
  await uploadFile({ dest: '/w/a.bin', size: 10, source: sourceOf(src), api: g.api, fetch: g.fetch, sleep: noSleep,
    onProgress: (sent, total) => seen.push([sent, total]) });
  assert.deepEqual(g.puts, [{ offset: 0, len: 4 }, { offset: 4, len: 4 }, { offset: 8, len: 2 }]);
  assert.deepEqual(seen, [[0, 10], [4, 10], [8, 10], [10, 10]]);
  assert.ok(g.committed);
  assert.deepEqual(g.bytes, [...src]);
});

test('a dropped connection resumes from what the server kept and completes', async () => {
  const src = file(10);
  const g = gateway(10);
  g.fault = (n) => (n === 2 ? { drop: true, keep: 1 } : null); // the second chunk dies after 1 byte
  const seen: number[] = [];
  await uploadFile({ dest: '/w/a.bin', size: 10, source: sourceOf(src), api: g.api, fetch: g.fetch, sleep: noSleep,
    onProgress: (sent) => seen.push(sent) });
  assert.deepEqual(g.puts.map((p) => p.offset), [0, 4, 5, 9], 'resumed at the 5th byte, not from zero');
  assert.deepEqual(seen, [0, 4, 5, 9, 10], 'progress never goes back');
  assert.ok(g.committed);
  assert.deepEqual(g.bytes, [...src]);
  assert.equal(g.urlSerial, 2, 'the resume minted a fresh URL');
});

test('a 409 moves to the offset the server names', async () => {
  const src = file(6);
  const g = gateway(6);
  g.received = 0;
  let first = true;
  const fetch409 = (async (url: string, init: RequestInit) => {
    if (first) { first = false; g.bytes.push(...src.slice(0, 4)); g.received = 4; } // an earlier PUT the client never heard back from
    return g.fetch(url, init);
  }) as unknown as typeof fetch;
  await uploadFile({ dest: '/w/a', size: 6, source: sourceOf(src), api: g.api, fetch: fetch409, sleep: noSleep });
  assert.deepEqual(g.puts.map((p) => p.offset), [0, 4]);
  assert.deepEqual(g.bytes, [...src]);
});

test('repeated failures with no progress fail naming the reason, and a retry resumes the same upload', async () => {
  const src = file(8);
  const g = gateway(8);
  g.fault = (n) => (n >= 2 ? { drop: true, keep: 0 } : null);
  const err = await uploadFile({ dest: '/w/a', size: 8, source: sourceOf(src), api: g.api, fetch: g.fetch, sleep: noSleep, maxStalls: 3 })
    .then(() => null, (e) => e);
  assert.ok(err instanceof UploadFailed, String(err));
  assert.equal(err.id, 'u1');
  assert.match(err.message, /Failed to fetch/);
  assert.equal(g.received, 4);
  g.fault = null;
  await uploadFile({ dest: '/w/a', size: 8, source: sourceOf(src), api: g.api, fetch: g.fetch, sleep: noSleep, resumeId: err.id });
  assert.ok(g.committed);
  assert.deepEqual(g.bytes, [...src]);
});

test('cancel stops sending and aborts the upload on the server', async () => {
  const src = file(12);
  const g = gateway(12);
  const ctl = new AbortController();
  const err = await uploadFile({ dest: '/w/a', size: 12, source: sourceOf(src), api: g.api, fetch: g.fetch, sleep: noSleep,
    signal: ctl.signal, onProgress: (sent) => { if (sent === 4) ctl.abort(); } }).then(() => null, (e) => e);
  assert.ok(err instanceof UploadCancelled, String(err));
  assert.ok(g.aborted, 'the server was told, so it removes the part file');
  assert.equal(g.puts.length, 1, 'no chunk after the cancel');
  assert.ok(!g.committed);
});

test('an empty file is done at begin', async () => {
  let fetched = false;
  const api: UploadApi = {
    begin: async () => ({ id: 'e', url: '', chunk: 4, received: 0, done: true }),
    resume: async () => { throw new Error('no'); }, abort: async () => ({}),
  };
  const seen: number[] = [];
  await uploadFile({ dest: '/w/e', size: 0, source: async () => new Uint8Array(), api,
    fetch: (async () => { fetched = true; }) as unknown as typeof fetch, onProgress: (s, t) => seen.push(s, t) });
  assert.equal(fetched, false);
  assert.deepEqual(seen, [0, 0]);
});
