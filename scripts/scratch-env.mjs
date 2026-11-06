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
//       exits 1, naming each route (or why its environment is unreadable:
//       /proc on Linux, KERN_PROCARGS2 on macOS, #30), unless the process in <dir>/pid has
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
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, UPDATE_SWITCHES } from './test-rust.mjs';

export { UPDATE_SWITCHES };

/** Names whose presence points a process at the live tmux server or gateway. */
const EXACT = ['TMUX', 'TMUX_PANE', 'TMUX_SOCKET', 'TOKEN'];

/** The gateway's default port (src-tauri/src/config.rs): the LIVE gateway's. */
export const LIVE_DEFAULT_PORT = 9899;

/** What in a NUL-separated environment (environOf) routes the
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
  // Board #48: a CLI without its switch may update itself and relink the real ~/.local/bin.
  for (const [name, value] of Object.entries(UPDATE_SWITCHES)) {
    const got = vars.get(name);
    if (got !== value) out.push(`${name} is ${got === undefined ? 'unset' : `'${got}'`}, not ${value} (the CLI may update itself and relink the real ~/.local/bin)`);
  }
  return out;
}

/** Where the user's CLIs are linked from (board #48): the shared bin dir every installer
 * relinks, and kimi's own. Read only, never changed. */
export function linkDirs(home) {
  return [join(home, '.local', 'bin'), join(home, '.kimi-code', 'bin')];
}

/** Every symlink in the user's link dirs with its absolute target ({path: target}), and every
 * dir or entry that could not be read (#48 round 1, #29's rule: "could not look" is never
 * "nothing there"). Only a dir that does not exist (ENOENT) is confirmed empty. */
export function readLinks(home) {
  const links = {};
  const unreadable = [];
  for (const d of linkDirs(home)) {
    let names;
    try { names = readdirSync(d); } catch (e) {
      if (e.code !== 'ENOENT') unreadable.push(`${d} could not be read (${e.code ?? e.message})`);
      continue;
    }
    for (const n of names.sort()) {
      const p = join(d, n);
      try {
        // The raw text, joined to the link's dir with NO normalising (#48 round 2): '..'
        // means something only after the symlinks before it are followed (resolveOnDisk).
        if (lstatSync(p).isSymbolicLink()) { const t = readlinkSync(p); links[p] = isAbsolute(t) ? t : `${d}/${t}`; }
      } catch (e) {
        if (e.code !== 'ENOENT') unreadable.push(`${p} could not be read (${e.code ?? e.message})`); // ENOENT: gone meanwhile
      }
    }
  }
  return { links, unreadable };
}

/** run's snapshot: the links alone. */
export function snapshotLinks(home) {
  return readLinks(home).links;
}

/** Where `p` lands on disk, resolved as the kernel resolves a path (#48 round 2): component
 * by component from `/`, each symlink followed when it is met, so `alias/..` is the parent of
 * alias's TARGET, never of alias. `{path}`, symlink-free; or `{why}` when it cannot be told:
 * any error but ENOENT (EACCES on an unreadable directory, EIO, ...) and more than 40 symlinks
 * (ELOOP). Only a CONFIRMED missing component (ENOENT) keeps the rest as written, normalised,
 * below what exists: a dangling link into a deleted scratch dir is still placed there. */
export function resolveOnDisk(p) {
  const queue = String(p).split('/');
  let cur = '/';
  let hops = 0;
  while (queue.length) {
    const name = queue.shift();
    if (name === '' || name === '.') continue;
    if (name === '..') { cur = dirname(cur); continue; }
    const next = cur === '/' ? `/${name}` : `${cur}/${name}`;
    let st;
    try { st = lstatSync(next); } catch (e) {
      if (e.code === 'ENOENT') return { path: resolve(next, ...queue) };
      return { why: `${next}: ${e.code ?? e.message}` };
    }
    if (!st.isSymbolicLink()) { cur = next; continue; }
    if (++hops > 40) return { why: `${next}: ELOOP (more than 40 symlinks)` };
    let target;
    try { target = readlinkSync(next); } catch (e) { return { why: `${next}: ${e.code ?? e.message}` }; }
    if (isAbsolute(target)) cur = '/';
    queue.unshift(...target.split('/'));
  }
  return { path: cur };
}

/** The user's codex home a managed render links from (codex.rs `codex_user_home`): the caller's
 * CODEX_HOME, else ~/.codex. */
const realCodexHome = (home, env) => (env.CODEX_HOME ? env.CODEX_HOME : join(home, '.codex'));

/** The files of a codex home that `inherit_codex_system_files` links into every managed codex
 * home (shared.rs): config.toml, .env, auth.json and the profile layers `*.config.toml`. */
