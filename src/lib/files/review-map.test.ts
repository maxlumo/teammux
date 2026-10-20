// Board #434, reviewer P1-A on 5b2a004f: a selection in the rendered
// markdown maps through the renderer's own token positions (traced through
// the preprocessing) and a DOM walk checked against them, never through a
// stripper that guesses. Each row renders with the REAL renderMarkdown into
// a real DOM (jsdom), selects as a person would, and reads the range — or
// the refusal. The highlight is the same walk backwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdownSourceMap, renderMarkdown } from '../core/markdown.ts';
import { markdownHighlight, markdownSelection } from './review-ui.ts';
import { rangeToOffsets } from './review-anchor.ts';

function page(src: string) {
  const dom = new JSDOM(`<div class="md-render">${renderMarkdown(src, { spans: true })}</div>`);
  const doc = dom.window.document;
  const root = doc.querySelector<HTMLElement>('.md-render')!;
  const map = markdownSourceMap(src);
  const texts = () => {
    const w = doc.createTreeWalker(root, 4);
    const out: Text[] = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  };
  /** The `nth` occurrence of `needle` inside one text node (optionally under `within`). */
  const at = (needle: string, nth = 0, within = 'body') => {
    let k = 0;
    for (const t of texts()) {
      if (!(t.parentElement?.closest(within))) continue;
      for (let i = t.data.indexOf(needle); i >= 0; i = t.data.indexOf(needle, i + 1)) {
        if (k++ === nth) return { node: t, start: i, end: i + needle.length };
      }
    }
    throw new Error(`no ${needle} #${nth} under ${within}`);
  };
  const select = (a: { node: Node; start: number }, b: { node: Node; end: number }) => {
    const r = doc.createRange();
    r.setStart(a.node, a.start); r.setEnd(b.node, b.end);
    return markdownSelection(root, r, src, map);
  };
  const word = (needle: string, nth = 0, within = 'body') => { const p = at(needle, nth, within); return select(p, p); };
  const whole = (el: Element) => { const r = doc.createRange(); r.selectNodeContents(el); return markdownSelection(root, r, src, map); };
  const shown = (range: { line: number; col: number; end_line: number; end_col: number }) => markdownHighlight(root, range, src, map)?.toString() ?? null;
  return { doc, root, map, at, select, word, whole, shown };
}
const R = (line: number, col: number, end_line: number, end_col: number) => ({ range: { line, col, end_line, end_col } });
/** The SOURCE text a mapped selection stores (the LINE model), or its refusal. */
function cut(src: string, m: ReturnType<typeof markdownSelection>): string {
  if (!m || !('range' in m)) return `refused:${m && 'refused' in m ? m.refused : 'none'}`;
  const text = src.replace(/\r\n/g, '\n');
  const [a, b] = rangeToOffsets(src, m.range)!;
  return text.slice(a, b);
}

test('the reviewer\u2019s row: a*b in inline code is the FIRST source range, never the escaped twin', () => {
  const p = page('`a*b` a\\*b');
  assert.deepEqual(p.word('a*b', 0, 'code'), R(1, 2, 1, 5), 'inside the code span');
  assert.deepEqual(p.word('a*b', 0, 'p'), R(1, 2, 1, 5));
  // The escaped one: its range covers the backslash it shows through.
  assert.deepEqual(p.word('a*b', 1, 'p'), R(1, 7, 1, 11));
  assert.equal(p.shown({ line: 1, col: 2, end_line: 1, end_col: 5 }), 'a*b');
  assert.equal(p.shown({ line: 1, col: 7, end_line: 1, end_col: 11 }), 'a*b');
});

test('identical text twice: each selection is its own place, by position, with no context needed', () => {
  const p = page('same para here\n\nsame para here\n');
  assert.deepEqual(p.word('para', 0), R(1, 6, 1, 10));
  assert.deepEqual(p.word('para', 1), R(3, 6, 3, 10));
  const q = page('word x word');
  assert.deepEqual(q.word('word', 1), R(1, 8, 1, 12), 'a zero-context twin in one sentence is still exactly the one selected');
});

