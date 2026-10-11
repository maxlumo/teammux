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

2. **Write the port and the listen address into `config.toml`.** The service
   reads that file ALONE, and today's `HOST`/`PORT` come from the watcher's
   environment, which never reaches it. Skip this and the gateway comes up on
   the defaults — `0.0.0.0:9899`, reachable from your whole network instead of
   loopback-only.

   ```bash
   tmm setup
   #   Port [9899]:                     ← Enter
   #   Listen on [0.0.0.0]: 127.0.0.1   ← what the watcher passed; loopback only
   #   tmux socket …:                   ← Enter (empty = tmux's default, as today)
   #   Keep the existing token? [y]:    ← Enter; a new token re-pairs every saved client
   #   TLS certificate …:               ← Enter
   ```

   It edits the file in place with `toml_edit`: your token, `team_rules` and
   `kiro_engine` stay, comments and all.

3. **Stop the old stack** (this takes vite down with it):

   ```bash
   systemctl --user stop tmux-mobile-dev.service
   ss -ltn | grep -E '5173|9899'   # expect nothing
   ```

   If something still holds a port, check for a drop-in
   (`systemctl --user cat tmux-mobile-dev.service`): with `KillMode=none`
   systemd signals only the main process and leaves vite and the server
   running. Kill those PIDs before continuing.

4. **Install the gateway** with the `tmm` of this checkout:

   ```bash
   ~/.local/bin/tmm gateway install
   ```

   It writes `~/.config/systemd/user/tmux-mobile-gateway.service` with
   `ExecStart=<repo>/src-tauri/target/release/tmm gateway start --service`,
   runs `daemon-reload` and `enable --now`, and returns only once OUR gateway
   answers. `~/.local/bin/tmm` is a symlink to that same file, so the identity
   the unit records (this `tmm`, this config root) survives every rebuild.

5. **Start the frontend again.** The dev unit needs no edit — `dev-stack.mjs`
   is vite alone by default since #343:

   ```bash
   systemctl --user restart tmux-mobile-dev.service
   ```

6. **Verify.** `tmm gateway status` now says the service is installed and
   running and that the gateway answers at `ws://127.0.0.1:9899` (this
   machine); `ss -ltn | grep -E '5173|9899'` shows both; open the app.

From then on, after every merge to main: `npm run gateway:update`. It runs
`npm run build:server`, and restarts the gateway only when the `tmm` binary's
bytes actually changed (a relink of identical bytes drops nobody); a failed
build leaves the running gateway alone, and a failed restart exits non-zero.

To go back: `tmm gateway uninstall`, then run the dev stack with the watcher
again (`TMUX_MOBILE_DEV_WITH_SERVER=1`).

## Removing

```bash
tmm gateway uninstall      # stops and removes the service
```

The configuration stays in `~/.config/tmux-mobile/`. The design behind every step is in [tmm-cli.md § The gateway](../design-docs/features/tmm-cli.md#the-gateway-tmm-gateway-board-323).
