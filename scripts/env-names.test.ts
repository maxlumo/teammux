// Renamed environment variables (board #472, phase B2): TMUX_MOBILE_X is now TEAMMUX_X.
// Acceptance, from the reviewer: the NEW name decides the source by being PROVIDED (even
// empty); an invalid new value never falls back to the old one; both set and different
// means the new wins; the old alone works; the warning names variables and never a
// value, once per process per old variable; the other fallbacks keep their order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvReader } from './env-names.mjs';
import { DEV_HOST_ENV, DEV_HOST_ENV_LEGACY, DEV_SERVER_PORT_ENV, DEV_SERVER_PORT_ENV_LEGACY, devHost, devServerPort, devServerTargets } from './dev-ports.mjs';
import { DEV_WITH_SERVER_ENV, DEV_WITH_SERVER_ENV_LEGACY, serviceSpecs } from './dev-stack.mjs';
import { TMM_BIN_ENV, TMM_BIN_ENV_LEGACY, targetDirConflict, tmmPath } from './gateway-update.mjs';

function sink() {
  const lines: string[] = [];
  return { lines, read: createEnvReader((line: string) => lines.push(line)) };
}

test('the names: TEAMMUX_ is the name, TMUX_MOBILE_ the one still accepted', () => {
  assert.deepEqual(
    [DEV_HOST_ENV, DEV_SERVER_PORT_ENV, DEV_WITH_SERVER_ENV, TMM_BIN_ENV],
    ['TEAMMUX_DEV_HOST', 'TEAMMUX_DEV_SERVER_PORT', 'TEAMMUX_DEV_WITH_SERVER', 'TEAMMUX_GATEWAY_TMM'],
  );
  assert.deepEqual(
    [DEV_HOST_ENV_LEGACY, DEV_SERVER_PORT_ENV_LEGACY, DEV_WITH_SERVER_ENV_LEGACY, TMM_BIN_ENV_LEGACY],
    ['TMUX_MOBILE_DEV_HOST', 'TMUX_MOBILE_DEV_SERVER_PORT', 'TMUX_MOBILE_DEV_WITH_SERVER', 'TMUX_MOBILE_GATEWAY_TMM'],
  );
});

