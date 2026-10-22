import test from 'node:test';
import assert from 'node:assert/strict';
// Runes modules outside the compiler: $state / $state.raw are the value itself.
(globalThis as any).$state = Object.assign((value: unknown) => value, { raw: (value: unknown) => value });
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
const { createDownloads } = await import('./downloads.svelte.ts');
const { createFilesMemory } = await import('./files-memory.ts');
const { createViewerDownload, viewerOpen } = await import('./viewer-download.svelte.ts');
const { SUSPEND } = await import('./download.ts');

// Under node this is the plain-browser realm: a memory sink and a blob link.
const links: string[] = [];
(globalThis as any).document = {
  documentElement: { lang: 'en' },
  createElement: () => ({ click() { links.push((this as unknown as { download: string }).download); } }),
  body: { appendChild() {}, removeChild() {} },
};

/** A deferred: the test decides when a held step proceeds or fails. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const later = (ms = 0) => new Promise<void>((ok) => setTimeout(ok, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await later(5);
  assert.ok(check(), what);
}

// A getter's type narrows across asserts; read it afresh each time.
const statusOf = (r: { dl: { status: unknown } }) => (r.dl.status ?? {}) as { kind?: string; detail?: string; message?: string };

function rig() {
  const memory = createFilesMemory();
  const downloads = createDownloads();
  const signed: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const fetched: string[] = [];
  const scope = {
    state: { files: { memory, downloads } },
    runtime: {
      api: {
        fsDownload: async () => ({ data: '' }),
        fsDownloadHttp: async (path: string) => {
          signed.push(path);
          await gates.get(path)?.promise;
          return { url: `http://h/dl?p=${encodeURIComponent(path)}&sig=${signed.length}` };
        },
      },
      connection: { getMachineId: () => 'machine-1' },
    },
  };
  // The byte transfer: held while `fetchGate` is set, aborted by its signal like a real fetch.
  let fetchGate: ReturnType<typeof deferred<void>> | null = null;
  (globalThis as any).fetch = async (url: string, init: { signal?: AbortSignal }) => {
    fetched.push(url);
    if (fetchGate) {
      await new Promise<void>((ok, no) => {
        fetchGate!.promise.then(ok);
        init.signal?.addEventListener('abort', () => no(init.signal!.reason));
      });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
  };
  // The host's door: by default every open is current; a test narrows it to one record (or none).
  let door: ((record: unknown) => boolean) | null = null;
  const dl = createViewerDownload(scope as never, (record) => (door ? door(record) : true));
  return {
    only: (current: unknown) => { door = (record) => record === current; },
    dl, memory, downloads, signed, fetched, gates,
    holdSignature: (path: string) => { const g = deferred(); gates.set(path, g); return g; },
    holdBytes: () => { fetchGate = deferred(); return fetchGate; },
  };
}

test('one tap, one attempt: a second activation while the signature is pending signs once and takes no token (#447)', async () => {
  links.length = 0;
  const r = rig();
  const gate = r.holdSignature('/srv/a.png');
  const record = viewerOpen('https://h/dl?viewer', '/srv/a.png');
  assert.equal(r.signed.length, 0, 'opening the viewer signs nothing for a download');
  r.dl.start(record);
  r.dl.start(record);                 // click and keyboard in the same tick
  r.dl.start(record);
  assert.equal(r.dl.busy(record), true, 'the control is hidden from the first activation');
  await later(5);
  assert.equal(r.signed.length, 1, 'ONE signature for the three activations');
  assert.equal(r.downloads.rows.length, 1, 'one row, one transfer');
  const during = r.dl.status!;
  assert.equal(during.kind, 'progress', 'the first attempt keeps its feedback while the others are ignored');
  gate.resolve();
  await until(() => !r.dl.busy(record), 'the attempt ends');
  assert.equal(links.length, 1);
  assert.equal(statusOf(r).message, 'Download requested');
});

test('an open with no server file offers nothing and signs nothing (#447)', async () => {
  const r = rig();
  const record = viewerOpen('blob:local', null);
  r.dl.start(record);
  r.dl.start(null);
  await later(5);
  assert.deepEqual(r.signed, []);
  assert.equal(r.dl.busy(record), false);
  assert.equal(r.dl.status, null);
});

test('A held, the viewer closes, B opens: A\'s late failure never lands on B, and B reads its own row (#447)', async () => {
  const r = rig();
  const gateA = r.holdSignature('/srv/a.png');
  r.holdSignature('/srv/b.png');
  const a = viewerOpen('u-a', '/srv/a.png');
  const b = viewerOpen('u-b', '/srv/b.png');
  r.dl.start(a);
  await later(5);
  r.dl.retire();                      // close
  assert.equal(r.dl.status, null);
  assert.equal(r.dl.busy(a), false);
  r.dl.start(b);
  await later(5);
  assert.equal(statusOf(r).kind, 'progress');
  assert.equal(statusOf(r).detail, '/srv/b.png', 'B shows the progress of the row B began, not the newest row of anything else');
  gateA.reject(new Error('A is gone'));
  await until(() => r.downloads.rows.some((row) => row.path === '/srv/a.png' && row.state === 'failed'), 'A fails in the record');
  assert.equal(statusOf(r).kind, 'progress', 'A\'s error did not replace B\'s feedback');
  assert.equal(statusOf(r).detail, '/srv/b.png');
});

test('A, close, A again: the old attempt is silent and the new open starts its own (#447)', async () => {
  const r = rig();
  const first = r.holdSignature('/srv/a.png');
  const one = viewerOpen('u1', '/srv/a.png');
  r.dl.start(one);
  await later(5);
  r.dl.retire();
  const two = viewerOpen('u2', '/srv/a.png');
  assert.equal(r.dl.busy(two), false, 'a reopened viewer is a new open');
  first.reject(new Error('too late'));
  await later(20);
  assert.equal(r.dl.status, null, 'the first open\'s failure never reaches the second');
});

test('the host going away does not stop the transfer: the row finishes, nothing is said, nothing throws (#447)', async () => {
  links.length = 0;
  const r = rig();
  const gate = r.holdSignature('/srv/a.png');
  const record = viewerOpen('u', '/srv/a.png');
  r.dl.start(record);
  await later(5);
  r.dl.dispose();
  gate.resolve();
  await until(() => r.downloads.rows[0]?.state === 'done', 'the transfer completes into the record');
  assert.equal(links.length, 1);
  assert.equal(r.dl.status, null, 'a disposed host shows nothing');
});

test('a runtime being released suspends the viewer\'s transfer: no re-sign, nothing said (#447)', async () => {
  const r = rig();
  const bytes = r.holdBytes();
  const record = viewerOpen('u', '/srv/a.png');
  r.dl.start(record);
  await until(() => r.fetched.length === 1, 'the bytes are requested');
  await r.memory.suspend(SUSPEND);
  bytes.resolve();
  await until(() => !r.dl.busy(record), 'the attempt ends');
  assert.equal(r.signed.length, 1, 'a suspended transfer asks for no fresh signature');
  assert.deepEqual(r.downloads.rows, [], 'a suspend takes the row with the rest of the server\'s memory');
  assert.equal(r.dl.status, null);
});

test('retire ends the display only: the transfer keeps running in the record (#447)', async () => {
  const r = rig();
  const bytes = r.holdBytes();
  const record = viewerOpen('u', '/srv/a.png');
  r.dl.start(record);
  await until(() => r.fetched.length === 1, 'the bytes are requested');
  r.dl.retire();
  assert.equal(r.dl.status, null);
  assert.equal(r.downloads.rows[0]?.state, 'downloading', 'the row is the runtime\'s and carries on');
  bytes.resolve();
  await until(() => r.downloads.rows[0]?.state === 'done', 'and finishes');
});

test('a handler kept from a closed, replaced or hidden viewer starts nothing and takes no token (#447 review P1-A)', async () => {
  links.length = 0;
  const r = rig();
  const a = viewerOpen('u-a', '/srv/a.png');
  const b = viewerOpen('u-b', '/srv/b.png');
  const gateB = r.holdSignature('/srv/b.png');
  // A is current, runs and finishes; the viewer is then closed (the host's open is none).
  r.only(a);
  r.dl.start(a);
  await until(() => !r.dl.busy(a), 'A finishes');
  r.dl.retire();
  r.only(null);
  const signedAfterA = r.signed.length;
  r.dl.start(a);                                   // the old handler, called after the close
  await later(10);
  assert.equal(r.signed.length, signedAfterA, 'no signature for a closed viewer');
  assert.equal(r.dl.status, null);
  // B opens and is held at its signature; A's old handler is called again: B keeps its own feedback.
  r.only(b);
  r.dl.start(b);
  await later(5);
  assert.equal(statusOf(r).detail, '/srv/b.png');
  r.dl.start(a);
  await later(10);
  assert.equal(r.signed.length, signedAfterA + 1, 'only B signed');
  assert.equal(statusOf(r).detail, '/srv/b.png', 'A\'s stale call took no token: B\'s feedback stands');
  // The host stops being active (the door answers no): B's own handler is refused too.
  gateB.resolve();
  await until(() => !r.dl.busy(b), 'B finishes');
  r.only(null);
  const before = r.signed.length;
  r.dl.start(b);
  await later(10);
  assert.equal(r.signed.length, before, 'an inactive host starts nothing');
});
