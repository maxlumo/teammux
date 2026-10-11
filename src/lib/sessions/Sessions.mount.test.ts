import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// #167, 2026-09-12: execute the caller, including its real Projects child.
// A swallowed kill rejection used to look like success to ConfirmDialog.
// Bound to one server's scope, as App's provider binds it (board #335 ②b):
// Sessions reads its RPCs from the scope, and the scope speaks through the
// mocked transport.
const compiled = compileMount(new URL('./Sessions.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
const pane = (window: number) => ({ session: 'alpha', window, pane: 0, window_name: `shell-${window}`,
  current_command: 'zsh', current_path: '/fixture', width: 80, height: 24 });
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    listSessionsWithPanes: async () => ({ sessions: [{ name: 'alpha', windows: 2 }],
      panes: [pane(0), pane(1)] }),
    projectList: async () => ({ projects: [] }), hubRooms: async () => ({ rooms: {} }),
    ...extra,
  };
}
async function ask(app: App, kind: 'session' | 'window') {
  for (let i = 0; i < 8 && !app.document.querySelector('.session-row'); i++) await app.flush();
  if (kind === 'window') {
    app.document.querySelector<HTMLElement>('.session-row')!.click(); await app.flush();
  }
  app.document.querySelector<HTMLButtonElement>(kind === 'session' ? '.kill' : '.pane-kill')!.click();
  await app.flush();
  app.document.querySelector<HTMLButtonElement>('[role=menuitem]')!.click(); await app.flush();
}
function confirm(app: App) {
  return app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
}

for (const kind of ['session', 'window'] as const) {
  test(`${kind} kill retains a rejected target with a modal alert and one retry (#167)`, async context => {
    const calls: string[] = [];
    let reject!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, openTerminal: () => assert.fail('unexpected navigation') },
      modules: [rpc({ [kind === 'session' ? 'killSession' : 'killWindow']: (target: string) => {
        calls.push(target); return new Promise((_, no) => reject = no);
      } })],
    });
    try {
      await ask(app, kind);
      const title = app.document.querySelector('[role=alertdialog]')!.getAttribute('aria-label');
      confirm(app).click(); confirm(app).click(); await app.flush();
      assert.equal(calls.length, 1);
      app.document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
      const escape = new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      app.window.dispatchEvent(escape); await app.flush();
      assert.equal(escape.defaultPrevented, true);
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      reject(new Error('Kill refused')); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-label'), title,
        'a failed kill must not close the confirmer');
      assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Kill refused/);
      assert.equal(confirm(app).disabled, false);
      confirm(app).click(); await app.flush();
      assert.deepEqual(calls, [kind === 'session' ? 'alpha' : 'alpha:0', kind === 'session' ? 'alpha' : 'alpha:0']);
      assert.equal(app.document.querySelector('[role=alertdialog] [role=alert]'), null, 'retry clears the previous error');
    } finally { await app.close(); }
  });

  test(`${kind} kill names the process action, never Delete (#167)`, async context => {
    const app = await (await compiled).mount(context, { props: { visible: true, openTerminal: () => {} }, modules: [rpc()] });
    try {
      await ask(app, kind);
      assert.equal(confirm(app).getAttribute('aria-label'), `Kill ${kind}`);
    } finally { await app.close(); }
  });

  test(`${kind} kill success closes before a failed refresh and cannot resubmit (#167)`, async context => {
    let reads = 0, writes = 0;
    const app = await (await compiled).mount(context, {
      props: { visible: true, openTerminal: () => {} },
      modules: [rpc({
        listSessionsWithPanes: async () => {
          if (++reads > 1) throw new Error('Refresh unavailable');
          return { sessions: [{ name: 'alpha', windows: 2 }], panes: [pane(0), pane(1)] };
        },
        listPanes: async () => { throw new Error('Refresh unavailable'); },
        [kind === 'session' ? 'killSession' : 'killWindow']: async () => { writes++; },
      })],
    });
    try {
      await ask(app, kind); confirm(app).click();
      for (let i = 0; i < 6; i++) await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(writes, 1);
      assert.match(app.document.querySelector('.error')?.textContent ?? '', /Refresh unavailable/);
    } finally { await app.close(); }
  });
}

test('a session kill completing after unmount cannot start a refresh (#167)', async context => {
  let finish!: () => void, reads = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, openTerminal: () => {} },
    modules: [rpc({
      listSessionsWithPanes: async () => { reads++; return { sessions: [{ name: 'alpha', windows: 1 }], panes: [pane(0)] }; },
      killSession: () => new Promise<void>(yes => finish = yes),
    })],
  });
  try {
    await ask(app, 'session'); confirm(app).click(); await app.flush();
    await app.close(); finish();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(reads, 1, 'an obsolete view cannot refresh after its mutation completes');
  } finally { await app.close(); }
});

