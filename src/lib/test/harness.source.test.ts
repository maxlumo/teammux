// Board #177 (lead, 2026-09-12): two `npm test` runs on one machine — the
// launch checkout and a worktree — made every render/mount case in one of
// them time out at 60 s with "WebSocket server error: Port 24678 is already
// in use". Vite 6's `createServer` in middleware mode opens its OWN http
// server for the HMR websocket on the fixed default 24678 even with
// `server.hmr: false` — that flag stops the updates, `server.ws: false` is
// what stops the socket (dep-*.js: `if (config.server.ws === false)`).
// Concurrent suites are normal here (several agents, one host), so no
// harness may hold a fixed port. The rule lives in ONE helper.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const listed = (pattern: string) => execFileSync('rg', ['-l', pattern, 'src', 'scripts', '--glob', '*.ts', '--glob', '*.mjs', '--glob', '*.js'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.endsWith('harness.source.test.ts')).sort();

test('the ONE Vite SSR helper opens no socket: ws:false, hmr:false, no port', async () => {
  const ssr = await readFile(new URL('./ssr.ts', import.meta.url), 'utf8');
  assert.match(ssr, /server:\s*\{\s*middlewareMode:\s*true,\s*hmr:\s*false,\s*ws:\s*false\s*\}/u, 'middleware mode, no HMR, and NO websocket server');
  assert.doesNotMatch(ssr, /port\s*:/u, 'no fixed port anywhere in the helper');
  assert.match(ssr, /appType:\s*'custom'/u);
});

test('the render tier is ONE process: every *.render.ts suite is collected by render.test.ts and shares the harness (board #178)', async () => {
  // Seven files were seven processes, each paying ~2.5 s CPU of fixed cost
  // (jsdom import, vite import, server start) plus the svelte runtime graph
  // — 44 s CPU for the tier, which a busy host stretched to 35–42 s per test
  // against a 60 s budget. The suites now run in one process behind one
  // warm server; the fixed cost is paid once, outside any test's timer.
  const creators = listed('createServer\\(');
  // The render tier's server is the helper's. The one other creator is not a render
  // process: scripts/vite-config.test.ts (board #393) runs the dev server's real file
  // watcher in middleware mode on a scratch root — no port, no socket, no component —
  // to prove a changed build-output .html is not reported (Vite turns it into a reload).
  assert.deepEqual(creators, ['scripts/vite-config.test.ts', 'src/lib/test/ssr.ts'], 'createServer( exists once for the render tier, in the helper (plus the watcher test)');
  // rg exits 1 when nothing matches — which is the pass here.
  let strays = '';
  try { strays = execFileSync('rg', ['--files', 'src', 'scripts', '-g', '*.render.test.ts'], { cwd: root, encoding: 'utf8' }).trim(); } catch (e) { if ((e as { status?: number }).status !== 1) throw e; }
  assert.equal(strays, '', 'no component owns a render PROCESS of its own — a *.render.test.ts is a stray');
  const suites = execFileSync('rg', ['--files', 'src', '-g', '*.render.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.ok(suites.length >= 7, `render suites found: ${suites.length}`);
  const collector = await readFile(new URL('./render.test.ts', import.meta.url), 'utf8');
  for (const f of suites) {
    const rel = f.replace(/^src\/lib\//u, '../').replace(/\.ts$/u, '.ts');
    assert.ok(collector.includes(`import '${rel}';`), `${f} is collected by render.test.ts`);
    const src = await readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ (?:[^}]*, )?renderHarness(?:, [^}]*)? \} from '\.\.\/test\/ssr\.ts'/u, `${f} uses the shared harness`);
    assert.doesNotMatch(src, /from '(?:vite|jsdom)'/u, `${f} does not reach for vite or jsdom itself`);
    assert.doesNotMatch(src, /timeout:\s*\d/u, `${f}: the budget is the harness constant, not a literal`);
    assert.match(src, /timeout: RENDER_TIMEOUT_MS/u, `${f} runs under the one render budget`);
    assert.doesNotMatch(src, /globalThis|\.close\(\)/u, `${f} installs no globals and closes nothing — the harness owns the environment`);
  }
});

test('the render budget is the harness constant, at least 3x the measured typical', async () => {
  const { RENDER_TIMEOUT_MS, RENDER_TYPICAL_MS } = await import('./ssr.ts');
  assert.ok(RENDER_TIMEOUT_MS >= 3 * RENDER_TYPICAL_MS, `${RENDER_TIMEOUT_MS} >= 3 × ${RENDER_TYPICAL_MS}`);
  assert.ok(RENDER_TIMEOUT_MS <= 60_000, 'no bigger than the budget the incident proved was not one');
});

test('the mount harness builds; it never serves', async () => {
  const mount = await readFile(new URL('./mount.ts', import.meta.url), 'utf8');
  assert.match(mount, /await build\(\{/u);
  assert.doesNotMatch(mount, /createServer|server:\s*\{|hmr|24678/u, 'a build has no listener to collide on');
});
