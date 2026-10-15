<script>
  import Terminal from '../terminal/Terminal.svelte';
  import Files from '../files/Files.svelte';
  import Board from './Board.svelte';
  import SideHandle from '../ui/SideHandle.svelte';
  import Icon from '../ui/Icon.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { drawerWindowPills, stateDotColor, stateIsLive } from './hub.ts';
  import { hoverInfo } from '../ui/hover.ts';

  let {
    compact = false, visible = false, fontSize = 14, selected = '',
    /** The project's declared path — where its Files partition starts (board #181). */
    projectPath = '',
    termTarget = '', drawerView = 'term',
    drawerFilesReq = null, drawerIssueReq = null, drawerBoardNew = null,
    agents = [], panes = [], winsExpanded = false,
    stateLabel = (state) => state, detailLabel = (detail) => detail, stateTone = () => undefined,
    drawerFilesDir = $bindable(''),
    onpick: pickWindow = () => {}, onclose: closeDrawer = () => {},
    onexpand = () => {}, onterminal = () => {}, onfiles = () => {},
    onboard = () => {}, onnewissue = () => {}, onfilesback = null,
  } = $props();

  // The shell window first, agents, the pane on screen; the rest fold (#92, #320).
  const bar = $derived(drawerWindowPills(agents, winsExpanded,
    (a) => termTarget.startsWith(`${selected}:${a.window}.`)));
  const winPills = $derived(bar.pills);
  const winsFolded = $derived(bar.folded);

  function pillInfo(a) {
    const lines = [{ label: t('hubHoverCommand'), value: a.command || '—' }];
    const n = panes.filter((p) => p.session === selected && p.window === a.window).length;
    if (n) lines.push({ label: t('hubHoverPanes'), value: String(n) });
    if (a.agent) lines.push({ label: t('hubHoverState'), value: [stateLabel(a.state), detailLabel(a.detail)].filter(Boolean).join(' · '), tone: stateTone(a.state, a.detail) });
    return { title: `${a.window}:${a.name}`, lines };
  }
</script>

