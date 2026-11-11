# Asks — an agent's question to the person, open until one explicit act closes it

Board #106 (ticket 1a of `docs/exec-plans/board-dashboard.md` § 9; the owner's
request of 2026-11-11 05:23 and his approval at 07:22). The design's § 3 is
the source; this doc holds what the code does and why.

Owner: "现在还是agent信息量太大了，人处理不过来，或者错过重要信息." A question
to the person was a chat line: twenty later lines buried it, so the asker
repeated it (the Fable 5.2 question went out four times in 20 hours). An ask
is the one thing the stream cannot hold: a question that is **open**.

## Shape

- **One message, one companion row.** The ask is ONE `hub_msgs` row (kind
  `ask`, to `["human"]`), so the room, `tmm log`, search and every older
  client see it. Its body is composed from the structure by ONE function,
  `projects::asks::compose_ask_body`: `@human [ask] <question>`, then a
  `KEY · label` line per option (`(recommended)` on one), then `(#N)`. The
  `hub_asks` row (schema v39) holds only the structure and the state:
  asker, asker home id, question, options, recommendation, issue, state,
  the closing message's seq and time, the chosen key, the delivery outcome,
  and `said`, the closing act in its own words without the quote of the ask
  (`B · beta — keep 24px`, `dismissed: …`, `withdrawn: why — citing …`).
  `tmm ask list --all` prints `said` whole: an excerpt of the closing body
  spent itself on the quote of a long question and hid the answer, in the
  very list a stopped asker reads (validator F3).
  The question is in the row too, as structure, so a client never parses
  the body (leader, G4).
- **The id is the message's seq.** `tmm ask` prints it; `tmm log` shows it.
- **Four states, three terminal**: `open`, then exactly one of `answered`
  (the person: an option and/or text), `dismissed` (the person: "I will not
  answer this"), `withdrawn` (the asker, saying why, optionally citing a
  room message).

## Rules and their reasons

### One transaction closes it, and only the first commit (the #92/#95/#98/#100 lesson)

`Store::ask_close` runs under `BEGIN IMMEDIATE`: read the row; if it is not
`open`, return it (`applied: false`) and write nothing; else INSERT the
closing message under the DERIVED id `ask:<seq>:close` and UPDATE the state
`WHERE seq = ? AND state = 'open'`, which must change one row. Both or
neither. Every close of one ask shares the id, so `hub_msgs.id UNIQUE` is a
second guard: two closing messages of one ask cannot exist. An open ask
whose closing id is taken is a broken record and an error, not a race.

So: two clients answering at once — one applies, the other reads the
winner's answer back and sends nothing; an answer racing a withdrawal —
first commit wins; a lost reply retried — the same row back, nothing written
or typed again. No read-then-write in the caller decides anything. Pinned by
`two_connections_closing_one_ask_one_wins` (two connections, and two threads
on two connections), `a_closed_ask_refuses_every_close_and_shows_the_winner`,
`an_open_ask_with_a_taken_closing_id_is_an_error_and_changes_nothing`.

A refused close is an ANSWER (`{applied: false, refused: "already answered
at HH:MM", ask}`), not an error: the client repaints from the winner's row,
and a retry of the winner's own call reads its own answer. `tmm ask close`
exits non-zero on it, saying nothing was written.

### Nothing is typed before the commit; after it, the composer's one path

