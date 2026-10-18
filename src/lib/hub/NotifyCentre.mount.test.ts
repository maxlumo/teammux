// The centre's Mute (board #423, owner 2026-10-19: "小铃铛图标那里，可以点开直接
// 有一个mute的按钮，就是静音不提示"): ONE switch with Settings — the
// `tmux_notify` key, through `notifySwitch` — a labelled toggle, pressed while
// muted; the head's tools are a dense group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./NotifyCentre.svelte', import.meta.url), []);
const centre = { items: [], sources: [], clearable: false, clear() {} };

test('the centre s Mute writes the one switch; muting asks nothing, unmuting unlocks and asks', async (context) => {
  let prompts = 0, plays = 0;
  const app = await (await compiled).mount(context, {
    props: { centre },
    modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_notify', 'on');
      (window as any).Audio = class { play() { plays++; return Promise.resolve(); } };
      (window as any).Notification = class { static permission = 'default'; static requestPermission() { prompts++; return Promise.resolve('granted'); } };
    },
  });
  const mute = () => app.document.querySelector<HTMLButtonElement>('button[aria-label="Mute notifications"]')!;
  try {
    assert.ok(mute(), 'a labelled Mute in the centre');
    assert.equal(mute().getAttribute('aria-pressed'), 'false');
    assert.ok(mute().closest('.nc-head .compact-tools'), 'the head s tools are a dense group (#423)');
    assert.ok(app.document.querySelector('.nc-head .compact-tools .segmented'), 'All | To me sits in the same group');

    mute().click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_notify'), 'off', 'the Settings key: one switch');
    assert.equal(mute().getAttribute('aria-pressed'), 'true');
    assert.equal(prompts + plays, 0, 'muting asks nothing and plays nothing');

    mute().click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_notify'), 'on');
    assert.equal(mute().getAttribute('aria-pressed'), 'false');
    assert.equal(prompts, 1, 'turning sound back on is the gesture that asks (#72)');
  } finally { await app.close(); }
});

test('a write from another window reaches the centre (the key is the one store)', async (context) => {
  const app = await (await compiled).mount(context, {
    props: { centre }, modules: [],
    setup(window) { window.localStorage.setItem('tmux_notify', 'on'); },
  });
  const mute = () => app.document.querySelector<HTMLButtonElement>('button[aria-label="Mute notifications"]')!;
  try {
    assert.equal(mute().getAttribute('aria-pressed'), 'false');
    app.window.localStorage.setItem('tmux_notify', 'off');
    app.window.dispatchEvent(new app.window.StorageEvent('storage', { key: 'tmux_notify' }));
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(mute().getAttribute('aria-pressed'), 'true');
  } finally { await app.close(); }
});

test('a mute the storage refuses claims nothing and says so (review P1)', async (context) => {
  const app = await (await compiled).mount(context, {
    props: { centre }, modules: [],
    setup(window) {
      window.localStorage.setItem('tmux_notify', 'on');
      const real = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function (k: string, v: string) {
        if (k === 'tmux_notify') throw new window.DOMException('full', 'QuotaExceededError');
        return real.call(this, k, v);
      };
    },
  });
  const mute = () => app.document.querySelector<HTMLButtonElement>('button[aria-label="Mute notifications"]')!;
  try {
    mute().click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_notify'), 'on', 'the gate s key is unchanged');
    assert.equal(mute().getAttribute('aria-pressed'), 'false', 'the control does not claim muted');
    assert.match(app.document.querySelector('[role="alert"]')?.textContent ?? '', /Could not save the notification setting/u);
  } finally { await app.close(); }
});
