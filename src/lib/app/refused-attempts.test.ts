// Board #458: the attempts a server refused the token for — scoped to the
// (address, token) pair an attempt sent, kept as SHA-256 digests; a pending
// comparison and an unknowable one both fail closed, and neither is "no refusal".
import test from 'node:test';
import assert from 'node:assert/strict';
import { asideKey, createRefusedAttempts, REFUSED_ASIDE_KEY } from './refused-attempts.ts';

const sha256 = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
// Web Crypto answers on the real event loop; under a loaded test run one turn of 20 ms is not always enough.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20)); };
const quiet = { failed: () => {}, ready: () => {} };

test('a refusal is of the pair it was sent as: another address with the same token, or another token, is another attempt', () => {
  const r = createRefusedAttempts({ read: () => null, write: () => {}, ...quiet });
  r.add('b', 'ws://wrong:1', 'T');
  assert.equal(r.check('b', 'ws://wrong:1', 'T'), 'refused');
  assert.equal(r.check('b', 'ws://right:1', 'T'), 'ok', 'a misrouted address saying no does not block the right one');
  assert.equal(r.check('b', 'ws://wrong:1', 'T2'), 'ok');
  assert.equal(r.check('c', 'ws://wrong:1', 'T'), 'ok', 'per server');
});

test('stored as SHA-256 digests; a fresh page holds the pair PENDING until compared, then asks again — a match is a refusal', async () => {
  let text: string | null = null;
  let ready = 0;
  const make = () => createRefusedAttempts({ read: () => text, write: (t) => { text = t; }, failed: () => { throw new Error('no'); }, ready: () => { ready++; }, digest: sha256 });
  make().add('b', 'ws://b:1', 'T');
  await settle();
  assert.deepEqual(JSON.parse(text!), { b: [await sha256('ws://b:1\u0000T')] }, 'the standard digest of the pair, nothing else');
  const fresh = make();
  assert.equal(fresh.check('b', 'ws://b:1', 'T'), 'pending', 'not compared yet: nothing dials, a pick included');
  await settle();
  assert.equal(ready, 1, 'the caller is asked again');
  assert.equal(fresh.check('b', 'ws://b:1', 'T'), 'refused');
  assert.equal(fresh.check('b', 'ws://b:1', 'T2'), 'pending', 'another pair: pending until its own digest is ready');
  await settle();
  assert.equal(fresh.check('b', 'ws://b:1', 'T2'), 'ok');
  assert.equal(make().check('c', 'ws://c:1', 'T'), 'ok', 'a server with nothing stored is not held');
});

test('an unreadable store (junk, or digests of the wrong shape) is RESET once: moved aside, emptied, reported — and every pair is ok, as on a fresh device (#458 validator V4; ruling)', async () => {
  for (const junk of ['{broken', '[]', '{"b":"x"}', '{"b":[1]}', '{"b":["garbage"]}', `{"b":["${'a'.repeat(63)}"]}`]) {
    let disk: string | null = junk;
    let aside: string | null = null;
    let resets = 0;
    const r = createRefusedAttempts({ read: () => disk, write: (t) => { disk = t; }, aside: (t) => { aside = t; }, reset: () => { resets++; }, ...quiet, digest: sha256 });
    assert.equal(r.check('b', 'ws://b:1', 'T'), 'ok', `${junk}: a corruption is not a refusal`);
    assert.equal(r.check('x', 'ws://x:1', 'T'), 'ok', 'nor for a server it never named');
    await settle();
    assert.equal(aside, junk, 'the junk is kept aside, never deleted');
    assert.equal(disk, null, 'the store is emptied');
    assert.equal(resets, 1, 'and the reset is reported, once');
    // A refusal after the reset re-records on its first answer.
    r.add('b', 'ws://b:1', 'T');
    await settle();
    assert.equal(r.check('b', 'ws://b:1', 'T'), 'refused');
    const reload = createRefusedAttempts({ read: () => disk, write: () => {}, ...quiet, digest: sha256 });
    reload.check('b', 'ws://b:1', 'T');
    await settle();
    assert.equal(reload.check('b', 'ws://b:1', 'T'), 'refused', 'and is kept across a reload');
  }
});

