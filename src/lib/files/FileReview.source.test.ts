// Board #434, reviewer P1-C and P2 on 5b2a004f: the card column's lane is a
// real scroller (no overflow:hidden hiding the stack), the spacing comes from
// tokens, and a card's top is placed in the uiZoom coordinate rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./FileReview.svelte', import.meta.url), 'utf8');
const style = source.slice(source.indexOf('<style>'), source.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//gu, '');

test('the lane scrolls, and nothing in the column hides overflow', () => {
  assert.match(style, /\.rv-lane \{[^}]*overflow-y: auto/u);
  for (const rule of ['.rv-column', '.rv-lane', '.rv-lane-inner']) {
    const body = new RegExp(`\\${rule} \\{([^}]*)\\}`, 'u').exec(style)?.[1] ?? '';
    assert.ok(body, rule);
    assert.doesNotMatch(body, /overflow: hidden/u, `${rule}: a clipped stack is unreachable`);
  }
});

test('spacing is tokens: no raw px in a gap or a padding', () => {
  for (const m of style.matchAll(/(?:^|[\s;{])(gap|row-gap|padding|margin):\s*([^;}]+)/gu)) {
    assert.doesNotMatch(m[2]!, /\d+px/u, `${m[1]}: ${m[2]}`);
  }
});

test('a card top is in zoomed CSS pixels through ONE conversion; uiZoom divides a page rect once', () => {
  // The page's own rects: divided by uiZoom.
  assert.match(source, /toParent: \(r\) => \(\{ left: r\.left \/ z, right: r\.right \/ z, top: r\.top \/ z, bottom: r\.bottom \/ z \}\)/u);
  // The frame's (#434 HTML, design delta 1 P1-B): the frame ELEMENT's rect is
  // divided once and its border added; the inner rect is already in the
  // frame's CSS pixels, which are the page's zoomed ones.
  assert.match(source, /const ox = fr\.left \/ z \+ f\.clientLeft, oy = fr\.top \/ z \+ f\.clientTop;/u);
  assert.match(source, /toParent: \(r\) => \(\{ left: ox \+ r\.left, right: ox \+ r\.right, top: oy \+ r\.top, bottom: oy \+ r\.bottom \}\)/u);
  // Cards and the ＋ go through it; nothing else divides by z in placement.
  const place = source.slice(source.indexOf('function placeCards()'), source.indexOf('let placeQueued'));
  assert.match(place, /s\.toParent\(r\.getBoundingClientRect\(\)\)\.top - scTop \+ sc\.scrollTop \+ offset/u);
  assert.match(source, /anchor: s\.toParent\(rectOf\(r\)\)/u);
});

test('a card top and the lane height never read the lane\u2019s own scroll (reviewer P1-C on 93c1b929)', () => {
  const place = source.slice(source.indexOf('function placeCards()'), source.indexOf('let placeQueued'));
  assert.ok(place.length > 100, 'placeCards found');
  assert.ok(!place.includes('lane.scrollTop'), 'the lane\u2019s own scroll is in no formula');
  assert.match(source, /if \(sc === s\.scroller && laneEl\) laneEl\.scrollTop = sc\.scrollTop;/u, 'the preview drives the lane');
});

test('the Files page takes the strip reserve when its content fills the strip corner (#434 validator on 4500d422)', async () => {
  const files = await readFile(new URL('./Files.svelte', import.meta.url), 'utf8');
  assert.match(files, /const stripOverContent = \$derived\(!splitEligible \|\| \(view !== 'list' && !wideEnough\)\);/u,
    'single-pane, or the split with its list hidden below 900px');
  assert.match(files, /<div class="files"[^>]*class:strip-over=\{stripOverContent\}/u);
  assert.doesNotMatch(source.slice(source.indexOf('<style>')), /--sys-sidebar-h|z-index: \d{3,}/u, 'no private offset, no new layer in the review itself');
});

test('a card\u2019s menu button is named for what it is, not "File tools"', () => {
  assert.match(source, /label=\{`\$\{t\('reviewCardMenu'\)\}: \$\{cut\(a\.quote\)\}`\}/u);
  assert.doesNotMatch(source, /t\('filesTools'\)/u);
});
