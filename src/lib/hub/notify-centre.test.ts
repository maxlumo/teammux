// Board #322: the centre is a bounded INDEX of alerts — newest first, one per
// message, capped; reading a room marks its entries viewed; clearing and
// eviction never touch a room's read mark (there is none in here to touch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Alert } from './notify-centre.svelte.ts';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).$state = (v: unknown) => v;
const { withAlert, readThrough, alertOf, createAlertLog, createCentre, centreSurface, CENTRE_CAP, ALERTS_KEY } = await import('./notify-centre.svelte.ts');
/** One server's centre over the live key, as its runtime's bundle builds it
 * once that server is current (board #335 ②b-2-1). */
const centreNow = () => createCentre(createAlertLog(localStorage));

const ctx = { server: 's1', room: 'proj:p', session: 'p', project: 'P', kind: 'reply' as const, viewed: false, excerpt: 'x' };
const a = (id: number, ts = id, over: Partial<Alert> = {}): Alert => ({ ...alertOf({ id, seq: id, ts, from: 'dev', to: ['human'] }, ctx), ...over });

test('withAlert keeps one entry per message, newest first, capped', () => {
  let list: Alert[] = [];
  for (let i = 1; i <= CENTRE_CAP + 5; i++) list = withAlert(list, a(i));
  assert.equal(list.length, CENTRE_CAP);
  assert.equal(list[0]!.id, String(CENTRE_CAP + 5), 'newest first');
  assert.equal(list.at(-1)!.id, '6', 'the oldest entries are evicted');
  assert.equal(withAlert(list, a(30)), list, 'a re-record of a known message changes nothing');
  const viewed = withAlert(list, a(30, 30, { viewed: true }));
  assert.equal(viewed.find((x) => x.id === '30')!.viewed, true, 'a viewed record upgrades the entry');
  assert.equal(withAlert(viewed, a(30)).find((x) => x.id === '30')!.viewed, true, 'and is never downgraded');
});

test('readThrough marks a room\'s entries at or below the read seq viewed, nothing else', () => {
  const other = { ...a(2), key: 'proj:q|2', session: 'q', room: 'proj:q' };
  const list = [a(3), a(2), a(1), other];
  const next = readThrough(list, 'p', 2);
  assert.deepEqual(next.map((x) => x.viewed), [false, true, true, false]);
  assert.equal(readThrough(next, 'p', 2), next, 'nothing new to mark: same array');
});

test('alertOf names the source and flags a reply to the human (#289)', () => {
  const r = alertOf({ id: 'm1', seq: 7, ts: 5, from: 'lead', to: ['human'] }, ctx);
  assert.equal(r.key, 'proj:p|m1');
  assert.equal(r.server, 's1');
  assert.equal(r.toHuman, true);
  assert.equal(alertOf({ id: 'm2', seq: 8, ts: 5, from: 'lead', to: ['dev'] }, ctx).toHuman, false);
});

test('the store persists per live key, clears records only, and a switched server s centre reads its own list', () => {
  store.clear();
  const centre = centreNow();
  centre.record(a(1));
  centre.record(a(2));
  assert.equal(centre.unviewed, 2);
  centre.markRoomRead('p', 1);
  assert.equal(centre.unviewed, 1);
  assert.equal(JSON.parse(store.get(ALERTS_KEY)!).length, 2, 'persisted under tmux_hub_alerts');
  centre.requestJump(centre.items[0]!);
  const n = centre.jump!.n;
  centre.requestJump(centre.items[0]!);
  assert.equal(centre.isCurrent(n), false, 'a newer jump supersedes');
  // A server switch points the live key at the other server's list, resets
  // the window's surface, and the target's runtime builds its own centre.
  store.set(ALERTS_KEY, JSON.stringify([a(9)]));
  centreSurface.reset();
  const next = centreNow();
  assert.deepEqual(next.items.map((x) => x.id), ['9']);
  assert.equal(next.jump, null, 'a pending jump does not cross servers');
  assert.deepEqual(centre.items.map((x) => x.id), ['2', '1'], 'and the server left keeps what it had');
  next.clear();
  assert.equal(next.items.length, 0);
});

test('a pre-#334 list loses its non-bell entries on load; read marks are not the centre\'s (#334)', () => {
  const plain = a(4, 4, { toHuman: false });                     // an agent↔agent reply
  const note = a(5, 5, { toHuman: false, kind: 'status' });      // an unaddressed note
  const done = a(6, 6, { toHuman: false, kind: 'finished' });    // a finished task, to anyone
  const mine = a(7);                                             // a reply to the human
  store.set(ALERTS_KEY, JSON.stringify([mine, done, note, plain]));
  store.set('tmux_hub_seen', JSON.stringify({ p: { seq: 1, ts: 1 } }));
  const centre = centreNow();
  assert.deepEqual(centre.items.map((x) => x.id), ['7', '6']);
  assert.equal(store.get('tmux_hub_seen'), JSON.stringify({ p: { seq: 1, ts: 1 } }), 'no room read mark moved');
});

test('tmux_hub_alerts is resident per server (#315, #335 ②b-4)', async () => {
  const { RESIDENT_KEYS } = await import('../app/servers.ts');
  assert.ok((RESIDENT_KEYS as readonly string[]).includes(ALERTS_KEY));
});

test('a stored alert entry survives a reload: the unconfirmed report is a bell entry with no recipient (#437)', async () => {
  const { bellEntry } = await import('./notify-centre.svelte.ts');
  assert.equal(bellEntry({ kind: 'alert', toHuman: false }), true);
  assert.equal(bellEntry({ kind: 'finished', toHuman: false }), true);
  assert.equal(bellEntry({ kind: 'reply', toHuman: false }), false, 'agent↔agent talk is still room unread only');
});
