// Source contracts of the Hub feed's turn rail (board #461). The behaviour is
// pinned by hub-turn-rail.test.ts (protocol), hub-turns.test.ts (arithmetic) and
// TurnRail.mount.test.ts (wired); these pin the STRUCTURE that must not fork:
// one popover mechanism, one jump, tokens only, and a retirement call at every
// place the reading context changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');
const rail = await read('./TurnRail.svelte');
const feed = await read('./Feed.svelte');
const hub = await read('./Hub.svelte');
const css = await read('../../app.css');
const style = /<style>([\s\S]*)<\/style>/u.exec(rail)?.[1] ?? '';
const markup = rail.slice(rail.indexOf('</script>'), rail.indexOf('<style>'));
const script = rail.slice(0, rail.indexOf('</script>'));
/** The code without its comments, so a comment may talk about what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:"'])\/\/.*$/gmu, '$1');
/** The rail's CSS without its comments (they quote tokens and issue numbers like #465). */
const styleCode = () => code(style);

test('the popover is the one mechanism: menuPlacementIn, the menu surface, one element, no tooltip protocol', () => {
  assert.match(script, /menuPlacementIn\(box, tick, \{ w: pw, h: ph \}, POPOVER_GAP, POPOVER_EDGE, 'right', 'left'\)/u,
    'placed beside the band, on its LEFT, by the shared rule and the shared gap/edge, inside the feed-wrap box');
  assert.doesNotMatch(code(script), /\bGAP\s*=|const GAP/u, 'no second gap constant');
  assert.match(script, /popOrigin\(tick, p, 'right', 'left'\)/u, 'it grows from the edge that touches the band');
  // ONE row, the probed turn (owner, 2026-10-24: "只预览当前选中的那个大一点的气泡，上下两个小的气泡就不显示了").
  assert.equal([...markup.matchAll(/class="menu-item tr-row"/gu)].length, 1, 'ONE row in the preview');
  assert.doesNotMatch(rail, /previewRows|\{#each rows|rows\.length/u, 'no neighbour rows');
  assert.match(markup, /onclick=\{\(\) => rail\.rowClick\(row\.key\)\}/u, 'the row commits the probed turn');
  assert.match(style, /\.tr-row \{[^}]*font-size: var\(--fs-body\)/u, 'at the bubble\'s own type step');
  assert.match(style, /-webkit-line-clamp: 3/u, 'a long first line is held to three lines');
  assert.equal([...markup.matchAll(/class="tr-pop menu-surface pop-layer"/gu)].length, 1, 'ONE popover element');
  assert.match(markup, /class="menu-list"/u);
  assert.match(markup, /class="menu-item tr-row"/u, 'the row is the menu atom');
  assert.doesNotMatch(rail, /HoverCard|hoverCard|hover\.svelte|role="tooltip"/u, 'not the tooltip protocol');
  assert.doesNotMatch(/\.tr-pop \{([^}]*)\}/u.exec(style)?.[1] ?? '', /pointer-events/u, 'the popover is operable (HoverCard is read-only; this is not)');
  assert.doesNotMatch(rail, /setTimeout|clearTimeout/u, 'the band-to-popover gap is a bridge, not a timer');
  // The corridor must be a real element, not a pseudo-element: the surface used to
  // clip it (overflow: hidden on .tr-pop), so the pointer left the cluster in the gap.
  assert.match(markup, /class="tr-bridge"/u, 'the corridor beside the band is its own element');
  assert.match(style, /\.tr-bridge \{ position: fixed;/u);
  assert.doesNotMatch(style, /\.tr-pop::(?:before|after)/u, 'a hit area outside the box would be clipped or lost');
  assert.doesNotMatch(/\.tr-pop \{([^}]*)\}/u.exec(style)?.[1] ?? '', /overflow/u, 'the surface clips nothing; only the list does');
  assert.match(markup, /style:height="\{placed\?\.bridge\.height \?\? 0\}px"/u, 'the corridor spans the band\'s whole height');
  assert.equal([...markup.matchAll(/onpointerleave=\{leaving\}/gu)].length, 3, 'band, corridor and popover share ONE leave rule');
  assert.match(markup, /onpointerdown=\{\(e\) => e\.preventDefault\(\)\}/u, 'a press on the popover never moves focus off the band');
  assert.match(markup, /tabindex="-1"/u, 'rows are not in the tab order');
});

test('the rail owns no scroll and no reading state: the ONE jump is the prop it is handed', () => {
  assert.doesNotMatch(code(script), /scrollTop|scrollTo\b|scrollIntoView|scrollBy|askKey|following|markSeen/u);
  assert.match(script, /jump: \(key\) => jump\(key\)/u);
  assert.match(feed, /jump=\{jumpToMsg\}/u, 'Feed hands it jumpToMsg, the same jump the double-tap and the expand use');
  assert.match(feed, /current=\{askKey\}/u, 'the lit tick is the anchor\'s key, projected and read-only');
  assert.doesNotMatch(code(script), /pickAnchor|heldAnchor|syncAsk/u, 'no second selection rule');
});

test('tokens and atoms only: no px, no literal colour, two declared tempos and no more', () => {
  assert.doesNotMatch(styleCode(), /\d+(?:\.\d+)?px/u, 'no raw px in the rail\'s CSS');
  assert.doesNotMatch(styleCode(), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/u, 'no literal colour');
  assert.doesNotMatch(styleCode(), /\d+(?:\.\d+)?m?s\b|cubic-bezier|@keyframes|animation/u, 'no raw time and no keyframes of its own');
  const transitions = [...styleCode().matchAll(/transition:\s*([^;]+);/gu)].map((m) => m[1]!.trim());
  assert.deepEqual(transitions, [
    'opacity var(--t-move) ease-out, transform var(--t-move) ease-out',
    'background var(--t-fast)',
  ], 'the rail\'s presence: ONE declaration, opacity + transform, --t-move (board #465); and the tick\'s colour on --t-fast');
  for (const token of ['--turn-rail-hit', '--turn-rail-inset', '--turn-tick-pitch', '--turn-tick-len', '--turn-tick-len-cur', '--turn-tick-thick', '--turn-pop-width', '--turn-rail-dwell', '--turn-rail-shift']) {
    assert.equal([...css.matchAll(new RegExp(`${token}:`, 'gu'))].length, 1, `${token} is defined once, in app.css`);
  }
  assert.match(css, /--turn-rail-hit: 44px;/u, 'the hit column is 44px on both screens');
  assert.doesNotMatch(styleCode(), /transition:[^;]*\b(?:width|height|top|left|margin|padding)\b/u, 'layout properties are not animated (motion.md)');
  assert.equal([...styleCode().matchAll(/touch-action:/gu)].length, 2, 'the band: auto while hidden, none while shown');
  assert.match(styleCode(), /\.tr-band \{[^}]*touch-action: auto/u);
  assert.match(styleCode(), /\.turn-rail\.shown \.tr-band \{ pointer-events: auto; touch-action: none; \}/u, 'only a SHOWN band takes the pointer and refuses the browser\'s scroll');
  assert.doesNotMatch(styleCode(), /\.turn-rail \{[^}]*touch-action/u, 'the column\'s empty parts refuse nothing');
  // The column overlays the feed and is inert: a wheel or a finger starting beside or above the band scrolls
  // the feed natively (validator, #461). The band is inert too until the rail is shown.
  assert.match(styleCode(), /\.turn-rail \{[^}]*position: absolute;[^}]*pointer-events: none;/u, 'the column overlays the feed and is inert');
  assert.match(styleCode(), /\.tr-band \{[^}]*pointer-events: none;/u, 'a hidden band takes no pointer');
});

