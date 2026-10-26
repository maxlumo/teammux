import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Board #470: the player's pre-frame placeholder is the existing skeleton
// atom in the design tokens, and only the Android app sets a poster.
const source = readFileSync(new URL('./MediaPlayer.svelte', import.meta.url), 'utf8');
const css = source.slice(source.indexOf('<style>'));

test('the placeholder wears the existing .skel / .skel-wrap atoms and tokens only — no new species, no literal colour or px (#470)', () => {
  assert.match(source, /<div class="mp-ph skel-wrap" aria-hidden="true" style:--mp-aspect=\{aspect\}>/u, 'the 150ms delay of motion.md principle 15');
  assert.match(source, /<span class="skel mp-ph-tile" class:still=\{hasData \|\| !!error\}>/u, 'the skeleton atom; still once there is data or an error');
  assert.match(source, /\{#if hasData && !error\}<span class="mp-ph-play"><Icon name="play" \/><\/span>\{\/if\}/u, 'the play glyph only on a playable, loaded picture');
  const rules = [...css.matchAll(/^\s*\.mp-ph[^{]*\{[^}]*\}/gmu)].map((m) => m[0]);
  assert.equal(rules.length, 4, 'the four placeholder rules');
  for (const rule of rules) {
    assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\d+px/iu, `tokens only: ${rule.trim()}`);
  }
  assert.match(css, /\.mp-ph-play \{ display: flex; color: var\(--text3\); \}/u, 'the glyph at the decorative rest ink');
  assert.match(css, /\.mp-ph-tile\.still::after \{ content: none; \}/u, 'ready or failed: no loading motion');
});

test('only the Android app gives the video a poster, from the first mount; preload stays metadata (#470)', () => {
  assert.match(source, /<video bind:this=\{mediaEl\} playsinline preload="metadata" src=\{ownSrc \?\? src\} \{\.\.\.media\}\s*poster=\{isAndroid \? BLANK_POSTER : undefined\}/u);
  assert.equal([...source.matchAll(/poster=/gu)].length, 1, 'one poster, on the element itself');
  assert.match(source, /if \(hasData && \(!isAndroid \|\| posterCleared\)\) framed = true;/u, 'the Android branch waits for the show-poster flag to clear');
});
