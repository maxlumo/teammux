// Two servers held at once, and the identity rules that decide which is which
// (board #335 ②a-2). The transport doubles are phase ①'s fixture, so these
// tests exercise the real Connection and the real `servers.ts` writes — only
// the socket and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeE2eServer, MockWebSocket, handshake, handshakePlain, installDoubles, settle, trackTimers, until, withWebCrypto,
} from '../core/connection.fixture.ts';
import { createConnectionRegistry, type ConnectionSlot } from '../core/connection-registry.ts';
import { createServerFleet } from './server-fleet.ts';
import { createServerRuntime, type ServerRuntime } from './server-runtime.ts';
import { loadServers, saveServers, type ServerEntry } from './servers.ts';

installDoubles();

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

const entry = (over: Partial<ServerEntry> & { id: string; address: string }): ServerEntry =>
  ({ name: over.name ?? 'srv', token: 'tok', ...over });

/** `include` declines an entry identity has let go of, so a test that means to
 * get a runtime says so. */
function got(runtime: ServerRuntime | undefined): ServerRuntime {
  assert.ok(runtime, 'the entry is still in the saved registry');
  return runtime;
}

/** A storage holding two saved servers, each knowing its machine. */
function twoServers() {
  const a = entry({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' });
  const b = entry({ id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b' });
  const storage = mem({
    tmux_servers: JSON.stringify([a, b]),
    tmux_server_current: 'a',
  });
  return { storage, a, b };
}

test('two servers are online at the same time, each with its own transport', async () => {
  const timers = trackTimers();
  const { storage, a, b } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const rb = got(fleet.include(b));
    assert.notEqual(ra.connection, rb.connection, 'one connection object each');
    assert.deepEqual(fleet.ids(), ['a', 'b']);

    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const sb = await handshakePlain(rb.connection, 'ws://b:9899', 'tokB', 'm-b');
    assert.ok(ra.connection.isConnected() && rb.connection.isConnected(), 'both live');
    assert.equal(ra.machineId(), 'm-a');
    assert.equal(rb.machineId(), 'm-b');

    // An RPC answered on one socket resolves only on its own runtime.
    const pa = ra.api.listSessions();
    const pb = rb.api.listSessions();
    await settle();
    const idOf = (s: MockWebSocket) => s.texts().at(-1).id;
    sa.message({ id: idOf(sa), result: [{ name: 'on-a' }] });
    sb.message({ id: idOf(sb), result: [{ name: 'on-b' }] });
    assert.deepEqual((await pa).map((s: any) => s.name), ['on-a']);
    assert.deepEqual((await pb).map((s: any) => s.name), ['on-b']);

    // Nothing of either server's clock survives the fleet: phase ①'s liveness
    // timers are per connection, so two runtimes must leave none behind.
    fleet.dropAll();
    assert.equal(timers.live(), 0, 'no interval or timeout outlives the fleet');
  } finally {
    fleet.dropAll();
    timers.restore();
  }
});

test('one entry is one runtime, and one machine is one runtime', async () => {
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const first = got(fleet.include(a));
    assert.equal(fleet.include(a), first, 'asking twice cannot mint a second client');
    // A caller holding a stale copy of the entry — a list read before a merge,
    // a different object with the same identity — must not open a second one.
    assert.equal(fleet.include({ ...a }), first, 'a copy of the entry is the same server');
    // An id that is not in the saved registry is declined outright: identity
    // has either removed it or absorbed it, and re-registering it would put a
    // server back that `servers.ts` has let go of.
    assert.equal(
      fleet.include(entry({ id: 'never-saved', address: 'ws://a-other:9899', machineId: 'm-a' })),
      undefined,
      'include declines an id the registry does not list',
    );
    assert.deepEqual(fleet.ids(), ['a'], 'still one runtime');
  } finally {
    fleet.dropAll();
  }
});

test('two saved entries for one machine share one runtime', async () => {
  // An unrepaired list can hold two entries claiming the same machine (the
  // #318 case `repairServers` heals). Until it is healed, the fleet must not
  // open two clients for one machine: identity is the machine.
  const one = entry({ id: 'one', name: 'n1', address: 'ws://n1:9899', token: 'tok', machineId: 'm-a' });
  const two = entry({ id: 'two', name: 'n2', address: 'ws://n2:9899', token: 'tok', machineId: 'm-a' });
  const storage = mem({ tmux_servers: JSON.stringify([one, two]), tmux_server_current: 'one' });
  const fleet = createServerFleet({ storage });
  try {
    const first = got(fleet.include(one));
    assert.equal(fleet.include(two), first, 'the second entry folds into the machine s runtime');
    assert.deepEqual(fleet.ids(), ['one']);
  } finally {
    fleet.dropAll();
  }
});

test('dropping one server leaves the other working', async () => {
  const { storage, a, b } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const rb = got(fleet.include(b));
    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const sb = await handshakePlain(rb.connection, 'ws://b:9899', 'tokB', 'm-b');

    fleet.drop('a');
    assert.equal(fleet.get('a'), undefined);
    assert.deepEqual(fleet.ids(), ['b']);
    assert.equal(sa.readyState, MockWebSocket.CLOSED, 'A s socket is gone');
    await assert.rejects(ra.api.listSessions(), /connection disposed|is not serving/u, 'and A is terminal');

    // B never noticed.
    assert.ok(rb.connection.isConnected());
    const pb = rb.api.listSessions();
    await settle();
    sb.message({ id: sb.texts().at(-1).id, result: [{ name: 'still-b' }] });
    assert.deepEqual((await pb).map((s: any) => s.name), ['still-b']);
  } finally {
    fleet.dropAll();
  }
});

test('A going down and coming back does not touch B', async () => {
  const { storage, a, b } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const rb = got(fleet.include(b));
    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const sb = await handshakePlain(rb.connection, 'ws://b:9899', 'tokB', 'm-b');

    // A's pending call must reject on A's own socket close, and B's must not.
    const lost = ra.api.listSessions();
    const kept = rb.api.listSessions();
    await settle();
    sa.readyState = MockWebSocket.CLOSED;
    sa.onclose?.({ code: 1006, reason: '', wasClean: false });
    await assert.rejects(lost, 'A s in-flight call fails with A');
    assert.equal(ra.connection.isConnected(), false);
    assert.equal(rb.connection.isConnected(), true, 'B stayed up');

    const back = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    assert.ok(ra.connection.isConnected(), 'A is back on a new socket');
    assert.notEqual(back, sa);
    // B's call, started before A fell over, still answers on B's socket.
    sb.message({ id: sb.texts().at(-1).id, result: [{ name: 'b-unmoved' }] });
    assert.deepEqual((await kept).map((s: any) => s.name), ['b-unmoved']);
  } finally {
    fleet.dropAll();
  }
});

