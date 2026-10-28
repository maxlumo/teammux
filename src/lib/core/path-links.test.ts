import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathRef, resolvePathRef, handlePathLinkClick, installPathLinkHandler, pathLinkParts } from './path-links.ts';
import { findPaths } from './path-grammar.ts';
import { encodeHref } from './markedSafeUrl.ts';
import { installExternalLinkHandler } from './external-links.ts';

test('file references share one decoder across chat and previews (#99, #106)', () => {
  for (const [href, expected] of [
    ['/local/home/u/notes.md', '/local/home/u/notes.md'],
    ['temp/AGENTS.global.draft.md', 'temp/AGENTS.global.draft.md'],
    ['./docs/fonts.md', './docs/fonts.md'],
    ['~/notes.md', '~/notes.md'],
    ['src/Hub.svelte#L123', 'src/Hub.svelte'],
    ['/a/spawn.rs:587', '/a/spawn.rs'],
    ['src/hub.ts:12:5', 'src/hub.ts'],
    ['spawn.rs:587', 'spawn.rs'],
    ['temp/notes:2026.md', 'temp/notes:2026.md'],
    ['my%20notes.md#intro', 'my notes.md'],
    ['notes%broken.md', 'notes%broken.md'],
    ['https://example.com/a.md', ''], ['http://example.com', ''],
    ['mailto:a@b.c', ''], ['#heading', ''], ['//example.com/x', ''],
    ['javascript:alert(1)', ''], ['', ''],
  ] as const) assert.equal(pathRef(href), expected, href);
  assert.equal(pathRef(null), '');
  assert.equal(pathRef(undefined), '');
});

test('relative references resolve against the project or document directory, not the HTTP origin', () => {
  assert.equal(resolvePathRef('/project/docs', '../src/file.ts'), '/project/src/file.ts');
  assert.equal(resolvePathRef('/project', './docs/notes.md'), '/project/docs/notes.md');
  assert.equal(resolvePathRef('/project', '/other/notes.md'), '/other/notes.md');
  assert.equal(resolvePathRef('/project', '~/notes.md'), '~/notes.md');
});

test('primary, Cmd/Ctrl and middle activation route once; other auxiliary buttons and URLs do not', () => {
  for (const gesture of [
    { type: 'click', button: 0 }, { type: 'click', button: 0, metaKey: true },
    { type: 'click', button: 0, ctrlKey: true }, { type: 'auxclick', button: 1 },
  ]) {
    const calls: string[] = [];
    let prevented = false;
    // Partial DOM boundary: only methods used by the handler.
    const event = {
      ...gesture, get defaultPrevented() { return prevented; },
      target: { closest: () => ({ getAttribute: () => '../notes.md:5' }) },
      preventDefault() { prevented = true; calls.push('prevent'); },
      stopPropagation() { calls.push('stop'); },
    } as unknown as MouseEvent;
    assert.equal(handlePathLinkClick(event, path => calls.push(path)), true);
    assert.equal(handlePathLinkClick(event, path => calls.push(path)), false);
    assert.deepEqual(calls, ['prevent', 'stop', '../notes.md']);
  }
  for (const [href, button] of [['notes.md', 2], ['https://example.com', 1], ['#intro', 1]] as const) {
    assert.equal(handlePathLinkClick({
      type: 'auxclick', button,
      target: { closest: () => ({ getAttribute: () => href }) },
    } as unknown as MouseEvent, () => assert.fail('not a path activation')), false);
  }
});

test('capture external handler cannot open a path before its router, including iframe documents', () => {
  const root = new EventTarget();
  const calls: string[] = [];
  const disposeExternal = installExternalLinkHandler(root as unknown as Document, {
    windowRef: { open() { calls.push('external'); } } as unknown as Window,
  });
  const disposePath = installPathLinkHandler(root as unknown as Document, path => calls.push(path));
  for (const type of ['click', 'auxclick']) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      button: { value: type === 'auxclick' ? 1 : 0 },
      target: { value: { closest: () => ({
        getAttribute: () => 'notes.md',
        href: 'http://localhost:5173/notes.md',
      }) } },
    });
    root.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(calls, ['notes.md', 'notes.md']);
  disposeExternal();
  disposePath();
});

