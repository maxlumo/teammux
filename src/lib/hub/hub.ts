// Pure display logic for the Hub view — testable with node --test, no Svelte.
import type { HubAgent, HubActivityEvent } from '../core/ws.ts';
import type { BackendCatalog } from '../core/agents.ts';
import { ALL_TARGET, busyTargetsFor, targetMembers, targetTeam, teamRoot } from './hub-composer.ts';

/**
 * THE status colour language — one progression, read at a glance (owner,
 * 2026-08-20: "不同的颜色应该是渐进式的 … 设计好颜色所表达的含义"):
 *
 *   accent (cyan)  = MOTION      — a turn is open, work is happening now
 *                                  (running/working; the same colour the
 *                                  progress row's lane bar and the tool
 *                                  lane's pulse already use)
 *   ok (green)     = SUCCESS     — finished well (done)
 *   warn (amber)   = NEEDS YOU   — paused on a person (waiting/blocked)
 *   danger (red)   = FAILED      — a thing that failed and has not recovered
 *   sleep (grey)   = AT REST     — nothing happening, nothing wrong (idle)
 *
 * The progression start → running → done reads accent → green, which matches
 * the CI intuition (a spinner is never green; green means it ENDED well).
 * `working` used to be green, which made every busy agent look already
 * finished. Both readers below speak this one language; do not fork it.
 *
 * Derived-state → dot color (theme token values are resolved in CSS; these
 * are the fallback literals used inline for dynamic dots).
 *
 * No AGENT state is `failed` any more (board #354): a failed turn end is
 * rest with the fact in its detail, because the red dot stood for minutes
 * over an agent that had already recovered from a network timeout. The word
 * stays in the language for the things that really are still failing — an
 * unreachable server in `app/ServerList` asks for this colour by that name,
 * and an agent's own `[tmm status failed]` note wears it through
 * `noteStateColor` — and that is why it is not a literal red anywhere.
 */
export function stateDotColor(state: string, detail = ''): string {
  // An agent at rest that a person must unblock (board #362 c: its CLI
  // painted an error no `continue` fixes) wears the same amber as one that
  // asked: the one "a person has to act" colour, not a new one.
  if (needsPerson(detail)) return 'var(--status-warn)';
  switch (state) {
    case 'running':
    case 'working': return 'var(--accent)';       // 'working' = pre-2026-08 name
    case 'waiting':
    case 'blocked': return 'var(--status-warn)';  // paused on a person
    case 'failed': return 'var(--status-danger)';  // never an agent's state (#354)
    case 'shell': return 'var(--text3)';          // outside the vocabulary
    default: return 'var(--status-sleep)'; // idle
  }
}

/**
 * Which states wear the RUNNING cue — app.css `.live-dot`: full-strength fill,
 * an accent halo, and the presence breathe. ONE definition so the sidebar
 * chip, the roster card and the recipient picker cannot disagree about what
 * "in motion" looks like (the colour alone was not enough at 5–7px; see the
 * .live-dot comment for the measurements). `working` is the pre-2026-08 name
 * for the same thing, exactly as in stateDotColor above.
 */
export function stateIsLive(state: string): boolean {
  return state === 'running' || state === 'working';
}

/** Which states mean "a PERSON has to act" — the amber half of the status
 * language (`stateDotColor` → --status-warn). The agent card wears a
 * card-level cue for them (`.acard.needs`: amber frame + wash + a short
 * label), because a 6px static dot was the weakest signal on the card while
 * being the one that needs the human most (review, 2026-09-03). Static on
 * purpose: `.live-dot`'s breathe says "a turn is open", and a waiting turn
 * is suspended, not running. `blocked` is `tmm status`'s wider word for it. */
export function stateNeedsYou(state: string, detail = ''): boolean {
  return state === 'waiting' || state === 'blocked' || needsPerson(detail);
}

/** The status details that mean a PERSON must act on an agent at rest
 * (board #362 c), as the server derives them: its CLI's newest paint was an
 * expired credential (`auth_expired`) or a conversation that fails every
 * turn (`conversation_blocked`), or auto-continue stopped for its errors
 * (`recovery_exhausted`). Never auto-continued; each has its remedy in the
 * hover (`hubDetail_<detail>`). */
export const PERSON_DETAILS: readonly string[] = ['auth_expired', 'conversation_blocked', 'recovery_exhausted'];

export function needsPerson(detail: string | undefined | null): boolean {
  return !!detail && PERSON_DETAILS.includes(detail);
}

/** Four capacity bands, not a colour ramp (#180, owner 2026-09-12).
 * 85% retains the compaction-imminent anchor; intermediate hues are retired. */
export function ctxColor(pct: number): string {
  const n = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  if (n < 50) return 'var(--status-ok)';
  if (n < 70) return 'var(--status-warn)';
  if (n < 85) return 'var(--status-hot)';
  return 'var(--status-danger)';
}

/** Merge new chat messages into the feed without duplicates, oldest first.
 * Pushes and cursor polls overlap; identity is the message id when present,
 * else (ts, from, body). */
export function mergeMessages<T extends { id?: string; ts?: number; seq?: number; from?: string; body?: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const key = (m: T) => m.id ?? `${m.ts}|${m.from}|${m.body}`;
  const seen = new Set(existing.map(key));
  const merged = existing.slice();
  for (const m of incoming) {
    if (!seen.has(key(m))) {
      seen.add(key(m));
      merged.push(m);
    }
  }
  // ts, then the bus's own log position: two messages can share a millisecond,
  // and with paging (board #9) they can arrive in DIFFERENT responses — a
  // ts-only sort left whichever landed first in front. `seq` is stable and
  // gapless; rows without one (older servers) keep the ts order they had.
  merged.sort((a, b) => ((a.ts ?? 0) - (b.ts ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0)));
  return merged;
}

/** Merge activity events without losing history (board #9): id-keyed dedupe
 * (the durable log's row id; pre-paging rows fall back to a content key),
 * sorted by (ts, id) so a prepended older page and an appended poll both land
 * in log order. Returns the EXISTING array when nothing new arrived, so the
 * poll path can skip a re-render. No length cap: the initial page is bounded
 * by the server, and everything past it was loaded on purpose. */
export function mergeEvents<T extends { ts: number; id?: number; window?: string; kind?: string; text?: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const key = (e: T) => (e.id != null ? `#${e.id}` : `${e.ts}|${e.window}|${e.kind}|${e.text}`);
  const seen = new Set(existing.map(key));
  const fresh = incoming.filter((e) => !seen.has(key(e)));
  if (!fresh.length) return existing;
  return [...existing, ...fresh].sort((a, b) => (a.ts - b.ts) || ((a.id ?? 0) - (b.id ?? 0)));
}

/** One step of the GAP WALK behind an incremental poll (review C, 2026-09-03).
 *
 * `hub_log(since_ts)` answers the newest page and drops what is older than the
 * cursor; when more than a page arrived since the cursor (a room parked in
 * `roomCache` for an hour of `@all` chatter — pushes for a non-selected room
 * are not merged), the older new messages are not on it. The server says so
 * with `has_more`, and the client walks `before_seq` pages backwards until a
 * page reaches the cursor. This decides one step: which rows of the page are
 * NEW (newer than `floorTs`, the cursor the poll started from) and where the
 * next page is — `null` when the walk is done, because the page reached back
 * to (or past) the cursor, came back empty, or the server has nothing older. */
export function gapWalkStep<T extends { ts?: number }>(
  page: { messages?: T[]; has_more?: boolean; oldest_seq?: number } | null | undefined,
  floorTs: number,
): { newer: T[]; next: number | null } {
  const msgs = page?.messages ?? [];
  const newer = msgs.filter((m) => (m.ts ?? 0) > floorTs);
  const reached = !msgs.length || newer.length < msgs.length;
  const cursor = page?.oldest_seq ?? 0;
  const next = !reached && page?.has_more && cursor > 0 ? cursor : null;
  return { newer, next };
}

/** Backend identity colors: consistent across sidebar, cards and registry so a
 * glance identifies who is who. The VALUES live in app.css (`--backend-*`) with
 * the other tokens — a literal colour in a component is a new visual species
 * (design-language.md §Colour); this only names the token (review C, 2026-09-03). */
export function backendColor(backend: string | null | undefined, catalog: Pick<BackendCatalog, 'colorToken'>): string {
  // The served list names the token (board #130) — THAT server's list, which
  // the caller passes (board #335 ②b-3); the switch is the older-server
  // fallback (kimi included since board #224 made it spawnable).
  const token = catalog.colorToken(backend);
  if (token) return `var(${token})`;
  switch (backend) {
    case 'kiro': case 'claude': case 'codex': case 'kimi': case 'grok': case 'omp':
      return `var(--backend-${backend})`;
    default: return 'var(--backend-other)';
  }
}

/** Who the composer talks to when the user has not chosen anyone.
 *
 * A conversation has ONE default recipient — the lead. Typing `@name` to reach
 * the only agent in the room is ceremony, so the room picks a lead and the
 * composer addresses it silently. Order of preference:
 *   1. the stored choice for this project, while that agent is still present;
 *   2. the only managed agent, when there is exactly one;
 *   3. an agent whose registry definition can hire (that IS the lead role);
 *   4. the lowest window index, so the answer is stable rather than arbitrary.
 * Returns '' when there is no managed agent and no explicit destination.
 *
 * `stored` distinguishes an agent name, a team target, ALL_TARGET, explicit
 * `''` (record only), and null/absent. The explicit destination modes are kept
 * without agents (#171); null/absent =
 * nobody chose, so the rule seats a lead. Before, '' and unset were the same
 * value, so "no recipient" was re-seated by the next 5 s roster poll. */
export function pickLead(
  agents: readonly HubAgent[],
  stored?: string | null,
): string {
  if (stored === '' || stored === ALL_TARGET) return stored;
  if (stored && targetTeam(stored)) return targetMembers(stored, agents).length ? stored : '';
  const managed = agents.filter((a) => a.managed);
  if (!managed.length) return '';
  if (stored && managed.some((a) => a.name === stored)) return stored;
  if (managed.length === 1) return managed[0]!.name;
  // No Manager role since 2026-09-26: the lowest window is the stable seat.
  return managed.slice().sort((a, b) => a.window - b.window)[0]!.name;
}

/** The drawer bar's window pills (board #92 + #320). Collapsed, the bar is
 * the project's SHELL — the lowest-indexed non-agent window, the one `up`
 * creates first — then the agent windows; every other non-agent window folds
 * behind `+N`, except the one the terminal is showing (`isCurrent`): the bar
 * never hides the current pane. Expanded, every window, the shell still
 * first. `folded` is what the `+N` counts; the shell is never in it (owner
 * 2026-10-08: "启动的项目里有一个0的 window，这个在侧边栏应该不要自动给我hide起来"). */
export function drawerWindowPills<T extends Pick<HubAgent, 'window' | 'agent'>>(
  windows: readonly T[], expanded: boolean, isCurrent: (w: T) => boolean,
): { pills: T[]; folded: number } {
  let shell: T | undefined;
  for (const w of windows) if (!w.agent && (!shell || w.window < shell.window)) shell = w;
  const rest = windows.filter((w) => w !== shell);
  const shown = expanded ? rest : rest.filter((w) => w.agent || isCurrent(w));
  const pills = shell ? [shell, ...shown] : shown;
  return { pills, folded: windows.length - pills.length };
}

/** Whose pane the terminal partition shows — ONE definition (board #209).
 * The recipient's, when the recipient is a named managed agent (#76: "应该优先
 * 跳转到当前所选的 agent 的 terminal window"); otherwise (room, ALL, nobody) the
 * first managed agent, then anything. `openDrawer`, `setRecipient`'s retarget
 * (#91), the room-switch restore and the late seat after a fresh roster all
 * ask this — the last two used to pick the first managed agent on their own,
 * so returning to a room showed the selected card beside another agent's pane
 * (owner, 2026-09-20: "选中的 agent card 好像保留了，但是右边侧边栏对应的 terminal
 * 好像没有保留到我选的 agent，这样左右不同步了"). */
export function pickDrawerAgent(agents: readonly HubAgent[], recipient: string): HubAgent | undefined {
  return (recipient && recipient !== ALL_TARGET ? agents.find((a) => a.managed && a.name === recipient) : undefined)
    ?? agents.find((a) => a.managed)
    ?? agents[0];
}

/** Busy first, then newest state edge; window order breaks ties (#168). */
export function sortAgentsForRoster(agents: readonly HubAgent[]): HubAgent[] {
  const busy = new Set(busyTargetsFor(ALL_TARGET, agents));
  return agents.slice().sort((a, b) =>
    Number(busy.has(b.name)) - Number(busy.has(a.name))
    || (b.since ?? 0) - (a.since ?? 0)
    || a.window - b.window);
}

/** Keep a launched team together without inventing another activity rank.
 * Call with the already sorted (or hover-held) list: the first member fixes
 * the group's position, and members retain their relative recency order. */
export function rosterGroups(agents: readonly HubAgent[]): { key: string; team: string | null; members: HubAgent[] }[] {
  const groups: { key: string; team: string | null; members: HubAgent[] }[] = [];
  const teams = new Map<string, (typeof groups)[number]>();
  for (const agent of agents) {
    const team = teamRoot(agent.team);
    if (!team) {
      groups.push({ key: `agent:${agent.name}`, team: null, members: [agent] });
      continue;
    }
    let group = teams.get(team);
    if (!group) {
      group = { key: `team:${team}`, team, members: [] };
      teams.set(team, group);
      groups.push(group);
    }
    group.members.push(agent);
  }
  return groups;
}

/** Teams with NO live member, from the stopped identities (board #287,
 * owner 2026-09-30: after "team stop" the team vanished and could only be
 * started member by member). `stoppedTeams` is hub_agents' map (stopped name
 * -> team path). A team that still has a live member keeps its live group
 * and menu; one drawn from stopped members follows `namedGroup` (two or
 * more), a lone stopped member being its own card. Order: first appearance
 * in `stopped`. Pure. */
export function stoppedGroups(
  stopped: readonly string[],
  stoppedTeams: Readonly<Record<string, string>>,
  live: readonly { team?: string | null }[],
): { team: string; members: string[] }[] {
  const alive = new Set(live.map((a) => teamRoot(a.team)).filter(Boolean));
  const out: { team: string; members: string[] }[] = [];
  for (const name of stopped) {
    const team = teamRoot(stoppedTeams[name]);
    if (!team || alive.has(team)) continue;
    const g = out.find((x) => x.team === team);
    if (g) g.members.push(name);
    else out.push({ team, members: [name] });
  }
  return out.filter((g) => namedGroup(g));
}

/** Does the strip draw this group AS a team (label, baseline, one lit
 * enclosure)? A team with one live member is drawn as that member's plain
 * card. The ONE definition: the markup and the selection marker both read it,
 * so a team that shrinks to one member can never leave the marker aimed at an
 * enclosure that is no longer drawn (#241). */
export const namedGroup = (group: { team: string | null; members: readonly unknown[] }): boolean =>
  !!group.team && group.members.length > 1;

/** The selector the strip's ONE marker glides to (motion principle 14): the
 * whole group under All, the lit team's enclosure while it is drawn as a
 * team, else the lit card(s); `''` when the recipient is the room itself.
 * `team` is the lit team's root, `addressed` whether any strip card is a
 * current recipient. */
export function rosterMarker({ all, team, groups, addressed }: {
  all: boolean;
  team: string | null;
  groups: readonly { team: string | null; members: readonly unknown[] }[];
  addressed: boolean;
}): string {
  if (all) return ':scope > .tabs-extent';
  if (team && groups.some((g) => g.team === team && namedGroup(g))) return '.roster-cluster.team-lit';
  return addressed ? '.acard.sel[data-agent]' : '';
}

/** The body to post for `text` addressed at `to`. `''` means everyone (the
 * room's broadcast), and an explicit `@` anywhere means the user is addressing
 * people by hand — never rewrite that. */
