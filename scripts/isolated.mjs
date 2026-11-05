#!/usr/bin/env node
// `node scripts/isolated.mjs -- <command…>` — run a test command where it
// CANNOT reach this host's live gateway (board #503).
//
// The incident (orchestrator, 2026-11-02, read from the live journal): every
// full gate left 3 loopback "Auth failed … invalid proof" lines on the LIVE
// gateway, bursts at 07:11 … 13:17. A test reached the real service. Two such
// runs within a minute spend 6 of the 5-attempt lockout on 127.0.0.1.
//
// Two interim recipes failed and are why this file looks the way it does:
//   - `unshare --map-current-user -n` (13:25): inside it, every root-owned
//     ancestor (/, /tmp, /local) stats as the overflow uid 65534, so
//     `safe_fs::trusted` refuses every state.db, and `ip link set lo up` is
//     not permitted (kiro, measured 13:26). A user namespace cannot show real
//     root, and the trust check is NOT relaxed for tests.
//   - `docker run --network none` with the whole real HOME mounted (13:26):
//     TCP is gone, but the live gateway's Unix socket
//     (<config>/sock/gateway.sock), its config, token, state.db and every
//     agent home are reachable by PATH, no network needed (reviewer, 13:29).
//
// So the boundary is a container with NO network AND none of the real HOME:
//   - `--network none`: only a loopback that holds nothing;
//   - the host's system dirs and toolchain READ-ONLY (real root ownership, so
//     the trust check sees what it sees on the host);
//   - writable: only the worktree under test (its target dir and
//     node_modules live there), its own git dir, and a private /tmp;
//   - HOME, XDG_*, CARGO_HOME and TMPDIR inside the private /tmp; no TMM_*,
//     TOKEN or TMUX* variable crosses (the container starts from an empty env);
//   - a SELF-CHECK runs first and refuses to start the command if the real
//     HOME, the real config dir or its gateway socket is visible, if any
//     forbidden variable is set, or if 127.0.0.1:9899 or an outside address
//     answers. It probes TCP only; it never opens the live socket.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const IMAGE = 'tmm-hostfs:empty';

/** The host paths the run must never see: the real HOME (by its name and by
 * what it resolves to), the app's real config dir and its gateway socket.
 * A HOME that is an ANCESTOR of the worktree exists inside as an empty
 * directory docker made for the mount, so for it the check names what a
 * real HOME holds instead (its config, data, credentials and toolchain). */
export function forbiddenPaths({ home = homedir(), env = process.env, worktree = '' } = {}) {
  const homes = new Set([home]);
  try { homes.add(realpathSync(home)); } catch { /* absent: nothing to add */ }
  const paths = new Set();
  for (const h of homes) {
    if (worktree === h || worktree.startsWith(`${h}/`)) {
      for (const child of ['.config', '.local', '.ssh', '.kiro', '.cargo', '.rustup', '.aws']) paths.add(join(h, child));
    } else {
      paths.add(h);
    }
  }
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  // Both names of the config root: a fresh install uses teammux, one from
  // before the rename keeps tmux-mobile (config::config_dir), as this host's does.
  for (const root of ['teammux', 'tmux-mobile']) {
    paths.add(join(xdg, root));
    paths.add(join(xdg, root, 'sock', 'gateway.sock'));
  }
  return [...paths];
}

/** The script the container runs: the self-check, then the command. In
 * order: the host paths that must be absent, the variables that must not
 * cross, every ancestor of the worktree holding nothing but the path down
 * (`chain`: [dir, allowed names]), the private HOME's setup (each step that
 * fails refuses), and only then the TCP probes, which therefore never run on
 * a host where an earlier check refuses. */
