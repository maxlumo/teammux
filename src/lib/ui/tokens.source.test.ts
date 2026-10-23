// Source-contract test for the type scale (see docs/conventions/testing.md).
//
// The app has ONE font-size vocabulary — the `--fs-*` steps on `:root` in
// app.css — and the point of the 2026-08-19 audit was that 185 raw px values
// had grown around it, drifting half a pixel apart per page ("对我们全部的 ui
// 里的字号系统做一个梳理，不要出现太多 hardcode"). Rounding them onto the scale
// is only half the fix; without a guard the next component re-grows its own.
//
// So: no component may name a raw px font-size. The exceptions are listed here
// BY REASON, which is the other thing this test buys — an exception has to be
// argued for in one place instead of hiding in a stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../../', import.meta.url);   // src/

/** Raw px font sizes that are NOT typography and must stay raw. Empty since
 *  the Team page (SVG graph units, an eye-tuned mono textarea) was deleted
 *  whole (board #100); the shape stays so the next justified exception has a
 *  place to live. */
const ALLOWED: { file: string; match: string }[] = [];

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) yield* walk(child);
    else if (/\.(svelte|css)$/u.test(entry.name)) yield child;
  }
}

test('no component names a raw px font-size — the scale is the vocabulary', async () => {
  const offenders: string[] = [];
  for await (const file of walk(SRC)) {
    const rel = file.href.slice(SRC.href.length);
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (!/font-size:\s*\d/u.test(line)) return;
      // A relative size (em) is a document scaling correctly with its base.
      if (/font-size:\s*[\d.]+em/u.test(line)) return;
      if (ALLOWED.some((a) => rel === a.file && line.includes(a.match))) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `use a --fs-* step instead:\n${offenders.join('\n')}`);
});

test('the scale itself is six chrome steps plus the named exceptions', async () => {
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  for (const token of ['--fs-micro', '--fs-meta', '--fs-sub', '--fs-ui', '--fs-body', '--fs-title']) {
    assert.match(css, new RegExp(`${token}:\\s*[\\d.]+px`, 'u'), `${token} must be defined`);
  }
  // Display steps are for the connect card only; the input constant is a
  // BEHAVIOUR (iOS auto-zooms a focused input below 16px), not a type step.
  assert.match(css, /--fs-hero:\s*[\d.]+px/u);
  assert.match(css, /--fs-display:\s*[\d.]+px/u);
  assert.match(css, /--fs-input-touch:\s*16px/u);
  // The control alias must resolve to a step, never to its own number.
  assert.match(css, /--ui-font-control:\s*var\(--fs-[a-z]+\)/u);
});


/** Where a full-round shape (`--ui-radius-pill`, `999px`, `50%`) may still
 *  appear, BY REASON (board #218, owner 2026-09-20: "这个图标按钮应该都用圆角矩形，
 *  不要用圆圈…除了 agent 自己的原型 logo，发送按钮以外，都要圆角矩形的按钮设计"). Buttons
 *  are rounded rectangles on `--ui-radius-control`; a circle or capsule is
 *  one of these, or it is a regression. */
