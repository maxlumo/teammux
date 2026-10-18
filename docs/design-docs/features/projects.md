# Projects — a workspace you can close and reopen

> Implemented: P0 of [`docs/exec-plans/projects-and-tasks.md`](../../exec-plans/projects-and-tasks.md).
> Tasks, the board and scheduling are later phases and are NOT here yet.

## Problem

A tmux session exists only inside the running tmux server. A reboot, a crash or
one stray `kill-server` and the machine forgets which workspaces were open,
where each was rooted and which agent CLI was running in it. Rebuilding that by
hand costs enough that closing a workspace never feels free, so sessions only
accumulate — the entropy the owner reported.

Team sessions (`tmm-team-*`) already had a durable registry and startup
recovery. Ordinary sessions — the ones the user actually lives in — had nothing.

## Shape

**The declaration is the truth; the tmux session is a disposable projection.**

```
Project = { path, name, session, slots[] }
slot    = one window's intent = { window_name, cwd, kind: shell | agent }
```

Three verbs, all in `src-tauri/src/projects/`:

- **`up`** (`reconcile.rs`) — ensure the session exists, then give every settled
  slot a window. Idempotent *by construction*: windows are matched **by name**
  and only missing ones are created. Nothing is renamed, reordered or
  restarted, because the session being reconciled may be the one the user is
  typing in right now. A freshly created session already owns one window named
  after the shell; the first slot takes it over (`tmux::rename_window`) instead
  of leaving a stray behind.
- **`down`** — kill the session, keep the declaration. This is what makes
  closing a workspace free.
- **`adopt`** — take a session the user made by hand, keep its name, and settle
  its current windows immediately. An adopted project must be restorable even
  if the machine reboots a minute later.

### Every session is a project

There is no such thing as an untracked session any more, and there is one way to
make a workspace. Two consequences fall out of that:

- **Auto-tracking.** `auto_adopt_once` runs on the capture tick and adopts any
  session that isn't a project yet — so `tmux new -s foo` in a terminal shows up
  as a project by itself, and on first run this is also the migration for
  sessions that already existed. Three guards keep it from becoming a new source
  of entropy: a session must have existed for `SESSION_SETTLE_SECS` (120 s, the
  same reasoning as the window settle rule one level down — a workspace is
  something you come back to, a two-minute shell is not); team sessions are never
  adopted (Team creates and kills its own, so a declaration would fight it); and a
  project you ARCHIVED is never re-adopted, or "remove from projects" would undo
  itself on the next tick.
- **One session is not a project: the scratch terminal's** (board #324, owner
  2026-10-09: "这个 Terminal 只是临时用的，并且跟你的项目没有关系"). It is
  recognised by OWNERSHIP, never by name: `projects::scratch::owned` = the exact
  session `tmm-scratch` exists AND carries the tmux session option
  `@tmm-scratch=1` (set when `scratch::ensure` created it; a native tmux fact, no
  new store) AND no project row declares that session — a project that is down
  still holds its name. `auto_adopt_with` skips a session that is Ours. A plain
  session or a project already holding the name is `Taken`: ensure and kill
  refuse with the reason and never take it over, kill, rename or undeclare it,
  and auto-adopt treats it like any other session. Project create suffixes and
  rename refuses a live session name as before, so the two cannot share one.
  A direct `adopt` (Sessions page, `tmm project adopt`) refuses an owned scratch
  session too. The RPCs are desktop-gated like the module (`MethodNotFound` on a
  phone build). Its tests never touch the real `tmm-scratch`: `scratch::name()`
  is pointed at a `tmux::Scratch`-guarded name per test (testing.md: every cargo
  run shares one tmux server); verified with a live `tmm-scratch` canary that
  survives `npm run test:rust` — since #326 the canary covers its hooks too.
- **Its NAME is reserved from every claiming path** (board #337, owner
  2026-10-09: "我打开快捷 terminal 的时候，直接报这个错误，完全用不了"). This AMENDS
  the "recognised by ownership, never by name" rule above for the paths that
  CLAIM a session, and the two point in opposite directions rather than
  conflicting: ownership-by-mark is what stops us STEALING a session that is
  not ours (`ensure` and `kill` still refuse an unmarked same-name session,
  unchanged), and the reservation is what stops us CLAIMING one. Declining a
  name is always safe; claiming it is what broke.
  - **The incident.** The dev stack's watcher journal dates it exactly: the
    server running at 05:03:38 had started at 04:06:58, seven minutes before
    `7cce2857` (04:13) introduced the mark and the `is_scratch` guard. That
    build had no scratch concept, so its `auto_adopt_once` claimed an unmarked
    `tmm-scratch` session (whose shell sat in /tmp, hence `path=/tmp`) 120 s
    after it appeared. The next build had the guard, but a project row now
    declared the name, so `owned()` answered
    `Taken("the name 'tmm-scratch' belongs to project 'tmm-scratch'")` from
    then on. `project up` on that row later created the session that was live.
    The panel's only affordance, "Open again", re-asked and got the same
    refusal: one stale session had permanently disabled the feature.
  - **The rule.** `scratch::reserved(session)` is the one predicate. The
    AUTOMATIC claim (`auto_adopt_with`) skips the name whoever holds it; a
    direct `adopt` refuses it with the reservation as the reason;
    `free_session_name` treats it as taken, so `create` suffixes past it
    whether or not a session is running (a DECLARATION is what kills the
    panel, not a live session); and `rename` REFUSES it rather than quietly
    decorating it, like every other taken name.
  - **Recovery is the reader's, not ours.** The first design repaired the
    hijacked row at server start, gated on `adopted = 1`. Review refused it,
    correctly: `adopt_in` sets that flag for a session the USER asked us to
    track as well as for one the capturer found, so it cannot tell our own
    hijacked row from somebody's workspace — and renaming a person's project
    under them while they are not looking is not a repair. So
    `scratch::release(projectId, session)` runs only on an explicit, confirmed
    request from the panel (`scratch_release`), and it is about ONE identified
    project: the refusal carries `{projectId, projectName, session}` as its
    error data, the confirmation names that project, and the release renames
    only if it still declares that session right now — otherwise nothing is
    touched and the answer names the current holder. Review caught the first
    cut re-resolving the holder at execution time: the reader would have
    approved releasing one project and a different one could have been renamed
    if the name changed hands in between, which a confirmation button cannot
    prevent. **The expectation travels into the write**: the holder check and
    the rename were still two separate critical sections — the store lock is
    released between them — so the expected session is passed to
    `projects::rename_if_session`, which re-reads the row under the lock it
    writes with. Re-reading alone would refuse nothing, because the id still
    exists; the caller's expectation is the only thing that can. Release's own
    check stays as the fast, informative refusal, and the candidate name is
    allowed to go stale in the other direction: `rename` refuses a name
    another project holds, so a lost race there is an error and an unchanged
    store, never a release onto an occupied name.
    **A stale confirmation is RECOVERED from, not reported.** Every refusal
    that means "the state you decided from has moved on, and nothing was
    written" is `projects::Refused::Stale`, which the server sends as its own
    code (`-32011`): nothing was touched, so a sentence about a project that
    has since moved on leaves the reader exactly where the incident left
    them. That is release's two snapshot refusals — nobody holds the name,
    somebody else does — AND the in-lock expectation that
    `rename_if_session` refuses, which is the very race the single critical
    section exists to catch (review, 19:23: it used to arrive as a plain
    internal error, so the panel kept the expired confirmation and an error
    beside it). One type carries the distinction from the write that refuses
    to the socket that answers, so `release` propagates the rename's
    classification with `?` and no translation step can lose it.
    The panel drops the stale snapshot and asks `scratch_session` ONCE, the
    one path that says who holds the name now — free, and it opens; still
    held, and that refusal names the CURRENT holder and offers the action
    again. It does not open the new confirmation for them: approving one
    project must not carry over to a project they have not looked at, which
    is the same rule that made the snapshot exist. Everything else the release
    can answer is a failure with the server's sentence, and the panel keeps it
    on screen — which is why each refusal is classified where its comparison
    lives, instead of being sniffed from the message.
    The recovered name is `<reserved>-recovered`, or — when that is
    taken — the name the ONE suffixing rule picks (`free_session_name`'s
    digest on a shortened `-rec` base); every candidate is bounded to `slug`'s
    24 characters BEFORE it is offered, because a truncated label is a name
    neither this policy nor `free_session_name` chose (measured: with a long
    reserved name two candidates collapsed onto the same string and the rename
    refused itself). **`released: true` is earned, not assumed**: a rename can
    answer `Ok` without moving anything — it moves the tmux session and re-keys
    the row as one act, and when tmux refuses its half (the reserved session
    was killed between the liveness check and the rename, which is one tap away
    in the same panel) it leaves the declaration where it is. So `scratch::freed`
    decides on the END STATE from two facts — the session the rename says the
    row now declares, and who holds the reserved name afterwards — and the
    answer's `renamed_to` is the session that was WRITTEN, never the one we
    asked for, so the answer and the row cannot disagree. That decision is one
    pure function with every refusal pinned, because the live path cannot be
    driven into those states: `session` is UNIQUE and every claiming path
    declines the reserved name (so no second holder can exist), and only tmux
    refusing the session rename leaves it held — which no test can inject
    between the liveness check and the call. Nothing is deleted and nothing is
    archived:
    the row keeps its id, path, room and history, and `projects::rename`
    carries a live session with it, so a shell inside survives. Archiving
    would not have worked — an archived project still holds its session name
    on purpose, since it can be restored and brought up.
  - **Occupancy is the CURRENT session only.** `declaring_project` asks
    `project_by_session`, not `projects::project_for_session`, which also
    matches a project's `prev_session` — a historical alias kept so a renamed
    project's room still resolves. A project that USED to be called
    `tmm-scratch` does not occupy the name, and counting it would keep the
    panel refused forever, including immediately after a release, which
    leaves exactly such an alias behind.
