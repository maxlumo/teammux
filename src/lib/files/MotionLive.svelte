<script lang="ts">
  // Board #133 (leader's ruling, note 2): a Motion Photo's ONE control and its moment. The
  // still stays the preview's own <img> underneath; pressed, the embedded video plays ONCE,
  // with sound (a deliberate press, as the video preview), in a bare <video playsinline> over
  // the still at the same fit; no player bar over a 1.5-3 s moment (MediaPlayer is a film's).
  // On 'ended', on Stop, on leaving the file or the page the still returns. The stream URL
  // (the server's signed window of the same file) is minted on the FIRST press, then reused;
  // a failed mint or stream returns the still and reports through the preview's error path.
  // The host keys this on the file, so a late answer for a file left behind lands nowhere.
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { isAndroid } from '../core/platform.ts';
  // Board #139: the transparent poster (the owner saw WebView's stock play graphic here); the
  // still underneath shows through it until play() clears the show-poster flag and a frame paints.
  import { hasPicture, posterFor } from './media-player.ts';

  let { path, natural, open, onerror, visible = true }: {
    path: string;
    /** The still's natural size: the motion is laid out from it under the still's own max-only
     * constraints, in the same container, so the layout engine gives both the same box at every
     * size and resize (validator-2, #133 notes 22 and 28: spanning the pane upscaled an 80×80
     * photo; a measured rect went 50 px off when only the position changed). */
    natural: { width: number; height: number };
    /** Mint the window's stream URL for `path`. */
    open: (path: string) => Promise<string>;
    onerror: (message: string) => void;
    visible?: boolean;
  } = $props();

  let src = $state('');
  let playing = $state(false);
  let video = $state<HTMLVideoElement | null>(null);
  let alive = true;
  $effect(() => () => { alive = false; });
  $effect(() => { if (!visible) retire(); });
  // Play once the element is in the DOM with its source: one writer of play(). Each attempt
  // is its OWN video (a replay draws a new element) and every answer is checked against it
  // (code-quality.md § 1.4). A rejected play while that video is still the one meant to play
  // is a failure, AbortError included (validator-2, #133 notes 13 and 27); our own Stop or
  // leaving retires it first, so its rejection lands on a video no longer current.
  $effect(() => {
    if (!(playing && video && src)) return;
    const el = video;
    el.play().catch(() => { if (current(el)) fail(); });
  });
  const current = (el: EventTarget | null) => alive && playing && el !== null && el === video;

  // The Live INTENT owns mint → playback (reviewer, #133 note 42): each press is an intent;
  // Stop, hiding the page and leaving the file retire it. ONE mint per file (single flight):
  // a press while it is pending waits on the same promise, and only the intent current when
  // it settles consumes it (plays) or reports it (once). A failed mint is dropped, so the next
  // press mints again.
  let intent = 0;
  let mint: Promise<string> | null = null;
  function retire() { intent += 1; playing = false; }

  function fail() {
    retire();
    onerror(t('filesMotionFailed'));
  }

  /** The current video has no decodable picture (board #141): sound alone is not the motion.
   * Its sound stops, the still returns and the person is told; the URL is kept (the stream
   * is fine), so a replay reports again without minting. */
  function noPicture(el: HTMLVideoElement) {
    el.pause();
    retire();
    onerror(t('filesMotionNoPicture'));
  }
  const checkPicture = (e: Event) => {
    const el = e.currentTarget as HTMLVideoElement;
    if (current(el) && !hasPicture(el)) noPicture(el);
  };

  /** The current video's STREAM failed (reviewer, #133 note 52): its URL is dropped as a failed
   * mint is, so the next press mints afresh: a file rewritten while previewed whose detected
   * window no longer matches (404) or a signature past its lifetime (403) is never replayed. */
  function dropStream() {
    src = '';
    mint = null;
    fail();
  }

  async function toggle() {
    if (playing) { retire(); return; }
    const mine = ++intent;
    playing = true;
    if (src) return;
    const pending = mint ??= open(path);
    try {
      const url = await pending;
      if (alive && mine === intent) src = url;
    } catch {
      if (mint === pending) mint = null;
      if (alive && mine === intent) fail();
    }
  }
</script>

<div class="motion-live">
  <CommandButton icon={playing ? 'stop' : 'play'} label={playing ? t('filesMotionStop') : t('filesMotionLive')}
    pressed={playing} onclick={toggle} />
</div>
{#if playing && src}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video class="motion-video" bind:this={video} {src} playsinline preload="auto" poster={posterFor(isAndroid)}
    style:--still-w={natural.width} style:--still-h={natural.height}
    onloadedmetadata={checkPicture} onplaying={checkPicture}
    onended={(e) => { if (current(e.currentTarget)) retire(); }} onerror={(e) => { if (current(e.currentTarget)) dropStream(); }}></video>
{/if}

<style>
  /* The pane's top-left, above the picture and outside its zoom target. */
  .motion-live { position: absolute; top: var(--ui-gap); left: var(--ui-gap); z-index: 1; }
  /* The still's box by the same layout (#133 note 28): the still is its natural size capped by
     the pane's content box on both axes, its ratio kept (max-width/max-height: 100%), centred;
     the video is the same numbers from the same container (the pane, a size container), centred
     in the same symmetric box. No measurement, so no event can be missed. The picture's own tap
     stays the zoom. */
  .motion-video {
    position: absolute; inset: 0; margin: auto; object-fit: contain; pointer-events: none; border-radius: 4px;
    width: min(calc(var(--still-w) * 1px), 100cqw, calc(100cqh * var(--still-w) / var(--still-h)));
    height: min(calc(var(--still-h) * 1px), 100cqh, calc(100cqw * var(--still-h) / var(--still-w)));
  }
</style>
