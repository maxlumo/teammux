// Board #14 (incident 2026-11-05 08:06, builder-3): a scratch gateway started
// from an agent's pane inherited TMUX/TMUX_PANE and drove the LIVE tmux server
// (tmux.rs reads $TMUX before TMUX_TMPDIR); its UI listed the live sessions.
// scratch-env.mjs starts a command with test-rust.mjs's isolatedEnv (the one
// definition of "kept away from the real tmux and gateway") and checks a
// running process for any name that survived.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { leaks, runScratch } from './scratch-env.mjs';

const nul = (pairs: string[]) => pairs.join('\0') + '\0';

test('a process is routed privately only when TMUX_TMPDIR and the XDG roots are THE scratch dir, and nothing live-pointing survived (#14 review)', () => {
  const dir = '/tmp/b3-x/gw';
  const ok = ['PATH=/bin', `TMUX_TMPDIR=${dir}`, `XDG_CONFIG_HOME=${dir}/xdg-config`, `XDG_DATA_HOME=${dir}/xdg-data`, `XDG_STATE_HOME=${dir}/xdg-state`];
  assert.deepEqual(leaks(nul(ok), dir), [], 'the isolated env routes only to the private dir');
  // This pane's real shape on 2026-11-05: TMUX, TMUX_PANE, TMM_SOCKET (the
  // live gateway's local socket), TMM_PROJECT, TMM_AGENT.
  const pane = nul([...ok, 'TMUX=/tmp/tmux-1000/default,22563,1', 'TMUX_PANE=%55', 'TMM_SOCKET=/home/u/.config/teammux/sock/gateway.sock', 'TMM_PROJECT=teammux', 'TMM_AGENT=builder-3']);
  assert.deepEqual(leaks(pane, dir), ['TMUX', 'TMUX_PANE', 'TMM_SOCKET', 'TMM_PROJECT', 'TMM_AGENT']);
  assert.deepEqual(leaks(nul([...ok, 'TMUX_SOCKET=/tmp/tmux-1000/default', 'TOKEN=secret']), dir), ['TMUX_SOCKET', 'TOKEN']);
  // Reviewer's false positives: a NAMED but non-private TMUX_TMPDIR is a leak.
  const swap = (k: string, v: string | null) => nul(ok.filter((kv) => !kv.startsWith(`${k}=`)).concat(v === null ? [] : [`${k}=${v}`]));
  assert.deepEqual(leaks(swap('TMUX_TMPDIR', ''), dir), [`TMUX_TMPDIR is '' (tmux falls back to /tmp, the live server's socket dir), not ${dir}`]);
  assert.deepEqual(leaks(swap('TMUX_TMPDIR', '/tmp'), dir), [`TMUX_TMPDIR is '/tmp', not ${dir}`]);
  assert.deepEqual(leaks(swap('TMUX_TMPDIR', null), dir), [`TMUX_TMPDIR is unset (tmux falls back to /tmp, the live server's socket dir), not ${dir}`]);
  assert.deepEqual(leaks(swap('XDG_CONFIG_HOME', '/home/u/.config'), dir), [`XDG_CONFIG_HOME is '/home/u/.config', not ${dir}/xdg-config`], 'the live config root (and its state.db) is a route too');
  assert.deepEqual(leaks(swap('XDG_STATE_HOME', null), dir), [`XDG_STATE_HOME is unset, not ${dir}/xdg-state`]);
  assert.deepEqual(leaks(nul([...ok, 'TMUXX=1', 'MY_TMM_X=1']), dir), [], 'only the exact names and the TMM_ prefix');
});

