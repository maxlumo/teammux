import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueRef,
  paneRef,
  projectRef,
  refKey,
  reownRef,
  retargetRef,
  roomRef,
  sessionRef,
  type Ref,
} from './refs.ts';
import { retarget } from './nav-state.ts';

const A = 'srv-a';
const B = 'srv-b';

test('two servers with the same names are different objects', () => {
  // The whole reason refs exist: before #335 a name WAS the address, so these
  // pairs collided in every map the app keys by name.
  const pairs: [Ref, Ref][] = [
    [sessionRef(A, 'work'), sessionRef(B, 'work')],
    [paneRef(A, 'work', 'work:1.0'), paneRef(B, 'work', 'work:1.0')],
    [roomRef(A, 'proj:work'), roomRef(B, 'proj:work')],
    [issueRef(A, 'work', 3), issueRef(B, 'work', 3)],
    [projectRef(A, 'p1'), projectRef(B, 'p1')],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(refKey(a), refKey(b), `${a.kind} on two servers`);
  }
});

test('one object has one key, whatever route produced the ref', () => {
  assert.equal(refKey(sessionRef(A, 'work')), refKey(sessionRef(A, 'work')));
  // A pane is keyed by its tmux target alone: the target already names the
  // session, so keying on both would mint two keys for one pane.
  assert.equal(refKey(paneRef(A, 'work', 'work:1.0')), refKey(paneRef(A, 'work', 'work:1.0')));
});

test('kinds and separators cannot collide, because every part is user data', () => {
  // One map (an unread watermark table, a draft store, an `{#each}` key) may
  // hold refs of several kinds at once, and the same user string may name an
  // object of every kind: a project called `work`, its session, its room, a
  // pane. All four must stay apart, which is what the leading kind tag buys.
  const sameName = [
    refKey(sessionRef(A, 'work')),
    refKey(roomRef(A, 'work')),
    refKey(projectRef(A, 'work')),
    refKey(paneRef(A, 'other', 'work')),
  ];
  assert.equal(new Set(sameName).size, sameName.length, `one name, four objects: ${sameName.join(' ')}`);
  // A room may be called anything a human types, including a pane target.
  assert.notEqual(refKey(roomRef(A, 'work:1.0')), refKey(paneRef(A, 'work', 'work:1.0')));
  // A `a|b|c` key would make these two the same object.
  assert.notEqual(
    refKey(sessionRef(A, 'one|two')),
    refKey(sessionRef(A, 'one')) + '|two',
  );
  // `#3` of `a-b` is not `#3` of `a` in a session called `b`.
  assert.notEqual(refKey(issueRef(A, 'a-b', 3)), refKey(issueRef(A, 'a', 3)));
  assert.notEqual(refKey(issueRef(A, 'a', 3)), refKey(issueRef(A, 'a', 33)));
});