test('inline markup, links, headings, escapes and our own & and < map to the raw source', () => {
  const src = '## Title here\n\nsome **bold** and *em* text, see [the docs](http://x) & a < b, a \\*star\\*\n';
  const p = page(src);
  assert.deepEqual(p.word('Title'), R(1, 4, 1, 9));
  assert.deepEqual(p.word('bold'), R(3, 8, 3, 12));
  assert.equal(cut(src, p.word('the docs')), 'the docs');
  assert.equal(cut(src, p.word('& a < b')), '& a < b');
  assert.equal(cut(src, p.word('*star*')), '\\*star\\*', 'both escapes inside the range');
  // A selection from one element into another: bold → em.
  assert.equal(cut(src, p.select(p.at('bold'), p.at('em', 0, 'em'))), 'bold** and *em');
});

test('inline code and escapes combined, and code that looks like markup', () => {
  const src = 'run `x**y**z` then \\`not code\\` and `_a_`';
  const p = page(src);
  assert.deepEqual(p.word('x**y**z'), R(1, 6, 1, 13), 'markup inside code is the code');
  assert.equal(cut(src, p.word('not code')), 'not code');
  assert.equal(cut(src, p.select(p.at('`not'), p.at('code`'))), '\\`not code\\`', 'an escaped backtick shows through its backslash');
  assert.equal(cut(src, p.word('_a_')), '_a_');
});

test('across paragraphs and blocks: the first unit\u2019s source to the last\u2019s', () => {
  const p = page('one two\n\n- item three\n- item four\n\n> quoted five\n> six\n');
  assert.deepEqual(p.select(p.at('two'), p.at('three')), R(1, 5, 3, 13));
  assert.deepEqual(p.select(p.at('four'), p.at('six')), R(4, 8, 7, 6));
  assert.deepEqual(p.word('six'), R(7, 3, 7, 6), 'a blockquote line keeps its own place');
});

test('a KaTeX region is generated: touching it is refused, the prose beside it maps', () => {
  const p = page('mass $x^2$ here\n\n$$\na\n+b\n$$\n\nafter the formula\n');
  assert.deepEqual(p.word('mass'), R(1, 1, 1, 5));
  assert.deepEqual(p.word('here'), R(1, 12, 1, 16));
  const katex = p.root.querySelector('.katex')!;
  assert.deepEqual(p.whole(katex), { refused: 'reviewRefusedGenerated' });
  assert.deepEqual(p.select(p.at('mass'), p.at('here')), { refused: 'reviewRefusedGenerated' }, 'a selection across a formula');
  assert.deepEqual(p.word('formula'), R(8, 11, 8, 18), 'after a multi-line formula, lines are not shifted');
});

test('the transparent md wrapper, CRLF, emoji, CJK emphasis, a table, a bare path and a URL', () => {
  const wrapped = page('intro\n```md\nsame para\n\nsame para\n```\nafter');
  assert.deepEqual(wrapped.word('same para', 1), R(5, 1, 5, 10));
  assert.deepEqual(page('a\r\nb **c** d\r\n').word('c'), R(2, 5, 2, 6));
  assert.deepEqual(page('x 👍🏽 y').word('👍🏽'), R(1, 3, 1, 5));
  assert.deepEqual(page('**粗体。**后面').word('粗体'), R(1, 3, 1, 5));
  const t = page('| a | b |\n|---|---|\n| - | two |\n');
  assert.deepEqual(t.word('-', 0, 'td'), R(3, 3, 3, 4), 'a cell\u2019s dash is the cell, never the delimiter row');
  assert.deepEqual(t.word('two'), R(3, 7, 3, 10));
  const l = page('Logs in /fixture/sub/ and https://e.com/a now');
  assert.deepEqual(l.word('/fixture/sub/'), R(1, 9, 1, 22));
  assert.deepEqual(l.word('https://e.com/a'), R(1, 27, 1, 42));
});

test('fenced code shows its content; a mermaid block is generated; a nested list in a quote maps', () => {
  const p = page('```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n```\n\n> - item one\n>   - nested word\n');
  assert.deepEqual(p.word('a = 1'), R(2, 7, 2, 12));
  assert.deepEqual(p.word('graph TD'), { refused: 'reviewRefusedGenerated' });
  assert.deepEqual(p.word('nested word'), R(10, 7, 10, 18));
});

