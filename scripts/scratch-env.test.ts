// Board #14 (incident 2026-11-05 08:06, builder-3): a scratch gateway started
// from an agent's pane inherited TMUX/TMUX_PANE and drove the LIVE tmux server
// (tmux.rs reads $TMUX before TMUX_TMPDIR); its UI listed the live sessions.
// scratch-env.mjs starts a command with test-rust.mjs's isolatedEnv (the one
// definition of "kept away from the real tmux and gateway") and checks a
// running process for any name that survived.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync, realpathSync, mkdirSync, writeFileSync, lstatSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliExecutables, configChanges, leaks, outsideLinks, realConfigHashes, runScratch } from './scratch-env.mjs';

const nul = (pairs: string[]) => pairs.join('\0') + '\0';

test('a process is routed privately only when TMUX_TMPDIR and the XDG roots are THE scratch dir, and nothing live-pointing survived (#14 review)', () => {
  const dir = '/tmp/b3-x/gw';
  const ok = ['PATH=/bin', `TMUX_TMPDIR=${dir}`, `XDG_CONFIG_HOME=${dir}/xdg-config`, `XDG_DATA_HOME=${dir}/xdg-data`, `XDG_STATE_HOME=${dir}/xdg-state`,
    'DISABLE_AUTOUPDATER=1', 'DISABLE_UPDATES=1', 'KIMI_CODE_NO_AUTO_UPDATE=1', 'KIRO_NO_AUTO_UPDATE=1'];
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

// Board #30: macOS has no /proc. Its NUL-separated source is
// sysctl(KERN_PROCARGS2), read for our own processes through the host's
// python3: argc (int32 LE), the exec path, NUL padding, argc argv strings,
// the environment, an empty string, then the kernel's apple strings. Round 1
// (reviewer P1-R1): `ps -E` joins with spaces, so a value could forge a
// variable. Captured on clawdbjs (macOS 27.0.1) from `env -i PATH=/usr/bin:/bin
// XDG_*_HOME=/s/gw/xdg-* NOTE="diagnostic TMUX_TMPDIR=/s/gw" node -e … 
// TMUX_TMPDIR=/s/gw "two words"`, cut inside the padding before the apple
// strings (they name the host's boot and binary hashes).
const MAC_FORGED = Buffer.from(
  '050000002f6f70742f686f6d65627265772f62696e2f6e6f646500002f6f70742f686f6d65627265772f62696e2f6e6f6465002d650073657454696d656f7574'
  + '2828293d3e7b7d2c32303030302900544d55585f544d504449523d2f732f67770074776f20776f72647300504154483d2f7573722f62696e3a2f62696e005844'
  + '475f434f4e4649475f484f4d453d2f732f67772f7864672d636f6e666967005844475f444154415f484f4d453d2f732f67772f7864672d64617461005844475f'
  + '53544154455f484f4d453d2f732f67772f7864672d7374617465004e4f54453d646961676e6f7374696320544d55585f544d504449523d2f732f677700000000', 'hex');
const MAC_ENV = ['PATH=/usr/bin:/bin', 'XDG_CONFIG_HOME=/s/gw/xdg-config', 'XDG_DATA_HOME=/s/gw/xdg-data', 'XDG_STATE_HOME=/s/gw/xdg-state', 'NOTE=diagnostic TMUX_TMPDIR=/s/gw'];
// /bin/sleep 5, a platform binary: the kernel gives its argv and no environment.
const MAC_SLEEP = Buffer.from('020000002f62696e2f736c6565700000000000002f62696e2f736c65657000350' + '0', 'hex');

test('the macOS process arguments yield exactly the environment: the argv copy is cut, each value kept whole (#30)', async () => {
  const { procargsEnviron } = await import('./scratch-env.mjs');
  assert.deepEqual(procargsEnviron(MAC_FORGED), { environ: nul(MAC_ENV) });
});

test('a TMUX_TMPDIR forged inside another value, or in argv, does not pass the check on macOS: it is unset, as on Linux (#30 round 1)', async () => {
  const { procargsEnviron } = await import('./scratch-env.mjs');
  const found = leaks(procargsEnviron(MAC_FORGED).environ, '/s/gw');
  // Captured before #48: the no-update switches are missing as well, and said after it.
  assert.deepEqual(found[0], "TMUX_TMPDIR is unset (tmux falls back to /tmp, the live server's socket dir), not /s/gw");
  assert.deepEqual(found.slice(1).map((l) => l.split(' ')[0]), ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'KIMI_CODE_NO_AUTO_UPDATE', 'KIRO_NO_AUTO_UPDATE']);
  assert.deepEqual(leaks(nul(MAC_ENV), '/s/gw'), found, 'the same verdict Linux gives the same environment');
});

test('process arguments with no environment, or cut short, are unreadable, never empty (#30)', async () => {
  const { procargsEnviron } = await import('./scratch-env.mjs');
  assert.match(procargsEnviron(MAC_SLEEP).why, /no environment/, 'a platform binary hides its environment');
  assert.match(procargsEnviron(MAC_FORGED.subarray(0, 3)).why, /cut short/);
  assert.match(procargsEnviron(MAC_FORGED.subarray(0, 0x40)).why, /cut short/, 'inside argv');
  assert.match(procargsEnviron(MAC_FORGED.subarray(0, 0xe0)).why, /cut short/, 'inside a value: never a shorter value');
});

test('check reads the environment per platform and fails with the reason when it cannot (#30)', async () => {
  const { environOf } = await import('./scratch-env.mjs');
  const ok = () => ({ status: 0, stdout: MAC_FORGED, stderr: Buffer.alloc(0) });
  assert.deepEqual(environOf('42', { platform: 'darwin', run: ok }).environ, nul(MAC_ENV));
  assert.match(environOf('42', { platform: 'darwin', run: () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('sysctl: errno 22\n') }) }).why, /pid 42.*errno 22/u, 'gone, or not ours (EINVAL)');
  assert.match(environOf('42', { platform: 'darwin', run: () => ({ error: new Error('spawn /usr/bin/python3 ENOENT') }) }).why, /python3 ENOENT/u);
  assert.match(environOf('42', { platform: 'freebsd' }).why, /freebsd/, 'an unknown platform is not a pass');
  const missing = () => { throw new Error("ENOENT: no such file or directory, open '/proc/42/environ'"); };
  assert.match(environOf('42', { platform: 'linux', readFile: missing }).why, /\/proc\/42\/environ/u);
});

