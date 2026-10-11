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
/** Does `text` import the module whose file is `base`(.ts)? Either quote:
 * a rule that matched only `'` let a double-quoted import through
 * (validator P2-c on ea56861b). */
const importsModule = (text: string, base: string) =>
  new RegExp(`from\\s*['"][^'"]*${base}(\\.ts)?['"]`, 'u').test(text);

test('the importer rule sees either quote', () => {
  assert.equal(importsModule("import { createServerFleet } from './server-fleet.ts';", 'server-fleet'), true);
  assert.equal(importsModule('import { createServerFleet } from "../app/server-fleet.ts";', 'server-fleet'), true);
  assert.equal(importsModule("import { x } from './server-fleet-view.ts';", 'server-fleet'), false);
});

test('one function spells the per-server key layout', async () => {
  // residentKey, in the identity layer (board #335 ②b-4 retired `parked()`,
  // its second speller). Everything else asks it.
  const servers = code(await read('servers.ts'));
  assert.match(servers, /export function residentKey/u);
  assert.equal((servers.match(/`\$\{[^}]*\}::\$\{/gu) ?? []).length, 1, 'servers.ts spells it once');
  for (const name of ['server-store.ts', 'server-state-migration.ts']) {
    const src = code(await read(name));
    assert.match(src, /residentKey\(/u, `${name} asks for the layout rather than rebuilding it`);
    assert.doesNotMatch(src, /`\$\{[^}]*\}::/u, `and never spells \`::\` itself`);
  }
  for (const name of ['server-store.ts', 'server-runtime.ts', 'server-fleet.ts', 'refs.ts', 'server-state-migration.ts']) {
    assert.doesNotMatch(code(await read(name)), /::\$\{/u, `${name} builds a resident key by hand`);
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
  //   ②b-4  App reaches server-store and the fold
  // Since ②b-1-3 the test after this one says who may CONSTRUCT a runtime or
  // a scope (App alone), and the one after it that a union list acts through
  // its rows rather than through one context.
  const allowed: Record<string, string[]> = {
    // ②b-2: App mints the refs its navigation keeps, and the saved-nav
    // decoder reads and attributes them. No page names a server itself.
    'refs.ts': ['src/App.svelte',
      // ③a: the device's excluded set holds ServerIds (a type import); it
      // reads them through the registry and is not a page.
      'src/lib/app/connection-mode.ts',
      // ③a: the window's view of a bound tree holds its PaneRef/SessionRef
      // (type imports); App owns it, and it is not a page.
      'src/lib/app/server-view.svelte.ts'],
    'nav-saved.ts': ['src/App.svelte'],
    'server-runtime.ts': [],
    'server-scope.ts': ['src/App.svelte'],
    // ②b-4: the activation generation, App's alone.
    'activation.ts': ['src/App.svelte'],
    // ②b-4: App's runtimes are the fleet's, one connection each.
    'server-fleet.ts': ['src/App.svelte'],
    // ②b-4: App builds each server's state over its own store, saves and
    // reads the navigation through it, and runs the fold.
    'server-store.ts': ['src/App.svelte'],
    'server-state-migration.ts': ['src/App.svelte'],
    // ②b-2-1: a page that holds this server's state reads it from its scope.
    // ②b-2-3: every page with a leave guard names its owner, the runtime of
    // its scope, so a leave asks only what it destroys.
    // ②b-3: a page bound to its scope takes its RPCs from it — terminal and
    // sessions first, then files, then the hub.
    'server-context.ts': ['src/lib/app/ServerScope.svelte', 'src/lib/hub/Hub.svelte', 'src/lib/files/Files.svelte',
      'src/lib/hub/Board.svelte', 'src/lib/hub/AgentsPage.svelte',
      'src/lib/terminal/Terminal.svelte', 'src/lib/sessions/Sessions.svelte', 'src/lib/sessions/PanePicker.svelte',
      'src/lib/app/ScratchPanel.svelte', 'src/lib/files/GitPanel.svelte', 'src/lib/files/DirPicker.svelte',
      'src/lib/hub/ChatImage.svelte', 'src/lib/projects/Projects.svelte', 'src/lib/projects/CreateProjectDialog.svelte',
      // ②b-3: the Hub's sidebar and roster wear THIS server's backend faces.
      'src/lib/hub/Roster.svelte', 'src/lib/hub/Sidebar.svelte'],
    // ②b-2-1: App builds each runtime's state bundle; pages never do.
    'server-state.ts': ['src/App.svelte'],
    'server-union.ts': [],
  };
  const found: Record<string, string[]> = {};
  for await (const file of glob('src/**/*.{ts,svelte}')) {
    if (/\.(test|fixture)\.(ts|svelte)$/u.test(file) || /\.test\.[a-z]+\.svelte$/u.test(file)) continue;
    const path = file.replaceAll('\\', '/');
    // The test harness stands in for the provider; it is not a page.
    if (path.startsWith('src/lib/test/')) continue;
    // The modules' own edges are theirs to have: the layering between them is
    // server-fleet.source.test.ts's subject, not this one's.
    if (Object.keys(allowed).some((a) => path.endsWith(`/app/${a}`))) continue;
    const text = await readFile(file, 'utf8');
    for (const a of Object.keys(allowed)) {
      const base = a.replace(/\.ts$/u, '');
      if (importsModule(text, base)) (found[a] ??= []).push(path);
    }
  }
  for (const [module, expected] of Object.entries(allowed)) {
    assert.deepEqual((found[module] ?? []).sort(), [...expected].sort(),
      `${module}: a page that names a server behind its provider's back would look right in Single mode`);
  }
});

/** Who may do which (reviewer P2-b on b1-3): CONSTRUCTING a runtime, a fleet,
 * a scope swap, a store or a server state is App's alone; BINDING a scope is
 * the provider's alone. One allowlist for both let the provider construct. */
const CONSTRUCT = /\b(createServerRuntime|createSingleRuntime|createServerFleet|createScopeSwap|createServerStore|createServerState)\(/u;
const BIND = /\bsetServerScope\(/u;
const MAY_CONSTRUCT = new Set(['src/App.svelte', 'src/lib/test/server-scope-host.ts']);
const MAY_BIND = new Set(['src/lib/app/ServerScope.svelte', 'src/lib/test/server-scope-host.ts']);
/** The violations in one file. */
function hostRights(path: string, text: string): string[] {
  const src = code(text);
  const out: string[] = [];
  if (!MAY_CONSTRUCT.has(path) && CONSTRUCT.test(src)) out.push(`${path} constructs`);
  if (!MAY_BIND.has(path) && BIND.test(src)) out.push(`${path} binds a scope`);
  return out;
}

test('only App constructs a runtime or a state, and only the provider binds a scope', async () => {
  // The importer table above says who may SEE the identity modules; this says
  // who may MAKE what they describe (②b-1-3). A runtime or a scope built
  // anywhere but the one host is a second answer to "which server is this
  // subtree on", and every page under it would believe it.
  const found: string[] = [];
  for await (const file of glob('src/**/*.{ts,svelte}')) {
    const path = file.replaceAll('\\', '/');
    // A browser fixture (`*.browser.test-fixture.ts`) is a test host too.
    if (/\.(test|fixture|test-fixture)\.(ts|svelte)$/u.test(path) || /\.test\.[a-z]+\.svelte$/u.test(path)) continue;
    // The modules that define them.
    if (/\/app\/(server-runtime|server-fleet|server-scope|server-store|server-state|server-context)\.ts$/u.test(path)) continue;
    found.push(...hostRights(path, await readFile(file, 'utf8')));
  }
  assert.deepEqual(found, [], `these act outside their right:\n  ${found.join('\n  ')}`);
});

test('the rights rule catches the provider constructing and App binding on its own', () => {
  // Its own negative controls: once the importer table widens in b3, this
  // rule is the only thing that stands between the provider and a runtime.
  assert.deepEqual(hostRights('src/lib/app/ServerScope.svelte', 'setServerScope({ runtime, state });'), []);
  assert.deepEqual(hostRights('src/lib/app/ServerScope.svelte', 'const rt = createServerRuntime(entry, deps);'), ['src/lib/app/ServerScope.svelte constructs']);
  assert.deepEqual(hostRights('src/App.svelte', 'setServerScope({ runtime, state });'), ['src/App.svelte binds a scope']);
  assert.deepEqual(hostRights('src/lib/hub/Hub.svelte', 'createServerState(store); setServerScope(x);'), ['src/lib/hub/Hub.svelte constructs', 'src/lib/hub/Hub.svelte binds a scope']);
});

test('a union list takes each action s runtime from its row, never from its context', async () => {
  // A list that spans servers has no single owner: one `useServerApi()` for
  // every row would send B's action to A, and in Single mode it would look
  // right. A component that projects a union acts through `onRow`.
  for await (const file of glob('src/**/*.svelte')) {
    const path = file.replaceAll('\\', '/');
    if (/\.test\.[a-z]+\.svelte$/u.test(path)) continue;
    const text = code(await readFile(file, 'utf8'));
    if (!importsModule(text, 'server-union')) continue;
    assert.doesNotMatch(text, /\buseServer(Api|Runtime|Scope)\(/u, `${path} projects a union and reads one api for it`);
  }
});
