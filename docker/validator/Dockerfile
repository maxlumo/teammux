# syntax=docker/dockerfile:1.7
# One simulated machine for the multi-server e2e environment (board #352):
# this checkout's web UI, `tmm` and `server` built INSIDE the image (never a
# host binary), tmux, and a stand-in `kiro-cli` so a managed project can hold
# a real agent window. Build context = the repo root (see /.dockerignore).

# --- 1. the web UI (embedded into the gateway binary) -----------------------
FROM node:22-trixie-slim AS ui
WORKDIR /src
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency's install hook is needed for `vite build`
# (esbuild's platform binary arrives as an optional dependency).
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY index.html vite.config.js svelte.config.js tsconfig.json ./
# vite.config.js imports the dev-port table from scripts/.
COPY scripts/dev-ports.mjs ./scripts/
COPY public ./public
COPY src ./src
RUN npx vite build

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
