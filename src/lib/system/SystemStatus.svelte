<script lang="ts">
  // Server system vitals corner — board #56 「服务端系统状态显示」.
  //
  // DELIBERATELY DUMB about transport: the `load` callback is INJECTED by
  // whoever mounts this (App wires it to the `system_status` RPC in its own
  // two-line integration — this file never imports ws.ts, so the #55/#57
  // territories stay untouched and the component tests need no socket).
  //
  // Tempo: one load per SYS_POLL_MS (20s — the owner asked for a low refresh,
  // "大概看个数就行"), floored at SYS_POLL_MIN_MS so no caller can wire a hot
  // loop; the SERVER computes CPU% over this very interval, so the tempo is
  // also the measurement window. While `visible` is false the timer stops —
  // a hidden corner reading the CPU is the hidden-terminal mistake in
  // miniature. On re-show it reads immediately (the old reading is stale by
  // up to a whole interval).
  //
  // Fail-soft both ways: a failed/null load KEEPS the last reading ("I could
  // not ask" is not "there is nothing", the roster's lesson), and nothing at
  // all renders until the first successful reading (the verdict rule — no
  // flash of zeros).
  import { sysDetail, sysParts, SYS_POLL_MS, SYS_POLL_MIN_MS, type SystemStatus } from './system.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import { untrack } from 'svelte';
  import { t } from '../core/i18n.svelte.ts';

  let {
    load,
    interval = SYS_POLL_MS,
    visible = true,
    tag = null,
    server = null,
  }: {
    load: () => Promise<SystemStatus | null>;
    interval?: number;
    visible?: boolean;
    /** The server's name by the ③c-1 tag rule (null = not shown): the
     * reading is ONE server's — the focused one's — never a sum (board 335
     * ③c-5), and when several servers are included the card says whose. */
    tag?: string | null;
    /** Whose reading this is: when the focus moves to another server the
     * last reading is that server's no more — it is dropped and read again
     * at once rather than shown for up to a whole interval. */
    server?: string | null;
  } = $props();

  let status = $state<SystemStatus | null>(null);
  const parts = $derived(sysParts(status));
  const tempo = $derived(Math.max(SYS_POLL_MIN_MS, interval));
  // The full reading rides the ONE hover card (motion.md §1.16), not a native
  // title: exact fractions and the poll tempo, read at open time.
  const LABELS: Record<string, () => string> = { CPU: () => 'CPU', MEM: () => t('sysMemory'), DISK: () => t('sysDisk') };
  const detail = () => ({
    title: tag ? `${t('sysVitals')} · ${tag}` : t('sysVitals'),
    lines: sysDetail(status).map((r) => ({ label: (LABELS[r.k] ?? (() => r.k))(), value: r.v })),
    note: t('sysRefresh').replace('{s}', String(Math.round(tempo / 1000))),
  });

  async function tick() {
    try {
      const r = await load();
      if (r) status = r; // a null/failed answer keeps the last reading
    } catch {
      /* fail-soft: telemetry may never break the page that carries it */
    }
  }

  // ONE effect owns the timer: visible → an immediate read (the old reading
  // is up to a whole interval stale) + the interval; hidden → cleanup stops
  // it. Re-runs when `visible` or the clamped tempo change.
  $effect(() => {
    void server;   // another server's reading is not this one's
    if (!visible) return;
    untrack(() => { status = null; });
    void tick();
    const timer = setInterval(tick, tempo);
    return () => clearInterval(timer);
  });
</script>

{#if parts.length}
  <!-- A quiet monitor readout, not three attention-seeking cards: tiny
       categorical dots aid scanning, muted labels orient, and only the mono
       readings use full ink. The hover card carries the complete reading. -->
  <div class="sysvitals appear" use:hoverInfo={detail}>
    {#each parts as p (p.k)}
      <span class="sv" class:cpu={p.k === 'CPU'} class:mem={p.k === 'MEM'} class:disk={p.k === 'DISK'}>
        <span class="sv-k">{p.k}</span><span class="sv-v">{p.v}</span>
      </span>
    {/each}
  </div>
{/if}

<style>
  .sysvitals {
    width: 100%;
    min-width: 0;
    display: flex;
    gap: 9px;
    align-items: center;
    font-size: var(--fs-micro);
    line-height: 1;
    user-select: none;
    white-space: nowrap;
  }
  .sv {
    --sv-hue: var(--accent);
    flex: 0 1 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    overflow: hidden;
  }
  .sv::before {
    content: '';
    width: 4px;
    height: 4px;
    flex: none;
    border-radius: 50%;
    background: var(--sv-hue);
    opacity: 0.72;
  }
  .sv.mem { --sv-hue: var(--status-purple); }
  .sv.disk { --sv-hue: var(--status-ok); }
  .sv-k {
    flex: none;
    color: var(--text2);
    font-weight: 500;
    letter-spacing: 0.03em;
  }
  .sv-v {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
    font-family: var(--font-mono);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
</style>
