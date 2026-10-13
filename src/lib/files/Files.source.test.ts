// Source pins for the Files page's server door (board #358, owner 2026-10-13:
// "在 File 页面…能很快速、方便地切换不同的 server 连接"): ONE mechanism — App's
// server popover, the same the rail and Settings open — never a second
// switcher species; shown by the ③c-1 tag rule; Files stays this server's
// tree (D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = readFileSync(fileURLToPath(new URL('./Files.svelte', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('../../App.svelte', import.meta.url)), 'utf8');

test('the door opens App s ONE server popover and is shown by the tag rule (#358)', () => {
  assert.match(files, /\{#if onServers && scope\.tag\}/u, 'host-provided toggle AND the ③c-1 tag: more than one server included');
  assert.match(files, /<button type="button" class="server-door"[^>]*aria-haspopup="dialog" aria-expanded=\{serversOpen\}\s*aria-controls=\{serversOpen \? serversControls : undefined\}/u, 'the popover s own dialog semantics, like the phone s Settings row');
  assert.match(files, /onclick=\{\(e\) => onServers\?\.\(e\)\}/u, 'the host toggles; Files owns no server list');
  assert.match(files, /<span class="quarter-turn" class:on=\{serversOpen\}><Icon name="swap-h" size=\{14\} \/><\/span>\s*<ServerTag name=\{scope\.tag\} \/>/u, 'the swap glyph that turns while open, the one tag atom');
  assert.ok(!/ServerList|loadServers|focusServer|currentServerId/u.test(files), 'no second switcher: Files imports nothing of the registry');
  // App hands Files the SAME toggle and open state the rail and Settings use.
  assert.match(app, /<Files [\s\S]*?onServers=\{toggleServerMenu\} serversOpen=\{serverMenuOpen\} serversControls=\{serverPickerId\} \/>/u);
  assert.match(app, /onServers=\{connected && layout\.isTouchDevice \? toggleServerMenu : null\} serversOpen=\{serverMenuOpen\} serversControls=\{serverPickerId\}/u, '(Settings phone row: the same three)');
});

test('the door wears tokens and the side-row washes, no raw sizes or colours', () => {
  const css = files.slice(files.indexOf('<style>'));
  const rule = css.match(/\.server-door \{([^}]*)\}/u)?.[1] ?? '';
  assert.ok(rule, 'the rule exists');
  assert.match(rule, /min-height: var\(--control-height\)/u);
  assert.match(rule, /padding: 0 var\(--tool-inset-inline\)/u);
  assert.ok(!/font-size:\s*\d|#[0-9a-f]{3,8}\b/iu.test(rule), 'tokens only');
  assert.match(css, /\.server-door:hover, \.server-door\.open \{ background: var\(--surface2\); \}/u, 'the side rows hover wash');
});
