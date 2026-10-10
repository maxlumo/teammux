// The ONE record of ONE server's downloads (board #308). Every attempt
// registers a row here and its progress updates it; the Files feedback slot
// and the Downloads view both READ it, so the toast and the list can never
// tell two stories. In memory: the disk keeps what must outlive the app
// (finished files, resumable parts), and the view reads that from the shell.
//
// A FACTORY plus one default instance (board #335 ②a-4). The rows name paths
// on one server, so two servers need two records: a row's `path` means nothing
// without the machine it is on, and `forgetAll` exists precisely because a
// switch invalidates the whole list. `createDownloads()` is that record as an
// object, and since #335 ②b-2-1 each runtime's `ServerState.files` holds one,
// shared by both Files instances (the page and the Hub drawer) and every
// attempt; there is no module-level record. "Reset the store on a switch"
// became "the next server's runtime has its own".
//
// ②b's contract, because dropping an instance is NOT stopping a download
// (reviewer, 2026-10-09): a runtime's rows and its FilesMemory must be held
// together by that runtime, shared by the page and the drawer, and removing
// it has to forbid new attempts, then suspend and AWAIT the running ones,
// then release — never just drop the reference.

import type { FeedbackValue } from '../ui/feedback-lifetime.ts';

export type DownloadState = 'downloading' | 'saving' | 'done' | 'failed' | 'paused';

export interface DownloadRow {
  /** The part id (native) or a session id (browser). */
  id: string;
  name: string;
  /** The file's path on the server: Retry and Resume start from it. */
  path: string;
  state: DownloadState;
  received: number;
  total: number;
  startedAt: number;
  /** Where this attempt's first progress report found the transfer (a
   * resume starts at the part's size); speed counts only what it moved. */
  base: { at: number; received: number } | null;
  finishedAt: number | null;
  savedPath: string | null;
  error: string | null;
  /** The part on disk was of an older version: this attempt began again. */
  restarted: boolean;
  /** A browser download: handed to the browser, no file path of ours. */
  requested: boolean;
}

export interface DownloadStore {
  readonly rows: readonly DownloadRow[];
  /** Rows a transfer is running for. */
  readonly active: number;
  rowOf(id: string): DownloadRow | undefined;
  /** A new attempt. A row for the same id (a resume, a retry) is reused, so
   * one file is one row, moved back to the top. */
  begin(id: string, name: string, path: string, now?: number): DownloadRow;
  progress(id: string, received: number, total: number, now?: number): void;
  restarted(id: string): void;
  saving(id: string): void;
  done(id: string, savedPath: string | null, now?: number, requested?: boolean): void;
  /** The transfer stopped and its part stays on disk to be resumed. */
  paused(id: string, error: string | null, now?: number): void;
  failed(id: string, error: string, now?: number): void;
  /** Cancelled or deleted: nothing of it is left to show. */
  forget(id: string): void;
  /** Everything this server's record holds. Before #335 a switch called it
   * because the rows named paths on the server being left; with one record
   * per server, dropping the instance does the same thing. */
  forgetAll(): void;
}

/** One server's download record. Nothing is shared between two of them — the
 * rows are closure state, so a row of A's can neither be read nor forgotten
 * through B's. */
export function createDownloads(): DownloadStore {
  const rows = $state<DownloadRow[]>([]);

  function rowOf(id: string): DownloadRow | undefined {
    return rows.find((r) => r.id === id);
  }

  return {
    get rows(): readonly DownloadRow[] { return rows; },
    get active(): number { return rows.filter((r) => r.state === 'downloading' || r.state === 'saving').length; },
    rowOf,
    begin(id, name, path, now = Date.now()) {
      const old = rows.findIndex((r) => r.id === id);
      if (old >= 0) rows.splice(old, 1);
      rows.unshift({
        id, name, path, state: 'downloading', received: 0, total: 0, startedAt: now,
        base: null, finishedAt: null, savedPath: null, error: null,
        restarted: false, requested: false,
      });
      return rows[0]!;
    },
    progress(id, received, total, now = Date.now()) {
      const row = rowOf(id);
      if (!row) return;
      if (!row.base) row.base = { at: now, received };
      row.received = received;
      row.total = total;
    },
    restarted(id) {
      const row = rowOf(id);
      if (!row) return;
      row.restarted = true;
      row.received = 0;
      row.base = null;
    },
    saving(id) {
      const row = rowOf(id);
      if (row) row.state = 'saving';
    },
    done(id, savedPath, now = Date.now(), requested = false) {
      const row = rowOf(id);
      if (!row) return;
      Object.assign(row, { state: 'done', savedPath, finishedAt: now, requested, error: null });
      if (row.total) row.received = row.total;
    },
    paused(id, error, now = Date.now()) {
      const row = rowOf(id);
      if (row) Object.assign(row, { state: 'paused', error, finishedAt: now });
    },
    failed(id, error, now = Date.now()) {
      const row = rowOf(id);
      if (row) Object.assign(row, { state: 'failed', error, finishedAt: now });
    },
    forget(id) {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    forgetAll() { rows.splice(0, rows.length); },
  };
}

/** Bytes per second of the current attempt, or null before one second. Pure:
 * it reads a row, so it belongs to no instance. */
export function speed(row: DownloadRow, now = Date.now()): number | null {
  if (!row.base) return null;
  const seconds = (now - row.base.at) / 1000;
  if (seconds < 1 || row.received <= row.base.received) return null;
  return (row.received - row.base.received) / seconds;
}

export interface FeedbackStrings { downloading: string; changed: string; saving: string }

/** The feedback slot's progress value for a row: the slot shows the store,
 * it keeps no copy of its own. Pure, like `speed`. */
export function feedbackOf(row: DownloadRow, s: FeedbackStrings): FeedbackValue {
  return {
    kind: 'progress', glyph: 'download',
    message: row.state === 'saving' ? s.saving : row.restarted ? s.changed : s.downloading,
    detail: row.path,
    progress: row.state === 'saving' || !row.total ? null : (row.received / row.total) * 100,
  };
}
