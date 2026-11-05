// Board #503: the isolated runner. The docker argv is pinned here because
// each rule in it is an incident (see isolated.mjs): no network, none of the
// real HOME, an empty env, only the worktree writable, and a self-check that
// refuses to start when any of that does not hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ancestry, dockerArgs, forbiddenPaths, installRefusal, nodeRuntime, npmInstallsIn, Refusal, selfCheck, target, withTripwire } from './isolated.mjs';

const home = '/local/home/u';
const worktree = '/local/home/u/work/repo/worktree/a-1';
const args = () => dockerArgs({
  worktree, gitDirs: { common: '/local/home/u/work/repo/.git', own: '/local/home/u/work/repo/.git/worktrees/a-1' },
  uid: 1000, gid: 100, home, forbidden: forbiddenPaths({ home, env: {}, worktree }), command: ['npm', 'test'],
});

test('the container has no network and runs as the caller; the self-check shell stays PID 1 to reap', () => {
  const a = args();
  assert.deepEqual(a.slice(0, 6), ['run', '--rm', '--network', 'none', '--user', '1000:100']);
  // The command runs as a CHILD of the self-check shell, never exec'd over
  // it: as PID 1 the command left a killed tree's orphans as zombies, and the
  // process-tree tests read them as alive (measured, 2026-11-02).
  assert.ok(!selfCheck([]).includes('exec "$@"'));
});

test('no mount exposes the real HOME: only the worktree and its git dirs are writable', () => {
  const a = args();
  const mounts = a.flatMap((x, i) => (a[i - 1] === '-v' ? [x] : []));
  const writable = mounts.filter((m) => !m.endsWith(':ro'));
  assert.deepEqual(writable.sort(), [`${worktree}:${worktree}`, '/local/home/u/work/repo/.git/worktrees/a-1:/local/home/u/work/repo/.git/worktrees/a-1'].sort());
  for (const m of mounts) {
    const src = m.split(':')[0];
    assert.notEqual(src, home, 'the HOME itself is never mounted');
    if (src.startsWith(`${home}/`)) {
      assert.ok(src.startsWith(`${home}/work/`) || /\/\.(cargo\/(bin|registry)|rustup)$/.test(src), `only the repo and the read-only toolchain under HOME: ${m}`);
    }
  }
  assert.ok(mounts.filter((m) => /\.(cargo|rustup)/.test(m)).every((m) => m.endsWith(':ro')), 'the toolchain is read-only');
});

test('the environment is built from nothing: HOME, XDG and CARGO_HOME are private, no TMM_/TOKEN/TMUX', () => {
  const a = args();
  const env = a.flatMap((x, i) => (a[i - 1] === '-e' ? [x] : []));
  const keys = env.map((e) => e.split('=')[0]);
  assert.ok(!keys.some((k) => /^(TMM_|TOKEN$|TMUX)/.test(k)), keys.join(' '));
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'CARGO_HOME']) {
    const v = env.find((e) => e.startsWith(`${k}=`));
    assert.ok(v && v.split('=')[1].startsWith('/tmp'), `${k} is under the private /tmp: ${v}`);
  }
  assert.ok(!a.includes('--env-file'), 'no env file crosses either');
});

test('a HOME above the worktree is checked by what it holds; another HOME by itself; plus the live config and socket', () => {
  const f = forbiddenPaths({ home, env: {}, worktree });
  for (const p of ['.config', '.ssh', '.kiro', '.cargo', '.rustup']) assert.ok(f.includes(`${home}/${p}`), p);
  assert.ok(f.includes(`${home}/.config/tmux-mobile/sock/gateway.sock`));
  assert.ok(f.includes(`${home}/.config/teammux/sock/gateway.sock`), 'both names of the config root');
  assert.ok(!f.includes(home), 'docker creates the ancestor itself, empty');
  assert.ok(forbiddenPaths({ home: '/elsewhere/h', env: {}, worktree }).includes('/elsewhere/h'));
  assert.ok(forbiddenPaths({ home, env: { XDG_CONFIG_HOME: '/x/cfg' }, worktree }).includes('/x/cfg/tmux-mobile/sock/gateway.sock'));
});

/** Run the self-check in a plain bash on this host (no docker), with a
 * private HOME. The forbidden list names paths of a scratch dir. */
