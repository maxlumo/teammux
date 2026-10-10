<script>
  import { onDestroy, tick, untrack } from 'svelte';
  import { activeModal } from './lib/ui/modal.ts';
  import Settings from './lib/app/Settings.svelte';
  import Sessions from './lib/sessions/Sessions.svelte';
  import Terminal from './lib/terminal/Terminal.svelte';
  import SplitView from './lib/sessions/SplitView.svelte';
  import Files from './lib/files/Files.svelte';
  import Hub from './lib/hub/Hub.svelte';
  import AgentsPage from './lib/hub/AgentsPage.svelte';
  import Board from './lib/hub/Board.svelte';
  import Icon from './lib/ui/Icon.svelte';
  import SideHandle from './lib/ui/SideHandle.svelte';
  import InstallPrompt from './lib/ui/InstallPrompt.svelte';
  import Preferences from './lib/app/Preferences.svelte';
  import { copyText } from './lib/core/clipboard.ts';
  import { createFeedbackLifetime } from './lib/ui/feedback-lifetime.ts';
  import { systemStatus } from './lib/core/ws.ts';
  import SystemStatus from './lib/system/SystemStatus.svelte';
  import ServerList from './lib/app/ServerList.svelte';
  import ScratchPanel from './lib/app/ScratchPanel.svelte';
  import NotifyCentre from './lib/hub/NotifyCentre.svelte';
  import { createAlertLog, createCentre, centreSurface } from './lib/hub/notify-centre.svelte.ts';
  import AddServerDialog from './lib/app/AddServerDialog.svelte';
  import { appPrefs } from './lib/hub/hub-prefs.svelte.ts';
  import { moveTrack, pinTrack } from './lib/hub/reveal.ts';
  import { connect, isConnected, disconnect, setOnDisconnect, subscribe as wsSubscribe, resubscribeActive as wsResubscribeActive, getMachineId, getHostname, findBestAddress, classifyAddress, ADDRESS_LABELS, isAddressViable, noteAddressUnreachable, listPanes, listSessions, setSocket } from './lib/core/ws.ts';
  import { setServedBackends } from './lib/core/agents.ts';
  import { t } from './lib/core/i18n.svelte.ts';
  import { layout } from './lib/app/layout.svelte.ts';
  import { applyFontVars } from './lib/app/fonts.svelte.ts';
  import { normalizeUiZoom, stepUiZoom, UI_ZOOM_DEFAULT } from './lib/app/ui-zoom.ts';
  import { agentsLivesInSettings, defaultPage, restoreNav, retarget } from './lib/app/nav-state.ts';
  import { RAIL_DRAG_THRESHOLD, RAIL_GAP, RAIL_ORDER_KEY, parseRailOrder, railDropAt, railDropIndex, railDropOffset, railOrderToStore, visibleRailSlots } from './lib/app/nav-order.ts';
  import { createReconnectMachine } from './lib/app/reconnect.ts';
  import { targetOf } from './lib/app/server-target.ts';
  import ServerScope from './lib/app/ServerScope.svelte';
  import { createSingleRuntime } from './lib/app/single-runtime.ts';
  import { createScopeSwap } from './lib/app/server-scope.ts';
  import { createServerState, releaseServerState, stateForRuntime } from './lib/app/server-state.ts';
  import { createServerStore } from './lib/app/server-store.ts';
  import { claimPending, migrateServerState } from './lib/app/server-state-migration.ts';
  import { createHandovers } from './lib/app/handover.ts';
  import { createHandleEnds } from './lib/app/handle-end.ts';
  import { navFor, readNav, reownSavedNav, saveNav } from './lib/app/nav-saved.ts';
  import { paneRef, reownRef, retargetRef, sessionRef } from './lib/app/refs.ts';
  import { activateConnected, adoptHostname, currentServerId, currentServerName, hostLabel, loadServers, mergedInto, migrateServers, recordServer, removeServer, renameServer, saveMachineAddresses, saveServers } from './lib/app/servers.ts';
  import { confirmLeave } from './lib/app/leave-guards.ts';
  import { terminalFocusTarget } from './lib/sessions/split-focus.ts';
  import { createServerSwitch } from './lib/app/server-switch.ts';
  import { readScratchEdge, writeScratchEdge } from './lib/app/scratch-edge.ts';
  import { hoverCard } from './lib/ui/hover.svelte.ts';
  import { anchorOf, menuPlacement, popOrigin, viewBox, POPOVER_EDGE, POPOVER_GAP } from './lib/ui/placement.ts';
  import HoverCard from './lib/ui/HoverCard.svelte';
  import ContextMenu from './lib/ui/ContextMenu.svelte';
  import CommandButton from './lib/ui/CommandButton.svelte';
  import { cycleItem, dispatchShortcut, shortcutLabel } from './lib/app/shortcuts.ts';
  import { isShortcutInputTarget, shortcuts } from './lib/app/shortcuts.svelte.ts';
  import { installExternalLinkHandler } from './lib/core/external-links.ts';
  import { isTauri, isTauriDesktop, tauriReady } from './lib/core/platform.ts';
  import { localServerLine, localServer } from './lib/app/server-mode.svelte.ts';
  import { flip } from 'svelte/animate';
  import { moveMs } from './lib/ui/motion.ts';
  import { slideIndicator } from './lib/ui/indicator.ts';
  import { hoverInfo } from './lib/ui/hover.ts';
  import { installNativeContextMenuGuard } from './lib/ui/native-context-menu.ts';
  import { installPathLinkNet } from './lib/ui/path-link-net.ts';

  // Tunable constants
  const KB_OPEN_THRESHOLD = 100; // px difference to detect keyboard open
  const RECONNECT_MAX_ATTEMPTS = 10;           // total attempts before giving up
  const RECONNECT_WATCHDOG_MS = 180000;        // hard cap: if still reconnecting after 3min, force reset
  const SLIDE_ANIMATION_MS = 120;
  const OPTIMIZE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  let page = $state('settings');

  // Desktop/browser right-click must never expose browser chrome: a surface
  // either opens its app ContextMenu or does nothing. Touch/pen long-press is
  // deliberately exempt so selectable prose keeps the system selection UI.
  $effect(() => installNativeContextMenuGuard(window));
  $effect(() => installPathLinkNet(window));
  let connected = $state(false);
  // An in-place server switch in progress (board 315): { intent, from, target,
  // phase: 'connecting' | 'failed', error }. While set, the SHELL stays drawn
  // (rail / tab bar, inert) and the content area shows the switch panel; the
  // server-bound content tree is not mounted. `connected` is false then —
  // honestly, the socket is down.
  let switching = $state(null);
  // WHICH SERVER the content tree is bound to (board #335 ②b-1), and the key
  // it is keyed on. A new handle is a different server: the tree is torn down
  // and rebuilt, and `ServerScope` binds every page below it to that runtime
  // for the page instance's whole life. An ordinary reconnect keeps the same
  // handle — a new socket inside one object — and remounts nothing, which is
  // why the always-mounted pages survive a blip. Null until a server is
  // current (a fresh client on the connect page): pages then fall back to the
  // facade, the path they all took before this (board 315's serverEpoch
  // counter said "a different server" without saying WHICH, so nothing below
  // could be bound to one).
  // `$state.raw`, not `$state`: a runtime is an opaque HANDLE, and a deep
  // proxy over it would both wrap its transport and break the one thing the
  // handle is for — identity. `scopeRuntime === scopeSwap.shown()` has to
  // mean something, and under a proxy it never can (found by the A→B→A
  // restore test: the saved-state effect's guard could never pass).
  let scopeRuntime = $state.raw(null);
  /** The runtime whose navigation has been restored. The saved-state effect
   * waits for it, so nothing writes an empty navigation over the record the
   * restore is about to read (board #335 ②b-2). */
  let navRestored = $state.raw(null);
  /** What the app remembers about each runtime's server (board #335 ②b-2-1),
   * built in `swapScope` when the runtime is — after CURRENT moved, so it
   * reads the server being bound and not the one being left — and handed to
   * the subtree with the runtime. A WeakMap because the bundle's life is the
   * handle's: a handle nobody holds takes its server's memory with it. */
  const serverStates = new WeakMap();
  /** The ONE way a handle ends (app/handle-end.ts; board #335 ②b-2-3,
   * reviewer P1-a on 48b40082), on every path — the swap, a switch's revoke,
   * a connect attempt's "another server" verdict, an identity loss: it stops
   * now, its server's state is released, and only then is it disposed. The
   * state is NOT released when the handle replacing it adopted it (a
   * same-machine merge, which hands over its Files record); `bound()` names
   * that replacement. */
  const ends = createHandleEnds({
    stateOf: (runtime) => serverStates.get(runtime),
    adoptedElsewhere: (state, runtime) => {
      const next = scopeSwap.bound();
      return !!next && next !== runtime && serverStates.get(next)?.files === state.files;
    },
    release: releaseServerState,
  });
  /** The centre the shell's bell shows: the bound server's (②b-2-1), or —
   * with no server — an empty list over the window's one surface, so the bell
   * and its popover keep one owner whether or not a server is bound. */
  const noServerCentre = createCentre(createAlertLog(null));
  const centre = $derived(serverStates.get(scopeRuntime)?.centre ?? noServerCentre);
  const scopeSwap = createScopeSwap({
    show: (runtime) => { scopeRuntime = runtime; },
    // Where the unbound tree's teardown runs.
    settle: () => tick(),
    invalidate: async (gone) => {
      // And a Files/Board/Agents jump aimed at the tree that is going away.
      clearLandings();
      // END the handle the tree no longer shows — the same end a revoke or a
      // verdict may already have started, and then this waits on it. Its
      // server's state is released first (board #335 ②b-2-3): the work that
      // state started finishes or stops while the handle can still answer
      // for it, and the swap shows no runtime until this resolves. Then it
      // is DETACHED (board #335 ②b-1, reviewer P1-a): two generations of
      // handles can borrow one connection, so a replaced handle must stop
      // being usable, or its late continuations would record identity over a
      // slot that now serves another server. On a borrowed slot that ends
      // the handle and leaves the connection to the facade; b3-4 routes it
      // through the fleet's drop, where it ends the connection too.
      await ends.end(gone);
    },
  });
  /** Bind the content tree to whichever server is current — the registry's
   * CURRENT is the one answer to "which server is the app on", so no caller
   * has to pass an entry and none can pass a different one.
   *
   * A handle is replaced when the SERVER changes, not when a connect happens:
   * a reconnect through the connect page keeps the handle it had. Identity
   * repair is the reason this is read rather than passed — `recordServer` can
   * absorb the current entry into a machine's survivor and re-point CURRENT
   * at it, and after that the app IS on the survivor.
   *
   * Two things it must ask rather than assume (reviewer P2, 2026-10-10):
   * whether the handle is still ALIVE, because a failed switch's Back finds
   * the same entry id while the handle whose lease was revoked on the way out
   * cannot serve it again; and what the swap is already heading for, because
   * one success path calls this twice and comparing against the gap would
   * mint a handle nobody ever shows or releases. */
  function swapScope() {
    const id = currentServerId(localStorage);
    // No server's state is built before the inputs' attribution has been
    // asked for it (board #335 ②b-4): a fresh client's first server folds
    // here, a pending input meets the server that can claim it, and a
    // migration that cannot be recorded binds nothing at all.
    const fold = id ? foldFor(id) : 'ok';
    const entry = fold !== 'blocked' ? loadServers(localStorage).find((s) => s.id === id) ?? null : null;
    followMerges();
    const held = scopeSwap.bound();
    // A claim just filed the inputs into THIS server's slots: its state,
    // read before the claim, is rebuilt from them.
    if (held?.alive() && !ends.ending(held) && entry && held.id === entry.id && fold !== 'claimed') return;
    // The tree is changing servers: an attempt still in flight is no longer
    // the one the app is waiting on.
    handovers.endAll();
    const next = entry ? createSingleRuntime(entry, { storage: localStorage }) : null;
    // Its server's state: built NOW, since CURRENT already names `entry` and
    // the bare live keys are that server's (board #335 ②b-2-1) — or, when
    // identity repair folded the replaced handle's id into `entry`, the SAME
    // machine's state handed over, attempts in flight and all.
    if (next) {
      const replaced = held ? { id: held.id, state: serverStates.get(held) } : null;
      serverStates.set(next, stateForRuntime(replaced, entry.id, {
        survivorOf: (id) => mergedInto(localStorage, id),
        create: () => createServerState(createServerStore(localStorage, entry.id)),
      }));
    }
    void scopeSwap.swap(next);
  }
  /** Identity repair MERGED entries: everything that named an absorbed entry
   * names its survivor now (reviewer P1, 2026-10-10).
   *
   * `recordServer` folds a machine's twins into one entry — an address-only
   * entry that just learned it is the machine we already know — DELETES the
   * absorbed one and moves CURRENT (and its slots) to the survivor. Nothing
   * else noticed: every ref the app holds, and the refs inside the saved
   * record, still named the deleted id, so the restore
   * filtered them out and a same-machine connect came up with no panes at
   * all. Before #335 the same record had no server in it and was simply
   * restored, which makes this a Single regression.
   *
   * WHICH ids moved is the identity layer's answer (`mergedInto`), recorded
   * where the absorption happened — never inferred from an id being absent
   * (reviewer P1-a): a forgotten entry or a record from a server this client
   * never saved is absent too, and pointing that at the current server would
   * open its same-named pane. An id nothing explains keeps its server, and
   * the restore filters it out. This runs in the one place that reads
   * CURRENT, so every path that records identity — boot, bringUp, the
   * connect page's same-server return, a failover that first learns the
   * machine — follows the same merges. */
  function followMerges() {
    const survivorOf = (serverId) => mergedInto(localStorage, serverId);
    const rebind = (ref) => (ref ? reownRef(ref, survivorOf) : ref);
    termPane = rebind(termPane);
    filesRef = rebind(filesRef);
    const cells = splitCells.map((c) => ({ ...c, pane: rebind(c.pane) }));
    if (cells.some((c, i) => c.pane !== splitCells[i].pane)) splitCells = cells;
    // And the record on disk, which names its server from v2 on — in the
    // survivor's slot, where the merge moved it.
    const id = currentServerId(localStorage);
    if (id) reownSavedNav(createServerStore(localStorage, id), survivorOf);
  }
  /** The server every navigation reference names: the one the content tree is
   * bound to (board #335 ②b-2). Empty when nothing is bound — and then
   * nothing in the saved state can be attributed, so none of its panes are
   * restored. A reference is minted only here and in the saved-state effect,
   * both from this one answer. */
  function navServerId() {
    // `bound()`, not the shown handle: during a swap nothing is shown for a
    // tick, and a reference minted — or a restore filtered — against that
    // emptiness would drop every pane of the server being bound (reviewer
    // P1-a). `bound()` is the confirmed target of the swap in flight, and the
    // shown handle once it has settled.
    return scopeSwap.bound()?.id ?? '';
  }
  /** Give up the handle the tree is bound to, BEFORE the shared socket is
   * re-dialled at another server (reviewer P1-b, 2026-10-10).
   *
   * Every page in the tree holds that handle's api, and through ②b the api is
   * the facade's one slot: the moment the socket points at B, a call still in
   * flight from A's tree — or a settled callback that runs in the window
   * before the new tree mounts — would be A's work sent to B. Detaching first
   * makes those refuse instead. Clearing the landings after the DOM is gone
   * (the swap's `invalidate`) is the second line, never the first: it runs
   * ticks later, and by then the socket has already changed hands.
   *
   * This is the SWITCH's revoke, where leaving is already decided: the tree
   * is unmounted, the leave guards have answered, and the target is by
   * definition another server. */
  function revokeScope() {
    // Every open handover stops being current here: leaving is decided, so an
    // attempt that comes back afterwards must write no identity and bring
    // nothing up, whatever it found (reviewer P1, 2026-10-10).
    handovers.endAll();
    heldOffline = false;               // the person chose another server
    // STOPPED now — it refuses every call from here on — and ended once its
    // server's state is released: the swap that follows waits on that end
    // before it shows anything (reviewer P1-a on 48b40082).
    void ends.end(scopeSwap.bound());
  }
  /** The connect form's handover (app/handover.ts, which holds the rules and
   * the tests): the handle stands down for the length of one attempt, and
   * what happens to it next is decided by what that attempt ESTABLISHED about
   * the peer — never by the attempt merely finishing. A reconnect to the same
   * server therefore keeps its handle and remounts nothing, while an
   * authenticated stranger leaves it refusing. */
  const handovers = createHandovers({ end: (runtime) => { void ends.end(runtime); } });
  function suspendScope() {
    heldOffline = false;               // the person is connecting
    return handovers.open(scopeSwap.bound());
  }
  /** The connect form is about to dial `address` (board #335 ②b-2-3,
   * reviewer P1-c on 0b8b9038). If that can be ANOTHER server, the tree bound
   * to this one will be destroyed, so its editors are asked first — the same
   * walk the switcher runs, for the same handle. ANY address can be: an
   * address is not an identity, and one this machine used to answer on can
   * answer as another machine now (reviewer P1-b on 48b40082) — which machine
   * is known only after the dial, too late to ask. So there is no address
   * exemption; a clean editor asks nothing anyway. The walk HOLDS the form
   * mounted (`holdPages`) while it reveals other pages, so an accept returns
   * to the attempt that asked, with what it froze. While it asks, the
   * socket is held: nothing automatic takes it (`serverSwitch.guard`). */
  function confirmFormLeave() {
    const held = scopeSwap.bound();
    if (!held?.alive()) return Promise.resolve(true);
    return serverSwitch.guard(() => confirmLeave({ leaving: held, current: page, reveal: revealPage, hold: (on) => { holdPages = on; } }));
  }
  const shell = $derived(connected || !!switching);
  // WHAT the terminal is pointed at (board #335 ②b-2): a reference that names
  // its SERVER, because `work:1.0` on its own does not — two servers can both
  // have a session called `work`. The identity has one home; the two strings
  // every consumer and the wire want are DERIVED from it, so a serverId can
  // never reach a `target` or `session` argument.
  let termPane = $state(null);
  const terminalTarget = $derived(termPane?.target ?? '');
  const terminalSession = $derived(termPane?.session ?? '');
  /** Point the terminal at a pane on the server the content tree is bound to.
   * Every write goes through here, so a reference without a server cannot be
   * created. */
  function showPane(session, target) {
    termPane = target ? paneRef(navServerId(), session || target.split(':')[0], target) : null;
  }
  // Files follows the session the user touched LAST — opening a terminal pane
  // OR selecting a chat project both set it. It used to derive from the
  // terminal alone, so browsing a project in the chat never moved the Files
  // tab while switching terminal panes did (owner, 2026-08-22: "chat里的路径
  // 没有刷新到文件 terminal好像就会刷新路径").
  let filesRef = $state(null);
  const filesSession = $derived(filesRef?.session ?? '');
  function showSession(session) {
    filesRef = session ? sessionRef(navServerId(), session) : null;
  }
  // A landing is a request aimed at the server-bound TREE rather than a
  // reference to an object, so what it carries is that tree's identity: it is
  // delivered only to the tree it names (`landingFor`), and the swap clears
  // the ones aimed at a tree that is going away.
  let filesNavReq = $state(null);
  let boardIssueReq = $state(null); // a feed board-line tap: which issue to open
  $effect(() => { if (terminalSession) showSession(terminalSession); });
  // The Hub (project rooms, agents, board) is desktop-server-only. We probe
  // once per connection: hub_rooms rejects with method-not-found on a server
  // without the projects store (mobile), so a resolved probe means the Hub
  // tabs should appear.
  let hubState = $state({ available: false, probed: false });
  let hubAvailable = $derived(hubState.available);
  // The Hub page-layers only mount when hubAvailable, so page === 'hub'
  // without it would render an empty main area (the state restore sets `page`
  // before the probe resolves, and a reconnect can land on a hubless server).
  // Once the probe has definitively answered "no hub", fall back to Terminal.
  // While the probe is still pending we leave `page` alone — a brief blank
  // beats kicking the user off the tab they were on.
  $effect(() => {
    if (page === 'team') page = 'hub'; // the retired Team tab's saved state lands on its successor
    // Sessions tab retired 2026-08-18: the list is Terminal's sidebar now, so
    // a persisted/deep-linked 'sessions' lands on the terminal it belonged to.
    if (page === 'sessions') page = 'terminal';
    // The Hub needs the desktop server. Only redirect once the probe answered.
    if ((page === 'hub' || page === 'agents' || page === 'board') && hubState.probed && !hubState.available) page = 'terminal';
    // On touch the agent configuration is a Settings CATEGORY, so `agents` as a
    // page has no tab icon and no swipe stop — whatever route set it (a saved
    // state, a deep link, an older build), it becomes Settings opened there.
    if (page === 'agents' && agentsLivesInSettings(layout.isTouchDevice)) {
      page = 'prefs';
      prefsOpenReq = { tab: 'agents', n: ++prefsOpenSeq };
    }
  });

  // ─── Split-screen (desktop + wide only) ────────────────────────────────
  // splitLayout 1 = the single-pane path (mobile + default desktop), exactly
  // as before. 2/3/4/6 tile that many independent Terminal cells via
  // SplitView. The single `terminalTarget` above stays the source of truth
  // for the Files page, nav pills, and the narrow-screen fallback; cell 0
  // mirrors it.
  let splitLayout = $state(1);
  let splitCells = $state([]);   // [{ id, pane: PaneRef | null }]
  /** What SplitView takes: the strings tmux resolves. The serverId stays on
   * this side of the boundary — a cell's identity is App's, the pane's name is
   * the wire's (board #335 ②b-2). */
  const splitViewCells = $derived(splitCells.map((c) => ({
    id: c.id,
    target: c.pane?.target ?? '',
    session: c.pane?.session ?? '',
  })));
  let activeCellId = $state(null);
  // The top-right layout menu: `ui/ContextMenu` anchored to the toggle (right-
  // aligned, like every dot menu). It was a hand-rolled `position:absolute`
  // panel with a backdrop — no Escape, no close on scroll/resize, no viewport
  // clamp (review, 2026-09-03); now it is the app's ONE popover mechanism.
  let splitMenuAt = $state(null);
  const SPLIT_CHOICES = [1, 2, 3, 4, 6];
  const splitMenuItems = $derived(SPLIT_CHOICES.map((n) => ({
    label: n === 1 ? t('splitSingle') : t('splitPanes').replace('{n}', String(n)),
    checked: n === 1 ? !splitActive : (splitActive && splitLayout === n),
    onselect: () => setLayout(n),
  })));
  function toggleSplitMenu(e) {
    splitMenuAt = splitMenuAt ? null : { anchor: anchorOf(e.currentTarget), trigger: e.currentTarget };
  }
  let nextCellId = 0;
  const SPLIT_MIN_WIDTH = 900;
  let wideEnough = $state(typeof window !== 'undefined' && window.innerWidth >= SPLIT_MIN_WIDTH);
  let splitEligible = $derived(!layout.isTouchDevice && (layout.forceDesktop || wideEnough));
  // ONE status sampler for the connected client (board #85). Desktop keeps
  // it visible in the primary sidebar; touch CSS reveals the same instance
  // only while a shared .side-sheet is open — never one poller per page.
  let sysMounted = $derived(connected);
  // Shared sidebar width (ui-unification.md): the shell owns the geometry,
  // pages consume var(--sidebar-w), SideHandle is the only other writer.
  $effect(() => {
    const saved = parseInt(localStorage.getItem('tmux_sidebar_w') || '', 10);
    if (saved >= 180 && saved <= 420) {
      document.documentElement.style.setProperty('--sidebar-w', saved + 'px');
    }
  });

  // The scratch terminal (board #324): App owns the frame's state — open,
  // edge, sizes — outside the server key; the panel itself (and its Terminal)
  // mounts inside the server-bound tree, so a switch destroys it. A switch
  // closes it the moment it starts; the next explicit open ensures the
  // session on the server you are on.
  let scratchOpen = $state(false);
  // bottom | right, with a pre-#326 `left` migrated on read (scratch-edge.ts).
  let scratchEdge = $state(readScratchEdge(localStorage));
  function setScratchEdge(e) { scratchEdge = e; writeScratchEdge(localStorage, e); }
  $effect(() => {
    for (const [v, k, lo, hi] of [['--scratch-h', 'tmux_scratch_h', 160, 1200], ['--scratch-w', 'tmux_scratch_w', 280, 1400]]) {
      const saved = parseInt(localStorage.getItem(k) || '', 10);
      if (saved >= lo && saved <= hi) document.documentElement.style.setProperty(v, saved + 'px');
    }
  });
  $effect(() => { if (switching) scratchOpen = false; });

  // Overlay geometry vars for fixed-position panels (Preferences): they must
  // clear whatever shell chrome exists — top bar when disconnected, the left
  // rail on connected desktop, nothing on connected mobile.
  $effect(() => {
    const root = document.documentElement.style;
    root.setProperty('--shell-top', shell ? '0px' : '49px');
    root.setProperty('--shell-left', shell && !layout.isTouchDevice ? '46px' : '0px');
  });
  // The Hub needs only the server-side bus (hub_* degrades method-not-found
  // without it, same probe). Its LAYOUT adapts: three columns on
  // desktop, a single chat column on touch devices.
  let hubEligible = $derived(hubAvailable);
  let splitActive = $derived(splitEligible && splitLayout > 1 && splitCells.length > 0);

  function setLayout(n) {
    if (!splitEligible || n <= 1) {
      splitLayout = 1;
      splitCells = [];
      activeCellId = null;
      return;
    }
    // Seed cell 0 from the current single pane; pad to n with empty cells.
    const base = splitCells.length
      ? splitCells.slice()
      : (termPane
          ? [{ id: nextCellId++, pane: termPane }]
          : []);
    const next = base.slice(0, n);
    while (next.length < n) next.push({ id: nextCellId++, pane: null });
    splitLayout = n;
    splitCells = next;
    if (activeCellId == null || !next.some(c => c.id === activeCellId)) {
      activeCellId = next[0]?.id ?? null;
    }
  }
  function assignCell(id, target, session) {
    const pane = target ? paneRef(navServerId(), session || target.split(':')[0], target) : null;
    splitCells = splitCells.map(c => c.id === id ? { ...c, pane } : c);
    // Keep the single-pane mirror pointed at the active cell so the
    // narrow-screen fallback and Files page follow what the user is using.
    if (id === activeCellId && target) {
      termPane = pane;
    }
  }
  function closeCell(id) {
    splitCells = splitCells.map(c => c.id === id ? { ...c, pane: null } : c);
  }
  function cellPaneExit(id) { closeCell(id); }

  // Re-subscribe after a reconnect / address switch: the server forgot all
  // subscriptions, so re-send the wire `subscribe` for every target with a
  // live refcount. This does NOT touch refcounts (the Terminals are still
  // mounted — only the server-side state was lost), so it's safe to call on
  // every reconnect without leaking counts.
  function resubscribeAll() {
    wsResubscribeActive();
  }
  let theme = $state(localStorage.getItem('tmux_theme') || 'system');
  let fontSize = $state(parseInt(localStorage.getItem('tmux_fontsize')) || 14);
  const initialUiZoom = normalizeUiZoom(localStorage.getItem('tmux_ui_zoom'));
  let uiZoom = $state(initialUiZoom);
  let zoomApplyVersion = 0;
  let zoomApplyQueue = Promise.resolve();
  const currentWebview = isTauriDesktop
    ? import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview())
    : null;
  const FONT_MIN = 6, FONT_MAX = 40;
  // Terminal font size is independent from desktop UI zoom. Changing it
  // flows to every Terminal instance and triggers xterm's deferred re-fit.
  function setFontSize(n) {
    const v = Math.max(FONT_MIN, Math.min(FONT_MAX, n));
    if (v === fontSize) return;
    fontSize = v;
    localStorage.setItem('tmux_fontsize', v);
  }
  async function setUiZoom(value) {
    const next = normalizeUiZoom(value);
    uiZoom = next;
    localStorage.setItem('tmux_ui_zoom', String(next));
    if (!isTauriDesktop) {
      // Web / Android: CSS zoom on the root scales the whole interface.
      // Two compensations keep the geometry honest:
      // - --ui-zoom lets the full-height containers divide their pixel
      //   --app-height back down (the writers keep writing raw innerHeight);
      // - the terminal host counter-zooms to 1.0 so xterm's cell metrics
      //   stay in physical pixels — terminal text size is its OWN setting,
      //   and mixing scaled cell rects with unscaled clientHeight would
      //   mis-fit cols×rows.
      document.documentElement.style.zoom = String(next);
      document.documentElement.style.setProperty('--ui-zoom', String(next));
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('app-zoom-change', { detail: { scale: next } }));
      });
      return;
    }
    const version = ++zoomApplyVersion;
    zoomApplyQueue = zoomApplyQueue.then(async () => {
      try {
        const webview = await currentWebview;
        await webview.setZoom(next);
        if (version !== zoomApplyVersion) return;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
          window.dispatchEvent(new CustomEvent('app-zoom-change', { detail: { scale: next } }));
        }));
      } catch (error) {
        if (version === zoomApplyVersion) {
          uiZoom = UI_ZOOM_DEFAULT;
          localStorage.setItem('tmux_ui_zoom', String(UI_ZOOM_DEFAULT));
        }
      }
    });
    await zoomApplyQueue;
  }

  if (isTauriDesktop || initialUiZoom !== 1) setUiZoom(initialUiZoom);

  // Settings is a PAGE (ui-unification.md "Settings as a page"), not a modal.
  // The gear toggles into it and back to where you were.
  let pageBeforePrefs = 'terminal';
  let prefsPushed = false;
  function togglePrefs() {
    if (page === 'prefs') {
      if (prefsPushed) history.back();
      else { page = pageBeforePrefs; slidePage('slide-in-left'); }
    } else {
      pageBeforePrefs = page; page = 'prefs'; slidePage('slide-in-right');
      prefsPushed = navPush();
    }
  }
  // Apply the persisted custom fonts (if any) before first paint — rewrites
  // --font-mono/--font-ui/--font-display inline; a no-op for the defaults.
  applyFontVars();
  let serverInfo = $state({ hostname: '', machineId: '' });
  let activeAddress = $state(localStorage.getItem('tmux_address') || '');
  // The address whose row was just tapped and is still dialing (review,
  // 2026-09-03: switching an address gave no feedback on the row itself — the
  // old one stayed lit while the socket was rebuilt). Set before the direct
  // connect, cleared when it settles either way; the row wears the running cue.
  let pendingAddress = $state('');
  // Bumped when the Connection page edits the failover set (board #222) —
  // localStorage is not reactive, so the derived re-reads on the bump.
  let addrSetVersion = $state(0);
  let prefAddresses = $derived.by(() => {
    void addrSetVersion;
    if (!serverInfo.machineId) return [];
    try {
      const machines = JSON.parse(localStorage.getItem('tmux_machines') || '{}');
      return Array.isArray(machines[serverInfo.machineId]) ? machines[serverInfo.machineId] : [];
    } catch {
      return [];
    }
  });
  // Remove the legacy CSS zoom. Desktop UI scaling now uses WKWebView's
  // native pageZoom through Tauri, so viewport geometry and visual scale stay
  // in the same coordinate system.
  if (isTauri) {
    document.documentElement.style.zoom = '';
    localStorage.removeItem('tmux_zoom');
  }

  // Keep every ordinary app link out of the embedded WebView. File-preview
  // iframes need their own handler because events do not cross documents.
  $effect(() => installExternalLinkHandler(document));

  // Keyboard height detection
  $effect(() => {
    // Android Tauri app: native event provides exact keyboard height
    let androidNativeKb = false;
    let pendingNativeKb = 0;
    let pendingNativeTimer = 0;
    const hasFocusedTextInput = () => {
      const activeTag = document.activeElement?.tagName;
      return activeTag === 'TEXTAREA' || activeTag === 'INPUT';
    };
    const applyNativeKeyboardHeight = (kbh) => {
      pendingNativeKb = 0;
      clearTimeout(pendingNativeTimer);
      if (kbh === 0 && window.innerHeight > fullHeight) fullHeight = window.innerHeight;
      const h = kbh > 0 ? (fullHeight - kbh) + 'px' : fullHeight + 'px';
      document.documentElement.style.setProperty('--app-height', h);
      document.documentElement.classList.toggle('keyboard-open', kbh > 0);
      // After layout updates, shift terminal and log
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('keyboard-shift', { detail: { kbHeight: kbh > 0 ? kbh : 0 } }));
        const main = document.querySelector('main');
        const termWrap = document.querySelector('.term-wrap');
      });
      // No explicit refit needed — updating --app-height changes the terminal
      // container size, which Terminal.svelte's ResizeObserver picks up.
    };
    const nativeHandler = (e) => {
      androidNativeKb = true; // suppress visualViewport handler on Android
      const kbh = e.detail?.height || 0;
      if (kbh > 0 && !hasFocusedTextInput()) {
        // The IME can become visible during the opening touch event,
        // one task before xterm's hidden textarea receives focus. Dropping this
        // one-shot native height leaves the terminal at full-screen size until
        // the user closes and reopens the keyboard. Keep the stale-event guard,
        // but defer the value briefly so focusin can validate and apply it.
        pendingNativeKb = kbh;
        clearTimeout(pendingNativeTimer);
        pendingNativeTimer = setTimeout(() => {
          if (pendingNativeKb === kbh && hasFocusedTextInput()) applyNativeKeyboardHeight(kbh);
          else if (pendingNativeKb === kbh) pendingNativeKb = 0;
        }, 500);
        return;
      }
      applyNativeKeyboardHeight(kbh);
    };
    window.addEventListener('androidKeyboardHeight', nativeHandler);

    // Track the max known height (= full screen without keyboard)
    let fullHeight = window.innerHeight;
    window.__fullHeight = () => fullHeight;

    // Mobile browser: track visualViewport height so main always fits
    // the visible area (keyboard doesn't push nav off screen).
    //
    // Desktop must NOT run this. A desktop window still has a
    // window.visualViewport, and resizing/zooming the window fires its
    // `resize` event — pinning `--app-height` to vv.height there both
    // (a) false-trips the `kbOpen` heuristic when the window shrinks past
    // the threshold, and (b) under page zoom hands back a scaled height
    // that diverges from the real layout box, so the terminal computes the
    // wrong row count (width was unaffected because it's pure flex). On
    // desktop we leave `--app-height` at its CSS default (100dvh) and let
    // the terminal's ResizeObserver refit on window resize.
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const vv = isTouch ? window.visualViewport : null;
    const vpHandler = () => {
      if (!vv || androidNativeKb) return;
      const h = vv.height;
      // Update full height when viewport grows (keyboard closing)
      if (h > fullHeight) fullHeight = h;
      const kbOpen = h < fullHeight - KB_OPEN_THRESHOLD;
      const wasKbOpen = document.documentElement.classList.contains('keyboard-open');
      document.documentElement.style.setProperty('--app-height', h + 'px');
      document.documentElement.classList.toggle('keyboard-open', kbOpen);
      // After layout, shift terminal so cursor stays visible
      requestAnimationFrame(() => {
        const kbShift = kbOpen ? (fullHeight - h) : 0;
        window.dispatchEvent(new CustomEvent('keyboard-shift', { detail: { kbHeight: kbShift } }));
      });
      // No explicit refit needed — --app-height already reflects the
      // visible viewport, so Terminal.svelte's ResizeObserver picks up
      // the container size change on both keyboard open and close.
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
    };
    if (vv) {
      vv.addEventListener('resize', vpHandler);
      vv.addEventListener('scroll', vpHandler);
    }

    // A deferred native keyboard height applies once an input takes focus.
    const onFocusIn = (e) => {
      if (pendingNativeKb > 0 && hasFocusedTextInput()) {
        const kbh = pendingNativeKb;
        applyNativeKeyboardHeight(kbh);
      }
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      clearTimeout(pendingNativeTimer);
      window.removeEventListener('androidKeyboardHeight', nativeHandler);
      document.removeEventListener('focusin', onFocusIn);
      if (vv) {
        vv.removeEventListener('resize', vpHandler);
        vv.removeEventListener('scroll', vpHandler);
      }
    };
  });

  // Track window width so split-screen collapses to single below the
  // threshold (and re-enables when widened). Cheap; desktop only matters.
  //
  // ALSO drive --app-height from window.innerHeight on desktop. The CSS
  // default is `100dvh`, but macOS WKWebView does NOT recompute `dvh` when
  // the window is enlarged — it stays pinned at the smaller value, so the
  // layout box never grows, the terminal's ResizeObserver never fires, and a
  // black gap opens below the terminal. (Chromium recomputes dvh, which is
  // why the browser is fine.) Writing innerHeight on every resize makes the
  // layout box track the window exactly, which the ResizeObserver then picks
  // up to refit xterm. Mobile is excluded: its height is owned by the
  // visualViewport handler above (keyboard-aware), and touching it here would
  // fight that handler.
  $effect(() => {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    let resizeFrame = 0;
    const syncDesktopHeight = () => {
      if (isTouch) return;
      document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
    };
    const onResize = () => {
      wideEnough = window.innerWidth >= SPLIT_MIN_WIDTH;
      syncDesktopHeight();
      // WKWebView can deliver the resize event before its layout viewport has
      // adopted the new window size. Measure again on the next frame so a
      // maximized/restored macOS window cannot retain the previous height.
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(syncDesktopHeight);
    };
    onResize(); // set the correct height on mount, not just on the first resize
    window.addEventListener('resize', onResize);
    window.addEventListener('pageshow', onResize);
    if (!isTouch) window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(resizeFrame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pageshow', onResize);
      if (!isTouch) window.visualViewport?.removeEventListener('resize', onResize);
    };
  });

  // Desktop Cmd/Ctrl +/-/0 scales the complete WebView. Terminal font size
  // remains an independent setting; changing UI scale therefore does not
  // replace xterm's renderer or disturb its hidden textarea focus.
  $effect(() => {
    if (!isTauriDesktop) return;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault(); setUiZoom(stepUiZoom(uiZoom, 1));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault(); setUiZoom(stepUiZoom(uiZoom, -1));
      } else if (e.key === '0') {
        e.preventDefault(); setUiZoom(UI_ZOOM_DEFAULT);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  });

  function setTheme(t) {
    theme = t;
    localStorage.setItem('tmux_theme', t);
    applyTheme();
  }

  let isDark = $state(true);

  function applyTheme() {
    isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }

  let iconSrc = $derived(isDark ? '/assets/icon-dark.svg' : '/assets/icon-light.svg');

  $effect(() => {
    applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  // A project rename renames its tmux session, so every target that names the
  // old session stops resolving — including the one on screen. Remap them in
  // place instead of dropping the user on a dead pane.
  $effect(() => {
    const onRenamed = (e) => {
      const { from, to } = e.detail ?? {};
      if (!from || !to || from === to) return;
      // The rename happened on the server whose tree dispatched it — the one
      // the content tree is bound to — and `retargetRef` refuses to apply it
      // to a reference belonging to any other (board #335 ②b-2). The
      // prefix-exact rule itself still lives in `nav-state.retarget`.
      const rename = { serverId: navServerId(), from, to };
      const move = (ref) => (ref ? retargetRef(ref, rename) : ref);
      termPane = move(termPane);
      filesRef = move(filesRef);
      splitCells = splitCells.map((c) => ({ ...c, pane: move(c.pane) }));
    };
    window.addEventListener('project-renamed', onRenamed);
    return () => window.removeEventListener('project-renamed', onRenamed);
  });

  // Persist nav state for restore on reload. It used to save ONLY when a
  // terminal target existed, so reading the chat and refreshing dropped you back
  // on the device's default tab — the state was there, just never written
  // (owner, 2026-08-19: "每次切换或者刷新都会变"). The tab is worth remembering on
  // its own; the terminal fields ride along when there are any.
  // splitLayout/splitCells are only meaningful on desktop; a desktop-saved state
  // degrades to single-pane on a phone because restore re-gates on splitEligible.
  // Since #335 ②b-2 every saved pane NAMES ITS SERVER (`nav-saved.ts`):
  // `work:1.0` on its own does not say whose `work` it is, and a restore runs
  // against ONE runtime. The ids come from the server the tree is bound to,
  // which is the only server anything in this state can be about.
  $effect(() => {
    // Not before the restore for THIS runtime has finished: the record this
    // effect would write over is the one the restore is about to read. It
    // writes the bound server's own slot (board #335 ②b-4).
    if (!connected || !scopeRuntime || navRestored !== scopeRuntime) return;
    saveNav(createServerStore(localStorage, scopeRuntime.id), { page, pane: termPane, splitLayout, splitCells });
  });

  // Reconnect UI state, mirrored from the reconnect machine
  // (src/lib/app/reconnect.ts — framework-free, unit-tested; owns every
  // timer, the retry/backoff/probe strategy, and the stuck-watchdog).
  let reconnecting = $state(false);
  /** Why the last automatic reconnect could not bring the app back, shown on
   * the connect page ('' when nothing went wrong). */
  let reconnectError = $state('');
  /** The person chose to stay on a server whose address now reaches another
   * one (`arrivedElsewhere`, reviewer P2 on 085b0e70). Nothing AUTOMATIC
   * dials until they connect themselves: not the disconnect callback, not a
   * foreground resume, not a late optimizer probe. The person's own acts —
   * the connect form, a switch, an address row — clear it. */
  let heldOffline = false;
  let reconnectAttempt = $state(0);   // 1-indexed when visible; 0 means not attempting
  let reconnectClass = $state('');    // LAN / Tailscale / WAN label for the current try

  const reconnectMachine = createReconnectMachine({
    connect,
    // Each attempt takes the socket through a HANDOVER of its own, the same
    // one the connect form opens (reviewer P1s, 2026-10-10): the handle
    // stands down for the attempt, a boot dial or a form still out stops
    // being the app's, and the attempt in turn stops being the app's the
    // moment the form opens one. Its verdict settles the same way.
    attempt: () => handovers.open(scopeSwap.bound()),
    findBestAddress,
    isAddressViable,
    noteAddressUnreachable,
    classifyAddress,
    addressLabels: ADDRESS_LABELS,
    // The ONE machine reconnects the CURRENT server (board #335 ②b-2-2); a
    // machine per runtime would pass its own id here.
    target: () => targetOf(localStorage, currentServerId(localStorage)),
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    watchdogMs: RECONNECT_WATCHDOG_MS,
    onStateChange: (st) => {
      reconnecting = st.reconnecting;
      reconnectAttempt = st.attempt;
      reconnectClass = st.label;
    },
    onSuccess: (useAddr, primaryAddr, handover) => onReconnectSuccess(useAddr, primaryAddr, handover),
    onGiveUp: () => { connected = false; page = 'settings'; },
  });

  setOnDisconnect(() => {
    if (switching) return; // the switch owns the socket now
    // A leave walk is asking about this socket, or the person chose to stay
    // offline: an automatic reconnect would take the socket under them.
    // Nor while the migration is blocked: nothing may move CURRENT.
    if (serverSwitch.guarding || heldOffline || migrationBlocked) return;
    // Keep connected=true during reconnect to avoid UI flicker
    reconnectMachine.start();
  });

  function cancelReconnect() {
    reconnectMachine.cancel();
    connected = false;
    disconnect();
    page = 'settings';
  }

  function onReconnectSuccess(useAddr, primaryAddr, handover) {
    // An attempt already out when the migration blocked records nothing.
    if (migrationBlocked) { handover?.settle('unresolved'); disconnect(); connected = false; return; }
    // WHO answered decides what this success means, and the identity layer
    // is the one that knows (reviewer P1-b on 372cb4af): the entry
    // `recordServer` returns for the machine that answered. "CURRENT did not
    // move" is not that answer — a known A whose address now reaches known B
    // keeps both entries and CURRENT on A.
    const held = scopeSwap.bound();
    const mid = getMachineId?.() || '';
    let canonical;
    try {
      ({ entry: canonical } = recordServer(localStorage, {
        address: useAddr, token: localStorage.getItem('tmux_token') || '',
        ...(localStorage.getItem('tmux_socket') ? { socket: localStorage.getItem('tmux_socket') } : {}),
        ...(mid ? { machineId: mid } : {}),
      }));
    } catch {
      // A peer authenticated and we could not establish which server it is.
      // That is never "the same server": the handle keeps refusing (hold),
      // and the person is told, exactly as the connect form does.
      handover?.settle('unresolved');
      reconnectError = t('configIdentityFailed');
      disconnect();
      connected = false;
      page = 'settings';
      return;
    }
    reconnectError = '';
    loadServerRegistry(); // the entry's active address moved
    // Another known machine answered, and both entries stay: the socket is
    // B's. The app ARRIVES at B the way the boot and the connect page do —
    // after A's editors have been asked — and never resumes A's api over B's
    // socket.
    if (held && currentServerId(localStorage) !== canonical.id && mergedInto(localStorage, held.id) !== canonical.id) {
      void arrivedElsewhere({ entry: canonical, machineId: mid }, useAddr, localStorage.getItem('tmux_token') || '', handover);
      return;
    }
    connected = true;
    serverInfo = { hostname: getHostname() || '', machineId: mid };
    // Keep the registry entry's active address fresh (board #55): failover
    // just proved a different address of the SAME machine.
    if (useAddr !== primaryAddr) { localStorage.setItem('tmux_address', useAddr); activeAddress = useAddr; }
    // The handle's own server (same id) resumes. Otherwise this is the entry
    // it was folded into: a failover can be the connect that first learns
    // this machine's id, and then `recordServer` absorbs the entry we were on
    // into the machine's survivor. CURRENT moved, so the tree's handle and
    // every reference the app holds have to follow it (reviewer P1,
    // 2026-10-10) — and the swap below does that WITHOUT a verdict: it ends
    // every handover and ends the handle itself, after the replacement has
    // ADOPTED its state. A verdict here would end it first, while nothing had
    // adopted it, and release the state the survivor is about to take over.
    // A no-op whenever the id did not move, which is the ordinary failover.
    if (held && held.id === canonical.id) handover?.settle('same-server');
    swapScope();
    void keepNavFor(scopeSwap.bound());
    resubscribeAll();
    serverReady();
    // Tell Terminal to reset stale resize state + re-fit against the new server.
    window.dispatchEvent(new Event('ws-reconnected'));
  }

  /** What EVERY connect path asks a server it has just reached: does it host
   * the Hub, and which backends can it spawn. ONE call per path (board #253):
   * the boot path called probeHub alone, so a page load with a saved token
   * never fetched backends_list and the Agents editor hid the queue/steer
   * field (and fell back to the frozen backend list).
   *
   * The questions are the RUNTIME's since board #335 ②b-2-2: it is asked
   * through its own api, keeps the answers as its caps, and a round number
   * of its own means an older answer never overwrites a newer one. App adds
   * the two checks only it can make — the switch still owns this intent, and
   * the runtime asked is still the one the tree is bound to — and mirrors the
   * caps into the shell. Two rules stay as they were: a Hub flag changes only
   * on a definitive answer (`hub` stays null on a blip, because false
   * unmounts the always-mounted Hub), and an empty backend list counts as
   * unknown. One rule is the runtime's and differs: a FAILED backends probe
   * keeps the list this runtime already had instead of wiping it to the
   * fallback, as ②a ruled (a list that vanished on a blip was the bug). */
  function serverReady() {
    const runtime = scopeSwap.bound();
    if (!runtime) return;
    const intent = serverSwitch.intent;
    // Published as EACH answer lands (reviewer P2): the Hub shows when its own
    // probe answers, not after a slow backends list.
    void runtime.probeCaps((caps) => {
      if (!serverSwitch.owns(intent) || scopeSwap.bound() !== runtime) return; // asked of a server we have left
      if (caps.hub !== null) hubState = { available: caps.hub, probed: true };
      setServedBackends(caps.backends);
    });
  }

  /** The socket now answers as ANOTHER saved entry: a boot dial's
   * `elsewhere` (reviewer P1-a on cc5e517e), or an automatic reconnect whose
   * address reached a different known machine (reviewer, 18:54 on
   * 5ca0e79e). Two different facts arrive as that one verdict:
   *
   *   - the entry was an address-only alias of that machine, and identity
   *     repair ABSORBED it: CURRENT already names the canonical entry, so the
   *     app simply comes up on it;
   *   - both entries are known machines and BOTH stay: the address that used
   *     to reach A reaches B now. CURRENT still names A, and bringing the app
   *     up would rebuild A's runtime over B's socket. The socket is B's, so
   *     the app ARRIVES at B the way the connect page arrives at a different
   *     server — CURRENT moves to B (`activateConnected`), and the app comes
   *     up on B through the swap (`onConnected(true)`).
   *
   * Arriving destroys A's tree, so A's editors are asked FIRST, through the
   * one leave walk: losing the socket is not consent to discard local edits.
   * On a fresh boot nothing is dirty and the walk asks nothing. A "stay"
   * keeps A's tree with its handle still refusing (`hold`), closes B's
   * socket, and says why on the connect page — and nothing automatic dials
   * again (`heldOffline`) until the person connects. While the walk asks,
   * the socket is held: no reconnect, address change or second walk starts
   * (`serverSwitch.guard`). `attempt` is the claim or handover the socket
   * was taken under: if someone else took it anyway, this arrival is not
   * the app's any more and does nothing. */
  async function arrivedElsewhere(result, addr, token, attempt) {
    if (migrationBlocked) { attempt.settle?.('unresolved'); disconnect(); connected = false; return; }
    if (currentServerId(localStorage) === result.entry.id) { bringUp(addr, token); return; }
    if (!attempt.current()) return;
    let leave = false;
    try {
      // Under the attempt's OWN ownership: claiming again would make it stale.
      leave = await serverSwitch.guard(() => confirmLeave({ leaving: scopeSwap.bound(), current: page, reveal: revealPage, hold: (on) => { holdPages = on; } }), attempt);
    } catch { leave = false; }
    if (!attempt.current()) return;
    if (!leave) {
      attempt.settle?.('unresolved');
      disconnect();
      connected = false;
      heldOffline = true;
      reconnectError = t('serverAnsweredElsewhere').replace('{name}', result.entry.name || hostLabel(result.entry.address));
      page = 'settings';
      return;
    }
    attempt.settle?.('other-server');
    try {
      const act = activateConnected(localStorage, {
        address: addr, token,
        ...(localStorage.getItem('tmux_socket') ? { socket: localStorage.getItem('tmux_socket') } : {}),
        ...(result.machineId ? { machineId: result.machineId } : {}),
      });
      if (act.reload) { onConnected(true); return; }
      bringUp(addr, token);
    } catch { page = 'settings'; }
  }

  /** The disconnected connect page reached a server. `switched`: it is a
   * DIFFERENT server than the current entry (activateConnected moved CURRENT
   * here), so the app comes up on it the way an in-place switch does — memory
   * reset, tree remounted, the target's own state restored — instead of
   * reloading (board 315). */
  function onConnected(switched = false) {
    if (switched) {
      reconnectMachine.cancel();
      serverSwitch.supersede();
      resetServerMemory();
      centreSurface.reset();          // the bell and a jump aimed at the server left
      swapScope();
      localStorage.removeItem('tmux_disconnected');
      activeAddress = localStorage.getItem('tmux_address') || '';
      loadServerRegistry();
      bringUp(activeAddress, localStorage.getItem('tmux_token') || '');
      resubscribeAll();
      return;
    }
    reconnectMachine.cancel();
    connected = true;
    serverInfo = { hostname: getHostname() || '', machineId: getMachineId() || '' };
    // A first-ever connect is where this client's registry entry comes from,
    // so it is also where the content tree first has a server to be bound to
    // (board #335 ②b-1). A plain reconnect to the server it is already bound
    // to keeps its handle and remounts nothing.
    swapScope();
    void keepNavFor(scopeSwap.bound());
    // The device default (Chat), never a hard-coded Terminal (board #333); a
    // hubless server falls back to Terminal through the redirect above.
    page = defaultPage();
    localStorage.removeItem('tmux_disconnected');
    // A manual connect from Settings reaches a server with EMPTY subscription
    // state, while Terminals stay mounted across the disconnect and keep their
    // refcounts — so their subscribe() calls will never re-send the wire
    // message themselves. Without this, the terminal shows a frozen snapshot
    // (send_keys still works — it's a plain RPC) until a full reload.
    // Mirrors onReconnectSuccess; on a first-ever connect both are no-ops.
    resubscribeAll();
    serverReady();
    window.dispatchEvent(new Event('ws-reconnected'));
  }

  function openTerminal(session, target) {
    const from = page;
    showPane(session, target);
    page = 'terminal';
    navPush();
    if (from === 'hub') jumpedFrom = 'hub';
  }

  // The shown pane died (Ctrl-D, process exit). Stay in the terminal and
  // fall back to the previous pane of the same session — switcher order,
  // nearest below the closed window/pane index, else the first after it.
  // Only when the session has no panes left (or is gone entirely) return
  // to Sessions, and only if the user is actually looking at the terminal:
  // pane_closed can arrive while they're on another tab (Terminal stays
  // mounted in a hidden page-layer), and yanking them out of Files for a
  // background pane death would be hostile.
  async function paneExitFallback(closed) {
    let remaining = [];
    try {
      const m = /:(\d+)\.(\d+)$/.exec(closed || '');
      const cw = m ? Number(m[1]) : -1;
      const cp = m ? Number(m[2]) : -1;
      remaining = (await listPanes(terminalSession))
        .filter((p) => `${p.session}:${p.window}.${p.pane}` !== closed)
        .sort((a, b) => a.window - b.window || a.pane - b.pane);
      const before = remaining.filter((p) => p.window < cw || (p.window === cw && p.pane < cp));
      const pick = before[before.length - 1] || remaining[0];
      if (pick) {
        showPane(pick.session, `${pick.session}:${pick.window}.${pick.pane}`);
        return;
      }
    } catch {} // list_panes fails when the whole session died with the pane
    showPane('', '');
    // Nothing left to show: the empty state offers the session list (which
    // used to BE the fallback page).
    if (page === 'terminal' && layout.isTouchDevice) sessListOpen = true;
  }

  function doDisconnect() {
    reconnectMachine.cancel();
    disconnect();
    connected = false;
    page = 'settings';
    const id = currentServerId(localStorage);
    if (id) createServerStore(localStorage, id).removeItem('tmux_state');
    localStorage.setItem('tmux_disconnected', '1');
  }

  // --- Server switcher (board #55: "在桌面上能右下角agent上边快速切换按钮") ---
  // The registry lives in servers.ts (named entries mirroring the active
  // tmux_address/token keys); this is only the rail entry: a popover listing
  // the entries, the current one marked, a click switching. The switch itself
  // is switchTo below — in place, no reload (board 315).
  let serverMenuOpen = $state(false);
  const serverPickerId = $props.id();
  let serverMenuEl = $state(null);
  let serverList = $state([]);
  let serverCurId = $state('');
  let serverMenuAnchor = $state(null); // read by the menu's --pop-origin in the template
  let serverMenuSide = $state('below');  // 'right' while the rail opened it (#326)
  let serverMenuTrigger = null;      // the control that opened it — not "outside"
  let serverMenuW = $state(0);
  let serverMenuH = $state(0);
  let serverListEl = $state(null);   // the ServerList instance: rename/IME state lives there
  // The ONE name of the current server outside the list (rail hover card,
  // the phone's Settings row, the switch panel's "Back to"): its saved
  // entry's name, as its row reads (board #319).
  const serverName = $derived(
    currentServerName(serverList, serverCurId, serverInfo, activeAddress),
  );
  function loadServerRegistry() {
    serverList = loadServers(localStorage);
    serverCurId = currentServerId(localStorage);
  }
  // Every successful auth reports the server's hostname (serverInfo, set on
  // each connect path). The ONE place the registry learns it (board #310):
  // the entry for this machine (or the current one, before it has a machine
  // id) adopts it as its name unless the user named it. Runs after the
  // connect paths' recordServer, so a fresh entry is already there.
  $effect(() => {
    const { hostname, machineId } = serverInfo;
    if (!hostname) return;
    const servers = loadServers(localStorage);
    const entry = (machineId && servers.find((s) => s.machineId === machineId))
      || servers.find((s) => s.id === currentServerId(localStorage));
    if (!entry) return;
    const next = adoptHostname(servers, entry.id, hostname);
    if (next === servers) return;
    saveServers(localStorage, next);
    serverList = next;
  });

  /** Where a popover opened by `el` goes — ONE definition, derived from
   * structure (board #326). A control inside the RAIL opens BESIDE the rail:
   * the box the popover must clear is that control's vertical span with the
   * RAIL's own right edge, so the popover clears the whole 46px column and
   * not merely the icon, and `side: 'right'` guarantees it by construction
   * (placement.ts turns a narrow viewport into less ROOM, never into an x
   * that slides back over the rail). Anything else keeps the dropdown
   * reading: the same `centre` store opened from the Hub's header bell still
   * drops below its trigger, with no second branch anywhere. */
  function popoverFrom(el) {
    const anchor = anchorOf(el);
    const rail = el?.closest?.('.rail');
    return rail
      ? { anchor: { ...anchor, right: anchorOf(rail).right }, side: 'right' }
      : { anchor, side: 'below' };
  }

  function toggleServerMenu(e) {
    if (serverMenuOpen) { closeServerPicker(); return; }
    loadServerRegistry();
    ({ anchor: serverMenuAnchor, side: serverMenuSide } = popoverFrom(e.currentTarget));
    serverMenuTrigger = e.currentTarget;
    serverMenuW = 0; serverMenuH = 0;
    serverMenuOpen = true;
  }
  /** Outside dismissal waits for an open IME composition's final value
   * (ServerList.finish returns false and calls onclose when it lands). */
  function closeServerPicker() {
    if (serverListEl && !serverListEl.finish(true)) return;
    serverMenuOpen = false;
  }
  const serverMenuPos = $derived.by(() =>
    serverMenuOpen && serverMenuAnchor
      ? menuPlacement(serverMenuAnchor, { w: serverMenuW, h: serverMenuH }, viewBox(), POPOVER_GAP, POPOVER_EDGE, 'right', serverMenuSide)
      : { x: 0, y: 0, maxW: 0, maxH: 0 },
  );
  $effect(() => {
    if (!serverMenuOpen || !serverMenuEl) return;
    const menu = serverMenuEl;
    const origin = serverMenuTrigger;
    const modal = activeModal(document);
    if (!modal || modal.contains(menu)) menu.focus({ preventScroll: true });
    const modalOwnsInteraction = () => {
      const modal = activeModal(document);
      return !!modal && !modal.contains(menu);
    };
    const onDown = (e) => {
      if (modalOwnsInteraction()) return;
      if (menu.contains(e.target) || serverMenuTrigger?.contains?.(e.target)) return;
      closeServerPicker();
    };
    const onKey = (e) => {
      if (modalOwnsInteraction()) return;
      if (!menu.contains(document.activeElement)) return;
      if (e.isComposing || e.keyCode === 229 || serverListEl?.isComposing()) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (!serverListEl?.cancelRename()) closeServerPicker();
      }
    };
    const onScroll = (e) => {
      if (modalOwnsInteraction()) return;
      if (serverMenuEl && e.target instanceof Node && serverMenuEl.contains(e.target)) return;
      const scroller = e.target === document ? document.documentElement : e.target;
      if (!(scroller instanceof Node) || !origin || !scroller.contains(origin)) return;
      closeServerPicker();
    };
    const onResize = () => {
      // The soft keyboard resizes a dialog containing its own editable field.
      if ((menu.querySelector('.sm-rename') || modalOwnsInteraction()) && origin?.isConnected) ({ anchor: serverMenuAnchor, side: serverMenuSide } = popoverFrom(origin));
      else closeServerPicker();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      const modal = activeModal(document);
      if (origin instanceof HTMLElement && origin.isConnected
        && (document.activeElement === document.body || menu.contains(document.activeElement))
        && (!modal || modal.contains(origin))) origin.focus({ preventScroll: true });
    };
  });

  // The notification centre's popover (board #322): the server picker's
  // placement and dismissal, anchored to whichever control opened it.
  const centreShown = $derived(hubEligible); // the centre is fed by the Hub bus
  let centreEl = $state(null);
  let centreW = $state(0);
  let centreH = $state(0);
  // ONE resolved placement for the centre: the position, the room AND the
  // grow origin come out of the same `popoverFrom` answer, so the intro can
  // never start at a corner the popover was not placed against (#326 review).
  const centrePlace = $derived.by(() => {
    if (!centre.anchor || !centre.anchor.isConnected) return null;
    const { anchor, side } = popoverFrom(centre.anchor);
    const pos = menuPlacement(anchor, { w: centreW, h: centreH }, viewBox(), POPOVER_GAP, POPOVER_EDGE, 'right', side);
    return { pos, origin: popOrigin(anchor, pos, 'right', side) };
  });
  const centrePos = $derived(centrePlace?.pos ?? { x: 0, y: 0, maxW: 0, maxH: 0 });
  $effect(() => {
    const origin = centre.anchor;
    if (!origin || !centreEl) return;
    const menu = centreEl;
    menu.focus({ preventScroll: true });
    const onDown = (e) => { if (!menu.contains(e.target) && !origin.contains(e.target)) centre.close(); };
    const onKey = (e) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); centre.close(); } };
    const onResize = () => centre.close();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (origin.isConnected && (document.activeElement === document.body || menu.contains(document.activeElement))) origin.focus({ preventScroll: true });
    };
  });

  function serverRename(id, name) { serverList = renameServer(localStorage, id, name); }
  function serverRemove(id) { serverList = removeServer(localStorage, id); serverCurId = currentServerId(localStorage); }
  /** A row of the server list was picked. */
  function doServerSwitch(id) {
    const target = loadServers(localStorage).find((s) => s.id === id);
    if (!target) { loadServerRegistry(); return; } // stale row (entry vanished)
    void switchTo(target);
  }

  // While the leave guards are asked, Settings stays mounted even when another
  // page is revealed: its Agents editor may not have answered yet (board 315).
  let holdPages = $state(false);
  /** What both server lists show about the connection (ServerList `link`). */
  const serverLink = $derived({
    connected: connected && !reconnecting,
    target: switching ? { id: switching.target.id, failed: switching.phase === 'failed' } : null,
  });
  /** Bring a hidden guarded page into view so its own dialog asks there. */
  async function revealPage(next) {
    if (page !== next) { page = next; await tick(); }
  }

  /** A landing is delivered only to the tree it NAMES (board #335 ②b-2).
   * The swap clears the ones aimed at a tree that is going away, and this is
   * the other half: a request that somehow outlived its tree — or arrives
   * while another server is bound — is not handed to the pages of a server it
   * was never about. */
  function landingFor(request) {
    return request && request.serverId === navServerId() ? request : null;
  }

  /** Requests aimed at the server-bound tree: a Files or Board jump from the
   * Hub, an agent to open in the editor, the breadcrumb back to where the
   * jump came from. They name a tree, so when that tree is replaced they are
   * not stale data to be refreshed — they are addressed to something that no
   * longer exists, and the swap clears them between the teardown and the new
   * mount (board #335 ②b-1). `resetServerMemory` calls this rather than
   * repeating it, so "what a landing is" has one definition. */
  function clearLandings() {
    filesNavReq = null; boardIssueReq = null; agentsEditReq = null;
    jumpedFrom = null;
  }

  /** Everything in memory that belongs to the server being left (board 315),
   * reset AFTER the content tree is gone and the socket closed. The rest of
   * the per-server state is in that server's slots and its runtime's state
   * bundle; components and
   * their ws.ts listeners/subscriptions went with the unmount. A source test
   * pins this list against the module-level stores. */
  function resetServerMemory() {
    // FIRST, and before the shared socket can be re-dialled at the target:
    // the handle this tree is bound to gives up its lease, so a call in
    // flight or a settled callback cannot become A's work sent to B.
    revokeScope();
    scratchOpen = false;                // the panel closes; its Terminal goes with the keyed tree
    setServedBackends(null);            // the backend list is the server's answer
    hoverCard.hide();                   // a card may describe the old server's row
    hubState = { available: false, probed: false };
    serverInfo = { hostname: '', machineId: '' };
    pendingAddress = '';
    // App navigation that names things on the old server; bringUp restores
    // the target's own from its parked tmux_state.
    termPane = null;
    splitCells = []; splitLayout = 1; activeCellId = null;
    filesRef = null;
    clearLandings();
    sessListOpen = false;
  }

  // THE server switch (board 315): every entry — the switcher popover,
  // Settings › Connection, Add server, the panel's Retry and Back — goes
  // through server-switch.ts, which owns the order and the source/candidate
  // split. App supplies the effects: the content tree unmounts while
  // `switching` is set, and `comeUp` binds it to the target's runtime handle
  // (board #335 ②b-1) — a failed switch's Back keeps the handle it had,
  // because Back returns to the server it left.
  const serverSwitch = createServerSwitch({
    storage: localStorage,
    connected: () => connected,
    currentId: () => serverCurId,
    currentName: () => serverName,
    confirmLeave: () => confirmLeave({ leaving: scopeSwap.bound(), current: page, reveal: revealPage, hold: (on) => { holdPages = on; } }),
    // An address change and a leave walk take the socket from every other
    // owner (reviewer P1s on 085b0e70 and 4fbce02e): the one owner counter.
    claim: () => handovers.claim(),
    reconnecting: () => reconnectMachine.isActive(),
    stopReconnect: () => reconnectMachine.cancel(),
    startReconnect: () => { if (!migrationBlocked) reconnectMachine.start(); },
    // While the migration is blocked nothing moves CURRENT (orchestrator,
    // 21:45): no switch, no address connect.
    frozen: () => migrationBlocked,
    addressUp: (address) => {
      serverInfo = { hostname: getHostname() || '', machineId: getMachineId() || '' };
      // The address that just answered is the server's active one, on its
      // ENTRY — the one place a reconnect or a reload reads it (board #335
      // ②b-4 retired the mirror that used to stand in for it).
      const mid = getMachineId() || '';
      if (mid) {
        try {
          recordServer(localStorage, {
            address, token: localStorage.getItem('tmux_token') || '',
            ...(localStorage.getItem('tmux_socket') ? { socket: localStorage.getItem('tmux_socket') } : {}),
            machineId: mid,
          });
          loadServerRegistry();
        } catch { /* the entry keeps the address it had */ }
      }
      resubscribeAll();
      window.dispatchEvent(new Event('ws-reconnected'));
    },
    onstate: (st) => {
      switching = st;
      if (st) { serverMenuOpen = false; connected = false; }
    },
    // The leaving server's attempts, from ITS record (board #335 ②b-2-1).
    // The leaving server's state is RELEASED before the socket moves (board
    // #335 ②b-2-3): new attempts forbidden, running ones suspended, and all
    // of them settled — not merely asked to stop.
    suspendDownloads: async () => { const st = serverStates.get(scopeSwap.bound()); if (st) await releaseServerState(st); },
    afterUnmount: () => tick(),
    disconnect,
    resetMemory: resetServerMemory,
    connect: (address, token) => connect(address, token),
    setSocket,
    machineId: () => getMachineId() || '',
    comeUp: (target) => {
      centreSurface.reset();          // the bell and a jump aimed at the server left
      swapScope();
      activeAddress = target.address;
      loadServerRegistry();
      addrSetVersion++;
      bringUp(target.address, target.token);
      resubscribeAll();
    },
  });
  // No switch while the fold is unrecorded: there is no server state to
  // arrive with.
  const switchTo = (target) => serverSwitch.switchTo(target);
  function switchRetry() { void serverSwitch.retry(); }
  function switchBack() { void serverSwitch.back(loadServers(localStorage)); }

  /** The `+` row: the Settings connect form IS the add flow (it upserts by
   *  address on success), so the row only takes you there. No disconnect —
   *  the current server stays live until the new one authenticates. */
  /** The `+` row and the failed panel's Edit: the connect fields in a
   * dialog inside the shell (board 315). Open/cancel write nothing; submit is
   * the one switch path. */
  let addServer = $state(null); // { initial } | null
  function openAddServer(initial = null) {
    serverMenuOpen = false;
    addServer = { initial: initial ? { address: initial.address, token: initial.token, socket: initial.socket } : null };
  }
  function serverAddRow() { openAddServer(); }
  function submitAddServer(c) {
    addServer = null;
    const known = loadServers(localStorage).find((s) => s.address === c.address);
    // A known address is that entry (same token/socket edits apply); a new
    // one is a CANDIDATE with no id until the server says which machine it is.
    void switchTo(known ? { ...known, token: c.token, socket: c.socket } : { id: '', name: hostLabel(c.address), ...c });
  }

  // --- Optimal address selection ---
  let lastProbeTime = 0;
  let optimizing = $state(false);

  function getAllAddresses() {
    // The CURRENT entry's machine (board #335 ②b-4): the unprefixed
    // tmux_machine_id is the frozen legacy mirror now, not the live machine.
    const id = currentServerId(localStorage);
    const mid = loadServers(localStorage).find((s) => s.id === id)?.machineId || '';
    if (!mid) return [];
    try { return JSON.parse(localStorage.getItem('tmux_machines') || '{}')[mid] || []; }
    catch { return []; }
  }

  async function optimizeConnection() {
    if (migrationBlocked) return;
    const addrs = getAllAddresses();
    if (addrs.length <= 1 || optimizing) return;
    const current = localStorage.getItem('tmux_address');
    // Only probe addresses that would be a strict UPGRADE over the current
    // class (LAN < Tailscale < WAN). Probing peers/downgrades is pure
    // waste: we'd never switch to them (the check below rejects ≥ current
    // class), and when the phone is on WAN the LAN/Tailscale addresses are
    // unreachable — each probe is a phantom connection attempt hanging
    // until its 3 s timeout, polluting logs and radio wakeups every cycle.
    const curClass = classifyAddress(current);
    if (curClass === 0) { lastProbeTime = Date.now(); return; } // already best
    const candidates = addrs.filter(a => classifyAddress(a) < curClass);
    if (candidates.length === 0) { lastProbeTime = Date.now(); return; }
    optimizing = true;
    const intent = serverSwitch.intent;
    try {
      const best = await findBestAddress(candidates);
      // A server switch began while probing: this server is not current now.
      // Nor may it move the socket while a leave walk asks about it — not
      // even the mirror: a probe that started before the dialog and answers
      // during it is the same takeover (reviewer P1 on 085b0e70).
      // And after a "stay" it is not the person's connect, so it does not
      // lift the stay (reviewer P2 on 4fbce02e); a walk since the probe
      // began has moved the intent anyway.
      if (!serverSwitch.owns(intent) || serverSwitch.guarding || heldOffline || migrationBlocked) return;
      if (!best || best === current) return;
      // Only switch if the new address is higher priority (lower class number)
      if (classifyAddress(best) >= curClass) return;
      localStorage.setItem('tmux_address', best);
      activeAddress = best;
      // A failure restarts the reconnect loop (all addresses) — only while
      // this attempt still owns the socket (connectAddress).
      await serverSwitch.connectAddress(best, localStorage.getItem('tmux_token') || '');
    } catch {
      // the probe itself threw: nothing was dialed, nothing to recover
    } finally {
      optimizing = false;
      lastProbeTime = Date.now();
    }
  }

  // Deep-link connect: a shareable URL can pre-fill the connection and auto-jump
  // in, e.g.  https://app/?addr=ws://host:9899&token=XXX  (also accepts
  // address=/server=, an optional socket=, and params inside the #hash). We copy
  // them into the same localStorage keys the normal flow uses — so the existing
  // auto-connect effect below picks them up — then STRIP them from the URL so the
  // token isn't left sitting in the address bar or re-applied on refresh.
  // (Caveat: a token in a link can still land in browser/proxy history before we
  // strip it — only share such links over trusted channels.)
  /** The connection a deep link names, or null; the link is stripped from the
   * address bar either way, so a token never stays there. */
  function takeConnectLink() {
    try {
      const hashQ = location.hash.includes('?') ? location.hash.split('?')[1] : '';
      const q = new URLSearchParams(location.search || hashQ);
      const addrRaw = q.get('addr') || q.get('address') || q.get('server');
      const token = q.get('token');
      const socket = q.get('socket');
      if (!addrRaw && token == null) return null;
      history.replaceState(null, '', location.pathname + location.hash.split('?')[0]);
      let address = '';
      if (addrRaw) {
        address = addrRaw.trim();
        if (!/^wss?:\/\//.test(address)) address = (location.protocol === 'https:' ? 'wss://' : 'ws://') + address;
      }
      return { address, token, socket };
    } catch { return null; } // malformed URL — ignore, fall back to saved/settings
  }
  /** Apply a deep link: the same keys the normal flow uses, so the boot dial
   * picks them up, and — with an address — the registry. */
  function applyConnectLink({ address, token, socket }) {
    try {
      if (address) {
        localStorage.setItem('tmux_address', address);
        try {
          const hist = JSON.parse(localStorage.getItem('tmux_address_history') || '[]')
            .map(h => (typeof h === 'string' ? { address: h, token: '' } : h));
          const entry = { address, token: token || '' };
          localStorage.setItem('tmux_address_history',
            JSON.stringify([entry, ...hist.filter(h => h.address !== address)].slice(0, 8)));
        } catch {}
      }
      if (token != null) localStorage.setItem('tmux_token', token);
      if (socket) localStorage.setItem('tmux_socket', socket);
      localStorage.removeItem('tmux_disconnected'); // explicit intent to connect
      // A deep-linked server joins the registry like a hand-typed one (board
      // #55) — and ACTIVATES like one: a different server becomes CURRENT
      // (this runs pre-boot, so no reload is needed on top), while an
      // alternate address of the current machine folds into its entry. The
      // inputs were attributed just before, so nothing of the server being
      // left can land in the linked server's slots.
      if (address) activateConnected(localStorage, { address, token: token || '', ...(socket ? { socket } : {}) });
    } catch { /* storage refused: the saved connection stays as it was */ }
  }
  // Multi-server registry (board #55): migrate the single-server keys into
  // named entries BEFORE the deep-link consumer runs, so a link on a
  // pre-registry client first preserves the current user as entry one and
  // then upserts the linked server — never the reverse (an upsert creating
  // the registry would make migrateServers a no-op and drop the history).
  /** The boot migration is NOT COMPLETE (board #335 ②b-4; reviewer P1s on
   * cf7e7957): a write it needed failed — the registry's, the inputs'
   * attribution, the fold — and nothing records what happened to the
   * pre-#335 inputs. Until a retry records it, CURRENT and the registry are
   * FROZEN (orchestrator, 21:45): no server's state is built and no server
   * page mounts, and nothing that would move CURRENT or record an identity
   * runs — the boot dial, a deep link's activation, a switch, an address
   * row, the optimizer, the reconnect loop, the connect form. The shell,
   * the connect card (disabled, with the reason) and Preferences stay; the
   * panel's Retry is the way out. */
  let migrationBlocked = $state(false);
  /** Everything the boot needs written before a server may be bound, in its
   * order: the registry, then the inputs' attribution. Safe to run again —
   * each step is idempotent — which is what Retry does. */
  function prepareStorage() {
    try {
      migrateServers(localStorage);
      migrationBlocked = migrateServerState(localStorage).reason === 'unrecorded';
    } catch { migrationBlocked = true; }
    loadServerRegistry();
  }
  /** Before server `id`'s state is built: `claimed` when a pending input
   * was just filed into its slots, `blocked` when the migration cannot be
   * recorded (and then nothing is bound), else `ok`. A blocked migration is
   * tried again first, so storage that recovered unblocks the next bind. */
  function foldFor(id) {
    if (migrationBlocked) prepareStorage();
    if (migrationBlocked) return 'blocked';
    let reason;
    try {
      reason = migrateServerState(localStorage).reason;
      if (reason === 'pending') {
        const claim = claimPending(localStorage, id).reason;
        reason = claim === 'folded' ? 'claimed' : claim;
      }
    } catch { reason = 'unrecorded'; }
    if (reason === 'unrecorded') { migrationBlocked = true; return 'blocked'; }
    return reason === 'claimed' ? 'claimed' : 'ok';
  }
  /** A deep link that arrived while the migration was blocked: parsed and
   * stripped from the address bar at once, APPLIED only once the migration
   * is recorded — applying it makes its server current, and the inputs must
   * be attributed first (reviewer P1-a on cf7e7957). */
  let deferredLink = null;
  function retryMigration() {
    prepareStorage();
    if (migrationBlocked) return;
    if (deferredLink) { const link = deferredLink; deferredLink = null; applyConnectLink(link); loadServerRegistry(); }
    swapScope();
    const bound = scopeSwap.bound();
    if (bound && connected) { serverReady(); void restoreNavFor(bound); }
  }
  /** The boot (board #335 ②b-4): the registry and the inputs' attribution
   * FIRST, then the deep link — a link to B makes B current, and attributing
   * after it would file A's live state into B's slot — then the bind. */
  prepareStorage();
  takeBootLink(takeConnectLink());
  function takeBootLink(link) {
    if (link && migrationBlocked) deferredLink = link;
    else if (link) { applyConnectLink(link); loadServerRegistry(); }
  }
  // Bind the content tree before its first render (board #335 ②b-1): the
  // deep-link consumer above can make a different server current, and a bind
  // that arrived a tick later would mount every page unbound and then rebuild
  // them. With nothing bound yet this is immediate, by that rule.
  swapScope();

  // Copy the CURRENT connection as a deep link (consumed by takeConnectLink
  // on the other device). Plain clipboard copy with a brief ✓ — no share sheet,
  // no prompt (copyText already falls back to execCommand on http).
  let linkCopied = $state(false);
  const linkFeedback = createFeedbackLifetime(value => { linkCopied = value?.kind === 'success'; });
  // Same-machine polling replaces serverInfo, not the copy's semantic context.
  const linkContext = $derived(JSON.stringify({ page, connected, activeAddress, serverCurId, machineId: serverInfo.machineId }));
  $effect(() => { void linkContext; linkFeedback.clear(); });
  onDestroy(() => linkFeedback.dispose());
  async function shareConnectionLink() {
    const attempt = linkFeedback.begin();
    const context = linkContext;
    const addr = localStorage.getItem('tmux_address') || activeAddress;
    if (!addr) return;
    const token = localStorage.getItem('tmux_token') || '';
    const socket = localStorage.getItem('tmux_socket') || '';
    const params = new URLSearchParams();
    params.set('addr', addr);
    if (token) params.set('token', token);
    if (socket) params.set('socket', socket);
    const link = `${location.origin}${location.pathname}?${params.toString()}`;
    // Storage is not reactive; recheck the captured credentials as well as the page/server.
    const current = () => linkFeedback.current(attempt) && context === linkContext
      && addr === (localStorage.getItem('tmux_address') || activeAddress)
      && token === (localStorage.getItem('tmux_token') || '')
      && socket === (localStorage.getItem('tmux_socket') || '');
    const copied = await copyText(link);
    if (!current()) return;
    if (!copied) throw new Error(t('copyFailed'));
    linkFeedback.update(attempt, { kind: 'success', message: t('linkCopied') });
  }

  /** Bring the app up against the server the socket just authenticated with:
   * the boot path's half after `connect` resolves (board 315 shares it with
   * the in-place switch, so "how the app comes up on a server" is written
   * once). Records the machine identity onto the current entry, asks the
   * server what it hosts, and restores that server's navigation. */
  function bringUp(addr, token) {
    connected = true;
    serverInfo = { hostname: getHostname() || '', machineId: getMachineId() || '' };
    // RECORD the machine identity onto the current registry entry (board
    // #55): the boot path is how most sessions connect, and without this
    // stamp an entry never learns its machineId — a later connect to an
    // alternate address of the SAME machine would then read as a new
    // server. Record only: the entry booted as current, nothing activates.
    try {
      const mid = getMachineId?.();
      if (mid) {
        recordServer(localStorage, {
          address: addr, token,
          ...(localStorage.getItem('tmux_socket') ? { socket: localStorage.getItem('tmux_socket') } : {}),
          machineId: mid,
        });
      }
    } catch {}
    // Identity repair may have moved CURRENT: `recordServer` absorbs the
    // machine's twins, and when the entry we booted as is one of the absorbed
    // the app is now on the survivor. Binding the tree is therefore the last
    // step of recording identity, not a step of connecting — and it is a
    // no-op whenever the id did not move (board #335 ②b-1).
    swapScope();
    // Nothing to restore while the fold is unrecorded: the app shows the
    // reason, on a page that is not the connect card (board #335 ②b-4).
    if (migrationBlocked) { page = defaultPage(); return; }
    serverReady();
    void restoreNavFor(scopeSwap.bound());
  }

  /** The app's navigation is ALREADY this runtime's: open the saved-state
   * effect for it without reading the record back (reviewer P1-b,
   * 2026-10-10).
   *
   * The save gate opens per runtime, and before this only a restore opened
   * it — so every path that confirms a runtime WITHOUT arriving at a server
   * left it shut: the connect page's same-server return (and with it a
   * client's first-ever connect, which has no record to restore), and a
   * failover. When identity repair absorbed the entry the app was on, those
   * paths replaced the handle and the gate stayed on the old one forever:
   * the pane on screen was right, and nothing the person did after it was
   * ever saved. Restoring there instead would be wrong in the other
   * direction — what is on screen is the person's latest navigation on this
   * same machine, newer than the record, and the merge has already rebound
   * it. Same guard as the restore: after the bind, and only for the runtime
   * still on screen. */
  async function keepNavFor(target) {
    await scopeSwap.settled();
    if (!target || scopeSwap.shown() !== target) return;
    navRestored = target;
  }

  /** The navigation the app comes up with, for ONE confirmed runtime.
   *
   * It runs after that runtime is actually bound (reviewer P1-a): the swap
   * shows nothing for a tick, and filtering against that emptiness dropped
   * every pane of the server being brought up — an ordinary A→B→A lost both
   * sides' terminal and split. A restore for a runtime that is no longer the
   * one on screen does nothing, so a stale swap cannot restore over a later
   * one's work, and the saved-state effect waits until the restore for the
   * bound runtime has finished (`navRestored`) rather than writing an empty
   * navigation over the record it was about to read. */
  async function restoreNavFor(target) {
    await scopeSwap.settled();
    if (!target || scopeSwap.shown() !== target) return;
    try {
      // Read from THIS server's slot, which is what makes it this server's
      // (board #335 ②b-4), then filtered to this runtime: a v2 pane that
      // names another server cannot be resolved over this connection — at
      // best the capture fails, at worst that server has a pane by the same
      // name and the reader lands on a stranger's terminal.
      const s = navFor(readNav(createServerStore(localStorage, target.id)), target.id);
      // A saved target names a session that may not exist any more — killed
      // while we were away, or RENAMED (a project rename renames its session).
      // Restoring it anyway lands the user on a pane that cannot be captured,
      // so check first and come back to the tab without a target instead.
      if (s.pane) {
        const named = s.pane.session;
        const intent = serverSwitch.intent;
        listSessions()
          .then((sessions) => {
            if (!serverSwitch.owns(intent)) return; // a switch began: not this server's tree
            // list_sessions answers with a bare array (list_sessions_with_panes
            // is the one that wraps).
            if (!(sessions ?? []).some((x) => x.name === named)) {
              termPane = null;
              splitCells = splitCells.filter((c) => c.pane?.session !== named);
            }
          })
          .catch(() => {});
        termPane = s.pane;
        // Restore split layout only on eligible (desktop + wide) clients;
        // a desktop-saved state silently stays single-pane on a phone.
        if (splitEligible && s.splitLayout > 1 && s.splitCells.length) {
          splitCells = s.splitCells;
          splitLayout = s.splitLayout;
          nextCellId = Math.max(0, ...s.splitCells.map((c) => c.id)) + 1;
          activeCellId = s.splitCells[0]?.id ?? null;
        }
      }
      // The tab is restored whether or not a terminal came with it; only an
      // unknown name falls back to the device default. On touch a saved
      // `agents` resolves to Settings opened at its Agents category — there is
      // no Agents tab to land on there. The tab is the PERSON's, so it
      // survives even when nothing could be attributed to a server.
      const nav = restoreNav(s.page, layout.isTouchDevice);
      page = nav.page;
      if (nav.settingsTab) prefsOpenReq = { tab: nav.settingsTab, n: ++prefsOpenSeq };
    } catch { page = defaultPage(); }
    navRestored = target;
  }

  // Auto-reconnect and restore state on page load
  let autoConnectAttempted = false;

  // Detect app resume (Android background → foreground) + periodic optimize
  $effect(() => {
    const handler = () => {
      // Not while a leave walk asks about the socket, and not after the
      // person chose to stay offline (reviewer P2 on 085b0e70).
      if (document.visibilityState !== 'visible' || switching || serverSwitch.guarding || heldOffline || migrationBlocked) return;
      if (!isConnected() && !reconnectMachine.isActive()) {
        reconnectMachine.start();
      } else if (isConnected()) {
        // A suspended mobile WebView can resume with WebSocket.readyState still
        // OPEN even though pane pushes stopped while it was backgrounded. The
        // server treats subscribe as idempotent and resets its change detector,
        // guaranteeing a fresh pane_output without perturbing local refcounts.
        resubscribeAll();
        if (Date.now() - lastProbeTime > OPTIMIZE_INTERVAL_MS) optimizeConnection();
      }
    };
    document.addEventListener('visibilitychange', handler);
    // Periodic check while connected
    const interval = setInterval(() => {
      if (!switching && !serverSwitch.guarding && isConnected() && Date.now() - lastProbeTime > OPTIMIZE_INTERVAL_MS) {
        optimizeConnection();
      }
    }, OPTIMIZE_INTERVAL_MS);
    return () => { document.removeEventListener('visibilitychange', handler); clearInterval(interval); };
  });

  $effect(() => {
    // Not while the migration is blocked; Retry unblocks it and this runs.
    if (autoConnectAttempted || connected || switching || migrationBlocked) return;
    // Where: the CURRENT entry when there is one (board #335 ②b-4, reviewer
    // P2 on cf7e7957 — a mirror an unanswered form emptied must not keep a
    // saved server from coming up); the mirror only for a client with no
    // saved entry yet.
    const route = targetOf(localStorage, currentServerId(localStorage));
    const addr = route?.address || localStorage.getItem('tmux_address');
    const token = route ? route.token : localStorage.getItem('tmux_token');
    if (!addr || !token) return;
    if (localStorage.getItem('tmux_disconnected')) return;
    autoConnectAttempted = true;

    const timeout = setTimeout(() => { page = 'settings'; }, 5000);

    // The bound runtime dials (board #335 ②b-2-2): the same connection the
    // facade would have used (the Single runtime borrows it), with the
    // runtime's attempt identity and its identity recording. It dials the
    // route the one reader names, its entry — `addr` and `token` here. A
    // client with no saved entry yet has nothing bound, and connects through
    // the facade as before.
    //
    // The dial OWNS the socket only until another attempt takes it — the
    // connect form, a reconnect attempt, a switch (reviewer P1-b,
    // 2026-10-10). It claims the host's one owner counter, the runtime asks
    // that claim before it records anything, and the outcome below is acted
    // on only while the claim is still current: a result that had already
    // resolved when the form took over says nothing about the app now.
    const owner = handovers.claim();
    const runtime = scopeSwap.bound();
    const dialled = runtime ? runtime.dial(owner.current) : connect(addr, token).then(() => ({ ok: true }));
    dialled.then((result) => {
      clearTimeout(timeout);
      if (!owner.current()) return;
      // Where the runtime actually dialled is its ENTRY's address (board
      // #335 ②b-4), which the mirror read above need not be: the app comes
      // up on what answered, and records that.
      if (result.ok) { bringUp(result.entry?.address ?? addr, result.entry?.token ?? token); return; }
      if (result.reason === 'elsewhere') { void arrivedElsewhere(result, result.entry.address, result.entry.token, owner); return; }
      if (result.reason !== 'superseded') page = 'settings';
    }).catch(() => {
      clearTimeout(timeout);
      if (owner.current()) page = 'settings';
    });
  });
  // Android back gesture via history API
  // Every navigation push a state, back pops it naturally
  let filesGoBack = $state(null);
  /** Files' reading mode asks for the whole screen (board #226): the tab bar hides while it is on. */
  let filesImmersive = $state(false);
  let hubGoBack = $state(null);
  let agentsGoBack = $state(null);
  let prefsGoBack = $state(null);
  // A request from the Hub's agent menu to open one agent's CONFIG editor:
  // {name, n} — n increments so asking for the same agent twice still fires.
  let agentsEditReq = $state(null);
  // A one-shot "open this Settings category" request, same {tab, n} shape. The
  // sequence is a plain counter, NOT read back off the state: one of the writers
  // is the page-redirect $effect, and reading the state it writes would make
  // that effect depend on itself.
  let prefsOpenSeq = 0;
  let prefsOpenReq = $state(null);
  /** The ONE way into the agent configuration, wherever it lives on this device:
   *  a page of its own on the desktop rail, a Settings category on a phone
   *  (nav-state's agentsLivesInSettings). Every caller — the Hub's "configure
   *  agent" item and the restore path — goes through here, so the two devices
   *  cannot drift apart. */
  function openAgentsConfig(name = null, kind = 'agent') {
    if (name) agentsEditReq = { serverId: navServerId(), name, kind, n: (agentsEditReq?.n ?? 0) + 1 };
    if (agentsLivesInSettings(layout.isTouchDevice)) {
      prefsOpenReq = { tab: kind === 'team' ? 'teams' : 'agents', n: ++prefsOpenSeq };
      if (page !== 'prefs') togglePrefs();
    } else {
      switchTab('agents');
    }
  }
  let boardGoBack = $state(null);
  let sessionsGoBack = $state(null);
  // A cross-page JUMP from the chat (header toggles, a feed board-line tap,
  // opening a pane full-screen) remembers where it came from, so the phone's
  // back at the target's FLOOR returns to the conversation instead of the
  // terminal root (owner, 2026-08-29: "从聊天跳转到terminal或者board或者file，
  // 我返回 应该回到聊天对话页面"). Any deliberate navigation — a tab tap, a
  // swipe — clears it: the slot only survives while you stay where the jump
  // landed.
  let jumpedFrom = $state(null);

  // The history dance exists for the PHONE's back gesture (app-shell.md): a
  // seeded `{app:true}` entry, re-pushed on every consumed pop, so the gesture
  // peels layers instead of leaving the app. A desktop browser has no gesture
  // to protect, and the same dance made the app a page you could not Back out
  // of (review, 2026-09-03). So the seed, every re-push and the popstate router
  // are gated on the touch layout — live, because the layout mode is a
  // setting. navPush reports whether it pushed, so a caller that later spends
  // the entry with history.back() (the gear, Settings' drill) only does so
  // when its push was real.
  function navPush() {
    if (!layout.isTouchDevice) return false;
    history.pushState({ app: true }, '');
    return true;
  }

  $effect(() => {
    if (!layout.isTouchDevice) return; // desktop: the browser's Back is the browser's
    const handler = (e) => {
      if (!e.state?.app) {
        // Reached bottom of our stack, re-push to prevent exit
        navPush();
        return;
      }
      // The shell's OWN dialog is the first layer (#317): a dialog is modal,
      // so a Back that peeled a page layer behind it would act on something
      // the reader cannot even see. Every other dialog in the app is peeled
      // by the page that owns it (Hub's backLayers, Projects/Sessions/Files'
      // goBack) — the one mechanism, one registration per host.
      if (addServer) { addServer = null; navPush(); return; }
      if (page === 'files' && filesGoBack && filesGoBack()) return;
      if (page === 'files' && jumpedFrom) { switchTab(jumpedFrom); return; }
      // Files with nothing to peel has climbed to /: fall through to the
      // re-push — the terminal is not below it (board #47).
      // Chat and Agents peel their own layers (menus, dialogs, drawer,
      // editor) exactly like Files peels its views — a back with nothing to
      // peel falls through to the re-push, so it never reads as the browser
      // navigating away (owner, 2026-08-24: "像是网页刷新了。像文件管理页面
      // 就很好"). The consumed pop re-pushes so the NEXT back has an entry
      // to spend no matter how many layers were peeled.
      if (page === 'hub' && hubGoBack && hubGoBack()) { navPush(); return; }
      if (page === 'agents' && agentsGoBack && agentsGoBack()) { navPush(); return; }
      if (page === 'board' && boardGoBack && boardGoBack()) { navPush(); return; }
      if (page === 'board' && jumpedFrom) { switchTab(jumpedFrom); return; }
      // Board with nothing to peel is like Hub: the drawer is its compact
      // floor (lifted by its own chain above), so a fall-through just
      // re-pushes — it never dumps the reader on the terminal (board #47).
      // A terminal JUMPED INTO from Chat returns there before the ordinary
      // terminal floor gets a chance to lift its drawer.
      if (page === 'terminal' && sessionsGoBack?.()) { navPush(); return; }
      if (page === 'terminal' && jumpedFrom) { switchTab(jumpedFrom); return; }
      // Compact Terminal has the same FLOOR semantics as Chat/Board (board
      // #58): a bare page lifts the session drawer. Once open, Back falls
      // through to the final re-push — it must never peel closed and then
      // re-open on the next gesture (an open/close cycle).
      if (page === 'terminal' && layout.isTouchDevice && narrowVp && !sessListOpen) {
        sessListOpen = true;
        navPush();
        return;
      }
      // Settings peels its open category back to the list first; only a
      // back with nothing to peel leaves the page.
      if (page === 'prefs' && prefsGoBack && prefsGoBack()) { return; }
      if (page === 'prefs') { page = pageBeforePrefs; slidePage('slide-in-left'); prefsPushed = false; return; }
      // At sessions root, re-push to prevent exit
      navPush();
    };
    window.addEventListener('popstate', handler);
    // Seed one entry
    navPush();
    return () => window.removeEventListener('popstate', handler);
  });
  // ── The rail's icon ORDER is the user's, and remembered ─────────────────
  // Press a rail icon and drag it up or down (owner, 2026-08-29: "在桌面版的左
  // 侧侧边栏 可以鼠标长按页面 icon 来调整上下顺序 这个顺序也会在客户端记录下
  // 来"). DESKTOP RAIL ONLY: the phone's bottom bar is thumb geography rather
  // than a preference, and press-and-drag is the gesture the terminal already
  // spends on scrolling. The rules that regress silently — what a saved order
  // may say, where a page a saved order never heard of goes, what a drop moves
  // — are pure functions in lib/app/nav-order.ts with their own tests.
  const RAIL_ITEMS = {
    hub:      { icon: 'chat',     label: 'hub' },
    terminal: { icon: 'terminal', label: 'terminal' },
    files:    { icon: 'files',    label: 'files' },
    board:    { icon: 'layout',   label: 'board' },
    agents:   { icon: 'bots',     label: 'agentsTitle' },
    prefs:    { icon: 'gear',     label: 'settings' },
  };
  let railOrder = $state(parseRailOrder(localStorage.getItem(RAIL_ORDER_KEY)));
  // The rail explains itself on a pointer (motion.md §1.16): the ONE hover
  // card shows a page's name and its shortcut, and the switcher's server with
  // its address and state. The native `title`s went with it — a second
  // tooltip beside the card is the thing the rule forbids. Getters, so the
  // card reads the CURRENT binding / server when it opens.
  const RAIL_SHORTCUT = { hub: 'goHub', board: 'goBoard', terminal: 'openTerminal', files: 'openFiles', agents: 'goAgents', prefs: 'goSettings' };
  function railInfo(slot) {
    const key = RAIL_SHORTCUT[slot] && shortcutsOn ? shortcuts.get(RAIL_SHORTCUT[slot]) : '';
    return { title: t(RAIL_ITEMS[slot].label), note: key ? shortcutLabel(key) : undefined };
  }
  // This computer's own server (board #323): what the desktop app found at
  // start — a reused gateway, its embedded server, or neither. It is about
  // THIS machine, not the connection, so its line is labelled as such and
  // reads the same whatever server is connected. `localServer` follows every
  // transition (the server_mode_changed event), and the hover card re-reads
  // this getter while it is shown, so an open card follows too.
  if (isTauriDesktop) localServer.start(tauriReady, () => window.__TAURI__);
  function serverCardInfo() {
    const local = localServerLine(localServer.mode, t);
    // Mid-switch the card describes the TARGET being reached (board 315): the
    // server we left is not connected any more, and saying so is the truth.
    if (switching) {
      const target = switching.target;
      return {
        title: target.name || hostLabel(target.address),
        lines: [
          { label: t('address'), value: target.address },
          switching.phase === 'connecting'
            ? { label: t('status'), value: t('connecting'), tone: 'warn' }
            : { label: t('status'), value: switching.error, tone: 'danger' },
        ],
      };
    }
    const key = shortcutsOn ? shortcuts.get('openServers') : '';
    return {
      title: serverName,
      note: key ? shortcutLabel(key) : undefined,
      lines: [
        // The title is the entry's name; a renamed server still says which
        // host it is (identity detail, board #319).
        ...(serverInfo.hostname && serverInfo.hostname !== serverName
          ? [{ label: t('hostname'), value: serverInfo.hostname }] : []),
        { label: t('address'), value: activeAddress },
        reconnecting
          ? { label: t('status'), value: t('reconnecting'), tone: 'warn' }
          : { label: t('status'), value: t('connected'), tone: 'ok' },
        ...(local ? [local] : []),
      ],
    };
  }
  // Only what is AVAILABLE is rendered, but the order keeps every page: hub /
  // board / agents need the server bus, and a page the bus turned off must come
  // back where the user put it rather than at the default position.
  let railSlots = $derived(visibleRailSlots(
    railOrder,
    (p) => (p === 'hub' || p === 'board' || p === 'agents' ? hubEligible : true),
  ));
  /** The live drag: null, or the carried slot plus the geometry snapshotted at
   *  drag start. Snapshotted because the carried icon moves by `transform`,
   *  which reflows nothing — re-measuring mid-drag could only add jitter. */
  let railDrag = $state(null);
  let railPress = null;        // pre-threshold bookkeeping; deliberately not reactive
  let railClickGuard = false;  // a drag must not ALSO switch pages on release

  function setRailOrder(next) {
    railOrder = next;
    const raw = railOrderToStore(next);
    if (raw) localStorage.setItem(RAIL_ORDER_KEY, raw);
    else localStorage.removeItem(RAIL_ORDER_KEY);
  }
  function railPointerDown(e, slot) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // Cleared on every fresh press, so a guard left behind by a drag whose
    // click never arrived cannot swallow the NEXT click.
    railClickGuard = false;
    railPress = { slot, y: e.clientY, el: e.currentTarget };
    // Captured at once so a fast drag off the 34px button keeps reporting here
    // instead of to whatever it passes over.
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function railPointerMove(e) {
    if (!railPress) return;
    const dy = e.clientY - railPress.y;
    if (!railDrag) {
      // A press that moves a few px is a CLICK — mouse jitter must not reorder
      // the rail, and switching pages is what the icon is for almost always.
      if (Math.abs(dy) < RAIL_DRAG_THRESHOLD) return;
      const nav = railPress.el.closest('.rail');
      if (!nav) return;
      railDrag = {
        slot: railPress.slot,
        dy,
        navTop: nav.getBoundingClientRect().top,
        rects: [...nav.querySelectorAll('[data-rail-slot]')].map((el) => {
          const r = el.getBoundingClientRect();
          return { slot: el.dataset.railSlot, top: r.top, bottom: r.bottom };
        }),
        idx: 0,
      };
    }
    railDrag.dy = dy;
    railDrag.idx = railDropIndex(railDrag.rects, e.clientY);
  }
  function railPointerUp() {
    if (railDrag) {
      // Committed with the SAME index the insertion line was drawn from, so
      // the icon can only land where the line said it would.
      setRailOrder(railDropAt(railOrder, railDrag.slot, railDrag.rects, railDrag.idx));
      railClickGuard = true;
    }
    railPress = null;
    railDrag = null;
  }
  /** Abandon a drag without reordering — and still swallow the click, because
   *  the pointer travelled: the user was dragging, not picking a page. */
  function railCancelDrag() {
    if (railDrag) railClickGuard = true;
    railPress = null;
    railDrag = null;
  }
  // A second click on the ACTIVE tab is not nothing: the page gets a
  // "reselect" — the Hub expands its collapsed project sidebar (owner,
  // 2026-09-14: "左侧的选项卡已经选中二次再点击的时候，也是自动帮我展开侧边栏"; board
  // #199). Pages register theirs the way they register their back chain.
  const pageReselect = {};
  // ONE primary-sidebar state for the whole shell (board #200, owner
  // 2026-09-14: "这个折叠收起在不同的页面是同步的，不然我点击chat terminal board，展开状态
  // 不一致"): the Hub's toggle writes appPrefs.sidebarCollapsed; the Terminal
  // page's and the Board's sidebars and the system-status bar follow it, and a
  // rail reselect on any of the three pages opens it again (#199).
  const shellSideCollapsed = $derived(shell && !layout.isTouchDevice && appPrefs.sidebarCollapsed);
  // Only three pages HAVE the primary sidebar; the toggle and the page-head
  // room it takes exist there alone (board #219, owner 2026-09-20: "files页面里，
  // 多显示了折叠左侧边栏的按钮，还有设置这些页面也都没兼容好"). The collapsed state
  // itself stays app-wide (#200) so the hidden Terminal/Board tracks keep
  // their rest position while another page is on screen.
  const SIDEBAR_PAGES = new Set(['hub', 'terminal', 'board']);
  const pageHasSidebar = $derived(SIDEBAR_PAGES.has(page));
  // A reselect TOGGLES (owner, 2026-09-14: "选中点击也能展开，也能折叠"; board #201).
  pageReselect.terminal = pageReselect.board = () => appPrefs.setSidebarCollapsed(!appPrefs.sidebarCollapsed);
  // The Terminal page moves its track the way the Hub does (reveal.ts): the
  // sidebar pinned at its width, the factor moving, xterm fitted once at rest.
  let termPageEl = $state(null);
  let termSideWasCollapsed = untrack(() => shellSideCollapsed); // the rest state at mount; the effect moves from it
  $effect(() => {
    const collapsed = shellSideCollapsed;
    if (collapsed === termSideWasCollapsed) return;
    termSideWasCollapsed = collapsed;
    if (page !== 'terminal' || !termPageEl || !termSideEl) return;
    const unpin = pinTrack(termSideEl, 'end');
    void moveTrack(termPageEl, '--side-open', collapsed ? 1 : 0).then(unpin);
  });
  // The rail's toggle and a reselect are the same act: the page's delegate
  // if it has one (the Hub animates with its reading anchor), else the shared
  // state directly.
  function toggleShellSidebar() {
    (pageReselect[page] ?? (() => appPrefs.setSidebarCollapsed(!appPrefs.sidebarCollapsed)))();
  }
  function railActivate(slot) {
    if (railClickGuard) { railClickGuard = false; return; }
    if (slot === 'prefs') togglePrefs();
    else if (slot === page) { pageReselect[slot]?.(); return; }
    else switchTab(slot);
  }
  // Escape abandons a drag and a resize invalidates its snapshotted rects —
  // the same dismissal contract every transient layer here follows. The
  // window-level pointerup is a safety net: if the captured button stops
  // existing mid-drag (the bus dropping hides three icons), the nav never sees
  // the release and a carried icon would be stranded on screen.
  $effect(() => {
    if (!railDrag) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); railCancelDrag(); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', railCancelDrag);
    window.addEventListener('pointerup', railPointerUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', railCancelDrag);
      window.removeEventListener('pointerup', railPointerUp, true);
    };
  });

  // Swipe left/right to switch tabs with slide animation
  const tabs = $derived(() => {
    // On DESKTOP the rail IS the order, so keyboard previous/next page follows
    // the icons the user arranged rather than a second, hidden sequence. The
    // gap is not a page and the gear is not a cycle stop (it toggles).
    if (!layout.isTouchDevice) return railSlots.filter((s) => s !== RAIL_GAP && s !== 'prefs');
    // Same order as the tab bar: files sits LEFT of the agent
    // config (owner, 2026-08-28: "手机下边的栏文件放到agent配置左侧吧").
    // Agents is NOT a stop here: on touch it is a Settings category, and a
    // swipe that reaches a page with no icon is a page you cannot get back to.
    // Owner-set order (2026-08-29): chat, board, files, terminal — settings
    // stays the row's last, non-cycling stop.
    const t = [];
    if (hubEligible) t.push('hub');
    if (hubEligible) t.push('board');
    t.push('files');
    t.push('terminal');
    return t;
  });

  // The session list is Terminal's sidebar, not a page of its own (owner,
  // 2026-08-18: "sessions 页面差不多相当于 terminal 的侧边栏"). On a wide
  // screen it is a column; on a phone it slides over the terminal, because
  // the terminal wants the whole screen there.
  let sessListOpen = $state(false);
  let termSideEl = $state(null);
  // The empty state's "Sessions" action — the ONE way it reaches the list.
  // On a touch layout it lifts the drawer (sessListOpen), like the switcher's
  // hamburger. On the desktop the list is already the left column, so "open"
  // means hand it keyboard focus: the first row of the list, or the create
  // row when nothing is listed yet. Before this the button only set
  // `sessListOpen`, which no desktop rule reads, and did nothing (review,
  // 2026-09-03). The SideHandle is skipped on purpose — it is a separator,
  // not the list.
  function openSessionsList() {
    if (layout.isTouchDevice) { sessListOpen = true; return; }
    termSideEl?.querySelector('.sessions .content [tabindex="0"], .sessions .content button')?.focus();
  }
  // The Terminal sheet's own condition (touch AND ≤760px — the old media
  // gate, now expressed where the class is applied; see app.css .side-sheet).
  let narrowVp = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const fn = () => { narrowVp = mq.matches; };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  });
  let slideAnim = $state('');

  function switchTab(target) {
    if (slideAnim) return;
    const t = tabs();
    const curName = page;
    if (target === curName) return;
    jumpedFrom = null; // deliberate navigation stands the return slot down
    const fromIdx = t.indexOf(curName);
    const toIdx = t.indexOf(target);
    // Apply page change immediately
    page = target;
    navPush();
    // Single slide-in animation from the correct direction — TOUCH LAYOUTS
    // ONLY. It is the visual half of the swipe gesture: content follows the
    // finger, so the direction means something. On a desktop the tabs are a
    // rail of buttons with no horizontal motion behind them, and pages slid
    // sideways for no reason (owner report) — worse on the wide three-column
    // pages, where a whole workspace lurches.
    if (fromIdx >= 0 && toIdx >= 0) slidePage(toIdx > fromIdx ? 'slide-in-right' : 'slide-in-left');
  }

  /** The one page-slide trigger (touch only): every page-level navigation —
   * tab switches, entering/leaving Settings — speaks the same 120ms grammar:
   * deeper/rightward enters from the right, back/leftward from the left. */
  function slidePage(dir) {
    if (!layout.isTouchDevice || slideAnim) return;
    slideAnim = dir;
    requestAnimationFrame(() => {
      setTimeout(() => { slideAnim = ''; }, SLIDE_ANIMATION_MS);
    });
  }

  // Keyboard shortcuts (board 316): ONE registry (shortcuts.ts) declares every
  // action; this host is the only thing App adds — the primitives the actions
  // call and what they need to know. The gate is the desktop form factor (the
  // touch layout has no shortcuts), not the Tauri shell.
  let railServerEl = $state(null);
  const shortcutHost = {
    get connected() { return connected && !switching; },
    get hub() { return hubEligible; },
    get page() { return page; },
    get terminalTarget() { return !!terminalTarget; },
    get servers() { return loadServers(localStorage).length; },
    get splitEligible() { return splitEligible; },
    get sidebarPage() { return pageHasSidebar; },
    goTo(target) {
      if (target === 'prefs') { if (page !== 'prefs') togglePrefs(); return; }
      if (target === 'agents' && agentsLivesInSettings(layout.isTouchDevice)) { openAgentsConfig(); return; }
      switchTab(target);
    },
    cyclePage(direction) {
      const available = tabs();
      if (!available.includes(page)) return;
      switchTab(cycleItem(available, page, direction));
    },
    cycleServer(direction) {
      const list = loadServers(localStorage);
      const next = cycleItem(list.map((x) => x.id), serverCurId, direction);
      if (next && next !== serverCurId) doServerSwitch(next);
    },
    openServers() { if (railServerEl && !serverMenuOpen) toggleServerMenu({ currentTarget: railServerEl }); },
    toggleSidebar() { toggleShellSidebar(); },
    toggleSplit() {
      if (page !== 'terminal') switchTab('terminal');
      setLayout(splitLayout > 1 ? 1 : 2);
    },
    async focusComposer() {
      if (page !== 'hub') { switchTab('hub'); await tick(); }
      document.querySelector('.page-layer:not(.hidden) .c-input')?.focus();
    },
    async focusTerminal() {
      if (page !== 'terminal') { switchTab('terminal'); await tick(); }
      // The ACTIVE pane (board 316 review): in split screen the active cell,
      // never the first terminal on the page; an empty active cell takes no
      // input at all rather than handing it to another cell.
      terminalFocusTarget(termPageEl, splitActive ? activeCellId : null)?.focus();
    },
    cycleWindow(direction) {
      window.dispatchEvent(new CustomEvent('terminal-window-shortcut', { detail: { direction } }));
    },
    toggleScratch() { scratchOpen = !scratchOpen; },
  };
  const shortcutsOn = $derived(!layout.isTouchDevice);
  $effect(() => {
    if (!shortcutsOn) return;
    const onShortcut = (event) => {
      if (isShortcutInputTarget(event.target)) return;
      if (activeModal(document)) return;
      // Parse → binding → need → run (shortcuts.ts); an unavailable key and
      // character input (IME, AltGr) stay the page's.
      dispatchShortcut(event, shortcuts.action, shortcutHost);
    };
    window.addEventListener('keydown', onShortcut, { capture: true });
    return () => window.removeEventListener('keydown', onShortcut, { capture: true });
  });
