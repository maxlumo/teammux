# Disconnect Grace Period for Window Resize Restore

## Context
`resize_pane` sets a tmux window to the client's viewport size. Since tmux
picks the smallest size across all attached clients for a shared window,
the server used to restore windows back to auto-size (`resize-window -A`)
the moment the client disconnected, so that a real terminal client attaching
the same session would not be stuck at 80×24 of a phone.

This fired on *every* disconnect, including:

- App backgrounded (iOS suspends the WebSocket in ~10-30 s)
- Cellular/Wi-Fi handover (network blip)
- App killed and reopened by the user

The observable symptom: reopening the app takes noticeably long before the
pane settles. The reason is a **double reflow**:

1. Disconnect → server runs `resize -A` → tmux reshapes the window to
   whatever the remaining clients (or defaults) want → every AI CLI in
   that pane redraws against the new dimensions.
2. Reconnect → client sends `resize_pane(cols, rows)` → tmux reshapes
   back to the phone size → second redraw.

On long scrollback (Kiro/Claude transcripts with tables, code blocks, long
responses) the two reflows can take multiple seconds of visible churn.

## Decision
Defer the restore with a configurable grace period. On disconnect, schedule
`resize -A` to run after `disconnect_grace_secs`. If the same (or any)
connection resizes the window again before the timer fires, cancel it —
the window is still being actively driven and should stay at its current
size.

Default: **600 s (10 min)**. Long enough to cover app-backgrounded + phone
locked + user returns after a coffee break. Short enough that a real desktop
tmux client attaching after a forgotten session still gets a reasonable
window size within minutes.

`disconnect_grace_secs = 0` preserves the legacy behavior (immediate
restore, no timer).

## Architecture

```
ResizeTrackerInner {
    per_conn  : HashMap<conn_id, HashSet<window>>
    per_window: HashMap<window,  WindowResizeState { active_conns, pending_restore }>
}
```

Two indexes, one purpose each:

- `per_conn` — so disconnect can iterate "which windows did this conn touch"
  without scanning every window.
- `per_window` — aggregate state shared across connections. `active_conns`
  is a refcount of still-connected clients that resized this window;
  `pending_restore` holds the `JoinHandle` of a running grace-timer task,
  or `None` if no restore is scheduled.

### Event flow

**`resize_pane(target, cols, rows)` (conn `C` on window `W`):**
1. `tmux resize-pane`
2. If `(C, W)` is a new pair in `per_conn`, increment `per_window[W].active_conns`.
3. If `per_window[W].pending_restore` is `Some`, `.abort()` it and clear.

**Connection `C` disconnects:**
1. Remove `C` from `per_conn`, get its window set.
2. For each window `W`:
   - Decrement `per_window[W].active_conns`.
   - If still > 0 → skip (another client is holding the size).
   - Else spawn a timer task:
     ```
     sleep(grace_secs)
     reconfirm active_conns == 0  // someone may have reconnected
     run resize -A in spawn_blocking
     remove per_window[W]
     ```
     Store its `JoinHandle` in `per_window[W].pending_restore`.

### Abort vs. re-check
`JoinHandle::abort()` cancels the task at its next `.await` point. If a
reconnect lands after the task has already passed the `sleep` but before
it executes the tmux call, the abort fires too late — so the task also
re-reads `active_conns` under the lock before calling `resize -A`. Belt
and suspenders.

### Lock discipline
`ResizeTracker` uses `std::sync::Mutex`. `MutexGuard` is `!Send`, so
holding it across an `await` breaks the spawned-future `Send` bound. The
disconnect cleanup works in two phases:

1. **Under the lock** — compute a `Decision` (Skip / RestoreNow / Scheduled),
   including synchronously spawning the grace-timer task and storing its
   handle in `pending_restore`. `tokio::spawn` is synchronous (returns
   immediately), so no await happens inside the lock.
2. **After the lock releases** — `match decision` handles the awaits
   (`RestoreNow` does a `spawn_blocking(resize -A).await`).

## Alternatives Considered

**Per-connection map only, with no per-window aggregation.** Original
design. Breaks when two clients share a window: whichever drops first
triggers `resize -A` even though the other is still attached and wants
the window at its current size. Per-window refcount fixes this as a
side benefit.

