// The saved navigation state (`tmux_state`), and how a reload reads it
// (board #335 ②b-2).
//
// It used to be a record of two bare strings — `terminalTarget` and
// `terminalSession` — plus the desktop split's cells, which held the same two
// again. With more than one server a name is not an address: two servers can
// both have a session called `work`, so a restored record has to say WHICH
// server's `work` it means. v2 therefore saves `PaneRef`s, and the reading
// side is where the care goes.
//
// READING A v1 RECORD IS THE INTERESTING HALF (reviewer + orchestrator,
// 2026-10-10), and the rule is about WHERE the record was read, not about a
// global marker:
//
//   - a record read from a server's own SLOT (`tmux_state::<id>`) belongs to
//     that id. Nothing is inferred, because the slot names it, and a
//     v1-shaped record inside B's slot is still B's. The slot reader itself
//     arrives with the fold (②b-4); before that the live key is the only
//     home, so this module reads only it.
//   - the ONE unprefixed legacy record belongs to whoever owned the live keys
//     when it was written: `layoutMark.into` once the fold has run (that
//     marker records which server received those very inputs), else the
//     CURRENT read before anything in this boot could move it.
//   - when that cannot be established — a dangling CURRENT, no marker — the
//     record is UNATTRIBUTED and nothing of it is restored. It is not handed
//     to the next server that authenticates: being the next to connect is not
//     evidence of having written it. The data stays where it is, and ②b-4
//     only lets a server claim it on PROOF (its machineId matching the frozen
//     legacy mirror).
//
// A deep link activates its server before the boot restore runs, so
// attributing the legacy record to the new CURRENT would hand server B the
// panes of server A — which is the bug this shape exists to make unwritable.
//
// Everything here treats storage as UNTRUSTED: a hand-edited value, a record
// from a newer build, a cell list of nulls. Anything that does not parse into
// the shape below is dropped rather than repaired, because a half-understood
// pane target lands the reader on a pane that cannot be captured.
import { paneRef, type PaneRef, type ServerId } from './refs.ts';

/** Where the nav state lives. One spelling, shared with `servers.ts`'s
 * resident-key list, which treats the value as opaque. */
export const NAV_KEY = 'tmux_state';

/** The layout this module writes. v1 is "no `v` at all": the pre-#335 record
 * with `terminalTarget`/`terminalSession` strings. */
export const NAV_VERSION = 2;

/** One cell of the desktop split. The id is the cell's own, so a restore can
 * keep `activeCellId` and the next id generator consistent. */
export interface SavedCell {
  id: number;
  pane: PaneRef | null;
}

export interface SavedNav {
  /** Raw: `restoreNav` decides what an unknown or retired name resolves to. */
  page: unknown;
  pane: PaneRef | null;
  splitLayout: number;
  splitCells: SavedCell[];
}

export const EMPTY_NAV: SavedNav = { page: undefined, pane: null, splitLayout: 1, splitCells: [] };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** A pane target names its session, so a record that disagrees with itself is
 * not repaired: the target is what tmux resolves. */
function paneOf(serverId: ServerId, target: unknown, session: unknown): PaneRef | null {
  if (typeof target !== 'string' || !target) return null;
  const named = typeof session === 'string' && session ? session : target.split(':')[0]!;
  return paneRef(serverId, named, target);
}

/** A ref as it comes back out of JSON: validated, and re-stamped with nothing —
 * a v2 record already knows its server. */
function savedPane(value: unknown): PaneRef | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<PaneRef>;
  if (r.kind !== 'pane' || typeof r.serverId !== 'string' || typeof r.target !== 'string' || !r.target) return null;
  return paneOf(r.serverId, r.target, r.session);
}

function cellsOf(value: unknown, read: (v: unknown) => PaneRef | null): SavedCell[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c, i) => {
      const cell = (c ?? {}) as { id?: unknown; pane?: unknown; target?: unknown; session?: unknown };
      const id = typeof cell.id === 'number' && Number.isFinite(cell.id) ? cell.id : i;
      return { id, pane: read(cell) };
    });
}

/**
 * Read a record and attribute it to `owner`.
 *
 * `owner` is what the CALLER established — the slot's id, or the legacy
 * record's provable owner — and it is only consulted for a v1-shaped record,
 * since a v2 one names its server itself. An EMPTY owner means the records
 * cannot be attributed: the tab survives (it is the person's) and every pane
 * is dropped, rather than filed under a server that may not have written it.
 */
function readAt(storage: Pick<Storage, 'getItem'>, key: string, owner: ServerId): SavedNav {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(key) || '{}'); } catch { return EMPTY_NAV; }
  if (!raw || typeof raw !== 'object') return EMPTY_NAV;
  const r = raw as Record<string, unknown>;
  const layout = typeof r.splitLayout === 'number' && r.splitLayout > 1 ? r.splitLayout : 1;
  if (r.v === NAV_VERSION) {
    return {
      page: r.page,
      pane: savedPane(r.pane),
      splitLayout: layout,
      splitCells: cellsOf(r.splitCells, (c) => savedPane((c as { pane?: unknown }).pane)),
    };
  }
  // v1: the panes belong to the server that owned the live keys. An empty
  // owner means nothing can be attributed, so the panes are dropped and only
  // the tab survives — better than filing them under a server that is not
  // theirs.
  return {
    page: r.page,
    pane: owner ? paneOf(owner, r.terminalTarget, r.terminalSession) : null,
    splitLayout: owner ? layout : 1,
    splitCells: owner
      ? cellsOf(r.splitCells, (c) => {
        const cell = c as { target?: unknown; session?: unknown };
        return paneOf(owner, cell.target, cell.session);
      })
      : [],
  };
}

/**
 * The ONE unprefixed legacy record, attributed to the server that can be shown
 * to have written it — and to nobody otherwise.
 *
 * `owner` is the caller's conclusion, and the caller has exactly two sources
 * for it: the fold's marker (`layoutMark.into`, which records the server those
 * inputs went to) once the fold has run, and the CURRENT read before anything
 * in this boot could move it. With neither, it passes '' and nothing is
 * restored: the record stays untouched for a server that can prove it later.
 */
export function readLegacyNav(storage: Pick<Storage, 'getItem'>, owner: ServerId): SavedNav {
  return readAt(storage, NAV_KEY, owner);
}

/** Write the record. One definition of the shape, shared with `readNav`. */
export function saveNav(storage: Store, nav: SavedNav): void {
  storage.setItem(NAV_KEY, JSON.stringify({
    v: NAV_VERSION,
    page: nav.page,
    pane: nav.pane,
    splitLayout: nav.splitLayout,
    splitCells: nav.splitCells.map((c) => ({ id: c.id, pane: c.pane })),
  }));
}

/**
 * Keep only what belongs to `serverId`.
 *
 * The restore runs against ONE server's runtime, and a reference to another
 * server's pane cannot be resolved over that connection — it would be a
 * capture against a target the server has never heard of, or worse, a target
 * it happens to have under the same name. A cell naming another server
 * becomes empty rather than disappearing, so the split keeps its shape.
 */
export function navFor(nav: SavedNav, serverId: ServerId): SavedNav {
  const mine = (pane: PaneRef | null) => (pane && pane.serverId === serverId ? pane : null);
  return {
    page: nav.page,
    pane: mine(nav.pane),
    splitLayout: nav.splitLayout,
    splitCells: nav.splitCells.map((c) => ({ id: c.id, pane: mine(c.pane) })),
  };
}