for (const kind of ['session', 'window'] as const) {
  test(`${kind} Back is stable, consumes busy confirmation and disposes to false (#167)`, async context => {
    let back: (() => boolean) | undefined, registrations = 0, writes = 0;
    let reject!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: {
        visible: true, openTerminal: () => assert.fail('unexpected navigation'),
        onGoBack: (fn: () => boolean) => { back = fn; registrations++; },
      },
      modules: [rpc({ [kind === 'session' ? 'killSession' : 'killWindow']: () => {
        writes++; return new Promise((_, no) => reject = no);
      } })],
    });
    try {
      assert.equal(typeof back, 'function', 'Sessions registers its local Back handler');
      const initial = back!;
      assert.equal(initial(), false, 'idle lets the host handle Back');
      await ask(app, kind);
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(writes, 0, 'Back cancels, never confirms');
      if (kind === 'window') app.document.querySelector<HTMLElement>('.session-row')!.click();
      await ask(app, kind);
      confirm(app).click(); await app.flush();
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      assert.equal(writes, 1);
      reject(new Error('Kill refused')); await app.flush();
      assert.ok(app.document.querySelector('[role=alertdialog] [role=alert]'));
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(initial(), false);
      assert.equal(back, initial, 'state changes do not replace the handler');
      assert.equal(registrations, 1);
      await app.close();
      assert.equal(registrations, 2, 'unmount replaces the host callback with an idle handler');
      assert.equal(back!(), false);
    } finally { await app.close(); }
  });
}

for (const kind of ['down', 'archive'] as const) {
  test(`Sessions delegates Back to nested project ${kind} confirmation (#167)`, async context => {
    let back: (() => boolean) | undefined;
    let reject!: (error: Error) => void, writes = 0;
    const app = await (await compiled).mount(context, {
      props: { visible: true, openTerminal: () => {}, onGoBack: (fn: () => boolean) => back = fn },
      modules: [rpc({
        projectList: async () => ({ projects: [{
          project: { id: 'tracked', session: 'tracked', name: 'Tracked', path: '/fixture' }, slots: [], live: true,
        }] }),
        [kind === 'down' ? 'projectDown' : 'projectArchive']: () => {
          writes++; return new Promise((_, no) => reject = no);
        },
      })],
    });
    const askProject = async () => {
      for (let i = 0; i < 8 && !app.document.querySelector('.proj'); i++) await app.flush();
      app.document.querySelector<HTMLButtonElement>(kind === 'down' ? '.acts .act' : '.acts .icon')!.click();
      await app.flush();
    };
    try {
      assert.equal(typeof back, 'function');
      assert.equal(back!(), false);
      await askProject();
      assert.equal(back!(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(writes, 0);
      await askProject(); confirm(app).click(); await app.flush();
      assert.equal(back!(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      reject(new Error('Project refused')); await app.flush();
      assert.equal(back!(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(back!(), false);
      await app.close(); assert.equal(back!(), false);
    } finally { await app.close(); }
  });
}

test('the phone Back closes the New Project dialog, and nothing behind it (#317 review P1-a)', async context => {
  // The dialog shell deliberately does NOT consume popstate (it would race
  // the host's layer chain and peel two layers for one gesture), so the HOST
  // must register it. Sessions did not, which meant that on a phone — where
  // Sessions is the Terminal page's drawer — the New Project dialog could not
  // be dismissed with Back at all.
  let goBack!: () => boolean;
  const app = await (await compiled).mount(context, {
    props: { visible: true, openTerminal: () => assert.fail('unexpected navigation'),
      onGoBack: (fn: () => boolean) => { goBack = fn; } },
    modules: [rpc({ registryList: async () => ({ agents: [] }), fsList: async () => ({ path: '/', entries: [] }) })],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.new-btn'); i++) await app.flush();
    assert.equal(goBack(), false, 'with nothing open, Back is not ours to consume');
    app.document.querySelector<HTMLButtonElement>('.new-btn')!.click();
    for (let i = 0; i < 8 && !app.document.querySelector('.dlg'); i++) await app.flush();
    assert.ok(app.document.querySelector('.dlg'), 'the dialog is up');
    // And it peels the dialog's own steps first, in the order Escape takes:
    // the folder picker's new-folder field, then the picker, then the dialog.
    // One definition (CreateProjectDialog.goBack) serves both dismissals, so
    // Back and Escape cannot disagree about what a draft is.
    app.document.querySelector<HTMLButtonElement>('.dlg .path-row .chip-btn')!.click();
    for (let i = 0; i < 8 && !app.document.querySelector('.pk-head'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg [aria-label="New folder"]')!.click();
    for (let i = 0; i < 4 && !app.document.querySelector('.pk-new-input'); i++) await app.flush();
    assert.equal(goBack(), true); await app.flush();
    assert.equal(app.document.querySelector('.pk-new-input'), null, 'the folder field first');
    assert.ok(app.document.querySelector('.pk-head'), 'the picker is still open');
    assert.equal(goBack(), true); await app.flush();
    assert.equal(app.document.querySelector('.pk-head'), null, 'then the picker');
    assert.ok(app.document.querySelector('.dlg'), 'and the form is still there with its draft');
    assert.equal(goBack(), true, 'Back is consumed by the modal');
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.document.querySelector('.dlg'), null, 'and closes it');
    assert.ok(app.document.querySelector('.new-btn'), 'the page behind it is untouched');
    assert.equal(goBack(), false, 'the next Back falls through to the page again');
  } finally { await app.close(); }
});
