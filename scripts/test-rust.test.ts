import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cargoArgs, isolatedEnv, runTestRust, serverSocketsUnder } from './test-rust.mjs';

test('npm run test:rust is the isolating wrapper', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:rust'], 'node scripts/test-rust.mjs');
});

test('the cargo run is always sequential, whatever the caller adds', () => {
  assert.deepEqual(cargoArgs(), ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--', '--test-threads=1']);
  // A filter passes through; a caller's --test-threads cannot win (libtest: last one wins).
  assert.deepEqual(cargoArgs(['tmux::tests', '--', '--test-threads=8']).slice(-2), ['--', '--test-threads=1']);
  assert.ok(cargoArgs(['tmux::tests']).includes('tmux::tests'));
});

test('the test process cannot see the real tmux: TMUX/TMUX_PANE gone, TMUX_TMPDIR fresh', () => {
  const env = isolatedEnv({ TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/tmp', PATH: '/bin' }, '/tmp/iso-x');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.TMUX_TMPDIR, '/tmp/iso-x');
  assert.equal(env.PATH, '/bin', 'everything else is kept');
});

test('a run creates the dir, hands it to cargo, kills only servers under it, and removes it', () => {
  const calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  let dirSeen = '';
  const code = runTestRust({
    extra: ['tmux::tests'],
    env: { TMUX: '/tmp/tmux-1000/default,1,0', HOME: '/home/x' },
    log: () => {},
    spawn: ((cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
      calls.push({ cmd, args, env: opts.env });
      if (cmd === 'cargo') dirSeen = opts.env?.TMUX_TMPDIR ?? '';
      return { status: 3 };
    }) as unknown as typeof import('node:child_process').spawnSync,
  });
  assert.equal(code, 3, 'cargo’s exit code is the wrapper’s');
  assert.equal(calls[0].cmd, 'cargo');
  assert.ok(dirSeen.includes('tmm-test-rust-'), dirSeen);
  assert.equal(calls[0].env?.TMUX, undefined);
  // No server was created under the dir, so no kill-server was issued at all —
  // and never one without -S.
  for (const c of calls.filter((x) => x.cmd === 'tmux')) {
    assert.equal(c.args[0], '-S');
    assert.ok(c.args[1].startsWith(dirSeen), `only servers under the throwaway dir: ${c.args[1]}`);
  }
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
