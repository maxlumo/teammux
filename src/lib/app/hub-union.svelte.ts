// The Hub sidebar's union source (board #335 ③c-2).
//
// Every tree's Hub keeps its own project list, ordered by its own server's
// rule and clock (`projects.compareRowsWithClock` over that server's talk
// map). In Aggregate the VISIBLE Hub's sidebar shows every included server's
// projects in one list. That list is a PROJECTION (②a-5 and `server-union.ts`):
// each Hub PUBLISHES its already-ordered slice here, and the one list is a
// k-way merge of the slices with the domain's own comparator, each row
// measured by its SOURCE server's clock, ties broken by saved order. No
// second poller, no re-sort (D4): a hidden member's Hub still refreshes its
// list on its own cadence and publishes; this module only holds what it got.
//
// The source is App's, read-only to the Hubs that render it; a Hub writes
// only its OWN slice (`publish(serverId, …)`), keyed by the runtime handle so
// a replaced runtime for the same id does not inherit the old one's rows, and
// withdraws it when its tree goes (`withdraw`). `missing` names servers whose
// slice is absent — a member whose Hub has not answered, or has no Hub — so
// the view can say so rather than show a shorter list in silence.
import { SvelteMap } from 'svelte/reactivity';
import type { ProjectRow } from '../projects/projects.ts';
import { compareRowsWithClock } from '../projects/projects.ts';
import type { ServerId, SessionRef } from './refs.ts';
import { sessionRef } from './refs.ts';
import { unionRows, type ServerSlice, type UnionRow } from './server-union.ts';

/** What one Hub publishes about its server's projects. */
export interface HubSlice {
  /** The server's rows, in ITS order (`sortRows` already applied). */
  rows: readonly ProjectRow[];
  /** room → last talk timestamp: this server's activity clock. */
  talk: Record<string, number>;
  /** session → unread summary, this server's. */
  unread: Record<string, { count: number }>;
  /** session → agent states (for the row's agent faces), this server's. */
  agentStates: Record<string, unknown>;
  /** Live panes, this server's (for the row's agent counts). */
  panes: readonly unknown[];
}

export type HubUnionRow = UnionRow<ProjectRow, SessionRef> & {
  /** The row's own server's clock and companions, for the row's labels. */
  slice: HubSlice;
};

export interface HubUnion {
  /** Publish server `id`'s slice from runtime `owner`. A publish from a
   * runtime that is not the current owner of `id` is ignored. */
  publish(owner: object, id: ServerId, slice: HubSlice): void;
  /** `owner`'s slice is gone (its tree unmounted). */
  withdraw(owner: object): void;
  /** The merged list over `included` (saved order), with `tag` per row when
   * more than one server is included and `missing` for those without a
   * slice. Reactive: a `$derived` over it follows every publish. */
  rows(included: readonly { id: ServerId; name: string }[]): { rows: HubUnionRow[]; missing: ServerId[] };
}

export function createHubUnion(): HubUnion {
  /** owner runtime → [serverId, slice] */
  const slices = new SvelteMap<object, { id: ServerId; slice: HubSlice }>();
  return {
    publish(owner, id, slice) { slices.set(owner, { id, slice }); },
    withdraw(owner) { slices.delete(owner); },
    rows(included) {
      const byId = new Map<ServerId, HubSlice>();
      for (const { id, slice } of slices.values()) byId.set(id, slice);
      const serverSlices: ServerSlice<ProjectRow>[] = included.map((s, order) => {
        const slice = byId.get(s.id);
        return { serverId: s.id, name: s.name, order, ok: !!slice, items: slice?.rows ?? [] };
      });
      const list = unionRows<ProjectRow, SessionRef>(serverSlices, {
        ref: (serverId, row) => sessionRef(serverId, row.project.session),
        // Each head measured by ITS server's clock (reviewer P1, 2026-10-10).
        compare: (a, b) => compareRowsWithClock(
          { row: a.item, talk: byId.get(a.serverId)?.talk ?? {} },
          { row: b.item, talk: byId.get(b.serverId)?.talk ?? {} },
        ),
      });
      const empty: HubSlice = { rows: [], talk: {}, unread: {}, agentStates: {}, panes: [] };
      return {
        rows: list.rows.map((r) => ({ ...r, slice: byId.get(r.serverId) ?? empty })),
        missing: list.missing,
      };
    },
  };
}
