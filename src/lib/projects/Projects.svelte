<script lang="ts">
  // Projects: the declarative half of the Sessions page.
  //
  // A project is a directory plus the windows it is made of; the tmux session
  // is a projection we can throw away and rebuild (`up` / `down`). Everything
  // here is thin: the server owns the declaration, this file owns the taps.
  //
  // Hidden entirely on a server without project support (mobile builds), the
  // same method-not-found contract the Team tab uses.
  import { useServerApi } from '../app/server-context.ts';
  import type { TmuxPane } from '../core/ws.ts';
  import type { ProjectRow } from './projects.ts';
  import { flip } from 'svelte/animate';
  import { moveMs } from '../ui/motion.ts';
  import { declaredWindowChips, liveWindowChips, projectAgeLabel, shortPath, sortRows } from './projects.ts';
  import Icon from '../ui/Icon.svelte';
  import { slideIndicator } from '../ui/indicator.ts';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import { longpress } from '../ui/longpress.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import type { HoverInfo, HoverLine } from '../ui/hover.svelte.ts';
  import { t } from '../core/i18n.svelte.ts';

  let { visible = false, openTerminal, panes = {}, onTracked = () => {}, onReady = () => {}, onGoBack = null, dense = false, activeTarget = '', oncreate = null }: {
    visible?: boolean;
    /** The sidebar head's New project command (dense only); the host owns the dialog. */
    oncreate?: (() => void) | null;
    openTerminal: (session: string, target: string, command?: string) => void;
    /** Live panes per session, already loaded by the Sessions page. */
    panes?: Record<string, TmuxPane[]>;
    /** Session names that are tracked, so the session list can stop repeating them. */
    onTracked?: (sessions: string[]) => void;
    /** Hands the reload function out, so creating a project refreshes us. */
    onReady?: (reload: () => Promise<void>) => void;
    onGoBack?: ((fn: () => boolean) => void) | null;
    /** Sidebar mode: rows in the shared side-row language instead of cards
     * (ui-unification "Page skeleton"). The Chat sidebar set that style; the
     * Terminal sidebar has to match it (owner, 2026-08-19). */
    dense?: boolean;
    /** The pane the terminal is showing (`session:win.pane`) — its project's
     * row wears the same selected wash the Chat sidebar's open row wears
     * (owner, 2026-08-24: "选中的有一个背景底色terminal的侧边栏也应该加上"). */
    activeTarget?: string;
  } = $props();
  // This server's RPCs, read once at init (board #335 ②b).
  const { listPanes, hubRooms, projectArchive, projectDown, projectList, projectUp } = useServerApi();

  let rows = $state<ProjectRow[]>([]);
  let talkMap = $state<Record<string, number>>({});
  let tick = $state(Date.now());
  let supported = $state(true);
  let error = $state('');
  let busy = $state<Record<string, boolean>>({});
  /** The project awaiting a CONFIRMED verb. Archive has always asked (there is
   * no un-remove); Close asks too since board #77 (owner, 2026-09-02: "关闭需要
   * 二次确认") — it kills every pane in the session, the same reason the Hub's
   * Close confirms. Two taps used to arm and fire; the app's confirmation says
   * what actually happens instead. */
  let pending = $state<{ kind: 'archive' | 'down'; id: string; name: string } | null>(null);
  let confirmError = $state('');
  let viewEpoch = 0;
  function ask(kind: 'archive' | 'down', row: ProjectRow) {
    if (pending || busy[row.project.id]) return;
    confirmError = '';
    pending = { kind, id: row.project.id, name: row.project.name };
  }
  function goBack() {
    if (!pending) return false;
    if (!busy[pending.id]) { pending = null; confirmError = ''; }
    return true;
  }
  $effect(() => {
    const register = onGoBack;
    if (!register) return;
    register(goBack);
    return () => register(() => false);
  });

  // Right-click / long-press on a row: the SAME verbs the row already offers
  // (design-language.md §5 — a context menu is never a second source of
  // truth), in rising-consequence order. The Chat sidebar's rows had this and
  // the Terminal sidebar's did not (owner, 2026-08-25: "终端页面 侧边栏
  // 右键/长按效果" in the uniformity sweep).
  let ctxAt = $state<{ x: number; y: number } | null>(null);
  let ctxWho = $state('');
  let ctxItems = $state<{ label: string; icon?: string; danger?: boolean; onselect: () => void }[]>([]);
  const pointOf = (e: MouseEvent) => ({ x: e.clientX ?? 0, y: e.clientY ?? 0 });
  const closeCtx = () => { ctxAt = null; ctxItems = []; };
  function rowItems(row: ProjectRow) {
    return [
      row.live
        ? { label: t('projectDown'), icon: 'stop', danger: true, onselect: () => ask('down', row) }
        : { label: t('projectUp'), icon: 'zap', onselect: () => run(row.project.id, () => projectUp(row.project.id)) },
      { label: t('projectArchive'), icon: 'trash', danger: true, onselect: () => ask('archive', row) },
    ];
  }
  function openCtx(at: { x: number; y: number; align?: 'left' | 'right' }, row: ProjectRow) {
    ctxWho = row.project.name;
    ctxItems = rowItems(row);
    ctxAt = at;
  }
  let collapsed = $state(false);

  const sorted = $derived(sortRows(rows, talkMap));

  // Live windows beat the declaration while the session exists: they are what
  // you can actually tap into, including a window that has not settled yet.
  function chipsFor(row: ProjectRow) {
    if (!row.live) return declaredWindowChips(row.slots);
    const live = panes[row.project.session] ?? [];
    return live.length ? liveWindowChips(live) : declaredWindowChips(row.slots);
  }

  // The card's facts for the hover card (motion.md principle 16), through the
  // card's OWN helpers — projectAgeLabel for the shared updated age, chipsFor
  // for the live windows —
  // never a second formatter. Agents: declared agent slots, split into the
  // ones with a live agent pane and the rest.
  function projectInfo(row: ProjectRow): HoverInfo {
    const declared = row.slots.filter((s) => s.kind === 'agent').length;
    const live = row.live ? chipsFor(row).filter((c) => c.agentTag).length : 0;
    const lines: HoverLine[] = [
      { label: t('path'), value: row.project.path },
      { label: t('hoverState'), value: row.live ? t('hoverLive') : t('hoverStopped'), tone: row.live ? 'accent' : undefined },
    ];
    if (declared || live) {
      lines.push({ label: t('hoverAgents'), value: t('hoverAgentsCount').replace('{live}', String(live)).replace('{stopped}', String(Math.max(0, declared - live))) });
    }
    const age = projectAgeLabel(row, talkMap, tick);
    if (age) lines.push({ label: t('hoverActivity'), value: age });
    return { title: row.project.name, lines };
  }

  /** First fill (motion.md principle 15): the cards unfold once, when the
   * first answer lands; later loads keep the keyed cards' nodes. */
  let firstFill = $state(false);

  async function load(generation = viewEpoch) {
    try {
      const [res, rooms] = await Promise.all([
        projectList(),
        hubRooms().catch(() => null),
      ]);
      if (generation !== viewEpoch) return;
      rows = res?.projects ?? [];
      if (rooms) talkMap = rooms.rooms ?? {};
      if (rows.length) firstFill = true;
      supported = true;
      error = '';
      onTracked(rows.map((r) => r.project.session));
    } catch (e) {
      if (generation !== viewEpoch) return;
      const code = (e as { code?: number })?.code;
      // -32601: this server has no project support. Not an error to show.
      if (code === -32601) { supported = false; onTracked([]); return; }
      error = (e as Error)?.message || String(e);
      // Report the LAST KNOWN tracking even on failure: the host gates its
      // untracked-session rendering on "projects have reported", and a silent
      // failure here must not leave that gate shut forever.
      onTracked(rows.map((r) => r.project.session));
    }
  }

  // Hand our reload out once, so tracking a session from the list below can
  // refresh this section. Inside an effect because reading a prop at component
  // init only captures its initial value.
  $effect(() => {
    onReady(load);
  });

  // Reload whenever the section becomes visible: another client (or the
  // capturer) may have changed the declaration while we were away.
  $effect(() => {
    if (visible) void load();
    return () => {
      viewEpoch++;
      pending = null; busy = {}; confirmError = '';
      closeCtx();
    };
  });

  $effect(() => {
    if (!visible) return;
    const timer = setInterval(() => { tick = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  async function run(id: string, fn: () => Promise<unknown>) {
    if (busy[id]) return;
    const generation = viewEpoch;
    busy = { ...busy, [id]: true };
    error = '';
    try {
      await fn();
      if (generation === viewEpoch) await load(generation);
    } catch (e) {
      if (generation === viewEpoch) error = (e as Error)?.message || String(e);
    } finally {
      if (generation === viewEpoch) delete busy[id];
    }
  }

  async function runPending() {
    if (!pending || busy[pending.id]) return;
    const act = pending;
    const generation = viewEpoch;
    busy[act.id] = true;
    confirmError = '';
    try {
      if (act.kind === 'down') await projectDown(act.id);
      else await projectArchive(act.id, true);
    } catch (e) {
      if (generation === viewEpoch && pending === act) confirmError = (e as Error)?.message || String(e);
      return;
    } finally {
      if (generation === viewEpoch && pending === act) delete busy[act.id];
    }
    if (generation !== viewEpoch || pending !== act) return;
    pending = null;
    await load(generation);
  }

  // A window's live pane target. The panes prop comes from the Sessions page's
  // own poll, so right after `up` it does not know about the new session yet —
  // ask tmux directly in that case.
  async function paneTargets(session: string): Promise<TmuxPane[]> {
    const known = panes[session] ?? [];
    if (known.length) return known;
    return await listPanes(session).catch(() => []);
  }

  async function open(row: ProjectRow) {
    if (!row.live) {
      await run(row.project.id, () => projectUp(row.project.id));
    }
    const live = await paneTargets(row.project.session);
    const pane = live.find((p) => p.active) ?? live[0];
    if (pane) openTerminal(row.project.session, `${pane.session}:${pane.window}.${pane.pane}`);
  }

  /// Tap a window chip: jump straight into that window. A closed project has to
  /// come up first, and then we look the window up by name.
  async function openWindow(row: ProjectRow, name: string, target: string | null) {
    if (target) {
      openTerminal(row.project.session, target);
      return;
    }
    await run(row.project.id, () => projectUp(row.project.id));
    const live = await paneTargets(row.project.session);
    const pane = live.find((p) => p.window_name === name && p.active)
      ?? live.find((p) => p.window_name === name);
    if (pane) openTerminal(row.project.session, `${pane.session}:${pane.window}.${pane.pane}`);
  }



</script>

{#if supported && sorted.length > 0}
  <section class="projects" class:dense class:reveal={firstFill}
    use:slideIndicator={{ key: `${activeTarget}|${sorted.map((r) => r.project.id).join(',')}`, active: '.proj.open', hidden: !dense || !activeTarget }}>
    {#if dense}
      <!-- The shown project's wash glides between rows (motion principle 14),
           the same marker the Chat and Board sidebars carry. -->
      <span class="slide-pill soft" aria-hidden="true"></span>
    {/if}
    <div class="group-label" class:side-h={dense} class:side-toggle-row={dense}>
      {#if dense}
        <!-- A sidebar section header is a LABEL, not a control: the Chat
             sidebar has no chevron to collapse its projects, and a list this
             short never needed one (owner: "projects 上边还是折叠的，这个和
             chat 里不太一样"). No count either: Chat's header is the word
             alone, and "PROJECTS 24" next to Chat's "PROJECTS" was one of
             the mismatches the owner named (board #235: "projects 后面写的
             project 数量等等，这些都给我对齐一下"). -->
        <span>{t('projects')}</span>
        {#if oncreate}
          <!-- New project at the head, as in Chat's sidebar (owner, 2026-09-23). -->
          <button class="icon-btn head-add" aria-label={t('projectNew')} title={t('projectNew')} onclick={oncreate}>
            <Icon name="plus" size={13} />
          </button>
        {/if}
      {:else}
        <!-- The word alone here too (#235 follow-up): with every sidebar
             count gone, the page header's badge was the last of its species
             — the Sessions page shows none, and the list below already
             answers "how many". -->
        <button class="group-toggle" onclick={() => collapsed = !collapsed} aria-expanded={!collapsed}>
          <span class="chev" class:open={!collapsed}><Icon name="chevron-right" size={12} /></span>
          {t('projects')}
        </button>
      {/if}
    </div>

    {#if !collapsed}
      <!-- Keyed + animate:flip (motion.md): `sortRows` ranks live projects
           first, so a project going up or down changes rank and its card
           MOVES there instead of every card repainting. A card fades in when
           it mounts (a new project, or the section expanding). -->
      {#each sorted as row (row.project.id)}
        {@const chips = chipsFor(row)}
        <div class="proj appear" class:live={row.live}
          class:open={dense && !!activeTarget && activeTarget.startsWith(row.project.session + ':')}
          animate:flip={{ duration: moveMs() }}
          role="group" aria-label={row.project.name}
          oncontextmenu={(e) => { e.preventDefault(); openCtx(pointOf(e), row); }}
          use:longpress={{ onlongpress: (pt) => openCtx(pt, row) }}>
          <div class="proj-top">
            <button class="proj-main" onclick={() => open(row)} use:hoverInfo={() => projectInfo(row)}>
              <span class="dot" class:on={row.live}></span>
              <span class="body">
                <span class="line">
                  <span class="name">{row.project.name}</span>
                  <span class={dense ? 'side-age' : 'age'}>{projectAgeLabel(row, talkMap, tick)}</span>
                </span>
                {#if !dense}
                  <!-- The path is what tells two same-named folders apart, so a
                       full-page card shows it. A sidebar row is one line like
                       every other sidebar row; the path lives in the row's
                       hover card instead (use:hoverInfo above). -->
                  <span class="line sub">
                    <span class="path">{shortPath(row.project.path)}</span>
                  </span>
                {/if}
              </span>
            </button>
            {#if dense}
              <!-- The SIDEBAR row (board #77): no verbs in the open — "关闭之类的
                   应该是点击后才有进一步操作". One quiet ⋯ opens the same context
                   menu right-click/long-press already speak (rising consequence:
                   Open/Close, then Remove), and the destructive ones confirm. -->
              <button class="icon-btn row-menu" disabled={busy[row.project.id]} title={t('hubProjectMenu')} aria-label={t('hubProjectMenu')}
                onclick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openCtx({ x: r.right, y: r.bottom, align: 'right' }, row); }}>
                <Icon name="dots" size={13} />
              </button>
            {:else}
            <div class="acts">
              {#if row.live}
                <!-- Close confirms (board #77): it kills every pane in the session. -->
                <button class="act" disabled={busy[row.project.id]} onclick={() => ask('down', row)}>{t('projectDown')}</button>
              {:else}
                <button class="act primary" disabled={busy[row.project.id]} onclick={() => run(row.project.id, () => projectUp(row.project.id))}>{t('projectUp')}</button>
              {/if}
              <!-- Confirmed, because there is no un-remove in the UI and the
                   server never auto-tracks a removed session again. The session
                   itself is left alone — this forgets the declaration, it does
                   not kill anything. -->
              <button
                class="act icon"
                disabled={busy[row.project.id]}
                aria-label={t('projectArchive')}
                title={t('projectArchive')}
                onclick={() => ask('archive', row)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
            {/if}
          </div>

          <!-- Windows belong INSIDE the project card: they are what the project
               is made of, not a separate list under it. Each one is tappable —
               jumping to the window you want is the whole point. A down project
               lists what `up` would restore, and the tap brings it up first. -->
          {#if chips.length}
            <div class={dense ? 'side-wins wins-indent' : 'wins'} class:dim={!row.live}>
              {#each chips as chip (chip.name + (chip.window ?? ''))}
                <button class={dense ? 'side-win' : 'win'} onclick={() => openWindow(row, chip.name, chip.target)}>
                  {#if chip.agentIcon}<img src={chip.agentIcon} alt={chip.agentTag} width="11" height="11" />{/if}
                  <span class={dense ? 'side-win-name' : 'win-name'}>{chip.name}</span>
                </button>
              {/each}
            </div>
          {:else}
            <div class={dense ? 'side-wins wins-indent' : 'wins'}><span class="win-empty">{t('projectNoWindows')}</span></div>
          {/if}
        </div>

      {/each}

      {#if error}
        <div class="err appear">{error}</div>
      {/if}
    {/if}
  </section>
{/if}

<ContextMenu at={ctxAt} items={ctxItems} who={ctxWho} oncancel={closeCtx} />

<ConfirmDialog open={!!pending} busy={!!pending && !!busy[pending.id]} error={confirmError}
  title={pending ? t(pending.kind === 'down' ? 'projectDownTitle' : 'projectArchiveConfirmTitle').replace('{name}', pending.name) : ''}
  note={pending ? t(pending.kind === 'down' ? 'projectDownNote' : 'projectArchiveConfirmNote') : ''}
  confirmLabel={pending?.kind === 'down' ? t('projectDown') : t('projectArchive')}
  confirmIcon={pending?.kind === 'down' ? 'stop' : 'trash'}
  onconfirm={runPending}
  oncancel={() => { if (!pending || !busy[pending.id]) { pending = null; confirmError = ''; } }} />

<style>
  .projects { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  /* The PAGE dialect for the header. Scoped away from dense mode on purpose:
     a scoped `.group-label` rule outranks the shared `.side-h` class (0,2,0
     vs 0,1,0), so leaving it unqualified silently overrode the vocabulary the
     sidebar is supposed to inherit — measured as 11px/0.66px tracking against
     Chat's 10.5px/1.4px (2026-08-19). */
  .projects:not(.dense) .group-label {
    font-size: var(--fs-sub); letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text3);
    padding: 2px 2px 2px 4px;
  }
  /* NO padding (or type) on the unqualified rule: this element carries `.side-h`
     in dense mode, and a scoped rule outranks that shared class (0,2,0 vs
     0,1,0). Declaring padding here is what put the Terminal sidebar's
     "PROJECTS" 6px left of Chat's — the third recurrence of the same drift
     (owner, 2026-08-20). The page dialect above owns its own box instead. */
  .group-label {
    display: flex; align-items: center; gap: 6px;
  }
  .group-toggle {
    display: flex; align-items: center; gap: 6px;
    background: none; border: 0; padding: 2px 0; cursor: pointer;
    font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit;
  }

  /* ── Sidebar (dense) mode ───────────────────────────────────────────────
     The Chat sidebar defined the house style — bg2 surface, one uppercase
     mono section header, borderless rows that only highlight when active —
     and the Terminal sidebar now shows the SAME component, so the cards
     become rows here instead of a second visual language living next door.
     Card chrome off, section header in the shared .side-h idiom, actions
     revealed on hover so the row is a name and a state at rest. */
  .projects.dense { gap: 1px; margin-bottom: 6px; }
  /* The header IS `.side-h` now (the class is on the element), so the type
     dialect — mono, 10.5px, uppercase, 1.4px tracking, --text3 — comes from
     app.css and cannot drift. Re-declaring it here is what put 1.05px
     tracking next to Chat's 1.4px (measured 2026-08-19). Only the sidebar's
     tighter gutter stays local. */
  /* Padding comes from `.side-h` too — see the note in Sessions.svelte. */
  /* ONE box rhythm with Chat's `.side-row.proj-row` (board #235, owner:
     "上下宽度等格式感觉不一样…都给我对齐一下"; measured 2026-09-22 — Chat:
     row pad 8/10, name→chips 2px, chips flush to the 8px bottom pad, an 8px
     gap before the ⋯ column; this row had 2+6 pads, an 8px name→chips gap
     and a 3px chips inset, three near-misses that read as a second dialect).
     The row owns the 8px 10px pad like Chat's; .proj-main carries none. */
  .projects.dense .proj {
    background: none; border: none; border-radius: var(--ui-radius-row); padding: 8px 10px; gap: 2px;
  }
  .projects.dense .proj:hover { background: var(--surface2); }
  /* The project whose pane the terminal is SHOWING wears the same selected
     wash as the Chat sidebar's open row — carried by the travelling
     .slide-pill above, not drawn in place, so switching projects glides
     identically in both sidebars. */
  .projects.dense .proj.open { background: none; }
  .projects.dense { position: relative; }
  .projects.dense > :global(.slide-pill) { border-radius: var(--ui-radius-row); }
  .projects.dense .group-label { justify-content: space-between; }
  .projects.dense .head-add { width: 24px; height: 24px; padding: 0; flex: none; color: var(--text3); }
  .projects.dense .proj.live { border: none; }
  .projects.dense .proj-main { padding: 0; align-items: center; }
  /* Chat's first line, verbatim: an 8px gap before the ⋯, which leaves the
     flow so the name→chips rhythm never depends on a button's height. */
  .projects.dense .proj { position: relative; }
  .projects.dense .proj-top { gap: 8px; align-items: flex-start; }
  /* The ⋯ rides the TITLE line, as in Chat's rows (owner, 2026-09-24): only
     that line keeps its 24+8 room; the windows beneath take the full width. */
  .projects.dense .line { padding-right: 32px; }
  .projects.dense .row-menu { position: absolute; right: 10px; top: 6px; }
  /* Chat's dot language, verbatim: 6px, --status-ok when live, --text3 when
     down, no glow (the 7px accent-glow dot is the card dialect). The name
     takes `.p-name`'s 550, not the card's 600. */
  .projects.dense .dot { width: 6px; height: 6px; margin-top: 0; background: var(--text3); }
  .projects.dense .dot.on { background: var(--status-ok); box-shadow: none; }
  .projects.dense .name { font-weight: 550; }
  .projects.dense .path { color: var(--text3); }
  /* At rest a row shows what it IS; what you can DO to it appears on hover
     (or focus, for keyboards) — the same restraint the Chat rows have. */
  .projects.dense .acts { opacity: 0; transition: opacity var(--t-fast) ease; }
  .projects.dense .proj:hover .acts,
  .projects.dense .proj:focus-within .acts { opacity: 1; }
  /* Windows stay — they are what the project is made of, and picking one is
     why this sidebar exists. Their LOOK is the shared `.side-win` dialect in
     app.css now (the Chat sidebar's agent chips wear the same class — "这两个
     可以共用", owner 2026-08-24); only the indent that tucks them under the
     name is structural and stays here: dot 6 + gap 8 = 14, the name's own x,
     exactly where Chat's chips start (#235). The bottom inset is the row's
     8px pad, as in Chat — no extra chip padding. */
  .projects.dense .wins-indent { padding: 0 0 0 14px; }

  .proj {
    display: flex; flex-direction: column; gap: 6px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--ui-radius-panel, 8px); padding: 7px 8px;
    /* Border (live), background (dense hover / open wash) cross-fade. */
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .proj.live { border-color: var(--accent-bg); }
  .proj-top { display: flex; align-items: stretch; gap: 6px; }
  .proj-main {
    flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 8px;
    background: none; border: 0; padding: 0; cursor: pointer; text-align: left; color: var(--text);
  }
  .dot {
    flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; margin-top: 5px;
    background: var(--border2);
    /* A state dot changes COLOUR, never opacity (design-language.md §1). */
    transition: background var(--t-fast), box-shadow var(--t-fast);
  }
  .dot.on { background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); }
  /* flex: 1 so `.line` spans the row and the age's `margin-left: auto` can
     right-align it — without it the age hugged the name while Chat's
     `.side-age` sat on the row's right edge (owner, 2026-09-21, board #232:
     "terminal 页面的的左侧边栏好像像是还是不一样"). */
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  /* Identity layer: the project's NAME takes the display face; the window
     chips beside it stay mono — they are data. */
  .name { font-size: var(--fs-body); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-display); }
  .age { margin-left: auto; font-size: var(--fs-meta); color: var(--text3); }
  .sub { font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text2); }
  .path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Window row: one tappable button per window, inside the project card and
     indented to line up under the project name (past the status dot). */
  .wins {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding-left: 15px;
  }
  .wins { transition: opacity var(--t-move); }
  .wins.dim { opacity: 0.65; }
  .win {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface2); color: var(--text2);
    border: 1px solid var(--border); border-radius: 5px;
    padding: 2px 7px; cursor: pointer;
    font-family: var(--font-mono); font-size: var(--fs-meta);
    transition: color var(--t-fast), border-color var(--t-fast);
  }
  .win:hover { color: var(--text); border-color: var(--border2); }
  .win-name { max-width: 13ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .win-empty { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text3); }

  .acts { display: flex; align-items: center; gap: 4px; }
  /* The sidebar row's ⋯: the shared borderless icon-btn, quiet until hovered,
     never shrinking under a long name. */
  .row-menu { flex: none; width: 24px; height: 24px; color: var(--text3); }
  .act {
    height: var(--ui-control-height); padding: 0 9px;
    background: var(--surface2); color: var(--text2);
    border: 1px solid var(--border); border-radius: var(--ui-radius-control);
    font-family: var(--font-ui); font-size: var(--fs-sub); cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast);
  }
  .act:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .act:disabled { opacity: 0.5; cursor: default; }
  .act.primary { color: var(--accent); border-color: var(--accent-bg); }
  .act.icon { padding: 0 7px; display: flex; align-items: center; }


  .err {
    color: var(--danger); background: var(--danger-bg);
    border-radius: var(--ui-radius-control); padding: 5px 8px; font-size: var(--fs-sub);
  }
</style>