export function selfCheck(forbidden, chain = [], node = SYSTEM_NODE) {
  const lines = [
    'set -u',
    'fail() { echo "[isolated] REFUSED: $1" >&2; exit 97; }',
    ...forbidden.map((p) => `[ -e ${sq(p)} ] && fail ${sq(`a host path is visible: ${p}`)}`),
    'env | grep -E "^(TMM_|TOKEN=|TMUX|GIT_DIR=|GIT_WORK_TREE=|GIT_COMMON_DIR=|GIT_INDEX_FILE=)" >/dev/null && fail "a forbidden variable is set"',
    // Along the worktree's path, nothing of the host but the way down: a
    // checkout's .tmm/ (agent homes, uploads, teams) or another agent's
    // worktree beside this one is never visible.
    // Board #503 P2 (reviewer, on d16b9ca0): a structured walk, not `ls`
    // word-splitting, and a directory that cannot be listed refuses.
    'shopt -s nullglob dotglob',
    ...chain.map(([dir, allowed]) => `{ [ -r ${sq(dir)} ] && [ -x ${sq(dir)} ]; } || fail ${sq(`${dir} cannot be listed`)}; for p in ${sq(dir)}/*; do e="\${p##*/}"; case "$e" in ${allowed.map(sq).join('|')}) ;; *) fail ${sq(`more than the way down is visible in ${dir}: `)}"$e";; esac; done`),
    'mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$CARGO_HOME" || fail "the private HOME could not be made"',
    // An empty HOME makes zsh (a tmux pane's shell here) open its new-user
    // wizard, which swallows the first typed command (measured, 2026-11-02:
    // a_session_is_adopted_at_the_directory_it_was_made_in timed out on it).
    ': > "$HOME/.zshrc" || fail "the private .zshrc could not be written"',
    // A node outside the system mounts (board #9): only node, npm and npx
    // of its read-only prefix go on PATH, never the prefix's other globals.
    ...(node.links ? [`mkdir -p ${NODE_BIN} || fail "the node links could not be made"`,
      ...['node', 'npm', 'npx'].map((b) => `ln -sfn ${sq(`${NODE_AT}/bin/${b}`)} ${NODE_BIN}/${b} || fail ${sq(`the node link ${b} could not be made`)}`)] : []),
    'for d in bin registry git; do if [ -e "/opt/cargo/$d" ]; then ln -sfn "/opt/cargo/$d" "$CARGO_HOME/$d" || fail "the toolchain link $d could not be made"; fi; done',
    '(exec 3<>/dev/tcp/127.0.0.1/9899) 2>/dev/null && fail "127.0.0.1:9899 answers"',
    '(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && fail "an outside address answers"',
    'echo "[isolated] self-check passed: no network, no host HOME, no live socket" >&2',
    'export ISOLATED_RUNNER=1',
    ...withTripwire(node.bin),
  ];
  return lines.join('\n');
}

/** The tripwire around the command (`"$@"`): its start, the command, and
 * the verdict. Needs `fail` defined; exported so its behaviour rows can run
 * it alone on a test port (`TRIPWIRE_PORT`, `TRIPWIRE_BASE`). */
