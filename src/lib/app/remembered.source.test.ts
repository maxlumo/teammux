// Maintenance pin for #400: the server registry is the ONLY list of remembered
// connections. The recents list it replaced (`tmux_address_history`) is named
// by exactly one module, servers.ts, which folds it once and removes it. A
// second reader or writer anywhere else brings the second store back, and a
// server deleted in Settings is remembered again by the login page.
// The behaviour proofs are servers.test.ts and App.shell.mount.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../../', import.meta.url);

async function sources(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...await sources(url));
    else if (/\.(?:ts|js|svelte)$/u.test(entry.name) && !/\.test\./u.test(entry.name)) out.push(url);
  }
  return out;
}

test('only servers.ts names the retired address-history key (#400)', async () => {
  const holders: string[] = [];
  for (const url of await sources(SRC)) {
    if ((await readFile(url, 'utf8')).includes('tmux_address_history')) holders.push(url.pathname.slice(SRC.pathname.length));
  }
  assert.deepEqual(holders, ['lib/app/servers.ts']);
});

test('the connect form offers the registry and has no list of its own to forget from (#400)', async () => {
  const fields = await readFile(new URL('lib/app/ConnectFields.svelte', SRC), 'utf8');
  assert.match(fields, /rememberedAddresses\(localStorage\)/u, 'the suggestions are read off the registry');
  assert.doesNotMatch(fields, /hist-del|forget\(|setItem\(/u, 'no forget button and no write of its own');
});
