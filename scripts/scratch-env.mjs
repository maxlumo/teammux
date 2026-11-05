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
//   node scripts/scratch-env.mjs run <dir> [--port <p>] -- <command> [args…]
//       creates <dir> and the server's config root at 0700 on every level,
//       with --port writes its config.toml (127.0.0.1, that port, a random
//       token) BEFORE the launch, starts <command> detached with the isolated
//       env, writes <dir>/pid (stop it with: kill "$(cat <dir>/pid)").
//   node scripts/scratch-env.mjs check <dir> [--gateway]
//       exits 1, naming each route, unless the process in <dir>/pid has
//       TMUX_TMPDIR and the XDG roots exactly under <dir> and kept no
//       live-pointing name. --gateway also plants a marker session on the
//       private tmux server and asks the gateway's own list_sessions: it must
//       list exactly the private server's sessions, the marker included.
// Scope: INHERITED ROUTING to the live tmux server and gateway. isolatedEnv
// keeps HOME and the network, so this is not a sandbox; scripts/isolated.mjs is.
//
// docs/conventions/development.md § "A scratch gateway never reaches the live
// tmux server" holds the rule and its reason.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-rust.mjs';

/** Names whose presence points a process at the live tmux server or gateway. */
const EXACT = ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET', 'TOKEN'];

/** The gateway's default port (src-tauri/src/config.rs): the LIVE gateway's. */
export const LIVE_DEFAULT_PORT = 9899;

/** What in a NUL-separated environment (/proc/<pid>/environ) routes the
 * process anywhere but the scratch `dir` (#14 review P1-R1: a NAMED variable
 * proves nothing, its VALUE must be the private root): every live-pointing
 * name that survived, then TMUX_TMPDIR unless it is exactly `dir` (tmux treats
 * an empty one as unset and falls back to /tmp, the live socket root), then
 * each XDG root unless it is exactly the one isolatedEnv puts under `dir` (the
 * config root holds state.db and the gateway's own socket). Empty = private. */
export function leaks(environ, dir) {
  const vars = new Map();
  for (const kv of environ.split('\0').filter(Boolean)) {
    const at = kv.indexOf('=');
    vars.set(at === -1 ? kv : kv.slice(0, at), at === -1 ? '' : kv.slice(at + 1));
  }
  const out = [...vars.keys()].filter((n) => EXACT.includes(n) || n.startsWith('TMM_'));
  const want = isolatedEnv({}, dir);
  for (const name of ['TMUX_TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const got = vars.get(name);
    if (got === want[name]) continue;
    const fallback = name === 'TMUX_TMPDIR' && !got ? " (tmux falls back to /tmp, the live server's socket dir)" : '';
    out.push(`${name} is ${got === undefined ? 'unset' : `'${got}'`}${fallback}, not ${want[name]}`);
  }
  return out;
}

/** Why `dir` cannot be a scratch root, read only (a check never changes
 * what it checks): it must be a non-empty absolute path, not the shared /tmp,
 * an existing directory of ours that nobody else can reach. Empty = fine. */
export function rootProblems(dir) {
  if (!dir || !isAbsolute(dir)) return ['the scratch root must be a non-empty absolute path'];
  if (resolve(dir) === resolve(tmpdir()) || resolve(dir) === '/tmp') return [`${dir} is the shared tmux socket root, never a scratch root`];
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const st = statSync(dir);
  const out = [];
  if (!st.isDirectory()) out.push(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) out.push(`${dir} is not owned by you`);
  if (st.mode & 0o077) out.push(`${dir} is mode ${(st.mode & 0o777).toString(8)}; others can reach it (want 700)`);
  return out;
}

/** The session `check` plants on the private tmux server: a positive marker
 * the gateway must report, so an empty or live answer cannot pass. */
export const MARKER = 'scratch-env-marker';

/** Whether the gateway's `list_sessions` answer proves it sees ONLY the
 * private tmux server: it must include the marker, which must really be on
 * the private server, and name nothing the private server lacks. null = it
 * does; otherwise why not. */
export function routeVerdict(gatewaySessions, privateSessions) {
  if (!privateSessions.includes(MARKER)) return `the private tmux server has no ${MARKER} session, so the answer proves nothing`;
  const foreign = gatewaySessions.filter((n) => !privateSessions.includes(n));
  if (!gatewaySessions.includes(MARKER)) return `the gateway does not list ${MARKER}; it lists: ${gatewaySessions.join(', ') || '(nothing)'}`;
  if (foreign.length) return `the gateway lists sessions the private server does not have: ${foreign.join(', ')}`;
  return null;
}

/** The private tmux server's session names, read with ONLY its socket dir
 * (TMUX/TMUX_PANE/TMUX_SOCKET removed, so this pane's server is never asked);
 * the marker is created first when absent. */
function privateSessions(dir) {
  const env = isolatedEnv(process.env, dir);
  const tmux = (...args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  if (tmux('has-session', '-t', `=${MARKER}`).status !== 0) tmux('new-session', '-d', '-s', MARKER);
  const ls = tmux('list-sessions', '-F', '#{session_name}');
  return ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
}

/** The gateway's own `list_sessions`, over its WebSocket with the scratch
 * config's port and token: the sessions the process's tmux actually has. */
async function gatewaySessions(dir) {
  const toml = readFileSync(join(dir, 'xdg-config', 'teammux', 'config.toml'), 'utf8');
  const port = /^port\s*=\s*(\d+)/mu.exec(toml)?.[1];
  const token = /^token\s*=\s*"([^"]*)"/mu.exec(toml)?.[1];
  if (!port || !token) throw new Error('the scratch config has no port or token; start it with run --port');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const replies = [];
  let wake = () => {};
  ws.onmessage = (e) => { replies.push(JSON.parse(String(e.data))); wake(); };
  const next = (id) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error(`no reply ${id} from 127.0.0.1:${port} in 5 s`)), 5000);
    const look = () => { const r = replies.find((m) => m.id === id); if (r) { clearTimeout(timer); ok(r); } else wake = look; };
    look();
  });
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`cannot reach 127.0.0.1:${port}`)); });
  ws.send(JSON.stringify({ id: 1, method: 'auth', params: { token } }));
  const auth = await next(1);
  if (!auth.result?.authenticated) { ws.close(); throw new Error('the scratch gateway refused its own token'); }
  ws.send(JSON.stringify({ id: 2, method: 'list_sessions', params: {} }));
  const reply = await next(2);
  ws.close();
  const list = reply.result?.sessions ?? reply.result ?? [];
  return list.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean);
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
export function runScratch({ dir, argv, env = process.env, spawn = nodeSpawn, port = null }) {
  if (!dir) throw new Error('give a scratch dir: scratch-env.mjs run <dir> -- <command…>');
  if (!isAbsolute(dir)) throw new Error(`the scratch dir must be an absolute path: ${dir}`);
  if (!argv.length) throw new Error('give a command after --: scratch-env.mjs run <dir> -- <command…>');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`--port must be a TCP port number, got ${port}`);
  if (port === LIVE_DEFAULT_PORT) throw new Error(`--port ${LIVE_DEFAULT_PORT} is the live gateway's default; pick a free one`);
  privateDir(dir);
  const scoped = isolatedEnv(env, dir);
  // The store refuses a state.db under any level others can change, and a
  // `mkdir -m 700 -p` sets only the last one: each level is made ours.
  for (const root of [scoped.XDG_CONFIG_HOME, scoped.XDG_DATA_HOME, scoped.XDG_STATE_HOME]) privateDir(root);
  const configRoot = join(scoped.XDG_CONFIG_HOME, 'teammux');
  privateDir(configRoot);
  // A gateway's config exists BEFORE its first launch (#14 review): without
  // it the server binds the default port, the live gateway's.
  if (port !== null) {
    const toml = join(configRoot, 'config.toml');
    writeFileSync(toml, `host = "127.0.0.1"\nport = ${port}\ntoken = "${randomBytes(16).toString('hex')}"\n`, { mode: 0o600 });
    chmodSync(toml, 0o600);
  }
  const child = spawn(argv[0], argv.slice(1), { env: scoped, detached: true, stdio: 'ignore' });
  child.unref?.();
  writeFileSync(join(dir, 'pid'), `${child.pid}\n`);
  return child.pid;
}

