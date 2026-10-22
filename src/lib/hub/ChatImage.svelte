<script>
  // An image a chat message REFERENCED. The message carries a path or a URL,
  // never bytes — the room is a log, so resolving the reference is the client's
  // job and happens here, once per src:
  //   http(s)/data/blob → straight into <img>.
  //   anything else     → a path on the server's machine, fetched through the
  //                       same signed /dl endpoint the file browser uses, so a
  //                       50 MB screenshot streams instead of arriving base64'd
  //                       through the RPC channel.
  // The signature on that URL dies after 60 s (download.rs DL_TOKEN_TTL_SECS),
  // so it belongs to the FETCH, not to the render (board #175, owner
  // 2026-09-11: every older image in the room wore the amber failed chip —
  // the URL was minted when the message rendered, the lazy <img> fetched it
  // minutes later, 403). Three rules follow: the signature is minted when the
  // image NEARS the viewport (an IntersectionObserver, ~one screen ahead —
  // it IS the laziness, so the <img> is not `loading="lazy"` on top); a load
  // error re-signs exactly once before the reference is declared failed (the
  // same re-sign-on-retry rule Files' downloads use, never a loop); and the
  // viewer is handed a URL signed at the moment of the tap, never the
  // thumbnail's. A failed load falls back to showing the reference itself,
  // which is still information ("it sent /tmp/x.png").
  import { isDirectUrl } from './hub.ts';
  import { useServerApi } from '../app/server-context.ts';

  // `onviewstart` (optional, board #329): called at the TAP, before the
  // signature is minted; whatever it returns is handed back with the URL, so
  // the host can tell this tap's answer from a later one's. The answer also
  // carries the REFERENCE taken at the same tap (board #447): the viewer shows
  // the URL and, if it offers a download, saves that reference's file — the two
  // are one record and cannot be completed from anything read later. A direct
  // URL (http, data, blob) has no server file: its reference is null.
  let { src = '', alt = '', onview = null, onviewstart = null } = $props();
  // The server this image's reference is signed by: the subtree's (board
  // #335 ②b-3), read once at init.
  const { fsDownloadHttp } = useServerApi();

  let url = $state('');
  let failed = $state(false);
  /** The image is about to be fetched (near the viewport, or no observer
   * exists to tell us — then now is the fetch). */
  let near = $state(false);
  /** One re-sign per src: a second error is the file, not the signature. */
  let resigned = false;
  // The picture fades in once its bytes are there (motion.md: an image that
  // pops from blank to painted is a cut the eye notices). `onload` sets it; a
  // CACHED image can be complete before the handler is wired, so the effect
  // below reads `complete` too. Reset per src.
  let loaded = $state(false);
  let imgEl = $state(null);
  let hostEl = $state(null);
  $effect(() => {
    if (imgEl?.complete && imgEl.naturalWidth > 0) loaded = true;
  });

  /** The ONE resolver: a direct URL is itself, anything else is signed NOW. */
  const resolve = (ref) => (isDirectUrl(ref) ? Promise.resolve(ref) : fsDownloadHttp(ref).then((info) => info.url));

  // Per src: forget everything, and let a direct URL through at once — it
  // carries no signature that could age.
  $effect(() => {
    const ref = src;
    failed = false;
    loaded = false;
    resigned = false;
    near = false;
    url = ref && isDirectUrl(ref) ? ref : '';
  });

  // Nearing the viewport is what starts the fetch. Without an observer
  // (an old engine) the fetch starts at once — the pre-#175 behaviour.
  $effect(() => {
    const el = hostEl;
    if (!el || url || failed) return;
    if (typeof IntersectionObserver === 'undefined') { near = true; return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { near = true; io.disconnect(); }
    }, { rootMargin: '100% 0px' });
    io.observe(el);
    return () => io.disconnect();
  });

  // Sign when the fetch is about to happen; `url = ''` after an error runs
  // this again (the one re-sign).
  $effect(() => {
    const ref = src;
    if (!ref || !near || url || failed) return;
    let live = true;
    resolve(ref)
      .then((u) => { if (live) url = u; })
      .catch(() => { if (live) failed = true; });
    return () => { live = false; };
  });

  function onError() {
    if (resigned) { failed = true; return; }
    resigned = true;
    url = '';
  }

  /** The viewer opens what the server signs NOW — a thumbnail viewed five
   * minutes later would otherwise open a 403. */
  function view() {
    const ref = src;
    const claim = onviewstart?.();
    resolve(ref).then((u) => onview?.(u, claim, isDirectUrl(ref) ? null : ref)).catch(() => { failed = true; });
  }
</script>

<!-- The reference, named: grey while the picture is on its way, warn-coloured
     when it could not be fetched. -->
{#snippet ref()}<span class="ci-ref" class:failed>{src}</span>{/snippet}
{#if src && !failed}
  <!-- The host mounts before the url exists: it is what the observer watches,
       it names the reference (grey) until the picture arrives, and the <img>
       replaces that name once the signature is minted. -->
  {#if onview}
    <!-- With an in-app viewer there is NO link at all: any anchor to a /dl
         URL leaves a path where a tap navigates or downloads (owner,
         2026-08-27: "注意图片查看是在我应用内的，不是说我点击图片去下载了一个
         图片"). The button can only open the Lightbox. -->
    <button class="ci-link" aria-label={alt || 'image'} bind:this={hostEl} onclick={view}>
      {#if url}<img class="ci" class:loaded {alt} src={url} bind:this={imgEl} onload={() => loaded = true} onerror={onError} />{:else}{@render ref()}{/if}
    </button>
  {:else}
    <a class="ci-link" href={url || undefined} target="_blank" rel="noopener" bind:this={hostEl}>
      {#if url}<img class="ci" class:loaded {alt} src={url} bind:this={imgEl} onload={() => loaded = true} onerror={onError} />{:else}{@render ref()}{/if}
    </a>
  {/if}
{:else}
  <!-- Unresolvable: name what was referenced instead of showing nothing. -->
  {@render ref()}
{/if}

<style>
  .ci-link { display: block; padding: 0; margin: 0; border: 0; background: none; text-align: left; }
  .ci {
    /* A THUMBNAIL by default (owner, 2026-08-27: "消息框里显示的图片，默认使用
       较小尺寸的缩略图，我可以点击放大查看" — the old 42vh cap let one screenshot
       take half the conversation); the Lightbox is where it gets big. */
    display: block; max-width: min(100%, 300px); max-height: 180px; width: auto; height: auto;
    border-radius: var(--ui-radius-control); border: 1px solid var(--border2); background: var(--surface2);
    cursor: zoom-in;
    /* Fades in when loaded — opacity only, the box is already its size. */
    opacity: 0; transition: opacity var(--t-move) ease-out;
  }
  .ci.loaded { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .ci { transition: none; } }
  .ci-ref {
    display: inline-block; font-family: var(--font-mono); font-size: var(--fs-sub);
    color: var(--text3); border: 1px dashed var(--border); border-radius: 7px; padding: 4px 8px;
    max-width: 100%; overflow-wrap: anywhere;
    transition: color var(--t-fast), border-color var(--t-fast);
  }
  .ci-ref.failed { color: var(--status-warn); border-color: var(--status-warn); }
</style>
