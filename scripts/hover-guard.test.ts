// A hover is a pointer's paint, a press is a finger's (board #392).
//
// Owner: "应用里还是有很多按钮，点击的时候背景不太对…现在经常点击下去，背景就是一片非常大的方框，看起来非常丑，
// 尤其是在设置页面". Two causes, measured in Chromium with touch emulation (hover: none):
//   · a TAP sets :hover and nothing clears it until the next tap elsewhere — `.side-row:hover` was still
//     true, and its --surface2 wash still on the whole 374px row, 1.5 s after the finger lifted;
//   · the browser's own tap flash (rgba(0,0,0,.18) over the control's whole box) on every control that
//     had not declared `-webkit-tap-highlight-color` itself: the Settings segmented controls, the server
//     rows, the address field, the chat's agent rows.
// scripts/hover-guard.mjs is the first cure (PostCSS, in the one place all CSS passes), app.css `html`
// the second. What this file holds is both, plus that no later rule can bring either back.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { generate, parse, walk } from 'css-tree';
import postcss from 'postcss';
import { compile } from 'svelte/compiler';
import { preprocessCSS, resolveConfig } from 'vite';
import { createViteConfig } from '../vite.config.js';
import { hoverGuard, splitSelector } from './hover-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = async (css: string) => (await postcss([hoverGuard()]).process(css, { from: undefined })).css;
/** Comments out, whitespace and the last `;` of a block out: CSS compared by what it says. */
const norm = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\s+/gu, ' ').replace(/ ?([{};,:]) ?/gu, '$1').replace(/;\}/gu, '}').trim();
const has = (css: string, expected: string) => norm(css).includes(norm(expected));

/** Every rule whose selector has a :hover, with whether a (hover: hover) media rule encloses it. */
function hoverRules(css: string) {
  const out: Array<{ selector: string; guarded: boolean }> = [];
  postcss.parse(css).walkRules((rule) => {
    if (!/:hover(?![\w-])/u.test(rule.selector)) return;
    let guarded = false;
    for (let p = rule.parent; p; p = p.parent) if (p.type === 'atrule' && (p as postcss.AtRule).name === 'media' && /\bhover\s*:\s*hover/u.test((p as postcss.AtRule).params)) guarded = true;
    out.push({ selector: rule.selector, guarded });
  });
  return out;
}

/** Every stylesheet the app ships: app.css, and each component's CSS as Svelte hands it to PostCSS
 * (compiled: scoped, `:global()` resolved — the shapes the plugin really sees). */
function sourceStylesheets() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(svelte|css)$/u.test(name) && !/\.test\./u.test(name)) files.push(path);
    }
  };
  walk(join(ROOT, 'src'));
  return files.map((file) => {
    const text = readFileSync(file, 'utf8');
    const css = file.endsWith('.css') ? text : (compile(text, { filename: file, generate: 'client', css: 'external' }).css?.code ?? '');
    return { file: file.slice(ROOT.length), css, raw: text };
  });
}

test('a :hover rule applies where a pointer can hover and nowhere else; its finger twin is the same paint on :active', async () => {
  const out = await run('.side-row:hover { background: var(--surface2); }');
  assert.equal(norm(out), norm('@media (hover: hover), (pointer: none){.side-row:hover{background:var(--surface2)}}.side-row:active{background:var(--surface2)}'));
});

test('a selector list is split: the members that are not hover keep applying everywhere', async () => {
  const out = await run('.menu-item:not(:disabled):is(:hover, .cur) { background: var(--surface2); }');
  assert.ok(has(out, '.menu-item:not(:disabled):is(.cur){background:var(--surface2)}'), 'the keyboard cursor is a state, not a pointer: it stays unguarded');
  assert.ok(has(out, '@media (hover: hover), (pointer: none){.menu-item:not(:disabled):is(:hover){background:var(--surface2)}}'), 'the hover member is guarded');
  const list = await run('.b:hover, .c { color: blue; }');
  assert.ok(norm(list).startsWith(norm('.c{color:blue}@media (hover: hover), (pointer: none){.b:hover{color:blue}}')), norm(list));
  assert.deepEqual(splitSelector('.a:hover'), { hover: ['.a:hover'], rest: [] });
  assert.deepEqual(splitSelector('.a'), { hover: [], rest: ['.a'] });
});

