import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_DISPATCH, HUB_FILES, SPAWN_JOIN, CapError, holdForLogin, lacksCap, parseCaps, requireCap } from './login-caps.ts';

test('parseCaps keeps the plain strings of a list and nothing else (board #377)', () => {
  assert.deepEqual(parseCaps(['board_dispatch']), ['board_dispatch']);
  assert.deepEqual(parseCaps(['a', '', 3, null, 'b']), ['a', 'b'], 'a malformed member is dropped, not trusted');
  for (const raw of [undefined, null, 'board_dispatch', { 0: 'board_dispatch' }, 7]) assert.deepEqual(parseCaps(raw), [], `not a list: ${JSON.stringify(raw)}`);
});

test('a server lacks a capability only when it ANSWERED without it (board #377)', () => {
  assert.equal(lacksCap(undefined, BOARD_DISPATCH), false, 'no authenticated socket: an unanswered question is not a no');
  assert.equal(lacksCap([], BOARD_DISPATCH), true, 'an older server announced none');
  assert.equal(lacksCap(['other'], BOARD_DISPATCH), true);
  assert.equal(lacksCap([BOARD_DISPATCH], BOARD_DISPATCH), false);
});

// The gate on the write path (board #377 review, P1-B residual): WAIT for the
// login (async), then CHECK (synchronous).
const fake = (initial: string[] | undefined) => {
  let caps = initial;
  const waiters: ((c: string[]) => void)[] = [];
  return {
    getCaps: () => caps,
    whenCaps: (ms = 5000) => caps ? Promise.resolve(caps) : new Promise<string[]>((res, rej) => { waiters.push(res); setTimeout(() => rej(new Error('late')), ms); }),
    answer(c: string[]) { caps = c; for (const w of waiters.splice(0)) w(c); },
  };
};
const refusal = (code: string) => (e: unknown) => e instanceof CapError && e.code === code;

test('requireCap passes only on an answered login that includes the capability, and never waits (board #377)', () => {
  requireCap(fake([BOARD_DISPATCH]), BOARD_DISPATCH);
  assert.throws(() => requireCap(fake([]), BOARD_DISPATCH), refusal('server_too_old'), 'an older server: a refusal');
  assert.throws(() => requireCap(fake(['other']), BOARD_DISPATCH), refusal('server_too_old'));
  // #382: each cap says what the person cannot do.
  assert.throws(() => requireCap(fake([BOARD_DISPATCH]), SPAWN_JOIN), (e: any) => e.code === 'server_too_old' && /start an agent inside a team/.test(e.message));
  assert.throws(() => requireCap(fake([]), BOARD_DISPATCH), (e: any) => /Update the server to assign\./.test(e.message));
  assert.throws(() => requireCap(fake([BOARD_DISPATCH]), HUB_FILES), (e: any) => e.code === 'server_too_old' && /Update the server to list files\./.test(e.message), '#432: Files says what it needs');
  assert.throws(() => requireCap(fake(undefined), BOARD_DISPATCH), refusal('login_pending'), 'unknown is never a yes, and the check does not wait: that is holdForLogin\u2019s job');
});

test('holdForLogin WAITS for an unanswered login and gives up as login_pending (board #377)', async () => {
  await holdForLogin(fake([]));            // answered (even with nothing): nothing to hold for
  await holdForLogin(fake([BOARD_DISPATCH]));
  const slow = fake(undefined);
  let passed = false;
  const hold = holdForLogin(slow, 1000).then(() => { passed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(passed, false, 'held while the login has not answered');
  slow.answer([BOARD_DISPATCH]);
  await hold;
  assert.equal(passed, true);
  await assert.rejects(holdForLogin(fake(undefined), 5), refusal('login_pending'), 'a login that never answers is not waited on forever');
});
