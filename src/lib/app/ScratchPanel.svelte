<script>
  // The scratch terminal (board #324, owner 2026-10-09: "有点像 iTerm 或 Ghost
  // 里的那种全局 Terminal 模式…跟你的项目没有关系，我就是单纯想在系统上去运行个
  // Terminal"): a quake-style panel over the current page, from the bottom or
  // the left, hosting the ONE project-less tmux session the server owns
  // (projects/scratch.rs). Desktop only — App renders it only off touch.
  //
  // App keeps the frame's STATE (open, edge, sizes) outside the server key;
  // this component is rendered INSIDE the server-bound tree, so a server
  // switch destroys it with its Terminal and subscription. `live` goes false
  // the moment a switch starts: every pending ensure/kill/focus completion is
  // dropped from then on (one intent counter), and nothing ensures again until
  // the reader opens the panel on the server they are on.
  //
  // Closing HIDES the panel (the session keeps running, the Terminal stays
  // mounted and records frames without rendering, rule 7); Kill ends the
  // session. Escape belongs to the shell inside: it closes the panel only from
  // the head's own controls.
  //
  // The panel docks at the BOTTOM or the RIGHT (board #326, owner 2026-10-09:
  // "这个 terminal 应该可以显示在下方或右侧 上面的按钮不用写'bottom'之类的文字
  // 了 你用两个小图标去做状态切换"); the right dock reuses the vertical axis's
  // stored size, so a reader who had chosen `left` keeps their width.
  import { tick, untrack, onDestroy } from 'svelte';
  import Terminal from '../terminal/Terminal.svelte';
  import SideHandle from '../ui/SideHandle.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { scratchSession, scratchKill, scratchRelease } from '../core/ws.ts';
  // From rpc-codes, not ws.ts: the mount fixtures mock ws.ts, and a constant
  // read as `undefined` there would silently disable the action (#337).
  import { ERR_SCRATCH_HELD, ERR_SCRATCH_STALE } from '../core/rpc-codes.ts';

  let {
    open = false, live = true, edge = 'bottom', fontSize = 14,
    onclose = () => {}, onedge = (_e) => {},
  } = $props();

  let phase = $state('idle');     // idle | opening | ready | ended | error
  let target = $state('');
  let session = $state('');       // the server's name for it (never spelled here)
  let error = $state('');
  let killAsk = $state(false);
  let killing = $state(false);
  let killError = $state('');
  // The reserved name is held by a project (board #337), so the refusal
  // carries a way out instead of being a dead end. Keyed on the server's
  // error CODE, never on its sentence: the message is the server's one
  // composition for the human, and parsing it here would be a second copy.
  //
  // The refusal's DATA is kept as a snapshot — which project, which session —
  // and sent back with the release: the reader confirms THAT project, and the
  // server renames only if it still holds the name. Without the snapshot the
  // action would mean "rename whoever holds it when I run", which is not what
  // was on screen when they said yes (#337 review).
  let held = $state(null);
  let releaseAsk = $state(false);
  let releasing = $state(false);
  let releaseError = $state('');
  let panelEl = $state(null);
  let opener = null;              // what had focus when the panel opened
  let intent = 0;                 // one counter for every async completion
  const mine = (n) => n === intent && live;

  async function ensure() {
    const n = ++intent;
    phase = 'opening'; error = '';
    try {
      const r = await scratchSession();
      if (!mine(n)) return;
      target = r.target;
      session = r.session;
      phase = 'ready';
      if (open) void focusTerminal(n);
    } catch (e) {
      if (!mine(n)) return;
      phase = 'error'; error = e?.message ?? String(e);
      const by = e?.code === ERR_SCRATCH_HELD ? e?.data : null;
      held = by?.projectId && by?.session ? by : null;
    }
  }

  async function release() {
    const n = intent;
    const who = held;
    if (!who) return;
    releasing = true; releaseError = '';
    try {
      await scratchRelease(who.projectId, who.session);
      if (!mine(n)) return;
      releaseAsk = false;
      held = null;
      await ensure();              // the name is free: open on a live shell
    } catch (e) {
      if (!mine(n)) return;
      // The snapshot the reader confirmed is stale and NOTHING was renamed
      // (board #337, orchestrator 19:07). A sentence about a project that has
      // since moved on leaves them where the incident left them, so the panel
      // drops the stale snapshot and asks once what is true now: free, and it
      // opens; still held, and `ensure`'s own refusal names the CURRENT holder
      // and offers the action again. The new confirmation is not opened for
      // them — it names a project they have not looked at yet, and approving
      // one project must never carry over to another (the review that made
      // this snapshot exist at all).
      if (e?.code === ERR_SCRATCH_STALE) {
        releaseAsk = false; releaseError = ''; held = null;
        await ensure();
        return;
      }
      releaseError = e?.message ?? String(e);
    } finally { releasing = false; }
  }
  /** Focus only once the Terminal is mounted AND the panel is shown. */
  async function focusTerminal(n) {
    await tick();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (!mine(n) || !open || !panelEl) return;
    panelEl.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true });
  }

  // Only the reader's OPENING (and an explicit Open again) ensures: the
  // effect tracks `open` and `live` alone, so an answer — success or a
  // refusal — never triggers the next ensure (#324 review: an error state
  // re-ensured in a loop).
  //
  // `ended` ensures too (board #326). It did not, and that is why the owner
  // kept opening the panel on nothing: a hidden Terminal stays subscribed, so
  // a session that ended behind the panel's back (before #326 the shell's own
  // `exit` did exactly that) delivered `pane_closed` while the panel was
  // CLOSED, leaving `phase = 'ended'` and no target — and the next open did
  // not ensure, so it showed the bare "Session ended" line instead of a
  // prompt. Opening now converges on a live session from every state the
  // panel knows about; `ready` still trusts what it has until the
  // subscription says otherwise.
  $effect(() => {
    if (!live) { intent++; return; }
    if (open) untrack(() => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && !panelEl?.contains(a)) opener = a;
      if (phase === 'ready') void focusTerminal(intent);
      else void ensure();
    });
    else untrack(restoreFocus);
  });
  // A destroyed panel (the server-keyed tree unmounting) drops whatever is
  // still in flight, whatever order the switch tore things down in.
  onDestroy(() => { intent++; });
  function restoreFocus() {
    if (!panelEl?.contains(document.activeElement)) return;
    // Back to where the reader was — only if focus is still ours to give
    // and that control is still there to take it.
    const back = opener;
    opener = null;
    if (back?.isConnected && back.checkVisibility?.() !== false && !back.closest('[inert]')) back.focus({ preventScroll: true });
    else (document.activeElement)?.blur?.();
  }

  function ended() { target = ''; phase = 'ended'; }

  async function kill() {
    const n = intent;
    killing = true; killError = '';
    try {
      await scratchKill();
      if (!mine(n)) return;
      killAsk = false;
      ended();
      onclose();
    } catch (e) {
      if (mine(n)) killError = e?.message ?? String(e);
    } finally { killing = false; }
  }
  function onHeadKey(e) {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onclose(); }
  }
