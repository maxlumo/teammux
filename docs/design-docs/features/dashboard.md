# The dashboard read — one derived answer per project

Board #108 (ticket 2a of `docs/exec-plans/board-dashboard.md` § 9, read § 4,
§ 5, § 8; the owner's request of 2026-11-11 05:23, approved 07:22). The view
that draws it is #109. Rulings: leader notes 4 and 6 on #108.

## Shape

`hub_dashboard {session}` (cap `dashboard`), ONE read:

| part | source |
|---|---|
| `asks` | the room's open asks, `store::asks::ask_list` (#106) |
| `board.counts` | this session's row of `projects::board_counts` (the Board's own grouped count) |
| `board.oldest_doing` | the doing issue whose `updated_at` is oldest: `issue_oldest_change`. Named `last_change`: any edit or note moves it, so it is never "in doing since" |
| `agents` | the live agents of `agent_states`, the ONE fold `hub_agents` answers with, read once per call: `state`, `detail`, `since` as derived, plus `issue` (the doing issue it is assignee of, `issues_held`) and `status` (its newest status row's own words, `rooms::latest_status`: the sender's newest row `rooms::status_text`, the one parser, accepts, with NO window, see below) |
| `stopped` | managed homes (`managed_names_in`) with no live window: counted, not listed |
| `finished` | issues that entered done in the last 24 h by `issues.done_at` (board.md § An issue knows when it was done) |

`hub_ask_counts {}` (cap `dashboard`, answered before the session gate like
`hub_board_counts`): every room's open asks in one grouped read, keyed by
the project's room.

Units follow their tables: the board's times are seconds, the room's ms.

## Rules and their reasons

### Nothing is classified twice (leader, note 6)

