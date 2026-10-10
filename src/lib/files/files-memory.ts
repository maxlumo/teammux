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
  /** The instance that started it, so a second ask from the SAME instance
   * re-adopts the attempt instead of refusing it. */
  owner: unknown;
  /** Take the attempt's feedback back over in this instance. */
  adopt(): void;
}

/** A browse position: where this session was last read, and the directory a
 * preview came from. */
export interface BrowsePosition {
  cwd: string;
  sourceDir: string;
}

export interface FilesMemory {
  /** Where this session was left, or undefined on a first visit. */
  position(session: string): BrowsePosition | undefined;
  /** Record where a session is, including on unmount — the drawer instance
   * dies with the drawer, and a position written only at the next session
   * switch would never be written at all. */
  park(session: string, at: BrowsePosition): void;
  /** The attempt already writing this part, if any. */
  writerOf(partId: string): PartWriter | undefined;
  claim(partId: string, writer: PartWriter): void;
  release(partId: string): void;
  /** Track a running attempt: how to stop it, and when it has settled. */
  track(rowId: string, control: AbortController, settled: Promise<void>): void;
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
  /** Per-server memory a switch drops: the browse positions. */
  reset(): void;
}

export function createFilesMemory(): FilesMemory {
  const browsed = new Map<string, BrowsePosition>();
  const inFlight = new Map<string, PartWriter>();
  const cancels = new Map<string, AbortController>();
  const settles = new Map<string, Promise<void>>();
  let webSeq = 0;

  return {
    position: (session) => browsed.get(session),
    park: (session, at) => { browsed.set(session, at); },
    writerOf: (partId) => inFlight.get(partId),
    claim: (partId, writer) => { inFlight.set(partId, writer); },
    release: (partId) => { inFlight.delete(partId); },
    track(rowId, control, settled) {
      cancels.set(rowId, control);
      settles.set(rowId, settled);
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
  };
}