async function main(args) {
  const [verb, ...rest] = args;
  if (verb === 'run') {
    const at = rest.indexOf('--');
    const head = at === -1 ? rest : rest.slice(0, at);
    const argv = at === -1 ? [] : rest.slice(at + 1);
    const p = head.indexOf('--port');
    const port = p === -1 ? null : Number(head[p + 1]);
    const dir = head.filter((_, i) => p === -1 || (i !== p && i !== p + 1))[0];
    const pid = runScratch({ dir, argv, port });
    console.log(`[scratch-env] pid ${pid} (in ${join(dir, 'pid')}); config root ${join(dir, 'xdg-config', 'teammux')}; TMUX_TMPDIR=${dir}`);
    console.log(`[scratch-env] check: node scripts/scratch-env.mjs check ${dir}`);
    return 0;
  }
  if (verb === 'check') {
    const dir = rest[0];
    const bad = rootProblems(dir);
    if (bad.length) {
      console.error(`[scratch-env] not a private scratch root: ${bad.join('; ')}`);
      return 1;
    }
    const pid = readFileSync(join(dir, 'pid'), 'utf8').trim();
    if (!/^\d+$/.test(pid)) throw new Error(`${join(dir, 'pid')} holds no pid`);
    const found = leaks(readFileSync(`/proc/${pid}/environ`, 'utf8'), dir);
    if (found.length) {
      console.error(`[scratch-env] pid ${pid} is not routed only to ${dir}:\n  ${found.join('\n  ')}`);
      return 1;
    }
    console.log(`[scratch-env] pid ${pid}: TMUX_TMPDIR and the XDG roots are ${dir}'s; no TMUX, TMUX_PANE, TMUX_SOCKET, TOKEN or TMM_* inherited`);
    // The effective route (#14 review): what the gateway's tmux really has.
    if (rest.includes('--gateway')) {
      const mine = privateSessions(dir);
      const theirs = await gatewaySessions(dir);
      const why = routeVerdict(theirs, mine);
      if (why) {
        console.error(`[scratch-env] the gateway does not see only its private tmux server: ${why}`);
        return 1;
      }
      console.log(`[scratch-env] gateway list_sessions = [${theirs.join(', ')}], exactly the private server's, ${MARKER} included`);
    }
    return 0;
  }
  console.error('usage: scratch-env.mjs run <dir> [--port <p>] -- <command…> | check <dir> [--gateway]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[scratch-env] ${e.message}`);
    process.exitCode = 2;
  });
}