test('a press twin only repaints: a reveal, a move, a descendant of the hovered thing, a pseudo-element and a rule with its own :active get none', async () => {
  for (const css of [
    '.row:hover .acts { opacity: 1; }',
    '.handle:hover { opacity: 0.6; }',
    '.x:hover { text-decoration: underline; }',
    '.door:hover .tag { background: var(--control-hover); }',
    '.t::-webkit-scrollbar-thumb:hover { background-color: red; }',
  ]) {
    const out = await run(css);
    assert.ok(out.includes('@media (hover: hover)'), `guarded: ${css}`);
    assert.ok(!/:active/u.test(out), `no twin: ${css}`);
  }
  const own = await run('.d:hover { background: red; } .d:active { background: blue; }');
  assert.equal(norm(own), norm('@media (hover: hover), (pointer: none){.d:hover{background:red}}.d:active{background:blue}'), 'the control that already speaks for its press keeps its own');
});

test('a rule already guarded is left alone; one inside another media rule is guarded inside it; a keyframe is not a rule', async () => {
  const guarded = await run('@media (hover: hover) { .f:hover { color: red; } }');
  assert.equal(norm(guarded), norm('@media (hover: hover){.f:hover{color:red}}'), 'a guard the author wrote is theirs');
  const nested = await run('@media (max-width: 760px) { .e:hover { color: red; } }');
  assert.ok(has(nested, '@media (max-width: 760px){@media (hover: hover), (pointer: none){.e:hover{color:red}}'), norm(nested));
});

test('a :hover that cannot be guarded safely is a build error that names the selector, not a silent sticky hover', async () => {
  await assert.rejects(run('.a:not(:hover) { color: red; }'), /':hover' inside ':not\(\)' cannot be guarded: \.a:not\(:hover\)/u);
  await assert.rejects(run('.a:is(:hover:not(.b)) { color: red; }'), /hover-guard: ':is\(\)' alternative/u);
});

test('the shapes it will not move throw (the reviewer\'s four, and the rest), and a ":hover" that is only text is not a hover', async () => {
  for (const [css, why] of [
    ['.a:has(:is(:hover, .cur)) { color: red; }', 'a flat group NESTED in :has() (reviewer 1)'],
    ['.a:hover:is(:hover, .cur):is(:hover, .sel) { color: red; }', 'an outer hover hiding two groups that hold one (reviewer 2)'],
    ['.a:is(:hover, .cur):is(:hover, .sel) { color: red; }', 'two groups that hold a hover'],
    ['.a:is(:hover, #chosen) { color: red; }', 'an id alternative: splitting would lower the specificity of the hover arm'],
    ['.a:is(:hover, .b.c) { color: red; }', 'an alternative heavier than :hover'],
    ['.a:is(:hover, div) { color: red; }', 'a type alternative'],
    ['.a:is(:hover, p.cur) { color: red; }', 'a type plus a class: as many parts as :hover, a stronger selector'],
    ['.a:is(:hover, [data-x]) { color: red; }', 'an attribute alternative: not a plain class'],
    ['.a:is(:hover, .b .c) { color: red; }', 'an alternative with a combinator'],
    ['.a:has(:hover) { color: red; }', 'a hover inside :has()'],
    ['.a:not(:hover) { color: red; }', 'a hover inside :not()'],
    ['.a:nth-child(2n of :hover) { color: red; }', 'a hover inside :nth-child(of)'],
  ] as const) await assert.rejects(run(css), /hover-guard:/u, why);
  const text = await run('[data-x=":hover"] { color: red; }');
  assert.ok(!text.includes('@media'), 'a hover inside an attribute value is text, not a state');
  // reviewer 3: the press twin renames the REAL pseudo-class, never the text in an attribute value
  const mixed = await run('.a[data-x=":hover"]:hover { color: red; }');
  assert.ok(has(mixed, '.a[data-x=":hover"]:active{color:red}'), `the attribute keeps its value in the twin: ${norm(mixed)}`);
  assert.ok(has(mixed, '@media (hover: hover), (pointer: none){.a[data-x=":hover"]:hover{color:red}}'), 'and in the guarded rule');
  // an escape is read by the parser, not guessed at
  const escaped = await run('.a\\:b:hover { color: red; }');
  assert.ok(has(escaped, '.a\\:b:active{color:red}') && has(escaped, '.a\\:b:hover{color:red}'), norm(escaped));
  // reviewer 4: a media condition counts as a guard only when it IS one; every other is guarded again inside it
  for (const media of ['not (hover: hover)', '(hover: hover), (max-width: 760px)', '(hover: hover) and (min-width: 700px)', '(hover: none)', '(any-pointer: coarse)']) {
    const out = await run(`@media ${media} { .a:hover { color: red; } }`);
    assert.ok(has(out, `@media ${media}{@media (hover: hover), (pointer: none){.a:hover{color:red}}`), `${media}: the hover is guarded inside it: ${norm(out)}`);
  }
  for (const media of ['(hover: hover)', '(any-hover: hover)', '(hover: hover), (pointer: none)']) {
    const out = await run(`@media ${media} { .a:hover { color: red; } }`);
    assert.equal(norm(out), norm(`@media ${media}{.a:hover{color:red}}`), `${media}: a guard that is one is left alone`);
  }
});

