import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildIdentity, createViteConfig, devProxy } from '../vite.config.js';
import { DEV_SERVER_PORT_ENV } from './dev-ports.mjs';

test('Vite proxies WebSocket and downloads to the same internal Rust server', () => {
  const proxy = devProxy({ [DEV_SERVER_PORT_ENV]: '19099' });
  assert.deepEqual(proxy, {
    '/ws': { target: 'ws://127.0.0.1:19099', ws: true },
    '/dl': { target: 'http://127.0.0.1:19099' },
  });
});

test('production build does not parse the development backend port', () => {
  const build = createViteConfig('build', { PORT: 'not-a-port' });
  assert.equal('proxy' in build.server, false);
  assert.throws(() => createViteConfig('serve', { PORT: 'not-a-port' }), /invalid internal dev server port/);
});

test('agent worktrees inside the checkout are neither watched nor scanned (#342)', async () => {
  // Task worktrees live at <repo>/worktree/<agent>-<task>. Without these two
  // entries the dev server serving the checkout watched every worktree
  // (measured: 705 inotify watches for one fresh worktree; estimated, not
  // measured: a Rust-built one would add about the checkout's own target/,
  // 58,215 entries) and its dependency scan crawled each worktree's
  // index.html as a second app. Measured on a private Vite with a nested
  // worktree/: 304 → 0 watches there, and the scan stopped following its import.
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('../worktree', import.meta.url));
  const config = createViteConfig('serve', {});
  assert.deepEqual(config.server.watch, { ignored: [`${here}/**`] },
    'the watch ignore is ABSOLUTE and anchored at the config: a worktree’s own Vite ignores only a worktree/ nested inside it');
  assert.deepEqual(config.optimizeDeps.entries, ['**/*.html', '!worktree/**'],
    'Vite’s default entry glob, minus the worktrees — an explicit list REPLACES the default, so it must keep **/*.html');
  assert.deepEqual(config.optimizeDeps.exclude, ['@xterm/xterm'], 'the xterm source-serving rule is untouched');
  // And the build sees the same scan rule (a build never watches).
  assert.deepEqual(createViteConfig('build', {}).optimizeDeps.entries, config.optimizeDeps.entries);
});

// ── Board #368: the UI's build identity ─────────────────────────────────

test('the UI bakes version, short commit and UTC minute; no git says dev, never a failed build', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const at = new Date('2026-10-14T07:40:59.999Z');
  assert.deepEqual(buildIdentity(at, () => '46392f16\n'), { version: pkg.version, commit: '46392f16', built: '2026-10-14 07:40' });
  assert.equal(buildIdentity(at, () => { throw new Error('git: not found'); }).commit, 'dev', 'no git');
  for (const odd of ['', 'HEAD', '46392f1', '46392f16x', '46392F16', 'fatal: not a git repository']) {
    assert.equal(buildIdentity(at, () => odd).commit, 'dev', `not a short commit: ${JSON.stringify(odd)}`);
  }
});

test('the identity is a define in BOTH the dev server and the build, read through one module', () => {
  for (const command of ['serve', 'build']) {
    const { define } = createViteConfig(command, {});
    const built = JSON.parse(define.__TMM_BUILD__);
    assert.deepEqual(Object.keys(built).sort(), ['built', 'commit', 'version']);
    assert.match(built.built, /^\d{4}-\d\d-\d\d \d\d:\d\d$/u);
    assert.equal(JSON.parse(define.__TMM_LICENSE__), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).license);
  }
});
