// A recording stand-in for the HTTP upload channel (board #23) as Hub
// attachments use it (board #25): `fs_upload_begin` names the destination,
// each PUT appends at its offset, the last byte commits. Like the server
// (upload.rs `begin`), a destination with a live upload refuses a second
// begin with "upload in progress" until the first commits. `hold(path)` runs
// inside begin, before the upload is live, so a test can keep it from
// starting (a deferred) or have the server refuse it (a rejection, which
// `uploadFile` throws as is); `put(path)` runs inside the PUT that commits,
// so a test can keep an upload live. `rpc` goes into the mocked ws module;
// `fetch` onto the realm's window.

export type Committed = { path: string; data: string };

export function uploadChannel(
  hold: (path: string) => Promise<unknown> | void = () => {},
  put: (path: string) => Promise<unknown> | void = () => {},
) {
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
        if ([...live.values()].some((u) => u.path === path)) throw new Error(`upload in progress: ${path}`);
        const id = `u${++n}`;
        live.set(id, { path, size, bytes: [] });
        return { id, url: `http://gw/up/${id}`, chunk: 4 * 1024 * 1024, received: 0 };
      },
      fsUploadResume: async (id: string) => { throw new Error(`no such upload: ${id}`); },
      fsUploadAbort: async () => ({ ok: true }),
      /** What exists is what committed (fs_stat errors on a missing path). */
      fsStat: async (path: string) => {
        const c = committed.find((x) => x.path === path);
        if (!c) throw new Error(`stat error: No such file or directory (os error 2) — ${path}`);
        return { path, size: Buffer.from(c.data, 'base64').length };
      },
    },
    fetch: async (url: string, init: RequestInit) => {
      const id = url.split('/').pop()!;
      const u = live.get(id)!;
      const raw = init.body as Blob | Uint8Array;
      const body = typeof (raw as Blob).arrayBuffer === 'function' ? new Uint8Array(await (raw as Blob).arrayBuffer()) : Uint8Array.from(raw as Uint8Array);
      u.bytes.push(...body);
      const done = u.bytes.length === u.size;
      if (done) {
        await put(u.path);
        live.delete(id);
        committed.push({ path: u.path, data: Buffer.from(u.bytes).toString('base64') });
      }
      return new Response(null, { status: done ? 201 : 204, headers: { 'Upload-Offset': String(u.bytes.length) } });
    },
  };
}
