import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEV_DOWNLOAD_PATH,
  DEV_WEB_PORT,
  DEV_WS_PATH,
  devHost,
  devServerTargets,
} from './scripts/dev-ports.mjs';

export function devProxy(env = process.env) {
  const target = devServerTargets(env);
  return {
    [DEV_WS_PATH]: { target: target.ws, ws: true },
    [DEV_DOWNLOAD_PATH]: { target: target.http },
  };
}

function allowCompactXtermLines() {
  const original = 'if(i<1)throw new Error(`${e} cannot be less than 1, value: ${i}`)';
  // Lower bound must stay in sync with LINE_HEIGHT_MIN in src/lib/terminal-prefs.svelte.js.
  const patched = 'if(i<(e==="lineHeight"?.4:1))throw new Error(`${e} cannot be less than ${e==="lineHeight"?.4:1}, value: ${i}`)';
  const glyphAssignment = 'f.textContent=R';
  const centeredGlyphAssignment = 'f.replaceChildren(Object.assign(this._document.createElement("span"),{className:"xterm-glyph",textContent:R}))';
  const compositionAssignment = 'this._compositionView.textContent=t.data';
  const centeredCompositionAssignment = 'this._compositionView.replaceChildren(Object.assign(this._compositionView.ownerDocument.createElement("span"),{className:"xterm-glyph",textContent:t.data}))';

  return {
    name: 'allow-compact-xterm-lines',
    enforce: 'pre',
    transform(code, id) {
      // Dev serves excluded deps with a `?v=<hash>` query on the id; strip it.
      if (!id.split('?')[0].endsWith('/@xterm/xterm/lib/xterm.mjs')) return;
      if (!code.includes(original)) throw new Error('Unsupported @xterm/xterm lineHeight validation');
      const glyphAssignments = code.split(glyphAssignment).length - 1;
      if (glyphAssignments !== 3) throw new Error('Unsupported @xterm/xterm DOM glyph renderer');
      const compositionAssignments = code.split(compositionAssignment).length - 1;
      if (compositionAssignments !== 1) throw new Error('Unsupported @xterm/xterm IME renderer');
      return code
        .replace(original, patched)
        .replaceAll(glyphAssignment, centeredGlyphAssignment)
        .replace(compositionAssignment, centeredCompositionAssignment);
    },
  };
}

// A dropped connection never reloads the page (owner, 2026-10-15 23:40, #393:
// "应该悄悄恢复，最多有个悬浮提示一下重连就行，保证整个页面稳定性").
//
// Vite's dev client answers a lost HMR socket with "[vite] server connection
// lost. Polling for restart..." and, as soon as the server answers a ping,
// `location.reload()` — the whole page, composer text and scroll position
// included, whatever dropped it (a proxy's idle timeout, a laptop's wifi, a tab
// that was frozen and resumed, the SSH tunnel behind the CloudFront → Caddy →
// tunnel path the browser app is reached through). The patch reconnects instead.
//
// HOW (reviewer P1-A on the first cut): Vite's transport wrapper is a state
// machine that a failed dial POISONS — a rejected connectingPromise sticks and
// every later connect() re-awaits it, disconnect() is a no-op once the socket has
// closed, and the default (no hmr.port) path swaps its socket factory to the
// SERVER's direct address, which a remote browser cannot reach. So each attempt
// builds a FRESH transport from the same factory the page started with (always
// dialled at the page's own proxied address first), hands it to the same HMRClient
// (its module registrations — what makes hot updates reach the modules — stay), and
// a failed attempt is simply thrown away. The old transport's 30 s ping timer is
// also cleared the moment its socket is seen CLOSED (the wrapper's own disconnect
// never runs after a natural close, so one timer would leak per drop).
//
// WHEN TO RELOAD: a failed re-dial is NOT evidence of a restart — the same server
// may refuse one handshake and take the next. The evidence is the server's
// IDENTITY: its HMR token is new on every start, so the page re-reads /@vite/client
// and compares. Only a confirmed new identity reloads, and only a page on the
// loopback (the local dev loop's wanted answer to a restart); a page reached
// through any other host never reloads, it says so once in the console. Short of
// either, it keeps trying for ~1 minute and then says HMR is off until a manual
// reload.
//
// Guarded like the xterm patch: every piece of text it replaces must be found
// exactly once, or the dev server fails loudly instead of silently reloading again.
// The Vite whose dev client this was measured against (live, 2026-10-15/16, through a
// proxy that dropped the connection for 5, 30 and 60 s, one that refused the first
// HMR handshake, and a dev-server restart). scripts/vite-config.test.ts fails when the
// installed Vite is another one, so an upgrade re-checks the patch instead of
// silently keeping or losing it.
export const QUIET_RECONNECT_MEASURED_ON = '6.4.2';

