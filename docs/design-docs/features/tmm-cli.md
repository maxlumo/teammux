# tmm CLI — the agent's hands

## What this is

`tmm` (binary at `src-tauri/src/bin/tmm.rs`) is the CLI front for the project
hub: one chat room per project and hook-derived agent states. It is the
**only active interface an agent has** to the rest of the
system — the CLI-only substrate decision from
`docs/exec-plans/agents-v2.md` §4.1: what an agent *says* goes through `tmm`,
what we *observe* arrives through hooks into `projects::telemetry`, and the
two channels are joined at read time.

There is deliberately no MCP tool surface for this. MCP requires per-backend
config materialization and three different schema dialects; `tmm` requires
one line in a system prompt. (The agora MCP daemon that once backed the Team
feature was deleted with it, board #100.)

Two subtrees break the client-of-the-hub shape on purpose: `tmm task` and
`tmm mcp` are purely local and never open a socket — see their sections below.

Every command answers tenet 6's question — "what can an agent not do without
it": send/log are the room, board is the shared task state, spawn/registry/
teams are delegation, project is workspace lifecycle, prompt/skills/mcp are
the identity assets, task is background work, agent is teammate control. A
command that no agent needs is not added; `--help` is the complete list and
this reference stays one screen.

## Commands

```
# the room (context from $TMM_PROJECT / $TMM_AGENT, exported by the launcher)
tmm send "@name <text>"              send to one or more recipients (@all, @human)
tmm send "@name /command [args]"     typed VERBATIM into its CLI, like the composer (#274);
                                     @name must be a managed agent (else exit 4, nothing
                                     recorded); "@human /x" is a chat message to the person
tmm send "@name <text>" --in 10m | --at 14:30   a WAKE: delivered then as "[wake] <text>"
                                     (yourself included); prints the time and wake id (#275)
tmm wake list [--all] · tmm wake cancel <id>   pending wakes; the setter or the human cancels
tmm task start <name> --wake [@who] -- <cmd>   wake @who (default: you) when it ends by itself
tmm send "<text>" --status           ambient progress; room-only, interrupts nobody
tmm scratch [--kill]                 the desktop's scratch terminal session (#324): ensure it
                                     (in $HOME, no project) and print its pane target, or kill it
                                     — only ever OUR session; a name held by anything else refuses
tmm setup                            choose port, listen address, tmux socket, token and TLS (config.toml)
tmm gateway                          ensure this machine's gateway service is installed and running
tmm gateway start                    the gateway in the foreground (what the service and `server` run)
tmm gateway install [--replace]      the per-user service for THIS tmm + config root; idempotent
tmm gateway status [--show-token] · restart · uninstall · logs [-f]
tmm ui [--open]                      the web UI this machine's gateway serves: its URL, or why none
tmm send … --image <path|url>        attach an image by REFERENCE (repeatable)
tmm log [--since <ts>] [--limit N] [-f]      read chat; --since exclusive (ms), -f follows
tmm log --grep <text> [--grep …] [--global]  search FULL history (any-match, body+sender)

# the task board
tmm board [list] | show <id>         the kanban; one issue + its note thread
tmm board add "title" [--body <t>] [--image <path|url>] [--assignee <n>]
tmm board take <id>                  claim: assignee = you, status = doing
tmm board move <id> <todo|doing|review|done>
tmm board note <id> <text> [--image <path|url>]  progress/decisions ON the issue (an image alone is a note)

# teammates and projects
tmm agent list                       windows + agent detection + derived state
tmm agent interrupt|stop|restart|remove <name>
tmm agent mode <name> queue|steer    kiro only: its Ctrl+S, this session (#271)
tmm spawn <agent> [--brief <text>]   spawn a registry agent into this project
tmm spawn --team <team> [--brief <text>]     start a configured team (all members)
tmm project list                     ● live / ○ down, session + path
tmm project create <path> [--name n] [--session s] [--with-agent <backend>]
tmm project up|down|archive|delete|rename <session>

# identity assets (central registry)
tmm registry list|save|delete        agent definitions (--backend --system --model
                                     --effort --input-mode --skills --mcp)
tmm teams list|save|delete           named agent teams (members + roles)
tmm prompt show|path|set|clear       the app-wide instructions (<config>/AGENTS.md)
tmm skills list|save|delete|refresh|import   app-owned skill store
tmm mcp list|save|delete             central MCP server defs (RPC half)

# background tasks — LOCAL tmux only, no server, never exits 2
tmm task start <name> [--session <s>] [--replace] -- <cmd...>
tmm task list | status <name> | logs <name> [--limit N] [--grep <t>] | stop [--keep] | rm

# local MCP runtime (the mcp-cli skill; progressive tiers)
tmm mcp servers | tools [<server>] | schema <server> <tool> | call … | add …

# local helper
tmm claude-statusline                render Claude Code statusLine JSON from stdin
```

Global flags: `--project <session>`, `--agent <name>`, `--server <ws://…>`,
`--output json` (every read). Token from `config.toml`, overridable with
`$TMM_TOKEN`; server from `$TMM_SERVER`, default `ws://127.0.0.1:<port>`.

Central assets (skills, MCP defs, registry agents, teams) are the app's own
store; how they materialize into agents — built-in skills, one-url import,
isolated homes — is [agents-overview.md](agents-overview.md).

## Self-management: the app operates itself through its own CLI

Everything the UI can do to projects and the registry, `tmm` can do — and the
spawn prompt tells agents so. A lead can set up a whole project
(`tmm project create` → `up`), define a NEW kind of agent
(`tmm registry save`) and then spawn it: definition → instantiation →
delegation, all inside one conversation. This adds no authority: an agent
already holds a shell (it can run tmux or edit files directly), so first-class
commands only replace ad-hoc power with a documented, observable interface.
The former `can_hire` spawn gate followed that logic out on 2026-09-26 (owner:
"本身就是 agent 自己能够通过命令行获得的能力，不应该加到里边"): every agent may
spawn; the per-project cap alone bounds fan-out. `project up/down/archive` accept the SESSION NAME (resolved to the
project id via project_list), because the session is what agents and humans
actually see.

Verified with a real agent: a spawned lead briefed to "create a project at
/tmp/evolve" ran `tmm project create /tmp/evolve --session evolve`, verified
with `tmm project list`, and reported done — 21s end to end.

## The two hard rules

**Fail soft, never block.** The server is optional (agents-v2 principle 4):
an agent is a plain CLI process in a tmux window and must keep working when
the server is down. `tmm` enforces this with a 2s connect timeout, a 10s RPC
timeout, no retries: a dead server is one stderr line and exit 2, measured at
~20ms for connection-refused. Anything that calls `tmm` from a hook or a
prompt can treat it as fire-and-forget.

**Tiered exit codes** (multica's convention, adopted after reading its CLI
docs): `0` ok · `1` local/tmux failure (`tmm task` only) · `2` server
unreachable · `3` auth rejected · `4` not found (method missing on this
server — mobile or old build; or no such task) · `5` usage/params.
Agents and scripts branch on the class without parsing error prose.
`tmm task *` opens no socket, so it can never return 2 — see below.

## Background tasks (`tmm task`) — local tmux, no server

Retention is bounded since board #206 (30 min past death, every verb reaps;
`stop` closes; see "Retention is bounded" below).