The person's answer or dismissal is a message to the asker:
`@<asker> [re <asker> HH:MM: 「…」] KEY · label — text`, the quote being the
ask's, as `--re` would make it. It is pushed to the clients and handed to
`hub_rpc::deliver_to` (the composer's path) only after `ask_close` committed,
and only for an applied close. Pinned by
`the_line_is_handed_to_delivery_only_after_the_commit_and_only_once` (the
injected delivery sees the ask already closed and the line stored).

The line goes to the asker ALONE (`hub_rpc::deliver_to`, the composer's path
with its recipient given instead of read from the body). An `@other` or
`@all` in an option label or the person's comment is text: before round 1
`deliver_mentions` re-read the body and typed the answer into a second
agent's pane (validator F2, measured in the rig). Pinned by
`an_answer_naming_another_agent_reaches_only_the_asker`, red with the old
routing.

What that path did is recorded in `hub_asks.delivery`, beside the decision,
never merged into it:

| asker at that moment | delivery | what happens |
|---|---|---|
| live pane | `found` | typed once, quoting the ask |
| CLI exited to the shell | `found` | held and typed once at the restart (#77) |
| stopped | `stopped` | nothing typed, nothing queued: hub-composer.md's no-second-queue rule. The asker reads `tmm ask list --all` after a restart (its prompt says so) |
| removed, or a same-name replacement | `gone` | recorded only |
| tmux or the home could not be asked | `unchecked` / `unknown` | nothing typed |

Pinned with real tmux and the fake codex of #77: `a_live_asker_…`,
`an_answer_to_an_asker_whose_cli_exited_…`, `an_answer_to_a_stopped_asker_…`,
`a_same_name_replacement_is_not_the_asker`.

### The asker is a lifetime, not a name (G1)

An agent removed and created again under the same name is somebody else and
never receives the old ask's answer. No lifetime identity of a managed home
existed, so one is added: `<home>/home-id`, a uuid published the first time
it is asked for (`projects::asks::home_id_at`). It is written to a private
`home-id.<uuid>.tmp` and then linked into place with a link that never
replaces, so no reader can see it partial: the first version created the file
empty and filled it after, and two of eight barrier-released first readers
saw it empty in 139 rounds (validator F4). The loser of the link reads the
winner's id; a writer killed between the two steps leaves only its temp file,
which is never read as an id and is removed by the next writer once a minute
old; an empty `home-id` (not one we published) is an error, never replaced.
Pinned by `a_home_s_id_is_published_whole_once_and_a_new_home_has_another`
(200 rounds of eight barrier-released readers; red at round 0 with the old
create-then-write) and `a_leftover_temp_file_is_ignored_and_an_old_one_cleaned_up`. The one definition is `projects::asks::home_id(session, window)`,
beside `managed::managed_home`. A restart and a config refresh keep the
directory and so the id; a removal deletes it; a fork gets a fresh home
(`spawn::fork` never copies one), so a new id. Pinned in the fork test
`a_fork_of_a_solo_agent_launches_its_def_in_a_fresh_home`. Inode numbers are
not used: they are reused after a delete.

### A name is resolved once, at the door (reviewer R2, round 3)

`hub_ask` and `hub_ask_withdraw` resolve the typed `from` through the ONE
`address::Names` (`projects::names::resolve`) before the home and lifetime
checks, as every live-agent door does (agents-overview.md § physical name and
label): the physical name, the current label and a previous label all reach
the agent. The row and the wire keep the physical name. `hub_ask_list`
carries the project's `labels`, and `tmm ask list` shows each asker by its
current label, as `tmm board list` shows an assignee. Pinned by
`the_ask_doors_resolve_labels_and_the_list_carries_them` (asked under the
current label, then a previous one, then the physical name; withdrawn under
each; another agent's label refused), red with the resolution removed.

### A held answer and a removed asker (#116)

The home id is checked where #106 hands the line over, and the delivery
carries it on (`Deliver`'s `home`; `deliver_to`'s `Recipient { name, home }` carries it): the one
delivery path types a line only into the lifetime it was meant for
(hub-composer.md § A line is typed only into the lifetime it was meant for,
#116). Its write step observes the pane with its server and process,
compares the window's home id with the asker's, then types to that pane only
under the native guard of that observation (#117: a pane id is unique only
within one tmux server), so an asker removed and created again between this
check and the keys, even on a new server, gets nothing. An answer HELD
for a busy or exited asker keeps the asker's home id in its row
(`deliveries.home`), and its flush is checked the same way; a remove drops
the asker's held answer in its own call (`undelivered (the agent was
removed)`). Pinned by `a_held_answer_never_reaches_a_same_name_replacement`
(the asker's home replaced while its answer is held: nothing typed, the row
retired; removing the asker drops a held answer), red with the check off.
#106 and #116 merge and deploy together, so no build carries `tmm ask`
without that boundary (leader, note 61).

### The doors are as strong as today's, and no stronger (G3)

On the gateway socket a same-uid caller can call any RPC and names its own
`from` (a courtesy flag, as `hub_post` says). So an ask's answer is exactly as
authentic as any message recorded as the person's; no authentication is
claimed. What the doors do enforce:

- `hub_ask` refuses a `from` that is not a managed home of the project, and
  records that home's id.
- `hub_ask_answer` and `hub_ask_dismiss` read no sender: they always record
  `human`. `tmm` has no answer verb.
- `hub_ask_withdraw` requires the asker's name AND its current home id to be
  the ask's. A cited `--re` message must be one of THIS room (leader, note 4).
- Every supplied field has its one type, or the call is -32602 with nothing
  written (`server/hub_rpc/asks.rs` `opt_str`, `opt_number`, `options_of`):
  `options` an array of exactly `{key, label}` strings, `recommend`, `question`,
  `from`, `why`, `option`, `text` strings, `issue` and `seq` integers, `re` a
  seq or an id, `all` a boolean. Absent and null mean "not given"; nothing of
  another type is defaulted away (validator F1: `options` as an object, a
  numeric `recommend` and `re: true` used to be stored as no options, no
  recommendation and no citation). Pinned by
  `a_wrong_typed_field_is_refused_and_nothing_is_stored`. The types are
  checked BEFORE the ask's state is read, so a malformed field on a closed ask
  is still -32602; only a well-formed call reaches the state, where a retry
  reads the winner (round 2, validator note 44: `option: 1` on an answered ask
  came back "already answered").
- Validation runs once, at the door (`projects::asks::validate`): a question
  of 1-4000 characters; at most six options; keys of 1-8 ASCII letters or
  digits, unique ignoring case; labels of 1-200; the recommendation one of the
  keys; the issue on this project's board. A refusal is -32602 with nothing
  stored.

### An approval is never inferred

A "可以" typed in the chat names no ask (on 11-10 it could have meant either
of two 48 px questions). Only the person's own act on the ask answers it. An
asker that reads a chat line as its answer can only withdraw, citing it:
`[re …] withdrawn: answered in chat — citing [re human HH:MM: 「可以」]`. The
record then holds the agent's reading with the person's words beside it.

### Asks follow the room

The row hangs off its message (`REFERENCES hub_msgs(seq) ON DELETE CASCADE`,
with the store's foreign keys ON after `init`, asserted in the test). A
project rename keeps its recorded room; an archive keeps it; a delete keeps
the room (projects.md) and so its asks, whose asker's home is gone. Pinned in
`asks_follow_the_room_through_a_rename_and_an_archive` and
`a_purged_ask_message_takes_its_row`.

### The capability is `asks`, not `dashboard` (G2)

The login answer's `asks` says the `hub_ask*` methods exist. `tmm ask` refuses
an older server before sending: a question sent there as a plain message
could never be closed. The dashboard's read (#108) brings its own
`dashboard` cap, so a client that sees `asks` never expects `hub_dashboard`.

### Teaching

The shipped prompt block gains one bullet (a question only the person can
answer goes through `tmm ask`, one question with options and a
recommendation; never repeat an open ask; after a restart read
`tmm ask list --all`), and the tmm-cli skill a section. Existing homes get
the prompt at their next launch, as every prompt change.

## Not here

The chat bubble and the bell (#107), the dashboard's read and view (#108,
#109). No cap on asks (a cap loses questions), no reminders (the stream
again).
