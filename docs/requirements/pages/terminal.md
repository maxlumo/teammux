# Terminal Page

## Purpose
Primary view for interacting with tmux panes. Renders terminal output with ANSI colors, provides touch-optimized scrolling and input for mobile devices.

## Components

- **ONE bar, and it belongs to the terminal.** The sidebar renders with
  `chips={false}`: its MRU quick-switch strip is justified when the list is a
  whole page, but beside a terminal that already has a window bar it was a
  second switcher stacked on the first (owner report). Search survives the row
  — it moves to the sidebar's bottom bar. The terminal's own bar is the
  coordinate strip: every window chip reads `<index>:<name>` (an agent window
  keeps its backend icon AND shows the agent's name — a bare icon said "a kiro
  is here" but not WHICH agent, useless in a project running three), the
  session chip sits at the far left, and `+` adds a window.
- **The session list is part of this page** (the Sessions tab was retired into
  it, 2026-08-18): `.term-page` is a two-column grid — a 280px session/window
  list (`src/lib/sessions/Sessions.svelte`, 240px was too narrow for its
  project cards) plus the terminal. On a touch layout the column becomes a
  slide-over sheet: the switcher's session chip opens it (instead of the
  smaller pane popover, which stays for desktop where the column is already
  visible), and picking a pane closes it via `onPick`. On a compact phone the
  sheet is Terminal's **Back floor** (board #58): Back on a bare Terminal opens
  it; Back while it is open falls through/re-pushes and leaves it open, so the
  gesture cannot cycle close→open or leave the page. A Terminal reached through
  Chat's jump slot returns to Chat before this ordinary floor is considered.
  Terminal remains the connect/fallback landing everywhere.