test('dial records the machine that answered and adopts its hostname', async () => {
  // A DEFAULT name (still the URL host it was derived from) follows the
  // server's own hostname, board #310; a name the user typed does not.
  const def = entry({ id: 'd', name: 'n', address: 'ws://n:9899', token: 'tokN', machineId: 'm-d' });
  const typed = entry({ id: 't', name: 'my laptop', address: 'ws://t:9899', token: 'tokT', machineId: 'm-t', named: true });
  const storage = mem({ tmux_servers: JSON.stringify([def, typed]), tmux_server_current: 'd' });
  const fleet = createServerFleet({ storage });
  try {
    for (const [id, addr, machine, host] of [['d', 'ws://n:9899', 'm-d', 'new-host'], ['t', 'ws://t:9899', 'm-t', 'typed-host']] as const) {
      const rt = got(fleet.include(loadServers(storage).find((s) => s.id === id)!));
      const dialing = rt.dial();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.readyState = MockWebSocket.OPEN;
      socket.message({ server_nonce: '00'.repeat(16) });
      socket.message({ result: { authenticated: true, machine_id: machine, hostname: host } });
      const result = await dialing;
      assert.equal(result.ok, true, `${id} authenticated at ${addr}`);
      assert.equal(result.ok && result.entry.id, id, 'published under its own id');
      assert.equal(rt.hostname(), host);
    }
    assert.equal(loadServers(storage).find((s) => s.id === 'd')?.name, 'new-host', 'a default name follows the server');
    assert.equal(loadServers(storage).find((s) => s.id === 't')?.name, 'my laptop', 'a typed name is never replaced');
    // Recording is not activating: CURRENT is untouched by a dial.
    assert.equal(storage.getItem('tmux_server_current'), 'd');
  } finally {
    fleet.dropAll();
  }
});

test('an address that now answers as another machine does not publish under the old entry', async () => {
  // The bug this rule exists for: a loopback tunnel or a reused LAN address
  // that used to reach A now reaches B. Nothing may route B's panes into A's
  // views, and A's saved entry must keep its own name, token and address.
  const { storage, a } = twoServers();
  const before = loadServers(storage);
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const dialing = ra.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    socket.message({ result: { authenticated: true, machine_id: 'm-b', hostname: 'beta-host' } });
    const result = await dialing;

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'elsewhere');
    assert.equal(!result.ok && result.reason === 'elsewhere' && result.entry.id, 'b',
      'it reports the entry of the machine that DID answer');
    assert.equal(ra.connection.isConnected(), false, 'and holds no live link to it');
    const after = loadServers(storage);
    assert.deepEqual(after.find((s) => s.id === 'a'), before.find((s) => s.id === 'a'),
      'A s entry is untouched — name, token and address are still A s');
    assert.equal(after.find((s) => s.id === 'b')?.address, 'ws://a:9899',
      'B s entry learns the address that reached it');
  } finally {
    fleet.dropAll();
  }
});

test('an entry that does not know its machine is merged before it publishes', async () => {
  // A migrated address-history entry, or one recorded before the machine id
  // was learned. Once it authenticates as a machine that already has an entry,
  // that entry is the server and this id must not become a second one.
  const known = entry({ id: 'known', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' });
  const guess = entry({ id: 'guess', name: 'a-other', address: 'ws://a-other:9899', token: 'tokA' });
  const storage = mem({
    tmux_servers: JSON.stringify([known, guess]),
    tmux_server_current: 'known',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899'] }),
  });
  const fleet = createServerFleet({ storage });
  try {
    const rg = got(fleet.include(guess));
    const dialing = rg.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    socket.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'alpha-host' } });
    const result = await dialing;

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason === 'elsewhere' && result.entry.id, 'known');
    assert.equal(rg.connection.isConnected(), false);
    assert.deepEqual(loadServers(storage).map((s) => s.id), ['known'], 'the guess was absorbed');
  } finally {
    fleet.dropAll();
  }
});

