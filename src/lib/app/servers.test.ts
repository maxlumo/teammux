import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_KEY, MAX_SERVERS, MERGES_KEY, SERVERS_KEY, mergedInto, residentKey,
  activateConnected, activateSwitched, adoptHostname, currentServerId, currentServerName, RESIDENT_KEYS, hostLabel, loadServers,
  migrateServers, recordServer, removeServer, renameServer, saveMachineAddresses, MOVES_KEY, resumeSlotMove,
} from './servers.ts';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

test('hostLabel names a server by its host, keeping typed fallbacks', () => {
  assert.equal(hostLabel('ws://192.168.1.5:9899'), '192.168.1.5');
  assert.equal(hostLabel('wss://mac.tail.ts.net/ws'), 'mac.tail.ts.net');
  assert.equal(hostLabel('  wss://host:443  '), 'host');
  assert.equal(hostLabel('not-an-address'), 'not-an-address');
});

test('migration: the current connection becomes the first, CURRENT entry; history follows', () => {
  const s = mem({
    tmux_address: 'ws://10.0.0.2:9899',
    tmux_token: 'tokA',
    tmux_socket: '/tmp/sockA',
    tmux_address_history: JSON.stringify([
      { address: 'ws://10.0.0.2:9899', token: 'stale' },   // covered by current — skipped
      { address: 'wss://other.example/ws', token: 'tokB' },
      'ws://legacy-string:9899',                            // old string format
    ]),
  });
  const servers = migrateServers(s);
  assert.equal(servers.length, 3);
  assert.equal(servers[0]!.address, 'ws://10.0.0.2:9899');
  assert.equal(servers[0]!.token, 'tokA');
  assert.equal(servers[0]!.socket, '/tmp/sockA');
  assert.equal(servers[0]!.name, '10.0.0.2');
  assert.equal(currentServerId(s), servers[0]!.id, 'the current user is not lost');
  assert.equal(servers[1]!.address, 'wss://other.example/ws');
  assert.equal(servers[2]!.token, '');
  // The mirror keys are untouched: the boot path still reads them.
  assert.equal(s.getItem('tmux_address'), 'ws://10.0.0.2:9899');
});

test('migration is idempotent — an existing registry is returned, never rebuilt', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: 't' });
  const first = migrateServers(s);
  s.setItem('tmux_address', 'ws://changed:2'); // later drift must not re-run it
  const second = migrateServers(s);
  assert.deepEqual(second, first);
});

test('migration with no stored connection yields an empty registry and no current', () => {
  const s = mem();
  assert.deepEqual(migrateServers(s), []);
  assert.equal(currentServerId(s), '');
  assert.equal(s.getItem(SERVERS_KEY), '[]', 'the marker exists so it never re-runs');
});

test('loadServers drops malformed rows, duplicate ids, and respects the cap', () => {
  const good = { id: 'a', name: 'A', address: 'ws://a:1', token: 't' };
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      good, { id: 'a', name: 'dup', address: 'ws://dup:1', token: '' },
      { id: 'b', address: 'ws://b:1' },            // name/token missing → defaulted
      { id: 'c' }, 'junk', null,                   // dropped
    ]),
  });
  const servers = loadServers(s);
  assert.equal(servers.length, 2);
  assert.equal(servers[1]!.name, 'b', 'name defaults to the host label');
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `${i}`, address: `ws://h${i}:1`, token: '' }));
  s.setItem(SERVERS_KEY, JSON.stringify(many));
  assert.equal(loadServers(s).length, MAX_SERVERS);
  s.setItem(SERVERS_KEY, '{not json');
  assert.deepEqual(loadServers(s), []);
});

test('same machine, three addresses = ONE config (lead review, board #55)', () => {
  // tmux_machines is the identity authority: LAN/Tailscale/WAN alternates of
  // the CURRENT machine must not re-materialize from history as separate
  // "servers" — they are the failover set the switch hands back to.
  const s = mem({
    tmux_address: 'ws://192.168.1.5:9899',
    tmux_token: 'tok',
    tmux_machine_id: 'm1',
    tmux_machines: JSON.stringify({ m1: ['ws://192.168.1.5:9899', 'wss://mac.tail.ts.net/ws', 'wss://wan.example:443'] }),
    tmux_address_history: JSON.stringify([
      { address: 'wss://mac.tail.ts.net/ws', token: 'tok' },
      { address: 'wss://wan.example:443', token: 'tok' },
      { address: 'ws://192.168.1.5:9899', token: 'tok' },
    ]),
  });
  const servers = migrateServers(s);
  assert.equal(servers.length, 1, 'the machine is one entry, not three');
  assert.equal(servers[0]!.machineId, 'm1');
  assert.equal(servers[0]!.address, 'ws://192.168.1.5:9899', 'the live address is the active one');
});

test('different machines never merge, however alike their addresses look', () => {
  const s = mem({
    tmux_address: 'ws://10.0.0.2:9899',
    tmux_token: 'ta',
    tmux_machine_id: 'm1',
    tmux_machines: JSON.stringify({ m1: ['ws://10.0.0.2:9899'], m2: ['ws://10.0.0.2:9900'] }),
    tmux_address_history: JSON.stringify([{ address: 'ws://10.0.0.2:9900', token: 'tb' }]),
  });
  const servers = migrateServers(s);
  assert.equal(servers.length, 2, 'same host shape, different machineId — separate entries');
  assert.equal(servers[0]!.machineId, 'm1');
  assert.equal(servers[1]!.machineId, 'm2');
  // hostLabel collides ('10.0.0.2' both) — identity is the machine, not the label.
  assert.equal(servers[0]!.name, servers[1]!.name);
});