test('only the inner paint layer moves: the column and the band keep the rectangles that are measured (#465)', () => {
  const rule = (selector: RegExp) => selector.exec(styleCode())?.[1] ?? '';
  // EVERY rule whose subject is the column or the band (a later `.turn-rail { transform }` is as bad as the first one).
  const measured = [...styleCode().matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selector]) => /^\.(?:turn-rail|tr-band)(?![\w-])/u.test(selector!.trim().split(/\s+/u).at(-1)!));
  assert.ok(measured.length >= 3, 'the column and the band rules were found');
  for (const [, selector, body] of measured) {
    assert.doesNotMatch(body!, /transform|transition|opacity|translate/u, `${selector!.trim()} neither moves nor fades: its rectangle feeds the input protocol and the popover`);
  }
  assert.match(rule(/\.tr-paint \{([^}]*)\}/u), /pointer-events: none;/u, 'the moving paint is never a target: only the fixed band takes input, so a press on the slid box outside it is the feed\u2019s (reviewer #465 P1-B)');
  assert.doesNotMatch([...styleCode().matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter(([, selector]) => /\.tr-(?:paint|tick)/u.test(selector!)).map(([, , body]) => body).join(' '), /pointer-events:\s*(?!none)\S/u, 'and nothing inside it turns pointer events back on');
  assert.match(rule(/\.tr-paint \{([^}]*)\}/u), /opacity: 0; transform: translateX\(var\(--turn-rail-shift\)\);/u);
  assert.match(styleCode(), /\.turn-rail\.shown \.tr-paint \{ opacity: 1; transform: none; \}/u);
  assert.match(markup, /<div class="tr-band"[\s\S]*?<div class="tr-paint">[\s\S]*?class="tr-tick"/u, 'the paint layer is INSIDE the band and holds the ticks');
  const hostEnd = markup.indexOf('{#if view.open && row}');
  const before = markup.slice(0, hostEnd);
  assert.ok(hostEnd > 0 && before.includes('class="tr-paint"'));
  assert.equal([...before.matchAll(/<div\b/gu)].length, [...before.matchAll(/<\/div>/gu)].length, 'column, band and paint are all closed before the popover and the corridor begin: they are not under the moving layer');
  assert.match(styleCode(), /@media \(prefers-reduced-motion: reduce\) \{ \.tr-paint \{ transform: none; \} \}/u, 'reduced motion: the fade stays, the slide goes');
});

