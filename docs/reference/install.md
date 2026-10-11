# Installing tmux-mobile

Two pieces run on the machine whose tmux you want to reach:

- **the gateway** (`tmm gateway`): the server, as a per-user background service. Phones, browsers and the desktop app all connect to it.
- **the desktop app** (macOS, optional): a window onto the same server.

## macOS from the DMG

You need tmux (`brew install tmux`). The app is not signed or notarized yet: the first time, macOS refuses to open it. Right-click it in Finder → **Open** → **Open**, or run `xattr -dr com.apple.quarantine /Applications/TmuxMobile.app`.

Install the gateway first, then open the app. The other way round, the app starts its own server on the gateway's port, and `tmm gateway` refuses to start next to it.

1. Open the DMG and drag **TmuxMobile.app** into `/Applications` (or `~/Applications`). Use it from there: the gateway service records the path of the `tmm` inside the app, and a path on the mounted DMG, or a temporary copy macOS made on a first launch from the DMG, disappears.
2. Make the bundled `tmm` reachable:

   ```bash
   mkdir -p ~/.local/bin
   ln -s /Applications/TmuxMobile.app/Contents/MacOS/tmm ~/.local/bin/tmm   # ~/.local/bin must be on your PATH
   ```

3. Start the gateway:

   ```bash
   tmm gateway
   ```

   With no `~/.config/tmux-mobile/config.toml` yet it asks a few questions (port, listen address, tmux socket, optional TLS) and writes it; `tmm setup` runs the same questions again later. It then installs and starts the launchd agent `cc.voka.tmux-mobile`, which starts at login. `tmm gateway status` shows it and prints the connect hint; `tmm ui --open` opens the web UI the gateway serves.

4. Open the app. At start it checks for this machine's gateway (the same check `tmm gateway status` makes: a login with your token, answered with this machine's id):
   - the gateway answers → the app uses it and starts no server of its own;
   - nothing is listening → the app starts its own server, which stops when you quit the app;
   - something else holds the port → the app starts nothing and says why on the connect page.

   The server card on the left rail shows which, on its **This computer** line. Quitting the app never stops the gateway.

**If you opened the app first**, it is running its own server on that port. Quit the app (⌘Q; its server stops with it), then run `tmm gateway`, then open the app again. Its first launch already wrote `config.toml` with a token, so `tmm gateway` asks nothing; run `tmm setup` first if you want to change the port or listen address.

**What was tested.** The reuse and the embedded fallback were checked on an Apple-silicon Mac (macOS 27) by launching the app binary with an explicit environment. A double-click from Finder starts the app with launchd's PATH, not your shell's; the app itself needs none, but tmux has to be reachable for the server, and the gateway service sets its own PATH. Starting from Finder has not been verified end to end.

After moving the app, run `tmm gateway install --replace` with the new `tmm`: the installed service names the old path, so to the new `tmm` it is not its own and a plain `tmm gateway` refuses it.

## Linux

Build the server and `tmm` (`npm run build:server`: the web UI is embedded), put `src-tauri/target/release/tmm` on your PATH and run `tmm gateway`. It installs a systemd user unit, `tmux-mobile-gateway.service`. On a headless machine, `loginctl enable-linger <user>` lets it start at boot.

## Switching a dev host to the gateway

A machine that has been developing tmux-mobile for a while starts its backend
from `scripts/dev-server-watch.sh` inside `tmux-mobile-dev.service`: that
watcher's `server` IS the gateway binary, just not under the gateway's own
unit, so `tmm gateway status` says "not installed" while something answers on
the port. Board #343 splits the two jobs — vite stays in the dev unit, the
backend becomes `tmux-mobile-gateway.service`, and `npm run gateway:update`
rebuilds and restarts it after each merge to main.

Run these steps yourself (an agent does not restart your stack), in this order:
`tmm gateway install` REFUSES while anything else holds the port, which is
deliberate — a second instance could only fail, and an answering stranger would
hide that.

1. **See what you have.** `tmm gateway status` should say the service is not
   installed while a gateway answers; `systemctl --user cat
   tmux-mobile-gateway.service` should find no file.

2. **Stop the whole old supervision chain**, not just whatever holds a port.
   The chain is the unit → `scripts/dev-stack.mjs` → `scripts/dev-server-watch.sh`
   → `server`: kill only the server and the watcher starts another one, and a
   momentarily free port proves nothing.

   First read the unit AS CONFIGURED, drop-ins included:

   ```bash
   systemctl --user cat tmux-mobile-dev.service
   ```

   This host carries a `cutover.conf` drop-in with `KillMode=none` and
   `Restart=no`. Per `systemd.kill(5)`, `none` kills NOTHING on stop (it only
   runs `ExecStop`), and `process` signals the main process alone; only the
   default, `control-group`, stops the whole chain. So either remove that
   drop-in and `systemctl --user daemon-reload` so the default applies again,
   or stop the unit and then terminate `dev-stack.mjs` yourself — it handles
   `SIGTERM` by stopping each service's process group, escalating to `SIGKILL`
   after 5 s:

   ```bash
   systemctl --user stop tmux-mobile-dev.service
   systemd-cgls --user-unit tmux-mobile-dev.service          # the authority: what is left in the cgroup
   pgrep -fa "$PWD/scripts/dev-stack.mjs|$PWD/scripts/dev-server-watch.sh|$PWD/src-tauri/target/release/server"
   kill <the dev-stack.mjs pid>    # top-down: the supervisor first, never the
   #                                 server alone; re-run pgrep until it is empty
   ```

   The cgroup listing is what decides, and the `pgrep` is scoped to THIS
   checkout's paths: the question is whether this unit's chain is gone, not
   whether the machine runs nothing of that shape. Never `pkill` by a broad
   pattern — other agents' builds and servers run on this host. Only once this
   unit's processes are gone and both ports stay free is the chain down:

   ```bash
   ss -ltn | grep -E '5173|9899'   # expect nothing, and again a few seconds later
   ```

   A surviving watcher would otherwise race `install` for the port, or relink
   `target/release` under the new gateway.