test('on Linux, check reads the real /proc environment (#30)', { skip: process.platform !== 'linux' }, async () => {
  const { environOf } = await import('./scratch-env.mjs');
  assert.equal(environOf(String(process.pid)).environ, readFileSync(`/proc/${process.pid}/environ`, 'utf8'));
  assert.match(environOf('999999999').why, /\/proc\/999999999\/environ/u);
});

// Board #48 (incidents 08:00 and 08:55 on 2026-11-06): a scratch claude
// self-updated into the scratch XDG_DATA_HOME and relinked the REAL
// ~/.local/bin/claude there (HOME stays real); deleting the dir left every
// claude on the host 'not found'. Measured: DISABLE_AUTOUPDATER=1 stops it.
test('run starts the command with every CLI\'s documented no-update switch, and check reports one missing (#48)', async () => {
  const { UPDATE_SWITCHES } = await import('./scratch-env.mjs');
  assert.deepEqual(UPDATE_SWITCHES, { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIRO_NO_AUTO_UPDATE: '1' });
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const dir = join(root, 'gw');
    let env: Record<string, string | undefined> = {};
    const spawn = (_c: string, _a: string[], opts: { env: Record<string, string | undefined> }) => { env = opts.env; return { pid: 9, unref() {} }; };
    runScratch({ dir, argv: ['./server'], env: { PATH: '/bin', DISABLE_AUTOUPDATER: '0' }, spawn, home: join(root, 'home') });
    for (const [k, v] of Object.entries(UPDATE_SWITCHES)) assert.equal(env[k], v, k);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const dir = '/tmp/b3-x/gw';
  const ok = ['PATH=/bin', `TMUX_TMPDIR=${dir}`, `XDG_CONFIG_HOME=${dir}/xdg-config`, `XDG_DATA_HOME=${dir}/xdg-data`, `XDG_STATE_HOME=${dir}/xdg-state`];
  const all = Object.entries(UPDATE_SWITCHES).map(([k, v]) => `${k}=${v}`);
  assert.deepEqual(leaks(nul([...ok, ...all]), dir), []);
  assert.deepEqual(leaks(nul([...ok, ...all.filter((kv) => !kv.startsWith('DISABLE_AUTOUPDATER='))]), dir), ['DISABLE_AUTOUPDATER is unset, not 1 (the CLI may update itself and relink the real ~/.local/bin)']);
});

