// The Android scan sheet (board #403): the shell's one Dialog over a live
// preview, so it must not dim it, and only Cancel (or Escape/Back through the
// host) may end the scan: a tap on the preview ends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./NativeScanSheet.svelte', import.meta.url), []);

test('it says what it is looking for, leaves the preview undimmed, and ends the scan only by Cancel or Escape', async context => {
  let cancelled = 0;
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => { cancelled++; } },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
    modules: [],
  });
  try {
    for (let i = 0; i < 6 && !app.document.querySelector('.dlg'); i++) await app.flush();
    assert.match(app.document.querySelector('.dlg')!.textContent ?? '', /Point the camera at the code/u);
    assert.ok(app.document.querySelector('.dlg-backdrop')!.classList.contains('clear'), 'the scrim does not dim the preview');
    app.document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
    await app.flush();
    assert.equal(cancelled, 0, 'a tap on the preview cancels nothing');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^cancel$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.equal(cancelled, 1);
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await app.flush();
    assert.equal(cancelled, 2, 'Escape is the shell\u2019s');
  } finally { await app.close(); }
});
