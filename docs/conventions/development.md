# Development — commands, the dev loop, and build gotchas

Everything about RUNNING and BUILDING the project. Testing conventions are in `testing.md`; frontend coding rules in `frontend.md`; runtime configuration in `../reference/config.md`.

## Prerequisites and first run

- macOS or Linux with tmux; recommended `set-option -g history-limit 50000`.
- Rust toolchain and Node (version below).
- A WebKit webview for the desktop app (macOS has one; Linux needs
  `webkit2gtk-4.1`), or skip it with the headless build below.

```bash
npm install
npm run build:server            # the server and tmm, web UI embedded
ln -s "$PWD/src-tauri/target/release/tmm" ~/.local/bin/tmm   # or call it by path
tmm gateway                     # the backend, as a per-user background service
npm run dev:all                 # Vite on :5173
```

The build puts `tmm` in `src-tauri/target/release`; nothing installs it on your
PATH, and the gateway service records the absolute path of the `tmm` that
installed it, so link the real file rather than copying it.

The first launch generates a token in `~/.config/tmux-mobile/config.toml`.
Open `http://<your-machine-ip>:5173`; the connection field is pre-filled with
`ws://<your-machine-ip>:5173/ws`, because Vite proxies `/ws` and `/dl` to the
loopback-only Rust server. Only port 5173 needs to be reachable.

`tmm` is built next to the server binary and is on every managed agent's PATH.
From any shell:

```bash
tmm project create ~/work/my-app --name "My app"
tmm spawn claude --brief "Read docs/tenet.md, then fix the failing test in src/lib/core."
tmm log -f
```

## Node and Package Installation

