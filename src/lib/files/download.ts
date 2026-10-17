// ONE download core for every shell (board #305). The bytes stream from the
// signed `/dl` URL straight into a SINK; only the sink differs per shell:
//
//   Android / macOS — `nativeSink`: base64 pieces to the Rust `download_*`
//     commands, which append to a hidden `.part` next to its server ETag and
//     move it into place at the end. A part survives the app, so a later
//     download of the same file resumes where the last one stopped.
//   Browser — `memorySink`: no filesystem to keep a part in, so the file is
//     held in memory and handed to `<a download>`; resume works only within
//     this attempt (retries after a network blip).
//
// Why pieces and not one buffer: Tauri 2 on Android has no binary IPC
// (`ipc-protocol.js`: `canUseCustomProtocol = osName !== 'android'`), so a
// Uint8Array argument is JSON-encoded as one number per byte. An 89 MB file
// became an 89-million-element array and ~318 million JSON characters, and the
// phone failed with "Invalid array length" (owner, 2026-10-04).
//
// Resume rule: ask for `Range: bytes=<received>-` with `If-Range: <etag>`.
// 206 → the server still has that version, continue. 200 → the file changed
// (or the server ignored Range): reset the sink for the new ETag and start at
// byte 0. The server side is `/dl` in src-tauri/src/server/download.rs.

export interface PartState { received: number; etag: string | null }

export interface DownloadSink {
  /** What an earlier attempt left for this file. */
  open(): Promise<PartState>;
  /** Start over for the version `etag` names (null: the server sent none). */
  reset(etag: string | null): Promise<void>;
  /** The next bytes, in order. */
  write(bytes: Uint8Array): Promise<void>;
  /** Everything arrived: flush what is still buffered. */
  flush(): Promise<void>;
}

export interface DownloadOptions {
  url: string;
  /** A fresh signed URL: the plain /dl signature lives 60 s. */
  freshUrl: () => Promise<string>;
  sink: DownloadSink;
  /** fraction 0–1 (null while the total is unknown), and the bytes. */
  onProgress?: (fraction: number | null, received: number, total: number) => void;
  /** A part was found but its file changed on the server; told once. */
  onRestart?: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  stallMs?: number;
  /** Cancel (the Downloads view, board #308): stops at once, never retried,
   * and the error carries `cancelled` so the caller drops the part. */
  signal?: AbortSignal;
  retryDelayMs?: number;
  maxRetries?: number;
}

export const DL_STALL_TIMEOUT_MS = 20000;
export const DL_MAX_RETRIES = 4;
export const DL_RETRY_DELAY_MS = 1500;
/** Zero bytes after this many attempts: plain HTTP to the host is blocked
 * (typical: a reverse proxy that forwards WebSocket upgrades only). */
export const DL_UNREACHABLE_ATTEMPTS = 2;

export class DownloadCancelled extends Error {
  cancelled = true;
  keepPart: boolean;
  constructor(keepPart = false) { super('cancelled'); this.keepPart = keepPart; }
}

/** The abort reason of a SUSPEND (board 315, a server switch): the attempt
 * stops like a cancel, but its part is kept for a resume. */
export const SUSPEND = Object.freeze({ suspend: true });
const cancelledBy = (signal: AbortSignal | undefined) => new DownloadCancelled(signal?.reason === SUSPEND);

/** Throws the cancel error when `signal` was aborted: the check a caller
 * puts at its own await boundaries outside `download()` (board #420, the
 * whole-file fallback), so a Cancel shown there is a Cancel honored. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledBy(signal);
}

export class DownloadUnreachable extends Error {
  code = 'DL_HTTP_UNREACHABLE';
}

/** A /dl answer that is not 200/206. 5xx, 408 and 429 are the link (a
 * public proxy cutting a long transfer answers 502/504), so the part is kept
 * for a later resume; any other status (403, 404) is about the file. */
export class DownloadStatus extends Error {
  status: number;
  constructor(status: number) { super(`HTTP ${status}`); this.status = status; }
  get transient() { return this.status >= 500 || this.status === 408 || this.status === 429; }
}

