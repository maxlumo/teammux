<script lang="ts">
  // The Hub's search box (board #432): an OVERLAY on the header row, and the
  // results in the notification centre's popover dialect (menu-surface/
  // menu-list/pop-layer placed by menuPlacement) — no new popover species.
  //
  // · The bar covers the row's content (title, path, tools) without moving or
  //   resizing it, and enters with the existing `.appear` fade. Nothing here
  //   animates a width (motion.md §3: transform and opacity only), so neither
  //   the title nor the feed is pushed while it opens.
  // · It is a field of its own: it never reads or writes the composer's draft,
  //   and closing returns focus to whatever held it before, caret intact.
  // · COLLAPSE is decided by the whole interaction region (the bar AND the
  //   results), not by the input's blur: an empty query collapses only when
  //   focus leaves both, or on Escape; a typed query never collapses on blur.
  //   Both surfaces are focusable containers, so a click on a non-focusable
  //   spot inside them still lands focus inside the region.
  // · The lifecycle (what is current, what a late answer does) is
  //   `hub-search.svelte.ts`; this file only draws it and forwards a tap.
  import { untrack } from 'svelte';
  import Icon from '../ui/Icon.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { agentHue, listWhen } from './hub.ts';
  import { anchorOf, menuPlacement, popOrigin, viewBox, POPOVER_EDGE, POPOVER_GAP } from '../ui/placement.ts';
  import { excerptOf, highlight, lineSuffix, pathParts, SEARCH_MAX_TERMS, searchTerms, type FileHit, type SearchHit } from './hub-search.ts';
  import type { HubSearch } from './hub-search.svelte.ts';

  let { search, projectName = (room: string) => room, agentName = (name: string) => name, onjump = (_hit: Pick<SearchHit, 'room' | 'id' | 'seq'>) => {}, onopenfile = (_file: FileHit) => {}, onclearagent = () => {} }: {
    search: HubSearch;
    /** The project a room belongs to, for a hit found in ALL rooms. */
    projectName?: (room: string) => string;
    /** How a filter's agent is named to the reader ('you' for the human). */
    agentName?: (name: string) => string;
    /** A message result, or a file row's "show the message" button. */
    onjump?: (hit: Pick<SearchHit, 'room' | 'id' | 'seq'>) => void;
    /** A file row: open the file (the Hub resolves it against the row's OWN project). */
    onopenfile?: (file: FileHit) => void;
    /** The token's x, or Backspace in an empty field: the reading filter is
     * the Hub's, so removing it is the Hub's act (the same toggle the card's
     * menu and its double-click use). */
    onclearagent?: () => void;
  } = $props();

  let barEl = $state<HTMLElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);
  let panelW = $state(0);
  let panelH = $state(0);
  /** The results popover. An outside press hides it; typing or focusing the
   * field brings it back. The bar (and the query) stay. */
  let panelOpen = $state(true);
  let viewTick = $state(0);

  const when = (ms: number) => listWhen(Math.floor(ms / 1000));
  const terms = $derived(searchTerms(search.label?.query ?? ''));
  const showPanel = $derived(search.open && panelOpen);

  const inRegion = (node: EventTarget | null): boolean =>
    node instanceof Node && !!(barEl?.contains(node) || panelEl?.contains(node));

  // Focus: take it on open, give it back on close. Read once at the moment the
  // box opens — what held focus then (the search button, or the composer) is
  // what gets it back.
  $effect(() => {
    if (!search.open) return;
    const before = untrack(() => document.activeElement as HTMLElement | null);
    untrack(() => { panelOpen = true; inputEl?.focus({ preventScroll: true }); });
    return () => {
      const active = document.activeElement;
      if (before?.isConnected && (active === document.body || active === null || inRegion(active))) before.focus({ preventScroll: true });
    };
  });

  // Pointer: a press inside the region is inside for the focus rule below until
  // it ends; a press outside both hides the popover (not the bar).
  let pressInside = false;
  $effect(() => {
    if (!search.open) return;
    const down = (e: PointerEvent) => {
      pressInside = inRegion(e.target);
      if (!pressInside) panelOpen = false;
    };
    const up = () => { pressInside = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      pressInside = false;
    };
  });

  // The region lost focus. Whether that is LEAVING it is decided once the move
  // has settled, by where focus actually is: a Tab or a click between the bar and
  // the results ends inside, a press that is still down is inside, and a window
  // that merely blurred keeps its focused element, so it is no move at all.
  function focusout() {
    setTimeout(() => {
      if (!search.open || pressInside || inRegion(document.activeElement)) return;
      if (!search.query.trim()) search.close();
    }, 0);
  }

  function keydown(e: KeyboardEvent) {
    // An IME's Escape cancels its composition; it is not ours.
    if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      search.close();
    } else if (e.key === 'Backspace' && !e.isComposing && e.target === inputEl && search.agent && !inputEl?.value) {
      e.preventDefault();
      onclearagent();
    } else if (e.key === 'Enter' && !e.isComposing && e.target === inputEl) {
      e.preventDefault();
      search.submit();
    } else if (e.key === 'ArrowDown' && e.target === inputEl) {
      const first = panelEl?.querySelector<HTMLElement>('.sr-row');
      if (first) { e.preventDefault(); first.focus(); }
    }
  }

  // ONE resolved placement: position, room and grow origin from the same
  // anchor, so the intro never starts at a corner the popover is not against.
  const place = $derived.by(() => {
    void viewTick;
    if (!showPanel || !inputEl?.isConnected) return null;
    const anchor = anchorOf(barEl ?? inputEl);
    const pos = menuPlacement(anchor, { w: panelW, h: panelH }, viewBox(), POPOVER_GAP, POPOVER_EDGE, 'left');
    return { pos, origin: popOrigin(anchor, pos, 'left') };
  });
  $effect(() => {
    if (!search.open) return;
    const bump = () => { viewTick += 1; };
    window.addEventListener('resize', bump);
    return () => window.removeEventListener('resize', bump);
  });

  const scopeName = (s: 'room' | 'all') => (s === 'all' ? t('hubSearchScopeAll') : t('hubSearchScopeRoom'));
  const fromName = (agent: string) => t('hubSearchFrom').replace('{name}', agentName(agent));
  const forLabel = $derived.by(() => {
    const l = search.stale;
    if (!l) return '';
    const key = l.mode === 'files' ? (l.query ? 'hubSearchFilesFor' : 'hubSearchFilesForAll') : 'hubSearchFor';
    return t(key).replace('{query}', l.query).replace('{scope}', scopeName(l.scope)) + (l.agent ? ` · ${fromName(l.agent)}` : '');
  });
  const hint = $derived(search.mode === 'files'
    ? (search.agent ? t('hubSearchHintFilesFrom').replace('{name}', agentName(search.agent)) : t('hubSearchHintFiles'))
    : (search.agent ? t('hubSearchHintFrom').replace('{name}', agentName(search.agent)) : t('hubSearchHint')));
  const modes = $derived([{ value: 'messages' as const, label: t('hubSearchModeMessages') }, { value: 'files' as const, label: t('hubSearchModeFiles') }]);
