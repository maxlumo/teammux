# tmux-mobile Tenets

> Draft v7 · 2026-09-09 · English edition of the Chinese discussion draft,
> translated at the owner's direction. Owner quotes remain in Chinese as evidence.
> This is the root document: `docs/guidance/*.md` expands the tenets into
> actionable rules and review checklists by discipline; `docs/todo.md` records
> the gaps between them and today's implementation. This document takes precedence.
> Each tenet follows **tenet -> why -> evidence (from code, documents, 1251 commits,
> 93 board issues and room history) -> implications**. Evidence establishes where
> a tenet came from, not that the code already meets it. These tenets exist to
> improve code quality.
> Tenets 9-11 clarified on 2026-09-10 by board #159, under owner-approved #154:
> shared interaction contracts, explicit context and usable restraint.

---

## Purpose

We build a **shell** connecting things that already exist: tmux owns processes
and sessions, coding agent CLIs (kiro / claude / codex / grok / omp / kimi / dsh) own
intelligence, MCP and skills own tools, and a phone or desktop provides the
window into them. We do not maintain a tmux-like runtime, implement agents,
build tools, or hide agents behind an invisible protocol wrapper. We define
how they meet, so a person on any device can observe, talk and give orders,
then return to the terminal and take over directly at any time.

We **own** only four things; everything else belongs elsewhere:

| We Own | Contents | We Do Not Own |
|---|---|---|
| Connection | WebSocket JSON-RPC, token, E2E, switching between servers | Processes and sessions (tmux) |
| Room | One chat room per project, board, derived agent status | Intelligence and its harness (each agent CLI) |
| Identity | Registry definitions, isolated homes, launch recipes, teams | Tools (MCP servers, skills) |
| Window | Equally complete phone and desktop UI, terminal rendering, file browsing | Memory (mem and similar tools, integrated as skills) |

If a feature belongs on the left, we build it. If it belongs on the right,
we integrate it. When the boundary is unclear, first ask whether the
underlying tool offers a native integration point.

---

## Zen

Short form for prompts and reviews:

```text
Understand the root cause before acting; a symptom fix returns in another form.
A shell, not an engine.
The real CLI in a real pane; a human can take over at any time.
If the server dies, the work keeps running.
Three primitives: type into panes, observe hooks, let agents act through tmm.
Humans and agents read the same record.
What a human can do, an agent can do; add nothing an agent does not need.
Declaration is truth; running state is disposable.
Derive status from observation, never self-report.
One definition per concept; a second copy is a bug.
One mechanism per job; a new visual species is a regression.
The shared unit is the interaction, state and accessibility contract.
Adding a backend touches one file.
Look for a native integration point first; build your own only with a recorded reason.
Measure, do not guess; record the version.
Keep rules beside their design, with reasons and incidents.
Exercise restraint: delete rather than retain, use fewer words, do not overdesign.
Do not remove what a person needs to identify, act or return.
Phone and desktop must both be complete; compromising one fails both.
Make the object, state, available actions and return destination clear.
Beauty is function: make it obvious who is running and who needs me.
Motion guides attention; it does not decorate.
Commit verified work; one idea per commit.
Telemetry never blocks.
```

---

# 0. How We Think

## Tenet 1: First Principles

**Why.** Of this repository's 1251 commits, 454 were fixes. One delivery
acknowledgment chain needed seven fixes; keyboard resize direction reversed
four times in one day; six Escape-focus commits preceded the discovery that
a browser extension was responsible. Fixing symptoms lets the same problem
return in another form. Before acting, ask for the real cause, the concept
involved and the failing layer. This is the basis of every other tenet:
the shell boundary, three primitives and one definition per concept follow
from reducing the problem to its smallest set of primitives, not arbitrary rules.

**Evidence.**
- Moving the model into configuration instead of the launch command was not
  about correcting a `--model` typo. The model belongs to identity, and identity
  belongs in configuration. That resolved `up`, restart and resume together.