- **Several servers** (board #335 ③): every server's Terminal page is its own
  tree over its own socket — a pane stream reaches only the tree whose server
  sent it, and a split stays within one tree (no cross-server split). In
  Aggregate the focused page's session list adds, under its own sessions, an
  **Other servers** section: every other included server's sessions, tagged
  with the server (`ui/ServerTag`), as a SELECTOR — picking one moves the
  focus to that server and opens the pane there; the panes, kill, search and
  the pane picker above stay this server's, and the section is not searched.
  **On the phone** (board #357, owner 2026-10-13: "在 Terminal 页面…都没有
  整合…所有项目") the session sheet is ONE list: the other servers' sessions
  are rows of the main list, each with its tag on its own second line — the
  bottom section the phone rarely scrolls to is gone there. The desktop
  sidebar keeps the grouped section. **Where a foreign row sits** (board #371,
  owner 2026-10-14: the phone's Terminal sheet read as Single while the Chat
  sidebar beside it listed both servers — #357 had parked the foreign rows
  AFTER this server's whole project list, past the fold of a long one): in
  Aggregate the sheet is ONE list in the Hub's order — live first, then
  recency, each row by ITS OWN server's clock — with every row, this
  server's too, wearing the Chat sidebar's tag line; a foreign live row sits
  where its recency puts it among this server's live rows, never parked last
  and never forced first. Single has no tag and no foreign row. A foreign
  session with no project row on its server (an untracked one) is live with no
  recorded activity: after every live row that has some, before the stopped
  projects. A server that has not published is a status, named above the list.
  A foreign row
  shows the NAME of the declared project its session belongs to when that
  differs from the session (the identity the local row shows) and opens by the
  session. The Terminal's union is of LIVE sessions only: a Terminal is about
  live panes, and another server's declared-but-stopped projects are in the
  Hub and Board unions: the Hub's row opens that project (focus move, then
  that server's own Open); the Board's row lands on that project's board, a
  read — the Board starts nothing. With another server's rows listed, an empty list on this server
  says "No sessions on this server"; search stays this server's.
  A server whose list has not arrived is listed as "no list yet". The section
  never waits for this server's own first Projects answer. In Single with
  more servers saved the sidebar ends with the Hub's "Showing <server> only ·
  N more saved" row (#364, hub.md). A hidden member's
  page keeps its list current on the same 20 s list cadence the Hub uses
  (one `list_sessions_with_panes` per tick, nothing of a pane) and on its
  server's reconnect; the shown page has no poll of its own. The page head
  wears the server tag when more than one server is included; the system
  status strip beside the sidebar shows the FOCUSED server's reading only,
  named in Aggregate.

- The Terminal tab and its always-mounted page layer are available immediately
  after connecting, even before a pane has been selected. With no active target,
  the page renders a stable empty state; opening a pane from Sessions or Team
  fills that same layer instead of creating the tab on demand.
- Window chips and the all-session pane picker carry NO unread attention dots
  (retired 2026-09-01 with the notification inbox): an agent's backend icon
  still marks WHAT runs in a window, while "finished/needs attention" lives in
  the Hub room (auto-posted replies + read cursor) and the derived status
  dots. Source tests pin the absence.
- Expanded window-switcher chips and every mobile shortcut-key button share a 24px control height and pill geometry. Their text and icons use the same 1px optical baseline correction so visible glyphs are vertically centered. Shortcut rows add no vertical padding, preserving terminal viewport space.
- xterm.js v6 terminal emulator with theme-aware color schemes (light/dark)
- Shortcut buttons: Esc, Ctrl, ^C, Tab, arrows — with long-press repeat for repeatable keys
- Last slot of the bar: Enter (↩, sent once) while the on-screen keyboard is down, close-keyboard while it is up
- Collapsible window switcher:
  - **Collapsed**: a single chip in the top-right corner (uses the shared
    AgentChip component — same visual language as every other chip in the
    app). Shows the current window's agent icon or command name plus a
    small chevron-left indicator (pointing toward where the bar would
    expand from). Positioned absolute so it does not steal a row from
    the terminal viewport.
  - **Expanded**: horizontal tab bar pinned to the top of the Terminal
    view. The first chip is the current session name, rendered with the same
    text-only active style as the Sessions page chip strip; tapping it opens
    the all-session pane picker. The remaining scrollable chips contain only
    windows from the current session plus the `+ new window` button. A
    chevron-right button on the right collapses the bar back into the single
    chip (toward where the collapsed chip will live).
  - Recognized coding-agent panes render as icon-only chips in both the current-session bar and the all-session pane picker; process names such as `kiro-cli-chat` and `node` remain available in the desktop hover title but are not shown beside the logo.
  - All chips in both states are the same `AgentChip` component — same
    height, same padding, same font. The switcher has one size in its
    expanded state and a smaller footprint in its collapsed state, not
    two different visual languages.
  - State (collapsed vs expanded) is persisted in localStorage.
- Floating **back-to-tail** button wears the app-wide `.to-tail` control
  shared with Chat: 38px token-surface circle, quiet ink with accent hover,
  scale press, invisible 44px touch target, and the same token-red `.news`
  dot when deferred output is waiting. Terminal owns only its bottom/right/z
  placement; no glass/square/span-dot variant (board #49).
- Status bar: session:pane and running command

## Interactions (Mobile)
- **Double-tap terminal** → open keyboard (single tap does nothing)
- **Last bar key** → Enter while the keyboard is down (double-tap opens it); closes the keyboard while it is up
- **Vertical swipe** → scroll terminal content (momentum physics)
- **Long-press (500ms)** → select a word, then drag either endpoint handle to extend or reverse the selection
- **Selection toolbar** → explicitly copy the selected text; tapping outside or switching panes cancels the selection
- **Swipe right edge** → scrollbar drag
- **Tap shortcut button** → sends key sequence; long-press repeats
- **Tap Ctrl** → arms a one-shot modifier (the pill highlights); the next letter typed on the system keyboard sends Ctrl+letter, then Ctrl releases. It also releases when tapped again, on a shortcut-bar key, on pane switch, when the terminal loses focus, and on its own after 4 s — the highlight drops with it
- **Horizontal swipe (App level)** → switch tabs (lowest priority, suppressed by all above)

## Interactions (Desktop)
- **Empty state "Sessions" button** (no pane selected) → moves keyboard focus into the Sessions sidebar (first list row, or the create row when nothing is listed); the sidebar is already the left column on the desktop, so the button has nothing to slide open. On a touch layout the same button lifts the session drawer. One opener (`openSessionsList` in `App.svelte`) serves both
- App-configured shortcuts are consumed before terminal input
- Clicking an HTTP(S) URL opens the system browser and never navigates the app
  WebView
- Every unassigned hardware Ctrl / Option combination is encoded as terminal input and sent to tmux, including Ctrl+X, Ctrl+F, letters, punctuation, navigation keys, and F1–F12; touch-capable desktop browsers and devices with attached keyboards follow the same path
- Cmd combinations remain owned by the macOS app/browser unless explicitly configured as an app shortcut
- **Scratch terminal** (board #324, #326): a control in the system status bar or ⌘⌥` / Ctrl+Alt+` slides a panel in from the bottom or the right (two icons in its head) with a shell in `$HOME` that belongs to no project; × or the toggle hides it and the shell keeps running; `exit` or Ctrl-D does not end the session — the server respawns the shell in the same pane — and the session is never listed on this page or in Sessions; the stop icon kills it after a confirmation, and opening the panel again starts a fresh one.

## API Calls
- `subscribe(target)` — start streaming pane output (200ms polling, includes cursor position and command changes)
- `unsubscribe(target)` — stop streaming
- `send_keys(target, keys, literal)` — send keystrokes
- `send_command(target, command)` — send text + Enter
- `capture_pane(target, lines)` — initial content load
- `list_panes(session)` — populate window switcher (current session)
- `resize_pane(target, cols, rows)` — resize pane to match client viewport (auto-restores on disconnect)
- `scratch_session()` / `scratch_kill()` — the scratch terminal's session (ensure + its pane target / kill ours only)

## State Management
- Active pane target (session:window.pane) — a ref that names its server (`serverId`); saved in that server's own slot (`tmux_state::<id>`) and restored from it, never resolved by a same-named pane on another server
- Terminal content (managed by xterm.js)
- Window switcher collapsed/expanded (persisted)
- `touchScrolling` flag — pauses content updates during touch
- `kbLocked` flag + `inputmode` attribute — keyboard control (see design doc)
- Persistent selection object `{anchor, head}` in inclusive buffer coordinates, plus derived handle/toolbar geometry
- Terminal font size, family, and line spacing (from settings); desktop interface scale is independent

## Edge Cases
- Content updates paused during touch interaction, caught up via `endTouchScroll()`
- `endTouchScroll` does NOT manipulate `kbLocked` — prevents race conditions with delayed timers
- Complete xterm.js Device Attribute response chunks (`\x1b[?62;22c`) are filtered before forwarding to tmux; split-chunk leakage remains tracked in `docs/todo.md` §B
- Mobile keyboard: double-tap to open. Three-layer control — `inputmode="none"` (browser hint), `kbLocked` focus guard (immediate blur), `keyboard-shift kbHeight=0` listener (catches system keyboard dismiss). Only `unlockKeyboard()`, blur timer, keyboard-shift, and pane switch may change `kbLocked`.
- Nav buttons have `tabindex="-1"` to prevent focus stealing from textarea
- All shortcut buttons use non-passive `touchstart: preventDefault()` to block synthetic `mousedown` focus stealing
- Uses `visualViewport` API for mobile browser, native `OnGlobalLayoutListener` for Android WebView
- Android stale keyboard height events guarded by `activeElement` check
- Mobile auto-pair input (quotes `""`, brackets `()[]`): xterm's hidden textarea is force-cleared via `requestAnimationFrame` after each keyboard input. Paste excluded via `paste` event flag (NOT `data.length`).
- Tab swipe suppressed when any child gesture is active (`defaultPrevented` or vertical movement > 10px)
- Shown pane dies (Ctrl-D / process exit → server `pane_closed`): stay on the
  Terminal page and switch to the previous pane of the same session (switcher
  order — nearest below the closed window/pane index, else first after it).
  Return to Sessions only when the session has no panes left, and only if the
  Terminal page is the one being viewed (a background pane death must not
  yank the user out of another tab). Split cells keep their own behavior
  (the cell empties).
