import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_KEY, MACHINE_PREFIX, MAX_SERVERS, MERGES_KEY, SERVERS_KEY, STATE_PREFIX, mergedInto,
  activateConnected, activateSwitched, adoptHostname, currentServerId, currentServerName, parkFrom, pointTo, PARKED_KEYS, hostLabel, loadServers,
  migrateServers, recordServer, removeServer, renameServer, saveMachineAddresses,
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

test('activateConnected: a DIFFERENT server parks the old live state and demands a reboot', () => {
  // The lead blocker: a Settings connect to a new machine bypassed
  // applySwitch — old tmux_state was never parked under the old id and the
  // in-memory caches (Hub rooms, terminals, Files cwds) stayed old-server.
  // activateConnected does the applySwitch bookkeeping and returns
  // reload:true so the caller reboots through the one boot path.
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
    tmux_state: '{"page":"board"}',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  s.setItem('tmux_address', 'ws://b:2');       // the connect form wrote the mirror keys pre-dial
  s.setItem('tmux_token', 'tb');
  s.setItem('tmux_disconnected', '1');
  const act = activateConnected(s, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' });
  assert.equal(act.reload, true, 'different machine — the caller must location.reload()');
  assert.equal(s.getItem(STATE_PREFIX + aId), '{"page":"board"}', 'A’s live state parked under A');
  assert.equal(s.getItem(MACHINE_PREFIX + aId), 'm-a', 'A’s machine id parked too');
  assert.equal(s.getItem('tmux_state'), null, 'B starts fresh — never on A’s restore targets');
  assert.equal(s.getItem('tmux_machine_id'), 'm-b', 'B’s identity is live');
  const bEntry = loadServers(s).find((x) => x.address === 'ws://b:2')!;
  assert.equal(currentServerId(s), bEntry.id, 'B is current');
  assert.equal(s.getItem('tmux_disconnected'), null, 'connecting IS the intent');
  // And a later switch back restores A intact.
  parkFrom(s, currentServerId(s));
  pointTo(s, loadServers(s).find((x) => x.id === aId)!);
  assert.equal(s.getItem('tmux_state'), '{"page":"board"}');
  assert.equal(s.getItem('tmux_machine_id'), 'm-a');
});

test('removeServer refuses the current entry and clears parked state for others', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: '' });
  migrateServers(s);
  const a = loadServers(s)[0]!;
  const { entry: b } = recordServer(s, { address: 'ws://b:2', token: '' });
  s.setItem(STATE_PREFIX + b.id, '{"page":"hub"}');
  s.setItem(MACHINE_PREFIX + b.id, 'mid-b');
  assert.equal(removeServer(s, a.id).length, 2, 'current is not removable');
  const left = removeServer(s, b.id);
  assert.equal(left.length, 1);
  assert.equal(s.getItem(STATE_PREFIX + b.id), null, 'parked state goes with the entry');
  assert.equal(s.getItem(MACHINE_PREFIX + b.id), null);
});

// --- The in-place switch's storage half (board 315) -------------------------

const HUB = (project: string, draft: string) => ({
  tmux_hub_project: project,
  tmux_hub_drafts: JSON.stringify({ [project]: draft }),
  tmux_hub_seen: JSON.stringify({ [project]: 1 }),
  tmux_hub_lead: JSON.stringify({ [project]: 'lead' }),
});

test('parkFrom files every per-server key under the source id; pointTo surfaces the target’s', () => {
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta',
    tmux_state: '{"page":"terminal","terminalTarget":"app:1.1"}', tmux_machine_id: 'mid-a',
    ...HUB('app', 'half-typed on A'),
  });
  migrateServers(s);
  const a = loadServers(s)[0]!;
  const { entry: b } = recordServer(s, { address: 'ws://b:2', token: 'tb' });
  s.setItem(STATE_PREFIX + b.id, '{"page":"board"}');
  s.setItem(MACHINE_PREFIX + b.id, 'mid-b');
  s.setItem(`tmux_hub_drafts::${b.id}`, JSON.stringify({ app: 'B draft' }));

  parkFrom(s, a.id);
  assert.equal(s.getItem(STATE_PREFIX + a.id), '{"page":"terminal","terminalTarget":"app:1.1"}');
  assert.equal(s.getItem(MACHINE_PREFIX + a.id), 'mid-a');
  assert.equal(s.getItem(`tmux_hub_drafts::${a.id}`), JSON.stringify({ app: 'half-typed on A' }));
  assert.equal(s.getItem(`tmux_hub_project::${a.id}`), 'app');
  assert.equal(s.getItem('tmux_address'), 'ws://a:1', 'parking never touches the mirror');
  assert.equal(currentServerId(s), a.id, 'nor CURRENT');

  pointTo(s, b);
  assert.equal(s.getItem('tmux_state'), '{"page":"board"}');
  assert.equal(s.getItem('tmux_machine_id'), 'mid-b');
  assert.equal(s.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'B draft' }), 'same project name, B’s own draft');
  assert.equal(s.getItem('tmux_hub_project'), null, 'nothing parked for B: cleared, never A’s');
  assert.equal(s.getItem('tmux_hub_seen'), null);
  assert.equal(currentServerId(s), b.id);

  // And back: A exactly as it was.
  parkFrom(s, b.id);
  pointTo(s, a);
  assert.equal(s.getItem('tmux_state'), '{"page":"terminal","terminalTarget":"app:1.1"}');
  assert.equal(s.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'half-typed on A' }));
  assert.equal(s.getItem('tmux_hub_project'), 'app');
  assert.equal(s.getItem('tmux_machine_id'), 'mid-a');
});

