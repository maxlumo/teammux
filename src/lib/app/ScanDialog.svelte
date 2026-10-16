<script lang="ts">
  // Scan a connection QR code in the browser or the PWA (board #403), in the
  // app's one modal shell. It opens only after the person tapped "Scan QR", so
  // the camera is never started unasked. It tells the person what the camera is
  // for BEFORE the browser asks, shows the live view, and always offers a photo:
  // a photo works on a plain-http page and with the camera refused. It hands back
  // the decoded TEXT and nothing else; the host decides what that text means and
  // never connects by itself. Nothing is recorded, stored, logged or sent.
  import { onDestroy } from 'svelte';
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { decodePhoto, openCamera, type Camera, type Frame } from '../core/qr-scan.ts';

  let {
    compact = false, onscanned, oncancel,
    /** The camera and the photo reader are parameters so a test (or another
     * platform) can stand in for them. */
    camera = openCamera,
    toFrame = undefined,
  }: {
    compact?: boolean; onscanned: (text: string) => void; oncancel: () => void;
    camera?: (video: HTMLVideoElement) => Promise<Camera>;
    toFrame?: ((file: Blob) => Promise<Frame>) | undefined;
  } = $props();

  let video = $state<HTMLVideoElement>();
  let picker = $state<HTMLInputElement>();
  let status = $state<'starting' | 'live' | 'unavailable'>('starting');
  let problem = $state('');
  let photoNote = $state('');
  let active: Camera | null = null;
  let frame = 0;
  let stopped = false;

  const REASONS = { insecure: 'scanInsecure', none: 'scanNoCamera', denied: 'scanDenied', failed: 'scanFailed' } as const;

  function release() {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    active?.stop();
    active = null;
  }
  function done(text: string) {
    release();
    onscanned(text);
  }

  // Started once the video element exists, i.e. right after the tap that opened
  // this dialog. A failure is a state of the dialog, never an error thrown at it.
  $effect(() => {
    const el = video;
    if (!el || active || stopped) return;
    camera(el).then((opened) => {
      if (stopped) { opened.stop(); return; }
      active = opened;
      status = 'live';
      // Every third animation frame (about 20 reads a second): a read draws and
      // decodes a frame, and the next code is not going anywhere.
      let n = 0;
      const tick = () => {
        if (stopped) return;
        if (n++ % 3 === 0) {
          const text = opened.readFrame();
          if (text) { done(text); return; }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }).catch((error) => {
      status = 'unavailable';
      // Read by its `reason` rather than by class: the camera is a parameter, and
      // anything that says why is understood.
      const reason = (error as { reason?: string } | null)?.reason ?? '';
      problem = t(REASONS[(reason in REASONS ? reason : 'failed') as keyof typeof REASONS]);
    });
  });
  onDestroy(release);

  async function chosen() {
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
  <div class="scan-view" class:off={status === 'unavailable'}>
    <video bind:this={video} playsinline muted></video>
  </div>
  <p class="dlg-note scan-status" role="status">
    {#if status === 'starting'}{t('scanStarting')}{:else if status === 'live'}{t('scanLook')}{:else}{problem}{/if}
  </p>
  {#if photoNote}<div class="config-error appear" role="alert">{photoNote}</div>{/if}
  <input bind:this={picker} class="scan-file" type="file" accept="image/*" capture="environment" onchange={chosen} tabindex="-1" aria-hidden="true" />
  <div class="dlg-actions">
    <CommandButton label={t('cancel')} onclick={oncancel} />
    <CommandButton label={t('scanPhoto')} icon="image" variant="primary" onclick={() => picker?.click()} />
  </div>
</Dialog>

<style>
  .scan-view { width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--ui-radius-control); background: var(--bg3); }
  .scan-view.off { display: none; }
  .scan-view video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .scan-file { display: none; }
</style>
