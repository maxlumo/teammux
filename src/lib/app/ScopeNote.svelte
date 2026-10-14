<script lang="ts" module>
export interface ScopeNoteSpec {
  /** The server being shown. */
  name: string;
  /** How many other servers are saved. */
  others: number;
  /** Open the server picker, anchored to the row. */
  onopen: (e: MouseEvent) => void;
  expanded?: boolean;
  controls?: string;
}
</script>

<script lang="ts">
  // One server shown while others are saved (board #364). In Single mode a
  // sidebar lists the focused server's rows and nothing else, which read on a
  // phone as "the other machine's projects are missing" (owner 2026-10-14
  // 08:27). The list is right; its silence was not: this foot row names the
  // server being shown and how many more are saved, and opens the one server
  // picker (App's), where another can be chosen. Aggregate says the same
  // thing differently — every included server's rows, a tag on each, and a
  // "no list yet" row for one that has not answered — so the host hands
  // `null` there and this renders nothing.
  //
  // The row is the sidebars' existing quiet command row (`.side-row.add`),
  // the slot is the one the union's missing rows use (after the list).
  import Icon from '../ui/Icon.svelte';
  import { t } from '../core/i18n.svelte.ts';

  let { note = null }: { note?: ScopeNoteSpec | null } = $props();
</script>

{#if note}
  <button type="button" class="side-row add scope-note" aria-haspopup="dialog" aria-expanded={!!note.expanded}
    aria-controls={note.expanded ? note.controls : undefined}
    onclick={(e) => note.onopen(e)}>
    <Icon name="swap-h" size={13} />
    <span class="scope-note-text">{t('scopeNoteSingle').replace('{name}', note.name).replace('{n}', String(note.others))}</span>
  </button>
{/if}

<style>
  .scope-note :global(svg) { flex: none; }
  .scope-note-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