- Indistinguishable running and idle states were not a request for another
  color. Hue differences were unreadable at 5-7px; a halo changed the visible
  quality of the mark instead of merely its color value.
- Accumulating sessions did not call for a cleanup button. The concept of an
  untracked session was unnecessary, so every session became a project.
- Network health went through five approaches (heavyRpc counts, lastRxAt,
  pending rules, and more) before moving to protocol-level WS PING/PONG.
  Inferring link health from application signals started at the wrong layer.
- Three failed toolbar attempts to fix paint covering content ended with the
  commit's conclusion: "structure beats paint".

**Implications.**
1. Before fixing a bug, state the root cause in one sentence and explain why
   the earlier observations were symptoms. For a second failure in the same
   area, start with the assumption that the previous fix addressed a symptom.
2. Identify the failing layer (browser, xterm, tmux, CLI or our code), then
   fix it at that layer.
3. Ask whether a concept should exist before asking where to put its `if`.
   Removing a concept is better than adding branches around it.
4. When two similar requirements appear, find their shared underlying need
   and implement that once.
5. Measure uncertainty instead of hiding it behind defensive code. After a
   fix, inspect related operations too. Owner: "你再检查一下其他类似操作逻辑".

---

# A. What We Are

## Tenet 2: A Shell, Not an Engine

**Why.** Reimplementing an underlying capability creates another body of code
that must track upstream versions and can break with each upstream change.
Using a native integration point costs a measurement; rebuilding it costs
ongoing maintenance.

**Evidence.**
- Prompts go into each backend's **own** instruction surface: kiro's
  agent-config `prompt`, codex's `CODEX_HOME/AGENTS.md`, claude's isolated
  `CLAUDE.md`, grok's `agents/<name>.md`, and omp's
  `--append-system-prompt <file>`. Owner: "一个文件注入…更优雅", "保证更加稳定".
- MCP uses native backend configuration, not our own tool interface;
  `tmm mcp` exists only as an optional skill.
- A background task is a `remain-on-exit` tmux window, not our own process manager.
- A rejected design used an agora MCP daemon as the agent message substrate,
  with three backend-specific configurations and a handshake. A single `tmm`
  line in the system prompt replaced it.

**Implications.**
1. Look for a native integration point first. Build your own only if there
   is none, and record why in the design document.
2. A new backend may add only one backend file; downstream hub, delivery,
   status and UI code must not gain another `if`. The seven backends really
   do have different configuration, hook dialects and status lines, so
   separate implementations are necessary. Their scattered placement is
   the problem (see todo).
3. We do **not** think for agents or make decisions for CLIs. Forward
   `/command` unchanged; `Escape` is the only interrupt.

## Tenet 3: The Real CLI in a Real Pane

**Why.** Half of a coding agent's value is its model; the other half is its
own harness: TUI, approval flow, tool loop, session recovery and shortcuts.
Wrapping the CLI in an invisible process through a protocol such as ACP
throws away that second half and makes us rebuild it. More importantly,
someone returning to their workstation must see **the same CLI** they
would have launched manually in the tmux window. They can keep typing,
press Escape and browse history without knowing we exist. **The native
agent experience** is a baseline, not an optional feature.

**Evidence.**
- Each managed agent is a real CLI process in a tmux window. An isolated home
  changes only its home through `KIRO_HOME` / `CODEX_HOME` / `--settings` /
  `PI_CODING_AGENT_DIR`.
- omp uses `--append-system-prompt` to **append**, not replace; replacing
  with `--system-prompt` would "lobotomize the tools".
- Our two actions toward the CLI are **observing from outside** through hooks
  and **typing into it** through `tmux::send_command`, the same route as a keyboard.
- Manually launched windows are recognized too, using word boundaries; they
  simply lack an isolated home. The Terminal page shows the actual pane,
  not a transcript.
