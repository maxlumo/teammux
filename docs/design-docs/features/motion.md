# Motion — the app's animation principles and the 2026-09-03 plan

Written on owner request (2026-09-03: "你现在是我们的 ui 动效设计师，你可以帮
我们定一下 app 整体的设计准则，以及当前项目优化实施方案"). This is the
normative motion contract; [design-language.md](design-language.md) §1 keeps
the one-paragraph summary and links here. `ui/motion.source.test.ts` pins the
vocabulary.

**Composer revision (board #168, 2026-09-11).** The agent strip replaces the
recipient chip and delayed tap menu; Send no longer swaps into a Stop or shows
an arm caption. Their wave-history entries below are retired, not invitations
to restore them. The remaining command palette and shared ContextMenu keep
`.pop-layer`; card state uses the existing `.live-dot` and token transitions.
Mentions carry one `@` mark. No height animation or new loop accompanies the
normal-flow composer, and the existing shell-height notification still runs
only when its measured height changes.
The owner's 07:09 final choice adds an in-flow roster disclosure: its
CommandButton chevron wears `.flip.on` from the existing controlled `expanded`
state. The list height is a cut inside the reading transaction, never animated.
Global turn-edge order uses keyed `flip`/`moveMs()` once pointing/press/focus
releases the held order. An idle expanded view stays live; no timer controls
release. Tool-call detail or poll time does not reorder cards.

## 1 · Principles

1. **Motion explains a cause.** Every animation answers "what just happened
   and where did it go": a caret turns because a section opened, a chip fades
   in because you attached something, a card slides because its status
   changed. Decoration without a cause is banned; so is animating a state the
   user did not touch (a poll refresh that re-sorts silently must not dance).
2. **Two tempos, no third.** `--t-fast` (120ms) is micro feedback: colour,
   border, a glyph turning, a chip appearing. `--t-move` (200ms) is something
   that MOVES or resizes: a drawer, a card changing place, a sheet rising.
   Spinner tempos are semantic (0.6s loading, 2.2s "a turn is open", 1.3–5s
   presence) and are not tokens. A raw `0.15s` / `160ms` in a component is a
   drift to fix, not a third tempo.
3. **Transform and opacity only.** Never animate height, width, top, left,
   margin or padding: layout animation is what makes a UI feel slow, and in
   this app several surfaces (the chat feed, the terminal, the composer) read
   their own geometry mid-frame and would measure a lie. An element that
   appears grows nothing — it fades or rises 6px into a slot that is already
   its size.
4. **A glyph turns, it is never swapped.** An arrow that reads up then down,
   a caret that reads closed then open, is ONE glyph rotated (180° / 90°); a
   180°-symmetric swap icon uses a quarter-turn so the movement remains visible. Two
   glyphs swapped is a cut, not a movement, and it is the thing the owner
   noticed first ("上箭头变成下箭头 可以用旋转过渡"). Unrelated glyphs (trash →
   caret, copy → check) may still swap: there is no rotation that means it.
5. **Enter with motion, leave with a cut.** Intros animate; exits snap. Exit
   should be faster than enter, and the fastest exit is none — an outro keeps
   a dead element in flow while the list under it has already moved, and it
   doubles a grid cell for a beat. The rule frees every `{#if}` from needing
   a matching `out:`. The cut is for LIST ITEMS and popovers — a thing whose
   place is taken by what is under it. A PARTITION that moved in moves out
   the same way (the desktop Hub's sidebar and drawer, board #174): a cut
   beside an animated open reads as a stutter, and nothing is under it to
   take its place.
6. **Arrive decelerating, spin linear.** `ease-out` for anything that enters
   or settles; `linear` for constant-rate rotation (spinners) and for the
   navigation slide (owner rule). No springs and no bounces: the app's
   surfaces are dense and technical, and overshoot on a 6px rise reads as
   jitter.
7. **The finger is the animation.** While a drag or swipe is in progress the
   element follows the pointer with an inline transform and NO transition; a
   transition only plays on release (spring back on `--t-fast`, commit on the
   navigation slide). Files' edge-swipe and the rail's icon drag are the
   references.
8. **A popover is placed first, then grows from its anchor; navigation has
   one slide; sheets slide with a scrim.** A menu, select, picker or hover
   card is measured invisible, positioned, and only THEN plays a short
   opacity + scale(0.96 → 1) intro from the corner that touches its trigger
   (`.pop-layer`, `popOrigin()`), so it is never seen at the wrong place and
   still feels like it came from where you clicked (owner, 2026-09-04 #86:
   "右键或者长按出来的选项卡出现什么的，都可以加动效" — this replaces the
   earlier "popovers do not animate"). Its exit is a cut. Page-level slides
   are touch-only. Desktop rails have no motion behind them — but the
   HIGHLIGHT that marks the chosen tab glides (principle 14). EXCEPTION
   (owner, 2026-09-11, board #174: "现在左侧侧边栏可以加一个折叠展开的按钮 …
   折叠展开最好是有动画，不是直接跳。另外右侧侧边栏，比如文件 board terminal
   的侧边栏，点击展开最好也是有动画展开。这些要更丝滑一些"): the desktop
   Hub's two PARTITIONS — the project sidebar and the files/board/terminal
   drawer — open and close on `--t-move`, ease-out both ways. They do it by
   REVEAL, NOT RESIZE, which is how principles 3 and 9 stay true: the
   partition's content is laid out at its FINAL width and pinned there
   (`pinTrack`, inline width, anchored to the edge that stays put), and only
   the grid TRACK moves — an animatable `@property` open factor in
   `grid-template-columns` (`--side-open`/`--drawer-open`, transitioned only
   under the `.moving` gate `moveTrack` raises) uncovers content that never
   changes size, the grid clips the rest. xterm inside the drawer is fitted
   once, to the final width (measured at 1440: the `.drawer` box is one value
   for every frame of the open and the close; the only xterm width change is
   its own estimated→real metric settling, present with the transition
   disabled too). The chat column in the middle does reflow during the move;
   it owns width changes already (ResizeObserver + retained reading anchor,
   #135). The order is "placed first, then grows" (this principle's popover
   rule): rest state → Svelte flush → measure → pin → move from the start
   value, all before a paint, so the final layout is never seen early and
   the last frame of the move IS the committed layout (the transition's
   target is the rest formula). Engines that do not interpolate `@property`
   get the cut this always was. Switching the drawer's partition while open
   is a content swap, not a move; SideHandle drags stay finger-driven with
   no transition (principle 7). Source: `src/lib/hub/reveal.ts`,
   `Hub.svelte` (the grid), `Hub.source.test.ts` + `reveal.test.ts`.
9. **Never touch the terminal's box.** No transform, transition or animation
   on `.term-wrap`, `.xterm-wrap`, a split `.cell`, or any ancestor of an
   xterm instance: a resting transform turns it into a containing block and
   breaks every fixed popover, and a transitioning size makes the fit run on
   a mid-flight measurement. Chrome AROUND the terminal (bars, chips, toasts,
   the to-tail button) moves freely; an xterm ancestor may fade (opacity) and
   nothing else.
10. **The feed decides its own scroll.** The Hub feed disables scroll
    anchoring and drives `scrollTop` itself; any animation that changes a
    block's height mid-flight (a `slide` on a fold) re-creates the documented
    blink loop. Feed blocks fade/rise in with transform only, and a fold is a
    turned caret plus a cut.
11. **Motion is optional.** Every loop stills and every atom goes inert under
    `prefers-reduced-motion`; a JS duration goes through `moveMs()` /
    `fastMs()` so it becomes 0 there. The static state must read on its own —
    a stilled spinner is still a partial ring, a stilled live-dot still wears
    its halo.
12. **Animate one or two things per view.** When a card is selected, its
    frame cross-fades and nothing else; when a feed block arrives, it rises
    and the to-tail dot pops — that is the budget. A screen in which five
    things move at once is a screen in which nothing is explained.
13. **Rapid changes cancel cleanly.** State correctness never waits for
    `transitionend`/`animationend`; CSS transitions replace themselves, an
    intro class is on the element that mounts so a remount restarts it, and
    a whole list mounting at once (history load, project switch) is gated
    with `class:appear={fresh}` so two hundred rows do not fade in together.
14. **One highlight that travels.** A rail, a segmented control has ONE
    marker for "chosen", and when the choice changes the marker glides to
    the new item (`.slide-pill`, `ui/indicator.ts` — the wash behind the
    item, never a bar: owner 2026-09-04, "线条都去掉，直接用 icon 上面的背景
    阴影来滑动")
    instead of one item switching off and another switching on. The items'
    own colour still cross-fades (`.state-ctl`); the travelling marker is
    what makes the change read as a movement (owner, 2026-09-04: "点击不同的
    标签页面，过度的一些选项卡高亮过度的时候，都可以有动效"). EXCEPTION —
    the phone TAB BAR selects by ink alone (owner, 2026-09-05: "保持没有背景
    色，只有前景色的一个高亮样式…没有选中灰色 选中后前景有颜色" — the
    WeChat/Alipay dialect): grey at rest, accent when chosen, no wash, no
    marker; its first paint and its post-tap state are one look by
    construction.
15. **A load unfolds, it never flashes.** Content that arrives after a
    switch does not pop in as a finished wall: while it loads, the slot
    shows either the PREVIOUS content dimmed (stale-while-revalidate, Files'
    pattern) or, when there is nothing previous, a skeleton of the right
    shape that appears only after 150ms (`.skel-wrap`); when the data lands
    the rows unfold with a ~30ms stagger (`.reveal` from the top,
    `.reveal-tail` from the newest message at the bottom). Never a blank
    frame followed by everything at once (owner, 2026-09-04: "切换过去然后
    看到东西闪出来 … 像一个东西在你面前展开一样加载").
16. **Hover explains.** On a pointer device, resting on a thing that has
    more to say (an agent card, a project row, a rail icon, a session, a
    file) opens ONE shared hover card (`use:hoverInfo`, `ui/HoverCard`) after
    a short dwell, instantly when hopping between neighbours, with the
    thing's live facts — never a second tooltip species and never a native
    `title` beside it. Touch has no hover: there the long-press menu is the
    "more" gesture, and the card is not shown. The card carries only what
    the element HIDES — an abbreviation spelled out, an id the row drops,
    a status word behind a dot — never the name or text already on the row
    (owner, 2026-10, on the server switcher: a card that repeats its
    element is noise); when nothing is hidden the card does not open
    (`hoverInfo` getter returns null). Board #335 ③c-5 applied this to the
    server list: machine id, connecting/reconnecting, Excluded — not the
    name, the address, or the failure reason the row already shows.

## Configuration Command States (#155, parent #154, 2026-09-10)

Configuration buttons use the existing feedback tempo but do not scale on
press: their label/icon boxes remain fixed at every state. Primary hover
and press are paint overlays, not geometry changes. Pending replaces an
already reserved icon with a shared spinning refresh glyph; the visible
label and width stay unchanged, activation is blocked, and pending is not
dimmed like an unavailable command. Reduced motion stops that rotation.
Switch motion only moves its thumb; Segmented retains the existing travelling
marker. #161 replaces its outlined group with an inset neutral track and a
single compact selected surface; the same action and geometry still move it.

`ConfirmDialog` retains its existing desktop fade and touch sheet entry,
now with shared command buttons. Its pending label is the operation's name,
not an ellipsis that resizes the action. No exit animation delays completion,
focus restoration, Escape handling or draft state.

These rules supersede press-scaling/independent-pill descriptions for the
configuration controls as they migrate; navigation slides, reading anchors
and terminal ancestor restrictions remain unchanged.

## 2 · Vocabulary (app.css, one copy)

| atom | meaning | tempo |
|---|---|---|
| `.chev` + `.open` | disclosure caret turns 90° (closed ▸ → open ▾) | `--t-move` |
| `.flip` + `.on` | up↔down arrow, or the rail's drawn `panel-left` toggle (#202): its inner chevron, not the stable panel frame, turns 180° on `--t-move` | `--t-move` |
| `.quarter-turn` + `.on` | a 180°-symmetric swap trigger turns a visible 90° | `--t-move` |
| `.tab-glyph` + `.on`, `glyph-*` parts in `ui/Icon.svelte` | a navigation tab's icon (desktop rail, phone tab bar, the disconnected gear) settles into its chosen pose and moves back when left (board #240): the terminal prompt steps forward and its cursor shortens, the chat bubble's three dots type in (40ms apart), the gear turns 90°, the files page gains its title line (slides in from the left with the move, no delay: a delay on either side stalled a reversal — deselect mid-entry or re-select mid-exit — and staggering one part against still lines buys nothing), a card drops into the board's left column, the agents crew rises behind the front bot. Every end pose is upright and visibly different from rest (#262, owner 2026-09-28: the −10° page tilt read as crooked, and the board's mirror flip ended on the same symmetric drawing, so only its middle frames differed); parts that enter (dots, line, card) rest hidden, so the glyph outside the atom is unchanged. One held transition, ease-out, so a rapid switch reverses mid-flight; outside the atom every part rests | `--t-move` |
| `.appear` | something enters: fade in | `--t-fast` |
| `.appear-rise` | a block/banner enters: fade + rise 6px | `--t-move` |
| `.appear-pop` | a badge/dot/small chip enters: fade + scale from 0.6 | `--t-fast` |
| `.state-ctl` | a control's selected/active clothes cross-fade (border, background, colour, inset ring, opacity) | `--t-fast` |
| `animate:flip={{ duration: moveMs() }}` | a keyed list reorders — the ONE Svelte directive in use (`ui/motion.ts`) | `--t-move` |
| `.side-scrim` / `.dlg-backdrop` fade-in, `sheet-up` (`translateY(100%) → none`, only for a layer whose resting transform is none) | sheets rise with a scrim (design-language §1) | `--t-move` |
| `drill-in-right` / `drill-in-left` (app.css, one copy), `slideInLeft/Right` (App) | navigation, touch-only | 120ms linear |
| `.pop-layer` + `.ready`, `--pop-origin` from `popOrigin()` | a placed popover grows from its anchor corner (opacity + scale 0.96→1); exit is a cut | `--t-fast` |
| `.slide-pill` (+ `.soft` no ring) + `use:slideIndicator` | the one travelling highlight of a rail / segmented control — the WASH behind the item glides; the bar variant is retired (owner, 2026-09-04), and the phone tab bar's `.inset` wash with it (owner, 2026-09-05: the tab bar selects by ink alone). `--ind-x/y/w/h` are written by the action from LAYOUT OFFSETS (`boxFromOffsets`, the `offsetParent` chain from both ends), never client rects: a rect carries the tab's press `scale(0.95)`, a slot's mid-flip transform and the root zoom, and a marker measured through them glided wrong and then corrected itself (the phone's "乱滑"). `.ready` after the first measure so it is born in place; `hidden: true` collapses it while the container is being rearranged. ONE ResizeObserver re-measures it, and it watches the container, the active item and the container's direct children (never the pill, which is the action's own output), calls coalesced to one frame (board #345, owner: after agents were added to a project the sidebar wash "没有跟着一起变大或变小"). The sidebars' container is a scroll area whose own box does not change when a row inside grows by a second line of agent chips, so a container-only observer never heard it; and a row ABOVE the active one growing moves the active item without resizing it, hence the siblings. Measured on a real gateway: after four agents joined, the row was 87px and the wash stayed 51px; with the fix the wash equals the row at every step (51 → 69 → 51px as four agents joined and left) and followed the active row from 129px to 93px when the row above it shrank. Pinned by `indicator.test.ts` (what is watched, one frame per burst, the position case) A segmented row is `ui/Segmented`, which carries its own pill | `--t-move` |
| `.reveal` / `.reveal-tail` on a container, dropped after `revealMs()` | a loaded list unfolds, rows staggered 30ms from the top / from the newest at the bottom; backwards fill only; the class is cleared after one move + the longest stagger so a row that mounts later does not rise (`ui/motion.ts` `revealMs()`) | `--t-move` + stagger |
| `.skel` (+ `.skel-wrap`) | a loading placeholder of the coming shape with a slow shimmer, invisible for the first 150ms | 1.4s loop, stilled |
| `pinTrack(track, edge)` + `moveTrack(cols, factor, from)` (`hub/reveal.ts`), `.cols.moving`, `.track.pin-start/.pin-end` | a desktop Hub partition is REVEALED: content pinned at its final width, the grid track's `@property` open factor moves; release on that track's own `transitionend` (safety net `moveMs()+100`, instant under reduced motion) | `--t-move` ease-out |
| `use:hoverInfo={() => info}` + `ui/HoverCard` | the one hover card (title / text / label→value rows / note), 380ms dwell, 60ms hop, pointer + keyboard focus only | `--t-fast` intro |
| `.tr-paint` under `.turn-rail.shown` (`hub/TurnRail.svelte`) | the Hub feed's turn rail is present only while it is wanted (board #465): the inner paint layer fades and slides `--turn-rail-shift` (6px) in from the right edge and back out; the hit column and band never transform. Reduced motion: opacity only | `--t-move`, ease-out, both ways |

Usage: wrap the `<Icon>` in `<span class="chev" class:open={x}>`; put `.appear*`
on the element that mounts inside `{#if}`; add `.state-ctl` to a segmented
button / tab / row that has an `.active`/`.on`/`.sel` state; key the `{#each}`
before adding `animate:flip`. `svelte/transition` is not used — intros are the
classes, exits are cuts (principle 5) — and `ui/motion.source.test.ts` forbids
importing it.

## 3 · Implementation plan (2026-09-03)

Three surveys (Hub · shell/Settings/ui · terminal/Sessions/Files/Projects/
Team) found ~120 state or position changes that snap. Ordered by how often a
user meets them; each item is a one-class change unless noted.

**Wave 1 — the vocabulary and the rule violations** (done with this doc):
tokens mirrored in `ui/motion.ts`; atoms in app.css; `.side-row` 160ms and
the scrim/to-tail snaps normalised; six spinner loops without a
reduced-motion still (App, Settings, Hub attach, AgentGrid, Team,
TeamTemplates) guarded; Hub's private `.chev` promoted to the atom.

**Wave 2 — turning glyphs** (principle 4): Hub recipient chip arrow, message
fold/unfold caret, tool-lane caret (already), Settings address-history arrow,
Select trigger chevron, Projects/TeamTemplates/Sessions disclosure carets,
AgentChip's `chevron` prop, the terminal chip-bar collapse chevron, the
server-switcher trigger (`.quarter-turn`, 90° — 180° is visually identical).

**Wave 3 — things that enter** (`.appear*`): fresh feed blocks (gated on
`ts > openedAt`), attachment / recipient-extra / unread / needs-you chips,
the interrupt pill, `.m-acts` rows, error and info lines
everywhere, reconnect and push banners, to-tail buttons (Hub + Terminal),
toasts (Terminal, Files copy/download), selection toolbar, search bar,
new-item / rename / commit rows, drop hint, system vitals first reading,
ConfirmDialog / picker / CreateProjectDialog / template sheets rising with a
scrim (the grammar already promised this).

**Wave 4 — state controls** (`.state-ctl`): tab bar, gear, split toggle,
Preferences segmented controls and address rows, shortcut recording, Board
status slider ring, `.acard` background + ring + opacity, `.to-chip`
variants, `.win-pill.cur`, `.pick.sel`, git tabs, Files tool buttons and
editor actions, Team header buttons, AgentGrid/SplitView active-cell ring,
state dots' background colour (never opacity).

**Wave 5 — reorders** (`animate:flip`, keyed lists first): Projects cards
(the most meaningful one: a project going up/down moves), roster cards,
Board same-column cards, sidebar project rows, Sessions rows and MRU chips,
terminal window chips, git status rows, Team roster chips, rail icons after a
drag, Settings history rows.

**Done 2026-09-03, shell / Settings / ui pass** (App, Preferences, Settings,
SystemStatus, ConfirmDialog, Select, SideHandle, InstallPrompt, Lightbox,
app.css atoms): tab bar, gear (turns 30° while Settings is open; 90° through `.tab-glyph` since #240), split
toggle, reconnect banner, rail drop line and rail-slot flip after a drag,
server-switcher and Settings server-row swap glyphs (90° quarter-turn), page slides stilled;
Preferences segmented/stepper/address/shortcut/hook controls and error
lines; Settings history arrow, list rise, row flip, error box, eye/share/
history buttons; the sysvitals first reading; ConfirmDialog scrim + sheet
rise (`sheet-up` joined the vocabulary) + desktop fade; Select chevron;
SideHandle opacity reveal; InstallPrompt on `--t-move`; Lightbox settle on
`moveMs()`; `.m-acts button` and `.chip-btn` filter transitions.

**Wave 6 — popovers grow from their anchor** (#86): ContextMenu, Select,
PanePicker, the Hub agent menu, the server menu and the hover card wear
`.pop-layer`; the composer's recipient and command menus and any remaining
`opacity: 0 → .ready` gate join them.

**Wave 7 — the highlight travels** (#86): desktop rail (vertical bar),
Preferences segmented controls and the Board status slider
(pill), Files/Git tabs ✓, the Hub drawer's view toggle; 2026-09-23 the Hub
agent strip's lit tab enclosure (`.slide-pill.tab`, fill + edge + feet,
gliding between a card, a team and All — hub-composer.md), and the open
project row of the Chat, Terminal and Board sidebars (`.slide-pill.soft`,
the accent wash gliding to the picked row — hub-feed.md). Done 2026-09-04 in
the terminal/Sessions/Files/Projects/Team pass: GitPanel's Status/Log tabs
and TeamTemplates' template list (both `.slide-pill`). Skipped on purpose:
the Terminal chip strip (scrolling AgentChips), the Sessions MRU chips and
the Team header toggles — none is a segmented control. RETIRED 2026-09-05:
the phone tab bar's wash (`.slide-pill.inset`) — the tab bar selects by ink
alone (§1.14's exception).

**Wave 8 — loads unfold** (#86): Hub room switch (skeleton bubbles + cards
after 150ms for an uncached room, then `.reveal-tail` on the feed and
`.reveal` on the roster), Board columns, Sessions list ✓, Files listing (the
dim-then-reveal) ✓, Projects cards ✓, Agents list, Settings categories on
first paint. Done 2026-09-04: Sessions (four `.skel` rows in a `.skel-wrap`,
then `.reveal` on the first fill), Files (board #93 three times: first the
tap-time slide + answer-time unfold read as two detached beats — a flash —
so the entrance is now ONE beat at answer time: `pendingSlide` records the
direction and the drill slide starts WITH the unfold when the directory
lands; `.reveal` still drops after `revealMs()`; round three, 2026-09-08,
the same beat for FILE opens — the tap-time `navAnim('fwd')` replayed the
drill over the STILL-VISIBLE list before the preview landed ("打开新的文件，
看到的是当前的目录文件动画加载了一遍，然后又才打开文件"), so `openEntry`
records `pendingViewSlide` and `enterView()` fires it exactly when the view
swaps to the answer; instant swaps like preview→editor keep their tap-time
slide — they happen in the same frame), DirPicker (one-shot
`reveal` on the first answer only),
Projects (first fill), the Team roster strip (once per room, dropped after
the stagger so joiners still pop) and TeamTemplates' list on open.

**Wave 9 — hover explains** (#86): agent cards (state, model, context,
last activity, cwd), sidebar project rows (path, agents, last message),
rail icons and tab bar (name + shortcut), sessions and panes (command, size,
last activity) ✓, file rows (size, modified, kind) ✓, board cards (reporter,
assignee, updated), settings rows where the label is terse. Native `title`
is removed wherever the card takes over; `aria-label` stays. Done
2026-09-04: session and pane rows, Terminal window chips (on the `.win-chip`
wrapper) and its to-tail note, file rows / breadcrumbs / bookmarks / recent
files / git status rows (`files/git-status.ts` puts the porcelain code in
words), project cards (path, "n live · n stopped", state, age) and Team
roster chips (state, role, backend, model, room) — every card through the
row's EXISTING formatter. AgentChip accepts `title={null}` ("no native
title"), which the Terminal chip passes so the card is not doubled.

**Landed 2026-09-04, shell / Settings / ui pass** (App, Preferences,
SystemStatus, ui): wave 6 — the server menu wears `.pop-layer` (done in the
foundation commit, verified); wave 7 — the phone tab bar's bar, the rail's
vertical bar (hidden during an icon drag, re-measured on release — the
action now measures by client rects ÷ `uiZoom()` and re-reads after the move
tempo, `boxFromRects` pure + tested), and every Preferences segmented row
through the new `ui/Segmented` (the pill); wave 8 — the Settings category
list on first paint and the keyed `.pref-content` on a category switch;
wave 9 — rail icons (name + live shortcut), the server switcher (server,
address, state), the gear, the split toggle, Settings category rows (one
`settings*Hint` line each) and address rows (address + state), the vitals
corner (`sysDetail`: full CPU/memory/disk numbers + poll tempo). Not done
here, with reasons: the tab bar gets no hover card (touch-only, no hover);
address rows show no "last used" (no timestamp is stored for an address);
the vitals card has no load average / uptime (not on the `system_status`
wire); the server menu's rows do not `.reveal` (a popover already grows).
Settings has no `.git-tabs`-like tab row — its categories are `.side-row`s.

**Deliberately not done**: `body` and the scrollbar thumb keep their `0.3s`
theme cross-fade (app.css) — that is the THEME changing under every pixel at
once, a whole-screen event with no token of its own, and moving it to
`--t-move` would make a theme switch read as a flash; composer height
(JS-measured per keystroke); fold
bodies and tool-lane bodies via slide (principle 10); desktop sidebar /
rail content swaps (owner rule); PanePicker / Select / ContextMenu / agent
menu open (popover rule — the two that fade on `.ready` are tolerated as the
"invisible until measured" guard, not as a precedent); Team's `swapSides`
remount (a layout bug, not a motion gap — belongs to a Team fix); button
sizes (owner declined).

## Rules and their reasons

- **The turn rail is an outro exception (board #465, 2026-10-24).** Principle 5
  says leave with a cut, because an outro keeps a dead element in flow while
  what is under it has moved. The rail is an absolutely positioned overlay
  that holds no flow and has nothing under it that takes its place, so that
  reason does not apply, and the owner asked for it by name: "出现和隐藏要有
  流畅的动画交互" (a cut at the edge of a scroll reads as flicker). The
  deviation is limited to that case: an overlay that holds no flow, one
  transition (opacity + a 6px `translateX`, `--t-move`, ease-out, in both
  directions, on an inner paint layer, never on a layer that is measured),
  and nothing waits for it to end. It is one more named exception beside the
  desktop Hub partition's animated open AND close (#174, principles 5 and 8),
  which stays exactly as it was; a list item and a popover still leave with
  a cut. **Its dwell is 1500ms, one token
  (`--turn-rail-dwell`, app.css).** The rail is a TARGET, not a readout: the
  reader who sees it appear must bring a thumb to the right edge before it
  leaves, so it outlives the scroll by more than `scrollFade`'s 700ms (a
  scrollbar thumb, which is only looked at). Precedent for the figure, not a
  standard: androidx `FastScroller` hides its handle 1500ms after it was last
  shown (1200ms after a drag, 500ms to fade; androidx-main, read 2026-10-24).
  The dwell counts from the END of the last activity (a scroll, or a probe,
  focus or mouse hold), so a long hold gets the full 1500ms afterwards.

- **Completion lifetime is not an animation or a transport timer** (#167
  batch 2, 2026-09-12): one 1500ms completion scheduler replaces private
  Copied/short-success expiries. Errors, progress and actionable Open/Close
  results do not expire. The Files 1.2-second in/out flash is retired; callers
  may retain the existing intro atom, and anchored copy errors use `.pop-layer`
  readiness. There is no layout animation or eased progress percentage.
  Indeterminate progress uses the one spin keyframe and stops spinning under
  reduced motion. Download retry/watchdog and keyboard-grace timers are
  different jobs and remain unchanged.
- **Confirmation failure is state, not a timed notification** (#167,
  2026-09-12): a caller's error remains inside the existing confirmation
  until retry or dismissal. It appears without a new animation or timer;
  the existing desktop fade, touch sheet, pending spinner and reduced-motion
  contracts are unchanged. Process-stop and delete glyphs differ by caller
  intent, not motion or a new button family.
- **Signature allocation does not animate layout** (#186, 2026-09-12):
  the owner's 15:39 correction restores a measured native-text mirror, not
  the retired send-arm controls or hardcoded avoidance zone. Full-width text
  shares its final clear rectangle with All/Attach/Send; a real collision or
  scroll ceiling reserves a bottom action band. Input/font/width changes
  reuse the same synchronous height transaction and existing notification,
  with no timer, new tempo or animated padding.
- **Inline composer growth is layout, not animation** (#180, 2026-09-12):
  All/Attach/Send share the textarea's row and stay bottom-aligned. Natural
  textarea measurement drives the existing shell-height notification;
  neither width nor height is animated. The no-mirror layout is superseded
  by #186 above; All uses
  the existing command pressed feedback and Hub ContextMenu `.pop-layer`;
  there is no resident All Stop or second popup/history mechanism.

- **Capacity rings use fixed geometry and discrete colour** (#180, 2026-09-12):
  the owner's 14:26 correction supersedes the edge-bar width/colour tween.
  Equal avatar rings show the reported fraction without an intermediate
  hue animation; `ctxColor` owns four thresholds. Hover never changes card
  width: hidden action slots are removed, busy Stop is resident and Watch
  stays in ContextMenu. The existing keyed `flip` recency move and its
  input-held order remain; expanded wrapping stays inside the existing
  reading transaction, with no animated layout.

- **Chat commands adopt state feedback without new motion** (2026-09-12,
  #166): header, Drawer and bubble tools use the existing CommandButton
  paint transitions, focus and reduced-motion rules. Raw selected state is
  controlled by the displayed source view. Copy changes its glyph to a
  check without changing its target width. The existing absolute `.m-acts`
  intro stays `.appear`; no layout animation, delayed click, new listener
  or replacement reading transaction is added. Window choices keep
  `.state-ctl`; terminal reveal/visibility/keyed lifetime and `.to-tail`
  retain their separate existing owners.

- **Dense Files tools do not animate their packing** (2026-09-11, #164):
  measured trailing overflow replaces toolbar wrapping; the shared command
  paint may be smaller, but the native 28/44px targets stay fixed. Menus still
  use `.pop-layer` after border-box measurement and the existing dismissal
  set; no layout animation, second popover tempo or history listener is added.
  The owner's size/row correction is quoted in file-handling.md.
- **Compact Settings keeps the same accepted-category motion** (2026-09-10,
  #162): the row budget and spacing change in the shared CSS owner. The
  existing accepted category, drill slide and answer-time reveal remain
  untouched; compact metrics do not introduce a resize animation. A pending
  Agent exit retains the Agent view's metrics until its existing guard
  commits the category change. This implements the owner's compact choice
  recorded in design-language.md, not another navigation or font mechanism.
  Segmented's equal grid tracks supply intrinsic sizing for the narrow-row
  fallback; the same indicator action still owns the moving selection.
- **Compact entity forms keep their existing drill and member disclosure**
  (2026-09-11, #163): the page opts into shared field metrics and removes
  only the avatar's decorative frame. The owner's compact choice and
  circular-avatar correction are recorded in design-language.md. No
  layout animation, timer, listener or alternative easing is added; the
  existing draft guard still commits navigation, and the shared Select
  remains viewport-anchored. Textarea sizing is layout, not moving paint.
- **Roster density changes paint, not interaction timing** (2026-09-12,
  #176): card paint takes the shared command inset; its hover/selection
  transition stays `--t-fast` and its existing context fill stays `--t-move`.
  Reduced motion stills both. Measured horizontal edge cues follow native
  scrolling without a timer, animated overlay or new scroll engine; fitting
  and expanded lists have no mask. Keyed recency motion, input-held ordering
  and the parent reading-anchor transaction remain unchanged.
- **Popup paint has one owner without merging interaction roles** (2026-09-12,
  #165): shared menu frames/rows replace the ContextMenu/Select private
  recipes; richer pickers and tooltips share only frame paint. `.pop-layer`
  still owns measured readiness and origin, and row feedback uses `--t-fast`
  with a reduced-motion rule. No private opacity gate, layout animation or
  delayed style correction is added. Intrinsic width is resolved before
  placement instead of repairing a width/position loop with another frame.
- **A picker edit is not a delayed click** (2026-09-12, #165). Server choice
  runs immediately and rename has an explicit command. Existing popup
  readiness/origin still govern the dialog. While its name input owns the
  keyboard, a viewport resize remeasures the same anchor without dismissing
  the edit; this is layout, not a new motion or timer. Other resize/outside
  dismissal and guarded focus return keep their existing owners.
- **Compact controls change paint, not motion or hit geometry** (2026-09-10,
  #160/#161): the owner's 14:19/14:58 words are recorded verbatim in
  [design-language.md](design-language.md#compact-paint-does-not-shrink-the-input-target-2026-09-10-160161).
  Commands paint inside their stable native target with the same `--t-fast`
  feedback and unchanged solid hover/press composites; the pseudo-element
  never intercepts input. Reduced motion stills its paint transition.
  Segmented uses the existing `.slide-pill` and `slideIndicator`, with one
  compact paint modifier in `app.css`, not another marker/action or an
  independently animated option. No control resize animation, timer or listener.
- **File tools update state inside stable boxes** (2026-09-10, #157): Files
  uses the shared CommandButton paint and loading rotation. The bookmark star
  changes glyph and pressed state without its former private pop animation.
  Toolbar wrapping and list/preview width changes are layout, not animated
  geometry. The existing file-view drill and transfer feedback remain unchanged.
- **Share rotation geometry and tokenize feedback paint** (2026-09-10, #155
  review, #156): CommandButton and Composer reference the one `spin` keyframe
  in `app.css`, retaining their semantic 0.6s loading / 2.2s open-turn tempos
  and local reduced-motion guards. Their identical private keyframes drifted
  from the shared-atom rule. CommandButton overlays use `color-mix(in srgb, ...)`
  over `--control-overlay-light` / `--control-overlay-dark`, preserving the
  original 4% white hover / 6% black press composites and contrast. Other
  legacy rotation consumers are outside this scoped migration.
- **One vocabulary in app.css, components add a class** — five components had
  five private spinners, Hub had a private caret transition, and the compact
  drill pair was declared in five components; a second copy is a second tempo
  waiting to drift. A component references a global keyframe BY NAME (Svelte
  scopes only keyframes declared locally), so `ui/motion.source.test.ts`
  forbids a component-level `.chev`/`.flip` rule and any local declaration of
  `fade-in`/`rise-in`/`pop-in`/`sheet-up`/`drill-in-*`. `.to-tail` carries its
  own `pop-in` in app.css, so wearers add nothing.
- **No `svelte/transition`** — the codebase was CSS-only before this doc;
  outros conflict with principle 5 and with the feed's scroll ownership; a
  Svelte intro on a keyed list replays for every row on a parent recreate
  unless guarded. The one Svelte directive allowed is `animate:flip`, because
  CSS cannot animate a reorder, and its duration must come from `moveMs()`.
- **Intro keyframes animate transform/opacity only** — pinned by the test;
  the reasons are principles 3, 9 and 10.
- **Every loop stills under reduced motion** — the test walks every
  component for `infinite` and requires a `prefers-reduced-motion` rule in
  the same file.
- **The tokens have a JS mirror** — `T_FAST_MS`/`T_MOVE_MS` in `ui/motion.ts`
  are asserted equal to `--t-fast`/`--t-move` so a token change cannot leave
  `animate:flip` on the old tempo.
