// The search box's pure part (board #432): what a query is and what a row shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { excerptOf, highlight, newestFirst, normalizeQuery, searchTerms } from './hub-search.ts';

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('');
const marked = (segs: { text: string; mark: boolean }[]) => segs.filter((s) => s.mark).map((s) => s.text);

test('a query is its whitespace-separated terms, blanks gone', () => {
  assert.deepEqual(searchTerms('  deploy   staging\t build\n'), ['deploy', 'staging', 'build']);
  assert.deepEqual(searchTerms('   '), []);
  assert.deepEqual(searchTerms(''), []);
  assert.equal(normalizeQuery('  deploy   staging '), 'deploy staging', 'two spellings of one query are one request');
});

test('a mark follows the server’s match: ASCII case-insensitive, any term, merged where they touch', () => {
  assert.deepEqual(marked(highlight('Deploy the STAGING build', ['deploy', 'staging'])), ['Deploy', 'STAGING']);
  assert.equal(text(highlight('Deploy the STAGING build', ['deploy'])), 'Deploy the STAGING build', 'the text is never altered');
  assert.deepEqual(marked(highlight('redeployed', ['dep', 'deploy'])), ['deploy'], 'overlapping terms are one mark');
  assert.deepEqual(marked(highlight('abcabc', ['ab'])), ['ab', 'ab'], 'every occurrence');
  assert.deepEqual(highlight('plain', []), [{ text: 'plain', mark: false }], 'no terms, no marks');
  assert.deepEqual(highlight('', ['x']), [{ text: '', mark: false }]);
});

test('a non-ASCII letter is not folded: the server’s lower() is ASCII-only, so the mark must not claim a hit it did not make', () => {
  assert.deepEqual(marked(highlight('ÉCOLE école', ['école'])), ['école'], 'É is not é');
  // A character whose full lower-casing is longer must not shift the indexes of what follows.
  const segs = highlight('İstanbul needle', ['needle']);
  assert.equal(text(segs), 'İstanbul needle');
  assert.deepEqual(marked(segs), ['needle']);
});

test('markup in a message is only ever text in a segment', () => {
  const segs = highlight('<img src=x onerror=1> & <b>bold</b>', ['bold']);
  assert.equal(text(segs), '<img src=x onerror=1> & <b>bold</b>');
  assert.deepEqual(marked(segs), ['bold']);
});

test('the excerpt is a window around the first match, flattened, with … where it cut', () => {
  const body = 'line one\n\nline two ' + 'x'.repeat(120) + ' the needle sits here ' + 'y'.repeat(120);
  const segs = excerptOf(body, ['needle'], 60, 20);
  assert.ok(!text(segs).includes('\n'), 'newlines are flattened');
  assert.ok(text(segs).startsWith('…') && text(segs).endsWith('…'), 'cut on both sides');
  assert.deepEqual(marked(segs), ['needle']);
  assert.ok(text(segs).replace(/…/gu, '').length <= 60, 'at most max characters of the message');
  const short = excerptOf('short needle', ['needle'], 60, 20);
  assert.equal(text(short), 'short needle', 'a short body is whole, with no …');
});

test('a match near the end still fills the window; a sender-only match starts from the beginning', () => {
  const body = 'a'.repeat(200) + ' needle';
  const segs = excerptOf(body, ['needle'], 50, 10);
  assert.ok(text(segs).replace(/…/gu, '').length === 50, 'the window is pulled back to a full one');
  assert.deepEqual(marked(segs), ['needle']);
  const bySender = excerptOf('z'.repeat(200), ['kiro'], 40, 10);
  assert.deepEqual(marked(bySender), [], 'the body has no match');
  assert.ok(text(bySender).startsWith('z') && text(bySender).endsWith('…'));
});

test('the list is newest first, and the server’s array is not mutated', () => {
  const server = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(newestFirst(server).map((h) => h.id), ['c', 'b', 'a']);
  assert.deepEqual(server.map((h) => h.id), ['a', 'b', 'c']);
});
