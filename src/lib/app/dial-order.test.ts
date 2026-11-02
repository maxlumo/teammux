import test from 'node:test';
import assert from 'node:assert/strict';
import { dialOrder, dialTimeoutMs, isAuthRefusal, isReachabilityFailure, loginErrorKey, loginFailure, pairKey, runRound, type DialPair, type RoundPick } from './dial-order.ts';

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

test('only the server SAYING no to the credentials is an auth refusal: its ERR_AUTH code AND a credential answer — a drop, a timeout, a protocol surprise and a frame-before-login race are not (board #393, #502)', async () => {
  const { authKindOf } = await import('../core/rpc-codes.ts');
  // What core/connection.ts rejects with when the server answers the login with ERR_AUTH:
  // the code, and the class read once from the server's sentence.
  const login = (m: string) => Object.assign(new Error(m), { code: -32000, authKind: authKindOf(m) });
  const coded = (message: string, code: number) => Object.assign(new Error(message), { code });
  for (const m of ['invalid proof', 'invalid token']) assert.equal(isAuthRefusal(login(m)), true, `-32000 "${m}"`);
  // The same code for a race or a malformed handshake is not a bad token (#502): the
  // server's `auth required…` answer to a frame sent before the login, its
  // `invalid client_nonce`, and anything it says that this client does not recognise.
  for (const m of ['auth required — send {"method":"auth","params":{"token":"..."}} first', 'invalid client_nonce', 'locked out', '']) {
    assert.equal(isAuthRefusal(login(m)), false, `-32000 "${m}"`);
  }
  // Not a refusal, and not a reachability failure either (#502 review P1-A): its own class.
  assert.equal(loginFailure(login('locked out')), 'login', 'an ERR_AUTH not recognised');
  assert.equal(loginFailure(login('auth required — send … first')), 'protocol', 'a frame-before-login race');
  assert.equal(loginFailure(login('invalid client_nonce')), 'protocol');
  for (const m of ['invalid token', 'invalid proof']) assert.equal(loginFailure(login(m)), null, `${m} is a refusal, not a login failure`);
  assert.equal(loginFailure(new Error('connection timeout')), null);
  for (const m of ['locked out', 'auth required — send … first', 'invalid client_nonce']) assert.equal(isReachabilityFailure(login(m)), false, `${m}: no cooldown`);
  // The one translation of a login error, by class (#502 review P2-D).
  assert.deepEqual(['invalid token', 'invalid proof', 'auth required — send … first', 'invalid client_nonce', 'locked out'].map((m) => loginErrorKey(login(m))),
    ['memberTokenRefused', 'memberProofRefused', 'memberLoginProtocol', 'memberLoginProtocol', 'memberLoginUnknown']);
  assert.equal(loginErrorKey(new Error('connection timeout')), null, 'not a login error: the caller s own words');
  assert.equal(loginErrorKey(coded('internal', -32603)), null);
  // The code with no class (anything that did not come through the login's entry) is not a refusal.
  assert.equal(isAuthRefusal(coded('invalid proof', -32000)), false, 'the code alone is not a refusal');
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
  assert.equal(isReachabilityFailure(login('invalid proof')), false);
});

test('authKindOf is the one table from the server’s ERR_AUTH sentences (connection.rs) to what they are about (#502)', async () => {
  const { authKindOf } = await import('../core/rpc-codes.ts');
  const { readFile } = await import('node:fs/promises');
  assert.equal(authKindOf('invalid token'), 'token');
  assert.equal(authKindOf('invalid proof'), 'proof');
  assert.equal(authKindOf('invalid client_nonce'), 'protocol');
  assert.equal(authKindOf('auth required — send {"method":"auth","params":{"token":"..."}} first'), 'protocol');
  for (const m of ['Invalid Token', 'invalid token ', 'something new', '', undefined, 42]) assert.equal(authKindOf(m), 'unknown', String(m));
  // Every ERR_AUTH sentence the server has is in the table: a new one fails here first.
  const rs = await readFile(new URL('../../../src-tauri/src/server/connection.rs', import.meta.url), 'utf8');
  const said = [...rs.matchAll(/Response::err\(req\.id, ERR_AUTH, "((?:[^"\\]|\\.)*)"/gu)].map((m) => (m[1] ?? '').replace(/\\"/gu, '"'));
  assert.ok(said.length >= 4, `found the server's ERR_AUTH sentences (${said.length})`);
  for (const m of said) assert.notEqual(authKindOf(m), 'unknown', `the server's "${m}" is classified`);
});

// ---- runRound (board #495): the one address round the switch and the reconnect machine walk ----
/** A round over a fixed list, each address answering as `answers` says. */
function fixedRound(addresses: string[], answers: Record<string, 'ok' | 'timeout' | 'auth' | 'protocol'>, over: Partial<Parameters<typeof runRound>[0]> = {}) {
  const log: string[] = [];
  const timeout = new Error('connection timeout');
  const auth = Object.assign(new Error('invalid proof'), { code: -32000, authKind: 'proof' });
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
