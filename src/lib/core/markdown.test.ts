import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';
import { pathRef } from './path-links.ts';

test('a single tilde is text, not strikethrough', () => {
  // The bug: a weather reply full of ranges (`26~32℃`) came back with several
  // lines struck through, because GFM opens <del> at one tilde and closes it at
  // the next — across a `breaks: true` newline.
  const body = '• 8月17日：阴，26~32℃，东风微风\n• 8月18日：小雨，26~32℃，东南风微风';
  const html = renderMarkdown(body);
  assert.ok(!html.includes('<del>'), `no strikethrough, got: ${html}`);
  assert.ok(html.includes('26~32℃'), 'the range survives as written');
});

test('double tildes still strike text out, on one line only', () => {
  assert.match(renderMarkdown('~~gone~~ kept'), /<del>gone<\/del>/);
  // Inline markdown inside still renders.
  assert.match(renderMarkdown('~~**bold gone**~~'), /<del><strong>bold gone<\/strong><\/del>/);
  // Spanning a newline would be how the damage spread; it must not.
  assert.ok(!renderMarkdown('~~open\nclose~~').includes('<del>'));
});

test('blockquotes render — escaping `>` up front used to kill them', () => {
  const html = renderMarkdown('> 引用一句\n> 第二行');
  assert.match(html, /<blockquote>/, `got: ${html}`);
  assert.ok(!html.includes('&gt; 引用'), 'the marker was consumed, not printed');
  // Nested markdown inside a quote still works.
  assert.match(renderMarkdown('> **重点**'), /<blockquote>[\s\S]*<strong>重点<\/strong>/);
});

test('html in agent output stays inert, markdown still renders', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
  assert.ok(!html.includes('<img'), 'raw html is escaped');
  assert.match(html, /<strong>bold<\/strong>/);
  // `<` is the only character a tag can start with, so leaving `>` alone is safe.
  const script = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!script.includes('<script'), `got: ${script}`);
  assert.match(script, /&lt;script&gt;|&lt;script>/, 'shown as text');
  // A closing angle bracket in prose is just text.
  assert.match(renderMarkdown('a > b'), /a &gt; b|a > b/);
});

test('markdown/md fences are rendered in rendered view, not shown as source', () => {
  // This is the exact shape used by proj:test seq=52: prose, a quoted tasks.md
  // file, then prose. Raw view bypasses this function and still shows the fence.
  const body = '@human tasks.md：\n\n```markdown\n# Plan\n\n- [x] done\n- [ ] next\n```\n\n完成。';
  const html = renderMarkdown(body);
  assert.match(html, /<h1>Plan<\/h1>/, `heading should render, got: ${html}`);
  assert.match(html, /<input[^>]*checked/, 'task item should render as checked');
  assert.ok(!html.includes('language-markdown'), 'markdown wrapper is transparent in rendered view');
  assert.ok(!html.includes('<pre>'), 'the quoted md is not presented as source');
});

test('only complete markdown fences unwrap; code and malformed fences stay code', () => {
  assert.match(renderMarkdown('```rust\n# not a heading\n```'), /<pre><code class="language-rust">/);
  assert.match(renderMarkdown('```markdown\n# unclosed'), /<pre><code class="language-markdown">/);
  // Four ticks can wrap a document that itself contains a normal code fence.
  const nested = renderMarkdown('````md\n# Doc\n```js\nconst x = 1\n```\n````');
  assert.match(nested, /<h1>Doc<\/h1>/);
  assert.match(nested, /<code class="language-js">/);
});

test('LaTeX renders in every dialect agents emit; money and code stay prose', () => {
  // The four delimiter families (owner, 2026-08-26: "latex公式要正确渲染").
  assert.ok(renderMarkdown('inline $v = 2t$ here').includes('class="katex"'), '$…$');
  assert.ok(renderMarkdown('$$\\int_0^1 x\\,dx$$').includes('katex-display'), '$$…$$');
  assert.ok(renderMarkdown('so \\(E = mc^2\\) holds').includes('class="katex"'), '\\(…\\)');
  assert.ok(renderMarkdown('\\[\\sum_{i=0}^n i\\]').includes('katex-display'), '\\[…\\]');
  // TeX is read RAW — `<` survives into the formula, not as `&lt;`.
  assert.ok(renderMarkdown('$a < b$').includes('class="katex"'), 'relational < inside math');
  // Pandoc guards: everyday dollars are not formulas.
  assert.ok(!renderMarkdown('costs $5, earns $10 total').includes('katex'), 'money');
  assert.ok(!renderMarkdown('US$5 vs A$7 deal$').includes('katex'), 'currency prefixes');
  // Code is holed out before math extraction.
  assert.ok(!renderMarkdown('```sh\necho $PATH $HOME\n```').includes('katex'), 'fence');
  assert.ok(!renderMarkdown('run `$x$` now').includes('katex'), 'inline code');
  // Placeholders never leak into the output.
  assert.ok(!renderMarkdown('mix `code` and $v=1$ and $$w=2$$').includes('MATH'), 'holes restored');
});

