// Board #434, the HTML preview: a selection in the frame maps to the SOURCE
// through parse5's recorded positions, checked unit for unit against the
// frame's DOM. Each row builds the frame document the way the app does — the
// real basedPreviewDoc serialization, parsed again by a browser-grade DOM
// (jsdom) — selects as a person would and asserts the STORED range and
// quote, not only the shown text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { basedPreviewDoc } from './file-preview.ts';
import { htmlHighlight, htmlSelection } from './review-html.ts';
import { htmlSourceMap } from './review-html-map.ts';
import { offsetsToRange, rangeToOffsets } from './review-anchor.ts';

async function frame(content: string) {
  const parser = new (new JSDOM('').window.DOMParser)();
  const doc = new JSDOM(basedPreviewDoc(content, null, parser)).window.document;
  const map = await htmlSourceMap(content);
  const texts = () => {
    const w = doc.createTreeWalker(doc.body, 4);
    const out: Text[] = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  };
  const at = (needle: string, nth = 0) => {
    let k = 0;
    for (const t of texts()) for (let i = t.data.indexOf(needle); i >= 0; i = t.data.indexOf(needle, i + 1)) if (k++ === nth) return { node: t, start: i, end: i + needle.length };
    throw new Error(`no ${needle} #${nth}`);
  };
  const select = (a: { node: Node; start: number }, b: { node: Node; end: number }) => {
    const r = doc.createRange();
    r.setStart(a.node, a.start); r.setEnd(b.node, b.end);
    return htmlSelection(doc, r, content, map);
  };
  const word = (needle: string, nth = 0) => { const p = at(needle, nth); return select(p, p); };
  /** The LINE-model source a mapped selection stores. */
  const stored = (m: ReturnType<typeof htmlSelection>) => {
    if (!m || !('range' in m)) return `refused:${m && 'refused' in m ? m.refused : 'none'}`;
    const [a, b] = rangeToOffsets(content, m.range)!;
    return content.replace(/\r\n/gu, '\n').slice(a, b);
  };
  const shown = (m: ReturnType<typeof htmlSelection>) => (m && 'range' in m ? htmlHighlight(doc, m.range, content, map)?.toString() ?? null : null);
  return { doc, map, at, select, word, stored, shown };
}
const R = (line: number, col: number, end_line: number, end_col: number) => ({ range: { line, col, end_line, end_col } });

test('entities: the shown "&" stores its whole reference; a reference next to an emoji', async () => {
  const f = await frame('<p>Tom &amp; Jerry 👍🏽&nbsp;ok &#x1F600; end</p>');
  assert.deepEqual(f.word('&'), R(1, 8, 1, 13));
  assert.equal(f.stored(f.word('Tom & Jerry')), 'Tom &amp; Jerry');
  assert.equal(f.stored(f.word('👍🏽')), '👍🏽');
  assert.equal(f.stored(f.word('\u{1F600}')), '&#x1F600;', 'an astral reference: both units share its span');
  // Half of the astral character selected stores the WHOLE reference.
  const p = f.at('\u{1F600}');
  assert.equal(f.stored(f.select({ node: p.node, start: p.start }, { node: p.node, end: p.start + 1 })), '&#x1F600;');
  assert.equal(f.stored(f.select({ node: p.node, start: p.start + 1 }, { node: p.node, end: p.start + 2 })), '&#x1F600;', 'and its second half too');
  assert.equal(f.shown(f.word('&')), '&', 'and its highlight is what is shown');
});

test('CRLF before the node and across lines: the stored line/col are the LINE model\u2019s', async () => {
  const f = await frame('<!doctype html>\r\n<html>\r\n<body>\r\n<h1>Title</h1>\r\n<p>one\r\ntwo three</p>\r\n</body></html>\r\n');
  assert.ok(f.map, 'the newline after </html> (no location, whitespace) does not refuse the page');
  assert.deepEqual(f.word('Title'), R(4, 5, 4, 10));
  assert.deepEqual(f.select(f.at('one'), f.at('two')), R(5, 4, 6, 4), 'across a CRLF inside the paragraph');
  assert.equal(f.stored(f.select(f.at('one'), f.at('two'))), 'one\ntwo');
  assert.deepEqual(f.select(f.at('Title'), f.at('three')), R(4, 5, 6, 10), 'across elements and lines');
});

test('a lone CR refuses the document', async () => {
  const f = await frame('<p>a\rb</p>');
  assert.equal(f.map, null);
  assert.deepEqual(f.word('a'), { refused: 'reviewRefusedRendered' });
  // In markup too, where no text node's value would disagree: the browser
  // reads it as a line break, the LINE model as a character.
  const g = await frame('<p\rclass="a">word</p>');
  assert.equal(g.map, null, 'a lone CR outside any text is refused as well');
});

test('nested inline elements, twins, script and style skipped, noscript shown, a comment', async () => {
  const src = '<style>p{color:red}</style><p>same <b>bold <i>it</i></b> same</p><script>var same=1</script><noscript><p>shown when scripts are off</p></noscript><!-- same -->';
  const f = await frame(src);
  assert.ok(f.map, 'mappable');
  assert.equal(f.stored(f.word('same', 1)), 'same', 'the second twin');
  assert.deepEqual(f.word('same', 1), R(1, 58, 1, 62));
  assert.equal(f.stored(f.select(f.at('bold'), f.at('it'))), 'bold <i>it');
  assert.equal(f.stored(f.word('shown')), 'shown', 'noscript is markup with scripting off, in both parses');
});

