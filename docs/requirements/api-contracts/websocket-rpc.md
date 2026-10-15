# WebSocket JSON-RPC API Contract

## Transport
JSON-RPC over WebSocket (`ws://` or `wss://`).

## Authentication

### Encrypted Auth (default, when Web Crypto available)
```
← {"server_nonce": "<hex>", "e2e": 2}                // nonce + newest handshake version
→ {"method": "auth", "params": {"client_nonce": "<hex>", "proof": "<hex>", "e2e": 2}}
← <binary AES-GCM frame: {"result": {"authenticated": true, "machine_id", "hostname", "e2e": 2, "build": {…}, "caps": ["board_dispatch", "spawn_join", "agent_team"]}}>
```
- IKM = token, salt = server_nonce ‖ client_nonce (16 + 16 bytes), HKDF-SHA256, 32-byte outputs
- **v2** (current) derives THREE keys, one per job, by `info` label:
  `tmux-mobile-e2e/v2/proof` (HMAC proof key), `tmux-mobile-e2e/v2/c2s`
  (client→server AES-256-GCM key), `tmux-mobile-e2e/v2/s2c` (server→client key)
- **v1** (legacy) derives ONE key with `info` = `tmux-mobile-e2e` and uses it as
  proof key and as the cipher key in both directions. Both directions counting
  from 0 under one key meant client message #n and server message #n shared a
  (key, nonce) pair — the AES-GCM nonce-reuse failure. Kept only so peers that
  predate v2 still connect.
- Negotiation: the server advertises `e2e` in the nonce frame; the client asks
  for a version in its auth params; the server derives with the version the
  CLIENT asked for (no field = v1) and echoes it in the authenticated result. An
  old client never sends `e2e` and gets v1; a new client against an old server
  sees no `e2e` in the nonce frame and uses v1.
- Proof: HMAC-SHA256(proof_key, server_nonce ‖ client_nonce) — both nonces, so a
  captured proof cannot be replayed into a later handshake
- All subsequent messages are binary AES-256-GCM frames; nonce = 4 zero bytes ‖ big-endian u64 counter
- Decrypted payload starts with a one-byte framing tag: raw UTF-8 JSON or raw-deflate JSON (compression is used only when it reduces payload size)
- Each direction uses its own monotonic counter; clients must serialize encrypted sends so wire order matches nonce order
- Server and client derivations are pinned to shared test vectors
  (`src-tauri/src/server/wire.rs` tests ↔ `src/lib/core/ws.test.ts`)