3. **Write the port and the listen address into `config.toml`.** The service
   reads that file ALONE, and the `HOST`/`PORT` the watcher passed came from
   its environment, which never reaches it. Skip this and the gateway comes up on
   the defaults — `0.0.0.0:9899`, reachable from your whole network instead of
   loopback-only.

   ```bash
   tmm setup
   #   Port [9899]:                     ← Enter
   #   Listen on [0.0.0.0]: 127.0.0.1   ← what the watcher passed; loopback only
   #   tmux socket …:                   ← Enter (empty = tmux's default, as today)
   #   Keep the existing token? [y]:    ← Enter; a new token re-pairs every saved client
   #   TLS certificate …:               ← see below
   ```

   It edits the file in place with `toml_edit`: your token, `team_rules` and
   `kiro_engine` stay, comments and all.

   On TLS, Enter is not "no TLS": with a certificate already in the file Enter
   KEEPS it and `-` clears it. Check `config.toml` and decide deliberately. The
   dev loop needs plain `ws`/`http` on the loopback hop — Vite's proxy speaks
   nothing else, and the watcher used to force it by passing empty
   `TLS_CERT`/`TLS_KEY`, which the gateway does not read. So either confirm
   `tls_cert`/`tls_key` are empty (clear them with `-`), or keep TLS and
   configure the proxy to match; do not leave a certificate set and expect the
   plain hop to work.

4. **Build the binary the service will run.** The watcher built `--bins`
   WITHOUT `embed-ui`, so the `tmm` sitting in `target/release` right now
   carries no web UI: installed as it is, the gateway serves none and `tmm ui`
   says so until the first `build:server` (that is also what
   `npm run gateway:update` would fix afterwards). Build it here, with nothing
   watching the tree to relink a UI-less copy over it:

   ```bash
   npm run build:server
   ```

5. **Install the gateway** with the `tmm` of this checkout:

   ```bash
   ~/.local/bin/tmm gateway install
   ```

   It writes `~/.config/systemd/user/tmux-mobile-gateway.service` with
   `ExecStart=<repo>/src-tauri/target/release/tmm gateway start --service`,
   runs `daemon-reload` and `enable --now`, and returns only once OUR gateway
   answers. `~/.local/bin/tmm` is a symlink to that same file, so the identity
   the unit records (this `tmm`, this config root) survives every rebuild.

6. **Start the frontend again.** The dev unit needs no edit — `dev-stack.mjs`
   is vite alone by default since #343:

   ```bash
   systemctl --user restart tmux-mobile-dev.service
   ```

7. **Verify.** `tmm gateway status` now says the service is installed and
   running and that the gateway answers at `ws://127.0.0.1:9899` (this
   machine); `ss -ltn | grep -E '5173|9899'` shows both; `tmm ui` prints the
   URL the gateway itself serves; open the app.

From then on, after every merge to main: `npm run gateway:update`. It runs
`npm run build:server`, then restarts the gateway unless the binary is already
the one the gateway is running — the receipt beside the binary
(`.tmm-gateway-deployed.json`, naming the binary, the config root and the
service, as the service's own identity does) records a deploy that was
CONFIRMED answering, written after the check and never before it. A build's
output alone cannot say what is running: after a failed restart the next build
produces the same bytes, and "nothing changed" would skip the deploy for good.
So a failed build leaves the running gateway alone, a failed restart deploys
nothing, a deploy the gateway did not survive records nothing — and exit 0,
with the commit it prints, means the gateway answered as ours after everything
that run did. It supports the default Cargo layout only:
a `CARGO_TARGET_DIR`, a `--target`, or a `target-dir` in a cargo config moves
the artifact, and the run stops and asks you to name it with
`TMUX_MOBILE_GATEWAY_TMM` rather than hash one file and restart another.

To go back: `tmm gateway uninstall`, then run the dev stack with the watcher
again (`TMUX_MOBILE_DEV_WITH_SERVER=1`).

## Removing

```bash
tmm gateway uninstall      # stops and removes the service
```

The configuration stays in `~/.config/tmux-mobile/`. The design behind every step is in [tmm-cli.md § The gateway](../design-docs/features/tmm-cli.md#the-gateway-tmm-gateway-board-323).
