# Terminal Gesture & Keyboard Architecture

## Context
xterm.js v6 has no mobile touch support. All touch interactions are custom. The keyboard must be explicitly controlled because Android IME aggressively re-shows keyboard on any textarea focus. Multiple gesture types must coexist without interference.

## First Principles
1. **A selection is an object, not a transient state.** Once made, it persists across scrolling, content updates, and finger lifts — until the user explicitly copies it (toolbar) or cancels it (tap outside, new long-press, pane switch, app background).
2. **Both endpoints are independently draggable.** Touch UIs since iPhoneOS 3.0 use draggable handles at each end of the selection. We do the same — there is no "one-shot select" path.
3. **Copy is explicit, never implicit.** A floating toolbar above the selection has a "Copy" button. There is no tap-to-copy heuristic, because heuristics produce clipboard pollution from stray taps.
4. **The selection's coordinate space is the buffer, not the viewport.** Endpoints are stored as absolute buffer rows. Scrolling moves the on-screen handle position, not the selection.

## Touch Modes
The touch handler is a single state machine driven by `touchMode`:

| Mode | How entered | What it does |
|------|-------------|--------------|
| `idle` | default | nothing |
| `down` | touchstart on terminal body (no selection-handle, no scrollbar) | starts long-press timer |
| `scrollbar` | touchstart on right 30px edge | proportional scroll-by-drag |
| `scroll` | `down` → accumulated signed movement reaches one line | inertial content scroll |
| `longpress-select` | `down` → 500ms hold | word-select; touchmove extends head |
| `handle-drag` | touchstart in a selection handle's capsule hit zone | moves that endpoint |

## Touchstart Hit-Test Order
1. **Toolbar button**: bow out — the button has its own pointer handler.
2. **Selection handle**: enter `handle-drag` inside its capsule, with same-row overlap divided at the midpoint and edge handles extending to the container edge.
3. **Scrollbar edge** (right 30px): `scrollbar`.
4. **Anywhere else**: `down`. Long-press timer arms.

## Selection Lifecycle

### Creation
- **Long-press (500ms)** anywhere outside an existing selection → word-select at that cell. Same touch can extend the selection by dragging the head.
- **xterm-native** (mouse double/triple-click on desktop, programmatic Cmd+A) is adopted via `term.onSelectionChange`. The handler converts xterm's *exclusive* end to our *inclusive* end and pins content updates.

### Persistence
While a selection exists:
- Content updates are **paused** (`touchScrolling = true`) so incoming tmux output doesn't wipe the visible selection.
- Scrolling is allowed; on each `term.onScroll` we recompute pixel positions of handles + toolbar. If the selection scrolls fully out of view, the toolbar hides; handles hide independently per side.
- The keyboard cannot open via tap (it only opens via the toolbar button — separate concern).
- Resize re-applies the selection to xterm via `term.select()` so the visual highlight tracks the new geometry.

### Endpoint Adjustment
Drag a handle within its hit zone. At **grab time** (`beginEndpointDrag`) the selection is rewritten so the grabbed endpoint becomes `head` and the stationary one becomes `anchor`; every subsequent touchmove rewrites *head only*. Dragging past the other endpoint flips the selection's direction naturally — the anchor physically cannot move. (Earlier code addressed endpoints by geometric role per-move; after a crossover the roles swapped under a stale `dragHandle`, so the next move perturbed the far endpoint and both ends jumped.)

Drag mapping details (all in `applyHandleDragAt` / grab-offset capture):
- **Grab-offset compensation in both axes**: at grab, record finger − endpoint-cell-centre delta (X and Y); subtract it on every move. First frame maps to exactly the cell the endpoint is already on — zero snap. No artificial "lift" above the finger.
- **Horizontal edge snap**: within `max(10px, 0.6·cellW)` of the container's left edge → col 0; symmetric on the right (excluding the scrollbar zone) → last col. Matches OS selection where dragging past the text edge reaches the line boundary.
- **Vertical edge auto-scroll**: holding a drag within 36 px of the top/bottom edge scrolls the viewport (rAF loop, speed ramps 0.25→2 rows/frame with proximity) and re-maps the endpoint each scrolled line, so selections extend beyond the visible screen — same as native text views.