test('two unknown entries racing to one machine leave one runtime, in either order', async () => {
  // The ordinary way a duplicate appears: two migrated address-history rows
  // (or a hand-added address) that turn out to be the same machine. Whichever
  // authenticates FIRST becomes that machine's canonical entry; the other is
  // absorbed by `recordServer`, and its runtime must be released — not merely
  // disconnected — because its id no longer exists. A disconnected handle
  // could dial again, keeps its liveness clock, and anything that captured
  // the dead id would go on addressing a server that is gone.
  for (const winnerFirst of [true, false]) {
    const one = entry({ id: 'one', name: 'n1', address: 'ws://n1:9899', token: 'tok' });
    const two = entry({ id: 'two', name: 'n2', address: 'ws://n2:9899', token: 'tok' });
    const storage = mem({ tmux_servers: JSON.stringify([one, two]), tmux_server_current: 'one' });
    const fleet = createServerFleet({ storage });
    try {
      const r1 = got(fleet.include(one));
      const r2 = got(fleet.include(two));
      assert.deepEqual(fleet.ids(), ['one', 'two'], 'two entries, two runtimes until they authenticate');

      // Both dials are in flight before either answer arrives.
      const d1 = r1.dial();
      const s1 = MockWebSocket.instances.at(-1)!;
      const d2 = r2.dial();
      const s2 = MockWebSocket.instances.at(-1)!;
      assert.notEqual(s1, s2, 'one socket each');
      const auth = (s: MockWebSocket) => {
        s.readyState = MockWebSocket.OPEN;
        s.message({ server_nonce: '00'.repeat(16) });
        s.message({ result: { authenticated: true, machine_id: 'm-same', hostname: 'same-host' } });
      };
      // The auth answers come back in the order the test chooses, which is the
      // part neither runtime controls.
      if (winnerFirst) { auth(s1); await d1; auth(s2); } else { auth(s2); await d2; auth(s1); }
      const [first, second] = winnerFirst ? [await d1, await d2] : [await d2, await d1];
      const [winner, loser] = winnerFirst ? [r1, r2] : [r2, r1];
      const loserSocket = winnerFirst ? s2 : s1;

      assert.equal(first.ok, true, 'the first to authenticate owns the machine');
      assert.equal(second.ok, false);
      assert.equal(!second.ok && second.reason, 'elsewhere');
      assert.equal(!second.ok && second.reason === 'elsewhere' && second.entry.id, winner.id);

      assert.deepEqual(loadServers(storage).map((s) => s.id), [winner.id], 'one entry survives');
      assert.deepEqual(fleet.ids(), [winner.id], 'and one runtime');
      assert.equal(fleet.get(loser.id), undefined, 'the fleet forgot the merged-away id');
      assert.equal(loserSocket.readyState, MockWebSocket.CLOSED, 'its socket is closed');
      await assert.rejects(loser.api.listSessions(), /connection disposed|is not serving/u,
        'and the handle is terminal, not merely disconnected');
      await assert.rejects(loser.connection.connect('ws://n2:9899', 'tok'), /connection disposed|is not serving/u,
        'so it cannot dial its way back');

      // A reply that was already on the wire when the merge happened resolves
      // nothing, on either runtime.
      loserSocket.message({ id: 1, result: [{ name: 'ghost' }] });
      const live = winner.api.listSessions();
      await settle();
      const winnerSocket = winnerFirst ? s1 : s2;
      winnerSocket.message({ id: winnerSocket.texts().at(-1).id, result: [{ name: 'real' }] });
      assert.deepEqual((await live).map((s: any) => s.name), ['real']);
    } finally {
      fleet.dropAll();
    }
  }
});

test('a runtime whose entry is absorbed is terminal at once, with no fleet to help; its host disposes it (board #335 ②b-4)', async () => {
  // The rule belongs to the runtime, not to the fleet: whoever holds a
  // runtime directly (②b's provider, a test) must not be left with a handle
  // that can serve a server that no longer exists. Since ②b-4 it DETACHES
  // rather than disposing itself — the connection is the host's to end,
  // after that server's state is released.
  const known = entry({ id: 'known', name: 'n1', address: 'ws://n1:9899', token: 'tok', machineId: 'm-a' });
  const guess = entry({ id: 'guess', name: 'n1', address: 'ws://n1:9899', token: 'tok' });
  const storage = mem({ tmux_servers: JSON.stringify([known, guess]), tmux_server_current: 'known' });
  const registry = createConnectionRegistry();
  const slot = registry.ensure('guess');
  let disposed = 0;
  const realDispose = slot.connection.dispose;
  slot.connection.dispose = () => { disposed++; realDispose(); };
  const runtime = createServerRuntime(guess, { storage, slot });
  try {
    const dialing = runtime.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    socket.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'n1-host' } });
    const result = await dialing;
    assert.equal(!result.ok && result.reason, 'elsewhere');
    assert.deepEqual(loadServers(storage).map((s) => s.id), ['known'], 'the guess was absorbed');
    assert.equal(runtime.alive(), false, 'terminal');
    assert.equal(disposed, 0, 'but it did not dispose its connection itself: that is the host s end');
    await assert.rejects(runtime.api.listSessions(), /is not serving/u, 'and every call refuses');
    runtime.dispose();                                     // the host's end
    await assert.rejects(runtime.connection.connect('ws://n1:9899', 'tok'), /connection disposed/u);
  } finally {
    registry.disposeAll();
  }
});

test('an older dial whose promise already RESOLVED touches nothing (P1-b)', async () => {
  // The case that matters, and the one a socket-driven test cannot reach:
  // phase ① makes a new `connect` CANCEL an older dial, so driving this
  // through real sockets only ever exercises the rejection path — which is
  // exactly the shortcut the reviewer warned about. A `Connection` cannot
  // un-resolve a promise whose continuation has not run, so here the connect
  // promise is resolved by hand, D2 starts in the same turn, and only then
  // does D1's continuation get to run.
  const { storage, a } = twoServers();
  const before = loadServers(storage);
  let resolve1: (v: string) => void = () => {};
  let resolve2: (v: string) => void = () => {};
  let turn = 0;
  let disconnects = 0;
  const slot = {
    connection: {
      connect: () => new Promise<string>((r) => { if (++turn === 1) resolve1 = r; else resolve2 = r; }),
      disconnect: () => { disconnects++; },
      dispose: () => {},
      // The LIVE socket is A's — which is what a stale attempt would read if
      // it took its identity from the connection instead of its own result.
      getMachineId: () => 'm-a',
      getHostname: () => 'alpha-host',
    },
    api: {},
  } as unknown as ConnectionSlot;
  const runtime = createServerRuntime(a, { storage, slot });

  const d1 = runtime.dial();
  const d2 = runtime.dial();
  // D1 authenticated as machine B, and its promise settles first.
  resolve1('m-b');
  resolve2('m-a');
  const [r1, r2] = [await d1, await d2];

  assert.equal(r1.ok, false);
  assert.equal(!r1.ok && r1.reason, 'superseded',
    'not elsewhere, not a stale ok: the attempt no longer owns the runtime');
  assert.equal(r2.ok, true, 'and the attempt that does own it succeeds');
  assert.equal(disconnects, 0,
    'the superseded attempt did NOT disconnect — its own socket is already gone, and the live one is D2 s');
  // No identity write from the stale attempt.
  const after = loadServers(storage);
  assert.equal(after.find((s) => s.id === 'b')?.address, before.find((s) => s.id === 'b')?.address,
    'B s entry never learned A s address');
  assert.equal(after.find((s) => s.id === 'a')?.machineId, 'm-a', 'and A is still A s machine');
});

