import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildIdentity, CLIENT_PATCHES, createViteConfig, devProxy, fsDeny, QUIET_RECONNECT_MEASURED_ON, quietDevReconnect, scanEntries, viteCacheDir, VITE_DEFAULT_FS_DENY, watchIgnored } from '../vite.config.js';
import { DEV_HOST_ENV, DEV_SERVER_PORT_ENV, devHost } from './dev-ports.mjs';

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

test('what is not the web app is neither watched nor scanned (#342, #393)', async () => {
  // Task worktrees live at <repo>/worktree/<agent>-<task>. Without the ignore the
  // dev server serving the checkout watched every worktree (measured: 705 inotify
  // watches for one fresh worktree) and its dependency scan crawled each
  // worktree's index.html as a second app. #393 adds the rest of what the checkout
  // holds that no browser page imports: src-tauri/ (the Android build writes
  // `.html` files under target/ and gen/android/build/, and Vite answers any
  // changed `.html` with a full page reload of every open tab), temp/, build/,
  // dist/ and .tmm/.
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const config = createViteConfig('serve', {});
  assert.deepEqual(config.server.watch, { ignored: [
    `${here}/worktree/**`, `${here}/src-tauri/**`, `${here}/temp/**`, `${here}/build/**`, `${here}/dist/**`, `${here}/.tmm/**`,
  ] }, 'the watch ignore is ABSOLUTE and anchored at the config: a worktree’s own Vite ignores only what is nested inside it');
  assert.deepEqual(config.optimizeDeps.entries, ['**/*.html', '!worktree/**', '!src-tauri/**', '!temp/**', '!build/**', '!dist/**', '!.tmm/**'],
    'Vite’s default entry glob, minus the same directories — an explicit list REPLACES the default, so it must keep **/*.html');
  assert.deepEqual(config.optimizeDeps.exclude, ['@xterm/xterm'], 'the xterm source-serving rule is untouched');
  // And the build sees the same scan rule (a build never watches).
  assert.deepEqual(createViteConfig('build', {}).optimizeDeps.entries, config.optimizeDeps.entries);
  assert.deepEqual(scanEntries(), config.optimizeDeps.entries);
  for (const web of ['src', 'public', 'scripts', 'docs']) assert.ok(!watchIgnored().some((g) => g.includes(`/${web}/`)), `${web}/ is still watched`);
});

test('a build output file changing does not reload the page; a source html does (#393)', async (context) => {
  // The incident, with the real watcher: an Android build writes .html files under
  // src-tauri/target/…/tauri-codegen-assets/ and Vite broadcast a `full-reload`
  // to every open browser (journal of the supervised dev server, 2026-10-15,
  // 15:11 and 22:50). A scratch root, the config's own ignore list anchored there.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('vite');
  const root = mkdtempSync(join(tmpdir(), 'tmm-vite-watch-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>app</body></html>');
  const quiet = ['src-tauri/target/aarch64-linux-android/release/build/out/tauri-codegen-assets', 'src-tauri/gen/android/build/reports', 'dist', 'temp', 'build', '.tmm/agents/x'];
  for (const dir of quiet) { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, 'seed.html'), '<html></html>'); }
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', cacheDir: join(root, '.cache'),
    server: { middlewareMode: true, watch: { ignored: watchIgnored(root) }, hmr: false },
    optimizeDeps: { noDiscovery: true, entries: [] },
  });
  context.after(() => server.close());
  // What the watcher reports is what Vite turns into an update, and an `.html`
  // among it into a full page reload.
  const seen: string[] = [];
  server.watcher.on('all', (_event: string, file: string) => seen.push(file.slice(root.length + 1)));
  await new Promise((r) => setTimeout(r, 400));
  for (const dir of quiet) writeFileSync(join(root, dir, 'seed.html'), `<html>${dir} changed</html>`);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(seen, [], `the watcher reported build output, which reloads every open tab: ${seen.join(', ')}`);
  // The control: the same change to a page the app serves IS reported (the watcher works).
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>app changed</body></html>');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(seen, ['index.html'], 'the index.html control was not reported');
});

