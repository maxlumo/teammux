// The one runtime production holds while `ws.ts` still owns the socket
// (board #335 ②b-1). Two facts carry the whole commit, and both are about the
// IDENTITY of objects rather than about behaviour, so they are asserted that
// way: a different connection would be a second socket, and a terminal
// dispose would be a dead app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVERS_KEY, type ServerEntry } from './servers.ts';

// The facade installs the device-reachability listeners at module scope, so a
// node test gives it the one global it needs and then loads it — the same way
// `core/ws.test.ts` does. Both imports name the same specifier, so both get
// the same module instance, which is what makes the identity checks below
// mean anything.
(globalThis as any).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {},
};
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
  id: 's1', name: 'work', address: 'ws://host:9999', token: 't', named: true, ...over,
} as ServerEntry);

const saved = (...servers: ServerEntry[]) => mem({ [SERVERS_KEY]: JSON.stringify(servers) });

test('it is the facade s own slot, not a second client', () => {
  // The point of the whole arrangement: a provided subtree and a module that
  // still imports its RPCs from ws.ts are talking over the SAME socket, which
  // is what makes each ②b commit behaviour-identical in Single mode. A fleet
  // runtime would have built its own connection, and every page that had not
  // moved yet would be on the other one.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  assert.equal(rt.api, compatSlotApi, 'the api IS the facade s');
  assert.equal(rt.id, 's1');
  // The connection is a VIEW of the facade's: every member is the facade's own
  // closure, so asking either object asks one socket.
  assert.equal(rt.connection.isConnected, connection.isConnected);
  assert.equal(rt.connection.connect, connection.connect);
  assert.equal(rt.connection.subscribe, connection.subscribe);
});

test('releasing it closes the socket and does not end the app s transport', async () => {
  // `Connection.dispose()` is terminal by design (#335 ①), and this object is
  // the transport of every module that has not moved yet. A disposed facade
  // answers "connection disposed" for the rest of the session — a blank app
  // that only a reload fixes — and the two terminal paths inside `dial` reach
  // dispose from a call that is supposed to report a result and recover.
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  assert.equal(rt.connection.dispose, connection.disconnect, 'dispose means disconnect here');

  rt.dispose();

  // The facade still answers the way an unconnected transport answers, which
  // is what every page sees today before the first connect.
  await assert.rejects(() => compatSlotApi.listSessions(), /not connected/u);
  assert.equal(connection.isConnected(), false);

  // And the HANDLE is still terminal: a released runtime cannot dial again,
  // which is the part of the contract that matters to whoever holds it.
  assert.deepEqual(await rt.dial(), { ok: false, reason: 'gone' });
});

test('the entry is read fresh, so a rename shows through', () => {
  const e = entry();
  const storage = saved(e);
  const rt = createSingleRuntime(e, { storage });
  storage.setItem(SERVERS_KEY, JSON.stringify([{ ...e, name: 'renamed' }]));
  assert.equal(rt.entry().name, 'renamed');
});
