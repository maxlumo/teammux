# Agent Notifications

> **2026-09-01: the notification UI half of this system is RETIRED** (owner:
> "原来我用的感觉不是很好用"). The unread inbox (`unread.json`), the
> `agent_notifications_list`/`mark_read` RPCs, the `agent_notification` push and
> every attention dot (Terminal window chips, Sessions rows, PanePicker,
> Projects) are gone: the project room's auto-posted replies + read cursor and
> the derived status dots (hub) carry the signal now. What SURVIVES of this
> design is the event path itself — hooks → helper → inbox → `consume_file` —
> which feeds telemetry (status derivation), the stop-hook auto-post, and the
> per-window conversation-id memory that `up --resume` depends on.

## Purpose

Agent hooks turn structured lifecycle events from coding agents running inside
tmux into observed facts: telemetry for status derivation, the auto-posted
final reply, and the conversation id a restored window resumes with. The
supported backends are Claude Code, Codex CLI, Kiro CLI and Grok.
(Originally this fed per-window attention markers — retired, see above.)

Terminal output is not the source of truth. Prompts and completion text change
between versions, themes, models, and languages. Each backend's lifecycle hooks
are the authoritative input; tmux activity and bell flags remain unrelated,
low-confidence signals.

## Event Path

```text
agent lifecycle hook
  -> notification helper writes one atomic inbox file
  -> desktop server consumes the inbox
  -> telemetry (status derivation, tool/prompt rows)
  -> managed stop-hook auto-post into the project room
  -> per-window conversation-id memory (project resume)
```

(Until 2026-09-01 the consumer ALSO stored unread window state and pushed
`agent_notification` snapshots that Sessions/Terminal chips rendered as
attention markers — that half is retired; see the note above.)

The helper uses a filesystem inbox under the app's config directory rather
than a second HTTP listener. This avoids another exposed port and authentication
surface. It writes a temporary file and renames it into the inbox so the server
never reads a partial payload. The hook does not connect to the desktop server:
if the server is stopped, the event remains in the inbox and is consumed on the
next start. Notification delivery is advisory, so helper setup/write failures
are silently ignored and always return success to the Agent CLI. Hook payloads
are single-line JSON; helpers read one line rather than waiting for stdin EOF,
because some interactive CLIs keep the pipe open until the hook exits. Hook
commands invoke the helper through `/bin/sh` instead of executing it directly:
macOS may attach `com.apple.provenance` to app-generated scripts and kill direct
execution with status 137.

