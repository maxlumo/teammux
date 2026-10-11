// Source-contract tests for DirPicker.svelte (see docs/conventions/testing.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const source = await readFile(new URL('./DirPicker.svelte', import.meta.url), 'utf8');

async function walk(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p.pathname);
  }
  return out;
}

test('there is ONE directory picker (rule 6: one mechanism per UI job)', async () => {
  // files/DirPicker.svelte and team/DirPicker.svelte were two implementations
  // of one job with different props (onpick/oncancel vs onPick/onNavigate/
  // onClose) and split behaviour — the race guard lived in one, the new-folder
  // affordance in the other (review, 2026-09-03).
  const files = await walk(new URL('../', import.meta.url));
  const pickers = files.filter(f => /\/DirPicker\.svelte$/u.test(f));
  assert.equal(pickers.length, 1, `one DirPicker.svelte under src/lib, found: ${pickers.join(', ')}`);
  assert.match(pickers[0]!, /\/files\/DirPicker\.svelte$/u, 'it lives with the file browser whose fs_list it reuses');
});

test('the newest tap wins — a slow earlier listing never overwrites a later one', () => {
  // The list stays on screen mid-load (no blank-then-repaint) and stays
  // tappable, so two answers can be in flight; `seq` discards the stale one.
  const body = /async function open\(path: string\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(body, 'open must exist');
  assert.match(body, /const my = \+\+seq;/u);
  assert.match(body, /const r = await fsList\(path, false\);\s*if \(my !== seq\) return;/u, 'the success path checks seq first');
  assert.match(body, /catch \(e\) \{\s*if \(my !== seq\) return;/u, 'the failure path checks seq first');
  assert.doesNotMatch(body, /dirs = \[\];/u, 'the current list is never cleared before the answer');
});

test('the picker can create the folder it is about to pick, and the caller can track browsing', () => {
  // The Team workspace field needed both (its own picker had them); a project
  // that does not exist yet is the common case for "new".
  // Both from this subtree's server (board #335 ②b), not the facade.
  assert.match(source, /const \{ fsList, fsMkdir \} = useServerApi\(\);/u);
  assert.match(source, /await fsMkdir\(dir\);[\s\S]{0,200}?await open\(dir\);/u, 'a created folder becomes the selection');
  assert.match(source, /onnavigate\?\.\(cwd\);/u, 'every browse step is reported');
  // One prop dialect, lowercase like DOM events, for every caller.
  assert.match(source, /onpick\?: \(path: string\) => void;/u);
  assert.match(source, /oncancel\?: \(\) => void;/u);
  assert.match(source, /onnavigate\?: \(path: string\) => void;/u);
  assert.doesNotMatch(source, /onPick|onClose|onNavigate/u, 'no second (camelCase) dialect');
});

test('the unfold plays for the FIRST answer only, then the class drops (board #93)', () => {
  // The rows are keyed by path, so a hop remounts them all — remounting under
  // a lingering `.reveal` blanked every row behind rise-in's backwards fill
  // and flashed the list. Keep-and-swap is this picker's own rule; the unfold
  // is for the answer that had no predecessor.
  assert.match(source, /if \(!ready\) \{\s*\n\s*reveal = true;\s*\n\s*revealTimer = setTimeout\(\(\) => \{ reveal = false; \}, revealMs\(\)\);\s*\n\s*\}/u,
    'one-shot reveal, dropped after the stagger');
  assert.match(source, /class:busy class:reveal bind:this=\{listEl\}/u, 'the list wears the transient flag, not ready');
});