test('a history machine seen for the first time yields ONE entry across its addresses', () => {
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm1',
    tmux_machines: JSON.stringify({ m1: ['ws://a:1'], m2: ['ws://b-lan:2', 'wss://b-wan:443'] }),
    tmux_address_history: JSON.stringify([
      { address: 'ws://b-lan:2', token: 'tb' },
      { address: 'wss://b-wan:443', token: 'tb' },
    ]),
  });
  const servers = migrateServers(s);
  assert.equal(servers.length, 2);
  assert.equal(servers[1]!.machineId, 'm2');
  assert.equal(servers[1]!.address, 'ws://b-lan:2', 'first-seen address is the active one');
});

test('recordServer NEVER moves CURRENT — recording and activating are different acts', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: 'ta' });
  migrateServers(s);
  const aId = currentServerId(s);
  const { entry } = recordServer(s, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' });
  assert.equal(loadServers(s).length, 2, 'the new server is recorded');
  assert.notEqual(entry.id, aId);
  assert.equal(currentServerId(s), aId, 'CURRENT did not move (lead blocker #2)');
});

test('recordServer merges by machine identity across addresses and keeps renames', () => {
  const s = mem();
  migrateServers(s);
  recordServer(s, { address: 'ws://192.168.1.5:9899', token: 't', machineId: 'm1' });
  renameServer(s, loadServers(s)[0]!.id, 'my mac');
  const { servers } = recordServer(s, { address: 'wss://mac.tail.ts.net/ws', token: 't2', machineId: 'm1' });
  assert.equal(servers.length, 1, 'machineId match merges, address difference notwithstanding');
  assert.equal(servers[0]!.address, 'wss://mac.tail.ts.net/ws', 'active address follows the connect');
  assert.equal(servers[0]!.token, 't2');
  assert.equal(servers[0]!.name, 'my mac', 'rename survives reconnects');
  // A pre-connect entry (no machineId yet) gets stamped by an address match:
  recordServer(s, { address: 'ws://new:1', token: 'x' });
  const { servers: stamped } = recordServer(s, { address: 'ws://new:1', token: 'x', machineId: 'm2' });
  assert.equal(stamped.length, 2);
  assert.equal(stamped[1]!.machineId, 'm2', 'address match stamps the learned machineId');
});

test('recordServer attributes an address through tmux_machines when no machineId is given', () => {
  // A deep link carries no machineId; the failover map still knows whose
  // address it is — an alternate of a known machine folds into that entry.
  const s = mem({
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'wss://a-wan:443'] }),
  });
  recordServer(s, { address: 'ws://a-lan:1', token: 't' });
  const { servers, entry } = recordServer(s, { address: 'wss://a-wan:443', token: 't' });
  assert.equal(servers.length, 1, 'the map attribution merged the alternate');
  assert.equal(entry.machineId, 'm-a', 'and stamped the identity');
});

test('activateConnected: the SAME server (machine alternate) needs no reboot', () => {
  const s = mem({
    tmux_address: 'ws://a-lan:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'wss://a-wan:443'] }),
    tmux_state: '{"page":"hub"}',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  const act = activateConnected(s, { address: 'wss://a-wan:443', token: 'ta', machineId: 'm-a' });
  assert.equal(act.reload, false, 'same machine — the socket swap was the whole event');
  assert.equal(currentServerId(s), aId, 'CURRENT unchanged');
  assert.equal(s.getItem('tmux_state'), '{"page":"hub"}', 'live state untouched');
  assert.equal(loadServers(s).length, 1, 'still one entry');
});

test('activateConnected: a DIFFERENT server becomes CURRENT, and nothing is filed or surfaced (board #335 ②b-4)', () => {
  // Each server's state is in its own slots already, so arriving is only
  // moving CURRENT. The legacy live keys are inputs for the fold: nothing
  // writes them, the machine id included (it is the frozen legacy mirror).
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
    tmux_state: '{"page":"board"}',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  s.setItem(residentKey('tmux_state', aId), '{"page":"files"}');
  s.setItem('tmux_address', 'ws://b:2');       // the connect form wrote the mirror keys pre-dial
  s.setItem('tmux_token', 'tb');
  s.setItem('tmux_disconnected', '1');
  const act = activateConnected(s, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' });
  assert.equal(act.reload, true, 'different machine — the caller brings the app up as a switch');
  const bEntry = loadServers(s).find((x) => x.address === 'ws://b:2')!;
  assert.equal(currentServerId(s), bEntry.id, 'B is current');
  assert.equal(s.getItem(residentKey('tmux_state', aId)), '{"page":"files"}', 'A s slot untouched');
  assert.equal(s.getItem(residentKey('tmux_state', bEntry.id)), null, 'B s slot untouched: B starts fresh');
  assert.equal(s.getItem('tmux_state'), '{"page":"board"}', 'the legacy live key is not touched');
  assert.equal(s.getItem('tmux_machine_id'), 'm-a', 'nor the legacy machine id');
  assert.equal(s.getItem('tmux_disconnected'), null, 'connecting IS the intent');
});

test('removeServer refuses the current entry and clears the others  slots', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: '' });
  migrateServers(s);
  const a = loadServers(s)[0]!;
  const { entry: b } = recordServer(s, { address: 'ws://b:2', token: '' });
  for (const key of RESIDENT_KEYS) s.setItem(residentKey(key, b.id), `${key} of b`);
  assert.equal(removeServer(s, a.id).length, 2, 'current is not removable');
  const left = removeServer(s, b.id);
  assert.equal(left.length, 1);
  for (const key of RESIDENT_KEYS) assert.equal(s.getItem(residentKey(key, b.id)), null, `${key} goes with the entry`);
});

