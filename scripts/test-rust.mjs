#!/usr/bin/env node
// `npm run test:rust` — the Rust suite, SEQUENTIAL and in an ISOLATED tmux
// environment (board #349).
//
// Two incidents on 2026-10-12 killed the developer's default tmux server and
// every session on this host, both from this repository's own tests:
//   05:51  a bare `cargo test --lib` ran the tmux-touching tests in parallel;
//          a private server's `kill-server`, issued through the process-global
//          socket another test had just reset to None, hit the default server.
//   07:12  a negative control on the FIX for 05:51 put that bug back on
//          purpose and ran one test in the developer's real shell ($TMUX set,
//          no TMUX_TMPDIR) — so the deliberately broken kill went to the real
//          server again.
// The Rust side now refuses parallel runs and names its sockets (tmux.rs
// test_support). This wrapper is the other half: whatever a test does, it can
// only reach a tmux server inside a throwaway directory that did not exist
// before the run and is removed after it. The real server's socket is simply
// not where the test process will look:
//   - TMUX and TMUX_PANE are unset, so no test inherits "the pane we are in";
//   - TMUX_TMPDIR is a fresh `mkdtemp`, so the "default" server tmux resolves
//     is an empty one under that dir, created on demand and killed with it.
// Nothing here reaches the developer's tmux at all.
// One layer up (board #407): every TMM_* variable (TMM_SERVER, TMM_TOKEN,
// TMM_PROJECT, TMM_AGENT, TMM_STATE_DB, …) and the bare TOKEN that
// Config::load reads are unset too: a runner whose environment carried
// TMM_SERVER=ws://127.0.0.1:9899 made a starter-identity test read a server
// it was never given (an agent pane carries TMM_PROJECT/TMM_AGENT; whatever
// the caller has, the suite must not inherit it). This removes the
// caller's inherited routing, identity and credential; it is not a network
// sandbox (HOME, XDG_CONFIG_HOME, HOST/PORT and config.toml still resolve), so
// a test that talks to a gateway sets its own endpoint and config on its child.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The cargo command this wrapper runs. `extra` is what the caller added
 * after `npm run test:rust`, in cargo's own grammar: everything before the
 * caller's first `--` goes to cargo (a filter, `--lib`, `-p`), everything
 * after it to the test harness (`--nocapture`, `--exact`, …).
 *
 * The harness has a grammar of its own that decides WHERE our forced flag
 * must go (measured on libtest, 2026-10-12): a bare `--` on the harness side
 * ends option parsing, and everything after it is a test-name FILTER — so
 * `--test-threads=4 -- --test-threads=1` runs 4 threads and filters on the
 * string "--test-threads=1" (reviewer P1 on 6e166901, which had put ours
 * last). Ours therefore goes FIRST among the harness args, where libtest
 * reads options, and any `--test-threads` the caller wrote in the option zone
 * is dropped; the caller's own `--` and what follows it stay as filters. */
export function cargoArgs(extra = []) {
  const at = extra.indexOf('--');
  const forCargo = at === -1 ? extra : extra.slice(0, at);
  const forHarness = at === -1 ? [] : extra.slice(at + 1);
  const stop = forHarness.indexOf('--');
  const options = stop === -1 ? forHarness : forHarness.slice(0, stop);
  const filters = stop === -1 ? [] : forHarness.slice(stop);
  const kept = [];
  for (let i = 0; i < options.length; i += 1) {
    const a = options[i];
    if (a === '--test-threads') { i += 1; continue; }
    if (a.startsWith('--test-threads=')) continue;
    kept.push(a);
  }
  return [
    'test', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features',
    ...forCargo,
    '--', '--test-threads=1', ...kept, ...filters,
  ];
}

/** The environment the cargo process gets: the caller's, minus the two
 * variables that point at a real tmux, every `TMM_*` (the caller's gateway,
 * identity and state) and `TOKEN` (the credential Config::load reads), plus
 * TMUX_TMPDIR = `dir`. */
export function isolatedEnv(base, dir) {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TOKEN;
  for (const key of Object.keys(env)) if (key.startsWith('TMM_')) delete env[key];
  env.TMUX_TMPDIR = dir;
  return env;
}

export function runTestRust({ extra = process.argv.slice(2), spawn = spawnSync, env = process.env, log = console.error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tmm-test-rust-'));
  log(`[test:rust] isolated tmux: TMUX_TMPDIR=${dir} (TMUX/TMUX_PANE/TMM_*/TOKEN unset), --test-threads=1`);
  try {
    const result = spawn('cargo', cargoArgs(extra), { cwd: repoRoot, env: isolatedEnv(env, dir), stdio: 'inherit' });
    if (result.error) {
      log(`[test:rust] cargo: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    // A server a test left under the throwaway dir would outlive the dir
    // (tmux keeps running with its socket unlinked), so each is told to stop
    // BY ITS OWN SOCKET PATH — the only servers this wrapper ever addresses
    // are the ones under the dir it created.
    for (const socket of serverSocketsUnder(dir)) {
      spawn('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every `<dir>/tmux-<uid>/<name>` socket: where tmux puts a server when
 * TMUX_TMPDIR is `dir`. */
export function serverSocketsUnder(dir) {
  const found = [];
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory() || !sub.name.startsWith('tmux-')) continue;
    for (const entry of readdirSync(join(dir, sub.name), { withFileTypes: true })) {
      if (entry.isSocket()) found.push(join(dir, sub.name, entry.name));
    }
  }
  return found;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runTestRust();
