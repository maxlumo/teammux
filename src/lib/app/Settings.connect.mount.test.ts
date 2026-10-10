// The connect form hands the shared socket over in the right ORDER
// (board #335 ②b-1, reviewer P1-b ii).
//
// This form can reach a DIFFERENT server than the one the app is on, and
// through ②b every page is talking over one connection object. So the host
// must get to revoke the current server's handle BEFORE the socket is
// re-dialled: after it points elsewhere, a call still in flight from the old
// tree — or a callback that settles before the new tree mounts — would be the
// old server's work sent to the new one.
//
// A source pin would only say the call is written somewhere in the function. A
// mount says it HAPPENED, and happened first.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
]);

async function mount(context: TestContext) {
  const order: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() { order.push('revoke'); },
    },
    modules: [{
      connect: async () => { order.push('connect'); return 'm-a'; },
      disconnect: () => {},
      getMachineId: () => 'm-a',
      setSocket: async () => {},
    }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
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

test('the current server s handle is revoked BEFORE the socket is re-dialled', async (context) => {
  const app = await mount(context);
  await connectTo(app, 'wss://other.test/ws');
  assert.ok(app.order.includes('connect'), `the form dialled: ${app.order.join(' → ')}`);
  assert.deepEqual(app.order.slice(0, 2), ['revoke', 'connect'],
    'the lease is given up first; after the re-dial the old tree would be talking to the new server');
});
