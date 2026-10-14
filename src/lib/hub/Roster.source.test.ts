import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./Roster.svelte', import.meta.url), 'utf8');
const ruleIn = (text: string, selector: string) =>
  text.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
const rule = (selector: string) => ruleIn(source, selector);
// The tab paint, the travelling marker and the strip's frame are the SHARED
// tab strip's since #365 (app.css `.tab-strip` / `.strip-tab` / `.slide-pill.tab`):
// these pins read them there, with the reasons they always had.
const appCss = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
const atom = (selector: string) => ruleIn(appCss, selector);

test('cards, Add and disclosure share the strip centre without moving the expanded control (#186)', () => {
  assert.match(rule('.cards'), /align-items: center/u);
  const toggle = rule('.roster-toggle');
  assert.match(toggle, /align-items: center/u);
  assert.match(toggle, /height: calc\(var\(--tab-paint-height\) \+ 2 \* var\(--control-paint-inset\)\)/u,
    'the disclosure wrapper matches the card target height, without a spare row above it');
  assert.match(rule('.cards'), /padding: 0 2px 0 var\(--tab-foot\)/u,
    '#237: no top scrollport inset; the start inset is room for the first enclosure\'s outward foot');
  assert.match(toggle, /align-self: end/u, 'expanding upward keeps the collapse control reachable in place');
  assert.doesNotMatch(toggle, /padding-block-end/u);
});

