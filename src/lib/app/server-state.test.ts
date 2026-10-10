// One slot per server, and the one-time fold that gets there (board #335
// ②a-3; in production since ②b-4, where App runs the fold at boot, before
// the deep link, and again before it builds any server's state).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore, isResidentKey } from './server-store.ts';
import { LAYOUT_KEY, LAYOUT_VERSION, claimPending, layoutMark, migrateServerState } from './server-state-migration.ts';
import { RESIDENT_KEYS, activateConnected, activateSwitched, recordServer, residentKey } from './servers.ts';

/** What a switch on a pre-#335 build did to storage: file the leaving
 * server's live keys under its id, surface the target's. The upgrade
 * fixtures need it; the app no longer does it (②b-4). */
function legacySwitch(storage: ReturnType<typeof mem>, fromId: string, to: { id: string; machineId?: string }) {
  for (const key of RESIDENT_KEYS) {
    const live = storage.getItem(key);
    if (live != null) storage.setItem(residentKey(key, fromId), live); else storage.removeItem(residentKey(key, fromId));
  }
  for (const key of RESIDENT_KEYS) {
    const v = key === 'tmux_machine_id' ? to.machineId || storage.getItem(residentKey(key, to.id)) : storage.getItem(residentKey(key, to.id));
    if (v != null && v !== '') storage.setItem(key, v); else storage.removeItem(key);
  }
  storage.setItem('tmux_server_current', to.id);
}

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem(k: string, v: string) { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    dump: () => Object.fromEntries([...m.entries()].sort()),
  };
}

/** A client as it looked before #335: one live set of keys for the server it
 * is connected to, and a park for the server it last left. */
function preMigration() {
  return mem({
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b' },
    ]),
    tmux_server_current: 'a',
    // A's live state: the user is on A right now.
    tmux_state: JSON.stringify({ page: 'hub', terminalTarget: 'work:1.0', terminalSession: 'work' }),
    tmux_machine_id: 'm-a',
    tmux_hub_project: 'work',
    tmux_hub_drafts: JSON.stringify({ work: 'half a line on A' }),
    tmux_hub_seen: JSON.stringify({ work: { seq: 12, ts: 1000 } }),
    tmux_hub_lead: JSON.stringify({ work: 'builder' }),
    tmux_hub_drawer: JSON.stringify({ work: 'files' }),
    tmux_hub_roster_expanded: JSON.stringify({ work: true }),
    tmux_hub_alerts: JSON.stringify([{ id: 'n1', room: 'proj:work' }]),
    // B's park, from the last time the user left it. Same project NAME, which
    // is the collision the whole phase exists for.
    'tmux_state::b': JSON.stringify({ page: 'terminal', terminalTarget: 'work:2.1', terminalSession: 'work' }),
    'tmux_machine_id::b': 'm-b',
    'tmux_hub_drafts::b': JSON.stringify({ work: 'half a line on B' }),
    'tmux_hub_seen::b': JSON.stringify({ work: { seq: 3, ts: 500 } }),
    // A stale park for A itself, from before this visit: older than the live
    // value by construction, because the live value is what replaced it.
    'tmux_hub_drafts::a': JSON.stringify({ work: 'what A looked like last time' }),
    // A global preference, which is the PERSON's and not any server's.
    tmux_hub_feed_level: 'status',
    tmux_theme: 'dark',
  });
}

test('the store scopes exactly the resident set', () => {
  // One list (`servers.ts`), used by the store, the fold and the identity
  // layer's remove and merge. `servers.test.ts` pins it against hub-prefs'
  // HUB_SERVER_KEYS by reading the source, because hub-prefs touches
  // localStorage at module load; this chains onto that pin.
  for (const key of [
    'tmux_state', 'tmux_machine_id', 'tmux_hub_project', 'tmux_hub_drafts', 'tmux_hub_seen',
    'tmux_hub_lead', 'tmux_hub_drawer', 'tmux_hub_roster_expanded', 'tmux_hub_alerts',
  ]) {
    assert.ok(isResidentKey(key), `${key} is one server's state`);
  }
  // The person's and the window's preferences are not.
  for (const key of [
    'tmux_hub_feed_level', 'tmux_hub_sidebar', 'tmux_hub_steps_rows', 'tmux_theme', 'tmux_font_size',
    'tmux_servers', 'tmux_server_current', 'tmux_machines', 'tmux_address', 'tmux_token', 'tmux_socket',
  ]) {
    assert.equal(isResidentKey(key), false, `${key} must not become per-server`);
  }
});

