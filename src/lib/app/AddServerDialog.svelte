<script lang="ts">
  // Add server (board 315): the connect fields in the app's dialog shape —
  // `ui/Dialog` since #317, so the shape, Escape, the Tab trap and the focus
  // restore are the app's one copy — opened INSIDE the connected shell. You
  // are still connected while it is open: opening and cancelling write
  // nothing and leave the current server live, and the background follows the
  // modal rules (activeModal owns the keyboard, the scrim takes the pointer).
  // Submitting hands the candidate to the ONE switch path; a failure is
  // reported there, in place, with Retry · Back · Edit (Edit reopens this
  // dialog prefilled).
  import { untrack } from 'svelte';
  import ConnectFields from './ConnectFields.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { normalizeAddress } from '../core/connection-address.ts';

  type Candidate = { address: string; token: string; socket?: string };
  let {
    initial = null, compact = false, onsubmit, oncancel, onscan = null,
  }: { initial?: Candidate | null; compact?: boolean; onsubmit: (c: Candidate) => void; oncancel: () => void; onscan?: ((signal: AbortSignal) => Promise<string | null>) | null } = $props();

  // The dialog is mounted per opening, so the prefill is read once on purpose.
  const seed = untrack(() => initial);
  let address = $state(seed?.address ?? '');
  let token = $state(seed?.token ?? '');
  let socket = $state(seed?.socket ?? '');

  let fields = $state<{ commit(): boolean }>();

  function submit() {
    // The form's own gate: a typed link is split (or refused) before any field is read.
    if (fields && !fields.commit()) return;
    if (!address.trim()) return;
    onsubmit({ address: normalizeAddress(address, location.protocol), token, ...(socket.trim() ? { socket: socket.trim() } : {}) });
  }
</script>

<Dialog {compact} label={t('serverAdd')} {oncancel}>
  <h2>{t('serverAdd')}</h2>
  <ConnectFields bind:this={fields} bind:address bind:token bind:socket autofocus onscan={onscan} onenter={submit} />
  <div class="dlg-actions">
    <CommandButton label={t('cancel')} onclick={oncancel} />
    <CommandButton label={t('connect')} variant="primary" icon="link" disabled={!address.trim()} onclick={submit} />
  </div>
</Dialog>
