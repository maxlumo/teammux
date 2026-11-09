// Source-contract test for the ONE text-field family (board #97; see
// docs/conventions/testing.md on source tests).
//
// Owner, 2026-11-09 05:14: "应用里还有很多风格不一致的情况，比如查找的输入框还有设置里
// 的一些输入框的框线的圆角和 chat 输入框不一样". Measured before the change, four
// field paints existed: the composer (corner 10, a 1px line, focus = the
// line turning --accent-line), `.config-input` (corner 12, a fill and no
// line, focus = a 2px outline), the config textareas (corner 12 with a
// line) and a dozen private rules (Sessions' pill search, ConnectFields,
// the create-project and brief inputs, the review note, the folder name,
// the commit message). Now every field a person types into wears
// `.config-input`; the few in-place document editors keep their look and
// take only the family's focus mark (orchestrator, #97 notes 2-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const src = new URL('../../', import.meta.url);
const css = await readFile(new URL('app.css', src), 'utf8');

async function svelteFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...await svelteFiles(p));
    else if (p.endsWith('.svelte') && !p.endsWith('.test.svelte')) out.push(p);
  }
  return out;
}
const libDir = new URL('lib/', src).pathname;
const files = await Promise.all((await svelteFiles(libDir)).map(async (p) => ({ file: p.slice(libDir.length), text: await readFile(p, 'utf8') })));
const styleOf = (text: string) => { const i = text.indexOf('<style'); return i < 0 ? '' : text.slice(i).replace(/\/\*[\s\S]*?\*\//gu, ''); };
const markupOf = (text: string) => { const i = text.indexOf('<style'); return (i < 0 ? text : text.slice(0, i)).replace(/<script[\s\S]*?<\/script>/gu, ''); };

/** Fields that are NOT the family's box, each with its reason. */
const OWN_FIELD = new Map<string, string>([
  ['hub/Composer.svelte c-input', 'the composer: its SHELL is the family\u2019s reference box; the textarea inside is bare'],
  ['hub/Board.svelte d-title-input', 'in-place document editor (D3): keeps its look, takes the focus mark'],
  ['hub/Board.svelte d-body-edit', 'in-place document editor (D3)'],
  ['hub/Board.svelte note-input', 'in-place document editor (D3): the inline note'],
  ['hub/Board.svelte n-title', 'in-place document editor (D3): the create form\u2019s title'],
  ['hub/Hub.svelte h1-edit', 'in-place title rename (D3): the title stays a title'],
  ['files/Files.svelte editor', 'the file editor: a code document over its mirror, not a field'],
]);

test('the family is defined once in app.css: line, fill, the control corner and the line-turning focus (#97)', () => {
  assert.match(css, /--control-radius:\s*var\(--ui-radius-control\);/u, 'one radius scale (D4)');
  const family = css.match(/^\.config-input \{([^}]+)\}/mu)?.[1] ?? '';
  assert.match(family, /border:\s*1px solid var\(--field-line, var\(--border\)\)/u, 'a 1px --border edge (D2)');
  assert.match(family, /border-radius:\s*var\(--control-radius\)/u);
  assert.match(family, /background:\s*var\(--control-field-bg\)/u, 'the fill (D2)');
  assert.match(family, /height:\s*var\(--control-height\)/u, 'the control height per breakpoint');
  const inset = css.match(/^input\.config-input, \.control-field \{([^}]+)\}/mu)?.[1] ?? '';
  assert.match(inset, /box-shadow:\s*inset 0 0 0 1px var\(--field-line, var\(--border\)\)/u, 'a single-line field draws the edge on its paint');
  assert.match(css, /:is\(input\.config-input, textarea\.config-input, \[contenteditable\]\.config-input, input\.control-field\):focus \{ --field-line: var\(--accent-line\); outline: none; \}/u,
    'the composer\u2019s focus mark on TEXT fields only: the edge turns --accent-line, no ring (D1)');
  assert.doesNotMatch(css, /(^|[\s,(])\.config-input:focus/mu, 'no focus rule catches every .config-input, a button included');
  // Round 1 (validator note 10, orchestrator note 11): a button wearing the field look keeps the ring.
  assert.match(css, /:is\(button\.config-input, \.control-field:not\(input\)\):focus-visible \{ outline: 2px solid var\(--accent-ink\); outline-offset: 2px; \}/u,
    'a non-text control keeps the 2px ring');
});

test('every field a person types into wears the family class, or is a named exception (#97)', () => {
  const offenders: string[] = [];
  for (const { file, text } of files) {
    for (const m of markupOf(text).matchAll(/<(input|textarea)\b([^>]*)>/gu)) {
      const attrs = m[2]!;
      if (/type="(checkbox|radio|range|file|hidden)"/u.test(attrs)) continue;
      const cls = /class="([^"]*)"/u.exec(attrs)?.[1] ?? '';
      const classes = cls.split(/\s+/u).filter(Boolean);
      if (classes.some((c) => c === 'config-input' || c === 'sel-trigger')) continue;
      if (classes.some((c) => OWN_FIELD.has(`${file} ${c}`))) continue;
      offenders.push(`${file}: <${m[1]} class="${cls}">`);
    }
  }
  assert.deepEqual(offenders, [], 'a field outside the family draws a second species');
});

