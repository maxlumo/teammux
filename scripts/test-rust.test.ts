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
  // Before the caller's `--`: cargo's side. After it: the harness's side,
  // with our flag FIRST (libtest reads options until a bare `--`).
  assert.deepEqual(cargoArgs(['tmux::tests']), [...base, 'tmux::tests', '--', '--test-threads=1']);
  assert.deepEqual(cargoArgs(['--', '--nocapture']), [...base, '--', '--test-threads=1', '--nocapture']);
  assert.deepEqual(cargoArgs(['--lib', 'tmux::tests', '--', '--exact', '--nocapture']),
    [...base, '--lib', 'tmux::tests', '--', '--test-threads=1', '--exact', '--nocapture']);
  // A caller's --test-threads in the option zone is DROPPED, in both spellings,
  // so there is exactly one and it is ours.
  assert.deepEqual(cargoArgs(['tmux::tests', '--', '--test-threads=8']), [...base, 'tmux::tests', '--', '--test-threads=1']);
  assert.deepEqual(cargoArgs(['--', '--test-threads', '8', '--nocapture']), [...base, '--', '--test-threads=1', '--nocapture']);
  // The reviewer's case: a second `--` on the harness side ends libtest's
  // option parsing, and what follows is filters. Ours must be BEFORE it;
  // the caller's filters stay after it untouched (even one that looks like a flag).
  assert.deepEqual(cargoArgs(['--', '--test-threads=4', '--', 'tmux::tests']),
    [...base, '--', '--test-threads=1', '--', 'tmux::tests']);
  assert.deepEqual(cargoArgs(['--', '--', '--test-threads=4']),
    [...base, '--', '--test-threads=1', '--', '--test-threads=4'], 'after the bare -- it is a filter string, and libtest will treat it as one');
  // Invariant over every shape: exactly one --test-threads before any bare --
  // on the harness side, and it is =1.
  for (const extra of [[], ['x'], ['--', '--nocapture'], ['--', '--test-threads=9'], ['--', '--test-threads', '9', '--', 'f'], ['--', '--', '--test-threads=9']]) {
    const argv = cargoArgs(extra);
    const harness = argv.slice(argv.indexOf('--') + 1);
    const stop = harness.indexOf('--');
    const optionZone = stop === -1 ? harness : harness.slice(0, stop);
    assert.deepEqual(optionZone.filter((a) => a.startsWith('--test-threads')), ['--test-threads=1'], JSON.stringify(extra));
  }
});

test('the test process cannot see the real tmux: TMUX/TMUX_PANE gone, TMUX_TMPDIR fresh', () => {
  const env = isolatedEnv({ TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/tmp', PATH: '/bin' }, '/tmp/iso-x');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.TMUX_TMPDIR, '/tmp/iso-x');
  assert.equal(env.PATH, '/bin', 'everything else is kept');
});

test('the test process cannot see its caller\'s gateway, identity or token: every TMM_* and TOKEN gone (#407)', () => {
  const env = isolatedEnv({
    TMM_SERVER: 'ws://127.0.0.1:9899', TMM_TOKEN: 'fake-tmm-token', TMM_PROJECT: 'tmux-mobile', TMM_AGENT: 'validator',
    TMM_STATE_DB: '/home/x/state.db', TOKEN: 'fake-token', TEAMMUX_GATEWAY_TMM: '/x/tmm', XDG_CONFIG_HOME: '/c', PATH: '/bin',
  }, '/tmp/iso-x');
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('TMM_')), []);
  assert.equal(env.TOKEN, undefined, 'Config::load reads bare TOKEN');
  assert.equal(env.TEAMMUX_GATEWAY_TMM, '/x/tmm', 'only the TMM_ prefix');
  assert.equal(env.PATH, '/bin');
});

test('an exported TMUX_SOCKET cannot point a test\'s gateway at the real server (#425 review)', () => {
  // Poison value only: nothing here connects to it. Config::from_parts prefers TMUX_SOCKET over everything.
  const env = isolatedEnv({ TMUX_SOCKET: '/tmp/tmux-1000/real-default', TMUX: '/tmp/tmux-1000/default,1,0', PATH: '/bin' }, '/tmp/iso-x');
  assert.equal(env.TMUX_SOCKET, undefined);
  assert.equal(env.TMUX_TMPDIR, '/tmp/iso-x');
});

test('a test process cannot reach the real config, data or state dir: the XDG roots are the run dir\'s (#425)', () => {
  // The incident: a rig that set only HOME ran a gateway on the real ~/.config,
  // because the config dir is XDG_CONFIG_HOME first, HOME second.
  const env = isolatedEnv({ XDG_CONFIG_HOME: '/home/x/.config', XDG_DATA_HOME: '/home/x/.local/share', XDG_STATE_HOME: '/home/x/.local/state', HOME: '/home/x', PATH: '/bin' }, '/tmp/iso-x');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/iso-x/xdg-config');
  assert.equal(env.XDG_DATA_HOME, '/tmp/iso-x/xdg-data');
  assert.equal(env.XDG_STATE_HOME, '/tmp/iso-x/xdg-state');
  assert.equal(env.HOME, '/home/x', 'HOME stays: the toolchain lives under it');
  // And they are set even when the caller had none: HOME alone would still resolve .config under it.
  const bare = isolatedEnv({ HOME: '/home/x', PATH: '/bin' }, '/tmp/iso-y');
  assert.equal(bare.XDG_CONFIG_HOME, '/tmp/iso-y/xdg-config');
});

