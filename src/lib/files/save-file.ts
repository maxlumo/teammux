// ONE attempt to save a server file to this device (board #447; it lived as
// `handleDownload` inside Files.svelte until then, and moved here unchanged).
//
// `download.ts` is the byte core; this is the protocol around it, and every
// caller shares it so there is exactly one: the row in the runtime's download
// record (`downloads.svelte.ts`), the one-writer claim and the abort handle
// (`files-memory.ts`, which is what a server switch and a runtime release
// suspend), a signed `/dl` URL asked for NOW (and again on each retry, the
// signature lives 60 s), the whole-file RPC fallback when plain HTTP is
// blocked, the desktop save dialog after the bytes, and the browser's blob
// link. The caller supplies only WHO it is (`owner`) and where the outcome is
// SAID (`say`): Files tells its feedback slot, a viewer tells its own.
//
// What the attempt needed from Files being loaded travels with it: the Tauri
// dialog is imported here behind `tauriReady`, and the once-per-realm drop of
// stale Rust claims is `realmReady()`, awaited before the first byte moves.

import { isAndroid, isTauri, tauriReady } from '../core/platform.ts';
import { invokeNative } from '../core/native.ts';
import { download, memorySink, nativeSink, partId, PIECE_BYTES, throwIfCancelled } from './download.ts';
import type { DownloadStore } from './downloads.svelte.ts';
import type { FilesMemory } from './files-memory.ts';

/** What the attempt needs from ONE server's runtime. */
export interface SaveDeps {
  memory: FilesMemory;
  store: DownloadStore;
  fsDownload(path: string): Promise<{ data: string }>;
  fsDownloadHttp(path: string): Promise<{ url?: string; base64?: string }>;
  getMachineId(): string | null | undefined;
  /** The once-per-process preparation every attempt awaits (default `realmReady`). A seam for
   * tests that hold it; nothing else replaces it. */
  ready?: () => Promise<void>;
}

/** Where an attempt's outcome is said. Exactly one of these ends an attempt
 * that said anything; a cancel and a server-switch suspend say nothing. */
export interface SaveOutcome {
  /** The row this attempt owns, said synchronously the moment it exists (before the
   * first await), so a caller reads ITS progress from the record by id and never by
   * "the newest row of that path". Optional: Files reads the whole stack. */
  began?(rowId: string): void;
  /** Another writer holds this file: it is theirs to finish. */
  inProgress(path: string): void;
  /** Written to `savedPath` on this device. */
  saved(savedPath: string): void;
  /** The finished part is kept for the next Download (the save dialog was dismissed). */
  kept(name: string): void;
  /** Handed to the browser, which owns the file from here. */
  requested(name: string): void;
  error(message: string, path: string): void;
}

/** A fresh page has no writer yet: drop claims a previous page (a webview
 * reload in a live process) left in Rust, or its parts could never be
 * resumed. Once per realm, before any download can start — a property of the
 * PROCESS, not of any server. Memoised; callers only await it. */
let realm: Promise<void> | null = null;
export function realmReady(): Promise<void> {
  realm ??= isTauri ? invokeNative('download_release_all').then(() => {}, () => {}) : Promise.resolve();
  return realm;
}

/** An RPC fallback arrives whole as base64 (≤50 MB server cap). */
async function writeWhole(sink: { reset(etag: string | null): Promise<void>; write(bytes: Uint8Array): Promise<void>; flush(): Promise<void> }, b64: string) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  await sink.reset(null);
  await sink.write(bytes);
  await sink.flush();
}

type Failure = { message?: string; code?: string; partBusy?: boolean; cancelled?: boolean; keepPart?: boolean };

/** One writer per part id (board #305). The id is stable per server + file so
 * a later session can resume; two concurrent attempts on one id would append
 * to the same part and corrupt it. A second ask from the SAME `owner` does
 * nothing (its card is already on screen); from another owner it is told the
 * file is already downloading. */