test('the dev server listens on the loopback unless a person says otherwise (#393, security)', () => {
  // The only intended path from outside this host is the reverse SSH tunnel, which
  // dials 127.0.0.1; a 0.0.0.0 listener was reachable from the whole security group.
  assert.equal(createViteConfig('serve', {}).server.host, '127.0.0.1');
  assert.equal(createViteConfig('build', {}).server.host, '127.0.0.1');
  assert.equal(devHost({}), '127.0.0.1');
  assert.equal(devHost({ [DEV_HOST_ENV]: '  ' }), '127.0.0.1', 'blank is not a choice');
  assert.equal(devHost({ [DEV_HOST_ENV]: '0.0.0.0' }), '0.0.0.0', 'LAN dev is opt-in');
  assert.equal(createViteConfig('serve', { [DEV_HOST_ENV]: '0.0.0.0' }).server.host, '0.0.0.0');
  assert.equal(devHost({ TAURI_DEV_HOST: '192.168.1.5' }), '192.168.1.5', 'Tauri’s own name for mobile dev');
  assert.equal(devHost({ [DEV_HOST_ENV]: '10.0.0.7', TAURI_DEV_HOST: '192.168.1.5' }), '10.0.0.7', 'ours wins');
  assert.equal(createViteConfig('serve', {}).server.allowedHosts.join(), ['.ts.net', 'localhost'].join(), 'allowedHosts is not widened');
});

test('what is not the web app is not SERVED either: a watch ignore is not access control (#393, security)', async (context) => {
  // Measured on a private Vite before: `.tmm/agents/x/launch.json` (an agent's
  // environment), temp/, worktree/ and src-tauri/ answered 200 over a plain URL
  // and over /@fs/<abs path>. server.fs.deny REPLACES Vite's defaults, so the list
  // keeps every one of them and adds the directories that are not the web app.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { createServer: createHttpServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer, resolveConfig } = await import('vite');
  const root = mkdtempSync(join(tmpdir(), 'tmm-vite-deny-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const vitesOwn = (await resolveConfig({ root, configFile: false, logLevel: 'silent' }, 'serve')).server.fs.deny;
  for (const pattern of vitesOwn) assert.ok(fsDeny(root).includes(pattern), `Vite’s own default ${pattern} is still denied`);
  assert.deepEqual([...VITE_DEFAULT_FS_DENY].sort(), [...vitesOwn].sort(), 'the restated defaults ARE the installed Vite’s (re-check when Vite is upgraded)');
  assert.deepEqual(createViteConfig('serve', {}).server.fs, { deny: fsDeny() });

  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>app</body></html>');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'export const app = 1;\n');
  const hidden = ['.tmm/agents/x/launch.json', 'temp/x.txt', 'worktree/y.txt', 'src-tauri/Cargo.toml', 'build/z.txt', 'dist/index.html'];
  for (const f of hidden) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), 'SECRET'); }
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', cacheDir: join(root, '.cache'),
    server: { middlewareMode: true, hmr: false, fs: { deny: fsDeny(root) } },
    optimizeDeps: { noDiscovery: true, entries: [] },
  });
  context.after(() => server.close());
  const http = createHttpServer(server.middlewares);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  context.after(() => http.close());
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const status = async (path: string) => (await fetch(`${base}${path}`)).status;
  for (const f of hidden) {
    assert.equal(await status(`/${f}`), 403, `/${f} (plain URL)`);
    assert.equal(await status(`/@fs${join(root, f)}`), 403, `/@fs/${f}`);
  }
  assert.equal(await status('/'), 200, 'the app’s page still serves');
  assert.equal(await status('/src/app.js'), 200, 'and its source');
  assert.equal(await status(`/@fs${join(root, 'src', 'app.js')}`), 200, 'by /@fs too');
});

test('package-lock.json pins the Vite the dev-client patch was measured on: a fresh npm ci installs the stamped version, not only a checkout whose node_modules had drifted (#396)', () => {
  // The stamp test below reads node_modules, so a checkout whose node_modules had been updated
  // past the lock stayed green while every fresh `npm ci` (6.4.1 from the lock) failed it.
  // Reading the lock makes the drift fail HERE, on every machine, in the commit that causes it.
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/vite'].version, QUIET_RECONNECT_MEASURED_ON,
    `package-lock.json pins Vite ${lock.packages['node_modules/vite'].version} but the dev-client patch was measured on ${QUIET_RECONNECT_MEASURED_ON}: upgrade the lock, the stamp and the patch together (docs/conventions/development.md § The dev server)`);
});

