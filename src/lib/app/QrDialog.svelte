<script lang="ts">
  // The connection QR code (board #403), in the app's one modal shell. It is
  // shown only after an explicit tap, because the code carries the token, and
  // it never holds the link: the host passes the MODULES, builds nothing here,
  // and drops them when the dialog closes. The code is dark on light in every
  // theme (--qr-ink / --qr-paper; see design-language.md): a scanner reads
  // dark modules on a light ground and an inverted code fails on many.
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { QR_QUIET, qrPath } from '../core/qr.ts';

  let { matrix, compact = false, oncancel }: { matrix: boolean[][]; compact?: boolean; oncancel: () => void } = $props();

  const size = $derived(matrix.length + 2 * QR_QUIET);
  const path = $derived(qrPath(matrix));
</script>

<Dialog {compact} label={t('qrTitle')} {oncancel}>
  <h2>{t('qrTitle')}</h2>
  <svg class="qr" viewBox="0 0 {size} {size}" role="img" aria-label={t('qrTitle')} shape-rendering="crispEdges">
    <rect class="paper" width={size} height={size} />
    <path class="ink" d={path} transform="translate({QR_QUIET} {QR_QUIET})" />
  </svg>
  <p class="dlg-note">{t('qrNote')}</p>
  <div class="dlg-actions">
    <CommandButton label={t('qrHide')} variant="primary" onclick={oncancel} />
  </div>
</Dialog>

<style>
  .qr { display: block; width: 100%; max-width: 22em; aspect-ratio: 1; margin: 0 auto; border-radius: var(--ui-radius-control); }
  .qr .paper { fill: var(--qr-paper); }
  .qr .ink { fill: var(--qr-ink); }
</style>