test('a dial takes its machine id from its own result, not from the socket', async () => {
  // Production cannot make these two disagree — a current attempt's live
  // socket IS its own socket — so a stub that disagrees is the only way to
  // state WHICH source the code trusts. It matters because the one place they
  // could diverge is a stale attempt reading the socket a newer dial opened.
  const { storage, a } = twoServers();
  const slot = {
    connection: {
      connect: async () => 'm-a',                 // this attempt reached A
      disconnect: () => {}, dispose: () => {},
      getMachineId: () => 'm-b',                  // the socket claims otherwise
      getHostname: () => 'alpha-host',
    },
    api: {},
  } as unknown as ConnectionSlot;
  const result = await createServerRuntime(a, { storage, slot }).dial();
  assert.equal(result.ok, true, 'the attempt s own answer decides');
  assert.equal(result.ok && result.entry.id, 'a');
  assert.equal(loadServers(storage).find((s) => s.id === 'b')?.address, 'ws://b:9899',
    'B s entry was not touched by a machine id the attempt never reported');
});

test('a superseded dial that FAILED is also silent', async () => {
  // Same rule on the other branch: the attempt that took over owns the
  // outcome, so a late failure is not reported as this runtime's failure.
  const { storage, a } = twoServers();
  let reject1: (e: unknown) => void = () => {};
  let resolve2: (v: string) => void = () => {};
  let turn = 0;
  const slot = {
    connection: {
      connect: () => new Promise<string>((res, rej) => { if (++turn === 1) reject1 = rej; else resolve2 = res; }),
      disconnect: () => {}, dispose: () => {},
      getMachineId: () => 'm-a', getHostname: () => 'alpha-host',
    },
    api: {},
  } as unknown as ConnectionSlot;
  const runtime = createServerRuntime(a, { storage, slot });

  const d1 = runtime.dial();
  const d2 = runtime.dial();
  reject1(new Error('connection timeout'));
  resolve2('m-a');
  const [r1, r2] = [await d1, await d2];
  assert.equal(!r1.ok && r1.reason, 'superseded', 'not "failed": it is not this runtime s failure any more');
  assert.equal(r2.ok, true);
});

test('a late dial whose socket was cancelled reports superseded, not failure', async () => {
  // The same situation through real sockets, which is the path production
  // takes: phase ① cancels the older dial, so D1 comes back as a rejection.
  // It must still be reported as superseded and must not close D2's socket.
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const d1 = ra.dial();
    const s1 = MockWebSocket.instances.at(-1)!;
    s1.readyState = MockWebSocket.OPEN;
    s1.message({ server_nonce: '00'.repeat(16) });

    const d2 = ra.dial();
    const s2 = MockWebSocket.instances.at(-1)!;
    assert.notEqual(s2, s1, 'the second dial opened its own socket');
    s2.readyState = MockWebSocket.OPEN;
    s2.message({ server_nonce: '00'.repeat(16) });
    s2.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'alpha-host' } });

    assert.equal((await d2).ok, true, 'D2 is the dial that owns the runtime');
    const late = await d1;
    assert.equal(!late.ok && late.reason, 'superseded');
    assert.equal(s2.readyState, MockWebSocket.OPEN, 'D2 s socket was not closed');
    assert.equal(ra.connection.isConnected(), true);
  } finally {
    fleet.dropAll();
  }
});

test('an entry removed mid-dial is not resurrected by the connection that succeeded', async () => {
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const dialing = ra.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });

    // The user removes the server while it is authenticating. That is a
    // decision, and recording the connection would undo it.
    storage.setItem('tmux_servers', JSON.stringify(loadServers(storage).filter((s) => s.id !== 'a')));
    socket.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'alpha-host' } });

    const result = await dialing;
    assert.equal(!result.ok && result.reason, 'gone');
    assert.deepEqual(loadServers(storage).map((s) => s.id), ['b'], 'the entry stays removed');
    assert.equal(fleet.get('a'), undefined, 'and the fleet let the runtime go');
    await assert.rejects(ra.api.listSessions(), /connection disposed|is not serving/u);
  } finally {
    fleet.dropAll();
  }
});

