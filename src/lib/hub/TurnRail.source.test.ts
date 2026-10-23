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

test('the popover is the one mechanism: menuPlacementIn, the menu surface, one element, no tooltip protocol', () => {
  assert.match(script, /menuPlacementIn\(box, a, \{ w: pw, h: ph \}, POPOVER_GAP, POPOVER_EDGE, 'right', 'right'\)/u,
    'placed beside the band by the shared rule and the shared gap/edge, inside the feed-wrap box');
  assert.doesNotMatch(code(script), /\bGAP\s*=|const GAP/u, 'no second gap constant');
  assert.match(script, /popOrigin\(a, p, 'right', 'right'\)/u, 'it grows from the edge that touches the band');
  assert.equal([...markup.matchAll(/class="tr-pop menu-surface pop-layer"/gu)].length, 1, 'ONE popover element');
  assert.match(markup, /class="menu-list"/u);
  assert.match(markup, /class="menu-item tr-row"/u, 'rows are the menu atom');
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

test('tokens and atoms only: no px, no literal colour, no second tempo', () => {
  assert.doesNotMatch(style, /\d+(?:\.\d+)?px/u, 'no raw px in the rail\'s CSS');
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/u, 'no literal colour');
  assert.doesNotMatch(style, /--t-move|\bms\b|\d+s\b|ease|cubic-bezier|@keyframes|animation/u, 'only --t-fast, and no keyframes of its own');
  for (const m of style.matchAll(/transition:\s*([^;]+);/gu)) {
    for (const part of m[1]!.split(',')) assert.match(part, /var\(--t-fast\)/u, `transition on --t-fast only: ${part.trim()}`);
  }
  for (const token of ['--turn-rail-hit', '--turn-rail-inset', '--turn-tick-pitch', '--turn-tick-len', '--turn-tick-len-cur', '--turn-tick-thick', '--turn-pop-width']) {
    assert.equal([...css.matchAll(new RegExp(`${token}:`, 'gu'))].length, 1, `${token} is defined once, in app.css`);
  }
  assert.match(css, /--turn-rail-hit: 44px;/u, 'the hit column is 44px on both screens');
  assert.doesNotMatch(style, /transition:[^;]*\bwidth\b/u, 'layout properties are not animated (motion.md)');
  assert.match(style, /touch-action: none/u);
  assert.equal([...style.matchAll(/touch-action:/gu)].length, 1, 'only the band refuses the browser\'s scroll');
  assert.match(style, /\.tr-band \{[^}]*touch-action: none/u);
  assert.doesNotMatch(style, /\.turn-rail \{[^}]*touch-action/u, 'the column\'s empty parts refuse nothing');
  // The column is the feed's own padding with the rail laid over it: inert except the band, so
  // a wheel or a finger starting beside or above the band scrolls the feed natively (validator, #461).
  assert.match(style, /\.turn-rail \{[^}]*position: absolute;[^}]*pointer-events: none;/u, 'the column overlays the padding and is inert');
  assert.match(style, /\.tr-band \{[^}]*pointer-events: auto;/u, 'only the band takes the pointer');
});

test('the band is an operable slider that keeps a Tab exit and follows the preview', () => {
  assert.match(markup, /role="slider" tabindex="0" aria-orientation="vertical"/u);
  assert.match(markup, /aria-valuenow=\{shownIdx >= 0 \? shownIdx \+ 1 : count\} aria-valuetext=\{valueText\}/u,
    'value and text follow the PREVIEW while one is open, else the current turn');
  assert.match(markup, /onkeydown=\{\(e\) => \{ if \(rail\.key\(e\.key, e\.repeat\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \} \}\}/u,
    'handled keys do not scroll the feed; everything else (Tab) is left alone');
  assert.match(markup, /oncontextmenu=\{\(e\) => e\.preventDefault\(\)\}/u);
  assert.match(script, /window\.addEventListener\('pointerdown', outside, true\)/u);
  assert.doesNotMatch(code(script), /\.focus\(\)/u, 'an outside press never steals focus back to the band');
});

test('the column is the feed\'s own padding and its appearance goes through the reading anchor', () => {
  assert.match(feed, /\.feed-wrap\.railed > \.feed \{ padding-left: max\(var\(--feed-pad-x\), calc\(var\(--turn-rail-hit\) \+ var\(--ui-gap\)\)\); \}/u,
    'the bubbles stand where a flex gutter put them, and the column stays part of the scroller');
  assert.match(feed, /untrack\(\(\) => \{ if \(want !== railOn\) withReadingAnchor\(\(\) => \{ railOn = want; \}\); \}\);/u,
    'the 1-to-2 turns change is a layout mutation like every other');
  assert.match(feed, /const railWanted = \$derived\(roomReady && turns\.length >= 2\);/u, 'hidden with fewer than two turns and until the room settled');
  assert.doesNotMatch(feed, /\.feed-wrap\.railed[^{]*\{[^}]*transition/u, 'the gutter\'s width is not animated');
  assert.match(feed, /<TurnRail bind:this=\{turnRail\} \{turns\}/u, 'laid over the scroller\'s padding, never inside it, fed the shared turns');
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
  assert.match(script, /\$effect\(\(\) => \{ if \(!live\) untrack\(\(\) => rail\.retire\(\)\); \}\);/u, 'the gate falling edge retires too');
  assert.match(feed, /live=\{visible && roomReady && turns\.length >= 2\}/u);
});

test('the one jump reports where it landed: moved, in-view or missing', () => {
  const body = /function jumpToMsg\(key\) \{([\s\S]*?)\n  \}\n/u.exec(feed)?.[1] ?? '';
  assert.equal([...body.matchAll(/return 'missing';/gu)].length, 2, 'no feed, or no mounted message: nothing moved');
  assert.match(body, /syncAsk\(\);\s*return 'in-view';/u, 'the start was already on screen: only the anchor is re-seeded');
  assert.match(body, /syncAsk\(askDir, true\);\s*return 'moved';/u);
});

test('the rail\'s geometry changing is a retirement called at the change', () => {
  assert.match(script, /window\.addEventListener\('resize', moved\)/u);
  assert.match(script, /window\.addEventListener\('app-zoom-change', moved\)/u);
  assert.match(script, /vv\?\.addEventListener\('resize', moved\)/u);
  assert.match(script, /vv\?\.addEventListener\('scroll', moved\)/u);
  assert.match(script, /const targets = \[hostEl, band, bounds\]/u, 'the column, the band and the feed-wrap are observed');
  assert.match(script, /const moved = \(\) => untrack\(\(\) => rail\.retire\(\)\);/u);
});
