import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Bound to one server's scope, as App's provider binds it (board #335 ②b).
const compiled = compileMount(new URL('./GitPanel.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type Reply = { code: number; stdout: string; stderr: string };
type Call = { subcmd: string; args: string[]; cwd: string };
const ok = (stdout = ''): Reply => ({ code: 0, stdout, stderr: '' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rpc(verb: (call: Call) => Reply | Promise<Reply> = () => ok()) {
  const calls: Call[] = [];
  return { calls, modules: [{ gitCmd: (subcmd: string, args: string[], cwd: string) => {
    const call = { subcmd, args: [...args], cwd }; calls.push(call);
    if (subcmd === 'rev-parse') return Promise.resolve(ok('/repo\n'));
    if (subcmd === 'branch') return Promise.resolve(ok('main\n'));
    if (subcmd === 'status') return Promise.resolve(ok(' M first.txt\nM  second.txt\n'));
    if (subcmd === 'log') return Promise.resolve(ok('abc123|subject|today|author\n'));
    if (subcmd === 'diff') return Promise.resolve(ok(args.includes('--numstat') ? '1\t0\tfirst.txt\n' : '@@ change @@\n+new\n'));
    assert.ok(['push', 'add', 'restore', 'commit'].includes(subcmd), `Unexpected git verb: ${subcmd}`);
    return Promise.resolve(verb(call));
  } }] };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
const props = { cwd: '/repo', onOpenFile() {}, onClose() {} };
async function settle(app: App) { for (let i = 0; i < 8; i++) await app.flush(); }
const notice = (app: App) => app.document.querySelector('.git-push-result, .operation-feedback');
function button(app: App, label: string) {
  const found = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label);
  assert.ok(found, label); return found;
}
function stage(app: App, index = 0) { app.document.querySelectorAll<HTMLButtonElement>('.git-stage-btn')[index]!.click(); }

test('GitPanel operation errors persist beyond the old three-second flash (#167)', async context => {
  const transport = rpc(() => ({ code: 1, stderr: 'index locked', stdout: '' }));
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); stage(app); await settle(app);
    assert.match(notice(app)?.textContent ?? '', /index locked/);
    await app.advance(10000);
    assert.match(notice(app)?.textContent ?? '', /index locked/);
    assert.equal(notice(app)?.getAttribute('role'), 'alert');
    button(app, 'Close').click(); await settle(app);
    assert.equal(notice(app), null);
  } finally { await app.close(); }
});

test('GitPanel older failure cannot overwrite the latest verb result (#167)', async context => {
  const a = deferred<Reply>(), b = deferred<Reply>();
  const transport = rpc(call => call.subcmd === 'add' ? a.promise : b.promise);
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); stage(app); stage(app, 1); await settle(app);
    b.reject(Error('new restore failure')); await settle(app);
    a.reject(Error('old add failure')); await settle(app);
    assert.match(notice(app)?.textContent ?? '', /new restore failure/);
    assert.doesNotMatch(notice(app)?.textContent ?? '', /old add failure/);
  } finally { a.resolve(ok()); b.resolve(ok()); await app.close(); }
});

test('GitPanel late push success cannot replace a newer staging error (#167)', async context => {
  const push = deferred<Reply>();
  const transport = rpc(call => call.subcmd === 'push' ? push.promise : { code: 1, stdout: '', stderr: 'new add failure' });
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); button(app, 'Push').click(); await settle(app);
    stage(app); await settle(app);
    push.resolve(ok()); await settle(app);
    assert.match(notice(app)?.textContent ?? '', /new add failure/);
    assert.doesNotMatch(notice(app)?.textContent ?? '', /Pushed/);
  } finally { push.resolve(ok()); await app.close(); }
});

test('GitPanel push completion expires at 1500ms and has no Close action (#167)', async context => {
  const transport = rpc();
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); button(app, 'Push').click(); await settle(app);
    assert.deepEqual(transport.calls.filter(call => call.subcmd === 'push'), [{ subcmd: 'push', args: [], cwd: '/repo' }]);
    const message = notice(app)?.textContent?.trim();
    assert.equal(notice(app)?.querySelector('button'), null);
    await app.advance(1499); assert.ok(notice(app));
    await app.advance(1); assert.equal(notice(app), null);
    assert.equal(message, 'Pushed');
  } finally { await app.close(); }
});

test('GitPanel old completion expiry cannot erase a newer persistent error (#167)', async context => {
  const transport = rpc(call => call.subcmd === 'push' ? ok() : { code: 1, stdout: '', stderr: 'new stage error' });
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); button(app, 'Push').click(); await settle(app);
    await app.advance(1000); stage(app); await settle(app);
    await app.advance(10000);
    assert.match(notice(app)?.textContent ?? '', /new stage error/);
  } finally { await app.close(); }
});

