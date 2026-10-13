# Agents v2 — CLI substrate, hooks telemetry, isolated homes, registry

The shape of the agent layer: what an agent SAYS goes through the `tmm` CLI, what we OBSERVE arrives through hooks, and every managed agent lives in an isolated home materialized from the registry. The CLI itself is documented in `tmm-cli.md`; the runtime status model in `agent-status.md`; the lifecycle in `agent-lifecycle.md`.

## Rules and their reasons

### Configuration drafts have one owner (2026-09-10, #156)

AgentsPage owns the Agent/Team/Skill/MCP/global-instruction working copy, the
save operation and the exit guard. `config-draft.ts` defines the payload and
fingerprint once; expanding a team member does not make it dirty, and nested
MCP data is not mistaken for UI state. Save freezes payload and editor identity,
rejects duplicates and retains failed edits. The Settings embedding host uses
the registered exit callback, not an independent dirty flag. Keyboard submission
uses the same Save and skips IME events. Global reads are generation-scoped even
when reopening the same document. These rules replace the independent unguarded
close/save handlers found by #154. Exact geometry, shared controls and the
pending/return contract live in [design-language.md](design-language.md).

### Deletion confirmation owns its failure (2026-09-12, #167 batch 1)

Deletion errors were already visible in the baseline: AgentsPage appended the
shared editor error to the confirmation's consequence note. This change gives
deletion its own error state and a separate modal `role="alert"`; it is not a
fix for hidden error text or for the already-correct busy Back behavior.

Agent, Team, Skill and MCP deletion keep their captured kind/name and editor
generation until the mutation settles. Pending is set before awaiting; duplicate
activation, Escape, backdrop and the existing registered Back callback cannot
dismiss it. A rejected deletion remains retryable with an `error` alert inside
ConfirmDialog, separate from its consequence note and the editor's save error.
The caller explicitly supplies `trash`; neutral Discard supplies `check` and
keeps the existing `configKeepEditing` translation.

Deletion success ends `removing` and closes only its own confirmation/editor
before refreshing the catalog. Refresh is not a pending deletion: a newer editor
can open while it runs, and its completion must not reset a newer deletion's
busy state. `AgentsPage.mount.test.ts` asserts the separate modal alert and
reproduces the refresh blocking a newer editor. A committed host section change clears
the old view's pending state; its late failure/finally cannot affect a new
confirmation. The tests also preserve the pre-existing busy
Back, failed-target retry, save and draft-exit behaviors. Source contracts pin
the explicit glyphs rather than inferring them from danger tone. These are
real Svelte client mounts with controlled RPC promises, not native Back or
layout/paint acceptance; no feedback timers change in this batch.
Verified with Node 22.23.2, Svelte 5.55.5, Vite 6.4.2 and jsdom 30.0.1.
Disconnecting the caller's `error` prop made the deletion-alert test fail;
restoring it passed. No shared file was changed for that negative control.

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Agents v2 — CLI substrate, hooks telemetry, isolated homes