test('run writes the private config BEFORE the first launch, so a gateway never binds the default port (#14 review)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const dir = join(root, 'gw');
    const cfg = join(dir, 'xdg-config', 'teammux', 'config.toml');
    let seen = '';
    const spawn = () => { seen = readFileSync(cfg, 'utf8'); return { pid: 7, unref() {} }; };
    runScratch({ dir, argv: ['./server'], env: { PATH: '/bin' }, spawn, port: 19950 });
    assert.match(seen, /^host = "127\.0\.0\.1"\nport = 19950\ntoken = "[0-9a-f]{32}"\n$/u, 'the config the process starts on');
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    assert.throws(() => runScratch({ dir, argv: ['./server'], env: {}, spawn, port: 9899 }), /9899/, 'the live default port is refused');
    for (const bad of [0, 70000, 1.5]) assert.throws(() => runScratch({ dir, argv: ['./server'], env: {}, spawn, port: bad }), /port/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run starts the command with the isolated env in a dir private on every level, and records its pid (#14)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    chmodSync(root, 0o775);
    const dir = join(root, 'gw');
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const spawn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
      calls.push({ cmd, args, env: opts.env });
      return { pid: 4242, unref() {} };
    };
    const pid = runScratch({ dir, argv: ['./server', '--flag'], env: { PATH: '/bin', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%1', TMM_SOCKET: '/live.sock', TOKEN: 't' }, spawn });
    assert.equal(pid, 4242);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0]!.cmd, calls[0]!.args], ['./server', ['--flag']]);
    const env = calls[0]!.env;
    for (const k of ['TMUX', 'TMUX_PANE', 'TMM_SOCKET', 'TOKEN']) assert.equal(env[k], undefined, k);
    assert.equal(env.TMUX_TMPDIR, dir);
    assert.equal(env.XDG_CONFIG_HOME, join(dir, 'xdg-config'));
    assert.equal(env.PATH, '/bin');
    // Every level the server's store checks is 0700, created or not.
    for (const p of [dir, join(dir, 'xdg-config'), join(dir, 'xdg-config', 'teammux'), join(dir, 'xdg-data'), join(dir, 'xdg-state')]) {
      assert.equal(statSync(p).mode & 0o777, 0o700, p);
    }
    assert.equal(readFileSync(join(dir, 'pid'), 'utf8').trim(), '4242');
    // An existing, too-open level is tightened, not trusted.
    chmodSync(join(dir, 'xdg-config'), 0o775);
    runScratch({ dir, argv: ['./server'], env: { PATH: '/bin' }, spawn });
    assert.equal(statSync(join(dir, 'xdg-config')).mode & 0o777, 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run refuses a dir that is not a fresh private path of ours, and a missing command (#14)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const spawn = () => { throw new Error('must not start'); };
    assert.throws(() => runScratch({ dir: '', argv: ['./server'], env: {}, spawn }), /a scratch dir/);
    assert.throws(() => runScratch({ dir: join(root, 'gw'), argv: [], env: {}, spawn }), /a command/);
    assert.throws(() => runScratch({ dir: 'relative/gw', argv: ['./server'], env: {}, spawn }), /absolute/);
    assert.throws(() => runScratch({ dir: '/tmp', argv: ['./server'], env: {}, spawn }), /not your own/, 'a shared dir is never tightened or used');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check refuses a scratch root that is not an absolute private directory of ours (#14 review)', async () => {
  const { rootProblems } = await import('./scratch-env.mjs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    chmodSync(root, 0o700);
    assert.deepEqual(rootProblems(root), [], 'a fresh 0700 dir of ours');
    chmodSync(root, 0o755);
    assert.deepEqual(rootProblems(root), [`${root} is mode 755; others can reach it (want 700)`]);
    assert.deepEqual(rootProblems(''), ['the scratch root must be a non-empty absolute path']);
    assert.deepEqual(rootProblems('rel/gw'), ['the scratch root must be a non-empty absolute path']);
    assert.deepEqual(rootProblems('/tmp'), ['/tmp is the shared tmux socket root, never a scratch root']);
    assert.deepEqual(rootProblems(join(root, 'absent')), [`${join(root, 'absent')} does not exist`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the gateway routes privately only when it lists exactly the private server\'s sessions, the marker included (#14 review)', async () => {
  const { routeVerdict, MARKER } = await import('./scratch-env.mjs');
  assert.equal(MARKER, 'scratch-env-marker');
  assert.equal(routeVerdict([MARKER], [MARKER]), null, 'the positive marker, and only what the private server has');
  assert.match(routeVerdict(['artex', 'teammux', 'token-porta'], [MARKER])!, /does not list scratch-env-marker.*artex, teammux, token-porta/su, 'the 08:06 incident: live sessions, no marker');
  assert.match(routeVerdict([], [MARKER])!, /does not list scratch-env-marker/u, 'an empty answer is not evidence (reviewer: an empty list is a weak oracle)');
  assert.match(routeVerdict([MARKER, 'teammux'], [MARKER])!, /teammux/u, 'a session the private server lacks');
  assert.match(routeVerdict([MARKER], [])!, /private tmux server has no scratch-env-marker/u, 'the marker must really be on the private server');
});
