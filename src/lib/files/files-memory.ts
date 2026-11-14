// What the Files pages remember about ONE server (board #335 ②a-4).
//
// Both Files instances — the page and the Hub's drawer — share this and
// outlive any one of them, which is why it was a `<script module>` block in
// Files.svelte. It is a record per SERVER, not per app:
//
//   - browse positions are keyed by session NAME, and `app` on one server is
//     not `app` on another (a switch used to `resetFilesMemory` for that).
//   - a part id, a running attempt and its abort handle all belong to a
//     transfer from one machine. A switch stops them and KEEPS the part,
//     because the bytes are the leaving server's file.
//
// A factory so each runtime holds its own: since #335 ②b-2-1 a runtime's
// `ServerState.files` holds this record together with its download rows, and
// App's switch suspends the leaving server's through `suspendFiles`. Every
// rule below is the one it had.
//
// Two things ②b owes this record (reviewer, 2026-10-09):
//
//   - DROPPING AN INSTANCE IS NOT STOPPING A DOWNLOAD. A runtime must hold
//     this record together with that server's download rows, shared by the
//     page and the drawer, and removing the runtime has to forbid new
//     attempts, then `suspend` and AWAIT, then release. `suspend` snapshots
//     the attempts tracked WHEN IT IS CALLED; it does not seal off a later
//     `track`, and it is deliberately not given an auto-dispose of its own —
//     that belongs to the lifecycle wiring, in one place.
//   - A WEB ROW ID IS UNIQUE ONLY IN ONE RECORD. `web-1` of two servers is
//     two different rows, so a union list or a cancel dispatched across
//     servers must carry the owner; bare row ids from two records must never
//     meet in one map. A native `partId` already has a machine dimension in
//     it — the two kinds of id are not the same guarantee.

/** The one writer of a part folder, across every Files instance (board
 * #305): the page and the drawer write the same folder, so the one-writer
 * rule has to hold between them and not only inside one. */
export interface PartWriter {
  /** The instance that started it: a second ask from the SAME instance does
   * nothing (its card is already on screen, board #420), from the other one
   * it is told the file is already downloading. */
  owner: unknown;
}

/** A browse position: where this session was last read, the directory a
 * preview came from, and the file on screen then (#479). `file` is a PATH
 * only, '' or absent for a listing: a restore re-reads and re-signs it
 * through the ordinary open, never reuses bytes, URLs or an edit buffer. */
export interface BrowsePosition {
  cwd: string;
  sourceDir: string;
  file?: string;
}

/** An editor's unsaved working copy (board #126). Its baseline is not here: the text
 * last known on disk is the store's (`saved`), one per file, beside it (ruling 16). */
export interface EditDraft {
  text: string;
  /** The instance whose editor made it dirty (#126 ruling 7): only it, or a save or
   * discard of THIS text, clears it; a clean exit of another instance never does. */
  owner: unknown;
}

