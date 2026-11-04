// Board #517 (owner 2026-11-04: "打开是白屏什么都用不了"): the gateway's UI is
// reached through a reverse proxy that adds a path prefix (the CloudFront
// secret path, `/<prefix>/` → the gateway's `/`). A URL that starts at the
// origin root (`/assets/…`) leaves the prefix and lands on the edge's 404, a
// white screen. So nothing the UI ships names a public file from the root:
// every such URL is relative to the page, and only the page's own URL knows
// the prefix. The behaviour proofs are connection-address.test.ts (the
// socket) and agents.server.test.ts (a served icon); this pins the sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = new URL('../../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
/** A root-absolute URL of a file this UI ships (public/ or the build). */
const ROOT_ABSOLUTE = /["'`(]\/(?:assets|fonts|src)\/|["'`(]\/(?:favicon|pwa-|sw\.js|manifest\.webmanifest)/u;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return /\.(ts|js|svelte)$/u.test(name) && !/\.(test|render|source\.test|mount\.test)\.ts$|\.test-fixture\.ts$/u.test(name) ? [path] : [];
  });
}

test('index.html names every file relative to the page, and gives a bare prefix its slash first', () => {
  const html = read('index.html');
  for (const line of html.split('\n')) assert.doesNotMatch(line, ROOT_ABSOLUTE, line.trim());
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const firstScript = head.match(/<script>([\s\S]*?)<\/script>/u);
  assert.ok(firstScript && head.indexOf('<script') < head.indexOf('<link'), 'the slash redirect runs before anything loads');
});

/** Run index.html's FIRST script as a page at `href` would, and say where it
 * navigates (null: nowhere). `hosted`: the gateway's marker is in the page. */
function normalise(href: string, hosted = true): string | null {
  const script = read('index.html').match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/u)![1]!;
  let went: string | null = null;
  runInNewContext(script, {
    URL,
    location: { href, replace: (to: string) => { went = to; } },
    document: { querySelector: (sel: string) => (hosted && sel === 'meta[name="tmm-gateway"]' ? {} : null) },
  });
  return went;
}

// Board #517 design v2, the entry contract: "/", a prefix directory with or
// without its slash (multi-level, dotted) and an explicit index.html. Only the
// pathname changes; the origin, the query and the hash are kept.
test('a hosted page gives its prefix directory the slash, and changes nothing else', () => {
  const at = 'https://cf.example';
  for (const [path, to] of [
    ['/p', '/p/'], ['/a/b', '/a/b/'], ['/tenant.html', '/tenant.html/'], ['/p.v2', '/p.v2/'],
    ['/p?x=1#/hub', '/p/?x=1#/hub'], ['/p%20x', '/p%20x/'],
  ] as const) assert.equal(normalise(at + path), at + to, path);
  for (const path of ['/', '/p/', '/a/b/', '/p/index.html', '/index.html', '/p/?x=1#/hub'])
    assert.equal(normalise(at + path), null, `${path} is already a directory or its index`);
  // A path that LOOKS like a network-path reference never leaves the origin.
  const evil = normalise(`${at}//evil.example`);
  assert.equal(evil && new URL(evil).origin, at);
  assert.equal(evil, `${at}//evil.example/`);
});

test('only a gateway-hosted http(s) document is normalised: never dev, Tauri, a custom scheme or a file', () => {
  assert.equal(normalise('http://localhost:5173/p', false), null, 'Vite dev: no marker');
  assert.equal(normalise('http://tauri.localhost/p', false), null, 'Tauri: no marker');
  for (const href of ['tauri://localhost/p', 'file:///tmp/dist/p', 'app://x/p'])
    assert.equal(normalise(href), null, href);
});

test('the manifest scopes the app to its own directory', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as { start_url: string; scope: string; icons: { src: string }[] };
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.ok(!icon.src.startsWith('/'), icon.src);
});

test('no source names a shipped file from the origin root', () => {
  const offenders = sources(new URL('src', root).pathname).flatMap((file) =>
    readFileSync(file, 'utf8').split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*|<!--)/u.test(line) && ROOT_ABSOLUTE.test(line))
      .map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(offenders, []);
});
