/** Pure helpers for the board's issue DRAFT (board #11): opening an issue
 * edits a copy, and only an explicit Save persists it. Kept out of the
 * component so save/cancel/patch semantics are testable without a DOM.
 * Since board #15 the draft carries ALL FOUR editable fields — status and
 * assignee joined title/body, because a stray tap on a picker was changing
 * live state with no confirmation ("避免手动手滑随便一点就改变了状态"):
 * now every edit waits for the same ✓. */

export interface IssueDraft {
  title: string;
  body: string;
  status: string;
  assignee: string;
}

const FIELDS = ['title', 'body', 'status', 'assignee'] as const;

type IssueLike = { title?: string; body?: string; status?: string; assignee?: string };

/** The editable copy of an issue's fields. */
export const draftOf = (issue: IssueLike | null | undefined): IssueDraft => ({
  title: issue?.title ?? '',
  body: issue?.body ?? '',
  status: issue?.status ?? '',
  assignee: issue?.assignee ?? '',
});

/** Has the draft diverged from the stored issue? Raw comparison — whitespace
 * the user typed is an edit until they remove it. */
export const draftDirty = (draft: IssueDraft, issue: IssueLike): boolean =>
  FIELDS.some((f) => draft[f] !== (issue[f] ?? ''));

/** A draft the server would accept (board #31: the title is OPTIONAL) —
 * an issue just may not be contentless: title or body must say something. */
export const draftValid = (draft: IssueDraft): boolean =>
  draft.title.trim().length > 0 || draft.body.trim().length > 0;

/** The submit chord of a board field (board #36, #348): Cmd+Enter on a Mac,
 * Ctrl+Enter everywhere else. A bare or Shift Enter stays a newline in a
 * multi-line field, and an IME composition's Enter commits the candidate
 * text, never the form. The ONE definition: create and edit both ask it, and
 * what they do with a `true` is their own guarded save. */
export const isSubmitChord = (e: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }): boolean =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing;

/** The chars kept when a titleless issue is identified by its body. Mirrors
 * the Rust `projects::ISSUE_REF_CHARS` — the two ends of the same fallback. */
export const ISSUE_REF_CHARS = 40;

/** The stable display identity of an issue (board #31): the trimmed title
 * when there is one; else the body squashed to one line and cut on a code
 * point boundary (Unicode-safe) with a `…` marker; a legacy all-empty issue
 * falls back to `#id`. Mirrors Rust `projects::issue_ref` — every surface
 * that NAMES an issue (cards, dialogs, notices) speaks this one fallback. */
export function issueRef(issue: { id?: number; title?: string; body?: string } | null | undefined): string {
  const t = (issue?.title ?? '').trim();
  if (t) return t;
  const squashed = (issue?.body ?? '').trim().replace(/\s+/gu, ' ');
  if (!squashed) return `#${issue?.id ?? 0}`;
  const chars = [...squashed];
  if (chars.length <= ISSUE_REF_CHARS) return squashed;
  return `${chars.slice(0, ISSUE_REF_CHARS).join('').trimEnd()}…`;
}

/** ONLY the fields the USER changed, measured against the draft's own BASE —
 * never against the live issue (#11 review): after a concurrent refetch the
 * live body may already be an agent's newer text, and diffing against it
 * would send the user's stale copy of a field they never touched, silently
 * overwriting the agent. `null` when there is nothing to save or the draft
 * is invalid. */
export function draftPatch(
  draft: IssueDraft,
  base: IssueLike,
): Partial<Record<(typeof FIELDS)[number], string>> | null {
  if (!draftValid(draft) || !draftDirty(draft, base)) return null;
  const patch: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const f of FIELDS) {
    if (draft[f] !== (base[f] ?? '')) patch[f] = f === 'title' ? draft[f].trim() : draft[f];
  }
  return patch;
}

/** Three-way rebase after a refetch (#11 review): the server moved while the
 * user was editing. Per field — UNTOUCHED (draft == base) follows the server
 * (the editor shows the agent's fresh text), TOUCHED keeps the user's edit
 * (their save then overwrites that one field, knowingly). The new base is
 * always the server's copy, so a later `draftPatch(draft, base)` still flags
 * exactly the touched fields. */
export function rebaseDraft(
  draft: IssueDraft,
  base: IssueDraft,
  server: IssueDraft,
): { draft: IssueDraft; base: IssueDraft } {
  const pick = (field: keyof IssueDraft) => (draft[field] === base[field] ? server[field] : draft[field]);
  const next = {} as IssueDraft;
  for (const f of FIELDS) next[f] = pick(f);
  return { draft: next, base: { ...server } };
}

// ── Sidebar counts (board #39: "在 board 侧边栏的 projects 列表中 列出当前
// 每个项目中 4 个 board 分别的数量 如果该项目完全为空 则直接不显示该
// project"). The server's hub_board_counts is the bulk read; these helpers
// keep the CLIENT's copy speaking the same dialect — four statuses always
// present, total explicit, an EMPTY board ABSENT from the map (absence =
// hide) — so the sidebar can react to a local create/delete instantly
// instead of waiting out the poll.

import type { BoardCountRow } from '../core/ws.ts';
import { stateIsLive, HUMAN } from './hub.ts';
import type { BackendCatalog } from '../core/agents.ts';

export const BOARD_STATUSES = ['todo', 'doing', 'review', 'done'] as const;

