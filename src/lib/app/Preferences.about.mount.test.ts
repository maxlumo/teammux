// Settings › About (board #368): this app's build, the focused server's build,
// and the one verdict a stale phone needs. The UI build is a Vite define; the
// component runs in the mount window's realm, which has none, so `setup` gives
// that window the two globals before the bundle loads build-info.ts.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Preferences.test.svelte', import.meta.url), [
  new URL('../hub/AgentsPage.svelte', import.meta.url),
]);

const SAME = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };
const STALE = { version: '1.0.0', commit: '0badc0de', built: '2026-10-12 01:00' };

async function about(context: TestContext, props: Record<string, unknown>) {
  const app = await (await compiled).mount(context, {
    props: { initial: { connected: true, ...props }, register() {} },
    modules: [{ default: () => {} }],
    setup(window) {
      window.__TMM_BUILD__ = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };
      window.__TMM_LICENSE__ = 'MIT';
      window.localStorage.setItem('tmux_settings_tab', 'about');
      window.localStorage.setItem('tmux_locale', 'en');
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const rows = () => [...app.document.querySelectorAll<HTMLElement>('.preference-row')].map((r) => ({
    label: r.querySelector('.config-field-label')?.textContent?.trim() ?? '',
    // A build value is two stacked halves (what it IS, when it was made): read
    // back as the one line the other surfaces speak.
    value: (() => {
      const halves = [...r.querySelectorAll('.pref-control .about-build > span')].map((x) => x.textContent!.trim());
      return halves.length ? halves.join(' · ') : r.querySelector('.pref-control')?.textContent?.trim() ?? '';
    })(),
    el: r,
  }));
  return { app, rows };
}

test('About names this app\'s build and the server\'s, dim while they are the same build', async context => {
  const { app, rows } = await about(context, { serverInfo: { hostname: 'devbox', machineId: 'm', build: SAME } });
  try {
    const r = rows();
    assert.deepEqual(r.map((x) => x.label), ['tmux-mobile', 'Server', 'Source', 'License']);
    assert.equal(r[0]!.value, 'v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC');
    assert.equal(r[1]!.value, 'v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC');
    assert.doesNotMatch(r[1]!.el.textContent!, /devbox/, 'the label is the word; the focus is named by the Settings head, not by a hostname that wraps a phone column');
    assert.equal(app.document.querySelector('.about-build.mismatch'), null);
    assert.equal(app.document.querySelector('.about-mismatch'), null);
    assert.equal(r[3]!.value, 'MIT');
  } finally { await app.close(); }
});

test('two different real commits wear the warn colour and say what to do', async context => {
  const { app, rows } = await about(context, { serverInfo: { hostname: 'devbox', machineId: 'm', build: STALE } });
  try {
    const server = rows()[1]!;
    assert.equal(server.value, 'v1.0.0 · 0badc0de · 2026-10-12 01:00 UTC');
    assert.ok(server.el.querySelector('.about-build.mismatch'), 'the server line carries the mismatch');
    assert.equal(rows()[0]!.el.querySelector('.mismatch'), null, 'and only the server line');
    assert.match(app.document.querySelector('.about-mismatch')?.textContent ?? '', /different builds/);
  } finally { await app.close(); }
});

test('an older server is "unknown", never blank and never a mismatch; offline there is no server row', async context => {
  const old = await about(context, { serverInfo: { hostname: 'devbox', machineId: 'm', build: null } });
  try {
    assert.equal(old.rows()[1]!.value, 'unknown');
    assert.equal(old.app.document.querySelector('.mismatch, .about-mismatch'), null);
  } finally { await old.app.close(); }
  const off = await about(context, { connected: false, serverInfo: { hostname: '', machineId: '', build: null } });
  try {
    assert.deepEqual(off.rows().map((x) => x.label), ['tmux-mobile', 'Source', 'License']);
  } finally { await off.app.close(); }
});

test('the GitHub link lives here once, opens outside, and carries no tracking of its own', async context => {
  const { app } = await about(context, { serverInfo: { hostname: 'h', machineId: 'm', build: SAME } });
  try {
    const links = [...app.document.querySelectorAll<HTMLAnchorElement>('a[href*="github.com/vokako/tmux-mobile"]')];
    assert.equal(links.length, 1);
    assert.equal(links[0]!.target, '_blank');
    assert.match(links[0]!.rel, /noopener/);
  } finally { await app.close(); }
});

test('a build value stacks its halves so a narrow column breaks between them, never inside a timestamp', async context => {
  const { app } = await about(context, { serverInfo: { hostname: 'h', machineId: 'm', build: SAME } });
  try {
    const value = app.document.querySelector('.pref-control .about-build')!;
    assert.deepEqual([...value.querySelectorAll(':scope > span')].map((x) => x.textContent), ['v1.0.0 · 46392f16', '2026-10-14 07:40 UTC']);
  } finally { await app.close(); }
});