test('context meters surround equal circular avatars with room inside the card (#180)', () => {
  assert.match(source, /style:--ctx-color=\{ctxColor\(a\.vitals\.context_pct\)\}/u);
  assert.match(atom('.strip-tab'), /position: relative/u);
  const bar = rule('.ctx-ring');
  assert.match(bar, /position: absolute/u);
  assert.match(bar, /left: 0; top: 0/u, 'the ring is positioned in the same box as the icon, not independently in the card');
  assert.match(rule('.avatar-slot'), /position: relative/u);
  assert.match(bar, /width: var\(--roster-ring-size\); height: var\(--roster-ring-size\)/u);
  assert.match(rule('.roster'), /--roster-ring-size: 24px/u);
  assert.match(atom('.tab-strip'), /--tab-paint-height: 30px/u);
  assert.match(appCss, /\.tab-strip \{ --tab-paint-height: 32px; --control-height: 36px; --control-paint-inset: 2px; \}/u,
    'the phone strip wears the desktop geometry: a 36px row and 36px commands, not 44 (owner, 2026-09-24)');
  assert.doesNotMatch(source, /padding-block-start: calc\(2 \* var\(--ui-gap\)\)/u, 'no content shove: the paint inset is the desktop\'s, so content sits as on desktop');
  assert.doesNotMatch(source, /\.roster\.compact \.slide-pill\.tab::before/u, 'one paint inset for both pointers');
  assert.match(appCss, /@media \(any-pointer: coarse\) \{\n\s*\.tab-strip \{ --tab-paint-height: 32px;/u,
    '#237: the phone row is 32px — the 44px touch floor lives on .agent-select, not the paint');
  assert.match(bar, /pointer-events: none/u);
  assert.match(bar, /conic-gradient/u);
  assert.doesNotMatch(bar, /transition/u, 'colour thresholds never pass through intermediate hues');
  assert.match(rule('.ava'), /border-radius: 50%/u);
  assert.doesNotMatch(source, /ac-bar|roster-meter-height/u, 'edge bar removed whole');
});

test('everyone leaves the roster whole for the sole Composer command (#180)', async () => {
  assert.doesNotMatch(source, /acard all|acard\.all|all-ava|allPending|broadcast-glyph/u);
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.hub-root \.acard\.all/u, 'the obsolete corner exception leaves with the old card');
});

test('card paint keeps its inset and the single measured scrolling edge (#180)', () => {
  assert.match(atom('.strip-tab::before'), /inset: var\(--control-paint-inset\) 0/u);
  assert.match(atom('.strip-tab::before'), /pointer-events: none/u);
  // The tab strip has only its scrollport inset; the field retains its inset.
  assert.match(rule('.roster'), /padding: 0 var\(--composer-inset\) 0 0/u);
  assert.match(rule('.roster'), /gap: 0/u);
  assert.match(source, /class="cards edge-fade"[^>]*use:scrollEdges=\{\{ active: !expanded, wrapped: 'expanded', onoverflow: \(over\) => \{ overflowing = over; \}, key: markerKey \}\}/u);
});

test('no invisible action slots widen the card; Stop stands ON the dot instead (#180 → #205)', () => {
  assert.doesNotMatch(source, /agent-watch|card-quick|onwatch/u);
  assert.doesNotMatch(rule('.agent-stop'), /opacity: 0/u, 'never an invisible reserved slot');
  assert.match(rule('.agent-stop'), /position: absolute; z-index: 1; left: var\(--dot-x, 50%\); top: var\(--dot-y, 50%\); transform: translate\(-50%, -50%\)/u,
    '#205: placed over the dot by overDot, taking no width — the card never changes size');
  assert.match(rule('.acard.stop-shown .ac-top'), /visibility: hidden/u, 'the dot yields while the Stop stands on it');
  assert.doesNotMatch(atom('.strip-tab'), /grid-template-columns/u);
  assert.match(source, /icon="stop" variant="danger" iconOnly/u);
});

test('Stop is red, hidden until hover/focus or a pending interrupt, and never on touch (board #205)', () => {
  // Owner 2026-09-20: "终止按钮应该是红色的吧，更符合语义，而且默认不显示，只有鼠标移到上边，
  // 把状态的小圆点变为终止按钮。手机端就不要了，节省空间，让用户用选项卡终止就好".
  assert.match(source, /const coarse = typeof window !== 'undefined' && window\.matchMedia\('\(any-pointer: coarse\)'\)\.matches;/u);
  assert.match(source, /const showStop = \(name\) => !coarse && busyNames\.includes\(name\) && \(armed === name \|\| interrupting\.includes\(name\)\);/u);
  assert.match(source, /function arm\(name, pointerType = 'mouse'\) \{ if \(!coarse && pointerType !== 'touch'\) armed = name; \}/u);
  assert.match(source, /onpointerenter=\{\(e\) => arm\(a\.name, e\.pointerType\)\} onpointerleave=\{\(\) => disarm\(a\.name\)\}/u);
  assert.match(source, /onfocusin=\{\(\) => arm\(a\.name\)\} onfocusout=\{\(e\) => \{ if \(!e\.currentTarget\.contains\(e\.relatedTarget\)\) disarm\(a\.name\); \}\}/u);
  assert.match(source, /\{#if showStop\(a\.name\)\}/u);
  assert.match(source, /class="agent-stop compact-tools" class:pending use:overDot/u);
  assert.doesNotMatch(source, /renderedStops|pressStops|has-stop/u, 'the resident slot and its press-hold layout are gone');
});

test('the dot reserves the Stop\'s room, constant, and the Stop wears no wash (board #211)', () => {
  // Owner 2026-09-20: "agent 卡片状态小点右侧好像没有留边距，包括我鼠标悬浮的时候，停止按钮都
  // 超出 agent 卡片框了。而且停止按钮就不用加背景了，就红色方块我直接点就行".
  // The 28px slot (hit box = focus-ring extent; 20px paint inside) centred on
  // the 6px dot reaches 14px past its centre; 12px = 28/2 − 6/2 + the 1px
  // inset border ends the slot at the border's inner edge.
  assert.match(rule('.roster'), /--roster-dot-reserve: 12px/u);
  assert.match(rule('.acard:not(.off) .agent-select'), /padding-inline-end: var\(--roster-dot-reserve\)/u,
    'a live card reserves it at rest — revealing the Stop must not reflow the row');
  assert.doesNotMatch(rule('.agent-select'), /padding-inline-end/u, 'a stopped card has no dot and keeps the plain inset');
  assert.match(source, /icon="stop" variant="danger" iconOnly bare/u, 'no rest/hover/press paint: the red glyph is the control');
});

test('one controlled roster replaces the delayed tap menu whole (#168)', () => {
  assert.match(source, /import \{ ALL_TARGET, targetMembers, targetTeam, teamTarget \} from '\.\/hub-composer\.ts'/u);
  assert.match(source, /const ranked = \$derived\(sortAgentsForRoster\(managedAgents\)\)/u,
    'turn-edge recency stays the one sorting authority');
  assert.match(source, /const groups = \$derived\(rosterGroups\(orderedAgents\)\)/u,
    'grouping follows the hover-held order instead of re-sorting identities');
  assert.match(source, /onselect: setRecipient = \(\) => \{\}/u);
  assert.match(source, /function selectTarget\(name\) \{\s*setRecipient\(name\);/u, '#196: a click selects; Record only in the menu deselects');
  assert.doesNotMatch(source, /selectTarget\(ALL_TARGET\)/u);
  assert.match(source, /onclick=\{\(e\) => clickAgent\(e, a\.name\)\}/u);
  assert.doesNotMatch(source.slice(source.indexOf('} = $props();')), /\brecipient\s*=(?!=)/u,
    'selection emits intent without locally committing recipient');
  assert.doesNotMatch(source, /menuFor|bind:cardsEl|cardTimer|cardDbl|cardClick|toggleAgentMenu|menuAnchor|menuPos|vitalsFor|menuAgent|a-menu|am-who|am-vitals|groupRoster|tgroup/u);
  // Owner 08:41 (#173) adds Watch as a direct intent, not a local action menu.
  assert.doesNotMatch(source, /onstart|onrestart|onaction|onconfigure|setTimeout|addEventListener|popstate|history\./u);
});

test('Stop consumes parent busy and pending sets through the shared command', () => {
  assert.match(source, /busyNames = \[\], interrupting = \[\]/u);
  assert.match(source, /\{#if showStop\(a\.name\)\}/u);
  assert.match(source, /\{pending\} disabled=\{pending\}/u);
  assert.doesNotMatch(source, /interrupting\.includes\(ALL_TARGET\)/u,
    'pending contains captured member names, never a second all-job sentinel');
  assert.match(source, /interrupting\.includes\(a\.name\)/u);
  assert.equal([...source.matchAll(/icon="stop" variant="danger" iconOnly/gu)].length, 1);
  assert.equal([...source.matchAll(/e\.stopPropagation\(\); interrupt\(/gu)].length, 1);
  assert.doesNotMatch(source, /hubAgentStop|hubAgentInterrupt|busyTargetsFor|\.state\s*===\s*'(?:running|working|waiting|blocked)'/u,
    'the parent owns target membership and dispatch, not a second local busy classifier');
});

test('body mentions use chipExtras, separate from selected state and Stop', () => {
  assert.match(source, /const extras = \$derived\(chipExtras\(composerText, recipient, managedNames\)\)/u);
  assert.match(source, /extras\.includes\(ALL_TARGET\)/u);
  assert.match(source, /extras\.includes\(a\.name\)/u);
  assert.match(source, /class="agent-mention"[^>]*>@<\/span>/u);
  assert.doesNotMatch(source, /mentionTokens|new RegExp|\.split\(['"]@|name="check"/u);
  assert.doesNotMatch(rule('.agent-mention'), /border[^;\n]*dashed/u,
    '#173 permits a reading-filter outline, never a mention outline');
});

test('native selection owns hover and context; stopped slots never select or resume', () => {
  assert.match(source, /<button type="button" class="agent-select"\s+aria-pressed=\{isAddressed\(a\.name\)\}/u);
  assert.match(source, /const addressedMembers = \$derived\(new Set\(targetMembers\(recipient, managedAgents\)\)\)/u);
  assert.match(source, /const isAddressed = \(name\) => addressedMembers\.has\(name\)/u);
  assert.match(source, /class:sel=\{isAddressed\(a\.name\)\}/u, '#186: paint and accessibility read the same aggregate selection');
  assert.match(source, /use:hoverInfo=\{\(\) => cardInfo\(a\)\}/u);
  assert.match(source, /use:hoverInfo=\{\(\) => offCardInfo\(name\)\}/u);
  // #223: a touch open carries the hover card's facts (a finger has no
  // hover); touchInfo returns null on a fine pointer, keeping those menus
  // verbs-only.
  assert.match(source, /const touchInfo = \(get\) => \(coarsePointer\(\) \? get\(\) : null\);/u);
  assert.match(source, /oncontextmenu=\{\(e\) => \{ e\.preventDefault\(\); oncontext\(pointOf\(e\), a\.name, touchInfo\(\(\) => cardInfo\(a\)\)\); \}\}/u);
  assert.match(source, /use:longpress=\{\{ onlongpress: \(at\) => oncontext\(at, a\.name, touchInfo\(\(\) => cardInfo\(a\)\)\) \}\}/u);
  // One stopped-card body (the offSelect snippet, #287) for a loose stopped
  // identity and a stopped team's member.
  const off = source.slice(source.indexOf('{#snippet offSelect(name)}'), source.indexOf('{/snippet}', source.indexOf('{#snippet offSelect(name)}')));
  assert.match(off, /onclick=\{\(e\) => stoppedMenu\(e, name\)\}/u);
  assert.match(off, /disabled=\{acting\}/u);
  assert.doesNotMatch(off, /selectTarget|interrupt\(|startAgent|a-start|aria-pressed/u);
  assert.doesNotMatch(source, /role="button"|onkeydown|position:\s*fixed/u);
  for (const fact of ['runtimeLabel(a)', 'fmtElapsed(a.since, tick)', 'stateTone(a.state)', "t('hubHoverTarget')", "t('hubHoverPath')", "t('hubToDmLong')", "t('hubToAlsoHint')"]) {
    assert.ok(source.includes(fact), `retained hover fact: ${fact}`);
  }
});

test('double-click focuses live agents without delay and uses the existing filter intent (#173)', () => {
  assert.match(source, /if \(!coarsePointer\(\) && event\.detail > 1\) return;/u);
  assert.match(source, /if \(!stopped && recipient !== name\) setRecipient\(name\);/u);
  assert.match(source, /onfilter\(name\);/u);
  assert.match(source, /anchor: anchorOf\(trigger\), align: 'left', trigger, keepTriggerClear: true/u);
  assert.match(source, /class:filtered=\{filterAgent === a\.name\}/u);
  // The mode is shown in the strip (owner, 2026-09-23: "把当前的卡片直接亮起，
  // 其他全部变暗"): every other destination dims; the tab paint is untouched.
  assert.match(source, /class="cards edge-fade" class:expanded class:filtering=\{!!filterAgent\}/u);
  assert.match(source, /\.cards\.filtering \.acard:not\(\.filtered\) \.agent-select,\n\s*\.cards\.filtering \.team-label,\n\s*\.cards\.filtering \.all-choice \{ opacity: var\(--control-disabled-opacity\); \}/u);
  assert.doesNotMatch(source, /\.acard\.filtered::after/u, 'the dashed outline is replaced, not kept beside the dimming');
  // Dimming alone said "something changed", not "filtered to this one" (owner,
  // 2026-09-23): the filtered card carries the filter verb's own glyph, and its
  // hover note names the mode and the way out.
  assert.match(source, /<\/span>\n\s*\{#if filterAgent === a\.name\}<span class="agent-filter" aria-hidden="true"><Icon name="filter" size=\{12\} \/><\/span>\{\/if\}/u,
    'the funnel the menu row wears (owner: "沙漏过滤的样式"), as its own flex child after the marks column — a third stacked mark would grow the strip');
  assert.match(source, /class:unmarked=\{!mentioned && !unread\.has\(a\.name\)\}/u);
  assert.match(rule('.agent-filter'), /flex: none/u);
  assert.match(rule('.agent-filter'), /color: var\(--accent-ink\)/u);
  assert.match(source, /return filterAgent === name \? t\('hubFilterOnNote'\) : '';/u);
  assert.doesNotMatch(source, /setTimeout|clearTimeout/u);
});

test('identity, readiness and motion retain their existing authorities', () => {
  assert.match(source, /\{#if selected\}\s*<div class="roster tab-strip"/u);
  assert.match(source, /\{#if !roomReady && !managedAgents\.length && !stopped\.length\}\s*<div class="skel-wrap sk-cards" aria-hidden="true">/u,
    'placeholders only while there is nothing to show — never in front of rendered cards (owner, 2026-09-23)');
  assert.match(source, /class:reveal=\{justLoaded\}/u);
  assert.match(source, /class:appear-pop=\{!!rosterBase && !rosterBase\.has\(a\.name\)\}/u);
  assert.match(source, /class:live-dot=\{stateIsLive\(a\.state\)\} style:background=\{stateDotColor\(a\.state\)\}/u);
  assert.doesNotMatch(source, /<span>\{stateLabel\(a\.state\)\}<\/span>|agent-state|stateNeedsYou/u,
    'owner 07:09 retains state wording in accessible/hover facts only');
  assert.match(source, /\{#each groups as group \(group\.key\)\}/u);
  assert.match(source, /\{#each group\.members as a \(a\.name\)\}/u);
  // Live groups, their cards, stopped teams (#287), and each place a stopped
  // card sits: the each's own child, as svelte requires.
  assert.equal([...source.matchAll(/animate:flip=\{\{ duration: moveMs\(\) \}\}/gu)].length, 5);
  assert.doesNotMatch(source, /^\s*\.st \{/mu, 'the shared Hub dot box is not copied');
  assert.match(source, /const slotBackend = \(name\) => \(selectedRow\?\.slots \?\? \[\]\)\.find\(\(s\) => s\.window_name === name\)\?\.command;/u);
  assert.match(source, /img class="ava dim" src=\{backendIcon\(backend\)\}/u);
  assert.match(rule('img.ava.dim'), /filter: grayscale\(1\); opacity: 0\.55/u);
  assert.match(source, /onclick=\{onadd\}/u);
});

test('density lives in local tokens; full names and native targets do not shrink', () => {
  const roster = rule('.roster');
  assert.match(roster, /--roster-avatar-size: 18px/u);
  assert.match(roster, /--roster-expanded-max: min\(240px, calc\(32dvh \/ var\(--ui-zoom, 1\)\)\)/u);
  assert.match(rule('.agent-select'), /min-height: var\(--control-height\)/u);
  assert.match(atom('.strip-tab'), /width: max-content/u, 'only actual content sets card width');
  assert.match(rule('.cards'), /overflow-x: auto/u);
  assert.match(rule('.cards.expanded'), /overflow-y: auto/u);
  assert.match(rule('.cards.expanded'), /max-height: var\(--roster-expanded-max\)/u);
  assert.match(rule('.cards.expanded'), /flex-wrap: wrap/u);
  assert.doesNotMatch(rule('.cards.expanded .acard'), /width: auto/u);
  assert.match(rule('.cards.expanded .a-name'), /overflow-wrap: anywhere/u);
  assert.match(rule('.cards.expanded .a-name'), /padding-block: var\(--control-paint-inset\)/u);
  assert.match(rule('.agent-marks.unmarked'), /display: none/u);
  assert.doesNotMatch(source, /\.agent-marks:empty/u,
    'Svelte leaves conditional whitespace; CSS :empty kept 12.5px reserved and split ordinary phone names');
  // The name's type and its one line are the shared tab label's since #365
  // review P2 (app.css `.strip-label`); the name itself stays unclipped.
  assert.match(source, /<span class="a-name strip-label" style:--who-ink=/u);
  assert.match(atom('.strip-label'), /white-space: nowrap/u);
  assert.doesNotMatch(rule('.a-name') + atom('.strip-label'), /max-width|ellipsis|overflow: hidden/u);
  assert.doesNotMatch(source, /data-density|URLSearchParams|location\.search/u);
});

test('one in-flow disclosure controls one list without remounting its cards', () => {
  assert.equal([...source.matchAll(/class="cards edge-fade"/gu)].length, 1);
  assert.match(source, /icon="chevron-up" variant="icon"/u);
  assert.match(source, /\{expanded\} controls=\{cardsId\} disabled=\{!roomReady\} onclick=\{onexpand\}/u);
  assert.match(source, /const holdOrder = \$derived\(hovering \|\| focused \|\| pressing\)/u);
  assert.match(source, /onpointerdown=\{beginPress\} onpointerup=\{clearPress\} onlostpointercapture=\{clearPress\}/u);
  assert.doesNotMatch(source, /requestAnimationFrame|cancelAnimationFrame|setTimeout/u,
    'order releases on input lifecycle events, not a timer');
  assert.match(source, /focused = !!cardsEl\?\.contains\(document\.activeElement\)/u,
    'removed controls can lose focus without emitting focusout');
  assert.doesNotMatch(rule('.cards') + rule('.cards.expanded') + rule('.roster'), /transition:[^;\n]*(?:height|width)/u,
    'list geometry never animates; the absolute context fill may change width (#173)');
  assert.doesNotMatch(source, /@keyframes|position: fixed/u);
});

test('idle cards keep no padding for absent commands (#180)', () => {
  assert.doesNotMatch(source, /padding-right: calc|grid-column: 1 \/ 3/u);
  assert.match(rule('.agent-select'), /padding: 0 var\(--roster-card-inset\)/u);
});

test('the stop is a quiet dense action and the dot sits clear of the name, on the x-height (board #195)', () => {
  // Owner 2026-09-13: "agent卡片，也要紧凑一点，尤其是停止按钮，又大颜色也不好看，状态小点
  // 稍微有点挨得近了，而且上下不居中". Measured 390 coarse before: stop 44×44 in a
  // 46px card (card 111px wide), name→dot gap 1.3–2px, dot on the line-box centre.
  assert.match(source, /class="agent-stop compact-tools" class:pending use:overDot/u, 'the shared dense slot, not a private size');
  assert.doesNotMatch(source, /variant="warn"/u, 'the amber-mixed ink is gone with its variant');
  assert.match(source, /<span class="a-name strip-label" style:--who-ink=\{agentHue\(a\.name\)\}>\{a\.name\}<span class="ac-top"><span class="st"/u, 'the dot is in the name\'s line');
  assert.match(rule('.ac-top'), /vertical-align: middle; margin-inline-start: 5px;/u);
});

test("a second click on the recipient's card opens its menu at the card, never deselects (board #196)", () => {
  // Owner 2026-09-13: "agent选中卡片时，再次点击不是取消选中，而且展开选项卡".
  assert.match(source, /if \(recipient === name\) \{\n\s*const a = managedAgents\.find\(\(x\) => x\.name === name\);\n\s*oncontext\(cardAnchor\(event\.currentTarget\), name, touchInfo\(\(\) => \(a \? cardInfo\(a\) : offCardInfo\(name\)\)\)\);\n\s*return;\n\s*\}/u);
  assert.match(source, /const cardAnchor = \(trigger\) => \(\{ anchor: anchorOf\(trigger\), align: 'left', trigger, keepTriggerClear: true \}\);/u);
  assert.doesNotMatch(source, /recipient === name \? '' : name/u, 'the click toggle is gone');
  assert.match(source, /use:longpress=\{\{ onlongpress: \(at\) => oncontext\(at, a\.name, touchInfo\(\(\) => cardInfo\(a\)\)\) \}\}/u, 'a hold forwards the element anchor longpress hands it');
});

test('Everyone is the PINNED tab: always at the head, previewing on hover (board #236, supersedes #204)', () => {
  // Owner, 2026-09-22: "不用隐藏，我不展开就看不到吧"; "重新给我设计一个好看的
  // 图案…画成 Agent 类似的 Logo" (people and orbiting dots both failed the
  // glance test — the agents' own bot mark says "the agents"); "按钮有点大" —
  // 16px glyph under the avatars' 20px; "鼠标悬停…所有的 Agent 被选中或者激活".
  assert.match(source, /<span class="all-choice acard strip-tab" class:sel=\{recipient === ALL_TARGET\} role="presentation"/u);
  assert.match(source, /<CommandButton variant="icon" icon="bots" label=\{t\('hubEveryone'\)\} pressed=\{recipient === ALL_TARGET\} bare/u,
    '#237: a small CROWD of the bot mark — "可以多画几个机器人"');
  assert.match(rule('.roster'), /--roster-all-icon-size: 20px/u, 'three heads have their own readable icon metric');
  assert.match(rule('.all-choice'), /--control-icon-size: var\(--roster-all-icon-size\)/u,
    'All must not grow when the between-tab gap changes');
  assert.match(source, /\.all-choice :global\(\.command-icon svg\) \{ width: 100%; height: 100%; \}/u,
    'the svg fills the sized box — the atom hands Icon no size prop');
  // #237: the leading tab gives back the width its square box spent. Tight by
  // DEFAULT (desktop, and any device that reports no pointer); the coarse
  // branch restores the square, because on touch the box IS the target — and
  // it must come after the tight rule, which carries the same specificity.
  assert.match(source, /\.all-choice :global\(\.command-button\.icon-only\) \{ width: auto; min-width: 0; padding-inline: 2px; \}/u);
  const tight = source.indexOf('.all-choice :global(.command-button.icon-only) { width: auto;');
  const square = source.indexOf('.all-choice :global(.command-button.icon-only) { width: var(--control-height)');
  assert.ok(tight > 0 && square > tight, 'the coarse square must be declared after the tight default');
  assert.doesNotMatch(source, /\{#if expanded\}\s*\n\s*<span class="all-choice"/u, 'the expanded-only gate is gone');
  assert.doesNotMatch(source, /data-agent="all"/u, '#180: never a card');
  // Hover/focus previews the choice — the STRIP lights as one enclosure,
  // exactly as clicking would (round 5); touch never previews.
  assert.match(source, /let allPreview = \$state\(false\);/u);
  assert.match(source, /const allLit = \$derived\(recipient === ALL_TARGET \|\| allPreview\);/u);
  assert.match(source, /<div class="tabs tab-group" class:all-lit=\{allLit\} use:slideIndicator=/u);
  assert.match(source, /onpointerenter=\{\(e\) => \{ if \(e\.pointerType !== 'touch'\) allPreview = true; \}\}/u);
  assert.doesNotMatch(source, /class:preview=/u, 'round 5: no per-card preview paint — the strip is the one enclosure');
});

test('a card is a TAB wearing the agent bubble, and multi-select is ONE enclosure (board #236, round 5)', () => {
  // Owner: "做成类似 Chrome tab 栏的样式"; round 5 — "会不会有点过亮了？…把其他
  // 地方变得更暗", "和 Agent 返回给我的消息框的亮度色彩差不多就可以", "整体加一个
  // 稍微淡白色的边", "如果是选择多个 Agent，就用一个大的包边…不要有很多线拐来拐去".
  assert.match(atom('.strip-tab'), /--card-paint: transparent; --card-line: transparent/u, 'at rest a card is a name, not a block');
  assert.match(appCss, /\.strip-tab:hover \{ --card-paint: var\(--surface2\); \}/u, 'hover is the one quiet wash');
  assert.match(source, /\.cards\.expanded \.acard\.sel \{ --card-paint: var\(--bubble-in\); --card-line: var\(--bubble-line\); \}/u,
    'the lit tab wears the agent bubble: its brightness and its faint edge');
  // ONE HIGHLIGHT THAT TRAVELS (motion principle 14; owner, 2026-09-23:
  // "切换的动画不是很丝滑…先标了一个框，然后又闪过去了"): in the strip the lit
  // card paints nothing of its own; one `.slide-pill` marker carries fill,
  // edge, feet and join and glides between destinations via slideIndicator.
  assert.match(source, /use:slideIndicator=\{\{ key: markerKey, active: markerTarget, hidden: expanded \|\| !markerTarget \}\}/u);
  assert.match(source, /\{#if !expanded && markerTarget\}[\s\S]{0,700}?<span class="slide-pill tab" class:raised=\{litInGroup\} aria-hidden="true">\s*<span class="tab-shape" use:tabShape><svg><path class="tab-fill" \/><path class="tab-edge" \/><\/svg><\/span>\s*<\/span>\s*\{\/if\}/u,
    'the marker is ONE outline: feet, sides and top corners are one filled, once-stroked path (owner, 2026-09-27)');
  assert.doesNotMatch(source, /class="tab-foot|\.tab-foot\b|background: radial-gradient/u, 'no pieced feet: separate rasterisations are what failed to meet');
  assert.match(source, /const markerTarget = \$derived\(rosterMarker\(\{ all: allLit, team: litTeam, groups, addressed: managedAgents\.some\(\(a\) => addressedMembers\.has\(a\.name\)\) \}\)\);/u,
    'All, a team and a card are the same marker at a different width; the rule itself is rosterMarker (hub.test.ts)');
  assert.match(appCss, /\.strip-tab\.sel \{ --card-paint: transparent; --card-line: transparent; \}/u,
    'no card lights in place in the strip — that crossfade beside popping feet was the flash');
  assert.doesNotMatch(source, /\n\s*\.cards:not\(\.expanded\) \.acard\.sel::before/u, 'no second enclosure paint on the card');
  assert.match(rule('.tabs'), /position: relative; z-index: 0/u, 'the marker\'s container, and the stacking context it and the baseline sink in');
  assert.match(atom('.slide-pill.tab'), /z-index: -1/u, 'under the cards; over the baseline by DOM order, so All stays the group\'s first child');
  assert.match(source, /\{\/each\}\n\s*<!--[\s\S]{0,600}?-->\n\s*\{#if !expanded && markerTarget\}/u, 'the marker is the last thing in the destinations group');
  assert.match(atom('.tab-shape') + atom('.tab-strip'), /--tab-radius: var\(--ui-radius-row\);[\s\S]*--tab-foot: 8px/u,
    'the card tier and the context ring\'s own curvature (the panel radius read as a half-circle, owner 2026-09-23); the 8px foot');
  assert.match(atom('.tab-shape'), /inset: var\(--control-paint-inset\) calc\(-1 \* var\(--tab-foot\)\) -1px/u,
    'the paint box widened by a foot each side and one pixel into the band, where the fill overlaps the junction');
  assert.match(atom('.tab-fill') + atom('.tab-strip'), /fill: var\(--tab-fill\)[\s\S]*--tab-fill: var\(--bubble-in\)/u, 'the marker wears the agent bubble');
  assert.match(atom('.tab-edge'), /fill: none; stroke: var\(--card-line\); stroke-width: 1px; transition: stroke var\(--t-move\) ease/u,
    'the marker MOVES; only its stroke colour crossfades');
  assert.doesNotMatch(source, /\.slide-pill\.tab::(?:before|after)/u, 'no box-and-border paint beside the path');
  assert.doesNotMatch(source, /inset: 0 0 -1px/u, 'no enclosure PAINT reaches into the band: its strokes would tick under the floor line');
  assert.match(rule('.tabs-extent'), /position: absolute; inset: 0; pointer-events: none/u, 'the measurement box for All');
  assert.match(source, /\.cards:not\(\.expanded\) \.tabs, \.cards:not\(\.expanded\) \.roster-cluster, \.cards:not\(\.expanded\) \.acard \{ align-self: stretch; \}/u,
    'a tab is attached to the floor, so its box reaches it however tall the strip is (owner\'s macOS build, 2026-09-23)');
  // Multi-select: the STRIP is the lit tab — one fill, one edge, no lines
  // between siblings, and the per-card paint switches off by construction.
  assert.match(rule('.cards.expanded .tabs.all-lit::before'), /background: var\(--bubble-in\); border: 1px solid var\(--bubble-line\); border-radius: var\(--ui-radius-panel\)/u,
    'only the wrapped list closes All as a box of its own; in the strip All is the marker grown to the group');
  assert.doesNotMatch(source, /\n\s*\.tabs\.all-lit::before/u, 'no second All enclosure in the strip');
  assert.match(source, /\.cards\.expanded \.tabs\.all-lit \.acard::before \{ background: transparent; border-color: transparent; \}/u);
  // Round 6: the enclosure belongs to the DESTINATIONS group, sized to its
  // content — the +, a stopped identity and the space behind them are not
  // destinations (owner: "不要把加号后面的这些区域也都框出来").
  assert.match(rule('.tabs'), /display: flex; align-items: center; gap: var\(--roster-gap\); flex: none/u,
    'the group must NOT shrink in the scrolling strip: its flex:none cards would spill out of it and the + would draw on top (review 2026-09-22)');
  assert.equal(rule('.cards:not(.expanded) .tabs'), '', 'the feet reach into the empty bottom corner of a neighbour; no gap widens for them');
  assert.match(rule('.cards.expanded .tabs'), /flex: 0 1 auto; min-width: 0; flex-wrap: wrap/u,
    'only the wrapped list shrinks the group — there it wraps inside itself');
  assert.doesNotMatch(source, /\.cards\.all-lit/u, 'the row-wide enclosure is gone');
  assert.match(atom('.strip-tab::before'), /transition: background var\(--t-move\) ease, border-color var\(--t-move\) ease/u,
    'the hover wash and the wrapped list\'s paint keep the one movement tempo');
  assert.doesNotMatch(atom('.strip-tab::before'), /transition:[^;]*(?:inset|border-radius)/u,
    'geometry never passes through intermediate frames');
  assert.doesNotMatch(source, /linear-gradient\(to top, var\(--bubble-in\) var\(--roster-gap\)/u,
    'the instant opaque floor is gone with the crossfading fill it patched');
  assert.doesNotMatch(source, /\.roster::after/u, 'the floor line is a background layer, never an overlay above the tabs');
  assert.match(atom('.tab-strip'), /--tab-line: var\(--bubble-line\);[\s\S]*background-image: linear-gradient\(to top, var\(--tab-line\) 1px, transparent 1px\)/u,
    'the band\'s faint top edge runs the full width and the lit enclosure breaks it (owner, 2026-09-23)');
  assert.match(atom('.tab-strip'), /background: var\(--hub-tab-frame\)/u, 'the contrast comes from the frame going darker');
});

test('team tabs use the reference pill, broken baseline and raised member contour (#238)', () => {
  assert.match(source, /\{@const named = namedGroup\(group\)\}/u, 'the markup and the marker read ONE definition of a drawn team (#241)');
  assert.match(source, /class:team=\{named\} class:team-lit=\{named && recipient === teamTarget\(group\.team\)\} data-team=\{named \? group\.team : undefined\}/u);
  assert.match(source, /role=\{named \? 'group' : undefined\} aria-label=\{named \? `\$\{t\('teamsTitle'\)\} \$\{group\.team\}` : undefined\}/u);
  assert.match(rule('.roster-cluster'), /display: flex; align-items: center; gap: var\(--roster-gap\); flex: none/u,
    'one non-shrinking unit prevents its tabs from spilling over neighbours on horizontal scroll');
  assert.match(rule('.cards:not(.expanded) .roster-cluster.team::before'), /position: absolute; inset: auto var\(--roster-gap\) 0/u,
    'the baseline spans the group floor, not the tray or the top edge');
  assert.match(rule('.cards:not(.expanded) .roster-cluster.team::before'), /height: calc\(var\(--roster-gap\) \/ 2\); background: var\(--text2\)/u,
    'one neutral pixel uses existing spacing and adds no row height');
  assert.match(rule('.team-label'), /min-height: var\(--control-height\)/u, 'the label is a native target within the existing tab row');
  assert.match(rule('.team-label'), /color: var\(--text2\); background: none/u,
    'a word, not a block: the pill read as a big square beside the tabs (owner, 2026-09-24)');
  assert.match(source, /\.team-label:hover, \.team-label\[aria-pressed="true"\] \{ color: var\(--text\); \}/u, 'it speaks through ink alone');
  assert.doesNotMatch(source, /\.team-label:hover \{ background/u, 'no wash returns on hover');
  assert.match(rule('.team-label'), /-webkit-tap-highlight-color: transparent/u, 'no native tap flash on the name (owner, 2026-09-25)');
  assert.match(source, /\.all-choice :global\(\.command-button\.engaged\),\n\s*\.all-choice :global\(\.command-button\.engaged:hover:not\(:disabled\)\),\n\s*\.all-choice :global\(\.command-button\.engaged:active:not\(:disabled\)\) \{ --command-paint: transparent; \}/u,
    'the selected All stays washless on hover and after a tap, not only at rest');
  assert.match(rule('.roster.compact .team-label'), /min-width: var\(--control-height\); min-height: var\(--control-height\)/u,
    'a team can be selected on the phone with the full touch target');
  assert.match(rule('.team-name'), /text-overflow: ellipsis/u, 'long names cannot bury all member tabs on the phone');
  assert.match(rule('.slide-pill.tab.raised'), /--card-line: var\(--text2\)/u,
    'only a lit grouped tab has a raised neutral contour; solos and All keep their original paint');
  assert.match(source, /const litInGroup = \$derived\(!allLit && !litTeam && groups\.some\(\(g\) => namedGroup\(g\) && g\.members\.some\(\(m\) => m\.name === recipient\)\)\);/u);
  assert.match(rule('.cards:not(.expanded) .roster-cluster.team::before'), /z-index: -1/u, 'the baseline sinks under the marker, in the group\'s stacking context');
  assert.match(rule('.tabs.all-lit .roster-cluster.team::before'), /display: none/u, 'All owns the only visible enclosure');
  assert.match(rule('.cards.expanded .roster-cluster.team'), /flex: 0 1 100%; min-width: 0; flex-wrap: wrap/u,
    'the expanded group may wrap without overflowing the narrow list');
  assert.match(source, /<button type="button" class="team-label"[\s\S]{0,350}?aria-pressed=\{recipient === teamTarget\(group\.team\)\}[\s\S]{0,350}?onclick=\{\(\) => setRecipient\(teamTarget\(group\.team\)\)\}/u,
    'the team label is a choice of addressees, never a fake decorative pill');
  assert.match(rule('.cards.expanded .roster-cluster.team-lit'), /background: var\(--bubble-in\); border-radius: var\(--ui-radius-panel\)/u,
    'team selection is one enclosure; in the strip it is the marker grown to the group');
  assert.match(rule('.cards.expanded .roster-cluster.team-lit .acard::before'), /background: transparent; border-color: transparent/u,
    'member tab borders do not divide the team enclosure');
  assert.match(rule('.cards.expanded .roster-cluster.team-lit::after'), /inset: 0; border: 1px solid var\(--bubble-line\)/u,
    'the expanded list is a closed group, not an open tab that pretends to reach the band');
});

test('one outward foot joins every lit enclosure to the floor line (#238 owner corrections)', () => {
  assert.match(atom('.tab-strip'), /--tab-foot: 8px/u, 'a 4px arc at a 1px stroke read as jagged (owner, 2026-09-23)');
  assert.match(source, /import \{ tabShape \} from '\.\.\/ui\/tab-shape\.ts';/u,
    'the feet, sides and top are one path (ui/tab-shape.ts): its joints are geometry, tested there');
  assert.match(appCss, /linear-gradient\(to top, var\(--tab-line\) 1px, transparent 1px\),\n\s*linear-gradient\(to top, var\(--tab-fill\) 1px, transparent 1px\);/u,
    'the translucent floor line lies on band fill: over the frame it read a third dimmer and thinner than the tab edge');
  assert.match(rule('.cards:not(.expanded) .roster-cluster.team::before'), /inset: auto var\(--roster-gap\) 0/u,
    'the group baseline stays the group\'s own');
});

test('expanding exists only while the single row overflows (#266)', () => {
  assert.match(source, /expanded: expandPref = false, onexpand/u, 'the prop is the remembered preference');
  assert.match(source, /const expanded = \$derived\(expandPref && overflowing\);/u,
    'a row that fits renders its single-row form, the lit tab with feet');
  assert.match(source, /\{#if overflowing\}\n\s*<div class="roster-toggle">/u, 'no chevron when there is nothing to expand');
  assert.match(rule('.roster'), /grid-template-columns: minmax\(0, 1fr\) var\(--control-height\)/u,
    'the chevron column stays reserved: the row width must not depend on the answer');
  assert.match(source, /\.cards:not\(\.expanded\) \.ctx-value \{ display: none; \}/u,
    'the probe reads the single row without the wrapped list\'s figures');
});

test('a team with nobody running keeps its place: a name that opens the team menu over its stopped cards (#287)', () => {
  assert.match(source, /const offTeams = \$derived\(stoppedGroups\(stopped, stoppedTeams, managedAgents\)\);/u, 'drawn from hub_agents\u2019 stopped_teams');
  assert.match(source, /<div class="roster-cluster team off" data-team=\{group\.team\}/u);
  const off = source.slice(source.indexOf('{#each offTeams'), source.indexOf('{#each offLoose'));
  assert.match(off, /onclick=\{\(e\) => onteamcontext\(cardAnchor\(e\.currentTarget\), group\.team\)\}/u, 'its name opens the team menu');
  assert.doesNotMatch(off, /setRecipient|aria-pressed/u, 'not a destination: nobody is running to talk to');
  assert.equal(source.match(/\{@render offSelect\(name\)\}/gu)?.length, 2, 'one stopped-card body, for a loose identity and a team member');
});

test('the hover model line is runtimeLabel, the one the feed header reads (board #292)', () => {
  assert.match(source, /const model = runtimeLabel\(a\);/u);
});

test('a live card name wears agentHue, dimmed toward --text2 when unlit (board #292)', () => {
  assert.match(source, /<span class="a-name strip-label" style:--who-ink=\{agentHue\(a\.name\)\}>/u);
  assert.match(source, /\.tabs:not\(\.all-lit\) \.acard:not\(\.sel\):not\(\.off\) \.a-name \{ color: color-mix\(in srgb, var\(--who-ink\) 55%, var\(--text2\)\); \}/u);
  assert.doesNotMatch(source, /var\(--agent-\d\)/u);
});

test('a failed agent says why on the phone too: the state line carries the detail into the touch facts (#322)', () => {
  // The long-press menu on a touch device renders cardInfo (#223), so the
  // reason of a real CLI failure is reachable without a hover.
  assert.match(source, /const lines = \[\{ label: t\('hubHoverState'\), value: \[stateLabel\(a\.state\), a\.detail\]\.filter\(Boolean\)\.join\(' · '\)/u);
});
