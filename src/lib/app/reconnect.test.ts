import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectMachine, RECONNECT_MAX_ATTEMPTS, RECONNECT_WATCHDOG_MS, RETRY_GAP_CAP_MS, type ReconnectDeps, type ReconnectState } from './reconnect.ts';
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

type HarnessEvent = Partial<ReconnectState> & { success?: [string, string]; gaveUp?: boolean };
function harness({ storage, connectImpl, findBest = async (a: string[]) => a[0] ?? null, viable = () => true, maxAttempts = 3 }: {
  storage: Pick<Storage, 'getItem'>;
  connectImpl: ReconnectDeps['connect'];
  findBest?: ReconnectDeps['findBestAddress'];
  viable?: ReconnectDeps['isAddressViable'];
  maxAttempts?: number;
}) {
  const timers = fakeTimers();
  const events: HarnessEvent[] = [];
  const unreachable: string[] = [];
  const machine = createReconnectMachine({
    connect: connectImpl,
    // eslint-disable-next-line — deliberate partial mocks below
    findBestAddress: findBest,
    isAddressViable: viable,
    noteAddressUnreachable: (u) => unreachable.push(u),
    classifyAddress: (url) => (url.includes('192.168.') ? 0 : url.includes('100.') ? 1 : 2),
    addressLabels: ['LAN', 'Tailscale', 'WAN'],
    // What App passes: the CURRENT server's target.
    target: () => targetOf(storage, currentServerId(storage)),
    onStateChange: (s) => events.push({ ...s }),
    onSuccess: (use, primary) => events.push({ success: [use, primary] }),
    onGiveUp: () => events.push({ gaveUp: true }),
    maxAttempts,
    watchdogMs: 180000,
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

test('a dropped connection is retried for the whole watchdog window, so a 60 s outage never reaches the connect card (#393)', async () => {
  // Owner, 2026-10-15: a dropped connection "should recover quietly". The app's
  // attempt budget is the watchdog window over the retry cap (App.svelte); 10
  // attempts gave up after ~25 s and dropped the person to the connect card,
  // measured live through a proxy that dropped the connection for 30 s.
  // The budget is DERIVED in reconnect.ts (disconnect-grace.md § The client's side):
  // attempts x the longest gap reach the watchdog, so the count cannot end the loop first.
  assert.equal(RECONNECT_MAX_ATTEMPTS, RECONNECT_WATCHDOG_MS / RETRY_GAP_CAP_MS);
  const budget = RECONNECT_MAX_ATTEMPTS;
  const outage = async (maxAttempts: number, recoverAtMs: number) => {
    let up = false;
    const h = harness({
      storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 't' }),
      connectImpl: async () => { if (!up) throw new Error('connection timeout'); return 'back'; },
      maxAttempts,
    });
    h.machine.start();
    for (let t = 0; t < recoverAtMs + 10000 && !h.events.some((e) => e.gaveUp || e.success); t += 500) {
      if (t === recoverAtMs) up = true;
      await h.timers.advance(500);
    }
    return h.events;
  };
  const kept = await outage(budget, 60000);
  assert.ok(kept.some((e) => e.success), 'the server is back after 60 s and the loop is still trying');
  assert.ok(!kept.some((e) => e.gaveUp), 'and it never gave up');
  const old = await outage(10, 60000);
  assert.ok(old.some((e) => e.gaveUp) && !old.some((e) => e.success), 'with the old budget of 10 the same outage ends at the connect card');
});

test('auth errors do NOT mark the address unreachable', async () => {
  const h = harness({
    storage: makeStorage({ tmux_address: 'ws://9.9.9.9:1', tmux_token: 'bad' }),
    connectImpl: async () => { throw new Error('auth failed'); },
    maxAttempts: 1,
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