test('check reports a link in the real ~/.local/bin that now points into the scratch dir, with what it pointed at before (#48, the 08:00 shape)', async () => {
  const { snapshotLinks, escapedLinks } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync, writeFileSync, unlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = join(root, 'home');
    const dir = join(root, 'gw');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
    const real = join(home, '.local', 'share', 'claude', 'versions', '2.1.319');
    writeFileSync(real, '');
    symlinkSync(real, join(home, '.local', 'bin', 'claude'));
    symlinkSync('/usr/bin/env', join(home, '.local', 'bin', 'other'));
    mkdirSync(join(dir, 'xdg-data', 'claude', 'versions'), { recursive: true });
    const before = snapshotLinks(home);
    assert.equal(before[join(home, '.local', 'bin', 'claude')], real);
    assert.deepEqual(escapedLinks(home, dir, before), [], 'nothing points into the scratch dir yet');
    // The 08:00 shape: claude's updater installs into the scratch XDG_DATA_HOME and relinks.
    const inside = join(dir, 'xdg-data', 'claude', 'versions', '2.1.319');
    writeFileSync(inside, '');
    unlinkSync(join(home, '.local', 'bin', 'claude'));
    symlinkSync(inside, join(home, '.local', 'bin', 'claude'));
    // And a brand-new link into the scratch dir.
    symlinkSync(inside, join(home, '.local', 'bin', 'claude-new'));
    assert.deepEqual(escapedLinks(home, dir, before), [
      `${join(home, '.local', 'bin', 'claude')} -> ${inside}, inside the scratch dir (it was ${real}: ln -sfn ${real} ${join(home, '.local', 'bin', 'claude')})`,
      `${join(home, '.local', 'bin', 'claude-new')} -> ${inside}, inside the scratch dir (it did not exist before the run)`,
    ]);
    assert.deepEqual(escapedLinks(home, dir, null).length, 2, 'found without a snapshot too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// #48 round 1 (reviewer 10:04, validator's probes): the guard must never report clean on an
// observation it could not make (#29's rule), must see through a symlinked path, and must
// print a repair a shell runs as written.
test('a link dir that cannot be read is a failed check, never "none escaped" (#48 round 1)', { skip: process.getuid?.() === 0 }, async () => {
  const { escapedLinks } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  const bin = join(root, 'home', '.local', 'bin');
  try {
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'gw'));
    symlinkSync(join(root, 'gw', 'v', 'claude'), join(bin, 'claude'));
    chmodSync(bin, 0o000);
    const found = escapedLinks(join(root, 'home'), join(root, 'gw'), {});
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0]!, new RegExp(`^${bin} could not be read \\(EACCES`), 'its reason, so nothing reads as clean');
  } finally { chmodSync(bin, 0o755); rmSync(root, { recursive: true, force: true }); }
});

