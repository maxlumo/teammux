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

// ---- board #502: a login that succeeded with a pair clears its refusal ----

test('#502: clear drops the pair from this page at once and from the device once its digest is known; another pair and another server keep theirs', async () => {
  const writes: Array<string | null> = [];
  const r = createRefusedAttempts({ read: () => null, write: (t) => { writes.push(t); }, digest: sha256, ...quiet });
  r.add('b', 'ws://b1', 't');
  r.add('b', 'ws://b2', 't');
  r.add('c', 'ws://c', 't');
  await settle();
  assert.equal(r.check('b', 'ws://b1', 't'), 'refused');
  r.clear('b', 'ws://b1', 't');
  assert.equal(r.check('b', 'ws://b1', 't'), 'ok', 'the page is clear before any digest returns');
  assert.equal(r.check('b', 'ws://b2', 't'), 'refused', 'the sibling pair keeps its refusal');
  await settle();
  const last = JSON.parse(writes.at(-1)!);
  assert.deepEqual(last, { b: [await sha256('ws://b2\u0000t')], c: [await sha256('ws://c\u0000t')] }, 'the device keeps everything else');
  // A reload reads the device: the cleared pair is ok, the others are not.
  const reloaded = createRefusedAttempts({ read: () => writes.at(-1)!, write: () => {}, digest: sha256, ...quiet });
  assert.equal(reloaded.check('b', 'ws://b1', 't'), 'pending');
  reloaded.check('b', 'ws://b2', 't');
  await settle();
  assert.equal(reloaded.check('b', 'ws://b1', 't'), 'ok');
  assert.equal(reloaded.check('b', 'ws://b2', 't'), 'refused');
});

test('#502: a stored refusal read back from the device is cleared too, and an empty store is removed', async () => {
  const stored = JSON.stringify({ b: [await sha256('ws://b\u0000t')] });
  const writes: Array<string | null> = [];
  const r = createRefusedAttempts({ read: () => stored, write: (t) => { writes.push(t); }, digest: sha256, ...quiet });
  r.check('b', 'ws://b', 't');
  await settle();
  assert.equal(r.check('b', 'ws://b', 't'), 'refused');
  r.clear('b', 'ws://b', 't');
  assert.equal(r.check('b', 'ws://b', 't'), 'ok');
  await settle();
  assert.deepEqual(writes, [null], 'one write: the store is empty, so it goes');
  // Negative control: a clear of a pair the device does not hold writes nothing.
  r.clear('b', 'ws://other', 't');
  await settle();
  assert.deepEqual(writes, [null]);
});

test('#502 races: a late digest can neither put back a cleared refusal nor take out a newer one', async () => {
  // Digests answer only when released, in the order the test chooses.
  const held: Array<() => void> = [];
  const slow = (text: string) => new Promise<string>((resolve) => { held.push(() => { void sha256(text).then(resolve); }); });
  const writes: Array<string | null> = [];
  const r = createRefusedAttempts({ read: () => null, write: (t) => { writes.push(t); }, digest: slow, ...quiet });
  // add → clear, the add's digest released AFTER the clear: nothing is stored.
  r.add('b', 'ws://b', 't');
  r.clear('b', 'ws://b', 't');
  assert.equal(r.check('b', 'ws://b', 't'), 'ok');
  for (const release of held.splice(0)) release();
  await settle();
  assert.deepEqual(writes, [], 'the late add wrote nothing: the clear is newer');
  assert.equal(r.check('b', 'ws://b', 't'), 'ok');
  // Stored, then clear → add again, the clear's digest released AFTER the re-add's: refused stays.
  r.add('b', 'ws://b', 't');
  for (const release of held.splice(0)) release();
  await settle();
  assert.equal(writes.length, 1, 'the refusal is stored');
  r.clear('b', 'ws://b', 't');
  const clearDigest = held.splice(0);
  r.add('b', 'ws://b', 't');
  assert.equal(r.check('b', 'ws://b', 't'), 'refused', 'refused again on this page');
  for (const release of held.splice(0)) release();
  await settle();
  for (const release of clearDigest) release();
  await settle();
  assert.deepEqual(JSON.parse(writes.at(-1)!), { b: [await sha256('ws://b\u0000t')] }, 'the late clear did not take out the newer refusal');
  assert.equal(r.check('b', 'ws://b', 't'), 'refused');
});

