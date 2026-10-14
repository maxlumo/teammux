# The design language

One normative reference for every surface — layout, type, colour, controls,
menus, motion, touch. Written on owner request (2026-08-25: "你重新梳理我们ui
的设计语言…设定好一套规范 让以后的新功能也能完美和谐统一。注意当前我整体比
较满意，不要大变样") — so this codifies what the app already is, and new work
matches it instead of inventing. Deep rationale lives with each feature
(`tmm-cli.md` §Conversation visual language, `ui-unification.md`, `fonts.md`);
this file is the contract. `src/lib/ui/tokens.source.test.ts` and
`src/lib/ui/sidebar.source.test.ts` enforce the mechanizable parts.

**Configuration rollout (2026-09-10, owner-approved #154).** The concrete
control contract below ships in #155; Settings and Agent-family adoption
and draft workflows ship in #156, Files tools in #157. Approval does not
mean every legacy consumer has already migrated. Keep existing mechanisms
and replace their consumers explicitly; do not retune Terminal geometry
through the legacy `--ui-control-height` token.

**Compact revision (2026-09-10, #160/#161).** The owner selected the compact
comparison, not the large boxed appearance of #155. #161 replaces shared
control paint and pointer geometry; Settings, Agent editors and Files
composition follow separately in #162-#164. The functional contracts of
#155-#157 remain. The dated owner quotes and reason are in Rules below.
Settings adopts the compact composition in #162. Its three font roles and
brand/canvas defaults remain: the prototype's `font-display=font-ui` was a
comparison shortcut, not a decision to replace user font preferences.

**Chat strip revision (2026-09-11, #168).** The owner's request to place
working agents above the input and stop them individually is recorded verbatim
in [hub-composer.md](hub-composer.md#one-roster-above-the-input-one-stop-operation-board-168-2026-09-11).
One roster replaces the old delivery chip and delayed card menu. Selection
uses the existing accent fill/border with `aria-pressed`, not an additional
check glyph; body mentions use one `@` glyph, not a dashed card ring.
Attach/send use shared `CommandButton` paint and native 28px pointer /
44px coarse targets; the card's Stop is the `danger` icon command in a 28px
`compact-tools` slot standing ON the state dot while the card is hovered or
focused on a fine pointer, never on touch (#205, owner 2026-09-20: "终止按钮应该
是红色的吧，更符合语义，而且默认不显示"; #195's resident quiet `--text2` Stop and the
#173 amber `warn` variant are history, see hub-composer.md). Stop response is
recoverable interruption, not the destructive process-stop confirmation. Status remains `.live-dot` /
`stateDotColor`; no extra busy-colour family or permanent stop-spinner.
The owner's 07:09 final selection (quoted in hub-composer.md) is single-line,
without visible state words. One chevron reveals the same list in flow, with
1/2/4 columns at 360/720px roster-container thresholds and a maximum height of
`min(240px, 32dvh / --ui-zoom)`, scrolling internally. Native targets remain
28/44px; the original 20px avatars, 6px card gaps and 4px internal gaps
replaced the provisional two-line geometry. State stays available in hover/ARIA, turn-level activity order
places team groups by their highest-ranked member, and long names may wrap in
expanded cells.
An empty mention/unread slot reserves width only in the horizontal strip;
expanded grid cells already have stable widths and release that space to names.

**Team tab group (2026-09-23, #238).** A launched team with at least two live
members is one contiguous Chrome-style group in the roster; individual member
tabs and 28/44px targets stay native. The owner's Chrome group screenshot
supersedes the first thin upper marker: a native team-name button keeps the
existing 28/44px targets and, since 2026-09-24, no pill — the block read too
large beside the tabs, so the name is ink alone (`--text2`, `--text` when
hovered or chosen). A neutral
`--text2` 1px baseline occupies the bottom pixel of the GROUP only
(`calc(var(--roster-gap) / 2)`). A selected member uses `--text2` on the
existing raised tab edge; its bubble fill covers the baseline under that
tab and still opens into the composer band. No tray-wide line or extra row
height. Compact limits the label's visible width but preserves its full
accessible name; tapping it addresses only the current managed members and
lights one team enclosure, not each internal border. An individual card
narrows the recipient, All broadens it. The expanded list closes a selected
team's border rather than pretending to join the band. Under All the group
baseline and contour yield to the destinations' single enclosure; solo and
one-member teams have no group chrome. The screenshot's green is intentionally
not copied: group membership is not agent status. No nested frame, second
delivery path or new motion tempo. Reason, ordering and measurements:
[hub-composer.md](hub-composer.md#one-roster-above-the-input-one-stop-operation-board-168-2026-09-11).

**Outward tab feet (owner, 2026-09-23).** The first inward lower radii were
reversed (owner 10:39). Every lit enclosure — a tab, a team group, All —
keeps its `--ui-radius-row` top corners (17:19: the panel radius "半圆半径变
大了…稍微小一点显得更加精致"; 12px is the card tier and the 24px context ring's
own curvature) and opens into the band through
the SAME pair of outward feet (`--roster-foot-radius` 8px; a 4px arc read
as jagged). Since 2026-09-27 the whole silhouette — foot, side, top
corners, side, foot — is ONE vector path filled once and stroked once
(`.tab-shape`, `hub/tab-shape.ts`), Chrome's own construction: the side
turns into the floor tangentially on half-pixel centres, and no piece can
land beside another at a fractional scale. The feet take no pointer and reach into a neighbour's empty bottom
corner; tab gaps stay `--roster-gap`. The band's top edge is the strip's
floor line: a full-width `--bubble-line` pixel painted as the strip's
background, which each lit enclosure breaks and its feet turn into.
Expanded list cards keep their closed row radius and no feet; a row that
fits has nothing to expand, so it offers no chevron and keeps the strip's
tab whatever the remembered preference (#266,
[reason](hub-composer.md#expanding-exists-only-when-the-row-overflows-board-266-2026-09-28)). In the
collapsed row the tab chain stretches to the strip's height: a tab is
attached to the floor, so its box reaches it however tall the strip is.
The lit enclosure is ONE travelling marker (`.slide-pill.tab`, placed by
`slideIndicator`, motion principle 14): fill, edge, feet and join glide
from the old destination to the new one; no card lights in place in the
strip. The band under it has equal 6px/3px air above and below the field
and square lower corners against the sidebar and drawer. The All crowd
has a named 20px icon metric, not avatar size plus a spacing token, so
the group symbol stays legible when flex gaps change. No added row height
or paint over another target. Switching tabs crossfades paint colour
on `--t-move`, but the joining inset/corner geometry switches immediately;
the selected, collapsed, non-All tab has a 2px opaque floor in its own
`--bubble-in` fill, so the group baseline cannot flash through during the
colour fade. See [hub-composer.md](hub-composer.md) for the frame evidence.

**Compact tab floor (owner, 2026-09-23).** The 44px target is the floor.
Remove empty scrollport/disclosure space above the tabs, not the field's 3px
top inset. Compact button contents sit lower inside their unchanged hit box
so the open selected paint has less unused space below the text; the context
ring sits WITH its avatar inside the same positioned `.avatar-slot`, never
separately centred against the card. A shared 18px avatar and 24px ring
preserve the 1px image gap and 2px stroke. The compact selected tab's paint
starts at `--roster-gap` instead of the coarse control inset; Chrome-smooth
top corners took `--ui-radius-panel` until the owner's 17:19 correction
(now `--ui-radius-row`, like the group label pill). No second radius scale or altered hit box. The
three-head All glyph stays legible at its named 20px roster size, independent
of the gap between tabs; rendering it at the reduced avatar size blurred it.
The coarse strip was 44px high against the desktop's 34 until 2026-09-24,
when the owner asked the phone to match the desktop ("手机对齐一下桌面…tab 栏高
度比桌面预留的还要大…'发送给所有人'的按钮预留的都要宽"): the roster now sets the
desktop's 2px paint inset on coarse too, so the row is 36px and the All, +
and disclosure commands are 36px squares — a scoped exception to the 44px
touch floor like `.compact-tools`, and the content shove that lowered
compact button contents is gone with the gutter it compensated. The tab-to-band junction,
All enclosure and 44px native controls are unchanged. Measurements and the
superseded 1px field inset: [hub-composer.md](hub-composer.md).

**Strip density correction (2026-09-12, #176).** The owner's screenshot and
verbatim correction are in hub-composer.md. Card borders/backgrounds, not
their native hit boxes, use the shared 2px pointer / 6px coarse paint inset;
ordinary card paint is 24/32px and the strip is 32/48px. No global control
height, font or avatar size is reduced. The context meter is 3px, retaining
`ctxColor`. All moves after individual identities and uses neutral icon-only
resting chrome when collapsed; its selected state and expanded label remain.
The radius policy stays here in app.css, including the card paint's inherited
corner shape.

Actual horizontal overflow can use `.edge-fade` with `ui/scroll-edges.ts`.
Its 16px alpha edge is present only where content remains outside the
scrollport; it disappears at the corresponding end and is disabled for an
expanded grid or while a descendant is `:focus-visible`. This specific scroll cue never replaces width constraints,
intercepts input or shades fully visible final controls. Use native scroll,
not an extra pagination menu, overlay or independent animation.

## 1 · Tokens (app.css `:root` — never restate a value)

**Avatar capacity rings (#180, 2026-09-12).** The owner's 14:26 correction
and superseded choices are recorded verbatim in hub-composer.md. Card width
must not be the scale of a capacity reading: every circular 18px avatar now
has the same 24px outer meter, 1px image gap and 2px stroke. Pointer/coarse
card paint is 30/34px, with existing inset paint around unchanged 28/44px
native commands. Cards size to actual content; only busy Stop occupies an
action slot, Watch remains in ContextMenu, and expanded cards wrap rather
than stretch. There is no hover-time width change. Exact percentage remains
in hover/ARIA and expanded cards. The ONE `ctxColor` maps <50 / 50-69 / 70-84 /
>=85 to existing green/yellow/orange/red tokens without interpolating hues.
The earlier edge-bar and ground-fill designs are historical, not alternatives
to retain in production.

**Plain interruption commands (2026-09-11, #173; revised 2026-09-13, #195).**
The owner rejected the card's black Stop square and circular ground (#173:
"还有终止按钮，不要圆形的阴影了，还有这个黑方块看着不知道是停止的意思，是不是换个颜色？让我能更容易够理解这个按钮的含义。").
#173 answered with a `warn` variant of `CommandButton` — `--status-warn` mixed
80/20 with `--text` (raw amber failed the 3:1 glyph floor on a selected light
card; Chromium 152 measured 3.42:1 light / 10.26:1 dark), no ground at rest,
hover or press. Two days later the owner found that ink ugly and the slot too
big (#195: "尤其是停止按钮，又大颜色也不好看"), so the `warn` variant is GONE whole
(type, class, rules, tests): Stop is the ordinary `icon` variant — `--text2`
ink, the normal icon hover/press wash — in a `compact-tools` slot (28px
pointer / 32px touch). The 3:1 guard stays and now checks `--text2` against
every card/theme combination. Keyboard focus ring, controlled ARIA and the
pending/disabled contract are unchanged. The card's colour is its state dot;
Stop is a quiet action beside it. Interruption is recoverable; kill/remove keep
danger semantics.

- **Type scale, six chrome steps**: `--fs-micro 9 · --fs-meta 10.5 · --fs-sub
  11.5 · --fs-ui 12.5 · --fs-body 13.5 · --fs-title 15`. Connect card only:
  `--fs-hero/--fs-display`. `--ui-font-control: var(--fs-sub)` remains the
  legacy alias; configuration values use `--fs-body`, command labels use
  `--fs-ui`, and help uses `--fs-sub`. A raw px font-size anywhere is a regression (guarded).
  `--fs-input-touch: 16px` is a BEHAVIOUR (iOS focus auto-zoom), not a step,
  and is gated `@supports (-webkit-touch-callout: none)`.
- **Three font roles** (`fonts.md`, all three user-overridable per device):
  `--font-ui` (Inter Variable) = content: prose, inputs, documents.
  `--font-display` (Space Grotesk Variable) = identity: page titles, `.side-h`
  headers, names, the brand, and every `button` that is chrome.
  `--font-mono` = data: terminal, code, paths, ids, readings, window chips.
  Every mono surface wears `var(--font-mono)` — no private `ui-monospace`
  stack — and no rule anywhere sets a raw `font-feature-settings`: a
  `cvNN`/`ssNN` tag means something different in every fallback font, and
  Inter's l/I alternates on `body` made PingFang SC draw Traditional
  punctuation and glyphs in every bubble for two weeks (#97; fonts.md "The
  feature that was the bug"). Font-specific features live in
  `@font-feature-values` for one family; generic needs use `font-variant-*`.
  A data-carrying button (file row, dropdown value) opts back out of the
  button rule with an explicit font-family.
- **Radius scale**: `--ui-radius-control 10` (buttons, inputs, selects) ·
  `--ui-radius-row 12` (cards, rows) · `--ui-radius-panel 14` (menus, panels)
  · specials: bubbles 18/6, composer 16/15, dialogs 18 · true pills
  (`--ui-radius-pill`) only for micro tags, the switch track and historical
  non-configuration chips. **Every button is a rounded rectangle** (board
  #218, owner 2026-09-20: "这个图标按钮应该都用圆角矩形，不要用圆圈…除了 agent 自己的原型
  logo，发送按钮以外，都要圆角矩形的按钮设计，还有像 file 里什么的…弹出窗口确认的按键等等"):
  a command's PAINT — the inset layer inside its hit box — takes
  `--control-paint-radius 7`, icon squares, text commands and the segmented
  track alike (on a 24px paint square `--ui-radius-control 10` or
  `--control-radius 12` IS a circle, which is what the owner stopped); a
  dense `.compact-tools` group paints 20px squares and scales the corner to
  5px with them (#219 — 7 on 20 read as circles in the Files toolbar). The
  circle/capsule exceptions, by reason: agent avatars, the composer's Send
  (`CommandButton round`, its only wearer), the switch knob/track, tags and
  chips (day pills, count badges, `.pick`/AgentChip membership), input
  capsules (the sessions search), dots, spinners, progress bars. The list is
  the allowlist of `tokens.source.test.ts` — a new circle or capsule on a
  button fails it. Field/menu/dialog radii stay `--control-radius 12`,
  `--control-menu-radius 16`, `--control-dialog-radius 22`.
  These replace the migrated controls' 10/14/18px treatment, not the legacy
  terminal, bubble or card geometry. Configuration boolean/multiple choices
  still use Switch/CheckboxGroup, never `.pick` membership pills.
- **Colour**: theme tokens only — `--bg*`, `--surface*`, `--text*`, `--border*`,
  `--accent*` (`--accent-fill`/`--accent-fill-ink` for solid CTAs, `--accent-ink`
  for readable selected text, `--accent-line` for selection borders,
  `--accent-bg` for washes), `--danger/-bg`. ONE progressive
  status language everywhere a state shows: accent = in motion, `--status-ok`
  = ended well, `--status-warn` = needs a person / a turn cut short,
  `--status-danger` = failed/destructive, grey = at rest. A literal colour is
  wrong; compute expressions with `color-mix` over tokens (`ctxColor`).
- **Agent name inks are identity, the one exception to "one hue"** (board #292,
  owner 2026-10-01: "名字多个颜色更好看，可以的"). Six theme-aware tokens
  `--agent-1..6` in each theme block, chosen by ONE pure function,
  `agentHue(name)` in hub.ts (FNV-1a hash of the name mod 6, so the same name
  wears the same ink everywhere, with no table to maintain; the human and
  `@all` keep `--accent`). It is applied through one variable, `--who-ink`,
  in four places: the feed's name header, the sysline's who, a live roster
  card's name, and an `@mention` (`.m-to`, still mixed 62% toward `--text`).
  Nowhere else, and never on a state: dots, badges and rings keep the
  status language. A component that names `--agent-3` by hand fails
  `tokens.source.test.ts`. Contrast is WCAG, measured on the real surfaces (feed
  canvas, incoming and outgoing bubble, roster tab frame, `--surface2` hover):

  | token | dark | min ratio | light | min ratio |
  |---|---|---|---|---|
  | `--agent-1` | #22d3ee | 8.3 | #0e6a82 | 4.70 |
  | `--agent-2` | #a78bfa | 5.5 | #6d28d9 | 5.41 |
  | `--agent-3` | #4ade80 | 8.7 | #166c34 | 4.95 |
  | `--agent-4` | #fbbf24 | 9.0 | #9a4a08 | 4.76 |
  | `--agent-5` | #f472b6 | 5.7 | #be185d | 4.59 |
  | `--agent-6` | #60a5fa | 5.9 | #1d4ed8 | 5.10 |

  A board card's assignee is the agent's BACKEND icon in the `.ava` atom
  (board #327 replaced #293's lettered tile in this ink: an avatar is the
  agent's own face, never an invented letter); its running dot is the status
  language's `.live-dot`, drawn only in the doing column.
  `--backend-*` stays the avatar fill and is NOT text ink: grok's #e2e8f0
  vanishes on the light canvas and codex's #94a3b8 reads as meta grey.
- **The at-rest grey is ACHROMATIC, and "in motion" is not colour alone**: the
  two states you most need to tell apart are running and idle, and at 5–7px a
  dot's hue is not enough — the owner reported them as indistinguishable twice
  (2026-08-26, again 2026-08-29). Two rules answer it. `--status-sleep` carries
  no hue: a blue-leaning grey next to the blue-cyan accent is the SAME family at
  lower chroma (in light theme the two sat 3° apart), so its channels stay
  equal-ish. And an in-motion dot wears the app-wide `.live-dot` cue (app.css) —
  full-strength fill, a `color-mix` halo over the dot's own `--live-hue`, and the
  `dot-breathe` scale loop. The halo is the load-bearing half: it gives a live
  dot ~3× the visual mass of a resting one, which survives greyscale, a 5px dot
  and `prefers-reduced-motion` (that only stills the loop). A state dot may
  NEVER animate opacity — the retired `s-pulse` faded running toward the card
  and its trough measured 22 L* points DARKER than the idle grey, so half of
  every cycle the running dot read as the less alive of the two. ONE mechanism,
  one class; `stateIsLive()` is the single definition of which states wear it,
  and `ui/statusdot.source.test.ts` pins all of this.
- **Motion**: `--t-fast 120ms` = micro feedback (hover, border, colour);
  `--t-move 200ms` = things that move or resize (drawer, bars, width).
  Spinner tempos are semantic, not tokens: 0.6s = loading,
  breathe ≈ 1.3–5s (presence). The former 2.2s send-button turn spinner was
  removed with the send/interrupt dual mode in #168. Every looping animation
  stills under `prefers-reduced-motion`. **Micro-motion** (owner, 2026-09-03:
  a state change is a movement, not a swap): a glyph that reads two ways
  TURNS (`.chev`/`.flip`/`.quarter-turn`), a chosen navigation tab's icon
  settles into its own pose and back (`.tab-glyph`, #240), things that enter fade or rise in (`.appear*`),
  a control's selected clothes cross-fade (`.state-ctl`), a keyed list
  reorders with `animate:flip` on `moveMs()`; exits are cuts, layout is never
  animated, `svelte/transition` is not used. The full principles, vocabulary
  and the 2026-09-03 plan: [motion.md](motion.md); `ui/motion.source.test.ts`
  pins it.
- **Navigation motion grammar** (owner, 2026-08-25: "对于交互动效也应该有
  规范，大家都共同遵守"): ONE slide language, 120ms linear translateX(40%),
  for every navigation — no fades, no scales, no second tempo. Direction is
  meaning: going DEEPER (opening Settings, a drill-down category, an editor)
  enters from the RIGHT; going BACK (back gesture, back button, closing
  Settings) enters from the LEFT; lateral tab switches slide in the
  direction of travel. Page-level slides are TOUCH-ONLY (`slidePage` in App
  — desktop tabs are a rail with no motion behind them, owner rule);
  compact drill-downs animate under 760px via the shared `drill-in-right`/
  `drill-in-left` keyframe pair (Settings, Agents). SHEETS (sidebar
  slide-overs, phone dialogs) instead slide on `--t-move` with a scrim: a
  side sheet transitions its transform, a phone DIALOG sheet (ConfirmDialog)
  rises through the shared `sheet-up` keyframe (app.css) while `.dlg-backdrop`
  fades in — and the DESKTOP dialog only fades (`fade-in` on `--t-fast`),
  because it is centred BY a transform that no keyframe may fight. A
  sheet's directional shadow belongs to its OPEN state only: a parked
  `translateX(-100%)` layer is still painted, so a persistent blur leaks back
  onto the page's left edge. POPOVERS (menus, selects, pickers, the hover
  card) are placed and measured invisible, THEN grow from their anchor corner
  on `--t-fast` (`.pop-layer`, owner 2026-09-04 #86; before that they did not
  animate at all). A transform hint (`will-change`) may exist only
  WHILE a slide runs:
  a resting transform turns the page into a containing block and breaks
  every fixed popover. A SHEET is the one sanctioned standing hint, and it is
  `will-change: opacity`, never transform: the Android System WebView drops a
  sheet's compositor layer at transitionend (open = `transform: none`) and
  blinks a blank frame while it re-rasterizes (board #21 — Android Chrome
  hides the seam, the APK does not), so the sheet keeps a standing layer
  (the side sheets and ConfirmDialog's `.dlg.sheet` all wear it); but
  the hint must stay OUTSIDE the containing-block family
  (transform/perspective/filter), because a sheet's TREE contains fixed
  overlays (Sessions' dialogs) that must keep the viewport. Opacity promotes
  without re-anchoring anything — it adds only a stacking context, which
  `position: fixed` + z-index already gave the sheet.
- **Interactive edge-swipe** (Files is the reference): the drag IS the
  animation — content follows the finger with damping (×0.4, capped ~96px,
  inline transform, no transition), an intent lock keeps diagonal scrolls
  vertical (|dx| > 1.2·|dy| after 8px), release under the 60px commit
  threshold springs back on `--t-fast`, and a commit plays the shared
  drill-back slide. The transform exists only while the finger does.
- **History discipline for drill layers**: a navigation that OPENS a layer
  (entering Settings, a compact drill-down) pushes its history entry AT OPEN
  TIME, and the pop that peels it SPENDS that entry (no re-push). Reason:
  the browser's predictive-back preview slides in a SCREENSHOT of the entry
  being returned to, captured when it was last current — entries pushed only
  at tab switches made backing out of a Settings level flash an unrelated
  page for a beat (owner, 2026-08-25: "疑似闪一下其他页面"). Pushed at open,
  every preview shows the true destination. Two fallbacks keep the stack
  honest: an open that pushed nothing (reload landed there; drill opened
  outside compact) closes DIRECTLY instead of calling history.back() into
  the stack-bottom re-push guard. Layers that only PEEL state without a
  matching open-time push (Hub menus, dialogs) keep the consume-and-re-push
  model.

## 2 · Layout skeletons

- A page = optional LEFT SIDEBAR (`var(--sidebar-w)` grid column, `--bg2`,
  1px `--border` right) + main column headed by `.page-head` (h1 in
  `--font-display` at `--fs-title`; actions as `.icon-btn`, right-aligned).
- The ONE compact breakpoint is **760px**. Under it a page picks ONE of two
  patterns, never a third: the sidebar becomes a slide-over SHEET
  (Chat, Terminal — scrim + `--t-move` slide), or the page DRILLS DOWN
  (Agents, Settings — the list is the first screen, the opened thing takes
  the whole screen, a chevron-left `.icon-btn` and the back gesture return).
- Every page registers `onGoBack` (Files' contract) and peels its layers in
  tap-outside order; a consumed pop re-pushes. A page never installs its own
  popstate listener.
- Sidebar internals are the SHARED atoms in app.css (`.side-h`, `.side-row`,
  `.side-age`, `.side-win*`): components may position them, never restyle
  them (guarded).
- `.page` must never become a containing block (no resting transform/
  will-change/filter): every fixed popover assumes the VIEWPORT. Any fixed
  sheet pads with `var(--sat)/var(--sab)`, never raw `env()` (0 in the APK).
  Overlay vh/vw sizes divide by `--ui-zoom`.

## 3 · Control dialects (reuse, never invent)

**Chat signature controls (#186, 2026-09-12).** The owner's 15:39 words and
the #168/#180 layout reversal are recorded in hub-composer.md. Text uses the
full textarea width; All/Attach/Send share its last line when their measured
rectangle is clear, otherwise one control-height bottom band is reserved.
A clipped native-text mirror uses the actual computed font and line boxes;
there is no character-count estimate, permanent right column or new token.
Scroll-capped text retains full width and a bottom action band. All remains
the circular shared pressed command with its guarded ContextMenu, not a
second solid CTA; all managed cards now expose the aggregate selection.
Native 28/44px targets, the one popup/focus owner and #180 measurement guards
remain unchanged.

### Configuration controls (#155, revised by #161, 2026-09-10)

The audit found 24px Settings commands, 28x26px editor commands, 29px fields,
38px member commands and 26px pill choices. Shared CSS names alone did not
establish common states or touch reach. The replacement is one component
per job, using the following shared CSS tokens; the legacy 24px token is
unchanged until its consumers migrate.

| Metric | Pointer | Touch input |
|---|---:|---:|
| `--control-height`, native hit height | 28px | 44px |
| Icon command hit box | 28x28px | 44x44px |
| Command/segmented painted height | 24px | 32px |
| Native single-line field painted height | 24px | 28px |
| `--control-paint-inset` (each vertical side) | 2px | 6px |
| `--control-field-inset` (each vertical side) | 2px | 8px |
| `--control-icon-size` | 16px | 17px |
| `compact-tools` paint height (#164) / pitch (#192, #193, #309) | 20px inside 28px target | 26px inside 30px target |
| `--config-header-height` (minimum) | 48px | 56px |
| `--config-nav-height` (minimum row) | 40px | 44px |
| `config-compact` header / navigation minimum (#162) | 44 / 36px | 56 / 44px |
| `--config-padding` | 24px | 16px on compact |
| Menu/option row minimum (#165) | 28px | 44px |
| Label / field / section gaps | 8 / 16 / 24px | same |
| `config-compact` label / field / section gaps (#162) | 6 / 12 / 20px | same |
| `config-entity` short-row minimum / vertical inset (#163) | 44 / 2px | same; 44px control makes a 49px row |
| `config-entity` writing-surface minimum (#163) | 128px | 140px |

Input capability, not a narrow viewport alone, selects touch sizes.

**Dense tool groups on the phone sit on a 30px pitch** (boards #192/#193/#309,
owner 2026-09-13: "文件浏览器的尤其是手机上的按钮可以紧凑一些，现在按钮太大了，在手机上
体验不好空间利用不够", then "最上边一行能显示全，不要...折叠了"). This is the ONE
deliberate exception to the 44px icon hit box, scoped to `.compact-tools`
under `(any-pointer: coarse)`: the 17px icon is unchanged, the paint is 26px
inside the 30px pitch. Measured on Files: nine toolbar commands needed a
More menu at 44 (412px at 390); #192's 36px let nine fit at 390 but the APK
has TEN (Git, Downloads) — 390px, still 8 + More on a 360–384px phone; at 32
the ten took 338px and fit at 360 (348 available), but the owner's phone is a
347px viewport (2026-10-04, #309: 335 available, 3px short, so "…" appeared
where it looked as if everything fit); at 30 the ten take 318px and fit from
a 330px viewport. A 1px-margin fix (the toolbar inset 6→4) was rejected: the
next tool would fold again. Three inline row tools
136 → 96px; toolbar 48 → 36, path row 52 → 40, the list starts at 76 instead
of 100. The file row itself keeps its 44px `--files-row-height`.
`controls.source.test.ts` pins the metric and which Files groups carry the
class. **The Chat head and the composer's two controls wear it on the phone
too** (board #228, owner 2026-09-21: "chat在手机上的按钮间的间距小一些，更紧凑一些，
右上角的按钮 发送区的按钮，还有chat的标题要能够放下更宽的标题 下箭头右边不用留这么大间距"):
`Hub`'s `.chat-head` takes `class:compact-tools={compact}` — menu, name caret
and the three partition toggles all on the 32px pitch, the toggles grouped
in `.head-tools` at the tool gap — and `Composer`'s `.composer-actions`
likewise. Measured on a 390px phone (coarse tokens): the three toggles
280/314/348 instead of 240/288/336 (100px, was 140), the caret's box
32 wide so its glyph sits 7px off the name's end instead of 13, attach+send
66px instead of 90 (the field keeps the difference), and a long name gets
193px before it ellipsizes (was ~178). The `.title-group`'s 60% cap is for
the PATH beside it, which the phone does not render, so
`.hub-root.compact .title-group { max-width: none }` lets the name run up to
the tool group.
Single-line controls are border-box sized with an 18px line box. Layout,
hover, pending icons and disabled states cannot resize them. Command
labels use display/ui-step 500; values/options use the content face;
code/numeric readouts use mono. Configuration letter spacing is zero.
Commands paint through an inert inset pseudo-element inside the native
button: a rounded rectangle on `--control-paint-radius` for icon squares and
text commands alike (#218 — they were circles and capsules until the owner
asked for rounded rectangles everywhere but Send and the avatars). A
command's INK is `--text2` at rest and `--text` on hover — the `.icon-btn` /
rail grammar (board #220, owner 2026-09-20: "这些按钮上显示的线条太黑了，甚至有点喧宾
夺主…tab 上的文字，其实都没有那么黑"; rest had been `--text`, so every 2px stroke
outweighed the words beside it): tab `--text3` < command `--text2` < body
`--text`. Solid keeps its fill ink, danger its red, engaged its accent, in
every state. Hit rectangles remain in flow, nonoverlapping, and active even
outside the paint.
Native fields use transparent vertical borders and `background-clip:
padding-box`, retaining the same input/button as the click, focus and menu
anchor. The outer vertical radius includes the inset, so the painted inner
radius remains 12px rather than becoming square as the border grows.
Select-only values use text and a chevron without a filled field box;
editable values retain the quiet field surface. Textareas stay full writing
surfaces, not inset single-line targets.

Migrated controls use round arcs in the one global corner policy. The legacy
continuous-corner list is a zero-specificity default, so its most complex
selector cannot override a round variant. Checkbox marks retain their 16px
size and 4px corners, inside full labelled targets; switches retain their
existing thumb/track. No blanket pill conversion of cards, rows or fields.

| Component | Contract |
|---|---|
| `CommandButton` | Required accessible label; primary, secondary, icon or danger variant. Icon-only commands use the shared hover card, not another native title. Pending requires a reserved icon slot, blocks activation and retains its label, box and contrast. |
| `Switch` | A boolean, with native button activation, switch role and checked state; controlled by its caller. Thumb position communicates state without relying on colour. |
| `CheckboxGroup` | Labelled native checkbox inputs for independent membership choices. Changing one choice preserves unlisted values. Provisional native state resets to the caller value until that caller commits the intent. |
| `Stepper` | Named minus/plus commands, mono value, clamped limits and disabled end stops. |
| `Slider` | Native range keyboard/input semantics, visible value and a named reset command. Provisional native values reset until the caller commits. Set min/max/step before value: Chromium otherwise rounds a fractional initial value against its default integer step. |
| `Select` | One fixed measured popover, native 28/44px trigger with 24/28px field paint; unique combobox/list relationships, active-descendant cursor and focus return. IME keys do not select/commit; disabling closes its menu and blocks queued choices. Uses its full border-box height, 6px trigger gap and 8px viewport inset. `dense` only retains the legacy text-size role, never another height. |
| `Segmented` | One quiet neutral track, equal option targets and one travelling selection surface (`.slide-pill.control`), all on `--control-paint-radius` (a rounded rectangle since #218, not a capsule); selected text also has weight 600. No independently framed option buttons or unused tail inside the group. |
| `Dialog` | The ONE modal shell (#317): scrim, card, phone sheet, `aria-modal` with the caller's role and label, IME-safe Escape, Tab wrapping over the dialog's fields and buttons, focus in on open and back to the opener on close, and the one motion. Escape is CONSUMABLE — the caller's `escapeGuard` peels its innermost open step first and the dialog closes only when nothing consumed it; the scrim is not routed through it. Only the top modal answers keys; a busy dialog neither cancels nor resubmits. Callers pass WORDS and actions as children — there is no `class` prop, and the confirmation's circular corners are keyed off `[role="alertdialog"]`. Back stays with the host's layer chain. |
| `ConfirmDialog` | Same confirmation mechanism, shared command buttons; caller supplies the verb, icon and failure text. Danger is severity, not a trash-icon classifier. Starts on Cancel, traps Tab inside, restores connected trigger focus, and does not cancel or resubmit while busy. Only the active modal handles keys. |

### Confirmation outcomes (#167, 2026-09-12)

Owner, 2026-09-11 03:00:
> 还有全局的一些消息通知规范，比如删除停止的提示。删除这类高危按钮的样式都统一。保证我们交互统一，注意我们的规范。

Interrupting a response remains immediate, plain amber and unconfirmed.
Stopping/closing a process is a red confirmed action with a stop/x glyph;
deleting/removing keeps trash. The caller names the captured object and what
is lost or retained. A local-copy deletion must not claim the server original
is deleted. Discard is neutral, with Keep editing and Discard.

The existing `ConfirmDialog` owns presentation and keyboard focus, never
the RPC. `confirmIcon` is independent of `danger`; a caller's `error` appears
inside the dialog as an alert and its accessible description, in the shared
error text role. Names and errors wrap within the existing scroll-capped
dialog/sheet. While busy, focus parks on the dialog itself: Chromium 152
otherwise dropped the disabled command's focus to BODY in 15 measured async
scenarios. The initial return target and listener lifetime are retained;
busy transitions do not re-register the modal or replace its return target.
Error text does not expire or animate in. A rejection remains
retryable on the captured object; successful mutation closes the matching
view, while a later read failure retries the read, not the mutation.

The shared component's mounted regressions were red before the independent
icon/error slots. Consumer execution and Back ownership are migrated in
separate #167 commits; this component change alone does not prove those paths.

### Local operation feedback (#167 batch 2, 2026-09-12)

`ui/OperationFeedback` is the one presentation for local success, error,
progress and actionable results. Files and Terminal both adopt it; their
private toast paint and flash animation are removed. It reuses `menu-surface`,
the shared error text role and CommandButton. Callers own position and actions;
the component owns no transport, timer, queue or notification policy.
The message flexes from its intrinsic width beside actions; a percentage-based
minimum made short copy errors wrap Close onto a second row in shrink-to-fit
popovers. Long text wraps inside the message column instead.

`feedback-lifetime.ts` owns `COMPLETION_FEEDBACK_MS = 1500` and the completion
scheduler. A local instance captures an attempt before awaiting and accepts
only that attempt's outcome. A queued expiry also checks the displayed
instance, so identical text does not make an old expiry current. Context exit
and disposal invalidate callbacks and cancel their timer.

Only an ordinary success/Copied notice expires. Errors and progress persist.
A result offering Open/Close is an actionable prompt, not a notice: it persists
until acted on or its operation context is replaced/exited. This qualifier was
approved on 2026-09-12 at 18:08; shortening the old download result to 1.5 seconds
would hide an action before it could be used. Unrelated jobs have separate local
slots, so copying cannot erase a download prompt or a connection error.
Plain success/progress does not gain a redundant Close button.
The progress glyph is `refresh`, turning only while the percent is unknown; a value with `glyph: 'download'` (Files' download path, board #307) wears `downloading` instead: a dashed ring that turns for the whole progress phase, known percent or not, around a still arrow into a tray (only `.dl-ring` animates, about its own centre; reduced motion holds it still).

A percentage reports measured transfer bytes only. Unknown Content-Length and
the write phase are indeterminate, not a synthetic ramp. A browser download
request does not claim that a file has been saved; a confirmed native write can.
Copy reports success only after `core/clipboard` returns true, retaining its
insecure-context fallback. Git errors do not expire as short success notices.

Feed and Board share the existing message-action generation model, lifted
mechanically before adoption, and use the common completion scheduler.
Message identity, never body equality, owns the checkmark and expiry.
Copy errors use the same OperationFeedback, anchored to the live Copy trigger
by `feedback-position` through `menuPlacement`/`menuHeightLimit`. The box wears
`.pop-layer`, is measured before showing, and is bounded by the message/notes
scrollport so it flips above inputs. Local resize/scroll tracking is disposed
with the box; the existing caller still owns dismissal. This replaces fixed
corner placement that Chromium measured over short-tail Copy/Raw and Board
input controls. It adds no flow row, reading-layout change or global listener.
Content bounds and the actual scroller are distinct: Board's `.notes` is
clipped and tracked through its `.detail` ancestor. The vertical anchor can
include an adjacent timestamp/tool row while retaining the Copy trigger's
horizontal origin. Unmeasured or off-scrollport boxes are inert as well as
not ready; opacity alone had left an invisible Close in the Tab sequence.

**Controlled icon tools (#157, 2026-09-10):** `CommandButton` accepts optional
`pressed`, `expanded` and `controls`, reflected as native `aria-pressed`,
`aria-expanded` and `aria-controls`. Explicit false remains `"false"`; absent
props omit the attributes. For `variant="icon"`, a pressed or expanded tool
keeps the shared neutral control surface and readable accent ink through
hover/press (#161 visual revision).
The caller owns mode/disclosure state and the controlled element's ID; clicks
only emit intent, and disabled/pending tools cannot activate. Ordinary command
styling is unchanged. Boolean preferences still use `Switch`, not tool buttons.

Modal ownership comes from the visible modal DOM through `activeModal`, not
listener registration order or copied open flags. The Hub drawer's earlier
Escape listener and desktop shell shortcuts yield before acting; stopping
propagation in a later dialog listener cannot undo an earlier action. Hidden
retained pages do not own keys; a modal still entering at opacity zero does.
This does not install a new global Back/history handler.

No control owns persistence or a second copy of committed application state.
Callers set pending synchronously before an asynchronous operation and enforce
its request/identity guard; the entity-level rules are below.
Do not use an always-enabled Save as the primary-colour demonstration.

Primary is solid fill; secondary has a quiet neutral surface without an outline;
icon commands are borderless; danger is quiet red until a destructive
confirmation uses solid red. Selected is a wash/marker, never a primary CTA.
Enabled uses readable ink; unavailable uses native disabled semantics at
0.4 opacity. Pending blocks input but retains normal contrast. The shared
disabled-opacity token can keep submitted form values readable while locked.
Focus-visible is a 2px readable accent-ink ring with 2px offset. Commands
outline their painted surface; native fields outline their full target.
Hover/press change paint only:
solid controls use 4% white / 6% black overlays, never press scaling.
Status and action are distinct roles.

| Role token | Light | Dark |
|---|---|---|
| `--accent-fill` / `--accent-fill-ink` | `#0074ad` / white | `#056f87` / white |
| `--accent-ink` | `#006699` | `#00d4ff` |
| `--text2` | `#5f636b` | `#a7abb3` |
| `--text3` | `#a8a8b1` | `#6b6e74` |
| `--control-border` | `#7a808a` | `#727884` |
| `--control-surface` | `#ededf2` | `#2a2a30` |
| `--control-hover` | `#e4e5eb` | `#393940` |
| `--control-selected` | white | `#494950` |
| `--control-field-bg` | `#f0f0f5` | `#28282e` |
| `--danger-fill` | `#c33535` | `#c33535` |
| `--danger-ink` | `#c33535` | `#ff5050` |

Brand accents and canvas colours remain unchanged in #161. Control boundaries differ
from decorative dividers: normal text pairs need 4.5:1 and essential boundary
marks 3:1. The fill/white-ink pairs remain above 4.5:1 even on hover.
Do not put necessary labels in the faint decorative `--text3` role.
Every ink token is OPAQUE (board #321, owner 2026-10-09: "左侧大侧边栏的灰色 icon
图标…拐折处的那一点比较亮"). `--text3` was `rgba(226,232,240,0.45)` /
`rgba(26,26,46,0.35)`; an icon's separate strokes each composite that alpha, so
where two meet (the files fold on its outline, the board divider's caps, a plus's
crossing) the overlap read 0.69 / 0.58 instead of 0.45 / 0.35 — measured on 36
of the 76 Icon.svelte glyphs, so the cause is the ink, not a few paths. The
opaque value is the old ink composited on `--bg`, so the two are identical on
`--bg` only; on any other ground (a `--surface` lift, an accent tint) the opaque
grey no longer takes on the ground's colour. A translucent ink token is a regression; tint with
`color-mix` or a surface, not an alpha ink.

The shared `config-*` atoms establish an 860px left-aligned canvas, aligned
header/body leading edges, field roles and 8/16/24px rhythm for #156 consumers.
`config-compact` explicitly opts a surface into the tighter rhythm above,
12px form leading inset and weight-500 field labels. The type roles and
user-overridable font stacks are unchanged. Other surfaces adopt it through
their own reviewed migration; it is not a global legacy-token change.

Preference rows use one shared owner: above 760px a grid with a minimum-110px
flexible label and a maximum-260px value, with 16px between. Compact rows use
a 108px label basis and the remaining width for the value, separated by 12px.
The value's intrinsic `max-content` width decides whether it fits beside the
label; unusually wide content wraps to the next line, without the former
arbitrary 240px floor. Segmented uses equal native grid columns, so its
intrinsic width budgets for the longest option in every equal track, not
the sum of unequal label widths.
The row minimum is 48px with 5px vertical insets; a 44px touch control
naturally makes it 55px including the divider. Labels and error/status text
wrap rather than clipping; the control column has no inherited 240px floor.
Font values use quiet unfilled Selects and standalone switches align right.
The last row drops its separator.
Entity forms opt into `config-entity` alongside `config-compact` (#163).
Short input/Select labels share a 110px-minimum flexible label and a value
capped at 360px, with the same 16px gap. Their multi-field groups become
one column; groups of checkbox choices keep their existing layout. Under
760px, short rows use the same 108px label basis and 12px gap as preferences.
Choice buttons wrap when their intrinsic label needs it. Native inputs and
editable Selects use the remaining width, not the input's default 20-character
intrinsic size; their existing horizontal editing behavior handles long text.
Textarea labels remain
above their writing surface, never inheriting a horizontal label basis.
The 128/140px editor minimum does not replace native rows, auto-growth,
vertical resizing or the existing maximum-height/scroll rules.
Neither the grid nor the compact tokens create a containment ancestor for
fixed Select popovers.
Terminal cells, cursor metrics and gesture coordinates are outside this scope.

### Configuration forms and persistence (#156, 2026-09-10)

Settings and Agent/Team/Skill/MCP/global-instruction editors use the shared
canvas and controls above. Page sections are unframed; a team member is a
repeated object, so its single frame remains. Remove the replaced 720px
centered Settings cards, 980px Team editor and private field/command sizing.
Category and object lists wear `config-navigation`, including the initial
list before an editor is open. Their touch floor is a real row rectangle,
not overlapping hit-area overlays.
Header titles wrap at a 160px flexible basis and may grow the header; commands
remain one right-aligned group. Never shrink type or elide the object name to
preserve decoration. In a collapsed editor, one left Back replaces right
Cancel; both use the same draft guard.
Member sources and team-member summaries are readable metadata (`--fs-sub`,
`--text2`), not micro decoration. Redundant file labels do not take width from
the category name; the global document is already named in its own object row.
Font-preview Selects change family, not size: they use the same body step as
other configuration values, without the legacy `dense` option.
Skill descriptions keep that body step in both reading and editing states.
The click-to-edit reading target respects the shared minimum height; built-in
descriptions are plain read-only text, without a misleading edit action.
Entity failures use the same `config-error` text role and alert semantics as
Settings; a page-local error frame does not introduce another state style.

The Agent page retains categories, rows and editor as logical levels. A root
ResizeObserver reads the actual container and requested sidebar/row widths;
`--config-editor-width: 480px` is the editor budget. If three columns cannot
fit, rows and editor alternate beside categories. If two cannot fit, levels
drill in one column. Saved divider preferences are not overwritten by this
adaptation. This is not a CSS containment ancestor for fixed Select menus.
The list stays mounted, preserving its scroll position on an editor return.

Only two persistence models exist:

- **Immediate preference:** independently valid, reversible local settings
  apply immediately. They do not get Save/Cancel. Commands and asynchronous
  validation show their own pending/error state.
- **Draft entity:** Agent, Team, Skill, MCP and global instructions use an
  original fingerprint and a working copy. Save requires a valid new/dirty
  value and no pending operation. The same payload definition measures dirty
  state and builds the write; team disclosure is not data, while unknown
  references and inline MCP objects remain data. Built-in skills and existing
  identifiers are read-only, not dimmed to imitate disabled fields.

Agent-family Save and Ctrl/Cmd+Enter enter one handler; IME key events do not
submit. Capture payload and editor generation before awaiting. Lock the
submitted fields without dimming their values, block duplicate activation,
retain text on failure and return to the originating list/category on success.
An unnamed skill import returns to its list too, rather than opening the first
imported definition as a different editing task.

Cancel, Escape, in-pane Back, object/category picks, external editor requests and the
Settings host's category exit use one guard. Dirty exits use ConfirmDialog;
Keep editing preserves the draft. Confirmations use the shared bottom-sheet
form below the compact breakpoint and the centered form otherwise. A single
bounded exit intent received while saving waits for the operation and is then
rechecked against the current draft.
Settings registers this guard instead of copying dirty/pending flags. Hiding an
already-mounted page on a global tab switch preserves the draft. No global
desktop Back/popstate or reload trap is added.

Global instructions cannot be saved from an unfinished or failed read.
Every opening has its own generation, including reopening the same document;
an old reply cannot replace the newer text. Skill refresh also guards dirty
work and freezes its target before awaiting. Skill file and file-list requests
have their own sequence so a pre-refresh reply for the same path cannot
overwrite the refreshed preview. Select and modal key handling precede the
editor's Escape guard.

### File tools (#157, 2026-09-10)

Files tools adopt the shared command metrics and state contract too.
#164 (owner, 2026-09-11) refines dense tool groups through the shared
`compact-tools` inset, without changing CommandButton state/activation or
28/44px native targets. The toolbar stays one row and measures whether a
trailing More menu is necessary; it is not a fixed device-specific cutoff.
The listing is a
content surface, not a navigation sidebar. It fills an unused preview area,
then uses its own SideHandle width beside an open preview. Names wrap in full,
with size on the right in the same row, superseding #157's secondary-line
rule. Ordinary files/folders share one row minimum; long names may grow.
See [file-handling.md](file-handling.md) for the verbatim owner correction,
measurements, width bounds and unchanged routing/Back contract.

### Chat command adoption (#166, 2026-09-12)

Owner, 2026-09-11 03:00 (verbatim):
> 还有 chat 界面里的一些按钮风格都帮我也检查都统一一下。

The remaining Chat commands still used private/legacy button paint and
negative-inset touch overlays. Their native layout boxes did not describe
their hit regions; Raw/window selection also existed only as a CSS class.
Hub header, Drawer commands, filter exit and picker footer now use
`CommandButton`. Native targets occupy 28/44px in flow; the paint keeps the
already-approved compact inset. No invisible hit region crosses another
command. `hub-atoms.css` owns the matching Chat/Drawer header line: 42px
minimum, the shared 2px tool vertical inset, 10px inline inset and 4px gap.
Coarse targets can grow both headers together without a second row.

Desktop partition commands expose controlled expanded state and their
region relationship. Compact page-navigation commands do not pretend to
expand hidden drawers. The title remains selectable, with its menu beside
it; rename and all project verbs keep the same captured action list.
Window chips remain native choices, not command buttons or a second roster:
their selected state is `aria-pressed`, their 28/44px native box retains the
shared vertical paint inset, and dots keep the one status language.

Copy/Raw are icon commands with accessible names and the shared hover card.
The existing `.m-acts` overlay owns position only, offset by half the actual
target height; CommandButton owns all paint and focus. Board's identical
note Copy adopts it too, so the old button recipe is removed whole.
Incoming tools use safe end alignment: a very short bubble falls back to
its left edge instead of sending Copy outside the scrollport. Outgoing tools
remain right-aligned. The empty alignment track passes pointer input through;
only the native commands intercept it. Compact Feed reserves half a target
in its existing bottom padding before any action opens, so last-message tools
do not create scrollable overflow or get clipped by the composer.
Board's notes container reserves the same half-target before its note input;
otherwise the Copy command took 14px of that input's native hit region.
Quiet painted icon tools can expose the same controlled selected wash as
borderless icon tools. Ordinary text/primary/danger commands are unchanged.
No permanent row, message context menu or new toast is introduced.

Inline prose folds, timestamps and data rows retain their content roles;
the shared `.to-tail`, Roster/Composer commands, RPC payloads and capture
listener order are unchanged. Interrupt remains plain amber and recoverable;
process stop, removal and project deletion remain red shared menu actions
with their existing confirmations. Operation feedback and confirmation
policy changes belong to #167, not this control adoption.

Chromium 152.0.7977.64 measured two 9x42px overlapping header hit regions
at 390px in the baseline and none after adoption. Seven general variants
(desktop/390px, both themes, reduced motion and wide touch) pass the
shared target/state checks; four edge variants add 360px, 1000px splits,
short incoming/outgoing tail messages and Board note/input boundaries.
Restoring only the old 6px bottom padding reproduces 16px extra scrollable
height; restoring only right-alignment sends short-message Copy 6.53px
outside the left edge. Both negative controls fail and recover after removal.
This is a real-component, controlled-RPC browser fixture, not a native APK
or full App safe-area/assistive-technology acceptance pass.

### Legacy consumers during migration

The following records explain existing non-migrated atoms and historical
owner decisions. Their 24px/28x26px/pill configuration variants are replaced
by the contract above, not extended by new page-local overrides.

- `.chip-btn` — bordered text chip; `.primary` accent wash; lone `.danger`
  quiet until hover. `.chip-btn.primary.danger` = SOLID red with white ink,
  reserved for the confirming button of a destructive dialog.
- `.icon-btn` — BORDERLESS icon square (28×26), the page-head action dialect;
  the rail's grammar, not the chip's (owner, 2026-08-28: icon-only actions
  drop the thin frame, "类似…选项卡图标的风格"): hover = `--surface2` wash,
  press/toggled-on = `--accent-bg` + accent ink, disabled = 0.4 opacity (the
  border used to carry visibility). Label goes in `title` + `aria-label`.
  `.danger` reds its ink and tints the wash. Files' `.tool-btn` and Sessions'
  pill variant wear the same skin at their own touch sizes. Editor heads
  (AgentsPage) speak it too — save/cancel/delete/refresh are icon-only with
  the label on hover (owner, 2026-08-28: "能用图标就不用文字了…鼠标移在上边
  才有小的文字alt标签"); the confirming action is `.go`, the same borderless
  button — and when a `.go` is CLICKABLE it is a FILLED button: solid
  accent, page-background ink, hover by brightness (app.css, one app-wide
  rule). The owner could not spot the armed ✓ (board #98), and round two
  settled the shape: "可以用带背景色的按钮…不要用单独的线条了，颜色也调回
  以前的颜色" — the solid-fill-for-the-confirming-action grammar
  `.chip-btn.primary.danger` already speaks, in the accent instead of a new
  colour. Disabled it drops to the shared quiet grey. `.go` is worn by
  CONFIRMS only — the boardNew `+` opens a form and stays a plain
  `.icon-btn` (owner: "加号按钮不用调整"). No page redefines the go colour
  locally (the old AgentsPage accent ink retired into this rule) — emphasis
  by colour, not by a
  frame. Dialog CTAs keep their text chips: a destructive confirm must read
  its consequence.
- `.side-row` — sidebar list row; hover `--surface2`, open/selected
  `--accent-bg`.
- A resting CARD on the page canvas (agent cards, the connect card) wears
  `--surface` + 1px `--border`: dark-theme elevation is the surface lift,
  never a black drop shadow alone — `--bg`-on-`--bg` with a black shadow
  reads flat on the near-black canvas (owner, 2026-09-05: "第一次启动的
  时候，选项的卡片后面没有阴影"). A drop shadow may ride along for the
  light theme, where it does show.
- The Hub roster's agent TAB (board #236) — the one Chrome-tab selection
  idiom, reserved for the destination strip above the composer: at rest a
  card is a bare name (no paint, no line), hover is the `--surface2` wash,
  and the SELECTED card and the composer BAND below are ONE ENCLOSURE wearing
  the AGENT BUBBLE's own paint — `--bubble-in` fill, `--bubble-line` edge
  (owner, 2026-09-22: "和 Agent 返回给我的消息框的亮度色彩差不多就可以…整体加
  一个稍微淡白色的边"). The contrast comes from the strip's `--hub-tab-frame`
  going DARKER beneath (per-theme opaque, dark `#06060a`, light `#e2e2e8`),
  never from a brighter tab ("会不会有点过亮了？…把其他地方变得更暗的方式来解
  决"). The lit tab's fill overlaps the floor line and the band's top edge by
  1px through a join layer of its own (the paint box and its strokes end at
  the floor), so the outline breaks exactly at the junction. The band's top edge is the
  strip's faint floor line, which the lit enclosure breaks and its outward
  feet turn into (2026-09-23; the earlier "中间分隔的横线不要有" was about a
  line that also crossed under the lit tab). MULTI-SELECT IS ONE ENCLOSURE: under All (and while All previews)
  the DESTINATIONS GROUP (`.tabs` — the All tab plus the live agents, sized to
  its content) is the lit tab — one fill, one edge, zero lines between
  siblings ("就用一个大的包边…不要有很多线拐来拐去") — and per-card paint
  switches off. The `+`, a stopped identity and the space behind them stay
  OUTSIDE it: they are not destinations ("不要把加号后面的这些区域也都框出来"). An inactive
  tab's LABEL dims to `--text2`, two signals for one state; avatars, status
  dots and context rings keep their colours because they are live facts. Top
  corners `--ui-radius-control`, fill down to the strip's floor in the
  single-row strip; the wrapped expanded list keeps closed rounded boxes. The
  swap animates on `--t-move`. A second wearer of this idiom needs a recorded
  reason — and has one since #365 (below).
- THE TAB STRIP (#365, owner 2026-10-14: "Terminal 上方的 Tab 栏和 Chat 上方的
  Tab 栏，样式需要做得更加一致一些"): the roster TAB above is now ONE atom for
  every row of mutually exclusive DESTINATIONS — the Chat roster's agents and
  the Terminal's windows — in app.css: `.tab-strip` (the `--hub-tab-frame`
  frame and its floor line), `.tab-group` (the destinations group that holds
  the one marker), `.strip-tab` (a destination: bare name at rest, the
  `--surface2` wash on hover, label dimmed to `--text2` while another is
  current), `.slide-pill.tab` + `.tab-shape` (`ui/tab-shape.ts`, the one
  travelling outline). Height, inset and foot are the strip's tokens
  (`--tab-paint-height` 30/32px, `--tab-foot` 8px; coarse: 36px targets, the
  2px paint inset — the owner's 2026-09-24 exception to the 44px floor holds
  for every tab strip). What a strip opens INTO is its own: `--tab-fill` /
  `--tab-line` — the Chat composer band (`--bubble-in` / `--bubble-line`), the
  Terminal's terminal (`--bg` / the head `--border` the floor line replaces).
  Content is the strip's: avatars, rings, team clusters and Stop in Chat; the
  backend mark and `index:name` in the Terminal, with its `+` and
  split/close/collapse commands after the group. The LABEL's type is the
  atom's, not the content's: the Chat tab name's display face, `--fs-ui`,
  600, on both — the whole `index:name` wears it, because a second face
  inside one label would be the inconsistency the owner asked to remove. A
  scrolled strip fades at its clipped edges (`.edge-fade` + `scrollEdges`,
  the roster's), so a cut label never butts against the title. What the lit
  tab is filled with is what it opens into, by design: Chat's lit tab is the
  composer band's `--bubble-in`, the Terminal's is the terminal's `--bg`. In
  the dark theme `--bg` is close to the frame, so the Terminal's lit tab
  reads by its outline, its full ink and its join into the terminal, not by
  a brighter fill; a lighter fill there would make the tab a block of a
  different colour from the terminal it opens into. The phone Terminal
  head is 44px (main: 43): the 8px head padding plus the 36px tab standing
  on the floor line that replaced the 1px border; recovering 43 would need a
  raw 7px inset (orchestrator, 2026-10-14: keep 44).
  Why tabs and not the old accent pills (orchestrator ruling): one current
  item among many reads as tabs with ONE marker; accent pills read as
  toggles, which is what `AgentChip` is kept for (MRU chips, the pane
  picker, the collapsed and split-cell badges). A page re-declaring the tab
  paint, a second marker, or a pill strip for destinations is a regression;
  `Terminal.source.test.ts` pins both wearers to the atom. Measured on the
  branch: the Chat roster at 1280 is box-for-box identical to main; the
  Terminal strip is 42px at 1280 (tabs 34px) and 44px at 390 touch (tabs
  36px), and the marker glides on `--t-move` to the picked, added or
  remaining window.
- `.pick` / `.agent-pick` / `.pchip` — stadium toggle chips for MEMBERSHIP
  (skills, roster picks); selected = `--accent-line` border + `--accent-bg`.
- Inputs — the dense field dialect: `--input-bg`, 1px `--input-border`,
  `--ui-radius-control`, `--fs-ui`, padding 6px 9px; focus = accent border.
  `ui/Select` is the ONE dropdown (its `editable` mode is the one combobox);
  a native `<select>`/`<datalist>` is a regression.
- Segmented rows / steppers (Preferences) — `--ui-control-height`,
  `--ui-radius-control`, `--ui-font-control`. A segmented row is
  `ui/Segmented` (`options` / `value` / `onchange`), never hand-rolled: the
  accent wash + ring is ONE `.slide-pill` that travels to the chosen option
  (motion.md §1.14), the buttons keep only their ink (`.state-ctl` cross-fade)
  and the chosen one drops its own border so the pill's ring shows.
  `ui/segmented.source.test.ts` pins it.
- Dialogs — `ui/Dialog` is the shell of EVERY modal (#317: four copies had
  drifted into three shapes, two of them with no Escape, Tab trap or focus
  restore), and `ui/ConfirmDialog` is the one confirm inside it; phone =
  bottom sheet with 44px buttons that rises on `sheet-up` under a fading
  scrim, desktop = a centred card that fades. The content dialect (`.dlg h2`,
  `.dlg-note`, `.dlg-error`, `.dlg-actions`) lives in app.css because the
  children belong to the caller. Solid red confirm per above.
- The `Select` trigger's chevron is a `.flip` that turns 180° while the list
  is open (both the button and the combobox mode — the combobox puts the
  rotation on an inner wrapper so its own centring transform stays put); the
  list itself does not animate beyond the "invisible until measured" guard.

## 4 · Hover / active (desktop), two families only

Configuration commands use the scoped state matrix in §3; the legacy
press-scale/brightness details below do not override it.

- CONTROLS (text chips, inputs, select triggers — anything wearing a drawn
  border): border → `--accent`, text → `--accent` (danger controls red
  instead). No fills. Icon-only buttons are NOT here: borderless, they hover
  in the wash family below (like the rail).
- ROWS & MENU ITEMS (side rows, menu buttons, list rows): background →
  `--surface2`, text → `--text`; toned verbs keep their tone and tint their
  wash (`color-mix` 14%).
- Solid CTAs brighten (`filter: brightness(1.07)`); pressing scales 0.93–0.95.
  All at `--t-fast`. Hover is never the only affordance (phones exist): a
  hover-revealed control must have a tap/long-press route.
- ONE exception, named: an icon command standing ON a surface that already
  carries the hover takes `CommandButton`'s `bare` modifier — no rest, hover
  or press paint, the glyph is the control; hit box, focus ring, pending and
  disabled unchanged, and never on solid paint. A wash there would be a
  second layer of the same hover. Today the roster card's Stop only (board
  #211, owner 2026-09-20: "停止按钮就不用加背景了，就红色方块我直接点就行"); a
  toolbar's icon commands stay in the wash family.

## 5 · Menus & popovers

- **Trigger-anchored scroll ownership (#180, 2026-09-12).** A ContextMenu
  with a rect anchor and connected trigger closes only when a container of
  that trigger scrolls, through `scrollMovesTrigger` in placement.ts, the
  same predicate PanePicker uses. Sibling feed/terminal output does not move
  the trigger and must not dismiss an action menu mid-choice. Pointer anchors,
  trigger-less menus and detached triggers retain broad outside-scroll
  dismissal. Own-list scrolling remains exempt; no new listener is installed.
  A mounted regression first reproduced the All menu disappearing on Feed
  scroll, then pins sibling/own/ancestor paths and the pointer-anchor control.
- **Shared popup chrome (#165, 2026-09-12).** Owner, 2026-09-11:
  "对了右键的菜单风格都检查统一。" The later compact correction
  ("很多卡片按钮什么的，不要这么傻大的", 2026-09-12) is the reason to
  use 28px pointer rows rather than enlarging every action menu to the old
  36px Select rows; coarse rows remain 44px.
  `menu-surface` owns only background, border, the 16px round panel and the
  softer shadow derived from `--control-shadow`. ContextMenu, Select,
  PanePicker and HoverCard share this paint without sharing roles or content
  layout. `menu-list` opts list-shaped content into 5px padding and 2px gaps;
  `menu-item` owns 4px/10px padding, 8px content gaps, 12px row corners,
  UI-face text (12.5px pointer / 13.5px coarse), hover/cursor and disabled paint.
  These metrics live in app.css, not repeated component styles. Font-preview
  option text still uses its requested family; data headings/hints keep mono.
  Long labels/headings wrap; hints yield width to labels. One optional leading
  icon column aligns a mixed list without reserving it for an icon-free list.
  Menu actions are explicitly non-submit buttons. ContextMenu keeps
  menuitem/menuitemcheckbox, Select keeps options, PanePicker keeps its
  dialog/chip composition, and HoverCard remains a non-interactive tooltip.
  Width/height/position and dismissal stay with their existing owners.
  ContextMenu uses `width: max-content` before its viewport cap: once labels
  wrapped, auto shrink-to-fit width depended on the already-clamped left
  position, creating a ResizeObserver feedback loop at the right edge.
  Warning **text** mixes 60% `--status-warn` with `--text`, reaching 5.42:1
  on light background and 4.76:1 on its 14% warning hover wash; raw dot amber
  failed 4.5:1. Destructive text uses `--danger-ink`. This derives readable
  menu ink from existing semantics, not a new status palette or a change to
  the Stop glyph's separate 3:1 contract.
  Chromium 152.0.7977.64 verifies 96 corner/zoom/theme/input cases without the
  width/position feedback loop, plus real Hub/Files menu consumers. The measured
  warning-text floor is 4.75:1 including hover. This paint adoption does not
  claim that unrelated picker or keyboard behavior is already corrected.
- **Keyboard cursor boundaries (#165, 2026-09-12).** ContextMenu and Select
  use `ui/menu-navigation.ts`: the first Up enters at the last enabled item,
  Down at the first, and Home/End use the same edges. Applying modulo to an
  unseated `-1` cursor previously skipped the last item on Up. Moving the
  active-descendant alone also left Select's End choice outside its viewport;
  each view now reveals the chosen row through native `scrollIntoView`.
  ContextMenu has one tab stop, closes on Tab without stealing the next focus,
  and ignores keys owned by a foreign field. Select focuses its native
  trigger on opening and likewise ignores foreign focus. Existing IME,
  disabled, modal and activation gates remain; no global navigation trap.
- **Rich picker boundaries (#165, 2026-09-12).** The server chooser is a
  non-modal dialog with native Tab-navigable controls, not a menu with nested
  editing controls. Its explicit switch/rename decision and focus/IME rules
  live in websocket-client.md. It adopts the same frame/list paint, with a
  two-line row budget derived from two control line boxes and padding.
  PanePicker and HoverCard also measure border boxes and constrain width in
  zoom-corrected viewport space. The tooltip remains non-interactive: no
  scrollable clipping is added to hide facts. PanePicker preserves its
  terminal-aware ancestor-scroll rule and yields Escape to an active modal.
- **ContextMenu activation contract (#164, 2026-09-11):** checked view/tool
  choices announce `menuitemcheckbox` and `aria-checked`; ordinary verbs remain
  `menuitem`. Disabled entries reject queued activation too. Its dimensions
  include borders, its height is bounded inside the same 8px viewport inset,
  and internal scrolling remains exempt from outside-scroll dismissal.
  The focused menu announces its keyboard cursor through active-descendant
  IDs and scrolls that item into view inside the bounded list.
  Coarse pointers get 44px rows even on wide screens. Opening moves focus into
  the menu so earlier territory-based Escape listeners see the correct owner;
  active modals keep their keyboard priority. Connected focus is restored
  before invoking an action, so a following dialog inherits the live origin,
  and cleanup never steals focus from a newer control. Earlier Hub capture
  handling yields to menu territory instead of closing the drawer below it.
  These are shared prerequisites,
  not a second Files menu or a global history trap; #165 supplies the shared paint.
- ONE popover mechanism: `position: fixed` layer placed by `menuPlacement`
  (`anchorOf`/`pointAnchor` divide by `--ui-zoom`), styled `--bg` surface,
  1px `--border`, the shared `menu-surface` frame and `menu-item` rows;
  invisible until measured. Dismissal set: outside pointerdown, Escape, any
  ancestor scroll, resize — and every transient layer auto-hides after its
  job (owner rule, 2026-08-22). "Ancestor scroll" is a CAPTURE listener on
  window, which also hears the layer's own list scrolling — each layer spares
  itself (a long Select closed the moment it was scrolled; review 2026-09-03;
  `ui/popover.source.test.ts`).
- **A popover placed BESIDE its anchor, for the rail (2026-10-09, #326).**
  `menuPlacement` takes `side: 'below' | 'right'` and returns the ROOM it
  found with the position (`{x, y, maxW, maxH}`). The desktop rail's bell and
  server switcher sit in the bottom-left corner, so a menu placed below them
  flipped up and clamped onto the 8px margin — i.e. over the rail, hiding the
  buttons the reader wanted next (owner: "小窗口就把上面的区域覆盖住了 导致我
  没办法再去点其他按钮"). With `side: 'right'`, `x` is the anchor's right edge
  plus the gap and is NEVER clamped back; a narrow window shrinks `maxW`
  instead, and the caller caps itself with `--pop-maxw`/`--pop-maxh` and
  scrolls inside. The box to clear is the CALLER's: App composes a rail
  control's vertical span with the RAIL's right edge (`popoverFrom`, derived
  from `el.closest('.rail')`), so the popover clears the whole 46px column and
  the same `centre` store opened from the Hub's header bell still drops below.
  The rail is not gated on 760px — a forced Desktop layout shows it in a
  narrow window — so the guarantee is by construction, not by breakpoint.
  `popOrigin` takes the same `side`: a beside-right popover grows from its
  left edge, and both rail popovers resolve position, room and origin from ONE
  `popoverFrom` answer, so an intro can never start at a corner the popover
  was not placed against.
  An ICON-ONLY segmented option (the scratch panel's two edges) carries its
  name on the shared hover card, never a native `title`: a second tooltip
  species beside the one card is the regression this section exists to
  prevent. A row is iconic only when EVERY option has an icon; a mixed row
  draws text for all of them, because the travelling pill cannot cross cells
  of two shapes.
- **A click trigger may opt into staying clear (2026-09-11, #173).**
  `ContextMenu` accepts `at.keepTriggerClear` with a rect anchor. The shared
  `menuHeightLimit` caps height to the larger space above/below, rounded down
  for integer `offsetHeight`; existing `menuPlacement` still owns the flip.
  This preserves the stopped card's native second click even when a full
  menu fits on neither side. Point menus and other callers are unchanged.
  Pure vectors include fractional anchors; Chromium at 1440x240 measured a
  100px internally scrolling menu ending 6px above its trigger. Without the
  cap the viewport-only clamp can cover the trigger again.
- A pick-one over a control that is NOT a field (an icon toggle, a header
  pill) is `ui/ContextMenu` with `checked` on the current row — Select's own
  trailing check, so a menu and a dropdown say "you are here" in one glyph;
  `hint` is Select's secondary text. Pass the opener as `at.trigger` so its
  click toggles instead of closing-and-reopening.
- Right-click and long-press are ONE gesture (`ui/ContextMenu` +
  `ui/longpress`), offering the verbs the surface already has elsewhere.
  **They anchor differently** (board #196, owner 2026-09-13: "手机上展开选项卡不是
  以点击焦点展开选项卡，是以元素的左对齐展开，手机长按之类的也类似，和鼠标操作不一样"): a
  right-click opens with its corner at the POINTER (the OS convention), a hold
  opens at the ELEMENT held — left-aligned to it, the element kept clear
  (`keepTriggerClear`) — the same reading a control that opens its own menu
  gets (the All button, a stopped card, the title caret). `ui/longpress`
  decides this once for every long-press menu: it hands
  `{ anchor: anchorOf(node), align: 'left', trigger: node, keepTriggerClear }`
  plus the finger's `x, y`; only a SURFACE with no element to align to (the
  Files directory background) strips it back to the point. A menu opened by a
  TAP on an already-selected object is element-anchored on both inputs.
  **Desktop browser chrome never surfaces**: App installs one capture-phase
  `contextmenu` guard; a surface with app verbs opens its shared ContextMenu,
  and a surface without one simply does nothing instead of showing the browser
  menu. The guard yields to touch/pen (including legacy synthetic mouse events
  with `firesTouchEvents`) so native selection is untouched.
  **Selectable prose is the exception**: a touch/pen hold belongs to native
  text selection (never `preventDefault` its `contextmenu`); only mouse/
  keyboard contextmenu opens the app menu, and selection beats the tail click.
- Menu ORDER = rising consequence: read/constructive verbs first, configure
  next, amber interrupt-class verbs after, red destructive verbs LAST.
  Tones sit on the verb at rest, not only on hover.

## 6 · Touch

- Primary actions ≥ 44px hit area — small visual boxes grow an invisible
  `::before/::after` overlay. Menu rows ≥ 40–44px on compact. Keyboard
  equivalents (Enter/Space) on anything with role=button. A scrolling
  record's back-to-tail action is always global `.to-tail` (board #49), with
  component CSS limited to placement — never a page-specific redraw.
- Keyboard reach: the ONE focus ring is app.css `button/input/textarea:
  focus-visible` (accent outline, 2px offset). Navigation never opts out of
  the Tab order with `tabindex="-1"`; only a container that is focused
  programmatically (a `role=menu`/`listbox` layer) may carry it.

## 7 · Copy is a label, not a tutorial

The interface explains itself through hierarchy, state, placement and familiar
controls. Visible copy names the object, value, state or consequence; it does
not narrate the design or teach ordinary gestures. `Click: address`,
`Right-click: menu`, “tap again”, implementation details about panes/hooks,
and a subtitle that merely repeats the controls beside it are regressions.

- Hover cards report live facts (state, model, path, shortcut), never a footer
  explaining click/right-click/long-press.
- Settings rows need a label and their value/control. Persistent helper text is
  reserved for an actual warning, validation failure or non-obvious constraint.
- Empty states are verdicts (`No messages`, `No issues`), not onboarding prose.
- Form help may state an input format briefly. Storage/materialization details
  belong in docs, not below the field.
- Destructive confirmations are the exception: say concisely what is lost and
  what survives. Accessibility labels remain even when visible prose is cut.

## 8 · Data honesty (the "verdict" rule)

"Empty" and states are VERDICTS, not defaults: render nothing until the first
answer arrives (`roomReady`, `listReady`), keep last-known data on a failed
poll ("could not ask" ≠ "there is nothing"), and cache-restore on switches so
nothing flashes.

## 9 · New-feature checklist

sizes from `--fs-*` · fonts by role · colours by token · radius from the scale
· controls from §3 · hover from §4 · popovers from §5 · 760 compact + onGoBack
· 44px touch · transitions from `--t-*` · reduced-motion for loops · no new
species without retiring the old one — and update THIS file when a rule earns
an exception.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Configuration controls share behavior, not just paint (2026-09-10, #155)

The 32px pointer / full-height painted boxes below are historical measurement;
#161 supersedes their appearance, not their functional tests.

Owner-approved #154 replaces the inconsistent configuration dialects with
the §3 contracts. Node mount tests execute keyboard, IME, controlled values,
pending guards and modal ownership; source tests enforce tokens and contrast.
Chromium 152.0.7977.64 measures 32px pointer / 44px touch controls in six
desktop/390px/wide-touch light/dark/reduced-motion variants. The fixture mounts
real Settings and Agent views plus a shared-control specimen; it does not
prove their still-unmigrated form workflow or every global-token consumer.
Those forms follow in #156, and the owner's actual browser/APK acceptance
remains a separate gate. Restoring old pending, IME, native-value and modal
handling fails the corresponding tests; restoring the range attribute order
reproduces Chromium's fractional-value rounding.

### Compact paint does not shrink the input target (2026-09-10, #160/#161)

Owner, 14:19, verbatim:
> 我看到都改变了 但是这个设计语言不好看 有点古老 不够现代 我希望是更现代化一些的 不要那么大的按钮方块 更圆润精致一些 和苹果设计一样

Owner, 14:58, selecting the real-page compact comparison, verbatim:
> 是的，紧凑方案好，而且紧凑方案可以下拉框高度更低一些，不要那么笨大。还有圆角设计也统一，不要很多还是方框，还有一些在文件上的功能按键，尽量紧凑，不要浪费空间

The cause was equating target size with painted size and outlining every
control/group. Change that at the shared control layer, not through page-local
skins or by shrinking touch reach. Keep native fields, modal/draft ownership,
disabled pristine Save, controlled tools and the existing selection indicator.
The compact prototype is the visual reference; it is not shipped as an override
stylesheet. Its page composition, font/canvas refinements and Files action gaps
belong to the following surface issues, not this foundational control revision.

Chromium 152.0.7977.64 also exposed the old global `:is(...)` corner list
borrowing `(0,3,0)` specificity from one Sessions selector: later round
variants lost. `:where(...)` makes the same list a default; round variants
remain in the same global owner, including the existing Sessions icon variant.
The 1440x900/390x844 light/dark matrix plus wide-touch and reduced-motion spots
measures 28/44px native targets, 24/32px command paint and 24/28px Select paint.
Clicks on the transparent target margin still focus/open the native trigger;
menu width, 6px gap, Escape/focus return and the single selection marker stay
correct. Removing the field inset restores the excessive painted height;
restoring `:is` restores square-looking corners. Both fail the browser checks.

Token tests check actual neutral-surface text and focus-ring pairs; the retained
`--control-border` test only covers outlined controls such as checkbox/switch,
not the deliberately borderless compact field. These measurements are not a
full accessibility certification. Native WebView/IME rendering, other legacy
consumers and owner-build acceptance remain separate from this fixture.

### Compact Settings fixes the row budget, not the touch target (2026-09-10, #162)

The owner's 14:19 rejection and 14:58 compact selection are quoted verbatim
in the preceding #160/#161 rule. The 160px label + 24px gap + 240px minimum
control budget forced every ordinary 390px Settings row to stack. Smaller
button paint alone could not fix that structural waste.

Replace the row budget in its existing `app.css` owner; Preferences only opts
into `config-compact` when its accepted category is not an embedded Agent
page. A pending/rejected Agent exit cannot change the editor's metrics;
the existing mount scenario checks this before and after the guard applies.
No handler, persistence, font preference or history mechanism changes.
The prototype's temporary font-role collapse and canvas overrides are an
intentional comparison difference, confirmed by lead review at 15:20; three
font roles and the existing palette remain visible in the candidate screenshots.

Chromium 152.0.7977.64 measures ordinary 390px Appearance rows at 55px
(last row 54px without its divider), down from 85.5px. The last row ends at
508px instead of 757px, matching the chosen compact reference. Restoring
the old row budget makes the narrow-screen geometry check fail. Check all
Settings categories, menu/focus alignment, recorder and error states, not
only the initial Appearance view; actual device acceptance remains open.
Independent review caught a second boundary: 360px English/custom-font
content could exceed the fixed 208px value track. Shrinking that grid track
did not fix equal-segment text overflow. Content-aware wrapping plus the
Segmented grid's honest intrinsic width preserves the ordinary 390px reference
and lets wide labels/commands fall back without clipping. Its existing
indicator, state callbacks and native touch targets are unchanged.

### Compact entity forms and unframed identity (2026-09-11, #163)

This adopts the owner's 2026-09-10 14:19/14:58 compact choice quoted above
for Agent, Team, Skill, MCP and global-instruction editors. The shared
controls were already compact, but the page still used the old stacked
labels and 280px-column budget. `app.css` owns the replacement short rows
and writing-surface metrics; the page opts in, without a private skin.
The existing three font roles, canvas palette and shared 6/12/20px rhythm
remain, as in #162; the prototype's temporary font/canvas overrides are not
production decisions. Checkbox legends now inherit the shared label gap
and weight, with unchanged defaults outside configuration forms.
In the 360px fixture, using native input `max-content` put even a short model
value on a second line (78.5px row). The editable-field basis therefore
shrinks to available space; this does not require text-width estimation or
another geometry observer.

Owner, 2026-09-11 03:00 (avatar excerpt, verbatim):
> 还有 agent team 配置里，agent 图标是一个小圆外边多了一个圆角矩形，这个边缘没必要，agent 图标用圆形没问题的。

Remove only the member avatar's extra shadow and 8px box. Its 32px desktop /
34px compact dimensions, backend asset/brand colour and fallback stay;
the avatar is circular and no longer opts into the global squircle list.
The member itself remains one framed repeated object, with its existing
summary, disclosure, actions and focus treatment.

This revision changes no editor handler, payload, draft, Save/Back guard,
request generation, geometry observer or selection mechanism. Native
28/44px targets and the shared Select anchor remain. Chromium 152.0.7977.64
measures ordinary short rows at 44px on desktop (formerly 53.5px) and 49px
at 390px coarse input (formerly 69.5px), with 360/238px value widths.
The 360px model row also stays 49px after correcting its native width basis.
Before/after fixtures cover both themes, 360px, a 500px embedded form,
wide touch, alternate mono text, reduced motion, real backend assets,
popover/focus placement and dirty/error/pending states. Removing the entity
opt-in restores stacked rows; restoring the avatar's box/shadow fails the
shape check. Owner acceptance on the merged browser/APK, including native
IME behavior, is separate from this controlled-RPC browser evidence.

### Configuration adoption is measured per state (2026-09-10, #156)

Chromium 152.0.7977.64 found that Settings font Selects still used 12.5px while
Agent values used 13.5px, and the initial touch Agent list still had 32-33px
rows. Sharing a component or testing only its height did not establish the
contract. Remove the legacy dense option, apply the navigation atom to initial
lists as well as editors, and inspect reading, pending, error and read-only
states. Real-component mount tests caught a second discard prompt between
Preferences and AgentsPage; the host's approved section is now accepted without
another guard. Late global and skill-preview reads, duplicate saves and held
exits have executable regressions and negative controls. The runtime matrix
covers both themes, pointer/touch layouts, reduced-motion spots and Chinese;
it does not substitute for native-platform or owner-build acceptance.

### The design language is a CONTRACT

(`docs/design-docs/features/design-language.md`, owner 2026-08-25: "设定好一套规范 让以后的新功能也能完美和谐统一"): six type steps + three font roles + the radius scale + the two hover families (bordered controls: accent border; rows/menu items: surface2 wash — icon-only buttons are BORDERLESS and hover in the wash family, like the rail; owner 2026-08-28) + ONE popover mechanism + rising-consequence menu order + `--t-fast/--t-move` motion + 760px compact with sheet-or-drilldown + 44px touch overlays. New surfaces REUSE the dialects in §3 or retire an old one — a new species is a regression. The doc lists what the source tests already enforce.

### Copy names facts; it never narrates the interaction

(board #87): labels, values, state, and consequence are UI copy. Ordinary
gestures and implementation mechanisms are not. Hover cards may add current
facts but never `Click: … / Right-click: …`; Settings does not put a subtitle
under a self-explanatory control; empty states stay verdicts. Brief format help
and destructive consequences remain, as do all accessibility labels.

### One dropdown, and it is ours

(`src/lib/ui/Select.svelte`): a native `<select>` pops the OS menu — its own font, palette, animation, and on desktop WKWebView a separate window — so every picker in the app is the shared component (owner, 2026-08-19: "尽量保证我们 ui 统一一致"), and a native `<datalist>` is the same violation with suggestions (the agent editor's model field wore one until the owner caught it, 2026-08-24: "模型选择下拉框明显不对") — Select's `editable` combobox mode replaces it: a real input in the trigger's exact clothes, the menu as the filtered suggestion list, free text preserved (`registry_save` stays the authority on bad ids). It reuses the popover mechanics of the Hub's agent menu: a `position: fixed` layer placed by `menuPlacement` (`src/lib/ui/placement.ts` — UI-level, so a `ui/` component never imports from `hub/`; `anchorOf` divides the client rect by `--ui-zoom`), because these fields sit inside scrolling panels that would clip an absolutely-positioned menu.

**Every fixed popover assumes the VIEWPORT is its containing block, so `.page` must never become one**: a permanent `will-change: transform` on `.page` made it exactly that, and on desktop — where the rail pads `.page` 46px right — every menu rendered 46px right of where the math put it (owner, 2026-08-25: "下拉框整体往右偏了"; the phone's `.page` starts at x=0, which is why nothing ever showed there). The hint now applies only WHILE the 120ms tab slide runs (no popover can be open mid-slide), and any fixed sheet that clears the status bar pads with `var(--sat)`, never raw `env()` — the APK's real inset arrives via MainActivity's inline override and `env()` reads 0 there. The menu is placed with the FIELD's width (`fieldW`), never a measured-back `clientWidth`, which excludes the border and — on classic-scrollbar desktops — the scrollbar. The trigger wears the app's INPUT dialect so it does not look like a different species next to a text field; rows take `--ui-font-control`, hover and the keyboard cursor are the SAME highlight (two would read as two selections), and dismissal is outside-pointerdown / Escape / any ancestor scroll / resize. Team's roster picker was the first hand-rolled one and is now the same component, not a second implementation. The 2026-09-03 review found four more hand-rolled `position:absolute` panels (each with a backdrop button, hard-coded offsets, no Escape/scroll/resize dismissal, clipping at the viewport edge) and each went through the same door: the split layout menu (App) → `ContextMenu` with `checked`; the pane picker (`sessions/PanePicker`, also mounted by Terminal) → a fixed layer placed by `menuPlacement` from its opener, whose scroll dismissal is scoped to scrollers that CONTAIN the opener (it hangs over live terminals whose viewports scroll on every output line); the Team switcher → `ContextMenu` left-aligned from its pill with `checked` + `hint`; the phone's roster-template picker (TeamTemplates) → `Select`, with "new template" as a button beside the field rather than a row inside a pick-one list. The Settings address-history list was NOT converted: it is an inline disclosure in the form's flow (no floating layer, nothing to clip, nothing for a scroll to leave behind), with a per-row delete a combobox has no place for. `--fs-input-touch` bumps are gated `@supports (-webkit-touch-callout: none)` — the focus auto-zoom they exist for is iOS-only, and on Android the blanket bump made fields disagree with the dense Selects beside them (owner, 2026-08-24: "字号还是偏大不一致").

### At-rest is ACHROMATIC, and "in motion" is never colour alone

running vs idle is the one pair a reader must resolve at a glance, and a 5–7px dot cannot carry it on hue — the owner reported the two as indistinguishable twice (2026-08-26 "空闲是偏紫色 正在运行是蓝色 这些颜色太接近了", again 2026-08-29). Half the cause was the token: `--status-sleep` went indigo → blue-GREY, which is still the accent's own hue family at lower chroma (in light theme #94a0b0 sat 3° from #0088cc), so it is now equal-channel grey in both themes (measured ΔE(Lab) vs `--accent`: dark 42.9 → 49.6, light 36.1 → 41.5, while the gap to the composited `--text3` stays ~6 so a resting dot still reads as a STATE, not as disabled chrome). The other half was that the MOTION worked against the colour: `s-pulse` faded a running dot's OPACITY to 0.35, compositing it toward the card — on the dark card the trough measured L*=33.9 against idle's L*=55.7, i.e.

**22 points darker, so half of every 1.4 s cycle the running dot read as the less alive of the two** (light washed out the other way, L*=82). So an opacity keyframe on a state dot is BANNED, and the cue is now `.live-dot` in app.css: full-strength fill + a `color-mix` halo over the dot's own `--live-hue` + the `dot-breathe` SCALE loop (the presence tempo CollabGraph already speaks). The halo is the load-bearing half — ~3× the visual mass of a resting dot, which survives greyscale, 5px, and `prefers-reduced-motion` (that stills only the loop, and the old cue vanished entirely there). ONE mechanism, worn by class: the Hub sidebar chip, the roster card, the recipient picker and the tool lane's `.s-live` all add it, `stateIsLive()` (pure + tested) is the single definition of WHICH states get it (running + the legacy `working` — exactly the accent-coloured ones, pinned against `stateDotColor`), and Team's wider vocabulary reuses the same class with `--live-hue` overridden to its amber/orange states rather than re-implementing it. `--live-ring`/`--live-glow` shrink for the dense 5px sidebar chip so the glow does not sit on the name. `ui/statusdot.source.test.ts` pins the achromatic token, the halo+scale+reduced-motion shape, and that no component re-implements the cue or names the retired fade.

### Unread is accent ink; red is failure only (2026-10-09, board #322)

Owner, 2026-10-09: "现在的状态显示经常有红色的小点。比如网络断掉时，它就会显示这个红色的小点…如果这个红色小点没必要，我们甚至可以都不要了。或者你把它用来做通知提示". The red the owner saw was the roster's unread dot, painted `--status-danger`: after a reconnect the poll brings in the messages missed offline, they are newer than the read mark, and every agent that spoke lit red — which reads as "failed". Real failures are rare (15 `failed` turn ends in the whole live log by 2026-10-09) and come from the CLI's own failure edge (agent-status.md), never from the phone's connection, which shows the reconnect banner and keeps the last roster. One colour was carrying two meanings, so the grammar is now:

| meaning | paint | where |
|---|---|---|
| news you have not read | `--accent-ink`, STATIC (`.unread-dot`, `.side-unread`, `.to-tail.news::after`) | roster card, project row (dot + count), back-to-tail |
| in motion | `--accent` + `.live-dot` halo and breathe | state dots of running agents |
| needs a person / failed / at rest | `--status-warn` / `--status-danger` / `--status-sleep` | agent state dots and words only |
| destructive / error | `--danger*` | verbs, error text |

Unread never wears `--status-*` (it is not a state; `--status-ok` already means "ended well") and never the halo or breathe (those say a turn is open). Two labelled red uses stay outside the dot language: the Board sidebar's categorical `todo` count chip (with its word) and the context bar's >85% band. `Sidebar.source.test.ts` and `totail.source.test.ts` pin the tokens and the absence of `--status-`/`--danger`/animation on the unread atoms.

### A name never ellipsises to make room for its tag — the tag yields first (2026-10-13, board #359)

Owner, on #356's header: "那个 tag 放到名称底下，是按照模式来的吗？还是说，当发现
project 名称会被压缩成'...'时，你自动就把它放到底下？我发现在桌面上也需要这样的一个
功能。" Wherever a name carries a `ServerTag` (the Hub head; the Board, Terminal
and Files heads as they gain one), the two sit in ONE wrapping flex row
(`.title-stack`): the NAME LINE — the name and whatever is glued to it (the
Hub's chevron) — is one non-wrapping unit that hugs its text (`flex: 0 0
auto; max-width: 100%`), the tag is the wrappable item, so the tag drops under
the name exactly when the two do not fit side by side — on any screen, at any
width, by fit and not by mode — and the name ellipsises only once the line
alone is wider than the whole group. A control that belongs to the name
(the chevron) is INSIDE the name line, never a sibling of the stack: a
sibling centres against the two-line block and floats mid-height beside a
hole (owner 2026-10-13 22:57). Pure CSS: no ResizeObserver, no measurement, no
second class flip; the wrapped form reuses the 2px stack rhythm. The phone
stacks unconditionally (the stack is its complete form, #356), and there the
2px is measured from the NAME's text box to the tag (#363, owner 2026-10-14:
"标签和项目名中间的上下间隔有点大了，应该紧挨着"): a control in the name line
keeps its full hit box but lays out at its line height
(`margin-block: (--control-line-height − --control-height) / 2`, on top of
the tag), because the Hub's 30px chevron in a 19px name line had put the tag
7.5px under the name. Measured at 390 touch: Hub head 7.5px → 2px, the
Board head (no chevron) and the sidebar rows (`.p-main`) already 2px. A tag
that
holds its place while the name truncates, or a JS-measured flip, is a
regression. Verified in a real browser at 1280 (85-char name whole, tag below;
short name inline) and 700 (tag wraps first, the name ellipsises after).

### One server tag, shown by the source set (2026-10-12, board #335 ③c-1)

Where several servers can show in one place — a page head, a union row, the
Hub head, a notification — the row's SOURCE is named by ONE atom,
`ui/ServerTag.svelte`: a micro tag in the existing vocabulary (the pill radius
that tags already keep, `--fs-micro`, `--text2` on `--surface2`). A server is
identity, not a state, so it never wears a status colour or an agent ink; and
it is not a button, so it is on the capsule allowlist of
`tokens.source.test.ts`, not an exception to it. WHEN it shows is one rule,
`app/server-tag.ts` (`serverTag(scope, id)`): more than one server INCLUDED —
the source set, not how many answered, so a member that is offline keeps the
others named — and never otherwise, which makes Single tag-free by
construction. ONE ruled exception, by a different rule (orchestrator
2026-10-13 02:28): the system status strip names the Aggregate focus ALWAYS,
one member included or many, because a reading without its machine is not a
reading; it uses the same atom (system-status.md). The atom decides nothing itself (`ServerTag.source.test.ts`
pins it to its tokens and to the absence of any mode logic); App computes the
scope once and hands each tree its name through its scope (`ServerScope`
`tag`, a live read). A page that computed its own "should I name the server"
would drift from the others, which is the one thing a tag must not do.

### One back-to-tail control across scrolling records

(board #49): Chat and Terminal both wear global `.to-tail` from app.css — 38px token-surface circle, quiet ink/accent hover, scale press, 44px `::before`, and the unread-ink (`--accent-ink`, board #322) `.news::after`; component-scoped `.to-bottom`/`.scroll-btn` rules may POSITION only (right/bottom/z), never redraw the box. The old Terminal glass square/span dot is retired.

## User-facing vocabulary (the contract; moved from tmm-cli.md, board #102)

One noun per concept, everywhere the USER reads: the tab is **Chat** (中文 "对话") — it was "Hub", a name that described the architecture, not the page; a **Project** (项目) is the container entity in the left column, and each project has one chat; the things that speak are **agents**. "Room" is the store's term (`proj:<session>`) and NEVER appears in UI copy — the no-recipient send is "leave a note in the chat". Internal identifiers (`hub_*` RPCs, component names, i18n keys) intentionally keep their names: they are API contracts, and renaming them buys migration risk, not clarity.