// --- The in-place switch's storage half (board 315; since #335 ②b-4 it is
// only moving CURRENT — the layer proof is server-state.test.ts) ----------

test('activateSwitched: a candidate becomes current only by the identity it reported', () => {
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:1'] }), tmux_disconnected: '1',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  s.setItem(residentKey('tmux_state', aId), '{"page":"hub"}');
  // A NEW address that turns out to be machine A (its Tailscale name): it
  // folds into A's entry, never a second server.
  const same = activateSwitched(s, { address: 'ws://a-ts:9', token: 'ta', machineId: 'm-a' });
  assert.equal(same.id, aId);
  assert.equal(loadServers(s).length, 1);
  assert.equal(currentServerId(s), aId);
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!)['m-a'], ['ws://a:1', 'ws://a-ts:9'], 'the address joins the failover set');
  assert.equal(s.getItem('tmux_address'), 'ws://a-ts:9', 'the mirror follows only after auth');
  assert.equal(s.getItem('tmux_disconnected'), null);
  // A genuinely new machine gets its own entry, and CURRENT moves to it.
  const b = activateSwitched(s, { address: 'ws://b:2', token: 'tb', socket: '/sb', machineId: 'm-b' });
  assert.notEqual(b.id, aId);
  assert.equal(currentServerId(s), b.id);
  assert.equal(s.getItem('tmux_socket'), '/sb');
  assert.equal(s.getItem(residentKey('tmux_state', aId)), '{"page":"hub"}', 'A s slot untouched by B s activation');
  assert.equal(s.getItem(residentKey('tmux_state', b.id)), null, 'and B s is its own');
  assert.equal(s.getItem('tmux_machine_id'), 'm-a', 'the legacy machine id is written by nothing');
});

test('RESIDENT_KEYS names exactly the Hub prefs that are per project (per server)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../hub/hub-prefs.svelte.ts', import.meta.url), 'utf8');
  const keyOf = (name: string) => new RegExp(`const ${name} = '([^']+)'`, 'u').exec(src)?.[1];
  const list = /HUB_SERVER_KEYS = \[([^\]]+)\]/u.exec(src)?.[1]?.split(',').map((x) => keyOf(x.trim())) ?? [];
  assert.ok(list.length >= 4, 'hub-prefs names its per-server keys');
  for (const key of list) assert.ok((RESIDENT_KEYS as readonly string[]).includes(key!), `${key} is resident per server`);
});

test('a merge hands the CURRENT twin s slots to the survivor (board #335 ②b-4)', () => {
  // The current twin's slots are what the person was just using on that
  // machine; before ②b-4 they were the live keys and simply stayed live.
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'alias', name: 'home', address: 'ws://a:1', token: 't' },
      { id: 'canon', name: 'canonical', address: 'ws://a-ts:2', token: 't', machineId: 'm-a' },
    ]),
    [CURRENT_KEY]: 'alias',
    [residentKey('tmux_state', 'alias')]: 'alias nav',
    [residentKey('tmux_hub_drafts', 'alias')]: 'alias drafts',
    [residentKey('tmux_state', 'canon')]: 'older canon nav',
    [residentKey('tmux_hub_seen', 'canon')]: 'older canon seen',
  });
  recordServer(s, { address: 'ws://a:1', token: 't', machineId: 'm-a' });
  assert.equal(currentServerId(s), 'canon', 'CURRENT followed the merge');
  assert.equal(s.getItem(residentKey('tmux_state', 'canon')), 'alias nav', 'the current twin s state is the survivor s now');
  assert.equal(s.getItem(residentKey('tmux_hub_drafts', 'canon')), 'alias drafts');
  // Merged, not copied whole (board #335 ③b; orchestrator 15:04): what the
  // twin did not have is the survivor's still — under Aggregate the survivor
  // is a live member with its own state — and the survivor's value the
  // twin's replaced is recorded, not lost.
  assert.equal(s.getItem(residentKey('tmux_hub_seen', 'canon')), 'older canon seen', 'a missing source never deletes');
  assert.deepEqual(JSON.parse(s.getItem('tmux_slot_conflicts')!), [{ from: 'alias', to: 'canon', key: 'tmux_state', value: 'older canon nav' }],
    'the current twin won the real conflict; the survivor s value is recorded');
  for (const key of RESIDENT_KEYS) assert.equal(s.getItem(residentKey(key, 'alias')), null, `the alias s ${key} went with it`);
});