const ROUND_ALLOWED: { file: string; match: string; why: string }[] = [
  { file: 'app.css', match: '--ui-radius-pill: 999px;', why: 'the token itself' },
  { file: 'app.css', match: '.subtle-scroll::-webkit-scrollbar-thumb', why: 'scrollbar thumb' },
  { file: 'app.css', match: '.to-tail.news::after', why: 'the news dot on the to-tail button' },
  { file: 'app.css', match: '.side-win-dot', why: 'a dot' },
  { file: 'app.css', match: '.proj-row .dot', why: 'a dot' },
  { file: 'app.css', match: '.unread-dot', why: 'the unread dot (board #322)' },
  { file: 'App.svelte', match: '.bell-badge', why: 'the centre bell\'s count badge (board #322)' },
  { file: 'lib/app/Preferences.svelte', match: '.addr-dot', why: 'a dot' },
  { file: 'lib/app/ServerList.svelte', match: '.sm-dot', why: 'a dot' },
  { file: 'lib/ui/CommandButton.svelte', match: '.round, .round::before {', why: 'the composer Send — the one circular command' },
  { file: 'lib/ui/Switch.svelte', match: '', why: 'the switch knob and track' },
  { file: 'lib/ui/OperationFeedback.svelte', match: 'progress', why: 'a progress bar' },
  { file: 'lib/ui/AgentChip.svelte', match: '', why: 'a chip (membership/destination), not a button' },
  { file: 'lib/hub/Feed.svelte', match: '.day-pill', why: 'a date tag' },
  { file: 'lib/hub/Feed.svelte', match: 'width: 5px; height: 5px', why: 'a dot' },
  { file: 'lib/hub/Feed.svelte', match: '.s-live', why: 'a dot' },
  { file: 'lib/hub/AgentsPage.svelte', match: 'object-fit: cover', why: 'an avatar' },
  { file: 'lib/hub/Roster.svelte', match: '.ava', why: 'an avatar' },
  { file: 'lib/hub/Board.svelte', match: '.c-live', why: 'the assignee\u2019s running dot (board #293)' },
  { file: 'lib/hub/Roster.svelte', match: '.ctx-ring', why: 'the context ring around an avatar' },
  { file: 'lib/hub/hub-atoms.css', match: '.st', why: 'the status dot' },
  { file: 'lib/sessions/Sessions.svelte', match: '.search-bar', why: 'an input capsule' },
  { file: 'lib/ui/ServerTag.svelte', match: '.server-tag', why: 'a micro tag naming a row s server (#335 ③c-1)' },
  { file: 'lib/sessions/Sessions.svelte', match: '.dot', why: 'a dot' },
  { file: 'lib/system/SystemStatus.svelte', match: '.sv::before', why: 'a dot' },
  { file: 'lib/files/Files.svelte', match: '.file-icon.is-link::after', why: 'a badge on an icon' },
  { file: 'lib/app/Settings.svelte', match: '.spinner', why: 'a spinner' },
  { file: 'App.svelte', match: 'border-top-color', why: 'a spinner' },
  { file: 'lib/projects/Projects.svelte', match: 'width: 7px; height: 7px', why: 'a dot' },
  { file: 'lib/terminal/Terminal.svelte', match: '.sel-handle::after', why: 'the selection handle dot' },
  { file: 'lib/ui/MediaRange.svelte', match: '.mr-thumb', why: 'the position bar\'s dot, painted from the fill\'s own --p (boards #453, #462)' },
];

test('no button is a circle or a capsule: full-round shapes are the listed non-buttons (board #218)', async () => {
  const offenders: string[] = [];
  for await (const file of walk(SRC)) {
    if (/\.test\.(svelte|css)$/u.test(file.pathname)) continue;
    const rel = decodeURIComponent(file.pathname.slice(SRC.pathname.length));
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/border-radius:\s*(?:var\(--ui-radius-pill\)|999px|50%)/u.test(line)) return;
      // The rule's selector: the nearest preceding line that opens a block.
      let head = i;
      while (head > 0 && !/\{\s*$/u.test(lines[head]!) && !/\{/u.test(lines[head]!)) head--;
      const context = lines.slice(Math.max(0, head - 1), i + 1).join('\n');
      const allowed = ROUND_ALLOWED.some((a) => rel === a.file && (a.match === '' || context.includes(a.match) || line.includes(a.match)));
      if (!allowed) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `a button is a rounded rectangle (--ui-radius-control); list a non-button here by reason:\n${offenders.join('\n')}`);
});

// Board #337 (owner 2026-10-09: "为什么背景是一个圆形的呀？这个不符合我们的设计
// 规范"): the round-shape test above only sees a radius written as a round
// VALUE (--ui-radius-pill / 999px / 50%). A circle delivered through a TOKEN
// slips past it — the status bar's scratch control was a 20px square with
// `border-radius: var(--control-radius)` (12px), i.e. a circle, and every
// test stayed green. design-language.md already states the rule in words:
// "on a 24px paint square --ui-radius-control 10 or --control-radius 12 IS a
// circle", and a dense group scales the corner to --control-paint-radius 5
// with its 20px paint (#219). This is that rule, executable.
//
// The checkable shape of it: a rule that paints a SQUARE (same width and
// height) whose side resolves to 24px or less must take the PAINT corner, not
// a field/menu/dialog radius. One level of custom-property indirection is
// resolved, because that is how the size arrives (`--sys-ctl: 20px`).
const FIELD_RADII = ['--control-radius', '--ui-radius-control', '--control-menu-radius', '--control-dialog-radius'];

test('a small square control takes the PAINT corner, so a token cannot deliver a circle (#337)', async () => {
  const offenders: string[] = [];
  for await (const file of walk(SRC)) {
    if (/\.test\.(svelte|css)$/u.test(file.pathname)) continue;
    const rel = decodeURIComponent(file.pathname.slice(SRC.pathname.length));
    const text = await readFile(file, 'utf8');
    // Sizes declared in this file, so `width: var(--sys-ctl)` can be resolved.
    const sizes = new Map<string, number>();
    for (const [, token, px] of text.matchAll(/(--[\w-]+):\s*(\d+)px\s*;/gu)) sizes.set(token!, Number(px));
    const side = (value: string): number | null => {
      const literal = /^(\d+)px$/u.exec(value.trim());
      if (literal) return Number(literal[1]);
      const token = /^var\((--[\w-]+)(?:,[^)]*)?\)$/u.exec(value.trim());
      return token ? sizes.get(token[1]!) ?? null : null;
    };
    for (const block of text.split('}')) {
      const w = /width:\s*([^;]+);/u.exec(block)?.[1];
      const h = /height:\s*([^;]+);/u.exec(block)?.[1];
      if (!w || !h || w.trim() !== h.trim()) continue;
      const px = side(w);
      if (px === null || px > 24) continue;
      const radius = /border-radius:\s*([^;]+);/u.exec(block)?.[1]?.trim();
      if (!radius) continue;
      const field = FIELD_RADII.find((token) => radius.includes(token));
      if (!field) continue;
      const selector = block.split('\n').filter((l) => l.includes('{')).pop()?.trim() ?? block.slice(0, 40);
      offenders.push(`${rel}  ${selector}  ${px}px square with ${field}`);
    }
  }
  assert.deepEqual(offenders, [],
    `a square this small takes var(--control-paint-radius) (5 in a dense group, 7 otherwise) — a field radius is a circle here:\n${offenders.join('\n')}`);
});

