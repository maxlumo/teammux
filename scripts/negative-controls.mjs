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
// Five verdicts, because only one of them is evidence (validator and
// reviewer P2s, 2026-10-10):
//   BITES        a test failed, and every test file still LOADED;
//   NO BITE      the tests ran and none failed — the finding;
//   BROKE BUILD  the replacement stopped a test FILE from loading (a parse or
//                import error), or failed every test there is: that is the
//                break failing to compile, not a test noticing it;
//   ERROR        the run itself failed — a timeout, a crash, no TAP, or no
//                tests at all — so nothing can be concluded;
//   SKIP         the anchor was not found.
// Only BITES says a guard is held.
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
 *   timeoutMs?: number,
 * }} spec
 * `prelude` adds a declaration one case's broken version needs, as
 * `{ [file]: [[caseName, anchor, replacement], ...] }`, applied after the
 * case's own replacement. `report` writes the result lines to a file.
 * Resolves to the result lines; sets a non-zero exit code when the tree could
 * not be restored or the run refused to start.
 */
export async function negativeControls({ files, tests, cases, prelude = {}, cwd = process.cwd(), report, log = console.log, timeoutMs = 600_000 }) {
  if (!process.stdout.listenerCount('error')) process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
  const git = (...args) => run('git', args, { cwd }).then((r) => r.stdout);
  const dirty = async () => (await git('status', '--porcelain', '--', ...files)).trim();
  const lines = [];
  const say = (text) => { lines.push(text); log(text); };

  const before = await dirty();
  // The WHOLE worktree as it stands now — untracked specs and all — so the end
  // check can say "nothing changed anywhere", not only "the named files are
  // back": a test that writes into the tree is a leftover too.
  const tree = async () => (await git('status', '--porcelain', '--untracked-files=all')).trim();
  const treeBefore = before ? '' : await tree();
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
      let crash = '';
      try {
        // A fresh test run, not a child of whatever runs THIS: an inherited
        // NODE_TEST_CONTEXT makes node skip every file and report nothing.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        out = (await run('node', ['--test', '--test-reporter=tap', ...tests], { cwd, env, timeout: timeoutMs, maxBuffer: 64 << 20 })).stdout;
      } catch (e) {
        out = e.stdout ?? '';
        // node --test exits 1 when a test failed; anything else is the run
        // itself going wrong.
        if (e.killed || e.signal) crash = `killed (${e.signal ?? 'timeout'})`;
        else if (e.code !== 1) crash = `exit ${e.code}: ${String(e.stderr ?? e.message).trim().split('\n')[0]}`;
      }
      await git('checkout', '--', file);
      say(verdict(name, out, crash, tests));
    }
  } finally {
    await git('checkout', '--', ...files);
    process.off('exit', restore);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGPIPE']) process.off(sig, onSignal);
  }
  const after = await dirty();
  const treeAfter = await tree();
  if (after) say(`*** TREE NOT RESTORED ***\n${after}`);
  else if (treeAfter !== treeBefore) say(`*** TREE CHANGED during the run ***\nbefore:\n${treeBefore || '(clean)'}\nafter:\n${treeAfter || '(clean)'}`);
  else say('tree restored: the whole worktree is as it was before the run');
  if (after || treeAfter !== treeBefore) process.exitCode = 1;
  if (report) await writeFile(join(cwd, report), lines.join('\n') + '\n');
  return lines;
}

/** One case's verdict from its TAP output; see the module header. */
function verdict(name, out, crash, tests) {
  const failed = out.split('\n').filter((l) => l.startsWith('not ok')).map((l) => l.trim());
  const count = (key) => Number(/^# (\w+) (\d+)$/mu.exec(out.split('\n').filter((l) => l.startsWith(`# ${key} `)).at(-1) ?? '')?.[2] ?? NaN);
  const total = count('tests');
  const list = failed.length ? `\n       ${failed.join('\n       ')}` : '';
  if (crash) return `*** ERROR *** ${name}: the run itself failed — ${crash}${list}`;
  if (!Number.isFinite(total) || total === 0) return `*** ERROR *** ${name}: no tests ran${list}`;
  // node reports a test FILE as an entry of its own only when nothing inside
  // it did: `not ok - <file>` is a file that did not load, `ok - <file>` one
  // that loaded and declared no tests.
  const files = tests.map((t) => t.replace(/^\.\//u, ''));
  const isFile = (l) => { const title = l.replace(/^(?:not )?ok \d+ - /u, ''); return files.some((f) => title === f || title.endsWith(`/${f}`)); };
  if (failed.some(isFile)) return `*** BROKE BUILD *** ${name}: a test file did not load${list}`;
  if (out.split('\n').some((l) => /^ok \d+ - /u.test(l) && isFile(l))) return `*** ERROR *** ${name}: no tests ran in a test file${list}`;
  if (total > 1 && failed.length >= total) return `*** BROKE BUILD *** ${name}: every test failed (${total}), which a break that compiles does not do${list}`;
  return failed.length ? `BITES  ${name}${list}` : `*** NO BITE *** ${name}`;
}
