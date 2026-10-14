<script lang="ts">
  import CommandButton from '../ui/CommandButton.svelte';
  /* The project task board (owner, 2026-08-29: "引入一个新的看板功能…人类有一个
     看板页面，能写任务issue，agent也可以读任务，修改任务状态，在看板上记录信息
     状态"). This is the HUMAN's half; agents read and update the same issues
     through `tmm board`. Four fixed columns — the status vocabulary is shared
     with the CLI (`projects::BOARD_STATUSES`), so a free-text status here
     would fork the language. Lives in the Hub drawer as a partition, like the
     terminal and Files. */
  import type { BoardIssue, BoardCountRow, HubAgent } from '../core/ws.ts';
  import { projectAgeLabel, sortRows } from '../projects/projects.ts';
  import { boardStatusColor, localWhen, splitImages } from './hub.ts';
  import { createStager, attachPaste, type Stager } from './attachments.svelte.ts';
  import AttachStrip from './AttachStrip.svelte';
  import ChatImage from './ChatImage.svelte';
  import Lightbox from '../ui/Lightbox.svelte';
  import type { ProjectRow } from '../projects/projects.ts';
  import { t, hanLang } from '../core/i18n.svelte.ts';
  import { onDestroy, untrack, tick } from 'svelte';
  import { registerLeaveGuard } from '../app/leave-guards.ts';
  import { useServerScope } from '../app/server-context.ts';
  import ServerTag from '../ui/ServerTag.svelte';
  import { titleFit } from '../ui/title-fit.ts';
  import type { BoardUnion, BoardUnionRow } from '../app/hub-union.svelte.ts';
  import { sessionRef, refKey, type SessionRef } from '../app/refs.ts';
  import Icon from '../ui/Icon.svelte';
  import Select from '../ui/Select.svelte';
  import SideHandle from '../ui/SideHandle.svelte';
  import { moveTrack, pinTrack } from './reveal.ts';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import OperationFeedback from '../ui/OperationFeedback.svelte';
  import { feedbackPosition } from '../ui/feedback-position.ts';
  import { copyText } from '../core/clipboard.ts';
  import { scheduleCompletion } from '../ui/feedback-lifetime.ts';
  import { draftOf, draftDirty, draftValid, draftPatch, rebaseDraft, issueRef, countsOf, applyCounts, visibleBoards, boardTitle, assignNotes, chipCols, assigneeView, rememberBackends } from './board.ts';
  import { messageActsSet, messageActsCopyLanded, messageActsCopyFailed, messageActsExpired, MESSAGE_ACTS_IDLE, type MessageActsState } from './message-actions.ts';
  import { scrollFade } from '../core/scrollFade.ts';
  import { flip } from 'svelte/animate';
  import { moveMs, revealMs } from '../ui/motion.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import { slideIndicator } from '../ui/indicator.ts';
  import { selectionClickGuard } from '../ui/native-context-menu.ts';
  import ScopeNote, { type ScopeNoteSpec } from '../app/ScopeNote.svelte';

  // The scope whose subtree holds this board, read once at init: its runtime
  // for the leave guard (#335 ②b-2-3) and the RPCs (②b-3), its state for that
  // server's backend catalog (the assignee faces).
  const scope = useServerScope();
  // A board always lives in a server's subtree (the page, the Hub drawer).
  if (!scope) throw new Error('Board needs a server scope');
  const guardOwner = scope.runtime;
  const serverId = guardOwner.id;
  const catalog = scope.state.backends;
  const backendIcon = catalog.icon;
  const { boardList, boardGet, boardSave, boardNote, boardDelete, boardCounts, projectList, hubAgents, hubPost, hubRooms } = guardOwner.api;
  /** `union` (board #357, owner 2026-10-13: "在 Terminal 页面和 Board 页面，都
   * 没有整合两种或几种不同连接里的所有项目"): App's one projects union source
   * for the Board family (`hub-union.svelte.ts` createBoardUnion) and the
   * included set. This Board PUBLISHES its server's slice (rows, clock,
   * counts, answered/failed) and the VISIBLE one renders the merged list in
   * its sidebar, each row tagged by the ③c-1 rule. A foreign row's pick is
   * the host's (`onPickServer`: focus that server, land on that board — D2);
   * the board body stays this server's (D3). Null in Single: this server's
   * list, untagged, as before. */
  let { session = '', visible = true, onGoBack = null, issueRequest = null, embedded = false, createRequest = null, jumped = false, sideCollapsed = false, guardPage = '', union = null, scopeNote = null, onPickServer = null }: { guardPage?: string; session?: string; visible?: boolean; onGoBack?: ((fn: () => boolean) => void) | null; issueRequest?: { session: string; id: number; n: number } | null; embedded?: boolean; createRequest?: { n: number } | null; jumped?: boolean; sideCollapsed?: boolean; union?: { source: BoardUnion; included: readonly { id: string; name: string }[] } | null; scopeNote?: ScopeNoteSpec | null; onPickServer?: ((ref: SessionRef) => void) | null } = $props();

  // The project sidebar follows the shell-wide collapse (board #200) with the
  // Hub's reveal: pinned at its width, the track's factor moving (reveal.ts).
  let rootEl = $state<HTMLElement | null>(null);
  let sideEl = $state<HTMLElement | null>(null);
  let sideWasCollapsed = untrack(() => sideCollapsed); // the rest state at mount; the effect moves from it
  $effect(() => {
    const collapsed = sideCollapsed;
    if (collapsed === sideWasCollapsed) return;
    sideWasCollapsed = collapsed;
    if (!visible || embedded || narrowVp || !rootEl || !sideEl) return;
    const unpin = pinTrack(sideEl, 'end');
    void moveTrack(rootEl, '--side-open', collapsed ? 1 : 0).then(unpin);
  });

  // Every project has its OWN board (issues are session-scoped like the chat
  // room), so the page carries the shared project sidebar (owner, 2026-08-29:
  // "board是不是也有一个侧边栏，我可以选择不同的项目"). The prop is the
  // FOLLOW default — the last-touched session, same as Files — and a pick
  // here overrides it until the prop moves again.
  let cur = $state('');
  let viewGeneration = 0, readSequence = 0;
  // ── Who a request belongs to (board #329 review): every submit freezes its
  // context at entry — the session, the issue, and this generation, bumped
  // whenever the project or the open issue changes and when the page is
  // destroyed (a server switch remounts it: the page's lifetime IS the
  // server's). Each follow-on RPC, success, catch, clear and refetch first
  // asks `owns(ctx)`; a request whose context is gone stops and touches
  // nothing — never the live cur/sel. While a request runs its editors are
  // locked (busy) and leaving waits for it, so no newer input can be cleared.
  let opGen = 0;
  let alive = true;
  type OpCtx = { session: string; id: number | null; gen: number };
  const freeze = (): OpCtx => ({ session: cur, id: sel?.id ?? null, gen: opGen });
  const owns = (c: OpCtx) => alive && c.gen === opGen;
  onDestroy(() => { alive = false; opGen++; viewGeneration++; readSequence++; setNoteActions(-1); createStage.clear(); bodyStage.clear(); noteStage.clear(); endLeaveAsk?.(true); });
  let picked = $state(false);      // a manual pick overrides the session follow
  // The Board sheet's own condition (≤760px — the old media gate, expressed
  // where the class is applied; see app.css .side-sheet).
  let narrowVp = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const fn = () => { narrowVp = mq.matches; };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  });
  let sideOpen = $state(false);    // compact: the hamburger DRAWER (same dialect
                                   // as Chat/Terminal — reopened #11, no more
                                   // second-page drilldown)
  // UNSAVED WORK blocks the silent follow — a dirty edit or typed create
  // data alike (board #11; #29 review): the prop moving under either would
  // reset the view and wipe it with no confirm, bypassing the shared
  // ConfirmDialog. The board keeps its current project until the user
  // explicitly cancels/creates/saves; the effect reads both flags, so the
  // moment they clear it follows again.
  $effect(() => { if (session && (!picked || !cur) && !dirty && !noteDirty && !createDirty && !submitting) cur = session; });
  // A jump from the feed's board line (board #13 follow-up): the request names
  // its OWN session — a manual pick may have parked this page on another
  // project, and the issue id is session-gated. The dirty-draft guard still
  // stands between the jump and an open edit. With no issue (`id` 0) it is a
  // LANDING on that project's board LIST — a union row of this server picked
  // from another server's Board (#357, D2): it opens no issue and leaves any
  // open detail through the same guard (dirty → Keep/Discard).
  //
  // A landing is HELD, not consumed on arrival (reviewer P1-B on 390ba4dd): the
  // guard refuses while this board's own request is running (`submitting`),
  // and a request marked seen before the guard ran was dropped for good. Only
  // the NEWEST request is kept, and it is taken once nothing of this board is
  // committing.
  //
  // The held landing and the guard continuation it may park share ONE
  // eligibility (reviewer R2 on 0feb403e and c728ac80; orchestrator ruling):
  //   displayed  — this board is shown (`visible`),
  //   focused ∧ serving — asked of the HOST (`scope.eligible()`: this tree is
  //                 the current binding and its runtime still serves; a leave
  //                 question that merely REVEALS a background tree is not the
  //                 focus, and a runtime detached under a still-mounted tree
  //                 can serve nothing),
  //   same request — the parent's request is still this one,
  //   not destroyed.
  // It is evaluated at the hold, when the board frees, and right before the
  // continuation runs; any false VOIDS the landing and withdraws the
  // Keep/Discard it parked — there is no replay when the person comes back.
  // The existing guard; no new modal. The board never imports CURRENT or
  // compares ids as a stand-in for the handle.
  let issueReqSeen = $state(0);
  let landing = $state<{ session: string; id: number; n: number } | null>(null);
  let landingGen = 0;
  let landingParked: (() => void) | null = null;
  let landingParkedOk: (() => boolean) | null = null;   // is the parked question still the landing's to ask?
  const eligible = () => visible && (scope.eligible ? scope.eligible() : true) && alive;
  function voidLanding() {
    landingGen++;
    landing = null;
    if (landingParked && pendingDiscard === landingParked) pendingDiscard = null;
    landingParked = null; landingParkedOk = null;
  }
  $effect(() => {
    const req = issueRequest;
    const ok = req ? eligible() : false;
    untrack(() => {
      if (!req) { if (landing || landingParked) voidLanding(); return; }
      if (req.n === issueReqSeen) return;
      issueReqSeen = req.n;
      voidLanding();            // a newer selection voids the older one
      if (ok) landing = req;    // held only by a board that can act on it NOW
    });
  });
  // A question the landing parked is the landing's too: it goes with it.
  $effect(() => { const ok = eligible(); if (!ok && landingParked) untrack(voidLanding); });
  $effect(() => {
    const req = landing;
    if (!req) return;
    const ok = eligible();
    if (!ok) { untrack(voidLanding); return; }
    if (submitting) return;
    untrack(() => {
      const gen = landingGen;
      landing = null;
      const run = () => {
        if (gen !== landingGen || !eligible()) return;      // the last look, right before it runs
        landingParked = null; landingParkedOk = null;
        if (req.session && req.session !== cur) { cur = req.session; picked = !embedded; }
        creating = false; sideOpen = false;
        if (req.id) void openIssue(req.id);
        else sel = null;
      };
      landingParked = run;
      landingParkedOk = () => gen === landingGen && eligible();
      guard(run);
      if (pendingDiscard !== run) { landingParked = null; landingParkedOk = null; }
    });
  });
  // Embedded, the new-issue button lives in the DRAWER head (board #23: the
  // embedded page-head was one redundant project-name row), so creation
  // arrives as a request. The dirty-draft guard still stands.
  let createReqSeen = $state(0);
  $effect(() => {
    const req = createRequest;
    if (!req || req.n === createReqSeen) return;
    createReqSeen = req.n;
    guard(() => { sel = null; creating = true; });
  });
  let talkMap = $state<Record<string, number>>({});
  let projectTick = $state(Date.now());
  // The FULL non-archived list vs what the sidebar shows (board #39: "如果该
  // 项目完全为空 则直接不显示该 project"): the rows are filtered by the bulk
  // counts — total>0 — but allProjects stays whole, because the CURRENT board
  // may be empty and hidden while its page-head still names it and its main
  // area still creates the first issue. DERIVED, so a local counts update
  // (create/delete below) re-filters without waiting for any poll.
  let allProjects = $state<ProjectRow[]>([]);
  let countsMap = $state<Record<string, BoardCountRow>>({});
  const projects = $derived(visibleBoards(allProjects, countsMap));
  /** The list's own state for the union (P1-C4). A Board's list is TWO
   * required reads — the projects AND the per-board counts that decide which
   * boards exist (an empty board is hidden, board #39). There is ONE counts
   * map (`countsMap`): bulk batches, `boardList` results and the local
   * create/delete/status confirmations all write it, and the slice publishes
   * THAT map as it stands. The only extra state is two flags: `completeOnce`
   * (a first batch in which BOTH reads answered) gates `answered`, so a counts
   * failure can never read as "no boards"; `listFailed` marks a later failure,
   * cleared by the next success. A failed batch changes flags and never the
   * map, so "the last complete list" is simply the map as last confirmed —
   * local confirmations included (reviewer R1 on 0feb403e, which a frozen
   * snapshot broke). `hubRooms` stays tolerant: a missing clock only orders
   * the rows. */
  let completeOnce = $state(false);
  let listFailed = $state(false);
  let projectReadSequence = 0;
  async function loadProjects() {
    const request = ++projectReadSequence;
    try {
      // The SAME order as the Hub/Chat sidebar (reopened #11): newest
      // conversation first — one hub_rooms read feeds sortRows, exactly the
      // recipe the Hub uses. boardCounts is the third bulk read (board #39):
      // ONE grouped RPC for every project's four column counts — a
      // per-project boardList walk here is the N+1 the server call exists
      // to prevent.
      // Each read starts inside an async thunk: a call that THROWS (a
      // detached runtime's gate refuses synchronously) becomes that read's
      // own rejection, so the reads already started are still handled. Without
      // it a throw at the second call left the first call's rejection with no
      // handler — an unhandled rejection from a member that now refreshes
      // while hidden (#357).
      const ask = <T,>(f: () => Promise<T>): Promise<T> => (async () => f())();
      const [r, rooms, bc] = await Promise.all([
        ask(() => projectList()),
        ask(() => hubRooms()).catch(() => ({ rooms: {} })),
        ask(() => boardCounts()).catch(() => null),
      ]);
      if (request !== projectReadSequence) return;
      // Counts did not answer: flags only. The map, the rows and the clock stay
      // as last confirmed ("could not ask" is not "every board is empty").
      if (!bc) { listFailed = true; return; }
      talkMap = rooms.rooms ?? {};
      allProjects = sortRows((r.projects ?? []).filter((row) => !row.project.archived), talkMap);
      countsMap = bc.counts ?? {};
      completeOnce = true; listFailed = false;
      // No session to follow: land on the first NON-EMPTY board — the ones
      // the sidebar actually shows (board #39).
      if (!cur) cur = visibleBoards(allProjects, countsMap)[0]?.project.session ?? '';
    } catch {
      /* keep the last list — "could not ask" is not "there is nobody" */
      if (request === projectReadSequence) listFailed = true;
    }
  }
  // D4 (#357, as the Hub's ③c-2): a HIDDEN member in a union keeps only its
  // list refresh — the slice it publishes, on the same 20 s cadence — and
  // nothing else; in Single a hidden Board polls nothing, as before.
  $effect(() => {
    if (!visible && !union) return;
    loadProjects();
    const iv = setInterval(loadProjects, 20000);
    return () => clearInterval(iv);
  });
  $effect(() => {
    if (!visible) return;
    const ageIv = setInterval(() => { projectTick = Date.now(); }, 1000);
    return () => clearInterval(ageIv);
  });
  // #357: publish this server's slice, by this runtime; withdraw it with the
  // tree. The union is read-only to this Board beyond its own slice.
  $effect(() => {
    if (!union) return;
    union.source.publish(guardOwner, serverId, { rows: allProjects, talk: talkMap, counts: countsMap, answered: completeOnce, failed: listFailed });
  });
  $effect(() => () => { union?.source.withdraw(guardOwner); });
  /** The sidebar's list: in Aggregate every included server's boards merged
   * by the one rule, each row filtered by ITS server's counts (an empty
   * board is hidden, board #39) and labelled by its server's clock; in
   * Single this server's rows as untagged single-server entries. ONE row
   * template either way. */
  const unionList = $derived(union ? union.source.rows(union.included) : null);
  const sideRows = $derived<BoardUnionRow[]>(unionList
    ? unionList.rows.filter((r) => (r.slice.counts[r.item.project.session]?.total ?? 0) > 0)
    : projects.map((p) => ({ serverId, item: p, ref: sessionRef(serverId, p.project.session), key: refKey(sessionRef(serverId, p.project.session)), tag: null, slice: { rows: allProjects, talk: talkMap, counts: countsMap, answered: completeOnce, failed: listFailed } })));
  const curKey = $derived(refKey(sessionRef(serverId, cur)));
  const missingRows = $derived(unionList ? (union?.included ?? []).filter((s) => unionList.missing.includes(s.id)) : []);
  const unavailableRows = $derived(unionList ? (union?.included ?? []).filter((s) => unionList.unavailable.includes(s.id)) : []);
  /** Rows of a server whose latest refresh failed are the map as last confirmed,
   * muted like the Hub's (the same `.proj-row.unavailable`). */
  const unavailableIds = $derived(new Set(unionList?.unavailable ?? []));
  function pick(s: string) {
    guard(() => {
      if (s !== cur) { cur = s; }
      picked = true;
      sideOpen = false; // choosing closes the drawer
    });
  }
  /** A sidebar row picked: this server's is the ordinary pick; another
   * server's is the host's focus move + landing (D2), the drawer closing
   * here as for any choice. */
  function pickRow(r: BoardUnionRow) {
    if (r.serverId === serverId) { pick(r.item.project.session); return; }
    sideOpen = false;
    onPickServer?.(r.ref);
  }

  // The back gesture peels detail/form → list before leaving the page —
  // the same contract every page registers via onGoBack (Files defined it).
  $effect(() => {
    onGoBack?.(() => {
      if (pendingDelete) { if (!busy) pendingDelete = null; return true; } // pending Back is consumed, not dismissed
      if (pendingDiscard) { cancelDiscard(); return true; }
      if (submitting) return true; // consumed: the request answers first
      if (shotView) { shotView = ''; return true; } // the viewer first, then the detail
      if (sel && (dirty || noteDirty)) { pendingDiscard = () => { sel = null; }; return true; }
      if (creating && createDirty) { pendingDiscard = () => { creating = false; }; return true; }
      if (sel || creating) { sel = null; creating = false; return true; }
      // Compact bare list: back LIFTS the project drawer — the drawer is the
      // FLOOR, exactly Hub's compact rule (back with it open falls through,
      // so it can never cycle open/close). Except when the page was JUMPED
      // INTO from the chat: then App's return slot below is the floor, and
      // back belongs to the conversation (board #47: the bottom-bar entry
      // used to fall straight to the terminal).
      if (narrowVp && !sideOpen && !jumped) { sideOpen = true; return true; }
      return false;
    });
  });

  const STATUSES = ['todo', 'doing', 'review', 'done'];

  let issues = $state<BoardIssue[]>([]);
  let ready = $state(false);
  /** The FIRST fill of a project's board unfolds its columns (motion.md
   * principle 15: `.reveal` on each .col-scroll); a poll that refreshes the
   * same board is a cut, and a card that moves has animate:flip. Cleared by a
   * timer (one --t-move + the atom's 210ms stagger + margin) so a card that
   * arrives on a later poll does not rise as if it were part of the fill. */
  let justLoaded = $state(false);
  let justLoadedTimer: ReturnType<typeof setTimeout> | null = null;
  function unfold() {
    if (justLoadedTimer) clearTimeout(justLoadedTimer);
    justLoaded = true;
    justLoadedTimer = setTimeout(() => { justLoaded = false; }, revealMs());
  }
  let err = $state('');
  // view: the list, one issue (with its note thread), or the new-issue form.
  let sel = $state<BoardIssue | null>(null);
  let creating = $state(false);
  // Drill motion (design-language.md §1 navigation grammar, motion.md): on a
  // phone the detail takes the screen, so it enters from the right and the
  // columns re-enter from the left — 120ms linear, same as AgentsPage, and
  // inert on desktop (the swap is a content change there, not a navigation).
  // Derived from ONE compound flag so every open/close path animates alike;
  // switching from one issue to another does not replay it.
  const drilled = $derived(!!sel || creating);
  let drillAnim = $state('');
  // The viewer and the body/note stagers belong to the issue they were
  // opened on. Most ways off an issue pass the guard (whose confirmed
  // discard clears them); a confirmed DELETE does not, and drops the issue's
  // staged images with it — never into the next issue opened.
  let stagedFor: number | null = null;
  // Opening or closing the create form is a new editor too: a picker opened
  // in the previous one is revoked (its files go nowhere).
  let formWas = false;
  $effect(() => { const c = creating; if (c !== formWas) { formWas = c; untrack(() => { opGen++; }); } });
  $effect(() => {
    const id = sel?.id ?? null;
    if (id === stagedFor) return;
    stagedFor = id;
    // The note text and its images have ONE owner, the issue: they go together.
    untrack(() => { opGen++; bodyStage.clear(); noteStage.clear(); noteText = ''; shotView = ''; });
  });
  let wasDrilled = false;
  $effect(() => { if (drilled !== wasDrilled) { drillAnim = drilled ? 'fwd' : 'back'; wasDrilled = drilled; } });
  /** How many notes the open issue had when it was opened (motion.md
   * principle 13): only a note that ARRIVES afterwards fades in — the
   * thread itself is history. Notes append and are never removed in the
   * UI, so the count is a stable gate. */
  let notesBase = $state(0);
  let nTitle = $state('');
  let nBody = $state('');
  let nAssignee = $state('');
  let noteText = $state('');
  let busy = $state(false);
  /** A save, create or note request is running: its editors are locked and
   * nothing navigates under it (board #329 review). Delete keeps #167's rule
   * (a pending delete never blocks a visit) — it only sets `busy`. */
  let submitting = $state(false);
  // ── Images (board #329): each editor owns a stager on the ONE pipeline the
  // chat composer uses (attachments.svelte.ts) — paste or +, uploaded into
  // THIS board's project, an [img:n] token at the caret, the ref swapped in
  // at save. Staged attachments are DRAFT state: they join the leave guard
  // below, and a stager is cleared only by a confirmed discard, a successful
  // save, or a context change that already passed that guard (another issue,
  // another project, the page's destruction on a server switch — clear()
  // bumps its generation, so a late upload, its catch and its finally never
  // touch the new context).
  const projectPath = () => allProjects.find((r) => r.project.session === cur)?.project.path;
  let createEl = $state<HTMLTextAreaElement | null>(null);
  let bodyEl = $state<HTMLTextAreaElement | null>(null);
  let noteEl = $state<HTMLTextAreaElement | null>(null);
  const createStage = createStager({ api: guardOwner.api, ws: projectPath, getText: () => nBody, setText: (v) => { nBody = v; }, caret: () => createEl?.selectionStart, focus: () => createEl?.focus() });
  const bodyStage = createStager({ api: guardOwner.api, ws: projectPath, getText: () => draft.body, setText: (v) => { draft.body = v; }, caret: () => bodyEl?.selectionStart, focus: () => bodyEl?.focus() });
  const noteStage = createStager({ api: guardOwner.api, ws: projectPath, getText: () => noteText, setText: (v) => { noteText = v; }, caret: () => noteEl?.selectionStart, focus: () => noteEl?.focus() });
  /** Staged or still uploading: unsaved work the guard protects. */
  const holds = (st: Stager) => st.pending.length > 0 || st.attaching;
  /** Not submittable while an upload runs or a failed chip stands. */
  const blocked = (st: Stager) => st.attaching || st.failed;
  // The picker remembers the editor AND the generation it opened in: files
  // chosen after the issue or project changed under the dialog go nowhere.
  let pickTarget: { stager: Stager; gen: number } | null = null;
  let fileEl = $state<HTMLInputElement | null>(null);
  function pickFor(st: Stager) { if (submitting) return; pickTarget = { stager: st, gen: opGen }; fileEl?.click(); }
  async function onPickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = ''; // same file re-pickable
    const pick = pickTarget; pickTarget = null;
    if (pick && pick.gen === opGen && alive && !submitting) await pick.stager.stage(files);
  }
  /** Paste into an editor — refused while its request runs (the lock). */
  const pasteInto = (st: Stager) => (e: ClipboardEvent) => { if (submitting) { e.preventDefault(); return; } attachPaste(e, (f) => st.stage(f)); };
  // The Lightbox (the shared viewer): opened from any image in the detail;
  // Back and Escape close IT before the detail (backLayers order below).
  let shotView = $state('');
  /** The viewer URL is signed at the tap, asynchronously. Each tap takes its
   * OWN claim — the generation then, and a sequence number — and only the
   * answer to the LATEST tap, in the generation it was made, may open the
   * viewer: an answer from another issue (A→B→A) or an older tap is dropped. */
  let viewSeq = 0;
  const claimView = () => ({ gen: opGen, n: ++viewSeq });
  const acceptView = (u: string, c: { gen: number; n: number } | undefined) => {
    if (alive && c && c.gen === opGen && c.n === viewSeq) shotView = u;
  };
  /** Body/note text and its images (the feed's own parser). Text without an
   * image is returned BYTE-FOR-BYTE — history is shown verbatim (#28/#11);
   * only a text that carries images is split. */
  function withImages(text: string): { text: string; images: string[] } {
    const parts = splitImages(text);
    return parts.images.length ? parts : { text, images: [] };
  }
  // ── The DRAFT (board #11): opening an issue edits a COPY; only the explicit
  // Save persists, Cancel restores, and every path that would drop unsaved
  // edits (back, Esc, sidebar switch, the phone's back gesture) goes through
  // the app's confirm dialect instead of losing them silently.
  let draft = $state(draftOf(null));
  // The draft's BASE: the server text the user started from (or last saved/
  // rebased onto). Dirty and the save patch are measured against IT, never
  // the live issue — a concurrent refetch moves the live copy, and diffing
  // against that would ship stale fields the user never touched (#11 review).
  let draftBase = $state(draftOf(null));
  let pendingDiscard = $state<null | (() => void)>(null);
  const dirty = $derived(sel ? draftDirty(draft, draftBase) || holds(bodyStage) : false);
  // The note box is a draft too (board #329 review): typed text or a staged
  // image under an open issue asks before it is dropped.
  const noteDirty = $derived(!!sel && (!!noteText.trim() || holds(noteStage)));
  // The create form's typed-but-uncreated data is the same kind of unsaved
  // work as a dirty edit (board #29): any exit that would drop it — cancel,
  // Escape, back, a sidebar project pick — asks through the SAME guard, and
  // a clean form navigates without a pointless dialog.
  const createDirty = $derived(creating && (!!(nTitle.trim() || nBody.trim() || nAssignee) || holds(createStage)));
  // A server switch destroys this page (board 315): it asks through the SAME
  // discard confirm, after a request in flight has answered, and a hidden
  // Board is revealed by the walk first (its layer is `guardPage`).
  let endLeaveAsk: ((leave: boolean) => void) | null = null;
  function cancelDiscard() { pendingDiscard = null; const end = endLeaveAsk; endLeaveAsk = null; end?.(false); }
  $effect(() => registerLeaveGuard({
    runtime: guardOwner,
    page: guardPage,
    dirty: () => untrack(() => busy || dirty || noteDirty || createDirty),
    ask: async () => {
      while (alive && untrack(() => busy)) await new Promise((r) => setTimeout(r, 50));
      if (!alive || !untrack(() => dirty || noteDirty || createDirty)) return true;
      await tick(); // the revealed layer is visible before the dialog asks
      return new Promise<boolean>((resolve) => {
        endLeaveAsk = resolve;
        pendingDiscard = () => { endLeaveAsk = null; resolve(true); };
      });
    },
  }));
  /** Run now, or park behind the discard confirm when unsaved work exists. */
  function guard(action: () => void) {
    if (submitting) return; // a request is running: its editor is locked, nothing leaves under it
    if (dirty || noteDirty || createDirty) pendingDiscard = action;
    else action();
  }

  async function load() {
    // FROZEN at entry (lead review, board #39): every await below is a window
    // for the user to switch projects, and with live `cur` the OLD board's
    // response would paint its issues into the NEW board — and, worse since
    // the counts fold, apply the old list's counts to the new session,
    // hiding/showing the wrong project in the sidebar. So the whole call is
    // about `s`: the RPCs ask for it, and every landing re-checks identity
    // before touching state — a stale response (or a stale ERROR) is dropped
    // whole; the switch effect already reset the view, and s's own next
    // reader is gone.
    const s = cur;
    const request = ++readSequence;
    const current = () => cur === s && request === readSequence;
    try {
      const r = await boardList(s);
      if (!current()) return;
      if (!ready) unfold(); // the first answer for this board, not a poll
      issues = r.issues;
      ready = true;
      err = '';
      // The fresh list IS this board's counts: fold them into the bulk map
      // at once (board #39: "删除最后一条立即从 sidebar 消失，创建第一条立即
      // 出现") — load() runs after every create/delete/save, so the sidebar
      // reacts NOW instead of waiting out the 20 s projects poll. applyCounts
      // removes the key when the list is empty, the same absence the server
      // speaks. Keyed by the FROZEN session — the one the issues belong to.
      countsMap = applyCounts(countsMap, s, issues);
    } catch (e) {
      if (!current()) return;
      // A failed poll keeps the last board — "could not ask" ≠ "empty".
      err = String((e as Error)?.message ?? e);
    }
    // The assignee picker offers the project's MANAGED agents (the only ones
    // an assignment can be typed into). A failed read keeps the last roster.
    try {
      const a = await hubAgents(s);
      if (!current()) return;
      agents = a.agents.filter((x) => x.managed);
      backends = rememberBackends(backends, agents);
    } catch { /* keep */ }
  }
  let agents = $state<HubAgent[]>([]);
  /** name → backend, as last seen (board #327): a stopped agent keeps its icon. */
  let backends = $state<Record<string, string>>({});

  // Poll while visible: agents move cards from their panes, and the human
  // should see it without touching anything. Same verdict rule as the rooms —
  // nothing renders as "empty" before the first answer.
  $effect(() => {
    if (!visible || !cur) return;
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  });
  // Switching projects resets the view to the new board's list.
  $effect(() => {
    void cur;
    viewGeneration++;
    sel = null; creating = false; ready = false; issues = []; noteText = ''; nTitle = ''; nBody = ''; nAssignee = ''; pendingDiscard = null; pendingDelete = null;
    shotView = ''; opGen++;
    untrack(() => { createStage.clear(); bodyStage.clear(); noteStage.clear(); });
    if (justLoadedTimer) clearTimeout(justLoadedTimer); justLoaded = false; // the unfold belongs to the board that loaded
    // untrack: this effect runs on `cur` — reading acts to bump its gen
    // would ALSO subscribe the effect to acts, and writing it back loops
    // the effect to death (caught live: effect_update_depth_exceeded).
    untrack(() => setNoteActions(-1));
  });

  /** The editor boxes ADAPT to their content (owner, 2026-08-29: "有的框很大
   * 有空白 应该自适应"): height follows scrollHeight on input and whenever the
   * bound value changes programmatically (opening an issue swaps the draft).
   * The CSS min-height is the floor; manual resize stays available. */
  function autoGrow(el: HTMLTextAreaElement, _value: string) {
    const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
    el.addEventListener('input', fit);
    fit();
    return {
      update: (_v: string) => fit(),
      destroy: () => el.removeEventListener('input', fit),
    };
  }

  // ── The status slider (board #15): one segmented track, slide or tap ──
  // It edits the DRAFT — nothing reaches the server until the ✓ confirms
  // ("避免手动手滑随便一点就改变了状态"). Pointer capture makes a swipe from
  // any segment sweep the track; a plain tap lands on its segment.
  let segEl = $state<HTMLElement | null>(null);
  let segDrag = $state(false);
  function segPick(e: PointerEvent) {
    if (!segEl || submitting) return;
    const r = segEl.getBoundingClientRect();
    const i = Math.min(STATUSES.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * STATUSES.length)));
    draft.status = STATUSES[i]!;
  }
  function segDown(e: PointerEvent) {
    if (submitting) return; // the draft is locked while it is being saved
    segDrag = true;
    segEl?.setPointerCapture?.(e.pointerId);
    segPick(e);
  }

  async function openIssue(id: number) {
    try {
      sel = await boardGet(cur, id);
      notesBase = Array.isArray(sel.notes) ? sel.notes.length : 0;
      draft = draftOf(sel);
      draftBase = draftOf(sel);
      setNoteActions(-1); // a different issue, a fresh slate (board #46)
      err = '';
    } catch (e) { err = String((e as Error)?.message ?? e); }
  }
  /** Re-fetch the open issue and REBASE the draft three-way: untouched
   * fields follow the server (an agent's new body shows up mid-edit),
   * touched fields keep the user's text (#11 review). */
  async function refetchSel(ctx: OpCtx = freeze()) {
    if (sel && ctx.id != null) {
      try {
        const fresh = await boardGet(ctx.session, ctx.id);
        if (!owns(ctx)) return; // another issue, project or server by now
        sel = fresh;
        const r = rebaseDraft(draft, draftBase, draftOf(fresh));
        draft = r.draft;
        draftBase = r.base;
        err = '';
      } catch (e) { if (owns(ctx)) err = String((e as Error)?.message ?? e); }
    }
    if (owns(ctx)) await load();
  }
  // Assigning DOES something (owner, 2026-08-29: "Assign 给某个 Agent 去做"):
  // besides the field, a non-empty assignment posts an @message — hub_post's
  // delivery types it into that agent's pane, so the agent actually starts.
  // ONE function carries that semantics; the detail Select and the create
  // dialog both route through it (board #11: create-with-assignee must
  // dispatch, never just write a label).
  // The brief CARRIES the issue (owner, 2026-08-30): the ORIGINAL title/body
  // are the task input, so they ride in full and the agent starts without a
  // lookup. Only the note thread has a separate explicit budget below.
  async function dispatchAssign(ctx: OpCtx, id: number, name: string, title = '', body = '', notes: { author: string; body: string; at: number }[] = []) {
    await boardSave(ctx.session, { id, assignee: name });
    if (name) {
      // The brief follows only while this page (this server) still owns it.
      if (!alive) return;
      const b = body.trim() ? ` — ${body.trim()}.` : '.';
      // The {title} slot names the issue; with the body already riding in
      // {body}, a titleless issue is named by its id (not the body twice).
      // The SUBJECT leads (board #51: "前边有谁分给他一个主体名称"): who
      // assigned it, then the issue, then the notes, then the ask — the
      // reading order of a handoff. The UI's dispatch is the operator's act,
      // and 'human' is the name agents know the operator by (hubPost below
      // posts as the same identity).
      const msg = t('boardAssignMsg')
        .replaceAll('{id}', String(id))
        .replace('{who}', 'human')
        .replace('{title}', title.trim() || '#' + id)
        .replace('{body}', b);
      // The note thread rides along (board #42): the discussion under an
      // issue is context the agent must not miss, appended AFTER the rendered
      // message under its own header, chronological, authors kept, and
      // budget-capped with the `tmm board show` pointer — assignNotes owns
      // that shape. A fresh issue has no notes and appends nothing. The tmm
      // instructions come LAST (board #51: "please tmm xxxx这样的顺序") —
      // after the content, never between the issue and its thread.
      const take = t('boardAssignTake').replaceAll('{id}', String(id));
      await hubPost(ctx.session, `@${name} ${msg}${assignNotes(id, notes)}\n${take}`);
    }
  }
  /** Explicit save of the USER's changed fields (diffed against the draft
   * base, never the live issue); a failure KEEPS the draft. The refetch's
   * rebase then normalizes: the server now carries the saved text, so base
   * catches up and the draft reads clean. */
  async function saveDraft() {
    if (!sel || busy || blocked(bodyStage)) return;
    // Frozen at entry (board #329 review): the target, and ONE materialized
    // body — the [img:n] tokens become refs, and that SAME text is what
    // boardSave stores and the assignment brief carries.
    const ctx = freeze();
    const id = sel.id;
    const notes = Array.isArray(sel.notes) ? sel.notes : [];
    const saved = { ...draft, body: bodyStage.body(draft.body) };
    const patch = draftPatch(saved, draftBase);
    if (!patch) return;
    busy = true; submitting = true;
    try {
      // The assignee travels through dispatchAssign — the ONE carrier of
      // assignment=dispatch semantics (board #11) — so a change confirmed by
      // the ✓ briefs the agent exactly like assign-at-birth does. Everything
      // else is an ordinary field patch.
      const { assignee, ...rest } = patch;
      if (Object.keys(rest).length) await boardSave(ctx.session, { id, ...rest });
      // A reassign carries the OPEN issue's note thread (board #42).
      if (assignee !== undefined && alive) await dispatchAssign(ctx, id, assignee, saved.title, saved.body, notes);
      if (!owns(ctx)) return;
      err = '';
      // What was SENT is now the server's: the draft and its base both take
      // the materialized fields (refs, not [img:n] — the map is about to be
      // cleared), so the three-way refetch never reads a committed token as
      // a new edit. The note box is not part of this save and is untouched.
      for (const f of Object.keys(patch) as (keyof typeof saved)[]) { draft[f] = saved[f]; draftBase[f] = saved[f]; }
      bodyStage.clear(); // persisted
      // The ✓ ANSWERS the edit (board #48 v2: back to the board) — unless the
      // NOTE box still holds a draft: the body save is not the note's, so the
      // detail stays, rebased on the saved body, with the note as it was.
      if (noteDirty) { await refetchSel(ctx); return; }
      // A FAILED save takes the catch instead — the detail stays open with
      // the error and the typed draft (createIssue's rule).
      sel = null;
      await load();
    } catch (e) { if (owns(ctx)) err = String((e as Error)?.message ?? e); }
    finally { busy = false; submitting = false; }
  }
  async function createIssue() {
    // Title OR content — an image-only body counts (the stager's rule).
    if (!(nTitle.trim() || createStage.sendable(nBody)) || busy || blocked(createStage)) return;
    // Frozen at entry: the target and every field the dispatch will use.
    const ctx = freeze();
    const title = nTitle.trim();
    const body = createStage.body(nBody).trim(); // the one materialized body
    const wantAssign = nAssignee;
    busy = true; submitting = true;
    let created: number | null = null;
    try {
      created = (await boardSave(ctx.session, { title, body }))?.id ?? null;
    } catch (e) {
      // The CREATE failed: the form stays, retry is honest.
      if (owns(ctx)) err = String((e as Error)?.message ?? e);
      busy = false; submitting = false;
      return;
    }
    // The issue EXISTS from here on: the form closes — a retryable form after
    // a successful create is how duplicate issues are born (#11 review). A
    // failed dispatch is reported; the issue can be assigned from its detail.
    if (owns(ctx)) { nTitle = ''; nBody = ''; nAssignee = ''; creating = false; createStage.clear(); }
    try {
      // Create-with-assignee reuses the ONE dispatch semantics (board #11).
      if (wantAssign && created != null && alive) await dispatchAssign(ctx, created, wantAssign, title, body);
    } catch (e) {
      if (alive && cur === ctx.session) err = `#${created}: ${String((e as Error)?.message ?? e)}`;
    }
    if (alive && cur === ctx.session) await load();
    busy = false; submitting = false;
  }
  async function addNote() {
    if (!sel || !noteStage.sendable(noteText) || busy || blocked(noteStage)) return;
    const ctx = freeze();
    const id = sel.id;
    const body = noteStage.body(noteText).trim(); // frozen before the await
    busy = true; submitting = true;
    try {
      await boardNote(ctx.session, id, body);
      if (!owns(ctx)) return; // the note is saved; another issue's box is not ours to clear
      noteText = ''; noteStage.clear(); // persisted
      await refetchSel(ctx);
    } catch (e) { if (owns(ctx)) err = String((e as Error)?.message ?? e); }
    finally { busy = false; submitting = false; }
  }
  // ── Delete is CONFIRMED, and the request is CAPTURED (board #29): the
  // dialog carries the session + issue it was opened FOR, and the executor
  // uses exactly that — a poll refetch, a selection change or a project
  // switch while the dialog stands open cannot redirect the delete. Nothing
  // destructive runs before the confirm; busy blocks a double confirm.
  let pendingDelete = $state<null | { session: string; id: number; title: string }>(null);
  let deleteError = $state('');
  function requestDelete() {
    if (!sel || busy) return;
    deleteError = '';
    pendingDelete = { session: cur, id: sel.id, title: issueRef(sel) };
  }
  async function confirmDelete() {
    const cap = pendingDelete;
    if (!cap || busy) return;
    const generation = viewGeneration;
    busy = true;
    deleteError = '';
    try {
      await boardDelete(cap.session, cap.id);
    } catch (e) {
      if (generation === viewGeneration && pendingDelete === cap) deleteError = String((e as Error)?.message ?? e);
      return;
    } finally { busy = false; }
    if (generation !== viewGeneration || pendingDelete !== cap) return;
    // The mutation is complete. A later read error belongs to load(), not
    // to another destructive retry, and cannot close another room's view.
    pendingDelete = null;
    if (cur === cap.session) {
      if (sel?.id === cap.id) sel = null;
      issues = issues.filter(issue => issue.id !== cap.id);
      countsMap = applyCounts(countsMap, cap.session, issues);
      await load();
    }
  }

  // ── Note actions (board #46: "点击中间 Agent 或人回复的消息…出现一个 copy
  // 按钮"): tapping a note's body reveals ONE Copy action on the bubble's
  // corner — Chat's action-row pattern, wearing Chat's own .m-acts atoms
  // from app.css (a scoped copy is dialect drift). acts.open is the single
  // source of WHICH row is open; another note's tap switches, the same
  // note's tap closes, outside/Escape/issue-switch put it away. Every
  // transition is a pure message-actions.ts function over ONE state triple, and
  // acts.gen makes the Copy beat's timeout self-scoped (review blocker:
  // a global boolean let Copy A's stale timeout close Copy B's row).
  let acts = $state<MessageActsState>(MESSAGE_ACTS_IDLE);
  let copyTrigger = $state<HTMLElement | null>(null);
  let notesEl = $state<HTMLElement | null>(null);
  let detailEl = $state<HTMLElement | null>(null);
  let cancelCopyExpiry = () => {};
  function setNoteActions(open: number | string) {
    cancelCopyExpiry(); cancelCopyExpiry = () => {};
    copyTrigger = null;
    acts = messageActsSet(acts, open);
  }
  $effect(() => { if (!visible || !sel) untrack(() => setNoteActions(-1)); });
  const noteSelectionClicks = selectionClickGuard();
  function toggleNoteActs(i: number) {
    if (noteSelectionClicks.consume(i)) return;
    // A drag-selection's tail click must not steal the selection — the note
    // text is swipe-selectable (#43); the action row is for a plain tap.
    if (typeof getSelection === 'function' && !(getSelection()?.isCollapsed ?? true)) return;
    setNoteActions(acts.open === i ? -1 : i);
  }
  async function copyNote(i: number, body: string, trigger: EventTarget | null) {
    if (acts.open !== i || !(trigger instanceof HTMLElement)) return;
    setNoteActions(i);
    copyTrigger = trigger;
    // The attempt's identity, captured BEFORE the await (second blocker):
    // the clipboard write is async, and by resolve time the user may be on
    // another note or another issue — that resolve must not stamp Copied
    // onto the new context, nor arm a timer against it.
    const attempt = acts.gen;
    const ok = await copyText(body ?? '');
    const next = ok ? messageActsCopyLanded(acts, attempt)
      : messageActsCopyFailed(acts, attempt, t('copyFailed'));
    if (next === acts) return;
    acts = next;
    if (ok) {
      const gen = next.gen;
      cancelCopyExpiry = scheduleCompletion(() => { acts = messageActsExpired(acts, gen); });
    }
  }
  // Outside pointerdown / Escape close the open row — the transient-layer
  // rule every popover follows. WINDOW-level capture, active only while a
  // row is open: the note text is a div, so a click leaves focus on <body>
  // and a .bmain-scoped key handler would never hear the Escape (measured —
  // the row survived it). Open dialogs keep their own Escape.
  $effect(() => {
    if (acts.open === -1) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.('.m-acts, .n-wrap, .n-at, .note-feedback')) setNoteActions(-1);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pendingDiscard || pendingDelete) return;
      setNoteActions(-1); e.stopPropagation();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onEsc, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onEsc, true); };
  });

  // Esc peels the board's own layers (detail → list, form → list) before the
  // drawer's close sees it — same territory rule as the files partition.
  // (The note action row peels FIRST, via its own window-capture listener
  // above — it stops propagation, so this handler never sees that press.)
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (shotView) return; // the Lightbox's own window handler closes it first
    if (pendingDiscard || pendingDelete) return; // the ConfirmDialog's own capture handler closes itself
    if (sideOpen) { sideOpen = false; e.stopPropagation(); return; }
    if (submitting) { e.stopPropagation(); return; } // the request answers first
    if (sel && (dirty || noteDirty)) { pendingDiscard = () => { sel = null; }; e.stopPropagation(); return; }
    if (creating && createDirty) { pendingDiscard = () => { creating = false; }; e.stopPropagation(); return; }
    if (sel || creating) { sel = null; creating = false; e.stopPropagation(); }
  }

  /** A card never shows a path (board #329): image refs leave the preview,
   * and a body that was ONLY images reads as the localized word for one. */
  function cardText<I extends { id?: number; title?: string; body?: string }>(i: I): I {
    if (!i.body) return i;
    const parts = withImages(i.body);
    if (!parts.images.length) return i;
    // The shared parser keeps a bare path INSIDE a sentence in the text (the
    // feed shows it as prose and the picture below); a card shows the word.
    let text = parts.text;
    for (const src of parts.images) text = text.split(src).join(`[${t('hubImage')}]`);
    return { ...i, body: text || `[${t('hubImage')}]` };
  }
  const statusLabel = (s: string) => t(`boardStatus_${s}`);
  /** The SIDEBAR count chips' colours — the owner's four CATEGORICAL colours
   * in board order (2026-09-01, fourth ruling: "红 蓝 黄紫 吧，橙色和红色区
   * 分不明显" — at a 5px dot the third ruling's red/orange pair blurred, so
   * doing wears BLUE: var(--accent), the app's own blue and incidentally the
   * colour the global language already gives doing). These are counts, not
   * severities: red-todo is category paint, not alarm. All theme tokens (a
   * hex literal is only right in one theme), none of them green — the first
   * ruling (no collision with the row's green LIVE dot) holds by
   * construction. Still deliberately SCOPED (lead): the feed's "→ done"
   * badge keeps boardStatusColor's language, unknown statuses delegate to
   * it, and the chips stay non-colour-readable — every one carries its
   * label and count. */
  const COUNT_COLORS: Record<string, string> = {
    todo: 'var(--status-danger)',
    doing: 'var(--accent)',
    review: 'var(--status-warn)',
    done: 'var(--status-purple)',
  };
  const countColor = (st: string) => COUNT_COLORS[st] ?? boardStatusColor(st);
  /** Dynamic chip layout (owner, 2026-09-01: "如果一行能 放下放一行也行，甚
   * 至两行放不下，就放一列，动态适配" — layered on 不要 3+1): a hidden GHOST
   * row (the composer's mirror-div pattern) with nowrap natural-width chips
   * reports the row width and the widest chip; chipCols (pure, tested) turns
   * the two into 4, 2 or 1 equal columns, and every real row wears the
   * answer inline. The ghost carries the sidebar's WIDEST count so digit
   * width is priced in, and its labels re-render with the locale. */
  const CHIP_GAP_X = 10; // .side-wins column-gap in app.css
  let winsW = $state(0);
  let chipWs = $state<number[]>([0, 0, 0, 0]);
  // The widest count of the rows ACTUALLY RENDERED (#357): in a union a
  // row wears its own server's counts, so pricing the ghost off the focused
  // server's map alone would size 4 or 2 columns for the small numbers and let
  // a big count from another server overflow its chip.
  const maxCount = $derived(Math.max(0, ...sideRows.flatMap((r) => {
    const c = r.slice.counts[r.item.project.session];
    return c ? STATUSES.map((st) => Number(c[st as keyof BoardCountRow]) || 0) : [];
  })));
  const cols = $derived(chipCols(winsW, Math.max(...chipWs), CHIP_GAP_X));
  const col = (s: string) => issues.filter((i) => i.status === s);
  const noteCount = (i: BoardIssue) => (typeof i.notes === 'number' ? i.notes : i.notes.length);
  /** The card's hover card (motion.md principle 16; board #284, owner
   * 2026-09-30: "不要做重复内容展示"): ONLY what the card does not say. The
   * card already shows the title, the body preview, #N, reporter, assignee,
   * the note count and the age; the column is the status. What it lacks is
   * WHEN: it gives the update as a relative age and the creation not at all,
   * so the hover gives both as absolute local times (`localWhen`, the wake
   * row's form), the update only when it differs. A clamped body needs no
   * hover: the card is the door to the detail (the preview's own rule). No
   * time, nothing to say: no card. */
  function cardInfo(i: BoardIssue) {
    if (!i.created_at) return null;
    const lines = [{ label: t('boardHoverCreated'), value: localWhen(i.created_at) }];
    if (i.updated_at > i.created_at) lines.push({ label: t('boardHoverUpdated'), value: localWhen(i.updated_at) });
    return { lines };
  }
  const ago = (ts: number) => {
    const d = Math.max(0, Date.now() / 1000 - ts);
    return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
  };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="board-root" class:embedded class:side-collapsed={sideCollapsed && !narrowVp && !embedded} bind:this={rootEl}>
  {#if !embedded}
  <aside class="sidebar" class:side-sheet={narrowVp} class:open={narrowVp && sideOpen} bind:this={sideEl}>
    <SideHandle />
    <div class="side-scroll subtle-scroll" use:scrollFade
      use:slideIndicator={{ key: `${curKey}|${sideRows.map((r) => r.key).join(',')}`, active: '.proj-row.open', hidden: !sideRows.some((r) => r.key === curKey) }}>
      <!-- The chosen project's wash glides (motion principle 14), as in the
           Chat and Terminal sidebars. -->
      <span class="slide-pill soft" aria-hidden="true"></span>
      <div class="side-h side-toggle-row">{t('hubProjects')}</div>
      <!-- The Chat sidebar's two-line row, atom for atom (board #39: "board
           侧边栏的样式也要和 chat terminal 的侧边栏对齐"): dot + name + age up
           top from the SHARED .proj-row/.p-* atoms in app.css, and the quiet
           second line wears the same .side-win chips the Terminal's windows
           and Chat's agents wear — here each chip is a COLUMN: its status
           color (boardStatusColor, the one board status language) and count,
           all four in fixed order, zeros included, so every row reads the
           same shape. Only boards WITH issues are listed (visibleBoards —
           the empty ones are hidden, never zero-rows). -->
      <!-- The measurement ghost: a real row's structure at height 0, chips
           nowrap at natural width. Its binds feed chipCols; it renders the
           WIDEST count so the answer already fits every real row. -->
      <div class="side-row proj-row mirror" aria-hidden="true">
        <span class="dot off"></span>
        <span class="p-main">
          <span class="side-wins" bind:clientWidth={winsW}>
            {#each STATUSES as st, i (st)}
              <span class="side-win" bind:clientWidth={chipWs[i]}>
                <span class="side-win-dot"></span>
                <span class="side-win-name">{statusLabel(st)}</span>
                <span class="b-count">{maxCount}</span>
              </span>
            {/each}
          </span>
        </span>
      </div>
      <!-- #357: ONE row template over the union (Aggregate) or this
           server's list (Single). A row's counts, clock and age are ITS
           server's (`r.slice`); its tag follows the ③c-1 rule; a foreign
           row is a SELECTOR — pick = focus that server + land on its board.
           The tag takes the second line, under the name (#360's grammar). -->
      {#each sideRows as r (r.key)}
        {@const p = r.item}
        {@const c = r.slice.counts[p.project.session]}
        <button class="side-row proj-row" class:open={r.key === curKey} class:foreign={r.serverId !== serverId} class:unavailable={unavailableIds.has(r.serverId)} data-server={r.serverId} onclick={() => pickRow(r)}>
          <span class="dot" class:off={!p.live}></span>
          <span class="p-main">
            <span class="p-top">
              <span class="p-name">{p.project.name}</span>
              <span class="side-age">{projectAgeLabel(p, r.slice.talk, projectTick)}</span>
            </span>
            {#if r.tag}<span class="p-source"><ServerTag name={r.tag} /></span>{/if}
            <span class="side-wins grid" style:grid-template-columns={`repeat(${cols}, minmax(0, 1fr))`}>
              {#each STATUSES as st (st)}
                <span class="side-win">
                  <span class="side-win-dot" style:background={countColor(st)}></span>
                  <span class="side-win-name">{statusLabel(st)}</span>
                  <span class="b-count">{c?.[st as keyof BoardCountRow] ?? 0}</span>
                </span>
              {/each}
            </span>
          </span>
        </button>
      {/each}
      <!-- A server in the union whose list has not arrived, or fails now
           (P1-C4): said, never a shorter list in silence. -->
      {#each missingRows as m (m.id)}
        <div class="side-row proj-row missing" role="note">
          <span class="dot off"></span>
          <span class="p-main"><span class="p-top"><span class="p-name">{m.name}</span><span class="side-age">{t('hubUnionMissing')}</span></span></span>
        </div>
      {/each}
      {#each unavailableRows as u (u.id)}
        <div class="side-row proj-row missing" role="note">
          <span class="dot off"></span>
          <span class="p-main"><span class="p-top"><span class="p-name">{u.name}</span><span class="side-age">{t('hubUnionUnavailable')}</span></span></span>
        </div>
      {/each}
      <ScopeNote note={scopeNote} />
    </div>
  </aside>
  {#if sideOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="side-scrim" onclick={() => (sideOpen = false)}></div>
  {/if}
  {/if}
  <div class="bmain" onkeydowncapture={onKey}>
  <!-- The bar is Chat's own .page-head dialect (board #15: "board上边那一栏
       应该和chat样式一致…按钮风格也要一致"): the shared app.css class carries
       the height, padding, border and h1 type — a scoped re-style is the
       drift that split the sidebars once. The project name appears ONCE
       ("project名称写一遍就行了" — the session chip retired).
       EMBEDDED there is no bar at all (board #23: the drawer head already
       names the project — this row repeated it and nothing else); the
       new-issue + moves up into the drawer head, arriving as createRequest. -->
  {#if !embedded}
  <div class="page-head">
    <!-- Compact: the hamburger calls the project drawer — the same dialect as
         Chat and Terminal (reopened #11), never a second-page drilldown. -->
    <button class="icon-btn side-toggle" title={t('hubProjects')} aria-label={t('hubProjects')}
      onclick={() => (sideOpen = !sideOpen)}>
      <Icon name="menu" size={16} />
    </button>
    <!-- The page names the PROJECT, not itself (board #15): the tab already
         says "Board", so the title says WHOSE board this is. -->
    <!-- The Hub head's Name + tag stack, the ONE atom in app.css (#359, #357):
         the tag is a line under the name exactly when they do not fit, the
         name never ellipsises to make room; no local paint. -->
    <div class="title-stack" class:stacked={narrowVp} use:titleFit={{ active: !narrowVp, key: `${boardTitle(allProjects, cur) ?? (cur || t('board'))}|${scope?.tag ?? ''}` }}>
      <div class="name-line"><h1>{boardTitle(allProjects, cur) ?? (cur || t('board'))}</h1></div>
      <ServerTag name={scope?.tag} />
    </div>
    <span class="spacer"></span>
    {#if !sel && !creating}
      <!-- New issue lives in the page head's top-right (reopened #11:
           "不应该放到最下方…手机操作更友好"). -->
      <button class="icon-btn" title={t('boardNew')} aria-label={t('boardNew')} onclick={() => (creating = true)}>
        <Icon name="plus" size={16} />
      </button>
    {/if}
  </div>
  {/if}
  <div class="board" class:drill-fwd={drillAnim === 'fwd'} class:drill-back={drillAnim === 'back'}>
  {#if !ready && !issues.length}
    <div class="empty">…</div>
  {:else if sel}
    <!-- ── one issue: the note thread is the issue's own record ── -->
    <div class="detail" bind:this={detailEl}>
      <div class="d-head">
        <button class="icon-btn" title={t('back')} aria-label={t('back')} onclick={() => guard(() => (sel = null))}>
          <Icon name="arrow-left" size={14} />
        </button>
        <span class="d-id">#{sel.id}</span>
        <span class="spacer"></span>
        <!-- Verb order (board #48 v2, owner: "一般习惯对勾在最右边，防止误
             点击"): trash first, then the draft's undo + ✓ — the ✓ is the
             LAST control so the muscle-memory rightmost tap confirms, and
             undo stands between it and delete. -->
        <button class="icon-btn" title={t('boardDeleteIssue')} aria-label={t('boardDeleteIssue')} disabled={busy} onclick={requestDelete}>
          <Icon name="trash" size={14} />
        </button>
        {#if dirty}
          <!-- The draft's own verbs, only while there is a draft to speak of:
               cancel restores the stored issue, save persists the changed
               fields — and is the ONLY thing that does (board #11). -->
          <!-- Cancel ASKS (board #15: "当前状态没有保存，是否退出"): the same
               ConfirmDialog every guarded exit uses — confirming restores the
               base, so a slid status or picked assignee rolls back. -->
          <button class="icon-btn appear-pop" title={t('cancel')} aria-label={t('cancel')} disabled={busy} onclick={() => guard(() => {})}>
            <Icon name="undo" size={14} />
          </button>
          <button class="icon-btn go appear-pop" title={t('save')} aria-label={t('save')} disabled={busy || !draftValid({ ...draft, body: bodyStage.body(draft.body) }) || blocked(bodyStage)} onclick={saveDraft}>
            <Icon name="check" size={14} />
          </button>
        {/if}
      </div>
      <!-- Layout hierarchy (board #11): the title is ONE compact line, the
           body is the big field — visibly larger, growable, never same-size
           siblings again. -->
      <!-- Locked text is the RECORD (board #43, backend 842f970): once an
           agent has touched the issue — or while it is assigned — the server
           refuses title/body patches, so the frontend renders the ORIGINAL
           text as semantic static prose: complete, swipe-selectable, and
           carrying NO edit affordance (the bordered box read as "tap to
           edit" — a disabled input would be the same lie). The workflow
           stays live either way: status slider, assignee, note reply. -->
      {#if sel.editable}
        <input class="d-title-input" bind:value={draft.title} placeholder={t('boardTitlePh')} readonly={submitting} />
      {:else if sel.title.trim()}
        <div class="d-title-static">{sel.title}</div>
      {/if}
      <div class="d-meta">
        <!-- The status is a SLIDER (board #15): sweep the track or tap a
             stop. It edits the draft — the head's ✓ is what saves, and
             cancel asks before losing the change. -->
        <!-- ONE highlight that travels (motion.md principle 14): the wash and
             ring belong to the .slide-pill behind the stops, and it glides to
             the chosen one; the stop itself only changes its ink. -->
        <div class="seg" role="radiogroup" tabindex="-1" aria-label={statusLabel(draft.status || sel.status)}
          bind:this={segEl}
          use:slideIndicator={{ key: draft.status, active: '.on' }}
          onpointerdown={segDown}
          onpointermove={(e) => segDrag && segPick(e)}
          onpointerup={() => (segDrag = false)}
          onpointercancel={() => (segDrag = false)}>
          <span class="slide-pill" aria-hidden="true"></span>
          {#each STATUSES as st (st)}
            <button class="seg-b" class:on={draft.status === st} role="radio" aria-checked={draft.status === st}
              disabled={submitting} onclick={() => { if (!submitting) draft.status = st; }}>{statusLabel(st)}</button>
          {/each}
        </div>
        <Select value={draft.assignee} dense disabled={submitting}
          options={[{ value: '', label: t('boardUnassigned') }, ...agents.map((a) => ({ value: a.name, label: a.name, icon: backendIcon(a.agent) ?? undefined }))]}
          onchange={(v: string) => { if (!submitting) draft.assignee = v; }} />
        {#if sel.created_by}<span class="meta-bit">{t('boardOpenedBy')} <span class="m-name">{sel.created_by}</span></span>{/if}
      </div>
      {#if sel.editable}
        <textarea class="d-body-edit" bind:this={bodyEl} bind:value={draft.body} use:autoGrow={draft.body} placeholder={t('boardBodyPh')} rows="3"
          onpaste={pasteInto(bodyStage)} readonly={submitting}></textarea>
        <div class="attach-line">
          <CommandButton variant="icon" icon="plus" label={t('hubAttach')} disabled={submitting || bodyStage.attaching}
            pending={bodyStage.attaching} onclick={() => pickFor(bodyStage)} />
          <AttachStrip pending={bodyStage.pending} onremove={(i) => { if (!submitting) bodyStage.remove(i); }} onpreview={(u) => { shotView = u; }} />
        </div>
        <!-- The SAVED images (board #329): the refs already in the stored body,
             seen through the feed's image atom; the chips above are only
             what this edit adds (they become refs on ✓). -->
        {@render shots(withImages(sel.body).images)}
      {:else if sel.body.trim()}
        <!-- The full body, VERBATIM (review blocker on ebda03b): this is the
             original history, so the display layer must not rewrite it —
             trim() only decides whether the field renders at all; the output
             is sel.body untouched, leading/trailing whitespace included
             (pre-wrap makes it real). -->
        {@const parts = withImages(sel.body)}
        {#if !parts.images.length}
          <div class="d-body-static">{sel.body}</div>
        {:else}
          {#if parts.text}<div class="d-body-static">{parts.text}</div>{/if}
          {@render shots(parts.images)}
        {/if}
      {/if}
      <!-- The note thread as a TIMELINE (reopened #11): a header line — author
           in the accent ink, time right-aligned — and the content in its own
           box below, so ragged name lengths stop pushing the text around. -->
      <div class="notes" bind:this={notesEl}>
        {#if Array.isArray(sel.notes)}
          {#each sel.notes as n, i (`${i}:${n.at}`)}
            <div class="note" class:appear={i >= notesBase}>
              <div class="n-head">
                <span class="n-author">{n.author}</span>
                <!-- The accessible route to the action row (board #46): the
                     note text stays TEXT to assistive tech — like the Chat
                     bubble — so the time is a real borderless button, Chat's
                     meta-trailer pattern. -->
                <button class="n-at" aria-label={t('hubMsgActions')}
                  onclick={(e) => { e.stopPropagation(); setNoteActions(acts.open === i ? -1 : i); }}>{ago(n.at)}</button>
              </div>
              <!-- fit-content relative wrapper: the overlay anchors to the
                   BUBBLE's corner, never the full row's far right. -->
              <div class="n-wrap">
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div class="n-text" lang={hanLang(n.body)} oncontextmenu={(e) => { noteSelectionClicks.mark(e, i); }} onclick={() => toggleNoteActs(i)}>{withImages(n.body.trim()).text}</div>
                {#if acts.open === i}
                  <div class="m-acts appear">
                    <CommandButton iconOnly icon={acts.copied ? 'check' : 'copy'}
                      label={acts.copied ? t('hubCopied') : t('hubCopy')} onclick={(event) => copyNote(i, n.body, event.currentTarget)} />
                  </div>
                {/if}
              </div>
              {@render shots(withImages(n.body).images)}
            </div>
          {/each}
        {/if}
      </div>
      <AttachStrip pending={noteStage.pending} onremove={(i) => { if (!submitting) noteStage.remove(i); }} onpreview={(u) => { shotView = u; }} />
      <div class="note-add">
        <CommandButton variant="icon" icon="plus" label={t('hubAttach')} disabled={submitting || noteStage.attaching}
          pending={noteStage.attaching} onclick={() => pickFor(noteStage)} />
        <!-- A textarea, not an input (board #28: "消息过长要自动帮我换行，
             现在是一直在一行里，前边都看不到了"): long text soft-wraps in
             the visible width and the box grows with it — the same shared
             autoGrow the title/body edits use, one line at rest. Enter
             sends (guarded: Shift+Enter inserts a real newline, and an IME
             composition's Enter commits the composition, never the note);
             clearing on send shrinks the box back through autoGrow's
             update. -->
        <textarea class="note-input" rows="1" placeholder={t('boardNotePh')} bind:this={noteEl} bind:value={noteText}
          use:autoGrow={noteText}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addNote(); } }}
          onpaste={pasteInto(noteStage)} readonly={submitting}></textarea>
        <button class="icon-btn go" title={t('save')} aria-label={t('save')} disabled={!noteStage.sendable(noteText) || busy || blocked(noteStage)} onclick={addNote}>
          <Icon name="check" size={14} />
        </button>
      </div>
    </div>
  {:else if creating}
    <!-- ── new issue: title is the one required field ── -->
    <div class="detail">
      <div class="d-head">
        <button class="icon-btn" title={t('cancel')} aria-label={t('cancel')} onclick={() => guard(() => (creating = false))}>
          <Icon name="arrow-left" size={14} />
        </button>
        <span class="d-title">{t('boardNew')}</span>
        <span class="spacer"></span>
        <button class="icon-btn go" title={t('create')} aria-label={t('create')} disabled={!(nTitle.trim() || createStage.sendable(nBody)) || busy || blocked(createStage)} onclick={createIssue}>
          <Icon name="check" size={14} />
        </button>
      </div>
      <!-- Owner-set order (2026-08-29): the title STARTS as one line and grows
           with its text; assign comes next; the body takes whatever height is
           left and scrolls INSIDE itself. -->
      <!-- svelte-ignore a11y_autofocus -->
      <textarea class="n-title one-line" rows="1" placeholder={t('boardTitlePh')} bind:value={nTitle} autofocus readonly={submitting}
        use:autoGrow={nTitle}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); createIssue(); } }}></textarea>
      <!-- Assign at birth: the same dispatch as the detail picker — the agent
           is briefed the moment the issue exists (board #11). -->
      <div class="d-meta">
        <Select value={nAssignee} dense disabled={submitting}
          options={[{ value: '', label: t('boardUnassigned') }, ...agents.map((a) => ({ value: a.name, label: a.name, icon: backendIcon(a.agent) ?? undefined }))]}
          onchange={(v: string) => { if (!submitting) nAssignee = v; }} />
      </div>
      <!-- The body is MULTI-LINE, so Enter must stay a newline — the submit
           chord is Cmd+Enter (mac) / Ctrl+Enter (elsewhere), the pair every
           chat product speaks (board #36, owner 2026-09-01: "我在 board 填写
           完 issue 描述后，可以 cmd+enter 直接提交确认"). Same createIssue as
           the ✓ — a trigger, not a second submit path — and an IME
           composition's Enter commits the candidate text, never the issue
           (the note box's precedent, board #28). -->
      <textarea class="d-body-edit fill" placeholder={t('boardBodyPh')} bind:this={createEl} bind:value={nBody}
        onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); createIssue(); } }}
        onpaste={pasteInto(createStage)} readonly={submitting}></textarea>
      <div class="attach-line">
        <CommandButton variant="icon" icon="plus" label={t('hubAttach')} disabled={submitting || createStage.attaching}
          pending={createStage.attaching} onclick={() => pickFor(createStage)} />
        <AttachStrip pending={createStage.pending} onremove={(i) => { if (!submitting) createStage.remove(i); }} onpreview={(u) => { shotView = u; }} />
      </div>
    </div>
  {:else}
    <!-- ── the board: four fixed columns, cards in movement order ── -->
    <div class="cols">
      {#each STATUSES as s (s)}
        {@const items = col(s)}
        <!-- SPARSE (0–1 cards) vs DENSE (2+) drives the 1-column layout
             (board #33): a sparse area takes header+content height only,
             dense areas flex-share what remains — the class is inert in the
             2/4-column grids (flex properties do nothing for grid items). -->
        <div class="colm" class:sparse={items.length <= 1}>
          <div class="col-h">{statusLabel(s)}<span class="col-n">{items.length}</span></div>
          <div class="col-scroll subtle-scroll" class:reveal={justLoaded}>
          {#each items as i (i.id)}
            <button class="card" animate:flip={{ duration: moveMs() }} onclick={() => openIssue(i.id)} use:hoverInfo={() => cardInfo(i)}>
              <!-- Titleless issues (board #31) wear their body excerpt as the
                   title (issueRef); the preview line then stays EMPTY — the
                   same text twice reads as a rendering bug. -->
              <span class="c-title">{issueRef(cardText(i))}</span>
              {#if i.body && i.title?.trim()}<span class="c-body">{cardText(i).body}</span>{/if}
              <span class="c-meta">
                #{i.id}
                {#if i.created_by}· {t('boardBy')} {i.created_by}{/if}
                {#if i.assignee}
                  {@const who = assigneeView(i.assignee, agents, s, backends, catalog)}
                  <!-- WHO is on it (board #293): the app's .ava tile in the
                       agent's own ink + the name; a dot on the tile's corner
                       while that agent is running (hub_agents, stateIsLive). -->
                  {#if who?.icon}·
                    <span class="c-who"><span class="c-tile"><img class="ava" src={who.icon} alt="" />{#if who.live}<span class="c-live live-dot" aria-hidden="true"></span>{/if}</span><span class="c-assignee">{who.name}</span></span>
                  {:else}· <span class="c-assignee">{who?.name === 'human' ? '@human' : who?.name ?? ''}</span>{/if}
                {/if}
                {#if noteCount(i)}· {noteCount(i)} <Icon name="chat" size={10} />{/if}
                · {ago(i.updated_at)}
              </span>
            </button>
          {/each}
          </div>
        </div>
      {/each}
    </div>
    {#if !issues.length && ready}
      <div class="empty">{t('boardEmpty')}</div>
    {/if}
  {/if}
  {#if err}<div class="err appear">{err}</div>{/if}
  </div>
  {#if visible && sel && acts.error}
    <div class="note-feedback pop-layer" use:feedbackPosition={{ trigger: copyTrigger, bounds: notesEl, scrollport: detailEl }}>
      <OperationFeedback value={{ kind: 'error', message: acts.error }} ondismiss={() => setNoteActions(acts.open)} />
    </div>
  {/if}
  </div>
  {#snippet shots(images: string[])}
    {#if images.length}
      <div class="shots">
        {#each images as src, k (`${k}-${src}`)}
          <ChatImage {src} alt={t('hubImage')} onviewstart={claimView} onview={acceptView} />
        {/each}
      </div>
    {/if}
  {/snippet}
  <input type="file" multiple hidden bind:this={fileEl} onchange={onPickFiles} />
  {#if shotView}<Lightbox src={shotView} onclose={() => { shotView = ''; }} />{/if}
  <ConfirmDialog open={!!pendingDiscard} danger={false} compact={narrowVp}
    confirmIcon="check"
    title={t('confirmDiscardTitle')} note={creating ? t('boardCreateDiscardNote') : t('boardDiscardNote')}
    confirmLabel={t('confirmDiscard')} cancelLabel={t('configKeepEditing')}
    onconfirm={() => {
      const go = pendingDiscard;
      // The question the LANDING parked is answerable only while the landing is
      // still eligible — checked BEFORE the discard clears the draft, the note
      // or the attachments, not only before the final navigation (reviewer on
      // 0b50b8c7). Other parked actions (leave walks, Back) are not the
      // landing's and keep their legitimate Discard.
      if (go && go === landingParked && landingParkedOk && !landingParkedOk()) { voidLanding(); return; }
      pendingDiscard = null; draft = { ...draftBase }; nTitle = ''; nBody = ''; nAssignee = ''; noteText = ''; createStage.clear(); bodyStage.clear(); noteStage.clear(); go?.(); }}
    oncancel={cancelDiscard} />
  <!-- Deleting is the DANGER confirmation (board #29): the dialog names the
       captured issue, nothing reaches boardDelete before the confirm, and
       busy holds the button through the RPC. -->
  <ConfirmDialog open={!!pendingDelete} danger compact={narrowVp} {busy}
    confirmIcon="trash" error={deleteError}
    title={t('boardDeleteConfirmTitle').replace('{title}', pendingDelete?.title ?? '')}
    note={t('boardDeleteConfirmNote')}
    confirmLabel={t('boardDeleteIssue')} cancelLabel={t('cancel')}
    onconfirm={confirmDelete}
    oncancel={() => (pendingDelete = null)} />
</div>

<style>
  /* Page skeleton (ui-unification §1): the shared sidebar + a main column.
     Compact is the same drill-down every page speaks: the list is the first
     screen, a picked project takes it (the back gesture peels it off). */
  /* The sidebar is a REVEAL track on the shell-wide --side-open factor
     (app.css; board #200), moved by reveal.ts like the Hub's. */
  .board-root { height: 100%; display: grid; --side-open: 1; grid-template-columns: minmax(0, calc(var(--sidebar-w) * var(--side-open))) minmax(0, 1fr); min-height: 0; background: var(--bg); overflow: hidden; }
  .board-root:global(.moving) { transition: --side-open var(--t-move) ease-out; }
  .board-root.side-collapsed { --side-open: 0; }
  .board-root.side-collapsed:not(:global(.moving)) > .sidebar { visibility: hidden; }
  .sidebar:global(.pin-end) { justify-self: end; }
  .sidebar { position: relative; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  /* The same 8px scroll inset the Chat sidebar wears — the row/header INSET
     is .side-h/.side-row's own 10px in app.css, but the container padding
     was Board's silent 0 and the whole list sat 8px left of Chat's (board
     #39: "我看 projects 这些写的位置都不一样"). */
  .side-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 8px; position: relative; }
  .side-scroll > :global(.slide-pill) { border-radius: var(--ui-radius-row); }
  /* The count on a column chip: tabular so 9→10 does not wiggle the row. */
  .b-count { font-variant-numeric: tabular-nums; }
  /* Embedded in the Hub's right drawer: one column, the drawer names the
     project — no sidebar track, no hamburger (board #13 follow-up). */
  .board-root.embedded { grid-template-columns: minmax(0, 1fr); }
  .board-root.embedded .board { padding: 10px 12px; }
  /* Compact: the sidebar is a DRAWER over the board — the sheet geometry and
     motion are the SHARED .side-sheet dialect in app.css (owner, 2026-08-30:
     one drawer for Chat/Terminal/Board), never a second page. */
  .side-toggle { display: none; flex: none; }
  @media (max-width: 760px) {
    .board-root { grid-template-columns: minmax(0, 1fr); }
    .side-toggle { display: inline-flex; }
    /* Drill motion: same 120ms grammar as the app-level page slide and
       AgentsPage. Desktop swaps the content in place — no motion. */
    .board.drill-fwd .detail { animation: drill-in-right 0.12s linear; }
    .board.drill-back .cols { animation: drill-in-left 0.12s linear; }
  }
  @media (prefers-reduced-motion: reduce) {
    .board.drill-fwd .detail, .board.drill-back .cols { animation: none; }
  }
  /* The main column: the shared page-head on top, the padded board below —
     the head spans full width like Chat's, the padding belongs to the content. */
  .bmain { display: flex; flex-direction: column; height: 100%; min-width: 0; overflow: hidden; }
  .note-feedback { position: fixed; z-index: 8; }
  .board {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* The PAGE holds still; each column scrolls its own cards (reopened #11:
       "应该是分区上下滑动才对"). The detail view brings its own scroller. */
    overflow: hidden;
    padding: 14px clamp(10px, 3vw, 28px);
    gap: 10px;
    /* Full width (board #96: "四个区域…左右占满"): the columns use whatever
       the window gives — an 1100px cap centred the board and wasted the
       margins on a wide screen. The issue DETAIL keeps a reading cap of its
       own below; prose and form fields do not improve by stretching. */
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    /* The board is the CONTAINER the column count answers to (board #27):
       the standalone page and the Hub drawer are the same rule by
       construction, because each asks its own width — the viewport plays
       no part. inline-size only: width comes from bmain either way. */
    container-type: inline-size;
    container-name: board;
  }
  .empty { color: var(--text3); font-size: var(--fs-ui); padding: 18px 6px; }
  .err { color: var(--status-danger); font-size: var(--fs-meta); }

  /* Columns: four areas can honestly tile as 1, 2 or 4 — NEVER 3 (board #27:
     "总共只有 4 个区域，控制列数在 1 2 4 不要出现 3"): at three across, the
     fourth wraps into a lonely orphan row, which is neither the side-by-side
     reading nor the stack. auto-fit was exactly the 3-column bug — it packs
     as many 170px tracks as fit, viewport and drawer alike. The ladder asks
     the BOARD container (see .board), so the standalone page and the Hub
     drawer obey the same thresholds by construction; the steps are the same
     math auto-fit used (170px min card, 10px gap): 2×170+10 = 350,
     4×170+3×10 = 710. Stacked modes cap each area's share of the height so
     every column keeps its OWN scroller — the page still holds still. */
  /* The 1-column BASE is a column flex, not an equal-row grid (board #33:
     four unconditionally equal areas squeezed every real column to a
     quarter-screen while empty ones stood stretched): a SPARSE area (0–1
     cards) is content-sized — header plus what it actually holds — and
     DENSE areas (2+) flex-share the remaining height, each keeping its own
     scroller. All four sparse leaves the leftover blank at the BOTTOM,
     never inflated into empty areas. No fixed card heights, no JS
     measuring — the class is the whole mechanism. */
  .cols {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
    flex: 1;
    min-height: 0;
  }
  .colm.sparse { flex: none; }
  .colm:not(.sparse) { flex: 1 1 0; }
  /* 1 column (board #328): every card is COMPACT — the title clamps to 2
     lines and the preview to 1 (in .c-title / .c-body below) — so a lone
     card is short by construction and #33's rule (a sparse area hugs its
     content) cannot hand it the screen. The 350px step restores the full
     card (`.card .c-*`, one step more specific than the base). */
  /* ≥2 columns: back to the #27 grid — equal rows, never 3 across; flex
     properties on .colm are inert here (grid items ignore them). */
  @container board (min-width: 350px) {
    .cols {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-auto-rows: minmax(0, 1fr);
    }
    /* The grids share height equally: the full card returns (board #328). */
    .card .c-title { -webkit-line-clamp: unset; line-clamp: none; }
    .card .c-body { -webkit-line-clamp: 4; line-clamp: 4; }
  }
  @container board (min-width: 710px) {
    .cols { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  .col-scroll {
    overflow-y: auto;
    min-height: 0;
    display: flex; flex-direction: column; gap: 6px;
    padding-bottom: 6px;
  }
  .col-h {
    font-size: var(--fs-meta);
    font-weight: 600;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 2px 6px;
    display: flex; gap: 6px; align-items: baseline;
  }
  .col-n { color: var(--text3); font-weight: 400; }
  .colm { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }

  .card {
    display: flex; flex-direction: column; gap: 3px;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-row);
    padding: 8px 10px;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
    min-width: 0;
  }
  .card:hover { background: var(--surface2); }
  .c-title {
    font-size: var(--fs-ui); color: var(--text); font-weight: 600; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
    -webkit-line-clamp: 2; line-clamp: 2;
  }
  /* The body PREVIEW (owner, 2026-08-29): short text shows whole, long text
     clamps — one mechanism, the clamp; the card is already the door to the
     detail view, so a clamped preview needs no separate "more" control.
     The card is a <button>, which wears the display (chrome) face; its body
     is the issue's own prose, so it takes the content role (design-language
     three font roles; #154 audit A3, board #246). */
  .c-body {
    font-family: var(--font-ui);
    font-size: var(--fs-meta);
    color: var(--text2);
    white-space: pre-line;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .c-meta { font-size: var(--fs-micro); color: var(--text3); display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  /* The assignee (board #293, #327): the agent's BACKEND icon in the shared
     .ava atom (the roster's avatar), then its name in --text2. The running
     dot — only in DOING — sits on the icon's top-right corner. */
  .c-who { display: inline-flex; align-items: center; gap: 5px; }
  .c-tile { position: relative; display: inline-flex; }
  .c-live {
    position: absolute; top: -2px; right: -2px; width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent); box-sizing: content-box; border: 1px solid var(--bg2);
  }
  .c-assignee { color: var(--text2); }


  /* ── detail / new form ── */
  .detail { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; overflow-y: auto; max-width: 1100px; margin: 0 auto; width: 100%; box-sizing: border-box; }
  .d-head { display: flex; align-items: center; gap: 6px; }
  .d-id { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text3); }
  .d-title { font-size: var(--fs-ui); font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .spacer { flex: 1; }
  .d-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  /* The status slider (board #15): one bordered track in the control dialect,
     equal stops; the chosen stop wears the segmented control's SELECTED look
     from design-language.md §3 — accent outline + accent wash + accent ink,
     the same as Preferences' `.segmented button.active` — never the solid
     --accent-fill, which is the CTA dialect (review, 2026-09-03). The outline
     is an inset ring because the stops share one bordered track. touch-action
     none so the sweep is ours, not the page scroll's.
     The thumb is NESTED (board #95: "边缘线条都出框了…像是真的一个滑块"):
     the track carries 3px padding, so the pill floats INSIDE the frame with
     the nested radius (outer minus inset) instead of grinding its ring
     against the track's border; the dividers are short centre detents that
     never touch the frame and step aside around the thumb. */
  .seg {
    display: inline-flex; align-items: stretch; position: relative; /* the pill's frame */
    border: 1px solid var(--border); border-radius: var(--ui-radius-control);
    background: var(--surface); overflow: hidden; padding: 3px;
    touch-action: none; user-select: none;
  }
  /* The stops sit ABOVE the pill (z-index 1 over the atom's 0) and paint no
     wash of their own — the wash + inset ring are the .slide-pill's (app.css),
     so the highlight is ONE thing that moves (motion.md principle 14). */
  .seg-b {
    border: none; background: none; cursor: pointer;
    font-size: var(--fs-meta); color: var(--text2);
    padding: 3px 12px; position: relative; z-index: 1;
    border-radius: calc(var(--ui-radius-control) - 3px);
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  /* Detents: a short centre line between stops (a pseudo, not a border — a
     border would run the stop's full height into the rounded frame). The
     pair flanking the chosen stop yields to the thumb's ring. */
  .seg-b + .seg-b::before {
    content: ''; position: absolute; left: -0.5px; top: 25%; height: 50%;
    width: 1px; background: var(--border);
    transition: background var(--t-fast);
  }
  .seg-b.on::before, .seg-b.on + .seg-b::before { background: transparent; }
  .seg-b.on { color: var(--accent); }
  .seg-b:not(.on):hover { background: var(--surface2); }
  /* The nested thumb: same wash and ring, the inner radius (atom override —
     scoped to this track; the rail and tab pills keep the atom's own). */
  .seg :global(.slide-pill) { border-radius: calc(var(--ui-radius-control) - 3px); }
  .meta-bit { font-size: var(--fs-meta); color: var(--text3); }
  .meta-bit .m-name { color: var(--accent); font-weight: 650; }
  /* The hierarchy (board #11): one compact title LINE, then the body as the
     visibly bigger field — it is the content, so it gets the space. */
  .d-title-input {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-control);
    color: var(--text);
    font-size: var(--fs-ui);
    font-weight: 600;
    padding: 7px 10px;
  }
  .d-title-input:focus { outline: none; border-color: var(--accent); }
  .d-body-edit {
    font-size: var(--fs-ui); color: var(--text);
    font-family: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-row);
    padding: 8px 10px;
    /* A floor, not a size: autoGrow raises the box to its content, so a
       two-line body is a small box and a long one opens at full height
       (owner, 2026-08-29: "有的框很大 有空白 应该自适应"). */
    min-height: 72px;
    resize: vertical;
    flex: none;
  }
  .d-body-edit:focus { outline: none; border-color: var(--accent); }
  /* Locked title/body (board #43): the same type as their editable twins,
     but PROSE — no surface, no border, no focus ring, nothing that invites
     a tap. Explicitly selectable: the app shell's global user-select:none
     (app.css) only opts inputs back in, and these are no longer inputs. */
  .d-title-static {
    color: var(--text); font-size: var(--fs-ui); font-weight: 600;
    padding: 7px 0;
    user-select: text; -webkit-user-select: text; cursor: text;
  }
  .d-body-static {
    color: var(--text); font-size: var(--fs-ui);
    white-space: pre-wrap; overflow-wrap: anywhere;
    padding: 2px 0;
    user-select: text; -webkit-user-select: text; cursor: text;
  }
  /* Timeline notes (reopened #11): author + right-aligned time on the header
     line, the content in its own box below — ragged author widths no longer
     push the text around, and the inks follow the app's hierarchy (accent
     name / grey time / full-ink content). */
  .notes { display: flex; flex-direction: column; gap: 8px; padding-bottom: calc(var(--control-height) / 2); }
  .note { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .n-head { display: flex; align-items: baseline; gap: 8px; }
  .n-author { color: var(--accent); font-weight: 650; font-size: var(--fs-meta); }
  /* A real <button> since board #46 (the accessible route to Copy — the note
     text stays text), still dressed as the quiet time it always was. */
  .n-at {
    color: var(--text3); font-size: var(--fs-micro); margin-left: auto; flex: none;
    background: none; border: none; padding: 0; font-family: inherit; line-height: 1; cursor: pointer;
  }
  /* The overlay's anchor (board #46): relative + fit-content, so .m-acts
     sits on the BUBBLE's corner — anchored to the full-width row it would
     float at the far right, nowhere near a short note. */
  .n-wrap { position: relative; width: fit-content; max-width: 100%; }
  .n-text {
    color: var(--text); font-size: var(--fs-ui);
    white-space: pre-wrap; overflow-wrap: anywhere;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-row);
    padding: 7px 10px;
    /* Every historical note is a document to READ (board #43: "所有的历史
       消息都可以手动滑动选择"): explicit opt-out of the shell's global
       user-select:none, with the text cursor saying so. */
    user-select: text; -webkit-user-select: text; cursor: text;
    /* The box HUGS its content — a one-word note is a small chip, not a
       full-width band of blank (owner, 2026-08-29). */
    width: fit-content;
    max-width: 100%;
    box-sizing: border-box;
  }
  /* The send button rides the LAST line as the box grows (board #28) —
     flex-end, not center: centered, a five-line note strands the button in
     the middle of the text block. At one line the two are the same place. */
  .note-add { display: flex; gap: 6px; align-items: flex-end; }
  /* The + and the staged chips under an editor (board #329: the composer's
     atoms, nothing new); saved images use the feed's .shots strip. */
  .attach-line { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; }
  .shots { display: flex; flex: none; flex-direction: column; gap: 6px; margin-top: 6px; border-radius: var(--ui-radius-control); overflow: hidden; }
  /* The create form's title: a textarea so it can WRAP as it grows (autoGrow),
     but dressed exactly like the input it replaces — one line at rest, no
     manual resize handle, and no flex stretch in the column layout. */
  .n-title.one-line { flex: none; resize: none; overflow: hidden; }
  /* The note reply is the same species (board #28): soft wrap in the visible
     width, autoGrow raises it, no scrollbar flash while it measures. */
  .note-input { resize: none; overflow: hidden; }
  /* The create form's body: takes the height the column has left and scrolls
     INSIDE itself (owner, 2026-08-29: "下边区域大一点 上下撑满 可以内部滚动"). */
  .d-body-edit.fill { flex: 1; min-height: 140px; overflow-y: auto; resize: none; }
  .note-input, .n-title {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-control);
    color: var(--text);
    font-size: var(--fs-ui);
    padding: 7px 10px;
    font-family: inherit;
  }
  .note-input:focus, .n-title:focus { outline: none; border-color: var(--accent); }
</style>
