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

test('a process environment leaks every name that reaches the live tmux or gateway (#14)', () => {
  // This pane's real shape on 2026-11-05: TMUX, TMUX_PANE, TMM_SOCKET (the
  // live gateway's local socket), TMM_PROJECT, TMM_AGENT.
  const pane = nul(['PATH=/bin', 'TMUX=/tmp/tmux-1000/default,22563,1', 'TMUX_PANE=%55', 'TMM_SOCKET=/home/u/.config/teammux/sock/gateway.sock',
    'TMM_PROJECT=teammux', 'TMM_AGENT=builder-3', 'TMUX_TMPDIR=/tmp/b3-x']);
  assert.deepEqual(leaks(pane), ['TMUX', 'TMUX_PANE', 'TMM_SOCKET', 'TMM_PROJECT', 'TMM_AGENT']);
  assert.deepEqual(leaks(nul(['TMUX_SOCKET=/tmp/tmux-1000/default', 'TOKEN=secret', 'TMUX_TMPDIR=/tmp/x'])), ['TMUX_SOCKET', 'TOKEN']);
  assert.deepEqual(leaks(nul(['PATH=/bin', 'TMUX_TMPDIR=/tmp/x', 'XDG_CONFIG_HOME=/tmp/x/xdg-config'])), [], 'an isolated process leaks nothing');
  assert.deepEqual(leaks(nul(['PATH=/bin'])), ['TMUX_TMPDIR (unset: tmux falls back to /tmp, the live server\'s socket dir)']);
  assert.deepEqual(leaks(nul(['TMUXX=1', 'MY_TMM_X=1', 'TMUX_TMPDIR=/t'])), [], 'only the exact names and the TMM_ prefix');
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