test('an unreadable value that cannot be moved aside is left in place and never written over; the page starts empty and the failure is reported', async () => {
  let writes = 0;
  let failed = 0;
  let resets = 0;
  const r = createRefusedAttempts({ read: () => '{broken', write: () => { writes++; }, aside: () => { throw new Error('QuotaExceededError'); }, reset: () => { resets++; }, failed: () => { failed++; }, ready: () => {}, digest: sha256 });
  assert.equal(r.check('b', 'ws://b:1', 'T'), 'ok', 'members dial all the same');
  r.add('b', 'ws://b:1', 'T2');
  await settle();
  assert.equal(writes, 0, 'the unreadable value is not written over');
  assert.equal(failed, 1, 'the storage error handling is told');
  assert.equal(resets, 0, 'and it was not reset');
  assert.equal(r.check('b', 'ws://b:1', 'T2'), 'refused', 'the page knows its own refusal');
  let threw = 0;
  const unreadableRead = createRefusedAttempts({ read: () => { throw new Error('SecurityError'); }, write: () => { writes++; }, failed: () => { threw++; }, ready: () => {}, digest: sha256 });
  assert.equal(unreadableRead.check('b', 'ws://b:1', 'T'), 'ok');
  unreadableRead.add('b', 'ws://b:1', 'T');
  await settle();
  assert.equal(threw, 1, 'a read that throws is a storage failure');
  assert.equal(writes, 0, 'and nothing is written over what could not be read');
});

test('a write that fails is reported; without Web Crypto the fact is this page s and a stored one unknown — only for the server it names', async () => {
  let failed = 0;
  const broken = createRefusedAttempts({ read: () => null, write: () => { throw new Error('QuotaExceededError'); }, failed: () => { failed++; }, ready: () => {}, digest: sha256 });
  broken.add('b', 'ws://b:1', 'T');
  await settle();
  assert.equal(failed, 1);
  assert.equal(broken.check('b', 'ws://b:1', 'T'), 'refused');
  const noCrypto = createRefusedAttempts({ read: () => JSON.stringify({ b: ['ab'.repeat(32)] }), write: () => { throw new Error('unexpected'); }, ...quiet });
  assert.equal(noCrypto.check('b', 'ws://b:1', 'T'), 'unknown', 'a stored fact it cannot compare');
  assert.equal(noCrypto.check('x', 'ws://x:1', 'T'), 'ok', 'a server the stored fact does not name is dialled');
  noCrypto.add('c', 'ws://c:1', 'T');
  assert.equal(noCrypto.check('c', 'ws://c:1', 'T'), 'refused', 'kept in memory, not written');
});

test('an emptying that fails after the value is kept aside is a storage failure, never reported as reset (#458 review P2 on c23e9a7a)', async () => {
  let aside: string | null = null;
  let failed = 0;
  let resets = 0;
  const r = createRefusedAttempts({ read: () => '{broken', write: () => { throw new Error('QuotaExceededError'); }, aside: (t) => { aside = t; }, reset: () => { resets++; }, failed: () => { failed++; }, ready: () => {}, digest: sha256 });
  assert.equal(r.check('b', 'ws://b:1', 'T'), 'ok', 'members dial all the same');
  await settle();
  assert.equal(aside, '{broken', 'kept aside');
  assert.equal(failed, 1, 'the failed emptying goes to the storage error handling');
  assert.equal(resets, 0, 'and nothing says it was reset');
});

test('a later corruption is kept under the next free key, never over one kept before (#458 validator P2 on c23e9a7a)', () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null };
  assert.equal(asideKey(storage), REFUSED_ASIDE_KEY);
  m.set(asideKey(storage), 'first');
  assert.equal(asideKey(storage), `${REFUSED_ASIDE_KEY}.2`);
  m.set(asideKey(storage), 'second');
  assert.equal(asideKey(storage), `${REFUSED_ASIDE_KEY}.3`);
  assert.equal(m.get(REFUSED_ASIDE_KEY), 'first');
  assert.equal(m.get(`${REFUSED_ASIDE_KEY}.2`), 'second');
});
