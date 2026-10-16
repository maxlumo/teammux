// Maintenance pin for #403: the connection QR code is the one place the app
// paints a literal black on white, in every theme (a scanner reads dark modules
// on a light ground; an inverted code fails on many). The exception is two
// named tokens, defined once with the other theme-independent tokens, used by
// one component, and written down with its reason in design-language.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../../', import.meta.url);

async function sources(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...await sources(url));
    else if (/\.(?:ts|js|svelte|css)$/u.test(entry.name) && !/\.test\./u.test(entry.name)) out.push(url);
  }
  return out;
}
const rel = (url: URL) => url.pathname.slice(SRC.pathname.length);

test('--qr-ink and --qr-paper are defined once, in the theme-independent :root block, as a literal black and white', async () => {
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  for (const token of ['--qr-ink', '--qr-paper']) assert.equal(css.split(`${token}:`).length - 1, 1, `${token} is defined exactly once`);
  const block = css.match(/\n:root \{[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(block, /--qr-ink: #000; --qr-paper: #fff;/u, 'in the :root block that holds the other theme-independent tokens');
  assert.ok(block.includes('--backend-kiro'), 'the same block as the other identity colours, not a theme block');
});

test('only the QR dialog uses the QR tokens', async () => {
  const users: string[] = [];
  for (const url of await sources(SRC)) {
    if (/--qr-(?:ink|paper)\b/u.test(await readFile(url, 'utf8'))) users.push(rel(url));
  }
  assert.deepEqual(users.sort(), ['app.css', 'lib/app/QrDialog.svelte']);
});

test('the QR dialog draws from modules only: it never sees the link, builds no HTML and keeps nothing', async () => {
  const source = await readFile(new URL('lib/app/QrDialog.svelte', SRC), 'utf8');
  assert.doesNotMatch(source, /\{@html|innerHTML|connection-link|localStorage|sessionStorage|console\./u);
  assert.match(source, /matrix: boolean\[\]\[\]/u, 'its input is the modules');
  assert.doesNotMatch(source, /aria-label=\{[^}]*(?:link|token|address)/iu, 'and its accessible name names no part of the link');
});

test('design-language.md records the exception and its reason', async () => {
  const doc = await readFile(new URL('../docs/design-docs/features/design-language.md', SRC), 'utf8');
  assert.match(doc, /--qr-ink/u);
  assert.match(doc, /--qr-paper/u);
  assert.match(doc, /dark on (?:a )?light in every theme/iu);
});
