# Terminal Sizing (cols × rows management)

## Context

xterm.js renders content into a fixed `(cols, rows)` grid. The grid must
match what will actually fit in the terminal's DOM container:

```
term.cols ≈ floor(termEl.clientWidth  / cellW)
term.rows ≈ floor(termEl.clientHeight / cellH)
```

If this equation breaks, the display degrades in a very visible way:

- `rows` too small → only the top half of the container shows content;
  the bottom half is empty terminal background because xterm has no
  lines to draw there.
- `rows` too large → xterm tries to render rows that are physically
  clipped, the cursor ends up off-screen, and input feels "wrong row".
- `cols` too small → visible wrapping that doesn't exist on the tmux
  side.
- `cols` too large → truncation, or last characters rendered past the
  visible edge.

Container size can change for many reasons on mobile:

- Orientation change / split-screen
- On-screen keyboard opening and closing
- Browser address bar retracting
- Safe-area insets updating
- User-triggered zoom in/out (`⌘+` or pinch)
- Font-size change (changes cell dimensions, not container, but the
  equation still needs re-evaluation)

## Keyboard as an overlay (agent TUIs)

The mobile keyboard used to be a resize like any other: it shrinks the visual
viewport, `--app-height` follows, the terminal box shrinks, the `ResizeObserver`
re-fits, and `resize_pane` tells tmux. tmux resizing a window makes the
foreground app redraw from scratch — and a full-screen agent CLI redraws its
whole conversation, which takes seconds on a long session. The user pays that
twice per keyboard toggle, on open and on close, which made typing on the phone
feel broken.

So for those apps the keyboard is treated as an **overlay** instead: the
terminal keeps its box (and therefore its cols×rows), stays bottom-anchored, and
the keyboard simply covers its top rows. tmux is never told anything, so nothing
redraws. The visible part is the bottom of the screen, which is exactly where a
chat TUI keeps its prompt.

Mechanically it is two lines of CSS and one class, and it deliberately does NOT
add a sizing trigger:

- `keepRowsOnKeyboard = isMobile && !!agentByBackend(liveAgent)` puts the
  `.keep-rows` class on the xterm host. `liveAgent` is the pane's `agent`,
  pushed by the server with every `current_command` change — the same
  process-derived verdict that paints the agent icons (board #260) — so
  "which apps are chat TUIs" has one answer.
- `html.keyboard-open .xterm-wrap.keep-rows` pins `height: var(--kb-locked-h)`
  with `position: absolute; bottom: 0`. `App.svelte` toggles that class in the
  same layout pass that shrinks `--app-height`, so the pinned height applies
  immediately: **the observed box never changes size**, the ResizeObserver
  remains the single re-fit trigger, and it simply has nothing to report.
- `--kb-locked-h` is written by `doResize` but only while the keyboard is DOWN,
  so it always holds the real unkeyboarded height (it changes with rotation,
  font size and split view). Capturing it with the keyboard up would pin the
  shrunken height — the bug rather than the fix.

Editors are deliberately excluded. `vim` repaints cheaply and genuinely needs to
lay itself out inside the visible area, so it keeps the resize behaviour.

Known edge: on a small screen with a tall keyboard the visible strip can be only
a few rows. That is inherent to an overlay, and still better than a full repaint
per keystroke session.

Verified against a real tmux server: with a `kiro-cli` pane the tmux window
stayed `151x27` across keyboard open AND close, while a `zsh` pane in the same
app went `27 → 8 → 27` rows as it always did.

## Earlier (removed) approach

The previous implementation had **six different code paths** all trying
to keep the equation satisfied:

1. `requestAnimationFrame(doResize)` at init.
2. `window.addEventListener('resize', ...)` with a 300ms debounce, with
   a mobile-specific "skip height-only changes" guard.
3. `window.addEventListener('keyboard-shift', ...)` with a 100ms delay
   that also reset a `lastFitCols/Rows` cache.
4. `window.addEventListener('terminal-refit', ...)` as an explicit
   "force refit" event, dispatched by `App.svelte` at 100ms and 500ms
   after keyboard close, and after zoom changes.
5. `$effect(() => { if (viewMode === 'terminal' && term) term.refresh(...) })`
   for the chat → terminal tab switch.
6. `ws-reconnected` event for post-reconnect refit.

Each was added to fix one observed bug. Together they drifted into a
state where:

- On Android, the IME open event is sometimes ignored by the guard in
  `App.svelte`'s `androidKeyboardHeight` handler (when the active
  element is a `<button>` instead of a textarea). `keyboard-shift` is
  not dispatched. The terminal stays at the pre-keyboard size while the
  keyboard physically covers the bottom half of the screen — resulting
  in the "only top half shows content" symptom users reported.
