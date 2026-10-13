// The bell's union (board #335 ③c-4; plan c4, D6 as ruled 07:55).
//
// Every server keeps its own BOUNDED alert index (`AlertLog`, at most 50
// entries, in its own slot) — the union adds no second history. In
// Aggregate the window's one bell shows the included members' lists merged,
// newest first (an alert's own `ts`, then `seq`; ties by saved order), each
// row tagged by its server when more than one is included (the ③c-1 rule),
// and every action goes BACK to the source: a jump focuses that server and
// lands in THAT tree's Hub (D2 + `landingFor`), `markRoomRead` is the Hub's
// own and reaches only the room's server (`hub_read` to the message's
// server; another server's same-named room is untouched), `viewed`/`failed`
// mark the entry in the list it came from.
//
// D6 — the shown range, the count and Clear use ONE scope: the included
// members' lists. A member that is not CONNECTED right now (offline,
// reconnecting, orphaned) is still shown — its rows marked unavailable, with
// the row's server named — but its entries are not counted read and Clear
// does not touch them: "unavailable" is not "read", and a list that cannot
// be reached is not cleared behind its owner's back. Clear clears the
// available members' lists only, and advances no room's read mark (that is
// `hubPrefs.seen`, moved only by reading).
//
// Single shows the current server's list alone, as before: the union is
// built over the included set, which in Single is the one server.
import type { Alert, AlertLog, CentreSurface, JumpRequest } from '../hub/notify-centre.svelte.ts';
import type { ServerId } from './refs.ts';

export interface CentreSource {
  serverId: ServerId;
  /** The entry's name, for the tag and the unavailable row's label. */
  name: string;
  /** Saved order: the tie-break. */
  order: number;
  /** This server's list, or null when no runtime holds one (never joined). */
  log: AlertLog | null;
  /** Reachable now: connected and serving. */
  available: boolean;
}

export type UnionAlert = Alert & {
  /** The server label to show, or null when only one server contributes. */
  tag: string | null;
  /** The row's server cannot be reached now: shown, not clearable. */
  unavailable: boolean;
};

export interface CentreUnion {
  readonly items: readonly UnionAlert[];
  /** Unviewed entries of AVAILABLE sources (an unreachable list is not
   * counted read, and not counted at all: it cannot be acted on). */
  readonly unviewed: number;
  /** Anything to clear — an available source with entries. */
  readonly clearable: boolean;
  /** Which sources contribute, and which are unavailable (for the foot). */
  readonly sources: readonly CentreSource[];
  /** Clear the AVAILABLE sources' lists; the unavailable keep theirs. */
  clear(): void;
  viewed(alert: Alert): void;
  failed(alert: Alert, reason: string): void;
  readonly anchor: HTMLElement | null;
  toggle(trigger: HTMLElement): void;
  close(): void;
  readonly jump: JumpRequest | null;
  requestJump(alert: Alert): void;
  isCurrent(n: number): boolean;
  consume(n: number): void;
}

/** Pure: the merged list over `sources`, newest first, tagged when more than
 * one server is in the SET (not how many answered — the ③c-1 rule). */
export function unionAlerts(sources: readonly CentreSource[]): UnionAlert[] {
  const showTag = sources.length > 1;
  const rank = new Map(sources.map((s) => [s.serverId, s.order]));
  const rows: UnionAlert[] = [];
  for (const s of sources) {
    for (const a of s.log?.items ?? []) rows.push({ ...a, tag: showTag ? s.name : null, unavailable: !s.available });
  }
  rows.sort((a, b) => b.ts - a.ts || b.seq - a.seq || (rank.get(a.server) ?? 0) - (rank.get(b.server) ?? 0));
  return rows;
}

/** The union over a live `sources()` reading (a `$derived` in the host),
 * and the window's one surface. */
export function createCentreUnion(sources: () => readonly CentreSource[], surface: CentreSurface): CentreUnion {
  const logOf = (alert: Alert) => sources().find((s) => s.serverId === alert.server)?.log ?? null;
  return {
    get items() { return unionAlerts(sources()); },
    get unviewed() { return sources().reduce((n, s) => n + (s.available ? s.log?.unviewed ?? 0 : 0), 0); },
    get clearable() { return sources().some((s) => s.available && (s.log?.items.length ?? 0) > 0); },
    get sources() { return sources(); },
    clear() { for (const s of sources()) if (s.available) s.log?.clear(); },
    viewed(alert) { logOf(alert)?.viewed(alert.key); },
    failed(alert, reason) { logOf(alert)?.failed(alert.key, reason); },
    get anchor() { return surface.anchor; },
    toggle(trigger) { surface.toggle(trigger); },
    close() { surface.close(); },
    get jump() { return surface.jump; },
    requestJump(alert) { surface.requestJump(alert); },
    isCurrent(n) { return surface.isCurrent(n); },
    consume(n) { surface.consume(n); },
  };
}
