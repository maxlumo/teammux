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

**What does NOT change.** Beyond the window (3 minutes) the loop still gives
up and shows the connect card, so a server that is really gone does not keep
a device retrying for ever; the form and a server switch still take the socket from a
running loop. The Vite dev client's own reload-on-reconnect, which is what
reloaded a browser tab before the app's loop ever got a say, is a separate
mechanism, patched in `vite.config.js` (see
[development.md § The dev server](../../conventions/development.md#the-dev-server-what-it-watches-and-a-lost-hmr-socket-393)).