function runCheck(forbidden: string[], extraEnv: Record<string, string> = {}) {
  const t = mkdtempSync(join(tmpdir(), 'tmm-isolated-test-'));
  const env = { PATH: '/usr/bin:/bin', HOME: join(t, 'h'), XDG_CONFIG_HOME: join(t, 'h/c'), XDG_DATA_HOME: join(t, 'h/d'), XDG_STATE_HOME: join(t, 'h/s'), CARGO_HOME: join(t, 'ch'), ...extraEnv };
  const r = spawnSync('bash', ['-c', selfCheck(forbidden), 'isolated', 'echo', 'RAN'], { env, encoding: 'utf8' });
  return { t, r };
}

test('the self-check refuses a visible host path and a forbidden variable before any probe or command', () => {
  const visible = mkdtempSync(join(tmpdir(), 'tmm-isolated-seen-'));
  mkdirSync(join(visible, 'sock'), { recursive: true });
  try {
    const seen = runCheck([join(visible, 'sock')]);
    assert.equal(seen.r.status, 97, seen.r.stderr);
    assert.match(seen.r.stderr, /REFUSED: a host path is visible/);
    assert.ok(!seen.r.stdout.includes('RAN'), 'the command never ran');
    const tmm = runCheck([join(visible, 'absent')], { TMM_SERVER: 'ws://x' });
    assert.equal(tmm.r.status, 97);
    assert.match(tmm.r.stderr, /forbidden variable/);
    for (const x of [seen, tmm]) rmSync(x.t, { recursive: true, force: true });
  } finally {
    rmSync(visible, { recursive: true, force: true });
  }
});

test('the self-check probes TCP only and never opens the live socket path', () => {
  const s = selfCheck(['/h/.config/tmux-mobile/sock/gateway.sock']);
  assert.match(s, /\/dev\/tcp\/127\.0\.0\.1\/9899/);
  assert.ok(!/(nc|socat|curl)\b.*gateway\.sock/.test(s) && !s.includes('-U '), 'the socket is only tested with [ -e ]');
});

// ---- reviewer P1-A / P2-B on 74738836: the target, the path down, the setup ----
// Sentinel repos only, in a scratch dir: no real checkout is read or bound,
// and no check below reaches the TCP probes (each refuses before them).

function sentinel() {
  const t = mkdtempSync(join(tmpdir(), 'tmm-isolated-repo-'));
  const main = join(t, 'proj');
  mkdirSync(main);
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: t, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr);
  };
  g(main, 'init', '-q', '-b', 'main');
  g(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  g(main, 'worktree', 'add', '-q', '-b', 'w', join(main, 'worktree', 'a-1'));
  return { t, main, linked: join(main, 'worktree', 'a-1') };
}

test('the main checkout (own git dir == common dir) is refused before any docker call', () => {
  const s = sentinel();
  try {
    assert.throws(() => target({ cwd: s.main, env: {}, home: '/nonexistent-home' }), (e: Error) => e instanceof Refusal && /main checkout/.test(e.message));
    const ok = target({ cwd: s.linked, env: {}, home: '/nonexistent-home' });
    assert.equal(ok.worktree, realpathSync(s.linked));
    assert.equal(ok.main, realpathSync(s.main));
  } finally {
    rmSync(s.t, { recursive: true, force: true });
  }
});

test('an inherited GIT_* override, a worktree holding .tmm/, and a HOME inside the target are refused', () => {
  const s = sentinel();
  try {
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
      assert.throws(() => target({ cwd: s.linked, env: { [k]: join(s.main, '.git') }, home: '/nonexistent-home' }), (e: Error) => e instanceof Refusal && e.message.startsWith(k));
    }
    mkdirSync(join(s.linked, '.tmm', 'agents'), { recursive: true });
    assert.throws(() => target({ cwd: s.linked, env: {}, home: '/nonexistent-home' }), (e: Error) => e instanceof Refusal && /\.tmm/.test(e.message));
    rmSync(join(s.linked, '.tmm'), { recursive: true });
    assert.throws(() => target({ cwd: s.linked, env: {}, home: join(s.linked, 'h') }), (e: Error) => e instanceof Refusal && /HOME/.test(e.message));
  } finally {
    rmSync(s.t, { recursive: true, force: true });
  }
});

