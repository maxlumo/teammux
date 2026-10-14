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

const pkg = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const AT = new Date('2026-10-14T07:40:59.999Z');

test('a RELEASE build bakes version, commit and UTC minute; no git says dev, never a failed build', () => {
  assert.deepEqual(buildIdentity({ env: {}, now: AT, git: () => '46392f16\n' }), { version: pkg().version, commit: '46392f16', built: '2026-10-14 07:40' });
  assert.equal(buildIdentity({ env: {}, now: AT, git: () => { throw new Error('git: not found'); } }).commit, 'dev', 'no git');
  for (const odd of ['', 'HEAD', '46392f1', '46392f16x', 'fatal: not a git repository']) {
    assert.equal(buildIdentity({ env: {}, now: AT, git: () => odd }).commit, 'dev', `not a short commit: ${JSON.stringify(odd)}`);
  }
  assert.equal(buildIdentity({ env: {}, now: AT, git: () => '46392f16a' }).commit, '46392f16a', 'git --short=8 is AT LEAST 8: a collision-lengthened one is a commit');
});

test('the source revision comes from the ENVIRONMENT first, then git, then dev; a bad value is ignored (#368 review P2-C)', () => {
  // The e2e image has no .git: SOURCE_COMMIT / SOURCE_TIME are how it knows what it was built from.
  const git = () => { throw new Error('there is no .git in the image'); };
  assert.deepEqual(buildIdentity({ env: { SOURCE_COMMIT: 'ABCDEF12 ', SOURCE_TIME: '2026-01-02 03:04' }, now: AT, git }),
    { version: pkg().version, commit: 'abcdef12', built: '2026-01-02 03:04' });
  assert.equal(buildIdentity({ env: { SOURCE_COMMIT: 'abcdef12' }, now: AT, git: () => '46392f16' }).commit, 'abcdef12', 'the environment outranks git');
  for (const bad of ['', 'dev', 'xyz', '123', 'abcdef12; rm -rf /', 'g'.repeat(10)]) {
    assert.equal(buildIdentity({ env: { SOURCE_COMMIT: bad }, now: AT, git: () => '46392f16' }).commit, '46392f16', `ignored: ${JSON.stringify(bad)}`);
  }
  assert.equal(buildIdentity({ env: { SOURCE_TIME: 'yesterday' }, now: AT, git: () => '46392f16' }).built, '2026-10-14 07:40', 'a bad time falls back to the clock');
});

test('a DEV SERVER is `dev` + the minute it started, flagged, whatever HEAD or the environment say; only `vite build` carries a commit (#368 review P1-B)', () => {
  const env = { SOURCE_COMMIT: 'abcdef12', SOURCE_TIME: '2026-01-02 03:04' };
  const served = JSON.parse(createViteConfig('serve', env, { now: AT, git: () => '46392f16' }).define.__TMM_BUILD__);
  assert.deepEqual(served, { version: pkg().version, commit: 'dev', built: '2026-10-14 07:40', devServer: true },
    'the config is read once at start: a commit frozen then would keep naming itself after HMR and main moving');
  const built = JSON.parse(createViteConfig('build', env, { now: AT, git: () => '46392f16' }).define.__TMM_BUILD__);
  assert.deepEqual(built, { version: pkg().version, commit: 'abcdef12', built: '2026-01-02 03:04' }, 'a build carries its commit and no dev flag');
  // Two builds at two commits keep their OWN fixed identities.
  const a = JSON.parse(createViteConfig('build', {}, { now: AT, git: () => 'aaaaaaaa' }).define.__TMM_BUILD__);
  const b = JSON.parse(createViteConfig('build', {}, { now: AT, git: () => 'bbbbbbbb' }).define.__TMM_BUILD__);
  assert.deepEqual([a.commit, b.commit], ['aaaaaaaa', 'bbbbbbbb']);
  assert.equal(JSON.parse(createViteConfig('serve', {}).define.__TMM_LICENSE__), pkg().license);
});
