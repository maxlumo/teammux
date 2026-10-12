import test from 'node:test';
import assert from 'node:assert/strict';
import { serverTag, tagsShown } from './server-tag.ts';

const two = { included: [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }] };
const one = { included: [{ id: 'a', name: 'alpha' }] };

test('the tag shows only with more than one included server — the source set, not health (②a ruling)', () => {
  assert.equal(tagsShown(one), false, 'Single, or Aggregate with one included: no tag');
  assert.equal(tagsShown(two), true);
  assert.equal(serverTag(one, 'a'), null, 'one server: nothing is named');
  assert.equal(serverTag(two, 'a'), 'alpha');
  assert.equal(serverTag(two, 'b'), 'beta');
});

test('a ref from a server that is not included is still named, by its id — an unnamed foreign row is the ambiguity the tag removes', () => {
  assert.equal(serverTag(two, 'zzz'), 'zzz');
  assert.equal(serverTag(two, null), null);
  assert.equal(serverTag(two, ''), null);
});
