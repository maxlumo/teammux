// Board #137: every test entry refuses outside the isolated runner, starting nothing, and names the command
// to use. These run INSIDE the runner (pnpm test there); the refusal is shown by spawning each entry with
// the runner's marker REMOVED from its environment, never by running anything on the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { insideRunner, refusal, requireIsolated, shellCommand, OVERRIDE, OVERRIDE_VALUE, REFUSED } from './isolation-guard.mjs';
import { nodeTestArgs, GLOBS } from './test-node.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inRunner = insideRunner();

test('inside means the marker AND a container; an environment variable alone is not enough', () => {
  const box = mkdtempSync(join(tmpdir(), 'guard-'));
  const dockerenv = join(box, '.dockerenv');
  assert.equal(insideRunner({ env: { ISOLATED_RUNNER: '1' }, dockerenv }), false, 'the marker typed on a host');
  writeFileSync(dockerenv, '');
  assert.equal(insideRunner({ env: {}, dockerenv }), false, 'a container without the runner');
  assert.equal(insideRunner({ env: { ISOLATED_RUNNER: '1' }, dockerenv }), true);
  assert.equal(insideRunner({ env: { ISOLATED_RUNNER: 'yes' }, dockerenv }), false);
  rmSync(box, { recursive: true, force: true });
});

test('a refusal names the command to use and the one override, and exits without returning', () => {
  const said: string[] = [];
  let code: number | undefined;
  const exit = ((c: number) => { code = c; throw new Error('exited'); }) as (c: number) => never;
  assert.throws(() => requireIsolated(['pnpm', 'test'], { env: {}, dockerenv: '/no/such/dockerenv', log: (m: string) => said.push(m), exit }), /exited/u);
  assert.equal(code, REFUSED);
  assert.deepEqual(said, [refusal(['pnpm', 'test'])]);
  assert.equal(refusal(['pnpm', 'test']), [
    'refused: `pnpm test` runs tests, and tests run only inside the isolated runner (owner, 2026-11-06: no test on this host).',
    '  use: node scripts/isolated.mjs -- pnpm test',
    `  a person at this terminal who means to run it here, and only a person: ${OVERRIDE}=${OVERRIDE_VALUE} pnpm test`,
  ].join('\n'));
  // The override is one exact value: anything else is refused.
  for (const value of ['1', 'true', 'yes', OVERRIDE_VALUE.toUpperCase(), '']) {
    assert.throws(() => requireIsolated(['pnpm', 'test'], { env: { [OVERRIDE]: value }, dockerenv: '/no/such', log: () => {}, exit }), /exited/u, `value ${JSON.stringify(value)}`);
  }
  assert.doesNotThrow(() => requireIsolated(['pnpm', 'test'], { env: { [OVERRIDE]: OVERRIDE_VALUE }, dockerenv: '/no/such', log: () => {}, exit }));
});

/** The caller's environment without the runner's marker (and without any override). */
function outsideEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...extra };
  delete env.ISOLATED_RUNNER;
  delete env[OVERRIDE];
  // A child of node --test reports to its parent through another channel when it inherits this, which
  // would make 'no ℹ tests on stdout' true for any run: the child must print as a person's run does.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** A PATH whose `cargo` only records that it was started. */
function fakeCargo() {
  const box = mkdtempSync(join(tmpdir(), 'guard-cargo-'));
  const started = join(box, 'cargo-started');
  writeFileSync(join(box, 'cargo'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(started)}\nexit 0\n`);
  chmodSync(join(box, 'cargo'), 0o755);
  return { box, started, path: `${box}:${process.env.PATH}` };
}

test('pnpm run test:rust outside the runner refuses, starts no cargo, and says exactly what to run', { skip: !inRunner && 'runs only inside the isolated runner' }, () => {
  const cargo = fakeCargo();
  const r = spawnSync(process.execPath, [join(repo, 'scripts/test-rust.mjs'), '--lib', 'local_socket'], { cwd: repo, env: outsideEnv({ PATH: cargo.path }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, REFUSED, r.stderr);
  assert.equal(r.stderr.trim(), refusal(['pnpm', 'run', 'test:rust', '--lib', 'local_socket']));
  assert.equal(existsSync(cargo.started), false, 'no cargo was started');
  rmSync(cargo.box, { recursive: true, force: true });
});

test('with the runner marker test:rust goes on to cargo as before', { skip: !inRunner && 'runs only inside the isolated runner' }, () => {
  const cargo = fakeCargo();
  const r = spawnSync(process.execPath, [join(repo, 'scripts/test-rust.mjs'), '--lib', 'nothing_matches_this'], { cwd: repo, env: { ...process.env, PATH: cargo.path } as Record<string, string>, encoding: 'utf8', timeout: 120_000 });
  assert.equal(existsSync(cargo.started), true, `past the guard, cargo is started (its first call is the target lookup): ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /refused:/u);
  rmSync(cargo.box, { recursive: true, force: true });
});

