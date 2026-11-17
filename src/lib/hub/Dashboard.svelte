<script lang="ts">
  // The Dashboard view (board #109; design docs/design-docs/features/dashboard.md
  // § The view): what needs the person, where the project is, and what agents
  // told the person, for ONE project of the server whose scope holds it.
  // The derived facts are the server's (`hub_dashboard`, #108); who needs a
  // person is classified here with the client's one definition (needsPerson),
  // and Notes for you is the notification centre's one "to me" predicate
  // (toMe) over a room read that never moves the read mark (only the Hub's
  // feed calls hub_read).
  import { untrack } from 'svelte';
  import { poll, single } from '../core/poll.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { agoShort, stateDotColor, stateIsLive } from './hub.ts';
  import { agentSummary, countParts, foldNotes, isUnread, pickNotes, rememberStatusFolded, statusFoldedOf, BOARD_FOLD_KEY, NOTES_MAX_PAGES, NOTES_PAGE, type DashAgent } from './dashboard.ts';
  import { excerpt } from './notifications.ts';
  import Icon from '../ui/Icon.svelte';
  import AskCard from './AskCard.svelte';
  import { AskBook, askerState, closingSeq, isAsk } from './asks.svelte.ts';
  import { stoppedAgents } from './hub.ts';
  import type { AskClose, AskRow } from '../core/ws-api.ts';
  import { agentNames, type Names } from './names.ts';
  import ProjectPage from './ProjectPage.svelte';
  import type { PageHead } from './project-page.ts';

  type Note = { seq?: number; id?: number | string; ts?: number; from?: string; body?: string; to?: unknown; kind?: string; discuss?: boolean };
  type DashData = {
    asks: { seq: number; asker: string; question: string }[];
    board: { counts: Record<string, number>; oldest_doing: { id: number; title: string; assignee: string; last_change: number } | null };
    agents: DashAgent[];
    stopped: number;
    finished: { id: number; title: string; assignee: string; done_at: number }[];
    labels?: unknown;
    /** Board #111 (cap `dashboard_page`): the project page's head, or `page_error`. */
    page?: PageHead | null;
    page_error?: string;
  };

  type Api = {
    dashboard: (session: string) => Promise<unknown>;
    hubLog: (session: string, sinceTs?: number, limit?: number, beforeSeq?: number) => Promise<{ messages: unknown[]; has_more?: boolean; oldest_seq?: number }>;
    hubUnread: (rooms: Record<string, Record<string, never>>) => Promise<{ marks?: Record<string, { seq: number; ts: number }> }>;
    hubAskList: (session: string, all?: boolean) => Promise<{ asks: AskRow[] }>;
    hubAskAnswer: (session: string, seq: number, option?: string, text?: string) => Promise<AskClose>;
    hubAskDismiss: (session: string, seq: number) => Promise<AskClose>;
    pageLoad?: (session: string) => Promise<any>;
  };
  type Pushed = { room?: string; kind?: unknown; id?: unknown };

  let {
    api,
    connected = true,
    asksOn = false,
    pageOn = false,
    compact = false,
    onOpenFile = (_path: string) => {},
    onPageEdited = (_edited: boolean) => {},
    onPageGuard = (_editedNow: (() => boolean) | null) => {},
    slots = [],
    listen = null,
    now = Date.now(),
    session,
    room,
    visible = true,
    onOpenBoard = () => {},
    onOpenIssue = (_id: number) => {},
    foldKey = BOARD_FOLD_KEY,
    onOpenAgent = (_name: string) => {},
    onJump = (_m: Note) => {},
    onOpenChat = () => {},
  }: {
    /** The RPCs of the server whose scope holds the Board (it hands its own). */
    api: Api;
    /** Does the server's socket hold a login now? A close keeps the data, muted. */
    connected?: boolean;
    /** The server answers the ask RPCs (`asks` cap, #107): the cards are drawn only then. */
    asksOn?: boolean;
    /** The server announces `dashboard_page` (#111): the project page is drawn only then. */
    pageOn?: boolean;
    compact?: boolean;
    /** Open a file the project page links to (Files; Back returns here). */
    onOpenFile?: (path: string) => void;
    /** The project page holds a field the person edited (the Board's discard guard). */
    onPageEdited?: (edited: boolean) => void;
    /** The project page's LIVE "a field is edited now" read, for the Board's doors. */
    onPageGuard?: (editedNow: (() => boolean) | null) => void;
    /** The project's declared slots: who is stopped (an asker's state on its card). */
    slots?: { window_name: string; kind?: string }[];
    /** The server's pushed room lines (the Hub's own feed source): an ask, or the line
     * that closed one, re-reads this view's asks, so an answer given in the chat (or on
     * another client) repaints here, as it does there. Returns its unsubscribe. */
    listen?: ((fn: (m: Pushed) => void) => () => void) | null;
    /** The page's clock (the Board's one 1 s tick, visible-only): every age
     * is elapsed time against it, so it keeps moving after a failed poll
     * (leader #109 note 64) and freezes only while the page is hidden. */
    now?: number;
    session: string;
    room: string;
    visible?: boolean;
    onOpenBoard?: () => void;
    /** Board #150: an issue the block names (the oldest doing, a finished one) opens in this host's Board. */
    onOpenIssue?: (id: number) => void;
    /** Where this host remembers its fold (the Board tab's, or the drawer's board's). */
    foldKey?: string;
    onOpenAgent?: (name: string) => void;
    onJump?: (m: Note) => void;
    onOpenChat?: () => void;
  } = $props();


  let data = $state<DashData | null>(null);
  // Board #150 (the owner, 2026-11-17 03:14): the status block folds to one line so the project
  // page gets the room; per host, unfolded by default. Folding never touches the page.
  let statusOpen = $state(!statusFoldedOf(globalThis.localStorage ?? null, untrack(() => foldKey)));
  // The page's head: a read that could not read the page store (page_error)
  // keeps the last one; never "no page" (#108's rule).
  let pageHead = $state<PageHead | null>(null);
  let notes = $state<Note[]>([]);
  let notesCapped = $state(false);
  let mark = $state<{ seq: number } | null | undefined>(undefined);
  let failed = $state(false);
  let finishedOpen = $state(false);
  // The read's GENERATION: bumped when the project changes and when the view
  // goes, so a late answer of an earlier project is never shown (#335 rule).
  let gen = 0;
  // Notes holds only its lines (at most three, newest first), the newest seq scanned
  // (topSeen) and the first fill's 'more' (#109 R1, leader note 110): no raw pages. While
  // three are held, a poll reads only what is newer than topSeen.
  let held: { notes: Note[]; top: number; more: boolean } = { notes: [], top: 0, more: false };

  async function read() {
    // A hidden view starts no read of any origin (leader #109 note 62): an
    // entry read queued behind one in flight belongs to the showing that
    // queued it, so if the view was hidden again meanwhile it asks nothing.
    if (!visible) return;
    const mine = ++gen;
    const s = session, r = room;
    try {
      // The snapshot is ONE read: single()'s lock is held until every part has
      // settled (allSettled), so a part that fails early never frees it while
      // another is still in flight (#109 S4, validator note 49: Promise.all
      // let hide → show start a second dashboard read beside the first).
      const [dR, pageR, unreadR] = await Promise.allSettled([
        api.dashboard(s) as Promise<DashData>,
        api.hubLog(s, 0, NOTES_PAGE),
        api.hubUnread({ [r]: {} }),
      ]);
      if (mine !== gen) return;
      if (dR.status === 'rejected') throw dR.reason;
      if (pageR.status === 'rejected') throw pageR.reason;
      const d = dR.value, page0 = pageR.value;
      const unread = unreadR.status === 'fulfilled' ? unreadR.value : null;
      const top = (ms: Note[]) => Math.max(0, ...ms.map((m) => m.seq ?? 0));
      let picked: Note[], more: boolean, capped = false;
      if (held.notes.length >= 3) {
        // Three lines held (leader #109 note 30): never rescan held history.
        // Page 0 is read; only if its oldest seq is past topSeen + 1 (more
        // than a page arrived since) does it page back across that unseen
        // gap, down to topSeen and never past it. The gap bounds it, not the
        // first fill's 10-page stop: topSeen never moves past an unread row.
        const seen = held.top;
        const fresh = [(page0.messages as Note[]).filter((m) => (m.seq ?? 0) > seen)];
        let o = page0.oldest_seq ?? 0, gapMore = !!page0.has_more;
        while (o > seen + 1 && gapMore) {
          const p = await api.hubLog(s, 0, NOTES_PAGE, o);
          if (mine !== gen) return;
          fresh.push((p.messages as Note[]).filter((m) => (m.seq ?? 0) > seen));
          gapMore = !!p.has_more; o = p.oldest_seq ?? 0;
        }
        picked = foldNotes(held.notes, fresh);
        more = held.more;
      } else {
        // A first read (or fewer than three held): pages back until three
        // To-me lines or the room's start, at most NOTES_MAX_PAGES pages
        // (leader #109 note 5); the hard stop is said.
        const pages = [page0.messages as Note[]];
        more = !!page0.has_more;
        let before = page0.oldest_seq ?? 0;
        while (pickNotes(pages).length < 3 && more && pages.length < NOTES_MAX_PAGES && before > 0) {
          const p = await api.hubLog(s, 0, NOTES_PAGE, before);
          if (mine !== gen) return;
          pages.push(p.messages as Note[]);
          more = !!p.has_more; before = p.oldest_seq ?? 0;
        }
        picked = pickNotes(pages);
        capped = picked.length < 3 && more && pages.length >= NOTES_MAX_PAGES;
      }
      if (mine !== gen) return;
      held = { notes: picked, top: Math.max(held.top, top(page0.messages as Note[])), more };
      data = d;
      if (d.page_error == null) pageHead = d.page ?? null;
      followAsks(s, d);
      notes = picked;
      notesCapped = capped;
      mark = unread ? (unread.marks?.[r] ?? null) : undefined;
      failed = false;
    } catch {
      // Could not ask is never "nothing": the last complete data stays, muted.
      if (mine === gen) failed = true;
    }
  }
  const loader = single(read, () => `${session}|${room}`);
  // Needs you (AC2): #107's ONE ask component over this view's own AskBook (the store the
  // Hub uses, for the room this view shows). It follows the room at the view's read
  // boundaries (reconcile, the #107 rule) and on the server's push of an ask or a close.
  const book = new AskBook({
    hubAskList: (s, all) => api.hubAskList(s, all),
    hubAskAnswer: (s, seq, option, text) => api.hubAskAnswer(s, seq, option, text),
    hubAskDismiss: (s, seq) => api.hubAskDismiss(s, seq),
  });
  // A push while the view is hidden reads nothing (L6, every origin; leader note 76): it
  // marks the book stale, and the next showing's entry read (L4) reads it in full.
  let asksStale = false;
  let asksFor = '';
  function followAsks(s: string, d: DashData) {
    if (!asksOn) return;
    // Folded, the line needs only the count the snapshot carries: the ask rows wait for the
    // unfold (#150), the shape of #109 S8's hidden rule.
    if (!statusOpen) { asksStale = true; return; }
    if (asksStale) { asksStale = false; void book.load(s); return; }
    if (!book.ensure(s, d.asks.map((a) => a.seq))) void book.reconcile(s);
  }
  $effect(() => {
    if (!listen || !asksOn) return;
    const r = room, s = session;
    return listen((m) => {
      if (m?.room !== r || !(isAsk(m) || closingSeq(m) !== null)) return;
      if (!visible || !statusOpen) { asksStale = true; void (visible && loader()); return; }
      void book.load(s);
      void loader(); // the open list (and its count) is the server's: read it again
    });
  });
  const stopped = $derived(stoppedAgents(slots, (data?.agents ?? []).map((a) => ({ name: a.name })) as never));
  const roster = $derived((data?.agents ?? []).map((a) => ({ name: a.name, managed: true })));
  async function answer(seq: number, option?: string, text?: string) {
    const ok = await book.answer(seq, option, text);
    if (ok) void loader();
    return ok;
  }
  async function dismiss(seq: number) {
    if (await book.dismiss(seq)) void loader();
  }
  // A new project: forget the old one's data at once (no stale rows under a
  // new name), then read.
  $effect(() => {
    void session; void room;
    gen++; data = null; pageHead = null; notes = []; mark = undefined; failed = false; held = { notes: [], top: 0, more: false }; asksStale = false;
    // The project left: a read queued for it (a push while it was shown) never starts.
    untrack(() => { if (asksFor && asksFor !== session) book.retire(asksFor); asksFor = session; });
  });
  // Every ENTRY (a project change, or the view shown again) starts its own
  // read at once. `loader()` (not `tick`) queues behind a read of the same key
  // still in flight from before, whose answer the generation drops: A → B → A
  // and hidden → shown are read again, never left to the next poll (#109 S4).
  // Leaving bumps the generation, so nothing read before it lands after.
  $effect(() => {
    void session; void room;
    if (!visible) {
      gen++;
      // A full ask read a push queued while shown never starts hidden (S8): retired, and
      // the next showing reads the book in full.
      if (untrack(() => book.retire(session))) asksStale = true;
      return;
    }
    void untrack(() => loader());
    return poll(loader.tick, 20000);
  });
  // Not connected: the data stays, muted; a new login reads at once.
  $effect(() => {
    if (!connected) { failed = true; return; }
    untrack(() => { if (visible && data) void loader(); });
  });
  // Gone (the Board view chosen, the tree torn down): nothing read before
  // lands, and a queued entry read never starts (#109 S4).
  $effect(() => () => { gen++; loader.dispose(); book.dispose(); });

  // Unfolded again: the ask rows a folded block skipped are read now (#150).
  $effect(() => {
    if (!statusOpen || !visible) return;
    untrack(() => { if (asksOn && asksStale && data) { asksStale = false; void book.load(session); } });
  });
  const foldToggled = (e: Event) => {
    statusOpen = (e.currentTarget as HTMLDetailsElement).open;
    // Folded: an ask rows read queued while unfolded retires unrun (validator-2 R1), through the
    // one mechanism the hidden view uses (#109 S8); the next unfold reads the rows again.
    if (!statusOpen && untrack(() => book.retire(session))) asksStale = true;
    rememberStatusFolded(!statusOpen, globalThis.localStorage ?? null, foldKey);
  };
  const unreadNotes = $derived(notes.filter((m) => isUnread(m, mark)).length);

  const summary = $derived(data ? agentSummary(data.agents, data.stopped) : null);
  const labels: Names = $derived(agentNames(data?.labels ?? []));
  const counts = $derived(data?.board.counts ?? null);
  const STATUSES = ['todo', 'doing', 'review', 'done'];
  const COUNT_KEYS = { working: 'dashWorking', waiting: 'dashWaiting', idle: 'dashIdle', notRunning: 'dashNotRunning', needsYou: 'dashNeedYou', stopped: 'dashStopped' } as const;
