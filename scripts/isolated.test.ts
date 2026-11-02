// Board #503: the isolated runner. The docker argv is pinned here because
// each rule in it is an incident (see isolated.mjs): no network, none of the
// real HOME, an empty env, only the worktree writable, and a self-check that
// refuses to start when any of that does not hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ancestry, dockerArgs, forbiddenPaths, Refusal, selfCheck, target, withTripwire } from './isolated.mjs';

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
  const start = s.indexOf('/usr/bin/node -e');
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
  const script = ['fail() { echo "[isolated] REFUSED: $1" >&2; exit 97; }', ...withTripwire()].join('\n');
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
