// Source pins for the notification centre's row (board #356, owner
// 2026-10-13's phone screenshot): a row is three FIXED lines — identity
// (dot · project · time), meta (tag · who · "to you"), excerpt — so the
// project name is never the loser of a flex fight, the time is tiered to one
// stable width, and "to you" never wraps. The same structure on both screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./NotifyCentre.svelte', import.meta.url)), 'utf8');

test('a row is three fixed lines: identity, meta, excerpt — the project shares its line only with the dot and the time', () => {
  const top = source.match(/<span class="nc-top">([\s\S]*?)<\/span>\s*<span class="nc-meta">/u)?.[1] ?? '';
  assert.ok(top, 'the identity line exists, followed by the meta line');
  assert.match(top, /class="nc-project"/u);
  assert.match(top, /class="nc-time"/u);
  assert.ok(!/ServerTag|nc-who|nc-tag/u.test(top), 'tag, who and "to you" are NOT on the project s line');
  const meta = source.match(/<span class="nc-meta">([\s\S]*?)<\/span>\s*<span class="nc-text">/u)?.[1] ?? '';
  assert.match(meta, /<ServerTag name=\{a\.tag\} \/>/u);
  assert.match(meta, /class="nc-who"/u);
  assert.match(meta, /class="nc-tag"/u);
  assert.match(source, /<span class="nc-text">\{a\.excerpt\}<\/span>/u, 'the excerpt is the third line');
});

test('the project is the only shrinkable item of its line; the time is flex:none and tabular; "to you" never wraps', () => {
  assert.match(source, /\.nc-project \{[^}]*flex: 1 1 auto; min-width: 0;[^}]*text-overflow: ellipsis;[^}]*\}/u, 'the project takes the line and ellipsises last');
  assert.match(source, /\.nc-time \{[^}]*flex: none;[^}]*tabular-nums;[^}]*\}/u, 'the time never shrinks');
  assert.ok(!/\.nc-time \{[^}]*margin-left: auto/u.test(source), 'no auto margin: the project s flex owns the leftover');
  assert.match(source, /\.nc-tag \{[^}]*flex: none;[^}]*white-space: nowrap;[^}]*\}/u, '"to you" is one word pair, never two lines');
  assert.match(source, /\.nc-who \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*\}/u, 'a long sender ellipsises on ITS line');
  assert.match(source, /\.nc-meta \{[^}]*display: flex;[^}]*min-width: 0;[^}]*\}/u);
});

test('the list time is the tiered form; the hover card s full form is not used here', () => {
  assert.match(source, /import \{ agentHue, listWhen \} from '\.\/hub\.ts';/u);
  assert.match(source, /const when = \(ms: number\) => listWhen\(Math\.floor\(ms \/ 1000\)\);/u);
  assert.ok(!/localWhen/u.test(source));
});

test('no raw sizes or colours: tokens only (design-language contract)', () => {
  const css = source.slice(source.indexOf('<style>'));
  assert.ok(!/font-size:\s*\d/u.test(css), 'no raw px font-size');
  assert.ok(!/#[0-9a-f]{3,8}\b/iu.test(css), 'no raw colour');
  assert.ok(!/@media/u.test(css), 'one structure on both screens: no breakpoint changes the grid');
});
