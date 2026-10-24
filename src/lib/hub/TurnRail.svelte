<script lang="ts">
  // The Hub feed's turn rail (board #461, reworked by #463): one tick per human
  // message, floating over the feed's RIGHT edge (it takes no space from the
  // bubbles). Hover (or press and drag, or the arrow keys) PREVIEWS a turn in the
  // one popover mechanism, to the rail's left, and the PROBED tick is the one
  // emphasised, moving with the pointer like a picker wheel; a click, a release
  // or Enter jumps there through the feed's ONE jump. The protocol lives in hub-turn-rail.ts (a
  // DOM-free controller, every rule a test), the arithmetic in hub-turns.ts; this
  // file is only the markup, the pointer wiring and the placement.
  //
  // What it is NOT: it computes no "current turn" of its own (idle, the emphasised
  // tick is the anchor's askKey, read-only; while a probe is open it is the
  // probe's), it writes no reading state, and it owns no scroll. See docs/design-docs/features/hub-feed.md § The turn rail.
  import { untrack } from 'svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { anchorOf, intersectRects, menuPlacementIn, popOrigin, POPOVER_EDGE, POPOVER_GAP, viewBox } from '../ui/placement.ts';
  import { agoShort } from './hub.ts';
  import { createTurnRail } from './hub-turn-rail.ts';
  import type { Landing, Rect } from './hub-turn-rail.ts';
  import { tickCapacity, tickCount, tickOf, turnLabel } from './hub-turns.ts';
  import type { AskTurn } from './hub-turns.ts';


  let { turns, current = '', live = false, more = false, bounds = null, scroller = null, jump }: {
    turns: readonly AskTurn[];
    /** The anchor's selected message key, or '' — read-only. */
    current?: string;
    /** The host gate: shown, the room settled, two turns or more. */
    live?: boolean;
    /** Older history can still load: the count reads M+, never a total we do not know. */
    more?: boolean;
    /** The box the popover must stay inside (the feed-wrap: clear of header and composer). */
    bounds?: HTMLElement | null;
    /** The feed's scroller: a classic scrollbar takes width at its right edge, which the rail clears. */
    scroller?: HTMLElement | null;
    jump: (key: string) => Landing;
  } = $props();

  let hostEl: HTMLElement | null = $state(null);
  let band: HTMLElement | null = $state(null);
  let popEl: HTMLElement | null = $state(null);
  let bridgeEl: HTMLElement | null = $state(null);
  let capacity = $state(2);
  /** The scroller's scrollbar width at the right edge (0 for overlay scrollbars): the rail stands to its left. */
  let edge = $state(0);
  let view = $state({ open: false, key: '', kind: null as null | 'hover' | 'press' | 'key' });
  let pw = $state(0);
  let ph = $state(0);
  let openedAt = 0;

  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };

  const rail = createTurnRail({
    turns: () => turns,
    current: () => current,
    live: () => live,
    band: () => {
      if (!band) return null;
      const r = rectOf(band);
      return r.right - r.left > 0 && r.bottom - r.top > 0 ? r : null;
    },
    // Sliding AWAY from the band is sliding left, toward the feed: the room is what is left of it.
    reach: (r) => Math.max(0, Math.min(2 * (r.right - r.left), r.left)),
    jump: (key) => jump(key),
    capture: (id) => { try { band?.setPointerCapture(id); } catch { /* the pointer is already gone */ } },
    release: (id) => { try { if (band?.hasPointerCapture(id)) band.releasePointerCapture(id); } catch { /* already released */ } },
  }, () => {
    const next = rail.view();
    if (next.open && !view.open) openedAt = Date.now();
    view = next;
  });

  /** The owner of a reading-context change calls this at the change. */
  export function retire() { rail.retire(); }
  /** Close an open preview (the Hub's back stack, Escape); true when one was open. */
  export function close(): boolean { return rail.key('Escape'); }

  // The gate falling is also a retirement, so nothing is resumed when it comes back.
  $effect(() => { if (!live) untrack(() => rail.retire()); });
  $effect(() => () => untrack(() => rail.dispose()));

  // How many ticks the column can draw: its content box over the pitch token.
  $effect(() => {
    if (!hostEl) return;
    const el = hostEl;
    const measure = () => {
      const pitch = parseFloat(getComputedStyle(el).getPropertyValue('--turn-tick-pitch')) || 10;
      const cs = getComputedStyle(el);
      const inner = el.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
      capacity = tickCapacity(inner, pitch);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // The ground the rail and its popover were measured on moving is a retirement
  // too, called at the change: a window or visual-viewport resize (a keyboard, a
  // header), the interface zoom, or a new size of the band, its column or the
  // feed-wrap. A preview closes and a held press is cancelled, so nothing is left
  // at a stale position and a geometry that changes and changes back cannot bring
  // an old press back.
  $effect(() => {
    const targets = [hostEl, band, bounds, scroller].filter((x): x is HTMLElement => !!x);
    const sizes = new Map<Element, string>();
    const moved = () => untrack(() => rail.retire());
    // A scrollbar appearing or going moves the rail sideways: read it afresh and retire.
    const measure = () => {
      const next = scroller ? Math.max(0, scroller.offsetWidth - scroller.clientWidth) : 0;
      if (next !== edge) { edge = next; moved(); }
    };
    measure();
    const ro = new ResizeObserver((entries) => {
      measure();
      for (const e of entries) {
        const size = `${e.contentRect.width}x${e.contentRect.height}`;
        const before = sizes.get(e.target);
        sizes.set(e.target, size);
        if (before !== undefined && before !== size) moved();
      }
    });
    for (const el of targets) ro.observe(el);
    const vv = window.visualViewport;
    const changed = () => { measure(); moved(); };
    window.addEventListener('resize', changed);
    window.addEventListener('app-zoom-change', changed);
    vv?.addEventListener('resize', moved);
    vv?.addEventListener('scroll', moved);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', changed);
      window.removeEventListener('app-zoom-change', changed);
      vv?.removeEventListener('resize', moved);
      vv?.removeEventListener('scroll', moved);
    };
  });

  // A preview closes when something else is pressed, and Escape is the rail's
  // while one is open (a touch scrub has no focus to carry the key).
  $effect(() => {
    if (!view.open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (band?.contains(target) || popEl?.contains(target) || bridgeEl?.contains(target))) return;
      rail.outsidePress();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && rail.key('Escape')) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', esc);
    };
  });

  const count = $derived(turns.length);
  const ticks = $derived(tickCount(count, capacity));
  const index = (key: string) => (key ? turns.findIndex((x) => x.key === key) : -1);
  const curIdx = $derived(index(current));
  const probeIdx = $derived(view.open ? index(view.key) : -1);
  const curTick = $derived(tickOf(curIdx, count, ticks));
  const probeTick = $derived(tickOf(probeIdx, count, ticks));

  const labelOf = (turn: AskTurn) => {
    const l = turnLabel(turn);
    return l.text || (l.image ? t('hubTurnImage') : t('hubTurnEmpty'));
  };
  const ofText = (n: number) =>
    t(more ? 'hubTurnOfMore' : 'hubTurnOf').replace('{n}', String(n)).replace('{m}', String(count));
  const shownIdx = $derived(probeIdx >= 0 ? probeIdx : curIdx);
  /** The one row: the probed turn. */
  const row = $derived(probeIdx >= 0 ? { key: turns[probeIdx]!.key, label: labelOf(turns[probeIdx]!) } : null);
  const foot = $derived.by(() => {
    if (probeIdx < 0) return '';
    const ago = agoShort(turns[probeIdx]!.ts, openedAt || Date.now());
    return `${ofText(probeIdx + 1)}${ago ? ` · ${ago}` : ''}`;
  });
  const valueText = $derived((shownIdx >= 0
    ? `${ofText(shownIdx + 1)}: ${labelOf(turns[shownIdx]!)}`
    : t('hubTurnNone').replace('{m}', String(count))) + (more ? `, ${t('hubTurnMoreAria')}` : ''));

  // One placement, computed against the band and the box it must stay inside. The
  // card is a single row measured from its content (one to three lines, plus the
  // footer), so it is anchored to the PROBED tick (centred on its measured height)
  // and follows the probe without churn.
  const placed = $derived.by(() => {
    if (!view.open || !band) return null;
    const a = anchorOf(band);
    const vb = viewBox();
    const screen = { left: 0, top: 0, right: vb.w, bottom: vb.h };
    const box = bounds ? intersectRects(anchorOf(bounds), screen) : screen;
    const slot = (a.bottom - a.top) / Math.max(1, ticks);
    const mid = a.top + (Math.max(0, probeTick) + 0.5) * slot;
    const tick = { left: a.left, right: a.right, top: mid - ph / 2, bottom: mid + ph / 2 };
    const p = menuPlacementIn(box, tick, { w: pw, h: ph }, POPOVER_GAP, POPOVER_EDGE, 'right', 'left');
    // The corridor: the gap beside the band, over the band's WHOLE height, so the
    // pointer can leave the band at any tick and still be inside the cluster.
    return { p, origin: popOrigin(tick, p, 'right', 'left'), bridge: { left: a.left - POPOVER_GAP, top: a.top, height: a.bottom - a.top } };
  });

  const pin = (e: PointerEvent) => ({ id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, button: e.button });
  /** Focus the way a keyboard gives it; a mouse press focuses the band too but must not open a preview. */
  const keyboardFocus = (el: HTMLElement) => { try { return el.matches(':focus-visible'); } catch { return false; } };
  const inside = (to: EventTarget | null, el: Element | null) => !!el && to instanceof Node && el.contains(to);
  /** The pointer left one part of the cluster (band, corridor, popover): it only ends the hover when it did not go into another part. */
  const leaving = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (inside(e.relatedTarget, band) || inside(e.relatedTarget, bridgeEl) || inside(e.relatedTarget, popEl)) return;
    rail.leave();
  };
