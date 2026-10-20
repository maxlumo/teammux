import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { readFileSync } from 'node:fs';
import { encodeHref, safeLinkTarget } from './markedSafeUrl.ts'; // side-effect: registers the extension
import { findPaths } from './path-grammar.ts';
import { pathRef } from './path-links.ts';

test('bare URLs stop at CJK / fullwidth characters', () => {
  const html = marked.parse('见 https://host/admin（密码：xyz）') as string;
  assert.match(html, /<a href="https:\/\/host\/admin">https:\/\/host\/admin<\/a>/);
  assert.doesNotMatch(html, /href="[^"]*密码/);
});

test('trailing sentence punctuation is dropped from the link', () => {
  const html = marked.parse('see https://example.com/path.') as string;
  assert.match(html, /<a href="https:\/\/example\.com\/path">/);
});

test('a quote inside a bare URL is percent-encoded, never an attribute break', () => {
  const html = marked.parse('see https://a.b/x"onclick="alert(1) now') as string;
  assert.ok(!/<a[^>]*\bonclick=/u.test(html), html);
  assert.match(html, /<a href="https:\/\/a\.b\/x%22onclick=%22alert\(1\)">/u);
});

test('safeLinkTarget reads the scheme the way a browser reads an attribute', () => {
  for (const ok of ['https://x.y', 'http://x.y/a?b=1&c=2', 'mailto:a@b.c', 'docs/x.md', '#top', '/abs', '']) {
    assert.ok(safeLinkTarget(ok), `link ${JSON.stringify(ok)}`);
  }
  for (const bad of [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'java\nscript:alert(1)', 'javascript&#58;alert(1)', 'javascript&#x3A;alert(1)', 'javascript&colon;alert(1)',
    'vbscript:x', 'data:text/html,hi', 'file:///etc/passwd', 'C:\\Users', null, undefined,
  ]) {
    assert.ok(!safeLinkTarget(bad as any), `link ${JSON.stringify(bad)}`);
  }
  // An image may not even be mailto: — it is a reference to bytes elsewhere.
  assert.ok(safeLinkTarget('https://x.y/p.png', 'image'));
  assert.ok(safeLinkTarget('shots/p.png', 'image'));
  assert.ok(!safeLinkTarget('mailto:a@b.c', 'image'));
  assert.ok(!safeLinkTarget('data:image/png;base64,AAAA', 'image'));
});

test('a disallowed link renders its text; a disallowed image renders its alt', () => {
  assert.equal((marked.parse('[click **here**](javascript:alert(1))') as string).trim(), '<p>click <strong>here</strong></p>');
  assert.equal((marked.parse('![a <b> & c](data:x)') as string).trim(), '<p>a &lt;b&gt; &amp; c</p>');
  // The default renderer still handles allowed targets, title included.
  assert.match(marked.parse('[t](https://x.y "hint")') as string, /<a href="https:\/\/x\.y" title="hint">t<\/a>/u);
});

test('ordinary ASCII URLs are linked whole', () => {
  const html = marked.parse('https://example.com/a?b=1&c=2#frag') as string;
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&(amp;)?c=2#frag">/);
});

// Board #431 review P1-A: a bare path is not an encoded URL. Its href must
// click back to exactly the path the grammar matched.
test('a bare path round-trips: pathRef(encodeHref(raw, path)) is the matched path, on every table row', () => {
  const rows: { input: string }[] = JSON.parse(readFileSync(new URL('./path-grammar.cases.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const { input } of rows) {
    for (const hit of findPaths(input)) {
      const href = encodeHref(hit.raw, 'path');
      assert.ok(href !== null, hit.raw);
      assert.equal(pathRef(href), hit.path, `${hit.raw} -> ${href}`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `every match was checked: ${checked}`);
  for (const raw of ['/tmp/a%20b.md', '/tmp/a%2Fb.md', '/tmp/a%23b.md', '/tmp/100%.md']) {
    assert.equal(pathRef(encodeHref(raw, 'path')), raw, `a literal % stays literal: ${raw}`);
  }
  // Why the kinds differ: with the URL kind's undo, a %xx in a file name
  // would click to another file (%20 -> space, %2F -> a slash, %23 -> '#').
  for (const raw of ['/tmp/a%20b.md', '/tmp/a%2Fb.md', '/tmp/a%23b.md']) {
    assert.notEqual(pathRef(encodeHref(raw, 'url')), raw, `the URL kind would change it: ${raw}`);
  }
  assert.equal(encodeHref('https://x/a%20b', 'url'), 'https://x/a%20b', 'URLs keep today\'s encoding');
});
