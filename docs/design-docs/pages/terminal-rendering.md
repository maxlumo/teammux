# Terminal Rendering — frames, tail, and key encoding

How a pane's frames reach xterm.js and when they are allowed NOT to: hidden terminals record instead of render, local input snaps back to the live tail, and the two tmux key-encoding rules every send path must respect. Touch is in `terminal-touch.md` / `terminal-gestures.md`; sizing in `terminal-sizing.md`.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### A hidden terminal records frames, it does not render them

page layers stay mounted (`visibility: hidden`) so state survives tab switches, which meant every busy pane kept running the full frame pipeline (whole-snapshot ANSI color adaptation + full-screen xterm write + WebGL draw) at the server's 5 fps cadence, invisibly, per pane and per split cell — CPU as heat for nothing (owner, 2026-08-22: "发热挺厉害"). `Terminal` takes a `visible` prop (App passes `page === 'terminal'`, SplitView forwards it per cell, the Hub drawer passes the Hub's own `visible`); while false, `onPaneOutputCb` only updates `lastContent`, and a repaint-on-show effect replays the newest frame (tail follows, scrollback readers get the new-output pill). A hidden terminal does not size the pane either (board #395, terminal-sizing.md): its box still changes under `visibility: hidden`, and sending that size took the pane from the instance on screen. It never draws: the one draw path (`_writeToXtermNow`) returns while hidden, and a capture reply for a pane the component has left is dropped. The replay is REQUIRED, not polish: the server skips frames identical to the last one it sent, so a dropped frame is never re-sent. `lastContent`/`lastCursor` are component-scoped plain lets (reset per target) so that effect can reach them without re-running on every frame.

### A font, theme or `active` change is a live option update, never a rebuild

`Terminal.svelte` has ONE lifecycle effect — dispose the old xterm, construct the new one, resubscribe, `capture_pane`, WebGL init, `kbLocked = true` — and its only dependency is `target`. The effect reads `target` and then runs its whole body under `untrack`, so the font size and family, the line height, the theme and `active` it reads synchronously while constructing cannot re-trigger it. Those changes belong to two small effects that write `term.options` on the running instance. Because `term` is a plain let (it is read in hundreds of places and must not make every effect that touches it reactive), those effects wait on `termGen` — a `$state` counter bumped once per build, after the instance is complete — and read their reactive inputs BEFORE the `!term` guard. Reason (review, 2026-09-03): both live effects used to start with `if (!term) return`, ran once at mount before the terminal existed, tracked nothing and never ran again, while the lifecycle effect tracked everything — so a system light/dark auto-switch mid-sentence on the phone rebuilt the terminal and dropped the keyboard, and in a desktop split a click that flipped `active` on two cells rebuilt both. `Terminal.source.test.ts` pins the shape.

### Local input returns to the live tail

every send path calls `resumeLiveTail()` — drop the selection, stop momentum, unpin `touchScrolling`, snap to bottom, repaint from `lastContent`. Without it a suppressed render never recovers: the server skips frames whose state equals the last one it *sent*, so it never re-sends the one the client dropped, and the typed characters only appear when an unrelated repaint (resize / visibility / pane switch) happens. `unlockKeyboard()` must never `clearTimeout(endTouchScrollTimer)` — that timer is the only pending reset of `touchScrolling`.

### Snapshot replacement stays inside the synchronized frame

Snapshots include tmux history (`capture-pane -S -get_scrollback()`, default
500 lines) plus the pane; xterm's local history is also capped at 500. Replaying
a full snapshot restores that history. The old "permanent scrollback loss"
description was therefore a misdiagnosis, and simply deleting `term.clear()`
would append duplicate history on each replay.

The real defect (#109, 2026-09-09) was **synchronous** `clear()` before the
queued `write()`. It emits `onScroll` with `baseY = viewportY = 0`. While the
reader is in history, our handler mistakes that for a return to tail: it
clears `hasNewContent` (the `.to-tail` news indicator) and queues another
rewrite. Each rewrite can repeat the false transition.

`terminal-frame.ts` now wraps the existing body/padding/cursor bytes in ONE
queued synchronized-output write: `CSI ?2026h`, hide cursor, **CSI 3J**,
home, frame body, show cursor, `CSI ?2026l`. The erase is unconditional in
the byte stream (a no-op with empty history), so consecutive frames queued
before either is parsed still erase/rebuild in order. No out-of-band
`clear()`/`reset()`, second cache, delta renderer or extra scroll guard.
After restoring the viewport, the write callback derives the final tail/news
state directly: a history-free replacement may emit no scroll event at all.
The same `_writeToXtermNow` path handles updates, resize/reconnect and
tail/show replay; pane switches still create a fresh xterm. Hidden-frame
recording, scrollback deferral, input-to-tail and `.to-tail` remain unchanged.

Measured with **xterm 6.0.0**, **Chromium 152** (Node **22.23.2** for unit
tests): in a 60x8 terminal with 50 history rows, reading at viewport 12,
one requested old rewrite caused **8 completed redraws** (the probe cap),
8 false zero-scroll events and loss of the new-output flag. The in-frame
erase produced one redraw, no false-tail event, preserved the flag, and
kept the same history and viewport 12. Both versions ultimately displayed
the same text; this is not a claim of persistent history loss or a measured
text flash. Real-xterm tests also cover repeated snapshots, queued frame
ordering, resize, cursor/blank-row restoration and the bounded history.

### Ctrl keys must be tmux named keys

with `extended-keys on`, tmux DROPS raw C0 bytes (`send-keys -l $'\x03'`) sent to panes in extended key mode (`#{pane_key_mode}`=`Ext` — every modern agent TUI). `tmux::send_keys` literal mode therefore splits C0 bytes into named keys (`C-c`, `M-C-x`); don't bypass it.

### Operation feedback belongs to its operation and visible context (#167, 2026-09-12)

Terminal uses `ui/OperationFeedback` and `createFeedbackLifetime`, not a
private toast or timer. Copy and connection errors have separate local slots
in one unframed, centered stack at the former toast position. A successful
copy expires after the shared `COMPLETION_FEEDBACK_MS` and stays passive,
without Close. Review of #167 rejected a new focus/click target that vanishes
after 1500ms; only copy errors and the connection error expose Close.
Errors persist until
retry succeeds, dismissal or context invalidation. Copying cannot dismiss an
unrelated connection error, including when its success timer expires.
Two consecutive send failures publish `connectionUnstable` as an error;
one failure is still ignored, and a successful send clears that slot.
No notification, audio, transport retry or input queue is introduced here.

Capture the xterm instance, selection object, target, session and attempt
token before awaiting `copyText`. Only a still-current successful result may
clear that selection. Failure retains both selection and the Copy command
for retry; a stale result neither clears the new selection nor replaces its
feedback. Target/session changes, xterm lifecycle changes, the page becoming
hidden and document suspension invalidate feedback. Teardown cancels timers
and invalidates outstanding copies. This does not cancel an OS clipboard
request that already started. Desktop native copy remains native; the explicit
Copy toolbar is still the existing touch-capability path.

The original bugs were reproduced before changing production code with the
real Terminal and xterm **6.0.0**, Chromium **152.0.7977.64**, Svelte
**5.55.5**, Vite **6.4.2** and Node **22.23.2**: rejecting modern clipboard
copy and its fallback cleared `bravo`, and a first success timer erased a
later `Copied` before its own lifetime ended. The browser fixture controls
only RPC/clipboard boundaries and traces real xterm public APIs; the jsdom
mount tier's xterm prohibition is unchanged. Source contracts pin shared
ownership and identity guards; browser checks execute completions, context
changes and cleanup. The English/reduced-motion matrix passes 43 checks:
390x844 touch in light/DOM and dark/WebGL, 1440x900 pointer in light/DOM
and dark/WebGL, plus 1440x900 touch in dark/DOM. Pointer cases verify
connection feedback and rendering; touch cases also exercise the existing
Copy toolbar. Screenshots and pixel checks confirm nonblank real renderers;
the two feedback rectangles do not overlap. A build-only negative control
restoring unconditional selection clearing fails the copy-retry check while
the old-timer check stays green. Playwright **1.62.1** drives an isolated
agent-browser **0.35.2** session; all contexts, its daemon and the ephemeral
HTTP server close in `finally`. Evidence and runner are in
`temp/167-terminal/`.
These off-device tests do not establish Android/WebView clipboard activation,
IME ordering, physical touch or OS suspension behavior.

### xterm DA filtering

Filter device-attribute and device-status replies before forwarding to tmux.
`terminal-responses.ts` owns the filter, instantiated once per xterm lifecycle,
not once per `onData` callback and not shared between split panes.

Board #108 (2026-09-09): the old three anchored regexes assumed an entire
reply occupied exactly one callback. Injecting `ESC[?62;22` then `;52c`
forwarded both fragments, and a reply adjacent to other input bypassed the
same check. The filter now carries an unfinished ESC/CSI candidate between
callbacks, then applies the existing DA/DSR recognition to each completed
sequence. Ordinary text, malformed sequences and complete non-response
keys pass through unchanged. A 512-character cap releases overlong candidates
losslessly, preventing unbounded carry on malformed input.

There is no timing guess: an incomplete control prefix waits for its next
byte, and teardown drops it. The real bare Escape key and hardware Ctrl/Alt
shortcuts keep their existing capture-phase direct-send path, outside this
filter; complete arrow/function-key sequences on `onData` pass immediately.
Paste is explicitly literal, including pasted reply-shaped bytes, and does
not consume a pending response.

Measurement, `@xterm/xterm` **6.0.0**, Node **22.23.2**: the real parser emits
DA1 `ESC[?1;2c`, DA2 `ESC[>0;276;0c`, DSR `ESC[0n` and cursor position
`ESC[1;1R` as four complete `onData` events, even when the queries are split
across `write` calls. Its DA1 is not the reported `ESC[?62;22;52c`. Natural
response fragmentation was **not** reproduced; the regression is tested by
injecting fragments through the package's public `input` -> `onData` path.
Do not describe this measurement as proof of the original report's source.
Unit tests cover every split boundary, byte-wise and coalesced input, literal
paste, non-response keys, overflow and lifecycle reset; the source contract
pins the filter before forwarding and outside the callback.

### Motion: the terminal's box never animates, only the chrome around it

[motion.md](../features/motion.md) principle 9. `.term-wrap`, `.xterm-wrap` and a split `.cell`'s body carry no transform, transition or animation — a resting transform makes them a containing block (every fixed popover breaks) and a transitioning size makes the fit run on a mid-flight measurement; the retired `.xterm-wrap { transition: margin-top }` had one writer and it set 0. What moves is the chrome: the feedback stack, the selection handles and toolbar and the expanded chip strip fade in (`.appear`; their positions stay inline and instant), the to-tail button pops (app.css gives `.to-tail` its `pop-in`), the shortcut pills cross-fade colour on `--t-fast` with `transform` kept OUT of the list so the press `translateY(1px)` lands under the finger, and the window chips are keyed by window index with `animate:flip` on `moveMs()` so a renumbering moves the chip instead of repainting it. The collapse control is still a cut: the expanded bar and the collapsed chip are two different elements in two `{#if}` branches (pinned by `Terminal.source.test.ts`), so there is no one glyph to turn. A split cell's frame (`SplitView .cell`) cross-fades only its border colour and ring — colour is neither a containing block nor a size.

Hover / unfold / highlight (#86, 2026-09-04): resting on a window chip opens the ONE hover card (`use:hoverInfo` on the `.win-chip` wrapper — `index:name`, command, pane count, agent tag; the chip is passed `title={null}`, which AgentChip honours as "no native title", so the card is not doubled), and the to-tail button's card is a single note ("Back to the newest output"). Nothing unfolds and no highlight travels here: the chip strip scrolls and its chips are AgentChips, so the active chip is not a `.slide-pill` candidate, and the terminal's box stays untouched (principle 9 — the card is its own fixed layer and the action only adds listeners).
