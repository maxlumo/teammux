// Source-contract pins for the Backends section (board #492 phase 2; see
// docs/conventions/testing.md): the one cap constant on both sides, the
// transport waits, the one dot language, the shared atoms, and the path as
// selectable text. Behaviour is in BackendsSection.mount.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./BackendsSection.svelte', import.meta.url), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/u.exec(source)?.[1] ?? '';
const rule = (selector: string) => new RegExp(`${selector.replace(/\./gu, '\\.')} \\{([^}]*)\\}`, 'u').exec(style)?.[1] ?? '';

test('one cap, the same word on the server and in the client gate', async () => {
  const rust = await readFile(new URL('../../../src-tauri/src/server/mod.rs', import.meta.url), 'utf8');
  const desktop = /#\[cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)\]\s*pub\(crate\) const LOGIN_CAPS: &\[&str\] = &\[([^\]]*)\]/u.exec(rust)?.[1] ?? '';
  assert.match(desktop, /"backends_check"/u, 'a desktop server announces it');
  const phone = /#\[cfg\(any\(target_os = "android", target_os = "ios"\)\)\]\s*pub\(crate\) const LOGIN_CAPS: &\[&str\] = &\[\]/u;
  assert.match(rust, phone, 'the phone-hosted server has no check, and announces nothing');
  const caps = await readFile(new URL('../core/login-caps.ts', import.meta.url), 'utf8');
  assert.match(caps, /export const BACKENDS_CHECK = 'backends_check';/u);
});

test('the transport waits sit above the server budgets: 20 s Refresh, 35 s Test', async () => {
  const api = await readFile(new URL('../core/ws-api.ts', import.meta.url), 'utf8');
  assert.match(api, /call<unknown>\('backends_check', test \? \{ test \} : \{\}, test \? 35000 : 20000\)/u);
  assert.match(api, /backendsCheck: 'read'/u);
});

test('no poller, no automatic Test: a Test is sent only from its button', () => {
  assert.doesNotMatch(source, /setInterval|setTimeout/u);
  assert.equal(source.match(/run\('test'/gu)?.length, 1, 'one call site');
  assert.match(source, /onclick=\{\(\) => run\('test', b\.name\)\}/u);
});

test('a fact speaks the ONE dot language, and words say it too', () => {
  assert.match(source, /class:live-dot=\{stateIsLive\(factDot\(state\)\)\} style:background=\{stateDotColor\(factDot\(state\)\)\}/u);
  assert.match(source, /<span class="fact-text">\{value\}<\/span>/u, 'text beside every dot');
  assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu, 'no literal colour');
  assert.doesNotMatch(style, /font-size:\s*[\d.]+px/u, 'the type scale only');
});

test('the shared atoms: CommandButton for both actions, the preference row for facts', () => {
  assert.match(source, /<CommandButton icon="refresh" label=\{t\('backendsRefresh'\)\} pending=\{running === 'refresh'\}/u);
  assert.match(source, /<CommandButton icon="zap" label=\{t\('backendsTest'\)\}/u);
  assert.doesNotMatch(source, /<button\b/u, 'no hand-made button');
  assert.match(source, /<div class="preference-row fact">/u);
});

test('the path is selectable text on every layout, never hover-only (reviewer (c))', () => {
  const path = rule('.fact-path');
  assert.match(path, /user-select: text/u);
  assert.match(path, /overflow-wrap: anywhere/u);
  assert.doesNotMatch(path, /text-overflow|white-space: nowrap/u, 'never cut off');
  assert.doesNotMatch(source, /hoverInfo/u, 'no hover card carries what the row does not');
  assert.match(source, /\{#if path\}<span class="fact-path">\{path\}<\/span>\{\/if\}/u);
  // Measured at 390 px (2026-11-02): the shared row wraps its control at
  // max-content, which dropped a long fact under its label; text shrinks instead.
  assert.match(style, /@media \(max-width: 760px\) \{ \.preference-row > \.fact-value \{ flex: 1 1 0; \} \}/u);
});
