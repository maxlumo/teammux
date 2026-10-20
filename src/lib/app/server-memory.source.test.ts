// Maintenance pin for the in-place switch (board 315): every module-level
// store under src/lib is either reset by App's resetServerMemory (it holds
// something of the server being left) or listed here as GLOBAL with the
// reason it cannot hold a server's data. A new module cache must pick a side.
// The behaviour proof is server-switch.test.ts; this only keeps the list honest.
//
// Since #335 ②b-2-1 there is a third side, and it is where every per-server
// store is moving: it belongs to a RUNTIME (`app/server-state.ts`), so it has
// NO module instance at all and goes away with its runtime instead of being
// reset. `IN_RUNTIME` lists them; a module instance of one is a second owner
// of the same keys and fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const LIB = new URL('../', import.meta.url);
const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
const reset = app.match(/function resetServerMemory\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';

/** file → store name → how a switch handles it. */
const PER_SERVER: Record<string, Record<string, RegExp>> = {
  'ui/hover.svelte.ts': { shown: /hoverCard\.hide\(\)/u, hiddenAt: /hoverCard\.hide\(\)/u },
};
/** Per-server stores that belong to a runtime: how the bundle builds the
 * field, and the module-level instance that would be a second owner of the
 * same keys. */
const IN_RUNTIME: Record<string, { file: string; built: string; instance: string }> = {
  prefs: { file: 'hub/hub-prefs.svelte.ts', built: 'createHubPrefs\\(storage', instance: 'createHubPrefs\\(' },
  // The notification centre's list (board #322); its popover and jump request
  // are this WINDOW's, `centreSurface` below. A log over NO storage owns no
  // key, so only a stored one counts.
  centre: { file: 'hub/notify-centre.svelte.ts', built: 'createCentre\\(createAlertLog\\(storage', instance: 'createAlertLog\\((?!null\\))' },
  // Files' memory and the download rows, TOGETHER (②a's ruling): parked cwds
  // keyed by session name, the one-writer claim per part, each attempt's
  // abort handle and settle, and the rows. Memory only, so no storage.
  files: { file: 'files/files-memory.ts', built: '\\{ memory: createFilesMemory\\(\\), downloads: createDownloads\\(\\) \\}', instance: '(?:createFilesMemory|createDownloads)\\(' },
  // The backends this server can spawn (#335 ②b-3): an instance per runtime
  // since the module catalog and its named exports were deleted. The frozen
  // fallback lists stay module-level because they describe what this BUILD
  // ships, not what a server serves.
  backends: { file: 'core/agents.ts', built: 'createBackendCatalog\\(\\)', instance: 'createBackendCatalog\\(' },
  // Review comments' notes, recipient generations and live composers (#434).
  review: { file: 'files/review-state.ts', built: 'createReviewState\\(\\)', instance: 'createReviewState\\(' },
};
const GLOBAL: Record<string, Record<string, string>> = {
  'core/markdown.ts': { cache: 'rendered HTML keyed by the message text itself', spanCache: 'the review span render, keyed by the file text itself (#434)' },
  'hub/hub.ts': { squashed: 'a WeakMap on message objects; the tree that holds them is gone' },
  'hub/reveal.ts': { inFlight: 'a WeakMap on DOM nodes' },
  'app/leave-guards.ts': { guards: 'instances unregister on unmount' },
  'app/shortcuts.svelte.ts': { state: 'a preference' },
  // The person's and the window's Hub preferences (feed level, tool-row cap,
  // sidebar collapse). ONE owner however many servers are on screen, which is
  // the point: a shared storage key is not shared state, and two live
  // instances must not disagree about the same human's app (#335 ②a-4).
  'hub/hub-prefs.svelte.ts': { appPrefs: 'the person\'s preferences, shared by every server' },
  // One bell, one popover, one jump request in flight, however many servers
  // are on screen: a second anchor would be two popovers in one corner, and a
  // per-server jump counter would let two requests both think they are
  // current. A switch resets it (`centreSurface.reset()`).
  'hub/notify-centre.svelte.ts': { centreSurface: 'this WINDOW\'s bell and popover' },
  // The notification mute switch's reactive face (board #423): the
  // person's choice, one key for every server, mirrored here so Settings,
  // the centre's Mute and both bells read the same fact.
  'hub/notify-switch.svelte.ts': { on: 'a preference', permission: 'this device\'s platform permission' },
  'app/terminal-prefs.svelte.ts': { state: 'a preference' },
  'app/layout.svelte.ts': { mode: 'a preference' },
  'app/server-mode.svelte.ts': { current: 'THIS computer\'s own server, not the connected one', started: 'one subscription per page' },
  'core/i18n.svelte.ts': { i18n: 'a preference' },
  'test/ssr.ts': { harness: 'test-only' },
};

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* walk(u);
    else if (/\.(ts|svelte)$/u.test(e.name) && !/\.test\.|fixture/u.test(e.name)) yield u;
  }
}

