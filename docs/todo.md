# TODO: Gaps Against the Tenets

> Draft · 2026-09-09. This document is the ONE entry point for open problems
> and remaining work, not decisions. Decisions belong in `tenet.md`; rules
> belong in `guidance/`. (`docs/unresolved.md` was folded in here on
> 2026-09-09, board #104 — its resolved entries live on in the design docs'
> dated rules and in git history.)
> Priorities: **P0** implementation violates an established tenet;
> **P1** correctness/security; **P2** quality debt; **P3** recorded limitations.

---

## A. Implementing the Tenets (P0)

- [x] **Delete the desktop Team / agora bus completely** (owner, 2026-09-09;
  board #100/#107 completed 2026-09-09). Prerequisite moves went to
  `projects/backends/shared.rs` and `projects/skills.rs`. Hub messages moved
  into state.db `hub_msgs` through `projects/rooms.rs`, including a one-time
  proj:* history import. The agora crate, `src-tauri/src/team/`,
  `team_bridge.rs`, `server/team_rpc.rs`, `src/lib/team/`, `team/` and
  `TEAM_*` configuration were removed. Documents such as `team.md` were
  archived in `exec-plans/`.
- [x] **Consolidate backend knowledge** (board #101, #127–#131, completed
  2026-09-09): `enum Backend` in `src-tauri/src/backends/mod.rs`, one file per
  backend holding detection row, resume syntax, rendering, hooks, payload
  reading, effort values, models and status-line sniff; `materialize`/
  `refresh_hooks`/`normalize`/`resume_command` dispatch through the enum; the
  client reads the backend list and resource names from `backends_list`
  (#130). Two source tests reject backend literals outside `backends/` and
  hand-written backend arrays on the client (exemptions: tests, the fenced
  seed region, `// backend-quirk(measured):` markers). Rules and reasons:
  agents-overview.md § "Backend knowledge lives in one file per backend".
- [x] **Shorten `tmm-cli.md`** (owner: "太长了不对"; board #102, completed
  2026-09-09): 2337 to about 340 lines. The command reference fits one screen.
  Redundant narrative was removed; condensed rules already live in their
  design documents. Unique material moved: board #30/#31 rules to `board.md`;
  configuration drift, grok, claude-Bedrock and backend parity to
  `agents-overview.md`; board #9's read contract, drawer switcher and project
  header to `hub-feed.md`; user vocabulary to `design-language.md`.
  Every existing command passed the tenet 6 audit; see `tmm-cli.md`,
  "What this is".
- [x] **English documentation** (verified 2026-09-27, board #244): `tenet.md`
  is the English edition, every `guidance/*.md` is English and this document
  is English. The #103 decision stands: maintain English without new `.zh.md`
  copies, retaining owner quotes in Chinese.
- [x] **Entry-point map** (verified 2026-09-27, board #244): CLAUDE.md's
  ownership boundaries and documentation map point to `tenet.md` and
  `guidance/`; the app-wide `<config>/AGENTS.md` (projects/global_prompt.rs)
  sends Teammux work to the Zen section of `tenet.md`, describing process
  only (tenet 11).
- [x] **Consolidate `docs/unresolved.md` and this document** (board #104,
  2026-09-09): unresolved.md's surviving details are folded into the matching
  items here and the file is gone; resolved and deleted-feature entries were
  dropped (their record is the design docs' dated rules and git history).
- [x] **Review process** (board #105, 2026-09-10): defined in
  `guidance/process.md` §5 — one reviewer per guidance lens (architecture,
  agent bridge, code quality, UI/interaction, security, process), each
  reading commits against that lens's checklist and posting findings as
  board notes; the verdict goes on the issue.

## B. Correctness (P1)

- [x] Registry definition edits reach every already-spawned agent on restart
  (board #113, 2026-09-09): provenance lives in `launch.json` (`agent_def` /
  `team`+`member` — the recipe is the declaration, no slots column), and
  `refresh_agent` resolves the CURRENT def through it, so uniquified windows
  and team members re-materialize too; a deleted def degrades soft.
- [x] `is_managed_in` no longer re-arms merely because kiro recreates the
  `KIRO_HOME` subtree after `agent_remove`. It now requires `launch.json`
  or a pre-recipe `agents/<name>.json` (board #112, 2026-09-09).
- [ ] Extract Terminal's embedded gesture decisions and controller
  (#138 plan, 2026-09-09). #139 characterized the real terminal; #140-#142
  extracted selection decisions, geometry and motion with unit coverage.
  #148 moves the controller behind the approved 18 Root + 6 environment
  operations, with clock-driven transition tests and jsdom event fixtures;
  Terminal.svelte is now 2269 lines (2664 at the plan baseline).
  Selection/render/keyboard/visibility ownership and listener installation
  remain in Root. Still open: the owner Android pass against the candidate
  APK. Chromium is not IME or finger-behavior proof; do not check this item
  merely because the off-device tests pass.
- [x] #108: a bounded stateful filter covers fragmented/coalesced `onData`
  replies. The source of the original `?62;22;52c` report still requires
  measurement: installed xterm.js 6.0.0 emits DA1 as ONE complete callback
  even for fragmented queries, so the old "naturally split replies"
  attribution was an unverified hypothesis — if the text recurs, capture the
  `onData` payloads and pane output first; never strip bare printable
  `?62;22;52c` on assumption (see terminal-rendering.md § xterm DA filtering).
- [x] #109: full snapshots restore history. The false-tail event, lost news
  flag and repeated redraw caused by synchronous `clear()` are fixed by
  in-frame `CSI 3J`.
- [x] Telemetry keyed by window INDEX (board #120, 2026-09-09): every store
  (turn edges, deliveries, activity, vitals, recovery) now keys on the window
  NAME, resolved once at ingest (`resolve_pane_id` returns `#{window_name}`);
  state.db v20 migrates readable; the rename-between-hook-and-consume post
  loss went with the index → name round-trip. Identical-body receipts and
  delivery backpressure followed (board #122, 2026-09-09: duplicates are
  distinct promises settled count-wise per echo, v21; one mutex per pane
  target inside `send_command` serializes bursts). `SPAWN_CAP` counts managed
  agents only since board #126 (2026-09-09) — the cluster is closed.
- [ ] Backend parity, blocked on measurement rather than effort: claude's
  `/` palette is not transcribed (mechanical once captured — transcribe the
  popup with pinned captures like codex's); claude/codex/grok have no
  auto-continue (their transient-error paints are uncaptured, and a guessed
  pattern would type `continue` into a working agent — capture each verbatim
  into a test first); codex has no StopFailure hook event (binary checked),
  so a codex `failed` state has nothing to wire until the CLI grows one.
- [ ] Smoke-test CSP on a real device with Markdown, PDF, Mermaid and Hub.
  Browser/PWA responses have no CSP header.
- [ ] The Android signing key was in git history before 60992d4 and has not
  been rotated, by owner decision. Keep this recorded.
- [ ] Isolate the flaky `adopt_then_down_then_up_restores_the_workspace` test
  on its own tmux socket (`-S`): `pick_workspace` votes over ALL windows and
  the test's two windows have no majority, so anything another test leaves in
  the shared tmux can tip which directory wins (seen once, 2026-08-05).
- [x] One shell quoter (board #125, 2026-09-09): `src/shell.rs` is a leaf
  module with one escaping core and two documented forms — `quote_always`
  (the hook-file byte-pinned form; a managed home's hooks diffed
  byte-identical before/after) and `quote` (on-demand, the narrow safe set;
  the old tasks `,@+` bare-passthrough bought nothing its tests exercised).
  Every call site names it directly (board #144, 2026-09-09: the three alias
  names and their duplicate tests are gone; the union table is the one test).
- [x] `auto_adopt_with` invokes tmux while holding the store lock (board
  #149, 2026-09-09; measured: an adopt held the lock 90 ms — two pane
  listings — and a concurrent store RPC waited 84 ms; `list()` ran one
  `has-session` (~9 ms) per project under the lock on every project_list).
  The tmux half of an adoption is `adopt_facts`, read with no lock; the row
  half re-checks "already tracked" under the lock (0.4 ms). `list()` reads
  rows under the lock and probes tmux outside. A source test rejects any
  `with_store` closure in `projects/*.rs` that names `tmux::`; `rename`
  is the one marked exception (session rename and row re-key under one lock).
- [x] `with_store`'s first-use init was not race-safe (board #150, 2026-09-09):
  two first callers both opened and migrated the same file. The cold path is
  now serialised (`open_once`: init lock + re-read), one open per process, a
  failed open still not cached; red-then-green test with two racing threads.
- [x] The `@all` recipient is restored by `pickLead` (board #171, 2026-09-11,
  `hub.test.ts` pins the saved broadcast choice surviving roster changes), and
  `hub_log` composes `since_ts` with `before_seq` paging since the state.db
  rooms rewrite (board #107, 2026-09-09) — the page is filtered to newer than
  the cursor, never the cursor dropped.
- [x] Vitals and pane inspection policy is **decided** (owner, 2026-09-09):
  observing screens that people can also read is permitted. `statusLine`
  changes display, not agent behavior, and is allowed. The remaining work —
  moving backend-specific inspection into the backend files — closed with
  section A's second item (`sniff_*` lives in `src-tauri/src/backends/`,
  dispatched through `Backend::sniff`).

## C. Quality Debt (P2)

- [x] Hub decomposition (#114 family, through #136, 2026-09-09):
  `Hub.svelte` is 1872 lines, down from the measured 4577-line starting point.
  Sidebar, Roster, Composer, Feed and Drawer own their views; pure reading,
  composer and history decisions are tested modules. Back uses the original
  fixed-priority registry, not a chronological stack. Room/transport/cache,
  shared state/preferences, routing, action authority and the small
  spawn-coupled picker remain in Hub.
- [ ] Oversized files. Done: `store.rs` 3469 → `store/` with a 193-line hub
  and one `impl Store` file per table family (board #147, 2026-09-09; a
  source test keeps the hub to open/open_memory/init/heal); spawn `render_*`
  and the vitals dialects moved into the backend files (board #128/#127).
  `projects/mod.rs` 2379 → a 200-line facade with seven family files (board
  #152, 2026-09-09; guard: only the store handle and id helpers may live in
  mod.rs). Open: `bin/tmm.rs` 1362 (2026-09-27).
- [ ] The `hub_rpc.rs` match mixes dispatch, delivery and board notification
  policy. (The boilerplate half closed with board #146, 2026-09-09: both
  dispatchers are `?`-returning inner fns over `RpcError`, ~90 `match →
  Response::err` sites collapsed, every wire code and message byte-identical
  and pinned by `server::golden_errors`. The policy-mixing half — delivery
  and board-notice decisions living inside arms — is still open.)
- [x] `Store::hub_search` matches in SQL (board #124, 2026-09-09): `LIKE` with
  `%`/`_`/`\` escaped, ASCII `lower()` on both sides (identical to the old
  `to_ascii_lowercase` — SQLite `lower()` is ASCII-only without ICU), limit in
  SQL. Measured at 50k rows: the no-hit full scan fell 34.5 ms → 18.8 ms (row
  materialization eliminated); dense-hit pages unchanged (~0.3–1 ms). An
  unanchored substring can never use an index — FTS stays the next step if
  rooms outgrow this.
- [x] #110: Files navigation history/Back decisions moved into `file-nav.ts`;
  preview body/CSS and renderers moved into `FilePreview.svelte` /
  `file-preview.ts`, preserving behavior.
- [ ] Follow up #110: move renderer state down into `FilePreview` so the host
  passes only the file and callbacks, instead of binding `showAllLines` and four DOM references.
- [ ] Consolidate duplicate Markdown CSS into `ui/MarkdownBody`.
  #110 only moved existing styles, without cross-page unification.
- [ ] `ws.ts` is a module-level singleton with ten top-level `let` variables,
  blocking two connections in split-screen mode.
- [ ] Test gaps (refreshed 2026-09-27): the `bin/tmm.rs` tests still exercise
  only flags and CLI-surface formatting; `server/connection.rs` has no tests,
  as do `Projects`, `GitPanel` and `ui/Select`. (`fs.rs` moved to
  `src-tauri/src/fs.rs` with a test, `server/mod.rs` has one, and
  AgentsPage/Preferences/Settings gained source/mount tests.) Some source
  tests pin implementation text.
- [x] `list_panes` runs a full `ps -axo` every time (board #145, measured
  2026-09-09 on a 521-process host: `ps` 29 ms of `list_panes`' 41 ms; tmux
  itself 3 ms). The capture tick was the consumer that mattered — `observe`
  + `recovery::check_once` = 2 × live projects `ps` per 20 s (14 here, ≈0.4 s)
  — and it now runs under `tmux::with_process_snapshot`, one `ps` per tick,
  every later listing 6 ms; the readings were already treated as one moment
  in time, so no verdict changes. A `hub_post`'s two calls are two dispatches
  (server `deliver_mentions` + the client's `hub_agents` refresh), left as
  they are: a time-based cache would give a freshly launched CLI a window of
  reading as a plain shell. `child_cmd` stays a detection clue everywhere.
- [ ] Structural clippy findings (deferred 2026-07-22; fixing them changes
  signatures, which the mechanical-move discipline forbade in that pass).
  Done: `handle_connection`(9) / `handle_connection_ws`(11) take a
  `ConnContext` built once at the accept site (board #151, 2026-09-09;
  too_many_arguments 7 → 5); `write_launch_recipe`(8) → `LaunchRecipe`, whose
  fields are launch.json's keys, one writer, three recipe shapes diffed
  byte-identical (board #153; 5 → 4 — the rest are store row inserts). Open: `Outbound::InitCipher` is ~700 bytes vs
  24 for `Plain` (large_enum_variant) — boxing is trivial but touches the hot
  send funnel, so do it with a connection-path regression run, not blind.
- [x] Frontend backend lists (board #130): the per-component `BACKENDS`
  tables and the implicit `?? 'kiro'` defaults are gone; `core/agents.ts`
  reads the server's `backends_list` once per connection and keeps only a
  frozen fallback for pre-#130 servers.
- [x] Arbitrary absolute paths in `fs_*`/`/dl` and git push/commit in the
  allowlist are deliberate — documented as such in `guidance/security.md`
  rule 5 ("document deliberately broad capabilities … the allowlist must not
  imply restrictions it does not enforce").
- [ ] npm is aliased to pnpm and `package-lock.json` is stale;
  inspect `npm_config_user_agent` during preflight.
- [ ] Files Markdown escapes inline HTML, turning README badges into text.
  Accept this cost of one safe renderer or design an allowlist.

## D. Five-Backend Inventory

For section A's second item; recorded from the code on 2026-09-09.
In this inventory, `backend` was `&str` and the five literals were scattered:

| File | Lines Mentioning Backend Names | Responsibility |
|---|---|---|
| `projects/spawn.rs` | 218 | Five `render_*`, five `*_hooks`, resume syntax, refresh detection |
| `agent_notifications.rs` | 92 | Hook payload normalization (`normalize` + `is_user_prompt_submit`) |
| `projects/agents.rs` | 89 | `KNOWN` detection table including resume strings, `SPAWNABLE_BACKENDS` |
| `projects/vitals.rs` | 83 | Four `sniff_*` functions |
| `projects/store.rs` | 80 | Seed definitions, ordering `CASE WHEN`, default models |
| `projects/models.rs` | 36 | Effort values, model lists |
| `team/backends.rs` | 37 | MCP, launch-script and trust-marker helpers borrowed by `projects/` |
| Frontend `hub.ts`/`core/agents.ts`/`AgentsPage`/`TeamTemplates` | 24+24+11+2 | Icons, colors, command palette, two lists, five defaults |

**Not a problem, per the owner:** the five CLIs genuinely differ in configuration,
hook dialects and status lines. Separate implementations are necessary.
The recorded problems were their scattered ownership. Progress (board #101):
#127 closed 1 and 7 (`enum Backend`, models, sniff dialects), #128 closed 4
and 5 (renderers, hooks, per-backend refresh probes, resume dialects), #129
closed 2 and 3 (hook payload reading and the KNOWN rows live on the backend
files; `src-tauri/src/backends/` is an UNGATED leaf module so the mobile
inbox consumer reads the same dialects), #130 closes 8 (server-published
list), #131 closes 9 by name — the two tmux.rs adaptations stay, marked
`// backend-quirk(measured):` for the literal guard and the reader. Section
closed; kept as the record of what the scattering looked like.

1. No `Backend` type; one backend's knowledge spread across at least twelve
   match/if branches. Adding omp on 2026-09-07 missed `registry_save`.
2. Two tables for the same fact: resume dialects in `agents.rs::KNOWN` and
   `spawn.rs::resume_command`; frontend regexes mirrored the server matcher
   (gone with board #260: the client reads the server's pane `agent`).
3. Each hook contract spans two files: installation in spawn.rs and reading
   in agent_notifications.rs.
4. `refresh_hooks` detects backend-specific paths even though `launch.json`
   records the backend, with an extra kiro backfill case.
5. Five `render_*` functions duplicate the same skeleton: load notification
   center -> helper -> mcp_defs -> prompt file -> hooks -> model/effort ->
   `Rendered`. Three effort-delivery formats are scattered across functions.
6. The recorded `projects/` dependency on the then-to-be-deleted `team/`
   belongs to section A's first item.
7. Pane inspection is legitimate observation (section B), but backend-specific
   `sniff_*` functions belong beside the other backend knowledge.
8. The frontend maintains its own backend lists, icons, colors and command
   palettes (section C).
9. Generic tmux code contains codex's 200ms interval. This measured,
   screen-triggered adaptation is acceptable, but it remains backend
   knowledge in a generic module. (The kiro file-picker detection beside it
   moved to the backend, board #436: deliveries type no `@`
   (`Backend::at_opens_picker`) and only a verbatim `/command` asks
   `Backend::picker_open`.)

## E. Recorded Limitations (P3)

- A line sent to a BUSY claude or omp joins the running turn, so its reply
  can go to the wrong sender (board #245, measured on claude 2.1.283 and omp
  18.2.10). Claude has no queue mode (`chat:queueSubmit` still folds the line
  in at the next tool boundary, one Stop for both senders). omp's follow-up
  binding does queue, but our telemetry extension reports no prompt for a
  follow-up, so the line is swept `unconfirmed` and the Stop replies to the
  first sender. Neither is offered the input-mode choice. The omp half is
  fixable on our side: the extension would have to report follow-ups (its
  `input` event, unverified). See agents-overview.md § The input mode.

- An Escape pressed in a kiro pane (not through the hub) fires no hook
  (kiro-cli 2.22.1), so the window reads `running` until its next turn and
  lines held for it (board #257) wait up to `HOLD_MAX_SECS` (300 s) before
  they are typed anyway. See hub-composer.md § A busy queue-mode agent.

- Hook consumption is at least once (board #404, orchestrator rulings
  2026-10-16): what is promised is that a final reply reaches the ROOM at
  least once, not the requester's pane. A gateway that dies after a Stop's
  end row and before its reply reads the envelope again, and the reread
  recovers the reply edge from a log that already holds that end, so the
  re-posted reply has no recipients. Shared by every backend (pre-existing in
  the shared hook consumer). A possible follow-up: recover who was waiting
  durably (e.g. record the reply edge before the end row). Not filed; a crash
  in that window is rare. See agent-notifications.md § Event Path.

- Emoji width: tmux measures 2 cells, xterm's UnicodeV6 table 1 — a joined
  (`capture -J`) line with emoji can re-wrap differently and shear pane rows.
  Fix = `@xterm/addon-unicode11` AND the same table in
  `terminal/cursor-layout.ts` `cellWidth`; verify against tmux's wcwidth first.
- Bookmarks/recents are cross-client last-writer-wins: the client guards its
  own races (generation counter, see file-browser.md), but phone + desktop
  writing from parallel snapshots still clobber each other. Deeper fix:
  server-side add/remove RPCs (`bookmark_toggle`, `fs_add_recent`) or merge
  semantics in `set_prefs`, after which the client guards go.
- iOS target: not implemented (Xcode + xcodegen + Apple Developer account;
  `rustup target add aarch64-apple-ios aarch64-apple-ios-sim && npx tauri ios
  init && npx tauri ios dev`).
- xterm helper-textarea listeners after a font-size change: if xterm rebuilds
  its hidden textarea (unverified), the `kbTa` reference and blur/focus
  listeners go stale and break the keyboard-lock guard — confirm with a test
  before re-binding per font change (`Terminal.svelte` fontSize $effect).
- `newWindow` relies on `listPanes` returning the new pane last; have the
  `new_window` RPC return the new `{session, window, pane}` directly.
- The window switcher dedupes by window id with the FIRST pane it meets, so
  command/title/AI badge can come from a background pane — prefer
  `pane_active`.
- `slow_rpc_does_not_block_fast_rpc` proves concurrency in one direction only
  (measured 2026-08-20: the 5.3 MB download frame sits ahead of the pings in
  the socket buffer, so a serial server can look concurrent). It prints
  `inconclusive` instead of crying wolf; closing the gap needs an RPC whose
  server work is slow while its response stays small — every current one
  couples the two.