</script>

<!-- Keys are read for the whole region at the window, in the capture phase (an Escape that closes this box must not also reach a dialog behind it), not per element: the bar is a landmark, not a control. -->
<svelte:window onkeydowncapture={(e) => { if (search.open && inRegion(e.target)) keydown(e); }} />

{#if search.open}
  <div class="search-bar appear" bind:this={barEl} role="search" tabindex="-1" onfocusout={focusout}>
    <span class="search-glyph" aria-hidden="true"><Icon name="search" size={16} /></span>
    {#if search.agent}
      <!-- The reading filter, as the box's own scope (board #432): who the search is
           from. Its x is the filter's off switch, so the feed unfilters with it. -->
      <span class="search-token" style:--who-ink={agentHue(search.agent)}>
        <span class="token-name">{agentName(search.agent)}</span>
        <CommandButton variant="icon" icon="x" label={t('hubSearchTokenRemove').replace('{name}', agentName(search.agent))} onclick={() => { inputEl?.focus({ preventScroll: true }); onclearagent(); }} />
      </span>
    {/if}
    <input class="config-input search-input" bind:this={inputEl} type="search" autocomplete="off" autocapitalize="off" spellcheck="false"
      enterkeyhint="search" aria-label={t('hubSearch')} placeholder={t('hubSearch')}
      value={search.query}
      oninput={(e) => { panelOpen = true; search.setQuery(e.currentTarget.value); }}
      onfocus={() => { panelOpen = true; }} />
    <CommandButton variant="icon" icon="x" label={t('hubSearchClose')} onclick={() => search.close()} />
  </div>
{/if}

{#if showPanel}
  <div class="search-panel menu-surface menu-list pop-layer" class:ready={panelH > 0}
    role="dialog" aria-modal="false" aria-label={t('hubSearch')} tabindex="-1"
    style:left="{place?.pos.x ?? 0}px" style:top="{place?.pos.y ?? 0}px"
    style:--pop-maxw="{place?.pos.maxW ?? 0}px" style:--pop-maxh="{place?.pos.maxH ?? 0}px"
    style:--pop-origin={place?.origin}
    bind:this={panelEl} bind:offsetWidth={panelW} bind:offsetHeight={panelH}
    onfocusout={focusout}>
    <div class="menu-heading sr-head">
      <span class="sr-status" role="status">
        {#if search.status === 'pending'}{t('hubSearchPending')}
        {:else if search.status === 'error'}{search.error === 'too-many' ? t('hubSearchTooMany').replace('{n}', String(SEARCH_MAX_TERMS)) : search.error === 'files-unsupported' ? t('hubSearchFilesUnsupported') : t('hubSearchFailed')}
        {:else if search.status === 'empty'}{search.label?.mode === 'files' ? t('hubSearchFilesEmpty') : t('hubSearchEmpty')}
        {:else if search.status === 'idle'}{hint}{/if}
      </span>
      <span class="sr-tools compact-tools">
        <Segmented options={modes} value={search.mode} onchange={(m) => search.setMode(m)} ariaLabel={t('hubSearchModes')} />
        {#if search.status === 'error' && search.error !== 'too-many' && search.error !== 'files-unsupported'}<CommandButton variant="secondary" label={t('hubSearchRetry')} onclick={() => search.retry()} />{/if}
        <CommandButton variant="secondary" label={t('hubSearchAllRooms')} pressed={search.scope === 'all'}
          onclick={() => search.setScope(search.scope === 'all' ? 'room' : 'all')} />
      </span>
    </div>
    {#if search.notice}<div class="config-error sr-notice" role="alert">{search.notice}</div>{/if}
    {#if forLabel}<div class="sr-label" role="note">{forLabel}</div>{/if}
    {#if search.mode === 'files' && search.files.length}
      <ul class="sr-list">
        {#each search.files as file (`${file.room}|${file.path}`)}
          {@const parts = pathParts(file.path, terms)}
          <li class="sr-file">
            <button type="button" class="menu-item sr-row" aria-label={t('hubSearchFileOpen').replace('{path}', file.path)} onclick={() => onopenfile(file)}>
              <span class="sr-top">
                <span class="sr-name">{#each parts.name as seg}{#if seg.mark}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}{lineSuffix(file)}</span>
                {#if file.count > 1}<span class="sr-count">×{file.count}</span>{/if}
                <span class="sr-time">{when(file.ts)}</span>
              </span>
              {#if parts.dir.length}<span class="sr-dir">{#each parts.dir as seg}{#if seg.mark}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span>{/if}
              <span class="sr-top">
                <span class="sr-who" style:--who-ink={agentHue(file.from)}>{agentName(file.from)}</span>
                {#if search.label?.scope === 'all'}<span class="sr-project">{projectName(file.room)}</span>{/if}
              </span>
            </button>
            <CommandButton variant="icon" icon="chat" label={t('hubSearchFileJump').replace('{path}', file.path)} onclick={() => onjump(file)} />
          </li>
        {/each}
      </ul>
    {/if}
    {#if search.mode === 'files' && search.label?.mode === 'files' && (search.files.length || search.next !== null)}
      <div class="sr-more" role="note">{t('hubSearchFilesNote').replace('{n}', String(search.scanned))}</div>
      {#if search.canOlder || search.loadingOlder || search.olderFailed}
        <div class="sr-older">
          {#if search.olderFailed}<span class="config-error sr-older-failed" role="alert">{t('hubSearchFilesOlderFailed')}</span>{/if}
          <CommandButton variant="secondary" label={search.loadingOlder ? t('hubSearchFilesOlderPending') : t('hubSearchFilesOlder')} disabled={search.loadingOlder} onclick={() => search.loadOlder()} />
        </div>
      {/if}
    {/if}
    {#if search.mode === 'messages' && search.rows.length}
      <ul class="sr-list">
        {#each search.rows as hit (`${hit.room}|${hit.id}`)}
          <li>
            <button type="button" class="menu-item sr-row" onclick={() => onjump(hit)}>
              <span class="sr-top">
                <span class="sr-who" style:--who-ink={agentHue(hit.from)}>{#each highlight(hit.from, terms) as seg}{#if seg.mark}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span>
                {#if search.label?.scope === 'all'}<span class="sr-project">{projectName(hit.room)}</span>{/if}
                <span class="sr-time">{when(hit.ts)}</span>
              </span>
              <span class="sr-text">{#each excerptOf(hit.body, terms) as seg}{#if seg.mark}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if search.more}<div class="sr-more" role="note">{t('hubSearchMore').replace('{n}', String(search.rows.length))}</div>{/if}
    {/if}
  </div>
{/if}

<style>
  /* The bar covers the head row's content box. It does not take a slot in the
     row, so the title, path and tools underneath are not moved or resized by
     it opening (the .chat-head is the positioning context, see Hub.svelte). */
  .search-bar {
    position: absolute; inset: 0; z-index: 3;
    display: flex; align-items: center; gap: var(--ui-gap);
    padding: inherit; box-sizing: border-box; background: var(--bg);
  }
  .search-glyph { display: inline-flex; flex: none; color: var(--text3); }
  .search-input { flex: 1 1 auto; min-width: 0; }
  /* The token keeps its whole name (the field gives way first); only a name longer than half the bar ellipsizes. */
  .search-token { display: inline-flex; align-items: center; flex: 0 0 auto; max-width: 50%; min-width: 0; padding-left: var(--menu-item-padding-x); border-radius: var(--ui-radius-control); background: var(--accent-bg); color: var(--who-ink); font-size: var(--fs-meta); font-weight: 600; }
  .token-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The bar has its own Close; the engine's clear-x would be a second one. */
  .search-input::-webkit-search-cancel-button { appearance: none; display: none; }
  /* The popover is NotifyCentre's: same chrome, same room cap. The 520px is its width cap (the
     centre's is 360px), a popover geometry like it, not a spacing: the bar's padding is the header's own. */
  .search-panel {
    position: fixed; z-index: 24; width: min(520px, calc(100vw / var(--ui-zoom, 1) - 16px));
    max-width: var(--pop-maxw, none);
    max-height: min(520px, calc(100vh / var(--ui-zoom, 1) - 16px), var(--pop-maxh, 100vh)); overflow-y: auto;
  }
  .sr-head { display: flex; align-items: center; justify-content: space-between; gap: var(--menu-item-gap); }
  .sr-status { min-width: 0; color: var(--text2); font-size: var(--fs-meta); }
  .sr-tools { display: flex; align-items: center; gap: var(--ui-gap); flex: none; }
  .sr-notice { margin: 0 var(--menu-item-padding-x) var(--menu-item-padding-y); }
  .sr-label, .sr-more { padding: 0 var(--menu-item-padding-x); color: var(--text3); font-size: var(--fs-micro); }
  .sr-more { padding-top: var(--menu-item-padding-y); }
  .sr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--menu-gap); }
  .sr-file { display: flex; align-items: center; gap: var(--menu-item-gap); }
  .sr-file .sr-row { flex: 1 1 auto; min-width: 0; width: auto; }
  .sr-name { flex: 0 1 auto; min-width: 0; color: var(--text); font-size: var(--fs-body); font-weight: 600; overflow-wrap: anywhere; }
  .sr-count { flex: none; color: var(--text3); font-size: var(--fs-meta); font-variant-numeric: tabular-nums; }
  .sr-dir { color: var(--text3); font-size: var(--fs-micro); overflow-wrap: anywhere; }
  .sr-older { display: flex; align-items: center; justify-content: space-between; gap: var(--menu-item-gap); padding: var(--menu-item-padding-y) var(--menu-item-padding-x) 0; }
  .sr-older-failed { min-width: 0; }
  .sr-row { display: flex; flex-direction: column; align-items: stretch; gap: var(--menu-gap); width: 100%; text-align: left; }
  .sr-top { display: flex; align-items: center; gap: var(--menu-item-gap); min-width: 0; }
  .sr-who { flex: 0 1 auto; min-width: 0; color: var(--who-ink); font-size: var(--fs-meta); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-project { flex: 1 1 auto; min-width: 0; color: var(--accent-ink); font-size: var(--fs-micro); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-time { flex: none; margin-left: auto; font-size: var(--fs-meta); color: var(--text3); font-variant-numeric: tabular-nums; }
  .sr-text { color: var(--text2); font-size: var(--fs-meta); white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  mark { background: var(--accent-bg); color: var(--text); }
</style>