export interface FilesMemory {
  /** Where this session was left, or undefined on a first visit. */
  position(session: string): BrowsePosition | undefined;
  /** Record where a session is, including on unmount — the drawer instance
   * dies with the drawer, and a position written only at the next session
   * switch would never be written at all. */
  park(session: string, at: BrowsePosition): void;
  /** Has a Files instance of this server already taken this navigation
   * request? A request is one-shot across instances (#479): the drawer
   * remounts with the request its previous instance consumed, and replaying
   * it would override the file browsed since. Identity, not `n`: the page and
   * the drawer number their requests independently. */
  consumed(request: object): boolean;
  consume(request: object): void;
  /** The attempt already writing this part, if any. */
  writerOf(partId: string): PartWriter | undefined;
  claim(partId: string, writer: PartWriter): void;
  release(partId: string): void;
  /** Track a running attempt: how to stop it, and when it has settled.
   * Returns false on a SEALED record and tracks nothing: the attempt must
   * not start (board #335 ②b-2-3, reviewer P1-a — a gate, not a signal the
   * caller may or may not read later). */
  track(rowId: string, control: AbortController, settled: Promise<void>): boolean;
  untrack(rowId: string): void;
  /** The Downloads view's Cancel. */
  abort(rowId: string): void;
  /** Browser rows have no part id, so they get a sequence of their own.
   * Unique within this record, which is all a row id has to be. */
  nextWebRowId(): string;
  /**
   * A server switch stops every running download and keeps its part: the
   * bytes are the leaving server's file and they resume when the user is back
   * on it (Cancel in the Downloads view deletes the part; a switch does not).
   *
   * Resolves once every attempt has SETTLED, so no retry, re-sign or fallback
   * of the old server's chain can go out afterwards.
   */
  suspend(reason: unknown): Promise<void>;
  /** Forbid new attempts, for good (board #335 ②b-2-3): the first step of
   * releasing this server's record. `suspend` snapshots what is tracked when
   * it is called, so without this an attempt started in the gap would
   * outlive the release; after it, `track` refuses. Idempotent. */
  seal(reason: unknown): void;
  /** Has the record been sealed? A new download must not start. */
  sealed(): boolean;
  /** The unsaved edit of `path` in `session`, if an editor left one (board #126):
   * the Hub's drawer Files is unmounted when the Hub turns compact, and the next
   * instance, or the page's, wakes in the editor with it. */
  draft(session: string, path: string): EditDraft | undefined;
  /** The text last known on disk for `path` (set when a Files instance reads it, and
   * by a settled save from the snapshot it sent): every instance's baseline, so dirty
   * is `current ≠ saved` in whichever instance shows the file (#126 ruling 16). */
  saved(session: string, path: string): string | undefined;
  setSaved(session: string, path: string, text: string): void;
  /** Be told whenever a baseline moves (a save settled, a read landed), so every mounted
   * instance recomputes its dirty state. Returns the unsubscribe. */
  watchSaved(fn: () => void): () => void;
  /** Keep that working copy (its owner is the writer). */
  keepDraft(session: string, path: string, draft: EditDraft): void;
  /** Drop it only when `when` says the stored copy is the caller's to drop (its owner,
   * or the very text a save just wrote); answers whether it dropped one. */
  dropDraft(session: string, path: string, when: (draft: EditDraft) => boolean): boolean;
  /** Per-server memory a switch drops: the browse positions (never a draft:
   * unsaved text is the person's). */
  reset(): void;
}

export function createFilesMemory(): FilesMemory {
  const browsed = new Map<string, BrowsePosition>();
  const drafts = new Map<string, EditDraft>();
  const saves = new Map<string, string>();
  const watchers = new Set<() => void>();
  const draftKey = (session: string, path: string) => `${session}\n${path}`;
  const taken = new WeakSet<object>();
  const inFlight = new Map<string, PartWriter>();
  const cancels = new Map<string, AbortController>();
  const settles = new Map<string, Promise<void>>();
  let webSeq = 0;
  let sealedBy: { reason: unknown } | null = null;

  return {
    position: (session) => browsed.get(session),
    draft: (session, path) => drafts.get(draftKey(session, path)),
    saved: (session, path) => saves.get(draftKey(session, path)),
    setSaved(session, path, text) {
      const key = draftKey(session, path);
      if (saves.get(key) === text) return;
      saves.set(key, text);
      for (const fn of [...watchers]) fn();
    },
    watchSaved(fn) { watchers.add(fn); return () => { watchers.delete(fn); }; },
    keepDraft(session, path, draft) { drafts.set(draftKey(session, path), draft); },
    dropDraft(session, path, when) {
      const key = draftKey(session, path);
      const d = drafts.get(key);
      if (!d || !when(d)) return false;
      drafts.delete(key);
      return true;
    },
    park: (session, at) => { browsed.set(session, at); },
    consumed: (request) => taken.has(request),
    consume: (request) => { taken.add(request); },
    writerOf: (partId) => inFlight.get(partId),
    claim: (partId, writer) => { inFlight.set(partId, writer); },
    release: (partId) => { inFlight.delete(partId); },
    track(rowId, control, settled) {
      // Released: this attempt never runs, and nothing of it is kept.
      if (sealedBy) return false;
      cancels.set(rowId, control);
      settles.set(rowId, settled);
      return true;
    },
    untrack(rowId) {
      cancels.delete(rowId);
      settles.delete(rowId);
    },
    abort: (rowId) => { cancels.get(rowId)?.abort(); },
    nextWebRowId: () => `web-${++webSeq}`,
    async suspend(reason) {
      // Snapshot first: aborting runs each attempt's own cleanup, which
      // untracks it, so iterating the live map would miss attempts.
      const running = [...settles.values()];
      for (const control of cancels.values()) control.abort(reason);
      await Promise.allSettled(running);
    },
    reset() { browsed.clear(); },
    seal(reason) { sealedBy ??= { reason }; },
    sealed: () => sealedBy !== null,
  };
}
