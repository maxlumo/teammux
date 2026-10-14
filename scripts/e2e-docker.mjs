#!/usr/bin/env node
// `npm run test:e2e:docker` — the Docker-isolated multi-gateway environment
// (board #352) and its smoke.
//
// Why containers: #335 ③ (several servers in one app) was verified against ONE
// real gateway plus fakes, and the validator's two-member browser check was
// built from scratch gateways on this host — each on its own port, config dir
// and tmux socket, but sharing the host's kernel, users, /tmp and the owner's
// tmux server. Every incident of 2026-10-12 (#349 ×2, the #350 risk) came from
// test infrastructure sharing the host with the owner's real sessions. One
// container per simulated machine gives a real `tmm gateway` per server with
// its own tmux, its own config root (token, machine_id, state.db) and its own
// address, and no path at all to the owner's tmux: nothing from the host is
// mounted, and this script never runs tmux, systemctl or the host's tmm.
//
// What it does, in order, and always tears down (`--keep` leaves the machines
// up for a validator to use by hand; the next run tears them down first, so
// every run starts from fresh machines):
//   1. `docker compose up -d --build --wait` on docker/validator/compose.yaml
//      (the image builds THIS checkout's web UI, tmm and server inside the
//      container; a host binary never enters);
//   2. for each gateway, from the HOST through its published 127.0.0.1 port:
//      a real WebSocket login with the token read out of the container, which
//      answers with that machine's id; `list_sessions` names the project the
//      entrypoint brought up; GET / serves the embedded web UI (what a browser
//      loads); `tmm agent list` inside the container shows the
//      MANAGED agent (isolated home, launch recipe) running;
//   3. the ids and tokens differ across gateways, and each id is the one in
//      that container's machine_id file;
//   4. the host's gateway is OUT OF REACH from inside the network: the same
//      `tmm --server … project list` first lists gw-a's OWN gateway (the
//      probe works), then, aimed at the network's gateway address (the host)
//      on the default port, ends with tmm's own "server not reachable" or
//      "auth rejected" — anything else, including a probe that did not run,
//      fails (the issue's negative control — a test that depends on the host
//      gateway must fail here);
//   5. a container restart keeps the machine's identity and brings its project
//      and agent back — the mechanism the ③ matrix uses for "server dies" and
//      "reconnect reaches another machine".
//
// Teardown is part of the verdict: a failed `down` (before up, after a pass,
// after a failure) makes the run fail, PASS is said only once the machines
// are gone, and SIGINT/SIGTERM run the down themselves. Every compose call
// carries `-p tmm-e2e`, so no COMPOSE_PROJECT_NAME in the caller's shell can
// aim the down at another project.
//
// Known limit, on purpose: the compose network is NOT `internal` — Docker does
// not forward published ports on an internal network (measured here on Docker
// 25.0.14: the host could not connect at all), and a browser on the host must
// reach each gateway. So a container CAN route to the host's bridge address;
// what keeps the host gateway out is that it binds 127.0.0.1 (as on this host)
// and that no container holds its token. Step 4 asserts the outcome, not the
// route.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const composeFile = 'docker/validator/compose.yaml';
export const SERVICES = ['gw-a', 'gw-b', 'gw-c'];
/** What the entrypoint declares in every machine (docker/validator/entrypoint.sh). */
export const PROJECT = 'demo';
export const AGENT = 'kiro';
/** The gateway's port INSIDE every container (compose.yaml publishes it). */
export const PORT = 9899;
/** The compose project: the prefix of every container and network this script
 * may touch. Passed as `-p` on EVERY compose call (reviewer P1-A): `-p`
 * outranks `COMPOSE_PROJECT_NAME`, so a shell whose environment names some
 * other local project cannot turn our `down --remove-orphans` into that
 * project's. compose.yaml's `name:` is the same value for a human running
 * compose by hand. One fixed name = one environment per host; two checkouts
 * running this at once would tear each other down, and that is on purpose
 * (the validator's kept environment is THE environment). */
