// A stand-in for the Tauri packages Files imports lazily (board #474):
// `@tauri-apps/plugin-dialog`, `-fs`, `-opener`, `@tauri-apps/api/path` and
// `/webview`, one module for all five. It records every call in the realm's
// `__tauri.calls`, answers the dialog with `__tauri.pick` and `readFile` with
// `__tauri.files[path]`, so a test can see WHICH path a gesture took. The
// dialog and the fs plugin both export `open`: a PATH argument is fs's
// (a positioned file handle over `__tauri.files`, board #23), anything else
// the dialog's.
type Call = { fn: string; args: unknown[] };
type Realm = { calls: Call[]; pick: unknown; files: Record<string, Uint8Array> };
const realm = ((globalThis as { __tauri?: Realm }).__tauri ??= { calls: [], pick: null, files: {} });
const record = (fn: string, args: unknown[]) => { realm.calls.push({ fn, args }); };

const fileOf = (path: string) => {
  const bytes = realm.files[path];
  if (!bytes) throw new Error(`no such file: ${path}`);
  return bytes;
};
export const SeekMode = { Start: 0, Current: 1, End: 2 } as const;
export async function open(...args: unknown[]) {
  if (typeof args[0] !== 'string') { record('dialog.open', args); return realm.pick; }
  const path = args[0];
  record('fs.open', [path]);
  const bytes = fileOf(path);
  let at = 0;
  return {
    async seek(offset: number, whence: number) { record('fs.seek', [path, offset, whence]); at = offset; return at; },
    async read(buf: Uint8Array) {
      const n = Math.min(buf.length, bytes.length - at);
      buf.set(bytes.subarray(at, at + n)); at += n;
      return n > 0 ? n : null;
    },
    async close() { record('fs.close', [path]); },
  };
}
export async function stat(path: string) { record('fs.stat', [path]); return { size: fileOf(path).length }; }
export async function save(...args: unknown[]) { record('dialog.save', args); return null; }
export async function readFile(path: string) {
  record('fs.readFile', [path]);
  return fileOf(path);
}
export async function writeFile(...args: unknown[]) { record('fs.writeFile', args); }
export async function openPath(...args: unknown[]) { record('opener.openPath', args); }
export async function downloadDir() { record('path.downloadDir', []); return '/downloads'; }
export async function join(...parts: string[]) { return parts.join('/'); }
export function getCurrentWebview() {
  return { onDragDropEvent: async (handler: unknown) => { record('webview.onDragDropEvent', [typeof handler]); return () => {}; } };
}
