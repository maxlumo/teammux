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
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { cargoTargetDir, lockFile, lockedCommand, withTargetDir } from './target-lock.mjs';

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Round 2 (reviewer P1-R1): the lock must guard the directory cargo ACTUALLY
// writes to. A forwarded --target-dir wins; otherwise cargo itself says
// (`cargo metadata` target_directory: CARGO_TARGET_DIR, CARGO_BUILD_TARGET_DIR,
// build.target-dir in .cargo/config.toml, the default), made canonical.
function crate() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmm-crate-')));
  mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n');
  writeFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), '');
  return root;
}
const bare = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.HOME ?? '', '.cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME ?? '', '.rustup') };

test('the locked directory is the one cargo writes to, from every source cargo reads, canonical (#35 round 2)', () => {
  const root = crate();
  try {
    const at = (args: string[], env: Record<string, string> = {}) => cargoTargetDir({ args, env: { ...bare, ...env }, root });
    assert.deepEqual(at([]), { dir: join(root, 'src-tauri', 'target') }, 'the default');
    assert.deepEqual(at([], { CARGO_TARGET_DIR: join(root, 'a') }), { dir: join(root, 'a') });
    assert.deepEqual(at([], { CARGO_BUILD_TARGET_DIR: join(root, 'b') }), { dir: join(root, 'b') }, 'validator-2: CARGO_BUILD_TARGET_DIR');
    mkdirSync(join(root, '.cargo'));
    writeFileSync(join(root, '.cargo', 'config.toml'), `[build]\ntarget-dir = "${join(root, 'c')}"\n`);
    assert.deepEqual(at([]), { dir: join(root, 'c') }, 'build.target-dir in the project\'s .cargo/config.toml');
    assert.deepEqual(at(['test', '--target-dir', 'd', '--', '--target-dir=x']), { dir: join(root, 'd') }, 'a forwarded flag wins, relative to the root; harness args are not cargo\'s');
    assert.deepEqual(at(['--target-dir=e']), { dir: join(root, 'e') });
    symlinkSync(join(root, 'e'), join(root, 'e-link'));
    assert.deepEqual(at(['--target-dir', 'e-link']), at(['--target-dir', 'e']), 'two spellings of one directory, one lock');
    assert.match(cargoTargetDir({ args: [], env: { PATH: '/nonexistent' }, root }).why ?? '', /cargo metadata/u, 'no cargo: a reason, never a guess');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cargo is given exactly the locked directory, whatever --target-dir it was handed (#35 round 2)', () => {
  assert.deepEqual(withTargetDir(['test', '--lib', '--', '--exact'], '/t'), ['test', '--lib', '--target-dir', '/t', '--', '--exact']);
  assert.deepEqual(withTargetDir(['check', '--target-dir', 'x', '--target-dir=y'], '/t'), ['check', '--target-dir', '/t']);
  assert.deepEqual(withTargetDir(['test', '--', '--target-dir', 'z'], '/t'), ['test', '--target-dir', '/t', '--', '--target-dir', 'z'], 'harness args untouched');
});

test('test:rust with --target-dir X and check:android with CARGO_TARGET_DIR=X take ONE lock; different directories take two (#35 round 2)', () => {
  const root = crate();
  try {
    const x = join(root, 'shared');
    const rust = cargoTargetDir({ args: ['test', '--target-dir', x], env: bare, root });
    const android = cargoTargetDir({ args: ['check', '--lib'], env: { ...bare, CARGO_TARGET_DIR: x }, root });
    assert.equal(lockFile(rust.dir!), lockFile(android.dir!));
    const other = cargoTargetDir({ args: ['check'], env: { ...bare, CARGO_TARGET_DIR: join(root, 'other') }, root });
    assert.notEqual(lockFile(other.dir!), lockFile(rust.dir!));
  } finally { rmSync(root, { recursive: true, force: true }); }
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