test('along the path down only the next component is allowed, plus .git in the main checkout', () => {
  const chain = ancestry('/r/proj/worktree/a-1', '/r/proj');
  assert.deepEqual(chain, [['/r/proj/worktree', ['a-1']], ['/r/proj', ['worktree', '.git']], ['/r', ['proj']]]);
});

test('a checkout .tmm/ or another worktree beside the target is refused inside, before any probe', () => {
  const t = mkdtempSync(join(tmpdir(), 'tmm-isolated-chain-'));
  try {
    const main = join(t, 'proj');
    mkdirSync(join(main, 'worktree', 'a-1'), { recursive: true });
    mkdirSync(join(main, '.git'));
    const chain = ancestry(join(main, 'worktree', 'a-1'), main).filter(([d]) => d.startsWith(main));
    const clean = runCheckChain(t, chain);
    assert.match(clean.r.stderr, /the private HOME could not be made/, 'a clean path passes the chain step and stops at the setup');
    mkdirSync(join(main, '.tmm', 'agents'), { recursive: true });
    const tmm = runCheckChain(t, chain);
    assert.equal(tmm.r.status, 97, tmm.r.stderr);
    assert.match(tmm.r.stderr, /more than the way down is visible in .*proj: \.tmm/);
    assert.ok(!tmm.r.stdout.includes('RAN') && !tmm.r.stderr.includes('passed'));
    rmSync(join(main, '.tmm'), { recursive: true });
    mkdirSync(join(main, 'worktree', 'b-2'));
    const other = runCheckChain(t, chain);
    assert.equal(other.r.status, 97);
    assert.match(other.r.stderr, /worktree: b-2/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the path-down walk refuses a name with a space, a lone *, and an ancestor that cannot be read', () => {
  const t = mkdtempSync(join(tmpdir(), 'tmm-isolated-walk-'));
  try {
    const main = join(t, 'proj');
    mkdirSync(join(main, 'worktree', 'a-1'), { recursive: true });
    mkdirSync(join(main, '.git'));
    const chain = ancestry(join(main, 'worktree', 'a-1'), main).filter(([d]) => d.startsWith(main));
    mkdirSync(join(main, 'two words'));
    const spaced = runCheckChain(t, chain);
    assert.equal(spaced.r.status, 97, spaced.r.stderr);
    assert.match(spaced.r.stderr, /visible in .*proj: two words$/m, 'the whole name, not two words');
    rmSync(join(main, 'two words'), { recursive: true });
    mkdirSync(join(main, 'worktree', '*'));
    const star = runCheckChain(t, chain);
    assert.equal(star.r.status, 97, star.r.stderr);
    assert.match(star.r.stderr, /visible in .*worktree: \*$/m, 'a lone * is a name, never a glob');
    rmSync(join(main, 'worktree', '*'), { recursive: true });
    chmodSync(join(main, 'worktree'), 0o300);
    const unreadable = runCheckChain(t, chain);
    chmodSync(join(main, 'worktree'), 0o755);
    assert.equal(unreadable.r.status, 97, unreadable.r.stderr);
    assert.match(unreadable.r.stderr, /worktree cannot be listed/, 'an unreadable ancestor refuses, never reads as empty');
    for (const r of [spaced, star, unreadable]) assert.ok(!r.r.stdout.includes('RAN') && !r.r.stderr.includes('passed'));
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

/** The self-check with only `chain` and a HOME that cannot be made, so a
 * clean chain stops at the setup step (97, "could not be made") and never
 * reaches the TCP probes on this host. */
function runCheckChain(t: string, chain: [string, string[]][]) {
  const env = { PATH: '/usr/bin:/bin', HOME: '/proc/self/no-home', XDG_CONFIG_HOME: '/proc/self/no-home/c', XDG_DATA_HOME: '/proc/self/no-home/d', XDG_STATE_HOME: '/proc/self/no-home/s', CARGO_HOME: join(t, 'ch') };
  return { r: spawnSync('bash', ['-c', selfCheck([], chain), 'isolated', 'echo', 'RAN'], { env, encoding: 'utf8' }) };
}

test('a setup step that fails refuses: the command does not run and "passed" is never printed', () => {
  const r = spawnSync('bash', ['-c', selfCheck([]), 'isolated', 'echo', 'RAN'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/proc/self/no-home', XDG_CONFIG_HOME: '/proc/self/no-home/c', XDG_DATA_HOME: '/proc/self/no-home/d', XDG_STATE_HOME: '/proc/self/no-home/s', CARGO_HOME: '/proc/self/no-home/ch' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 97, r.stderr);
  assert.match(r.stderr, /the private HOME could not be made/);
  assert.ok(!r.stdout.includes('RAN'), 'the command never ran');
  assert.ok(!r.stderr.includes('self-check passed'));
});

test('the TCP probes come after every refusal that can be tested on a host', () => {
  const s = selfCheck(['/x'], [['/r', ['a']]]);
  const probe = s.indexOf('/dev/tcp/');
  for (const step of ['[ -e', 'forbidden variable', 'more than the way down', 'could not be made', '.zshrc could not', 'toolchain link']) {
    assert.ok(s.indexOf(step) !== -1 && s.indexOf(step) < probe, `${step} is checked before the probes`);
  }
});

// ---- board #503: the default-port tripwire (reviewer P1-A/P1-B on 586c6fbb) ----
// The pins say where it sits and what it never does; the behaviour rows run
// it for real, ONLY inside the accepted isolated runner (ISOLATED_RUNNER=1,
// exported after the self-check), on a test port beside the run's own
// tripwire, never on a host where a live gateway listens.
test('the tripwire sits between "passed" and the verdict and reads no peer bytes', () => {
  const s = selfCheck([]);
  const passed = s.indexOf('self-check passed');
  const start = s.indexOf("'/usr/bin/node' -e");
  const run = s.indexOf('"$@"');
  const verdict = s.indexOf('exit 98');
  assert.ok(passed < start && start < run && run < verdict, 'passed, the tripwire, the command, the verdict');
  assert.match(s, /pauseOnConnect: true/, 'an accepted socket is never read');
  assert.ok(!/on\("data"|\.read\(|toString\("latin1"\)|head/.test(s.slice(start, run)), 'no peer bytes, no head');
  assert.ok(!s.includes('exec "$@"'));
});

const inside = process.env.ISOLATED_RUNNER === '1';

/** Run `body` (bash) as the command inside the tripwire, on a test port. */
function tripped(body: string) {
  const t = mkdtempSync(join(tmpdir(), 'tmm-tripwire-'));
  const port = String(20000 + Math.floor(Math.random() * 20000));
  // The node running this test (board #9): /usr/bin/node only where it is.
  const script = ['fail() { echo "[isolated] REFUSED: $1" >&2; exit 97; }', ...withTripwire(realpathSync(process.execPath))].join('\n');
  const r = spawnSync('bash', ['-c', script, 'isolated', 'bash', '-c', body], {
    env: { PATH: '/usr/bin:/bin', TRIPWIRE_PORT: port, TRIPWIRE_BASE: join(t, 'tw'), TW_DIR: t },
    encoding: 'utf8', timeout: 30_000,
  });
  rmSync(t, { recursive: true, force: true });
  return { r, port };
}

const dial = (send: string) => `exec 3<>/dev/tcp/127.0.0.1/$TRIPWIRE_PORT; ${send}`;

test('a clean command keeps its own status', { skip: !inside }, () => {
  assert.equal(tripped('exit 0').r.status, 0);
  assert.equal(tripped('exit 7').r.status, 7);
});

test('a connection that sends nothing, half a head, or comes at the very end is counted', { skip: !inside }, () => {
  for (const [name, body] of [
    ['held with no data', dial('sleep 0.3')],
    ['half a head as the command exits', dial('printf "GET / HTTP/1.1\\r\\nHost: x" >&3')],
    ['at the very end', dial(':')],
  ] as const) {
    const { r } = tripped(body);
    assert.equal(r.status, 98, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /TRIPWIRE: 1 connection\(s\)/, name);
  }
});

test('no peer byte reaches the output: credentials, cookies, signed paths and binary payloads', { skip: !inside }, () => {
  const sentinels = ['Bearer-SENTINEL-1', 'cookie-SENTINEL-2', 'token=SENTINEL-3', '/signed/SENTINEL-4'];
  const body = dial(`printf "GET /signed/SENTINEL-4?token=SENTINEL-3 HTTP/1.1\\r\\nAuthorization: Bearer-SENTINEL-1\\r\\nCookie: cookie-SENTINEL-2\\r\\n\\r\\n\\x00\\xffraw" >&3; sleep 0.2`);
  const { r } = tripped(body);
  assert.equal(r.status, 98, r.stderr);
  for (const s of sentinels) assert.ok(!r.stderr.includes(s) && !r.stdout.includes(s), `${s} is never printed`);
});

test('a listener that dies, or cannot write its record, fails closed', { skip: !inside }, () => {
  const died = tripped('kill -9 $(pgrep -f "$TW_DIR/tw") 2>/dev/null; sleep 0.2');
  assert.equal(died.r.status, 97, died.r.stderr);
  assert.match(died.r.stderr, /tripwire died|record cannot be read|did not stop|ended with status/);
  const unwritable = tripped(`chmod 0400 "$TW_DIR/tw.count"; ${dial('sleep 0.3')}`);
  assert.equal(unwritable.r.status, 97, unwritable.r.stderr);
  assert.match(unwritable.r.stderr, /tripwire died|ended with status/, 'a failed record write fails closed');
  const quiet = tripped(`chmod 0400 "$TW_DIR/tw.count"; sleep 0.2`);
  assert.equal(quiet.r.status, 97, `a final record that cannot be written is never a clean run: ${quiet.r.stderr}`);
});

// ---- board #514: refuse while the worktree's npm install is incomplete ----
// Sentinel directories only; the process scan is injected, except the rows
// that read the real /proc: stand-ins in each argv shape, and a REAL `npm ci`
// held in its root install script by a sentinel file.

function installTree(opts: { pkg?: boolean; marker?: boolean; markerOlder?: boolean }) {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-isolated-install-')));
  if (opts.pkg !== false) writeFileSync(join(t, 'package.json'), '{}');
  writeFileSync(join(t, 'package-lock.json'), '{}');
  if (opts.marker !== false) {
    mkdirSync(join(t, 'node_modules'));
    writeFileSync(join(t, 'node_modules', '.package-lock.json'), '{}');
    if (opts.markerOlder) utimesSync(join(t, 'node_modules', '.package-lock.json'), new Date(1000), new Date(1000));
  }
  return t;
}
const none = () => [];

test('a complete install runs; a missing marker, a stale marker and a running install each refuse', () => {
  const ok = installTree({});
  const missing = installTree({ marker: false });
  const stale = installTree({ markerOlder: true });
  const nopkg = installTree({ pkg: false, marker: false });
  try {
    assert.equal(installRefusal({ worktree: ok, installs: none }), null, 'a complete install is never refused');
    assert.equal(installRefusal({ worktree: nopkg, installs: none }), null, 'nothing to install, nothing refused');
    const fix = `run \`npm ci\` alone in ${missing}, wait for it to exit, then retry`;
    assert.equal(installRefusal({ worktree: missing, installs: none }), `node_modules is missing or its install did not finish (no node_modules/.package-lock.json); ${fix}`, 'the refusal names the worktree and the fix');
    assert.match(installRefusal({ worktree: stale, installs: none }) ?? '', /older than package-lock\.json.*run `npm ci` alone in /);
    assert.equal(installRefusal({ worktree: ok, installs: () => [4242] }), `an npm install is still running in ${ok} (pid 4242); wait for it to exit, then retry`, 'a running install refuses even beside a marker');
  } finally {
    for (const d of [ok, missing, stale, nopkg]) rmSync(d, { recursive: true, force: true });
  }
});

test('a marker that is not a regular file refuses; an unreadable lock refuses, an absent one does not', () => {
  const dirMarker = installTree({ marker: false });
  const badLock = installTree({});
  const noLock = installTree({});
  try {
    mkdirSync(join(dirMarker, 'node_modules', '.package-lock.json'), { recursive: true });
    assert.match(installRefusal({ worktree: dirMarker, installs: none }) ?? '', /^node_modules\/\.package-lock\.json is not a regular file; run `npm ci` alone in /);
    // A self-loop symlink: stat fails with ELOOP, not ENOENT, whoever runs it.
    rmSync(join(badLock, 'package-lock.json'));
    symlinkSync('package-lock.json', join(badLock, 'package-lock.json'));
    assert.equal(installRefusal({ worktree: badLock, installs: none }), 'package-lock.json cannot be read (ELOOP), so the install cannot be judged; fix it, then retry');
    rmSync(join(noLock, 'package-lock.json'));
    assert.equal(installRefusal({ worktree: noLock, installs: none }), null, 'no lock: no staleness to judge');
  } finally {
    for (const d of [dirMarker, badLock, noLock]) rmSync(d, { recursive: true, force: true });
  }
});

// Each stand-in leads its own process group: kill the group, its children too.
function killGroup(pid: number | undefined) { try { process.kill(-pid!, 'SIGKILL'); } catch { /* already gone */ } }
function waitFor(cond: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) spawnSync('sleep', ['0.05']);
  return cond();
}

test('the process scan finds an npm install by its cwd, in both argv shapes, and nothing else', () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-isolated-npm-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-isolated-other-')));
  // Startup shape: argv `npm … ci`, one element per word (exec -a sets argv[0]).
  const words = (cwd: string) => spawn('bash', ['-c', "exec -a npm bash -c 'sleep 30; :' ci"], { cwd, stdio: 'ignore', detached: true });
  // npm 10's own title: ONE element `npm ci`, set the way lib/npm.js does,
  // through process.title, which node writes over the argv area.
  const title = (cwd: string) => spawn(process.execPath, ['-e', "process.title = 'npm ci'; setTimeout(() => {}, 30000)"], { cwd, stdio: 'ignore', detached: true });
  // A shell whose argument string reads `npm ci`: several elements, not npm.
  const shell = (cwd: string) => spawn('bash', ['-c', "exec -a sh bash -c 'sleep 30; :' 'npm ci'"], { cwd, stdio: 'ignore', detached: true });
  const procs = [words(t), title(t), shell(t), words(other), title(other)];
  const [here, titled, sh, ...there] = procs;
  try {
    let found: number[] = [];
    waitFor(() => (found = npmInstallsIn(t)).includes(here.pid!) && found.includes(titled.pid!), 5000);
    assert.ok(found.includes(here.pid!), `startup argv shape found: ${found}`);
    assert.ok(found.includes(titled.pid!), `npm 10 title shape found: ${found}`);
    assert.ok(!found.includes(sh.pid!), 'a shell string that mentions npm ci is not an install');
    for (const p of there) assert.ok(!found.includes(p.pid!), 'another worktree\'s install is not this one\'s');
    assert.deepEqual(npmInstallsIn(join(t, 'nope')), [], 'a directory with no install has none');
  } finally {
    for (const c of procs) killGroup(c.pid);
    rmSync(t, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});

test('a REAL npm ci is refused while its root scripts run after the marker, and passes once it exits', () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-isolated-realnpm-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-isolated-other-')));
  // A local file: dependency gives npm a node_modules to write (offline);
  // the root install script holds npm until the sentinel `go` appears.
  mkdirSync(join(t, 'dep'));
  writeFileSync(join(t, 'dep', 'package.json'), '{"name":"dep","version":"1.0.0"}');
  writeFileSync(join(t, 'package.json'), JSON.stringify({ name: 'sentinel', version: '1.0.0', dependencies: { dep: 'file:./dep' }, scripts: { install: 'while [ ! -e go ]; do sleep 0.1; done' } }));
  const env = { ...process.env, npm_config_cache: join(t, '.npm-cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: t, env, stdio: 'ignore' });
  assert.equal(lock.status, 0, 'the sentinel lockfile is written');
  utimesSync(join(t, 'package-lock.json'), new Date(1000), new Date(1000));
  const npm = spawn('npm', ['ci'], { cwd: t, env, stdio: 'ignore', detached: true });
  let exited = false;
  npm.on('exit', () => { exited = true; });
  const marker = join(t, 'node_modules', '.package-lock.json');
  try {
    assert.ok(waitFor(() => existsSync(marker) && existsSync(join(t, 'node_modules', 'dep')) && npmInstallsIn(t).length > 0, 30000), 'npm wrote the marker and is still running');
    assert.match(installRefusal({ worktree: t }) ?? '', /^an npm install is still running in /, 'the marker exists, npm runs its root script: refused');
    assert.equal(npmInstallsIn(other).length, 0, 'another cwd sees no install');
    writeFileSync(join(t, 'go'), '');
    assert.ok(waitFor(() => npmInstallsIn(t).length === 0, 30000), 'npm exits once the sentinel is there');
    assert.equal(installRefusal({ worktree: t }), null, 'after npm exits, the run goes ahead');
  } finally {
    if (!exited) killGroup(npm.pid);
    rmSync(t, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});

test('the install check runs before any docker call, after the target check', () => {
  const src = readFileSync(new URL('./isolated.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function main('));
  const at = (s: string) => body.indexOf(s);
  assert.ok(at('target()') < at('installRefusal(') && at('installRefusal(') < at('ensureImage()') && at('ensureImage()') < at("spawnSync('docker'"));
});

// Board #9: the runner needs node (the tripwire, and npm/node for the
// command) and resolves it from the RUNNING process, never a guessed path.
// Measured 2026-11-05 on a host whose node is ~/.local/share/node/bin/node:
// the hardcoded `/usr/bin/node` tripwire could not start (exit 97, under 3 s),
// so the runner could not start there while node lived outside /usr.
const envOf = (a: string[]) => Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === '-e' ? [x.split(/=(.*)/s).slice(0, 2)] : [])));
const mountsOf = (a: string[]) => a.flatMap((x, i) => (a[i - 1] === '-v' ? [x] : []));
const forbidden = forbiddenPaths({ home, env: {}, worktree });
// `pathNode` stands in for the node the container's PATH would pick (the
// real one reads /usr/local/bin, /usr/bin and /bin on the host running the
// test); null when PATH has none.
const argsWith = (execPath: string, pathNode: string | null = null) => dockerArgs({
  worktree, gitDirs: { common: '/local/home/u/work/repo/.git', own: '/local/home/u/work/repo/.git/worktrees/a-1' },
  uid: 1000, gid: 100, home, forbidden, command: ['npm', 'test'],
  node: nodeRuntime({ execPath, pathNode: () => pathNode }),
});

test('the node PATH already picks adds nothing: no mount, the same PATH, the tripwire runs that node', () => {
  const a = argsWith('/usr/bin/node', '/usr/bin/node');
  assert.deepEqual(mountsOf(a), mountsOf(args()), 'the mount list is unchanged');
  assert.equal(envOf(a).PATH, '/tmp/cargo-home/bin:/usr/local/bin:/usr/bin:/bin');
  const s = a[a.indexOf('-c') + 1];
  assert.ok(s.includes("'/usr/bin/node' -e"), 'the tripwire runs /usr/bin/node, quoted');
  assert.ok(!s.includes('/tmp/node-bin'), 'no node links are made');
  assert.deepEqual(a, args(), 'the whole argv is the default');
  const local = argsWith('/usr/local/bin/node', '/usr/local/bin/node');
  assert.ok(local[local.indexOf('-c') + 1].includes("'/usr/local/bin/node' -e"));
  assert.equal(envOf(local).PATH, '/tmp/cargo-home/bin:/usr/local/bin:/usr/bin:/bin');
});

// Reviewer, #9 @82de46b8: visible is not the same as on PATH.
test('a visible node PATH would not pick is linked first on PATH, with nothing mounted', () => {
  for (const [execPath, pathNode] of [['/usr/local/node-v26/bin/node', null], ['/usr/bin/node', '/usr/local/bin/node']] as const) {
    const a = argsWith(execPath, pathNode);
    assert.deepEqual(mountsOf(a), mountsOf(args()), `${execPath}: visible already, nothing mounted`);
    assert.equal(envOf(a).PATH, '/tmp/node-bin:/tmp/cargo-home/bin:/usr/local/bin:/usr/bin:/bin', execPath);
    const s = a[a.indexOf('-c') + 1];
    assert.ok(s.includes(`'${execPath}' /tmp/node-bin/node`), `${execPath}: \`node\` on PATH is the running node`);
    assert.ok(s.includes(`'${execPath}' -e`), 'and the tripwire runs it');
  }
});

test('the tripwire quotes the node path: a system install with a space runs', () => {
  const a = argsWith('/usr/my node/bin/node', null);
  const s = a[a.indexOf('-c') + 1];
  assert.ok(s.includes("'/usr/my node/bin/node' -e"), 'one shell word');
  const script = ['fail() { echo "[isolated] REFUSED: $1" >&2; exit 97; }', ...withTripwire('/usr/my node/bin/node')].join('\n');
  const r = spawnSync('bash', ['-n', '-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

/** A node install on disk: `<prefix>/bin/node` and, unless `npm` is false,
 * npm's package at `<prefix>/lib/node_modules/npm`, inside a dir that also
 * holds a SECRET sibling, as ~/.local/share or ~/.ssh would (validator-2,
 * #9 round 1). */
function install(parentName: string, { npm = true } = {}) {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-node-')));
  const prefix = join(t, parentName, 'x');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'node'), '');
  writeFileSync(join(t, parentName, 'SECRET'), 'never mounted');
  if (npm) {
    mkdirSync(join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'lib', 'node_modules', 'npm', 'package.json'), '{"name":"npm"}');
  }
  return { t, prefix, execPath: join(prefix, 'bin', 'node') };
}

test('a node elsewhere mounts ONLY its binary and npm\'s package, read-only, at /opt/node', () => {
  for (const parent of ['.local/share', '.ssh', '.aws', '.config/teammux', '.tmm/agents/a']) {
    const { t, prefix, execPath } = install(parent);
    const a = argsWith(execPath);
    const before = mountsOf(args());
    const added = mountsOf(a).filter((m) => !before.includes(m));
    assert.deepEqual(added, [
      `${prefix}/bin/node:/opt/node/bin/node:ro`,
      `${prefix}/lib/node_modules/npm:/opt/node/lib/node_modules/npm:ro`,
    ], `${parent}: the binary and npm only, never the prefix or its parent`);
    assert.ok(!mountsOf(a).some((m) => [prefix, join(t, parent)].includes(m.split(':')[0])), `${parent}: the dir holding SECRET is not mounted`);
    assert.deepEqual(mountsOf(a).filter((m) => !m.endsWith(':ro')).sort(), mountsOf(args()).filter((m) => !m.endsWith(':ro')).sort(), 'nothing new is writable');
    assert.deepEqual(a.slice(0, 6), args().slice(0, 6), 'network and user unchanged');
    assert.equal(envOf(a).PATH, '/tmp/node-bin:/tmp/cargo-home/bin:/usr/local/bin:/usr/bin:/bin');
    const s = a[a.indexOf('-c') + 1];
    assert.ok(s.includes("'/opt/node/bin/node' -e"), 'the tripwire runs the mounted node, quoted');
    assert.ok(s.includes("'/opt/node/bin/node' /tmp/node-bin/node"), 'node is linked');
    assert.ok(s.includes("'/opt/node/lib/node_modules/npm/bin/npm-cli.js' /tmp/node-bin/npm"), 'npm is linked to its own cli');
    assert.ok(s.includes("'/opt/node/lib/node_modules/npm/bin/npx-cli.js' /tmp/node-bin/npx"), 'npx is linked to its own cli');
    assert.ok(s.indexOf('/tmp/node-bin') < s.indexOf('self-check passed'), 'the links are made in the setup, before the probes');
    assert.ok(s.indexOf('/tmp/node-bin') > s.indexOf('a host path is visible'), 'and after the host-path refusals');
    rmSync(t, { recursive: true, force: true });
  }
});

test('a node without npm beside it mounts the binary alone and links only node', () => {
  const { t, prefix, execPath } = install('.local/share', { npm: false });
  const a = argsWith(execPath);
  assert.deepEqual(mountsOf(a).filter((m) => !mountsOf(args()).includes(m)), [`${prefix}/bin/node:/opt/node/bin/node:ro`]);
  const s = a[a.indexOf('-c') + 1];
  assert.ok(!s.includes('/tmp/node-bin/npm') && !s.includes('/tmp/node-bin/npx'));
  rmSync(t, { recursive: true, force: true });
});

test('a node that cannot be mounted refuses, naming the path and the fix', () => {
  const refuses = (execPath: string, what: RegExp) => assert.throws(
    () => nodeRuntime({ execPath }),
    (e: unknown) => e instanceof Refusal && what.test(e.message) && e.message.includes(execPath) && /install node/.test(e.message),
  );
  refuses('/local/home/u/odd:dir/bin/node', /`:` or `,`/);
  refuses('/local/home/u/odd,dir/bin/node', /`:` or `,`/);
  refuses('/local/home/u/no-such-node', /not a regular file/);
});

test('the runner resolves node from the running process, and refuses before any docker call', () => {
  const src = readFileSync(new URL('./isolated.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function main('));
  assert.ok(body.indexOf('installRefusal(') < body.indexOf('nodeRuntime(') && body.indexOf('nodeRuntime(') < body.indexOf('ensureImage()'));
  assert.match(src, /nodeRuntime\(\{ execPath: realpathSync\(process\.execPath\) \}\)/);
  assert.ok(!/^\s*['`]\/usr\/bin\/node -e/m.test(src), 'no hardcoded tripwire node');
});
