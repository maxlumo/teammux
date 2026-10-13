<script>
  import { onDestroy, tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
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
  import SystemStatus from './lib/system/SystemStatus.svelte';
  import ServerList from './lib/app/ServerList.svelte';
  import ScratchPanel from './lib/app/ScratchPanel.svelte';
  import NotifyCentre from './lib/hub/NotifyCentre.svelte';
  import { createAlertLog, createCentre, centreSurface } from './lib/hub/notify-centre.svelte.ts';
  import { createCentreUnion } from './lib/app/centre-union.svelte.ts';
  import AddServerDialog from './lib/app/AddServerDialog.svelte';
  import { appPrefs } from './lib/hub/hub-prefs.svelte.ts';
  import { moveTrack, pinTrack } from './lib/hub/reveal.ts';
  import { findBestAddress, classifyAddress, ADDRESS_LABELS, isAddressViable, noteAddressUnreachable, createConnection, createWsApi, createConnectionRegistry } from './lib/core/ws.ts';
  import { t } from './lib/core/i18n.svelte.ts';
  import { layout } from './lib/app/layout.svelte.ts';
  import { applyFontVars } from './lib/app/fonts.svelte.ts';
  import { normalizeUiZoom, stepUiZoom, UI_ZOOM_DEFAULT } from './lib/app/ui-zoom.ts';
  import { agentsLivesInSettings, defaultPage, restoreNav, retarget } from './lib/app/nav-state.ts';
  import { RAIL_DRAG_THRESHOLD, RAIL_GAP, RAIL_ORDER_KEY, parseRailOrder, railDropAt, railDropIndex, railDropOffset, railOrderToStore, visibleRailSlots } from './lib/app/nav-order.ts';
  import { createReconnectMachine } from './lib/app/reconnect.ts';
  import { targetOf } from './lib/app/server-target.ts';
  import ServerScope from './lib/app/ServerScope.svelte';
  import { createServerFleet } from './lib/app/server-fleet.ts';
  import { createServerView } from './lib/app/server-view.svelte.ts';
  import { createMembers } from './lib/app/server-members.svelte.ts';
  import { readMode, writeMode, readExcluded, setExcluded, includedServers } from './lib/app/connection-mode.ts';
  import { serverTag } from './lib/app/server-tag.ts';
  import { createHubUnion } from './lib/app/hub-union.svelte.ts';
  import { createSessionsUnion } from './lib/app/sessions-union.svelte.ts';
  import { createScopeSwap } from './lib/app/server-scope.ts';
  import { createServerState, releaseServerState, reloadStored, stateForRuntime } from './lib/app/server-state.ts';
  import { createServerStore, createWriteGate } from './lib/app/server-store.ts';
  import { claimPending, migrateServerState } from './lib/app/server-state-migration.ts';
  import { createActivations } from './lib/app/activation.ts';
  import { createHandleEnds } from './lib/app/handle-end.ts';
  import { navFor, readNav, reownSavedNav, saveNav } from './lib/app/nav-saved.ts';
  import { paneRef, reownRef, retargetRef, sessionRef } from './lib/app/refs.ts';
  import { absorbedInto, activateConnected, adoptHostname, focusServer, restoreCurrent, currentServerId, currentServerName, hostLabel, loadServers, mergedInto, migrateServers, recordServer, removeServer, renameServer, saveMachineAddresses, saveServers } from './lib/app/servers.ts';
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
  /** The window's side of the bound tree (board #335 ③a, server-view.svelte.ts):
   * where its navigation stands — the pane, the Files session, the split —
   * the requests aimed at it, the runtime whose navigation has been restored
   * (the saved-state effect waits for it, so nothing writes an empty
   * navigation over the record the restore is about to read; ②b-2), and the
   * Back chains and reselects its pages registered. One view for the one
   * tree; `resetServerMemory` resets it where it always reset these. */
  const views = new WeakMap();
  /** A runtime's view, made on first ask. */
  function viewOf(runtime) {
    let v = views.get(runtime);
    if (!v) { v = createServerView(); views.set(runtime, v); }
    return v;
  }
  /** The view with no server bound: what the shell reads in the gap. */
  const noServerView = createServerView();
  /** The FOCUSED tree's view (③a-4): the window reads and dispatches through
   * it. Each tree's pages register into their own (`viewOf(runtime)` in the
   * template). */
  const view = $derived(scopeRuntime ? viewOf(scopeRuntime) : noServerView);
  /** The tree a leave walk has brought IN FRONT to ask its guards (#335
   * ③b-2): a background member about to be destroyed is asked on its own
   * tree, seen and answerable, without becoming CURRENT (D2) — the focus,
   * its view and CURRENT stay as they were, and the walk puts this back to
   * null when it ends, either way (`walkLeave`). */
  let revealed = $state.raw(null);
  /** The tree on screen: the one a walk revealed, else the focused one. ONE
   * definition of "in front": every tree's `held`, the guest Preferences
   * shows and the Back chain the window asks all follow it. */
  const front = $derived(revealed ?? scopeRuntime);
  /** Does the server IN FRONT host the Hub — the one whose guest editor a
   * walk may be showing (reviewer P1-2 on 99566068: the capability is the
   * revealed runtime's, not CURRENT's). */
  // `revealed` is a mounted member, so its view already exists: a view
  // CREATED inside this derived would not be tracked by it (Svelte does not
  // track state a reaction creates), and the flag would never follow.
  const frontHub = $derived(revealed ? viewOf(revealed).hubState.available : hubEligible);
  /** The trees the app holds mounted: the focused server's, and in
   * Aggregate every background member that passed its gates (③b-1). */
  let background = $state.raw([]);
  const members = $derived([...(scopeRuntime ? [scopeRuntime] : []), ...background.filter((r) => r !== scopeRuntime)]);
  /** The app's ONE write gate (board #335 ③a; orchestrator's P1-D ruling and
   * 08:17's "one mechanism, Single included"): while the app is blocked on
   * its storage, every server store App builds holds its resident writes
   * instead of landing them, and every runtime refuses new write RPCs. The
   * tree stays MOUNTED — inert and hidden — so nothing a person typed is
   * lost; the fold's own writes do not go through it. `storageHeld` is the
   * gate's state as the template sees it. */
  const writeGate = createWriteGate();
  let storageHeld = $state(false);
  /** Close the gate and freeze every runtime, in the same turn the block is
   * decided — before any page could write. */
  function holdStorage() {
    migrationBlocked = true;
    // Every attempt in flight stops being the app's, in this same turn
    // (reviewer P1-3 on 6b923c0d): a dial asks its owner right before it
    // records an identity, so a late authentication cannot reach the
    // registry or CURRENT through a frozen app. Connections, streams and
    // downloads are untouched; Retry starts what it owes afresh.
    activations.endAll();
    if (storageHeld) return;
    writeGate.close();
    storageHeld = true;
    for (const runtime of fleet.all()) runtime.setFrozen(true);
  }
  /** Once the claim has run: land what was held, in order, under each
   * server's survivor, and only then thaw. False — still held, still
   * blocked — when a write fails; what did not land waits for the next
   * Retry. */
  function releaseStorage() {
    if (!storageHeld) return true;
    if (!writeGate.flush(localStorage, (id) => mergedInto(localStorage, id))) return false;
    storageHeld = false;
    for (const runtime of fleet.all()) runtime.setFrozen(false);
    return true;
  }
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
  /** Every runtime, and its CONNECTION, is the fleet's (board #335 ②b-4,
   * orchestrator's ruling 01:43): one connection per runtime, so a switch
   * includes the next server and drops the one left, and nothing re-points a
   * shared socket. The registry comes through ws.ts, the transport's one
   * import. A runtime the fleet lets go of is ended the host's one way
   * (release, then dispose) — except the one the tree is still bound to,
   * which the swap that replaces it ends (`invalidate`), after its
   * replacement has had the chance to adopt its state. */
  const fleet = createServerFleet({
    storage: localStorage,
    registry: createConnectionRegistry(),
    // A published member the set holds is ORPHANED here, at the fleet's own
    // synchronous boundary (P1-5; reviewer R1 on aed2f654): its identity is
    // detached now — api refusing, socket closed, loop stopped — and its tree
    // is kept, drafts and all, until the person is asked; `release` ends it
    // then. Not deferred to a later sync, which a block could hold off while
    // a captured api still answered. Anything else the set holds (a join in
    // flight, an orphan already) is the set's; a stranger is ended here.
    end: (runtime) => {
      // The bound runtime leaves the fleet for two reasons: the swap or a
      // mint replacing it (its entry still saved; the swap ends it, after its
      // replacement adopts its state), or identity repair ABSORBING its entry
      // (gone from the registry): then its identity ends here.
      if (runtime === scopeSwap.bound()) {
        if (!loadServers(localStorage).some((s) => s.id === runtime.id)) focusAbsorbed(runtime);
        return undefined;
      }
      if (aggregate.absorbed(runtime) || aggregate.holds(runtime)) return undefined;
      return ends.end(runtime);
    },
    // An absorption merged the absorbed entries' slots into a survivor's
    // (servers.ts `forgetDropped`): a survivor that is alive re-reads them,
    // or its next write would put back what it held before the merge.
    onReconciled: (gone) => { for (const id of gone) reloadSurvivor(mergedInto(localStorage, id)); },
  });
  function reloadSurvivor(id) {
    const runtime = id ? fleet.get(id) : undefined;
    const state = runtime && serverStates.get(runtime);
    if (state) reloadStored(state);
  }
  /** The identity layer declared the entry the tree is BOUND to gone — at
   * the fleet's synchronous boundary, like any member's (reviewer P1-A on
   * e0dafe3c). Keeping its tree, for the person to be asked, and keeping its
   * identity callable are two different things, and the first step here is
   * UNCONDITIONAL (reviewer P1-B on 4c7cd64c): the vanishing current handle
   * is detached — api refusing, reconnect loop stopped, socket closed, as a
   * member's is — before any fallible I/O, whoever absorbed it and whatever
   * follows. Out of the fleet it is out of service: a block that follows
   * cannot freeze what the fleet no longer lists, so it must already refuse.
   *
   * What follows is the HANDOVER, owed work from this moment (reviewer P1-A
   * on 4c7cd64c): completed now when the window is free, else recorded
   * (`owedHandover`) and completed when the window operation in flight ends
   * — unless that operation bound something else meanwhile (a switch or
   * activation whose record absorbed this entry brings up the survivor and
   * the swap ends this tree), which voids it. A handover beneath an
   * operation in flight would supersede it (a switch whose confirm walk is
   * asking this very tree) or have its swap end the member just bound. */
  function focusAbsorbed(leaving) {
    // Detach is idempotent: a handle its OWN dial already detached
    // (server-runtime.ts) is detached again to no effect. Who detached it
    // says nothing about who will complete the handover (reviewer P1-1 on
    // 9c1f757c): that dial's arrival may be refused by a guard in flight and
    // conclude nothing — so the debt is registered for EVERY committed
    // disappearance of the bound entry, and an arrival that does take over
    // voids it by binding (`settleHandover`: bound !== leaving).
    leaving.detach();
    leaving.connection.disconnect();
    // Its reconnect loop: stopped now when idle. A loop with a dial IN FLIGHT
    // is left to finish — its continuation may be the block's source (a
    // record that committed and then failed reports `unrecorded` through it)
    // or the arrival itself — and is stopped when that answer lands
    // (`memberReconnected`, `onReconnected`); every dial of a dead handle
    // answers `gone` at once.
    if (!reconnectors.get(leaving)?.isActive()) forgetReconnector(leaving);
    // The canonical the record folded this entry into, named NOW: CURRENT
    // may already name a window operation's target (a form connect moved
    // it before the member absorbed the focus), and that is its, not ours.
    if (owedHandover?.leaving !== leaving) owedHandover = { leaving, to: absorbedInto(localStorage, leaving.id) };
    // Settled on the window's own turn, never inside a dial's reconcile:
    // the handover's publish passes the storage gate, which writes.
    scheduleAsk();
  }
  /** The detached bound runtime whose focus handover is still owed, and the
   * canonical it is owed to (the id the registry folded it into). */
  let owedHandover = null;
  /** Complete the owed handover if the window is free; true when nothing is
   * owed any more (done, or void). Run before the orphan drain on every
   * turn the window frees (`drainWindow`). A failed switch's panel is a
   * resting state, not an operation: a handover completes under it and
   * dismisses it, with its reason kept as the notice — the server it would
   * go Back to is gone.
   *
   * The X2 contract (orchestrator 15:52): the debt is VOID once a legitimate
   * window operation moved CURRENT off the survivor — a connect, a switch, a
   * focus move: that operation owns the front and binds (or has bound) its
   * own target; a failed one puts CURRENT back on the survivor
   * (`restoreCurrent` follows the merge) and the debt is settled then. It is
   * never settled by activating whatever CURRENT names. */
  function settleHandover() {
    const leaving = owedHandover?.leaving;
    if (!leaving) return true;
    // Something else was bound meanwhile: the swap ended this tree.
    if (scopeSwap.bound() !== leaving) { owedHandover = null; return true; }
    // The person chose to stay on the detached tree (an arrival's walk
    // answered "keep editing"): the choice stands until they connect.
    if (heldOffline) { owedHandover = null; return true; }
    if (windowBusy() || migrationBlocked) return false;
    const to = owedHandover.to;
    if (!to || currentServerId(localStorage) !== to) { owedHandover = null; return true; }
    // The PUBLISH passes the storage gate (reviewer P1-2 on 9c1f757c): the
    // inputs' attribution and the merge's navigation rewrite for the
    // survivor — the same gate every bind passes (`foldCurrent`) — before any
    // tree is shown as the front. A write that fails BLOCKS: the tree, the
    // debt and the detached handle stay as they are; Retry runs the gate
    // again and settles then (it drains).
    const gate = foldCurrent();
    if (gate.fold === 'blocked') return false;
    if (handOverFocus(leaving, to)) return true;
    owedHandover = null;
    // Nobody to hand to — the survivor is no published, connected member
    // (Single; a member that dropped or lost its own identity meanwhile):
    // the one defined path is an activation of the survivor, which asks this
    // tree's guards first and replaces it through the swap, as Retry's owed
    // arrival does.
    const minted = mintFrom(gate);
    if (minted.runtime) arriveOn(minted);
    return true;
  }
  /** The focus hands over to the connected member `to` — the canonical
   * whose own reconnect reached the focus's address and absorbed the focus
   * into its entry, so nothing else will ever bring the focus there. The
   * mirror is written for it (CURRENT already names it: the commit point; a
   * mirror failure is the host gate's and the focus still follows CURRENT),
   * the front moves, the window's attempts aimed at the absorbed server go
   * stale, the canonical leaves the set as the focus and the absorbed tree
   * joins it as a member — which the sync that follows, finding its id
   * unsaved, makes an ORPHAN: mounted, held, drafts and all, asked when the
   * window is free. False when no such member is published and connected. */
  function handOverFocus(leaving, to) {
    const next = aggregate.runtimes().find((r) => r.id === to && !aggregate.orphan(r) && r.connection.isConnected());
    if (!next || !scopeSwap.refocus(next)) return false;
    // Settled: from here the set no longer wants `next` as a member (its own
    // dial, still returning, is the focus's and must not be joined over).
    owedHandover = null;
    // The mirror write failing blocks the app on the server just handed to:
    // the block's own path (`enterBlocked`) stands it down, and Retry owes
    // it its dial like any interrupted activation (ruling K).
    try { focusServer(localStorage, next.id); } catch { storageFailed(); if (migrationBlocked) owedActivation = true; }
    const failed = switching?.phase === 'failed' ? switching.error : '';
    serverSwitch.supersede();
    serverSwitch.dismiss();
    activations.claim();
    aggregate.handOver(next);
    aggregate.adopt(leaving, false);
    // The set changed hands NOW, sync or no sync (a block skips it): the
    // adopted tree stays mounted as a member, held.
    background = aggregate.runtimes();
    serverMenuOpen = false;
    membershipError = '';
    reconnectError = failed;
    // Up, or its own loop (a member's) is dialling it and reports to the
    // shell from here (`onStateChange`, `onSuccess` by `bound()`).
    connected = next.connection.isConnected();
    reconnecting = !connected && !!reconnectors.get(next)?.isActive();
    // The connect card was up (the person had disconnected the absorbed
    // server to connect the form): the app is on a server again.
    if (connected && page === 'settings') page = defaultPage();
    serverInfo = { hostname: next.hostname(), machineId: next.machineId() };
    activeAddress = next.entry().address;
    loadServerRegistry();
    syncMembers();
    return true;
  }
  /** The bound runtime's connection and api: what App itself talks to the
   * server it is on through — never a module-level socket. */
  const bound = () => scopeSwap.bound();
  const live = () => bound()?.connection ?? null;
  /** The bound server's centre: what its Hub records into and jumps from. */
  const focusCentre = $derived(serverStates.get(scopeRuntime)?.centre ?? noServerCentre);
  /** The bell's UNION over the included servers (③c-4, `centre-union`):
   * every member's list — the focus's and each background member's, in
   * saved order — tagged by the ③c-1 rule; a member not connected right now
   * is listed unavailable (D6: shown, not counted read, not cleared). Single
   * includes one server, so the union is that server's list, as before. */
  const centreSources = $derived.by(() => {
    const live = new Map([...(scopeRuntime ? [scopeRuntime] : []), ...background].map((r) => [r.id, r]));
    return tagScope.included.map((s, order) => {
      const runtime = live.get(s.id);
      // Reachable by the DERIVED state (agent-status rule): the focus by the
      // shell's `connected`, a member by its status — never a socket poll.
      const available = !!runtime && (runtime === scopeRuntime
        ? connected && !reconnecting
        : aggregate.status(s.id)?.kind === 'connected');
      return {
        serverId: s.id, name: s.name || hostLabel(s.address), order,
        log: runtime ? serverStates.get(runtime)?.centre ?? null : null,
        available,
      };
    });
  });
  const centre = createCentreUnion(() => centreSources, centreSurface);
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
      if (gone) forgetReconnector(gone);
      if (gone && fleet.get(gone.id) === gone) fleet.drop(gone.id);
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
    const minted = mintCurrent();
    if (!minted.keep) void scopeSwap.swap(minted.runtime);
  }
  /** `swapScope` without the swap (board #335 ②b-4): the runtime the tree
   * should be bound to — the held handle when it still serves CURRENT
   * (`keep`), else a new one with its server's state built, or null — but
   * not SHOWN, so a caller can dial it before any page is mounted on it. A
   * new runtime the caller never shows is ended by that caller. */
  function mintCurrent() { return mintFrom(foldCurrent()); }
  /** The storage gate every bind passes, for whichever server is CURRENT:
   * the inputs' attribution and the navigation's merge rewrite. Run before a
   * runtime is minted, and again once its dial has taught it its machine —
   * before anything is published (reviewer P1-3 on 341554b3). */
  function foldCurrent() {
    const id = currentServerId(localStorage);
    // No server's state is built before the inputs' attribution has been
    // asked for it (board #335 ②b-4): a fresh client's first server folds
    // here, a pending input meets the server that can claim it, and a
    // migration that cannot be recorded binds nothing at all.
    let fold = id ? foldFor(id) : 'ok';
    // The navigation's merge rewrite is a pre-bind write too (reviewer P1-3
    // on 08fdb6ba): not attempted while blocked, and a failure blocks.
    // What the block held lands once the claim has run, before the merge
    // rewrite reads the navigation (P1-D): a write that fails blocks again.
    if (fold !== 'blocked' && !releaseStorage()) { holdStorage(); fold = 'blocked'; }
    if (fold !== 'blocked' && !followMerges()) { holdStorage(); fold = 'blocked'; }
    return { id, fold };
  }
  function mintFrom({ id, fold }) {
    const entry = fold !== 'blocked' ? loadServers(localStorage).find((s) => s.id === id) ?? null : null;
    const held = scopeSwap.bound();
    // A claim just filed the inputs into THIS server's slots: its state,
    // read before the claim, is rebuilt from them.
    if (held?.alive() && !ends.ending(held) && entry && held.id === entry.id && fold !== 'claimed') return { keep: true, runtime: held };
    // The tree is changing servers: an attempt still in flight is no longer
    // the one the app is waiting on — the window's, and the leaving server's
    // own (its reconnect). No other member's (③a, reviewer P1-A).
    activations.claim(held);
    // The fleet follows the registry first: an id identity repair absorbed
    // leaves it (the bound one is not ended here, see `fleet`), so the
    // survivor's runtime is a NEW one rather than the alias found as a twin.
    // A runtime still held under this id that is ending, or already ended,
    // is let go of the same way: a failed switch's Back gets a fresh handle.
    fleet.reconcile();
    const stale = entry && fleet.get(entry.id);
    if (stale && (!stale.alive() || ends.ending(stale) || stale === held)) fleet.drop(entry.id);
    // The runtime the tree is bound to stays in the fleet, running, until
    // its replacement is bound (order (a)): the swap's `invalidate` drops it.
    const next = entry ? fleet.include(entry) ?? null : null;
    // Its socket closing is THIS runtime's drop: the reconnect loop takes
    // over only while it is still the one the tree is bound to.
    if (next) wireDrop(next);
    // A runtime minted while the gate is held is held too: holdStorage froze
    // only the ones it found.
    if (storageHeld) next?.setFrozen(true);
    // Its server's state: built NOW, since CURRENT already names `entry` and
    // the bare live keys are that server's (board #335 ②b-2-1) — or, when
    // identity repair folded the replaced handle's id into `entry`, the SAME
    // machine's state handed over, attempts in flight and all.
    // A runtime the fleet already holds for this id keeps the state it was
    // minted with: a later activation reusing it must not swap that state
    // under the one still dialling (reviewer P1-C on cc45d7d1).
    if (next && !serverStates.has(next)) serverStates.set(next, stateFor(entry.id));
    // Its view travels with its state: a same-machine merge that handed the
    // state over hands the view over too (③a-4), and any other server starts
    // from an empty one.
    if (next && !views.has(next) && held && held.id !== entry.id && mergedInto(localStorage, held.id) === entry.id) views.set(next, viewOf(held));
    return { keep: false, runtime: next };
  }
  /** Server `id`'s state for a runtime about to be bound: fresh from its own
   * slots, or — when identity repair folded the bound handle's id into `id` —
   * that same machine's Files record handed over. */
  /** A server's state over its own store, behind the write gate: the ONE
   * place one is built (a bound server's through `stateFor`, a background
   * member's at its publish). */
  function freshState(id) { return createServerState(createServerStore(localStorage, id, writeGate)); }
  function stateFor(id) {
    const held = scopeSwap.bound();
    const replaced = held ? { id: held.id, state: serverStates.get(held) } : null;
    return stateForRuntime(replaced, id, {
      survivorOf: (serverId) => mergedInto(localStorage, serverId),
      create: () => freshState(id),
    });
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
    // The record on disk FIRST, which names its server from v2 on — in the
    // survivor's slot, where the merge moved it. A write that fails returns
    // false and moves nothing in memory either: the caller blocks, and
    // Retry runs this again.
    const id = currentServerId(localStorage);
    try { if (id) reownSavedNav(createServerStore(localStorage, id, writeGate), survivorOf); } catch { return false; }
    const rebind = (ref) => (ref ? reownRef(ref, survivorOf) : ref);
    view.termPane = rebind(view.termPane);
    view.filesRef = rebind(view.filesRef);
    const cells = view.splitCells.map((c) => ({ ...c, pane: rebind(c.pane) }));
    if (cells.some((c, i) => c.pane !== view.splitCells[i].pane)) view.splitCells = cells;
    return true;
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
  /** The app's activation generation (app/activation.ts): the latest
   * attempt to bring a server up is the only one the app waits on. */
  const activations = createActivations();
  /** The connect form's CANDIDATE (board #335 ②b-4; orchestrator's ruling
   * 01:43): its own connection, apart from every bound runtime, so nothing a
   * server's pages are using is touched while an address nobody has
   * identified yet answers. One at a time — opening one closes the last —
   * and it is the app's latest activation (`claim`): a boot dial or a
   * reconnect attempt out at the time stops being current, and the
   * candidate stops being current the moment anything newer — a switch, a
   * revoke, another attempt — takes over. The form closes it once identity
   * is recorded; the server's own runtime then dials (`onConnected`). */
  let candidateOpen = null;
  function openCandidate() {
    heldOffline = false;               // the person is connecting
    candidateOpen?.close();
    // The form acts on the bound server: its reconnect in flight is stale too.
    const owner = activations.claim(scopeSwap.bound());
    // And holds the window while it is out (P1-B): no owed question is
    // asked over it — asking would claim the window and end this attempt.
    const release = leaseWindow();
    const connection = createConnection();
    const api = createWsApi(connection);
    let closed = false;
    const candidate = {
      connect: (url, tok) => connection.connect(url, tok),
      setSocket: (socket) => api.setSocket(socket),
      machineId: () => connection.getMachineId() || '',
      current: () => !closed && owner.current(),
      close() {
        if (closed) return;
        closed = true;
        connection.dispose();
        if (candidateOpen === candidate) candidateOpen = null;
        release();
      },
    };
    candidateOpen = candidate;
    return candidate;
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
    // A bound tree whose handle is already detached (its entry absorbed, a
    // failed switch's Back) still holds its drafts: it is asked like any.
    if (!held) return Promise.resolve(true);
    return serverSwitch.guard(() => walkLeave(held));
  }
  const shell = $derived(connected || !!switching);
  // WHAT the terminal is pointed at (board #335 ②b-2): a reference that names
  // its SERVER, because `work:1.0` on its own does not — two servers can both
  // have a session called `work`. The identity has one home; the two strings
  // every consumer and the wire want are DERIVED from it, so a serverId can
  // never reach a `target` or `session` argument.
  const terminalTarget = $derived(view.terminalTarget);
  const terminalSession = $derived(view.terminalSession);
  /** Point the terminal at a pane on the server the content tree is bound to.
   * Every write goes through here, so a reference without a server cannot be
   * created. */
  function showPane(session, target) { showPaneIn(bound(), view, session, target); }
  /** The same, in ONE tree's view (③b-1): a background tree's own pane exit
   * moves its own terminal, never the focused one's. */
  function showPaneIn(runtime, v, session, target) {
    v.termPane = target && runtime ? paneRef(runtime.id, session || target.split(':')[0], target) : null;
  }
  // Files follows the session the user touched LAST — opening a terminal pane
  // OR selecting a chat project both set it. It used to derive from the
  // terminal alone, so browsing a project in the chat never moved the Files
  // tab while switching terminal panes did (owner, 2026-08-22: "chat里的路径
  // 没有刷新到文件 terminal好像就会刷新路径").
  const filesSession = $derived(view.filesSession);
  function showSession(session) { showSessionIn(bound(), view, session); }
  function showSessionIn(runtime, v, session) {
    v.filesRef = session && runtime ? sessionRef(runtime.id, session) : null;
  }
  // A landing is a request aimed at the server-bound TREE rather than a
  // reference to an object, so what it carries is that tree's identity: it is
  // delivered only to the tree it names (`landingFor`), and the swap clears
  // the ones aimed at a tree that is going away. They are the view's:
  // `filesNavReq`, `boardIssueReq` (a feed board-line tap) and `agentsEditReq`.
  $effect(() => { if (terminalSession) showSession(terminalSession); });
  // The Hub (project rooms, agents, board) is desktop-server-only. We probe
  // once per connection: hub_rooms rejects with method-not-found on a server
  // without the projects store (mobile), so a resolved probe means the Hub
  // tabs should appear. The answer is the view's `hubState`.
  let hubAvailable = $derived(view.hubState.available);
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
    if ((page === 'hub' || page === 'agents' || page === 'board') && view.hubState.probed && !view.hubState.available) page = 'terminal';
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
  /** What SplitView takes: the strings tmux resolves. The serverId stays on
   * this side of the boundary — a cell's identity is App's, the pane's name is
   * the wire's (board #335 ②b-2). */
  // (Built per tree as `v.splitViewCells`, server-view.svelte.ts, ③a-4.)
  // The top-right layout menu: `ui/ContextMenu` anchored to the toggle (right-
  // aligned, like every dot menu). It was a hand-rolled `position:absolute`
  // panel with a backdrop — no Escape, no close on scroll/resize, no viewport
  // clamp (review, 2026-09-03); now it is the app's ONE popover mechanism.
  let splitMenuAt = $state(null);
  const SPLIT_CHOICES = [1, 2, 3, 4, 6];
  const splitMenuItems = $derived(SPLIT_CHOICES.map((n) => ({
    label: n === 1 ? t('splitSingle') : t('splitPanes').replace('{n}', String(n)),
    checked: n === 1 ? !splitActive : (splitActive && view.splitLayout === n),
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
  /** Is a tree's split on? One definition, for the focused view and for each
   * tree's own (③a-4). */
  const splitOn = (v) => splitEligible && v.splitLayout > 1 && v.splitCells.length > 0;
  let splitActive = $derived(splitOn(view));

  function setLayout(n) {
    if (!splitEligible || n <= 1) {
      view.splitLayout = 1;
      view.splitCells = [];
      view.activeCellId = null;
      return;
    }
    // Seed cell 0 from the current single pane; pad to n with empty cells.
    const base = view.splitCells.length
      ? view.splitCells.slice()
      : (view.termPane
          ? [{ id: nextCellId++, pane: view.termPane }]
          : []);
    const next = base.slice(0, n);
    while (next.length < n) next.push({ id: nextCellId++, pane: null });
    view.splitLayout = n;
    view.splitCells = next;
    if (view.activeCellId == null || !next.some(c => c.id === view.activeCellId)) {
      view.activeCellId = next[0]?.id ?? null;
    }
  }
  function assignCell(id, target, session, runtime = bound(), v = view) {
    const pane = target && runtime ? paneRef(runtime.id, session || target.split(':')[0], target) : null;
    v.splitCells = v.splitCells.map(c => c.id === id ? { ...c, pane } : c);
    // Keep the single-pane mirror pointed at the active cell so the
    // narrow-screen fallback and Files page follow what the user is using.
    if (id === view.activeCellId && target) {
      view.termPane = pane;
    }
  }
  function closeCell(id, v = view) {
    v.splitCells = v.splitCells.map(c => c.id === id ? { ...c, pane: null } : c);
  }
  function cellPaneExit(id, v = view) { closeCell(id, v); }

  // Re-subscribe after a reconnect / address switch: the server forgot all
  // subscriptions, so re-send the wire `subscribe` for every target with a
  // live refcount. This does NOT touch refcounts (the Terminals are still
  // mounted — only the server-side state was lost), so it's safe to call on
  // every reconnect without leaking counts.
  /** The bound runtime's socket came back (or moved to another of its
   * addresses): its pages re-fit and refresh. The event NAMES that runtime
   * (board #335 ②b-4, reviewer P2 on the b3 binding range), and a page acts
   * only on its own server's. */
  function announceReconnected(runtime = bound()) {
    const id = runtime?.id;
    if (id) window.dispatchEvent(new CustomEvent('ws-reconnected', { detail: { serverId: id } }));
  }
  function resubscribeAll() {
    live()?.resubscribeActive();
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
      const { serverId, from, to } = e.detail ?? {};
      if (!serverId || !from || !to || from === to) return;
      // The rename happened on the server the DISPATCHER names, from its own
      // scope (reviewer P1 on the b3 binding range) — not whichever one is
      // bound now — and `retargetRef` refuses to apply it to a reference
      // belonging to any other (board #335 ②b-2). An event that names no
      // server is nobody's, and moves nothing. The prefix-exact rule itself
      // still lives in `nav-state.retarget`.
      const rename = { serverId, from, to };
      const move = (ref) => (ref ? retargetRef(ref, rename) : ref);
      view.termPane = move(view.termPane);
      view.filesRef = move(view.filesRef);
      view.splitCells = view.splitCells.map((c) => ({ ...c, pane: move(c.pane) }));
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
    if (!connected || !scopeRuntime || view.navRestored !== scopeRuntime) return;
    saveNav(createServerStore(localStorage, scopeRuntime.id, writeGate), { page, pane: view.termPane, splitLayout: view.splitLayout, splitCells: view.splitCells });
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

  /** EACH runtime's reconnect loop (board #335 ②b-4; reviewer P1-A on
   * cc45d7d1): it dials that runtime's OWN connection through `dial`, so
   * every answer is checked against that server's identity before anything
   * trusts it, and it reaches the server by that entry's own route — its
   * addresses and its token, never a mirror's. A loop whose runtime is not
   * the one the tree is bound to shows nothing and brings nothing up. */
  const reconnectors = new Map();
  const noReconnector = { start: () => false, cancel: () => {}, isActive: () => false };
  /** The bound runtime's loop (the one the shell's reconnect UI shows). */
  function reconnect() {
    const runtime = bound();
    return runtime ? reconnectorOf(runtime) : noReconnector;
  }
  function reconnectorOf(runtime) {
    let machine = reconnectors.get(runtime);
    if (machine) return machine;
    machine = createReconnectMachine({
      // Each attempt dials under ITS OWN claim, handed in by the machine and
      // asked all the way down — the dial's ownership check, the identity
      // record, the arrival — and its answer comes back as its own result
      // (reviewer P1-2 on 341554b3). Nothing here is shared between
      // attempts: a variable the next attempt overwrites would let a stale
      // one borrow a newer owner. Not while the person is being asked
      // something: the dial waits for the walk to answer, and an attempt
      // someone took over meanwhile is nobody's.
      connect: (address, _token, timeoutMs, claim) => serverSwitch.idle().then(() => {
        if (!claim?.current()) throw new Error('superseded');
        return runtime.dial(() => claim.current(), { via: address, timeoutMs });
      }).then(
        (result) => {
          if (result.ok || result.reason === 'elsewhere') return result;
          throw result.error ?? new Error(result.reason);
        },
        // An identity record that failed: the dial closed that socket, and
        // it is not a reachability failure to retry — it is reported.
        (error) => {
          if (error?.message === 'superseded') throw error;
          return { ok: false, reason: 'unrecorded' };
        },
      ),
      // THIS runtime's own generation (③a, reviewer P1-A): its reconnect
      // never makes another member's attempt stale, and a window attempt
      // acting on it (the form, a switch) ends it.
      attempt: () => activations.member(runtime).claim(),
      findBestAddress,
      isAddressViable,
      noteAddressUnreachable,
      classifyAddress,
      addressLabels: ADDRESS_LABELS,
      target: () => targetOf(localStorage, runtime.id),
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
      watchdogMs: RECONNECT_WATCHDOG_MS,
      onStateChange: (st) => {
        if (bound() !== runtime) { if (st.reconnecting) aggregate.reconnecting(runtime); return; }
        reconnecting = st.reconnecting;
        reconnectAttempt = st.attempt;
        reconnectClass = st.label;
      },
      onSuccess: (_useAddr, _primaryAddr, attempt, result) => (bound() === runtime ? onReconnected(runtime, result, attempt) : memberReconnected(runtime, result)),
      onGiveUp: () => { if (bound() === runtime) { connected = false; page = 'settings'; } else aggregate.gaveUp(runtime); },
    });
    reconnectors.set(runtime, machine);
    return machine;
  }
  /** A runtime is over: its loop stops with it. */
  function forgetReconnector(runtime) {
    reconnectors.get(runtime)?.cancel();
    reconnectors.delete(runtime);
  }

  /** A runtime's socket closed under it: the bound one's reconnect is the
   * shell's; a background member's is its own (③b-1). ONE hook for both, so
   * a member a failed switch reused keeps reconnecting as a member. */
  function wireDrop(runtime) {
    runtime.connection.setOnDisconnect(() => {
      if (bound() === runtime) { onDrop(); return; }
      if (!aggregate.holds(runtime)) return;
      // Blocked: no loop now; Retry's resume redials it.
      if (migrationBlocked) { aggregate.blocked(runtime); return; }
      aggregate.reconnecting(runtime);
      reconnectorOf(runtime).start();
    });
  }

  /** The servers Aggregate holds besides the focused one (③b-1,
   * server-members.svelte.ts). Each joins through the same gates as a
   * bring-up, addressed to its own id and owned by its own generation; none
   * writes CURRENT or takes the screen. */
  const aggregate = createMembers({
    include: (entry) => fleet.include(entry),
    gate: (id) => (foldFor(id) === 'blocked' ? 'blocked' : 'ok'),
    activations,
    // A block ends every attempt in flight (holdStorage's endAll), so a
    // member's dial out when it lands records nothing; `wanted` is the set.
    wanted: (id) => memberIds().includes(id),
    onUp(runtime) {
      if (!serverStates.has(runtime)) serverStates.set(runtime, freshState(runtime.id));
      if (storageHeld) runtime.setFrozen(true);
      wireDrop(runtime);
      background = aggregate.runtimes();
      try { fillViewFrom(runtime, viewOf(runtime), () => aggregate.holds(runtime)); } catch { /* an unreadable record restores nothing */ }
      serverReady(runtime);
    },
    onBack(runtime) {
      runtime.connection.resubscribeActive();
      serverReady(runtime);
      announceReconnected(runtime);
    },
    release(runtime) {
      background = aggregate.runtimes().filter((r) => r !== runtime);
      // Handed to the focus: bound already, or CURRENT names it and the
      // window activation that moved CURRENT (a form connect, a switch
      // reusing this handle) is binding it. Never a member CURRENT moved
      // onto with no activation — an absorption's canonical — which the
      // fleet's boundary hands over explicitly (`focusAbsorbed`) before
      // this can run (reviewer P1-A on e0dafe3c).
      if (runtime === bound() || (runtime.alive() && runtime.id === currentServerId(localStorage))) return;
      forgetReconnector(runtime);
      // `release` is called with the set no longer holding it, so the
      // fleet's `end` ends it (or, already dropped there, this does).
      if (fleet.get(runtime.id) === runtime) fleet.drop(runtime.id);
      else void ends.end(runtime);
    },
    retry(runtime) { if (!migrationBlocked && runtime !== bound()) reconnectorOf(runtime).start(); },
    saved: (id) => loadServers(localStorage).some((s) => s.id === id),
    // The ONE host gate classifies a member's failed identity record, as it
    // does the focused server's (reviewer P1 on 453f02b8).
    unrecorded() { storageFailed(); return migrationBlocked; },
    hold(runtime) { runtime.connection.disconnect(); },
    // Identity gone, editors kept (reviewer P1-5 on 3a0b4feb; orchestrator
    // 03:40): the runtime stops serving NOW — its api refuses, its socket is
    // closed, its loop stops — and its tree stays mounted, held, drafts and
    // all, until the person answers.
    detach(runtime) {
      forgetReconnector(runtime);
      runtime.detach();
      runtime.connection.disconnect();
      background = aggregate.runtimes();
    },
    // The identity callback REGISTERS the owed ask and nothing more (reviewer
    // P1-B on e0dafe3c): it runs inside the reconcile of whatever dial
    // absorbed the member — a Settings connect's second handshake, an
    // address row's redial — and asking here would claim the window and
    // expire that very dial.
    orphaned(runtime) { orphansToAsk.add(runtime); scheduleAsk(); },
  });
  /** Orphans whose ask is still owed (reviewer R2 on aed2f654): an orphan is
   * retained and marked the moment it becomes one, but it is ASKED only when
   * the window can present the question — not over a switch in flight (its
   * guard would end the switch's intent), a walk already asking, an address
   * connect, a window activation or the connect form's candidate (its claim
   * would end theirs: `windowLeases`), a membership change, or a block (its
   * tree is held). Busy: it stays pending and is asked by this same
   * mechanism when the window is free again; no second modal. */
  const orphansToAsk = new SvelteSet();
  let askingOrphan = false;
  /** Is a window operation in flight — a switch, a walk, an address connect
   * (`serverSwitch.busy`), an activation or a form candidate (`windowLeases`),
   * a membership change? Then the window is not free: no owed question is
   * asked (it would claim the window and end the operation), and no focus
   * hands over beneath it (`focusAbsorbed`). */
  const windowBusy = () => switching?.phase === 'connecting' || serverSwitch.busy || windowLeases > 0 || membershipBusy;
  function askOrphans() {
    // A failed switch's panel is not an operation, but it COVERS the trees
    // (they are held under it): a question asked there could not be answered.
    if (ended || askingOrphan || windowBusy() || switching || migrationBlocked) return;
    const next = [...orphansToAsk].find((r) => aggregate.orphan(r));
    for (const r of orphansToAsk) if (!aggregate.orphan(r)) orphansToAsk.delete(r);
    if (!next) return;
    orphansToAsk.delete(next);
    askingOrphan = true;
    void askOrphan(next).finally(() => { askingOrphan = false; scheduleAsk(); });
  }
  /** The drain, scheduled on the window going quiet — a walk, switch or
   * address connect ending (`serverSwitch.onidle`), a lease released, Retry
   * unblocking — and run on its own turn (P2 on e0dafe3c): the operation
   * whose end freed the window finishes its own continuation first — the
   * walk's answer reaches the caller that asked and that caller commits
   * (writes its mode, opens its candidate, mints its activation) — before
   * the queue is looked at; the queue never grabs the window's generation
   * the moment a guard resolves. One timer, whoever asked. */
  let askTimer = 0;
  /** The shell has ended (reviewer P1-3 on 9c1f757c): nothing the window
   * owed is done any more — no drain, no handover, no ask, no mint — and a
   * release landing late (a candidate's close in the teardown, an
   * activation's `finally`, the switch module's `onidle`) schedules nothing.
   * Set FIRST in `onDestroy`, before any resource is closed. */
  let ended = false;
  function scheduleAsk() {
    if (ended || askTimer) return;
    askTimer = setTimeout(() => { askTimer = 0; drainWindow(); }, 0);
  }
  /** What the window owes, in order: a focus handover first (it decides
   * which tree is in front), then an orphan's ask. */
  function drainWindow() {
    if (ended) return;
    settleHandover();
    askOrphans();
  }
  /** Window operations in flight outside the switch module: an activation
   * from its mint to its `done`, a candidate from open to close. */
  let windowLeases = 0;
  function leaseWindow() {
    windowLeases++;
    let released = false;
    return () => { if (released) return; released = true; windowLeases--; scheduleAsk(); };
  }
  // Retry unblocked: an orphan still owed its ask gets it.
  $effect(() => { void migrationBlocked; untrack(scheduleAsk); });
  /** An orphan's tree is asked, in that tree: "discard" lets it go; "keep
   * editing" keeps the tree, detached, listed with Dismiss. The dismissal is a
   * deferred destruction and re-validates at commit like every membership
   * change (`membershipOp`): a block, a newer window intent or a replaced
   * orphan since the ask cancels the stale answer and keeps the tree. */
  async function askOrphan(runtime) {
    if (!aggregate.orphan(runtime)) return;
    const op = membershipOp();
    const leave = await serverSwitch.guard(() => walkLeave(runtime));
    if (!aggregate.orphan(runtime)) return;
    // Stale (a block or a newer window intent since the ask), whatever the
    // answer — a walk the block interrupted is no answer at all: the tree is
    // kept, and the question is owed again when the window is free.
    if (!op.valid()) { orphansToAsk.add(runtime); return; }
    if (leave) aggregate.dismiss(runtime);
  }
  /** The ids Aggregate wants as background members: every saved, included
   * entry but the focused one, in saved order. Single wants none. */
  function memberIds() {
    if (readMode(localStorage) !== 'aggregate') return [];
    const saved = loadServers(localStorage);
    const current = currentServerId(localStorage);
    // Nor the server the tree is BOUND to while CURRENT already names
    // another (an activation in flight moved CURRENT; its target binds when
    // it is up): the bound runtime is never joined as a member of its own
    // set — a join would dial it over its live socket and, its entry gone
    // meanwhile, detach it from under the focus (M1 F5).
    const held = scopeSwap.bound()?.id;
    // The member an owed handover will take as the focus stays a member
    // until it does (reviewer P1-A on 4c7cd64c): its own dial, returning,
    // must not find it unwanted and leave it.
    return includedServers(saved, readExcluded(localStorage, saved)).map((s) => s.id).filter((id) => (id !== current || owedHandover?.to === id) && id !== held);
  }
  /** Bring the member set in line with the registry, the mode and the
   * exclusions. Never while blocked: a block ends no member (ruling K), and
   * Retry syncs again. */
  function syncMembers() {
    if (migrationBlocked || switching) return;
    const want = new Set(memberIds());
    aggregate.sync(loadServers(localStorage).filter((s) => want.has(s.id)));
    background = aggregate.runtimes();
  }
  // The registry, CURRENT and the block are what the set follows.
  $effect(() => {
    void serverList; void serverCurId; void migrationBlocked; void switching;
    untrack(syncMembers);
  });

  /** The device's mode and exclusions as the UI shows them (③b-3): read from
   * storage, never declared beside it — refreshed whenever the registry is,
   * and by the two changes below. */
  let connMode = $state(readMode(localStorage));
  let excludedIds = $state.raw(new Set());
  $effect(() => { void serverList; untrack(() => { connMode = readMode(localStorage); excludedIds = readExcluded(localStorage, serverList); }); });
  /** One mode or membership change at a time; each holds the walk. */
  let membershipBusy = false;
  let membershipError = $state('');
  const membershipFrozen = () => migrationBlocked || !!switching || serverSwitch.guarding || membershipBusy;

  /** A membership change — the mode, an include switch — is ONE deferred
   * operation (reviewer P1-4 on 3a0b4feb; orchestrator 03:40): asked at the
   * start, COMMITTED only after it is checked again. Between the ask and the
   * write it awaits a walk, and a walk can end for reasons other than the
   * person answering — a Save in flight finishing resolves the Agents guard —
   * while the app has meanwhile blocked (holdStorage ends every attempt,
   * this one included) or something newer has taken the window over. So the
   * operation claims the window's activation and, after EVERY await and
   * before any write, asks `valid()`: still its own, not blocked, the set it
   * decided about unchanged (the mode and the registry as they were). A
   * change that is not valid writes nothing and ends nothing; the frozen
   * controls are the visible half, this is the half that holds. */
  function membershipOp() {
    const owner = activations.claim();
    const mode = readMode(localStorage);
    const saved = loadServers(localStorage).map((s) => s.id).join('\u0000');
    const valid = () => owner.current() && !migrationBlocked && !switching
      && readMode(localStorage) === mode && loadServers(localStorage).map((s) => s.id).join('\u0000') === saved;
    return { valid };
  }
  /** Settings › Connection's mode (③b-3). Single→Aggregate keeps the
   * connection the app is on and joins the rest. Aggregate→Single keeps the
   * focus and lets every member go — after asking each member's tree, one at
   * a time, in that tree (`walkLeave`); a "keep editing" anywhere changes
   * neither the mode nor any connection. */
  async function setConnectionMode(next) {
    if (membershipFrozen() || next === readMode(localStorage)) return;
    membershipBusy = true;
    membershipError = '';
    const op = membershipOp();
    try {
      if (next === 'single') {
        for (const member of aggregate.runtimes()) {
          if (!(await serverSwitch.guard(() => walkLeave(member)))) return;
          if (!op.valid()) return;
        }
      }
      if (!op.valid()) return;
      try { writeMode(localStorage, next); } catch { storageFailed(); return; }
      // Every member was asked: they leave now, as answered.
      if (next === 'single') aggregate.leaveAll();
      connMode = next;
      syncMembers();
    } finally { membershipBusy = false; scheduleAsk(); }
  }
  /** Include or exclude one saved server (Aggregate, ③b-3). Including joins
   * it. Excluding destroys its tree, so that tree is asked first, alone; the
   * focus is excluded only by moving the focus first, to the next connected
   * member in saved order — ONE operation with the write: a focus that moved
   * but could not be excluded is moved back. */
  async function setIncluded(id, on) {
    if (membershipFrozen() || connMode !== 'aggregate') return false;
    membershipBusy = true;
    membershipError = '';
    const op = membershipOp();
    let movedFrom = null;
    try {
      if (!on && id === currentServerId(localStorage)) {
        const next = aggregate.runtimes().find((r) => r.connection.isConnected());
        const leaving = scopeSwap.bound();
        // Nowhere to move the focus: refused, with the reason.
        if (!next || !leaving) { membershipError = t('serverOnlyConnected'); return false; }
        if (!(await serverSwitch.guard(() => walkLeave(leaving)))) return false;
        if (!op.valid()) return false;
        if (focusMember(next.id) !== true) return false;
        movedFrom = leaving.id;
      } else if (!on) {
        const member = aggregate.runtimes().find((r) => r.id === id);
        if (member && !(await serverSwitch.guard(() => walkLeave(member)))) return false;
        if (!op.valid()) return false;
        // Asked and answered: it leaves now (the sync below would otherwise
        // only unwant it, and an orphan is never made of an answered tree).
        if (member) aggregate.leave(member.id);
      }
      // Nothing awaits between the last check and this write: a focus move
      // and the exclusion commit together, synchronously.
      try {
        excludedIds = setExcluded(localStorage, loadServers(localStorage), id, !on);
      } catch {
        // The stored set could not be READ: writing over it would include
        // every server again (D5). Said, not done — and the focus goes back.
        undoFocus(movedFrom);                 // (a focus move clears the notice)
        membershipError = t('migrationBlockedNote');
        storageFailed();
        return false;
      }
      syncMembers();
      return true;
    } finally { membershipBusy = false; scheduleAsk(); }
  }
  /** Half of a focus-exclusion that cannot finish: put the focus back. */
  function undoFocus(id) { if (id && !migrationBlocked) focusMember(id); }
  /** The Hub sidebar's union source (③c-2, `hub-union.svelte.ts`): every
   * tree's Hub publishes its ordered list here; the focused Hub renders the
   * merge over the included set. ONE source for the app, read-only to the
   * Hubs beyond their own slice; Single hands no union at all. */
  const hubUnion = createHubUnion();
  const hubUnionFor = $derived(connMode === 'aggregate' ? {
    source: hubUnion, included: tagScope.included,
    runtimeOf: (id) => { const r = scopeSwap.bound()?.id === id ? scopeSwap.bound() : background.find((x) => x.id === id); return r && r.alive() ? r : null; },
  } : null);
  /** The Terminal sidebar's sessions union (③c-3, `sessions-union.svelte.ts`):
   * the same shape as the Hub's; a foreign session is a SELECTOR (D3). */
  const sessionsUnion = createSessionsUnion();
  const sessionsUnionFor = $derived(connMode === 'aggregate' ? { source: sessionsUnion, included: tagScope.included } : null);
  /** Another server's session picked in the Terminal sidebar (③c-3): focus
   * that server (D2) and open the pane THERE — `openTerminal` writes into
   * the focused tree's view, which the focus move just made that server's.
   * A server that is not a connected member is not a focus change. */
  function pickServerPane(ref) {
    const target = loadServers(localStorage).find((s) => s.id === ref.serverId);
    if (!target) return;
    const moved = focusMember(ref.serverId);
    if (moved !== true) { pickMember(target); return; }
    if (ref.target && ref.target !== `${ref.session}:`) openTerminal(ref.session, ref.target);
    else page = 'terminal';
    sessListOpen = false;
  }
  /** A union row of ANOTHER server picked (③c-2): focus that server (D2:
   * no teardown) and hand its Hub the session as a landing it alone reads.
   * A server that is not a connected member is not a focus change — the
   * row's own state says why (pickMember). */
  function pickServerProject(ref) {
    const target = loadServers(localStorage).find((s) => s.id === ref.serverId);
    if (!target) return;
    const moved = focusMember(ref.serverId);
    if (moved !== true) { pickMember(target); return; }
    const v = viewOf(scopeSwap.bound());
    v.hubSelectReq = { serverId: ref.serverId, session: ref.session, n: (v.hubSelectReq?.n ?? 0) + 1 };
  }
  /** A bell row picked (③c-4): the jump lands in the ALERT'S server's Hub.
   * Another included server's row focuses that server first (D2, as a
   * union project row does: `pickServerProject`); a server that is not a
   * connected member is not a focus change, and the row says why
   * (`pickMember`). The jump request is the window's one; the Hub that
   * reads it refuses an alert of another server (`hubJumpOtherServer`), so
   * only the focused server's Hub — the alert's — acts on it. */
  function pickAlert(alert) {
    centre.close();
    if (alert.server && alert.server !== currentServerId(localStorage)) {
      const target = loadServers(localStorage).find((s) => s.id === alert.server);
      if (!target) { centre.failed(alert, t('hubJumpOtherServer')); return; }
      const moved = focusMember(alert.server);
      if (moved !== true) { pickMember(target); return; }
    }
    centre.requestJump(alert);
    if (page !== 'hub') switchTab('hub');
  }
  /** Which servers are NAMED beside what they own (③c-1, `server-tag.ts`):
   * the included set — Aggregate's included entries, Single's one — read
   * once here for every tag in the app. */
  const tagScope = $derived({ included: connMode === 'aggregate' ? includedServers(serverList, excludedIds) : serverList.filter((s) => s.id === serverCurId) });
  /** What a server list row needs in Aggregate; null in Single. */
  const memberRows = $derived(connMode === 'aggregate' ? {
    included: (id) => !excludedIds.has(id),
    status: (id) => aggregate.status(id),
    ontoggle: (id, on) => { void setIncluded(id, on); },
    orphans: background.filter((r) => aggregate.orphan(r)).map((r) => {
      const st = aggregate.status(r.id);
      return { id: r.id, name: r.entry().name || hostLabel(r.entry().address), into: st?.kind === 'orphan' ? st.into : '' };
    }),
    ondismiss: (id) => { const r = background.find((x) => x.id === id); if (r && aggregate.orphan(r) && !membershipFrozen()) void askOrphan(r); },
  } : null);

  /** The bound runtime's socket closed under it. */
  function onDrop() {
    if (switching) return; // the switch is bringing another server up
    // The person chose to stay offline, or the migration is blocked:
    // nothing automatic dials. A drop while blocked is an interrupted
    // activation, which Retry owes its dial (orchestrator 16:12).
    if (heldOffline) return;
    if (migrationBlocked) { owedActivation = true; return; }
    // Keep connected=true during reconnect to avoid UI flicker
    reconnect().start();
  }

  function cancelReconnect() {
    reconnect().cancel();
    connected = false;
    live()?.disconnect();
    page = 'settings';
  }

  /** A background member's own loop answered (③b-1). An identity that could
   * not be recorded is the host gate's, as for the focused server. */
  function memberReconnected(runtime, result) {
    // A dead handle's loop is over with this answer (see `focusAbsorbed`).
    if (!runtime.alive()) forgetReconnector(runtime);
    if (!aggregate.holds(runtime)) return;
    // An attempt out when the app blocked brings nothing back.
    if (migrationBlocked) { runtime.connection.disconnect(); aggregate.blocked(runtime); return; }
    if (!result?.ok && result?.reason === 'unrecorded') { storageFailed(); if (migrationBlocked) aggregate.blocked(runtime); return; }
    loadServerRegistry();
    aggregate.answered(runtime, result);
  }

  /** A reconnect attempt of `runtime` answered. Its OWN dial already decided
   * who that was and recorded it (reviewer P1-A on cc45d7d1): a different
   * machine closed that socket before anything here ran, so no call of this
   * server's could reach it. */
  function onReconnected(runtime, result, attempt) {
    // (Still bound, if possibly detached: an alias identity repair just
    // absorbed is detached by its own dial, and the arrival below is what
    // brings its survivor up.)
    if (bound() !== runtime) { if (!runtime.alive()) forgetReconnector(runtime); return; }
    // An attempt already out when the migration blocked brings nothing up;
    // the block interrupted it, so Retry owes it its dial (orchestrator 16:12).
    if (migrationBlocked) { runtime.connection.disconnect(); connected = false; owedActivation = true; return; }
    if (!result?.ok && result?.reason === 'unrecorded') {
      // A peer authenticated and we could not establish which server it is.
      // That is never "the same server": its socket is closed, and the
      // person is told, exactly as the connect form does.
      reconnectError = t('configIdentityFailed');
      storageFailed();
      // An identity that could not be recorded because the app blocked — an
      // absorption whose merge failed, say — interrupted this reconnect:
      // Retry dials it again. An ordinary failure is the person's.
      if (migrationBlocked) owedActivation = true;
      connected = false;
      page = 'settings';
      return;
    }
    reconnectError = '';
    loadServerRegistry(); // the entry's active address may have moved
    // Another machine answered, or identity repair absorbed this entry into
    // its machine's survivor: the app ARRIVES where the dial landed, through
    // THAT server's own runtime — never by resuming this one over it.
    if (!result?.ok) { void arrivedElsewhere(result, attempt); return; }
    connected = true;
    serverInfo = { hostname: runtime.hostname(), machineId: runtime.machineId() };
    activeAddress = runtime.entry().address;
    void keepNavFor(runtime);
    resubscribeAll();
    serverReady();
    // Tell Terminal to reset stale resize state + re-fit against the server.
    announceReconnected();
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
  function serverReady(runtime = scopeSwap.bound()) {
    if (!runtime) return;
    const intent = serverSwitch.intent;
    // Still the app's to publish: the bound runtime while the switch owns the
    // intent, or a background member while Aggregate holds it (③b-1).
    const asked = runtime === scopeSwap.bound()
      ? () => serverSwitch.owns(intent) && scopeSwap.bound() === runtime
      : () => aggregate.holds(runtime);
    // Published as EACH answer lands (reviewer P2): the Hub shows when its own
    // probe answers, not after a slow backends list.
    void runtime.probeCaps((caps) => {
      if (!asked()) return; // asked of a server we have left
      if (caps.hub !== null) viewOf(runtime).hubState = { available: caps.hub, probed: true };
      // Into THIS runtime's catalog (board #335 ②b-3): the list is one
      // machine's answer, and its pages read it from their scope.
      serverStates.get(runtime)?.backends.set(caps.backends);
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
  /** Before an arrival replaces the tree that is bound, ask its pages (the
   * leave guards): true to go on, false when the person keeps editing — the
   * app then stays on the source, offline, with what was typed — and null
   * when another question is already open (a form's walk), whose answer
   * decides instead. ONE place for every automatic arrival — a reconnect
   * that landed on another machine and an absorption's survivor, Retry's
   * owed re-dial included (it lands here). A switch Retry resumes asked in
   * its own walk, before the block. */
  async function askToReplace(mine) {
    const leaving = scopeSwap.bound();
    if (!leaving) return true;
    if (serverSwitch.guarding) { connected = false; return null; }
    let leave = false;
    try {
      leave = await serverSwitch.guard(() => walkLeave(leaving));
    } catch { leave = false; }
    // An answer that came after someone else took over is nobody's: it
    // changes nothing here (reviewer P1 on 97824925) — the owner is checked
    // BEFORE a "keep editing" stays anything offline.
    if (!mine()) return null;
    if (!leave) {
      connected = false;
      heldOffline = true;
      page = 'settings';
    }
    return leave;
  }
  async function arrivedElsewhere(result, attempt, chain = null) {
    if (migrationBlocked) { connected = false; return t('migrationBlockedNote'); }
    // Someone took over since the dial (a newer connect, a switch): this
    // arrival is not the app's any more, the alias case included.
    if (!attempt.current()) return null;
    // Identity repair absorbed the entry we were on into the machine's
    // survivor, and CURRENT already names it: the SAME machine.
    const same = currentServerId(localStorage) === result.entry.id;
    // Either way a NEW tree replaces the one bound, so its pages are asked
    // first (#335 ③b-2) — the survivor of an absorption is a runtime of its
    // own, and an unsaved editor of the alias's would otherwise go with the
    // old tree in silence.
    const leave = await askToReplace(() => attempt.current());
    if (leave === null) return null;
    if (!leave) {
      reconnectError = same ? '' : t('serverAnsweredElsewhere').replace('{name}', result.entry.name || hostLabel(result.entry.address));
      return reconnectError || null;
    }
    // The same machine: its own runtime dials before anything comes up on
    // it (reviewer P1-B on cc45d7d1), keeping the tree until it is up — the
    // survivor adopts the replaced handle's Files record.
    if (same) return activate({ replace: false, up: () => { bringUp(); resubscribeAll(); }, chain }).done;
    // What a failure returns to: the server the tree is bound to — CURRENT
    // may already name the server the dial was meant for.
    const left = bound()?.id ?? '';
    try {
      const entry = result.entry;
      const act = activateConnected(localStorage, {
        address: entry.address, token: entry.token,
        ...(entry.socket ? { socket: entry.socket } : {}),
        ...(result.machineId ? { machineId: result.machineId } : {}),
      });
      const run = act.reload ? arriveAt(left, 'arrive', chain) : activate({ replace: false, up: () => { bringUp(); resubscribeAll(); }, chain });
      return await run.done;
    } catch { page = 'settings'; storageFailed(); return t('configIdentityFailed'); }
  }

  /** Come up on ANOTHER server, CURRENT already pointing at it: its own
   * runtime dials and is bound before the server left is ended (ruling (a),
   * 04:04), and if it does not come up CURRENT goes back to `left`, which is
   * still running. */
  function arriveAt(left, elsewhere = 'arrive', chain = null) {
    serverSwitch.supersede();
    const c = chain ?? newChain();
    // Back to the server left, which is still the one bound — unless the
    // migration froze CURRENT, or something else has been bound since.
    const back = () => {
      if (!left || migrationBlocked || bound()?.id !== left || currentServerId(localStorage) === mergedInto(localStorage, left)) return;
      try { restoreCurrent(localStorage, left); } catch { storageFailed(); return; }
      loadServerRegistry();
    };
    // Only for the chain that is still the app's: a cancel runs it only on
    // a chain it actually cancelled, and a failure only while the chain is
    // current — a newer bring-up (an arrival, a switch) concludes its own
    // (reviewer P1-C on cc45d7d1, P1-4 on 341554b3).
    c.onCancel(back);
    const run = activate({ replace: true, elsewhere, up: () => { bringUp(); resubscribeAll(); }, chain: c });
    const done = run.done.then((failure) => { if (failure && c.current()) back(); return failure; });
    return { done, cancel: run.cancel, current: run.current, committed: run.committed };
  }

  /** The connect page reached a server, and recorded which one. `switched`:
   * it is a DIFFERENT server than the current entry (activateConnected moved
   * CURRENT here), so the app comes up on it the way an in-place switch does
   * — memory reset, tree remounted, the target's own state restored —
   * instead of reloading (board 315).
   *
   * The form dialled its own CANDIDATE and has closed it (board #335 ②b-4):
   * what answered there proved nothing about the server's own connection,
   * which dials now, and ITS handshake is the identity of record. Returns the
   * activation, so the form stays busy through this second handshake, shows
   * its failure, and can cancel it (reviewer P1-D on cc45d7d1). */
  function onConnected(switched = false) {
    // The server the app was on — the one the tree is bound to — is what a
    // failed bring-up returns to (ruling (a)).
    const left = bound()?.id ?? '';
    reconnect().cancel();
    localStorage.removeItem('tmux_disconnected');
    loadServerRegistry();
    if (switched) return arriveAt(left);
    return activate({ replace: false, up: () => {
      connected = true;
      serverInfo = { hostname: live()?.getHostname() || '', machineId: live()?.getMachineId() || '' };
      activeAddress = bound()?.entry().address ?? '';
      void keepNavFor(scopeSwap.bound());
      // The device default (Chat), never a hard-coded Terminal (board #333);
      // a hubless server falls back to Terminal through the redirect above.
      page = defaultPage();
      // A manual connect reaches a server with EMPTY subscription state,
      // while Terminals stay mounted across the disconnect and keep their
      // refcounts — so their subscribe() calls will never re-send the wire
      // message themselves. Without this, the terminal shows a frozen
      // snapshot until a full reload. On a first-ever connect a no-op.
      resubscribeAll();
      serverReady();
      announceReconnected();
    } });
  }

  /** Runtimes minted for an activation and not shown yet, and the activation
   * that owns each (reviewer P1-C on cc45d7d1). A later activation that
   * reuses the same runtime TAKES it over, so the earlier one's cleanup can
   * never end what the later one is dialling or has shown. */
  const provisional = new Map();
  /** A bring-up the migration gate stopped before its runtime dialled: Retry
   * dials it (`retryMigration`). */
  let owedActivation = false;
  /** Let go of a runtime this activation minted and did not show — only if
   * it still owns it. */
  function releaseMinted(runtime, owner) {
    if (provisional.get(runtime) !== owner) return;
    provisional.delete(runtime);
    if (scopeSwap.bound() === runtime) return;
    // A background member a failed switch reused stays the member it was (③b-1).
    if (aggregate.holds(runtime)) return;
    forgetReconnector(runtime);
    if (fleet.get(runtime.id) === runtime) fleet.drop(runtime.id);
    else void ends.end(runtime);
  }

  /** ONE user activation, end to end (reviewer P1-4 on 341554b3). A
   * bring-up can hand over to another before it is done — its dial found
   * another machine (an arrival), or taught the gate a merge or a claim (a
   * fresh mint) — and every such link joins THIS chain: the caller's `done`
   * waits for the last link, its `cancel` reaches whichever link is out, and
   * it is `current` only while that link is. Once a link has published its
   * runtime, a cancel undoes nothing: that runtime is bound. */
  function newChain() {
    let owner = null;
    let runtime = null;
    let published = false;
    let cancelled = false;
    const undo = [];
    let commit = () => {};
    /** Resolves at the point of no return: a link is publishing its
     * runtime, and a cancel undoes nothing from here — so a caller stops
     * offering one (reviewer P2 on 027d1a92). */
    const committed = new Promise((resolve) => { commit = resolve; });
    return {
      committed,
      link(nextOwner, nextRuntime) { owner = nextOwner; runtime = nextRuntime; },
      publishing() { published = true; commit(); },
      onCancel(fn) { undo.push(fn); },
      current: () => !cancelled && !!owner?.current(),
      cancel() {
        if (published || cancelled) return;
        // Was this chain still the app's? Only then does its cancel undo
        // anything: a chain a newer bring-up replaced is that one's to
        // conclude (reviewer P1-C on cc45d7d1).
        const mine = !!owner?.current();
        cancelled = true;
        // The window's attempts and the server this chain was bringing up —
        // no other member's (reviewer P1-3: a local cancel is not the root's
        // end, which `endAll()` stays for: the teardown and a block).
        if (mine) activations.claim(runtime);
        // Let go of the runtime the link out minted, now: its dial may never
        // answer, and a connection nobody waits on must not stay open
        // (reviewer P1-D on cc45d7d1) — unless another activation has since
        // reused it (`releaseMinted`). A kept runtime's own dial closes its
        // unverified socket when it answers (server-runtime, P1-1).
        if (runtime && owner) releaseMinted(runtime, owner);
        if (mine) for (const fn of undo) fn();
      },
    };
  }

  /**
   * Bring CURRENT up through its OWN runtime (board #335 ②b-4): mint it,
   * claim the app's activation, DIAL its connection, pass the storage gate
   * for what that dial learned, and only then publish it — bind, reset, `up`.
   * Every way the app comes up on a server goes through here — the boot, the
   * connect form, a switch, an arrival elsewhere, a merge (reviewer P1-B on
   * cc45d7d1): nothing is bound to a runtime whose connection has not
   * authenticated, or whose server's storage could not be recorded
   * (reviewer P1-3 on 341554b3).
   *
   *   `replace`   another server: the server left stays as it is until this
   *               one is up, then its navigation resets and the swap ends it
   *               — release, then dispose (ruling (a), 04:04);
   *   `elsewhere` what to do if this dial reaches ANOTHER machine: 'arrive'
   *               there (its handshake is the identity of record), or 'fail'.
   *   `chain`     the activation this link continues (`newChain`).
   *
   * Returns `{ done, cancel, current }`: `done` resolves null once the
   * chain's runtime is BOUND and `up` has run, or the reason it was not; a
   * superseded chain resolves null and changes nothing.
   */
  function activate({ replace = false, elsewhere = 'arrive', up, minted = null, chain = null }) {
    // Holds the window until this link is done (P1-B): a question owed
    // meanwhile waits, since asking would claim the window and end this.
    const release = leaseWindow();
    const c = chain ?? newChain();
    const m = minted ?? mintCurrent();
    const runtime = m.runtime;
    // Claimed AFTER the mint, whose claim makes every older attempt stale:
    // this one is the latest from here (reviewer P1-C — never the reverse).
    // It acts on the server bound now: that one's reconnect ends with it.
    const owner = activations.claim(scopeSwap.bound());
    c.link(owner, runtime);
    // A cancelled activation owns the window no more, whenever its dial
    // settles (a cancelled socket may never answer).
    const handle = (done) => ({ done, cancel: () => { c.cancel(); release(); }, current: c.current, committed: c.committed });
    if (!runtime) {
      // Nothing to bind. Blocked: the gate's one blocked state, which keeps
      // the source (`enterBlocked`; ruling K, reviewer on 027d1a92), and
      // Retry owes this activation its dial. Not blocked, CURRENT names no
      // saved server: there is nothing to keep showing.
      if (migrationBlocked) { enterBlocked(); owedActivation = true; }
      else if (!m.keep) void scopeSwap.swap(null);
      release();
      return handle(Promise.resolve(migrationBlocked ? t('migrationBlockedNote') : t('configIdentityFailed')));
    }
    if (!m.keep) provisional.set(runtime, owner);
    const done = runtime.dial(owner.current).then(async (result) => {
      if (!owner.current()) { releaseMinted(runtime, owner); return null; }
      if (!result.ok) {
        releaseMinted(runtime, owner);
        if (result.reason === 'superseded') return null;
        if (result.reason === 'elsewhere') {
          loadServerRegistry();
          if (elsewhere === 'arrive') return arrivedElsewhere(result, owner, c);
          return t('serverAnsweredElsewhere').replace('{name}', result.entry.name || hostLabel(result.entry.address));
        }
        if (!replace) { connected = false; page = 'settings'; }
        return String(result.error?.message || result.error || result.reason);
      }
      // The dial taught the gate this server's machine: it may now claim
      // pending inputs or rewrite a merge's navigation. Those writes pass
      // BEFORE anything is published (reviewer P1-3 on 341554b3).
      const gate = foldCurrent();
      if (gate.fold === 'blocked') return blockedAfterDial(runtime, owner);
      if (gate.id !== runtime.id || (gate.fold === 'claimed' && m.keep)) {
        // CURRENT names another entry now (a merge), or the inputs were just
        // filed into the slots a SHOWN runtime read at init: a fresh
        // runtime, which dials first, like any other — the next link.
        releaseMinted(runtime, owner);
        return activate({ replace, elsewhere, up, minted: mintFrom(gate), chain: c }).done;
      }
      // Claimed for a runtime nobody has shown: its state is simply rebuilt
      // from the slots the claim just filled.
      if (gate.fold === 'claimed') serverStates.set(runtime, stateFor(runtime.id));
      c.publishing();
      provisional.delete(runtime);
      // Only now is the server left given up (ruling (a)): the swap ends it,
      // release first — and asks whether this runtime ADOPTED its state
      // first, so a same-machine merge keeps its downloads. The navigation
      // that named the old server resets in this same turn, before the new
      // tree can mount on it (board 315).
      const swapped = m.keep ? Promise.resolve() : scopeSwap.swap(runtime);
      if (replace) {
        resetServerMemory();
        centreSurface.reset();          // the bell and a jump aimed at the server left
      }
      // And the activation is DONE only once that bind has finished.
      await swapped;
      if (!owner.current() || scopeSwap.bound() !== runtime) return null;
      up(result);
      return null;
    }).catch(() => {
      // The dial resolves every connect failure; what rejects is the
      // identity record, and the dial has already closed that socket. The
      // host gate classifies it — for the activation that is still the app's.
      releaseMinted(runtime, owner);
      if (!owner.current()) return null;
      page = 'settings';
      storageFailed();
      return t('configIdentityFailed');
    });
    void done.finally(release);
    return handle(done);
  }
  /** The dial authenticated, and the storage gate for what it learned could
   * not be recorded (reviewer P1-3 on 341554b3; ruling K, 06:09). Nothing of
   * it is published: the runtime it minted is let go of. Nothing is ENDED
   * because of the block either: the runtime the tree is bound to — the
   * server being left, or a boot's own — stays bound and running, its
   * downloads included, and the tree simply does not render while blocked.
   * Retry owes this activation its dial, and the server left is ended only
   * once the next runtime has passed its handshake and every gate. */
  function blockedAfterDial(runtime, owner) {
    releaseMinted(runtime, owner);
    owedActivation = true;
    enterBlocked();
    return t('migrationBlockedNote');
  }
  /** The ONE blocked state, however the app got there — before a dial, after
   * one, or from the host gate (ruling K, reviewer 06:09 and on 027d1a92).
   * The source is KEPT: the runtime the tree is bound to stays bound,
   * running and in the fleet, its downloads included, so nothing is ended
   * because of the block; it is ended only once the next runtime has passed
   * every gate. What the block takes away is the VIEW — no server tree
   * renders, and no guest editor mounts, while `migrationBlocked` holds —
   * and every automatic dial. A first boot has no source: an empty view. */
  function enterBlocked() {
    reconnect().cancel();
    connected = false;
    page = defaultPage();
  }

  function openTerminal(session, target) {
    const from = page;
    showPane(session, target);
    page = 'terminal';
    navPush();
    if (from === 'hub') view.jumpedFrom = 'hub';
  }

  // The shown pane died (Ctrl-D, process exit). Stay in the terminal and
  // fall back to the previous pane of the same session — switcher order,
  // nearest below the closed window/pane index, else the first after it.
  // Only when the session has no panes left (or is gone entirely) return
  // to Sessions, and only if the user is actually looking at the terminal:
  // pane_closed can arrive while they're on another tab (Terminal stays
  // mounted in a hidden page-layer), and yanking them out of Files for a
  // background pane death would be hostile.
  async function paneExitFallback(closed, runtime = bound(), v = view) {
    let remaining = [];
    try {
      const m = /:(\d+)\.(\d+)$/.exec(closed || '');
      const cw = m ? Number(m[1]) : -1;
      const cp = m ? Number(m[2]) : -1;
      remaining = (await runtime.api.listPanes(v.terminalSession))
        .filter((p) => `${p.session}:${p.window}.${p.pane}` !== closed)
        .sort((a, b) => a.window - b.window || a.pane - b.pane);
      const before = remaining.filter((p) => p.window < cw || (p.window === cw && p.pane < cp));
      const pick = before[before.length - 1] || remaining[0];
      if (pick) {
        showPaneIn(runtime, v, pick.session, `${pick.session}:${pick.window}.${pick.pane}`);
        return;
      }
    } catch {} // list_panes fails when the whole session died with the pane
    showPaneIn(runtime, v, '', '');
    // Nothing left to show: the empty state offers the session list (which
    // used to BE the fallback page).
    if (v === view && page === 'terminal' && layout.isTouchDevice) sessListOpen = true;
  }

  function doDisconnect() {
    reconnect().cancel();
    live()?.disconnect();
    connected = false;
    page = 'settings';
    const id = currentServerId(localStorage);
    if (id) createServerStore(localStorage, id, writeGate).removeItem('tmux_state');
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
    // The registry is frozen while the migration is blocked; this runs
    // again once it is not.
    if (!hostname || migrationBlocked) return;
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

  // Frozen with the rest of the registry while the migration is blocked.
  function serverRename(id, name) { if (!migrationBlocked) serverList = renameServer(localStorage, id, name); }
  async function serverRemove(id) {
    if (migrationBlocked) return;
    // Removing a member destroys its tree (#335 ③b-2): that tree's guards
    // are asked first, on its own tree; "keep editing" keeps the server.
    const member = aggregate.runtimes().find((r) => r.id === id);
    if (member && !(await serverSwitch.guard(() => walkLeave(member)))) return;
    if (migrationBlocked) return;
    // Asked and answered: the member leaves NOW, before its entry goes, so
    // the sync that follows finds nothing to orphan.
    if (member) aggregate.leave(member.id);
    serverList = removeServer(localStorage, id);
    serverCurId = currentServerId(localStorage);
  }
  /** A row of the server list was picked. */
  function doServerSwitch(id) {
    const target = loadServers(localStorage).find((s) => s.id === id);
    if (!target) { loadServerRegistry(); return; } // stale row (entry vanished)
    // Aggregate never falls back to the Single switch for a saved server
    // (orchestrator 02:28 and 03:23; reviewer P1-1 on 99566068): that switch
    // REPLACES the focused tree, so a pick is a focus move or nothing.
    if (connMode === 'aggregate' && scopeSwap.bound()) { pickMember(target); return; }
    void switchTo(target);
  }
  /** Aggregate: a row was picked. A connected member becomes the focus (D2).
   * Any other server is not a focus change: the app STAYS where it is and
   * the row shows that server's own state — an excluded one is included,
   * and joins as a member through its own dial; one still connecting or
   * failing keeps its own loop. The person focuses it once it is up. */
  function pickMember(target) {
    if (target.id === currentServerId(localStorage)) { serverMenuOpen = false; return; }
    const moved = focusMember(target.id);
    if (moved === true) return;
    if (moved === 'failed') return;
    // An excluded pick is an INCLUDE, with the include's own checks and
    // failure handling (reviewer P1-1 on 3a0b4feb): never a bare write.
    const notConnected = () => { membershipError = t('memberNotConnected').replace('{name}', target.name || hostLabel(target.address)); };
    if (excludedIds.has(target.id)) { void setIncluded(target.id, true).then((ok) => { if (ok) notConnected(); }); return; }
    notConnected();
  }
  /** Aggregate: move the focus onto member `id`, which is already up with
   * its own tree (#335 D2). CURRENT and the active mirror name it, its tree
   * comes to the front and the one that was focused stays mounted, up, as a
   * member — nothing dials, nothing is torn down, so no leave walk runs and
   * no draft is at stake. Returns true when the focus moved; 'failed' when
   * its storage commit failed and NOTHING moved (CURRENT, the mirror and the
   * front all as they were; the host gate is told); false when this is not
   * such a move (Single, a member not connected, a switch or a walk in
   * progress, blocked).
   *
   * One commit (reviewer P1-3 on 99566068): everything that could refuse is
   * checked before anything is written; storage commits with CURRENT last
   * (`focusServer`); then every window attempt still aimed at the server
   * left goes stale — the switch's intent (a late optimizer probe of A's
   * addresses must not redial over B) and the window activation — while
   * each member's OWN reconnect is untouched; only then does the front move. */
  function focusMember(id) {
    if (readMode(localStorage) !== 'aggregate' || migrationBlocked || switching || serverSwitch.guarding) return false;
    const next = aggregate.runtimes().find((r) => r.id === id);
    const left = scopeSwap.bound();
    if (!next || !left || next === left || !next.connection.isConnected() || scopeSwap.shown() !== left) return false;
    try {
      if (!focusServer(localStorage, id)) return false;
    } catch {
      membershipError = t('serverFocusFailed');
      storageFailed();
      loadServerRegistry();
      return 'failed';
    }
    serverSwitch.supersede();
    activations.claim();
    scopeSwap.refocus(next);
    aggregate.handOver(next);
    aggregate.adopt(left, left.connection.isConnected());
    serverMenuOpen = false;
    membershipError = '';
    reconnectError = '';
    reconnecting = false;
    heldOffline = false;
    serverInfo = { hostname: next.hostname(), machineId: next.machineId() };
    activeAddress = next.entry().address;
    loadServerRegistry();
    syncMembers();
    return true;
  }

  // While the leave guards are asked, Settings stays mounted even when another
  // page is revealed: its Agents editor may not have answered yet (board 315).
  let holdPages = $state(false);
  /** Preferences stays mounted (hidden) once it holds a server's guest
   * editor (③a, reviewer P1-1): the guest's life is its member's, so
   * leaving the page — by hand, or a block moving it — must not destroy a
   * draft in it. Before any guest exists it mounts on demand, as always. */
  let prefsKept = $state(false);
  $effect(() => {
    if (page === 'prefs' && hubEligible && agentsLivesInSettings(layout.isTouchDevice)) prefsKept = true;
  });
  /** What both server lists show about the connection (ServerList `link`). */
  const serverLink = $derived({
    connected: connected && !reconnecting,
    target: switching ? { id: switching.target.id, failed: switching.phase === 'failed' } : null,
  });
  /** Bring a hidden guarded page into view so its own dialog asks there. */
  async function revealPage(next) {
    if (page !== next) { page = next; await tick(); }
  }
  /** The ONE leave walk (board 315; per (runtime, view) since #335 ③b-2):
   * ask the guards of `leaving` — the tree about to be destroyed, and only
   * it — where they live. A background member is brought in front for the
   * walk (`revealed`), each guard's page is revealed in THAT tree, and when
   * the walk ends, either way, the page, the front and the focus are back as
   * they were: a cancel loses no other tree's navigation or drafts. */
  function walkLeave(leaving) {
    return confirmLeave({
      leaving, current: page, reveal: revealPage,
      hold: (on) => { holdPages = on; revealed = on && leaving && leaving !== scopeRuntime ? leaving : null; },
    });
  }

  /** A landing is delivered only to the tree it NAMES (board #335 ②b-2).
   * The swap clears the ones aimed at a tree that is going away, and this is
   * the other half: a request that somehow outlived its tree — or arrives
   * while another server is bound — is not handed to the pages of a server it
   * was never about. */
  function landingFor(request, runtime) {
    return request && runtime && request.serverId === runtime.id ? request : null;
  }

  /** Requests aimed at the server-bound tree: a Files or Board jump from the
   * Hub, an agent to open in the editor, the breadcrumb back to where the
   * jump came from. They name a tree, so when that tree is replaced they are
   * not stale data to be refreshed — they are addressed to something that no
   * longer exists, and the swap clears them between the teardown and the new
   * mount (board #335 ②b-1). `resetServerMemory` calls this rather than
   * repeating it, so "what a landing is" has one definition. */
  function clearLandings() {
    view.filesNavReq = null; view.boardIssueReq = null; view.agentsEditReq = null; view.hubSelectReq = null;
    view.jumpedFrom = null;
  }

  /** Everything in memory that belongs to the server being left (board 315),
   * reset AFTER the content tree is gone and the socket closed. The rest of
   * the per-server state is in that server's slots and its runtime's state
   * bundle; components and
   * their ws.ts listeners/subscriptions went with the unmount. A source test
   * pins this list against the module-level stores. */
  function resetServerMemory() {
    // Not a revoke (board #335 ②b-4): this runs once the next server is up
    // and bound, and the swap that bound it ends the one left — after the
    // next one could adopt its state, which a same-machine merge does.
    heldOffline = false;               // the person chose another server
    scratchOpen = false;                // the panel closes; its Terminal goes with the keyed tree
    hoverCard.hide();                   // a card may describe the old server's row
    serverInfo = { hostname: '', machineId: '' };
    pendingAddress = '';
    // The pane, split, Files session and Hub answer are the VIEW's, and the
    // view is the runtime's (③a-4): this runs after the swap, so `view` is
    // already the next server's own, fresh one — clearing it here cleared
    // nothing (validator P2-1 on 6b923c0d: its two controls could not bite).
    clearLandings();
    sessListOpen = false;
    // And nothing saves that emptiness over a server's record until its
    // restore has run: Back from a failed switch comes up on the SAME
    // runtime it left (order (a)), whose save gate was still open, and the
    // reset navigation overwrote A's slot before the restore read it
    // (reviewer 04:05 on the switch order).
    view.navRestored = null;
  }

  // THE server switch (board 315): every entry — the switcher popover,
  // Settings › Connection, Add server, the panel's Retry and Back — goes
  // through server-switch.ts, which owns the order and the source/candidate
  // split. App supplies the effects: the content tree unmounts while
  // `switching` is set, and `comeUp` binds it to the target's runtime handle
  // (board #335 ②b-1) — a failed switch's Back keeps the handle it had,
  // because Back returns to the server it left.
  let switchCandidate = null;
  const serverSwitch = createServerSwitch({
    storage: localStorage,
    connected: () => connected,
    currentId: () => serverCurId,
    currentName: () => serverName,
    confirmLeave: () => walkLeave(scopeSwap.bound()),
    // An address change claims the app's activation (app/activation.ts),
    // acting on the bound server.
    claim: () => activations.claim(scopeSwap.bound()),
    stopReconnect: () => reconnect().cancel(),
    startReconnect: () => { if (!migrationBlocked) reconnect().start(); },
    // While the migration is blocked nothing moves CURRENT (orchestrator,
    // 21:45): no switch, no address connect.
    frozen: () => migrationBlocked,
    identityFailed: storageFailed,
    // The window went quiet: an orphan owed its ask is asked (P2 on e0dafe3c).
    onidle: scheduleAsk,
    addressUp: () => {
      // The dial recorded the address on the entry; the shell follows it.
      const runtime = bound();
      serverInfo = { hostname: runtime?.hostname() || '', machineId: runtime?.machineId() || '' };
      loadServerRegistry();
      activeAddress = runtime?.entry().address ?? activeAddress;
      resubscribeAll();
      announceReconnected();
    },
    onstate: (st) => {
      switching = st;
      if (st) { serverMenuOpen = false; connected = false; }
    },
    // A switch dials the target as a CANDIDATE (board #335 ②b-4): its own
    // connection, recorded by machine, closed, and then the target's own
    // runtime dials — the same road the connect form takes.
    disconnect: () => { switchCandidate?.close(); switchCandidate = null; },
    connect: (address, token) => { switchCandidate = openCandidate(); return switchCandidate.connect(address, token); },
    setSocket: (socket) => switchCandidate?.setSocket(socket) ?? Promise.resolve(),
    machineId: () => switchCandidate?.machineId() || '',
    // Another address of the CURRENT server: its OWN runtime dials it and
    // checks the answer is still this server (reviewer P1-A on cc45d7d1).
    redial: (address, owns, owner) => {
      const runtime = bound();
      if (!runtime) return Promise.reject(new Error('not connected'));
      // The attempt's own ownership, all the way into the dial and its
      // record (reviewer P1-2 on 341554b3): "A is still bound" is not it —
      // a newer form connect or activation leaves A bound and makes this
      // attempt stale.
      const mine = () => owns() && bound() === runtime;
      return runtime.dial(mine, { via: address }).then((result) => {
        if (result.ok) return 'up';
        if (result.reason === 'elsewhere') {
          if (!mine()) return 'handled';
          loadServerRegistry();
          void arrivedElsewhere(result, owner);
          return 'handled';
        }
        throw result.error ?? new Error(result.reason);
      }, () => { if (mine()) storageFailed(); return 'handled'; });
    },
    comeUp: () => {
      switchCandidate?.close();
      switchCandidate = null;
      loadServerRegistry();
      addrSetVersion++;
      // B's own runtime dials and is bound before A is ended (ruling (a));
      // the switch puts CURRENT back on A if it does not come up.
      const run = activate({ replace: true, elsewhere: 'fail', up: () => { bringUp(); resubscribeAll(); } });
      return run.done;
    },
  });
  // No switch while the fold is unrecorded: there is no server state to
  // arrive with.
  const switchTo = (target) => serverSwitch.switchTo(target);
  // App's own end (reviewer P2-1 on cc45d7d1): every resource it holds has
  // an owner here, so nothing outlives the shell — the candidates; every
  // activation in flight; every runtime's reconnect loop, stopped NOW with
  // its timers cleared (a stale claim alone would only end a loop at its
  // next timer, reviewer P2 on 341554b3); and every runtime in the fleet,
  // the bound one included (the fleet skips it on purpose, because the swap
  // that replaces it normally ends it; there is no next swap now).
  onDestroy(() => {
    ended = true;
    owedHandover = null;
    orphansToAsk.clear();
    clearTimeout(askTimer);
    askTimer = 0;
    candidateOpen?.close();
    switchCandidate?.close();
    activations.endAll();
    for (const machine of reconnectors.values()) machine.cancel();
    reconnectors.clear();
    const held = scopeSwap.bound();
    aggregate.leaveAll();
    fleet.dropAll();
    if (held) void ends.end(held);
  });
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
    const current = bound()?.entry().address ?? activeAddress;
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
      // Its OWN runtime dials it and checks the answer (connectAddress); a
      // failure restarts the reconnect loop — only while this attempt still
      // owns the activation.
      await serverSwitch.connectAddress(best);
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
    } catch { storageFailed(); }  // the saved connection stays as it was
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
  /** The boot dial has been tried; the migration gate re-arms it. */
  let autoConnectAttempted = false;
  /** Everything the boot needs written before a server may be bound, in its
   * order: the registry, then the inputs' attribution. Safe to run again —
   * each step is idempotent — which is what Retry does. */
  function prepareStorage() {
    try {
      migrateServers(localStorage);
      if (migrateServerState(localStorage).reason === 'unrecorded') holdStorage();
      // Recorded is not yet released: the gate opens in `foldCurrent`, after
      // the claim, so what it held never lands before the fold it waited on.
      else migrationBlocked = false;
    } catch { holdStorage(); }
    loadServerRegistry();
  }
  /** An identity or registry write failed somewhere — a form connect, the
   * boot dial, a reconnect, an arrival, a switch, an address change (reviewer
   * P1 on 23879812; orchestrator 23:44). The ONE host gate decides what it
   * means, by the migration state rather than the error: it runs the same
   * preparation the boot and Retry run, and if that cannot be recorded — an
   * open handoff that still cannot be finished, a registry that cannot be
   * written — the app is blocked HERE, in this turn: the server tree unbinds,
   * CURRENT and the registry freeze, and Retry is offered. Otherwise it was
   * an ordinary failure and the caller's own error stands. When it blocks,
   * the boot dial is re-armed, so Retry brings the connection back. */
  function storageFailed(switchTarget = null) {
    if (migrationBlocked) return;
    prepareStorage();
    if (!migrationBlocked) return;
    autoConnectAttempted = false;
    // A switch that hit it is the gate's to resume after Retry (reviewer P1
    // on af59fb5d): its target is kept here, and the switch shows nothing.
    if (switchTarget) deferredSwitch = switchTarget;
    // The one blocked state, which keeps the source (ruling K): never an
    // unbind, which would end the server the app is on.
    const wasConnected = connected;
    enterBlocked();
    // Disconnected, the Retry is on the connect card.
    if (!wasConnected) page = 'settings';
  }
  /** A switch the gate blocked, resumed by Retry through the switch itself. */
  let deferredSwitch = null;
  /** Before server `id`'s state is built: `claimed` when a pending input
   * was just filed into its slots, `blocked` when the migration cannot be
   * recorded (and then nothing is bound), else `ok`. A blocked app stays
   * blocked here: only Retry prepares the migration again. */
  function foldFor(id) {
    // A block is the whole app's until Retry (reviewer P1 on 453f02b8): a
    // later gate — another member's join — never re-prepares it open.
    if (migrationBlocked) return 'blocked';
    let reason;
    try {
      reason = migrateServerState(localStorage).reason;
      if (reason === 'pending') {
        const claim = claimPending(localStorage, id).reason;
        reason = claim === 'folded' ? 'claimed' : claim;
      }
    } catch { reason = 'unrecorded'; }
    if (reason === 'unrecorded') { holdStorage(); return 'blocked'; }
    return reason === 'claimed' ? 'claimed' : 'ok';
  }
  /** A deep link that arrived while the migration was blocked: parsed and
   * stripped from the address bar at once, APPLIED only once the migration
   * is recorded — applying it makes its server current, and the inputs must
   * be attributed first (reviewer P1-a on cf7e7957). */
  let deferredLink = null;
  /** Retry: finish what the migration could not record, then resume the
   * bind — and the CONNECTION, by its actual state (reviewer P1-2 on
   * 08fdb6ba): storage that worked again is not a socket that did. Never
   * connected (blocked at boot): the boot dial runs now that nothing blocks
   * it. Connected and the socket alive: the server comes up on it, no new
   * dial. Connected but the socket dropped while blocked (its reconnect was
   * frozen): the navigation is restored, and the reconnect loop brings the
   * socket back, through the same handover as any other drop. */
  function retryMigration() {
    prepareStorage();
    if (migrationBlocked) return;
    // The preparation may have finished a merge a failure left open, into a
    // survivor that is alive (board #335 ③b): every live state re-reads.
    for (const runtime of fleet.all()) { const state = serverStates.get(runtime); if (state) reloadStored(state); }
    // What the gate kept is consumed only once nothing blocks it any more
    // (reviewer P1 on fedd17eb): the link once applying it did not block,
    // the switch once the bind did not — a failure there blocks again, and
    // the next Retry still has them.
    if (deferredLink) {
      const link = deferredLink;
      applyConnectLink(link);
      if (migrationBlocked) return;
      deferredLink = null;
      loadServerRegistry();
    }
    // Minted, not shown: a runtime the block stopped before its own dial
    // dials before anything is bound to it (reviewer P1-B on cc45d7d1).
    const minted = mintCurrent();
    if (migrationBlocked) return;
    // Every member the block or an absorption interrupted dials again
    // (orchestrator 16:12): a handle that is no longer alive is replaced and
    // joins afresh through the set's sync, and a published member that is
    // not answering is redialled by its own loop.
    syncMembers();
    aggregate.resume();
    if (deferredSwitch) { const target = deferredSwitch; deferredSwitch = null; void switchTo(target); return; }
    if (!minted.runtime) return;
    // The focus. What it is owed follows from what the block interrupted,
    // never from whether its handle happens to be alive: a session that was
    // up stays up, and an activation the block or an absorption stopped —
    // a switch, a connect that had recorded its server, a reconnect, a drop
    // while blocked — is owed one dial. A form whose own identity write
    // failed is the person's to connect again, and the boot dial, re-armed
    // by the gate, does its own.
    const owed = owedActivation && !heldOffline;
    owedActivation = false;
    if (minted.keep && connected) {
      // The block came mid-session on the server the tree is bound to: up
      // still, or its own loop dials it (a drop while blocked).
      void restoreNavFor(minted.runtime);
      if (minted.runtime.connection.isConnected()) serverReady();
      else if (!heldOffline) reconnect().start();
      return;
    }
    if (!owed) return;
    autoConnectAttempted = true;
    arriveOn(minted);
  }
  /** Bring CURRENT up on the runtime minted for it, replacing whatever tree
   * is bound: Retry's owed arrival, and an owed focus handover with no
   * member to hand to. A NEW runtime replaces what the app showed (a
   * switch's source, a detached alias): its navigation resets once this one
   * is up. It replaces a tree kept mounted, drafts and all — an alias's
   * whose absorption already moved CURRENT to the canonical, say (reviewer
   * P1 on 97824925): that tree's pages are asked first, as every automatic
   * arrival asks. The minted runtime waits, owned by this arrival. */
  function arriveOn(minted) {
    const arrive = () => void activate({ minted, replace: !minted.keep, up: () => { bringUp(); resubscribeAll(); } }).done;
    const leaving = scopeSwap.bound();
    if (minted.keep || !leaving || leaving === minted.runtime) { arrive(); return; }
    const owner = activations.claim();
    provisional.set(minted.runtime, owner);
    void askToReplace(() => owner.current()).then((leave) => {
      if (leave) { arrive(); return; }
      releaseMinted(minted.runtime, owner);
    });
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

  /** Bring the app up on the server the bound runtime's own dial just
   * authenticated and recorded (`activate`): ask what it hosts, and restore
   * its navigation. The identity is the dial's (board #335 ②b-4) — nothing
   * here reads a mirror or records a second time. */
  function bringUp() {
    const runtime = bound();
    connected = true;
    serverInfo = { hostname: runtime?.hostname() || '', machineId: runtime?.machineId() || '' };
    activeAddress = runtime?.entry().address ?? activeAddress;
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
    view.navRestored = target;
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
  /** Fill ONE tree's view from its server's saved navigation (③b-1): the
   * pane and the split, filtered to this runtime, and dropped again if its
   * session has gone. The focused restore and a background member's both go
   * through here; only the focused one also restores the PAGE, which is the
   * window's. `owns` says whether the answer about the session is still for
   * this tree. Returns the record. */
  function fillViewFrom(target, v, owns) {
    const s = navFor(readNav(createServerStore(localStorage, target.id, writeGate)), target.id);
    // A saved target names a session that may not exist any more — killed
    // while we were away, or RENAMED (a project rename renames its session).
    // Restoring it anyway lands the user on a pane that cannot be captured,
    // so check first and come back to the tab without a target instead.
    if (s.pane) {
      const named = s.pane.session;
      target.api.listSessions()
        .then((sessions) => {
          if (!owns()) return; // not this tree any more
          // list_sessions answers with a bare array (list_sessions_with_panes
          // is the one that wraps).
          if (!(sessions ?? []).some((x) => x.name === named)) {
            v.termPane = null;
            v.splitCells = v.splitCells.filter((c) => c.pane?.session !== named);
          }
        })
        .catch(() => {});
      v.termPane = s.pane;
      // Restore split layout only on eligible (desktop + wide) clients;
      // a desktop-saved state silently stays single-pane on a phone.
      if (splitEligible && s.splitLayout > 1 && s.splitCells.length) {
        v.splitCells = s.splitCells;
        v.splitLayout = s.splitLayout;
        nextCellId = Math.max(0, ...s.splitCells.map((c) => c.id)) + 1;
        v.activeCellId = s.splitCells[0]?.id ?? null;
      }
    }
    if (v !== view) v.navRestored = target;
    return s;
  }

  async function restoreNavFor(target) {
    await scopeSwap.settled();
    if (!target || scopeSwap.shown() !== target) return;
    const intent = serverSwitch.intent;
    try {
      // Read from THIS server's slot, which is what makes it this server's
      // (board #335 ②b-4), then filtered to this runtime: a v2 pane that
      // names another server cannot be resolved over this connection — at
      // best the capture fails, at worst that server has a pane by the same
      // name and the reader lands on a stranger's terminal.
      const s = fillViewFrom(target, viewOf(target), () => serverSwitch.owns(intent));
      // The tab is restored whether or not a terminal came with it; only an
      // unknown name falls back to the device default. On touch a saved
      // `agents` resolves to Settings opened at its Agents category — there is
      // no Agents tab to land on there. The tab is the PERSON's, so it
      // survives even when nothing could be attributed to a server.
      const nav = restoreNav(s.page, layout.isTouchDevice);
      page = nav.page;
      if (nav.settingsTab) prefsOpenReq = { tab: nav.settingsTab, n: ++prefsOpenSeq };
    } catch { page = defaultPage(); }
    view.navRestored = target;
  }

  // Auto-reconnect and restore state on page load (`autoConnectAttempted`,
  // declared beside the migration gate, which re-arms it).

  // Detect app resume (Android background → foreground) + periodic optimize
  $effect(() => {
    const handler = () => {
      // Not while a leave walk asks about the socket, and not after the
      // person chose to stay offline (reviewer P2 on 085b0e70).
      if (document.visibilityState !== 'visible' || switching || serverSwitch.guarding || heldOffline || migrationBlocked) return;
      if (!live()?.isConnected() && !reconnect().isActive()) {
        reconnect().start();
      } else if (live()?.isConnected()) {
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
      if (!switching && !serverSwitch.guarding && live()?.isConnected() && Date.now() - lastProbeTime > OPTIMIZE_INTERVAL_MS) {
        optimizeConnection();
      }
    }, OPTIMIZE_INTERVAL_MS);
    return () => { document.removeEventListener('visibilitychange', handler); clearInterval(interval); };
  });

  $effect(() => {
    // Not while the migration is blocked; Retry unblocks it and this runs.
    if (autoConnectAttempted || connected || switching || migrationBlocked) return;
    // Where: the CURRENT entry's own route (board #335 ②b-4, reviewer P2 on
    // cf7e7957 and P1-A on cc45d7d1) — never a mirror an unanswered form left.
    const route = targetOf(localStorage, currentServerId(localStorage));
    if (!route?.address || !route.token) return;
    if (localStorage.getItem('tmux_disconnected')) return;
    autoConnectAttempted = true;

    const timeout = setTimeout(() => { page = 'settings'; }, 5000);

    // CURRENT's own runtime dials, through the one road every bring-up takes
    // (`activate`): its attempt identity, its identity record, and the app's
    // activation claimed after the mint, so a later attempt — the connect
    // form, a reconnect, a switch — makes this one a no-op.
    const run = activate({ replace: false, up: () => { bringUp(); } });
    run.done.then((failure) => {
      clearTimeout(timeout);
      if (failure) page = 'settings';
    });
  });
  // Android back gesture via history API
  // Every navigation push a state, back pops it naturally
  // The pages' back chains are the view's (Files' reading mode, board #226,
  // is too: the tab bar hides while it is on). Preferences is the person's.
  let prefsGoBack = $state(null);
  // A request from the Hub's agent menu to open one agent's CONFIG editor is
  // the view's `agentsEditReq`: {name, n} — n increments so asking for the
  // same agent twice still fires.
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
  function openAgentsConfig(name = null, kind = 'agent', runtime = bound(), v = view) {
    // Named for the tree that asked (③a, reviewer P1-1): only that server's
    // editor takes it, on touch (Preferences' guest) as on the desktop page.
    if (name && runtime) v.agentsEditReq = { serverId: runtime.id, name, kind, n: (v.agentsEditReq?.n ?? 0) + 1 };
    if (agentsLivesInSettings(layout.isTouchDevice)) {
      prefsOpenReq = { tab: kind === 'team' ? 'teams' : 'agents', n: ++prefsOpenSeq };
      if (page !== 'prefs') togglePrefs();
    } else {
      switchTab('agents');
    }
  }
  // A cross-page JUMP from the chat (header toggles, a feed board-line tap,
  // opening a pane full-screen) remembers where it came from, so the phone's
  // back at the target's FLOOR returns to the conversation instead of the
  // terminal root (owner, 2026-08-29: "从聊天跳转到terminal或者board或者file，
  // 我返回 应该回到聊天对话页面"). Any deliberate navigation — a tab tap, a
  // swipe — clears it: the slot only survives while you stay where the jump
  // landed. The slot is the view's `jumpedFrom`.

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
      // A held tree takes no input, programmatic or not (reviewer P1-2): its
      // pages' Back chains are not asked while the app is blocked. The Retry
      // panel is the content area then; Back just stays (re-push).
      if (storageHeld && page !== 'prefs') { navPush(); return; }
      // The tree IN FRONT is asked (#335 ③b-2): during a leave walk that is
      // the member whose guard is asking, so Back answers its dialog.
      const fv = front ? viewOf(front) : view;
      if (page === 'files' && fv.filesGoBack && fv.filesGoBack()) return;
      if (page === 'files' && view.jumpedFrom && !revealed) { switchTab(view.jumpedFrom); return; }
      // Files with nothing to peel has climbed to /: fall through to the
      // re-push — the terminal is not below it (board #47).
      // Chat and Agents peel their own layers (menus, dialogs, drawer,
      // editor) exactly like Files peels its views — a back with nothing to
      // peel falls through to the re-push, so it never reads as the browser
      // navigating away (owner, 2026-08-24: "像是网页刷新了。像文件管理页面
      // 就很好"). The consumed pop re-pushes so the NEXT back has an entry
      // to spend no matter how many layers were peeled.
      if (page === 'hub' && fv.hubGoBack && fv.hubGoBack()) { navPush(); return; }
      if (page === 'agents' && fv.agentsGoBack && fv.agentsGoBack()) { navPush(); return; }
      if (page === 'board' && fv.boardGoBack && fv.boardGoBack()) { navPush(); return; }
      if (page === 'board' && view.jumpedFrom && !revealed) { switchTab(view.jumpedFrom); return; }
      // Board with nothing to peel is like Hub: the drawer is its compact
      // floor (lifted by its own chain above), so a fall-through just
      // re-pushes — it never dumps the reader on the terminal (board #47).
      // A terminal JUMPED INTO from Chat returns there before the ordinary
      // terminal floor gets a chance to lift its drawer.
      if (page === 'terminal' && fv.sessionsGoBack?.()) { navPush(); return; }
      if (page === 'terminal' && view.jumpedFrom && !revealed) { switchTab(view.jumpedFrom); return; }
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
  // #199). Pages register theirs the way they register their back chain,
  // in the view's `pageReselect`.
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
  const toggleShellSide = () => appPrefs.setSidebarCollapsed(!appPrefs.sidebarCollapsed);
  /** What a reselect does on a page none of whose pages registered one: the
   * shell's, not a server's (③a-4). */
  const shellReselect = { terminal: toggleShellSide, board: toggleShellSide };
  // The Terminal page moves its track the way the Hub does (reveal.ts): the
  // sidebar pinned at its width, the factor moving, xterm fitted once at rest.
  const termPageEl = $derived(view.termPageEl);
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
    ((storageHeld ? null : view.pageReselect[page]) ?? toggleShellSide)();
  }
  function railActivate(slot) {
    if (railClickGuard) { railClickGuard = false; return; }
    if (slot === 'prefs') togglePrefs();
    else if (slot === page) { ((storageHeld ? null : view.pageReselect[slot]) ?? shellReselect[slot])?.(); return; }
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
  const termSideEl = $derived(view.termSideEl);
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
    view.jumpedFrom = null; // deliberate navigation stands the return slot down
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
      if (storageHeld) return;
      if (page !== 'terminal') switchTab('terminal');
      setLayout(view.splitLayout > 1 ? 1 : 2);
    },
    async focusComposer() {
      if (storageHeld) return;
      if (page !== 'hub') { switchTab('hub'); await tick(); }
      document.querySelector('.page-layer:not(.hidden) .c-input')?.focus();
    },
    async focusTerminal() {
      if (storageHeld) return;
      if (page !== 'terminal') { switchTab('terminal'); await tick(); }
      // The ACTIVE pane (board 316 review): in split screen the active cell,
      // never the first terminal on the page; an empty active cell takes no
      // input at all rather than handing it to another cell.
      terminalFocusTarget(termPageEl, splitActive ? view.activeCellId : null)?.focus();
    },
    cycleWindow(direction) {
      if (storageHeld) return;
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

<main class:with-rail={shell && !layout.isTouchDevice} class:touch-layout={shell && layout.isTouchDevice} class:side-collapsed={shellSideCollapsed} class:side-page={pageHasSidebar} class:immersive={view.filesImmersive && page === 'files'}>
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
    <!-- The FOCUSED server's reading, named when the tag rule says so (③c-5):
         one server's numbers, never several machines' summed. -->
    <aside class="sys-sidebar compact-tools" aria-label="Server system status">
      <SystemStatus load={() => bound()?.api.systemStatus() ?? Promise.reject(new Error('not connected'))} visible={connected}
        server={serverCurId} tag={serverTag(tagScope, serverCurId)} />
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
        onadd={serverAddRow} onclose={() => (serverMenuOpen = false)} frozen={migrationBlocked ? t('migrationBlockedNote') : ''}
        members={memberRows} notice={membershipError} />
    </div>
  {/if}

  {#if centre.anchor}
    <div class="centre-menu menu-surface menu-list pop-layer" class:ready={centreH > 0}
      role="dialog" aria-modal="false" aria-label={t('notifyCentre')} tabindex="-1"
      style:left="{centrePos.x}px" style:top="{centrePos.y}px"
      style:--pop-maxw="{centrePos.maxW}px" style:--pop-maxh="{centrePos.maxH}px"
      style:--pop-origin={centrePlace?.origin}
      bind:this={centreEl} bind:offsetWidth={centreW} bind:offsetHeight={centreH}>
      <NotifyCentre {centre} onpick={pickAlert} />
    </div>
  {/if}

  {#snippet savedServers()}
    <!-- Settings › Connection: the same ServerList as the popover (board 315). -->
    <ServerList variant="page" servers={serverList} currentId={serverCurId} link={serverLink}
      onpick={doServerSwitch} onrename={serverRename} onremove={serverRemove} onadd={serverAddRow} frozen={migrationBlocked ? t('migrationBlockedNote') : ''}
      members={memberRows} notice={membershipError} />
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
    {/if}
    <!-- Nothing a switch is not replacing goes with it (#335 ③b; reviewer
         P1-1 on 99566068): every member's tree, and Preferences while it
         keeps a guest, stay MOUNTED under the switch panel — hidden, inert,
         their drafts with them. Only the tree the switch replaces is let go
         of, by the swap, after its own walk. The connect form is the one
         surface that still steps aside, as before. -->
    <!-- The person-level surface. The Connection card needs no server — a
         fresh client has none to give it, and a dangling CURRENT leaves none
         either — so it lives OUTSIDE the server-bound subtree. That is also
         what lets the subtree render nothing at all while it has no runtime
         (board #335 ②b-1, reviewer P1-b). -->
    <!-- Held, like Preferences below, while a leave walk shows another page:
         the walk may have been started BY this form, and its accept has to
         come back to the attempt that asked (reviewer P1-b on 48b40082). -->
    {#if (page === 'settings' || holdPages) && !switching}
    <div class="page-layer connect-layer" class:hidden={page !== 'settings'}>
      <Settings {onConnected} {openCandidate} confirmLeave={confirmFormLeave} notice={reconnectError}
        frozen={migrationBlocked ? t('migrationBlockedNote') : ''} onRetry={retryMigration} onIdentityFailed={storageFailed} />
    </div>
    {/if}
    <!-- Preferences is the PERSON's surface — theme, fonts, zoom, language,
         shortcuts, notification switches — so it must open with or without a
         server: the gear is reachable whenever the shell is, including with no
         runtime at all, and inside the server-bound subtree it would have
         rendered a blank page there (reviewer, 2026-10-10). Its one
         server-bound guest, the Agents editor on touch, is already gated on a
         live server through `showAgents`, and bound to that server by a GUEST
         scope (board #335 ②b-3): the bound runtime and its state, keyed on the
         handle like the subtree, so a switch rebuilds the guest too. -->
    {#if (page === 'prefs' || holdPages || prefsKept) && (!switching || prefsKept)}
    <div class="page-layer" class:hidden={page !== 'prefs' || !!switching} inert={!!switching}>
    <Preferences {connected} {theme} {fontSize} {serverInfo} serverTag={serverTag(tagScope, serverCurId)} {activeAddress} {pendingAddress} addresses={prefAddresses}
      {savedServers}
      connectionMode={connMode} onConnectionMode={(m) => { void setConnectionMode(m); }} connectionModeFrozen={migrationBlocked}
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
      showAgents={frontHub && agentsLivesInSettings(layout.isTouchDevice)}
      guests={members.map((runtime) => ({ runtime, state: serverStates.get(runtime) }))} guestShown={front}
      guestHeld={storageHeld ? t('migrationBlockedNote') : ''}
      visible={page === 'prefs' && !switching}
      agentsEditRequest={view.agentsEditReq}
      openRequest={prefsOpenReq}
      onAddress={(address) => {
        if (migrationBlocked) return;  // nothing moves the socket while it is blocked
        pendingAddress = address;
        // A typed address is a NEW intent: end any running reconnect loop
        // before the direct connect, or its next attempt races this socket
        // and the loser's timeout marks a reachable address unreachable.
        // The switch module owns the socket (board 315): a server switch that
        // starts meanwhile makes this attempt stale, and a stale one neither
        // publishes nor restarts the reconnect loop.
        heldOffline = false;           // the person picked an address
        void serverSwitch.connectAddress(address)
          .finally(() => { if (pendingAddress === address) pendingAddress = ''; });
      }}
      onDisconnect={() => { page = 'settings'; doDisconnect(); }}
      onAddressesChange={(next) => {
        if (migrationBlocked) return;
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
    {#if !switching && migrationBlocked && page !== 'settings' && page !== 'prefs'}
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
    {#each members as runtime (runtime)}
    {@const v = viewOf(runtime)}
    {@const held = storageHeld || !!switching || runtime !== front}
    {@const shown = !held}
    <!-- While the app is blocked on its storage the tree stays MOUNTED, inert
         and hidden (board #335 ③a; orchestrator 08:17: one mechanism, Single
         included): no input reaches it, its resident writes are held by the
         write gate and its runtime refuses new write RPCs, so nothing typed
         is lost and nothing lands before Retry. The runtime it is bound to
         stays bound and RUNNING (ruling K) until the next one passes every
         gate.
         One tree per bound member (③a-4), keyed by its handle: only the
         FOCUSED one is shown and takes input — every other is held, inert
         and hidden, keeping its pages, drafts and terminals. `shown` is the
         ONE definition of "this tree is in front": not held, so a blocked
         tree is no more shown than an unfocused one, and every `visible`
         below follows it — a held Hub is not a read Hub (reviewer P1-2). Its pages
         register their Back chains and requests into ITS view `v`; the
         window dispatches only through the focused one. -->
    <div class="scope-tree" class:held inert={held}>
    <ServerScope {runtime} state={serverStates.get(runtime)} tag={serverTag(tagScope, runtime.id)}>
    {#if v.hubState.available}
      <!-- Hub (agents-v2 desktop three-column view): kept mounted (like
           Files/Terminal below) and merely hidden when inactive, so the
           selected project, chat scroll, and embedded terminal survive tab
           switches. Desktop-eligible only (needs width + the desktop server):
           mobile keeps the tab layout untouched. -->
      <div class="page-layer" class:hidden={!shown || page !== 'hub'}>
        <Hub visible={shown && page === 'hub'} {fontSize} mobile={layout.isTouchDevice} openTerminal={(s, tgt) => openTerminal(s, tgt)} onSelectSession={(s) => { if (s) showSessionIn(runtime, v, s); }} onGoBack={(fn) => v.hubGoBack = fn} onReselect={(fn) => { v.pageReselect.hub = fn; }} openAgentConfig={(name, kind) => openAgentsConfig(name, kind, runtime, v)} openFilesTab={(s, path, file) => { if (s) showSessionIn(runtime, v, s); if (path || file) v.filesNavReq = { serverId: runtime.id, path, file, n: (v.filesNavReq?.n ?? 0) + 1 }; switchTab('files'); v.jumpedFrom = 'hub'; }} openBoardTab={(s, issue) => { if (s) showSessionIn(runtime, v, s); if (issue) v.boardIssueReq = { serverId: runtime.id, session: s, id: issue, n: (v.boardIssueReq?.n ?? 0) + 1 }; switchTab('board'); v.jumpedFrom = 'hub'; }}
          union={hubUnionFor} selectRequest={landingFor(v.hubSelectReq, runtime)} onPickServer={pickServerProject} />
      </div>
    {/if}
    <!-- The Agents PAGE exists where Agents is a page: the desktop rail. On
         touch the only instance is the one Settings embeds, so this layer is not
         mounted there — two live copies would both load and both claim a back
         chain. -->
    {#if v.hubState.available && !agentsLivesInSettings(layout.isTouchDevice)}
      <div class="page-layer" class:hidden={!shown || page !== 'agents'}>
        <AgentsPage visible={shown && page === 'agents'} guardPage="agents" onGoBack={(fn) => v.agentsGoBack = fn} editRequest={landingFor(v.agentsEditReq, runtime)} />
      </div>
    {/if}
    <div class="page-layer" class:hidden={!shown || page !== 'files'}>
      <Files session={v.filesSession} guardPage="files" visible={shown && page === 'files'} {fontSize} onGoBack={(fn) => v.filesGoBack = fn} onimmersive={(on) => v.filesImmersive = on} navRequest={landingFor(v.filesNavReq, runtime)} jumped={!!v.jumpedFrom} />
    </div>
    <div class="page-layer" class:hidden={!shown || page !== 'board'}>
      {#if v.hubState.available}
        <Board session={v.filesSession} guardPage="board" visible={shown && page === 'board'} sideCollapsed={shellSideCollapsed} onGoBack={(fn) => v.boardGoBack = fn} issueRequest={landingFor(v.boardIssueReq, runtime)} jumped={!!v.jumpedFrom} />
      {/if}
    </div>
    <div class="page-layer term-page" class:hidden={!shown || page !== 'terminal'} bind:this={v.termPageEl}>
      <!-- The session/window list: a column beside the terminal on a wide
           screen, a slide-over sheet on a phone (opened from the switcher's
           session tag). Kept MOUNTED so its polling and expansion state
           survive; `visible` pauses the poll while the page is hidden. -->
      <aside class="term-side" class:side-sheet={layout.isTouchDevice && narrowVp} class:sheet={layout.isTouchDevice} class:open={layout.isTouchDevice && narrowVp && sessListOpen} bind:this={v.termSideEl}>
        {#if !layout.isTouchDevice}<SideHandle />{/if}
        <Sessions {openTerminal} activeTarget={v.terminalTarget}
          onGoBack={(fn) => v.sessionsGoBack = fn}
          visible={shown && page === 'terminal' && (!layout.isTouchDevice || sessListOpen)}
          onPick={() => sessListOpen = false}
          union={sessionsUnionFor} onPickServer={pickServerPane}
          chips={false} />
      </aside>
      {#if layout.isTouchDevice && sessListOpen}
        <button class="side-scrim" aria-label={t('close')} onclick={() => sessListOpen = false}></button>
      {/if}
      <div class="term-main">
      {#if v.terminalTarget}
        <div class="terminal-body" class:split-capable={splitEligible}>
          {#if splitOn(v)}
            <!-- In split mode the layout control floats top-right (no single
                 win-bar to host it; cells have their own headers). In single-
                 pane mode the control lives in the Terminal's chip bar. -->
            <div class="split-control">
              <button class="split-toggle state-ctl" class:on={splitOn(v)} aria-label={t('split')} use:hoverInfo={() => ({ title: t('split') })}
                aria-haspopup="menu" aria-expanded={!!splitMenuAt} onclick={toggleSplitMenu}>
                <Icon name="layout" size={15} />
              </button>
              <ContextMenu at={splitMenuAt} items={splitMenuItems} oncancel={() => (splitMenuAt = null)} />
            </div>
          {/if}
          {#if splitOn(v)}
            <SplitView cells={v.splitViewCells} layout={v.splitLayout} activeCellId={v.activeCellId} {fontSize}
              visible={shown && page === 'terminal'} focused={!held}
              onActivate={(id) => v.activeCellId = id}
              onAssign={(id, tg, se) => assignCell(id, tg, se, runtime, v)}
              onCloseCell={(id) => closeCell(id, v)}
              onPaneExit={(id) => cellPaneExit(id, v)} />
          {:else}
            <Terminal target={v.terminalTarget} session={v.terminalSession} {fontSize}
              visible={shown && page === 'terminal'} active={!held}
              splitEligible={splitEligible} splitActive={splitOn(v)} splitLayout={v.splitLayout} onSetLayout={setLayout}
              onOpenSessions={layout.isTouchDevice ? () => sessListOpen = true : null}
              onSwitchPane={(t) => showPaneIn(runtime, v, '', t)} onPaneExit={(t) => paneExitFallback(t, runtime, v)} />
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
    {#if !layout.isTouchDevice && connected && shown}
      <ScratchPanel open={scratchOpen} live={!switching} edge={scratchEdge} {fontSize}
        onclose={() => (scratchOpen = false)} onedge={setScratchEdge} />
    {/if}
    </ServerScope>
    </div>
    {/each}
    <!-- (the switch panel above sits over the kept trees) -->
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
  /* The server-bound tree's wrapper takes no box of its own, so every page
     layer keeps its place; held (the app blocked on its storage, #335 ③a)
     it is hidden — visibility inherits — and inert. */
  .scope-tree { display: contents; }
  .scope-tree.held { visibility: hidden; }
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
