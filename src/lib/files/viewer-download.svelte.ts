// The viewer's download (board #447): a button in the Lightbox that saves the
// picture's SERVER FILE through `saveServerFile`, the one attempt every caller
// shares. Two lifetimes, kept apart on purpose:
//
//   TRANSFER  belongs to the server's runtime (`scope.state.files`: the row,
//             the writer claim, the abort handle). Closing the viewer, hiding
//             the host or destroying it does not stop it; only the runtime's
//             own seal -> suspend -> await does.
//   FEEDBACK  belongs to ONE open of the viewer. `start` takes a token from
//             the feedback lifetime, and the attempt reports through it, so a
//             late progress, failure or Saved cannot land on another image's
//             open (A -> close -> B, or A -> close -> A). `retire()` ends the
//             display when the viewer closes, the record changes or the host
//             stops being active; the store row carries on and is the only
//             record left (the SESSION's Downloads list: a reload loses it, on
//             Tauri the saved file stays).
//
// An open is an immutable record { src, ref }: what the Lightbox shows and
// what a download saves are captured together at the tap and never completed
// from anything live (not the URL, not the selected file).

import { saveServerFile } from './save-file.ts';
import type { SaveDeps } from './save-file.ts';
import { feedbackOf } from './downloads.svelte.ts';
import { createFeedbackLifetime } from '../ui/feedback-lifetime.ts';
import type { FeedbackValue } from '../ui/feedback-lifetime.ts';
import type { DownloadStore } from './downloads.svelte.ts';
import type { FilesMemory } from './files-memory.ts';
import type { WsApi } from '../core/ws-api.ts';
import { t } from '../core/i18n.svelte.ts';

/** One open of the viewer. `ref` is the picture's file on THE SERVER of the
 * host that opened it, or null when there is none (a direct URL, a local
 * thumbnail): then there is nothing to download and the button is not offered. */
export interface ViewerOpen {
  readonly src: string;
  readonly ref: string | null;
  /** The viewer's accessible name, taken at the same tap (it too must not follow the selection). */
  readonly label: string;
}

export function viewerOpen(src: string, ref: string | null = null, label = ''): ViewerOpen {
  return Object.freeze({ src, ref, label });
}

/** What the helper needs of the host's server scope: structural, so that this module names no
 * server of its own (only a page, under its provider, hands the scope it was bound to). */
export interface ViewerScope {
  state: { files: { memory: FilesMemory; downloads: DownloadStore } };
  runtime: { api: Pick<WsApi, 'fsDownload' | 'fsDownloadHttp'>; connection: { getMachineId(): string | null | undefined } };
}

/** `isCurrent(record)`: is this open the host's CURRENT open, and is the host still active? The
 * host answers, by the identity of its own record (never by reading the ref or the URL back):
 * a handler kept from a closed, replaced or hidden viewer asks again at the door. */
export function createViewerDownload(scope: ViewerScope, isCurrent: (record: ViewerOpen) => boolean = () => true) {
  const { memory, downloads: store } = scope.state.files;
  const { fsDownload, fsDownloadHttp } = scope.runtime.api;
  const deps: SaveDeps = { memory, store, fsDownload, fsDownloadHttp, getMachineId: scope.runtime.connection.getMachineId };

  let alive = true;
  let outcome = $state<FeedbackValue | null>(null);
  const lifetime = createFeedbackLifetime<FeedbackValue>((value) => { outcome = value; });
  // The attempt this host is SHOWING: one at a time, owned by `shownToken`. The record is
  // compared by identity, so it is kept raw (a state proxy would never equal the open).
  let shownToken = -1;
  let shownOpen = $state.raw<ViewerOpen | null>(null);
  let shownRow = $state<string | null>(null);
  let shownEnded = $state(true);

  const strings = () => ({ downloading: t('downloading'), changed: t('downloadFileChanged'), saving: t('saving') });

  return {
    /** What the viewer shows: this attempt's running row, read from the
     * record by its id (never copied), else the outcome the token still owns. */
    get status(): FeedbackValue | null {
      const row = shownRow && !shownEnded ? store.rowOf(shownRow) : undefined;
      if (row && (row.state === 'downloading' || row.state === 'saving')) return feedbackOf(row, strings());
      return outcome;
    },
    /** A save for THIS open is running (or being prepared): the button is not offered. */
    busy(record: ViewerOpen | null): boolean {
      return !!record && shownOpen === record && !shownEnded;
    },
    /** The tap. Synchronous guards come first: a second activation of the same
     * open while its attempt is prepared or running starts nothing and takes no
     * token, so the first attempt's feedback keeps arriving. */
    start(record: ViewerOpen | null): void {
      if (!alive || !record || !record.ref || !isCurrent(record)) return;
      if (shownOpen === record && !shownEnded) return;
      const token = lifetime.begin();
      shownToken = token; shownOpen = record; shownRow = null; shownEnded = false;
      const live = () => alive && lifetime.current(token);
      const say = (value: FeedbackValue) => { if (live()) lifetime.update(token, value); };
      void saveServerFile(deps, record.ref, record, {
        began: (rowId) => { if (shownToken === token) shownRow = rowId; },
        inProgress: (path) => say({ kind: 'success', message: t('downloadInProgress'), detail: path }),
        saved: (savedPath) => say({ kind: 'result', message: t('saved'), detail: savedPath }),
        kept: (name) => say({ kind: 'success', message: t('downloadPartKept'), detail: name }),
        requested: (name) => say({ kind: 'success', message: t('downloadRequested'), detail: name }),
        error: (message, path) => say({ kind: 'error', message, detail: path }),
      }).finally(() => { if (shownToken === token) shownEnded = true; });
    },
    /** The display of this open is over (close, another image, the host not
     * active). The transfer, if any, is untouched. */
    retire(): void {
      lifetime.clear();
      shownToken = -1; shownOpen = null; shownRow = null; shownEnded = true;
    },
    /** The host is going away. */
    dispose(): void {
      alive = false;
      lifetime.dispose();
      shownToken = -1; shownOpen = null; shownRow = null; shownEnded = true;
    },
    /** Dismiss an error line (the status owns its Close). */
    dismiss(): void { lifetime.clear(); },
  };
}
