import test from 'node:test';
import assert from 'node:assert/strict';
import { dialOrder, dialTimeoutMs, isAuthRefusal, isReachabilityFailure } from './dial-order.ts';

test('a dial that got nowhere is a reachability failure; an auth refusal is not (board #353)', () => {
  for (const m of ['connection timeout', 'connection failed', 'closed during auth', 'Connection Timeout']) {
    assert.equal(isReachabilityFailure(new Error(m)), true, m);
  }
  assert.equal(isReachabilityFailure('connection timeout'), true, 'a bare string reads the same');
  assert.equal(isReachabilityFailure(new Error('auth failed')), false, 'the server answered: another address would answer the same');
  assert.equal(isReachabilityFailure(new Error('invalid token')), false);
  assert.equal(isReachabilityFailure(undefined), false);
  assert.equal(isReachabilityFailure(null), false);
});

test('a dial is as patient as its address class: LAN fails fast, the internet gets a handshake (board #353)', () => {
  assert.deepEqual([0, 1, 2].map(dialTimeoutMs), [2000, 3000, 5000]);
  assert.equal(dialTimeoutMs(9), 5000, 'anything unclassified is treated as the internet');
});

test('dialOrder keeps the asked order, drops repeats and puts distrusted addresses last, still reachable by a pick (board #353)', () => {
  const a = 'ws://lan:1', b = 'ws://ts:2', c = 'ws://wan:3';
  assert.deepEqual(dialOrder([a, b, c], () => true), [a, b, c]);
  assert.deepEqual(dialOrder([a, b, a, c, b], () => true), [a, b, c], 'repeats once, in first place');
  assert.deepEqual(dialOrder([a, b, c], (x) => x !== a), [b, c, a], 'the one that just failed is last, not gone');
  assert.deepEqual(dialOrder([a, b], () => false), [a, b], 'all distrusted: the asked order stands');
  assert.deepEqual(dialOrder(['', a], () => true), [a], 'an empty address is no address');
  assert.deepEqual(dialOrder([], () => true), []);
});

test('only the server SAYING no is an auth refusal; a drop, a timeout and a protocol hiccup are not (board #393)', () => {
  for (const m of ['invalid token', 'Invalid token', 'auth failed']) assert.equal(isAuthRefusal(new Error(m)), true, m);
  assert.equal(isAuthRefusal('invalid token'), true, 'a bare string reads the same');
  for (const m of ['connection timeout', 'connection failed', 'closed during auth', 'superseded', 'auth failed: expected binary auth response', 'not an invalid token']) {
    assert.equal(isAuthRefusal(new Error(m)), false, m);
  }
  assert.equal(isAuthRefusal(undefined), false);
  assert.equal(isAuthRefusal(null), false);
  // The two kinds never overlap: an auth refusal is not a reachability failure.
  for (const m of ['invalid token', 'auth failed']) assert.equal(isReachabilityFailure(new Error(m)), false, m);
});
