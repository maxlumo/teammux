// The connect form hands the shared socket over in the right ORDER, and gives
// it back whatever the outcome (board #335 ②b-1, reviewer P1-b ii and the
// 2026-10-10 follow-up).
//
// This form can reach a DIFFERENT server than the one the app is on, and
// through ②b every page is talking over one connection object. So the host
// must get to stand its current handle down BEFORE the socket is re-dialled:
// after it points elsewhere, a call still in flight from the old tree — or a
// callback that settles before the new tree mounts — would be the old
// server's work sent to the new one.
//
// And it must get the handle BACK when the attempt settles, because nobody
// knows until the server authenticates whether this address is the same
// server. Revoking outright would remount every always-mounted page on an
// ordinary reconnect and throw away the state they exist to keep.
//
// A source pin would only say the calls are written somewhere in the
// function. A mount says they happened, and in which order.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
]);

async function mount(
  context: TestContext,
  connect: () => Promise<unknown>,
  seed: (storage: Storage) => void = () => {},
) {
  const order: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() {
        order.push('stand-down');
        return (outcome: string) => order.push(`conclude:${outcome}`);
      },
    },
    modules: [{
      connect: async (...args: unknown[]) => { order.push('connect'); return connect.apply(null, args as []); },
      disconnect: () => {},
      getMachineId: () => 'm-a',
      setSocket: async () => {},
    }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      seed(window.localStorage);
    },
  });
  return { ...app, order };
}

/** Type an address and submit the form the way a person does. */
async function connectTo(app: Awaited<ReturnType<typeof mount>>, address: string) {
  const input = app.document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
  input.value = address;
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
  const form = app.document.querySelector<HTMLFormElement>('form');
  if (form) form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  else app.document.querySelector<HTMLButtonElement>('button[type="submit"], .connect-btn')!.click();
  for (let i = 0; i < 8; i++) await app.flush();
}

test('the current server s handle stands down BEFORE the socket is re-dialled', async (context) => {
  const app = await mount(context, async () => 'm-a');
  await connectTo(app, 'wss://other.test/ws');
  assert.ok(app.order.includes('connect'), `the form dialled: ${app.order.join(' → ')}`);
  assert.deepEqual(app.order.slice(0, 2), ['stand-down', 'connect'],
    'first the handle stands down; after the re-dial the old tree would be talking to the new server');
});

test('a same-server reconnect reports that conclusion, after the dial', async (context) => {
  // The reconnect case: the identity layer confirms this is the server we
  // were on, so the host may keep its handle. Without a conclusion to report,
  // a plain reconnect would replace the handle, rebuild every page and ask no
  // leave guard.
  // The client is already on this machine: a saved entry, current, with the
  // mirror pointing at it. Only then is re-dialling it a RECONNECT rather
  // than a first connect to an unknown server.
  const app = await mount(context, async () => 'm-a', (storage) => {
    storage.setItem('tmux_servers', JSON.stringify([
      { id: 'a', name: 'alpha', address: 'wss://same.test/ws', token: 'tok', machineId: 'm-a', named: true },
    ]));
    storage.setItem('tmux_server_current', 'a');
    storage.setItem('tmux_address', 'wss://same.test/ws');
    storage.setItem('tmux_token', 'tok');
    storage.setItem('tmux_machine_id', 'm-a');
  });
  await connectTo(app, 'wss://same.test/ws');
  assert.ok(app.order.indexOf('conclude:same-server') > app.order.indexOf('connect'),
    `concluded after the dial: ${app.order.join(' → ')}`);
  assert.equal(app.order.at(-1), 'connected', 'and App is told last');
});

test('a dial that never reached a peer says so', async (context) => {
  // No authenticated stranger on the socket, so there is nothing for the old
  // handle to be confused with.
  const app = await mount(context, async () => { throw new Error('refused'); });
  await connectTo(app, 'wss://down.test/ws');
  assert.deepEqual(app.order, ['stand-down', 'connect', 'conclude:no-peer']);
});

test('a superseded attempt concludes nothing', async (context) => {
  // Handovers overlap in ordinary use: a dial is in flight and the person
  // submits again (or leaves the form and comes back, which is a new
  // instance). The older attempt must not report a conclusion — with a
  // boolean suspension its late "I am done" would lift the live attempt's
  // protection and put the old server's pages on a socket that is still
  // authenticating (reviewer P1, 2026-10-10).
  const pending: ((machine: string) => void)[] = [];
  const app = await mount(context, () => new Promise((resolve) => { pending.push(resolve); }));
  await connectTo(app, 'wss://same.test/ws');          // attempt 1, in flight
  assert.deepEqual(app.order, ['stand-down', 'connect'], 'the first dial is pending');

  // The form does not let one instance dial twice at once (the button is
  // disabled while connecting), so the second attempt starts the way a person
  // reaches it: cancel, then submit again.
  const cancel = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /cancel/iu.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`));
  assert.ok(cancel, 'the connecting state offers Cancel');
  cancel.click();
  await app.flush();
  await connectTo(app, 'wss://same.test/ws');          // attempt 2 supersedes it
  assert.deepEqual(app.order.filter((o) => o === 'connect').length, 2, 'two dials were started');

  assert.equal(pending.length, 2, 'both dials are waiting');
  pending[0]!('m-a');                                   // the OLD dial settles
  for (let i = 0; i < 8; i++) await app.flush();
  assert.deepEqual(app.order.filter((o) => o.startsWith('conclude')), [],
    'the superseded attempt reported nothing at all');
  assert.ok(!app.order.includes('connected'), 'and did not bring the app up either');
});

// The identity layer, mocked, so the one failure that matters can happen: a
// peer authenticates and the client cannot record WHICH server it is.
const withIdentity = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
  new URL('./servers.ts', import.meta.url),
]);

test('a peer that authenticated but could not be identified is not a same-server success', async (context) => {
  // The reviewer's second fixture: B authenticates, the registry write fails,
  // CURRENT still names A. Reporting "the function finished" would resume A's
  // handle onto B's socket. The conclusion must be `unresolved`, the form must
  // say so, and the app must NOT be told it is connected.
  const order: string[] = [];
  const app = await (await withIdentity).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); },
      beforeConnect() {
        order.push('stand-down');
        return (outcome: string) => order.push(`conclude:${outcome}`);
      },
    },
    modules: [
      {
        connect: async () => { order.push('connect'); return 'm-b'; },
        disconnect: () => { order.push('disconnect'); },
        getMachineId: () => 'm-b',
        setSocket: async () => {},
      },
      {
        // Everything Settings asks of the identity layer, with the one write
        // that fails.
        activateConnected: () => { order.push('activate'); throw new Error('storage full'); },
      },
    ],
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
  });
  await connectTo({ ...app, order }, 'wss://stranger.test/ws');

  assert.deepEqual(order, ['stand-down', 'connect', 'activate', 'conclude:unresolved', 'disconnect'],
    'the attempt concluded `unresolved` and dropped the socket it could not identify');
  assert.ok(!order.some((o) => o.startsWith('connected')),
    'and the app was never told this was its server');
  assert.match(app.document.querySelector('.error')?.textContent ?? '',
    /identif/iu, 'the person is told why');
});
