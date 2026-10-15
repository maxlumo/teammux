// Two REAL connections at once (board #335 ①).
//
// `ws.test.ts` proves the facade still behaves as it always did; this file
// proves the thing the facade now stands on: that two `createConnection()`
// objects share nothing. The interesting cases are all collisions — the same
// request id, the same pane target, the same room name, the same moment —
// because before the split those were not collisions, they were the single
// module's state. Every claim has a negative control: an assertion that would
// hold if the two were still sharing.
//
// Real Web Crypto, a real server half of the handshake per connection
// (`connection.fixture.ts`), no stubbing of our own transport.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeE2eServer, MockWebSocket, handshake, handshakePlain,
  installDoubles, settle, trackTimers, until, withWebCrypto,
} from './connection.fixture.ts';

installDoubles();
const { createConnection } = await import('./connection.ts');
const { createWsApi } = await import('./ws-api.ts');
const { createConnectionRegistry } = await import('./connection-registry.ts');
const { createServerRuntime } = await import('../app/server-runtime.ts');
const { createReconnectMachine } = await import('../app/reconnect.ts');
const { isAuthRefusal } = await import('../app/dial-order.ts');

const A_URL = 'ws://a.test/ws';
const B_URL = 'ws://b.test/ws';

/** Two authenticated connections to two different servers. Teardown is
 * registered on the test context, so a FAILING assertion still releases both
 * idle probes — otherwise a failed run hangs the file instead of reporting
 * (validator, 2026-10-09). */
async function pair(t: TestContext) {
  const serverA = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');
  const serverB = new FakeE2eServer('tok-b', 2, 'machine-b', 'bravo');
  const a = createConnection();
  const b = createConnection();
  // Registered BEFORE the first await: a fixture failure (either handshake's
  // own assertion) must still release both idle probes, or the file hangs
  // instead of reporting (reviewer P2, 2026-10-09).
  t.after(() => { a.dispose(); b.dispose(); });
  const socketA = await handshake(a, serverA, A_URL, 'tok-a');
  const socketB = await handshake(b, serverB, B_URL, 'tok-b');
  return {
    a, b, serverA, serverB, socketA, socketB,
    apiA: createWsApi(a), apiB: createWsApi(b),
  };
}

test('two connections authenticate at the same time and keep their own identity', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  assert.equal(w.a.isConnected(), true);
  assert.equal(w.b.isConnected(), true);
  assert.equal(w.a.getMachineId(), 'machine-a');
  assert.equal(w.b.getMachineId(), 'machine-b');
  assert.equal(w.a.getHostname(), 'alpha');
  assert.equal(w.b.getHostname(), 'bravo');
  assert.equal(w.a.url(), A_URL);
  assert.equal(w.b.url(), B_URL);
}));

test('the same request id on both connections resolves on the connection that sent it', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const fromA = w.apiA.listSessions();
  const reqA = await w.serverA.next(w.socketA);
  // Each connection counts its own ids from 1, so the collision below is the
  // normal case, not a contrived one.
  assert.equal(reqA.id, 1);

  // Negative control: A's reply, delivered on B's socket, while B holds no
  // pending call at all. A shared pending map would have resolved A here.
  let aSettled = false;
  fromA.then(() => { aSettled = true; }, () => { aSettled = true; });
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqA.id, result: [{ name: 'wrong-way' }] })));
  await settle();
  assert.equal(aSettled, false, "A's reply cannot arrive through B");

  const fromB = w.apiB.listSessions();
  const reqB = await w.serverB.next(w.socketB);
  assert.equal(reqB.id, 1, 'B numbers its own requests from 1 too');

  // Replies out of order: B first, then A. Neither sees the other's payload.
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqB.id, result: [{ name: 'on-b' }] })));
  w.socketA.binary(await w.serverA.seal(JSON.stringify({ id: reqA.id, result: [{ name: 'on-a' }] })));
  assert.deepEqual((await fromA).map((s: any) => s.name), ['on-a']);
  assert.deepEqual((await fromB).map((s: any) => s.name), ['on-b']);
}));

test('two handshakes interleaved frame by frame derive their own keys', () => withWebCrypto(async () => {
  // `pair()` finishes A's handshake before starting B's, which proves two
  // authenticated links coexist but not that the handshakes themselves can
  // overlap. Here every step alternates (reviewer P2, 2026-10-09).
  const serverA = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');
  const serverB = new FakeE2eServer('tok-b', 1, 'machine-b', 'bravo'); // and a v1 server
  const a = createConnection();
  const b = createConnection();
  try {
    const dialA = a.connect(A_URL, 'tok-a');
    const socketA = MockWebSocket.instances.at(-1)!;
    const dialB = b.connect(B_URL, 'tok-b');
    const socketB = MockWebSocket.instances.at(-1)!;
    socketA.readyState = MockWebSocket.OPEN;
    socketB.readyState = MockWebSocket.OPEN;

    // Nonces cross: B's first, then A's.
    socketB.message(serverB.nonceFrame());
    socketA.message(serverA.nonceFrame());
    await until(() => socketA.sent.length >= 1 && socketB.sent.length >= 1);
    const authA = JSON.parse(socketA.sent[0] as string);
    const authB = JSON.parse(socketB.sent[0] as string);
    assert.equal(authA.params.e2e, 2, 'each connection negotiates with ITS server');
    assert.equal(authB.params.e2e, 1);
    assert.notEqual(authA.params.client_nonce, authB.params.client_nonce, 'separate nonces');
    assert.equal(await serverA.accept(authA), true, 'A s proof verifies under A s token');
    assert.equal(await serverB.accept(authB), true);
    assert.equal(await serverA.accept(authB), false, 'and not under the other s');

    // Auth answers cross back the other way.
    socketA.binary(await serverA.seal(JSON.stringify({ result: { authenticated: true, machine_id: 'machine-a', hostname: 'alpha', e2e: 2 } })));
    socketB.binary(await serverB.seal(JSON.stringify({ result: { authenticated: true, machine_id: 'machine-b', hostname: 'bravo', e2e: 1 } })));
    assert.equal(await dialA, 'machine-a');
    assert.equal(await dialB, 'machine-b');

    // Each cipher still decrypts only its own traffic.
    const fromA = createWsApi(a).listSessions();
    const fromB = createWsApi(b).listSessions();
    const reqA = await serverA.next(socketA);
    const reqB = await serverB.next(socketB);
    socketA.binary(await serverA.seal(JSON.stringify({ id: reqA.id, result: [{ name: 'a' }] })));
    socketB.binary(await serverB.seal(JSON.stringify({ id: reqB.id, result: [{ name: 'b' }] })));
    assert.deepEqual((await fromA).map((s: any) => s.name), ['a']);
    assert.deepEqual((await fromB).map((s: any) => s.name), ['b']);
  } finally {
    a.dispose();
    b.dispose();
  }
}));