test('pointTo prefers the entry’s own machineId for the failover set', () => {
  const s = mem({ tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a' });
  migrateServers(s);
  const a = loadServers(s)[0]!;
  const { entry: b } = recordServer(s, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' });
  parkFrom(s, a.id);
  pointTo(s, b);
  assert.equal(s.getItem('tmux_machine_id'), 'm-b', 'B’s identity, even with no parked key');
  parkFrom(s, b.id);
  pointTo(s, loadServers(s).find((x) => x.id === a.id)!);
  assert.equal(s.getItem('tmux_machine_id'), 'm-a', 'and back — never crossed');
});

test('activateSwitched: a candidate becomes current only by the identity it reported', () => {
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a', tmux_state: '{"page":"hub"}',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:1'] }), tmux_disconnected: '1',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  parkFrom(s, aId);
  // A NEW address that turns out to be machine A (its Tailscale name): it
  // folds into A's entry and restores A's parked state, never a second server.
  const same = activateSwitched(s, { address: 'ws://a-ts:9', token: 'ta', machineId: 'm-a' });
  assert.equal(same.id, aId);
  assert.equal(loadServers(s).length, 1);
  assert.equal(s.getItem('tmux_state'), '{"page":"hub"}');
  assert.deepEqual(JSON.parse(s.getItem('tmux_machines')!)['m-a'], ['ws://a:1', 'ws://a-ts:9'], 'the address joins the failover set');
  assert.equal(s.getItem('tmux_address'), 'ws://a-ts:9', 'the mirror follows only after auth');
  assert.equal(s.getItem('tmux_disconnected'), null);
  // A genuinely new machine gets its own entry and starts fresh.
  parkFrom(s, aId);
  const b = activateSwitched(s, { address: 'ws://b:2', token: 'tb', socket: '/sb', machineId: 'm-b' });
  assert.notEqual(b.id, aId);
  assert.equal(currentServerId(s), b.id);
  assert.equal(s.getItem('tmux_state'), null);
  assert.equal(s.getItem('tmux_machine_id'), 'm-b');
  assert.equal(s.getItem('tmux_socket'), '/sb');
  assert.equal(s.getItem(STATE_PREFIX + aId), '{"page":"hub"}', 'A’s park untouched by B’s activation');
});

test('PARKED_KEYS names exactly the Hub prefs that are per project (per server)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../hub/hub-prefs.svelte.ts', import.meta.url), 'utf8');
  const keyOf = (name: string) => new RegExp(`const ${name} = '([^']+)'`, 'u').exec(src)?.[1];
  const list = /HUB_SERVER_KEYS = \[([^\]]+)\]/u.exec(src)?.[1]?.split(',').map((x) => keyOf(x.trim())) ?? [];
  assert.ok(list.length >= 4, 'hub-prefs names its per-server keys');
  for (const key of list) assert.ok((PARKED_KEYS as readonly string[]).includes(key!), `${key} is parked per server`);
});

test('activateConnected owns the live machine id — same machine refreshes it (lead blocker #2)', () => {
  const s = mem({
    tmux_address: 'ws://a-lan:1', tmux_token: 'ta',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a-lan:1', 'ws://a-alt:2'] }),
    // live key stale/absent — Settings no longer pre-writes it
  });
  migrateServers(s);
  const act = activateConnected(s, { address: 'ws://a-alt:2', token: 'ta', machineId: 'm-a' });
  assert.equal(act.reload, false);
  assert.equal(s.getItem('tmux_machine_id'), 'm-a', 'the same-machine branch refreshes the live key');
});

test('the REAL caller sequence cannot poison the old server’s parked machine id', () => {
  // Regression for the exact bug: Settings used to write the NEW machine's
  // id into the live key BEFORE activating, so parkAndPoint filed m-b under
  // A's slot. The contract is now: the caller never pre-writes the live key,
  // activateConnected parks whatever the OLD server left there.
  const s = mem({
    tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
    tmux_state: '{"page":"hub"}',
  });
  migrateServers(s);
  const aId = currentServerId(s);
  // The real caller: mirror keys pre-written, map updated, live key UNTOUCHED.
  s.setItem('tmux_address', 'ws://b:2');
  s.setItem('tmux_token', 'tb');
  s.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://a:1'], 'm-b': ['ws://b:2'] }));
  const act = activateConnected(s, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' });
  assert.equal(act.reload, true);
  assert.equal(s.getItem(MACHINE_PREFIX + aId), 'm-a', 'A’s slot holds A’s id — never B’s');
  assert.equal(s.getItem('tmux_machine_id'), 'm-b', 'the live key is B’s, written by parkAndPoint');
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