test('a merge of a twin that was NOT current keeps the survivor s slots', () => {
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'canon', name: 'canonical', address: 'ws://a-ts:2', token: 't', machineId: 'm-a' },
      { id: 'alias', name: 'home', address: 'ws://a:1', token: 't' },
    ]),
    [CURRENT_KEY]: 'canon',
    [residentKey('tmux_state', 'alias')]: 'alias nav',
    [residentKey('tmux_state', 'canon')]: 'canon nav',
  });
  recordServer(s, { address: 'ws://a:1', token: 't', machineId: 'm-a' });
  assert.equal(s.getItem(residentKey('tmux_state', 'canon')), 'canon nav');
  assert.equal(s.getItem(residentKey('tmux_state', 'alias')), null);
});

test('removeServer with a vanished id is a harmless no-op (stale confirm, board #55)', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: 'ta' });
  migrateServers(s);
  const before = loadServers(s);
  assert.equal(removeServer(s, 'gone-id').length, before.length, 'nothing filtered');
  assert.deepEqual(loadServers(s), before, 'registry byte-identical');
});

test('saveMachineAddresses: a drag-reorder persists the new priority order (board #222)', () => {
  const s = mem({
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'wss://a-wan:443'], 'm-b': ['ws://b:2'] }),
  });
  const written = saveMachineAddresses(s, 'm-a', ['wss://a-wan:443', 'ws://a-lan:1']);
  assert.deepEqual(written, ['wss://a-wan:443', 'ws://a-lan:1']);
  const map = JSON.parse(s.getItem('tmux_machines')!);
  assert.deepEqual(map['m-a'], ['wss://a-wan:443', 'ws://a-lan:1'], 'order IS the failover priority');
  assert.deepEqual(map['m-b'], ['ws://b:2'], 'other machines untouched');
});

test('saveMachineAddresses: removing an address shrinks the set; the last one drops the key', () => {
  const s = mem({
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'wss://a-wan:443'] }),
  });
  saveMachineAddresses(s, 'm-a', ['ws://a-lan:1']);
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!)['m-a'], ['ws://a-lan:1']);
  const written = saveMachineAddresses(s, 'm-a', []);
  assert.deepEqual(written, []);
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!), {}, 'an empty set leaves no key behind');
});

test('saveMachineAddresses sanitizes at the door: dedupe, drop blanks, keep first-seen order', () => {
  const s = mem();
  const written = saveMachineAddresses(s, 'm-a', ['ws://a:1', '', 'ws://a:1', 'ws://b:2']);
  assert.deepEqual(written, ['ws://a:1', 'ws://b:2']);
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!)['m-a'], ['ws://a:1', 'ws://b:2']);
});

test('saveMachineAddresses refuses a missing machine id and an unreadable map', () => {
  const s = mem({ tmux_machines: '{broken' });
  assert.deepEqual(saveMachineAddresses(s, '', ['ws://a:1']), [], 'no machine id, no write');
  assert.equal(s.getItem('tmux_machines'), '{broken', 'no machine id — the map is untouched');
  const written = saveMachineAddresses(s, 'm-a', ['ws://a:1']);
  assert.deepEqual(written, ['ws://a:1'], 'an unreadable map is replaced, not crashed on');
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!), { 'm-a': ['ws://a:1'] });
});

// Board #310 (owner 2026-10-05: "显示的名称应该默认是主机的名称，不是连接的url").
test('adoptHostname: a default name becomes the hostname the server reports; a typed name never does', () => {
  const base = { id: 'a', address: 'wss://d1x.cloudfront.net/tmuxmobile-x/ws', token: 't', machineId: 'm' };
  const fresh = [{ ...base, name: 'd1x.cloudfront.net' }];
  const adopted = adoptHostname(fresh, 'a', 'macmini');
  assert.equal(adopted[0]!.name, 'macmini', 'the URL host was only a placeholder');
  assert.equal(adopted[0]!.hostname, 'macmini');
  assert.notEqual(adopted, fresh, 'a new array when something changed');
  assert.equal(adoptHostname(adopted, 'a', 'macmini'), adopted, 'the same hostname twice changes nothing');
  // The address changes (failover to the LAN address): the adopted name stays.
  const moved = [{ ...adopted[0]!, address: 'ws://192.168.11.221:9899' }];
  assert.equal(adoptHostname(moved, 'a', 'macmini'), moved);
  // The host is renamed on the server: an adopted name follows it.
  assert.equal(adoptHostname(moved, 'a', 'studio')[0]!.name, 'studio');
  // A name the user typed is never overwritten, flagged or (pre-#310) not.
  const typed = [{ ...base, name: 'My Mac', named: true as const }];
  assert.equal(adoptHostname(typed, 'a', 'macmini'), typed);
  const legacy = [{ ...base, name: 'My Mac' }];
  assert.equal(adoptHostname(legacy, 'a', 'macmini'), legacy, 'an old hand rename has no flag but is not the default');
  // Nothing to adopt.
  assert.equal(adoptHostname(fresh, 'a', ''), fresh);
  assert.equal(adoptHostname(fresh, 'a', '   '), fresh);
  assert.equal(adoptHostname(fresh, 'nope', 'macmini'), fresh);
});

