<script>
  // Hub — chat-first project workspace (owner-directed IA rework 2026-08-01):
  //
  // · The DEFAULT view of a project is its CONVERSATION, full width. The
  //   terminal is a DRAWER opened by a button on the right — terminal is
  //   terminal, project is project; they are never presented as parallel
  //   equals (that layout implied the two panes were synced views of one
  //   thing, which they are not).
  // · Two kinds of windows, handled apart: MANAGED agents (spawned from the
  //   registry, tmm-wired, isolated home — the server marks them) live in
  //   the chat as cards and DM targets; DIRECT windows (shells, agents the
  //   user started by hand) exist only inside the terminal drawer's window
  //   list. Shells never get chat affordances.
  // · Tapping a managed agent's card selects it as the DM target: the
  //   composer auto-addresses @name, so "talk to THIS agent" is one tap.
  // · Agent DEFINITIONS are configured on their own page (AgentsPage), not
  //   in this sidebar. New projects pick their agents at creation time.
  import Sidebar from './Sidebar.svelte';
  import Roster from './Roster.svelte';
  import Composer from './Composer.svelte';
  import Feed from './Feed.svelte';
  import Drawer from './Drawer.svelte';
  import { copyText } from '../core/clipboard.ts';
  import OperationFeedback from '../ui/OperationFeedback.svelte';
  import { createFeedbackLifetime } from '../ui/feedback-lifetime.ts';
  import { feedbackPosition } from '../ui/feedback-position.ts';
  import Lightbox from '../ui/Lightbox.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import Select from '../ui/Select.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import './hub-atoms.css';
  import Icon from '../ui/Icon.svelte';
  import { onDestroy, untrack, tick as settled } from 'svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { sortRows } from '../projects/projects.ts';
  import { alertOf } from './notify-centre.svelte.ts';
  import { HUMAN, quotePreview, stateDotColor, mergeMessages, mergeEvents, backendColor as colorOf, feedBlocks, filterBlocks, mergeStates, pickLead, pickDrawerAgent, addressed, addressedTeam, mentionedAgents, unreadSenders, stoppedAgents, slashCommand, inputModeSwitch, issueSpans, systemLine } from './hub.ts';
  import { issueRef } from './board.ts';
  import { AGENT_TEAM, lacksCap } from '../core/login-caps.ts';
  import { resolvePathRef } from '../core/path-links.ts';
  import { createStager } from './attachments.svelte.ts';
  import { ALL_TARGET, attachmentBody, busyTargetsFor, targetMembers, targetTeam, teamRoot, teamTarget } from './hub-composer.ts';
  import { walkFeedGap } from './hub-history.ts';
  import { createHubBackRegistry } from './hub-back.ts';
  import { notifyNews, isAway, roomProjectName, playCue, systemNotify, notifyEnabled, notifyLevel, excerpt } from './notifications.ts';
  import { anchorOf } from '../ui/placement.ts';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import { groupActions, groupScope, runGroup } from './group-actions.ts';
  import { revealMs } from '../ui/motion.ts';
  import { useServerScope } from '../app/server-context.ts';
  import ServerTag from '../ui/ServerTag.svelte';
  import { titleFit } from '../ui/title-fit.ts';
  import { onRow } from '../app/server-union.ts';
  import { refKey, sessionRef } from '../app/refs.ts';
  import { pinTrack, moveTrack } from './reveal.ts';
  import CreateProjectDialog from '../projects/CreateProjectDialog.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { activeModal } from '../ui/modal.ts';

  // This server's memory — per-project lead, read mark, draft, drawer, roster,
  // the open project, and its notification centre — from the scope the
  // subtree is bound to (board #335 ②b-2-1), read once at init. The person's own preferences come through it
  // from `appPrefs`, their one owner.
  const scope = useServerScope();
  const { prefs: hubPrefs, centre } = scope.state;
  // And this server's RPCs and push stream (②b-3): the team-message stream
  // lives on the connection, the calls on the api — both from the one read.
  const {
    projectList, projectUp, projectDown, projectDelete, projectArchive, projectCreate, projectRename, listSessionsWithPanes,
    hubPost, hubCommand, modelsList, boardList, hubAgentSetTeam, hubLog, hubLogAround, hubRooms, hubUnread, hubRead, hubAgents, fsCwd, hubSpawn, hubSpawnTeam, teamsList, hubAgentStop, hubAgentRestart, hubTeamRestart, hubActivity, hubAgentRemove, hubAgentInterrupt, hubAgentInputMode, registryList,
  } = scope.runtime.api;
  const { addTeamMessageListener, removeTeamMessageListener } = scope.runtime.connection;
  // What this server's login says it can do (board #377 caps). Moving a
  // running agent between teams needs `agent_team` (#384): without it the
  // drag has no targets and the Move items are disabled, saying why.
  let loginCaps = $state(scope.runtime.connection.getCaps?.());
  $effect(() => {
    loginCaps = scope.runtime.connection.getCaps?.();
    const off = scope.runtime.connection.onCaps?.((caps) => { loginCaps = caps; });
    return () => { if (typeof off === 'function') off(); };
  });
  const moveBlocked = $derived(lacksCap(loginCaps, AGENT_TEAM));
  /* The context a card drag belongs to (board #384, reviewer P1-A): a NEW
     object whenever the project, the page's visibility, the room's readiness
     or the server's capability changes (a $derived re-runs on any input
     change, so A → B → A is two new objects, never the first one back). The
     roster captures it at the press, cancels a press or drag the moment it
     changes, and commits only while the one it captured is still this one,
     so a release after a project switch moves nothing in either project. */
  const moveScope = $derived({
    session: selected,
    ok: visible && roomReady && !moveBlocked && loginCaps !== undefined,
  });
  // This server's backend catalog (②b-3): the avatars and whether a running
  // agent can switch its input mode are its answer.
  const catalog = scope.state.backends;
  const { icon: backendIcon, togglesInputMode: backendTogglesInputMode } = catalog;
  const backendColor = (backend) => colorOf(backend, catalog);

  /** `union` (board #335 ③c-2): App's one Hub union source and the servers
   * included in it. This Hub PUBLISHES its own ordered list there, and the
   * sidebar it renders is the merged list over every included server. A
   * foreign row picked is the host's to land (`onPickServer`: focus that
   * server, select there); a foreign row's menu acts on THAT server's api
   * (`onRow`) or does nothing when it has no live runtime. Null: this Hub's
   * own list, as before (Single, or a host without the notion).
   * `scopeNote` (#364): Single with more servers saved — the sidebar's foot
   * row naming the server shown (`app/ScopeNote.svelte`); null otherwise. */
  let { visible = false, fontSize = 14, mobile = false, openTerminal = () => {}, onSelectSession = (_s) => {}, onGoBack = null, onReselect = null, openAgentConfig = null, openFilesTab = null, openBoardTab = null,
    union = null, scopeNote = null, selectRequest = null, onPickServer = null } = $props();
  const drawerId = $props.id();

  // Layout follows the viewport, not the device class (a squeezed desktop
  // window must not overflow). `mobile` still decides behavior defaults.
  let narrow = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => { narrow = mq.matches; };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });
  const compact = $derived(mobile || narrow);

  let rows = $state([]);            // ProjectRow[]
  /** Project ids present when the sidebar first filled (motion.md principle
   * 13): the first fill is not news, a project that joins later fades in. */
  let rowsBase = $state(null);
  // The recycle bin: archived projects, folded at the sidebar's bottom.
  let trash = $state([]);           // ProjectRow[] (archived)
  let trashAsk = $state(null);      // row pending PERMANENT delete (the only irreversible step)
  let panes = $state([]);           // all tmux panes
  let talkMap = $state({});         // room -> newest message ts (ms) — sidebar row times
  let agentStates = $state({});     // "<session>:<window>" -> derived state, all projects
  let selected = $state('');        // selected project session
  let selectionGeneration = 0, alive = true;
  onDestroy(() => { alive = false; selectionGeneration++; });
  let agents = $state([]);          // HubAgent[] for selected session (all windows)
  // Stopped managed agent → its team path (hub_agents, board #258), so a
  // team's "Start stopped" knows which stopped identities are its members.
  let stoppedTeams = $state({});
  let feed = $state([]);            // chat messages, oldest first
  let activity = $state([]);        // telemetry events (in-memory ring on the server)
  let lastActivityTs = 0;
  let registry = $state([]);        // RegAgent[]
  let teams = $state([]);           // RegTeam[] — configured agent teams (board #74)
  // ── Board references (board #340) ──────────────────────────────────────
  // Each project's issues as `#` names them: the composer's `#` palette and
  // the feed's `#<id>` links read the open room's. Three things are kept
  // apart (reviewer P1 on 0d48bdda):
  //   - KNOWLEDGE: the last SUCCESSFUL snapshot of a project's board
  //     (`issueBoards`). A failed read writes nothing, so it never becomes a
  //     "this issue does not exist".
  //   - READS: each started read of a project gets a number; an answer lands
  //     only if it is newer than the snapshot it would replace, so two reads
  //     finishing out of order never move the snapshot back (P2-A).
  //   - TRIGGERS: what may start a read. A `#` starting to be typed in a
  //     room (the composer's `onissues`), and a MESSAGE naming an id above
  //     the snapshot's newest, once per message per visit (`issueTriggered`,
  //     cleared when the room is entered). Ids only grow, so within a
  //     successful snapshot a missing id at or below its newest was deleted;
  //     one above it may be filed later, which a NEW message naming it, a
  //     revisit or a typed `#` asks about again. Nothing retries by itself
  //     after a failure, and nothing polls.
  // Keyed by session, so a late answer lands on its own project.
  let issueBoards = $state({});     // session → { list: IssueCandidate[], max, seq }
  const issueReads = {};            // session → number of the last read started
  const issueTriggered = {};        // session → Set of message keys that started a read this visit
  const roomIssues = $derived(issueBoards[selected]?.list ?? []);
  const roomIssueIds = $derived(roomIssues.map((i) => i.id));
  async function loadIssues(s = selected) {
    if (!s) return;
    const seq = issueReads[s] = (issueReads[s] ?? 0) + 1;
    try {
      const r = await boardList(s);
      if (!alive || seq <= (issueBoards[s]?.seq ?? 0)) return;
      const list = (r.issues ?? []).map((i) => ({ id: i.id, ref: issueRef(i), open: i.status !== 'done' }));
      issueBoards = { ...issueBoards, [s]: { list, max: list.reduce((m, i) => Math.max(m, i.id), 0), seq } };
    } catch { /* keep the last snapshot: "could not ask" is not "no issues" */ }
  }
  // The messages of this room that name an issue, by their raw body (a
  // system line carries its own board jump). The scan reads the raw text, so
  // a `#id` inside code can start a read even though it is never linked.
  const roomIssueRefs = $derived(feed.flatMap((m) => {
    if (systemLine(m.body)) return [];
    const ids = issueSpans(m.body ?? '').map((x) => x.id);
    return ids.length ? [{ key: m.id ?? `${m.ts}:${m.from}`, ids }] : [];
  }));
  $effect(() => {
    const s = selected, refs = roomIssueRefs, max = issueBoards[s]?.max ?? 0;
    if (!visible || !s || !refs.length) return;
    const triggered = (issueTriggered[s] ??= new Set());
    const fresh = refs.filter((r) => !triggered.has(r.key) && r.ids.some((id) => id > max));
    if (!fresh.length) return;
    for (const r of fresh) triggered.add(r.key);
    untrack(() => loadIssues(s));
  });
  // A choice of destination never creates a second delivery path:
  //   a name    → typed into that agent's input; exactly one agent is
  //               interrupted and starts a turn. The default (the lead).
  //   team:root → resolved at send time to that team's current managed names;
  //               one room line names each member explicitly with @name.
  //   ALL_TARGET→ `@all`: typed into EVERY managed agent's input. Every agent
  //               starts a turn at once, so this is a deliberate act, not a
  //               casual default — it is the expensive one.
  //   ''        → recorded in the room and delivered to NOBODY. Agents read it
  //               when they next call `tmm log`, which is how you leave context
  //               without interrupting anyone mid-task.
  let composerText = $state('');
  // Who the composer addresses. Defaults to the project's lead (pickLead), so
  // talking to your lead agent needs no @ ceremony.
  let recipient = $state('');
  let composer = $state(null);
  let feedView = $state(null);
  let feedActions = $state.raw(null);
  function registerFeedActions(handlers) {
    feedActions = handlers;
    return () => { if (feedActions === handlers) feedActions = null; };
  }

  // Terminal drawer (closed by default — the whole point).
  let termOpen = $state(false);
  // The drawer REVEALS and withdraws instead of appearing (board #174; the
  // technique is reveal.ts): while it closes, the Drawer stays mounted at its
  // pinned width and the grid track shrinks over it, so `drawerShown` — the
  // mount gate — is the intent OR a close in flight. `.drawer-open`, the rest
  // class the track factor follows, is the intent alone.
  let drawerClosing = $state(false);
  const drawerShown = $derived(termOpen || drawerClosing);
  let colsEl = $state(null);
  let drawerTrackEl = $state(null);
  // The project sidebar collapses and expands the same way (owner, board
  // #174: "左侧侧边栏可以加一个折叠展开的按钮 … 折叠展开最好是有动画，不是直接
  // 跳"). The state IS the app-wide preference; the desktop-only class puts
  // the track factor at 0 and hides the content at rest.
  let sideTrackEl = $state(null);
  const sideCollapsed = $derived(hubPrefs.sidebarCollapsed);
  /** Collapse: pin at the current width, rest state, move from 1. Expand:
   * rest state, flush, pin at the FINAL width, move from 0 — placed first,
   * then revealed (reveal.ts). Both through the reading anchor: the chat
   * column changes width either way. */
  async function setSidebar(collapsed) {
    if (compact || collapsed === sideCollapsed) return;
    if (!colsEl || !sideTrackEl) { hubPrefs.setSidebarCollapsed(collapsed); return; }
    if (collapsed) {
      const unpin = pinTrack(sideTrackEl, 'end');
      await withReadingAnchor(() => hubPrefs.setSidebarCollapsed(true));
      await moveTrack(colsEl, '--side-open', 1);
      unpin();
    } else {
      await withReadingAnchor(() => hubPrefs.setSidebarCollapsed(false));
      const unpin = pinTrack(sideTrackEl, 'end');
      await moveTrack(colsEl, '--side-open', 0);
      unpin();
    }
  }
  // What the drawer SHOWS: the terminal, or the file browser (owner,
  // 2026-08-28: "右侧边栏，可以展开文件浏览器的分区，类似展示 terminal 面板
  // 一样的逻辑"). One drawer, one width handle, two bodies — the hidden one
  // keeps visibility:hidden (never display:none: a re-laid-out terminal
  // would resize the pane and make the agent repaint, the .keep-rows story).
  let drawerView = $state('term');
  let drawerIssueReq = $state(null); // a feed board-line tap on desktop: open the issue in the drawer
  let drawerFilesReq = $state(null); // a feed path-reference tap: preview the file in the drawer (board #99)
  let drawerFilesBack = null;

  async function routePathRef(raw) {
    const target = selected;
    let file = raw;
    // A relative reference is relative to the PROJECT — the same base the
    // agents' own paths mean. (~ passes through; the server expands it.) The
    // declared path is that base (board #181); only a session without a
    // declaration falls back to asking where its active pane is.
    if (!file.startsWith('/') && !file.startsWith('~')) {
      const base = projectPath;
      if (base) file = resolvePathRef(base, file);
      else { try { const r = await fsCwd(target); if (r.path) file = resolvePathRef(r.path, file); } catch {} }
    }
    if (selected !== target) return;
    if (mobile || compact) { openFilesTab?.(target, '', file); return; }
    drawerFilesReq = { file, n: (drawerFilesReq?.n ?? 0) + 1 };
    drawerView = 'files'; openDrawer();
  }
  let drawerBoardNew = $state(null); // the drawer head's + (board #23): new issue, requested into the embedded Board
  let drawerFilesDir = $state(''); // where the drawer's Files is — the jump hands it over
  let termTarget = $state('');
  // The switcher bar folds non-agent windows (board #92: "只 filter 出当前有效
  // 的 agent window，其他 window 可以帮我折叠起来"): shells and other windows
  // hide behind a +N pill so they never push the agent pills out of the bar.
  // Two exceptions (hub.ts drawerWindowPills): the project's shell window
  // stays first, a terminal always at hand (#320), and the window the
  // terminal is SHOWING — the bar may never hide the current pane.
  let winsExpanded = $state(false);

  // New-project dialog.
  let createOpen = $state(false);
  let createEl = $state(null);   // the CreateProjectDialog instance (its own back layers)


  const room = (session) => `proj:${session}`;
  let lastTs = 0;

  const selectedRow = $derived(rows.find((r) => r.project.session === selected) ?? null);
  /** The project's DECLARED path — where Files opened from this room starts
   * and what a relative path reference resolves against (board #181, owner
   * 2026-09-12: "你应该默认从我们选定的项目路径去跑"). The active pane's cwd is
   * an accident of what was last touched in tmux; it stays the explicit
   * Session-directory tool and the fallback for a session with no project. */
  const projectPath = $derived(selectedRow?.project.path ?? '');
  const liveSelected = $derived(!!selectedRow?.live);
  const managedAgents = $derived(agents.filter((a) => a.managed));
  // The names `deliver_mentions` can type into — the roster the room-note
  // verdict and the composer chip's `+@name` read against.
  const managedNames = $derived(managedAgents.map((a) => a.name));
  // Declared but not running — a stopped agent still belongs to the room.
  const stopped = $derived(stoppedAgents(selectedRow?.slots, managedAgents));

  let projectReadSequence = 0, rosterReadSequence = 0;
  /** The list's own state for the union (P1-C4): has it ever answered, and
   * did the latest refresh fail. A failure keeps the rows (last good list). */
  let listAnswered = $state(false), listFailed = $state(false);
  async function reload(report = false) {
    const request = ++projectReadSequence;
    try {
      // The sidebar is ordered by CONVERSATION, so the list needs one more fact:
      // when each room last had a message. One grouped query server-side.
      const [{ projects }, sp, roomsRes] = await Promise.all([
        projectList(true),
        listSessionsWithPanes(),
        hubRooms().catch(() => ({ rooms: {}, states: {} })),
      ]);
      if (!alive || request !== projectReadSequence) return;
      listAnswered = true; listFailed = false;
      const talk = roomsRes.rooms ?? {};
      // Kept for the rows themselves: the same map that orders the sidebar
      // answers "when did this project last say something" on each row, and
      // the states map colours the agent chips (owner, 2026-08-24: "上次回复
      // 的时间 … 当前几个 Agent 的简单 logo 状态").
      talkMap = talk;
      // Overlay the current roster BEFORE adopting the snapshot: hub_rooms
      // answers on a 20s cadence, so for the selected project this response
      // is usually OLDER than the 5s roster — adopting it raw rolled the
      // sidebar dots back and the two UIs disagreed again (board #8).
      agentStates = mergeStates(roomsRes.states ?? {}, selected, agents);
      // Archived projects are the RECYCLE BIN (owner, 2026-08-21: "相当于回收
      // 站的功能"): they leave the working list and wait, restorable, in the
      // collapsed section at the bottom of the sidebar.
      const all = projects ?? [];
      trash = all.filter((r) => r.project.archived);
      rows = sortRows(all.filter((r) => !r.project.archived), talk);
      void refreshUnread();
      if (!rowsBase && rows.length) rowsBase = new Set(rows.map((r) => r.project.id));
      panes = sp.panes ?? [];
      // First load: go back to the conversation that was open, and only fall
      // back to the top row when that project is gone. Not while HIDDEN (D4):
      // opening a room is room work (its log, roster, read mark); a hidden
      // member publishes its list and waits — the room opens when it is shown.
      if (!selected && rows.length && visible) openFirst();
    } catch (e) {
      if (alive && request === projectReadSequence) listFailed = true;
      if (report && alive && request === projectReadSequence) throw e;
    }
  }

  // ③c-2: publish this server's ordered list, by this runtime; withdraw it
  // with the tree. The union is read-only to this Hub beyond its own slice.
  $effect(() => {
    if (!union) return;
    union.source.publish(scope.runtime, serverId(), { rows, talk: talkMap, unread: roomUnread, agentStates, panes, answered: listAnswered, failed: listFailed, icon: backendIcon });
  });
  $effect(() => () => { union?.source.withdraw(scope.runtime); });
  /** The sidebar's list in Aggregate: every included server's rows merged
   * by the one rule, each row with its own server's clock and maps. */
  const unionList = $derived(union ? union.source.rows(union.included) : null);
  const selectedKey = $derived(refKey(sessionRef(serverId(), selected)));
  /** A union row picked: this server's is selected here; another server's
   * is the host's to land — focus that server and select there. */
  function pickEntry(entry) {
    if (entry.serverId === serverId()) { selectProject(entry.item.project.session); sideOpen = false; return; }
    onPickServer?.(entry.ref);
    sideOpen = false;
  }
  /** A union row's menu: this server's as before; another server's offers
   * only what `onRow` can run on THAT server — nothing when it has no live
   * runtime (a view that lied here would act on the wrong machine). */
  function entryItems(entry) {
    if (entry.serverId === serverId()) return projectItems(entry.item);
    // ONE project-action flow (reviewer P1-C1 on 018d4fa5): a foreign row's
    // Close/Delete is the same `askAction` → confirm → `runAction` as a local
    // row's — Delete is close + archive, never the irreversible purge — with
    // the SOURCE api and the row's own id/name/session frozen at the ask, so
    // a focus move during the confirm changes nothing about the target.
    // `onRow` hands the act its api SYNCHRONOUSLY (frozen before any await);
    // it is captured here, once, for the whole action.
    let source = null;
    if (!onRow(entry, union?.runtimeOf ?? (() => null), (api) => { source = api; })) return [{ label: t('hubUnionUnavailable'), icon: 'info', onselect: () => {} }];
    const row = entry.item, server = entry.tag ?? entry.serverId;
    const where = { ...row, api: source, server };
    return [
      ...(row.live ? [] : [{ label: t('projectUp'), icon: 'zap', onselect: () => { void bringUpRow(where); } }]),
      ...(row.live ? [{ label: t('projectDown'), icon: 'stop', danger: true, onselect: () => askAction('down', row.project.name, row.project.session, where) }] : []),
      { label: t('projectDelete'), icon: 'trash', danger: true, onselect: () => askAction('delete', row.project.name, row.project.session, where) },
    ];
  }
  /** Open a row's project on ITS server (the local `bringUp` is the selected
   * row's). The api was frozen when the menu was built; a failure is logged
   * like the local one's — Open destroys nothing and asks nothing. */
  async function bringUpRow(where) {
    try { await where.api.projectUp(where.project.id); } catch (e) { console.warn('up failed', e); }
  }
  // A landing from another tree (③c-2): the person picked this server's
  // project in a union list while another server was focused; the host
  // moved the focus here and hands the session over.
  let selectDone = 0;
  $effect(() => {
    const req = selectRequest;
    if (!req || req.n === selectDone || req.serverId !== serverId()) return;
    selectDone = req.n;
    untrack(() => { if (req.session && req.session !== selected) selectProject(req.session); });
  });

  // A room you have visited before renders INSTANTLY from memory when you
  // return; a room you have not shows nothing until its first load answers.
  // Without both, every switch showed the empty-room PRESET panel for the
  // beat between `feed = []` and hub_log's answer — an "add an agent" pitch
  // flashing in front of rooms full of history (owner, 2026-08-25: "先看到
  // 添加 agent 一个 agent list那个页面闪了一下，然后再出来消息"). In-memory
  // only, per session; the pollers keep merging on top, so the cache is a
  // starting point, never a second source of truth.
  // ── History paging (board #9, frontend half): the first load is ONE page,
  // the poll stays incremental, and scrolling near the TOP walks backwards by
  // cursor — chat by `seq`, activity by the exact (ts, id) pair the server
  // hands back. `has_more=false` parks the walk; the cursors ride roomCache
  // so returning to a room never re-walks what it already loaded.
  let histSeq = $state(0);          // chat: oldest loaded seq (0 = no page yet)
  let histMore = $state(true);
  let actCursor = $state(null);     // activity: { ts, id } of the oldest loaded row
  let actMore = $state(true);
  let loadingOlder = $state(false); // one walk at a time — the dedupe
  const ACT_PAGE = 200;

  const roomCache = new Map();
  let roomReady = $state(false);
  /** Motion gates (motion.md principle 13: a whole list mounting at once never
   * animates). `openedAt` is the newest block timestamp once the room's first
   * load has landed — only a block NEWER than it rises in (`.appear-rise`);
   * history, an older page and a cached room are already there. `rosterBase`
   * is the set of agent names present at that same moment — a card that
   * JOINS the roster later pops in, a project switch replays nothing. Both
   * are reset to "nothing is fresh" while a room is loading. */
  let openedAt = $state(Infinity);
  let rosterBase = $state(null);
  /** A load unfolds (motion.md principle 15, wave 8): while an UNCACHED room
   * loads (`!roomReady`) the feed and roster show skeletons of the coming
   * shape (`.skel-wrap` keeps them invisible for 150ms, so a fast answer never
   * flashes one); when the room settles, `justLoaded` puts `.reveal-tail` on
   * the feed and `.reveal` on the roster for ONE unfold. It is cleared by a
   * timer rather than left on: the atoms animate every child that MOUNTS
   * while the class is present, and an older page prepended by `loadOlder`
   * (or the empty-room panel) must not rise (principle 13) — the timer runs
   * one --t-move plus the atom's longest stagger (210ms) and a margin, and is
   * zero-plus-margin under reduced motion, where the atom is inert anyway.
   * A cached room never sets it: its content is already there. */
  let justLoaded = $state(false);
  let justLoadedTimer = null;
  function unfold() {
    clearTimeout(justLoadedTimer);
    justLoaded = true;
    justLoadedTimer = setTimeout(() => { justLoaded = false; }, revealMs());
  }

  /** `claim` is the centre jump that is opening this room (board #322); any
   * other call is the reader choosing a room, which ends a pending jump at
   * once — it may not land later, and it stops suppressing this room's
   * markSeen now. */
  async function selectProject(session, claim = 0) {
    if (jumpIntent && jumpIntent !== claim) { const n = jumpIntent; jumpIntent = 0; centre.consume(n); }
    headerCopyLifetime.clear();
    commandFeedbackLifetime.clear();
    selectionGeneration++;
    actionReadError = ''; actionRefreshing = false;
    // An unsent line belongs to the conversation it was written for. Park it on
    // the project we are leaving and pick up whatever was waiting in the new one
    // — carrying the text across would put it in front of the wrong agents.
    if (selected) hubPrefs.setDraft(selected, composerText);
    // Park the room too, so switching back is instant.
    // A history window is not the room's state; it is never parked (#322).
    if (selected && windowed) roomCache.delete(selected);
    else if (selected) roomCache.set(selected, { feed, lastTs, activity, lastActivityTs, agents, histSeq, histMore, actCursor, actMore });
    if (selected !== session || !jumpIntent) { windowed = null; revealId = ''; filterBefore = ''; filterNote = ''; }
    newReading();
    // Entering a room is a revisit: its messages may ask the board again (#340).
    delete issueTriggered[session];
    selected = session;
    openedAt = Infinity; rosterBase = null; // nothing is fresh until this room has settled
    startJoin = ''; // a picker's Join belongs to the project it was opened in (#382)
    clearTimeout(justLoadedTimer); justLoaded = false; // an unfold belongs to the room that loaded
    composerText = hubPrefs.draft(session);
    clearAttachments(); // staged for one room; must not ride into another
    feedView?.resetForRoom();
    hubPrefs.setProject(session);
    // The chat's project is a working context like the terminal's: tell App,
    // so the Files tab follows whichever the user touched LAST (owner,
    // 2026-08-22: "chat里的路径没有刷新到文件 terminal好像就会刷新路径").
    onSelectSession(session);
    const c = roomCache.get(session);
    feed = c?.feed ?? [];
    activity = c?.activity ?? [];
    lastActivityTs = c?.lastActivityTs ?? 0;
    lastTs = c?.lastTs ?? 0;
    agents = c?.agents ?? [];
    histSeq = c?.histSeq ?? 0;
    histMore = c?.histMore ?? true;
    actCursor = c?.actCursor ?? null;
    actMore = c?.actMore ?? true;
    loadingOlder = false;
    // A cached room is ready NOW (its pollers refresh underneath); an unknown
    // one may not claim "empty" until its first load has actually answered.
    roomReady = !!c;
    recipient = '';
    // The cached roster can seat the recipient immediately — same rule as
    // loadAgents, which will confirm or correct it when the fresh roster lands.
    if (agents.length) recipient = pickLead(agents, hubPrefs.lead(session));
    // A stored team is NOT judged here: a cold room has no roster yet, and
    // "no members known" is not "no members". loadAgents drops a stale team
    // once the fresh roster answers (#241, validator: a refresh wiped it).
    filterAgent = ''; // a filter is a reading choice, scoped to its room
    replyTo = null; // a quote belongs to the room it was taken in
    // The drawer follows the project (board #23, owner: "chat的右侧边栏打开
    // 哪个的状态前端帮我记住，这样我切换不同的 project 回来原来的视图还在"):
    // whichever partition was open when the user LEFT this room reopens on
    // return, and a room where it was closed comes back closed. No reading
    // anchor here — selectProject lands at the tail regardless.
    const dv = compact ? '' : hubPrefs.drawer(session);
    if (dv) drawerView = dv;
    termOpen = !!dv;
    // The old room's pane must never leak into this one's terminal partition
    // — and the unfold is a transient reading of THAT room's bar (board #92).
    termTarget = ''; winsExpanded = false;
    // Seat the recipient's pane (board #209): the card the user left selected
    // and the pane beside it are ONE choice — same rule as openDrawer/#91.
    if (dv === 'term') {
      const pick = pickDrawerAgent(agents, recipient);
      if (pick) pickWindow(pick);
    }
    // Entering a room lands at its tail, cached or not — a parked scrollTop
    // from the LAST room would point at arbitrary content in this one.
    // A jump owns the landing (board #322): no tail, no seen, until it lands.
    following = !jumpIntent;
    if (feed.length && !jumpIntent) scrollFeed(true);
    await Promise.all([loadFeed(), loadAgents(), loadActivity()]);
    if (selected === session) {
      // An uncached room's first fill unfolds (the skeleton has been standing
      // in for it); a cached one was already on screen and stays a cut.
      if (!c) unfold();
      roomReady = true;
      // The room has settled: from here on, what arrives is news and moves.
      openedAt = blocks.reduce((m, b) => Math.max(m, b.ts), 0);
      rosterBase = new Set([...managedAgents.map((a) => a.name), ...stopped]);
    }
    // A restored terminal partition may have had NO roster to pick from (a
    // first visit after reload restores before any cache exists) — seat it
    // once the fresh roster is in, beside the recipient (#209).
    if (selected === session && termOpen && drawerView === 'term' && !termTarget) {
      const pick = pickDrawerAgent(agents, recipient);
      if (pick) pickWindow(pick);
    }
  }

  async function loadFeed(report = false) {
    if (!selected || windowed) return; // a history window takes no live rows (#322)
    // The answer must still be about the question: every poller here freezes
    // the project it asked ABOUT and drops the reply if the user has switched
    // meanwhile — a late resolve was merging the OLD room's messages into the
    // NEW room's feed (same identity bug as the context-menu close: resolving
    // a live `selected` after the fact; owner, 2026-08-24).
    const s = selected;
    const g = readGen;
    const ours = () => selected === s && readGen === g && !windowed;
    try {
      // First load asks for ONE page (the server's newest 100) and keeps its
      // cursor; every later call is the same incremental since_ts poll as
      // before (board #9).
      const first = lastTs === 0 && histSeq === 0;
      const floorTs = lastTs;
      const res = await hubLog(s, lastTs, 100);
      if (selected !== s) return;
      const messages = res.messages;
      // The batch is news even when the feed is no longer the one it was
      // asked for (a jump landed meanwhile): notify first, then decide.
      if (messages?.length) notifyNews(messages, newsCtx(room(s), s, first), undefined, newsEffects);
      if (!ours()) return;
      if (first) {
        histSeq = res.oldest_seq ?? 0;
        histMore = (res.has_more ?? false) && histSeq > 0;
      } else if (res.has_more && (res.oldest_seq ?? 0) > 0) {
        // More than a page arrived since the cursor (a room parked in
        // roomCache while the team talked): the poll's page is the NEWEST 100
        // and `has_more` says newer-than-cursor rows lie behind it. Walk them
        // in before the cursor moves past them — the hole was permanent
        // otherwise (review C, 2026-09-03). Bounded: 50 pages is 5000 messages
        // in one absence, past which the first-load page is the honest answer.
        const walked = await walkFeedGap({ session: s, floorTs, cursor: res.oldest_seq }, {
          readPage: (session, cursor) => hubLog(session, 0, 100, cursor),
          stillCurrent: (session) => selected === session && ours(),
          mergePage: (newer) => { if (ours()) feed = mergeMessages(feed, newer); },
        });
        // The helper return adds an await boundary before adopting the poll batch.
        if (!walked || !ours()) return;
      }
      if (messages?.length) {
        feed = mergeMessages(feed, messages);
        lastTs = Math.max(lastTs, ...messages.map((m) => m.ts ?? 0));
        // New-message notification (board #57) ran above, before the
        // generation check: a poll batch that lands while the reader is AWAY
        // plays the cue and raises a system notification. The first page is
        // history, never news. This is the FALLBACK site: the push handler is
        // where an off-screen reader is actually reached (board #72); sift's
        // seen keys make the two alert once.
        if (following) scrollFeed(); else newBelow = true;
      }
    } catch (e) { if (report) throw e; /* hub not available */ }
  }

  async function loadActivity() {
    // Polled at EVERY feed level: delivery receipts and undelivered-line
    // reports ride this channel, and those are about the message the user just
    // sent, not opt-in telemetry detail. feedBlocks does the level filtering.
    if (!selected) return;
    const s = selected;
    try {
      const first = lastActivityTs === 0 && !actCursor;
      const res = await hubActivity(s, lastActivityTs);
      if (selected !== s) return;
      const events = res.events;
      if (first) {
        actCursor = res.oldest ?? null;
        actMore = (res.has_more ?? false) && !!actCursor;
      }
      if (events?.length) {
        // mergeEvents, not concat-and-slice: the old -300 cap EVICTED the
        // history pages the user had walked to (board #9), and id-keyed
        // dedupe is what makes a prepend and a poll meet without doubles.
        activity = mergeEvents(activity, events);
        lastActivityTs = Math.max(lastActivityTs, ...events.map((e) => e.ts));
        // Telemetry rows are not "news": they extend the tail, so follow if we
        // were following, but they must not raise the new-messages dot.
        if (following) scrollFeed();
      }
    } catch { /* hub not available */ }
  }

  async function loadAgents(report = false) {
    if (!selected) return;
    const s = selected;
    const request = ++rosterReadSequence;
    try {
      const r = await hubAgents(s);
      const got = r.agents ?? [];
      // A stale success is as wrong as a stale feed: the OLD project's roster
      // must not dress the NEW project (and then re-pick its recipient).
      if (selected !== s) return;
      if (!alive || request !== rosterReadSequence) return;
      agents = got;
      stoppedTeams = r.stopped_teams ?? {};
      // The sidebar chips share this truth (board #8): the roster is the
      // freshest reading for THIS project, so its states overwrite the
      // 20s-cadence snapshot's keys instead of disagreeing beside them.
      agentStates = mergeStates(agentStates, s, got);
      // The recipient follows the room: an agent that left cannot be the
      // recipient, and a room that just gained its first agent gets a lead
      // without the user choosing one. ALL_TARGET is not a window, so it stays.
      const emptyTeam = !!targetTeam(recipient) && !targetMembers(recipient, agents).length;
      if (emptyTeam) { recipient = ''; hubPrefs.setLead(selected, ''); }
      else if (recipient && recipient !== ALL_TARGET && !targetTeam(recipient)
        && !agents.some((a) => a.managed && a.name === recipient)) recipient = '';
      if (!recipient && !emptyTeam) recipient = pickLead(agents, hubPrefs.lead(selected));
      // The answered roster is the one judge of a stored team: kept while it
      // has members, forgotten once it has none.
      const storedLead = hubPrefs.lead(selected) ?? '';
      if (targetTeam(storedLead) && !targetMembers(storedLead, agents).length) hubPrefs.setLead(selected, '');
    } catch (e) {
      if (!alive || request !== rosterReadSequence || selected !== s) return;
      if (report) throw e;
      // "I could not ask" is not "there is nobody". Emptying the roster on a
      // failed poll is what made the cards — and with them the model and context
      // readings — blink away whenever the socket hiccuped or an RPC timed out
      // (owner, 2026-08-19: "有时候会闪没了，是不是中间心跳失败了"). The roster is
      // a last-known state; `selectProject` is the one place that clears it,
      // because that is the one time it is genuinely unknown.
      console.warn('hub agents poll failed, keeping the last roster', e);
    }
  }

  const scrollFeed = (force = false) => feedView?.scrollToTail(force);

  /** The unread cue means "an agent said something and you have not looked".
   * So it clears when the newest message is on screen — the bottom of the
   * feed — and when you send, since you are plainly looking then. The mark is
   * the newest message's seq (board #322; two messages can share a ms). */
  function markSeen() {
    if (!selected || !visible || windowed || jumpIntent) return;
    const newest = feed.reduce((best, m) => ((m.seq ?? 0) > (best?.seq ?? 0) ? m : best), null);
    const mark = hubPrefs.seen(selected);
    if (!newest || (newest.seq ?? 0) <= mark.seq && (newest.ts ?? 0) <= mark.ts) return;
    const next = { seq: newest.seq ?? 0, ts: Math.max(mark.ts, newest.ts ?? 0) };
    hubPrefs.setSeen(selected, next);
    centre.markRoomRead(selected, newest.seq ?? 0);
    // The room is read: its cue goes now (an optimistic cache), the server
    // is told, and the mark stays PENDING until hub_read ACKs it (#334).
    if (roomUnread[selected]) { const { [selected]: _, ...rest } = roomUnread; roomUnread = rest; }
    pendingRead[selected] = next;
    void flushRead([selected]);
    void refreshUnread([selected]);
  }

  // ── The shared read mark (board #334) ────────────────────────────────
  // The server holds ONE read mark per room for the human; `hubPrefs.seen`
  // is this client's cache of it. A mark this client set is PENDING until
  // `hub_read` ACKs it; a failed or lost ACK is re-sent by the next
  // `refreshUnread` (the 20 s sidebar cadence, a push, a reconnect). With
  // nothing pending, the cache adopts the server's PERSISTED mark — another
  // client's reading, or the server's correction of an impossible cache.
  // A server switch remounts this page; an answer that lands after it, or
  // for another server id, touches nothing.
  //
  // A pending mark clears only on THIS room's ACK at or above it: an absent
  // room (a partial or empty answer) stays pending and is re-sent. Every
  // ACK of a room bumps its CONFIRM generation, and a `hub_unread` answer
  // asked before that bump never adopts — its persisted mark predates the
  // write, and adopting it would roll the room back (equal values do not
  // prove the answer is newer). Answers are also applied in ask order: an
  // older answer landing after a newer one is dropped. Pending lives for
  // this Hub's lifetime only: a mark still pending at close is re-derived
  // from the server on the next mount (at worst one just-read message shows
  // unread again until the next read).
  const pendingRead = {};          // session -> the mark not yet ACKed
  const confirmGen = {};           // session -> ACKs seen
  const answeredAsk = {};          // session -> newest hub_unread ask applied
  let unreadAsks = 0;
  function adoptMark(s, m) {
    const cur = hubPrefs.seen(s);
    const seq = Number(m?.seq) || 0, ts = Number(m?.ts) || 0;
    if (cur.seq === seq && cur.ts === ts) return;
    hubPrefs.setSeen(s, { seq, ts });
    if (seq > cur.seq) centre.markRoomRead(s, seq);
  }
  async function flushRead(sessions = Object.keys(pendingRead)) {
    const ask = {};
    const sent = {};
    for (const s of sessions) {
      const p = pendingRead[s];
      const row = rows.find((r) => r.project.session === s);
      if (!p || !row) continue;
      ask[roomKey(row)] = p.seq > 0 ? { seq: p.seq } : { ts: p.ts };
      sent[roomKey(row)] = { s, p };
    }
    if (!Object.keys(ask).length) return;
    const server = serverId();
    const res = await hubRead(ask).catch(() => null);
    if (!res || !alive || serverId() !== server) return;   // still pending: the next refresh re-sends
    for (const [key, { s, p }] of Object.entries(sent)) {
      const ack = res.rooms?.[key];
      if (!ack) continue;                                    // not confirmed: still pending
      confirmGen[s] = (confirmGen[s] ?? 0) + 1;              // every unread answer asked before is stale
      if (pendingRead[s] !== p) continue;                    // a newer read is on its way
      if (p.seq > 0 ? (Number(ack.seq) || 0) < p.seq : !(Number(ack.seq) > 0)) continue;
      delete pendingRead[s];
      adoptMark(s, ack);
    }
  }
  const unread = $derived(unreadSenders(feed, hubPrefs.seen(selected)));

  // ── Notification centre wiring (board #322) ──────────────────────────
  // Every batch goes through notifyNews; the centre records what it calls
  // news BEFORE mute/level/away decide the sound, under this server's id. A
  // message that lands while the reader is at that room's visible tail is
  // recorded already viewed.
  // The server this Hub is bound to — its scope's, never CURRENT (reviewer P1
  // on the b3 binding range): an alert filed under whichever server is current
  // would be mislabelled the moment two are on screen. Constant for this
  // instance; a switch destroys the Hub and its in-flight work with it.
  const serverId = () => scope.runtime.id;
  function newsCtx(roomName, session, first) {
    const here = !!selected && roomName === room(selected);
    const away = !here || isAway(visible);
    return {
      first, away, project: roomProjectName(rows, roomName),
      server: serverId(), room: roomName, session,
      viewed: !away && following && !windowed,
      // The tray title names the server by the one tag rule (③c-1/③c-4).
      ...(scope?.tag ? { serverName: scope.tag } : {}),
    };
  }
  const newsEffects = {
    cue: playCue, sys: systemNotify, enabled: notifyEnabled, level: notifyLevel,
    record: (m, c) => centre.record(alertOf(m, { server: c.server, room: c.room, session: c.session, project: c.project, kind: c.kind, viewed: !!c.viewed, excerpt: excerpt(m.body ?? '') })),
  };

  // The jump to a centre entry's message (board #322). One request at a
  // time: a newer request, a room change or a server switch (which remounts
  // this page and reloads the centre) supersedes it, and a superseded jump
  // changes neither the view nor viewed. The room is the target's; when the
  // message is not in the loaded feed, ONE page around it (`around_seq`)
  // becomes the feed as a HISTORY WINDOW — not the tail: no live rows merge
  // into it, seen does not move, it is never parked, older pages still walk
  // from its top, and "Back to latest" swaps the tail page in only once it
  // has answered. viewed only when the message is mounted and scrolled to.
  let jumpIntent = 0;
  // ONE reading generation for the visible feed (board #322 review): every
  // write into the feed, its cursors or its anchor — tail poll, gap walk,
  // older page, around_seq landing, Back-to-latest completion — captures it
  // when its request STARTS and is dropped if it moved by the time the
  // answer lands. A jump, a return and a room switch each mint a new one (a
  // server switch remounts the page). Dropped rows still went through
  // notifyNews, so the centre, the cue and unread lose nothing.
  let readGen = 0;
  const newReading = () => ++readGen;
  let windowed = $state(null);      // {newestSeq, newestTs} while a window is on screen
  let revealId = $state('');        // the target a level/filter would hide, kept for this jump
  let filterNote = $state('');      // "filter cleared for this jump" — visible, Back restores it
  let filterBefore = '';
  $effect(() => {
    const req = centre.jump;
    if (!req || !visible || !alive) return;
    untrack(() => { void openAt(req); });
  });
  async function openAt({ alert, n }) {
    // The request is CLAIMED before anything awaits, and every exit —
    // including these preflight refusals — consumes the same `n` (finally).
    // After an await the claim is re-checked BEFORE a new generation is
    // minted, so a stale continuation can never take a newer request's (or
    // a manual room switch's) reading away.
    jumpIntent = n;
    let g = 0;
    let row = null;
    let sel = selectionGeneration;
    // The selection generation this jump caused (or found): a reader's own
    // room choice — even back to the same room — moves it, so a stale
    // continuation can never re-claim by the room's name.
    const claimed = () => centre.isCurrent(n) && jumpIntent === n && alive && visible && !!row && selected === row.project.session && selectionGeneration === sel;
    const current = () => claimed() && readGen === g;
    try {
      if (alert.server && alert.server !== serverId()) { centre.failed(alert.key, t('hubJumpOtherServer')); return; }
      row = rows.find((r) => r.project.session === alert.session || roomKey(r) === alert.room) ?? null;
      if (!row) { centre.failed(alert.key, t('hubJumpNoProject')); return; }
      if (selected !== row.project.session) {
        const opening = selectProject(row.project.session, n);
        sel = selectionGeneration; // our own switch's generation, taken before it awaits
        await opening;
      }
      if (!claimed()) return;
      g = newReading(); // this jump owns the visible feed from here on
      if (!current()) return;
      // A room-scoped reading filter that would hide the target is cleared
      // VISIBLY (the chip changes; Back puts it back). The level is a stored
      // preference and is never touched: the target is revealed instead.
      if (filterAgent) { filterBefore = filterAgent; filterAgent = ''; filterNote = t('hubJumpFilterCleared'); }
      revealId = alert.id;
      if (!feed.some((m) => String(m.id) === alert.id)) {
        const res = await hubLogAround(row.project.session, alert.seq, 100).catch(() => null);
        if (!current()) return;
        if (!res) { centre.failed(alert.key, t('hubJumpLoadFailed')); return; }
        const msgs = res.messages ?? [];
        if (!msgs.some((m) => String(m.id) === alert.id)) { centre.failed(alert.key, t('hubJumpGone')); return; }
        feed = msgs;
        histSeq = res.oldest_seq ?? 0;
        histMore = (res.has_more ?? false) && histSeq > 0;
        if (res.newer_more) {
          windowed = { newestSeq: msgs.at(-1)?.seq ?? 0, newestTs: msgs.at(-1)?.ts ?? 0 };
        } else {
          // The page reaches the room's newest message: it IS the tail.
          lastTs = Math.max(0, ...msgs.map((m) => m.ts ?? 0));
        }
      }
      following = false;
      await settled();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (!current()) return;
      if (feedView?.showMsg(alert.id)) centre.viewed(alert.key);
      else centre.failed(alert.key, t('hubJumpGone'));
    } finally {
      if (jumpIntent === n) jumpIntent = 0;
      centre.consume(n); // one-shot: never replayed, never a newer request's
    }
  }
  // Leaving the Hub page invalidates a pending jump: it may not land on a
  // hidden feed, mark anything viewed, or move the reader on return.
  $effect(() => {
    if (visible) return;
    untrack(() => { if (jumpIntent) { const n = jumpIntent; jumpIntent = 0; newReading(); centre.consume(n); } });
  });
  /** Back to latest from a history window: the window stays (no live rows,
   * no seen) until the tail page answers for the same room and intent, then
   * messages, activity bound and cursors are replaced in one step. A failure
   * keeps the window and its control for a retry. */
  function restoreFilter() {
    filterAgent = filterBefore; filterBefore = ''; filterNote = '';
  }
  async function returnToLatest() {
    if (!windowed || !selected) { scrollFeed(true); return; }
    const s = selected;
    const g = newReading(); // a return is a reading of its own: a later jump supersedes it
    const res = await hubLog(s, 0, 100).catch(() => null);
    if (!alive || selected !== s || readGen !== g || !windowed) return;
    if (!res) return; // the window and its control stay; tap again to retry
    const msgs = res.messages ?? [];
    feed = msgs;
    lastTs = Math.max(0, ...msgs.map((m) => m.ts ?? 0));
    histSeq = res.oldest_seq ?? 0;
    histMore = (res.has_more ?? false) && histSeq > 0;
    windowed = null;
    revealId = '';
    newBelow = false;
    following = true;
    scrollFeed(true);
  }

  // Unread per ROOM, for every project (board #322): the server's summary of
  // the news above each room's read mark — `hub_unread`, the same news rule
  // as the roster dot. Asked with every sidebar read, at once for a room a
  // push touched, and for the open room when it is read. An answer is applied
  // only while the mark it was asked with is still the room's mark: a newer
  // mark means a fresher question is already on its way.
  let roomUnread = $state({});      // session -> {count, first_seq, last_seq}
  const roomKey = (r) => r.project.room ?? `proj:${r.project.session}`;
  async function refreshUnread(sessions = rows.map((r) => r.project.session)) {
    const asked = {};
    const marks = {};
    for (const s of sessions) {
      const row = rows.find((r) => r.project.session === s);
      if (!row) continue;
      const mark = hubPrefs.seen(s);
      marks[roomKey(row)] = mark.seq > 0 ? { seq: mark.seq } : { ts: mark.ts };
      asked[roomKey(row)] = { s, mark, gen: confirmGen[s] ?? 0 };
    }
    if (!Object.keys(marks).length) return;
    const server = serverId();
    const n = ++unreadAsks;
    const res = await hubUnread(marks).catch(() => null);
    if (!res || !alive || serverId() !== server) return;
    const next = { ...roomUnread };
    const retry = [];
    for (const [key, { s, mark, gen }] of Object.entries(asked)) {
      const now = hubPrefs.seen(s);
      if (now.seq !== mark.seq || now.ts !== mark.ts) continue;
      if ((answeredAsk[s] ?? 0) > n) continue;               // a newer answer already landed
      answeredAsk[s] = n;
      if (res.rooms?.[key]) next[s] = res.rooms[key];
      else delete next[s];
      // #334: a pending mark is re-sent; otherwise the cache becomes the
      // server's persisted mark (absent = the server has none). A pre-#334
      // server answers no `marks` at all and the cache is left alone.
      if (pendingRead[s]) retry.push(s);
      else if (res.marks && (confirmGen[s] ?? 0) === gen) adoptMark(s, res.marks[key] ?? { seq: 0, ts: 0 });
    }
    roomUnread = next;
    if (retry.length) void flushRead(retry);
  }
  let unreadPushTimer = 0;
  const unreadPushed = new Set();
  function unreadSoon(room) {
    const row = rows.find((r) => roomKey(r) === room);
    if (!row) return;
    unreadPushed.add(row.project.session);
    clearTimeout(unreadPushTimer);
    unreadPushTimer = setTimeout(() => { const s = [...unreadPushed]; unreadPushed.clear(); void refreshUnread(s); }, 400);
  }

  let following = $state(true);   // the feed is parked at the tail
  let newBelow = $state(false);   // something arrived while it was not
  /** Walk one page BACK on each channel that still has one (board #9). One
   * walk at a time; the response is dropped if the room changed underneath;
   * the prepend re-enters through withReadingAnchor so the line being read
   * stays put — a jump to the tail here would throw the reader out of the
   * history they came for. */
  async function loadOlder() {
    if (loadingOlder || !selected || (!histMore && !actMore)) return;
    const s = selected;
    const g = readGen;
    loadingOlder = true;
    try {
      const [older, olderAct] = await Promise.all([
        histMore && histSeq > 0 ? hubLog(s, 0, 100, histSeq) : Promise.resolve(null),
        actMore && actCursor ? hubActivity(s, 0, { limit: ACT_PAGE, before: actCursor }) : Promise.resolve(null),
      ]);
      if (selected !== s || readGen !== g) return; // the room or the reading changed — this page is not ours
      // AWAITED: withReadingAnchor is async (it settles the DOM and then
      // compensates scrollTop). Releasing `loadingOlder` before that scroll
      // lands let the compensation itself re-enter onFeedScroll and walk the
      // SAME cursor twice (#9 review).
      await withReadingAnchor(() => {
        if (older) {
          if (older.messages?.length) feed = mergeMessages(feed, older.messages);
          histSeq = older.oldest_seq ?? histSeq;
          histMore = (older.has_more ?? false) && (older.oldest_seq ?? 0) > 0;
        }
        if (olderAct) {
          if (olderAct.events?.length) activity = mergeEvents(activity, olderAct.events);
          actCursor = olderAct.oldest ?? actCursor;
          actMore = (olderAct.has_more ?? false) && !!olderAct.oldest;
        }
      });
    } catch { /* keep the cursors — the next nudge retries */ }
    finally {
      if (selected === s) loadingOlder = false; // released for the next reading too
    }
  }

  async function send() {
    const raw = composerText.trim();
    if ((!raw && !pending.length) || !selected) return;
    // While a stage job is in flight the message is NOT whole yet: sending
    // now would post the text without its attachment, and the attachment
    // would land in an emptied composer as an orphaned token (lead review,
    // board #25). The button is disabled too — this entry guard covers the
    // keyboard's Enter and any future caller.
    if (attaching) return;
    // A failed attachment stays a visible chip until the user removes it: a
    // message that quietly left without the file it showed is the failure
    // mode this exists to prevent (review, 2026-09-03).
    if (failed) return;
    const team = targetTeam(recipient);
    const members = team ? targetMembers(recipient, agents) : [];
    const cmd = slashCommand(raw);
    if (team && !members.length) {
      setRecipient('');
      if (!cmd?.to && !mentionedAgents(raw, targetMembers(ALL_TARGET, agents)).length) return;
    }
    // A SLASH COMMAND goes to the agent's CLI, not to its model, so it is typed
    // verbatim — no `[tmm chat …] human:` stamp, no @address, nothing the TUI
    // would read as prose. It needs a target: an explicit `@name`, else the
    // composer's recipient. A team fans out via the same native per-name RPC
    // as any explicit address. With neither (a room note) there is nobody to run
    // it, so it stays an ordinary message rather than vanishing.
    const cmdTarget = cmd && (cmd.to || (recipient === ALL_TARGET ? 'all' : recipient));
    if (cmd && cmdTarget) {
      const room = selected; // same room-snapshot rule as the message path
      const feedbackToken = commandFeedbackLifetime.begin();
      commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
      const commandName = cmd.command.split(/\s/u, 1)[0];
      composerText = '';
      following = true;
      scrollFeed(true);
      try {
        if (team && !cmd.to) {
          const results = await Promise.allSettled(members.map((name) => hubCommand(room, name, cmd.command)));
          const failedNames = members.filter((_name, i) => results[i].status === 'rejected');
          if (failedNames.length === results.length) throw results[0].reason;
          if (failedNames.length && selected === room) commandFeedbackLifetime.update(feedbackToken, {
            kind: 'error', message: t('hubCommandFailedFor').replace('{command}', commandName).replace('{names}', failedNames.join(', ')),
          });
        } else {
          await hubCommand(room, cmdTarget, cmd.command);
        }
        if (selected !== room) return;
        await loadFeed();
        scrollFeed(true);
      } catch (e) {
        console.warn('hub command failed', e);
        if (selected === room) {
          composerText = raw;
          commandFeedbackLifetime.update(feedbackToken, {
            kind: 'error', message: t('hubCommandFailed').replace('{command}', commandName),
          });
        }
      }
      return;
    }
    // The recipient makes "talk to THIS agent" the default rather than a
    // gesture: addressed() prefixes @name unless the user @-addressed someone
    // by hand, and an empty recipient posts to the room.
    const atts = pending;
    const body = attachmentBody(raw, atts);
    const text = team ? addressedTeam(body, members) : addressed(body, recipient);
    // Room snapshot: everything after the await below must answer to the
    // room this message BELONGS to, never to whichever room is on screen
    // when the RPC returns (lead review, board #25, round 2 — the success
    // path reset attachSeq into a room that had meanwhile staged its own
    // attachments, colliding token numbers, and refreshed the wrong feed).
    const room = selected;
    const re = replyTo?.id;
    const quoteBack = replyTo;
    composerText = '';
    stager.pending = []; // detached, not cleared: the thumbs live until the post settles
    replyTo = null;
    following = true;
    scrollFeed(true);
    try {
      await hubPost(room, text, 'human', re);
      // The thumbs belong to the delivered attachments — dead either way.
      for (const a of atts) if (a.thumb) URL.revokeObjectURL(a.thumb);
      if (selected !== room) return; // the new room's numbering/feed are not ours
      stager.resetSeq();
      await loadFeed();
      scrollFeed(true);
    } catch (e) {
      console.warn('hub post failed', e);
      // A post that fails AFTER the user switched projects must not restore
      // the old room's draft/attachments into the new one. The refs are
      // already uploaded; the draft is lost with the failed post — losing it
      // beats corrupting another room.
      if (selected === room) { stager.pending = atts; composerText = raw; if (re && !replyTo) replyTo = quoteBack; }
      else for (const a of atts) if (a.thumb) URL.revokeObjectURL(a.thumb);
    }
  }

  // ── Attachments (board #25): the ONE pipeline lives in attachments.svelte.ts
  // (board #329 moved it there unchanged; the Board's editors use it too).
  // This room's stager: uploads land in the selected project, tokens at the
  // composer's caret. Uploaded attachments wait as chips above the textarea
  // (owner, 2026-08-26: "消息框内部不展示完整的上传图片的 markdown 格式路径")
  // and their refs join the body at SEND time, where each token stood.
  const stager = createStager({
    api: scope.runtime.api,
    ws: () => selectedRow?.project.path,
    getText: () => composerText,
    setText: (v) => { composerText = v; },
    caret: () => composer?.caret(),
    focus: () => composer?.focus(),
  });
  const pending = $derived(stager.pending);
  const attaching = $derived(stager.attaching);
  // A failed chip is not content: it does not make the composer sendable, and
  // while one is staged nothing sends (send() and the button agree, the same
  // two-gate rule as `attaching`) — the user removes it or re-attaches.
  const failed = $derived(stager.failed);
  const sendable = $derived(stager.sendable(composerText));
  const stageFiles = (files) => stager.stage(files);
  const removeAttachment = (i) => stager.remove(i);
  const clearAttachments = () => stager.clear();


  // The draft survives a reload because a half-written message is work. Written
  // on every keystroke: one small JSON string, and the alternative (a debounce)
  // loses the last few characters exactly when the tab goes away.
  $effect(() => { hubPrefs.setDraft(selected, composerText); });

  /** The message the next send replies to (board #290): its id, sender and
   * a preview line for the chip. The quote itself is built by the server
   * from its own row (`hub_post` `re`). One per send; the room switch, ×,
   * Escape and Back clear it. */
  let replyTo = $state(null);
  function replyToMessage(m) {
    if (!m?.id) return;
    replyTo = { id: String(m.id), from: m.from ?? '', preview: quotePreview(m.body) };
    // A reply to an agent goes to that agent unless a recipient was chosen.
    if (!recipient && m.from && managedAgents.some((a) => a.name === m.from)) setRecipient(m.from);
    composer?.focus();
  }

  // Roster owns card interaction; Hub owns the resulting reading filter.
  let filterAgent = $state('');
  /** Filtering is a ContextMenu verb, independent of the delivery recipient. */
  function toggleFilter(name) {
    filterAgent = filterAgent === name ? '' : name;
  }
  /* The mode is shown and exited only on its card (#238), so it lasts only
     while the strip draws one: a live or a stopped identity. An agent removed
     from the room takes the filter with it; otherwise the feed stayed filtered
     with no visible mode and no way out (#241, validator). */
  $effect(() => {
    if (filterAgent && filterAgent !== HUMAN && !managedAgents.some((a) => a.name === filterAgent) && !stopped.includes(filterAgent)) filterAgent = '';
  });
  const filterItem = (name) => ({
    label: filterAgent === name ? t('hubFilterExit') : t('hubFilterItem'),
    icon: 'filter',
    onselect: () => toggleFilter(name),
  });

  /** Choosing a recipient is also choosing this project's lead: it is the same
   * decision ("who am I working with here"), so it persists. That includes
   * choosing the ROOM (`''`): hubPrefs stores it as a real value, and pickLead
   * keeps it — before, '' was "unset" and the next roster poll re-seated a lead
   * the user had just dismissed (review C, 2026-09-03). */
  function setRecipient(name) {
    if (recipient !== name) commandFeedbackLifetime.clear();
    recipient = name;
    if (selected) hubPrefs.setLead(selected, name);
    // An OPEN terminal partition follows the selection (board #91): choosing
    // an agent is also choosing whose pane you are watching — the same reading
    // openDrawer makes when it seats the recipient's window (board #76). The
    // lookup is by roster name, so @all and the room skip naturally; a closed
    // drawer stays closed — this retargets, it never opens.
    if (termOpen && drawerView === 'term') {
      const a = agents.find((x) => x.name === name);
      if (a) pickWindow(a);
    }
  }

  // Terminal drawer: pick a window (any window — this is where direct
  // windows and shells live) and show it.
  /* Interrupt: type Escape into the agent's own pane. An agent CLI reacts to
     what lands in its input (the same truth `deliver_mentions` rests on), and
     Escape is how every supported TUI cancels the turn it is in — a `tmm`
     message could not, because a busy agent reads chat only between turns.
     Escape must be the NAMED key: with extended-keys on, tmux drops raw C0
     bytes sent to a pane in extended mode (see CLAUDE.md). Stop/restart stay
     separate and heavier: this cancels output, it does not kill the agent. */
  let interruptJobs = $state.raw([]);
  const interrupting = $derived(interruptJobs.filter((job) => job.session === selected).map((job) => job.name));
  const busyNames = $derived(busyTargetsFor(ALL_TARGET, agents));
  const interruptible = $derived(busyTargetsFor(recipient, agents).length > 0
    && !busyTargetsFor(recipient, agents).some((name) => interrupting.includes(name)));
  const rosterExpanded = $derived(hubPrefs.rosterExpanded(selected));

  async function toggleRoster() {
    const session = selected;
    if (!session) return;
    const next = !rosterExpanded;
    await withReadingAnchor(() => {
      if (selected === session) hubPrefs.setRosterExpanded(session, next);
    });
  }

  /** Returns the members whose interrupt failed (board #258: a group verb
   * names them); single-card callers ignore it. */
  async function interrupt(target, session = selected) {
    if (!session || session !== selected) return [];
    // Snapshot before the first await. A peer Stop never selects its card,
    // changes the reading anchor, or reaches an idle/unmanaged window.
    const targets = busyTargetsFor(target, agents);
    if (targets.some((name) => interruptJobs.some((job) => job.session === session && job.name === name))) return [];
    const jobs = targets.map((name) => ({ session, name }));
    interruptJobs = [...interruptJobs, ...jobs];
    const failed = [];
    await Promise.all(jobs.map(async (job) => {
      try {
        await hubAgentInterrupt(job.session, job.name);
      } catch (e) {
        console.warn('interrupt failed', job.name, e);
        failed.push(job.name);
      } finally {
        interruptJobs = interruptJobs.filter((pending) => pending !== job);
      }
    }));
    return targets.filter((name) => failed.includes(name));
    // The existing push/poll path reads the server's reset-first status and
    // [tmm] interrupted line; acknowledging a request does not invent either.
  }

  async function withReadingAnchor(mutate) {
    if (!feedView) { mutate(); return; }
    return feedView.withReadingAnchor(mutate);
  }

  function watchAgent(agent) {
    drawerView = 'term';
    openDrawer(agent);
  }

  async function openDrawer(a = null) {
    // No explicit agent → the one you are TALKING TO (board #76: "应该优先跳转到
    // 当前所选的 agent 的 terminal window"), then the first managed, then anything
    // — pickDrawerAgent, the one definition every seat of the pane shares (#209).
    const pick = a ?? pickDrawerAgent(agents, recipient);
    if (pick) {
      const p = panes.find((p) => p.session === selected && p.window === pick.window && p.active)
        ?? panes.find((p) => p.session === selected && p.window === pick.window);
      if (p) {
        termTarget = `${p.session}:${p.window}.${p.pane}`;
      } else {
        termTarget = '';
      }
    }
    if (mobile || (compact && drawerView === 'term')) {
      // Compact layouts have no terminal drawer; use the whole Terminal tab.
      const m = /^(.+):(\d+)\.(\d+)$/.exec(termTarget);
      if (m) openTerminal(selected, termTarget);
      return;
    }
    if (termOpen) return; // switching partitions while open is a content swap, not a move
    // Placed first, then revealed (reveal.ts): the rest state lands and the
    // reader is re-anchored at the FINAL layout, all before a paint; only
    // then is the content pinned at that width and the track moved from 0.
    await withReadingAnchor(() => { termOpen = true; });
    hubPrefs.setDrawer(selected, drawerView);
    await revealDrawer(0);
  }

  /** Move the drawer track between 0 and its rest value with the Drawer's
   * content pinned at the width it has now (the measured final width on
   * open, the current width on close) — xterm sees ONE size. */
  async function revealDrawer(from) {
    if (!colsEl || !drawerTrackEl) return;
    const unpin = pinTrack(drawerTrackEl, 'start');
    await moveTrack(colsEl, '--drawer-open', from);
    unpin();
  }

  /** The one close path, so every trigger keeps the reader's place. The close
   * moves too (lead, #174: a cut beside an animated open reads as a stutter):
   * pinned at its current width, the Drawer withdraws under the shrinking
   * track and unmounts after the move — one size until the end. */
  async function closeDrawer() {
    if (!termOpen) return;
    const unpin = drawerTrackEl ? pinTrack(drawerTrackEl, 'start') : null;
    drawerClosing = true;
    await withReadingAnchor(() => { termOpen = false; });
    hubPrefs.setDrawer(selected, '');
    if (colsEl) await moveTrack(colsEl, '--drawer-open', 1);
    drawerClosing = false;
    unpin?.();
  }

  function pickWindow(a) {
    const p = panes.find((p) => p.session === selected && p.window === a.window && p.active)
      ?? panes.find((p) => p.session === selected && p.window === a.window);
    if (p) {
      termTarget = `${p.session}:${p.window}.${p.pane}`;
    }
  }

  async function bringUp() {
    if (!selectedRow) return;
    try {
      await projectUp(selectedRow.project.id);
      await reload();
      await loadAgents();
    } catch (e) { console.warn('up failed', e); }
  }

  // ── Renaming a project happens where you read its name: the chat header.
  // A project is named by its NAME and identified by its SESSION, so this
  // edits the label only — the room (`proj:<session>`) and the tmux session
  // stay put, which is why the conversation survives a rename.
  let renaming = $state(false);
  let renameDraft = $state('');
  let renameEl = $state(null);
  let titleNameEl = $state(null); // the h1's name span — the title menu's anchor (board #32)

  function startRename() {
    if (!selectedRow) return;
    renameDraft = selectedRow.project.name;
    renaming = true;
  }
  // Focus + select once the input exists, so typing replaces the old name.
  $effect(() => {
    if (renaming && renameEl) { renameEl.focus(); renameEl.select(); }
  });
  async function commitRename() {
    if (!renaming || !selectedRow) return;
    const name = renameDraft.trim();
    const id = selectedRow.project.id;
    const was = selectedRow.project.session;
    renaming = false;
    if (!name || name === selectedRow.project.name) return;
    try {
      const res = await projectRename(id, name);
      // The session may have followed the name. Everything keyed by it — the
      // remembered lead, the read marker, which project is open — follows too,
      // and the feed reloads under the new key.
      if (res?.session && res.session !== was) {
        hubPrefs.renameSession(was, res.session);
        // The Terminal may be pointing at `<old session>:<win>.<pane>`, which
        // stops resolving the moment tmux renames the session. Nothing here can
        // reach that state, so say it out loud and let App remap.
        // It names the server the rename happened on, from this Hub's scope
        // (reviewer P1): App retargets only that server's references.
        window.dispatchEvent(new CustomEvent('project-renamed', {
          detail: { serverId: scope.runtime.id, from: was, to: res.session },
        }));
        await reload();
        await selectProject(res.session);
        return;
      }
      await reload();
    } catch (e) { console.warn('rename failed', e); }
  }





  // Spawn into the CURRENT project (from the chat header).
  let sideOpen = $state(false);     // phone: the project list, as a drawer
  // ONE way to add agents, in two moods: 'start' also makes the first pick the
  // lead (an empty room), 'add' leaves the current lead alone (a running one).
  let pickerOpen = $state(false);
  let pickerMode = $state('start');
  let startPick = $state([]);
  let startBrief = $state('');
  // Where the picked agents go (board #382): '' = standalone, else a team
  // RUNNING in this project, which they join at runtime (the team's
  // definition is not changed). Defaults to the team tab the composer points
  // at, the owner's "在这个 team 里招募"; a visible choice before confirming.
  // It is the state of ONE open picker (reviewer P1 on a4f0d9d7): set when
  // the picker opens, cleared when it closes and when the project changes,
  // and handed to `addAgents` only by the picker's own confirm. No other
  // entry reads it, so a choice left over from another picker or project can
  // never put a one-tap start into a team.
  let startJoin = $state('');
  function closePicker() { pickerOpen = false; startJoin = ''; }
  /** Which opening of the picker its draft belongs to. The add button stays
   * enabled while a batch starts, so the picker can be reopened in the same
   * project mid-batch; a batch clears the draft only if no opening came after
   * the one it was confirmed from (reviewer P2 on 90b7c4e3, reachable). */
  let pickerOpening = 0;
  const runningTeams = $derived([...new Set(managedAgents.map((a) => teamRoot(a.team)).filter(Boolean))].sort());
  const joinChoices = $derived([...new Set([...runningTeams, startJoin].filter(Boolean))].sort());
  let starting = $state(false);
  /** Add agents to the conversation: one, or several at once. Each is an
   * existing `hub_spawn`, run in order so the roster appears in the order it was
   * picked. In 'start' mode the new roster also gets a lead — the first that can
   * hire, else the first picked, the same rule pickLead applies to a live room.
   * In 'add' mode whoever you were talking to stays the recipient. */
  /** The batch is FROZEN at confirmation (reviewer P1-C on 56a3ad44, the
   * #329/#377 rule): the project, the Join, the names and the brief are the
   * ones the person confirmed. A project switch while it runs stops the rest
   * (`selectionGeneration`), so nothing lands in the other project and
   * nothing there is re-targeted. A picked Join is sent as picked, even if
   * that team stopped meanwhile: the server's `check_join` judges it, and
   * every refusal is said in the composer's feedback slot, never only in the
   * console. */
  async function addAgents(picked, pickedBrief = '', mode = pickerMode, pickedJoin = '') {
    if (!selected || !picked.length || starting) return;
    const session = selected, gen = selectionGeneration, opening = pickerOpening;
    const names = [...picked], brief = pickedBrief, join = pickedJoin;
    const current = () => alive && selectionGeneration === gen && selected === session;
    starting = true;
    closePicker();
    const feedbackToken = commandFeedbackLifetime.begin();
    commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
    const failed = [];
    let first = '';
    try {
      for (const name of names) {
        if (!current()) break;
        try {
          const r = await hubSpawn(session, name, brief, '', join);
          if (!first) first = r?.window_name || name;
        } catch (e) {
          failed.push({ name, why: spawnRefusal(e) });
        }
      }
      if (!current()) return;
      if (failed.length) commandFeedbackLifetime.update(feedbackToken, {
        kind: 'error',
        message: failed.map((f) => t('hubSpawnFailed').replace('{name}', f.name).replace('{why}', f.why)).join('; '),
      });
      await Promise.all([reload(), loadAgents(), loadFeed()]);
      if (first && current() && (mode === 'start' || !recipient)) {
        setRecipient(first);
      }
    } finally {
      starting = false;
      // The picker's draft belongs to the opening it was confirmed in: a
      // batch that ends after a project switch, or after the picker was
      // opened again, leaves that newer draft alone.
      if (current() && pickerOpening === opening) { startPick = []; startBrief = ''; }
    }
  }
  /** Move a running agent into a team of this project, or out ('' = leave),
   * at runtime (board #384): the drag and the Move/Leave items both land
   * here. A member its team's DEFINITION places is not moved; the person is
   * told where that lives. Every refusal is said in the composer's feedback
   * slot. Frozen to the project it was asked in. */
  async function moveAgent(name, team, session = selected) {
    if (!session || session !== selected) return;
    const a = managedAgents.find((x) => x.name === name);
    const from = teamRoot(a?.team);
    const feedbackToken = commandFeedbackLifetime.begin();
    commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
    if (a && from && !a.joined) {
      commandFeedbackLifetime.update(feedbackToken, { kind: 'error', message: t('hubMoveDefMember').replace('{name}', name).replace('{team}', from) });
      return;
    }
    if ((team || '') === from) { commandFeedbackLifetime.clear(); return; }
    const gen = selectionGeneration;
    try {
      await hubAgentSetTeam(session, name, team);
      if (alive && selectionGeneration === gen && selected === session) await Promise.all([loadAgents(), loadFeed()]);
    } catch (e) {
      if (alive && selectionGeneration === gen && selected === session) commandFeedbackLifetime.update(feedbackToken, {
        kind: 'error',
        message: t('hubMoveFailed').replace('{name}', name).replace('{why}', e?.code === 'server_too_old' ? t('hubMoveOldServer') : spawnRefusal(e)),
      });
    }
  }
  /** Why a spawn did not go, in this page's words: the gate's two refusals
   * (#377, #382) have their own copy; anything else is the server's message
   * (`check_join` names the team it refused). */
  function spawnRefusal(e) {
    if (e?.code === 'server_too_old') return t('hubJoinOldServer');
    if (e?.code === 'login_pending') return t('boardAssignConnecting');
    return String(e?.message ?? e);
  }

  /** Member names of a configured team, for the preset rows. */
  function teamMembers(tm) {
    try { return (JSON.parse(tm.members) ?? []).map((m) => (m.team ? `+${m.team}` : m.name)).filter(Boolean); } catch { return []; }
  }

  /** Start a configured TEAM (board #74): one RPC spawns every member with its
   * role; the first member that landed becomes the recipient (the team's own
   * order is its hierarchy — the lead is listed first). */
  async function startTeam(name, brief = '', mode = pickerMode) {
    if (!selected || !name || starting) return;
    // Frozen like a batch (#382 review): a switch while the team starts
    // neither re-targets the other project's recipient nor clears its draft,
    // and the MODE is the one it was started in (reviewer P2 on b4f01642): a
    // picker opened while it starts does not decide whether it takes the lead.
    const session = selected, gen = selectionGeneration, opening = pickerOpening;
    const current = () => alive && selectionGeneration === gen && selected === session;
    starting = true;
    closePicker();
    try {
      const r = await hubSpawnTeam(session, name, brief);
      for (const e of r?.errors ?? []) console.warn('team member spawn failed', e.name, e.error);
      if (!current()) return;
      await Promise.all([reload(), loadAgents(), loadFeed()]);
      const first = r?.spawned?.[0]?.window_name;
      if (first && current() && (mode === 'start' || !recipient)) setRecipient(first);
    } catch (e) {
      console.warn('team spawn failed', name, e);
    } finally {
      starting = false;
      if (current() && pickerOpening === opening) { startPick = []; startBrief = ''; }
    }
  }

  function openPicker(mode) {
    pickerOpening++;
    pickerMode = mode;
    startPick = [];
    const tab = targetTeam(recipient);
    startJoin = tab && runningTeams.includes(tab) ? tab : '';
    pickerOpen = true;
  }

  // Stopping an agent kills a process that may be mid-task, and on a phone the
  // button is a thumb away from the chip you meant to tap — so it asks first.
  // Starting one that is already stopped destroys nothing, so it just happens.
  // One confirmation dialog for the consequential actions: stopping ONE agent
  // and closing the WHOLE project (which kills every pane in its session).
  // Both are recoverable — the declaration survives, `Open` brings it back
  // and an agent resumes its conversation — but neither should happen from a
  // mis-tap.
  // Copy for the one confirmation dialog, keyed by action. Four consequential
  // verbs share it: stop/remove an agent, close/delete a project.
  const ACT_COPY = {
    stop:   { title: 'hubStopTitle',       note: 'hubStopNote',       go: 'hubStop', icon: 'stop' },
    remove: { title: 'hubRemoveTitle',     note: 'hubRemoveNote',     go: 'hubRemove', icon: 'trash' },
    down:   { title: 'projectDownTitle',   note: 'projectDownNote',   go: 'projectDown', icon: 'stop' },
    delete: { title: 'projectDeleteTitle', note: 'projectDeleteNote', go: 'projectDelete', icon: 'trash' },
    // Group verbs (board #258): {name} is the group (everyone / the team),
    // {n} how many agents the confirm covers.
    groupStop:    { title: 'hubGroupStopTitle',    note: 'hubGroupStopNote',    go: 'hubStop',    icon: 'stop' },
    groupRestart: { title: 'hubGroupRestartTitle', note: 'hubGroupRestartNote', go: 'hubRestart', icon: 'refresh' },
  };
  let pendingAct = $state(null);   // { kind: keyof ACT_COPY, name, session }
  let acting = $state(false);
  let actionError = $state(''), purgeError = $state(''), purging = $state(false);
  let actionReadError = $state(''), actionRefreshing = $state(false);
  let actionRefreshSequence = 0;
  /** Freeze the TARGET at ask time. `name` is what the dialog shows; `session`
   * is what the action runs on. The context menu opens on ANY row, so the verb
   * must carry that row's identity — resolving `selected` at confirm time
   * closed whichever project happened to be open, not the one long-pressed
   * (owner, 2026-08-24: "关的不是我选中的 是其他的"). Agent verbs keep the
   * default: the roster only shows the selected project's agents. */
  const askAction = (kind, name, session = selected, where = null) => {
    if (acting || purging) return;
    // `where`: another server's row (③c-2 union) — its api, id and liveness
    // frozen here; the dialog names the server beside the project.
    const row = where ?? rows.find(r => r.project.session === session);
    actionError = '';
    pendingAct = { kind, name, session, projectId: row?.project.id, closed: !row?.live, api: where?.api ?? null, server: where?.server ?? null };
  };
  async function refreshActionView(afterMutation = false) {
    if (actionRefreshing && !afterMutation) return;
    const generation = selectionGeneration;
    const request = ++actionRefreshSequence;
    const current = () => alive && generation === selectionGeneration && request === actionRefreshSequence;
    actionRefreshing = true;
    try {
      await Promise.all([reload(true), loadAgents(true), loadFeed(true)]);
      if (current()) actionReadError = '';
    }
    catch (e) {
      if (current())
        actionReadError = t('operationRefreshFailed').replace('{error}', String(e?.message ?? e));
    } finally { if (current()) actionRefreshing = false; }
  }

  async function runAction() {
    if (!pendingAct || acting) return;
    const act = pendingAct, generation = selectionGeneration;
    const { kind, name, session, projectId } = act;
    let step = t(ACT_COPY[kind].go);
    acting = true; actionError = '';
    try {
      if (kind === 'down' || kind === 'delete') {
        if (!projectId) throw new Error(t('operationUnavailable'));
        // The row's own server: this Hub's api, or the SOURCE api a union
        // row froze at the ask (P1-C1) — never resolved again here.
        const down = act.api ? act.api.projectDown : projectDown;
        const archive = act.api ? act.api.projectArchive : projectArchive;
        // Delete is close then archive, not purge. Remember the completed
        // step on this captured intent so a retry never closes it again.
        if (kind === 'down' || !act.closed) {
          step = t('projectDown');
          await down(projectId);
          act.closed = true;
        }
        if (kind === 'delete') {
          step = t('projectArchive');
          await archive(projectId, true);
        }
      } else if (kind === 'remove') {
        await hubAgentRemove(session, name);
      } else if (kind === 'groupStop' || kind === 'groupRestart') {
        // Every member once; a retry after a partial failure runs only the
        // ones that failed — a success is never repeated (board #258).
        const failed = kind === 'groupRestart'
          ? await restartGroup(act.names, act.team, session, act.retry)
          : await runGroup(act.names, (member) => hubAgentStop(session, member));
        if (failed.length) {
          act.names = failed;
          act.retry = true;
          throw new Error(t('hubGroupFailedNames').replace('{names}', failed.join(', ')));
        }
      } else {
        await hubAgentStop(session, name);
      }
    } catch (e) {
      if (alive && pendingAct === act)
        actionError = t('operationStepFailed').replace('{action}', step).replace('{error}', String(e?.message ?? e));
      return;
    } finally { if (alive) acting = false; }
    if (!alive || pendingAct !== act) return;
    pendingAct = null;
    if (generation !== selectionGeneration) return;
    // Another server's project: its own Hub's list refresh will show the
    // change; this Hub's rooms are untouched.
    if (act.api) return;
    if (kind === 'delete' && session === selected) selected = '';
    await refreshActionView(true);
  }

  /** Out of the recycle bin: un-archive. Destroys nothing, so it asks nothing
   * (the same rule as restoring a message from the archive). */
  async function restoreProject(row) {
    try {
      await projectArchive(row.project.id, false);
      await reload();
    } catch (e) { console.warn('restore project failed', e); }
  }

  /** The ONLY irreversible project verb, so the only one that confirms from
   * the trash: remove the managed agents' homes and forget the declaration.
   * User files and the chat history survive even this (server contract). */
  async function purgeProject() {
    const row = trashAsk;
    if (!row || purging) return;
    const generation = selectionGeneration;
    purging = true; purgeError = '';
    try {
      await projectDelete(row.project.id);
    } catch (e) {
      if (alive && trashAsk === row) purgeError = String(e?.message ?? e);
      return;
    } finally { if (alive) purging = false; }
    if (!alive || trashAsk !== row) return;
    trashAsk = null;
    if (generation === selectionGeneration) await refreshActionView(true);
  }

  /** Restart a live agent, or bring a stopped one back. The RPC tolerates there
   * being no window, so both labels share one implementation and both resume
   * the agent's own conversation rather than opening a blank prompt. */
  async function restartAgent(name, failure = 'restart failed') {
    if (!selected || acting) return;
    acting = true;
    try {
      await hubAgentRestart(selected, name);
      await Promise.all([reload(), loadAgents(), loadFeed()]);
      setRecipient(name);
    } catch (e) {
      console.warn(failure, e);
    } finally {
      acting = false;
    }
  }
  const startAgent = (name) => restartAgent(name, 'start failed');

  /** Queue ⇄ steer for this session (board #271): the CLI's own live
   * toggle, verified by the server; the card reads the new mode from the
   * pane on the next agents load. A failure is said in the composer's
   * feedback slot, like a group verb's. */
  async function switchInputMode(name, mode, session = selected) {
    if (!session || session !== selected) return;
    const feedbackToken = commandFeedbackLifetime.begin();
    commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
    try {
      await hubAgentInputMode(session, name, mode);
      await Promise.all([loadAgents(), loadFeed()]);
    } catch (e) {
      if (selected === session) commandFeedbackLifetime.update(feedbackToken, {
        kind: 'error',
        message: t('hubModeFailed').replace('{name}', name).replace('{error}', e?.message ?? String(e)),
      });
    }
  }

  /** A group verb (board #258) — the per-agent RPC once per member, captured
   * when the menu was built. Stop always confirms and a restart confirms when
   * it would cut a running turn: both go through the one ConfirmDialog. The
   * rest run at once; a partial failure names who failed, in the composer's
   * feedback slot, and nothing that succeeded is retried. */
  async function groupVerb(action, target, label, session = selected) {
    if (!session || session !== selected || acting || !action.names.length) return;
    if (action.verb === 'interrupt') {
      // The same visible failure list as the other group verbs (validator,
      // orchestrator 04:17): a member whose interrupt failed is named.
      const feedbackToken = commandFeedbackLifetime.begin();
      commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
      const failed = await interrupt(target, session);
      if (failed.length && selected === session) commandFeedbackLifetime.update(feedbackToken, {
        kind: 'error',
        message: t('hubGroupFailed').replace('{action}', t('hubInterrupt')).replace('{names}', failed.join(', ')),
      });
      return;
    }
    if (action.confirm) {
      if (purging) return;
      actionError = '';
      pendingAct = { kind: action.verb === 'stop' ? 'groupStop' : 'groupRestart', name: label, session, names: [...action.names], team: targetTeam(target) };
      return;
    }
    const feedbackToken = commandFeedbackLifetime.begin();
    commandFeedbackAnchor = composer?.feedbackAnchor() ?? null;
    acting = true;
    try {
      // Starting a team with nobody running is a team restart (board #287):
      // one alignment with the CURRENT definition, as `tmm spawn --team`
      // would start it, never a replay of each stopped member alone.
      const wholeTeam = action.verb === 'start' && !!targetTeam(target) && !targetMembers(target, agents).length;
      const failed = action.verb === 'restart' || wholeTeam
        ? await restartGroup(action.names, targetTeam(target), session)
        : await runGroup(action.names, (member) => hubAgentRestart(session, member));
      if (failed.length && selected === session) commandFeedbackLifetime.update(feedbackToken, {
        kind: 'error',
        message: t('hubGroupFailed').replace('{action}', t(action.verb === 'start' ? 'hubStartAgain' : 'hubRestart')).replace('{names}', failed.join(', ')),
      });
      if (selected === session) await Promise.all([reload(), loadAgents(), loadFeed()]);
    } finally {
      acting = false;
    }
  }

  /** Restart a group; the names that failed. A TEAM is aligned with its
   * current definition in one server step (board #286: the members it
   * dropped stop, the ones it gained start, the rest restart from it), so an
   * edited team takes effect. All restarts each live member. A retry runs
   * only the names that failed (#258: a success is never retried). */
  async function restartGroup(names, team, session, retry = false) {
    if (!team) return runGroup(names, (member) => hubAgentRestart(session, member));
    const r = await hubTeamRestart(session, team, retry ? [...names] : undefined);
    return (r.errors ?? []).map((e) => e.name);
  }

  /** The group verbs as menu rows, in groupActions' order. `scope` is 'all'
   * or 'team' — the only difference is the words. */
  function groupItems(target, scope, label, session = selected) {
    const words = {
      interrupt: scope === 'all' ? 'hubAllInterrupt' : 'hubTeamInterrupt',
      restart: scope === 'all' ? 'hubAllRestart' : 'hubTeamRestart',
      start: 'hubGroupStart',
      stop: scope === 'all' ? 'hubAllStop' : 'hubTeamStop',
    };
    const icons = { interrupt: 'stop', restart: 'refresh', start: 'refresh', stop: 'stop' };
    return groupActions(groupScope(target, agents, stopped, stoppedTeams)).map((action) => ({
      label: t(words[action.verb]).replace('{n}', String(action.names.length)),
      icon: icons[action.verb],
      warn: action.verb === 'interrupt',
      danger: action.danger,
      disabled: action.verb === 'interrupt'
        ? busyTargetsFor(target, agents).some((name) => interrupting.includes(name))
        : acting,
      onselect: () => groupVerb(action, target, label, session),
    }));
  }

  // Live pushes + polling while visible.
  const onPush = (m) => {
    // New-message notification, PRIMARY site (board #72): a push arrives for
    // EVERY project room and whatever page is on screen — the poll above does
    // not (it stops with the page). A message in another project's room is
    // away by definition (the reader is not looking at THAT conversation);
    // the selected room asks the live document. Messages are never "first"
    // here: a push is by construction newer than any loaded page.
    if (m?.room) {
      const session = rows.find((r) => roomKey(r) === m.room)?.project.session ?? m.room.replace(/^proj:/u, '');
      notifyNews([m], newsCtx(m.room, session, false), undefined, newsEffects);
    }
    if (m?.room) unreadSoon(m.room);
    // Everything above is the LIST's (the unread badge on the published slice,
    // the notification record); everything below is the ROOM's. A hidden
    // member does no room work on a push either (D4; reviewer P2-1 on
    // 018d4fa5): no feed merge, no scroll, no roster refresh — the room's
    // state is rebuilt when it is shown (`loadFeed` on show).
    if (!visible) return;
    if (!selected || m?.room !== room(selected)) return;
    // A history window takes no live rows; the to-tail dot says news waits.
    if (windowed) { newBelow = true; return; }
    feed = mergeMessages(feed, [m]);
    lastTs = Math.max(lastTs, m.ts ?? 0);
    if (following) scrollFeed(); else newBelow = true;
    // A message is a turn edge — the sender's state just changed — so the
    // roster is refreshed ahead of the 5 s poll; but a burst of 30 pushes was
    // 30 hub_agents calls (review C, 2026-09-03). One trailing 300 ms window
    // keeps the immediacy and collapses the burst into one call.
    clearTimeout(agentsRefresh);
    agentsRefresh = setTimeout(() => { agentsRefresh = 0; loadAgents(); }, 300);
  };
  let agentsRefresh = 0;
  $effect(() => {
    addTeamMessageListener(onPush);
    return () => { removeTeamMessageListener(onPush); clearTimeout(agentsRefresh); agentsRefresh = 0; clearTimeout(unreadPushTimer); };
  });
  /** The conversation that was open, or the top row. */
  function openFirst() {
    const remembered = rows.some((r) => r.project.session === hubPrefs.project) ? hubPrefs.project : rows[0].project.session;
    selectProject(remembered);
  }
  // A member shown for the first time with its list already published (D4
  // deferred its room): open it now.
  $effect(() => { if (visible && !selected && rows.length) untrack(openFirst); });
  // D4 (board #335 ③c-2): a HIDDEN member keeps only its list refresh — the
  // project list it publishes to the union, on the same 20 s cadence — and
  // nothing of the room: feed, roster, activity poll only while visible. In
  // Single a hidden Hub polls nothing, as before (`union` is null).
  $effect(() => {
    if (!visible && !union) return;
    reload();
    const pi = setInterval(reload, 20000);
    return () => clearInterval(pi);
  });
  $effect(() => {
    if (!visible) return;
    registryList().then((r) => { registry = r.agents ?? []; }).catch(() => {});
    teamsList().then((r) => { teams = r.teams ?? []; }).catch(() => {});
    const ai = setInterval(() => { loadAgents(); loadActivity(); }, 5000);
    const fi = setInterval(loadFeed, 10000);
    return () => { clearInterval(ai); clearInterval(fi); };
  });

  // Esc closes the drawer — but ONLY when it is pressed OUTSIDE the terminal.
  // Escape is how every agent TUI cancels the turn it is running, so an Esc
  // typed INTO the focused pane belongs to the pane app; stealing it at window
  // capture closed the drawer instead of reaching the agent (owner,
  // 2026-08-26: "按键盘的 ESC 键 它就直接退出这个区域了 而不是发送 ESC 键").
  // The drawer still closes via its ✕, the back gesture, and an Esc pressed
  // while focus is anywhere else. Gated on `visible` too: pages stay mounted
  // while hidden, so a drawer left open used to eat the Terminal page's Esc.
  $effect(() => {
    if (!termOpen || !visible) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (activeModal(document)) return;
      if (e.target?.closest?.('[role="menu"]')) return;
      if (e.target?.closest?.('.xterm')) return; // focused terminal: the pane gets it
      // Same territory rule for the files partition: an Esc from inside it
      // (editor, rename field, preview) is the browser's own — closing the
      // drawer here would UNMOUNT an open editor mid-edit.
      if (e.target?.closest?.('.files-body')) return;
      // And the board partition: its Esc order (drawer → dirty-draft confirm →
      // detail) belongs to the Board itself.
      if (e.target?.closest?.('.board-body')) return;

      closeDrawer(); e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ── Right-click on the desktop, long press on a phone. One menu component, one
  // piece of state, three subjects (owner, 2026-08-20: "还有很多地方增加右键点击操
  // 作，和手机长按"). The ITEMS are built per subject, and each surface offers the
  // verbs it already has elsewhere — a context menu with its own set of actions is
  // a second source of truth waiting to disagree.
  let ctxAt = $state(null);        // { x, y } in client px, or null
  let ctxItems = $state([]);
  let ctxWho = $state('');
  // Facts under the heading for TOUCH-opened agent menus (board #223): the
  // opener passes the hover card's info, because a finger has no hover.
  let ctxInfo = $state(null);

  function openCtx(at, who, items, info = null) {
    const usable = items.filter(Boolean);
    if (!usable.length) return;
    ctxWho = who;
    ctxItems = usable;
    ctxInfo = info;
    ctxAt = at;
  }
  const closeCtx = () => { ctxAt = null; ctxItems = []; ctxInfo = null; };

  function activateAll(event) {
    const session = selected;
    if (!session) return;
    if (recipient !== ALL_TARGET) { setRecipient(ALL_TARGET); return; }
    if (ctxAt?.allSession === session) { closeCtx(); return; }
    const trigger = event.currentTarget;
    openAllMenu({ anchor: anchorOf(trigger), trigger, keepTriggerClear: true });
  }
  /** Right-click / long-press on All (board #258) opens the same menu at any
   * time; a click opens it only while All is the recipient. `allFor` is the
   * recipient it opened under: the menu closes if that changes. */
  function openAllMenu(at) {
    const session = selected;
    if (!session) return;
    const allMenuId = Symbol('all-menu');
    openCtx({ ...at, allSession: session, allMenuId, allFor: recipient }, t('hubEveryone'), allItems(session, allMenuId));
  }
  function allItems(session, menuId) {
    const current = () => selected === session && ctxAt?.allMenuId === menuId;
    return [
      recipient === ALL_TARGET
        ? { label: t('hubRecordOnly'), icon: 'chat', onselect: () => { if (current() && recipient === ALL_TARGET) setRecipient(''); } }
        : { label: t('hubTalkToAll'), icon: 'chat', onselect: () => { if (current()) setRecipient(ALL_TARGET); } },
      ...groupItems(ALL_TARGET, 'all', t('hubEveryone'), session).map((item) => ({
        ...item, onselect: () => { if (current()) return item.onselect(); },
      })),
    ];
  }
  const visibleCtxItems = $derived(ctxAt?.allSession ? allItems(ctxAt.allSession, ctxAt.allMenuId)
    : ctxAt?.teamSession ? teamItems(ctxAt.teamSession, ctxAt.team, ctxAt.teamMenuId) : ctxItems);
  $effect(() => {
    if (ctxAt?.allSession && (ctxAt.allSession !== selected || recipient !== ctxAt.allFor)) closeCtx();
    if (ctxAt?.teamSession && ctxAt.teamSession !== selected) closeCtx();
  });

  /** A team name's menu (board #258): the group verbs scoped to that team's
   * members in this room, plus its configuration. Built live like All's, so
   * counts and busy state follow the roster while it is open. */
  function openTeamMenu(at, team) {
    const session = selected;
    if (!session || !team) return;
    const teamMenuId = Symbol('team-menu');
    openCtx({ ...at, teamSession: session, team, teamMenuId }, team, teamItems(session, team, teamMenuId));
  }
  function teamItems(session, team, menuId) {
    const target = teamTarget(team);
    const current = () => selected === session && ctxAt?.teamMenuId === menuId;
    // A team with nobody running (board #287) is not a destination: no
    // talk row, only Start and its configuration.
    const talk = !targetMembers(target, agents).length ? [] : [
      recipient === target
        ? { label: t('hubRecordOnly'), icon: 'chat', onselect: () => { if (current() && recipient === target) setRecipient(''); } }
        : { label: t('hubTalkToTeam'), icon: 'chat', onselect: () => { if (current()) setRecipient(target); } },
    ];
    return [
      ...talk,
      ...groupItems(target, 'team', team, session).map((item) => ({
        ...item, onselect: () => { if (current()) return item.onselect(); },
      })),
      ...(openAgentConfig ? [{ label: t('hubTeamConfig'), icon: 'gear', onselect: () => openAgentConfig(team, 'team') }] : []),
    ];
  }

  // ── The phone's BACK GESTURE, the Files page's contract (owner, 2026-08-24:
  // "chat…对于返回手势适配不太好 像是网页刷新了。像文件管理页面就很好"): App
  // routes a history pop here, and a `true` means it was CONSUMED by peeling
  // the topmost layer in the fixed Back priority (separate from key listeners).
  // Only when nothing is left to peel does it fall through to App's re-push,
  // so a back never looks like the browser leaving. On a phone the project
  // LIST is the level above the conversation (the Files analogy: cwd = '/'
  // is the floor); with the list open, back has reached the floor.
  // The rail's second click on this page toggles the project sidebar (board
  // #199 opened it; #201 makes it a toggle: "选中点击也能展开，也能折叠"). Desktop
  // only — the phone has no rail; its sheet has its own opener in the header.
  $effect(() => {
    onReselect?.(() => { if (!compact) void setSidebar(!sideCollapsed); });
  });

  // The lightbox is the topmost transient layer: back peels it first.
  let shotView = $state('');
  const backLayers = createHubBackRegistry();
  $effect(() => {
    if (!onGoBack) return;
    const disposers = [
      backLayers.register('lightbox', () => { if (shotView) { shotView = ''; return true; } return false; }),
      backLayers.register('contextMenu', () => { if (ctxAt) { closeCtx(); return true; } return false; }),
      backLayers.register('action', () => { if (!pendingAct) return false; if (!acting) pendingAct = null; return true; }),
      backLayers.register('trash', () => { if (!trashAsk) return false; if (!purging) trashAsk = null; return true; }),
      backLayers.register('picker', () => { if (pickerOpen) { closePicker(); return true; } return false; }),
      // The dialog peels its own steps first, exactly as in Sessions and as
      // its Escape does (#317): one order per dismissal, one definition.
      backLayers.register('create', () => { if (!createOpen) return false; if (!createEl?.goBack()) createOpen = false; return true; }),
      backLayers.register('rename', () => { if (renaming) { renaming = false; return true; } return false; }),
      backLayers.register('jumpFilter', () => { if (filterBefore) { restoreFilter(); return true; } return false; }),
      backLayers.register('filter', () => { if (filterAgent) { filterAgent = ''; return true; } return false; }),
      backLayers.register('reply', () => { if (replyTo) { replyTo = null; return true; } return false; }),
      backLayers.register('files', () => { if (termOpen && drawerView === 'files' && drawerFilesBack?.()) return true; return false; }),
      backLayers.register('drawer', () => { if (termOpen) { closeDrawer(); return true; } return false; }),
      backLayers.register('sidebar', () => { if (compact && !sideOpen) { sideOpen = true; return true; } return false; }),
    ];
    onGoBack(backLayers.back);
    return () => { for (const dispose of disposers) dispose(); };
  });

  /** An agent's verbs — shared by its card and context menus. */
  /** One order for every agent menu — rising consequence, destructive last
   * (owner, 2026-08-25: "停止删除应该靠后"), interrupt in the warn tone. */
  /** "Move to team t" per other running team and, for a JOINED agent,
   * "Leave team t" (board #384): the drag's form for touch and keyboard, flat
   * items in the one menu. None for a member its team's definition places.
   * On a server without `agent_team` they are shown disabled, with why. */
  function moveItems(a, session) {
    if (!a) return [];
    const from = teamRoot(a.team);
    if (from && !a.joined) return [];
    const hint = moveBlocked ? t('hubMoveOldServer') : undefined;
    return [
      ...runningTeams.filter((team) => team !== from).map((team) => ({
        label: t('hubMoveToTeam').replace('{name}', team), icon: 'bots', disabled: moveBlocked, title: hint,
        onselect: () => moveAgent(a.name, team, session),
      })),
      ...(from ? [{ label: t('hubLeaveTeam').replace('{name}', from), icon: 'bots', disabled: moveBlocked, title: hint,
        onselect: () => moveAgent(a.name, '', session) }] : []),
    ];
  }
  function agentItems(name) {
    const session = selected;
    const config = openAgentConfig
      ? [{ label: t('hubAgentConfig'), icon: 'gear', onselect: () => openAgentConfig(name) }]
      : [];
    if (stopped.includes(name)) {
      return [
        { label: t('hubStartAgain'), icon: 'refresh', onselect: () => startAgent(name) },
        filterItem(name),
        ...config,
        { label: t('hubRemove'), icon: 'trash', danger: true, onselect: () => askAction('remove', name) },
      ];
    }
    const a = managedAgents.find((x) => x.name === name);
    const modeSwitch = inputModeSwitch(a, backendTogglesInputMode);
    return [
      // The current recipient's card offers to stop addressing it (Record
      // only leads, as for All); any other card offers to talk to it (#196).
      recipient === name
        ? { label: t('hubRecordOnly'), icon: 'chat', onselect: () => { if (recipient === name) setRecipient(''); } }
        : { label: t('hubTalkTo'), icon: 'chat', onselect: () => setRecipient(name) },
      { label: t('hubWatch'), icon: 'terminal', onselect: () => { if (a) watchAgent(a); } },
      filterItem(name),
      ...config,
      ...(busyTargetsFor(name, agents).length
        ? [{ label: t('hubInterrupt'), icon: 'stop', warn: true, disabled: interrupting.includes(name), onselect: () => interrupt(name, session) }]
        : []),
      // Queue ⇄ steer for this session, where the running CLI can switch
      // (#271): the item names the OTHER mode, no hint line (#272).
      ...(modeSwitch
        ? [{ label: t(modeSwitch.label), icon: 'zap',
            onselect: () => switchInputMode(name, modeSwitch.next, session) }]
        : []),
      ...moveItems(a, session),
      { label: t('hubRestart'), icon: 'refresh', onselect: () => restartAgent(name) },
      { label: t('hubStop'), icon: 'stop', danger: true, onselect: () => askAction('stop', name) },
      { label: t('hubRemove'), icon: 'trash', danger: true, onselect: () => askAction('remove', name) },
    ];
  }

  /** A project's verbs. Open/Close mirrors the header's single button, so the two
   * cannot disagree about which one applies. Rename selects the project first,
   * because the editor it opens is the chat header's own title. */
  function projectItems(row, withView = false) {
    const session = row?.project?.session ?? '';
    const name = row?.project?.name ?? '';
    // Constructive verbs lead, destructive close the menu (owner, 2026-08-25):
    // Open (when closed) → Rename → [view] → Close (when live) → Delete.
    return [
      ...(row?.live ? [] : [{ label: t('projectUp'), icon: 'zap', onselect: () => { selectProject(session); setTimeout(bringUp, 0); } }]),
      { label: t('projectRename'), icon: 'edit',
        onselect: () => { selectProject(session); setTimeout(startRename, 0); } },
      ...(withView ? [...feedLevelItems(), onlyMineItem()] : []),
      ...(row?.live ? [{ label: t('projectDown'), icon: 'stop', danger: true, onselect: () => askAction('down', name, session) }] : []),
      { label: t('projectDelete'), icon: 'trash', danger: true,
        onselect: () => askAction('delete', name, session) },
    ];
  }

  /** The feed's detail level as three menu rows — chat / + status / + tools —
   * the current one ticked. It lives in the project TITLE's menu (the one
   * menu about "this conversation") rather than as a header switch: the
   * header keeps no spare switches (board #72), and Settings was the only
   * other way to reach it (review, 2026-09-03: dead code in the Hub, a
   * setting three pages away). Radio semantics through the two icons the menu
   * already has — a tick on the chosen level, a hollow circle on the rest. */
  function feedLevelItems() {
    const levels = [['chat', 'hubFeedChat'], ['status', 'hubFeedStatus'], ['tools', 'hubFeedTools']];
    return levels.map(([level, key]) => ({
      label: `${t('hubFeedLevel')} · ${t(key)}`,
      icon: hubPrefs.feedLevel === level ? 'check' : 'circle',
      onselect: () => hubPrefs.setFeedLevel(level),
    }));
  }
  /** "Only mine" (board #289): the SAME reading filter as an agent card's
   * "Only its messages", with the human as the subject (filterBlocks). One
   * filter at a time, scoped to the room, Back clears it — all of that is
   * toggleFilter's already. A toggle, ticked while on. */
  function onlyMineItem() {
    return { label: t('hubOnlyMine'), icon: filterAgent === HUMAN ? 'check' : 'circle', onselect: () => toggleFilter(HUMAN) };
  }


  // The same dismissal order for Copy/Raw and the command palette. Both used to
  // stay up until something happened to replace them (owner, 2026-08-22:
  // "在其他操作之后应该自动隐藏 不应该一直常驻显示"). A tap anywhere outside
  // the layer (or Escape) closes them; the toggles themselves and clicks
  // INSIDE the layer are excluded so choosing an option is not also
  // "outside". Raw view is not a popup — an opened raw source stays until
  // retoggled or the project changes.
  // The reply chip (#290) is a layer Escape peels too, after the two above
  // (validator 12:23: with only the chip up, no listener was installed).
  $effect(() => {
    if (!feedActions?.isOpen() && !composer?.hasTransient() && !replyTo) return;
    const onDown = (e) => {
      feedActions?.outside(e);
      composer?.dismissOutside(e);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      feedActions?.escape(e);
      composer?.dismissEscape(e);
      if (replyTo && !e.defaultPrevented) replyTo = null;
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  // Messages remain a record: Copy/Raw belong under the bubble, never in
  // an action menu with delete (hub-feed.md).
  // `windowOf` is what lets a reply close the lane it belongs to, so two agents
  // working at once keep ONE growing group each instead of interleaving.
  const blocks = $derived.by(() => {
    // A jump's history window shows no activity newer than its last message
    // (activity is merged by ts and would trail it), and keeps its target
    // even where the level would drop it (board #322).
    const acts = windowed ? activity.filter((e) => (e.ts ?? 0) <= windowed.newestTs) : activity;
    const all = feedBlocks(feed, acts, hubPrefs.feedLevel, (from) => agents.find((a) => a.name === from)?.name, revealId);
    if (!filterAgent) return all;
    // Replies, addressed messages and this agent's telemetry lane:
    // the reading rule lives in filterBlocks.
    return filterBlocks(all, filterAgent, agents.find((a) => a.name === filterAgent)?.name);
  });

  /** Four states, one word each. Anything unexpected shows itself rather than
   * being silently relabelled. */
  function stateLabel(state) {
    const label = t('hubState_' + state);
    return label.startsWith('hubState_') ? state : label;
  }

  // ── Hover explains (motion.md principle 16, wave 9). ONE shared card
  // (`use:hoverInfo`, ui/HoverCard) on a pointer device only — the action
  // ignores touch, where the long-press menu is the "more" gesture. Every
  // getter runs at OPEN time, so the card reads the current state; every
  // value goes through the formatter the page already uses (stateLabel,
  // modelLabel, fmtElapsed for the epoch-seconds `since`, agoShort for ms
  // timestamps) — a second formatter would be a second clock.
  /** The state's tone in the card is the SAME family stateDotColor paints. */
  function stateTone(state) {
    switch (stateDotColor(state)) {
      case 'var(--accent)': return 'accent';
      case 'var(--status-warn)': return 'warn';
      case 'var(--status-danger)': return 'danger';
      default: return undefined;
    }
  }
  // A clock for the elapsed readouts. One timer for the whole page, and only
  // while the tab is on screen — a "running 2m14s" that ticks in a hidden tab
  // is pure wakeups.
  // The chat/terminal divider is draggable like the sidebar's, so --hub-drawer-w
  // has to be restored the same way App restores --sidebar-w: SideHandle is the
  // only other writer.
  $effect(() => {
    const saved = parseInt(localStorage.getItem('tmux_hub_drawer_w') || '', 10);
    if (saved >= 320 && saved <= 900) {
      document.documentElement.style.setProperty('--hub-drawer-w', saved + 'px');
    }
  });

  let tick = $state(Date.now());
  $effect(() => {
    if (!visible) return;
    const id = setInterval(() => { tick = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  /** The header path remains prose: drag selects it, while a double-click
   * copies the complete value (including the off-screen part) through the
   * app's clipboard helper. An action keeps the span's read-only semantics —
   * it is not a fake button — and lets the browser perform its normal text
   * selection before we expand the highlight to the whole copied path. */
  let headerCopyFeedback = $state(null), headerCopyAnchor = $state(null);
  const headerCopyLifetime = createFeedbackLifetime(value => { headerCopyFeedback = value; });
  $effect(() => { if (!visible) headerCopyLifetime.clear(); });
  onDestroy(() => headerCopyLifetime.dispose());
  let commandFeedback = $state(null), commandFeedbackAnchor = $state(null);
  const commandFeedbackLifetime = createFeedbackLifetime(value => { commandFeedback = value; });
  $effect(() => { if (!visible) commandFeedbackLifetime.clear(); });
  onDestroy(() => commandFeedbackLifetime.dispose());
  function doubleClickCopy(el, initialValue) {
    let value = initialValue;
    const onDoubleClick = () => {
      if (!value || !visible) return;
      const attempt = headerCopyLifetime.begin(); headerCopyAnchor = el;
      void copyText(value).then(ok => headerCopyLifetime.update(attempt,
        { kind: ok ? 'success' : 'error', message: ok ? t('copied') : t('copyFailed') }));
      const selection = window.getSelection();
      if (!selection || !el.isConnected) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    el.addEventListener('dblclick', onDoubleClick);
    return {
      update(nextValue) { if (value !== nextValue) headerCopyLifetime.clear(); value = nextValue; },
      destroy() { el.removeEventListener('dblclick', onDoubleClick); headerCopyLifetime.clear(); if (headerCopyAnchor === el) headerCopyAnchor = null; },
    };
  }

  /** Vertical wheel pans the header path horizontally — the path scrolls
   * instead of ellipsizing, and a mouse has no horizontal axis of its own.
   * An action (not `onwheel`) because preventDefault needs a non-passive
   * listener. */
  function wheelX(el) {
    const onWheel = (e) => {
      if (!e.deltaY || e.deltaX) return; // trackpads already pan natively
      if (el.scrollWidth <= el.clientWidth) return; // it fits — let the page have the wheel
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return { destroy: () => el.removeEventListener('wheel', onWheel) };
  }
</script>

<div class="hub-root" class:compact class:drawer-open={termOpen && !compact} class:side-collapsed={sideCollapsed && !compact}>
  <div class="cols" bind:this={colsEl}>
    <!-- The .track is the grid item the reveal pins; the Sidebar inside never
         changes size while the track moves (board #174). -->
    <div class="track side" bind:this={sideTrackEl}>
    <Sidebar {compact} open={sideOpen} {rows} {trash} {rowsBase} {selected}
      entries={unionList?.rows ?? null} missing={unionList ? union.included.filter((s) => unionList.missing.includes(s.id)) : []} unavailable={unionList?.unavailable ?? []} {selectedKey}
      {panes} {agentStates} {talkMap} {tick} {roomUnread} {scopeNote}
      onselect={(session) => { selectProject(session); sideOpen = false; }}
      onselectEntry={pickEntry}
      onmenuEntry={(entry, at) => openCtx(at, entry.item.project.name, entryItems(entry))}
      oncreate={() => { createOpen = true; sideOpen = false; }}
      onclose={() => { sideOpen = false; }}
      onmenu={(row, at) => openCtx(at, row.project.name, projectItems(row))}
      onrestore={restoreProject} onpurge={(row) => { if (!purging) { purgeError = ''; trashAsk = row; } }} />
    </div>

    <!-- ── Main: the conversation ─────────── -->
    <main class="mid">
      <!-- On the phone the whole head is ONE dense tool group (.compact-tools:
           the 32px pitch the Files head keeps on touch, #192/#193) — menu,
           caret and the three partition toggles — so the name gets the width
           three 44px boxes were spending on padding (board #228, owner
           2026-09-21: "手机上的按钮间的间距小一些，更紧凑一些，右上角的按钮…标题要能够
           放下更宽的标题"). -->
      <div class="page-head chat-head" class:compact-tools={compact}>
        <!-- The phone reaches the project list here, as a drawer. No chip strip:
             separate conversations are chosen deliberately, not flicked past. -->
        {#if compact}
          <CommandButton variant="icon" icon="menu" label={t('hubProjects')}
            expanded={sideOpen} controls="hub-sidebar" onclick={() => sideOpen = true} />
        {/if}
        <!-- Name and menu stay one tight group (board #32). The name is
             selectable prose; its sibling command owns the full hit target. -->
        <div class="title-group">
          <!-- The name, its chevron and its server tag (③c-1, #356, #359;
               owner 2026-10-13 22:57, two screenshots): the NAME LINE is one
               non-wrapping unit — the name (or the rename input) with the
               chevron glued to its right edge (owner 2026-08-30: 紧挨着 name)
               — and the tag is the ONLY item that moves. Inline while both fit
               (name ▾ tag); when they do not, line 1 = name ▾ hugging the
               text, line 2 = tag. Fit, not mode: ONE class on the stack,
               toggled by `ui/title-fit.ts` (#369 — CSS alone left a hole);
               the phone stacks unconditionally (#356) with the same name line. The name line
               does not grow, so nothing floats mid-block beside a hole. -->
          <div class="title-stack" class:stacked={compact} use:titleFit={{ active: !compact, key: `${selectedRow?.project.name ?? ''}|${scope?.tag ?? ''}|${renaming}` }}>
            <div class="name-line">
              {#if renaming}
                <input class="h1-edit" bind:this={renameEl} bind:value={renameDraft}
                  aria-label={t('projectRename')} maxlength="80"
                  onkeydown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    else if (e.key === 'Escape') { e.preventDefault(); renaming = false; }
                  }}
                  onblur={commitRename} />
              {:else}
                <h1>
                  <!-- Rename remains an explicit project-menu action. -->
                  <span class="h1-text" bind:this={titleNameEl}>{selectedRow?.project.name ?? ''}</span>
                </h1>
              {/if}
              {#if selected}
                <!-- The project's own verbs — Open/Rename/Close/Delete — as ONE
                     second-level menu (owner, 2026-08-29), glued to the name it
                     acts on. The affordance is a DOWNWARD CHEVRON, tight against
                     the name — it reads as "expand this name for its options",
                     the dropdown grammar everyone already knows (owner,
                     2026-08-30: "换成一个向下的直角箭头…有点像把这个名字展开给
                     出的下拉标签选项，这样对于人类更好理解").
                     Opens the SAME projectItems menu the sidebar row's
                     long-press/right-click speaks. -->
                <CommandButton variant="icon" icon="chevron-down" label={t('hubProjectMenu')} hasPopup="menu"
                  onclick={(e) => {
                    // The menu is the NAME expanding downward (board #32): its
                    // LEFT edge sits on the name's own left edge, measured from
                    // the name element's REAL rect (anchorOf carries the zoom
                    // correction), so a wide menu near the right edge stops
                    // clipping — the placement clamp still owns the viewport
                    // edges. While renaming, the span is an input and the caret
                    // itself anchors. Every other context menu keeps the
                    // right-aligned pointer default.
                    openCtx({ anchor: anchorOf(titleNameEl ?? e.currentTarget), align: 'left' },
                      selectedRow?.project.name ?? '', projectItems(selectedRow, true));
                  }} />
              {/if}
            </div>
            {#if !renaming}<ServerTag name={scope?.tag} />{/if}
          </div>
        </div>
        <!-- The FULL path, not a middle-elided stub: it renders whole when it
             fits, and when it doesn't the box scrolls (wheel included) instead
             of ellipsizing — "不要直接用省略号" (owner, 2026-08-20). Desktop
             only, same as before. -->
        {#if !compact}<span class="path" use:wheelX use:doubleClickCopy={selectedRow?.project.path ?? ''} title={selectedRow?.project.path ?? ''}>{selectedRow?.project.path ?? ''}</span>{/if}
        <span class="spacer"></span>
        <!-- Shared commands own paint, accessible names and hover. Desktop
             discloses a partition; compact layouts navigate to its page. -->
        <!-- The message-notification switch that stood here moved to Settings
             (board #72): a header keeps no spare switches, and on a phone it
             cost this row a button. -->
        <!-- The task board: on the phone this jumps to the board PAGE (owner,
             2026-08-29: "board单独作为一个独立的功能的页面"); on desktop it is
             the drawer's THIRD partition ("或者右侧边栏有这个任务侧边栏", same
             day) — exactly the files toggle's split. -->
        <!-- The partition toggles sit at the tool gap, not the row gap: three
             icons read as one group (board #228). -->
        <div class="head-tools">
        <!-- The phone's door to the notification centre (board #322): the
             desktop's is the rail bell; the Hub tab carries the badge. -->
        {#if mobile || compact}
          <span class="bell-wrap"><CommandButton variant="icon" icon="bell" label={t('notifyCentre')} hasPopup="dialog" expanded={!!centre.anchor}
            onclick={(e) => centre.toggle(e.currentTarget)} />{#if centre.unviewed}<span class="unread-dot bell-dot" aria-hidden="true"></span>{/if}</span>
        {/if}
        <CommandButton variant="icon" icon="layout" label={t('board')}
          expanded={mobile || compact ? undefined : termOpen && drawerView === 'board'}
          controls={mobile || compact || !drawerShown ? undefined : drawerId}
          onclick={() => {
            if (mobile || compact) { openBoardTab?.(selected); return; }
            if (termOpen && drawerView === 'board') { closeDrawer(); } else { drawerView = 'board'; openDrawer(); }
          }} />
        <!-- The drawer's second partition. On the phone (no drawer) the same
             button JUMPS to the Files tab — exactly what the terminal toggle
             does with the Terminal tab (owner, 2026-08-28: "手机上好像没有
             打开文件侧边栏的按钮"). -->
        <CommandButton variant="icon" icon="files" label={t('files')}
          expanded={mobile || compact ? undefined : termOpen && drawerView === 'files'}
          controls={mobile || compact || !drawerShown ? undefined : drawerId}
          onclick={() => {
            if (mobile || compact) { openFilesTab?.(selected, drawerFilesDir || projectPath); return; }
            if (termOpen && drawerView === 'files') { closeDrawer(); } else { drawerView = 'files'; openDrawer(); }
          }} />
        <!-- THE terminal affordance: a button, not a permanent pane. Adding an
             agent belongs to the roster row, and chat detail belongs to the
             title's menu (and Settings) — a header is not a place to keep
             spare switches. -->
        <CommandButton variant="icon" icon="terminal" label={t('hubTerminal')}
          expanded={mobile || compact ? undefined : termOpen && drawerView === 'term'}
          controls={mobile || compact || !drawerShown ? undefined : drawerId}
          onclick={() => termOpen && drawerView === 'term' && !compact ? closeDrawer() : (drawerView = 'term', openDrawer())} />
        </div>
        {#if headerCopyFeedback && headerCopyAnchor}
          <div class="header-copy-feedback pop-layer" use:feedbackPosition={{ trigger: headerCopyAnchor, bounds: headerCopyAnchor.closest('main'), keepClear: headerCopyAnchor.closest('.chat-head') }}>
            <OperationFeedback value={headerCopyFeedback} ondismiss={headerCopyFeedback.kind === 'error' ? headerCopyLifetime.clear : undefined} />
          </div>
        {/if}
      </div>

      {#if actionReadError}
        <div class="config-error action-read-error" role="alert">
          <span>{actionReadError}</span>
          <CommandButton icon="refresh" label={t('refresh')} pending={actionRefreshing} onclick={() => refreshActionView()} />
        </div>
      {/if}
      {#snippet emptyFeed()}
          {#if selected && !managedAgents.length && registry.length}
            <!-- Nothing to talk to yet: start from a preset. One tap = that
                 agent becomes the lead; "several" starts a team in one go.
                 Offered for a CLOSED project too, for the same reason the +
                 button is: `projects::spawn` ensures the session, so "the
                 session is down" was never a reason to withhold the only way
                 to start one. -->
            <div class="start">
              <div class="start-h">{t('hubStartTitle')}</div>
              <div class="start-list">
                {#each registry as r (r.name)}
                  <button class="start-row" disabled={starting} onclick={() => addAgents([r.name], '', 'start')}>
                    {#if backendIcon(r.backend)}<img class="ava" src={backendIcon(r.backend)} alt={r.backend} />{:else}<span class="ava" style:background={backendColor(r.backend)}>{r.name.slice(0, 1).toUpperCase()}</span>{/if}
                    <span class="sr-name">{r.name}</span>
                    <span class="sr-backend">{r.backend}</span>
                  </button>
                {/each}
                <!-- Configured TEAMS (board #74): one tap starts every member
                     with its role. -->
                {#each teams as tm (tm.name)}
                  <button class="start-row team" disabled={starting} onclick={() => startTeam(tm.name, '', 'start')}>
                    <span class="ava tava"><Icon name="bots" size={12} /></span>
                    <span class="sr-name">{tm.name}</span>
                    <span class="sr-backend">{teamMembers(tm).join(' · ')}</span>
                  </button>
                {/each}
              </div>
              <CommandButton icon="bots" label={t('hubStartTeam')} disabled={starting}
                onclick={() => openPicker('start')} />
            </div>
          {:else}
            <div class="empty">{managedAgents.length ? t('hubEmpty') : t('hubEmptyNoAgents')}</div>
          {/if}
      {/snippet}
      <Feed bind:this={feedView} {blocks} {agents} {managedNames} issueIds={roomIssueIds} {selected} {visible} {compact}
        {roomReady} {justLoaded} {openedAt} {loadingOlder} {histMore} {actMore}
        stepsRows={hubPrefs.stepsRows} {stateLabel} {emptyFeed} bind:following bind:newBelow
        onseen={markSeen} onolder={loadOlder} onpath={routePathRef}
        windowed={!!windowed} onlatest={returnToLatest}
        onimage={(url) => { shotView = url; }}
        onreply={replyToMessage}
        onboard={(id) => {
          if (mobile || compact) { openBoardTab?.(selected, id); return; }
          drawerIssueReq = { session: selected, id, n: (drawerIssueReq?.n ?? 0) + 1 };
          drawerView = 'board'; openDrawer();
        }}
        registerActions={registerFeedActions} />

      <Roster {selected} {compact} {managedAgents} {stopped} {stoppedTeams} {selectedRow}
        {recipient} filterAgent={filterAgent === HUMAN ? '' : filterAgent} {composerText} {managedNames} {busyNames} {interrupting}
        {unread} {acting} {tick} {roomReady} {justLoaded} {rosterBase}
        expanded={rosterExpanded} onexpand={toggleRoster}
        allMenuOpen={!!ctxAt?.allSession && ctxAt.allSession === selected} onall={activateAll}
        onallcontext={openAllMenu} onteamcontext={openTeamMenu}
        {stateLabel} {stateTone} onselect={setRecipient} oninterrupt={interrupt}
        onfilter={(name) => { closeCtx(); toggleFilter(name); }}
        onadd={() => openPicker('add')}
        {moveScope} onmove={(name, team, scope) => moveAgent(name, team, scope.session)}
        oncontext={(at, name, info) => openCtx(at, name, agentItems(name), info)} />

      {#if filterNote}
        <!-- A jump cleared the reading filter to reach its message (#322):
             said, and one tap (or Back) puts it back. -->
        <div class="jump-note appear"><span>{filterNote}</span>
          <CommandButton variant="secondary" label={t('hubJumpFilterRestore')} onclick={restoreFilter} /></div>
      {/if}
      <Composer bind:this={composer} bind:composerText {selected} {compact} {recipient}
        {roomReady}
        {agents} {pending} {attaching} {failed} {sendable} {interruptible} {replyTo}
        issues={roomIssues} onissues={(s) => loadIssues(s)}
        onclearreply={() => { replyTo = null; composer?.focus(); }}
        onsend={send} onstage={stageFiles} onremove={removeAttachment}
        onmodels={modelsList} oninterrupt={interrupt} onpreview={(path) => { shotView = path; }}
        onheightchange={() => { if (following) scrollFeed(true); }}
        registerBack={onGoBack ? backLayers.register : null} />
      {#if commandFeedback && commandFeedbackAnchor}
        <div class="composer-feedback pop-layer" use:feedbackPosition={{
          trigger: commandFeedbackAnchor, bounds: commandFeedbackAnchor.closest('main'),
          keepClear: commandFeedbackAnchor.closest('.composer'),
        }}>
          <OperationFeedback value={commandFeedback} ondismiss={commandFeedbackLifetime.clear} />
        </div>
      {/if}
    </main>

    {#if drawerShown && !compact}
    <!-- ── Terminal drawer: where terminal things live. The .track is the
         grid item the reveal pins; the Drawer inside never changes size
         while the track moves (board #174). ── -->
    <div class="track drawer-track" id={drawerId} bind:this={drawerTrackEl}>
    <Drawer {compact} {visible} {fontSize} {selected} {projectPath} {termTarget}
      {drawerView} {drawerFilesReq} {drawerIssueReq} {drawerBoardNew}
      {agents} {panes} {winsExpanded} {stateLabel} {stateTone}
      bind:drawerFilesDir onpick={pickWindow} onclose={closeDrawer}
      onexpand={() => (winsExpanded = !winsExpanded)}
      onterminal={() => { const m = /^(.+):(\d+)\.(\d+)$/.exec(termTarget); if (m) openTerminal(selected, termTarget); }}
      onfiles={() => openFilesTab?.(selected, drawerFilesDir || projectPath)}
      onboard={() => openBoardTab?.(selected)}
      onnewissue={() => (drawerBoardNew = { n: (drawerBoardNew?.n ?? 0) + 1 })}
      onfilesback={(back) => { drawerFilesBack = back; }} />
    </div>
    {/if}
  </div>

  <!-- Confirm: stop one agent, close or delete the whole project. The dialog is
       the shared one (src/lib/ui/ConfirmDialog.svelte) — this page had the only
       good version of it, so it was lifted out rather than copied. -->
  <ConfirmDialog open={!!pendingAct} busy={acting} compact={compact}
    error={actionError} confirmIcon={pendingAct ? ACT_COPY[pendingAct.kind].icon : 'check'}
    title={pendingAct ? t(ACT_COPY[pendingAct.kind].title).replace('{name}', pendingAct.server ? `${pendingAct.name} · ${pendingAct.server}` : pendingAct.name).replace('{n}', String(pendingAct.names?.length ?? '')) : ''}
    note={pendingAct ? t(ACT_COPY[pendingAct.kind].note) : ''}
    confirmLabel={pendingAct ? t(ACT_COPY[pendingAct.kind].go) : ''}
    onconfirm={runAction} oncancel={() => (pendingAct = null)} />

  <!-- One context menu for every subject above: right-click on the desktop, long
       press on a phone. -->
  <ContextMenu at={ctxAt} items={visibleCtxItems} who={ctxWho} info={ctxInfo} oncancel={closeCtx} />

  <!-- Forgetting a PROJECT for good — only reachable from the recycle bin,
       the two-step rule: hide first, destroy there. -->
  <ConfirmDialog open={!!trashAsk} compact={compact} busy={purging} error={purgeError} confirmIcon="trash"
    title={trashAsk ? t('projectPurgeTitle').replace('{name}', trashAsk.project.name) : ''}
    note={t('projectPurgeNote')}
    confirmLabel={t('hubPurgeGo')}
    onconfirm={purgeProject} oncancel={() => (trashAsk = null)} />

  {#if pickerOpen}
    <!-- ── Start a team: several agents at once ── -->
    <Dialog {compact} label={t('hubStartTeam')} oncancel={closePicker}>
      <h2>{t('hubStartTeam')}</h2>
      {#if teams.length}
        <!-- Configured teams first (board #74): a tap starts the whole team
             with the brief below; the ad-hoc pick stays underneath. -->
        <div class="dlg-agents" class:touch={compact}>
          {#each teams as tm (tm.name)}
            <button class="agent-pick team" disabled={starting} onclick={() => startTeam(tm.name, startBrief.trim())}>
              <span class="ava tava"><Icon name="bots" size={12} /></span>
              <span class="ap-name">{tm.name} · {teamMembers(tm).join(', ')}</span>
              <span class="ap-go">{t('hubStartTeamNamed')}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="dlg-agents" class:touch={compact}>
        {#each registry as r (r.name)}
          <button class="agent-pick" class:sel={startPick.includes(r.name)} aria-pressed={startPick.includes(r.name)}
            onclick={() => { startPick = startPick.includes(r.name) ? startPick.filter((n) => n !== r.name) : [...startPick, r.name]; }}>
            {#if backendIcon(r.backend)}<img class="ava" src={backendIcon(r.backend)} alt={r.backend} />{:else}<span class="ava" style:background={backendColor(r.backend)}>{r.name.slice(0, 1).toUpperCase()}</span>{/if}
            <span class="ap-name">{r.name} · {r.backend}</span>
            {#if startPick.includes(r.name)}<Icon name="check" size={13} />{/if}
          </button>
        {/each}
      </div>
      {#if joinChoices.length}
        <!-- Join (board #382): the picked agents start standalone or inside a
             team already running here. Only shown when there is one. A team
             the person picked stays offered even if it stops meanwhile
             (reviewer P1-C): it is never quietly turned into Standalone. -->
        <label class="config-field"><span class="config-field-label">{t('hubJoin')}</span>
          <Select value={startJoin} ariaLabel={t('hubJoin')} disabled={starting}
            options={[{ value: '', label: t('hubJoinNone') }, ...joinChoices.map((team) => ({ value: team, label: t('hubJoinTeam').replace('{name}', team) }))]}
            onchange={(v) => { startJoin = v; }} />
        </label>
      {/if}
      <input class="pick-brief" placeholder={t('hubBrief')} bind:value={startBrief} />
      <div class="dlg-actions">
        <CommandButton label={t('cancel')} onclick={closePicker} />
        <CommandButton variant="primary" icon="zap" label={t('hubStartGo').replace('{n}', String(startPick.length))}
          disabled={!startPick.length} pending={starting} onclick={() => addAgents(startPick, startBrief.trim(), pickerMode, startJoin)} />
      </div>
    </Dialog>
  {/if}

  {#if createOpen}
    <!-- ONE New Project surface app-wide (CreateProjectDialog): the Terminal
         sidebar opens the same component, so they cannot drift apart. -->
    <CreateProjectDialog bind:this={createEl} {compact}
      oncreated={async (proj) => {
        createOpen = false;
        await reload();
        await selectProject(proj.session);
      }}
      oncancel={() => createOpen = false} />
  {/if}
  {#if shotView}
    <Lightbox src={shotView} onclose={() => shotView = ''} />
  {/if}
</div>

<style>
  .bell-wrap { position: relative; display: inline-flex; }
  .bell-dot { position: absolute; top: 4px; right: 4px; pointer-events: none; }
  .jump-note { display: flex; align-items: center; gap: 8px; padding: 4px 12px; font-size: var(--fs-meta); color: var(--text2); }
  .header-copy-feedback { position: fixed; z-index: 8; }
  .composer-feedback { position: fixed; z-index: 16; }
  .action-read-error { display: flex; align-items: center; gap: var(--tool-gap); padding: calc(2 * var(--ui-gap)) calc(3 * var(--ui-gap)); }
  .action-read-error span { min-width: 0; overflow-wrap: anywhere; }
  .hub-root {
    height: 100%; display: flex; flex-direction: column; min-height: 0;
    background: var(--bg); position: relative;
    --chat-canvas: color-mix(in srgb, var(--bg) 62%, var(--bg2));
    /* ONE bubble width budget for message, prompt row and tool lane — three
       rules sharing a literal is how they drift. The %-term is what rules on
       a wide screen: the old min(76%, 760px) let the 760px absolute cap win
       there, leaving bubbles at ~half of a wide chat column (owner,
       2026-08-28: "屏幕很宽的情况下，只占到了可能一半的宽度"). 84% keeps a
       readable gutter that says "a message, not a document"; 1360px still
       stops a full-screen ultrawide from producing 200-char prose lines. */
    --msg-max: min(84%, 1360px);
    /* --bubble-in moved to :root in app.css with the Board note's shared
       action atoms (board #46) — one definition, every wearer. */
    --bubble-out: color-mix(in srgb, var(--bg) 84%, var(--accent) 16%);
    --bubble-line: color-mix(in srgb, var(--border) 72%, var(--text3) 28%);
    /* ONE inline inset for the tab strip (Roster) and the composer shell
       under it (board #236): the lit tab must land exactly on the shell's
       edge, and two literals is how they would drift apart. */
    --composer-inset: 12px;
  
    /* Design tokens (--fs-*, --meta-ink, --t-*) come from :root in app.css —
       promoted app-wide 2026-08-18. Contract: tmm-cli.md "Design tokens". */
  }
  /* REVEAL, DO NOT RESIZE (board #174; the helpers and the reasoning are in
     reveal.ts). Each side track is its requested width times an OPEN FACTOR
     — a registered numeric custom property, so it interpolates — and the
     three tracks are always declared (a closed side is a 0 track). The
     factor is the only thing that ever transitions, and only under the
     `.moving` gate the helper raises for the duration of one move; the
     content inside a `.track` is pinned at its final width (inline, by
     pinTrack) and anchored to the edge that stays put, so the track merely
     uncovers it and an xterm inside is fitted once. What the track has not
     uncovered yet is clipped by the grid. Engines without @property
     interpolation fall back to the cut this always was. */
  /* --side-open is registered once in app.css (shell-wide since #200). */
  @property --drawer-open { syntax: '<number>'; inherits: false; initial-value: 0; }
  .cols { flex: 1; display: grid; min-height: 0; --side-open: 1; --drawer-open: 0; }
  .hub-root:not(.compact) .cols { grid-template-columns: minmax(0, calc(var(--sidebar-w) * var(--side-open))) minmax(280px, 1fr) minmax(0, calc(var(--hub-drawer-w, 520px) * var(--drawer-open))); overflow: hidden; }
  .hub-root.compact .cols { grid-template-columns: minmax(0, 1fr); }
  .hub-root.compact { --composer-inset: 9px; }
  /* :global — these classes are raised by reveal.ts, not by the markup. */
  .cols:global(.moving) { transition: --side-open var(--t-move) ease-out, --drawer-open var(--t-move) ease-out; }
  /* A track is a single-cell grid so its partition stretches to it at rest;
     pinned, it keeps the inline width and hugs the edge that does not move. */
  .track { display: grid; min-width: 0; min-height: 0; }
  .track > :global(*) { min-width: 0; } /* a partition follows its track at rest (yield, #158) instead of overflowing it */
  .track:global(.pin-start) { justify-self: start; }
  .track:global(.pin-end) { justify-self: end; }
  .hub-root.compact .track { display: contents; }
  /* Phone shape: tighter gutters, thumb-sized controls, no horizontal
     overflow. The page head wraps instead of pushing the chips off-screen. */
  /* ONE row, always: the app-wide phone rule lets a busy page-head wrap under
     the title (skill editor), but this header has few, icon-sized actions and
     wrapping put the Terminal toggle on a second line (owner, 2026-08-21:
     "打开terminal的按钮给换行到第二行了"). The title is the flexible child —
     .h1-text ellipsizes — and the buttons refuse to shrink. */
  .hub-root.compact .page-head { flex-wrap: nowrap; }
  .hub-root.compact .page-head h1 { font-size: var(--fs-title); }
  .hub-root.compact .h1-edit { font-size: var(--fs-title); }

  /* SideHandle widths are requested maxima: both side tracks yield when the
     container cannot fit them, without rewriting the saved preferences.
     Chat keeps its reading floor and takes any remaining space. */
  .hub-root.drawer-open .cols { --drawer-open: 1; }
  /* Collapsed = the track is 0 and the content is UNREACHABLE (not merely
     narrowed): hidden from sight, tab order and assistive tech at rest, and
     visible only while the move uncovers or withdraws it. */
  .hub-root.side-collapsed .cols { --side-open: 0; }
  .hub-root.side-collapsed .cols:not(:global(.moving)) > .track.side { visibility: hidden; }
  /* The NAME displays WHOLE, with priority over the PATH (owner, 2026-08-30:
     "名字还是优先要显示全的，尽量不要省略") — but NEVER over the buttons
     (owner, 2026-09-02, board #72: "按钮应该优先出现，避免项目名把按钮挤不见").
     `flex: none` made the group refuse to shrink outright, and in this nowrap
     header a long name on a phone overflowed the row and pushed the icon
     buttons off-screen. So the group CAN shrink (min-width: 0 lets the
     .h1-text ellipsis engage), but at flex-shrink 1 against the path's 1000:
     negative space is distributed by shrink × basis, so the path absorbs
     effectively all of it and the name only starts to ellipsize once the
     path is down to its floor. No width cap: the old 60% cap ellipsized the
     name while the path still held width — the exact inversion of the
     priority (owner, 2026-09-21, board #234: "优先保证标题完整显示，可以压
     缩路径宽度，反正路径可以滚动"). The path's own min-width floor is what
     keeps it reachable. The buttons are `flex: none` and always keep their
     box. */
  .title-group { display: flex; align-items: center; gap: 1px; flex: 0 1 auto; min-width: 0; }
  /* Name + tag (#356, #359, #357): the Name + tag stack — `.title-stack` /
     `.name-line` — is ONE shared atom in app.css, worn by this head and the
     Board's. */
  .head-tools { display: flex; align-items: center; gap: var(--tool-gap); flex: none; }
  /* The title yields width before any native command target does. */
  h1 { display: flex; align-items: center; min-width: 0; }
  .h1-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .h1-edit {
    font-family: var(--font-mono);
    font-size: var(--fs-title); font-weight: 600; color: var(--text);
    min-width: 0; flex: 0 1 auto; width: 22ch; max-width: 100%;
    background: var(--bg2); border: 1px solid var(--accent-line); border-radius: var(--ui-radius-control);
    padding: 2px 6px; box-sizing: border-box;
  }
  .h1-edit:focus { outline: none; }
  .mid { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  /* Fits → shows whole; doesn't fit → pans (wheelX action), NEVER an ellipsis.
     `flex: 0 1 auto` + min-width lets the header's buttons take their space
     first while the path yields, and the hidden scrollbar keeps the header one
     quiet line. */
  .path {
    font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text3);
    white-space: nowrap; overflow-x: auto; overflow-y: hidden;
    /* THE dynamic region: shrinks below its content first (min-width + scroll)
       while the buttons stay whole; the shrink weight of 1000 against the
       title group's 1 is what makes it yield FIRST and the name only after it
       (see .title-group); the spacer still owns the leftover, keeping the
       toggles right-aligned. The 8ch floor (board #234) keeps a compressed
       path visible and scrollable — a path squeezed to zero is not
       "可以滚动", it is gone. */
    min-width: 8ch; flex: 0 1000 auto;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
    user-select: text; -webkit-user-select: text; cursor: text;
  }
  .path::-webkit-scrollbar { display: none; }
  .tava { display: inline-grid; place-items: center; background: var(--accent-bg); color: var(--accent); }
  /* A picker row is three columns (board #341): the avatar, the name (the one
     column that wraps) and the action, which never does, so every action's
     right edge is the row's and every name starts where the avatar ends. */
  .ap-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .ap-go { flex: none; white-space: nowrap; font-size: var(--fs-micro); color: var(--accent); }



  /* Empty room: start from a preset — one agent, or a team. */
  .start { margin: auto; display: flex; flex-direction: column; gap: 8px; width: min(420px, 100%); }
  .start-h { font-size: var(--fs-ui); color: var(--text2); text-align: center; margin-bottom: 2px; }
  .start-list { display: flex; flex-direction: column; gap: 5px; }
  .start-row {
    display: flex; align-items: center; gap: 8px; min-height: 44px; width: 100%; text-align: left;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--ui-radius-row);
    color: var(--text); padding: 8px 11px; font-size: var(--fs-ui); cursor: pointer;
  }
  .start-row:hover { border-color: var(--accent); background: var(--accent-bg); }
  .start-row:disabled { opacity: 0.5; }
  .sr-name { font-family: var(--font-mono); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-backend { font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text3); margin-left: auto; }

  /* The dialog's shape, scrim, sheet and keyboard are ui/Dialog's (#317);
     what is left here is the picker's own content. */
  .pick-brief { background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--ui-radius-control); color: var(--text); padding: 8px 12px; font-size: var(--fs-ui); outline: none; }
  .pick-brief:focus { border-color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .cols:global(.moving) { transition: none; } }
  .dlg-agents { display: flex; flex-direction: column; gap: 5px; }
  /* Phone sheet: the roster scrolls inside the sheet instead of pushing the
     actions off the bottom edge, and each row takes a 44px touch target. */
  .dlg-agents.touch { max-height: calc(46vh / var(--ui-zoom, 1)); overflow-y: auto; }
  .dlg-agents.touch .agent-pick { min-height: 44px; }
  .agent-pick { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--ui-radius-control); color: var(--text2); padding: 8px 11px; font-size: var(--fs-ui); cursor: pointer; text-align: left; }
  .agent-pick.sel { border-color: var(--accent); color: var(--text); background: var(--accent-bg); }
  .agent-pick > :global(svg) { flex: none; color: var(--accent); }
  .dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
