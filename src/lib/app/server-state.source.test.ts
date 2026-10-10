// Maintenance pins for the per-server storage layout (board #335 ②a-3).
// Behaviour proofs are server-state.test.ts; these keep two facts that a
// reviewer cannot see by calling the modules:
//
//   - the `<key>::<id>` layout is spelled in ONE function. Phase ② adds a
//     second reader of these slots beside `servers.ts`'s park/point, and two
//     places building the string by hand is how they come to disagree.
//   - a page never names a server behind its provider's back. The identity
//     modules have exactly the production consumers the current commit gives
//     them, one row at a time, so the diff says which layer just gained the
//     right to choose a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
/** Code only: a rule about imports must not trip over a comment naming one. */
const code = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*)/u.test(line))
  .join('\n');

test('one function spells the per-server key layout', async () => {
  const layout = code(await read('server-state-migration.ts'));
  // residentKey is that function. It is the only template literal in the
  // module that joins a key to a server id.
  assert.match(layout, /export function residentKey/u);
  const store = code(await read('server-store.ts'));
  assert.match(store, /residentKey\(/u, 'the store asks for the layout rather than rebuilding it');
  assert.doesNotMatch(store, /`\$\{[^}]*\}::/u, 'and never spells `::` itself');
  // servers.ts keeps its own `parked()` until ②b retires park/point; what must
  // not happen is a THIRD speller appearing in the new modules.
  for (const name of ['server-store.ts', 'server-runtime.ts', 'server-fleet.ts', 'refs.ts']) {
    assert.doesNotMatch(code(await read(name)), /::\$\{/u, `${name} builds a parked key by hand`);
  }
});

test('the store keeps the storage layout and none of the semantics', async () => {
  const src = code(await read('server-store.ts'));
  // What a SeenMark is, that an empty draft removes its row, how stepsRows
  // clamps: all of that stays in hub-prefs and notify-centre. A copy here
  // would be a second definition that drifts.
  for (const leak of ['SeenMark', 'draftUpdate', 'clampStepsRows', 'JSON.parse', 'JSON.stringify']) {
    assert.ok(!src.includes(leak), `${leak} in server-store.ts — the store is a Storage view, not a second store`);
  }
});

test('the identity modules have exactly the production consumers this commit gives them', async () => {
  // ②a's version of this test said the identity modules had NO production
  // consumer, which was the revised scope then and stopped being true the
  // moment ②b-1 made App provide a runtime. The rule it was protecting is
  // still the one worth keeping, so it is rewritten rather than deleted: a
  // PAGE must not reach for a server of its own. It asks its provider (the
  // context) and gets the one its subtree is bound to; a page that imported
  // the runtime, the fleet or the store would be choosing a server behind the
  // provider's back, and in Single mode it would look right.
  //
  // One row widens per commit, which is the point — the diff says which layer
  // just gained the right to name a server:
  //   ②b-1  App (the constructor) and ServerScope (the provider)
  //   ②b-2  App's nav keeps refs; the resident stores reach server-store
  //   ②b-3  every bound page reaches server-context
  const allowed: Record<string, string[]> = {
    'refs.ts': [],
    'server-runtime.ts': [],
    'single-runtime.ts': ['src/App.svelte'],
    'server-scope.ts': ['src/App.svelte'],
    'server-fleet.ts': [],
    'server-store.ts': [],
    'server-state-migration.ts': [],
    'server-context.ts': ['src/lib/app/ServerScope.svelte'],
    'server-union.ts': [],
  };
  const found: Record<string, string[]> = {};
  for await (const file of glob('src/**/*.{ts,svelte}')) {
    if (/\.(test|fixture)\.(ts|svelte)$/u.test(file) || /\.test\.[a-z]+\.svelte$/u.test(file)) continue;
    const path = file.replaceAll('\\', '/');
    // The modules' own edges are theirs to have: the layering between them is
    // server-fleet.source.test.ts's subject, not this one's.
    if (Object.keys(allowed).some((a) => path.endsWith(`/app/${a}`))) continue;
    const text = await readFile(file, 'utf8');
    for (const a of Object.keys(allowed)) {
      const base = a.replace(/\.ts$/u, '');
      if (new RegExp(`from '[^']*${base}(\\.ts)?'`, 'u').test(text)) (found[a] ??= []).push(path);
    }
  }
  for (const [module, expected] of Object.entries(allowed)) {
    assert.deepEqual((found[module] ?? []).sort(), [...expected].sort(),
      `${module}: a page that names a server behind its provider's back would look right in Single mode`);
  }
});
