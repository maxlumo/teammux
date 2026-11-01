import test from 'node:test';
import assert from 'node:assert/strict';
import { entryToolActions, visibleToolCount } from './file-tools.ts';

test('toolbar overflow is measured and reserves a slot only when necessary (#164)', () => {
  assert.equal(visibleToolCount(9, 378, 44, 2), 7);
  assert.equal(visibleToolCount(9, 348, 44, 2), 6);
  assert.equal(visibleToolCount(9, 284, 28, 4), 9, 'exact fit has no More button');
  assert.equal(visibleToolCount(9, 283, 28, 4), 7, 'one pixel short needs a More slot');
  assert.equal(visibleToolCount(3, 1000, 44, 2), 3);
  assert.equal(visibleToolCount(9, 44, 44, 2), 0, 'a tiny toolbar retains the More target');
  assert.equal(visibleToolCount(9, 0, 44, 2), 9, 'unmeasured/SSR keeps all named actions');
});

test('entry menus and inline tools share callbacks and the captured entry (#164)', () => {
  const calls: unknown[] = [];
  const entry = { path: '/a/notes.md', name: 'notes.md', type: 'file' };
  const actions = entryToolActions(entry, key => key, {
    open: target => calls.push(['open', target.path]), copy: path => calls.push(['copy', path]),
    download: path => calls.push(['download', path]), rename: target => calls.push(['rename', target.name]),
    remove: path => calls.push(['remove', path]),
    bookmarked: () => false, bookmark: path => calls.push(['bookmark', path]),
  });
  assert.deepEqual(actions.map(a => a.key), ['open', 'copyName', 'copy', 'bookmark', 'download', 'rename', 'delete']);
  assert.deepEqual(actions.filter(a => a.inline).map(a => a.key), ['download', 'rename', 'delete']);
  entry.path = '/different'; entry.name = 'different';
  for (const action of actions) action.run();
  assert.deepEqual(calls, [
    ['open', '/a/notes.md'], ['copy', 'notes.md'], ['copy', '/a/notes.md'], ['bookmark', '/a/notes.md'], ['download', '/a/notes.md'],
    ['rename', 'notes.md'], ['remove', '/a/notes.md'],
  ]);
  assert.equal(actions.at(-1)?.danger, true, 'destruction is last, with its semantic tone');
});

test('folders and broken links do not offer file download (#164)', () => {
  const handlers = { open() {}, copy() {}, download() {}, rename() {}, remove() {}, bookmarked: () => false, bookmark() {} };
  for (const type of ['dir', 'broken']) {
    const actions = entryToolActions({ path: '/x', name: 'x', type }, key => key, handlers);
    assert.deepEqual(actions.filter(a => a.inline).map(a => a.key), ['rename', 'delete']);
    assert.equal(actions[0]?.disabled, type === 'broken');
  }
});

test('a thing with a path offers its NAME and its full PATH to copy (board #191)', () => {
  // Owner 2026-09-12: "复制文件路径最好是可以…我可以复制文件名或者整个完整的路径".
  const copied: string[] = [];
  const t = (key: string) => key;
  const actions = entryToolActions({ name: 'readme.md', path: '/srv/docs/readme.md', type: 'file' }, t, {
    open() {}, copy: (text) => copied.push(text), download() {}, rename() {}, remove() {}, bookmarked: () => false, bookmark() {},
  });
  const keys = actions.map(a => a.key);
  assert.deepEqual(keys.slice(0, 3), ['open', 'copyName', 'copy'], 'name before path, both beside open');
  actions.find(a => a.key === 'copyName')!.run();
  actions.find(a => a.key === 'copy')!.run();
  assert.deepEqual(copied, ['readme.md', '/srv/docs/readme.md']);
  assert.equal(actions.find(a => a.key === 'copyName')!.label, 'filesCopyName');
  assert.ok(!actions.find(a => a.key === 'copyName')!.inline, 'a menu action, not a row tool');
});

test('a file or a folder offers one bookmark toggle in its menu; a broken link does not (#494)', () => {
  // Owner 2026-11-01: "单个文件我应该也可以收藏，同时展示在我的收藏列表里面".
  const marked = new Set(['/a/kept.md']);
  const toggled: string[] = [];
  const handlers = { open() {}, copy() {}, download() {}, rename() {}, remove() {},
    bookmarked: (path: string) => marked.has(path), bookmark: (path: string) => toggled.push(path) };
  for (const [path, type, on] of [['/a/kept.md', 'file', true], ['/a/new.md', 'file', false], ['/a/dir', 'dir', false]] as const) {
    const action = entryToolActions({ path, name: path.split('/').pop()!, type }, key => key, handlers).find(a => a.key === 'bookmark');
    assert.ok(action, `${type} ${path} offers a bookmark`);
    assert.equal(action.label, 'filesBookmarkEntry');
    assert.equal(action.pressed, on, 'the toggle shows whether it is bookmarked');
    assert.equal(action.icon, on ? 'star-filled' : 'star', 'the star, the toolbar s own glyph');
    assert.ok(!action.inline, 'a menu action, not a row tool');
    action.run();
  }
  assert.deepEqual(toggled, ['/a/kept.md', '/a/new.md', '/a/dir']);
  assert.equal(entryToolActions({ path: '/x', name: 'x', type: 'broken' }, key => key, handlers).find(a => a.key === 'bookmark'), undefined);
});