// Board #475 (owner 2026-10-28: "在工具调用栏里出现的路径，也支持直接点击预览"): a tool call's argument is
// scanned with the message body's recogniser and linked with the message body's href.
test('a tool row\u2019s argument splits into words and path links, with the body\u2019s recogniser and href (#475)', () => {
  const lines: Array<[string, string[]]> = [
    ['/local/home/cfu/work/projects/lab/out/shK2.jpg', ['/local/home/cfu/work/projects/lab/out/shK2.jpg']],
    // the command from the owner's screenshot: a directory after cd, a workspace file, and `2>/dev/null`, whose path
    // starts after a `>` (no path may start there) and so stays text; the path ends at the space before `|`
    ['cd /local/home/cfu/work/projects/lab/three && wc -l worlds/uki.js worlds/b.js 2>/dev/null | tail -1',
      ['/local/home/cfu/work/projects/lab/three', 'worlds/uki.js', 'worlds/b.js']],
    ['/local/home/cfu/work/projects/lab/out/stills/t27.00.png', ['/local/home/cfu/work/projects/lab/out/stills/t27.00.png']],
    ['src/lib/hub/Feed.svelte:118', ['src/lib/hub/Feed.svelte:118']],
    ['grep -rn foo --manifest-path=src-tauri/Cargo.toml ~/notes/a.md', ['src-tauri/Cargo.toml', '~/notes/a.md']],
    ['curl https://example.com/a/b.js?p=src/a.rs', []],
    ['echo done', []],
    ['', []],
  ];
  for (const [line, links] of lines) {
    const parts = pathLinkParts(line);
    assert.equal(parts.map((p) => p.text).join(''), line, `lossless: ${line}`);
    assert.deepEqual(parts.filter((p) => p.href).map((p) => p.text), links, line);
    assert.deepEqual(parts.filter((p) => p.href).map((p) => p.text), findPaths(line).map((h) => h.raw), 'the same paths the message body finds');
    for (const p of parts.filter((x) => x.href)) assert.equal(p.href, encodeHref(p.text, 'path'), 'the same href the body writes');
  }
});

test('a link\u2019s href goes through the room\u2019s path decoder to the path it names (#475)', () => {
  for (const [line, expected] of [
    ['read /a/my notes.md', '/a/my'], // a space ends a path (spaces are not supported, on purpose); what is before it is one
    ['/local/x/y.jpg', '/local/x/y.jpg'],
    ['src/hub.ts:12:5', 'src/hub.ts'],
    ['./docs/fonts.md', './docs/fonts.md'],
  ] as const) {
    const link = pathLinkParts(line).find((p) => p.href);
    assert.equal(link ? pathRef(link.href) : '', expected, line);
  }
});

// Board #477 (review of #475): a path may hold a LITERAL percent triplet. `/tmp/a%20b.md` is a file whose name
// has the characters %20 in it. The href is encodeHref(raw, 'path'), which writes the `%` as `%25`, so pathRef's
// ONE decode gives the literal name back. An href that skipped the encoding (the raw path) would be decoded into
// `/tmp/a b.md` or `/tmp/a/b.md`, a different file.
test('a path holding a literal %XX keeps its name through href and decoder (#477)', () => {
  for (const [line, href, expected] of [
    ['/tmp/a%20b.md', '/tmp/a%2520b.md', '/tmp/a%20b.md'],
    ['/tmp/a%2Fb.md', '/tmp/a%252Fb.md', '/tmp/a%2Fb.md'],
    ['/tmp/a%23b.md', '/tmp/a%2523b.md', '/tmp/a%23b.md'],
    ['read /tmp/a%20b.md && wc -l /tmp/a%2Fb.md', '/tmp/a%2520b.md', '/tmp/a%20b.md'],
  ] as const) {
    const link = pathLinkParts(line).find((p) => p.href);
    assert.equal(link?.href, href, `the written href: ${line}`);
    assert.equal(pathRef(link?.href), expected, `the decoded path: ${line}`);
    assert.notEqual(pathRef(link?.text), expected, 'the raw text as an href would name a DIFFERENT file');
  }
  const two = pathLinkParts('read /tmp/a%20b.md && wc -l /tmp/a%2Fb.md').filter((p) => p.href);
  assert.deepEqual(two.map((p) => pathRef(p.href)), ['/tmp/a%20b.md', '/tmp/a%2Fb.md'], 'every link on a line, not only the first');
});

// The shared case table is the list of every path shape the matcher yields: for each of them the link's href must
// decode to the path the matcher named, whatever characters it holds (percent, colon, tilde, dot segments).
test('every path in the shared case table round-trips through its link href to the matched path (#477)', () => {
  type Row = { input: string; paths: { raw: string; path: string }[] };
  const rows: Row[] = JSON.parse(readFileSync(new URL('./path-grammar.cases.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const { input, paths } of rows) {
    const links = pathLinkParts(input).filter((p) => p.href);
    assert.equal(links.length, paths.length, `one link per matched path: ${input}`);
    links.forEach((link, i) => {
      assert.equal(pathRef(link.href), paths[i]!.path, `${input} \u2192 ${link.href}`);
      checked++;
    });
  }
  assert.equal(checked, rows.reduce((n, r) => n + r.paths.length, 0), 'every matched path of the table was checked');
  assert.ok(checked > 0, 'and the table was read');
});
