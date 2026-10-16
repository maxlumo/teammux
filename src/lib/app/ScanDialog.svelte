<script lang="ts">
  // Scan a connection QR code in the browser or the PWA (board #403), in the
  // app's one modal shell. It opens only after the person tapped "Scan QR", so
  // the camera is never started unasked. It tells the person what the camera is
  // for BEFORE the browser asks, shows the live view, and always offers a photo:
  // a plain file picker of an EXISTING image (no `capture`: on wry that routes to
  // the camera branch, which needs the permission the person may have refused, and
  // opens the camera instead of the gallery). It works on a plain-http page and
  // with the camera refused, and choosing it lets the camera go first. It hands back
  // the decoded TEXT and nothing else; the host decides what that text means and
  // never connects by itself. Nothing is recorded, stored, logged or sent.
  import { onDestroy } from 'svelte';
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { decodePhoto, openCamera, type Camera, type Frame } from '../core/qr-scan.ts';
  import { isAndroid } from '../core/platform.ts';

  let {
    compact = false, onscanned, oncancel, onpicking = () => {},
    /** The camera and the photo reader are parameters so a test (or another
     * platform) can stand in for them. */
    camera = openCamera,
    toFrame = undefined,
  }: {
    compact?: boolean; onscanned: (text: string) => void; oncancel: () => void;
    /** Told when a photo picker this dialog opened is up (true) or has returned
     * (false): the host does not end the scan because the page was hidden for it. */
    onpicking?: (on: boolean) => void;
    camera?: (video: HTMLVideoElement, signal: AbortSignal) => Promise<Camera>;
    toFrame?: ((file: Blob) => Promise<Frame>) | undefined;
  } = $props();

  let video = $state<HTMLVideoElement>();
  let picker = $state<HTMLInputElement>();
  let status = $state<'starting' | 'live' | 'unavailable' | 'photo'>('starting');
  let problem = $state('');
  let photoNote = $state('');
  let active: Camera | null = null;
  let frame = 0;
  let stopped = false;                 // the dialog is closed or has its answer
  let cameraOff = false;               // the camera was let go for the photo picker
  /** The dialog's lifetime, handed to the camera so that closing it stops the
   * stream even while the camera is still opening. */
  const lifetime = new AbortController();

  const REASONS = { insecure: 'scanInsecure', none: 'scanNoCamera', denied: isAndroid ? 'scanDeniedAndroid' : 'scanDenied', failed: 'scanFailed' } as const;

  /** Let the camera go: abort its lifetime (so a request still pending stops the
   * stream that arrives later), stop the frame loop, stop what is open. */
  function releaseCamera() {
    cameraOff = true;
    lifetime.abort();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    active?.stop();
    active = null;
  }
  function release() {
    stopped = true;
    releaseCamera();
  }
  function done(text: string) {
    release();
    onscanned(text);
  }

  // Started once the video element exists, i.e. right after the tap that opened
  // this dialog. A failure is a state of the dialog, never an error thrown at it.
  $effect(() => {
    const el = video;
    if (!el || active || stopped || cameraOff) return;
    camera(el, lifetime.signal).then((opened) => {
      if (stopped || cameraOff) { opened.stop(); return; }
      active = opened;
      status = 'live';
      // Every third animation frame (about 20 reads a second): a read draws and
      // decodes a frame, and the next code is not going anywhere.
      let n = 0;
      const tick = () => {
        if (n++ % 3 === 0) {
          const text = opened.readFrame();
          if (text) { done(text); return; }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }).catch((error) => {
      if (stopped || cameraOff) return;         // closed, or let go for the picker: nothing to report
      status = 'unavailable';
      // Read by its `reason` rather than by class: the camera is a parameter, and
      // anything that says why is understood.
      const reason = (error as { reason?: string } | null)?.reason ?? '';
      problem = t(REASONS[(reason in REASONS ? reason : 'failed') as keyof typeof REASONS]);
    });
  });
  onDestroy(release);

  /** The photo command is its own state within the scan: the camera is let go and
   * its frame loop stopped BEFORE the picker takes over (the picker is an Activity
   * that may cover this page), and the host is told the picker is ours. */
  function pickPhoto() {
    releaseCamera();
    status = 'photo';
    photoNote = '';
    onpicking(true);
    picker?.click();
  }
  async function chosen() {
    onpicking(false);
    const file = picker?.files?.[0];
    if (picker) picker.value = '';                 // the same photo can be chosen again
    if (!file) return;
    photoNote = '';
    const text = await decodePhoto(file, toFrame);
    if (stopped) return;
    if (text) done(text); else photoNote = t('scanPhotoNone');
  }
</script>

<Dialog {compact} label={t('scanQr')} {oncancel}>
  <h2>{t('scanQr')}</h2>
  <p class="dlg-note">{t('scanReason')}</p>
  <div class="scan-view" class:off={status === 'unavailable' || status === 'photo'}>
    <video bind:this={video} playsinline muted></video>
  </div>
  <p class="dlg-note scan-status" role="status">
    {#if status === 'starting'}{t('scanStarting')}{:else if status === 'live'}{t('scanLook')}{:else if status === 'photo'}{t('scanPhotoWaiting')}{:else}{problem}{/if}
  </p>
  {#if photoNote}<div class="config-error appear" role="alert">{photoNote}</div>{/if}
  <input bind:this={picker} class="scan-file" type="file" accept="image/*" onchange={chosen} oncancel={() => onpicking(false)} tabindex="-1" aria-hidden="true" />
  <div class="dlg-actions">
    <CommandButton label={t('cancel')} onclick={oncancel} />
    <CommandButton label={t('scanPhoto')} icon="image" variant="primary" onclick={pickPhoto} />
  </div>
</Dialog>

<style>
  .scan-view { width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--ui-radius-control); background: var(--bg3); }
  .scan-view.off { display: none; }
  .scan-view video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .scan-file { display: none; }
</style>