test('a runtime absorbed while idle or mid-auth is released by the fleet (P1-c)', async () => {
  // `recordServer` absorbs every twin of the machine that just authenticated,
  // so A's successful dial can delete B's entry. B has no occasion to discover
  // that: it may never have dialled, or still be authenticating. Membership
  // therefore follows the entry set, reconciled after every recordServer.
  for (const state of ['idle', 'authenticating'] as const) {
    const known = entry({ id: 'known', name: 'n1', address: 'ws://n1:9899', token: 'tok', machineId: 'm-a' });
    const guess = entry({ id: 'guess', name: 'n1', address: 'ws://n1:9899', token: 'tok' });
    const storage = mem({ tmux_servers: JSON.stringify([known, guess]), tmux_server_current: 'known' });
    const registry = createConnectionRegistry();
    const fleet = createServerFleet({ storage, registry });
    try {
      const rk = got(fleet.include(known));
      const rg = got(fleet.include(guess));
      assert.deepEqual(fleet.ids(), ['known', 'guess']);

      let guessSocket: MockWebSocket | undefined;
      let guessDial: Promise<unknown> | undefined;
      if (state === 'authenticating') {
        guessDial = rg.dial();
        guessSocket = MockWebSocket.instances.at(-1)!;
        guessSocket.readyState = MockWebSocket.OPEN;
        guessSocket.message({ server_nonce: '00'.repeat(16) });   // no auth answer yet
      }

      // A authenticates. recordServer stamps m-a on `known` and absorbs the
      // address twin `guess`.
      const dialing = rk.dial();
      const ks = MockWebSocket.instances.at(-1)!;
      ks.readyState = MockWebSocket.OPEN;
      ks.message({ server_nonce: '00'.repeat(16) });
      ks.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'n1-host' } });
      assert.equal((await dialing).ok, true, `A owns the machine (${state})`);

      assert.deepEqual(loadServers(storage).map((s) => s.id), ['known'], 'one entry');
      assert.deepEqual(fleet.ids(), ['known'], `the absorbed runtime is gone from the fleet (${state})`);
      assert.equal(registry.get('guess'), undefined, 'and from the registry');
      await assert.rejects(rg.api.listSessions(), /connection disposed|is not serving/u, 'its handle is terminal');
      await assert.rejects(rg.connection.connect('ws://n1:9899', 'tok'), /connection disposed|is not serving/u,
        'so it cannot dial its way back');
      if (guessSocket) {
        assert.equal(guessSocket.readyState, MockWebSocket.CLOSED, 'its half-finished auth was cancelled');
        // A reply already on that wire must not recreate the entry.
        guessSocket.message({ result: { authenticated: true, machine_id: 'm-late', hostname: 'ghost' } });
        await settle();
        assert.equal(!(await guessDial as any).ok, true);
        assert.deepEqual(loadServers(storage).map((s) => s.id), ['known'], 'the late answer built nothing');
      }
      // And a stale list cannot put it back.
      assert.equal(fleet.include(guess), undefined, 'include declines an entry identity has let go of');
      assert.deepEqual(fleet.ids(), ['known']);
    } finally {
      fleet.dropAll();
    }
  }
});

test('the reverse direction: the unknown entry authenticates first', async () => {
  const known = entry({ id: 'known', name: 'n1', address: 'ws://n1:9899', token: 'tok', machineId: 'm-a' });
  const guess = entry({ id: 'guess', name: 'n1', address: 'ws://n1:9899', token: 'tok' });
  const storage = mem({ tmux_servers: JSON.stringify([known, guess]), tmux_server_current: 'known' });
  const fleet = createServerFleet({ storage });
  try {
    const rk = got(fleet.include(known));
    const rg = got(fleet.include(guess));
    const dialing = rg.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    socket.message({ result: { authenticated: true, machine_id: 'm-a', hostname: 'n1-host' } });
    const result = await dialing;

    // `known` already holds m-a, so it is the canonical entry whichever side
    // authenticates: identity is the machine, not the order of arrival.
    assert.equal(!result.ok && result.reason === 'elsewhere' && result.entry.id, 'known');
    assert.deepEqual(loadServers(storage).map((s) => s.id), ['known']);
    assert.deepEqual(fleet.ids(), ['known'], 'the loser left both maps');
    assert.ok(rk.connection, 'and the survivor is untouched');
    await assert.rejects(rg.api.listSessions(), /connection disposed|is not serving/u);
  } finally {
    fleet.dropAll();
  }
});

test('an entry whose machine is new keeps its own id and gets stamped', async () => {
  const fresh = entry({ id: 'fresh', name: 'ws://n:9899', address: 'ws://n:9899', token: 'tokN' });
  const storage = mem({ tmux_servers: JSON.stringify([fresh]), tmux_server_current: 'fresh' });
  const fleet = createServerFleet({ storage });
  try {
    const rt = got(fleet.include(fresh));
    const dialing = rt.dial();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    socket.message({ result: { authenticated: true, machine_id: 'm-new', hostname: 'new-host' } });
    const result = await dialing;
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.entry.id, 'fresh');
    assert.equal(loadServers(storage).find((s) => s.id === 'fresh')?.machineId, 'm-new');
  } finally {
    fleet.dropAll();
  }
});

test('a removed entry is not dialled from a stale address', async () => {
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    storage.setItem('tmux_servers', JSON.stringify(loadServers(storage).filter((s) => s.id !== 'a')));
    const sockets = MockWebSocket.instances.length;
    const result = await ra.dial();
    assert.equal(!result.ok && result.reason, 'gone');
    assert.equal(MockWebSocket.instances.length, sockets, 'no socket was opened');
    // The name is still available to whoever has to tear the runtime down.
    assert.equal(ra.entry().name, 'alpha');
  } finally {
    fleet.dropAll();
  }
});

test('caps are the answer of the server that was asked', async () => {
  const { storage, a, b } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const rb = got(fleet.include(b));
    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const sb = await handshakePlain(rb.connection, 'ws://b:9899', 'tokB', 'm-b');
    assert.deepEqual(ra.caps(), { hub: null, backends: null }, 'unasked is not "no"');

    const probing = Promise.all([ra.probeCaps(), rb.probeCaps()]);
    await settle();
    const answer = (s: MockWebSocket, method: string, body: unknown) => {
      const req = s.texts().findLast((t: any) => t.method === method);
      assert.ok(req, `${method} was asked`);
      s.message({ id: req.id, ...(body as object) });
    };
    // A has the Hub and two backends; B is a plain tmux server.
    answer(sa, 'hub_rooms', { result: { rooms: {} } });
    answer(sa, 'backends_list', { result: { backends: [{ name: 'kiro' }, { name: 'codex' }] } });
    answer(sb, 'hub_rooms', { error: { code: -32601, message: 'no such method' } });
    answer(sb, 'backends_list', { error: { code: -32601, message: 'no such method' } });
    await probing;

    assert.equal(ra.caps().hub, true);
    assert.deepEqual(ra.caps().backends?.map((x) => x.name), ['kiro', 'codex']);
    assert.equal(rb.caps().hub, false, 'a definitive "no method" is a no');
    assert.equal(rb.caps().backends, null);
  } finally {
    fleet.dropAll();
  }
});