export const COMPOSE_PROJECT = 'tmm-e2e';
export const NETWORK = `${COMPOSE_PROJECT}_tmm`;

/** `docker compose -p tmm-e2e -f <file> <args>`, the one spelling every call uses. */
export function composeArgs(args) {
  return ['compose', '-p', COMPOSE_PROJECT, '-f', composeFile, ...args];
}

/** The environment a docker child gets: the caller's, minus the compose
 * variables that re-aim a project or a file. `-p`/`-f` already win, but a
 * value that cannot be there cannot be argued about. */
export function dockerEnv(base) {
  const env = { ...base };
  for (const k of ['COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_PROFILES']) delete env[k];
  return env;
}

/** The public SOURCE REVISION of the checkout this runs from, as the env the
 * image build takes (board #368). The image has no `.git` (.dockerignore keeps
 * it out, on purpose), so without this both sides of the stack would build as
 * `dev` and a build-A-image-with-a-build-B-UI mismatch could never be produced.
 * A caller's own SOURCE_COMMIT / SOURCE_TIME wins, but it only LABELS what the
 * image says it is: the image is still built from this checkout's files, so to
 * build commit A run the script from a checkout AT A. A git failure adds
 * nothing (`dev`). Public metadata only: a hash and
 * a minute, never a path, a remote or a credential. */
export function sourceRevisionEnv(base, run = spawnSync, now = new Date()) {
  const env = { ...base };
  if (!/^[0-9a-f]{8,40}$/.test(String(env.SOURCE_COMMIT ?? '').trim().toLowerCase())) {
    delete env.SOURCE_COMMIT;
    const r = run('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    const sha = String(r?.stdout ?? '').trim();
    if (r?.status === 0 && /^[0-9a-f]{8,40}$/.test(sha)) env.SOURCE_COMMIT = sha;
  }
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(String(env.SOURCE_TIME ?? '').trim())) {
    delete env.SOURCE_TIME;
    env.SOURCE_TIME = now.toISOString().slice(0, 16).replace('T', ' ');
  }
  return env;
}

/** The token in a config.toml the entrypoint wrote (`token = "…"`). */
export function tokenOf(configToml) {
  const m = /^token\s*=\s*"([^"]+)"/m.exec(configToml);
  if (!m) throw new Error('config.toml has no token line');
  return m[1];
}

/** `docker compose port <svc> 9899` prints `127.0.0.1:19901`; the number. */
export function hostPortOf(portLine) {
  const m = /:(\d+)\s*$/.exec(portLine.trim());
  if (!m) throw new Error(`not a host:port line: ${JSON.stringify(portLine)}`);
  return Number(m[1]);
}

/** One login + one `list_sessions` over a real WebSocket, the wire the app
 * speaks: the server opens with a plain `server_nonce` frame, the client
 * answers `auth`, and every later request is a JSON-RPC call. The plain-token
 * login is the http:// client path the server still accepts; the smoke needs
 * the machine id it answers with, not the sealed channel. */
export async function loginAndList(url, token, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5000 } = {}) {
  return new Promise((done, fail) => {
    const ws = new WebSocketImpl(url);
    const timer = setTimeout(() => { ws.close(); fail(new Error(`${url}: no answer within ${timeoutMs} ms`)); }, timeoutMs);
    const finish = (f, v) => { clearTimeout(timer); ws.close(); f(v); };
    let machineId = null;
    ws.onerror = () => finish(fail, new Error(`${url}: websocket error (nothing listening, or not a websocket)`));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return finish(fail, new Error(`${url}: non-JSON frame`)); }
      if (msg.server_nonce !== undefined) {
        ws.send(JSON.stringify({ id: 1, method: 'auth', params: { token } }));
      } else if (msg.id === 1) {
        if (msg.result?.authenticated !== true) return finish(fail, new Error(`${url}: auth rejected: ${JSON.stringify(msg.error ?? msg)}`));
        machineId = msg.result.machine_id;
        ws.send(JSON.stringify({ id: 2, method: 'list_sessions', params: {} }));
      } else if (msg.id === 2) {
        if (msg.error) return finish(fail, new Error(`${url}: list_sessions: ${JSON.stringify(msg.error)}`));
        finish(done, { machineId, sessions: (msg.result ?? []).map((s) => s.name) });
      }
    };
  });
}