/** Specificity of the selectors this test writes: ids, classes / attributes / pseudo-classes, types; :is / :not take their strongest argument, :where counts nothing. */
function specificity(selector: string): [number, number, number] {
  const max = (list: Array<[number, number, number]>): [number, number, number] => list.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2]))) ? b : a), [0, 0, 0]);
  let id = 0; let cls = 0; let type = 0; let rest = selector;
  for (let m = /:(is|not|where)\(([^()]*)\)/u.exec(rest); m; m = /:(is|not|where)\(([^()]*)\)/u.exec(rest)) {
    if (m[1] !== 'where') { const inner = max((m[2] ?? '').split(',').map((a) => specificity(a.trim()))); id += inner[0]; cls += inner[1]; type += inner[2]; }
    rest = rest.replace(m[0], '');
  }
  id += (rest.match(/#[\w-]+/gu) ?? []).length;
  cls += (rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/gu) ?? []).length;
  type += (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gu) ?? []).length;
  return [id, cls, type];
}
const stronger = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A selector with every `:name` pseudo-class turned into the class `.h`, by the parser — no string replace, so text inside an attribute value is left alone. */
function asClass(selector: string, name: string): string {
  const ast = parse(selector, { context: 'selector' });
  walk(ast, { visit: 'PseudoClassSelector', enter(node: { type: string; name: string; children?: unknown }) {
    if (node.name.toLowerCase() !== name) return;
    Object.assign(node, { type: 'ClassSelector', name: 'h', children: undefined });
  } });
  return generate(ast);
}
const topLevel = (list: string) => { const parts: string[] = []; let depth = 0; let cur = ''; for (const ch of list) { if (ch === '(' || ch === '[') depth++; if (ch === ')' || ch === ']') depth--; if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; } parts.push(cur.trim()); return parts; };

