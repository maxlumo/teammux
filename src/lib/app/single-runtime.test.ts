// The one runtime production holds while `ws.ts` still owns the socket
// (board #335 ②b-1), and the lifetime rule that makes borrowing safe
// (reviewer P1-a, 2026-10-10).
//
// Borrowing is what keeps ONE socket while the consumers move: a provided
// subtree and a module that still imports its RPCs from ws.ts talk over the
// same connection, so each ②b commit is behaviour-identical in Single mode.
// The danger is the other side of it — the handle must never be able to act
// on that connection once it has stopped serving its server, and the
// connection must survive the handle.
//
// These cases drive the REAL facade: `connection.fixture.ts` gives it a mock
// socket and a plain-token handshake, which is how ②a tests the transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockWebSocket, handshakePlain, installDoubles, settle } from '../core/connection.fixture.ts';
import { SERVERS_KEY, type ServerEntry } from './servers.ts';

installDoubles();
const { compatSlotApi, connection } = await import('../core/ws.ts');
const { createSingleRuntime } = await import('./single-runtime.ts');

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem(k: string, v: string) { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const entry = (over: Partial<ServerEntry> = {}): ServerEntry => ({
  id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', named: true, ...over,
} as ServerEntry);

const saved = (...servers: ServerEntry[]) => mem({ [SERVERS_KEY]: JSON.stringify(servers) });

/** Send and forget. A pending RPC rejects when the socket closes, and a
 * rejection nobody caught after the test ends is a failure of its own. */
const fire = (p: Promise<unknown>) => { void p.catch(() => {}); };

/** The facade is one object for the whole process, as it is for the whole app:
 * every case leaves it connectable again. */
function cleanup() {
  connection.disconnect();
  MockWebSocket.instances.length = 0;
}

test('it is the facade s own slot, and its api reaches the facade', async (t) => {
  t.after(cleanup);
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  assert.equal(rt.id, 'a');
  // The connection is the facade's object itself — one socket, so a page bound
  // to this runtime and an un-migrated module cannot disagree about which
  // server they are on.
  assert.equal(rt.connection, connection);

  const socket = await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');
  assert.equal(connection.isConnected(), true);
  fire(rt.api.listSessions());
  await settle();
  const sent = socket.texts().map((m: any) => m.method);
  assert.ok(sent.includes('list_sessions'), `the call went out over the facade s socket: ${sent.join(',')}`);
  assert.equal(rt.alive(), true);
});

test('the gate is asked when the call is MADE, not when the method is read', async (t) => {
  t.after(cleanup);
  // Both ways a page really calls. A page holds `api` for its whole life and
  // calls through it much later; and a call like `fsWrite(path, await body)`
  // reads the method BEFORE the await and sends AFTER it. A gate that fired on
  // the property read would let both through to a slot that by then serves
  // another server.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');

  const captured = rt.api.listSessions;              // read while alive
  assert.equal(captured, rt.api.listSessions, 'the wrapper is stable, so a holder keeps the gate');

  rt.dispose();
  await assert.rejects(() => captured(), /detached/u, 'the captured method refuses');
  await assert.rejects(() => rt.api.listSessions(), /detached/u);
});

test('in the window after the socket changes hands, the old handle sends nothing', async (t) => {
  t.after(cleanup);
  // The ruling's case. A is authenticated and a page has a call in flight. The
  // lease is revoked, the shared socket is re-dialled at B, and the page's
  // callback settles BEFORE the new tree mounts. Nothing of A's may reach B.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  const socketA = await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');
  const inFlight = rt.api.listSessions();
  fire(inFlight);
  await settle();
  assert.ok(socketA.texts().some((m: any) => m.method === 'list_sessions'), 'A s call is on the wire');

  // Revoke BEFORE the re-dial — the order the switch and the connect form
  // both follow.
  rt.dispose();
  const socketB = await handshakePlain(connection, 'ws://b:9899', 'tokB', 'm-b');
  const beforeB = socketB.sent.length;

  // A's call cannot resolve against B; the re-dial ended it.
  await assert.rejects(() => inFlight, /./u, 'the in-flight call does not come back as B s answer');
  // And the continuation that runs in the window — the UI for B has not
  // mounted yet — is refused rather than sent.
  await assert.rejects(() => rt.api.listSessions(), /detached/u);
  await assert.rejects(() => rt.api.capturePane('work:1.0'), /detached/u);
  await settle();
  assert.equal(socketB.sent.length, beforeB, 'B s socket carried nothing of A s');
  // The facade itself is untouched: every un-migrated module still works.
  assert.equal(connection.isConnected(), true);
  assert.equal(connection.getMachineId(), 'm-b');
  fire(compatSlotApi.listSessions());
  await settle();
  assert.ok(socketB.texts().some((m: any) => m.method === 'list_sessions'),
    'and a legacy ws caller reaches B normally');
});

test('releasing the handle leaves the connection to its owner', async (t) => {
  t.after(cleanup);
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');

  rt.dispose();

  assert.equal(rt.alive(), false);
  assert.deepEqual(await rt.dial(), { ok: false, reason: 'gone' }, 'the handle cannot dial again');
  // Not disposed, not even disconnected: `Connection.dispose()` is terminal
  // and this object is the transport of every module that has not moved yet.
  assert.equal(connection.isConnected(), true);
  fire(compatSlotApi.listSessions());
  await settle();
  assert.equal(MockWebSocket.instances.at(-1)!.texts().some((m: any) => m.method === 'list_sessions'), true);
});

test('a successful answer whose continuation runs after the handover sends nothing', async (t) => {
  t.after(cleanup);
  // The shape the earlier version of this test did NOT create (reviewer's
  // evidence note, 2026-10-10): the call SUCCEEDED, the answer is in, and the
  // page's continuation — the `.then` that does the next thing — runs after
  // the lease was revoked and the socket changed hands. That continuation is
  // ordinary code holding an ordinary api object.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  const socketA = await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');
  const answered = rt.api.listSessions();
  await settle();
  const sent = socketA.texts().find((m: any) => m.method === 'list_sessions');
  assert.ok(sent, 'the call went out');
  // The server answers it successfully, and the connection processes it: from
  // here the call has SUCCEEDED and only the page's continuation is still owed.
  socketA.message({ id: (sent as any).id, result: [{ name: 'work' }] });
  await settle();

  let late: Promise<unknown> | null = null;
  // Attached now, so it is queued as a microtask and runs AFTER the
  // synchronous handover below — which is the shape a page produces: the
  // answer arrived, and what it does next happens a turn later.
  const continuation = answered.then((sessions: any) => {
    late = rt.api.capturePane('work:1.0');
    return sessions;
  });
  rt.dispose();
  const socketB = await handshakePlain(connection, 'ws://b:9899', 'tokB', 'm-b');
  const beforeB = socketB.sent.length;

  assert.deepEqual((await continuation).map((s: any) => s.name), ['work'],
    'the call that already succeeded still resolves with ITS server s answer');
  await assert.rejects(() => late!, /detached/u, 'but what the continuation does next is refused');
  // And again after B is fully up, which is where the new tree would mount.
  await assert.rejects(() => rt.api.listSessions(), /detached/u);
  await settle();
  assert.equal(socketB.sent.length, beforeB, 'B s socket carried nothing of A s');
});

test('a suspended handle refuses, and resumes as the SAME handle', async (t) => {
  t.after(cleanup);
  // The connect form's handover: the socket is about to be re-dialled at an
  // address that may be this very server. Revoking for that would replace the
  // handle on every reconnect — a new key, every always-mounted page rebuilt,
  // no leave guard asked — so the handle stands down instead and comes back.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');
  const held = rt.api.listSessions;              // what a page is holding

  const ticket = rt.suspend();
  assert.equal(rt.alive(), true, 'suspended is not released: it is the same handle');
  await assert.rejects(() => held(), /suspended/u, 'and it does not send during the handover');
  await assert.rejects(() => rt.api.capturePane('work:1.0'), /suspended/u);

  rt.settle(ticket, 'resume');
  fire(held());
  await settle();
  assert.ok(MockWebSocket.instances.at(-1)!.texts().some((m: any) => m.method === 'list_sessions'),
    'the very api a page was holding works again — nothing was rebuilt');
});

test('only the CURRENT handover s ticket may resume', async (t) => {
  t.after(cleanup);
  // Handovers overlap: a form unmounted mid-dial, a new instance starting its
  // own, and the first one's completion arriving while the second is still
  // authenticating. A boolean would let that stale completion lift the live
  // attempt's protection — the same class of bug as a superseded dial
  // recording its result (reviewer P1, 2026-10-10).
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');

  const first = rt.suspend();
  const second = rt.suspend();                   // a newer handover takes over
  rt.settle(first, 'resume');                              // the OLD attempt settles
  await assert.rejects(() => rt.api.listSessions(), /suspended/u,
    'the stale conclusion did not lift the live handover s protection');

  rt.settle(second, 'resume');                             // the attempt that owns it
  fire(rt.api.listSessions());
  await settle();
  assert.ok(MockWebSocket.instances.at(-1)!.texts().some((m: any) => m.method === 'list_sessions'),
    'and the right conclusion does');
});

test('an unidentified peer leaves the handle suspended, not released', async (t) => {
  t.after(cleanup);
  // The orchestrator's refinement (2026-10-10): a peer authenticated and the
  // registry write failed, so nothing proves whose socket this is. Refusing
  // is required; RELEASING would be safe and worse — the next attempt that
  // does establish this is still our server would have to rebuild every page,
  // when the handle it needs is right there. So the handle stays suspended
  // and a later handover's own ticket can lift it.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  await handshakePlain(connection, 'ws://a:9899', 'tokA', 'm-a');

  const unresolved = rt.suspend();        // the attempt that could not identify the peer
  void unresolved;                        // its conclusion resumes nothing
  await assert.rejects(() => rt.api.listSessions(), /suspended/u);
  assert.equal(rt.alive(), true, 'still the same handle, so no page is rebuilt');

  // The retry establishes that this IS our server, and resumes what was there.
  const retry = rt.suspend();
  rt.settle(retry, 'resume');
  fire(rt.api.listSessions());
  await settle();
  assert.ok(MockWebSocket.instances.at(-1)!.texts().some((m: any) => m.method === 'list_sessions'),
    'the handle came back without anything being remounted');
});

test('a handle released while suspended stays released', async (t) => {
  t.after(cleanup);
  // The other outcome of the same handover: the address was ANOTHER server,
  // the scope swap released this handle, and the form's resume then arrives.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  const ticket = rt.suspend();
  rt.dispose();
  rt.settle(ticket, 'resume');                             // the form settles afterwards
  assert.equal(rt.alive(), false);
  await assert.rejects(() => rt.api.listSessions(), /detached/u,
    'resume cannot bring back a handle whose server is gone');
});

test('the entry is read fresh, so a rename shows through', () => {
  const e = entry();
  const storage = saved(e);
  const rt = createSingleRuntime(e, { storage });
  storage.setItem(SERVERS_KEY, JSON.stringify([{ ...e, name: 'renamed' }]));
  assert.equal(rt.entry().name, 'renamed');
});
