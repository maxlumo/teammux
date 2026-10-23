// The server rows say which build their server runs (board #368): on the page
// variant only, only for a LIVE row, and an older server says so instead of
// leaving the line blank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./ServerList.svelte', import.meta.url), []);

const BUILD = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };
const servers = [
  { id: 'a', name: 'alpha', address: 'ws://a:1', token: 't' },
  { id: 'b', name: 'bravo', address: 'ws://b:2', token: 't' },
  { id: 'c', name: 'charlie', address: 'ws://c:3', token: 't' },
];

async function lines(context: any, options: { variant?: 'menu' | 'page'; builds?: (id: string) => unknown; connected?: boolean; statuses?: Record<string, string> }) {
  const members = options.statuses ? {
    included: () => true,
    status: (id: string) => (options.statuses![id] ? { kind: options.statuses![id] } : null),
    ontoggle() {}, orphans: [], ondismiss() {},
  } : null;
  const app = await (await compiled).mount(context, {
    props: {
      servers, currentId: 'a', link: { connected: options.connected ?? true }, variant: options.variant ?? 'page',
      onpick() {}, onrename() {}, onremove() {}, onadd() {}, members, builds: options.builds,
    },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
    modules: [],
  });
  const rows = [...app.document.querySelectorAll<HTMLElement>('.sm-row')];
  const build = (i: number) => rows[i]?.querySelector('.sm-build')?.textContent?.trim() ?? null;
  return { app, build };
}

test('the current server\'s row names its build; a row that is not live says nothing', async context => {
  const { app, build } = await lines(context, {
    builds: (id) => (id === 'a' ? BUILD : undefined),
    statuses: { b: 'connecting', c: 'failed' },
  });
  try {
    assert.equal(build(0), 'server v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC');
    assert.equal(build(1), null, 'still connecting: no answer to give');
    assert.equal(build(2), null, 'failed: no answer to give');
  } finally { await app.close(); }
});

test('in Aggregate each connected member shows ITS OWN build, and an older server says unknown', async context => {
  const other = { ...BUILD, commit: '0badc0de', built: '2026-10-12 01:00' };
  const { app, build } = await lines(context, {
    builds: (id) => ({ a: BUILD, b: other, c: null } as Record<string, unknown>)[id],
    statuses: { b: 'connected', c: 'connected' },
  });
  try {
    assert.equal(build(0), 'server v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC');
    assert.equal(build(1), 'server v1.0.0 · 0badc0de · 2026-10-12 01:00 UTC', 'the member\'s own, not the focused server\'s');
    assert.equal(build(2), 'server: unknown', 'an older server names none: said, never blank');
  } finally { await app.close(); }
});

test('the switcher popover stays two lines: no build there, and none while the link is down', async context => {
  const menu = await lines(context, { variant: 'menu', builds: () => BUILD });
  try { assert.equal(menu.build(0), null); } finally { await menu.app.close(); }
  const down = await lines(context, { connected: false, builds: () => BUILD });
  try { assert.equal(down.build(0), null, 'the current server is not live: nothing to say'); } finally { await down.app.close(); }
});

// #458: the chosen row says, in words, that it is the pending choice and
// what its member is doing; a storage stop keeps its own reason.
test('the chosen row reads chosen / not answering / its storage pause, never someone else\'s word (#458)', async context => {
  for (const [target, want] of [
    [{ id: 'b', failed: false, chosen: true }, /^bravo\s*ws:\/\/b:2· Chosen; the app moves there when it connects$/u],
    [{ id: 'b', failed: true, chosen: true }, /· Chosen; not answering — pick it again to retry$/u],
    [{ id: 'b', failed: true, chosen: true, why: 'Paused: storage' }, /· Chosen; Paused: storage$/u],
    [{ id: 'b', failed: true, chosen: true, why: 'Token refused — edit its connection' }, /· Chosen; Token refused — edit its connection$/u],
  ] as const) {
    const app = await (await compiled).mount(context, {
      props: { servers, currentId: 'a', link: { connected: true, target }, variant: 'page', onpick() {}, onrename() {}, onremove() {}, onadd() {} },
      setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
      modules: [],
    });
    try {
      const row = [...app.document.querySelectorAll<HTMLElement>('.sm-pick')].find((b) => b.querySelector('.sm-name')?.textContent === 'bravo')!;
      assert.match((row.textContent ?? '').replace(/\s+/gu, ' ').trim(), want);
      assert.equal(row.getAttribute('aria-current'), null, 'never the current marker');
    } finally { await app.close(); }
  }
});
