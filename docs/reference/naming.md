# Naming: Teammux, and what still says tmux-mobile

The project is **Teammux** (owner, 2026-10-26, board #472). The command stays
`tmm`, the project data stays `<workspace>/.tmm/`, and the repository is
`github.com/maxlumo/teammux` (the old `vokako/tmux-mobile` address redirects).

A person reads the new name everywhere: the README, the docs, the page title and
installed-app name of the web app, the About row, what the binaries print and what
agents are told. The old name remains only in the places below, each for a reason
that is not "we have not got to it". A search for `tmux-mobile` (or `tmux_mobile`,
`TMUX_MOBILE`, `TmuxMobile`, `tmuxmobile`) should land only on these, and `scripts/naming.test.ts` holds this table as a
test: a new old-name string in prose, a UI string or a banner fails it until it says
Teammux or is listed there with its reason.

| Old string | Where | Why it stays | Planned |
|---|---|---|---|
| `tmux-mobile-e2e`, `…/v2/proof`, `…/v2/c2s`, `…/v2/s2c` | `server/wire.rs`, `core/connection.ts`, the test fixture, websocket-rpc.md | HKDF `info` strings of the encrypted handshake. Client and server must derive the same keys; one changed byte breaks every existing pair. A protocol constant, not a name | never |
| `tmux-mobile-agent-notify`, grok `hooks/tmux-mobile.json`, `# tmux-mobile managed kiro entries (board #207)` (the line is the dedup key of an existing `.git/info/exclude`) | `agent_notifications.rs`, `backends/grok.rs`, `backends/kiro.rs` | Written into agents' hook configs and `.git/info/exclude`, then read back to find our own entries. Renaming strands the old entries in every home and in the user's own files | with a cleanup protocol (phase B) |
| `~/.config/tmux-mobile/` and the files in it | `config.rs`, docs, rig scripts | The user's state (`config.toml`, `state.db`, `machine_id`, …). A move needs a fallback read and a migration message. The gateway service records the PARENT of this directory (`XDG_CONFIG_HOME`), not the `tmux-mobile` subdirectory, so renaming only the subdirectory tells the service nothing and does not stop old and new state from forking: phase B names which directory is authoritative and how to go back | phase B |
| `TMUX_MOBILE_*` (`DEV_HOST`, `DEV_SERVER_PORT`, `DEV_WITH_SERVER`, `GATEWAY_TMM`) | the legacy constants in `scripts/`, their tests, one sentence in development.md | Still READ, so the owner's units and shells keep working; the new name wins, each old name prints one line naming it (never a value) | done in B2; removed when nobody sets them |
| `tmux-mobile-gateway.service`, `tmux-mobile-dev.service`, launchd `cc.voka.tmux-mobile` | `gateway/service.rs`, `scripts/`, docs | Installed on real hosts. Install must recognise the old unit as ours; running units are not restarted by us | phase B, label domain is an owner question |
| Cargo package `tmux-mobile`, lib `tmux_mobile`, bin `tmux-mobile`, `libtmux_mobile.so`, Android `Theme.tmux_mobile`, the `Log` tag `tmux-mobile`, `src-tauri/gen/apple` | Rust, Gradle, Kotlin | Build and load names that must agree with each other; checked by one Android build | phase B |
| `com.tmuxmobile.dev` (Android applicationId, namespace, Kotlin package, FileProvider, tauri `identifier`, macOS bundle id) | `tauri.conf.json`, `gen/android` | Changing it installs a NEW app: stored servers and tokens stay behind. Kept so a new build upgrades in place. Android and macOS share one `identifier` today; a later platform config can decide them apart | owner decision |
| `Download/TmuxMobile` | Android downloads folder | Files already saved there stay in the old folder (nothing deletes them) while new ones go elsewhere | owner decision |
| `tmux_state`, `tmux_address`, `tmux_token`, `tmux_machine_id`, `tmux_hub_*` | `localStorage` | A `tmux_` prefix, not the project name; the browser's saved state | never |
| the tmm project / tmux session named `tmux-mobile`, the checkout path, `proj:tmux-mobile` and `tmux-mobile:1` in samples | this host, docs and tests | The name of a project declared on the owner's machine | owner decision |
| `Copyright (c) 2026 vokako` | `LICENSE` | The copyright holder, a legal name, not the project's | owner decision |
| `docs/exec-plans/`, dated incident text in `docs/design-docs/` | docs | A record of what each board saw under the name it had | never |
| `tmux-mobile behavior(s)` / `reverse_proxy blocks` in the CloudFront and Caddy runbook | config.md | Steps against the owner's live infrastructure, worded as its console shows them | with the infrastructure |

The names of the installed artefacts changed in their own step: `productName` and
the window title (`Teammux.app`, `Teammux_<version>_<arch>.dmg`), the Android
launcher label and its Settings > Apps entry. The identifiers in the table did not,
so a new Android build installs over the old one, and on a Mac the new app shares
the saved servers; the one thing that needs the owner's hands is the gateway
service's path, in [install.md](install.md).