test('a transient failure leaves BOTH caps alone; an empty list is unknown', async () => {
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    // findLast, not find: the second probe sends new requests, and answering
    // the first probe's stale id would leave these pending until the RPC
    // timeout — the test would then pass through the timeout's catch branch
    // and prove nothing about either rule.
    const answer = (method: string, body: unknown) => {
      const req = sa.texts().findLast((t: any) => t.method === method);
      assert.ok(req, `${method} was asked`);
      sa.message({ id: req.id, ...(body as object) });
    };
    const first = ra.probeCaps();
    await settle();
    answer('hub_rooms', { result: { rooms: {} } });
    answer('backends_list', { result: { backends: [{ name: 'kiro' }] } });
    await first;
    assert.equal(ra.caps().hub, true);
    assert.deepEqual(ra.caps().backends?.map((x) => x.name), ['kiro']);

    // A reconnect blip must not unmount the Hub and destroy its state, and
    // must not empty a backend list the page already has: a failure is not an
    // answer, so the last real one stands. That is what "caps survive a
    // reconnect of the same server" has to mean.
    const again = ra.probeCaps();
    await settle();
    answer('hub_rooms', { error: { code: -32000, message: 'timeout' } });
    answer('backends_list', { error: { code: -32000, message: 'timeout' } });
    await again;
    assert.equal(ra.caps().hub, true, 'only a definitive no flips it off');
    assert.deepEqual(ra.caps().backends?.map((x) => x.name), ['kiro'], 'and the list is still there');

    // A server that answers with an EMPTY list IS answering, and `agents.ts`
    // reads that as unknown rather than "this server has none".
    const third = ra.probeCaps();
    await settle();
    answer('hub_rooms', { result: { rooms: {} } });
    answer('backends_list', { result: { backends: [] } });
    await third;
    assert.equal(ra.caps().backends, null);
  } finally {
    fleet.dropAll();
  }
});

test('a slower probe cannot overwrite a newer answer', async () => {
  // Two probes overlap — a reconnect while one is in flight, or an upgrade.
  // The older `method not found` must not unmount a Hub the newer probe has
  // just confirmed (reviewer P2): `dead` says whether the runtime is held,
  // not whether an answer is current.
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    const sa = await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const ids = (method: string) => sa.texts().filter((t: any) => t.method === method).map((t: any) => t.id);

    const older = ra.probeCaps();
    await settle();
    const newer = ra.probeCaps();
    await settle();
    const [hubOld, hubNew] = ids('hub_rooms');
    const [backOld, backNew] = ids('backends_list');

    // The newer probe answers first: this server HAS the Hub.
    sa.message({ id: hubNew, result: { rooms: {} } });
    sa.message({ id: backNew, result: { backends: [{ name: 'kiro' }] } });
    await newer;
    assert.equal(ra.caps().hub, true);

    // Then the older one arrives, from before the upgrade, saying there is no
    // such method.
    sa.message({ id: hubOld, error: { code: -32601, message: 'no such method' } });
    sa.message({ id: backOld, result: { backends: [] } });
    await older;
    assert.equal(ra.caps().hub, true, 'the stale no did not unmount the Hub');
    assert.deepEqual(ra.caps().backends?.map((x) => x.name), ['kiro'], 'nor empty the list');
  } finally {
    fleet.dropAll();
  }
});

test('a probe in flight when the runtime is dropped settles without publishing', async () => {
  const { storage, a } = twoServers();
  const fleet = createServerFleet({ storage });
  try {
    const ra = got(fleet.include(a));
    await handshakePlain(ra.connection, 'ws://a:9899', 'tokA', 'm-a');
    const probing = ra.probeCaps();
    await settle();
    fleet.drop('a');
    const caps = await probing;
    assert.deepEqual(caps, { hub: null, backends: null }, 'a dropped runtime learns nothing');
    assert.deepEqual(ra.caps(), { hub: null, backends: null });
  } finally {
    fleet.dropAll();
  }
});

test('an answer that RESOLVES after the drop is still not published', async () => {
  // The race the `dead` guard exists for, with the timing made exact: the RPC
  // resolves successfully, and only then does the runtime go away. Through a
  // socket the drop rejects the pending call instead, so that path can only
  // ever exercise the catch branch — this one drives the success branch.
  const { storage, a } = twoServers();
  let answerHub: (v: unknown) => void = () => {};
  let answerBackends: (v: unknown) => void = () => {};
  let disposed = 0;
  const slot = {
    connection: {
      dispose: () => { disposed++; },
      getMachineId: () => 'm-a',
      getHostname: () => 'alpha-host',
    },
    api: {
      hubRooms: () => new Promise((resolve) => { answerHub = resolve; }),
      backendsList: () => new Promise((resolve) => { answerBackends = resolve; }),
    },
  } as unknown as ConnectionSlot;
  const runtime = createServerRuntime(a, { storage, slot });

  const probing = runtime.probeCaps();
  runtime.dispose();
  assert.equal(disposed, 1, 'the connection is released');
  answerHub({ rooms: {} });
  answerBackends({ backends: [{ name: 'kiro' }] });
  assert.deepEqual(await probing, { hub: null, backends: null },
    'both answers are dropped, not written onto a runtime nobody holds');
  // Terminal, like Connection.dispose: a second drop is a no-op.
  runtime.dispose();
  assert.equal(disposed, 2, 'and it stays idempotent at the connection');
});

test('the registry is the lifetime, the fleet is the membership', async () => {
  const { storage, a, b } = twoServers();
  const registry = createConnectionRegistry();
  const fleet = createServerFleet({ storage, registry });
  try {
    const ra = got(fleet.include(a));
    fleet.include(b);
    assert.equal(registry.get('a')?.connection, ra.connection, 'the runtime uses the registry s slot');
    fleet.drop('a');
    assert.equal(registry.get('a'), undefined, 'and dropping it clears both maps');
    assert.ok(registry.get('b'), 'B is still registered');
    fleet.dropAll();
    assert.equal(registry.get('b'), undefined);
    assert.deepEqual(fleet.ids(), []);
  } finally {
    fleet.dropAll();
  }
});

