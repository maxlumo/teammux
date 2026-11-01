import test from 'node:test';
import assert from 'node:assert/strict';
import { dialOrder, dialTimeoutMs, isAuthRefusal, isReachabilityFailure, pairKey, runRound, type DialPair, type RoundPick } from './dial-order.ts';

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

test('only the server SAYING no is an auth refusal, by its ERR_AUTH code: a drop, a timeout and a protocol surprise are not (board #393)', () => {
  const coded = (message: string, code: number) => Object.assign(new Error(message), { code });
  // What core/connection.ts rejects with when the server answers the login with ERR_AUTH.
  for (const m of ['invalid proof', 'invalid token', '']) assert.equal(isAuthRefusal(coded(m, -32000)), true, `-32000 "${m}"`);
  // The same words WITHOUT the code are not a refusal: the message is the server's sentence, not a contract.
  for (const m of ['invalid token', 'auth failed', 'invalid proof']) assert.equal(isAuthRefusal(new Error(m)), false, `no code: ${m}`);
  // Other ways a login fails, and other wire codes, are not.
  for (const m of ['connection timeout', 'connection failed', 'closed during auth', 'superseded', 'auth failed: expected binary auth response']) {
    assert.equal(isAuthRefusal(new Error(m)), false, m);
  }
  assert.equal(isAuthRefusal(coded('scratch held', -32010)), false);
  assert.equal(isAuthRefusal(coded('internal', -32603)), false);
  assert.equal(isAuthRefusal('invalid token'), false, 'a bare string is not an error with a code');
  assert.equal(isAuthRefusal(undefined), false);
  assert.equal(isAuthRefusal(null), false);
  // The two kinds never overlap: an auth refusal is not a reachability failure.
  assert.equal(isReachabilityFailure(coded('invalid proof', -32000)), false);
});

// ---- runRound (board #495): the one address round the switch and the reconnect machine walk ----
/** A round over a fixed list, each address answering as `answers` says. */
function fixedRound(addresses: string[], answers: Record<string, 'ok' | 'timeout' | 'auth' | 'protocol'>, over: Partial<Parameters<typeof runRound>[0]> = {}) {
  const log: string[] = [];
  const timeout = new Error('connection timeout');
  const auth = Object.assign(new Error('invalid proof'), { code: -32000 });
  const r = runRound<string>({
    pick: (tried) => {
      const address = addresses.find((a) => !tried.has(pairKey({ address: a, token: 't' })));
      return address ? { kind: 'dial', pair: { address, token: 't' } } : { kind: 'exhausted' };
    },
    dial: async ({ address }, ms) => {
      log.push(`dial:${address}:${ms}`);
      const how = answers[address] ?? 'ok';
      if (how === 'timeout') throw timeout;
      if (how === 'auth') throw auth;
      if (how === 'protocol') throw new Error('expected binary auth response');
      return `answer:${address}`;
    },
    live: () => true,
    failed: (_p, e) => (isAuthRefusal(e) ? 'stop' : 'next'),
    timeoutOf: (a) => (a.startsWith('lan') ? 2000 : 5000),
    unreachable: (a) => log.push(`cooldown:${a}`),
    ...over,
  } as Parameters<typeof runRound<string>>[0]);
  return { r, log };
}

test('runRound dials in the picked order, one at a time; a reachability failure is marked and the next is dialled; success ends the round with the dial s own answer (#495)', async () => {
  const { r, log } = fixedRound(['lan', 'wan', 'spare'], { lan: 'timeout' });
  assert.deepEqual(await r, { kind: 'ok', pair: { address: 'wan', token: 't' }, answer: 'answer:wan' });
  assert.deepEqual(log, ['dial:lan:2000', 'cooldown:lan', 'dial:wan:5000'], 'one at a time, each with its own timeout; spare never dialled');
});

