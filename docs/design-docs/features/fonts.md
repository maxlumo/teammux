# Fonts — bundled UI + display faces, system mono, bundled symbols, per-device override

## The UI face: Inter Variable, bundled (2026-08-25)

`--font-ui` leads with **'Inter Variable'**, self-hosted via
`@fontsource-variable/inter` (imported in `src/main.ts`, bundled by Vite —
subset files with `unicode-range`, so a client only downloads latin ~48 KB
unless it renders other scripts; ~224 KB total in dist for all subsets).
Owner request: "整体ui字体做的更具设计感一些…无衬线字体，但是要具备设计感
科技感，不同位置字体和谐统一，字体选择不要太多，尽量一致。terminal注意是
等宽字体" (2026-08-25).

Why bundled rather than a CDN `<link>`: this app lives exactly where a CDN
goes dark — the APK offline, a LAN server with no internet. Same-origin
files from `dist/` load everywhere the app itself loads. Why Inter: it is
THE common UI sans (the "cdn有的常用字体"), designed for screens at UI
sizes, and the variable weight axis makes the design system's mid-weights
(550 sidebar names, 650 bubble headers) render TRUE — system stacks
quantized them to 500/700, which is part of why the UI read as undesigned.
One face, not two: a display face for titles was considered and dropped
("字体选择不要太多"). Body text also enables Inter's `cv05`/`cv08`
character variants (disambiguated `l`/`I` — this UI is full of ids and
hashes) — through `@font-feature-values 'Inter Variable'` +
`font-variant-alternates`, never a raw `font-feature-settings`: see "The
feature that was the bug" below for the two weeks that cost.

## The display face: Space Grotesk Variable, the identity layer (2026-08-25)

Same day, the owner asked for the exception explicitly: "除了常用字体外
标题 名称等特殊 字体可以更特别一点". `--font-display` leads with
**'Space Grotesk Variable'** (`@fontsource-variable/space-grotesk`, same
self-hosting rationale; latin subset ~28 KB on the wire) and is applied to
the IDENTITY layer only:

- page titles (`.page-head h1`, app.css) and sidebar section headers
  (`.side-h` — uppercase at meta size with the existing 1.4px tracking);
- names: chat bubble headers (`.m-head`), agent roster cards (`.a-name`)
  and the agent menu header (`.am-who`), the Chat sidebar's project rows
  (`.p-name`), Projects rows (`.name`), Sessions rows (`.name`);
- the brand on the connect card (Settings `h2`).

Space Grotesk grew out of Space Mono, so the identity layer keeps the
terminal's genes while reading as a designed display sans. Both `.side-h`
and `.page-head h1` previously wore raw mono stacks — the display face
REPLACES that role; nothing else may adopt it. Three voices, one job each:
`--font-display` says WHO/WHERE, `--font-ui` says everything, `--font-mono`
says data. Window chips, vitals lines, paths and code stay mono — they are
data, not identity. CJK falls through to the same native CJK stack as
`--font-ui`.

Chinese stays on each platform's native CJK (PingFang / YaHei / Noto Sans
CJK) behind Inter in the stack: Inter has no CJK, and a downloadable CJK
subset is exactly what the 2026-07 un-bundling below traded away. The
terminal and all `--font-mono` surfaces are untouched by design — the
monospace story is the rest of this document.

## Simplified glyphs need the document's language (board #97, 2026-09-08)

"中文字体显示很怪异，不像是标准的简体中文字" had two causes, both about
FALLBACK resolution rather than the stacks' intent:

- `index.html` ships `lang="en"` and nothing updated it: Han-unified
  codepoints rendered by a fallback face pick their REGIONAL glyph variant
  from the document language, so platforms without a named SC family (or
  with a JP-preferring fontconfig default, typical on Linux) drew
  Japanese-variant shapes (直/骨/门…). `i18n.svelte.ts` now writes
  `document.documentElement.lang` (`zh-CN`/`en`) at init and on every
  `setLocale` — the module stays node-loadable behind a `typeof document`
  guard, and `i18n.test.ts` pins the behaviour.

