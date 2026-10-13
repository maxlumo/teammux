<script lang="ts">
  // The notification centre's list (board #322) — ONE component, opened from
  // the rail bell (desktop) or the Hub header (phone), in the app's one
  // popover dialect (menu-surface/menu-list/pop-layer, menuPlacement, the
  // server picker's dismissal). Each row names the project, who, a line and
  // when; tapping it asks the Hub to open THAT message. Default view All, so
  // every cue has a visible row; To me narrows to replies addressed to you.
  //
  // Since board #335 ③c-4 the list is the included servers' UNION
  // (`app/centre-union.svelte.ts`): a row carries its server's tag when more
  // than one is included, a row whose server cannot be reached is shown
  // muted and named in the foot, and Clear clears only the reachable lists
  // (D6) — the button is offered only when there is something it would clear.
  import Segmented from '../ui/Segmented.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import ServerTag from '../ui/ServerTag.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { agentHue, localWhen } from './hub.ts';
  import type { Alert } from './notify-centre.svelte.ts';
  import type { CentreUnion } from '../app/centre-union.svelte.ts';

  // The shell renders this popover, outside any server's subtree, so it is
  // handed the window's union rather than reading a scope (②b-2-1, ③c-4).
  let { centre, onpick = (_a: Alert) => {} }: { centre: CentreUnion; onpick?: (a: Alert) => void } = $props();
  let view = $state<'all' | 'me'>('all');
  const shown = $derived(view === 'me' ? centre.items.filter((a) => a.toHuman) : centre.items);
  const unavailable = $derived(centre.sources.filter((s) => !s.available && (s.log?.items.length ?? 0) > 0));
  const when = (ms: number) => localWhen(Math.floor(ms / 1000));
</script>

<div class="menu-heading nc-head">
  <span>{t('notifyCentre')}</span>
  <Segmented options={[{ value: 'all', label: t('notifyCentreAll') }, { value: 'me', label: t('notifyCentreToMe') }]}
    value={view} onchange={(v) => (view = v)} ariaLabel={t('notifyCentre')} />
</div>
{#if shown.length}
  <ul class="nc-list">
    {#each shown as a (`${a.server}|${a.key}`)}
      <li>
        <button type="button" class="menu-item nc-row" class:fresh={!a.viewed} class:unavailable={a.unavailable} data-server={a.server} onclick={() => onpick(a)}>
          <span class="nc-top">
            {#if !a.viewed}<span class="unread-dot" aria-hidden="true"></span>{/if}
            <span class="nc-project">{a.project}</span>
            <ServerTag name={a.tag} />
            <span class="nc-who" class:me={a.toHuman} style:--who-ink={agentHue(a.from)}>{a.from}</span>
            {#if a.toHuman}<span class="nc-tag">{t('notifyCentreToYou')}</span>{/if}
            <span class="nc-time">{when(a.ts)}</span>
          </span>
          <span class="nc-text">{a.excerpt}</span>
          {#if a.failed}<span class="nc-fail">{a.failed}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <div class="nc-empty">{t('notifyCentreEmpty')}</div>
{/if}
<div class="nc-foot">
  <span class="nc-limit">
    {centre.sources.length > 1 ? t('notifyCentreLimitMany') : t('notifyCentreLimit')}
    {#each unavailable as s (s.serverId)}<span class="nc-unavailable" role="note">{t('notifyCentreUnavailable').replace('{name}', s.name)}</span>{/each}
  </span>
  {#if centre.clearable}<CommandButton variant="secondary" label={t('notifyCentreClear')} onclick={() => centre.clear()} />{/if}
</div>

<style>
  .nc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .nc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .nc-row { display: flex; flex-direction: column; align-items: stretch; gap: 2px; width: 100%; text-align: left; }
  .nc-row.unavailable { opacity: var(--muted-opacity, 0.6); }
  .nc-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .nc-project { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nc-who { color: var(--who-ink); white-space: nowrap; }
  .nc-who.me { font-weight: 650; }
  .nc-tag { font-size: var(--fs-micro); color: var(--accent-ink); }
  .nc-time { margin-left: auto; flex: none; font-size: var(--fs-meta); color: var(--text3); font-variant-numeric: tabular-nums; }
  .nc-text { color: var(--text2); font-size: var(--fs-meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nc-row:not(.fresh) .nc-project { font-weight: 500; }
  .nc-fail { font-size: var(--fs-micro); color: var(--status-warn); }
  .nc-empty { padding: 16px 10px; color: var(--text3); font-size: var(--fs-meta); text-align: center; }
  .nc-foot { display: flex; align-items: center; gap: 8px; padding: 6px 4px 2px; border-top: 1px solid var(--border); margin-top: 4px; }
  .nc-limit { flex: 1; font-size: var(--fs-micro); color: var(--text3); display: flex; flex-direction: column; gap: 2px; }
  .nc-unavailable { color: var(--text3); }
</style>
