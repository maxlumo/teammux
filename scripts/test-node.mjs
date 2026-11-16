#!/usr/bin/env node
// `pnpm test`: the frontend and script suites (node --test), one shape with test-rust.mjs (board #137,
// reviewer R1): the guard first, with the command exactly as called (the caller's arguments included, so
// the refusal names the SAME command), then node --test with them before the suite's globs.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireIsolated } from './isolation-guard.mjs';

export const GLOBS = ['src/**/*.test.js', 'src/**/*.test.ts', 'scripts/**/*.test.js', 'scripts/**/*.test.ts'];

/** node --test's argv: the caller's arguments (a lone `--` from `pnpm test -- …` dropped), then the globs. */
export function nodeTestArgs(extra) {
  return ['--test', ...extra.filter((a, i) => !(i === 0 && a === '--')), ...GLOBS];
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const extra = process.argv.slice(2);
  requireIsolated(['pnpm', 'test', ...extra]);
  const r = spawnSync(process.execPath, nodeTestArgs(extra), { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