export const CLIENT_PATCHES = [
  // 1. The transport becomes a factory: a fresh one per attempt.
  {
    name: 'the transport factory',
    original: 'const transport = normalizeModuleRunnerTransport(\n  (() => {\n    let wsTransport',
    patched: 'const __tmmNewTransport = () => normalizeModuleRunnerTransport(\n  (() => {\n    let wsTransport',
  },
  {
    name: 'the transport binding',
    original: '  })()\n);\nlet willUnload = false;',
    patched: [
      '  })()',
      ');',
      'let transport = __tmmNewTransport();',
      '// The server\'s identity: its HMR token changes on every start (tmux-mobile #393).',
      'async function __tmmServerRestarted() {',
      '  try {',
      '    const res = await fetch(importMetaUrl.href.split("?")[0], { cache: "no-store" });',
      '    if (!res.ok) return false;',
      '    const served = /const wsToken = "([^"]*)"/.exec(await res.text())?.[1];',
      '    return !!served && served !== wsToken;',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      'let willUnload = false;',
    ].join('\n'),
  },
  // 2. The ping timer dies with its socket.
  {
    name: 'the ping timer',
    original: '      pingIntervalId = setInterval(() => {\n        if (socket.readyState === socket.OPEN) {\n          socket.send(JSON.stringify({ type: "ping" }));\n        }\n      }, pingInterval);',
    patched: [
      '      const ownPingId = pingIntervalId = setInterval(() => {',
      '        if (socket.readyState === socket.OPEN) {',
      '          socket.send(JSON.stringify({ type: "ping" }));',
      '        } else if (socket.readyState === socket.CLOSED) {',
      '          clearInterval(ownPingId);',
      '        }',
      '      }, pingInterval);',
    ].join('\n'),
  },
  // 3. The reconnect, in place of the reload.
  {
    name: 'the reload after the ping',
    original: '          await waitForSuccessfulPing(url.href);\n          location.reload();',
    patched: [
      '          await waitForSuccessfulPing(url.href);',
      '          let restored = false;',
      '          let restarted = false;',
      '          for (let attempt = 0; attempt < 12 && !restored && !restarted; attempt++) {',
      '            transport = __tmmNewTransport();',
      '            hmrClient.transport = transport;',
      '            try {',
      '              await transport.connect(createHMRHandler((next) => {',
      '                if (next.type === "custom" && next.event === "vite:ws:connect") restored = true;',
      '                return handleMessage(next);',
      '              }));',
      '            } catch {}',
      '            if (!restored) await wait(50);',
      '            if (restored) break;',
      '            restarted = await __tmmServerRestarted();',
      '            if (!restarted) await wait(Math.min(1e3 * (attempt + 1), 5e3));',
      '          }',
      '          if (restored) console.info("[vite] connection restored; the page was not reloaded.");',
      '          else if (restarted && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) location.reload();',
      '          else if (restarted) console.info("[vite] the dev server restarted; HMR is off until this page is reloaded.");',
      '          else console.info("[vite] could not re-establish HMR; it is off until this page is reloaded.");',
    ].join('\n'),
  },
];

export function quietDevReconnect() {
  return {
    name: 'quiet-dev-reconnect',
    enforce: 'post',
    transform(code, id) {
      if (!id.split('?')[0].endsWith('/vite/dist/client/client.mjs')) return;
      let out = code;
      for (const { name, original, patched } of CLIENT_PATCHES) {
        if (out.split(original).length !== 2) throw new Error(`Unsupported Vite dev client: ${name} not found exactly once`);
        out = out.replace(original, () => patched);
      }
      return out;
    },
  };
}

// Vite reads the whole root, and this checkout holds much that is not the web
// app (#342, #393; docs/conventions/development.md § Vite watches the web app):
//
// - agent task worktrees: they live INSIDE the checkout, in its gitignored
//   worktree/ (#342, § Agent worktree isolation). Without an ignore one fresh
//   worktree cost the supervised server 705 inotify watches (measured), its
//   dependency scan crawled each worktree's index.html as another app, and one
//   that had built Rust would add roughly this checkout's own target/ (58,215
//   entries, estimated);
// - src-tauri/: the Rust crate, its target/ and the Android project's build
//   output. An Android build writes `.html` files there
//   (target/<triple>/…/tauri-codegen-assets/<hash>.html, gen/android/build/
//   reports/problems/problems-report.html), and Vite answers ANY changed `.html`
//   under the root with a full PAGE RELOAD of every open browser — journal of the
//   supervised dev server, 2026-10-15: two such reloads at 15:11 and two at 22:50
//   (+ the problems report at 15:16), the owner's "the browser app restarts by
//   itself" (#393). Nothing in src/ imports from src-tauri/;
// - temp/ (agents' gitignored scratch, screenshots and html previews), build/
//   (the gradle cache symlink), dist/ (`vite build` output: a build while the dev
//   server runs would reload every tab) and .tmm/ (managed agents' homes).
//
// Absolute and anchored at THIS config's directory, so a worktree's own Vite
// ignores only what is nested inside it.
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const NOT_THE_WEB_APP = ['worktree', 'src-tauri', 'temp', 'build', 'dist', '.tmm'];