- The initial `requestAnimationFrame(doResize)` fires before xterm has
  actually rendered once, so `_renderService.dimensions.css.cell` is
  undefined and `calcFit` falls back to `fontSize * 0.6 / 1.2`. That
  estimate is off by a row or two for our font, so the first paint is
  sized slightly wrong and never self-corrects until something else
  (keyboard toggle, orientation change) triggers a re-fit.

Fixing this scenario-by-scenario kept producing "one more guard" style
patches — symptom fixes, not a root-cause fix.

## Decision

**One source of truth:** a `ResizeObserver(termEl)` is the only
trigger for re-fit.

The Android native height event still owns the upstream CSS viewport size.
Its stale-event guard must not discard an IME-open event merely because the
keyboard-toggle button is still the active element: Android can report the
height one task before xterm's hidden textarea receives focus. Such a height is
held for up to 500 ms and applied on the following text-input `focusin`; if no
focus arrives it is discarded as stale. A native height of zero always applies
immediately and clears any deferred open event. Once `--app-height` changes,
the `ResizeObserver(termEl)` remains the sole terminal re-fit trigger.

Rationale: every cause of container size change above ultimately
manifests as a change in `termEl.clientWidth` or `termEl.clientHeight`.
`ResizeObserver` observes exactly that, and its callback fires only
after layout is stable, so we don't hit the "clientHeight=0 mid-
transition" corner cases that the event-based approach drifted into.

**One extra trigger for the first render only:** xterm's real cell
metrics only become available after the first render. We attach
`term.onRender(...)` and re-fit once on its first fire. After that we
dispose the listener.

**What we keep, and why:**

- `keyboard-shift` event: still used, but ONLY to drive the keyboard
  lock/unlock state machine (see `terminal-gestures.md`). Sizing is
  not touched here — `--app-height` changes from `App.svelte` flow
  through normal CSS and show up as a `termEl` size change that the
  ResizeObserver catches.
- `ws-reconnected` event: this is not a sizing problem, it's a "we
  need to re-tell the server our cols/rows" problem. The server's
  resize tracker forgets per-connection state on disconnect. Kept as
  a distinct handler that re-sends `resize_pane`.
- The `pendingCols/Rows/Ts` server-echo reconciliation in
  `writeToXterm`. Unchanged.

### Two instances, one pane: the one that becomes visible asserts its size (2026-09-14, board #198)

