// Board #133: the info card's Type line names a Motion Photo and its video's size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { typeLine } from './file-preview.ts';

const size = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const words = { en: 'Motion Photo ({size} video)', zh: '动态照片（视频 {size}）' };

test('a Motion Photo\'s type line names it with its video size; any other file is its MIME type', () => {
  const motion = { mime_hint: 'image/jpeg', motion: { offset: 401655, length: 2093316 } };
  assert.equal(typeLine(motion, size, words.en), 'image/jpeg · Motion Photo (2.0 MB video)');
  assert.equal(typeLine(motion, size, words.zh), 'image/jpeg · 动态照片（视频 2.0 MB）');
  assert.equal(typeLine({ mime_hint: 'image/jpeg' }, size, words.en), 'image/jpeg');
  assert.equal(typeLine({ mime_hint: 'image/jpeg', motion: null }, size, words.en), 'image/jpeg');
});
