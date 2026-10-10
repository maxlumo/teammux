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
  assert.equal(lines.at(-1), 'tree restored: the whole worktree is as it was before the run');
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

test('a break that stops a file loading is BROKE BUILD, never BITES', async (t) => {
  // validator P2, 2026-10-10: a syntax error fails every test in the file,
  // which looks exactly like a guard noticing — and proves nothing.
  const { dir } = await repo(t);
  const lines = await negativeControls({
    cwd: dir, log: () => {},
    files: ['lib.mjs'], tests: ['lib.test.mjs'],
    cases: [['lib.mjs', 'syntax error', 'a + b', 'a +* b']],
  });
  assert.match(lines[0]!, /^\*\*\* BROKE BUILD \*\*\* syntax error: a test file did not load/u);
});

test('a run that fails or finds no tests is ERROR, never NO BITE', async (t) => {
  // reviewer P2, 2026-10-10: "nothing failed" is a finding only if something RAN.
  const { dir, git } = await repo(t);
  await writeFile(join(dir, 'empty.test.mjs'), '// no tests here\n');
  await writeFile(join(dir, 'slow.test.mjs'), "import test from 'node:test';\ntest('waits', () => new Promise((r) => setTimeout(r, 60_000)));\n");
  git('add', '.'); git('commit', '-q', '-m', 'more');
  const none = await negativeControls({
    cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['empty.test.mjs'],
    cases: [['lib.mjs', 'nothing tested', '"lib"', '"x"']],
  });
  assert.match(none[0]!, /^\*\*\* ERROR \*\*\* nothing tested: no tests ran in a test file/u);
  const slow = await negativeControls({
    cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['slow.test.mjs'], timeoutMs: 1500,
    cases: [['lib.mjs', 'timed out', '"lib"', '"x"']],
  });
  assert.match(slow[0]!, /^\*\*\* ERROR \*\*\* timed out: the run itself failed — killed/u);
});

test('a test that writes into the tree fails the whole-tree check', async (t) => {
  // reviewer P2: "restored" used to mean only the named files.
  const { dir, git } = await repo(t);
  await writeFile(join(dir, 'litter.test.mjs'),
    "import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('litters', () => writeFileSync('stray.txt', 'x'));\n");
  git('add', '.'); git('commit', '-q', '-m', 'litter');
  const before = process.exitCode;
  try {
    const lines = await negativeControls({
      cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['litter.test.mjs'],
      cases: [['lib.mjs', 'anything', '"lib"', '"x"']],
    });
    assert.match(lines.at(-1)!, /^\*\*\* TREE CHANGED during the run \*\*\*[\s\S]*stray\.txt/u);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = before; }
});