/** The web UI the gateway serves on the same port (embed-ui): what a browser
 * gets for `/`. `{ status, html }`, or `{ status: 0 }` when nothing answered
 * within `timeoutMs` — a hung HTTP socket must not hold the run (and its
 * teardown) open. */
export async function fetchUi(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`GET ${url}: no answer within ${timeoutMs} ms`)), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal });
    const body = await r.text();
    return { status: r.status, html: /<html/i.test(body) };
  } catch {
    return { status: 0, html: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The verdict on one machine's facts. `agents` is `tmm agent list --output
 * json` parsed; `fileId` the container's machine_id file. */
export function judgeMachine(name, { machineId, sessions, fileId, agents, ui }) {
  const problems = [];
  if (!machineId) problems.push('login answered without a machine_id');
  if (machineId && fileId && machineId !== fileId) problems.push(`login says machine ${machineId}, the container's file says ${fileId}`);
  if (!sessions.includes(PROJECT)) problems.push(`list_sessions has no "${PROJECT}" (got ${JSON.stringify(sessions)})`);
  if (ui && !(ui.status === 200 && ui.html)) problems.push(`GET / did not serve the web UI (status ${ui.status})`);
  const agent = (agents?.agents ?? []).find((a) => a.name === AGENT);
  if (!agent) problems.push(`no agent "${AGENT}" in ${PROJECT}`);
  else if (!agent.managed) problems.push(`agent "${AGENT}" is not managed (no isolated home)`);
  else if (agent.state !== 'running') problems.push(`agent "${AGENT}" is ${agent.state}, not running`);
  return problems.map((p) => `${name}: ${p}`);
}

/** Across machines: no two share an id or a token. A shared token is named
 * by the machines, never by its value — the default run's output is a log. */
export function judgeDistinct(machines) {
  const problems = [];
  for (const key of ['machineId', 'token']) {
    const seen = new Map();
    for (const m of machines) {
      const v = m[key];
      if (seen.has(v)) problems.push(`${m.name} and ${seen.get(v)} share a ${key}${key === 'token' ? '' : ` (${v})`}`);
      seen.set(v, m.name);
    }
  }
  return problems;
}

/** tmm's own exit codes (src-tauri/src/bin/tmm.rs). */
const TMM_UNREACHABLE = 2;
const TMM_AUTH_REJECTED = 3;

/** The negative control's verdict (reviewer P1-C on 8a0f17e2: "did not run"
 * is not "out of reach"). `control` is the SAME probe command aimed at the
 * container's own gateway, run first: it must list, which proves tmm, the
 * `--server` flag and the exec path all work in that container. Only then
 * does `host` count, and only two outcomes are evidence: tmm's own
 * "server not reachable" (exit 2) or "auth rejected" (exit 3), each with its
 * message on stderr. A spawn error, a signal, exec/usage codes (5, 126, 127),
 * `timeout`'s 124 or any other exit is the probe failing to run, and fails
 * the run. */
export function judgeHostOutOfReach({ control, host }) {
  const problems = [];
  if (control.error || control.status !== 0 || !/"projects"/.test(control.stdout ?? '')) {
    problems.push(`the probe did not list ${SERVICES[0]}'s OWN gateway (exit ${control.status ?? control.error?.message}); the host check cannot be trusted`);
    return problems;
  }
  if (host.error) return [`the host probe did not run: ${host.error.message}`];
  const err = (host.stderr ?? '').trim();
  if (host.status === 0 || /"projects"/.test(host.stdout ?? '')) {
    return [`a tmm inside ${SERVICES[0]} LISTED the host gateway's projects — the host is reachable with a working token`];
  }
  if (host.status === TMM_UNREACHABLE && /not reachable/.test(err)) return [];
  if (host.status === TMM_AUTH_REJECTED && /auth rejected/.test(err)) return [];
  return [`the host probe ended with exit ${host.status ?? `signal ${host.signal}`} (${err || 'no error text'}) — neither tmm's "not reachable" nor "auth rejected"; the probe did not reach a verdict`];
}

export async function runE2E({
  argv = process.argv.slice(2),
  spawn = spawnSync,
  log = console.log,
  env = process.env,
  onSignal = (handler) => { for (const s of ['SIGINT', 'SIGTERM']) process.once(s, handler); },
  loginAndList: login = loginAndList,
  fetchUi: getUi = fetchUi,
  revision = (base) => sourceRevisionEnv(base),
} = {}) {
  const keep = argv.includes('--keep');
  const denv = revision(dockerEnv(env));
  const sh = (args, opts = {}) => spawn('docker', composeArgs(args), { cwd: repoRoot, encoding: 'utf8', env: denv, ...opts });
  const must = (args, what) => {
    const r = sh(args);
    if (r.error) throw new Error(`${what}: docker: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${what}: docker compose ${args.join(' ')} exited ${r.status}\n${r.stderr ?? ''}`);
    return r.stdout ?? '';
  };
  const exec = (svc, cmd) => sh(['exec', '-T', svc, 'sh', '-c', cmd]);
  const inside = (svc, cmd) => {
    const r = exec(svc, cmd);
    if (r.status !== 0) throw new Error(`${svc}: ${cmd}: exit ${r.status}\n${r.stderr ?? ''}`);
    return (r.stdout ?? '').trim();
  };
  /** `down -v --remove-orphans` on OUR project; its exit is the verdict. */
  const down = (why) => {
    log(`[e2e:docker] compose down -v --remove-orphans (${why})`);
    const r = sh(['down', '-v', '--remove-orphans'], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) return `down: docker: ${r.error.message}`;
    if (r.status !== 0) return `down exited ${r.status}; the environment may be left behind — docker compose -p ${COMPOSE_PROJECT} -f ${composeFile} down -v --remove-orphans`;
    return null;
  };

  const version = spawn('docker', ['compose', 'version'], { encoding: 'utf8', env: denv });
  if (version.error || version.status !== 0) {
    log('[e2e:docker] docker compose is not available here; this suite needs Docker with the compose plugin');
    return 1;
  }

  // A Ctrl-C mid-run must not leave three machines up: `finally` does not run
  // on a signal, so the signal does the down itself (synchronously) and exits
  // non-zero. `--keep` keeps even then.
  let up = false;
  let passed = false;
  onSignal((sig) => {
    log(`[e2e:docker] ${sig}`);
    if (up && !keep) {
      const left = down(sig);
      if (left) log(`[e2e:docker] ${left}`);
    }
    process.exit(130);
  });

  const problems = [];
  try {
    // Fresh machines every run (reviewer P1-B: a failed clean-up is a
    // failure, not a warning): a kept environment from an earlier `--keep`,
    // its agents stopped and its rooms written on, is torn down first, and
    // if that down fails nothing is started — a verdict on machines whose
    // state.db an earlier session wrote is not a verdict.
    const stale = down('fresh machines');
    if (stale) throw new Error(stale);
    log('[e2e:docker] compose up --build --wait (the first build compiles tmm + server inside the image; minutes)');
    const t0 = Date.now();
    const upRun = sh(['up', '-d', '--build', '--wait'], { stdio: ['ignore', 'inherit', 'inherit'] });
    up = true;
    if (upRun.status !== 0) {
      log(sh(['logs', '--no-color', '--tail', '40']).stdout ?? '');
      throw new Error(`compose up exited ${upRun.status}`);
    }
    log(`[e2e:docker] up in ${Math.round((Date.now() - t0) / 1000)} s`);

    const describe = async (name) => {
      const hostPort = hostPortOf(must(['port', name, String(PORT)], `${name} port`));
      const token = tokenOf(inside(name, 'cat "$HOME/.config/tmux-mobile/config.toml"'));
      const fileId = inside(name, 'cat "$HOME/.config/tmux-mobile/machine_id"');
      const url = `ws://127.0.0.1:${hostPort}`;
      const { machineId, sessions } = await login(url, token);
      const ui = await getUi(`http://127.0.0.1:${hostPort}/`);
      const agents = JSON.parse(inside(name, `tmm agent list --project ${PROJECT} --output json`));
      return { name, hostPort, url, token, machineId, fileId, sessions, agents, ui };
    };

    const machines = [];
    for (const name of SERVICES) {
      const m = await describe(name);
      machines.push(m);
      problems.push(...judgeMachine(name, m));
      log(`[e2e:docker] ${name}  ${m.url}  machine ${m.machineId}  sessions ${JSON.stringify(m.sessions)}`);
    }
    problems.push(...judgeDistinct(machines));

    // 4. The host gateway, from inside: the network's gateway address IS the
    // host. Read from docker, never from the owner's config. The control run
    // (same command, the container's own gateway) proves the probe works.
    const net = spawn('docker', ['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', NETWORK], { encoding: 'utf8', env: denv });
    const hostAddr = (net.stdout ?? '').trim();
    if (net.status !== 0 || !hostAddr) problems.push(`could not read ${NETWORK}'s gateway address: ${net.stderr ?? ''}`);
    else {
      const probeCmd = (addr) => `timeout 5 tmm --server ws://${addr}:${PORT} project list --output json`;
      const control = exec(SERVICES[0], probeCmd('127.0.0.1'));
      const host = exec(SERVICES[0], probeCmd(hostAddr));
      problems.push(...judgeHostOutOfReach({ control, host }));
      log(`[e2e:docker] host gateway from ${SERVICES[0]} (ws://${hostAddr}:${PORT}): exit ${host.status} — ${(host.stderr ?? '').trim() || 'no error text'} (own gateway: exit ${control.status})`);
    }

    // 5. A restart keeps identity and brings the project back.
    const victim = machines[1];
    log(`[e2e:docker] restarting ${victim.name} (the "server dies" mechanism)`);
    must(['restart', victim.name], `restart ${victim.name}`);
    must(['up', '-d', '--wait', '--no-build', victim.name], `wait for ${victim.name}`);
    const again = await describe(victim.name);
    if (again.machineId !== victim.machineId) problems.push(`${victim.name}: machine_id changed across a restart (${victim.machineId} → ${again.machineId})`);
    if (again.token !== victim.token) problems.push(`${victim.name}: token changed across a restart`);
    problems.push(...judgeMachine(`${victim.name} after restart`, again));

    if (problems.length) {
      log('[e2e:docker] FAIL');
      for (const p of problems) log(`  - ${p}`);
      return 1;
    }
    if (keep) {
      log('[e2e:docker] PASS: 3 gateways answer with 3 machine ids and serve the UI, 3 managed agents, host out of reach, restart keeps identity');
      log('[e2e:docker] --keep: the machines stay up. Connect a browser to each (token per machine):');
      for (const m of machines) log(`  ${m.name}  ${m.url}  token ${m.token}`);
      log(`  down: docker compose -p ${COMPOSE_PROJECT} -f ${composeFile} down -v --remove-orphans`);
      passed = true;
      return 0;
    }
    // PASS is said only once the machines are gone: "every path leaves
    // nothing" is part of what passes.
    const left = down('done');
    up = false;
    if (left) {
      log(`[e2e:docker] FAIL: the smoke passed but ${left}`);
      return 1;
    }
    log('[e2e:docker] PASS: 3 gateways answer with 3 machine ids and serve the UI, 3 managed agents, host out of reach, restart keeps identity, nothing left');
    return 0;
  } catch (e) {
    log(`[e2e:docker] ${e.message}`);
    return 1;
  } finally {
    if (up && !keep) {
      const left = down('after failure');
      if (left) log(`[e2e:docker] ${left}`);
    } else if (up && keep && !passed) {
      log(`[e2e:docker] --keep: the machines stay up after this failure; end them with docker compose -p ${COMPOSE_PROJECT} -f ${composeFile} down -v --remove-orphans`);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runE2E().then((code) => { process.exitCode = code; });
