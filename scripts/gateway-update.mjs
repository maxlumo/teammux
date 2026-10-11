#!/usr/bin/env node
// `npm run gateway:update` — bring THIS machine's gateway up to the checkout
// it already runs from (board #343).
//
// The backend here is the tmm-managed gateway service: it runs
// `<repo>/src-tauri/target/release/tmm gateway start --service`, so the
// RUNNING BACKEND IS THAT `tmm` BINARY. Nothing watches the sources for it (a
// watcher that rebuilds mid-task is what we deliberately left behind), so
// after a merge to main somebody has to say "now". This is that command, and
// the orchestrator runs it after every ff-merge to main, from the launch
// checkout: run from an agent worktree it builds that worktree and then drives
// that worktree's `tmm`, whose absolute path is not the one the unit records,
// so `gateway restart` refuses it by identity before touching systemd.
//
// It does NOT fetch or pull: on this host `main` IS the working tree and the
// merge already happened locally. Pulling would be a second opinion about
// which commit we are on.
//
// Two rules are taken from the dev watcher (scripts/dev-server-watch.sh)
// rather than re-derived:
//
//   1. Build first, restart second. A failed build leaves the running gateway
//      alone — the last good binary keeps serving every client.
//   2. Restart only when the bytes the service should be running are not the
//      bytes it IS running. Cargo fingerprints by mtime, so a checkout, a
//      `touch` or a comment-only edit can relink an identical binary;
//      dropping every connected client for that is noise.
//
// Rule 2 is about the DEPLOYED artifact, and the file on disk cannot answer
// that on its own (reviewer P1-A on d31e1f06): compare a before/after hash of
// the file and a run whose restart FAILED looks, next time, exactly like a run
// with nothing to do — the build produces the same bytes, "nothing changed",
// and we would report a commit the gateway never started. So the comparison is
// against an ACTIVATION RECEIPT: the hash we last saw a successful
// `gateway restart` accept, written only after it returned (and it returns only
// once our instance answers). A missing, stale or mismatched receipt means
// deploy — the direction that retries rather than the one that skips.
//
// The receipt lives beside the binary it describes (`.tmm-gateway-deployed
// .json` in `target/release`, gitignored) and names the whole identity the
// service has (`gateway::service::Identity`): the binary, the CONFIG ROOT, and
// the service name (`TMM_GATEWAY_SERVICE`), plus the commit. Any of those
// differing makes it evidence about another service, so it is not read.
// `cargo clean` takes it with the binary, which costs one extra restart.
//
// `tmm gateway restart` is what actually restarts: it refuses a service that
// is not OURS (this tmm + this config root), drives `systemctl --user` itself,
// and waits until our instance answers before returning. So this script never
// touches systemd, and a fake `tmm` is the whole seam its tests need.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The `tmm` to drive. Default: the one this checkout builds, which is the
 * one the installed service execs — identity (this tmm + this config root) is
 * what makes `gateway restart` accept the unit. Overridable so a test can
 * point it at a fake, and so a host that builds into another target dir can
 * name the real artifact. */
export const TMM_BIN_ENV = 'TMUX_MOBILE_GATEWAY_TMM';
/** tmm's own override for the service name; part of what a receipt describes. */
export const SERVICE_ENV = 'TMM_GATEWAY_SERVICE';
export const RECEIPT_FILE = '.tmm-gateway-deployed.json';

export function tmmPath(root = repoRoot, env = process.env) {
  const given = env[TMM_BIN_ENV];
  return given ? resolve(given) : join(root, 'src-tauri/target/release/tmm');
}

/** The config root half of the service's identity, derived the way tmm derives
 * it (`config::dirs_next` + `service::current_identity`, which takes the XDG
 * BASE, not the app dir): `$XDG_CONFIG_HOME` when absolute, else `$HOME
 * /.config`, else `.config` beside the checkout. A receipt that named only the
 * binary would be read as evidence after a switch to another config root,
 * where the same binary serves a different service.  */
export function configHome(root = repoRoot, env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return resolve(xdg);
  if (env.HOME) return resolve(env.HOME, '.config');
  return resolve(root, '.config');
}

/** The hash that must be the same file three times over: what we hash, what
 * the build produced, and what the unit execs. Cargo can be told to build
 * somewhere else, and then the default path above is a stale or absent file —
 * so say so and stop, rather than hash one binary and restart another.
 *
 * Only the default Cargo layout is supported: the env vars below, and a
 * `target-dir`/`build.target` in a cargo config file we can see. The match is
 * deliberately crude (no TOML parser) because its only outcome is to STOP and
 * ask for the artifact by name — a false positive costs one env var, a false
 * negative is a stale hash. A layout chosen some other way is not detected;
 * name the artifact with `TMUX_MOBILE_GATEWAY_TMM` and it is used verbatim. */
