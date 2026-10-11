// Escape is a CONSUMABLE dismissal (board #317 review P1-b). The shell owns
// one window-level listener, so without being asked it cancelled a folder
// NAME by closing the whole project form — the draft with it. The dialog's
// layers are peeled innermost-first, and the same order serves the phone's
// Back (the host calls `goBack`), so the two dismissals cannot disagree.
//
// Tested through the real consumer: a Dialog.test host cannot show that the
// shell asks the right question, only that it asks one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Bound to one server's scope, as App's provider binds it (board #335 ②b):
// its DirPicker reads its RPCs from the scope.
const compiled = compileMount(new URL('./CreateProjectDialog.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
], { serverScope: true });
const ws = (extra: Record<string, (...a: any[]) => unknown> = {}) => ({
  registryList: async () => ({ agents: [] }),
  fsList: async () => ({ path: '/home/fixture', entries: [{ name: 'src', type: 'dir', path: '/home/fixture/src' }] }),
  fsMkdir: async () => ({ ok: true }),
  projectCreate: async () => assert.fail('no creation in these scenarios'),
  ...extra,
});
const esc = (app: { window: { KeyboardEvent: typeof KeyboardEvent; dispatchEvent: (e: Event) => boolean } }, composing = false) =>
  app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: composing, cancelable: true }));

test('Escape peels the folder step and keeps the project draft; a second one closes the dialog', async context => {
  let cancelled = 0;
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => { cancelled++; } }, modules: [ws()],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('input'); i++) await app.flush();
    // A draft worth protecting.
    const name = app.document.querySelector<HTMLInputElement>('input')!;
    name.value = 'my-project';
    name.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    // Into the folder picker, then into its new-folder field: three layers.
    app.document.querySelector<HTMLButtonElement>('.chip-btn')!.click();
    for (let i = 0; i < 8 && !app.document.querySelector('.pk-head'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('[aria-label="New folder"]')!.click();
    for (let i = 0; i < 4 && !app.document.querySelector('.pk-new-input'); i++) await app.flush();
    assert.ok(app.document.querySelector('.pk-new-input'), 'the new-folder field is open');

    esc(app); await app.flush();
    assert.equal(app.document.querySelector('.pk-new-input'), null, 'the folder step is cancelled');
    assert.ok(app.document.querySelector('.pk-head'), 'the picker stays');
    assert.equal(cancelled, 0, 'and the dialog does NOT close');

    esc(app); await app.flush();
    assert.equal(app.document.querySelector('.pk-head'), null, 'the next Escape leaves the picker');
    assert.equal(cancelled, 0);
    assert.equal(app.document.querySelector<HTMLInputElement>('input')!.value, 'my-project',
      'the draft survived both — which is what the shell used to throw away');

    esc(app); await app.flush();
    assert.equal(cancelled, 1, 'with nothing left to peel, Escape closes the dialog');
  } finally { await app.close(); }
});

test('an IME-composing Escape peels nothing and closes nothing', async context => {
  let cancelled = 0;
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => { cancelled++; } }, modules: [ws()],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.chip-btn'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.chip-btn')!.click();
    for (let i = 0; i < 8 && !app.document.querySelector('.pk-head'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('[aria-label="New folder"]')!.click();
    for (let i = 0; i < 4 && !app.document.querySelector('.pk-new-input'); i++) await app.flush();
    esc(app, true); await app.flush();
    assert.ok(app.document.querySelector('.pk-new-input'), 'that Escape belongs to the candidate window');
    assert.equal(cancelled, 0);
  } finally { await app.close(); }
});

// The phone Back peels the SAME order through the real host — asserted in
// sessions/Sessions.mount.test.ts, where `goBack` is the registered chain and
// the mount harness can reach it.