<section class="drawer">
  {#if !compact}
    <SideHandle varName="--hub-drawer-w" storeKey="tmux_hub_drawer_w"
      min={320} max={900} def={520} edge="left" label={t('hubTerminal')} />
  {/if}
  <div class="drawer-head chat-head">
    {#if drawerView === 'term'}
      <div class="win-list">
        {#each winPills as a (a.window)}
          <button class="win-pill state-ctl" class:cur={termTarget.startsWith(`${selected}:${a.window}.`)} onclick={() => pickWindow(a)}
            aria-pressed={termTarget.startsWith(`${selected}:${a.window}.`)}
            use:hoverInfo={() => pillInfo(a)}>
            <span class="st" class:live-dot={!!a.agent && stateIsLive(a.state)} style:background={a.agent ? stateDotColor(a.state, a.detail) : stateDotColor('shell')}></span>
            {a.window}:{a.name}{#if a.agent && !a.managed}<span class="direct-tag">{t('hubDirect')}</span>{/if}
          </button>
        {/each}
        {#if winsFolded > 0 || winsExpanded}
          <button class="win-pill state-ctl more"
            aria-label={winsExpanded ? t('hubWinLess') : t('hubWinMore').replace('{n}', String(winsFolded))}
            use:hoverInfo={() => ({ title: winsExpanded ? t('hubWinLess') : t('hubWinMore').replace('{n}', String(winsFolded)) })}
            aria-expanded={winsExpanded}
            onclick={onexpand}>
            {winsExpanded ? '−' : `+${winsFolded}`}
          </button>
        {/if}
      </div>
      <span class="spacer"></span>
      <CommandButton variant="icon" icon="maximize" label={t('hubOpenFull')} onclick={onterminal} />
    {:else if drawerView === 'files'}
      <!-- Files carries its own path bar and toolbar; the head only says
           which partition this is and keeps the one close affordance. -->
      <span class="d-files"><Icon name="files" size={13} />{t('files')} — {selected}</span>
      <span class="spacer"></span>
      <CommandButton variant="icon" icon="maximize" label={t('hubFilesFull')} onclick={onfiles} />
    {:else}
      <!-- The board partition: the head names it, maximize hands off to
           the board PAGE — the same translation the files head makes.
           New-issue lives HERE (board #23): the embedded Board renders no
           page-head of its own — that row only repeated the project name
           this head already carries. -->
      <span class="d-files"><Icon name="layout" size={13} />{t('board')} — {selected}</span>
      <span class="spacer"></span>
      <CommandButton variant="icon" icon="plus" label={t('boardNew')} onclick={onnewissue} />
      <CommandButton variant="icon" icon="maximize" label={t('board')} onclick={onboard} />
    {/if}
    <CommandButton variant="icon" icon="x" label={t('close')} onclick={closeDrawer} />
  </div>
  <div class="term-body" class:off={drawerView !== 'term'}>
    {#if termTarget}
      {#key termTarget}
        <Terminal target={termTarget} session={selected} {fontSize} embedded chromeless active={visible && drawerView === 'term'} visible={visible && drawerView === 'term'} />
      {/key}
    {:else}
      <div class="empty">{t('hubNoPane')}</div>
    {/if}
  </div>
  {#if drawerView === 'files'}
    <!-- Per-project cwd is Files' own parked-position map (module-scoped,
         keyed by session), so each project wakes up where you left it. -->
    <div class="files-body appear">
      <Files session={selected} root={projectPath} guardPage="hub" visible={visible} {fontSize} singlePane jumped onGoBack={onfilesback} navRequest={drawerFilesReq} bind:currentDir={drawerFilesDir} />
    </div>
  {/if}
  {#if drawerView === 'board'}
    <!-- The task sidebar (board #13 follow-up): the REAL Board, embedded —
         no project sidebar, it follows this room's project. -->
    <div class="board-body appear">
      <Board session={selected} guardPage="hub" visible={visible && drawerView === 'board'} embedded issueRequest={drawerIssueReq} createRequest={drawerBoardNew} />
    </div>
  {/if}
</section>

<style>
  .drawer { position: relative; }
  /* The drawer's GROUND is the app's, not the terminal's (board #23): a
     hardcoded #000 here leaked out as a black seam beside the chat column —
     the terminal element paints its own theme-adapted background, so in
     light theme every uncovered sliver of the drawer read as a black line
     that matched nothing. The dark surface belongs to the terminal BODY
     alone; files/board partitions already carry var(--bg). */
  .drawer { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); border-left: 1px solid var(--border); }
  /* The header shares its dimensions with Chat through hub-atoms.css. */
  .win-list { display: flex; gap: var(--ui-gap); min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .win-list::-webkit-scrollbar { display: none; }
  .win-pill { display: flex; align-items: center; gap: var(--ui-gap); flex: none; box-sizing: border-box; height: var(--control-height); min-width: var(--control-height); background: var(--surface); background-clip: padding-box; border: solid transparent; border-width: var(--control-paint-inset) 0; border-radius: calc(var(--control-radius) + var(--control-paint-inset)); color: var(--text2); padding: 0 var(--menu-item-padding-x); font-family: var(--font-mono); font-size: var(--fs-sub); cursor: pointer; }
  .win-pill.cur { color: var(--accent-ink); background-color: var(--accent-bg); }
  .direct-tag { font-size: var(--fs-micro); color: var(--text3); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; margin-left: 3px; }
  .term-body { flex: 1; min-width: 0; min-height: 0; position: relative; display: flex; flex-direction: column; }
  /* The files partition replaces the terminal VISUALLY only: the terminal
     stays laid out under visibility:hidden so its box never changes size —
     a display:none would re-fit cols×rows and make every agent TUI repaint
     (the .keep-rows lesson). */
  .term-body.off { visibility: hidden; position: absolute; inset: 0; }
  .files-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .board-body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .board-body > :global(.board-root) { flex: 1; min-height: 0; }
  /* Parent-owned suppression (board #23, lead): the drawer head is the ONLY
     header this partition may have. The embedded Board renders no page-head
     of its own (its {#if !embedded} gate, pinned by the render test), but the
     drawer is the container that KNOWS the embedding — so it enforces the
     contract too: whatever a prop/HMR/child-path drift might leak, a second
     header can neither show nor keep its height here. */
  .board-body :global(.page-head) { display: none; }
  .d-files { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ONE switcher for the drawer. It used to have two: these pills on top and
     a tmux-style statusline underneath, both listing the same windows and both
     calling pickWindow (owner: "上面和下面有两个 bar…可以把它们合并一下").
     The pills won — they carry the state dot, the direct-window tag and the
     actions. The roster count the statusline left behind ("N · M running")
     was removed too (board #338, owner: it costs width the pills need): the
     pill's live dot is the running cue. */
</style>
