// The one runtime production holds while `ws.ts` still owns the socket
// (board #335 ②b-1), and the lifetime rule that makes borrowing safe
// (reviewer P1-a, 2026-10-10).
//
// The whole point of borrowing is that a provided subtree and a module that
// still imports its RPCs from ws.ts talk over the SAME socket, which is what
// makes each ②b commit behaviour-identical in Single mode. The danger is the
// other side of it: `server-runtime.ts` ends a runtime from three places of
// its own, and the ORDINARY one — an old address-only entry absorbed into the
// canonical entry of the machine that answered — would close the legacy
// transport for the rest of the session. So every case below asks the same
// question: after the handle is finished with, can the app still talk?
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_KEY, SERVERS_KEY, loadServers, type ServerEntry } from './servers.ts';

// The facade installs the device-reachability listeners at module scope, so a
// node test gives it the one global it needs and then loads it — the same way
// `core/ws.test.ts` does. Both imports name the same specifier, so both get
// the same module instance, which is what makes the identity checks mean
// anything.
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

/** An entry whose name is still the DEFAULT: `named` is a presence flag, so an
 * unnamed entry omits it rather than setting it false. */
const unnamed = (over: Partial<ServerEntry>): ServerEntry =>
  ({ id: 'history', name: 'ws://old:9999', address: 'ws://old:9999', token: 't', ...over } as ServerEntry);

const saved = (...servers: ServerEntry[]) => mem({ [SERVERS_KEY]: JSON.stringify(servers) });

/** The facade is shared by the whole process here, as it is by the whole app:
 * every case must leave it usable, and this is the question each one asks. */
const facadeUsable = async () => {
  await assert.rejects(() => compatSlotApi.listSessions(), /not connected/u,
    'the facade still answers the way an unconnected transport answers');
  assert.equal(connection.isConnected(), false);
};

test('it is the facade s own slot, not a second client', async () => {
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });
  assert.equal(rt.id, 's1');
  // The connection is the facade's object itself — one socket, so a page
  // bound to this runtime and an un-migrated module cannot disagree about
  // which server they are on.
  assert.equal(rt.connection, connection);
  // The api is a liveness GATE over the facade's api (see the detach cases),
  // so it is not the same object — but every call goes to the facade's.
  await assert.rejects(() => rt.api.listSessions(), /not connected/u);
  await facadeUsable();
});

test('releasing the handle detaches it and leaves the app s transport alive', async () => {
  const e = entry();
  const rt = createSingleRuntime(e, { storage: saved(e) });

  rt.dispose();

  // The HANDLE is terminal: it cannot dial again, which is the part of the
  // contract its holders depend on.
  assert.deepEqual(await rt.dial(), { ok: false, reason: 'gone' });
  // And the api it handed out refuses rather than sending over a slot that
  // may now serve another server.
  await assert.rejects(() => rt.api.listSessions(), /detached/u);
  await facadeUsable();
});

test('an entry absorbed DURING auth detaches instead of closing the legacy transport', async () => {
  // The reviewer's case, and it is the ordinary one: an old address-only
  // history entry authenticates, `recordServer` folds it into the canonical
  // entry of the machine that answered, and this id ceases to exist. An owned
  // runtime is right to end itself there; a borrowed one must not take the
  // app's connection with it.
  const known = entry({ id: 'canon', machineId: 'm-1', address: 'ws://host:9999' });
  const old = unnamed({ address: 'ws://old:9999' });
  const storage = saved(known, old);
  const rt = createSingleRuntime(old, { storage });

  // No socket in a node test, so the dial fails before auth — which is not
  // the path under test. Drive the absorption directly: this is what
  // `recordServer` leaves behind, and then the handle is finished with.
  storage.setItem(SERVERS_KEY, JSON.stringify([known]));
  storage.setItem(CURRENT_KEY, 'canon');
  rt.dispose();

  assert.deepEqual(loadServers(storage).map((s) => s.id), ['canon'], 'identity kept the survivor');
  await assert.rejects(() => rt.api.listSessions(), /detached/u, 'the absorbed handle is inert');
  await facadeUsable();   // the legacy ws callers are unaffected
});

test('a handle the app has replaced cannot record identity any more', async () => {
  // Two generations over ONE connection: App swapped A for B, and A's dial —
  // begun before the swap — comes back afterwards. A detached handle reports
  // `gone` and writes nothing, so the stale continuation cannot resurrect its
  // entry or re-stamp a machine (②a's attempt identity is per handle, so
  // without the detach A would still consider its own latest attempt valid).
  const e = entry();
  const storage = saved(e);
  const a = createSingleRuntime(e, { storage });
  const b = createSingleRuntime(e, { storage });

  a.dispose();                       // the swap detaches the handle it replaced

  const before = storage.getItem(SERVERS_KEY);
  assert.deepEqual(await a.dial(), { ok: false, reason: 'gone' });
  assert.equal(storage.getItem(SERVERS_KEY), before, 'the stale handle wrote nothing');
  // B is untouched by A's end: same connection, its own liveness.
  await assert.rejects(() => b.api.listSessions(), /not connected/u, 'B still speaks');
  await facadeUsable();
});

test('the entry is read fresh, so a rename shows through', () => {
  const e = entry();
  const storage = saved(e);
  const rt = createSingleRuntime(e, { storage });
  storage.setItem(SERVERS_KEY, JSON.stringify([{ ...e, name: 'renamed' }]));
  assert.equal(rt.entry().name, 'renamed');
});