test('a same-named pane and a same-named room reach only their own connection', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const seenA: string[] = [], seenB: string[] = [];
  const closedA: string[] = [], closedB: string[] = [];
  const roomA: any[] = [], roomB: any[] = [];
  const onA = (_t: string, content?: string) => { seenA.push(content!); };
  const onB = (_t: string, content?: string) => { seenB.push(content!); };
  w.a.addPaneOutputListener('app:0.0', onA);
  w.b.addPaneOutputListener('app:0.0', onB);
  w.a.addPaneClosedListener('app:0.0', (t) => closedA.push(t));
  w.b.addPaneClosedListener('app:0.0', (t) => closedB.push(t));
  w.a.addTeamMessageListener((m) => roomA.push(m));
  w.b.addTeamMessageListener((m) => roomB.push(m));

  const push = (room: string, body: string) =>
    JSON.stringify({ method: 'team_message', params: { message: { room, body } } });
  w.socketA.binary(await w.serverA.seal(JSON.stringify({ method: 'pane_output', params: { target: 'app:0.0', content: 'from-a' } })));
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ method: 'pane_output', params: { target: 'app:0.0', content: 'from-b' } })));
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ method: 'pane_closed', params: { target: 'app:0.0' } })));
  w.socketA.binary(await w.serverA.seal(push('proj:app', 'hello from a')));
  w.socketB.binary(await w.serverB.seal(push('proj:app', 'hello from b')));
  await until(() => seenA.length === 1 && seenB.length === 1 && roomA.length === 1 && roomB.length === 1);
  await settle();

  assert.deepEqual(seenA, ['from-a'], 'A saw only its own pane snapshot');
  assert.deepEqual(seenB, ['from-b'], 'B saw only its own');
  assert.deepEqual(closedA, [], 'B closing app:0.0 says nothing about A\'s app:0.0');
  assert.deepEqual(closedB, ['app:0.0']);
  assert.deepEqual(roomA.map(m => m.body), ['hello from a'], 'the same room name on two servers is two rooms');
  assert.deepEqual(roomB.map(m => m.body), ['hello from b']);
}));

test('a pane push for a target only the other connection watches reaches nobody', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const seenA: string[] = [];
  w.a.addPaneOutputListener('only-on-a:0.0', (_t, c) => seenA.push(c!));
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ method: 'pane_output', params: { target: 'only-on-a:0.0', content: 'leak' } })));
  await settle();
  assert.deepEqual(seenA, [], 'B has no route to a listener registered on A');
}));

test('subscription refcounts are per connection, and a reconnect restores only its own targets', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const wire = async (server: FakeE2eServer, socket: MockWebSocket) =>
    (await server.drain(socket)).map(m => `${m.method} ${m.params.target}`);

  // Two subscribers on one connection are one wire subscription.
  w.a.subscribe('app:0.0');
  w.a.subscribe('app:0.0');
  w.b.subscribe('app:0.0');
  await until(() => w.socketA.sent.length >= 2 && w.socketB.sent.length >= 2);
  await settle();
  assert.deepEqual(await wire(w.serverA, w.socketA), ['subscribe app:0.0'], 'the 0→1 transition sends once');
  assert.deepEqual(await wire(w.serverB, w.socketB), ['subscribe app:0.0'], 'B subscribes for itself');

  // Dropping one of two subscribers must not cut the survivor's feed.
  w.a.unsubscribe('app:0.0');
  await settle();
  assert.deepEqual(await wire(w.serverA, w.socketA), [], '2→1 sends nothing');
  w.a.unsubscribe('app:0.0');
  await until(() => w.socketA.sent.length >= 3);
  await settle();
  assert.deepEqual(await wire(w.serverA, w.socketA), ['unsubscribe app:0.0'], '1→0 sends once');
  assert.deepEqual(await wire(w.serverB, w.socketB), [], "A's last unsubscribe is not B's");

  // A reconnect replaces A's socket inside the same object; the server forgot
  // the subscriptions, the mounted cells did not.
  w.a.subscribe('app:0.0');
  w.a.subscribe('app:0.1');
  await settle();
  await wire(w.serverA, w.socketA);
  const serverA2 = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');
  const socketA2 = await handshake(w.a, serverA2, A_URL, 'tok-a');
  w.a.resubscribeActive();
  await until(() => socketA2.sent.length >= 3);
  await settle();
  assert.deepEqual((await wire(serverA2, socketA2)).sort(), ['subscribe app:0.0', 'subscribe app:0.1']);
  assert.deepEqual(await wire(w.serverB, w.socketB), [], "A's reconnect does not resubscribe B");

  // The refcounts did not double: one unsubscribe per target reaches 0.
  w.a.unsubscribe('app:0.0');
  w.a.unsubscribe('app:0.1');
  await until(() => socketA2.sent.length >= 5);
  await settle();
  assert.deepEqual((await wire(serverA2, socketA2)).sort(), ['unsubscribe app:0.0', 'unsubscribe app:0.1']);
}));

test('an RPC timeout on one connection leaves the other pending call alone', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const slowB = w.apiB.listSessions();
  const reqB = await w.serverB.next(w.socketB);
  const timingOut = w.a.call('list_sessions', {}, 20);
  await assert.rejects(timingOut, /request timeout/u);
  assert.equal(w.b.isConnected(), true, "A's timeout is not B's problem");

  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqB.id, result: [{ name: 'still-here' }] })));
  assert.deepEqual((await slowB).map((s: any) => s.name), ['still-here']);
}));

test('a lost socket notifies only its own recovery callback, and the survivor still calls', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  let recoverA = 0, recoverB = 0;
  w.a.setOnDisconnect(() => recoverA++);
  w.b.setOnDisconnect(() => recoverB++);
  const strandedA = w.apiA.listSessions();
  await w.serverA.next(w.socketA);

  w.socketA.readyState = MockWebSocket.CLOSED;
  w.socketA.onclose!({ code: 1006, reason: '', wasClean: false });
  await assert.rejects(strandedA, { code: 'DISCONNECTED' });
  assert.equal(recoverA, 1);
  assert.equal(recoverB, 0, 'B never lost anything');
  assert.equal(w.a.isConnected(), false);
  assert.equal(w.b.isConnected(), true);

  const fromB = w.apiB.listSessions();
  const reqB = await w.serverB.next(w.socketB);
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqB.id, result: [] })));
  assert.deepEqual(await fromB, [], 'B keeps working through A s outage');
  assert.equal(recoverB, 0);
}));

