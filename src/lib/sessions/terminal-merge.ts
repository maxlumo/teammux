// The Terminal sidebar's ONE list over several servers (board #371).
//
// #357 parked the other servers' running sessions AFTER this server's whole
// project list. On a phone that list is longer than the sheet, so they sat
// below the fold and the sheet read as Single while the Chat sidebar beside
// it listed both servers. The rule the Hub and the Board already use is the
// answer: each server's slice stays in its own order, the slices are
// INTERLEAVED by the domain's own comparator (`compareRowsWithClock`: live
// first, then activity, each row measured by its OWN server's clock), through
// the one merge (`unionRows`). A live row of another server sits where its
// recency puts it among this server's live rows — never parked last, never
// forced first.
//
// What a foreign SESSION needs to be compared is the project row the Hub
// union already holds for it (its clock travels with the row), found by
// (server, session). A session with no project row (an untracked one, a
// server whose Hub has not answered) is still LIVE, with no activity: it
// sorts after every live row that has some, and stays before the stopped
// ones — an honest "we do not know when", not a made-up time.
import { compareRowsWithClock, type ProjectRow } from '../projects/projects.ts';
import { unionRows, type ServerSlice, type UnionRow } from '../app/server-union.ts';
import type { SessionPick } from '../app/sessions-union.svelte.ts';
import type { TmuxSession } from '../core/ws.ts';
import { refKey, sessionRef, type PaneRef, type Ref, type ServerId } from '../app/refs.ts';

/** The Hub union's knowledge of one project, by (server, session). */
export interface ProjectClock {
  name: string;
  row: ProjectRow;
  /** The row's OWN server's clock (room → last message, ms). */
  talk: Record<string, number>;
}

export type TermItem =
  | { kind: 'local'; row: ProjectRow; talk: Record<string, number> }
  /** THIS server's untracked live session (#371 review P1): one kind of row
   * whichever server it lives on, so it joins the same merge as a foreign
   * bare session — live, unclocked, tagged. */
  | { kind: 'session'; session: TmuxSession; tag: string | null; row: ProjectRow; talk: Record<string, number> }
  | { kind: 'foreign'; pick: SessionPick; name: string; tag: string | null; row: ProjectRow; talk: Record<string, number>; ref: PaneRef; clocked: boolean };

export type TermRow = UnionRow<TermItem, Ref>;

/** The key a host map uses for a (server, session). */
export const clockKey = (serverId: ServerId, session: string) => `${serverId}\u0000${session}`;

/** A running session with no project row: live, no activity. */
function unclocked(session: string): ProjectRow {
  return { project: { id: '', name: session, path: '', session, adopted: false, autostart: false, created_at: 0, archived: false }, slots: [], live: true };
}

/** The other servers' sessions as a list hands them in (Sessions → Projects). */
export interface ForeignInput {
  rows: readonly { serverId: ServerId; item: SessionPick; ref: PaneRef; tag: string | null }[];
  /** The saved order of the included servers (the tie-break). */
  order: readonly ServerId[];
  clock: (serverId: ServerId, session: string) => ProjectClock | null | undefined;
}

export interface MergeArgs {
  /** This server (the focused one): its rows are the `local` slice. */
  localId: ServerId;
  /** Its Projects rows in ITS order (`sortRows`), and the clock they were ordered by. */
  local: readonly ProjectRow[];
  localTalk: Record<string, number>;
  /** THIS server's untracked live sessions (those no project row tracks) and
   * the tag they wear; empty/absent outside the phone's Aggregate list. */
  localSessions?: readonly TmuxSession[];
  localTag?: string | null;
  /** The saved order of the included servers: it breaks ties, so the list is
   * stable across renders instead of following whoever answered first. */
  order: readonly ServerId[];
  /** The other servers' sessions, from the sessions union (tmux's order). */
  foreign: ForeignInput['rows'];
  clock: ForeignInput['clock'];
}

export function mergeTerminalRows(a: MergeArgs): TermRow[] {
  const cmp = (x: { item: TermItem }, y: { item: TermItem }) =>
    compareRowsWithClock({ row: x.item.row, talk: x.item.talk }, { row: y.item.row, talk: y.item.talk });
  const locals: TermItem[] = a.local.map((row) => ({ kind: 'local', row, talk: a.localTalk }));
  // Bare local sessions are live with no recorded activity, exactly the policy
  // for a foreign one. The local slice must be ordered by the rule before it
  // is merged, so it is ordered ONCE here — but only when there is something
  // to place: with no bare sessions the project rows keep their own sortRows
  // order untouched (Single, and any list without them).
  if (a.localSessions?.length) {
    for (const session of a.localSessions) locals.push({ kind: 'session', session, tag: a.localTag ?? null, row: unclocked(session.name), talk: {} });
    locals.sort((x, y) => cmp({ item: x }, { item: y }));
  }
  const byServer = new Map<ServerId, TermItem[]>();
  for (const f of a.foreign) {
    const c = a.clock(f.serverId, f.item.name);
    const row: ProjectRow = c ? { ...c.row, live: true } : unclocked(f.item.name);
    const item: TermItem = { kind: 'foreign', pick: f.item, name: c?.name || f.item.name, tag: f.tag, row, talk: c?.talk ?? {}, ref: f.ref, clocked: !!c };
    (byServer.get(f.serverId) ?? byServer.set(f.serverId, []).get(f.serverId)!).push(item);
  }
  // A slice is handed to the merge already ordered by the domain rule; a
  // foreign slice arrives in tmux's order, so it is ordered here, stably.
  for (const items of byServer.values()) items.sort((x, y) => cmp({ item: x }, { item: y }));
  const slices: ServerSlice<TermItem>[] = a.order.map((id, order) => ({
    serverId: id, name: id, order, ok: true,
    items: id === a.localId ? locals : byServer.get(id) ?? [],
  }));
  if (!a.order.includes(a.localId)) slices.push({ serverId: a.localId, name: a.localId, order: slices.length, ok: true, items: locals });
  const merged = unionRows<TermItem, Ref>(slices, {
    ref: (serverId, item) => item.kind === 'foreign' ? item.ref : sessionRef(serverId, item.row.project.session),
    compare: (x, y) => cmp(x, y),
    showSource: false,
  });
  // A project row keeps its project id as its key (its animation identity);
  // a bare local session is keyed by its server + session name, like a foreign one.
  return merged.rows.map((r) => ({ ...r, key: r.item.kind === 'local' ? `local:${r.item.row.project.id}` : r.item.kind === 'session' ? `session:${JSON.stringify([r.serverId, r.item.session.name])}` : refKey(r.ref) }));
}
