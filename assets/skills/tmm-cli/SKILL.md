---
name: tmm-cli
description: The full tmm CLI reference — project chat, the task board, agent/project self-management, the central registry, and tmm task for work that must outlive the turn (dev servers, watchers, deploys, remote jobs — NOT ordinary commands, which run in the foreground). Use when you need a tmm capability beyond the basics your system prompt teaches (send/log), e.g. spawning a teammate, restarting a stuck agent, sending a teammate a /command, waking yourself or someone later instead of sleeping, managing projects and registry definitions, or keeping a long-running process alive in the background.
---

# The tmm CLI

`tmm` is how an agent talks to the tmux-mobile project hub and manages its
own workspace. It is fail-soft by design: if the server is unreachable it
exits 2 in ~20ms and NEVER blocks — telemetry must not stop your work.

Exit codes: `0` ok · `1` local/tmux failure · `2` server unreachable ·
`3` auth · `4` not found · `5` usage.

Context flags on every command: `--project <session>` (default
`$TMM_PROJECT`), `--agent <name>` (default `$TMM_AGENT`, else `human`),
`--server <ws://host:port>`, `--output json` for machine-readable output.

## Chat (the basics, for completeness)

```bash
tmm send "@name message"        # post to the project chat; @name types it into
                                #   that agent's pane: idle, it starts a turn;
                                #   busy, it waits for the turn's end or joins
                                #   the running turn, by that CLI and its input
                                #   mode (queue / steer). It never cancels a
                                #   turn (that is `tmm agent interrupt`).
                                #   @human addresses the operator
tmm send "@name /compact"        # a CLI command, typed VERBATIM into that agent's
                                #   CLI (not its model), like the composer; one
                                #   @name or @all (= everyone but you); @human
                                #   stays a chat message; unknown name = exit 4
tmm send "@name text" --re <seq|id>   # reply QUOTING a room message: the line
                                  #   carries [re sender HH:MM: 「its first
                                  #   line」]; seq/id from tmm log --output json
tmm send "progress" --status     # ambient room progress; nobody is interrupted
tmm send "..." --image <path|url>   # attach an image by REFERENCE (repeatable)
tmm log [--since <ts>] [--limit N] [-f]   # read chat; -f follows
tmm log --grep <text> [--grep …] [--global]  # search the FULL history (any-match
                                #   terms; --global = across every project)
```

Normal final responses are recorded by hooks and automatically returned to
every agent whose request the turn carried (never to the human's pane, never
to yourself). Use addressed `tmm send` only to start a new
question, decision or handoff. A send without a recipient is rejected unless
it carries `--status`.

## Wake later — instead of sleeping

Never `sleep` to wait for something: a sleep blocks your turn and burns
context. End the turn and let tmm wake you (or anyone) with an ordinary
message, delivered like one sent at that moment.

```bash
tmm task start build --wake -- make all  # most waits are for an END: when the
                                #   task ends by itself, you get "[wake] task
                                #   build exited:<code> after <age>" + its last
                                #   lines (--wake @who wakes someone else;
                                #   `task stop` wakes nobody)
tmm send "@$TMM_AGENT check the deploy" --in 10m   # or a TIME, to yourself
                                #   (your own name, expanded by the shell; no
                                #   alias names you) or anyone: --in 90s|10m|2h|1h30m|1d,
tmm send "@name standup" --at 14:30        #   --at HH:MM (next occurrence) or
                                #   "YYYY-MM-DD HH:MM"; prints the resolved time
                                #   and wake id; at most 7 days ahead
tmm wake list [--all]           # pending wakes (this project / every project)
tmm wake cancel <id>            # yours, or any if you are the human
```

A wake arrives as `[wake] <text>` from whoever set it, so when you wake a
teammate its reply comes back to you; a wake to yourself is delivered to your
own pane and returns no reply to yourself. A plain `tmm send "@<you> …"` from
your own turn is never typed into your pane (refused unless it names someone
else real). Only a script whose parent shell has EXITED is not your turn
(`nohup … &` or `setsid`, then the command returns; cron), so its send does
reach you. Your CLI's own background run (kiro run_in_background, Claude
Code's background Bash) stays inside your pane and is still your turn: to be
told a job ended, use `task start --wake`. A `/command` cannot be scheduled. If the server was down at the due
time the wake fires once when it is back, marked late; a task wake that could
not be sent shows as `wake not sent: …` in `tmm task status|list|logs`.

## The task board — shared kanban, humans and agents alike

The project has ONE board (todo / doing / review / done). The human writes
issues on the board page; you read and update the same issues here. If your
task matches a board issue, keep that issue current — the board is the
plan's record, and a stale column misleads everyone who schedules by it.
`<id>` is the CURRENT PROJECT's number: each project starts at `#1` and has
its own independent sequence, so always run the command in the intended
`TMM_PROJECT` (or pass `--project <session>`).

```bash
tmm board                       # the whole board, grouped by column
tmm board show <id>             # one issue + its note thread
tmm board add "title" [--body <text>] [--assignee <name>]
tmm board take <id>             # claim it: assignee = you, status = doing
tmm board move <id> review      # done working — hand it to review
tmm board move <id> done        # accepted
tmm board note <id> "found the root cause in store.rs; fix is one COALESCE"
```

Conventions that keep the board honest:
- `take` before you start — two agents editing one issue's territory is the
  conflict the board exists to prevent.
- `note` decisions and findings ON the issue (not only in chat): the issue
  outlives the conversation and is what the next reader loads first.
  A note is delivered to the issue's reporter AND assignee (never to you or
  the human), so do not also `tmm send` it to them.
