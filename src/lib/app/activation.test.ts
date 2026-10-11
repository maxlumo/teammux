import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivations } from './activation.ts';

test('the latest claim is the only current one, and endAll ends them all (board #335 ②b-4)', () => {
  const a = createActivations();
  const first = a.claim();
  assert.equal(first.current(), true);
  const second = a.claim();
  assert.equal(first.current(), false, 'a newer attempt supersedes the older');
  assert.equal(second.current(), true);
  a.endAll();
  assert.equal(second.current(), false, 'a revoke leaves nothing current');
  assert.equal(a.claim().current(), true, 'and the next claim is');
});