test('every block of a corpus aligns with its source map, and its highlight is its own text', () => {
  const corpus = [
    '# Title\n\npara one\n\npara two', '- a\n- b\n\n1. x\n2. y', '> quote\n> more', '| a | b |\n|---|---|\n| 1 | 2 |',
    '```js\nconst a = 1;\n```', 'inline `code` and \\(y\\) and text', '**粗体。**后面', '~~gone~~ kept', '- [ ] task\n- [x] done',
    'intro\n```md\nwrapped *md*\n```\nafter', '[x]: http://e.com\n\nuse [x]', 'a  \nb', '<script>alert(1)</script>', 'a & b < c',
    'a\r\nb\r\n\r\nc', '    indented code\n    more', '![alt](i.png) caption', 'Logs in /fixture/sub/ and [Next](next.md)',
  ];
  for (const src of corpus) {
    const p = page(src);
    assert.ok(p.map, `a map for ${JSON.stringify(src)}`);
    for (const el of [...p.root.children].filter((e) => e.hasAttribute('data-src'))) {
      if (el.querySelector('.katex, code.language-mermaid')) continue; // generated: refused by design, pinned above
      const got = p.whole(el);
      if ('refused' in got! && got.refused === 'reviewRefusedBlank') continue; // a block that shows no text (an image)
      assert.ok(got && 'range' in got, `${JSON.stringify(src)}: ${el.outerHTML} → ${JSON.stringify(got)}`);
      const text = p.shown(got.range)!;
      assert.equal(text.replace(/\s+/gu, ''), el.textContent!.replace(/\s+/gu, ''), `${JSON.stringify(src)}: the highlight is the block`);
    }
  }
});

test('a document the span render cannot prove is refused, and so is a block that does not align', () => {
  const lone = page('lone\rcr');
  assert.equal(lone.map, null);
  assert.deepEqual(lone.whole(lone.root.firstElementChild ?? lone.root), { refused: 'reviewRefusedRendered' });
  // The DOM changed under the map (text edited in place): refused, not near-matched.
  const p = page('alpha beta');
  p.root.querySelector('p')!.firstChild!.nodeValue = 'alpha betz';
  assert.deepEqual(p.word('alpha'), { refused: 'reviewRefusedRendered' });
});

test('a child is laid out in its parent\u2019s CONTENT, never found at the parent\u2019s markers (reviewer P1-A on 93c1b929)', () => {
  // The heading's body is "# **x**": its visible # is column 3, the body's,
  // never column 1, the marker — though both are "#".
  const h = page('# # **x**');
  assert.deepEqual(h.word('#', 0, 'h1'), R(1, 3, 1, 4));
  assert.deepEqual(h.word('x', 0, 'strong'), R(1, 7, 1, 8));
  // Delimiter characters that equal the content.
  assert.deepEqual(page('a ** b').word('**'), R(1, 3, 1, 5), 'a literal run of stars is text where it is');
  assert.deepEqual(page('*\\**').word('*', 0, 'em'), R(1, 2, 1, 4), 'the escaped star inside em, not em\u2019s own delimiter');
  assert.deepEqual(page('[[](u)').word('[', 0, 'p'), R(1, 1, 1, 2));
  // Closing hashes and setext headings.
  assert.deepEqual(page('## Title ##').word('Title'), R(1, 4, 1, 9));
  assert.deepEqual(page('Title\n=====').word('Title'), R(1, 1, 1, 6));
  // A blockquote with an escaped ">" and a lazy continuation line; a nested
  // quote whose second line is lazy for the inner one.
  const q = page('> a \\>\n> plain\nlazy line');
  assert.deepEqual(q.word('>', 0, 'blockquote'), R(1, 5, 1, 7), 'the escaped > is the body, never the marker');
  assert.deepEqual(q.word('lazy'), R(3, 1, 3, 5));
  assert.deepEqual(q.word('plain'), R(2, 3, 2, 8));
  const n = page('> > x\n> plain');
  assert.deepEqual(n.word('x'), R(1, 5, 1, 6));
  assert.deepEqual(n.word('plain'), R(2, 3, 2, 8));
  // List items: a marker that is also content, a continuation line, a wide marker.
  const l = page('- - x\n- a\n  b continued\n10. ten');
  assert.deepEqual(l.word('continued'), R(3, 5, 3, 14));
  assert.deepEqual(l.word('ten'), R(4, 5, 4, 8));
  assert.deepEqual(l.word('x'), R(1, 5, 1, 6), 'inside the nested item, past both markers');
});

test('a container whose content cannot be derived is refused, never placed', () => {
  // An escaped pipe: marked's cell text is not its segment between pipes.
  const t = page('| a |\n|---|\n| x \\| y |\n');
  assert.deepEqual(t.word('x', 0, 'td'), { refused: 'reviewRefusedRendered' });
  assert.deepEqual(t.word('a', 0, 'th'), { refused: 'reviewRefusedRendered' }, 'the whole table block, not a guess for its other cells');
});