**Checking tmux `list-clients` on disconnect to decide whether to restore.**
Would give perfect semantics ("nobody's watching → restore"). But tmux
clients are per-session, not per-window, and the mapping to "would a
remaining tmux-mobile client see this pane wrong" is gnarly. The grace
timer sidesteps this: we just wait, and if someone reconnects and resizes,
we don't restore.

**Server-side capture cache keyed by target.** Would also help reconnect
speed (skip the 200 ms wait for first pane_output). Small win compared
to eliminating the reflow; can revisit if needed.

## Configuration
- `disconnect_grace_secs` in `~/.config/tmux-mobile/config.toml`
- Env var `DISCONNECT_GRACE_SECS` overrides config
- Default 600 (10 min); set to `0` for legacy immediate restore

## The client's side: how long a dropped connection is retried (board #393)

The grace period above is the SERVER waiting for a client to come back. The
client's half is the same promise from the other end: a dropped connection
reconnects QUIETLY and the person's place on the screen is not disturbed.

Owner, 2026-10-15 23:40: "ws连接中断了再重试恢复，为什么整个浏览器网页都要刷新呢…应该悄悄恢复，最多有个悬浮提示一下重连就行，保证整个页面稳定性". A dropped
connection never reloads the page (the app has no `location.reload`; a source
test pins it) and its only cue is the existing floating reconnect bar
(`.reconnect-bar`, "Reconnecting… (k/N · class)") — no new UI.

**The rule: a lost connection is retried for the reconnect loop's whole window,
BY THE CLOCK, and only then does the person land on the connect card.** The
window is `RECONNECT_WATCHDOG_MS` (180 s) in `app/reconnect.ts`; there is no
attempt count to size from the backoff and get wrong. (The first cut derived one
— 180 s over the 3 s retry cap = 60 attempts — and the reviewer calculated it from the source: with
the gap growing 0.5, 1, 1.5, 2, 2.5 s and then 3 s, 60 attempts have 59 gaps and
give up at 169.5 s, ~10 s early. A count rounds; the clock does not.) App.svelte
passes the machine no budget of its own and the bar shows the attempt number only,
no "/N" that a clock-driven loop would not honour.

**Why.** The budget used to be a literal 10 attempts. With the gap growing 0.5 s
per attempt up to 3 s, ten attempts last ~25 s: a connection that stayed down
longer put the connect card over the hub view and the text being typed
(measured live, 2026-10-15, headless Chrome through a TCP hop that dropped the
connection: a 5 s drop reconnected; a 30 s drop gave up at ~25 s). A restarting
SSH tunnel (up to 90 s to notice with `ServerAliveInterval 30 × 3`), a CloudFront
edge change, a laptop waking and a Wi-Fi handover all outlast that. After the
change the same rig: 5, 30 and 60 s drops reconnect with nothing but the bar,
the hub view and the draft kept, and the gateway sees a new connection when the
cut ends. Tests: `reconnect.test.ts` runs the machine with App's own budget (none)
on a fake clock — instant refusals keep the view at 179 s and give up at 180 s, and a
60 s and a 175 s outage both recover; `App.shell.mount.test.ts` runs the 60 s case through
the whole App: no connect card, the existing bar as the only cue, the same editor
with the same unsaved text and the same scroll position.

**An authentication refusal is not a drop.** When the server ANSWERS the login and
says no, retrying for three minutes would repeat the same answer — and each dial
counts against the server's per-address lockout — so the loop stops at once and
shows the connect card with the stored address and token to correct. What counts as
"the server said no" is ONE thing, and it is narrow: the server's plain `ERR_AUTH`
(-32000) error frame in reply to the auth message (`invalid proof` on the encrypted
path, `invalid token` on the plain one). On the encrypted path it arrives as TEXT,
because the server has no session key for a proof it just rejected;
`core/connection.ts` keeps it as an error carrying that code (the first cut of this
rule read every text frame there as "expected binary auth response", so the most
common real refusal — a wrong token over https or on localhost — was retried for the
whole window). The reconnect loop's single check, `isAuthRefusal` in
`app/dial-order.ts`, looks at the CODE and nothing else. Everything else that goes
wrong in a login fails THAT dial and leaves the loop retrying inside its window: a
frame that does not decrypt, a sealed frame that is not JSON or not an
authentication, a binary frame that is no answer, a text frame that is no JSON, a
sealed `ERR_AUTH` (the refusal is plain; an encrypted one is not what the server
sends), a socket closed during auth, a timeout. A plain authenticated-SUCCESS frame
is never accepted on the encrypted path (no downgrade): it is the protocol error
"expected binary auth response", not a login and not a refusal. Tested on the real
`createConnection` with the frames connection.rs sends and the ones it does not
(`connection.test.ts`), and through the reconnect machine with its default budget:
one dial, no unreachable cooldown; a socket closed during auth is still retried.

