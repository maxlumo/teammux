<script lang="ts">
  // Board #144: an agent's path found in SEVERAL places; the person picks which (owner: "如果匹配到
  // 多个，就显示一个选项卡，让人二次选择匹配到的路径"). The one Dialog; rows are project-relative paths,
  // nearest first; Enter or a tap picks, dismissing opens nothing (today's not-found).
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import type { PathFind } from './path-find.svelte.ts';

  let { finder, compact = false }: { finder: PathFind; compact?: boolean } = $props();
</script>

{#if finder.choices}
  <Dialog {compact} label={t('fileFindTitle')} oncancel={() => finder.dismiss()}>
    <h2>{t('fileFindTitle')}</h2>
    <div class="choices" role="list">
      {#each finder.choices.shown as rel, i (rel)}
        <div role="listitem"><CommandButton label={rel} wrap onclick={() => finder.pick(i)} /></div>
      {/each}
    </div>
    <!-- Independent facts (#144 note 24): the search stopped early, and known matches are not shown. -->
    {#if finder.choices.stopped}<p class="dlg-note">{t(finder.choices.stopped === 'unreadable' ? 'fileFindUnreadable' : 'fileFindStopped')}</p>{/if}
    {#if finder.choices.more}<p class="dlg-note">{t('fileFindMore')}</p>{/if}
  </Dialog>
{/if}

<style>
  .choices { display: flex; flex-direction: column; gap: var(--ui-gap); }
  .choices :global(.command-button) { width: 100%; justify-content: flex-start; font-family: var(--font-mono); }
</style>