- The 200ms text-to-Enter interval and kiro `@` file-picker footer detection
  require measurement and adaptation precisely because we do not bypass the TUI.

**Implications.**
1. Do not modify, fork or proxy a CLI's default harness. Inject only through
   documented environment variables, configuration files, hooks and launch
   arguments. Harness means **behavior**: tool loops, approvals, sessions and
   shortcuts. Display-only configuration, such as a managed Claude `statusLine`
   that makes status readable, does not change what the agent does and is
   permitted (owner, 2026-09-09).
2. Do not create a separate channel for something a person can do in the pane.
   Do not secretly perform actions a person cannot see there: no speaking
   for agents in the background or silently injecting prompt text.
3. When a CLI's TUI changes, adapt to it through measurement, documentation
   and tests. Do not require it to change back.

## Tenet 4: No Central Node

**Why.** Our server observes and delivers messages; it is not the runtime.
It may crash, restart or be absent. Agents keep running and people keep
working in their terminals without losing their work. A design that makes
our process a prerequisite concentrates the entire system's availability
in that process.

**Evidence.**
- The watch script restarts the server frequently without stopping agents.
- `tmm` fails soft when the server is unavailable: exit 2 in about 20ms,
  never blocking the agent. `tmm task` does not open a socket at all.
- Every tmux session is a project (`auto_adopt_once`): the server follows
  tmux, not the reverse.
- Counterexample: the desktop Team agora bus required agents to maintain
  a connection through `wait`; losing the server silenced the whole team.
  On 2026-09-09 the owner decided to delete it entirely, with no redundant path.

**Implications.**
1. Before designing a feature, ask whether its user, human or agent, would
   become stuck if the server process died. If so, change the design.
2. The server may cache state, but truth must be recoverable from tmux and
   disk (tenet 7).
3. In-process buses, daemons that require persistent connections and private
   protocols understood only by the server are antipatterns.

## Tenet 5: One Native Bridge, Three Primitives

**Why.** Human-agent and agent-agent communication use **the same** three
primitives:

| Primitive | Direction | Initiator | Implementation |
|---|---|---|---|
| Type into a pane | Into an agent | Human, another agent or system | `tmux::send_command`, with a `[tmm chat …]` stamp |
| Observe hooks | Out of an agent, passively | The CLI itself | Native backend hooks -> `projects/telemetry.rs` |
| Invoke `tmm` | Out of an agent, actively | The agent decides | `tmm send/done/spawn/board/…` |

The first two are everything we do to the CLI (tenet 3); the third is the
agent's own means of acting (tenet 6). A separate agent-to-agent protocol
would hide their conversation from people and prevent intervention. All
three primitives use the same room and panes, so a person can replace
either participant at any time.

**Evidence.**
- `@name` types `[tmm chat <time>] <sender>: <text>` into that pane; `@all`
  types into every managed agent; `@human` notifies the person.
- Hooks capture every final response, record it in the room and return it
  **only** to the parties whose requests the turn carried. `[reply]` creates no reverse edge.
- An agent speaks actively through `tmm send "@name …"`, which ultimately
  types into the recipient's pane. `tmm done` returns to the brief's sender.
- Rejected designs included `tmm done` suppressing auto-post, which lost
  final turn responses; `tmm status waiting|blocked`, about which the owner
  said "没有什么用处，给 agent 增加了理解成本"; and a separate notification
  UI, described as "原来我用的感觉不是很好用". Only three primitives and one
  room remained.

**Implications.**
1. Every collaboration feature must reduce to one of these primitives:
   who typed what into whose pane, what a hook observed, or who ran which
   `tmm` command. Otherwise it is a second bridge.
2. The room is the only record. Humans and agents read the same content;
   there are no agent-only messages.
3. Every line typed into a pane must be readable by a person. It is both
   input to the agent and a human-readable log.
4. `tmm` never blocks and never becomes a prerequisite for the agent's work
   (tenet 4).
