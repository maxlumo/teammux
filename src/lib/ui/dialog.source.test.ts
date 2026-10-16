// Source-contract test for the ONE dialog shell (board #317,
// design-language.md "Dialogs").
//
// Four components had copied the shell. ConfirmDialog owned the whole
// contract; AddServerDialog re-typed it with its own Tab selector;
// CreateProjectDialog and the Hub's team picker had copied only the PAINT and
// so drifted into three shapes (--bg2 vs --bg, 440 vs 420px, radius 18 vs
// --control-dialog-radius, z-index 30/31 vs 60/61, one with no fade at all)
// while having NO Escape, NO Tab trap and NO focus restore. Each copy looked
// reasonable when it was written, and nothing failed. This test is what makes
// the fifth copy fail instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../../', import.meta.url);           // src/
const SHELL = 'lib/ui/Dialog.svelte';

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.name.endsWith('.svelte')) yield child;
  }
}

const files: { rel: string; text: string }[] = [];
for await (const f of walk(SRC)) {
  files.push({ rel: f.href.slice(SRC.href.length), text: await readFile(f, 'utf8') });
}
const shell = files.find((f) => f.rel === SHELL)!;
/** Code only: the shell DISCUSSES the mechanisms it does not use (popstate,
 * the content classes it leaves to app.css), and a test that cannot tell a
 * mention from a use is a test nobody can satisfy (confirm.source.test.ts). */
const code = (text: string) => text
  .replace(/<!--[\s\S]*?-->/gu, '')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '');

test('only the shell paints a dialog: no component declares a second .dlg rule', () => {
  // The <style> block is what matters: a CONSUMER names .dlg-actions in its
  // markup (that class is a global atom in app.css) and may style its own
  // content, but the card, the scrim and the sheet belong to the shell.
  const offenders = files
    .filter(({ rel }) => rel !== SHELL)
    .filter(({ text }) => {
      const style = /<style[^>]*>([\s\S]*?)<\/style>/u.exec(text)?.[1] ?? '';
      return /(?:^|[\s,}])\.dlg(?:-backdrop)?\s*[,{]/mu.test(style) || /\.dlg\.sheet/u.test(style);
    })
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], 'render ui/Dialog instead of re-declaring .dlg / .dlg-backdrop / .dlg.sheet');
});

test('nothing hand-rolls a modal backdrop element either', () => {
  const offenders = files
    .filter(({ rel }) => rel !== SHELL)
    .filter(({ text }) => /class="dlg-backdrop"/u.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], 'the scrim is the shell’s');
});

test('every dialog in the app renders the shell', () => {
  for (const rel of ['lib/ui/ConfirmDialog.svelte', 'lib/app/AddServerDialog.svelte',
    'lib/projects/CreateProjectDialog.svelte', 'lib/hub/Hub.svelte']) {
    const text = files.find((f) => f.rel === rel)!.text;
    assert.match(text, /import Dialog from '[^']*Dialog\.svelte'/u, `${rel}: imports the shell`);
    assert.match(text, /<Dialog\b/u, `${rel}: renders it`);
  }
});

