// A doc comment stays directly above the item it documents (board #49).
//
// Three times in one night (2026-11-06) a change left a doc comment separated from its item, and each
// was caught only by a validator reading by eye: #43 S1 (two tmm.rs helpers inserted between
// `cap_refusal`'s doc and `fn cap_refusal`), #43 S2 (`blockPicks` inserted between `editBlocks`'s
// JSDoc and the function, Board.svelte) and #47 S1 (`fn resuming` inserted between
// `startup_confirmation`'s doc and its item, codex.rs). The fixtures are verbatim excerpts of those
// files before and after each change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changeBase, changedSources, introducedBy, strandedDocs } from './doc-adjacency.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const fixture = (name: string) => readFileSync(new URL(`./fixtures/doc-adjacency/${name}`, import.meta.url), 'utf8');

test('#43 S2: a JSDoc block directly followed by another JSDoc block is stranded', () => {
  assert.deepEqual(strandedDocs('Board.svelte', fixture('43-s2-Board.after.svelte')).map((f) => f.line), [2]);
});

const pair = (stem: string, ext: string) => [fixture(`${stem}.before.${ext}`), fixture(`${stem}.after.${ext}`)] as const;
const lines = (found: Array<{ line: number }>) => found.map((f) => f.line);

test('#43 S1: helpers inserted between a /// doc and its fn separate them', () => {
  const [before, after] = pair('43-s1-tmm', 'rs');
  assert.deepEqual(lines(introducedBy('tmm.rs', before, after)), [3]);
});

test('#47 S1: a fn inserted between a /// doc and its attributed item separates them', () => {
  const [before, after] = pair('47-s1-codex', 'rs');
  assert.deepEqual(lines(introducedBy('codex.rs', before, after)), [2]);
});

test('#43 S2: a declaration inserted between a JSDoc and its function separates them', () => {
  const [before, after] = pair('43-s2-Board', 'svelte');
  assert.deepEqual(lines(introducedBy('Board.svelte', before, after)), [2]);
});

const STRANDED = ['/** Old doc A. */', '/** Old doc B. */', 'export const b = 2;'];

test('a stranded block the branch already had is not counted, even with its wording edited', () => {
  const after = ['/** Old doc A, reworded. */', '/** Old doc B. */', 'export const b = 2;'];
  assert.deepEqual(introducedBy('x.ts', STRANDED.join('\n'), after.join('\n')), []);
});

test('a stranded block the change moves (as the diff sees it) is counted where it lands', () => {
  const rest = ['export const c = 3;', 'export const d = 4;', 'export const e = 5;', 'export const f = 6;'];
  assert.deepEqual(lines(introducedBy('x.ts', [...STRANDED, ...rest].join('\n'), [...rest, ...STRANDED].join('\n'))), [5]);
});

test('a JSDoc block with a blank line before its item is stranded', () => {
  assert.deepEqual(lines(strandedDocs('x.ts', ["import { m } from './m.ts';", '/** The count. */', '', 'export const n = m;'].join('\n'))), [2]);
});

test("a file's opening JSDoc may stand alone: it documents the file", () => {
  assert.deepEqual(strandedDocs('x.ts', ['/** What this module is. */', '', "import { m } from './m.ts';"].join('\n')), []);
  assert.deepEqual(strandedDocs('X.svelte', ['<script lang="ts">', '  /** What this component is. */', '', "  import { m } from './m.ts';"].join('\n')), []);
});

test('a /// run, then a blank or // line, then another /// run: the first is stranded', () => {
  assert.deepEqual(lines(strandedDocs('x.rs', ['/// Old summary.', '', '/// New summary.', 'fn x() {}'].join('\n'))), [1]);
  assert.deepEqual(lines(strandedDocs('x.rs', ['/// Old summary.', '// a note', '/// New summary.', 'fn x() {}'].join('\n'))), [1]);
});

test('growing a doc, adding an attribute or changing the item itself keeps the doc on its item', () => {
  const before = ['use x;', '/// Summary.', 'fn f(a: u8) {}'];
  assert.deepEqual(introducedBy('x.rs', before.join('\n'), ['use x;', '/// Summary.', '/// More.', 'fn f(a: u8) {}'].join('\n')), []);
  assert.deepEqual(introducedBy('x.rs', before.join('\n'), ['use x;', '/// Summary.', '#[cfg(test)]', 'fn f(a: u8) {}'].join('\n')), []);
  assert.deepEqual(introducedBy('x.rs', before.join('\n'), ['use x;', '/// Summary.', 'fn f(a: u8, b: u8) {}'].join('\n')), []);
});

// The limit (builder-2, 08:05 on #43): two `///` runs that touch are one block to every rule here.
// Read alone, the #43 S1 and #47 S1 files look like one long doc per item; only the change shows them.
test('limit: two /// runs merged into one block are invisible without the change', () => {
  assert.deepEqual(strandedDocs('tmm.rs', fixture('43-s1-tmm.after.rs')), []);
  assert.deepEqual(strandedDocs('codex.rs', fixture('47-s1-codex.after.rs')), []);
});

// The repository check reads the change since the branch left main. Without that base it cannot say
// anything, and it says so: a visible skip, never a silent pass (orchestrator's condition on #49).
test('no merge-base is a stated reason, not a base', () => {
  const bare = mkdtempSync(join(tmpdir(), 'doc-adjacency-'));
  try {
    assert.match(String(changeBase(bare).skip), /^skipped: no merge-base/u);
    execFileSync('git', ['init', '-q', '-b', 'side', bare]);
    execFileSync('git', ['-C', bare, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    assert.match(String(changeBase(bare).skip), /^skipped: no merge-base/u);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test('the change since the branch left main introduces no separated doc block', (t) => {
  const { base, skip } = changeBase(ROOT);
  if (skip) { t.skip(skip); return; }
  const found = changedSources(ROOT, base).flatMap(({ path, before, after }) => introducedBy(path, before, after).map((f) => `${path}:${f.line} ${f.rule}: ${f.text}`));
  assert.deepEqual(found, []);
});
