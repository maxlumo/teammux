import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// #167, 2026-09-12: the real caller used to close before its RPC even settled.
// Bound to one server's scope, as App's provider binds it (board #335 ②b).
const compiled = compileMount(new URL('./Projects.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
const rows = ['alpha', 'beta'].map(name => ({ project: { id: name, name, session: name, path: `/fixture/${name}` },
  slots: [], live: true }));
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return { projectList: async () => ({ projects: rows }), hubRooms: async () => ({ rooms: {} }), ...extra };
}
async function ask(app: App, kind: 'down' | 'archive') {
  for (let i = 0; i < 8 && !app.document.querySelector('.proj'); i++) await app.flush();
  app.document.querySelector<HTMLButtonElement>(kind === 'down' ? '.acts .act' : '.acts .icon')!.click();
  await app.flush();
}
function confirm(app: App) {
  return app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
}
for (const kind of ['down', 'archive'] as const) {
  test(`project ${kind} keeps its target pending and retryable with a modal alert (#167)`, async context => {
    const calls: unknown[][] = [];
    let reject!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, openTerminal: () => assert.fail('unexpected navigation') },
      modules: [rpc({ [kind === 'down' ? 'projectDown' : 'projectArchive']: (...args: unknown[]) => {
        calls.push(args); return new Promise((_, no) => reject = no);
      } })],
    });
    try {
      await ask(app, kind);
      confirm(app).click(); confirm(app).click(); await app.flush();
      assert.equal(calls.length, 1);
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      app.document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
      const escape = new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      app.window.dispatchEvent(escape); await app.flush();
      assert.equal(escape.defaultPrevented, true);
      assert.ok(app.document.querySelector('[role=alertdialog]'));
      reject(new Error('Project refused')); await app.flush();
      assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Project refused/);
      assert.equal(confirm(app).disabled, false);
      confirm(app).click(); await app.flush();
      assert.deepEqual(calls, kind === 'down' ? [['alpha'], ['alpha']] : [['alpha', true], ['alpha', true]]);
      assert.equal(app.document.querySelector('[role=alertdialog] [role=alert]'), null);
    } finally { await app.close(); }
  });

  test(`project ${kind} commits before refresh and a failed refresh does not offer mutation retry (#167)`, async context => {
    let reads = 0, writes = 0;
    let rejectRefresh!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, openTerminal: () => {} },
      modules: [rpc({
        projectList: () => ++reads === 1 ? Promise.resolve({ projects: rows })
          : new Promise((_, no) => rejectRefresh = no),
        [kind === 'down' ? 'projectDown' : 'projectArchive']: async () => { writes++; },
      })],
    });
    try {
      await ask(app, kind); confirm(app).click();
      for (let i = 0; i < 4; i++) await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      rejectRefresh(new Error('Catalog unavailable'));
      for (let i = 0; i < 4; i++) await app.flush();
      assert.equal(writes, 1);
      assert.match(app.document.querySelector('.err')?.textContent ?? '', /Catalog unavailable/);
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
    } finally { await app.close(); }
  });
}

test('a project mutation completing after unmount cannot refresh or report tracking (#167)', async context => {
  let finish!: () => void, reads = 0, tracked = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, openTerminal: () => {}, onTracked: () => tracked++ },
    modules: [rpc({
      projectList: async () => { reads++; return { projects: rows }; },
      projectDown: () => new Promise<void>(yes => finish = yes),
    })],
  });
  try {
    await ask(app, 'down'); confirm(app).click(); await app.flush();
    await app.close(); finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(reads, 1);
    assert.equal(tracked, 1);
  } finally { await app.close(); }
});

for (const kind of ['down', 'archive'] as const) {
  test(`project ${kind} Back is stable, consumes busy confirmation and disposes to false (#167)`, async context => {
    let back: (() => boolean) | undefined, registrations = 0, writes = 0;
    let reject!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: {
        visible: true, openTerminal: () => assert.fail('unexpected navigation'),
        onGoBack: (fn: () => boolean) => { back = fn; registrations++; },
      },
      modules: [rpc({ [kind === 'down' ? 'projectDown' : 'projectArchive']: () => {
        writes++; return new Promise((_, no) => reject = no);
      } })],
    });
    try {
      assert.equal(typeof back, 'function', 'Projects registers its local Back handler');
      const initial = back!;
      assert.equal(initial(), false);
      await ask(app, kind);
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(writes, 0);
      await ask(app, kind); confirm(app).click(); await app.flush();
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      assert.equal(writes, 1);
      reject(new Error('Project refused')); await app.flush();
      assert.ok(app.document.querySelector('[role=alertdialog] [role=alert]'));
      assert.equal(initial(), true); await app.flush();
      assert.equal(app.document.querySelector('[role=alertdialog]'), null);
      assert.equal(initial(), false);
      assert.equal(back, initial);
      assert.equal(registrations, 1, 'pending/error updates do not re-register Back');
      await app.close();
      assert.equal(registrations, 2);
      assert.equal(back!(), false, 'unmount releases the host callback');
    } finally { await app.close(); }
  });
}