test('every module-level store is reset on a switch or named global (board 315)', async () => {
  const found: string[] = [];
  for await (const file of walk(LIB)) {
    const rel = decodeURIComponent(file.pathname.slice(LIB.pathname.length));
    let text = await readFile(file, 'utf8');
    if (rel.endsWith('.svelte')) text = (/<script module>([\s\S]*?)<\/script>/u.exec(text)?.[1] ?? '').replace(/^  /gmu, '');
    // Column 0 only: a module's own top level (a module script is dedented).
    // `= create<Something>()` is in the list because board #335 ②a turns
    // module stores into factories: a per-server store's state moves inside
    // its factory, where a column-0 scan cannot see it, so the INSTANCE has to
    // pick a side instead. Without this a conversion would quietly empty the
    // inventory this file exists to keep.
    const decl = /^(?:export )?(?:let|const) (\w+)\b[^=\n]*= (?:\$state\b|new (?:Map|Set|WeakMap|LruCache)\b|create[A-Z]\w*\(|null;|0;)/gmu;
    for (const m of text.matchAll(decl)) {
      const name = m[1]!;
      if (/^[A-Z_0-9]+$/u.test(name)) continue; // constants
      // The transport layer (board #335 ①). A connection's mutable state —
      // socket, pending, listeners, refcounts, ciphers, timers — lives on the
      // object `createConnection()` returns and is released by that object's
      // own disconnect()/dispose(), so it cannot be a module cache this list
      // is about. What stays module-level in ws.ts is the DEVICE reachability
      // memory (probeFailedAt), global by design: see
      // websocket-client.md § The transport is an object, not a module.
      if (/^core\/(ws|connection|ws-api|connection-registry)\.ts$/u.test(rel)) continue;
      // The mount harness (#357): `scopeFlags` is a TEST fixture's switch for what
      // the host says about a binding. It is imported only by the harness
      // entry, never by the app bundle, and each mounted fixture is its own
      // realm — so it is not a cache a server switch could leave stale.
      if (/^test\/mount-reactive\.svelte\.ts$/u.test(rel)) continue;
      found.push(`${rel}:${name}`);
      const per = PER_SERVER[rel]?.[name];
      const glob = GLOBAL[rel]?.[name];
      assert.ok(per || glob, `${rel}: module-level "${name}" must be reset by a switch or listed as GLOBAL`);
      if (per && !per.test(reset) && !/suspendDownloads/u.test(per.source)) {
        assert.fail(`${rel}:${name} is per-server but resetServerMemory does not reset it`);
      }
    }
  }
  for (const instance of [
    'hub/notify-centre.svelte.ts:centreSurface',
  ]) {
    assert.ok(found.includes(instance), `the scan sees the factory instance ${instance}`);
  }
  // Once the next server is up and bound (board #335 ②b-4, ruling (a)): the
  // one bring-up road runs the reset for every server change.
  assert.match(app, /const swapped = m\.keep \? Promise\.resolve\(\) : scopeSwap\.swap\(runtime\);\s*if \(replace\) \{\s*resetServerMemory\(\);\s*centreSurface\.reset\(\);/u, 'a server change runs the reset, after the next one is bound');
});

test('a store that belongs to a runtime has no module instance, and the bundle builds it (#335 ②b-2-1)', async () => {
  const bundle = await readFile(new URL('./server-state.ts', import.meta.url), 'utf8');
  for (const [field, { file, built, instance }] of Object.entries(IN_RUNTIME)) {
    assert.match(bundle, new RegExp(`\\b${field}: ${built}`, 'u'), `the bundle builds ${field}`);
    for await (const url of walk(LIB)) {
      const rel = decodeURIComponent(url.pathname.slice(LIB.pathname.length));
      if (rel === 'app/server-state.ts') continue;
      const text = await readFile(url, 'utf8');
      assert.doesNotMatch(text, new RegExp(`^(?:export )?(?:let|const) \\w+[^=\\n]*= (?:\\w+\\()*${instance}`, 'mu'),
        `${rel} holds a module instance — a second owner of ${file}'s per-server keys`);
    }
  }
  // Nothing re-reads them on a switch any more: the next server's bundle is a
  // new one, built once that server is current.
  assert.doesNotMatch(app, /reloadServerState/u);
});
