import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileNavigation, directoryBackFloor, type FileLocation } from './file-nav.ts';

type File = { path: string; content?: string };
function location(path: string, scroll = 0): FileLocation<File, { path: string }> {
  return {
    cwd: path.replace(/\/[^/]+$/, ''), entries: [{ path }],
    view: 'preview', currentFile: { path, content: path },
    fromGit: false, scroll, frameScroll: scroll + 10,
  };
}

test('directory Back retraces visited paths, skipping empty and unchanged locations', () => {
  const nav = createFileNavigation();
  nav.rememberDirectory('', '/a');
  nav.rememberDirectory('/a', '/a');
  nav.rememberDirectory('/a', '/b');
  nav.rememberDirectory('/b', '/elsewhere');
  assert.equal(nav.popDirectory(), '/b');
  assert.equal(nav.popDirectory(), '/a');
  assert.equal(nav.popDirectory(), undefined);
});

test('the directory floor climbs only for tab visits, never a chat jump or the root', () => {
  assert.equal(directoryBackFloor('/a/b', false), '/a');
  assert.equal(directoryBackFloor('/a/', false), '/');
  assert.equal(directoryBackFloor('/a/b', true), '');
  assert.equal(directoryBackFloor('/', false), '');
  assert.equal(directoryBackFloor('', false), '');
});

test('linked preview Back restores origins in order with their exact listing and scroll state (#106)', () => {
  const nav = createFileNavigation<File, { path: string }>();
  const first = location('/a/first.md', 120);
  const second = location('/b/second.html', 240);
  const third = location('/c/third.md');
  nav.rememberFile(first);
  nav.rememberFile(second);
  assert.deepEqual(nav.backFromPreview(third), { kind: 'restore', location: second });
  const step = nav.backFromPreview(second);
  assert.equal(step.kind, 'restore');
  if (step.kind === 'restore') {
    assert.equal(step.location, first, 'restore the captured object, not live state or a reconstructed file');
    assert.equal(step.location.entries, first.entries);
    assert.equal(step.location.scroll, 120);
    assert.equal(step.location.frameScroll, 130);
  }
  assert.deepEqual(nav.backFromPreview(first), { kind: 'list', path: '/a' });
});

test('a chat file handoff can restore a listing, and a failed open adds no history', () => {
  const nav = createFileNavigation<File, { path: string }>();
  const list: FileLocation<File, { path: string }> = {
    ...location('/project/readme.md'), view: 'list', currentFile: null,
  };
  nav.rememberFile(list);
  // A failed request advances the generation but does not remember another location.
  nav.nextFile();
  assert.deepEqual(nav.backFromPreview(location('/other/file.md')), { kind: 'restore', location: list });
  assert.deepEqual(nav.backFromPreview(list), { kind: 'list', path: '/project' });
});

test('info first returns to loaded text preview without consuming its origin', () => {
  const nav = createFileNavigation<File, { path: string }>();
  const first = location('/a/first.md');
  const second = location('/b/second.md');
  nav.rememberFile(first);
  assert.deepEqual(nav.backFromInfo(second), { kind: 'preview' });
  assert.deepEqual(nav.backFromPreview(second), { kind: 'restore', location: first });
  nav.rememberFile(first);
  assert.deepEqual(nav.backFromInfo({ ...second, currentFile: { path: '/b/large.bin' } }),
    { kind: 'restore', location: first }, 'unloaded info uses the same history as a preview');
});

test('linked origins outrank Git, then Git outranks the parent listing', () => {
  const nav = createFileNavigation<File, { path: string }>();
  const source = { ...location('/repo/first.md'), fromGit: true };
  nav.rememberFile(source);
  assert.deepEqual(nav.backFromPreview(source), { kind: 'restore', location: source });
  assert.deepEqual(nav.backFromPreview(source), { kind: 'git' });
  assert.deepEqual(nav.backFromPreview({ ...source, fromGit: false }), { kind: 'list', path: '/repo' });
});

test('explicit resets and file generations preserve the existing separate lifetimes', () => {
  const nav = createFileNavigation<File, { path: string }>();
  const first = nav.nextFile();
  nav.rememberDirectory('/a', '/b');
  nav.rememberFile(location('/a/first.md'));
  nav.resetDirectories();
  assert.equal(nav.popDirectory(), undefined);
  assert.equal(nav.backFromPreview(location('/b/next.md')).kind, 'restore', 'directory reset alone does not reset file history');
  nav.rememberFile(location('/a/first.md'));
  nav.resetFiles();
  assert.equal(nav.isCurrentFile(first), true, 'clearing history alone does not invalidate a request');
  const second = nav.nextFile();
  assert.equal(nav.isCurrentFile(first), false);
  assert.equal(nav.isCurrentFile(second), true);
  assert.equal(nav.backFromPreview(location('/b/next.md')).kind, 'list');
});