test('pnpm test outside the runner refuses before node --test starts', { skip: (!inRunner || process.env.GUARD_SELFTEST === '1') && 'inside the runner, and not from its own child' }, () => {
  // GUARD_SELFTEST stops a recursion should the guard ever fail open: the child's own suite skips this case.
  const r = spawnSync('pnpm', ['test'], { cwd: repo, env: outsideEnv({ GUARD_SELFTEST: '1' }), encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(refusal(['pnpm', 'test'])), `the refusal: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ℹ tests \d/u, 'no test ran');
});

test('every package.json entry that executes tests goes through the guard first; check stays bare', () => {
  const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts as Record<string, string>;
  assert.equal(scripts.test, 'node scripts/test-node.mjs', 'one shape with test:rust, no && prefix (reviewer R1)');
  const node = readFileSync(join(repo, 'scripts/test-node.mjs'), 'utf8');
  assert.match(node, /if \(isMain\) \{\s*const extra = process\.argv\.slice\(2\);\s*requireIsolated\(\['pnpm', 'test', \.\.\.extra\]\);/u, 'test-node.mjs asks before anything else, with its real argv');
  assert.equal(scripts['test:rust'], 'node scripts/test-rust.mjs');
  const rust = readFileSync(join(repo, 'scripts/test-rust.mjs'), 'utf8');
  assert.match(rust, /if \(isMain\) \{ requireIsolated\(/u, 'test-rust.mjs asks before anything else');
  assert.equal(scripts.check, 'svelte-check --tsconfig ./tsconfig.json', 'the documented bare exception');
  assert.equal(scripts['check:android'], 'node scripts/preflight.mjs android-check');
  // The Docker entries build their own containers and run nothing on the host (#137 non-goal, checked).
  assert.equal(scripts['test:e2e:docker'], 'node scripts/e2e-docker.mjs');
  assert.equal(scripts['test:live:docker'], 'node scripts/live-docker.mjs');
});

// Validator #137 note 4 / leader note 5: the advice is the refused command argument for argument. Replayed
// by a real shell (printf, no test starts), each rendered word comes back exactly as it was given.
test('the advice keeps every argument boundary: a shell replays it to the same argv', () => {
  const argv = ['pnpm', 'run', 'test:rust', '--lib', 'local_socket', '--target-dir', '/tmp/x/target with space', "it's", '', 'a"b', '$HOME', 'x;rm', '*'];
  const shown = shellCommand(argv);
  const replay = spawnSync('sh', ['-c', `printf '%s\\0' ${shown}`], { encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(replay.stdout.split('\0').slice(0, -1), argv);
  assert.equal(shellCommand(['pnpm', 'test']), 'pnpm test', 'a simple command reads as before');
  const text = refusal(argv);
  assert.ok(text.includes(`use: node scripts/isolated.mjs -- ${shown}`), 'the Docker advice');
  assert.ok(text.includes(`${OVERRIDE}=${OVERRIDE_VALUE} ${shown}`), 'and the override line render it the same way');
});

test('test:rust refused with a spaced --target-dir prints it quoted, as one argument', { skip: !inRunner && 'runs only inside the isolated runner' }, () => {
  const cargo = fakeCargo();
  const args = ['--lib', 'local_socket', '--target-dir', '/tmp/guard x/target with space'];
  const r = spawnSync(process.execPath, [join(repo, 'scripts/test-rust.mjs'), ...args], { cwd: repo, env: outsideEnv({ PATH: cargo.path }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, REFUSED);
  assert.equal(r.stderr.trim(), refusal(['pnpm', 'run', 'test:rust', ...args]));
  assert.ok(r.stderr.includes("--target-dir '/tmp/guard x/target with space'"), r.stderr);
  assert.equal(existsSync(cargo.started), false);
  rmSync(cargo.box, { recursive: true, force: true });
});

// Reviewer #137 R1 (leader note 12): 'pnpm test -- <args>' is refused as itself, arguments included, and
// with the marker the arguments reach node --test (a name pattern filters as before).
test('pnpm test with arguments is refused as the same command, arguments included', { skip: (!inRunner || process.env.GUARD_SELFTEST === '1') && 'inside the runner, and not from its own child' }, () => {
  const r = spawnSync('pnpm', ['test', '--test-name-pattern', 'a b'], { cwd: repo, env: outsideEnv({ GUARD_SELFTEST: '1' }), encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(refusal(['pnpm', 'test', '--test-name-pattern', 'a b'])), `the refusal names the same command: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ℹ tests \d/u, 'no test ran');
});

test('the caller\'s arguments go to node --test before the globs; a lone leading -- is dropped', () => {
  assert.deepEqual(nodeTestArgs([]), ['--test', ...GLOBS]);
  assert.deepEqual(nodeTestArgs(['--test-name-pattern', 'x']), ['--test', '--test-name-pattern', 'x', ...GLOBS]);
  assert.deepEqual(nodeTestArgs(['--', '--test-name-pattern', 'x']), ['--test', '--test-name-pattern', 'x', ...GLOBS]);
});

test('with the marker, pnpm test passes a name pattern through and runs only what it names', { skip: (!inRunner || process.env.GUARD_SELFTEST === '1') && 'inside the runner, and not from its own child' }, () => {
  const r = spawnSync('pnpm', ['test', '--test-name-pattern', 'a lone leading -- is dropped$'], { cwd: repo, env: (() => { const e: Record<string, string> = { ...process.env as Record<string, string>, GUARD_SELFTEST: '1' }; delete e.NODE_TEST_CONTEXT; return e; })(), encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.doesNotMatch(r.stderr, /refused:/u);
  assert.match(r.stdout, /✔ the caller's arguments go to node --test before the globs; a lone leading -- is dropped/u, 'the named test ran');
  assert.doesNotMatch(r.stdout, /✔ inside means the marker AND a container/u, 'and another test of the same file did not');
});
