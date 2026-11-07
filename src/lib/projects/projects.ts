// Display logic for the Projects section. Pure functions live here so the
// component stays markup: the row ordering and the window-chip rules are the
// parts worth testing, and `node --test` can reach them without a DOM.

import { agentByBackend, paneAgent, type PaneLike } from '../core/agents.ts';
import type { AgentLabel } from '../hub/names.ts';

export type SlotKind = 'shell' | 'agent';

export interface Slot {
  ord: number;
  window_name: string;
  cwd: string;
  kind: SlotKind;
  command?: string;
  auto_run: boolean;
  first_seen_at: number;
  /** Absent until the window has survived long enough to be restorable. */
  settled_at?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  session: string;
  adopted: boolean;
  autostart: boolean;
  created_at: number;
  last_up_at?: number;
  last_seen_at?: number;
  archived: boolean;
  /** The bus room this project's conversation lives in. Recorded on the project
   * (schema v8) rather than derived, so a rename cannot orphan the chat. */
  room?: string;
}

export interface ProjectRow {
  project: Project;
  slots: Slot[];
  live: boolean;
  /** Its agents' labels (`project_list`, board #69), the same table as
   * `hub_agents.labels`; absent on an older server. */
  labels?: AgentLabel[];
}

/** A window the user can expect back after `up` (see capture::SETTLE_SECS). */
export function isRestorable(slot: Slot): boolean {
  return typeof slot.settled_at === 'number';
}

/** Minimal pane shape needed to build a live window chip. */
export type ChipPane = PaneLike & {
  session: string;
  window: number;
  pane: number;
  active?: boolean;
};

export interface WindowChip {
  name: string;
  /** tmux window index — null for a declared window that is not running. */
  window: number | null;
  /** `session:window.pane`, or null when there is nothing to open yet. */
  target: string | null;
  agentIcon: string | null;
  agentTag: string | null;
}

/**
 * Chips for a LIVE project: one per tmux window, taken from its active pane, so
 * tapping one opens exactly that window. This is the source of truth while the
 * session exists — including windows that have not settled into the declaration
 * yet, which you can still want to jump into.
 */
export function liveWindowChips(panes: ChipPane[]): WindowChip[] {
  const byWindow = new Map<number, ChipPane>();
  for (const p of panes) {
    const seen = byWindow.get(p.window);
    if (!seen || (p.active && !seen.active)) byWindow.set(p.window, p);
  }
  return [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([window, pane]) => {
      const agent = paneAgent(pane);
      return {
        name: pane.window_name || String(window),
        window,
        target: `${pane.session}:${pane.window}.${pane.pane}`,
        agentIcon: agent?.icon ?? null,
        agentTag: agent?.tag ?? null,
      };
    });
}

/**
 * Chips for a project that is DOWN: the windows `up` would recreate, in window
 * order. Unsettled windows are left out on purpose — showing a window we would
 * not restore would promise something the reconciler does not deliver. They have
 * no target: there is nothing to open until the project is up.
 */
export function declaredWindowChips(slots: Slot[]): WindowChip[] {
  return slots
    .filter(isRestorable)
    .slice()
    .sort((a, b) => a.ord - b.ord)
    .map((s) => {
      const agent = s.kind === 'agent' ? agentByBackend(s.command) : null;
      return {
        name: s.window_name,
        window: null,
        target: null,
        agentIcon: agent?.icon ?? null,
        agentTag: agent?.tag ?? null,
      };
    });
}

/** One project update clock for every Projects list. Conversation activity is
 * the user-visible change; projects with no room history fall back to tmux's
 * last observation/up/creation time. Bus timestamps are ms, project rows sec. */
export function projectUpdatedMs(row: ProjectRow, talk: Record<string, number> = {}): number {
  const room = row.project.room ?? `proj:${row.project.session}`;
  return talk[room]
    ?? (row.project.last_seen_at ?? row.project.last_up_at ?? row.project.created_at ?? 0) * 1000;
}