for (const changed of ['cwd', 'tab', 'diff'] as const) {
  test(`GitPanel ${changed} context exit invalidates pending feedback, even after return (#167)`, async context => {
    const pending = deferred<Reply>();
    let update!: (next: Record<string, unknown>) => void;
    const app = await (await compiled).mount(context, {
      props: { ...props, register: (fn: typeof update) => { update = fn; } },
      modules: rpc(() => pending.promise).modules,
    });
    try {
      await settle(app); button(app, 'Push').click(); await settle(app);
      if (changed === 'cwd') {
        update({ cwd: '/other' }); await settle(app);
        update({ cwd: '/repo' }); await settle(app);
      } else if (changed === 'tab') {
        button(app, 'Log').click(); await settle(app);
        button(app, 'Status').click(); await settle(app);
      } else {
        app.document.querySelector<HTMLButtonElement>('.git-file')!.click(); await settle(app);
        assert.ok(app.document.querySelector('.git-diff-body'));
        app.document.querySelector<HTMLButtonElement>('.back-btn')!.click(); await settle(app);
      }
      pending.reject(Error('old context failure')); await settle(app);
      assert.equal(notice(app), null);
    } finally { pending.resolve(ok()); await app.close(); }
  });
}

test('GitPanel unmount discards pending completion without starting another feedback timer (#167)', async context => {
  const pending = deferred<Reply>();
  const timers: number[] = [];
  const app = await (await compiled).mount(context, {
    props, modules: rpc(() => pending.promise).modules,
    setup(window) {
      const schedule = window.setTimeout;
      window.setTimeout = (run, delay, ...args) => {
        timers.push(delay ?? 0); return schedule(run, delay, ...args);
      };
    },
  });
  try {
    await settle(app); button(app, 'Push').click(); await settle(app);
    await app.close();
    const before = timers.length;
    pending.resolve(ok());
    for (let i = 0; i < 16; i++) await Promise.resolve();
    assert.equal(timers.length, before, 'a destroyed panel must not schedule completion feedback');
  } finally { pending.resolve(ok()); await app.close(); }
});

test('GitPanel stage/unstage/add-all keep their arguments and do not add success notices (#167)', async context => {
  const transport = rpc();
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); stage(app); await settle(app);
    assert.equal(notice(app), null);
    stage(app, 1); await settle(app); assert.equal(notice(app), null);
    button(app, 'Add All').click(); await settle(app); assert.equal(notice(app), null);
    assert.deepEqual(transport.calls.filter(call => ['add', 'restore'].includes(call.subcmd)), [
      { subcmd: 'add', args: ['first.txt'], cwd: '/repo' },
      { subcmd: 'restore', args: ['--staged', 'second.txt'], cwd: '/repo' },
      { subcmd: 'add', args: ['.'], cwd: '/repo' },
    ]);
  } finally { await app.close(); }
});

test('GitPanel commit retains the draft on failure, retries unchanged args, then shows a short completion (#167)', async context => {
  let attempts = 0;
  const transport = rpc(() => ++attempts === 1 ? { code: 1, stdout: '', stderr: 'commit rejected' } : ok());
  const app = await (await compiled).mount(context, { props, modules: transport.modules });
  try {
    await settle(app); button(app, 'Commit (1)').click(); await settle(app);
    const input = app.document.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = '  subject  '; input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await settle(app); button(app, 'OK').click(); await settle(app);
    assert.equal(input.value, '  subject  ');
    assert.ok(input.isConnected);
    assert.match(notice(app)?.textContent ?? '', /commit rejected/);
    button(app, 'OK').click(); await settle(app);
    assert.equal(app.document.querySelector('textarea'), null);
    const message = notice(app)?.textContent?.trim();
    assert.deepEqual(transport.calls.filter(call => call.subcmd === 'commit').map(call => call.args), [
      ['-m', 'subject'], ['-m', 'subject'],
    ]);
    await app.advance(1500); assert.equal(notice(app), null);
    assert.equal(message, 'Committed');
  } finally { await app.close(); }
});

test('GitPanel successful stdout is not classified by a leading cross character (#167)', async context => {
  const app = await (await compiled).mount(context, { props, modules: rpc(() => ok('\u2717 ordinary stdout')).modules });
  try {
    await settle(app); button(app, 'Push').click(); await settle(app);
    assert.equal(notice(app)?.getAttribute('role'), 'status');
    assert.match(notice(app)?.textContent ?? '', /ordinary stdout/);
  } finally { await app.close(); }
});
