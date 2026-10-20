# AGENTS.md — tmux-mobile

This file is the MAP, not the manual. It says why the project exists, the
tenets every decision answers to, the rules every change must respect, and
where everything else is written down. A rule belongs next to the design it
protects (`docs/design-docs/…`), never here: when you verify a change, update
that design doc and commit together. (`AGENTS.md` is a symlink to this file —
they are one document.)

## Tenets

We are a **shell, not an engine**. tmux owns processes and sessions, the agent
CLIs (kiro, claude, codex, grok, omp, kimi, dsh) own intelligence and their own harness,
MCP and skills own tools. We own four things — the **connection**, the
**room**, the **identity**, the **window** — and a person can always walk back
to the terminal and take over. Full text with reasons and evidence:
[docs/tenet.md](docs/tenet.md) · per-dimension rules and review checklists:
[docs/guidance/](docs/guidance/) · the gap between them and today's code:
[docs/todo.md](docs/todo.md).

**How we think**
1. **First principles.** Name the root cause and the layer it lives in before touching code; a fix for a symptom returns wearing another face. → [code-quality](docs/guidance/code-quality.md)

**What we are**
2. **A shell, not an engine.** Reach the CLI through its documented doors (env, config files, hooks, flags); never rebuild what tmux or a CLI already does. Adding a backend touches one file. → [architecture](docs/guidance/architecture.md)
3. **The real CLI in a real pane.** No ACP-style invisible wrapper, no modified harness; we only watch through hooks and type into the pane, and a human can take over any session at any time. → [agent-bridge](docs/guidance/agent-bridge.md)
4. **No central node.** Sessions live in tmux; if our server dies, every agent and every human keeps working. `tmm` never blocks. → [architecture](docs/guidance/architecture.md)
5. **One native bridge, three primitives.** Text typed into a pane, hooks observed, `tmm` invoked by the agent — for human↔agent and agent↔agent alike. One room; humans and agents read the same record. → [agent-bridge](docs/guidance/agent-bridge.md)
6. **CLI first.** Whatever a human can do in the UI an agent can do with `tmm`: read the room, see who is working, spawn and stop teammates. A command that no agent needs is not added. → [agent-bridge](docs/guidance/agent-bridge.md)

**How we build**
7. **Declaration is truth; the running state is a disposable projection.** state.db and `<ws>/.tmm/` are the only stores; everything else can be killed and rebuilt idempotently. → [architecture](docs/guidance/architecture.md)
8. **Derive, never declare.** Status comes from turn edges, not pane activity or an agent's own words; one definition function per concept; inputs validated once, at the door. → [architecture](docs/guidance/architecture.md) · [security](docs/guidance/security.md)
9. **One mechanism per job.** A second implementation drifts silently; a new visual species is a regression. Delete before you add. The shared unit is the interaction, state and accessibility contract. → [code-quality](docs/guidance/code-quality.md)
10. **Two screens, one standard.** Phone and desktop each get a complete form of one design language; beauty, usability and guiding motion are function, not polish. Use existing tokens and atoms only; a raw px value, literal color or second sliding tempo is a regression. Make the object, state, available actions and return destination clear. Adapt layout to available space and controls to input capability. → [ui-design](docs/guidance/ui-design.md)
11. **Restraint.** Fewer words, fewer buttons, fewer rules; a replaced mechanism is removed whole. Delete rather than retain; do not overdesign. Do not remove what a person needs to identify, act or return. → [ui-design](docs/guidance/ui-design.md) · [code-quality](docs/guidance/code-quality.md)

**How we work**
12. **Rules live with their design, with the reason and the incident.** Measure on the real version, write the version down; a rule that can be a test is a test. → [process](docs/guidance/process.md)
13. **Isolate, verify, commit small.** One worktree per task, one idea per commit, docs and tests in the same commit; discuss before large changes. → [process](docs/guidance/process.md)

The non-negotiables below are the tenets' enforced, mechanizable form.

## What this is