test('a failed authentication on a third connection disturbs neither live one', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  let recoverA = 0, recoverB = 0;
  w.a.setOnDisconnect(() => recoverA++);
  w.b.setOnDisconnect(() => recoverB++);

  const c = createConnection();
  const serverC = new FakeE2eServer('tok-c', 2, 'machine-c', 'charlie');
  const dialing = c.connect('ws://c.test/ws', 'tok-c');
  const socketC = MockWebSocket.instances.at(-1)!;
  socketC.readyState = MockWebSocket.OPEN;
  socketC.message(serverC.nonceFrame());
  await until(() => socketC.sent.length >= 1);
  // A text frame where the encrypted auth response belongs: refused.
  socketC.message({ error: { message: 'bad token' } });
  await assert.rejects(dialing, /auth failed/u);

  assert.equal(w.a.isConnected(), true);
  assert.equal(w.b.isConnected(), true);
  assert.equal(recoverA + recoverB, 0, 'a never-authenticated connection asks nobody to recover');
  c.dispose();
}));

test('dispose releases its own connection and nothing else', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const strandedA = w.apiA.listSessions();
  await w.serverA.next(w.socketA);
  const seenB: string[] = [];
  w.b.addPaneOutputListener('app:0.0', (_t, c) => seenB.push(c!));
  w.b.subscribe('app:0.0');
  await settle();
  await w.serverB.drain(w.socketB);

  w.a.dispose();
  await assert.rejects(strandedA, { code: 'DISCONNECTED' });
  assert.equal(w.a.isConnected(), false);
  assert.equal(w.socketA.closed, 1);
  assert.equal(w.b.isConnected(), true);
  assert.equal(w.socketB.closed, 0);

  w.socketB.binary(await w.serverB.seal(JSON.stringify({ method: 'pane_output', params: { target: 'app:0.0', content: 'alive' } })));
  await until(() => seenB.length === 1);
  assert.deepEqual(seenB, ['alive'], "B's listeners and cipher survived A's dispose");
  const fromB = w.apiB.listSessions();
  const reqB = await w.serverB.next(w.socketB);
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqB.id, result: [] })));
  assert.deepEqual(await fromB, []);
  w.b.dispose();
}));

test('encryption that finishes after a reconnect reaches neither socket', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  // ≥256 bytes goes through CompressionStream, so the encrypt resolves several
  // microtasks after the call — long enough for a reconnect to land first.
  const big = 'x'.repeat(4000);
  const doomed = w.apiA.sendKeys('app:0.0', big);
  const rejected = assert.rejects(doomed, { code: 'DISCONNECTED' });
  const beforeA = w.socketA.sent.length;
  const beforeB = w.socketB.sent.length;

  const serverA2 = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');
  const socketA2 = await handshake(w.a, serverA2, A_URL, 'tok-a');
  await rejected;
  await settle();

  assert.equal(w.socketA.sent.length, beforeA, 'the replaced socket was already closed');
  assert.equal(socketA2.sent.length, 1, "only A's own handshake went out on the new socket");
  assert.equal(w.socketB.sent.length, beforeB, "A's late ciphertext never reaches B");
  w.a.dispose();
  w.b.dispose();
}));

test('a signed download URL is resolved against the origin of the connection that asked', (t) => withWebCrypto(async () => {
  const w = await pair(t);
  const fromA = w.apiA.fsDownloadHttp('/p/same-name.png');
  const fromB = w.apiB.fsDownloadHttp('/p/same-name.png');
  const reqA = await w.serverA.next(w.socketA);
  const reqB = await w.serverB.next(w.socketB);
  assert.equal(reqA.method, 'fs_download_url');
  assert.equal(reqB.method, 'fs_download_url');

  // B answers first and becomes the last connection anyone heard from.
  w.socketB.binary(await w.serverB.seal(JSON.stringify({ id: reqB.id, result: { url: '/dl?sig=b', name: 'same-name.png' } })));
  await fromB;
  w.socketA.binary(await w.serverA.seal(JSON.stringify({ id: reqA.id, result: { url: '/dl?sig=a', name: 'same-name.png' } })));

  const a = await fromA;
  const b = await fromB;
  assert.equal(a.url, 'http://a.test/dl?sig=a');
  assert.equal(b.url, 'http://b.test/dl?sig=b');
  // The control: one shared "current URL" would have given both the same base.
  assert.notEqual(new URL(a.url).host, new URL(b.url).host);
}));

// ─── Lifetime: disconnect keeps the room, dispose empties it ─────────────
// The plain-token path, because what is under test is bookkeeping, not crypto.

test('disconnect keeps listeners and refcounts; dispose is what releases them', async () => {
  const conn = createConnection();
  const api = createWsApi(conn);
  const first = await handshakePlain(conn, A_URL, 'tok', 'machine-a');
  const seen: string[] = [];
  const listener = (_t: string, c?: string) => { seen.push(c!); };
  conn.addPaneOutputListener('app:0.0', listener);
  conn.subscribe('app:0.0');
  await settle(2); // sendOnSocket queues behind the socket's send chain
  assert.equal(first.texts().filter(m => m.method === 'subscribe').length, 1);

  // A deliberate disconnect: pending rejects, the registries stay.
  const stranded = api.listSessions();
  conn.disconnect();
  await assert.rejects(stranded, { code: 'DISCONNECTED' });

  const second = await handshakePlain(conn, A_URL, 'tok', 'machine-a');
  conn.resubscribeActive();
  await settle(2);
  assert.deepEqual(
    second.texts().filter(m => m.method === 'subscribe').map(m => m.params.target),
    ['app:0.0'],
    'the refcount survived, so the wire subscription came back',
  );
  second.onmessage!({ data: JSON.stringify({ method: 'pane_output', params: { target: 'app:0.0', content: 'back' } }) });
  await settle(2);
  assert.deepEqual(seen, ['back'], 'the listener survived too');

  // dispose: terminal. Every door is shut, and it says so distinctly — a
  // RELEASED connection is not an offline one, which phase ② has to tell
  // apart in a log.
  const sockets = MockWebSocket.instances.length;
  conn.dispose();
  await assert.rejects(conn.connect(A_URL, 'tok'), { code: 'DISCONNECTED', message: 'connection disposed' });
  await assert.rejects(api.listSessions(), { code: 'DISCONNECTED', message: 'connection disposed' });
  conn.addPaneOutputListener('app:0.0', listener);
  conn.subscribe('app:0.0');
  conn.resubscribeActive();
  conn.disconnect();
  await settle(2);
  assert.equal(MockWebSocket.instances.length, sockets, 'a disposed handle opens no socket, by any door');
  // The socket it used to hold is deaf: disconnect() nulled its handlers, so
  // the push below reaches no dispatcher at all. (That the listener map is
  // also empty is a leak claim with no runtime probe; connection.source.test.ts
  // pins the guards instead.)
  second.onmessage?.({ data: JSON.stringify({ method: 'pane_output', params: { target: 'app:0.0', content: 'gone' } }) });
  await settle(2);
  assert.deepEqual(seen, ['back']);
  conn.dispose();
});

