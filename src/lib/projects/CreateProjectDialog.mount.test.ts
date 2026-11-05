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

// Board #7 round 3 (reviewer 10:23 P1-R2): a pick made while availability is
// unknown is dropped when the first check greys it; Create spawns only what
// this server can run.
test('a pick made before the first check is dropped when that check greys it, and Create spawns nothing (#7)', async context => {
  const spawned: unknown[] = [];
  let release = () => {};
  let state = 'unknown';
  const app = await (await compiled).mount(context, {
    modules: [ws({
      registryList: async () => ({ agents: [{ name: 'grok', backend: 'grok', availability: state === 'unknown' ? { state } : { state, reason: 'not_found', missing: [] } }] }),
      backendsCheck: () => new Promise<void>((ok) => { release = () => { state = 'unavailable'; ok(); }; }),
      projectCreate: async () => ({ project: { id: 1, session: 'p' } }),
      projectUp: async () => ({}),
      hubSpawn: async (...args: unknown[]) => { spawned.push(args); return {}; },
    })],
  });
  try {
    const pick = () => app.document.querySelector<HTMLButtonElement>('.agent-pick')!;
    for (let i = 0; i < 8 && !app.document.querySelector('.agent-pick'); i++) await app.flush();
    pick().click(); await app.flush();
    assert.ok(pick().classList.contains('sel'), 'picked while unknown');
    release();
    for (let i = 0; i < 12 && !pick().disabled; i++) await app.flush();
    assert.ok(pick().disabled, 'the first check greyed grok');
    assert.equal(pick().classList.contains('sel'), false, 'and its pick is gone');
    const inputs = app.document.querySelectorAll<HTMLInputElement>('input');
    for (const [el, v] of [[inputs[0]!, 'p'], [inputs[1]!, '/home/fixture']] as const) { el.value = v; el.dispatchEvent(new app.window.Event('input', { bubbles: true })); }
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .primary')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(spawned, [], 'no spawn of an agent this server cannot run');
  } finally { await app.close(); }
});
