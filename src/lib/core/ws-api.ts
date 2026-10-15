// Every RPC this client can make, declared ONCE.
//
// `createWsApi(connection)` binds the whole surface to one Connection: each
// wrapper closes over that handle, so a call cannot wander to whichever
// connection happens to be current when its promise settles. The wire — method
// names, parameter shapes, per-call timeouts, return types — is the server's
// contract (docs/requirements/api-contracts/websocket-rpc.md) and is not
// this split's business to change (board #335 ①).
//
// Shapes mirror the Rust structs (src-tauri/src/tmux.rs). If a field changes
// server-side, change it here — every consumer then fails to type-check
// instead of silently reading `undefined`.
import type { ProjectRow } from '../projects/projects.ts';
import type { BackendInfo } from './agents.ts';
import type { SystemStatus as SystemStatusReading } from '../system/system.ts';
import type { Connection, TeamMessage } from './connection.ts';
import { BOARD_DISPATCH, holdForLogin, requireCap } from './login-caps.ts';

// ─── Protocol types ──────────────────────────────────────────────────────

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
  last_opened?: number;
}
export interface TmuxPane {
  session: string;
  window: number;
  pane: number;
  width: number;
  height: number;
  current_command: string;
  window_name: string;
  pane_title: string;
  current_path: string;
  active: boolean;
  child_cmd?: string; // omitted when the pane runs a bare shell
  /** The agent CLI the pane's processes run (backend name, board #260);
   * omitted for anything else. The server's one verdict — never re-derive it. */
  agent?: string;
}

// Project hub (agents-v2): per-project chat + derived agent states + spawn.
// Same desktop-only degradation contract as project_* / team_*. Chat pushes
// ride the existing team_message channel (each message carries its room —
// a project's room is `proj:<session>`).
export interface HubAgent {
  window: number;
  name: string;
  command: string;
  agent: string | null;
  /** True when the window is a MANAGED agent — spawned from the registry into
   * an isolated home under `<workspace>/.tmm/agents/<name>/`. Only these are
   * chat participants; direct windows (shells, agents the user started by
   * hand) exist in the terminal drawer only. */
  managed: boolean;
  /** The configured team path this window was started as part of (board #74);
   * null for a solo agent. The roster groups by root path; hover/ARIA retain
   * the full sub-team identity. */
  team?: string | null;
  state: string;
  detail: string;
  since: number;
  /** queue|steer the session RUNS now, derived from its pane (board #271);
   * null where the backend has no such choice. */
  input_mode?: 'queue' | 'steer' | null;
  /** The soonest pending wake addressed to this agent (board #275): when
   * (unix seconds), who set it, how many more follow; null when none. */
  wake?: HubWake | null;
}
export interface HubWake { due_at: number; from: string; more: number }
/** A room's unread summary above the reader's watermark (board #322): the
 * messages `rooms::news_kind` calls news. A room with none is absent. */
export interface RoomUnread { count: number; first_seq: number; last_seq: number }
/** The watermark per room: the last read seq, or a legacy ts. */
export type ReadMark = { seq: number } | { ts: number };
/** The server's PERSISTED read mark of a room (board #334). */
export interface ServerMark { seq: number; ts: number }
/** The project task board: session-scoped issues in four fixed columns.
 * Humans write issues here; agents read and update them via `tmm board`. */
/** What `hub_board_save` answers (board #377). `dispatch` is absent unless the
 * request asked for a hand-off AND there was somebody to tell: `sent` (typed
 * into a pane), `offline` (saved, nothing typed to anyone) or `failed` (saved,
 * and the post itself failed: an answer, never an error, because the issue
 * exists and a retry must not file it twice). */
export interface BoardSaveAnswer {
  ok: boolean;
  id: number;
  dispatch?: 'sent' | 'offline' | 'failed';
  dispatch_error?: string;
  /** `hub_post`'s own rows (#347): which names no pane received, and why. */
  offline?: { name: string; why: string }[];
}

