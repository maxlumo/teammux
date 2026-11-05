#!/usr/bin/env node
// A scratch gateway (or any scratch process) that cannot reach the live tmux
// server or the live gateway (board #14). Incident 2026-11-05 08:06: a scratch
// gateway started from an agent's pane inherited TMUX/TMUX_PANE, and the
// server reads $TMUX before TMUX_TMPDIR (src-tauri/src/tmux.rs, the pane's own
// server first), so it drove the LIVE tmux server; its UI listed the live
// sessions. The pane also carries TMM_SOCKET, the live gateway's local socket.
//
// One mechanism: the environment is test-rust.mjs's `isolatedEnv`, the same
// one every Rust test run gets (TMUX, TMUX_PANE, TMUX_SOCKET, TOKEN and every
// TMM_* dropped; TMUX_TMPDIR and the XDG roots under one private dir).
//
//   node scripts/scratch-env.mjs run <dir> -- <command> [args…]
//       creates <dir> and the server's config root at 0700 on every level,
//       starts <command> detached with the isolated env, writes <dir>/pid
//       (stop it with: kill "$(cat <dir>/pid)").
//   node scripts/scratch-env.mjs check <pid>
//       exits 1, naming each one, if the running process kept any name that
//       reaches the live tmux or gateway.
//
// docs/conventions/development.md § "A scratch gateway never reaches the live
// tmux server" holds the rule and its reason.
import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-rust.mjs';

/** Names whose presence points a process at the live tmux server or gateway. */
const EXACT = ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET', 'TOKEN'];

/** Every leaked name in a NUL-separated environment (/proc/<pid>/environ),
 * in order; and TMUX_TMPDIR when it is unset, because tmux then falls back to
 * /tmp/tmux-<uid>, where the live server's socket lives. */
export function leaks(environ) {
  const names = environ.split('\0').filter(Boolean).map((kv) => kv.slice(0, kv.indexOf('=') === -1 ? kv.length : kv.indexOf('=')));
  const out = names.filter((n) => EXACT.includes(n) || n.startsWith('TMM_'));
  if (!names.includes('TMUX_TMPDIR')) out.push("TMUX_TMPDIR (unset: tmux falls back to /tmp, the live server's socket dir)");
  return out;
}

/** Make `p` a directory of ours at 0700, creating it if needed. A path that
 * exists and belongs to someone else (a shared /tmp) is refused, never used. */
function privateDir(p) {
  if (existsSync(p)) {
    const st = statSync(p);
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new Error(`${p} is not your own directory; give a fresh path (e.g. "$(mktemp -d)/gw")`);
    }
  } else {
    mkdirSync(p);
  }
  chmodSync(p, 0o700);
}

/** Start `argv` with the isolated env under `dir`; returns its pid. */
export function runScratch({ dir, argv, env = process.env, spawn = nodeSpawn }) {
  if (!dir) throw new Error('give a scratch dir: scratch-env.mjs run <dir> -- <command…>');
  if (!isAbsolute(dir)) throw new Error(`the scratch dir must be an absolute path: ${dir}`);
  if (!argv.length) throw new Error('give a command after --: scratch-env.mjs run <dir> -- <command…>');
  privateDir(dir);
  const scoped = isolatedEnv(env, dir);
  // The store refuses a state.db under any level others can change, and a
  // `mkdir -m 700 -p` sets only the last one: each level is made ours.
  for (const root of [scoped.XDG_CONFIG_HOME, scoped.XDG_DATA_HOME, scoped.XDG_STATE_HOME]) privateDir(root);
  privateDir(join(scoped.XDG_CONFIG_HOME, 'teammux'));
  const child = spawn(argv[0], argv.slice(1), { env: scoped, detached: true, stdio: 'ignore' });
  child.unref?.();
  writeFileSync(join(dir, 'pid'), `${child.pid}\n`);
  return child.pid;
}

function main(args) {
  const [verb, ...rest] = args;
  if (verb === 'run') {
    const at = rest.indexOf('--');
    const dir = at === -1 ? rest[0] : rest.slice(0, at)[0];
    const argv = at === -1 ? [] : rest.slice(at + 1);
    const pid = runScratch({ dir, argv });
    const cfg = join(dir, 'xdg-config', 'teammux');
    console.log(`[scratch-env] pid ${pid} (also in ${join(dir, 'pid')}); config root ${cfg}; TMUX_TMPDIR=${dir}`);
    console.log(`[scratch-env] check: node scripts/scratch-env.mjs check ${pid}`);
    return 0;
  }
  if (verb === 'check') {
    const pid = rest[0];
    if (!/^\d+$/.test(pid ?? '')) throw new Error('scratch-env.mjs check <pid>');
    const found = leaks(readFileSync(`/proc/${pid}/environ`, 'utf8'));
    if (found.length) {
      console.error(`[scratch-env] pid ${pid} can reach the live tmux or gateway through: ${found.join(', ')}`);
      return 1;
    }
    console.log(`[scratch-env] pid ${pid}: no TMUX, TMUX_PANE, TMUX_SOCKET, TOKEN or TMM_*; TMUX_TMPDIR is set`);
    return 0;
  }
  console.error('usage: scratch-env.mjs run <dir> -- <command…> | check <pid>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`[scratch-env] ${e.message}`);
    process.exitCode = 2;
  }
}
