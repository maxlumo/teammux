<script lang="ts">
  import SideHandle from '../ui/SideHandle.svelte';
  import Icon from '../ui/Icon.svelte';
  import { scrollFade } from '../core/scrollFade.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { projectAgeLabel, type ProjectRow } from '../projects/projects.ts';
  import { rowAgentCounts, rowAgents, type SidebarPane } from './sidebar.ts';
  import { useServerScope } from '../app/server-context.ts';
  import { stateDotColor, stateIsLive } from './hub.ts';
  import { anchorOf } from '../ui/placement.ts';
  import { longpress } from '../ui/longpress.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import type { HoverInfo } from '../ui/hover.svelte.ts';
  import { flip } from 'svelte/animate';
  import { slideIndicator } from '../ui/indicator.ts';
  import { moveMs } from '../ui/motion.ts';

  type MenuPosition = { x: number; y: number }
    | { anchor: ReturnType<typeof anchorOf>; trigger: Element };
  interface Props {
    compact?: boolean;
    open?: boolean;
    rows?: ProjectRow[];
    trash?: ProjectRow[];
    rowsBase?: ReadonlySet<string> | null;
    selected?: string;
    panes?: SidebarPane[];
    agentStates?: Record<string, string>;
    talkMap?: Record<string, number>;
    tick?: number;
    /** Unread news per project (board #322): `hub_unread`'s summary, by session. */
    roomUnread?: Record<string, { count: number }>;
    onselect?: (session: string) => void;
    oncreate?: () => void;
    onclose?: () => void;
    onmenu?: (row: ProjectRow, at: MenuPosition) => void;
    onrestore?: (row: ProjectRow) => void;
    onpurge?: (row: ProjectRow) => void;
  }
  let {
    compact = false, open = false, rows = [], trash = [], rowsBase = null,
    selected = '', panes = [], agentStates = {}, talkMap = {}, tick = Date.now(),
    roomUnread = {}, onselect = () => {}, oncreate = () => {}, onclose = () => {},
    onmenu = () => {}, onrestore = () => {}, onpurge = () => {},
  }: Props = $props();
  // This server's backend catalog (board #335 ②b-3), for the rows' agent
  // faces. From the Hub's scope, read once at init.
  const catalog = useServerScope()!.state.backends;
  let trashOpen = $state(false);
  /* The open row's wash is ONE marker that glides (motion principle 14); it
     re-measures when the choice or the order changes. */
  const rowKey = $derived([selected, rows.map((r) => r.project.id).join(',')].join('|'));
  const rowLit = $derived(rows.some((r) => r.project.session === selected));

  function rowInfo(row: ProjectRow): HoverInfo {
    const n = rowAgentCounts(row, panes);
    const lines: NonNullable<HoverInfo['lines']> = [{ label: t('hubHoverPath'), value: row.project.path }];
    if (n.live || n.stopped) {
      lines.push({ label: t('hubHoverAgents'), value: t('hubHoverAgentsCount').replace('{live}', String(n.live)).replace('{stopped}', String(n.stopped)), tone: n.live ? 'accent' : undefined });
    }
    const age = projectAgeLabel(row, talkMap, tick);
    if (age) lines.push({ label: t('hoverActivity'), value: age });
    const unread = roomUnread[row.project.session]?.count ?? 0;
    if (unread) lines.push({ label: t('hubHoverUnread'), value: String(unread), tone: 'accent' });
    return { title: row.project.name, lines };
  }
</script>

