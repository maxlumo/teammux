import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Board #111 (leader note 20): the app's ONE popstate router swallows the app's
// own history.back() (a preview link's entry) before anything else it does,
// and the preview's link watcher is the only caller of markOwnBack.
test('the popstate router asks takeOwnBack first; only the link watcher marks', async () => {
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /const handler = \(e\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*\/\/ The app's OWN history\.back\(\)[^\n]*\n\s*if \(takeOwnBack\(\)\) return;/u);
  assert.equal(app.match(/takeOwnBack\(\)/gu)?.length, 1);
  const preview = await readFile(new URL('../files/file-preview.ts', import.meta.url), 'utf8');
  assert.equal(preview.match(/markOwnBack\(/gu)?.length, 1, 'one marker');
  assert.match(preview, /markOwnBack\(pending\.until\);\n\s*hist\.back\(\);/u, 'marked right before the back');
});