/** Raw bytes per native IPC call: 3 MiB, i.e. exactly 4 MiB of base64. */
export const PIECE_BYTES = 3 * 1024 * 1024;

/** The total size from a 206 `Content-Range` or a 200 `Content-Length`. */
function totalOf(resp: Response): number {
  const range = resp.headers.get('content-range');
  if (range) return Number(range.split('/')[1]) || 0;
  return Number(resp.headers.get('content-length')) || 0;
}

export async function download(o: DownloadOptions): Promise<{ etag: string | null; total: number }> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const stallMs = o.stallMs ?? DL_STALL_TIMEOUT_MS;
  const maxRetries = o.maxRetries ?? DL_MAX_RETRIES;
  // A refused claim (another writer holds this part) must not be handled as
  // this attempt's failure: the caller neither aborts nor releases it.
  let part: PartState;
  try { part = await o.sink.open(); } catch (e) { throw busy(e); }
  let received = part.received;
  let etag = part.etag;
  // Only a part from an earlier attempt can be outdated; tell the user once.
  let resumable = received > 0;
  let total = 0;
  let retriesLeft = maxRetries;
  let attempts = 0;
  let url = o.url;
  const report = () => o.onProgress?.(total ? received / total : null, received, total);

  while (true) {
    const before = received;
    try {
      attempts++;
      await fetchFrom();
      await o.sink.flush();
      return { etag, total };
    } catch (e) {
      if (o.signal?.aborted) throw cancelledBy(o.signal);
      if (e instanceof SinkError) throw keep(e.cause, false);
      // Some proxies cut the connection instead of ending it cleanly.
      if (total && received >= total) { await o.sink.flush(); return { etag, total }; }
      if (received === 0 && attempts >= DL_UNREACHABLE_ATTEMPTS) {
        throw new DownloadUnreachable(`HTTP download unreachable: ${(e as Error).message}`);
      }
      if (received > before) retriesLeft = maxRetries;   // a moving link may take many hits
      if (retriesLeft <= 0) {
        // Giving up on the NETWORK: put what arrived on disk, so a later
        // download of this file resumes from all of it.
        try { await o.sink.flush(); } catch { /* the network error wins */ }
        // The caller keeps the part (no abort) when the link failed; a
        // status about the file itself is not worth resuming.
        throw keep(e, !(e instanceof DownloadStatus) || e.transient);
      }
      retriesLeft--;
      await sleep(o.retryDelayMs ?? DL_RETRY_DELAY_MS);
      // Stopped while waiting: no re-sign may go out after an abort (a
      // suspended attempt's next URL would be asked of the NEXT server).
      if (o.signal?.aborted) throw cancelledBy(o.signal);
      try { url = await o.freshUrl(); } catch { /* keep the old URL */ }
    }
  }

  async function fetchFrom() {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new Error('download stalled')), stallMs); };
    const cancel = () => ctrl.abort(new DownloadCancelled());
    if (o.signal?.aborted) throw cancelledBy(o.signal);
    o.signal?.addEventListener('abort', cancel);
    arm();
    try {
      const headers: Record<string, string> = {};
      if (received > 0) {
        headers.Range = `bytes=${received}-`;
        if (etag) headers['If-Range'] = etag;
      }
      const resp = await doFetch(url, { headers, signal: ctrl.signal });
      if (resp.status === 416 && received > 0) {
        // The part already holds every byte (a finished part whose save was
        // cancelled), or more than the file has (a different file): done, or
        // start over.
        const size = Number(resp.headers.get('content-range')?.split('/')[1]);
        if (size === received) { total = size; report(); return; }
        received = 0; etag = null; resumable = false;
        await sink(() => o.sink.reset(null));
        return await fetchFrom();
      }
      if (!resp.ok) throw new DownloadStatus(resp.status);
      const tag = resp.headers.get('etag');
      if (resp.status !== 206) {
        // The whole file: a fresh download, or a version the part is not of.
        if (received > 0 && resumable && tag !== etag) o.onRestart?.();
        resumable = false;
        etag = tag;
        received = 0;
        await sink(() => o.sink.reset(etag));
      } else if (received === 0) {
        etag = tag;
        await sink(() => o.sink.reset(etag));
      }
      total = totalOf(resp);
      report();
      if (!resp.body?.getReader) {
        const bytes = new Uint8Array(await resp.arrayBuffer());
        await sink(() => o.sink.write(bytes));
        received += bytes.length;
        report();
        return;
      }
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // The sink may hand a piece to the shell; the watchdog measures the
        // network, so it re-arms after that write.
        await sink(() => o.sink.write(value));
        arm();
        received += value.length;
        report();
      }
      if (total && received < total) throw new Error('connection closed early');
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', cancel);
    }
  }
}

