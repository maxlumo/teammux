// The Docker multi-gateway environment (board #352): the harness's judgement
// and the shape of the compose/Dockerfile pair, pinned without Docker. The
// environment itself is exercised by `npm run test:e2e:docker`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AGENT, PORT, PROJECT, SERVICES, composeArgs, composeFile, composeProject, fetchUi, hostPortOf,
  judgeDistinct, judgeHostOutOfReach, judgeMachine, loginAndList, runE2E, tokenOf,
} from './e2e-docker.mjs';

const read = (rel: string) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('npm run test:e2e:docker is the harness', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['test:e2e:docker'], 'node scripts/e2e-docker.mjs');
});

test('every compose call names the one compose file', () => {
  assert.deepEqual(composeArgs(['up', '-d']), ['compose', '-f', 'docker/validator/compose.yaml', 'up', '-d']);
  assert.equal(composeFile, 'docker/validator/compose.yaml');
});

test('the compose file declares the services the harness smokes, host-loopback ports, nothing mounted', async () => {
  const yaml = await read(composeFile);
  assert.match(yaml, new RegExp(`^name: ${composeProject()}$`, 'm'), 'the network/container prefix the harness reads');
  for (const svc of SERVICES) assert.match(yaml, new RegExp(`^  ${svc}:$`, 'm'));
  // Every published port binds 127.0.0.1 — a browser on this host, nobody on the LAN.
  const ports = [...yaml.matchAll(/ports: \["([^"]+)"\]/g)].map((m) => m[1]);
  assert.equal(ports.length, SERVICES.length);
  for (const p of ports) assert.match(p, new RegExp(`^127\\.0\\.0\\.1:\\$\\{TMM_E2E_PORT_[ABC]:-\\d+\\}:${PORT}$`));
  // No host path reaches a container: no bind mounts, no volumes section.
  assert.doesNotMatch(yaml, /^\s+volumes:/m, 'a mounted host path is a road to the owner\'s tmux or config');
  assert.doesNotMatch(yaml, /network_mode:\s*host/, 'host networking would share the owner\'s ports');
  // Not internal: published ports do not work on an internal network (measured, Docker 25).
  assert.doesNotMatch(yaml, /internal:\s*true/);
});

test('the image builds this checkout inside the container and copies no host binary', async () => {
  const df = await read('docker/validator/Dockerfile');
  assert.match(df, /cargo build --manifest-path src-tauri\/Cargo\.toml[\s\\]+--no-default-features --features embed-ui --release --bins/);
  assert.match(df, /^RUN npx vite build$/m, 'the web UI is built in the image, then embedded');
  // The only COPY from outside the build context's sources is from the build stages.
  for (const line of df.split('\n').filter((l) => /^COPY /.test(l))) {
    assert.doesNotMatch(line, /target\/release/, `a host build artifact must not enter the image: ${line}`);
  }
  assert.match(df, /^USER tmm$/m, 'the gateway does not run as root');
  assert.match(df, /^HEALTHCHECK /m);
  const ignore = await read('.dockerignore');
  for (const dir of ['target', 'src-tauri/target', 'node_modules', '.tmm', 'worktree']) {
    assert.match(ignore, new RegExp(`^${dir.replace(/[.]/g, '\\.')}$`, 'm'), `${dir} stays out of the build context`);
  }
});

test('the entrypoint writes its own token, starts the gateway as the service does, and spawns a MANAGED agent', async () => {
  const sh = await read('docker/validator/entrypoint.sh');
  assert.match(sh, /tmm gateway start --service/, 'config.toml alone, no first-run prompt');
  assert.match(sh, /\/proc\/sys\/kernel\/random\/uuid/, 'a token generated in the container, never the operator\'s');
  assert.match(sh, /host = "0\.0\.0\.0"/, 'reachable from the compose network and the published port');
  assert.match(sh, /tmm project create \/work --name "\$project"$/m, 'no --with-agent: that seeds a plain shell slot');
  assert.match(sh, /tmm spawn "\$agent" --project "\$project"/, 'a registry agent: isolated home + recipe + hooks');
  assert.match(sh, new RegExp(`TMM_PROJECT:-${PROJECT}`));
  assert.match(sh, new RegExp(`TMM_AGENT:-${AGENT}`));
});

test('config.toml and port lines are read, not guessed', () => {
  assert.equal(tokenOf('host = "0.0.0.0"\nport = 9899\ntoken = "ab-12"\n'), 'ab-12');
  assert.throws(() => tokenOf('port = 9899\n'), /no token/);
  assert.equal(hostPortOf('127.0.0.1:19901\n'), 19901);
  assert.equal(hostPortOf('[::]:19901'), 19901);
  assert.throws(() => hostPortOf(''), /not a host:port/);
});

test('loginAndList speaks the wire: nonce, auth, list_sessions', async () => {
  const sent: string[] = [];
  class FakeWS {
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ server_nonce: 'aa', e2e: 2 }) })); }
    send(s: string) {
      sent.push(s);
      const req = JSON.parse(s);
      const reply = req.method === 'auth'
        ? { id: 1, result: { authenticated: true, machine_id: 'm-1', hostname: 'gw-a' } }
        : { id: 2, result: [{ name: 'demo', windows: 1 }, { name: 'other', windows: 1 }] };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
    }
    close() {}
  }
  const r = await loginAndList('ws://x', 'tok', { WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  assert.deepEqual(r, { machineId: 'm-1', sessions: ['demo', 'other'] });
  assert.deepEqual(JSON.parse(sent[0]), { id: 1, method: 'auth', params: { token: 'tok' } });
  assert.equal(JSON.parse(sent[1]).method, 'list_sessions');
});