test('a server store reads and writes its own slot, and nobody else s', () => {
  const storage = preMigration();
  const a = createServerStore(storage, 'a');
  const b = createServerStore(storage, 'b');
  assert.equal(a.keyFor('tmux_hub_drafts'), 'tmux_hub_drafts::a');
  assert.equal(b.keyFor('tmux_hub_drafts'), 'tmux_hub_drafts::b');

  assert.deepEqual(JSON.parse(b.getItem('tmux_hub_drafts')!), { work: 'half a line on B' });
  b.setItem('tmux_hub_drafts', JSON.stringify({ work: 'typed on B' }));
  assert.deepEqual(JSON.parse(a.getItem('tmux_hub_drafts')!), { work: 'what A looked like last time' },
    'A s slot is untouched by a write to B');
  assert.equal(storage.getItem('tmux_hub_drafts'), JSON.stringify({ work: 'half a line on A' }),
    'and so is the unprefixed key, which is no longer a location');

  a.removeItem('tmux_hub_drafts');
  assert.equal(a.getItem('tmux_hub_drafts'), null);
  assert.ok(b.getItem('tmux_hub_drafts'), 'removing A s row leaves B s');
});

test('a global preference is the person s, whichever server is asked', () => {
  const storage = preMigration();
  const a = createServerStore(storage, 'a');
  const b = createServerStore(storage, 'b');
  assert.equal(a.getItem('tmux_hub_feed_level'), 'status');
  assert.equal(b.getItem('tmux_hub_feed_level'), 'status', 'the same human gets the same app');
  b.setItem('tmux_theme', 'light');
  assert.equal(a.getItem('tmux_theme'), 'light');
  assert.equal(storage.getItem('tmux_theme'), 'light', 'written where every server reads it');
  assert.equal(storage.getItem('tmux_theme::b'), null, 'and not scoped behind one');
});

test('a store without a server is refused, not quietly unscoped', () => {
  // The dangerous case is the path where CURRENT has not resolved yet: a view
  // that fell back to the unprefixed keys would write one server's state into
  // the place every other server reads, and only there.
  assert.throws(() => createServerStore(mem(), ''), /serverId/u);
});

test('the fold files the live values under the CURRENT server', () => {
  const storage = preMigration();
  const report = migrateServerState(storage);
  assert.equal(report.ran, true);
  assert.equal(report.serverId, 'a');
  for (const key of RESIDENT_KEYS) {
    const live = storage.getItem(key);
    if (live == null) continue;
    assert.equal(storage.getItem(residentKey(key, 'a')), live, `${key} is now resident under A`);
  }
  // The active value wins over A's own stale park: it is what the user was
  // looking at a moment ago, and the park is from the last time they left.
  assert.deepEqual(
    JSON.parse(storage.getItem('tmux_hub_drafts::a')!),
    { work: 'half a line on A' },
  );
});

test('the fold keeps every other server s park', () => {
  const storage = preMigration();
  const before = storage.dump();
  migrateServerState(storage);
  const after = storage.dump();
  for (const [key, value] of Object.entries(before)) {
    if (key.endsWith('::b')) {
      assert.equal(after[key], value, `${key} is already in its final home`);
    }
  }
  // B's draft for the same project name is still B's.
  assert.deepEqual(JSON.parse(after['tmux_hub_drafts::b']!), { work: 'half a line on B' });
});

test('the fold leaves the unprefixed keys readable for a rollback', () => {
  const storage = preMigration();
  const before = storage.dump();
  migrateServerState(storage);
  for (const key of RESIDENT_KEYS) {
    assert.equal(storage.getItem(key), before[key] ?? null,
      `${key} still reads as it did, so a build from before #335 finds its world`);
  }
});