**Round two (same day): the CONTENT tags itself.** The document-lang fix
only covers a CHINESE UI — the owner runs the ENGLISH UI, and a Chinese
message inside it still drew 骨 with the Japanese variant, because the
bubble's nearest lang was the document's `en`. Han-bearing user/agent text
now carries its own language: `hanLang(text)` (i18n.svelte.ts, pure,
`\p{Script=Han}` test, unit-tested) returns `zh-CN`/`undefined`, and the
chat bubble body (`.m-body`) and Board note text (`.n-text`) render
`lang={hanLang(...)}`. SC is this product's Han default; other surfaces
adopt the same tagger if the complaint reaches them.

**Round three (same day): SC by NAME, before the system slot.** With the
document lang right AND the content tagged, the owner's browser still drew
骨/感 as Japanese variants in bubbles while the composer was correct. The
culprit is `-apple-system`: the system-font slot does not "fall through"
for Han — it resolves CJK through the OS's own language-preference cascade
(page lang notwithstanding), so with Japanese preferred anywhere in the
system settings the page text landed on JP shapes before CSS ever consulted
'PingFang SC' further down the stack. (The composer's immunity was read at
the time as "the form/IME path picks by input language"; round five found
the real reason — see below.) Fix: the SC families moved AHEAD of
`-apple-system`/`BlinkMacSystemFont`/'Segoe UI' in both stacks (latin still
resolves at the bundled Inter / Space Grotesk in front), plus 'Hiragino
Sans GB' and Adobe's 'Source Han Sans CN' naming for older macs and Adobe
installs. `fonts.source.test.ts` pins the order AND that the
fonts.svelte.ts literals mirror app.css byte-for-byte.
- The UI/display stacks named only PingFang (macOS), YaHei (Windows) and
  Noto SC; a Linux desktop or non-Google Android often carries the Adobe
  naming instead. `'Source Han Sans SC', 'WenQuanYi Micro Hei'` now sit at
  the tail of `--font-ui`/`--font-display` (app.css + the mirrored literals
  in fonts.svelte.ts).

The three Settings font pickers are SELF-DEMONSTRATING since the same
review ("最好选择的字体本身就有样式，我好理解去选择"): `ui/Select` grew an
opt-in `fontPreview` mode — each option renders in the family it names and
the combo field wears the current value's face; a family the device lacks
falls through to the app stack, which is also the honest answer. Which
surfaces each role paints is explained by the row's hover card
(`fontFamilyHint`/`uiFontBodyHint`/`uiFontDisplayHint` — the #87 dialect,
never a persistent subtitle) and the picker's aria-label; the terminal
row's label is now "Terminal font"/"终端字体", not the ambiguous "Font
name"/"字体".

## The feature that was the bug: `font-feature-settings` reaches every font (board #97, round 5, 2026-09-08)

After rounds one to four both surfaces drew Han in **PingFang SC** (the
owner read it off DevTools → Computed → Rendered Fonts for the bubble AND the
composer) and the bubble was still wrong — and now visibly so in a
side-by-side: every 中文 punctuation mark in the bubble sat CENTRED in its
box (the Taiwan/Hong Kong convention) while the composer's sat bottom-left
(mainland), and 骨/感 wore their Traditional shapes. Same font file, two
sets of forms: that can only be a feature switch.

The switch was ours. Since 2026-08-25 `body` carried
`font-feature-settings: 'cv05' 1, 'cv08' 1` for Inter's l/I alternates. A
`cvNN`/`ssNN` tag has NO cross-font meaning — each font defines what its
numbered Character Variants do — and `font-feature-settings` applies to
every font that draws a glyph in the element, fallbacks included. PingFang
SC defines 5 and 8, and answers them with its Traditional forms. The
composer was immune for a reason that had nothing to do with IMEs: the UA
stylesheet gives `textarea`/`input` a `font: -webkit-small-control`
shorthand, and the `font` shorthand resets `font-feature-settings` to
normal; app.css only re-inherited `font-family`. Turning the one line off
(with Inter restored) fixed every bubble on the owner's Mac in one refresh
("哇 现在好了，这可是一个深藏的 bug").