the project hub (`hub_*` RPCs, `src-tauri/src/server/hub_rpc.rs`, room `proj:<session>` in state.db's `hub_msgs` — `projects/rooms.rs`, board #107) is the agent collaboration layer. What an agent sends proactively goes through the `tmm` CLI (`src-tauri/src/bin/tmm.rs`: send/log/spawn — fail-soft exit 2 in ~20ms, NEVER blocks); normal final responses and status arrive through hooks into `projects/telemetry.rs`. Status is DERIVED (`running | waiting | idle | failed`), never declared by an agent.

**`tmm task` is the one LOCAL subtree** (`src-tauri/src/tasks.rs`): background tasks as tmux windows with window-scoped `remain-on-exit`, so status + logs survive the command exiting. It opens no socket and is dispatched before `Config::load()` (which writes to config.toml) — because what an agent most often wants to background is the server itself. Retention is bounded (board #206): a finished window lives 30 minutes past `#{pane_dead_time}`, every `tmm task` verb reaps expired ones at its door, `stop` closes the window after printing the tail (`--keep` retains), and the skill prompt reserves tasks for long-running / asynchronous work — the foreground is the default (tmm-cli.md § Retention is bounded).

**MCP is NATIVE again, with kiro's toolSearch carrying the context cost** (owner 2026-08-28, reversing the same-day inspector-only design: "mcp 工具还是用原生的方式调用吧，给 kiro 的 mcp 工具开启 toolsearch"): registry MCP defs materialize into each backend's own config exactly as before (kiro `mcpServers`, claude mcp.json + `--strict-mcp-config`, codex `-c` overrides, grok toml, omp `mcp.json` in its isolated agent dir), and managed kiro homes get `toolSearch.enabled=true` + `minPct=0` + `minTokens=0` in `settings/cli.json` (canonical set `spawn::kiro_cli_settings`, backfilled by `refresh_hooks` on every start) so MCP schemas are ALWAYS deferred into a compact list and loaded on demand by kiro's own `tool_search` — the progressive behavior, natively.

**`tmm mcp servers|tools|schema|call|add` (the second local subtree, `src-tauri/src/mcp_cli.rs`) survives as a SKILL only** — `assets/skills/mcp-cli/SKILL.md`, an agent opts in via its skills list; build_prompt does NOT teach it (a spawn.rs test pins that).

**The skill store has BUILT-INS** (owner, 2026-08-28: "应该有一个默认的内置的skill…来源就是内置的"): `projects::BUILTIN_SKILLS` embeds `tmm-cli`, `mem` and `mcp-cli` (assets/skills/*, `include_str!`) into the binary and `seed_builtin_skills()` materializes them into the managed store at server start with `source = "builtin"` — refresh re-syncs FROM THE RUNNING BUILD, save/delete refuse the reserved names (a deleted built-in would silently resurrect at restart; the UI hides delete and locks the source field), and a test pins seed + guards + heal-on-refresh.

**ONE url installs whatever it contains** (`skills_import` / `tmm skills import`, owner same day: "输入一个url就能装上"): `discover_skills` walks the fetched tree for every dir holding a SKILL.md (claude plugins and marketplaces need no layout table), `fetch_git_full` clones once with sparse-checkout disabled, each imported row's source points at ITS OWN subdir so per-skill refresh works, names come from the skill's frontmatter, and built-in names are skipped; the UI routes a name-less new skill through the importer, and the skill editor previews EVERY managed file (`skills_files`/`skills_file` — 256 KB cap, text only, path escapes rejected).

**ONE url installs whatever it contains** (`skills_import` / `tmm skills import`, owner same day: "输入一个url就能装上"): `discover_skills` walks the fetched tree for every dir holding a SKILL.md (claude plugins and marketplaces need no layout table), `fetch_git_full` clones once with sparse-checkout disabled, each imported row's source points at ITS OWN subdir so per-skill refresh works, names come from the skill's frontmatter, and built-in names are skipped; the UI routes a name-less new skill through the importer, and the skill editor previews EVERY managed file (`skills_files`/`skills_file` — 256 KB cap, text only, path escapes rejected). Its niche: per-call config reads make `tmm mcp add` + call work with NO restart, uniformly on every backend (inspector CLI from `$TMM_MCP_CLI`, default prefers an installed `mcp-inspector` binary — `npx -y` re-resolution measured 12s/call). `seed_mcp_config` still seeds `<ws>/.tmm/mcp.json` (merge, agent edits win) + `$TMM_MCP_CONFIG` at spawn so the skill path always works; `tmm mcp list|save|delete` (registry catalog) stay RPC. Registry agents (`reg_agents`, state.db v5) materialize into ISOLATED homes `<ws>/.tmm/agents/<name>/` via KIRO_HOME/CODEX_HOME/claude --settings/PI_CODING_AGENT_DIR so user-space config never leaks in; any agent may spawn (the can_hire gate was retired 2026-09-26), capped 8/project (`SPAWN_CAP`), window name = agent identity. Two delivery truths: an interactive CLI only reacts to what lands in its INPUT (hub_post types @mentions into agent panes — never into shells, they would execute it; `tmux::send_command` sleeps 200 ms between the text and the Enter because a TUI that gets the burst back-to-back treats the Enter as paste content and parks the line unsubmitted — measured on codex 0.148.0; and before that Enter it looks for kiro-cli's `@` FILE PICKER — kiro's terminal UI (2.18.1) opens a fuzzy picker on any typed or pasted `@` and filters it with what follows, so in a workspace holding a file that fuzzy-matches the agent's name the picker is still open when Enter lands and Enter there SELECTS: `@kiro [board #10] …` became `@file:runtime/kirocrew-artifact.json` in kirocrew-agentcore (owner, 2026-09-03). `tmux::file_picker_open` recognises the picker by its own footer ("esc to cancel · ↵ to select" — BOTH halves, a running turn shows "(esc to cancel)" alone) in a fresh capture, and only then sends Escape first: with the picker open Escape reaches only the picker and leaves the line intact (measured across a 12-second streaming turn that ran to its end); without it Escape is kiro's cancel-agent key, which is why the footer check, not the backend, gates it), and it does nothing until spoken to — which is now the DESIGN, not a problem to work around: a spawn with no brief passes NO first prompt and the agent waits (an invented line reads in the chat as words the user typed, and a contentless prompt makes an agent reason about nothing). A brief is the exception because it IS something to consume: `first_prompt()` delivers it stamped like every later message, which is also how an agent learns the wall time (`build_prompt` says so; a replayed system prompt cannot carry a date).

**The prompt teaches the communication flow, not the full CLI.** Inbound
messages are stamped and queued. The final response is captured by hooks,
recorded in the room and returned once to each agent whose request the turn carried.
`[reply]` inputs create no reverse edge, preventing ping-pong. `tmm send
"@name …"` starts a new question or handoff; a recipient-less send is rejected,
except `--status` ambient progress. `tmm log` supplies room history, backlog
messages are consolidated, and unclear context is verified before action.
Board handoff and spawn fit in one line each; everything else stays in
`tmm --help` and the CLI skill.

**A Team agent receives the conversation delta with its next @mention.** A
`[tmm team context …]` block comes FIRST and the current stamped request
LAST (board #279, owner 2026-09-29 10:49: "把这个放在前面，然后把真正给 Agent
发送的最后的消息放到它的后面"), so the last thing the model reads is what it
must answer. The block contains non-noise room messages since that target's previous delivery as
`sender -> recipients: body`. Explicit mentions and new hook-captured final
replies persist their exact recipients in the room message's `to` field;
historical replies without that route are reconstructed from the senders
waiting on the agent. Status and lifecycle rows are omitted. This is Team-only
(`launch.json.team`); solo managed agents keep the original one-line delivery.
The delta is bounded to 40 recent messages / 12K characters from the newest
1000 room rows, says when older context was omitted, excludes archived messages,
and labels itself background rather than instructions. The order moved
nothing a reader depends on (the consumer audit is on #279). The receipt
matches the whole typed line, which is what was typed. The reply edge reads
`[tmm chat …]` lines wherever they sit, and context rows never start one.
A held batch (#257) keeps each context right before its own line. The
activity log SHOWS the prompt ask first, because its 1024-char display cut
would otherwise keep only the context. That order comes from the producer,
never from reading the echo (orchestrator 2026-09-29 13:24):
`address::context_first` returns the typed text and `ask_at`, the byte where
the stamped line starts in it, and the delivery row keeps that offset
(`deliveries.ask_at`, schema v30; 0 when nothing leads the line). The receipt
matcher (`settled_by`) also returns WHERE in the echo it found each settled
row, mapped from its whitespace-free match back to the echo's own bytes, and
the stored text replaces each Team row's span in place with its
`address::shown` form (its line, then its context). Every byte outside those
spans (a person's words typed around our line, the break between held lines)
stays as it was, in order (orchestrator 14:03: no display loss). An echo that
settled nothing (a person typing, a pasted context block) is stored raw. An integer, not a display-text column: it duplicates no text and cannot
disagree with the `line` it splits; an offset that does not split it shows
the line as typed.

### Every agent lives in a tmux server somebody forked — two incidents and one near miss in a day (2026-10-12)

A managed agent is a pane in a tmux server, and that server belongs to whatever forked it: the user's shell, or our gateway running `tmm project up`. Twice in one day every session on the dev host was lost, and a third way was found before it fired — each by a different hand, each because something was allowed to act on a tmux server it did not create:

1. **05:51** — the Rust test suite, run in parallel, issued `kill-server` through a process-global socket another test had reset, and hit the default server (board #349).
2. **07:12** — a negative control on that fix put the bug back on purpose and ran in a developer's real shell, where `$TMUX` pointed at the real server (board #349).
3. **08:02, found before it fired** — the owner's tmux server sat INSIDE `tmux-mobile-dev.service`'s cgroup, forked there by the gateway, and only a hand-made `KillMode=none` drop-in kept `systemctl --user stop` from killing it; the gateway unit that replaced the dev unit forks tmux the same way and is restarted after every merge, with systemd's default `KillMode=control-group` (board #350).

The rules that came out of them, each in its own doc: tests reach tmux only through a socket they named, inside an isolated `TMUX_TMPDIR`, serially (testing.md); the gateway unit renders `KillMode=process` so a restart signals the gateway alone, the protection is applied to a running unit in place by `daemon-reload` and read back from the manager before any stop, and every stop or restart of a running unit of ours is refused until the manager reports it (tmm-cli.md § The gateway). The common shape, for the next mechanism that touches tmux: name the server you mean, and never let a restart or a stop of OUR process be a stop of the servers it happened to fork.

### Registry defaults are exactly the six backend-native agents

`kiro`, `codex`, `claude`, `grok`, `omp`, `kimi` — six backend-native defaults (the Manager flag they once carried was retired 2026-09-26; spawning is every agent's ability) with built-in `tmm-cli`/`mem`/`mcp-cli`. All keep the terse 10x-developer sentence; Kiro adds only one short Git rule: code changes use a dedicated worktree instead of the launch checkout, preserve the user's Git author, and add the exact `Co-authored-by: Kiro Agent <244629292+kiro-agent@users.noreply.github.com>` trailer. `reg_seed` upgrades only either known former Kiro default (the original terse sentence or the first verbose Git version), preserving every other field; a custom persona is never overwritten. The `claude` seed pins `global.anthropic.claude-fable-5-1[1m]` (owner, 2026-09-02) and the `omp` seed pins `bedrock-extra/global.anthropic.claude-fable-5-1` (owner, 2026-09-07 — the provider the user's `models.yml` declares, carried into every isolated omp home; a machine without it degrades soft to omp's own default) while kiro/codex/grok/kimi leave the model empty (= backend default; for kimi that is the user's own `default_model`, carried into the home — see the kimi section); Kiro and OMP use their built-in search (omp ships a native `web_search` tool) and the other four seed pinned `kiro-web-search==0.1.3` inline (the local registry may replace it with its secret-bearing central def). `reg_list` fixes those names in that order before alphabetizing custom agents, so AgentsPage, spawn pickers and CLI all agree. Retired `docs`/`reviewer`, `*-default`, and `cc_builder` must not return as seeds or examples.

### Managed agent launch PATH is part of the recipe

the supervised server can have a service-only PATH even when the user's CLIs are correctly installed under `~/.local/bin`/`~/bin`/`~/.cargo/bin`/`~/.kimi-code/bin` (Kimi Code's installer puts its one binary in the last, board #224). Both project-agent and Team launchers prepend those standard user bins (plus the colocated `tmm` dir for project agents), dedupe, and persist the result; otherwise a Claude home can be perfectly rendered yet its pane only says `command not found: claude`, and restart faithfully repeats the failure. Claude's provider channel is the `env` object from `~/.claude/settings.json`: projects and Team copy only that object into their explicit/isolated settings so Bedrock switch, region and model pins carry while plugins/preferences do not. Empty Claude model means that inherited `ANTHROPIC_MODEL`, never a hardcoded `--model sonnet`. Supported Claude PRIMARY pins use the literal `[1m]` suffix (global Sonnet 4.6, `cc_builder` Fable 5.1); it MUST pass through `shell::quote` because bare `[1m]` is a zsh glob. Haiku 4.5 stays unsuffixed because it is not on Anthropic's Bedrock 1M list.

**Codex's startup screens are answered on the launch line, never in the user's config** (board #184, owner 2026-09-12: "codex 启动会有提示是否升级，这个也要屏蔽掉，以及 codex 有可能还会有是否信任当前文件夹目录"). A managed pane is unattended, and codex 0.154.0 opens with up to two y/N screens: "Update available! … Update now" and "Do you trust the contents of this directory?". The isolated `CODEX_HOME/config.toml` is a symlink into the user's own, so the answers ride `-c` overrides in `render_codex` (the same door as model effort and MCP): `check_for_update_on_startup=false` (documented: "Check for Codex updates on startup") and `projects.<workspace>.trust_level="trusted"` — measured with an isolated home in an untrusted git dir: the override with the path UNQUOTED removes the trust screen and writes nothing back to config.toml, while a quoted segment is not honoured (`-c` keys are split on dots and quotes stay literal), so `codex_trust_key` yields no key for a path containing a dot and that workspace keeps the pane watcher (`StartupConfirmation`, `CODEX_FOLDER_TRUST_MARKERS`) as its answer — the watcher stays on every codex launch as the fallback. The update screen was not reproduced (0.154.0 is npm's latest); its key is the documented one. `Backend::render` already carried `workspace` for claude's trust pre-seeding; codex now reads it too.

**Managed Claude trust is per explicit workspace, never global**: `ensure_claude_state` merges Claude's documented `projects[repo_root].hasTrustDialogAccepted=true` into the isolated `.claude.json` before launch/restart, preserving all other state and mode 0600; the Down→Enter prompt confirmer is fallback only. On this host Bedrock has no built-in WebSearch, so local Claude defaults carry pinned `kiro-web-search==0.1.3` native MCP; its `KIRO_API_KEY` remains private local config/state and never enters the repo.

### The omp backend: one relocatable agent directory (2026-09-07)

omp (oh-my-pi, the `omp` CLI) keeps its ENTIRE state — auth store
(`agent.db`, the `auth_credentials` table), `config.yml`, `mcp.json`,
sessions, extensions — in one directory that `PI_CODING_AGENT_DIR`
relocates (its settings docs; verified live on omp 18.0.6). So
`render_omp` needs no per-file plumbing: the isolated home IS that
directory. Four decisions, each measured rather than guessed:

* **Auth carries as `agent.db`, the model catalog as `models.yml`** — the
  grok lessons (auth.json, config.toml catalog): an isolated home without
  the credential store is a logged-out agent, and one without the user's
  `models.yml` cannot resolve a registry model that lives there. On this
  host that file declares the Bedrock trio under `bedrock-extra`
  (fable-5-1 / opus-5 / gpt-5.6-sol — the bundled catalog lacks Fable 5.1,
  and its own gpt-5.6 entries 400 on Bedrock because the converse-stream
  transport sends the Anthropic `thinking` block to reasoning-marked
  models, measured 2026-09-07; the gpt entry is `reasoning: false` for
  exactly that reason). Env-keyed providers (Bedrock bearer tokens) need
  nothing and lose nothing. UI prefs and hooks deliberately do NOT carry.
* **The prompt is APPENDED, never replaced** — `--append-system-prompt
  <home>/system-prompt.md` (a file path; verified the contents reach the
  prompt). omp's builtin prompt teaches its own tool harness (hashline
  edits, LSP, subagents); `--system-prompt` would lobotomize the tools.
  Model → `config.yml` `modelRoles.default` (identity in config, kiro's
  lesson); effort → `--thinking`; approvals → `--auto-approve`.
  `OMP_SKIP_SETUP=1` rides the launch env: a fresh home has no
  `setupVersion`, and omp 18.2.10 then opens its provider-setup wizard,
  where every typed line and `/command` lands (#243, measured 2026-09-27:
  a fresh home without it shows "Setup step 1 of 5", with it the prompt).
  Auth already carries, so the wizard has nothing to add.
  `config.yml` and `mcp.json` are files the render OWNS
  (`shared::write_owned`): an unpinned model or an empty MCP set REMOVES
  the file on the next spawn. Skipping the write kept the previous render's
  file, so a restarted omp stayed on the old model and kept loading a
  revoked server (#241, validator, 2026-09-27; kimi's `mcp.json` likewise).
* **Telemetry is a generated TS extension**, `<home>/extensions/
  tmm-telemetry.ts` (omp auto-loads that directory), emitting CLAUDE-shaped
  payloads to the notify helper so the normalizer needs no third dialect —
  only the `omp` backend arm. The prompt is read from the first `context`
  event after `agent_start`, because at `agent_start` the user message is
  not yet in the session branch (measured); `agent_end` with `willContinue`
  is an auto-continuation, not a completion. `refresh_hooks` rewrites the
  whole file when this build's text differs.
* **Resume is cwd-scoped by construction** — sessions live per encoded cwd
  under the isolated dir, so `--continue` (breadcrumb, then newest session
  of THIS cwd) cannot cross projects; an exact id uses `--resume <id>`.
  Detection matches a process's program NAME exactly against the
  backend's `programs` (`agents::detect_processes`, board #260; the client
  reads the server's verdict and has no matcher): "omp" lives inside
  docker-compose and "kiro" inside kiro-web-search, and substring or word
  matches painted plain shells as agents.

### The app-wide instructions lead every prompt (2026-09-04)

An isolated home never reads the user's own `~/.claude/CLAUDE.md` /
`~/.codex/AGENTS.md` / kiro global config — by design — so the software
carries its own: `<config>/AGENTS.md` (`projects/global_prompt.rs`) is the
FIRST block `spawn::build_prompt` writes, before the agent's persona, on every
backend. Edited on the Agents page (the first row, "Instructions for every
agent") or with `tmm prompt show|path|set|clear` (`global_prompt_get/set`);
read at spawn, so a running agent picks a change up on restart. Full rules:
the entry above (the long-form history lived in tmm-cli.md until board #102).

### The input mode is a definition field, offered only where it was measured (board #245, 2026-09-27)

A line typed at a BUSY agent either waits for the turn to end and becomes the next prompt (**queue**) or goes into the running turn (**steer**). `reg_agents.input_mode` (v25, `queue` default for every agent, existing ones included; owner 2026-08-20 for kiro, 2026-09-27 for the choice) sits next to model and effort, and each backend file renders it into its own config at spawn and on restart (`refresh_agent`); the repair path on `project up` has no definition, so it keeps a valid value and only backfills `queue`. `Backend::switches_input_mode` names where the choice exists; `backends_list` carries it as `input_modes`, the Agents editor shows the Select only there (with a hint when steer is chosen), and `registry_save` refuses `steer` elsewhere. The editor never rewrites a saved mode from the capability list (validator, #245): the list arrives on connect and may be missing, so the payload saves the draft's mode as it is, a saved `steer` keeps its field visible, a late list re-renders an open editor (`onServedBackends`), and only an explicit backend pick to one the list says cannot switch resets a steer draft to queue. The list itself is fetched by `serverReady()`, the ONE handshake every connect path in `App.svelte` runs (boot with a saved token, reconnect, manual connect): at 1.0 the boot path called `probeHub` alone, so on the live app the field never appeared while the mount tests, which serve the list directly, passed (board #253; pinned by `App.source.test.ts` "every connect path runs the one server handshake…"). A team's BARE member is a complete definition too, so its editor renders the same field and hint (one snippet, `inputModeField`/`inputModeHint`); a member derived from a registry agent inherits the base's mode by default and, since #254 (owner 2026-09-28: "team 内的 agent … 应该需要能单独配置"), may override it like model/effort: `teams::Member.input_mode` (`''` = inherit; additive in the members JSON, so no migration), the same field with a "same as base (<mode>)" option, shown only where the BASE's backend switches, validated by `teams_save` against the base's backend, and applied by `effective_def` at spawn and on restart. Pinned by `a_team_member_input_mode_override_renders_on_restart_and_empty_inherits` and the AgentsPage mount test "a member derived from a registry agent overrides…". CLI parity: `tmm registry save --input-mode queue|steer`.

Queue is the only mode that keeps "one delivered line → one prompt hook → one turn → one reply to its sender". A backend is offered the choice only when BOTH halves were measured on this host: the switch is a documented config door, and in queue the delivered line comes back through the hook as its own turn. Probe (scratch project, managed agents through the live server): sender A asks for `sleep 45; echo tick` then a word, sender B's line is typed 15 s later while the tool runs.

| backend (version) | door | queue | steer | offered |
|---|---|---|---|---|
| kiro (kiro-cli 2.22.1) | `settings/cli.json` `chat.defaultInterruptBehavior` | own turn after A's, hook ack, reply to B | no `userPromptSubmit`; B answered by `tmm send` mid-turn; owed no echo, never swept `unconfirmed` (#276) | yes |
| codex (codex-cli 0.154.0) | launch-line `-c tui.keymap.composer.queue` / `composer.submit`: queue = `"enter"`/`"tab"`, steer = `"tab"`/`"enter"`, codex's defaults pinned so a remap in the user's `config.toml` (symlinked into the home, so every codex key is a `-c`) cannot override the definition (validator, #245; measured: with the user file set to queue, the steer pin still steered) | own turn after A's, hook ack, reply to B; idle Enter and slash commands still submit at once | CLI default: B's hook fired inside A's turn, the one Stop answered B, **A never got a reply** | yes |
| claude (2.1.283) | `<home>/keybindings.json` `chat:queueSubmit` (read under `CLAUDE_CONFIG_DIR`) | none exists: with or without the binding B's hook fires at typing time and B is folded into A's turn at the tool boundary; one Stop | CLI default | no |
| omp (18.2.10) | `<home>/keybindings.yml` `app.message.followUp: enter` | queues in the pane, but a follow-up continues the run with no `agent_start`, so our extension reports no prompt: swept `unconfirmed`, and the one Stop replied to A with B's answer | CLI default | no |
| kimi (2.0.2) | none (`tui.toml` has no key) | always: own turn, hook ack, reply to B | — | no |
| grok (1.0.13 and 1.0.41) | documented `[ui] follow_up_behavior` (default queue) | unmeasured: no managed grok turn completes here (Bedrock 400, board #252) | unmeasured | no |

The setting is the PANE's behaviour, not only ours (orchestrator, #245): a person who takes over the pane gets the same Enter. On a queued codex, Enter while it works queues and Tab now steers (the swap keeps a steer key); on kiro, the mode is also the one its footer shows, and Ctrl+S still toggles it for the session.

**The mode a session RUNS is read off its pane (board #271, 2026-09-29, kiro-cli 2.22.1 `--agent-engine v3`).** The registry's `input_mode` is the START mode only: Ctrl+S toggles kiro live, idle or mid-turn, for that session; it never rewrites `settings/cli.json`, and a restart (a new window, a new pane) starts from the configured mode again. Measured: a fresh spawn with `queue` shows `›  Kiro is working · Type to queue · Ctrl+S to steer` on its first busy turn (so v3 honours `chat.defaultInterruptBehavior`); each Ctrl+S paints one column-zero `● Switched to Steer mode` / `● Switched to Queue mode` (kiro keeps only the newest) and flips the busy footer at once; idle kiro paints no mode. The three live kiros that showed `Type to steer` with `queue` configured had been switched in the pane. One reading, in the kiro backend file (`kiro::live_input_mode`, both shapes matched whole so a quoted copy under a chat stamp or a tool head never counts; the confirmation outranks the footer).

**Both painted shapes drift between kiro builds, and each one alone breaks the toggle (board #346, 2026-10-12, kiro-cli 2.28.0).** Owner: "切 kiro steer 的时候，老是报错 the pane did not confirm steer mode，但是其实 terminal 里已经出现 type to steer 和 switched to steer mode 了". Both matchers had been written as one fixed prefix, and both prefixes were gone: the toast's bullet is now `•` (U+2022) where 2.22.1 painted `●` (U+25CF), and the busy footer carries an elapsed segment the old prefix did not allow for. So `switch_input_mode` pressed Ctrl+S, read a pane that had switched, recognised nothing for 3 s and failed — busy or idle. Measured on this host with `tmux capture-pane -p -J -S -0 | cat -A`:

| what | kiro-cli 2.28.0 | kiro-cli 2.22.1 |
|---|---|---|
| Ctrl+S confirmation | `• Switched to Steer mode` / `• Switched to Queue mode` | `● Switched to …` |
| busy footer, steer | `›  Kiro is working · 1m 27s · Type to steer · Ctrl+S to queue` | `›  Kiro is working · Type to steer · Ctrl+S to queue` |
| busy footer, queue | `›  Kiro is working · 19s · Type to queue · Ctrl+S to steer` | ` Kiro is working · Type to queue · Ctrl+S to steer` (no stamp) |
| queue backlog | ` ◇ 1 message queued · ctrl+x expand` | — |
| idle | `›  ask a question or describe a task ↵` (no mode) | same |

Each shape is therefore matched by its own STRUCTURE, not by a prefix: the confirmation is a column-zero line of one bullet GLYPH from a NAMED set (`TOAST_BULLETS`: the two measured ones plus four of kiro's own bullet family) followed by exactly `Switched to <Mode> mode`, so a minor repaint is not another outage while a glyph outside the set is a miss we can see and name; the footer must still BE the footer (`Kiro is working` at column zero after the stamp, or after one optional space on older builds) and its hints are read as SEGMENTS between ` · ` — the word after `Type to ` is the mode it is in, the word after `Ctrl+S to ` the other. What that keeps out is the point of matching by shape at all: an indented copy under a chat stamp or a tool head, anything a person or a delivery can start a line with (kiro's own input stamp `›`, a quote marker, a dash), a line that merely mentions steer, the queue backlog count (`queued` is not a mode), and a footer that offers the mode it is already in. The fixtures in `backends/kiro.rs` carry both builds' bytes with the version beside them; a pane captured in `temp/` is not evidence a future reader can check. One derivation, `delivery::input_mode_seen`: that reading, else the last reading in the SAME pane (idle kiro says nothing), else the recipe's start mode. #257's holding and #276's steered lines (`delivery::deliver_with`) and the card (`hub_agents.input_mode`, the hover row "input") both use it, so a Ctrl+S pressed in the terminal is followed. The switch is the CLI's own key: `hub_agent_input_mode` / `tmm agent mode <name> queue|steer` / the kiro card's menu item "Switch to Steer|Queue" (a bare label: its hint line was removed, owner #272 "后边的小字不要了吧，看着不好看"; that the switch lasts this session only and that steer gets no delivered check are said here and in the room line) send the named key `C-s` once, only when the pane is not already in the asked mode, and succeed only after the pane shows the new mode (never a blind second press), all under the window's delivery lock and then the pane's send lock — the lock #257 reads the mode under, so no delivery is decided between the key and the confirmation; the room records `[tmm] switched <agent> — <mode> mode (this session)`, a lifecycle row with its own verb `switched` (accent) — without a verb the rows rendered as bare text under a neighbouring `spawned` row and read as part of the spawn (validator 04:39). Offered where a live toggle was measured (`Backend::live_input_toggle`, `backends_list.input_mode_toggle`): kiro only — codex's mode is a launch-line keymap. The declaration stays single (orchestrator 03:58): the switch never writes `launch.json`, `cli.json` or the registry. Steer's known limit: a line sent to a BUSY steering kiro fires no hook, so it gets no delivered check. Since board #276 it is also owed none: it is typed with no pending row and is never swept `unconfirmed` (agent-status.md). The known limit is in `docs/todo.md`: a line sent to a busy claude or omp still joins the running turn, so its reply can go to the wrong sender.

### A managed agent's MODEL lives in its config, never on the launch line

`render_kiro` writes `"model": <id>` into `.tmm/agents/<name>/agents/<name>.json` (a real field of kiro's agent schema) and the line carries only `--agent`. Reason: kiro-cli's TUI answers an unknown `--model` with a warning above the splash and then runs its DEFAULT model, so `claude-sonnet-4-5` (one character off `claude-sonnet-4.5`) produced an agent answering happily on the wrong model, with the id invisible in the config the owner reads (owner report, 2026-08-19; in `--no-interactive` the same flag is a hard error, which is why no script ever caught it). In the config a bad id is reported as a real error on the first turn instead, and every start path (`up`, restart, `--resume-id`) reads it because they all pass `--agent` — the pre-recipe backfill in `refresh_hooks` used to drop the model entirely on restart. An empty model omits the key (= the BACKEND default, which is what the editor's placeholder promises; the old line pinned a hardcoded `claude-sonnet-4.6`). `projects::models` asks `kiro-cli chat --list-models -f json` (cached 10 min, never hardcoded — ids change weekly) and `registry_save` + `spawn` reject an unknown id listing the valid ones; `models_list` feeds the editor a datalist.

**Reasoning effort is the same kind of identity field** (`reg_agents.effort`, v11; owner 2026-08-22): empty = backend default; the levels are a FIXED measured enum per backend (`models::effort_values` — kiro/claude low..max, grok low..xhigh, codex minimal..xhigh, omp off..auto) so the editor offers a Select and bad values are rejected at save; delivery is each backend's own knob — `--effort` on the launch line for kiro/claude/grok (recipe replays it), `-c model_reasoning_effort=…` for codex, `--thinking` for omp (its own enum, off..auto). `refresh_hooks` migrates a `--model` off an old recipe into the config, but DROPS an id the backend rejects — it was never the running model, so carrying the typo forward would mute a working agent. Everything degrades soft: no CLI/login/parse means "cannot know" and the id is accepted; claude takes unenumerable aliases and stays free text. codex is free text only WITHOUT a catalog: when the user's `~/.codex/config.toml` names a `model_catalog_json`, its `models[].slug` values are the authoritative list (board #231, measured on 0.154.0 against the bedrock-runtime endpoint — every `global.`/`us.`-prefixed catalog slug answers, while the bare `gpt-5.6-sol` spelling is refused with `validation_error: The provided model identifier is invalid`; that failing spelling must not survive a save).

### One definition of "an agent this app created"

`projects::managed_home` / `is_managed_in` — the isolated home `<ws>/.tmm/agents/<window_name>/` that `spawn` materialized, never the window name (a hand-started window can share it). **The marker is what spawn WROTE, not the directory existing** (board #112, 2026-09-09): `home_is_managed` requires `launch.json` (every backend writes it before the window exists) or the pre-recipe kiro `agents/<name>.json` (refresh_hooks backfills the recipe only at the NEXT start, and a continuously-running old agent must not be demoted meanwhile). The directory alone re-armed the gate: `agent_remove` deletes the home while the kiro process keeps running with `KIRO_HOME` in its env, and its next write re-created `settings/`/`sessions/` (observed 2026-08-19, `.tmm/agents/builder/` back with no config and no recipe) — so auto-post and `@all` delivery resumed for a window the user had ejected. No CLI re-creates either marker file. THREE gates share that one function and must never re-implement it: chat participants (`hub_agents`), stop-hook auto-post (`maybe_auto_post`), and pane delivery (`deliver_mentions` — without it `@all` types into a kiro the user started by hand). Measured on kiro-cli 2.16.2: the user-space install is close to inert anyway — `~/.kiro/hooks/tmux-mobile.json` is not read, and `kiro_default` is a BUILT-IN name, so a materialized `~/.kiro/agents/kiro_default.json` is shadowed (its hooks never fire; the same file renamed fires immediately). Managed agents work because their config is a *named* agent inside an isolated `KIRO_HOME`. Do not rely on the global path for observation. The kiro launch env is ONE definition, `backends::kiro::kiro_launch_env` (spawn recipe and the launch.json backfill alike): `KIRO_HOME` plus `KIRO_SKIP_MIDWAY_CHECK=1` (board #183, owner 2026-09-12: "kiro 启动 agent 会报提示…跳过这个提示，避免启动被阻塞住") — a managed pane is unattended, and kiro-cli's launch-time "Your Midway session has expired or is missing. Refresh it now with mwinit? [y/N]" parked the agent until a human typed; kiro-cli 2.21.4 reads that switch beside the prompt (`crates/chat-cli/src/launch/midway.rs`; no flag or setting exists), and skipping the check leaves kiro's own login untouched — Midway gates only internal endpoints. Existing agents pick the variable up when their recipe is next rendered (a spawn or a backfilled `launch.json`); a recipe already written replays as it was. Not reproduced on this host (the owner's cookie was fresh; a fake `HOME` and a fake `mcscli` did not trigger the check) — the prompt's disappearance is the owner's acceptance.

**An agent name is a plain word, checked once** (`agents::valid_name`, 2026-09-03 review): letters and digits of any script, `-` and `_`, starting with a letter or digit, at most 64 characters. The rule is the intersection of the four parsers the name passes through — a directory component under `.tmm/agents/` (so no `/`, `\`, `.`, `..`), a tmux window name that also lands inside targets (`session:name.pane` — so no `:` `.` `=` and no glob characters), a CLI argument (so no leading `-`), and an `@address` (so no whitespace or `@`). It is enforced where a name ENTERS: `registry_save`, `teams::validate` (team and member names), `spawn` (the final window name), `agent_remove`; and every `<ws>/.tmm/agents/<name>` path is built by `agents::home_dir`, which returns `None` for a name that fails — so `managed_home`, `is_managed_in`, `agents::detect_pane`, `spawned_by`, `team_of` and `refresh_hooks` all answer "not managed" for such a window. The case that made this a rule: `agent_remove("../..")` resolved to `<ws>/.tmm/agents/../..` — the workspace itself, which `is_dir()` — and `remove_dir_all` would have deleted the project. A whitelist, not a blacklist of separators, so the next parser that reads a name is covered too.

**The launch recipe is written before the window exists, and its write is a spawn error** (2026-09-03 review). `launch.json` is what makes a window ours on restart — `agents::detect_pane` reads the backend off it, `relaunch_line` replays it — and it used to be written last with its error dropped, so a full disk or a permissions slip produced a live agent whose restart took the generic launch path and came back deaf (the very regression the recipe was introduced to end). Record, then act: `spawn` writes the recipe after the env is final and before `ensure_session`/`new_named_window`, so a failed write leaves nothing running. The pre-recipe kiro backfill in `refresh_hooks` stays best-effort, because there the agent is already running either way.

**Restart means "come back up to date"** (owner, 2026-09-08: "现在我直接重启那个会话里的 agent 就可以生效了吗" — and the honest answer was no: the recipe replay is verbatim, so a restarted agent kept its spawn-time prompt forever, contradicting what global_prompt.rs promised). `hub_agent_restart` now calls `spawn::refresh_agent` before the replay: `materialize` — the factored-out disk half of `spawn` (prompt, backend config, skills, MCP seed, hooks, recipe) — runs again from the CURRENT registry def and app-wide AGENTS.md, preserving `spawned_by` provenance and `team`, and dropping the original brief (the conversation is resumed; the brief is history). **The def is resolved through the recipe's PROVENANCE, so uniquified windows and team members refresh too** (board #113, 2026-09-09): `refresh_agent` used to look the def up by WINDOW NAME, so `lead-2`, every team member and anything renamed kept replaying its spawn-time snapshot forever. `launch.json` now records `agent_def` (the registry def name behind a solo spawn) or `member` beside the existing `team` path — in the recipe, not a slots column: the recipe is the declaration, one place (tenet 7) — and refresh resolves through them: a team member re-derives its effective def from the CURRENT team via `teams::effective_def`, with the roster reconstructed from the sibling recipes in the workspace (the recipes ARE the declaration of which window carries which member; a sibling without one falls back to its member name, exactly the name spawn would have used). A def or team deleted after the spawn degrades soft — the spawn-time materials keep working, logged once per window — and pre-#113 recipes keep the old window-name lookup.

**A relaunch line is sourced, never burst, and every prompt is a file** (owner, 2026-09-08: "codex 重启好像有点问题…能类似 kiro 那样一个文件注入吗", then "类似的 Claude omp grok 是不是也是这种文件形式的"). Two halves of one incident: codex's prompt rode the launch line as a ~6 KB `-c developer_instructions=…` override, and the restart replay (`reconcile::run_slot_command`) typed that line with send-keys — tty shims mangle bursts ≳2KB (team/launch.rs), so the pane filled with prompt fragments. Now (a) every backend takes the prompt as a FILE in its isolated home: kiro's agent-config `prompt`, codex's `CODEX_HOME/AGENTS.md` (its native global-instructions file — ours to write because the home is isolated; config.toml there is a SYMLINK into the user's real home and must never carry our text), claude's `CLAUDE.md` in the isolated CLAUDE_CONFIG_DIR (verified live: a relocated dir's CLAUDE.md is read and obeyed), grok's `agents/<name>.md`, omp's `--append-system-prompt <file path>` — with tests pinning the codex and claude launch lines under 2 000 bytes; and (b) managed agent relaunches stage the line as a script in the agent's home and source it (`stage_relaunch_script`), exactly like spawn. Windows without an isolated home keep the direct send: their generic launch lines are short.

**Restart touches ONE agent** (owner, 2026-09-20: "对于已经停止的 agent，我 resume 的时候好像把当前 project 所有的已停止的 agent 都 resume 了", board #210). `hub_agent_restart` used to relaunch through the project-wide `projects::up`, which by design brings up EVERY missing settled slot — so restarting one stopped agent silently resumed every other stopped agent in the project. It now calls `projects::up_agent(project, window_name)`, which runs `reconcile::create_or_keep` for that slot alone: the same code `up` runs per slot (slot cwd, hooks refresh, `relaunch_line` with the slot's exact `agent_session_id`, staged script), so a targeted restart still resumes the exact conversation rather than a degraded `--resume`. `up_agent` does not stamp `last_up_at` (it is not a project `up`). When the slot is not in the store yet (a window younger than the capture loop's settle rule) or its window cannot be created, the fallback is unchanged: a single `spawn { resume: true }` of that one agent. The project-wide `up` remains the verb for restoring a whole workspace (`tmm project up`, autostart). Test: `up_agent_restarts_only_the_named_agent_with_its_exact_conversation` — two stopped agent slots, restart one, the other's window must still not exist.

### The spawn cap counts MANAGED agents only (board #126, 2026-09-09)

`SPAWN_CAP` (8/project) is fan-out control — how many agents the app will run at once for one project (tmm-cli.md: a resource gate, not security) — but it was checked against every window the pane sniff called an agent, hand-started ones included: a project with a few plain windows refused a hire it had room for. `managed_window_count` counts through the ONE definition of ours (`is_managed_in` / `home_is_managed`, #112), both at `spawn` and at `spawn_team` (whose expansion still counts its LEAVES against the same cap). Shells and adopted agents are the user's business, not the cap's.

### Backend knowledge lives in one file per backend, behind one enum (board #101, 2026-09-09)

Six CLIs genuinely differ — configuration, hook dialect, status line, resume flags — and the owner's ruling is that the differences are legitimate; the defect was their ownership. On 2026-09-07 adding omp touched twelve `match`/`if` branches and still missed `registry_save`'s allowlist: the render arm existed while the validator said "must be kiro|claude|codex|grok". So `src-tauri/src/backends/` holds ONE file per backend (`kiro.rs`, `claude.rs`, `codex.rs`, `grok.rs`, `omp.rs`) — its renderer, hook set, refresh probe, resume dialect, sniff, effort values, model listing, `KNOWN` row and hook-payload reading — and `mod.rs` holds `enum Backend`, whose every per-concern method is an EXHAUSTIVE `match` with one-line arms into those files. An enum, not a trait object, on purpose: the set is closed, and a missing arm is a compile error that lists exactly the file the new backend must fill. The `backend` field stays a STRING at rest (state.db, `launch.json`, the wire); `Backend::parse` runs once at each boundary (`registry_save`, `materialize`, the inbox consumer), so an unknown name is rejected at the door with the same message as before. `backends/` is an UNGATED leaf like `shell.rs`: the enum and the payload dialects compile for the phone (`agent_notifications` consumes the same envelopes there), and every item that reaches `crate::projects` or `chrono` carries its own desktop `cfg` — the guard `projects_readers_are_desktop_gated` walks these files. Shared launch knowledge more than one backend reads (`Rendered`, `effort_flag`, prompt assembly, MCP seeding, the recipe writer) stays in `spawn.rs`; shared sniff helpers stay in `vitals.rs`.

Two source tests make tenet 2 ("adding a backend touches one file") a failing build rather than a review comment: `backends::tests::backend_literals_live_only_in_backends` rejects a quoted backend name anywhere else in `src-tauri/src` (exempt: tests, the `store.rs` seed region fenced by `// backend-seeds:begin/end` — a seed is registry data — and a statement introduced by `// backend-quirk(measured): …`, the marker for the owner-accepted, measured adaptations generic code has to keep: tmux.rs's codex 200 ms beat and kiro `@` picker gate; marker comments, never line numbers), and `core/backends.source.test.ts` rejects a hand-written backend array on the client, whose list comes from the server (`backends_list`, #130). Detection stays wider than spawning (openclaw is recognised in panes, never spawned; kimi was such a row until board #224 made it a backend) as a detection-only row in `agents.rs` and the client's pane regexes, an accepted mirror that names its Rust source. Two hand lists the literal guard could not see were caught by kimi and derived since: the notify helper's shell `case` allowlist (now `Backend::NAMES`) and `tmm --help`'s `<kiro|claude|…>` placeholders (now `SPAWNABLE_BACKENDS`). Proof standard for each move: the existing test corpus untouched and, for the renderers, the same five definitions materialized on both revisions byte-identical (#128).

### A CLI's painted shape is matched by its structure, never by a fixed prefix (board #346, 2026-10-12)

`kiro::live_input_mode` read the pane with two `strip_prefix` calls, and kiro-cli 2.28.0 invalidated both at once: the Ctrl+S confirmation's bullet changed glyph (`●` → `•`) and the busy footer gained an elapsed segment. Both evidence paths went blind, so `switch_input_mode` pressed the key, watched a pane that HAD switched, and failed after 3 s with "the pane did not confirm steer mode" — the frontend then believed one mode while the pane ran the other, which is what the owner hit while agents were working.

A fixed prefix asserts every byte before the part that matters, so any repaint breaks it, and it breaks it SILENTLY: the matcher returns `None`, which is also what an idle pane legitimately returns. So a painted line is matched by the structure that carries the meaning — for the confirmation, a column-zero line of one bullet glyph from a named set plus exactly `Switched to <Mode> mode`; for the footer, the label at column zero and then the words after `· Type to ` and `· Ctrl+S to ` read as segments. The boundaries that keep the reading honest are kept as deliberately: column zero (an indented copy under a chat stamp or a tool head is someone quoting us), a closed bullet set rather than "any glyph" (the stamps `›`/`>` carry what was TYPED, and a delivery can quote the sentence verbatim; a new glyph is added to the set with the version that painted it), whole words rather than "the line mentions steer", and a footer that offers the mode it is already in treated as no answer. Every fixture carries the kiro version it was captured on, both builds' bytes side by side, and the capture command — a pane pasted into a note is not evidence a later reader can check.

**The same cause had a second reader (board #361, 2026-10-14).** `kiro::high_traffic` did `strip_prefix("● ")`, so kiro-cli 2.28's `• claude-fable-5.1 is experiencing high traffic. …` was never a hit and the auto-recovery of `recovery.rs` (last fired 10-11 01:36) was silent for every stop since the upgrade: 49 real blocks in nine panes' scrollbacks, all `•`, none `●`, each an agent that sat stalled until a person typed. The fix is the #346 rule applied again: `kiro::HEAD_GLYPHS` is a closed set of the two measured glyphs, every negative (a stamped quote, a tool head, prose around it, a missing paren/colon/period, a non-uuid, text after) is tested for BOTH glyphs, and the positives are three blocks verbatim from the scrollbacks as `check_once` reads them (`capture-pane -p -J`; wide, narrow, and one with the status line below). The audit that the issue asked for — every reader of kiro's painted screen, checked against "does it assume the old bullet":

| reader | what it reads | `•` |
|---|---|---|
| `kiro::high_traffic` (via `transient_error`) | column-zero bullet + the sentence | **was blind, fixed** |
| `kiro::live_input_mode` (`toast_mode`, `footer_mode`; used by `delivery::input_mode_seen`, `hub_agents`) | toast bullet, busy footer | handled (#346, `TOAST_BULLETS`) |
| `kiro::transient_error`, the stream-error and model-unavailable shapes | `canonical(block)`, ASCII letters and digits only | glyph-agnostic by construction; no instance of either shape in this host's scrollbacks, so their 2.28 paint is unmeasured |
| `recovery.rs` block splitter, `headless_error_tail`, `extract_request_id` | column zero vs indent, blank line, `tmmchat`, `requestid` | glyph-agnostic (they never look at the head) |
| `kiro::sniff_kiro` / `vitals` | the status line: agent name, `·` segments, pie `○◔◑◕●◯` | no bullet; the 2.28 line `builder · claude-sonnet-5.5 · high · ◑ 29% · …` reads |
| `tmux::file_picker_open` | footer text `esc to cancel` + `to select` | no glyph |
| agent state, working/idle, replies | hooks and the session jsonl (`telemetry::derive`, `kiro_reply_from_session`) | not screen readers |
| the frontend | nothing parses kiro's screen text | — |

Open on purpose, unchanged: a tool call whose output is, verbatim and alone, the high-traffic sentence under a short tool head would still read as a hit (`• Read x` + that line); it is the same exposure `●` always had, it needs the tool to print exactly the sentence with a uuid. A false hit types `continue` into a working agent: once per incident when the hooks then confirm it, but up to `MAX_ATTEMPTS=4` spaced sends when they do not — this fix did not change that bound. Closing it needs a real tool paint to write the exclusion against (follow-up), not a model whitelist: the model name must stay free.

### The app owns managed agent configs, and drift is repaired at every start (moved from tmm-cli.md, board #102)

Hooks are how we observe an agent at all, so a config on disk must never be older than the build reading its events — agents spawned before `userPromptSubmit` existed kept a three-hook config, so deliveries had no receipt and the reply edge could not find its requester. `spawn::refresh_hooks(project_path, window_name)` rewrites the `hooks` key in place (kiro `agents/<name>.json`, claude `settings.json`, codex `codex/hooks.json`, grok `hooks/tmux-mobile.json`) and nothing else — the prompt carries the brief given once at spawn and cannot be rebuilt; it is a no-op when current and runs on EVERY start (`hub_agent_restart`, `reconcile` on project up). Each backend's hook set lives in ONE function (`kiro_hooks`/`claude_hooks`/`codex_hooks`/`grok_hooks`), shared by render and refresh so the two cannot disagree. Settings drift is the same disease: `kiro_cli_settings` is the canonical `settings/cli.json` content (`chat.disableTrustAllConfirmation=true` — an agent has nobody at its keyboard; plus the toolSearch keys above), written fail-loud at spawn, backfilled fail-soft on every start, and a key the app does not own survives untouched. A CLI reads its config at LAUNCH, so patching a file never repairs a running agent — restart is the only path, which is what the roster's restart button is for.

### The kiro backend on kiro-cli 2.22.1: one 3.0 profile for both engines, and the v3 door is the workspace (board #207, 2026-09-20)

Owner: "kiro 后续升级了 kiro-cli --v3 版本，你来帮我看一下后端是否都能用，各种配置以及参数兼容性，
以及一些状态嗅探等 … 保证我们顺利迁移". kiro-cli 2.22.1 ships two agent engines —
`--agent-engine v2` (its default and ours) and `v3` (KAS 0.66.4, the "next
generation Kiro agent") — and a 3.0 profile format. Everything below was
measured on private `KIRO_HOME`s and private tmux sockets; no running agent
was touched.

- **The profile is the 3.0 shape, for both engines.** `kiro_hooks()` emits an
  ARRAY of named hooks (`{name, trigger, action:{type:"command", command},
  timeout}`; our tool hooks carry no `matcher` — a bare `"*"` made the 3.0
  profile invalid, "agent not found", while no matcher means every tool) and
  the profile carries `permissions.rules = [{capability:"all", effect:"allow"}]`.
  The v2 engine accepts this shape and fires all four hooks (measured:
  userPromptSubmit, preToolUse, postToolUse, stop). `patch_profile` replaces
  the 2.0 object with the array and adds `permissions` only when absent;
  idempotent on both shapes. Why it matters: with
  `chat.enableAutoAgentUpgrade=true` (below) the CLI rewrites every 2.0 profile
  it finds to 3.0 and leaves a `.bak` beside it — writing 3.0 ourselves means
  the upgrade never runs on our homes. Measured: two `--agent-engine v3` starts
  on our profile, no `.bak`, byte-identical file.
- **Home settings** (`kiro_cli_settings`) gain `chat.enableAutoAgentUpgrade =
  true` — without it v3 parks an unattended pane on "Your agent configs are
  still in the 2.0 format. Upgrade?" — and `chat.defaultModel = <def.model>`:
  **v3 IGNORES the profile's `model`** and reads this key (or `--model`). The
  profile keeps `model` for v2; `ensure_kiro_settings(home, model)` mirrors the
  profile's model at every refresh, OMITS the key when the model is empty and
  DELETES a stale one when the model is cleared, so an old pin cannot outlive
  the config. The model still lives in CONFIG, never on the launch line.
- **The engine door is one app-wide key**: `kiro_engine = "v2" | "v3"` in
  `config.toml` (`KIRO_ENGINE` overrides; default v2; anything else is v2 with
  a note). `render_kiro` appends ` --agent-engine v3` to the launch line only
  when the door is open — v2 is byte-for-byte what it was — and `refresh`
  reconciles the recorded `launch.json` at every start (`reconcile_engine_in`:
  add / replace / drop the segment), so an agent takes the new engine at its
  NEXT restart and one scratch agent can be flipped by restarting it alone. No
  per-agent field: that would be a schema and editor change nobody asked for.
- **v3 finds the agent through the WORKSPACE, not `KIRO_HOME`** — the finding
  that changed the plan. With a private home, the same profile was "agent
  … not found, using default" under any other name and from any other cwd,
  and found the moment it sat in `<cwd>/.kiro/agents/`; the earlier "works"
  reading came from a copy that had been dropped there. `KIRO_HOME` still
  supplies the settings (`chat.defaultModel` was honoured). So, only while the
  door is open, `ensure_workspace_entry` puts ONE symlink per managed agent at
  `<ws>/.kiro/agents/<name>.json` → `<ws>/.tmm/agents/<name>/agents/<name>.json`
  — the isolated home stays the single truth, v3 reads through the link;
  idempotent on every start; a file there that is NOT our link is never
  clobbered (spawn fails loud naming it; refresh logs); the link is removed
  with the agent (`agent_remove`) and when the door closes; OUR FILE's path
  (`/.kiro/agents/<name>.json`, one line per agent under one mark) goes into
  `.git/info/exclude` (local, untracked, idempotent) so an agent's `git add
  -A` cannot commit it — never the whole directory, which would hide the
  user's own agents from their `git status`. Measured: v3 follows the link (found, session
  `agentMode=probe207`); a 2.0 profile left BEHIND the link is upgraded by the
  CLI through it — and the CLI's write replaces the link with a regular file
  plus `.bak` under `ws/.kiro` — which is exactly why our profiles are 3.0
  before v3 ever sees them, and why a non-link file at that path is a loud
  error at the next start rather than a silent fork.
- **The v3 Stop payload carries no reply text** (`{session_id,
  hook_event_name:"Stop", cwd}`). The reply is the last `assistant` entry of
  the GLOBAL session file `~/.kiro/sessions/<cwd-hash>/sess_<id>/messages.jsonl`
  — each line `{id, timestamp, payload:{type, content, …}}`, a turn
  `turn_start … turn_end` with possibly several `assistant` entries (text
  between tool calls, then the final text, then — measured on a managed TUI
  spawn, board #213 — a placeholder row whose content is `"..."`).
  `kiro_reply_from_session` takes the last assistant after the last
  `turn_start` that carries a letter or digit (the placeholder posted `...`
  to the room once); `Backend::reply_fallback` wires it into the notify
  helper when a kiro Stop has no text (agent-status.md).
- **Resume follows the engine, and an id is handed only to the engine that
  minted it** (board #213). The recipe's `cmd` never carries a resume
  segment; `relaunch_line` appends the backend's dialect at restart, so
  `kiro::resume_command` reads the engine off the (already reconciled)
  launch line. v2 ids live in the isolated home's own store; v3 ids are
  `sess_<uuid>` in the GLOBAL `~/.kiro/sessions/<cwd-hash>/`, which every
  managed agent of a project SHARES. Measured on kiro-cli 2.22.1: v3 given a
  v2 id came up `Default · Auto` with no session file, so the reply never
  reached the room (claude's rollout attempt); v2 given a v3 id came up
  `agent "kiro" not found, using "default"`; v3 `--resume-id sess_…` resumes
  the same session with agentMode, model and context intact; v3 `--resume`
  would take the newest session of the DIRECTORY, possibly a teammate's or
  the human's. Rule: v3 + `sess_` id → `--resume-id`; v3 + anything else →
  fresh (no `--resume`); v2 + non-`sess_` id → `--resume-id`; v2 + `sess_`
  id or none → `--resume` (this home's own newest thread — after a rollback
  that is the pre-switch conversation). Losing the v2 thread once at the
  first switch is the owner's accepted trade ("没关系，我可以重新再开",
  2026-09-20). Proven end to end on a scratch project with a private server
  and private tmux socket: spawn on v3 → reply posts; restart on v3 →
  `--resume-id sess_…`, status `kiro · …`, recalls the previous turn, reply
  posts; door closed → `--resume`, `kiro · auto`, reply posts; door opened
  again with a v2 id recorded → no resume segment, `kiro · …`, reply posts;
  the slot's `agent_session_id` follows the engine (the hook records
  whichever id the CLI reports).
- **The v3 status line prints the model's DISPLAY name** (`probe · Claude
  Sonnet 5 · high · ◔ 4% · Midway: 19h 19m   /ws · (branch)`; v2 prints the
  slug). `sniff_kiro` accepts a display name (`looks_like_model_name`: words
  of letters/digits/dots/dashes, ≤48 chars) ONLY right after the anchor —
  the `Midway:` segment (a colon) and prose lines are not models (fixtures +
  negative control in `backends/kiro.rs`).
- **Not ours to fix, documented:** v3 never fires the tool hooks
  (`preToolUse`/`postToolUse` are gated behind KAS `featureFlags.v2Hooks`), so
  kiro's tool lane is empty on v3 while status from turn edges is unaffected;
  in `--no-interactive` mode v3 fired no hooks at all (the TUI fires
  prompt/stop); v3 loads every `~/.kiro/skills/*` and `~/.kiro/steering/*`
  into each session regardless of `KIRO_HOME`; tmux 3.6a reports
  `pane_dead_signal` as a number. Re-measure on the next kiro-cli release.
- **The global `~/.kiro/agents/kiro_default.json`** is the CLI's file: 2.22.1
  upgrades it to the array shape, older installs keep the object. The
  user-space installers that once merged our marked entries into it retired
  with the Settings hooks surface (board #222) — managed agents carry hooks
  in their isolated home, and the global path was never reliable for
  observation anyway (it is shadowed by the built-in `kiro_default`).

**Rollout** (the owner's move, not the app's): 1) set `kiro_engine = "v3"` in
`config.toml` (the running server reads it at the next spawn/refresh; the
server binary must carry #207 + #213), 2) `tmm agent restart <one scratch
agent>` — its recipe gains ` --agent-engine v3` at refresh, its workspace
gains the link, and its FIRST v3 start is a fresh conversation (the v2 thread
stays in the home's store) — 3) check `tmm agent list` vitals (model =
display name, context, effort) and one reply edge (`tmm log --grep
'[reply]'` after a turn), 4) then restart the real agents. Flip back by
setting v2 and restarting: the segment and the link go, and `--resume`
returns the agent to its pre-switch v2 thread.

Guards: `backends/kiro.rs` tests (reconcile, session reply, display-name
model, patch_profile idempotence, workspace entry incl. the foreign-file
refusal and the git exclude), `spawn.rs` render/refresh tests (array shape,
permissions, defaultModel, no engine segment by default),
`agent_notifications.rs` (kiro_default both shapes), `config.rs`
(`normalize_engine`).

### The grok backend (grok 1.0.5, added 2026-08-21; moved from tmm-cli.md, board #102)

Aligned with kiro's shape, verified live (isolated home spawned from the hub answered on the owner's Bedrock custom model; hooks fired; state derived). **Isolation**: `GROK_HOME=<ws>/.tmm/agents/<name>/`. **Identity**: `agents/<name>.md` — YAML frontmatter (`name`, `description`, and the MODEL, honored from frontmatter; nothing on the launch line) with the system prompt as the body; launched `grok --always-approve --agent <name>`; skills ride the prompt as the compact index. **Telemetry**: `hooks/tmux-mobile.json` in the home (that home's "global" hook scope, always trusted); five events — UserPromptSubmit (payload wraps the text in `<user_query>` tags), Pre/PostToolUse (camelCase `toolName`/`toolInput`), Stop, StopFailure. **A grok `stop` is a completion ONLY with `reason: "end_turn"`** — a second observe-only stop fires at session teardown (`shutdown`/`channel_closed`) and reading it as a completion would double-post; the reply rides `lastAssistantMessage`. **Auth carries, prefs do not**: grok auth is HOME-scoped, so `grok_config_toml` copies the user's `[models]`/`[model.*]` catalog (+ `auth.json` when present) into the isolated home — without it the agent is a login screen; user hooks/UI/MCP deliberately do NOT carry. TRAP, paid for once: toml 1.x parses a DOCUMENT via `toml::Table` — `Value::from_str` fails on any real config ("expected nothing") and the catalog silently vanished. `[folder_trust] enabled=false` keeps the TUI off a trust prompt nobody can see. **Resume**: `--continue` is cwd-scoped, `--resume <id>` exact (id from the hooks' `sessionId`); managed homes always use one on restart. **Models**: `grok models` enumerates (bullet list, `*` marks the default), so grok ids validate like kiro's.

### The claude backend on Bedrock (claude 2.1.258, re-verified 2026-09-02; moved from tmm-cli.md, board #102)

The owner uses Claude through Bedrock ("都用bedrock渠道…复用我们全局定义的配置 但是自己管理好类似kirohome这种"); the live gate covered both doors (direct `claude -p` and a Hub-managed launch on `global.anthropic.claude-fable-5-1[1m]`). **Channel**: the user's `~/.claude/settings.json` `env` block (`CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`) — SigV4 from the normal AWS chain, no API key; `render_claude` copies ONLY that block into the isolated `settings.json` (plugins/marketplaces deliberately do not carry) and `refresh_hooks` backfills missing channel keys on every start while an existing per-agent value stays an explicit override. **Isolation**: `CLAUDE_CONFIG_DIR=<ws>/.tmm/agents/<name>/` — history, session state and `.claude.json` stay in the home; the relocation unhooks the user settings layer, which is why the channel must be copied. **First-run furniture, measured and PRESEEDED**: Claude has no global-trust switch; its permissions docs specify `projects["<repo-root>"].hasTrustDialogAccepted=true` in `.claude.json` (git root in a repo, launch dir outside), so `ensure_claude_state` canonicalizes the path, merges that key with onboarding/theme before launch, preserves session/usage fields, tightens the file to 0600; restart backfills old homes; the old prompt watcher (`Down`→`Enter` — 2.1.258 defaults the cursor to "No, exit") survives only as a fallback for changed CLI shapes. **Model**: empty = the inherited env's `ANTHROPIC_MODEL`, so no `--model` is passed (the old hardcoded `sonnet` alias overrode the env and does not resolve on Bedrock); a configured model rides `--model` and wins. Supported PRIMARY pins carry Claude Code's literal `[1m]` suffix (verified live: Fable 5.1's statusLine moved from `64.0K/200K` to `64.0K/1M`); the Haiku background pin has NO suffix (not on Anthropic's Bedrock 1M list); `[1m]` is a zsh glob, so the launch line MUST pass it through `shell::quote`. **Bedrock web search**: Anthropic's built-in WebSearch is unavailable on Bedrock; this host registers `kiro-web-search` as MCP instead (its `KIRO_API_KEY` stays in local private config, never the repository; the upstream endpoint is explicitly unstable — convenience, not a production API). **Hook payloads verified**: `hook_event_name`/`prompt`/`session_id` on UserPromptSubmit, `last_assistant_message` on Stop.

### The kimi backend: Kimi Code CLI 2.0.2 on Bedrock (board #224, 2026-09-20)

The owner runs Kimi K3 through Bedrock's OpenAI-compatible endpoint ("kimi code也帮我支持上吧 我应该配置了可以用bedrock"): `~/.kimi-code/config.toml` declares `[providers.bedrock] type="openai"`, `base_url=https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1`, `api_key_env="KIMI_API_KEY"` (the env var is the same long-term Bedrock API key as `AWS_BEARER_TOKEN_BEDROCK`, exported by the interactive zsh, so it reaches every pane; kimi's `openai` provider sends a fixed bearer token and does not SigV4-sign) and one alias `[models.bedrock-kimi-k3]` → `global.moonshotai.kimi-k3`, 1M context. Everything below was measured on 2.0.2 with a scratch `KIMI_CODE_HOME` and hooks that dumped their stdin.

**Isolation**: `KIMI_CODE_HOME=<ws>/.tmm/agents/<name>/kimi` — kimi's data-locations doc says the variable moves ALL of it (config, `AGENTS.md`, `mcp.json`, `tui.toml`, `sessions/`, `workspace-trust/`, credentials, logs). **Catalog carry, not symlink**: hooks are `[[hooks]]` rows INSIDE `config.toml`, so the rendered file is ours, and `render_kimi` copies the user's `default_model`, `[providers]` and `[models]` tables into it (`toml::Table` — grok's document-vs-value trap) and nothing else (the user's permission rules, hooks and UI prefs are what isolation is for). It also sets `default_permission_mode="auto"`, `telemetry=false`, the registry effort as `[thinking].effort` (kimi's enum low/medium/high/xhigh/max; bound as `thinkingEffort` in the wire), and writes `tui.toml` for an unattended pane (`[upgrade].auto_install=false`, `cache_expiry_hint=false` — a resume otherwise opens a "cache expired" dialog nobody sees — no survey, no desktop notifications). **Model = alias**: `-m <alias>` only when the registry pins one; empty means the user's own `default_model`, already in the copied config; `models_fetch` returns the alias keys of the user's `[models]`, an AUTHORITATIVE list (an unknown alias is `config.invalid` at startup), so a typo is rejected at save time. **Prompt**: `$KIMI_CODE_HOME/AGENTS.md` (kimi's global instructions, injected as `${agents_md}` reference data — codex's pattern; `SYSTEM.md` would replace kimi's whole prompt and its tool harness). **MCP**: `$KIMI_CODE_HOME/mcp.json`, `{"mcpServers":{name:{command,args,env}|{url,headers}}}` — kiro's shape, no `type` key (kimi's mcp doc); an empty set removes the file (`shared::write_owned`, #241); the seed carries `kiro-web-search` because kimi's built-in search is the Moonshot service behind a Kimi API key, absent on Bedrock. **Launch**: `command kimi --auto` — Never Ask, the documented unattended mode — with `KIMI_CODE_NO_AUTO_UPDATE=1`. `~/.kimi-code/bin` joins the recipe PATH (the installer's location; not on the service PATH). **The brief is TYPED, not positional** (claude's live gate after the merge: `kimi '[tmm chat …] claude: You are kimi…'` → `unknown command '[tmm chat …'` and the pane fell back to the shell; kimi 2.0.2's only prompt flag is `-p`, one-shot non-interactive). `Backend::first_prompt()` names the dialect — `LaunchLine` for the five CLIs that take a trailing positional, `Typed` for kimi — so `launch_command` appends nothing for kimi and `spawn` hands the stamped first prompt to the startup waiter, which types it through `projects::deliver_chat_line` (the same door as every later message: recorded delivery, turn-start echo as receipt, reply edge to the briefer) once kimi's ready markers (`Welcome to Kimi Code` / `No session yet`) are on screen — after the trust dialog, if one showed. `confirm_startup_prompt` gained that one `on_ready` action and answers the dialog ONCE (`startup_step`, pure and tested: the accepted screen lingers a repaint and a second Enter would submit an empty line); a pane that never becomes ready is logged rather than typed into. Known startup notice, measured: `tmux extended-keys-format is xterm. Kimi Code works best with csi-u` — informational; every key we send is a NAMED key (non-negotiable 7), and the global tmux format is not flipped for one CLI.

**Folder trust, preseeded and confirmed**: a fresh workspace shows "Trust this folder?" (cursor on "Trust this folder", Enter accepts) even under `--auto`; the answer is remembered in `workspace-trust/wd_<basename>_<sha256(cwd)[:12]>` as `{"root","trustedAt"}` — the hash half verified against three keys kimi wrote (`wd_ws_8134d477aa6a`, `wd_learn-english_13c0722d7b09`, `wd_cfu_b1525dd5ffa6`). `render_kimi` writes that file for the CANONICAL workspace path and keeps claude's belt-and-braces: a `StartupConfirmation` on the two markers (`Trust this folder?`, `Don't trust`) answers a key kimi stops recognising.

**Hooks** (`hook_event_name`, snake_case keys; `session_id` is `session_<uuid>`; every payload carries `cwd`): `UserPromptSubmit` — its `prompt` is an ARRAY of content parts `[{type:"text",text}]`, not a string, so the hub's one prompt reader (`agent_notifications::prompt_text`) accepts both shapes and flattens the parts before `reply_targets` sees them (a test pins that the array routes exactly like the string); `PreToolUse`/`PostToolUse` (`tool_name`, `tool_input`); `PermissionRequest` (the ask; never fires under `--auto`); `Stop` — NO reply text, `stop_hook_active` only; `StopFailure` → `failed`; **`Interrupt` fires INSTEAD of `Stop` when Escape ends a turn** (`reason:"cancelled"`), so it is a completion too — without that arm an interrupted kimi stays `working` forever, the v3-rollout failure again. `SessionStart` (`source: startup|resume`), `TurnStarted`, `SessionEnd` exist and are not subscribed.

**The reply is read from the wire**: `sessions/<wdKey>/<sid>/agents/main/wire.jsonl` holds `agent.message.appended` rows (`message.message.{role,content[]}`); the reply is the text parts of the LAST assistant message after the LAST `turn.prompt` (think parts and tool rows are not it; a turn interrupted before any text yields nothing, never the previous answer). It is already on disk when `Stop` fires (measured: the hook's own `grep -c` saw it). The hub resolves the home BY NAME — pane → window → `managed_home` — and hands it to `Backend::reply_fallback(payload, home)`; `session_index.jsonl` in that one home maps the id to its `sessionDir`. Never by searching the workspace: two kimi agents in one project must not read each other's session (the end-to-end test seeds a decoy sibling with the same id).

**Vitals** (`sniff_kimi`, measured at 100 and ~52 columns): two footer lines — `Never Ask  Kimi K3 on Bedrock thinking  /tmp/…/ws  master [±]` (items joined by two spaces; the model item is the alias's `display_name` plus a ` thinking` tail; no effort level is painted, so `effort` stays unknown rather than a verdict) and `context: 2% (19.3k/1M)`, anchored on the literal `context:`. On a narrow pane the cwd truncates with a LEADING ellipsis (`…/work/pr…`, measured live at ~52 columns) and the git item drops; the cwd anchor therefore accepts `…` beside `/` and `~` — anchoring on `/` alone read no model on any phone-width pane (board #230). The model is read only on a row that starts with one of kimi's three mode labels and has a cwd item to anchor against; the card drops the display name's ` on Bedrock` route tail at paint (`modelLabel`, the same rule that drops omp's `(Bedrock, 1M)`). **Resume**: `-S <id>` exact (same id, `SessionStart.source="resume"`), `-c` the cwd's previous session — cwd-scoped inside the isolated home, so the recent fallback is safe. **Typing**: an Enter glued to the text burst is swallowed as paste — codex's 200 ms beat in tmux.rs already covers kimi. **Client**: kimi already had its avatar and `--backend-kimi` token from its detection-only days; the served `backends_list` now includes it, so nothing else moved.

### Backend parity is measured per CLI, and the gaps are named (2026-08-22; moved from tmm-cli.md, board #102)

The owner asked claude/codex/grok to match kiro ("都要和kiro我们现在支持的特性能对齐"). What was missing and done: turn-start hooks (`claude_hooks`/`codex_hooks` lacked `UserPromptSubmit`, the carrier of the submitted prompt — deliveries stayed unconfirmed and the reply edge had no requester; both register it now, `is_user_prompt_submit` recognises their spelling, `refresh_hooks` backfills spawned agents; codex payloads measured live on 0.148.0 — same schema family as claude; codex has NO StopFailure, binary checked, so `failed` cannot derive for it); codex vitals (own dialect, see agent-status.md); codex resume (`relaunch_line` splices the SUBCOMMAND in — `command codex resume <id> <flags>`; appending like the flag backends would hand `resume` to the CLI as a prompt; `--last` is safe only in the isolated CODEX_HOME because codex filters it by cwd); per-backend `/` palettes (hub-composer.md). Not aligned, with reasons (also `docs/todo.md` §B): claude palette (its `/` popup untranscribed), auto-continue patterns for claude/codex/grok (their transient error texts uncaptured — a guessed pattern types into working agents), codex `failed`. Two general plumbing lessons from the live gate: **a managed window's backend comes from its RECIPE, not the pane sniff** (`agents::detect_pane` — the npm codex runs as `node` with nothing saying "codex", so a spawned codex fell out of delivery/roster/vitals/recovery until the record beat the sniff); and **`send_command` sleeps 200 ms between text and Enter** (a TUI that gets the burst back-to-back treats the Enter as paste content — measured on codex).

## Agent teams (board #74)

Owner, 2026-09-02: "除了定制 agent 之外，我们可以定义 agent team，可以看作是 agent 加上一个特定的角色补充设定，组成一个小组…在一个项目里，可以直接选择一个 team 拉起几个 agent 一起工作，视图上放到一个 group 里".

**Data.** `reg_teams` (state.db v17): `name`, `description`, `members` — a JSON array of `teams::Member { name, base, team, role, model, effort, input_mode, agent }`. The UI calls `description` **Team rules** because the text is injected into every member's team block; it is shared operating guidance, not a marketing purpose. A member has exactly one source: (1) a bare coding agent, stored as a complete inline `agent` definition whose backend/model/effort/prompt/Skills/MCP belong to this team; (2) a custom registry agent named by `base`, inherited with its prompt/Skills/MCP intact (only model/effort/input mode may be overridden, #254); or (3) a sub-team named by `team`, inherited whole with `role` as an enclosing brief. `teams_save` validates names, backends, models, efforts and the bare definition's Skills/MCP JSON before spawn.

**Nesting** (owner, same day: "应该在 dev 里直接加 review 小组…设计成可以嵌套的"). A member may be another team: `{ "team": "review", "role": "…" }`. `teams::expand` flattens depth-first; every leaf carries the PATH it came in on (`dev/review`), the team whose block names it, and the `role` of each enclosing reference as an extra brief ("From the enclosing team: …"). Cycles are refused (a team reaching itself through any chain), the cap applies to the EXPANSION, `teams_save` re-expands every team that includes the saved one so an edit cannot break a parent, and `teams_delete` refuses while another team includes it. The recipe records the path; the roster now keeps nested members under the root team's Chrome-style tab group, exposing their full path in hover/ARIA instead of drawing a frame inside a frame (owner, 2026-09-23). A nested member's prompt says `## Your team: "review" (a sub-team within "dev": dev/review)` while roster lines of members in another sub-team carry a `[path]` tag. The spawn cap rose from 4 to 8 for this: a squad of four plus its four-reviewer board.

**Spawn.** `spawn::spawn_team` (RPC `hub_spawn_team`, CLI `tmm spawn --team <name> [--brief]`; teams are managed with `tmm teams list|save|delete` — parity with the Agents page, so a lead can define a team too) checks the cap against the project's existing agents, uniquifies every member's window name FIRST, then builds each member's effective definition with `teams::effective_def`: base (or inline) def renamed to the member, persona = base persona + a team block (team name, description, "You are X. Your role: …") + the roster of teammates by their FINAL names with one-line roles, so the members can `@` each other on day one. Each member then goes through the ordinary `spawn` path — same isolated home, hooks, recipe, `tmm` — with `def`/`window_name`/`team` overrides on `SpawnRequest`; nothing downstream learns a new species. `launch.json` records `team`, `projects::team_of` reads it back, and `hub_agents` reports it per agent. One member failing does not stop the others; failures come back in `errors`, and the room gets one `[tmm] spawned <name> — team <team>` line per member.

**UI.** Agents page → Teams category (desktop: THREE levels — the sidebar
lists categories, the category's rows are their own second column, and the
main column holds the editor when the container can fit all three levels
(board #94, "右侧拆分成两级"; the rows column is a `SideHandle`
divider with its own remembered width, and the global instructions' level is
the single AGENTS.md row — owner 2026-09-04, "不要全堆在一起了"; compact
keeps the two-level drill); phone: Teams is its own Settings page): list rows (name + members) and an editor. The member-source Select offers Bare coding agent, Custom agent and Sub-team. Bare opens backend/model/effort/prompt/Skills/MCP; inherited sources hide those fields and keep only their team role (plus the existing model/effort override for a custom agent). A member card rests as a readable backend/avatar + name + source + role summary; tapping the broad summary expands that member and closes the previous one. Identity controls live only inside the expanded editor. Team rules, the team role and a bare member's prompt are full-width editors that grow with their text until the shared configuration height cap. Board #156 (2026-09-10) retires the private 140/150/240px desktop and 180/190/260px compact floors in favor of `--config-editor-min` and the common 860px canvas; those earlier measurements are history, not competing current rules. Existing teams open only the first member and a new member opens itself. Field grids wrap by available width; shared commands provide touch targets. Sections inside a member are divided, never nested cards; Add member is a command button, not a selection chip. Hub roster: `rosterGroups` gathers root-team members into one `.roster-cluster` with a team-name choice and group-only baseline. Tapping it selects the current members as one destination; individual member buttons remain independently addressable, and expanded lists keep a closed group enclosure. The preset panel and picker dialog list teams as one-tap starts.

**Motion (Agents page).** Per [motion.md](motion.md): the sidebar list unfolds on its FIRST paint only — `reload()` sets `justLoaded` once (`painted`), `.reveal` on `.side-scroll` staggers rows 30ms from the top, and a timer clears it after `revealMs()` so a saved or imported row later mounts plain; a revisit is a cut. The compact editor drill keeps its 120ms linear slide.

**Restart a team = align it with its current definition** (board #286, owner 2026-09-30: dev-squad edited to drop archivist and add reviewer, then "点击 dev-squad 重启，好像没有改变角色"). Restarting each live window, as the team menu used to, refreshed the members still in the team (`refresh_agent` → `refresh_team_def`) but replayed a dropped member from its old materials and never started an added one. `hub_team_restart` (the team name's menu "Restart team", CLI `tmm agent restart --team <team>`) plans from three facts (`spawn::team_plan`, pure; `team_plan_for` reads them): the members whose recipes name the team here, the CURRENT definition's members (path and name), and the live windows. A member the definition still has is restarted (a stopped one is started), each through the same `start_agent` a single restart uses, so it comes back from the current definition. A member it no longer has is stopped if live, its home kept (remove stays a per-agent decision). A member it gained is spawned by `spawn_team_members(…, only_new)`, which names the existing members by the windows their recipes record, so every roster is the team as it will stand. New members spawn first, so the restarted members' rosters can name them. The room gets one line per member: `restarted`, `stopped … — no longer in team`, `spawned … — team`. A single agent's restart stays a recipe replay. A retry (the confirm dialog's, after a partial failure) passes `only`, the names that failed, so what already restarted is never restarted again (#258). Known limit: the homes are read as one window per (path, member), so a team spawned twice in one project (`lead` and `lead-2`) aligns only one of each pair; the other is neither restarted nor stopped (validator 06:53, P2). Pinned by `a_team_restart_aligns_with_the_current_definition` (plan and retry), `a_team_restart_plans_from_the_edited_definition_and_its_prompts_follow` (store + recipes: the edit reaches the restarted member's roster), and the Hub mount test "Restart team aligns…" (one server call, no per-member replay). Negative control: a plan that restarts every home fails both Rust tests.

**Why not the (retired) desktop Team feature.** That was a different thing — an agora room with its own sessions (`tmm-team-*`), templates and bus, deleted whole 2026-09-09 (board #100). Agent teams are a REGISTRY concept inside a project's ordinary roster; they reuse everything the Hub already has.