/** What the dev server's watcher skips (absolute globs). */
export const watchIgnored = (root = ROOT) => NOT_THE_WEB_APP.map((dir) => `${root}/${dir}/**`);

// What the dev server will NOT serve (board #393, security review): a watch
// ignore is not access control. `server.fs.deny` REPLACES Vite's default list,
// so the defaults (6.4.2: .env, .env.*, *.{crt,pem} and the .git directories)
// are restated here — scripts/vite-config.test.ts fails if Vite's own default has
// something this list lacks — and the directories that are not the web app are
// added, absolute and anchored at the config like the watch list. Measured on a
// private Vite before this: `.tmm/agents/x/launch.json`, `temp/`, `worktree/` and
// `src-tauri/` answered 200 over a plain URL and over `/@fs/<abs path>`.
export const VITE_DEFAULT_FS_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'];
export const fsDeny = (root = ROOT) => [...VITE_DEFAULT_FS_DENY, ...NOT_THE_WEB_APP.map((dir) => `${root}/${dir}/**`)];

/** Vite's default dependency-scan entry glob, minus the same directories. */
export const scanEntries = () => ['**/*.html', ...NOT_THE_WEB_APP.map((dir) => `!${dir}/**`)];

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const COMMIT = /^[0-9a-f]{8,40}$/;
const MINUTE = /^\d{4}-\d\d-\d\d \d\d:\d\d$/;
const minuteOf = (now) => now.toISOString().slice(0, 16).replace('T', ' ');
const gitHere = (args) => execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** The UI's RELEASE build identity (board #368): the package version, the
 * source commit and the UTC minute. The same three words the server's login
 * answer carries (`src-tauri/src/build_info.rs`), so a stale phone is a mismatch
 * someone can read. Order, for the commit and the time alike: the environment
 * (`SOURCE_COMMIT` / `SOURCE_TIME`, public metadata a build that has no `.git`
 * is handed: the e2e image), then git, then `dev` / the clock; a bad value is
 * ignored, never a failed build. `--short=8` is AT LEAST 8 hex characters. */
export function buildIdentity({ env = process.env, now = new Date(), git = gitHere } = {}) {
  let commit = String(env.SOURCE_COMMIT ?? '').trim().toLowerCase();
  if (!COMMIT.test(commit)) {
    commit = 'dev';
    try {
      const sha = git(['rev-parse', '--short=8', 'HEAD']).trim();
      if (COMMIT.test(sha)) commit = sha;
    } catch { /* no git: dev */ }
  }
  const stamped = String(env.SOURCE_TIME ?? '').trim();
  return { version: PACKAGE.version, commit, built: MINUTE.test(stamped) ? stamped : minuteOf(now) };
}

/** A DEV SERVER's identity (review P1-B): config is read once at start, so a
 * commit or time read then would keep naming itself after hot reloads and main
 * moving, and point a cache hunt at the wrong thing. It is `dev` + the minute
 * the server STARTED, flagged, and About never compares it. Only `vite build`
 * output carries a commit. */
export function devServerIdentity(now = new Date()) {
  return { version: PACKAGE.version, commit: 'dev', built: minuteOf(now), devServer: true };
}

export function createViteConfig(command, env = process.env, identityDeps = {}) {
  return {
    plugins: [allowCompactXtermLines(), quietDevReconnect(), svelte()],
    // esbuild dep pre-bundling bypasses plugin transforms, so the compact-lines
    // patch above would never apply in dev. Serve @xterm/xterm from source.
    optimizeDeps: {
      exclude: ['@xterm/xterm'],
      // Vite's default entry glob, minus what is not the web app.
      entries: scanEntries(),
    },
    clearScreen: false,
    // Replaced at build time; read through src/lib/core/build-info.ts only.
    // A dev server is `dev` + its start time (never a commit): see devServerIdentity.
    define: {
      __TMM_BUILD__: JSON.stringify(command === 'serve' ? devServerIdentity(identityDeps.now) : buildIdentity({ env, ...identityDeps })),
      __TMM_LICENSE__: JSON.stringify(PACKAGE.license),
    },
    server: {
      host: devHost(env),
      port: DEV_WEB_PORT,
      strictPort: true,
      allowedHosts: ['.ts.net', 'localhost'],
      watch: { ignored: watchIgnored() },
      fs: { deny: fsDeny() },
      ...(command === 'serve' ? { proxy: devProxy(env) } : {}),
    },
  };
}

export default defineConfig(({ command }) => createViteConfig(command));