test('a table with foster-parented text and error recovery', async () => {
  const f = await frame('<table><tr><td>cell</td></tr>stray</table><p>after</p>');
  // Whether the stray text survives both parses identically or not, the
  // answer is a proved position or a refusal, never another occurrence.
  const got = f.word('after');
  if ('range' in got!) assert.equal(f.stored(got), 'after');
  else assert.deepEqual(got, { refused: 'reviewRefusedRendered' });
  const cell = f.stored(f.word('cell'));
  assert.ok(cell === 'cell' || cell.startsWith('refused'), cell);
  const g = await frame('<p>unclosed <b>bold<p>next');
  assert.equal(g.stored(g.word('next')), 'next');
  assert.equal(g.stored(g.word('bold')), 'bold');
});

test('text shown out of source order: a selection across it is refused, never cut or widened; in order it is exact (reviewer P1 on 6a4950ec)', async () => {
  const content = '<table><tr><td>A</td></tr>B</table><p>C</p>';
  const f = await frame(content);
  assert.deepEqual(f.map?.map((u) => u.ch), ['B', 'A', 'C'], 'foster parenting shows B before the table: DOM order B, A, C; source order A, B, C');
  // A browser builds the spec's tree, parse5's own: B before the table.
  // jsdom's DOMParser leaves it after (the two parses would disagree and the
  // page be refused before any selection), so the frame is set as a browser
  // sets it, and the order rule itself is what is tested here.
  const table = f.doc.querySelector('table')!;
  const stray = table.nextSibling!;
  assert.equal(stray.textContent, 'B');
  table.before(stray);
  assert.equal(f.stored(f.word('B')), 'B', 'one node is still its own position');
  assert.equal(f.stored(f.word('A')), 'A');
  assert.deepEqual(f.select({ node: f.at('B').node, start: 0 }, { node: f.at('A').node, end: 1 }), { refused: 'reviewRefusedOrder' }, 'B→A steps back in the source');
  assert.deepEqual(f.select({ node: f.at('A').node, start: 0 }, { node: f.at('C').node, end: 1 }), { refused: 'reviewRefusedOrder' }, 'A→C is in order, but its span holds B, which is not selected');
  // The inverse: a stored range over "A</td></tr>B" (say from the CLI) is two
  // units out of DOM order, so no highlight is claimed.
  const a = content.indexOf('A'), b = content.indexOf('B');
  assert.equal(f.shown({ range: offsetsToRange(content, a, b + 1) }), null);
  assert.equal(f.shown({ range: offsetsToRange(content, a, a + 1) }), 'A');
  // An ordinary selection across elements maps exactly, both ways.
  const n = await frame('<p>one <b>two</b> three</p><p>four</p>');
  const across = n.select({ node: n.at('one').node, start: 0 }, { node: n.at('four').node, end: 4 });
  assert.equal(n.stored(across), 'one <b>two</b> three</p><p>four');
  assert.equal(n.shown(across), 'one two threefour');
});

test('a selection over a very large page is computed in bounded passes (no argument spread)', async () => {
  const f = await frame(`<p>${'x'.repeat(200_000)}</p>`);
  const p = f.at('x');
  const all = f.select({ node: p.node, start: 0 }, { node: p.node, end: 200_000 });
  assert.equal(f.stored(all).length, 200_000);
});

test('form and editable regions are generated: a selection touching one is refused; edits under the map refuse', async () => {
  const f = await frame('<p>before</p><textarea>typed text</textarea><select><option>pick</option></select><div contenteditable>edit me</div><p>after</p>');
  assert.deepEqual(f.word('typed'), { refused: 'reviewRefusedGenerated' });
  assert.deepEqual(f.word('pick'), { refused: 'reviewRefusedGenerated' });
  assert.deepEqual(f.word('edit'), { refused: 'reviewRefusedGenerated' });
  assert.equal(f.stored(f.word('after')), 'after');
  // A DOM changed under the map (an editable region grew a text node outside itself).
  f.doc.body.append(f.doc.createTextNode('injected'));
  assert.deepEqual(f.word('after'), { refused: 'reviewRefusedRendered' });
});

test('a legacy reference without its semicolon refuses, never guesses', async () => {
  const f = await frame('<p>&copy 2026 and &amp; more</p>');
  assert.equal(f.map, null, 'parse5 decodes &copy without ";"; this map does not claim that span');
  const g = await frame('<p>AT&T and R&D</p>');
  assert.ok(g.map, 'a bare ampersand that is not a reference is literal');
  assert.equal(g.stored(g.word('AT&T')), 'AT&T');
});

test('parse5 and entities have ONE entry, lazy: only review-html-map.ts names them, and only through import()', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const src = new URL('../..', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|svelte)$/u.test(name) && !/\.test\.(ts|js)$/u.test(name)) files.push(p);
    }
  };
  walk(src);
  const spec = /(?:from\s*|import\s*\(\s*|import\s+)['"](?:parse5|entities)(?:\/[^'"]*)?['"]/u;
  const naming = files.filter((p) => spec.test(readFileSync(p, 'utf8'))).map((p) => relative(src, p));
  assert.deepEqual(naming, ['lib/files/review-html-map.ts'], 'one entry module');
  const entry = readFileSync(join(src, 'lib/files/review-html-map.ts'), 'utf8');
  assert.doesNotMatch(entry, /from\s*['"](?:parse5|entities)/u, 'no static import: the chunks load on first use');
  assert.match(entry, /Promise\.all\(\[import\('parse5'\), import\('entities'\)\]\)/u);
});
