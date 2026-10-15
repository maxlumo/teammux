import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_DISPATCH, lacksCap, parseCaps } from './login-caps.ts';

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
