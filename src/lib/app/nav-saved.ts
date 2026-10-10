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
//   - the ONE unprefixed legacy record belongs to whoever last PUT IT THERE,
//     and the caller is the only one who can know that: at boot it is the
//     server the last session left current, and from then on it is whichever
//     server the app arrived at, because arriving surfaces that server's
//     parked slot into the live key (`pointTo`, which ②b-4 retires).
//     Comparing bytes cannot answer this — two servers can hold byte-identical
//     records, and `work:1.0` on A looks exactly like `work:1.0` on B
//     (orchestrator, 2026-10-10).
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
import { paneRef, reownRef, type PaneRef, type ServerId } from './refs.ts';

/** Where the nav state lives. One spelling, shared with `servers.ts`'s
 * resident-key list, which treats the value as opaque. */
export const NAV_KEY = 'tmux_state';

/** The layout this module writes. v1 is "no `v` at all": the pre-#335 record
 * with `terminalTarget`/`terminalSession` strings. Any OTHER value is junk —
 * a record from a build this one does not understand is not a v1 record, and
 * guessing at it is how a newer layout gets misread (reviewer P2). */
export const NAV_VERSION = 2;

/** Where an input nobody can be shown to own is kept (reviewer P1-c): the raw
 * bytes, when they were found, and the machine the legacy mirror named at that
 * moment. ②b-4 lets a server claim it by PROVING that machine is its own; a
 * server merely being the next to authenticate proves nothing. */
export const QUARANTINE_KEY = 'tmux_state::unattributed';

/** The most panes a split can be restored into. The shell offers a smaller
 * set of its own (`SPLIT_CHOICES`), but on restore it gates only on being
 * able to show a split at all and on the count being more than one — so what
 * matters here is refusing a number that is not a small whole count
 * (reviewer P2, 2026-10-10). */
const MAX_SPLIT = 16;

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
 * REFUSED rather than repaired: the target is what tmux resolves, and a
 * `session` that is not its prefix means the two were written by different
 * things (reviewer P2). An empty serverId is refused too — an unattributed
 * pane is not a pane. */
function paneOf(serverId: ServerId, target: unknown, session: unknown): PaneRef | null {
  if (!serverId || typeof target !== 'string' || !target) return null;
  const prefix = target.split(':')[0]!;
  if (!prefix) return null;
  if (typeof session === 'string' && session && session !== prefix) return null;
  return paneRef(serverId, prefix, target);
}

/** A ref as it comes back out of JSON: validated, and re-stamped with nothing —
 * a v2 record already knows its server. */
function savedPane(value: unknown): PaneRef | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<PaneRef>;
  if (r.kind !== 'pane' || typeof r.serverId !== 'string' || typeof r.target !== 'string' || !r.target) return null;
  return paneOf(r.serverId, r.target, r.session);
}

/** Cells keep their order and their ids, and an id is used ONCE: two cells
 * sharing one would make the shell's keyed list and its `activeCellId`
 * disagree about which cell is which (reviewer P2).
 *
 * A duplicate or missing id falls back to the LOWEST id nobody is using —
 * the position is not a free slot: `[1, 1]` gave the second cell position 1,
 * which the first cell had just claimed as its id (reviewer P2-b,
 * 2026-10-10). Only the id changes; the cells keep their order. */
function cellsOf(value: unknown, read: (v: unknown) => PaneRef | null): SavedCell[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<number>();
  let free = 0;
  const unused = () => { while (used.has(free)) free++; return free; };
  return value.slice(0, MAX_SPLIT).map((c) => {
    const cell = (c ?? {}) as { id?: unknown; pane?: unknown; target?: unknown; session?: unknown };
    const given = typeof cell.id === 'number' && Number.isInteger(cell.id) && cell.id >= 0 ? cell.id : -1;
    const id = given >= 0 && !used.has(given) ? given : unused();
    used.add(id);
    return { id, pane: read(cell) };
  });
}

/** A whole small count, or single-pane. The shell re-gates on its own choices
 * and on whether this client can show a split at all. */
function layoutOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 && value <= MAX_SPLIT ? value : 1;
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
  // A version this build does not know is not a v1 record: only the absence
  // of `v` is.
  if (r.v !== undefined && r.v !== NAV_VERSION) return EMPTY_NAV;
  const layout = layoutOf(r.splitLayout);
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

/**
 * Keep an input nobody can be shown to own, before anything can overwrite it.
 *
 * `readLegacyNav` returning no panes does not preserve anything: the shell
 * saves its own navigation over the same key as soon as it comes up
 * (reviewer P1-c). So the bytes are copied aside, together with the machine
 * the legacy mirror named at that moment — the evidence ②b-4 requires before
 * any server may claim them. The live key is left writable: what is preserved
 * is this copy.
 *
 * The FIRST quarantine wins. A second boot must not overwrite the original
 * with whatever the shell has written since.
 */
export function quarantineLegacyNav(storage: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  const raw = storage.getItem(NAV_KEY);
  if (raw == null || storage.getItem(QUARANTINE_KEY) != null) return false;
  storage.setItem(QUARANTINE_KEY, JSON.stringify({
    raw,
    at: Date.now(),
    // The live mirror's machine id, read before any authentication can
    // rewrite it. Without it nothing can ever be proven, so a missing one is
    // recorded as missing rather than guessed.
    machineId: storage.getItem('tmux_machine_id') || '',
  }));
  return true;
}

/**
 * Follow an identity MERGE in the record itself (reviewer P1, 2026-10-10).
 *
 * A v2 record names its server, so a record written before `recordServer`
 * absorbed that entry still names the absorbed id — and the restore filters
 * it out, losing the navigation of the very machine the app has just
 * reconnected to. Every ref the identity layer shows to have been MERGED is
 * re-owned to its survivor (`survivorOf`, i.e. `servers.mergedInto`).
 *
 * Nothing else moves (reviewer P1-a): a ref naming an id nobody can explain
 * keeps it, and the restore then filters it out as another server's, which
 * is the safe answer for a record this client cannot attribute.
 *
 * A v1 record needs nothing: it names no server at all, and who owns it is
 * the caller's tracked provenance (App's `navLiveOwner`), which follows the
 * same merges. Returns whether anything was rewritten.
 */
export function reownSavedNav(storage: Store, survivorOf: (id: ServerId) => ServerId): boolean {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(NAV_KEY) || '{}'); } catch { return false; }
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).v !== NAV_VERSION) return false;
  const nav = readAt(storage, NAV_KEY, '');
  const move = (pane: PaneRef | null) => (pane ? reownRef(pane, survivorOf) : pane);
  const pane = move(nav.pane);
  const splitCells = nav.splitCells.map((c) => ({ id: c.id, pane: move(c.pane) }));
  if (pane === nav.pane && splitCells.every((c, i) => c.pane === nav.splitCells[i]!.pane)) return false;
  saveNav(storage, { page: nav.page, pane, splitLayout: nav.splitLayout, splitCells });
  return true;
}
