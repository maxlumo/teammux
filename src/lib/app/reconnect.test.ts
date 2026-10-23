import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectMachine, RECONNECT_WATCHDOG_MS, type ReconnectDeps, type ReconnectState } from './reconnect.ts';
import { targetOf } from './server-target.ts';
import { currentServerId } from './servers.ts';

// Deterministic fake timers: run() executes due callbacks in schedule order.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeoutFn: ((fn: () => void, ms?: number) => {
      const id = ++seq;
      tasks.set(id, { at: now + (ms || 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => { tasks.delete(id); }) as unknown as typeof clearTimeout,
    async advance(ms: number) {
      now += ms;
      for (const [id, t] of [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { tasks.delete(id); t.fn(); await Promise.resolve(); }
      }
      // settle microtasks queued by resolved promises
      await new Promise(r => setTimeout(r, 0));
    },
    pendingCount: () => tasks.size,
  };
}

/** The CURRENT server's entry, from the fields these fixtures name the old
 * way: where to reach a server is its ENTRY since board #335 ②b-4. */
function makeStorage(entries: Record<string, string>) {
  const { tmux_address: address, tmux_token: token = '', tmux_machine_id: machineId, ...rest } = entries;
  const map = new Map(Object.entries(address ? {
    ...rest,
    tmux_servers: JSON.stringify([{ id: 'cur', name: 'current', address, token, ...(machineId ? { machineId } : {}) }]),
    tmux_server_current: 'cur',
  } : rest));
  return { getItem: (k: string) => (map.has(k) ? map.get(k)! : null) };
}

type HarnessEvent = Partial<ReconnectState> & { success?: [string, string]; gaveUp?: boolean; why?: string };
function harness({ storage, connectImpl, findBest = async (a: string[]) => a[0] ?? null, viable = () => true, eligible, beforeDial, maxAttempts = 3, appBudget = false }: {
  storage: Pick<Storage, 'getItem'>;
  connectImpl: ReconnectDeps['connect'];
  findBest?: ReconnectDeps['findBestAddress'];
  viable?: ReconnectDeps['isAddressViable'];
  eligible?: ReconnectDeps['eligible'];
  beforeDial?: ReconnectDeps['beforeDial'];
  maxAttempts?: number;
  /** Pass NO budget of its own, as App does: the machine's defaults decide. */
  appBudget?: boolean;
}) {
  const timers = fakeTimers();
  const events: HarnessEvent[] = [];
  const unreachable: string[] = [];
  const machine = createReconnectMachine({
    connect: connectImpl,
    // eslint-disable-next-line — deliberate partial mocks below
    findBestAddress: findBest,
    isAddressViable: viable,
    ...(eligible ? { eligible } : {}),
    ...(beforeDial ? { beforeDial } : {}),
    noteAddressUnreachable: (u) => unreachable.push(u),
    classifyAddress: (url) => (url.includes('192.168.') ? 0 : url.includes('100.') ? 1 : 2),
    addressLabels: ['LAN', 'Tailscale', 'WAN'],
    // What App passes: the CURRENT server's target.
    target: () => targetOf(storage, currentServerId(storage)),
    onStateChange: (s) => events.push({ ...s }),
    onSuccess: (use, primary) => events.push({ success: [use, primary] }),
    onGiveUp: (why) => events.push({ gaveUp: true, ...(why ? { why } : {}) }),
    ...(appBudget ? {} : { maxAttempts, watchdogMs: 180000 }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { machine, timers, events, unreachable };
}

test('single address success on first try', async () => {
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://192.168.1.2:9899', tmux_token: 't' }),
    connectImpl: async () => 'machine-1',
  });
  h.machine.start();
  await h.timers.advance(1);
  const success = h.events.find(e => e.success)!;
  assert.deepEqual(success.success, ['ws://192.168.1.2:9899', 'ws://192.168.1.2:9899']);
  assert.equal(h.machine.isActive(), false);
});

test('multi-address first attempt probes in parallel and uses the winner', async () => {
  const h = harness({
    storage: makeStorage({
      tmux_address: 'ws://192.168.1.2:9899',
      tmux_token: 't',
      tmux_machine_id: 'm1',
      tmux_machines: JSON.stringify({ m1: ['ws://100.1.1.1:9899', 'ws://192.168.1.2:9899'] }),
    }),
    findBest: async () => 'ws://100.1.1.1:9899',
    connectImpl: async (url) => { if (url !== 'ws://100.1.1.1:9899') throw new Error('wrong addr'); },
  });
  h.machine.start();
  await h.timers.advance(1);
  const success = h.events.find(e => e.success)!;
  assert.deepEqual(success.success, ['ws://100.1.1.1:9899', 'ws://192.168.1.2:9899']);
});

test('failures retry with capped backoff, then give up after maxAttempts', async () => {
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: async () => { throw new Error('connection timeout'); },
    maxAttempts: 3,
  });
  h.machine.start();
  await h.timers.advance(1);      // attempt 1 fails → retry in 500ms
  await h.timers.advance(500);    // attempt 2 fails → retry in 1000ms
  await h.timers.advance(1000);   // attempt 3 fails → give up
  assert.ok(h.events.some(e => e.gaveUp));
  assert.equal(h.machine.isActive(), false);
  // Reachability failures were recorded for the cooldown memory.
  assert.equal(h.unreachable.length, 3);
});

