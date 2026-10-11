// Maintenance pin for the identity layer (board #335 ②, plan pin ③). The
// behaviour proofs are refs.test.ts; this file keeps the one rule that cannot
// be proved by calling the module: a serverId never reaches the wire.
//
// It is pinned as a LAYERING fact rather than as an assertion about strings,
// because the only way a serverId could travel is if this module — or
// something it imports — could send. refs.ts reaches no transport and builds
// no tmux address, so the `session`, `target` and `room` arguments a
// multi-server build sends are byte-for-byte the ones a single-server build
// sends today. The serverId selects the CONNECTION and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
/** Code only: a rule about imports must not trip over a comment naming one. */
const code = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*)/u.test(line))
  .join('\n');

test('refs.ts can name an object but cannot send one', async () => {
  const src = code(await read('refs.ts'));
  const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/gu)].map(m => m[1]);
  // One import, and it is the single definition of the session-rename rule.
  assert.deepEqual(imports, ['./nav-state.ts'],
    'refs.ts is pure identity: adding an import here is how a serverId would acquire a way onto the wire');
  assert.doesNotMatch(src, /localStorage|sessionStorage/u, 'a ref is not persisted state');
  assert.doesNotMatch(src, /\$state\b|from ['"]svelte/u, 'a ref is a value, not a store');
});

test('no serverId is ever concatenated into a tmux address', async () => {
  const src = code(await read('refs.ts'));
  // The one place a serverId joins other names is refKey, and it emits a JSON
  // tuple — `JSON.stringify` of an array, never a template literal. A
  // `${serverId}:${session}` or `${serverId}/${session}` here would read as a
  // session name at the far end.
  for (const literal of src.match(/`[^`]*`/gu) ?? []) {
    assert.doesNotMatch(literal, /\$\{[^}]*[sS]erverId[^}]*\}/u,
      `serverId inside a template literal: ${literal} — a wire string must not carry it`);
  }
  assert.doesNotMatch(src, /serverId\s*\+/u, 'nor by concatenation');
});
