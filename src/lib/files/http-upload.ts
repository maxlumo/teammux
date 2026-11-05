// ONE upload core for every Files entry point (board #23). The bytes go to
// the gateway's signed HTTP door in fixed chunks, each a `PUT` carrying its
// `Upload-Offset`; the server (src-tauri/src/server/upload.rs) accepts only
// the next expected offset and renames the part file onto the destination
// when the last byte lands. The file is never read whole: `source(start,
// end)` hands over one chunk at a time (Blob.slice for a picked or dropped
// File, a positioned read for a native path).
//
// Resume rule: on a network error, a 403 (the 15-minute URL expired) or any
// other failure, ask `resume(id)` over the authenticated session for a fresh
// URL and the bytes the server holds, and continue from there. A 409 names
// that offset itself. After `maxStalls` failures in a row with no byte
// gained, give up with an `UploadFailed` carrying the id, so a Retry resumes
// the same upload instead of starting again.

export interface UploadBegun { id: string; url: string; chunk: number; received: number; done?: boolean }

/** The session side: `fs_upload_begin`/`_resume`/`_abort`, with `url`
 * already absolute for this connection (ws-api.ts). */
export interface UploadApi {
  begin(path: string, size: number): Promise<UploadBegun>;
  resume(id: string): Promise<{ url: string; received: number; chunk?: number }>;
  abort(id: string): Promise<unknown>;
}

export type ChunkSource = (start: number, end: number) => Promise<Blob | Uint8Array>;

export interface UploadOptions {
  dest: string;
  size: number;
  source: ChunkSource;
  api: UploadApi;
  /** Bytes the server holds, and the total; told at the start and after every chunk. */
  onProgress?: (sent: number, total: number) => void;
  /** Continue this upload (a Retry) instead of beginning one. */
  resumeId?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxStalls?: number;
  retryDelayMs?: number;
}

export const UPLOAD_MAX_STALLS = 4;
export const UPLOAD_RETRY_DELAY_MS = 1500;

export class UploadCancelled extends Error {
  cancelled = true;
  constructor() { super('cancelled'); }
}

/** The upload stopped; `id` resumes it (the server keeps its bytes for 10 minutes). */
export class UploadFailed extends Error {
  id: string;
  constructor(id: string, reason: string) { super(reason); this.id = id; }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function offsetOf(res: Response): number | null {
  const v = res.headers.get('Upload-Offset');
  const n = v == null ? NaN : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function uploadFile(o: UploadOptions): Promise<void> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const maxStalls = o.maxStalls ?? UPLOAD_MAX_STALLS;
  const tell = (sent: number) => o.onProgress?.(sent, o.size);
  const cancelled = () => o.signal?.aborted === true;

  let id: string;
  let url: string;
  let chunk: number;
  let received: number;
  if (o.resumeId) {
    id = o.resumeId;
    const r = await o.api.resume(id);
    ({ url, received } = r);
    chunk = r.chunk ?? 4 * 1024 * 1024;
  } else {
    const b = await o.api.begin(o.dest, o.size);
    if (b.done) { tell(o.size); return; }
    ({ id, url, chunk, received } = b);
  }
  const stop = async () => { await o.api.abort(id).catch(() => {}); return new UploadCancelled(); };
  tell(received);

  let stalls = 0;
  while (received < o.size) {
    if (cancelled()) throw await stop();
    const end = Math.min(o.size, received + chunk);
    let reason: string;
    try {
      const body = await o.source(received, end);
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Upload-Offset': String(received) },
        body: body as BodyInit,
        signal: o.signal,
      });
      const at = offsetOf(res);
      if ((res.status === 204 || res.status === 201) && at != null) {
        if (at > received) stalls = 0;
        received = at;
        tell(received);
        continue;
      }
      if (res.status === 409 && at != null) {
        if (at > received) stalls = 0;
        received = at;
        tell(received);
        continue;
      }
      reason = `HTTP ${res.status}`;
    } catch (e) {
      if (cancelled()) throw await stop();
      reason = e instanceof Error ? e.message : String(e);
    }
    // Lost the connection, the URL expired, or the server refused: ask the
    // session where the upload stands and carry on from there.
    stalls += 1;
    if (stalls >= maxStalls) throw new UploadFailed(id, reason);
    await sleep(o.retryDelayMs ?? UPLOAD_RETRY_DELAY_MS);
    if (cancelled()) throw await stop();
    try {
      const r = await o.api.resume(id);
      if (r.received > received) stalls = 0;
      url = r.url;
      received = r.received;
      tell(received);
    } catch (e) {
      // "no such upload": it expired or was aborted; nothing left to resume.
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such upload/.test(msg)) throw new UploadFailed('', msg);
    }
  }
}