Development tests require Node `^22.22.2 || ^24.15.0 || >=26.0.0`
since the jsdom 30 client-mount tier (board #115, 2026-09-09).
Verified here with Node 22.23.2. This is a development-tool prerequisite,
not a change to the browser runtime.

`package-lock.json` is canonical; install with `npm ci`. This host aliases
`npm` to `pnpm` in its login shell, so use `bash -c 'npm ci'` (and real npm
for dependency changes) to honor and regenerate the tracked lock.
`pnpm-lock.yaml` is intentionally gitignored to avoid a second package
manager's dependency graph. Do not upgrade unrelated locked packages when
adding a test dependency.

When changing dependencies in a worktree, use that worktree's own
`node_modules`, not a symlink into the live checkout: installation must not
rewrite the running Vite optimizer's dependency tree. The client-mount
helper also uses its own disposable build cache and never starts another
dev server; see [testing.md](testing.md#3-client-behavior-componentmounttestts).

## Commands

```bash
npm run dev:all          # one public :5173; proxies /ws + /dl to the gateway
npm run dev              # Vite dev server only (web UI on 0.0.0.0:5173)
npm run gateway:update   # rebuild; restart the gateway if it is not running these bytes
npm run dev:server:watch # standalone WS server; rebuild/restart on Rust changes
npm run tauri:dev        # Desktop app + WS server (dev mode)
npm run tauri:dev:release # Release-mode desktop app + WS server
npm run build:mac        # macOS .app + .dmg
npm run build:android    # Android APK (aarch64)
npm test                 # Frontend + dev-script tests (node --test; see docs/conventions/testing.md)
npm run check            # svelte-check: type-checks .ts/.svelte.ts/.svelte files
npm run build:server     # web UI (vite build) + server + tmm with it embedded (embed-ui), no webview needed (release)
npm run dev:server       # standalone WS server (pair with `npm run dev`)
npm run test:rust        # Rust tests, sequential (needs tmux running)
```

Run Tauri through these project scripts. Do not use `pnpx tauri`: `pnpx` is
`pnpm dlx` and downloads the unrelated `tauri` package instead of invoking the
installed `@tauri-apps/cli`. Release mode is the `--release` option, not a
positional `release` argument.

On a memory-constrained machine, lower Cargo concurrency per invocation without
changing the project default:
`CARGO_BUILD_JOBS=2 npm run tauri:dev:release`.

### Headless build (server + CLI, no webview)

```bash
npm run build:server     # vite build, then server + tmm (embed-ui), release
npm run dev:all          # Vite alone (the recommended browser dev loop)
npm run gateway:update   # rebuild; restart the gateway if it is not running these bytes
npm run dev:server:watch # watched server only; pair with `npm run dev`
npm run dev:server       # one-shot server only; pair with `npm run dev`
npm run test:rust        # the Rust tests
```

**On this dev host both halves are supervised — do not restart either.** Since
board #343 the design is two units with one job each; the owner performs the
switch himself with the runbook below, so until he has, this host still runs
the single old chain (unit → `dev-stack.mjs` → `dev-server-watch.sh` →
`server`) and `tmm gateway status` still says the service is not installed.

The two units, after the switch:

- **the backend** is the gateway, `tmux-mobile-gateway.service`, installed by
  `tmm gateway install` and running `<repo>/src-tauri/target/release/tmm
  gateway start --service` (board #323). It reads `config.toml` ALONE, so the
  port and the listen address live there and nowhere else. It is rebuilt and
  restarted by `npm run gateway:update`, never by a file watcher.
- **the frontend** is the systemd user unit `tmux-mobile-dev.service`
  (`Restart=always`) → `scripts/dev-stack.mjs` (`npm run dev:all`) → vite on
  :5173, which proxies `/ws` and `/dl` to the gateway. Vite serves from disk,
  so a frontend edit needs a browser reload, not a restart.

Neither is a `tmm task` (verified with `ps` and `systemctl --user status`,
2026-09-29, board #282); starting one as a task would run a SECOND backend
beside the first. Restarting a unit is the owner's call, which he makes
himself; a reviewer or an issue never does it.

`npm run dev:all` therefore preflights :5173 only. The server port is held for
good by the installed gateway, and the old `dev` preflight (both ports) would
have refused to start the frontend at all.

The switch itself — for this host and any machine still on the old chain — is
the runbook in
[install.md § Switching a dev host](../reference/install.md#switching-a-dev-host-to-the-gateway).

**The watcher is still there, for a machine with no gateway**:
`TMUX_MOBILE_DEV_WITH_SERVER=1 npm run dev:all` puts
`scripts/dev-server-watch.sh` back beside vite (and preflights both ports), and
`npm run dev:server:watch` runs it alone. It is what
`tauri dev` would have given us for the server half, which cannot build here (no
webkit2gtk-4.1, no DISPLAY): it restarts the server when it EXITS (2 s backoff),
polls Rust source mtimes every 3 s (no inotify — NFS-safe, ~4 ms per scan),
rebuilds release (`--bins`: the server AND `tmm`) after the tree has been quiet
for one interval, and restarts ONLY when the rebuilt SERVER binary's BYTES
differ. A bash script is read when it starts, so an edit to the watcher takes
effect only when whatever started it restarts. `tmm` is rebuilt with it because
it is the one CLI every agent and the
owner run (`~/.local/bin/tmm` → `target/release/tmm`); built alone, the server
learned verbs (`task --wake`, `wake`, `agent mode`) that a three-day-old `tmm`
could not say (board #282). A rebuilt `tmm` restarts nothing: each run execs
the file anew. `scripts/dev-server-watch.test.ts` pins both halves. Restarting
only when the bytes differ matters — cargo fingerprints by mtime, so a
`touch`, a checkout, or a comment-only edit relinks an identical binary and
dropping every client for that would be noise. `gateway:update` keeps that
rule, and this is where it comes from; what it compares is the binary against
the one the gateway was last STARTED with (a receipt written after each
successful restart, naming the binary, the config root and the service — the
service's own identity), because a one-shot script re-reading the file each
time cannot otherwise tell a finished deploy from a restart that failed. Both
paths then end on one check of the gateway, so exit 0 means it answered as ours
after everything that run did. A failed
rebuild keeps the last
good binary running and retries on the next change. Owner correction, 2026-08-19.
These pass `--no-default-features`, which turns off the `gui` Cargo feature —
`tauri` plus its four plugins (dialog, fs, opener, notification). What remains is what the WebSocket server and
`tmm` actually use, and the webview leaves the dependency graph entirely. Use
this wherever there is no WebKit webview to link against (a Linux host with no
WebKitGTK development package, a CI runner, a container): on Linux `tauri`
reaches gtk3 and webkit2gtk-4.1 through wry, so a `--bin server` build that
needs none of it fails in `glib-sys`'s build script. It is also the faster way
to run the Rust tests anywhere, because none of them touch the Tauri shell.

Two things the gate has to preserve, both easy to break:
- `build.rs` emits the `desktop` / `mobile` cfg aliases itself when `gui` is
  off. They are not cosmetic — the `Config` import (and other desktop-only
  items) are gated on `desktop`. It cannot just call `tauri_build::build()`,
  which panics looking for the `cargo:dev` instruction `tauri`'s own build
  script would have emitted.
- The `tmux-mobile` bin still has to compile, so `main.rs` keeps a stub `main`
  that points at `server`.

The release profile has `incremental = false` deliberately. With it on, every
release build after a source edit failed at link time with hundreds of
`Undefined symbols: "_anon.<hash>.llvm.<n>" … referenced from libtmux_mobile.rlib`
and only `cargo clean -p tmux-mobile --release` recovered — the same cost as a
non-incremental build. If you hit that error on a branch that re-enables it,
that is the cause (this crate emits staticlib + cdylib + rlib, and LLVM's
per-CGU anonymous symbols get renamed between incremental runs).

Dev commands run a port preflight (`scripts/preflight.mjs`): if the ports that
run WANTS (5173 for vite, the server port for a backend it starts itself) are
already held they fail fast and print the owning PIDs instead of half-starting
(a second vite instance corrupts the dep-optimizer cache → blank page on every
open client). `build:android` ends with a postflight that re-points this
machine's gradle build-dir symlink at THIS checkout's output and prints the real
APK path. It computes the target rather than guessing: a global gradle init
script redirects `build/` to
`~/.cache/builds/gradle-builds/<dirname>-<md5(gradle root abs path)[:12]>/`, so
the slug is a pure function of the path. Two failure modes, and the second is
the dangerous one — dangling (cache pruned) is loud, but a link pointing at a
**second checkout of the same repo** hashes to a different slug and makes a
green build silently serve that other tree's older APK. Healing only the
dangling case, or picking the newest APK across all `android-*` dirs, is how you
end up shipping the wrong tree.


## Build targets

- **macOS** — `npm run build:mac` → `src-tauri/target/release/bundle/dmg/`.
- **Android** — `rustup target add aarch64-linux-android && npm run build:android`.
  Needs the Android SDK, NDK 28+ and Java 17+; signing is below.
- **Linux server only** — `npm run build:server` needs no WebKitGTK; it is all
  the browser UI and the phone talk to. It runs `vite build` first and embeds
  `dist/` (`embed-ui`), so `tmm gateway` serves the web UI on its own port and
  `tmm ui` prints its URL (board #323). The dev watcher builds without it.
- **iOS** — not implemented; tracked in [docs/todo.md](../todo.md).

## Remote access (Tailscale)

```bash
tailscale serve --bg 5173
# UI:        https://your-machine.tailnet-name.ts.net/
# WebSocket: wss://your-machine.tailnet-name.ts.net/ws
```

Port 9899 stays loopback-only and needs no serve rule.

## Android signing

The release keystore is NOT in the repository. `gen/android/app/build.gradle.kts`
reads `src-tauri/gen/android/key.properties` (gitignored; copy
`key.properties.example` and fill in `storeFile`, `storePassword`, `keyAlias`,
`keyPassword`; `storeFile` is relative to `gen/android/`). Without the file a
release build still succeeds but the APK is unsigned, and gradle says so — in
a Git worktree both files are absent (gitignored), so symlink `key.properties`
AND `keystore.jks` from the launch checkout before `npm run build:android`
there (2026-09-09, board #131: the first worktree build produced
`app-universal-release-unsigned.apk` and the postflight flagged it).

Why: until 2026-09-03 `keystore.jks` and its passwords were committed in the
gradle script. Anyone with the repository could sign an update that installed
copies of `com.tmuxmobile.dev` would accept. The file was untracked that day; the
key itself is still the one installed apps trust, so rotating it means users
reinstall — an owner decision, not a build step. Until it is rotated, treat the
history as containing a live signing key.

## Workflow

### Agent worktree isolation

- **Develop in a dedicated worktree, never in the launch checkout.** Before the
  first tracked-file edit for a task, a coding agent creates or reuses one task
  branch in a separate `git worktree`. The checkout where the agent was launched
  is for reading, coordination and final integration only. A session already
  launched inside its task worktree uses that worktree; read-only work needs no
  extra checkout.
- Keep one task per worktree, at `<repo>/worktree/<agent>-<task>` — INSIDE the
  launch checkout, in its gitignored `worktree/` directory, never outside the
  repository (owner, 2026-10-10: "worktree直接在当前项目目录里建一个worktree的
  目录，里边再建二级目录开发吧，不要放到外边"; the previous default,
  `~/work/worktrees/<repo>/…`, was wiped externally at 14:26 that day and took
  an uncommitted fix with it). Create it with a branch such as
  `agent/<agent>/<task>`, based on the intended integration HEAD:
  `git worktree add -b agent/<agent>/<task> <abs-repo>/worktree/<agent>-<task> <base>`.
  Use the worktree's **absolute path** for every file tool, test, build and Git
  command; a relative path from an agent process may still resolve to the
  launch checkout.
- What the location changes, measured with git 2.50.1 (2026-10-10, #342). Git
  itself accepts a worktree anywhere inside the repository — tracked directory
  or not. The `worktree/` ignore entry is what keeps the launch checkout clean:
  without it the directory shows as untracked, and `git add -A` there stages a
  worktree as an EMBEDDED REPOSITORY (a gitlink). `git clean -fdx` skips a
  worktree ("Would skip repository"), but `git clean -ffdx` — double force —
  removes the whole `worktree/` directory with every uncommitted change in it:
  never run it in the launch checkout. The dev server serving the checkout
  would also read `worktree/` — Vite watches the whole root, and its dependency
  scan treats every worktree's `index.html` as another app — so
  `vite.config.js` excludes it from both (measured on a private Vite with a
  nested 304-entry `worktree/`: 304 → 0 watches there, and the scan stopped
  following its imports; `scripts/vite-config.test.ts` pins it). `npm test`'s
  globs and tsconfig's `include` are anchored at `src/`/`scripts/`, so they
  never reach it.
- Verify and commit on the task branch. Only then fast-forward/cherry-pick the
  verified commit into the intended branch from the integration checkout. Keep
  the worktree until integration is confirmed, then remove it with
  `git worktree remove`; never absorb, clean or overwrite another dirty
  checkout. A fresh worktree has its own ignored files and dependencies, so run
  the documented setup there when a check needs them.
- The supervised dev stack on this host serves the launch checkout, not every
  linked worktree. Validate inside the worktree with its tests/build (or a
  separate free-port preview); do not mistake the existing server's UI for the
  worktree's code and do not restart the supervised server.

### Commits and AI attribution

- **Commit after every verified change** (owner's standing instruction): once a
  fix/feature is tested and its docs are updated, commit it right away — one
  logical change per commit. Don't let verified work sit uncommitted in the
  tree. Never commit `agent-team-page/` or other unrelated in-progress work
  without being asked.
- Preserve the human's configured Git author. The agent that made the change
  adds exactly one final trailer, after a blank line; an agent that only
  reviewed or integrated someone else's commit adds none. The canonical
  trailer per backend is THIS table, nothing else (owner, 2026-09-28: the
  Kimi one was invented on the spot by the first kimi session and copied
  from history ever after — an unlisted backend adds NO trailer until the
  owner assigns one, never one it made up or excavated from git log):

  | backend | trailer | what the address is |
  |---|---|---|
  | kiro | `Co-authored-by: Kiro Agent <244629292+kiro-agent@users.noreply.github.com>` | the public Kiro Agent GitHub identity — attributable |
  | claude | `Co-Authored-By: Claude <model> <noreply@anthropic.com>` as the CLI emits it (e.g. `Claude Fable 5.1`, `Claude Opus 4.8 (1M context)`) | Anthropic's noreply — not project-controlled |
  | codex | `Co-authored-by: Codex <noreply@openai.com>` | OpenAI's noreply — not project-controlled |
  | kimi | `Co-authored-by: Kimi Agent <kimi-agent@users.noreply.github.com>` | **a historical plain-text marker**: a GitHub user `kimi-agent` does exist (id 263675458), but its ownership is unverified, and this address is not that account's canonical noreply (accounts created after 2017-07-18 get `ID+USERNAME@users.noreply.github.com`) — so it is not an attributable identity. Born 2026-09-20 with the first kimi session (#222); kept for consistency with the commits that carry it |
  | grok / omp | none assigned | no trailer until the owner assigns one |

## Testing

```bash
tmux new-session -d -s test
npm run test:rust
```
Rust tests are sequential (shared tmux state), spread across `src-tauri/src/*.rs`
(`main.rs`, `tmux.rs`, and the `server/` and `projects/` modules — unit tests
live in the submodule they test). Frontend tests: `npm test` (node --test,
`src/**/*.test.{js,ts}`, no tmux needed; conventions in