test('the fold runs once, and a rerun never touches a newer resident value', () => {
  // The reviewer's P1-a. Value-comparison idempotency only holds while nothing
  // else writes the slot; the moment the slot is the live home, a second run
  // overwrites a NEWER resident value with the stale unprefixed one. The first
  // version of this test asserted that overwrite as if it were convergence.
  const storage = preMigration();
  const first = migrateServerState(storage);
  assert.equal(first.reason, 'folded');
  assert.ok(first.folded.includes('tmux_hub_drafts'));
  const once = storage.dump();

  const second = migrateServerState(storage);
  assert.deepEqual(second, { ran: false, reason: 'already-done', serverId: 'a', folded: [], cleared: [] });
  assert.deepEqual(storage.dump(), once, 'the second run changes nothing');

  // A module that has moved to the new layout writes, and the fold runs again.
  createServerStore(storage, 'a').setItem('tmux_hub_drafts', JSON.stringify({ work: 'newer' }));
  migrateServerState(storage);
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'newer' },
    'the newer resident value is PRESERVED — the inputs were consumed by the first run');
});

test('a CURRENT that changes later cannot re-attribute leftover inputs', () => {
  // A's live values were folded into A. The unprefixed keys are still there
  // for a rollback, so nothing may read them AS INPUTS again: if CURRENT
  // became B, a second fold would file A's drafts, nav state and read marks
  // under B.
  const storage = preMigration();
  migrateServerState(storage);
  const bBefore = JSON.parse(storage.getItem('tmux_hub_drafts::b')!);

  storage.setItem('tmux_server_current', 'b');
  const report = migrateServerState(storage);
  assert.deepEqual(report, { ran: false, reason: 'already-done', serverId: 'a', folded: [], cleared: [] },
    'and it still names the server the inputs actually went to');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::b')!), bBefore, 'B is still B');
  assert.equal(storage.getItem('tmux_state::b'), JSON.stringify({ page: 'terminal', terminalTarget: 'work:2.1', terminalSession: 'work' }));
});

test('ONE marker write records both facts, so there is no window between them', () => {
  // Two markers meant two writes: the per-server one lands, the global one
  // fails, and then the server it folded into skips while the NEXT server to
  // become current folds the same leftover inputs into its own slot. One write
  // carries the layout AND which server received the inputs.
  const storage = preMigration();
  migrateServerState(storage);
  assert.deepEqual(layoutMark(storage), { v: LAYOUT_VERSION, state: 'folded', into: 'a' });
  assert.equal(storage.getItem(residentKey(LAYOUT_KEY, 'a')), null, 'no second marker to go missing');
  // The marker is not a per-server key, so a server store does not rewrite it
  // on the way past.
  assert.equal(isResidentKey(LAYOUT_KEY), false);
  // Unparseable is still "consumed": reading the inputs twice is worse than
  // not knowing which fold ran.
  const old = mem({ ...preMigration().dump(), [LAYOUT_KEY]: 'yes' });
  assert.deepEqual(layoutMark(old), { v: 'yes', state: 'folded', into: '' });
  assert.equal(migrateServerState(old).reason, 'already-done');
});

test('a fold that cannot be recorded says so, and a later run records it', () => {
  // `localStorage` has no transaction, so the honest boundary is: one write,
  // and a report when even that fails. The caller must not switch servers on
  // `unrecorded` — the inputs still read as unconsumed.
  const storage = preMigration();
  const real = storage.setItem.bind(storage);
  storage.setItem = (k: string, v: string) => {
    if (k === LAYOUT_KEY) throw new Error('QuotaExceededError');
    real(k, v);
  };
  const first = migrateServerState(storage);
  assert.equal(first.reason, 'unrecorded');
  assert.equal(first.ran, true, 'the data DID move');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'half a line on A' });
  assert.equal(layoutMark(storage), null, 'but nothing claims it is done');

  storage.setItem = real;
  const second = migrateServerState(storage);
  assert.equal(second.reason, 'folded', 'the retry folds the same inputs again');
  assert.deepEqual(layoutMark(storage), { v: LAYOUT_VERSION, state: 'folded', into: 'a' });
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'half a line on A' });
});