export function targetDirConflict(env = process.env, root = repoRoot, read = readFileSync) {
  if (env[TMM_BIN_ENV]) return null;
  const why = ['CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET'].filter((k) => env[k]);
  const cargoHome = env.CARGO_HOME || (env.HOME ? join(env.HOME, '.cargo') : null);
  const configs = [join(root, 'src-tauri/.cargo'), join(root, '.cargo'), ...(cargoHome ? [cargoHome] : [])]
    // Cargo reads either name; the legacy one has no extension.
    .flatMap((dir) => [join(dir, 'config.toml'), join(dir, 'config')]);
  for (const file of configs) {
    let text = '';
    try {
      text = read(file, 'utf8');
    } catch {
      continue;
    }
    if (/^\s*(target-dir|target)\s*=/m.test(text)) why.push(file);
  }
  if (!why.length) return null;
  return `[gateway:update] ${why.join(' and ')} can move the build out of src-tauri/target/release, so the binary this would hash may not be the one it builds. Point ${TMM_BIN_ENV} at the real artifact — it must be the same file the unit's ExecStart names.`;
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

export function receiptPath(tmm) {
  return join(dirname(tmm), RECEIPT_FILE);
}

/** The hash this binary+service+config root was last ACTIVATED with, or null.
 * Anything unreadable, unparseable or about something else is null: deploy. */
export function deployedHash(tmm, service, home) {
  try {
    const r = JSON.parse(readFileSync(receiptPath(tmm), 'utf8'));
    const ok = r?.tmm === tmm
      && (r?.service ?? '') === service
      && r?.configHome === home
      && typeof r?.hash === 'string';
    return ok ? r.hash : null;
  } catch {
    return null;
  }
}

export function writeReceipt(tmm, service, home, hash, commit) {
  const body = { tmm, service, configHome: home, hash, commit, at: new Date().toISOString() };
  writeFileSync(receiptPath(tmm), `${JSON.stringify(body, null, 2)}\n`);
}

function runInherit(root, env) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
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
 * Exit code 0 means ONE thing: the gateway is running this checkout's binary,
 * and said so on the last check. Every other outcome is non-zero — a failed
 * build, a refused or failed restart (a host that has not migrated fails here,
 * with the runbook named), and a gateway that does not answer, whether or not
 * this run restarted it. "now at <commit>" is printed only on that one
 * success, after the final check, never before it.
 */
export async function gatewayUpdate({
  root = repoRoot,
  env = process.env,
  run = runInherit(root, env),
  capture = captureLine(root),
  log = console.log,
  warn = console.error,
} = {}) {
  const conflict = targetDirConflict(env, root);
  if (conflict) {
    warn(conflict);
    return 1;
  }
  const tmm = tmmPath(root, env);
  const service = env[SERVICE_ENV] || '';
  const home = configHome(root, env);

  log('[gateway:update] building (npm run build:server)');
  const built = await run('npm', ['run', 'build:server']);
  if (built !== 0) {
    warn('[gateway:update] build FAILED — the running gateway was left alone');
    return built;
  }

  const want = hashFile(tmm);
  if (want === null) {
    warn(`[gateway:update] the build reported success but there is no binary at ${tmm}`);
    return 1;
  }
  const commit = capture('git', ['log', '-1', '--format=%h %s']);
  const deployed = deployedHash(tmm, service, home);

  let restarted = false;
  if (want === deployed) {
    log('[gateway:update] the gateway was last started with exactly these bytes — NOT restarting (no client is dropped)');
  } else {
    log(deployed === null
      ? '[gateway:update] no activation receipt for these bytes (a first run, a hand-built binary, or a restart that failed) — deploying'
      : '[gateway:update] the binary changed since the gateway was started — deploying');
    const code = await run(tmm, ['gateway', 'restart']);
    if (code !== 0) {
      warn('[gateway:update] gateway restart FAILED — NOTHING was deployed; the gateway still runs whatever it ran before (or nothing). If the service is not installed, this host has not migrated yet: docs/reference/install.md § Switching a dev host to the gateway. Run this again afterwards.');
      return code;
    }
    restarted = true;
    try {
      // The receipt is a fact about the restart, which returned only once our
      // instance answered — so it is written even if the check below then
      // finds the service gone, and a later run reads "these bytes were
      // activated" rather than restarting a service that is failing.
      writeReceipt(tmm, service, home, want, commit);
    } catch (error) {
      warn(`[gateway:update] the restart succeeded but the receipt could not be written (${error.message}) — the next run will restart again`);
    }
  }

  // ONE final confirmation for both paths: success is the gateway answering
  // as ours, read after everything this run did (reviewer P1-A(i) — a restart
  // that was accepted and then died must not report a deployed commit).
  const state = await run(tmm, ['gateway', 'status']);
  if (state !== 0) {
    warn(restarted
      ? '[gateway:update] the restart was accepted, but this machine\'s gateway does not answer now — see the status above. The activation is recorded; fix the service (tmm gateway restart, or docs/reference/install.md) and run this again.'
      : '[gateway:update] nothing needed deploying, but this machine\'s gateway does not answer — see the status above. Nothing was restarted; fix the service (tmm gateway, or the runbook in docs/reference/install.md) and run this again.');
    return state;
  }
  if (commit) log(`[gateway:update] now at ${commit}`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await gatewayUpdate();
