// The status corner's ownership (board #335 ③c-5; reviewer P1-C2 on
// 018d4fa5): a reading belongs to the handle that asked for it. A late answer
// after the owner changed, or after the component is gone, writes nothing.
// The App tests cover the live shapes (A late over B; A→B→A fast); this one
// pins the unmount case the App harness cannot observe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

let compiled: ReturnType<typeof compileMount> | undefined;
const fixture = () => compiled ??= compileMount(new URL('./SystemStatus.test.svelte', import.meta.url), []);
const until = async (app: { flush: () => Promise<void> }, ok: () => boolean, n = 30) => { for (let i = 0; i < n && !ok(); i++) await app.flush(); };

test('a late answer after UNMOUNT writes nothing; a late answer of a replaced same-id handle is dropped', { timeout: 60000 }, async (context) => {
  const f = await fixture();
  const app = await f.mount(context, { modules: [], setup(w) { w.Element.prototype.getAnimations = () => []; } });
  try {
    const sys = app.window.__sys as { owner: unknown; tag: string; mounted: boolean; release(all?: boolean): void; pending: number };
    const vitals = () => app.document.querySelector('.sysvitals')?.textContent ?? '';
    await until(app, () => sys.pending >= 1);
    sys.release();
    await until(app, () => vitals() !== '');
    assert.match(vitals(), /10/u, `A s reading: ${vitals()}`);
    assert.equal(app.document.querySelector('.sysvitals .server-tag')?.textContent, 'alpha', 'named beside the number');
    // A fresh handle for the SAME id (a reconnect replaced the runtime): the
    // old reading goes, the request in flight on the old handle is dropped.
    context.mock.timers.tick(20_000);
    await until(app, () => sys.pending >= 1);
    const stale = sys.pending;
    sys.owner = { id: 'a' };
    await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'a new handle: no reading until it answers');
    assert.ok(sys.pending > stale, 'the new handle asked at once');
    sys.release(false);                         // the OLD handle s answer lands first
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'the old handle s late answer is dropped');
    sys.release();
    await until(app, () => vitals() !== '');
    assert.match(vitals(), /10/u, 'the new handle s answer lands');
    // Unmount with a request in flight; its answer arrives after.
    context.mock.timers.tick(20_000);
    await until(app, () => sys.pending >= 1);
    sys.mounted = false;
    await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'gone');
    sys.release();
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('.sysvitals'), null, 'nothing is written into a destroyed corner (no error either)');
  } finally {
    await app.unmount();
  }
});