test('no component restyles a field\u2019s box: corner, edge, fill or focus live in app.css (#97)', () => {
  const offenders: string[] = [];
  const fieldSel = /(^|[\s,>+~(])(input|textarea)\b|\.(config-input|control-field|sel-trigger)\b/u;
  const boxProp = /(^|;|\s)(border(-radius|-color|-width|-style)?|background(-color)?|outline|box-shadow)\s*:/u;
  const own = [...OWN_FIELD.keys()];
  // Non-text controls built on a native input: their own control species.
  const notText = new Set(['ui/CheckboxGroup.svelte', 'ui/MediaRange.svelte']);
  for (const { file, text } of files) {
    if (notText.has(file)) continue;
    for (const m of styleOf(text).matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
      const sel = m[1]!.trim();
      if (!fieldSel.test(sel)) continue;
      if (own.some((k) => k.startsWith(`${file} `) && sel.includes(`.${k.split(' ')[1]}`))) continue;
      if (/::?(placeholder|-webkit-search-cancel-button)/u.test(sel)) continue;
      if (boxProp.test(m[2]!)) offenders.push(`${file}: ${sel.replace(/\s+/gu, ' ')} { ${m[2]!.trim().replace(/\s+/gu, ' ').slice(0, 80)} }`);
    }
  }
  // The two the family itself names: a select-only value reads by its chevron (#161).
  const allowed = ['ui/Select.svelte: button.sel-trigger { --field-paint: transparent; --field-line: transparent; padding-inline: 0; }'];
  assert.deepEqual(offenders.filter((o) => !allowed.includes(o)), []);
});

/** Every literal px corner left in src/lib, each a non-field case. A new
 * one is either a token or a new line here with its reason. */
const PX_RADII = new Map<string, string>([
  ['app/Preferences.svelte .addr-drop 1px', 'a 2px drop marker line'],
  ['app/Settings.svelte .card 16px', 'a card (non-goal: cards are the panel step)'],
  ['files/FilePreview.svelte .html-preview 4px', 'a rendered page inside the preview'],
  ['files/FilePreview.svelte .image-preview img 4px', 'an image'],
  ['files/FilePreview.svelte .md-render :global(code) 3px', 'inline code'],
  ['files/FilePreview.svelte .md-render :global(pre) 12px', 'a code block'],
  ['files/FilePreview.svelte .md-render :global(img) 6px', 'an image in markdown'],
  ['files/FilePreview.svelte .md-render :global(.mermaid-block) 12px', 'a diagram block'],
  ['files/MediaPlayer.svelte video 4px', 'a video'],
  ['hub/AttachStrip.svelte .pend-row :global(.pend-chip) 6px', 'an attachment chip'],
  ['hub/Board.svelte .seg-b calc(var(--ui-radius-control) - 3px)', 'derived from the control step, inside its segment'],
  ['hub/Board.svelte .seg :global(.slide-pill) calc(var(--ui-radius-control) - 3px)', 'derived from the control step'],
  ['hub/ChatImage.svelte .ci-ref 7px', 'an image reference chip'],
  ['hub/Drawer.svelte .direct-tag 4px', 'a tag'],
  ['hub/Feed.svelte .sk-msg 6px 18px 18px 18px', 'a chat bubble skeleton'],
  ['hub/Feed.svelte .sk-msg.me 18px 18px 6px 18px', 'a chat bubble skeleton'],
  ['hub/Feed.svelte .bubble 6px 18px 18px 18px', 'a chat bubble'],
  ['hub/Feed.svelte .msg.me .bubble 18px 18px 6px 18px', 'a chat bubble'],
  ['hub/Feed.svelte .m-head .m-note-state 4px', 'a tag'],
  ['hub/Feed.svelte .sysline .sys-jump 6px', 'a text link\u2019s hover wash'],
  ['hub/Feed.svelte .day-pill 999px', 'a pill'],
  ['hub/Feed.svelte .p-tag 4px', 'a tag'],
  ['hub/Feed.svelte .pg-bar 2px', 'a progress bar'],
  ['hub/Feed.svelte .pg-tag 4px', 'a tag'],
  ['projects/CreateProjectDialog.svelte .ava 6px', 'an avatar tile'],
  ['projects/Projects.svelte .proj var(--ui-radius-panel, 8px)', 'the panel token with a fallback'],
  ['projects/Projects.svelte .win 5px', 'a window chip'],
  ['sessions/Sessions.svelte .w-badge 5px', 'a badge'],
  ['terminal/Terminal.svelte .xterm-wrap :global(.slider) 4px !important', 'the terminal\u2019s scrollbar thumb'],
  ['ui/CheckboxGroup.svelte .check-box 4px', 'a checkbox square'],
  ['ui/InstallPrompt.svelte .install-banner 16px', 'a banner card'],
  ['ui/InstallPrompt.svelte .install-icon 10px', 'an app icon tile'],
  ['ui/MediaRange.svelte .mr-track 2px', 'a media track'],
  ['ui/Select.svelte .so-ico 3px', 'a backend logo'],
  ['ui/Switch.svelte .switch-track 9px', 'a switch track'],
]);

test('literal px corners in src/lib are the allow-listed non-field cases (#97)', () => {
  const found: string[] = [];
  for (const { file, text } of files) {
    for (const m of styleOf(text).matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
      const r = /border-radius:\s*([^;]*\d+px[^;]*);/u.exec(m[2]!);
      if (!r) continue;
      const sel = m[1]!.trim().replace(/\s+/gu, ' ').replace(/^<style>\s*/u, '');
      found.push(`${file} ${sel} ${r[1]!.trim()}`);
    }
  }
  assert.deepEqual(found.filter((k) => !PX_RADII.has(k)), [], 'a new literal corner: use a token, or add it here with its reason');
  assert.deepEqual([...PX_RADII.keys()].filter((k) => !found.includes(k)), [], 'a stale allow-list line');
});
