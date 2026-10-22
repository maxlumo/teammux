import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Lightbox.svelte', import.meta.url), 'utf8');
const markup = source.slice(source.indexOf('<svelte:window'), source.indexOf('<style>'));
const style = source.slice(source.indexOf('<style>'));

// Board #447: the viewer's download control. The contract is structural, so it is pinned as source.

test('every gesture lives on the stage; the bar and the status are siblings outside the pointer capture (#447)', () => {
  const root = markup.slice(markup.indexOf('<div class="lb"'), markup.indexOf('>', markup.indexOf('<div class="lb"')) + 1);
  assert.doesNotMatch(root, /onpointer|onwheel|onclick/u, 'the root takes no input: a capture there would swallow the controls\' release and click');
  const stage = markup.slice(markup.indexOf('<div class="lb-stage"'), markup.indexOf('</div>', markup.indexOf('<div class="lb-stage"')));
  for (const handler of ['onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel', 'onclick', 'onwheel']) {
    assert.match(stage, new RegExp(`${handler}=`, 'u'), `the stage owns ${handler}`);
  }
  assert.match(stage, /<img class="lb-img"/u);
  const afterStage = markup.slice(markup.indexOf('</div>', markup.indexOf('<div class="lb-stage"')));
  assert.match(afterStage, /<div class="lb-bar">/u, 'the bar follows the stage, outside it');
  assert.match(afterStage, /<div class="lb-status">/u, 'and so does the status');
  assert.doesNotMatch(stage, /lb-bar|lb-btn|lb-status|OperationFeedback/u);
});

test('download and close are ONE control family: a 44px box, a painted square inside, tokens only (#447)', () => {
  assert.match(markup, /<button class="lb-btn lb-download" type="button" aria-label=\{t\('filesDownload'\)\} onclick=\{ondownload\}><Icon name="download" size=\{16\} \/><\/button>/u);
  assert.match(markup, /<button class="lb-btn lb-close" type="button" aria-label="close" onclick=\{onclose\}>✕<\/button>/u);
  assert.match(markup, /\{#if ondownload && !downloading\}/u, 'offered only with a handler, and not while its save runs');
  assert.match(style, /\.lb-btn \{[^}]*width: 44px; height: 44px;/u, 'the touch box is real');
  assert.match(style, /\.lb-btn::before \{[^}]*inset: 5px;[^}]*border-radius: var\(--ui-radius-control\); border: 1px solid var\(--border2\);[^}]*background: var\(--surface\);/u, 'the paint is the 34px square ✕ always had');
  assert.match(style, /\.lb-bar \{[^}]*display: flex; gap: var\(--ui-gap\);/u, 'neighbours abut and need only the shared gap');
  assert.match(style, /top: calc\(8px - 5px \+ var\(--sat, 0px\)\)/u, 'below the status strip, never raw env()');
  assert.doesNotMatch(style, /\.lb-close(?!,)[^{]*\{[^}]*(width|height):/u, 'close has no geometry of its own');
  assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b|rgba?\(/iu, 'no literal colour');
  assert.doesNotMatch(style, /::after/u, 'the old overlapping hit extension is gone');
});

test('the status is the one OperationFeedback atom, above the safe area (#447)', () => {
  assert.match(markup, /<div class="lb-status"><OperationFeedback value=\{status\} ondismiss=\{status\.kind === 'error' \? onstatusdismiss : undefined\} \/><\/div>/u);
  assert.match(style, /\.lb-status \{[^}]*bottom: calc\(var\(--ui-gap\) \* 4 \+ var\(--sab, 0px\)\);[^}]*pointer-events: none;/u);
  assert.doesNotMatch(source, /createFeedbackLifetime|setTimeout\([^)]*status/u, 'the host owns the feedback lifetime, not the atom');
});

test('a tap closes by its gesture\'s record, never by the scale its click finds (#449)', () => {
  const backdrop = source.slice(source.indexOf('function onBackdrop'), source.indexOf('function onKey'));
  assert.doesNotMatch(backdrop, /\bscale\b/u, 'the click arrives after pointerup: reading the scale there sees a double-tap that just zoomed out');
  assert.match(backdrop, /e\.target === e\.currentTarget && tapCloses && !moved\) onclose\(\)/u);
  const down = source.slice(source.indexOf('function onPointerDown'), source.indexOf('function onPointerMove'));
  assert.match(down, /tapCloses = pointers\.size === 0 && scale === 1;[^\n]*\n\s*pointers\.set\(/u, 'taken afresh by each first finger, before it is counted');
  // every real zoom path ends the qualification, not one hand-picked branch
  assert.match(source, /if \(s2 !== scale\) tapCloses = false;/u, 'pinch, wheel and double-tap zoom-in all go through zoomAt');
  assert.match(source, /scale = 1; tx = 0; ty = 0; tapCloses = false;/u, 'the double-tap zoom-out');
  assert.match(source, /if \(e\.type === 'pointercancel'\) tapCloses = false;/u);
  assert.match(source, /!moved && e\.type !== 'pointercancel'\)/u, 'a cancelled gesture is no half of a double-tap');
});
