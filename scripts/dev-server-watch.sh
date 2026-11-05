#!/usr/bin/env bash
# Watch-and-supervise loop for the headless WS server.
#
# Why this exists instead of `tauri dev --release`: this host has no
# webkit2gtk-4.1 and no DISPLAY (verified 2026-08-18), so the Tauri shell
# cannot even build here — the headless `--no-default-features` path is the
# supported one (see AGENTS.md "Headless build"). What `tauri dev` would have
# provided for the server half is exactly what this loop does:
#
#   1. build the release server AND the `tmm` CLI, run the server,
#   2. restart it when it EXITS (crash or clean), 2s backoff,
#   3. rebuild when Rust SOURCES CHANGE (mtime poll — no inotify dependency,
#      NFS-safe; measured 4ms per scan over 46 files, so the 3s poll is a
#      ~0.1% duty cycle),
#   4. restart ONLY when the rebuilt binary's bytes actually differ. cargo
#      fingerprints by mtime, so `touch`, a git checkout, or a comment-only
#      edit can relink an identical binary — restarting the server for that
#      would drop every client for nothing,
#   5. debounce: a change is acted on only after the tree has been quiet for
#      one poll interval (a checkout writes files for several seconds), and
#   6. a failed rebuild keeps the last good binary running; retry next change.
#
# `tmm` ships with the server (board #282): it is the ONE CLI every agent and
# the owner run (~/.local/bin/tmm -> target/release/tmm), and a verb the server
# learned is useless until the CLI can say it. Built `--server` alone, tmm sat
# at 09-26 for three days while agents were taught `task --wake`, `wake` and
# `agent mode` it did not have. A rebuilt tmm restarts NOTHING: step 4 hashes
# the server binary only, and each tmm run execs the file anew.
#
# Started by scripts/dev-stack.mjs (`pnpm run dev:all`); on the dev host that
# runs as the systemd user unit tmux-mobile-dev.service, so do NOT also start
# it as a task there (a second watcher and server). Elsewhere, a generic
# example of running it alone so its log survives in a tmux window:
#   tmm task start server --replace -- scripts/dev-server-watch.sh
set -u
cd "$(dirname "$0")/.."
. "$HOME/.cargo/env" 2>/dev/null || true

BIN=src-tauri/target/release/server
MANIFEST=src-tauri/Cargo.toml
export HOST="${HOST:-127.0.0.1}"

# Newest mtime over the sources the server is built from. One find, no xargs
# re-stat; explicit paths (Cargo.toml, build.rs) still pass the name group.
stamp() {
  find src-tauri/src src-tauri/crates src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs \
    \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) \
    -printf '%T@\n' 2>/dev/null | sort -rn | head -1
}

bin_hash() { [ -f "$BIN" ] && sha256sum "$BIN" | cut -d' ' -f1; }

build() {
  echo "[watch] building server + tmm ($(date +%H:%M:%S))"
  cargo build --manifest-path "$MANIFEST" --no-default-features --release --bins
}

pid=""
stop_server() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  pid=""
}
trap 'stop_server; exit 0' INT TERM

build || echo "[watch] initial build FAILED — will retry on next change"
hash=$(bin_hash)
last=$(stamp)
pending=""

while :; do
  # ── supervise ───────────────────────────────────────────────────────────
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    if [ -n "$pid" ]; then
      echo "[watch] server exited ($(date +%H:%M:%S)) — restarting in 2s"
      sleep 2
    fi
    if [ -x "$BIN" ]; then
      "$BIN" & pid=$!
      echo "[watch] server up (pid $pid)"
    else
      echo "[watch] no binary yet — waiting for a successful build"
      sleep 5
    fi
  fi
  # ── watch, with a one-interval settle ──────────────────────────────────
  cur=$(stamp)
  if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
    if [ "$cur" = "$pending" ]; then
      # Quiet for a full interval: act on it.
      echo "[watch] sources changed — rebuilding"
      if build; then
        new=$(bin_hash)
        if [ "$new" != "$hash" ]; then
          echo "[watch] binary changed — restarting server"
          hash="$new"
          stop_server
        else
          echo "[watch] binary identical (touch/comment/checkout) — NOT restarting"
        fi
        last="$cur"
        pending=""
      else
        echo "[watch] rebuild FAILED — keeping the running server"
        last="$cur"   # do not retry the same failure every poll; next change retries
        pending=""
      fi
    else
      pending="$cur"   # first sighting: let the tree settle one interval
    fi
  fi
  sleep 3
done
