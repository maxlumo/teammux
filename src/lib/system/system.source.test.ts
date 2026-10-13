// Source pins for the system-vitals corner (board #56). These hold the
// component to its contract with the OTHER territories: transport is
// injected, the tempo is low and floored, and failure never blanks a reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./SystemStatus.svelte', import.meta.url)),
  'utf8',
);

test('transport is INJECTED — the component never imports the socket or App (board #56)', () => {
  // The lead's territory split: #55/#57 own App/ws. This component must stay
  // mountable with a stub `load` in a test and integrable with two lines.
  assert.ok(!/core\/ws|from ['"].*\/App|hub\//u.test(source),
    'no ws.ts / App / hub imports — `load` is a prop');
  assert.match(source, /load,/u, 'the load callback is a prop');
});

test('the poll is low-frequency, floored, and stops while hidden', () => {
  // The server computes CPU% over the poll interval itself — a hot loop
  // would be cost AND noise, so the clamp must survive refactors.
  assert.match(source, /Math\.max\(SYS_POLL_MIN_MS, interval\)/u,
    'the interval prop is clamped to the floor');
  assert.match(source, /if \(!visible\) return;/u,
    'hidden → no timer (the hidden-terminal lesson in miniature)');
  assert.match(source, /return \(\) => clearInterval\(timer\);/u,
    'the effect cleans its own timer up');
});

test('fail-soft: a failed load keeps the last reading; nothing renders before the first', () => {
  // "I could not ask" is not "there is nothing" (the roster lesson): only a
  // truthy answer overwrites, and the catch swallows without clearing.
  assert.match(source, /if \(r\) status = r;/u, 'null/failed answers never clear the reading');
  assert.ok(!/catch[\s\S]{0,80}status\s*=/u.test(source), 'the catch never writes status');
  // The verdict rule: the markup is gated on having parts to say.
  assert.match(source, /\{#if parts\.length\}/u, 'renders nothing until a first reading');
});

test('the full reading is the ONE hover card, never a native title (motion.md §1.16, board #86)', () => {
  assert.match(source, /<div class="sysvitals appear" use:hoverInfo=\{detail\}>/u, 'the corner wears the shared hover card');
  assert.ok(!/title=/u.test(source), 'no native title beside the card — a second tooltip species');
  assert.match(source, /sysDetail\(status\)/u, 'the card spells the full numbers the corner abbreviates');
});

test('the sidebar monitor uses quiet token dots and readable value ink', () => {
  assert.ok(!/font-size:\s*\d/u.test(source), 'no raw px font-size (tokens contract)');
  assert.match(source, /var\(--fs-micro\)/u, 'micro chrome step');
  assert.match(source, /class:cpu=\{p\.k === 'CPU'\}[\s\S]*class:mem=\{p\.k === 'MEM'\}[\s\S]*class:disk=\{p\.k === 'DISK'\}/u,
    'the three categories are explicit, not positional guesses');
  assert.match(source, /--sv-hue: var\(--accent\)/u, 'CPU uses the brand accent');
  assert.match(source, /--sv-hue: var\(--status-purple\)/u, 'MEM uses the theme violet');
  assert.match(source, /--sv-hue: var\(--status-ok\)/u, 'DISK uses the theme green');
  const metricRule = source.match(/\.sv \{[^}]*\}/u)?.[0] ?? '';
  assert.match(metricRule, /flex: 0 1 auto/u,
    'metrics keep natural width and flow from the left — never equal thirds');
  assert.ok(!/flex:\s*1\b/u.test(metricRule), 'no equal-column flex growth');
  assert.ok(!/\b(?:background|border|padding):/u.test(metricRule),
    'metrics are one quiet readout — no per-item card surface, border or padding');
  assert.match(source, /\.sv::before \{[^}]*width: 4px[^}]*height: 4px[^}]*background: var\(--sv-hue\)/u,
    'category colour is only a tiny monitor dot');
  assert.match(source, /\.sv-k \{[^}]*color: var\(--text2\)/u, 'labels stay muted');
  assert.match(source, /\.sv-v \{[^}]*color: var\(--text\)/u,
    'numbers use primary ink — the all-text3 grey regression is retired');
  assert.ok(!/#[0-9a-f]{3,8}\b/iu.test(source), 'no raw component colour');
});

test('a reading belongs to the handle that asked for it: a late answer of another generation is dropped (board #335 ③c-5, reviewer P1-C2)', () => {
  assert.match(source, /owner\?: unknown;/u, 'the owner is the HANDLE, not an id — a reconnected same-id runtime is a new owner');
  assert.match(source, /void owner;\s*(?:\/\/[^\n]*\n\s*)*const mine = \+\+gen;\s*untrack\(\(\) => \{ status = null; \}\);/u,
    'a new owner is a new generation and drops the last reading before anything is asked');
  assert.match(source, /const r = await load\(\);\s*if \(gen !== mine\) return;/u, 'an answer is shown only under the generation it was asked in');
  assert.match(source, /<ServerTag name=\{tag\} \/>/u, 'the owner s name sits beside the reading itself, not only in the hover card');
});