test('a frame sealed for one server resolves nothing on the other', async () => {
  // End to end with real Web Crypto: the two runtimes negotiate separate
  // session keys, so a frame sealed by A is undecryptable by B. What must NOT
  // happen is B resolving A's call — and by the baseline's own rule a frame
  // that fails to decrypt costs that socket its link, because the receive
  // counter has already moved past it. So the cross-delivery costs B its
  // socket and leaves A's call still waiting for A.
  await withWebCrypto(async () => {
    const { storage, a, b } = twoServers();
    const fleet = createServerFleet({ storage });
    const srvA = new FakeE2eServer('tokA', 2, 'm-a', 'alpha-host');
    const srvB = new FakeE2eServer('tokB', 2, 'm-b', 'beta-host');
    try {
      const ra = got(fleet.include(a));
      const rb = got(fleet.include(b));
      const sa = await handshake(ra.connection, srvA, 'ws://a:9899', 'tokA');
      const sb = await handshake(rb.connection, srvB, 'ws://b:9899', 'tokB');
      assert.equal(ra.machineId(), 'm-a');
      assert.equal(rb.machineId(), 'm-b');

      const pa = ra.api.listSessions();
      let settled = false;
      void pa.then(() => { settled = true; }, () => { settled = true; });
      const reqA = await srvA.next(sa);
      const forA = await srvA.seal(JSON.stringify({ id: reqA.id, result: [{ name: 'a-only' }] }));

      sb.binary(forA);
      await until(() => !rb.connection.isConnected());
      assert.equal(settled, false, 'B could not answer a call it never carried');
      assert.equal(ra.connection.isConnected(), true, 'and A is untouched by B s loss');

      sa.binary(forA);
      assert.deepEqual((await pa).map((s: any) => s.name), ['a-only'], 'A s own socket answers it');
    } finally {
      fleet.dropAll();
    }
  });
});

// A BORROWED slot (board #335 ②b-1, reviewer P1-a 2026-10-10). Through ②b
// production's one runtime sits on the `ws.ts` facade's connection, because
// sixteen modules still import their RPCs from it and a second connection
// would put them on the other socket. The runtime therefore must not own that
// object's lifetime — not even from its own inside, which is where the danger
// is: `dial` ends the runtime on three paths, and the ORDINARY one is an old
// address-only entry being absorbed into the canonical entry of the machine
// that answered. Owning the lifetime there would close the legacy transport
// for the rest of the session.
//
// These cases drive those paths with a counting slot, because no node test
// can make the real facade authenticate.
function countingSlot(over: Record<string, unknown> = {}) {
  const calls = { disconnect: 0, dispose: 0 };
  const slot = {
    connection: {
      connect: async () => 'm-a',
      disconnect: () => { calls.disconnect++; },
      dispose: () => { calls.dispose++; },
      getMachineId: () => 'm-a',
      getHostname: () => 'alpha-host',
      ...over,
    },
    api: { listSessions: async () => [{ name: 'live' }] },
  } as unknown as ConnectionSlot;
  return { slot, calls };
}

test('a runtime whose entry is removed mid-auth DETACHES, borrowed or owned; only its host s end disposes (board #335 ②b-4)', async () => {
  const { storage, a } = twoServers();
  let resolve: (v: string) => void = () => {};
  const { slot, calls } = countingSlot({ connect: () => new Promise<string>((r) => { resolve = r; }) });
  const runtime = createServerRuntime(a, { storage, slot, borrowed: true });

  const dial = runtime.dial();
  // Removed WHILE authenticating: a decision that recording the successful
  // connection would undo.
  saveServers(storage, loadServers(storage).filter((s) => s.id !== 'a'));
  resolve('m-a');
  assert.deepEqual(await dial, { ok: false, reason: 'gone' });
  assert.deepEqual(calls, { disconnect: 0, dispose: 0 },
    'the borrowed connection is left alive for its owner');
  await assert.rejects(runtime.api.listSessions(), /detached/u, 'and the handle is terminal');

  // The same path on an OWNED slot detaches too (the gap recorded at b2-4's
  // 085b0e70, closed here): disposing itself would skip the host's release
  // of that server's state. It refuses at once — a method captured before
  // the dial included — and the connection goes only when the host ends it.
  const owned = twoServers();
  let resolveOwned: (v: string) => void = () => {};
  const second = countingSlot({ connect: () => new Promise<string>((r) => { resolveOwned = r; }) });
  const ownedRuntime = createServerRuntime(owned.a, { storage: owned.storage, slot: second.slot });
  const ownedDial = ownedRuntime.dial();
  saveServers(owned.storage, loadServers(owned.storage).filter((s) => s.id !== 'a'));
  resolveOwned('m-a');
  const captured = ownedRuntime.api.listSessions;
  assert.deepEqual(await ownedDial, { ok: false, reason: 'gone' });
  assert.equal(second.calls.dispose, 0, 'the owned runtime did not dispose itself');
  await assert.rejects(captured(), /detached/u, 'a pre-captured method refuses at once');
  assert.equal(ownedRuntime.alive(), false, 'and the handle is terminal');
  ownedRuntime.dispose();                                  // the host's end
  assert.equal(second.calls.dispose, 1, 'the host s end disposes the connection');
});

