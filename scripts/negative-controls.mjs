// Negative controls: break one thing on purpose, run the tests that should
// notice, put it back (docs/guidance/process.md §1.3).
//
// A case is `[file, name, find, replace]`: the runner replaces `find` with
// `replace` in `file`, runs `tests`, records which tests failed, and restores
// the file before the next case. "BITES" means at least one test failed; a
// "NO BITE" is the finding — a guard no test is holding.
//
// A spec is a small `.mjs` that calls `negativeControls(...)` from the
// worktree root; keep it in gitignored `temp/` beside the review it serves.
//
// It is committed rather than kept as scratch because it once DAMAGED a
// commit (#335 ②a-4): an earlier version restored files from a copy in
// memory, its output was piped through `head`, node took SIGPIPE before the
// restore, and the mutated file was staged and committed. And it was lost
// once with the rest of a worktree (#335 ②b, 2026-10-10). So:
//   - restore with `git checkout --`: the baseline is the committed blob, not
//     something this process is holding;
//   - refuse to START on a dirty file: a crash's leftovers cannot pass for the
//     baseline;
//   - restore on exit however we exit, and verify the tree is clean before
//     reporting success;
//   - ignore EPIPE on stdout, so a truncated pipe cannot kill the run.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

/**
 * @param {{
 *   files: string[],
 *   tests: string[],
 *   cases: [string, string, string, string][],
 *   prelude?: Record<string, [string, string, string][]>,
 *   cwd?: string,
 *   report?: string,
 *   log?: (line: string) => void,
 * }} spec
 * `prelude` adds a declaration one case's broken version needs, as
 * `{ [file]: [[caseName, anchor, replacement], ...] }`, applied after the
 * case's own replacement. `report` writes the result lines to a file.
 * Resolves to the result lines; sets a non-zero exit code when the tree could
 * not be restored or the run refused to start.
 */
export async function negativeControls({ files, tests, cases, prelude = {}, cwd = process.cwd(), report, log = console.log }) {
  if (!process.stdout.listenerCount('error')) process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
  const git = (...args) => run('git', args, { cwd }).then((r) => r.stdout);
  const dirty = async () => (await git('status', '--porcelain', '--', ...files)).trim();
  const lines = [];
  const say = (text) => { lines.push(text); log(text); };

  const before = await dirty();
  if (before) {
    say(`refusing to run: these files already differ from HEAD\n${before}\ncommit or restore them first — otherwise the baseline is unknown.`);
    process.exitCode = 1;
    return lines;
  }
  const restore = () => { try { execFileSync('git', ['checkout', '--', ...files], { cwd }); } catch { /* best effort */ } };
  const onSignal = () => { restore(); process.exit(1); };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGPIPE']) process.on(sig, onSignal);

  try {
    const source = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(cwd, f), 'utf8')])));
    for (const [file, name, find, replace] of cases) {
      if (!source[file]?.includes(find)) { say(`SKIP (anchor missing) ${name}`); continue; }
      let body = source[file].replace(find, replace);
      let skip = false;
      for (const [forCase, anchor, text] of prelude[file] ?? []) {
        if (forCase !== name) continue;
        if (!body.includes(anchor)) { say(`SKIP (prelude anchor missing) ${name}`); skip = true; break; }
        body = body.replace(anchor, text);
      }
      if (skip) continue;
      await writeFile(join(cwd, file), body);
      let out = '';
      try {
        // A fresh test run, not a child of whatever runs THIS: an inherited
        // NODE_TEST_CONTEXT makes node skip every file and report nothing.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        out = (await run('node', ['--test', '--test-reporter=tap', ...tests], { cwd, env, timeout: 600_000, maxBuffer: 64 << 20 })).stdout;
      } catch (e) { out = (e.stdout ?? '') + (e.stderr ?? ''); }
      await git('checkout', '--', file);
      const failed = out.split('\n').filter((l) => l.startsWith('not ok')).map((l) => l.trim());
      say(failed.length ? `BITES  ${name}\n       ${failed.join('\n       ')}` : `*** NO BITE *** ${name}`);
    }
  } finally {
    await git('checkout', '--', ...files);
    process.off('exit', restore);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGPIPE']) process.off(sig, onSignal);
  }
  const after = await dirty();
  say(after ? `*** TREE NOT RESTORED ***\n${after}` : 'tree restored, matches HEAD');
  if (after) process.exitCode = 1;
  if (report) await writeFile(join(cwd, report), lines.join('\n') + '\n');
  return lines;
}
