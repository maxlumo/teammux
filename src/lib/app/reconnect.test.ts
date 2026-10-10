import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectMachine, type ReconnectDeps, type ReconnectState } from './reconnect.ts';
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

function makeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
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
    // What App passes: the CURRENT server's target. These fixtures seed only
    // the mirror keys, so CURRENT is '' and the mirror answers.
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
  // The connect form opens its own handover while a reconnect attempt is
  // still out. That attempt's late success must not run onSuccess, its late
  // failure must not mark the address unreachable or schedule a retry that
  // would take the socket back from the form — and the machine must be idle
  // again, so a later start() is not a no-op forever.
  const { createHandovers } = await import('./handover.ts');
  for (const outcome of ['resolve', 'reject'] as const) {
    const handovers = createHandovers();
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
      attempt: () => handovers.open(null),
      onStateChange: () => {}, onSuccess: () => events.push('success'), onGiveUp: () => events.push('gave up'),
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    });
    machine.start();
    await timers.advance(1);
    handovers.open(null);           // the form takes the socket
    finish();
    await timers.advance(10_000);
    assert.deepEqual(events, [], `${outcome}: no success, no give-up, no cooldown`);
    assert.equal(dialled.length, 1, `${outcome}: no retry took the socket back`);
    assert.equal(machine.isActive(), false, `${outcome}: the loop yielded`);
    assert.equal(machine.start(), true, `${outcome}: and can start again`);
  }
});

test('a failed attempt resumes the handle it stood down; a success hands its handover to the host', async () => {
  const { createHandovers } = await import('./handover.ts');
  const log: string[] = [];
  let tickets = 0;
  const runtime = { suspend: () => ++tickets, settle: (t: number, v: string) => log.push(`${t}:${v}`) } as never;
  const handovers = createHandovers();
  const timers = fakeTimers();
  let n = 0;
  let handed: unknown = null;
  const machine = createReconnectMachine({
    connect: async () => { if (++n === 1) throw new Error('timeout'); },
    findBestAddress: async (a) => a[0] ?? null, isAddressViable: () => true, noteAddressUnreachable: () => {},
    classifyAddress: () => 0, addressLabels: ['LAN'],
    target: () => ({ address: 'ws://192.168.1.2:9899', token: 't', machineId: '', alternates: [] }),
    attempt: () => handovers.open(runtime),
    onStateChange: () => {}, onSuccess: (_u, _p, h) => { handed = h; }, onGiveUp: () => {},
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  machine.start();
  await timers.advance(1);
  await timers.advance(1000);
  await timers.advance(1);
  assert.deepEqual(log, ['1:resume'], 'the failed attempt (no peer) resumed its ticket');
  assert.ok(handed && typeof (handed as { settle?: unknown }).settle === 'function', 'the success carries its handover');
  (handed as { settle(o: string): void }).settle('same-server');
  assert.deepEqual(log, ['1:resume', '2:resume']);
});
