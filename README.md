<p align="center">
  <img src="assets/icon.svg" width="128" alt="tmuxmobile"><br>
  <img src="assets/logo.svg" width="220" alt="tmuxmobile">
</p>

<p align="center">
  <strong>Your coding agents, running for real in tmux — watched, directed and handed back from your phone or your desk.</strong><br>
  <sub>A shell around tmux and the agent CLIs you already use. Nothing is wrapped, nothing is re-implemented, and you can always walk back to the terminal and take over.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-Rust-orange?style=flat-square" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Svelte_5-Frontend-ff3e00?style=flat-square" alt="Svelte 5">
  <img src="https://img.shields.io/badge/xterm.js_6-Terminal-00d4ff?style=flat-square" alt="xterm.js 6">
</p>

---

You run Kiro CLI, Claude Code, Codex, Grok, OMP or Kimi Code inside tmux.
tmux-mobile connects those real sessions to your phone or desktop, gives every
project a chat room shared by you and your agents, and lets agents spawn, brief
and review one another.

## Design philosophy

**A shell, not an engine.** tmux owns processes and sessions. Each agent CLI
owns its intelligence and its harness. MCP servers and skills own the tools.
tmux-mobile owns only four things:

| We own | What it is |
|---|---|
| **Connection** | WebSocket JSON-RPC, token auth, optional end-to-end encryption, several servers |
| **Room** | A chat room and a task board per project; agent status derived from what agents do |
| **Identity** | Agent and team definitions, each agent spawned into its own isolated home |
| **Window** | A complete phone UI and a complete desktop UI |

Everything else follows from that boundary:

- **The real CLI in a real pane.** No protocol wrapper and no modified harness.
  We reach a CLI only through its documented doors: environment, config files,
  hooks and launch flags. A person can take over any session at any time.
- **No central node.** Sessions live in tmux. If our server stops, every agent
  and every human keeps working.
- **One bridge, three primitives.** Text typed into a pane, hooks observed from
  outside, and `tmm` run by the agent. Humans and agents talk the same way and
  read the same record.
- **CLI first.** Whatever a human can do in the UI, an agent can do with `tmm`,
  including spawning, briefing and stopping teammates.
- **Declaration is truth.** A project is a declaration. The running tmux session
  is a disposable projection that can be rebuilt after a reboot or a week away.
- **Derive, never declare.** Agent status comes from observed turn edges, never
  from pane activity or an agent's own words.
- **Restraint.** One mechanism per job; fewer words, buttons and rules. Phone and
  desktop each get a complete form of one design language.

The full tenets, with the reasons and incidents behind each, are in
[docs/tenet.md](docs/tenet.md).

## What you can do

- **Hub** — one room per project. Address an agent with `@name`, a team by its
  name, or everyone with `@all`. Spawn agents or whole teams from the registry,
  watch their status live, and open any agent's terminal, the project's files or
  its board without leaving the conversation.
- **Task board** — todo / doing / review / done per project; agents work it with
  `tmm board`.
- **Agents and teams** — define backend, model, effort, persona, skills and MCP
  servers once; every spawn gets an isolated home.
- **Terminal** — the same tmux pane you have at your desk, with touch scrolling,
  shortcut keys, and a keyboard that overlays agent TUIs instead of resizing them.
- **Files** — browse, preview (Markdown, code, images, PDF, CSV, HTML, PPTX) and
  edit, with a built-in git panel to diff, commit and push.
- **Projects** — every tmux session is a project you can bring up, take down or
  archive.
- **`tmm`** — the agent's hands: `send`, `log`, `board`, `spawn`, `project`,
  `registry`, background `task`s and more. It fails soft in about 20 ms when the
  server is away, so an agent never blocks on it.

The server runs on macOS or Linux next to tmux. The UI runs in any browser, as a
PWA, or as a native app on macOS and Android.

## Getting started

```bash
npm install
npm run build:server   # the server and the tmm CLI, web UI embedded
src-tauri/target/release/tmm gateway   # the backend, as a background service
npm run dev:all        # Vite on 127.0.0.1:5173 — open http://localhost:5173 (TMUX_MOBILE_DEV_HOST=0.0.0.0 to reach it from another device)
```

To install the app and the background gateway rather than build from source, see [docs/reference/install.md](docs/reference/install.md).

The first launch writes a token to `~/.config/tmux-mobile/config.toml`.
Prerequisites, the desktop and Android builds and remote access are in
[docs/conventions/development.md](docs/conventions/development.md); every
configuration key is in [docs/reference/config.md](docs/reference/config.md).

## Documentation

- [Tenets](docs/tenet.md) — why the project exists and what every decision answers to
- [Guidance](docs/guidance/) — per-dimension rules and review checklists
- [Documentation map](CLAUDE.md) — requirements, design docs, conventions and reference
- [WebSocket RPC API](docs/requirements/api-contracts/websocket-rpc.md)

## License

MIT