test('a quote in a bare URL cannot break out of the href attribute', () => {
  // Reproduced 2026-09-03: `&`/`<` escaping makes TEXT inert, but an href is an
  // ATTRIBUTE, and a `"` there ends it — the rest of the URL became onclick=.
  const html = renderMarkdown('see https://a.b/x"onclick="alert(1) now');
  assert.ok(!/<a[^>]*\bonclick=/u.test(html), `attribute injection: ${html}`);
  // Still a link, with the quote percent-encoded the way marked's own autolink does.
  assert.match(html, /<a href="https:\/\/a\.b\/x%22onclick=%22alert\(1\)">/u);
});

test('links and images only carry http(s), mailto or relative targets', () => {
  // marked v17 does not sanitize schemes: a javascript: link is a click away
  // from script in the app origin (the token lives in localStorage).
  const bads = [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:msgbox',
    'data:text/html,<script>alert(1)</script>', ' javascript:alert(1)',
    'java\tscript:alert(1)',
  ];
  for (const bad of bads) {
    const html = renderMarkdown(`[click](${bad})`);
    assert.ok(!/<a\b/u.test(html), `no anchor for ${JSON.stringify(bad)}: ${html}`);
    assert.ok(html.includes('click'), `the text survives for ${JSON.stringify(bad)}: ${html}`);
  }
  // Entity-encoded colons: the chat path's `&` escape already defuses them
  // (the browser decodes `&amp;#58;` ONCE, to the literal `&#58;`), and the
  // scheme guard reads them the way a browser would for any renderer that does
  // not pre-escape. Either way, what the browser sees is never `javascript:`.
  for (const bad of ['javascript&#58;alert(1)', 'javascript&#x3a;alert(1)', 'javascript&colon;alert(1)']) {
    const html = renderMarkdown(`[click](${bad})`);
    const href = /href="([^"]*)"/u.exec(html)?.[1] ?? '';
    const seen = href.replace(/&amp;/g, '&');
    assert.ok(!/^[\s\u0000-\u0020]*javascript:/iu.test(seen), `browser-visible href ${JSON.stringify(seen)} for ${JSON.stringify(bad)}`);
  }
  // An image is a reference (rule 13): bytes and scripts are not references.
  const img = renderMarkdown('![shot](data:image/png;base64,AAAA) and ![x](javascript:alert(1))');
  assert.ok(!img.includes('<img'), `no image for a non-reference: ${img}`);
  assert.ok(img.includes('shot'), 'the alt text survives');
  // Ordinary targets are untouched, including a query string with `&`.
  assert.match(renderMarkdown('[a](https://x.y/z?p=1&q=2)'), /<a href="https:\/\/x\.y\/z\?p=1&amp;q=2">a<\/a>/u);
  assert.match(renderMarkdown('[m](mailto:a@b.c)'), /<a href="mailto:a@b\.c">/u);
  assert.match(renderMarkdown('[rel](docs/x.md)'), /<a href="docs\/x\.md">/u);
  assert.match(renderMarkdown('![pic](https://x.y/p.png)'), /<img src="https:\/\/x\.y\/p\.png" alt="pic"/u);
});

test('inline code inside a dollar span is never swallowed as math', () => {
  // Reproduced 2026-09-03: code is holed out to \x00CODE0\x00 BEFORE math runs,
  // and the `$…$` body class matched across the placeholder — KaTeX got the
  // placeholder, the code never came back.
  const html = renderMarkdown('cost $5 and `code` is 3$ ok');
  assert.ok(!html.includes('CODE0'), `placeholder leaked: ${html}`);
  assert.match(html, /<code>code<\/code>/u, 'the code renders');
  assert.ok(!html.includes('katex'), 'money around code is prose');
  // The display and \( \) families hold the same line.
  assert.ok(!renderMarkdown('$$ a `b` c $$').includes('CODE0'));
  assert.ok(!renderMarkdown('\\( a `b` c \\)').includes('CODE0'));
  assert.ok(!renderMarkdown('\\[ a `b` c \\]').includes('CODE0'));
});