export function withTripwire(nodeBin = SYSTEM_NODE.bin) {
  return [
    // The TRIPWIRE (board #503): 127.0.0.1:9899, the default port a live
    // gateway holds on a real host, is held here by a listener that reads
    // NO peer bytes (reviewer P1-B on 586c6fbb): on accept it counts, stamps
    // the time, writes the record and destroys the socket, synchronously,
    // before anything else (P1-A), so a connection that sends nothing, half
    // a head, or arrives at the very end is still counted. The end is
    // cooperative and bounded: the shell asks it to stop (SIGUSR1), it
    // drains what is pending, writes a FINAL record marked ok and exits 0.
    // Anything else fails closed: a listener that cannot start, died, did
    // not stop, ended non-zero, a record that cannot be read, or one with no
    // final marker is 97; any counted connection is 98. Only the count and
    // the times are printed.
    'tw=${TRIPWIRE_BASE:-/tmp/.isolated-tripwire}; rm -f "$tw.count" "$tw.ready"',
    `${nodeBin} -e ${sq(TRIPWIRE)} "$tw" "\${TRIPWIRE_PORT:-9899}" & twpid=$!`,
    'for _ in $(seq 100); do [ -e "$tw.ready" ] && break; kill -0 "$twpid" 2>/dev/null || break; sleep 0.05; done',
    '[ -e "$tw.ready" ] || fail "the default-port tripwire could not start"',
    // NOT exec: bash stays PID 1 and reaps every orphan a killed process
    // tree leaves (docker's --init cannot be used, its /sbin/docker-init
    // mount lands on the read-only /usr/sbin). With the command as PID 1 the
    // orphans stayed zombies and two process-tree tests read them as alive
    // (measured, 2026-11-02).
    '"$@"',
    'rc=$?',
    'trip() { echo "[isolated] TRIPWIRE: $1 connection(s) to the default port 127.0.0.1:${TRIPWIRE_PORT:-9899} during the run (a test dials where a live gateway listens), at: $2" >&2; exit 98; }',
    'record() { [ -r "$tw.count" ] || return 1; IFS=" " read -r tw_ok tw_n tw_times < "$tw.count" || return 1; }',
    'alive=1; kill -0 "$twpid" 2>/dev/null || alive=0',
    '[ "$alive" = 1 ] && kill -USR1 "$twpid" 2>/dev/null',
    'for _ in $(seq 100); do kill -0 "$twpid" 2>/dev/null || break; sleep 0.05; done',
    'if kill -0 "$twpid" 2>/dev/null; then kill -9 "$twpid" 2>/dev/null; wait "$twpid" 2>/dev/null; record && [ "${tw_n:-0}" -gt 0 ] && trip "$tw_n" "$tw_times"; fail "the tripwire did not stop"; fi',
    'wait "$twpid"; twrc=$?',
    'record || fail "the tripwire record cannot be read"',
    '[ "${tw_n:-0}" -gt 0 ] 2>/dev/null && trip "$tw_n" "$tw_times"',
    '[ "$alive" = 1 ] || fail "the tripwire died during the run"',
    '[ "$twrc" = 0 ] || fail "the tripwire ended with status $twrc"',
    '[ "$tw_ok" = ok ] || fail "the tripwire record has no final marker"',
    'exit $rc',
  ];
}

/** The tripwire's listener (reviewer P1-A/P1-B on 586c6fbb): it never reads
 * a peer byte. Each accept, synchronously and first: count, time, rewrite
 * the record `<ok|run> <count> <times>`, destroy the socket. SIGUSR1: stop
 * accepting, let what is pending drain, write the final `ok` record, exit 0.
 * A write that fails exits 3; a listen error exits 2. */
const TRIPWIRE = [
  'const net = require("net"), fs = require("fs"), base = process.argv[1], port = Number(process.argv[2]);',
  'let n = 0; const times = [];',
  'const write = (mark) => { try { fs.writeFileSync(base + ".count", `${mark} ${n} ${times.join(",") || "-"}\\n`); } catch { process.exit(3); } };',
  'const srv = new net.Server({ pauseOnConnect: true }, (s) => { n += 1; times.push(new Date().toISOString()); write("run"); s.destroy(); });',
  'srv.on("error", () => process.exit(2));',
  'srv.listen(port, "127.0.0.1", () => { write("run"); try { fs.writeFileSync(base + ".ready", ""); } catch { process.exit(3); } });',
  'process.on("SIGUSR1", () => setTimeout(() => srv.close(() => { write("ok"); process.exit(0); }), 200));',
].join('\n');

