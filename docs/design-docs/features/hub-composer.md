# Hub — the composer

Who a message goes to, the agent strip, `/commands`, readline editing and
per-agent interruption. The feed is `hub-feed.md`.

## Rules and their reasons

### The feed follows its own size; the composer notifies nothing (board #467, 2026-10-25)

Whatever changes the composer's height (the input row, the reply chip, an attachment, a chip row wrapping, a thumbnail's size landing) changes the feed's box: the composer is a `flex: none` sibling under the `flex: 1` feed in the same column. The feed's own ResizeObserver runs the reading transaction for every reading-size change, so a follower re-takes the tail and a reader keeps their row, in the frame's resize-observer step, which runs before that frame paints. Hub used to get a second signal, `onheightchange` from a ResizeObserver on the composer shell (#466), which called `scrollFeed(true)` for a follower. Its write came one `requestAnimationFrame` later, on a feed already at its tail. It was deleted whole: the shell observer, the prop, Hub's handler and their pins.

Measured before deleting it (Chromium 153; a 60-message room on a scratch gateway; 390px with mouse and with touch, and 1280px). There were 28 triggers per run: typing three lines and clearing, the reply chip on and off, an image and a text attachment on and off (the attach flow; the rig did not record a decoded thumbnail or a separate size change, so a late thumbnail size is not shown to be covered), six attachments added and removed one by one across the chip-row wraps (the shell going 34 → 318px at 390), a viewport shrink to 0.6× and back, and the same as a reader mid-room. The rig sampled the feed's GEOMETRY, the bottom gap or the reader's reference-row offset, after every frame (a `requestAnimationFrame`, then a task), against a baseline taken before the trigger. These are layout readings, not captured pixels; no trace or screenshot was taken. With the notification removed, no sampled frame drifted in any row, identical to main. A control build whose Feed observer did NOT re-take the tail for a follower showed 41–46px of drift for a frame or more when typing or attaching, and 338px on the viewport shrink, never recovered. So the sampling can see drift, and the Feed's observer is the only thing holding the tail. `Feed.mount.test.ts` pins it: a follower whose feed box shrinks is put back at the tail by the feed's own observer, and an unchanged size writes nothing. It fails on that control. `Composer.source.test.ts` and `Hub.source.test.ts` pin the notification's absence.

### Focusing the composer is not navigation (board #303, 2026-10-03)

