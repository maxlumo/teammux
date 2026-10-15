import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// An Icon whose name has no branch in Icon.svelte renders an EMPTY <svg>: no
// error, no warning, just a blank square where the glyph should be. That is
// how the team rows of the "Start a team" picker (and the empty room's team
// list) shipped with `collab`, a name that was never drawn: a tinted box with
// nothing in it (board #341, the owner's screenshot). A typo cannot be seen in
// a diff, so the whole class is pinned: every STATIC icon name the app asks
// for exists.
const root = fileURLToPath(new URL('../../', import.meta.url));
const iconSource = await readFile(new URL('./Icon.svelte', import.meta.url), 'utf8');
const defined = new Set([...iconSource.matchAll(/name === '([a-z0-9-]+)'/gu)].map((m) => m[1]!));

async function svelteFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await svelteFiles(path));
    else if (entry.name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

test('every static icon name in the app is drawn by Icon.svelte (board #341)', async () => {
  assert.ok(defined.size > 50 && defined.has('bots') && defined.has('check'), 'the atom\u2019s names were read');
  const missing: string[] = [];
  for (const file of await svelteFiles(root)) {
    const source = await readFile(file, 'utf8');
    for (const m of source.matchAll(/<Icon\b[^>]*?\bname="([a-z0-9-]+)"/gu)) {
      if (!defined.has(m[1]!)) missing.push(`${file.slice(root.length)}: <Icon name="${m[1]}">`);
    }
    for (const m of source.matchAll(/<CommandButton\b[^>]*?\bicon="([a-z0-9-]+)"/gsu)) {
      if (!defined.has(m[1]!)) missing.push(`${file.slice(root.length)}: <CommandButton icon="${m[1]}">`);
    }
  }
  assert.deepEqual(missing, [], 'a name with no branch renders a blank glyph');
});