test('a dropped connection is retried for the whole 180 s window by the clock: kept at 179 s, given up at 180 s (#393)', async () => {
  // The first cut sized an attempt COUNT from the backoff (60 attempts) and gave up
  // at 169.5 s (reviewer P2-1): the clock decides. Every dial here is refused at
  // once, App's own budget (none) is what the machine runs with.
  const refused = () => harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: async () => { throw new Error('connection failed'); },
    appBudget: true,
  });
  const h = refused();
  h.machine.start();
  let t = 0;
  for (; t < 179000; t += 500) await h.timers.advance(500);
  assert.ok(!h.events.some((e) => e.gaveUp), 'still retrying at 179 s: the person keeps the view');
  assert.equal(h.machine.isActive(), true);
  for (; t < 180500; t += 500) await h.timers.advance(500);
  assert.ok(h.events.some((e) => e.gaveUp && !e.why), 'and gave up when the 180 s window ended (not as a token refusal)');
  assert.equal(h.machine.isActive(), false);
  assert.ok(h.unreachable.length > 55, `it kept dialling the whole time (${h.unreachable.length} dials)`);
  assert.equal(RECONNECT_WATCHDOG_MS, 180000);
});

test('a 60 s and a 175 s outage both recover under the default budget; the old 10 attempts gave up at the connect card (#393)', async () => {
  const outage = async (recoverAtMs: number, over: { appBudget?: boolean; maxAttempts?: number }) => {
    let up = false;
    const h = harness({
      storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
      connectImpl: async () => { if (!up) throw new Error('connection timeout'); return 'back'; },
      ...over,
    });
    h.machine.start();
    for (let t = 0; t < recoverAtMs + 10000 && !h.events.some((e) => e.gaveUp || e.success); t += 500) {
      if (t === recoverAtMs) up = true;
      await h.timers.advance(500);
    }
    return h.events;
  };
  for (const at of [60000, 175000]) {
    const kept = await outage(at, { appBudget: true });
    assert.ok(kept.some((e) => e.success) && !kept.some((e) => e.gaveUp), `the server is back after ${at / 1000} s and the loop was still trying`);
  }
  const old = await outage(60000, { maxAttempts: 10 });
  assert.ok(old.some((e) => e.gaveUp) && !old.some((e) => e.success), 'with the old budget of 10 the same outage ends at the connect card');
});

test('an auth refusal stops the loop at once: the server answered, and retrying would repeat the answer for the whole window (#393 P2-2)', async () => {
  const refused = (message: string) => Object.assign(new Error(message), { code: -32000 });
  for (const message of ['invalid proof', 'invalid token']) {
    let dials = 0;
    const h = harness({
      storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 'bad' }),
      connectImpl: async () => { dials++; throw refused(message); },
      appBudget: true,
    });
    h.machine.start();
    await h.timers.advance(1);
    assert.ok(h.events.some((e) => e.gaveUp && e.why === 'auth'), `${message}: gave up at once, saying it was the token (#458 V1)`);
    assert.equal(dials, 1, `${message}: one dial, not a window of them`);
    assert.equal(h.machine.isActive(), false);
    assert.equal(h.unreachable.length, 0, `${message}: the address is not marked unreachable`);
  }
  // Anything that is not the server's coded refusal keeps retrying: a drop, and also an
  // unexpected frame in the login ("auth failed: expected binary auth response") or a bare
  // "auth failed" — a protocol surprise is not a bad token.
  for (const message of ['connection failed', 'connection closed during auth', 'auth failed: expected binary auth response', 'auth failed']) {
    let dials = 0;
    const h = harness({
      storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
      connectImpl: async () => { dials++; throw new Error(message); },
      appBudget: true,
    });
    h.machine.start();
    for (let t = 0; t < 20000; t += 500) await h.timers.advance(500);
    assert.ok(dials > 5 && !h.events.some((e) => e.gaveUp), `${message}: keeps retrying (${dials} dials)`);
  }
});

test('auth errors do NOT mark the address unreachable', async () => {
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 'bad' }),
    connectImpl: async () => { throw Object.assign(new Error('invalid proof'), { code: -32000 }); },
    appBudget: true,
  });
  h.machine.start();
  await h.timers.advance(1);
  assert.ok(h.events.some(e => e.gaveUp));
  assert.equal(h.unreachable.length, 0);
});

test('round-robin skips non-viable addresses on retries', async () => {
  const tried: string[] = [];
  const h = harness({
    storage: makeStorage({
      tmux_address: 'ws://192.168.1.2:9899',
      tmux_token: 't',
      tmux_machine_id: 'm1',
      tmux_machines: JSON.stringify({ m1: ['ws://100.1.1.1:9899'] }),
    }),
    findBest: async () => null, // probe finds nothing → falls back to first
    viable: (url) => url.startsWith('ws://100.'), // LAN address in cooldown
    connectImpl: async (url) => { tried.push(url); throw new Error('connection timeout'); },
    maxAttempts: 3,
  });
  h.machine.start();
  await h.timers.advance(1);
  await h.timers.advance(500);
  await h.timers.advance(1000);
  // Attempt 0 used the probe fallback (primary); retries 1..2 only used the
  // viable (Tailscale) address, never the cooled-down LAN one.
  assert.deepEqual(tried.slice(1), ['ws://100.1.1.1:9899', 'ws://100.1.1.1:9899']);
});

