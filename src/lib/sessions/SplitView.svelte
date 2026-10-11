<script lang="ts">
  // Desktop split-screen: tiles N independent Terminal instances in a CSS
  // grid, each bound to any session:window.pane. Mounted only when
  // App.svelte decides split is active (desktop + wide). Each cell owns its
  // own Terminal (own subscription, own xterm, own resize) — the ws.ts
  // per-target listener registry is what lets them coexist.
  import Terminal from '../terminal/Terminal.svelte';
  import PanePicker from './PanePicker.svelte';
  import { anchorOf, type AnchorRect } from '../ui/placement.ts';
  import Icon from '../ui/Icon.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import type { TmuxPane } from '../core/ws.ts';

  export interface SplitCell { id: number; target: string; session: string }

  let {
    cells,            // one entry per grid cell
    layout,           // 2 | 3 | 4 | 6
    activeCellId,
    fontSize = 14,
    onActivate = () => {},
    onAssign = () => {},
    onCloseCell = () => {},
    onPaneExit = () => {},
    visible = true,
    // Is this split's TREE the focused one (board #335 ③a-4)? A cell takes
    // window input only when its tree is focused AND it is the active cell.
    focused = true,
  }: {
    cells: SplitCell[];
    layout: number;
    activeCellId: number;
    fontSize?: number;
    onActivate?: (cellId: number) => void;
    onAssign?: (cellId: number, target: string, session: string) => void;
    onCloseCell?: (cellId: number) => void;
    onPaneExit?: (cellId: number) => void;
    visible?: boolean;
    focused?: boolean;
  } = $props();

  // Which cell's pane picker is open (null = none). PanePicker (shared with
  // Terminal's single-pane switcher) fetches + renders the list.
  let pickerCellId = $state<number | null>(null);
  // The opener fills the whole cell, so the picker hangs from a 30px strip at
  // the cell's top (6px in from each side) — the spot it always occupied —
  // and the shared placement flips/clamps it from there.
  let pickerTrigger = $state<Element | null>(null);
  let pickerAnchor = $state<AnchorRect | null>(null);
  function openPicker(cellId: number, opener: Element) {
    const r = anchorOf(opener);
    pickerTrigger = opener;
    pickerAnchor = { left: r.left + 6, right: r.right - 6, top: r.top, bottom: r.top + 30 };
    pickerCellId = cellId;
  }
  function closePicker() { pickerCellId = null; }
  function pickPane(cellId: number, p: TmuxPane) {
    onAssign(cellId, `${p.session}:${p.window}.${p.pane}`, p.session);
    closePicker();
  }
</script>

<div class="split-grid layout-{layout}">
  {#each cells as cell (cell.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="cell"
      data-cell-id={cell.id}
      class:active={cell.id === activeCellId}
      onmousedowncapture={() => onActivate(cell.id)}
    >
      <div class="cell-body">
        {#if cell.target}
          <!-- The Terminal's own window-switcher bar IS the cell header
               (same form as the single-pane view). Its session badge opens
               the cross-session pane picker; onClose closes the cell. -->
          {#key cell.target}
            <Terminal
              target={cell.target}
              session={cell.session}
              embedded={true}
              active={focused && cell.id === activeCellId}
              {visible}
              {fontSize}
              onSwitchPane={(t2: string) => onAssign(cell.id, t2, t2.split(':')[0] ?? '')}
              onPaneExit={() => onPaneExit(cell.id)}
              onClose={() => onCloseCell(cell.id)}
            />
          {/key}
        {:else}
          <button class="cell-empty" onclick={(e) => { e.stopPropagation(); openPicker(cell.id, e.currentTarget); }}>
            <Icon name="plus" size={20} />
            <span>{t('pickPane')}</span>
          </button>
        {/if}
      </div>

      {#if pickerCellId === cell.id}
        <PanePicker
          currentTarget={cell.target}
          trigger={pickerTrigger}
          anchor={pickerAnchor}
          onPick={(p: TmuxPane) => pickPane(cell.id, p)}
          onClose={closePicker}
        />
      {/if}
    </div>
  {/each}
</div>

<style>
  .split-grid {
    display: grid;
    gap: 4px;
    height: 100%;
    width: 100%;
    padding: 4px;
    box-sizing: border-box;
    background: var(--bg);
  }
  .layout-2 { grid-template-columns: 1fr 1fr; }
  .layout-3 { grid-template-columns: 1fr 1fr 1fr; }
  .layout-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .layout-6 { grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }

  .cell {
    display: flex;
    flex-direction: column;
    /* min-* are essential: grid children otherwise refuse to shrink and
       xterm's ResizeObserver never sees the real (smaller) box. */
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-row);
    overflow: hidden;
    position: relative;
    background: var(--bg);
    /* The frame cross-fades its colour and ring (motion.md principle 9 allows
       this: colour is neither a containing block nor a size). No transform,
       no opacity, no flip on a cell — it is an xterm ancestor. */
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .cell.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 0 12px var(--accent-glow);
  }

  .cell-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
  }

  .cell-empty {
    width: 100%; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px;
    border: none; background: transparent;
    color: var(--text3); font-size: var(--fs-body);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .cell-empty:hover { color: var(--accent); }
</style>