5. Prompt-only constraints eventually fail; enforce them through mechanisms.
   Codex still failed with "always end with wait" in its prompt, leading to
   a Stop hook. Voluntary `tmm done` led to automatic hook capture.

## Tenet 6: CLI First

**Why.** An agent managed only by a human cannot manage teammates. Agents
must be able to start one another, delegate, review and stop work, with
humans intervening only when needed. Their commands must reach every
management operation, and integration must fit in one system-prompt line.

**Evidence.**
- `tmm agent list` shows the session and teammates' state; `tmm log` reads
  the room, including full-history `--grep`; `tmm spawn` and
  `tmm project up|down` start and stop workspaces; `tmm registry save` and
  `tmm teams save` define agents and teams.
- Every project / agent / board verb has a `tmm` command, with CLI/UI parity.
- `tmm done` returns to whoever provided the brief, so agents can delegate
  and receive results just like people.
- The owner's high-priority guidance: when context is unclear, search
  history with `tmm log --grep` and ask the other party directly with `@`;
  do not guess. Answer every addressed message and consolidate queued replies.

**Implications.**
1. A new UI action and its corresponding `tmm` command land in the same
   commit, in either direction.
2. `tmm` output is for agents to read: stable, searchable with grep and
   free of decoration.
3. Every new command must explain what an agent cannot do without it.
   Add nothing without an answer. A 2300-line `tmm-cli.md` is itself a sign
   of excess. Owner: "太长了不对，接下来优化".

---

# B. How We Build

## Tenet 7: Declaration Is Truth

**Why.** A tmux session exists only in the tmux process and disappears when
that process restarts. If closing a workspace creates reconstruction work,
people leave it open and sessions accumulate. Making closure cost nothing
is the only way to control that accumulation. This complements tenet 4:
running state does not depend on us (4), but we can rebuild it (7).

**Evidence.**
- Project = `{ path, name, session, slots[] }`, persisted in state.db.
  `up` matches windows by name and idempotently fills gaps without reordering
  or restarting existing windows.
- A managed agent's `launch.json` is written **before** window creation;
  failure to write it fails the spawn. A recipe-free restart once left an
  agent able to answer but unable to receive messages: "能答但聋" (2026-08-18).
- Restart **rematerializes** from the current registry and AGENTS.md before
  replaying, rather than replaying an old recipe verbatim (2026-09-08).
- Rejected: a `snapshots` table with depth 20. Measurement found only one
  entry per project, and `restore` changed the declaration but not the
  projection. It was deleted.

**Implications.**
1. Anything that may be repeated must be idempotent. State that cannot be
   reconstructed from a declaration is a bug.
2. Persistent state lives only in state.db and `<ws>/.tmm/`. Window names,
   pane contents and processes are not storage.
3. Agent configuration on disk is part of the code. Fixing a hook must make
   already-spawned homes self-heal at the next launch (`refresh_hooks`);
   otherwise the fix has not reached its users.
4. Migrations must accept older declarations and use `PRAGMA foreign_keys=OFF`.

## Tenet 8: Derive, Never Declare

**Why.** Agents can be wrong, forget or be interrupted. Screen activity
does not establish that work is happening. Trust the observed edges:
who opened a turn and who received a final response. Two definitions of
one concept will eventually diverge.

**Evidence.**
- `running | waiting | idle` are derived from hook turn edges.
  `window_activity` once meant working, but TUI redraws after completion
  left every agent permanently working. Claude's `idle_prompt`, appearing
  exactly 60s after completion, was once mistaken for a question.
- Managed identity is determined by an isolated home through
  `projects::managed_home`, shared by all three entry points. Seven
  separately assembled detection haystacks once included one that omitted
  the window name; `detect_pane` unified them.
- Agent names are validated once at the **entry boundary**, using the
  intersection of four parsers' allowlists. The trigger was
  `agent_remove("../..")` nearly deleting the workspace.
