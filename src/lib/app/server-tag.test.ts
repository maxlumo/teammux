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

// #366: the Files door's short label.
test('shortServerTag: the first word, at most 8 characters; null exactly when the tag is', async () => {
  const { shortServerTag, SHORT_TAG_MAX } = await import('./server-tag.ts');
  assert.equal(SHORT_TAG_MAX, 8);
  const scope = { included: [
    { id: 'a', name: 'devbox' }, { id: 'b', name: 'macmini' }, { id: 'c', name: 'dev-dsk-cfu-2a.ap-northeast-1' },
    { id: 'd', name: 'workstation' }, { id: 'e', name: 'build server' },
  ] };
  assert.equal(shortServerTag(scope, 'a'), 'devbox', 'short names stay whole (the owner s two)');
  assert.equal(shortServerTag(scope, 'b'), 'macmini');
  assert.equal(shortServerTag(scope, 'c'), 'dev', 'the first word of a long host name');
  assert.equal(shortServerTag(scope, 'd'), 'workstat', 'one long word: its first 8 letters');
  assert.equal(shortServerTag(scope, 'e'), 'build', 'space splits too');
  assert.equal(shortServerTag({ included: [{ id: 'a', name: 'devbox' }] }, 'a'), null, 'one server included: no tag, no door');
  assert.equal(shortServerTag(scope, null), null);
});

test('shortServerTag: two servers whose short forms collide are both named in full', async () => {
  const { shortServerTag } = await import('./server-tag.ts');
  const scope = { included: [{ id: 'a', name: 'dev-dsk-one' }, { id: 'b', name: 'dev-dsk-two' }, { id: 'c', name: 'mac' }] };
  assert.equal(shortServerTag(scope, 'a'), 'dev-dsk-one');
  assert.equal(shortServerTag(scope, 'b'), 'dev-dsk-two');
  assert.equal(shortServerTag(scope, 'c'), 'mac');
});