test('visibility is derived by one controller; hidden is inert but reachable (#465)', async () => {
  const visibility = await read('./hub-turn-visibility.ts');
  assert.doesNotMatch(code(script), /setTimeout|clearTimeout|setInterval/u, 'no timer in the component: the dwell lives in the visibility controller');
  assert.doesNotMatch(code(visibility), /\b1500\b|\b1\.5\b/u, 'the dwell figure is not here: it is the CSS token');
  assert.match(script, /getComputedStyle\(hostEl\)\.getPropertyValue\('--turn-rail-dwell'\)/u, 'the one definition is read from the token');
  assert.match(css, /--turn-rail-dwell: 1500ms;/u);
  assert.match(script, /operable: \(\) => shown,/u, 'the input gate is the same fact as the class');
  assert.match(markup, /class="turn-rail" class:shown/u);
  assert.match(markup, /role="slider" tabindex="0"/u, 'still in the tab order while hidden, so Tab can bring it back');
  assert.doesNotMatch(markup, /<[^>]*\sinert[\s=>]/u, 'never the inert attribute: Tab must still reach the band');
  assert.doesNotMatch(styleCode(), /visibility:\s*hidden|display:\s*none/u, 'never hidden for the accessibility tree and the tab order');
  assert.match(markup, /vis\.hold\('focus', true\); rail\.focus\(\)/u, 'focus shows it before the preview opens');
  assert.match(script, /vis\.hold\('probe', next\.open\);/u, 'a probe is a hold');
  assert.match(markup, /if \(live && RAIL_KEYS\.includes\(e\.key\)\) vis\.hold\('focus', true\);\s*if \(rail\.key\(/u, 'a navigating key on a focused-but-hidden band is the keyboard\u2019s claim: it holds the rail BEFORE the protocol sees the key (reviewer #465 P1-A)');
  assert.match(script, /export function retire\(\) \{ rail\.retire\(\); vis\.reset\(\); \}/u, 'a reading-context change also drops the old pulse and timer');
  assert.match(script, /vis\.dispose\(\)/u);
  // Which scrolls count: only the reader scrolling away from the tail, from the feed\'s once-per-frame handler.
  assert.match(feed, /if \(!following\) turnRail\?\.nudge\(\);/u);
  // The mouse wake: mouse and pen hovering only, never a touch or a pressed button.
  assert.match(script, /if \(e\.pointerType === 'touch'\) return;\s*if \(e\.buttons !== 0 \|\| !live \|\| !hostEl\) \{ vis\.hold\('entered', false\); return; \}/u);
  assert.match(script, /wrap\.addEventListener\('pointerleave', leave\)/u);
});

test('the band is an operable slider that keeps a Tab exit and follows the preview', () => {
  assert.match(markup, /role="slider" tabindex="0" aria-orientation="vertical"/u);
  assert.match(markup, /aria-valuenow=\{shownIdx >= 0 \? shownIdx \+ 1 : count\} aria-valuetext=\{valueText\}/u,
    'value and text follow the PREVIEW while one is open, else the current turn');
  assert.match(markup, /onkeydown=\{\(e\) => \{[^]*?if \(rail\.key\(e\.key, e\.repeat\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}\s*\}\}/u,
    'handled keys do not scroll the feed; everything else (Tab) is left alone');
  assert.match(markup, /oncontextmenu=\{\(e\) => e\.preventDefault\(\)\}/u);
  assert.match(script, /window\.addEventListener\('pointerdown', outside, true\)/u);
  assert.doesNotMatch(code(script), /\.focus\(\)/u, 'an outside press never steals focus back to the band');
});

test('the rail floats over the right edge and reserves NO space: the feed\'s geometry is untouched (#463)', () => {
  const feedStyle = feed.slice(feed.indexOf('<style>'));
  // Nothing of the feed or its wrap depends on the rail: no class, no variable, no padding rule.
  assert.doesNotMatch(feed, /railed|--feed-pad-x|railOn/u, 'no rail-dependent padding, class or layout effect');
  for (const m of feedStyle.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    if (/\.feed(?:-wrap)?\b/u.test(m[1]!)) assert.doesNotMatch(m[2]!, /--turn-rail/u, `${m[1]!.trim()} does not read a rail token`);
  }
  assert.doesNotMatch(feed, /withReadingAnchor\(\(\) => \{ rail/u, 'its appearing is not a reading transaction: it changes no layout');
  assert.match(feed, /const railWanted = \$derived\(roomReady && turns\.length >= 2\);/u, 'hidden with fewer than two turns and until the room settled');
  assert.match(feed, /\{#if railWanted\}\s*<TurnRail bind:this=\{turnRail\} \{turns\}/u, 'a plain {#if}, a sibling of the scroller, fed the shared turns');
  assert.match(style, /\.turn-rail \{[^}]*position: absolute;[^}]*inset-inline-end: var\(--turn-rail-edge, 0\);/u, 'at the right (inline end), standing clear of a classic scrollbar');
  assert.match(style, /\.turn-rail \{[^}]*inset-block: var\(--turn-rail-inset\) var\(--turn-rail-clear\);/u);
  assert.match(style, /\.tr-tick \{[^}]*justify-content: flex-start;/u, 'ticks at the INNER (left) side of the column');
  assert.doesNotMatch(feed, /<TurnRail[^>]*>\s*[^<]*<\/TurnRail>/u);
});

test('the rail stays clear of the back-to-tail control, hit area included', () => {
  // The control: .to-bottom { right/bottom } in Feed.svelte, .to-tail { 38px } and its ::before overhang in app.css.
  const bottom = Number(/\.to-bottom \{[^}]*bottom: (\d+)px/u.exec(feed)?.[1]);
  const size = Number(/\.to-tail \{[^}]*?height: (\d+)px/u.exec(css)?.[1]);
  const overhang = Math.abs(Number(/\.to-tail::before \{[^}]*inset: (-?\d+)px/u.exec(css)?.[1]));
  const clear = Number(/--turn-rail-clear: (\d+)px/u.exec(css)?.[1]);
  assert.ok(bottom > 0 && size > 0 && overhang > 0 && clear > 0, 'all four numbers were read');
  assert.ok(clear >= bottom + size + overhang, `--turn-rail-clear (${clear}px) clears the control's whole hit area (${bottom} + ${size} + ${overhang}px)`);
});

test('retire() is CALLED at every place the reading context changes', () => {
  assert.match(feed, /export function resetForRoom\(\) \{\s*turnRail\?\.retire\(\);/u, 'every room selection, cached or not');
  assert.match(hub, /const newReading = \(\) => \{ feedView\?\.retireTurnRail\(\); return \+\+readGen; \};/u,
    'a jump, a return and a room switch each mint a reading');
  assert.match(hub, /if \(filterAgent === next\) return;\s*feedView\?\.retireTurnRail\(\);[^\n]*\n\s*filterAgent = next;/u, 'the one filter writer');
  // The call-constraint proof: every write of the window or the filter sits in a
  // function that also retires. A new write site without it fails here.
  const starts = [...hub.matchAll(/\n  (?:async )?function \w+|\n  const \w+ = (?:async )?\(/gu)].map((m) => m.index!);
  const body = (at: number) => {
    const from = [...starts].reverse().find((s) => s < at) ?? 0;
    const to = starts.find((s) => s > at) ?? hub.length;
    return hub.slice(from, to);
  };
  const writes = [...hub.matchAll(/\b(?:windowed|filterAgent) = (?!\$state)/gu)].map((m) => m.index!);
  assert.ok(writes.length >= 4, 'the writes of windowed and filterAgent were found');
  for (const at of writes) {
    assert.match(body(at), /newReading\(\)|retireTurnRail\(\)/u, `the write near "${hub.slice(at, at + 40).replace(/\s+/gu, ' ')}" sits beside a retirement`);
  }
});

test('the back stack and the host gate close the preview', () => {
  assert.match(hub, /backLayers\.register\('turnRail', \(\) => \{ if \(feedView\?\.closeTurnRail\(\)\) return true; return false; \}\)/u);
  assert.match(script, /\$effect\(\(\) => \{ if \(!live\) untrack\(\(\) => \{ rail\.retire\(\); vis\.clear\(\); \}\); \}\);/u, 'the gate falling edge retires too, and clears every hold');
  assert.match(feed, /live=\{visible && roomReady && turns\.length >= 2\}/u);
});

test('the one jump reports where it landed: moved, in-view or missing', () => {
  const body = /function jumpToMsg\(key\) \{([\s\S]*?)\n  \}\n/u.exec(feed)?.[1] ?? '';
  assert.equal([...body.matchAll(/return 'missing';/gu)].length, 2, 'no feed, or no mounted message: nothing moved');
  assert.match(body, /syncAsk\(\);\s*return 'in-view';/u, 'the start was already on screen: only the anchor is re-seeded');
  assert.match(body, /syncAsk\(askDir, true\);\s*return 'moved';/u);
});

test('the rail\'s geometry changing is a retirement called at the change', () => {
  assert.match(script, /window\.addEventListener\('resize', changed\)/u);
  assert.match(script, /window\.addEventListener\('app-zoom-change', changed\)/u);
  assert.match(script, /const changed = \(\) => \{ measure\(\); moved\(\); \};/u, 'a resize or a zoom also reads the scrollbar afresh');
  assert.match(script, /vv\?\.addEventListener\('resize', moved\)/u);
  assert.match(script, /vv\?\.addEventListener\('scroll', moved\)/u);
  assert.match(script, /const targets = \[hostEl, band, bounds, scroller\]/u, 'the column, the band, the feed-wrap and the scroller are observed');
  assert.match(script, /scroller\.offsetWidth - scroller\.clientWidth/u, 'the scrollbar width is read, never assumed');
  assert.match(script, /if \(next !== edge\) \{ edge = next; moved\(\); \}/u, 'and a scrollbar that appears or goes retires the rail');
  assert.match(script, /const moved = \(\) => untrack\(\(\) => rail\.retire\(\)\);/u);
});

test('the leftward reach is measured from the band to the screen\'s LEFT, and the tick\'s colour change is on --t-fast (#463)', () => {
  assert.match(script, /reach: \(r\) => Math\.max\(0, Math\.min\(2 \* \(r\.right - r\.left\), r\.left\)\),/u,
    'the room to slide into is what is left of the band; measuring toward the right edge collapses the graded slow-down into the slowest at once');
  assert.doesNotMatch(code(script), /innerWidth\s*-\s*r\.right/u);
  assert.match(style, /\.tr-tick::before \{[^}]*transition: background var\(--t-fast\);/u, 'the emphasis moves on --t-fast (an existence check: a rule that is missing must fail)');
});
