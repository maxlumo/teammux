# Guidance: Adding an Agent Backend

> Tenets: 2 (a shell, not an engine: one file per backend), 3 (the real CLI in
> a real pane), 8 (derive, never declare), 12 (measure on the real version).
> Review questions: **Which documented door does this use? On which CLI
> version was it measured? What happens when the read fails?**
> Draft · 2026-11-08. Written from adding pi (board #71) and the fixes that
> followed it (#65, #66, #70, #72, #74, #77, #79); owner 2026-11-08: "把新加
> Agent 的过程写在文档里…去 check 到底哪些东西做好了，哪些没有做好".

Use this page as the definition of done for a new backend: every box is either
done with its evidence, or named as a gap in that backend's section of
[agents-overview.md](../design-docs/features/agents-overview.md). The reasons
behind each rule live in the linked design sections; this page is the list.

## 1. Principles

1. **One backend file, one enum arm per concern.** All knowledge of the CLI
   lives in `src-tauri/src/backends/<name>.rs`. `enum Backend` in
   `backends/mod.rs` dispatches every concern through an exhaustive `match`, so
   the compiler lists each method the new arm must answer. A backend name
   spelled anywhere else fails `backend_literals_live_only_in_backends`
   ([§ Backend knowledge lives in one file per backend](../design-docs/features/agents-overview.md)).
2. **Only documented doors:** environment, config files, hooks or extensions,
   launch flags. Read the CLI's own docs and package source, cite file and line,
   and write down the version measured.
3. **Reuse before copying.** When the CLI is a sibling of a supported one (pi
   and omp), share the mechanism (`pi_telemetry.rs` generates both telemetry
   extensions) and keep only the measured differences apart.
4. **Measured in the Docker live rig, never on the host.** A unit test pins a
   shape; a case in `pnpm run test:live:docker <case>` proves the real CLI
   behaves that way, on the committed tree.
5. **A read that fails is unknown, never a reassuring default.** A config that
   cannot be read is not "the default model" (#65), a pane that cannot be
   listed is not "CLI running" (#77), a screen that cannot be captured is not
   "no menu open" (#66).

## 2. The checklist

### 2.1 Registration

- [ ] The `Backend` variant, its place in `ALL` and `NAMES`, and its `parse`
      and `name` arms. Then answer every method the compiler asks for.
- [ ] The `known()` row: the program name the pane really runs, measured from
      `pane_current_command` and `/proc` (pi sets `process.title`, so `pi`; the
      npm codex is `node …/codex`). Status, restore and the not-running state
      (#65 item 3) all read it.
- [ ] Frontend: the `AGENTS` row and icon in `src/lib/core/agents.ts`,
      `public/assets/<name>.svg`, and the `NAMES` pin in
      `src/lib/core/backends.source.test.ts`. Colour, efforts and input modes
      come from the server's `backends_list`; the client's switches
      (`FALLBACK_*`, the colour switch in `hub.ts`) are frozen fallbacks for
      older servers, so nothing is added to them.
- [ ] The scratch environment's `CLI_PROGRAMS` (`scripts/scratch-env.mjs`).

### 2.2 The isolated home and the launch

- [ ] `render_<name>` writes the managed home: the CLI's config-dir variable
      points at `<ws>/.tmm/agents/<name>/`; the prompt starts with the
      app-wide `AGENTS.md`, then the persona; skills and MCP through the CLI's
      own door ([§ Agents v2](../design-docs/features/agents-overview.md),
      [§ The app-wide instructions lead every prompt](../design-docs/features/agents-overview.md)).
- [ ] User files the CLI needs (credentials, provider config) are LINKED with
      `shared::link_user_file`, never copied. Check how the CLI writes each one:
      in place keeps the link, write-then-rename breaks it (#71 note 8).
      Credentials use the non-replacing policy, so a login made inside the
      agent survives every render, and a conflict refuses with both paths and
      the one step that resolves it (#71 R1).
- [ ] Secrets are files only the owner can read, never on the launch line or in
      a log ([§ A definition's secrets](../design-docs/features/agents-overview.md)).
- [ ] Anything that blocks or phones home at start is switched off through a
      documented setting (pi: `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`,
      project trust).
- [ ] `set_up_need` and `version_program`: `tmm agent backends` says installed,
      set up, and how that was judged ([§ Backend readiness](../design-docs/features/agents-overview.md)).

### 2.3 Hooks and status

- [ ] A turn's edges come from the CLI's own hook or extension events: prompt
      submitted, tool use, an ask, the turn's end. Map them in the backend file
      (`is_user_prompt_submit`, `cli_own_prompt`, `is_housekeeping_tool`,
      `is_idle_nudge`, `failed_end`). Choose the event that means DONE: pi's
      `agent_settled`, not `agent_end`, which fires again on retries
      ([agent-status.md](../design-docs/features/agent-status.md)).
- [ ] The final reply is recorded once and returned to whoever asked
      (`is_empty_reply`, `reply_quality`).
- [ ] Status comes from those edges only. Where a screen must be read (ready,
      a menu), match its structure, never a prefix
      ([§ A CLI's painted shape is matched by its structure](../design-docs/features/agents-overview.md)).
- [ ] A CLI that exits to the shell shows as not running, never idle, and a
      message to it is held instead of typed into the shell (#65 item 3, #77).
      Both follow from a correct `known()` row; test it with a fake CLI that
      exits.

### 2.4 Restart, resume, fork, new conversation

- [ ] `resume_exact` and `resume_command`: the exact conversation id first, the
      directory's latest second, a fresh start last, each with measured flags
      (pi: `--session-id`, `--continue`).
- [ ] A conversation the CLI will refuse to resume starts fresh, and the room
      says why; never a dead shell (#74, codex after a provider switch). Decide
      from data the CLI wrote itself, gated to the measured version.
- [ ] `current_thread`, `new_conversation`, `command_effect`: what a new
      conversation is and how its effect is seen, so
      `tmm send "@x /new" --when-idle` takes effect safely (#45).
- [ ] Fork gives a fresh home and a fresh conversation; a restart replays the
      recipe ([§ Fork](../design-docs/features/agents-overview.md)).

### 2.5 Delivery and slash commands

- [ ] Input mode: offer steer only where queue and steer were both measured
      (`switches_input_mode`); otherwise queue
      ([§ The input mode](../design-docs/features/agents-overview.md)).
- [ ] `loses_busy_input` and `input_ready` if the CLI loses text typed while it
      runs (dsh).
- [ ] `at_opens_picker`: if `@` opens a file picker, deliveries carry `＠`
      (omp, pi).
- [ ] Menus: `picker_open` reads a menu by its key-hint row's shape and
      `picker_holds_delivery` holds a line while one is open; a screen that
      cannot be read holds too, and a later read releases it (#66). Survey
      every menu the CLI has (`/new`, `/model`, …) AND its normal footer, which
      must not match.
- [ ] Slash commands: the palette's list (`src/lib/hub/<name>-commands.ts`, read
      by `offeredCommands`), each typed verbatim; `slash_opens_picker` and
      `picker_guard` where a command opens a menu. A CLI with no native
      commands names the few the app runs itself (`app_command`, dsh;
      [hub-composer.md](../design-docs/features/hub-composer.md)).
- [ ] `/model`, the effort change and `/new` sent from the Hub take effect, and
      a restart brings back the defined model and effort (the pi live case).

### 2.6 Failure handling

- [ ] Provider failures are classified once: a model id the provider rejects is
      for a person to fix, and the notice names the model the agent was
      launched with; a 429 or 5xx stays retryable even when its text mentions a
      model (`provider_failure`, `model_id_error`, #65 item 2).
- [ ] `recovery_shapes`, `transient_shape`, `person_paint`: the screens the CLI
      paints when it is stuck, each with the version it was measured on.
- [ ] Every read that can fail has a stated unknown path (Principle 5) and a
      test that makes that read fail.

### 2.7 The agent definition and the UI

- [ ] A shipped default definition: `reg_seed` inside the `backend-seeds`
      fence (`projects/store/registry.rs`) for a fresh store, and a migration
      step that backfills an existing one, both from one shared system-text
      constant (omp v18, kimi v22, dsh v32, pi #79). Back up the store before
      deploying a migration.
- [ ] Registry and team saves accept the backend and refuse values it would
      ignore (the omp incident in
      [§ Backend knowledge](../design-docs/features/agents-overview.md)).
- [ ] The Agents page lists it, greyed when it is not installed
      ([§ The Agents list](../design-docs/features/agents-overview.md)).
- [ ] A definition field only this backend has is gated by a login capability,
      so a newer client never saves it to an older server that drops it (#72).

### 2.8 Models and effort

- [ ] `model_list` comes from the CLI's own catalogue or the user's config:
      authoritative only when the source is complete, otherwise suggestions
      that never refuse a typed id; cached under a digest of its source, never
      the source text (#70; [§ Model catalogue](../design-docs/features/agents-overview.md)).
- [ ] `effort_values` are the CLI's real levels; a value it would ignore is
      refused at save.
- [ ] The model lives in the managed config, never on the launch line, except
      where a resume restores the session's own model and the flag mirrors the
      config (omp, pi)
      ([§ A managed agent's MODEL lives in its config](../design-docs/features/agents-overview.md)).
- [ ] Limits the provider imposes (request size, context window) are measured
      in the rig and set in the managed config, with the arithmetic beside the
      measured numbers in [config.md](../reference/config.md) (#66: codex
      compacts at 700,000 tokens under UST's 10 MB body limit).

### 2.9 Live evidence and documentation

- [ ] A live case in `docker/live/live-check.sh` with its `NEED` entry in
      `scripts/live-docker.mjs`, the CLI pinned in `docker/validator/Dockerfile`,
      and credentials staged inside the rig, never read from the user's home
      (#71 option B).
- [ ] Docs in the same commits: an agents-overview section
      `### The <name> backend` with the version measured and its known gaps;
      [backend-map.md](../reference/backend-map.md); the backend lists in
      README.md and CLAUDE.md; the tmm-cli skill; the live case in
      [development.md](../conventions/development.md).

## 3. Review Checklist

- Does every `Backend` method have a measured answer for the new arm, or a
  named gap in the backend's section?
- Which CLI version was each shape measured on, and is it written beside the
  code?
- For each read (config, screen, pane, rollout, credential file): what happens
  when it fails, and which test makes it fail?
- Is anything copied that should be linked or shared (user files, telemetry,
  menu reading)?
- Was each live claim seen in the Docker rig on the committed tree?
- Does an older server or client stay correct (capabilities, fallbacks)?

## 4. Lessons (pi, 2026-11-07)

- The live fixture always staged a user credential, so the case where pi
  creates its own was never run; a re-render deleted a login made inside the
  agent until a unit test removed the source (#71 R1).
- A menu read by its first key missed `/experimental`; the next reader took a
  status line ending in `esc back` for a menu. Read the shape, and test both
  the menus and the normal footer (#66).
- "Could not read" turned into a reassuring answer three times in one day
  (#65, #66, #77), which is why Principle 5 exists.
- The shipped default definition was missed because the seed list lives outside
  the backend file (#79); 2.7 now names it.
