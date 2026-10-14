import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEV_DOWNLOAD_PATH,
  DEV_WEB_PORT,
  DEV_WS_PATH,
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

// Agent task worktrees live INSIDE the checkout, in its gitignored worktree/
// (#342, docs/conventions/development.md § Agent worktree isolation). Vite
// reads the whole root, so without this the dev server serving this checkout
// also watches every worktree — measured: one fresh worktree cost the
// supervised server 705 inotify watches; estimated, not measured: one that has
// built Rust would add roughly what this checkout's own target/ holds (58,215
// entries) — and its dependency scan crawls each worktree's index.html as
// another app. Anchored at THIS config's directory, so a worktree's own Vite
// ignores only a worktree/ nested inside it.
const AGENT_WORKTREES = fileURLToPath(new URL('./worktree', import.meta.url));

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
    plugins: [allowCompactXtermLines(), svelte()],
    // esbuild dep pre-bundling bypasses plugin transforms, so the compact-lines
    // patch above would never apply in dev. Serve @xterm/xterm from source.
    optimizeDeps: {
      exclude: ['@xterm/xterm'],
      // Vite's default entry glob, minus the agent worktrees.
      entries: ['**/*.html', '!worktree/**'],
    },
    clearScreen: false,
    // Replaced at build time; read through src/lib/core/build-info.ts only.
    // A dev server is `dev` + its start time (never a commit): see devServerIdentity.
    define: {
      __TMM_BUILD__: JSON.stringify(command === 'serve' ? devServerIdentity(identityDeps.now) : buildIdentity({ env, ...identityDeps })),
      __TMM_LICENSE__: JSON.stringify(PACKAGE.license),
    },
    server: {
      host: '0.0.0.0',
      port: DEV_WEB_PORT,
      strictPort: true,
      allowedHosts: ['.ts.net', 'localhost'],
      watch: { ignored: [`${AGENT_WORKTREES}/**`] },
      ...(command === 'serve' ? { proxy: devProxy(env) } : {}),
    },
  };
}

export default defineConfig(({ command }) => createViteConfig(command));
