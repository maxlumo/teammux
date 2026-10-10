// Every leave guard names its owner (board #335 ②b-2-3): the runtime handle
// whose subtree holds it, read from the scope at init, or null outside one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

test('every registered guard names the runtime that owns it', async () => {
  let n = 0;
  for await (const file of glob('src/**/*.svelte')) {
    if (/\.test\.[a-z]+\.svelte$/u.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/registerLeaveGuard\(\{\s*([^,]+),/gu)) {
      n++;
      assert.match(m[1]!, /^runtime: (?:scope\.runtime|guardOwner)$/u, `${file}: a guard registered without its owner`);
    }
  }
  assert.equal(n, 3, 'Files, Board and the Agents editor');
});
