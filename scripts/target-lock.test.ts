// Board #35 (retro, reviewer on #25): a Rust test run was spoiled twice on
// 2026-11-05 by another command in the same build directory, a
// `check:android` running alongside it (validator-2: 5 current_exe ENOENT
// failures, each passing alone) and a commit moving HEAD mid-run. The rule
// lived in a note; this pins the check that replaces it: one advisory lock
// per target directory, held by `test:rust` and `check:android` for their
// whole run, and the second one refuses at once, naming the holder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockFile, lockedCommand, targetDir } from './target-lock.mjs';

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('the target directory is CARGO_TARGET_DIR when set, else src-tauri/target', () => {
  assert.equal(targetDir({ CARGO_TARGET_DIR: '/tmp/t' }, '/repo'), '/tmp/t');
  assert.equal(targetDir({ CARGO_TARGET_DIR: 'rel' }, '/repo'), '/repo/rel', 'relative to the repo root, as cargo reads it from there');
  assert.equal(targetDir({}, '/repo'), '/repo/src-tauri/target');
  assert.equal(lockFile('/repo/src-tauri/target'), '/repo/src-tauri/target/.tmm-run.lock');
});

test('a second run refuses at once while the first holds the target dir, names it, and runs nothing; the lock is free after a kill (#35)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'tmm-lock-'));
  const marker = join(target, 'ran');
  const [hcmd, hargs] = lockedCommand(target, 'test:rust', 'sleep', ['30']);
  const holder = spawn(hcmd, hargs, { stdio: 'ignore' });
  try {
    await until(() => existsSync(lockFile(target)) && /test:rust/.test(readFileSync(lockFile(target), 'utf8')));
    const [cmd, args] = lockedCommand(target, 'check:android', 'touch', [marker]);
    const started = Date.now();
    const second = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(second.status, 75, 'refused, not waited');
    assert.ok(Date.now() - started < 3000, 'at once');
    assert.equal(existsSync(marker), false, 'its command never ran, so no artifact was touched');
    assert.match(second.stderr, /check:android/u);
    assert.match(second.stderr, new RegExp(`pid ${holder.pid}\\b`, 'u'), `names the holder's pid: ${second.stderr}`);
    assert.match(second.stderr, /test:rust/u);
    assert.match(second.stderr, /sleep 30/u, 'and its command');
    assert.match(second.stderr, /wait for it.*another worktree/isu, 'and the way out');
    assert.doesNotMatch(second.stderr, /\n\s*\n/u, `no empty line (validator-2 F2): ${JSON.stringify(second.stderr)}`);

    // A kill, even -9, releases the lock: it is the kernel's, not a file's.
    const child = Number(/child (\d+)/u.exec(readFileSync(lockFile(target), 'utf8'))?.[1]);
    holder.kill('SIGKILL');
    await until(() => holder.exitCode !== null || holder.signalCode !== null);
    if (child) try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    const third = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(third.status, 0, third.stderr);
    assert.equal(existsSync(marker), true, 'with the holder gone it runs');
  } finally {
    holder.kill('SIGKILL');
    rmSync(target, { recursive: true, force: true });
  }
});

test('a locked run passes on its command\'s exit status and creates the target dir (#35)', () => {
  const base = mkdtempSync(join(tmpdir(), 'tmm-lock-'));
  try {
    const target = join(base, 'fresh', 'target');
    const [cmd, args] = lockedCommand(target, 'test:rust', 'sh', ['-c', 'exit 3']);
    assert.equal(spawnSync(cmd, args).status, 3);
    assert.ok(existsSync(lockFile(target)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