### Termination
- **Toolbar Copy**: copy text, then clear.
- **Tap outside the selection** (clean tap on `down`, no scroll): clear.
- **Long-press outside the selection**: clear, then create new selection.
- **Pane switch / app background / xterm-native clear**: clear.
- **Any local input** (keystroke, shortcut button, paste): clear — see below.

## Input Returns to the Live Tail (`resumeLiveTail`)

Four states suppress rendering: a pinned selection, an unsettled touch scroll
(`touchScrolling`), a live momentum coast, and a viewport parked in scrollback
(`termAtBottom === false`, frames deferred as `hasNewContent`). None of them
used to end on input, which produced a display that looked broken: *you type
and nothing appears.*

Why it doesn't self-heal: the server only pushes a pane frame when the state
differs from the last one it **sent** (`state_key == prev → skip`). It has no
idea the client dropped a frame, so it never re-sends. `lastContent` keeps
advancing while the screen stays frozen, and the typed characters surface only
when some unrelated event (a resize, a visibility change, a pane switch)
happens to repaint — which is exactly why "switch to another tab and back"
appeared to fix it.

So every send path (`enqueueKeys`, and the paste branch that goes to
`paste_text` instead) calls `resumeLiveTail()` first: drop the selection, stop
the momentum coast, unpin `touchScrolling`, snap to the bottom, repaint from
`lastContent`. It early-returns when nothing is suppressed, so ordinary typing
costs one boolean check. This matches real terminals, where any keystroke
returns you to the live output and drops the selection.

Two traps worth keeping written down:

- **`unlockKeyboard()` used to `clearTimeout(endTouchScrollTimer)`.** That timer
  is the *only* pending reset of `touchScrolling` (armed for
  `TOUCH_END_DELAY_MS` = 500 ms after every scroll, longer with momentum).
  Opening the keyboard inside that window therefore pinned the display
  forever — the exact "I typed and the terminal froze" report. It now calls
  `resumeLiveTail()` instead of cancelling the reset.
- **Momentum outlives the snap.** Setting `termAtBottom = true` and
  `scrollToBottom()` while a coast is still running is pointless: the next
  coast frame scrolls straight back off the tail and re-arms the deferral.
  `resumeLiveTail` must `stopMomentum()` (measured, not theorised — typing
  mid-coast reproduced it).

## Coordinate Model
- `selection = { anchor: {row, col}, head: {row, col} }`
- `row` is **absolute buffer row** (not viewport-relative). Stable across scrolling.
- `col` is 0..cols-1, **inclusive** on both endpoints.
- `selStart(s)` / `selEnd(s)` derive the geometric (top-left, bottom-right) ordering from `anchor`/`head`.

The xterm.js API is converted at the boundary:
- `applySelectionToXterm()` calls `term.select(start.col, start.row, length)` where `length` spans the inclusive range.
- `onSelectionChange` reads `term.getSelectionPosition()` whose `pos.end.x` is exclusive, and converts to inclusive (`max(0, pos.end.x - 1)`).

### Selection Decision Ownership (#140, 2026-09-09)

`selection-model.ts` now owns the previously inline range containment,
inclusive length, endpoint re-anchoring, exclusive-end conversion and
word-boundary scan. `Selection` remains the one anchor/head definition;
`selStart` and `selEnd` are unchanged. The component still owns selection
state, guards before applying/re-anchoring or adopting a native selection,
xterm calls, the reentrancy guard, UI measurement and render pin, in the same
order. Range containment and absent-string fallback belong to the pure model.

This is a mechanical move, not a correction to boundary semantics:
length retains its one-cell floor, `end.x=0` retains the next-row col-0
clamp, and word scanning still indexes the already-translated UTF-16 string
and splits only at whitespace. Buffer-line reads stay in Terminal; the
model has no DOM, xterm, clock or Svelte dependency. Do not introduce a
second selection shape or a Unicode-width engine here.

Unit vectors cover absent ranges/strings, inclusive row/column edges,
resized-grid length flooring, equal/reversed endpoints and repeated
crossings, conversion and string boundaries. The source contracts follow
ownership: numeric rules live in the model tests, while Terminal tests pin
the real helper calls and unchanged side-effect guards.

