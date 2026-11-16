<script lang="ts">
  // The project page (board #111; docs/design-docs/features/dashboard.md
  // § The project page): the Dashboard's last section. The document is the
  // Files HTML preview's (#433) unchanged in kind: a srcdoc frame, same
  // origin, NO scripts, its policy and the signed read-only door; the app adds
  // its tokens as the one base sheet and reads the page's links, fields and
  // height from outside. This element is never moved or unmounted to hide it
  // (the Board hides an ancestor), so a playing track and a typed field
  // survive Dashboard ⇄ Board and another tab.
  import { tick, untrack } from 'svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { resolvePathRef } from '../core/path-links.ts';
  import { agoShort } from './hub.ts';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { preparePreview, routePreviewHref, watchPreviewLinks, type PreviewLinks, type PreviewScope } from '../files/file-preview.ts';
  import { capExpiry, contentHeight, decide, editedFields, fieldSnapshot, inProgress, pageSheet, staleness, type FieldSnapshot, type PageHead } from './project-page.ts';

  type Loaded = { rev: number; by: string; at: number; html: string; dir: string; base: string; scope: PreviewScope };

  let {
    api,
    session,
    head,
    visible = true,
    now = Date.now(),
    compact = false,
    shown = (name: string) => name,
    onOpenFile = (_path: string) => {},
    onEdited = (_edited: boolean) => {},
    onGuard = (_editedNow: (() => boolean) | null) => {},
  }: {
    /** The RPC of the server whose scope holds the Board (AC7). */
    api: { pageLoad: (session: string) => Promise<Loaded | null> };
    session: string;
    /** The dashboard read's head: the current revision, or undefined when the
     * read could not say (a page_error keeps the last). */
    head: PageHead | undefined;
    visible?: boolean;
    now?: number;
    compact?: boolean;
    /** A publisher's label (the Dashboard's one Names). */
    shown?: (name: string) => string;
    /** Open a file in the app (Files, with Back to the Dashboard). */
    onOpenFile?: (path: string) => void;
    /** Whether the page holds a field the person edited, as last read on the
     * page clock: for the header and for re-running a reactive gate, never for
     * a decision. */
    onEdited?: (edited: boolean) => void;
    /** The LIVE read every door asks (leaving, picking, a server switch): the
     * document itself at the moment of the decision (leader note 31). */
    onGuard?: (editedNow: (() => boolean) | null) => void;
  } = $props();

  /** The document on screen: its revision, publisher, age, door and folder. */
  let doc = $state<{ rev: number; by: string; at: number; exp: number; dir: string } | null>(null);
  let srcdoc = $state<string | null>(null);
  let links: PreviewLinks | null = null;
  let frameEl = $state<HTMLIFrameElement | null>(null);
  let height = $state(0);
  let edited = $state(false);
  /** The page's controls as they LOADED (F3): "edited" is measured against it. */
  let snap: FieldSnapshot = [];
  let failed = $state('');
  let confirming = $state(false);
  // A load belongs to the generation it started in: a project switch, a new
  // api (another owner, #335) or the section's end bumps it, and an answer of
  // an older one is dropped (AC7).
  let gen = 0;
  let loading = false;
  let failedAt = 0;
  let keepScroll: { el: Element; top: number } | null = null;

  const frameDoc = () => frameEl?.contentDocument ?? null;
  /** THE answers every decision reads, live: a field differs from the page as it
   * loaded / that, or media plays. The cached `edited` is for the header only. */
  const editedNow = () => { const d = frameDoc(); return !!d && editedFields(d, snap) > 0; };
  const busyNow = () => inProgress(frameDoc(), snap);
  const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';
  /** The frame ELEMENT's colour scheme equals its document's: when they differ,
   * the browser paints an opaque canvas behind the page (measured in Chromium
   * in the #111 rig), and the page must sit on the Dashboard's own surface. */
  let scheme = $state(isDark() ? 'dark' : 'light');
  const sheet = () => {
    const style = getComputedStyle(document.documentElement);
    return pageSheet((name) => style.getPropertyValue(name), isDark());
  };
  function scrollParent(el: Element | null): Element | null {
    for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
      const y = getComputedStyle(p).overflowY;
      if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  /** `confirmed`: the person's own Refresh (after the discard confirm when
   * fields were edited); otherwise an adoption, which re-reads the document
   * when its answer arrives and keeps the page if it became busy meanwhile
   * (validator F2): the newer revision then stays offered. */
  async function load(confirmed = false) {
    if (loading) return;
    loading = true;
    const mine = ++gen;
    const s = session;
    try {
      const r = await api.pageLoad(s);
      if (mine !== gen) return;
      failed = '';
      if (doc && !confirmed && busyNow()) return;
      if (!r) { doc = null; srcdoc = null; return; }
      const scroller = frameEl ? scrollParent(frameEl) : null;
      keepScroll = scroller ? { el: scroller, top: scroller.scrollTop } : null;
      doc = { rev: r.rev, by: r.by, at: r.at, exp: capExpiry(r.scope.url, r.scope.prefix), dir: r.dir };
      const prepared = preparePreview(r.html, r.scope, undefined, sheet());
      links = prepared.links;
      srcdoc = prepared.html;
    } catch (e) {
      if (mine !== gen) return;
      failed = String((e as Error)?.message ?? e);
      failedAt = Date.now();
    } finally {
      if (mine === gen) loading = false;
    }
  }

  // THE adoption rule (project-page.ts decide): on every read answer, every
  // tick of the page clock and every return to visible. A failure waits 20 s
  // before the rule asks again.
  $effect(() => {
    const h = head, v = visible, n = now;
    if (!v) return;
    untrack(() => {
      // The edited-field state is READ from the document on this clock: WebKit
      // runs no listener in a script-less frame, whoever registered it (#111 W1).
      edited = editedNow();
      if (failed && n - failedAt < 20000) return;
      const busy = busyNow();
      if (decide(doc, h, busy, n) === 'load') void load();
    });
  });
  // A new project or a new owner: the old document is dropped at once.
  $effect(() => {
    void session; void api;
    // Everything the old frame had pending goes with it (S1): its link
    // watcher, a link seen and waiting for its own back, the own-back mark.
    return () => { gen++; loading = false; unwire(); unwire = () => {}; doc = null; srcdoc = null; height = 0; edited = false; snap = []; failed = ''; };
  });
  $effect(() => { onEdited(edited); });
  $effect(() => { onGuard(editedNow); return () => onGuard(null); });
  $effect(() => () => onEdited(false));

  // The kept document's live wiring, installed at each load of the frame.
  let unwire = () => {};
  function wire() {
    unwire();
    const d = frameDoc();
    if (!d || !frameEl) return;
    // The link's owner and folder are captured HERE, with this frame's
    // generation: a link of this frame is never routed to a later owner (S1).
    const dir = doc?.dir ?? '';
    const mine = gen;
    const open = onOpenFile;
    // The pipeline's ONE link mechanism: the frame's hash, read by the parent.
    const removeLinks = links
      ? watchPreviewLinks(frameEl, links, (href, doc) => { if (mine === gen) routePreviewHref(doc, href, (ref) => open(resolvePathRef(dir, ref))); }, { active: () => visible })
      : () => {};
    // A document being replaced reads 0: the last height stays until the new
    // one is measured, so the Dashboard's scroll is never clamped meanwhile.
    const measure = () => { if (!visible || !d.documentElement) return; const h = contentHeight(d); if (h > 0) height = h; };
    // Chromium also delivers these to the parent's listeners; ResizeObserver
    // is what re-measures in every engine.
    for (const ev of ['load', 'loadedmetadata', 'toggle']) d.addEventListener(ev, measure, true);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(d.documentElement);
    ro?.observe(frameEl);
    measure();
    snap = fieldSnapshot(d);
    edited = false;
    // After the new height is in the DOM, never before it (WebKit clamped the
    // scroll to 0 here, measured in the #111 rig).
    const keep = keepScroll;
    keepScroll = null;
    if (keep) void tick().then(() => { keep.el.scrollTop = keep.top; });
    unwire = () => {
      removeLinks();
      for (const ev of ['load', 'loadedmetadata', 'toggle']) d.removeEventListener(ev, measure, true);
      ro?.disconnect();
    };
  }
  $effect(() => () => unwire());
  // Shown again: measure what changed while hidden (a width, a late image).
  $effect(() => { if (visible) untrack(() => { const d = frameDoc(); const h = d?.documentElement ? contentHeight(d) : 0; if (h > 0) height = h; }); });

  // A live theme switch rewrites the tokens INSIDE the kept document (AC4):
  // the srcdoc never changes, so the document is not replaced.
  $effect(() => {
    const mo = new MutationObserver(() => {
      scheme = isDark() ? 'dark' : 'light';
      const el = frameDoc()?.head?.querySelector('style[data-tmm-base]');
      if (el) el.textContent = sheet();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => mo.disconnect();
  });

  const standing = $derived(doc && head ? staleness(doc, head, now) : 'current');
  function refresh() {
    if (editedNow()) confirming = true;
    else void load(true);
  }
</script>

{#if doc && srcdoc != null}
  <section class="page-sec" aria-label={t('dashPage')}>
    <h2 class="menu-heading">{t('dashPage')} · {t('dashPageBy').replace('{name}', shown(doc.by))} · {agoShort(doc.at, now)}</h2>
    {#if standing !== 'current'}
      <div class="page-line" role="status">
        <span class="page-meta">{standing === 'newer' && head ? t('dashPageNewer').replace('{name}', shown(head.by)) : t('dashPageOutdated')}</span>
        <button type="button" class="page-refresh" onclick={refresh}>{t('dashPageRefresh')}</button>
      </div>
    {/if}
    {#if failed}<div class="page-meta" role="status">{t('dashPageFailed')}: {failed}</div>{/if}
    <iframe
      class="page-frame"
      bind:this={frameEl}
      {srcdoc}
      sandbox="allow-same-origin"
      title={t('dashPage')}
      style:height={height ? `${height}px` : undefined}
      style:color-scheme={scheme}
      onload={wire}
    ></iframe>
  </section>
{/if}
<ConfirmDialog open={confirming} danger={false} {compact}
  title={t('confirmDiscardTitle')} note={t('dashPageDiscardNote')}
  confirmLabel={t('confirmDiscard')} cancelLabel={t('configKeepEditing')}
  onconfirm={() => { confirming = false; void load(true); }}
  oncancel={() => { confirming = false; }} />

<style>
  .page-sec { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .page-sec > h2 { margin: 0; padding-left: 0; }
  /* The Dashboard's own meta line and text button (.dash-meta, .dash-more), the same declarations. */
  .page-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .page-meta { font: 400 var(--fs-meta)/1.4 var(--font-ui); color: var(--text2); min-width: 0; }
  .page-refresh {
    display: flex; align-items: center; min-height: var(--control-height); padding: 0 4px;
    border: none; background: none; color: var(--accent-ink); cursor: pointer;
    font: 400 var(--fs-meta)/1.4 var(--font-ui); border-radius: var(--control-radius);
  }
  .page-refresh:hover { background: var(--surface2); }
  /* As tall as its content (measured), no scrollbar of its own: the Dashboard scrolls as one page. */
  .page-frame { display: block; width: 100%; border: none; background: transparent; }
</style>
