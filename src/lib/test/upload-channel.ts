// A recording stand-in for the HTTP upload channel (board #23) as Hub
// attachments use it (board #25): `fs_upload_begin` names the destination,
// each PUT appends at its offset, the last byte commits. `hold(path)` runs
// inside begin, so a test can keep an upload in flight (a deferred) or have
// the server refuse it (a rejection, which `uploadFile` throws as is).
// `rpc` goes into the mocked ws module; `fetch` onto the realm's window.

export type Committed = { path: string; data: string };

export function uploadChannel(hold: (path: string) => Promise<unknown> | void = () => {}) {
  const live = new Map<string, { path: string; size: number; bytes: number[] }>();
  const begun: string[] = [];
  const committed: Committed[] = [];
  let n = 0;
  return {
    /** Destinations in the order begin was called. */
    begun,
    /** Destinations whose last byte landed, with the bytes as base64. */
    committed,
    rpc: {
      fsUploadBegin: async (path: string, size: number) => {
        begun.push(path);
        await hold(path);
        const id = `u${++n}`;
        live.set(id, { path, size, bytes: [] });
        return { id, url: `http://gw/up/${id}`, chunk: 4 * 1024 * 1024, received: 0 };
      },
      fsUploadResume: async (id: string) => { throw new Error(`no such upload: ${id}`); },
      fsUploadAbort: async () => ({ ok: true }),
    },
    fetch: async (url: string, init: RequestInit) => {
      const u = live.get(url.split('/').pop()!)!;
      const raw = init.body as Blob | Uint8Array;
      const body = typeof (raw as Blob).arrayBuffer === 'function' ? new Uint8Array(await (raw as Blob).arrayBuffer()) : Uint8Array.from(raw as Uint8Array);
      u.bytes.push(...body);
      const done = u.bytes.length === u.size;
      if (done) committed.push({ path: u.path, data: Buffer.from(u.bytes).toString('base64') });
      return new Response(null, { status: done ? 201 : 204, headers: { 'Upload-Offset': String(u.bytes.length) } });
    },
  };
}