/** Counts a freshly-listed board the way the server shapes its rows: the
 * four fixed statuses zero-filled, `total` explicit — and `null` for an
 * empty list, mirroring the RPC's absence semantics (a key that exists with
 * total 0 would make "hide empty boards" two different checks). A foreign
 * status string counts toward total only, exactly like the server. */
export function countsOf(issues: { status: string }[]): BoardCountRow | null {
  if (!issues.length) return null;
  const c: BoardCountRow = { todo: 0, doing: 0, review: 0, done: 0, total: 0 };
  for (const i of issues) {
    if ((BOARD_STATUSES as readonly string[]).includes(i.status)) c[i.status as (typeof BOARD_STATUSES)[number]]++;
    c.total++;
  }
  return c;
}

/** Fold one board's fresh local read into the counts map — IMMUTABLY, so a
 * $state consumer sees the change. A now-empty board's key is REMOVED (the
 * sidebar hides it the moment the last issue dies, board #39: "删除最后一条
 * 立即从 sidebar 消失"); other sessions' counts are untouched. */
export function applyCounts(
  map: Record<string, BoardCountRow>,
  session: string,
  issues: { status: string }[],
): Record<string, BoardCountRow> {
  const next = { ...map };
  const c = countsOf(issues);
  if (c) next[session] = c;
  else delete next[session];
  return next;
}

/** The sidebar's filter: only projects whose board HAS issues. Absence and
 * total agree by construction (countsOf/the server both refuse zero rows),
 * but the check is total>0 so a defensive zero row could never render. */
export function visibleBoards<T extends { project: { session: string } }>(
  rows: T[],
  counts: Record<string, BoardCountRow>,
): T[] {
  return rows.filter((r) => (counts[r.project.session]?.total ?? 0) > 0);
}

/** The page-head's name lookup runs over the FULL project list, never the
 * filtered one: the current board may be empty — hidden from the sidebar —
 * yet the head must still name it (board #39) so the first issue can be
 * created somewhere that visibly IS the project. */
export function boardTitle(
  rows: { project: { session: string; name: string } }[],
  session: string,
): string | null {
  return rows.find((r) => r.project.session === session)?.project.name ?? null;
}

/** How many EQUAL grid columns the four sidebar count chips get (board #39,
 * owner 2026-09-01: "如果一行能 放下放一行也行，甚至两行放不下，就放一列，动
 * 态适配" — layered on the standing 不要 3+1 rule). The columns are 1fr, so
 * every column must hold the WIDEST chip: n fits iff n·chip + (n−1)·gap ≤ w.
 * The domain is {4, 2, 1} by construction — three across is a ragged 3+1 the
 * moment there is a fourth chip, so it is never offered. Unmeasured inputs
 * (first paint, before the mirror row reports) answer 2: the rectangle is
 * the one layout every width wears without a flash. */
export function chipCols(w: number, chip: number, gap: number): 1 | 2 | 4 {
  if (w <= 0 || chip <= 0) return 2;
  if (4 * chip + 3 * gap <= w) return 4;
  if (2 * chip + gap <= w) return 2;
  return 1;
}

/** WHO is on a card (board #293; #327, owner 2026-10-09: "这里你用的 logo 好
 * 像又是自己发明的一个字母头像…就用他的头像就好…不要去发明新的头像"). An agent
 * assignee wears its BACKEND's own icon (`catalog.icon` — kiro, claude, codex…,
 * the roster's and drawer's avatar) and its name. The backend comes from the
 * agent's hub_agents row, or the one remembered from an earlier poll (a
 * stopped agent keeps its face); one never seen has no picture to wear, so it
 * is the name alone — never an invented lettered tile. `live` is the dot
 * "working on THIS issue", so it is lit ONLY in the doing column, and only
 * while that agent's row runs (`stateIsLive`); a card in todo, review or done
 * never shows it (owner: "他好像还在处理这个已经完成的档的任务"). The human is
 * not an agent: plain text, no picture. Unassigned: null. */
export function assigneeView(
  assignee: string | null | undefined,
  agents: readonly { name: string; state: string; managed?: boolean; agent?: string | null }[],
  status: string,
  known: Readonly<Record<string, string>>,
  /** This server's catalog (board #335 ②b-3): the face is ITS answer. */
  catalog: Pick<BackendCatalog, 'icon'>,
): { name: string; icon: string | null; live: boolean } | null {
  if (!assignee) return null;
  if (assignee === HUMAN) return { name: assignee, icon: null, live: false };
  const row = agents.find((a) => a.name === assignee && a.managed !== false);
  const backend = row?.agent || known[assignee] || null;
  return { name: assignee, icon: catalog.icon(backend), live: status === 'doing' && !!row && stateIsLive(row.state) };
}

/** Each managed agent's backend, as last seen: the poll's rows folded into
 * what was known, so an agent that stops keeps its icon on the cards. */
export function rememberBackends(known: Readonly<Record<string, string>>, agents: readonly { name: string; agent?: string | null; managed?: boolean }[]): Record<string, string> {
  let out: Record<string, string> | null = null;
  for (const a of agents) {
    if (a.managed === false || !a.agent || known[a.name] === a.agent) continue;
    out ??= { ...known };
    out[a.name] = a.agent;
  }
  return out ?? (known as Record<string, string>);
}