const PENDING_DANGLING = (storage: ReturnType<typeof mem>) => {
  const before = storage.dump();
  const report = migrateServerState(storage);
  assert.deepEqual(report, { ran: false, reason: 'pending', serverId: '', folded: [], cleared: [] });
  const { [LAYOUT_KEY]: marker, 'tmux_state::unattributed': copy, ...rest } = storage.dump();
  assert.deepEqual(rest, before, 'nothing filed into any slot');
  const record = JSON.parse(marker!);
  assert.deepEqual({ v: record.v, state: record.state, machineId: record.machineId }, { v: LAYOUT_VERSION, state: 'pending', machineId: 'm-a' },
    'the attribution state is RECORDED, with the legacy mirror s machine as its evidence');
  assert.equal(typeof record.inputs, 'string', 'and the inputs it is evidence for, fingerprinted');
  assert.deepEqual(Object.keys(record.slots).sort(), Object.keys(before).filter((k) => /::(a|b)$/u.test(k)).sort(),
    'and every slot that existed then');
  assert.equal(JSON.parse(copy!).raw, before.tmux_state, 'and the navigation is copied aside');
};

test('a CURRENT that names no saved server does not guess a slot: the inputs are recorded pending (reviewer P1-c)', () => {
  const storage = preMigration();
  storage.setItem('tmux_server_current', 'ghost');
  PENDING_DANGLING(storage);
});

test('a value the user CLEARED does not come back from the old park', () => {
  // Arriving at a server surfaces its park as the live key, so from then on
  // live and slot agree and any divergence is a live-side change: an absent
  // live key means cleared, not unknown. Copying only the present keys made a
  // cleared draft reappear the moment the slot became the live home.
  const storage = preMigration();
  // On A the user cleared the draft and closed the drawer; `::a` still holds
  // what was there when they last left A.
  storage.removeItem('tmux_hub_drafts');
  storage.setItem('tmux_hub_drawer::a', JSON.stringify({ work: 'files' }));
  storage.removeItem('tmux_hub_drawer');

  const report = migrateServerState(storage);
  assert.ok(report.cleared.includes('tmux_hub_drafts'), 'the fold reports what it cleared');
  assert.ok(report.cleared.includes('tmux_hub_drawer'));
  assert.equal(storage.getItem('tmux_hub_drafts::a'), null, 'the old draft is gone, as the user left it');
  assert.equal(storage.getItem('tmux_hub_drawer::a'), null);
  // B's own park is untouched: the live set speaks only for the current server.
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::b')!), { work: 'half a line on B' });
});

test('a fold interrupted halfway leaves the inputs, and the next run redoes it all', () => {
  // The markers are written AFTER the fold for this reason: private-mode
  // quota, a crash, a closed tab. A marker written first would claim a
  // conversion that only half happened, and the keys that had not moved yet
  // would never move.
  const storage = preMigration();
  const real = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = (k: string, v: string) => {
    if (++writes === 3) throw new Error('QuotaExceededError');
    real(k, v);
  };
  assert.equal(migrateServerState(storage).reason, 'unrecorded', 'a failed write is reported, never thrown');
  storage.setItem = real;

  assert.equal(storage.getItem(LAYOUT_KEY), null, 'nothing claims the fold happened');
  assert.equal(storage.getItem(residentKey(LAYOUT_KEY, 'a')), null);
  // The inputs are all still there, so the retry has everything it needs.
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts')!), { work: 'half a line on A' });

  const retry = migrateServerState(storage);
  assert.equal(retry.reason, 'folded');
  for (const key of RESIDENT_KEYS) {
    const live = storage.getItem(key);
    if (live == null) continue;
    assert.equal(storage.getItem(residentKey(key, 'a')), live, `${key} made it on the retry`);
  }
});

test('with no current server the inputs are recorded pending, never guessed', () => {
  const storage = preMigration();
  storage.removeItem('tmux_server_current');
  PENDING_DANGLING(storage);
});

test('with no inputs and no server there is nothing to record', () => {
  const storage = mem({});
  assert.equal(migrateServerState(storage).reason, 'no-current');
  assert.deepEqual(storage.dump(), {}, 'no writes');
});

