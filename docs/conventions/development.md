# Development — commands, the dev loop, and build gotchas

Everything about RUNNING and BUILDING the project. Testing conventions are in `testing.md`; frontend coding rules in `frontend.md`; runtime configuration in `../reference/config.md`.

## Prerequisites and first run

- macOS or Linux with tmux; recommended `set-option -g history-limit 50000`.
- Rust toolchain and Node (version below).
- A WebKit webview for the desktop app (macOS has one; Linux needs
  `webkit2gtk-4.1`), or skip it with the headless build below.

```bash
pnpm install
pnpm run build:server           # the server and tmm, web UI embedded
ln -s "$PWD/src-tauri/target/release/tmm" ~/.local/bin/tmm   # or call it by path
tmm gateway                     # the backend, as a per-user background service
pnpm run dev:all                # Vite on :5173
```

The build puts `tmm` in `src-tauri/target/release`; nothing installs it on your
PATH, and the gateway service records the absolute path of the `tmm` that
installed it, so link the real file rather than copying it.

The first launch generates a token in `config.toml` in `~/.config/teammux/` (an install made before the rename keeps `~/.config/tmux-mobile/`).
Open `http://localhost:5173` on this machine; the connection field is pre-filled
with `ws://localhost:5173/ws`, because Vite proxies `/ws` and `/dl` to the
loopback-only Rust server. Only port 5173 needs to be reachable — and Vite
listens on the LOOPBACK only (board #393, see [The dev server](#the-dev-server-what-it-watches-and-a-lost-hmr-socket-393)):
to open it from another device on your network, start it with
`TEAMMUX_DEV_HOST=0.0.0.0 pnpm run dev:all` and open
`http://<your-machine-ip>:5173`, which then pre-fills `ws://<your-machine-ip>:5173/ws`.

**Environment variable names (board #472, phase B2).** The `TMUX_MOBILE_*` variables of these scripts are now `TEAMMUX_*` (`DEV_HOST`, `DEV_SERVER_PORT`, `DEV_WITH_SERVER`, `GATEWAY_TMM`). The old names are still read: alone they work and each prints one line, once per process, naming the variable (never its value); with both set and different the new one wins and the line says so; a provided new value that is invalid or empty is the new value's problem, never a silent return to the old one. `scripts/env-names.mjs` is the one rule; `TMM_*` are not renamed.

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

**pnpm is the one package manager** (owner, 2026-11-05: "都统一用pnpm吧";
board #33). `pnpm-lock.yaml` is canonical and tracked; `package.json` names
the version (`packageManager: pnpm@12.16.1`). Install with
`pnpm install --frozen-lockfile`, which refuses rather than re-resolve when the
lock and `package.json` disagree. Change a dependency with `pnpm add`/`pnpm
remove`, which rewrites the lock, and commit both. Do not upgrade unrelated
locked packages when adding a test dependency. `package-lock.json` is gone and
gitignored, so a stray `pnpm install` cannot leave a second, unread source of
versions.

The lock has two YAML documents (pnpm 12 with `packageManager` set): the
first pins pnpm itself (`packageManagerDependencies`, every platform's
`@pnpm/exe.*`), the second is the project. Readers of the lock use the project
document (`scripts/pnpm-lock.mjs`). A lock without the first document is
refused by `pnpm install --frozen-lockfile` ("Cannot update
packageManagerDependencies with frozen-lockfile"), so commit the lock pnpm
wrote, both documents.

**The supervised units after the switch (board #33, checked 2026-11-05).**
Both start with no tty and no prompt:
- the gateway unit runs `<repo>/src-tauri/target/release/tmm gateway start
  --service` directly and calls no package manager. Only `pnpm run
  gateway:update`, which a person or agent runs, builds through pnpm.
- the dev unit, `tmux-mobile-dev.service`, should run `pnpm run dev:all`
  instead of `npm run dev:all`. Measured from a worktree with `setsid pnpm run
  dev:all </dev/null`: Vite listened on 127.0.0.1:5173 and answered 200. The
  unit was not installed on this host at the time (`systemctl --user status`:
  not found), so its line is the owner's to change. Its `PATH` must reach
  `pnpm` (`~/.local/share/pnpm` here), and the launch checkout needs one
  `pnpm install --frozen-lockfile` before it starts.

`pnpm-workspace.yaml` holds the two settings that make that deterministic:
- `allowBuilds`: the dependencies whose install scripts run. They are
  exactly the lock's two: `esbuild` and `fsevents`, which is optional and
  macOS-only. Without the entry `pnpm install` stops with
  `ERR_PNPM_IGNORED_BUILDS` (measured, pnpm 12.16.1).
- `verifyDepsBeforeRun: error`: a `pnpm run` whose `node_modules` does not
  match the lock stops and says so. pnpm's default re-installs first.

**The incident behind both.** 2026-11-05, before the switch, the owner's shell
aliased `npm` to `pnpm`. pnpm ignored `package-lock.json` and resolved newer
versions within the ranges (`@tauri-apps/api` 2.12.4, vite 6.4.5), and it
re-installed before every `run`, overwriting a real-npm install. An
untracked, gitignored `pnpm-lock.yaml` in the launch checkout kept those
versions alive. `tauri android build` then refused: "Found version
mismatched Tauri packages" (the crate is tauri 2.10.2).

**The conversion.** `pnpm import` from `package-lock.json` deduped
`@tauri-apps/api` to 2.11.1. The lock had pinned the root copy at 2.10.1 and
the plugins' nested copies at 2.11.1. `package.json` therefore pins
`@tauri-apps/api` EXACTLY at 2.10.1, the constraint the crate imposes. After
that, all 302 resolved packages and their integrity hashes equal
package-lock's. `scripts/tauri-versions.test.ts` pins every `@tauri-apps/*`
to its crate's major.minor in `src-tauri/Cargo.lock`, so a bump on either
side fails in `pnpm test`, not at the APK build.

When changing dependencies in a worktree, use that worktree's own
`node_modules`, not a symlink into the live checkout: installation must not
rewrite the running Vite optimizer's dependency tree. The client-mount
helper also uses its own disposable build cache and never starts another
dev server; see [testing.md](testing.md#3-client-behavior-componentmounttestts).

**A dependency change merges only after the live main checkout has the
dependency installed, with the owner's OK.** This covers a new or changed
entry in `package.json` (and its lock) and in the Cargo dependencies. The
live checkout's `node_modules` is what the supervised dev Vite on :5173
serves, and what `gateway:update`'s `vite build` uses, so a dependency
that is in the branch but not installed there breaks both at once: the dev
app gets a 500 on the import and does not load, and `gateway:update`
refuses to build and leaves the gateway on the previous version. A green
gate in a worktree proves nothing about it, because the worktree ran its
own install. Incident (10-16): #403 added `qr` 0.7.2, passed review and
validation, was merged as 9845e69f, broke :5173 at once, and was reverted
as 39dd125e until the owner approves the install; #392's `css-tree` was
caught before its merge by a read-only check of the live checkout. The
review of a dependency change names the exact install step for that
checkout (`pnpm install --frozen-lockfile` after the merge, which rewrites
`node_modules` and needs the dev server restarted), and the owner runs it or
approves it before the merge.

## Commands

```bash
pnpm run dev:all         # one :5173 (loopback unless TEAMMUX_DEV_HOST says otherwise); proxies /ws + /dl to the gateway
pnpm run dev             # Vite dev server only (web UI on 127.0.0.1:5173; TEAMMUX_DEV_HOST=0.0.0.0 for the LAN)
pnpm run gateway:update  # rebuild; restart the gateway if it is not running these bytes
pnpm run dev:server:watch # standalone WS server; rebuild/restart on Rust changes
pnpm run tauri:dev       # Desktop app + WS server (dev mode)
pnpm run tauri:dev:release # Release-mode desktop app + WS server
pnpm run build:mac       # macOS .app + .dmg
pnpm run build:android   # Android APK (aarch64)
pnpm test                # Frontend + dev-script tests (node --test; see docs/conventions/testing.md)
pnpm run check           # svelte-check: type-checks .ts/.svelte.ts/.svelte files
pnpm run check:android   # cargo check of the Rust lib for the phone (aarch64-linux-android); every src-tauri change
pnpm run build:server    # web UI (vite build) + server + tmm with it embedded (embed-ui), no webview needed (release)
pnpm run dev:server     # standalone WS server (pair with `pnpm run dev`)
pnpm run test:rust       # Rust tests, sequential (needs tmux running)
```

Run Tauri through these project scripts. Do not use `pnpx tauri`: `pnpx` is
`pnpm dlx` and downloads the unrelated `tauri` package instead of invoking the
installed `@tauri-apps/cli`. Release mode is the `--release` option, not a
positional `release` argument.

On a memory-constrained machine, lower Cargo concurrency per invocation without
changing the project default:
`CARGO_BUILD_JOBS=2 pnpm run tauri:dev:release`.

### Headless build (server + CLI, no webview)

```bash
pnpm run build:server    # vite build, then server + tmm (embed-ui), release
pnpm run dev:all         # Vite alone (the recommended browser dev loop)
pnpm run gateway:update  # rebuild; restart the gateway if it is not running these bytes
pnpm run dev:server:watch # watched server only; pair with `pnpm run dev`
pnpm run dev:server     # one-shot server only; pair with `pnpm run dev`
pnpm run test:rust       # the Rust tests
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
  port and the listen address live there and nowhere else. Its unit carries
  `KillMode=process` and `OOMPolicy=continue` (#350, #438): a kernel OOM kill of
  a pane's process ends that process, not the gateway; the unit's cgroup holds
  every pane (by process inheritance), so its memory figure is theirs. It is rebuilt and
  restarted by `pnpm run gateway:update`, never by a file watcher.
- **the frontend** is the systemd user unit `tmux-mobile-dev.service`
  (`Restart=always`) → `scripts/dev-stack.mjs` (`pnpm run dev:all`) → vite on
  :5173, which proxies `/ws` and `/dl` to the gateway. Vite serves from disk,
  so a frontend edit needs a browser reload, not a restart.

Neither is a `tmm task` (verified with `ps` and `systemctl --user status`,
2026-09-29, board #282); starting one as a task would run a SECOND backend
beside the first. Restarting a unit is the owner's call, which he makes
himself; a reviewer or an issue never does it.

`pnpm run dev:all` therefore preflights :5173 only. The server port is held for
good by the installed gateway, and the old `dev` preflight (both ports) would
have refused to start the frontend at all.

The switch itself — for this host and any machine still on the old chain — is
the runbook in
[install.md § Switching a dev host](../reference/install.md#switching-a-dev-host-to-the-gateway).

**The watcher is still there, for a machine with no gateway**:
`TEAMMUX_DEV_WITH_SERVER=1 pnpm run dev:all` puts
`scripts/dev-server-watch.sh` back beside vite (and preflights both ports), and
`pnpm run dev:server:watch` runs it alone. It is what
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
the one the gateway was last CONFIRMED running (a receipt naming the binary,
the config root and the service — the service's own identity), because a
one-shot script re-reading the file each time cannot otherwise tell a finished
deploy from a restart that failed. It confirms, then records, then reports, so
exit 0 means the gateway answered as ours after everything that run did, and an
unconfirmed deploy is tried again rather than remembered. A failed
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

**Vite's dep cache is per checkout, outside `node_modules` (board #464,
2026-10-24).** Vite's default `cacheDir` is `<root>/node_modules/.vite`, and a task
worktree's `node_modules` is usually a SYMLINK to the launch checkout's. The default
then resolved THROUGH the link into the launch checkout's cache, so any Vite started
from a worktree rewrote the supervised dev server's `deps/_metadata.json` while that
server kept serving its old dep hash: the owner's browser showed a blank page
(2026-10-24 22:03). `_metadata.json` was rewritten at 16:58 by a scratch Vite on another
port from a worktree with a symlinked `node_modules` (an agent's measurement
page for #463; the same pattern earlier for #461). The port preflight above guards the SAME port
only. The rule is now mechanical rather than a matter of care: `vite.config.js` sets
`cacheDir` to `<real directory of the config>/.vite` (gitignored), for `serve` and
`build` alike. A worktree gets its own cache; a scratch config that extends the main
one inherits it. So a worktree may share `node_modules` by symlink ONLY because the
cache no longer lives there; a dependency CHANGE still needs the worktree's own install
(above), and a scratch Vite never sets `cacheDir` into another checkout, and still
never runs in the launch checkout. Optimized deps are served from `/.vite/deps/…` now.

The unit of isolation is the CHECKOUT, not the process or the port: two dev servers
in the same checkout still share its `.vite`, so the port preflight stays and a
second Vite is not started there on another port. A scratch config with
`configFile: false` inherits NOTHING, the cache path included: it sets its own,
with the config's one helper and no second path calculator
(`import { viteCacheDir } from '../../vite.config.js'; … cacheDir: viteCacheDir()`,
the import being THIS worktree's config, so it gets this worktree's `.vite`;
importing the launch checkout's config would hand it the launch checkout's path).
`viteCacheDir` is resolved through symlinks, so a symlinked path to a worktree and
the worktree itself are the SAME cache, while a worktree and the launch checkout are
two.
Verified (Vite 6.4.2): two Vite instances from two worktrees that symlink one
`node_modules` each wrote their own `.vite/deps/_metadata.json` (different hashes,
`svelte.js?v=` 200 on both) and the launch checkout's `node_modules/.vite/deps/_metadata.json`
kept its mtime and md5; `scripts/vite-config.test.ts` reproduces the incident on a
scratch fixture (the default cache lands in the shared install) and pins the fix. The
supervised unit moves to the new path when this change lands, without a restart: a
running Vite restarts ITSELF when `vite.config.js` changes on disk (measured by the
validator on #464: it switched to `<checkout>/.vite` at once and an open page reloaded
once and mounted), so open pages reload once and the first load re-bundles. A
render-test cache (`node_modules/.vite-render-test`, `src/lib/test/ssr.ts`) is a separate
directory the dev server never reads, and is left as it is.
`vite build` writes nothing into the cache (measured after `rm -rf .vite`: the directory does
not exist afterwards; pinned on a scratch root with the real config's plugins), so the
`build:android` runs in the launch checkout are not a second writer next to the supervised server.


## Build targets

- **macOS** — `pnpm run build:mac` → `src-tauri/target/release/bundle/dmg/`.
  `tauri.conf.json` sets `app.macOSPrivateApi` (and `Cargo.toml` the matching
  `macos-private-api` tauri feature) for WebKit's element fullscreen (board
  #454): a private API, so the app is a dmg and never a Mac App Store build.
- **Android** — `rustup target add aarch64-linux-android && pnpm run build:android`.
  Needs the Android SDK, NDK 28+ and Java 17+; signing is below. The build
  needs `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) naming an SDK that holds an NDK
  under `ndk/<version>/`, and `build:android` refuses to start without one
  (`preflight.mjs android-env`, board #460). Measured with tauri-cli 2.10.0
  and 2.11.1: tauri takes the SDK from `ANDROID_HOME`, else
  `ANDROID_SDK_ROOT`, else an auto-detected one, and the NDK from that SDK's
  `ndk/`; `NDK_HOME` does not decide it. When the SDK it uses has no
  `ndk/<version>`, tauri asks whether to install the command line tools — an
  interactive prompt that hangs a `tmm task` or any shell nobody answers (an
  hour on 2026-10-23: with `ANDROID_HOME` unset, the auto-detect picked an
  empty SDK). Of several NDKs tauri uses the directory under `ndk/` whose
  NAME sorts last as a string — not the highest version (measured with
  2.11.1: of `9.0.0` and `10.0.0` it uses `9.0.0`). One that is present but
  broken fails loudly instead of prompting; the guard checks only that
  tauri's pick holds `source.properties`, the first file tauri reads, not
  that the NDK is complete. `NDK_HOME` is optional; if set, it must be that
  NDK (compared through symlinks). Per host:
  - `cfu`: the SDK is `/home/cfu/Android/sdk` (lowercase) with the NDK at
    `/home/cfu/Android/sdk/ndk/28.2.13676358`; `/home/cfu/Android/Sdk`
    (capital S) also exists, is empty, and is what the auto-detect picks:

    ```bash
    ANDROID_HOME=/home/cfu/Android/sdk pnpm run build:android
    ```
  - `ubuntu` (board #16): the SDK is `/home/ubuntu/Android/Sdk` with one NDK,
    `ndk/28.2.13676358`, plus platform-tools 37.0.1, `platforms;android-36`
    and `build-tools;36.0.0` from sdkmanager. `build-tools;35.0.0` is there
    too: gradle installed it itself during the first build (build log,
    08:59:34 UTC), so the build uses it. `~/.zshrc` exports
    `ANDROID_HOME` and `NDK_HOME` from that directory, so a login shell needs
    no prefix. First build 2026-11-05, about 08:55 to 09:02 UTC (7 min, gradle
    8.14.3), at main `49882cd0` in a detached worktree with `pnpm install --frozen-lockfile`
    (the shell's `npm` is pnpm). No signing files exist on this host, so the
    APK is `app-universal-release-unsigned.apk` and the postflight exits 1.
- **Linux server only** — `pnpm run build:server` needs no WebKitGTK; it is all
  the browser UI and the phone talk to. It runs `vite build` first and embeds
  `dist/` (`embed-ui`), so `tmm gateway` serves the web UI on its own port and
  `tmm ui` prints its URL (board #323). The dev watcher builds without it.
- **iOS** — not implemented; tracked in [docs/todo.md](../todo.md).

## Remote access (Tailscale)

```bash
tailscale serve --bg 9899
# UI:        https://your-machine.tailnet-name.ts.net/    (the gateway's own UI, embed-ui)
# WebSocket: wss://your-machine.tailnet-name.ts.net/ws
```

The gateway still listens on the loopback; `tailscale serve` dials it there.
Never `serve` (or `funnel`) the dev server's `:5173`: see the next section.

## The dev server is never public (#505)

**Rule.** The Vite dev server (`:5173`) is reached only DIRECTLY: from this host
on the loopback, or from the LAN when a person opts in with `TEAMMUX_DEV_HOST`.
It is never put behind a reverse SSH tunnel, a reverse proxy, a CDN or
`tailscale serve`/`funnel`. A browser anywhere else uses the gateway's own UI
(`pnpm run build:server` embeds `dist/`, `server/ui.rs` serves it with `/ws` and
`/dl` on the gateway's port), so the dev server is never a production origin. An
edge's catch-all route answers `404`; it is never a fallback to Vite. Forwarding
`:5173` anywhere is a forbidden config, not a known risk.

**The real topology** (2026-11-02, after the containment below):

```
CloudFront d2s31qhvdzbz3r ─▶ Caddy on tky (:8082, CloudFront's origin-facing prefix list only)
   this host's secret route prefix (BACKEND_PATH) ─▶ 127.0.0.1:9899 on tky
        ─▶ reverse SSH tunnel (tmm-tunnel-tky.service: -R 127.0.0.1:9899 only)
        ─▶ this host's gateway 127.0.0.1:9899 (UI + /ws + /dl; lockout keyed by XFF, #441)
   other secret prefixes                           ─▶ other machines' gateways (not drawn)
   anything else                                   ─▶ respond 404
this host: Vite 127.0.0.1:5173, proxying /ws and /dl to 127.0.0.1:9899 — local dev only
```

The edge (Caddy, the tunnel unit) is configured outside this repository; the
secret path names live there and are never written here.

**Why (incident, 2026-11-02 17:00).** Until then the edge's catch-all `handle`
reverse-proxied to port 5173 and the tunnel also forwarded that port, so the
public distribution's root WAS the dev server. The
owner's pentest reported, all through that one route: the gateway's `/ws` control
channel at the root (a real handshake and `invalid token` answer, any `Origin`);
a `/@fs` read of the gitignored `deploy/caddy/Caddyfile`, which names a secret
route prefix; source reads over `/@fs` that echo absolute paths and the username;
`/__open-in-editor` as a file-existence oracle that spawns a process; 500/502
from Vite's proxy on large bodies; and lockouts through that route. Those
findings are the owner's report; this section did not reproduce them. The report
explained the lockouts as Vite's proxy dropping `X-Forwarded-For`, so that every
login shared the 127.0.0.1 key. The source does not support that mechanism, and it
is unproven: `devProxy()` is only `target` + `ws: true`, Vite's proxy copies the
incoming request headers (Caddy's `X-Forwarded-For` included; without `xfwd` it
adds none, and it removes none), and #441's go-live check measured a login on
`/ws` at the root keyed by the viewer. Closing the route does not depend on it.
Orchestrator contained it the same hour (reversible): the catch-all became
`respond 404` (Caddyfile backup kept on tky) and the `:5173` forward was dropped
from the tunnel unit. Read back afterwards from this host: the running tunnel
carries `-R 127.0.0.1:9899` and no `:5173`; `https://d2s31qhvdzbz3r.cloudfront.net/`
and `/@vite/client` answer 404; `127.0.0.1:9899/` answers 200 with the
`tmm-gateway` marker; Vite listens on `127.0.0.1:5173` only.

**How the rule is held from the source** (the edge cannot be tested from here):

- *The dev server refuses proxied requests* (`refuseProxied()` in
  `vite.config.js`, the first plugin). A request that carries any header a
  reverse proxy or CDN adds on the way in (`Forwarded`, `X-Forwarded-For`,
  `-Host`, `-Proto`, `X-Real-IP`, `Via`, `CloudFront-Viewer-Address`,
  `X-Amz-Cf-Id`) gets `403` before Vite sees it: pages, `/@fs`,
  `/__open-in-editor`, the HMR socket and the `/ws` + `/dl` proxy. The gate sits on
  the HTTP server's `emit`, ahead of every `request` and `upgrade` listener, so a
  refused `/ws` upgrade never dials the gateway. Caddy always adds
  `X-Forwarded-For`, and CloudFront adds `Via`, so re-adding the old route gives
  403s, not the app. `scripts/vite-config.test.ts` runs a real server: each header
  alone is refused on every door, the stand-in gateway is dialled zero times, and
  the same requests without the headers are served (the control). With the gate
  disabled the test fails.
- *No proxied host name.* `allowedHosts` is `['localhost']`; `.ts.net` went with
  the old Tailscale recipe that served the dev port. (Vite always accepts an IP address, which is
  what LAN dev uses.)
- *Gitignored deploy configs are not served.* `deploy/` joined `NOT_THE_WEB_APP`
  (watch, scan and `fs.deny`); the served-files test asserts
  `deploy/caddy/Caddyfile` is 403 by plain URL and `/@fs`.
- *No tracked recipe forwards it.* `scripts/vite-config.test.ts` fails if a tracked
  file outside `docs/exec-plans/` holds an ssh `-R` forward of `5173`, a
  `reverse_proxy` or `header_up Host` to `:5173`, or a `tailscale serve`/`funnel`
  of `5173`.

What is left open: a raw TCP forward with no HTTP proxy in front adds no header.
Vite's host check still refuses a domain name there, not a bare IP address, and
the dev server would still be public. Only the rule above prevents that.

## Android signing

The release keystore is NOT in the repository. `gen/android/app/build.gradle.kts`
reads `src-tauri/gen/android/key.properties` (gitignored; copy
`key.properties.example` and fill in `storeFile`, `storePassword`, `keyAlias`,
`keyPassword`; `storeFile` is relative to `gen/android/`). Without the file a
release build still succeeds but the APK is unsigned, and gradle says so — in
a Git worktree both files are absent (gitignored), so symlink `key.properties`
AND `keystore.jks` from the launch checkout before `pnpm run build:android`
there (2026-09-09, board #131: the first worktree build produced
`app-universal-release-unsigned.apk` and the postflight flagged it). The
`android-apk` postflight recognises that APK and names the missing files and
this section, instead of blaming the gradle build dir redirect (board #17).

Why: until 2026-09-03 `keystore.jks` and its passwords were committed in the
gradle script. Anyone with the repository could sign an update that installed
copies of `com.tmuxmobile.dev` would accept. The file was untracked that day; the
key itself is still the one installed apps trust, so rotating it means users
reinstall — an owner decision, not a build step. Until it is rotated, treat the
history as containing a live signing key.

### The dev server: what it watches, and a lost HMR socket (#393)

Until #505 (2026-11-02) the owner's browser app was the Vite dev server
(`:5173`, through CloudFront → Caddy → a reverse SSH tunnel; forbidden now,
§ The dev server is never public). Two things made its tab reload by itself
("[vite] server connection lost. Polling for restart…" is Vite's dev client
about to call `location.reload()`).

**Vite watches the web app, not the checkout.** An `.html` file that changes
anywhere under the root is answered with a full page reload of EVERY open
browser, and an Android build writes them into the checkout: the supervised
server's journal, 2026-10-15, shows `page reload
src-tauri/target/aarch64-linux-android/release/build/…/tauri-codegen-assets/<hash>.html`
twice at 15:11 and twice at 22:50, and `src-tauri/gen/android/build/reports/problems/problems-report.html`
at 15:16. So `vite.config.js` (`watchIgnored`, `scanEntries`) skips everything the
web app cannot import: `worktree/`, `src-tauri/`, `temp/`, `build/`, `dist/`
(a `vite build` while the dev server runs would reload every tab too) and `.tmm/`.
The list is absolute and anchored at the config's directory, and the dependency
scan's entry glob carries the same exclusions. `scripts/vite-config.test.ts`
runs a real Vite watcher on a scratch root: a changed `.html` under any of them
is not even reported, the control `index.html` is. Add a new build-output
directory to `NOT_THE_WEB_APP` the day one appears.

**Vite listens on the loopback, and does not serve what is not the web app**
(security, reviewer on #393). A watch ignore is not access control. The dev
server used to listen on `0.0.0.0:5173`, reachable from the whole security group
(and, through the CloudFront route, from the internet), and it served the whole
checkout: measured on a private Vite before the change, `.tmm/agents/x/launch.json`
(an agent's environment), `temp/`, `worktree/` and `src-tauri/` answered 200 over
a plain URL and over `/@fs/<absolute path>`. Now (`devHost`, `fsDeny` in
`vite.config.js`):

- `server.host` is `127.0.0.1` by default. The only intended path from outside
  this host is the reverse SSH tunnel, which dials `127.0.0.1`, so the CloudFront
  route keeps working (measured: no Tailscale on this host). A person who wants the
  dev server on the LAN says so — `TEAMMUX_DEV_HOST=0.0.0.0` (Tauri's own
  `TAURI_DEV_HOST` for mobile dev is honoured too). `ss -ltn` on a Vite started
  with no flag: `127.0.0.1:<port>`. `allowedHosts` is not widened.
- `server.fs.deny` REPLACES Vite's defaults, so it restates them (`.env`, `.env.*`,
  `*.{crt,pem}`, `**/.git/**` on 6.4.2; a test fails if the installed Vite's own
  default has something this list lacks) and adds `worktree/`, `src-tauri/`,
  `temp/`, `build/`, `dist/` and `.tmm/`, absolute and anchored at the config.
  Measured on the private Vite after: all of them 403 over the plain URL AND
  `/@fs/<abs path>`; `/`, `/src/main.ts`, `/.vite/deps/…` (`/node_modules/.vite/deps/…` before #464) and
  `/@fs/<abs>/src/main.ts` still 200. `scripts/vite-config.test.ts` runs a real
  server and asserts the same on a scratch root.

This did NOT close the CloudFront route to Vite: whoever held that URL still
reached the app's own source through Vite, and the 2026-11-02 pentest used
exactly that. The route is closed now and forwarding the dev server is forbidden
(§ The dev server is never public, #505).

**A lost HMR socket reconnects; it does not reload the page.** `quietDevReconnect()`
(a Vite plugin in `vite.config.js`) patches Vite's own dev client, the way
`allowCompactXtermLines()` patches xterm ([xterm-patch.md](../design-docs/features/xterm-patch.md)),
at four pieces of text, so that after the ping answers the page reconnects instead
of calling `location.reload()`:

1. Vite's transport wrapper is a state machine that a failed dial POISONS (a
   rejected `connectingPromise` sticks and every later `connect()` re-awaits it;
   `disconnect()` is a no-op once the socket has closed; and the default path
   swaps its socket factory to the server's DIRECT address, which a remote browser
   cannot reach). So the patch turns the transport into a factory
   (`__tmmNewTransport`) and builds a FRESH one per attempt, always dialled at the
   page's own proxied address first, handing it to the same `HMRClient` so the
   modules' hot registrations survive. A failed attempt is thrown away.
2. The 30 s ping timer of a closed socket is cleared (the wrapper never does it
   after a natural close: one timer would leak per drop).
3. A failed re-dial is NOT evidence of a restart: the same server may refuse one
   handshake and take the next. The evidence is the server's IDENTITY — its HMR
   token is new on every start — so the page re-reads `/@vite/client` and compares.
   Only a confirmed new identity reloads, and only a page on the loopback
   (`localhost`, `127.0.0.1`, `[::1]`: the local dev loop's wanted answer to a
   restart); a page reached through any other host never reloads and logs once
   "the dev server restarted; HMR is off until this page is reloaded". With the
   identity unchanged or unreadable it keeps trying and then logs that HMR is off
   until a reload. The trying is BOUNDED, and stops after a while: 12 attempts
   (about a minute when every dial fails at once), each given 8 s and each identity
   read 5 s, so a PENDING upgrade or fetch delays the next dial and never blocks it;
   a timed-out attempt is invalidated, and if its socket opens late it is shut and
   its messages ignored, so it can never touch the live transport. THE COST: counting
   starts after the ping answers (the server is reachable), so it is not a recovery
   window for a whole network outage; and when HTTP is reachable but HMR keeps
   failing, the tab stops receiving source updates and needs a refresh to get them
   back — HMR carries source updates, not the room's data, so the app's own socket,
   the draft and the page are untouched. Hot updates are NOT promised to resume
   after an outage of any length.
4. If the same server is back, HMR resumes and the console says "connection
   restored; the page was not reloaded".

Tabs opened before the supervised server picked the new config up (Vite restarts
itself when `vite.config.js` changes) keep the old client until reloaded once.

*What was measured* (2026-10-15; nothing of the owner's was touched, the real
URL was only read through, one read-only HMR socket per probe):

- through the real path (`d2s31qhvdzbz3r.cloudfront.net` → Caddy → tunnel → Vite)
  an HMR WebSocket that carried no frame in either direction was cut at exactly
  600.2 s (close code 1006, no close frame) — a 10-minute idle timeout, not the
  distribution's 60 s origin read timeout; with a client frame every 30, 60 or
  90 s it stayed open for the whole 14 minutes. Vite's own client sends one every
  `server.hmr.timeout` (30 s), so a live tab never idles that long;
- a tab FROZEN for 11 minutes and then resumed (headless Chrome, CDP
  `Page.setWebLifecycleState`, what a sleeping or memory-saved tab does), through
  the same real URL, two tabs side by side: the owner's Vite client AS SERVED
  logged "server connection lost. Polling for restart…" at the moment of
  resume and the page RELOADED (the page's own variable gone, `navigation.type ==
  "reload"`, a new `timeOrigin`); the same client text with the patch applied
  (answered through CDP `Fetch`, so the owner's service was not touched — the HMR
  socket still crossed the real path) logged "connection restored; the page was
  not reloaded" and the page kept its variable and `timeOrigin` for the 32 s
  watched afterwards. Even a 5 s freeze closed the socket on resume (patched client:
  lost, then restored), so this trigger needs no idle timeout at all;
- on a private Vite behind a TCP hop that drops every connection for 5 s: the
  unpatched client reloaded the page (`navigation.type == "reload"`, the page's
  own variable gone); the patched one kept it, with the draft in the composer;
  two drops in a row recovered both times and a hot update (an edit to
  `App.svelte`) was delivered after each; with the hop refusing the FIRST HMR
  handshake after a drop (the reviewer's sequence) the page still recovered with no
  reload (the rig can reach the server's direct address, so Vite's own fallback
  carries it; the dynamic test below drives the case where it cannot);
  restarting that Vite: a loopback page reloaded as before, an `app.localhost`
  page (not in the loopback list) stayed put, logged the failed dial and then
  "the dev server restarted…" once.

*No server heartbeat.* The idle cut is already prevented by Vite's 30 s client
ping for a live tab, and the reconnect now makes every other drop invisible, so a
heartbeat would be a second mechanism for a case the first covers.

**The patch edits Vite's code, so it is stamped and it fails loudly.**
`QUIET_RECONNECT_MEASURED_ON` is the Vite version it was measured on (6.4.2); the
transform throws "Unsupported Vite dev client: … not found exactly once" when any of
the four pieces of text it replaces is gone or doubled, and `scripts/vite-config.test.ts`
fails when the installed Vite is another version OR any piece is gone, so an upgrade
can never quietly lose the patch (or quietly keep one that no longer does anything).
`pnpm-lock.yaml` pins the same version (the `package-lock.json` of the time, until
board #33) and a second test compares the lock with the
stamp (board #396: the first test reads `node_modules`, so a checkout whose
`node_modules` had been updated past the lock stayed green while every fresh install —
6.4.1 from the lock — failed it): an upgrade moves the lock, the stamp and the patch
in one commit.
`scripts/vite-client-reconnect.test.ts` RUNS the patched client of the installed Vite
in Node against a fake WebSocket, fetch, document and location with mocked timers: ping
answers → the first HMR dial fails → the same server comes back must re-dial the page's
own address, deliver later hot updates to modules registered before the drop and recover
a second drop, the old ping timers must be gone, a failed dial with an unchanged or
unreadable identity never reloads, and only a changed identity reloads a loopback page.
The unpatched client is run through the same sequence as the control (it reloads).
Upgrade procedure: run the tests; when they fail, read the new
`node_modules/vite/dist/client/client.mjs` (the transport wrapper, the ping timer and
§ `vite:ws:disconnect`), adapt the patch until `vite-client-reconnect.test.ts` passes on
it, re-run the live check (a private Vite with its own `--port` and
`cacheDir`, a TCP hop you can cut, a headless browser: a 5 s cut must leave the
page's own variable in place), then update the stamp. Never weaken the guard to
make the dev server start.

The app's own WebSocket never reloads the page either; how long it retries
before the connect card is in
[disconnect-grace.md](../design-docs/features/disconnect-grace.md#the-clients-side-how-long-a-dropped-connection-is-retried-board-393).

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
  following its imports; `scripts/vite-config.test.ts` pins it; the same
  ignore list now covers the rest of what is not the web app, see
  [The dev server](#the-dev-server-what-it-watches-and-a-lost-hmr-socket-393)). `pnpm test`'s
  globs and tsconfig's `include` are anchored at `src/`/`scripts/`, so they
  never reach it.
- **Three places say where a worktree goes, and only the first two are the
  project's.** (1) The repo's `AGENTS.md` non-negotiable 4, which every agent
  working ON this repository reads. (2) This section. (3) The owner's own
  app-wide `<config>/AGENTS.md` (`tmm prompt`), which leads every managed
  agent's prompt on every backend and is where a person's workflow rules
  live — it is user configuration, not a file in git, and the one place that
  should carry the same location (`<repo>/worktree/<agent>-<task>`, inside the
  project directory, `worktree/` gitignored) for agents working on OTHER
  projects. They must agree. What must NOT carry it is the shipped registry
  seed (`projects/store/registry.rs`): a release hands every fresh install a
  persona line only (board #344), so a location written there would be one
  owner's convention in everyone's defaults. A mismatch between (1)-(2) and
  (3) is silent — the agent simply builds its worktree where the prompt says —
  so changing the location means editing all three, and the third by hand.
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

### Live checks with real agent CLIs run only in Docker (board #55)

Owner, 2026-11-06 15:07: "Why did you change the system's configuration
during development? These are things that are forever forbidden. If you want
to test, open a virtual environment in Docker; do not test on this machine."
That day's live checks on this host relinked `~/.local/bin/claude` four times
and rewrote `~/.codex/config.toml` twice. So **no test runs on this host**:
unit suites run inside `scripts/isolated.mjs` (`node scripts/isolated.mjs --
pnpm test`, `node scripts/isolated.mjs -- bash -c 'pnpm run test:rust'`),
only `pnpm run check` and `pnpm run check:android` (no run) are allowed bare,
and every live check with a real agent CLI runs in the live rig:

```bash
pnpm run test:live:docker            # check `smoke`: one codex turn and one claude turn
pnpm run test:live:docker codex-models   # board #70: codex's list follows its config (agents-overview.md § Model catalogue)
pnpm run test:live:docker codex-provider   # board #74: a codex chat restarted under another provider comes back fresh (agents-overview.md)
pnpm run test:live:docker pi             # board #71: a managed pi end to end (agents-overview.md § The pi backend)
pnpm run test:live:docker pi-tools       # board #86: a pi tool call is one row with its argument (agent-status.md)
pnpm run test:live:docker pi-paste       # board #85: lines carrying `#81` reach a busy and an idle pi whole and alone (agents-overview.md § The pi backend)
pnpm run test:live:docker omp-tools        # board #72: omp's own tools off by default, on by the switch (agents-overview.md)
pnpm run test:live:docker codex-limit      # board #66: the provider's body limit, and a profile's compaction limit is taken (config.md)
pnpm run test:live:docker codex-picker     # board #66: a delivery waits while codex's /new picker is open (hub-composer.md)
```

- **The image** is `docker/validator/Dockerfile`'s `live` target: this
  checkout's `server` and `tmm` built inside, and the CLIs pinned to the
  versions measured on this host: claude 2.1.319, codex-cli 0.166.0, omp
  18.15.0 (npm), pi 1.5.0 (npm, @earendil-works/pi-coding-agent, board #71), with Bun 1.4.4 for omp (its package's `engines` names
  `bun >=1.4.4`; round 1, validator-2: without it `omp --version` failed with
  `env: bun: No such file or directory`). Measured in the built image: each
  `--version` answers its pinned version. kiro-cli 2.37.1 and kimi 2.5.1 have no public pinned install
  measured, so they are not in the image and nothing fakes them. Every CLI's
  no-update switch is set. The image carries `/etc/teammux-live-rig`, the
  only place `scripts/scratch-env.mjs` agrees to run (with `/.dockerenv`); on
  the host it refuses and names this command.
- **Credentials** (owner, 15:26: copy or map them from this system). Only the
  measured files are bind-mounted, each READ-ONLY, under `/stage`:
  `~/.codex/config.toml` and its `*.config.toml` layers, `auth.json` and
  `.env` when present, and `~/.claude/settings.json` (its env block and its
  `apiKeyHelper`, `printenv <NAME>` here, which the image has).
  `~/.claude.json` is not needed. The container's entrypoint COPIES them into
  its own HOME, so a CLI writes only its copy. A link is refused, never
  followed into a mount. Environment credentials (`UST_API_KEY`, which the
  codex config names by `env_key`, and the `ANTHROPIC_*` names) pass as
  `docker run -e NAME`, by name only. No value is ever in an argv, a log, the
  image or a file in the image. Nothing else of the host is mounted: no HOME,
  no `~/.config/teammux`, no socket.
- **The proof** is the host's own: before and after the run, the script
  snapshots an ALLOW-LIST of the user's config, credential and link paths
  (the files above, `~/.claude.json`, `~/.config/teammux/config.toml` and
  every link in `~/.local/bin` by its target) and fails, naming each path, on
  any change. An unreadable path fails too, and so does an entry of a dir that
  can be listed but not searched (round 1, validator-2: its links had vanished
  from both snapshots). An allow-list, because the user's
  own CLIs write their sessions and history meanwhile.
- **Measured** 2026-11-06 15:3x: the managed codex and the managed claude each
  answered `ready` inside the container, and all 24 host paths were unchanged.
  Without credentials each agent starts and its turn is reported skipped,
  never passed.

### A scratch gateway never reaches the live tmux server (board #14)

A scratch gateway or server you start from an agent's pane (or any shell
inside tmux) inherits `TMUX` and `TMUX_PANE`, and `src-tauri/src/tmux.rs`
reads `$TMUX` BEFORE `TMUX_TMPDIR`: the server then drives the LIVE tmux
server, whatever `TMUX_TMPDIR` says. The pane also carries `TMM_SOCKET`, the
live gateway's local socket, plus `TMM_PROJECT` and `TMM_AGENT`.
Incident 2026-11-05 (builder-3, #6 at about 06:10 and #7 at about 06:57 and
08:06): three scratch gateways started this way used the live tmux server,
and the 08:06 one's UI listed the live sessions. The live `tmux
list-sessions` was unchanged and the scratch stores held no projects, so
nothing was restored; option or hook writes could not be ruled out.

Start every scratch process through `scripts/scratch-env.mjs`, which gives it
`isolatedEnv` from `scripts/test-rust.mjs`, the same environment every Rust
test run gets. That drops `TMUX`, `TMUX_PANE`, `TMUX_SOCKET` (Config prefers
it to `TMUX_TMPDIR`), `TOKEN` and every `TMM_*`, and puts `TMUX_TMPDIR` and
the XDG roots under one private dir. It also makes every level of the
server's config root 0700: the store refuses a `state.db` under any level
others can change, and `mkdir -m 700 -p` sets only the last one.

```bash
D="$(mktemp -d)/gw"                                   # never /tmp itself
node scripts/scratch-env.mjs run "$D" --port 19951 -- src-tauri/target/debug/server
node scripts/scratch-env.mjs check "$D" --gateway     # exit 0, or says what routes elsewhere
node scripts/scratch-env.mjs check "$D"               # AGAIN before deleting: the user's CLI links
kill "$(cat "$D/pid")"                                # by its own pid, never pkill -f
env -u TMUX -u TMUX_PANE -u TMUX_SOCKET TMUX_TMPDIR="$D" tmux kill-server
```

- **Configured before the first launch.** `--port` writes
  `$D/xdg-config/teammux/config.toml` (`127.0.0.1`, that port, a random
  token, mode 0600) before the server starts, so it never binds the default
  port 9899, the live gateway's; `--port 9899` is refused. Reviewer's P2 on
  `dc5a1aa6`: the first recipe launched once on the default config and then
  restarted.
- **`check <dir>` compares values, not names** (reviewer P1-R1 on
  `dc5a1aa6`; validator reproduced it): a variable that is merely SET proves
  nothing. An empty `TMUX_TMPDIR` is treated by tmux as unset and falls back
  to `/tmp`, which here IS the live socket root. The check fails unless:
  - `<dir>` is an absolute, existing directory of yours at 0700 and not `/tmp`;
  - the process in `<dir>/pid` has `TMUX_TMPDIR` exactly `<dir>`, and its three
    XDG roots exactly the ones under it;
  - it kept no `TMUX`, `TMUX_PANE`, `TMUX_SOCKET`, `TOKEN` or `TMM_*`.
- **The environment is read per platform, and unreadable FAILS** (board
  #30). Linux reads `/proc/<pid>/environ`. macOS has no `/proc`, so `check`
  reads `sysctl(KERN_PROCARGS2)` for the pid through the host's
  `/usr/bin/python3` (ctypes; no root for our own processes): argc, the exec
  path, padding, argv, then the environment, every string NUL-ended, up to an
  empty string before the kernel's apple strings (measured on clawdbjs, macOS
  27.0.1, for #27). Every boundary is the kernel's, so an argv word or a value
  such as `NOTE="diagnostic TMUX_TMPDIR=<dir>"` never reads as a variable.
  Round 1 (reviewer P1-R1): the first reader used `ps -E`, which joins argv
  and environment with spaces, so that value forged a private `TMUX_TMPDIR`
  where Linux finds it unset. An environment that cannot be read is a failure
  with its reason, never "nothing found" (#26's lesson): the kernel shows no
  environment (a platform binary such as `/bin/sleep`), the bytes are cut
  short, the pid is gone or not ours (`EINVAL`), python3 is missing, or the
  platform is another. Before #30 the check died with
  `ENOENT /proc/<pid>/environ` on macOS and the environment was inspected by
  hand.
- **`--gateway` asks the gateway itself.** It plants a `scratch-env-marker`
  session on the private tmux server, then calls the gateway's own
  `list_sessions` with the scratch config's token. The gateway must list
  exactly the private server's sessions, the marker included. An empty
  `tmm project list` is NOT that proof: it is stored and adopted state, and is
  empty before adoption even on the wrong tmux. Measured 2026-11-05 from an
  agent pane: the scratch gateway listed `[scratch-env-marker]` while the live
  server held five sessions.
- **No CLI updates itself from a scratch run** (board #48). Incidents
  2026-11-06 08:00, 08:55 and 09:11: a scratch claude ran its updater under
  the private `XDG_DATA_HOME` and the REAL `HOME`, installed into
  `<dir>/xdg-data/claude/versions/`, and relinked the user's real
  `~/.local/bin/claude` there. Once the dir was deleted, every claude on the
  host failed to start (`claude: not found`). Measured on claude 2.1.319 with
  a fake HOME: the relink came within 10 s of its first screen, and with
  `DISABLE_AUTOUPDATER=1` it did not come in 60 s. So `isolatedEnv` sets each
  installed CLI's switch, over the caller's value (`UPDATE_SWITCHES` in
  `scripts/test-rust.mjs`): claude `DISABLE_AUTOUPDATER=1` and
  `DISABLE_UPDATES=1` (both documented; the second also blocks a typed
  `claude update`), kimi `KIMI_CODE_NO_AUTO_UPDATE=1`, and kiro
  `KIRO_NO_AUTO_UPDATE=1`. kiro's is read by kiro-cli-chat 2.37.1 but is not
  documented; its documented door, the setting `app.disableAutoupdates`,
  lives under the real HOME and so cannot be set for one scratch run. codex
  (a manual `codex update`; the managed launch already sets
  `check_for_update_on_startup=false` and `--no-daemon`) and omp (a manual
  `omp update`) needed none: neither changed a link in 90 s.
- **The switch has to reach the PANES.** A pane inherits the private tmux
  SERVER's environment from the moment the server started, not the
  gateway's. The 09:11 relink happened with the switch set on `run` alone,
  because `check --gateway` had started the server first with its own
  environment. Now every starter (`run`, `check`, `test:rust`) uses
  `isolatedEnv`, and `check` reads the running private server's
  `show-environment -g` and fails if a switch is missing, which is the shape
  a hand-started `tmux` gives. Live (2026-11-06, a real managed claude
  2.1.319 under this script): the claude process carried both claude
  switches, and after 80 s `readlink -f ~/.local/bin/claude` was unchanged
  and `<dir>/xdg-data/claude` did not exist.
- **The guard.** `run` writes `<dir>/real-links.json`, every symlink in
  `~/.local/bin` and `~/.kimi-code/bin` with its target. `check` fails on any
  of those links that now resolves inside `<dir>`, names what it pointed at
  before, and prints the `ln -sfn` that repairs it, shell-quoted. Run `check`
  again BEFORE deleting a scratch dir. It reports and never repairs. Round 1
  (reviewer P1-R1..P2-R3, each reproduced by validator): **only what was
  observed counts.** A link dir, link or target that cannot be read (EACCES,
  EIO; only ENOENT is absence) fails `check` with its path and reason, and the
  all-clear line is then never printed. A private tmux server is "none" only
  when tmux itself says so (`no server running on …`, or `error connecting to
  … (No such file or directory)`, measured on this host's tmux). Any other
  answer (`Permission denied`, tmux missing) fails, because a server that
  cannot be asked is not proven safe. A confirmed-absent server has no panes,
  so it passes even with a gateway recorded. Targets and the scratch dir are
  resolved the way the KERNEL resolves a path (`resolveOnDisk`, round 2):
  component by component from `/`, each symlink followed when it is met, and
  `..` applied only after that, so `alias/../v/cli` lands at the parent of
  alias's target, not alias's. Node's JS `realpathSync` normalises `..`
  lexically first and gets it wrong; the tests compare against
  `realpathSync.native` (libc `realpath`). The raw link text is kept until
  then, never `path.resolve`d. Only a component the filesystem says is
  missing (ENOENT) takes the dangling fallback (the rest as written, below
  what exists), so a link into a deleted scratch dir is still reported. Any
  other error on the way (EACCES on a directory that cannot be searched, EIO)
  and more than 40 symlinks (ELOOP) make the target UNKNOWN, and `check`
  fails naming the link and the reason. An alias of the dir, `..`, a trailing
  slash or macOS's `/var` → `/private/var` therefore cannot hide a link. A managed claude OUTSIDE scratch relinks within the
  real install (orchestrator 09:31: builder-3's fork moved it to 2.1.318). That
  is #50's fix at the source (claude's launch env), not this script's.
- **A scratch home gets COPIES of the user's CLI config, never links**
  (board #54). Incident 2026-11-06 14:00:38 and 14:20:04: a live check edited a
  scratch codex home's `config.toml` to point codex at a fake provider. That
  file is a symlink into the user's real `~/.codex/config.toml` (the managed
  render links it by design, `inherit_codex_system_files`), so the write
  changed the user's provider URL, and every codex started in the next
  20 minutes read a dead port. Measured on main 05a548c7 with one managed agent
  of each backend under this script: only codex links outside its home
  (`config.toml` and `*.config.toml`, plus `.env` and `auth.json` when the user
  has them); kiro's one link points INTO the home, and claude and kimi copy.
  So `run` sets the gateway's `CODEX_HOME` to `<dir>/codex-user`, which
  `codex_user_home` reads, and fills it with 0600 copies of exactly those files:
  the scratch's codex homes link the copy. `run` also writes
  `<dir>/real-config.json`, the sha256 of each real file a render links or
  reads (`~/.codex`'s linked set, `~/.claude/settings.json`,
  `~/.kimi-code/config.toml`). `check` fails when the gateway's `CODEX_HOME` is
  not the copy, when any link under `<dir>` or under a scratch workspace's
  `.tmm/agents` (the projects the scratch store declares) resolves outside
  `<dir>` and those workspaces, naming it, and when a real config's hash moved,
  naming the file. Round 1 (validator-2 F1 on `80ce562b`, live): codex 0.166.0
  links its own arg0 helpers (`tmp/arg0-linux/<id>/apply_patch`, `applypatch`,
  `codex-linux-sandbox`) to its executable, so `check` was red on every codex
  run. A link whose real target is the executable of a NAMED agent CLI
  (`CLI_PROGRAMS`: claude, codex, dsh, grok, kimi, kiro-cli, omp, found on the
  gateway's PATH and the user CLI bins a managed pane adds) passes; a link to
  any config, credential or data file, or to any other executable, still fails.
  Round 2 (reviewer P1-A/B on `40ed7067`, both reproduced by validator-2 with
  fake homes): `run` reuses an existing dir, and the copy followed a link
  already standing at `<dir>/codex-user` or at a file in it. Now the copy dir
  must be a real 0700 directory of ours (a link, a file or an open mode is
  refused), and each copy is a FRESH 0600 file written beside it with
  `O_EXCL|O_NOFOLLOW` and renamed over the name, so a symlink or a hard link
  already there is replaced and never written through or chmodded. And, as
  #48's rule: a scratch subtree or a real config that cannot be read (anything
  but ENOENT) fails `check` by path, never reads as absent or clean. Still the rule outside a script: **never edit an agent
  home's config in place**; `readlink -f` it first, and change a scratch CLI's
  settings with a launch-line override (`-c key=value`) or a copy.
- **Scope.** This removes INHERITED ROUTING to the live tmux server and
  gateway. `isolatedEnv` keeps `HOME` and the network, so a child that dials
  the live gateway's port on purpose still can; it is not a sandbox
  (`scripts/isolated.mjs` is). `pnpm run test:rust` and `isolated.mjs` are
  already isolated. A scratch server started without the helper is
  unguarded; the closest manual form is `env -u TMUX -u TMUX_PANE -u
  TMUX_SOCKET -u TMM_SOCKET TMUX_TMPDIR=<private> <command>`, but only the
  helper drops every `TMM_*` and `TOKEN`.

Board #48 is pinned by `scripts/scratch-env.test.ts` (every switch is set over the caller's value, `check` reports a missing one, and the 08:00 shape is reproduced on a fake home: a relinked link and a new link into the dir are both reported, with the earlier target and its repair; round 1: an unreadable link dir fails both the function and the `check` command with no all-clear line, tmux's two absence wordings versus any other error, a link through an alias and a dangling one into a deleted dir, four spellings of the root, and a repair with a space and a quote; round 2: `alias/../v/cli` and a relative target agree with the kernel's `realpath`, a target through a directory that cannot be searched fails the guard with EACCES, a symlink loop is ELOOP, and a missing component keeps the dangling fallback) and by `scripts/test-rust.test.ts` (`isolatedEnv` sets each switch).

Pinned by `scripts/scratch-env.test.ts`: the macOS KERN_PROCARGS2 parser on
bytes captured on clawdbjs (the argv copy cut, a value holding
` TMUX_TMPDIR=<dir>` kept whole and the check failing as on Linux) and each
unreadable case failing; the file runs on macOS too (the real `/proc` read is
Linux-only); the value checks on this pane's real
variables, with negative controls for an empty TMUX_TMPDIR, `/tmp`, a foreign
config root and an unset root; the root's privacy; the config written before
launch and port 9899 refused; the routing verdict for the incident's answer,
an empty answer, a foreign session and a missing marker. None of them starts
anything against the live server.

### Integrating a reviewed branch (`tmm merge`, board #445)

The integration checkout merges a branch only after reviewer CLEAR and
validator SHIP of ONE tip. `tmm merge <issue> <branch> --expect <that tip>`
does the rest, run in that checkout:
- reads the issue and binds the repository, the target and the branch tip;
- squash-merges with `git merge-tree --write-tree`;
- proves the squash diff is byte-for-byte the branch diff;
- commits with the configured author and the branch's own Co-authored-by
  trailers;
- swaps the target ref by compare-and-swap and checks it out;
- reads it all back and posts the issue note from those reads.

It does not push, deploy or delete the branch; those stay separate, explicit
steps. The manual sequence it replaces is the same order, written out in
tmm-cli.md § tmm merge. A value typed into a note by hand is exactly what the
command exists to stop.

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
pnpm run test:rust
```
Rust tests are sequential (shared tmux state), spread across `src-tauri/src/*.rs`
(`main.rs`, `tmux.rs`, and the `server/` and `projects/` modules — unit tests
live in the submodule they test). Frontend tests: `pnpm test` (node --test,
`src/**/*.test.{js,ts}`, no tmux needed; conventions in
