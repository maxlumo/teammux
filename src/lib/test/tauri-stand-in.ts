// A stand-in for the Tauri packages Files imports lazily (board #474):
// `@tauri-apps/plugin-dialog`, `-fs`, `-opener`, `@tauri-apps/api/path` and
// `/webview`, one module for all five. It records every call in the realm's
// `__tauri.calls`, answers the dialog with `__tauri.pick` and `readFile` with
// `__tauri.files[path]`, so a test can see WHICH path a gesture took.
type Call = { fn: string; args: unknown[] };
type Realm = { calls: Call[]; pick: unknown; files: Record<string, Uint8Array> };
const realm = ((globalThis as { __tauri?: Realm }).__tauri ??= { calls: [], pick: null, files: {} });
const record = (fn: string, args: unknown[]) => { realm.calls.push({ fn, args }); };

export async function open(...args: unknown[]) { record('dialog.open', args); return realm.pick; }
export async function save(...args: unknown[]) { record('dialog.save', args); return null; }
export async function readFile(path: string) {
  record('fs.readFile', [path]);
  const bytes = realm.files[path];
  if (!bytes) throw new Error(`no such file: ${path}`);
  return bytes;
}
export async function writeFile(...args: unknown[]) { record('fs.writeFile', args); }
export async function openPath(...args: unknown[]) { record('opener.openPath', args); }
export async function downloadDir() { record('path.downloadDir', []); return '/downloads'; }
export async function join(...parts: string[]) { return parts.join('/'); }
export function getCurrentWebview() {
  return { onDragDropEvent: async (handler: unknown) => { record('webview.onDragDropEvent', [typeof handler]); return () => {}; } };
}