</script>

<div class="turn-rail" bind:this={hostEl} style:--turn-rail-edge="{edge}px">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="tr-band" bind:this={band} role="slider" tabindex="0" aria-orientation="vertical"
    aria-label={t('hubTurnRail')} aria-valuemin="1" aria-valuemax={count}
    aria-valuenow={shownIdx >= 0 ? shownIdx + 1 : count} aria-valuetext={valueText}
    style:--n={ticks}
    onpointerenter={(e) => rail.pointerMove(pin(e))}
    onpointermove={(e) => rail.pointerMove(pin(e))}
    onpointerdown={(e) => rail.pointerDown(pin(e))}
    onpointerup={(e) => rail.pointerUp(pin(e))}
    onpointercancel={(e) => rail.pointerCancel(e.pointerId)}
    onlostpointercapture={(e) => rail.lostCapture(e.pointerId)}
    onpointerleave={leaving}
    onkeydown={(e) => { if (rail.key(e.key, e.repeat)) { e.preventDefault(); e.stopPropagation(); } }}
    onfocus={(e) => { if (keyboardFocus(e.currentTarget as HTMLElement)) rail.focus(); }}
    onblur={() => rail.blur()}
    oncontextmenu={(e) => e.preventDefault()}>
    {#each { length: ticks } as _, i (i)}
      <!-- ONE emphasised tick: the probe's while a probe is open, else the anchor's. -->
      <span class="tr-tick" class:cur={!view.open && i === curTick} class:probe={i === probeTick}></span>
    {/each}
  </div>
</div>

{#if view.open && row}
  <!-- The corridor beside the band (on its left): invisible, the width of the popover's gap and
       the height of the band. It is part of the cluster the hover lives in, so the
       pointer can leave the band at any tick and reach the popover; no timer. -->
  <div class="tr-bridge" bind:this={bridgeEl} role="presentation" onpointerleave={leaving}
    style:left="{placed?.bridge.left ?? 0}px" style:top="{placed?.bridge.top ?? 0}px"
    style:height="{placed?.bridge.height ?? 0}px" style:width="{POPOVER_GAP}px"></div>
  <!-- The popover is a pointer target for the mouse only: rows are not in the tab
       order and keep focus on the band, so the keyboard and assistive technology
       use the slider above (its value text names the same turn). -->
  <div class="tr-pop menu-surface pop-layer" class:ready={ph > 0} bind:this={popEl} role="presentation"
    style:left="{placed?.p.x ?? 0}px" style:top="{placed?.p.y ?? 0}px" style:--pop-origin={placed?.origin}
    style:--pop-maxw="{placed?.p.maxW ?? 0}px" style:--pop-maxh="{placed?.p.maxH ?? 0}px"
    bind:offsetWidth={pw} bind:offsetHeight={ph}
    onpointerdown={(e) => e.preventDefault()}
    onpointerleave={leaving}>
    <div class="menu-list" aria-hidden="true">
      <button type="button" class="menu-item tr-row" tabindex="-1" onclick={() => rail.rowClick(row.key)}>
        <span class="tr-label">{row.label}</span>
      </button>
    </div>
    <div class="menu-heading tr-foot" aria-hidden="true">{foot}</div>
  </div>
{/if}

<style>
  /* The hit column: --turn-rail-hit wide on both screens, painted as a few px of
     tick at its INNER (left) edge, floating over the feed's RIGHT edge, vertically
     centred between the top inset and the clearance above the to-tail control. It
     reserves no space (the feed's padding is untouched) and is itself inert
     (pointer-events none): the wheel and a finger that start anywhere but on the
     band reach the scroller underneath natively, with no forwarder. Only the band
     takes the pointer and only the band refuses the browser's scroll
     (touch-action). A classic scrollbar's width (--turn-rail-edge) is stood clear
     of so its thumb stays grabbable. */
  .turn-rail {
    position: absolute; z-index: 7; inset-block: var(--turn-rail-inset) var(--turn-rail-clear);
    inset-inline-end: var(--turn-rail-edge, 0);
    width: var(--turn-rail-hit); box-sizing: border-box; pointer-events: none;
    display: flex; flex-direction: column; justify-content: center;
  }
  .tr-band {
    flex: 0 1 auto; min-height: 0; box-sizing: border-box; pointer-events: auto;
    height: calc(var(--n, 2) * var(--turn-tick-pitch));
    display: flex; flex-direction: column;
    touch-action: none; cursor: pointer; user-select: none; -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .tr-band:focus-visible { outline: var(--turn-tick-thick) solid var(--accent); outline-offset: calc(-1 * var(--turn-tick-thick)); border-radius: var(--ui-radius-control); }
  .tr-tick {
    flex: 1 1 0; min-height: 0; display: flex; align-items: center; justify-content: flex-start;
    padding-inline-start: var(--ui-gap);
  }
  .tr-tick::before {
    content: ''; width: var(--turn-tick-len); height: var(--turn-tick-thick); border-radius: var(--turn-tick-thick);
    background: var(--text3);
    transition: background var(--t-fast);
  }
  .tr-tick.cur::before { background: var(--text); width: var(--turn-tick-len-cur); }
  .tr-tick.probe::before { background: var(--accent-ink); width: var(--turn-tick-len-cur); }

  .tr-pop {
    position: fixed; z-index: 70; box-sizing: border-box; width: max-content;
    max-width: min(var(--turn-pop-width), var(--pop-maxw));
    max-height: var(--pop-maxh);
    display: flex; flex-direction: column;
  }
  /* The surface itself clips nothing (a hit area outside its box must stay live);
     the list does, so a long row or a short room still cannot spill. */
  .tr-pop .menu-list { min-height: 0; overflow: hidden; }
  .tr-bridge { position: fixed; z-index: 70; }
  /* The probed turn at the bubble's own type step, up to three lines. */
  .tr-row { color: var(--text); font-size: var(--fs-body); align-items: flex-start; }
  .tr-label {
    min-width: 0; overflow: hidden; overflow-wrap: anywhere; white-space: normal;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3;
  }
  .tr-foot { color: var(--text3); font-variant-numeric: tabular-nums; }
</style>