export interface BoardIssue {
  /** Session-local durable number: every project starts at 1; the DB row key is hidden. */
  id: number;
  title: string;
  body: string;
  status: string;
  assignee: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** Original title/body may change only while unassigned and before any Agent activity. */
  editable: boolean;
  notes: number | { author: string; body: string; at: number }[];
}
/** Per-column counts on every returned row (server-side zero-filled over the
 * four fixed statuses) plus an explicit total — "is this board empty" is one
 * field, never a client-side sum. */
export interface BoardCountRow {
  todo: number;
  doing: number;
  review: number;
  done: number;
  total: number;
}
export interface HubActivityEvent {
  ts: number;      // epoch ms — merges directly with chat message timestamps
  /** The window NAME — the agent's identity (board #120; it was the tmux
   * window index, which renumber-windows reassigns). */
  window: string;
  /** tool = a hook tool call, status = `tmm status`, notif = a lifecycle hook,
   * prompt = a prompt the agent accepted (userPromptSubmit), warn = a line we
   * typed that the agent never echoed back, steered = lines typed into a busy
   * steer-mode turn, which owe no echo (board #276; `deliveries[].msg` names
   * them). */
  kind: 'tool' | 'status' | 'notif' | 'prompt' | 'warn' | 'steered';
  /** For `tool` events this is the ARGUMENT (a path, a command); the tool's
   * name is `tool`. For every other kind it is the whole line. */
  text: string;
  /** `tool` events only: the tool's name ("Edit", "execute_bash"). */
  tool?: string;
  /** `prompt` events only: 'app' when the text is the line this app typed into
   * the pane (the delivery receipt), 'local' when typed at the keyboard. */
  via?: 'app' | 'local';
  /** The delivery rows this event is about (board #249): the rows a `prompt`
   * echo settled, or the one row a `warn` reported. `id` is the row (the one
   * correlation key); `msg` the chat message it carries, where one exists.
   * Absent when there are none and on rows before v24. */
  deliveries?: { id: number; msg?: string }[];
  /** `status` events only: the state the agent declared. The `text` is its note
   * — what it says it is doing — which is the half a human reads. */
  state?: 'working' | 'waiting' | 'blocked';
  /** The durable log's row id — half of the paging cursor (ts, id): a busy
   * turn writes several events in one millisecond, so ts alone cannot
   * address a position (board #9). Absent on rows from pre-paging servers. */
  id?: number;
}
export interface RegAgent {
  name: string;
  backend: string;
  model: string;
  effort?: string;
  /** What a line typed while it is busy does (board #245); absent = queue.
   * `steer` only on a backend whose `backends_list` entry has `input_modes`. */
  input_mode?: 'queue' | 'steer';
  system: string;
  skills: string;
  mcp: string;
}
/** An agent TEAM (board #74): each member is a bare coding agent configured
 * inline, a custom registry agent inherited through `base`, or a sub-team. */
export interface TeamMember {
  name: string;
  base: string;
  /** Another team included whole (nesting); `role` is then a brief for all
   * of its members. name/base/agent are ignored for this kind. */
  team?: string;
  role: string;
  /** Model / effort / input-mode overrides for a derived member; empty = the
   * base's (input mode: board #254, `queue` | `steer`). */
  model?: string;
  effort?: string;
  input_mode?: '' | 'queue' | 'steer';
  /** Complete definition for the bare source. Registry/sub-team sources leave
   * this null and inherit their prompt, Skills and MCP unchanged. */
  agent?: RegAgent | null;
}
export interface RegTeam {
  name: string;
  description: string;
  members: string;
}
// Central skills / MCP assets — referenced from agent defs by name.
export interface RegSkill {
  name: string;
  source: string;
  description: string;
  synced_at?: number;
}
export interface RegMcpServer {
  name: string;
  def: string;
}