/** The same source and formatter for Chat and Terminal sidebar rows. */
export function projectAgeLabel(
  row: ProjectRow,
  talk: Record<string, number> = {},
  nowMs = Date.now(),
): string {
  const updated = projectUpdatedMs(row, talk);
  return updated ? ageLabel(updated / 1000, nowMs / 1000) : '';
}

/**
 * A row together with the activity clock of the SERVER it came from.
 *
 * One list may hold rows from several servers (board #335 ②a-5), and a room
 * id is only unique WITHIN a server: `proj:app` on two machines is two
 * different rooms with two different last-message times, which a single
 * room→ts map cannot express. So the clock travels with the row, and a
 * cross-server comparison reads each side's own.
 */
export interface RowWithClock {
  row: ProjectRow;
  /** That server's `hub_rooms` answer: room id → last message, ms. */
  talk: Record<string, number>;
}

/** The activity a row is ordered by, from ITS server's clock. */
function activityOf({ row, talk }: RowWithClock): number {
  return Math.max(
    talk[row.project.room ?? `proj:${row.project.session}`] ?? 0,
    (row.project.last_up_at ?? row.project.created_at ?? 0) * 1000,
  );
}

/**
 * THE ordering rule, in its source-qualified form: open first, then by
 * activity, each row measured by its own server's clock. Everything else here
 * is a wrapper on it — one definition, so a union cannot drift from a single
 * server's list.
 */
export function compareRowsWithClock(a: RowWithClock, b: RowWithClock): number {
  if (a.row.live !== b.row.live) return a.row.live ? -1 : 1;
  return activityOf(b) - activityOf(a);
}

/** The same rule for ONE server, whose rows all share a clock. */
export function compareRows(talk: Record<string, number> = {}): (a: ProjectRow, b: ProjectRow) => number {
  return (a, b) => compareRowsWithClock({ row: a, talk }, { row: b, talk });
}

/**
 * Order projects: OPEN ones first, then by activity, newest first (owner,
 * 2026-09-23: "已打开的优先排在前面，没有打开的排在后面…然后分别按照时间由近到远").
 * Activity is the newest of the room's last message (`talk`: room id → ms,
 * from `hub_rooms`) and when the project last came up or was created — so a
 * project created a moment ago, still empty, heads its group instead of
 * falling to the bottom for having no conversation yet (the owner's report).
 *
 * Not `last_seen_at`: the capturer rewrites it on every tick, so for a live
 * project it always means "just now" and orders nothing (2026-08-19). Rows
 * are seconds, the bus is milliseconds: normalise before comparing, or a
 * creation time looks like 1970 next to a message.
 *
 * The `talk` argument stays optional for project-only servers without Hub
 * support; production Chat, Terminal and Board all pass the same grouped map.
 *
 * `compareRowsWithClock` is the rule itself, exported because a union over
 * several servers has to INTERLEAVE already-ordered lists with the same
 * comparator this sorts by (board #335 ②a-5) — and has to measure each row by
 * its OWN server's clock, since `proj:app` on two machines is two rooms.
 * Anything that re-derives the clock — `projectUpdatedMs`, for instance, which
 * falls back to `last_seen_at` and is right for the AGE LABEL and wrong for
 * ordering — can reorder a single server's list.
 */
export function sortRows(rows: ProjectRow[], talk: Record<string, number> = {}): ProjectRow[] {
  return rows.slice().sort(compareRows(talk));
}

/**
 * Path label that fits a phone row: full path while it is short, otherwise the
 * last two segments with a leading ellipsis. The full path stays available as
 * the row's title attribute.
 */
export function shortPath(path: string, max = 34): string {
  if (path.length <= max) return path;
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Compact age label, matching the Sessions page vocabulary. */
export function ageLabel(unixSec: number | undefined, nowSec = Date.now() / 1000): string {
  if (!unixSec) return '';
  const d = Math.max(0, Math.floor(nowSec) - unixSec);
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d`;
  const date = new Date(unixSec * 1000);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