test('a fresh client has nothing to fold', () => {
  // The entry has to exist: a CURRENT that resolves to nothing is the
  // dangling case, which writes nothing at all.
  const storage = mem({
    tmux_servers: JSON.stringify([{ id: 'only', name: 'n', address: 'ws://n:9899', token: '' }]),
    tmux_server_current: 'only',
  });
  const report = migrateServerState(storage);
  assert.equal(report.ran, true);
  assert.deepEqual(report.folded, [], 'an absent live value is not evidence of an empty server');
  assert.deepEqual(storage.dump(), {
    tmux_server_current: 'only',
    tmux_servers: JSON.stringify([{ id: 'only', name: 'n', address: 'ws://n:9899', token: '' }]),
    [LAYOUT_KEY]: JSON.stringify({ v: LAYOUT_VERSION, state: 'folded', into: 'only' }),
  }, 'only the marker, so the empty client is not folded again either');
});

test('the fold survives a pre-#335 switch having happened in between', () => {
  // The realistic upgrade path: the user switches A→B on the OLD build, so
  // park/point has already shuffled the live keys, and only then does the new
  // build run the fold. Whatever is live belongs to whatever CURRENT says.
  const storage = preMigration();
  const servers = JSON.parse(storage.getItem('tmux_servers')!);
  legacySwitch(storage, 'a', servers[1]);
  assert.equal(storage.getItem('tmux_server_current'), 'b');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts')!), { work: 'half a line on B' },
    'the old switch surfaced B s park as the live value');

  const report = migrateServerState(storage);
  assert.equal(report.serverId, 'b');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::b')!), { work: 'half a line on B' });
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'half a line on A' },
    'and A s park, written by that switch, is A s resident value');

  // Both servers now read their own state through their own store.
  assert.deepEqual(JSON.parse(createServerStore(storage, 'a').getItem('tmux_hub_drafts')!), { work: 'half a line on A' });
  assert.deepEqual(JSON.parse(createServerStore(storage, 'b').getItem('tmux_hub_drafts')!), { work: 'half a line on B' });
});

test('after the fold nothing writes the legacy keys: a store write and a switch leave them as they were (board #335 ②b-4)', () => {
  // Before ②b-4 a switch filed the live keys over the resident slots, which
  // is why the fold, the stores and park/point had to flip in ONE commit.
  const storage = preMigration();
  migrateServerState(storage);
  const legacy = Object.fromEntries(RESIDENT_KEYS.map((key) => [key, storage.getItem(key)]));
  const a = createServerStore(storage, 'a');
  a.setItem('tmux_hub_drafts', JSON.stringify({ work: 'written after the flip' }));
  activateSwitched(storage, { address: 'ws://b:9899', token: 'tokB', machineId: 'm-b' });
  assert.equal(storage.getItem('tmux_server_current'), 'b', 'the switch only moved CURRENT');
  assert.deepEqual(JSON.parse(a.getItem('tmux_hub_drafts')!), { work: 'written after the flip' }, 'A s slot kept A s write');
  assert.deepEqual(Object.fromEntries(RESIDENT_KEYS.map((key) => [key, storage.getItem(key)])), legacy, 'no legacy key was written');
  assert.equal(migrateServerState(storage).reason, 'already-done', 'and they are never read again');
  assert.deepEqual(JSON.parse(a.getItem('tmux_hub_drafts')!), { work: 'written after the flip' });
});

/** A pre-#335 client whose CURRENT dangled: its inputs (m-a's) are pending
 * once the boot has run, and `servers` is what the registry holds after. */
function pending(servers: Array<{ id: string; machineId?: string }>) {
  const storage = preMigration();
  storage.setItem('tmux_server_current', 'ghost');
  assert.equal(migrateServerState(storage).reason, 'pending');
  storage.setItem('tmux_servers', JSON.stringify(servers.map((s) => ({ name: s.id, address: `ws://${s.id}:9899`, token: 't', ...s }))));
  return storage;
}