"Failed" is never an agent's state on the server (hub.ts `stateDotColor`,
#354). What the card shows as needing a person is a detail in the client's
`PERSON_DETAILS`, which only the client has. So the server returns each live
agent's derived state, detail and time unclassified, and the client counts
and picks the rows with `needsPerson` and `stateDotColor`; the roster card
and the dashboard row for one agent cannot disagree. Pinned by
`the_dashboard_is_one_derived_answer` (the dashboard's state and detail for
`dev` equal `hub_agents`').

### A dashboard agent is a managed one (reviewer R2, round 2)

The rows and counts are the MANAGED agents of the fold (`managed == true`),
the Hub roster's own rule (`Hub.svelte` `managedAgents`): a CLI started by
hand in a window is a terminal thing and never a dashboard row. Pinned by
`a_hand_started_cli_window_is_not_a_dashboard_agent` (hub_agents still lists
it, managed=false).

### "Could not ask" is never "none" (reviewer R1, leader notes 33 and 39)

`agent_states` says how its pane listing went (`panes`: `ok`, `absent`,
`failed`, by `tmux::session_confirmed_absent`, the delivery path's one
classification of what tmux KNOWS). A session tmux says is absent is a
conclusive empty roster: a stopped project answers no live agents and every
managed home stopped. A listing that could not be made, a project that
could not be read and a homes directory that could not be listed are each an
error of the whole read (-32603), so the client keeps its last complete data
muted (AC4) instead of showing "nobody live, all stopped" or "none stopped".
Pinned by `a_failed_pane_listing_is_an_error_and_an_absent_session_counts_its_homes_stopped`
(an injected lister, `roster_with`) and
`an_unreadable_agents_directory_is_an_error_not_zero_stopped`.

The fold reads the project ONCE (`roster`, round 3): a failed project read
makes its observation `failed` too, since no row's `managed` is then known,
and the dashboard takes the workspace from the fold for the stopped count.
Before, the fold swallowed a failed read into "every row unmanaged" and the
dashboard's own second read could succeed and count every home stopped
(reviewer, #108 note 46; source-confirmed, the transient trigger not
measured). Pinned by `a_failed_project_read_in_the_fold_refuses_the_dashboard`.

The fold's project must also BE the session it lists (round 4): a project
whose current session differs from the listed one means the dispatcher's
resolution of a previous session name was lost (its fallback to the asked
name on a failed read, #118), so tmux's "absent" would be about the wrong
session; the observation is `failed`, never "all stopped" (validator note
56). Pinned by `a_fold_listing_another_session_than_its_projects_is_no_reading`.

### Everything comes from ONE project row and conclusive observations, or the read refuses (round 5)

Every input was listed (#108 note 71) and each that could pass a failed
resolution as valid is closed:

| input | source | rule |
|---|---|---|
| session | the dispatcher | must be the fold's project's current session (round 4) |
| room | the fold's project row (`hub_rpc::fold`): its recorded room, else `proj:<session>`, `session_room`'s rule from the same row | never the dispatcher's `room` (reviewer note 65) |
| project, panes | the fold | a failed read is `failed` (rounds 2, 3) |
| membership | ONE `managed_state` per live window (the fold reads it once; `home_managed` on each row) | a marker that cannot be READ is `failed`; membership is the marker, the detected CLI kind is display only, so a managed home whose recipe cannot be parsed is still an agent, with the fold's DERIVED state (e.g. `exited`), never `shell` (amendment A, B) |
| stopped | `managed_names_checked_except(workspace, live windows, reader)`: the homes the fold did NOT observe, through the same reader | an unreadable home is an error, never a smaller count; a home with a live window is never stopped and never read again |
| a managed agent's state | `exited::shown_owned(…, observed membership)`: `classify` takes the fold's observation | never a second marker read (validator note 94; `shown` keeps its own read for its other callers) |
| labels | `names::names` | display only: a failed read shows physical names (logged), as in `hub_agents`; no row or count depends on it |
| ask chip key (client) | `roomOf(project)` (projects.ts): the recorded room when NON-EMPTY, else `proj:<session>`, the server's rule; the ONE client spelling, also used by the project sort, the notification room lookup and the Hub's unread key | a project with no or an empty recorded room shows its chip (validator note 81: the wire carries `''`) |

A refusal names its cause (`inconclusive`: the project, the panes, or a
home marker by name; the homes listing has its own words), and each cause
has its own test. Pinned by `the_dashboard_reads_the_room_of_the_folds_project_row`,
`the_fold_builds_rows_from_one_marker_observation`,
`a_managed_home_with_an_unreadable_recipe_is_still_counted`,
`the_dashboard_reads_each_home_marker_once` (the closing test, through the dashboard path: a reader conclusive on a home's first read and Unknown on any later one),
`an_unreadable_marker_of_a_live_agent_is_no_reading`,
`an_unreadable_stopped_home_is_an_error_not_a_smaller_count` and the Board
mount test for a project with no recorded room. The dispatcher's own
fallbacks (session and room) are #118.

### The latest status has no window (leader, amended ruling)

An agent's latest status line is its newest room row the one parser
accepts, however much unrelated traffic followed it. The first cut read
only the room's last 2000 messages, so a status line vanished after 2000
later messages while it was still stored (validator, measured). The read
walks the room's status-shaped rows newest first, skips any the parser
rejects (a newer malformed `[tmm status broken` cannot hide an older valid
line), and stops once every live managed agent has one; its cost is bounded
by how far back the oldest wanted line lies, not by traffic. Measured once
(isolated Docker runner, rusqlite's bundled SQLite, a SEEDED room of 12,601
messages, the size of this host's room log on 2026-11-11, with the only
status line the oldest row, the worst case): `latest_status` 12.3 ms, the
whole `hub_dashboard` 44.1 ms. Pinned by
`the_latest_status_survives_traffic_and_a_malformed_newer_candidate` and
`the_latest_status_read_cost_on_a_real_sized_room`.

### Notes for you are the client's (leader, note 4)

The bell's "to me" predicate lives in the client (`notifications.ts`), so the
server gains no second one: Notes for you is the notification centre's To-me
filter over a room read, asks left out (#109). `hub_dashboard` carries no
notes.

### Done is a fact of the board, not a sentence in the room (leader, note 4)

Finished · 24 h reads `issues.done_at`, never the room's `[tmm] board #N … →
done` lines: parsing a body is a second source (tenet 8), and the line keeps
an old title.

### An empty board with asks is still a row

The Board sidebar hides empty boards (#39). A project with open asks and no
issues stays listed (`visibleBoards(rows, counts, asks)`), or its asks have
nowhere to show. Pinned by the `visibleBoards` and Board mount tests.

## The view (board #109)

`hub/Dashboard.svelte` draws it, `hub/dashboard.ts` holds its logic (pure,
tested), and `Board.svelte` gains only wiring: the page head's
`ui/Segmented` (Dashboard · Board), the choice remembered per device
(`tmux_board_view`, Dashboard by default, the owner's D2), offered only on a
server that announces `dashboard`, never in the Hub drawer's embedded board.
The view takes the Board's own server RPCs (`api` prop), so no page names a
server behind its scope.

- **Needs you**: the open asks (`hub_dashboard.asks`, the server's list and
  its count, oldest first) through #107's `AskCard`, the one ask component, in
  its `compact` form (leader note 88): the asker's label and the ask's age
  (the Board's tick) on each card, the question clamped to 3 lines and,
  only when it is actually cut (measured after layout and on each resize;
  leader note 87; an OPEN question that fits its three lines after a resize
  is plain text again, note 95), a toggle opened by a tap on it (a tap on a link inside is
  the link's) wearing the one shared focus ring (`[role=button]` joins it in
  app.css); a question that fits is plain text, no role and no tab stop, options,
  Answer, Dismiss, Discuss and the closed and delivery wording as in the chat, over the view's
  own `AskBook` for the project it shows (the store the Hub uses). It follows
  the room at the view's read boundaries (`ensure`, else `reconcile`) and on
  the server's push of an ask or of the line that closed one (the Hub's own
  feed source, through the Board's connection), so an answer given in the
  chat, or on another client, repaints here, and one given here repaints
  there by the same push. A push while the view is hidden reads nothing (L6
  covers every origin, leader note 76): it marks the book stale, and the
  next showing's entry read reads it in full; a full read a push QUEUED
  while the view was shown is retired when the view hides (`AskBook.retire`,
  note 80) and marks it stale the same way; when the project changes, the
  read queued for the project left is retired; and the view's teardown
  disposes its book with its snapshot loader (`AskBook.dispose`: every
  queued read retires unrun, none starts after; note 85). An answer or a dismissal here reads the dashboard
  again, so the closed ask leaves the list. Drawn only on a server that
  announces `asks`, by the last login's answer (a closed socket keeps the
  cards and their drafts, muted). An ask whose row is not loaded shows who
  asks what as plain text, never a second card. "Discuss in chat" is the
  chat bubble's Discuss (hub-feed.md, #107; leader #109 note 82): the chat
  opens at the ask through the notification centre's jump (`discuss` on the
  jump request; a target known by its seq alone takes its id from the
  message), and on landing Reply is armed through the Hub's one reply entry
  for a live asker (a stopped one is refused there, #490), nothing for a
  gone one; the ask stays open. That is decided only once THAT room's roster
  has answered in this visit (`rosterOf`, leader note 80: a declared agent
  reads as stopped until then), by the same module and the same wait as the
  agent row's landing (`agent-landing.ts`: `discussFor`, `stepLanding`; note
  85): bound to its owner, the room and its visit (the Hub's selection
  generation, so A → B → A in one flush is a new visit and voids it), applied
  only while the Hub is visible and in focus, dropped if the roster answers
  while it is not, cancelled by a newer jump; never replayed.
  In the compact card a key on a link inside the question is the link's;
  Enter or Space on the question itself toggles it. A Hub shown for the first time by such a
  jump waits for its first project list before it may say the project is
  not there.
- **Now**: the four board counts in the sidebar's chip markup (a tap opens
  the Board view); the doing issue whose last change is oldest, labelled
  "last change"; the agents counted by `agentClass`, each ONCE, in
  the plan's § 4 order (leader #109 note 17): a detail `needsPerson` lists is
  "needs you" (it includes `cli_exited`, so an exited CLI is a person's to
  restart), then starting or exited without such a detail ("not running"),
  then a waiting turn, then a running one, then idle; the stopped homes are
  counted only. The line reads working · waiting · idle · not running ·
  needs you · stopped, each part only when it is not zero (`countParts`).
  A row for every agent that is not idle (needs you, not running, waiting,
  working, in that order), each
  with the one dot (`stateDotColor`, `.live-dot`), its label, the issue it
  holds and its status line with its age; no status line when it has none.
  Every age (status, note, finished) is the shared `.side-age` atom beside its
  words: the words elide, the age never does (#109 S5). An age is elapsed
  time against the page's CURRENT clock, the Board's one 1 s tick
  (`projectTick`, visible-only) passed down, so it keeps moving on a row
  kept muted after a failed poll and freezes only while the page is hidden
  (leader note 64). No second timer: the Hub's own tick lives on the Chat
  page, which the Board page cannot read. A
  row's tap opens the chat showing only that agent: one App request
  (`hubSelectReq` with `agent`), which the Hub applies through its own filter
  writer once the room's roster names the agent, so #482's lock and #101's
  rule hold. The landing's rules are a pure module, `hub/agent-landing.ts`
  (`landingFor`, `stepLanding`; T5, leader note 76), which the Hub feeds from
  one effect, bound to the room's visit like the Discuss landing below. The landing is bound to {server, session, agent} from the tap:
  applied only while the Hub is in that room and, when the roster comes, in
  focus and on screen (else dropped); void once the person leaves the room,
  the Hub loses focus or visibility after holding it, or a newer request
  comes; never replayed on return (#109 S6). Back returns to the Dashboard through App's one-deep return
  slot (`jumpedFrom`); the Hub's own layers peel first as always, so the
  first Back drops the agent filter (#432's rule) and the next returns, and
  the Hub's floor does not open its project list for a chat jumped into
  (`jumped`, Board's floor rule). Finished · 24h is a count
  that unfolds (its summary is a control like the rest: the control height,
  44px on touch).
- **Notes for you**: `notifications.toMe(m)` (bell-eligible AND to the
  person), the ONE predicate the notification centre's To-me view also reads,
  minus asks; the three newest, read through `hub_log` pages newest first
  until three are found or the room ends, at most 10 pages of 100: past
  that the view SAYS it stopped ("Only the last 1000 messages were read"). In
  this project's room To-me lines run at about 44 per 1000 messages
  (measured 2026-11-11), so three are normally in the first page or two.
  Unread = after the room's ONE server mark (`hub_unread`'s `marks`, #334),
  the same on every device; an unreadable mark marks nothing. The view never
  calls `hub_read` (only the Hub's feed moves the mark). While three lines
  are held, a poll never rescans held history (leader #109 note 29): it
  remembers topSeen, reads page 0, and only if page 0's oldest seq is past
  topSeen + 1 (more than a page arrived between polls) pages back across that
  unseen gap down to topSeen, never past it, so a To-me line in a burst
  still shows. Notes holds only its lines (at most three), topSeen and the first fill's 'more', never raw pages: a quiet poll leaves the same three (reviewer R1, leader note 110: the held pages had grown by an empty one per poll, rescanned each poll). The gap bounds that read, not the 10-page stop, which is the
  first fill's only (leader note 30): topSeen never moves past an unread row. A tap opens the chat
  at that message through the notification centre's jump.
- **Lifetimes**: one read is the whole snapshot (`hub_dashboard`, page 0,
  the mark), awaited with `allSettled`, so single()'s lock is held until
  every part has settled and a part that fails early never lets a second
  read start beside one still in flight (#109 S4); a read belongs to a generation bumped when the project
  changes and when the view goes, so a late answer of an earlier project is
  dropped; a project change reads at once, queued behind a read of the same
  project still in flight (A → B → A is read again, not left to the next
  poll); a closed socket (`onCaps(undefined)`) is "not connected", never "no
  dashboard": the switch follows the last login's answer and the data stays,
  muted, until a login answers and the view reads at once; every entry (a project change, or the view shown again)
  reads at once through the same single() loader, queued behind a read still
  in flight, and leaving bumps the generation so nothing read before lands
  after; the view's teardown also disposes its loader, so a queued entry
  read never starts once the view is gone; and a hidden view starts no read
  of any origin: a queued entry read that comes due while the view is hidden
  again asks nothing (the next showing queues its own, leader note 62); nothing is drawn before the first success; a failed read keeps
  the last complete data, muted, with "Not live"; hidden, the view polls
  nothing and reads at once on return.

## The project page (board #111)

The design and its reasons are docs/exec-plans/board-dashboard.md § 6 and § 9;
the rulings are on #111 (leader note 8). This section is how it is built.

### The store and its two operations

`projects/page.rs` owns `<ws>/.tmm/dashboard/`: `page.json` (`current`,
`next`, and the LIVE revisions `{rev, by, at_ms, retired_ms}`), `.lock`, one
folder per integer revision, and `.staging-<id>/` while a publication is
being copied. The server is its only writer: `tmm dashboard publish <dir>`
sends the folder absolute and unopened and the server reads it (#434 P1-D's
rule), so an agent whose sandbox cannot write `.tmm/` still publishes.
`server/page_rpc.rs` holds only the doors (`page_publish`, `page_unpublish`,
`page_load`; websocket-rpc.md).

- **Validate, copy outside the lock, commit inside it, then collect.** The
  whole bundle is validated FIRST, from its entries' own stat, before
  anything is created (regular files and folders only, nothing followed,
  index.html at most 512 KiB, 500 files, 16 folders, 20 MiB). Then it is
  copied into a staging folder, outside the lock (a slow copy blocks no
  reader), re-checking every opened object and counting the bytes; the
  COPY must hold its index.html (validator F2: a source changed after the
  validation is caught here). Under the flock: rename the staging folder to
  the next free number, retire the old current one and write `page.json`
  (tmp, fsync, rename, folder fsync). **The rename of page.json is the
  commit point** (leader, note 18). Any failure before it (validation, copy,
  the tmp write, the tmp fsync, the rename) removes the staging copy or the
  renamed revision and the tmp: no new revision, no `page.json.tmp`, and
  page.json byte-identical (or still absent). The store's empty SKELETON
  (the dashboard folder and its `.lock`) may remain after a failed first
  publication and is not a change: it holds no revision and no pointer,
  head and load answer no page over it, and a failing publisher never
  removes it, because a concurrent publisher may hold or wait on that lock
  (leader note 23). After the commit the publication has happened: nothing
  the pointer names is deleted, and a folder-fsync error is a durability
  `warning` on the answer (the CLI prints its ✓ line, then `warning: …` on
  stderr), never a refusal. Collection runs only after a commit that synced,
  and commits its own shortened page.json BEFORE it removes a folder, so
  nothing page.json lists is ever deleted; a failure of that rewrite is the
  same warning (`a_fault_in_collections_rewrite_is_a_warning_and_deletes_nothing_listed`). `a_fault_at_any_commit_step_leaves_the_old_store_or_a_complete_new_page`
  injects EIO at each step, for publish and unpublish.
- **No reader can block.** `page.json`, its tmp and `.lock` are opened
  `O_NOFOLLOW | O_NONBLOCK` and must fstat as regular files; a FIFO, a
  folder or a link is an error at once for every verb (F3), and an
  unreadable store is `page_error` in the dashboard read.
- **The first creation is idempotent** (F4): `mkdir` answering EEXIST is
  accepted when what is there opens as a folder, so concurrent first
  publications all succeed and the last wins.
- **The wide-root gate is the door's own** (S1): `rpc::too_wide_root`, the
  ONE check `fs_preview_base` uses (`/` and the canonical home folder are
  never a root). A project whose folder is one of them gets no page: publish
  refuses, and the head and the load are "no page".
- **Load and publish are serialized (AC2).** `page_load` reads the pointer,
  reads index.html from the revision's own handle and mints the cap
  (`download::scope_base`) inside the SAME flock. A revision is therefore
  retired no earlier than any cap minted for it, and collected no earlier
  than that cap expires. `a_publication_racing_a_load_waits_for_its_mint`
  starts a publication from inside the mint and fails when the mint is moved
  outside the lock (measured: the mutation turns it red). The unseamed
  stress test beside it checks the same invariant over 120 loads and 45
  publications, but its windows are too small to catch the mutation alone.
- **Collection uses the door's own lifetime.** At each publish and unpublish,
  a revision retired at least `DL_STREAM_TTL_SECS` ago goes, folder and
  entry, however many publications came between; `page.json` lists only
  live revisions (R7). An unlisted numbered folder or staging folder (a
  crash between the rename and the write) goes once its own mtime is that
  old, so nothing a loaded document could still read is removed.
- **A symlink is no page.** The store, the revision folder and index.html are
  reached from the project root's handle with nothing followed
  (`safe_fs::Dir`); a link at any step reads as no page in both the head and
  the load, and a publish refuses to write through a linked store.
- **Depth is part of the contract.** A revision is `.tmm/dashboard/<N>`, three
  below the root, so a page reaches a project file as
  `../../../<path from the project root>` (leader, Q1). The help, the skill
  and the prompt sentence each show it; `a_revision_sits_three_folders_below_the_project_root`
  fails if the layout changes.
- **The publisher** is `human` or a managed agent of the project, resolved
  and checked as `hub_ask`'s `from` (R8).
- **The head rides the dashboard read.** `hub_dashboard` carries `page`
  (`{rev, by, at}` or null) from an unlocked read of `page.json` (renames are
  atomic); a store that cannot be read is `page_error`, never "no page"
  (§ Could not ask). It only says a newer revision exists; the load reads
  again under the lock.
- **Not a transfer.** The #134 limiter caps the person's downloads and
  uploads; a page's pictures and media are the browser's subresource loads
  through the scope door, as in any Files HTML preview, and are not counted.

### The section (client)

`hub/ProjectPage.svelte` draws it and `hub/project-page.ts` holds its logic
(pure, tested); `Dashboard.svelte`, `Board.svelte` and `App.svelte` take
wiring only.

- **The frame is the Files preview's** (#433): `preparePreview` with ONE
  extra argument, the base sheet, placed after the policy, base and review
  style and before the author's head; same srcdoc, `sandbox="allow-same-origin"`,
  no scripts, same door. Links are the pipeline's one mechanism
  (file-handling.md § An HTML preview's links), opening files through the
  App's Files jump with `jumpedFrom = 'board'`: in the phone layout Back
  returns to the Dashboard (two steps from a file preview: the preview, then
  the folder, as for a path opened from chat); a desktop browser's Back is
  the browser's.
- **The app's look** (AC4): `pageSheet` writes the CURRENT computed values of
  `PAGE_TOKENS` (colours, the three font roles, the type steps, two radii)
  and an element sheet that uses only them. A live theme switch rewrites that
  one `<style data-tmm-base>` inside the kept document (a MutationObserver on
  `<html data-theme>`); the srcdoc never changes. The frame ELEMENT's
  `color-scheme` follows the same switch: when it differs from its document's,
  Chromium paints an opaque canvas behind the page (measured). The bundled
  webfonts do not reach the frame (its policy admits fonts from the door and
  `data:` only), so each role falls back along the app's own stack, CJK
  included (leader, Q3); embedding the faces as `data:` fonts is the
  follow-up if the owner wants them.
- **One scroll** (AC5): the frame's height is its document's block, measured
  at load and by a ResizeObserver on the document and the frame; a document
  being replaced reads 0 and keeps the last height, so the Dashboard's scroll
  is never clamped. The kept Dashboard wrapper (`.dash-keep`) is the page's
  ONE scroller.
- **Kept, never moved** (AC6, § 9): Board mounts the Dashboard whenever the
  server offers it and hides it (the `hidden` attribute on its wrapper) under
  the Board view, an issue or the create form; App hides the Board page on
  another tab. The #109 sections follow their HIDDEN rules then (leader Q5).
  Media keeps playing while hidden (Q4).
- **One adoption rule** (`decide`, AC6 as amended by Q2): no document loads
  the newest; a newer revision, or a document past its cap's expiry, is
  loaded only when no field is edited and no media plays (scroll kept);
  otherwise the header names the LOADED revision's publisher and offers
  Refresh ("A newer page by X is waiting." / "out of date"). Refresh on an
  edited page asks the app's discard confirm.
- **Every decision reads the live document** (leader note 31, validator
  F1/F2). `editedNow()` and `busyNow()` in ProjectPage are THE answers: the
  Board's doors (a project pick, the silent follow, a server switch's leave
  guard, the discard note) call `editedNow` through `onGuard`; Refresh calls
  it; an adoption calls `busyNow` again when its awaited load ANSWERS, and if
  the page became busy meanwhile the answer is dropped and the newer revision
  stays offered (a confirmed Refresh is the one load that applies anyway).
  The flag read on the page clock is for the header and to re-run a reactive
  gate only. WebKit delivers no in-frame event to the app, so nothing here
  listens inside the frame.
- **"Edited" is against the page as it loaded** (F3): the parent snapshots
  every control's value / checked / selected state at the frame's load and
  compares against it, because an untouched first option, range or colour has
  a value and no default attribute in Chromium and WebKit (measured: 6 of 12
  native cases were false edits before; 0 of 24 now, both engines).
- **Pending work belongs to its frame** (S1): a project or server change and
  the unmount stop the frame's link watcher; a link seen and waiting for its
  own back is dropped with its frame (and its own-back mark ends), and a link
  is routed only by the generation and with the opener and folder captured
  when its frame loaded. The Files preview's watcher drops a pending link the
  same way when its frame leaves the document (a file or server change).
- **The cap's expiry** is the segment right after the door's own prefix on
  that connection (`capExpiry(url, prefix)`), never the first `/dl/s/<digits>/`
  in the URL: a proxy prefix may hold one (F4).
- **Owners** (AC7): a load belongs to (api, session); a project switch or a
  new api drops a late answer; `page_error` keeps the last head; no head
  means no section.

### AC8: which backends can publish from their sandbox

Per backend (leader ruling, #111 note 29), with `node scripts/live-docker.mjs
page` as the measurement (each agent told to make `page-<backend>/index.html`
in its working directory with its own shell tool and run `tmm dashboard
publish`; the store must name the agent):

| backend | result | how we know |
|---|---|---|
| codex | can publish | MEASURED: the live check; the revision named `pgcodex` |
| claude | can publish | MEASURED: the live check; `pgclaude` |
| pi | can publish | MEASURED: the live check; pane `/work/live`, `✓ published revision 3 of live's page` |
| dsh | can publish | MEASURED by validator (#111 note 10): a managed dsh 0.2.0-rc.2 bash tool published and unpublished, against a scripted model |
| omp | can publish | NOT TESTED: its provider host was unreachable from the rig (`getaddrinfo ENOTFOUND`), so it never ran a tool. INFERRED from the design |
| kiro | can publish | NOT TESTED: not in the live image. INFERRED from the design |
| kimi | can publish | NOT TESTED: not in the live image. INFERRED from the design |

The inference: the SERVER is the only writer of the store and reads the
bundle itself, so a publish needs from the agent exactly what `tmm send` and
`tmm board` need, to run `tmm` and reach the gateway, which every managed
backend does as the bridge's third primitive. Cited from the launch recipes
too: every managed backend runs its tools unconfined (codex
`--dangerously-bypass-approvals-and-sandbox`, claude
`--dangerously-skip-permissions`, kiro `--trust-all-tools`, omp
`--auto-approve`, kimi `--auto`, dsh `DSH_PERMISSION_MODE=danger-full-access`).
A folder the SERVER cannot see (a CLI's private temp) is refused with the
path named and nothing written: `tmm: /nope: No such file or directory (os
error 2); nothing was published` (the rig's gateway).

### The probe page (AC9 b): the native check

`scripts/fixtures/project-page-probe/` is #110's hostile and render probes
as ONE page a person can read: every attempt in it to run (inline and
external script, SVG onload and script, event handlers, a nested frame) or
to load from another site (a picture, a CSS background, a web font, an
`@import`) would visibly mark it, and a clean probe reads "nothing ran,
nothing left". Publish it with `tmm dashboard publish
scripts/fixtures/project-page-probe` from a project on the owner's server
and open the Dashboard on the phone and the Mac. Rig result (Chromium and
WebKit): every row "did not run", every request to another origin blocked by
the policy (Chromium reports `csp`), the in-bundle picture and sound through
the door. The native result is the owner's look, recorded on #111.

## Not here

The bell and the bubble (#107, hub-feed.md); page actions (#112).