test('renameServer marks the name as typed, and the flag survives a reload (#310)', () => {
  const s = mem({ [SERVERS_KEY]: JSON.stringify([{ id: 'a', name: 'ws-host', address: 'ws://ws-host:9899', token: '' }]) });
  renameServer(s, 'a', 'Desk');
  const [entry] = loadServers(s);
  assert.equal(entry!.named, true);
  assert.equal(adoptHostname([entry!], 'a', 'macmini')[0]!.name, 'Desk');
});

// --- One entry per address and per machine (board 318) ----------------------

const CF = 'wss://d2luxl1l4s727q.cloudfront.net/tmuxmobile-i9pfjx56gbvq';

test('the owner’s ghost twin: an authenticated connect folds the machine-less entry with the same address', () => {
  // Exactly the screenshot: the current entry knows its machine; a migrated
  // twin holds the same address, named after the URL host, no machine id.
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'cur', name: 'dev-dsk-cfu', address: CF, token: 't', machineId: 'm-dev', hostname: 'dev-dsk-cfu' },
      { id: 'mini', name: 'macmini.local', address: 'ws://127.0.0.1:9899', token: 't2', machineId: 'm-mini' },
      { id: 'ghost', name: 'd2luxl1l4s727q.cloudfront.net', address: CF, token: 'old' },
    ]),
    [CURRENT_KEY]: 'cur',
    'tmux_state::ghost': '{"page":"hub"}',
  });
  const { servers, entry } = recordServer(s, { address: CF, token: 't', machineId: 'm-dev' });
  assert.equal(entry.id, 'cur');
  assert.deepEqual(servers.map((x) => x.id), ['cur', 'mini'], 'the twin is gone, the other server untouched');
  assert.equal(loadServers(s).find((x) => x.id === 'cur')!.name, 'dev-dsk-cfu', 'the survivor keeps its name');
  assert.equal(currentServerId(s), 'cur');
  assert.equal(s.getItem('tmux_state::ghost'), null, 'the twin’s parked state goes with it');
});

test('a twin that was CURRENT hands CURRENT to the survivor; a typed name survives a default one', () => {
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'a', name: 'a.lan', address: 'ws://a.lan:1', token: 't', machineId: 'm-a' },
      { id: 'b', name: 'My laptop', named: true, address: 'ws://a.lan:1', token: 't' },
    ]),
    [CURRENT_KEY]: 'b',
  });
  const { entry } = recordServer(s, { address: 'ws://a.lan:1', token: 't', machineId: 'm-a' });
  assert.equal(entry.id, 'a');
  assert.equal(loadServers(s).length, 1);
  assert.equal(currentServerId(s), 'a', 'CURRENT followed the survivor');
  assert.equal(loadServers(s)[0]!.name, 'My laptop', 'the user’s name is not lost to a default');
});

test('repair on boot heals an existing list once, and is idempotent', () => {
  const list = [
    { id: 'cur', name: 'dev-dsk-cfu', hostname: 'dev-dsk-cfu', address: CF, token: 't', machineId: 'm-dev' },
    { id: 'ghost', name: 'd2luxl1l4s727q.cloudfront.net', address: CF, token: 'old' },
    { id: 'alt', name: 'dev (lan)', named: true, address: 'ws://10.0.0.5:9899', token: 't', machineId: 'm-dev' },
    { id: 'other', name: 'mini', address: 'ws://127.0.0.1:9899', token: 't2', machineId: 'm-mini' },
  ];
  const s = mem({ [SERVERS_KEY]: JSON.stringify(list), [CURRENT_KEY]: 'cur' });
  const healed = migrateServers(s);
  assert.deepEqual(healed.map((x) => x.id), ['cur', 'other'], 'same address and same machine both fold into the current entry');
  assert.equal(healed[0]!.name, 'dev (lan)', 'a typed name on a twin replaces an adopted (default) one');
  const once = s.getItem(SERVERS_KEY);
  let writes = 0;
  const watch = { ...s, setItem: (k: string, v: string) => { writes++; s.setItem(k, v); } };
  assert.deepEqual(migrateServers(watch).map((x) => x.id), ['cur', 'other']);
  assert.equal(writes, 0, 'a healthy list is not rewritten');
  assert.equal(s.getItem(SERVERS_KEY), once);
});

test('no regression of #55: two addresses of one machine stay ONE entry, two machines stay two', () => {
  const s = mem({ tmux_address: 'ws://a-lan:1', tmux_token: 't', tmux_machine_id: 'm-a',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'ws://a-ts:2'] }) });
  migrateServers(s);
  recordServer(s, { address: 'ws://a-ts:2', token: 't', machineId: 'm-a' });
  recordServer(s, { address: 'ws://b:3', token: 'tb', machineId: 'm-b' });
  const list = loadServers(s);
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.machineId === 'm-a')!.address, 'ws://a-ts:2');
});

test('two different known machines that used the same address both stay — boot repair (validator, board 318)', () => {
  const L = 'ws://127.0.0.1:9899';
  const list = [
    { id: 'a', name: '127.0.0.1', address: L, token: 'ta', machineId: 'm-a' },
    { id: 'b', name: 'build box', named: true, address: L, token: 'tb', machineId: 'm-b' },
  ];
  const s = mem({ [SERVERS_KEY]: JSON.stringify(list), [CURRENT_KEY]: 'a', 'tmux_state::b': '{"page":"files"}' });
  const out = migrateServers(s);
  assert.deepEqual(out.map((x) => [x.id, x.name, x.token, x.machineId]),
    [['a', '127.0.0.1', 'ta', 'm-a'], ['b', 'build box', 'tb', 'm-b']], 'both kept, names and tokens untouched');
  assert.equal(s.getItem('tmux_state::b'), '{"page":"files"}');
  assert.equal(currentServerId(s), 'a');
});