function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The `docker run` argv for `command` on `worktree`. Pure, for the test. */
export function dockerArgs({ worktree, gitDirs, uid, gid, home = homedir(), forbidden, chain = [], command, node = SYSTEM_NODE }) {
  const ro = (p, at = p) => ['-v', `${p}:${at}:ro`];
  const rw = (p) => ['-v', `${p}:${p}`];
  const args = [
    'run', '--rm', '--network', 'none', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,exec,mode=1777,size=16g',
    ...['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc'].flatMap((p) => ro(p)),
    ...ro(join(home, '.cargo', 'bin'), '/opt/cargo/bin'),
    ...ro(join(home, '.cargo', 'registry'), '/opt/cargo/registry'),
    ...ro(join(home, '.rustup'), '/opt/rustup'),
    ...(node.prefix ? ro(node.prefix, NODE_AT) : []),
  ];
  // The repository's shared git dir read-only, this worktree's own git dir
  // (index, HEAD) writable on top of it, and the worktree itself.
  if (gitDirs.common) args.push(...ro(gitDirs.common));
  if (gitDirs.own && gitDirs.own !== gitDirs.common) args.push(...rw(gitDirs.own));
  args.push(...rw(worktree));
  const env = {
    HOME: '/tmp/home', XDG_CONFIG_HOME: '/tmp/home/.config', XDG_DATA_HOME: '/tmp/home/.local/share',
    XDG_STATE_HOME: '/tmp/home/.local/state', TMPDIR: '/tmp', CARGO_HOME: '/tmp/cargo-home',
    RUSTUP_HOME: '/opt/rustup', PATH: `${node.links ? `${NODE_BIN}:` : ''}/tmp/cargo-home/bin:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push('-w', worktree, IMAGE, '/usr/bin/bash', '-c', selfCheck(forbidden, chain, node), 'isolated', ...command);
  return args;
}

/** Why the runner refuses to start, before any docker call. */
export class Refusal extends Error {}

/** The system dirs every run mounts read-only at their own path. */
const SYSTEM_DIRS = ['/usr', '/lib', '/lib64', '/bin', '/sbin'];
const SYSTEM_NODE = { bin: '/usr/bin/node', prefix: null, links: false };
/** Where a node outside the system dirs is mounted: a neutral path, never
 * its real one, because a real path under HOME (~/.local) is exactly what
 * the self-check refuses to see (validator, #8, 2026-11-05). */
const NODE_AT = '/opt/node';
const NODE_BIN = '/tmp/node-bin';

/** The node the container runs (board #9), from `execPath`, the RUNNING
 * node's real path. Under a system dir it is already visible at that path:
 * nothing is added. Elsewhere its install prefix (`<prefix>/bin/node`) is
 * mounted read-only at /opt/node, and only node, npm and npx are linked onto
 * PATH. A prefix that would expose more than node refuses: one that is `/`,
 * HOME or holds it, holds the worktree, the main checkout or a forbidden
 * host path, or a node that is not `<prefix>/bin/node`. Pure. */
export function nodeRuntime({ execPath, home, worktree, main, forbidden }) {
  const holds = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
  if (SYSTEM_DIRS.some((d) => holds(d, execPath))) return { bin: execPath, prefix: null, links: false };
  const fix = 'install node under /usr (for example /usr/bin/node), or as its own <prefix>/bin/node outside HOME\'s top level, the worktree and the config dir, then run the runner with that node';
  const refuse = (why) => { throw new Refusal(`node ${execPath} cannot be mounted: ${why}; ${fix}`); };
  if (basename(dirname(execPath)) !== 'bin') refuse('it is not <prefix>/bin/node');
  const prefix = dirname(dirname(execPath));
  if (prefix === '/' || prefix === dirname(prefix)) refuse('its prefix is /');
  if (holds(prefix, home)) refuse(`its prefix ${prefix} is HOME or holds it`);
  if (holds(prefix, worktree)) refuse(`its prefix ${prefix} holds the worktree`);
  if (main && holds(prefix, main)) refuse(`its prefix ${prefix} holds the main checkout`);
  const hit = forbidden.find((f) => holds(prefix, f));
  if (hit) refuse(`its prefix ${prefix} holds a forbidden host path ${hit} (the config dir or a credential dir)`);
  return { bin: `${NODE_AT}/bin/node`, prefix, links: true };
}

const GIT_OVERRIDES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

/** The target the runner may bind, checked BEFORE any docker or image call
 * (reviewer P1-A on 74738836): it must be a LINKED git worktree of a
 * repository, never the main or launch checkout (own git dir == common dir),
 * never HOME or a parent of HOME or of the main checkout, never a tree that
 * holds `.tmm/` (agent homes, uploads, teams), and no inherited GIT_* may
 * redirect which repository is bound. Returns the paths, all real. */
export function target({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  for (const k of GIT_OVERRIDES) if (env[k]) throw new Refusal(`${k} is set; unset it, the runner binds only the worktree it starts in`);
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
  const g = (...a) => {
    const r = spawnSync('git', a, { cwd, env: clean, encoding: 'utf8' });
    if (r.status !== 0) throw new Refusal(`not inside a git worktree (${r.stderr.trim()})`);
    return r.stdout.trim();
  };
  const worktree = realpathSync(g('rev-parse', '--show-toplevel'));
  const common = realpathSync(resolve(cwd, g('rev-parse', '--git-common-dir')));
  const own = realpathSync(resolve(cwd, g('rev-parse', '--git-dir')));
  if (own === common) throw new Refusal(`${worktree} is a main checkout (its git dir is the repository's own); run from a linked worktree (git worktree add)`);
  if (basename(common) !== '.git') throw new Refusal(`the repository's git dir ${common} is not <checkout>/.git; refusing an unknown layout`);
  const main = dirname(common);
  let h = home;
  try { h = realpathSync(home); } catch { /* compare the name as given */ }
  const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}/`);
  if (within(h, worktree)) throw new Refusal(`${worktree} is HOME or holds it`);
  if (within(main, worktree)) throw new Refusal(`${worktree} holds the main checkout ${main}`);
  if (existsSync(join(worktree, '.tmm'))) throw new Refusal(`${worktree} holds .tmm/ (agent homes, uploads, teams): never bound into a run`);
  return { worktree, common, own, main };
}

/** The ancestors of `worktree` and the names each may show inside the
 * container: only the next component down, plus `.git` in the main
 * checkout (the shared git dir is mounted there). Nothing else of the host
 * along the path, not the checkout's `.tmm/`, not another worktree. */
export function ancestry(worktree, main) {
  const out = [];
  let child = worktree;
  for (let dir = dirname(worktree); ; dir = dirname(dir)) {
    const allowed = [basename(child)];
    if (dir === main) allowed.push('.git');
    out.push([dir, allowed]);
    if (dir === '/' || dir === dirname(dir)) break;
    child = dir;
  }
  // `/` itself holds the system mounts; it is checked by what must be absent.
  return out.filter(([dir]) => dir !== '/');
}

/** The empty image the container starts from (`docker import` of an empty
 * tar): everything it runs comes from the read-only host mounts. */
function ensureImage() {
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0) return;
  const r = spawnSync('bash', ['-c', `tar cf - --files-from /dev/null | docker import - ${IMAGE}`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not create ${IMAGE}`);
}