test('a rejected login or a dead port is an error, not a machine', async () => {
  class Rejecting {
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ server_nonce: 'aa' }) })); }
    send() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: 1, error: { code: 401, message: 'invalid token' } }) })); }
    close() {}
  }
  await assert.rejects(loginAndList('ws://x', 't', { WebSocketImpl: Rejecting as unknown as typeof WebSocket }), /auth rejected/);
  class Dead {
    onmessage = null;
    onerror: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onerror?.()); }
    send() {}
    close() {}
  }
  await assert.rejects(loginAndList('ws://x', 't', { WebSocketImpl: Dead as unknown as typeof WebSocket }), /websocket error/);
  class Silent { onmessage = null; onerror = null; send() {} close() {} }
  await assert.rejects(loginAndList('ws://x', 't', { WebSocketImpl: Silent as unknown as typeof WebSocket, timeoutMs: 10 }), /no answer/);
});

test('fetchUi reports the web UI, and nothing when nothing answers', async () => {
  const ok = async () => ({ status: 200, text: async () => '<!doctype html><html><head></head></html>' });
  assert.deepEqual(await fetchUi('http://x/', { fetchImpl: ok as unknown as typeof fetch }), { status: 200, html: true });
  const notFound = async () => ({ status: 404, text: async () => 'no' });
  assert.deepEqual(await fetchUi('http://x/', { fetchImpl: notFound as unknown as typeof fetch }), { status: 404, html: false });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await fetchUi('http://x/', { fetchImpl: down as unknown as typeof fetch }), { status: 0, html: false });
});

const good = {
  machineId: 'm-1', fileId: 'm-1', sessions: ['demo'], ui: { status: 200, html: true },
  agents: { agents: [{ name: 'kiro', managed: true, state: 'running' }] },
};