- Delivery acknowledgment requires a matching `userPromptSubmit` echo,
  not a successful `send-keys`. Seven fixes addressed queues, newlines,
  truncation and file pickers.

**Implications.**
1. Give every concept one definition function and use it everywhere.
   Reject a second copy of the decision logic in review.
2. Validate inputs at their entry boundary and trust them inside.
   Do not repeat validation at every internal layer.
3. `tmm status` is an agent's account of what it is doing, for display only;
   it never participates in status derivation.
4. Reading screens for vitals or recovery is legitimate observation of
   information a person can also see. Missed reads are normal: retain the
   previous value, anchor matching to structure instead of scanning all text,
   and never guess fields with no identifiable structure.

## Tenet 9: One Mechanism per Job

**Why.** A copied component begins drifting immediately and silently:
two pages may each look correct while disagreeing with one another.
This is the repository's most common regression pattern: sidebar titles
drifted three times, to-tail buttons had two forms, DirPicker had two copies,
platform detection had five, and 39 components declared their own mono stack.
The same applies to decision logic, renderers and popover positioning.
For UI, the shared unit is the interaction, state and accessibility contract,
not merely matching colours or rounded corners. Different jobs need distinct
semantics: a command, a choice and navigation are not interchangeable buttons.
**Duplicate implementations are the leading source of quality debt.**

**Evidence.**
- Dropdowns use only `ui/Select`; right-click/long-press uses
  `ui/ContextMenu` + `ui/longpress`; fixed popovers use `menuPlacement`;
  back-to-tail uses `.to-tail`; status dots use `.live-dot`.
- Markdown uses the one `marked` singleton registered by
  `core/markedSafeUrl.ts`. Files once called its own `marked.parse`,
  allowing README `<img onerror>` content to execute in the token-bearing origin.
- New projects use only `CreateProjectDialog`, removing 120 lines from Sessions.
- `*.source.test.ts` deliberately makes a new visual species fail tests.
- Board #154 (2026-09-10) found Settings and Agent configuration using
  different control geometry, membership pills for boolean and multi-choice
  values, an enabled pristine Save and unguarded draft exits. Shared styling
  alone would not correct the interaction.

**Implications.**
1. Search for an existing mechanism before writing another. Use it, or
   **change it** if it does not fit; do not create a parallel implementation.
   A new visual species is a regression. Shared reuse includes the interaction,
   state and accessibility contract, not just appearance.
2. Shared atoms live once in `app.css` / `ui/`. Component-scoped CSS must
   not redeclare them: specificity (0,2,0) silently beats (0,1,0).
   Reuse includes enabled, selected, pending, error, focus, keyboard and touch
   behavior. Pages supply their data and persistence mode, not another dialect.
3. A failing source-contract test means a change must be deliberate.
   Read the test before fixing it.
4. Prefer deleting code to adding it. Making a file shorter is a benefit.
5. Test shared behavior through its consumers. A token/source check cannot
   establish draft safety, target reachability or accessible control semantics.

## Tenet 10: Two Screens, One Standard

**Why.** Both use cases are essential: glance and speak from a phone away
from the workstation, then compare agents, browse files and read long
conversations on a desktop. A phone is not a reduced desktop; a desktop is
not an enlarged phone. Each needs its own complete form of **one** design
language. Aesthetics, usability and guiding motion are part of function,
not finishing work. In every view a person must know the current object,
its state, the available actions and where returning will take them. A UI
that cannot distinguish a running agent from one waiting for the user is
incomplete. Owner: "注意当前我整体比较满意，不要大变样".

**Evidence.**
- Both layouts share typography, control, state and motion contracts.
  Desktop has a rail, splits and resizable navigation; mobile has reachable
  touch targets, drawers, edge-back gestures and sheets. These are different
  forms of the same interaction, not permission to reduce either experience.