Tapping or clicking the input leaves the feed where it is. The owner reads an
earlier reply while typing the answer to it (2026-10-03: "要保持在我当时浏览的
消息位置不变……需要一边看一边回复"), and the old `onfocus` set `following` and
scrolled to the tail twice (immediately and after 300 ms), so the reader was
pulled away exactly when they needed the message on screen. Composer therefore
has no focus intent at all. The tail is still taken by the paths that mean it:
sending forces `scrollFeed(true)`; a reader who is already `following` keeps the
tail when the keyboard shrinks the viewport (Feed's `keyboard-shift` listener)
or the composer grows (the feed's own ResizeObserver, below); a reader in
history keeps their row through the same ResizeObserver reading anchor. `Hub.source.test.ts` and
`Composer.source.test.ts` pin the absence of the handler; `Hub.mount.test.ts`
focuses the input at `scrollTop` 330 and asserts it stays there with `.to-tail`
visible (fails on the old handler).

### Header path copy reports its actual result (#167 batch 2, 2026-09-12)

The desktop path stays selectable prose; double-click still copies its full,
untruncated value with the existing text-selection handling. Feedback follows the
clipboard result: only `copyText=true` shows Copied, through the shared
completion lifetime. A failed write now shows a retryable local error; previously
the result was ignored. A room/path/visibility change or unmount invalidates
the pending attempt, even when two rooms share the same path.
The same feedback presentation and placement action anchor to the path; this
adds no button to the header, notification transport or copy parser.

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Confirmed actions retain their outcome (#167, 2026-09-12)

Response interruption remains immediate and amber. Process Stop/Close stays
behind the single danger confirmation, with an explicit stop glyph; removal,
archive-as-delete and purge use trash. The confirmation captures its project
ID, session and agent at request time. Pending Back is consumed by that
confirmation rather than falling through to the drawer/sidebar; this
deliberately replaces the old fallthrough assertion in `hub-back.test.ts`.

Failure stays in that dialog and retries the same intent. Project deletion
is still close then archive, not purge; a completed close is recorded on the
intent so an archive retry cannot close a newly resumed session again. A
failed step is named instead of swallowed. Purge keeps its own pending guard
and captured row. Success closes only its own confirmation, and room
generation checks prevent late success from navigating a newer view.

A successful mutation followed by a failed read is not a failed mutation.
The existing read functions can report an explicit action refresh failure
without changing silent background polling. That error uses the shared text
role and a read-only Refresh command in the chat pane, never another Delete
or Stop confirmation. A retry keeps that error and its disabled/pending
Refresh command visible until the read succeeds. There is no success toast,
timer or notification.
Real-Hub mounted regressions cover rejection/retry, duplicate activation,
pending Back, partial close/archive completion and refresh-only retry.
Review also caught a race exposed by separating mutation from refresh: a
second successful action could lose its refresh behind `actionRefreshing`,
then an older snapshot could restore obsolete cards. Each completed mutation
now starts its own read; project/roster snapshots and refresh feedback publish
only for their current request identity. A manual retry still cannot repeat
while pending. Ordered promises pin newer results arriving before older ones.
This adds no queue, timer or mutation replay.

### Controls are the paragraph's signature (#186, 2026-09-12)

Owner, 15:39, verbatim:
> 还是有一些问题，agent 卡片和展开按钮不在上下居中的线上。点击 everyone 图标，应该上方展示好像所有 agent 都被选中了一样。还有文字消息，应该能存在于按钮的上方，不是完全左右分列的，就应该像是发送这几个按钮是文字段落的最后一行的右对齐的落款一样。

The native textarea takes the full input width. All/Attach/Send remain the
same shared commands, positioned at its bottom-right. A real DOM measurement
mirror copies the textarea's computed font, spacing, wrapping and padding;
text is assigned as a text node, never HTML. Native Range line rectangles
are made local to that mirror with CSS zoom removed. This is text-layout
measurement, not viewport/popover positioning or character-count estimation.
The mirror is clipped to zero layout height, invisible, non-interactive and
ARIA-hidden; it cannot add scrollable space and is removed on unmount.

`signatureLayout` in hub-composer.ts owns the allocation decision from those
measured boxes and the actual command cluster dimensions. If the bottom-right
command rectangle is clear, it shares the last line. A real intersection
reserves one command-height band below the textarea. What collides is INK
with PAINT (board #203, owner 2026-09-17: "到了第二行 这 3 个按钮好像就被撑到下一行了
中间多出了空白的一行"): a line's rectangle carries its half-leading
(`inkInset` = (line-height − font-size) / 2) and a command's hit box extends
`--control-paint-inset` beyond what it paints. Measured at 1440: a 28px pointer
command beside 20.25px lines dipped 2px of hit box into the preceding line's
leading — nothing visible touched — and every two-line draft with a full
first line reserved a 28px band; now `reserved` is 0 there, still 28 when the
last line runs under the commands (right 1101 > 1068). A 44px touch command's
paint (inset 6) does reach the preceding line's ink, so the phone keeps its
band — the #186 rule that a tall touch target can hit a long preceding line
even when the last line is short still holds, measured against paint. **The
commands stand centred on the field's single-line height, not glued to its
bottom** (board #229, owner 2026-09-21: "消息发送按钮在详细框里行没有上下居中对齐"):
after #228 the phone's group is 32px inside a 44px line, and at `bottom: 0` it
sat 6px low. `.compose-line` captures `--composer-line-h: var(--control-height)`
before the dense group redefines the token, `.composer-actions` takes
`bottom: calc((line − control) / 2)` (6px on the phone, 0 on the desktop's
28-in-28), and `growComposer` reads that `bottom` back as `lift` so
`signatureLayout` moves the collision box AND the reserved band up by the same
amount (`reserved = controlsHeight + lift`, 38 on the phone). Measured at
390: controls 746–778 in a 740–784 field (centre delta 0); a short last line
shares the row; a last line under the commands reserves 38px. **One measurement per pending frame, never in the input handler** (board #444): the text effect, a font completion and the ResizeObserver each call `requestGrow`, which schedules `growComposer` in the next animation frame; the triggers that come before that frame share it. The input handler measures nothing; it used to run the transaction once there and again from the text effect, each a forced layout. The measurement still lays out once in its frame (the #444 profile: growComposer 726-757 ms per 12 s of typing at 6x, from 1194-1262), and a ResizeObserver or font trigger lands in the frame after the one it was noticed in. The geometry is the same as before (390 px, empty / one line / wrapped / past the ceiling, read back on the #444 rig). **The row is a relayout boundary, written only on a change** (board #466; owner 2026-10-25: "我现在感觉打字又变得特别卡了，尤其是上方有很多消息的时候"): the feed was not re-rendered per key (the five counted functions — Hub's blocks, askTurns, renderMarkdown, markMentions, markIssueRefs — made 0 calls per key on main, before the turn rail and after #444), it was re-LAID-OUT — growComposer wrote the row's own style (a minHeight pin set and cleared, the reserved band reset and restored) and the textarea's, then read geometry, about 4 forced layouts per key, each from the document root, so their cost was the whole document's: 1123–1276 ms of layout over 30 keys at 6x with 320 messages loaded, 224–258 ms with 20 (Chromium 153, 390 px; keydown → second rAF, a latency proxy, p50 69–75 ms vs 34–37 ms). Now `.compose-line` has `contain: size layout` (not paint: the focus ring, the commands and the mirror must not clip) and an explicit height — the field's used height (its own clamp in CSS order, max first and then min, so min wins when they cross, CSS2 §10.7; fractional) plus the reserved band, counted once — that holds the space while the textarea measures inside it (so #180's transient expansion cannot happen, without a pin) and is written only when it changes; the row's own writes are skipped when the value is equal (the textarea's and the mirror's measuring writes stay inside the boundary). No measurement reads the shell back, and the composer notifies nobody of its height (board #467, below). `Hub.mount.test.ts` pins it in a 120-message room: a keystroke mutates nothing outside the row and writes no row style (it proves the DOM did not change, not that no effect re-ran). Same rig after: 71–75 ms of layout with 320 messages, 45–53 with 20; the proxy p50 35 ms vs 28 ms: the per-key cost's dependence on the room is much weaker. Typing across two wraps (90 keys): 3931–4103 → 818–885 ms of layout; the wrap keys themselves still cost a feed relayout (the feed's viewport really changes), as before. The geometry rows (empty, one line, short and long last line, three lines, the ceiling, cleared, a 0.6× viewport and back) read identical to main with a fine pointer at 390 and 1280 and at 390 with UI zoom 1.3, and with a COARSE pointer at 390 (Chromium touch emulation and the pointer/hover media features; `any-pointer: coarse` matched, the field's min-height 44px) with and without zoom, including a 150px-high squeeze where the field's max-height (42px, 32.3px zoomed) falls under its 44px min-height — the textarea keeps 44px and the row matches it (the zoomed run differs from main by 0.1px in one row, sub-pixel rounding). A reply chip and an attachment change the shell with the row unchanged; the feed stays at its tail in each, with both pointers. Not measured: a real Android WebView or IME. `field-sizing: content` does not replace it: it sizes the height only, not the signature band, and the macOS WKWebView follows the OS's Safari, which has it only from 26.2. At the scroll ceiling the commands keep their own bottom band outside
the scrolling text; no typed line loses a permanent right column. Only an
empty placeholder gives width to the controls, and the empty field stays
one native control high.

The shell wears an input's radius (`--ui-radius-control`) and the row content
inset (`--menu-item-padding-x`) since #203: its 16px radius on a 32px desktop
shell was a full semicircle and the first glyph, 6px from the border, read as
squeezed into it (owner: "尤其是文字在靠近边缘的位置 感觉被挤到了半圆里面一样"); the
50px phone shell had read as a rounded rectangle all along. Since board #236
(round 3) the composer paints the BAND: a full-width fill under the tab strip,
the same fill the lit tab wears — the owner's Chrome screenshot: the active tab
and the toolbar are one colour, the omnibox its own field inside ("底下的框是一
个单独的一个输入框 但上面整体上你有这种tab 的这种样"). Round 5 made that fill the
agent bubble's (`--bubble-in`/`--bubble-line`); round 3's `--surface` is gone.
The shell itself stays a complete bordered field. `--composer-inset` is the
BAND's inline inset, which the strip consumes on its RIGHT only: since #237 the
strip has no leading inset beyond its 2px scrollport padding, so the first tab
starts at the column's edge the way a Chrome tab strip meets the window, while
the field keeps its inset — the lit tab's left edge no longer has to meet the
field's.

This explicitly reverses the #168/#180 no-mirror/side-column layout rule:
the mirror was unnecessary for a separate row, but is necessary for the
owner's signature layout. The old hardcoded SEND_ZONE, inline recipient
popup and send/interrupt arming are not restored. Existing width/height
observation (including changes to the command cluster alone), native input
events, font-preference changes, initial font readiness and subsequent
font-load completion all call the same growth owner. The font listener is
removed on unmount. Measurement retains #180's
synchronous row-height hold; the parent is not notified of the height at all
(board #467, below). No value/caret rewriting, timer or layout animation
is added; draft, paste, IME, menu and transport owners are unchanged.

Verification: Chromium 152.0.7977.64 with the real Hub and isolated RPC
fixtures covers desktop, 390px coarse, 360px and wide-touch layouts, both
themes, reduced motion, long/short final lines, the preceding-line collision,
scroll ceilings, width/height changes and native CDP composition. The layout
matrix passes 810 checks, reduced motion 250, and deliberate missing-band/
wrong-font negative controls 41. A final source-hash-matched build passes
29 focused checks including command-only resize and font-completion wiring;
removing the font listener breaks parity, restoring it restores parity.
Unit vectors pin allocation; the real Hub mount pins late font events and
unmount cleanup. This is not an Android OS-IME acceptance pass.

The final global-font comparison also reproduced a pre-existing Feed issue,
recorded separately as #189: changing the UI font to DejaVu Sans Mono leaves
a 457px tail gap on the 390px fixture in both main `23e090fb` and #186,
while desktop remains at zero. It is not repaired by the composer change.

### Expanding exists only when the row overflows (board #266, 2026-09-28)

Owner, 13:44 (phone, LingTing, one agent): "为什么这个agent卡片 下边缘的圆角给反了，
其他会话我看到是正常的". The tab geometry was right. That room's roster had been
EXPANDED once on the device, and the wrapped list closes a lit card as a
rounded box with no feet — correct for a list, but with one agent the list is
one row and reads as the strip with its feet turned inside out. Orchestrator
ruling 13:59: expanding is only meaningful when the single row overflows.
`Roster` renders `expanded = expandPref && overflowing`: a room whose cards
all fit gets no chevron and keeps the strip's lit tab, whatever the remembered
preference says; the preference is kept and applies again once the row
overflows. `overflowing` is measured by the strip's one observer
(`ui/scroll-edges.ts` `rowOverflows`), always in the SINGLE-ROW form: while
wrapped, the `expanded` class is lifted, the row read and the class restored
in one synchronous block, so no frame paints the probe; the list's `%`
figures are hidden outside the wrapped form so the probe reads exactly the
strip. The chevron's grid column stays reserved when it is not offered: with
the column collapsing, a room between the two widths (574 vs 602px on desktop
at 900px) stayed whichever way it had arrived. Measured on the live server
in Chromium (agent-browser), 390px dark and 1440px light: LingTing with the
pref set draws the one-path tab with feet and no chevron; tmux-mobile at
390px still wraps under the pref; a 1440 → 380 → 1440 viewport sweep gives the
same answer at each width in both directions.

### One roster centre line (#186, 2026-09-12)

Owner, 15:39: "agent 卡片和展开按钮不在上下居中的线上。"
The disclosure wrapper now matches the card's painted height plus its
vertical inset and the scrollport's two 2px insets. Its native button is
centred inside that wrapper; the cards and Add align on their row centre.
There is no new size token or glyph offset. The wrapper remains bottom-aligned
when the list expands upward, keeping collapse at the same reachable position.
Chromium 152.0.7977.64 measured the old disclosure 3px below the card centre
on desktop and 1px below on 390px coarse input, in both themes. Both offsets
are now zero; restoring the old wrapper CSS reproduces the mismatch.

### The destination strip is a tab strip (board #236, 2026-09-22)

Owner: "Agent 卡片标题：能不能做成类似 Chrome tab 栏的样式？选中哪一个，哪一个
就是亮的，其他在旁边" — and on the pre-#236 look: "现在太多都是通过颜色块加选
择线框的形式了". The cards' wash + accent ring said "selected" with a colour
block and an outline; the tab says it with SHAPE and continuity: the lit
tab and the composer shell are one surface (the normative idiom lives in
design-language.md § paint species — rest bare, hover `--surface2`,
selected `--bubble-in` + `--border`, bottom open onto the shell in the
single-row strip; the wrapped expanded list keeps a closed rounded box,
a list is not a tab bar). The strip's bottom scrollport inset went to the
tab (it must reach the floor), so the disclosure wrapper height carries
`+ 2px`, not `+ 4px`. Status dots, context rings, unread marks, @ marks,
the dashed filter ring and the Stop-on-dot all survive unchanged — they
are function, not the retired chrome.

Three review rounds, same day (owner: "整体看起来比较生硬" → the Chrome
screenshot) and a fourth for contrast. Round 2 fixed the snap (the tab paint
transitions on `--t-move` ease — switching destination is the selection
MOVING, so it crossfades and reshapes; reduced-motion still disables it) and
patched the 1px seam with a z-index. Round 3 replaced the mechanism: the
outline + hairline model left
"一堆缺口" — a gap in the line under every lit tab, worst under All where
every tab is lit — because it said "attached" with LINES. The owner's
screenshot says Chrome does it with COLOUR: the lit tab and the composer
band share one fill, no borders, no hairline, and the input
stays its own complete field inside the band.

Round 4 gave that colour enough contrast to READ (owner: "选中和没有选中的
这些 agent card 的显示差异更明显一点…深色和浅色模式下都要考虑好"): a 3%
`--surface` wash on both the strip and the band left barely any step, so the
two fills became per-theme OPAQUE tokens in app.css. Opaque on purpose: the
lit tab and the band must be the SAME colour over different backdrops, which
a translucent wash cannot promise. The inactive tab's LABEL dims to
`--text2` as well — two signals for one state, as Chrome does — while avatar,
status dot and context ring keep their colours: those are live facts, not
chrome.

Round 5 put the step on the other side and joined the whole tray to the
conversation's own palette (owner, same evening): the lit tab and band wear
the AGENT BUBBLE's paint — `--bubble-in` fill, `--bubble-line` edge ("和
Agent 返回给我的消息框的亮度色彩差不多就可以…整体加一个稍微淡白色的边") — and
the contrast is the FRAME going darker beneath (`--hub-tab-frame`: dark
`#06060a`, light `#e2e2e8`), not a brighter tab ("会不会有点过亮了？…把其他
地方变得更暗的方式来解决呢"). `--hub-tab-band` is deleted: there is one
bubble paint, and a second token for the same colour would drift from it.
The enclosure closes without a seam because the lit tab's fill overlaps the
band's top edge by 1px — same colour, so the outline simply breaks where the
tab joins.

**Multi-select is ONE enclosure** ("如果是选择多个 Agent，就用一个大的包边。
注意 Agent 和 Agent 之间的卡片不要有很多线拐来拐去"): under All — and while
the All tab PREVIEWS it — `.tabs.all-lit` makes the DESTINATIONS GROUP the
lit tab (one fill, one edge, its join over the floor line) and
switches every card's own paint off. No border logic between siblings exists
to zigzag, and the per-card `preview` class is gone with it: hovering All
shows exactly the shape clicking produces.

Round 6 fixed what the first enclosure got wrong (owner, same evening). The
group is `.tabs` — the All tab plus the live agents — and it is sized to its
CONTENT, so the enclosure ends after the last agent instead of framing the
`+`, the stopped identities and the empty row behind them ("上面框的这个区域
有点过分大了…不要把加号后面的这些区域也都框出来"); naming that group is also
honest, since those siblings are not destinations. **`.tabs` carries
`flex: none` in the single-row strip**, and that is load-bearing: as a
shrinkable item of the scrolling `.cards` it absorbed every bit of negative
space once the tabs overflowed while its own `flex: none` cards did not, so
the cards spilled out of the group and the stopped cards and the `+` drew ON
TOP of them (review caught it before merge; Chromium at 300px with four 90px
tabs: group right 198 vs. last tab right 368, stopped card left 200). The
wrapped list is the opposite case and keeps `flex: 0 1 auto; min-width: 0`,
where the group shrinks to the container and wraps inside itself. Measured on
the phone at 390px with five destinations: group right 469 = last tab right
469, the `+` at 471, the strip scrolling as before.

**Superseded 2026-09-24 — the phone strip matches the desktop.** Measured on a
390px touch profile: row 44 → 36, All/+/disclosure 44×44 → 36×36, paint inset
6 → 2, the 32px paint unchanged; the compact `padding-block-start` shove on
the tab and All contents and the compact marker inset are deleted, since the
desktop inset needs neither. The owner's call ("手机对齐一下桌面…比桌面预留的还
要大…预留的都要宽") overrides the 44px floor here, as `.compact-tools` already
does for the dense tool groups; targets stay 36px on both axes.

**The phone card is at the touch floor; surplus row air can still shrink**
(owner, 2026-09-23: "tab 栏可以高度稍低一些…agent 卡片和下边的消息框之间间距小一
点"). On coarse the card's minimum comes from `.agent-select`'s 44px target,
not from its paint. The first round reduced card paint but left a disclosure
surplus in the row; that surplus was removed only in the later correction.
What did come out first: the coarse `--roster-paint-height` 34px → 32px (the card's
`min-height` was 46px, now 44px = the touch floor exactly), the band's top
padding 6px → 3px, and the scrollport's top inset 2px → 1px — six pixels of air
between the cards and the field, none of it target. And the band's `border-top`
is gone: a full-width top edge drew a horizontal rule between the strip and
the input area ("Agent card 和下面这个区域中间分隔的横线不要有"), while the lit
tab above already closes that side of the enclosure and beside it the frame
steps straight into the band's colour. Measured in both themes, desktop 1280
and phone 390: single selection and All. A further reduction of the band's
top padding from 3px to 1px missed the owner's intent. The 2026-09-23
correction restores that 3px and takes the space from INSIDE the tab row:
the now-unneeded 1px scrollport top inset and 2px disclosure surplus go
away together (the old upper team marker is gone). The 44px touch target
remains; compact tab content moves 2px toward its open bottom via
`--ui-gap` top padding within the same hit box, reducing the visible gap
below the name without severing the selected tab from the band. Chromium
152 desktop: row 36px -> 34px, name still 9px above/below, field top 6px;
at 390px with coarse CSS simulated: row 46px -> 44px, text gaps
14/14px -> 16/12px, field top 1px -> 3px. Real phone not measured.
The owner's 08:55 correction found the remaining root cause: the compact
button's shifted content put the avatar centre 2px BELOW its context ring,
which was independently positioned against the card. The ring now lives in
`.avatar-slot` beside the image, sharing its centre by construction. Ring
and avatar shrink from 26/20px to 24/18px; their 1px gap and 2px stroke
remain. Compact content padding uses two existing `--ui-gap`s, taking 2px
more from the text's bottom gap without shrinking the 44px native target.
The selected tab's paint top inset shrinks from coarse 6px to `--roster-gap`
(2px), while desktop stays at 2px; the strip itself still has zero top
padding. Top corners move from `--ui-radius-control` to `--ui-radius-panel`
(10px -> 14px; reversed to `--ui-radius-row` 12px on 2026-09-23 17:19 — "半圆
半径变大了…稍微小一点显得更加精致", and 12px is the context ring's own
curvature), the team pill to `--ui-radius-row` (12px); the bottom stays
open into the band. Chromium 152 before/after: desktop ring/face 26/20px ->
24/18px, their centre difference 0 -> 0, row 34px and text bottom 9px
unchanged; 390px with coarse CSS simulated: 26/20px -> 24/18px, centre
difference 2px -> 0, text bottom 12px -> 10px, selected paint top 6px ->
2px, row and hit box both 44px. The meter role and exact percentage remain
in accessibility output. Real Android WebView remains to be checked.

### All selects the addressed cards (#186, 2026-09-12)

Owner, 15:39: "点击 everyone 图标，应该上方展示好像所有 agent 都被选中了一样。"
The existing All command remains the single broadcast entry; it now also
selects every managed card's paint and `aria-pressed` through one `isAddressed`
predicate. Stopped slots remain unselected. A named card click still calls
the existing recipient setter, narrowing All to that agent; no membership
store or new destination is added. Hover wording names the aggregate
destination while All is selected. Body mention marks and reading filters
retain their separate meanings.
The real Hub mount test pins All -> every managed card -> one named card;
the single-name-only predicate fails as a negative control. Chromium
152.0.7977.64 verifies the same paint/ARIA states in both layouts and themes.

### One input row and one All command (#180, 2026-09-12)

Historical layout: #186 above supersedes the side-by-side row and no-mirror
rule. The All command, guarded live menu and measurement safety rules remain.

Owner, 14:22, verbatim (the subsequent 14:26 correction replaces only the
card's capacity encoding):
> A 背景填充的方案。everyone 的按钮应该是一个圆形的小按钮在 加号 左边 ，加号还是按照原来在发送键左边的方案，一起发发送的消息在同一行，就是不额外把消息框撑高一行，发送按钮在同一行就行，停止按钮可以是选中 everyone 后再次点击，才显示菜单栏选项 stop

Textarea and All/Attach/Send share one normal-flow flex row, in that order.
The textarea grows in the remaining width; commands align with its bottom,
not a separate footer. Attachments retain their own rows below it. Use the
existing natural-height measurement and CSS ceiling, not the retired mirror
or overlapping corner controls. Height notification measures the whole
shell, including attachments. Its local ResizeObserver watches the available
chat column and fixed command group, not the textarea it resizes, and reuses
the same calculation when text width or the CSS height ceiling changes.
Chromium 152 exposed both mistakes: observing the textarea produced resize-
loop warnings; a height-only viewport shrink left a 145px draft clipped to
90px with `overflow:hidden`. A shrink now enables scrolling, and growth
releases the old ceiling without waiting for another keystroke.
Natural-height measurement also holds the existing input row's minimum
height synchronously until the textarea's final height is set. Otherwise
`height:auto` briefly shrinks a four-line draft by 61px, expands the Feed
and clamps its scrollTop during a width resize; restoring the textarea
then leaves a 61px tail gap. The row hold is removed in `finally` before
the shell-height notification. It is not a mirror, timer or Feed correction.

All is the PINNED TAB at the strip's head (board #236, owner, 2026-09-22:
"不用隐藏，我不展开就看不到吧…都显示全了" — supersedes #204's expanded-only
gate, whose reason was the 2026-09-17 "藏到展开列表里"): Chrome pins a tab as
an icon-only tab at the far left, and this is that — always in view,
collapsed strip included, wearing `bots` — a small CROWD of the same bot mark
a single agent's glyph uses (owner, 2026-09-22: "不用画人，画成 Agent 类似的
Logo"; 2026-09-23: "可以多画几个机器人"; the group-of-people and `collab`'s
orbiting dots both failed the glance test). It used the avatars' size
(`--roster-avatar-size`, the token). The side-by-side heads each read at about
7px at the atom's 16px size
and looked muddled even at 20px (owner, 2026-09-23). Three heads now recede
behind a single readable foreground face; the rear contours end at the front
head rather than crossing its strokes. When the avatar shrank from 20px to
18px, rendering three heads at 18px became soft; the leading tab now has
its own `--roster-all-icon-size` at 20px, independent of the gap between
tabs. Its fine-pointer box stays 24px (`20px` icon plus `2px` per
side), and the strip has no extra leading inset beyond its 2px scrollport
padding. The field
keeps its normal inset; the tab's paint need not start at
the text field's left edge. On coarse the 44px square remains the touch
target even though that necessarily keeps some space around the icon.
Chromium 152 headless, isolated Roster/Composer preview: 24px fine-pointer
button; narrow viewport with the coarse CSS values applied: 44px All and
agent targets, 1px from the band top to its input field. The browser's device
emulation did not report a coarse pointer, so this is not a native phone
measurement. The tab retains `pressed`, `hasPopup` and `expanded` for the
All menu, wired into `Roster`
(`allMenuOpen`, `onall`). The span is `.acard` so selected All is a LIT TAB
like any card's; the CommandButton inside is `bare` and its `engaged` wash
is switched off locally — the tab is the paint, a wash inside it would be a
colour block again; the accent ink remains as the pressed signal. Hovering
or focusing the tab PREVIEWS the choice (owner: "鼠标悬停…看到的就是所有的
Agent 被选中或者激活"): `allPreview` lights every live, not-yet-addressed
card with exactly the selected tab paint (`.acard.preview` shares the
`.acard.sel` rule); touch never previews — a finger has no hover. #180's
"never a card" holds: no `data-agent="all"`, no Stop, no meter. Selected
All still opens the All menu on a second activation; Send is the only
solid CTA.
First activation selects `ALL_TARGET`; another activation opens the existing
Hub ContextMenu. Constructive Record only comes first and clears All
directly; the amber interrupt command appears only while members are busy,
disabled during an in-flight interrupt. A NAMED card follows the same shape
since #196 (owner, 2026-09-13: "agent选中卡片时，再次点击不是取消选中，而且展开选项卡"):
a click selects it; a second click on the card that IS the recipient opens the
Hub agent menu anchored to the card (left-aligned, card kept clear) with
Record only leading in place of "Talk to" — that is how a card is deselected
now; a click on any other card, or under All, moves the recipient. The click
toggle (`recipient === name ? '' : name`) is gone. A long-press opens the same
menu at the card too (`ui/longpress`, design-language.md § menus); a mouse
right-click keeps the pointer. `Hub.mount.test.ts` walks select → second click
→ Record only; Chromium 390: the menu's left edge = the card's (113), a hold at
finger x=77 on a card at 12 opens at 12.

The menu captures its opening room in the existing context-menu record and
closes if that room or destination changes. Its items follow current
busy/pending state while open, rather than freezing the opening snapshot.
Dispatch checks room, destination and this menu instance before revalidating
busy membership through the existing interrupt function. It
does not kill processes or change the recipient. No new listener, Back stack
or popup owner is added. Double Ctrl+C still mirrors the interrupt offered
for the selected named card or All menu; record-only is a no-op. The Send,
staging, draft, IME and command-palette gates remain in their original owners.
Chromium 152.0.7977.64 measures a 34px pointer / 50px coarse empty shell,
with native 28/44px controls on the same line. Seven desktop/390px light/dark,
reduced-motion and 360px variants cover multiline text, attachments, width
changes and menu actions; separate height-only shrink/grow and real Feed
scroll checks pass without ResizeObserver errors. Disabling only the
temporary row hold restores the 61px tail gap; removing that override
returns to zero. Browser coverage uses controlled RPC and synthetic IME;
native WebView/IME and owner-client acceptance remain separate.

### Group verbs on All and on a team name (board #258, 2026-09-28)

Owner, 2026-09-28 03:08: "右键点击 所有 agent 按钮或者 team 名字，应该也有选项卡，比如可以一键重启全部，停止全部等等功能". Right-click (desktop) or long-press (phone) on the All tab, or on a team name, opens the ONE Hub ContextMenu with the group's verbs; All's click behaviour (#180: select, then a second click opens the menu) is unchanged, and right-click opens the same menu whether or not All is the destination.

- **All** (every managed agent in this room): `Record only` while All is the destination, else `Message everyone`; `Interrupt all` (only while any member is busy, disabled during an in-flight interrupt); `Restart all (N)`; `Start stopped (N)` (only when some are stopped); `Stop all (N)`.
- **A team name** (that team's members, nested sub-teams included): `Record only` / `Message team`, `Interrupt team`, `Restart team (N)`, `Start stopped (N)`, `Stop team (N)`, then `Configure team`, which opens the Teams editor on that team through the same device-aware entry as `Configure agent` (the Agents page on desktop, Settings → Teams on a phone). A stopped member belongs to a team by its launch recipe: `hub_agents` returns `stopped_teams` (window name → team path) for every agent home whose window is not live, since a stopped identity has no row of its own.
- **A team with nobody running** (board #287, owner 2026-09-30: after "team stop" the team tab disappeared and the team could only be started member by member): the roster still draws it, after the live cards among the stopped identities, as the team's name over its dimmed stopped cards (`stoppedGroups`, from `stopped_teams`; two or more stopped members, the `namedGroup` rule, a lone one being its own card; a team with any live member keeps its live group). The name is not a destination: a click opens the team menu, which offers `Start stopped (N)` and `Configure team` only, and Start is one `hub_team_restart`. A member the team's CURRENT definition no longer has is not counted as its stopped member (`stopped_teams` checks `spawn::in_current_team`; validator 06:53): starting the team must not bring a dropped member back from its old materials, so such a home stays a loose stopped card.
- **Order and weight**: rising consequence, destructive last (the agent menu's rule). A verb with nobody to act on is not offered. Remove is never a group verb; it deletes homes and stays per agent.
- **Confirm**: `Stop …` always asks (ConfirmDialog: "Stop N agents (group)?"); `Restart …` asks only when a member is busy, because a restart cuts the running turn; `Start stopped` and `Interrupt` run at once.
- **Mechanism**: a group verb is the per-agent RPC (`hub_agent_restart` / `stop` / `interrupt`) run once per member, captured when the menu is built, with one exception: a TEAM's restart, and a team's start when nobody in it is running (#287), is ONE `hub_team_restart`, which aligns the team with its current definition (board #286, agents-overview.md § Agent teams; `tmm agent restart --team`) — a per-member replay cannot stop a dropped member or start an added one — and its retry passes `only`, the names that failed, so a member that already restarted is not restarted again. Otherwise no new server route, and `tmm agent restart|stop|interrupt <name>` already gives an agent the same reach (CLI parity). Every member is tried once in parallel; a failure never stops the others and a success is never retried. A partial failure names who failed — Interrupt included (review: its failures had reached only the console): in the confirm dialog for a confirmed verb (whose retry runs only the failed members), in the composer's feedback slot for an unconfirmed one. An unconfirmed verb offers no retry entry (orchestrator 04:17): the notice names the agents, and each one's own card retries it; choosing the group verb again acts on the whole group, as it says. The pure decisions live in `hub/group-actions.ts` (`groupScope`, `groupActions`, `runGroup`) with unit tests; `Hub.mount.test.ts` covers the menus, the team scope, confirm rules and partial failure.
- The orchestrator's own window is included: the owner chooses from the UI.

### Comparable avatar meters and content-sized cards (#180, 2026-09-12)

Owner, 12:13, requested a narrower card and a meter integrated with it:
> Context window 百分比进度条：这个进度条现在看起来还是有点丑，感觉像在边缘框上多了一条线，这条线和原来的框没有任何关联。

After comparing card-ground fill and an avatar ring, the owner superseded
the temporary fill choice at 14:26:
> 背景色有一个不好的是有可能卡片宽度不一样，大家对进度感知不一样，要不用圆环的方案吧，注意头像一定用圆形，圆环刚好包括头像大一圈。然后 agent 卡片现在右边的空白太多了，就自适应卡片宽度，不要 撑开这么多。agent 卡片现在高度有点太低了，已经贴近头像边边了，可以稍微留一点边冗余，包括给进度圆环留冗余，还有颜色，就绿黄橙红，不要有中间插值不好看的过渡色，看着颜色怪怪的

The original 26px outer ring around a 20px avatar shrank to 24px around
18px after the owner requested a smaller, properly centred pair. Still, 1px
of ground separates the image from a 2px stroke. The card paints 30px high
for pointers and 34px for coarse input, leaving 3px/5px outside the ring. Its container
includes the existing paint inset; native commands remain 28/44px. Avatar
and ring stay round through the one app.css corner-policy owner.
The existing meter exposes its bounded value and exact reading through ARIA;
expanded cards also show the exact percentage. Unknown means no ring,
zero has an empty track, and over-capacity values fill one circle while
retaining their exact text.

`ctxColor` is the single capacity classifier: green below 50%, yellow at
50-69%, orange at 70-84%, red at 85% and above. These four existing status
tokens replace the interpolated CLI-statusline ramp. The 85% imminent-
compaction anchor remains; neither CSS nor JS interpolates between hues.
The ring has fixed geometry, independent of name/card width; the old edge
bar and the rejected ground-fill prototype are not production mechanisms.

The newer auto-fit request supersedes the 2026-09-11 08:41 hover-reveal
decision quoted under #173 below. Cards no longer reserve invisible Watch
or Stop slots. Busy cards carry their real Stop; idle cards carry no action.
Watch remains in the same right-click/long-press ContextMenu on both input
types. Hover never expands a card or covers its name with actions. The
expanded, height-bounded view wraps the same content-width keyed cards
instead of stretching them into fixed columns. Recency ordering, input-
held order, disclosure persistence, reading transaction and status dots
retain their existing owners.
During the existing pointer press lifecycle only, rendered Stop membership
is held so a turn ending cannot remove the pressed target or shift its
neighbors. Current busy membership still disables an ended Stop; release
on pointer-up/cancel adopts current layout, without a timer or another
classifier. Expanded percentage text reserves four monospace characters
(the wire value is u8), so changes from 0% to 100% do not move targets.
Chromium 152.0.7977.64 verifies 26/20px concentric geometry, circular
avatars, 30/34px paint, native target floors, content widths, hover stability,
menu Watch and the four colour boundaries across desktop/390px light/dark,
wide touch, reduced motion and 360px. A forced zero-fraction ring fails the
computed visual-fraction check and recovers after removing the override.
The mounted press regression proves slot retention with live disabling;
native-device gesture and owner-build acceptance remain separate gates.

### Compact card paint and secondary All (board #176, 2026-09-12)

Historical geometry: #180 above replaces the edge meter, reserved action
slots and 24/32px card paint, not the native scrolling/selection mechanisms.

Owner, 00:02 (repeating the 2026-09-11 screenshot report), verbatim:
> 这个card行太高了，看着太难看，你要做的精致一点，还有类似检查一下，很多卡片按钮什么的，不要这么傻大的，上下文的进度条稍微粗一点明显一些。还有这个展开箭头和卡片，中间直接硬截断了，不好看，要融合完整一些。
> 还有everyone按钮太大了，而且占据了主要位置，不好用

The strip had kept full-height card backgrounds after commands adopted inset
paint. Cards now use the same `--control-paint-inset`: 24px pointer / 32px
coarse paint inside unchanged 28/44px native targets. Remove the extra 4px
outer vertical padding; the ordinary strip becomes 32/48px, including its
2px scrollport padding. Skeletons use the same paint inset. Selection and
filter outlines follow the painted boundary rather than crossing the
20px avatar in the compact interior; focus and sibling Stop/Watch targets
remain separate. The existing `ctxColor` meter becomes 3px and straddles
the painted lower edge by 1px to clear the avatar, with rounded ends; percentage/ARIA and
missing-versus-zero semantics are unchanged.
Expanded names retain wrapping, with padding for the paint inset and meter.
This leaves ordinary single-line geometry unchanged while letting long names
grow their row instead of crossing the 3px meter.

All is secondary, after the named and stopped identities, before Add. It is
an icon-only choice in the collapsed strip, labelled in the expanded list
and always named in hover/ARIA and the selected-destination placeholder.
Its resting paint is neutral/unframed, not a permanently accented first
card; selected All retains the accent capsule. This deliberately supersedes
the first-position/broadcast-emphasis treatment from #168/#173, not their
selection or interruption contracts. The same busy-only All Stop remains,
including the double-Ctrl+C equivalence; no new destination sentinel.

The single native horizontal scroller meets the disclosure without an extra
gap. `ui/scroll-edges.ts` measures which physical ends still hide content;
the shared `.edge-fade` alpha mask softens only those ends. It is an overflow
cue, not an overlay covering actions or a substitute for fitting controls.
At an end, that end is fully visible; a fitting or expanded list has no
horizontal mask. Keyboard focus also suspends the mask: native Tab and
menu focus return otherwise leave an edge glyph/focus ring visibly faded.
One action observes scrollport/items and direct-child
changes, cleans up on unmount and adds no timer, custom scrolling or
selection listener. The same keyed list, recency hold, disclosure preference
and parent reading transaction remain authoritative.

### Card refinements (board #173, 2026-09-11)

Owner, 08:39: "卡片显示优化，context 长度比例还是直接帮我可视化出来，还有 everyon 可以换一个样式，不然我以为还是和 agent 会话一样。还有终止按钮，不要圆形的阴影了，还有这个黑方块看着不知道是停止的意思，是不是换个颜色？让我能更容易够理解这个按钮的含义。还有缺少了双击show 单独过滤某个 agent 消息的能力，是不是可以双击后，卡片样式给我一些改变。"

Originally 2px (strengthened by #176 above), `.ac-bar` restores context usage at the card's
bottom edge, in both strip and expanded views. It uses `ctxColor`, not a new
threshold or colour family; zero is a reading, missing data has no bar, and
over-capacity readings saturate the fill while hover/ARIA retain the exact
percentage. The track sits between the rounded corners, costs no layout
height and never intercepts clicks or clips the command focus ring.
Chromium 152 desktop/390px light/dark, collapsed/expanded comparisons keep
card and roster boxes identical across 16 captures; fill/track ratios match
the reported percentage. A zero-fill negative control breaks that ratio.

The everyone choice is a broadcast capsule: no avatar tile, a group glyph
and accent-ink label, with the same accent fill/border for selected state.
It is deliberately distinct from a named partner, not another agent. Its
round-corner exception stays in app.css, the existing corner-policy owner.

**Double-click focuses an agent** (lead clarification, 08:48). There is no
single-click delay or rollback: clicks act immediately, and a fine-pointer
double-click explicitly selects the live agent and toggles the existing feed
filter. The second click in that native sequence does not toggle selection
off. Another double-click clears the filter and leaves the agent selected.
Stopped slots only filter; their click menu opts into the shared
`menuHeightLimit` cap before `menuPlacement` measures/flips it. A viewport-only
clamp could cover the trigger when neither side fits the full menu; limiting
height to the larger side keeps the second click reachable and scrolls the
menu internally. Other menu callers retain their existing placement.
Coarse pointers and keyboard users retain the ContextMenu filter command,
which remains a reading-only choice. The strip IS the filter indicator
(owner, 2026-09-23: "不要在上面显示了，直接在我们的 Agent tab 栏做强化显示…
把当前的卡片直接亮起，其他全部变暗"): while a filter is on, `.cards.filtering`
dims every other card, the team labels and the All tab to
`--control-disabled-opacity` (an opacity crossfade on `--t-move`), and the
filtered card keeps full ink and an accessible label. The tab paint is
untouched, so dimming says "not in view" and the paint still says who you
are talking to. The feed's sticky banner with its ✕ and the dashed card
outline are deleted — one indicator, and the exit is where the entry was:
double-click again, the card menu's Show everything, or the back gesture.
Because the card is the only indicator, the filter lives only while the
strip draws that card, live or stopped: an agent removed from the room
clears it, or the feed stayed filtered with no mode shown and no exit
(#241, validator, 2026-09-27).
A heavier avatar ring was the owner's other option; it was not taken
because that ring is the context meter. Dimming alone said that something
changed, not what (owner, 14:50: "只是颜色变暗了，没有任何提示…这个 Filter 和
正常状态的差异太小了"): the filtered card also carries the filter verb's own
`filter` funnel beside the marks column, in the marks' `--accent-ink`, and
its hover note names the mode and the way out (`hubFilterOnNote`).
Tests execute the complete click/click/dblclick sequence, not a lone
synthetic dblclick. Chromium also verifies repeat-to-clear, stopped-card
menu exclusion and the coarse-pointer long-press filter path.

Owner, 08:41: "还有我觉得交互可以优化，比如应该打断方块可以不一直显示，可以鼠标移到卡片上后，可以显示打断按钮，还有 show terminal 的快捷按钮也要显示"

**Stop stands on the dot, red, only while the pointer is on the card (board
#205, owner 2026-09-20: "终止按钮应该是红色的吧，更符合语义，而且默认不显示，只有鼠标移到上边，
把状态的小圆点变为终止按钮。手机端就不要了，节省空间，让用户用选项卡终止就好").** A busy
card at rest shows its state dot. Hovering or focusing it (fine pointers)
puts the `danger` icon command — the same shared `CommandButton`, 28px
`compact-tools` slot — exactly on the dot (`overDot` reads the dot's offsets
in the card's space; the dot hides underneath), so the card never changes
width and the row never shifts; a pending interrupt keeps its Stop so the
keyboard path has feedback (#173). Touch renders no Stop at all: the
long-press menu's Interrupt is the touch path. Measured at 1440: hover →
Stop centre (320, 841) = dot centre, card 71px wide before, during and after.
History: #173 revealed a resident amber Stop on hover; #180/#195 made it
resident while busy on both pointers, quiet `--text2` ink, with a press-hold
of the row's layout (`renderedStops`/`pressStops`) so the slot could not
shift under a finger — gone whole with the slot. Watch stays in the menu.

**The dot reserves the Stop's room, and the Stop wears no wash (board #211,
owner 2026-09-20: "agent 卡片状态小点右侧好像没有留边距，包括我鼠标悬浮的时候，停止按钮都超出
agent 卡片框了。而且停止按钮就不用加背景了，就红色方块我直接点就行").** Measured before:
the 28px slot centred on the dot reached 14px past the dot's centre while the
card had 3px (half dot) + 4px (`--roster-card-inset`) there — the hovered
Stop stood 7px outside the frame. Now a live card's `.agent-select` ends in
`--roster-dot-reserve: 12px` (= 28/2 − 6/2 + the 1px inset border): the slot,
which is also the focus ring's outer edge, ends at the border's inner edge.
The reserve is constant, not hover-only, so revealing the Stop still never
reflows the row; a stopped card has no dot and keeps its 4px. The Stop passes
`bare` to `CommandButton`: no rest, hover or press paint — the card under it
already carries the hover, and the red glyph is the whole control. Measured
at 1440 and 720 (compact), and in the expanded grid: card width identical
before/during/after hover (77.58px strip), slot right edge 379 vs card
right 379.58, paint right edge 3.6px inside the border, `::before`
background `rgba(0,0,0,0)` at rest and with the pointer on the button, ink
`--danger-ink`, Stop gone on pointer leave.

The state dot lives INSIDE the name's line with `vertical-align: middle` —
by definition the dot's midpoint on the baseline plus half the x-height, so it
is centred on the lowercase letters whatever the font's ascent/descent — 5px
after the last glyph. As a flex sibling it was centred on the LINE box (~1px
off, font-dependent) and 1–2px from the name (owner, same message: "状态小点稍微
有点挨得近了，而且上下不居中"; measured: dot centre 714 vs x-height centre 715,
gap 1.3–2px; after: 765.1 vs 765, gap 4.2–5px). Watch and the menu
share one parent adapter that selects the Terminal view before using the
existing pane resolver; a compact terminal
request uses the existing full-page Terminal callback. A missing requested
pane clears the stale terminal target rather than watching the previous agent.
Neither action changes the recipient. The Watch slot stays fixed; an idle
selection reclaims the
vacant Stop slot, keeping target regions separate. Chromium 152 verifies
18 desktop/390px, light/dark action states, stable reveal boxes, keyboard
reach/pending feedback and coarse fallback. Mounted tests exercise phone
and compact desktop routing including a vanished pane; the wide-browser
Files-to-Watch check stubs only the two renderer boundaries, proving routing
and identity rather than either renderer's internals.

### One roster above the input, one Stop operation (board #168, 2026-09-11)

Owner, 03:32: "我看到这个设计挺好看的，因为我们有多个 agent，可以在上边去展示哪些agent 在工作，并且我可以对某一个 agent 单独点停止。可以把原来我们的 agent 擦片就放到发送框上边的位置，然后我们消息输入框里，就不用 to 谁了"

The single `Roster` sits between Feed and Composer. Its native selection
button chooses `@name`; selecting it again chooses no implicit recipient.
An explicit everyone card chooses `@all`. The placeholder names that
destination, and the selected card's existing hover card explains delivery.
Body mentions still deliver through the existing parser; `chipExtras` uses
`mentionTokens` to mark reached cards with one `@` glyph, never a second
parser, dashed ring or selection change. The drawer's window selector has
a different purpose and stays. The owner-selected ordering and disclosure
below supersede the prototype's team-group adjacency.

**Final density and ordering, owner 07:09:** "用单行的形式吧，而且不要进行中这种文字描述了，最好有一个展开的小按钮，展开一个多行的 list ，但是限制高度，我可以一下子看到很多，而且 agent 卡片排序，一般最后活跃的放到最前边"

Cards have one line: avatar, name, the existing status dot, optional mention/
unread marks and a separate Stop. State words remain in hover/ARIA, not the
visible row. `sortAgentsForRoster` in `hub.ts` puts the existing busy membership
first, then sorts each busy/nonbusy partition by `since` descending and window
index ascending. For hooked agents this is turn-level recency: `since` is the
prompt start while running, ask time while waiting, and end time while
idle/failed, not the latest tool call. The server's existing no-hook fallback
is unchanged; the client adds no pane reading, clock, telemetry field or
history scan.
The 2026-09-11 global-order decision replaced the earlier team frame so every
agent could move independently. The owner clarified on 2026-09-23 that a
launched team should read as one Chrome tab group. `sortAgentsForRoster`
still owns the busy/recency rank; `rosterGroups` gathers members by root team
path after that sort, placing the whole group where its highest-ranked member
would have been and preserving the sorted order inside it. Solo agents stay
individual. Nested team paths (e.g. `dev/review`) share the `dev` group and
retain the full path in hover/ARIA; a second nested frame would fight the
small tab bar and the one-enclosure rule for All. A team with only one live
member has a stable team key but looks exactly like a solo tab. The group
adds no row height or status colour. The owner's Chrome tab-group
reference (2026-09-23, 558x88) supersedes the first 1px upper marker:
the team name is a native choice sized within the existing row — a
`--control-surface` pill until 2026-09-24, when the owner found the block
"有时候太大" and asked for the bare name: it now speaks through ink alone
(`--text2`, `--text` on hover and when the team is the recipient); a
`--text2` baseline sits in the group wrapper's
bottom pixel, behind the member cards. The selected member already has
`z-index: 1` and its bubble fill covers the floor-line pixel: it covers the
baseline beneath that tab. Its existing open-bottom outline takes `--text2`
only inside a group, rising from the group's baseline without sealing the
tab off from the composer. Solo tabs keep the normal faint bubble edge.
This is not a return to #236's deleted tray-wide rule: only the team itself
draws a baseline. The screenshot uses green; this implementation keeps a
neutral line because membership is not a status or selection colour.
The owner next asked for bottom LEFT and RIGHT rounding too (2026-09-23,
09:26). The first attempt rounded INWARD using `--ui-radius-row`; at
10:39 the owner corrected the direction to Chrome's small outward tangent.
The collapsed strip now widens ONLY its between-tab flex gaps from
`--roster-gap` (2px) to `--ui-gap` (4px). A selected named tab's two tangent
feet are 4px arcs confined to those real gaps, with the lower stroke of
the old vertical border removed only where the arc begins. The selected
team group has the same feet on its outer edges; All at the viewport's
left edge retains its original inner corners. The expanded list keeps
its old 2px gaps and no feet. The fill under each arc is the same
`--bubble-in` as the selected tab and composer, so `border-bottom: 0`
still joins the band. `--roster-gap` stays 2px: its eleven other readers,
including the group baseline and the instantly opaque join, must not
move with visual tab spacing. The All icon gets a named 20px roster metric
instead of avatar size plus gap. Chromium 152 at 390px with three team
members and two solos: the destinations width is 512.81px -> 524.81px
(+12px), scroll content 563px -> 575px, row and native targets stay
44px. Selected member's left/right feet ended exactly at the adjacent
pill/member hit-box edges with zero overlap. The owner's width tradeoff
is explicit: each of the six widened gaps costs 2px.
The owner's 14:29 review of that round found three faults, one root: each
lit enclosure (tab, team, All) drew its own silhouette. The 4px arc at a
1px stroke read as a staircase, and it sat in the gap one column OUTSIDE
the tab's side stroke, so the stroke went straight to the floor and the
arc started 1px beside it — on a team this read as "一个竖线和一个圆角";
All kept rounded lower corners ("成了一个圆角矩形"). Now ONE `.tab-foot`
pair serves all three: `--roster-foot-radius` (8px), its inner column ON
the side stroke's column (`calc(1px - radius)`), its fill covering the
stroke's stub below the arc, `z-index: 1` above a team enclosure's own
stroke. All's paint moved to `.tabs.all-lit::before` with the same open
bottom. The feet reach into the neighbour's empty bottom corner rather
than a widened gap, so the between-tab gaps are back to `--roster-gap` and
the +12px is gone; the scrollport's start inset is the foot radius so the
All enclosure's left foot is not clipped. The band's top edge came back as
the strip's floor line — a `--bubble-line` background pixel across the
full width, BELOW every tab ("圆弧连接的整个 Agent 框上面的输入区，应该有一
条横着的淡淡的白线延伸"). Unlike the deleted round-3 hairline, the lit
enclosure breaks it with its fill and its feet turn into it, so it never
crosses under a tab. Chromium, dark and light, 1300px at 2x: solo, team
member, team and All each show one continuous stroke from side to floor.
The owner's 14:50 look ("竖线…对齐得不是很严谨"; "横线，粗细好像也不一样")
was right at a FRACTIONAL device scale, which 2x hides. The tab's straight
side stroke is pixel-snapped and the arc is not; at 1.25x and 1.5x the
snapped stroke landed up to one device pixel inside a foot that ended
exactly on it, and showed as a stub beside the arc down to the floor. The
foot box now reaches one pixel into the enclosure and fills it, and its
ring box is exactly the radius (`box-sizing: border-box` — without it the
1px border pushed the arc a pixel outward). The floor line was a
translucent `--bubble-line` over the dark frame while every enclosure
stroke lies over band fill: measured luminance 46 against 65 at the
junction, which reads as a thinner line. The floor line now lies on one
pixel of `--bubble-in` too. Probe columns at 1x, 1.25x, 1.5x and 2x: no
stub under the arc, floor line 65–67 against the tab edge's 65.
The owner's own screenshots (15:07, macOS desktop, a 2x display at about
1.4 UI zoom) still showed both arcs landing a pixel ABOVE the floor line,
the line running on under each foot, and a bright tick of side stroke
below the line at each lit edge. WebKit cannot run on this host, so the
cause was read off the pixels: the tick sat on the floor line's rows, so
the card's bottom was a pixel above the strip's — the card was CENTRED at
its 34px minimum in a strip that something had made taller. Now the tab
chain (`.tabs`, the group, the card) stretches to the strip's height in the
collapsed row, so a tab reaches the floor however tall the strip is; the
paint box ends AT the floor instead of 1px into the band, so its side
strokes cannot tick below the line; and the fill's overlap of the floor
line moved to a join layer of its own (`::after` on a tab and on All, the
group baseline on a lit team) — without it a fractional scale let part of
a row of floor line or frame through under the tab (Chromium: lum 37 at
1.5x, 27 at 1.25x, band 31; 31 with it). The strip's scrollport clips at
the floor, so no enclosure paints into the band. The filter mark is the
funnel the menu row wears, not a magnifier (owner: "沙漏过滤的样式"), and it
sits beside the marks column rather than in it — three stacked marks would
have exceeded the strip and grown it.

**The enclosure is ONE marker that travels** (owner, 2026-09-23 16:58: "点击
不同 Agent 的标签进行切换时，会看到好像先标了一个框，然后又闪过去了…切换的动
画不是很丝滑"; motion principle 14). Until then each card lit in place: its
fill and edge crossfaded on `--t-move` while its feet, its opaque floor and
the join popped in the first frame — a frame appearing, then the fill
catching up, which is the flash. Now the lit enclosure — fill, edge, both
feet and the join into the band — is one `.slide-pill.tab` inside `.tabs`,
placed by the shared `slideIndicator` (`ui/indicator.ts`, the same
mechanism as the rail and every segmented control) and gliding by
transform and width on `--t-move` from the old destination to the new one.
Its target is the lit card (`.acard.sel[data-agent]`), the lit team group
(`.roster-cluster.team-lit`) or, under All and while All previews, the
group's own extent (an inert `.tabs-extent` box), so a card, a team and All
are the same marker at a different width; a lit member of a group wears the
raised `--text2` contour through `.raised`, and only that colour crossfades.
The rule is `rosterMarker` (`hub.ts`), and it reads the same `namedGroup`
the markup does: a lit team down to one live member is drawn as that
member's plain card, so the marker goes to the card. Aiming it at the
team enclosure when no enclosure was drawn left the selection with no
highlight at all, because a lit card paints nothing of its own here
(#241, validator, 2026-09-27).
In the strip a lit card, team or All paints nothing of its own any more (the
hover wash stays on unlit cards, as in Chrome); the wrapped list keeps its
closed boxes per element, and the marker is unmounted there. The marker is
the LAST child of `.tabs` (the All tab stays its first) and sits under the
cards and over the group baseline: both are `z-index: -1` inside `.tabs`,
now a stacking context, and the marker comes later in the DOM, so the
baseline shows exactly where the marker is not. The measure is layout (offsets),
so the marker is not fooled by the press scale or the root zoom; its box is
integer offsets, up to half a pixel wider than the card, inside the gap.
Frames at a 2.5s tempo: card → card, card → team and team → All each show
one enclosure in flight with both feet, nothing popping.
**The silhouette is one path** (owner, 2026-09-27: "这个拐角还是不够连续 感觉
线错位了…这个拐角渲染的效果感觉不是很自然…用最标准的方式"). The marker's
outline had been assembled from four rasterisations — a bordered box for the
sides and top, a radial-gradient fill and a bordered ring per foot, and a
join layer — and they had to meet: the side border snaps to device pixels,
the ring's arc and the gradient's hard stop do not. A static probe of that
construction measured the floor line's ink dropping to 60% of the line
under the foot at 1x (a visible break) and to 50% at 1.5x. Now the
silhouette is Chrome's own construction: ONE SVG path, filled once with
`--bubble-in` and stroked once with `--card-line` (`.tab-shape`, drawn by
`hub/tab-shape.ts`). The stroke runs on half-pixel centres and meets the
floor row tangentially; the fill is the stroke offset half a pixel outward
(radius r+½ on the top corners, f−½ on the feet) and closed one pixel into
the band, so the translucent stroke lies on fill along its whole length,
as the floor line does. The radii remain the tokens (`--ui-radius-row`,
`--roster-foot-radius`), read from the element. A ResizeObserver redraws
the path from the box's layout size, which it reports after layout and
before paint on every frame of the width glide, so the outline never lags
the marker. The same probe, same colours: the floor line's ink is constant
across the join at 1x, 1.25x, 1.5x and 2x; the real Roster at 1.5x and 2x
shows one continuous line from floor to foot to side. The strip's
skeleton (three shimmering cards) shows only while there is nothing to
show — with the cards already rendered it sat in front of them on a room
switch (owner, 17:38: "Agent 卡片都已经渲染出来了，前面还有 3 个空的过渡动画"). Same day, the band
under the strip got equal air above and below the field (6px, was 10px
below; compact 3px, was 8px) and square lower corners — the band's sides
meet the sidebar and the drawer, and the rounded corner left a notch
against them ("左下角和右下角…两边的侧边栏应该都是直角…会有一个小缺口").
Over the phone's tab bar the band has no bottom border (board #288, owner
2026-09-30: "输入框和下边的菜单中间会有一个小小的缝隙，在其他页面没有"): at
390px the band's 1px `--bubble-line` edge sat directly on the bar's 1px
`--border` top line, two lines of different shade that read as a seam, while
every other page meets the bar with its one line. The rule applies exactly
while the bar SHOWS: `html:not(.keyboard-open) main.touch-layout:not(.immersive)`
(App.svelte draws the bar under `touch-layout` and hides it while the soft
keyboard is up and in Files' reading mode). Under a hidden bar (typing on
the phone, a desktop window) the band keeps its own bottom edge (validator
06:19).
The owner's 09:38 report of a WHITE LINE while switching tabs exposed two
transient join faults. Chromium 152 at 390px measured the incoming bottom
inset at 6px immediately after selection, 3.14px after 64ms and -1px only
after 230ms; the outgoing tab retracted the other way while its bottom
border returned immediately. The 1px group baseline showed through for
the 200ms animation. The selected tab's joining geometry (inset and
corner radius) now switches immediately; only background and border colour
crossfade on `--t-move`. Colour alone would still fade the new tab's fill
from transparent and leak the group baseline. The collapsed, non-All
selected tab therefore owns an immediately opaque `--bubble-in` floor of
`--roster-gap` pixels (2px) INSIDE its own paint. It reaches the band in the
first frame while the rest of the fill fades; the group line neither
becomes a tray-wide rule nor needs a second covering layer. The frame
probe at 390px light: at 40ms the body was 7% opaque but the floor was
fully opaque; video pixel x187,y538 went from grey (97/96/99) straight
to bubble (239/238/243) with no intermediate line.
At 390px long names could bury the strip, so compact caps the team's
visible text width inside its 44px native button; its full name is in
ARIA/hover and each member's touch-opened menu. Expanded mode is a list:
the pill stays and a selected team closes its group border rather than
pretending to join the band. Under All selection/preview both group line
and contour yield to one destinations enclosure. Member cards keep
independent native selection/Stop targets. Stopped
identities remain outside `.tabs`. The wrapper scrolls as one item and
wraps members when expanded. A new member appears with `appear-pop`;
group/member reorders use the one `animate:flip` tempo; removal and a
one-to-two-member group chrome change cut.

### A mention nobody received is SAID (board #347, 2026-10-15)

Owner: "如果某一个 agent 发送了一个消息，可能 at 了其他 agent，当这个 agent 不在会话，或者停止什么的时候要返回一个 warning，提示 agent 不在线". A delivery to nobody used to be silent. `deliver_mentions` walks the live panes and types into the ones a mention matched; every other name — a stopped teammate, a typo, an agent of a different project — was dropped on the floor. The message was stored in the room, so the sender could not tell that from a delivery that landed, and waited for an answer that could not come.

Each unreached name leaves one room line, `[tmm] offline <name> — <sender>'s message was not typed in (stopped|unknown); nothing is queued for it`, in the lifecycle grammar `sysParts` already reads, and the verb joins the amber family (`sysVerbColor`: somebody has to notice; nothing is broken, somebody is simply not there). `tmm send` prints the same facts on stderr, in its own wording, and still exits 0: the message IS in the room, and being told is not a failure. (The room row, the stderr note and the line typed into the sender's pane say the same thing three ways; none is a string to match on — `--output json` carries the structured `{name, why}` rows.)

**The room line alone does not reach an AGENT sender** (review P1-A, 2026-10-15): the team context drops every `[tmm]` row (`context_noise`) and a Team agent's delta excludes its own messages anyway (`message.from != target`), so the first cut of this promised a warning that nobody would have read. The sender's own pane therefore gets ONE line typed into it through `deliver_chat_line` — the same server-decided delivery the board's notices use, so a busy queue-mode sender gets it at its turn's end like everything else — for all the names at once, because a pane is a conversation and a burst of near-identical rows in it is noise. A human or a UI sender has no pane and `deliver_chat_line` is quiet about that: the feed is where they are looking. A sender pane that REFUSES the notice (copy mode) gets the ordinary `undelivered` warn from the delivery path and nothing is retried — there is no promise that every managed sender sees it.

**The room line is posted under the sender's own name with no recipients, deliberately NOT addressed to the sender** (the orchestrator's first ruling asked for the addressed form; measured against the code, 2026-10-15): `team_context` takes the newest row whose `to` holds the target as that target's delivery cursor, so a row addressed to the sender becomes the point the sender's next delta starts AFTER — the warning would be hidden from the one reader it is for — and the same delta drops rows whose `from` is the target. Reaching a Team agent through its context would need a cursor rule that skips system rows, which is #279's machinery and its own issue.

**The notice asks nothing of the reply edge** (review P1-B): it is typed in the stamped RESULT shape `[tmm chat <stamp>] tmm: [reply] offline — …`, the one `address::requesters` already reads as "asks nothing". A bare `[tmm] offline …` is an unstamped prompt, and `requesters` takes every unstamped typed prompt for a person at the keyboard (#289): the agent's reply to its own warning would have been recorded as an answer to `human`, and a notice that joined an open turn would have added a requester that never asked. Pinned on the real output of `offline_notice`, alone and joined to a real request (`the_senders_notice_asks_nothing_of_the_reply_edge`), including that the bare look-alike WOULD be a human request.

**Offline means "no live managed agent matched the name", never "the line was not accepted"** (review P1-A): a pane in copy mode refuses the line (#250), and that agent is found and alive — so it is neither `stopped` nor reported a second time, because it already has its own `undelivered` warn. Typed, held for a busy queue-mode agent (#257) and refused are `deliver`'s three outcomes; none of them makes a found agent offline. Pinned on real panes (`a_live_pane_that_refuses_is_not_offline_but_a_stopped_slot_is`).

**A session we cannot list is told apart by tmux's own words** (review P1-B, then P1-A): when `list_panes` fails, every mention is unreachable and the sender is still told. But "tmux says there is no such session" (`can't find session`, `no server running`, `error connecting … No such file or directory` — measured on tmux 3.6a) and "tmux could not be asked" (`error connecting … Permission denied`, tmux not runnable) are different facts, and only the first may call a declared agent `stopped`. The second reports every name as `unchecked`, said as "tmux could not be asked", because a general tmux or I/O fault is not evidence that any process stopped. A future wording that the classifier misses lands on the safe side: `unchecked`, never a confident `stopped`.

Two words for what we KNOW, because a sender can act on two — and a third, `unchecked`, for what we do not (tmux could not be asked, below): `stopped` when this project HAS a managed home for that name (`is_managed_in`) and nothing is running it, `unknown` when it has none — a typo and another project's agent are both honestly unknown from here. Three names are never missing recipients: `@all` addresses whoever is there, `@human` reads the room instead of a pane, and the sender's own name is deliberately never typed back. One line per name, in mention order, so `@dev @dev` warns once.

NO retry and NO queue (the classification is `projects::delivery::offline_mentions`, beside the one typing path, with `offline_line` as its wording): a message to nobody is not stored for later. What exists is the room — the message is there, and `tmm log` or the feed is where a late-starting agent reads it. Holding it would mean inventing a second queue beside the one the deliveries table already is (#249), and delivering it on start would type a line whose moment has passed.

**After a reboot restore, a mention before the agent's window exists is offline (board #422 round 3).** The restore makes each agent window under a placeholder and gives it the agent's name only at its launch; until then a mention of that agent is said offline like any missing window. This is a v1 limit: the restore barrier holds lines for windows that exist (agent-status.md), it does not queue lines for windows not yet made.

### One team selection, exact member delivery (#239, 2026-09-23)

Owner: "如果是一个 team 的话，我点击 team 的名称，可以一次性选中该
team 的这几个 Agent". The label is a real button, not an `@all` disguise:
`team:<root>` is a frontend-only recipient value (the colon cannot occur
in an agent window name). The single `targetMembers` resolver reads the
managed roster's recorded `team` path; `dev` includes `dev/review`, never
a solo window or another team. It drives the pressed cards, composer
destination, message addresses and busy/interrupt membership. Clicking an
individual card narrows to one; clicking All broadens to everyone. A team
group is the ONE selected enclosure, so internal card borders turn off.
The terminal partition follows an agent only, never the team sentinel.

A chat send takes one snapshot of current member names, prefixes each
with the server's existing `@name` token and posts ONE room message;
explicit body mentions remain additive and `@all` is never synthesized.
If the team empties in the gap before the next roster poll, implicit
delivery keeps the draft and clears the stale team target; an explicit
valid `@name` in the text still wins and goes through unchanged.
A stored team target is judged only by an ANSWERED roster: `loadAgents`
forgets it once the fresh roster has no members. Entering a cold room
knows no roster yet, and clearing it there wiped the team on every
refresh (#241, validator, 2026-09-27).
There is no new server route. A leading CLI `/command` under team
selection is typed verbatim through one existing `hub_command` per current
member, like All's existing broadcast route; a leading explicit `@name`
still wins. Partial command success leaves the cleared draft alone so a
retry cannot duplicate commands already typed; if every call fails, the
draft is restored. Both cases now use the shared `OperationFeedback`
anchored to the composer's field: a partial failure names only the members
who did NOT receive `/command`, and an all-failed error names the command.
No raw transport exception reaches the screen. Errors persist until
dismissed, the next command, recipient change or room change; the local
feedback lifetime invalidates stale async outcomes. A remembered team
selection stays while at least one
member survives; when the last departs the recipient becomes an explicit
room note, not a silently selected agent elsewhere. The group label
stays a native 28px pointer / 44px coarse target in collapsed and expanded
lists. The visible compact name may elide, but its full accessible name
and the member's touch menu retain the identity.

One shared icon-only CommandButton expands the same keyed list in normal
flow. The default is one horizontal row; expansion uses 1/2/4 columns and
internal scrolling, capped at `min(240px, 32dvh / --ui-zoom)`. Long names wrap
in expanded cells instead of clipping. Both selection and Stop retain native
28px pointer / 44px coarse targets; the Stop track remains reserved when idle.
The disclosure chevron uses the existing `.flip` atom through controlled
`expanded`, never a second glyph or animation. `hubPrefs.rosterExpanded` stores
the mode per project and follows project rename like the drawer preference.
Hub captures project and next mode before its existing `withReadingAnchor`
transaction; this is not a popup or new Back/history layer.

While a card is pointed at, pressed or focused, hold the display order but
read current agent objects for state and actions. Remove departed names and
append new members; adopt the latest turn order on pointerleave/blur/release,
not a timer. An idle expanded view reorders live: freezing until collapse
would hide new activity (lead clarification, 08:04). Keyed `flip` uses
`moveMs()` for that reorder, not a new timing curve. A new Stop must not move
under an active gesture. Pointer-up/lost capture releases the press lock even
when a disabled target emits no click.
Relevant DOM updates recheck actual focus because removing a Stop or agent
does not guarantee a `focusout` event.

Each busy card exposes a sibling Stop button, not a nested selection button.
`busyTargetsFor` in `hub-composer.ts` is the sole membership decision:
running/working/waiting/blocked managed agents only; everyone includes only
busy members, no selection includes none. Both that button and empty-composer
double Ctrl+C call the same Hub dispatcher. The dispatcher captures room and
names before awaiting, prevents overlapping requests for a member, and cleans
up only its own jobs. A peer Stop never changes recipient, opens/retargets a
drawer or forces the feed to its tail. Existing server push/poll reads the
reset-first state and `[tmm] interrupted <name>` line; no optimistic status
store is added. Process kill/remove remain separate consequential menu verbs.

The keyboard can do no more than the visible Stop: two non-repeated Ctrl+C
presses within three seconds, only with an empty composer and no text
selection. Text, room or recipient changes and Escape reset that sequence;
native copy and IME composition remain untouched. It has no send-button
arming state, timer or caption. Send only sends and is disabled while empty,
uploading or blocked by a failed attachment.

The delayed 260ms card menu, double-click filter shortcut, recipient popup
and two-beat send-button mechanism are removed whole. Secondary agent verbs
use `ContextMenu` with `longpress`; stopped slots open that menu, never select
an undeliverable destination. Only the command palette remains a Composer
Back layer. The textarea and attach/send row are normal flow, so the old
recipient indent, last-line mirror and corner-collision padding are gone.
Actual shell-height changes still notify Hub through the existing reading
boundary; no animated height, new scroll mechanism or lifecycle remount.

The pre-#168 descriptions below of the chip, mirror, recipient menu and
two-beat button are historical evidence, not alternate supported controls.
Delivery parsing, attachment gates and readline rules are unchanged.

Verification on Node 22.23.2 / Svelte 5.55.5 / Vite 6.4.2: pure target
vectors plus the mounted real Hub pin selection, body mentions, busy-only
Stop, keyboard parity, duplicate requests and room identity across awaits.
Negative controls remove the managed gate (reaches a shell) and make Stop
select its target (changes Alice to Bob); both fail their tests. Seven retained
Hub transport/staging/reading functions are AST-identical to the #171 base.
Chromium 152 checks desktop and 390px light/dark, explicit coarse media,
long names, nested teams, menu/Stop reach, reload, reduced motion and a
reduced-height multiline input. Settled history typing and peer Stop preserve
the reference row within 1px. (Those tests waited for the 300ms focus-tail
callback, which board #303 removed.) Synthetic touch and key checks
do not replace native Android keyboard/IME acceptance.

### The room has a default recipient

**Explicit broadcast restoration** (board #171, 2026-09-11): a stored
`ALL_TARGET` is a destination mode, not an agent name to look up. `pickLead`
preserves it before inspecting the roster, exactly like the stored empty
string. This deliberately keeps broadcast selected through an empty/direct-only
roster; it neither delivers nor interrupts anything. With null/absent preference,
the existing managed-lead rule still applies, and an empty roster yields `''`.
The bug was in this classification, not localStorage: a stored `"all"` failed
the agent-name lookup and silently became the first lead on reload or revisit.
The single `ALL_TARGET` constant comes from `hub-composer.ts`; no new sentinel
or preference migration. Unit vectors cover zero/one/many/direct-only rosters;
a mounted real Hub covers fresh-client restore, cached-room return and polling
with post/command/interrupt RPCs forbidden. The chip's former "three states"
description below omits broadcast; this dated rule corrects that omission.

`pickLead()` (pure, client) = remembered choice while present → the only managed agent → lowest window (the `can_hire` seat was retired 2026-09-26); choosing a recipient IS choosing the project lead, so it persists per session — and the ROOM is a choice too: `hubPrefs.lead` has three states (a name, `""` = the user chose "no recipient, record only", `null` = nobody chose), `pickLead` keeps an explicit `""`, and only `null` seats a lead; before, `""` was stored as an absent key and the next 5 s roster poll re-seated a lead the user had just dismissed (review C, 2026-09-03; `hub-prefs.test.ts` + `pickLead` tests pin it) — and `addressed()` ALWAYS prefixes the chip's `@name` (owner, 2026-08-26: "前边的永远保留，后边的at如果存在某人的话也会发送过去" — an `@` in the body used to stand the chip down, so an email address or quoted @all silently defeated the chosen recipient); body @mentions deliver TOO because `deliver_mentions` scans the whole body, and only a body already leading with the same recipient skips the prefix (empty recipient = the whole room). **The chip SAYS so, live** (review, 2026-09-03: it read `to: alice` while `@bob` in the body was delivered as well, with no hint): `chipExtras(text, recipient, managedNames)` (pure + tested, on the same `mentionTokens` tokenizer as `mentionsAgent` and the feed's room-note verdict — never a second parser) appends `+@bob` for every managed agent the body addresses beyond the recipient, in roster order; an `@all` in the body collapses to `+@all` rather than listing the roster, `@all` as the recipient appends nothing (already everyone), and a name that resolves to nobody on the roster — an email address, a removed agent, a direct window — is not shown because it is not delivered. The extras wear the accent even on the grey room-note chip, because that part IS a delivery, and the chip's tooltip switches to name them. An empty room shows a preset start (one agent, or several as a team) rather than a composer with nobody to talk to — but "empty" is a VERDICT, not a default: switching projects parks the leaving room in an in-memory per-session cache (`roomCache`: feed, activity, roster, cursors) and restores it instantly on return, and a room without a cache entry renders NOTHING until its first `hub_log` answers (`roomReady`); judging emptiness from the cleared arrays made every switch flash the "add an agent" panel in front of rooms full of history (owner, 2026-08-25: "先看到添加 agent 一个 agent list那个页面闪了一下，然后再出来消息"). The pollers merge on top of the restored state (cached `lastTs` makes the refresh incremental), a cached roster seats the recipient immediately via the same `pickLead`, and entering a room always lands at its tail. The verdict rule swept the other pages too (owner, 2026-08-25: "不同页面切换会不会有类似的这种问题"): the Terminal sidebar says "No sessions" only after its first refresh answered (`listReady`) and renders the untracked group only after Projects reported `onTracked` once (`trackedReady` — before that every tracked session flashed as untracked and migrated; `Projects.load` now reports on its failure path too, so the gate cannot stay shut), and the Agents page keeps last-known defs/skills/MCP on a failed reload instead of wiping them. Files (`!entries.length && !loading`) and Team (`loading` gate) were already correct. DirPicker navigates the same way (owner, 2026-08-28: "每次点击一个路径…先清空再重新刷新…要交互更流畅"): a tap KEEPS the current list and swaps it atomically when `fs_list` answers (`seq` makes the newest tap win; scrollTop resets on the swap because a new directory starts at its top); the `…` placeholder shows only before the FIRST answer, a failed listing keeps the old rows with the error line above, and the busy cue is a 150ms-delayed opacity dim so a fast local listing never blinks.

### The reading filter locks the target (board #482, 2026-10-30)

The owner kept sending to the wrong agent while reading one ("如果我选了show
only后，要选中这个agent不能选其他agent不然经常发错消息"). The reading filter
(`filterAgent`) and the target (`recipient`) were two states under one paint.
The strip dimmed every other card, @all and the team names, and the person read
that as "I am talking to X". But every dimmed control still worked. The phone's
way in, the card menu's "Only its messages", never touched the target, and a
filtered agent that stopped let the next roster answer seat another lead.

While the filter shows one agent, that agent is the only target:

- `canAddress(target, shown)` (`hub-composer.ts`) is the one predicate.
  `setRecipient`, the one target writer, asks it first. So a card, a menu's
  Message / Message everyone / Message team / Record only, @all, a team name,
  and the spawn, restart and reply auto-picks are all refused by the same line.
  No path needs its own gate.
- The controls derive their state from the same predicate, which makes the
  dimming true. The cards' select, the team names and the @all command are
  `aria-disabled`, never natively `disabled`: each stays focusable, so its menu
  keeps a keyboard and context entry on every engine (review P2-C; the first
  cut disabled @all natively and relied on Chromium passing contextmenu to its
  wrapper). A click or keyboard activation reaches `setRecipient` and is
  refused there; a double-click on a refused card does nothing. The refused
  menu items are disabled. `CommandButton` gained `ariaDisabled` for this.
- Only target choice is locked. Watch, configure, restart, stop and switching
  the view ("Only its messages" on another card) stay. Leaving the filter is
  its own act (the card's "Show everything", its double-click, the search
  token's x, Back), and the target stays X afterwards.
- Showing a live agent selects it, through the same writer. "Only mine" is not
  an agent and locks nothing.
- The send checks the payload as it will be sent, at the one entry, before
  anything is cleared or sent: a message's address tokens (`mentionTokens`)
  after its attachments are expanded (`attachmentBody`; an uploaded file's
  name can carry one), and a slash command's own target (`slashCommand`).
  Every token counts, not only names on this client's roster (the first cut
  used `chipExtras`, which drops names the roster has not shown yet, though
  the server may already deliver to them; review P1-A). If any is not X, the
  draft, the attachments and the reply all stay, and the composer says
  "Showing only X. To send to @Y, leave that view first." Nothing is stripped,
  and the filter is not cleared for the person. Typing `@Y` is explicit, but
  while reading only X it is the same slip.
- A stopped X receives nothing, and the lock's one target is then nobody
  (`canAddress(target, X, live=false)` admits only ''). Filtering an
  already-stopped X reaches the same state a running X reaches when it stops:
  the previous target is dropped, not kept (review P1-B: filtering a stopped
  bob left alice as the target, and bob's return was then refused as
  "stopped"). The roster seats no other lead while X is shown (the direct
  writes in `loadAgents` and the review-block auto-recipient ask too). The
  composer says that X is stopped and cannot receive, and nothing is
  sendable. When X runs again, the roster's answer selects X. Leaving the
  filter while X is stopped keeps the target as shown: nobody.

Considered and rejected (#482 design round): the filter FOLLOWING the target,
where a tap on another agent moves both and @all or a team ends the filter.
That has no disabled control, but a mis-tap on @all or a spawn's auto-pick
still sends to the wrong place while both states agree. It is a different
product from the one the owner asked for.

`hub-composer.test.ts` pins the predicate and the send check.
`Hub.mount.test.ts` pins the actual posts and commands: the menu filter, a
disabled card, @all and its menu, a team, the menus, a restart's pick, the
body, unknown-name, attachment and slash addresses (draft, attachment and
reply kept), a stopped X both ways in, and leaving the filter. `Hub.source.test.ts` pins that
the lock sits in the writer and before the send clears anything.

### Three ways a message lands, and they are not shades of one thing

a name (the default lead) types into ONE agent's input; `@all` types into EVERY managed agent's input, so every agent starts a turn at once; no recipient records it in the room and interrupts NOBODY (agents see it at their next `tmm log`). A line is never typed back into the pane of the agent that sent it, except a fired wake and a post from a script that agent left running (board #285, tmm-cli.md § Self-wake). The third was once labelled "everyone", which was exactly backwards — it is the one that reaches nobody live.

### A kiro pane is never typed an `@` (board #436, 2026-10-20)

Owner, 10:27: "wake 的消息好像没有正确发送给 kiro". A `[wake] @engineer task fashion43 …` (nine newlines, 407 bytes) sat in engineer's composer as `› [tmm chat 2026-10-20 08:40] engineer: [wake]` plus the chip `m3-g2-engineering-appendix.md  114 lines`. That is a file attachment, not a paste: kiro-cli's `@` FILE PICKER fuzzy-matched `@engineer` to lingting's `docs/m3-g2-engineering-appendix.md`, and our Enter SELECTED it. The line was never submitted. Its receipt was reported `unconfirmed` only at 10:26, when the owner opened the feed: `sweep_deliveries` then ran only on a live feed read. Since board #437 it also runs on the capture tick and posts a room line (agent-status.md § An unconfirmed line is reported on a clock). The #355 stall nudge did not apply either, because it answers a turn that ENDED empty, and no turn had started.

The mechanism, read from kiro-cli 2.32.0's `tui.js` (`--agent-engine v3`):
- The triggers are hard-coded: `[{key:"/",type:"start"},{key:"@",type:"inline"}]`. An inline trigger is the `lastIndexOf("@")` in the text before the cursor, so ANY `@` anywhere in a typed line counts, a code sample's or an email's included.
- Enter goes to the picker while `activeTrigger.key === "@" && filePickerHasResults`.
- That flag is set by an async file search.
- No `chat.*` setting turns the picker off.

The screen guard that used to sit in `tmux::send_command` was measured against this. It read the screen once at the 200 ms beat, sent Escape if the picker's footer (`esc to cancel · ↵ to select`, unchanged since 2.18.1) was painted, and then sent Enter. Measured on the real CLI (private tmux 3.6a socket, a 62×48 pane like engineer's, the userPromptSubmit hook killing the CLI before it returns):

| trial | workspace | shape | submitted |
|---|---|---|---|
| no guard | 1 file | paste, 200 ms, Enter | 0/1, the owner's screen |
| the guard as shipped | 1 file | 200 ms + footer check | 7/7 |
| the guard as shipped | lingting's 559 file names | 200 ms + footer check | 3/4; the miss is the owner's screen |
| a longer beat | lingting-shaped | 500 ms / 1 s + footer check | 3/3, 3/3 |
| `@` typed as `＠` | lingting-shaped | 200 ms, no guard | 3/3 |

The footer first painted 170-205 ms after the typing in the one-file workspace and 239-316 ms in the lingting-shaped one. So the guard was a race between one screen read and a search whose time depends on the workspace and the load. A longer beat narrows the race without closing it, and it would delay every kiro line that contains `@`.

**The rule (orchestrator ruling).** A delivery never types `@` into a kiro pane. `delivery::type_text`, which every delivery, held flush and steered line passes through, types `address::unaddressed(text)` (every `@` as the full-width `＠`, the #290/#367 neutralizer) when the window's backend says `Backend::at_opens_picker`. That is a fact in the backend's own file (`kiro::AT_OPENS_FILE_PICKER`). The screen guard left `tmux::send_command`; deliveries no longer need it.
- **What stays `@`.** The room, the feed and the delivery rows keep `@`. Only the bytes typed into kiro's composer change.
- **Receipts.** The receipt's canonical form (`telemetry::canon_char`, used by both `strip_ws` and `canon_with_origin`) reads `＠` as `@`, so the echo of the typed line settles the row it came from.
- **What the agent is told.** The kiro agent reads `＠` for every `@`, so its own config says so. `kiro::AT_TYPED_NOTE` is the last bullet of the collaboration flow, written by `render_kiro`: a `＠` stands for `@`; restore `@` when quoting code; write `@name` yourself when addressing. A running agent picks it up at its next restart, like any prompt change.
- **Commands keep the guard (validator P1).** A `/command` is typed verbatim (`hub_command`, the section above), so its `@` stays and can open the picker. Deleting the guard regressed exactly that path: on the validator's offline rig (kiro-cli 2.32.0, the lingting-shaped workspace), `/context add @mdc-datasets.md` submitted 1/5 without it and 5/5 on main with it, counted from kiro's own session history, while tmm answered `✓` every time. So `delivery::send_into`, the one door, keeps the one-read guard for a text that still carries `@` into a backend with `at_opens_picker`: before the Enter it reads the screen once (`Backend::picker_open`, kiro's footer `esc to cancel · ↵ to select`, both halves) and sends Escape when the picker is open, which closes it and leaves the line intact. A delivery never reaches it with an `@` (it was typed as `＠`), so only a verbatim command pays. Its limit is the race measured above: one read at the 200 ms beat against a picker that opens 170-316 ms after the typing. It is the imperfect, measured control for the one path that must type a raw `@`, not a replacement for `＠` on deliveries.

Pinned by `a_kiro_delivery_types_no_at_so_its_file_picker_never_takes_the_enter` (real tmux, the real wake path, ten deliveries). The fake CLI turns on bracketed paste, opens a "picker" 150 ms after any `@` it reads, and lets an Enter with the picker open attach a file instead of submitting. Every delivery submits with `＠`, its receipt settles on the typed echo, and the room keeps `@`. A `/command` with `@` reaches the CLI as `@` and SUBMITS: the fake paints kiro's footer when its picker opens and closes it on a bare Escape, which the door's guard sends. In-test control: `send_command` typing `@` directly into the same pane, without the guard, is picked. The footer matcher is pinned on 2.18.1 and 2.32.0 screens (`kiro::tests::the_picker_is_recognised_by_its_footer_only`). Also pinned by the `render_kiro` assertion in `kiro_home_is_isolated_and_wired_to_tmm`.

### A typed line's Enter submits in codex: paste-burst is off (board #446, 2026-10-22)

Twice a delivery sat unsubmitted in the reviewer's codex composer, once for ten hours (09:33 → 19:31). One Enter pressed by hand submitted it. All three stuck lines were SINGLE-line and long (542, 593 and 795 characters; what looked like lines in the pane was the composer's soft wrap), and the pane was idle each time. A single line is typed by `tmux::send_command` as one `send-keys -l`, then the 200 ms beat, then a named Enter. Only a line holding `\n` is a bracketed paste.

The mechanism is codex's paste-burst heuristic (`tui/src/bottom_pane/paste_burst.rs`), meant for terminals without bracketed paste. A fast run of un-bracketed keystrokes is taken for a paste, and an Enter that arrives while that burst is open is inserted as a newline. `send-keys -l` is such a burst, and whether the beat outlasts it depends on how fast codex consumes it, so it is a race that a long line loses. The "codex needs a beat before Enter" quirk noted on 0.148.0 is consistent with this mechanism; only 0.162.1 was measured here.

Measured on codex-cli 0.162.1: a private tmux 3.6a socket with `extended-keys on`, an 80×24 pane like the reviewer's, its keymap overrides, and an isolated `CODEX_HOME` whose provider is a dead local port and whose `UserPromptSubmit` hook records and blocks the prompt. The text is the real stored lines.

| shape | text | Enter after | submitted |
|---|---|---|---|
| `send-keys -l` (as shipped) | 632 B / 832 B | 200 ms | 0/10, 2/10 |
| `send-keys -l` | 632 B | 0 / 500 ms / 1 s | 0/5, 1/3, 3/3 |
| `send-keys -l` | 60–200 B / 300–400 B | 200 ms | 9/9, 3/6 |
| bracketed paste | 632 B, 3-line | 200 ms | 5/5, 5/5 |
| `send-keys -l` + `-c disable_paste_burst=true` (legacy key) | 632 B / 832 B | 200 ms and 0 | 40/40 |

A second Enter two seconds later submitted every miss. codex's default keymap misses the same way (0/5), so the input mode is not involved.

**Which key wins** (reviewer P1). codex's [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) says `tui.disable_paste_burst` takes precedence over the legacy top-level `disable_paste_burst`. The managed home's `config.toml` is the user's own (symlinked), so a user setting can sit under either key. Measured on 0.162.1, same rig, the 632 B line, Enter after 200 ms, 10 trials each:

| inherited config.toml | launch override | submitted |
|---|---|---|
| `[tui] disable_paste_burst = false` | `-c disable_paste_burst=true` | 0/10 |
| both keys `false` | `-c disable_paste_burst=true` | 0/10 |
| `[tui] disable_paste_burst = false` | `-c tui.disable_paste_burst=true` | 10/10 |
| top-level `disable_paste_burst = false` | `-c tui.disable_paste_burst=true` | 10/10 |
| both keys `false` | `-c tui.disable_paste_burst=true` | 10/10 |
| neither | `-c tui.disable_paste_burst=true` | 10/10 |
| neither | `-c disable_paste_burst=true` | 10/10 |
| neither | none | 0/10 |

So the legacy override loses to a user's `[tui]` false, and the `[tui]` override wins against every adverse config tried. 0.162.1 reads the `[tui]` key with no legacy key present, so the legacy key is not set as well. In the user's file alone, a `true` under either key switched the heuristic off (both orders measured, 10/10).

**The rule (orchestrator ruling).** `render_codex` launches every managed codex with `-c tui.disable_paste_burst=true`, the codex config key that wins, on the launch line like its other answers (agents-overview.md § codex's startup screens). A person's own paste arrives bracketed from the terminal, the path the heuristic does not handle. Rejected alternatives:
- A longer beat: it only moves the race (500 ms: 1/3).
- Pasting every codex line: a second typing path for one backend, where the CLI has a door.

The beat stays for what reads the screen before the Enter (kiro's picker guard). A running codex gets the flag only at its next launch, so restart codex agents after deploying.

Pinned by `codex_launch_line_pre_answers_its_startup_prompts`: the exact `-c tui.disable_paste_burst=true` token on the launch line, and no legacy top-level token (control: the legacy key fails the pin). The race itself lives in codex, so it is measured above, not faked in a test.

### A busy queue-mode agent gets its lines combined at the turn's end (board #257, 2026-09-28)

Owner, 2026-09-28 02:44: "如果在短时间内一下子有大量消息堆积，就会让 kiro 响应的实时性受到很大的影响…kiro 有堆积未处理消息时，可以合并投递". Before, every line typed at a busy queue-mode agent sat in the CLI's own queue and was drained ONE per turn boundary, each its own turn with its own full reply: a burst of 20 lines cost 20 turns, and on 2026-09-27 builder's median delivery lag was ~19.5 min, p90 ~44 min (`temp/stall-analysis.md`).

Every delivery (`@name`, a board notice, a `[reply]`, a typed brief) takes ONE path, `projects::delivery::deliver`. When the target window's turn is open (`telemetry::turn_busy`: `running`/`waiting` by `derive_from`, never pane activity) AND the session RUNS queue on a backend that has the switch (kiro, codex; `delivery::input_mode`, read at typing time: kiro's pane says its live mode — Ctrl+S toggles it for the session — and the launch recipe's `input_mode` is only the start mode, `''` = queue; board #271, see agents-overview.md § the input mode), the line is HELD: a row in the one `deliveries` table with `held = 1` (schema v26), persisted, not typed, invisible to the echo match and the sweep. It is typed later, in order, each line whole with its own stamp, joined by a blank line, as ONE prompt; the #249 matcher settles every row from that one echo, and `reply_targets` parses every stamped line, so each distinct requester gets one reply (#256). Delivery is still typing into a pane, later and combined.

- **Triggers, no timer**: the turn's end edge (`completed`/`failed` stop hook); the next delivery to that window when it is idle (the new line goes BEHIND the held ones); the feed read (`hub_activity`, beside `sweep_deliveries`), which catches a stop that raced the hold; and server start (`delivery::flush_on_start`, orchestrator decision 3): every window with held rows whose RECOVERED turn is idle is flushed at once, so held lines never wait for a client to read the feed. Every decision and typing for a window runs under one per-window lock, so a line is never typed twice. The mode is read under that same lock, and a queue/steer switch (#271) holds it across its key and its verify, so a line is decided against the mode before a switch or after it, never between the read and the hold (validator 04:48: a line read as queue, then a confirmed switch to steer, was still held). The lock order is window lock, then the pane's send lock, everywhere, so the two never deadlock.
- **A CLI that LOSES typed text** (`Backend::loses_busy_input`: dsh, board #404 — its one-turn run owns the TTY in raw mode until it exits): in either mode (queue|steer since #410), ONE occupancy rule (`delivery::strict_occupied`, asked by the delivery decision and every flush trigger) holds its lines unless the CLI side says it is ready (`Backend::input_ready`: the shell's ready file, or in steer mode the run's reader claiming the pane) and no line typed there has echoed yet; it never takes the busy-steer path that owes no echo, because a steered dsh line echoes. Turn edges are not readiness: an interrupt ends the turn before the shell is back. The overdue rule below never releases into its running turn; a line held past `HOLD_MAX_SECS` is reported once instead (`held (the agent has not returned to its prompt): …`), and a hold that cannot be written while it is occupied is `undelivered`, nothing typed. See agents-overview.md § The dsh backend.
- **A window that is gone** (any backend): its held lines are said `undelivered (its window closed)` once each before they are retired — they used to vanish silently, and the sweep never reads held rows (board #404 review). Only a pane listing that SUCCEEDED retires a window: a failed read proves nothing (`a_failed_pane_read_is_not_proof_that_a_window_is_gone`). Rows recovered after a restart are covered by their windows' held rows, not only by this process's records (`held_lines_of_a_window_that_is_gone_are_reported_undelivered`).
- **Idle target, steer mode, claude/omp/kimi/grok**: typed at once, as before. A line for a BUSY steer-mode session goes into its running turn and owes no echo (board #276, agent-status.md), so it is never reported `unconfirmed`; so does a line that arrives while the previous one typed into an idle steer session has not echoed yet (#281).
- **Cap**: `FLUSH_MAX_CHARS` = 32 KiB per combined prompt, whole lines packed oldest first; the rest wait for the next end (so an overflow is the fewest prompts, and later arrivals still join them); a single longer line goes alone, never cut. Measured 2026-09-28, kiro-cli 2.22.1: a 64,147-byte multi-line paste was submitted whole and its delivery acked; 32 KiB leaves codex (not measured at that size) the same headroom.
- **Interrupt** (`hub_agent_interrupt` / `tmm agent interrupt`; orchestrator decision 1): the held lines are DROPPED, one `undelivered (interrupted)` warn each, no row id, no retry — the person asked the agent to stop, and kiro's own Escape clears its queue the same way; senders resend. Measured live: the held line became the warn, the agent read idle. The Escape itself goes through the delivery send door as THE interrupt (`delivery::send_key_into`, board #422 round 3): never refused because a restored window is not ready yet, but written only into a restored window's own bound pane, so a refused key (respawned or unreadable pane) is an error and posts no `[tmm] interrupted` line; see projects.md § the send door.
- **Copy mode at the flush** (orchestrator decision 2): the lines stay held, ONE `held (pane in copy mode): N lines will be typed when it clears` warn (the rows' `warned` mark, cleared when they are typed), retried at the next trigger — the sender was already told it is queued. Measured live: held + one warn while in copy mode; after `q`, the next delivery typed both lines as one prompt.
- **Escape pressed IN the pane** (not through the hub): kiro-cli 2.22.1 cancels the turn ("Cancelled streaming") and fires NO hook, so the window reads `running` until its next turn — the same limit status derivation has. A line held longer than `HOLD_MAX_SECS` (300 s) is therefore typed at the next trigger even though the window reads busy (never for a CLI that loses typed text, above): a busy queue-mode CLI queues it itself (the pre-#257 behaviour, still one combined prompt), an idle one starts the turn that corrects the state. So a very long turn receives at most one combined prompt per five minutes, and a deafened agent recovers within five.
- **A person typing in the pane**: kiro submits the person's queued line at the turn's end and starts that turn; our flush lands in the new turn and kiro queues it behind — still one prompt. A half-typed, unsubmitted line gets our text appended and submitted with it; that risk exists for every idle delivery and is not new.
- **Team context**: computed when each line is delivered, bounded at the target's previous delivery. Every held line is itself addressed to the target, so the deltas abut and a room row reaches the combined prompt at most once (`held_lines_contexts_abut_without_repeating_a_room_row`).
- **Restart**: held rows are rows; `recover_open_turns` replays the turn, and the lines go at its end (still running) or at server start (idle). A session whose log cannot be read is UNKNOWN (#394, agent-status.md): its held lines are released by nothing, however old, and a new line for a queue or steer window there is held, until its log is read or the window has a turn fact of its own. Every path that types held lines asks ONE rule, `delivery::may_release` (known, and not busy or — for a CLI that queues typed text itself — overdue): the delivery decision (`deliver_gated`) and every flush trigger (`flush_at`: the end edge, the feed read, the server start).
- **Failure handling** (validator 04:46–04:48, orchestrator 04:49): a hold that cannot be written (full, locked or read-only database) is today's behaviour — typed at once as an ordinary delivery, and if that fails too, the existing `undelivered` warn; a line is never reported queued while stored nowhere. Not into an UNKNOWN turn (#394): there a hold that cannot be written is said `undelivered (its turn is unknown and the line could not be held)` and nothing is typed. The release of a batch is ONE transaction: every row flips to typed, or none does and nothing is typed (the whole batch stays held for the next trigger), so a batch is never half pending and half held. The 24 h delivery prune never deletes a held row: its `ts` is when it was held, and it is still owed. Each has a real-SQLite fault-injection test (TEMP trigger, as #249).
- **Reply edge across a restart**: a combined prompt can run to 32 KiB while the activity row keeps 1024 characters of text for display, so a second requester can sit past the cut. The prompt row also stores its requesters (`activity.requesters`, schema v27), parsed once from the FULL prompt by `address::requesters` — the same parser the live reply edge uses — and written in the SAME `INSERT` as the row, under the turn-fact lock (validator 05:04: a second `UPDATE` left a window where a durable prompt had no senders; a failed write now leaves no row at all). Recovery reads that column, parsing the text only for older rows. No prompt body is stored beyond the display text.

Measured end to end 2026-09-28 on kiro-cli 2.22.1 in a scratch stack (own config dir, port and tmux socket): a `sleep 60` turn, 10 messages from two senders during it → 10 held rows, nothing typed; at the stop ONE prompt carrying all 10 lines, one echo settling all 10 rows (`deliveries` refs 10), and one reply routed to `["lead","validator"]`.

### A reply quotes a message by its content (board #290, 2026-09-30)

Owner, 10:55: "回复时可以直接点击某一条消息，底下应该出现一个 reply to，相当于引用这条消息去回复，然后发送给 Agent 时可以带上引用的那条消息的内容…你看是通过 index 或者什么样的方式去引用比较高效". The reference is the CONTENT, not an index: a delivered line is all an agent sees, no `tmm` verb fetches a message by id, and nobody can read a uuid, so a bare seq or id would cost every reader a lookup. The quote rides in the line and the record stays self-contained (tenet 4).

- **The token, built once, by the server.** `hub_post` takes an optional `re` (a message id, or its room `seq` when all digits) and builds `[re <sender> <when>: 「<excerpt>」] ` from its OWN stored row (`<when>` is `HH:MM` for a message from today and `YYYY-MM-DD HH:MM` otherwise, the client's `localWhen` rule, `quote_when`) (`address::quote_token`), inserting it after the body's leading `@addresses`: `@builder [re lead 10:41: 「＠lead please review #289」] which P1?`. The composer and `tmm send "@name text" --re <seq|id>` both send `re` and never format the token, so there is one set of rules, the CLI is at parity by construction, and the sender and time come from the record, not the client (orchestrator 11:30). A `re` naming a message of another room, or none, is `InvalidParams` (`rooms::message_by_ref` looks inside this room only). A `--re` with `--in`/`--at` is refused: a scheduled wake carries no quote.
- **The excerpt.** The quoted body's first non-empty line, whitespace squashed, cut to `QUOTE_CHARS` (120) characters with `…`; never multi-line. Two characters change inside it, and only there: `@` becomes the full-width `＠`, because every mention parser (`address::mention_names`, the client's `mentionTokens`) reads ASCII `@` only, so quoting "@lead please…" never delivers to lead or lights lead's card; `」` becomes `”`, so the first `」]` always ends the token (`parseQuote`). The reply's own addresses stay first and deliver as always; #283/#285's sender rules read the body as before.
- **The composer.** `Reply` in the bubble's `.m-acts` row (beside Copy and Raw, the `arc-left` glyph) holds the message's id, sender and a preview line (`quotePreview`) as a chip in the pending row (the attachment chip's species: `Replying to <name> · <first line>` and ×). One per send; ×, Escape (a layer after the action row and the palette: one Escape peels one; the listener is installed while the chip is up, validator 12:23), Back (a layer after the filter) and a room switch drop it, and a failed post keeps it with the restored draft. Replying to a managed agent with no recipient chosen seats that agent; an explicit recipient is never overridden.
- **The feed.** A body with the token renders it as the bubble's own `.md blockquote` (`.m-quote`: `sender · time`, then the excerpt) above the text, which is parsed without the token (`parseQuote(body).text`). Raw shows the body as sent. The token is plain text, so `tmm log`, notifications and an older client read it as written.
- **Pinned by** the ONE case table in `address.rs` (`a_quote_token_carries_the_first_line_and_addresses_nobody`: each token addresses nobody under `mention_names`), which `hub.test.ts` reads and runs through `parseQuote` and `mentionTokens` (an `@builder` reply over each quote yields exactly `['builder']`); `a_reply_quotes_a_message_of_its_own_room_after_the_addresses` (by id and by seq; another room's message refused; the quoted `@lead` adds nobody to `to`); `Feed.source`/`Composer.source`/`Hub.source` for the wiring; the `--re` flag in `tmm`'s valued-flag test. No schema change.

### A `/command` goes to the CLI, not to the model

`/model`, `/clear`, `/compact` are interpreted by the agent's TUI and only as a whole line, so `hub_command` types them VERBATIM into the pane — no `[tmm chat …] human:` stamp, no @address (owner, 2026-08-19). `slashCommand()` (pure + tested) requires the first token to be `/word` with NO second slash, so `/tmp/foo` and `/usr/bin/env node` stay messages; it needs a target (explicit `@name`, else the composer's recipient, `@all` = every managed agent) and falls back to an ordinary message when there is none; managed windows only (a `/clear` typed into a SHELL would run as a path); and the room records it as a `[tmm] ` lifecycle line, never a message, so the mention scanner cannot feed it back. The feed nevertheless draws that line as the sender's own bubble (board #264, hub-feed.md): what is stored is a record for the machine, what is shown is what the person said.

**An agent sends one the same way (board #274, 2026-09-29).** Owner, 08:04: "leader 这个 Agent 有时候可以直接发送一个 /compact 给其他 Agent 来压缩它的上下文". `tmm send "@dev /compact"` used to be `hub_post`, so dev received `[tmm chat …] lead: @dev /compact`, which its model read as prose and its CLI never ran. Now `tmm send` reads the body with `address::slash_command`, which is the composer's `slashCommand` rule on the server side. When the body is one `@name` (or `@all`) followed by `/word`, it calls `hub_command` with `from` = the calling agent, and the text is typed verbatim. Without an address, with `--status` or an image, it stays an ordinary message.
- **One rule, two readers.** The rule has to run in the client before a send (the composer picks the RPC) and in `tmm`, and moving the composer's choice to the server would change its wire. So the Rust function mirrors the TS one, and the ONE case table lives in `address.rs` (`a_slash_command_is_read_like_the_composer`). `hub.test.ts` reads its rows and runs `slashCommand` over them, the same pattern as #248's mentions.
- **The sender.** `hub_command` takes an optional `from` (absent = `human`). The room line `[tmm] /compact → dev` is posted under it, so the feed shows the agent's own bubble. `all` skips the sender's own pane, and a command to itself is refused before anything is typed, because it would land in the very turn that sent it.
- **Who can be commanded.** `@human` is a chat recipient, never a command target: `tmm send "@human /compact"` stays a room message with its exact body (validator 08:34, orchestrator 08:36). A named target that is no managed agent fails loudly (exit 4, "no managed agent named 'ghost'"), because a command aimed at nobody is a mistake, not a room note. `tmm` checks the roster (`hub_agents`) before `hub_command`. The routing is `send_route` in `tmm.rs`, pinned by `tmm_send_routes_a_command_like_the_composer_but_never_to_the_human`. Negative control: without the `@human` rule it fails.
- **Pinned by** `an_agents_command_names_it_skips_it_and_is_refused_to_itself` (real tmux). Negative control: the pre-#274 `hub_command` types `all` into the sender and records it as human.

**Not into a window a restore holds (board #422 round 3).** `hub_command` is the one typer outside `projects::delivery`, so it asks the same barrier delivery asks (`restore_hold::held`): a window a reboot restore made and has not seen ready may still be a shell, where a `/word` runs a path. That window is refused with `restoring, not ready` and nothing is typed; the other targets of an `all` are unaffected. Pinned by `a_command_into_a_window_a_restore_holds_is_refused`.

### An address starts a word (board #248, 2026-09-27)

Validator found during #242 that the server split a body on every `@`, so `mail me at a@bob` typed into bob's pane, and `a@bob.dev` addressed a window named `bob.dev`. The other edge was broken too: the address ran to the next whitespace, so `(@bob)`, `@bob，` and `@bob。` named nobody. The room holds real cases of both: 85 `@` right after an ASCII letter or digit (emails, `pkg@2.4.0`), and about 20 names followed by full-width punctuation or markdown.

`address::mention_names` (a leaf module, so the phone's server and `tmm` compile it too) is now the one server reading, used by `deliver_mentions`, the stored `to` and `tmm send`'s recipient check. The client's `mentionTokens` mirrors it in code points with Rust's own classes (`\p{Alphabetic}` or `\p{N}`, which is what `char::is_alphanumeric` means; `\p{L}` missed combining vowel signs such as Devanagari's, and a fixed two-unit slice split a non-BMP letter after `.`, both found by validator). There is ONE case table: `hub.test.ts` "mentionTokens reads an address…" reads the rows of `address.rs` `an_address_must_start_a_word` out of the Rust file, so a case added on one side runs on both. Both edges come from ONE definition of a name character, `address::name_char`, which `valid_name` also builds names from (orchestrator, #248), so a name can never hold a character the parser would cut:

- The `@` must start a word: at the start of the body, or after anything that is not an email/host character (ASCII letter or digit, `_ . -`). `(@bob)`, `"@bob"`, `/@bob` and a CJK character right before it (`请@bob`, which the owner writes) are all addresses.
- The address is the run of name characters after it (letters and digits of any script, `-`, `_`), so any trailing punctuation ends it. A run followed by `.` plus a name character, or by another `@`, is a host or an address, not a name (`@bob.dev`, `@a@b`).

A CJK word glued to the name (`@bob看看`) still reads as one run, because CJK characters are letters; that stays as before. Pinned on the delivery path by `an_in_word_at_delivers_to_nobody_but_a_bracketed_address_does` (real tmux, `hub_post`). `every_valid_name_is_addressable_whole` pins the one-definition claim: every name `valid_name` accepts reads back whole from `(@name` plus any punctuation. Negative controls: without the word-start check both Rust tests and the client table fail; letting `name_char` admit `.` fails the table and the one-definition test; the client with `\p{L}`, or with the old two-unit slice, fails the shared table.

### `@` completion rides the `/` palette (board #242, 2026-09-27)

Owner: "输入“@”，可以提示我 @ 某一个 Agent 的候选项". `mentionPalette`
(`hub.ts`, pure and tested) returns the same `Palette` shape as
`commandPalette`, so the popover, the arrow/Tab/Enter/tap keys, Escape and
the back layer are the existing ones; there is no second list. It
completes only the LAST token, and only an `@` at the start or after
whitespace: an `@` inside a word (`me@b`, an email address) does not open
the list. Since #248 delivery reads an address by the same word-start
rule (see "An address starts a word" below). The
candidates are exactly what delivery reaches: the room's
managed agents (hint: backend) and `all`. Team names are not offered: a
body `@team` names no window and reaches nobody; a team is addressed by
its tab (orchestrator, #242). A query that already equals the only
remaining candidate offers nothing (since #398 by the composer's one rule,
`offeredPalette`), so Enter after a finished `@bob`
sends instead of re-completing. A slash-command line (the same
`slashCommand` test `send()` uses, with or without a leading `@name`)
offers no names, because it is typed verbatim through `hub_command` and a
name inside it reaches nobody (validator, #242: `/compact @b` offered
`@bob`).

### `#` completion rides the same palette (board #340, 2026-10-15)

Owner: "增加一个（#）的规则吧 井号可以去引用我 board 的信息". `issuePalette`
(`hub.ts`, pure and tested) is a third source chained into the composer's
ONE `palette` value, after `/` and `@`: same `Palette` shape, popover, keys,
Escape and back layer (pinned by `Composer.source.test.ts` "/, @ and # are
ONE palette"). It reads the last token like a mention (`issueQuery`): a `#`
at the start or after whitespace, then letters, digits, `_` or `-`, so
`page#3`, `##` and a slash-command line (typed verbatim, the command
palette's) open nothing. The candidates are this project's issues
(`hub_board_list`, the existing read; no new RPC): matched with
`fuzzyRank` on the number and on the name (`board.ts` `issueRef`: the title,
else a body excerpt, which is also the hint); an exact number first, then
the better match, open (not `done`) before done, newest first. Accepting
inserts `#<id>` and a space — no title, no body: the delivered text is
exactly what was typed, and an agent reads the issue with
`tmm board show <id>` (orchestrator's ruling, #340). A query that already
is the one remaining candidate offers nothing (since #398 by the
composer's one rule, `offeredPalette`), so Enter sends.

The list is Hub's, kept per project (`issueBoards`), and is READ ONLY WHEN
NEEDED, never on a poll: each time a `#` query is entered in a room (the
composer's `onissues(room)`, keyed by the room as well as the entry, so a
restored `#` draft in another room reads THAT room, and typing on inside the
query reads nothing more; reviewer P2-B on 0d48bdda), and when a message
names an id above the board's newest (see hub-feed.md "A `#<id>` in a bubble
is a door to that issue", which also says what is kept apart: the last
successful snapshot, the reads, the triggers). A room nobody references
reads no board. A failed read keeps the last snapshot.

### Enter accepts only a change; a finished item sends (board #398, 2026-10-16)

Owner (screenshot: `/model claude-opus-5.5`, caret at the end, the list
still showing `claude-opus-5.5 · model`): "按 tab 补全了一个，这时这个命令后边还
没有空格，按回车就发不上去，要这时也能够按回车". The cause, read in code and
in the composer: the argument stage of `commandPalette` keeps offering an
argument that is already typed whole, the composer's Enter accepted
whatever item was selected, and accepting rewrote the text to itself (an
argument takes no trailing space), so Enter did nothing. The `@` and `#`
sources hid the same shape with their own "the query is the one candidate"
checks; the slash sources had none.

**The rule** (orchestrator, #398): Enter accepts the selected item only
when accepting CHANGES the text; otherwise it falls through to what Enter
does with no list (it sends on a desktop; on the phone it is the newline,
and Send is tapped). Tab always completes, Escape always closes, a tap
always accepts. `acceptChanges` (`hub.ts`, pure) is the ONE reading, for
every source: the selected token differs from what is typed (a longer
completion, another case) is a change; so is an item that opens a list of
its own, which is how a typed `/model` still gains its space and its
argument list on Enter. A token already typed whose acceptance adds only
the separating space (`/compact`, `@bob`, `#340`) or nothing at all (a final
argument) is not.

**"Opens a list" is the command's DECLARATION** (review P1-A on 1b9af621,
orchestrator): `commandPalette` marks a command item `opens` when its table
row declares arguments (fixed `args`, or `dynamic` values that are
fetched), never by asking whether a list for the accepted text would show
now. The first version asked exactly that, and grok's `/model` (fetched
model ids only, no fixed arguments) failed cold: before the models arrived
there was no list for `/model `, so the typed `/model` read as "changes
nothing", its list closed, Enter sent a bare `/model`, and the fetch, which
waited for a list to show, never started. The fetch now reads the
declaration too (`wantsFetchedArgs`: a slash-command line of a backend whose
table declares fetched values, and no cache yet), so it does not depend on
a list that needs it. A failed fetch is asked again by the next keystroke,
as before.

**A list whose one item changes nothing is closed** (`offeredPalette`, the
same rule): a finished `/model claude-opus-5.5`, `/compact`, `@bob` or
`#340` shows no list, so nothing on screen suggests Enter would do
something else. It replaced the `@` and `#` sources' own checks (one
mechanism for one job). A list with more items stays (a typed `@bob` with
`@bobby` offered), and Enter on the typed one sends.

**An exact match ranks first** (`fuzzyPick`, orchestrator, #398): a
candidate that IS the query leads its list, before the prefix tier, the way
the `#` list already put an exact number first. With `claude-opus-5.5`
listed before `claude-opus-5`, a typed `claude-opus-5` was a prefix of both
and the longer one led, so Enter replaced what was typed. The same spelling
leads another case of it, which leads the tiers (review P2-B: `Bob` and
`bob` are two valid names and delivery tells them apart, so a typed `@bob`
must not become `@Bob` because it was listed first; with no same spelling,
`Claude-Opus-5` still finds `claude-opus-5` first, and accepting it is a
change). Without an exact match the tiers and the table order are
unchanged.

Pinned by `hub.test.ts` "one rule for every palette" (each stage's change
and no-change case, a different case is a change, exact-first in commands
and mentions, the same spelling before another case, a cold grok `/model`
and `wantsFetchedArgs`) and four `Hub.mount.test.ts` cases (#398). A cold
grok `/model` with the fetch held: the list stays, the fetch is asked, Enter
takes the argument level and sends nothing; a failed fetch sends nothing
and the next keystroke asks again; once the models arrive the argument list
completes and the finished argument sends. With `Bob` listed before `bob`,
a typed `@bob` sends `@bob`, and a typed `test-model` with `Test-Model`
listed first sends `test-model`. On the desktop a
partial argument is completed and not sent; the completed argument, then
Enter, sends it; Tab then Enter sends for a slash argument, a slash command
and a mention; a typed `/model` opens its argument list; an IME
composition's Enter neither sends nor accepts; ArrowDown to the longer item
makes Enter accept it. On the phone (a hardware keyboard sends the same
events): Tab and a partial's Enter complete, a finished item's Enter is the
newline and does not rewrite it, and Send sends.

### The `/` palette is transcribed, not invented

`KIRO_COMMANDS` (`hub.ts`) carries kiro-cli's own names/descriptions/sub-commands copied from its TUI table — a made-up command looks authoritative in the list and then does nothing in the pane — minus cloud-only/hidden entries, with `/quit` last.

**Only commands that DO something are offered**: kiro's `inputType: "panel"` ones (plus those that open $EDITOR or a recorder) would park the agent inside a view nobody here can see or dismiss, so `/tools`, `/help`, `/mcp`, `/context`, `/code`… carry `view: true` — they stay in the table WITH the reason and `OFFERED_COMMANDS` filters them out (owner, 2026-08-19); re-enabling one is deleting a flag. Ten remain, and `/agent` offers only `swap` because create/edit open an editor.

**dsh has no commands of its own, so its palette is the APP's** (board #411, owner 2026-10-17: "应该支持一些slash command 比如切换模型之类的"). dsh-headless has no slash commands (`dsh-commands`, `dsh-command-compact` and `dsh-command-goal` serve its UI clients), so a `/word` typed into a dsh pane is a task string for the model. Non-negotiable 12 says a `/command` goes verbatim to the CLI; this is the honest exception, declared per backend: `Backend::app_command(name, args)` (in `backends/dsh.rs`) returns the command the APP runs for that backend, `None` for everything else, which is typed verbatim exactly as before. Today only dsh has any. `DSH_COMMANDS` offers exactly those three (a test reads `backends/dsh.rs` and compares the names, the effort levels and the model ids):

| command | what happens | applies |
|---|---|---|
| `/model <id>` | the agent's registry definition gets the model; the id has the syntax the shared validation door demands of every dsh model (`models::validate` → `Backend::model_id_error`: one token of letters, digits and `._:/-`, at most 100), so the editor, `tmm registry save`, a team member and `/model` agree; the palette offers the two ids the route's catalog lists, `deepseek-flash` and `deepseek-v4-pro`, but any id is accepted ("the model id passes through to the wire") | the NEXT turn |
| `/effort off\|low\|high\|max` | the definition gets the effort (the deepseek-official route's levels; anything else is refused naming them) | the NEXT turn |
| `/new` | the next line starts a new conversation. The command's ONLY write is the request, `<home>/dsh/tmm/new`; the managed shell owns everything after it: when it starts the next turn it consumes the request, deletes the recorded session and starts without `--session-id` (whatever session is recorded or a restart handed back as `TMM_DSH_SESSION`), so it holds across a restart, and a command can never delete a session id the shell has already replaced; the plugin's later session write records the FRESH conversation. **Refused while a turn runs** ("wait for it to end, then send /new again"): the running turn's plugin records its session when its first event arrives, which could land after the command and be taken for the new conversation, so refusing removes that race instead of racing it. The old session stays on disk | the next line |

`hub_command` does NOT type these. `Backend::app_command` parses the arguments (a usage error is refused to the caller with nothing changed), `projects::live_config::run` executes the meaning. **The model and the effort are saved FIELD-SPECIFICALLY** (`registry_set_model_effort` reads the current row in the section that writes it), so a concurrent `/model` and `/effort`, or an editor save of the skills, MCP or system text between a snapshot and the write, cannot be undone by a stale whole-object save. The save projects the definition into the running homes (below). The room records the usual `[tmm] /model deepseek-v4-pro → name` line, with `(other windows not updated: …)` when a window of the same definition could not be.

**The projection is reported, never assumed.** Every dsh turn is a fresh process that reads the profile, so a saved definition reaches a RUNNING dsh window by re-rendering the profile's patch layer in its home (`Backend::write_live_config`, `live_config::rerender_all`), in `registry_save` and `teams_save` themselves: the Agents editor, `tmm registry save` and the commands are one path. What a projection came to is one of applied, already-current, not-applicable (another backend), unknown (a dsh home whose recipe cannot be read, or that was never rendered: what it runs is not known) or failed; nothing is inferred from the absence of an error. Every home that is unknown or failed is returned in the save's answer as `unapplied: [{project, window, definition, team, bases, kind, error}]` (`kind` is `failed` or `unknown`) (a failure of discovery, a project that cannot be listed or an agents directory that cannot be read, has an empty `window` and is a failure, never an empty list). It is scoped by ONE rule, `live_config::affected`, which reads a window's PROVENANCE (its `Lineage`: the registry definitions its LIVE-published fields derive from — the model, the effort and, since #412, the MCP list — with which a team member inherits rather than overrides; a member derived from a base always takes the base's MCP list, `teams::member_def` has no MCP override; and its team path), never the display label: a whole-definition save reaches the windows that follow the definition and the team members that inherit ANY of those fields from it (a member overriding both model and effort still inherits its MCP rows, so a failed write there is that save's, `an_mcp_only_save_reports_a_failed_member_that_overrides_model_and_effort`), and a `/model` or `/effort` only those inheriting that field (an overridden field is the member's own, so it is not that change's); skills are not live-published (their links are the render's, applied at restart); a change to a CENTRAL MCP definition (`mcp_save`) is not projected either — a home picks it up at its definition's next save or at restart; a team save reaches the members under that team's path (sub-teams included); and a home that cannot be placed at all (an unreadable recipe, a failed discovery, a team or member that cannot be resolved) cannot be ruled out, so every change says it. The lineage is read from the SAME member the effective definition resolved (no second expansion), and a failed resolution is `unresolved`, which is not the same as an inline member with no registry base (that one is known to derive from none, so a definition change does not concern it). An unrelated definition's or team's failed home is not attributed, a genuinely affected inheriting member never disappears, and two projects with a window of the same name are told apart by `project`. The same list serves the definition save, the team save and the slash command (the command names the OTHER affected homes beside its own). `/new` is not under this filter: it is a per-home marker write, confirmed by its own home only. The definition stays saved (no rollback of a newer declaration). The Agents editor names each such window (and its project) in an alert on the page it returns to; a failed write says the agents still use the old settings, a home whose state could not be confirmed says "application not confirmed" (no claim of an old model, and a discovery error is not counted as an agent); `tmm registry save` and `tmm teams save` print them on stderr after the saved line, and a command for the window is judged by ITS OWN home, confirmed after the save: anything but applied or already-current FAILS saying what is saved and that sending it again, or a restart, applies it: a failed write says the home "still runs the old one", an unconfirmed home says "application not confirmed". A command to `all` where one window took it and another did not answers `refused` and names the window on the room line (`not run for …`). Each window is projected under its recipe section (the one `refresh_agent` holds over resolve and render), from the definition as it is at that moment, so a restart or an older projection cannot finish after a newer one, and the patch file is replaced whole (`write_atomic`) so a turn starting meanwhile reads the old or the new document. Only the patch layer is written under a running agent; the plugin and privacy settings it carries are part of every projection.

**Whose definition a window follows** is `effective_def`'s rule, shared (`spawn::team_defining`): a solo agent, a uniquified `dsh-2`, and a runtime-JOINED solo agent (it has a `team` but no `member`) follow their own registry definition; only a team member and a fork of one take theirs from the team, and `/model` and `/effort` on those are refused with that reason (a team save re-renders them). **`/compact` is not offered**: `dsh-command-compact` calls `ctx.compaction.compactNow(agent, …)` with the running agent of a live process and answers "the agent is not idle" otherwise; a headless turn is one process that starts a model turn the moment it has a task, so there is no process to compact between turns and a plugin cannot call it from inside a run without racing the turn it is part of. dsh compacts under context pressure by itself. Nothing is faked. Pinned by `hub.test.ts` (the palette equals the Rust table), the `live_config` tests (the definition, the profile, the refusals, a failing write with partial application, an unconfirmable home, a failed discovery, project and definition scope, a team save and a base save reaching an inheriting and an overriding member, the section wait and the held field update, both observed rather than slept for, a joined solo agent), the AgentsPage mount test (the alert names window and project, the save is not undone, a failed write and an unconfirmed home are worded apart), `a_failed_inheriting_member_is_reported_by_its_base_and_an_unrelated_team_is_not` (a read-only inheriting member of a base, an overriding member and an unrelated failed team: a `/model` on the standalone window, a base save and a team save each report exactly their own), the `dsh.rs` tests (a fake dsh in a real managed zsh: the next turn reads the new patch with no relaunch; `/new` across a restart and a late-written session; a reader at publication), `hub_rpc` "a dsh agent's model, effort and new are run by the app, not typed", and, through the REAL dsh against a loopback stand-in for the Messages API, `a_rerendered_profile_changes_the_model_and_effort_on_the_wire_of_the_next_run`.

**The palette speaks the ADDRESSEE's dialect** (2026-08-22): `offeredCommands(backend)` picks the table by the explicit `@name`'s backend, else the recipient — `GROK_COMMANDS` (transcribed from grok 1.0.5's own docs; its `/model` completes inline since grok models enumerate) and `CODEX_COMMANDS` (transcribed live from codex 0.148.0's `/` popup; there `/model`/`/permissions`/`/review` are PICKERS = views, and `/delete` is flagged destructive, never offered); `@all` over a mixed roster gets none. `commandPalette()` (pure + tested) decides stage/items/replace-slice: `/` → commands, `/model ` → its values (fetched via `models_list` PER BACKEND, the same call the agent editor uses), and only the LAST token + FIRST argument are completed because what follows one is a path or free text. Matching is FUZZY in three strict tiers — prefix, substring, subsequence (`fuzzyRank`, pure + tested; stable table order within a tier), with a candidate that equals the query ahead of all three (#398) — so `/mdl` finds `/model` and `son` finds `claude-sonnet-4.5` (owner, 2026-08-24: "不一定从第一个字符开始匹配"), while Enter stays safe because a looser match never outranks a tighter one (`/co` still means `/compact`). The palette owns ↑↓/Tab/Enter while open (Enter only when accepting changes the text, #398), Escape dismisses until the text changes, hover and the keyboard cursor share ONE highlight. The composer SPEAKS READLINE: Ctrl-A/E/U/K/W/Y/D/H/T/F/B via `readlineEdit()` (pure + tested) — one kill buffer, consecutive kills accumulate (backward prepends), any other key breaks the chain, A/E are line-scoped, Ctrl-K at line end joins, empty-buffer Ctrl-Y is a handled no-op (Chromium's default is REDO), Ctrl-C/V/X/Z fall through to the browser; the caret is set after Svelte writes the value back. A command-shaped draft STYLES the composer (accent-tinted capsule, tool-lane monospace) via `composerIsCmd`, which mirrors send()'s branch exactly; the measuring mirror flips font with the input in ONE rule, and `growComposer` re-measures on the flip (a font change rewraps).

**Every backend has a table since board #243** (owner, 2026-09-27: "斜杠命令…对于 claude Code 好像还不太支持，包括其他的也检查一下"). Measured in a throwaway project on this host with the composer's own door: a `hub_command` RPC typed each line into a real managed pane, and the pane was read back.

| backend (version) | delivery check | table |
|---|---|---|
| kiro-cli 2.22.1 | `/effort medium` → footer `high`→`medium` | re-read: `/memories` `/goal` `/workflow` `/voice` gone; new panels (`/changelog`, `/sessions`, `/settings`, `/config`, `/editor`, `/transcript`) and kiro-internal `/spawn` recorded as views |
| Claude Code 2.1.283 | `/effort medium` → "Set effort level to medium" | new `CLAUDE_COMMANDS`: `/model <alias>` (default/opus/sonnet/haiku, each switched without the picker), `/effort <level>`, `/compact`, `/clear`, `/plan`, `/rename`, `/exit`; bundled skills that also list under `/` are left out |
| codex-cli 0.154.0 | `/status` → inline status box | re-read: `/agent` → `/agents` (view), `/pwd` offered |
| grok 1.0.13 | `/effort medium` → the CLI's own answer ("current model does not support reasoning effort") | re-read: `/always-approve` and `/memory` gone |
| omp 18.2.10 | `/session` → modal; `/plan` → "Plan mode enabled" | new `OMP_COMMANDS`: `/compact` `/new` `/clear` `/plan` `/retry` `/context` `/usage` `/exit`; `/model` and `/session` are modals, `/delete` destructive |
| Kimi Code 2.0.2 | `/usage` → inline usage box | new `KIMI_COMMANDS`: `/compact` `/new` `/plan` `/goal status…` `/title` `/status` `/usage` `/version` `/exit`; `/model` opens a picker even with an alias, `/effort` levels depend on the model (K3 on Bedrock: only "on"), `/undo` is not offered |

Delivery itself needed no change for any CLI. One launch fix came out of it: a fresh omp home opened omp's setup wizard, where every typed line landed, so `render_omp` sets `OMP_SKIP_SETUP=1` ([agents-overview.md](agents-overview.md)). Some commands are recorded as views because they break delivery rather than park the pane: grok `/multiline` swaps Enter, codex `/vim` turns typed text into keystrokes, and `/statusline` (claude, codex) or grok `/minimal` change the footer the vitals sniffer reads.

### One attachment pipeline for every editor (board #329, 2026-10-09)

The staging that lived in `Hub.svelte` — the generation and per-job guard, the failed chip, the 1568px webp/jpeg encode, the 32 MiB file cap, the `.tmm/uploads/` layout with its self-gitignore, the `[img:n]`/`[file:n]` token at the caret — is `hub/attachments.svelte.ts` (`createStager(host)`, one per editor; `attachPaste(e, stage)` is the paste rule, Office text first). Its chips are `hub/AttachStrip.svelte`; the composer's reply chip renders through its `lead` snippet. Hub owns a stager for the room and keeps its send transaction: snapshot the set, DETACH it (`stager.pending = []`, never `clear()`, which revokes the thumbs and bumps the generation), revoke on success, restore on failure. The Board's three editors use the same stager (board.md § Images). Moved verbatim with one fix: `remove()` escapes the token as `/[[\]]/g`; the old `/[[\\]]/g` was a character class plus a literal `]`, so it never escaped `[img:1]` and the remove regex deleted ONE character of the text instead of the token (validator reproduced: `look [img:1] here` → `look [mg:1] here`). `Composer.source.test.ts` pins that upload, encode, the 1568 ceiling and the paste rule exist only in that module.

### Pure composer decisions (board #117, 2026-09-09)

`hub-composer.ts` owns palette-backend selection, `ALL_TARGET`, attachment
token spelling and body substitution; #168 adds the pure busy-target
selector described above. The original helpers were closure-local calculations;
parameterizing them adds executing boundary tests without changing behavior.
The selector still requires a managed target, keeps unknown targets empty,
and offers a shared dialect only when the managed roster has exactly one.
Substitution replaces the first matching token, appends missing-token
references in attachment order, and retains `String.replace` semantics.
The existing command/mention/readline parsers and command tables stay in
`hub.ts`; Hub keeps `send()`, staging and both send gates. Board #133 moves
the view-owned state and DOM as described below.

The mounted Hub test holds a file upload unresolved, presses Enter and
observes no post; after upload it observes the complete addressed body.
Removing the actual `attaching` guard is the negative control. This proves
the event-to-send path, not native clipboard behavior or layout.

### Historical extraction characterization (board #133, 2026-09-09)

Before moving the view, the mounted Hub characterizes readline caret after
settling, kill-buffer and draft lifetime across rooms, palette focus, all
three delivery destinations, compact/Shift/IME Enter, the mixed button/key
interrupt pair and its 3-second expiry/disarm rules. Deferred RPC replies
cover overlapping upload generations, failed chips and post/command rollback
across a room switch. The existing upload/Enter and Back tests stay unchanged.
These execute the real handlers but do not simulate clipboard insertion or
layout. Chromium 152.0.7977.64 separately captures the real view at 1440x900
and 390x844, light/dark and reduced-motion spots: short and overflowing text,
command mirror font, measured recipient indent, both menus and file chips.

The receipt and recipient menu share the dashed `.note-dot` in
`hub-atoms.css`, beside their shared `.st` box. Its former scoped declaration
is relocated once, with the same two-class specificity and restricted parent
selectors, so extracting the Composer does not duplicate it or restyle
embedded Files/Terminal/Board content.

### Historical view ownership (board #133, 2026-09-09; superseded by #168)

`Composer.svelte` owns the capsule, textarea/mirror sizing, paste/key adapters,
palette/model cache, readline kill buffer, recipient popover and interrupt
arm/timer. It is unkeyed and lives as long as Hub: changing rooms does not
reset the kill buffer or model cache. Private CSS moves with its markup;
compact ancestor selectors cross the Svelte boundary at the same specificity.

Hub still owns the draft binding, recipient/preference writes, attachment
generation/jobs/pending set, staging, `send()` and every RPC. Composer receives
explicit state and commands, not a Hub store or feed/roster DOM references.
The named `caret`/`focus` methods replace staging's two textarea accesses;
the height intent retains the original parent tail behavior (the focus intent
was removed by board #303). Thumbnail
preview passes the original local object URL to Hub's existing Lightbox.

Composer registers only recipient/palette/interrupt with the existing fixed
Back registry and disposes those registrations on unmount. The capture-phase
listeners remain in Hub in their original order; their Composer portions
delegate to live child methods, not copied open flags. Parent recipient
selection still closes the picker and disarms synchronously. No browser
history listener, new dismissal mechanism or RPC race fix is part of this move.

Verification on Svelte 5.53.5 / Vite 6.4.1 / Node 22.23.2: seven moved
handlers and `send()` are AST-identical; staging/growth differ only by their
named boundary calls; all 73 moved CSS rule bodies match. Chromium
152.0.7977.64 produced 54 identical text/rect/computed-style signatures
across the six variants. The font-mirror negative control removed only the
mirror's command-font selector: its tail marker moved from (552.58, 849.5)
to (983.13, 809), failing the geometry assertion. The selector was restored.
The restored build passes that assertion again. Two additional desktop/compact
long-recipient signatures also match; real PNG paste stages a thumbnail whose
original local URL opens in the existing Lightbox in both layouts.

### Words beside a picture of the words: the text is the paste (2026-09-08)

The paste door's rule was "files win over co-riding text" (board #25) — right for a Finder/Explorer file copy, whose text is the file's own path, and for a screenshot, which has no text. It was wrong for the paste the owner met daily: PowerPoint (and Word, Excel, Keynote, Numbers, every browser) puts a **PNG rendering of the selection** on the clipboard beside `text/plain`/`text/html`, and the composer staged the picture and threw the words away ("从 ppt 上粘贴过来的文字，总是被粘贴为了一个图片"). `textIsThePaste(text, files)` (hub.ts, pure, tested) now decides before `preventDefault`: the text wins when it is non-empty AND every file is an image AND the text is not one token that is a URL, a path, or the name of one of the files. Every legitimate file paste fails that test — a screenshot carries no text, a file copy carries its own name/path, a web "Copy image" carries at most the image URL, and any non-image file (a pdf beside a caption) is a file paste whatever the text says. When the text wins the handler simply returns and the textarea's default insertion runs; the rendering is dropped, not staged — nobody wants a picture of a bullet list next to the bullet list. The HTML flavour is ignored on purpose: the composer is plain text and markdown, and Office HTML is a wall of styling.

### An attachment failure is a chip, never a console line

The staging pipeline (`stageFiles` — the `+` button and paste share it; the reference rule and the upload layout are in `hub-feed.md` §An image is a reference) used to `console.warn` an oversized file (`FILE_CAP`, 32 MB per RPC) or a failed upload and carry on, so the user could not tell what the message was about to carry (review, 2026-09-03). Now every failure is a `pending` entry like any other attachment — `failedAttachment(file, reason)`: no path, no token, no number, an `error` — rendered in the file chip's own clothes turned to the danger tone (`.pend-chip.err`: `--status-danger` ink + border + 8% wash, name + reason, tooltip with the whole reason, ✕ removes it). Three failures land there: too large (before any upload — with the hint to point the agent at the path instead), a per-file throw (the loop is per FILE now, so one bad file does not take the others down), and the uploads dir itself failing (every file of that job). A failed chip is not content (`sendable` counts only staged ones) and it BLOCKS send while it stands — `send()` returns and the button is disabled with `Remove the failed attachment first` — the same two-gate rule `attaching` follows, because a message that quietly left without the file it showed is the failure mode this exists to prevent. The staleness discipline holds: a throw comes out of an await, so the catch checks `stale()` before touching the room (as a guard, not a return, so the loop goes on); the source test pins one check per await unchanged, plus this test's own three chips and the two gates.

### Interrupt is a third verb, and only the pane can carry it

typing `Escape` into the agent's own pane (`hub_agent_interrupt` server-side so the UI and CLI share ONE implementation; `send_keys`, NAMED key — with `extended-keys on` tmux drops raw C0 bytes) is the only way to cancel a turn that is ALREADY running; a `tmm`/chat message is read between turns by definition, and stop/restart kill or bounce the process.

**The derived state is RESET FIRST, then the key is typed** (`telemetry::record_interrupt`: `end = ("completed", now)`, `ask` and the explicit claim cleared → `derive` says `idle` immediately), and the order is the whole point (owner, 2026-08-29): a turn cancelled from OUTSIDE has no edge of its own — no stop hook fires for it — so the newest fact would stay the `userPromptSubmit` that opened it and the card would read `running` for as long as the agent lived; and an interrupted agent usually gets something else to do within seconds, whose own turn re-derives `running`, so a reset racing that new turn is indistinguishable from no reset at all — an interrupt that looks like it never landed. Clearing `explicit` is part of it: a `blocked` claim from the dead turn outranks the end in `derive_from` when they share a second. So the Hub's agent action bar carries Watch / Interrupt / Stop, in rising order of consequence.

**The composer carries it too, behind two beats** (owner, 2026-08-24): with the box EMPTY the grey send button is still clickable — the first tap ARMS it ("send interrupt": amber, a caption pill naming the target since a phone has no hover) and the second fires; double Ctrl+C on the empty composer is the same arm/fire pair (with text present Ctrl+C stays the browser's copy, which `readlineEdit` deliberately falls through to).

**While the recipient is mid-turn the resting button says so**: a stop square inside a slowly circling arc (2.2s — a fast spin says "loading", this says "a turn is open"; accent on the resting grey, `prefers-reduced-motion` stills it), the glyph every chat product speaks — the armed state keeps the same glyph on the amber ground, because the earlier `zap` bolt read as nothing ("我看打断是闪电，看着好像不是那么容易理解", owner 2026-08-25). Busy means the hook-derived running/working/waiting/blocked of the recipient (any managed agent for `@all`); idle and failed show the plain grey arrow — an ended turn has nothing to interrupt. The interrupt reaches whoever the composer reaches — the recipient, or every managed agent for `@all`; an unaddressed room note arms nothing. Armed state stands down by itself: 3 s, typing, Escape, or switching projects. And the room now RECORDS the act — `hub_agent_interrupt` posts `[tmm] interrupted <name>` (the sys grammar already spoke it: amber, a turn cut short), so the feed shows what the app did ("发送 interrupt 的状态在消息列表里也要展示出来"); a real-tmux test pins window-survives + room-line.

### Historical composer motion (before #168)

Per [motion.md](motion.md). The recipient chip's arrow is ONE chevron in `.flip` — up while closed (the menu opens upward), turned down while open — never two glyphs swapped (principle 4, the owner's own example). `+@bob` fades in (`.appear`); attachment chips and thumbs pop in (`.appear-pop`; the list is keyed by `a.key`, but its three chip species sit under an `{#if}`, so there is no `animate:flip`); the interrupt caption rises (`.appear-rise`); the send glyph pops when the `{#if}` swaps arrow ↔ stop-square — unrelated glyphs may swap. The recipient menu and the `/` palette are placed popovers like every other (principle 8, wave 6): each wears `.pop-layer` with `bind:clientHeight` as its `.ready` gate and `--pop-origin: bottom left` — the corner touching the chip, since both open upward — so it is measured invisible, then grows from the chip on `--t-fast`; the height resets when the menu closes so every opening is measured (and animated) again, and the atom touches only opacity/transform/pointer-events, so their own `position: absolute; bottom: calc(100% + 6px)` placement is untouched and the rest state is `transform: none`. Exits are cuts. **Hover** (principle 16): resting on the recipient chip opens the one hover card with a sentence for the CURRENT destination in the three-destination model — `@name` types into one pane, `@all` into every managed pane, no recipient records only — with the body's `+@` extras as its note; the chip carries no native `title` any more. The composer's height is JS-measured per keystroke and never animated.
