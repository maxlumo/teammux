<script lang="ts">
  import type { HLJSApi } from 'highlight.js';
  import { renderMarkdown } from '../core/markdown.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { basedPreviewDoc, highlightLine, mimeCategory, renderCsv, type PreviewFile, type PreviewScope } from './file-preview.ts';

  interface Props {
    currentFile: PreviewFile;
    fontSize: number;
    wrapLines: boolean;
    hljs: HLJSApi | null;
    showAllLines: boolean;
    previewLinkClick: (event: MouseEvent) => void;
    attachHtmlPreviewLinks: () => void;
    previewBodyEl: HTMLDivElement | null;
    previewEl: HTMLDivElement | null;
    htmlPreviewEl: HTMLIFrameElement | null;
    pdfContainer: HTMLDivElement | null;
    /** Open the picture in the host's fullscreen viewer (board #188). */
    onview?: (src: string) => void;
    /** Whether the page showing this preview is on screen. Files stays mounted
     * and hidden on a tab or server switch, so a playing track or film would
     * go on with no controls in sight (board #416 review). */
    visible?: boolean;
    /** Mint an HTML preview's signed scope URL on this file's server (board #433). */
    previewBase?: (path: string) => Promise<PreviewScope>;
    /** A base that could not be minted: the frame is not shown without one. */
    onpreviewerror?: (message: string) => void;
    /** A change asks the HTML preview for a fresh base (the Refresh button). */
    renew?: number;
  }
  let {
    currentFile, fontSize, wrapLines, hljs, onview = () => {}, visible = true,
    previewBase = () => Promise.reject(new Error('no preview base')), onpreviewerror = () => {}, renew = 0,
    showAllLines = $bindable(false),
    previewLinkClick, attachHtmlPreviewLinks,
    previewBodyEl = $bindable(null), previewEl = $bindable(null),
    htmlPreviewEl = $bindable(null), pdfContainer = $bindable(null),
  }: Props = $props();

  /** A trackpad pinch reaches a page as ctrl+wheel; Svelte's `onwheel` is
   * passive, so this listener is the one place that may preventDefault. */
  function pinchOpens(node: HTMLElement, open: () => void) {
    const onWheel = (event: WheelEvent) => { if (event.ctrlKey) { event.preventDefault(); open(); } };
    node.addEventListener('wheel', onWheel, { passive: false });
    return { destroy() { node.removeEventListener('wheel', onWheel); } };
  }

  /** The video or audio element, if the preview is one. */
  let mediaEl = $state<HTMLMediaElement | null>(null);
  // Hiding the page pauses the media and nothing else: the element, its signed
  // URL and its position stay, and showing the page again never plays.
  $effect(() => { if (!visible) mediaEl?.pause(); });

  // An HTML preview loads its relative resources through a signed directory
  // cap (board #433). Every showing mints its own (a Back, a Refresh): the
  // base is never kept on the file. The frame shows only what THIS run of the
  // effect prepared — any change of file or content ends the run, clears the
  // frame and drops that run's late answer. A refused or failed mint reports
  // its error and still shows the page, under a CSP that loads nothing —
  // never an unbased document fetching from the app's origin.
  let htmlSrcdoc = $state<string | null>(null);
  $effect(() => {
    const file = currentFile;
    const content = file.content;
    void renew;
    if (mimeCategory(file.stat?.mime_hint) !== 'html' || content == null) return;
    let live = true;
    previewBase(file.path).then((scope) => {
      if (live) htmlSrcdoc = basedPreviewDoc(content, scope);
    }).catch((e) => {
      if (!live) return;
      // The SAME preparation without a scope; if even that fails, no frame.
      try { htmlSrcdoc = basedPreviewDoc(content, null); } catch {}
      onpreviewerror(`${t('previewResourcesNotLoaded')}: ${e?.message ?? String(e)}`);
    });
    return () => { live = false; htmlSrcdoc = null; };
  });

  // Keep the cap state in Files so an editor round-trip does not reset it.
  const CODE_PREVIEW_MAX_LINES = 3000;
  let previewLines = $derived((currentFile?.content ?? '').split('\n'));
  let shownLines = $derived(showAllLines || previewLines.length <= CODE_PREVIEW_MAX_LINES
    ? previewLines
    : previewLines.slice(0, CODE_PREVIEW_MAX_LINES));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="preview-body" bind:this={previewBodyEl} onclick={previewLinkClick} onauxclick={previewLinkClick} style="--file-font-size:{fontSize}px">
  {#if mimeCategory(currentFile.stat?.mime_hint) === 'markdown'}
    <div class="md-render" bind:this={previewEl}>{@html renderMarkdown(currentFile.content!, { spans: true })}</div>
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'csv'}
    <div class="csv-render">{@html renderCsv(currentFile.content)}</div>
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'html'}
    {#if htmlSrcdoc != null}
      <iframe
        class="html-preview"
        bind:this={htmlPreviewEl}
        srcdoc={htmlSrcdoc}
        sandbox="allow-same-origin"
        title="HTML Preview"
        onload={attachHtmlPreviewLinks}
      ></iframe>
    {/if}
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'pdf'}
    <div class="pdf-container" bind:this={pdfContainer} style="margin: -12px; padding: 0;"></div>
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'image'}
    <!-- Board #188 (owner: "点击图片全屏放大…触摸板两指放大手势，不是把整个页面
         放大"): the picture is a BUTTON into the one Lightbox, as a chat image
         is (ChatImage .ci-link); and a trackpad pinch — ctrl+wheel in every
         browser — is taken by the image (non-passive, so the page keeps its
         zoom) and answered with the viewer, where pinch/wheel zoom the image. -->
    <div class="image-preview">
      <button class="image-open" aria-label={currentFile.name} onclick={() => onview(currentFile.dataUrl ?? '')}
        use:pinchOpens={() => onview(currentFile.dataUrl ?? '')}>
        <img src={currentFile.dataUrl} alt={currentFile.name} />
      </button>
    </div>
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'video'}
    <!-- Board #182: the browser's own player streams ranges from the signed
         /dl URL (206 + Accept-Ranges); preload=metadata costs the header, not
         the film; playsinline keeps the phone in the preview, not a forced
         fullscreen player. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <div class="image-preview"><video bind:this={mediaEl} controls playsinline preload="metadata" src={currentFile.mediaUrl}></video></div>
  {:else if mimeCategory(currentFile.stat?.mime_hint) === 'audio'}
    <!-- Board #416: the same stream as the video above, into the browser's own
         audio player; preload=metadata costs the header, not the track. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <div class="image-preview"><audio bind:this={mediaEl} controls preload="metadata" src={currentFile.mediaUrl}></audio></div>
  {:else if currentFile.convertedHtml}
    <div class="md-render">{@html currentFile.convertedHtml}</div>
  {:else}
    <!-- 'code' and every other text: one lined view, capped (see shownLines).
         Review comments (#434) map a selection by these rows: `.cl-row`
         order IS the line number, `.cl-code` the line's text. -->
    <div class="code-lined" class:wrap={wrapLines}>
      {#each shownLines as line, i}
        <div class="cl-row"><span class="cl-num">{i + 1}</span><code class="cl-code">{@html highlightLine(line, currentFile.stat?.mime_hint, hljs) || '\u200b'}</code></div>
      {/each}
      {#if shownLines.length < previewLines.length}
        <button class="cl-more" onclick={() => { showAllLines = true; }}>
          {t('previewShowAllLines').replace('{n}', String(previewLines.length))}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Preview body */
  .preview-body { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; padding: 12px; display: flex; flex-direction: column; min-height: 0; }
  /* Per-line code view: each logical line is its own flex row (number + code),
     so the line number sits at the top of its row and stays aligned even when
     the code soft-wraps. No-wrap mode scrolls horizontally with the number
     column pinned (sticky) on the left. */
  .code-lined {
    flex: 1; overflow: auto; -webkit-overflow-scrolling: touch;
    font-family: var(--font-mono); font-size: var(--file-font-size, 13px); line-height: 1.5;
    padding: 12px 0;
  }
  .cl-row { display: flex; align-items: flex-start; }
  .cl-num {
    position: sticky; left: 0; z-index: 1; flex-shrink: 0; min-width: 2.5em; padding: 0 8px;
    text-align: right; color: var(--text3); user-select: none; white-space: pre;
    background: var(--bg); border-right: 1px solid var(--border);
  }
  .cl-code {
    margin: 0 0 0 10px; flex: 1; min-width: 0; color: var(--text);
    white-space: pre; font-family: inherit;
  }
  .cl-code :global(code) { font-family: inherit; background: none; padding: 0; }
  .code-lined.wrap .cl-code { white-space: pre-wrap; word-break: break-word; }
  /* The "show all N lines" tail of a capped preview: a text button in the
     gutter's row grid, sticky like the numbers so it is reachable at any
     horizontal scroll. */
  .cl-more {
    display: block; position: sticky; left: 0; margin: 8px 0 0 10px; padding: 6px 10px;
    min-height: 44px; border: 1px solid var(--border); border-radius: var(--ui-radius-control);
    background: var(--surface); color: var(--accent); font: inherit; cursor: pointer;
    transition: background var(--t-fast);
  }
  .cl-more:hover { background: var(--surface2); }
  .html-preview {
    flex: 1; width: 100%; border: none; background: #fff; border-radius: 4px;
  }
  .pdf-container {
    flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; padding: 4px;
    background: var(--surface);
  }
  .image-preview {
    flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 12px;
  }
  .image-preview img, .image-preview video { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; }
  .image-preview audio { width: 100%; }
  .image-open { display: block; max-width: 100%; max-height: 100%; padding: 0; margin: 0; border: 0; background: none; cursor: zoom-in; touch-action: none; }
  .md-render { font-size: var(--file-font-size, 14px); line-height: 1.6; color: var(--text); overflow-wrap: break-word; }
  .md-render :global(h1) { font-size: 1.55em; margin: 16px 0 8px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .md-render :global(h2) { font-size: 1.28em; margin: 14px 0 6px; color: var(--accent); }
  .md-render :global(h3) { font-size: 1.15em; margin: 10px 0 4px; color: var(--accent); }
  .md-render :global(h4), .md-render :global(h5), .md-render :global(h6) { font-size: 1em; margin: 8px 0 4px; color: var(--accent); }
  .md-render :global(p) { margin: 8px 0; }
  .md-render :global(code) { background: var(--surface2); padding: 2px 5px; border-radius: 3px; font-size: 0.86em; font-family: var(--font-mono); }
  .md-render :global(pre) { background: var(--code-bg); border-radius: 12px; padding: 12px; overflow-x: auto; margin: 8px 0; }
  .md-render :global(pre code) { background: none; padding: 0; font-size: var(--fs-ui); line-height: 1.5; }
  .md-render :global(strong) { color: var(--text); }
  .md-render :global(em) { color: var(--text2); }
  .md-render :global(a) { color: var(--accent); text-decoration: none; }
  .md-render :global(a:hover) { text-decoration: underline; }
  .md-render :global(ul), .md-render :global(ol) { padding-left: 20px; margin: 6px 0; }
  .md-render :global(li) { margin: 3px 0; }
  .md-render :global(blockquote) { border-left: 3px solid var(--accent); margin: 8px 0; padding: 4px 12px; color: var(--text2); }
  .md-render :global(hr) { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .md-render :global(img) { max-width: 100%; border-radius: 6px; }
  .md-render :global(table) { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: var(--fs-body); }
  .md-render :global(th), .md-render :global(td) { padding: 8px 12px; border: 1px solid var(--input-border); text-align: left; }
  .md-render :global(th) { background: var(--surface2); color: var(--accent); font-weight: 600; }
  .md-render :global(input[type="checkbox"]) { margin-right: 6px; }
  .md-render :global(.katex-display) { overflow-x: auto; margin: 8px 0; }
  .md-render :global(.mermaid-block) { background: var(--surface); border-radius: 12px; padding: 12px; margin: 8px 0; overflow-x: auto; }
  .md-render :global(.mermaid-block svg) { max-width: 100%; }
  .csv-render { overflow: auto; }
  .csv-render :global(table) { border-collapse: collapse; font-size: var(--fs-ui); width: 100%; }
  .csv-render :global(th), .csv-render :global(td) {
    padding: 6px 10px; border: 1px solid var(--input-border); text-align: left;
  }
  .csv-render :global(th) { background: var(--surface2); color: var(--accent); font-weight: 600; }
  .csv-render :global(td) { color: var(--text); }


</style>
