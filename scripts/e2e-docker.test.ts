// The Docker multi-gateway environment (board #352): the harness's judgement
// and the shape of the compose/Dockerfile pair, pinned without Docker. The
// environment itself is exercised by `npm run test:e2e:docker`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AGENT, PORT, PROJECT, SERVICES, composeArgs, composeFile, fetchUi, hostPortOf,
  judgeDistinct, judgeHostOutOfReach, judgeMachine, loginAndList, runE2E, tokenOf,
  COMPOSE_PROJECT, NETWORK, dockerEnv, sourceRevisionEnv,
} from './e2e-docker.mjs';

const read = (rel: string) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('npm run test:e2e:docker is the harness', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['test:e2e:docker'], 'node scripts/e2e-docker.mjs');
});

test('every compose call names the one compose file AND the one project, whatever the shell says', () => {
  assert.deepEqual(composeArgs(['up', '-d']), ['compose', '-p', 'tmm-e2e', '-f', 'docker/validator/compose.yaml', 'up', '-d']);
  assert.equal(composeFile, 'docker/validator/compose.yaml');
  assert.equal(COMPOSE_PROJECT, 'tmm-e2e');
  assert.equal(NETWORK, 'tmm-e2e_tmm');
  // Belt and braces: the compose variables that re-aim a project never reach docker.
  const env = dockerEnv({ COMPOSE_PROJECT_NAME: 'owner-stack', COMPOSE_FILE: 'x.yml', COMPOSE_PROFILES: 'p', PATH: '/bin', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('the compose file declares the services the harness smokes, host-loopback ports, nothing mounted', async () => {
  const yaml = await read(composeFile);
  assert.match(yaml, new RegExp(`^name: ${COMPOSE_PROJECT}$`, 'm'), 'the same project name for a human running compose by hand');
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
  assert.match(df, /cargo build --locked --manifest-path src-tauri\/Cargo\.toml[\s\\]+--no-default-features --features embed-ui --release --bins/);
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
  // Health = READY (reviewer P2-1): the marker is dropped at start, written
  // after spawn, and required by `health`, in that order.
  const rm = sh.indexOf('rm -f "$ready"'); const touch = sh.indexOf('touch "$ready"'); const spawnAt = sh.indexOf('tmm spawn');
  assert.ok(rm > 0 && spawnAt > rm && touch > spawnAt, 'drop marker → create/up/spawn → write marker');
  assert.match(sh, /\[ -f "\$ready" \] && exec tmm project list/, 'health needs the marker AND an answering gateway');
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
  // A hung socket cannot hold the run open: the fetch carries an abort signal.
  let signal: AbortSignal | undefined;
  const hang = (_u: string, init: { signal: AbortSignal }) => new Promise<never>((_, rej) => { signal = init.signal; init.signal.addEventListener('abort', () => rej(init.signal.reason)); });
  assert.deepEqual(await fetchUi('http://x/', { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 5 }), { status: 0, html: false });
  assert.ok(signal?.aborted);
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
  assert.deepEqual(judgeDistinct([a, { ...b, token: 't-1' }]), ['gw-b and gw-a share a token'], 'the value is a secret; the log names the machines');
});

test('the negative control: only a probe that RAN and got tmm\'s refusal is evidence', () => {
  const own = { status: 0, stdout: '{"projects":[]}', stderr: '' };
  const unreachable = { status: 2, stdout: '', stderr: 'tmm: server not reachable at ws://240.11.0.1:9899: Connection refused' };
  const rejected = { status: 3, stdout: '', stderr: 'tmm: auth rejected — check token' };
  assert.deepEqual(judgeHostOutOfReach({ control: own, host: unreachable }), []);
  assert.deepEqual(judgeHostOutOfReach({ control: own, host: rejected }), []);
  // The host answered: a failure whatever the exit.
  assert.equal(judgeHostOutOfReach({ control: own, host: { status: 0, stdout: '{"projects":[]}', stderr: '' } }).length, 1);
  assert.equal(judgeHostOutOfReach({ control: own, host: { status: 1, stdout: '{"projects":[]}', stderr: '' } }).length, 1);
  // "Did not run" is NOT "out of reach" (reviewer P1-C): each of these fails.
  for (const host of [
    { status: 124, stdout: '', stderr: '' },                         // timeout killed it
    { status: 127, stdout: '', stderr: 'sh: tmm: not found' },        // no tmm
    { status: 126, stdout: '', stderr: 'permission denied' },
    { status: 5, stdout: '', stderr: 'tmm: usage' },
    { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
    { status: 2, stdout: '', stderr: '' },                           // exit 2 without tmm's message
    { status: 3, stdout: '', stderr: 'something else' },
    { error: new Error('spawn docker ENOENT'), status: null, stdout: '', stderr: '' },
  ]) {
    const v = judgeHostOutOfReach({ control: own, host });
    assert.equal(v.length, 1, JSON.stringify(host));
    assert.match(v[0], /did not run|did not reach a verdict/);
  }
  // A probe that cannot even list its own gateway proves nothing about the host.
  for (const control of [{ status: 2, stdout: '', stderr: 'not reachable' }, { status: 127, stdout: '', stderr: '' }, { error: new Error('x'), status: null, stdout: '' }]) {
    const v = judgeHostOutOfReach({ control, host: unreachable });
    assert.equal(v.length, 1);
    assert.match(v[0], /OWN gateway/);
  }
});

/** A fake docker: a healthy three-machine environment, with knobs for the
 * failures the harness must report. Records every argv and the env it got. */
function fakeDocker(opts: { preDown?: number; postDown?: number; up?: number; hostProbe?: { status: number; stderr: string } } = {}) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const machineIds: Record<string, string> = { 'gw-a': 'm-a', 'gw-b': 'm-b', 'gw-c': 'm-c' };
  let current = '';
  let downs = 0;
  let isUp = false;
  const spawn = (cmd: string, args: string[], o?: { env?: Record<string, string> }) => {
    calls.push([cmd, ...args]);
    envs.push(o?.env);
    if (cmd === 'docker' && args[0] === 'network') return { status: 0, stdout: '240.11.0.1\n', stderr: '' };
    if (args[1] === 'version') return { status: 0, stdout: 'v5', stderr: '' };
    if (args.includes('down')) {
      downs += 1;
      const code = downs === 1 ? (opts.preDown ?? 0) : (opts.postDown ?? 0);
      if (code === 0) isUp = false;
      return { status: code, stdout: '', stderr: code ? 'down failed' : '' };
    }
    if (args.includes('up')) { isUp = true; return { status: opts.up ?? 0, stdout: '', stderr: '' }; }
    if (args.includes('port')) { current = args[args.indexOf('port') + 1]; return { status: 0, stdout: `127.0.0.1:1990${current.charCodeAt(3) - 96}\n`, stderr: '' }; }
    if (args.includes('exec')) {
      const cmdline = args[args.length - 1];
      if (/config\.toml/.test(cmdline)) return { status: 0, stdout: `token = "tok-${current}"\n`, stderr: '' };
      if (/machine_id/.test(cmdline)) return { status: 0, stdout: `${machineIds[current]}\n`, stderr: '' };
      if (/agent list/.test(cmdline)) return { status: 0, stdout: JSON.stringify({ agents: [{ name: 'kiro', managed: true, state: 'running' }] }), stderr: '' };
      if (/--server ws:\/\/127\.0\.0\.1/.test(cmdline)) return { status: 0, stdout: '{"projects":[]}', stderr: '' };
      if (/--server ws:/.test(cmdline)) return { status: opts.hostProbe?.status ?? 2, stdout: '', stderr: opts.hostProbe?.stderr ?? 'tmm: server not reachable at ws://240.11.0.1:9899' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const login = async (url: string) => ({ machineId: machineIds[`gw-${String.fromCharCode(96 + Number(url.slice(-1)))}`], sessions: ['demo'] });
  const ui = async () => ({ status: 200, html: true });
  const logs: string[] = [];
  const run = (argv: string[] = [], extra: Record<string, unknown> = {}) =>
    runE2E({ argv, spawn: spawn as never, log: (s: string) => logs.push(s), loginAndList: login, fetchUi: ui, env: { PATH: '/bin' }, onSignal: () => {}, ...extra });
  return { calls, envs, logs, run, isUp: () => isUp };
}

const composeCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'docker' && c[1] === 'compose' && c[2] !== 'version');

test('a passing run: down before up, PASS only after the final down, every compose call pinned to tmm-e2e', async () => {
  const f = fakeDocker();
  assert.equal(await f.run(), 0, f.logs.join('\n'));
  const downs = f.calls.filter((c) => c.includes('down'));
  const upAt = f.calls.findIndex((c) => c.includes('up'));
  assert.equal(downs.length, 2);
  assert.ok(f.calls.indexOf(downs[0]) < upAt && f.calls.indexOf(downs[1]) > upAt);
  for (const d of downs) assert.ok(d.includes('-v') && d.includes('--remove-orphans'));
  const passAt = f.logs.findIndex((l) => /PASS/.test(l));
  const lastDownAt = f.logs.findIndex((l) => /compose down .*\(done\)/.test(l));
  assert.ok(lastDownAt >= 0 && passAt > lastDownAt, 'PASS is said after the machines are gone');
  assert.ok(!f.isUp());
  // P1-A: every compose verb — down, up, port, exec, restart, logs — carries -p tmm-e2e -f <file>.
  for (const c of composeCalls(f.calls)) assert.deepEqual(c.slice(1, 6), ['compose', '-p', 'tmm-e2e', '-f', 'docker/validator/compose.yaml'], c.join(' '));
  assert.ok(f.calls.some((c) => c[0] === 'docker' && c[1] === 'network' && c.includes('tmm-e2e_tmm')));
});

test('a hostile COMPOSE_PROJECT_NAME in the shell never reaches docker, and -p still pins every call', async () => {
  const f = fakeDocker();
  assert.equal(await f.run([], { env: { PATH: '/bin', COMPOSE_PROJECT_NAME: 'owner-stack', COMPOSE_FILE: 'owner.yml' } }), 0, f.logs.join('\n'));
  for (const e of f.envs) { assert.equal(e?.COMPOSE_PROJECT_NAME, undefined); assert.equal(e?.COMPOSE_FILE, undefined); }
  for (const c of composeCalls(f.calls)) assert.ok(c.includes('-p') && c[c.indexOf('-p') + 1] === 'tmm-e2e', c.join(' '));
});

test('a failed fresh-start down refuses to start anything', async () => {
  const f = fakeDocker({ preDown: 1 });
  assert.equal(await f.run(), 1);
  assert.ok(!f.calls.some((c) => c.includes('up')), 'no up after a failed down');
  assert.ok(f.logs.some((l) => /down exited 1/.test(l)), f.logs.join('\n'));
  assert.ok(!f.logs.some((l) => /PASS/.test(l)));
});

test('a smoke that passed but whose down failed is a FAIL that names both', async () => {
  const f = fakeDocker({ postDown: 1 });
  assert.equal(await f.run(), 1);
  assert.ok(f.logs.some((l) => /FAIL: the smoke passed but down exited 1/.test(l)), f.logs.join('\n'));
  assert.ok(f.logs.some((l) => /docker compose -p tmm-e2e -f docker\/validator\/compose\.yaml down -v --remove-orphans/.test(l)), 'the clean-up command is printed');
  assert.ok(!f.logs.some((l) => /PASS/.test(l)));
});

test('up failed and the down after it failed too: non-zero, logs shown, both errors kept', async () => {
  const f = fakeDocker({ up: 1, postDown: 1 });
  assert.equal(await f.run(), 1);
  assert.ok(f.calls.some((c) => c.includes('logs')), 'the failing machines\' logs are shown');
  assert.ok(f.logs.some((l) => /compose up exited 1/.test(l)));
  assert.ok(f.logs.some((l) => /down exited 1/.test(l)));
});

test('a host probe that did not run fails the run (P1-C end to end)', async () => {
  const f = fakeDocker({ hostProbe: { status: 124, stderr: '' } });
  assert.equal(await f.run(), 1);
  assert.ok(f.logs.some((l) => /did not reach a verdict/.test(l)), f.logs.join('\n'));
  assert.ok(f.calls.some((c) => c.includes('down')), 'still torn down');
});

test('runE2E refuses without compose', async () => {
  const none = (cmd: string, args: string[]) => (args[1] === 'version' ? { status: 1, stdout: '', stderr: 'no plugin' } : { status: 0, stdout: '' });
  const logs: string[] = [];
  assert.equal(await runE2E({ argv: [], spawn: none as never, log: (s: string) => logs.push(s), env: {}, onSignal: () => {} }), 1);
  assert.match(logs[0], /docker compose is not available/);
});

test('--keep leaves the machines up and prints how to reach them', async () => {
  const f = fakeDocker();
  assert.equal(await f.run(['--keep']), 0, f.logs.join('\n'));
  const downs = f.calls.filter((c) => c.includes('down'));
  const upAt = f.calls.findIndex((c) => c.includes('up'));
  assert.equal(downs.length, 1, '--keep: the only down is the one BEFORE up (fresh machines), none after');
  assert.ok(f.calls.indexOf(downs[0]) < upAt);
  assert.ok(f.isUp());
  assert.ok(f.logs.some((l) => /gw-a\s+ws:\/\/127\.0\.0\.1:19901\s+token tok-gw-a/.test(l)), f.logs.join('\n'));
  assert.ok(f.logs.some((l) => /docker compose -p tmm-e2e -f .* down -v --remove-orphans/.test(l)), 'how to end it');
  assert.ok(f.logs.some((l) => /restarting gw-b/.test(l)));
  assert.ok(!f.logs.some((l) => /after this failure/.test(l)), 'a pass is not a failure');
});

test('--keep after a FAILURE says the machines are still up and how to end them', async () => {
  const f = fakeDocker({ hostProbe: { status: 124, stderr: '' } });
  assert.equal(await f.run(['--keep']), 1);
  assert.ok(f.logs.some((l) => /--keep: the machines stay up after this failure; end them with docker compose -p tmm-e2e/.test(l)), f.logs.join('\n'));
  assert.ok(f.isUp());
});

test('a signal mid-run tears down (unless --keep) and exits 130', async () => {
  for (const [argv, expectDown] of [[[], true], [['--keep'], false]] as Array<[string[], boolean]>) {
    const f = fakeDocker();
    let handler: ((sig: string) => void) | undefined;
    const exits: number[] = [];
    const realExit = process.exit;
    (process as unknown as { exit: (c: number) => void }).exit = (c: number) => { exits.push(c); };
    try {
      // Fire the signal right after up, from inside the login the harness awaits.
      const login = async (url: string) => { if (url.endsWith('19901') && handler) handler('SIGINT'); return { machineId: `m-${url.slice(-1)}`, sessions: ['demo'] }; };
      await f.run(argv, { onSignal: (h: (sig: string) => void) => { handler = h; }, loginAndList: login });
    } finally {
      process.exit = realExit;
    }
    assert.deepEqual(exits, [130], JSON.stringify(argv));
    const downsAfterUp = f.calls.slice(f.calls.findIndex((c) => c.includes('up'))).filter((c) => c.includes('down') && c.includes('-v'));
    assert.equal(downsAfterUp.length > 0, expectDown, `${JSON.stringify(argv)}: ${f.logs.join('\n')}`);
  }
  // A down that fails on the signal path names the error and the clean-up
  // command — from the HANDLER (reviewer evidence P2 on 0d33d801). The
  // handler is called synchronously from inside `login`, so the logs it
  // wrote are exactly those present when `handler()` returns; a snapshot
  // taken there cannot contain anything the final down logs later.
  const f = fakeDocker({ postDown: 1 });
  let handler: ((sig: string) => void) | undefined;
  let afterHandler: string[] | undefined;
  const realExit = process.exit;
  (process as unknown as { exit: (c: number) => void }).exit = () => {};
  try {
    const login = async (url: string) => {
      if (url.endsWith('19901') && handler) { handler('SIGTERM'); afterHandler = [...f.logs]; }
      return { machineId: `m-${url.slice(-1)}`, sessions: ['demo'] };
    };
    await f.run([], { onSignal: (h: (sig: string) => void) => { handler = h; }, loginAndList: login });
  } finally {
    process.exit = realExit;
  }
  assert.ok(afterHandler);
  const at = afterHandler.findIndex((l) => /\[e2e:docker\] SIGTERM/.test(l));
  assert.ok(at >= 0);
  assert.deepEqual(afterHandler.slice(at), [
    '[e2e:docker] SIGTERM',
    '[e2e:docker] compose down -v --remove-orphans (SIGTERM)',
    '[e2e:docker] down exited 1; the environment may be left behind — docker compose -p tmm-e2e -f docker/validator/compose.yaml down -v --remove-orphans',
  ], 'the handler itself logged the down failure and the clean-up command');
});

// ── Board #368 review P2-C: the image has no .git, so it is handed the revision ──

test('the e2e image is handed the checkout\'s PUBLIC source revision as build args, so a build at commit A can differ from a UI built at B', async () => {
  const dockerfile = await read('docker/validator/Dockerfile');
  const yaml = await read(composeFile);
  // Both stages that bake an identity (vite for the UI, cargo for build.rs) take it.
  assert.equal(dockerfile.match(/^ARG SOURCE_COMMIT=$/gm)?.length, 2);
  assert.equal(dockerfile.match(/^ARG SOURCE_TIME=$/gm)?.length, 2);
  assert.equal(dockerfile.match(/^ENV SOURCE_COMMIT=\$SOURCE_COMMIT SOURCE_TIME=\$SOURCE_TIME$/gm)?.length, 2);
  assert.ok(dockerfile.indexOf('ENV SOURCE_COMMIT') < dockerfile.indexOf('RUN npx vite build'), 'set before the UI build runs');
  assert.ok(dockerfile.lastIndexOf('ENV SOURCE_COMMIT') < dockerfile.indexOf('cargo build'), 'and before cargo does');
  assert.match(yaml, /args:\s*\n\s+SOURCE_COMMIT: \$\{SOURCE_COMMIT:-\}\s*\n\s+SOURCE_TIME: \$\{SOURCE_TIME:-\}/u);
  // Still no way to carry a .git or a host path in: the context and ignore file are as before.
  assert.doesNotMatch(dockerfile, /COPY[^\n]*\.git\b/u);
  const ignore = await read('.dockerignore');
  assert.match(ignore, /^\.git$/m, '.git stays out of the context');
});

test('sourceRevisionEnv: the checkout\'s short commit and the UTC minute; the caller\'s own win; git failing adds no commit', () => {
  const at = new Date('2026-10-14T07:40:59.999Z');
  const ok = (cmd: string, args: string[]) => ({ status: 0, stdout: '46392f16\n' });
  assert.deepEqual(sourceRevisionEnv({ PATH: '/bin' }, ok as any, at), { PATH: '/bin', SOURCE_COMMIT: '46392f16', SOURCE_TIME: '2026-10-14 07:40' });
  // The git call is the plain short-hash one, in the checkout.
  let seen: unknown[] = [];
  sourceRevisionEnv({}, ((...a: unknown[]) => { seen = a; return { status: 0, stdout: 'abcdef12' }; }) as any, at);
  assert.deepEqual(seen.slice(0, 2), ['git', ['rev-parse', '--short=8', 'HEAD']]);
  // "Build the image as commit A": the caller's value is kept, git is not even asked.
  const asked: string[] = [];
  const kept = sourceRevisionEnv({ SOURCE_COMMIT: 'aaaaaaaa', SOURCE_TIME: '2025-01-01 00:00' }, (() => { asked.push('git'); return { status: 0, stdout: 'ffffffff' }; }) as any, at);
  assert.deepEqual([kept.SOURCE_COMMIT, kept.SOURCE_TIME, asked.length], ['aaaaaaaa', '2025-01-01 00:00', 0]);
  // git missing/failing: no commit at all (the build says dev), the time is still the clock.
  const none = sourceRevisionEnv({}, (() => ({ status: 128, stdout: '' })) as any, at);
  assert.deepEqual(none, { SOURCE_TIME: '2026-10-14 07:40' });
  const junk = sourceRevisionEnv({ SOURCE_COMMIT: 'not a hash; rm -rf /' }, (() => ({ status: 0, stdout: 'zzz' })) as any, at);
  assert.equal(junk.SOURCE_COMMIT, undefined, 'a value that is not a hash never reaches a build arg');
});