<!-- The same list is a desktop column and the shared compact sheet. -->
{#if compact && open}
  <div class="side-scrim" onclick={onclose} role="presentation"></div>
{/if}
<aside class="sidebar" class:side-sheet={compact} class:sheet={compact} class:open={compact && open}>
  {#if !compact}<SideHandle />{/if}
  <div class="side-scroll subtle-scroll" use:scrollFade use:slideIndicator={{ key: rowKey, active: '.proj-row.open', hidden: !rowLit }}>
    <!-- The chosen project's wash: one marker that glides to the newly picked
         row instead of one row switching off and another on (owner,
         2026-09-23: "阴影直接滑动过来，增加一些动画衔接的感觉"). -->
    <span class="slide-pill soft" aria-hidden="true"></span>
    <div class="side-h side-head side-toggle-row"><span>{t('hubProjects')}</span>
      <!-- New project at the head, reachable without scrolling the list
           (owner, 2026-09-23: "每次还得滚动到最下边才能新建"); the row at the
           foot went with it. -->
      <button class="icon-btn head-add" aria-label={t('projectNew')} title={t('projectNew')} onclick={oncreate}>
        <Icon name="plus" size={13} />
      </button>
    </div>
    {#each rows as row (row.project.id)}
      {@const unread = roomUnread[row.project.session]?.count ?? 0}
      <div class="side-row proj-row" role="group" aria-label={unread ? `${row.project.name} · ${t('hubUnreadCount').replace('{n}', String(unread))}` : row.project.name} class:open={row.project.session === selected} class:unread={unread > 0}
        class:appear={!!rowsBase && !rowsBase.has(row.project.id)}
        animate:flip={{ duration: moveMs() }}
        oncontextmenu={(e) => { e.preventDefault(); onmenu(row, { x: e.clientX ?? 0, y: e.clientY ?? 0 }); }}
        use:longpress={{ onlongpress: (pt) => onmenu(row, pt) }}
        use:hoverInfo={() => rowInfo(row)}>
        <button class="proj-pick" onclick={() => onselect(row.project.session)}>
          <span class="dot" class:off={!row.live}></span>
          <span class="p-main">
            <span class="p-top">
              <span class="p-name">{row.project.name}</span>
              {#if unread}<span class="side-unread appear-pop"><span class="unread-dot"></span>{unread}</span>{/if}
              <span class="side-age">{projectAgeLabel(row, talkMap, tick)}</span>
            </span>
            {#if rowAgents(row, panes, agentStates, catalog).length}
              <span class="side-wins" class:dim={!row.live}>
                {#each rowAgents(row, panes, agentStates, catalog) as a (a.name)}
                  <span class="side-win">
                    {#if a.icon}<img src={a.icon} alt="" width="11" height="11" />{/if}
                    <span class="side-win-name">{a.name}</span>
                    {#if a.state}<span class="side-win-dot" class:live-dot={stateIsLive(a.state)} style:background={stateDotColor(a.state)}></span>{/if}
                  </span>
                {/each}
              </span>
            {/if}
          </span>
        </button>
        <button class="icon-btn row-menu" aria-label={t('hubProjectMenu')}
          onclick={(e) => {
            e.stopPropagation();
            onmenu(row, { anchor: anchorOf(e.currentTarget), trigger: e.currentTarget });
          }}>
          <Icon name="dots" size={13} />
        </button>
      </div>
    {/each}
    {#if trash.length}
      <button class="side-row add trash-bar" onclick={() => trashOpen = !trashOpen}>
        <Icon name={trashOpen ? 'chevron-down' : 'trash'} size={13} />
        {t('hubTrashBar').replace('{n}', String(trash.length))}
      </button>
      {#if trashOpen}
        {#each trash as r (r.project.id)}
          <div class="side-row trash-row appear" title={r.project.path}>
            <span class="p-name trash-name">{r.project.name}</span>
            <button class="t-act" title={t('hubRestore')} aria-label={t('hubRestore')}
              onclick={() => onrestore(r)}>
              <Icon name="refresh" size={12} />
            </button>
            <button class="t-act danger" title={t('hubPurge')} aria-label={t('hubPurge')}
              onclick={() => onpurge(r)}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</aside>

<style>
  .proj-pick {
    display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0;
    padding: 0; border: 0; background: none; color: inherit; text-align: left;
    font: inherit; cursor: pointer;
  }
  .row-menu { padding: 0; color: var(--text3); } /* its place is the shared atom's (app.css) */
  .head-add { width: 24px; height: 24px; padding: 0; flex: none; color: var(--text3); }
  /* The rows' place above the wash and their absent in-place wash live with
     the shared row atoms in app.css. */
  .side-scroll > :global(.slide-pill) { border-radius: var(--ui-radius-row); }

  .sidebar { position: relative; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  /* Sheet geometry/motion and project-row atoms remain in app.css. */
  .sidebar.sheet .side-row { min-height: 44px; }
  .side-scroll { flex: 1; overflow-y: auto; padding: 8px; position: relative; }
  /* The head is a row; the Hub's riding collapse toggle overlays its right end
     (#197). The look (face, size, tracking, padding) stays app.css's .side-h. */
  .side-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .trash-row { cursor: default; color: var(--text3); }
  .trash-row:hover { background: var(--surface); }
  .trash-name { font-weight: 450; }
  .t-act {
    display: grid; place-items: center; width: 24px; height: 24px; flex: none;
    /* 24px square: the command PAINT corner, not a field radius — 10 on 24
       reads as a circle (design-language radius scale; found by #337's new
       token test, same defect the owner reported on the scratch control). */
    background: none; border: none; border-radius: var(--control-paint-radius);
    color: var(--text3); cursor: pointer;
  }
  .t-act:hover { background: var(--surface2); color: var(--text); }
  .t-act.danger:hover { color: var(--danger); }
</style>