/** The part has another writer: leave it, and its claim, alone. */
function busy(e: unknown) {
  if (e && typeof e === 'object') (e as { partBusy?: boolean }).partBusy = true;
  return e;
}

/** Mark whether the part on disk is worth keeping for a later resume. */
function keep(e: unknown, value: boolean) {
  if (e && typeof e === 'object') (e as { keepPart?: boolean }).keepPart = value;
  return e;
}

/** A sink failure is not a network blip: never retried. */
class SinkError extends Error {
  constructor(cause: unknown) { super(String((cause as Error)?.message ?? cause), { cause }); }
}
async function sink(run: () => Promise<void>) {
  try { await run(); } catch (e) { throw new SinkError(e); }
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** The browser: the whole file in memory, for `<a download>`. */
export function memorySink() {
  let chunks: Uint8Array[] = [];
  let size = 0;
  return {
    async open() { return { received: 0, etag: null }; },
    async reset() { chunks = []; size = 0; },
    async write(bytes: Uint8Array) { chunks.push(bytes); size += bytes.length; },
    async flush() {},
    bytes() {
      const out = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.length; }
      return out;
    },
  };
}

export type NativeInvoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** Android / macOS: one buffered piece at most, each sent as base64. */
/** What a part is of, kept beside it for the Downloads view (board #308). */
export interface PartAbout { name: string; path: string; server: string }

export function nativeSink(invoke: NativeInvoke, id: string, piece = PIECE_BYTES, about: PartAbout | null = null) {
  let pending: Uint8Array[] = [];
  let held = 0;
  async function send(all: boolean) {
    while (held >= piece || (all && held > 0)) {
      const size = Math.min(piece, held);
      const out = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const head = pending[0]!;
        const take = Math.min(head.length, size - offset);
        out.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.length) pending.shift(); else pending[0] = head.subarray(take);
      }
      held -= size;
      await invoke('download_chunk', { id, data: bytesToB64(out) });
    }
  }
  return {
    async open() { return await invoke('download_open', { id }) as PartState; },
    async reset(etag: string | null) { pending = []; held = 0; await invoke('download_reset', { id, etag, about }); },
    async write(bytes: Uint8Array) {
      if (!bytes.length) return;
      pending.push(bytes); held += bytes.length;
      await send(false);
    },
    async flush() { await send(true); },
    /** Move the finished part into place; resolves to the saved path. */
    async finish(name: string, dest: string | null = null) {
      return await invoke('download_finish', { id, name, dest }) as string;
    },
    /** Keep the part for a later resume and let go of the writer claim
     * (downloads.rs). Never throws. */
    async release() {
      pending = []; held = 0;
      try { await invoke('download_release', { id }); } catch { /* the claim ends with the app */ }
    },
    /** Drop the part. Never throws: the error that led here wins. */
    async abort() {
      pending = []; held = 0;
      try { await invoke('download_abort', { id }); } catch { /* nothing to clean */ }
    },
  };
}

/** The part file's id: fnv1a64(server + "\n" + remote path), 16 hex digits.
 * The same file from the same server finds its part again after a restart;
 * the id carries no path. The path is stored, in the part's sidecar (board
 * #308, so the Downloads view can resume it): on Android that is the public
 * Download/TmuxMobile folder, hidden only by its dot prefix. */
export function partId(server: string, path: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(`${server}\n${path}`)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