Tauri 2 cross-platform app (Rust + Svelte 5) for monitoring and controlling
tmux sessions from a phone, and — through the **Hub** — for running and
talking to AI coding agents (kiro, codex, claude, grok, omp, kimi, dsh) inside those sessions.
WebSocket JSON-RPC with token auth + optional E2E encryption. Targets: Android
(primary), macOS desktop, browser/PWA.

- **Frontend**: Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`), Vite 6, TypeScript (migration in progress), xterm.js v6
- **Backend**: Rust (Tauri 2), tokio, tokio-tungstenite, rusqlite (`state.db`)
- **Preview / rendering**: highlight.js, marked (+ KaTeX in chat), mermaid, pdfjs-dist
- **Agent side**: the `tmm` CLI (`src-tauri/src/bin/tmm.rs`) + hooks telemetry; no MCP for the integration itself
- **Layout**: `src/lib/{app,core,files,hub,projects,sessions,system,terminal,ui}` · `src-tauri/src/{server,projects,bin}` (backend map: [docs/reference/backend-map.md](docs/reference/backend-map.md))

## Commands

```bash
npm run dev:all          # Vite :5173, proxying /ws to the gateway (browser dev loop)
npm run gateway:update   # rebuild + restart the gateway (after each merge, once switched)
npm run tauri:dev        # desktop app + server
npm run build:server     # server + tmm, no webview needed
npm run build:android    # APK (aarch64) — ends with the build-dir postflight
npm test                 # frontend + script tests (node --test, no tmux)
npm run check            # svelte-check (the ONLY type check)
npm run test:rust        # Rust tests, sequential, needs a running tmux
npm run test:e2e:docker  # 3 isolated gateways in Docker: the environment smoke for multi-server work
```

Everything else about running and building — the supervised units on this host
(**do not restart them**), the `gui` Cargo feature and headless build,
`incremental = false`, port preflight, the Android build-dir postflight,
`pnpx` — is in [docs/conventions/development.md](docs/conventions/development.md).

## Non-negotiables

Each links to the doc that holds the reason and the details.

1. **The design language is a contract** — six type steps, three font roles, the radius scale, two hover families, ONE popover mechanism, `--t-fast/--t-move`, 760px compact, 44px touch. A new visual species is a regression; source tests enforce it. → [design-language.md](docs/design-docs/features/design-language.md)
2. **TypeScript rules**: explicit `.ts` in relative imports, erasable syntax only, `npm run check` is the type check, convert `.js` file-by-file with no logic change in the same commit. → [conventions/frontend.md](docs/conventions/frontend.md)
3. **Platform checks**: `isAndroid` before `isTauri`; `await tauriReady` before any plugin; Android opens files through `AndroidFileOpener`, never `tauri-plugin-opener`. → [conventions/frontend.md](docs/conventions/frontend.md)
4. **Isolate, verify, then commit** — coding agents develop each tracked-file task in its own Git worktree under `<repo>/worktree/<agent>-<task>` (gitignored; never outside the repo; the launch checkout is coordination/integration only), then commit every verified logical change with the active agent's co-author trailer; never absorb another dirty tree or commit `agent-team-page/`. → [conventions/development.md](docs/conventions/development.md)
5. **Tests**: `npm test` for the frontend, `npm run test:rust` (sequential, shared tmux) for Rust; source-contract tests (`*.source.test.ts`) pin markup and CSS on purpose — read the test before "fixing" it. → [conventions/testing.md](docs/conventions/testing.md)
6. **One mechanism per UI job**: `ui/Dialog` for every modal (`ui/ConfirmDialog` is the one confirm inside it), `ui/Select` for every dropdown, `ui/ContextMenu` + `ui/longpress` for right-click/long-press, `menuPlacement` for every fixed popover, `.to-tail` for every back-to-tail control, `.live-dot`/`stateDotColor` for the one status colour language (at rest is achromatic). → [design-language.md](docs/design-docs/features/design-language.md), [ui-unification.md](docs/design-docs/features/ui-unification.md), [hub-feed.md](docs/design-docs/features/hub-feed.md)
7. **Terminal key encoding**: Ctrl keys go to tmux as NAMED keys (`extended-keys on` drops raw C0 bytes); device-attribute responses are filtered before forwarding; a hidden terminal records frames and never renders them. → [terminal-rendering.md](docs/design-docs/pages/terminal-rendering.md)
8. **The keyboard is an overlay for agent TUIs** (`.keep-rows`), a resize for everything else; printable keys bypass xterm's keydown so CJK IMEs work; only `unlockKeyboard()` and friends may touch `kbLocked`. → [terminal-keyboard.md](docs/design-docs/pages/terminal-keyboard.md)
9. **Projects declare, tmux projects**: every session is a project, `up` matches windows by name, only agent slots are relaunched, migrations run with `PRAGMA foreign_keys=OFF`. A project is named by its NAME, never its folder. → [projects.md](docs/design-docs/features/projects.md)
10. **A managed agent is defined by its isolated home** (`<ws>/.tmm/agents/<name>/`, `projects::managed_home`); its model and effort live in its CONFIG, never on the launch line; the launch recipe (env + PATH + identity) is replayed on restart; the app-wide `<config>/AGENTS.md` is the first block of every prompt (`tmm prompt`). → [agents-overview.md](docs/design-docs/features/agents-overview.md), [agents-overview.md § app-wide instructions](docs/design-docs/features/agents-overview.md#the-app-wide-instructions-lead-every-prompt-2026-09-04)
11. **Final replies follow one reply edge**: hooks record every managed agent's final response and return it once to every agent whose request the turn carried (the edge accumulates until the turn ends, #256); `[reply]` never creates a reverse edge. Status is DERIVED from turn edges — pane activity is not work, Claude's `idle_prompt` is not an ask. → [agent-status.md](docs/design-docs/features/agent-status.md)
12. **Delivery is typing into a pane**: every delivery takes ONE path (`projects::delivery`), and a busy queue-mode kiro/codex — and dsh, whose run loses typed text — gets its lines typed as one combined prompt at its turn's end (#257, #404); `@name` types into one agent, `@all` into every managed agent, no recipient records only; a Team agent also gets the routed room delta since its previous delivery as background; a `/command` goes verbatim to the CLI; a backend with no native commands (dsh) names the few the app runs itself (`/model`, `/effort`, `/new`) through `Backend::app_command`, documented in hub-composer.md; `Escape` is the only interrupt. → [hub-composer.md](docs/design-docs/features/hub-composer.md)
13. **Chat markdown escapes `&` and `<`, never `>`**; images are references, never bytes; messages are not deletable in the UI. → [conventions/frontend.md](docs/conventions/frontend.md), [hub-feed.md](docs/design-docs/features/hub-feed.md)
14. **CLI/UI parity**: every project/agent/board verb exists as a `tmm` command, because an agent that can only be managed by a human cannot manage a teammate. → [tmm-cli.md](docs/design-docs/features/tmm-cli.md)

## Documentation map

`docs/` is divided by the QUESTION a document answers:

| directory | answers | when to read |
|---|---|---|
| `docs/tenet.md` · `docs/guidance/` | WHY we exist and what every decision answers to; per-dimension rules + review checklists | before any design decision, and when reviewing |
| `docs/requirements/` | WHAT the product does (pages, features, API contracts, backend services) | before changing behaviour a user sees |
| `docs/design-docs/` | WHY it is built this way and HOW — `features/` cross-cutting, `pages/` per screen; each ends with **Rules and their reasons** | before touching that area |
| `docs/conventions/` | how we WORK: development loop, frontend rules, testing | first day, and whenever a build misbehaves |
| `docs/reference/` | FACTS to look up: configuration keys, the backend module map | when configuring or deploying |
| `docs/exec-plans/` | HISTORY: dated plans and prototypes that led here | to understand a past decision |
| `docs/todo.md` | the gap between tenets and code; known open problems | before filing a duplicate |

### Requirements (the WHAT)
- Pages: [Terminal](docs/requirements/pages/terminal.md) · [File Browser](docs/requirements/pages/file-browser.md) · [Sessions](docs/requirements/pages/sessions.md) · [Settings](docs/requirements/pages/settings.md) · [Hub (chat, agents, board)](docs/requirements/pages/hub.md)
- Features: [i18n](docs/requirements/features/i18n.md) · [Message notifications](docs/requirements/features/notifications.md) · [System status](docs/requirements/features/system-status.md)
- Contracts: [WebSocket RPC API](docs/requirements/api-contracts/websocket-rpc.md) · [WebSocket server](docs/requirements/backend/services/websocket-server.md) · [tmux wrapper](docs/requirements/backend/services/tmux-wrapper.md) · [Filesystem service](docs/requirements/backend/services/filesystem.md)

### Design — shell, platform, visual language
- [**Design language** (normative)](docs/design-docs/features/design-language.md) · [Motion (principles + vocabulary)](docs/design-docs/features/motion.md) · [Fonts](docs/design-docs/features/fonts.md) · [UI unification](docs/design-docs/features/ui-unification.md) · [App shell (rail, bottom bar, back gesture, restore)](docs/design-docs/features/app-shell.md) · [Desktop split-screen](docs/design-docs/features/split-screen.md) · [Sessions density](docs/design-docs/pages/sessions-density.md)
- [Android platform](docs/design-docs/features/android-platform.md) · [PWA install](docs/design-docs/features/pwa-install.md) · [File handling & security](docs/design-docs/features/file-handling.md) · [Files review comments](docs/design-docs/pages/files-review.md) · [Message notifications](docs/design-docs/features/notifications.md) · [System status](docs/design-docs/features/system-status.md)
- [WebSocket client robustness + server registry](docs/design-docs/features/websocket-client.md) · [Concurrent WS RPC](docs/design-docs/features/concurrent-ws-rpc.md) · [Disconnect grace](docs/design-docs/features/disconnect-grace.md)

### Design — terminal
- [Touch handling](docs/design-docs/pages/terminal-touch.md) · [Gesture state machine](docs/design-docs/pages/terminal-gestures.md) · [Keyboard](docs/design-docs/pages/terminal-keyboard.md) · [Rendering, tail, key encoding](docs/design-docs/pages/terminal-rendering.md) · [Sizing (cols × rows)](docs/design-docs/pages/terminal-sizing.md) · [Cursor layout](docs/design-docs/pages/terminal-cursor-layout.md) · [Color adaptation](docs/design-docs/features/color-adaptation.md) · [xterm build-time patch](docs/design-docs/features/xterm-patch.md)

### Design — projects, agents, hub
- [Projects (declarative workspaces)](docs/design-docs/features/projects.md) · [Agents overview (CLI substrate, hooks, isolated homes, registry)](docs/design-docs/features/agents-overview.md) · [Agent status (derived state, deliveries, vitals, recovery)](docs/design-docs/features/agent-status.md) · [Agent lifecycle](docs/design-docs/features/agent-lifecycle.md) ([中文](docs/design-docs/features/agent-lifecycle.zh.md)) · [Agent notifications (hooks)](docs/design-docs/features/agent-notifications.md)
- [tmm CLI (the agent's hands)](docs/design-docs/features/tmm-cli.md) · [Agent teams (§ in agents overview)](docs/design-docs/features/agents-overview.md#agent-teams-board-74) · [Hub feed](docs/design-docs/features/hub-feed.md) · [Hub composer](docs/design-docs/features/hub-composer.md) · [Task board](docs/design-docs/features/board.md)

### Conventions, reference, history
- [Development (commands, dev loop, build gotchas)](docs/conventions/development.md) · [Frontend conventions](docs/conventions/frontend.md) · [Testing](docs/conventions/testing.md)
- [Configuration reference](docs/reference/config.md) · [Backend module map](docs/reference/backend-map.md)
- [Execution plans (history)](docs/exec-plans/)

## One entry point

This is the ONLY memory file in the repository (owner, 2026-09-02: source
folders carry no `CLAUDE.md`/`AGENTS.md` — a second entry point is a second
place to look). Everything else is under `docs/`. `temp/` is gitignored
scratch and `.tmm/agents/*/` are generated agent homes; files inside them are
not project memory.
