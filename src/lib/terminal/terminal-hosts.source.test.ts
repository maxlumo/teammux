// Every element that renders a <Terminal> is a flex container (board #397).
//
// Terminal's root is `flex: 1`, which only fills a FLEX parent. In a block
// parent it takes its content height, and xterm's content is its rows: the
// fit then measures a box exactly as tall as the rows it already has, so a
// terminal that starts on a window tmux left at 80x24 fits 24 rows and never
// grows. Measured on desktop split view (main d77492f7): the second cell's
// box was 384 px in a 790 px cell, tmux kept the window at 24 rows, and the
// bottom of the pane (an agent's status line) was cut off. The mount tier has
// no layout engine, so this rule is a source contract over every host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

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

/** The class of the nearest element opened before `index` and not yet closed. */
function hostClass(markup: string, index: number): string | null {
  const before = markup.slice(0, index);
  const stack: string[] = [];
  for (const m of before.matchAll(/<(\/?)(div|section|main|aside)\b([^>]*)>/gu)) {
    if (m[1]) stack.pop();
    else stack.push(/class="([a-z][\w-]*)/u.exec(m[3] ?? '')?.[1] ?? '');
  }
  return stack.at(-1) || null;
}

test('every element that renders a Terminal is a flex container, so the terminal fills it (board #397)', async () => {
  const hosts: string[] = [];
  for (const file of await svelteFiles(root)) {
    const src = await readFile(file, 'utf8');
    if (file.pathname.endsWith('/terminal/Terminal.svelte')) continue;
    for (const m of src.matchAll(/<Terminal\b/gu)) {
      const cls = hostClass(src, m.index!);
      const name = file.pathname.slice(root.pathname.length);
      assert.ok(cls, `${name}: a <Terminal> whose parent element has no class to check`);
      const rule = new RegExp(`\\n\\s*\\.${cls} \\{([^}]*)\\}`, 'u').exec(src)?.[1] ?? '';
      assert.match(rule, /display: flex;/u, `${name}: .${cls} hosts a Terminal and must be a flex container: {${rule}}`);
      hosts.push(`${name}:.${cls}`);
    }
  }
  // The scan still sees every host the app has (a renamed file or class
  // must be re-pointed here, not silently dropped).
  for (const known of ['App.svelte:.terminal-body', 'lib/sessions/SplitView.svelte:.cell-body', 'lib/hub/Drawer.svelte:.term-body', 'lib/app/ScratchPanel.svelte:.scratch-body']) {
    assert.ok(hosts.includes(known), `the scan found ${known}: ${hosts.join(', ')}`);
  }
});
