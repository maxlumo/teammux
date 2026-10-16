// The application boundary of a scan result (board #403, review P2-1): a result
// that RESOLVED before its form was disposed must still not be applied to it. The
// promise is already fulfilled with text, so only the check at the point of
// application can tell; a detached input's value would prove nothing, so this
// watches the side effect itself (the pick callback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./ConnectFields.svelte', import.meta.url), []);
const LINK = 'wss://scan.example/ws?token=SCANNED-TOKEN&socket=';

async function mountFields(context: import('node:test').TestContext, onscan: (signal: AbortSignal) => Promise<string | null>, picks: unknown[]) {
  return (await compiled).mount(context, {
    props: { address: '', token: '', socket: '', onscan, onpick: (row: unknown) => { picks.push(row); return undefined; }, onenter: () => {} },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); window.localStorage.setItem('tmux_layout_mode', 'mobile'); },
    modules: [],
  });
}
const scanButton = (app: { document: Document }) => [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^scan qr code$/iu.test((b.textContent ?? '').trim()));

test('a scan result that resolves, then the form is disposed before the continuation runs, is not applied to it', async context => {
  const picks: unknown[] = [];
  let resolve!: (text: string | null) => void;
  const app = await mountFields(context, () => new Promise<string | null>((done) => { resolve = done; }), picks);
  scanButton(app)!.click();
  await app.flush();
  resolve(LINK);                       // fulfilled now; the continuation is a queued microtask
  const closing = app.close();         // the form is disposed in the same turn, before that microtask runs
  await closing;
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(picks, [], 'the pick callback never ran on a disposed form');
});

test('the same result, with the form alive, is applied exactly once', async context => {
  const picks: Array<{ address: string; token: string }> = [];
  let resolve!: (text: string | null) => void;
  const app = await mountFields(context, () => new Promise<string | null>((done) => { resolve = done; }), picks);
  try {
    scanButton(app)!.click();
    await app.flush();
    resolve(LINK);
    await app.flush(); await app.flush();
    assert.equal(picks.length, 1);
    assert.equal(picks[0]!.address, 'wss://scan.example/ws');
    assert.equal(picks[0]!.token, 'SCANNED-TOKEN');
  } finally { await app.close(); }
});