test('what it rewrites matches the same elements with the same strength, and its press twin is exactly the hover arm (jsdom, parser-made oracle)', async () => {
  const dom = new JSDOM(`<div id="root"><div class="row a h"></div><div class="row a cur"></div><div class="row a sel"></div><div class="row b h"></div>
    <div class="row a" id="chosen"></div><p class="x"><span class="a h"><i class="b"></i></span></p><button class="a h" disabled></button><button class="a cur"></button></div>`);
  const els = [...dom.window.document.querySelectorAll('#root *')];
  const best = (selectors: string[], el: Element) => selectors.filter((sel) => el.matches(sel)).map(specificity).sort(stronger).at(-1) ?? null;
  for (const input of [
    '.a:hover', '.a:is(:hover, .cur)', '.row.a:not(:disabled):is(:hover, .cur)', '.x .a:hover .b', '.x .a:hover',
    '.a:hover, .b', '.b:hover, .a:is(:hover, .sel)', 'button.a:hover:not(:disabled)', '.a:where(:hover, .cur)', '.row:hover .nothing',
    '.a[data-x=":hover"]:hover', 'button.a:hover::before',
  ]) {
    const original = topLevel(input).map((sel) => asClass(sel, 'hover'));
    const out = postcss.parse(await run(`${input} { color: red; }`));
    const guarded: string[] = []; const rest: string[] = []; const twins: string[] = [];
    out.walkRules((rule) => {
      const inGuard = rule.parent?.type === 'atrule' && /hover/u.test((rule.parent as postcss.AtRule).params);
      if (/:hover(?![\w-])/u.test(rule.selector) && inGuard) guarded.push(...rule.selectors.map((s) => asClass(s, 'hover')));
      else if (/:active(?![\w-])/u.test(rule.selector)) twins.push(...rule.selectors.map((s) => asClass(s, 'active')));
      else rest.push(...rule.selectors.map((s) => asClass(s, 'hover')));
    });
    for (const el of els) {
      assert.deepEqual(best([...guarded, ...rest], el), best(original, el), `${input} -> ${[...guarded, ...rest].join(' | ')}: ${el.outerHTML.slice(0, 50)} must match with the same specificity`);
      // the press twin is the hover arm and nothing else (the rest of a list does not become a press)
      assert.deepEqual(best(twins, el), twins.length ? best(guarded, el) : null, `${input}: the press twin ${twins.join(' | ')} must equal the hover arm ${guarded.join(' | ')} on ${el.outerHTML.slice(0, 50)}`);
    }
  }
});

test('EVERY stylesheet the app ships comes out with no :hover outside (hover: hover), and none throws', async () => {
  let rules = 0;
  for (const { file, css } of sourceStylesheets()) {
    if (!/:hover/u.test(css)) continue;
    let out = '';
    try { out = await run(css); } catch (error) { assert.fail(`${file}: ${(error as Error).message}`); }
    const found = hoverRules(out);
    rules += found.length;
    assert.deepEqual(found.filter((r) => !r.guarded).map((r) => r.selector), [], `${file}: a hover rule outside the guard`);
  }
  assert.ok(rules > 40, `the scan saw ${rules} hover rules: it is reading the stylesheets`);
});

test('the Vite config runs it on every stylesheet, and the shared atoms come out right (the Settings row, the menu row)', async () => {
  const config = await resolveConfig({ ...createViteConfig('build'), configFile: false, plugins: [], logLevel: 'silent' }, 'build');
  const appCss = readFileSync(join(ROOT, 'src/app.css'), 'utf8');
  const out = (await preprocessCSS(appCss, join(ROOT, 'src/app.css'), config)).code;
  assert.deepEqual(hoverRules(out).filter((r) => !r.guarded), [], 'through the real config, app.css has no unguarded hover');
  assert.ok(has(out, '@media (hover: hover), (pointer: none){.side-row:hover{background:var(--surface2)}}'), 'the Settings row washes under a pointer');
  assert.ok(has(out, '.side-row:active{background:var(--surface2)}'), 'and under a finger only while it presses');
  assert.ok(has(out, '.menu-item:not(:disabled):is(.cur){background:var(--surface2)}'), 'the menu cursor is not a hover');
});

test('the browser\'s own tap flash is switched off in ONE place, inherited by every control; nothing else in src mentions it, app.css included (board #392)', () => {
  const appCss = readFileSync(join(ROOT, 'src/app.css'), 'utf8');
  const html = /\nhtml \{([\s\S]*?)\n\}/u.exec(appCss)?.[1] ?? '';
  assert.match(html, /-webkit-tap-highlight-color: transparent;/u, 'the root rule');
  // ONE mention in the whole of src: a second rule anywhere — another class in app.css (a visible colour passed the
  // first version of this pin, validator #392 P3), a component, an inline style — is the whack-a-mole this replaced
  // (about fifty copies; every control added without one flashed)
  const mentions = sourceStylesheets().flatMap(({ file, raw }) => (raw.match(/tap-highlight/gu) ?? []).map(() => file));
  assert.deepEqual(mentions, ['src/app.css'], 'exactly one mention of the property in src, and it is html\'s');
});