</script>

<main class:with-rail={shell && !layout.isTouchDevice} class:touch-layout={shell && layout.isTouchDevice} class:side-collapsed={shellSideCollapsed} class:side-page={pageHasSidebar} class:immersive={filesImmersive && page === 'files'}>
  <!-- Shell chrome. Every nav item is in the Tab order (no tabindex="-1" —
       review, 2026-09-03: the whole nav was unreachable by keyboard) and wears
       the global button:focus-visible ring; the current page is aria-current.
       Three shapes, one per context (docs/design-docs/features/app-shell.md):
       · connected desktop  → a left icon RAIL (the whole top bar is gone —
         vertical space goes to the terminal, switching is one always-visible click)
       · connected mobile   → a bottom TAB BAR in thumb reach, hidden while the
         keyboard is up (html.keyboard-open) so immersive typing costs nothing
       · disconnected       → the top brand bar with the gear (both platforms) -->
  {#if !shell}
    <nav class="topbar">
      <div class="brand">
        <img class="logo" src={iconSrc} alt="" width="24" height="24" />
        <span class="brand-text">tmux<span class="brand-accent">mobile</span></span>
      </div>
      <div class="nav-right">
        <button class="gear-btn" class:active={page === 'prefs'} aria-label={t('settings')} use:hoverInfo={() => ({ title: t('settings') })} onclick={togglePrefs}><span class="tab-glyph" class:on={page === 'prefs'}><Icon name="gear" size={16} /></span></button>
      </div>
    </nav>
  {:else if !layout.isTouchDevice}
    <!-- The icons are the USER's order (railOrder → nav-order.ts), so this is a
         list rather than six hardcoded buttons. The brand is not part of it: it
         is the app's mark, not a page. The gap between the two shipped groups —
         where you WORK above, where you CONFIGURE below (owner, 2026-08-19) —
         is a MEMBER of the order, so it moves as icons move around it and a
         drag across it is an ordinary drop instead of a silent refusal. -->
    <nav
      class="rail"
      inert={switching?.phase === 'connecting'}
      class:reordering={!!railDrag}
      onpointermove={railPointerMove}
      onpointerup={railPointerUp}
      onpointercancel={railCancelDrag}
      use:slideIndicator={{ key: page, active: '.rail-btn.active', hidden: !!railDrag }}
    >
      <!-- The ONE travelling highlight (motion.md §1.14): the accent wash
           behind the active icon glides to the next one (no bar — owner,
           2026-09-04). Measured by layout offsets, so the .rail-slot wrapper
           and a mid-flip transform do not enter; collapsed while an icon is
           being dragged and re-placed on release. -->
      <span class="slide-pill soft" aria-hidden="true"></span>
      <img class="rail-brand" src={iconSrc} alt="" width="26" height="26" draggable="false" />
      {#each railSlots as slot (slot)}
        <!-- One wrapper per slot so the list can `animate:flip` (Svelte wants
             the animated element to be the each block's only child). It also
             CARRIES the dragged icon: the inline transform follows the pointer
             with no transition (motion.md §1.7), and on release the flip
             measures from that translated rect, so the icon settles from
             under the finger into its new slot instead of jumping back first. -->
        <div
          class="rail-slot"
          class:rail-gap={slot === RAIL_GAP}
          class:lifted={railDrag?.slot === slot}
          style:transform={railDrag?.slot === slot ? `translateY(${railDrag.dy}px)` : null}
          animate:flip={{ duration: moveMs() }}
        >
        {#if slot === RAIL_GAP}
          <div class="rail-spacer" data-rail-slot={slot}></div>
          <!-- The notification centre (board #322): above the server switcher,
               a CONTROL like it. The badge counts unviewed alerts, static
               accent ink — the unread language, never red. -->
          {#if centreShown}
            <button
              class="rail-btn rail-bell"
              class:open={!!centre.anchor}
              aria-label={centre.unviewed ? `${t('notifyCentre')} · ${t('hubUnreadCount').replace('{n}', String(centre.unviewed))}` : t('notifyCentre')}
              use:hoverInfo={() => ({ title: t('notifyCentre') })}
              aria-haspopup="dialog"
              aria-expanded={!!centre.anchor}
              onclick={(e) => centre.toggle(e.currentTarget)}
            ><Icon name="bell" size={17} />{#if centre.unviewed}<span class="bell-badge">{centre.unviewed > 99 ? '99+' : centre.unviewed}</span>{/if}</button>
          {/if}
          <!-- Server switcher (board #55): "右下角agent上边" — glued to the top
               of the rail's bottom (configure) group, above the agents icon in
               the shipped order. A CONTROL, not a page: never draggable, never
               active, opens the registry popover. The 180°-symmetric swap
               glyph turns 90° while open, so the state change is visible
               (trigger side only — the menu itself does not animate). -->
          <button
            class="rail-btn rail-server"
            bind:this={railServerEl}
            class:open={serverMenuOpen}
            aria-label={t('serversTitle')}
            use:hoverInfo={serverCardInfo}
            aria-haspopup="dialog"
            aria-expanded={serverMenuOpen}
            aria-controls={serverMenuOpen ? serverPickerId : undefined}
            onclick={(e) => toggleServerMenu(e)}
          ><span class="quarter-turn" class:on={serverMenuOpen}><Icon name="swap-h" size={17} /></span></button>
        {:else}
          <button
            class="rail-btn"
            class:active={page === slot}
            class:dragging={railDrag?.slot === slot}
            data-rail-slot={slot}
            aria-label={t(RAIL_ITEMS[slot].label)}
            use:hoverInfo={() => railInfo(slot)}
            aria-current={page === slot ? 'page' : undefined}
            disabled={!!switching}
            onpointerdown={(e) => railPointerDown(e, slot)}
            onclick={() => railActivate(slot)}
          ><span class="tab-glyph" class:on={page === slot}><Icon name={RAIL_ITEMS[slot].icon} size={17} /></span></button>
        {/if}
        </div>
      {/each}
      {#if railDrag}
        <div
          class="rail-drop appear"
          style:top="{(railDropOffset(railDrag.rects, railDrag.idx) ?? railDrag.navTop) - railDrag.navTop}px"
          aria-hidden="true"
        ></div>
      {/if}
    </nav>
    <!-- THE sidebar toggle (board #217, owner 2026-09-20: "折叠按钮放到侧边栏上吧，
         类似这个设计我觉得挺好的" with two reference frames): ONE shell-level node
         standing at the top-LEFT of the content area, fixed — open, it is the
         first thing in the sidebar's head row; collapsed, the same square at
         the same screen point, over the page head (or the terminal). It never
         moves because the sidebar collapses from the RIGHT with its content
         pinned left — the #197 ride that slid ~190px away from the pointer
         is exactly what a left-edge seat avoids. Its click is the page's own
         reselect delegate (#199/#201): the Hub keeps its reading anchor,
         Terminal/Board their reveal effects (#200). The heads make room for
         it through `.side-toggle-row` / `.page-head` (app.css). -->
    {#if pageHasSidebar && !switching}
      <div class="shell-side-toggle">
        <CommandButton variant="secondary" iconOnly icon="panel-left" expanded={!appPrefs.sidebarCollapsed} inside
          label={appPrefs.sidebarCollapsed ? t('hubSidebarExpand') : t('hubSidebarCollapse')}
          onclick={toggleShellSidebar} />
      </div>
    {/if}
  {/if}

  <!-- Server system vitals (board #85): ONE shell-level instance. Desktop
       keeps it in the primary sidebar; on touch it is hidden until a shared
       side-sheet opens, then occupies the same drawer width and its reserved
       bottom space. No copy per page, no second poll timer. -->
  {#if sysMounted}
    <!-- The system status bar also carries the scratch terminal's toggle
         (board #326, owner 2026-10-09: "可以把它放到我们的系统状态栏里 我们不是
         有一个系统状态栏嘛 在旁边可以画一个小选项 用来打开快捷 terminal"). In
         the rail it read as a second Terminal PAGE icon, a page it is not;
         beside the readings it reads as what it is — a small thing the server
         offers. It retracts with the bar when the sidebar collapses (#200),
         and the `toggleScratch` shortcut is the door that is always open. -->
    <!-- `compact-tools` is the existing dense-group token setter (app.css):
         its 20px paint square needs the 5px corner, because the 7px command
         corner reads as a circle there (#219) and `--control-radius` 12 on a
         20px square IS one — which is the bug #337 reported. It sets only
         custom properties, and the bar's own geometry is declared on `main`,
         so nothing else moves. -->
    <aside class="sys-sidebar compact-tools" aria-label="Server system status">
      <SystemStatus load={systemStatus} visible={connected} />
      {#if !layout.isTouchDevice}
        <button
          class="sys-scratch"
          class:open={scratchOpen}
          aria-label={t('scratchTitle')}
          aria-pressed={scratchOpen}
          use:hoverInfo={() => { const key = shortcutsOn ? shortcuts.get('toggleScratch') : ''; return { title: t('scratchTitle'), note: key ? shortcutLabel(key) : undefined }; }}
          onclick={() => (scratchOpen = !scratchOpen)}
        ><Icon name="terminal" size={14} /></button>
      {/if}
    </aside>
  {/if}

  {#if serverMenuOpen}
    <!-- Inline editing makes this a non-modal picker, not an action menu. -->
    <div class="server-menu menu-surface menu-list pop-layer" class:ready={serverMenuH > 0}
      role="dialog" aria-modal="false" aria-label={t('serversTitle')} tabindex="-1" id={serverPickerId}
      style:left="{serverMenuPos.x}px" style:top="{serverMenuPos.y}px"
      style:--pop-maxw="{serverMenuPos.maxW}px" style:--pop-maxh="{serverMenuPos.maxH}px"
      style:--pop-origin={serverMenuAnchor ? popOrigin(serverMenuAnchor, serverMenuPos, 'right', serverMenuSide) : undefined}
      bind:this={serverMenuEl} bind:offsetWidth={serverMenuW} bind:offsetHeight={serverMenuH}>
      <div class="menu-heading">{t('serversTitle')}</div>
      <ServerList bind:this={serverListEl} servers={serverList} currentId={serverCurId} link={serverLink} container={serverMenuEl}
        onpick={(id) => { serverMenuOpen = false; doServerSwitch(id); }}
        onrename={serverRename} onremove={serverRemove}
        onadd={serverAddRow} onclose={() => (serverMenuOpen = false)} />
    </div>
  {/if}

  {#if centre.anchor}
    <div class="centre-menu menu-surface menu-list pop-layer" class:ready={centreH > 0}
      role="dialog" aria-modal="false" aria-label={t('notifyCentre')} tabindex="-1"
      style:left="{centrePos.x}px" style:top="{centrePos.y}px"
      style:--pop-maxw="{centrePos.maxW}px" style:--pop-maxh="{centrePos.maxH}px"
      style:--pop-origin={centrePlace?.origin}
      bind:this={centreEl} bind:offsetWidth={centreW} bind:offsetHeight={centreH}>
      <NotifyCentre {centre} onpick={(a) => { centre.close(); centre.requestJump(a); if (page !== 'hub') switchTab('hub'); }} />
    </div>
  {/if}

  {#snippet savedServers()}
    <!-- Settings › Connection: the same ServerList as the popover (board 315). -->
    <ServerList variant="page" servers={serverList} currentId={serverCurId} link={serverLink}
      onpick={doServerSwitch} onrename={serverRename} onremove={serverRemove} onadd={serverAddRow} />
  {/snippet}

  {#if addServer}
    <AddServerDialog initial={addServer.initial} compact={narrowVp}
      onsubmit={submitAddServer} oncancel={() => (addServer = null)} />
  {/if}

  {#if reconnecting && page !== 'settings'}
    <div class="reconnect-bar appear">
      <span class="reconnect-spinner"></span>
      <span>{t('reconnecting')}{#if reconnectAttempt} ({reconnectAttempt}/{RECONNECT_MAX_ATTEMPTS}{#if reconnectClass} · {reconnectClass}{/if}){/if}</span>
      <button class="reconnect-cancel" onclick={cancelReconnect}>{t('cancel')}</button>
    </div>
  {/if}

  <div class="page {slideAnim}" class:page-terminal={page === 'terminal'}>
    {#if switching}
      <!-- The switch panel (board 315): in the content area, inside the kept
           shell. Connecting names the target with the running cue; a failure
           says what happened and offers the three ways on — never the
           connect page, never a blank screen. -->
      <div class="switch-panel appear" role="status" aria-live="polite">
        {#if switching.phase === 'connecting'}
          <span class="reconnect-spinner" aria-hidden="true"></span>
          <strong class="switch-name">{t('serverSwitching').replace('{name}', switching.target.name || hostLabel(switching.target.address))}</strong>
          <span class="switch-addr">{switching.target.address}</span>
        {:else}
          <Icon name="info" size={22} />
          <strong class="switch-name">{t('serverSwitchFailed').replace('{name}', switching.target.name || hostLabel(switching.target.address))}</strong>
          <span class="switch-addr">{switching.target.address}</span>
          <p class="config-error" role="alert">{switching.error}</p>
          <div class="switch-actions">
            <CommandButton label={t('configRetry')} icon="refresh" variant="primary" onclick={switchRetry} />
            {#if switching.from}<CommandButton label={t('serverSwitchBack').replace('{name}', switching.from.name)} icon="arrow-left" onclick={switchBack} />{/if}
            <CommandButton label={t('serverSwitchEdit')} icon="edit" onclick={() => openAddServer(switching.target)} />
            <CommandButton label={t('serverSwitchOther')} icon="swap-h" expanded={serverMenuOpen}
              onclick={(e) => toggleServerMenu(e)} />
          </div>
        {/if}
      </div>
    {:else}
    <!-- The person-level surface. The Connection card needs no server — a
         fresh client has none to give it, and a dangling CURRENT leaves none
         either — so it lives OUTSIDE the server-bound subtree. That is also
         what lets the subtree render nothing at all while it has no runtime
         (board #335 ②b-1, reviewer P1-b). -->
    <!-- Held, like Preferences below, while a leave walk shows another page:
         the walk may have been started BY this form, and its accept has to
         come back to the attempt that asked (reviewer P1-b on 48b40082). -->
    {#if page === 'settings' || holdPages}
    <div class="page-layer connect-layer" class:hidden={page !== 'settings'}>
      <Settings {onConnected} beforeConnect={suspendScope} confirmLeave={confirmFormLeave} notice={reconnectError}
        frozen={migrationBlocked ? t('migrationBlockedNote') : ''} onRetry={retryMigration} />
    </div>
    {/if}
    <!-- Preferences is the PERSON's surface — theme, fonts, zoom, language,
         shortcuts, notification switches — so it must open with or without a
         server: the gear is reachable whenever the shell is, including with no
         runtime at all, and inside the server-bound subtree it would have
         rendered a blank page there (reviewer, 2026-10-10). Its one
         server-bound guest, the Agents editor on touch, is already gated on a
         live server through `showAgents`; b3-3 gives that guest a scope of its
         own. -->
    {#if page === 'prefs' || holdPages}
    <div class="page-layer" class:hidden={page !== 'prefs'}>
    <Preferences {connected} {theme} {fontSize} {serverInfo} {activeAddress} {pendingAddress} addresses={prefAddresses}
      {savedServers}
      {serverName} onServers={connected && layout.isTouchDevice ? toggleServerMenu : null} serversOpen={serverMenuOpen} serversControls={serverPickerId}
      {optimizing} {linkCopied}
      onClose={togglePrefs}
      onTheme={setTheme}
      {uiZoom} showUiZoom={true} showShortcuts={shortcutsOn} {shortcutHost} onUiZoom={setUiZoom}
      onFontSize={setFontSize}
      onOptimize={optimizeConnection}
      onShare={shareConnectionLink}
      onGoBack={(fn) => prefsGoBack = fn}
      onDrill={() => navPush()}
      showAgents={hubEligible && agentsLivesInSettings(layout.isTouchDevice)}
      agentsEditRequest={landingFor(agentsEditReq)}
      openRequest={prefsOpenReq}
      onAddress={(address) => {
        if (migrationBlocked) return;  // nothing moves the socket while it is blocked
        localStorage.setItem('tmux_address', address);
        activeAddress = address;
        pendingAddress = address;
        // A typed address is a NEW intent: end any running reconnect loop
        // before the direct connect, or its next attempt races this socket
        // and the loser's timeout marks a reachable address unreachable.
        // The switch module owns the socket (board 315): a server switch that
        // starts meanwhile makes this attempt stale, and a stale one neither
        // publishes nor restarts the reconnect loop.
        heldOffline = false;           // the person picked an address
        void serverSwitch.connectAddress(address, localStorage.getItem('tmux_token') || '')
          .finally(() => { if (pendingAddress === address) pendingAddress = ''; });
      }}
      onDisconnect={() => { page = 'settings'; doDisconnect(); }}
      onAddressesChange={(next) => {
        saveMachineAddresses(localStorage, serverInfo.machineId, next);
        addrSetVersion++;
      }}
      onConnectionSetup={() => { page = 'settings'; }} />
    </div>
    {/if}
    <!-- Keyed by the server's RUNTIME HANDLE (board #335 ②b-1, board 315): a
         different server is a different handle, so every server-bound
         component is rebuilt from scratch — no component state, listener or
         subscription of the old server survives into the new tree — while a
         reconnect inside one runtime keeps the handle and remounts nothing.
         `ServerScope` binds the subtree to that handle and renders NOTHING
         without one; the order (teardown, release, mount) is
         server-scope.ts's, because `{#key}` creates the new branch before
         destroying the old one. -->
    {#if migrationBlocked && page !== 'settings' && page !== 'prefs'}
      <!-- The fold could not be recorded (board #335 ②b-4): no server page,
           the switch panel's own form, and Retry. -->
      <div class="switch-panel appear" role="alert">
        <Icon name="info" size={22} />
        <strong class="switch-name">{t('migrationBlocked')}</strong>
        <p class="config-error">{t('migrationBlockedNote')}</p>
        <div class="switch-actions">
          <CommandButton label={t('configRetry')} icon="refresh" variant="primary" onclick={retryMigration} />
        </div>
      </div>
    {/if}
    {#key scopeRuntime}
    <ServerScope runtime={scopeRuntime} state={serverStates.get(scopeRuntime)}>
    {#if hubEligible}
      <!-- Hub (agents-v2 desktop three-column view): kept mounted (like
           Files/Terminal below) and merely hidden when inactive, so the
           selected project, chat scroll, and embedded terminal survive tab
           switches. Desktop-eligible only (needs width + the desktop server):
           mobile keeps the tab layout untouched. -->
      <div class="page-layer" class:hidden={page !== 'hub'}>
        <Hub visible={page === 'hub'} {fontSize} mobile={layout.isTouchDevice} openTerminal={(s, tgt) => openTerminal(s, tgt)} onSelectSession={(s) => { if (s) showSession(s); }} onGoBack={(fn) => hubGoBack = fn} onReselect={(fn) => { pageReselect.hub = fn; }} openAgentConfig={(name, kind) => openAgentsConfig(name, kind)} openFilesTab={(s, path, file) => { if (s) showSession(s); if (path || file) filesNavReq = { serverId: navServerId(), path, file, n: (filesNavReq?.n ?? 0) + 1 }; switchTab('files'); jumpedFrom = 'hub'; }} openBoardTab={(s, issue) => { if (s) showSession(s); if (issue) boardIssueReq = { serverId: navServerId(), session: s, id: issue, n: (boardIssueReq?.n ?? 0) + 1 }; switchTab('board'); jumpedFrom = 'hub'; }} />
      </div>
    {/if}
    <!-- The Agents PAGE exists where Agents is a page: the desktop rail. On
         touch the only instance is the one Settings embeds, so this layer is not
         mounted there — two live copies would both load and both claim a back
         chain. -->
    {#if hubEligible && !agentsLivesInSettings(layout.isTouchDevice)}
      <div class="page-layer" class:hidden={page !== 'agents'}>
        <AgentsPage visible={page === 'agents'} guardPage="agents" onGoBack={(fn) => agentsGoBack = fn} editRequest={landingFor(agentsEditReq)} />
      </div>
    {/if}
    <div class="page-layer" class:hidden={page !== 'files'}>
      <Files session={filesSession} guardPage="files" visible={page === 'files'} {fontSize} onGoBack={(fn) => filesGoBack = fn} onimmersive={(on) => filesImmersive = on} navRequest={landingFor(filesNavReq)} jumped={!!jumpedFrom} />
    </div>
    <div class="page-layer" class:hidden={page !== 'board'}>
      {#if hubEligible}
        <Board session={filesSession} guardPage="board" visible={page === 'board'} sideCollapsed={shellSideCollapsed} onGoBack={(fn) => boardGoBack = fn} issueRequest={landingFor(boardIssueReq)} jumped={!!jumpedFrom} />
      {/if}
    </div>
    <div class="page-layer term-page" class:hidden={page !== 'terminal'} bind:this={termPageEl}>
      <!-- The session/window list: a column beside the terminal on a wide
           screen, a slide-over sheet on a phone (opened from the switcher's
           session tag). Kept MOUNTED so its polling and expansion state
           survive; `visible` pauses the poll while the page is hidden. -->
      <aside class="term-side" class:side-sheet={layout.isTouchDevice && narrowVp} class:sheet={layout.isTouchDevice} class:open={layout.isTouchDevice && narrowVp && sessListOpen} bind:this={termSideEl}>
        {#if !layout.isTouchDevice}<SideHandle />{/if}
        <Sessions {openTerminal} activeTarget={terminalTarget}
          onGoBack={(fn) => sessionsGoBack = fn}
          visible={page === 'terminal' && (!layout.isTouchDevice || sessListOpen)}
          onPick={() => sessListOpen = false}
          chips={false} />
      </aside>
      {#if layout.isTouchDevice && sessListOpen}
        <button class="side-scrim" aria-label={t('close')} onclick={() => sessListOpen = false}></button>
      {/if}
      <div class="term-main">
      {#if terminalTarget}
        <div class="terminal-body" class:split-capable={splitEligible}>
          {#if splitActive}
            <!-- In split mode the layout control floats top-right (no single
                 win-bar to host it; cells have their own headers). In single-
                 pane mode the control lives in the Terminal's chip bar. -->
            <div class="split-control">
              <button class="split-toggle state-ctl" class:on={splitActive} aria-label={t('split')} use:hoverInfo={() => ({ title: t('split') })}
                aria-haspopup="menu" aria-expanded={!!splitMenuAt} onclick={toggleSplitMenu}>
                <Icon name="layout" size={15} />
              </button>
              <ContextMenu at={splitMenuAt} items={splitMenuItems} oncancel={() => (splitMenuAt = null)} />
            </div>
          {/if}
          {#if splitActive}
            <SplitView cells={splitViewCells} layout={splitLayout} {activeCellId} {fontSize}
              visible={page === 'terminal'}
              onActivate={(id) => activeCellId = id}
              onAssign={assignCell}
              onCloseCell={closeCell}
              onPaneExit={cellPaneExit} />
          {:else}
            <Terminal target={terminalTarget} session={terminalSession} {fontSize}
              visible={page === 'terminal'}
              splitEligible={splitEligible} {splitActive} {splitLayout} onSetLayout={setLayout}
              onOpenSessions={layout.isTouchDevice ? () => sessListOpen = true : null}
              onSwitchPane={(t) => showPane('', t)} onPaneExit={paneExitFallback} />
          {/if}
        </div>
      {:else}
        <!-- No pane selected. The HEADER still renders: every other page keeps
             its `.page-head` when its detail pane is empty (Chat, Agents,
             Settings), and dropping it here made the Terminal tab look like a
             different app the moment nothing was open (owner, 2026-08-19). -->
        <div class="page-head">
          <h1>{t('terminal')}</h1>
        </div>
        <div class="terminal-empty">
          <Icon name="terminal" size={22} />
          <span>{t('noTerminalSelected')}</span>
          <button class="chip-btn" onclick={openSessionsList}>
            <Icon name="sessions" size={14} />{t('sessions')}
          </button>
        </div>
      {/if}
      </div>
    </div>
    {#if !layout.isTouchDevice && connected}
      <ScratchPanel open={scratchOpen} live={!switching} edge={scratchEdge} {fontSize}
        onclose={() => (scratchOpen = false)} onedge={setScratchEdge} />
    {/if}
    </ServerScope>
    {/key}
    {/if}
  </div>

  <InstallPrompt />
  <HoverCard />
  {#if shell && layout.isTouchDevice}
    <nav class="tabbar" inert={!!switching}>
      <!-- Foreground-only selection (owner, 2026-09-05: "保持没有背景色，只有
           前景色的一个高亮样式…没有选中灰色 选中后前景有颜色" — the WeChat/
           Alipay dialect): the 2026-09-04 travelling wash is retired here —
           it read as a smudge on the phone and its first paint differed from
           the post-tap state. The buttons' ink cross-fade IS the state; the
           desktop rail keeps its travelling wash (motion.md §1.14). -->
      {#if hubEligible}
        <button class:active={page === 'hub'} aria-current={page === 'hub' ? 'page' : undefined} onclick={() => switchTab('hub')}>
          <span class="tab-glyph" class:on={page === 'hub'}><Icon name="chat" size={19} />{#if centre.unviewed}<span class="unread-dot tab-badge" aria-hidden="true"></span>{/if}</span><span>{t('hub')}</span>
        </button>
        <button class:active={page === 'board'} aria-current={page === 'board' ? 'page' : undefined} onclick={() => switchTab('board')}>
          <span class="tab-glyph" class:on={page === 'board'}><Icon name="layout" size={19} /></span><span>{t('board')}</span>
        </button>
      {/if}
      <button class:active={page === 'files'} aria-current={page === 'files' ? 'page' : undefined} onclick={() => switchTab('files')}>
        <span class="tab-glyph" class:on={page === 'files'}><Icon name="files" size={19} /></span><span>{t('files')}</span>
      </button>
      <button class:active={page === 'terminal'} aria-current={page === 'terminal' ? 'page' : undefined} onclick={() => switchTab('terminal')}>
        <span class="tab-glyph" class:on={page === 'terminal'}><Icon name="terminal" size={19} /></span><span>{t('terminal')}</span>
      </button>
      <!-- No Agents icon here: on a phone the agent configuration is a CATEGORY
           OF SETTINGS (nav-state's agentsLivesInSettings), because this row had
           one tab too many (owner, 2026-08-29: "不用单独在底下一行展示了，现在
           看着有点多底下的标签"). The desktop rail keeps it as a page. -->
      <button class:active={page === 'prefs'} aria-current={page === 'prefs' ? 'page' : undefined} onclick={togglePrefs}>
        <span class="tab-glyph" class:on={page === 'prefs'}><Icon name="gear" size={19} /></span><span>{t('settings')}</span>
      </button>
    </nav>
  {/if}

</main>

<style>
  main, nav { transition: background-color 0.3s ease, color 0.3s ease; }

  main {
    /* The status bar's height and the room its control needs inside it
       (#326) are ONE pair: every sidebar reserves this height as bottom
       padding, so a bar that grew past the reservation would cover the last
       row, and the bar clips its own content. A mouse gets a 20px target
       inside the unchanged 24px bar (the readings are one line of --fs-micro,
       so the bar's vertical padding gives way, not its height).
       Both numbers are FIXED, on every pointer type (owner, 2026-10-10:
       "现在把那一栏整体撑得特别高，不是我想要的，需要维持得小一点"). #326 let
       a coarse pointer take the control to --control-height and grew the bar
       with it, which turned the 24px strip into 48px — measured — on any
       machine whose pointer merely REPORTS coarse while a mouse is what is
       being used. The DESKTOP layout therefore keeps the compact strip the
       owner asked for, and a coarse pointer gets a bigger HIT AREA instead,
       bounded by the bar (.sys-scratch::after).
       A deliberate size trade-off, not a proof that nobody taps: the control
       hangs off `!layout.isTouchDevice`, which is an overridable LAYOUT
       choice (layout.svelte.ts), so a touch user who forces Desktop reads
       false here and gets the 20px paint with the wider hit box. */
    --sys-ctl: 20px;
    --sys-sidebar-h: 24px;
    display: flex;
    flex-direction: column;
    height: calc(var(--app-height, 100dvh) / var(--ui-zoom, 1));
    max-width: calc(100vw / var(--ui-zoom, 1));
    /* The shell reserves the top inset ONCE, for every screen. Android draws
       edge-to-edge (enforced from targetSdk 35), so without this the topmost
       header sits under the status bar. It cannot live on the page headers:
       only the disconnected `.topbar` used to carry it, so every CONNECTED
       page — which renders its own `.page-head` / win-bar instead — overlapped
       the notification strip. `box-sizing: border-box` is global, so the
       padding comes out of the content box and the terminal's fit math still
       adds up. Mirrors `.tabbar`'s `padding-bottom: var(--sab)` at the bottom.
       `--sat` is `env(safe-area-inset-top)`, overridden by an inline value that
       MainActivity pushes in from WindowInsetsCompat — WebView only forwards
       systemBars() to CSS from M136 (fullscreen) / M144 (always), so on older
       WebViews the Kotlin path is the only source. Both land on this one var. */
    padding-top: var(--sat);
    overflow: hidden;
    background: linear-gradient(180deg, var(--bg) 0%, var(--bg2) 50%, var(--bg3) 100%);
  }

  /* Disconnected top bar (brand + gear), both platforms. The safe area is
     `main`'s job now, so this is plain padding. */
  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--nav-bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    z-index: 10;
  }

  /* Connected desktop: the left icon rail. The top bar is gone — every page
     gets its vertical space back and switching is one always-visible click.
     `top: var(--sat)` (board #332, owner 2026-10-09: on an Android tablet in
     the desktop layout the rail "跑到了屏幕最顶端，和消息上面的状态栏重叠了"):
     the rail is FIXED, so `main`'s `padding-top: var(--sat)` never reached it —
     only in-flow content starts under the status bar. It is 0 on a desktop. */
  .rail {
    position: fixed;
    left: 0; top: var(--sat); bottom: 0;
    width: 46px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 0 12px;
    background: var(--nav-bg);
    border-right: 1px solid var(--border);
    z-index: 12;
  }
  .rail-brand { border-radius: var(--ui-radius-control); margin-bottom: 8px; flex: none; }
  /* The sidebar toggle's seat (#217): the rail's width in, one --side-toggle-x
     inset, centred on the page-head row. Fixed, so neither the collapsing
     track nor a page's own scrolling moves it; above page content, below
     popovers (rail 12, menus 24). The heads' reservations live in app.css. */
  .shell-side-toggle {
    position: fixed; z-index: 11;
    left: calc(46px + var(--side-toggle-x));
    /* Fixed like the rail, so it adds the status-bar inset itself (#332). */
    top: calc(var(--sat) + (var(--page-head-h) - var(--control-height)) / 2);
  }
  /* The per-slot wrapper mirrors the rail's own column so the layout is the
     one it had before the wrapper existed: a page slot is its 34px button,
     the gap slot stretches (flex: 1) and stacks the spacer over the server
     control with the rail's 4px gap. Lifted = carrying the dragged icon:
     it paints over its neighbours. */
  .rail-slot { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: none; }
  .rail-slot.rail-gap { flex: 1; align-self: stretch; }
  .rail-slot.lifted { position: relative; z-index: 2; }
  .rail-btn {
    width: 34px; height: 32px;
    display: grid; place-items: center;
    border: none; border-radius: var(--ui-radius-control); background: none;
    color: var(--text3); cursor: pointer;
    /* transform is NOT in the list: the drag carries the icon by an inline
       transform and must follow the pointer with no lag (motion.md §1.7). */
    transition: color var(--t-fast), background var(--t-fast), box-shadow var(--t-fast);
    -webkit-tap-highlight-color: transparent;
    position: relative; z-index: 1; /* above the travelling pill */
  }
  .rail-btn:hover { color: var(--text); background: var(--surface2); }
  /* The active wash is the travelling .slide-pill behind the button (the rail
     is position: fixed, so it is the pill's containing block); the button
     keeps only its ink. */
  .rail-btn.active { color: var(--accent); }
  .rail-spacer { flex: 1; }

  /* Server picker geometry and two-line rows are local; shared atoms own paint. */
  .rail-server { margin-bottom: 4px; }
  .rail-bell { position: relative; }
  /* The scratch terminal's toggle, in the system status bar (#326). The bar
     is a quiet monitor readout, so the control is quiet too: borderless, the
     icon-only hover and press washes, accent ink while the panel is open. It
     sizes from `--sys-ctl` rather than a literal, so the bar reserves room
     for it instead of clipping it — one fixed 20px square, because the bar
     stays 24px whatever the pointer reports (#339; a coarse pointer gets the
     hit area below, not a bigger box).

     Icon-only, so it wears the shared grammar: no drawn frame, the paint
     appears on hover and press and is gone at rest (owner, 2026-10-10:
     "那个背景不用一直显示，就是我鼠标移上去，或者我点击的时候能看到的形状"),
     and the corner is the dense-group PAINT token — 5px on this 20px square,
     a rounded rectangle, where --control-radius would draw a circle (#337).
     The OPEN panel is accent INK only: a wash would be a background showing
     all the time, which is what the owner asked not to have. */
  .sys-scratch {
    position: relative;
    flex: none; margin-left: auto; display: grid; place-items: center;
    width: var(--sys-ctl); height: var(--sys-ctl); padding: 0;
    border: 0; border-radius: var(--control-paint-radius); background: none;
    color: var(--text3); cursor: pointer;
    transition: color var(--t-fast), background var(--t-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .sys-scratch:hover { color: var(--text); background: var(--surface2); }
  /* Press: the accent wash the icon-only family already uses (.icon-btn). */
  .sys-scratch:active { color: var(--accent); background: var(--accent-bg); }
  .sys-scratch.open { color: var(--accent); }
  /* A pointer that reports coarse gets a bigger hit area, never a bigger
     paint and never a taller bar. It stops at the bar's own box — 24px tall,
     and sideways only into the padding and the gap that are already dead
     space — because an overlay larger than the strip would take clicks from
     the sidebar content ABOVE it, where this control is not. */
  @media (any-pointer: coarse) {
    .sys-scratch::after {
      content: ''; position: absolute; inset: -2px -6px;
    }
  }
  @media (prefers-reduced-motion: reduce) { .sys-scratch { transition: none; } }
  .bell-badge {
    position: absolute; top: 3px; right: 2px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
    border-radius: var(--ui-radius-pill); background: var(--accent-ink); color: var(--bg);
    font-size: var(--fs-micro); font-weight: 700; line-height: 14px; text-align: center; font-variant-numeric: tabular-nums;
  }
  .tab-glyph { position: relative; }
  .tab-badge { position: absolute; top: -1px; right: -4px; border: 2px solid var(--nav-bg); }
  /* --pop-maxw/--pop-maxh are the ROOM menuPlacement found at the position it
     returned (#326). Beside the rail that room is what shrinks on a narrow
     window — the popover scrolls inside itself rather than sliding back over
     the rail — so each menu keeps its own preferred size and takes the room
     as a second cap. */
  .centre-menu {
    position: fixed; z-index: 24; width: min(360px, calc(100vw / var(--ui-zoom, 1) - 16px));
    max-width: var(--pop-maxw, none);
    max-height: min(520px, calc(100vh / var(--ui-zoom, 1) - 16px), var(--pop-maxh, 100vh)); overflow-y: auto;
  }
  .server-menu {
    position: fixed; z-index: 24; width: max-content;
    min-width: min(220px, calc(100vw / var(--ui-zoom, 1) - 16px), var(--pop-maxw, 100vw));
    max-width: min(320px, calc(100vw / var(--ui-zoom, 1) - 16px), var(--pop-maxw, 100vw));
    max-height: min(calc(100vh / var(--ui-zoom, 1) - 16px), var(--pop-maxh, 100vh)); overflow-y: auto;
    /* Visibility and the intro are the shared .pop-layer atom (app.css). */
  }

  /* Reordering the rail. Two cues, because one is not enough to say both WHAT
     is moving and WHERE it lands: the pressed icon is CARRIED (it follows the
     pointer by transform, which reflows nothing, so the drop geometry stays the
     rects snapshotted at drag start) and wears the accent selection it already
     uses for "active"; the insertion point is an accent LINE on the edge the
     icon would push down. Hover is suppressed on the icons it passes over —
     mid-drag, a highlight under the cursor reads as a second selection. */
  .rail.reordering { cursor: grabbing; user-select: none; }
  .rail.reordering .rail-btn { cursor: grabbing; }
  .rail.reordering .rail-btn:not(.dragging):hover { color: var(--text3); background: none; }
  .rail-btn.dragging {
    color: var(--accent); background: var(--accent-bg);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .rail-drop {
    position: absolute; left: 7px; right: 7px; height: 2px;
    background: var(--accent); border-radius: 1px;
    z-index: 1; pointer-events: none;
  }
  main.with-rail { padding-left: 46px; }

  /* The singleton status strip sits over RESERVED sidebar space only. These
     are the three primary sidebar shells used by Chat/Board/Agents/Settings,
     Terminal/Sessions and Files respectively. Padding shrinks their own
     content box (global border-box), so no last row is hidden; the main
     content column receives neither padding nor a footer track. */
  .with-rail :global(.sidebar),
  .with-rail .term-side,
  .with-rail :global(.files-left) {
    padding-bottom: var(--sys-sidebar-h);
  }
  .sys-sidebar {
    position: fixed;
    left: 46px;
    bottom: 0;
    width: var(--sidebar-w);
    height: var(--sys-sidebar-h);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    background: var(--bg2);
    border-top: 1px solid var(--border);
    border-right: 1px solid var(--border);
    z-index: 11;
    overflow: hidden; box-sizing: border-box;
    transition: width var(--t-move) ease-out, padding var(--t-move) ease-out, visibility 0s linear 0s;
  }
  /* Collapsed with the sidebar it belongs to (owner, 2026-09-14: "左侧边栏收起的
     时候，底下的系统状态显示也要收起"; board #200): it retracts into the rail's
     edge on the partition's tempo and is unreachable at rest. */
  .with-rail.side-collapsed .sys-sidebar {
    width: 0; padding-inline: 0; border-right-color: transparent; visibility: hidden;
    transition: width var(--t-move) ease-out, padding var(--t-move) ease-out, visibility 0s linear var(--t-move);
  }

  /* Touch keeps the SAME singleton but parks it until one of the shared
     drawers is actually open. It then becomes the drawer's final reserved
     row, above the scrim and below dialogs; safe-area padding keeps the
     reading clear of the home indicator. */
  .touch-layout .sys-sidebar {
    display: none;
    left: 0;
    width: min(300px, 86vw);
    height: calc(var(--sys-sidebar-h) + var(--sab));
    padding: 2px 8px calc(2px + var(--sab));
    border-right: none;
    z-index: 27;
  }
  .touch-layout:has(:global(.page-layer:not(.hidden) .side-sheet.open)) .sys-sidebar { display: flex; }
  .touch-layout:has(:global(.page-layer:not(.hidden) .side-sheet.open)) :global(.side-sheet.open) {
    padding-bottom: calc(var(--sys-sidebar-h) + var(--sab));
  }

  /* Connected mobile: bottom tab bar in thumb reach. Hidden while the
     keyboard is up so immersive typing (terminal, editor) costs nothing —
     the ONLY writer of that class is App's viewport handler. */
  .tabbar {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    background: var(--nav-bg);
    border-top: 1px solid var(--border);
    padding-bottom: var(--sab);
    z-index: 10;
  }
  :global(html.keyboard-open) .tabbar { display: none; }
  /* …and while a page asks for the whole screen: Files' reading mode (board
     #226) — the page reports it through `onimmersive`, App gates it on the
     page being the visible one. Same hide, second explicit reason. */
  .immersive .tabbar { display: none; }
  .tabbar button {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 7px 0 5px;
    border: none; background: none;
    color: var(--text3); cursor: pointer;
    font-size: var(--fs-meta);
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast), transform var(--t-fast);
  }
  .tabbar button.active { color: var(--accent); }
  .tabbar button:active { transform: scale(0.95); }

  .nav-right {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }

  .gear-btn {
    padding: 6px; border: none; border-radius: var(--ui-radius-control); background: none;
    color: var(--text3); cursor: pointer; display: flex;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast), background var(--t-fast);
  }
  .gear-btn:active { color: var(--accent); }
  .gear-btn.active { color: var(--accent); background: var(--accent-bg); }
  /* The gear's turn while Settings is open is the shared .tab-glyph atom
     (app.css, board #240) — the same 90° the rail and tab bar gears make. */


  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }
  .logo {
    width: 24px; height: 24px;
    filter: drop-shadow(0 0 6px rgba(0, 212, 255, 0.4));
  }
  :global(html[data-theme="light"]) .logo {
    filter: brightness(0.7) drop-shadow(0 0 4px rgba(0, 136, 204, 0.3));
  }
  .brand-text {
    font-weight: 600;
    font-size: var(--fs-title);
    color: var(--text2);
    letter-spacing: -0.3px;
  }
  .brand-accent { color: var(--accent); }

  .reconnect-bar {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 6px; background: var(--bg2); border-bottom: 1px solid var(--accent); color: var(--accent);
    font-size: var(--fs-ui); font-weight: 500; flex-shrink: 0;
  }
  .reconnect-spinner {
    width: 12px; height: 12px; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: reconnect-spin 0.6s linear infinite;
  }
  @keyframes reconnect-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .reconnect-spinner { animation: none; } }
  .reconnect-cancel {
    margin-left: auto; padding: 2px 10px; border: 1px solid var(--accent);
    border-radius: var(--ui-radius-control); background: none; color: var(--accent); font-size: var(--fs-sub);
    font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }

  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .page-terminal { background: var(--bg); }
  /* Terminal = session list + terminal, one page (the Sessions tab was
     retired into this). Wide: two columns. Phone: the list slides over,
     because the terminal needs the whole screen there. */
  /* Specificity note: .page-layer sets display:flex later in this sheet, so
     the merged layout must qualify with BOTH classes to win. */
  /* The left column is THE shared sidebar (ui-unification.md §1): same
     `var(--sidebar-w)` geometry and the same SideHandle as Chat / Agents /
     Files, so switching rail tabs no longer makes the left region jump. It
     was pinned at 280px because this column used to render project CARDS
     with a tray of pane pills that wrapped one-per-line at 240 — dense mode
     retired both, so the exception expired with them (owner, 2026-08-19). */
  /* The sessions sidebar is a REVEAL track on the shell-wide --side-open
     factor (app.css; board #200), moved by reveal.ts like the Hub's: pinned
     at its width, hugging the edge that stays, clipped by the page while the
     track uncovers or withdraws it; unreachable (visibility) at rest collapsed. */
  .page-layer.term-page { display: grid; --side-open: 1; grid-template-columns: minmax(0, calc(var(--sidebar-w) * var(--side-open))) minmax(0, 1fr); min-height: 0; overflow: hidden; }
  .page-layer.term-page:global(.moving) { transition: --side-open var(--t-move) ease-out; }
  .with-rail.side-collapsed .page-layer.term-page { --side-open: 0; }
  .with-rail.side-collapsed .page-layer.term-page:not(:global(.moving)) > .term-side { visibility: hidden; }
  .term-side:global(.pin-end) { justify-self: end; }
  .term-side { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); background: var(--bg2); }
  .term-main { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  @media (max-width: 760px) {
    .page-layer.term-page { grid-template-columns: minmax(0, 1fr); }
    /* The sheet geometry/motion is the SHARED .side-sheet dialect in app.css
       (owner, 2026-08-30: one drawer for Chat/Terminal/Board). */
  }

  /* Swipe transition animations */
  /* will-change ONLY while the 120ms slide runs (slideAnim clears right
     after): a permanent `will-change: transform` makes .page the CONTAINING
     BLOCK for every position:fixed popover inside it. On the phone .page
     starts at viewport x=0 so nothing showed, but on desktop the rail pads
     .page 46px right — and every fixed menu (the shared Select's list, the
     agent dot menu, context menus) rendered 46px right of where the
     viewport-space math put it (owner, 2026-08-25: "下拉框整体往右偏了").
     No popover can be open during the tab slide, so the transient containing
     block is harmless. */
  .page.slide-in-left, .page.slide-in-right { will-change: transform; }
  .page.slide-in-left   { animation: slideInLeft 0.12s linear; }
  .page.slide-in-right  { animation: slideInRight 0.12s linear; }
  @keyframes slideInLeft  { from { transform: translateX(-40%); } to { transform: none; } }
  @keyframes slideInRight { from { transform: translateX(40%); } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { .page.slide-in-left, .page.slide-in-right { animation: none; } }
  .page-layer {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    /* NO z-index here. With one, each page layer becomes a stacking context
       that CAPS every fixed overlay inside it at that value — a dialog's
       z-index: 31 lost to the tabbar's z-index: 10, so on the phone every
       bottom sheet's action row (create project, close/delete confirms) sat
       BEHIND the tabbar once fixed layers anchored to the true viewport
       ("手机上窗口被下边被最下边挡住了，按钮看不到，包括关闭确认框", owner
       2026-08-25). Layers are visibility-toggled, never z-fought, so the
       stacking context bought nothing. */
    z-index: auto;
  }
  .page-layer.hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .terminal-body { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  .terminal-empty {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 9px; color: var(--text3); font-size: var(--fs-body);
  }
  .terminal-empty :global(svg) { opacity: 0.65; }
  /* The in-place switch panel (board 315): the terminal-empty dialect, in
     the content area of the kept shell. */
  .switch-panel {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 9px; padding: 24px 16px; text-align: center; color: var(--text3); font-size: var(--fs-body);
  }
  .switch-panel :global(svg) { opacity: 0.65; }
  .switch-name { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
  .switch-addr { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text2); overflow-wrap: anywhere; }
  .switch-panel .config-error { margin: 0; max-width: 420px; }
  .switch-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }

  /* Split-layout control: a single floating icon in the terminal's top-right
     corner (no full-width toolbar row). Opens the shared ContextMenu with
     single/2/3/4/6 panes, the current one checked. */
  .split-control { position: absolute; top: 6px; right: 8px; z-index: 12; }
  .split-toggle {
    width: 28px; height: 28px; padding: 0;
    border: 1px solid var(--border); border-radius: var(--ui-radius-row);
    background: var(--surface); color: var(--text3);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  .split-toggle:hover { color: var(--text2); }
  .split-toggle.on { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
</style>