The fix keeps the alternates and makes them unable to reach anything but
Inter: app.css declares `@font-feature-values 'Inter Variable' {
@character-variant { disambiguated-l: 5; disambiguated-i: 8; } }` and body
asks for `font-variant-alternates: character-variant(disambiguated-l,
disambiguated-i)`. `@font-feature-values` is keyed by family, so the
feature is applied only to glyph runs actually drawn by Inter Variable;
PingFang / YaHei / Noto SC never see the numbers. Inputs opt back in
(`font-variant-alternates: inherit`) — safe now. Chrome 111+, Safari,
Firefox support it; an older WebView simply loses the l/I tails.

**Rule (owner, 2026-09-08: "你一定记好，以后我们开发要注意"):** a raw
`font-feature-settings` is forbidden in the codebase — `fonts.source.test.ts`
scans every `.svelte`/`.css`/`.ts`. A font-specific feature (`cvNN`, `ssNN`,
`salt`, anything whose meaning the font decides) goes in
`@font-feature-values` for ONE named family; a generic typographic need uses
the `font-variant-*` property that names it (`font-variant-numeric:
tabular-nums`, `font-variant-ligatures`), which every font interprets the
same way. And when a glyph "looks foreign" while Rendered Fonts names the
right file, look for a feature, not a font.

## Context

The terminal (xterm.js) and all mono UI (`--font-mono`) need a monospace
font on every platform: macOS desktop, Android WebView, plus any browser
via the web UI. Three constraints pull against each other:

1. **Small payload** — the app ships in an APK and over the network; the
   user asked for "as little font bundling as possible".
2. **Correct rendering everywhere** — agent status markers (⏺ ✳ ✻),
   braille spinners, box drawing, CJK, Nerd Font prompt icons.
3. **Personal preference** — the operator likes Maple Mono on their own
   devices.

## History: why we un-bundled the text fonts (2026-07)

An earlier iteration bundled Maple Mono latin (2 cuts) + a 5 MB CJK subset
+ 2 symbol fonts (6.6 MB total), stack-fronted by `'Maple Mono NF CN'`.
Three defects, found by inspecting the actual woff2 payloads:

- **The latin file was the Light (300) cut** (`usWeightClass` 300 inside;
  the "600" file was actually Medium/500). Normal-weight text matched the
  300 face → thin rendering on every device *except* machines with the
  full font installed system-wide — i.e. it looked right on the dev
  machine and wrong for users. xterm was even configured with
  `fontWeight: 300 / fontWeightBold: 600` to match the bundle.
- **Dev machine ≠ user device**: the stack-front family only resolved on
  the developer's Mac. What users actually got was a four-font patchwork
  (thin latin → Noto Symbols → Nerd → CJK), each with different metrics.
- **Async webfont swap broke xterm metrics**: xterm measures cell width at
  `open()`; when the woff2 swapped in later the cached width was stale
  ("characters stuck together" on some MIUI WebViews). A
  `document.fonts.ready` re-measure + atlas-clear patch papered over it.

## Decision

**Text fonts come from the system; only symbols are bundled.**

xterm renders a fixed cell grid — column alignment comes from the grid,
not the font, and CJK is force-rendered at 2 cells. So platform-native
mono + CJK (SF Mono / Cascadia / Roboto Mono; PingFang / YaHei / Noto CJK
/ MiSans) is metric-safe and higher quality than any downloadable subset.

The default stack (App.svelte `--font-mono`, mirrored in
`src/lib/app/fonts.svelte.ts` `SYSTEM_STACK`):

```
ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', Consolas,
'Roboto Mono', 'Droid Sans Mono', 'Noto Sans Mono',
'Noto Sans Symbols 2', 'Symbols Nerd Font Mono', monospace,
'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC',
'Noto Sans SC', 'Source Han Sans SC', 'Source Han Sans CN', 'WenQuanYi Micro Hei'
```

