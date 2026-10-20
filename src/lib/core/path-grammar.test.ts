import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codeSpanPath, findPaths, firstPathAt, matchPath, STOP, type PathMatch } from './path-grammar.ts';

// The shared case table (board #431): this test and the Rust twin (#432) run
// the same rows, so the two implementations cannot drift. No case lives only
// here; a new grammar case is a new row.
type Row = { input: string; paths: PathMatch[]; code?: PathMatch | null };
const rows: Row[] = JSON.parse(readFileSync(new URL('./path-grammar.cases.json', import.meta.url), 'utf8'));

test('every row of the shared case table: the paths, in order (#431)', () => {
  assert.ok(rows.length >= 50, `the table was read: ${rows.length} rows`);
  for (const { input, paths } of rows) {
    const got = findPaths(input).map(({ raw, path, line, col }) => {
      const out: PathMatch = { raw, path };
      if (line !== undefined) out.line = line;
      if (col !== undefined) out.col = col;
      return out;
    });
    assert.deepEqual(got, paths, input);
  }
});

test('a row\'s code field is what a code span holding exactly the input links (#443)', () => {
  const coded = rows.filter((r) => 'code' in r);
  assert.ok(coded.some((r) => r.code === null) && coded.some((r) => r.code && r.paths.length === 0), 'both kinds of row are present');
  for (const { input, code } of coded) assert.deepEqual(codeSpanPath(input), code, input);
});

test('the offsets name the matched text, and firstPathAt agrees with findPaths', () => {
  for (const { input } of rows) {
    const found = findPaths(input);
    for (const hit of found) assert.equal(input.slice(hit.start, hit.end), hit.raw, input);
    assert.equal(firstPathAt(input), found[0]?.start ?? -1, input);
  }
});

test('matchPath reads its left neighbour: a path never starts after a letter, digit, slash, dot, colon or @', () => {
  for (const prev of ['', ' ', '\n', '(', '"', "'", '=', ',', '见', '：']) {
    assert.equal(matchPath('src/a.rs', prev)?.path, 'src/a.rs', `after ${JSON.stringify(prev)}`);
  }
  for (const prev of ['a', '7', '/', '.', ':', '@', '_', '-', '*']) {
    assert.equal(matchPath('src/a.rs', prev), null, `after ${JSON.stringify(prev)}`);
  }
});

test('STOP is the CJK and fullwidth set the URL autolinker stops at', () => {
  for (const c of ['见', '。', '（', 'ア', '한', '：']) assert.ok(STOP.test(c), c);
  for (const c of ['a', '/', '.', 'é', ' ']) assert.ok(!STOP.test(c), c);
});