- Appearance conveys function: resting states are achromatic; running
  states use a `.live-dot` halo. Status dots never animate opacity. Colors
  form a vocabulary: green means only "ended well", brand colors stay fixed,
  and a hue cannot have two meanings within the same status mark.
- Motion conveys direction: enter deeper views from the right, return
  from the left, using one sliding grammar. Historical feedback on the
  symmetric server-switch glyph, "180 度相当于没有变化", explains why that
  glyph needs a visible turn; it is not a rule for every arrow. Exact motion
  and its exceptions belong in the motion design.
- Usability has concrete rules: confirm destructive actions, put confirmation
  on the far right, leave only after success, keep popovers reachable,
  preserve native text selection and return context, and fold content
  rather than crop it. The approved configuration direction distinguishes
  immediate preferences from explicitly saved drafts (board #154, 2026-09-10);
  implementation and verification belong to its controls/form changes.
- Historical icon-action feedback favoured removing decorative frames and
  excessive colour or explanatory copy:
  "像一个系统状态的监控一样，不要过度占用人的注意力".
  This does not prohibit field boundaries, visible focus or necessary labels.

**Implications.**
1. Every feature needs a complete, appropriate form on both screens.
   Deferring either screen does not count as completion. Review both.
2. Use existing tokens and atoms only. A raw px value, literal color or
   second sliding tempo is a regression. Values live in
   [design-language.md](design-docs/features/design-language.md), not these
   tenets; [tokens.source.test.ts](../src/lib/ui/tokens.source.test.ts) and
   [motion.source.test.ts](../src/lib/ui/motion.source.test.ts) pin the type
   and motion vocabulary. Adapt layout to available space and controls to input capability.
   Keep names, reading space and actions reachable; a wide touch device still
   needs touch controls.
3. Motion must communicate direction, state or entry/exit. Add none without
   an answer to what it guides. Page switches must not flash into place.
   Where the navigation slide applies, content arrives with the new page;
   a desktop rail switch does not inherit touch navigation motion.
   All looping animations stop under reduced-motion.
4. Use one meaning per state across views. Selection is not a command,
   pending is not disabled, failure is not empty, and colour is not the only
   signal. Keyboard, touch, focus and reduced-motion states are part of the
   same contract.
5. Follow familiar interaction patterns with explicit scope, not blanket
   appearance rules. Back returns to the origin; all exits protect drafts
   and reading position. Hover and shortcuts supplement a discoverable path.

## Tenet 11: Restraint

**Why.** The owner repeatedly asks for "克制", "不留冗余" and "不过设计":
restraint, no redundancy and no overdesign. Extra prompt text consumes
agent context, extra buttons consume attention, and speculative features
create maintenance debt. None of the mechanisms removed outright has been
requested back: message deletion, notification UI, `status waiting|blocked`,
the agora bus, snapshots, pull-to-refresh or bubble long-press menus.
Restraint removes noise, not information needed to identify an object,
understand its state, choose an action or return safely.

**Evidence.**
- CLAUDE.md shrank from 117KB to an 11KB map. Source directories have no
  second instruction entry point.
- No synthetic first message without a brief: "多此一举". Agent cards have
  no three-dot button or Bedrock suffix; effort appears only when expanded.
- Prompt feedback: "就说他是一个非常 powerful 的 developer 就行…人狠话不多";
  "不用上价值，
  就说明白大家是如何协作的流程就好".
- UI copy feedback: "不要把你的很多设计直接写在文字上…不是靠多文字提示就易用性越强".

**Implications.**
1. Before adding, ask what can be removed. Remove a replaced mechanism
   completely, without a compatibility layer.
2. Inject process instructions only: no value speeches or duplication of
   the tools' own documentation.
3. Every UI word, button and background color must explain what the user
   would get wrong without it. Keep necessary labels, errors, consequences
   and accessible names; icon-only design must not sacrifice discoverability.
4. Lead human-facing explanations with the conclusion. Use fewer words
   and do not repeat yourself.

---

# C. How We Work

## Tenet 12: Rules Live with Their Design

**Why.** A rule without its reason gets optimized away; a rule without an
incident is hard to trust. An outside-style review on 2026-09-03 produced
70 fixes in one day, largely for rules documented but not implemented.
The owner said "感觉之前修过，是不是文档里没写好，导致又改错了".
AGENTS.md is only the map. Rules belong in the corresponding design
document, with dates, measurements and the failures that triggered them.
Repeated notes such as "measured on codex 0.148.0" describe a method,
not rhetoric: **measure, do not guess**.

**Evidence.**
- `send_command` waits 200ms between text and Enter: codex 0.148.0 treats
  immediately following Enter as part of a paste.
- tmux >=3.4 octal-escapes `\x1f`; `-t name` is prefix matching, so
  `kill_session("dev")` killed `dev-2`. External systems have versions and
  parsing rules; consult their documentation instead of relying on intuition.
- Each design document ends with **Rules and their reasons**. Every
  regression fix starts with a failing test and uses a negative control:
  deliberately break one thing and verify that exactly one corresponding test fails.
- Documents, scripts and tests become stale silently: three documents
  promised an unimplemented double-tap gesture, CLAUDE.md named nonexistent
  symbols, and fetch-fonts.sh produced different files from those index.html loaded.

**Implications.**
1. Behavior changes and the corresponding design-document updates belong
   in the same commit. A code-only behavior change is incomplete.
2. Record rules as decision + reason + date + triggering incident or measurement.
3. Measure uncertain behavior on real CLI versions and devices, then record
   the version. Green tests are not proof: four times the source tests
   passed while the owner was viewing an old APK.
4. Make a rule executable as a test whenever possible. A rule that can only
   live in prose still lacks a sufficiently precise boundary.

## Tenet 13: Isolate, Verify, Commit Small

**Why.** Separate worktrees prevent concurrent agents from interfering.
A shared checkout once mixed another issue's hunks into a commit, broke
someone else's checks and let an interrupted editor insert duplicate tests.
One logical change per commit makes review and rollback operate on one idea.
Discuss a plan before large changes instead of immediately editing code.

**Evidence.**
- One worktree per task; the launch checkout is only for coordination and
  integration (owner, 2026-09-04).
- Tests and documentation land with code. A new module's
  `<module>.test.ts` and both i18n language branches land in the same commit.
- Separate mechanical moves from logic changes. Append commits; do not amend.
- Preserve the human Git author; the agent adds a co-author trailer only.
- The owner said three times: "先讨论方案，不要直接修改代码".

**Implications.**
1. Commit as soon as verification passes; do not leave verified work uncommitted.
2. Each commit answers one question. Separate incidental changes and keep
   scope isolated. Owner: "你不是只改了
   terminal 为什么其他页面也变了".
3. Do not absorb another person's dirty tree or commit unrelated work in progress.
4. Present a plan in the room and get owner confirmation before changes to
   architecture, design language or feature removal.
5. The lead divides work to avoid conflicts, not to take over implementation.
   Different people perform adversarial review; self-testing does not replace
   independent acceptance.

---

## Disciplines and Guidance

`docs/guidance/` organizes these tenets into loosely coupled review disciplines,
each with its own checklist, so agents can review separate dimensions:

| Discipline | File | Main Tenets |
|---|---|---|
| Architecture and boundaries | `guidance/architecture.md` | 2, 4, 7, 8 |
| Agent bridge | `guidance/agent-bridge.md` | 3, 5, 6 |
| Code quality | `guidance/code-quality.md` | 1, 9, 11 |
| UI and interaction | `guidance/ui-design.md` | 10, 11 |
| Security | `guidance/security.md` | 8 |
| Process and testing | `guidance/process.md` | 12, 13 |

Gaps between these tenets and the implementation, plus remaining work:
`docs/todo.md`.
