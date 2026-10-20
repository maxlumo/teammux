import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./FilePreview.svelte', import.meta.url), 'utf8');

test('the preview body uses the one safe markdown renderer and the shared host path handlers', () => {
  assert.match(source, /import \{ renderMarkdown \} from '\.\.\/core\/markdown\.ts';/u);
  assert.doesNotMatch(source, /marked\.parse\(|from 'marked'|from 'katex'/u);
  assert.match(source, /\{@html renderMarkdown\(currentFile\.content!\)\}/u);
  assert.match(source, /onclick=\{previewLinkClick\} onauxclick=\{previewLinkClick\}/u);
  assert.match(source, /sandbox="allow-same-origin"/u);
  assert.doesNotMatch(source, /allow-scripts/u);
  assert.match(source, /onload=\{attachHtmlPreviewLinks\}/u);
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