test('two different known machines on one address both stay — recordServer, and B never takes over A', () => {
  const L = 'ws://127.0.0.1:9899';
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'a', name: 'mac mini', named: true, address: L, token: 'ta', machineId: 'm-a' },
      { id: 'b', name: 'b', address: 'ws://b:2', token: 'tb', machineId: 'm-b' },
    ]),
    [CURRENT_KEY]: 'a', 'tmux_state::a': '{"page":"hub"}',
  });
  const { entry } = recordServer(s, { address: L, token: 'tb', machineId: 'm-b' });
  assert.equal(entry.id, 'b');
  const list = loadServers(s);
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === 'a')!.name, 'mac mini');
  assert.equal(s.getItem('tmux_state::a'), '{"page":"hub"}');
  // A third machine on the same address, with no entry yet: a new entry, not A's renamed.
  const { entry: c } = recordServer(s, { address: L, token: 'tc', machineId: 'm-c' });
  assert.notEqual(c.id, 'a');
  assert.equal(loadServers(s).find((x) => x.id === 'a')!.machineId, 'm-a', 'A is still A');
  assert.equal(loadServers(s).length, 3);
});

test('a machine-less entry is attributed only when exactly one known machine shares its address, in either direction (validator, board 318)', () => {
  const L = 'ws://127.0.0.1:9899';
  // Scenario 4: the ghost is CURRENT and two known machines share its address.
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'ghost', name: '127.0.0.1', address: L, token: 'tg' },
      { id: 'a', name: 'A', named: true, address: L, token: 'ta', machineId: 'm-a' },
      { id: 'b', name: 'B', named: true, address: L, token: 'tb', machineId: 'm-b' },
    ]),
    [CURRENT_KEY]: 'ghost', 'tmux_state::b': '{"page":"files"}',
  });
  const out = migrateServers(s);
  assert.deepEqual(out.map((x) => [x.id, x.name, x.token, x.machineId ?? null]),
    [['ghost', '127.0.0.1', 'tg', null], ['a', 'A', 'ta', 'm-a'], ['b', 'B', 'tb', 'm-b']], 'all three kept as they were');
  assert.equal(s.getItem('tmux_state::b'), '{"page":"files"}');
  // One known machine on the address: the CURRENT ghost still folds it in.
  const one = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'ghost', name: '127.0.0.1', address: L, token: 'tg' },
      { id: 'a', name: 'A', named: true, address: L, token: 'ta', machineId: 'm-a' },
    ]),
    [CURRENT_KEY]: 'ghost',
  });
  const folded = migrateServers(one);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.id, 'ghost');
  assert.equal(folded[0]!.machineId, 'm-a');
  assert.equal(folded[0]!.name, 'A');
  assert.equal(currentServerId(one), 'ghost');
});

test('currentServerName: the current server reads as its saved row, renamed or not (board #319)', () => {
  const host = 'dev-dsk-cfu-2a.ap-northeast-1.amazon.com';
  const s = mem();
  const id = recordServer(s, { address: 'ws://10.0.0.5:9899', token: 'tok' }).entry.id;
  saveServersAdopted(s, id, host);
  const info = { hostname: host, machineId: 'm1' };
  // Unrenamed: the adopted hostname, which is also what the row shows.
  assert.equal(currentServerName(loadServers(s), id, info, 'ws://10.0.0.5:9899'), host);
  // Renamed: the row's name, not the raw hostname (the owner's screenshot).
  renameServer(s, id, 'devbox');
  assert.equal(currentServerName(loadServers(s), id, info, 'ws://10.0.0.5:9899'), 'devbox');
  // Found by machine even when the current id is stale.
  const withMachine = loadServers(s).map((e) => ({ ...e, machineId: 'm1' }));
  assert.equal(currentServerName(withMachine, 'gone', info, 'ws://10.0.0.5:9899'), 'devbox');
  // No entry yet: hostname, then the URL host — never the raw URL.
  assert.equal(currentServerName([], '', info, 'ws://10.0.0.5:9899'), host);
  assert.equal(currentServerName([], '', {}, 'ws://10.0.0.5:9899'), '10.0.0.5');
});

function saveServersAdopted(s: ReturnType<typeof mem>, id: string, host: string) {
  s.setItem(SERVERS_KEY, JSON.stringify(adoptHostname(loadServers(s), id, host)));
}