export function httpOriginForWs(url: string): string {
  const parsed = new URL(url);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const path = parsed.pathname.replace(/\/+$/, '');
  const downloadBasePath = path.endsWith('/ws') ? path.slice(0, -3) : path;
  return `${protocol}//${parsed.host}${downloadBasePath}`;
}

export function createWsApi(connection: Connection) {
  // A closure on the handle, not a method: `call` carries its connection with
  // it, which is the whole point of binding the API to one object.
  const { call } = connection;

  const listSessions = () => call<TmuxSession[]>('list_sessions');
  const listPanes = (session: string) => call<TmuxPane[]>('list_panes', { session });
  // Single round-trip alternative for callers (Sessions page) that need both
  // the session list AND all their panes — saves N+1 RPCs vs listSessions
  // followed by N × listPanes.
  const listSessionsWithPanes = () => call<{ sessions: TmuxSession[]; panes: TmuxPane[] }>('list_sessions_with_panes');
  const capturePane = (target: string, lines?: number) => call('capture_pane', { target, lines });
  const sendKeys = (target: string, keys: string, literal = true) => call('send_keys', { target, keys, literal });
  const pasteText = (target: string, text: string) => call('paste_text', { target, text });
  /** The scratch terminal's session (board #324): ensure it and get its pane
   * target, or kill it. The server decides ownership; a name held by anything
   * else is refused with the reason. */
  const scratchSession = () => call<{ session: string; target: string }>('scratch_session', {});
  const scratchKill = () => call<{ killed: boolean }>('scratch_kill', {});
  /** Board #337: free the reserved session name from the project holding it,
   * on the reader's confirmation. The project is the one the REFUSAL named
   * (its error data) — the server renames only if it still declares that
   * session, so what the reader approved is what happens. */
  const scratchRelease = (projectId: string, session: string) =>
    call<{ released: boolean; project: string; renamed_to: string }>('scratch_release', { projectId, session });
  const newSession = (name: string, path?: string, command?: string) => call('new_session', { name, path, command });
  const killSession = (name: string) => call('kill_session', { name });
  const newWindow = (session: string) => call('new_window', { session });
  const killWindow = (target: string) => call('kill_window', { target });
  const paneCommand = (target: string) => call('pane_command', { target });
  const resizePane = (target: string, cols: number, rows: number) => call('resize_pane', { target, cols, rows });
  const setSocket = (socket: string) => call('set_socket', { socket });
  const getBookmarks = () => call('get_bookmarks');
  const saveBookmarks = (bookmarks: string[]) => call('save_bookmarks', { bookmarks });
  const getPrefs = () => call('get_prefs');
  const setPref = (key: string, value: unknown) => call('set_pref', { key, value });

  // File system
  const fsCwd = (session: string) => call('fs_cwd', { session });
  const fsList = (path: string, show_hidden = false) => call('fs_list', { path, show_hidden });
  const fsStat = (path: string) => call('fs_stat', { path });
  const fsRead = (path: string) => call('fs_read', { path });
  const fsWrite = (path: string, content: string) => call('fs_write', { path, content });
  const fsMkdir = (path: string) => call('fs_mkdir', { path });
  const fsDelete = (path: string) => call('fs_delete', { path });
  const fsRename = (from: string, to: string) => call('fs_rename', { from, to });
  // Large transfers have a long explicit timeout — they're allowed to sit in
  // flight longer than the default RPC timeout. Liveness detection during the
  // transfer is handled at the WS protocol layer (server PING / browser PONG),
  // so even a 50 MB frame in the air won't make us give up on the socket.
  const fsDownload = (path: string) => call('fs_download', { path }, 60000);

  /** `stream: true` asks for a media-lived signature — a `<video>` keeps
   * re-requesting the same URL for the whole playback (board #182); a plain
   * download URL is fetched at once and dies in a minute. */
  const fsDownloadUrl = (path: string, opts: { stream?: boolean } = {}) =>
    call<{ url: string; name: string }>('fs_download_url', opts.stream ? { path, stream: true } : { path });
  const fsUpload = (path: string, data: string) => call('fs_upload', { path, data }, 60000);
  const fsConvert = (path: string, format = 'html') => call('fs_convert', { path, format });
  const gitCmd = (subcmd: string, args: string[] = [], cwd?: string) => call<{ code: number; stdout: string; stderr: string }>('git', { subcmd, args, cwd });

  // Declarative projects (desktop server only — state.db is not built for
  // mobile). Like team_*, these reject with method-not-found on a server without
  // support and the Projects section hides itself.
  const projectList = (includeArchived = false) =>
    call<{ projects: ProjectRow[] }>('project_list', { include_archived: includeArchived });
  const projectCreate = (path: string, opts: { name?: string; session?: string; agent?: string } = {}) =>
    call('project_create', { path, ...opts });
  const projectAdopt = (session: string, name?: string) => call('project_adopt', { session, name });
  const projectUp = (id: string) => call('project_up', { id });
  const projectDown = (id: string) => call('project_down', { id });
  /** Rename a project. The tmux SESSION follows the name (it is what the Terminal
   * and `tmux ls` show), except on an adopted project whose session name is its
   * owner's. `session` is the name it ended up with. The chat room does NOT move —
   * it is recorded on the project — and the previous session name keeps resolving,
   * so agents already running with `TMM_PROJECT` set are unaffected. */
  const projectRename = (id: string, name: string) =>
    call<{ id: string; name: string; session: string; session_renamed: boolean }>(
      'project_rename', { id, name },
    );
  const projectArchive = (id: string, archived = true) => call('project_archive', { id, archived });
  /** Forget a project: kills its session and deletes its agents' isolated homes.
   * `projectArchive` is the reversible "hide it" verb; this one is not. */
  const projectDelete = (id: string) => call('project_delete', { id });
  const projectAutostart = (id: string, autostart: boolean) => call('project_autostart', { id, autostart });
  /** `re` (board #290): the id or seq of a message of this room to quote;
   * the server puts its quote token after the body's leading addresses. */
  const hubPost = (session: string, body: string, from = 'human', re?: string) =>
    call('hub_post', re ? { session, body, from, re } : { session, body, from });
  /** Type a slash command into an agent's pane VERBATIM — no stamp, no sender, no
   * @address. `/model`, `/clear`, `/compact` are interpreted by the agent's CLI and
   * only when they are the whole line, so they cannot go through hub_post's
   * delivery. `agent` is a window name or 'all'; the room records it as a lifecycle
   * line, not a message. */
  const hubCommand = (session: string, agent: string, text: string) =>
    call<{ sent: string[]; command: string }>('hub_command', { session, agent, text });
  /** Read the project chat. `sinceTs` (exclusive) is the incremental poll;
   * `beforeSeq` walks BACKWARDS one page at a time (board #9) — `seq` is the
   * bus's own stable cursor, carried on every message. The response hands back
   * `oldest_seq` (this page's cursor for the next walk) and `has_more`. */
  const hubLog = (session: string, sinceTs = 0, limit = 100, beforeSeq = 0) =>
    call<{ messages: TeamMessage[]; has_more?: boolean; oldest_seq?: number }>(
      'hub_log',
      beforeSeq > 0 ? { session, limit, before_seq: beforeSeq } : { session, since_ts: sinceTs, limit },
    );
  /** The page of a room AROUND one of its messages (board #322, the centre's
   * jump): `limit / 2` rows from `seq` on and the rest before it, plus
   * `newer_more` — newer rows exist, so this page is a history window, not the
   * tail. `oldest_seq` and `has_more` continue the backward walk as usual. */
  const hubLogAround = (session: string, seq: number, limit = 100) =>
    call<{ messages: TeamMessage[]; has_more?: boolean; newer_more?: boolean; oldest_seq?: number }>(
      'hub_log', { session, limit, around_seq: seq },
    );
  /** Deleting a message is two steps. `hubMsgArchive` HIDES it — the message stays in
   * the room's store, so a restore costs nothing — and `hubMsgPurge` is the step that
   * forgets it for good. Only the second one destroys anything. */
  const hubMsgArchive = (session: string, ids: string[]) =>
    call<{ archived: number }>('hub_msg_archive', { session, ids });
  const hubMsgRestore = (session: string, ids: string[]) =>
    call<{ restored: number }>('hub_msg_restore', { session, ids });
  const hubMsgPurge = (session: string, ids: string[]) =>
    call<{ deleted: number }>('hub_msg_purge', { session, ids });
  /** Newest message timestamp (ms) per room: `{ "<room>": ts }`. One call for every
   * room, so the sidebar can order projects by conversation without asking per
   * project. */
  const hubRooms = () =>
    call<{ rooms: Record<string, number>; states?: Record<string, string> }>('hub_rooms', {});
  /** `marks` is the persisted server mark of every asked room that has one —
   * never the effective watermark the count was read from (board #334). */
  const hubUnread = (rooms: Record<string, ReadMark | Record<string, never>>) =>
    call<{ rooms: Record<string, RoomUnread>; marks?: Record<string, ServerMark> }>('hub_unread', { rooms });
  /** The human read these rooms (board #334): moves each room's ONE server
   * mark forward. The answer is the persisted marks — the ACK; a room absent
   * from it wrote nothing. Only the human's clients call this, never tmm. */
  const hubRead = (rooms: Record<string, ReadMark>) =>
    call<{ rooms: Record<string, ServerMark> }>('hub_read', { rooms });
  // ── Server system vitals (board #56) ────────────────────────────────────────
  /** One low-frequency reading of the machine the SERVER runs on (cpu/mem/root
   * disk — `src-tauri/src/system_status.rs` is the authority on the shape).
   * Null instead of a rejection on ANY failure: a mobile or older server
   * answers method-not-found, and the corner's contract is "a failed ask keeps
   * the last reading / nothing renders before the first" — an exception here
   * would be the one thing the fail-soft chain cannot absorb. */
  const systemStatus = (): Promise<SystemStatusReading | null> =>
    call<SystemStatusReading>('system_status', {}).catch(() => null);
  /** What is hidden in this room, newest first. Each row carries the message itself,
   * so the archive view needs no second lookup. */
  const hubArchive = (session: string) =>
    call<{ messages: TeamMessage[] }>('hub_archive', { session });
  const hubAgents = (session: string) =>
    call<{ agents: HubAgent[] }>('hub_agents', { session });
  const boardList = (session: string) =>
    call<{ issues: BoardIssue[]; statuses: string[] }>('hub_board_list', { session });
  /** Issue counts for EVERY project's board in one call (board #39) — the Board
   * sidebar's grouped read, like hubRooms: no session param, answered before the
   * per-session gate. A project with an EMPTY board is ABSENT from the map
   * (absence = hide), so callers must not expect all-zeros rows. */
  const boardCounts = () =>
    call<{ counts: Record<string, BoardCountRow> }>('hub_board_counts', {});
  const boardGet = (session: string, id: number) =>
    call<BoardIssue>('hub_board_get', { session, id });
  /** Create (no id) or patch (id + only the fields to change). `who` records the
   * actor; the UI always says 'human'. */
  const boardSave = async (session: string, fields: { id?: number; title?: string; body?: string; status?: string; assignee?: string; dispatch?: boolean }) => {
    // A save that asks the server to hand the issue over (board #377) is the
    // ONE write that needs `board_dispatch`: an older server stores the label
    // and ignores the flag, which reads as a success nobody is told about.
    // The gate lives here, on the write path, bound to the socket that will
    // carry the call; the page only mirrors it for display.
    if (fields.dispatch) {
      await holdForLogin(connection); // may wait for the login; the only await
      requireCap(connection, BOARD_DISPATCH); // then check and write in ONE synchronous block
    }
    return call<BoardSaveAnswer>('hub_board_save', { session, who: 'human', ...fields });
  };
  const boardNote = (session: string, id: number, body: string) =>
    call<{ ok: boolean }>('hub_board_note', { session, id, body, who: 'human' });
  const boardDelete = (session: string, id: number) =>
    call<{ ok: boolean }>('hub_board_delete', { session, id });
  /** Read the activity feed. Newest page by default; `before` walks backwards
   * with the exact (ts, id) pair the previous page's `oldest` handed back. */
  const hubActivity = (
    session: string,
    sinceTs = 0,
    opts: { limit?: number; before?: { ts: number; id: number } } = {},
  ) =>
    call<{
      events: HubActivityEvent[];
      has_more?: boolean;
      oldest?: { ts: number; id: number } | null;
      total?: number;
      first_ts?: number;
    }>('hub_activity', {
      session,
      since_ts: sinceTs,
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.before ? { before_ts: opts.before.ts, before_id: opts.before.id } : {}),
    });
  const hubSpawn = (session: string, agent: string, brief = '', by = '') =>
    call('hub_spawn', { session, agent, brief, by });
  /** Start a configured agent TEAM (board #74): every member spawns as an
   * ordinary managed agent with its role block; one failure does not stop the
   * others and comes back in `errors`. */
  const hubSpawnTeam = (session: string, team: string, brief = '', by = '') =>
    call<{ team: string; spawned: { name: string; window_name: string; pane: string | null }[]; errors: { name: string; error: string }[] }>(
      'hub_spawn_team', { session, team, brief, by }, 120000);
  /** Kill one agent's window. The declaration survives, so it can come back. */
  const hubAgentStop = (session: string, agent: string) =>
    call<{ stopped: string }>('hub_agent_stop', { session, agent });
  /** Eject an agent: stop it, drop its slot, delete its isolated home. */
  const hubAgentRemove = (session: string, agent: string) =>
    call<{ agent: string; slot_removed: boolean; home_removed: boolean }>('hub_agent_remove', { session, agent });
  /** Cancel the turn an agent is running (Escape into its pane, server-side, so
   * the CLI and the UI share one implementation). */
  const hubAgentInterrupt = (session: string, agent: string) =>
    call<{ interrupted: string }>('hub_agent_interrupt', { session, agent });
  /** Switch a running agent's queue|steer mode for THIS session (board #271):
   * its CLI's own live toggle; a restart returns to the configured mode.
   * `changed` is false when it already ran `mode`. */
  const hubAgentInputMode = (session: string, agent: string, mode: 'queue' | 'steer') =>
    call<{ agent: string; mode: 'queue' | 'steer'; changed: boolean }>('hub_agent_input_mode', { session, agent, mode });
  /** Kill and bring back. `resumed` is false when the agent had to start a fresh
   * conversation because the project declaration did not have it yet. */
  const hubAgentRestart = (session: string, agent: string) =>
    call<{ restarted: string; resumed: boolean }>('hub_agent_restart', { session, agent }, 60000);
  /** Align a team with its CURRENT definition (board #286): restart the
   * members it still has, spawn those it gained, stop those it dropped. */
  const hubTeamRestart = (session: string, team: string, only?: string[]) =>
    call<{ team: string; restarted: string[]; stopped: string[]; spawned: string[]; errors: { name: string; error: string }[] }>(
      'hub_team_restart', only ? { session, team, only } : { session, team }, 180000);
  const registryList = () => call<{ agents: RegAgent[] }>('registry_list');
  const registrySave = (def: RegAgent) => call('registry_save', { def });
  const registryDelete = (name: string) => call('registry_delete', { name });
  /** The app-wide agent instructions (`<config>/AGENTS.md`): prepended to every
   * managed agent's system prompt at spawn (tmm-cli.md § The app-wide instructions). */
  const globalPromptGet = () => call<{ text: string; path: string; max_bytes: number }>('global_prompt_get');
  const globalPromptSet = (text: string) => call('global_prompt_set', { text });
  const teamsList = () => call<{ teams: RegTeam[] }>('teams_list');
  const teamsSave = (def: RegTeam) => call('teams_save', { def });
  const teamsDelete = (name: string) => call('teams_delete', { name });
  /** The backends this server can spawn, with the client's resource names for
   * each (name, avatar path, colour token, effort levels), first = default. */
  const backendsList = () => call<{ backends: BackendInfo[] }>('backends_list');
  /** The model ids a backend accepts. `models` is null where the backend cannot
   * enumerate them (claude/codex take aliases), and the editor keeps the field as
   * free text in that case. */
  const modelsList = (backend: string) =>
    call<{ backend: string; models: string[] | null }>('models_list', { backend });
  const skillsList = () => call<{ skills: RegSkill[] }>('skills_list');
  const skillsSave = (def: RegSkill) => call('skills_save', { def });
  const skillsDelete = (name: string) => call('skills_delete', { name });
  const skillsRefresh = (name: string) => call('skills_refresh', { name });
  const skillsRead = (name: string) => call<{ name: string; content: string }>('skills_read', { name });
  const skillsImport = (source: string) => call<{ ok: boolean; imported: string[]; skipped: string[] }>('skills_import', { source });
  const skillsFiles = (name: string) => call<{ name: string; files: { path: string; size: number }[] }>('skills_files', { name });
  const skillsFile = (name: string, path: string) => call<{ name: string; path: string; content: string }>('skills_file', { name, path });
  const mcpList = () => call<{ mcp: RegMcpServer[] }>('mcp_list');
  const mcpSave = (def: RegMcpServer) => call('mcp_save', { def });
  const mcpDelete = (name: string) => call('mcp_delete', { name });

  /** The signed HTTP URL for `path`, resolved against the origin of THIS
   * connection. The origin is read BEFORE the round trip: the signature comes
   * from one server, so the base it is appended to cannot be whatever
   * connection became interesting while we waited.
   *
   * Both ws:// and wss:// use the streaming HTTP /dl endpoint — the server
   * peeks the first bytes of every accepted (plain or TLS) connection and
   * branches HTTP vs WS. Streaming avoids the 50 MB cap and base64 overhead.
   * wss://host/prefix/ws → https://host/prefix. Only a trailing /ws proxy
   * segment is discarded; production parent prefixes remain intact. */
  function fsDownloadHttp(path: string, opts: { stream?: boolean } = {}) {
    const origin = connection.url(); // connect() set it before any RPC could run
    return fsDownloadUrl(path, opts).then(({ url, name }) => {
      const base = httpOriginForWs(origin!);
      return { url: base + url, name };
    });
  }

  return {
    listSessions, listPanes, listSessionsWithPanes, capturePane, sendKeys, pasteText,
    scratchSession, scratchKill, scratchRelease, newSession, killSession, newWindow, killWindow, paneCommand,
    resizePane, setSocket, getBookmarks, saveBookmarks, getPrefs, setPref, fsCwd, fsList,
    fsStat, fsRead, fsWrite, fsMkdir, fsDelete, fsRename, fsDownload, fsDownloadUrl,
    fsUpload, fsConvert, gitCmd, projectList, projectCreate, projectAdopt, projectUp,
    projectDown, projectRename, projectArchive, projectDelete, projectAutostart, hubPost,
    hubCommand, hubLog, hubLogAround, hubMsgArchive, hubMsgRestore, hubMsgPurge, hubRooms,
    hubUnread, hubRead, systemStatus, hubArchive, hubAgents, boardList, boardCounts,
    boardGet, boardSave, boardNote, boardDelete, hubActivity, hubSpawn, hubSpawnTeam,
    hubAgentStop, hubAgentRemove, hubAgentInterrupt, hubAgentInputMode, hubAgentRestart,
    hubTeamRestart, registryList, registrySave, registryDelete, globalPromptGet,
    globalPromptSet, teamsList, teamsSave, teamsDelete, backendsList, modelsList, skillsList,
    skillsSave, skillsDelete, skillsRefresh, skillsRead, skillsImport, skillsFiles,
    skillsFile, mcpList, mcpSave, mcpDelete, fsDownloadHttp,
  };
}

