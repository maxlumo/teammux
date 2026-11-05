# xterm.js Build-Time Patch (vite.config.js)

## What

`allowCompactXtermLines()` in `vite.config.js` is a Vite `transform` hook that
string-patches `@xterm/xterm`'s **published, minified** `xterm.mjs` at build
time. It makes three edits:

1. **lineHeight lower bound**: xterm rejects `lineHeight < 1`; we relax the
   bound to `0.4` for `lineHeight` only, enabling the compact line-spacing
   setting (see `terminal-prefs.svelte.ts`, `LINE_HEIGHT_MIN` — the two bounds
   must stay in sync).
2. **DOM glyph renderer**: wraps each row's text in an inner
   `<span class="xterm-glyph">` so compact rows can crop the *cell box*
   without moving the glyph baseline (see `fonts.md`, glyph-layer section).
3. **IME composition view**: same inner-span treatment for the composition
   text, keeping the IME candidate-window anchor at the unmoved outer box.

## Why a source patch

xterm.js exposes no hook for any of these: the bound check is hardcoded, and
both renderers assign `textContent` directly. Forking the package was
rejected — we'd own the whole fork for three one-line edits. The patch is the
smallest thing that works, at the cost of coupling to minified output.

## Failure mode (deliberate)

The transform **throws at build time** if any expected pattern is missing or
appears the wrong number of times. A silent no-match would ship a broken
terminal; a loud build failure points here instead. If `pnpm run build` or
`pnpm run dev` fails with `Unsupported @xterm/xterm ...`, an xterm upgrade
changed the minified output — do NOT weaken the assertion to make the build
pass.

## Upgrade procedure

`@xterm/xterm` is **pinned exactly** (no caret) in `package.json` because
even a patch release can rename minified locals and break the string match.
To upgrade:

1. Bump the pinned version, `pnpm install`.
2. Run `pnpm run build`. If the transform throws, open
   `node_modules/@xterm/xterm/lib/xterm.mjs`, find the new equivalents of the
   three patterns (search for `cannot be less than`, the glyph
   `textContent=` assignment, `_compositionView.textContent`), and update the
   constants in `vite.config.js`.
3. Re-verify on a device: compact line spacing (< 1.0) renders without
   clipped glyphs, and CJK IME composition shows at the caret.

## Related

- `docs/design-docs/features/fonts.md` — glyph layer + renderer signatures
- `docs/design-docs/pages/terminal-sizing.md` — cols × rows management