test('a machine passes only when the login id is the file id, the project is up, the UI serves and the managed agent runs', () => {
  assert.deepEqual(judgeMachine('gw-a', good), []);
  assert.match(judgeMachine('gw-a', { ...good, machineId: 'm-9' })[0], /login says machine m-9, the container's file says m-1/);
  assert.match(judgeMachine('gw-a', { ...good, machineId: undefined })[0], /without a machine_id/);
  assert.match(judgeMachine('gw-a', { ...good, sessions: [] })[0], /no "demo"/);
  assert.match(judgeMachine('gw-a', { ...good, ui: { status: 404, html: false } })[0], /did not serve the web UI/);
  assert.match(judgeMachine('gw-a', { ...good, agents: { agents: [] } })[0], /no agent "kiro"/);
  // The shell slot `--with-agent` seeds is NOT a managed agent (measured in gw-a, 2026-10-12).
  assert.match(judgeMachine('gw-a', { ...good, agents: { agents: [{ name: 'kiro', managed: false, state: 'shell' }] } })[0], /not managed/);
  assert.match(judgeMachine('gw-a', { ...good, agents: { agents: [{ name: 'kiro', managed: true, state: 'stopped' }] } })[0], /is stopped/);
  for (const p of judgeMachine('gw-b', { ...good, sessions: [] })) assert.match(p, /^gw-b: /);
});

test('two machines may not share an id or a token', () => {
  const a = { name: 'gw-a', machineId: 'm-1', token: 't-1' };
  const b = { name: 'gw-b', machineId: 'm-2', token: 't-2' };
  assert.deepEqual(judgeDistinct([a, b]), []);
  assert.deepEqual(judgeDistinct([a, { ...b, machineId: 'm-1' }]), ['gw-b and gw-a share a machineId (m-1)']);
  assert.deepEqual(judgeDistinct([a, { ...b, token: 't-1' }]), ['gw-b and gw-a share a token (t-1)']);
});

test('the negative control: a tmm inside the network must not list the host gateway', () => {
  assert.deepEqual(judgeHostOutOfReach({ status: 2, stdout: '' }), [], 'not reachable');
  assert.deepEqual(judgeHostOutOfReach({ status: 3, stdout: '' }), [], 'auth rejected');
  assert.deepEqual(judgeHostOutOfReach({ status: 124, stdout: '' }), [], 'timed out');
  assert.equal(judgeHostOutOfReach({ status: 0, stdout: '{"projects":[]}' }).length, 1);
  assert.equal(judgeHostOutOfReach({ status: 1, stdout: '{"projects":[]}' }).length, 1);
});

test('runE2E tears down after a failed up, and refuses without compose', async () => {
  const calls: string[][] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[1] === 'version') return { status: 0, stdout: 'v5' };
    if (args.includes('up')) return { status: 1, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: '' };
  };
  const logs: string[] = [];
  const code = await runE2E({ argv: [], spawn: spawn as never, log: (s: string) => logs.push(s) });
  assert.equal(code, 1);
  assert.ok(calls.some((c) => c.includes('logs')), 'the failing machines\' logs are shown');
  const downs = calls.filter((c) => c.includes('down') && c.includes('-v') && c.includes('--remove-orphans'));
  const upAt = calls.findIndex((c) => c.includes('up'));
  assert.equal(downs.length, 2, 'down before up (fresh machines) and down after the failure');
  assert.ok(calls.indexOf(downs[0]) < upAt && calls.indexOf(downs[1]) > upAt);
  assert.ok(logs.some((l) => /compose up exited 1/.test(l)));

  const none = (cmd: string, args: string[]) => (args[1] === 'version' ? { status: 1, stdout: '', stderr: 'no plugin' } : { status: 0, stdout: '' });
  const logs2: string[] = [];
  assert.equal(await runE2E({ argv: [], spawn: none as never, log: (s: string) => logs2.push(s) }), 1);
  assert.match(logs2[0], /docker compose is not available/);
});

test('--keep leaves the machines up and prints how to reach them', async () => {
  const calls: string[][] = [];
  const machineIds: Record<string, string> = { 'gw-a': 'm-a', 'gw-b': 'm-b', 'gw-c': 'm-c' };
  let current = '';
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'docker' && args[0] === 'network') return { status: 0, stdout: '240.11.0.1\n' };
    if (args[1] === 'version') return { status: 0, stdout: 'v5' };
    if (args.includes('port')) { current = args[args.indexOf('port') + 1]; return { status: 0, stdout: `127.0.0.1:1990${current.charCodeAt(3) - 96}\n` }; }
    if (args.includes('exec')) {
      const cmdline = args[args.length - 1];
      if (/config\.toml/.test(cmdline)) return { status: 0, stdout: `token = "tok-${current}"\n` };
      if (/machine_id/.test(cmdline)) return { status: 0, stdout: `${machineIds[current]}\n` };
      if (/agent list/.test(cmdline)) return { status: 0, stdout: JSON.stringify({ agents: [{ name: 'kiro', managed: true, state: 'running' }] }) };
      if (/--server ws:/.test(cmdline)) return { status: 2, stdout: '', stderr: 'tmm: server not reachable' };
    }
    return { status: 0, stdout: '' };
  };
  const login = async (url: string) => ({ machineId: machineIds[`gw-${String.fromCharCode(96 + Number(url.slice(-1)))}`], sessions: ['demo'] });
  const logs: string[] = [];
  const code = await runE2E({ argv: ['--keep'], spawn: spawn as never, log: (s: string) => logs.push(s), loginAndList: login, fetchUi: async () => ({ status: 200, html: true }) });
  assert.equal(code, 0, logs.join('\n'));
  const downs = calls.filter((c) => c.includes('down'));
  const upAt = calls.findIndex((c) => c.includes('up'));
  assert.equal(downs.length, 1, '--keep: the only down is the one BEFORE up (fresh machines), none after');
  assert.ok(calls.indexOf(downs[0]) < upAt);
  assert.ok(logs.some((l) => /gw-a\s+ws:\/\/127\.0\.0\.1:19901\s+token tok-gw-a/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /restarting gw-b/.test(l)));
});
