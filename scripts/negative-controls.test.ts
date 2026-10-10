// The negative-control runner's own guarantees, in a throwaway git repository:
// it reports which breaks the tests catch, and it leaves the tree exactly as
// committed — the property an earlier version once failed (it committed a
// mutated file; see the module header).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { negativeControls } from './negative-controls.mjs';

async function repo(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-nc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'nc@test'); git('config', 'user.name', 'nc');
  await writeFile(join(dir, 'lib.mjs'), 'export const add = (a, b) => a + b;\nexport const name = "lib";\n');
  // One test guards `add`; nothing guards `name`.
  await writeFile(join(dir, 'lib.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './lib.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  git('add', '.'); git('commit', '-q', '-m', 'base');
  return { dir, git };
}

test('a guarded break bites, an unguarded one does not, and the file is restored', async (t) => {
  const { dir } = await repo(t);
  const original = await readFile(join(dir, 'lib.mjs'), 'utf8');
  const lines = await negativeControls({
    cwd: dir, log: () => {},
    files: ['lib.mjs'], tests: ['lib.test.mjs'],
    cases: [
      ['lib.mjs', 'add subtracts', 'a + b', 'a - b'],
      ['lib.mjs', 'name changes', '"lib"', '"other"'],
      ['lib.mjs', 'anchor gone', 'nothing like this', 'x'],
    ],
  });
  assert.match(lines[0]!, /^BITES  add subtracts\n {7}not ok 1 - adds/u);
  assert.equal(lines[1], '*** NO BITE *** name changes', 'an unguarded break is the finding');
  assert.equal(lines[2], 'SKIP (anchor missing) anchor gone');
  assert.equal(lines.at(-1), 'tree restored, matches HEAD');
  assert.equal(await readFile(join(dir, 'lib.mjs'), 'utf8'), original);
});

test('a prelude adds what one broken version needs', async (t) => {
  const { dir } = await repo(t);
  const lines = await negativeControls({
    cwd: dir, log: () => {},
    files: ['lib.mjs'], tests: ['lib.test.mjs'],
    cases: [['lib.mjs', 'add uses a helper', 'a + b', 'twice(a)']],
    prelude: { 'lib.mjs': [['add uses a helper', 'export const add', 'const twice = (x) => x * 2;\nexport const add']] },
  });
  assert.match(lines[0]!, /^BITES  add uses a helper/u, 'twice(2) is 4, not 5');
});

test('it refuses to start on a dirty file, and leaves it alone', async (t) => {
  // Otherwise a crash's leftovers would be taken for the baseline.
  const { dir } = await repo(t);
  await writeFile(join(dir, 'lib.mjs'), 'export const add = () => 0;\n');
  const before = process.exitCode;
  try {
    const lines = await negativeControls({
      cwd: dir, log: () => {},
      files: ['lib.mjs'], tests: ['lib.test.mjs'],
      cases: [['lib.mjs', 'x', 'add', 'sub']],
    });
    assert.match(lines[0]!, /^refusing to run/u);
    assert.equal(process.exitCode, 1);
    assert.equal(await readFile(join(dir, 'lib.mjs'), 'utf8'), 'export const add = () => 0;\n', 'the work in progress is untouched');
  } finally { process.exitCode = before; }
});
