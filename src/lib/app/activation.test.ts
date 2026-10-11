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

// Per member (③a; reviewer P1-A on the ③ plan): one server hanging,
// reconnecting or being excluded never makes another's attempt stale.
const A = {}, B = {}, C = {};

test('members interleave: B hangs, C completes, A reconnects — each is still its own latest', () => {
  const g = createActivations();
  const a1 = g.member(A).claim();
  const b1 = g.member(B).claim();          // hangs
  const c1 = g.member(C).claim();
  assert.ok(a1.current() && b1.current() && c1.current(), 'three joins in flight, none stale');
  const a2 = g.member(A).claim();          // A reconnects while B still hangs
  assert.equal(a1.current(), false, 'A s own newer attempt supersedes A s older one');
  assert.ok(a2.current() && b1.current() && c1.current(), 'and touches neither B nor C');
});

test('a window attempt does not end background members; one acting ON a member ends only that member s', () => {
  const g = createActivations();
  const bReconnect = g.member(B).claim();
  const aReconnect = g.member(A).claim();
  const focusToC = g.claim();               // the person focuses C
  assert.ok(focusToC.current() && bReconnect.current() && aReconnect.current(), 'a focus change leaves every member s attempts alone');
  const formOnA = g.claim(A);               // the connect form takes over A s socket (②b)
  assert.equal(aReconnect.current(), false, 'the form ends A s reconnect in flight');
  assert.equal(bReconnect.current(), true, 'not B s');
  assert.equal(focusToC.current(), false, 'and is the window s latest');
  assert.equal(formOnA.current(), true);
});

test('excluding B ends B s late answers only; endAll ends everything', () => {
  const g = createActivations();
  const a = g.member(A).claim();
  const b = g.member(B).claim();
  const w = g.claim();
  g.member(B).endAll();                     // B excluded
  assert.equal(b.current(), false, 'B s late answer concludes nothing');
  assert.ok(a.current() && w.current(), 'A and the window are untouched');
  g.endAll();                               // the root teardown / a global block
  assert.ok(!a.current() && !w.current(), 'every generation ends');
  assert.equal(g.member(A).claim().current(), true, 'and the next claim is current');
});

test('same id, new handle: keys are handles, so a new runtime never inherits the old one s attempts', () => {
  const g = createActivations();
  const oldHandle = {}, newHandle = {};
  const late = g.member(oldHandle).claim();
  g.member(newHandle).claim();
  assert.equal(late.current(), true, 'the new handle s claim is not the old one s supersession');
  g.member(oldHandle).endAll();             // the old handle ends
  assert.equal(late.current(), false);
});