test('a run creates the dir, hands it to cargo, kills only servers under it by -S, and removes it', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { spawnSync: realSpawn } = await import('node:child_process');
  const calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  let dirSeen = '';
  const code = runTestRust({
    extra: ['tmux::tests'],
    env: { TMUX: '/tmp/tmux-1000/default,1,0', TMM_SERVER: 'ws://127.0.0.1:9899', TOKEN: 'fake-token', HOME: '/home/x' },
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
  assert.equal(calls[0].env?.TMM_SERVER, undefined, 'what cargo gets is isolatedEnv');
  assert.equal(calls[0].env?.TOKEN, undefined);
  assert.equal(calls[0].env?.HOME, '/home/x');
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

// Board #476: tests/setup_cli.rs had its gateway listen on the fixed port
// 19977, and two agents' Rust gates on this host collided ('Address already
// in use'). testing.md's rule (board #177) is that a test harness holds no
// fixed port. This is a CONVENTION guard for that incident's shape, not a
// proof about every Rust spelling (review P2): it checks two LITERAL forms.
//   named: a loopback `host:N` (127.0.0.1, localhost, 0.0.0.0, [::1]) with N
//          of 1-5 digits other than 0, in a file under src-tauri/tests (the
//          integration tests start gateways and other processes);
//   bound: `bind("host:N")` or `bind(("host", N))` with a literal N > 0, in
//          any Rust source.
// A port through a constant or a variable, or with digit separators, is not
// seen. Whole-line comments are skipped; a `//` inside a string is code.
const LOOPBACK_NAMED = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(?!0\b)\d{1,5}\b/gu;
const LITERAL_BIND = /bind\(\s*(?:"[^"]*:(?!0\b)\d+"|\(\s*"[^"]*"\s*,\s*(?!0\b)\d+\s*\))/gu;
const codeOnly = (s: string) => s.replace(/^\s*\/\/[^\n]*/gmu, '');
/** The fixed-port forms in one file's text (`inTests`: under src-tauri/tests). */
function fixedPortForms(text: string, inTests: boolean): string[] {
  const code = codeOnly(text);
  return [
    ...(inTests ? [...code.matchAll(LOOPBACK_NAMED)].map((m) => `names ${m[0]}`) : []),
    ...[...code.matchAll(LITERAL_BIND)].map((m) => m[0]),
  ];
}

test('the fixed-port matcher: what it catches and what it lets through (#476 review P2)', () => {
  for (const fixed of ['"wss://127.0.0.1:19977"', 'format!("localhost:7")', '"0.0.0.0:9899"', '"[::1]:5"']) {
    assert.equal(fixedPortForms(fixed, true).length, 1, `a named fixed port in a test file: ${fixed}`);
  }
  for (const bind of ['TcpListener::bind("127.0.0.1:19500")', 'bind(("127.0.0.1", 9))', 'bind( "0.0.0.0:80" )']) {
    assert.equal(fixedPortForms(bind, false).length, 1, `a literal non-zero bind anywhere: ${bind}`);
  }
  for (const free of ['TcpListener::bind("127.0.0.1:0")', 'bind(("127.0.0.1", 0))', '"ws://127.0.0.1:0"', '"127.0.0.1:0/x"']) {
    assert.deepEqual(fixedPortForms(free, true), [], `the free form: ${free}`);
  }
  assert.deepEqual(fixedPortForms('"wss://127.0.0.1:19977"', false), [], 'a named port outside the tests is a fixture value (parsed, not bound)');
  assert.deepEqual(fixedPortForms('  // was 127.0.0.1:19977 before #476\n', true), [], 'a whole-line comment is not code');
  assert.equal(fixedPortForms('let u = "wss://127.0.0.1:19977"; // the gateway\n', true).length, 1, 'a // inside a string is code');
  // Not seen, by construction (a convention guard, not a proof):
  assert.deepEqual(fixedPortForms('const P: u16 = 19977; bind(("127.0.0.1", P))', true), [], 'a port through a constant');
  assert.deepEqual(fixedPortForms('bind(("127.0.0.1", 19_977))', true), [], 'digit separators');
});

test('no Rust test names a fixed loopback port, and no Rust source binds a literal one: the forms the matcher checks (#476)', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../src-tauri/', import.meta.url);
  const rsUnder = async (dir: URL): Promise<URL[]> => {
    const out: URL[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...await rsUnder(new URL(`${e.name}/`, dir)));
      else if (e.name.endsWith('.rs')) out.push(new URL(e.name, dir));
    }
    return out;
  };
  const found: string[] = [];
  for (const [dir, inTests] of [['tests/', true], ['src/', false]] as const) {
    for (const f of await rsUnder(new URL(dir, root))) {
      for (const hit of fixedPortForms(await readFile(f, 'utf8'), inTests)) found.push(`${f.pathname.split('/src-tauri/')[1]}: ${hit}`);
    }
  }
  assert.deepEqual(found, [], 'take a free port: std::net::TcpListener::bind("127.0.0.1:0") and read local_addr()');
});
