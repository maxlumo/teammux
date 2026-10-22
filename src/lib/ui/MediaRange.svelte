<script lang="ts">
  // The media position bar (board #453): a NATIVE range — arrows, Home/End,
  // PageUp/PageDown and the assistive-technology adjust gestures come with it —
  // over a painted track that shows what the browser has buffered and what has
  // played. The atom owns the commit protocol, the player owns what a commit
  // means (files/MediaPlayer.svelte):
  //   pointer  — `input` previews, `pointerup` commits once, a cancel or a lost
  //              capture without a release cancels (nothing is sought);
  //   keyboard / AT — `input` previews and `change` commits; nothing waits for
  //              a pointerup that never comes.
  // Each of those is ONE input transaction with an id, handed to the host with
  // every callback, and it belongs to the host `epoch` it began in. When the
  // host bumps `epoch` (its life ended, focus left), the open transaction is
  // dead: a pointer's later moves, its change and its release do nothing until
  // that pointer is lifted, and a new transaction starts only with a new input
  // (#453 review P1-A). The PHYSICAL pointer is tracked apart from the
  // transaction (review round 5): `pointercancel` and `lostpointercapture` end
  // the transaction, not the press — the finger may still be down and the
  // native range may still move under it — so its inputs stay its own and are
  // dropped, never re-read as a keyboard/AT adjust. Only that pointer's real
  // release (seen on the window too, wherever it lands, or a touch's
  // touchend/touchcancel once no finger is left) or a new pointerdown ends the
  // press; another finger's pointerup does not. The trailing native `change` a released pointer still
  // owes is swallowed only while no newer input came, so a later assistive
  // adjustment is never eaten by an old mark.
  // Its keydown never reaches the player, so the player's own Left/Right
  // shortcut never fires on top of the range's step.
  let { value, max, step = 1, label, valuetext, disabled = false, buffered = [], waiting = false, epoch = 0,
    onpreview, oncommit, oncancel }:
    { value: number; max: number; step?: number; label: string; valuetext: string; disabled?: boolean;
      buffered?: { start: number; end: number }[]; waiting?: boolean; epoch?: number;
      onpreview: (v: number, tx: number) => void; oncommit: (v: number, tx: number) => void; oncancel: (tx: number) => void } = $props();
  let tx = 0, kind: 'pointer' | 'other' | null = null, txEpoch = 0, committed = false;
  /** The physical pointer that owns the open press (live, or dead after a
   * cancel, a lost capture or an epoch bump); null once it is released. */
  let press: { id: number | undefined; type: string | undefined } | null = null;
  let input: HTMLInputElement | null = null;
  /** The released pointer transaction whose trailing `change` is still owed;
   * any newer input is a newer `tx`, so the mark never reaches it. */
  let owed = 0;
  const pct = (t: number) => (max > 0 ? Math.min(100, Math.max(0, (t / max) * 100)) : 0);
  const live = (k: 'pointer' | 'other') => kind === k && txEpoch === epoch;
  function begin(k: 'pointer' | 'other') { tx++; kind = k; txEpoch = epoch; committed = false; }
  /** A dead transaction's native thumb goes back to the host's value. */
  const restore = (el: HTMLInputElement) => { el.value = String(value); };
  const mine = (e: PointerEvent) => !!press && e.pointerId === press.id;
  /** The transaction ends; the press does not. */
  function kill() { if (kind === 'pointer') { if (live('pointer') && !committed) oncancel(tx); kind = null; } }
  function unpress() {
    press = null;
    window.removeEventListener('pointerup', away, true);
    window.removeEventListener('touchend', touchAway, true);
    window.removeEventListener('touchcancel', touchAway, true);
  }
  // A release the range itself does not see (its capture was lost): the press
  // ends there. The range's own pointerup is handled on the range.
  function away(e: PointerEvent) { if (mine(e) && e.target !== input) { kill(); unpress(); } }
  function touchAway(e: TouchEvent) { if (press?.type === 'touch' && e.touches.length === 0) { kill(); unpress(); } }
  // Destroyed mid-input (the player swaps its narrow/wide row while a finger
  // is down): this range retires its OWN open transaction, so the host drops
  // its preview and drag hold (review P2 after #453), then lets the press go.
  // It runs in the same flush as the swap, before the new range can take any
  // input, and the host clears only a drag whose id it holds.
  $effect(() => () => { if (kind) oncancel(tx); kind = null; unpress(); });
</script>

<div class="media-range" class:waiting>
  <div class="mr-track" aria-hidden="true">
    {#each buffered as b, i (i)}<span class="mr-buf" style:left="{pct(b.start)}%" style:width="{pct(b.end - b.start)}%"></span>{/each}
    <span class="mr-played" style:width="{pct(value)}%"></span>
  </div>
  <!-- Native ranges sanitize value immediately, so constraints come first. -->
  <input type="range" min="0" {max} {step} {value} {disabled} aria-label={label} aria-valuetext={valuetext}
    bind:this={input}
    onpointerdown={(e) => {
      kill(); unpress();
      press = { id: e.pointerId, type: e.pointerType };
      window.addEventListener('pointerup', away, true);
      window.addEventListener('touchend', touchAway, true);
      window.addEventListener('touchcancel', touchAway, true);
      begin('pointer'); e.currentTarget.setPointerCapture?.(e.pointerId);
    }}
    onpointerup={(e) => {
      if (!mine(e)) return;
      if (live('pointer') && !committed) { committed = true; owed = tx; oncommit(e.currentTarget.valueAsNumber, tx); }
      if (kind === 'pointer') kind = null;
      unpress();
    }}
    onpointercancel={(e) => { if (mine(e)) kill(); }} onlostpointercapture={(e) => { if (mine(e)) kill(); }}
    oninput={(e) => {
      const v = e.currentTarget.valueAsNumber;
      if (press) { if (live('pointer')) onpreview(v, tx); else restore(e.currentTarget); return; }
      if (!live('other')) begin('other');
      onpreview(v, tx);
    }}
    onchange={(e) => {
      const v = e.currentTarget.valueAsNumber;
      if (press) { if (live('pointer') && !committed) { committed = true; oncommit(v, tx); } else if (!live('pointer')) restore(e.currentTarget); return; }
      if (owed && owed === tx && kind === null) { owed = 0; return; }
      if (live('other')) { kind = null; oncommit(v, tx); return; }
      kind = null; restore(e.currentTarget);
    }}
    onkeydown={(e) => e.stopPropagation()} />
</div>

<style>
  .media-range { position: relative; flex: 1; min-width: 0; height: var(--control-height); display: flex; align-items: center; }
  .mr-track { position: absolute; left: 0; right: 0; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; pointer-events: none; }
  .mr-buf { position: absolute; top: 0; bottom: 0; background: var(--text3); }
  .mr-played { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent-ink); transition: opacity var(--t-fast); }
  .waiting .mr-played { opacity: 0.6; }
  input {
    position: relative; width: 100%; height: 100%; margin: 0; background: transparent;
    -webkit-appearance: none; appearance: none; cursor: pointer; touch-action: none;
  }
  input:disabled { cursor: default; }
  input::-webkit-slider-runnable-track { height: 100%; background: transparent; }
  input::-moz-range-track { background: transparent; }
  input::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: calc((var(--control-height) - 14px) / 2);
    border: 0; border-radius: 50%; background: var(--accent-ink);
  }
  input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--accent-ink); }
  input:disabled::-webkit-slider-thumb { background: var(--text3); }
  input:disabled::-moz-range-thumb { background: var(--text3); }
  @media (prefers-reduced-motion: reduce) { .mr-played { transition: none; } }
</style>
