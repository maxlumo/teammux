#!/usr/bin/env node
// `pnpm run test:live:docker` — the ONE place a live check with real agent CLIs runs (board #55).
//
// Owner, 2026-11-06 15:07: "Why did you change the system's configuration during development?
// These are things that are forever forbidden. If you want to test, open a virtual environment in
// Docker; do not test on this machine." That day's live checks on this host relinked
// ~/.local/bin/claude four times (scratch claudes at 08:00, 08:55, 09:11; a managed fork at 09:30)
// and rewrote ~/.codex/config.toml twice (14:00, 14:20) through a scratch codex home's symlink.
//
// This file holds the host side of the rig. Its proof that the host was left alone is a snapshot of
// an ALLOW-LIST of the user's config, credential and link paths taken before and after a run
// (orchestrator 15:15): not "everything minus exclusions", because the user's own CLIs write their
// sessions and history while the rig runs, and those would be false alarms. A missing path is
// recorded as absent; one that cannot be read throws, naming it (#48: unknown is not safe).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** The user's files a managed render links or reads, relative to HOME. ~/.codex's profile layers
 * (`*.config.toml`) and every link in ~/.local/bin are added from the directory itself. */
export const HOST_FILES = ['.codex/config.toml', '.codex/auth.json', '.codex/.env', '.claude/settings.json', '.claude.json', '.config/teammux/config.toml'];

/** What stands at `p`: `sha256:<hex>` for a file, `link → <target>` for a link (never followed),
 * `dir` for a directory, null when absent. Anything that cannot be read is pushed to `bad`. */
function stateOf(p, bad) {
  let st;
  try { st = lstatSync(p); } catch (e) {
    if (e.code === 'ENOENT') return null;
    bad.push(`${p}: ${e.code ?? e.message}`);
    return undefined;
  }
  try {
    if (st.isSymbolicLink()) return `link → ${readlinkSync(p)}`;
    if (st.isDirectory()) return 'dir';
    return `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  } catch (e) {
    bad.push(`${p}: ${e.code ?? e.message}`);
    return undefined;
  }
}

/** Whether `p` is a link; one that cannot be lstat'ed (a listable but unsearchable dir, validator-2
 * on e03f402a) is pushed to `bad`, never taken for "not a link" (#48: unknown is not safe). */
const isLink = (p, bad) => { try { return lstatSync(p).isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') bad.push(`${p}: ${e.code ?? e.message}`); return false; } };

/** The names in `dir` that `keep` accepts; [] when it is absent; pushed to `bad` when unreadable. */
function listed(dir, keep, bad) {
  try { return readdirSync(dir).filter(keep).sort(); } catch (e) {
    if (e.code !== 'ENOENT') bad.push(`${dir}: ${e.code ?? e.message}`);
    return [];
  }
}

/** The allow-list's state under `home`, keyed by absolute path. Throws, naming every path, when any
 * of it cannot be read. */
export function hostSnapshot(home) {
  const bad = [];
  const paths = [
    ...HOST_FILES,
    ...listed(join(home, '.codex'), (n) => n.endsWith('.config.toml'), bad).map((n) => `.codex/${n}`),
    // Every LINK in ~/.local/bin (orchestrator 15:15): a CLI's updater relinks there; the user's
    // own regular files there are theirs to install and change.
    ...listed(join(home, '.local', 'bin'), (n) => isLink(join(home, '.local', 'bin', n), bad), bad).map((n) => `.local/bin/${n}`),
  ];
  const out = {};
  for (const rel of [...new Set(paths)]) {
    const p = join(home, rel);
    out[p] = stateOf(p, bad);
  }
  if (bad.length) throw new Error(`the host's config cannot be read, so it cannot be proven unchanged:\n  ${bad.join('\n  ')}`);
  return out;
}

/** Every difference between two snapshots, one line per path, in path order. */
export function hostChanges(before, after) {
  const out = [];
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = Object.hasOwn(before, p) ? before[p] : null;
    const b = Object.hasOwn(after, p) ? after[p] : null;
    if (a === b) continue;
    if (a === null) out.push(`${p} appeared`);
    else if (b === null) out.push(`${p} was removed`);
    else if (String(a).startsWith('link') || String(b).startsWith('link')) out.push(`${p} changed (${a} is now ${b})`);
    else out.push(`${p} changed`);
  }
  return out;
}

/** The environment names a live check may receive, and nothing else (AC2). The staged codex
 * config names its key by `env_key` (UST_API_KEY on this host), so that value comes from the
 * caller's environment; claude's come with its staged settings.json, or these names. Values are
 * never read by this script. */