- `move <id> review` when YOUR part is done — this is a HANDOFF, not a
  label: a managed reporter gets the handoff in its pane and reviews it
  (a human reporter sees it on the board). Whoever accepts the work (the
  reporter by default, or the lead the team names) moves it to `done`; if it
  needs fixes they `note` what to fix and move it back to `doing`.
- Board status is the ISSUE's lifecycle; live agent state comes from hooks.
- Every status change is recorded in the room (`[tmm] board #N a → b`),
  so the chat shows the flow without anyone narrating it.
- Notices (review handoff, assignment, notes) are lines typed into a pane,
  so they reach a live MANAGED agent only: never you, never the human. The
  human reads the board and the room.

The ideal loop (and who moves what): the human (or lead) files the issue →
the lead assigns it (a managed assignee gets it in its pane) → the
assignee `take`s it (todo → doing) → finishes and `move review` (a managed
reporter is notified) → whoever accepts the work (the reporter by default,
or the lead the team names) accepts with `move done`, or `note`s fixes and
moves it back to `doing`.

## Background tasks — LOCAL tmux, no server needed

**The foreground is the default.** A command that finishes within your turn
— a test run, a build, a one-shot script, `git`, `curl` — runs in the
foreground, where you read its output directly. Reach for `tmm task` ONLY for
work that is long-running (minutes or more), asynchronous, or must outlive
the turn: a dev server, a watcher, a deploy, a remote job. Every task is a
tmux window; a window you start is yours to finish.

Each task is a tmux window with window-scoped `remain-on-exit`, so status and
logs survive the command exiting. It works even when the server is down.
A task runs as you: it gets your `TMM_PROJECT` and `TMM_AGENT` (and
`TMM_SERVER`/`XDG_CONFIG_HOME` if you have them), so a `tmm send` inside it
is from you and an `@<you>` in it reaches your own pane. Do not export them
in the task's script.

```bash
tmm task start <name> -- <cmd...>   # run detached in its own tmux window
      [--session <s>]               # default: your session, else "tmm-tasks"
      [--replace]                   # take over a name a live task holds
      [--wake [@who]]               # wake @who (default: you) when it ends by
                                    #   itself — see "Wake later" above
tmm task list                       # every task, in every session, + state
tmm task status <name>              # running | exited:<code>  (exit 4 if gone)
tmm task logs <name> [--limit N] [--grep <text>]   # default 50 lines, tail
tmm task stop <name> [--keep]       # C-c, then TERM, then KILL; prints the last
                                    # 20 lines and CLOSES the window (--keep keeps it)
tmm task rm <name>                  # close a finished task's window now
```

Finish what you start: `stop` when you are done with a long-running task,
`rm` after reading a finished one. A finished window you leave behind is
reaped 30 minutes after its process ended (the next `tmm task` verb closes
it; `TMM_TASK_TTL_SECS` overrides) — read its logs before then, or `--keep`.
Reuse names (`--replace`) instead of inventing a new one per run.

## Agents — manage yourself and your teammates

```bash
tmm agent list                      # who is here and their derived states
tmm agent interrupt <name>          # cancel the turn it is RUNNING (types
                                    #   Escape into its pane); a chat line never
                                    #   cancels a turn — it waits or joins it
tmm agent mode <name> queue|steer   # kiro only: switch how a line typed while it
                                    #   is busy lands (queue = after the turn,
                                    #   steer = into it) for THIS session; a
                                    #   restart returns to the configured mode
tmm agent stop <name>               # stop the process (slot survives)
tmm agent restart <name>            # bring it back, resuming its conversation
tmm agent restart --team <team>     # align a team with its current definition:
                                    #   restart who it still has, start who it
                                    #   gained, stop who it dropped (home kept)
tmm agent remove <name>             # eject: stop + forget slot + delete home
tmm spawn <registry-name> [--brief "<text>"]   # hire a teammate into this
                                    #   project; no brief = it waits silently;
                                    #   standalone unless you add --join
tmm spawn <registry-name> --join <team>   # …into a team of this project (live or
                                    #   stopped): it gets
                                    #   the team's context and is told its
                                    #   teammates; the team's definition is not
                                    #   changed (a team stop stops it, a team
                                    #   restart leaves it as it is)
```

## Projects

```bash
tmm project list
tmm project create <path> [--name n] [--session s] [--with-agent kiro|claude|codex|grok|omp|kimi]
tmm project up <session>            # bring the tmux session up (recreates
                                    #   missing windows, relaunches agents)
tmm project down <session>          # kill the session, KEEP the declaration
tmm project rename <session> --name "New name"   # the tmux session follows
                                    #   the name (slugged; printed); the room,
                                    #   board and wakes move with it
tmm project archive <session>       # forget the project (session survives)
tmm project delete <session>        # forget it AND delete its agents' homes
```

## Registry — central agent/skill/MCP definitions

```bash
tmm registry list
tmm registry save --name <n> --backend <kiro|claude|codex|grok|omp|kimi>
      [--system <text>] [--model m] [--effort low|...|high]
      [--skills a,b] [--mcp <json>] [--input-mode queue|steer]
                                    # steer (kiro, codex): a line typed while
                                    #   busy enters the running turn; applied
                                    #   on restart
tmm registry delete <name>
tmm skills list                     # the app-managed skill store
tmm skills save --name <n> --source <abs dir|github url>   # import files
tmm skills refresh <name>           # re-sync from the recorded source
tmm skills delete <name>            # (built-in skills refuse: they reseed)
tmm mcp list|save|delete            # central MCP server defs (the catalog;
                                    #   calling MCP tools is the mcp-cli skill)
```
