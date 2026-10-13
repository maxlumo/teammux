// Source-contract test for the sidebar's shared box (see docs/conventions/testing.md).
//
// Every sidebar in this app is built from two shared classes in app.css:
// `.side-h` for a section header and `.side-row` for a row. They agree on ONE
// left inset — 10px — which is what makes the Chat sidebar and the Terminal
// sidebar read as the same component instead of two lists that happen to look
// similar.
//
// Twice now a component has re-declared part of that box locally and drifted:
// first the type dialect (10.5px/1.4px tracking became 11px/0.66px), then the
// padding (`8px 6px 4px`), which put the "PROJECTS" header 4px left of the rows
// it labels and 4px left of Chat's identical header — owner, 2026-08-20: "chat
// 页面和 terminal 页面这里的 projects 文字的位置不一样，样式好像不统一".
//
// A scoped rule outranks a shared class (0,2,0 vs 0,1,0), so the drift is silent:
// nothing breaks, the two pages just stop matching. Hence this guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../../', import.meta.url); // src/

/** The components whose section headers ARE `.side-h` (class:side-h={…}). */
const HEADERS = ['lib/sessions/Sessions.svelte', 'lib/projects/Projects.svelte'];

test('a sidebar header takes its box from .side-h, not from a local override', async () => {
  for (const file of HEADERS) {
    const raw = await readFile(new URL(file, SRC), 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(raw)?.[1] ?? '';
    const css = style.replace(/\/\*[\s\S]*?\*\//g, ''); // comments mention px values
    // EVERY rule that can reach the header in SIDEBAR mode. The third
    // recurrence of this drift was an UNQUALIFIED `.group-label` rule (the
    // first two were `.projects.dense`-scoped), so the test now inverts:
    // only a rule pinned to PAGE mode (`:not(.dense)` / `:not(.sidebar-mode)`)
    // may declare the header's box or type. The fourth recurrence (#232) was
    // a `font-family` on the header's INNER span (`.side-h-inline`), which
    // painted the Terminal sidebar's "PROJECTS" in mono next to Chat's
    // display face — inner spans and the face are guarded too.
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, sel, body]) => [sel!.trim(), body!] as const)
      .filter(([sel]) => /\.group-label|\.side-h-inline/.test(sel) && !/:not\(\.(?:dense|sidebar-mode)\)/.test(sel));
    for (const [sel, body] of rules) {
      assert.ok(
        !/(^|;|\s)padding[^:]*:/.test(body),
        `${file}: \`${sel}\` re-declares the header's padding, which .side-h owns in sidebar mode — qualify it to page mode (:not(.dense) / :not(.sidebar-mode))`,
      );
      assert.ok(
        !/font-size\s*:|font-family\s*:|letter-spacing\s*:|text-transform\s*:/.test(body),
        `${file}: \`${sel}\` re-declares the header's type, which .side-h owns in sidebar mode — qualify it to page mode (:not(.dense) / :not(.sidebar-mode))`,
      );
    }
  }
});

test('app.css still defines the one sidebar inset both classes share', async () => {
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  const head = /\.side-h\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const row = /\.side-row\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const insetOf = (body: string) => {
    const p = /padding:\s*([^;]+);/.exec(body)?.[1]?.trim().split(/\s+/) ?? [];
    // `a b c` → left is b; `a b` → left is b; `a` → a.
    return p.length >= 2 ? p[1] : p[0];
  };
  assert.equal(insetOf(head), '10px', '.side-h must keep the shared inset');
  assert.equal(insetOf(row), '10px', '.side-row must keep the shared inset');
  assert.equal(insetOf(head), insetOf(row), 'a header and a row line up, or the sidebar looks broken');
});

test('the sidebar project-row atoms live in app.css, not in a component', async () => {
  // The Chat and Terminal sidebars are ONE component visually ("应该和terminal
  // 侧边栏一样 … 这两个可以共用", owner 2026-08-24): the age readout and the
  // window/agent chips wear the shared .side-age/.side-win classes. A scoped
  // rule on those classes outranks app.css silently (0,2,0 vs 0,1,0) — the
  // same drift that split the two headers, so the same guard: a component may
  // POSITION the shared containers (.side-wins indent) but never restyle the
  // atoms themselves.
  const FILES = ['lib/hub/Hub.svelte', 'lib/hub/Sidebar.svelte', 'lib/projects/Projects.svelte', 'lib/hub/Board.svelte'];
  for (const file of FILES) {
    const raw = await readFile(new URL(file, SRC), 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(raw)?.[1] ?? '';
    const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, sel] of css.matchAll(/([^{}]+)\{[^}]*\}/g)) {
      assert.ok(
        !/\.side-win(?![s-])|\.side-win-name|\.side-win-dot|\.side-age/.test(sel!),
        `${file}: \`${sel!.trim()}\` restyles a shared sidebar atom — the look lives in app.css`,
      );
    }
  }
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  assert.match(css, /\.side-win\s*\{/u, 'the chip dialect is defined once, in app.css');
  assert.match(css, /\.side-age\s*\{/u, 'the age dialect is defined once, in app.css');
});