test('a disposed handle cannot come back; a replacement comes only from the registry', async () => {
  const registry = createConnectionRegistry();
  const a = registry.ensure('a');
  const b = registry.ensure('b');
  const socketA = await handshakePlain(a.connection, A_URL, 'tok', 'machine-a');
  const socketB = await handshakePlain(b.connection, B_URL, 'tok', 'machine-b');

  registry.remove('a');
  const sockets = MockWebSocket.instances.length;
  // The retry closure / unmounted view that still holds the old handle.
  await assert.rejects(a.connection.connect(A_URL, 'tok'), { code: 'DISCONNECTED', message: 'connection disposed' },
    'the removed handle must not dial behind the registry s back');
  await assert.rejects(a.api.listSessions(), { code: 'DISCONNECTED', message: 'connection disposed' });
  a.connection.subscribe('app:0.0');
  a.connection.setOnDisconnect(() => assert.fail('a disposed connection cannot ask for recovery'));
  a.connection.resubscribeActive();
  await settle(2);
  assert.equal(MockWebSocket.instances.length, sockets, 'no socket exists outside the registry');
  assert.equal(a.connection.isConnected(), false);
  assert.equal(socketA.readyState, MockWebSocket.CLOSED);

  // A fresh ensure is a NEW object, and it is the only live one for that key.
  const again = registry.ensure('a');
  assert.notEqual(again.connection, a.connection);
  const socketA2 = await handshakePlain(again.connection, A_URL, 'tok', 'machine-a');
  assert.equal(again.connection.isConnected(), true);
  assert.notEqual(socketA2, socketA);

  assert.equal(b.connection.isConnected(), true, 'B never noticed');
  assert.equal(socketB.readyState, MockWebSocket.OPEN);
  registry.disposeAll();
});

// ─── Releasing a connection that is still dialling ──────────────────────
// Two halves of one handshake can be in flight when the registry drops a
// server: before the nonce arrives, and after it, while auth or the key
// derivation is still running. Each leaves a promise nobody will answer and a
// connect timeout nobody will clear unless dispose() ends them (review P1-a).

test('removing a connection that is waiting for a nonce settles its dial at once', async () => {
  const timers = trackTimers();
  try {
    const registry = createConnectionRegistry();
    const a = registry.ensure('a');
    const b = registry.ensure('b');
    const socketB = await handshakePlain(b.connection, B_URL, 'tok', 'machine-b');

    const dialing = a.connection.connect(A_URL, 'tok');
    const socketA = MockWebSocket.instances.at(-1)!;
    socketA.readyState = MockWebSocket.OPEN;
    assert.equal(timers.timeouts(), 1, 'the dial is holding its connect timeout');

    registry.remove('a');
    // Immediately, not after CONNECT_TIMEOUT_MS.
    await assert.rejects(dialing, { code: 'DISCONNECTED' });
    assert.equal(timers.timeouts(), 0, 'the connect timeout was cleared with it');
    assert.equal(socketA.readyState, MockWebSocket.CLOSED);

    // The server answering late changes nothing: no listener, no timer, no frame.
    const sentBefore = socketA.sent.length;
    socketA.onmessage?.({ data: JSON.stringify({ server_nonce: '00'.repeat(16) }) });
    socketA.onmessage?.({ data: JSON.stringify({ result: { authenticated: true, machine_id: 'machine-a' } }) });
    await settle(3);
    assert.equal(socketA.sent.length, sentBefore, 'a released dial sends nothing');
    assert.equal(a.connection.isConnected(), false);
    assert.equal(timers.live(), 1, 'only B s idle probe remains');

    assert.equal(b.connection.isConnected(), true);
    const fromB = b.api.listSessions();
    await settle(2);
    const reqB = socketB.texts().find(m => m.method === 'list_sessions');
    socketB.message({ id: reqB.id, result: [] });
    assert.deepEqual(await fromB, [], 'B is untouched');
    registry.disposeAll();
    assert.equal(timers.live(), 0);
  } finally {
    timers.restore();
  }
});

test('disposeAll settles a dial that is mid-authentication', (t) => withWebCrypto(async () => {
  const timers = trackTimers();
  try {
    const registry = createConnectionRegistry();
    const a = registry.ensure('a');
    const serverA = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');

    const dialing = a.connection.connect(A_URL, 'tok-a');
    const socketA = MockWebSocket.instances.at(-1)!;
    socketA.readyState = MockWebSocket.OPEN;
    socketA.message(serverA.nonceFrame());
    await until(() => socketA.sent.length >= 1); // the proof is on the wire
    const auth = JSON.parse(socketA.sent[0] as string);
    assert.equal(timers.timeouts(), 1);

    registry.disposeAll();
    await assert.rejects(dialing, { code: 'DISCONNECTED' });
    assert.equal(timers.timeouts(), 0);

    // The auth answer the server was about to send arrives anyway.
    assert.equal(await serverA.accept(auth), true);
    socketA.onmessage?.({ data: await serverA.seal(JSON.stringify({ result: { authenticated: true, machine_id: 'machine-a', hostname: 'alpha', e2e: 2 } })) });
    await settle(5);
    assert.equal(a.connection.isConnected(), false, 'a completed handshake cannot revive a released connection');
    assert.equal(timers.live(), 0, 'and it starts no idle probe');
    assert.equal(registry.get('a'), undefined);
  } finally {
    timers.restore();
  }
}));

test('a dial superseded by the next connect is settled instead of left hanging', async () => {
  const timers = trackTimers();
  try {
    const conn = createConnection();
    const abandoned = conn.connect(A_URL, 'tok');
    MockWebSocket.instances.at(-1)!.readyState = MockWebSocket.OPEN;
    assert.equal(timers.timeouts(), 1);

    const second = await handshakePlain(conn, B_URL, 'tok', 'machine-b');
    await assert.rejects(abandoned, { code: 'DISCONNECTED' });
    assert.equal(timers.timeouts(), 0, 'the abandoned attempt took its timeout with it');
    assert.equal(conn.isConnected(), true, 'the attempt that won is unaffected');
    assert.equal(conn.getMachineId(), 'machine-b');
    assert.equal(second.readyState, MockWebSocket.OPEN);
    conn.dispose();
    assert.equal(timers.live(), 0);
  } finally {
    timers.restore();
  }
});