test('emphasis closes after CJK punctuation when CJK text follows (board 311)', () => {
  // The owner's line: the full stop sits inside the bold and the sentence goes
  // on with no space, so CommonMark's right-flanking rule refused to close it.
  const owner = renderMarkdown('@human **sdk-s3-ane 更省。**同场对比：s3-ane 比 s1-mlx 少 406 mW');
  assert.match(owner, /<strong>sdk-s3-ane 更省。<\/strong>同场对比/, `got: ${owner}`);
  assert.match(renderMarkdown('**粗体。**后面'), /<strong>粗体。<\/strong>后面/);
  assert.match(renderMarkdown('**bold。**后'), /<strong>bold。<\/strong>后/);
  assert.match(renderMarkdown('*斜体，*后'), /<em>斜体，<\/em>后/);
  assert.match(renderMarkdown('**x**后面'), /<strong>x<\/strong>后面/);
  // The mirror case: CJK before an opener that is followed by punctuation.
  assert.match(renderMarkdown('中文**「引用」**后'), /中文<strong>「引用」<\/strong>后/);
  assert.match(renderMarkdown('前文**粗体。**後'), /前文<strong>粗体。<\/strong>後/);
  assert.match(renderMarkdown('**태그。**다음'), /<strong>태그。<\/strong>다음/);
});

test('the CJK flanking rule leaves English, literals, code and math alone', () => {
  // English follows the spec: a run after `.` and before a letter does not close.
  assert.ok(renderMarkdown('**bold.**after').includes('**bold.**after'));
  assert.match(renderMarkdown('a ** b'), /a \*\* b/);
  assert.match(renderMarkdown('5 * 3 * 2'), /5 \* 3 \* 2/);
  // Underscore keeps its intraword rule (snake__case must not embolden).
  assert.ok(renderMarkdown('前__粗体。__后').includes('__粗体。__'));
  // Code spans and blocks are holed out before the rule runs.
  assert.match(renderMarkdown('`**粗体。**后`'), /<code>\*\*粗体。\*\*后<\/code>/);
  assert.match(renderMarkdown('```\n**粗体。**后\n```'), /<code>\*\*粗体。\*\*后\n<\/code>/);
  // No flanking mark survives into the output, in text or in a link target.
  const link = renderMarkdown('[看。**这](https://a.b/x。**后) **粗。**后');
  assert.ok(!/\uFFFC|%EF%BF%BC/.test(link), `got: ${link}`);
  assert.ok(!renderMarkdown('**粗体。**后面').includes('\uFFFC'));
});

test('a bold code span or formula followed by CJK text renders bold (board 311)', () => {
  // The run touches a holed-out span (`\x00`) while the rule runs, but marked
  // sees the restored backtick, which is punctuation.
  for (const [src, want] of [
    ['**运行 `npm test`**后通过', /<strong>运行 <code>npm test<\/code><\/strong>后通过/],
    ['运行**`npm test`**即可', /运行<strong><code>npm test<\/code><\/strong>即可/],
    ['**`tmm send`**命令', /<strong><code>tmm send<\/code><\/strong>命令/],
    ['公式**$x^2$**后面', /公式<strong><span class="katex">[\s\S]*<\/strong>后面/],
  ] as const) {
    const html = renderMarkdown(src);
    assert.match(html, want, `got: ${html}`);
    assert.ok(!html.includes('\uFFFC'), 'no flanking mark survives');
  }
  // Code content is byte-identical, asterisks inside it included.
  assert.match(renderMarkdown('**`a**。`**后'), /<strong><code>a\*\*。<\/code><\/strong>后/);
});

// Board #431 (owner 2026-10-20): a bare file path in a message is the same
// door a `[text](path)` link is. The grammar is core/path-grammar.ts; these are
// the RENDERER's context rules around it.
test('a bare path in prose renders the same anchor a markdown path link does (#431)', () => {
  const html = renderMarkdown('see src/lib/hub/Feed.svelte:118 and /tmp/val422/h2/.');
  assert.ok(html.includes('<a href="src/lib/hub/Feed.svelte:118">src/lib/hub/Feed.svelte:118</a>'), html);
  assert.ok(html.includes('<a href="/tmp/val422/h2/">/tmp/val422/h2/</a>.'), `the full stop is prose: ${html}`);
  assert.ok(renderMarkdown('见src/a.rs第3行').includes('见<a href="src/a.rs">src/a.rs</a>第3行'), 'CJK on both sides');
  assert.ok(renderMarkdown('**src/a.rs**').includes('<strong><a href="src/a.rs">src/a.rs</a></strong>'), 'inside emphasis');
});

