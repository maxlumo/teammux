# Hub Page (project chat & agent collaboration)

## Purpose
The desktop workbench for **agents-v2**: one chat room per project where the
human and its managed agents collaborate, with the roster, live telemetry, a
terminal/files/board drawer, and every agent-management verb in one place.
This is the surface the `tmm` CLI talks to from the other side — CLI/UI
parity is a standing rule: every verb here exists as a `tmm` command, because
an agent that can only be managed by a human cannot manage a teammate.
See `docs/design-docs/features/tmm-cli.md` (architecture & rationale) and
`docs/design-docs/features/agent-lifecycle.md` (spawn → conversation →
completion).

## Availability
- **Every form factor the server allows** (`hubEligible` = the server answers
  `hub_rooms`, probed on every connect): Chat and Board are tabs on the phone
  too (the phone's chat tab is this page since 2026-08-01); the three-column
  workbench is the desktop form, compact (≤760px) gets the drill-down layout
  (project list ⇄ conversation) and keeps Agents inside Settings.
- Requires a server new enough to answer the hub RPCs (method-not-found
  elsewhere; a probed-unavailable server falls back to the terminal).

## The model (business summary)
- **A project is a directory + a tmux session**; every session is a project
  (auto-adopted). The chat **room is recorded on the project** and survives
  renames. See `docs/design-docs/features/projects.md`.
- The header chevron beside the project name opens the project-actions
  menu as the NAME expanding downward (board #32): its left edge aligns
  with the visible name's left edge (anchored on the name element's real
  rect, zoom-corrected), and the shared placement clamp keeps it whole
  inside the viewport — never clipped at the right edge. Every other
  context menu keeps the right-aligned pointer placement.
- The desktop header path remains the complete project path: it scrolls instead
  of ellipsizing when space runs out, explicitly supports mouse text selection,
  and a double-click selects and copies the complete value (including its
  off-screen portion) through the shared clipboard fallback.
- The composer's scrollbar exists exactly while there is something to
  scroll (board #34): hidden at rest and while the text fits, auto only
  when the natural height exceeds the max — decided in growComposer's one
  measurement, so shrinking or sending flips it back at once. Placeholders
  name the reach and stop ("Message every agent…", "Leave a note…"); the
  recipient menu's small hints keep the delivery semantics.
- **Agents are windows** in the project session. A *managed* agent was
  spawned by the app into an isolated home (`<ws>/.tmm/agents/<name>/`) from
  a **registry definition** (backend, model, effort, system prompt, skills,
  MCP); a *direct* window (hand-started) is observed but never typed into.
- **What an agent SAYS** goes through the `tmm` CLI; **what we OBSERVE**
  arrives via hooks (turn open, tool calls, ask, stop) and status is
  **derived** (`running | waiting | idle | failed`).
- **Messages move four ways** (taught to every agent): stamped prompts enter
  its pane (a busy queue-mode agent receives the lines sent meanwhile as one
  combined prompt when its turn ends); the captured final reply is recorded and returned once to each
  agent whose request the turn carried; addressed sends (`@name`) start a new question
  or handoff; `send --status` records ambient progress. `tmm log` is the room
  memory. When the addressed recipient belongs to an agent team, its prompt
  also carries the routed room delta since its previous delivery, identifying
  who sent each message to whom. Non-team recipients keep the addressed line
  alone.
- **The task board** is the project's plan of record: the human writes
  issues here, agents keep them current via `tmm board`
  (todo/doing/review/done, fixed vocabulary).
- **Board detail is a selectable history, not a mutable chat log** (board
  #43): note bodies and a locked issue's original title/body explicitly allow
  text selection. The original brief is editable only while the issue is
  currently unassigned AND no Agent has ever saved or noted on it; the server
  persists that activity bit and rejects later title/body patches, so clearing
  an assignee or moving back to todo cannot rewrite history. Status, assignee
  and new notes remain active workflow controls. Detail changes remain a draft
  until the explicit ✓: a successful save returns to the board list, while a
  failed save stays in detail with its draft and error intact for retry. In the
  detail header, delete precedes cancel and ✓; whenever the draft actions are
  present, ✓ is the rightmost control so a habitual confirm tap cannot hit the
  destructive action (board #48).

## Sidebar (projects)
- Ordered by **conversation recency** (newest message per room), live-only
  projects without talk underneath. Chat and Terminal show the SAME updated
  age from `projectAgeLabel`: conversation time first, tmux activity only when
  the project has never spoken; one source and one formatter prevent the two
  sidebars disagreeing. Each row shows the project's agents as quiet mono chips
  with state dots (shared atoms with the Terminal sidebar — `.side-*` in
  app.css).
- Every Chat project row has a permanently visible borderless `icon-btn` dots
  affordance; click and row right-click/long-press all open the SAME
  `projectItems` ContextMenu, so the menu is discoverable without duplicating
  its verbs.
- Create (`+`) requires a name; the path comes from the DirPicker (never
  typed from memory). Delete goes through the **recycle bin** (archive →
  restore is free; the confirmed delete is the only irreversible step).
- The open project persists (`tmux_hub_project`) and is re-verified against
  the list on load.
- Several servers (board #335 ③): each server's Hub is its own tree (its own
  socket, its own per-server prefs and alert list). In Aggregate the FOCUSED
  Hub's sidebar is the UNION of every included server's projects — each
  server's slice in its own order and on its own clock, merged by the one
  rule, ties by saved order — and every row wears its server's tag
  (`ui/ServerTag`) when more than one server is included. A row of another
  server, picked, moves the focus to that server (no dial, no teardown) and
  selects that project in ITS Hub. A row's Close/Delete is the same confirmed
  flow as a local row's, on that server's api with the row's own project id,
  the confirmation naming project · server; Delete is the recoverable
  archive; Open opens there. A server whose list has not answered is listed
  as "no list yet", never silently absent; one whose latest refresh failed
  keeps its last good rows, muted, and is named "not connected"; an
  included server with no live runtime offers nothing. Each row's agent faces
  come from its own server's catalog. A hidden member's Hub does list work
  only — its 20 s list refresh and, on a push, the unread badge and the
  notification record — and opens its room when first shown. The Hub head
  wears the server tag too.

## Roster (agent cards)
- One card per live window; managed agents carry the hook-derived state dot
  (at-rest is achromatic grey; running wears the `.live-dot` halo + breathe;
  waiting/blocked puts an amber frame + wash + `needs you` word on the whole
  card — same `--status-warn` token, no motion),
  sniffed **vitals** (model + effort at `--fs-micro`, context% as a 2px
  bottom edge line), and a context menu reached from the card itself or from
  right-click/long-press — no dedicated dots control taking roster space
  (Message / Watch / Only its messages — the one-agent feed filter, also a
  double-click on the card / configure agent / Interrupt / Restart / Stop /
  Remove — rising consequence order). The card TAP menu
  aligns to the card's LEFT edge (board #47 — the card reads name-first
  from its left edge; same shared placement flip/clamp as the title menu);
  right-click/long-press keeps the pointer placement.
- A **stopped** agent (slot, no window) keeps its card and menu (Start /
  Remove). The card is dimmed and carries no "stopped" word — the dimming
  says it, and the word made the card wide (owner, 2026-09-03); the state
  stays in the card's aria-label. Its avatar is the SAME backend icon the
  live card wears — read from the slot's declared backend, greyed by filter
  (owner, 2026-09-05); the letter tile remains only for a backend without
  an icon. The `+ agent` card is the strip's sticky last card and renders
  for every selected project — empty roster and closed session included
  (spawn into a down project opens it).
- Tapping a card makes that agent the composer's **recipient** (and the
  remembered project lead — `pickLead`).
- **Agent teams** (board #74): agents started as one configured team wear a
  Chrome-style tab group: a filled name pill, a group-only lower baseline
  and a raised outline around a selected member. The name is a native choice:
  clicking it addresses all current managed members of that team, without
  reaching solo agents or another team. Compact shows a width-bounded label
  with a 44px hit target; the full team name remains in accessible text.
  The group scrolls as one unit of the strip. Nested team members remain
  inside their root team's group, with their full path in hover/ARIA.
- **Group verbs** (board #258): right-click or long-press on the All tab or
  a team name opens a menu that restarts, starts the stopped, interrupts or
  stops every member at once (counts in the labels; Stop always confirms,
  Restart confirms only when a member is working). A team's Restart first
  brings the team in line with its current definition: members removed from
  it are stopped (their homes kept), members added to it are started, and the
  rest restart (board #286). A team's menu also opens its configuration.
  Removing agents stays per agent.
  The empty-room preset lists configured teams as
  one-tap starts beside the single agents, and the "Start a team" picker
  offers them above the ad-hoc pick (the brief applies to every member).
  On the desktop the Agents page is a category page like Settings: the
  sidebar lists Instructions for every agent · Agents · Teams · Skills · MCP
  servers (with counts), the main column shows the chosen category's rows
  and a "+" in its head, and picking a row opens its editor there (the
  chosen category persists). On the phone each category is its own Settings
  page (`section`) whose list IS the screen. "Instructions for every agent"
  edits the app-wide `<config>/AGENTS.md` that leads every managed agent's
  system prompt (also `tmm prompt`).
  Teams are configured on the Agents page (Teams section). Each member chooses
  one source: a bare coding agent configured here (backend/model/effort,
  prompt, Skills, MCP), a custom registry agent inherited whole, or a sub-team
  inherited whole. The latter two expose no prompt/Skills/MCP fields in the
  team editor. Shared guidance is labelled **Team rules** and is injected into
  every member. Member cards are readable summaries that expand one at a time;
  the expanded bare-agent prompt uses a full-width editor, and compact layouts
  stack every field into one column. At most 8 agents after sub-team expansion
  (the spawn cap).

## Feed (the conversation)
- Telegram-like bubbles: name header, floated time trailer, delivery ring on
  own messages; `[tmm status]` and historical `[tmm done]` markers render as ordinary
  bubbles with a state badge; `[tmm] ` lifecycle lines fold into one sys
  capsule (dropped at the chat-only detail level), except a `/command` the
  person sent, which is their own bubble at every level (board #264); tool calls fold into one
  lane per turn (configurable row cap, middle column scrolls, never
  truncated); once that agent's reply ends the lane, the lane rides inside
  the reply's bubble, folded until opened (board #295).
- Long user messages fold at the rear (`elideTail`) with an in-bubble
  expand; ONE user-message anchor pins the reading position (never while
  expanded). The budget is rendered rows, not source newlines: each line is
  priced by character width, CJK/fullwidth counts double, and the exhausting
  line is cut at the remaining units. `perLine` is measured from the actual
  chat content width and current bubble font (not a desktop-only 80-char
  constant), so narrow phones keep the same approximate row budget. Window
  resize and drawer regrids re-measure/re-cut inside `withReadingAnchor`
  before restoring tail or history position (board #53). Images render as
  thumbnails and open the in-app Lightbox; markdown + LaTeX render in bubbles.
- **A tapped bubble reveals its Copy / Raw row; long-press selection stays
  the system's** (board #48; owner, 2026-09-07: "我只要消息气泡下边的这两个
  按钮，不要出现右键那种选项卡"): `.m-body` explicitly enables selection
  while message head/meta stay chrome. A plain tap (or the meta-trailer
  button, the accessible route) toggles the absolute `.m-acts` row under the
  bubble — **Copy** writes the raw body and dismisses after the Copied beat;
  **Raw** swaps the rendered markdown for the message's source until
  retoggled. There is NO message context menu: the bubble's `contextmenu`
  handler never prevents default — it only arms a one-shot guard so a
  touch/pen long-press stays the system's selection gesture and its
  compatibility click cannot open the row; a genuinely non-collapsed
  selection also wins over any bubble tap. The row closes on outside tap,
  Escape, or project switch. Board note text stays selectable too, and a
  plain tap still opens the note's Copy overlay (same guard).
- Feed levels: chat-only / +status / +tools, chosen in Settings or from the
  project title's menu (the current one ticked). Receipts and warnings are
  always visible.
- Tail intent survives a page switch (board #38): "at the tail" is measured
  as the BOTTOM GAP (`scrollHeight − scrollTop − clientHeight < TAIL_GAP`),
  never absolute scrollTop; a hidden page's scroll/layout events cannot flip
  `following` in either direction; messages arriving while hidden update the
  data with the physical scroll deferred; on return the feed settles, then
  forces the tail and re-seeds the ask anchor + seen marker — but ONLY for a
  reader who left at the tail. One parked in history returns exactly where
  they were. Entering a room still lands at its tail. The visible return
  control is the same global `.to-tail` button Terminal uses (board #49):
  shared circle/surface/ink/motion/touch target/news dot, while Chat keeps
  only its right/bottom/z placement.
- Room state is cached per session (`roomCache`) — switching projects
  restores instantly, "empty" is a verdict reached only after the first
  `hub_log` answer.
- New-message alerts (board #57) are for an **away running client**: a hidden
  or unfocused document, or another visible app page. The persisted Hub bell
  enables/mutes the placeholder cue and is the only gesture that requests Web
  Notification permission. Initial/history/cache loads and poll replays never
  alert; seen ids (or `from/ts/body`) dedupe, watched/muted batches never
  backfill, and own/sys/ambient-status rows are filtered while agent replies
  and historical `[tmm done]` rows remain news. Unsupported notification/audio paths fail soft;
  this is not remote push after the app has closed.
- The notification centre (bell) with several servers (board #335 ③c-4):
  one bell per window over the INCLUDED servers' lists, newest first, each
  row tagged with its server; picking a row focuses that server and lands in
  its Hub on the message; `hub_read` reaches only the message's server. An
  included member that is not connected is listed with its rows muted and
  named in the foot, not counted in the badge, and Clear leaves its list; an
  excluded server is not in this view. The bell is the window's: it is
  reachable when the focus or any member has a Hub, or any list has entries —
  on desktop the rail bell, on a phone the Hub header's bell, or, when the
  focused server has no Hub, a bell in the Chat tab's slot. A system
  notification's tag is the room ON ITS SERVER, and with several servers
  included its title names the server.

## Composer
- ONE capsule: recipient chip (`@name`, always prefixed on send), auto-grow
  textarea, up-arrow send. Drafts are per-project and survive reload.
- `/` opens the **command palette** in the addressee's dialect (transcribed
  from each CLI, view-commands filtered out; fuzzy 3-tier matching); a
  command-shaped draft styles as a command and goes verbatim into the pane
  (`hub_command`).
- `@` at the start of a word opens the same palette with the room's managed
  agents and `@all` (fuzzy-matched; Enter/Tab/tap inserts `@name `, Escape
  dismisses); `a@b` does not open it.
- Readline editing (Ctrl-A/E/U/K/W/Y/D/H/T/F/B, one kill buffer).
- **Interrupt**: empty-composer send button arms (amber) then fires Escape
  into the recipient's pane; double Ctrl-C same; while the recipient is
  mid-turn the resting button shows the stop-in-arc glyph. The act is
  recorded in the room (`[tmm] interrupted <name>`).
- Attachments (`+`): images downscale client-side and land in
  `<ws>/.tmm/uploads/`; any other file lands byte-identical; position is a
  visible `[img:n]` token swapped for the real ref at send. Pasting into the
  composer stages files the same way (board #25): a clipboard carrying files
  (screenshot, copied file) goes through the identical pipeline and the
  default text insertion is suppressed — a copied file's path-as-text would
  say the same thing twice; a text-only paste is untouched. A file that
  cannot be staged (too large, upload failed) becomes an error chip with the
  reason — removable, and send is blocked until it is removed.

## Drawer (three partitions, one width handle)
- The header's terminal button (drawer on desktop, Terminal tab on the phone)
  opens the window of the agent you are TALKING TO — the composer's recipient
  — before falling back to the first managed agent (board #76). While the
  terminal partition is OPEN, selecting another agent (card click, composer
  picker, "talk to") switches it to that agent's window (board #91); a closed
  drawer never springs open.
- **Terminal**: the selected agent's live pane (embedded xterm), window
  pills with state dots. The pills show agent windows only — shells and
  other windows fold behind a `+N` pill that expands on tap (board #92); the
  window currently on screen always keeps its pill. Esc inside `.xterm` goes
  to the pane.
- **Files**: the real Files component in single-pane mode, per-project
  parked cwd, maximize hands off to the Files tab. Esc inside is the
  browser's own.
- On the phone/compact: terminal and files toggles JUMP to their tabs.
- The open partition is remembered PER PROJECT (board #23: "切换不同的
  project 回来原来的视图还在"): opening/closing records it
  (`hubPrefs.drawer`, localStorage), switching projects restores it — a room
  where the drawer was closed comes back closed, and the terminal partition
  re-seats its pane from the NEW room's roster (a stale target from the old
  room never leaks in). Survives reload; renameSession migrates the key.
- The header also carries a board shortcut — the task board is its own
  PAGE (tab between Files and Agents), never a drawer partition.
- Every drawer toggle re-anchors the reading position (`withReadingAnchor`).

## Board page (task management — its own tab)
- **Several servers** (board #357, owner 2026-10-13: "在 Terminal 页面和 Board
  页面，都没有整合两种或几种不同连接里的所有项目"): in Aggregate the focused
  Board's project list is the UNION of every included server's boards — the
  same projection the Hub sidebar is (each server's slice in its own order and
  on its own clock, merged by the one rule), each row wearing its server's tag
  (`ui/ServerTag`, on its own second line) when more than one server is
  included, and counted by ITS server's per-board totals (an empty board is
  hidden by its own server's counts). Picking another server's row moves the
  focus there (no dial, no teardown) and lands on THAT project's board, with
  no issue opened; the board body is always one server's. A server whose list
  has not answered is "no list yet", one whose latest refresh failed is "not
  connected" with its last complete list kept (muted). A board's list is both
  reads — projects AND per-board counts — so a failed counts read never reads
  as "no boards", and a delete or create the person just confirmed is in the
  union at once, here and on the other server's Board. The landing is held
  while the target Board is committing, then opens that project's board LIST
  (an open issue is left through the usual Keep/Discard); it is void once the
  person leaves that board — no replay on return. The head's name and tag are the Hub head's stack. A
  hidden member's Board does list refresh only (its existing 20 s timer).
  Single: this server's boards, untagged.
- Four fixed columns: **todo / doing / review / done**. Issues carry title,
  body, assignee, opened-by, and their own **note thread** (progress and
  decisions live ON the issue, not only in chat). The **title is OPTIONAL**
  (board #31): an issue needs title or body — never neither — and an empty
  title is STORED empty (no fabricated fallback in persistence). Everything
  that NAMES an issue (cards, delete confirm, room lines, notices, the CLI's
  list/show) speaks ONE fallback — `issueRef`/`issue_ref`: trimmed title,
  else the body squashed to one line and cut Unicode-safe with a `…`
  marker, else `#id` — so a titleless card wears its body excerpt as the
  title and the preview line stays empty (the same text twice reads as a
  bug). The note reply box
  soft-wraps and grows with its content (board #28: a long line used to
  scroll horizontally, hiding what came before) — one line at rest, Enter
  sends, Shift+Enter inserts a newline, an IME composition's Enter never
  sends, and a sent note shrinks the box back; the send button rides the
  last line. Tapping a historical note reveals the same absolute `.m-acts`
  action row Chat bubbles use, with one **Copy** verb that writes the note's
  raw body; selection drags do not trigger it, the time is the accessible
  action trigger, and outside/Escape/issue switch or the brief Copied beat
  dismisses it without changing detail scroll height (board #46). Copy state
  is generation-scoped before and after the async clipboard write, so an old
  timeout or deferred resolve cannot affect another note or issue. The
  CREATE form submits from the keyboard too (board #36:
  "我在 board 填写完 issue 描述后，可以 cmd+enter 直接提交确认"): the
  title's Enter creates, and the multi-line body creates on **Cmd+Enter /
  Ctrl+Enter** (both modifiers, cross-platform) — a bare or Shift Enter in
  the body stays a real newline, an IME composition's Enter commits the
  candidate text and never the issue (on the title too), and every trigger
  is the same createIssue the ✓ button calls. The DETAIL editor takes no
  chord — its save is the diffed, guarded Save button.
- The four areas tile as **1, 2 or 4 columns — never 3** (board #27: with
  four areas, three across orphans the fourth on its own row). The count is
  decided by the BOARD's own container width (CSS container queries), so
  the standalone page and the Hub drawer's embedded board obey the same
  thresholds by construction — the viewport plays no part. Movement order
  and per-column scrolling hold in every shape; the page itself never
  scrolls. The 1-column stack is ADAPTIVE (board #33): a **sparse** area
  (0–1 cards) takes header + content height only, **dense** areas (2+)
  flex-share the remaining height with their own internal scroll, and when
  all four are sparse the leftover blank stays at the bottom — empty areas
  are never inflated. In this 1-column stack every card is COMPACT (board
  #328): the title clamps to 2 lines and the body preview to 1, so a
  single card stays short and cannot take the screen from the dense areas;
  the 2- and 4-column grids show the full title and a 4-line preview. The ≥2-column grids keep splitting the height
  equally (rows must not content-size, or the page would scroll).
- The human writes/edits here; agents use `tmm board` (`take` = claim +
  doing; only the acceptor moves to done). Same rows, same vocabulary —
  the board is session-scoped like the room. Public `#N` is the project's own
  durable sequence: every project starts at `#1`, advances independently, and
  never reuses a deleted number (gaps therefore remain honest history). The
  database-wide `issues.id` survives only as an internal row key for note FKs;
  UI, room events and `tmm board` expose the project number. Every
  list/get/save/note/delete resolves `session + id`, so two projects may both
  have `#1` without sharing a row. Schema v16 backfills existing rows densely
  by their old creation order within each session. Renaming a project moves
  both its Board rows and number sequence in the same transaction; archive
  keeps both, while permanent project deletion removes both before releasing
  the session name (board #41).
- The sidebar lists only projects whose board HAS issues (board #39: "如果
  该项目完全为空 则直接不显示该 project"), fed by ONE bulk `hub_board_counts`
  read alongside `project_list`/`hub_rooms` — never a per-project
  `hub_board_list` walk. Each row is the Chat sidebar's two-line shape (the
  shared `.proj-row` skeleton: dot + name + the same conversation-first updated
  age Chat and Terminal use) with the four
  column counts as the quiet second line — fixed todo/doing/review/done
  order, zeros included, each chip coloured by the one board status
  language. Because the set is always four, Board alone adds the shared
  `.side-wins.grid` modifier and a zero-height hidden mirror row: it measures
  the available row, localized labels, and the widest count across boards;
  `chipCols` then selects equal **4 / 2 / 1** columns (4×1, 2×2, or 1×4).
  Two columns are the safe pre-measure fallback. Three is never offered, so
  there is no ragged 3+1; equal tracks align each column's leading dots, and
  the one-column fallback prevents truncation at very narrow widths. Chat
  keeps the bare flex-wrap for its variable agent count. The CURRENT board's
  counts refresh from its own `hub_board_list`
  the moment it answers, so deleting the last issue hides the project and
  creating the first shows it at once — no poll wait. An empty CURRENT
  board stays usable while hidden: the page-head still names it (the name
  lookup runs over the full project list) and its main area creates the
  first issue; with no session to follow, the first NON-EMPTY board is the
  default selection.
- Cards name the REPORTER (`by human` / `by lead`) and the assignee.
  Assigning from the detail view picks a managed agent and DELIVERS the
  assignment (`hub_post` @message typed into that agent's pane, with the
  take/note/move instructions) — assignment is a dispatch, not a label. The
  dispatch reads as a HANDOFF (board #51): the SUBJECT leads (`{who}
  assigned this to you`, the operator's name at the front), then the issue
  (original title/body), then the note thread, and the tmm take/note/move
  instructions ride LAST — never between the issue and its thread. Notes
  come chronological with authors preserved (board #42) under their own
  explicit character budget, and any cut points to `tmm board show <id>`
  so one giant note cannot flood the pane while discussion never disappears.
- Status changes are recorded in the room (`[tmm] board #N a → b`), and a
  move to review NOTIFIES the reporter (line typed into their pane) — the
  handoff loop: file → assign (delivered) → take → review (delivered) →
  done by the reviewer. Board columns and agent live states are separate
  axes joined at these events.
- Destructive and discarding actions confirm through the app's ONE
  ConfirmDialog, phone-sheet aware (board #29): deleting an issue is a
  danger confirm that CAPTURES its target at request time (a selection or
  project change while the dialog stands cannot redirect it; success cleans
  only the matching view); dropping a dirty edit OR typed-but-uncreated
  form data is a neutral confirm reached from every exit (cancel, Escape,
  back, sidebar pick), a confirmed discard truly clears the form, and clean
  navigation never asks.
- Carries the shared project sidebar (every project has its own board);
  the followed last-touched session is the default, a pick overrides it
  until that moves again. Compact is the standard drill-down (project list
  ⇄ board). Polls while visible; a failed poll keeps the last board; back
  gesture peels detail → list, then LIFTS the project drawer as the floor
  (Hub's compact rule — back with it open falls through and re-pushes; it
  never dumps the reader on the terminal, board #47). Only when the page
  was jumped into from the chat's board icon does back return to the
  conversation instead (App's one-deep return slot outranks the lift).

## Back gesture (compact)
Peels layers in tap-outside order: context menu → agent menu → recipient
picker → palette → armed interrupt → confirms → pickers → drawer → and a
bare conversation lifts the project list (the floor).

## Related
- Design: `tmm-cli.md` (the whole agents-v2 substrate), `projects.md`,
  `agent-lifecycle.md`, `design-language.md` (visual contract). (The other
  multi-agent surface, the agora-bus Team page, was deleted on 2026-09-09,
  board #100/#107; its record is `docs/exec-plans/team.md`.)
- API: `docs/requirements/api-contracts/websocket-rpc.md` (hub_*, board,
  registry/skills/MCP tables).