test('a deliberate disconnect during a dial settles it too', async () => {
  const timers = trackTimers();
  try {
    const conn = createConnection();
    const dialing = conn.connect(A_URL, 'tok');
    MockWebSocket.instances.at(-1)!.readyState = MockWebSocket.OPEN;
    conn.disconnect();
    await assert.rejects(dialing, { code: 'DISCONNECTED' });
    assert.equal(timers.live(), 0, 'nothing is left running after a disconnect mid-dial');
    // disconnect is NOT terminal: the same object dials again.
    const socket = await handshakePlain(conn, A_URL, 'tok', 'machine-a');
    assert.equal(conn.isConnected(), true);
    assert.equal(socket.readyState, MockWebSocket.OPEN);
    conn.dispose();
  } finally {
    timers.restore();
  }
});

test('dispose is idempotent and a disposed connection still refuses RPCs cleanly', async () => {
  const conn = createConnection();
  const api = createWsApi(conn);
  await handshakePlain(conn, A_URL, 'tok', 'machine-a');
  let recover = 0;
  conn.setOnDisconnect(() => recover++);
  conn.dispose();
  conn.dispose();
  conn.dispose();
  await assert.rejects(api.listSessions(), { code: 'DISCONNECTED', message: 'connection disposed' });
  assert.equal(recover, 0, 'a deliberate teardown never asks for recovery');
});

// ── Board #368: the build the server says it runs ────────────────────────

const BUILD = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };

test('the build a server names at login is read from the sealed answer, per connection', (t) => withWebCrypto(async () => {
  const sealed = new FakeE2eServer('tok-a', 2, 'machine-a', 'alpha');
  sealed.build = BUILD;
  const older = new FakeE2eServer('tok-b', 2, 'machine-b', 'bravo'); // no `build` member at all
  const a = createConnection();
  const b = createConnection();
  t.after(() => { a.dispose(); b.dispose(); });
  assert.equal(a.getBuild(), undefined, 'no socket yet: nothing to say');
  await handshake(a, sealed, A_URL, 'tok-a');
  await handshake(b, older, B_URL, 'tok-b');
  assert.deepEqual(a.getBuild(), BUILD);
  assert.equal(b.getBuild(), null, 'an older server names none: null, not undefined, and not another connection\'s');
}));

test('the plain login path reads the build too, and a malformed one is null', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  await handshakePlain(conn, A_URL, 'tok', 'machine-a', BUILD);
  assert.deepEqual(conn.getBuild(), BUILD);
  conn.disconnect();
  assert.equal(conn.getBuild(), undefined, 'a closed socket says nothing about a build');
  for (const bad of ['v1.0.0', { version: '1.0.0', commit: 'abc' }, { version: 1, commit: 'abc', built: 'x' }, { version: '1.0.0', commit: '', built: 'x' }]) {
    await handshakePlain(conn, A_URL, 'tok', 'machine-a', bad);
    assert.equal(conn.getBuild(), null, `not three plain strings: ${JSON.stringify(bad)}`);
    conn.disconnect();
  }
});

test('between the socket opening and the login answer a server has named nothing: undefined, not "none"', async (t) => {
  // `null` means "the server answered and named no build" (an older one); a
  // socket that has not been answered yet must not say that, or About would
  // call a server "unknown" in the second before it speaks.
  const conn = createConnection();
  t.after(() => conn.dispose());
  const dial = conn.connect(A_URL, 'tok');
  dial.catch(() => {});
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  assert.equal(conn.getBuild(), undefined, 'socket open, login not answered');
  socket.message({ result: { authenticated: true, machine_id: 'machine-a', hostname: 'alpha', build: BUILD } });
  await dial;
  assert.deepEqual(conn.getBuild(), BUILD);
});

test('the capabilities a server announces at login are read per connection; none is [] (a definite no), not unknown (board #377)', async (t) => {
  const login = async (result: object) => {
    const conn = createConnection();
    t.after(() => conn.dispose());
    const dial = conn.connect(A_URL, 'tok');
    dial.catch(() => {});
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    const before = conn.getCaps();
    socket.message({ result: { authenticated: true, machine_id: 'machine-a', hostname: 'alpha', ...result } });
    await dial;
    return { conn, before };
  };
  const modern = await login({ caps: ['board_dispatch'] });
  assert.equal(modern.before, undefined, 'socket open, login not answered: unknown, which is not a refusal');
  assert.deepEqual(modern.conn.getCaps(), ['board_dispatch']);
  const older = await login({});
  assert.deepEqual(older.conn.getCaps(), [], 'an older server announced none: a definite no');
  assert.deepEqual((await login({ caps: 'board_dispatch' })).conn.getCaps(), [], 'not a list: none');
  assert.deepEqual(modern.conn.getCaps(), ['board_dispatch'], 'and never another connection\u2019s');
  modern.conn.disconnect();
  assert.equal(modern.conn.getCaps(), undefined, 'a closed socket says nothing about a server');
});

// ── Board #377 review, P1-B residual: a save that asks the server to hand the
// issue over is gated ONCE, on the write path, against the CURRENT socket.
const methodsSent = (socket: InstanceType<typeof MockWebSocket>) =>
  socket.sent.map((frame) => { try { return JSON.parse(String(frame)).method as string | undefined; } catch { return undefined; } });
const login = (socket: InstanceType<typeof MockWebSocket>, caps?: string[]) =>
  socket.message({ result: { authenticated: true, machine_id: 'machine-a', hostname: 'alpha', ...(caps ? { caps } : {}) } });
const ask = { title: 'T', assignee: 'alice', dispatch: true };
/** A REAL server runtime over a real connection: the api a page gets, with the gate that asks the handle's write right (board #377). */
const runtimeOver = (conn: ReturnType<typeof createConnection>) =>
  createServerRuntime(
    { id: 'srv', name: 'srv', address: 'ws://a.test/ws', token: 't' } as never,
    { storage: { getItem: () => null, setItem() {}, removeItem() {} } as never, slot: { connection: conn, api: createWsApi(conn) } as never },
  );