test('a composite key can never pass as a tmux target', () => {
  // If a key ever leaked into a `session`/`target` argument it must fail
  // loudly rather than address some real pane. Every key is a JSON array, and
  // a JSON array is not a `session:window.pane`.
  const keys = [
    refKey(sessionRef(A, 'work')),
    refKey(paneRef(A, 'work', 'work:1.0')),
    refKey(roomRef(A, 'proj:work')),
    refKey(issueRef(A, 'work', 3)),
    refKey(projectRef(A, 'p1')),
  ];
  for (const key of keys) {
    assert.ok(Array.isArray(JSON.parse(key)), `${key} is a tuple`);
    assert.match(key, /^\[/u, `${key} starts as JSON, not as a session name`);
  }
});

test('a rename moves only the refs of the server it happened on', () => {
  const rename = { serverId: A, from: 'old', to: 'new' };
  const mine = paneRef(A, 'old', 'old:1.0');
  const theirs = paneRef(B, 'old', 'old:1.0');
  assert.deepEqual(retargetRef(mine, rename), paneRef(A, 'new', 'new:1.0'));
  // B has its own session called `old` and it did not move.
  assert.equal(retargetRef(theirs, rename), theirs, 'the other server is untouched');
});

test('a rename follows the same prefix-exact rule a single server uses', () => {
  const rename = { serverId: A, from: 'old', to: 'new' };
  for (const target of ['old:1.0', 'old:12.3', 'older:1.0', 'other:1.0', '']) {
    const moved = retargetRef(paneRef(A, target.split(':')[0] ?? '', target), rename);
    assert.equal(moved.target, retarget(target, 'old', 'new'), `${target} follows nav-state`);
  }
  assert.deepEqual(
    retargetRef(sessionRef(A, 'old'), rename),
    sessionRef(A, 'new'),
  );
  assert.equal(
    retargetRef(sessionRef(A, 'older'), rename).session,
    'older',
    'a name that merely starts with the old one is a different session',
  );
  assert.deepEqual(retargetRef(issueRef(A, 'old', 3), rename), issueRef(A, 'new', 3));
});

test('a room and a project do not move when a session is renamed', () => {
  const rename = { serverId: A, from: 'old', to: 'new' };
  // The room is recorded on the project (schema v8) exactly so a rename cannot
  // orphan the chat, and `Project.id` is stable by construction.
  const room = roomRef(A, 'proj:old');
  const project = projectRef(A, 'p1');
  assert.equal(retargetRef(room, rename), room, 'the conversation stays where it is');
  assert.equal(retargetRef(project, rename), project, 'an id survives every rename');
});

test('nothing to do returns the very same object', () => {
  // Identity, not just equality: a caller holding it in `$state` must not see
  // a change, and `next !== ref` is how a caller detects a real move.
  const ref = paneRef(A, 'work', 'work:1.0');
  const noops = [
    { serverId: A, from: '', to: 'new' },
    { serverId: A, from: 'old', to: '' },
    { serverId: A, from: 'same', to: 'same' },
    { serverId: B, from: 'work', to: 'new' },
    { serverId: A, from: 'nobody', to: 'new' },
    { serverId: '', from: 'work', to: 'new' },
  ];
  for (const rename of noops) {
    assert.equal(retargetRef(ref, rename), ref, JSON.stringify(rename));
  }
});

test('a ref whose server was absorbed names the survivor', () => {
  // Identity repair folds a machine's twin entries into one and DELETES the
  // absorbed entry. A ref left naming the deleted entry is filtered out of its
  // own server's restore — the navigation of the very machine the app is
  // connected to (reviewer P1, 2026-10-10). Only the server moves: the object
  // is the same pane on the same machine.
  const survivorOf = (id: string) => (id === A ? B : id === B ? B : '');
  assert.deepEqual(reownRef(paneRef(A, 'work', 'work:1.0'), survivorOf), paneRef(B, 'work', 'work:1.0'));
  assert.deepEqual(reownRef(sessionRef(A, 'work'), survivorOf), sessionRef(B, 'work'));
  assert.deepEqual(reownRef(issueRef(A, 'work', 3), survivorOf), issueRef(B, 'work', 3));
  assert.deepEqual(reownRef(roomRef(A, 'proj:work'), survivorOf), roomRef(B, 'proj:work'));
  assert.deepEqual(reownRef(projectRef(A, 'p1'), survivorOf), projectRef(B, 'p1'));
});

test('a ref nothing shows to be merged is the very same object', () => {
  // A saved server is itself, and an id the identity layer cannot explain —
  // forgotten, or never saved — is NOT re-pointed at anyone (reviewer P1-a,
  // 2026-10-10): absence is not evidence of a merge, and moving it to the
  // current server would open that server's same-named pane.
  const survivorOf = (id: string) => (id === B ? B : '');
  for (const ref of [paneRef(B, 'work', 'work:1.0'), paneRef('srv-c', 'work', 'work:1.0'), projectRef(A, 'p1')] as const) {
    assert.equal(reownRef(ref, survivorOf), ref, refKey(ref));
  }
});
