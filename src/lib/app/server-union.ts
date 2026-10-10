// One list over several servers (board #335 ②a-5).
//
// A union list is where two servers become visible at once, and it has to be
// a PROJECTION rather than a new source of truth: each server's own ordering
// rule still decides its rows, and this module only interleaves them.
//
// So it MERGES already-ordered slices with the domain's own comparator — the
// very function that domain sorts by (`projects.compareRows`) — and never
// sorts anything itself. The first version took a `rank` instead, composed
// from `projectUpdatedMs`, and that was a different clock from the one
// `sortRows` uses: `projectUpdatedMs` falls back to `last_seen_at`, which is
// right for the age LABEL and wrong for ordering (the capturer rewrites it on
// every tick). A union built on it could reorder a SINGLE server's list, which
// is the one thing this module must never do (reviewer P1, 2026-10-10).
//
// With one slice a merge of one list IS that list, by construction rather than
// as a property of some rank function — which is why the Single-mode guarantee
// is now structural.
//
// Three properties are the whole point:
//
//   - INDEPENDENT ARRIVAL. The function is pure over whatever slices it is
//     given, so a server that has not answered yet simply is not in them, and
//     the list is complete for the servers that have.
//   - ONE FAILURE DOES NOT ERASE THE OTHERS. A slice that failed contributes
//     no rows and is reported in `missing`, so the view can say which server
//     is unreachable instead of showing a shorter list with no explanation.
//   - EVERY ROW CARRIES ITS REF. A union row is the only place a name is
//     ambiguous, so each one comes out with the `Ref` that names its object on
//     its server. ②b's row actions take their runtime FROM that ref rather
//     than from a single "current" api, which is what keeps a click on B's
//     row from acting on A.
//
// No production list projects a union yet: that arrives with the mode switch
// (③). ②b-1-3 adds `onRow`, the one way a row's action reaches its server,
// and the pins that hold any future union list to it. The server TAG below is
// the data a view would show; its visual atom needs the design-language review
// and is not here.
import type { Ref, ServerId } from './refs.ts';
import { refKey } from './refs.ts';
import type { WsApi } from '../core/ws-api.ts';
import type { ServerRuntime } from './server-runtime.ts';

/** What one server contributed. */
export interface ServerSlice<T> {
  serverId: ServerId;
  /** A short label for the server — its entry name. Shown only when more than
   * one server contributes to the list. */
  name: string;
  /** The server's position in the saved registry. It breaks ties, so a union
   * of two servers whose rows rank equally is STABLE across renders instead of
   * flickering with whichever answered first. */
  order: number;
  /** Did this server answer? `false` means "asked and failed", which is not
   * the same as an empty list. */
  ok: boolean;
  /** This server's rows, in the order ITS own rule put them. */
  items: readonly T[];
}

/** An item together with the server it came from. The comparator takes these
 * rather than bare items, because a cross-server comparison usually needs the
 * source: a room id, a session name and an issue number are unique only
 * WITHIN a server, so the clock or table a domain measures by is the SOURCE
 * server's. Losing the source here is how `proj:app` on two machines came to
 * be read off one room map (reviewer P1, 2026-10-10). */
export interface Sourced<T> {
  serverId: ServerId;
  item: T;
}

/** A row of a union list. */
export interface UnionRow<T, R extends Ref> {
  serverId: ServerId;
  item: T;
  /** Names this object on its own server. */
  ref: R;
  /** `refKey(ref)` — an `{#each}` key that cannot collide across servers. */
  key: string;
  /** The server label to show, or null when only one server contributes.
   * Null in Single mode is what makes the union invisible there. */
  tag: string | null;
}

export interface UnionList<T, R extends Ref> {
  rows: UnionRow<T, R>[];
  /** Servers that were asked and failed. The view owes the user a word about
   * these; it must not quietly show a shorter list. */
  missing: ServerId[];
}

export interface UnionSpec<T, R extends Ref> {
  /** How to name an item of this slice on its server. */
  ref: (serverId: ServerId, item: T) => R;
  /**
   * The DOMAIN's own comparator, in its source-qualified form
   * (`projects.compareRowsWithClock`, reached through an adapter that supplies
   * each server's own `talk`). Used ONLY to decide which slice's head comes
   * next; a slice is never re-sorted, so a comparator that disagreed with the
   * given order would still not change any single server's list.
   *
   * It takes both heads WITH their servers. A bare `(a: T, b: T)` could not
   * express "the more active of two projects both called `app`", because the
   * activity of each is in its own server's room map.
   *
   * Omit it for a list whose order IS the server's answer (tmux's session
   * order): the slices are then concatenated in server order.
   */
  compare?: (a: Sourced<T>, b: Sourced<T>) => number;
  /**
   * Show the source tag? Defaults to "more than one server is in this list",
   * which is the SOURCE SET and not how many answered — a server dropping out
   * must not make the remaining rows stop saying where they are from
   * (reviewer P1, 2026-10-10). ②b passes the mode explicitly where the mode,
   * rather than the count, is what decides.
   */
  showSource?: boolean;
}

