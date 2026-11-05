#!/usr/bin/env bash
# Fetch / generate the two bundled web fonts into public/fonts/.
#
# These files are deliberately NOT committed (see .gitignore). Run once
# after cloning, before `pnpm run build` / `pnpm run build:android`.
# Requires fonttools with brotli (`pip install fonttools brotli` or
# `uv tool install fonttools --with brotli`).
#
# The bundle is exactly what index.html's @font-face loads (see
# docs/design-docs/features/fonts.md for the design + the trap notes):
#
#   - noto-symbols2-subset.woff2 — Noto Sans Symbols 2 subset to the
#     terminal-relevant blocks (arrows, technical, geometric, dingbats
#     incl. agent markers, braille spinners, misc symbols).
#   - symbols-nerd-mono.woff2 — Nerd Font PUA icons (starship etc.).
#
# Maple Mono is NOT bundled anymore: it participates only as a local()
# source when the user has it installed (fonts.md §history).
#
# Idempotent: re-running overwrites the outputs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/fonts"
mkdir -p "$OUT"

command -v fonttools >/dev/null || {
  echo "✗ fonttools not found — pip install fonttools brotli" >&2; exit 1; }

dl() {
  echo "↓ $(basename "$2")"
  curl -fsSL -o "$2" "$1"
}

TMP="$(mktemp -d -t fonts)"
trap 'rm -rf "$TMP"' EXIT

echo "== Noto Sans Symbols 2 (download → subset) =="
dl "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-symbols-2@latest/files/noto-sans-symbols-2-symbols-400-normal.woff2" "$TMP/noto-symbols2-400.woff2"
fonttools subset "$TMP/noto-symbols2-400.woff2" \
  --unicodes="U+2190-21FF,U+2300-23FF,U+25A0-25FF,U+2600-27BF,U+2800-28FF,U+2B00-2BFF" \
  --flavor=woff2 --output-file="$OUT/noto-symbols2-subset.woff2"

echo "== Nerd Symbols (download TTF → woff2) =="
dl "https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.4.0/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf" "$TMP/nerd.ttf"
fonttools ttLib.woff2 compress -o "$OUT/symbols-nerd-mono.woff2" "$TMP/nerd.ttf"

echo "✅ $(ls -lh "$OUT" | awk 'NR>1 {print $9, "("$5")"}' | tr '\n' ' ')"