test('a flagged board save waits for the login answer and sends nothing before it (board #377)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const api = runtimeOver(conn).api;
  const dial = conn.connect(A_URL, 'tok');
  dial.catch(() => {});
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  assert.equal(conn.getCaps(), undefined, 'the login has not answered');

  const save = api.boardSave('s', ask);
  save.catch(() => {});
  await settle();
  assert.ok(!methodsSent(socket).includes('hub_board_save'), `held: nothing is written before the login answers (${methodsSent(socket)})`);

  login(socket, ['board_dispatch']);
  await dial;
  await settle();
  assert.equal(methodsSent(socket).filter((m) => m === 'hub_board_save').length, 1, 'and exactly one save goes once it has');
  const frame = JSON.parse(String(socket.sent.find((f) => JSON.parse(String(f)).method === 'hub_board_save')));
  assert.equal(frame.params.dispatch, true);
  socket.message({ id: frame.id, result: { ok: true, id: 3, dispatch: 'sent' } });
  assert.deepEqual(await save, { ok: true, id: 3, dispatch: 'sent' });
});

test('after a reconnect to a server without board_dispatch a flagged save is refused unsent, and a plain edit still goes (board #377)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const api = runtimeOver(conn).api;
  const seen: (string[] | undefined)[] = [];
  conn.onCaps((caps) => seen.push(caps));

  const first = conn.connect(A_URL, 'tok');
  MockWebSocket.instances.at(-1)!.readyState = MockWebSocket.OPEN;
  MockWebSocket.instances.at(-1)!.message({ server_nonce: '00'.repeat(16) });
  login(MockWebSocket.instances.at(-1)!, ['board_dispatch']);
  await first;
  assert.deepEqual(conn.getCaps(), ['board_dispatch']);

  // The same Connection is redialled to an OLDER server: no caps in its login.
  const second = conn.connect(A_URL, 'tok');
  second.catch(() => {});
  const old = MockWebSocket.instances.at(-1)!;
  old.readyState = MockWebSocket.OPEN;
  old.message({ server_nonce: '11'.repeat(16) });
  assert.equal(conn.getCaps(), undefined, 'the new socket has not answered: the old answer is not its');
  login(old);
  await second;
  assert.deepEqual(conn.getCaps(), [], 'answered, and without it');
  assert.deepEqual(seen, [['board_dispatch'], undefined, []], 'modern, then NOTHING while the new socket is unanswered, then old: observers see every step');

  await assert.rejects(api.boardSave('s', ask), (e: any) => e.code === 'server_too_old' && /Update the server/.test(e.message));
  assert.ok(!methodsSent(old).includes('hub_board_save'), 'refused BEFORE anything was sent');

  // A save that asks for no hand-off is not gated: an old server can store it.
  const plain = api.boardSave('s', { id: 1, title: 'Just a rename' });
  plain.catch(() => {});
  await settle();
  assert.equal(methodsSent(old).filter((m) => m === 'hub_board_save').length, 1, 'ordinary edits keep working against any server');
});

// Board #382 reviewer P1-A: an older server ignores `join` and spawns the
// agent standalone, so a join goes through the same gate as a flagged board
// save; a standalone spawn is never gated.
test('a join waits for the login, is refused unsent by a server without spawn_join, and a standalone spawn always goes (board #382)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const api = runtimeOver(conn).api;
  const spawns = (socket: InstanceType<typeof MockWebSocket>) => socket.sent.map((f) => JSON.parse(String(f))).filter((f) => f.method === 'hub_spawn');

  const first = conn.connect(A_URL, 'tok');
  first.catch(() => {});
  const modern = MockWebSocket.instances.at(-1)!;
  modern.readyState = MockWebSocket.OPEN;
  modern.message({ server_nonce: '00'.repeat(16) });
  const held = api.hubSpawn('s', 'helper', '', '', 'squad');
  held.catch(() => {});
  await settle();
  assert.equal(spawns(modern).length, 0, 'held while the login is unanswered');
  login(modern, ['board_dispatch', 'spawn_join']);
  await first;
  await settle();
  assert.deepEqual(spawns(modern).map((f) => f.params.join), ['squad'], 'one join, once the login said it can');

  const second = conn.connect(A_URL, 'tok');
  second.catch(() => {});
  const old = MockWebSocket.instances.at(-1)!;
  old.readyState = MockWebSocket.OPEN;
  old.message({ server_nonce: '11'.repeat(16) });
  login(old, ['board_dispatch']);
  await second;
  await assert.rejects(api.hubSpawn('s', 'helper', '', '', 'squad'),
    (e: any) => e.code === 'server_too_old' && /start an agent inside a team/.test(e.message));
  assert.equal(spawns(old).length, 0, 'refused BEFORE anything was sent: nothing can start standalone');
  const plain = api.hubSpawn('s', 'helper');
  plain.catch(() => {});
  await settle();
  assert.equal(spawns(old).length, 1, 'a standalone spawn is not gated');
  assert.equal('join' in spawns(old)[0].params, false);
});

test('a team move waits for the login and is refused unsent by a server without agent_team (board #384)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const api = runtimeOver(conn).api;
  const moves = (socket: InstanceType<typeof MockWebSocket>) => socket.sent.map((f) => JSON.parse(String(f))).filter((f) => f.method === 'hub_agent_set_team');

  const first = conn.connect(A_URL, 'tok');
  first.catch(() => {});
  const modern = MockWebSocket.instances.at(-1)!;
  modern.readyState = MockWebSocket.OPEN;
  modern.message({ server_nonce: '00'.repeat(16) });
  const held = api.hubAgentSetTeam('s', 'helper', 'squad');
  held.catch(() => {});
  await settle();
  assert.equal(moves(modern).length, 0, 'held while the login is unanswered');
  login(modern, ['board_dispatch', 'spawn_join', 'agent_team']);
  await first;
  await settle();
  assert.deepEqual(moves(modern).map((f) => f.params), [{ session: 's', agent: 'helper', team: 'squad' }], 'one move, once the login said it can');

  const second = conn.connect(A_URL, 'tok');
  second.catch(() => {});
  const old = MockWebSocket.instances.at(-1)!;
  old.readyState = MockWebSocket.OPEN;
  old.message({ server_nonce: '11'.repeat(16) });
  login(old, ['board_dispatch', 'spawn_join']);
  await second;
  await assert.rejects(api.hubAgentSetTeam('s', 'helper', ''),
    (e: any) => e.code === 'server_too_old' && /move an agent between teams/.test(e.message));
  assert.equal(moves(old).length, 0, 'refused BEFORE anything was sent');
});

