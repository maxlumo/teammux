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
| room | the fold's project row (`hub_rpc::fold`): its recorded room, else `proj:<session>`, `session_room_checked`'s rule from the same row | never the dispatcher's `room` (reviewer note 65) |
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

## Not here

The view (#109), the bell and the bubble (#107), the project page (#111).
