# syntax=docker/dockerfile:1.7
# One simulated machine for the multi-server e2e environment (board #352):
# this checkout's web UI, `tmm` and `server` built INSIDE the image (never a
# host binary), tmux, and a stand-in `kiro-cli` so a managed project can hold
# a real agent window. Build context = the repo root (see /.dockerignore).

# --- 1. the web UI (embedded into the gateway binary) -----------------------
FROM node:22-trixie-slim AS ui
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm, the version package.json's packageManager names, through the image's
# corepack (board #33). --ignore-scripts: no dependency's install hook is
# needed for `vite build` (esbuild's platform binary arrives as an optional
# dependency).
RUN corepack enable
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY index.html vite.config.js svelte.config.js tsconfig.json ./
# vite.config.js imports the dev-port table from scripts/.
COPY scripts/dev-ports.mjs scripts/env-names.mjs scripts/hover-guard.mjs ./scripts/
COPY public ./public
COPY src ./src
# The image has no `.git` (.dockerignore keeps it out, on purpose), so the
# source revision arrives as PUBLIC build metadata: vite.config.js reads
# SOURCE_COMMIT / SOURCE_TIME first (board #368). Empty = `dev`.
ARG SOURCE_COMMIT=
ARG SOURCE_TIME=
ENV SOURCE_COMMIT=$SOURCE_COMMIT SOURCE_TIME=$SOURCE_TIME
RUN pnpm exec vite build

# --- 2. tmm + server, release, no webview, UI embedded -----------------------
# `rust:1` floats to the current stable; the crate pins no toolchain, so this
# is the same contract as a developer's `rustup update`. `--locked` keeps the
# dependency graph the one in Cargo.lock.
FROM rust:1-trixie AS rust
WORKDIR /src
COPY src-tauri ./src-tauri
# `include_str!`s in src/projects/skills.rs reach the bundled skills.
COPY assets/skills ./assets/skills
COPY --from=ui /src/dist ./dist
# The same revision for build.rs (SOURCE_COMMIT / SOURCE_TIME, then git, then dev).
ARG SOURCE_COMMIT=
ARG SOURCE_TIME=
ENV SOURCE_COMMIT=$SOURCE_COMMIT SOURCE_TIME=$SOURCE_TIME
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/src-tauri/target \
    cargo build --locked --manifest-path src-tauri/Cargo.toml \
      --no-default-features --features embed-ui --release --bins \
    && install -D -t /out src-tauri/target/release/tmm src-tauri/target/release/server

# --- 3. the machine: tmux, the binaries, a fake agent CLI --------------------
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ca-certificates procps git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 tmm \
    && install -d -o tmm -g tmm /work
COPY --from=rust /out/tmm /out/server /usr/local/bin/
COPY docker/validator/kiro-cli /usr/local/bin/kiro-cli
COPY docker/validator/entrypoint.sh /usr/local/bin/tmm-e2e
USER tmm
ENV HOME=/home/tmm TERM=xterm-256color LANG=C.UTF-8
EXPOSE 9899
# Healthy = an authenticated RPC answered by THIS container's gateway.
HEALTHCHECK --interval=2s --timeout=5s --start-period=3s --retries=30 \
    CMD ["tmm-e2e", "health"]
ENTRYPOINT ["tmm-e2e"]

# --- 4. the Docker LIVE rig (board #55): real agent CLIs, no host --------------
# The ONE place a live check with a real agent CLI runs (owner, 2026-11-06 15:07: no test on this
# host). `docker build --target live`. The CLIs are pinned to the versions measured on the host
# (claude 2.1.319, codex-cli 0.166.0, omp 18.15.0 with the Bun 1.4.4 its package names in
# `engines`, `bun >=1.4.4`); kiro-cli 2.37.1 and kimi 2.5.1 have no
# public pinned install measured yet and are NOT faked here (#55 notes). No credential is baked in:
# they arrive by NAME at `docker run` (scripts/live-docker.mjs). The marker lets scratch-env run.
FROM node:22-trixie-slim AS live
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux zsh ca-certificates procps git python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-fund --no-audit \
      @anthropic-ai/claude-code@2.1.319 @openai/codex@0.166.0 @oh-my-pi/pi-coding-agent@18.15.0 bun@1.4.4 \
    && npm cache clean --force
RUN usermod -l tmm -d /home/tmm -m node && groupmod -n tmm node \
    && install -d -o tmm -g tmm /work \
    && : > /etc/teammux-live-rig
COPY --from=rust /out/tmm /out/server /usr/local/bin/
COPY docker/live/live-check.sh /usr/local/bin/live-check
USER tmm
# Every CLI's no-update switch (scripts/test-rust.mjs UPDATE_SWITCHES), so nothing self-updates.
ENV HOME=/home/tmm TERM=xterm-256color LANG=C.UTF-8 \
    DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 KIMI_CODE_NO_AUTO_UPDATE=1 KIRO_NO_AUTO_UPDATE=1
WORKDIR /work
ENTRYPOINT ["live-check"]
