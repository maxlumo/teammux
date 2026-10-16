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

The helper uses a filesystem inbox under tmux-mobile's config directory rather
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

The server side of the inbox (`AgentNotificationHub::run`) polls every 250 ms
and runs `consume_inbox` on tokio's blocking pool: the scan is synchronous end
to end (directory listing, file reads, tmux subprocesses, bus posts), and on a
runtime worker it stalled every RPC sharing that thread for the duration.

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