The five lifted formulas/bodies match their originals after parameter/return
normalization. The #139 comparison preserves all 92 final-state/geometry
signatures and xterm selection arguments; 88 PNGs match byte-for-byte, with
the other four differing only in the unchanged 1.5s Copied toast's capture
timing. Reversing the grabbed endpoint fails the crossover unit vector and
real-component browser check. Android validation remains deferred.

## Handle UI
- Visual: 12px filled circle in `var(--accent)`, with a 2px-wide stem one cell high. The positioned wrapper has zero width/height; pseudo-elements draw the stem and dot.
- Position: the leading anchor is the start cell's top-left corner, its stem runs down through the cell, and its dot sits below. The trailing anchor is the end cell's bottom-right corner, its stem runs up, and its dot also sits below. Edge dots shift 6px inward without moving the stem.
- Hit zone: 28px half-width around each anchor. The leading Y interval is `startY - 11` through `startY + cellH + 22`; trailing is `endY - cellH - 11` through `endY + 22`. Same-row overlap divides at the horizontal midpoint (the leading handle is tested first). At column 0 / the final column, the respective X interval extends to the container edge. Handle hit testing precedes the scrollbar's 30px zone.

**Documentation correction (#139, 2026-09-09):** these are the existing
`hitHandle` and CSS rules from `7bf035c6`, not a new hit-target design. The
former 22px-radius/44px-wrapper description had drifted from the implementation.

### Numeric Geometry Ownership (#141, 2026-09-09)

`terminal-gesture-geometry.ts` first takes the point-to-cell, grab-offset and
horizontal-snap formulas. Inputs are measured numbers; the module does not
read DOM, xterm or a clock. Terminal still reads the actual client rectangle
and the one `cellSize` source at the original call sites, including the nested
cell mapping during a handle drag. Nothing stores geometry between gestures.
Buffer-row conversion and the existing writes to the drag state stay in
their adapters.

Boundary vectors pin flooring/clamping, nonzero origins, fractional and
changed measurements, compensation in both axes, inclusive snap edges and
the left-edge priority in overlapping zones. This is a mechanical move;
it does not retune thresholds or change coordinate systems.
The three formulas and metric-read order match the original AST. Moving
the 10px snap minimum to 11px fails the just-inside boundary vector;
restoring it returns green.

The second mechanical commit moves `selectionView` and `hitSelectionHandle`.
They reuse the canonical selection ordering and return the existing derived
UI coordinates or handle identity; `SelectionUI` is a projection, not another
selection store or a saved measurement. Missing selection/element and
zero-cell-metric guards remain in Terminal, before the same live reads.
The five formula bodies, the `cellSize` implementation and measurement-call
order match the pre-extraction code; markup/CSS and gesture scheduling stay
unchanged.

Projection/hit vectors cover independent offscreen endpoints, strict toolbar
flip boundaries, horizontal clamping, fractional metrics, capsule edges,
same-row midpoint ties and the handle occupying the scrollbar touch zone.
At this step the row-3 Copy anchor (26px, producing the measured -16px clipping)
was pinned deliberately; the separate #143 correction is recorded below.

Chromium 152.0.7977.64 with real xterm 6.0.0 reproduces #140's 92
state/geometry signatures and selection-call arguments. 88 PNGs are
byte-identical; the four Copy captures differ only in the unchanged toast's
1.5s lifetime. A separate touch 3px inside the right edge still drags the
handle. The negative control excludes that scrollbar-width region from the
end capsule: the unit vector fails and the real component calls
`scrollToLine`, leaving column 40 instead of moving to 36. Restoring the
capsule restores the drag. These are off-device checks, not Android IME or
physical-touch verification.

## Toolbar UI
- Single "Copy" button (one job, one button).
- Default: above the selection's first row, horizontally centered between start and end (or roughly above the start cell when the selection spans multiple rows).
- If the rendered top would be above the 8px inset, flips below the
  selection's last row. If that side cannot fit, uses the first visible
  handle's other side, then clamps the rendered box to the viewport.
- X is clamped to `[48, container_width - 48]` so the toolbar never escapes its container.
- `pointerdown` handler stops propagation and calls `copySelection()` — the touchstart hit-test on the underlying `termEl` would otherwise treat it as a tap and try to cancel the selection.

### Rules and Their Reasons (#143, 2026-09-09)

Flip/clamp decisions use the **rendered toolbar rectangle**, not its CSS
anchor. The above placement translates upward by 100% of its own height:
on Chromium 152.0.7977.64 / xterm 6.0.0 at 390x844, viewport row 3 had
anchor 26px and a 42px toolbar, so its top was -16px. The old `anchor < 8`
test missed this; row 4 even placed the rendered top directly at 0px.

Root binds the actual `offsetHeight`, including borders but excluding
CSS zoom and animation transforms. The initial unmeasured toolbar is
invisible until that size arrives. `selUI` is now derived from the canonical
selection, measurements captured at the same existing selection/scroll/resize
sites, and toolbar height. A size change re-runs only the existing
`selectionView` decision; it does not add a gesture listener, timer or
terminal resize trigger. Root supplies the clipping parent's CSS height,
not a possibly taller keyboard-pinned xterm grid. No fixed 42px estimate,
second placement function, selection store or controller port is introduced.

Prefer above the first row when its whole rectangle fits with the existing
8px inset. Otherwise preserve the 22px handle clearance below the final
row. For a long selection reaching the bottom, prefer below the leading
handle; when only the trailing handle is visible, use above it instead.
If the viewport cannot accommodate those clearances, clamp the actual box
inside it; reduce the outer inset only when necessary to fit. A viewport
shorter than the toolbar itself cannot contain it without resizing the
control, which is not part of this fix. Handle coordinates, hit zones,
horizontal centering/clamp, selection, Copy and gesture behavior are unchanged.

Regression vectors cover the original row-3 failure, fractional measured
heights at the strict boundary, long and partially offscreen selections,
and short clip boxes. The Root contract pins border-box binding, hidden
first measurement and the one derived geometry call. These deliberately
replace #141's provisional/unmeasured anchor assertion, not its handle
geometry vectors.

Verification: all five regressions failed before the fix. Chromium checks
68 rectangles across portrait/landscape, DOM/WebGL, 1.25 UI zoom and a wide
touch viewport; row 3 now occupies y=86..128 instead of -16..26. Single-row
cases retain 22px handle clearance, Copy reaches the clipboard, and changing
the measured toolbar from 42px to 73px repositions it without a new gesture.
The terminal's existing counter-zoom keeps those dimensions unscaled.
Ordinary 1440x900 desktop mouse selection and input-to-tail also pass.
Replacing only the geometry module with its pre-fix version makes both the
five unit regressions and the Chromium top-edge assertion fail again.
These are off-device checks, not the owner Android pass pending on #148.

## Keyboard Control

### States
- `inputmode="text"` is pinned at mobile textarea initialization.
- `kbLocked = true` makes the focus handler immediately blur the textarea.
- `kbLocked = false` permits focus; explicit unlock blurs an already-focused
  textarea before focusing it again so a dismissed IME can reopen.

### Transitions
| From | Event | To | Action |
|------|-------|----|--------|
| either | double-tap on terminal (two clean `down` taps ≤300ms, ≤40px apart, no selection) | unlocked | `unlockKeyboard()`; the second touchend is `preventDefault`ed so no synthetic dblclick reaches xterm |
| locked | single tap on terminal | locked | no-op |
| unlocked | single tap on terminal | unlocked | no-op |
| unlocked | textarea blur (150ms timer) | locked (or retry focus if in grace) | grace → re-focus, at most twice; otherwise lock |
| unlocked | keyboard-shift kbH=0 (was >0, post-grace) | locked | lock, blur |
| either | bar close key (shown only under `keyboard-open`) | locked | end grace, lock, blur |
| unlocked | pane switch | locked | reset |

**Documentation correction (#139, 2026-09-09):** `a228b41c` records why
none/text toggling was retired: Android's first InputConnection could cache
the original `none` value and ignore the first attempt to open the IME.
The toggle reads the actual `keyboard-open` class, not `kbLocked`, since a
system IME close can leave the textarea focused. This documents the current
focus-gated implementation; it does not claim a new Android verification.

### Key Rules
1. **Two ways to open the keyboard, both through `unlockKeyboard()`: the toggle button and a double-tap on the terminal.** A single tap never opens or closes it. The double-tap is detected on `touchend` by `createDoubleTapDetector` (`ui/double-tap.ts` since board #484, re-exported by `terminal-keyboard.ts`; the app's one pair rule) and fed ONLY from the clean-tap (`down`) branch — a scroll, scrollbar drag, long-press or handle drag between two taps resets the pair, and a tap that cancels a selection is spent on the cancel. (Until 2026-09-03 the docs promised this gesture while the toggle was the only caller; `Terminal.source.test.ts` now pins both callers.)
2. **`endTouchScroll` does NOT change `kbLocked`** (was causing race conditions with delayed timers).
3. **`endTouchScroll` is a no-op while a selection exists** — releasing `touchScrolling=false` would let writeToXterm clear+rewrite, wiping xterm's native highlight.
4. **keyboard-shift kbH=0** locks only on the open→close falling edge.
5. **Nav buttons have tabindex=-1** — prevents focus stealing.

## Tab Swipe Suppression (App level)
The App-level horizontal tab swipe is suppressed when:
- `e.defaultPrevented` on touchmove (terminal scroll, selection drag, handle drag, scrollbar drag all call `preventDefault`)
- Vertical movement > 10px

## Auto-pair Textarea Clearing
Mobile keyboards auto-pair quotes/brackets (`""`, `()`, `[]`). Force-clear textarea after each `onData` on mobile, EXCEPT during paste (detected via paste event flag, NOT `data.length`) and during active IME composition.

## Lessons Learned
- `endTouchScroll` via setTimeout can fire after explicit unlock → removed kbLocked manipulation.
- `data.length <= 1` misclassifies auto-paired input as paste → use paste event flag.
- Android `OnGlobalLayoutListener` can fire stale keyboard heights → guard with activeElement check.
- "Tap inside selection to copy" looked clever but was ambiguous — users couldn't tell whether the selection was "live", and a stray tap could wipe their clipboard. Replaced with an explicit toolbar.
- One-shot selection (no handles) made tmux text capture frustrating: misjudge by one cell and you re-select from scratch. Handles let users do the rough cut at long-press, then nudge.
- `pos.end.x` from xterm is exclusive while our long-press path stored inclusive — mixing the two caused intermittent "tap copies anywhere" because the hit-test sometimes used a 1-cell-too-wide rect. Now `selection` is canonically inclusive everywhere; only the xterm boundary translates.

## Fixed-Frame Motion

The existing release calculation weights up to five velocity samples from
the last 100ms, multiplies the average px/ms by 16 and caps it at
`MOMENTUM_MAX_PX = 240` before converting to lines/frame. Coast starts above
0.1 line/frame, multiplies velocity by 0.95 before accumulating each frame,
and stops at 0.05 or below. Both scroll paths retain signed fractional
remainders with `Math.trunc`. Edge dragging uses a 36px zone and ramps from
0.25 to 2 rows/frame. These are current fixed-frame rules, not a claim of
refresh-rate-independent physics.

Documentation correction (#139, 2026-09-09): the release comment said 120px
while the executable cap was already 240px. The comment now matches the
constant. Characterization pins that value; extraction must not tune it or
change the time model.

### Motion Decision Ownership (#142, 2026-09-09)

`terminal-gesture-motion.ts` now owns sample collection, whole-line/remainder
splitting, weighted release velocity, a coast frame and edge direction/frame
calculations. Time and frame state are inputs; the module has no browser,
timer, xterm or Svelte dependency. One signed `Math.trunc` splitter serves
pixel scrolling (with the measured line height) and line-unit coasts.

The sample helper returns a bounded copy instead of mutating its input.
At this step Terminal remained the sole owner of that private list, assigning the result
at the old collection point; existing sample objects are retained. Pruning
still happens on collection, not through a new release-time age check.
Same-time/backward clocks retain the one-millisecond denominator floor.

At this step all scheduling and mode transitions stayed in the closure: the nonempty
sample guard and strict `>0.1` coast-start condition, rAF ownership/cancel,
200/500ms release paths, and edge-drag stop conditions are unchanged.
Accumulated state is published before `scrollLines`, and its remainder
after that call, as before. Fixed-frame friction and speed are not converted
to elapsed-time physics. Selection, keyboard lock, input-to-tail and
hidden-frame rules remain their existing mechanisms.

Sixteen unit cases cover the 100ms/five-sample boundaries, clock reversal,
signed fractional carry, weighting/capping, decay termination and edge ramps.
The formula/AST audit also checks scheduling-call and mode-write order.
On Chromium 152.0.7977.64 with real xterm 6.0.0, the original and extracted
code both scroll `+3` / `-3` lines over four live coast frames after release;
input then cancels the queued coast. Changing `Math.trunc` to `Math.floor`
fails the unit vector and produces `-4` instead of `-3` in the real browser.
Restoring truncation returns green.

The 92-state #141 matrix still matches, including selection API arguments;
88 PNGs are byte-identical and four Copy captures differ only in the existing
toast timing. This is not a physical Android/IME verification. The controller
boundary was re-reviewed after these pure moves landed; #148 below records
the approved state/timer move. Listener ownership does not move.

## Controller Boundary Preparation (#148, 2026-09-09)

Before moving the controller, Root groups its existing operations into the
18 approved synchronous adapters. The three state queries read live values;
constructing the adapter object invokes none of them. Compound selection
and scrollbar commands retain their existing read/action order, including
re-anchoring before grab measurement and inline keyboard unlock after the
second touchend prevents default. This grouping does not move gesture state,
timers, listeners, selection or rendering ownership.
Expanding the adapters restores the original Root AST, including read/action
order. The 92-state Chromium baseline matches; the four nonidentical Copy
PNGs differ only in the existing toast timing.

## Controller Ownership (#148, 2026-09-09)

The second commit moves the procedural controller, not the xterm lifecycle,
into `createTerminalGestures` in `terminal-gestures.ts`. One inert factory
replaces the old state group inside the target-only lifecycle: construction
does not query Root, perform a command or schedule work. It owns the same
21 transient bindings (including existing redundant fields), four touch
handlers, edge loop, hold timer, momentum/edge rAFs and double-tap detector.
Selection/model/geometry/motion definitions remain in their existing modules.

The boundary is deliberately bounded, not a mutable component-context bag:

- 18 live Root operations: `available`, `hasSelection`, `isPinned`,
  `pinUpdates`, `requestRenderRelease`, `hitHandle`, `grabHandle`,
  `dragHeadAt`, `extendHeadAt`, `tryWordSelection`, `clearSelectionOutside`,
  `isScrollbarPoint`, `scrollPosition`, `dragScrollbar`, `lineHeight`,
  `edgeBounds`, `scrollLines`, `openFromDoubleTap`.
- Six environment operations: `now`, `setDelay`, `clearDelay`,
  `requestFrame`, `cancelFrame`, `vibrate`. No browser global is read inside
  the controller; `target.closest` uses only the supplied event target.
- Ten returned operations: `onTouchStart`, `onTouchMove`, `onTouchEnd`,
  `onTouchCancel`, `isIdle`, `isCoasting`, `stopMomentum`,
  `resetAfterVisibility`, `cancelHold`, `dispose`.

Root keeps selection/UI, native selection/scroll adoption, geometry reads,
input/tail/news, rendering, keyboard, clipboard, visibility/RPC recovery and
listener installation/removal. The same four handler references are installed
at the old positions: start/cancel passive, move/end non-passive. Double-tap
still invokes the labelled Root unlock synchronously after preventing default.

**The render-release timer stays in Root.** `endTouchScrollTimer`,
`scheduleEndTouchScroll` and `endTouchScroll` also serve input and repaint,
so the controller requests 100/200/500ms release without owning its timer
or another copy of the render pin. `resumeLiveTail` queries/stops the coast
before its existing release/tail/replay sequence. The selection-clear paths
query live idle state. Visibility reset is not touchcancel: it only resets
the original mode/drag fields and stops coasts, without newly cancelling
hold, resetting the double-tap pair or requesting release.

Teardown retains two slots: `cancelHold` at the old pre-keyboard-cleanup
position, then `dispose` at the old coast/edge-cancellation position.
Disposal cancels owned work only, never selection, pin, keyboard or replay.
The controller move preserved extra-finger/end-touch semantics and #143
toolbar clipping; the latter is corrected separately in the Rules above.

`terminal-gestures.test.ts` executes transitions, live queries, call ordering,
hold/coast/edge scheduling, disposal and independent instances with injected
time and narrow Root spies. Small jsdom 30 event fixtures execute `closest`,
cancelability, synchronous prevention/opening and listener teardown. These
are not fake-xterm rendering tests. Source contracts deliberately follow the
new owners: Root wiring stays in `Terminal.source.test.ts`; gesture execution
replaces its old inline-body assertions. `mount.ts` still rejects xterm,
and no dependency or runner was added.

The nine moved functions and 21 bindings match their originals after
type/port normalization; reinserting the regions restores the entire Root
AST and markup/CSS are byte-identical. Copying selection/pin at construction,
giving the scrollbar priority over a handle, dropping hold/coast cleanup or
retaining a cancelled/spent tap each fails its negative-controlled test.

Measured on Chromium 152.0.7977.64, xterm 6.0.0, Node 22.23.2 and
Svelte 5.53.5: all 92 state/geometry signatures, selection arguments and
92 PNGs match the first commit byte-for-byte across the eight desktop/compact
DOM/WebGL combinations. Both builds coast +3/-3 lines over four live frames,
then real xterm input stops the coast at tail. Omitting only Root's input
`stopMomentum` call in a separate test build leaves viewport 49 instead
of tail 53; the normal build restores the passing trace. The full 745-test
suite and svelte-check pass. Terminal.svelte is 2269 lines; the controller
is 362 lines. Reproducer and logs are referenced on #148.

**Android acceptance is still pending.** Code may reach review, but #148
does not become done until the owner records the seven checks on #138 against
the candidate APK/build hash and device/WebView/IME configuration. Desktop
Chromium and jsdom cannot establish physical touch batching, fling feel,
haptics, real activation/compatibility events, InputConnection/IME ordering,
native insets or OS suspension. The lead schedules that pass.

## Characterization Before Extraction

Board #139 (2026-09-09) adds source contracts and a real-Terminal Chromium
baseline before moving these decisions. Five additional source cases pin
text-mode focus gating, gesture priority/passivity/cleanup, inclusive selection
and its render pin, endpoint/capsule geometry, and fixed-frame motion.
They do not execute touch handlers or simulate layout.

The browser fixture uses actual xterm 6.0.0 with controlled RPC replies and
build-layer public-API trace wrappers, never replacement parsing/rendering
logic. Eight desktop/compact, theme/motion and DOM/WebGL combinations record
92 state signatures and viewport-sized PNGs: selection/viewport/handle/toolbar
rectangles, action traces, crossing and edge-cancel, explicit Copy, input
interrupting momentum, focus pairing, font/line-height/zoom, hidden replay
and pane disposal. Touch events are constructed in Chromium with controlled
timestamps; mouse selection/Copy and screenshots use Playwright. Both the
real DOM fallback and WebGL renderer were exercised. The fixture, logs and
images are referenced on #139.

Measured versions: Chromium 152.0.7977.64, Node 22.23.2, Svelte 5.53.5 and
Vite 6.4.1. Changing only the hit half-width from 28px to 8px fails the
source contract and the 24px-offset grab: the endpoint remains at column 14
instead of moving to 20. Restoring the original source returns green.
Production behavior, markup and CSS are unchanged.

The baseline deliberately retains a discovered defect (#143): a row-3
selection anchors Copy at 26px, but its 42px height and upward transform put
its top at -16px under the clipped container. Fix it separately rather than
silently changing toolbar placement during extraction.

No Android pass was performed. These results cannot establish physical
touch batching, fling feel, user activation, IME composition/height ordering,
haptics or OS suspension behavior; the owner pass in #138 remains a gate
for the later controller move, not for these off-device characterizations.