/**
 * Merge several servers' already-ordered rows into one list.
 *
 * With one slice the result is that slice, in its given order — a merge of one
 * list cannot reorder it.
 */
export function unionRows<T, R extends Ref>(
  slices: readonly ServerSlice<T>[],
  spec: UnionSpec<T, R>,
): UnionList<T, R> {
  const missing = slices.filter((s) => !s.ok).map((s) => s.serverId);
  // Source order is the saved registry order, so ties and concatenation are
  // stable across renders rather than following whoever answered first.
  const live = slices.filter((s) => s.ok).slice().sort((a, b) => a.order - b.order);
  const tagged = spec.showSource ?? slices.length > 1;

  const make = (slice: ServerSlice<T>, item: T): UnionRow<T, R> => {
    const ref = spec.ref(slice.serverId, item);
    return { serverId: slice.serverId, item, ref, key: refKey(ref), tag: tagged ? slice.name : null };
  };

  if (!spec.compare) {
    return { rows: live.flatMap((slice) => slice.items.map((item) => make(slice, item))), missing };
  }

  // A k-way merge: each step takes the head that the DOMAIN's comparator puts
  // first, ties going to the earlier server. Each slice is consumed in its own
  // order, so no server's list can be reordered by this. Every head carries
  // its server, so the comparator can measure it by that server's own clock.
  const at = live.map(() => 0);
  const head = (i: number): Sourced<T> =>
    ({ serverId: live[i]!.serverId, item: live[i]!.items[at[i]!]! });
  const rows: UnionRow<T, R>[] = [];
  const total = live.reduce((n, s) => n + s.items.length, 0);
  for (let taken = 0; taken < total; taken++) {
    let pick = -1;
    for (let i = 0; i < live.length; i++) {
      if (at[i]! >= live[i]!.items.length) continue;
      if (pick < 0) { pick = i; continue; }
      // Strictly less only: an equal head leaves the earlier server in front.
      if (spec.compare(head(i), head(pick)) < 0) pick = i;
    }
    rows.push(make(live[pick]!, live[pick]!.items[at[pick]!]!));
    at[pick]!++;
  }
  return { rows, missing };
}

/** Every server contributing to a list, in `order`. Useful to a view that
 * needs a per-server section header or an "unreachable" notice. */
export function contributors<T>(slices: readonly ServerSlice<T>[]): ServerSlice<T>[] {
  return slices.slice().sort((a, b) => a.order - b.order);
}

/** What a row action needs from the runtime its row names. `ServerFleet.get`
 * satisfies the lookup. */
export type RowRuntime = Pick<ServerRuntime, 'api' | 'alive'>;

/**
 * Run a union row's action on the server THAT ROW came from (board #335
 * ②b-1-3).
 *
 * A union list spans servers, so it has no owner a component could read once
 * from its context: one `useServerApi()` for every row would send B's delete
 * to A. The owner is the clicked row's REF, and this is the one place a row
 * action turns that ref into an api:
 *
 *   - the runtime is looked up ONCE, from `row.ref.serverId`, and `act` is
 *     handed that api synchronously — FROZEN before its first await. A switch,
 *     a reconnect that replaces the handle, or the fleet dropping B while the
 *     action waits cannot re-target the rest of it; a runtime that was
 *     detached meanwhile refuses the call through its own gate, which is the
 *     right failure for an action whose server went away.
 *   - no live runtime for that server means NO action: `null`, and nothing is
 *     called on any api. There is deliberately no "current server" fallback —
 *     falling back is exactly how a click on B's row acts on A.
 */
export function onRow<R extends Ref, T>(
  row: { ref: R },
  runtimeOf: (id: ServerId) => RowRuntime | null | undefined,
  act: (api: WsApi, ref: R) => T | Promise<T>,
): Promise<T> | null {
  const runtime = runtimeOf(row.ref.serverId);
  if (!runtime || !runtime.alive()) return null;
  const { api } = runtime;
  return Promise.resolve(act(api, row.ref));
}