Inbox files are named `<unix secs>-<pid>.json`, or `<unix secs>-<seq, 20
digits>-<pid>.json` when the producer sets `TMM_HOOK_SEQ` (digits only). They
are consumed by ONE order (`inbox_order`) for a directory that mixes both
shapes: the second, then the sequence (none = 0), then the name — so an
unsequenced pair keeps exactly today's order (sorting by modification time
instead would have reordered every other backend's same-second pairs, and an
existing test pins the name order).
Only dsh's plugin and shell set a sequence (board #404: a prompt and the Stop
of a run interrupted at once land in one second); every other backend keeps
its old file name. A producer that numbers its envelopes also puts the number
in the payload (`tmm_seq`), and the hub keeps a per-window high-water mark: an
envelope not above it is dropped, so one published late (a notifier that
outlived its run) can never reopen a turn that already ended. The mark is
durable (`meta` key `hook_seq:<session>:<window>`, one per window, so one
window's number never fences another), and the in-memory copy never runs
ahead of it. A numbered envelope is ACCEPTED, and leaves the inbox, only once
its turn fact, its effects and its durable mark have all succeeded
(orchestrator ruling, #404 round 5):
- a mark that cannot be read, or holds something that is not a number, is
  unknown: the envelope is kept, never consumed past a guessed fence;
- a turn fact of the producer's own window whose INSERT failed
  (`telemetry::with_numbered`) stops the consumption BEFORE the room post,
  the flush and the mark, and changes no live turn state. A numbered
  prompt's row and the retirement of the delivery receipts it settles are
  ONE store transaction (`Store::settle_prompt`, round 6): both durable or
  neither, so a retry finds exactly the receipts it matched and never
  records them as local input. Retrying a known failure repeats no visible
  effect;
- the room row is an effect: `RoomPoster::post_final` returns whether the
  room recorded the reply (`rooms::post_routed`; nothing is typed when it
  did not). A refused post keeps the envelope and writes no mark; the next
  pass retries the end's tail alone (`finish_end`: the post, then the flush),
  never its end fact (round 6). A post that succeeded but reported an
  error is posted again: the at-least-once window below;
- a mark that cannot be written keeps the envelope; its effects are done, so
  later passes retry the mark alone;
- while a producer has an envelope not yet accepted, its later envelopes wait
  behind it (`Consume::Defer`), so the fence never passes it and it is never
  dropped as old. Other windows and unnumbered producers go on.

For such a numbered producer the helper's exit status is a receipt — 0 only once the
envelope is in the inbox, 1 when it is not — so it can keep and resend what
did not land; every other caller keeps the fail-soft exit 0.

**Consumption is at least once, for every backend** (board #404, orchestrator
rulings 2026-10-16 16:00 and 17:30). A file leaves the inbox only after its
consumption returned, so a gateway that dies in between reads it again on the
next start: the end row may be written twice and the reply posted to the room
twice. Only a crash (or a restart), or a room write that succeeded but
reported failure, repeats an effect. Unnumbered producers log a refused room
post and go on, as before. An unnumbered
producer's failed INSERT stays fail-soft telemetry (the file is consumed).
What is promised is that the reply reaches the ROOM at least once, NOT that it
reaches the requester's pane at least once: the reread recovers the reply
edge from the log (`recovered_targets`), which already holds the end written
before the crash, so the re-posted reply has no recipients (docs/todo.md).
Recovering who was waiting durably is a separate, possible follow-up.
Pinned by `dsh_consumption_is_at_least_once_and_never_guesses_a_fence` (a
crash after the end row, a crash after the reply, a failed end INSERT, an
unreadable mark), `a_numbered_window_waits_behind_its_unaccepted_envelope` (a
failed end INSERT under repeated polling with a held line, N+1 queued behind
N, a restart, a failed prompt INSERT keeping its receipt),
`a_failed_mark_write_keeps_its_envelope_across_a_restart` (a failed mark
write, a restart, then an old prompt), `a_room_post_that_failed_is_retried_alone`
(three refused posts, then one post, one end row, the flush after it),
`a_numbered_prompt_settles_its_receipts_with_its_row_or_not_at_all` (the
transaction as a restarted process would read it, mid-way and after a
failed INSERT), `a_reply_the_room_did_not_record_is_an_error_and_types_nothing` and
`a_numbered_envelope_is_accepted_by_its_own_windows_turn_facts_only`.

**The store stamps every activity row at its INSERT, on one clock with the
live record** (board #414). ONE rule, `Store::stamp_activity`: an observed
row's `ts` is `max(clock_ms, high-water + 1)`, taken inside the store's write
section — the one store lock is held across the stamp and its INSERT, the
settled-prompt and missed-end transactions included — so `ts` rises strictly
in INSERT order across EVERY writer: turn facts (prompt, ask, tool, end,
interrupt), the numbered prompt (`settle_prompt`), the missed end
(`insert_missed_end`), and the warn, steered and recovery rows. The
high-water is seeded from `MAX(ts)` when the store opens, so a restart, or a
wall clock that stepped back, never stamps a row behind one a client already
holds. No caller computes a ts: the store returns it (`publish_activity` →
`(ts, Result<id>)`, `settle_prompt` and `insert_missed_end` with their row), and the live record, the ring and the log all carry exactly that
value, so a restart that replays the row derives the state the window had.
A fact dated ON PURPOSE (a test's chosen time) is a separate, named path —
`record_notification_at`, `record_notification_with_at`,
`record_missed_end_at`, `Store::insert_dated_activity`,
`Store::insert_dated_missed_end` — never inferred from how old a time is, and
all of it `#[cfg(test)]`: no build that ships can date a row. A dated row is
outside the cursor contract and does not move this process's high-water (a
test's simulated timeline minutes ahead must not stamp every later observed
row there). A test must therefore not date one fact of a turn and let the
store stamp the next: with the high-water ahead of the wall clock (after a
restart over a log a faster clock wrote, or after a test that drove the
clock), the stamped prompt lands a second after the dated end, and the
replay reopens the turn (board #419:
`the_first_agent_read_after_a_restart_derives_from_the_log` dated its missed
end with the wall-clock second since #414's call-site rewrite, and failed
whenever an earlier test had left the high-water ahead; it now records every
fact observed, on a clock held ahead).

**A failed write keeps its stamp; no store at all degrades, never backwards**
(review P1, round 3). `publish_activity` returns the stamp with the INSERT's
outcome, so a row that could not be written leaves no id behind, and its
fail-soft live and ring update carries the time the store gave it. Before,
the failure fell back to the wall clock: with the high-water ahead of it
(after a restart or a clock step) a stop that failed to write was dated
before its turn's prompt, and the ended agent still read running. With no
store write at all — none could be opened, a mobile build, a unit test — the
event takes `max(wall clock, the session's newest KNOWN fact + 1)`, so a later
fact never sorts before one the process already holds. Known means the live
records as well as the in-memory feed (round 4): a restart replays the log
into the records and paints no feed, and the feed is a display cache, not the
authority. A record keeps whole seconds, so its second `S` counts as
`S * 1000` (`known_floor_ms`): a fact just above it takes the same second and
sorts after it by arrival, which is how the live state orders. Rounding up to
`(S + 1) * 1000` was tried and measured wrong: it put the degraded fact a
second past the store's high-water, so an end the store stamped right after it
sorted first (two recovery tests that mix a degraded prompt with a stamped
missed end read running). A NUMBERED producer is unchanged: a failed write changes no live state
and its envelope is retried (`numbered_write_failed`, board #404).

**The cursor contract.** The feed is ordered by `(ts, id)`
(`Store::activity_page`) and a client's tail is `since_ts` (exclusive). Because
an observed row's `ts` is strictly greater than every row inserted before it,
a tail from ANY cursor the feed handed out sees every observed row
successfully published after that row, exactly once. A write that failed has
no row, so it is in no tail; a stamp it used is a gap, never a duplicate.

Why: a row's ts used to be `ts * 1000 + now_ms() % 1000`, the seconds of a
time the caller captured glued to the milliseconds of now. When a second
boundary passed between the two reads the row was ~1 s in the past: a turn's
end could sort before the prompt that opened it (seen once in a full test run
as `[notif, prompt]`, in `dsh_consumption_is_at_least_once_and_never_guesses_a_fence`,
load-dependent), and a tail that had read the prompt skipped the end. The
inbox's own order was never at fault; the rows were stamped out of it. Two
caller-side fixes came first and are gone: a write-time stamp with the record
left on the caller's second (50 full runs caught the replay disagreeing once),
then one clock allocated by the caller from an in-process counter, with a
"this second or the one before" test for a dated fact. The review (P1-A, P1-B
on 3f0bb156) named what that still left: a real event delayed two seconds
(behind the turn-fact lock, a slow disk, a clock step) was taken as dated and
backdated again; warn and steered rows used the bare wall clock; the counter
was allocated before the INSERT, so a writer could take T, wait, and commit
after another's T+1 had moved a client's cursor; and it restarted at zero.
Stamping at the INSERT, in the store, closes all of them in one place. Pinned
by `every_activity_writer_is_stamped_in_insert_order_under_a_fixed_or_backwards_clock`
(prompt, ask, tool, warn, steered, end, missed end; a clock that stands still,
then steps back a minute; ts strictly by id; a tail from every cursor sees
every later row; the record's second is its row's),
`an_observed_end_held_behind_the_lock_lands_after_a_row_published_meanwhile`
(the end observed WAITING on the turn lock, `TURN_WAITING`, while a warn is
published; the clock then two seconds behind),
`a_writer_held_inside_the_write_section_keeps_the_next_one_behind_it` (a
writer held between its stamp and its INSERT, `Store::hold_next_publish`, while
a second is observed waiting for the store, `STORE_WAITING`),
`two_racing_writers_are_stamped_in_insert_order` (a stress check: 400 rows,
two threads, a frozen clock), `a_restart_never_stamps_below_the_durable_high_water`
(a real file closed and reopened, in this process, an hour behind its own
high-water), `a_failed_insert_keeps_its_stamp_so_a_later_end_is_never_undone`
(the high-water two seconds ahead, a trigger refusing the end's and the
interrupt's INSERT: both windows read idle, the ring is prompt then end, no
row, then a new prompt opens the next turn),
`with_no_store_write_a_later_fact_never_sorts_before_a_known_one` (a feed
that holds the newer fact), `with_no_store_write_a_later_fact_never_sorts_before_a_replayed_one`
(a prompt five seconds ahead recovered through the real replay with an EMPTY
feed; an end and an interrupt with no store write read idle, dated in the
recovered second or later), and the
restart (a real child process) and concurrency tests above. A numbered
producer's failed write keeps its envelope and changes no live state:
`a_numbered_window_waits_behind_its_unaccepted_envelope` (an end row and a
prompt row that cannot be written: retained, no live change, landed in order
once repaired).

The server side of the inbox (`AgentNotificationHub::run`) polls every 250 ms
and runs `consume_inbox` on tokio's blocking pool: the scan is synchronous end
to end (directory listing, file reads, tmux subprocesses, bus posts), and on a
runtime worker it stalled every RPC sharing that thread for the duration.

**An envelope is dropped only for what it IS, or for a server that provably ended
(board #425, 2026-10-19).** Incident: a validator's browser rig started a gateway
with a private `HOME` and a private tmux socket, but the shell still exported
`XDG_CONFIG_HOME`, which the config directory prefers over `HOME`; the gateway ran
on the REAL config dir, consumed eleven real hook envelopes from the real inbox in
22 seconds, and dropped every one as "ignored" because `tmux: error connecting to
<the rig's socket>` was filed under the same `Consume::Drop` as a malformed file.
Their turn facts and final replies never reached the room (and are not
recoverable). Three rules came out of it, each a typed answer rather than a list
of bad news:
* **What a failed tmux call proves** (`tmux::classify` → `Fact`): `Unavailable` (no
  socket, nothing listening, the server died under the command: "error connecting
  to", "no server running", "lost server", "server exited unexpectedly") and
  `Unknown` (tmux could not be run, EAGAIN; an answer we do not read) keep the
  envelope in the inbox, however long it takes: no deadline, no age, no deletion
  for waiting. The warn line says once per file that it is kept and why, and a pass
  that kept envelopes logs one summary line (count, oldest age), at most once a
  minute, never a room line. `Missing` (a server ANSWERED that the pane does not
  exist, which tmux 3.6a does as exit 0 with empty fields) and `Invalid` (a
  malformed envelope or pane id, anything not tmux's) drop once, naming the reason.
  A failed spawn or an unreadable reply is never "invalid".
* **Whose pane is this, and does it exist there?** A pane id means something only
  to the server INCARNATION that issued it: a new server reuses the socket path, the
  pid and `%0`. The notify helper therefore writes `tmm_tmux` into every envelope: the
  producing server's `socket,pid,start_time` (`$TMUX` gives the first two; the start
  time is asked once from inside the pane with `tmux -S <socket> display -p
  '#{start_time}'`; plain path characters and digits only, any failure leaves the field
  out). **That probe is bounded**: it runs in the background with a one-second budget,
  is killed with KILL when it overruns (TERM can be ignored) and reaped, and then the
  envelope is published WITHOUT the field, as an identity-less one. Its number counts only
  when the probe EXITED 0: a number printed before a failure, a signal or the KILL is a
  partial answer, and a wrong start time would make the consumer drop a real envelope as
  an older server's. The helper's cleanup trap is armed only after the probe phase,
  because bash lets a subshell killed with TERM (the watchdog) run the EXIT trap it
  inherited, which deleted the probe file or the envelope's temp file from under the
  helper (observed under load, an envelope silently lost about one run in thirty); the atomic publish
  never waits on tmux, and no coreutils `timeout` is assumed. The same helper change
  writes `launch`, the window incarnation's `TMM_LAUNCH`, top level beside `backend`
  and `pane_id` (never inside `payload`), only when it is exactly a 36-character
  `[0-9a-f-]` uuid and left out otherwise, so nothing needs escaping; both fields are
  `Option` with `serde(default)`, an old envelope parses. Right after the pane is
  checked, `restore_hold::attribute(pane, launch)` decides whose envelope it is (board
  #422 round 3, projects.md): an envelope that CARRIES a launch is attributed only by
  the live hold row of that launch on this pane — the logical slot's while it blocks
  (`Slot`: `resolved` names the slot), routed as usual once released (`Own`) — and is
  DROPPED when there is none, never taken as legacy normal (a restore-launched CLI's
  envelope checked before an ordinary restart retired its row writes nothing for the
  new CLI). An envelope with no launch from a pane with a live hold is dropped; from a
  pane with none it is normal. A hold or pane that cannot be read is `Unknown`, and
  the envelope is KEPT and tried again (H2 review P1-C). Attribution only routes:
  `Slot` and `Own` envelopes are consumed under `telemetry::with_generation`, which
  writes every turn fact of that window (prompt, end, ask, tool) ONLY while the hold
  still carries the launch, in the same transaction as the row, and records the row as
  the hold's first accepted fact there too (`Store::publish_activity_in`,
  `settle_prompt_in`; a prompt also marks the release pending). A fact its generation
  refused has no effect at all: no row, no live state, no feed line, no reply post, no
  command row stepped, no recovery budget refilled; it is dropped. Any other failed
  fenced write keeps the envelope. An attributed prompt then calls
  `restore_hold::on_prompt`; a release it cannot complete is completed by the capture
  tick from the pending mark its row committed. A `SessionStart` (subscribed by claude
  and kimi for this) is never a turn fact: attributed, it goes to
  `restore_hold::on_session_start`; a release that cannot be verified or written now
  keeps it for a retry; otherwise it is ignored.
  **The consumer asks ONE question per envelope** (`tmux::resolve_pane_checked`): one
  tmux response returns the answering server's incarnation (`socket,pid,start_time`)
  AND the pane's native id, session, window and index, and the envelope's expected
  instance and pane are compared in that same response. The verified pane then flows
  through the numbered mark, the turn fact and the reply edge: nothing inside resolves
  `%N` a second time, so a server replaced between a check and its use cannot have
  one's answer attributed to the other, and a positive answer never authorises the next
  envelope (only a NEGATIVE one, "tmux cannot be asked", is remembered for the pass, so
  the pass does not spawn a doomed query per file). The comparison goes through the one
  definition (`tmux::Incarnation`, also what `WindowIdentity::same_server` compares,
  board #422): the same triple is consumed; the same socket with another pid OR another
  start time is a server that is gone, so the envelope is **dropped**, naming both;
  ANOTHER socket is another gateway's envelope (the stray gateway that reads this inbox
  while connected elsewhere): **left untouched** in the inbox, not delivered, not
  dropped, and it does not fence this server's own panes. Only after the instance
  matches is "no such pane" a verdict, and only about THAT instance: an empty or
  different `pane_id` in the response is `Missing` for the checked server, never taken
  from another server's empty fields. An envelope with no identity (an older helper's,
  or a probe that expired) is a **compatibility downgrade, not a proof of the same
  incarnation**: it is consumed as before only when its file time is readable and not
  before this server started; older than the server it is left untouched (it cannot be
  this server's); an unreadable file time is Unknown and kept. Time only ever keeps
  here, never delivers on its own, never deletes. A server that cannot be asked keeps
  every envelope. Consequence recorded for #422: a Stop written just before a host
  reboot is `Missing` after the restore (a new server), and its final reply is not
  recorded in the room, unless the restore records the room line from the envelope alone.
* **Order is kept while one is kept.** The fence of a numbered producer (#404) also
  holds for an unavailable tmux, and now for UN-numbered producers too (kiro, claude,
  codex …): a prompt kept for a flicker is not overtaken by its END in the same
  pass. It is per pane, and an envelope left for another server does not count.
At-least-once is unchanged: a tmux failure that interrupts a consumption after a
visible effect can repeat that effect on the retry, like a crash between an effect
and the file's removal. The helper now costs one `tmux display` per hook.
Pinned by `an_envelope_for_an_unreachable_server_is_kept_and_delivered_when_that_server_is_back`
(the same private server unreachable, a day on, then back: delivered, the malformed
one dropped once), `an_envelope_from_another_incarnation_of_the_server_is_dropped_never_delivered`
(a new server on the same socket reusing `%0`, including a file younger than any
probe, and the same pid with another start time),
`an_unnumbered_envelope_is_checked_alone_when_the_server_is_replaced_between_envelopes`
and `a_numbered_envelope_is_checked_alone_when_the_server_is_replaced_between_envelopes`
(the server is replaced right after the first envelope's check, `%0` reused: the first lands
in its own server's pane, the old envelope after the replacement does not land in the new
pane, the new server's own envelope is not deleted by a cached old identity),
`a_hung_tmux_does_not_hold_the_helper_and_leaves_no_probe_behind` (a fake tmux that hangs
and ignores TERM, with or without a number printed first: the helper exits within budget, the
envelope is published without the field, no probe process is left),
`the_probe_identity_is_used_only_when_tmux_exits_cleanly` (a number then exit 1 or a signal:
no identity; a clean answer is carried), `an_empty_payload_publishes_nothing_and_leaves_no_temp_file`, `an_unreadable_answer_for_one_pane_does_not_keep_another_panes_envelope` (only a connection error is remembered for the pass), the legacy test's pre-1970 file time (an unreadable time is kept through `consume_inbox`), `the_helpers_cleanup_trap_is_armed_after_its_background_jobs_are_gone`
(the order in the generated script: the race is an instant after the watchdog's fork, which no fixture can hit on demand), `an_identityless_envelope_is_judged_by_a_readable_file_time_or_kept`, `another_servers_envelope_is_left_untouched_and_does_not_fence_ours`,
`an_envelope_without_an_identity_is_delivered_only_when_younger_than_the_server_and_never_deleted`,
`numbered_envelopes_wait_for_an_unreachable_tmux_in_order`,
`an_unreachable_first_envelope_fences_its_producers_second_in_the_same_pass`,
`an_unreachable_prompt_fences_its_ends_for_an_unnumbered_producer`,
`a_tmux_failure_is_classified_by_what_it_proves`, `a_server_identity_is_plain_path_characters_and_digits_or_nothing`
and `the_helper_records_the_producing_server_and_leaves_it_out_when_it_cannot`.
The process half of the incident is in
[testing.md](../../conventions/testing.md#a-rig-owns-its-whole-environment-not-just-home-board-425).

## Backend Mapping

- Claude Code: `Notification` maps permission/input/completion notification
  types precisely; `Stop` provides a completion fallback.
- Codex CLI: `PermissionRequest` maps to permission-required and `Stop` maps to
  completed. A payload carrying `agent_id` comes from a sub-agent thread and
  is the agent's own work (board #169): its `UserPromptSubmit` is a `Subagent`
  tool row, its `SubagentStop` is not a turn end — see agent-status.md.
- Kiro CLI: `stop` maps to completed. Current Kiro hooks do not expose a
  permission-wait event with the same precision as Claude or Codex.
- Grok 1.0.5 (camelCase `hookEventName`; `stop` counts only with reason
  `end_turn`, `stop_failure` is failed) and OMP (our own telemetry extension
  emits claude-shaped `Stop`) are read the same way.

**kiro payload shapes by engine (kiro-cli 2.22.1, board #207, measured):** v2
`Stop` carries `assistant_response`/`last_assistant_message`; v3 `Stop` is
`{session_id: "sess_<uuid>", hook_event_name: "Stop", cwd}` with no text (the
reply is read from the session file — the agent's ISOLATED home first, see
below, agents-overview.md); `UserPromptSubmit`
carries `prompt` + `session_id` on both; v3 never delivers `preToolUse`/
`postToolUse`. The managed profile's hooks are the 3.0 ARRAY shape
(`{name, trigger, action:{type:"command", command}, timeout}`), accepted by
both engines.

**Where that session file is read from, in order** (board #376, 2026-10-15,
kiro-cli 2.28): `<home>/sessions` — the `KIRO_HOME` the managed agent runs
with — and only then the global `~/.kiro/sessions`, as the legacy source for
a window spawned before homes were isolated or one we have no home for.
`kiro::reply_fallback` is handed that home (`Backend::reply_fallback(payload,
home)`) and used to drop it, reading the global store alone. The incident:
owner, 01:35, on laminar-log — "为啥 agent 返回的结果界面上都看不到". The room
held ZERO replies from four kiro agents (editor/researcher/writer/critic)
while their panes finished turns normally, because a STALE copy of the live
session id survived in `~/.kiro/sessions/…` from before that agent's home was
isolated (mtime 00:03 against the live file's 01:39, 414 assistant rows).
Every Stop found the stale file first and returned the same old sentence, so
nothing new was recorded: no room line, and no reply edge either — every
`@editor` request from the owner was a dead end for the team too. ORDER was
the defect, not existence; both files were there and the wrong one answered.
Deleting the stale copy would not have helped before the fix, since the
fallback never looked in the isolated home at all.

The order needs THREE answers, not one (review P1, 02:02 and 02:08): whether a root
HOLDS the session — its own directory under some cwd bucket — and whether
that session has a reply for the latest turn. `session_lookup` answers them, and only
"this root does not hold it" may send the caller to another root. "It is here and says nothing" is an ANSWER: a turn whose
newest assistant row is kiro's `"..."` placeholder has no reply by the #213
rule, and falling through on it would hand back a stale copy's old sentence
as THIS turn's reply — posting it to the room and spending the turn's reply
edge on it, which is a worse failure than the silence we started from. A
session directory with no readable `messages.jsonl` (a turn that has only
just started) answers the same way. The third answer is `Unreadable`: a
sessions root that is not a directory, a permission or I/O error, a bucket we
could not enumerate. We could not TELL whether the live session is there, and
"I could not ask" is not "there is nobody" — so it reads nothing rather than
reaching for a copy that may be another conversation's. The reply is then
missing, which someone can see; a confident wrong reply is what we were
fixing. `session_lookup` returns those three (`Missing`, `Found(Option)`,
`Unreadable`) and `session_reply` is the flattening wrapper for callers that
only want the text. The legacy root resolves
through one function (`legacy_sessions_root`) whose `cfg(test)` form is a
per-process temp dir, so no test reads the developer's own `~/.kiro` (the
#216 rule: the isolation door belongs where the path is resolved).

**Where each dialect lives (board #129, 2026-09-09):** every backend's payload
reading — `normalize_kind`, `is_user_prompt_submit`, claude's `is_idle_nudge`
— is a function on that backend's file in `src-tauri/src/backends/`, next to
the hook it installs (one hook contract, one file). `normalize` here is only
the shell: `Backend::parse` at the door, then the backend's own reader; an
unknown backend is rejected exactly as before. `backends/` is an ungated leaf
module because this consumer compiles for the phone too — the measured payload
tests in this file pin every dialect and did not change.

(Historical: the unread inbox collapsed duplicate completion events from one
turn by backend session, pane, event kind and a short time window. Telemetry
deliberately takes every observed fact instead — dedupe was a UI concern.)

## Tmux Identity

Hook processes inherit `TMUX_PANE` from the agent process. The helper records
that stable pane id (for example `%18`). The server resolves it through tmux to
the current `session:window.pane` target; telemetry keys its facts by
`session:window`, the unit agents are managed at.

Events without `TMUX_PANE`, or whose pane no longer exists when consumed, are
discarded: guessing from cwd or process names can associate attention with the
wrong session. This also makes globally installed hooks inert when an Agent is
running outside tmux.

## Unread Model (RETIRED 2026-09-01)

This section is history, kept because it explains what the retirement removed.
The desktop server persisted per-window unread state (`unread.json`) with
normal/urgent/error marker kinds; opening a window called
`agent_notifications_mark_read`, the server broadcast the snapshot, and
Terminal chrome filtered `tmm-team-*` dots. All of it is gone: the RPCs answer
METHOD_NOT_FOUND (a boundary test pins it), a legacy `unread.json` is removed
at server start (regression-tested), and the event kinds live on only inside
telemetry's status derivation. The project room and the derived status dots
are the one notification language.

## Hook Management

Managed agents receive the hooks in their generated private backend
configuration automatically (spawn and `refresh_hooks` render them into the
isolated home; `helper_command` names the one generated helper). They never
depended on the user's global hook installation — and the global install
surface itself retired 2026-09-20 (board #222, owner: "这个页面里的agenthooks
是不是多余了，是历史冗余 我们都删掉吧"): the Settings → Connection install/
status/remove row, the `agent_hooks_*` RPCs and the user-space installers are
deleted whole. Hooks a user installed globally before the retirement keep
firing — the helper and the inbox consumer remain — they are simply no longer
managed from the app.

The generated helper and inbox are private to the local user's config directory.
Payloads are bounded and notification summaries are truncated before