test('a provided new name is used, even empty, and says nothing', () => {
  const { lines, read } = sink();
  assert.equal(read({ TEAMMUX_X: 'new' }, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'new');
  assert.equal(read({ TEAMMUX_X: '' }, 'TEAMMUX_X', 'TMUX_MOBILE_X'), '', 'provided and empty is still the new name');
  assert.equal(read({ TEAMMUX_X: 'same', TMUX_MOBILE_X: 'same' }, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'same');
  assert.equal(read({}, 'TEAMMUX_X', 'TMUX_MOBILE_X'), undefined);
  assert.equal(read({ TEAMMUX_X: undefined } as never, 'TEAMMUX_X', 'TMUX_MOBILE_X'), undefined, 'an undefined entry is not provided');
  assert.deepEqual(lines, []);
  const other = sink();
  assert.equal(other.read({ TEAMMUX_X: '', TMUX_MOBILE_X: 'old' }, 'TEAMMUX_X', 'TMUX_MOBILE_X'), '', 'an empty new value does not fall back to the old');
  assert.equal(other.lines.length, 1, 'but the two differ, so the line says which one is used');
});

test('the old name alone still works and is named once per process, never with its value', () => {
  const { lines, read } = sink();
  const env = { TMUX_MOBILE_X: 'S3CRET-VALUE', TMUX_MOBILE_Y: 'other' };
  assert.equal(read(env, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'S3CRET-VALUE');
  assert.equal(read(env, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'S3CRET-VALUE');
  assert.equal(lines.length, 1, 'the second read is silent');
  assert.match(lines[0]!, /TMUX_MOBILE_X is deprecated; use TEAMMUX_X/u);
  read(env, 'TEAMMUX_Y', 'TMUX_MOBILE_Y');
  assert.equal(lines.length, 2, 'another variable says its own line');
  assert.ok(!lines.join('\n').includes('S3CRET-VALUE') && !lines.join('\n').includes('other'), 'no value is ever printed');
});

test('both set and different: the new wins and the line says which, once, without values', () => {
  const { lines, read } = sink();
  const env = { TEAMMUX_X: 'NEW-VALUE', TMUX_MOBILE_X: 'OLD-VALUE' };
  assert.equal(read(env, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'NEW-VALUE');
  assert.equal(read(env, 'TEAMMUX_X', 'TMUX_MOBILE_X'), 'NEW-VALUE');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /TEAMMUX_X and TMUX_MOBILE_X are both set and differ; TEAMMUX_X is used/u);
  assert.ok(!/NEW-VALUE|OLD-VALUE/u.test(lines[0]!));
});

test('devHost: the new name, the old alone, an empty new name, and Tauri\'s own fallback keep their order', () => {
  const { lines, read } = sink();
  assert.equal(devHost({ TEAMMUX_DEV_HOST: '0.0.0.0', TAURI_DEV_HOST: '1.1.1.1' }, read), '0.0.0.0');
  assert.equal(devHost({ TMUX_MOBILE_DEV_HOST: '0.0.0.0' }, read), '0.0.0.0', 'the old name alone works');
  assert.equal(lines.length, 1);
  assert.equal(devHost({ TEAMMUX_DEV_HOST: '  ', TMUX_MOBILE_DEV_HOST: '0.0.0.0', TAURI_DEV_HOST: '1.1.1.1' }, read), '1.1.1.1', 'a provided but blank new value is the new name: its own blank-handling applies, the old is not consulted');
  assert.equal(devHost({ TAURI_DEV_HOST: '1.1.1.1' }, read), '1.1.1.1');
  assert.equal(devHost({}, read), '127.0.0.1');
});

test('devServerPort: a provided new value that is invalid is an error, not the old value', () => {
  const { read } = sink();
  assert.equal(devServerPort({ TEAMMUX_DEV_SERVER_PORT: '19001', PORT: '19000' }, read), 19001, 'the dedicated setting still wins over PORT');
  assert.equal(devServerPort({ TMUX_MOBILE_DEV_SERVER_PORT: '19002', PORT: '19000' }, read), 19002, 'the old name alone works and still beats PORT');
  assert.equal(devServerPort({ TEAMMUX_DEV_SERVER_PORT: '19001', TMUX_MOBILE_DEV_SERVER_PORT: '19002' }, read), 19001, 'both set: the new wins');
  assert.throws(() => devServerPort({ TEAMMUX_DEV_SERVER_PORT: 'not-a-port', TMUX_MOBILE_DEV_SERVER_PORT: '19002' }, read), /invalid internal dev server port/u, 'no silent return to the old value');
  assert.equal(devServerPort({ TEAMMUX_DEV_SERVER_PORT: '', TMUX_MOBILE_DEV_SERVER_PORT: '19002', PORT: '19000' }, read), 19000, 'blank new: the existing blank-handling falls to PORT, never to the old name');
  assert.deepEqual(devServerTargets({ TEAMMUX_DEV_SERVER_PORT: '19001' }, read), { ws: 'ws://127.0.0.1:19001', http: 'http://127.0.0.1:19001' });
});

test('the dev stack: the new flag, the old flag alone, and the new one deciding when they differ', () => {
  const { read } = sink();
  const names = (env: Record<string, string>) => serviceSpecs('/w', env, read).map((s) => s.name);
  assert.deepEqual(names({ TEAMMUX_DEV_WITH_SERVER: '1' }), ['server', 'web']);
  assert.deepEqual(names({ TMUX_MOBILE_DEV_WITH_SERVER: '1' }), ['server', 'web'], 'the old flag alone still turns the watcher on');
  assert.deepEqual(names({ TEAMMUX_DEV_WITH_SERVER: '0', TMUX_MOBILE_DEV_WITH_SERVER: '1' }), ['web'], 'the new value wins');
  const web = serviceSpecs('/w', { TMUX_MOBILE_DEV_SERVER_PORT: '19002' }, read)[0]!;
  assert.deepEqual(web.env, { TEAMMUX_DEV_SERVER_PORT: '19002' }, 'the child is handed the NEW name, so it never warns');
});

test('gateway:update: the artifact variable, the old one alone, and the message names the new one', () => {
  const { read } = sink();
  assert.equal(tmmPath('/r', { TEAMMUX_GATEWAY_TMM: '/new/tmm' }, read), '/new/tmm');
  assert.equal(tmmPath('/r', { TMUX_MOBILE_GATEWAY_TMM: '/old/tmm' }, read), '/old/tmm');
  assert.equal(tmmPath('/r', { TEAMMUX_GATEWAY_TMM: '/new/tmm', TMUX_MOBILE_GATEWAY_TMM: '/old/tmm' }, read), '/new/tmm');
  assert.equal(tmmPath('/r', {}, read), '/r/src-tauri/target/release/tmm');
  assert.equal(targetDirConflict({ CARGO_TARGET_DIR: '/x', TMUX_MOBILE_GATEWAY_TMM: '/old/tmm' }, '/r', () => '', read), null, 'naming the artifact by the old variable still settles it');
  const why = targetDirConflict({ CARGO_TARGET_DIR: '/x' }, '/r', () => '', read);
  assert.match(String(why), /TEAMMUX_GATEWAY_TMM/u);
});
