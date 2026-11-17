/** The Dashboard view's pure logic (board #109; design
 * docs/design-docs/features/dashboard.md § The view). The server answers the
 * derived facts (`hub_dashboard`, #108); the client classifies who needs a
 * person with its ONE definition (`needsPerson`, leader #108 note 6) and picks
 * Notes for you with the ONE "to me" predicate (`toMe`). No DOM here. */
import { needsPerson, stateIsLive } from './hub.ts';
import { toMe, type FeedMsg } from './notifications.ts';

/** One live managed agent as `hub_dashboard` answers it. */
export interface DashAgent {
  name: string;
  label?: string;
  state: string;
  detail?: string | null;
  since?: number | null;
  issue?: { id: number; title: string } | null;
  status?: { text: string; ts: number } | null;
}

export type AgentClass = 'needsYou' | 'notRunning' | 'waiting' | 'working' | 'idle';

/** How an agent counts, ONCE, in the order the plan's § 4 rules (leader #109
 * note 17): a detail that needs a person (`needsPerson`, the card's amber "a
 * person has to act"), then a CLI that is starting or exited, then a turn
 * waiting on a pane prompt, then a running turn; the rest is idle. */
export function agentClass(a: Pick<DashAgent, 'state' | 'detail'>): AgentClass {
  if (needsPerson(a.detail)) return 'needsYou';
  if (a.state === 'exited' || a.state === 'starting') return 'notRunning';
  if (a.state === 'waiting' || a.state === 'blocked') return 'waiting';
  if (stateIsLive(a.state)) return 'working';
  return 'idle';
}

export interface AgentSummary {
  counts: Record<AgentClass, number> & { stopped: number };
  /** Every agent that is not idle, in the classification's order (needs you,
   * not running, waiting, working), each in the roster's order within. */
  rows: DashAgent[];
}

const ROW_ORDER: AgentClass[] = ['needsYou', 'notRunning', 'waiting', 'working'];

/** The counts line's parts, in § 4's order, only those that are not zero. */
export const COUNT_ORDER = ['working', 'waiting', 'idle', 'notRunning', 'needsYou', 'stopped'] as const;
export function countParts(counts: AgentSummary['counts']): { key: (typeof COUNT_ORDER)[number]; n: number }[] {
  return COUNT_ORDER.map((key) => ({ key, n: counts[key] })).filter((p) => p.n > 0);
}

export function agentSummary(agents: readonly DashAgent[], stopped: number): AgentSummary {
  const counts = { needsYou: 0, notRunning: 0, waiting: 0, working: 0, idle: 0, stopped };
  for (const a of agents) counts[agentClass(a)]++;
  const rows = ROW_ORDER.flatMap((c) => agents.filter((a) => agentClass(a) === c));
  return { counts, rows };
}

/** Notes for you: the newest `want` messages of the room that are TO ME
 * (`toMe`, the notification centre's own predicate) and are not asks (asks
 * are Needs you). `pages` are hub_log pages, NEWEST page first, each page's
 * messages oldest first as the server sends them. */
export function pickNotes<M extends FeedMsg & { seq?: number; kind?: string }>(pages: readonly (readonly M[])[], want = 3): M[] {
  const out: M[] = [];
  for (const page of pages) {
    for (let i = page.length - 1; i >= 0 && out.length < want; i--) {
      const m = page[i]!;
      if (m.kind !== 'ask' && toMe(m)) out.push(m);
    }
    if (out.length >= want) break;
  }
  return out;
}

/** A poll's Notes (#109 R1, leader note 110): the lines `held` (newest first, at most
 * `want`) merged with what the poll read above topSeen (`fresh`, pages newest first, each
 * oldest first), the newest `want` kept. Nothing else is held, so a quiet poll (no fresh
 * line) leaves the same lines, whatever how many polls. */
export function foldNotes<M extends FeedMsg & { seq?: number; kind?: string }>(held: readonly M[], fresh: readonly (readonly M[])[], want = 3): M[] {
  return pickNotes([...fresh, [...held].reverse()], want);
}

/** The most pages Notes reads back (leader #109 note 5): 10 pages of 100, the
 * hard stop, SAID in the view when it is reached with fewer than three. */
export const NOTES_PAGE = 100;
export const NOTES_MAX_PAGES = 10;

export type BoardView = 'dashboard' | 'board';
/** Where each host remembers its own choice (board #147): the Board tab, and
 * the Hub drawer's board, each Dashboard by default (D2). */
export const BOARD_VIEW_KEY = 'tmux_board_view';
export const DRAWER_VIEW_KEY = 'tmux_drawer_board_view';

/** A host's view, remembered per device; Dashboard by default (D2). */
export function boardViewOf(store: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null, key = BOARD_VIEW_KEY): BoardView {
  try { return store?.getItem(key) === 'board' ? 'board' : 'dashboard'; } catch { return 'dashboard'; }
}

export function rememberBoardView(v: BoardView, store: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null, key = BOARD_VIEW_KEY): void {
  try { store?.setItem(key, v); } catch { /* a private window keeps it for the session only */ }
}

/** Board #150: whether a host's status block (Needs you, Now, Notes) is folded to its one
 * line, remembered per device and per host, the view memory's pattern; unfolded by default. */
export const BOARD_FOLD_KEY = 'tmux_dash_folded';
export const DRAWER_FOLD_KEY = 'tmux_drawer_dash_folded';

export function statusFoldedOf(store: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null, key = BOARD_FOLD_KEY): boolean {
  try { return store?.getItem(key) === '1'; } catch { return false; }
}

export function rememberStatusFolded(folded: boolean, store: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null, key = BOARD_FOLD_KEY): void {
  try { store?.setItem(key, folded ? '1' : '0'); } catch { /* a private window keeps it for the session only */ }
}

/** Unread = after the room's ONE server mark (board #334), the same on every
 * device. `null`: the room has no mark yet, so everything is unread;
 * `undefined`: the mark could not be read, so nothing is marked (unknown is
 * never "unread"). */
export function isUnread(m: { seq?: number }, mark: { seq: number } | null | undefined): boolean {
  if (mark === undefined) return false;
  return (m.seq ?? 0) > (mark?.seq ?? 0);
}