test('the identity layer records the merges it made, and only those', () => {
  // reviewer P1-a (#335, 2026-10-10): a holder of an old id has to follow it
  // to the survivor, and the evidence must be the absorption itself — an id
  // that is merely absent may have been forgotten or never saved, and
  // re-pointing it at the current server would open a stranger's pane.
  const storage = mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'alias', name: 'home', address: 'ws://a:9899', token: 't', named: true },
      { id: 'canon', name: 'canonical', address: 'ws://b:9899', token: 't', machineId: 'm', named: true },
      { id: 'other', name: 'other', address: 'ws://c:9899', token: 't', machineId: 'm-c', named: true },
    ]),
    [CURRENT_KEY]: 'alias',
  });
  assert.equal(mergedInto(storage, 'alias'), 'alias', 'a saved entry is itself');
  recordServer(storage, { address: 'ws://a:9899', token: 't', machineId: 'm' });
  assert.deepEqual(loadServers(storage).map((s) => s.id), ['canon', 'other'], 'the alias was absorbed');
  assert.equal(mergedInto(storage, 'alias'), 'canon', 'and it is followed to its survivor');
  assert.equal(mergedInto(storage, 'never-saved'), '', 'an id nothing explains is nobody');
  removeServer(storage, 'other');
  assert.equal(mergedInto(storage, 'other'), '', 'a FORGOTTEN entry was not merged into anyone');
  assert.equal(mergedInto(storage, ''), '');
});

test('a merge chain is followed, and a chain into a forgotten entry ends nowhere', () => {
  const storage = mem({
    [SERVERS_KEY]: JSON.stringify([{ id: 'c', name: 'c', address: 'ws://c', token: 't' }]),
    [MERGES_KEY]: JSON.stringify({ a: 'b', b: 'c', x: 'gone', loop1: 'loop2', loop2: 'loop1' }),
  });
  assert.equal(mergedInto(storage, 'a'), 'c', 'a was folded into b, and b later into c');
  assert.equal(mergedInto(storage, 'x'), '', 'its survivor was forgotten since');
  assert.equal(mergedInto(storage, 'loop1'), '', 'a corrupt cycle terminates');
  assert.equal(mergedInto(mem({ [MERGES_KEY]: 'not json' }), 'a'), '');
});

// ─── #335 ③b: every absorbed id is MERGED into the survivor ─────────────
// (orchestrator 15:02/15:04, reviewer 15:03, validator 15:08). Under
// Aggregate a background alias has state of its own, and so does the
// canonical entry it is folded into. A folded client (no pending inputs):
// the focus X takes no part. a1/a2 are address-only twins of canonical c.

const alert = (id: string, server: string, ts: number) => ({ key: `proj:work|${id}`, room: 'proj:work', server, session: 'work', seq: ts, id, ts, from: 'dev', toHuman: true, kind: 'reply', excerpt: 'x' });
function twins(order: ('a1' | 'a2')[], slots: Record<string, string> = {}) {
  const entries = {
    a1: { id: 'a1', name: 'one', address: 'ws://a:1', token: 't' },
    a2: { id: 'a2', name: 'two', address: 'ws://a:1', token: 't' },
  };
  return mem({
    [SERVERS_KEY]: JSON.stringify([
      { id: 'x', name: 'xray', address: 'ws://x:1', token: 't', machineId: 'm-x' },
      { id: 'c', name: 'canon', address: 'ws://a:1', token: 't', machineId: 'm-a' },
      ...order.map((k) => entries[k]),
    ]),
    [CURRENT_KEY]: 'x',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'folded', into: 'x' }),
    [residentKey('tmux_hub_drafts', 'x')]: JSON.stringify({ work: 'X s own' }),
    ...slots,
  });
}
const drafts = (s: ReturnType<typeof mem>, id: string) => JSON.parse(s.getItem(residentKey('tmux_hub_drafts', id)) ?? 'null');

for (const order of [['a1', 'a2'], ['a2', 'a1']] as const) {
  test(`two background aliases absorbed at once both land on an empty canonical, in either order (${order.join(' then ')})`, () => {
    const s = twins([...order], {
      [residentKey('tmux_hub_drafts', 'a1')]: JSON.stringify({ work: 'TYPED' }),
      [residentKey('tmux_hub_drafts', 'a2')]: JSON.stringify({ ops: 'TYPED2' }),
      [residentKey('tmux_hub_seen', 'a2')]: JSON.stringify({ ops: { seq: 4 } }),
    });
    migrateServers(s);
    assert.deepEqual(loadServers(s).map((e) => e.id), ['x', 'c'], 'both absorbed');
    assert.deepEqual(drafts(s, 'c'), { work: 'TYPED', ops: 'TYPED2' }, 'neither overwrote the other');
    assert.deepEqual(JSON.parse(s.getItem(residentKey('tmux_hub_seen', 'c'))!), { ops: { seq: 4 } });
    assert.deepEqual(drafts(s, 'x'), { work: 'X s own' }, 'the focus took no part');
    assert.equal(s.getItem('tmux_slot_conflicts'), null, 'no conflict to record');
    assert.equal(s.getItem(MOVES_KEY), null, 'every intent closed');
    for (const k of RESIDENT_KEYS) assert.equal(s.getItem(residentKey(k, 'a1')) ?? s.getItem(residentKey(k, 'a2')), null, `the twins s ${k} slots are gone`);
  });
}

