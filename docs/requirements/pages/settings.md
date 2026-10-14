# Settings Page

## Purpose
Configure server connection, appearance, language, and app behavior.

The gear button opens Settings as a full-window workspace below the app nav,
not a small popover. The workspace uses the shared left-aligned 860px
configuration canvas and one header, not centered cards. Preference rows,
fields and commands follow the configuration control contract in
[design-language.md](../../design-docs/features/design-language.md): 32px
pointer / 44px touch controls, labelled values and shared spacing. The category list
reads as TWO labelled groups where both exist (owner, 2026-09-05: app-level
settings, then Agent-level settings; a lone group hides its label — desktop,
where Agents is a page of its own, reads as one plain list):

**App** — about the application itself; Connection ends the group as its way out
- **Appearance** — how the app looks: theme, language, responsive layout, interface scale, the three font roles (content, display, terminal family), then the terminal's size and line spacing (owner, 2026-09-24: the terminal's style settings belong to Appearance; the one-row Terminal category is retired)
- **Chat** — how much of the conversation the feed shows: chat detail and tool rows (moved out of Appearance 2026-09-25: they set what is said, not how it looks)
- **Notifications** — message notifications On/Off, the level (Finished / Replies / Everything) and a test row (its own category, owner 2026-09-02)
- **Shortcuts** — configurable bindings for pages, servers, panels (including the scratch terminal toggle, board #324 — its other door is the system status bar control, #326) and Terminal windows (every desktop form factor: browser, PWA and the desktop app; absent on the touch layout)
- **Connection** — every saved server (switch/rename/remove/add), then the current server's addresses, optimize/share/disconnect (the global debug switch and its floating log panel were retired 2026-09-26)

**Agent** (phone only, where Agents is not a page of its own)
- **Agents / Teams / Skills / MCP servers** — four second-level pages, each the real AgentsPage narrowed to one section (owner, 2026-09-02)

## Components
- Connection setup command opens the existing address/token form.
- Current server addresses allow quick switching; tokens are never displayed.
- Multi-server registry (board #55): named server configs persist in
  `tmux_servers` (id, name, address, token, optional socket + machineId);
  identity is the MACHINE, so LAN/Tailscale/WAN alternates of one server are
  ONE entry (the failover map `tmux_machines` stays the address authority). A
  successful connect upserts by machineId; the desktop rail carries a
  switcher above the configure group, and on the phone a row at the top of
  the Settings category list (swap icon + authenticated hostname, falling back
  to the host portion of the address before auth) opens the same switcher —
  current entry marked, click switches
  IN PLACE (board 315: no reload; the shell stays, a panel names the target
  while connecting, a failure offers Retry, Back, Edit and the switcher;
  per-server nav state and the Hub's per-project prefs are parked and
  restored so nothing crosses servers; unsaved edits ask first), a pencil
  renames, non-current rows removable, `+` row opens the Add server dialog
  (cancel changes nothing; connect is the same switch). Settings ›
  Connection lists every saved server with the same component and actions
  (the current one marked, its address list below it). A LIVE row (the focused
  server, or a connected Aggregate member) adds a third line, on this page
  only, naming ITS build: `server v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC`,
  or `server: unknown` for a server older than #368 that names none (board
  #368). A row that is not connected says nothing; the popover stays two lines. Migration from the
  single-server keys is
  one-time, idempotent, and never loses the current user.
- About (board #368, the last category of the app group): the app's name and
  build (`v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC`: the package version, the
  source commit and the build minute; `dev` / `unknown` where git or the clock
  was unavailable), the FOCUSED server's build for comparison, the repository
  link (here only; the connect form no longer carries it) and the licence from
  `package.json`. **Where the identity comes from.** A `vite build` carries
  the source revision, read from the ENVIRONMENT first (`SOURCE_COMMIT` /
  `SOURCE_TIME`: public metadata a build without `.git` is handed, which is
  how the e2e image gets one), then git, then `dev`; build.rs reads the same
  two names in the same order. A **dev server is not a build**: it says
  `dev server (started 15:38 UTC)` and is never compared, because its config is
  read once at start and a commit frozen then would keep naming itself after
  hot reloads and main moving (review P1-B). **The server's build is a fact of
  the CURRENT socket**, not a remembered attribute (review P1-A): while the app
  re-dials after a drop the line says `Reconnecting...`, never the build from
  before the drop and never `unknown` (that word is for an older server that
  answered and named none); the next login's build replaces it. The server
  line is dim while the two agree or cannot be compared (a `dev` side, a dev
  server, a server that named none), and wears the warn status colour with one
  sentence when both name a real commit and the commits differ (compared by
  prefix, because `--short=8` is at least 8 characters, not exactly 8): that
  is the stale-PWA tell (UI from one build, server from another). The
  sentence does not promise a reload fetches the server's UI: it says the UI
  and the server are different builds, to update the installed app or reload a
  browser (the UI may come from a cache or a different deployment). The same
  commit built twice is not a mismatch. Not connected: no server row.
- Connection mode (board #335 ③): **Connect to: One server / All
  included** (`ui/Segmented`, persisted to `tmux_connection_mode`). In
  Aggregate every INCLUDED saved server is a member: it dials on its own
  socket and, once up and published, its tree is kept mounted, held and inert
  behind the focused one (an excluded server, or one that never came up, has
  no tree; its row says so). Every
  row of the ONE server list (popover and this page) carries an include
  switch (`ui/Switch`, the set in `tmux_excluded_servers`) and the member's
  derived status — the one status-dot language, a failure's reason after the
  address (not answering, paused on storage, reaches another known server),
  and "Excluded" for a server left out. Picking a CONNECTED member moves the
  focus (CURRENT and the mirror) with no dial and no teardown; picking an
  excluded one includes it (it joins through its own dial; the app stays
  where it is); picking a member that is not up is not a focus change — the
  row shows its state and the person focuses it once it is up. Every mode or
  include change asks the trees it would
  destroy first, one at a time, in that tree, and a "keep editing" changes
  nothing; excluding the focus moves the focus to the next connected member
  first and is refused when there is none. While the app is blocked on
  storage, the mode and every switch are frozen with the registry. A new
  server is included by default; a rename changes nothing.
- The row's hover card (desktop) carries only what the row hides: the
  machine id, the connecting/reconnecting word, Excluded — never the name,
  address or reason already on the row. No native `title`.
- Pending state from before #335: when drafts and views saved by an earlier
  build are still waiting for the server whose machine they name, Connection
  shows them as a row (named by that machine) with one action, **Discard**,
  which asks first; confirming closes only that record (nothing else moves,
  the earlier build's keys are left), and the row is frozen while blocked.
- Server info: hostname, machine ID, address; in Aggregate with more than
  one server included the title wears the focused server's tag
  (`ui/ServerTag`); copy-link and the address optimizer act on the FOCUSED
  server, resolved when the action starts. The address list marks the
  current address and shows a connecting cue on a tapped address until the
  switch settles. An alternate address is removable (the active one is not —
  it is the live connection), and a row's grip drag (or Arrow keys on it)
  reorders the list; the order IS the failover priority the reconnect
  round-robin walks (board #222)
- Language selector: EN / 中文 (`ui/Segmented`, the travelling pill)
- Theme selector: Auto / Light / Dark (`ui/Segmented`)
- Message notifications (own category): `ui/Switch`, persisted immediately to localStorage `tmux_notify`; turning it on is the user gesture that previews the cue and requests system-notification permission (Android's runtime prompt inside the app). The caption says when only sound can play. The separate test command plays the cue and attempts a notification; it cannot race an outstanding permission request. Moved here from the Hub header (board #72).
- Desktop interface scale (60%–180%, persisted to localStorage `tmux_ui_zoom`; Cmd/Ctrl `+`, `-`, and `0` use the same value)
- Terminal font size control (`ui/Stepper`, 6-40px), independent from interface scale; tool-row count and interface scale use the same Stepper with their own bounds and localized action names
- Terminal font family (in Appearance with the other two font roles, followed by the terminal's size and line spacing; the list offers only families the DEVICE resolves — the suggestion pool is probed with the same registry check the validator uses, so nothing offered can fail on pick; another family may still be typed; only a valid local font is applied and persisted to localStorage `tmux_font`; empty = system default)
- Terminal line spacing (0.40–1.60, persisted to localStorage `tmux_line_height`; applies live to every normal, split, and Team terminal)
- Line spacing uses `ui/Slider`, with its native range semantics, visible numeric value and named reset command
- Shortcuts (board 316, owner 2026-10-08: "现在有一些快捷键，好像都不起作用…做成可以设定快捷键的配置，例如常见切换页面，切换连接，打开某些侧边栏"). Why they "did not work": the tab AND the handler were gated on the Tauri desktop shell, and the owner runs the app in a desktop browser. The gate is now the desktop form factor (`!layout.isTouchDevice`).
  - ONE registry, `lib/app/shortcuts.ts` `SHORTCUTS`: each action declares its id (the `tmux_shortcuts` key), label, group, default and what it needs; App's handler and this tab are both derived from it. App only supplies the host primitives. A key whose action is not available at that moment (not connected, not on the Terminal page…) is left to the browser.
  - Groups and defaults (macOS / Windows·Linux): **Pages** previous/next page ⌘U ⌘I / Ctrl+Alt+U I, go to Chat / Board / Terminal / Files / Agents / Settings ⌘⌥1…6 / Ctrl+Alt+1…6; **Servers** previous/next server ⌘⌥[ ] / Ctrl+Alt+[ ], open the server switcher ⌘⌥S / Ctrl+Alt+S (switching goes through the in-app switch, board 315); **Panels** sidebar ⌘\ / Ctrl+Alt+\, split screen ⌘⌥\ / Ctrl+Alt+0, type a message ⌘⌥; / Ctrl+Alt+M, type in the terminal ⌘⌥' / Ctrl+Alt+K (the ACTIVE split cell, never the first terminal; an empty active cell takes nothing); **Terminal windows** previous/next ⌥U ⌥I / Alt+U I.
  - The terminal owns plain Ctrl chords (validator, board 316): a binding whose only modifier is Ctrl, with or without Shift, is refused on every platform (`shortcutReservedTerminal`), because the handler runs over the terminal and ^U / ^I / ^\ are kill-line, Tab and SIGQUIT there (AGENTS.md rule 7). That is why the Windows/Linux defaults are Ctrl+Alt.
  - **Residual overlap, Terminal windows:** the previous/next terminal window defaults Alt+U / Alt+I (⌥U / ⌥I on macOS, the pre-316 bindings kept unchanged) are also readline's upcase-word (M-u) and, in some shells, a Meta binding of `i`. They act only on the Terminal page and only when bound, so a user who needs M-u in the shell clears or rebinds them in this tab. Plain Alt is not refused globally because these two keys use it.
  - Character input is never a shortcut (review P1): `shortcutFromEvent`, the ONE parse entry for the handler and the recorder, drops an IME composition (`isComposing`, keyCode 229), a dead key (`key === 'Dead'`, with or without the AltGraph state) and AltGr (`getModifierState('AltGraph')`), which Windows and Linux report as Ctrl+Alt. The recorder asks the same predicate (`isCharacterInput`) before any of its own handling, so a composing Backspace does not clear a binding, a composing Escape does not end recording, and the event is not consumed. A browser that reports AltGr as plain Ctrl+Alt without that state still sends the typed character as `key` (Polish AltGr+S → `ś`, German AltGr+7 → `{`); a Ctrl+Alt event whose printable `key` is not the key's own base character is treated as typing. **Residual risk:** an AltGr layout where AltGr+key types the key's own base character, on a browser without the AltGraph state, still fires the binding; rebinding or clearing that action is the way out.
  - Reserved combos are refused in place with the reason (`reservedReason`), when the browser delivers the keydown at all: what Chrome, Safari and Firefox keep (new tab/window, close, quit, tab switching incl. Mod+1…9 and Linux Alt+1…9, developer tools incl. Firefox's ⌘⌥K) and what the OS keeps (macOS screenshots ⌘⇧3/4/5, ⌘H, ⌘M, ⌘Space, ⌘`, ⌘⌥M/H/D/Space/Esc; Ctrl+Alt+T/Delete). Some never reach the page (the OS or browser takes them first); the recorder then sees nothing and keeps waiting — it cannot show a reason for a key it never receives. The old ⌘T default for Terminal was one of these, which is part of why Terminal "didn't work".
  - What was exercised and what was judged (review P2): exercised in Chrome on Linux (the real app at 1280px against the fake two-server backend): go to Files, go to Terminal (with a migrated legacy ⌘T), previous page, next server (no reload), open the switcher. Unit tests drive the dispatch with real event shapes (AltGr with and without the AltGraph state, IME, 229, plain Ctrl+Alt). macOS (Safari, Chrome), Firefox and Windows were NOT exercised; their reserved-table entries come from the browsers' and OSes' published shortcut lists. The table is the project's own judgement, not a three-browser verification.
  - Migration: the six old ids keep their keys; a stored value equal to its OLD default or now reserved follows the new default, any other stored choice stays, and a new default landing on a stored choice is left unbound.
  - Rows: record (Delete/Backspace clears, Escape cancels), a per-row reset (the Slider's undo atom, resting at the default), Restore all defaults; duplicates are refused. An action this device or server cannot do (no Chat on this server, one saved server, a window too narrow for split screen) is shown disabled with the reason; a page scope (Terminal windows only on the Terminal page) is not a refusal.
  - Not included: a Files reading-mode / tree toggle. Reading mode is touch-only (board #226) and Files has no desktop sidebar toggle; the sidebar action covers the pages that have one (Chat, Terminal, Board).
- Disconnect button

## Interactions
- Enter address + token → connect
- Tap history entry → auto-fill and connect
- Switch language → immediate UI text update, persisted to localStorage
- Switch theme → immediate CSS variable transition
- Switch settings tab → remember the last tab in localStorage and restore it on the next open
- Rest a pointer on a category row (desktop) → the shared hover card shows the category's name and a one-line description of what is inside (`settings*Hint`); on an address row → the address and its state (current / connecting / alternate). Touch shows no card; the rows' `aria-label`s and visible text are unchanged
- Adjust interface scale → updates the complete Tauri desktop WebView; terminal grid refits after the native zoom settles
- Adjust terminal font size → updates Terminal view without changing the surrounding UI
- Choose or enter a font → validate it against the device font registry, then apply and remember it; the row is pending during validation, and failure restores the confirmed family with a visible error
- Tap an alternate address' × → it leaves the machine's failover set; drag a row's grip (or focus it and press Arrow keys) → the set's order changes; both persist to localStorage `tmux_machines` through the one writer (`servers.ts` `saveMachineAddresses`)
- Tap disconnect → `doDisconnect()`
- Switch mode / flip an include switch → the leave walk for each tree it would destroy, then one write (`tmux_connection_mode` / `tmux_excluded_servers`); a connected member picked in the list → focus moves in place
- Tap Discard on the pending row → confirm → the `tmux_state_layout` marker closes as `discarded`

## API Calls
- `auth(token)` or encrypted auth (client_nonce + proof) — authenticate on connect (returns machine_id, hostname, build)
- `set_socket(socket)` — set tmux socket path at runtime

## State Management
- Connection state (disconnected/connecting/connected)
- Address history (localStorage)
- Locale / language preference (localStorage `tmux_locale`)
- Interface scale, terminal font size, theme, terminal font name preference (localStorage)
- Server info (hostname, machine_id, build)
- State restore on reload (page, session, view mode) — per server, from that server's own slot (`tmux_state::<id>` and the other resident keys); in Aggregate the mode, the excluded set and the focus are restored too, and every member's tree from its own slot
- Connection mode and excluded set (localStorage `tmux_connection_mode`, `tmux_excluded_servers`)

## Configuration Contract (#156, 2026-09-10)

- Independently valid local preferences remain immediate; there is no page-wide
  Save or Cancel. Async commands use shared CommandButton pending/error states,
  synchronously prevent duplicate activation and permit retry after failure.
  Hook results belong to the captured connection generation; a late response
  cannot overwrite a newer server's status. Failed updates retain known status.
- Preferences keeps one embedded AgentsPage for the four Agent categories.
  A category change, including a capability correction or external request,
  passes its action through the child's `onGuardExit` registration before
  changing the visible category or unmounting that child. The child owns
  pending-save queuing and dirty-draft confirmation, not a second Settings queue.
- An external `{tab, n}` request is consumed only when its category action
  applies. Its Agent edit request is forwarded only after that accepted jump,
  and only to the Agents section. Superseded callbacks cannot redirect a newer
  category intent. Back still delegates to the child's dialog/editor chain
  before returning to categories; no new global history handler is installed.
- Settings observes its actual container and requested sidebar width. Below
  the sidebar plus 480px editor budget, it presents the existing category drill
  layout without navigating or discarding state. The 760px compact form remains;
  control sizes follow input capability. The child's own layout decides how its
  object list and editor fit.
- The shortcut recorder remains a native keyboard-input target, now using shared
  field geometry. Capture, conflict rejection, Escape, clear and reset keep their
  existing meanings; ordinary commands no longer share its private button skin.

Mounted tests execute the Settings handlers; the request-arbitration cases use
a child stub only for that boundary. `preferences-agent.mount.test.ts` also
mounts the real Preferences and AgentsPage together, proving a single discard
confirmation and a host exit held until Save completes. Global-tab preservation
is tested at the retained-component boundary, not through a complete App mount.
Chromium checks geometry and interaction in isolated real-component fixtures;
native WebView/IME behavior and the owner's actual build remain separate gates.

## Edge Cases
- Auto ws/wss detection based on address format
- Multi-address reconnect: server machine_id tracks alternate addresses, auto-failover on disconnect
- Tauri desktop auto-fills config from local `~/.config/tmux-mobile/config.toml`
- Language auto-detected from `navigator.language` on first visit (zh → Chinese, else English)

## Motion
State changes on this page move on the app's one vocabulary
([design-docs/features/motion.md](../../design-docs/features/motion.md)): the
address-history arrow TURNS 180° (`.flip`) instead of swapping glyphs, the
history list rises in and its rows `animate:flip` when an entry is removed,
every error line fades in (`.appear`, opacity only — never height), address
rows / the shortcut recorder cross-fade their selected clothes on `--t-fast`,
every segmented row is `ui/Segmented` whose accent pill GLIDES to the chosen
option on `--t-move` (the buttons only cross-fade their ink), and the server
row's 180°-symmetric swap glyph uses `.quarter-turn` to rotate 90° while its
popover is open (a 180° turn would look unchanged). The server popover grows
from its anchor (`.pop-layer`). The category list unfolds on first paint and a
switched category's pane is keyed on the accepted category so its sections rise in
staggered (`.reveal`) rather than swapping in as a finished wall — on the
phone the unfold plays inside the drill slide only on the way in; a re-shown
list does not replay it. On a pointer device the category and address rows
open the shared hover card (name + description / address + state).