test('a pending input is claimed only by the machine the legacy mirror named (reviewer P1-b on cf7e7957)', () => {
  const storage = pending([{ id: 'x', machineId: 'm-x' }, { id: 'n' }, { id: 'a2', machineId: 'm-a' }]);
  const before = storage.dump();
  for (const id of ['x', 'n']) {
    assert.equal(claimPending(storage, id).reason, 'pending', `${id} cannot prove it: still pending`);
    assert.deepEqual(storage.dump(), before, 'and nothing moved — no terminal state either');
  }
  assert.equal(migrateServerState(storage).reason, 'pending', 'a later boot sees it pending too');
  const claim = claimPending(storage, 'a2');
  assert.equal(claim.reason, 'folded', 'the machine that proves it claims it, after the others');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a2')!), { work: 'half a line on A' });
  assert.deepEqual(layoutMark(storage), { v: LAYOUT_VERSION, state: 'folded', into: 'a2' });
  assert.equal(claimPending(storage, 'a2').reason, 'already-done', 'once');
});

test('pending survives a reload with another server legitimately current (reviewer P1-c on cf7e7957)', () => {
  // B became current through a connect while the inputs were pending; a
  // reload must not read "CURRENT is valid" as "CURRENT owns the inputs".
  const storage = pending([{ id: 'b', machineId: 'm-b' }]);
  storage.setItem('tmux_server_current', 'b');
  assert.equal(migrateServerState(storage).reason, 'pending');
  assert.equal(storage.getItem('tmux_hub_drafts::b'), JSON.stringify({ work: 'half a line on B' }), 'B s own slot, not A s inputs');
});

test('a claim keeps what the owner wrote since the inputs were set aside', () => {
  const storage = pending([{ id: 'a2', machineId: 'm-a' }]);
  storage.setItem('tmux_hub_drafts::a2', JSON.stringify({ work: 'typed on the new build' }));
  assert.equal(claimPending(storage, 'a2').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a2')!), { work: 'typed on the new build' }, 'newer wins');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_lead::a2')!), { work: 'builder' }, 'and the rest is filled in');
});

test('a pending input with no machine on record waits; nothing can prove it', () => {
  const storage = preMigration();
  storage.removeItem('tmux_server_current');
  storage.removeItem('tmux_machine_id');
  assert.equal(migrateServerState(storage).reason, 'pending');
  storage.setItem('tmux_servers', JSON.stringify([{ id: 'n', name: 'n', address: 'ws://n:9899', token: 't' }]));
  assert.equal(claimPending(storage, 'n').reason, 'pending');
});

test('with nothing to fold there is nothing to prove', () => {
  const storage = mem({
    tmux_servers: JSON.stringify([{ id: 'n', name: 'new', address: 'ws://n:9899', token: 't', machineId: 'm-n' }]),
    tmux_server_current: 'n',
  });
  assert.equal(migrateServerState(storage).reason, 'folded');
  assert.deepEqual(layoutMark(storage), { v: LAYOUT_VERSION, state: 'folded', into: 'n' });
});

test('every write the attribution needs can fail, and each says unrecorded', () => {
  for (const key of [LAYOUT_KEY, 'tmux_state::unattributed']) {
    const storage = preMigration();
    storage.setItem('tmux_server_current', 'ghost');
    const set = storage.setItem;
    storage.setItem = (k: string, v: string) => { if (k === key) throw new Error('QuotaExceededError'); set(k, v); };
    assert.equal(migrateServerState(storage).reason, 'unrecorded', `${key} failing`);
    storage.setItem = set;
    assert.equal(layoutMark(storage), null, 'nothing recorded, so the retry decides again');
  }
  const claim = pending([{ id: 'a2', machineId: 'm-a' }]);
  const set = claim.setItem;
  claim.setItem = (k: string, v: string) => { if (k === LAYOUT_KEY) throw new Error('QuotaExceededError'); set(k, v); };
  assert.equal(claimPending(claim, 'a2').reason, 'unrecorded');
  claim.setItem = set;
  assert.equal(layoutMark(claim)?.state, 'pending', 'and a failed claim leaves it pending');
});

test('a key the server never had leaves no slot behind', () => {
  const storage = preMigration();
  storage.removeItem('tmux_hub_lead');            // A never chose a lead
  const report = migrateServerState(storage);
  assert.equal(storage.getItem('tmux_hub_lead::a'), null);
  assert.ok(!report.folded.includes('tmux_hub_lead'));
  assert.ok(!report.cleared.includes('tmux_hub_lead'), 'nothing to clear either');
});

