import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnedToken } from './owned-token.ts';

// Board #150 (leader note 19): #144's token core, shared. Its table, literal.
test('a newer operation retires the older one for good', () => {
  const ops = new OwnedToken();
  const a = ops.begin('on|p'), b = ops.begin('on|p');
  assert.deepEqual([ops.live(a), ops.live(b)], [false, true]);
});

test('the owner becoming another retires; away and back stays dead', () => {
  const ops = new OwnedToken();
  const t = ops.begin('on|p');
  assert.equal(ops.own('off|p'), true, 'away: retired');
  assert.equal(ops.own('on|p'), true, 'back: a change again, nothing revives');
  assert.equal(ops.live(t), false);
});

test('a change TO the owner a token was minted for never retires it, in either order', () => {
  const first = new OwnedToken();
  first.own('on|old');
  const t1 = first.begin('on|new');      // minted for the new owner before the host says so
  assert.equal(first.own('on|new'), false);
  assert.equal(first.live(t1), true);
  const second = new OwnedToken();
  second.own('on|new');                  // the host says so first
  const t2 = second.begin('on|new');
  assert.equal(second.own('on|new'), false);
  assert.equal(second.live(t2), true);
  const mount = new OwnedToken();
  const t3 = mount.begin('on|p');        // an open at mount, before the owner effect's first run
  assert.equal(mount.own('on|p'), false);
  assert.equal(mount.live(t3), true);
});

test('retire ends whatever is pending (the host\u2019s end)', () => {
  const ops = new OwnedToken();
  const t = ops.begin('on|p');
  ops.retire();
  assert.equal(ops.live(t), false);
});