</script>

<section class="scratch" class:open class:right={edge === 'right'} bind:this={panelEl}
  inert={!open} aria-hidden={!open} aria-label={t('scratchTitle')}>
  {#if edge === 'right'}
    <!-- Docked RIGHT, the grab edge is the panel's LEFT side: dragging left
         grows it, which is the handle's own `left` reading. -->
    <SideHandle varName="--scratch-w" storeKey="tmux_scratch_w" min={280} max={1400} def={560} edge="left" label={t('scratchTitle')} always />
  {:else}
    <SideHandle varName="--scratch-h" storeKey="tmux_scratch_h" min={160} max={1200} def={320} edge="top" label={t('scratchTitle')} always />
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <header class="scratch-head" onkeydown={onHeadKey} role="toolbar" aria-label={t('scratchTitle')} tabindex="-1">
    <span class="scratch-name">{t('scratchTitle')}</span>
    <span class="spacer"></span>
    <Segmented options={[{ value: 'bottom', label: t('scratchBottom'), icon: 'panel-bottom' }, { value: 'right', label: t('scratchRight'), icon: 'panel-right' }]}
      value={edge} onchange={(v) => onedge(v)} ariaLabel={t('scratchEdge')} />
    <CommandButton variant="icon" icon="stop" label={t('scratchKill')} disabled={phase !== 'ready'} onclick={() => { killError = ''; killAsk = true; }} />
    <CommandButton variant="icon" icon="x" label={t('close')} onclick={onclose} />
  </header>
  <div class="scratch-body">
    {#if target}
      <Terminal {target} {session} {fontSize} embedded chromeless active={open} visible={open} onPaneExit={ended} />
    {:else}
      <div class="scratch-state">
        {#if phase === 'opening'}<span>{t('scratchOpening')}</span>
        {:else if phase === 'ended'}<span>{t('scratchEnded')}</span><CommandButton variant="secondary" label={t('scratchOpenAgain')} onclick={ensure} />
        {:else if phase === 'error'}<span class="scratch-err">{error}</span>
          {#if held}<CommandButton variant="secondary" icon="swap-h" label={t('scratchRelease')} onclick={() => { releaseError = ''; releaseAsk = true; }} />{/if}
          <CommandButton variant="secondary" label={t('scratchOpenAgain')} onclick={ensure} />
        {/if}
      </div>
    {/if}
  </div>
</section>

<ConfirmDialog open={killAsk} busy={killing} error={killError} confirmIcon="stop"
  title={t('scratchKillTitle')} note={t('scratchKillNote')} confirmLabel={t('scratchKill')}
  onconfirm={kill} oncancel={() => { if (!killing) killAsk = false; }} />

<!-- Releasing renames another project's session, so it is a confirmation with
     the consequence spelled out, not a button that just does it. Neutral, not
     danger: nothing is deleted and the project keeps everything but the name. -->
<ConfirmDialog open={releaseAsk} busy={releasing} error={releaseError} danger={false} confirmIcon="swap-h"
  title={t('scratchReleaseTitle')} note={t('scratchReleaseNote').replace('{p}', held?.projectName ?? '').replace('{s}', held?.session ?? '')} confirmLabel={t('scratchRelease')}
  onconfirm={release} oncancel={() => { if (!releasing) releaseAsk = false; }} />

<style>
  /* Over the content area (right of the rail), a tool panel, not a modal: no
     backdrop. One slide on --t-move; closed it is off-screen, hidden and
     inert, so nothing in it is reachable. */
  .scratch {
    position: fixed; z-index: 20; display: flex; flex-direction: column;
    left: var(--shell-left, 0px); right: 0; bottom: 0;
    /* A stored size never outgrows the window it is restored into or shrinks
       with: the head and its handle stay on screen (#324 review). */
    height: min(var(--scratch-h, 320px), calc(100vh / var(--ui-zoom, 1) - 80px));
    background: var(--bg); border-top: 1px solid var(--border);
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18);
    transform: translateY(100%); visibility: hidden;
    transition: transform var(--t-move) ease, visibility 0s linear var(--t-move);
  }
  .scratch.right {
    /* Fixed, so it adds the status-bar inset itself (#332): a tablet in the
       desktop layout shows this panel, and main's padding never reaches it.
       The width still subtracts the rail (--shell-left), so a stored size
       cannot cover the controls on the far side. */
    left: auto; top: var(--sat, 0px); height: auto;
    width: min(var(--scratch-w, 560px), calc(100vw / var(--ui-zoom, 1) - var(--shell-left, 0px) - 80px));
    border-top: none; border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
    transform: translateX(100%);
  }
  .scratch.open { transform: none; visibility: visible; transition: transform var(--t-move) ease; }
  .scratch-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px; min-height: 36px; box-sizing: border-box; border-bottom: 1px solid var(--border); outline: none; }
  .scratch-name { font-size: var(--fs-meta); color: var(--text2); font-family: var(--font-mono); }
  .spacer { flex: 1; }
  .scratch-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .scratch-body > :global(*) { flex: 1; min-width: 0; }
  .scratch-state { display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--text3); font-size: var(--fs-ui); }
  .scratch-err { color: var(--danger-ink); }
  @media (prefers-reduced-motion: reduce) { .scratch, .scratch.open { transition: none; } }
</style>
