# Desktop Split-Screen

## Context
On a phone there's only room for one tmux pane, but on the desktop app and wide
browser windows the screen can hold several. Split-screen tiles 2/3/4/6
independent terminal cells, each bound to any `session:window.pane`, so the user
can watch multiple agents / shells at once like a tiling terminal. Mobile and
narrow windows keep the single-pane behavior unchanged.

## Decision
Compose multiple existing `Terminal` instances in a CSS grid (`SplitView.svelte`)
rather than building a new multi-pane renderer. The server already multiplexes
subscriptions; the only client change required was making pane-output delivery
multi-listener.

## How It Works
- **ws.ts per-target registry** (the enabling change): `pane_output` / `pane_closed`
  are routed to a `Map<target, cb>` keyed listener instead of one shared
  callback. Each cell's `Terminal` registers its own target. See
  `websocket-client.md`.
- **Server**: no change. `Subscriptions` is a `HashMap<String,String>` and
  `subscription_loop` already pushes per subscribed target; N cells = N
  `subscribe` calls on one connection.
- **`SplitView.svelte`**: CSS grid (`.layout-{2,3,4,6}`), one `.cell` per entry,
  keyed by a stable `cell.id` so re-assigning a cell's target rebuilds only that
  Terminal. Each cell has a header (an `AgentChip` label + a pane picker popover
  populated by `listSessionsWithPanes()` + a close button) over the Terminal
  body. The picker (`sessions/PanePicker.svelte`) is the app's one popover
  mechanism since 2026-09-03: a fixed layer placed by `menuPlacement` from its
  opener (`trigger`, defaulting to the previous element sibling — Terminal's
  session chip), dismissed by outside pointerdown / Escape / resize / a scroll
  of any scroller that CONTAINS the opener — not the list itself, and not a
  terminal viewport scrolling under it as output arrives. SplitView passes an
  explicit 30px top-strip `anchor` because its opener fills the whole cell.
  It used to be `position:absolute; top:36px; left:6px` inside the caller's
  wrapper with a backdrop button: clipped at the viewport edge, deaf to Escape. `min-width:0; min-height:0` on cell/body is required so grid children
  shrink and each xterm's `ResizeObserver` sees its real box.
- **Focus / active cell**: clicking a cell sets `activeCellId` (visual border).
  Input routing is automatic — each Terminal has its own hidden xterm textarea;
  only the focused one receives keys. `activeCellId` is purely the highlight.
- **The layout menu is the shared `ui/ContextMenu`** (review, 2026-09-03):
  the top-right toggle opens it right-aligned from its own rect (`anchorOf`,
  `trigger` so the toggle's click closes as well as opens), one row per choice
  (single / 2 / 3 / 4 / 6 panes) with the current one `checked`. It was a
  hand-rolled `position:absolute` strip with a backdrop — no Escape, no close on
  scroll/resize, no viewport clamp — the last such panel in App.svelte. The
  single-pane Terminal's chip-bar copy of this menu (`terminal/Terminal.svelte`,
  `.win-split-btn`) opens the same `ContextMenu` with the same rows; the two
  toggles differ only in where they sit.
- **`App.svelte` state**: `splitLayout` (1 = single, else 2/3/4/6),
  `splitCells [{id,target,session,command}]`, `activeCellId`. The pre-existing
  single `terminalTarget` stays the source of truth for the Files page, nav
  pills, narrow-screen fallback, and persistence; the active cell mirrors into
  it via `assignCell`.
- **Gating**: `splitEligible = !isTouchDevice && innerWidth >= 900` (a
  `window.resize` effect keeps it live). Narrowing below 900 px collapses to the
  single Terminal on cell 0's pane; widening restores. Mobile never mounts
  SplitView.
- **Desktop launch size**: the Tauri window opens at `1200 × 760`, a landscape
  size above the split threshold that still fits common laptop work areas.
  This is only the initial size; users can freely resize the window narrower.
- **Layout toolbar**: a thin row at the top of the terminal page (`1·2·3·4·6`),
  rendered only when `splitEligible`. Reuses the surface/pill visual language.
- **Persistence**: `splitLayout` + `splitCells` ride in `tmux_state`. Restore is
  re-gated on `splitEligible`, so a desktop-saved layout degrades to single-pane
  on a phone.
- **Reconnect**: `resubscribeAll()` subscribes every populated cell (or the
  single target). Each mounted Terminal also re-subscribes itself via the
  `ws-reconnected` event.

## Interactions
- **fontSize**: one global prop → every cell re-fits when the terminal font-size
  setting changes. Cmd/Ctrl +/- scales the complete desktop WebView instead;
  every cell observes its resulting container size and re-fits.
- **Chat**: the separate chat view was removed 2026-07 (dead code); split cells are always plain terminals.
- **Files**: unchanged; overlays the whole terminal page and keys off the single
  `terminalSession`.

## Trade-offs
- N terminals = N subscriptions + N xterm instances; each runs its own 200 ms
  snapshot stream. Acceptable on desktop; gated off mobile.
- Cell 0 mirrors `terminalTarget` so the narrow-screen fallback shows the
  expected pane; reassigning the active cell updates the mirror.

## Rules and their reasons

### A cell's body is a flex column (2026-10-16, board #397)

Owner, 10-16: "terminal侧边栏经常没有刷新 我点放大到全屏可能会好 … 可能全屏也有可能".
Found by the validator during #395 and measured on main d77492f7 (own
gateway, Vite preview, Chromium 1280×800, two cells on two tmux windows, no
tmux client attached): a cell assigned to a window tmux had left at 80×24
got its WIDTH right (tmux 80×24 → 76×24) but kept 24 rows: its terminal box
was 384 px tall in a 790 px cell, and the bottom of the pane (an agent's
status line) never showed. `.cell-body` was a plain block, and `Terminal`'s
root is `flex: 1`, which only fills a flex parent; in a block it takes its
content height, and xterm's content is its rows. The fit measures that box,
finds the rows it already has, and holds them. A cell whose window tmux had
already sized tall looked fine for the same reason. Every other Terminal
host (the page's `.terminal-body`, the drawer's `.term-body`, the scratch
panel's `.scratch-body`) was already a flex container. `.cell-body` is now a
flex column; measured after: the fresh cell's box 738 px in its cell, tmux
80×24 → 58×46 within 1.2 s of the assignment, both cells' bottom rows
repainting 6 of 6 one-second samples; an empty cell's picker still fills its
cell. `lib/terminal/terminal-hosts.source.test.ts` parses every component
with the Svelte parser and asserts that the element a `<Terminal>` renders
directly into is a flex container (the mount tier has no layout); `{#if}`,
`{#each}`, `{#key}` and `{#await}` render in place, and a `<Terminal>` the
source cannot place (inside another component, a snippet, a dynamic element,
or at a file's root) is refused rather than guessed. It fails on main's
`SplitView.svelte`.

## Verification
See the plan's verification section: build (`npm run build`), run
`npm run tauri:dev`, then check single-pane regression, two panes streaming at
once, per-cell input/resize, close, pane death, reconnect, the narrow gate, and
persistence. Backend multi-subscribe + single-pane routing were verified against
the live server over one WS connection.
