<script lang="ts">
  // The Android scan's own words (board #403): the camera preview is drawn by
  // the native plugin BEHIND this transparent page, so all the page owes the
  // person is what it is looking for, and a way out. The shell's one Dialog,
  // undimmed so the preview stays what it is.
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';

  let { compact = true, oncancel }: { compact?: boolean; oncancel: () => void } = $props();
</script>

<Dialog {compact} scrim={false} label={t('scanQr')} {oncancel}>
  <h2>{t('scanQr')}</h2>
  <p class="dlg-note">{t('scanLook')}</p>
  <div class="dlg-actions">
    <CommandButton label={t('cancel')} onclick={oncancel} />
  </div>
</Dialog>