**Round four of #97 (2026-09-08): the SC families close the mono stack too,
and every data surface goes through `var(--font-mono)`.** No monospace face
carries Han, so a Chinese character in the terminal, an inline code span, a
path, an id or a window chip reached the generic `monospace` and was drawn
by the OS cascade — the same Japanese variants the UI stack had just been
cured of, one surface over. The SC families now close the stack AFTER the
generic `monospace`, in app.css AND `SYSTEM_STACK` (`fonts.source.test.ts`
pins the mirror and the order). The generic in the middle is deliberate and
verified in headless Chromium: a family list keeps matching past a generic
for the glyphs the resolved font lacks, so latin always resolves at A
monospace (on a bare Linux with none of the named monos, that is the
generic's DejaVu Sans Mono) and only Han travels on to the SC faces. With
the SC faces BEFORE the generic, that same box rendered the whole line —
`ls -la` included — in Noto Sans SC, because an SC face carries latin too;
the terminal would have stopped being monospace. (A `@font-face` alias
with `local()` + `unicode-range` was the other candidate; `local()` did not
match a variable SC font by family name in the same test, so it was
dropped.) The 39 component rules that spelled their own
`ui-monospace, Menlo, monospace` were drift from design-language §"three
font roles" (`--font-mono` = data: terminal, code, paths, ids, chips): they
now wear `var(--font-mono)`, which is what gives them the SC tail — and,
as the contract always said, the user's terminal font. The test forbids a
raw mono literal in any component.

A note on diagnosis, for the next time a glyph "looks Japanese": Blink
renders a `<textarea>` and a `<p>` with the same stack through the same
font selection (verified with CDP `CSS.getPlatformFontsForNode`), and the
element's `lang` does not change which font the generic fallback picks
(only which variant a *multi-locale* face like Noto Sans CJK draws). The
fix is always a NAMED SC family in the stack that reaches that surface;
DevTools → Computed → "Rendered Fonts" tells you which font actually drew
the run.

Bundled (public/fonts/, @font-face in index.html):

- `noto-symbols2-subset.woff2` (~70 KB) — subset of Noto Sans Symbols 2 to
  the terminal-relevant blocks `U+2190-21FF, 2300-23FF, 25A0-25FF,
  2600-27BF, 2800-28FF, 2B00-2BFF` (arrows, technical, geometric shapes,
  dingbats incl. the agent markers ⏺✳✻, braille spinners, misc symbols).
  Regenerated by `scripts/fetch-fonts.sh` (download + subset in one step;
  the unicode ranges live in that script).
- `symbols-nerd-mono.woff2` (1.1 MB) — Nerd Font PUA icons (starship
  prompts etc.). No system font anywhere ships these. Could be subset to
  the common PUA ranges (~300 KB) if payload matters more than long-tail
  icon coverage; not done yet.

**Trap: the first available font in the stack defines the line box.** The
symbol fonts originally sat FIRST in the stack, on the theory that a font
earlier in the stack only wins for codepoints it actually has (true for glyph
selection). But the CSS strut — and xterm 6's cell measurement via canvas
`fontBoundingBoxAscent/Descent` — come from the FIRST available font
regardless of which font renders the text. `Noto Sans Symbols 2` carries a
1.7 em vertical box (ascent 1.07, descent 0.63 per em vs Menlo's 1.17 em
total), so once its woff2 decoded, every terminal cell inflated ~45%, text
sat high in the cell, and the full-cell block cursor protruded far below the
glyphs ("cursor not vertically centered, sticks out at the bottom"; line
spacing looked loose even at 1.00). The symbol fonts therefore sit AFTER the
text families (still before generic `monospace`): codepoints missing from the
text font — the agent markers ⏺, braille spinners, Nerd PUA icons — still
resolve to the bundled files via per-codepoint fallback; the only change is
that symbols a text font DOES contain (✳ ✻ ● ▲ on macOS Menlo) now render
from that font, metric-matched to the text. `@font-face` metric overrides
(`ascent-override`) were rejected as the fix: WKWebView (Tauri macOS) doesn't
support them. When a custom font is set it is prepended, so the strut follows
the user's text font either way.

The symbol fonts don't drive cell metrics; a one-shot `document.fonts.ready` →
texture-atlas clear + `term.refresh()` in Terminal.svelte repaints any
tofu drawn before they decoded. The old re-measure/refit dance is gone by
construction (the measuring font is present at `open()` time).

xterm weights are back to `normal`/`bold` (real 400/700 faces exist in
every system family).

## Personal preference: the custom font setting

Settings → Appearance (`fonts.svelte.ts`, localStorage `tmux_font`). All
three font roles stand together there — content, display, terminal family —
one "which fonts" cluster (owner, 2026-09-21, board #233: "终端的显示字体和其
他字体设置应该在一起，现在有点乱"). The terminal's size and line spacing followed
the family there on 2026-09-25 — the owner reads them as the terminal's look
("Terminal 的一些风格设置，都应该算到 Appearance 里面") — and the one-row
Terminal category was retired.

The editable control offers ONLY families the device resolves: the
suggestion pool (`COMMON_MONO`/`COMMON_SANS`) is probed through
`availableFamilies` — the same `FontFace`+`local()` registry check the
validator uses — when Settings mounts, so nothing offered can fail on pick
(owner, same board: "很多字体都用不了，用不了前端应该提前过滤一下"; before
this the pool was shown raw and most rows were decoration). Because the
offer is filtered per device, the pool may carry tasteful Han faces that
only some machines have — LXGW 霞鹜 (WenKai/WenKai GB/Neo XiHei, WenKai
Mono), Sarasa 更纱 (UI SC, Mono SC), MiSans, HarmonyOS Sans SC ("帮我能不能
加上 LXGW，或者你找一些有质感的字体") — install one on a device and its
picker offers it; bundling them stays traded away (see History above).
**The field names the default, and the default can be picked back** (board 312, owner 2026-10-08: "每个 project 标题的字体都很好看，但是我选择都改坏了"; then "你要在设置页面显示出来，不然我都没办法选，然后旁边有一个按钮 reset default"). The empty field used to say a grey "System default" while the chrome wore the bundled Space Grotesk, and no picker listed the bundled faces: a `local()` probe cannot see a webfont, so the #233 filter dropped them. Now: (1) each role's field shows the face it renders in when nothing is customized, in that face — `FontPref.defaultFace`, the bundled face the role's stack leads with (ui `Inter Variable`, display `Space Grotesk Variable`) — and picking that name back stores nothing. The terminal has no nameable default — its stack leads with the `ui-monospace` keyword, which is SF Mono on a Mac and which `local()` cannot resolve, so a probe would name Menlo while the terminal draws SF Mono — so its empty field shows "System monospace" worn in `var(--font-mono)` (`Select`'s `emptyFace`); (2) `Inter Variable` and `Space Grotesk Variable` (`BUNDLED_SANS`) lead the ui and display offers and validate without a probe; (3) each field carries the Slider's reset atom (undo icon `CommandButton`, "Reset <role>"), disabled at the default, which clears the override and applies at once. The stacks themselves are unchanged. Placeholders, shown only while a field is empty mid-edit, name the role's default too ("Default · Inter", "Default · Space Grotesk", "System monospace"). Test: `Preferences.mount.test.ts` "font fields show the real default and reset to it".

A family typed by hand still works and still validates. Before a new value
is applied, a temporary `FontFace` with
`local("<family>")` asks the platform font registry to resolve it. Canvas width
comparison remains only as a compatibility fallback: it falsely rejects an
installed monospace family such as Maple Mono NF CN when its advances equal the
generic fallback. Invalid input is shown inline and does not replace the active
or persisted preference. A valid family name is
prepended (quoted) to the stack and applied two ways:

- rewrites the `--font-mono` CSS var inline on `<html>` (all mono UI), and
- flows into `term.options.fontFamily` via the fontSize/`fonts.stack`
  $effect in Terminal.svelte, which re-measures and refits.

Semantics are deliberately **per-device**: the name resolves against fonts
installed on that device (e.g. the operator's Macs/pads with Maple Mono NF
CN installed). On a device without the font, CSS font matching falls
through to the system stack — a typo or missing font degrades safely, no
tofu, no layout break (the cell grid absorbs the metric change). This is
the "I want Maple on MY devices" requirement without shipping Maple to
everyone: install the font on the device (macOS: double-click; Android
can't install system fonts — an Android device that must have Maple would
need it re-bundled, which we explicitly traded away).

## Terminal size and line spacing

Settings → Appearance keeps terminal font size and line spacing alongside the
custom font name. Terminal font size remains the application-level `fontSize`
state and the stepper triggers xterm's deferred re-fit. Desktop Cmd/Ctrl `+`,
`-`, and `0` do not change this value; they control the independent native
WebView interface scale instead.

Line spacing is a per-device preference stored as `tmux_line_height` and
clamped to `0.40`–`1.60` (`LINE_HEIGHT_MIN`/`MAX` in
`terminal-prefs.svelte.ts`). xterm 6 normally rejects values below `1.00`, so
the Vite config applies a signature-guarded transform that changes only the
line-height lower bound (the tab-width bound remains unchanged); the patched
bound must stay in sync with `LINE_HEIGHT_MIN`, or sub-minimum values throw in
xterm's option setter and the slider silently does nothing below `1.00`.

**Trap: Vite dep pre-bundling bypasses plugin transforms.** In dev, optimized
deps are served from the checkout's `.vite/deps/` (`node_modules/.vite/deps/` before #464) as esbuild output that never
went through the plugin, so the patch only took effect in `npm run build` while
`npm run dev` / `npm run tauri:dev` kept the stock `lineHeight >= 1` check.
`@xterm/xterm` is therefore excluded via `optimizeDeps.exclude` (safe: the
addons only type-import the core). Excluded deps get a `?v=<hash>` query on
their module id in dev, so the transform strips the query before matching.

`terminal-prefs.svelte.ts` owns the reactive value;
every `Terminal.svelte` instance reads it when xterm is created and again in
the existing font-metrics effect. This makes the setting apply immediately to
single-pane, split, and embedded Team terminals without passing another prop
through each container.

xterm's DOM renderer normally assumes `lineHeight >= 1`: it shortens each row
for compact values but leaves the glyph top-aligned at the original font
height, so clipping is visually one-sided. The Vite transform adds a dedicated
`xterm-glyph` child inside each xterm cell (signature-guarded for xterm 6), and
`Terminal.svelte` centers that original-height glyph box over the compact cell.
The row's existing overflow clipping then removes exactly half of the excess
above and below. Cell backgrounds, block/bar/underline cursors, selection
overlays, decorations, and touch coordinates stay on the unmoved outer cell;
foreground color, weight, italics, letter spacing, and text decorations inherit
into the glyph child. The visible IME composition text uses the same inner
glyph layer, leaving its containing box and IME candidate-window anchor
unchanged. `npm test` runs the full frontend suite (including the
line-geometry test that verifies the split), while `npm run
build` verifies both xterm renderer signatures before shipping.

## Alternatives considered

- **Keep bundling, fix the weight bug** (bundle Regular/Bold cuts):
  fixes thin text but keeps 6.6 MB, the four-font patchwork, and the
  async-swap re-measure machinery. Rejected — the user's explicit goal
  was to stop bundling.
- **Serve the custom font from the tmux server** (`fs_download` the TTF at
  connect, register via `FontFace`): would give Maple on Android without
  bundling it in the APK. Deferred — adds a moving part (font file path
  config, 12 MB TTF over weak links, FontFace lifecycle across
  reconnects) for a single-device gap; revisit if the operator actually
  wants Maple on Android.
- **`local()` sources in @font-face**: `src: local('Maple Mono NF CN')`
  before the system stack would auto-use a locally-installed Maple with no
  setting. Rejected: invisible magic (font changes depending on what's
  installed, with no UI to see/override why), and fingerprinting-protection
  in some browsers ignores `local()` entirely.

## Consequences

- Payload: 6.6 MB → ~1.2 MB of fonts.
- Mono text looks *native per platform*, not identical across platforms.
  That's accepted: "correct and readable everywhere" won over "identical
  everywhere".
- The thin-text bug and the stuck-together-glyphs bug class are both gone
  by construction.
- `--font-mono` default in App.svelte and `SYSTEM_STACK` in
  fonts.svelte.ts must stay in sync (single-source refactor not worth the
  indirection for one literal; both sites carry a pointer comment).
