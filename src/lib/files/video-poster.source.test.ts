// Board #139 (owner, 2026-11-16 09:09: '点击播放按钮的时候，会出现一个很丑的大大的播放器播放按键图案在图片中间。
// 另外所有的你都检查一下，避免出现类似图案'): a <video> with no poster attribute shows Android WebView's
// stock poster (the big circled play glyph) until it has a frame (#470). Every <video> the app
// renders carries the ONE transparent poster in the Android app: poster={posterFor(isAndroid)}.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLANK_POSTER, posterFor } from './media-player.ts';

const src = fileURLToPath(new URL('../../', import.meta.url));

async function svelteFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await svelteFiles(p));
    else if (e.name.endsWith('.svelte') && !e.name.endsWith('.test.svelte')) out.push(p);
  }
  return out;
}

test('every <video> in src carries poster={posterFor(isAndroid)}', async () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of await svelteFiles(src)) {
    // The markup only: no script or style block, no HTML comment (a <video> named in prose is not one).
    const text = (await readFile(file, 'utf8')).replace(/<script\b[^>]*>[^]*?<\/script>|<style\b[^>]*>[^]*?<\/style>|<!--[^]*?-->/gu, '');
    // The whole element, to its close (an attribute's arrow function holds a '>').
    for (const m of text.matchAll(/<video\b[^]*?(?:<\/video>|\/>)/gu)) {
      seen++;
      if (!/\sposter=\{posterFor\(isAndroid\)\}/u.test(m[0])) offenders.push(`${file.slice(src.length)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.ok(seen >= 3, `MediaPlayer, MotionLive and ScanDialog at least (saw ${seen})`);
  assert.deepEqual(offenders, []);
});

test('the one poster: transparent in the Android app, none elsewhere (a desktop keeps its first-frame preview)', () => {
  assert.equal(posterFor(true), BLANK_POSTER);
  assert.equal(posterFor(false), undefined);
});