**A failed login is the TERMINAL state of that attempt** (reviewer P1-B residual on
the first cut of the above). Rejecting the dial's promise was not enough: the socket
and its handlers stayed live, and the encrypted-path failure cleared the session
cipher, which the receive handler also used to mean "this attempt chose plain-token
auth". So a LATER plain `authenticated: true` on the same socket — or one already
queued behind the failure — took the plain branch and logged the connection in, in
plain text: identity, capabilities, the liveness probe, pushes, behind a promise that
had already failed. Now `failDial` in `core/connection.ts` ends the attempt: its
handlers are cut, its socket is closed and, if the connection still points at it,
released; the chosen mode (`encrypted`) is its own variable, set once at the nonce
and never inferred from the cipher; and every handler and every continuation after
an `await` checks `failed`. It acts on THIS attempt's socket only, so an old failure
can never close a newer connection (a fresh handshake on the same object afterwards
succeeds, and the old socket's late frames, close and error touch nothing). The
classification is unchanged: only the server's coded `ERR_AUTH` stops the reconnect
loop; every other failure ends only that dial. Tested on the real `createConnection`
with the failing answer followed by a plain success and a push on the same socket,
already queued behind it and arriving later, on the encrypted and the plain-token
paths: the promise stays rejected, identity and capabilities do not change, nothing
is announced or pushed, and the socket is closed.

**The handshake is a gate, one phase at a time** (reviewer, round 4: the third pass over this gate; each earlier fix had
closed the branch named and left its neighbour open, so this one sweeps every phase). The rule: until the login completes,
a connection delivers nothing, and every error on the way ends THAT attempt through its own `failDial` — none is swallowed.
`core/connection.ts`'s receive handler runs the frames of one socket strictly in arrival order, so a frame that arrives
while an earlier one is being worked on waits, and is handled in the phase it then finds. The server's nonce is read at the
door by `parseServerNonce` (a string of 32 hex digits = 16 bytes, the salt's width in the key derivation); the receive
chain's `catch` calls `failDial` with the error while `authed` is false; `decryptMsg` takes a real `Cipher`, has no plain
mode, and no code path calls it without one (the first cut had `cipher: Cipher | null` and read a plain frame as "decrypted").

| phase (state) | a frame or an error | what happens | pinned by (`connection.test.ts`) |
|---|---|---|---|
| **1 · before the nonce** (no `serverNonce`) | a valid nonce: text, `server_nonce` = 32 hex digits | taken; phase 2 | every handshake test |
| | a malformed nonce (not a string, not hex, not 16 bytes), a push, a team message, an RPC answer, a plain or binary success, text that is no JSON, `e2e` without a nonce | `failDial("auth failed: the first frame was not a valid server nonce")`; nothing derived and nothing sent (not the token); a valid nonce queued behind it is not answered; no listener is called | "a malformed server nonce ends the attempt at the door" (8 values × encrypted/plain × queued/late, then a fresh handshake); "a frame BEFORE the nonce" (8 kinds × both modes) |
| | a network fault: a socket error, a close, the connect timer | the attempt ends with "connection failed" / "connection closed during auth" / "connection timeout"; never a refusal, so the reconnect loop retries inside its window. (No key derivation or crypto exists yet, so there is no other error here.) | "a socket error, a close or a timeout BEFORE the nonce ends the attempt as a network failure" |
| **2 · while the key is built** (nonce taken, `buildSession` awaiting; plain-token: no key, the token goes out at once) | a frame | waits; handled in phase 3 (or 5 if this phase failed) | "a valid nonce whose key derivation FAILS" (a plain binary success, a push and a team message queued behind it, then late) |
| | a derivation, crypto or send error (socket not open) | the receive chain's catch → `failDial(that error)`; the socket is closed, its handlers cut; what waited behind is dropped | "a valid nonce whose key derivation FAILS"; "a send that fails during the handshake" (both modes) |
| | the dial times out, is superseded, disconnected or disposed, or the socket closes | `failDial` / the settle path; the continuation after the `await` sees `failed \|\| ws !== socket` and sends nothing | "encryption that finishes after a reconnect reaches neither socket"; "disposeAll settles a dial that is mid-authentication"; "a dial superseded by the next connect is settled" |
| **3 · waiting for the auth answer** (auth sent) | encrypted: the server's plain `ERR_AUTH` | `failDial(refusal)`: the reconnect loop stops | "the server's plain invalid-proof frame on the ENCRYPTED path is kept as a refusal" |
| | encrypted: any other text (a push, a plain success, no JSON) | `failDial("expected binary auth response")`; never a login, never a refusal | "a plain frame on the encrypted path is NEVER a login"; "while the auth answer is awaited a push is never dispatched" (plain push) |
| | encrypted: a binary frame that does not decrypt, is no JSON, is no authentication, or is a sealed push or error | `failDial("auth failed")`; nothing dispatched | "only the server's explicit PLAIN ERR_AUTH is a refusal"; "while the auth answer is awaited…" (sealed push, sealed team message) |
| | encrypted: a real sealed `authenticated` | `authSuccess`: identity, build and capabilities are read, the dial resolves; phase 4 | every `handshake()` |
| | plain-token: text `authenticated` / `ERR_AUTH` / any other (a push, a binary frame) | success / `failDial(refusal)` / `failDial(message or "auth failed")`; a push is not dispatched | "the PLAIN-token path keeps the server's invalid-token refusal too"; "while the plain-token answer is awaited a push is never dispatched either" |
| | a parse or decrypt error | `failDial("auth failed")` (the same line as the frame being wrong) | as above |
| **4 · after success** (`authed`) | encrypted: a sealed frame | decrypted; a push or an answer is dispatched. It does not decrypt: `forceDisconnect("decrypt failed")` (the counter has moved, so the session is dead). It decrypts but is no JSON: dropped | "after the login the encrypted path ignores a plain text frame and a second nonce, and delivers a sealed push" |
| | encrypted: a text frame, a second nonce | ignored: not a push, not a second handshake, not answered | same |
| | plain-token: a text push or answer; a binary frame; a second nonce | dispatched; ignored; ignored | "after the login the plain-token path delivers a text push, and ignores a binary frame and a second nonce" |
| **5 · after failure** (`failed`) | any frame (queued or late), close, error | nothing: the handlers are cut, `handleMessage` and every continuation return on `failed`; a later `connect()` on the same object dials a NEW socket and its handshake succeeds | "after a failed ENCRYPTED login the same socket can never log in"; "…PLAIN-token login…"; "a failed attempt ends only ITS OWN socket"; and the fresh-handshake line closing each test of phases 1–2 |

The source pin `connection.source.test.ts` ("the handshake takes its inputs through ONE door each and decryptMsg has no
plain mode") keeps `decryptMsg`'s signature non-null and `parseServerNonce` the only caller of `hexToBytes`. The line
`if (!authed) return` before the dispatch is defence in depth: the two handshake blocks return for every frame while
`!authed`, and this states it where the dispatch begins.

**What does NOT change.** Beyond the window (3 minutes) the loop still gives
up and shows the connect card, so a server that is really gone does not keep
a device retrying for ever; the form and a server switch still take the socket from a
running loop. The Vite dev client's own reload-on-reconnect, which is what
reloaded a browser tab before the app's loop ever got a say, is a separate
mechanism, patched in `vite.config.js` (see
[development.md § The dev server](../../conventions/development.md#the-dev-server-what-it-watches-and-a-lost-hmr-socket-393)).
