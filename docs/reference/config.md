# Configuration reference

Runtime configuration of the WebSocket server and the Team feature. Build and dev-loop settings are in `../conventions/development.md`.

`tmm setup` writes the connection keys interactively (board #323; the first `tmm gateway` asks too when the file is absent), keeping every other key and comment and saving paths absolute; a file it cannot read or parse is left untouched and stops the command. File: `$XDG_CONFIG_HOME/tmux-mobile/config.toml` (fallback `~/.config/tmux-mobile/`) — token, host, port, tmux_socket, tls_cert, tls_key, scrollback, disconnect_grace_secs, kiro_engine, ui_dir, restore_on_start.

```toml
token = "auto-generated-uuid"  # written on first launch
host = "0.0.0.0"               # optional
port = 9899                    # optional
tmux_socket = ""               # optional, tmux -S path
tls_cert = ""                  # optional, PEM cert for wss://
tls_key = ""                   # optional, PEM private key for wss://
disconnect_grace_secs = 600    # optional
restore_on_start = false       # optional; board #422
ui_dir = ""                    # optional, absolute path of a built web UI (dist/)
```

Env vars `TOKEN`, `HOST`, `PORT`, `TMUX_SOCKET`, `TLS_CERT`, `TLS_KEY`, `SCROLLBACK`, `DISCONNECT_GRACE_SECS` override config. **An installed gateway service does not use them** (board #323): it runs `tmm gateway start --service`, which loads `config.toml` ALONE, so neither the installing shell nor the user manager's environment can change its port, bind, token or TLS. `tmm gateway install|status` say so when any override is set in the calling shell, and `status` reads the same file-only view, read-only. Put a lasting change in `config.toml`, then `tmm gateway restart`. (The retired Team feature's `TEAM_*` keys are gone, board #100; `projects::rooms::import_legacy` still reads `TEAM_DB`/`team_db`/`crew_db`/`agora_db` once to locate a legacy team.db for the one-off chat-history import.)
Default scrollback: 500 lines.
`ui_dir` (config.toml only, absolute): a built web UI the gateway serves on its own port (board #323). Unset: the UI built into the binary (`--features embed-ui`, what `npm run build:server` builds), else none. A `ui_dir` without a readable `index.html` serves nothing — `tmm ui` says why. See tmm-cli.md § The web UI on the gateway's own port.
`<config>/AGENTS.md` — optional app-wide agent instructions, prepended to every managed agent's system prompt at spawn (`tmm prompt`, Settings → Agents). Absent = none. See `docs/design-docs/features/tmm-cli.md` § The app-wide instructions.
Per-agent settings are not in this file: each registry definition (backend, model, effort, input mode `queue`|`steer`, prompt, skills, MCP) lives in `state.db` and is edited in Settings → Agents or with `tmm registry save`. The input mode is offered only for kiro and codex; see agents-overview.md § The input mode.
`kiro_engine` (default `v2`; env `KIRO_ENGINE`): the kiro-cli agent engine managed kiro agents launch with — `v2` (the CLI's default) or `v3` (kiro-cli 2.22.1's KAS engine). Read at spawn and at every refresh; an agent takes it at its next restart. Under `v3` each managed kiro agent also gets a symlink `<ws>/.kiro/agents/<name>.json` into its isolated home (see agents-overview.md § kiro 2.22.1). Board #207.

Default restore_on_start: false. When true, a gateway start after a host reboot brings back the sessions and agents the last checkpoint saw live (board #422; `docs/design-docs/features/projects.md` § After a host reboot). Off until the live acceptance of round 4.

Default disconnect_grace_secs: 600 (10 min). Delay before a disconnected client's tmux window is auto-resized back; set to 0 for legacy immediate restore. See `docs/design-docs/features/disconnect-grace.md`.