test('the shell owns the modal contract its consumers stopped repeating', () => {
  const { text } = shell;
  assert.match(text, /aria-modal="true"/u);
  assert.match(text, /aria-busy=\{busy \|\| undefined\}/u, 'a running operation is announced, not just painted');
  // Escape: IME-safe, busy-guarded (through cancel()), and only for the top
  // modal — the three rules the copies each got partly right.
  assert.match(text, /if \(activeModal\(document\) !== dialog\) return;/u, 'only the top modal answers keys');
  assert.match(text, /e\.key === 'Escape' && !e\.isComposing/u, 'an IME composition keeps its own Escape');
  assert.match(text, /function cancel\(\) \{\s*if \(!busy\) oncancel\(\);/u, 'busy blocks the scrim AND Escape in one place');
  // Tab wraps over fields as well as buttons: AddServerDialog's selector was
  // the superset, ConfirmDialog's was buttons-only.
  assert.match(text, /const FOCUSABLE = 'input:not\(:disabled\), button:not\(:disabled\), textarea:not\(:disabled\), select:not\(:disabled\), \[tabindex\]:not\(\[tabindex="-1"\]\)';/u);
  assert.match(text, /e\.shiftKey \? \(index <= 0 \? focusables\.length - 1 : index - 1\) : \(index \+ 1\) % focusables\.length/u);
  // Focus: in on open unless the content claimed it, back to the opener on
  // close, never past a modal that opened over this one.
  assert.match(text, /if \(!dialog\.contains\(document\.activeElement\)\) focusDefault\(\);/u);
  assert.match(text, /previousFocus\.isConnected\s*\n?\s*&& \(!owner \|\| owner === dialog \|\| owner\.contains\(previousFocus\)\)\) previousFocus\.focus/u);
  // The one motion (motion.md): the card FADES on --t-fast because it is
  // centred by a transform; the phone sheet rises on the shared keyframe
  // under a scrim that fades on --t-move.
  assert.match(text, /\.dlg \{[\s\S]*?animation: fade-in var\(--t-fast\) ease-out;/u);
  assert.match(text, /\.dlg-backdrop \{[^}]*animation: fade-in var\(--t-move\) ease-out;/u);
  assert.match(text, /\.dlg\.sheet \{[\s\S]*?animation: sheet-up var\(--t-move\) ease-out;/u);
  assert.match(text, /@media \(prefers-reduced-motion: reduce\) \{ \.dlg-backdrop, \.dlg, \.dlg\.sheet \{ animation: none; \} \}/u);
  // One card geometry, zoom-corrected (a raw vh at zoom > 1 put DirPicker's
  // confirm button below the screen edge, owner 2026-08-25).
  assert.match(text, /width: min\(420px, calc\(100vw \/ var\(--ui-zoom, 1\) - 32px\)\)/u);
  assert.match(text, /max-height: calc\(100vh \/ var\(--ui-zoom, 1\) - 48px\)/u);
  assert.match(text, /border-radius: var\(--control-dialog-radius\)/u);
  assert.match(text, /padding: 16px 14px calc\(16px \+ var\(--sab, 0px\)\)/u, 'the sheet pads with --sab, never raw env()');
  // The only dialog species is the ROLE: app.css keys the confirmation's one
  // paint difference (corner-shape, #161) off `[role="alertdialog"]`, so the
  // shell needs no class prop for a caller to paint a fifth dialog with.
  assert.match(text, /\{role\} aria-modal="true"/u, 'the caller\u2019s role reaches the element');
  assert.doesNotMatch(code(text), /class[:=]\s*(?:extra|className|classes)/u, 'no class door');
  // Escape is a CONSUMABLE dismissal: the innermost open layer gets it first,
  // and the dialog closes only when nothing consumed it (#317 review P1-b —
  // the shell's one window listener used to cancel a folder NAME by closing
  // the whole project form). The scrim is deliberately NOT routed through the
  // guard: clicking outside is unambiguous.
  assert.match(text, /if \(!escapeGuard\(\)\) cancel\(\);/u);
  assert.match(text, /e\.stopPropagation\(\); e\.preventDefault\(\);\s*\n\s*if \(!escapeGuard\(\)\)/u,
    'handled either way, so nothing further acts on the key');
  assert.match(text, /onclick=\{cancel\}/u, 'the scrim closes without asking');
  // Back is the host's layer chain, not the shell's: a shell that consumed
  // popstate would peel two layers for one gesture.
  assert.doesNotMatch(code(text), /popstate|history\./u);
});

test('the dialog content dialect lives once, in app.css', async () => {
  // The children belong to the CALLER's component, so a rule scoped inside
  // Dialog.svelte would never match them — these are global atoms.
  const css = await readFile(new URL('app.css', SRC), 'utf8');
  for (const rule of [/^\.dlg h2 \{ margin: 0; font-size: var\(--fs-title\); \}/mu,
    /^\.dlg-note \{ margin: 0; color: var\(--text2\)/mu,
    /^\.dlg-actions \{ display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; \}/mu,
    /^\.dlg\.sheet :is\(input, \.dlg-actions button, \.dlg-actions \.command-button\) \{ min-height: 44px; \}/mu]) {
    assert.match(css, rule);
  }
  assert.doesNotMatch(code(shell.text), /\.dlg-actions|\.dlg-note/u, 'the shell does not scope what it does not render');
});

test('one peel order serves Escape and the phone Back (#317 review)', async () => {
  // The dialog's own steps are peeled innermost-first by ONE function, which
  // the shell asks as its escapeGuard and the host calls for Back. Two orders
  // would mean the two dismissals disagreeing about what a draft is.
  const create = files.find((f) => f.rel === 'lib/projects/CreateProjectDialog.svelte')!.text;
  assert.match(create, /export function goBack\(\) \{\s*\n\s*if \(pickerEl\?\.cancelLocal\(\)\) return true;[\s\S]{0,120}?if \(pickerOpen\) \{ pickerOpen = false; return true; \}[\s\S]{0,80}?return false;/u,
    'field, then picker, then the host closes it');
  assert.match(create, /<Dialog \{compact\} label=\{t\('projectNew'\)\} escapeGuard=\{goBack\}/u, 'Escape asks that function');
  // The component that OWNS the state exposes the cancel (the ServerList
  // dialect), so the dialog never reaches into a child's internals.
  const picker = files.find((f) => f.rel === 'lib/files/DirPicker.svelte')!.text;
  assert.match(picker, /export function cancelLocal\(\): boolean \{\s*\n\s*if \(!creating\) return false;/u);
  assert.match(picker, /e\.key === 'Escape' && !e\.isComposing\) cancelLocal\(\)/u,
    'the field\u2019s own handler runs the same cancel, not a second copy');
  // Both hosts of that dialog peel through it — one order, two hosts.
  for (const [rel, re] of [
    ['lib/sessions/Sessions.svelte', /if \(showNew\) \{\s*\n\s*if \(!createEl\?\.goBack\(\)\) showNew = false;\s*\n\s*return true;/u],
    ['lib/hub/Hub.svelte', /if \(!createOpen\) return false; if \(!createEl\?\.goBack\(\)\) createOpen = false; return true;/u],
  ] as const) assert.match(files.find((f) => f.rel === rel)!.text, re, `${rel}: peels through the dialog`);
});

test('the phone Back peels the shell’s dialog before any page layer (#317)', async () => {
  // A dialog is modal: a Back that peeled a page layer behind it would act on
  // something the reader cannot see. App owns the add-server dialog, so App's
  // popstate chain peels it first; every other dialog is registered by the
  // page that owns it (Hub's backLayers, Projects/Sessions/Files' goBack).
  const app = await readFile(new URL('App.svelte', SRC), 'utf8');
  const chain = /const handler = \(e\) => \{([\s\S]*?)\n    \};/u.exec(app)?.[1] ?? '';
  assert.ok(chain, 'the popstate chain is still one handler');
  const peel = chain.indexOf('if (addServer)');
  const firstPage = chain.indexOf("if (page ===");
  assert.ok(peel > 0 && peel < firstPage, 'the dialog is peeled before the first page branch');
  assert.match(chain, /if \(addServer\) \{ addServer = null; navPush\(\); return; \}/u,
    'and it spends the entry it consumed, like every other peel');
});