The rest of `tmm` is a thin WS client: the hub subcommands go through
`rpc()` and `state.db` is owned by the server process. `tmm task` is the one
subtree that is purely local (`src-tauri/src/tasks.rs`, over `tmux.rs`), and it
has to be: **what an agent most often wants to run in the background is the
server itself.** A task manager that needed the hub to be up could not start
the hub. So `task` is dispatched in `main()` before `Config::load()` — which is
not just a read, it seeds a token and a machine id into `config.toml`, and a
command that only talks to tmux has no business doing that.

### `tmm mcp` — the CLI door that became a skill

The history matters because it explains the shape: for a few hours on
2026-08-28 this subtree REPLACED native MCP entirely ("可以不用各种 agent 内部
的 mcp 工具调用了，可以用 MCP Inspector CLI 来统一来做"), and the same day the
owner reversed the call ("mcp 工具还是用原生的方式调用吧，给 kiro 的 mcp 工具
开启 toolsearch。我们这个 cli 方式调用 mcp，只作为另一个 skill 就好"). The
final shape:

- **Native MCP is the invocation path**: registry defs materialize into each
  backend's own config at spawn (kiro `mcpServers`, claude `mcp.json` +
  `--strict-mcp-config`, codex `-c mcp_servers.*`, grok `[mcp_servers.*]`
  toml), exactly as before the detour.
- **kiro gets toolSearch**: managed kiro homes carry `toolSearch.enabled=true`
  with `minPct=0`/`minTokens=0` (`kiro_cli_settings` — written at spawn,
  backfilled by `refresh_hooks`), so MCP schemas are always DEFERRED into a
  compact list and loaded on demand through kiro's built-in `tool_search`.
  That is the progressive-loading behavior, natively.
- **`tmm mcp` survives as a SKILL** (`assets/skills/mcp-cli/SKILL.md`,
  imported into the store as `mcp-cli`): the system prompt does NOT teach it
  (a spawn.rs test pins that); an agent gets it only by listing the skill.
  Its niche is what native cannot do: per-call config reads, so `tmm mcp add`
  makes a server callable on the NEXT command with no restart, uniformly on
  every backend.

The subtree itself is the second purely-local one (like `task`, dispatched
before `Config::load()`):

- The verbs shell out to the **MCP Inspector CLI** (`$TMM_MCP_CLI`, default
  `npx -y @modelcontextprotocol/inspector --cli`), which connects, invokes one
  method, prints, and exits — its exit codes are a stable contract (4
  unreachable, 5 tool error) and pass straight through.
- Discovery is **progressive, like skills** (owner, 2026-08-28: "渐进式加载…
  避免一次性加载太多上下文，有点像 toolsearch"): each tier loads only what the
  previous one made you want. `servers` prints names; `tools <server>` prints
  ONE LINE per tool (name — first line of the description; the reshaping is
  `mcp_cli::compact_tools` over the inspector's `--format json` output, so a
  50-tool server costs 50 lines, not pages of schema); `schema <server> <tool>`
  prints ONE tool's full record, read just before calling; `call` invokes it.
  The SKILL tells its reader to walk the ladder and never dump every schema up
  front (the system prompt deliberately says nothing about any of this).
- **Dynamic**: `tmm mcp add <name> --def '{"command":…}'` merges one server
  into the config NOW (creating `.tmm/mcp.json` in a fresh workspace), and
  because the inspector reads the file per call, the next call has it. Editing
  the file directly is equally valid — `add` is sugar.
- The config is a STANDARD `{"mcpServers": …}` file at
  `<workspace>/.tmm/mcp.json` — **the agent's file**: `spawn` seeds missing
  entries from the registry defs (`seed_mcp_config`) but an existing entry
  always wins and unknown entries are kept, so an agent can edit its own tool
  set and the NEXT call reads it — no restart, which the native path could
  never offer. `$TMM_MCP_CONFIG` (set at spawn) names it from any cwd; without
  the env var the CLI walks up from cwd like git does.
- `tmm mcp list|save|delete` (the central registry defs) stay RPC — they are
  the catalog; `servers|tools|schema|call|add` is the runtime.

### Why this belongs to an agent at all

An agent's constraints differ from a human's. Every tool call is a fresh,
TTY-less, one-shot shell; the only state shared between calls is the
filesystem and the process table; and the agent's own context gets compacted.
So:

- **The handle must be discoverable, not remembered.** A PID noted in the
  conversation is exactly the thing that rots. `tmm task list` is one
  `tmux list-windows -a` call that enumerates every task in every session, so
  an agent that lost its context can rediscover what it left running.
- **Output must be bounded.** Context is the scarce resource; `cat`-ing a
  500 MB log destroys the caller. `logs` scans the whole scrollback but returns
  a bounded tail (50 lines by default).
- **A real TTY matters more than it looks.** Two reasons. When stdout is a pipe
  or file, libc switches from line to block buffering, so a Python/Node task
  can write nothing to its log for minutes — an agent polling it concludes the
  task hung and kills a healthy process. And a TTY is what makes `C-c` reach
  the whole foreground process group, so `stop` collapses the process tree
  instead of orphaning its children (a `nohup`-ed `npm → tauri → vite + server`
  chain cannot be given that signal; `scripts/preflight.mjs` exists because
  those orphans really happened). The TERM/KILL escalation follows the same
  rule (2026-09-03 review): it goes to the pane's process GROUP (`killpg`),
  not to `#{pane_pid}` — that pid is the `sh -c` wrapper, and a TERM to it
  alone let `npm run dev` or a pipeline run on headless while the pane went
  dead and the task said `killed:term`. tmux starts every pane as a session
  leader, so the wrapper's pgid is its own pid and the group is exactly the
  tree the task started; `stop_ends_the_whole_process_group_not_just_the_wrapper`
  pins it with a wrapper that ignores INT and a `nohup`-ed child — the kernel's
  SIGHUP to the foreground group when the wrapper dies is exactly what such a
  child shrugs off, which is why the pid-only version looked fine in casual use.

`pm2` was rejected, not just as an extra dependency: **auto-restart lies to an
agent.** From a log tail you cannot tell "running fine" from "crashed five
times and retrying", and for a build task the restart loop is pure harm. A
standalone shell wrapper was rejected because `tmux.rs` already solves socket
discovery (`-S`), tmux binary location, and `capture-pane -J` wrap
normalization — bash would duplicate all three, badly.

### The three tmux facts it rests on (verified, tmux 3.7b)

1. **`remain-on-exit on` is what makes a finished task observable.** The pane
   goes `#{pane_dead}=1` with the code in `#{pane_dead_status}`, and the
   scrollback stays readable. Status *and* log retention from one native
   mechanism — no pidfiles, no sentinel files, no log files. A task that
   auto-vanished would be evidence destroyed: the agent could never find out
   why it failed.
2. **It must be set with `-w`.** Session scope would turn it on for every
   window the user has open, so their shells would stop closing on exit. Not
   ours to change. Verified: with a task running in the current session, a
   sibling window still auto-closes and global `remain-on-exit` is still `off`.
3. **The registry is a window option, not a file.** `@tmm_task` marks the
   window; `@tmm_cmd` and `@tmm_started` ride along so `list` needs no second
   lookup. The options are set *before* `respawn-window -k` runs the command,
   otherwise a command that exits in milliseconds takes its window down first.

Task names are globally unique — the name is the handle — so lookups scan all
sessions, and `start` refuses a name a live task holds (`--replace` to take it
over). Refusing rather than clobbering matches preflight's philosophy and keeps
parallel subagents from silently stealing each other's tasks.

### Retention is bounded (board #206, 2026-09-20)

Owner: "当 agent 每轮都用新名称执行 tmm task start，它默认开启 remain-on-exit，任务结束后窗口
仍保留；停止任务也不等于删除窗口，这样就导致大量冗余窗口堆积…只有特别长时的任务 异步任务 后台
运行的任务采用 tmm task 执行". Measured on the live tmux 3.6a: 40 task windows, 39
dead, aged 21h–7d, every name used once, never `rm`'d. Two layers were wrong:
retention was unbounded and manual (`remain-on-exit` kept every finished window
until someone ran `rm`; `stop` kept the window on purpose), and the skill
prompt read as "run any command as a task".

- **A finished task's window lives `TTL` past its death**, 30 minutes by
  default (`tasks::DEFAULT_TTL_SECS`; `TMM_TASK_TTL_SECS` overrides, 0 for
  tests). The clock is tmux's own `#{pane_dead_time}` — the epoch second of
  the LATEST death; verified on 3.6a: set when the pane dies, EMPTY while it
  is alive again after `respawn-window`, set anew on the next death — so a
  reused name is never judged by an old death.
- **Every `tmm task` verb reaps at its door**, ONE mechanism, local, no
  daemon/timer/file, working with the server down: `tasks::reap_expired`
  closes windows that carry `@tmm_task`, are `pane_dead`, and died more than
  the TTL ago — never a running task, never a window without `@tmm_task`
  (a plain dead window is not ours). A verb reaps AFTER its own work and
  shields its own target, so `logs`/`status`/`rm` on an expired task still
  answer; `list` reaps first so what it prints is what exists. Reaped names go
  to stderr (`--json` stdout stays clean).
- **`stop` finishes**: C-c → TERM → KILL as before, then it prints the last
  20 lines (`STOP_TAIL_LINES`) and CLOSES the window; `--keep` leaves it (and
  `logs` still reads it). Stopping an already finished task closes it too.
  `rm` is unchanged: close now.
- **The prompt reverses its default**: `assets/skills/tmm-cli/SKILL.md`
  (embedded as a built-in skill by `projects/skills.rs`, materialised to
  `<state dir>/skills/tmm-cli/SKILL.md` by `seed_builtin_skills()` at server
  start, which is where agents load it — so a changed asset lands at the next
  server start, not at merge) says the foreground is the default and `tmm
  task` is for long-running / asynchronous / must-outlive-the-turn work only,
  finished with `stop`/`rm` or reaped by the TTL.

Tests (`tasks::tests`, real tmux on a PRIVATE socket — a TTL-0 sweep on the
shared server would close the developer's own finished windows, which is the
production effect and not a test's): the expired task is reaped, the verb's
target is shielded, a running task and a dead non-task window are untouched,
a fresh death is not expired at the default TTL; `stop` closes with its tail,
`--keep` keeps, and `stop` on a finished task closes.

### A task runs as whoever started it (board #291, 2026-09-30)

Owner (14:55, LingTing): a line `@architect [queue-watch from data] …` showed
as the HUMAN's outgoing bubble, though the human never sent it. `data` had
started the watcher with `tmm task start lingting-queue-watch -- …`. A tmux
window starts with the tmux SERVER's environment, not the caller's, so the
task had no `TMM_AGENT` (its script exported `TMM_PROJECT` by hand) and every
`tmm send` inside fell back to `human`. Meanwhile the `--wake` hook of the same
task did carry the starter. One mechanism had two answers.

Now `tasks::starter_env` is the ONE definition of the starter, and both
consumers take it: the task command gets it as `respawn-window -e KEY=VAL`
(tmux's own door, set on every start, so a reused window gets it too), and
`wake_shell` prefixes the wake with it. It holds `TMM_PROJECT` (`--project`,
else `$TMM_PROJECT`) and `TMM_AGENT` (`--agent`, else `$TMM_AGENT`). Both are
always set, and empty when the starter has none, because tmm reads empty as
unset: a stale identity in the server's environment cannot leak in, and a task
the human starts speaks as the human. `XDG_CONFIG_HOME` and `TMM_SERVER`
travel only when the starter has them, because an empty `TMM_SERVER` would be
read as an address. A task pane is not its starter's turn (board #285), so a
task's `@<starter>` send reaches the starter too. A task no longer has to
export `TMM_PROJECT`/`TMM_AGENT` itself. Rows already recorded as `human`
(state.db seq 10820, 10962, 11123) are not rewritten. Pinned by
`a_task_runs_with_its_starters_identity` (`tasks.rs`, real tmux: a stale
server env, a fresh window as an agent, a reused window as the human).
Negative control: dropping the `-e` fails it with `agent=[stale]
project=[stale]`, which is the bug.

### Two things that read as bugs and are not

**`logs` filters tmux's own `Pane is dead (…)` line.** tmux writes it into the
pane, on the bottom row, padding the gap above with blank rows. Left in, a
bounded `--limit 5` returned five blank lines and the real output fell out of
view. So `logs` returns task output only (and only strips the marker for dead
tasks), while `status` stays the single place that reports how it ended.

**A signal death is not an exit code.** `State::Killed(String)` is fed from
`#{pane_dead_signal}` (tmux names it: `kill`, `int`, `term`). The first cut
reported a SIGKILL as `exited:-1`, which is a lie an agent would then act on;
JSON now carries `exit_code` and `signal` as separate fields, one of which is
always null. `Exited(-1)` survives only as the "dead and tmux told us nothing"
fallback.

### Naming

`task`, not `bg`: the existing management surface is `<noun> <verb>`
(`project up`, `registry save`), a noun is what `list` can enumerate, and
shell `bg` actually means "resume a *stopped* job", which is the wrong
semantics. `spawn` was unavailable — it already spawns agents. `start`, not
`run`, because `run` implies it blocks and returns output, and an agent holding
that mental model waits forever. No aliases: they double the surface an agent
can get wrong to save three characters.

### Known limits

- Output lives in the tmux scrollback, so anything past `history-limit` is
  gone. Deliberate: writing a log file would bring back the CR/ANSI sludge
  that makes `capture-pane` output nice to read in the first place.
- Tasks are tmux windows, so `tmux kill-server` takes them with it.
- The `tmm-tasks` fallback session keeps one idle shell window (the one tmux
  creates with the session). Harmless, and it keeps the session alive between
  tasks.

## Waking an agent later (`--in` / `--at`, board #275)

Owner, 2026-09-29 08:04: agents running very long jobs sat in `sleep`, which blocks the turn and burns context. `tmm send "@name text" --in 10m` (or `--at 14:30`) lets the agent end its turn instead. The server types the line later, through the same path as a line sent now. No CLI has a native way to do this (measured: kiro-cli 2.22.1 and codex-cli 0.154.0 have nothing; Claude Code 2.1.284's background sessions cannot type into another pane), so one mechanism serves every backend.

- **A declaration.** Each wake is a row of `wakes` (state.db v29, `projects/store/wakes.rs`). It is not a `deliveries` row: a delivery is one line already typed for one window, waiting for its echo, and a wake's recipients are resolved only when it fires. One sleeper (`projects::wakes::run`) waits until the earliest due time; a schedule or cancel wakes it. There is no tick.
- **At most once, and from the row.** The sleeper holds only a wake's id and due time. `fire_wake(id)` claims the row (`fired_at`) and reads it back in the same store step, then fires with the row's CURRENT session, so a rename while the sleeper waited cannot send it to a dead room (validator 09:54). A second fire does nothing. A crash between the claim and the post loses that one wake rather than doubling it. At server start every past-due row fires once, in due order, and says `(late: was due …)`; there is no drop window, because the 7-day limit already caps the delay (orchestrator 08:20 B).
- **One fire path, one record.** The fire posts `[wake] <text>` as the SCHEDULER, in the `[reply]` marker shape, and delivers it with `deliver_mentions`. So busy/queue/steer holding and team context apply exactly as for a line sent now, and when A wakes B, B's reply returns to A. The room records it once, when it fires; nothing is posted at scheduling.
- **Self-wake: two rules.** (1) `deliver_mentions` never types a line back into its sender, except a fired wake or a post detached from the sender's turn (both `to_sender`; the second is board #285, below), so an agent's `tmm send "@$TMM_AGENT …" --in 10m` reaches its own pane. There is no `@me` alias: a second self-name would be a second rule (orchestrator 10:21). (2) An agent is never its own reply target (`take_reply_targets`): replying to its own wake would type the answer back into the same pane, a loop. Rule 2 holds for every prompt, not only wakes.
- **The CLI says so (board #283).** Because of rule 1, an unscheduled `tmm send` whose only recipient is the sending agent reaches nobody. It is refused with exit 5 (usage) and names the two doors: `--in 10s` or `tmm task start <name> --wake -- <cmd>`. When other names ride along, the CLI checks them against the live roster with the same `hub_agents` read a `/command` target uses (#274; orchestrator 14:28: say only what is true). `@human` is a real recipient; `@all` is one only when another managed agent exists; any other name must be a managed agent. If none is real (an unknown name, `@all` in a room where the sender is the only agent) the send is refused like a self-only one, naming the unknown tokens; otherwise it is sent and stderr says the sender's own copy is not typed, naming any unknown token. A roster read that fails fails the send as any RPC does. `--status`, a wake and the `human` identity (`--agent human`, `TMM_AGENT=human`, or none; it has no pane) are unaffected; the server skip does not change. Incident: LingTing watcher scripts run with `nohup` inherited `TMM_AGENT` and posted `@<self> [watcher] …`; `✓ sent` hid five lost notices on 2026-09-29, one a training failure found 68 minutes late. Pinned by `a_send_to_yourself_is_refused_unless_someone_real_else_gets_it` (`bin/tmm.rs`). The refusal and the note apply only to a call made by the agent's own turn (next rule).
- **A script the agent left behind is not its turn (board #285).** The skip exists so a turn cannot type into itself. A watcher started with `nohup … &` inherits `TMM_AGENT` and even `TMUX_PANE` from the agent's pane, then outlives the turn under init, and its `@<self>` copy is exactly what the agent needs (owner, 2026-09-30: four LingTing job notices lost in two days, even after #283). So `tmm send` asks the process table, not the environment: the call is the agent's turn only when `$TMUX_PANE` is the agent's own window AND this `tmm` descends from that pane's `#{pane_pid}` (`from_own_pane`, `descends_from`: `/proc/<pid>/stat`, else `ps -o ppid=`). Otherwise (reparented because its parent shell exited, as with `nohup … &` or `setsid`; no `TMUX_PANE` as under cron or a k8s hook; a pane that is gone; a `tmm task` pane) the post carries `detached: true` and `hub_post` types the sender's copy too: the plain `[tmm chat …] <agent>: …` line everyone else gets, not a `[wake]`, because it is the same message. `@all` then includes the sender. A turn's own call keeps the skip and the refusal above. So does a process started by the CLI's OWN background run (kiro `run_in_background`, Claude Code's background Bash): it stays under `node ← bun ← kiro-cli-chat` inside the pane, a descendant of `pane_pid`, so its `@<self>` is skipped (validator 06:06, measured). The skill says so and points at `tmm task start --wake`, which reaches the agent from a task pane. `detached` is a courtesy flag like `--agent`. Measured on this host 2026-09-30: an in-turn call's chain is `zsh ← node ← bun ← kiro-cli-chat ← kiro-cli ← <pane zsh = pane_pid>`; the LingTing watcher's parent was `systemd --user`. Live scratch check (one kiro, v3 engine): a nohup'd script with the kiro pane's `TMUX_PANE` and `TMM_AGENT=kiro` sent `@kiro [watcher] …`; kiro received it and answered; kiro running `tmm send "@kiro …"` in its own turn got exit 5. Pinned by `a_call_is_the_agents_turn_only_when_it_descends_from_the_pane` (`bin/tmm.rs`, pure chain plus the real process table) and the detached post in `a_fired_wake_reaches_its_own_sender_once` (real tmux). Negative controls: a server that ignores `detached`, or a walk that always answers "descends", fails them.
- **Limits.** `--in` is at least 10 s, with units s/m/h/d that can be summed (`1h30m`). `--at HH:MM` is its next occurrence: today, or tomorrow when already past (orchestrator 08:20 C). `YYYY-MM-DD HH:MM` is taken as written. The CLI always prints the resolved local time and the wake id. A wake is at most 7 days ahead, at most 50 are pending per project, and it needs an addressee. A `/command` cannot be scheduled yet (orchestrator 08:20).
- **See and cancel.** `tmm wake list [--all]` and `tmm wake cancel <id>`. Only the scheduler or the human may cancel, so a teammate cannot drop your reminder by mistake (orchestrator 08:20 A). This is a courtesy rule against mistakes, not a security boundary (orchestrator 09:33): tmm has no per-agent authentication, and every verb (send, board, agent stop/remove, wake cancel) trusts the declared `--agent` / `TMM_AGENT`; the token authenticates the client, not the agent. The UI shows the next wake as one hover row on the addressee's card, `wake 14:30 · builder +2` (`hub_agents.wake`, `wakeLine`). There is no badge and no UI cancel (tenet 11).
- **When a task ends: `tmm task start <name> --wake [@who] -- <cmd>`.** Most sleeps wait for an end, not a time. The task's pane gets a tmux `pane-died` hook that runs `tmm task wake <name>`. That verb schedules a wake due now, with the body `@who task <name> exited:<code> after <age>; last lines:` followed by the last 15 lines. Measured on tmux 3.6a: the hook fires once per death with `#{pane_dead_status}` or `#{pane_dead_signal}`, and not for a command that `respawn -k` replaces, so no wrapper is needed around the task's command (orchestrator's fallback). The hook's shell command lives in a pane option expanded with `E:`, so no task name or path goes through tmux's command parser; literals are `#`-escaped. The hook carries `TMM_PROJECT`, the starter as `TMM_AGENT`, `XDG_CONFIG_HOME`, and the server the task was started against (`--server` or `TMM_SERVER`), but never the token: tmm reads it from config, as an agent's tmm does. An `@` in the output gets a zero-width space after it, so a log line never addresses anyone. `tmm task stop` clears the hook first, because the one who stopped it knows. Every start sets or clears the hook, so a reused window never keeps an old one. Fail-soft and visible (orchestrator 09:33): with the server down nothing is sent and nothing retries, and the reason is recorded ON the task (`@tmm_wake_err`). `tmm task status`, `list` and `logs` then print `wake not sent: @lead was not woken (…)`. It is not printed into the pane itself because a dead pane's tty is closed: measured on tmux 3.6a, neither a `run-shell` hook's output nor a write to `#{pane_tty}` appears on its screen. Every start of the task clears it, with or without `--wake` (`a_wake_failure_is_recorded_on_the_task_until_it_restarts`). Pinned by `a_wake_task_runs_its_command_once_at_its_own_end` (real tmux: one run for a self-ended task with its status, none for a stopped one, none after a restart without `--wake`) and `a_task_end_wake_says_how_it_ended_and_addresses_only_its_target`.
- **Renames.** Wakes are keyed by the project's session, like the board, and follow a rename in the SAME `set_session` transaction (validator 09:31). That is less surface than keying them by the project id, which would need an id lookup on every wake call. Pinned by `a_wake_follows_two_renames_and_fires_once_into_the_real_pane` (after A → B the list, hover and cancel see it; after A → B → C, firing the id the sleeper held from BEFORE the renames posts once into C's real pane and room). Negative controls: without the move, B lists nothing; firing the pre-rename snapshot fails the test.
- **Pinned by** `a_fired_wake_reaches_its_own_sender_once` (real tmux: an ordinary self-addressed post types nothing, the wake reaches its sender, a second fire types nothing more, one room record), `an_agent_is_never_its_own_reply_target`, `the_sleeper_fires_missed_wakes_once_then_new_ones_on_time`, the store claim/cancel test and the CLI parse tests. Negative controls: dropping the `to_sender` exception, the self-target filter or the claim each fails its test.

## The gateway (`tmm gateway`, board #323)

Owner, 2026-10-09: "通过输入 tmm gateway 就可以启动后台的 server…做成 Linux 或 macOS 下的一个后台进程任务". `gateway::start` (`src-tauri/src/gateway/`) is the ONE start path: `tmm gateway start` runs it in the foreground, the `server` binary is a thin alias of it (the dev watcher and existing units launch that name), and the installed service runs `tmm gateway start`.

- **Bare `tmm gateway` = ensure the service is installed and running**; `install` is the same verb with `--replace` available.
- **First-run setup** (`gateway/setup.rs`; owner: "如果本地没有 TMM 的配置，启动时可以提供配置引导"). `tmm setup` runs it alone; `tmm gateway`, `gateway install` and `gateway start` run it when `config.toml` does not exist yet, in the foreground caller — the installed service (`gateway start --service`) never prompts (it has no terminal), and `status` never does (it reads with `peek_service`). One step, `setup_step`, decides, with ONE read/validate boundary first in every mode (`read_existing`): only a file that does NOT EXIST is a first run; an unreadable file, non-UTF-8 bytes or a file the schema rejects stops the command in a terminal and without one alike — the bytes stay as they are and no token or machine id is created. Its outcome is `Existing` (a valid file: nothing asked), `Proceed` (answered and written), `Cancelled` (EOF, or three invalid answers to one question: nothing written, and `tmm gateway …` exits non-zero with "setup cancelled — nothing was installed or started" — no unit, no start) or `NonInteractiveDefaults` (no terminal, no file: only what any first start does, a token and a machine id, and it says so). It asks the port, the listen address (default `0.0.0.0`, with the two lines "reachable from your phone on this network — the token is the guard, not encryption; use TLS or Tailscale off your LAN" / "127.0.0.1 = this machine only"), the tmux socket (a running server's socket is shown as a hint; empty = tmux's default), whether to keep an existing token (else a new one), and an optional TLS certificate + key (both files must exist). Where a socket or certificate is already set, the prompt says Enter keeps it and `-` clears it. **Paths are saved absolute**: the service runs from another directory, so a relative answer is resolved against the caller's cwd and `~`/`~/…` against HOME at setup time (`~user` is refused); the socket need not exist yet. The answers are written through the ONE schema `Config` reads (`config::validate_file`) by editing the file in place (`toml_edit`): every other key and comment stays; the write is a 0600 temp file renamed over the old one. **A parse error never quotes the file** — toml's own message prints the offending line, which may hold the token — only the kind ("not valid TOML" / "a value of the wrong type or out of range") and line and column. Tested over scripted answers (defaults, re-asks, EOF, three strikes, token keep/replace, TLS both-or-neither, relative and `~` paths), on bytes (keys and comments kept, schema rejects, 0600, no temp left, unreadable/non-UTF-8/invalid unchanged in both modes with a dummy secret never echoed), and through the real CLI (`src-tauri/tests/setup_cli.rs`: an isolated root, a fake init system that only logs, a pty): a cancelled `gateway install` writes no config, no unit and makes no native call; an unparsable config stops it the same way and the dummy secret never reaches the terminal; relative TLS answers start `gateway start --service` from `/` on `wss://`.
- **The service** is a launchd LaunchAgent `~/Library/LaunchAgents/cc.voka.tmux-mobile.plist` (the label clawdbjs already ran by hand since #313 — deliberately not the app bundle id `com.tmuxmobile.dev`) or a systemd user unit `~/.config/systemd/user/tmux-mobile-gateway.service` (`Restart=on-failure`, `WantedBy=default.target`). It runs `<absolute tmm> gateway start --service` directly — no shell — with `XDG_CONFIG_HOME` (the config ROOT, the parent of the app's config dir), `HOME` and `PATH` in its environment; never the token. **`--service` loads config.toml ALONE** (`Config::load_service`): a user manager's environment cannot change the service's port, bind, token or TLS, so the service and `status` always read the same thing. The unit is rendered with systemd's quoting (`\`, `"`, `%` specifiers, `$` expansion in ExecStart; `$` stays literal in Environment=); the plist is SERIALISED by the `plist` crate. A newline or NUL in any value is refused. It lives in the user session (launchd `gui/<uid>`, systemd `--user`): on Linux a headless host needs `loginctl enable-linger <user>` for it to start at boot; it is never a root daemon.
- **The unit does not take tmux down with it (`KillMode=process`, board #350).** Found during the #343 host switch, 2026-10-12 08:02, by reading cgroups: the owner's default tmux server and every agent pane were INSIDE `tmux-mobile-dev.service`'s cgroup, because the gateway that ran `tmm project up` was the watcher's child and a forked tmux server inherits its spawner's cgroup; only a hand-made `KillMode=none` drop-in had kept `systemctl --user stop` from killing all of it. The gateway unit has the identical shape — it forks tmux servers, and `npm run gateway:update` restarts it after every merge — so with systemd's default `control-group`, the first restart after the gateway became the forker would have lost every session a third time that day (05:51 and 07:12 did, by other hands; this one was found before it fired). The unit therefore renders `KillMode=process`: systemd signals the main process only; children live on. What `process` does NOT promise: it changes only the signal scope when THIS service stops; the children stay in our cgroup, so a user-slice shutdown, logout, or a hand `kill` of the cgroup still takes them. `none` was rejected — it spares the children but kills nothing on stop, so a wedged gateway could never be ended. `systemd-run --user --scope` around the fork would put tmux in a cgroup of its own, so OUR service's stop could never reach it by any KillMode — but that scope still lives under the same user manager and slice, so it is no promise about logout or a slice shutdown either. It was evaluated and rejected for now: a second place that knows about systemd, Linux-only while the forking code is shared with macOS, and it needs the bus from inside the service; one `KillMode=` line covers the restart that actually recurs. **The protection is a fact about the MANAGER, not the file.** Measured on this host (2026-10-12): `systemctl --user daemon-reload` applies a changed `KillMode=` to an already-running unit — same MainPID — so protecting an old unit needs NO restart, and the manager can be asked (`systemctl show -p KillMode`, drop-ins included) before anything is stopped. Every path that would stop a running unit of ours — `install`'s update, `restart` (which `gateway:update` calls), `uninstall` — asks `Sys::stop_allowed` first, and only an effective `process` on a unit the manager plainly reports as RUNNING passes; a manager that reports anything else, or that cannot be read (a failed `show`, a missing field, a transitional state), refuses with the hazard and the way out — not knowing whether it runs is not knowing whether it is protected. A protection that does not take (a `daemon-reload` failure, a drop-in) stops nothing and leaves the new text in place on purpose: the next plain `install` finds the file complete, reloads, reads the manager back, and finishes — the half-done state is recovered by the same command, and a `Keep` is never a quiet no-op while the manager is not at `process`. A pre-#350 unit is still ours (same identity; `KillMode` joined the grammar) and `plan` names it `Protect` when the missing line is the only difference: `install` writes, reloads, reads back, and returns `Protected` without a stop; an `Update` on such a unit does the same first and stops only after the manager confirms. `status` reads the manager's value while the unit runs and the file when it does not. launchd has no cgroup kill: never `Protect`, stop always allowed. Pinned on the rendered text, the plan, and a fake manager whose `show` follows the file only on `daemon-reload`; the live cgroup effect is not something a test can measure.
- **Identity, structurally.** Every verb reads the installed file back. Ours = exactly our shape for this name, by a grammar that refuses anything it does not interpret. A plist is parsed as a structure (XML or binary): only the keys tmm writes (`Label`, `ProgramArguments`, `EnvironmentVariables`, `RunAtLoad`, `KeepAlive`, `StandardOutPath`, `StandardErrorPath` — so `Program`, `WorkingDirectory`, `UserName`, … are not ours), `Label` = the file's name, `ProgramArguments` exactly `[<this tmm>, gateway, start, --service]`, `EnvironmentVariables` only `XDG_CONFIG_HOME`/`HOME`/`PATH` with `XDG_CONFIG_HOME` = this root. A unit is read by section: only `[Unit]`, `[Service]`, `[Install]`, each once, each with only the keys tmm writes; identity is the `[Service]` section alone — exactly one `ExecStart="<this tmm>" gateway start --service` and `Environment=` lines in our quoted form, one per key, only `XDG_CONFIG_HOME`/`HOME`/`PATH`, with `XDG_CONFIG_HOME` = this root (an `Environment=` in `[Install]` is never identity). Quoting is read back by the renderer's exact inverse: only `\\` and `\"` escapes (plus `%%`, and `$$` in ExecStart) — systemd decodes `\t`, `\n`, `\x…` to other bytes, so any other escape is not ours. Leading or trailing whitespace, a continuation line, a CR, a duplicate key, an `ExecStart` prefix (`-`, `@`, …) or any unknown key → not ours. Only a file that does NOT EXIST is absent; any other read or parse failure is "not ours". Not ours → refused with what it names, never adopted, overwritten or removed (`uninstall`, `restart` and `logs` included). `TMM_GATEWAY_SERVICE` must be a bare file name (no separator, no `..`, no leading `.`/`-`, `.service` on Linux).
- **Native operations are checked** (`service::Sys`, injectable; the tests drive a fake init system). Before installing when ours is not running, the probe must say `None` — a held port, or this machine's gateway answering outside this service (a foreground `start`), refuses before anything is written, because a new instance could only fail and the other answer would mask it. A stop that fails aborts before the file changes, unless the service is confirmed not loaded — and only the init system's explicit answer counts (systemd `LoadState=not-found` or inactive+disabled; launchd's "Could not find service"); a query that fails otherwise is an error, never "stopped". Install, a forced start and `restart` WAIT until OUR instance runs (its pid stable) and the probe says Ours — a 10 s polling budget that counts the probes and queries, not only the sleeps: no poll starts past it, so the wait ends within 10 s plus one poll (a probe is bounded at 1.5 s; the native queries carry no timeout of their own) — and fail with the last reason otherwise; the CLI exits non-zero. Same identity and same bytes and running → nothing at all happens (the pid is kept); same identity, different bytes (a new PATH) → stop, rewrite, load, wait. `--replace` is the explicit migration of a file of THIS name that is not ours (the #313 hand plist), and it runs BEFORE the port check, because that old service may be the very gateway on the port: copy the old file to a backup name no earlier backup has (`<file>.bak-<ts>-<n>`), stop it (a failed stop changes nothing), THEN require the port free (an unrelated occupant still refuses), write ours, load, wait; on any failure it stops ours, copies the old file back, loads it and — when it was running — checks it runs again, and reports both errors, keeping the backup, when that restore fails too. `restart` is the only forced restart.
- **`status`** is read-only (`Config::peek_service`: nothing is created, so it never makes a machine look configured) and prints the service state (installed / running pid / not ours) and the local probe's verdict — `answering at <url> (this machine)`, `occupied — <why>`, or `not running` — then the listen address, the config dir and the connect hint; the token only with `--show-token`. Exit 0 only when our gateway answers.
- **The probe** (`gateway::probe`) logs in with the server's OWN challenge: it waits for the `server_nonce` greeting (anything else is not our gateway), answers with a fresh client nonce and the v2 HMAC proof, and accepts only a reply sealed under the s2c key — so the token never crosses the wire (an echo server receives a nonce and a proof; validator's fixture), and a plain "authenticated" answer is a forgery, not ours. `Ours` = a sealed answer with our machine id; `Occupied` = everything else that answers, with a CLASSIFIED reason (not a WebSocket, not the protocol, token refused, cannot seal, another machine, a TLS failure, no answer in 1.5 s) — no peer bytes are ever quoted; `None` = connection refused. The address follows the config (a wildcard bind is reached on the matching loopback, a specific address on itself; `wss` when TLS is configured). TLS is verified by rustls's `WebPkiServerVerifier` with the configured certificate as the only trust anchor (signature, validity period, subjectAltName against the dialled address) plus a pin on that leaf; a `CA:TRUE` certificate is reported as needing a leaf certificate. Only `None` means free. A second `gateway start` on a taken port fails and says who holds it.
- **Smoke** (`scripts/gateway-smoke.sh <tmm> [port]`) on a real systemd user manager, under a TEST name unique to the run (`tmux-mobile-gateway-test-<pid>.service`): preflight refuses when it exists or the port is taken; every call is `env -i` with only HOME, PATH, the user bus, the scratch `XDG_CONFIG_HOME` and the test name; the EXIT trap stops the foreground gateway it started and removes the unit ONLY through `tmm gateway uninstall` (the identity check above — a unit that is not this run's is refused and never stopped, and its failed state is not reset); a failed cleanup fails the run, and while a unit remains its scratch root (exe and config) is kept, with the journal and unit as evidence; every check is an assertion. It proves `--service` ignores `PORT=1 HOST=9.9.9.9`, the unit carries the root and no token, the service listens on the scratch port, status sees it, a second install keeps the pid, restart changes it, a second foreground start names the holder, another executable's uninstall is refused and changes nothing, a path-escaping name is refused, uninstall removes it. `scripts/gateway-smoke.test.ts` runs the script itself against a fake user manager and a fake tmm: a competing install is refused and the other unit is never stopped, a foreground-phase failure leaves no foreground gateway, a cleanup whose stop fails exits non-zero and keeps the evidence and the exe.

- **The web UI on the gateway's own port** (`server/dispatch.rs`, `server/ui.rs`; owner: "tmm ui 或类似命令来启动 UI 的 server"). There is no second server: every connection, plain or TLS, goes through ONE door that reads the request head (16 KiB up to the blank line, 5 s) and routes it from the parsed request line and headers — a `…/dl` PATH with a query → the signed download (as before); `Upgrade: websocket` (case-insensitive, a token list) → the WebSocket handshake; any other `GET`/`HEAD` → the static UI; anything else → 400. The handler gets a stream that REPLAYS every byte already read, so the download parser and tungstenite see the request exactly as sent; this replaced the 256-byte peek and the TLS `fill_buf` special case. The UI's source is one rule: `ui_dir` (absolute) when set, else the `dist/` embedded with the `embed-ui` feature (`build.rs` writes a sorted `include_bytes!` table; it fails clearly without `dist/index.html`, and any change under `dist/` rebuilds), else none. A `ui_dir` without a readable `index.html` is an error, never a silent fall back; `ui_info` and every GET resolve through ONE function (`resolve` → File / Missing / Refused), so `index.html` as a directory or as a link out of the root is "no UI" to `tmm ui` and 404 to the browser alike. `build.rs` refuses any symbolic link in `dist/` (a link could embed a file from outside it, or loop). Paths are percent-decoded once; `..`, `.`, empty segments, `\` and NUL are 404; a directory source canonicalises and must stay under its root, so a symlink cannot leave it. The SPA fallback answers navigations only (`Accept` has `text/html`, no extension) and only for a path that does not EXIST — a missing script is 404, and a refused path (a link out of the root, dangling or not) is 404 even when asked as a page. `immutable` only for a name Vite gave a content hash (`assets/<name>-<8 base64url chars>.<ext>`); `public/` files copied under their own names (`assets/icon.svg`, `assets/notify.wav`, …) and `index.html`/`sw.js` are `no-cache` (a test runs the rule over the real `public/assets`); `HEAD` = the same headers, no body. index.html gets `<meta name="tmm-gateway" content="1">` injected into the RESPONSE (the file on disk / in the binary is unchanged, so the PWA precache stays truthful); the page then defaults its address to its own origin (`connection-address.ts`). No token or address is ever in the page or a URL.
- **`tmm ui [--open]`** asks the gateway over the PROBE's own authenticated session (`probe_and_ask`: the challenge login, sealed frames both ways, the configured TLS trust; the request is sent only after the login proved the gateway ours, never on a second connection) the `ui_info` method, which answers from the same source check the requests use. Verdicts: nothing listening → "no gateway is running … start it with: tmm gateway" (exit 2); something else on the port → "not this machine's gateway: <classified reason>" (exit 2); ours without a UI → the reason (no embed-ui and no ui_dir / ui_dir unreadable / no index.html / not absolute; exit 4); an older gateway without `ui_info` → says so (exit 4); ours with a UI → the page URL (`http(s)://<local_url host:port>/`), and `--open` runs `open`/`xdg-open` with that URL as one argument. Nothing is opened in any other case. Tested: sniff classification (query `/dl?` is not a download, case, token lists, bad methods/versions), a head split across 7-byte segments replayed byte-exact, the 16 KiB limit (also within one segment, and frame bytes after the head not counted), traversal/symlink/SPA/404/cache/marker, `ui_info` on the real server's sealed session, an echo gateway asked nothing; smoke from `/` with a copied binary: `embed-ui` serves `/` (marker), assets (bytes = dist), 404 / 200-navigation / traversal 404 / HEAD / POST 400, WS login on the same port, `tmm ui` URL and all three no-UI verdicts; TLS: `https://` page, `/dl` preflight 204 and the probe on one port.
- **First address of a client** (one derivation: `Config::local_url`, which the probe, `tmm ui` and `get_local_config`'s `url` share — wildcard → loopback, IPv6 bracketed, a specific bind on itself, `wss` with both TLS files). A saved address always wins. A gateway-hosted page → its own origin. The desktop app (not Android) decides the TARGET first (a saved address, else one typed while the config loaded, else `url`) and fills the local token and socket ONLY when that target is the local gateway (`isLocalTarget`), each only when nothing is saved for it and nobody changed it; a saved or typed remote address never gets local values. The auto-filled values remember which address they are for: moved to another server, the ones still untouched are cleared (`dropAutofilled`); what the person typed stays. A history pick first drops the untouched auto values that do not belong to the picked address — the socket included, since history entries carry none — then applies the entry's address and token (`pickHistory`); picking the local gateway keeps its socket, still tracked. `Settings.autofill.mount.test.ts` drives the real Settings with a delayed `get_local_config`: fresh install filled; saved remote with no token, remote typed during the wait, auto-fill then switch to remote, and auto-fill then a remote HISTORY pick never carry the local token/socket (the entry's token stays); a local history pick keeps the socket; Android never asks.

- **The desktop app reuses the gateway** (`lib.rs::run`, 323-app). At start, before the window, it loads `Config::load` (the app keeps its environment-aware load; the service's `load_service` is file-only, so the two agree on the file and differ only where the app's process environment overrides HOST/PORT/TOKEN/TLS/socket) and runs `gateway::probe` ONCE, bounded at 1.5 s. `Ours` → the gateway is reused and no in-process server starts; `None` → the embedded server starts through `gateway::start_ready`, and is reported `starting` until the listener is bound and TLS loaded (`start_with_socket_ready` sends `ready` right before the first accept), then `embedded`; an error before or after is `failed` with our own error; `Occupied` → nothing starts, the reason is the probe's classified text. No re-probe: if a reused gateway dies the app reconnects like any client and does not start a server (no central node). The mode is a small state machine keyed by a start generation (`advance_mode`, pure, tested): within a generation `embedded` applies only over `starting` and `failed` is terminal, so a ready signal whose task runs after the failure was written never revives the mode (review P1-a). Each APPLIED transition mints a `seq` in the same lock and is emitted as `server_mode_changed` while the lock is held, so publication order is seq order; `server_mode` (a Tauri command, `null` off the desktop) answers the same snapshot shape `{mode, url, reason?, gen, seq}`. The frontend's `localServer` (`server-mode.svelte.ts`) subscribes ONCE and reads once, and both go through `newerMode`, which keeps only a strictly newer `seq` — an old read landing late, or an old event landing after a newer read, never moves it back (review). No polling. The rail's server card shows it as a **This computer** line (labelled as this machine, not the connection, so it reads the same whatever server is connected — `localServerLine`; `starting` and `embedded`/`gateway` are achromatic, `occupied` warn, `failed` danger), and the connect card shows it when there is no server (occupied / failed), since there is no rail then; both follow a transition without reopening. An OPEN hover card re-reads its getter (`hoverCard.show(…, live)`), so it changes with the state too. The first stderr line is the start decision (`decision starting at …`); only `… (listening)` and a real listener prove the embedded server is up. `build:mac` is `tauri build --features embed-ui`. Tauri copies EVERY `[[bin]]` of the crate into `Contents/MacOS/` (`tmux-mobile`, `server`, `tmm`), so the app already carries `tmm`; `embed-ui` makes its gateway serve the web UI (`beforeBuildCommand` builds `dist/` first). A `bundle.externalBin` named `tmm` was tried and is wrong: the crate's own `tmm` bin overwrites it (measured on clawdbjs — the bundled file's hash was the bin's, not the sidecar's). Installation for users: [install.md](../../reference/install.md).
  Accepted on clawdbjs (macOS 27.0.1, arm64, 2026-10-09) with an ISOLATED variant: the same tree built with bundle id `com.tmuxmobile.test323` / product `TmuxMobileTest323` (its own WebView store, so the owner's saved `:9899` server was never seen), `XDG_CONFIG_HOME` passed explicitly to the binaries with `env -i` (never through Finder or `launchctl setenv`), port 19977 bound to 127.0.0.1, its own tmux socket. No gateway → `embedded … (listening)` and the APP pid held 19977; quit → port free. `Contents/MacOS/tmm gateway start --service` → the app said `gateway at ws://127.0.0.1:19977`, the only listener was the gateway's pid, the app held none; through `ssh -L` the gateway served the page (with the `tmm-gateway` marker), its hashed asset and a 101 WebSocket upgrade; quitting the app left the gateway answering. The owner's launchd agent (`cc.voka.tmux-mobile`, pid 79095, `*:9899`) and checkout were the same before and after. The release-id DMG was built but not launched (launching it would open the owner's WebView store).

## Server side — where each verb's design lives

`hub_*` RPCs in `src-tauri/src/server/hub_rpc.rs`, dispatched by prefix in
`connection.rs`. The room is `proj:<session>` in state.db's `hub_msgs`
(`projects/rooms.rs`, board #107); a room is implicit — it exists exactly when
it has messages. Mobile has no projects store, so every `hub_*` method answers
method-not-found there (`tmm` maps it to exit 4).

The rules behind each surface live next to their design, not here:

| surface | design doc |
|---|---|
| chat store, feed, paging, drafts, images | [hub-feed.md](hub-feed.md) |
| delivery, receipts, status derivation, vitals, activity log | [agent-status.md](agent-status.md) |
| recipients, `/commands`, the palette, interrupt | [hub-composer.md](hub-composer.md) |
| the task board (`hub_board_*`, `tmm board`) | [board.md](board.md) |
| spawn, isolated homes, registry, per-backend knowledge, AGENTS.md | [agents-overview.md](agents-overview.md) |
| project lifecycle, restart/resume | [projects.md](projects.md) |

## CLI/UI parity

Every agent and project verb is reachable from both the chat UI and `tmm` —
the CLI is not a subset (owner: "所有的 Agent 也可以通过 TMM 命令直接交互所有
的操作"), because an agent that can only be managed by a human cannot manage
a teammate:

| | CLI | UI |
|---|---|---|
| Agent | `tmm agent interrupt\|stop\|restart\|remove <name>` | roster card/context menu: Watch / Interrupt / Restart / Stop / Remove |
| Input mode | `tmm agent mode <name> queue\|steer` | kiro card context menu: Switch to Steer / Switch to Queue (#271) |
| CLI command | `tmm send "@name /compact"` (`@all` = everyone else) | composer: `@name /compact` (#274, one rule: `address::slash_command` ⇄ `slashCommand`) |
| Project | `tmm project up\|down\|archive\|delete <session>` | header: Open / Close / Delete (archive is the list's own action) |

`remove` is the eject button next to stop's pause button: it kills the window,
DROPS THE SLOT (so `up` never recreates it) and deletes the isolated home (so
`is_managed_in` stops recognising it). `delete` is archive's irreversible
sibling: it closes the session, removes every `<path>/.tmm/agents/<name>/` the
app created, and forgets the row (slots cascade; the Board's issues go with a
permanent delete, board #41). Two things both verbs leave alone on purpose:
**your files** — we only ever delete inside `.tmm/agents/` — and **the chat
history**, because the room is the record. In the chat UI, delete is a recycle
bin, not destruction (hub-feed.md); the raw CLI keeps the sharper verbs as-is.

## Verified

Against the live server: `project list` (6 projects, ● markers), `send` →
`log` roundtrip (message in `proj:tmux` with ts cursor working), `--output
json` on all reads. Dead server → exit 2 in 21ms; wrong token → exit 3.
Unit tests: derivation table (9 cases), hub dispatch (4 cases), all in
`cargo test --lib`.

`tmm task`, end to end against the real binary: a task started in the current
session reports `running`, then `exited:7` with the code from
`pane_dead_status`; `logs --limit 3` and `logs --grep error` both return
bounded, already-rendered text; `stop` on a process trapping INT and TERM
escalates and reports `killed:kill` with `exit_code: null`; `rm` on a running
task exits 5, `start` on a taken name exits 5, `status` on an unknown task
prints `missing` and exits 4. Scope: global `remain-on-exit` still `off`,
session-level unset, a sibling window still auto-closes. `-- printf %s|%s|%s
--release --limit -f` reached the command verbatim, proving flags after `--`
never touch the parser. With `TMUX`/`TMUX_PANE` unset the task lands in
`tmm-tasks` and stays fully operable from outside tmux. 13 unit tests cover the
pure helpers (quoting, row parsing incl. signal vs status, bounded tail, grep,
dead-marker strip, name validation, ages).
