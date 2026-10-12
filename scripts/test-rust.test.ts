import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { cargoArgs, isolatedEnv, runTestRust, serverSocketsUnder } from './test-rust.mjs';

test('npm run test:rust is the isolating wrapper', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:rust'], 'node scripts/test-rust.mjs');
});

test('the cargo run is always sequential, whatever the caller adds, and forwards harness args', () => {
  const base = ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features'];
  assert.deepEqual(cargoArgs(), [...base, '--', '--test-threads=1']);
  // Before the caller's `--`: cargo's side. After it: the harness's side.
  assert.deepEqual(cargoArgs(['tmux::tests']), [...base, 'tmux::tests', '--', '--test-threads=1']);
  assert.deepEqual(cargoArgs(['--', '--nocapture']), [...base, '--', '--nocapture', '--test-threads=1']);
  assert.deepEqual(cargoArgs(['--lib', 'tmux::tests', '--', '--exact', '--nocapture']),
    [...base, '--lib', 'tmux::tests', '--', '--exact', '--nocapture', '--test-threads=1']);
  // A caller's --test-threads cannot win: ours is last (libtest: last one wins).
  assert.deepEqual(cargoArgs(['tmux::tests', '--', '--test-threads=8']).slice(-3), ['--', '--test-threads=8', '--test-threads=1']);
  // A second `--` from the caller stays where the caller put it (harness side).
  assert.deepEqual(cargoArgs(['--', 'x', '--', 'y']), [...base, '--', 'x', '--', 'y', '--test-threads=1']);
});

test('the test process cannot see the real tmux: TMUX/TMUX_PANE gone, TMUX_TMPDIR fresh', () => {
  const env = isolatedEnv({ TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/tmp', PATH: '/bin' }, '/tmp/iso-x');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.TMUX_TMPDIR, '/tmp/iso-x');
  assert.equal(env.PATH, '/bin', 'everything else is kept');
});

test('a run creates the dir, hands it to cargo, kills only servers under it by -S, and removes it', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { spawnSync: realSpawn } = await import('node:child_process');
  const calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  let dirSeen = '';
  const code = runTestRust({
    extra: ['tmux::tests'],
    env: { TMUX: '/tmp/tmux-1000/default,1,0', HOME: '/home/x' },
    log: () => {},
    spawn: ((cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
      calls.push({ cmd, args, env: opts.env });
      if (cmd === 'cargo') {
        dirSeen = opts.env?.TMUX_TMPDIR ?? '';
        // What a test that left a server behind looks like: a socket inode
        // under <dir>/tmux-<uid>/. No listener — nothing is started here.
        const sockDir = join(dirSeen, 'tmux-1000');
        mkdirSync(sockDir);
        const made = realSpawn('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(join(sockDir, 'default'))})`]);
        assert.equal(made.status, 0, String(made.stderr));
      }
      return { status: 3 };
    }) as unknown as typeof import('node:child_process').spawnSync,
  });
  assert.equal(code, 3, 'cargo’s exit code is the wrapper’s');
  assert.equal(calls[0].cmd, 'cargo');
  assert.ok(dirSeen.includes('tmm-test-rust-'), dirSeen);
  assert.equal(calls[0].env?.TMUX, undefined);
  assert.equal(calls[0].env?.TMUX_PANE, undefined);
  // The cleanup: exactly one kill, carrying -S, aimed inside the run dir.
  const kills = calls.filter((x) => x.cmd === 'tmux');
  assert.deepEqual(kills.map((k) => k.args), [['-S', join(dirSeen, 'tmux-1000', 'default'), 'kill-server']]);
  assert.ok(!existsSync(dirSeen), 'the dir is removed afterwards');
});

test('serverSocketsUnder finds tmux-<uid>/<name> sockets only', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'tmm-sockets-'));
  try {
    mkdirSync(join(dir, 'tmux-1000'));
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'tmux-1000', 'not-a-socket'), '');
    const sock = join(dir, 'tmux-1000', 'default');
    // A real socket inode without a listener: python's socket.bind creates
    // one and the process exits; the file stays. No server is started here.
    const made = spawnSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(sock)})`]);
    assert.equal(made.status, 0, String(made.stderr));
    assert.deepEqual(serverSocketsUnder(dir), [sock]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