test('runRound: failed() decides — stop ends the round with the pair sent; a non-reachability failure marks no cooldown (#495)', async () => {
  const { r, log } = fixedRound(['a', 'b'], { a: 'auth' });
  const out = await r;
  assert.equal(out.kind, 'stopped');
  assert.deepEqual(out.kind === 'stopped' && out.pair, { address: 'a', token: 't' });
  assert.deepEqual(log, ['dial:a:5000'], 'no cooldown for an auth refusal, and b is not dialled');
  const p = fixedRound(['a', 'b'], { a: 'protocol' });
  assert.equal((await p.r).kind, 'ok', 'a protocol error the caller passes on goes to the next');
  assert.deepEqual(p.log, ['dial:a:5000', 'dial:b:5000'], 'and marks no cooldown');
});

test('runRound: every pair failed is exhausted, with the last error (#495)', async () => {
  const { r } = fixedRound(['a', 'b'], { a: 'timeout', b: 'timeout' });
  const out = await r;
  assert.equal(out.kind, 'exhausted');
  assert.match(String(out.kind === 'exhausted' && (out.error as Error).message), /timeout/u);
});

test('runRound: live() false after the wait or after a dial — no further dial, no cooldown, nothing concluded (#495 P1-B)', async () => {
  let owned = true;
  const a = fixedRound(['a', 'b'], {}, { before: async () => { owned = false; }, live: () => owned });
  assert.deepEqual(await a.r, { kind: 'abandoned' });
  assert.deepEqual(a.log, [], 'taken during the wait: nothing dialled');
  owned = true;
  const b = fixedRound(['a', 'b'], { a: 'timeout' }, { live: () => owned, dial: async () => { owned = false; throw new Error('connection timeout'); } });
  assert.deepEqual(await b.r, { kind: 'abandoned' });
  assert.deepEqual(b.log, [], 'taken during the dial: its failure marks nothing, b is not dialled');
  owned = true;
  const c = fixedRound(['a'], {}, { live: () => owned, dial: async () => { owned = false; return 'late'; } });
  assert.deepEqual(await c.r, { kind: 'abandoned' }, 'a success that lands after the takeover is nobody s');
});

test('runRound: pick runs after EVERY await, after the wait, and the pair it gives is dialled in the same turn; wait and end pass through without a dial (#495)', async () => {
  const order: string[] = [];
  let n = 0;
  const picks: RoundPick[] = [{ kind: 'dial', pair: { address: 'a', token: 't' } }, { kind: 'wait' }];
  const out = await runRound<string>({
    before: async () => { order.push('before'); },
    pick: () => { order.push('pick'); return picks[n++]!; },
    dial: (p: DialPair) => { order.push(`dial:${p.address}`); return Promise.reject(new Error('connection timeout')); },
    live: () => true,
    failed: () => 'next',
  });
  assert.deepEqual(out, { kind: 'wait' });
  assert.deepEqual(order, ['before', 'pick', 'dial:a', 'before', 'pick']);
  const end = await runRound<string>({ pick: () => ({ kind: 'end', reason: 'auth' }), dial: async () => 'x', live: () => true, failed: () => 'next' });
  assert.deepEqual(end, { kind: 'end', reason: 'auth' });
});

test('runRound: tried is keyed by the PAIR sent — the same address with another token is a new pair (#495 P1-A)', async () => {
  let token = 't';
  const sent: string[] = [];
  const out = await runRound<string>({
    pick: (tried) => (tried.has(pairKey({ address: 'a', token })) ? { kind: 'exhausted' } : { kind: 'dial', pair: { address: 'a', token } }),
    dial: async (p) => { sent.push(`${p.address} ${p.token}`); if (p.token === 't') { token = 't2'; throw new Error('connection timeout'); } return 'up'; },
    live: () => true,
    failed: () => 'next',
  });
  assert.deepEqual(sent, ['a t', 'a t2']);
  assert.equal(out.kind, 'ok');
});
