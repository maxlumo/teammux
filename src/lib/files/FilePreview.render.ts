import test from 'node:test';
import assert from 'node:assert/strict';
import type { PreviewFile } from './file-preview.ts';
import { renderHarness, RENDER_TIMEOUT_MS } from '../test/ssr.ts';

// One warm server for the whole render tier (board #178): the environment
// and the svelte runtime are built at import, outside this suite's timer.
const h = await renderHarness();
const noop = () => {};

test('the extracted preview renders every existing branch and preserves the code cap', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Preview = (await h.load('/src/lib/files/FilePreview.svelte')).default;
  const { render } = h;
  const renderFile = (file: Partial<PreviewFile>, showAllLines = false): string => render(Preview, { props: {
    currentFile: { path: '/test/file', name: 'file', ...file },
    fontSize: 14, wrapLines: false, hljs: null, showAllLines,
    previewLinkClick: noop, attachHtmlPreviewLinks: noop,
    previewBodyEl: null, previewEl: null, htmlPreviewEl: null, pdfContainer: null,
  } }).body;

  const markdown = renderFile({ stat: { mime_hint: 'text/markdown' }, content: '# Title\n\n[next](next.md)\n\n<script>inert</script>' });
  assert.match(markdown, /class="preview-body/u);
  assert.match(markdown, /<h1>Title<\/h1>/u);
  assert.match(markdown, /href="next\.md"/u);
  assert.ok(!markdown.includes('<script>'), 'raw Markdown HTML remains inert');
  assert.ok(!markdown.includes('preview-header'), 'no duplicate header in the extracted body');

  const csv = renderFile({ stat: { mime_hint: 'text/csv' }, content: 'a,b\n1,2' });
  assert.match(csv, /class="csv-render/u);
  assert.match(csv, /<td>1<\/td><td>2<\/td>/u);
  assert.ok(!csv.includes('<iframe'));

  const html = renderFile({ stat: { mime_hint: 'text/html' }, content: '<h1>HTML</h1>' });
  // Board #433: the frame waits for its signed base (minted in the client),
  // so the server render never holds an unbased HTML document.
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<h1>HTML</h1>'));
  const pdf = renderFile({ stat: { mime_hint: 'application/pdf' }, pdfData: 'bytes' });
  assert.match(pdf, /class="pdf-container/u);
  assert.ok(!pdf.includes('<iframe'));
  const image = renderFile({ name: 'shot.png', stat: { mime_hint: 'image/png' }, dataUrl: 'data:image/png;base64,eA==' });
  assert.match(image, /<img[^>]*src="data:image\/png;base64,eA=="/u);
  // Board #188: the picture is a BUTTON that opens the one Lightbox (like a
  // chat image) — never a bare <img> you can only look at.
  assert.match(image, /<button class="image-open[^"]*"[^>]*aria-label="shot\.png"/u);
  assert.match(renderFile({ stat: { mime_hint: 'application/octet-stream' }, convertedHtml: '<h2>Slide</h2>' }), /<h2>Slide<\/h2>/u);
  // Board #182: a video is a <video> pointed at the signed stream URL — the
  // browser fetches ranges itself; no bytes pass through the RPC.
  const video = renderFile({ name: 'demo.mp4', stat: { mime_hint: 'video/mp4' }, mediaUrl: 'https://h/dl?path=%2Fdemo.mp4&exp=9&sig=s&stream=1' });
  assert.match(video, /<video[^>]*\bcontrols\b[^>]*src="https:\/\/h\/dl\?path=%2Fdemo\.mp4&amp;exp=9&amp;sig=s&amp;stream=1"/u);
  assert.match(video, /<video[^>]*\bplaysinline\b/u, 'the phone plays in place, not in a forced fullscreen player');
  assert.match(video, /<video[^>]*preload="metadata"/u, 'opening a preview costs the header, not the film');
  assert.ok(!video.includes('<img'));
  // Board #416: a sound is an <audio> on the same signed stream URL, header only until played.
  const audio = renderFile({ name: 'song.mp3', stat: { mime_hint: 'audio/mpeg' }, mediaUrl: 'https://h/dl?path=%2Fsong.mp3&exp=9&sig=s&stream=1' });
  assert.match(audio, /<audio[^>]*\bcontrols\b[^>]*src="https:\/\/h\/dl\?path=%2Fsong\.mp3&amp;exp=9&amp;sig=s&amp;stream=1"/u);
  assert.match(audio, /<audio[^>]*preload="metadata"/u, 'opening a preview costs the header, not the track');
  assert.ok(!audio.includes('<video') && !audio.includes('<img'));

  const content = Array.from({ length: 3002 }, (_, i) => `line ${i}`).join('\n');
  const capped = renderFile({ stat: { mime_hint: 'text/plain' }, content });
  assert.equal([...capped.matchAll(/class="cl-row\b/gu)].length, 3000);
  assert.match(capped, /class="cl-more/u);
  const expanded = renderFile({ stat: { mime_hint: 'text/plain' }, content }, true);
  assert.equal([...expanded.matchAll(/class="cl-row\b/gu)].length, 3002);
  assert.ok(!expanded.includes('class="cl-more'));
});