export const CREDENTIAL_NAMES = [
  'UST_API_KEY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
];

/** The credential files the CLIs inside the rig need, measured on this host (owner 15:26: copy or
 * map them from this system): codex's provider config (config.toml, its profile layers, and
 * auth.json/.env when present) and claude's settings.json (its env block and apiKeyHelper, which is
 * `printenv <NAME>` here, a command the image has). ~/.claude.json is NOT needed: a managed claude
 * has its own CLAUDE_CONFIG_DIR, and the render writes its onboarding state. Present regular files
 * only; a link is refused, never followed into a mount. */
export function stagedCredentials(home) {
  const want = [
    ['.codex/config.toml', 'codex/config.toml'], ['.codex/auth.json', 'codex/auth.json'], ['.codex/.env', 'codex/.env'],
    ...listed(join(home, '.codex'), (n) => n.endsWith('.config.toml'), []).map((n) => [`.codex/${n}`, `codex/${n}`]),
    ['.claude/settings.json', 'claude/settings.json'],
  ];
  const out = [];
  for (const [rel, dest] of want) {
    const src = join(home, rel);
    let st;
    try { st = lstatSync(src); } catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`${src}: ${e.code ?? e.message}`); }
    if (!st.isFile()) throw new Error(`${src} is not a regular file (a link or a directory); refusing to mount it`);
    out.push({ src, dest });
  }
  return out;
}

/** `docker run` arguments for one live check: `-e NAME` (name only: Docker copies the value from
 * this process's environment) for each allow-listed name that is set, nothing of the host mounted,
 * removed at exit. `missing`: the `need`ed names that are unset or empty. */
export function liveRunArgs({ image, env, need = [], check, stage = [] }) {
  const set = (n) => typeof env[n] === 'string' && env[n] !== '';
  const args = ['run', '--rm', '--init', '--name', `tmm-live-${process.pid}`];
  for (const n of CREDENTIAL_NAMES) if (set(n)) args.push('-e', n);
  // Each staged file read-only under /stage; the entrypoint copies it into the container's HOME.
  for (const { src, dest } of stage) args.push('--mount', `type=bind,src=${src},dst=/stage/${dest},readonly`);
  args.push(image, check);
  return { args, missing: need.filter((n) => !set(n)) };
}

/** What each check needs to run its turns (the in-container script skips a turn without them). */
const NEED = { smoke: [], 'codex-models': [] };

async function main(args) {
  const { spawnSync } = await import('node:child_process');
  const { homedir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const check = args.find((a) => !a.startsWith('-')) ?? 'smoke';
  if (!Object.hasOwn(NEED, check)) { console.error(`[live] unknown check '${check}' (known: ${Object.keys(NEED).join(', ')})`); return 2; }
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const home = homedir();
  const before = hostSnapshot(home);
  console.log(`[live] host snapshot: ${Object.keys(before).length} config, credential and link paths`);
  const image = 'tmm-live:local';
  const built = spawnSync('docker', ['build', '-f', 'docker/validator/Dockerfile', '--target', 'live', '-t', image, '.'], { cwd: repo, stdio: 'inherit' });
  let code = built.status === 0 ? 0 : 1;
  if (code === 0) {
    const stage = stagedCredentials(home);
    console.log(`[live] staged read-only: ${stage.length ? stage.map((s) => s.src.replace(home, '~')).join(', ') : 'none'}`);
    const { args: runArgs, missing } = liveRunArgs({ image, env: process.env, need: NEED[check], check, stage });
    if (missing.length) { console.error(`[live] not set: ${missing.join(', ')}`); code = 2; } else {
      const passed = CREDENTIAL_NAMES.filter((n) => runArgs.includes(n));
      console.log(`[live] credentials passed by name: ${passed.length ? passed.join(', ') : 'none'}`);
      code = spawnSync('docker', runArgs, { stdio: 'inherit' }).status === 0 ? 0 : 1;
    }
  } else console.error('[live] the image did not build');
  const changes = hostChanges(before, hostSnapshot(home));
  if (changes.length) {
    console.error(`[live] FAIL: the host's config changed during the run:\n  ${changes.join('\n  ')}`);
    return 1;
  }
  console.log(`[live] host config unchanged (${Object.keys(before).length} paths)`);
  console.log(code === 0 ? '[live] PASS' : '[live] FAIL');
  return code;
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`[live] ${e.message}`); process.exitCode = 2; });
}
