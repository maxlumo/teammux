# WebSocket Server Service

## Purpose
Rust-based WebSocket server providing JSON-RPC interface to tmux and filesystem operations.

## Implementation
- Module: `src-tauri/src/server/` (`mod.rs` listener, `wire.rs` framing+crypto, `rpc.rs` dispatch + agent-hooks RPCs, `hub_rpc.rs` hub RPCs + message push, `download.rs` HTTP side-channel, `dispatch.rs` the one request-head router (download / WebSocket / static UI), `ui.rs` the web UI on the same port, `connection.rs` connection pump and the `Peer` (TCP or local) it serves, `local_socket.rs` the local socket's claim, bind and cleanup)
- Dependencies: tokio, tokio-tungstenite, hmac, sha2, aes-gcm, base64
- Starts on desktop only (`#[cfg(desktop)]`)
- Standalone binary: `src-tauri/src/bin/server.rs`

## Authentication
- Two modes: encrypted (AES-256-GCM with HKDF key derivation) and legacy plain token
- Server sends `server_nonce` (+ `e2e: 2`, the newest handshake it speaks) on connect; client responds with `client_nonce` + HMAC proof (+ the `e2e` version it wants), or plain token
- Before auth a connection gets 8 KB per text frame and 10 s to finish the handshake; over either, the server closes it. The 80 MB message allowance exists for authenticated `fs_upload`, not for a stranger on a 0.0.0.0 port.
- E2E v2 derives three keys per session (proof, client→server, server→client) so the two directions never share a (key, nonce); a client that does not ask for v2 gets the single-key v1 handshake. Contract: `docs/requirements/api-contracts/websocket-rpc.md`
- Encrypted mode: all subsequent messages are binary AES-256-GCM frames; decrypted payloads use a one-byte raw-JSON/raw-deflate framing tag
- Token auto-generated on first run, persisted in `~/.config/tmux-mobile/config.toml` (mode 0600). Printed at startup only when stdout is a terminal; under a supervisor or redirect the line names the config file instead, so the secret never lands in a log
- Environment variable `TOKEN` overrides config
- Rate limiting: per-IP auth failure tracking for TCP peers. Five failures inside 60 s lock that IP out for the rest of the 60 s, refused before the WebSocket handshake. A success from the IP clears its count. The local socket below carries no lockout.

## Two transports (board #440)
- **TCP** (`host:port`): phones, the desktop app, the LAN, and everything that arrives through a reverse proxy or the SSH tunnel. Per-IP lockout as above. On this host 127.0.0.1 is many clients at once: every agent's tmm, the Vite proxy, and the tunnel the internet arrives through. A stranger's bad tokens therefore lock all of them out; the tunneled clients' part of that is #441.
- **Local socket** `<config>/sock/gateway.sock` (desktop unix only): the same WebSocket JSON-RPC, the same token auth, auth deadline, frame limits and RPC dispatch, for this host's own tmm. It is "local" as a checked fact, not an address:
  - the socket is a 0600 node in a 0700 directory of the gateway's uid, and the gateway closes a peer whose credentials (SO_PEERCRED / getpeereid) are another uid;
  - a local login is never refused by, counted into, or cleared from the TCP lockout. A process that can open the socket can read config.toml beside it, so a lockout there would protect nothing;
  - the socket serves WebSocket only: no `/dl`, no UI;
  - only a successful local login is told the gateway's `endpoint` (`{port, config}`: this config's TCP port and canonical config dir), so a tmm can refuse a socket that is not its own config's gateway.
