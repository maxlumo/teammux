// A doc comment stays directly above the item it documents (board #49).
//
// Lines only, no parser: every rule here is about which LINE follows a doc block, so it can be read
// from the text. It sees the shapes below and nothing about what a comment means.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const isRust = (path) => path.endsWith('.rs');

/** Each doc block in `lines` as { start, end } (0-based, inclusive): a `/** … *\/` that owns its lines
 * (nothing before `/**`, nothing after `*\/`), or a run of `///` lines in Rust. */
function docBlocks(path, lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isRust(path)) {
      if (!t.startsWith('///') || t.startsWith('////')) continue;
      let end = i;
      while (end + 1 < lines.length && isRustDoc(lines[end + 1])) end++;
      blocks.push({ start: i, end });
      i = end;
    } else if (t.startsWith('/**') && !t.startsWith('/**/')) {
      let end = i;
      while (end < lines.length && !lines[end].includes('*/', end === i ? 3 : 0)) end++;
      if (end === lines.length) break;
      if (lines[end].slice(lines[end].indexOf('*/') + 2).trim() === '') blocks.push({ start: i, end });
      i = end;
    }
  }
  return blocks;
}

/** A block with nothing above it but blank lines or a Svelte `<script>` tag: a file's own header. */
const opensFile = (lines, start) => lines.slice(0, start).every((l) => l.trim() === '' || /^<script[\s>]/u.test(l.trim()));

const isRustDoc = (line) => { const t = line.trim(); return t.startsWith('///') && !t.startsWith('////'); };

/** Doc blocks in one file whose next line shows they document nothing: [{ line, rule }], line 1-based. */
export function strandedDocs(path, text) {
  const lines = text.split('\n');
  const found = [];
  for (const { start, end } of docBlocks(path, lines)) {
    const next = lines[end + 1]?.trim();
    if (next === undefined) continue;
    if (isRust(path)) {
      let j = end + 1;
      while (j < lines.length && !isRustDoc(lines[j]) && (lines[j].trim() === '' || lines[j].trim().startsWith('//'))) j++;
      if (j > end + 1 && j < lines.length && isRustDoc(lines[j])) found.push({ line: start + 1, rule: 'a /// block followed, past a blank or // line, by another /// block' });
    } else if (next.startsWith('/**')) found.push({ line: start + 1, rule: 'a doc block directly followed by another doc block' });
    else if (next === '' && !opensFile(lines, start)) found.push({ line: start + 1, rule: 'a doc block followed by a blank line' });
  }
  return found;
}

/** Line pairs [beforeIndex, afterIndex] that a shortest edit script keeps unchanged (Myers' O(ND)
 * diff, after the common head and tail are matched directly). */
function unchangedPairs(a, b) {
  const pairs = [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) pairs.push([head, head++]);
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail), B = b.slice(head, b.length - tail);
  const n = A.length, m = B.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const middle = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const t = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && t[off + k - 1] < t[off + k + 1]) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : t[off + prevK], py = px - prevK;
    while (x > px && y > py) middle.push([head + --x, head + --y]);
    if (d > 0) { x = px; y = py; }
  }
  pairs.push(...middle.reverse());
  for (let i = tail; i > 0; i--) pairs.push([a.length - i, b.length - i]);
  return pairs;
}

const isAttribute = (path, line) => { const t = line.trim(); return isRust(path) ? t.startsWith('#[') : t.startsWith('@'); };

/** Doc blocks in BEFORE that had their item directly below and that the change moved apart from it:
 * the item line and a doc line both survive, with code (not doc, not attribute) now between them. */
function separations(path, a, b, pairs) {
  const toAfter = new Map(pairs);
  const inBlock = new Set(docBlocks(path, b).flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i)));
  const found = [];
  for (const { start, end } of docBlocks(path, a)) {
    const item = a[end + 1];
    if (item === undefined || item.trim() === '' || item.trim().startsWith('/')) continue;
    const itemAt = toAfter.get(end + 1);
    const kept = [];
    for (let i = start; i <= end; i++) if (toAfter.has(i)) kept.push(toAfter.get(i));
    if (itemAt === undefined || kept.length === 0) continue;
    const last = kept.at(-1);
    let between = false;
    for (let i = last + 1; i < itemAt; i++) if (!inBlock.has(i) && !isAttribute(path, b[i])) between = true;
    if (between) found.push({ line: kept[0] + 1, rule: 'the change put code between this doc block and its item' });
  }
  return found;
}

/** What a change from BEFORE to AFTER introduces: a single-file finding in AFTER that the diff did
 * not keep from one BEFORE already had (neither the block nor the line after it is kept from a
 * stranded block or its next line), so it was added or moved; and every separation. One finding per line, in line order. */
export function introducedBy(path, before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const pairs = unchangedPairs(a, b);
  const blockOf = (ls, f) => docBlocks(path, ls).find((x) => x.start === f.line - 1);
  const oldStranded = new Set();
  for (const f of strandedDocs(path, before)) { const { start, end } = blockOf(a, f); for (let i = start; i <= end + 1; i++) oldStranded.add(i); }
  const keptFromStranded = new Set(pairs.filter(([i]) => oldStranded.has(i)).map(([, j]) => j));
  const added = strandedDocs(path, after).filter((f) => {
    const { start, end } = blockOf(b, f);
    for (let j = start; j <= end + 1; j++) if (keptFromStranded.has(j)) return false;
    return true;
  });
  const seen = new Set();
  return [...added, ...separations(path, a, b, pairs)]
    .filter((f) => !seen.has(f.line) && seen.add(f.line))
    .sort((x, y) => x.line - y.line)
    .map((f) => ({ ...f, text: b[f.line - 1].trim() }));
}

const SOURCE = /\.(rs|ts|js|mjs|svelte)$/u;
/** The incident fixtures are stranded on purpose. */
const FIXTURES = 'scripts/fixtures/doc-adjacency/';

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Where the change under test starts: { base } = merge-base(HEAD, main), or { skip } naming why
 * there is none (not a git checkout, no `main` ref, history too shallow to meet it). */
export function changeBase(root, ref = 'main') {
  const r = git(root, ['merge-base', 'HEAD', ref]);
  if (r.status !== 0 || !r.stdout.trim()) return { skip: `skipped: no merge-base of HEAD and ${ref} (${(r.stderr || 'no output').trim().split('\n')[0]})` };
  return { base: r.stdout.trim() };
}

/** Every source file the working tree changes since BASE (committed, staged, unstaged or untracked):
 * { path, before, after }, before '' for a new file. A deleted file has nothing left to strand. */
export function changedSources(root, base) {
  const run = (args) => { const r = git(root, args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout; };
  const tracked = run(['diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', base]).split('\0');
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return [...new Set([...tracked, ...untracked])]
    .filter((p) => p && SOURCE.test(p) && !p.startsWith(FIXTURES) && existsSync(join(root, p)))
    .map((path) => {
      const old = git(root, ['show', `${base}:${path}`]);
      return { path, before: old.status === 0 ? old.stdout : '', after: readFileSync(join(root, path), 'utf8') };
    });
}