Owner: "从 terminal 的右侧边栏点击 扩展到 terminal 面板后，画面的尺寸不对，应该加一次窗口尺寸的
设置到新的尺寸". The Hub drawer's Terminal and the Terminal page's Terminal can show
the SAME pane, and App keeps the page mounted in a hidden layer whose box never
changes on a tab switch. Each instance sends `resizePane` only from its
ResizeObserver, and only when its fit differs from its own xterm dims. So:
page shows codex (136×35) → Hub, drawer re-targets codex and sizes tmux to its
box (61×35) → Maximize: the page's target is unchanged, its box unchanged, no
observer tick, fit == dims → nothing sent → tmux stays 61×35 under a 1154px
box (reproduced on the desktop at 1440 against the live server). The rule:
**a terminal that becomes visible asserts its size once** — the `visible`
effect (which already replays the newest frame) calls `doResize({ assert:
true })`, which sends `resizePane` even when fit equals dims. Symmetric for the
drawer on the way back. Measured after: maximize with an unchanged target →
144×53 (that session's metrics); back to the Hub → the drawer's 64×53. The
equation above holds for whichever instance is on screen. `Terminal.source.test.ts`
pins the signature, the assert branch and the call in the visible effect.

### A hidden terminal never sizes the pane (2026-10-16, board #395)

Owner: "还有一个bug就是terminal侧边栏经常没有刷新 我点放大到全屏可能会好". #198's
last sentence assumed the hidden instance stays silent because "its observer
does not fire". It does fire: `visibility: hidden` keeps the page's box in
the layout, so the box follows every window resize, sidebar fold or drawer
drag, and each change ran `doResize` and sent the HIDDEN box's size. Measured
in a real browser (own gateway, Vite preview of main 0d8e56f4, Chromium,
1280×800): the pane opened once in the Terminal tab, then shown in the Chat
drawer (519 px box, tmux 64×47); narrowing the window to 1200 px made tmux
114×46, the hidden page's box. The drawer's xterm took that size too and
drew the left 512 px of a 912 px screen, so the right side and the bottom
rows were outside its box: a right-aligned status line (what agent CLIs
paint) was never seen to change, 1 of 5 one-second samples of the drawer's
bottom rows distinct, while the pane ticked every second. Toggling the
Terminal tab or "open in Terminal tab" put a box of that size on screen,
which is why it looked like fullscreen fixed it. A gateway restart did the
same through `onReconnected`, which re-sent every instance's size.

The rule: **only the instance on screen sizes the pane.** `doResize` returns
before measuring while `visible` is false (it still records the keyboard-free
height), and `onReconnected` re-sends the size of a shown terminal only; its
capture of a hidden one is recorded, not drawn. Coming back on screen asserts
the current size (#198), which is the only moment a hidden instance's size
matters. Same probe after the fix: tmux stays 64×47 while the hidden page's
box changes, and the drawer's bottom rows changed in 5 of 5 samples.

Two instances that are BOTH on screen (two split cells, or another client on
the same pane) still share one tmux size; the last to size it wins. That is
unchanged, and outside this rule. On the phone the Hub has no terminal drawer
(compact opens the Terminal tab), so the case does not arise there; a hidden
Terminal page is silent there too and asserts when shown.

Pinned by `Terminal.shared.mount.test.ts` (one real connection, the page's
and the drawer's Terminal on one pane, boxes and observers owned by the test:
the hidden page's box change sends nothing, the visible drawer's sends its
size, a reconnect re-sends the drawer's only, showing the page asserts its
current box) and `Terminal.source.test.ts` (the three gates where they live).

## Implementation sketch

```js
function doResize() {
  const fit = calcFit();
  if (!fit) return;
  if (fit.cols === term.cols && fit.rows === term.rows) return;
  queuePaneResize(fit.cols, fit.rows);
  term.resize(fit.cols, fit.rows);
  if (lastContent) writeToXterm(lastContent, lastCursor);
}

const resizeObs = new ResizeObserver(() => doResize());
resizeObs.observe(termEl);

let firstRenderDone = false;
const onFirstRender = term.onRender(() => {
  if (firstRenderDone) return;
  firstRenderDone = true;
  doResize();
});
```

`queuePaneResize` updates xterm immediately but debounces the server RPC for
120 ms. A burst of WebView zoom/layout observations therefore sends only the
final tmux size, preventing stale intermediate resize echoes from replacing the
new grid. The explicit `app-zoom-change` event runs one final fit after Tauri's
native WebView zoom promise and two layout frames have settled.

Cleanup disposes the observer, listeners, and pending resize timer.

`doResize` is exposed via a module-level `doResizeRef` so the
`fontSize` $effect (which doesn't live inside the same $effect scope)
can trigger a re-fit after a font-size change.

## Feedback loop safeguard

`term.resize()` can cause a tiny geometric change to the xterm DOM
(scrollbar width, internal wrapper sizing) which ResizeObserver would
re-report. The `if (fit.cols === term.cols && fit.rows === term.rows) return`
early-out in `doResize` breaks the potential loop cleanly: once the
equation is satisfied, no more resize is sent.

## Alternatives considered

- **Keep the event spaghetti, just add more guards.** Rejected: the
  symptom is a coordination failure between six independent triggers,
  more triggers make it worse.
- **Use `term.fit()` from @xterm/addon-fit.** Considered briefly. The
  addon wraps the same `calcFit` + `term.resize` logic we already have
  and doesn't help with the "when to fire" coordination problem. Our
  `calcFit` also handles the `!cellSize ready` case, which the addon
  throws on in some versions. Not worth the dependency.
- **Use `MutationObserver` on the container.** Wrong tool — it observes
  subtree changes, not box size.

## Lessons learned

- When multiple unrelated code paths are all trying to keep the same
  invariant alive, prefer observing the thing the invariant is about
  directly, rather than subscribing to every upstream cause.
- `requestAnimationFrame` is not a safe substitute for "wait until
  layout has measured the element". For xterm specifically, wait for
  `term.onRender` instead.
- Screen symptoms like "only the top half shows content" on mobile
  almost always point to a cols/rows ↔ container mismatch, not to a
  rendering bug. Check the sizing path first.
- Pane/window switching may clear mobile keyboard state, but it must never
  restore `--app-height` from the mobile `fullHeight` cache on desktop. That
  cache is initialized for keyboard handling and can predate a macOS window
  maximize; writing it during a pane switch shrinks the real terminal box even
  though xterm's fit calculation remains correct.