</script>

<div class="dash" class:muted={failed} aria-busy={!data}>
  {#if failed}<div class="dash-note" role="status">{t('dashNotLive')}</div>{/if}
  {#if data && summary && counts}
    <!-- Board #150: the ONE status block, folding to its line (the 'Finished · 24 h' atom). The
         summary is the same line in both states; the middle part elides, the ask part never. -->
    <details class="dash-block" open={statusOpen} ontoggle={foldToggled}>
      <summary class="dash-fold-line">
        <span class="flip" class:on={statusOpen}><Icon name="chevron-down" size={11} /></span>
        <span class="fold-label">{t('dashStatus')}</span>
        {#if data.asks.length}<span class="fold-asks">· <span class="b-count side-unread">{data.asks.length}</span> {t(data.asks.length === 1 ? 'dashFoldAsk' : 'dashFoldAsks')}</span>{/if}
        {#if countParts(summary.counts).length}<span class="fold-mid">· {countParts(summary.counts).map((p) => t(COUNT_KEYS[p.key]).replace('{n}', String(p.n))).join(' · ')}</span>{/if}
        {#if unreadNotes}<span class="fold-unread">· {t('dashFoldUnread').replace('{n}', String(unreadNotes))}</span>{/if}
      </summary>
      <div class="dash-block-body">
    <section class="dash-sec" aria-label={t('dashNeedsYou')}>
      <h2 class="menu-heading">{t('dashNeedsYou')} · {data.asks.length}</h2>
      <div class="dash-asks" data-asks={data.asks.length}>
        {#each data.asks as a (a.seq)}
          {@const row = asksOn ? book.rows[a.seq] : undefined}
          {#if row}
            <AskCard compact {now} ask={row} names={labels} asker={askerState(row.asker, roster, stopped)} refused={book.refused[a.seq] ?? ''} error={book.errors[a.seq] ?? ''} stale={book.failed}
              draft={book.drafts[a.seq]} ondraft={(dr) => book.setDraft(a.seq, dr)} busy={!!book.busy[a.seq]}
              onanswer={(option, words) => answer(a.seq, option, words)} ondismiss={() => dismiss(a.seq)}
              ondiscuss={() => onJump({ seq: a.seq, discuss: true })} onopen={() => onJump({ seq: a.seq })} />
          {:else}
            <!-- Not loaded (yet, folded, or its read failed): who asks what, never a second card;
                 a door to the ask's bubble (#150). -->
            <button type="button" class="dash-door dash-meta" onclick={() => onJump({ seq: a.seq })}>{labels.shown(a.asker)}: {a.question}</button>
          {/if}
        {/each}
      </div>
    </section>

    <section class="dash-sec" aria-label={t('dashNow')}>
      <h2 class="menu-heading">{t('dashNow')}</h2>
      <button type="button" class="dash-line side-wins" onclick={onOpenBoard} aria-label={t('dashOpenBoard')}>
        {#each STATUSES as st (st)}
          <span class="side-win"><span class="side-win-name">{t(`boardStatus_${st}`)}</span><span class="b-count">{counts[st] ?? 0}</span></span>
        {/each}
      </button>
      {#if data.board.oldest_doing}
        {@const o = data.board.oldest_doing}
        <button type="button" class="dash-door dash-meta" onclick={() => onOpenIssue(o.id)}>{t('dashOldestDoing').replace('{id}', String(o.id)).replace('{title}', o.title)} · {t('dashLastChange')} {agoShort(o.last_change * 1000, now)}</button>
      {/if}
      {#if countParts(summary.counts).length}
        <div class="dash-meta" data-counts>{countParts(summary.counts).map((p) => t(COUNT_KEYS[p.key]).replace('{n}', String(p.n))).join(' · ')}</div>
      {/if}
      {#each summary.rows as a (a.name)}
        <button type="button" class="dash-agent" onclick={() => onOpenAgent(a.name)}>
          <span class="side-win">
            <span class="side-win-dot" class:live-dot={stateIsLive(a.state)} style:background={stateDotColor(a.state, a.detail ?? '')} aria-hidden="true"></span>
            <span class="side-win-name whole">{labels.shown(a.name)}</span>
          </span>
          {#if a.issue}<span class="dash-issue">#{a.issue.id} {a.issue.title}</span>{/if}
          {#if a.status}<span class="dash-status"><span class="dash-status-text">{a.status.text}</span><span class="side-age">{agoShort(a.status.ts, now)}</span></span>{/if}
        </button>
      {/each}
      {#if data.finished.length}
        <details class="dash-finished" bind:open={finishedOpen}>
          <summary><span class="flip" class:on={finishedOpen}><Icon name="chevron-down" size={11} /></span>{t('dashFinished')} · {data.finished.length}</summary>
          {#each data.finished as f (f.id)}
            <button type="button" class="dash-door dash-meta dash-done" onclick={() => onOpenIssue(f.id)}><span class="dash-done-text">#{f.id} {f.title}{f.assignee ? ` · ${labels.shown(f.assignee)}` : ''}</span><span class="side-age">{agoShort(f.done_at * 1000, now)}</span></button>
          {/each}
        </details>
      {/if}
    </section>

    <section class="dash-sec" aria-label={t('dashNotes')}>
      <h2 class="menu-heading">{t('dashNotes')}</h2>
      {#each notes as m (m.seq ?? m.id)}
        <button type="button" class="dash-note-row" class:fresh={isUnread(m, mark)} onclick={() => onJump(m)}>
          {#if isUnread(m, mark)}<span class="unread-dot" aria-label={t('dashUnread')}></span>{/if}
          <span class="dash-from">{labels.shown(m.from ?? '')}</span>
          <span class="side-age">{agoShort(m.ts ?? 0, now)}</span>
          <span class="dash-text">{excerpt(m.body ?? '', 120)}</span>
        </button>
      {/each}
      {#if notesCapped}<div class="dash-meta">{t('dashNotesCapped')}</div>{/if}
      <button type="button" class="dash-more" onclick={onOpenChat}>{t('dashAllInChat')}</button>
    </section>
      </div>
    </details>

    {#if pageOn && pageHead && api.pageLoad}
      <!-- The LAST section (board #111): it can neither draw over Needs you nor push it away. -->
      <ProjectPage api={api as { pageLoad: NonNullable<Api['pageLoad']> }} {session} head={data.page_error == null ? pageHead : undefined} {visible} {now} {compact}
        shown={(n) => labels.shown(n)} {onOpenFile} onEdited={onPageEdited} onGuard={onPageGuard} />
    {/if}
  {/if}
</div>

<style>
  .dash { display: flex; flex-direction: column; gap: 12px; padding: 12px; min-width: 0; }
  .dash.muted { opacity: var(--control-disabled-opacity); }
  .dash-sec { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .dash-sec > h2 { margin: 0; padding-left: 0; }
  .dash-asks { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .dash-line, .dash-agent, .dash-note-row, .dash-more {
    display: flex; align-items: center; gap: 8px; min-width: 0; min-height: var(--control-height);
    padding: 0 4px; border: none; background: none; color: var(--text); text-align: left; cursor: pointer;
    font: 400 var(--fs-sub)/1.4 var(--font-ui); border-radius: var(--control-radius);
  }
  .dash-line { flex-wrap: wrap; }
  .dash-line:hover, .dash-agent:hover, .dash-note-row:hover, .dash-more:hover { background: var(--surface2); }
  .dash-agent { flex-wrap: wrap; }
  .dash-meta, .dash-issue, .dash-status, .dash-note { font: 400 var(--fs-meta)/1.4 var(--font-ui); color: var(--text2); min-width: 0; }
  .dash-issue, .dash-status-text, .dash-done-text, .dash-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The words may elide; an age never does: it is the shared .side-age atom
     (flex: none), placed right after its words (#109 S5, measured at 320/390). */
  .dash-status, .dash-done { display: flex; align-items: baseline; gap: 6px; max-width: 100%; min-width: 0; }
  .dash-status-text, .dash-done-text { min-width: 0; }
  .dash-status > .side-age, .dash-done > .side-age, .dash-note-row > .side-age { margin-left: 0; }
  .dash-from { flex: none; }
  .dash-from { font-weight: 600; font-family: var(--font-display); } /* a name is WHO: the display role (fonts.md) */
  /* The chip is placed in a row it may fill (its name wears the atom's
     `.whole` variant, app.css): it ellipsizes only past the row's width. */
  .dash-agent .side-win { max-width: 100%; min-width: 0; }
  /* A narrow Dashboard: the note's text takes its own line under sender and age.
     By the width the view HAS (the Board's `board` container: the Board tab beside
     its project list, or the Hub drawer at any width), not by the viewport (#147);
     760 is the design language's one compact breakpoint. */
  @container board (max-width: 760px) {
    .dash-note-row { flex-wrap: wrap; row-gap: 0; padding-block: 4px; }
    .dash-note-row .dash-text { flex-basis: 100%; }
  }
  .dash-text { flex: 1 1 auto; }
  .dash-note-row.fresh .dash-text { color: var(--text); }
  .dash-more { color: var(--accent-ink); font-size: var(--fs-meta); }
  /* A tappable control like every other in the view: the control height
     (44px on touch), #109 S3. */
  .dash-finished > summary {
    display: flex; align-items: center; min-height: var(--control-height); padding: 0 4px;
    cursor: pointer; font: 400 var(--fs-meta)/1.4 var(--font-ui); color: var(--text2); border-radius: var(--control-radius);
  }
  .dash-finished > summary { gap: 6px; }
  .dash-finished > summary::-webkit-details-marker { display: none; }
  .dash-finished > summary:hover { background: var(--surface2); }
  /* Board #150: the status block and its one line (the disclosure atom above, one row). */
  .dash-block { min-width: 0; }
  .dash-block-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding-top: 4px; }
  .dash-block > summary {
    display: flex; align-items: center; gap: 6px; min-width: 0; min-height: var(--control-height); padding: 0 4px;
    cursor: pointer; font: 400 var(--fs-meta)/1.4 var(--font-ui); color: var(--text2); border-radius: var(--control-radius);
    white-space: nowrap; overflow: hidden;
  }
  .dash-block > summary::-webkit-details-marker { display: none; }
  .dash-block > summary:hover { background: var(--surface2); }
  .dash-block > summary > :not(.fold-mid) { flex: none; }
  .fold-label { font-weight: 600; color: var(--text); }
  .fold-mid { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* Doors that were text (#150): the row dialect of the view's other doors. */
  .dash-door { display: flex; align-items: baseline; gap: 6px; min-height: var(--control-height); padding: 0 4px; border: none; background: none;
    text-align: left; cursor: pointer; border-radius: var(--control-radius); width: 100%; }
  .dash-door:hover { background: var(--surface2); }
</style>
