# Terminal Color Adaptation

## Context
AI CLIs (Kiro, Claude Code, etc.) ship ANSI truecolor / 256-color codes tuned for a *typical* dark terminal around bg ≈ `#1e1e1e`. Teammux's themes are harsher at both ends:

- Dark: `#0a0a0f` (near-black)
- Light: `#f5f5f7` (near-white)

Unchanged, a Kiro "Tasks" panel with BG `rgb(238,238,238)` reads as a **blinding near-white block** on our dark background, and in light mode the previous behavior (flat `255 - c` RGB inversion) produced **pure-black blocks and wrong hues**.

## Decision
Adapt colors at write-time, in JS, before handing to xterm.js. Instead of a blanket inversion, an SGR state machine tracks the effective foreground, background, and reverse-video state. It **preserves hue + saturation** and only moves a color's luminance when:

- The effective **FG/BG pair** lacks WCAG AA contrast (< 4.5:1) — move the foreground toward the nearest readable lightness while preserving hue and saturation.
- It's a **BG block** that either clashes with the terminal bg (too bright in dark mode, too dark in light mode) or blends into it (too close to the terminal bg in light mode) — push it to a mid-luminance band that reads as a "block" without dominating.

Decisions use **WCAG relative luminance** (perceptually correct); construction uses HSL L (cheap to edit hue/saturation separately). Thresholds are covered by the executable matrix in `src/lib/terminal/ansi-colors.test.ts`.

## How It Works
1. Parse every SGR sequence and update the current foreground, background, reset, and reverse-video state.
2. Resolve basic ANSI 0–15 colors through the active xterm theme; resolve indexed 16–255 colors through the standard palette; read 24-bit colors directly.
3. Adapt an explicit background block against the terminal background, while leaving the default background untouched.
4. Compute the effective displayed FG/BG pair (including reverse video). If contrast is below 4.5:1, binary-search HSL lightness toward the higher-contrast black/white direction, stopping at the smallest passing change on that path.
5. Append explicit truecolor FG/BG overrides after the original SGR sequence, preserving non-color attributes while making the mapped pair deterministic.

Cache by (text, theme) so a stable pane doesn't re-transform on every frame.

### Key constants
| Name | Value | Role |
|------|-------|------|
| `MIN_TEXT_CONTRAST` | 4.5 | Effective FG/BG pair must meet WCAG AA normal-text contrast |
| `BG_CLASH_RATIO_DARK` | 4.5 | Dark BG > 4.5× brighter than term bg → recolor |
| `BG_CLASH_RATIO_LIGHT` | 1.8 | Light BG > 1.8× darker than term bg → recolor |
| `BG_BLEND_RATIO_LIGHT` | 1.15 | Light BG within 1.15× of term bg → recolor (invisible) |
| `HSL_L_BG_{DARK,LIGHT}` | 0.30 / 0.75 | Target HSL L for explicit background blocks |

## Alternatives Considered
- **Flat RGB inversion** (old behavior). Rejected: destroys hue, produces near-black UI blocks in light mode, and leaves Kiro's bright UI blocks blinding in dark mode.
- **xterm.js `minimumContrastRatio` plus background-only preprocessing**. Rejected after testing: xterm adjusts FG *for every cell at render time*, but keeps pair decisions split across two systems, cannot help with glaring BG blocks by itself, and does not cover reverse-video semantics deterministically.
- **Do-nothing**. Rejected: that's what produced the user-reported bug.

## Trade-offs
- Target luminance values are global constants; colors from different CLIs map to the same targets. Saturated colors (pure green, pure red) land at slightly different WCAG L than greys because HSL L → WCAG L is non-linear; the effect is that saturated colors end up *slightly* brighter than their grey peers, which actually helps semantic colors stand out.
- Always running adaptation (vs the old "light-only" path) adds one SGR scan per changed terminal snapshot. The Terminal component caches the last `(content, theme)` result. A local benchmark maps a 21.5 KiB ANSI snapshot in ~0.52 ms on the development Mac.
- The adapter emits explicit truecolor overrides after color-changing SGR sequences. This makes theme results deterministic, but terminals that intentionally combine bold with the basic 8-color palette receive the theme's resolved base color rather than asking xterm to synthesize a separate bold-as-bright variant.

## Verification

`npm test` (the ansi-colors suite) covers dark and light themes, truecolor, indexed and basic ANSI colors, reset behavior, reverse video, default-background preservation, and a 288-pair representative color matrix. Every mapped pair must retain at least 4.5:1 contrast.

## Lessons Learned
- The original symptom was reported as "dark mode renders as white background, light mode as black background" — it was literally the symptom of a blind RGB inversion; the fix required separating the *role* (FG vs BG) from the *color space* (perceptual vs nominal).
- HSL L and WCAG L are **not** the same. Early drafts used HSL L for decisions; saturated dark colors (e.g. `rgb(200,0,0)`) slip past thresholds unexpectedly. Always decide in WCAG L; only use HSL to *construct* the target color.
- Keep a runnable offline harness (`temp/color_test.js`) with representative inputs (Kiro Tasks block, error boxes, rainbow hues, pure black/white, 256-color spot checks, FG+BG pair samples). Iterating against the harness caught two rounds of wrong thresholds before any on-device test.
