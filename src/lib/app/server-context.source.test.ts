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
import { parse } from 'svelte/compiler';

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

/** The pages already bound to their scope (board #335 ②b-3), area by area.
 * Each takes its RPCs from `useServerApi()` / `useServerRuntime()`, so a value
 * import from the facade here would be a second, unbound way to the wire — the
 * call would go to "whichever server the facade is on", not to this subtree's.
 * Types still come from ws.ts. b3-4 deletes the facade's RPCs, and this list
 * with them. */
const BOUND = [
  // terminal/sessions
  'src/lib/terminal/Terminal.svelte', 'src/lib/sessions/Sessions.svelte', 'src/lib/sessions/PanePicker.svelte',
  'src/lib/sessions/SplitView.svelte', 'src/lib/app/ScratchPanel.svelte',
  // files
  'src/lib/files/Files.svelte', 'src/lib/files/GitPanel.svelte', 'src/lib/files/DirPicker.svelte',
  // hub
  'src/lib/hub/Hub.svelte', 'src/lib/hub/Board.svelte', 'src/lib/hub/ChatImage.svelte',
  'src/lib/projects/Projects.svelte', 'src/lib/projects/CreateProjectDialog.svelte',
  'src/lib/hub/AgentsPage.svelte',
  // Not a component: it takes the api its host read (StagerHost.api).
  'src/lib/hub/attachments.svelte.ts',
];
/** The value names a file imports from core/ws (type-only imports excluded). */
function facadeValues(text: string): string[] {
  const out: string[] = [];
  for (const m of code(text).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[./]*(?:lib\/)?core\/ws(?:\.ts)?'/gu)) {
    if (m[1]) continue;
    for (const name of m[2]!.split(',').map((n) => n.trim()).filter(Boolean)) if (!name.startsWith('type ')) out.push(name);
  }
  return out;
}

