import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./FilePreview.svelte', import.meta.url), 'utf8');

test('the preview body uses the one safe markdown renderer and the shared host path handlers', () => {
  assert.match(source, /import \{ renderMarkdown \} from '\.\.\/core\/markdown\.ts';/u);
  assert.doesNotMatch(source, /marked\.parse\(|from 'marked'|from 'katex'/u);
  // #434: the SAME renderer in its span mode (data-src on each top-level
  // block), which the review mapper reads; chat never asks for it.
  assert.match(source, /\{@html renderMarkdown\(currentFile\.content!, \{ spans: true \}\)\}/u);
  assert.match(source, /onclick=\{previewLinkClick\} onauxclick=\{previewLinkClick\}/u);
  assert.match(source, /sandbox="allow-same-origin"/u);
  assert.doesNotMatch(source, /allow-scripts/u);
  // Board #111: each load hands the watcher the PARENT's link table.
  assert.match(source, /onload=\{\(\) => attachHtmlPreviewLinks\(htmlLinks\)\}/u);
  assert.match(source, /const p = preparePreview\(content, scope\); htmlLinks = p\.links; htmlSrcdoc = p\.html;/u);
  // Board #433: the frame shows only the based document, never raw content.
  assert.match(source, /\{#if htmlSrcdoc != null\}\s*<iframe[\s\S]*?srcdoc=\{htmlSrcdoc\}/u);
  assert.doesNotMatch(source, /srcdoc=\{currentFile/u);
  assert.doesNotMatch(source, /createPreviewRenderers/u, 'loader caches remain owned by the Files lifetime');
});

test('the code cap and DOM scroll bindings keep their original host-owned state', () => {
  assert.match(source, /showAllLines = \$bindable\(false\)/u);
  assert.match(source, /const CODE_PREVIEW_MAX_LINES = 3000;/u);
  assert.match(source, /let previewLines = \$derived\(\(currentFile\?\.content \?\? ''\)\.split\('\\n'\)\);/u);
  assert.match(source, /\{#each shownLines as line, i\}/u);
  assert.match(source, /\{#if shownLines\.length < previewLines\.length\}[\s\S]{0,200}?showAllLines = true;/u);
  for (const ref of ['previewBodyEl', 'previewEl', 'htmlPreviewEl', 'pdfContainer']) {
    assert.match(source, new RegExp(`${ref} = \\$bindable\\(null\\)`, 'u'));
    assert.ok(source.includes(`bind:this={${ref}}`));
  }
  assert.doesNotMatch(source, /class="preview-header"/u, 'the shared header stays with Files');
});

// Board #130 (owner, 2026-11-15: "这个图片在折叠屏内屏预览下边被截断了"; measured: a 3:4 picture
// overflowed the preview body by 171 px at 717×776 and 327 px at 1280×800). The picture's
// max-height:100% resolves against its zoom BUTTON, which had a definite box only for an SVG
// (#481), so a bitmap was limited by width alone. Every picture now has that containing box:
// the whole image fits (letterboxed), a smaller one keeps its natural size, the margin is inert.
test('every picture fits its preview body: the zoom button is a definite box for a bitmap too (#130)', () => {
  const css = source.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? '';
  const open = css.match(/\.image-open \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(open, /width:\s*100%/u, 'the button takes the body\u2019s width');
  assert.match(open, /height:\s*100%/u, 'and its height, so the picture\u2019s max-height resolves');
  assert.match(open, /display:\s*flex/u);
  assert.match(open, /pointer-events:\s*none/u, 'the letterbox margin is inert');
  assert.match(css, /\.image-open img \{[^}]*pointer-events:\s*auto/u, 'the picture itself takes the tap');
  assert.match(css, /\.image-preview img \{[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;[^}]*object-fit:\s*contain/u, 'max only: a small picture is never enlarged');
  assert.doesNotMatch(css, /\.image-open\.vector/u, 'one rule for every picture, not a vector special case');
});
