// Maintenance pins for the server context (board #335 ②a-3, decision D1).
// The real wiring cases are server-context.mount.test.ts; these two rules are
// the ones a mount cannot state, and each is one line away from coming back:
//
//   - a second importer of `compatSlotApi`. That export is the facade's second
//     door, open for one commit range so a provider-less component keeps
//     taking today's path. A page that reaches for it directly is a page that
//     has gone back to "whichever server is current", and it would look
//     correct for as long as production holds one server. Since ②b-1 the door
//     has exactly one other named user, `app/single-runtime.ts`, which builds
//     the ONE runtime production holds over that slot so there is one socket
//     while the consumers move; b3-4 deletes that file, this export and the
//     fallback together, and the list goes back to the facade alone.
//   - a context read that is not at component init. `getContext` works during
//     initialisation and nowhere else, so a read inside a handler or after an
//     `await` silently yields nothing — and the whole point of reading once is
//     that an operation already under way cannot re-target itself.
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

test('only the context fallback and the single runtime reach the compatibility slot', async () => {
  const allowed = new Set([
    'src/lib/app/server-context.ts',
    // The ONE runtime production holds while ws.ts still owns the socket
    // (②b-1). It is a separate file precisely so `server-runtime.ts` stays
    // facade-free, which server-fleet.source.test.ts pins.
    'src/lib/app/single-runtime.ts',
    'src/lib/core/ws.ts',
  ]);
  const found: string[] = [];
  for await (const file of glob('src/**/*.{ts,svelte}')) {
    if (/\.(test|fixture)\.(ts|svelte)$/u.test(file) || /\.test\.[a-z]+\.svelte$/u.test(file)) continue;
    if (allowed.has(file.replaceAll('\\', '/'))) continue;
    if (/\bcompatSlotApi\b/u.test(code(await readFile(file, 'utf8')))) found.push(file);
  }
  assert.deepEqual(found, [],
    `compatSlotApi is the facade's one temporary door; these reach it instead of using their provider:\n  ${found.join('\n  ')}`);
});

test('the context is read at component init and nowhere else', async () => {
  const src = code(await read('server-context.ts'));
  // The module's own helpers are the only legitimate `getContext` callers, and
  // they are plain functions a component calls during init.
  const reads = (src.match(/getContext</gu) ?? []).length;
  assert.equal(reads, 1, 'one getContext call, in useServerScope');
  assert.doesNotMatch(src, /async function|await /u,
    'nothing here may await: a context read after an await returns nothing');

  // Every consumer reads the context ONCE, at the top level of the instance
  // script (②b-1-3): not inside a handler, an effect or an async function,
  // and not twice — a second read is a second chance to see a different
  // server, and `useServerRuntime()` already gives both the id and the api.
  for await (const file of glob('src/**/*.svelte')) {
    const text = await readFile(file, 'utf8');
    if (!/\buseServer(Api|Id|Runtime|Scope)\b/u.test(text)) continue;
    const script = /<script(?![^>]*\bmodule\b)[^>]*>([\s\S]*?)<\/script>/u.exec(text)?.[1] ?? '';
    const calls = code(script).split('\n').filter((line) => /\buseServer(Api|Id|Runtime|Scope)\(/u.test(line));
    // A test consumer exists to observe both answers, so it may read twice.
    if (!/\.test\.[a-z]+\.svelte$/u.test(file)) {
      assert.ok(calls.length <= 1, `${file}: ${calls.length} context reads — read it once, into one local const`);
    }
    for (const line of calls) {
      // An init read is an assignment at the script's top level, so it is not
      // indented inside a function, an effect or a block.
      assert.match(line, /^\s{0,2}(const|let) /u,
        `${file}: "${line.trim()}" — read the context once at init into a local const`);
    }
    assert.doesNotMatch(/<script[^>]*\bmodule\b[^>]*>([\s\S]*?)<\/script>/u.exec(text)?.[1] ?? '', /\buseServer(Api|Id|Runtime|Scope)\(/u,
      `${file}: a module script is not a component instance — it has no context to read`);
  }
  // And nothing that is not a component reads it: a `.ts` / `.svelte.ts`
  // module has no init, so a read there either throws or — called from a
  // component's handler — returns nothing. Helpers take an explicit api.
  for await (const file of glob('src/**/*.ts')) {
    const path = file.replaceAll('\\', '/');
    if (path.endsWith('/app/server-context.ts') || /\.test\.ts$/u.test(path)) continue;
    assert.doesNotMatch(code(await readFile(file, 'utf8')), /\buseServer(Api|Id|Runtime|Scope)\(/u,
      `${path} reads the server context outside a component; take an explicit api or serverId instead`);
  }
});