test('a page bound to its scope takes no RPC from the facade', async () => {
  for (const file of BOUND) {
    const text = await readFile(file, 'utf8');
    const values = facadeValues(text);
    assert.deepEqual(values, [], `${file} imports ${values.join(', ')} from core/ws — take it from the scope`);
    // Nor its server's id from CURRENT (reviewer P1 on the b3 binding range):
    // "the server that is current" is not "the server this page is bound
    // to" once two are on screen; the scope's runtime says which.
    assert.doesNotMatch(code(text), /\bcurrentServerId\b/u, `${file} reads CURRENT — take the id from the scope`);
  }
  assert.deepEqual(facadeValues("import { listPanes, type TmuxPane } from '../core/ws.ts';"), ['listPanes'], 'the rule sees a value import');
  assert.deepEqual(facadeValues("import type { TmuxPane } from '../core/ws.ts';"), [], 'and lets a type through');
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
  // Decided on the parsed script, not on lines (reviewer P2-a on b1-3): two
  // reads on one line are two reads, and `const later = () => useServerApi()`
  // starts like an init and reads in a handler.
  for await (const file of glob('src/**/*.svelte')) {
    const text = await readFile(file, 'utf8');
    if (!/\buseServer(Api|Id|Runtime|Scope)\b/u.test(text)) continue;
    // A test consumer exists to observe both answers, so it may read twice.
    const problems = contextReads(text, { once: !/\.test\.[a-z]+\.svelte$/u.test(file) });
    assert.deepEqual(problems, [], `${file}: ${problems.join('; ')}`);
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

/** What is wrong with a component's context reads: each must be the whole
 * initializer of a top-level declaration of the instance script, and (with
 * `once`) there is at most one. A module script and the markup read none. */
function contextReads(source: string, { once }: { once: boolean }): string[] {
  const ast = parse(source, { modern: true }) as unknown as {
    instance?: { content: { body: Node[] } }; module?: { content: Node }; fragment: Node;
  };
  type Node = { type: string; [key: string]: unknown };
  const isRead = (n: Node) => n.type === 'CallExpression'
    && (n.callee as Node)?.type === 'Identifier' && /^useServer(Api|Id|Runtime|Scope)$/u.test(String((n.callee as Node).name));
  const calls = (root: unknown): Node[] => {
    const out: Node[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as Node;
      if (typeof node.type === 'string' && isRead(node)) out.push(node);
      for (const [k, v] of Object.entries(node)) if (k !== 'parent' && k !== 'loc' && k !== 'metadata') walk(v);
    };
    walk(root);
    return out;
  };
  const problems: string[] = [];
  if (ast.module && calls(ast.module.content).length) problems.push('a module script has no context to read');
  // The markup is never init: `onclick={() => useServerApi()}` reads in a
  // handler (reviewer P2 on 0a5db703).
  if (calls(ast.fragment).length) problems.push('the markup reads the context — read it once in the script');
  const body = ast.instance?.content.body ?? [];
  const all = calls(body);
  const atInit = new Set<Node>();
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations as Node[]) {
      let init = d.init as Node | null;
      // `useServerScope().state`, `useServerScope()?.state ?? null`,
      // `useServerApi() as Api`: still the read itself, at init.
      for (;;) {
        if (init && (init.type === 'TSAsExpression' || init.type === 'TSNonNullExpression')) init = init.expression as Node;
        else if (init && init.type === 'MemberExpression') init = init.object as Node;
        else if (init && init.type === 'ChainExpression') init = init.expression as Node;
        else if (init && init.type === 'LogicalExpression') init = init.left as Node;
        else break;
      }
      if (init && isRead(init)) atInit.add(init);
    }
  }
  for (const c of all) if (!atInit.has(c)) problems.push(`useServer…() read outside a top-level declaration (offset ${String(c.start)})`);
  if (once && all.length > 1) problems.push(`${all.length} context reads — read it once, into one local const`);
  return problems;
}

test('the init-read rule reads the script, not its lines (reviewer P2-a on b1-3)', () => {
  const wrap = (body: string) => `<script lang="ts">\n${body}\n</script>`;
  assert.deepEqual(contextReads(wrap('const api = useServerApi();'), { once: true }), [], 'the one legitimate shape');
  assert.deepEqual(contextReads(wrap('const scope = useServerScope() as Scope;'), { once: true }), [], 'with a type assertion');
  assert.deepEqual(contextReads(wrap('const { prefs } = useServerScope().state;'), { once: true }), [], 'a member of the read');
  assert.deepEqual(contextReads(wrap('const of = useServerScope()?.state?.of ?? null;'), { once: true }), [], 'an optional chain with a default');
  assert.ok(contextReads(wrap('const x = ready ?? useServerApi();'), { once: true }).length, 'but not a read on the RIGHT of a default');
  assert.ok(contextReads(wrap('const api = useServerApi(); const rt = useServerRuntime();'), { once: true }).some((p) => /2 context reads/u.test(p)),
    'two reads on ONE line are two reads');
  assert.ok(contextReads(wrap('const later = () => useServerApi();'), { once: true }).some((p) => /outside a top-level/u.test(p)),
    'a deferred read that starts like an init is not one');
  assert.ok(contextReads(wrap('function onClick() { const api = useServerApi(); }'), { once: true }).length, 'a handler');
  assert.ok(contextReads(wrap('$effect(() => { useServerScope(); });'), { once: true }).length, 'an effect');
  assert.ok(contextReads(wrap('const { api } = { api: useServerApi() };'), { once: true }).length, 'nested in an initializer');
  assert.ok(contextReads('<script module>\nconst api = useServerApi();\n</script>', { once: true }).length, 'a module script');
  assert.ok(contextReads(`${wrap('')}\n<button onclick={() => useServerApi()}>x</button>`, { once: true }).some((p) => /markup/u.test(p)),
    'a handler in the markup (reviewer P2 on 0a5db703)');
  assert.ok(contextReads(`${wrap('')}\n{#if useServerScope()}x{/if}`, { once: true }).some((p) => /markup/u.test(p)), 'a block in the markup');
});

test('a server s backend list has no module-level owner (board #335 ②b-3)', async () => {
  // The catalog is one machine's answer, so each runtime's state holds one and
  // a page reads it from its scope; a pure helper takes it as a parameter. A
  // module-level catalog (or the named exports that fronted it) would be a
  // second answer to "what can THIS server spawn", shared by every server.
  const agents = code(await readFile('src/lib/core/agents.ts', 'utf8'));
  assert.doesNotMatch(agents, /^export const \w+ = createBackendCatalog\(/mu, 'no module catalog');
  assert.doesNotMatch(agents, /^export (const|function) (setServedBackends|onServedBackends|servedBackendsKnown|spawnableBackends|defaultBackend|backendEfforts|backendSwitchesInputMode|backendTogglesInputMode|backendColorToken|backendIcon)\b/mu,
    'and no named front for one');
  // Preferences' embedded editor is bound by a guest scope, keyed like App's.
  const prefs = await readFile('src/lib/app/Preferences.svelte', 'utf8');
  assert.match(prefs, /\{#key guestRuntime\}\s*<ServerScope runtime=\{guestRuntime\} state=\{guestState\}>\s*<AgentsPage/u);
});