test('a borrowed runtime absorbed into another entry keeps the socket the app came up on', async () => {
  // The ordinary absorption: this id knows no machine, the machine that
  // answered already has an entry, so `recordServer` folds this one away. The
  // app is coming up on the machine that answered — cutting that socket from
  // inside a dial that is REPORTING the canonical entry would take the
  // connection away from the caller that has to recover.
  const known = entry({ id: 'canon', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' });
  const history = entry({ id: 'history', name: 'ws://old:9899', address: 'ws://old:9899', token: 'tokA' });
  const storage = mem({
    tmux_servers: JSON.stringify([known, history]),
    tmux_server_current: 'canon',
  });
  const { slot, calls } = countingSlot();
  const runtime = createServerRuntime(history, { storage, slot, borrowed: true });

  const result = await runtime.dial();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'elsewhere');
  assert.equal(!result.ok && result.reason === 'elsewhere' && result.entry.id, 'canon',
    'it reports the entry for the machine that answered');
  assert.ok(!loadServers(storage).some((s) => s.id === 'history'), 'and this id is gone');
  assert.deepEqual(calls, { disconnect: 0, dispose: 0 },
    'the legacy transport is still open: every un-migrated module is on it');
  await assert.rejects(runtime.api.listSessions(), /detached/u, 'the absorbed handle is inert');

  // Owned, the same dial closes the socket, because a connection under an id
  // that no longer exists is exactly what must not stay open.
  const owned = mem({
    tmux_servers: JSON.stringify([known, history]),
    tmux_server_current: 'canon',
  });
  const second = countingSlot();
  await createServerRuntime(history, { storage: owned, slot: second.slot }).dial();
  assert.equal(second.calls.disconnect, 1, 'an owned runtime closes a socket it may not keep');
});

test('a borrowed runtime that reaches a DIFFERENT known server detaches; an owned one stays A s handle', async () => {
  // known-A → known-B (reviewer P1-a2): both entries survive, so the
  // absorption rule above never fires. The dial was A's and the socket it got
  // reaches B — and the socket is not ours to close — so a BORROWED handle is
  // provably no longer serving A, and anything still holding its api would be
  // sending A's work to B. An OWNED handle closed its own socket instead, so
  // it is still A's handle and may dial A again.
  const { storage, a } = twoServers();
  const { slot, calls } = countingSlot({ connect: async () => 'm-b' });
  const runtime = createServerRuntime(a, { storage, slot, borrowed: true });

  const result = await runtime.dial();
  assert.equal(!result.ok && result.reason, 'elsewhere');
  assert.equal(!result.ok && result.reason === 'elsewhere' && result.entry.id, 'b');
  assert.deepEqual(loadServers(storage).map((s) => s.id), ['a', 'b'], 'both entries are kept');
  assert.deepEqual(calls, { disconnect: 0, dispose: 0 }, 'the owner s socket is untouched');
  assert.equal(runtime.alive(), false, 'but the handle has let go');
  await assert.rejects(runtime.api.listSessions(), /detached/u);

  const owned = twoServers();
  const second = countingSlot({ connect: async () => 'm-b' });
  const ownedRuntime = createServerRuntime(owned.a, { storage: owned.storage, slot: second.slot });
  const ownedResult = await ownedRuntime.dial();
  assert.equal(!ownedResult.ok && ownedResult.reason, 'elsewhere');
  assert.equal(second.calls.disconnect, 1, 'it closes the socket that reached the wrong server');
  assert.equal(second.calls.dispose, 0);
  assert.equal(ownedRuntime.alive(), true, 'and remains A s handle, free to dial A again');
});

test('a borrowed handle keeps answering until it is detached', async () => {
  // The gate is on the handle's own liveness, not on the connection: while the
  // handle is the one the app shows, its api is the facade's api, so a bound
  // page and an un-migrated module are provably on one socket.
  const { storage, a } = twoServers();
  const { slot } = countingSlot();
  const runtime = createServerRuntime(a, { storage, slot, borrowed: true });
  assert.deepEqual((await runtime.api.listSessions()).map((s: any) => s.name), ['live']);
  runtime.dispose();
  await assert.rejects(runtime.api.listSessions(), /detached/u);
});

test('with a host end, drop and reconcile END a runtime release → dispose, and the id is free at once (board #335 ②b-4)', async () => {
  // Reviewer and orchestrator, 01:46: every fleet drop and reconcile goes
  // through the host's one end — stop, release that server's state, then
  // dispose — never a bare connection close. The slot leaves the registry
  // NOW, so including the id again builds a NEW connection while the old one
  // is still being ended.
  const { storage, a, b } = twoServers();
  const registry = createConnectionRegistry();
  const order: string[] = [];
  let finish: () => void = () => {};
  const fleet = createServerFleet({
    storage, registry,
    // What App's end does (handle-end.ts): stop serving at once, release,
    // dispose last.
    end: (runtime) => {
      runtime.detach();
      order.push(`end:${runtime.id}`);
      return new Promise<void>((done) => { finish = () => { order.push(`dispose:${runtime.id}`); runtime.dispose(); done(); }; });
    },
  });
  try {
    const ra = got(fleet.include(a));
    got(fleet.include(b));
    const captured = ra.api.listSessions;
    fleet.drop('a');
    assert.deepEqual(order, ['end:a'], 'the host s end ran, not a direct dispose');
    assert.equal(registry.get('a'), undefined, 'the slot left the registry at once');
    await assert.rejects(captured(), /is not serving/u, 'the ending runtime refuses at once, before its dispose');
    const again = got(fleet.include(a));
    assert.notEqual(again, ra, 'a new runtime');
    assert.notEqual(again.connection, ra.connection, 'over a new connection, while the old one is still ending');
    finish();
    await Promise.resolve();
    assert.deepEqual(order, ['end:a', 'dispose:a'], 'dispose last');
    await assert.rejects(captured(), /connection disposed|is not serving/u, 'and the old api refuses');
    // Reconcile takes the same road.
    saveServers(storage, loadServers(storage).filter((s) => s.id !== 'b'));
    fleet.reconcile();
    assert.deepEqual(order.slice(-1), ['end:b'], 'a reconcile ends through the host too');
  } finally {
    registry.disposeAll();
  }
});
