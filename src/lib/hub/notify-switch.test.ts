// The mute switch and the effect gate are ONE effective state (board #423
// review P1): the switch's face moves only after the key did, so when the
// storage refuses the write, the UI does not say "muted" while `notifyNews`
// still rings, and when it accepts it, the gate is muted too. The REAL gate
// (`notifyNews` with `enabled: notifyEnabled`) is asked here, not a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
let refuse = false;
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { if (refuse) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).localStorage = fake;
let asks = 0;
(globalThis as any).Notification = class {
  static permission = 'denied';
  static requestPermission() { asks++; (globalThis as any).Notification.permission = 'granted'; return Promise.resolve('granted'); }
};
(globalThis as any).$state = (v: unknown) => v;
store.set('tmux_notify', 'on');
const { notifySwitch } = await import('./notify-switch.svelte.ts');
const { notifyNews, notifyEnabled } = await import('./notifications.ts');

/** Does the real gate ring for one away reply to the human? */
function rings(): { cue: number; sys: number } {
  const fired = { cue: 0, sys: 0 };
  notifyNews([{ id: `m${Math.random()}`, from: 'dev', body: 'done', to: ['human'] }],
    { first: false, away: true, project: 'p', server: 's', room: 'proj:p' },
    { seen: new Set(), lastCueAt: 0 },
    { cue: () => { fired.cue++; return true; }, sys: () => { fired.sys++; return true; }, enabled: notifyEnabled, level: () => 'replies' });
  return fired;
}

test('a mute the storage refuses changes nothing: the face stays on AND the gate still rings', async () => {
  store.set('tmux_notify', 'on');
  refuse = true;
  try {
    assert.equal(await notifySwitch.set(false), false, 'the door reports the refused write');
    assert.equal(notifySwitch.on, true, 'the face does not claim muted');
    assert.deepEqual(rings(), { cue: 1, sys: 1 }, 'and the gate agrees: it rings');
  } finally { refuse = false; }
});

test('a mute that is written: the face is off AND the gate is silent, both channels', async () => {
  store.set('tmux_notify', 'on');
  assert.equal(await notifySwitch.set(false), true);
  assert.equal(notifySwitch.on, false);
  assert.equal(store.get('tmux_notify'), 'off', 'the one key');
  assert.deepEqual(rings(), { cue: 0, sys: 0 });
});

test('turning it on asks once, and the permission snapshot follows (one source for every caption)', async () => {
  store.set('tmux_notify', 'off');
  (globalThis as any).Notification.permission = 'denied';
  notifySwitch.refreshPermission();
  assert.equal(notifySwitch.permission, 'denied');
  const before = asks;
  assert.equal(await notifySwitch.set(true), true);
  assert.equal(asks, before + 1, 'the turn-on gesture asks');
  assert.equal(notifySwitch.permission, 'granted', 'and re-reads the platform');
  assert.deepEqual(rings(), { cue: 1, sys: 1 });
  const again = asks;
  assert.equal(await notifySwitch.set(false), true);
  assert.equal(asks, again, 'muting asks nothing');
});