- **Socket lifecycle.** Every step works from an O_DIRECTORY handle of `<config>/sock/`, and any failure leaves the gateway TCP-only with the reason logged (`⚠  local socket unavailable (…)`); it never stops the start.
  1. `sock/` is created 0700 if absent, then opened without following a symlink. It must be a directory of the gateway's uid with mode 0700; it is never chmod-ed.
  2. An flock on `sock/gateway.lock` (opened O_NOFOLLOW, our regular file) is held for the gateway's life. If another live gateway holds it, the path is not touched.
  3. An existing node is considered only while THIS gateway holds the claim, so no live gateway of this config serves it; the claim is the cross-platform liveness fact (orchestrator ruling 2026-10-20 18:45). A regular file, a symlink, a directory or another uid's node is refused and left. For a socket of ours, one NONBLOCKING connect is made: it never waits, so a listener that stopped accepting with a full backlog cannot hold the start (review P1-A). What its answer proves differs by OS. On Linux ECONNREFUSED means no listener; on macOS (XNU, `unp_connect` when `sonewconn` finds the queue full) a full backlog answers ECONNREFUSED too (review, 18:45). So the decision also asks whether the node is the one the previous claim holder recorded: every gateway writes its bound node's (dev, ino) into `gateway.lock` once its socket is ready (`reclaimable`):

     | the probe | node recorded by the previous claim holder | not recorded |
     |---|---|---|
     | connects | keep, TCP only | keep, TCP only |
     | ECONNREFUSED | reclaim (its gateway is gone: the claim was free) | Linux: reclaim (no listener, proven). macOS / other unix: keep, TCP only (it may be a full backlog of a process that is not a gateway) |
     | EAGAIN or anything else | keep, TCP only | keep, TCP only |

     A gateway killed after its socket was ready leaves a recorded node, which the next start reclaims on every OS. A node with no record (a gateway killed between bind and the record, or a process that is not a gateway) is reclaimed only on Linux; on macOS it stays until removed by hand, and the gateway is TCP-only with the reason logged. Tests: `the_reclaim_decision_follows_the_per_os_table` (both OS rows, on any host), `a_ready_socket_records_its_node_in_the_claim`, `a_busy_listener_neither_blocks_the_start_nor_is_reclaimed`, and (Linux) `a_dead_socket_is_reclaimed_a_live_one_or_a_foreign_node_never_is`. The macOS row is pinned as a decision, not measured on a Mac.
  4. Bind, and at once take the bound node's (dev, ino) into the owning guard, so a failure in any later step removes THIS node (and no replacer's) with the claim still held (`a_failure_after_bind_removes_only_its_own_node`, a fault injected after bind). If that very first stat fails, the node cannot be told ours and is left. Then chmod 0600 and re-check: the pathname still names the directory held, and the node is the recorded 0600 socket of our uid. The async listener is built next. Only after all of that is the socket announced (`🔌 local socket: <path>`), its path published for the spawn recipe (`server::bound_local_socket`, once per process), and accepted on (review P2).
  - Every accepted stream passes ONE gate, `admit_local`: the peer credentials must say the gateway's uid, else it is closed before a byte is read or written, and unreadable credentials are closed too. Only then does it reach the WebSocket and the token auth. The credential result is passed in, so `admit_local_tests` drives the refusal (another uid, an error) and the admission without a second user (review P1-B).
  5. The node is removed when the socket is dropped, only if its (dev, ino) is still the one bound. The gateway has no graceful stop today, so on a kill the node stays, and step 3 reclaims it at the next start as dead.

## Subscription Model
- `subscribe(target)` starts a polling loop (200ms interval)
- Polls `capture_pane_with_width` (ANSI escapes + joined soft-wrapped lines + CJK width fix)
- Also polls `cursor_info` for cursor position
- Pushes `pane_output` with content (only when changed), cursor position, and `current_command` + the pane's process-derived `agent` on the first push or when the command changes
- Pushes `pane_closed` after repeated capture failures (pane gone)
- One subscription map per connection (multiple targets supported)
- `unsubscribe` or disconnect stops the loop

## Resize Tracking
- `resize_pane` resizes tmux pane to match client viewport
- Two-level tracking:
  - Per-connection: which windows each connection has resized
  - Per-window: how many still-connected clients are "holding" the window at its current size, plus an optional pending-restore task handle
- On disconnect: decrement the holder count for each window; if the count reaches 0, schedule (not perform) a restore task that sleeps `disconnect_grace_secs` and then calls `resize-window -A`
- Any subsequent `resize_pane` on that window cancels the pending restore — so short reconnects (app backgrounded, network blip) avoid the disconnect → reflow → reconnect → reflow double-cycle
- `disconnect_grace_secs = 0` preserves the legacy immediate-restore behavior (no timer)
- Sets tmux hook (`client-session-changed`) so real terminal clients restore size when they next attach

## Configuration
- File: `~/.config/tmux-mobile/config.toml`
- Fields: token, host (default 0.0.0.0), port (default 9899), tmux_socket, tls_cert, tls_key, scrollback (default 500), disconnect_grace_secs (default 600)
- Env vars: TOKEN, HOST, PORT, TMUX_SOCKET, TLS_CERT, TLS_KEY, SCROLLBACK, DISCONNECT_GRACE_SECS
- TLS support via tls_cert + tls_key paths
- Preferences: separate `prefs.json` file for client-side settings (get_prefs/set_pref)
- Bookmarks: separate `bookmarks.json` file

## Security
- Full filesystem access by design (remote management tool)
- Path traversal protection on download filenames (`sanitize_filename()`)
- Git operations whitelisted to safe subset, shell metacharacters rejected in args
- iframe sandbox: `allow-same-origin` only (no scripts)

## Agent hooks

- There is no client-facing hooks RPC. Managed agents carry their hooks in the
  isolated home's rendered config (spawn / `refresh_hooks`), so the
  `agent_hooks_status` / `agent_hooks_install` / `agent_hooks_remove`
  management surface retired 2026-09-20 (board #222) together with the
  user-space installers; an old client's call gets METHOD_NOT_FOUND.
- The hooks feed telemetry (status derivation, tool/prompt rows), the managed
  stop-hook auto-post into the project room, and the per-window conversation-id
  memory that project restore resumes with.
- The unread-inbox surface retired 2026-09-01: `agent_notifications_list`,
  `agent_notifications_mark_read` and the `agent_notification` push are no
  longer served — an old client's call gets METHOD_NOT_FOUND. The
  room's auto-post + read cursor and the derived status dots carry the signal.
