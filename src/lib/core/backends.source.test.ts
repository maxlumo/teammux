// Source contract (board #101/#131): the client does not keep its own list of
// spawnable backends. The server publishes it (`backends_list`, board #130);
// a hand-written array here is the mirror that drifts — the client's effort
// table had already lost omp while the server knew it. Tenet 2's "adding a
// backend touches one file" is only true if that file is on the server.
//
// What is DELIBERATELY still client-side, and why this test does not touch it:
//   - core/agents.ts AGENTS: pane DETECTION regexes (openclaw included).
//     An accepted mirror of agents.rs `find_word`; the comment there points at
//     the Rust source of truth. Detection is wider than spawning.
//   - hub.ts KIRO/GROK/CODEX command palettes: transcriptions of each TUI's
//     slash commands — UI knowledge, not backend identity.
//   - core/agents.ts fallback lists (arrive with #130): the frozen pre-#130
//     shape an OLDER server is answered with. One place, named as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const NAMES = ['kiro', 'claude', 'codex', 'grok', 'omp', 'kimi'];

async function walk(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) out.push(...(await walk(u)));
    else if (/\.(ts|js|svelte)$/u.test(e.name) && !/test/u.test(e.name)) out.push(u);
  }
  return out;
}

/** An array literal spelling two or more backend names — `['kiro', 'claude', …]`. */
function backendArrays(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(/\[[^\]\n]*\]/gu)) {
    const names = NAMES.filter((n) => new RegExp(`['"]${n}['"]`, 'u').test(m[0]));
    if (names.length >= 2) hits.push(m[0]);
  }
  return hits;
}

// The ONLY allowed site: core/agents.ts's frozen fallback list, the shape an
// OLDER server (pre-#130, no `backends_list`) is answered with. AgentsPage's
// own array went with #130 (2026-09-09) and its allowance with it.
const ALLOWED: Record<string, number> = {
  'core/agents.ts': 1,
};

test('no client file spells the spawnable backend list; the server publishes it', async () => {
  const files = await walk(ROOT);
  assert.ok(files.length > 50, `walk found only ${files.length} files`);
  const leaks: string[] = [];
  for (const f of files) {
    const rel = decodeURIComponent(f.href.slice(ROOT.href.length));
    const hits = backendArrays(await readFile(f, 'utf8'));
    const allowed = ALLOWED[rel] ?? 0;
    if (hits.length > allowed) leaks.push(`${rel}: ${hits.join(' | ')}`);
  }
  assert.deepEqual(leaks, [], 'a backend list written by hand — read the scope catalog (state.backends.spawnable()) instead');
});

test('the allowance is not larger than what exists (a removed array lowers it)', async () => {
  for (const [rel, n] of Object.entries(ALLOWED)) {
    const source = await readFile(new URL(rel, ROOT), 'utf8').catch(() => '');
    const hits = backendArrays(source).length;
    assert.ok(hits <= n, `${rel} has ${hits} backend arrays, allowance ${n}`);
    // An allowance nobody uses is a hole waiting for a new mirror.
    assert.equal(hits, n, `${rel}: tighten ALLOWED to ${hits}`);
  }
});