export async function saveServerFile(deps: SaveDeps, path: string, owner: unknown, say: SaveOutcome): Promise<void> {
  const { memory, store } = deps;
  const name = path.split('/').pop() as string;
  // Without a machine id (should not happen after auth) the id must not be
  // shared across servers: a one-off id downloads correctly, it just cannot
  // resume in a later session.
  const server = isTauri ? deps.getMachineId() || `once-${Date.now()}-${Math.random()}` : '';
  const id = isTauri ? partId(server, path) : null;
  const running = id ? memory.writerOf(id) : null;
  // Its card is already in the stack (board #420): nothing to take back.
  if (running?.owner === owner) return;
  if (running) { say.inProgress(path); return; }
  // The store's row is this attempt's ONE record (board #308): progress
  // writes it, and its card in the feedback stack shows what it says.
  const rowId = id ?? memory.nextWebRowId();
  const control = new AbortController();
  let settle!: () => void;
  // The gate (board #335 ②b-2-3, reviewer P1-a): a record being released
  // refuses the attempt, which ends here — no row, no claim, no RPC.
  if (!memory.track(rowId, control, new Promise<void>((resolve) => { settle = resolve; }))) return;
  store.begin(rowId, name, path);
  say.began?.(rowId);
  const progress = (_fraction: number | null, received = 0, total = 0) => { store.progress(rowId, received, total); };
  if (id) memory.claim(id, { owner });
  const completed = (savedPath: string) => {
    store.done(rowId, savedPath);
    say.saved(savedPath);
  };
  try {
  progress(null);
  // ONE download core (board #305, download.ts); only the sink differs.
  // A Tauri shell writes a resumable part on disk, the browser holds the
  // file in memory for <a download>.
  const native = id ? nativeSink(invokeNative, id, PIECE_BYTES, { name, path, server }) : null;
  const held = native ? null : memorySink();
  const sink = (native ?? held)!;
  try {
    await (deps.ready ?? realmReady)();
    // The preparation may have taken a while: a Cancel or a runtime's suspend that came in
    // meanwhile ends the attempt HERE, before any signature is asked for (board #447 review P1-B).
    throwIfCancelled(control.signal);
    const dlInfo = await deps.fsDownloadHttp(path);
    if (dlInfo.url) {
      // freshUrl re-signs on each retry: the /dl signature has a 60 s TTL,
      // so resuming a long transfer needs a new URL, not the original.
      const freshUrl = () => deps.fsDownloadHttp(path).then(info => info.url as string);
      try {
        await download({ url: dlInfo.url, freshUrl, sink, signal: control.signal,
          onProgress: progress,
          // The part on disk is of an older version of the file: the row
          // says so for the rest of the attempt (told once).
          onRestart: () => { store.restarted(rowId); } });
      } catch (e) {
        if ((e as Failure).code !== 'DL_HTTP_UNREACHABLE') throw e;
        // The WS connection demonstrably works (we just got the signed
        // URL over it) but plain HTTP to the same host doesn't — typical
        // when a reverse proxy only forwards WebSocket upgrades. Fall
        // back to the WS RPC download (base64, 50 MB server-side cap).
        await writeWhole(sink, (await deps.fsDownload(path)).data);
      }
    } else {
      // wss:// fallback path: we got base64 over WS RPC. No progress to
      // report mid-decode.
      await writeWhole(sink, dlInfo.base64 as string);
    }

    // Cancel is honored up to here (review P2-C): download() checks it on
    // the streamed path, and this one check covers the whole-file fallback
    // and a URL ask a Cancel overtook. Past it the row is 'saving' and its
    // card offers no Cancel (a dialog or a finish is not cancelled here).
    throwIfCancelled(control.signal);
    // There is no measured write fraction. Only transfer bytes report a percentage.
    store.saving(rowId);
    if (native) {
      let dest: string | null = null;
      if (!isAndroid) {
        await tauriReady;
        const dialog = await import('@tauri-apps/plugin-dialog');
        // macOS / desktop: the dialog comes after the bytes, as before.
        dest = await dialog.save({ defaultPath: name });
        if (!dest) {
          // Cancelled: the finished part stays in the app cache, so the
          // next Download of this file asks again without refetching.
          await native.release();
          store.paused(rowId, null);
          say.kept(name);
          return;
        }
      }
      completed(await native.finish(name, dest ? String(dest) : null));
      return;
    }
    const bytes = held!.bytes();
    // Plain browser: trigger a tag-based download.
    const blob = new Blob([bytes as BlobPart]);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 100);
    store.done(rowId, null, Date.now(), true);
    say.requested(name);
  } catch (e) {
    const failure = e as Failure;
    // A NETWORK failure keeps the part for a later resume (download.ts
    // flushed what arrived); anything else (a write or save failure, a
    // missing file) leaves no half-file behind.
    // Another writer holds the part (Rust refused the claim): it is theirs
    // to finish, so neither abort nor release it, and say so as the JS
    // guard does.
    if (failure?.partBusy) {
      store.forget(rowId);
      say.inProgress(path);
      return;
    }
    // Suspended by a server switch (board 315): the part stays for a
    // resume on this server; the row goes with the rest of its memory.
    if (failure?.cancelled && failure.keepPart) {
      await native?.release();
      store.forget(rowId);
      return;
    }
    // Cancelled (its card or the Downloads view): the part goes, the row
    // goes and with it the card; nothing more is said.
    if (failure?.cancelled) {
      await native?.abort();
      store.forget(rowId);
      return;
    }
    const message = String(failure?.message || e);
    if (failure?.keepPart) { await native?.release(); store.paused(rowId, message); }
    else { await native?.abort(); store.failed(rowId, message); }
    say.error(message, path);
  }
  } finally { if (id) memory.release(id); memory.untrack(rowId); settle(); }
}
