# Sessions List (Terminal's sidebar)

> **Merged into Terminal, 2026-08-18.** There is no Sessions TAB any more: the
> list was, in the owner's words, "差不多相当于 terminal 的侧边栏" and it also
> duplicated the switcher's quick-jump. It is now part of the Terminal page —
> a 280px column beside the terminal on a wide screen, a slide-over sheet on a
> phone (opened by the switcher's session chip, closed by picking a pane or by
> the back gesture). Everything below still describes the list's own
> requirements; only its host changed. A persisted or deep-linked `sessions`
> page redirects to `terminal`.

## Purpose
Fast, scannable entry point for selecting which pane to view. Optimized for
a user running many parallel coding-agent sessions ("is Kiro done in `proj-A`?
what's Claude doing in `proj-B`?") — each row should reveal its identity at a
glance without requiring interaction.

## Components

- Session rows, MRU chips and pane rows carry NO unread attention dots: the
  per-window notification inbox retired 2026-09-01 (the Hub room's auto-post +
  read cursor and the derived agent status dots are the one notification
  language). A source test pins the absence.

### Top row
The live list — Terminal's sidebar, the one host that mounts this component
(`chips={false}`) — has **no top row**: the MRU chip strip is pure
duplication there (owner: "左侧侧边栏不要显示"; the terminal already has a
window bar and the rows sit right below), and search moves to the bottom
bar. The component still carries the page dialect (`chips`, default true):
a single top row combining up to 5 MRU chips of recently opened **AI
sessions** (a pane is AI when the server's process-derived pane `agent`
says so, read through `core/agents.ts` `paneAgent` — board #260; not a list
kept here) with a round search button that swaps the row into a full-width input
(× or Escape closes). No host mounts that dialect since the list became
Terminal's sidebar on 2026-08-18; the chip strip hides while searching, and
one tap on a chip opens that session at its primary AI pane, never toggling
a row.

### Grouping
One group, one header: in the sidebar the list carries a **GROUP SESSIONS**
label (terminal icon + the word alone — no count pill since board #235),
because bare rows under the Projects header read as more projects
(ui-unification: every sidebar speaks the same language). The header hides
with an empty list. (The Teams/Sessions split keyed on `tmm-team-<room>`
sessions left with the team bus on 2026-09-09, board #100/#107; today's
agent teams live in the Hub, not in tmux session names.)

### Session row (single line, dense)
Left-to-right:
- **Status dot** — accent color + glow when tmux `attached == true`,
  muted otherwise.
- **Session name** (bold, truncates at 40% of row width).
- **Inline summary** — the row's identity, chosen as:
  - If a pane in the session runs a known AI CLI → the AI's icon.
  - Otherwise → the primary pane's `current_command` (monospace).
  - The cwd path segment was removed from the session row (it was squeezed
    to unreadability in the cramped line). Full paths live on the expanded
    window rows (right-aligned, horizontally scrollable).

  The "primary pane" is: the pane matching `activeTarget` if open, else the
  first pane with an AI tag, else the first pane returned by the server.
- **Trailing cluster** (right-aligned, tight):
  - Relative time of last open (`now`, `5m`, `3h`, `2d`, or month/day).
    Only shown when the session has a `last_opened` timestamp.
  - Window count badge `Nw` — only when `windows > 1`.
  - A quiet `⋯` menu button (board #77): opens the row's context menu — the
    same one right-click / long-press opens — whose only verb is Kill session
    (danger, confirmed by the app's dialog). No destructive verb sits in the
    open on a row.

### Pane list (expanded only when relevant)
Default: collapsed for every session. Shown when:
- The session has > 1 window AND the user taps the session row once, OR
- A search query is active AND the session matches but some panes match
  more specifically (search auto-expands). The search matches a renamed
  agent's label as well as its window name (board #91); the rows themselves
  show no window name, so they are unchanged.

Each pane row shows: `W.P` index (monospace, accent) · `current_command` ·
`cwd segment` · AI icon (if any) · `⋯` menu (Kill window, confirmed).

Plus a `+ Window` button at the end of the pane list.

### Bottom bar
- In the sidebar the bar holds the two list utilities: **search** (opens
  the search row) and **refresh**. Creation does not live here: since
  2026-09-23 the New command sits at the Projects head (owner: "每次还得滚
  动到最下边才能新建"), and an in-list add row appears only while there are
  no projects to head. Either route opens the shared **New Project** dialog
  (`CreateProjectDialog`, the same one the Chat sidebar opens — every
  session is a project), and a successful create jumps straight into the
  new session's first pane.
- **Refresh** icon. Pull-to-refresh was removed: it was a custom
  touch-handler implementation and on top of a scrolling list it conflicted
  too often with ordinary vertical scrolling near the top edge. A tap on
  the refresh button is explicit, reliable, and hits the same code path.

## Interactions

### Opening a session
- **Single pane session** → tap the session row anywhere (except kill) →
  navigates directly to Terminal with that pane.
- **Multi-window session** → tap the session row → expands the pane list in
  place. Tap again to collapse. Tap any pane to navigate.
- **MRU chip** (page dialect, currently unmounted — see Top row) → single
  tap → opens the session at its *primary AI pane* (the first pane running
  a known agent CLI, falling back to the first pane). **Chips never toggle
  the inline pane list** — the chip strip is the fast-switch surface, so a
  chip tap must move the user to the terminal, not leave them on the
  Sessions page with an unexpected row expansion elsewhere.

### Searching
- Type in the search box → list filters instantly. Matches highlight by
  virtue of appearing at all (no per-match highlighting; density already
  makes matches visible).
- Empty state while searching shows the query verbatim:
  `No matches for "foo"`.
- MRU chips hide while searching to focus attention on results.

### Kill
- Session kill: `⋯` (or right-click / long-press the row) → Kill session →
  the shared ConfirmDialog names the session → `kill_session` RPC → refresh.
- Window kill: same pattern from the pane row's `⋯`.
- Tapping the row itself always activates the session, never kills. The
  tracked-project rows beside these follow the same rule (board #77): their
  Open/Close/Remove verbs live in the `⋯` menu, Close and Remove confirm.

## API Calls
- `list_sessions` — sessions with `last_opened` annotation.
- `list_panes(session)` — called for every session on load (needed for
  inline summary). One call per session; cheap.
- `project_create` + `project_up` — creation goes through the shared New
  Project dialog; `new_session` is no longer called from this list.
- `kill_session(name)`.
- `new_window(session)`.
- `kill_window(target)`.
- `fs_list(path)` — for the dialog's directory picker.

## State Management
- `sessions`: array of `TmuxSession` sorted as: (1) active session, then
  (2) sessions with `last_opened` descending (MRU), then (3) never-opened
  sessions in server's baseline order (tmux `session_activity` desc).
- `panes[sessionName]`: `TmuxPane[]`, loaded eagerly for summary rendering.
- `expanded[sessionName]`: bool, user-controlled per-session expansion for
  multi-window sessions.
- `query`: current search string, `$derived` `isSearching` gates chip
  visibility and auto-expansion.

## Derived rendering rules

### `sessionSummary(session)`
Picks the "primary pane" as described above and returns `{ ai, cmd }`.
The session row uses this to render inline context without opening the list.

### `relTime(unixSec)`
`< 45s` → `now`, `< 1h` → `Nm`, `< 24h` → `Nh`, `< 7d` → `Nd`, otherwise
`M/D`. Tabular numerals so the column is steady.

## Edge Cases
- **No sessions**: shows a friendly empty state at the list position.
- **Sessions without `last_opened`**: still listed (at the bottom of the
  MRU tail), but no time chip.
- **Long session names / cwd**: truncated with ellipsis; inline summary
  sacrifices cwd first, then cmd, keeping name and trailing cluster intact.
- **Recreated session with same name**: inherits previous `last_opened`
  (persisted by name); acceptable for MRU.
- **Search query exact match on cwd but no visible cwd in row**: the row
  still appears — search runs against full data, not rendered text.