test('a claim by the SAME id folds by the fold s rule: its old park is replaced, a cleared value stays cleared (reviewer P1-1 on 08fdb6ba)', () => {
  // `tmux_hub_drafts::a` is A's pre-#335 park — older than the live draft by
  // construction — not something the owner wrote since.
  const storage = preMigration();
  storage.setItem('tmux_hub_drawer::a', JSON.stringify({ work: 'old drawer' }));   // a park the live set has cleared
  storage.removeItem('tmux_hub_drawer');
  storage.setItem('tmux_server_current', 'ghost');
  assert.equal(migrateServerState(storage).reason, 'pending');
  assert.equal(claimPending(storage, 'a').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'half a line on A' }, 'the live draft replaced the old park');
  assert.equal(storage.getItem('tmux_hub_drawer::a'), null, 'and the cleared drawer did not come back');
});

test('a claim keeps what the owner changed or cleared after the inputs were set aside', () => {
  const storage = preMigration();
  storage.setItem('tmux_hub_seen::a', JSON.stringify({ work: { seq: 1, ts: 1 } }));   // an old park
  storage.setItem('tmux_server_current', 'ghost');
  assert.equal(migrateServerState(storage).reason, 'pending');
  // The owner was bound before it could prove itself, and the person used it.
  storage.setItem('tmux_hub_drafts::a', JSON.stringify({ work: 'typed on the new build' }));
  storage.removeItem('tmux_hub_seen::a');
  assert.equal(claimPending(storage, 'a').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::a')!), { work: 'typed on the new build' }, 'a changed slot is kept');
  assert.equal(storage.getItem('tmux_hub_seen::a'), null, 'a slot cleared since stays cleared');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_lead::a')!), { work: 'builder' }, 'an untouched one takes the live value');
});

test('inputs an old build changed after they were set aside are re-attributed before anyone claims them (reviewer P2-a)', () => {
  const storage = pending([{ id: 'a2', machineId: 'm-a' }, { id: 'b2', machineId: 'm-b' }]);
  // A pre-#335 page on the same origin switched to B: B's live keys now.
  storage.setItem('tmux_hub_drafts', JSON.stringify({ work: 'B s bytes' }));
  storage.setItem('tmux_machine_id', 'm-b');
  assert.equal(claimPending(storage, 'a2').reason, 'pending', 'm-a may not claim B s bytes');
  assert.equal(claimPending(storage, 'b2').reason, 'folded', 'the machine they now belong to may');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::b2')!), { work: 'B s bytes' });
});

/** Reviewer's fixture on cde052f7: an address-only alias `a` and the known
 * canonical `c` (m-a), different addresses so boot repair does not merge
 * them, each with an old park; CURRENT dangles; the inputs are m-a's. */
function aliasPending(more: Record<string, string> = {}) {
  const storage = mem({
    ...more,
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alias', address: 'ws://alias:9899', token: 't' },
      { id: 'c', name: 'canon', address: 'ws://canonical:9899', token: 't', machineId: 'm-a' },
    ]),
    tmux_server_current: 'ghost',
    tmux_machine_id: 'm-a',
    tmux_hub_drafts: JSON.stringify({ work: 'LATEST' }),
    'tmux_hub_drafts::a': JSON.stringify({ work: 'OLD-ALIAS' }),
    'tmux_hub_drafts::c': JSON.stringify({ work: 'OLD-CANON' }),
    'tmux_hub_drawer::a': JSON.stringify({ work: 'old alias drawer' }),     // the live set has none
  });
  assert.equal(migrateServerState(storage).reason, 'pending');
  storage.setItem('tmux_server_current', 'a');          // a link activates the alias before any auth
  return storage;
}