test('two Files instances never share histories or request generations', () => {
  const first = createFileNavigation();
  const second = createFileNavigation();
  first.rememberDirectory('/a', '/b');
  first.nextFile();
  first.nextFile();
  assert.equal(second.popDirectory(), undefined);
  assert.equal(second.nextFile(), 1);
});

test('Forward retraces a Back, and a new navigation clears it (board #187)', () => {
  // Owner 2026-09-12: "文件夹浏览的能不能加一个类似浏览器后退前进的按钮，方便我跳转
  // 位置后快速回来" — the browser model: Back pushes where you WERE onto a
  // forward stack; Forward pops it (and the place you leave becomes Back
  // again); any fresh navigation throws the forward stack away.
  const nav = createFileNavigation();
  assert.equal(nav.canGoBack(), false);
  assert.equal(nav.canGoForward(), false);
  nav.rememberDirectory('/a', '/b');
  nav.rememberDirectory('/b', '/c');
  assert.equal(nav.canGoBack(), true);
  assert.equal(nav.canGoForward(), false);
  assert.equal(nav.popDirectory('/c'), '/b', 'back from /c lands on /b');
  assert.equal(nav.canGoForward(), true);
  assert.equal(nav.forwardDirectory('/b'), '/c', 'forward returns to /c');
  assert.equal(nav.canGoForward(), false);
  assert.equal(nav.popDirectory('/c'), '/b', 'and /c is a Back step again');
  assert.equal(nav.popDirectory('/b'), '/a');
  assert.equal(nav.canGoBack(), false);
  assert.equal(nav.forwardDirectory('/a'), '/b');
  // A fresh navigation from the middle of the history discards forward.
  nav.rememberDirectory('/b', '/x');
  assert.equal(nav.canGoForward(), false);
  assert.equal(nav.forwardDirectory('/x'), undefined);
  assert.equal(nav.popDirectory('/x'), '/b');
  // Resets clear both directions (a session switch is a new entry point).
  nav.resetDirectories();
  assert.equal(nav.canGoBack(), false);
  assert.equal(nav.canGoForward(), false);
});

test('a directory link is a real Back step that returns to its preview, in order (#431 review P1)', () => {
  const nav = createFileNavigation<File>();
  const at = (path: string): FileLocation<File> => ({ cwd: '/a', entries: [], view: 'preview', currentFile: { path }, fromGit: false, scroll: 0, frameScroll: 0 });
  nav.rememberLink(at('/a/A.md'));
  assert.equal(nav.canGoBack(), true, 'even a link to the directory already listed is a step');
  nav.rememberDirectory('/x', '/x/sub');
  nav.rememberLink(at('/x/sub/B.md'));
  const steps = [nav.popDirectory('/y'), nav.popDirectory('/x/sub'), nav.popDirectory('/x'), nav.popDirectory('/a')];
  assert.deepEqual(steps.map((s) => (typeof s === 'string' ? s : s?.location.currentFile?.path)),
    ['/x/sub/B.md', '/x', '/a/A.md', undefined], 'preview -> dir -> dir -> preview -> dir unwinds in order, each once');
  assert.equal(nav.canGoForward(), true, 'the directory step left a Forward');
  assert.equal(nav.forwardDirectory('/a'), '/x/sub', 'and only the directory: a preview is not re-entered by Forward');
  assert.equal(nav.forwardDirectory('/x/sub'), undefined);
});

test('a link entry keeps its preview\'s linked-file history through browsing in the listing (#431 review P1 residual)', () => {
  const nav = createFileNavigation<File>();
  const at = (path: string): FileLocation<File> => ({ cwd: '/a', entries: [], view: 'preview', currentFile: { path }, fromGit: false, scroll: 0, frameScroll: 0 });
  nav.rememberFile(at('/a/A.md')); // B was opened as a link from A
  nav.rememberLink(at('/a/B.md')); // B links a directory
  nav.resetFiles(); // browsing in that directory: a plain file open or a subdirectory clears the file history
  const step = nav.popDirectory('/x');
  assert.equal(typeof step === 'string' ? step : step?.location.currentFile?.path, '/a/B.md');
  const next = nav.backFromPreview({ cwd: '/a', currentFile: { path: '/a/B.md' }, fromGit: false });
  assert.equal(next.kind === 'restore' ? next.location.currentFile?.path : next.kind, '/a/A.md', 'B\'s Back reaches A again');
});
