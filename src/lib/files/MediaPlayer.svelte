<script lang="ts">
  // The Files media player (board #453). The browser's own <video>/<audio> is
  // still the engine — it decodes, buffers and fetches its own ranges from the
  // signed /dl stream (#182/#416) — and this is only its controls layer, in
  // our design language. The rules are files/media-player.ts; the position bar
  // is the ui/MediaRange atom. Protocols (the #453 design, deltas 1-3):
  //   - a tap on the picture only shows or hides the controls; playing is the
  //     button's job, so a double tap's first tap never changes playback. A
  //     double tap in the left or right third seeks -10/+10 s;
  //   - nothing in the bar reaches the picture or Files' edge swipe;
  //   - the bar auto-hides during playback after 3 s, never while paused,
  //     waiting or failed, nor while keyboard focus (:focus-visible), a drag,
  //     the pointer or an open menu is on it; hidden, it is inert;
  //   - state comes from the element's events only, and every async request
  //     carries an owner ticket (Intents): a late one never starts anything and
  //     never undoes a newer request.
  import { flushSync, onDestroy, tick, untrack } from 'svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import MediaRange from '../ui/MediaRange.svelte';
  import { anchorOf } from '../ui/placement.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { isAndroid } from '../core/platform.ts';
  import Icon from '../ui/Icon.svelte';
  import { ANDROID_FULLSCREEN_EVENT, BLANK_POSTER, androidFullscreen, canFullscreen, canPip, clampTo, errorKind, fmtTime, Intents, seekWindow, spans, third, type Span } from './media-player.ts';

  let { kind, src, name = '', visible = true, mediaEl = $bindable(null), reopen = null }:
    { kind: 'video' | 'audio'; src: string; name?: string;
      /** The host's gate (Files: the page is seen AND its server scope is
       * eligible, the same gate its image viewer retires on). */
      visible?: boolean; mediaEl?: HTMLMediaElement | null;
      /** A fresh stream URL for this file (Files' own open path), for a retry after a network error. */
      reopen?: (() => Promise<string>) | null } = $props();

  const intents = new Intents();
  let player = $state<HTMLDivElement | null>(null), bar: HTMLDivElement | null = null;
  /** A self-reopen's fresh URL; the prop `src` changing is a new source. */
  let ownSrc = $state<string | null>(null);
  let paused = $state(true), waiting = $state(false), muted = $state(false), rate = $state(1);
  let time = $state(0), duration = $state(NaN);
  let buffered = $state<Span[]>([]), seekable = $state<Span[]>([]);
  let error = $state<{ text: string; unplayable: boolean; network: boolean } | null>(null);
  let preview = $state<number | null>(null);
  /** The picture is on screen (board #470) once the CURRENT load has data
   * AND, in the Android app, the show-poster flag is cleared: our transparent
   * poster (BLANK_POSTER) keeps covering the first frame until play or a
   * seek, as any poster does. Both facts are per load: `loadstart` (a new
   * load's resource selection, where Blink sets the show-poster flag again)
   * and `emptied` clear them, so an old source's never reaches a new one, and they may arrive
   * in either order. Until then the player shows its own tile, in the
   * picture's aspect (16:9 until the metadata says). */
  let hasData = $state(false), posterCleared = $state(false), framed = $state(false), aspect = $state(16 / 9);
  /** Read the element itself, on every event that can change the answer:
   * data is HAVE_CURRENT_DATA or better on THIS element now. Once the frame
   * is on screen it stays for this load — a later pause, seek or buffering
   * never brings the initial tile back. */
  function settleFrame() {
    if (framed || !mediaEl) return;
    hasData = mediaEl.readyState >= 2;
    if (hasData && (!isAndroid || posterCleared)) framed = true;
  }
  function newLoad() { hasData = false; posterCleared = false; framed = false; aspect = 16 / 9; }
  /** The range transaction being dragged and the seek ticket it opened. */
  let drag: { tx: number; ticket: ReturnType<Intents['begin']> } | null = null;
  /** `life` bumps at every life end (menus built before it are stale);
   * `gesture` also bumps when focus leaves: the range's transactions of an
   * older one are dead (MediaRange `epoch`). */
  let life = $state(0), gesture = $state(0), destroyed = false;
  let shown = $state(true), menuAt = $state<object | null>(null), fsOn = $state(false), pipOn = $state(false);
  let width = $state(0), pointerOver = false, hideTimer = 0, tapTimer = 0, lastTap = { at: 0, side: '' };
  /** The picture's pointerdown: where, and whether the bar was shown THEN —
   * before the tap's own focus move into the player pokes it shown. */
  let down: { x: number; y: number; shown: boolean } | null = null;

  /** Every forward entry (play, seek, mute, modes, menu, keys, taps) asks
   * this first: nothing starts while the host's gate is closed. */
  const live = () => visible && !destroyed;
  const win = $derived(seekWindow(duration, seekable));
  /** What the bar says. A media error is never "playing", whatever the
   * element's own paused flag still reads, so its one action is Play. */
  const playing = $derived(!paused && !error);
  const shownTime = $derived(preview ?? time);
  // Before there is anywhere to seek, the position is not a number either.
  const posText = $derived(win ? fmtTime(shownTime, duration) : '--:--');
  const narrow = $derived(width > 0 && width < 520);
  /** The Android host's answer, as state (board #454 review P1-A): queried
   * once at mount and again on every `androidfullscreenchange` the host
   * dispatches when its answer flips, so an install that lands after the
   * player mounted shows the control without remounting it. */
  let androidFs = $state(false);
  $effect(() => {
    if (!isAndroid) return;
    const ask = () => { androidFs = androidFullscreen(window as never); };
    window.addEventListener(ANDROID_FULLSCREEN_EVENT, ask);
    ask();
    return () => window.removeEventListener(ANDROID_FULLSCREEN_EVENT, ask);
  });
  const fsOk = $derived(kind === 'video' && !!player && canFullscreen({ android: isAndroid, androidFullscreen: androidFs }, document, player));
  const pipOk = $derived(kind === 'video' && !!mediaEl && canPip(document as never, mediaEl as never));

  function cancelGesture() { gesture++; drag = null; preview = null; }
  // A life ends when the host's gate closes (hide, ineligible), on a source
  // change and on destroy: requests in flight go stale, every open gesture
  // (range, picture), the menu and the timers go with it, and the modes THIS
  // player holds are left.
  function endLife() {
    intents.endLife();
    life++; cancelGesture();
    menuAt = null; down = null; lastTap = { at: 0, side: '' };
    clearTimeout(hideTimer); clearTimeout(tapTimer); tapTimer = 0;
    if (player && document.fullscreenElement === player) document.exitFullscreen?.().catch(() => {});
    if (mediaEl && (document as { pictureInPictureElement?: Element | null }).pictureInPictureElement === mediaEl) (document as { exitPictureInPicture?: () => Promise<void> }).exitPictureInPicture?.().catch(() => {});
  }
  let lastSrc: string | undefined;
  $effect(() => {
    const next = src;
    if (lastSrc === undefined || next === lastSrc) { lastSrc = next; return; }
    lastSrc = next; ownSrc = null; error = null;
    untrack(endLife);
  });
  // Hide ends the life; the PAUSE itself stays FilePreview's one rule (#416),
  // on the same bound element, so there is one pause-on-hide.
  // (untrack: an end of life bumps `life`/`gesture`, which these effects must not read.)
  $effect(() => { if (!visible) untrack(endLife); });
  onDestroy(() => { destroyed = true; endLife(); });

  function reset() { time = 0; duration = NaN; buffered = []; seekable = []; preview = null; drag = null; waiting = false; }
  function readTimes() {
    if (!mediaEl) return;
    time = mediaEl.currentTime; duration = mediaEl.duration;
    buffered = spans(mediaEl.buffered); seekable = spans(mediaEl.seekable);
  }

  /** Play or pause, as the user asks. A late result re-asserts the CURRENT
   * play intent: it pauses only when no newer request asked to play. */
  function play() {
    const el = mediaEl;
    if (!el || !live() || error?.unplayable) return;
    if (error?.network && reopen) { retry(); return; }
    error = null;
    const ticket = intents.begin('play', true);
    el.play().then(
      () => { if (!intents.current(ticket) && !intents.wants('play')) el.pause(); },
      (e: { name?: string }) => {
        if (!intents.current(ticket) || e?.name === 'AbortError') return;
        error = { text: t(e?.name === 'NotAllowedError' ? 'mediaBlocked' : 'mediaFailed'), unplayable: false, network: false };
      });
  }
  function pause() { intents.begin('play', false); mediaEl?.pause(); }
  const toggle = () => (playing ? pause() : play());
  /** A network error: re-open the file through Files' path (a fresh stream
   * signature) and play it, as ONE intent. Anything that ends the life or a
   * newer play/pause request drops the continuation. */
  async function retry() {
    const ticket = intents.begin('play', true);
    error = null;
    let url: string;
    try { url = await reopen!(); } catch { if (intents.current(ticket)) error = { text: t('mediaFailed'), unplayable: false, network: true }; return; }
    if (!intents.current(ticket)) return;
    ownSrc = url;
    await tick();
    if (!intents.current(ticket) || !mediaEl) return;
    const el = mediaEl;
    el.play().then(
      () => { if (!intents.current(ticket) && !intents.wants('play')) el.pause(); },
      (e: { name?: string }) => { if (intents.current(ticket) && e?.name !== 'AbortError') error = { text: t('mediaFailed'), unplayable: false, network: false }; });
  }

  // Every seek path (range, keys, double tap) has the range's own limits: no
  // window yet, or an unplayable file, seeks nothing.
  const canSeek = () => live() && !!win && !error?.unplayable;
  function seekTo(v: number, ticket: ReturnType<Intents['begin']>) {
    if (!mediaEl || !win || !canSeek() || !intents.current(ticket)) return;
    mediaEl.currentTime = clampTo(v, win, seekable);
  }
  function seekBy(d: number) { if (canSeek()) seekTo((mediaEl?.currentTime ?? 0) + d, intents.begin('seek', true)); }
  // One range transaction, one seek ticket: the first preview of a NEW
  // transaction opens it, a commit of that same transaction spends it. The
  // range refuses a dead transaction's events itself (its `epoch`), so an old
  // finger never opens a ticket for the next source.
  function onPreview(v: number, tx: number) {
    if (!live()) return;
    if (drag?.tx !== tx) drag = { tx, ticket: intents.begin('seek', true) };
    preview = v;
  }
  function onCommit(v: number, tx: number) {
    const d = drag; preview = null; drag = null;
    if (d && d.tx === tx) seekTo(v, d.ticket);
  }
  function onCancel(tx: number) { if (drag?.tx === tx) { drag = null; preview = null; } }

  function toggleMute() { if (mediaEl && live()) mediaEl.muted = !mediaEl.muted; }
  function toggleFs() {
    if (!player || !live()) return;
    if (document.fullscreenElement === player) { intents.begin('fullscreen', false); document.exitFullscreen?.().catch(() => {}); return; }
    const ticket = intents.begin('fullscreen', true), el = player;
    el.requestFullscreen().then(() => {
      if (!intents.current(ticket) && !intents.wants('fullscreen') && document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
    }, () => {});
  }
  function togglePip() {
    const v = mediaEl as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    const doc = document as { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
    if (!v?.requestPictureInPicture || !live()) return;
    if (doc.pictureInPictureElement === v) { intents.begin('pip', false); doc.exitPictureInPicture?.().catch(() => {}); return; }
    const ticket = intents.begin('pip', true);
    v.requestPictureInPicture().then(() => {
      if (!intents.current(ticket) && !intents.wants('pip') && doc.pictureInPictureElement === v) doc.exitPictureInPicture?.().catch(() => {});
    }, () => {});
  }

  // Auto-hide (video only). The timer re-checks the holds when it fires.
  function hold(): boolean {
    return !!drag || !!menuAt || pointerOver || !!player?.matches(':focus-visible') || !!player?.querySelector(':focus-visible');
  }
  /** Hide the bar without blurring what the user pressed (validator V2): a
   * control that holds focus hands it to the container first, so `inert`
   * never drops focus to the page — whose focusout would show the bar again
   * and restart the 3 s. */
  function hide() {
    if (player && bar?.contains(document.activeElement)) player.focus({ preventScroll: true });
    clearTimeout(hideTimer); // after the focus move: its focusin pokes
    shown = false;
  }
  function poke() {
    shown = true;
    clearTimeout(hideTimer);
    if (kind !== 'video' || paused || waiting || error) return;
    hideTimer = window.setTimeout(() => { if (hold()) poke(); else hide(); }, 3000);
  }
  $effect(() => { void paused; void waiting; void error; poke(); });

  // One handler for the picture: a single tap (after 250 ms) toggles the
  // controls; a second tap in the same side third seeks instead.
  function onPictureUp(e: PointerEvent) {
    if (!down || !live() || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) { down = null; return; }
    const wasShown = down.shown;
    down = null;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side = third(e.clientX - r.left, r.width), now = Date.now();
    const second = tapTimer && now - lastTap.at < 250 && side === lastTap.side;
    clearTimeout(tapTimer); tapTimer = 0;
    if (second && side !== 'middle') { seekBy(side === 'left' ? -10 : 10); poke(); lastTap = { at: 0, side: '' }; return; }
    lastTap = { at: now, side };
    tapTimer = window.setTimeout(() => {
      tapTimer = 0;
      if (wasShown && !paused && !waiting && !error) hide(); else poke();
    }, 250);
  }

  function onKey(e: KeyboardEvent) {
    if (e.target !== player || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    // Tab from the container into a hidden bar (validator V3): the bar is
    // shown — inert lifted — BEFORE the browser moves focus, so Tab lands on
    // its first control instead of leaving the player.
    if (e.key === 'Tab') { if (!e.shiftKey && !shown) { flushSync(() => { shown = true; }); poke(); } return; }
    if (e.key === ' ' || e.key === 'k') toggle();
    else if (e.key === 'ArrowLeft') seekBy(-5);
    else if (e.key === 'ArrowRight') seekBy(5);
    else if (e.key === 'm') toggleMute();
    else if (e.key === 'f' && fsOk) toggleFs();
    else return;
    e.preventDefault(); poke();
  }
  const stop = (e: Event) => e.stopPropagation();

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  // A menu belongs to the life it was opened in: a choice made after that
  // life ended (hide, another file) does nothing to the media now here.
  const moreItems = $derived.by(() => {
    const at = life, ours = (f: () => void) => () => { if (at === life && live()) f(); };
    return [
      ...RATES.map((r) => ({ label: t('mediaSpeed').replace('{rate}', String(r)), checked: rate === r, onselect: ours(() => { if (mediaEl) mediaEl.playbackRate = r; }) })),
      ...(narrow && pipOk ? [{ label: t('mediaPip'), icon: 'pip', onselect: ours(togglePip) }] : []),
      ...(narrow && fsOk ? [{ label: t(fsOn ? 'mediaExitFullscreen' : 'mediaFullscreen'), icon: fsOn ? 'minimize' : 'maximize', onselect: ours(toggleFs) }] : []),
    ];
  });
  const media = {
    // Blink clears the show-poster flag where it fires `play` (PlayInternal)
    // and `seeking` (Seek step 1); a play() the browser refuses fires neither.
    onplay: () => { paused = false; posterCleared = true; settleFrame(); }, onpause: () => { paused = true; }, onended: () => { paused = true; },
    onwaiting: () => { waiting = true; }, onseeking: () => { waiting = true; posterCleared = true; readTimes(); settleFrame(); },
    onplaying: () => { waiting = false; error = null; settleFrame(); }, onseeked: () => { waiting = false; readTimes(); settleFrame(); },
    oncanplay: () => { waiting = false; settleFrame(); },
    ontimeupdate: readTimes, ondurationchange: readTimes, onprogress: readTimes,
    onloadedmetadata: () => {
      readTimes();
      const v = mediaEl as HTMLVideoElement | null;
      if (v?.videoWidth && v.videoHeight) aspect = v.videoWidth / v.videoHeight;
    },
    onloadeddata: settleFrame,
    // A new load: the old source's state, its error included, is gone
    // (`loadstart` comes from the resource selection that sets the
    // show-poster flag again).
    onloadstart: newLoad,
    onemptied: () => { reset(); paused = true; error = null; newLoad(); },
    onerror: () => {
      const code = mediaEl?.error?.code, unplayable = errorKind(code) === 'unplayable';
      error = { text: t(unplayable ? 'mediaUnplayable' : 'mediaFailed'), unplayable, network: code === 2 };
      waiting = false;
    },
    onvolumechange: () => { muted = !!mediaEl?.muted; }, onratechange: () => { rate = mediaEl?.playbackRate ?? 1; },
    onenterpictureinpicture: () => { pipOn = true; }, onleavepictureinpicture: () => { pipOn = false; },
  };
</script>

<svelte:document onfullscreenchange={() => { fsOn = !!player && document.fullscreenElement === player; }} />

<!-- The container is focusable so the player's keys have a home (and Tab
     reaches the bar through it); its keys act only when it is the target,
     never for a child control. A role=group with a tab stop is the player's
     own composite, so the noninteractive-tabindex lint does not apply. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="media-player {kind}" bind:this={player} bind:clientWidth={width} tabindex="0" role="group" aria-label={name || t('mediaPlayer')}
  onkeydown={onKey} onfocusin={poke}
  onfocusout={(e) => { if (!player?.contains(e.relatedTarget as Node | null)) { cancelGesture(); poke(); } }}
  onpointermove={(e) => { if (e.pointerType === 'mouse') poke(); }}>
  {#if kind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={mediaEl} playsinline preload="metadata" src={ownSrc ?? src} {...media}
      poster={isAndroid ? BLANK_POSTER : undefined}
      onpointerdown={(e) => { down = live() ? { x: e.clientX, y: e.clientY, shown } : null; }} onpointerup={onPictureUp}></video>
    <!-- Until the picture is on screen, OUR placeholder (board #470): the
         .skel atom in the picture's aspect, centred where the frame will
         land, invisible for its first 150ms (.skel-wrap, motion.md 15).
         Three states (review P1): LOADING shimmers, nothing else; READY to
         play but not yet showing its frame (the Android app's poster flag,
         until play) is still, with the one small play glyph; an ERROR is
         still with no glyph, and the bar says what failed. Taps go through. -->
    {#if !framed}
      <div class="mp-ph skel-wrap" aria-hidden="true" style:--mp-aspect={aspect}>
        <span class="skel mp-ph-tile" class:still={hasData || !!error}>
          {#if hasData && !error}<span class="mp-ph-play"><Icon name="play" /></span>{/if}
        </span>
      </div>
    {/if}
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <audio bind:this={mediaEl} preload="metadata" src={ownSrc ?? src} {...media}></audio>
  {/if}
  <!-- The bar's pointer/touch/click handlers STOP propagation, so nothing in
       it reaches the picture or Files' edge swipe; a press on it also
       restarts the auto-hide countdown (using the bar is activity). -->
  <!-- A toolbar whose buttons are each in the Tab order (no roving focus), so
       the bar itself takes no tab stop. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="mp-bar" bind:this={bar} role="toolbar" aria-label={t('mediaControls')} class:narrow class:hidden={!shown} inert={!shown}
    onpointerdown={(e) => { stop(e); poke(); }} onpointerup={stop} onclick={stop} ontouchstart={stop} ontouchmove={stop}
    onpointerenter={() => { pointerOver = true; }} onpointerleave={() => { pointerOver = false; poke(); }}>
    <div class="mp-row">
      <CommandButton variant="icon" icon={playing ? 'pause' : 'play'} label={t(playing ? 'mediaPause' : 'mediaPlay')}
        disabled={!!error?.unplayable} onclick={toggle} />
      <span class="mp-time"><span>{posText}{' '}</span><span>/ {fmtTime(duration)}</span></span>
      {#if !narrow}{@render range()}{/if}
      <CommandButton variant="icon" icon={muted ? 'volume-off' : 'volume'} label={t(muted ? 'mediaUnmute' : 'mediaMute')} onclick={toggleMute} />
      {#if !narrow && pipOk}<CommandButton variant="icon" icon="pip" label={t('mediaPip')} pressed={pipOn} onclick={togglePip} />{/if}
      {#if !narrow && fsOk}<CommandButton variant="icon" icon={fsOn ? 'minimize' : 'maximize'} label={t(fsOn ? 'mediaExitFullscreen' : 'mediaFullscreen')} onclick={toggleFs} />{/if}
      <CommandButton variant="icon" icon="dots" label={t('mediaMore')} hasPopup="menu" expanded={!!menuAt}
        onclick={(e) => { if (!live()) return; menuAt = menuAt ? null : { anchor: anchorOf(e.currentTarget as Element), align: 'left', trigger: e.currentTarget }; }} />
    </div>
    {#if narrow}<div class="mp-row">{@render range()}</div>{/if}
    {#if error}<p class="mp-error" role="status">{error.text}</p>{/if}
  </div>
  <ContextMenu at={menuAt} items={moreItems} oncancel={() => { menuAt = null; poke(); }} />
</div>

{#snippet range()}
  <MediaRange value={win ? shownTime : 0} max={win?.hi ?? 0} disabled={!win || !!error?.unplayable} waiting={waiting && !paused}
    label={t('mediaSeek')} valuetext={t('mediaOf').replace('{a}', posText).replace('{b}', fmtTime(duration))}
    {buffered} epoch={gesture} onpreview={onPreview} oncommit={onCommit} oncancel={onCancel} />
{/snippet}

<style>
  .media-player { position: relative; display: flex; flex-direction: column; justify-content: center; width: 100%; max-height: 100%; outline: none; }
  .media-player.video { align-self: stretch; flex: 1; min-height: 0; }
  video { flex: 1; min-height: 0; width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; background: var(--bg); }
  /* The placeholder covers the video's box (the bar is absolute, so the
     video IS the player's box) and fits the picture's aspect in it the way
     object-fit: contain fits the frame. */
  .mp-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; container-type: size; pointer-events: none; }
  .mp-ph-tile { display: flex; align-items: center; justify-content: center; width: min(100cqw, calc(100cqh * var(--mp-aspect))); aspect-ratio: var(--mp-aspect); }
  .mp-ph-tile.still::after { content: none; }
  .mp-ph-play { display: flex; color: var(--text3); }
  .mp-bar {
    display: flex; flex-direction: column; gap: var(--tool-gap); padding: var(--ui-gap) calc(2 * var(--ui-gap));
    border-radius: var(--ui-radius-row); background: var(--surface2);
    /* Showing is instant for `visibility` (only the fade plays), so a control
       is focusable the moment the bar shows — Tab into a hidden bar lands on
       it (validator V3); hiding keeps it visible until the fade ends. */
    transition: opacity var(--t-fast), visibility 0s;
    /* A sideways drag from the bar is no browser history swipe (Chrome's
       overscroll back fired from the Play button on the rig); vertical stays. */
    touch-action: pan-y;
  }
  .video .mp-bar { position: absolute; left: calc(2 * var(--ui-gap)); right: calc(2 * var(--ui-gap)); bottom: calc(2 * var(--ui-gap)); background: color-mix(in srgb, var(--bg) 82%, transparent); }
  .mp-bar.hidden { opacity: 0; visibility: hidden; transition: opacity var(--t-fast), visibility 0s var(--t-fast); }
  .mp-row { display: flex; align-items: center; gap: var(--ui-gap); min-width: 0; }
  .mp-time { flex: none; padding: 0 var(--ui-gap); color: var(--text2); font: var(--fs-ui)/var(--control-line-height) var(--font-mono); font-variant-numeric: tabular-nums; white-space: pre; }
  /* Narrow, the time yields first: one line that wraps the "/ duration" part
     away (hidden) when the row has no room for it, so the 44px controls never
     leave the bar (rig: 347px at uiZoom 1.2 pushed More 30px out). */
  .narrow .mp-time { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; height: var(--control-line-height); overflow: hidden; }
  .mp-error { margin: 0; padding: 0 var(--ui-gap) var(--ui-gap); color: var(--danger-ink); font: var(--fs-ui)/1.4 var(--font-display); }
  .media-player:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .mp-bar, .mp-bar.hidden { transition: none; } }
</style>