test('cancel mid-backoff stops the loop', async () => {
  let calls = 0;
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: async () => { calls++; throw new Error('connection timeout'); },
    maxAttempts: 5,
  });
  h.machine.start();
  await h.timers.advance(1);      // attempt 1 fails, retry scheduled
  h.machine.cancel();
  await h.timers.advance(10000);  // scheduled retry must not run
  assert.equal(calls, 1);
  assert.equal(h.machine.isActive(), false);
});

test('a success that lands after cancel is ignored', async () => {
  let resolveConnect!: (v: unknown) => void;
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: () => new Promise(res => { resolveConnect = res; }),
  });
  h.machine.start();
  await h.timers.advance(1);
  h.machine.cancel();
  resolveConnect('late');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.events.some(e => e.success), false);
});

test('watchdog force-resets a stuck reconnect', async () => {
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: () => new Promise(() => {}), // hangs forever
  });
  h.machine.start();
  await h.timers.advance(1);
  await h.timers.advance(180000);
  assert.ok(h.events.some(e => e.gaveUp));
  assert.equal(h.machine.isActive(), false);
});

test('missing stored address gives up immediately', async () => {
  const h = harness({
    storage: makeStorage({}),
    connectImpl: async () => {},
  });
  h.machine.start();
  await h.timers.advance(1);
  assert.ok(h.events.some(e => e.gaveUp));
});

test('start() while a loop is running is a no-op — one chain per outage (review 2026-09-03)', async () => {
  // The disconnect callback, the foreground check and a failed address switch
  // can all call start() during one outage. Two chains race for the single
  // socket: each supersedes the other's connect(), each times out, each marks
  // a reachable address unreachable.
  let calls = 0;
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
    connectImpl: () => { calls++; return new Promise(() => {}); }, // in flight
  });
  assert.equal(h.machine.start(), true);
  await h.timers.advance(1);
  assert.equal(h.machine.start(), false, 'the second start is refused');
  assert.equal(h.machine.start(), false);
  await h.timers.advance(1);
  assert.equal(calls, 1, 'exactly one connect in flight');
  assert.equal(h.events.filter(e => e.reconnecting === true && e.attempt === 1).length, 1, 'no duplicate attempt-1 state');
});

test('a superseded chain cannot continue a restarted loop or poison the cooldown', async () => {
  // cancel() → start() is what a typed address (onAddress) does. The OLD
  // chain's connect is still pending; when ws.ts supersedes its socket it
  // rejects with 'connection timeout'. A boolean `reconnecting` is true again
  // by then, so without a generation the old chain would (a) mark the address
  // unreachable and (b) schedule ITS retry beside the new loop's.
  const pending: Array<(e: Error) => void> = [];
  let calls = 0;
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://192.168.1.2:9899', tmux_token: 't' }),
    connectImpl: () => { calls++; return new Promise((_, rej) => { pending.push(rej); }); },
    maxAttempts: 5,
  });
  h.machine.start();
  await h.timers.advance(1);          // chain A: attempt 1 in flight
  h.machine.cancel();
  h.machine.start();                  // chain B
  await h.timers.advance(1);          // chain B: attempt 1 in flight
  assert.equal(calls, 2);
  pending[0]!(new Error('connection timeout')); // A's late failure
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(h.unreachable, [], 'the stale failure marks nothing unreachable');
  await h.timers.advance(5000);       // A's retry, had it been scheduled, would fire here
  assert.equal(calls, 2, 'no retry from the superseded chain');
  assert.equal(h.machine.isActive(), true, 'the live chain is untouched');
  pending[1]!(new Error('connection timeout')); // B's own failure counts
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(h.unreachable, ['ws://192.168.1.2:9899']);
});