/** The npm install processes running in `worktree` right now: an `npm` or
 * `npm-cli.js` process whose argv names `ci`, `install`, `i` or `add` and
 * whose cwd is the worktree. Two argv shapes, both measured with npm 10.9.9
 * (2026-11-04): at startup `node …/npm-cli.js ci` (or `npm ci`), one element
 * per word; once loaded, npm sets `process.title` to its positional args
 * (`lib/npm.js`: `['npm', ...remain].join(' ')`), so /proc shows ONE element,
 * `npm ci`. npm keeps that title while it runs the root scripts AFTER it has
 * written `node_modules/.package-lock.json`, which is why this scan is needed
 * beside the marker. Only a single element that starts with the word `npm`
 * is split, so a shell string like `sh -c "npm ci"` (three elements) is not
 * matched. Read from /proc; a process that ends meanwhile, or one this user
 * cannot read, is skipped; the raw cmdline is never printed. */
export function npmInstallsIn(worktree, proc = '/proc') {
  const found = [];
  let pids = [];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return found; }
  for (const pid of pids) {
    let cwd, argv;
    try {
      cwd = readlinkSync(join(proc, pid, 'cwd'));
      argv = readFileSync(join(proc, pid, 'cmdline'), 'latin1').split('\0').filter(Boolean);
    } catch { continue; }
    if (cwd !== worktree) continue;
    const words = argv.length === 1 && /^npm /.test(argv[0]) ? argv[0].split(' ').filter(Boolean) : argv;
    const npm = words.findIndex((a) => /(^|\/)npm(-cli\.js)?$/.test(a));
    if (npm !== -1 && words.slice(npm + 1).some((a) => ['ci', 'install', 'i', 'add'].includes(a))) found.push(Number(pid));
  }
  return found;
}