test('the two-line project ROW is one shared skeleton — Chat and Board wear it, app.css owns it (board #39)', async () => {
  // The row structure (.proj-row + .dot/.p-main/.p-top/.p-name) lived scoped
  // in Hub.svelte while Board grew its own one-line variant — which is how
  // the two sidebars stopped matching ("board 侧边栏的样式也要和 chat
  // terminal 的侧边栏对齐，我看 projects 这些写的位置都不一样"). The skeleton
  // was lifted to app.css; a scoped re-declaration outranks it silently
  // (0,2,0 vs the lifted rule's specificity), so the guard is the same as
  // the atoms': components may USE the classes, never restyle them.
  const ROW_ATOMS = /\.p-name(?![\w-])|\.p-main(?![\w-])|\.p-top(?![\w-])|\.p-source(?![\w-])|\.proj-row(?![\w-])/;
  for (const file of ['lib/hub/Sidebar.svelte', 'lib/hub/Board.svelte']) {
    const raw = await readFile(new URL(file, SRC), 'utf8');
    const style = /<style>([\s\S]*)<\/style>/.exec(raw)?.[1] ?? '';
    const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, sel] of css.matchAll(/([^{}]+)\{[^}]*\}/g)) {
      assert.ok(
        !ROW_ATOMS.test(sel!),
        `${file}: \`${sel!.trim()}\` re-declares the shared project-row skeleton — it lives in app.css since board #39`,
      );
    }
    // And both sidebars actually WEAR the shared skeleton in markup.
    const markup = raw.replace(/<style>[\s\S]*<\/style>/, '');
    assert.match(markup, /class="side-row proj-row"/u, `${file} renders the shared row`);
    assert.match(markup, /class="p-name"/u, `${file} names through the shared atom`);
  }
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  for (const atom of ['\\.proj-row\\s*\\{', '\\.proj-row \\.dot\\s*\\{', '\\.p-name\\s*\\{', '\\.p-main\\s*\\{', '\\.p-top\\s*\\{', '\\.p-source\\s*\\{']) {
    assert.match(css, new RegExp(atom, 'u'), `app.css defines the skeleton atom ${atom}`);
  }
  // The dot is deliberately SCOPED to .proj-row in app.css: Sessions and the
  // Terminal sidebar have their own scoped .dot species, and a bare global
  // `.dot` would leak into them.
  assert.ok(!/(^|\n)\.dot\s*\{/.test(css), 'no bare global .dot — it must stay qualified to .proj-row');
});

test('the project row yields its wash to the travelling marker — after .side-row.open in the cascade', async () => {
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  const lit = css.indexOf('.side-row.open { background: var(--accent-bg); }');
  const yields = css.indexOf('.proj-row.open { background: none; }');
  assert.ok(lit > 0 && yields > 0);
  assert.ok(yields > lit, 'equal specificity: the override must come later or the in-place wash wins (codex review, 2026-09-23)');
  assert.match(css, /\.proj-row \{[^}]*position: relative;/u, 'rows paint above the marker');
});

test('the row menu rides the title line and only that line keeps its room (owner, 2026-09-24)', async () => {
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.match(css, /\.proj-row \.row-menu \{ position: absolute; right: 10px; top: 6px; width: 24px; height: 24px; \}/u,
    'as a column beside the whole row the ⋯ took 32px from every agent line');
  assert.match(css, /\.proj-row:has\(\.row-menu\) \.p-top \{ padding-right: 32px; \}/u, 'Board rows, without a menu, reserve nothing');
});

test('a tagged row is two lines — identity (.p-top) then source (.p-source), the tag never on the name s line (#360, owner 2026-10-13 22:58)', async () => {
  // On `.p-top` the tag sat between the name and unread · age, and the name
  // was the only shrinkable item: a 240px sidebar read "laminar-…",
  // "tmux-m…", "Ling…". The tag is the widest element and the row's SOURCE;
  // it yields to the name (design-language) by taking its own line, the
  // notification row's grammar (#356). Single has no tag: one line, as before.
  const sidebar = await readFile(new URL('lib/hub/Sidebar.svelte', SRC), 'utf8');
  const top = /<span class="p-top">([\s\S]*?)<\/span>\s*(\{#if e\.tag\}<span class="p-source"><ServerTag name=\{e\.tag\} \/><\/span>\{\/if\})/u.exec(sidebar);
  assert.ok(top, 'the source line follows the identity line, rendered only with a tag');
  assert.doesNotMatch(top![1]!, /ServerTag|p-source/u, 'nothing of the source on the identity line');
  assert.match(top![1]!, /class="p-name"[\s\S]*side-unread[\s\S]*side-age/u, 'identity: name, unread, age — in that order');
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  assert.match(css, /\.p-top \{ display: flex; align-items: baseline; gap: 6px; min-width: 0; \}\n(?:\/\*[\s\S]*?\*\/\n)?\.p-source \{ display: flex; min-width: 0; \}/u,
    'the second line is a flex line beside .p-top in app.css — a shared row atom, not a component rule');
});
