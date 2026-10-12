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
