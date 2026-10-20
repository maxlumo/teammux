// The shared message corpus (board #432): the other half of the Rust test in
// `src-tauri/src/projects/message_paths.rs`. Each row is a message body, what
// the BUBBLE links (`feed`, checked here against the real renderer) and what
// Files mode lists (`files`, checked there). Files is a NAMED SUBSET of the
// feed: every path it lists is one the bubble links, and every row where the
// two differ names one gap from the closed list below. Neither side may claim
// equivalence on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from './markdown.ts';
import { pathRef } from './path-links.ts';

type Row = { body: string; feed: string[]; files: string[]; gap?: string };
const rows: Row[] = JSON.parse(readFileSync(new URL('./message-paths.cases.json', import.meta.url), 'utf8'));
/** The gaps Files v1 names (hub-feed.md § search). Keep in step with GAPS in message_paths.rs. */
const GAPS = ['reference-style link', 'emphasis boundary', 'bracketed text', 'indented line', 'link title'];

/** The paths the bubble opens, in order: every anchor, read the way the click reads it. */
const linked = (body: string): string[] =>
  [...renderMarkdown(body).matchAll(/<a href="([^"]*)"/gu)].map((m) => pathRef(m[1]!.replace(/&amp;/gu, '&'))).filter(Boolean);

test('every row of the shared message corpus: what the bubble links (#432)', () => {
  assert.ok(rows.length >= 25, `the corpus was read: ${rows.length} rows`);
  for (const row of rows) assert.deepEqual(linked(row.body), row.feed, row.body);
});

test('Files is a subset of the feed, and every difference names a gap from the closed list (#432)', () => {
  for (const row of rows) {
    const unseen = [...row.feed];
    for (const path of row.files) {
      const at = unseen.indexOf(path);
      assert.notEqual(at, -1, `Files lists ${path}, which the bubble does not link: ${row.body}`);
      unseen.splice(at, 1);
    }
    const same = JSON.stringify(row.files) === JSON.stringify(row.feed);
    if (same) assert.equal(row.gap, undefined, `a gap is named but feed and files agree: ${row.body}`);
    else assert.ok(row.gap && GAPS.includes(row.gap), `feed and files differ without a named gap: ${row.body}`);
  }
});

test('the corpus covers the regions the design names (#432 review P1-B)', () => {
  const has = (re: RegExp) => assert.ok(rows.some((r) => re.test(r.body)), String(re));
  has(/^\[README\]\(README\.md\)$/u);            // an explicit link to a bare word
  has(/my%20notes\.md/u);                         // percent-encoding, explicit and bare
  has(/\[1\]: docs\/a\.md/u);                     // a reference-style link (a gap)
  has(/`\[ ?src\/a\.rs ?\]`|\[`src\/a\.rs`\]\(/u); // code inside link text
  has(/^```markdown\n/u);                          // the transparent wrapper
  has(/^````md\n/u);                                // ... with an inner fence
  has(/\?p=src\/a\.rs/u);                          // a URL with a query
  has(/^` src\/a\.rs `$/u);                        // a padded span
  has(/^``src\/a\.rs``$/u);                        // a double-backtick span
  has(/\$a\/b\.c\$/u);                             // math
});