test('a merge that MOVES the alias s old park into canonical is not an edit: the claim still folds the inputs over it (reviewer P1 on cde052f7)', () => {
  const storage = aliasPending();
  recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' });   // it answers as m-a
  assert.equal(storage.getItem('tmux_server_current'), 'c', 'absorbed into canonical');
  assert.equal(storage.getItem('tmux_hub_drafts::c'), JSON.stringify({ work: 'OLD-ALIAS' }), 'the merge moved the alias s park');
  assert.equal(claimPending(storage, 'c').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::c')!), { work: 'LATEST' }, 'the latest legacy draft, not the moved park');
  assert.equal(storage.getItem('tmux_hub_drawer::c'), null, 'and a value the legacy set cleared does not come back with it');
});

test('what the alias really edited after the inputs went pending survives the merge and the claim', () => {
  const storage = aliasPending();
  storage.setItem('tmux_hub_drafts::a', JSON.stringify({ work: 'typed on the alias' }));
  recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' });
  assert.equal(claimPending(storage, 'c').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::c')!), { work: 'typed on the alias' }, 'a real edit is kept');
  assert.equal(storage.getItem('tmux_hub_drawer::c'), null, 'and the untouched rest still folds');
});

/** `storage` refusing writes to `key` while `on()` says so. */
function refuse(storage: ReturnType<typeof mem>, key: string) {
  const set = storage.setItem;
  let failing = true;
  storage.setItem = (k: string, v: string) => { if (failing && k === key) throw new Error('QuotaExceededError'); set(k, v); };
  return () => { failing = false; };
}

test('a merge whose slot move fails part-way, then a connect straight to canonical: the claim still lands LATEST (reviewer P1 on 4ef4dd07)', () => {
  // A key that moves BEFORE the failing one (RESIDENT_KEYS order), so the
  // canonical slots end up half alias, half canonical.
  const storage = aliasPending({
    tmux_hub_project: 'LATEST-PROJECT',
    'tmux_hub_project::a': 'OLD-ALIAS-PROJECT',
    'tmux_hub_project::c': 'OLD-CANON-PROJECT',
  });
  const restore = refuse(storage, 'tmux_hub_drafts::c');           // a slot write AFTER the record
  assert.throws(() => recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' }), /Quota/u);
  restore();
  assert.equal(storage.getItem('tmux_server_current'), 'a', 'the merge never committed');
  assert.equal(storage.getItem('tmux_hub_drafts::c'), JSON.stringify({ work: 'OLD-CANON' }), 'c s draft was not moved');
  assert.equal(storage.getItem('tmux_hub_project::c'), 'OLD-ALIAS-PROJECT', 'but its project was');
  // The canonical address, which does not re-run the alias merge.
  activateConnected(storage, { address: 'ws://canonical:9899', token: 't', machineId: 'm-a' });
  assert.equal(storage.getItem('tmux_server_current'), 'c');
  assert.equal(claimPending(storage, 'c').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::c')!), { work: 'LATEST' }, 'LATEST, not an old park read as an edit');
  assert.equal(storage.getItem('tmux_hub_project::c'), 'LATEST-PROJECT', 'and the moved half is not read as an edit either');
  assert.equal(storage.getItem('tmux_hub_drawer::c'), null, 'and nothing the legacy set cleared');
});

test('a merge that fails part-way and is then retried keeps what the alias really edited', () => {
  const storage = aliasPending();
  storage.setItem('tmux_hub_drafts::a', JSON.stringify({ work: 'typed on the alias' }));
  const restore = refuse(storage, 'tmux_hub_drafts::c');
  assert.throws(() => recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' }), /Quota/u);
  restore();
  recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' });   // the retry completes it
  assert.equal(storage.getItem('tmux_server_current'), 'c');
  assert.equal(claimPending(storage, 'c').reason, 'folded');
  assert.deepEqual(JSON.parse(storage.getItem('tmux_hub_drafts::c')!), { work: 'typed on the alias' }, 'the real edit survives');
  assert.equal(storage.getItem('tmux_hub_drawer::c'), null);
});

test('if even the move s record cannot be written, nothing moves', () => {
  const storage = aliasPending();
  const before = storage.dump();
  const restore = refuse(storage, LAYOUT_KEY);
  assert.throws(() => recordServer(storage, { address: 'ws://alias:9899', token: 't', machineId: 'm-a' }), /Quota/u);
  restore();
  assert.deepEqual(storage.dump(), before);
});