// Board #292 (owner 2026-10-01, "名字多个颜色更好看"): agent NAME inks are six
// theme-aware tokens, defined in both theme blocks and nowhere else, and only
// `agentHue` (hub.ts) names them: a component painting --agent-3 by hand is
// a second colour rule.
test('agent name inks are exactly --agent-1..6 per theme, named only by agentHue', async () => {
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  for (const theme of ['dark', 'light']) {
    const start = css.indexOf(`html[data-theme="${theme}"] {`);
    const block = css.slice(start, css.indexOf('\n}', start));
    const defs = [...block.matchAll(/--agent-(\w+):\s*(#[0-9a-f]{6});/giu)].map((m) => m[1]);
    assert.deepEqual(defs, ['1', '2', '3', '4', '5', '6'], `${theme}: six inks, in order`);
  }
  assert.equal([...css.matchAll(/--agent-\w+:/gu)].length, 12, 'twelve definitions, no seventh ink or third block');
  const offenders: string[] = [];
  for await (const file of walk(SRC)) {
    const rel = file.href.slice(SRC.href.length);
    if (rel === 'app.css') continue;
    if ((await readFile(file, 'utf8')).includes('--agent-')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'only agentHue names an agent ink');
  const hub = await readFile(new URL('lib/hub/hub.ts', SRC), 'utf8');
  assert.equal([...hub.matchAll(/var\(--agent-/gu)].length, 1, 'agentHue is the one place that builds the name');
});

// ── One tempo vocabulary: --t-fast and --t-move (board #392, from the validator's #391 finding) ──
//
// design-language.md: "`--t-fast` / `--t-move`" are the two tempos, and a second sliding tempo is a
// regression. Nothing enforced it: a control that wrote `transition: all 300ms` — or `background 0.2s`,
// or a `transition-duration` of its own — passed every test, so the next component re-grew its own
// speed. Like the type scale above: no stylesheet may name a transition duration, and `all` (which
// hides WHAT moves, and moves what a later rule adds) is not a property. Delays are choreography, not
// tempo, and stay out of this. The exceptions are listed here BY REASON.
const TEMPO_EXCEPTIONS: { file: string; selector: string; value: string; why: string }[] = [
  { file: 'app.css', selector: 'body', value: 'background-color 0.3s ease, color 0.3s ease', why: 'the THEME cross-fade on body: the whole screen changes at once, no token of its own; --t-move would make a theme switch read as a flash (motion.md § Deliberately not done)' },
  { file: 'app.css', selector: '.subtle-scroll::-webkit-scrollbar-thumb', value: 'background-color 0.3s ease', why: 'the same theme cross-fade, on the scrollbar thumb' },
  { file: 'App.svelte', selector: 'main, nav', value: 'background-color 0.3s ease, color 0.3s ease', why: 'the same theme cross-fade, on the two surfaces (main, nav) that sit under every page' },
  { file: 'lib/terminal/Terminal.svelte', selector: '.xterm-wrap :global(.xterm-scrollable-element > .invisible)', value: 'opacity 0.35s ease 0.2s !important', why: 'xterm\'s own overlay scrollbar fading OUT after its dwell, forced with !important over xterm\'s stylesheet: not a control\'s tempo' },
  { file: 'lib/terminal/Terminal.svelte', selector: '.xterm-wrap :global(.xterm-scrollable-element > .visible)', value: 'opacity 0.12s ease !important', why: 'the same overlay scrollbar fading IN' },
];

/** Every transition / transition-duration declaration of a stylesheet's text, with the selector of the rule that holds it. */
function transitionDeclarations(text: string, isCss: boolean) {
  const blocks = isCss
    ? [{ at: 0, css: text }]
    : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((m) => ({ at: (m.index ?? 0) + m[0].indexOf(m[1] ?? ''), css: m[1] ?? '' }));
  const out: Array<{ line: number; decl: string; value: string; selector: string }> = [];
  for (const { at, css } of blocks) {
    // comments out, length kept, so a line number is still the file's
    const bare = css.replace(/\/\*[\s\S]*?\*\//gu, (c) => c.replace(/[^\n]/gu, ' '));
    for (const m of bare.matchAll(/(?<![\w-])transition(?:-duration)?\s*:\s*([^;}]*)/gu)) {
      const idx = m.index ?? 0;
      let depth = 0; let open = idx;
      for (; open >= 0; open--) {
        const ch = bare[open];
        if (ch === '}') depth++;
        else if (ch === '{') { if (depth === 0) break; depth--; }
      }
      let from = open - 1;
      while (from >= 0 && !'{};'.includes(bare[from] ?? '')) from--;
      out.push({
        line: text.slice(0, at + idx).split('\n').length,
        decl: m[0].trim(),
        value: (m[1] ?? '').replace(/\s+/gu, ' ').trim(),
        selector: bare.slice(from + 1, open).replace(/\s+/gu, ' ').trim(),
      });
    }
  }
  return out;
}

test('no stylesheet names a transition duration or `transition: all` — the two tempos are the vocabulary', async () => {
  const offenders: string[] = [];
  const used = new Map<string, number>();
  for await (const file of walk(SRC)) {
    const rel = file.href.slice(SRC.href.length);
    if (/\.test\./u.test(rel)) continue;
    for (const d of transitionDeclarations(await readFile(file, 'utf8'), rel.endsWith('.css'))) {
      const rest = d.value.replace(/var\(--t-(?:fast|move)\)/gu, '').replace(/(?<![\d.])0s\b/gu, '');
      if (!/(?<![\w-])\d*\.?\d+m?s\b/u.test(rest) && !/\ball\b/u.test(d.value)) continue;
      // an exception is ONE declaration in ONE rule: the same value in another rule, or twice, is a new tempo
      const key = `${rel}|${d.selector}|${d.value}`;
      const allowed = TEMPO_EXCEPTIONS.some((e) => `${e.file}|${e.selector}|${e.value}` === key);
      used.set(key, (used.get(key) ?? 0) + 1);
      if (allowed && used.get(key) === 1) continue;
      offenders.push(`${rel}:${d.line}  ${d.selector} { ${d.decl} }`);
    }
  }
  assert.deepEqual(offenders, [], `a transition moves on var(--t-fast) or var(--t-move), and names what it moves:\n${offenders.join('\n')}`);
});

test('the tempo exceptions are real: each is one declaration in one rule, verbatim, so a removed or edited one cannot linger as a free pass', async () => {
  for (const e of TEMPO_EXCEPTIONS) {
    const found = transitionDeclarations(await readFile(new URL(e.file, SRC), 'utf8'), e.file.endsWith('.css'))
      .filter((d) => d.selector === e.selector && d.value === e.value);
    assert.equal(found.length, 1, `${e.file}: "${e.selector} { transition: ${e.value} }" must exist exactly once — delete the exception if it is gone (${e.why.slice(0, 48)}…)`);
  }
});

test('--t-fast and --t-move are each defined once, in app.css', async () => {
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  assert.equal((css.match(/--t-fast:\s*\d+ms/gu) ?? []).length, 1, 'one --t-fast');
  assert.equal((css.match(/--t-move:\s*\d+ms/gu) ?? []).length, 1, 'one --t-move');
  for await (const file of walk(SRC)) {
    const rel = file.href.slice(SRC.href.length);
    if (rel === 'app.css' || /\.test\./u.test(rel)) continue;
    assert.doesNotMatch(await readFile(file, 'utf8'), /--t-(?:fast|move):\s*\d/u, `${rel} redefines a tempo`);
  }
});
