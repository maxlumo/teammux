<script lang="ts">
  // Shared pane picker popover: lists every tmux pane grouped by session and
  // calls onPick(pane) when one is chosen. Used by SplitView (assign a cell)
  // and by Terminal's single-pane window switcher (jump to any pane without
  // returning to the Sessions page). The caller owns open/close; the panel is
  // the app's ONE popover mechanism — a fixed layer placed by `menuPlacement`
  // from the opener's rect, invisible until measured, dismissed by an outside
  // pointerdown / Escape / any ancestor scroll / a resize. It used to be a
  // `position:absolute` panel at a hard-coded offset inside the caller's
  // wrapper, closed only by a backdrop button (review, 2026-09-03): a cell
  // near the viewport edge clipped it, and Escape did nothing.
  import AgentChip from '../ui/AgentChip.svelte';
  import Icon from '../ui/Icon.svelte';
  import { activeModal } from '../ui/modal.ts';
  import { anchorOf, menuPlacement, popOrigin, viewBox, scrollMovesTrigger, type AnchorRect } from '../ui/placement.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { useServerApi } from '../app/server-context.ts';
  import type { TmuxPane } from '../core/ws.ts';
  import { paneAgent, paneChipLabel } from '../core/agents.ts';
  type SessionGroup = { name: string; panes: TmuxPane[] };

  let {
    currentTarget = '',   // highlight the pane matching this target
    onPick = () => {},
    onClose = () => {},
    align = 'left',       // which edge of the anchor the panel hangs from
    /** The element whose click opened the picker: the placement anchor by
     * default, and never "outside" (so its own click can toggle the picker
     * closed). Callers that render the picker right after their trigger may
     * leave it unset — the previous element sibling is then the trigger. */
    trigger = null,
    /** An explicit placement rect when the trigger's own box is not where the
     * panel should hang (SplitView's opener fills the whole cell). */
    anchor = null,
  }: {
    currentTarget?: string;
    onPick?: (pane: TmuxPane) => void;
    onClose?: () => void;
    align?: 'left' | 'right';
    trigger?: Element | null;
    anchor?: AnchorRect | null;
  } = $props();
  // This server's RPCs, read once at init (board #335 ②b): the subtree's
  // provider decides which server that is, never a module-level default.
  const api = useServerApi();

  let el = $state<HTMLDivElement | null>(null);
  let w = $state(0);
  let h = $state(0);
  let anchorRect = $state<AnchorRect | null>(null);
  let opener: Element | null = null;
  $effect(() => {
    if (!el) return;
    opener = trigger ?? el.previousElementSibling ?? el.parentElement;
    anchorRect = anchor ?? (opener ? anchorOf(opener) : null);
  });
  // Measured before it is placed, like Select and ContextMenu: an unmeasured
  // panel would be positioned from a zero height and jump.
  const pos = $derived(anchorRect ? menuPlacement(anchorRect, { w, h }, viewBox(), 6, 8, align) : { x: 0, y: 0 });

  // Dismissal, all four ways. "Any ancestor scroll" is literal here: only a
  // scroller that CONTAINS the opener moves the subject away. A scroll inside
  // the panel is the list scrolling, and a terminal viewport scrolling under
  // the panel is output arriving — an agent printing a line must not close the
  // picker mid-choice (this popover hangs over live terminals).
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node | null;
      if (tgt && (el?.contains(tgt) || opener?.contains(tgt))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const modal = activeModal(document);
      if (modal && !modal.contains(el)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    const onScroll = (e: Event) => {
      const scroller = e.target === document ? document.documentElement : e.target;
      if (!scrollMovesTrigger(scroller, opener)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  let loading = $state(true);
  let sessions = $state<SessionGroup[]>([]);
  let busySession = $state(''); // session whose "+" is mid-create (disable it)

  let currentMatch = $derived(/^(.+):(\d+)\./u.exec(currentTarget));
  let currentSession = $derived(currentMatch?.[1] || '');

  async function load(): Promise<SessionGroup[]> {
    const { sessions: list, panes } = await api.listSessionsWithPanes();
    const bySession = new Map<string, TmuxPane[]>();
    for (const p of panes) {
      const arr = bySession.get(p.session);
      if (arr) arr.push(p); else bySession.set(p.session, [p]);
    }
    return list
      .map(s => ({ name: s.name, panes: bySession.get(s.name) || [] }))
      .filter(s => s.panes.length);
  }

  // Fetch on mount (the caller only renders this when open).
  $effect(() => {
    let cancelled = false;
    load()
      .then(next => { if (!cancelled) { sessions = next; loading = false; } })
      .catch(() => { if (!cancelled) { sessions = []; loading = false; } });
    return () => { cancelled = true; };
  });

  // Create a new window in `sessionName`, then pick its newest pane — mirrors
  // Terminal's in-bar "+" so opening a fresh window and jumping to it is one
  // tap. We reload to find the just-created window (new-window returns no id).
  async function addWindow(sessionName: string) {
    if (busySession) return;
    busySession = sessionName;
    try {
      await api.newWindow(sessionName);
      const next = await load();
      sessions = next;
      const s = next.find(x => x.name === sessionName);
      const fresh = s?.panes?.length
        ? s.panes.reduce((a, b) => (b.window > a.window ? b : a))
        : null;
      if (fresh) onPick(fresh);
    } catch {} finally {
      busySession = '';
    }
  }
</script>

<div class="picker menu-surface pop-layer" class:ready={h > 0} role="dialog" aria-label={t('pickPane')} tabindex="-1"
  style:--pop-origin={anchorRect ? popOrigin(anchorRect, pos, align) : undefined}
  style:left="{pos.x}px" style:top="{pos.y}px"
  bind:this={el} bind:offsetWidth={w} bind:offsetHeight={h}>
  {#if loading}
    <div class="picker-empty">…</div>
  {:else if sessions.length === 0}
    <div class="picker-empty">{t('noSessions')}</div>
  {:else}
    {#each sessions as s}
      {@render sessionBlock(s)}
    {/each}
  {/if}
</div>

{#snippet sessionBlock(s: SessionGroup)}
  <div class="picker-session">
    <span class="picker-session-name">{s.name}</span>
  </div>
  <div class="picker-panes">
    {#each s.panes as p}
      {@const isCur = currentTarget === `${p.session}:${p.window}.${p.pane}`}
      {@const pAgent = paneAgent(p)}
      <AgentChip
        agent={pAgent}
        label={paneChipLabel(p, `${p.window}.${p.pane}`)}
        variant={isCur ? 'active' : 'default'}
        title={`${p.session}:${p.window}.${p.pane} · ${p.current_command || p.window_name || ''}`}
        onclick={(e) => { e.stopPropagation(); onPick(p); }}
      />
    {/each}
    <button
      class="picker-add"
      title={t('newWindow')}
      aria-label={t('newWindow')}
      disabled={busySession === s.name}
      onclick={(e) => { e.stopPropagation(); addWindow(s.name); }}
    >
      <Icon name="plus" size={12} />
    </button>
  </div>
{/snippet}

<style>
  /* Same popover dialect as Select / ContextMenu: fixed layer, --bg surface,
     1px --border, panel radius, shadow; invisible until measured. */
  .picker {
    position: fixed;
    z-index: 40;
    width: max-content;
    min-width: min(200px, calc(100vw / var(--ui-zoom, 1) - 16px));
    max-width: min(360px, calc(100vw / var(--ui-zoom, 1) - 16px));
    max-height: calc(60vh / var(--ui-zoom, 1));
    overflow-y: auto;
    padding: 6px;
    /* Visibility and the intro are the shared .pop-layer atom (app.css). */
  }
  .picker-session {
    display: flex; align-items: center; gap: 6px;
    font-size: var(--fs-meta); font-weight: 600; color: var(--text3);
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 6px 6px 2px;
  }
  .picker-session-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-add {
    flex-shrink: 0;
    width: 24px; height: 24px; padding: 0;
    /* 24px square: the command PAINT corner (#337's token test) — 10 on 24
       reads as a circle, which the radius scale names explicitly. */
    border: 1px solid var(--border2); border-radius: var(--control-paint-radius);
    background: var(--input-bg); color: var(--text3);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
  }
  .picker-add:active { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
  .picker-add:disabled { opacity: 0.4; cursor: default; }
  .picker-panes { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 4px 6px; }
  .picker-empty { padding: 16px; text-align: center; color: var(--text3); font-size: var(--fs-body); }
</style>