test('disposing a connection ends a parked whenCaps now, not at its timer (board #377)', async (t) => {
  const conn = createConnection();
  const dial = conn.connect(A_URL, 'tok');
  dial.catch(() => {});
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  const parked = conn.whenCaps(60_000); // far longer than this test would wait
  let settled: string | null = null;
  parked.then(() => { settled = 'resolved'; }, (e: Error) => { settled = e.message; });
  await settle();
  assert.equal(settled, null, 'parked while the login has not answered');
  conn.dispose();
  await settle();
  assert.equal(settled, 'connection disposed', 'released by the dispose, with its own reason');
  t.after(() => {});
});

test('a flagged save issued after a redial reads the NEW socket, not the answer the old one gave (board #377)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const api = runtimeOver(conn).api;
  const first = conn.connect(A_URL, 'tok');
  MockWebSocket.instances.at(-1)!.readyState = MockWebSocket.OPEN;
  MockWebSocket.instances.at(-1)!.message({ server_nonce: '00'.repeat(16) });
  login(MockWebSocket.instances.at(-1)!, ['board_dispatch']);
  await first;
  assert.deepEqual(conn.getCaps(), ['board_dispatch']);

  // Redialled, not yet answered: the modern answer is gone with its socket.
  const second = conn.connect(A_URL, 'tok');
  second.catch(() => {});
  const next = MockWebSocket.instances.at(-1)!;
  next.readyState = MockWebSocket.OPEN;
  next.message({ server_nonce: '11'.repeat(16) });
  const save = api.boardSave('s', ask);
  const outcome = save.then(() => 'sent', (e: any) => e.code);
  await settle();
  assert.ok(!methodsSent(next).includes('hub_board_save'), 'held for the new socket\u2019s own answer');
  login(next); // and that socket is an OLDER server
  await second;
  assert.equal(await outcome, 'server_too_old');
  assert.ok(!methodsSent(next).includes('hub_board_save'), 'refused unsent');
});

test('a flagged save that waited for the login is sent only if its runtime may still write when the wait ends; no retry (board #377)', async (t) => {
  const cases: [string, (r: ReturnType<typeof runtimeOver>) => void, RegExp | null][] = [
    ['detached while it waited', (r) => r.detach(), /detached/],
    ['frozen while it waited', (r) => r.setFrozen(true), /frozen/],
    ['still live', () => {}, null],
  ];
  for (const [label, lose, refusal] of cases) {
    const conn = createConnection();
    t.after(() => conn.dispose());
    const runtime = runtimeOver(conn);
    const dial = conn.connect(A_URL, 'tok');
    dial.catch(() => {});
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message({ server_nonce: '00'.repeat(16) });
    const outcome = runtime.api.boardSave('s', ask).then(() => 'sent', (e: Error) => e.message);
    await settle();
    assert.equal(methodsSent(socket).filter((m) => m === 'hub_board_save').length, 0, `${label}: held while the login is unanswered`);
    lose(runtime);
    login(socket, ['board_dispatch']); // the connection itself is fine: it logs in WITH the capability
    await dial; await settle();
    const frames = methodsSent(socket).filter((m) => m === 'hub_board_save').length;
    if (refusal) {
      assert.equal(frames, 0, `${label}: the login completing sends nothing for a runtime that lost its right`);
      assert.match(await outcome, refusal, `${label}: the caller gets the refusal (and keeps its draft)`);
      await settle();
      assert.equal(methodsSent(socket).filter((m) => m === 'hub_board_save').length, 0, `${label}: and nothing is retried afterwards`);
    } else {
      assert.equal(frames, 1, `${label}: exactly one frame`);
    }
  }
});

// ── Board #393 (reviewer P1-B): the server's refusal is kept through the encrypted gate ──
//
// connection.rs answers a wrong proof with a PLAIN `{id, error:{code:-32000, message:"invalid
// proof"}}` — it has no session key for a proof it just rejected. The client used to read any
// text frame on the encrypted path as "expected binary auth response", which the reconnect loop
// could not tell from a protocol accident, so a wrong token was dialled for the whole 180 s
// window (and each dial counts against the server's per-address lockout).

/** Dial with the wrong token, play the server's half exactly as connection.rs does, and hand
 * back the socket to answer on. */
async function wrongTokenDial(conn: ReturnType<typeof createConnection>, url: string) {
  const server = new FakeE2eServer('the-right-token', 2, 'machine-r', 'right');
  const dialing = conn.connect(url, 'a-wrong-token');
  dialing.catch(() => {}); // asserted below; never an unhandled rejection in between
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message(server.nonceFrame());
  await until(() => socket.sent.length >= 1);
  const auth = JSON.parse(socket.sent[0] as string);
  assert.equal(await server.accept(auth), false, 'the server verifies the proof the way connection.rs does: it is wrong');
  return { dialing, socket };
}

test('the server’s plain invalid-proof frame on the ENCRYPTED path is kept as a refusal (#393 P1-B)', (t) => withWebCrypto(async () => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const { dialing, socket } = await wrongTokenDial(conn, 'ws://refuse.test/ws');
  socket.message({ id: 0, error: { code: -32000, message: 'invalid proof' } });
  const error = await dialing.then(() => null, (e: unknown) => e) as Error & { code?: number };
  assert.ok(error, 'the dial failed');
  assert.equal(error.message, 'invalid proof', 'with the server’s own sentence, not "expected binary auth response"');
  assert.equal(error.code, -32000);
  assert.equal(isAuthRefusal(error), true, 'and the reconnect loop’s one check calls it a refusal');
  assert.equal(conn.getMachineId() ?? null, null, 'nothing was authenticated');
}));

test('a plain frame on the encrypted path is NEVER a login: no downgrade, and a surprise is not a refusal (#393 P1-B)', (t) => withWebCrypto(async () => {
  // A plain SUCCESS where the encrypted answer belongs (a middlebox, a downgrade attempt):
  // refused as the protocol error it is, never authenticated, never a "bad token".
  const a = createConnection();
  t.after(() => a.dispose());
  const sentA = await wrongTokenDial(a, 'ws://downgrade.test/ws');
  sentA.socket.message({ id: 0, result: { authenticated: true, machine_id: 'evil', hostname: 'evil' } });
  const downgrade = await sentA.dialing.then(() => null, (e: unknown) => e) as Error;
  assert.match(downgrade.message, /auth failed: expected binary auth response/u);
  assert.equal(isAuthRefusal(downgrade), false);
  assert.equal(a.getMachineId() ?? null, null, 'it took nothing from the plain success: not authenticated, no identity');
  assert.equal(a.getCaps(), undefined, 'and no capabilities: the login is unanswered');
  // An error frame with another code, or none: a protocol error, not a bad token.
  for (const frame of [{ id: 0, error: { code: -32603, message: 'internal' } }, { error: { message: 'bad token' } }, { id: 0 }]) {
    const c = createConnection();
    t.after(() => c.dispose());
    const sent = await wrongTokenDial(c, 'ws://surprise.test/ws');
    sent.socket.message(frame);
    const error = await sent.dialing.then(() => null, (e: unknown) => e) as Error;
    assert.match(error.message, /auth failed: expected binary auth response/u, JSON.stringify(frame));
    assert.equal(isAuthRefusal(error), false, JSON.stringify(frame));
  }
}));

