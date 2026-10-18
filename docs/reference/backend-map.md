# Backend map — `src-tauri/`

Rust side of tmux-mobile: the WebSocket server, the `tmm` CLI, project/agent
management, and the Tauri shell. Rules with their reasons live in the design
docs (`../design-docs/`); this page only says where things are.

## Modules

- `lib.rs` — Tauri app setup (plugins: dialog, fs, opener, notification), desktop menu; `main.rs` is a stub pointing at `server` when `gui` is off.
- `bin/server.rs` — headless WebSocket server entry. `bin/tmm.rs` — the agents' CLI (send/log/status/done/spawn/board/task/mcp…; fail-soft, never blocks).
- `server/` — `mod.rs` (accept loop, auth), `connection.rs`, `wire.rs` (framing/E2E), `rpc.rs` (tmux/fs RPCs + agent-hooks dispatch), `hub_rpc.rs` (`hub_*`: rooms, agents, board, spawn, and the hub message push loop — messages live in state.db `hub_msgs` via `projects/rooms.rs`, board #107), `download.rs` (`/dl`).
- `projects/` — `mod.rs` is the FACADE only (module tree, the one store handle, id helpers, explicit re-exports so every `projects::X` holds; board #152). `projects.rs` (the verbs: create/adopt/up/down/rename/archive/delete, session-workspace lookup), `managed.rs` (managed-agent identity: `managed_home`/`is_managed_in`, `agent_remove`), `registry.rs` (registry/teams/global-prompt facades), `board.rs` (task-board facade), `store/` (state.db: `mod.rs` the one `Store` + connection + open/heal, `schema.rs` the migration ladder, and one `impl Store` file per table family — `projects`, `registry`, `board`, `activity`, `rooms`, `restore`; board #147), `rooms.rs` (hub chat store + push channel + legacy import + the archive verbs, board #107), `capture.rs` (observe/merge + the 20 s tick: auto-adopt, fold tmux back, publish the restore checkpoint, recovery scan), `restore.rs` (reboot restore, board #422: tmux/boot identity, checkpoint publication rule, the reboot trigger and the pure plan), `reconcile.rs` (`up`/`down`), `spawn.rs` (isolated homes, hooks, recipes, `build_prompt`), `skills.rs` (skill resolution for spawn + the central skills/MCP assets), `agents.rs` (ONE detection/relaunch table), `telemetry.rs` (derived status, deliveries, activity), `vitals.rs` (pane sniffing), `recovery.rs` (auto-`continue`), `models.rs` (model/effort validation), `teams.rs` (agent teams: member schema, validation, effective definition).
- `backends/` — ONE file per agent CLI (`kiro.rs`, `claude.rs`, `codex.rs`, `grok.rs`, `omp.rs`) plus `shared.rs` (backend-neutral launch helpers) and `mod.rs` (`enum Backend`: every per-concern method is an exhaustive match into the backend's file — render, hooks, refresh probe, resume dialect, sniff, effort values, models, KNOWN row, hook payload dialect). An UNGATED leaf like `shell.rs`: the enum and the payload dialects compile on every target, desktop-only items carry their own cfg gate (board #101/#129).
- `agent_notifications.rs` — hook inbox consumer: the normalize shell (kind decided by `Backend::normalize_kind`), auto-posts replies (four invariants), installs global hooks.
- `tmux.rs` (wrapper; named keys, paste), `fs.rs`, `tasks.rs` (`tmm task`: background tmux windows), `mcp_cli.rs` (`tmm mcp`), `system_status.rs` (desktop vitals), `config.rs`, `pptx.rs`.

## Rust-only rules

- Features: `gui` = tauri + its four plugins; `--no-default-features` builds server + tmm on any host. `build.rs` emits the `desktop`/`mobile` cfg aliases itself when `gui` is off — the `Config` import (and formerly the Team modules) are gated on `desktop`.
- Release profile keeps `incremental = false` (see `docs/conventions/development.md` for the link-error history).
- Migrations MUST `PRAGMA foreign_keys=OFF` — a table rebuild's `DROP TABLE` cascades children otherwise.
- Telemetry writes and the activity DB are off under `cfg(test)` so `cargo test` never writes invented sessions into the real `state.db`.
- Tests are sequential (`--test-threads=1`) and need a running tmux; unit tests live in the module they test. On Linux without WebKitGTK, `cargo check --features gui` only works for the Android target with the NDK toolchain in env.