function codexLinkedNames(codexHome) {
  let profiles = [];
  try { profiles = readdirSync(codexHome).filter((n) => n.endsWith('.config.toml')).sort(); } catch { /* none */ }
  return ['config.toml', '.env', 'auth.json', ...profiles];
}

/** Board #54: fill `dest` with COPIES (0600) of the user's codex files a render links, so the
 * scratch's managed codex homes link into `dest`, inside the scratch dir, and a write in one can
 * never reach the user's file. Measured on main 05a548c7: codex is the only backend whose render
 * links outside the agent home (kiro's link points into it; claude and kimi copy). */
export function copyCodexHome(realHome, dest) {
  privateDir(dest);
  for (const name of codexLinkedNames(realHome)) {
    const from = join(realHome, name);
    let st;
    try { st = statSync(from); } catch { continue; }
    if (!st.isFile()) continue;
    writeFileSync(join(dest, name), readFileSync(from), { mode: 0o600 });
    chmodSync(join(dest, name), 0o600);
  }
}

/** The user's real CLI config files a managed render links or reads from, each with its sha256
 * (null when absent), recorded before a run so check can say what changed (board #54). */
export function realConfigHashes(home, env) {
  const codex = realCodexHome(home, env);
  const kimi = env.KIMI_CODE_HOME ? env.KIMI_CODE_HOME : join(home, '.kimi-code');
  const files = [...codexLinkedNames(codex).map((n) => join(codex, n)), join(home, '.claude', 'settings.json'), join(kimi, 'config.toml')];
  const out = {};
  for (const f of files) {
    try { out[f] = createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { out[f] = null; }
  }
  return out;
}

/** What changed between two `realConfigHashes`, one line per file, in the first's order. */
export function configChanges(before, after) {
  const out = [];
  for (const [f, h] of Object.entries(before)) {
    const now = Object.hasOwn(after, f) ? after[f] : null;
    if (h === now) continue;
    out.push(h === null ? `${f} appeared` : now === null ? `${f} was removed` : `${f} changed`);
  }
  for (const f of Object.keys(after)) if (!Object.hasOwn(before, f) && after[f] !== null) out.push(`${f} appeared`);
  return out;
}

/** Every symlink under `dirs` (not followed into) that resolves outside all of `roots`, as
 * `<link> → <target>` (board #54): a write through it would land in a file the scratch does
 * not own. A link that cannot be resolved is named with why. */
export function outsideLinks(dirs, roots) {
  const real = roots.map((r) => resolveOnDisk(r).path ?? r);
  const inside = (p) => real.some((r) => p === r || p.startsWith(`${r}/`));
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const r = resolveOnDisk(p);
        if (r.why) out.push(`${p} → cannot be resolved (${r.why})`);
        else if (!inside(r.path)) out.push(`${p} → ${r.path}`);
      } else if (st.isDirectory()) walk(p);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

/** The workspaces the scratch gateway's store declares (its projects' paths), read-only. */
function scratchWorkspaces(dir) {
  const db = join(dir, 'xdg-config', 'teammux', 'state.db');
  if (!existsSync(db)) return [];
  const conn = new DatabaseSync(db, { readOnly: true });
  try { return conn.prepare('SELECT path FROM projects').all().map((r) => r.path); } finally { conn.close(); }
}

/** A word a POSIX shell reads back as exactly `s`. */
function shellQuote(s) {
  return /^[A-Za-z0-9_\/.,:@%+=-]+$/u.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** What the guard reports (board #48): the user's links that now point INTO the scratch dir,
 * each with what it pointed at before the run (`before`, run's snapshot; null when there is
 * none) and the one command that repairs it, plus every dir or link it could not read. Empty
 * = nothing escaped, as observed. */
export function escapedLinks(home, dir, before) {
  const { links, unreadable } = readLinks(home);
  const root = resolveOnDisk(resolve(dir));
  if (root.why) return [...unreadable, `the scratch dir ${dir} could not be resolved (${root.why})`];
  const inside = (r) => r.path === root.path || r.path.startsWith(root.path + sep);
  const out = [...unreadable];
  for (const [path, target] of Object.entries(links)) {
    const r = resolveOnDisk(target);
    if (r.why) { out.push(`${path} -> ${target}: its target could not be resolved (${r.why}), so it is not proven outside the scratch dir`); continue; }
    if (!inside(r)) continue;
    const was = before?.[path];
    const wasInside = was !== undefined && (() => { const w = resolveOnDisk(was); return !w.why && inside(w); })();
    const why = before == null ? 'no snapshot from run' : was === undefined ? 'it did not exist before the run' : wasInside ? `it was ${was}` : `it was ${was}: ln -sfn ${shellQuote(was)} ${shellQuote(path)}`;
    out.push(`${path} -> ${target}, inside the scratch dir (${why})`);
  }
  return out;
}

/** The verdict on `tmux show-environment -g` for the private server (#48 round 1): {environ}
 * (NUL-separated), {none} when tmux CONFIRMS there is no server (its own two wordings, measured
 * on this host's tmux), or {why} for anything else, which fails the check. */
export function serverEnvVerdict(r) {
  if (r.error) return { why: `tmux could not be asked: ${r.error.message}` };
  if (r.status === 0) return { environ: r.stdout.split('\n').filter((l) => l && !l.startsWith('-')).join('\0') + '\0' };
  const err = String(r.stderr).trim();
  if (/^no server running on /u.test(err) || /^error connecting to .* \(No such file or directory\)$/u.test(err)) return { none: true };
  return { why: `tmux could not be asked: ${err || `exit ${r.status}`}` };
}

/** The private tmux server's global environment, which every pane and so every managed
 * agent inherits (board #48: run's own env does not reach a pane when another client started
 * the server): `serverEnvVerdict` of one `show-environment -g`. */
function privateServerEnv(dir) {
  return serverEnvVerdict(spawnSync('tmux', ['show-environment', '-g'], { env: isolatedEnv(process.env, dir), encoding: 'utf8' }));
}

/** sysctl(KERN_PROCARGS2) for one pid through the macOS host's own python3
 * (ctypes, no install, no root for our own processes): its raw bytes on
 * stdout, or the errno on stderr and exit 1. */
const PROCARGS_PY = `import ctypes, sys
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[1]))
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0: sys.exit('sysctl: errno %d' % ctypes.get_errno())
buf = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: sys.exit('sysctl: errno %d' % ctypes.get_errno())
sys.stdout.buffer.write(buf.raw[:size.value])`;

/** The environment in macOS's KERN_PROCARGS2 bytes (board #30 round 1; the
 * #27 measurement on clawdbjs, macOS 27.0.1): argc (int32 LE), the exec
 * path, NUL padding, argc argv strings, then the environment, each string
 * NUL-ended, up to an empty string before the kernel's apple strings. Every
 * boundary is the kernel's, so neither an argv word nor a value can forge a
 * variable (reviewer P1-R1 on `ps -E`, which joins them with spaces). What it
 * cannot read is unreadable, never empty (#26's lesson): no environment (a
 * platform binary such as /bin/sleep hides it) or bytes cut short. Returns
 * {environ} (NUL-separated, the /proc form) or {why}. */
export function procargsEnviron(buf) {
  const short = { why: 'the process arguments are cut short' };
  if (buf.length < 4) return short;
  const argc = buf.readInt32LE(0);
  let at = 4;
  const next = () => {
    const end = buf.indexOf(0, at);
    if (end === -1) return null;
    const str = buf.subarray(at, end).toString('utf8');
    at = end + 1;
    return str;
  };
  if (next() === null) return short; // the exec path
  while (at < buf.length && buf[at] === 0) at++;
  for (let i = 0; i < argc; i++) if (next() === null) return short;
  const vars = [];
  while (at < buf.length) {
    const kv = next();
    if (kv === null) return short;
    if (kv === '') break;
    vars.push(kv);
  }
  if (!vars.length) return { why: 'the kernel shows no environment (a platform binary or a process that is not ours hides it)' };
  return { environ: vars.map((kv) => `${kv}\0`).join('') };
}

/** The NUL-separated environment of `pid`, or why it cannot be read: the
 * one platform switch of `check`. Linux reads /proc/<pid>/environ, macOS
 * KERN_PROCARGS2 (procargsEnviron); anything else, or any failure, is {why},
 * never a pass. */
export function environOf(pid, {
  platform = process.platform,
  readFile = (p) => readFileSync(p, 'utf8'),
  run = (cmd, args) => spawnSync(cmd, args),
} = {}) {
  if (platform === 'linux') {
    try { return { environ: readFile(`/proc/${pid}/environ`) }; } catch (e) { return { why: e.message }; }
  }
  if (platform === 'darwin') {
    const r = run('/usr/bin/python3', ['-I', '-c', PROCARGS_PY, pid]);
    if (r.error) return { why: `KERN_PROCARGS2 through python3: ${r.error.message}` };
    if (r.status !== 0) return { why: `KERN_PROCARGS2 for pid ${pid} (gone, or not ours): ${String(r.stderr).trim()}` };
    return procargsEnviron(Buffer.from(r.stdout));
  }
  return { why: `no way to read a process environment on ${platform}` };
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
export function runScratch({ dir, argv, env = process.env, spawn = nodeSpawn, port = null, home = homedir() }) {
  if (!dir) throw new Error('give a scratch dir: scratch-env.mjs run <dir> -- <command…>');
  if (!isAbsolute(dir)) throw new Error(`the scratch dir must be an absolute path: ${dir}`);
  if (!argv.length) throw new Error('give a command after --: scratch-env.mjs run <dir> -- <command…>');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`--port must be a TCP port number, got ${port}`);
  if (port === LIVE_DEFAULT_PORT) throw new Error(`--port ${LIVE_DEFAULT_PORT} is the live gateway's default; pick a free one`);
  privateDir(dir);
  const scoped = isolatedEnv(env, dir);
  // Board #54: the scratch's managed codex homes link a COPY of the user's codex config.
  scoped.CODEX_HOME = join(dir, 'codex-user');
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
  // What the user's CLI links point at before anything runs (board #48), for check.
  const links = join(dir, 'real-links.json');
  if (!existsSync(links)) writeFileSync(links, JSON.stringify(snapshotLinks(home), null, 2), { mode: 0o600 });
  // And what the user's real CLI config files are before anything runs (board #54), for check.
  const configs = join(dir, 'real-config.json');
  if (!existsSync(configs)) writeFileSync(configs, JSON.stringify(realConfigHashes(home, env), null, 2), { mode: 0o600 });
  copyCodexHome(realCodexHome(home, env), scoped.CODEX_HOME);
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
    const env = environOf(pid);
    if (env.why) {
      console.error(`[scratch-env] cannot read the environment of pid ${pid}, so it is not proven private: ${env.why}`);
      return 1;
    }
    const found = leaks(env.environ, dir);
    if (found.length) {
      console.error(`[scratch-env] pid ${pid} is not routed only to ${dir}:\n  ${found.join('\n  ')}`);
      return 1;
    }
    console.log(`[scratch-env] pid ${pid}: TMUX_TMPDIR and the XDG roots are ${dir}'s; no TMUX, TMUX_PANE, TMUX_SOCKET, TOKEN or TMM_* inherited; every no-update switch set`);
    // Board #48: what the panes inherit is the private SERVER's env, not this pid's.
    const server = privateServerEnv(dir);
    if (server.why) {
      console.error(`[scratch-env] the private tmux server's environment is not known, so its panes are not proven safe: ${server.why}`);
      return 1;
    }
    if (server.environ) {
      const missing = leaks(server.environ, dir).filter((l) => Object.keys(UPDATE_SWITCHES).some((k) => l.startsWith(`${k} `)));
      if (missing.length) {
        console.error(`[scratch-env] the private tmux server's panes would start CLIs that may update themselves:\n  ${missing.join('\n  ')}`);
        return 1;
      }
      console.log('[scratch-env] the private tmux server carries every no-update switch to its panes');
    }
    // And whether anything already escaped: the user's own links, never changed by check.
    let before = null;
    try { before = JSON.parse(readFileSync(join(dir, 'real-links.json'), 'utf8')); } catch { /* none */ }
    const escaped = escapedLinks(homedir(), dir, before);
    if (escaped.length) {
      console.error(`[scratch-env] the user's CLI links point into ${dir}; repair them BEFORE deleting it:\n  ${escaped.join('\n  ')}`);
      return 1;
    }
    console.log(`[scratch-env] none of the user's CLI links (${linkDirs(homedir()).join(', ')}) points into ${dir}`);
    // Board #54: the scratch's codex homes link a copy, no scratch home links out, and the user's
    // real CLI config is as it was before the run.
    const codexHome = env.environ.split('\0').find((kv) => kv.startsWith('CODEX_HOME='))?.slice('CODEX_HOME='.length);
    if (codexHome !== join(dir, 'codex-user')) {
      console.error(`[scratch-env] pid ${pid} renders codex homes from ${codexHome ? `'${codexHome}'` : "the user's own ~/.codex (CODEX_HOME unset)"}, not the copy ${join(dir, 'codex-user')}`);
      return 1;
    }
    const workspaces = scratchWorkspaces(dir);
    const out = outsideLinks([dir, ...workspaces.map((w) => join(w, '.tmm', 'agents'))], [dir, ...workspaces]);
    if (out.length) {
      console.error(`[scratch-env] a scratch home links outside the scratch (a write through it lands in a file the scratch does not own):\n  ${out.join('\n  ')}`);
      return 1;
    }
    let configsBefore = null;
    try { configsBefore = JSON.parse(readFileSync(join(dir, 'real-config.json'), 'utf8')); } catch { /* none */ }
    if (!configsBefore) {
      console.error(`[scratch-env] ${join(dir, 'real-config.json')} is missing, so the user's real CLI config cannot be compared with its state before the run`);
      return 1;
    }
    const changed = configChanges(configsBefore, realConfigHashes(homedir(), process.env));
    if (changed.length) {
      console.error(`[scratch-env] the user's real CLI config changed during this run; restore it from a copy taken before:\n  ${changed.join('\n  ')}`);
      return 1;
    }
    console.log(`[scratch-env] no scratch home links outside ${dir}${workspaces.length ? ` or its workspaces` : ''}, and the user's real CLI config is unchanged (${Object.keys(configsBefore).length} files)`);
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
