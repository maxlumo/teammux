<script lang="ts">
  import { moveMs } from './motion.ts';
  import Icon from './Icon.svelte';
  import OperationFeedback from './OperationFeedback.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import type { FeedbackValue } from './feedback-lifetime.ts';
  // Fullscreen image viewer (owner, 2026-08-26: "看图片的支持"). One fixed
  // overlay above everything — like every fixed layer it assumes the VIEWPORT
  // as containing block (design-language.md §2). Gestures are the ones a photo
  // viewer owes you: pinch to zoom (two pointers), drag to pan once zoomed,
  // double-tap toggles 1x ↔ 2.5x at the tapped point, wheel zooms on desktop.
  // Dismissal is the standard set: backdrop tap (only when NOT zoomed — a pan
  // that ends on the backdrop must not close it), Escape, the ✕, and the
  // Android back gesture via the host page's onGoBack chain.
  //
  // Download (board #447): a host that can save this picture's FILE hands
  // `ondownload`; the control sits beside ✕ in the same bar, and `status` is the
  // host's feedback for it, drawn by the one OperationFeedback. Without
  // `ondownload` the viewer is exactly what it was. `downloading` hides the
  // control while a save for THIS open runs (one tap, one attempt). The bar and
  // the status are SIBLINGS of the stage that owns every gesture below: the
  // stage captures the pointer on press, so anything inside it would lose its
  // release (and its click) to the capture.
  let { src = '', alt = '', onclose = () => {}, ondownload = undefined, downloading = false, status = null, onstatusdismiss = undefined } = $props<{
    src?: string; alt?: string; onclose?: () => void;
    ondownload?: () => void; downloading?: boolean;
    status?: FeedbackValue | null; onstatusdismiss?: () => void;
  }>();

  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  /* Swipe-to-dismiss (owner, 2026-08-27: "我可以再一划这个图片，它就自动缩小
     了"): an UNZOOMED single-finger drag carries the image with the finger,
     shrinking it and thinning the backdrop as it travels; past a threshold the
     release closes the viewer, short of it the image springs back. Zoomed
     drags stay pans. */
  let dismissing = $state(false);
  let settle = $state(false);
  const dismissP = $derived(scale === 1 ? Math.min(1, Math.hypot(tx, ty) / 260) : 0);

  const MAX_SCALE = 6;
  let pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let lastTap = 0;
  let moved = false;

  function clamp() {
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; }
    else if (scale > MAX_SCALE) scale = MAX_SCALE;
  }
  function zoomAt(cx: number, cy: number, factor: number) {
    // Keep the point under the cursor/fingers stationary while scaling.
    const s2 = Math.min(Math.max(scale * factor, 1), MAX_SCALE);
    const k = s2 / scale;
    const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
    tx = ox - (ox - tx) * k;
    ty = oy - (oy - ty) * k;
    scale = s2;
    clamp();
  }

  function onPointerDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    settle = false;
    if (pointers.size === 2) {
      dismissing = false; // a second finger means pinch, not dismiss
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  }
  function onPointerMove(e: PointerEvent) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDist > 0) zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d / pinchDist);
      pinchDist = d;
    } else if (scale > 1) {
      tx += dx; ty += dy;
    } else if (pointers.size === 1) {
      dismissing = true;
      tx += dx; ty += dy;
    }
  }
  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (pointers.size === 0 && dismissing) {
      dismissing = false;
      if (Math.hypot(tx, ty) > 80) { onclose(); return; }
      settle = true;   // spring back: the transition does the animation
      tx = 0; ty = 0;
      setTimeout(() => { settle = false; }, moveMs());
    }
    if (pointers.size === 0 && !moved) {
      const now = performance.now();
      if (now - lastTap < 300) {
        // Double-tap: zoom into the tapped point, or all the way back out.
        if (scale > 1) { scale = 1; tx = 0; ty = 0; }
        else zoomAt(e.clientX, e.clientY, 2.5);
        lastTap = 0;
      } else lastTap = now;
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }
  function onBackdrop(e: MouseEvent) {
    // Only a clean tap on the backdrop itself, while unzoomed, closes.
    if (e.target === e.currentTarget && scale === 1 && !moved) onclose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); onclose(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="lb" role="dialog" aria-label={alt || 'image'} tabindex="-1"
  style:background={dismissP ? `color-mix(in srgb, var(--bg) ${Math.round(88 * (1 - 0.6 * dismissP))}%, transparent)` : null}>
  <!-- The stage: the picture and every gesture on it (pinch, pan, swipe, wheel, backdrop tap). -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="lb-stage"
    onpointerdown={onPointerDown} onpointermove={onPointerMove}
    onpointerup={onPointerUp} onpointercancel={onPointerUp}
    onclick={onBackdrop} onwheel={onWheel}>
    <img class="lb-img" class:settle {src} {alt} draggable="false"
      style:transform={`translate(${tx}px, ${ty}px) scale(${scale * (1 - 0.18 * dismissP)})`} />
  </div>
  <div class="lb-bar">
    {#if ondownload && !downloading}
      <button class="lb-btn lb-download" type="button" aria-label={t('filesDownload')} onclick={ondownload}><Icon name="download" size={16} /></button>
    {/if}
    <button class="lb-btn lb-close" type="button" aria-label="close" onclick={onclose}>✕</button>
  </div>
  {#if status}
    <div class="lb-status"><OperationFeedback value={status} ondismiss={status.kind === 'error' ? onstatusdismiss : undefined} /></div>
  {/if}
</div>

<style>
  .lb {
    position: fixed; inset: 0; z-index: 300;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    overscroll-behavior: contain;
  }
  .lb-stage {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    touch-action: none;
    /* The APK's real status-bar inset arrives via --sat, never raw env(). */
    padding-top: var(--sat, 0px);
  }
  .lb-img {
    max-width: 100%; max-height: 100%;
    user-select: none; -webkit-user-select: none;
    /* The transform is the viewer's state, not a transition: the finger is
       the animation, exactly like the Files edge-drag. */
    will-change: transform;
    pointer-events: none;
  }
  /* Springing back from an aborted dismiss swipe is the ONE animated moment;
     while a finger is down the finger is the animation. */
  .lb-img.settle { transition: transform var(--t-move) ease; }
  @media (prefers-reduced-motion: reduce) { .lb-img.settle, .lb-btn::before, .lb-btn { transition: none; } }
  /* The bar: ✕ keeps its place (34px paint, 8px from the corner and below the status
     strip); each control's 44px touch box is real, so neighbours abut instead of
     overlapping their hit areas. */
  .lb-bar {
    position: absolute; top: calc(8px - 5px + var(--sat, 0px)); right: calc(8px - 5px);
    display: flex; gap: var(--ui-gap);
  }
  .lb-btn {
    position: relative; isolation: isolate;
    width: 44px; height: 44px; padding: 0; display: flex; align-items: center; justify-content: center;
    border: 0; background: none; color: var(--text2); font-size: var(--fs-body);
    cursor: pointer;
    transition: color var(--t-fast);
  }
  .lb-btn::before {
    content: ''; position: absolute; inset: 5px; z-index: -1;
    border-radius: var(--ui-radius-control); border: 1px solid var(--border2);
    background: var(--surface);
    transition: border-color var(--t-fast);
  }
  .lb-btn:hover { color: var(--text); }
  .lb-btn:hover::before { border-color: var(--accent); }
  .lb-status {
    position: absolute; left: var(--ui-gap); right: var(--ui-gap);
    bottom: calc(var(--ui-gap) * 4 + var(--sab, 0px));
    display: flex; justify-content: center; pointer-events: none;
  }
  .lb-status > :global(.operation-feedback) { pointer-events: auto; max-width: 100%; }
</style>
