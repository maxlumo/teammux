// The element a <Terminal> renders directly into is a flex container
// (board #397).
//
// Terminal's root is `flex: 1`, which only fills a FLEX parent. In a block
// parent it takes its content height, and xterm's content is its rows: the
// fit then measures a box exactly as tall as the rows it already has, so a
// terminal that starts on a window tmux left at 80x24 fits 24 rows and never
// grows. Measured on desktop split view (main d77492f7): the second cell's
// box was 384 px in a 790 px cell, tmux kept the window at 24 rows, and the
// bottom of the pane (an agent's status line) was cut off. The mount tier has
// no layout engine, so this rule is a source contract over every host.
//
// The host is found with the Svelte parser, not by matching tags (review
// P2-2 on 9ceea08e): logic blocks render in place, so the nearest element
// above them is the host. A <Terminal> whose DOM parent the source cannot
// tell (inside another component's children, a snippet, a dynamic element,
// or at its file's root, where the parent is the component's user) is
// refused, so a new wrapper is checked by hand instead of passing on the
// element around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from 'svelte/compiler';

const root = new URL('../../', import.meta.url); // src/

async function svelteFiles(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) out.push(...await svelteFiles(u));
    else if (e.name.endsWith('.svelte') && !e.name.includes('.test.')) out.push(u);
  }
  return out;
}

type AstNode = { type?: string; name?: string; [key: string]: unknown };
/** Where a <Terminal> renders: the element it is a direct child of, or why
 * the source cannot say. */
type Host = { element: AstNode } | { refused: string };

/** Render their content in place: the host is the element above them. */
const IN_PLACE = new Set(['Fragment', 'IfBlock', 'EachBlock', 'KeyBlock', 'AwaitBlock']);

function terminalHosts(fragment: AstNode): Host[] {
  const found: Host[] = [];
  const walk = (node: unknown, host: Host) => {
    if (Array.isArray(node)) { for (const child of node) walk(child, host); return; }
    if (!node || typeof node !== 'object') return;
    const n = node as AstNode;
    if (n.type === 'Component' && n.name === 'Terminal') { found.push(host); return; }
    let next = host;
    if (n.type === 'RegularElement') next = { element: n };
    // Anything else that can hold markup (another component's children, a
    // snippet, a dynamic element, svelte:*) renders it somewhere this file
    // does not say. Expression nodes land here too; they hold no markup.
    else if (n.type && !IN_PLACE.has(n.type)) next = { refused: `inside a ${n.type}${n.name ? ` <${n.name}>` : ''}, whose DOM parent this file does not say` };
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'metadata' && key !== 'parent' && value && typeof value === 'object') walk(value, next);
    }
  };
  walk(fragment, { refused: 'at the root of its file: its host is wherever the component is used' });
  return found;
}

/** The first static class of an element, if it has one. */
function firstClass(element: AstNode): string | null {
  const attr = (element.attributes as AstNode[]).find((a) => a.type === 'Attribute' && a.name === 'class');
  const parts = Array.isArray(attr?.value) ? attr.value as AstNode[] : [];
  const text = parts.map((p) => (p.type === 'Text' ? String(p.data) : ' ')).join('');
  return /^\s*([a-z][\w-]*)/u.exec(text)?.[1] ?? null;
}

/** Whether a top-level rule `.cls { … }` (one class, no media query)
 * declares `display: flex`. */
function isFlex(css: AstNode | null, src: string, cls: string): boolean {
  const rules = ((css?.children ?? []) as AstNode[]).filter((r) => r.type === 'Rule');
  return rules.some((r) => {
    const prelude = r.prelude as { start: number; end: number };
    if (src.slice(prelude.start, prelude.end).trim() !== `.${cls}`) return false;
    return ((r.block as AstNode).children as AstNode[])
      .some((d) => d.type === 'Declaration' && d.property === 'display' && d.value === 'flex');
  });
}

const hostsOf = (markup: string) => terminalHosts(parse(markup, { modern: true }).fragment as unknown as AstNode)
  .map((h) => ('element' in h ? `${h.element.name}.${firstClass(h.element) ?? ''}` : 'refused'));

test('the host finder takes the real parent and refuses what it cannot place; a host is flex only by its own top-level rule', () => {
  assert.deepEqual(hostsOf('<div class="a">{#if x}{#key y}<Terminal />{/key}{/if}</div>'), ['div.a'], 'blocks render in place');
  assert.deepEqual(hostsOf('<div class="a"><article><Terminal /></article></div>'), ['article.'], 'the wrapper is the host, not the flex div around it');
  assert.deepEqual(hostsOf('<div class="a"><Wrap><Terminal /></Wrap></div>'), ['refused'], 'another component s children');
  assert.deepEqual(hostsOf('<div class="a">{#snippet s()}<Terminal />{/snippet}</div>'), ['refused'], 'a snippet renders where it is called');
  assert.deepEqual(hostsOf('<div class="a"><svelte:element this={tag}><Terminal /></svelte:element></div>'), ['refused'], 'a dynamic element');
  assert.deepEqual(hostsOf('<Terminal />'), ['refused'], 'a file s root: the host is in its user');
  const flex = (style: string) => { const src = `<div class="a"></div><style>${style}</style>`; return isFlex(parse(src, { modern: true }).css as unknown as AstNode, src, 'a'); };
  assert.equal(flex('.a { display: flex; }'), true);
  assert.equal(flex('.a { display: block; } .b { display: flex; }'), false, 'another rule s flex is not this host s');
  assert.equal(flex('@media (min-width: 1px) { .a { display: flex; } }'), false, 'flex only under a media query is not always flex');
});

test('the element a Terminal renders directly into is a flex container, so the terminal fills it (board #397)', async () => {
  const hosts: string[] = [];
  for (const file of await svelteFiles(root)) {
    const src = await readFile(file, 'utf8');
    if (!src.includes('<Terminal')) continue; // a component tag is written literally
    const name = file.pathname.slice(root.pathname.length);
    const ast = parse(src, { modern: true });
    for (const host of terminalHosts(ast.fragment as unknown as AstNode)) {
      assert.ok('element' in host, `${name}: a <Terminal> ${'refused' in host ? host.refused : ''}; check its host by hand and teach this test`);
      const cls = firstClass(host.element);
      assert.ok(cls, `${name}: a <Terminal> directly in a <${host.element.name}> with no class to check`);
      assert.ok(isFlex(ast.css as unknown as AstNode, src, cls), `${name}: .${cls} hosts a Terminal and must be a flex container (display: flex)`);
      hosts.push(`${name}:.${cls}`);
    }
  }
  // The scan sees exactly the hosts the app has: a new, renamed or lost host
  // is written here, so none is added or dropped silently.
  assert.deepEqual(hosts.sort(), ['App.svelte:.terminal-body', 'lib/app/ScratchPanel.svelte:.scratch-body', 'lib/hub/Drawer.svelte:.term-body', 'lib/sessions/SplitView.svelte:.cell-body']);
});
