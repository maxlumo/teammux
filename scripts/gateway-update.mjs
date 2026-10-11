#!/usr/bin/env node
// `npm run gateway:update` — bring THIS machine's gateway up to the checkout
// it already runs from (board #343).
//
// The backend here is the tmm-managed gateway service: it runs
// `<repo>/src-tauri/target/release/tmm gateway start --service`, so the
// RUNNING BACKEND IS THAT `tmm` BINARY. Nothing watches the sources for it (a
// watcher that rebuilds mid-task is what we deliberately left behind), so
// after a merge to main somebody has to say "now". This is that command, and
// the orchestrator runs it after every ff-merge to main.
//
// It does NOT fetch or pull: on this host `main` IS the working tree and the
// merge already happened locally. Pulling would be a second opinion about
// which commit we are on.
//
// Three rules, taken from the dev watcher (scripts/dev-server-watch.sh) rather
// than re-derived:
//
//   1. Build first, restart second. A failed build leaves the running gateway
//      alone — the last good binary keeps serving every client.
//   2. Restart ONLY when the binary's BYTES differ. Cargo fingerprints by
//      mtime, so a checkout, a `touch` or a comment-only edit can relink an
//      identical binary; dropping every connected client for that is noise.
//   3. `tmm` is the binary to hash, not `server`. The gateway unit execs
//      `tmm`, and `build:server` embeds the built web UI into it (embed-ui) —
//      so a frontend-only change changes those bytes too, and must restart.
//
// `tmm gateway restart` is what actually restarts it: it refuses a service
// that is not OURS (this tmm + this config root), drives `systemctl --user`
// itself, and waits until our instance answers before returning. So this
// script never touches systemd, and a fake `tmm` is the whole seam its tests
// need.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The `tmm` to drive. Default: the one this checkout builds, which is the
 * one the installed service execs — identity (this tmm + this config root) is
 * what makes `gateway restart` accept the unit. Overridable so a test can
 * point it at a fake. */
export const TMM_BIN_ENV = 'TMUX_MOBILE_GATEWAY_TMM';

export function tmmPath(root = repoRoot, env = process.env) {
  const given = env[TMM_BIN_ENV];
  return given ? resolve(given) : join(root, 'src-tauri/target/release/tmm');
}

/** sha256 of a file, or null when it does not exist (nothing built yet). */
export function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function runInherit(root) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error) {
      console.error(`[gateway:update] ${command}: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  };
}

function captureLine(root) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  };
}

/**
 * Exit code: 0 when the gateway is at this checkout, non-zero when the build
 * or the restart failed. A `status` that says "not installed" is NOT a
 * failure — the host may never have migrated (install.md's runbook does
 * that), and a merge must not look broken because of it. The status lines we
 * print say so plainly.
 */
export async function gatewayUpdate({
  root = repoRoot,
  env = process.env,
  run = runInherit(root),
  capture = captureLine(root),
  hash = hashFile,
  log = console.log,
  warn = console.error,
} = {}) {
  const tmm = tmmPath(root, env);
  const before = hash(tmm);

  log('[gateway:update] building (npm run build:server)');
  const built = await run('npm', ['run', 'build:server']);
  if (built !== 0) {
    warn('[gateway:update] build FAILED — the running gateway was left alone');
    return built;
  }

  const after = hash(tmm);
  if (after === null) {
    warn(`[gateway:update] the build reported success but there is no binary at ${tmm}`);
    return 1;
  }

  if (after === before) {
    log('[gateway:update] tmm is byte-identical — NOT restarting (no client is dropped)');
  } else {
    log(`[gateway:update] tmm changed (${before === null ? 'built for the first time' : 'new bytes'}) — restarting the gateway`);
    const restarted = await run(tmm, ['gateway', 'restart']);
    if (restarted !== 0) {
      warn('[gateway:update] gateway restart FAILED — see the message above (not installed? run the runbook in docs/reference/install.md)');
      return restarted;
    }
  }

  const at = capture('git', ['log', '-1', '--format=%h %s']);
  if (at) log(`[gateway:update] now at ${at}`);
  await run(tmm, ['gateway', 'status']);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await gatewayUpdate();