### Legacy Plain Auth (fallback, no Web Crypto)
```
← {"server_nonce": "<hex>"}
→ {"method": "auth", "params": {"token": "..."}}
← {"result": {"authenticated": true, "machine_id": "uuid", "hostname": "my-mac", "build": {…}, "caps": ["board_dispatch", "spawn_join", "agent_team"]}}
```
`build` (board #368) is the build the server runs, `{"version": "1.0.0", "commit": "46392f16", "built": "2026-10-14 07:40"}`:
the package version, the source commit (`git --short=8`: AT LEAST 8 hex characters, so two sides compare by prefix; `dev` when git was unavailable) and the UTC minute the build ran
(`unknown` when the clock was). It rides the login answer, not a new RPC, in both paths. A server older than #368 sends
none; a client reads that as "unknown", never as a mismatch.

`caps` (board #377) lists what the server can do that a client must know BEFORE it writes. Today three: `board_dispatch` —
`hub_board_save` with `dispatch: true` hands the issue to its assignee; `spawn_join` (board #382) — `hub_spawn` with `join`
puts the agent in that team, one present in this project (a member home here, live or stopped) (an older server ignores the key and spawns it standalone, so the page and `tmm spawn
--join` refuse a join unsent without it; a standalone spawn is not gated); `agent_team` (board #384) — `hub_agent_set_team`
exists (an older server answers method-not-found after the card was dropped, so the page disables the drag and the Move items and
`tmm agent team` exits with nothing changed). A server that lacks them sends no `caps` at all, and a
client that needs one refuses the write (the page's write path refuses it unsent and disables the picker, `tmm board assign` / `add --assignee` exit
with nothing saved); a login that has not answered yet is a wait, never a yes rather than store a label no agent is ever told about. Like `build`, it rides the login answer, in both paths.

### Rate Limiting
- Max auth failures tracked per IP
- Lockout after repeated failures (configurable timeout)

## Methods

### Session Management
| Method | Params | Response |
|--------|--------|----------|
| `ping` | — | `"pong"`. Used by the client's idle probe to detect half-open links. |
| `list_sessions` | — | Array of `{name, windows, attached, created, last_opened?}` objects. `last_opened` is unix seconds of the last time this session was opened via tmux-mobile (`subscribe` RPC); absent if never opened. The scratch terminal's session is omitted while it is ours (`scratch::hidden_session`, board #326 — its panel is its only door); a plain session or a project holding that name is listed normally. |
| `list_panes` | `session` | Array of pane objects: `{session, window, pane, width, height, current_command, window_name, pane_title, current_path, active, child_cmd?, agent?}`. `current_path` is tmux `#{pane_current_path}`; `active` marks the window's active pane; `child_cmd` is the foreground descendant argv, omitted for bare shells; `agent` is the backend name (`kiro`, `claude`, `codex`, `grok`, `omp`, `kimi`, `openclaw`) the pane's PROCESSES run, derived by the server from the NAME of each process on the pane's chain (argv[0]'s file name, plus the script's file name when argv[0] is an interpreter such as `node`; the one path read is Claude's `…/claude/versions/<version>` binary) — never from other arguments, directories, `pane_title` or `window_name` — and omitted for anything else. Clients read `agent`; they do not re-derive it (board #260). `list_sessions_with_panes` carries the same pane objects. |
| `list_sessions_with_panes` | — | `{sessions, panes}` — the two lists above in one round-trip (saves 1+N RPCs on the Sessions page). Hides the owned scratch session through the same one predicate, from the sessions AND from the panes. |
| `new_session` | `name?`, `path?`, `command?` | OK |
| `kill_session` | `name` | OK |
| `scratch_session` | — | `{session, target}` — ensures the scratch terminal's session (board #324: `tmm-scratch`, in `$HOME`, marked `@tmm-scratch=1`, never a project) and answers its first window's first pane as `session:window.pane`, always a LIVE one: #326 applies the keep-alive (`remain-on-exit` + a `pane-died: respawn-pane` hook) and repairs a pane that is already dead — `respawn-pane` without `-k`, so tmux itself refuses to restart a pane whose shell or command is still running; refuses with the reason when the name belongs to a plain session or a project |
| `scratch_release` | `projectId`, `session` | `{released, project, renamed_to}` — frees the scratch terminal's reserved session name by renaming the holder's session (board #337). The params are the snapshot the REFUSAL carried, and the server renames only if that project still declares that session right now; otherwise nothing is touched and the refusal is `-32011`, with the current holder named in its message. So what the reader confirmed is what happens, even if the holder changed in between, and `renamed_to` is the session that was actually WRITTEN, never the one the server asked for. The recovered name is `<reserved>-recovered`, or the same name `create` would pick (`free_session_name`'s digest suffix on a shortened base) when that is taken — always inside `slug`'s 24 characters, so the name chosen is the name written |
| `scratch_kill` | — | `{killed}` — kills the scratch session only when it is ours; `false` when absent; refuses when the name belongs to something else |
| `new_window` | `session` | OK |
| `kill_window` | `target` | OK |

### Pane Operations
| Method | Params | Response |
|--------|--------|----------|
| `capture_pane` | `target`, `lines?` | `{output}` with ANSI colors |
| `send_keys` | `target`, `keys`, `literal` | OK |
| `paste_text` | `target`, `text` | OK. Real-terminal paste semantics via tmux `load-buffer` + `paste-buffer -p`: bracketed-paste markers (`\x1b[200~…\x1b[201~`) are added exactly when the pane app enabled mode `?2004`, so pasted newlines are not executed line by line. |
| `send_command` | `target`, `command` | OK |
| `pane_command` | `target` | `{command}` string |
| `resize_pane` | `target`, `cols`, `rows` | OK (auto-restores on disconnect) |
| `subscribe` | `target` | Starts polling, pushes `pane_output`. Side effect: stamps the session's `last_opened` timestamp (persisted to `session_usage.json`) for MRU sorting. |
| `unsubscribe` | `target` | Stops streaming |

### Filesystem
| Method | Params | Response |
|--------|--------|----------|
| `fs_cwd` | `session` | `{path}` |
| `fs_list` | `path`, `show_hidden?` | `{entries, path}` |
| `fs_stat` | `path` | FileStat object |
| `fs_read` | `path` | `{content}` (≤512KB) |
| `fs_write` | `path`, `content` | OK |
| `fs_mkdir` | `path` | OK |
| `fs_delete` | `path` | OK |
| `fs_rename` | `from`, `to` | OK |
| `fs_download` | `path` | `{name, data}` base64 (≤50MB). For inline preview; user-initiated downloads use `fs_download_url` + HTTP `/dl` streaming instead. |
| `fs_download_url` | `path`, `stream?` | `{url, name}` where `url` = `/dl?path=…&exp=…&sig=…`. Client GETs it on the same host (http:// for ws://, https:// for wss://) to stream the file; `/dl` honours `Range: bytes=N-` and `bytes=N-M` (206/416). Every 200/206 carries a strong `ETag` (`"<size hex>-<mtime ns hex>"`) and `Last-Modified` (exposed to cross-origin callers); `If-Range` naming that ETag or that date keeps the Range, any other value makes `/dl` ignore Range and answer the whole current file as 200 (RFC 7233), which is how a resuming client learns the file changed (board #305). `OPTIONS` on `/dl` is the CORS preflight a Tauri page sends for `If-Range`: 204, `Allow-Methods: GET`, `Allow-Headers: Range, If-Range`, `Allow-Private-Network: true` (a Chromium webview's Private Network Access asks in the same preflight), no signature check, no file access. A 416 also carries CORS headers, so a cross-origin client can read its `Content-Range`. HMAC-SHA256 over `dl:<path>:<exp>` (download) or `dl:stream:<path>:<exp>` (stream; URL carries `&stream=1`); `exp` is an absolute expiry: 60 s after minting for a download, 4 h with `stream: true` (a `<video>` re-requests the URL for the whole playback). `stream: true` is refused (invalid params, and 403 at `/dl`) unless the path is a video extension. No server-side size limit. |
| `fs_upload` | `path`, `data` | OK |
| `fs_convert` | `path`, `format?` | `{html}` (currently only pptx→html) |

### Git
| Method | Params | Response |
|--------|--------|----------|
| `git` | `subcmd`, `args[]`, `cwd?` | `{stdout, stderr, code}` |

Whitelisted subcmds: status, diff, log, show, branch, rev-parse, push, add, commit, restore.
Shell metacharacters rejected in args.

### Config / Preferences
| Method | Params | Response |
|--------|--------|----------|
| `set_socket` | `socket` | OK |
| `get_bookmarks` | — | `{bookmarks}` array |
| `save_bookmarks` | `bookmarks` | OK |
| `get_prefs` | — | Preferences JSON |
| `set_pref` | `key`, `value` | OK |

### Agent hooks (agent lifecycle telemetry)
The `agent_notifications_list` / `agent_notifications_mark_read` unread-inbox
RPCs and the `agent_notification` push retired 2026-09-01 with the old
notification-dot UI: the project room's auto-post + read cursor and the derived
status dots are the one notification language. The `agent_hooks_status` /
`agent_hooks_install` / `agent_hooks_remove` management RPCs retired
2026-09-20 (board #222): managed agents carry their hooks in the isolated
home's rendered config, so there was nothing left for a client to manage. The
hooks themselves remain — they feed telemetry, status derivation and the
auto-post. All of the retired methods answer METHOD_NOT_FOUND.

### Projects (desktop-only — method-not-found on servers without `state.db`)
A project is a workspace declaration; the tmux session is its projection. The
Projects section hides itself when these return -32601. See
[`docs/design-docs/features/projects.md`](../../design-docs/features/projects.md).

| Method | Params | Response |
|--------|--------|----------|
| `project_list` | `include_archived?` | `{projects: [{project, slots, live}]}` — the client subtracts these from `list_sessions` to get the untracked ones |
| `project_create` | `path`, `name?`, `session?`, `agent?` | The project (existing one for that path is returned, un-archived). `agent` seeds one settled agent window (`kiro`/`claude`/`codex`) |
| `project_adopt` | `session`, `name?` | `{project, slots}` — takes a live session's windows as the declaration |
| `project_up` | `id` | `{session, created_session, slots: [{window_name, status, error?}]}` |
| `project_down` | `id` | `{session, live: false}` — kills the session, keeps the declaration |
| `project_archive` | `id`, `archived?` | Hides/unhides without deleting |
| `project_rename` | `id`, `name` | `{id, name, session, session_renamed}` — renames the tmux session to `slug(name)` too. The chat room is recorded on the project so it does NOT move, the Board rows move transactionally to the new session key, and the previous session name stays reserved/resolving for agents already running with `TMM_PROJECT` (another project cannot reuse the alias) |
| `project_autostart` | `id`, `autostart?` | Flag only; no boot integration yet |
| `project_delete` | `id` | Forgets the project (slots cascade), closes the session, deletes `<path>/.tmm/agents/*` and its Board issues/note threads — the chat room and the user's files survive. Reached in the UI only through the recycle bin |
| `models_list` | `backend?` (default: the first entry of `backends_list`) | `{backend, models}` — model ids the backend accepts, asked of its own CLI (cached). `models` is `null` when it cannot be enumerated (claude, or codex without a `model_catalog_json` in the user's config), and the agent editor keeps free text |
| `backends_list` | — (no session, no gate: answered by every server, phone-hosted included) | `{backends: [{name, icon, color, efforts, input_modes, default_input_mode, input_mode_toggle}]}` — the backends this server can spawn, in canonical order (first = the default an absent `backend` means). `icon` is the avatar path (`/assets/<name>.svg`), `color` the colour token NAME (`--backend-<name>`, values live in the client's app.css), `efforts` the reasoning levels the CLI accepts, `input_modes` whether a definition may choose `queue`/`steer` (board #245; absent on older servers = no choice), `default_input_mode` the mode a NEW definition on it starts in (board #336: `steer` on kiro, `queue` elsewhere; absent on older servers = `queue`), `input_mode_toggle` whether a RUNNING session can switch it (board #271: kiro's Ctrl+S; absent = no switch). The client keeps NO list of its own (source test `core/backends.source.test.ts`); on a pre-#130 server (method-not-found) it falls back to a frozen copy of this shape |

### Project Hub (desktop-only — the `tmm` CLI's surface)
One chat room per project on the bus (`proj:<session>`), agent status
declarations, derived agent states. Consumed by the `tmm` CLI (agents and
humans) and the desktop hub UI. See
[`docs/design-docs/features/tmm-cli.md`](../../design-docs/features/tmm-cli.md).

| Method | Params | Response |
|--------|--------|----------|
| `hub_post` | `session`, `body`, `from?` (default `human`), `status?`, `requires_reply?` | The stored message; `status=true` wraps the body as ambient `[tmm status working]` and never delivers mentions |
| `hub_log` | `session`, `since_ts?` (exclusive, epoch ms), `limit?` (default 100, cap 1000 PER PAGE — not a history horizon), `before_seq?` (exclusive; the page STRICTLY OLDER than that log position — 0/absent = the newest page), `around_seq?` (board #322: the page of THIS room around one of its messages — `limit/2` rows from it on, the rest before it; wins over `before_seq`/`since_ts` and adds `newer_more`: newer rows exist, so the page is not the tail) | `{messages: […], has_more, head_seq, oldest_seq?}` — oldest first; archived messages are filtered out. Nothing is ever pruned from a room, so `before_seq` = `oldest_seq` of the page you hold is the lazy-load step backwards. `has_more` is measured (the store is asked for one row more), so "that is the whole conversation" is distinguishable from "your page ended exactly at the limit". `oldest_seq` is the cursor for the next page back: a SURVIVING row's seq when the page has one, else the RAW page's oldest seq — a page can lose every row to the archive/`since_ts` filters, and `has_more: true` with no cursor would stop scroll-up dead at a hidden run. `seq` is globally monotonic across ALL rooms (one AUTOINCREMENT log), so gaps inside one room's sequence are normal — treat it as an opaque cursor, never as a count of what is missing. On a `since_ts` query `has_more` changes meaning: true iff rows NEWER than `since_ts` remain behind this page (the raw page did not reach back to the cursor) — the client then walks `before_seq` pages until one does, so a room that gained more than a page while unwatched has no hole (2026-09-03) |
| `hub_rooms` | — (the one hub method with no `session`) | `{rooms: {"<room>": ts_ms}}` — newest message per room, one grouped query; orders the project sidebar by conversation |
| `hub_unread` | `{rooms: {"<room>": {seq} \| {ts}}}` — the reader's watermark per room (last read seq, or a legacy ts); no `session`, like `hub_rooms` | `{rooms: {"<room>": {count, first_seq, last_seq}}}` — every row above the watermark is read, then the ONE news rule (`rooms::news_kind`, TS twin `newsKind`, shared case table) keeps replies, status notes and finished lines (a board move to review/done, `[tmm done]`) and drops own words and other narration; archived rows excluded; a room with none is ABSENT. At most 256 rooms per call (board #322). The watermark is the LATER of the server's read mark (`hub_read`) and the client's (a legacy ts mark resolved to the room's seq first); a client mark past the room's newest seq/ts is impossible and dropped at the door. The answer also carries `marks: {"<room>": {seq, ts}}` — the PERSISTED server mark of every asked room that has one, never the effective max (board #334) |
| `hub_read` | `{rooms: {"<room>": {seq} \| {ts}}}` — the human read these rooms; no `session` | `{rooms: {"<room>": {seq, ts}}}` — the persisted marks, the client's ACK. The server resolves each mark to a real message (a seq clamped to the room's newest, a legacy ts to the newest message at or before it; the stored ts is that message's) and only moves it forward. A room with no messages, or an empty mark, writes nothing and is absent. Bootstrap: the v31 migration seeded every room that already had messages read to its head; a room born after the upgrade has no mark until a client reads it, so all its messages count. One mark per room per server (one human reader); `tmm` never calls it. At most 256 rooms (board #334) |
| `hub_search` | `session`, `grep[]` (non-empty term list; any-match, substring, ASCII-case-insensitive, against body AND sender), `global?` (bool: search EVERY room, not just this project's — `session` is still required, it names the caller), `limit?` (default 50, cap 500) | `{messages: […]}` — the newest `limit` hits, oldest first; each message carries its `room`, which is what makes a `global` answer readable. Archived messages are filtered out per room, same one-way mirror as `hub_log`. `hub_log` pages, this FINDS — no cursors, a narrower `grep` is how you dig deeper |
| `hub_msg_archive` | `session`, `ids[]` | `{archived: n}` — HIDES messages (they stay in the room's store — state.db `hub_msgs` — so `hub_log` filters them out on the way). Reversible, so no confirmation. Bodies are looked up by exact id, so a message the user scrolled back to is as archivable as a fresh one |
| `hub_msg_restore` | `session`, `ids[]` | `{restored: n}` — take them back out of the archive |
| `hub_msg_purge` | `session`, `ids[]` | `{deleted: n}` — forgets them for good: deletes from `hub_msgs` first, then drops the archive rows |
| `hub_archive` | `session` | `{messages: [{id, ts, from, body, archived_at}]}` — what is hidden, newest first; each row carries its own copy of the message |
| `hub_command` | `session`, `agent` (window name or `all`), `text` (must start with `/`), `from?` (the sending agent, `tmm send`; absent = `human`, the composer — board #274: the room line is posted under it, `all` skips it, and `agent == from` is refused) | `{sent: [names], command}` — types the text VERBATIM into the managed agent's pane (no stamp, no sender): slash commands are read by the CLI, not the model. Where the backend declares the command's prompt-hook echo, a receipt row carrying the room line's id is recorded first, so that echo marks the command delivered (board #264). Recorded in the room as a `[tmm] ` lifecycle line |
| `hub_agents` | `session` | `{agents: [{window, name, command, agent, managed, team, joined, state, detail, since, vitals, input_mode, wake}]}` — `vitals` is `{model, context_pct, effort, branch}` SNIFFED from the last lines of a managed agent's pane (a CLI's live state has no API): every field may be null, and `vitals` itself is null when nothing could be read. `wake` is the soonest pending wake whose body addresses this agent (`@name` or `@all`), `{due_at, from, more}`, else null (board #275). `joined` is true for a managed agent in `team` by a runtime join or move (board #382/#384: a team restart leaves it, a team stop stops it; false for a member its team's definition places). `input_mode` is `queue`/`steer`, the mode the session RUNS (board #271: read off the pane, else its last reading in the same pane, else the launch recipe's start mode); null for a backend without the choice or an unmanaged window |
| `hub_wake_add` | `session`, `body`, `due` (unix seconds), `from?` (absent = `human`) | the stored wake `{id, session, sender, body, due_at, created_at}` — schedules `body` to be posted as `from` at `due` and delivered like a line sent then, prefixed `[wake] ` (board #275). Refused (invalid params): no `@` recipient, a `/command`, `due` already past or more than 7 days ahead, 50 already pending in the project |
| `hub_wake_list` | `session`, `all?` | `{wakes: [wake]}` — pending, soonest first; `all` = every project's |
| `hub_wake_cancel` | `session`, `id`, `by?` (absent = `human`) | `{id, cancelled: true}` — only the wake's scheduler or `human`; a wake of another project, or one already fired, is not found |
| `hub_activity` | `session`, `since_ts?`, `limit?` (default 600, hard cap 1000 PER PAGE — not a history horizon), `before_ts?` + `before_id?` (exclusive cursor; the page strictly OLDER than it) | `{events: […], has_more, oldest: {ts, id}?, total, first_ts}` — oldest first; durable telemetry rows (tool calls, prompts, receipts, warns) the feed folds into tool lanes. The log is COMPLETE (nothing is pruned), so the read is the bounded half: pass `oldest` straight back as `before_ts`/`before_id` to walk as far back as the log goes. The cursor needs BOTH halves — a busy turn writes several events inside one millisecond; `before_id` omitted means "older than that whole millisecond" (always progresses, may skip same-ms siblings). `total`/`first_ts` describe what the server holds, for a "N of M loaded" affordance. A `prompt` event carries `via: app|local`. Since v24 (board #249) `prompt` and `warn` events carry `deliveries?: {id, msg?}[]` — the delivery rows the echo settled or the warn reported, `id` the row (the one correlation key), `msg` the chat message it carries where one exists; absent when none. A warn whose row a later echo names is retracted by the client |
| `hub_spawn` | `session`, `agent` (registry name), `brief?`, `by?` (spawning agent, empty = human), `join?` (a team present in this project, board #382: one with a member home here, live or stopped) | `{window_name, pane, backend, team}` — materializes an isolated home and opens the session if needed; the stamped first prompt names `by`, establishing the final-reply edge. With `join` the agent is put in that team at runtime (recipe `team`, no `member`; the team's definition is unchanged), its prompt carries the team block, the room line is `spawned x — joined team t`, and each CURRENT member of that team (a live managed window in it, not the joiner, not a solo agent or another team's member) is typed one `[tmm chat <stamp>] tmm: [reply] @x joined your team t: …` notice, which asks nothing; a team with no member here is refused by name before any window. A client sends `join` only when the login announced `spawn_join`. `team` is the joined team or null |
| `hub_agent_interrupt` | `session`, `agent` | `{ok}` — resets the derived state FIRST (`record_interrupt`), then types the named `Escape` key into the pane; posts `[tmm] interrupted <name>` |
| `hub_agent_set_team` | `session`, `agent`, `team` (a team present in this project, or `""` to leave), `by?` (the calling agent, empty = human) | `{agent, team, left, changed}` — moves a RUNNING managed agent between teams at runtime (board #384; the Hub's card drag and Move/Leave items, `tmm agent team`): only the recipe's `team` changes (written whole, then renamed into place); the team's definition is never edited, the running CLI is neither rewritten nor restarted, and its prompt follows at its next start. `changed: false`, no line and no notice when it is already there. Otherwise one room line, `[tmm] moved x — to team t[, from team l]` or `[tmm] left x — team l, now standalone`, and three `[reply]` notices that ask nothing: to the moved agent (its teammates, and that its prompt changes at its next start), to the new team's current live members (`@x joined your team t: a <backend> agent moved in by <by>; …`), to the old team's (`@x left your team l; …`). Two moves of one agent are told in the order they committed, and a move overtaken by a newer one before it is told says nothing (the recipe's `team_rev`). `team` / `left` are roots or null. Invalid params: an agent this app did not start, a member its team's DEFINITION places ("change it in Agents > Teams"), a team with no member home here. A client sends it only when the login announced `agent_team` |
| `hub_agent_input_mode` | `session`, `agent`, `mode` (`queue`\|`steer`) | `{agent, mode, changed}` — switches a running session's mode for THIS session with the CLI's live toggle (board #271; kiro's named key `C-s`), under the window's delivery lock (the one a delivery reads the mode under) and then the pane's send lock: `changed: false` and nothing typed when it already runs `mode`; otherwise one key, then success only once the pane shows `mode` (else an internal error, no second key). Posts `[tmm] switched <agent> — <mode> mode (this session)` when it changed (verb `switched` in the feed's one lifecycle grammar). The registry, `launch.json` and the CLI's config are untouched; a restart starts from the configured mode. Invalid params: a mode other than queue/steer, an agent this app did not start, a backend without a live switch |
| `hub_agent_stop` | `session`, `agent` | `{stopped}` — kills the window, keeps the slot (a stopped agent restarts via restart, or via `project_up` with the rest of the workspace) |
| `hub_agent_restart` | `session`, `agent` | `{restarted, resumed}` — refreshes the agent's materials, then replays the launch recipe of THIS slot only (full identity: env, `--agent`, model in config) and resumes its recorded conversation; other stopped agents in the project are not touched (#210). `resumed: false` = the slot was not restorable and a fresh resume spawn ran instead |
| `hub_agent_remove` | `session`, `agent` | `{ok}` — ejects: kills the window, DROPS the slot, deletes the isolated home; refuses only when nothing of the agent is left |
| `hub_board_list` | `session` | `{issues: […], statuses}` — the project task board, four fixed columns (`todo/doing/review/done`); each issue carries a note COUNT. Public `id`/`#N` is a session-local sequence: every project's first issue is `#1`, deletes leave gaps, and numbers are never reused. Every single-issue operation resolves `session + id`; the database-wide row key remains internal for note FKs only |
| `hub_board_counts` | — (no `session`, like `hub_rooms`) | `{counts: {"<session>": {todo, doing, review, done, total}}}` — issue counts for EVERY board in one grouped read; the four statuses are zero-filled server-side, `total` is explicit, and a project with an empty board is ABSENT (absence = hide) |
| `hub_board_get` | `session`, `id` | The issue with its full `notes` thread and server-computed `editable` (`true` only while unassigned and before any Agent save/note activity) |
| `hub_board_save` | `session`, `id?`, `title?`, `body?`, `status?`, `assignee?`, `dispatch?`, `who?` | Create (no id) or PATCH (id + only the changed fields — COALESCE, so a `move` cannot erase a body edited meanwhile). Once assigned or touched by an Agent, title/body are immutable server-side; workflow fields remain patchable. `assignee` is `""` (clear), `human`, or ONE valid agent name — anything else (`all`, `dev @all`, whitespace) is `-32602` with nothing saved. `dispatch: true` (sent only by clients that read `board_dispatch` in the login answer) also hands the issue to the assignee: the brief goes to a managed agent of THIS project, once per save that names one (not the actor, not `human`). Without the flag nothing is posted (an older client posts its own brief). `{ok, id}`, plus `dispatch: "sent" \| "offline" \| "failed"` when a hand-off was asked and there was somebody to tell (`sent`: posted, and a live pane was found for the name — not proof it was typed), `dispatch_error` with `offline`/`failed`, and `offline` (as `hub_post`'s) when no pane received it. The save is committed BEFORE the telling, and everything after the commit (the read-back, the brief, the post) is part of the answer: `failed` is an answer, never an error, and the id always comes back |
| `hub_board_note` | `session`, `id`, `body`, `who?` | Appends to the issue's own thread, bumps `updated_at` |
| `hub_board_delete` | `session`, `id` | `{ok}` — deletes the issue and cascades its notes |

### Registry, skills & MCP defs (desktop-only)
Central definitions that `spawn` materializes into isolated agent homes. The
skill store is app-owned files under `<state dir>/skills/<name>/`; three
built-ins (`tmm-cli`, `mem`, `mcp-cli`) ship inside the binary and reseed at
server start (`source = "builtin"`; save/delete refuse their names).

| Method | Params | Response |
|--------|--------|----------|
| `registry_list` | — | `{agents: [{name, backend, model, effort, input_mode, system, skills, mcp}]}` (the `can_hire` flag was retired 2026-09-26; `input_mode` is `queue`\|`steer`, v25) |
| `registry_save` | `def` | Validates backend, model id (against the backend's own CLI), effort enum and `input_mode` (absent or null: an existing row keeps its stored mode, a NEW one gets the backend's `default_input_mode`, board #336; `steer` only where `backends_list` says `input_modes`). `teams_save` treats a bare member's inline agent without `input_mode` the same way (a null there is refused, as before), matched by member name against the stored team; an existing member stored without a mode is left so (queue) |
| `registry_delete` | `name` | OK |
| `global_prompt_get` | — | `{text, path, max_bytes}` — the app-wide agent instructions (`<config>/AGENTS.md`), prepended to every managed agent's system prompt at spawn |
| `global_prompt_set` | `text` | `{ok, bytes}`; empty text deletes the file; > 24 KB rejected |
| `skills_list` | — | `{skills: [{name, source, description, synced_at}]}` |
| `skills_save` | `name`, `source`, `description?` | Imports/re-syncs the files from `source` (abs dir, github url, or `builtin`) |
| `skills_import` | `url` (or abs dir) | `{imported: [names]}` — walks the fetched tree for EVERY dir holding a SKILL.md (claude plugins/marketplaces work as-is); each row's source points at its own subdir; frontmatter names, built-in names skipped |
| `skills_read` | `name` | `{markdown}` — the managed SKILL.md |
| `skills_files` | `name` | `{files: [{path, size}]}` — every managed file of the skill |
| `skills_file` | `name`, `path` | `{content}` — 256 KB cap, text only, path escapes rejected |
| `skills_refresh` | `name` | Re-syncs from the recorded source (builtin = the running build) |
| `skills_delete` | `name` | OK (refused for built-ins) |
| `mcp_list` / `mcp_save` / `mcp_delete` | `name`, `def?` | Central MCP server defs; materialized into each backend's native config at spawn |

### Team (desktop-only — method-not-found on servers without the bus)
All chat operations are scoped to a team `room`; `team_status` / `team_teams`
are team-agnostic. The Team tab hides itself when these return -32601.

| Method | Params | Response |
|--------|--------|----------|
| `team_status` | — | `{available, teams, system_prompt, …}` |
| `team_teams` | — | Team list (room, workspace, agents) |
| `team_start_team` | `workspace`, `template?` | Starts a team for the workspace; returns its descriptor |
| `team_close_team` | `room` | OK |
| `team_history` | `room`, `limit?` | Message history |
| `team_roster` | `room` | Live roster with agent states |
| `team_employees` | `room` | Desired-roster employee list |
| `team_post` | `room`, `body`, `requires_reply?` | Posts a chat message as the human |
| `team_templates` | — | Named roster templates |
| `team_template_save` | `name`, `def` | OK |
| `team_template_delete` | `name` | OK |
| `team_system_prompt_save` | `text` | OK |

## Server Push Messages
| Method | Params | Description |
|--------|--------|-------------|
| `pane_output` | `target`, `content?`, `cursor`, `current_command?`, `agent?` | Pushed on content/cursor change; `current_command` appears on the first push and when the command changes, and `agent` (the pane's backend name as in `list_panes`, `null` for none) appears with it |
| `pane_closed` | `target` | Pushed when pane becomes unreachable (after repeated capture failures) |
| `team_message` | `room`, `message` | New group-chat message in a team room |

Cursor object: `{x, y, w, h, t}` (x/y position, width, height, trailing trimmed lines).
Content is omitted when only cursor position changed.

## Error Format
```json
{"error": {"code": -1, "message": "description"}}
```

The `message` is the server's ONE sentence for the human and may be
translated or reworded; a client that needs to act on a particular failure
keys on the CODE, never on the text (board #337). An error may also carry
`data`, the facts needed to ACT on it rather than only show it — today only
`-32010` does; `-32011` deliberately does not, because the fact it would
carry has one source and copying it is how a snapshot goes stale twice.

| Code | Name | Meaning |
|---|---|---|
| `-32700` | parse error | the frame was not JSON we could read |
| `-32601` | method not found | unknown method, or one this build does not serve (a phone build answers this for every desktop-only method, which is how the client probes for the projects/hub features) |
| `-32602` | invalid params | a required parameter is missing or the wrong type |
| `-32603` | internal error | the operation failed; `message` carries the reason |
| `-32000` | auth required | the connection has not authenticated, or the token was refused |
| `-32010` | scratch name held | `scratch_session` refused because a PROJECT holds the scratch terminal's reserved session name. The one refusal a client can act on, and the only one with `data`: `{projectId, projectName, session}` identifies the holder, so the confirmation names it and `scratch_release` can only touch that project. The panel keys on this code alone, so its copy and its action cannot drift apart (board #337) |
| `-32011` | scratch snapshot stale | `scratch_release` refused because the state the reader confirmed from has moved on — the project they approved is not the holder any more, it has been deleted, or the expectation the write itself carries no longer holds — and nothing was renamed. The panel RECOVERS rather than showing it: the snapshot is dropped and `scratch_session` is asked once, since that is the one path that says who holds the name now (free → it opens; still held → a fresh `-32010` names the current holder and offers the action again). No `data`, for that reason: a holder copied onto this error could be stale again by the time it was used (board #337) |