export function addressed(text: string, to: string): string {
  const body = text.trim();
  if (!body || !to) return body;
  // The chip ALWAYS addresses the recipient (owner, 2026-08-26: "前边的永远
  // 保留，后边的at如果存在某人的话也会发送过去") — it used to stand down when
  // the body contained ANY `@`, so an email address or a quoted @all defeated
  // the chosen recipient silently. Extra @mentions in the body still deliver:
  // the server scans the WHOLE body for mentions, not just the head. Only a
  // body already LEADING with this same recipient skips the prefix (no
  // `@dev @dev`).
  const esc = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^@${esc}(?:[\\s,:;.!?]|$)`, 'u').test(body)) return body;
  return `@${to} ${body}`;
}

/** Team selection is one room message with the existing exact @name tokens. */
export function addressedTeam(text: string, members: readonly string[]): string {
  const body = text.trim();
  if (!body || !members.length) return body;
  return `${[...new Set(members)].map((name) => `@${name}`).join(' ')} ${body}`;
}

/** "2m14s" / "1h03m" / "12s" — how long the current state has held. Compact on
 * purpose: it sits inside an agent chip, and the point is the order of
 * magnitude, not the precision. `since` is epoch SECONDS (what the server
 * reports); `now` is epoch ms so the caller can pass a ticking clock. */
export function fmtElapsed(since: number, now: number): string {
  if (!since) return '';
  const s = Math.max(0, Math.floor(now / 1000) - since);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

/** How long ago, at sidebar precision: "now", "5m", "2h", "3d". One unit only —
 * the row is a summary, and `fmtElapsed`'s two-unit form ("2h14m") is running-
 * timer language, not last-reply language (owner, 2026-08-24: the project list
 * should show "上次回复的时间"). Both arguments in ms; 0/absent → ''. */
export function agoShort(ts: number, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** What kind of news a message is — the ONE rule shared with the server's
 * unread summary (`rooms::news_kind`, whose case table hub.test.ts runs here,
 * board #322). Own words and app narration are none, except a board move to
 * review/done; that and a `done` status note are `finished` (rings at every
 * level); other status notes are `status` (progress, `all` only); anything
 * else an agent says is a `reply`. */
export type NewsKind = 'none' | 'reply' | 'status' | 'finished';
export function newsKind(m: { from?: string; body?: string }): NewsKind {
  const from = m.from ?? '';
  if (!from || from === 'human') return 'none';
  if (systemLine(m.body) !== null) {
    const b = boardLine(systemLine(m.body));
    return b && (b.to === 'review' || b.to === 'done') ? 'finished' : 'none';
  }
  const note = statusNote(m.body);
  if (note) return note.state === 'done' ? 'finished' : 'status';
  return 'reply';
}

/** The read watermark of a room: the last read message's seq, and its ts (a
 * legacy mark has only the ts). A message is above it by seq when the mark
 * has one — two messages can share a millisecond — else by ts. */
export type SeenMark = { seq: number; ts: number };
export function aboveMark(m: { seq?: number; ts?: number }, mark: SeenMark): boolean {
  return mark.seq > 0 && (m.seq ?? 0) > 0 ? (m.seq ?? 0) > mark.seq : (m.ts ?? 0) > mark.ts;
}

/** Who has said something NEW in the open room: the senders of the messages
 * above the read mark that `newsKind` calls news (the roster card's unread
 * dot; the same rule as the server's per-room summary, board #322). */
export function unreadSenders(feed: readonly { seq?: number; ts?: number; from?: string; body?: string }[], mark: SeenMark): Set<string> {
  const out = new Set<string>();
  for (const m of feed) {
    if (newsKind(m) !== 'none' && aboveMark(m, mark)) out.add(m.from ?? '');
  }
  return out;
}

/** Markdown image references in a message body, split from the prose.
 *
 * `tmm send --image` appends `![](src)` lines, and agents write the same syntax
 * by hand. They are pulled OUT of the markdown rather than left to the renderer
 * because a local path is not a URL a webview can load: the src has to go
 * through the file service first, which means the client needs the list, not an
 * `<img>` tag it would have to rewrite afterwards. Text keeps its markdown. */
/** A bare image reference in prose: an http(s) URL or an absolute/`~` path
 * ending in an image extension. Agents rarely write markdown image syntax —
 * they answer "截图在 /tmp/shot.png" (owner, 2026-08-26: "如果有图片的返回
 * 可以返回图片路径或者 url，然后你正确读图渲染出来"). */
const BARE_IMG = String.raw`(?:https?:\/\/[^\s<>()"']+?|(?<=^|[\s"'【（(:：=])~?\/[^\s<>()"':]+?)\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\?[^\s<>()"']*)?`;

export function splitImages(body: string | null | undefined): { text: string; images: string[] } {
  const images: string[] = [];
  let text = (body ?? '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g, (_m, src: string) => {
      images.push(src);
      return '';
    })
    // A bare ref ALONE on its line folds into the image strip; one inside a
    // sentence keeps the prose readable and STILL renders below.
    .replace(new RegExp(`^[ \\t]*(${BARE_IMG})[ \\t]*$`, 'gim'), (_m, src: string) => {
      images.push(src);
      return '';
    });
  for (const m of text.matchAll(new RegExp(BARE_IMG, 'gi'))) images.push(m[0]);
  const seen = new Set<string>();
  const deduped = images.filter((s) => !seen.has(s) && (seen.add(s), true));
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, images: deduped };
}

/** Where a composer attachment lands: a flat temp space under the project's
 * own `.tmm` (owner, 2026-08-26: "上传到项目下…创建临时目录，随机图片 id，
 * 并且转 webp"). The extension is the encoder's verdict — webp where the
 * webview can (Chromium), jpeg where it cannot (WebKit). */
export function uploadImagePath(ws: string, id: string, ext: string): string {
  return `${ws.replace(/\/+$/, '')}/.tmm/uploads/${id}.${ext}`;
}

/** A non-image attachment keeps its own name (an agent told about
 * `report.pdf` should see `report.pdf`), uniqued by the same id and stripped
 * of separators and whitespace — a space would break the bare-ref grammar
 * and read ambiguously when typed into a pane. */
export function uploadFilePath(ws: string, id: string, name: string): string {
  const safe = (name.split(/[\\/]/).pop() || '').trim()
    .replace(/\s+/g, '_')
    .replace(/[<>:"'|?*\x00-\x1f]/g, '')
    .slice(-80) || 'file';
  return `${ws.replace(/\/+$/, '')}/.tmm/uploads/${id}-${safe}`;
}

/** The files a paste carries, or [] when it is a plain text paste (board #25:
 * "chat 输入框，应该支持剪贴板粘贴图片或者文件等"). Files WIN over any text
 * riding the same clipboard: a Finder/Explorer file copy also carries the
 * path as text, and inserting that path next to the staged chip would say
 * the same thing twice — so the caller preventDefaults whenever this is
 * non-empty. Items are read first (a screenshot paste is an items-only
 * clipboard on some engines) and `files` is the fallback, never both — the
 * two views alias the SAME files and reading both would stage duplicates. */
export function pastedFiles(dt: {
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }>;
  files?: ArrayLike<File>;
} | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  if (out.length) return out;
  return Array.from(dt.files ?? []);
}

/** A paste that carries BOTH text and only-image files is, almost always, a
 * rendering of the text: PowerPoint, Word, Excel, Keynote, Numbers and every
 * browser put a PNG of the selection on the clipboard next to the words
 * (owner, 2026-09-08: "从 ppt 上粘贴过来的文字，总是被粘贴为了一个图片"). The
 * words are what the user copied; the picture is a by-product — so the text
 * wins and the default insertion runs. The three pastes where the FILE is the
 * point all fail this test: a screenshot has no text at all; a Finder /
 * Explorer file copy carries only the file's own name or path as text (one
 * token, and it names one of the files); a web page's "Copy image" carries at
 * most the image URL (one URL token). Anything non-image (a pdf beside a
 * caption) is a file paste — no app renders a document as a pdf. */
export function textIsThePaste(text: string | null | undefined, files: readonly { name?: string; type?: string }[]): boolean {
  if (!files.length) return true;
  const t = (text ?? '').trim();
  if (!t) return false;
  if (!files.every((f) => (f.type ?? '').startsWith('image/'))) return false;
  if (/\s/u.test(t)) return true; // words, not a name
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|~\/|[a-z]:\\)/iu.test(t)) return false; // a URL or a path
  const base = t.split(/[\\/]/u).pop() ?? t;
  if (files.some((f) => f.name && (f.name === t || f.name === base))) return false; // the file's own name
  return true;
}

/** Collision-safe enough for a temp dir, sortable by time, no ceremony. */
export function imageId(): string {
  const rand = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8);
  return `${Date.now().toString(36)}-${rand}`;
}

/** True when a reference is already something a webview can load directly; a
 * filesystem path has to be fetched through the file service instead. */
export function isDirectUrl(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/** Agent slots the project DECLARES that have no live window right now — a
 * stopped agent. They belong in the roster (greyed, with a start action)
 * because an agent you stopped has not left the project: its isolated home and
 * its conversation id are still on disk, so starting it again resumes it. */
export function stoppedAgents(
  slots: readonly { window_name: string; kind?: string }[] | undefined,
  live: readonly HubAgent[],
): string[] {
  const running = new Set(live.map((a) => a.name));
  return (slots ?? [])
    .filter((s) => String(s.kind ?? '').toLowerCase() === 'agent' && !running.has(s.window_name))
    .map((s) => s.window_name);
}

/** A colour for a tool NAME, by what the tool does. A wall of grey monospace is
 * hard to read; the same four buckets in the same colours make a run of steps
 * scannable without a legend. Names differ per backend (`fs_read`, `Read`,
 * `execute_bash`, `Bash`, `web_search`…), so match on substrings rather than an
 * exhaustive table — an unknown tool falls back to neutral rather than to a
 * misleading colour. */
export function toolColor(tool: string | null | undefined): string {
  const t = (tool ?? '').toLowerCase();
  if (!t) return 'var(--text3)';
  if (/(write|edit|create|insert|replace|delete|remove|rename|mv|patch|apply)/.test(t)) {
    return 'var(--status-warn)';       // it changes something
  }
  if (/(bash|shell|exec|command|run|terminal|process)/.test(t)) {
    return 'var(--status-ok)';         // it runs something
  }
  if (/(search|grep|find|fetch|web|http|browse|url|query)/.test(t)) {
    return 'var(--accent)';            // it looks something up
  }
  if (/(read|list|stat|cat|view|ls|glob|tree|show)/.test(t)) {
    return 'var(--tool-read, #7aa2f7)'; // it reads something
  }
  return 'var(--text2)';
}

/** How many tool rows a group shows before its body starts scrolling — the
 * DEFAULT for the `hubPrefs.stepsRows` setting (owner, 2026-08-24: "最大显示的
 * 行数应该也变成一个可配置的参数。现在默认把这个参数配置成 5 行"). Five rows
 * show what the agent is doing now and where it has just been; the group's
 * OUTER height stops growing there, which is what keeps a live run from
 * shoving the conversation around. "Expand all" lifts the cap for one group. */
export const STEPS_ROWS = 5;

/** The setting's guard: any stored/typed value becomes a usable cap. Not a
 * free number — 1–2 rows cannot show a run's shape, and past ~30 the cap no
 * longer caps anything a screen can hold. Non-numbers fall to the default. */
export function clampStepsRows(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return STEPS_ROWS;
  return Math.min(30, Math.max(3, n));
}

/** The marker that stands in for what a folded bubble is not showing. Full-width
 * ellipsis: this is a Chinese-first UI and `...` reads as three periods. */
export const ELIDE = '……';

/**
 * Shorten `text` from the TAIL — a plain rear truncation, with the marker
 * glued INLINE to the last kept content, never on a line of its own.
 *
 * Every long USER message renders folded by default (owner, 2026-08-27:
 * "用户如果发送过长消息 直接后截断的形式 最后文末不用换行三个点 中间不要了，
 * 默认用户消息都截断 不要显示太多"), which retired the middle elision the held
 * anchor used (head + …… + tail): the fold is no longer a landmark's reminder
 * of both ends of an ask but the feed's default economy, and a default wants
 * the simplest shape — the start of the message, cut where the budget runs out.
 *
 * Two shapes need cutting:
 *  · MANY LINES → keep the first whole lines (markdown stays parseable),
 *    marker appended to the last one.
 *  · ONE LONG PARAGRAPH → line counting cannot help, so cut characters, on a
 *    word boundary rather than mid-word (CJK has no spaces; a run without one
 *    is cut where asked).
 *
 * `maxLines` is derived by the caller from the height it may occupy and the
 * measured line height, so a big screen shows more lines than a small one.
 * Returns the text unchanged when it already fits — the common case, and the
 * caller relies on identity to skip re-rendering.
 */
/** A folded user message's line budget on a COMPACT screen: a constant.
 * On the phone the old screen-derived budget (20% of the chat column) gave
 * 6–8 lines — too tall for a screen that fits three bubbles (board #4) — and
 * it MOVED: the on-screen keyboard resizes the viewport, so opening it
 * re-cut every folded message mid-read. One line above the 3-line floor:
 * the floor is where "a shorter fold no longer says anything", and a fold
 * must stay distinguishable from it while letting several messages share a
 * phone screen. Constant on purpose — no basis term means neither the
 * keyboard nor the composer can change it. */
export const PHONE_FOLD_LINES = 4;

/** How many whole lines a folded user message may show — the ONE mapping
 * from (compact, chat-column height, bubble line-height) to a budget
 * (board #4, testable without a DOM):
 * - compact: `PHONE_FOLD_LINES`, flat (see above);
 * - desktop: a fifth of the column (the owner's number), floored at 96px so
 *   a tiny window still folds meaningfully, minus the bubble's own padding
 *   and meta line (26px), in whole line boxes — never below the 3-line
 *   floor. The basis is the chat COLUMN, which holds still while the
 *   composer grows; a real window resize re-enters through the reading
 *   anchor. */
export function foldLines(compact: boolean, basis: number, lineHeight: number): number {
  if (compact) return PHONE_FOLD_LINES;
  const maxPx = Math.max(96, Math.round(basis * 0.2));
  const lh = Number.isFinite(lineHeight) && lineHeight > 6 ? lineHeight : 20;
  return Math.max(3, Math.floor((maxPx - 26) / lh));
}

/** Fold a long user message to `maxLines` VISUAL lines (board #53).
 *
 * The first cut budgeted SOURCE lines and only fell back to characters when
 * the line count already fit — so one giant paragraph among the first lines
 * wrapped into pages and the fold held nothing back (owner, 2026-09-01:
 * "应该是按照消息字符长度来，不只是行数，不然一大段就占满了，没起到折叠
 * 作用"). The budget is now spent line by line at each line's RENDERED
 * height: a short line costs one visual line, a wrapping line costs
 * ceil(width / perLine), and the line that exhausts the budget is cut
 * mid-line at the units that remain. CJK is priced at TWO units per
 * character — it renders double width, and counting it at one folded the
 * owner's own messages at twice the promised height. An estimate, like
 * perLine itself: a line off makes the bubble a line taller, nothing is
 * lost, and the unfold control shows the whole message either way. */
export function elideTail(text: string, maxLines: number, perLine = 80): string {
  const cut = cutTail(text, maxLines, perLine);
  return cut === null ? text : closeFences(cut);
}

/** `elideTail`'s cut without its markdown fence repair: `null` when the text
 * fits, else the kept start with `ELIDE` glued on. Plain-text callers (a
 * command's arguments) use this so no ``` is ever added to them. */
function cutTail(text: string, maxLines: number, perLine: number): string | null {
  const t = text ?? '';
  const budget = Math.max(1, Math.floor(maxLines));
  const lines = t.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const rows = Math.max(1, Math.ceil(visualUnits(line) / perLine));
    if (used + rows <= budget) {
      used += rows;
      kept.push(line);
      if (i === lines.length - 1) return null; // everything fits: the caller keeps the text itself
      continue;
    }
    // This line exhausts the budget: keep what the remaining rows can show.
    const remain = (budget - used) * perLine;
    if (remain > 0) kept.push(cutUnits(line, remain));
    break;
  }
  return `${kept.join('\n').trimEnd()}${ELIDE}`;
}

