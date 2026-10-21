# Configuration reference

Runtime configuration of the WebSocket server and the Team feature. Build and dev-loop settings are in `../conventions/development.md`.

`tmm setup` writes the connection keys interactively (board #323; the first `tmm gateway` asks too when the file is absent), keeping every other key and comment and saving paths absolute; a file it cannot read or parse is left untouched and stops the command. File: `$XDG_CONFIG_HOME/tmux-mobile/config.toml` (fallback `~/.config/tmux-mobile/`) — token, host, port, tmux_socket, tls_cert, tls_key, scrollback, disconnect_grace_secs, kiro_engine, ui_dir, restore_on_start, trusted_proxies.

```toml
token = "auto-generated-uuid"  # written on first launch
host = "0.0.0.0"               # optional
port = 9899                    # optional
tmux_socket = ""               # optional, tmux -S path
tls_cert = ""                  # optional, PEM cert for wss://
tls_key = ""                   # optional, PEM private key for wss://
disconnect_grace_secs = 600    # optional
restore_on_start = true        # optional; board #422 (false turns the automatic start off)
ui_dir = ""                    # optional, absolute path of a built web UI (dist/)
trusted_proxies = []           # optional; board #441 (OFF: read the preconditions below first)
```

Env vars `TOKEN`, `HOST`, `PORT`, `TMUX_SOCKET`, `TLS_CERT`, `TLS_KEY`, `SCROLLBACK`, `DISCONNECT_GRACE_SECS` override config. **An installed gateway service does not use them** (board #323): it runs `tmm gateway start --service`, which loads `config.toml` ALONE, so neither the installing shell nor the user manager's environment can change its port, bind, token or TLS. `tmm gateway install|status` say so when any override is set in the calling shell, and `status` reads the same file-only view, read-only. Put a lasting change in `config.toml`, then `tmm gateway restart`. (The retired Team feature's `TEAM_*` keys are gone, board #100; `projects::rooms::import_legacy` still reads `TEAM_DB`/`team_db`/`crew_db`/`agora_db` once to locate a legacy team.db for the one-off chat-history import.)
Default scrollback: 500 lines.
`ui_dir` (config.toml only, absolute): a built web UI the gateway serves on its own port (board #323). Unset: the UI built into the binary (`--features embed-ui`, what `npm run build:server` builds), else none. A `ui_dir` without a readable `index.html` serves nothing — `tmm ui` says why. See tmm-cli.md § The web UI on the gateway's own port.
`<config>/AGENTS.md` — optional app-wide agent instructions, prepended to every managed agent's system prompt at spawn (`tmm prompt`, Settings → Agents). Absent = none. See `docs/design-docs/features/tmm-cli.md` § The app-wide instructions.
Per-agent settings are not in this file: each registry definition (backend, model, effort, input mode `queue`|`steer`, prompt, skills, MCP) lives in `state.db` and is edited in Settings → Agents or with `tmm registry save`. The input mode is offered only for kiro and codex; see agents-overview.md § The input mode.
`kiro_engine` (default `v2`; env `KIRO_ENGINE`): the kiro-cli agent engine managed kiro agents launch with — `v2` (the CLI's default) or `v3` (kiro-cli 2.22.1's KAS engine). Read at spawn and at every refresh; an agent takes it at its next restart. Under `v3` each managed kiro agent also gets a symlink `<ws>/.kiro/agents/<name>.json` into its isolated home (see agents-overview.md § kiro 2.22.1). Board #207.

Default restore_on_start: true (since board #422 round 4's live acceptance, `scripts/restore-acceptance.sh`). A gateway start after a host reboot brings back the sessions and agents the last checkpoint saw live (`docs/design-docs/features/projects.md` § After a host reboot); `false` turns that off, and so does a config.toml that cannot be read or parsed (said on stderr by kind and line/column only, never the file's text, which holds the token: a person's opt-out is never lost to a torn file). The switch governs only the automatic start: `tmm project restore --run` is the person's door either way, and `tmm project restore` shows the switch's state.

`trusted_proxies` (config.toml only; default OFF): IPs or CIDRs whose `X-Forwarded-For` the auth lockout believes (board #441; websocket-server.md § The lockout key behind a trusted proxy). From a TCP peer inside the list, the lockout is keyed by the right-most `X-Forwarded-For` entry outside the list; any missing or unusable header keys by the peer, as when OFF. A wrong entry or shape turns the key off as a whole (said once, by position) and leaves the rest of the file loading. `tmm gateway status` shows what the running gateway does. **Read before setting it:**

- *What it trusts.* `trusted_proxies = ["127.0.0.1/32", "::1/128"]` trusts every program that can open a TCP connection to the gateway's port from this host without passing the proxy, and each can choose its own lockout key (dodge it, or lock someone else out). Two preconditions: (1) the reverse tunnel's far end binds loopback only. On tky, sshd's `GatewayPorts yes` makes the `-R 127.0.0.1:9899` and `:5173` forwards listen on 0.0.0.0, reachable without Caddy from the security groups' other sources; set `GatewayPorts clientspecified` (or `no`) and confirm with `ss -ltn` that they listen on 127.0.0.1 only. (2) This host's agents reach the gateway over the local socket (board #440), not TCP, and no other local program you do not trust talks to the TCP port.
- *What reaches the gateway today.* Caddy on tky, without its own `trusted_proxies`, replaces any incoming `X-Forwarded-For` with the CloudFront edge's address (measured, Caddy v2.11.4). Setting the key alone therefore keys by EDGE: a stranger on another edge can no longer lock the owner out, one on the owner's edge still can.
- *Keying by the viewer* (the recommended deployment, owner's change, in this order): (a) switch the CloudFront distribution's origin request policy from Managed-AllViewer to Managed-AllViewerAndCloudFrontHeaders-2022-06, which adds `CloudFront-Viewer-Address` (viewer `ip:port`). AWS: when a policy adds that header, CloudFront overwrites a viewer-sent value of the same name (CloudFront developer guide, Restrictions on Lambda@Edge, "CloudFront headers"). Under Managed-AllViewer a viewer-sent value is forwarded as is. (b) On both tmux-mobile routes of tky's Caddyfile add `header_up X-Forwarded-For {http.request.header.CloudFront-Viewer-Address}`. (c) Set `trusted_proxies` and `tmm gateway restart`. (d) Verify: one login through the distribution that sends a forged `CloudFront-Viewer-Address: 192.0.2.1:1` and a wrong token must log `Auth failed from <your real address> (via 127.0.0.1:…)` in `tmm gateway logs`. A revert of the policy must take (b) or (c) with it: the gateway cannot tell.

Default disconnect_grace_secs: 600 (10 min). Delay before a disconnected client's tmux window is auto-resized back; set to 0 for legacy immediate restore. See `docs/design-docs/features/disconnect-grace.md`.
