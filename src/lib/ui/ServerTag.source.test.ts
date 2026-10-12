// The ONE server tag (board #335 ③c-1): a micro tag in the existing
// vocabulary — tag radius, meta type role, achromatic identity ink — and
// rendered only when its host passes a name; the rule for WHEN lives in
// app/server-tag.ts, nowhere in the atom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ServerTag.svelte', import.meta.url), 'utf8');
const style = source.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? '';
/** The component without its comments: what it DOES. */
const code = source.replace(/\/\/[^\n]*/gu, '').replace(/<!--[\s\S]*?-->/gu, '');

test('the server tag is a micro tag in existing tokens: pill radius, --fs-micro, --text2 on --surface2, no status colour', () => {
  assert.match(source, /border-radius: var\(--ui-radius-pill\)/u);
  assert.match(source, /font: 500 var\(--fs-micro\)/u);
  assert.match(source, /background: var\(--surface2\); color: var\(--text2\);/u, 'a server is identity, not a state');
  assert.doesNotMatch(style, /--status-|--accent|--danger|--agent-\d|#[0-9a-f]{3,8}\b/iu, 'no status colour, no agent ink, no literal colour');
  assert.equal([...style.matchAll(/\d+px/gu)].length, 1, "one raw measure: the 6px inline padding of a micro tag (design-language §Radius: tags keep their historical geometry)");
});

test('it renders nothing without a name — Single is tag-free by construction, and the atom decides nothing itself', () => {
  assert.match(source, /\{#if name\}\s*<span class="server-tag"/u);
  assert.doesNotMatch(code, /included|aggregate|readMode|localStorage/u, 'the rule for WHEN is app/server-tag.ts');
});
