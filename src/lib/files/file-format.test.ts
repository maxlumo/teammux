// Board #144's extraction: Files' entry formatters, moved unchanged; a literal table.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as any).$state = (v: unknown) => v;
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
(globalThis as any).document = { documentElement: { lang: 'en' } };
const { entryInfo, entryKind, fileIcon, formatDate, formatSize } = await import('./file-format.ts');

test('sizes, dates, kinds, info lines and icons (en)', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 1048576, 5 * 1073741824].map(formatSize), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB', '5.0 GB']);
  assert.equal(formatDate(0), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate(1800000000), new Date(1800000000 * 1000).toLocaleString());
  assert.equal(entryKind({ name: 'a', type: 'file', size: 1 }), 'file');
  assert.equal(entryKind({ name: 'd', type: 'dir', size: 0 }), 'folder');
  assert.equal(entryKind({ name: 'b', type: 'broken', size: 0 }), 'broken link');
  assert.equal(entryKind({ name: 'l', type: 'file', size: 1, is_symlink: true, link_target: '/t' }), 'symlink → /t');
  assert.deepEqual(entryInfo({ name: 'a.txt', type: 'file', size: 2048, modified: 0 }), { title: 'a.txt', lines: [{ label: 'Type', value: 'file' }, { label: 'Size', value: '2.0 KB' }] });
  assert.deepEqual(entryInfo({ name: 'd', type: 'dir', size: 0 }).lines.map((l) => l.label), ['Type'], 'a folder has no size line');
  assert.deepEqual([fileIcon({ type: 'dir' }), fileIcon({ type: 'file' }), fileIcon({ type: 'broken' })], ['folder', 'file', 'file']);
});
