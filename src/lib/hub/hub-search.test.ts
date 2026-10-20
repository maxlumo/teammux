// The search box's pure part (board #432): what a query is and what a row shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { excerptOf, fileKey, highlight, lineSuffix, mergeFiles, newestFirst, normalizeQuery, pathParts, searchTerms, splitPath, type FileHit } from './hub-search.ts';

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

const file = (path: string, room: string, count: number, over: Partial<FileHit> = {}): FileHit => ({ path, line: null, col: null, room, id: `${room}-${path}`, seq: 1, ts: 1, from: 'kiro', count, source: null, ...over });

test('a file is one row by its path when absolute, by (room, path) when relative (#432 Files mode)', () => {
  assert.equal(fileKey(file('/srv/a.md', 'r1', 1)), fileKey(file('/srv/a.md', 'r2', 1)), 'an absolute path is the same file wherever it was named');
  assert.equal(fileKey(file('~/a.md', 'r1', 1)), fileKey(file('~/a.md', 'r2', 1)));
  assert.notEqual(fileKey(file('src/a.rs', 'r1', 1)), fileKey(file('src/a.rs', 'r2', 1)), 'a relative path is its room’s');
  assert.equal(fileKey(file('src/a.rs', 'r1', 1)), fileKey(file('src/a.rs', 'r1', 5)));
});

test('an older page only adds counts to rows already listed and appends the new ones; nothing is mutated', () => {
  const first = [file('/a.md', 'r1', 2, { ts: 9 }), file('x.rs', 'r1', 1, { ts: 8 })];
  const page = [file('/a.md', 'r2', 3, { ts: 5 }), file('x.rs', 'r2', 1, { ts: 4 }), file('x.rs', 'r1', 4, { ts: 3 })];
  const merged = mergeFiles(first, page);
  assert.deepEqual(merged.map((f) => [f.path, f.room, f.count, f.ts]), [['/a.md', 'r1', 5, 9], ['x.rs', 'r1', 5, 8], ['x.rs', 'r2', 1, 4]], 'the first sighting is the newest and names the row');
  assert.deepEqual(first.map((f) => f.count), [2, 1], 'the rows so far are not changed in place');
  assert.deepEqual(page.map((f) => f.count), [3, 1, 4]);
  assert.deepEqual(mergeFiles([], page).map((f) => f.path), ['/a.md', 'x.rs', 'x.rs']);
});

test('a path is cut into folder and name, and a line suffix is only written when there is a line', () => {
  assert.deepEqual(splitPath('docs/spec/a.md'), { dir: 'docs/spec/', name: 'a.md' });
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' });
  assert.deepEqual(splitPath('/etc/'), { dir: '/etc/', name: '' });
  assert.equal(lineSuffix({ line: null, col: null }), '');
  assert.equal(lineSuffix({ line: 12, col: null }), ':12');
  assert.equal(lineSuffix({ line: 12, col: 3 }), ':12:3');
});

test('a term is marked in the folder and the name, and one that runs across the slash marks both sides', () => {
  const p = pathParts('docs/spec/Main.md', ['spec', 'main']);
  assert.deepEqual([p.dir.map((s) => s.text).join(''), p.name.map((s) => s.text).join('')], ['docs/spec/', 'Main.md']);
  assert.deepEqual(marked(p.dir), ['spec'], 'folder');
  assert.deepEqual(marked(p.name), ['Main'], 'name, ASCII-case-insensitive like the server');
  const across = pathParts('src/main.rs', ['c/ma']);
  assert.deepEqual([marked(across.dir), marked(across.name)], [['c/'], ['ma']]);
  const none = pathParts('a/b.md', []);
  assert.deepEqual([text(none.dir), text(none.name), marked(none.dir).length + marked(none.name).length], ['a/', 'b.md', 0]);
  assert.deepEqual(pathParts('b.md', ['b']).dir, [], 'no folder');
});