- **It is HIDDEN, and its shell can exit** (board #326, owner 2026-10-09:
  "不需要作为一个真实的 project 显示出来，就是一个隐藏的会话就好…退出这个隐藏
  会话时，也不要关掉"). This REPLACES the earlier rule that Sessions and
  Terminal listed it like any tmux session.
  - **Hidden from every listing, by ownership.** `scratch::hidden_session()` is
    derived from the same `owned` predicate — `Some(name)` only while the
    verdict is `Ours`, `None` for `Absent`, for `Taken` and for a FAILED read,
    so the name alone never drops a row. `server/rpc.rs` filters the two
    listing doors through one definition (`without_hidden`, applied to the
    sessions AND to their panes, because a listing that kept the panes would
    still leak it): `list_sessions` and `list_sessions_with_panes` — the
    Sessions page, Terminal's pane picker, the Hub drawer and App's first pick
    all read those. Targeted calls are untouched, so the panel still
    subscribes, captures, types into and resizes its own pane. A plain
    same-name session the user made, and a name a project declares, stay
    visible exactly as before.
  - **Exiting the shell does not end it**, and that is tmux's own mechanism,
    not a process manager of ours (tenet 2). `ensure` applies, idempotently and
    only to its own window and session: `remain-on-exit on` (a WINDOW option,
    so it is set through the pane target — a session target would only reach
    that session's current window) and the session hook
    `pane-died: respawn-pane`. Measured on **tmux 3.6a**: before this,
    `exit` in the pane closed the only window and the SESSION disappeared
    ("can't find session"); with the keep-alive the pane comes back with the
    SAME `%id` and the same `session:window.pane` target, which is why the
    Terminal's subscription survives it. The hook body is bare
    `respawn-pane`: no target, because tmux runs a `pane-died` hook against the
    pane that died — verified with two panes, only the dead one was respawned
    and the live pane kept its shell pid (the explicit
    `respawn-pane -t "#{pane_id}"` form stores fine and never fires on 3.6a) —
    and no `-k`, for the reason below. The respawned shell starts in the
    pane's creation directory, which for this session is `$HOME`
    (`new_session(_, None, None)` passes `-c $HOME`) — measured with a pane
    created in `/tmp/probe-cwd` that had `cd /usr`'d: it came back in
    `/tmp/probe-cwd`, never `/`. No global option or hook is touched.
  - **`ensure` hands back a LIVE pane, and "only a dead pane" is TMUX's
    decision.** A pane that died before the keep-alive existed (an older
    session, a hook someone removed, an exit between create and hook) is
    repaired here. The first implementation read `pane_dead` and then ran
    `respawn-pane -k`, which review (#326 P1) correctly called a
    check-then-kill: between the read and the call the `pane-died` hook or a
    concurrent `ensure` can revive the pane, and the `-k` would then have
    killed a live shell and whatever it had started. So **nothing in this path
    carries `-k`** — neither `tmux::respawn_pane` nor the hook. tmux refuses to
    respawn a pane whose command is still running ("pane … still active"),
    which makes the whole thing ONE atomic tmux decision; our `pane_live`
    reading is only a fast path. Measured on tmux 3.6a: a repair aimed at a
    pane running `sleep 120` is refused with the shell's pid and its command
    untouched, and two concurrent repairs of one dead pane end with one winner,
    one refusal and a surviving shell. The END STATE is what `ensure` answers
    on — a refusal whose pane is now live is success (someone else won the
    race), and anything still not live is an error naming the target — and an
    UNREADABLE liveness answer (`pane_live` → `None`) falls on the repair side,
    which costs nothing now that a repair cannot kill anything — and
    `pane_live` is STRICT about what it accepts as an answer: `#{pane_dead}`
    is `0` or `1`, and anything else (a missing pane's empty answer, a format
    tmux stops supporting) is UNKNOWN rather than live, because "not 1 means
    live" is exactly how an unanswerable pane would be handed out as ready.
    Everything
    after the first read names the pane by its tmux `%id`, read once:
    `session:window.pane` is a POSITION and a pane created beside ours
    renumbers it, so the check and the repair could otherwise land on two
    different panes; the `%id` is stable for the pane's life and is what
    `respawn-pane` keeps. The positional target the client subscribes with is
    read BACK from that id at the END of the call, never handed over as the
    pre-repair string: a pane created or killed beside ours while we work
    renumbers positions, so the earlier string could name a pane this call
    never checked. That read carries the pane's SESSION and it is
    CHECKED: a `move-pane` into another session keeps the `%id` valid, and an
    unchecked answer would have paired `session: tmm-scratch` with a foreign
    pane — sending the client through the scratch door into another session,
    with the two fields of one answer contradicting each other. The target is
    rebuilt from the two verified fields (session name, then position), never
    split out of a joined string, because a session name may contain spaces.
    The verdict is a pure function, so every refusal — gone, malformed, moved
    out — is pinned without racing a live call; the races themselves are
    closed by construction and pinned by "the answer names the pane we
    checked".
    TWO facts are checked before a target is handed out, and neither stands in
    for the other: that one is about THE PANE, and `still_ours(owned()?)` is
    about THE SESSION — its mark can be unset, a project declaration can claim
    its name, or it can be gone and recreated by someone else while we work,
    none of which a pane-position read can see. Ownership was true at the top
    of the call; answering asserts it is still true. A `Taken` session answers
    with the sentence `owned` already composed, so a mid-call refusal reads
    exactly like a refusal at the start. A repeated ensure is pinned to keep the shell pid across
    three calls, across a running command, and across the review's exact race
    (observed dead, revived by another path, then repaired).
  - **Explicit Kill is still the only way to end it.** `pane-died` is a session
    option, so it goes with the session: measured, `kill-session` on a session
    carrying the hook leaves no session behind rather than a respawned pane.
- **One create path.** The old "new session" form now creates a *project* and
  brings it up (`project_create` + `project_up`), so the second `+` in the
  Projects header is gone. A bare `new_session` would have been pointless anyway:
  the auto-tracker would adopt it seconds later. The form's Kiro/Claude/Codex
  presets became `agent` — they seed one settled agent slot instead of a raw
  command line, which is what makes the agent relaunch AND resume on every later
  `up`. Free-form commands were dropped from the form on purpose: a shell command
  is observed-only and never replayed, so offering to type one there would
  promise something `up` does not do.

The Track button is gone with them: tracking is not a decision the user has to
make per session any more.

### Identity is the session, not the directory

v1 made `path` UNIQUE and derived a project's directory from the session's
**active pane**. Both were wrong, and together they made most real sessions
un-trackable:

- Several sessions parked in `$HOME` is the normal case, not a conflict. With
  `UNIQUE(path)` the first one adopted claimed `~` and every later one failed
  with *"`/Users/me` is already project 'Default'"*.
- The focused window is often a shell in `$HOME` while the actual work sits in
  another window. A session whose second window ran an agent in
  `~/work/poc/260728-ds160` was recorded as a project rooted at `~`.

So (schema v2): uniqueness lives on `session` — two projects fighting over one
tmux session name is the real conflict — `path` is merely indexed, and the
workspace directory is decided by `pick_workspace` over ALL windows: most
frequent cwd wins, `$HOME` only wins when nothing else is on offer, ties break
toward the shortest path (the one closest to a project root when windows sit in
sibling subdirs). A window that does sit outside the project keeps an absolute
cwd, so it is restored where it was.

`project_create` had to learn the same lesson a second time (owner report,
2026-08-19): the schema had moved uniqueness to `session`, but `create` still
opened with "is there a project at this canonical path? → return it", so
creating a NEW project inside a directory some existing project already used
silently merged into that project — the dialog said created, the store said
nothing happened. Dedup now follows identity: only the literal same request
(same wanted session name AND same canonical path) is idempotent and returns
the existing row (un-archiving it); a session-name clash at a different path
falls through to `free_session_name`'s suffixing, and the id is salted past a
collision so even same-name-same-path coexistence works when an explicit
session distinguishes them. `project_by_path` was deleted outright so
path-identity cannot creep back in.

Migrations run with `PRAGMA foreign_keys=OFF` and this is not optional:
libsqlite3-sys builds its bundled SQLite with `SQLITE_DEFAULT_FOREIGN_KEYS=1`,
so enforcement is ON by default, and a schema rebuild's `DROP TABLE projects`
then performs an implicit `DELETE FROM` that cascades every child row away
(slots, and the snapshots table that existed at the time). The migration test
caught exactly that.

The steps run in ONE transaction with the `user_version` stamp inside it
(`Store::migrate` → `migrate_steps`, 2026-09-03 review). Before, each step
autocommitted and the stamp was written last, so a failure after step k left
the database half-migrated but still stamped old: the next open re-ran step k,
hit "table already exists" (the plain `CREATE TABLE`s are deliberately not
idempotent — a step is a one-time schema change, not a floor; `heal()` is the
floor), and `Store::open` failed for ever. Now the database is either fully at
`SCHEMA_VERSION` or exactly as it was, and `a_failed_migration_step_rolls_every_step_back`
pins it. Two consequences: `init` sets `PRAGMA foreign_keys=OFF` BEFORE the
transaction because SQLite ignores that pragma inside one, and no step may
toggle it — the v7 step used to switch it back ON, which then applied to every
later step's rebuild.

The reverse direction, `capture.rs`, is why nobody hand-writes a project: a
20-second loop folds live tmux back into the declaration.

That tick is blocking work — tmux subprocesses (and the `ps` behind
`list_panes`), a `launch.json` read per window, SQLite — so `capture_loop` runs
it on tokio's blocking pool, and `capture_once` splits it in two (2026-09-03
review): observe every live session FIRST with no lock held, then take the store
lock once to fold. Every RPC goes through the same `with_store` mutex, so
observing under the lock stalled each of them for the length of the tmux walk;
now the lock covers a few statements per project. A project deleted between the
two phases is skipped rather than failing the tick. `models::list` follows the
same rule for its cache: the ~3 s `--list-models` fetch runs outside the lock,
because every registry save validates through it.

### Renaming moves the session too, and never the room

`project_rename` (RPC, `projects::rename`, `tmm project rename <session> --name`)
updates `projects.name` AND renames the tmux session to `slug(name)`. The Hub's
chat header is the control: the title is a button that becomes an input in place,
Enter/blur commits, Escape cancels.

The session has to follow, because it is the name the Terminal's header and
`tmux ls` show — renaming only the label left one project wearing two names
(owner, 2026-08-19: "没有改tmux session的名字 所以在terminal显示不对"). Three
things make that safe, and all three are the reason the first version did not do
it:

- **The chat room is recorded on the project, not derived from the session**
  (`projects.room`, schema v8, backfilled as `proj:<session>`). The room id was
  `proj:<session>`, so a rename would have orphaned the conversation. Now the id
  is frozen at birth and `project_room()` reads it, falling back to the derived
  form for anything older.
- **The previous session name keeps resolving** (`projects.prev_session`;
  `project_for_session` checks it after the current name). A running agent has
  `TMM_PROJECT=<session>` baked into its environment and a process cannot be told
  otherwise, so without this every `tmm send/status/done` from an agent that was
  already up would fail until someone restarted it. Only the most recent previous
  name is kept — two renames in a row leave the oldest unresolvable, which costs a
  restarted agent nothing and keeps this to one column instead of a table.
- **tmux goes first.** If `rename-session` fails (the name is taken by a session
  no project claims), the declaration is left alone rather than drifting away from
  the session it projects onto. `free_session_name` picks a free name first, so
  this is the belt to that braces.

There is no exception for **adopted** projects, and the first version's was a
mistake worth remembering: it skipped them on the theory that their session name
is their owner's. But `auto_adopt_once` adopts every untracked session
automatically — that is the migration path and the "every session is a project"
rule — so `adopted` mostly means "the app found it before it was declared", not "a
human chose this name". On the owner's own machine 2 of 4 projects were adopted,
including the one being renamed, so the exception silently disabled the feature
exactly where it was asked for ("tmux不能改名字吗", 2026-08-19). A rename typed
into our UI is the instruction; nothing else needs consulting.

Client-side, everything keyed by the session name follows. The Hub re-selects the
project under its new name and `hubPrefs.renameSession` moves the remembered lead
and the read marker (both keyed by session). The Terminal is the case that cannot
be reached from there: it may be showing `<old session>:<window>.<pane>`, which
stops resolving the instant tmux renames the session, so the Hub dispatches a
`project-renamed` event and App remaps the live target and every split cell
through `retarget` (pure, tested — only an exact session-name prefix moves, so
`older:1.0` is left alone).

## The capture rule

**A window must survive `SETTLE_SECS` (120 s) before it becomes restorable.**
The window you opened to grep one file and closed again must not reappear on
every future `up`. Unsettled slots are still persisted — `first_seen_at` has to
survive a server restart — but `up` skips them until they settle. An ordinary
window that disappears simply leaves the declaration: it is not part of the
workspace any more. A **managed agent is the deliberate exception**: its
isolated home proves durable membership, so Stop removes only the window while
capture retains the slot and conversation id; Remove explicitly deletes both.

There is no history beyond that, on purpose. **The declaration IS the last
observed state** — closing a project does not touch it (capture only reads live
sessions) and a restart reads it back — which is exactly the "state before I
closed it / before the reboot" people want. A 20-deep topology history existed
here briefly and was removed: two days of real use produced one snapshot per
project (the one written at adopt, identical to the current declaration), what
people actually want back is *content* rather than window names (covered by the
pane's scrollback and by agent resume), and its `restore` could not deliver
anyway — it rewrote the declaration without projecting it, so on a live project
the next capture tick threw the restored rows away. The only real cost of the
removal: changes in the ≤20 s before a crash are lost.

## What `up` will and will not run

Only agent slots are relaunched. An observed `npm run dev` or `vim` is recorded
on the slot for display and **never replayed**: restoring a workspace must not
re-execute whatever you happened to be running last time. Each slot carries an
`auto_run` flag — set for agents, clear for shells — so this stays a data
decision rather than a special case in the reconciler.

`agents.rs` is one table used for **both** detection and relaunch, so the two
can never disagree; a detector that recognises "codex" but relaunches something
else would quietly rebuild the wrong workspace. Detection reads the pane's
PROCESSES only — `pane_current_command`, then for the pane process and each
process below it the NAME of the program it runs: argv[0]'s file name, plus the script's file
name when argv[0] is an interpreter (`node …/bin/codex`)
(`agents::detect_processes`). A name counts only when it is EXACTLY one of a
backend's `programs` (`kiro-cli`, `codex`/`codex.js`, `kimi-code` …, declared
in each `backends/<name>.rs`): the `kiro-web-search` helper is not kiro
(validator, #260). Other arguments are data — `rg grok` runs rg — and
directories are labels: `~/work/kiro-tools/bin/deploy` is not kiro
(orchestrator, #260). The SHALLOWEST match wins: a later match is a subprocess the agent spawned (a real case was codex
spawning a `kiro-web-search` helper and being labelled Kiro). Claude Code is the
one install shape read from a path: its binary can be
`…/claude/versions/<version>`, whose name is a bare version number, so exactly
that layout counts as claude (`versioned_binary`, `claude.rs`). Labels are not
evidence: `pane_title` is whatever the last CLI wrote and nothing resets it on
exit, so a zsh where grok had quit still read "grok" and wore its icon
(owner, 2026-09-28, board #260); the window name is a label too. The verdict
is computed once per pane in the listing (`TmuxPane::agent`) and the client
reads that field — it has no matcher of its own.

## Restoring the conversation, not just the window

A rebuilt window with a blank agent prompt is only half a restore: the point of
reopening a workspace is to carry on. So an agent slot remembers **which
conversation** it was in and `up` resumes it.

Flags come from the installed CLIs' own `--help`, not from memory:

| backend | exact conversation | managed-home fallback when id is missing |
|---|---|---|
| kiro | `kiro-cli chat --resume-id <id>` | `kiro-cli chat --resume` |
| claude | `claude --resume <id>` | `claude --continue` |
| codex | `codex resume <id>` | `codex resume --last` |
| grok | `grok --resume <id>` | `grok --continue` |

The managed path (`spawn::relaunch_line`) picks exact id first, then recent in
the agent's isolated home. `codex resume --last` is safe **only there**:
`CODEX_HOME` belongs to one managed agent and Codex filters `--last` by cwd, so
it cannot reopen another project's conversation. The generic
`agents::launch_line` path uses shared `~/.codex` and deliberately starts Codex
clean without an id; there `--last` could cross projects. Kimi/openclaw still
get no resume flags because their dialects are unverified.

The recent fallback is not cosmetic: hooks update the in-process id immediately,
but capture reaches `state.db` only every 20 seconds. Restarting inside that
window — or starting an agent whose slot was not settled yet — must resume the
isolated home's newest cwd conversation rather than open blank.

Where the id comes from: the agent lifecycle hooks already carry `session_id`
(`agent_notifications.rs` has been normalising it into `agent_session_id` all
along, keyed by tmux session + window). The hub now keeps the last id per window
in memory and the capturer stamps it onto the slot, so the durable copy lives in
`state.db` — which is the point, since the thing that has to survive is exactly
the reboot that loses tmux. `projects` never names the notification types: it
declares an `AgentSessions` trait and the hub implements it.

The stamp is **sticky**. A hook only reports at the end of a turn, so an
observation without an id must not erase what we know; a *different* id replaces
it, and a live window that stops being an agent drops it. Stop is different:
the managed home remains, so capture keeps the absent agent slot and its last
exact id. If no id was captured yet, the isolated-home fallback above resumes
the newest cwd conversation.

## After a host reboot: the evidence (board #422, round 1)

Incident, 2026-10-18 03:06: the devbox rebooted for a kernel patch. systemd
brought the gateway back at 03:09, but tmux is not a unit, so every session
was gone, and the owner rebuilt six projects by hand at 11:09. Everything a
restore needs was already durable (the declaration, each agent's recipe and
conversation id). What was missing is the decision: which projects were up
when the host went down, and whether the host really went down.

Round 1 records the evidence and makes the decision as pure functions
(`projects/restore.rs`, `store/restore.rs`). Round 2 adds the executor
(below). **Nothing calls it at gateway start yet**: that waits for round 3's
input barrier for restored windows, and `autostart` is still not acted on.

- **The checkpoint is a complete observation, committed with its folds.**
  Each capture tick lists its tmux socket's sessions ONCE (`list-sessions -F
  '#{pid} #{start_time} #{socket_path} #{session_name}'`), and that listing
  also decides which declared sessions are live. The tick publishes
  `meta restore_checkpoint:<socket>` (the configured socket, else the
  implicit default) only when three things hold. The listing succeeded
  before AND after the observation, both times naming the same server
  (`pid`, `start_time`, socket). Every live project's windows were read.
  And every slot fold of the tick is written in the SAME IMMEDIATE
  transaction (`Store::commit_tick`). A fold the store refuses, or a crash,
  rolls the whole tick back, so the previous checkpoint and the previous
  slots stay together (review P1-B). An incomplete observation still folds
  but advances no evidence. The value is one JSON object: `{gen, at,
  boot_id, tmux:{socket,pid,start_time}|null, projects:[{id, session,
  windows:[{name, kind, managed, backend, agent_session_id}]}]}`. Each
  window is described by the slot that tick folded for it. `managed` is the
  window's provenance at that moment (`is_managed_in`). No server before
  and after is a complete observation too: `tmux:null`, no projects.
- **An empty tick keeps the last evidence of a server** (orchestrator's
  decision on validator F4). Publishing a `tmux:null` checkpoint over one
  that saw a server keeps that one as `restore_checkpoint_prev:<socket>`. A
  further empty tick keeps it, and a tick that sees a server again drops it.
  A restore reads `evidence(latest, prev)`: the kept one when the latest saw
  no server and both are from the same boot, else the latest. So a tmux
  death in the last tick before a reboot still restores. A kept checkpoint
  from an earlier boot never does. The flip side is deliberate: "kill every
  session by hand, then reboot" restores, unless a down was issued. A down
  (or a kill through the Sessions page, below) is the way out.
- **`tmux_now` keeps three answers apart.** Present (with the instance),
  Absent (`session_confirmed_absent`: no server, no socket file, a stale
  socket), and Unknown (anything else, e.g. `Permission denied`). Unknown is
  never read as an empty server.
- **A person's down and Stop are durable, versioned intents.**
  `projects::down` writes `meta project_down:<id>` BEFORE it kills the
  session. A kill that fails leaves the session alive and marked, and the
  error says so. Stopping a managed agent (`hub_agent_stop` / `tmm agent
  stop`, and a team restart's "no longer in team" stop) writes `meta
  slot_stopped:<id>:<window>` before the kill. So does the Sessions page:
  its `kill_session` writes the down for a project's session, and its
  `kill_window` writes the Stop for a managed agent's window (validator F3).
  A mark's value is its version, from the monotonic `restore_intent_seq`
  counter, never a clock. No observation ever revokes an intent: a project
  seen live after its down, the same second included, stays suppressed.
- **Only a start clears an intent, and only the version it read** (review
  P1-A). Each top-level start verb takes ONE `StartPermit` for its (project,
  window) BEFORE any side effect, and the permit records the Stop version
  that stood then. The verbs are the hub's Start/Restart (taken before its
  kill), a team restart's member (likewise), a spawn (once its window name
  is decided, before anything is written; a hire, a team member and a fork
  all go through it, validator F1), and a project `up`. Nested launches
  (`respawn`, `launch_window`, the resume) never read the mark: they run
  under the verb's permit. The verb finishes the permit once, at its end,
  and clears exactly that version (`DELETE … WHERE value = v`), only on an
  error-free success. A Stop written while the verb ran, or a newer one that
  replaced the version it read, stands. A project `up` (`up_with`) clears the
  down only when no slot reported an error, and a window's Stop only when
  that window came up created/existing with no error. A Start whose window
  came back but whose CLI did not launch returns that error to the Hub
  (`restart failed: …`); it is not a restart (review P2). `agent_remove`
  forgets the agent's Stop whatever its version, and deleting the project
  removes all of its marks. Every agent stop (the button, `tmm agent stop`,
  a team restart's "no longer in team") is one helper, `stop_agent_window`:
  the mark first, and a stop that cannot be recorded kills nothing.
- **A Sessions-page close is one operation on one window** (review P1 on
  F3). `close_window` resolves the target (`session:index`, `session:name`
  or `@id`) by LISTING windows, never with `display-message`. That command
  answers a missing target with some other window, or with nothing and exit
  0 (measured, tmux 3.6a). The resolved identity is the server incarnation
  (socket, pid, start time: the checkpoint's definition, since a new server
  can reuse a pid and an `@id`), the session, the name and the native `@id`.
  Managed-ness is asked three ways (`managed::managed_state`): Managed (a
  marker is there), Plain (every marker confirmed absent), or Unknown (a
  marker could not be read, e.g. an unreadable agents dir). Unknown refuses
  the close; the readers' `is_managed_in` keeps its fail-open bool. The Stop
  is written under the project that declares that PHYSICAL session, and only
  while it still does. Then `close_window` re-checks that the same server
  incarnation still shows that `@id` under that session and name, and kills
  the `@id`. It never kills the original string, which a renumber can point
  at another window. A target that is confirmed gone is done. A lookup tmux
  cannot answer, a target that names no window, an unreadable marker, or a
  project that changed meanwhile is an error, and nothing is killed.
- **The trigger is a host reboot that took the server with it**
  (`reboot_trigger`). Four conditions must all hold: restore is enabled; a
  checkpoint exists for the socket; the checkpoint's boot id and the current
  one are both known and differ (Linux `/proc/sys/kernel/random/boot_id`,
  macOS `kern.bootsessionuuid`); and tmux is now Absent or another instance.
  Everything else restores nothing: the last session killed while the
  gateway was stopped, or a `kill-server`, with no reboot after it (same
  boot; a reboot after it restores from the kept checkpoint, see "An empty
  tick", unless a down was issued); a session missing from
  a live server (same instance); an unknown boot or tmux state; and no
  checkpoint (the first start after the upgrade). The checkpoint it judges
  is `evidence(latest, prev)` (above).
- **The plan** (`plan`) reads the checkpoint, the declaration and the intents
  as they are now. A project comes back when the checkpoint saw it live and
  it still exists, is not archived, has no down mark, and its directory is
  there. Of its slots, only the ones live in the checkpoint, settled, and not
  stopped come back, and only when the declaration still says what the
  checkpoint saw. A different kind is `KindMismatch`: a window seen as a
  shell is never planned as an agent, nor the reverse. An agent whose
  backend or conversation id changed since is `ChangedSinceCheckpoint`. The
  plan never takes the declaration's identity over the observation's. An
  agent slot additionally needs its saved conversation
  id and a provable identity: a managed agent needs a managed home whose
  `launch.json` holds a command, and an adopted agent needs a CLI with an
  exact `resume_id`. Otherwise it is skipped, never relaunched from the bare
  backend line, a "most recent" resume or a blank prompt. Autostart projects
  the checkpoint did not see are added only on request, as shell windows
  only. Every skip carries its reason (`SkipReason`), so "why did X not come
  back" has an answer. Restore never reads `last_seen_at`; it stays the MRU
  sort key.

## After a host reboot: the executor (board #422, round 2)

`projects/restore_run.rs` brings a plan back, and `store/restore_batch.rs`
holds its progress. Tests are its only caller in this round; round 3 wires
`restore_run::run` into gateway start, together with the input barrier.

- **The gate holds for both paths.** Restore off, or a boot that cannot be
  read, does nothing before any write. An open batch is then neither
  continued nor closed; it is closed FAILED only when both boots are known
  and differ (review P1-D).
- **One owner.** `flock(LOCK_EX|LOCK_NB)` on `<state dir>/restore.lock`; the
  OS releases it when the owner dies. A run that cannot take it answers
  `Busy` and does nothing.
- **The batch.** `meta restore_batch:<socket>` holds the plan frozen whole:
  the full batch uuid, the boot, the socket, the source checkpoint, the
  server the first creation printed, and every project and window with its
  state. Every step writes the next state BEFORE the tmux call (`op` is the
  step issued). A successor continues from the batch alone: it never reads a
  newer checkpoint and never re-judges the reboot trigger. The closed batch
  moves to `restore_last:<socket>`. A boot that already has one is not
  restored again. A batch from another boot (a second reboot mid-restore) is
  closed FAILED and nothing is re-planned automatically.
- **Ownership is a fact on the tmux object.**
  - A session is made by ONE `new-session -e TMM_RESTORE_BATCH=<uuid> -n
    tmm-r-<uuid>-holder`, so it carries the batch from birth. A taken name
    fails, so creation is the claim. Only "duplicate session" means
    "exists".
  - A window is born as `tmm-r-<uuid>-<ord>` and then tagged
    `@tmm_rw=<uuid>:<ord>`; the session is tagged `@tmm_rs=<uuid>`. These
    are separate options, so a window format can never mistake the
    session's tag for its own.
  - A same-name session made by a person has no env, or another batch's:
    it is skipped untouched.
  - Placeholder and holder names are no agent's names, so no delivery can
    reach such a window.
  - Capture leaves an OPEN batch's projects unfolded, and publishes no
    checkpoint while one is open. It reads the open and last batches in ONE
    SQL statement (one WAL snapshot), decodes both from those bytes, and
    keeps the same bytes as the revision it compares AGAIN inside its
    commit's IMMEDIATE transaction; a separate read for the revision could
    pair an old scan with a new revision (review round 2, P1-A residual). If a
    restore opened, moved on or closed meanwhile (here or in another
    gateway on the same state.db), the tick commits nothing; the batch
    writer takes the same write lock. After the close, it excludes only the
    windows a batch OWNS and never restored: env and `@tmm_rs` carry the
    batch's full uuid, `@tmm_rw` names that batch and ord, the native id is
    the recorded one, and it is on the batch's server. That covers a
    `launch_unknown` start, a kill left in place, and the holder. Each is
    excluded by the `(window index, name)` of the listing that proved it
    ours, so a person's window of the same name next to it is still folded.
    That pair is not an identity across a renumber or a same-name
    replacement between the two listings; carrying the native id through
    the observation is open (review P2).
    A person's window named `tmm-r-…`, even in the exact placeholder
    format, is folded like any other: a name never proves ownership
    (review P1-A).
    An unreadable batch holds only the projects whose session carries a
    restore env; every other project folds as usual (validator P2).
- **Every write is checked in-server.** Each write to an owned object is ONE
  `if-shell -F -t <native id>`. Its condition holds the server's own
  `#{pid}`/`#{start_time}` and the full tags; `#{TMM_RESTORE_BATCH}` reads
  the session env, measured on tmux 3.6a. The true branch ends `; display -p
  OK` and the false branch is `display -p REFUSED`. Results are Applied,
  Refused or Unknown, and only REFUSED proves nothing ran. A server replaced
  between our read and the write refuses: its pid and start time differ, and
  its reused `@0`/`$0` lacks our tags. Every call names the batch socket
  with `-S`.
  - Every window write also binds the window's FROZEN identity: its native
    `@id` inside its project's native `$N`. The ord alone repeats across
    projects.
  - The launch is typed into the pane `%id` recorded at creation, and only
    while that window has exactly one pane (`#{window_panes}==1`). A window
    moved to another session, or split, refuses, and nothing is typed
    (review P1-B).
  - Every parsed tmux answer uses the `<TMM_SEP>` delimiter, never spaces:
    socket paths may contain them.
  - A window is created only while the server sees no window of the slot's
    name in the session (`#{W:…}` in the same condition). A person's window
    that appears between our read and the create makes the create refuse,
    and the slot is skipped as "window exists". A slot name the format
    grammar cannot hold literally (`#{},`) is not created.
  - **The launch is typed only into a shell whose prompt was seen** (the
    observable edge of `wait_for_shell_on`). A shell still starting on a
    busy host drops typed-ahead input, so a timeout never types (validator
    load finding, 2026-10-19). Instead the window stays Created with
    nothing typed ("shell not ready; not started"), and the next pass looks
    again. Manual `up` keeps its type-anyway behaviour.
- **Unknown is re-observed, never redone blind.**
  - A create (`new-session`, `new-window`) is never issued twice: an unseen
    result is looked up by its full uuid name or env, and adopted or failed.
  - A kill is never issued twice: present means left in place, reported.
  - A tag or a rename is redone only after re-observation shows the object
    is still ours.
  - `launch_issued` is written BEFORE the launch is typed. From then on the
    automatic path never retypes, kills or renames that window, and an
    unseen outcome is `launch_unknown`. Tenet 4: our death never ends a
    running agent.
- **The strict launch door.** `reconcile::slot_command_exact` launches an
  agent only with its exact conversation:
  - a managed agent needs `managed_state` Managed and its recipe, through
    `spawn::relaunch_line_exact` → `Backend::resume_exact`, which each
    backend builds with the same code as its `resume_command`. Codex returns
    a line only for the canonical `command codex …` shape; kiro only when
    its own store holds that conversation for that agent (v3:
    `v3_session_resumable`; v2: `<home>/sessions/cli/<id>.json` naming the
    id and the agent);
  - an adopted agent needs its CLI's `resume_id`.

Otherwise it is `Err`: the window we made is killed (nothing was typed)
and failed. Manual `up` keeps `resume_command`'s looser behaviour.

- **What counts as an exact id.** An id is one data argument: shell-quoted
  through the managed builder's own quoter, also for the adopted
  `resume_id` templates. It is non-empty, not an option, and has no control
  characters (`backends::shared::exact_id_ok`). Each backend also refuses
  its own recent selector: codex `--last`, dsh `recent` (review P1-E).
- **The holder is never killed to zero windows.** The kill's own in-server
  condition requires `#{session_windows} > 1`. When it refuses because the
  holder is the session's last window, the holder is renamed to the shell's
  name (one plain shell window) and the project is reported NOT restored.
  - Both steps are written ahead (`HolderKill` / `HolderRename`).
  - The holder is judged by every native fact: its id, its birth name, and
    the session's env and tag. One a person took over is left as it is,
    and the project closes.
  - A successor consumes an issued kill by re-observation: gone is done;
    present is left in place, and the report says so. The kill is never
    issued twice, and an unconfirmed step is never reported as cleaned up
    (review P1-C).
  - After an unseen session-tag install, a session that is present, ours by
    env and untagged is NOT foreign: the install is redone under the same
    bootstrap guard.
- **The reread.** Before each project and at each launch, the row,
  `archived`, `project_down`, the window's `slot_stopped` and the path are
  read again. A later act skips that project or window; the old plan is not
  permission to override it. The reread compares the FROZEN session and
  path: a project renamed or moved since the plan is refused, never
  launched half from its old place under its new identity. The ONE row it
  validated is what the recipe, the tmm identity and the staged script are
  built from; no later read of the row is used.

## Storage

`state.db` — SQLite, ours, at `$XDG_CONFIG_HOME/tmux-mobile/state.db`
(`TMM_STATE_DB` overrides it; that is how the tests stay off the real
database). Tables: `projects` and `slots`, with `PRAGMA user_version` as the
migration marker.

Two boundaries worth keeping:

- **A legacy `team.db` is not touched.** The retired Team bus's database
  (board #100) stays on disk unread; `projects::rooms::import_legacy` copied
  its `proj:*` rooms into state.db once (board #107).
- **Files hold what a human writes, SQLite holds what the machine observed.**
  Slot cwds are stored *relative* to the project path, so moving a workspace
  keeps the declaration valid. When P2 introduces real agent definitions they
  will live in files (git-trackable, able to carry `skills/` assets) and the DB
  will reference them by name — no second copy.

Desktop-only, like the team supervisor: the phone is a client of a desktop
server, so `rusqlite` is excluded from mobile builds entirely. The gate on
`mod projects` matches the dependency gate in `Cargo.toml` exactly, and
`handle_project_request` is the single place where mobile answers
method-not-found — the same contract the Team tab uses to hide itself.

## UI

`src/lib/projects/Projects.svelte` renders above the raw session list on the
Sessions page, and the two halves divide the world between them: **a tracked
session appears only in Projects, everything else only in the session list.**
Since every session becomes a project on its own, what remains in the session
list is the short-lived (younger than the settle window), team sessions, and
anything you deliberately removed from Projects. One session, one home.

A project row is name + live dot + path, with its **windows on their own row as
individual buttons**: a project is a set of windows and jumping into the one you
want is the whole point. While the session is live the buttons come from the live
panes — the source of truth for what you can actually open, including a window
that has not settled into the declaration yet — and each carries the running
agent's icon. While the project is down they come from the declaration instead
(dimmed, no targets yet) and tapping one brings the project up and lands you in
that window.

Tracking is automatic (see above), so there is no per-session Track control and
no separate "new session" form: the single `+` creates a project and brings it
up. The panes the Sessions page already polls are passed down as a prop, so the
window buttons cost no extra RPC.

Display logic that is worth testing (row ordering, which windows to show and
where each one points, path shortening) lives in `projects.ts` so `node --test`
can reach it without a DOM.

## Verification

- `cargo test --lib` — 25 project tests, including an end-to-end case against a
  real tmux server: adopt a two-window session, `down` it, `up` it, and assert
  both windows return with the right relative cwd; plus a second `up` that must
  change nothing, two sessions sharing one directory becoming two projects, and
  a v1→v2 migration that must keep its children.
- The pure rules (settle, removal, reorder, agent detection) are unit-tested
  without tmux.
- The UI flow was exercised in a real browser against a live server: track
  `demoproj` → the session dies on Close → Open rebuilds `editor` and `api` at
  their original directories.
- Resume was verified with a real agent, not a mock: a kiro conversation was
  told to remember the word PINEAPPLE, the session was tracked, killed and
  reopened, and the restored agent — in a brand-new pane — answered PINEAPPLE
  when asked what it had been told to remember. The slot held the same
  conversation id that `kiro-cli chat -l` listed for that directory.

## Known edges

- `autostart` is stored but nothing acts on it yet (decision 3: manual restore
  first). Board #422 records the reboot evidence and plans the restore (see
  "After a host reboot"); bringing sessions back is its later rounds.
- A window renamed by hand looks like "old window gone, new window appeared":
  the old slot leaves the declaration and the new one has to settle again.
- `up` restores windows, not panes: a split layout inside a window is not part
  of the declaration.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Restore evidence is a complete observation; a person's down and Stop outlive it (2026-10-18, #422)

The reboot restore acts on three kinds of fact, and they are kept apart. The
declaration and the person's intents are one kind. The checkpoint, a
complete observation, is the second. The restore batch, work in progress, is
the third (later round). The reviewer's design P1s and round-1 findings are
the reasons:

- A checkpoint is published only from a tick that saw the whole server: the
  same `(pid, start_time, socket)` before and after, and every live project's
  windows read. A failed tmux query is Unknown and advances nothing. Equal
  wall-clock seconds are not evidence, because `mark_seen` autocommits row by
  row and `mark_up` also writes `last_seen_at`.
- The checkpoint is committed in ONE transaction with the folds it describes,
  and the plan refuses a window whose declaration no longer matches it. A
  checkpoint committed before its folds, followed by a refused fold, left new
  evidence beside old slots. A plan that took the declaration's kind would
  then relaunch an old CLI in a window last seen as a shell (round-1 review
  P1-B).
- The down and Stop intents are written BEFORE the kill, and only an explicit
  start removes them. With "a later live observation revokes it", a down that
  committed while a capture was mid-observation would be resurrected after a
  reboot. A start clears only the version it read at its beginning, and only
  on a clean success, under ONE permit per top-level verb. Before that rule,
  an old up or restart that returned after a newer Stop deleted that Stop; a
  window created with a launch error counted as started; and a restart's
  nested respawn re-read the mark and cleared a Stop written after the
  restart began (round-1 review P1-A and its residual).
- A Sessions-page close resolves, marks and kills ONE native window. A
  lookup that failed used to kill anyway with no Stop, and a renumber could
  record A and kill B (review P1 on F3).
- Only a reboot triggers a restore: the boot id changed and the server
  instance is gone. With a wall-clock comparison, a person's kill of the last
  session while the gateway was stopped would restore against their act.
- A managed agent comes back only through its recipe with its exact id.
  The bare backend line runs the user-space config, whose hooks never fire
  (the 2026-08-18 "deaf agent").

Pinned by `t1_only_a_complete_observation_becomes_a_checkpoint`,
`checkpoint_windows_are_the_folded_slots_of_the_live_windows`,
`a_refused_fold_rolls_back_the_checkpoint_and_the_whole_tick`,
`an_empty_tick_keeps_the_last_evidence_of_a_server`,
`an_empty_latest_checkpoint_defers_to_the_kept_one_from_the_same_boot`,
`the_tmux_server_reads_as_present_absent_or_unknown` (a real private server
and a permission-denied socket), `t2_t3_a_down_suppresses_until_an_explicit_up_clears_it`,
`a_down_whose_kill_fails_stays_on_record`,
`intents_are_versioned_cleared_conditionally_and_scoped_exactly`,
`an_up_clears_only_the_intents_it_read_and_only_on_success` (the reconcile
is the barrier), `a_clean_start_clears_the_stop_it_found_and_a_later_stop_survives`
(the real hub Stop → Start path, then the nested respawn fallback as the
barrier: a newer Stop, or a first Stop, written during the launch survives;
a failed launch clears nothing; a resumed window whose CLI did not launch is
a restart error and keeps the mark),
`a_team_restart_that_drops_a_member_records_its_stop`,
`closing_a_window_marks_and_kills_the_same_native_window` (a renumber between
lookup and kill; an unreadable agents dir, a project that changed meanwhile,
and a window renamed before the kill refuse the close), `a_window_lookup_tmux_cannot_answer_kills_nothing`,
`managed_state_tells_unreadable_from_absent`,
`same_server_compares_the_whole_incarnation`,
`a_tick_disturbed_between_its_listings_publishes_no_checkpoint` (the capture
tick's own wiring on a real private server: a session that vanishes after the
listing, and a server replaced before the second listing),
`live_facts_read_the_recipe_and_the_resume_table`,
`stopping_a_managed_agent_kills_the_window_and_says_so` (a failed start keeps
the mark), `sessions_page_kills_record_the_persons_intent`,
`every_managed_launch_is_a_start_for_the_stop_intent`,
`the_plan_refuses_a_window_whose_declaration_disagrees_with_the_checkpoint`,
`t4_only_a_seen_live_existing_reachable_project_is_planned`,
`t5_only_live_unstopped_windows_with_a_provable_identity_are_planned`,
`t6_only_a_reboot_that_took_the_server_restores` and
`adopt_then_down_then_up_restores_the_workspace` (the real tick publishes;
down marks, up clears).

### The restore executor acts only on objects it can prove it made (2026-10-18, #422 round 2)

Ownership is on the tmux object, not in our memory. It is checked by the
server that performs each write, on that write's own native target. An
unseen result is re-observed and never redone blind: no second create, no
second kill, no retype after `launch_issued`. The reasons are the round-2
design reviews:
- a `session_created` bool written after the fact lost our own half-built
  session to a crash, and adopted the person's same-name session;
- a check in Rust followed by a write let a replaced server's reused `@0`
  receive our kill;
- killing an "uncertain" window could end a CLI that had already started.

Pinned on a real private tmux server by the `restore_run` tests:
`a_restore_brings_back_the_live_windows_once_with_their_exact_conversation`,
`t7_a_session_the_person_made_is_skipped_untouched`,
`t7_a_session_of_another_batch_is_not_ours`,
`t10_a_second_owner_is_busy_and_does_nothing`,
`t9_t17_an_owner_that_dies_is_continued_from_the_batch_alone` (a child
process aborts mid-batch), `b1_…` through `b5a_…`,
`b3b_a_server_replaced_before_a_write_refuses_it_in_server` (create, tag,
launch, rename, kill), `r1_…`, `r2_text_without_enter_is_launch_unknown_and_the_cli_never_started`,
`r3_bootstrap_guards_refuse_a_second_install_and_a_foreign_object`,
`the_guards_carry_the_batch_instance`,
`a_claim_issued_but_unseen_with_no_session_is_failed_not_retried`,
`t19_b6_the_door_and_the_reread_refuse_what_changed_after_the_plan`,
`the_strict_door_never_falls_back`,
`t11_capture_leaves_a_restoring_project_and_every_placeholder_alone` and
`a_second_reboot_mid_batch_closes_it_failed_and_plans_nothing`; plus
`resume_exact_carries_the_exact_id_or_refuses` (backends). Review round 2
added `capture_excludes_only_windows_a_batch_owns_never_by_name`,
`an_unreadable_batch_holds_only_restore_sessions`,
`a_project_renamed_or_moved_after_the_plan_is_refused`,
`a_window_moved_or_split_before_the_launch_gets_nothing_typed`,
`the_holder_kill_is_written_ahead_never_repeated_and_never_empties_a_session`,
`a_holder_that_became_the_last_window_is_renamed_not_killed`,
`an_open_batch_is_left_untouched_when_restore_is_off_or_the_boot_is_unknown`
and `a_lost_session_tag_install_is_completed_not_called_foreign`; then
`a_shell_that_prompts_late_is_never_typed_into_blind`,
`a_tick_that_scanned_under_another_batch_state_commits_nothing` (with a
second connection writing as the tick reads the batches),
`a_batch_opened_by_another_connection_after_a_scan_voids_its_commit`,
`a_scan_decodes_each_batch_from_the_bytes_it_compares`,
`a_launch_carries_the_identity_it_validated`,
`a_same_name_window_appearing_before_the_create_is_the_persons`,
`a_holder_a_person_took_over_is_left_and_the_project_closes`, and pins for the
validator's surviving controls (`only_the_exact_markers_classify_and_an_error_is_unknown`,
`the_production_guards_refuse_what_they_claim_to`, `o5_…`, `o7_u5_…`, `u8_…`,
`l6_…` (a Stop and, separately, a down written after the step's reread
are both refused AT the door), `u7_a_refused_window_tag_is_not_redone`,
`l10_…`, `c4_…`).

### A fresh pane is typed into only after its shell shows a prompt (2026-10-09, #325)

Every line typed into a pane tmm just created — `up`'s first-window `cd` and
slot command, a re-created slot window on agent restart, a spawn's
`. launch-<agent>.sh` — goes through `tmux::wait_for_shell(pane, SHELL_READY)`
first: poll every 50 ms until the cursor sits past column 0 on its row and the
screen and cursor are unchanged across two polls, bounded at 5 s, after which it
logs and types anyway (never a hang; a dead pane returns at once). Owner report
on clawdbjs (macOS, zsh 5.9 login shell + starship, project test): every agent
Restart came back as a bare prompt showing `. …/launch-kiro.sh%` — the restart
path (`create_or_keep` → `run_slot_command`) typed right after `new-window`,
the tty echoed the bytes, then zsh's line-editor init discarded the pending
input and drew its prompt mid-line. Spawn only worked because of a fixed 800 ms
sleep, which is a race and is gone. `tmux.rs`'s
`a_line_typed_into_a_fresh_pane_lands_only_after_the_prompt` runs a real shell
behind a 1 s init that flushes the tty input queue: typed at once the line is
lost; through the wait it runs.

TESTS that type into a pane go through the same wait, behind one helper per
test module (`scratch.rs`'s `typed`), never a bespoke readiness poll — a second
readiness mechanism is weaker than this one and drifts from it. Found by the
#337 validator: `the_shell_can_exit_without_ending_the_session_and_a_dead_pane_is_repaired`
typed `sleep 120` straight at a pane `ensure` had just respawned, and measured
at that instant the pane's cursor still sat at column 0 in 5 of 5 runs — #325's
precondition for a lost line, with no wait in front of it. It flaked only in the
full suite, where the host is loaded.

### Confirmed process and project actions settle before closing (2026-09-12, #167 batch 1)

Sessions and Projects own the confirmed target, synchronous busy state and a
modal-local error. Sessions previously swallowed kill RPC rejection, so its
confirmation closed as though successful; Projects cleared the pending target
before starting Close/Remove. Both now retain the same target on rejection and
show the error through ConfirmDialog's alert, with retry available. Busy Escape,
backdrop and repeated confirmation are consumed by the shared dialog.

Mutation success closes the confirmation before the list refresh. A refresh
failure uses the existing list error and must not turn a completed mutation
into a retryable kill/Close/Remove. The captured target and view generation gate
completion and cleanup; hiding/unmounting the view invalidates old callbacks,
including refresh results and tracking notifications. Window kill uses the same
session/pane refresh so its counts and pane list come from one response.

Caller glyphs name the action: session kill and project Close use `stop`, window
kill uses `x`, project removal uses `trash`. Session confirmation reuses the
existing Kill session/window labels, not the missing `del` key.
`Sessions.mount.test.ts` and `Projects.mount.test.ts` reproduce the rejection,
label and unmount failures with real client components and controlled promises;
they also cover successful mutation followed by failed refresh. Colocated source
contracts pin explicit glyph choice. These tests cover synthetic DOM events, not
layout or native Terminal Back, which remains owned by App.
Verified with Node 22.23.2, Svelte 5.55.5, Vite 6.4.2 and jsdom 30.0.1.
Negative controls reintroduced closing on kill rejection and clearing a project
target before its RPC; each failed its corresponding mount test and was restored
in place without checking out an uncommitted file.

### Terminal confirmation Back delegation (2026-09-12, #167)

The narrow addition approved by the lead at 17:33 gives Sessions and Projects
optional `onGoBack` registration callbacks. The host previously had no local
confirmation handler to consult before its Terminal navigation. Sessions consumes
its pending kill first, otherwise delegates to the nested Projects handler;
Projects consumes its pending Close/Remove. Both dismiss only when the mutation
is not busy and return `false` when no confirmation owns Back.

Each component registers a stable handler reading live local state; unmount or
registration replacement gives the old host a callback returning `false`.
No document/window listeners or separate history mechanism are added. App owns
native Back routing. The colocated client-mount tests exercise idle fallthrough,
cancel without mutation, busy consumption, failed-confirmation cancellation,
nested delegation and disposal. These are synthetic callback tests, not Android
device acceptance; the App wiring is verified separately by its owner.
Red-first tests failed on the absent registration. Removing either busy guard
or the nested delegation then failed its corresponding negative-control test;
each temporary change was restored in place without touching the staged snapshot.

### Projects declare, tmux projects

a project (`state.db`, `src-tauri/src/projects/`) is a directory + the windows it is made of; the tmux session is a disposable projection.

**Every session is a project**: `auto_adopt_once` on the capture tick adopts anything untracked (that is also the migration for pre-existing sessions), guarded by a 120 s session age and "archived is never re-adopted" (the `tmm-team-` prefix exclusion died with the Team system, board #100). There is ONE create path — the `+` calls `project_create` + `project_up`, and its agent presets seed an agent slot rather than a raw command, because a shell command is observed-only and never replayed. `up` matches windows BY NAME and only creates what is missing (the session may be the one you're typing in), `down` kills the session and keeps the declaration, and the capture loop folds live tmux back in — nobody hand-writes a project. One rule keeps it honest: a window must survive 120 s to become restorable, and an ordinary vanished window leaves the declaration; a managed agent's isolated home is durable membership, so Stop retains its absent slot/session id and only Remove ejects it. There is NO topology history — the declaration is the last observed state, which is what "restore what I had before closing/rebooting" means; a 20-deep snapshot list was removed as dead weight (its `restore` rewrote the declaration without projecting it, so a live project's next capture tick undid it).

**Identity is the SESSION, not the path** — several sessions parked in `$HOME` is normal, so `UNIQUE` sits on `session`; the workspace dir comes from `pick_workspace` over ALL windows (most frequent, `$HOME` only as a last resort), never from the focused pane. Migrations MUST `PRAGMA foreign_keys=OFF`: libsqlite3-sys defaults them ON, so a table rebuild's `DROP TABLE` cascades the children away. Only agent slots are relaunched: an observed `npm run dev` is recorded, never replayed. `projects/agents.rs` is ONE table for detection and relaunch so they cannot disagree (a pane's agent is the exact program name of its shallowest agent process — `detect_processes`, a deeper match is a subprocess); for MANAGED windows `detect_pane` reads the backend off the launch recipe FIRST, because the sniff lies for our own spawns — the npm codex runs as `node` with nothing saying "codex" anywhere, so a spawned codex fell out of delivery/roster/vitals/recovery until the record beat the sniff (measured 2026-08-22). And there is ONE way to ask about a pane — `agents::detect_pane(ws, &pane)`: the recipe, else the listing's process-derived `TmuxPane::agent` — because seven call sites used to assemble a detection haystack by hand and one did it differently (the capturer read `child_cmd` and not the window name; the roster, delivery, vitals and recovery read the window name and not `child_cmd`), so the declaration and the roster could disagree about whether the same window was an agent (2026-09-03 review). The client used to be the eighth: its own regex over command + title + child argv, which is how a stale title painted a shell as grok (board #260); it now reads `agent` off the pane.

**An agent resumes its conversation, not a blank prompt**: the notify hooks already carry `session_id`, the hub keeps the last one per tmux window, the capturer stamps it onto the slot (sticky — a quiet cycle must not erase it), and managed `up` prefers `--resume-id`/`--resume <id>`/`codex resume <id>`/`grok --resume <id>`. If the exact id has not reached `state.db` before the 20-second capture tick, the isolated-home fallback is `kiro-cli chat --resume` / `claude --continue` / `grok --continue` / `codex resume --last`; the Codex form is safe only here because CODEX_HOME is per-agent and `--last` is cwd-filtered, while the generic shared-home path still starts clean.

**A managed agent restarts with its FULL identity**: `spawn` persists a launch recipe (`launch.json` in the isolated home: env + identity command, kick stripped) and the restart path replays it (`spawn::relaunch_line`, used by `reconcile::slot_command_in`); `refresh_hooks` backfills the recipe for pre-recipe kiro agents. Without the recipe the restart ran the bare backend line — no KIRO_HOME, no `--agent` — i.e. the user-space config whose hooks NEVER fire, so a restarted agent kept answering but went observably deaf: no tool rows, no auto-post, every delivery "unconfirmed" (owner report 2026-08-18). A restart whose slot is absent/unsettled goes through spawn's explicit `resume` mode, so re-rendering current config does not turn Start into a new conversation. Desktop-only, `rusqlite` gate == `mod projects` gate; `team.db` stays the agora bus. See `docs/design-docs/features/projects.md`.

### A project is named by its NAME, never by its folder

`project_create` derives the session as `session ?? name ?? basename(path)` — the folder is the LAST resort, because falling straight to it produced a project called "src-tauri" and a session called "tmp" for `--name closetest` (two owner reports, one bug seen from both ends). The Hub's create dialog also REQUIRES a name.

**Renaming moves the tmux SESSION too** (`project_rename` / `tmm project rename`; the chat header's title is the control — a button that becomes an input in place), because the session name is what the Terminal and `tmux ls` show and a label-only rename left one project wearing two names (owner, 2026-08-19). Three things make that safe: the chat room is RECORDED on the project (`projects.room`, schema v8, backfilled `proj:<session>`) instead of derived from the session, so the conversation cannot be orphaned; `projects.prev_session` keeps the old name resolving in `project_for_session` and RESERVED from reuse by another project, because a running agent has `TMM_PROJECT` baked into its env and would otherwise go mute until restarted; and tmux is renamed FIRST, so a refusal leaves the declaration matching reality. There is NO adopted exception (the first cut had one and it disabled the feature on most real projects: `auto_adopt_once` adopts every untracked session, so `adopted` means "found before declared", not "a human named it"). Client-side `hubPrefs.renameSession` moves the per-session lead/read-marker keys, and a `project-renamed` event lets App `retarget` the live terminal + split cells, whose `<session>:<win>.<pane>` would otherwise be dead. The chat header then shows exactly one of `Open`/`Close` (`project_up`/`project_down`) depending on whether a live session exists; Close shares the agent-stop confirmation because it kills every pane. The path comes from `DirPicker` (`src/lib/files/DirPicker.svelte`) — the file browser's own `fs_list` RPC, directories only, read-only — so nobody types an absolute path from memory.

### Stop pauses, remove ejects; archive hides, delete forgets

`hub_agent_remove` / `projects::agent_remove` kills the window, DROPS THE SLOT so `up` cannot recreate it, and deletes the isolated home so `is_managed_in` stops recognising it — and it removes whatever of those three is still there, refusing only when NOTHING of the agent is left in the project: requiring a managed home made a STOPPED agent (slot, no window) and a home-less declaration unremovable, so `up` kept recreating a window nobody wanted (owner, 2026-08-19). The slot is membership, so the slot is what authorizes removal; the Hub's stopped card therefore carries the same dot menu (Start / Remove).

**And the roster ROW outlives its cards**: the `+ agent` button is the strip's STICKY last card — inside the family ("加agent应该放到最后，和其他agent放到一起…不用强行一直占一个位置", owner 2026-08-25; icon-only `+` while agents exist, labelled only in an empty roster) yet `position: sticky; right: 0` so it can never scroll invisible, which is the bug that first exiled it to a pinned slot (owner, 2026-08-21) — and the row renders for every SELECTED project — empty roster and CLOSED session included, and the empty-feed preset panel drops the same gate. Two gates hid the one entry point to an empty room, each in a different situation: gated on a non-empty roster it vanished with the last agent (the preset panel that would have covered it only renders in an EMPTY feed, so a room with history had no `+` at all), and gated on a live session a closed project still had none (owner, 2026-08-24, twice). A closed session was never a real constraint: `projects::spawn` calls `tmux::ensure_session` itself, so a spawn into a project that is down OPENS it (verified live — `hub_spawn` into a `○` project returned `{window_name, pane}` and the session appeared).

**That dot menu is a context menu**, a `position: fixed` layer placed from the trigger's rect (`menuPlacement` — right-aligned, flips above, clamps to the viewport; divide the rect by `--ui-zoom` because a client rect is visual px while a fixed child's `left` is zoomed px), never a popover INSIDE the horizontally-scrolling roster, which would clip it — that clipping is why it was a full-width bar until the owner asked for "类似右键菜单" (2026-08-19); it dismisses on outside pointerdown / Escape / roster scroll / resize.

**Every transient layer follows that rule** (owner, 2026-08-22: "在其他操作之后应该自动隐藏 不应该一直常驻显示"): the message action row (copy/raw under a tapped bubble) and the recipient picker close on outside pointerdown + Escape, copy closes its row after the "Copied" beat, and a tap outside the composer parks the `/` palette exactly like Escape (paletteOff, reset by the next text change). Raw view is deliberately NOT a popup — an opened raw source stays until retoggled. Modal dialogs keep their backdrop-click dismissal. `project_delete` / `projects::delete` closes the session first, then in ONE store section forgets the row (slots cascade) and stages `<path>/.tmm/agents/`, then removes the staged homes outside the lock — in that order. The homes belong to the DIRECTORY, not the row: while another project (archived included, it is still declared) names the same directory, delete forgets only its row, keeps every home and answers `agent_homes_kept_for: [{project, reason}]`, `reason` being `declared`, or `unresolved` when that project's path could not be resolved (board #415, 2026-10-17: the stale probe project `tmmprobe_colon` sat on this repository's own path, and deleting it would have removed builder's, validator's, orchestrator's, kiro's and deepseek's homes). `same_dir` compares canonical paths (a symlink alias, `..` and a relative spelling resolve), a path that does not exist compares as written, and any other resolution failure (permission, a symlink loop) is UNKNOWN, which keeps the homes. The decision and the claim are ONE store section: it reads the other declarations, forgets the row and, with no other owner, RENAMES `<path>/.tmm/agents` to `<path>/.tmm/agents.deleting-<id>-<ts>`; the recursive delete of that staging dir runs after the lock. Every declaration writer (create, adopt) takes the same lock, so a project declared before the section is counted as an owner and one declared after it finds no agents dir (review P1-B on 1be70ea0: a snapshot read before the removal let a concurrent create lose the homes it had just declared). The section first REREADS the target and requires the session and path it closed (review round 2, P1): a rename between the read and the section moved the session, so the close closed a name the project no longer has and its renamed session may be running. A changed or vanished target is refused with "nothing removed" (no row deleted, nothing staged). Failures say what they left and never overstate: a failed row delete stages nothing; a failed rename keeps the homes where they were (`agent_homes_error: "homes kept in …"`); a staged home that cannot be removed stays in the staging dir, named in `agent_homes_left_in` and `agent_homes_error`, and `agent_homes_removed` counts only what is really gone. The first round of #415 also dropped the `down` call by mistake (review P1-A); it is step one again. Pinned by `delete_keeps_the_homes_while_another_project_declares_the_directory`, `delete_closes_the_real_session_first_and_a_refused_close_deletes_nothing` (a real tmux session), `a_declaration_racing_a_delete_is_counted_or_finds_no_homes_to_lose` (observable, not timed: the decision seam asserts it runs inside a store section, a create on the same path announces itself before asking for the store, and the seam after the claim asserts the SAME section and that the create has not returned; a decision and claim split into two sections fails it every time, 10 of 10 in both split shapes), `a_project_renamed_or_gone_while_it_is_deleted_loses_nothing` (a real renamed session), `a_delete_that_cannot_finish_says_what_it_left_and_never_overstates` and `same_dir_compares_canonical_paths_and_a_failed_resolution_is_unknown` — and the close must SUCCEED first (2026-09-03 review): a session that survives with its homes deleted and its row gone is an untracked session full of windows nobody owns, which `auto_adopt_once` re-adopts as a new project within 120 s, so a delete that ignored `down`'s error resurrected what it was asked to forget. `agent_remove` follows the same rule for its window: a kill that fails is an error before the slot and home go, not a warning after. But in the chat UI it is reachable only through the RECYCLE BIN (owner, 2026-08-21, same two-step rule as messages): the header's Delete does `project_down` + `project_archive` and the project waits in a folded "回收站" section at the sidebar's bottom (hidden while empty), where restore is free and the confirmed `project_delete` is the only irreversible step; archived is never re-adopted, which keeps the bin stable. Both deliberately spare the user's files (we only delete inside `.tmm/agents/`) and the chat history (the room is the record, keyed by session name).

**CLI/UI parity is a rule, not a nice-to-have**: every one of these verbs exists as `tmm agent interrupt|stop|restart|remove` and `tmm project up|down|archive|unarchive|delete`, because an agent that can only be managed by a human cannot manage a teammate.

### Motion: a project that changes state moves, nothing swaps

[motion.md](motion.md) applied to `Projects.svelte`. `sortRows` ranks live projects first, so `up`/`down` changes a card's rank — the cards are keyed by id and carry `animate:flip={{ duration: moveMs() }}`, the most meaningful reorder in the app: the card you just closed travels down instead of the list repainting. A card `.appear`s when it mounts (a new project, or the section expanding — the expand itself is a cut, no slide). The section's caret is ONE `chevron-right` in `.chev` with `class:open={!collapsed}` (principle 4 — it turns, it is not swapped for a `chevron-down`). The live border, the dense hover/open wash and the state dot's colour cross-fade on `--t-fast` (a dot changes colour, never opacity); the declared-windows dim on `--t-move`. The error line fades in.

Hover / unfold / highlight (#86, 2026-09-04): a card's hover card (`use:hoverInfo` on `.proj-main`, principle 16) shows the path, the state (open/closed), the agents as "n live · n stopped" (declared agent slots against the live agent panes `chipsFor` already knows) and the age through `ageLabel` — the card's own helpers, never a second formatter; the path's native `title` is gone, the `aria-label` on the group stays. The cards unfold once: `firstFill` flips on the first answer with rows and puts `.reveal` on the section; later loads keep the keyed cards' nodes. There is no segmented control here, so no highlight travels.
