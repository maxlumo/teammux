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
  import ServerTag from '../ui/ServerTag.svelte';
  import type { HubUnionRow } from '../app/hub-union.svelte.ts';

  type MenuPosition = { x: number; y: number }
    | { anchor: ReturnType<typeof anchorOf>; trigger: Element };
  interface Props {
    compact?: boolean;
    open?: boolean;
    rows?: ProjectRow[];
    /** The list as a UNION over servers (board #335 ③c-2): the Hub builds it
     * from App's union source, one entry per project per server, each with
     * the clock, unread, states and panes of ITS server. Rendered instead of
     * `rows` (which stays the one-server form the entries are built from);
     * the row's `key` (its ref) is the `{#each}` key and what `selectedKey`
     * names, so two servers' same-named projects never collide. */
    entries?: HubUnionRow[] | null;
    /** Servers included in the union whose list has not arrived. */
    missing?: { id: string; name: string }[];
    trash?: ProjectRow[];
    rowsBase?: ReadonlySet<string> | null;
    selected?: string;
    /** The open row as a ref key (`refKey(sessionRef)`), when `entries` is
     * given; `selected` alone cannot tell two servers' `work` apart. */
    selectedKey?: string;
    panes?: SidebarPane[];
    agentStates?: Record<string, string>;
    talkMap?: Record<string, number>;
    tick?: number;
    /** Unread news per project (board #322): `hub_unread`'s summary, by session. */
    roomUnread?: Record<string, { count: number }>;
    onselect?: (session: string) => void;
    /** A union entry picked: its server and session (③c-2). */
    onselectEntry?: (entry: HubUnionRow) => void;
    oncreate?: () => void;
    onclose?: () => void;
    onmenu?: (row: ProjectRow, at: MenuPosition) => void;
    onmenuEntry?: (entry: HubUnionRow, at: MenuPosition) => void;
    onrestore?: (row: ProjectRow) => void;
    onpurge?: (row: ProjectRow) => void;
  }
  let {
    compact = false, open = false, rows = [], entries = null, missing = [], trash = [], rowsBase = null,
    selected = '', selectedKey = '', panes = [], agentStates = {}, talkMap = {}, tick = Date.now(),
    roomUnread = {}, onselect = () => {}, onselectEntry = () => {}, oncreate = () => {}, onclose = () => {},
    onmenu = () => {}, onmenuEntry = () => {}, onrestore = () => {}, onpurge = () => {},
  }: Props = $props();
  /** ONE list shape for the template: the union's entries, or this server's
   * rows as single-server entries (no tag, this Hub's own clock and maps). */
  const list = $derived<HubUnionRow[]>(entries ?? rows.map((row) => ({
    serverId: '', item: row, ref: { kind: 'session', serverId: '', session: row.project.session }, key: row.project.id, tag: null,
    slice: { rows, talk: talkMap, unread: roomUnread, agentStates, panes },
  })));
  const isOpen = (e: HubUnionRow) => (entries ? e.key === selectedKey : e.item.project.session === selected);
  const pick = (e: HubUnionRow) => { if (entries) onselectEntry(e); else onselect(e.item.project.session); };
  const menu = (e: HubUnionRow, at: MenuPosition) => { if (entries) onmenuEntry(e, at); else onmenu(e.item, at); };
  // This server's backend catalog (board #335 ②b-3), for the rows' agent
  // faces. From the Hub's scope, read once at init.
  const catalog = useServerScope()!.state.backends;
  let trashOpen = $state(false);
  /* The open row's wash is ONE marker that glides (motion principle 14); it
     re-measures when the choice or the order changes. */
  const rowKey = $derived([entries ? selectedKey : selected, list.map((e) => e.key).join(',')].join('|'));
  const rowLit = $derived(list.some(isOpen));

  function rowInfo(e: HubUnionRow): HoverInfo {
    const row = e.item;
    const n = rowAgentCounts(row, e.slice.panes as SidebarPane[]);
    const lines: NonNullable<HoverInfo['lines']> = [{ label: t('hubHoverPath'), value: row.project.path }];
    // The hover carries only what the row hides (owner): the server's name is
    // on the row's tag already; its path is not.
    if (n.live || n.stopped) {
      lines.push({ label: t('hubHoverAgents'), value: t('hubHoverAgentsCount').replace('{live}', String(n.live)).replace('{stopped}', String(n.stopped)), tone: n.live ? 'accent' : undefined });
    }
    const age = projectAgeLabel(row, e.slice.talk, tick);
    if (age) lines.push({ label: t('hoverActivity'), value: age });
    const unread = e.slice.unread[row.project.session]?.count ?? 0;
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
    {#each list as e (e.key)}
      {@const row = e.item}
      {@const unread = e.slice.unread[row.project.session]?.count ?? 0}
      {@const agents = rowAgents(row, e.slice.panes as SidebarPane[], e.slice.agentStates as Record<string, string>, catalog)}
      <div class="side-row proj-row" role="group" aria-label={unread ? `${row.project.name} · ${t('hubUnreadCount').replace('{n}', String(unread))}` : row.project.name} class:open={isOpen(e)} class:unread={unread > 0}
        class:appear={!!rowsBase && !rowsBase.has(row.project.id)}
        data-server={e.serverId || undefined}
        animate:flip={{ duration: moveMs() }}
        oncontextmenu={(ev) => { ev.preventDefault(); menu(e, { x: ev.clientX ?? 0, y: ev.clientY ?? 0 }); }}
        use:longpress={{ onlongpress: (pt) => menu(e, pt) }}
        use:hoverInfo={() => rowInfo(e)}>
        <button class="proj-pick" onclick={() => pick(e)}>
          <span class="dot" class:off={!row.live}></span>
          <span class="p-main">
            <span class="p-top">
              <span class="p-name">{row.project.name}</span>
              <ServerTag name={e.tag} />
              {#if unread}<span class="side-unread appear-pop"><span class="unread-dot"></span>{unread}</span>{/if}
              <span class="side-age">{projectAgeLabel(row, e.slice.talk, tick)}</span>
            </span>
            {#if agents.length}
              <span class="side-wins" class:dim={!row.live}>
                {#each agents as a (a.name)}
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
          onclick={(ev) => {
            ev.stopPropagation();
            menu(e, { anchor: anchorOf(ev.currentTarget), trigger: ev.currentTarget });
          }}>
          <Icon name="dots" size={13} />
        </button>
      </div>
    {/each}
    {#each missing as m (m.id)}
      <!-- A server in the union whose list has not arrived (no Hub answer
           yet, or no Hub): said, never a shorter list in silence (②a-5). -->
      <div class="side-row proj-row missing" role="note">
        <span class="dot off"></span>
        <span class="p-main"><span class="p-top"><span class="p-name">{m.name}</span><span class="side-age">{t('hubUnionMissing')}</span></span></span>
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