test('only the server’s explicit PLAIN ERR_AUTH is a refusal: a failed decrypt, a JSON error, a binary frame that is no auth answer and a text frame that is no JSON all fail THIS dial and leave the loop retrying (#393 P1-B)', (t) => withWebCrypto(async () => {
  // The right token, so the keys exist and the server can seal real frames; then the answer to
  // the login is each of the things that is NOT the server saying no.
  const cases: Array<[string, (server: InstanceType<typeof FakeE2eServer>) => Promise<unknown>]> = [
    ['a binary frame that does not decrypt', async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).buffer],
    ['a sealed frame that is not JSON', (server) => server.seal('this is not json')],
    ['a sealed frame that is JSON but no authentication', (server) => server.seal(JSON.stringify({ id: 0, result: { authenticated: false } }))],
    ['a sealed ERR_AUTH error (the refusal is plain; an encrypted one is not what the server sends)', (server) => server.seal(JSON.stringify({ id: 0, error: { code: -32000, message: 'invalid proof' } }))],
  ];
  for (const [what, frame] of cases) {
    const conn = createConnection();
    t.after(() => conn.dispose());
    const server = new FakeE2eServer('the-right-token', 2, 'machine-r', 'right');
    const dialing = conn.connect('ws://negative.test/ws', 'the-right-token');
    dialing.catch(() => {});
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message(server.nonceFrame());
    await until(() => socket.sent.length >= 1);
    assert.equal(await server.accept(JSON.parse(socket.sent[0] as string)), true, 'the proof is right');
    socket.binary((await frame(server)) as ArrayBuffer);
    const error = await dialing.then(() => null, (e: unknown) => e) as Error;
    assert.ok(error, `${what}: the dial failed`);
    assert.match(error.message, /^auth failed/u, what);
    assert.equal(isAuthRefusal(error), false, `${what}: NOT a refusal — the loop retries`);
    assert.equal(conn.getMachineId() ?? null, null, `${what}: nothing was authenticated`);
  }
  // A text frame that is no JSON at all.
  const conn = createConnection();
  t.after(() => conn.dispose());
  const server = new FakeE2eServer('the-right-token', 2, 'machine-r', 'right');
  const dialing = conn.connect('ws://negative.test/ws', 'the-right-token');
  dialing.catch(() => {});
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message(server.nonceFrame());
  await until(() => socket.sent.length >= 1);
  socket.onmessage?.({ data: 'not json {' });
  const error = await dialing.then(() => null, (e: unknown) => e) as Error;
  assert.match(error.message, /auth failed: expected binary auth response/u);
  assert.equal(isAuthRefusal(error), false);
}));

test('the PLAIN-token path keeps the server’s invalid-token refusal too (#393 P1-B)', async (t) => {
  const conn = createConnection();
  t.after(() => conn.dispose());
  const dialing = conn.connect('ws://plain-refuse.test/ws', 'wrong');
  dialing.catch(() => {});
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  await until(() => socket.sent.length >= 1);
  socket.message({ id: 0, error: { code: -32000, message: 'invalid token' } });
  const error = await dialing.then(() => null, (e: unknown) => e) as Error & { code?: number };
  assert.equal(error.message, 'invalid token');
  assert.equal(isAuthRefusal(error), true);
});

test('the default reconnect budget dials ONCE on a real refusal, marks nothing unreachable, and still retries a socket closed during auth (#393 P1-B)', (t) => withWebCrypto(async () => {
  const dial = (script: (conn: ReturnType<typeof createConnection>) => Promise<void>) => {
    const log = { dials: 0, unreachable: [] as string[], gaveUp: 0, succeeded: 0 };
    const machine = createReconnectMachine({
      // App passes the machine no budget of its own: the defaults decide (reconnect.ts).
      connect: async (url, token) => {
        log.dials++;
        const conn = createConnection();
        t.after(() => conn.dispose());
        const dialing = conn.connect(url, token);
        dialing.catch(() => {});
        await script(conn);
        return dialing;
      },
      findBestAddress: async (addresses) => addresses[0] ?? null,
      isAddressViable: () => true,
      noteAddressUnreachable: (address) => log.unreachable.push(address),
      classifyAddress: () => 2,
      addressLabels: ['LAN', 'Tailscale', 'WAN'],
      target: () => ({ address: 'ws://loop.test/ws', token: 'a-wrong-token', machineId: '', alternates: [] }),
      onStateChange: () => {},
      onSuccess: () => { log.succeeded++; },
      onGiveUp: () => { log.gaveUp++; },
    });
    return { log, machine };
  };

  // A real refusal: the server sends its plain invalid-proof frame. One dial, then the card.
  const refused = dial(async () => {
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    const server = new FakeE2eServer('the-right-token', 2, 'machine-r', 'right');
    socket.message(server.nonceFrame());
    await until(() => socket.sent.length >= 1);
    socket.message({ id: 0, error: { code: -32000, message: 'invalid proof' } });
  });
  refused.machine.start();
  await until(() => refused.log.gaveUp === 1);
  await settle(60);
  assert.deepEqual({ dials: refused.log.dials, gaveUp: refused.log.gaveUp, unreachable: refused.log.unreachable, active: refused.machine.isActive() },
    { dials: 1, gaveUp: 1, unreachable: [], active: false }, 'one dial, no cooldown, the loop is over');

  // A socket that closes during auth is a reachability failure: it is retried (the first gap is 0.5 s).
  const dropped = dial(async () => {
    const socket = MockWebSocket.instances.at(-1)!;
    socket.readyState = MockWebSocket.OPEN;
    socket.message(new FakeE2eServer('x', 2, 'm', 'h').nonceFrame());
    await until(() => socket.sent.length >= 1);
    socket.onclose?.({ code: 1006, reason: '', wasClean: false });
  });
  dropped.machine.start();
  await until(() => dropped.log.dials >= 2, 1500);
  dropped.machine.cancel();
  assert.ok(dropped.log.dials >= 2 && dropped.log.gaveUp === 0, `retried (${dropped.log.dials} dials)`);
  assert.ok(dropped.log.unreachable.length >= 1, 'and the address is remembered as unreachable');
}));
