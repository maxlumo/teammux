// Maintenance pin for the runtime/fleet boundary (board #335 ②a-2). The
// behaviour proofs are server-fleet.test.ts; this file keeps the LAYERING
// honest, because each rule below is one line away from coming back and each
// would undo a different part of the design:
//
//   - the ws.ts facade inside a runtime → the runtime would reach the
//     compatibility slot's connection instead of its own, which is exactly the
//     "whichever server is current" bug phase ② exists to remove, and it would
//     be invisible as long as production holds one server.
//   - `localStorage` instead of the injected store → identity stops being
//     testable and a second runtime reads the first one's live keys.
//   - a write to CURRENT → recording a connection would move the focus, and a
//     background server could steal the screen (servers.ts: recording and
//     activating are different acts).
//   - an address used as a key → one machine would become two servers the
//     moment it answered on a second address (board #55).
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

test('a runtime uses its own connection, never the facade', async () => {
  for (const name of ['server-runtime.ts', 'server-fleet.ts']) {
    const src = code(await read(name));
    assert.doesNotMatch(src, /from ['"]\.\.\/core\/ws\.ts['"]/u,
      `${name} imports the ws.ts facade — a runtime must call through the api bound to ITS connection`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/u,
      `${name} reaches storage directly — the store is injected so identity stays testable and scoped`);
  }
});

test('a runtime records a connection but never moves the focus', async () => {
  const src = code(await read('server-runtime.ts'));
  // Every identity write goes through servers.ts, and none of them is an
  // activation: activateConnected / activateSwitched / pointTo / parkFrom all
  // move CURRENT or the live mirror keys, which is App's switch contract.
  assert.doesNotMatch(src, /tmux_server_current|CURRENT_KEY/u, 'CURRENT is not a runtime s to write');
  assert.doesNotMatch(src, /activateConnected|activateSwitched|pointTo|parkFrom/u,
    'a runtime records; activating a server is the switch path s act');
  assert.doesNotMatch(src, /setItem\(/u, 'and it writes storage only through servers.ts');
});

test('identity is the entry and the machine, never an address', async () => {
  const src = code(await read('server-fleet.ts'));
  // The fleet keys by ServerEntry.id and matches by machineId. An address
  // appearing here at all would mean a second notion of which server is which.
  assert.doesNotMatch(src, /\baddress\b|hostLabel|\burl\b/u,
    'the fleet must not look at addresses: one machine is one entry, however many addresses answer for it');
});