test('a code span is a path link only when its whole content is a path (#431)', () => {
  const html = renderMarkdown('run `src/a.rs` and `cargo test src/a.rs`');
  assert.ok(html.includes('<a href="src/a.rs"><code>src/a.rs</code></a>'), html);
  assert.ok(html.includes('<code>cargo test src/a.rs</code>') && !html.includes('cargo test <a'), `a command stays plain code: ${html}`);
  assert.ok(!renderMarkdown('` src/a.rs `').includes('<a '), 'a padded span is not a path as written');
  assert.ok(!renderMarkdown('``src/a.rs``').includes('<a '), 'a double-backtick span is marked\'s own');
});

test('a code span holding a workspace directory links it; the same words in prose do not (#443)', () => {
  const html = renderMarkdown('海选：`lab/out/through_the_floorboards_audition/` 下有 11 个候选; foo/bar/ stays prose');
  assert.ok(html.includes('<a href="lab/out/through_the_floorboards_audition/"><code>lab/out/through_the_floorboards_audition/</code></a>'), html);
  assert.ok(html.includes(' foo/bar/ stays prose'), `prose directory stays text: ${html}`);
});

test('a path inside a link, a reference link or an image never becomes a second anchor (#431 review P1-B)', () => {
  for (const [src, outer] of [
    ['[`src/a.rs`](https://example.test)', 'https://example.test'],
    ['[`src/a.rs`][ref]\n\n[ref]: https://example.test', 'https://example.test'],
    ['[src/a.rs and /tmp/x/y](https://example.test)', 'https://example.test'],
    ['[see src/a.rs](/x/y.md)', '/x/y.md'],
  ] as const) {
    const html = renderMarkdown(src);
    assert.equal(html.match(/<a /gu)?.length, 1, `one anchor: ${html}`);
    assert.ok(html.includes(`<a href="${outer}">`), `the outer href is kept: ${html}`);
  }
  const img = renderMarkdown('![`src/a.rs`](image.png)');
  assert.ok(!img.includes('<a '), `an image alt gets no path anchor: ${img}`);
});

test('fences stay code, a markdown fence is a document, and a URL wins over a path in it (#431)', () => {
  assert.ok(!renderMarkdown('```\nsrc/a.rs\n```').includes('<a '), 'a code fence is never linked');
  assert.ok(renderMarkdown('```markdown\nsee src/a.rs\n```').includes('<a href="src/a.rs">'), 'a markdown fence renders as a document, as today');
  const html = renderMarkdown('https://host/?p=src/a.rs and https://x/a.rs');
  assert.equal(html.match(/<a /gu)?.length, 2, html);
  assert.ok(!html.includes('href="src/a.rs"'), `no path inside a URL: ${html}`);
  assert.ok(renderMarkdown('a & b /tmp/x/y < c').includes('a &amp; b <a href="/tmp/x/y">/tmp/x/y</a> &lt; c'), 'the & and < escape is untouched');
});

// Validator V2/V2b/V5 on #431: the RENDERERS' own choices, not only the
// functions they call. A renderer switched to the URL kind of encodeHref, or
// one that ignored the left neighbour, passed every test above.
test('the renderers encode a bare path as a PATH: a literal % clicks back to itself (#431, validator V2/V2b)', () => {
  for (const src of ['/tmp/a%20b.md', '`/tmp/a%20b.md`']) {
    const href = /<a href="([^"]+)">/u.exec(renderMarkdown(src))?.[1];
    assert.equal(href, '/tmp/a%2520b.md', `${src}: the % is kept encoded`);
    assert.equal(pathRef(href), '/tmp/a%20b.md', `${src}: and pathRef gives back the literal name`);
  }
});

test('the prose renderer reads the left neighbour: no path starts after a colon or an @ (#431, validator V5)', () => {
  for (const src of ['host:/a/b', 'x@h:/a/b.md', 'see host:/tmp/x/y', 'user@host:/x/y']) {
    assert.ok(!renderMarkdown(src).includes('<a '), `${src}: ${renderMarkdown(src)}`);
  }
  // Where a TOKEN ends right before the path, the tokenizer must read that
  // token's last character itself; findPaths cannot see across the boundary.
  // An escaped colon and a closing emphasis are such boundaries.
  for (const src of ['x\\:/tmp/a/b', '**b**/tmp/a/b']) {
    assert.ok(!renderMarkdown(src).includes('href="/tmp/a/b"'), `${src}: ${renderMarkdown(src)}`);
  }
  assert.ok(renderMarkdown('see /tmp/x/y').includes('<a href="/tmp/x/y">'), 'the same path after a space is a link');
});
