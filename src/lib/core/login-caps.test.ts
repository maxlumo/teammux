import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_DISPATCH, CapError, lacksCap, parseCaps, requireCap } from './login-caps.ts';

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

// The one gate on the write path (board #377 review, P1-B residual).
const fake = (initial: string[] | undefined) => {
  let caps = initial;
  const waiters: ((c: string[]) => void)[] = [];
  return {
    getCaps: () => caps,
    whenCaps: (ms = 5000) => caps ? Promise.resolve(caps) : new Promise<string[]>((res, rej) => { waiters.push(res); setTimeout(() => rej(new Error('late')), ms); }),
    answer(c: string[]) { caps = c; for (const w of waiters.splice(0)) w(c); },
  };
};

test('requireCap passes only on an answered login that includes the capability (board #377)', async () => {
  await requireCap(fake([BOARD_DISPATCH]), BOARD_DISPATCH);
  await assert.rejects(requireCap(fake([]), BOARD_DISPATCH), (e: unknown) => e instanceof CapError && e.code === 'server_too_old', 'an older server: a refusal');
  await assert.rejects(requireCap(fake(['other']), BOARD_DISPATCH), (e: unknown) => e instanceof CapError && e.code === 'server_too_old');
});

test('requireCap WAITS for an unanswered login, never treats it as a yes, and gives up as login_pending (board #377)', async () => {
  const slow = fake(undefined);
  let passed = false;
  const gate = requireCap(slow, BOARD_DISPATCH, 1000).then(() => { passed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(passed, false, 'unknown is not a yes');
  slow.answer([BOARD_DISPATCH]);
  await gate;
  assert.equal(passed, true, 'and it goes once the login says so');

  const refused = fake(undefined);
  const g2 = requireCap(refused, BOARD_DISPATCH, 1000);
  refused.answer([]);
  await assert.rejects(g2, (e: unknown) => e instanceof CapError && e.code === 'server_too_old', 'the login answered without it: refused');

  await assert.rejects(requireCap(fake(undefined), BOARD_DISPATCH, 5), (e: unknown) => e instanceof CapError && e.code === 'login_pending', 'a login that never answers is not waited on forever');
});