test('#502: without Web Crypto, or with a store pinned by an unreadable value, a clear is this page s only — the device is not written', async () => {
  const writes: Array<string | null> = [];
  const plain = createRefusedAttempts({ read: () => JSON.stringify({ b: ['a'.repeat(64)] }), write: (t) => { writes.push(t); }, ...quiet });
  assert.equal(plain.check('b', 'ws://b', 't'), 'unknown');
  plain.clear('b', 'ws://b', 't');
  assert.equal(plain.check('b', 'ws://b', 't'), 'ok', 'the pair that logged in is ok on this page');
  await settle();
  assert.equal(writes.length, 0, 'the stored fact that cannot be compared stays');
  const pinned = createRefusedAttempts({ read: () => 'junk', write: (t) => { writes.push(t); }, digest: sha256, ...quiet });
  pinned.add('b', 'ws://b', 't');
  pinned.clear('b', 'ws://b', 't');
  await settle();
  assert.equal(writes.length, 0, 'the unreadable value is never written over');
});

/** Digests that answer only when the test says, resolve or reject, in its order. */
function heldDigests() {
  const held: Array<{ text: string; ok: () => void; fail: () => void }> = [];
  const digest = (text: string) => new Promise<string>((resolve, reject) => {
    held.push({ text, ok: () => { void sha256(text).then(resolve); }, fail: () => reject(new Error('digest failed')) });
  });
  return { digest, take: () => held.splice(0), held };
}

test('#502 review P1-B: add → clear → the add s digest REJECTS: the superseded add reports no failure, and the clear stands', async () => {
  const d = heldDigests();
  let failed = 0;
  const writes: Array<string | null> = [];
  const r = createRefusedAttempts({ read: () => null, write: (t) => { writes.push(t); }, digest: d.digest, failed: () => { failed++; }, ready: () => {} });
  r.add('b', 'ws://b', 't');
  const addDigest = d.take();
  r.clear('b', 'ws://b', 't');
  for (const x of addDigest) x.fail();
  await settle();
  assert.equal(failed, 0, 'no failure from an operation a newer one superseded');
  assert.equal(r.check('b', 'ws://b', 't'), 'ok');
  assert.equal(writes.length, 0);
  // Negative control: the same reject while the add IS the latest is reported.
  r.add('b', 'ws://b2', 't');
  for (const x of d.take()) x.fail();
  await settle();
  assert.equal(failed, 1, 'the latest operation s own failure still reaches the storage handling');
});

test('#502 review P1-B: a check s digest that rejects late, interleaved with a newer add or clear, changes neither fact and reports no failure', async () => {
  const stored = JSON.stringify({ b: [await sha256('ws://b\u0000t')] });
  for (const newer of ['clear', 'add'] as const) {
    const d = heldDigests();
    let failed = 0;
    const r = createRefusedAttempts({ read: () => stored, write: () => {}, digest: d.digest, failed: () => { failed++; }, ready: () => {} });
    assert.equal(r.check('b', 'ws://b', 't'), 'pending', 'the comparison is out');
    const checkDigest = d.take();
    if (newer === 'clear') r.clear('b', 'ws://b', 't'); else r.add('b', 'ws://b', 't');
    for (const x of checkDigest) x.fail();
    await settle();
    assert.equal(r.check('b', 'ws://b', 't'), newer === 'clear' ? 'ok' : 'refused', `${newer}: the newer fact stands`);
    assert.equal(failed, 0, `${newer}: a check s comparison never reports a failure`);
  }
});

test('#502: a clear whose write fails is reported, the page stays clear, and a reopened page reads the real old record; a clear whose digest rejects keeps the old record silently', async () => {
  const stored = JSON.stringify({ b: [await sha256('ws://b\u0000t')] });
  // The write fails.
  let failed = 0;
  const w = createRefusedAttempts({ read: () => stored, write: () => { throw new Error('QuotaExceededError'); }, digest: sha256, failed: () => { failed++; }, ready: () => {} });
  w.clear('b', 'ws://b', 't');
  assert.equal(w.check('b', 'ws://b', 't'), 'ok');
  await settle();
  assert.equal(failed, 1, 'the write failure reaches the storage handling');
  assert.equal(w.check('b', 'ws://b', 't'), 'ok', 'this page logged in with it');
  const reopened = createRefusedAttempts({ read: () => stored, write: () => {}, digest: sha256, ...quiet });
  reopened.check('b', 'ws://b', 't');
  await settle();
  assert.equal(reopened.check('b', 'ws://b', 't'), 'refused', 'nothing claims the clear was saved');
  // The clear's digest rejects.
  const d = heldDigests();
  let failed2 = 0;
  const writes: Array<string | null> = [];
  const g = createRefusedAttempts({ read: () => stored, write: (t) => { writes.push(t); }, digest: d.digest, failed: () => { failed2++; }, ready: () => {} });
  g.clear('b', 'ws://b', 't');
  for (const x of d.take()) x.fail();
  await settle();
  assert.equal(g.check('b', 'ws://b', 't'), 'ok');
  assert.equal(failed2, 0);
  assert.equal(writes.length, 0, 'the device keeps its old fact');
});
