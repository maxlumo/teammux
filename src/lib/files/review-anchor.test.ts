// Board #434: the code-selection table and the coordinate helpers (delta
// 1-3). Code rows map directly. The markdown mapper, which works on the DOM,
// is pinned in review-map.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeRange, markdownRange, offsetsToRange, rangeToOffsets, reviewLines, toScalarCol, toUtf16 } from './review-anchor.ts';

const range = (line: number, col: number, end_line: number, end_col: number) => ({ range: { line, col, end_line, end_col } });

test('columns are scalars; the LINE model is the Rust one', () => {
  assert.equal(toScalarCol('a 👍🏽 b', 2), 3);
  assert.equal(toScalarCol('a 👍🏽 b', 6), 5, 'the thumb and its skin tone are two scalars, four UTF-16 units');
  assert.equal(toUtf16('a 👍🏽 b', 5), 6);
  assert.equal(toScalarCol('中文注释', 2), 3);
  assert.deepEqual(reviewLines('x\r\ny\na\rb'), ['x', 'y', 'a\rb'], 'CRLF and LF end a line; a lone CR is a character');
});

test('the LINE model is one rule: review.rs shared rows, read here', async () => {
  const { readFileSync } = await import('node:fs');
  const rust = readFileSync(new URL('../../../src-tauri/src/projects/review.rs', import.meta.url), 'utf8');
  const table = rust.slice(rust.indexOf('let shared: &[(&str, usize, usize)]'), rust.indexOf('for (text, lines, last) in shared'));
  const rows = [...table.matchAll(/^\s*\(("(?:[^"\\]|\\.)*"), (\d+), (\d+)\),$/gmu)];
  assert.ok(rows.length >= 6, `the shared rows were found: ${rows.length}`);
  for (const [, lit, lines, last] of rows) {
    const text = JSON.parse(lit!) as string;
    const got = reviewLines(text);
    assert.deepEqual([got.length, [...got[got.length - 1]!].length], [Number(lines), Number(last)], JSON.stringify(text));
  }
});

test('a code selection maps by its rows, with no search', () => {
  const lines = reviewLines('fn main() {\r\n  let 👍🏽 = 1;\r\n}\r\n');
  assert.deepEqual(codeRange(lines, { row: 1, offset: 6 }, { row: 1, offset: 10 }), range(2, 7, 2, 9), 'emoji columns');
  assert.deepEqual(codeRange(lines, { row: 0, offset: 3 }, { row: 1, offset: 5 }), range(1, 4, 2, 6), 'multi-line');
  assert.deepEqual(codeRange(lines, { row: 0, offset: 3 }, { row: 0, offset: 12 }), range(1, 4, 1, 12), 'the CR of a CRLF row clamps to the line end');
  assert.ok('refused' in codeRange(lines, { row: 9, offset: 0 }, { row: 9, offset: 1 }), 'outside the file');
  assert.ok('refused' in codeRange(['a   b'], { row: 0, offset: 1 }, { row: 0, offset: 4 }), 'whitespace only');
  assert.ok('refused' in codeRange(['abc'], { row: 0, offset: 2 }, { row: 0, offset: 2 }), 'nothing selected');
});

test('offsets and wire coordinates convert both ways in the LINE model', () => {
  const src = 'a 👍🏽 b\n中文注释';
  assert.deepEqual(offsetsToRange(src, 2, 6), { line: 1, col: 3, end_line: 1, end_col: 5 });
  assert.deepEqual(rangeToOffsets(src, { line: 2, col: 3, end_line: 2, end_col: 5 }), [11, 13]);
  assert.equal(rangeToOffsets(src, { line: 3, col: 1, end_line: 3, end_col: 2 }), null, 'past the end');
  assert.equal(rangeToOffsets(src, { line: 1, col: 3, end_line: 1, end_col: 3 }), null, 'empty');
});

test('a markdown selection is its units: blank and generated are refused, nothing is searched', () => {
  assert.deepEqual(markdownRange('ab cd', [{ from: 3, to: 4, gen: false }, { from: 4, to: 5, gen: false }]), range(1, 4, 1, 6));
  assert.deepEqual(markdownRange('x', []), { refused: 'reviewRefusedBlank' });
  assert.deepEqual(markdownRange('x $y$', [{ from: 0, to: 1, gen: false }, { from: 2, to: 5, gen: true }]), { refused: 'reviewRefusedGenerated' });
});