test('the canonical s own state survives an absorbed alias that lacks it, and a real conflict keeps canonical s and RECORDS the alias s (validator 15:08)', () => {
  const s = twins(['a1'], {
    [residentKey('tmux_hub_drafts', 'c')]: JSON.stringify({ work: 'TYPED on canonical', ops: 'canon ops' }),
    [residentKey('tmux_hub_alerts', 'c')]: JSON.stringify([alert('1', 'c', 10)]),
    [residentKey('tmux_hub_lead', 'c')]: 'canon-lead',
    [residentKey('tmux_hub_drafts', 'a1')]: JSON.stringify({ work: 'typed on the alias', new: 'only on the alias' }),
    [residentKey('tmux_hub_alerts', 'a1')]: JSON.stringify([alert('2', 'a1', 20), alert('3', 'elsewhere', 5)]),
  });
  migrateServers(s);
  assert.deepEqual(drafts(s, 'c'), { work: 'TYPED on canonical', ops: 'canon ops', new: 'only on the alias' },
    'canonical s drafts kept; the alias s non-conflicting draft lands');
  assert.equal(s.getItem(residentKey('tmux_hub_lead', 'c')), 'canon-lead', 'a key the alias does not have is not deleted');
  assert.deepEqual(JSON.parse(s.getItem('tmux_slot_conflicts')!), [{ from: 'a1', to: 'c', key: 'tmux_hub_drafts', value: JSON.stringify({ work: 'typed on the alias' }) }],
    'the alias s draft of the same room is recorded, not lost');
  const alerts = JSON.parse(s.getItem(residentKey('tmux_hub_alerts', 'c'))!) as { id: string; server: string }[];
  assert.deepEqual(alerts.map((a) => [a.id, a.server]), [['2', 'c'], ['1', 'c'], ['3', 'elsewhere']],
    'alerts union, newest first; the alias s names canonical now, a third server s is left alone');
});

test('a folded client interrupted between two absorbed aliases records both intents, and a reload completes the second (orchestrator 15:04)', () => {
  const s = twins(['a1', 'a2'], {
    [residentKey('tmux_hub_drafts', 'a1')]: JSON.stringify({ work: 'TYPED' }),
    [residentKey('tmux_hub_drafts', 'a2')]: JSON.stringify({ ops: 'TYPED2' }),
  });
  const set = s.setItem;
  let n = 0;
  s.setItem = (k: string, v: string) => { if (k === residentKey('tmux_hub_drafts', 'c') && ++n === 2) throw new Error('QuotaExceededError'); set(k, v); };
  assert.throws(() => migrateServers(s), /Quota/u, 'the second alias s merge fails');
  s.setItem = set;
  assert.deepEqual((JSON.parse(s.getItem(MOVES_KEY)!) as { from: string }[]).map((m) => m.from).sort(), ['a1', 'a2'], 'one intent per pair, on a folded client');
  assert.deepEqual(loadServers(s).map((e) => e.id), ['x', 'c', 'a1', 'a2'], 'the registry was not committed');
  migrateServers(s);                                                  // the reload
  assert.deepEqual(drafts(s, 'c'), { work: 'TYPED', ops: 'TYPED2' }, 'both landed');
  assert.deepEqual(loadServers(s).map((e) => e.id), ['x', 'c']);
  assert.equal(s.getItem(MOVES_KEY), null);
});

test('one move that cannot finish does not hold another: each resumes on its own (orchestrator 15:04)', () => {
  const s = twins(['a1', 'a2'], {
    [residentKey('tmux_hub_lead', 'a1')]: 'a1-lead',                // only a1 writes this key
    [residentKey('tmux_hub_drafts', 'a2')]: JSON.stringify({ ops: 'TYPED2' }),
  });
  s.setItem(MOVES_KEY, JSON.stringify([{ from: 'a1', to: 'c', wins: 'target' }, { from: 'a2', to: 'c', wins: 'target' }]));
  const set = s.setItem;
  s.setItem = (k: string, v: string) => { if (k === residentKey('tmux_hub_lead', 'c')) throw new Error('QuotaExceededError'); set(k, v); };
  assert.throws(() => resumeSlotMove(s), /Quota/u, 'a1 s move fails');
  s.setItem = set;
  assert.deepEqual(drafts(s, 'c'), { ops: 'TYPED2' }, 'a2 s completed anyway');
  assert.deepEqual((JSON.parse(s.getItem(MOVES_KEY)!) as { from: string }[]).map((m) => m.from), ['a1'], 'only a1 s intent is still open');
  assert.equal(resumeSlotMove(s), true);
  assert.equal(s.getItem(residentKey('tmux_hub_lead', 'c')), 'a1-lead');
  assert.equal(s.getItem(MOVES_KEY), null);
});

test('an intent written before ③b, on the pending record, is still resumed: as the whole move it was', () => {
  const s = mem({
    [SERVERS_KEY]: JSON.stringify([{ id: 'c', name: 'canon', address: 'ws://a:1', token: 't', machineId: 'm-a' }]),
    [CURRENT_KEY]: 'a',
    tmux_state_layout: JSON.stringify({ v: '335', state: 'pending', machine: 'm-a', slots: {}, moving: { from: 'a', to: 'c' } }),
    [residentKey('tmux_hub_drafts', 'a')]: JSON.stringify({ work: 'TYPED' }),
  });
  assert.equal(resumeSlotMove(s), true);
  assert.equal(currentServerId(s), 'c', 'the registry no longer lists a: CURRENT moved off it');
  assert.deepEqual(JSON.parse(s.getItem(residentKey('tmux_hub_drafts', 'c'))!), { work: 'TYPED' });
  assert.equal(JSON.parse(s.getItem('tmux_state_layout')!).moving, undefined, 'and the old intent is closed');
});
