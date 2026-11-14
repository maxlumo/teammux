// Source contract for the micro-motion vocabulary (design-language.md §1
// "Micro-motion"): ONE set of atoms in app.css, on the two tempo tokens, stilled
// under reduced motion, and no component re-implements them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname;
const appCss = readFileSync(join(root, 'src/app.css'), 'utf8');
const motionTs = readFileSync(join(root, 'src/lib/ui/motion.ts'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}
const components = walk(join(root, 'src'));

test('app.css owns one complete-turn spin atom; consumers keep their own semantic duration (#156)', () => {
  const spins = [...appCss.matchAll(/@keyframes\s+spin\s*\{/gu)];
  assert.equal(spins.length, 1, 'the shared rotation has one definition in app.css');
  assert.match(appCss, /@keyframes spin \{ to \{ transform: rotate\(360deg\); \} \}/u);
});

test('the tempo tokens and the JS mirror agree', () => {
  const tokens = /--t-fast:\s*(\d+)ms;\s*--t-move:\s*(\d+)ms;/u.exec(appCss);
  assert.ok(tokens, 'app.css declares --t-fast and --t-move together');
  assert.equal(motionTs.includes(`T_FAST_MS = ${tokens![1]}`), true, 'T_FAST_MS mirrors --t-fast');
  assert.equal(motionTs.includes(`T_MOVE_MS = ${tokens![2]}`), true, 'T_MOVE_MS mirrors --t-move');
});

test('the four atoms exist once, on the tokens, and still under reduced motion', () => {
  assert.match(appCss, /\.chev,\s*\.flip,\s*\.quarter-turn\s*\{[^}]*transition:\s*transform var\(--t-move\)/u, 'a turning glyph moves on --t-move');
  assert.match(appCss, /\.chev\.open\s*\{\s*transform:\s*rotate\(90deg\)/u);
  assert.match(appCss, /\.flip\.on\s*\{\s*transform:\s*rotate\(180deg\)/u);
  assert.match(appCss, /\.quarter-turn\.on\s*\{\s*transform:\s*rotate\(90deg\)/u);
  for (const kf of ['fade-in', 'rise-in', 'pop-in']) {
    assert.match(appCss, new RegExp(`@keyframes ${kf}\\s*\\{\\s*from\\s*\\{[^}]*\\}\\s*\\}`, 'u'), `${kf} is an intro-only keyframe`);
    assert.doesNotMatch(appCss, new RegExp(`@keyframes ${kf}[^}]*(height|width|top|left|margin)`, 'u'), `${kf} animates transform/opacity only`);
  }
  assert.match(appCss, /\.appear\s*\{\s*animation:\s*fade-in var\(--t-fast\)/u);
  assert.match(appCss, /\.appear-rise\s*\{\s*animation:\s*rise-in var\(--t-move\)/u);
  assert.match(appCss, /\.appear-pop\s*\{\s*animation:\s*pop-in var\(--t-fast\)/u);
  assert.match(appCss, /\.state-ctl\s*\{\s*transition:[^}]*border-color var\(--t-fast\)[^}]*background var\(--t-fast\)[^}]*color var\(--t-fast\)/u);
  const still = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.chev,\s*\.flip,\s*\.quarter-turn,\s*\.state-ctl[^{]*\{\s*transition:\s*none;\s*\}\s*\.appear,\s*\.appear-rise,\s*\.appear-pop[^}]*\{\s*animation:\s*none;/u;
  assert.match(appCss, still, 'the atoms still under prefers-reduced-motion');
});

test('the wave-2 atoms: popover intro, sliding indicator, reveal, skeleton', () => {
  assert.match(appCss, /\.pop-layer\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*scale\(0\.96\);[^}]*transform-origin:\s*var\(--pop-origin/u, 'a popover is invisible and slightly small until placed');
  assert.match(appCss, /\.pop-layer\.ready\s*\{[^}]*transform:\s*none;[^}]*transition:[^}]*var\(--t-fast\)/u, 'it grows on --t-fast and rests with no transform');
  assert.match(appCss, /\.slide-pill\.ready\s*\{\s*transition:[^}]*transform var\(--t-move\)/u, 'the indicator glides on --t-move, only once placed');
  assert.doesNotMatch(appCss, /\.slide-ind\b/u, 'the bar indicator is retired — the wash behind the item travels (owner, 2026-09-04)');
  assert.match(appCss, /\.slide-pill\.soft \{ box-shadow: none; \}/u, 'an icon bar wants only the wash');
  assert.doesNotMatch(appCss, /\.slide-pill\.inset/u, 'the inset pill retired with the tab bar wash — ink-only selection there (owner, 2026-09-05)');
  assert.match(appCss, /\.reveal > \*,\s*\.reveal-tail > \*\s*\{\s*animation:\s*rise-in var\(--t-move\) ease-out backwards;/u, 'a loaded list unfolds with backwards fill only');
  assert.match(appCss, /\.reveal-tail > :nth-last-child\(2\)/u, 'a feed unfolds from its newest row');
  assert.match(appCss, /\.skel::after\s*\{[^}]*animation:\s*shimmer/u);
  assert.match(appCss, /\.skel-wrap\s*\{[^}]*animation-delay:\s*150ms/u, 'a skeleton waits 150ms so a fast load never flashes one');
  const still = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*\.pop-layer\.ready,\s*\.slide-pill\.ready\s*\{\s*transition:\s*none;[^@]*\.reveal > \*,\s*\.reveal-tail > \*,\s*\.skel::after,\s*\.skel-wrap\s*\{\s*animation:\s*none;/u;
  assert.match(appCss, still, 'the wave-2 atoms still under prefers-reduced-motion');
});

test('every placed popover wears .pop-layer and no component keeps a private opacity gate', () => {
  const popovers = ['src/lib/ui/ContextMenu.svelte', 'src/lib/ui/Select.svelte', 'src/lib/sessions/PanePicker.svelte', 'src/lib/ui/HoverCard.svelte'];
  for (const rel of popovers) {
    const src = readFileSync(join(root, rel), 'utf8');
    assert.match(src, /class="[^"]*\bpop-layer\b[^"]*" class:ready=/u, `${rel}: the placed layer wears .pop-layer with the ready gate`);
    assert.match(src, /style:--pop-origin=/u, `${rel}: tells the atom which corner it grows from`);
  }
  // #168 removes Roster's private tap menu; its actions use ContextMenu above.
  for (const rel of ['src/App.svelte']) {
    const src = readFileSync(join(root, rel), 'utf8');
    assert.match(src, /class="server-menu menu-surface menu-list pop-layer" class:ready=/u, `${rel}: its picker keeps .pop-layer while adopting shared chrome (#165)`);
  }
  assert.doesNotMatch(readFileSync(join(root, 'src/lib/hub/Roster.svelte'), 'utf8'), /class="a-menu/u);
  for (const file of components) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(root.length);
    assert.doesNotMatch(src, /\.(ctx|sel-menu|a-menu|server-menu|picker|hover-card)\.ready\s*\{\s*opacity:\s*1/u, `${rel}: the .ready opacity gate is the atom's, not the component's`);
  }
});

test('a navigation tab glyph settles into a chosen pose and back (#240)', () => {
  assert.match(appCss, /\.tab-glyph :is\([^)]*\)\s*\{\s*transition:\s*transform var\(--t-move\) ease-out, opacity var\(--t-move\) ease-out;/u,
    'one held transition on --t-move, so leaving moves back the way it came');
  for (const [part, pose] of [['step', 'translateX'], ['cursor', 'scaleX'], ['spin', 'rotate\\(90deg\\)'], ['crew', 'translateY']]) {
    assert.match(appCss, new RegExp(`\\.tab-glyph\\.on \\.glyph-${part} \\{ transform: ${pose}`, 'u'), `.glyph-${part} has a chosen pose`);
  }
  assert.match(appCss, /\.glyph-talk \{ opacity: 0; transform: scale\(0\.4\); \}/u, 'the chat dots rest hidden outside the atom');
  // #262: Files and Board END upright and different — a part appears (files'
  // title line slides in from the left, a card drops into the board's left
  // column). No rotation or mirror: a tilted page read as crooked, a mirrored
  // board as the same board.
  assert.match(appCss, /\.glyph-write \{ opacity: 0; transform: translateX\(-3px\); \}/u, 'the files title line rests hidden, left');
  assert.match(appCss, /\.glyph-card \{ opacity: 0; transform: translateY\(-3px\); \}/u, 'the board card rests hidden, above');
  for (const part of ['write', 'card']) {
    assert.match(appCss, new RegExp(`\\.tab-glyph\\.on \\.glyph-${part} \\{ opacity: 1; transform: none; \\}`, 'u'), `.glyph-${part} settles in upright`);
  }
  // No delay on the Files line in EITHER direction (orchestrator, #262): a
  // delay on either side stalls a reversal that interrupts the other one
  // (deselect mid-entry, or re-select mid-exit), and staggering one moving
  // part against lines that stay still buys nothing. Chat keeps its stagger:
  // three dots move together.
  assert.doesNotMatch(appCss, /glyph-write[^{]*\{[^}]*transition-delay/u, 'the Files line reverses at once both ways');
  assert.doesNotMatch(appCss, /glyph-(tilt|flip)/u, 'the replaced tilt and flip poses are gone whole');
  assert.match(appCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.tab-glyph :is\([^)]*\)[^{]*\{\s*transition:\s*none;/u, 'stilled under reduced motion');
  const icon = readFileSync(join(root, 'src/lib/ui/Icon.svelte'), 'utf8');
  for (const part of ['step', 'cursor', 'talk', 'spin', 'write', 'card', 'crew']) {
    assert.match(icon, new RegExp(`class="glyph-${part}"`, 'u'), `Icon names the .glyph-${part} part`);
  }
  const app = readFileSync(join(root, 'src/App.svelte'), 'utf8');
  assert.match(app, /<span class="tab-glyph" class:on=\{page === slot\}><Icon name=\{RAIL_ITEMS\[slot\]\.icon\}/u, 'the rail icons wear it');
  for (const [page, name] of [['hub', 'chat'], ['board', 'layout'], ['files', 'files'], ['terminal', 'terminal'], ['prefs', 'gear']]) {
    assert.match(app, new RegExp(`<span class="tab-glyph" class:on=\\{page === '${page}'\\}><Icon name="${name}" size=\\{19\\}`, 'u'), `the tab bar's ${name} wears it`);
  }
  assert.doesNotMatch(app, /\.gear-btn[^{]*svg[^{]*\{[^}]*rotate/u, 'the gear has no private turn beside the atom');
});

test('no component re-implements an atom or reaches for svelte/transition', () => {
  for (const file of components) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(root.length);
    assert.doesNotMatch(src, /\n\s*\.(chev|flip|quarter-turn)\s*\{/u, `${rel}: turning glyphs are app.css atoms — add the class, do not redefine it`);
    assert.doesNotMatch(src, /@keyframes\s+(fade-in|rise-in|pop-in|sheet-up|drill-in-right|drill-in-left)\b/u, `${rel}: the shared keyframes live in app.css — reference them by name`);
    assert.doesNotMatch(src, /from ['"]svelte\/transition['"]/u, `${rel}: intros are the .appear* classes, exits are a snap — no svelte/transition`);
    if (/animate:flip/u.test(src)) {
      assert.match(src, /moveMs\(\)/u, `${rel}: animate:flip takes its duration from moveMs() (reduced-motion gate)`);
    }
  }
});

test('every looping animation in a component stills under reduced motion', () => {
  for (const file of components) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(root.length);
    const loops = [...src.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/gu)].map((m) => m[1]);
    if (!loops.length) continue;
    const stilled = /@media\s*\(prefers-reduced-motion:\s*reduce\)/u.test(src);
    assert.ok(stilled, `${rel}: loops ${loops.join(', ')} need a prefers-reduced-motion rule`);
  }
});