/** The bound RPC surface of one connection. */
export type WsApi = ReturnType<typeof createWsApi>;

/**
 * What each wrapper does to its server: `read` asks, `write` changes it —
 * tmux (keys, panes, sessions), files, projects, the bus (posts, read marks,
 * agents), the board, the registry, skills, MCP, the server's own prefs
 * (board #335 ③a, orchestrator's P1-D ruling). A server whose app is blocked
 * on its storage keeps its reads — the lists, a download's re-sign — and
 * refuses NEW writes until Retry. `gitCmd` runs whatever subcommand it is
 * given, so it is a write; `resizePane` and `setSocket` change the server's
 * tmux, so they are too.
 *
 * Every wrapper is here (the `satisfies` makes a missing one a type error,
 * and app/server-runtime.frozen.test.ts a test failure): a new RPC cannot be added
 * without saying which it is, and there is no default.
 */
export const RPC_KIND = {
  listSessions: 'read', listPanes: 'read', listSessionsWithPanes: 'read', capturePane: 'read',
  sendKeys: 'write', pasteText: 'write',
  scratchSession: 'write', scratchKill: 'write', scratchRelease: 'write',
  newSession: 'write', killSession: 'write', newWindow: 'write', killWindow: 'write',
  paneCommand: 'read', resizePane: 'write', setSocket: 'write',
  getBookmarks: 'read', saveBookmarks: 'write', getPrefs: 'read', setPref: 'write',
  fsCwd: 'read', fsList: 'read', fsStat: 'read', fsRead: 'read',
  fsWrite: 'write', fsMkdir: 'write', fsDelete: 'write', fsRename: 'write',
  fsDownload: 'read', fsDownloadUrl: 'read', fsDownloadHttp: 'read',
  fsUpload: 'write', fsConvert: 'read', gitCmd: 'write',
  projectList: 'read', projectCreate: 'write', projectAdopt: 'write', projectUp: 'write',
  projectDown: 'write', projectRename: 'write', projectArchive: 'write', projectDelete: 'write',
  projectAutostart: 'write',
  hubPost: 'write', hubCommand: 'write', hubLog: 'read', hubLogAround: 'read',
  hubMsgArchive: 'write', hubMsgRestore: 'write', hubMsgPurge: 'write',
  hubRooms: 'read', hubUnread: 'read', hubRead: 'write', systemStatus: 'read',
  hubArchive: 'write', hubAgents: 'read',
  boardList: 'read', boardCounts: 'read', boardGet: 'read',
  boardSave: 'write', boardNote: 'write', boardDelete: 'write',
  hubActivity: 'read', hubSpawn: 'write', hubSpawnTeam: 'write',
  hubAgentStop: 'write', hubAgentRemove: 'write', hubAgentInterrupt: 'write', hubAgentInputMode: 'write',
  hubAgentRestart: 'write', hubTeamRestart: 'write',
  registryList: 'read', registrySave: 'write', registryDelete: 'write',
  globalPromptGet: 'read', globalPromptSet: 'write',
  teamsList: 'read', teamsSave: 'write', teamsDelete: 'write',
  backendsList: 'read', modelsList: 'read',
  skillsList: 'read', skillsSave: 'write', skillsDelete: 'write', skillsRefresh: 'write',
  skillsRead: 'read', skillsImport: 'write', skillsFiles: 'read', skillsFile: 'read',
  mcpList: 'read', mcpSave: 'write', mcpDelete: 'write',
} as const satisfies Record<keyof WsApi, 'read' | 'write'>;
export type RpcKind = (typeof RPC_KIND)[keyof typeof RPC_KIND];