test('the dev-client patch is stamped with its Vite, lands on every piece of text it replaces, and fails loudly when one is gone (#393)', async () => {
  // Vite’s dev client ends "Polling for restart..." in location.reload(): the composer
  // text and scroll position of the owner’s browser tab. The patch (run against a fake
  // browser in vite-client-reconnect.test.ts) reconnects with a fresh transport instead.
  // This file pins what only the text can tell: the version it was measured on, the four
  // anchors, and that a Vite whose client reads differently stops the dev server.
  const installed = JSON.parse(readFileSync(new URL('../node_modules/vite/package.json', import.meta.url), 'utf8')).version;
  assert.equal(installed, QUIET_RECONNECT_MEASURED_ON,
    `the dev-client patch was measured on Vite ${QUIET_RECONNECT_MEASURED_ON}, this is ${installed}: re-check it live and update the stamp (docs/conventions/development.md § The dev server)`);
  const client = readFileSync(new URL('../node_modules/vite/dist/client/client.mjs', import.meta.url), 'utf8');
  const plugin = quietDevReconnect();
  const id = '/x/node_modules/vite/dist/client/client.mjs?v=1';
  const patched = plugin.transform(client, id) as string;
  assert.ok(!/waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/u.test(patched), 'the unconditional reload after the ping is gone');
  assert.ok(patched.includes('const __tmmNewTransport = () => normalizeModuleRunnerTransport(') && patched.includes('let transport = __tmmNewTransport();'), 'the transport is a factory');
  assert.equal((patched.match(/location\.reload\(\)/gu) ?? []).length, (client.match(/location\.reload\(\)/gu) ?? []).length, 'the reconnect adds one loopback reload and removes the unconditional one: no other reload is added');
  assert.match(patched, /else if \(restarted && \["localhost", "127\.0\.0\.1", "\[::1\]"\]\.includes\(location\.hostname\)\) location\.reload\(\)/u, 'the one reload left is a CONFIRMED restart on the loopback');
  assert.match(patched, /clearInterval\(ownPingId\)/u, 'the ping timer dies with its socket');
  // The patched client is still a module (esbuild is Vite’s own parser).
  const { transformWithEsbuild } = await import('vite');
  await transformWithEsbuild(patched, 'client.mjs', { loader: 'js', format: 'esm', target: 'esnext' });
  // Not the Vite client: untouched.
  assert.equal(plugin.transform('location.reload();', '/x/src/lib/other.js'), undefined);
  // Every piece of replaced text must be there exactly once: gone, or twice, stops the dev server.
  assert.equal(CLIENT_PATCHES.length, 4, 'the four pieces of text');
  for (const { name, original } of CLIENT_PATCHES) {
    assert.ok(client.includes(original), `the text the patch replaces is this Vite’s: ${name}`);
    assert.throws(() => plugin.transform(client.replace(original, 'REMOVED'), id), /Unsupported Vite dev client: .* not found exactly once/, `gone: ${name}`);
    assert.throws(() => plugin.transform(`${client}\n${original}`, id), /Unsupported Vite dev client: .* not found exactly once/, `twice: ${name}`);
  }
  assert.ok(createViteConfig('serve', {}).plugins.some((p: { name?: string }) => p?.name === 'quiet-dev-reconnect'), 'and it is in the config');
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

// Board #464 (owner, 2026-10-24 22:03: a blank page). Vite's dep pre-bundle cache
// defaulted to `<root>/node_modules/.vite`, and a task worktree's node_modules is a
// symlink to the launch checkout's, so ANY Vite started from a worktree rewrote the
// supervised dev server's deps/_metadata.json (16:58, a scratch server on another
// port: the port preflight guards one port only) while that server kept serving its
// old dep hash. The cache now lives in each checkout's own gitignored `.vite/`.
test('the dep cache is this checkout\'s own, outside node_modules, for serve and build alike (#464)', async () => {
  const { fileURLToPath } = await import('node:url');
  const { realpathSync } = await import('node:fs');
  const here = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(viteCacheDir(), `${here}/.vite`);
  assert.equal(createViteConfig('serve', {}).cacheDir, `${here}/.vite`);
  assert.equal(createViteConfig('build', {}).cacheDir, `${here}/.vite`);
  assert.ok(!viteCacheDir().split('/').includes('node_modules'), 'never inside node_modules: that directory is shared by symlink');
  assert.match(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^\/\.vite$/mu, 'the cache is gitignored');
});

test('the cache directory is resolved from the REAL directory, so a symlinked checkout path cannot point it elsewhere (#464)', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-vite-cache-')));
  try {
    mkdirSync(join(base, 'launch/node_modules'), { recursive: true });
    mkdirSync(join(base, 'launch/worktree/task'), { recursive: true });
    symlinkSync(join(base, 'launch/node_modules'), join(base, 'launch/worktree/task/node_modules'));   // how every task worktree is set up
    symlinkSync(join(base, 'launch/worktree/task'), join(base, 'alias'));                                // and a path that reaches it through a link
    assert.equal(viteCacheDir(join(base, 'launch/worktree/task')), join(base, 'launch/worktree/task/.vite'));
    assert.equal(viteCacheDir(join(base, 'alias')), join(base, 'launch/worktree/task/.vite'));
    assert.equal(viteCacheDir(join(base, 'launch')), join(base, 'launch/.vite'));
    for (const root of ['launch/worktree/task', 'alias', 'launch']) {
      assert.ok(!viteCacheDir(join(base, root)).includes('node_modules'), `${root}: not through the shared install`);
    }
    assert.notEqual(viteCacheDir(join(base, 'launch/worktree/task')), viteCacheDir(join(base, 'launch')), 'a worktree and the launch checkout never share a cache');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('two Vite roots that share a node_modules by symlink no longer write into each other (#464, the incident, on a scratch fixture)', async (context) => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('vite');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-vite-shared-')));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'shared/node_modules/tiny-dep'), { recursive: true });
  writeFileSync(join(base, 'shared/node_modules/tiny-dep/package.json'), '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(base, 'shared/node_modules/tiny-dep/index.js'), 'module.exports = { hi: 1 };');
  for (const name of ['a', 'b']) {
    mkdirSync(join(base, name));
    symlinkSync(join(base, 'shared/node_modules'), join(base, name, 'node_modules'));
    writeFileSync(join(base, name, 'index.html'), '<!doctype html><html><body>x</body></html>');
    writeFileSync(join(base, name, 'package.json'), '{"name":"fx","type":"module"}');
  }
  const optimize = async (root: string, cacheDir?: string) => {
    const server = await createServer({
      root, configFile: false, logLevel: 'silent', ...(cacheDir ? { cacheDir } : {}),
      server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { include: ['tiny-dep'], entries: [] },
    });
    const meta = join(cacheDir ?? join(root, 'node_modules/.vite'), 'deps/_metadata.json');
    for (let i = 0; i < 100 && !existsSync(meta); i++) await new Promise((r) => setTimeout(r, 100));
    await server.close();
    return existsSync(meta);
  };
  // The incident: Vite's default cacheDir goes THROUGH the symlink into the shared install.
  assert.equal(await optimize(join(base, 'a')), true);
  assert.equal(existsSync(join(base, 'shared/node_modules/.vite/deps/_metadata.json')), true, 'the default cache landed in the SHARED node_modules');
  assert.equal(existsSync(join(base, 'a/.vite')), false);
  rmSync(join(base, 'shared/node_modules/.vite'), { recursive: true, force: true });
  // The config's cacheDir: each root keeps its own, and the shared install is never written.
  assert.equal(await optimize(join(base, 'a'), viteCacheDir(join(base, 'a'))), true);
  assert.equal(await optimize(join(base, 'b'), viteCacheDir(join(base, 'b'))), true);
  assert.equal(existsSync(join(base, 'a/.vite/deps/_metadata.json')), true);
  assert.equal(existsSync(join(base, 'b/.vite/deps/_metadata.json')), true);
  assert.equal(existsSync(join(base, 'shared/node_modules/.vite')), false, 'nothing was written through the symlink');
});

test('vite build writes nothing into the dep cache, so a build in the launch checkout is not a second writer (#464)', async (context) => {
  // The build:android runs happen in the LIVE checkout, next to the supervised dev server whose cache is
  // <checkout>/.vite. Measured on the real project (Vite 6.4.2): after `rm -rf .vite && vite build` the
  // directory does not exist. Pinned here with the REAL config's plugin set on a scratch root and a
  // cacheDir of its own, so no checkout's cache is touched even if this ever failed.
  const { mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { build } = await import('vite');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-vite-build-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(root, 'main.js'), "import { answer } from './a.js'; document.title = String(answer);");
  writeFileSync(join(root, 'a.js'), 'export const answer = 42;');
  const cacheDir = join(root, '.vite');
  await build({ ...createViteConfig('build', {}), root, configFile: false, logLevel: 'silent', cacheDir, build: { outDir: join(root, 'out'), emptyOutDir: true } });
  assert.equal(existsSync(join(root, 'out/index.html')), true, 'the build ran');
  assert.equal(existsSync(cacheDir), false, 'and it created no dep cache');
});

test('a build in the SAME root and cacheDir as a running dev server leaves its cache and its served deps alone (#464, reviewer P1)', async (context) => {
  // The case that matters: build:android runs in the launch checkout, next to the supervised dev server whose
  // cache is <checkout>/.vite. Serve populates the cache and STAYS UP; the project's build runs on the same root
  // and the same cacheDir (the config\'s plugin set, a scratch root); every file in the cache keeps its bytes,
  // its mtime and its name, and the optimized dep URL still answers. A private scratch root: no checkout touched.
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync, readFileSync: read, readdirSync, statSync, rmSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer, build } = await import('vite');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-vite-serve-build-')));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'shared/node_modules/tiny-dep'), { recursive: true });
  writeFileSync(join(base, 'shared/node_modules/tiny-dep/package.json'), '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(base, 'shared/node_modules/tiny-dep/index.js'), 'module.exports = { hi: 1 };');
  const root = join(base, 'checkout');
  mkdirSync(root);
  symlinkSync(join(base, 'shared/node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"name":"fx","type":"module"}');
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(root, 'main.js'), "import dep from 'tiny-dep'; document.title = String(dep.hi);");
  const cacheDir = viteCacheDir(root);
  const server = await createServer({
    ...createViteConfig('serve', {}), root, configFile: false, logLevel: 'silent', cacheDir,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { include: ['tiny-dep'], entries: [] },
  });
  context.after(() => server.close());
  const meta = join(cacheDir, 'deps/_metadata.json');
  for (let i = 0; i < 100 && !existsSync(meta); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));                    // let the plugins settle their own files
  assert.equal(existsSync(meta), true, 'serve populated the cache');
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else out[path.slice(cacheDir.length)] = `${statSync(path).mtimeMs}:${createHash('md5').update(read(path)).digest('hex')}`;
      }
    };
    walk(cacheDir);
    return out;
  };
  const before = snapshot();
  assert.ok(Object.keys(before).some((f) => f.includes('tiny-dep')), 'an optimized dep is in it');
  const hash = JSON.parse(read(meta, 'utf8')).browserHash;
  const url = `/.vite/deps/tiny-dep.js?v=${hash}`;
  const served = await server.transformRequest(url);
  assert.ok(served?.code.includes('hi'), 'the optimized dep is served');
  await new Promise((r) => setTimeout(r, 50));                     // mtimes are compared at millisecond resolution
  await build({ ...createViteConfig('build', {}), root, configFile: false, logLevel: 'silent', cacheDir, build: { outDir: join(base, 'out'), emptyOutDir: true } });
  assert.equal(existsSync(join(base, 'out/index.html')), true, 'the build ran');
  assert.deepEqual(snapshot(), before, 'the build touched nothing in the running server\'s cache: same files, same bytes, same mtimes');
  assert.equal(JSON.parse(read(meta, 'utf8')).browserHash, hash, 'the dep hash the server handed to clients is unchanged');
  assert.ok((await server.transformRequest(url))?.code.includes('hi'), 'and the dep URL still answers after the build');
});