/** Why the worktree's npm install is not complete, or null (board #514).
 * A start-time preflight, NOT mutual exclusion for the whole run: an install
 * that starts after the scan, or one this user cannot read in /proc, is not
 * seen, so `npm ci` still runs alone and the test run starts after it exits.
 * Refused: an `npm ci`/`install` still running in the worktree (npm writes
 * `node_modules/.package-lock.json` after every package, then still runs the
 * root scripts, and `npm ci` first removes node_modules, so a marker can exist
 * while an install is running); a marker that is missing or not a regular
 * file; a marker older than `package-lock.json` (a conservative staleness
 * test, not proof the contents match); and a `package-lock.json` that cannot
 * be stat'ed for any reason but absence. The marker is not proof npm exited
 * successfully. A worktree with no package.json has nothing to install. One
 * rule for every command: this is a workspace policy with a named fix, not a
 * guess at which command needs node_modules (`test:rust` does not). A test
 * run on a half-written node_modules gave a partial red run (validator,
 * #511: 2978 tests, 20 fails, "Cannot find package …/jsdom"). */
export function installRefusal({ worktree, installs = npmInstallsIn }) {
  if (!existsSync(join(worktree, 'package.json'))) return null;
  const fix = `run \`npm ci\` alone in ${worktree}, wait for it to exit, then retry`;
  const running = installs(worktree);
  if (running.length) return `an npm install is still running in ${worktree} (pid ${running.join(', ')}); wait for it to exit, then retry`;
  const marker = join(worktree, 'node_modules', '.package-lock.json');
  let m;
  try { m = statSync(marker); } catch { return `node_modules is missing or its install did not finish (no node_modules/.package-lock.json); ${fix}`; }
  if (!m.isFile()) return `node_modules/.package-lock.json is not a regular file; ${fix}`;
  let lock;
  try { lock = statSync(join(worktree, 'package-lock.json')); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return `package-lock.json cannot be read (${e?.code ?? 'error'}), so the install cannot be judged; fix it, then retry`;
  }
  if (m.mtimeMs < lock.mtimeMs) return `node_modules is older than package-lock.json (its .package-lock.json predates the lock); ${fix}`;
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--');
  const command = at === -1 ? argv : argv.slice(at + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/isolated.mjs -- <command…>   (run from the worktree under test)');
    return 2;
  }
  let t;
  try {
    t = target();
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`[isolated] REFUSED before docker: ${e.message}`);
    return 97;
  }
  const { worktree, common, own, main: checkout } = t;
  const install = installRefusal({ worktree });
  if (install) {
    console.error(`[isolated] REFUSED before docker: ${install}`);
    return 97;
  }
  const home = homedir();
  for (const p of [join(home, '.cargo', 'bin'), join(home, '.rustup')]) {
    if (!existsSync(p)) { console.error(`[isolated] missing toolchain dir ${p}`); return 2; }
  }
  const forbidden = [
    ...forbiddenPaths({ home, worktree }),
    ...['.tmm', '.tmm/agents', '.tmm/uploads', '.tmm/teams'].map((p) => join(checkout, p)),
  ];
  let node;
  try {
    node = nodeRuntime({ execPath: realpathSync(process.execPath), home, worktree, main: checkout, forbidden });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`[isolated] REFUSED before docker: ${e.message}`);
    return 97;
  }
  ensureImage();
  const args = dockerArgs({
    worktree, gitDirs: { common, own }, uid: process.getuid(), gid: process.getgid(), home,
    forbidden, chain: ancestry(worktree, checkout), command, node,
  });
  console.error(`[isolated] ${worktree}: --network none, private HOME/XDG/TMPDIR, only the worktree writable`);
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