test('the machine reconnects the server its target names, read at every attempt (board #335 ②b-2-2)', async () => {
  // The loop no longer reads connection keys: WHERE is the host's answer, and
  // it is asked again on each attempt — a target that moved between two
  // attempts is followed rather than retried at the old address.
  let where = { address: 'ws://192.168.1.2:9899', token: 'old', machineId: '', alternates: [] as string[] };
  const dialled: string[] = [];
  const timers = fakeTimers();
  const events: string[] = [];
  const machine = createReconnectMachine({
    connect: async (url, token) => { dialled.push(`${url}#${token}`); if (dialled.length === 1) throw new Error('timeout'); },
    findBestAddress: async (a) => a[0] ?? null,
    isAddressViable: () => true,
    noteAddressUnreachable: () => {},
    classifyAddress: () => 0,
    addressLabels: ['LAN'],
    target: () => where,
    onStateChange: () => {},
    onSuccess: (use) => events.push(`ok:${use}`),
    onGiveUp: () => events.push('gave up'),
    maxAttempts: 3,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(1);
  where = { address: 'ws://192.168.1.9:9899', token: 'new', machineId: '', alternates: [] };
  await timers.advance(5000);
  assert.deepEqual(dialled, ['ws://192.168.1.2:9899#old', 'ws://192.168.1.9:9899#new']);
  assert.deepEqual(events, ['ok:ws://192.168.1.9:9899']);
});

test('no target gives up at once, and dials nothing', async () => {
  const dialled: string[] = [];
  const events: string[] = [];
  const timers = fakeTimers();
  const machine = createReconnectMachine({
    connect: async (url) => { dialled.push(url); },
    findBestAddress: async () => null, isAddressViable: () => true, noteAddressUnreachable: () => {},
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => null,
    onStateChange: () => {}, onSuccess: () => events.push('ok'), onGiveUp: () => events.push('gave up'),
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(1);
  assert.deepEqual(dialled, []);
  assert.deepEqual(events, ['gave up']);
});

test('the machine reads no connection keys of its own (board #335 ②b-2-2)', async () => {
  // "Whoever is current is who I reconnect", spelled inside the loop, is the
  // thing one-machine-per-runtime cannot have; WHERE is the host's target().
  const { readFile } = await import('node:fs/promises');
  const src = (await readFile(new URL('./reconnect.ts', import.meta.url), 'utf8'))
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/u.test(l)).join('\n');
  assert.doesNotMatch(src, /tmux_|localStorage|getItem\(/u);
});

test('an attempt whose handover was taken over does nothing, and the loop yields (reviewer P1 on c5487bef)', async () => {
  // The connect form claims the activation while a reconnect attempt is
  // still out. That attempt's late success must not run onSuccess, its late
  // failure must not mark the address unreachable or schedule a retry that
  // would take the socket back from the form — and the machine must be idle
  // again, so a later start() is not a no-op forever.
  const { createActivations } = await import('./activation.ts');
  for (const outcome of ['resolve', 'reject'] as const) {
    const handovers = createActivations();
    const timers = fakeTimers();
    const events: string[] = [];
    let finish: () => void = () => {};
    const dialled: string[] = [];
    const machine = createReconnectMachine({
      connect: (url) => { dialled.push(url); return new Promise<void>((res, rej) => { finish = outcome === 'resolve' ? res : () => rej(new Error('timeout')); }); },
      findBestAddress: async (a) => a[0] ?? null, isAddressViable: () => true,
      noteAddressUnreachable: (u) => events.push(`cooldown:${u}`),
      classifyAddress: () => 0, addressLabels: ['LAN'],
      target: () => ({ address: 'ws://192.168.1.2:9899', token: 't', machineId: '', alternates: [] }),
      attempt: () => handovers.claim(),
      onStateChange: () => {}, onSuccess: () => events.push('success'), onGiveUp: () => events.push('gave up'),
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    machine.start();
    await timers.advance(1);
    handovers.claim();           // the form takes the socket
    finish();
    await timers.advance(10_000);
    assert.deepEqual(events, [], `${outcome}: no success, no give-up, no cooldown`);
    assert.equal(dialled.length, 1, `${outcome}: no retry took the socket back`);
    assert.equal(machine.isActive(), false, `${outcome}: the loop yielded`);
    assert.equal(machine.start(), true, `${outcome}: and can start again`);
  }
});

test('a success hands its claim to the host (board #335 ②b-4: no handle is stood down any more)', async () => {
  const { createActivations } = await import('./activation.ts');
  const handovers = createActivations();
  const timers = fakeTimers();
  let n = 0;
  let handed: unknown = null;
  const machine = createReconnectMachine({
    connect: async () => { if (++n === 1) throw new Error('timeout'); },
    findBestAddress: async (a) => a[0] ?? null, isAddressViable: () => true, noteAddressUnreachable: () => {},
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => ({ address: 'ws://192.168.1.2:9899', token: 't', machineId: '', alternates: [] }),
    attempt: () => handovers.claim(),
    onStateChange: () => {}, onSuccess: (_u, _p, h) => { handed = h; }, onGiveUp: () => {},
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(1);
  await timers.advance(1000);
  await timers.advance(1);
  assert.ok(handed && (handed as { current(): boolean }).current() === true, 'the success carries its claim, still current');
});

test('each attempt s connect gets ITS claim, and its own answer reaches onSuccess (reviewer P1-2 on 341554b3)', async () => {
  // R1 hangs; the loop is cancelled and started again (R2). R1's connect
  // must still be holding R1's claim — stale now — never R2's, which a
  // variable shared by the loop would hand it.
  const { createActivations } = await import('./activation.ts');
  const activations = createActivations();
  const timers = fakeTimers();
  const seen: { current(): boolean }[] = [];
  let answerR1: (value: unknown) => void = () => {};
  const answers: unknown[] = [];
  const machine = createReconnectMachine({
    connect: (_url, _token, _ms, claim) => {
      seen.push(claim!);
      return seen.length === 1 ? new Promise((resolve) => { answerR1 = resolve; }) : Promise.resolve('R2 s answer');
    },
    findBestAddress: async (a) => a[0] ?? null, isAddressViable: () => true, noteAddressUnreachable: () => {},
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => ({ address: 'ws://192.168.1.2:9899', token: 't', machineId: '', alternates: [] }),
    attempt: () => activations.claim(),
    onStateChange: () => {}, onSuccess: (_u, _p, _h, answer) => { answers.push(answer); }, onGiveUp: () => {},
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(1);
  machine.cancel();
  machine.start();
  await timers.advance(1);
  assert.equal(seen.length, 2, 'two attempts dialled');
  assert.notEqual(seen[0], seen[1], 'each with its own claim');
  assert.equal(seen[0]!.current(), false, 'R1 s claim is stale');
  assert.equal(seen[1]!.current(), true, 'R2 s is the latest');
  assert.deepEqual(answers, ['R2 s answer'], 'R2 s own answer reached onSuccess');
  answerR1('R1 s late answer');
  await timers.advance(1);
  assert.deepEqual(answers, ['R2 s answer'], 'and R1 s late one never does');
});

// reviewer P1-a on 372cb4af: the chain's OTHER phases. In each, the form
// takes the socket while the chain is between dials; the chain must not dial
// again, mark cooldown or give up.
async function takeoverHarness(over: { addresses?: string[]; probe?: (a: string[]) => Promise<string | null>; fail?: boolean; watchdogMs?: number } = {}) {
  const { createActivations } = await import('./activation.ts');
  const handovers = createActivations();
  const timers = fakeTimers();
  const events: string[] = [];
  const machine = createReconnectMachine({
    connect: async (url) => { events.push(`dial:${url}`); if (over.fail) throw new Error('timeout'); return new Promise<void>(() => {}); },
    findBestAddress: over.probe ?? (async (a) => a[0] ?? null),
    isAddressViable: () => true,
    noteAddressUnreachable: (u) => events.push(`cooldown:${u}`),
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => ({ address: (over.addresses ?? ['ws://192.168.1.2:9899'])[0]!, token: 't', machineId: 'm', alternates: (over.addresses ?? []).slice(1) }),
    attempt: () => handovers.claim(),
    onStateChange: () => {}, onSuccess: () => events.push('success'), onGiveUp: () => events.push('gave up'),
    maxAttempts: 5, watchdogMs: over.watchdogMs ?? 180000,
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { handovers, timers, events, machine };
}

test('a takeover during the BACKOFF ends the chain: the next attempt never dials', async () => {
  const h = await takeoverHarness({ fail: true });
  h.machine.start();
  await h.timers.advance(1);
  assert.deepEqual(h.events, ['dial:ws://192.168.1.2:9899', 'cooldown:ws://192.168.1.2:9899'], 'R1 failed; a retry is scheduled');
  h.handovers.claim();                 // the form takes the socket in the gap
  await h.timers.advance(10_000);
  assert.deepEqual(h.events.filter((e) => e.startsWith('dial:')).length, 1, 'R2 did not dial');
  assert.ok(!h.events.includes('gave up'));
  assert.equal(h.machine.isActive(), false, 'the chain yielded');
});

test('a takeover while the ADDRESS PROBE is out ends the chain, whether the probe resolves or rejects', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    let answer: () => void = () => {};
    const h = await takeoverHarness({
      addresses: ['ws://192.168.1.2:9899', 'ws://100.64.0.2:9899'],
      probe: (a) => new Promise((res, rej) => { answer = () => (outcome === 'resolve' ? res(a[0]!) : rej(new Error('probe'))); }),
    });
    h.machine.start();
    await h.timers.advance(1);
    h.handovers.claim();
    answer();
    await h.timers.advance(10_000);
    assert.deepEqual(h.events, [], `${outcome}: no dial, no cooldown, no give-up`);
    assert.equal(h.machine.isActive(), false);
  }
});

test('a superseded chain s watchdog does not give up', async () => {
  const h = await takeoverHarness({ watchdogMs: 5000 });
  h.machine.start();
  await h.timers.advance(1);                // R1 is out, and never answers
  h.handovers.claim();
  await h.timers.advance(6000);
  assert.ok(!h.events.includes('gave up'), 'somebody else is connecting: not a give-up');
  assert.equal(h.machine.isActive(), false);
});

// ---- #458: the hard rule — a refused (address, token) is never a candidate ----
const LAN = 'ws://192.168.1.2:9899', TS = 'ws://100.1.1.1:9899';
const twoAddresses = () => makeStorage({ tmux_address: LAN, tmux_token: 't', tmux_machine_id: 'm1', tmux_machines: JSON.stringify({ m1: [LAN, TS] }) });

test('a refused pair is out of the first round s probe and of every later round, and the loop never falls back to it (#458 ruling P1-A)', async () => {
  const probed: string[][] = [];
  const dialled: string[] = [];
  const h = harness({
    storage: twoAddresses(),
    findBest: async (a) => { probed.push(a); return a.includes(TS) ? TS : a[0] ?? null; },
    // LAN is in cooldown (soft), TS refused the token (hard).
    viable: (u) => u !== LAN,
    eligible: (u) => (u === TS ? 'refused' : 'ok'),
    connectImpl: async (url) => { dialled.push(url); throw new Error('connection failed'); },
  });
  h.machine.start();
  for (let i = 0; i < 6; i++) await h.timers.advance(3000);
  assert.ok(probed.every((a) => !a.includes(TS)), 'the probe never sees the refused address');
  assert.ok(dialled.length > 0 && dialled.every((u) => u === LAN), `only the eligible address is dialled, cooldown or not: ${dialled.join(',')}`);
});

test('every address refused: no dial at all, and the loop gives up saying so (#458 ruling P1-A)', async () => {
  let dials = 0;
  // Only the configured pairs are refused: nothing outside the set may stand in for them.
  const h = harness({ storage: twoAddresses(), eligible: (u) => ([LAN, TS].includes(u) ? 'refused' : 'ok'), connectImpl: async () => { dials++; } });
  h.machine.start();
  await h.timers.advance(10);
  assert.equal(dials, 0);
  assert.ok(h.events.some((e) => e.gaveUp && e.why === 'auth'));
});

test('a refusal at one address goes on to another address that is still a candidate, in the same loop; none left gives up (#458 validator V3)', async () => {
  const refused = new Set<string>();
  const dialled: string[] = [];
  const h = harness({
    storage: twoAddresses(),
    findBest: async () => LAN,
    eligible: (u) => (refused.has(u) ? 'refused' : 'ok'),
    // LAN reaches another gateway that refuses the token; the caller records it.
    connectImpl: async (url) => { dialled.push(url); if (url === LAN) { refused.add(LAN); throw Object.assign(new Error('invalid proof'), { code: -32000 }); } },
  });
  h.machine.start();
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  assert.deepEqual(dialled, [LAN, TS], 'the refused address once, then the other');
  assert.ok(h.events.some((e) => e.success), 'connected through TS');
  assert.ok(!h.events.some((e) => e.gaveUp));
});

// ---- #458 ruling on f20d1ea0: one pair's state is never the member's ----
// The candidate set {LAN, TS} through every point the loop chooses again —
// the attempt's start (the probe's set), the recheck after the probe's await,
// the recheck after the host's wait, a refusal mid-loop — with the OTHER pair
// in each state. A sibling 'ok' is dialled in the same budget; a 'pending'
// one is waited for (zero dials, no give-up) and dialled once wake() reports
// it decided; only a set with no 'ok' and no 'pending' gives up: 'auth' when
// every pair is refused, 'unknown' otherwise.
type Pair = 'ok' | 'pending' | 'refused' | 'unknown';
const authError = () => Object.assign(new Error('invalid proof'), { code: -32000 });

function setWorld(initial: Record<string, Pair>) {
  const state: Record<string, Pair> = { ...initial };
  const dialled: string[] = [];
  return { state, dialled, eligible: (u: string) => state[u] ?? 'ok' };
}

/** Run until quiet; then, if the other pair was pending, decide it ok and wake. */
async function settleAndWake(h: ReturnType<typeof harness>, w: ReturnType<typeof setWorld>, other: string, was: Pair) {
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  const before = { dials: w.dialled.length, gaveUp: h.events.some((e) => e.gaveUp), active: h.machine.isActive() };
  if (was === 'pending') {
    w.state[other] = 'ok';
    h.machine.wake();
    for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  }
  return before;
}

function expectOutcome(h: ReturnType<typeof harness>, w: ReturnType<typeof setWorld>, other: string, was: Pair, before: { dials: number; gaveUp: boolean; active: boolean }, refusedSent: number, label: string) {
  const sentToOther = w.dialled.filter((u) => u === other).length;
  if (was === 'ok') {
    assert.equal(sentToOther, 1, `${label}: the ok sibling is dialled`);
    assert.ok(h.events.some((e) => e.success?.[0] === other), `${label}: and connects`);
    assert.ok(!h.events.some((e) => e.gaveUp), `${label}: no give-up`);
  } else if (was === 'pending') {
    assert.equal(before.dials, refusedSent, `${label}: nothing sent while the sibling is compared`);
    assert.equal(before.gaveUp, false, `${label}: no give-up while pending`);
    assert.equal(before.active, true, `${label}: the loop waits, in the same budget`);
    assert.equal(sentToOther, 1, `${label}: decided ok, the sibling is dialled once`);
    assert.ok(h.events.some((e) => e.success?.[0] === other), `${label}: and connects`);
  } else {
    assert.equal(sentToOther, 0, `${label}: a ${was} sibling is never sent`);
    const why = h.events.find((e) => e.gaveUp)?.why;
    assert.equal(why, was === 'refused' ? 'auth' : 'unknown', `${label}: the set gives up as ${was === 'refused' ? 'auth' : 'unknown'}`);
  }
}

for (const was of ['ok', 'pending', 'refused', 'unknown'] as const) {
  test(`attempt start (the probe's set): LAN refused, TS ${was} → ${was === 'ok' || was === 'pending' ? 'TS connects' : 'gives up'}; LAN is never sent (#458 ruling on f20d1ea0)`, async () => {
    const w = setWorld({ [LAN]: 'refused', [TS]: was });
    const probed: string[][] = [];
    const h = harness({ storage: twoAddresses(), eligible: w.eligible, findBest: async (a) => { probed.push(a); return a[0] ?? null; },
      connectImpl: async (u) => { w.dialled.push(u); } });
    h.machine.start();
    const before = await settleAndWake(h, w, TS, was);
    assert.equal(w.dialled.filter((u) => u === LAN).length, 0, 'the refused pair: zero dials');
    assert.ok(probed.every((a) => !a.includes(LAN)), 'and never probed');
    expectOutcome(h, w, TS, was, before, 0, `start/${was}`);
  });

  test(`recheck after the probe: the probe chose TS, refused meanwhile; LAN ${was} → ${was === 'ok' || was === 'pending' ? 'LAN connects' : 'gives up'}; TS is never sent (#458 ruling on f20d1ea0)`, async () => {
    const w = setWorld({ [LAN]: 'ok', [TS]: 'ok' });
    const h = harness({ storage: twoAddresses(), eligible: w.eligible,
      // While the probe is out, TS's refusal lands and LAN becomes `was`.
      findBest: async () => { w.state[TS] = 'refused'; w.state[LAN] = was; return TS; },
      connectImpl: async (u) => { w.dialled.push(u); } });
    h.machine.start();
    const before = await settleAndWake(h, w, LAN, was);
    assert.equal(w.dialled.filter((u) => u === TS).length, 0, 'the pair refused during the probe: zero dials');
    expectOutcome(h, w, LAN, was, before, 0, `recheck-probe/${was}`);
  });

  test(`recheck after the host's wait: TS chosen, refused while the host waited; LAN ${was} → ${was === 'ok' || was === 'pending' ? 'LAN connects' : 'gives up'}; TS is never sent (#458 ruling on f20d1ea0)`, async () => {
    const w = setWorld({ [LAN]: 'ok', [TS]: 'ok' });
    let waits = 0;
    const h = harness({ storage: twoAddresses(), eligible: w.eligible, findBest: async () => TS,
      beforeDial: async () => { if (waits++ === 0) { w.state[TS] = 'refused'; w.state[LAN] = was; } },
      connectImpl: async (u) => { w.dialled.push(u); } });
    h.machine.start();
    const before = await settleAndWake(h, w, LAN, was);
    assert.equal(w.dialled.filter((u) => u === TS).length, 0, 'the pair refused during the wait: zero dials');
    expectOutcome(h, w, LAN, was, before, 0, `recheck-wait/${was}`);
  });

  test(`mid-loop: LAN dialled and refused; TS ${was} → ${was === 'ok' || was === 'pending' ? 'TS connects in the same budget' : 'gives up'}; LAN is sent once (#458 ruling on f20d1ea0)`, async () => {
    const w = setWorld({ [LAN]: 'ok', [TS]: 'ok' });
    const h = harness({ storage: twoAddresses(), eligible: w.eligible, findBest: async () => LAN,
      // LAN's gateway refuses the token; the caller records the pair, and by
      // then TS is `was`.
      connectImpl: async (u) => { w.dialled.push(u); if (u === LAN) { w.state[LAN] = 'refused'; w.state[TS] = was; throw authError(); } } });
    h.machine.start();
    const before = await settleAndWake(h, w, TS, was);
    assert.equal(w.dialled.filter((u) => u === LAN).length, 1, 'the refused pair: sent once, never again');
    expectOutcome(h, w, TS, was, before, 1, `mid-loop/${was}`);
  });
}

test('a refusal is the loop s own fact too: with no host eligibility, the refused pair is not sent again and the sibling is tried; both refused is auth (#458)', async () => {
  const dialled: string[] = [];
  const h = harness({ storage: twoAddresses(), findBest: async () => LAN, connectImpl: async (u) => { dialled.push(u); throw authError(); } });
  h.machine.start();
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  assert.deepEqual(dialled, [LAN, TS]);
  assert.equal(h.events.find((e) => e.gaveUp)?.why, 'auth');
});

test('give-up: a set still pending at the watchdog gives up as unreachable, never as auth; a wake after it does nothing (#458)', async () => {
  let dials = 0;
  const h = harness({ storage: twoAddresses(), eligible: () => 'pending', appBudget: true, connectImpl: async () => { dials++; } });
  h.machine.start();
  await h.timers.advance(RECONNECT_WATCHDOG_MS - 1);
  assert.equal(h.machine.isActive(), true, 'waiting, inside the budget');
  await h.timers.advance(1);
  const gave = h.events.filter((e) => e.gaveUp);
  assert.equal(gave.length, 1);
  assert.equal(gave[0]!.why, undefined, 'the budget ran out: not a refusal');
  h.machine.wake();
  await h.timers.advance(10);
  assert.equal(dials, 0, 'nothing dialled, before or after');
});

test('give-up: refused + unknown is unknown, not auth — no pair was decided for every address (#458 ruling on f20d1ea0)', async () => {
  let dials = 0;
  const h = harness({ storage: twoAddresses(), eligible: (u) => (u === LAN ? 'refused' : 'unknown'), connectImpl: async () => { dials++; } });
  h.machine.start();
  await h.timers.advance(10);
  assert.equal(dials, 0);
  assert.equal(h.events.find((e) => e.gaveUp)?.why, 'unknown');
});

test('a wait on pending is woken only by wake(): no timer re-asks it, and a wake while not waiting is a no-op (#458)', async () => {
  let state: Pair = 'pending';
  let dials = 0;
  const h = harness({ storage: makeStorage({ tmux_address: LAN, tmux_token: 't' }), eligible: () => state, connectImpl: async () => { dials++; } });
  h.machine.wake();
  h.machine.start();
  await h.timers.advance(10);
  assert.equal(h.timers.pendingCount(), 1, 'only the watchdog is armed while waiting');
  state = 'ok';
  await h.timers.advance(30000);
  assert.equal(dials, 0, 'decided, but not yet reported: nothing dialled');
  h.machine.wake();
  await h.timers.advance(10);
  assert.equal(dials, 1, 'the wake asks again and dials once');
  h.machine.wake();
  await h.timers.advance(10);
  assert.equal(dials, 1, 'a wake after success is a no-op');
});

test('a token edited during the host s wait: the new pair is asked, pending waits, and it connects once decided (#458 ruling on f20d1ea0, P1-B)', async () => {
  const map = new Map<string, string>();
  const base = makeStorage({ tmux_address: LAN, tmux_token: 'old' });
  const storage = { getItem: (k: string) => (map.has(k) ? map.get(k)! : base.getItem(k)) };
  const decided = new Set<string>();
  const sent: string[] = [];
  let waits = 0;
  const h = harness({ storage, eligible: (_u, t) => (t === 'old' || decided.has(t) ? 'ok' : 'pending'),
    beforeDial: async () => { if (waits++ === 0) map.set('tmux_servers', JSON.stringify([{ id: 'cur', name: 'current', address: LAN, token: 'new' }])); },
    connectImpl: async (_u, t) => { sent.push(t); } });
  h.machine.start();
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  assert.deepEqual(sent, [], 'the old token is not sent after the edit, the new one not before it is decided');
  assert.ok(!h.events.some((e) => e.success || e.gaveUp), 'no success, no give-up while it waits');
  decided.add('new');
  h.machine.wake();
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  assert.deepEqual(sent, ['new']);
  assert.equal(h.events.filter((e) => e.success).length, 1);
});

test('a loop waiting on a pending set holds its attempt s claim: a join that claims meanwhile ends it quietly — its wake dials nothing, its watchdog gives nothing up (#458)', async () => {
  const { createActivations } = await import('./activation.ts');
  const handovers = createActivations();
  const timers = fakeTimers();
  const events: string[] = [];
  let state: Pair = 'pending';
  const machine = createReconnectMachine({
    connect: async (url) => { events.push(`dial:${url}`); },
    findBestAddress: async (a) => a[0] ?? null, isAddressViable: () => true, noteAddressUnreachable: () => {},
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => ({ address: LAN, token: 't', machineId: 'm', alternates: [] }),
    attempt: () => handovers.claim(), eligible: () => state,
    onStateChange: (s) => events.push(`active:${s.reconnecting}`), onSuccess: () => events.push('success'), onGiveUp: () => events.push('gave up'),
    watchdogMs: 180000, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(10);
  assert.equal(machine.isActive(), true, 'waiting');
  handovers.claim();                     // the member's join (a sync) claims it
  state = 'ok';
  machine.wake();
  await timers.advance(10);
  assert.ok(!events.some((e) => e.startsWith('dial:')), 'the superseded wait dials nothing');
  assert.equal(machine.isActive(), false, 'and stops');
  await timers.advance(200000);
  assert.ok(!events.includes('gave up') && !events.includes('success'), 'quietly: nothing failed, nothing succeeded');
});

// ---- #458 ruling on 77e1185d (P1-B): the recheck reads the CURRENT declaration ----
/** The CURRENT server with the machine's addresses, editable mid-attempt. */
function editable(addresses: string[]) {
  const map = new Map<string, string>();
  const put = (list: string[], token = 't') => {
    map.set('tmux_servers', JSON.stringify([{ id: 'cur', name: 'current', address: list[0], token, machineId: 'm1' }]));
    map.set('tmux_machines', JSON.stringify({ m1: list }));
  };
  map.set('tmux_server_current', 'cur');
  put(addresses);
  return {
    storage: { getItem: (k: string) => (map.has(k) ? map.get(k)! : null) },
    /** The person edits the connection: these addresses now. */
    set: (list: string[]) => put(list),
    /** The entry is removed. */
    remove: () => { map.set('tmux_servers', '[]'); },
  };
}
const OTHER = 'ws://10.9.9.9:9899';

for (const window of ['probe', 'host wait'] as const) {
  for (const edit of ['removed', 'replaced'] as const) {
    test(`after the ${window}: the chosen address was ${edit} meanwhile — it is never sent; the address the declaration now names connects in the same budget (#458 ruling on 77e1185d)`, async () => {
      const s = editable([LAN, TS]);
      const dialled: string[] = [];
      // TS is chosen; during the window the person drops it (or swaps it for OTHER).
      const change = () => s.set(edit === 'removed' ? [LAN] : [LAN, OTHER]);
      let waits = 0;
      const h = harness({
        storage: s.storage, eligible: () => 'ok',
        // The probe answers from the set it was given (TS when it is in it).
        findBest: async (a) => { if (window === 'probe' && a.includes(TS)) change(); return a.includes(TS) ? TS : a[0] ?? null; },
        ...(window === 'host wait' ? { beforeDial: async () => { if (waits++ === 0) change(); } } : {}),
        connectImpl: async (u) => { dialled.push(u); },
      });
      h.machine.start();
      for (let i = 0; i < 4; i++) await h.timers.advance(1000);
      assert.equal(dialled.filter((u) => u === TS).length, 0, `the ${edit} address: zero dials`);
      assert.equal(dialled.length, 1, `one dial: ${dialled.join(',')}`);
      assert.ok(h.events.some((e) => e.success), 'and it connects');
      assert.ok(!h.events.some((e) => e.gaveUp), 'in the same budget, no give-up');
    });
  }
}

test('after the host wait: the entry was removed meanwhile — nothing is sent, the loop stops (#458 ruling on 77e1185d)', async () => {
  const s = editable([LAN]);
  let dials = 0;
  const h = harness({ storage: s.storage, eligible: () => 'ok', beforeDial: async () => { s.remove(); }, connectImpl: async () => { dials++; } });
  h.machine.start();
  for (let i = 0; i < 4; i++) await h.timers.advance(1000);
  assert.equal(dials, 0);
  assert.ok(h.events.some((e) => e.gaveUp), 'nothing saved for it: the loop gives up');
});

test('the decided pair is what connect receives: the token the loop checked, in the same turn as the check (#458 ruling on 77e1185d)', async () => {
  const s = editable([LAN]);
  const sent: string[] = [];
  const h = harness({ storage: s.storage, eligible: () => 'ok', connectImpl: async (u, t) => { sent.push(`${u} ${t}`); } });
  h.machine.start();
  await h.timers.advance(10);
  assert.deepEqual(sent, [`${LAN} t`]);
});