/** Rendered width of a line in perLine units: CJK and other fullwidth
 * codepoints occupy two columns where a latin letter takes one. A width
 * ESTIMATE for a fold budget — not a text-shaping engine. */
function visualUnits(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1;
  return w;
}

/** Cut `s` down to its first `n` visual units, backing up to the nearest
 * space so a latin word is not sliced in half; CJK has no spaces to honor
 * and cuts clean anywhere. */
function cutUnits(s: string, n: number): string {
  let w = 0;
  let end = 0;
  for (const ch of s) {
    const cw = visualUnits(ch);
    if (w + cw > n) break;
    w += cw;
    end += ch.length;
  }
  const slice = s.slice(0, end);
  const at = slice.lastIndexOf(' ');
  return (at > end * 0.7 ? slice.slice(0, at) : slice).trimEnd();
}

/** An elision can drop the closing half of a fenced block, which would swallow
 * the rest of the bubble in a code block. Balance it. */
function closeFences(s: string): string {
  const fences = (s.match(/^```/gmu) ?? []).length;
  return fences % 2 === 0 ? s : `${s}\n\`\`\``;
}

/** Advance the ONE user-message anchor without inventing a second component.
 *
 * The active message is selected while its real bubble is naturally visible:
 * scrolling down chooses the newest visible message and gives that SAME element
 * a top sticky edge; scrolling up chooses the oldest visible one and gives it a
 * bottom edge. It therefore moves with the feed first and only catches when it
 * is about to leave. While a long reply contains no user message, keep the same
 * active element — never switch at an invisible midpoint.
 *
 * `current` is also the seed across direction reversals in an empty gap. If the
 * page opens/jumps directly into a gap, select only the message already passed
 * in that direction. */
export function pickAnchor(
  items: readonly { key: string; top: number; height: number }[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  direction: 'up' | 'down',
  current: { key: string; edge: 'top' | 'bottom' | '' } = { key: '', edge: '' },
): { key: string; edge: 'top' | 'bottom' | '' } {
  const none = { key: '', edge: '' } as const;
  if (scrollHeight <= clientHeight + 1 || !items.length) return none;
  const viewBottom = scrollTop + clientHeight;
  const visible = items.filter((it) => it.top < viewBottom - 1 && it.top + it.height > scrollTop + 1);
  if (visible.length) {
    const picked = direction === 'down' ? visible[visible.length - 1]! : visible[0]!;
    return { key: picked.key, edge: direction === 'down' ? 'top' : 'bottom' };
  }
  // No new bubble entered naturally: the current one keeps holding its edge.
  if (current.key && items.some((it) => it.key === current.key)) return current;
  if (direction === 'down') {
    const passed = items.filter((it) => it.top + it.height <= scrollTop + 1).at(-1);
    return passed ? { key: passed.key, edge: 'top' } : none;
  }
  const ahead = items.find((it) => it.top >= viewBottom - 1);
  return ahead ? { key: ahead.key, edge: 'bottom' } : none;
}

/**
 * A composer line that is a SLASH COMMAND for the agent's CLI rather than a
 * message for its model — `/model`, `/clear`, `/compact`, `/tools`.
 *
 * Those are interpreted by the TUI and only when they are the whole line, so
 * they cannot go through the normal delivery, which prefixes
 * `[tmm chat <time>] human:` — the model would just read them as prose (owner,
 * 2026-08-19). Returns the target (an explicit leading `@name`, else '' for
 * "whoever the composer is addressing") and the command text, or null when this
 * is an ordinary message.
 *
 * A PATH is not a command: the first token must be `/word` with no second
 * slash, so `/tmp/foo` and `/usr/bin/env x` stay messages while `/model
 * claude-opus-5` does not.
 */
export function slashCommand(text: string): { to: string; command: string } | null {
  const body = (text ?? '').trim();
  const addressed = /^@([\w][\w.-]*)\s+([\s\S]+)$/u.exec(body);
  const to = addressed ? addressed[1]! : '';
  const rest = (addressed ? addressed[2]! : body).trim();
  if (!/^\/[A-Za-z][\w-]*(\s|$)/u.test(rest)) return null;
  const first = rest.split(/\s/u)[0] ?? '';
  if (first.slice(1).includes('/')) return null;    // a path, not a command
  return { to, command: rest };
}

/** One slash command of an agent's CLI, for the composer's completion palette.
 *
 * The table is TRANSCRIBED from kiro-cli's own TUI (its command palette carries
 * the same names, descriptions and subcommands), not invented here: a made-up
 * command is worse than no completion, because it looks authoritative in the
 * list and then does nothing in the pane. Cloud-only and hidden entries are
 * left out; `/quit` is last because it ends the agent.
 */
export interface SlashCmd {
  name: string;
  desc: string;
  /** Fixed sub-commands, when the CLI defines them. */
  args?: string[];
  /** Values that have to be fetched — the model ids come from `models_list`. */
  dynamic?: 'models';
  /** The command opens an interactive VIEW in the agent's TUI rather than doing
   * something: kiro marks these `inputType: "panel"` (a list/table that takes
   * over the pane and needs a key to dismiss) or opens $EDITOR / a recorder.
   * Sending one from the chat parks the agent inside a panel nobody here can
   * see, so they are kept in this table — with the reason — and filtered OUT of
   * the palette until there is a way to show them ("有一些命令输入后是交互式查看
   * 的 这种就先去掉吧 以后再想办法支持", owner 2026-08-19). Re-enabling one is
   * deleting a flag. */
  view?: true;
}

export const KIRO_COMMANDS: readonly SlashCmd[] = [
  // ── Act immediately, or act once an argument is chosen.
  { name: 'model', desc: 'List or switch models', args: ['set-current-as-default'], dynamic: 'models' },
  { name: 'compact', desc: 'Compact conversation history to reduce context usage' },
  { name: 'clear', desc: 'Clear the conversation and start a fresh session' },
  { name: 'effort', desc: 'Set the reasoning effort level', args: ['low', 'medium', 'high', 'xhigh', 'max', 'set-current-as-default'] },
  // `create`/`edit` open $EDITOR in the pane, so only `swap` is offered.
  { name: 'agent', desc: 'Switch to a different agent', args: ['swap'] },
  { name: 'chat', desc: 'Save the conversation, load one, or start fresh', args: ['new', 'save', 'load'] },
  { name: 'spec', desc: 'List specs, switch to spec mode, or run spec tasks', args: ['new', 'run', 'view', 'analyze_requirements'] },
  { name: 'plan', desc: 'Switch to plan mode to break ideas into a plan' },
  { name: 'paste', desc: 'Paste image from clipboard' },
  { name: 'quit', desc: 'Exit the agent CLI' },
  // ── Interactive views: kept for the record, filtered out of the palette.
  { name: 'tools', desc: 'List available tools', view: true },
  { name: 'help', desc: 'Show available commands', view: true },
  { name: 'usage', desc: 'Show plan usage and billing information', view: true },
  { name: 'context', desc: 'Show or manage context files', args: ['add', 'remove', 'clear'], view: true },
  { name: 'mcp', desc: 'Show MCP server status', view: true },
  { name: 'hooks', desc: 'View configured hooks', view: true },
  { name: 'code', desc: 'Code intelligence status, init, codebase overview', args: ['status', 'init', 'overview'], view: true },
  { name: 'knowledge', desc: 'Manage knowledge bases', view: true },
  { name: 'tangent', desc: 'Go back, switch to, or create a conversation tangent', args: ['ls', 'root'], view: true },
  { name: 'rewind', desc: 'Fork the session at an earlier turn', view: true },
  { name: 'prompts', desc: 'Select or list available prompts', view: true },
  { name: 'feedback', desc: 'Submit feedback, request features, or report issues', view: true },
  { name: 'upgrade-agent', desc: 'Upgrade V2 agent configs to universal form', view: true },
  { name: 'reply', desc: 'Reply to the last assistant message in $EDITOR', view: true },
  // Re-read on kiro-cli 2.22.1 (2026-09-27, #243): /memories, /goal,
  // /workflow and /voice are gone; these arrived, and all of them park the
  // pane (a scrolling panel, $EDITOR, $PAGER, a dashboard) or switch into a
  // kiro-internal session the room cannot see.
  { name: 'changelog', desc: 'Show recent release notes', view: true },
  { name: 'config', desc: 'View configured agents, MCP servers, powers, steering, skills, hooks', view: true },
  { name: 'sessions', desc: 'Browse sessions (dashboard)', view: true },
  { name: 'settings', desc: 'Configure theme, terminal, keybindings', view: true },
  { name: 'editor', desc: 'Open $EDITOR to compose a prompt', view: true },
  { name: 'transcript', desc: 'Open the transcript in $PAGER', view: true },
  { name: 'spawn', desc: 'Spawn a kiro-internal agent session; the room spawns with tmm spawn', view: true },
];

/** The commands the palette offers: everything that is not an interactive view. */
export const OFFERED_COMMANDS: readonly SlashCmd[] = KIRO_COMMANDS.filter((c) => !c.view);

/** grok 1.0.5 — transcribed from its own docs (`~/.grok/docs/user-guide/
 * 04-slash-commands.md`); re-read against grok 1.0.13's live `/` popup
 * (2026-09-27, #243: /always-approve and /memory are gone). Same contract as KIRO_COMMANDS: a made-up command
 * looks authoritative in the list and then does nothing in the pane. `view`
 * entries open a modal/picker/pane nobody here can see or dismiss and are
 * filtered from the palette; they stay in the table WITH the reason. */
export const GROK_COMMANDS: readonly SlashCmd[] = [
  { name: 'model', desc: 'Switch models (name, then optional effort)', dynamic: 'models' },
  { name: 'effort', desc: 'Set reasoning effort on the current model', args: ['low', 'medium', 'high', 'xhigh'] },
  { name: 'compact', desc: 'Compress history to reclaim context; a note says what to keep' },
  { name: 'new', desc: 'Start a fresh session (alias /clear)' },
  { name: 'plan', desc: 'Enter plan mode, optionally with a description' },
  { name: 'fork', desc: 'Branch the session into a new agent, keeping history' },
  { name: 'remember', desc: 'Save a note to memory immediately' },
  { name: 'btw', desc: 'Send an aside without interrupting the current task' },
  { name: 'goal', desc: 'Set or manage an autonomous goal', args: ['status', 'pause', 'resume', 'clear'] },
  { name: 'deep-research', desc: 'Kick off a background research workflow' },
  { name: 'workflow', desc: 'Launch or manage a saved workflow', args: ['pause', 'resume', 'stop', 'save'] },
  { name: 'loop', desc: 'Run a prompt on a recurring interval' },
  { name: 'imagine', desc: 'Generate an image from a description' },
  { name: 'auto', desc: 'Toggle classifier-approved permission mode' },
  { name: 'quit', desc: 'Quit the application (alias /exit)' },
  // ── Interactive views / pickers / modals: kept for the record, filtered.
  { name: 'resume', desc: 'Open the session picker', view: true },
  { name: 'dashboard', desc: 'Open the live agent dashboard', view: true },
  { name: 'context', desc: 'Show the context-window breakdown', view: true },
  { name: 'session-info', desc: 'Show session details (alias /status)', view: true },
  { name: 'rewind', desc: 'Roll back to an earlier turn (alias /undo)', view: true },
  { name: 'hooks', desc: 'Extensions modal, Hooks tab', view: true },
  { name: 'plugins', desc: 'Extensions modal, Plugins tab', view: true },
  { name: 'skills', desc: 'Extensions modal, Skills tab', view: true },
  { name: 'mcps', desc: 'MCP servers management modal', view: true },
  { name: 'theme', desc: 'Switch the color theme (picker)', view: true },
  { name: 'feedback', desc: 'Bare form opens a report pane', view: true },
  { name: 'settings', desc: 'Configuration UI', view: true },
  { name: 'usage', desc: 'Account usage view', view: true },
  { name: 'delete', desc: 'Deletes the session — destructive, never offered', view: true },
  // Never offered: it swaps Enter and Shift+Enter, and every delivery
  // (tmux::send_command) submits with Enter.
  { name: 'multiline', desc: 'Swaps Enter/Shift+Enter — would stop every typed delivery', view: true },
  { name: 'minimal', desc: 'Switches to scrollback-native rendering the vitals sniffer does not read', view: true },
];

/** codex-cli 0.148.0 — transcribed live from its own `/` popup (2026-08-22).
 * `/model` and friends are PICKERS in codex (they park the TUI at a selection
 * UI), so unlike kiro's they are views here. Re-read on codex-cli 0.154.0
 * (2026-09-27, #243): /agent became /agents; /pwd acts (verified). */
export const CODEX_COMMANDS: readonly SlashCmd[] = [
  { name: 'new', desc: 'Start a new chat during a conversation' },
  { name: 'clear', desc: 'Clear the terminal and start a new chat' },
  { name: 'compact', desc: 'Summarize conversation to prevent hitting the context limit' },
  { name: 'init', desc: 'Create an AGENTS.md file with instructions for Codex' },
  { name: 'plan', desc: 'Switch to Plan mode' },
  { name: 'goal', desc: 'Set or view the goal for a long-running task', args: ['edit', 'pause', 'resume', 'clear'] },
  { name: 'fork', desc: 'Fork the current chat' },
  { name: 'diff', desc: 'Show git diff (including untracked files)' },
  { name: 'status', desc: 'Show current session configuration and token usage' },
  { name: 'pwd', desc: 'Show the current working directory' },
  { name: 'mcp', desc: 'List configured MCP tools' },
  { name: 'ps', desc: 'List background terminals' },
  { name: 'stop', desc: 'Stop all background terminals' },
  { name: 'approve', desc: 'Approve one retry of a recent auto-review denial' },
  { name: 'archive', desc: 'Archive this session and exit' },
  { name: 'exit', desc: 'Exit Codex' },
  // ── Pickers and views: kept for the record, filtered from the palette.
  { name: 'model', desc: 'Model picker — a view in codex, not an inline arg', view: true },
  { name: 'permissions', desc: 'Approval-mode picker', view: true },
  { name: 'review', desc: 'Review-preset picker', view: true },
  { name: 'resume', desc: 'Saved-chat picker', view: true },
  { name: 'agents', desc: 'Agent-session switcher', view: true },
  { name: 'mention', desc: 'File picker', view: true },
  { name: 'skills', desc: 'Skills toggle view', view: true },
  { name: 'memories', desc: 'Memory settings view', view: true },
  { name: 'hooks', desc: 'Lifecycle hooks view', view: true },
  { name: 'keymap', desc: 'Shortcut remapping view', view: true },
  { name: 'feedback', desc: 'Send logs to maintainers (report view)', view: true },
  { name: 'personality', desc: 'Communication-style picker', view: true },
  { name: 'delete', desc: 'Permanently deletes the session — destructive, never offered', view: true },
  // Never offered: composer Vim mode eats typed text as keystrokes, and the
  // status line is the footer the vitals sniffer reads.
  { name: 'vim', desc: 'Composer Vim mode — typed delivery would become keystrokes', view: true },
  { name: 'statusline', desc: 'Status-line picker', view: true },
];

/** Claude Code 2.1.283 — transcribed live from its own `/` popup
 * (2026-09-27, #243; its bundled skills, which also list under `/`, are
 * left out). Offered entries were each typed through `hub_command` into a
 * real pane and acted inline: `/model <alias>` switches without the picker
 * (default / opus / sonnet / haiku), `/effort <level>` sets it, `/plan`
 * turns plan mode on. Bare `/model` and `/effort` open pickers. */
export const CLAUDE_COMMANDS: readonly SlashCmd[] = [
  { name: 'compact', desc: 'Free up context by summarizing the conversation so far' },
  { name: 'clear', desc: 'Start a new session with empty context (the old one stays resumable)' },
  { name: 'model', desc: 'Set the model (an alias; bare /model opens a picker)', args: ['default', 'opus', 'sonnet', 'haiku'] },
  { name: 'effort', desc: 'Set the effort level', args: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { name: 'plan', desc: 'Enable plan mode' },
  { name: 'rename', desc: 'Rename the current conversation' },
  { name: 'exit', desc: 'Exit the CLI' },
  // ── Pickers, panels and dialogs: kept for the record, filtered.
  { name: 'config', desc: 'Settings', view: true },
  { name: 'context', desc: 'Context-usage grid', view: true },
  { name: 'help', desc: 'Help and commands', view: true },
  { name: 'mcp', desc: 'MCP server manager', view: true },
  { name: 'memory', desc: 'Edit CLAUDE.md files', view: true },
  { name: 'permissions', desc: 'Tool permission rules', view: true },
  { name: 'resume', desc: 'Conversation picker', view: true },
  { name: 'rewind', desc: 'Restore code or conversation to an earlier point', view: true },
  { name: 'status', desc: 'Status dialog', view: true },
  { name: 'usage', desc: 'Cost and plan usage dialog', view: true },
  { name: 'hooks', desc: 'Hook configurations', view: true },
  { name: 'skills', desc: 'Skills list', view: true },
  { name: 'tasks', desc: 'Background tasks', view: true },
  { name: 'login', desc: 'Sign-in flow', view: true },
  { name: 'statusline', desc: 'Status-line setup — the footer the vitals sniffer reads', view: true },
];

/** omp 18.2.10 — transcribed live from its own `/` popup (2026-09-27,
 * #243). Offered entries were typed through `hub_command` into a real
 * pane: /plan toggles plan mode, /new starts a session, /compact and
 * /context and /usage answer inline. /model and /session are modals. */
export const OMP_COMMANDS: readonly SlashCmd[] = [
  { name: 'compact', desc: 'Compact the context' },
  { name: 'new', desc: 'Start a new session' },
  { name: 'clear', desc: 'Drop context, keep the session' },
  { name: 'plan', desc: 'Toggle plan mode' },
  { name: 'retry', desc: 'Retry the last failed agent turn' },
  { name: 'context', desc: 'Show context usage' },
  { name: 'usage', desc: 'Show provider usage and limits' },
  { name: 'exit', desc: 'Exit the application' },
  // ── Modals, pickers and dashboards: kept for the record, filtered.
  { name: 'model', desc: 'Model picker (roles modal)', view: true },
  { name: 'session', desc: 'Session info modal', view: true },
  { name: 'settings', desc: 'Settings menu', view: true },
  { name: 'setup', desc: 'Provider setup wizard', view: true },
  { name: 'resume', desc: 'Session picker', view: true },
  { name: 'tree', desc: 'Session tree navigator', view: true },
  { name: 'git', desc: 'Git UI', view: true },
  { name: 'hotkeys', desc: 'Keyboard shortcuts', view: true },
  { name: 'restart', desc: 'Restarts omp outside the launch recipe', view: true },
  { name: 'delete', desc: 'Deletes the session — destructive, never offered', view: true },
];

/** Kimi Code 2.0.2 — transcribed live from its own `/` popup (2026-09-27,
 * #243). Offered entries were typed through `hub_command` into a real
 * pane and answered inline. /model opens a picker even with an alias, and
 * /effort's levels depend on the model (Kimi K3 on Bedrock accepts only
 * "on"), so both are views here. */
export const KIMI_COMMANDS: readonly SlashCmd[] = [
  { name: 'compact', desc: 'Compact the conversation context' },
  { name: 'new', desc: 'Start a fresh session in this workspace' },
  { name: 'plan', desc: 'Toggle plan mode' },
  { name: 'goal', desc: 'Manage the autonomous goal', args: ['status', 'pause', 'resume', 'cancel'] },
  { name: 'title', desc: 'Set or show the session title' },
  { name: 'status', desc: 'Session and runtime status' },
  { name: 'usage', desc: 'Session tokens, context window and quotas' },
  { name: 'version', desc: 'Version information' },
  { name: 'exit', desc: 'Exit the application' },
  // ── Pickers and panels: kept for the record, filtered.
  { name: 'model', desc: 'Model picker, even with an alias', view: true },
  { name: 'effort', desc: 'Effort picker; the levels depend on the model', view: true },
  { name: 'permission', desc: 'Permission-mode picker', view: true },
  { name: 'sessions', desc: 'Session browser', view: true },
  { name: 'settings', desc: 'TUI settings', view: true },
  { name: 'help', desc: 'Commands and shortcuts', view: true },
  { name: 'login', desc: 'Provider sign-in', view: true },
  { name: 'undo', desc: 'Withdraws the last prompt from the transcript — not offered', view: true },
];

/** DeepSeek Harness 0.2.0-rc.2 (board #411, owner 2026-10-17). dsh-headless has
 * NO slash commands of its own (`dsh-commands` serves its UI clients), so these
 * are the APP's: `hub_command` does not type them, it changes the agent's
 * definition (or its session) and the NEXT turn — a fresh process that reads
 * the profile — is the changed one, with no restart. Transcribed from the
 * backend's own file (`backends/dsh.rs`): the effort levels are the
 * deepseek-official route's (`off | low | high | max`), the model ids are the
 * two its catalog lists (advisory: any id is accepted, "the model id passes
 * through to the wire"). `/compact` is not offered because dsh cannot run it
 * between headless turns (see `dsh.rs`), and none is faked. */
export const DSH_COMMANDS: readonly SlashCmd[] = [
  { name: 'model', desc: 'Set the model for the next turn (any model id)', args: ['deepseek-flash', 'deepseek-v4-pro'] },
  { name: 'effort', desc: 'Set the reasoning effort for the next turn', args: ['off', 'low', 'high', 'max'] },
  { name: 'new', desc: 'Start a new conversation with the next line' },
];

/** The palette's table for a recipient's backend. kiro is the default dialect
 * (and the empty string is "backend unknown", which historically meant kiro).
 * Every backend has its own transcribed table since #243 (2026-09-27); a
 * mixed @all roster or an unknown backend still gets none, because offering
 * one CLI's table to another shows commands that do not exist there
 * (owner, 2026-08-22 对齐). */
export function offeredCommands(backend?: string | null): readonly SlashCmd[] {
  switch (backend ?? '') {
    case 'grok': return GROK_COMMANDS.filter((c) => !c.view);
    case 'codex': return CODEX_COMMANDS.filter((c) => !c.view);
    // kiro is the default dialect; the empty string is "backend unknown",
    // which historically meant kiro and keeps the old behavior.
    case 'kiro': case '': return OFFERED_COMMANDS;
    case 'claude': return CLAUDE_COMMANDS.filter((c) => !c.view);
    case 'omp': return OMP_COMMANDS.filter((c) => !c.view);
    case 'kimi': return KIMI_COMMANDS.filter((c) => !c.view);
    case 'dsh': return DSH_COMMANDS;
    // A mixed @all roster, anything else: no palette beats a wrong one.
    default: return [];
  }
}

export interface PaletteItem {
  value: string;
  hint: string;
  /** Accepting this item opens a list of its own: a command whose
   * DECLARATION takes arguments (fixed `args`, or `dynamic` values that are
   * fetched). Read from the table, never from what is cached (board #398
   * review P1-A: a grok `/model` before its models loaded read as "no next
   * level", closed its list, blocked the fetch and was sent bare). */
  opens?: true;
}
export interface Palette {
  /** 'command' completes `/mo` → `/model`; 'arg' completes what follows it;
   * 'mention' completes `@bo` → `@bob`; 'issue' completes `#33` → `#336`. */
  stage: 'command' | 'arg' | 'mention' | 'issue';
  items: PaletteItem[];
  /** Replace `text.slice(from)` with the chosen value. */
  from: number;
  /** True when the accepted value takes a separating space (a command, a
   * mention, an issue). */
  more: boolean;
}

/** The text accepting `item` leaves: the token replaced, plus the separating
 * space when the palette asks for one. The composer's accept writes exactly
 * this. */
export function acceptedText(palette: Palette, text: string, item: PaletteItem): string {
  return `${text.slice(0, palette.from)}${item.value}${palette.more ? ' ' : ''}`;
}

/**
 * Whether accepting `item` changes the text (board #398). Owner: after Tab
 * completed `/model claude-opus-5.5`, the list still offered that same item,
 * Enter accepted it, the text came out identical and nothing was sent. The
 * orchestrator's rule: Enter accepts only a change, otherwise it sends as if
 * the list were closed. A change is a different token (a longer completion,
 * another case), or an item that opens a list of its own (`opens`: a typed
 * `/model` gains its space and its argument list, whether or not the list is
 * loaded yet). An item already typed whose acceptance adds only the
 * separating space (a no-argument command, a mention, an issue) or nothing
 * at all (a final argument) changes nothing.
 */
export function acceptChanges(palette: Palette, text: string, item: PaletteItem): boolean {
  return text.slice(palette.from) !== item.value || !!item.opens;
}

/** The list worth showing (board #398): none when its only item would
 * change nothing, so a finished `@bob`, `#340`, `/compact` or final argument
 * closes it and Enter sends. One rule for every source, which replaced the
 * mention and issue sources' own "the query is the one candidate" checks. */
export function offeredPalette(palette: Palette | null, text: string): Palette | null {
  if (!palette) return null;
  return palette.items.length === 1 && !acceptChanges(palette, text, palette.items[0]!) ? null : palette;
}

/**
 * How well a candidate matches what was typed: `0` prefix, `1` substring,
 * `2` subsequence, `-1` no match. The palette must not demand the first
 * characters ("不一定从第一个字符开始匹配，可以模糊匹配", owner 2026-08-24) —
 * the discriminating part of a model id like `claude-sonnet-4.5` never comes
 * first — but a looser match must never outrank a tighter one: Enter accepts
 * the TOP item, so `/co` has to keep meaning `/compact`, not whatever else
 * happens to contain a c and an o. Case-insensitive; the empty query matches
 * everything as a prefix.
 */
export function fuzzyRank(query: string, candidate: string): number {
  const q = (query ?? '').toLowerCase();
  if (!q) return 0;
  const c = (candidate ?? '').toLowerCase();
  if (c.startsWith(q)) return 0;
  if (c.includes(q)) return 1;
  let i = 0;
  for (const ch of c) {
    if (ch === q[i] && ++i === q.length) return 2;
  }
  return -1;
}

/** Filter + order by fuzzyRank, keeping the table's own order within a tier
 * (sort is stable): the table order is the CLI's own, and it is what makes the
 * list predictable when several candidates tie. A candidate that IS the
 * query comes before every other, the way the `#` list puts an exact number
 * first (board #398): with `claude-opus-5.5` listed before `claude-opus-5`, a
 * typed `claude-opus-5` was a prefix of both, the longer one led, and Enter
 * replaced what was typed with it. The same spelling leads a different case
 * of it (review P2-B: `Bob` and `bob` are two names, and delivery tells them
 * apart, so a typed `@bob` must not become `@Bob` because it was listed
 * first); with no same spelling, an equal-but-for-case one still leads. */
function fuzzyPick<T>(query: string, all: readonly T[], key: (t: T) => string): T[] {
  const lower = (query ?? '').toLowerCase();
  const rank = (k: string, tier: number) => (!query ? tier : k === query ? -2 : k.toLowerCase() === lower ? -1 : tier);
  return all
    .map((t) => ({ t, r: fuzzyRank(query, key(t)) }))
    .filter((x) => x.r >= 0)
    .map((x) => ({ ...x, r: rank(key(x.t), x.r) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t);
}

/** The slash-command line the command palette reads: after an optional
 * leading `@name `, a line that starts with `/`. `at` is where it starts. */
function commandLine(text: string): { at: number; line: string } | null {
  const at = /^(\s*@[\w][\w.-]*\s+)?/u.exec(text ?? '')?.[0]?.length ?? 0;
  const line = (text ?? '').slice(at);
  return line.startsWith('/') ? { at, line } : null;
}

/** Whether the composer should fetch `backend`'s values (the model ids) for
 * `text`: it is a slash-command line, and the backend's table DECLARES a
 * command whose values are fetched. Read from the text and the table only,
 * never from the list on screen (board #398 review P1-A): the argument list
 * of a typed `/model ` needs the models, so a fetch that waited for a list
 * to show could wait forever. */
export function wantsFetchedArgs(text: string, backend?: string | null): boolean {
  return !!commandLine(text) && offeredCommands(backend).some((c) => c.dynamic === 'models');
}

/**
 * What to offer for the composer's current text — the two-stage completion the
 * owner asked for: "比如我打/ 就会出现compact之类的让我选，还有model 如果支持两个
 * 参数的，可以多次选择".
 *
 * Only a line that IS a slash command gets a palette (an optional leading
 * `@name ` is allowed, since that is how you aim one), and only its LAST token is
 * completed. Returns null when there is nothing to offer, which is also how the
 * caller knows to stay out of the way.
 */
export function commandPalette(text: string, models: readonly string[] = [], backend?: string | null): Palette | null {
  const table = offeredCommands(backend);
  if (!table.length) return null;
  const found = commandLine(text);
  if (!found) return null;
  const { at, line } = found;
  const parts = line.split(/(\s+)/u);          // keeps the separators
  const head = parts[0]!.slice(1);              // the command, without the slash
  // Still typing the command itself: `/`, `/mo`, `/mdl` with no space yet.
  if (parts.length === 1) {
    const items = fuzzyPick(head, table, (c) => c.name).map((c) => ({
      value: `/${c.name}`,
      hint: c.desc,
      ...(c.args?.length || c.dynamic ? { opens: true as const } : {}),
    }));
    return items.length ? { stage: 'command', items, from: at, more: true } : null;
  }
  const cmd = table.find((c) => c.name === head.toLowerCase());
  if (!cmd) return null;
  const values = [...(cmd.dynamic === 'models' ? models : []), ...(cmd.args ?? [])];
  if (!values.length) return null;
  // Completing the argument: everything after the last whitespace run.
  const lastGap = line.search(/\s+\S*$/u);
  const typed = lastGap >= 0 ? line.slice(lastGap).trimStart() : '';
  const from = at + line.length - typed.length;
  // Only the FIRST argument is completable — these commands take one, and what
  // follows it (a path, a prompt, a free-text name) is not ours to guess. So a
  // filled argument ends the palette instead of re-offering the same list.
  const tokens = line.split(/\s+/u).filter(Boolean);
  if (tokens.length > 2 || (tokens.length === 2 && typed === '')) return null;
  const items = fuzzyPick(typed, values, (v) => v)
    .map((v) => ({ value: v, hint: cmd.dynamic === 'models' && !cmd.args?.includes(v) ? 'model' : 'option' }));
  return items.length ? { stage: 'arg', items, from, more: false } : null;
}

/**
 * The `@` completion (board #242, owner 2026-09-27: "输入“@”，可以提示我 @ 某
 * 一个 Agent 的候选项"). It rides the slash palette: same `Palette` shape, same
 * popover, same keys. Only the LAST token of the text is completed, and only
 * when it is an `@` at the start or after whitespace: an `@` inside a word
 * (an email address) does not open it. The query is the run `mentionTokens` would read (no second
 * `@`, no whitespace). `candidates` are the names `deliver_mentions` delivers
 * to: the room's managed agents plus `all`, with the caller's hint text.
 * A query that already IS the one remaining candidate is closed by the
 * composer (`offeredPalette`, board #398), so Enter after a finished `@bob`
 * sends instead of completing it again.
 * A slash-command line offers no names: send() types it verbatim through
 * `hub_command`, so an `@bob` inside it would reach nobody (validator, #242).
 * `slashCommand` is the same test send() uses.
 */
export function mentionPalette(text: string, candidates: readonly PaletteItem[]): Palette | null {
  if (slashCommand(text ?? '')) return null;
  const m = /(^|\s)@([\w.-]*)$/u.exec(text ?? '');
  if (!m || !candidates.length) return null;
  const query = m[2]!;
  const items = fuzzyPick(query, candidates, (c) => c.value).map((c) => ({ value: `@${c.value}`, hint: c.hint }));
  if (!items.length) return null;
  // `more`: the accepted mention takes its separating space, like a command.
  return { stage: 'mention', items, from: (text ?? '').length - query.length - 1, more: true };
}

/** A board issue as the `#` palette offers it (board #340): its number, the
 * name every surface gives it (`board.ts` `issueRef`: title, else a body
 * excerpt) and whether it is still open (not `done`). */
export interface IssueCandidate { id: number; ref: string; open: boolean }

/** The `#` query being typed: the last token, when it is a `#` at the start
 * or after whitespace, read like a mention (letters, digits, `_`, `-`; a `#`
 * inside a word, a URL fragment or `##` is not one). Null when there is
 * none, and on a slash-command line, which the command palette owns and
 * send() types verbatim. One reading for the palette and the composer's
 * "a `#` is being typed" (which refreshes the list). */
export function issueQuery(text: string | null | undefined): string | null {
  if (slashCommand(text ?? '')) return null;
  return /(^|\s)#([\p{L}\p{N}_-]*)$/u.exec(text ?? '')?.[2] ?? null;
}

/**
 * The `#` completion (board #340, owner: "增加一个（#）的规则吧 井号可以去引用我
 * board 的信息"). It rides the `/` and `@` palette: the same `Palette`, the same
 * popover and keys. The candidates are this project's issues, matched on the
 * number AND the name (`fuzzyRank`); an exact number comes first, then the
 * better match, open before done, newest first. Accepting inserts `#<id>`
 * and a space, nothing else: the delivered text is what was typed, and an
 * agent reads the issue with `tmm board show <id>`. A query that already IS
 * the one remaining candidate is closed by the composer (`offeredPalette`,
 * board #398), so Enter sends.
 */
export function issuePalette(text: string, issues: readonly IssueCandidate[]): Palette | null {
  const query = issueQuery(text);
  if (query === null || !issues.length) return null;
  const exact = /^\d+$/u.test(query) ? Number(query) : -1;
  const rank = (i: IssueCandidate) => {
    if (i.id === exact) return -1;
    const r = [fuzzyRank(query, String(i.id)), fuzzyRank(query, i.ref)].filter((x) => x >= 0);
    return r.length ? Math.min(...r) : Infinity;
  };
  const items = issues
    .map((i) => ({ i, r: rank(i) }))
    .filter((x) => x.r !== Infinity)
    .sort((a, b) => a.r - b.r || Number(b.i.open) - Number(a.i.open) || b.i.id - a.i.id)
    .map(({ i }) => ({ value: `#${i.id}`, hint: i.ref }));
  if (!items.length) return null;
  return { stage: 'issue', items, from: text.length - query.length - 1, more: true };
}

/** Every `#<number>` a message names (board #340), in the one place a `#`
 * counts: at the start or after a character that is not part of a word, an
 * HTML entity (`&#39;`) or a path (`/#12`), and not followed by more of a
 * word (`#12a`). The feed links these and Hub reads the board when one is
 * newer than what it knows. Offsets are UTF-16 units of `text`. */
export function issueSpans(text: string): { at: number; id: number; end: number }[] {
  const out: { at: number; id: number; end: number }[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_&#/])#(\d+)(?![\p{L}\p{N}_])/gu)) {
    out.push({ at: m.index!, id: Number(m[1]), end: m.index! + m[0].length });
  }
  return out;
}

/** Map each text run of rendered HTML that lies OUTSIDE `code`, `pre` and
 * `a` (a code sample or a link's text is not an address or a reference);
 * tags pass through. Each run is read on its own, since the tag before it
 * stood for markdown punctuation. */
function mapTextRuns(html: string, fn: (text: string) => string): string {
  let skip = 0;
  return html.split(/(<[^>]*>)/u).map((part) => {
    const tag = /^<(\/?)(code|pre|a)\b/iu.exec(part);
    if (tag) { skip = Math.max(0, skip + (tag[1] ? -1 : 1)); return part; }
    if (part.startsWith('<') || skip) return part;
    return fn(part);
  }).join('');
}

/** Link every `#<id>` of a rendered message that names an issue of THIS
 * project (board #340): a `.issue-ref` link carrying its number, which the
 * feed opens on the Board. A number the project has no issue for stays text. */
export function markIssueRefs(html: string, ids: ReadonlySet<number>): string {
  if (!ids.size) return html;
  return mapTextRuns(html, (part) => {
    if (!part.includes('#')) return part;
    let out = '', from = 0;
    for (const { at, id, end } of issueSpans(part)) {
      if (!ids.has(id)) continue;
      out += `${part.slice(from, at)}<a class="issue-ref" href="#" data-issue="${id}">#${id}</a>`;
      from = end;
    }
    return out + part.slice(from);
  });
}

export type FeedLevel = 'chat' | 'status' | 'tools';

/** Lifecycle lines the server posts into the room (a spawn, a `tmm done`) are
 * events, not prose, and render as a centered system line rather than a chat
 * bubble. The marker is `[tmm] `; the two glyph prefixes are the pre-2026-08
 * spelling and stay recognized because the room is persisted — old messages
 * must not regress into bubbles. Returns the text without its marker, or null
 * when the body is ordinary prose. */
/** Wrap every VALID `@address` in a rendered message in the span the bubble
 * sets apart (`.m-to`). Owner, 2026-09-29 (#273): "一个消息里如果有 @ 多个角色
 * 这些有效的 @ 都应该被高亮起来；如果是无效的 就不要高亮了" — the server types a
 * body into every agent it names ANYWHERE in it (`deliver_mentions`), so the
 * old "only the leading one is an address" premise (455efceb) is gone. The
 * addresses are `mentionSpans`'s, the one tokenizer; valid = a managed agent
 * in `names`, `all` or `human`, so a removed agent, a typo or an email stays
 * plain. Works on the rendered HTML: only text outside `code`, `pre` and `a`
 * is read (a code sample or a link's text is not an address), and each text
 * run is read on its own, since the tag before it stood for markdown
 * punctuation the server read as a word break. */
export function markMentions(html: string, names: readonly string[]): string {
  const valid = (n: string) => n === 'all' || n === 'human' || names.includes(n);
  return mapTextRuns(html, (part) => {
    if (!part.includes('@')) return part;
    let out = '', from = 0;
    for (const { at, name } of mentionSpans(part)) {
      if (!valid(name)) continue;
      const end = at + 1 + name.length;
      out += `${part.slice(from, at)}<span class="m-to" style="--who-ink: ${agentHue(name)}">${part.slice(at, end)}</span>`;
      from = end;
    }
    return out + part.slice(from);
  });
}

/** The spawn kick's echo: `[YYYY-MM-DD HH:MM] (session start)`. Also matches
 * the pre-2026-08-18 instruction kick, because rooms are persisted. */
export function isSessionStart(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return /^\[[^\]]+\]\s*\(session start\)$/.test(t) || /^\[[^\]]+\]\s*Start now:/.test(t);
}

/** The card hover's wake row (board #275): the soonest pending wake for
 * this agent as local `HH:MM` (with the date when not today), who set it,
 * and `+N` for the others waiting behind it. Pure. */
export function wakeLine(wake: { due_at: number; from: string; more: number }, now = new Date()): string {
  return [localWhen(wake.due_at, now), wake.from].join(' · ') + (wake.more > 0 ? ` +${wake.more}` : '');
}

/** An absolute moment (unix SECONDS) as local `HH:MM`, with the date
 * `YYYY-MM-DD HH:MM` when it is not today — the one absolute form a hover
 * card gives (wake rows #275, board cards #284). Pure. */
export function localWhen(sec: number, now = new Date()): string {
  const at = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** A LIST row's absolute moment (unix SECONDS), tiered so the column stays
 * one stable width and never both the full date and the time (board #356,
 * owner 2026-10-13: a `2026-10-11 10:57` beside a long sender collapsed the
 * project name to "tm…"): today → `HH:MM`; this year → `MM-DD HH:MM`; older →
 * `YYYY-MM-DD`. The hover card keeps `localWhen`'s full form. Pure. */
export function listWhen(sec: number, now = new Date()): string {
  const at = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === now.toDateString()) return time;
  const md = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return at.getFullYear() === now.getFullYear() ? `${md} ${time}` : `${at.getFullYear()}-${md}`;
}

/** The card menu's queue ⇄ steer item for one agent (board #271), or null
 * when there is none to offer: the server must report the mode the session
 * RUNS (`input_mode`, derived from the pane) and the backend must switch it
 * live (`toggles`, from `backends_list`). The item names the OTHER mode,
 * with no hint line (owner, #272: "后边的小字不要了吧，看着不好看"). */
export function inputModeSwitch(
  agent: { agent?: string | null; input_mode?: 'queue' | 'steer' | null } | null | undefined,
  toggles: (backend: string | null | undefined) => boolean,
): { next: 'queue' | 'steer'; label: 'hubToQueue' | 'hubToSteer' } | null {
  if (!agent?.input_mode || !toggles(agent.agent)) return null;
  return agent.input_mode === 'steer'
    ? { next: 'queue', label: 'hubToQueue' }
    : { next: 'steer', label: 'hubToSteer' };
}

/** A slash command the person sent (`hub_command` records `[tmm] /goal args →
 * kiro, dev`) as the parts of an OUTGOING bubble (board #264, owner
 * 2026-09-28: "不如直接还是气泡"): the recipients it was typed into, the
 * command name, its arguments. `null` for any other line — lifecycle lines
 * stay capsules. The room keeps storing the same line, so old rooms render
 * their commands as bubbles too. */
export interface SentCommand { to: string[]; name: string; args: string }
export function sentCommand(body: string | null | undefined): SentCommand | null {
  const line = systemLine(body);
  if (line === null) return null;
  const p = sysParts(line);
  if (!p.cmd) return null;
  const to = p.who ? p.who.split(',').map((n) => n.trim()).filter(Boolean) : [];
  return { to, name: p.verb, args: p.text };
}

/** The ARGUMENTS a folded command bubble shows, or `null` when they fit
 * (owner, 2026-09-28 16:35: "消息怎么好像没有折叠，一个气泡就把我的手机屏幕占满
 * 了"). Only the arguments fold, through the SAME budget and tail cut as a
 * long user message (`cutTail`, `elideTail`'s cut); the recipients and the
 * name are never counted against it or cut (orchestrator 16:50), so an
 * argument-less command never folds and never offers an Expand that would
 * change nothing (validator 16:49: eight long recipients + `/compact`). The
 * arguments are plain text, so `elideTail`'s fence repair is skipped: a
 * command never gains a visible ```. */
export function foldedCommandArgs(cmd: SentCommand, maxLines: number, perLine = 80): string | null {
  return cmd.args ? cutTail(cmd.args, maxLines, perLine) : null;
}

export function systemLine(body: string | null | undefined): string | null {
  for (const marker of ['[tmm] ', '⚡ ', '✔ ']) {
    if (body?.startsWith(marker)) return body.slice(marker.length);
  }
  return null;
}

/** The lifecycle verbs the server narrates (`hub_rpc.rs`). A line that does not
 * start with one of them is left whole — an unknown shape must render as its own
 * text, never as a guessed verb plus a truncated remainder. */
const SYS_VERBS = new Set(['spawned', 'forked', 'started', 'stopped', 'restarted', 'kept', 'moved', 'left', 'removed', 'interrupted', 'switched', 'assigned', 'unassigned', 'offline', 'done']);

/**
 * ONE structure for every line the app narrates: WHO it is about, WHAT
 * happened, and the DETAIL — `{ who, verb, text }` (owner, 2026-08-24: "slash
 * 命令，以及 agent 的 remove 等状态更新，都用统一的 ui 来展示…包括 agent 的名字，
 * 状态，或者发送的指令").
 *
 * - `removed k`               → who `k`,   verb `removed`
 * - `spawned dev — fix bug`   → who `dev`, verb `spawned`, text `fix bug`
 * - `forked dev-2 from dev` → who `dev-2`, verb `forked`, text `from dev` (#383: a fork is a
 *   start, so it speaks the same grammar and wears the same colour as `spawned`)
 * - `done`                    → verb `done` (nobody named)
 * - `/model x → dev, rev`     → who `dev, rev`, verb `/model`, text `x`, cmd
 *
 * The command splits at the LAST ` → ` because that is the one `hub_command`
 * appended (`[tmm] {text} → {targets}`) — the typed text may contain an arrow,
 * the slug-joined target list cannot. An unknown shape keeps only `text`: the
 * whole line renders as itself, because a guessed verb or name would truncate
 * the rest.
 */
export function sysParts(item: string | null | undefined): { verb: string; who: string; text: string; cmd: boolean } {
  const line = (item ?? '').trim();
  if (line.startsWith('/')) {
    const cut = line.lastIndexOf(' → ');
    const typed = cut < 0 ? line : line.slice(0, cut);
    const who = cut < 0 ? '' : line.slice(cut + 3).trim();
    const gap = typed.search(/\s/u);
    return {
      verb: gap < 0 ? typed : typed.slice(0, gap),
      who,
      text: gap < 0 ? '' : typed.slice(gap).trim(),
      cmd: true,
    };
  }
  const gap = line.search(/\s/u);
  const head = (gap < 0 ? line : line.slice(0, gap)).toLowerCase();
  if (!SYS_VERBS.has(head)) return { verb: '', who: '', text: line, cmd: false };
  const rest = gap < 0 ? '' : line.slice(gap).trim();
  // The subject is one token (spawned window names are registry slugs); what
  // follows the em-dash is the spawn brief.
  const wgap = rest.search(/\s/u);
  const who = wgap < 0 ? rest : rest.slice(0, wgap);
  const text = wgap < 0 ? '' : rest.slice(wgap).replace(/^\s*—\s*/u, '').trim();
  return { verb: head, who, text, cmd: false };
}

/**
 * A board status-change line: `board #12 todo → doing — 标题` (the body
 * `hub_board_save` posts, marker already stripped by `systemLine`). Parsed so
 * the feed can render it in the sys grammar's own atoms — the issue number as
 * the WHO, the destination status as the coloured badge, the title as the
 * detail — instead of one grey unparsed line (board #13). The FROM survives
 * because the transition is the message: `done → todo` is a REOPEN, and that
 * must read differently from a first take. An unmatched shape returns null and
 * the line renders whole, exactly like every other unknown sys shape.
 */
export function boardLine(item: string | null | undefined): { id: string; from: string; to: string; title: string } | null {
  const m = /^board #(\d+) ([a-z]+) → ([a-z]+)(?: — ([\s\S]*))?$/u.exec((item ?? '').trim());
  if (!m) return null;
  return { id: m[1]!, from: m[2]!, to: m[3]!, title: (m[4] ?? '').trim() };
}

/**
 * The colour of the DESTINATION status in a board line's badge — the one
 * progressive status language again (`noteStateColor` / `stateDotColor` /
 * `sysVerbColor`): accent = started moving (doing), amber = needs a person
 * (review waits for its acceptor), green = ended well (done), grey = at rest
 * (todo — including a reopen landing back there). An unknown word takes
 * ordinary reading ink, never an invented meaning. The Board SIDEBAR's count
 * chips are the one sanctioned departure (Board.svelte `countColor`, owner
 * 2026-09-01): there the four columns wear four CATEGORICAL colours
 * (红橙黄紫), because next to the row's green LIVE dot this language's green
 * lied and its two greys blurred; everywhere else the board dialect is
 * exactly this function.
 */
export function boardStatusColor(to: string): string {
  switch (to) {
    case 'doing': return 'var(--accent)';
    case 'review': return 'var(--status-warn)';
    case 'done': return 'var(--status-ok)';
    case 'todo': return 'var(--text3)';
    default: return 'var(--text2)';
  }
}

/** The tag a board delivery marker may carry after the id — the THREE
 * notices hub_rpc.rs types into a pane: `[board #N]` (a change to an issue
 * you hold), `[board #N review]` (a handoff to the reporter),
 * `[board #N reply]` (a note on an issue you reported or hold,
 * `board_note_notice`). A new server shape is added HERE, or it renders as
 * raw log text (board #172). */
export type BoardPromptTag = 'review' | 'reply';

/**
 * A delivered prompt, read for display (owner, 2026-08-30: "在 chat 对话视图
 * 上展示得不是很好"): the machine stamp (`[tmm chat <ts>] <who>: `) comes off
 * — the row's head shows the SENDER instead — and a `[board #N]` /
 * `[board #N review]` / `[board #N reply]` marker becomes a structured chip
 * (+ tag) so board deliveries wear the board dialect instead of raw log text.
 * Anything else passes through whole: an unrecognised shape must render as
 * itself — which is how the reply notice surfaced (board #172, owner
 * 2026-09-11 "有消息没有渲染": the third shape rendered as its raw marker).
 */
export function promptParts(text: string | null | undefined): { from: string; board: { id: string; tag: BoardPromptTag | null } | null; text: string } {
  const line = (text ?? '').trim();
  const m = /^\[tmm chat [^\]]*\] (\S+): ([\s\S]*)$/u.exec(line);
  const from = m ? m[1]!.replace(/:$/u, '') : '';
  const rest = m ? m[2]! : line;
  const b = /^\[board #(\d+)(?: (review|reply))?\]\s*([\s\S]*)$/u.exec(rest);
  if (b) return { from, board: { id: b[1]!, tag: (b[2] as BoardPromptTag | undefined) ?? null }, text: b[3]!.trim() };
  return { from, board: null, text: rest };
}

/**
 * The colour of a lifecycle verb's badge — the SAME progressive language as
 * `noteStateColor` / `stateDotColor`, so one vocabulary covers every coloured
 * state word in the Hub: accent = something started moving, green = ended well,
 * grey = at rest, red = destructive (the token the Close/Remove buttons already
 * wear). An unknown verb takes ordinary reading ink rather than a colour we
 * would be inventing a meaning for.
 */
export function sysVerbColor(verb: string): string {
  switch (verb) {
    case 'spawned':
    case 'forked':
    case 'started':
    case 'restarted':
    // A queue/steer switch (#271) changes how the agent takes input: accent,
    // like a start — never a status of its own.
    case 'switched':
    // A board hand-off (#367) starts work moving, like a spawn; handing the
    // issue back to nobody leaves it at rest, like a stop.
    case 'assigned':
    // A runtime move into a team (#384) starts something, like a spawn; a
    // leave puts the agent back at rest, like a kept joiner.
    case 'moved': return 'var(--accent)';
    case 'left':
    case 'unassigned': return 'var(--text3)';
    // A team restart that left a joined agent as it was (#382): nothing
    // happened to it, so it is at rest.
    case 'kept': return 'var(--text3)';
    case 'done': return 'var(--status-ok)';
    // A message that reached nobody needs a person to notice (#347): the
    // amber the language already keeps for "paused on a human", not red —
    // nothing broke, somebody is simply not there.
    case 'offline':
    case 'interrupted': return 'var(--status-warn)';
    case 'removed': return 'var(--status-danger)';
    case 'stopped': return 'var(--text3)';
    default: return 'var(--text2)';
  }
}

/**
 * A note posted by an agent about its own work: `[tmm status working] compiling
 * the server`, or `[tmm done] shipped the palette`.
 *
 * `tmm status` used to be a telemetry event, which meant it vanished on restart
 * while the messages around it survived. It is now a MESSAGE from the agent
 * ("status要用agent发送消息的形式显示", 2026-08-19), so it is persisted like any
 * other and it reads as the agent speaking — because it is. This is the reader:
 * the marker comes off, the declared state comes out, and the note is rendered as
 * an ordinary bubble that happens to be dimmer.
 *
 * The marker is NOT `[tmm] ` on purpose: that prefix means "the app is narrating",
 * folds into a grey sys row, and is dropped entirely at the chat-only level — so
 * the text disappeared exactly where a reader looks. That is the treatment both of
 * these were moved OUT of (owner, 2026-08-19, twice: "status要用agent发送消息的形
 * 式显示" and "返回的状态信息要用消息的形式展示在对话里").
 *
 * A `done` with no summary never becomes a message: there is nothing to read.
 */
export function statusNote(body: string | null | undefined): { state: string; text: string } | null {
  const m = /^\[tmm (?:status ([a-z]+)|(done))\]\s*([\s\S]*)$/u.exec(body ?? '');
  if (!m) return null;
  const text = m[3]!.trim();
  return text ? { state: m[1] ?? m[2]!, text } : null;
}

/**
 * The colour of a status-note's declared state, worn by the badge in the
 * bubble header. SAME language as `stateDotColor` (see the table there):
 * accent = in motion, green = done well, amber = needs a person, red =
 * failed, grey = a word we do not know (quiet, never wrong). The only case
 * this reader adds is `done`, which is a note-only state — a roster dot never
 * shows it because a finished agent goes back to idle. Here `failed` is a
 * word the AGENT chose for itself, which is a report and not a derivation,
 * so it keeps the red the derived dot gave up in board #354. `stuck` was
 * dropped from both readers with that issue: nothing has produced it since
 * the Team-supervisor era, and an unknown word is grey by this rule anyway.
 */
export function noteStateColor(state: string): string {
  switch (state) {
    case 'working':
    case 'running': return 'var(--accent)';
    case 'waiting':
    case 'blocked': return 'var(--status-warn)';
    case 'failed': return 'var(--status-danger)';
    case 'done': return 'var(--status-ok)';
    default: return 'var(--text3)';
  }
}

/**
 * Same calendar day in LOCAL time — the rule behind the feed's date
 * separators. UTC arithmetic would flip the divider at 08:00 for a UTC+8
 * reader, which is exactly the reader who asked for it ("我希望在有新日期的
 * 地方能有一个标注", owner 2026-08-20).
 */
/** How far apart two bubbles of one sender may be and still read as one
 * run (board #331). */
export const RUN_GAP_MS = 5 * 60_000;

/** Whether feed block `b` CONTINUES the run of the block before it (board
 * #331, owner 2026-10-09: "如果一个 Agent 连续发了好几条消息，那么这个 Agent 的
 * 名字只写一次就行了…消息气泡依次列出"): both are agent messages from the same
 * sender, adjacent in the feed (any other block between them — a sys line, a
 * prompt, a note, a progress line — ends the run), on the same day and at
 * most RUN_GAP_MS apart. A message that carries its own header meaning
 * starts a new run: a status note (its header wears the state badge) and a
 * reply addressed to the human (it is the one the reader is looking for).
 * The human's own bubbles have no header, so they never form runs. */
export function continuesRun(prev: FeedBlock | undefined, b: FeedBlock): boolean {
  if (!prev || prev.type !== 'msg' || b.type !== 'msg') return false;
  const from = b.msg?.from ?? '';
  if (!from || from === 'human' || prev.msg?.from !== from) return false;
  if (b.ts - prev.ts > RUN_GAP_MS || b.ts < prev.ts || !sameDay(prev.ts, b.ts)) return false;
  if (statusNote(b.msg?.body) || (Array.isArray(b.msg?.to) && b.msg.to.includes('human'))) return false;
  return true;
}

export function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/** A draft is a convenience, not a document: capped so a pasted file cannot fill
 * localStorage and take the rest of the Hub's prefs down with it. */
export const DRAFT_MAX = 8000;

/**
 * The next draft map after typing in a project's composer. Pure so the two rules
 * that would regress silently are testable: an EMPTY draft removes its key (else
 * every project ever visited leaves a row behind), and the text is capped.
 *
 * Returns the SAME object when nothing changes, which is the caller's signal to
 * skip the write — this runs on every keystroke.
 */
export function draftUpdate(
  map: Record<string, string>,
  session: string,
  text: string,
): Record<string, string> {
  if (!session) return map;
  const keep = (text ?? '').slice(0, DRAFT_MAX);
  if (keep === (map[session] ?? '')) {
    // A stored empty string is junk — we never write one — so clean it up if an
    // older build or a hand-edited value left one behind. Everything else is a
    // genuine no-op, which is the common case on a keystroke.
    if (map[session] === '') {
      const cleaned = { ...map };
      delete cleaned[session];
      return cleaned;
    }
    return map;
  }
  const next = { ...map };
  if (keep) next[session] = keep;
  else delete next[session];
  return next;
}

/** One row of the conversation. `msg` and `prompt` are things that were said,
 * `note` is a single observed fact, `steps` is a collapsible run of tool calls
 * (the "what it did between two replies" pane). */
export type FeedBlock =
  /** `steps`: the tool-call group this reply closed for its OWN window
   *  (board #295) — rendered inside the reply's card, folded by default. */
  | { type: 'msg'; ts: number; msg: any; delivered: boolean; command?: SentCommand; steered?: boolean; steps?: Extract<FeedBlock, { type: 'steps' }> }
  | { type: 'sys'; ts: number; key: string; items: string[]; /** each item's message id, parallel to items (board #322's jump anchor) */ ids?: string[] }
  | { type: 'prompt'; ts: number; window: string; text: string }
  | { type: 'progress'; ts: number; window: string; state: string; text: string }
  | { type: 'note'; ts: number; window: string; event: HubActivityEvent }
  | { type: 'steps'; ts: number; window: string; key: string; events: HubActivityEvent[] };

/** The two halves of a `tmm status` event: what the agent DECLARED and the note
 * it wrote. Older servers glued them into one string (`"working — 重写状态机"`)
 * and sent no `state`; rooms and rings outlive a build, so both shapes parse. */
export function statusParts(e: HubActivityEvent): { state: string; text: string } {
  if (e.state) return { state: e.state, text: e.text === e.state ? '' : e.text };
  const m = /^(working|waiting|blocked)(?:\s+—\s+([\s\S]*))?$/.exec(e.text.trim());
  return m ? { state: m[1]!, text: m[2] ?? '' } : { state: '', text: e.text };
}

/** Internal: a tool call before consecutive ones are folded into a group. */
type ToolItem = { type: 'tool'; ts: number; window: string; event: HubActivityEvent };

/** ONE truth per agent dot (board #8): the sidebar's project rows colour
 * their chips from the `hub_rooms` snapshot (all projects, 20s poll) while
 * the roster reads `hub_agents` (selected project, 5s poll) — same server
 * derivation, different ages, so the two UIs disagreed for up to a poll
 * cycle. This overlays the SELECTED project's roster states onto the
 * snapshot map, so whichever response lands LAST, the freshest source wins
 * for the project on screen and the cheap snapshot keeps speaking for the
 * rest:
 * - called with the roster after a `hub_agents` poll, it refreshes that
 *   project's keys in place;
 * - called with the roster over a fresh `hub_rooms` response, it stops the
 *   (older-cadence) snapshot from rolling the selected project's dots back;
 * - only MANAGED agents with a non-empty state write keys (a shell window
 *   has no state to assert), and a stopped agent's snapshot key passes
 *   through untouched — absence is the sidebar's own "idle" default, never
 *   invented here. Pure; returns a new map. */
export function mergeStates(
  snapshot: Record<string, string>,
  session: string,
  agents: readonly { name: string; state?: string; managed?: boolean }[],
): Record<string, string> {
  const out: Record<string, string> = { ...snapshot };
  for (const a of agents) {
    if (!a.managed || !a.state) continue;
    // Keyed by the window NAME — the agent's identity (board #120).
    out[`${session}:${a.name}`] = a.state;
  }
  return out;
}

/** Does this body ADDRESS the agent — an `@name` (or `@all`) token, parsed
 * exactly the way the server's `deliver_mentions` does (token after `@` up to
 * whitespace, trailing punctuation trimmed, exact name equality)? Used by the
 * roster's double-click filter: "发给它的用户消息" means addressed, and a
 * substring match would collect `@builder-2` for `builder` (board #3). */
export function mentionsAgent(body: string, name: string): boolean {
  return mentionTokens(body).some((token) => token === name || token === 'all');
}

/** The `@` tokens of a body, exactly as the server reads them
 * (`address::mention_names`, board #248 — the same case table pins both
 * sides). The `@` must start a word: at the start, or after anything but an
 * email/host character (ASCII letter or digit, `_ . -`), so `a@bob` and
 * `me@bob.dev` name nobody while `(@bob)` and `请@bob` do. The address is the
 * run of name characters (`address::name_char`: Alphabetic or numeric code
 * points of any script, `-`, `_`) after it; a run followed by `.`+name character or another `@` is a host, not a
 * name. ONE tokenizer for every client-side reading of an address — the
 * filter, the room-note verdict and the composer chip cannot disagree about
 * what `@bob:` means. */
export function mentionTokens(body: string): string[] {
  return mentionSpans(body).map((s) => s.name);
}

/** `mentionTokens` with where each address starts (the index of its `@`, in
 * UTF-16 units), for a reader that marks them in place (`markMentions`). */
export function mentionSpans(body: string): { at: number; name: string }[] {
  // Code points, not UTF-16 units, and Rust's own classes (validator, #248):
  // `char::is_alphanumeric` is `\p{Alphabetic}` or `\p{N}` — wider than
  // `\p{L}` (a Devanagari vowel sign is Alphabetic, not a Letter) — and a
  // non-BMP letter after a `.` is two units a fixed-width slice would split.
  const inWord = /[A-Za-z0-9_.-]/u;
  const nameRun = /^[\p{Alphabetic}\p{N}_-]*/u;
  const hostTail = /^(?:@|\.[\p{Alphabetic}\p{N}_-])/u;
  const out: { at: number; name: string }[] = [];
  for (let i = body.indexOf('@'); i >= 0; i = body.indexOf('@', i + 1)) {
    const before = [...body.slice(0, i)].pop();
    if (before && inWord.test(before)) continue;
    const rest = body.slice(i + 1);
    const run = nameRun.exec(rest)![0];
    if (run && !hostTail.test(rest.slice(run.length))) out.push({ at: i, name: run });
  }
  return out;
}

/** Which of `names` this body is TYPED INTO — the server's `deliver_mentions`
 * verdict, read client-side: `@name` reaches that managed agent, `@all`
 * reaches every one of them, and a token that names nobody on the roster
 * (an email address, a removed agent, a direct window) reaches nobody.
 * Roster order, no duplicates. An empty answer is a ROOM NOTE: recorded for
 * the agents' next `tmm log`, typed into no pane — so the feed must not hang
 * a "waiting for its turn to end" ring on it (review, 2026-09-03), and the
 * composer chip can say `+@bob` when the body reaches past the recipient. */
export function mentionedAgents(body: string, names: readonly string[]): string[] {
  const tokens = new Set(mentionTokens(body));
  if (tokens.has('all')) return [...names];
  return names.filter((n) => tokens.has(n));
}

/** What the recipient chip appends when the BODY reaches past the chosen
 * recipient (review, 2026-09-03: the chip said `to: alice` while `@bob` in
 * the body was delivered too, with no hint). `'all'` as the recipient already
 * means everyone, so nothing is appended; an `@all` in the body collapses to
 * the one token `all` rather than listing the roster; otherwise the managed
 * agents the body addresses, minus the recipient, in roster order. Rendered
 * as `+@name` after the chip's name. */
export function chipExtras(body: string, recipient: string, names: readonly string[]): string[] {
  if (recipient === 'all') return [];
  if (mentionTokens(body).includes('all') && names.length) return ['all'];
  return mentionedAgents(body, names).filter((n) => n !== recipient);
}

/** A reply's quote token (board #290): the server writes it
 * (`address::quote_token`) from the row it quotes, right after the body's
 * leading addresses — `@builder [re <sender> <HH:MM>: 「<first line>」] text`.
 * Inside the excerpt `@` is the full-width `＠` and `」` is `”`, so no mention
 * parser reads an address in it and the first `」]` always ends it. `text` is
 * the body without the token (its addresses kept); `null` when there is no
 * token there. Pure; its case table lives in address.rs. */
export function parseQuote(body: string | null | undefined): { from: string; time: string; excerpt: string; text: string } | null {
  const b = body ?? '';
  const m = /^((?:@\S+\s+)*)\[re (\S+) ((?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2}): 「([^\n]*?)」\] ?/u.exec(b);
  if (!m) return null;
  return { from: m[2]!, time: m[3]!, excerpt: m[4]!, text: m[1]! + b.slice(m[0].length) };
}

/** The preview a reply chip shows before the server builds the token: the
 * quoted body's first non-empty line, squashed. Display only. Pure. */
export function quotePreview(body: string | null | undefined): string {
  return (body ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.replace(/\s+/gu, ' ') ?? '';
}

/** The human's identity in a room (the server's `address::HUMAN`). */
export const HUMAN = 'human';

/** The feed narrowed to ONE agent (board #3: 双击卡片 "筛选跟某个agent有关的
 * 消息"). "Related" is defined here, once, and tested:
 * - a message FROM the agent (its replies, its `[tmm status]`/`[tmm done]`
 *   bubbles), or ANY message ADDRESSED to it (`@name` / `@all` — from the
 *   human or a teammate);
 * - telemetry blocks (prompt / progress / note / steps) of ITS window and no
 *   other — two agents working concurrently must not leak into each other's
 *   filter (`window` undefined keeps none: no window, no telemetry);
 * - sys capsules keep only the lifecycle LINES that name the agent as a whole
 *   word (`spawned builder-2` must not surface for `builder`), and disappear
 *   when none do.
 * `name` = HUMAN is "Only mine" (board #289, owner 2026-09-30: "过滤所有
 * to human 的消息"): the human's own messages, a message whose recorded `to`
 * names the human (an agent's final reply to a turn the human asked in, or
 * an `@human` send), and a body that says `@human`. `@all` is every AGENT, so
 * it does not count; the human has no window, so no telemetry block does.
 * Rows recorded before #289 carry no `to` for a reply and are not matched.
 * Pure so the rules are testable without a DOM. */
export function filterBlocks(blocks: FeedBlock[], name: string, window?: string): FeedBlock[] {
  const word = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'u');
  const out: FeedBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'msg') {
      const from = b.msg?.from ?? '';
      const body = b.msg?.body ?? '';
      const addressed = name === HUMAN
        ? (Array.isArray(b.msg?.to) && b.msg.to.includes(HUMAN)) || mentionTokens(body).includes(HUMAN)
        : mentionsAgent(body, name);
      if (from === name || addressed) out.push(b);
      continue;
    }
    if (b.type === 'sys') {
      const keep = b.items.map((line) => word.test(line));
      const items = b.items.filter((_, i) => keep[i]);
      if (items.length) out.push({ ...b, items, ids: b.ids?.filter((_, i) => keep[i]) });
      continue;
    }
    // prompt / progress / note / steps — all carry the window they belong to.
    if (window != null && b.window === window) out.push(b);
  }
  return out;
}

/** ALL whitespace removed — the delivery-echo match runs on this form (the
 * server's `strip_ws` twin; a test pins the two to the same behavior via the
 * same cases). Squashing to ONE space was not enough: tmux in extended-keys
 * mode dropped the raw \n byte outright, so the echo came back with the lines
 * GLUED and "a b" could never contain "ab" (owner, 2026-08-24). */
export function squashWs(s: string): string {
  return s.replace(/\s+/gu, '');
}

/** squashWs, once per OBJECT. feedBlocks pairs every app-echo with every
 * message (P × M) and recomputed the regex per pair on every poll — with paged
 * history that is 10⁵–10⁶ passes a tick (review C, 2026-09-03). Messages and
 * events are stable objects across polls (`mergeMessages`/`mergeEvents` keep
 * the existing ones), so a WeakMap keyed by the object caches the squash for
 * its lifetime and costs nothing when the object goes. A body edit would
 * produce a new object (the room is a log), so staleness cannot happen. */
const squashed = new WeakMap<object, string>();
function squashOf(obj: object | null | undefined, text: string | null | undefined): string {
  if (!obj) return squashWs(text ?? '');
  let v = squashed.get(obj);
  if (v === undefined) {
    v = squashWs(text ?? '');
    squashed.set(obj, v);
  }
  return v;
}

/** Internal: a turn boundary that produces NO row — a delivery echo. The echo
 * is consumed as a receipt (rule 1) so it never renders, but it is still the
 * moment `userPromptSubmit` opened a new turn, and a new turn must not pour its
 * tool calls into the previous turn's group. */
type TurnMark = { type: 'turn'; ts: number; window: string };

/** `tmm` subcommands whose EFFECT is already a row in this timeline: the
 * message, the status change, the completion, the spawn notice. Showing the
 * tool call that produced them would print the same event twice — once as the
 * thing the agent said, once as the mechanics of saying it. `tmm log` is
 * filtered for the same reason inverted: polling the room produces nothing to
 * see. Everything else (`tmm task`, `project`, `agent`, `skill`…) has no other
 * trace in the chat, so it stays visible. */
const TMM_SELF_REPORT = new Set(['send', 'status', 'done', 'log', 'spawn']);

/** Normalize a tool event across server generations. An older server had no
 * `tool` field and spelled the event as one string, `"shell tmm send …"` — the
 * tool name glued onto the front of the text. Measured live (2026-08-18): that
 * shape is what made every tool name grey (the coloured column only renders
 * when `tool` is set) AND what defeated the self-report filter (the first
 * token was `shell`, not `tmm`). Split the known lead-in words back out;
 * events that already carry `tool` pass through untouched. */
const LEGACY_TOOL_PREFIX = /^(shell|bash|exec)\s+(\S[\s\S]*)$/;
export function toolEventParts(e: HubActivityEvent): { tool: string; text: string } {
  if (e.tool) return { tool: e.tool, text: e.text };
  const m = LEGACY_TOOL_PREFIX.exec(e.text.trim());
  return m ? { tool: m[1]!, text: m[2]! } : { tool: '', text: e.text };
}

/** True when this tool call is the agent reporting through `tmm` — the call
 * whose own output is already shown as a message or a note. Agents chain the
 * report onto one shell line (`tmm send "…" 2>&1; tmm status working "…"`), so
 * the whole command is a self-report only if EVERY chained segment is one —
 * `tmm send "done" && make deploy` still has something to show. */
export function isSelfReport(e: HubActivityEvent): boolean {
  if (e.kind !== 'tool') return false;
  const { text } = toolEventParts(e);
  const segments = text.split(/(?:&&|\|\||;)+/);
  let sawTmm = false;
  for (const seg of segments) {
    const parts = seg.trim().split(/\s+/);
    if (!parts[0]) continue;                        // empty tail after a ';'
    const cmd = parts[0].split('/').pop() ?? '';
    if (cmd !== 'tmm' || !TMM_SELF_REPORT.has(parts[1] ?? '')) return false;
    sawTmm = true;
  }
  return sawTmm;
}


/** The server stores a prompt echo truncated to this many characters plus a
 * `…` (telemetry.rs `MAX_PROMPT_CHARS`); the delivery MATCH there ran on the
 * full prompt, so a long message is confirmed server-side while its stored
 * echo can never contain its whole body. Board #78 (owner, 2026-09-03: a
 * 1041-character paste "没有成功被确认已读" — the ring stayed hollow although
 * the hook had acked it). */
export const PROMPT_ECHO_MAX = 1024;
export function echoTruncated(rawEcho: string): boolean {
  return rawEcho.endsWith('…') && [...rawEcho].length > PROMPT_ECHO_MAX;
}
/** Whitespace-blind containment, truncation-aware: a truncated echo confirms a
 * body when the body STARTS inside the echo and everything the echo still has
 * after that point is a prefix of the body — the characters still have to
 * match in order, so a different long message cannot be acked by accident.
 * The lead-in probe is short (24 chars) so a body that begins right before the
 * cut still finds its start. */
export function echoContains(canonEcho: string, body: string, truncated: boolean): boolean {
  if (canonEcho.includes(body)) return true;
  if (!truncated) return false;
  const echo = canonEcho.endsWith('…') ? canonEcho.slice(0, -1) : canonEcho;
  const probe = body.slice(0, 24);
  let idx = echo.indexOf(probe);
  while (idx >= 0) {
    const rest = echo.slice(idx);
    if (rest.length < body.length && body.startsWith(rest)) return true;
    idx = echo.indexOf(probe, idx + 1);
  }
  return false;
}

/**
 * Build the conversation from chat messages plus observed telemetry.
 *
 * Three rules carry the design:
 *
 * 1. **A delivery receipt is not telemetry.** `deliver_mentions` types a line
 *    into an agent's pane; the agent's `userPromptSubmit` hook echoing that line
 *    back is the only proof it was accepted as a prompt. Such an echo arrives as
 *    a `prompt` event with `via: 'app'`, and it is consumed here to mark the
 *    message that caused it as delivered rather than shown as a separate row —
 *    the text would otherwise appear twice. This runs at EVERY feed level,
 *    because "did what I just sent arrive" is not a detail the user opted into.
 *    Since board #249 the echo also NAMES the delivery rows it settled
 *    (`deliveries`): their messages are marked by id, and the echo is
 *    consumed even when none of them is in the loaded page — it is a receipt,
 *    never keyboard input. A `warn` names the one row it reported; once an
 *    echo settles that row the warn is dropped, by row id, never by text. An
 *    echo without `deliveries` (a row before v24) keeps the content match.
 * 2. **A local prompt is the input half of the transcript.** Text typed at the
 *    agent's own keyboard exists in no other channel, so an unmatched `prompt`
 *    event renders as its own row.
 * 2b. **A `tmm status` note is a spoken line.** Hooks see that a turn is open,
 *    never what it is about; the note is the only account of the work in
 *    progress, so it renders at every level and never breaks a tool lane (the
 *    agent wrote it in the middle of the run it describes).
 * 3. **Tool calls collapse per AGENT, replies do not.** A window's tool events
 *    fold into one `steps` group that stays open for that window's whole turn.
 *    Only that SAME window ends its own run — its reply, its local prompt, the
 *    echo of a line delivered to it, a note about it. Another agent's rows are a
 *    different lane and must not break it: with two agents working, a rule that
 *    folded only CONSECUTIVE events produced one group per call
 *    (w1, w2, w1, w2 …) and the feed read as churn (owner report, 2026-08-19).
 *    Duplicate consecutive tool lines are dropped per window first (pre+post
 *    fire for one call).
 *    When the run is ended by THAT window's own reply, the group moves INTO
 *    the reply (`msg.steps`, board #295, owner 2026-10-01: "工具调用的折叠框和
 *    最近的那条消息回复合并到一起"): one card, the steps folded by default
 *    because the answer is there. A run ended any other way — a prompt, a
 *    note, a turn edge, another lane's reply, or a reply we cannot attribute —
 *    or still open stays its own block.
 *
 * `windowOf` maps a message's sender to its window, which is how a reply is
 * attributed to the lane it ends. Without it a reply cannot be attributed, so
 * it conservatively ends every open run — the pre-aggregation behavior.
 */
export function feedBlocks(
  feed: any[],
  activity: readonly HubActivityEvent[],
  level: FeedLevel,
  windowOf?: (from: string) => string | undefined,
  /** A message id a jump must reach (board #322): a lifecycle line the
   * chat-only level would drop is kept for that one message. The stored
   * level is never changed. */
  reveal = '',
): FeedBlock[] {
  // Lifecycle lines ("[tmm] spawned dev") are the app's record, not the
  // conversation: at the chat-only level they disappear, and elsewhere they
  // become 'sys' rows so CONSECUTIVE ones fold into one line — a stop
  // followed by a restart is one fact, not two rows (owner report).
  const msgs: Extract<FeedBlock, { type: 'msg' | 'sys' }>[] = feed.flatMap((m): Extract<FeedBlock, { type: 'msg' | 'sys' }>[] => {
    const sys = systemLine(m.body);
    if (sys === null) {
      return [{ type: 'msg' as const, ts: m.ts ?? 0, msg: m, delivered: false }];
    }
    // A command the person sent is THEIR message (board #264): the same
    // outgoing bubble at every detail level, addressed like a chat line. Its
    // `body` is what they typed, `@to /name args`, so copy/raw and the
    // echo match read the command itself rather than the room's marker.
    const command = sentCommand(m.body);
    if (command) {
      const typed = command.args ? `${command.name} ${command.args}` : command.name;
      const body = [...command.to.map((n) => `@${n}`), typed].join(' ');
      return [{ type: 'msg' as const, ts: m.ts ?? 0, msg: { ...m, body }, delivered: false, command }];
    }
    if (level === 'chat' && !(reveal && String(m.id ?? '') === reveal)) return [];
    return [{ type: 'sys' as const, ts: m.ts ?? 0, key: `sys${m.id ?? m.ts}`, items: [sys], ids: [String(m.id ?? '')] }];
  });

  // Rule 1: pair echoes with the messages that produced them.
  const consumed = new Set<HubActivityEvent>();
  const turns: TurnMark[] = [];
  const settledRows = new Set<number>();
  for (const e of activity) {
    if (e.kind === 'prompt' && e.via === 'app') for (const d of e.deliveries ?? []) settledRows.add(d.id);
  }
  for (const e of activity) {
    // A line typed into a busy steer-mode turn (board #276) will never echo:
    // the server owes it nothing and names its message here, so the bubble
    // promises no check. The event itself is never drawn.
    if (e.kind === 'steered') {
      const named = new Set((e.deliveries ?? []).map((d) => d.msg).filter(Boolean));
      for (const m of msgs) if (m.type === 'msg' && named.has(m.msg?.id)) m.steered = true;
      consumed.add(e);
      continue;
    }
    // A warn about a row a later echo settled is retracted: the line was late,
    // not lost.
    if (e.kind === 'warn' && e.deliveries?.some((d) => settledRows.has(d.id))) {
      consumed.add(e);
      continue;
    }
    if (e.kind !== 'prompt' || e.via !== 'app') continue;
    // EVERY message at or before the echo whose body it contains. The typed line
    // is `[tmm chat] <from>: <body>`, an agent that was mid-typing submits it with
    // its own leftover text attached — and a busy agent can submit SEVERAL queued
    // lines in one prompt, in which case each of them was delivered. Marking only
    // the newest left the earlier ones hollow for ever.
    // Whitespace-canonical, same rule as the server's record_prompt: the line
    // rides tmux send-keys and the TUI's composer before it echoes back, and a
    // newline in the body does not survive that byte-for-byte (owner,
    // 2026-08-22: multi-line messages never confirmed).
    // Named receipts first: the server knows exactly which rows it settled,
    // and which messages they carry.
    const named = e.deliveries?.length ? new Set(e.deliveries.map((d) => d.msg).filter(Boolean)) : null;
    let hit = !!named;
    if (named) {
      for (const m of msgs) {
        if (m.type === 'msg' && named.has(m.msg?.id)) m.delivered = true;
      }
    }
    const canonEcho = squashOf(e, e.text);
    const truncated = echoTruncated(e.text);
    for (const m of msgs) {
      if (m.type !== 'msg' || m.delivered) continue;
      const body = squashOf(m.msg, m.msg?.body);
      if (body && m.ts <= e.ts && echoContains(canonEcho, body, truncated)) {
        m.delivered = true;
        hit = true;
      }
    }
    if (hit) {
      consumed.add(e);
      // Invisible, but still a turn boundary (rule 3).
      turns.push({ type: 'turn', ts: e.ts, window: e.window });
    }
  }

  const stream: (FeedBlock | ToolItem | TurnMark)[] = [...msgs, ...turns];
  const lastTool = new Map<string, string>();
  for (const e of activity) {
    if (consumed.has(e)) continue;
    // A line that never came back is about the message, not about telemetry:
    // it survives even the chat-only level.
    if (e.kind === 'warn') {
      stream.push({ type: 'note', ts: e.ts, window: e.window, event: e });
      continue;
    }
    // A `tmm status` NOTE is the agent saying what it is doing — the one thing
    // hooks cannot observe. It is deliberate, it is prose, and it is the answer
    // to "what is happening right now", so it renders as a spoken line at every
    // detail level. A note-less claim is dropped: the derived state already says
    // running/idle better than a word the agent typed.
    if (e.kind === 'status') {
      const { state, text } = statusParts(e);
      if (text.trim()) stream.push({ type: 'progress', ts: e.ts, window: e.window, state, text: text.trim() });
      continue;
    }
    if (level === 'chat') continue;
    if (e.kind === 'tool') {
      if (level !== 'tools') continue;
      // The agent's own `tmm send/status/done` is already a row of its own.
      if (isSelfReport(e)) continue;
      // Dedup on the whole call, not the argument: two different tools acting
      // on one file are two facts, and pre+post of one call are one.
      const sig = `${e.tool ?? ''}\u0000${e.text}`;
      if (lastTool.get(e.window) === sig) continue;
      lastTool.set(e.window, sig);
      stream.push({ type: 'tool', ts: e.ts, window: e.window, event: e });
      continue;
    }
    if (e.kind === 'prompt') {
      // The spawn kick is machinery, not conversation: it is a marker
      // (`[time] (session start)`) that only exists because a CLI does
      // nothing until spoken to. Showing it made the app look like it had
      // typed instructions at the agent in the operator's name.
      if (isSessionStart(e.text)) continue;
      stream.push({ type: 'prompt', ts: e.ts, window: e.window, text: e.text });
      continue;
    }
    // A finished turn is not news: the agent's reply is right there as a
    // message, and its chip goes idle. A row saying "finished a turn" after
    // every answer was just noise in the transcript (owner call, 2026-08-16).
    // The other lifecycle events all mean something is WAITING on a human.
    if (e.kind === 'notif' && e.text === 'completed') continue;
    // An interrupt's end row is a turn edge for the server's restart
    // recovery (board #249); the room already says `[tmm] interrupted`, so
    // it draws nothing here either.
    if (e.kind === 'notif' && e.text === 'interrupted') continue;
    stream.push({ type: 'note', ts: e.ts, window: e.window, event: e });
  }
  // Chronological, and when two things share a timestamp the OBSERVATION comes
  // first: a reply is what ends a turn, so the tool calls of that turn happened
  // before it. Ties are not hypothetical — the server stamps a hook event when
  // it consumes the file, so a turn's last tool call and its auto-posted reply
  // can land in the same millisecond. A turn boundary sorts ahead of everything
  // at its timestamp, because it OPENS what follows.
  const rank = (i: FeedBlock | ToolItem | TurnMark) => (i.type === 'turn' ? -1 : i.type === 'msg' ? 1 : 0);
  stream.sort((a, b) => a.ts - b.ts || rank(a) - rank(b));

  // Rule 3: one group per window per turn — see the doc comment. `open` holds
  // the group each window is still adding to; a row from that window closes it,
  // a row from any other window is a different lane and is ignored.
  const out: FeedBlock[] = [];
  const open = new Map<string, Extract<FeedBlock, { type: 'steps' }>>();
  for (const item of stream) {
    if (item.type === 'tool') {
      const group = open.get(item.window);
      if (group) {
        group.events.push(item.event);
        continue;
      }
      const created: Extract<FeedBlock, { type: 'steps' }> = {
        type: 'steps',
        ts: item.ts,
        window: item.window,
        key: `w${item.window}-${item.ts}`,
        events: [item.event],
      };
      open.set(item.window, created);
      out.push(created);
      continue;
    }
    if (item.type === 'turn') {
      open.delete(item.window);
      continue;                      // a receipt renders as a mark on its message
    }
    if (item.type === 'msg') {
      // Which lane does this reply end? Its sender's, when we can tell; every
      // lane when we cannot (no map = no attribution, so stay conservative).
      const from = item.msg?.from ?? '';
      const w = from ? windowOf?.(from) : undefined;
      if (!windowOf) open.clear();
      else if (w !== undefined) {
        // Its own lane's run becomes part of this reply's card (#295). The
        // human never has a lane, so only an agent's reply can carry one.
        const run = open.get(w);
        open.delete(w);
        if (run && from !== HUMAN) {
          out.splice(out.indexOf(run), 1);
          item.steps = run;
        }
      }
      out.push(item);
      continue;
    }
    if (item.type === 'prompt' || item.type === 'note') {
      open.delete(item.window);
      out.push(item);
      continue;
    }
    // A progress note is NOT a boundary, on purpose: the agent wrote it in the
    // middle of the work it describes, so closing its lane there would chop one
    // run into a group per report — the churn this whole rule exists to avoid.
    if (item.type === 'progress') {
      out.push(item);
      continue;
    }
    // Lifecycle lines are the app's record, not a turn boundary: consecutive
    // ones fold into ONE row.
    const prev = out[out.length - 1];
    if (item.type === 'sys' && prev?.type === 'sys') {
      prev.items.push(...item.items);
      prev.ids = [...(prev.ids ?? []), ...(item.ids ?? item.items.map(() => ''))];
      continue;
    }
    out.push(item);
  }
  return out;
}

/** One readline edit against the composer's text, as pure data.
 *
 * The composer talks to terminal people: their fingers already know Ctrl-A/E/
 * U/K/W/Y from every shell they have ever typed into, and on macOS the system
 * text views honour half of that set natively — so its ABSENCE here is what
 * reads as broken, and the half macOS lacks (U, W, Y) is the half a Linux
 * browser lacks entirely (owner, 2026-08-20: "支持 ctrl a/e/u/y 等等快捷键，
 * 其中有一些 mac 系统好像就已经支持了 … 适用性更好一些"). Implementing the set
 * OURSELVES, everywhere, is what makes it uniform: the mac keeps the bindings
 * it had, every other platform gains them, and none of them drift apart.
 *
 * Pure — the component owns the textarea and the kill buffer; this owns the
 * arithmetic. Returns null for any key the table does not know, so the caller
 * falls through to the browser (Ctrl-C/V/X/Z are deliberately NOT here).
 *
 * Kill semantics are readline's: U/K/W save what they delete into ONE buffer,
 * consecutive kills accumulate (backward kills PREPEND, forward kills APPEND —
 * so Ctrl-W Ctrl-W Ctrl-Y restores the words in their original order), and any
 * other edit breaks the chain. Ctrl-D deletes without saving, as in readline.
 * A/E move within the LINE, not the whole text — the composer is a textarea
 * and a multi-line draft has lines.
 */
export interface ReadlineReq {
  key: string;      // e.key, lowercased; caller has checked ctrl && !meta && !alt
  text: string;
  start: number;    // selectionStart
  end: number;      // selectionEnd
  kill: string;     // the kill buffer as of this keystroke
  killing: boolean; // the PREVIOUS edit was a kill (accumulation chain)
}
export interface ReadlineEdit {
  text: string;
  caret: number;    // collapsed selection
  kill: string;
  killing: boolean;
}
export function readlineEdit(r: ReadlineReq): ReadlineEdit | null {
  const { text, start, end } = r;
  const lineStart = (i: number) => text.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = (i: number) => { const n = text.indexOf('\n', i); return n === -1 ? text.length : n; };
  const keep = (caret: number): ReadlineEdit => ({ text, caret, kill: r.kill, killing: false });
  const cut = (from: number, to: number, prepend: boolean): ReadlineEdit => {
    const del = text.slice(from, to);
    return {
      text: text.slice(0, from) + text.slice(to),
      caret: from,
      kill: del ? (r.killing ? (prepend ? del + r.kill : r.kill + del) : del) : r.kill,
      killing: true,
    };
  };
  switch (r.key) {
    case 'a': return keep(lineStart(start));
    case 'e': return keep(lineEnd(end));
    case 'b': return keep(start !== end ? start : Math.max(start - 1, 0));
    case 'f': return keep(start !== end ? end : Math.min(end + 1, text.length));
    case 'u': return cut(lineStart(start), start, true);
    case 'k': {
      // At the end of a line, Ctrl-K eats the newline — that is how readline
      // joins lines, and without it the key dies exactly where you reach for it.
      const from = end;
      const to = lineEnd(end) === from && from < text.length ? from + 1 : lineEnd(end);
      return cut(from, to, false);
    }
    case 'w': {
      let p = start;
      while (p > 0 && /\s/u.test(text[p - 1]!)) p--;
      while (p > 0 && !/\s/u.test(text[p - 1]!)) p--;
      return cut(p, start, true);
    }
    case 'y': {
      // Empty buffer still returns handled: the browser's own Ctrl-Y is redo
      // (Chromium), and half-yanking half-redoing would be worse than a no-op.
      if (!r.kill) return keep(start);
      return {
        text: text.slice(0, start) + r.kill + text.slice(end),
        caret: start + r.kill.length,
        kill: r.kill,
        killing: false,
      };
    }
    case 'd': {
      if (start !== end) return { text: text.slice(0, start) + text.slice(end), caret: start, kill: r.kill, killing: false };
      if (start >= text.length) return keep(start);
      return { text: text.slice(0, start) + text.slice(start + 1), caret: start, kill: r.kill, killing: false };
    }
    case 'h': {
      if (start !== end) return { text: text.slice(0, start) + text.slice(end), caret: start, kill: r.kill, killing: false };
      if (start === 0) return keep(0);
      return { text: text.slice(0, start - 1) + text.slice(start), caret: start - 1, kill: r.kill, killing: false };
    }
    case 't': {
      // Drag the char before point over the char at point; at the end of a
      // line, transpose the last two. Readline's caret lands after the pair.
      const atEol = start >= text.length || text[start] === '\n';
      const i = atEol ? start - 2 : start - 1;
      if (i < 0 || text[i] === '\n' || text[i + 1] === '\n' || i + 1 >= text.length) return keep(start);
      return {
        text: text.slice(0, i) + text[i + 1] + text[i] + text.slice(i + 2),
        caret: i + 2,
        kill: r.kill,
        killing: false,
      };
    }
    default: return null;
  }
}

// ── Tail intent (board #38) ──────────────────────────────────────────────────
/** A feed is "at the tail" within this bottom gap (px). The margin absorbs
 * sub-pixel rounding and the last message's own padding. */
export const TAIL_GAP = 40;

/** Distance from the scrollport's bottom edge — the ONE measure of tail
 * intent. Never the absolute scrollTop: content growth moves scrollTop's
 * meaning, while the gap keeps meaning "how far from the newest message". */
export function bottomGap(box: { scrollHeight: number; scrollTop: number; clientHeight: number } | null): number {
  if (!box) return 0;
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/** The transition rule for `following` on a scroll event. A HIDDEN page's
 * scroll events are layout noise (another tab moved the viewport var, content
 * grew under a hidden feed): they can neither TAKE the tail intent away from a
 * reader who left at the tail, nor GRANT it to one who left reading history.
 * Visible, the gap decides. */
export function tailAfterScroll(visible: boolean, wasFollowing: boolean, gap: number): boolean {
  if (!visible) return wasFollowing;
  return gap < TAIL_GAP;
}

/** The perLine estimate, MEASURED (board #53 review blocker): elideTail's
 * default 80 was tuned on a 1280px window whose content line is ~723px ≈ 82
 * latin glyphs — at 420px the same line is ~338px ≈ 38 glyphs, so the fold
 * under-priced wrapping ~2.1× and a "folded" bubble rendered ~8 lines on a
 * 4-line budget (lead, real-Chromium measurements, 2026-09-01). The mapping:
 * the widest content line a bubble can wrap at ÷ the bubble font's average
 * latin glyph (CJK is elideTail's 2-unit half, not this one's). Unmeasured
 * or degenerate inputs answer the historic default — the same pre-measure
 * posture as chipCols' 2 columns — and real answers clamp to [16, 240] so a
 * sliver of a column still shows words and an ultrawide still folds. */
export function perLineOf(contentPx: number, glyphPx: number): number {
  if (!Number.isFinite(contentPx) || !Number.isFinite(glyphPx) || contentPx <= 0 || glyphPx <= 0) return 80;
  return Math.min(240, Math.max(16, Math.floor(contentPx / glyphPx)));
}

/** The model as the CARD shows it: the vendor/routing prefixes a provider id
 * carries — `openai.gpt-5.6-sol`, `xai.grok-4.6`, `us.anthropic.claude-…`,
 * `global.openai.gpt-5.6-luna` — are facts about the route, not the model, and
 * on a 4-across phone row they eat the characters that tell models apart
 * (owner, 2026-09-03: "agent卡片显示的前缀可以省略掉"). Only known vendor and
 * region words are dropped, so `gpt-5.6-sol` and `Fable 5.1` pass unchanged
 * and a dotted version (`gpt-5.6`) is never mistaken for a prefix. A TRAILING
 * parenthetical is the same kind of fact — omp's display names carry the
 * route and the window there (`Fable 5.1 (Bedrock, 1M)`, `Opus 4.8 (US)`) —
 * and is dropped too (owner, 2026-09-07: "(Bedrock, 1M) 这个可以省略吧");
 * a name that is ONLY a parenthetical stays whole rather than emptying.
 * A trailing ` on <route>` clause is the unparenthesised spelling of the same
 * fact — kimi's alias display name is `Kimi K3 on Bedrock` (owner, 2026-09-21,
 * board #230: "现在应该是 Kimi K3") — and only the known route words drop, so a
 * model whose identity happens to contain " on " passes unchanged. */
const MODEL_PREFIXES = new Set(['openai', 'anthropic', 'xai', 'amazon', 'meta', 'us', 'eu', 'apac', 'global']);
const MODEL_ROUTES = new Set(['bedrock', 'vertex', 'azure']);
/** The six agent name inks (`--agent-1..6`, app.css), one per identity. */
export const AGENT_HUES = 6;
/** An agent's NAME ink (board #292): a stable FNV-1a hash of the name picks
 * one of the six theme-aware `--agent-*` tokens, so the same name wears the
 * same colour in every room, on every device, after every restart — and no
 * table has to be kept. The ONE function behind the feed header, the
 * sysline's who, the roster card name and an @mention; the human and @all
 * are not agents and keep the accent. Identity, never state. */
export function agentHue(name: string | null | undefined): string {
  if (!name || name === HUMAN || name === 'all') return 'var(--accent)';
  let h = 0x811c9dc5;
  for (const ch of name) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return `var(--agent-${(h % AGENT_HUES) + 1})`;
}

/** What an agent RUNS on, for a reader: `kiro · claude-opus-5.5` — the
 * backend, then the sniffed model through `modelLabel` (board #292). The ONE
 * definition behind the roster card's hover model line and the grey label
 * beside an agent's name over its bubble, read off the same hub_agents row.
 * No row (a stopped or removed agent, the human) means no label: '' — never a
 * guess from history. */
export function runtimeLabel(agent: { agent?: string | null; vitals?: { model?: string | null } | null } | null | undefined): string {
  if (!agent) return '';
  return [agent.agent ?? '', agent.vitals?.model ? modelLabel(agent.vitals.model) : ''].filter(Boolean).join(' · ');
}

export function modelLabel(model: string): string {
  let s = model.trim();
  for (;;) {
    const dot = s.indexOf('.');
    if (dot <= 0 || !MODEL_PREFIXES.has(s.slice(0, dot)) || dot === s.length - 1) break;
    s = s.slice(dot + 1);
  }
  let bare = s.replace(/\s*\([^()]*\)$/u, '');
  const route = bare.match(/^(.*\S)\s+on\s+(\S+)$/u);
  if (route?.[1] && route[2] && MODEL_ROUTES.has(route[2].toLowerCase())) bare = route[1];
  return bare === '' ? s : bare;
}