test('a link that reaches the scratch dir through another symlink is caught, and its repair is quoted (#48 round 1)', async () => {
  const { escapedLinks } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const dir = join(root, 'gw');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'v'), { recursive: true });
    writeFileSync(join(dir, 'v', 'claude'), '');
    symlinkSync(dir, join(root, 'alias')); // alias -> the scratch dir
    symlinkSync(join(root, 'alias', 'v', 'claude'), join(bin, 'codex'));
    const was = join(root, 'real dir', "it's", 'claude');
    const found = escapedLinks(home, dir, { [join(bin, 'codex')]: was });
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.ok(found[0]!.includes(`ln -sfn '${join(root, 'real dir')}/it'\\''s/claude' ${join(bin, 'codex')}`), found[0]);
    // A dangling link into a scratch dir that is already gone is still caught.
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(join(dir, 'gone', 'claude'), join(bin, 'claude'));
    assert.equal(escapedLinks(home, dir, null).length, 2, 'both, the dir deleted or not');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the private server env: confirmed absent is no server; any other tmux error fails the check (#48 round 1)', async () => {
  const { serverEnvVerdict } = await import('./scratch-env.mjs');
  assert.deepEqual(serverEnvVerdict({ status: 1, stdout: '', stderr: 'no server running on /s/gw/tmux-1000/default\n' }), { none: true });
  assert.deepEqual(serverEnvVerdict({ status: 1, stdout: '', stderr: 'error connecting to /s/gw/tmux-1000/default (No such file or directory)\n' }), { none: true });
  assert.deepEqual(serverEnvVerdict({ status: 1, stdout: '', stderr: 'error connecting to /s/gw/tmux-1000/default (Permission denied)\n' }),
    { why: 'tmux could not be asked: error connecting to /s/gw/tmux-1000/default (Permission denied)' });
  assert.deepEqual(serverEnvVerdict({ error: new Error('spawn tmux ENOENT') }), { why: 'tmux could not be asked: spawn tmux ENOENT' });
  assert.deepEqual(serverEnvVerdict({ status: 0, stdout: 'A=1\n-B\nC=2\n', stderr: '' }), { environ: 'A=1\0C=2\0' });
});

