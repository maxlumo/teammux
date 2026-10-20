// Maintenance pin for the connection layer's boundary (board #335 ①,
// reviewer r1 §1). The behaviour proofs are connection.test.ts,
// connection-registry.test.ts and connection-facade.test.ts; this file only
// keeps the LAYERING honest, because every rule below is one import away from
// quietly coming back and each would undo a different part of the design:
//
//   - storage or a Svelte store in connection.ts → the transport starts
//     deciding identity and focus, which is app/servers.ts's job.
//   - `window` in connection.ts → device state creeps back into a per-server
//     object (that is why the reachability cache stayed in ws.ts).
//   - a dial inside the registry → ensure() stops being free, and something
//     other than the caller decides when a server is contacted.
//   - a persisted facade slot key → the compatibility slot becomes a second
//     opinion on which server is current, the one thing it must never be.
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

test('connection.ts owns the transport and imports nothing above it', async () => {
  const src = code(await read('connection.ts'));
  assert.doesNotMatch(src, /localStorage|sessionStorage/u, 'persistence is the app layer s');
  assert.doesNotMatch(src, /\bwindow\b/u, 'device state (reachability, online events) stays in ws.ts');
  assert.doesNotMatch(src, /\$state\b|from ['"]svelte|\.svelte(\.ts)?['"]/u, 'no Svelte reactivity in the transport');
  assert.doesNotMatch(src, /from ['"]\.\.\/app\//u, 'the transport must not import the app layer');
  assert.doesNotMatch(src, /from ['"]\.\/ws(-api)?\.ts['"]/u, 'and never back through its own facade');
  // The whole point: mutable connection state is per object, not per module.
  const moduleLevel = src.split('\n').filter(l => /^(export )?(let|const) \w+/u.test(l));
  for (const line of moduleLevel) {
    assert.doesNotMatch(line, /new (Map|Set|WeakMap)\b/u,
      `module-level collection in connection.ts: "${line.trim()}" — per-connection state belongs inside createConnection()`);
    assert.doesNotMatch(line, /^(export )?let /u,
      `module-level mutable in connection.ts: "${line.trim()}" — per-connection state belongs inside createConnection()`);
  }
});

test('ws-api.ts declares each RPC once, against the connection it was handed', async () => {
  const src = code(await read('ws-api.ts'));
  // `window` as a WORD is a protocol field (a tmux window index); what must
  // not appear is the global.
  assert.doesNotMatch(src, /localStorage|\bwindow\s*\.|from ['"]\.\.\/app\//u);
  // Every wrapper reaches the wire through the handle's own `call`.
  assert.match(src, /const \{ call \} = connection;/u);
  assert.equal((src.match(/new WebSocket\(/gu) ?? []).length, 0, 'the API never opens a socket');
  const methods = [...src.matchAll(/\bcall<?[^>]*>?\(\s*'(\w+)'/gu)].map(m => m[1]);
  const duplicates = methods.filter((m, i) => methods.indexOf(m) !== i && m !== 'hub_log' && m !== 'hub_search');
  assert.deepEqual(duplicates, [], 'one declaration per RPC (hub_log and hub_search are each read two ways on purpose: a page or a window; messages or files)');
});

test('the registry owns lifetime only: it never dials and never guesses identity', async () => {
  const src = code(await read('connection-registry.ts'));
  assert.doesNotMatch(src, /localStorage|\bwindow\s*\.|from ['"]\.\.\/app\//u);
  assert.doesNotMatch(src, /\.connect\(/u, 'ensure() builds an IDLE connection; dialling is the caller s verb');
  assert.doesNotMatch(src, /machine|URL|address/iu, 'identity lives in app/servers.ts, not here');
  assert.doesNotMatch(src, /current|active/iu, 'the registry has no notion of a focused server');
});

test('every entry point that would mutate a disposed connection is guarded', async () => {
  const src = code(await read('connection.ts'));
  // dispose() is terminal (review P1-b). "It opens no socket" has a runtime
  // probe (connection.test.ts); "it accumulates no state on a dead object"
  // does not — nothing can observe a listener that can never fire. So the
  // guard itself is the contract, pinned here.
  assert.match(src, /^  let disposed = false;$/mu);
  assert.equal((src.match(/disposed = true/gu) ?? []).length, 1, 'nothing clears the flag');
  const guarded = [
    /function connect\([^)]*\): Promise<string \| null> \{\n    if \(disposed\) return rejectDisposed\(\);/u,
    /function call<.*>\(.*\): Promise<T> \{\n    if \(disposed\) return rejectDisposed<T>\(\);/u,
    /function disconnect\(\) \{\n    if \(disposed\) return;/u,
    /function dispose\(\) \{\n    if \(disposed\) return;/u,
    /function subscribe\(target: string\) \{\n    if \(disposed\) return;/u,
    /function unsubscribe\(target: string\) \{\n    if \(disposed\) return;/u,
    /function resubscribeActive\(\) \{\n    if \(disposed\) return;/u,
    /function addPaneOutputListener\([^)]*\) \{ if \(!disposed\) /u,
    /function addPaneClosedListener\([^)]*\) \{ if \(!disposed\) /u,
    /function addTeamMessageListener\(.*\) \{ if \(!disposed\) /u,
    /function setOnDisconnect\(.*\) \{ if \(!disposed\) /u,
  ];
  for (const re of guarded) assert.match(src, re, `missing disposed guard: ${re.source}`);
  // A dial in flight is part of the lifetime, not a detached timer (P1-a):
  // connect, disconnect and therefore dispose all end the unsettled ones.
  assert.match(src, /cancelDialing\('superseded by new connect'\);/u);
  assert.match(src, /cancelDialing\('disconnected'\);/u);
  assert.match(src, /dial\.timeout !== null\) clearTimeout\(dial\.timeout\)/u);
});

test('ws.ts holds NO connection and no second door, only the factories and the device cache (board #335 ②b-4)', async () => {
  const src = code(await read('ws.ts'));
  assert.doesNotMatch(src, /registry\.ensure\(|createConnection\(\)|Symbol\(/u, 'no slot of its own');
  assert.doesNotMatch(src, /localStorage|sessionStorage|tmux_/u, 'nothing persisted');
  // No duplicate transport: the one WebSocket here is the reachability probe.
  assert.equal((src.match(/new WebSocket\(/gu) ?? []).length, 1,
    'the one WebSocket in ws.ts is the reachability probe, not a second client');
  assert.doesNotMatch(src, /_cipher|pending\.set|requestId/u, 'no parallel socket bookkeeping');
  assert.doesNotMatch(src, /export const \{/u, 'no RPC or lifecycle re-exported off a connection');
  // The reachability cache is the documented exception and must stay keyed by
  // URL — a device fact, not a server's.
  assert.match(src, /const probeFailedAt = new Map<string, number>\(\);/u);
});

test('the handshake takes its inputs through ONE door each and decryptMsg has no plain mode (#393 round 4)', async () => {
  const src = code(await read('connection.ts'));
  // decryptMsg needs a real cipher: a null one used to return the frame's text as if it were
  // decrypted, which let a plain binary success pass for the sealed answer.
  const decrypt = src.match(/async function decryptMsg\(([^)]*)\)[^{]*\{[\s\S]*?\n\}/u);
  assert.ok(decrypt, 'decryptMsg exists');
  const [whole = '', params = ''] = decrypt;
  assert.match(params, /cipher: Cipher$/u, 'it takes a Cipher, not a Cipher | null');
  assert.doesNotMatch(whole, /!cipher|TextDecoder|typeof buf === 'string'/u, 'and has no branch that reads the frame as plain text');
  assert.doesNotMatch(src, /decryptMsg\([^)]*\bnull\b/u, 'nobody calls it with null');
  // The server's nonce reaches hexToBytes only through parseServerNonce (type, hex, length).
  assert.equal(src.match(/\bhexToBytes\(/gu)?.length, 2, 'hexToBytes: its definition and the one call inside parseServerNonce');
  assert.match(src, /function parseServerNonce\(raw: unknown\)[^{]*\{\s*return typeof raw === 'string' && \/\^\[0-9a-f\]\{32\}\$\/i\.test\(raw\)/u);
});
