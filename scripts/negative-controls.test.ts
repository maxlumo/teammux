// The negative-control runner's own guarantees, in a throwaway git repository:
// it reports which breaks the tests catch, and it leaves the tree exactly as
// committed — the property an earlier version once failed (it committed a
// mutated file; see the module header).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  assert.equal(lines.at(-1), 'tree clean: the whole worktree is as committed, before and after the run');
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
    assert.match(lines.at(-1)!, /^\*\*\* TREE NOT CLEAN after the run \*\*\*[\s\S]*stray\.txt/u);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = before; }
});

test('a break that compiles and fails every test is BITES, flagged for a human, not BROKE BUILD (reviewer P2-a on a05a996e)', async (t) => {
  const { dir, git } = await repo(t);
  await writeFile(join(dir, 'lib.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './lib.mjs';\n"
    + "test('adds', () => assert.equal(add(2, 3), 5));\ntest('adds again', () => assert.equal(add(1, 1), 2));\n");
  git('add', '.'); git('commit', '-q', '-m', 'two');
  const lines = await negativeControls({
    cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['lib.test.mjs'],
    cases: [['lib.mjs', 'subtracts', 'a + b', 'a - b']],
  });
  assert.match(lines[0]!, /^BITES  subtracts \(every test failed, 2 — read them/u);
});

test('it refuses to start on ANY dirty path, tracked or untracked, named or not (reviewer P2-b on a05a996e)', async (t) => {
  const { dir, git } = await repo(t);
  await writeFile(join(dir, 'other.mjs'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'other');
  const before = process.exitCode;
  try {
    for (const [path, text] of [['other.mjs', 'export const x = 2;\n'], ['untracked.txt', 'x']] as const) {
      await writeFile(join(dir, path), text);
      const lines = await negativeControls({
        cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['lib.test.mjs'],
        cases: [['lib.mjs', 'x', 'a + b', 'a - b']],
      });
      assert.match(lines[0]!, /^refusing to run: the worktree is not clean/u, path);
      assert.equal(await readFile(join(dir, path), 'utf8'), text, 'and leaves it alone');
      git('checkout', '--', '.'); git('clean', '-fdq');
    }
  } finally { process.exitCode = before; }
});

test('a test that edits a tracked file the spec does not name fails the end check', async (t) => {
  // The case the status-text comparison missed: the edit leaves the same
  // " M" line it would have had if the file were dirty before.
  const { dir, git } = await repo(t);
  await writeFile(join(dir, 'other.mjs'), 'export const x = 1;\n');
  await writeFile(join(dir, 'edit.test.mjs'),
    "import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('edits', () => writeFileSync('other.mjs', 'export const x = 9;\\n'));\n");
  git('add', '.'); git('commit', '-q', '-m', 'edit');
  const before = process.exitCode;
  try {
    const lines = await negativeControls({
      cwd: dir, log: () => {}, files: ['lib.mjs'], tests: ['edit.test.mjs'],
      cases: [['lib.mjs', 'anything', '"lib"', '"x"']],
    });
    assert.match(lines.at(-1)!, /^\*\*\* TREE NOT CLEAN after the run \*\*\*[\s\S]*other\.mjs/u);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = before; }
});

test('wip: uncommitted work is the baseline, and it comes back uncommitted on the same HEAD (#335 ③b)', async (t) => {
  const { dir, git } = await repo(t);
  const head = git('rev-parse', 'HEAD').toString().trim();
  await writeFile(join(dir, 'lib.mjs'), 'export const add = (a, b) => b + a;\nexport const name = "lib";\n');   // the work
  await writeFile(join(dir, 'new.mjs'), 'export {};\n');                                                   // untracked
  const lines = await negativeControls({
    cwd: dir, log: () => {}, wip: true,
    files: ['lib.mjs'], tests: ['lib.test.mjs'],
    cases: [['lib.mjs', 'add subtracts', 'b + a', 'b - a']],
  });
  assert.match(lines[0]!, /^BITES  add subtracts/u, 'the break is applied to the uncommitted work');
  assert.match(lines.at(-1)!, /^wip: the transient commit is undone/u);
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), head, 'HEAD is where it was: no nc-tmp left');
  assert.equal(git('status', '--porcelain').toString(), ' M lib.mjs\n?? new.mjs\n', 'the work is back, unstaged');
  assert.match(await readFile(join(dir, 'lib.mjs'), 'utf8'), /b \+ a/u);
  assert.equal(existsSync(join(dir, '.git', 'nc-in-progress')), false, 'and the marker is gone');
});

test('a wip run killed before its undo is caught by the next start, which names the way back (#335 ③b, 2026-10-11)', async (t) => {
  // What a machine move did: the transient commit stayed on the branch.
  const { dir, git } = await repo(t);
  const head = git('rev-parse', 'HEAD').toString().trim();
  await writeFile(join(dir, 'lib.mjs'), 'export const add = (a, b) => b + a;\n');
  const marker = join(dir, '.git', 'nc-in-progress');
  await writeFile(marker, `${head}\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'nc-tmp');
  const tip = git('rev-parse', 'HEAD').toString().trim();
  const before = process.exitCode;
  try {
    for (const wip of [false, true]) {
      const lines = await negativeControls({ cwd: dir, log: () => {}, wip, files: ['lib.mjs'], tests: ['lib.test.mjs'], cases: [['lib.mjs', 'x', 'b + a', 'b - a']] });
      assert.match(lines[0]!, /^refusing to run: an interrupted wip run/u, `wip=${wip}: refused`);
      assert.ok(lines[0]!.includes(`git reset --soft ${head} && git reset && rm '${marker}'`), 'with the commands that put the work back');
      assert.equal(process.exitCode, 1);
      assert.equal(git('rev-parse', 'HEAD').toString().trim(), tip, 'and nothing moved');
    }
  } finally { process.exitCode = before; }
});