test('check, the command: an unreadable link dir fails it with the reason and never prints the all-clear line (#48 round 1)', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  const home = join(root, 'home');
  const bin = join(home, '.local', 'bin');
  const dir = join(root, 'gw');
  const script = join(import.meta.dirname, 'scratch-env.mjs');
  const env = { ...process.env, HOME: home };
  try {
    mkdirSync(bin, { recursive: true });
    assert.equal(spawnSync(process.execPath, [script, 'run', dir, '--', '/bin/sleep', '20'], { env }).status, 0);
    const clean = spawnSync(process.execPath, [script, 'check', dir], { env, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /none of the user's CLI links/u);
    chmodSync(bin, 0o000);
    const r = spawnSync(process.execPath, [script, 'check', dir], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`${bin} could not be read \\(EACCES\\)`, 'u'));
    assert.doesNotMatch(r.stdout, /none of the user's CLI links/u, 'no all-clear on a failed observation');
  } finally {
    chmodSync(bin, 0o755);
    try { process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 'SIGTERM'); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('the scratch root is compared as the filesystem resolves it, however it is spelt (#48 round 1)', async () => {
  const { escapedLinks } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'gw', 'v'), { recursive: true });
    mkdirSync(join(root, 'x'));
    writeFileSync(join(root, 'gw', 'v', 'claude'), '');
    symlinkSync(join(root, 'gw', 'v', 'claude'), join(bin, 'claude')); // the direct 08:00 case
    symlinkSync(join(root, 'gw'), join(root, 'gw-alias'));
    for (const spelt of [join(root, 'gw'), `${root}/x/../gw`, join(root, 'gw-alias'), `${root}/gw/`]) {
      assert.equal(escapedLinks(home, spelt, null).length, 1, spelt);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// #48 round 2 (reviewer at 59a3e4a5, validator's probes): the target resolver follows the
// kernel. '..' applies only after the symlinks before it are followed on disk, and only a
// confirmed missing component (ENOENT) takes the dangling fallback; anything else is unknown.
test('a target is resolved as the kernel does: alias/.. lands where realpath says, and the guard agrees (#48 round 2)', async () => {
  const { escapedLinks, resolveOnDisk } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  // The KERNEL's answer: libc realpath(3). Node's JS realpathSync normalises '..' lexically too.
  const kernelPath = (p: string) => realpathSync.native(p);
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const dir = join(root, 'gw');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(join(dir, 'v'));
    writeFileSync(join(dir, 'v', 'cli'), '');
    symlinkSync(join(dir, 'sub'), join(root, 'alias')); // alias -> gw/sub
    const raw = `${root}/alias/../v/cli`; // lexically root/v/cli, on disk gw/v/cli
    symlinkSync(raw, join(bin, 'cli'));
    const kernel = kernelPath(join(bin, 'cli'));
    assert.equal(kernel, join(kernelPath(dir), 'v', 'cli'), 'the kernel follows alias before ..');
    assert.deepEqual(resolveOnDisk(raw), { path: kernel }, 'the resolver gives the kernel\'s answer');
    assert.equal(escapedLinks(home, dir, null).length, 1, 'so the guard sees it inside the scratch dir');
    // A relative target, resolved from the link's own dir.
    symlinkSync('../../../gw/v/cli', join(bin, 'rel'));
    assert.deepEqual(resolveOnDisk(`${bin}/../../../gw/v/cli`), { path: kernelPath(join(bin, 'rel')) });
    assert.equal(escapedLinks(home, dir, null).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a target that cannot be resolved is unknown and fails the guard: an unreadable directory on the way, a loop (#48 round 2)', { skip: process.getuid?.() === 0 }, async () => {
  const { escapedLinks, resolveOnDisk } = await import('./scratch-env.mjs');
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  const locked = join(root, 'locked');
  try {
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const dir = join(root, 'gw');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'v'), { recursive: true });
    writeFileSync(join(dir, 'v', 'claude'), '');
    mkdirSync(locked);
    symlinkSync(dir, join(locked, 'alias'));
    symlinkSync(join(locked, 'alias', 'v', 'claude'), join(bin, 'claude'));
    assert.equal(escapedLinks(home, dir, null).length, 1, 'control: readable, it is inside');
    chmodSync(locked, 0o000);
    const found = escapedLinks(home, dir, null);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0]!, /its target could not be resolved .*EACCES/u, found[0]);
    chmodSync(locked, 0o755);
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    assert.match(resolveOnDisk(join(root, 'a', 'x')).why ?? '', /ELOOP/u, 'a loop is unknown, never a lexical guess');
    // Confirmed missing keeps the dangling fallback: a link into a deleted dir is still reported.
    assert.deepEqual(resolveOnDisk(join(dir, 'gone', 'claude')), { path: join(realpathSync(dir), 'gone', 'claude') });
  } finally { chmodSync(locked, 0o755); rmSync(root, { recursive: true, force: true }); }
});

// Board #54 (incident 2026-11-06 14:00:38 and 14:20:04): a managed codex home's config.toml is a
// symlink into the user's REAL ~/.codex/config.toml (codex.rs, by design, so the user's provider
// applies). A live check that edited the scratch agent's config.toml rewrote the user's provider
// URL to a dead fake port, and every codex started in the next 20 minutes read it.
const fakeUser = (root: string) => {
  const home = join(root, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "real"\n[model_providers.ust]\nbase_url = "https://real.example/v1"\n');
  writeFileSync(join(home, '.codex', 'personal.config.toml'), 'model = "p"\n', { mode: 0o600 });
  writeFileSync(join(home, '.codex', 'auth.json'), '{"k":"secret"}\n', { mode: 0o600 });
  writeFileSync(join(home, '.codex', 'history.jsonl'), 'not config\n');
  return home;
};
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('run gives the scratch a COPY of the user codex config the render links, never a link, so a write there leaves the real file alone (#54)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = fakeUser(root);
    const dir = join(root, 'gw');
    let env: Record<string, string | undefined> = {};
    const spawn = (_c: string, _a: string[], opts: { env: Record<string, string | undefined> }) => { env = opts.env; return { pid: 7, unref() {} }; };
    runScratch({ dir, argv: ['./server'], env: { PATH: '/bin', HOME: home }, spawn, home });
    const copy = join(dir, 'codex-user');
    assert.equal(env.CODEX_HOME, copy, 'the gateway renders from the copy');
    for (const name of ['config.toml', 'personal.config.toml', 'auth.json']) {
      const st = lstatSync(join(copy, name));
      assert.ok(st.isFile() && !st.isSymbolicLink(), `${name} is a regular file`);
      assert.equal(st.mode & 0o777, 0o600, `${name} is private`);
      assert.equal(readFileSync(join(copy, name), 'utf8'), readFileSync(join(home, '.codex', name), 'utf8'));
    }
    assert.ok(!existsSync(join(copy, 'history.jsonl')), 'only what the render links');
    const before = sha(join(home, '.codex', 'config.toml'));
    writeFileSync(join(copy, 'config.toml'), 'base_url = "http://127.0.0.1:19954/v1"\n');
    assert.equal(sha(join(home, '.codex', 'config.toml')), before, "the user's file is untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a link in a scratch home that resolves outside the scratch roots is named; one inside is not (#54)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = fakeUser(root);
    const dir = join(root, 'gw');
    const ws = join(root, 'ws');
    const agent = join(ws, '.tmm', 'agents', 'cx', 'codex');
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(dir, 'codex-user'), { recursive: true });
    writeFileSync(join(dir, 'codex-user', 'config.toml'), 'x\n');
    symlinkSync(join(dir, 'codex-user', 'config.toml'), join(agent, 'config.toml'));
    mkdirSync(join(ws, '.kiro', 'agents'), { recursive: true });
    symlinkSync(join(ws, '.tmm', 'agents', 'cx'), join(ws, '.kiro', 'agents', 'cx.json'));
    assert.deepEqual(outsideLinks([join(ws, '.tmm', 'agents')], [dir, ws]), []);
    symlinkSync(join(home, '.codex', 'auth.json'), join(agent, 'auth.json'));
    assert.deepEqual(outsideLinks([join(ws, '.tmm', 'agents')], [dir, ws]), [`${join(agent, 'auth.json')} → ${join(realpathSync(home), '.codex', 'auth.json')}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a change to the user's real CLI config during a run is reported by name (#54)", () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = fakeUser(root);
    const before = realConfigHashes(home, {});
    assert.ok(Object.keys(before).includes(join(home, '.codex', 'config.toml')), Object.keys(before).join(', '));
    assert.deepEqual(configChanges(before, realConfigHashes(home, {})), []);
    writeFileSync(join(home, '.codex', 'config.toml'), 'base_url = "http://127.0.0.1:19954/v1"\n');
    rmSync(join(home, '.codex', 'auth.json'));
    assert.deepEqual(configChanges(before, realConfigHashes(home, {})), [
      `${join(home, '.codex', 'config.toml')} changed`,
      `${join(home, '.codex', 'auth.json')} was removed`,
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 (validator-2 F1 on 80ce562b, live): codex 0.166.0 links its own arg0 helpers
// (tmp/arg0-linux/*/apply_patch, applypatch, codex-linux-sandbox) to its executable, so check was
// red on every codex run. A link whose real target is a NAMED CLI executable passes; a link to
// any config, credential or data file still fails.
test("a link to a named CLI's own executable passes, a config link out still fails (#54 round 1)", () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-env-test-'));
  try {
    const home = fakeUser(root);
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'notacli'), '#!/bin/sh\n', { mode: 0o755 });
    const exes = cliExecutables(bin);
    assert.deepEqual(exes, [realpathSync(join(bin, 'codex'))], 'only the named CLIs found on PATH');
    const dir = join(root, 'gw');
    const arg0 = join(root, 'ws', '.tmm', 'agents', 'cx', 'codex', 'tmp', 'arg0-linux', 'x');
    mkdirSync(arg0, { recursive: true });
    for (const n of ['apply_patch', 'applypatch', 'codex-linux-sandbox']) symlinkSync(join(bin, 'codex'), join(arg0, n));
    const agents = [join(root, 'ws', '.tmm', 'agents')];
    assert.deepEqual(outsideLinks(agents, [dir, join(root, 'ws')], exes), [], "codex's own helpers");
    symlinkSync(join(bin, 'notacli'), join(arg0, 'other'));
    symlinkSync(join(home, '.codex', 'config.toml'), join(arg0, 'config.toml'));
    assert.deepEqual(outsideLinks(agents, [dir, join(root, 'ws')], exes), [
      `${join(arg0, 'config.toml')} → ${join(realpathSync(home), '.codex', 'config.toml')}`,
      `${join(arg0, 'other')} → ${realpathSync(join(bin, 'notacli'))}`,
    ], 'a config link and an unnamed executable still fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
