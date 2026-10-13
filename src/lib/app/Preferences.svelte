<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import Icon from '../ui/Icon.svelte';
  import ServerTag from '../ui/ServerTag.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import Switch from '../ui/Switch.svelte';
  import Stepper from '../ui/Stepper.svelte';
  import Slider from '../ui/Slider.svelte';
  import SideHandle from '../ui/SideHandle.svelte';
  import { scrollFade } from '../core/scrollFade.ts';
  import Select from '../ui/Select.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { hoverInfo } from '../ui/hover.ts';
  import { t, i18n, setLocale } from '../core/i18n.svelte.ts';
  import { layout } from './layout.svelte.ts';
  import { fonts, uiFont, displayFont, availableFamilies } from './fonts.svelte.ts';
  import { UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_STEP } from './ui-zoom.ts';
  import { terminalPrefs, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX } from './terminal-prefs.svelte.ts';
  import { appPrefs } from '../hub/hub-prefs.svelte.ts';
  import { notifyEnabled, setNotifyEnabled, ensurePermission, previewCue, notifyPermission, systemNotify, notifyLevel, setNotifyLevel, NOTIFY_LEVELS, type NotifyLevel } from '../hub/notifications.ts';
  import { SHORTCUTS, SHORTCUT_GROUPS, isCharacterInput, shortcutFromEvent, shortcutLabel, type ShortcutAction, type ShortcutDef, type ShortcutHost } from './shortcuts.ts';
  import { shortcuts } from './shortcuts.svelte.ts';
  import { moveMs } from '../ui/motion.ts';
  import { RAIL_DRAG_THRESHOLD, listDropAt, railDropIndex, railDropOffset } from './nav-order.ts';
  import AgentsPage from '../hub/AgentsPage.svelte';
  import ServerScope from './ServerScope.svelte';

  let {
    connected = false,
    theme = 'system',
    fontSize = 14,
    uiZoom = 1,
    showUiZoom = false,
    showShortcuts = false,
    shortcutHost = null,
    serverInfo = { hostname: '', machineId: '' },
    serverTag = null,
    activeAddress = '',
    pendingAddress = '',
    addresses = [],
    optimizing = false,
    linkCopied = false,
    onClose = () => {},
    onTheme = () => {},
    onUiZoom = () => {},
    onFontSize = () => {},
    onOptimize = () => {},
    onShare = () => {},
    onGoBack = null,
    onDrill = () => {},
    showAgents = false,
    guests = [],
    guestShown = null,
    guestHeld = '',
    visible = true,
    agentsEditRequest = null,
    openRequest = null,
    onAddress = () => {},
    onAddressesChange = () => {},
    onDisconnect = () => {},
    onConnectionSetup = () => {},
    serverName = '',
    onServers = null,
    serversOpen = false,
    serversControls = undefined,
    savedServers = null,
    connectionMode = 'single',
    onConnectionMode = null,
    connectionModeFrozen = false,
  }: {
    connected?: boolean;
    theme?: string;
    fontSize?: number;
    uiZoom?: number;
    showUiZoom?: boolean;
    showShortcuts?: boolean;
    /** App's shortcut host: lets a row say it is unavailable here (board 316). */
    shortcutHost?: ShortcutHost | null;
    serverInfo?: { hostname: string; machineId: string };
    /** The focused server's name by the ③c-1 tag rule (null = not shown):
     * the Connection section — its copy-link, its addresses, its optimizer —
     * acts on the FOCUSED server (③c-5), and with several included the
     * title says which. */
    serverTag?: string | null;
    activeAddress?: string;
    /** The address whose row was tapped and is still connecting — it wears the
     *  app-wide running cue (`.live-dot`) until App reports the outcome. */
    pendingAddress?: string;
    addresses?: string[];
    optimizing?: boolean;
    linkCopied?: boolean;
    onClose?: () => void;
    onTheme?: (theme: string) => void;
    onUiZoom?: (value: number) => void | Promise<void>;
    onFontSize?: (size: number) => void;
    onOptimize?: () => void | Promise<void>;
    onShare?: () => void | Promise<void>;
    onGoBack?: ((fn: () => boolean) => void) | null;
    onDrill?: () => boolean | void;
    /** Touch only: the agent configuration is a CATEGORY here rather than a page
     *  of its own (nav-state's agentsLivesInSettings). The desktop rail keeps
     *  its own Agents page, so this stays false there. */
    showAgents?: boolean;
    /** The server the embedded AgentsPage is bound to — its GUEST scope
     * (board #335 ②b-3): App's bound runtime and that runtime's state.
     * Preferences itself is the person's and needs neither; with no runtime
     * the guest renders nothing, like every server-bound subtree. */
    /** Every bound member's GUEST scope (board #335 ③a, reviewer P1-C on the
     * ③ plan): its runtime and state. Each member keeps its own Agents editor,
     * mounted on first open and kept, so a focus change never destroys a
     * draft in one; only the `guestShown` one is visible and takes input. */
    guests?: { runtime: import('./server-runtime.ts').ServerRuntime; state: import('./server-state.ts').ServerState | undefined }[];
    guestShown?: import('./server-runtime.ts').ServerRuntime | null;
    /** Is this page on screen? App keeps it mounted, hidden, once a guest
     * exists (③a): hidden, no guest is visible or takes input. */
    visible?: boolean;
    /** Non-empty while the app is blocked on its storage (board #335 ③a): the
     * guest editor stays mounted — a draft in it survives — but takes no
     * input, and this says why. */
    guestHeld?: string;
    /** Forwarded to the embedded AgentsPage: the Hub's "configure agent" jump. */
    /** One agent's or team's editor to open, on the server it names
     * (`serverId`); only that member's guest takes it. */
    agentsEditRequest?: { serverId: string; name: string; kind?: 'agent' | 'team'; n: number } | null;
    /** A one-shot "open this category" request — `{ tab, n }`, the same shape
     *  the Files/Agents deep links use. Restoring a saved `agents` page on a
     *  phone lands here. */
    openRequest?: { tab: string; n: number } | null;
    onAddress?: (address: string) => void | Promise<void>;
    /** The failover set's ONE write path (board #222): a remove and a
     *  drag-reorder both hand up the new list — its order IS the priority.
     *  App persists it through servers.ts's saveMachineAddresses. */
    onAddressesChange?: (addresses: string[]) => void;
    onDisconnect?: () => void | Promise<void>;
    onConnectionSetup?: () => void | Promise<void>;
    /** The current server's name as its registry row reads (App's
     *  currentServerName: the hostname unless renamed; board #319). */
    serverName?: string;
    /** Touch layout only: opens App's server registry popover from the row
     *  at the top of the category list. The desktop rail has its own control,
     *  so App passes null there and the row does not render. */
    onServers?: ((e: MouseEvent) => void) | null;
    /** The symmetric swap glyph turns 90° while the popover is open; 180°
     *  would leave the icon looking unchanged. */
    serversOpen?: boolean;
    serversControls?: string;
    /** Every saved server (board 315): App's ONE ServerList, rendered here in
     *  page layout — same rows and actions as the switcher popover. */
    savedServers?: import('svelte').Snippet | null;
    /** How many saved servers this device connects to (board #335 ③):
     *  'single' or 'aggregate'. App owns the change — it asks the trees a
     *  switch to Single would destroy — so this only reports the choice. */
    connectionMode?: 'single' | 'aggregate';
    onConnectionMode?: ((mode: 'single' | 'aggregate') => void) | null;
    /** The registry is frozen (blocked): the mode cannot change either. */
    connectionModeFrozen?: boolean;
  } = $props();

  const TAB_KEY = 'tmux_settings_tab';
  const storedTab = localStorage.getItem(TAB_KEY);
  /** The four agent-configuration categories a phone shows (owner, 2026-09-02:
   *  "把 team agent mcp skill 分开几个二级设置页面吧，在手机上") — each embeds
   *  the REAL AgentsPage narrowed to one section, so the desktop page and the
   *  four phone pages cannot drift apart. */
  const AGENT_TABS = ['agents', 'teams', 'skills', 'mcp'];
  // A stored 'terminal' (the category retired 2026-09-25) falls through to
  // Appearance, where its rows now live.
  const validStoredTab = storedTab === 'connection' || storedTab === 'shortcuts' || storedTab === 'notifications' || storedTab === 'chat' || (storedTab != null && AGENT_TABS.includes(storedTab));
  const initialTab = validStoredTab ? storedTab : 'appearance';
  let tab = $state<string>(initialTab);
  if (storedTab && storedTab !== initialTab) localStorage.setItem(TAB_KEY, initialTab);
  // No icons on the category rows (owner, 2026-08-25: "三个子页面就不要图标
  // 了，不好看") — the words carry it, like the Chat sidebar's project rows.
  //
  // Agents is a category only where it is not a page: on a phone the bottom bar
  // had one icon too many (owner, 2026-08-29), so the agent configuration moved
  // in here — as the REAL AgentsPage embedded below, never a second copy of it.
  // The four agent categories are their own labelled group AFTER the app group
  // (owner, 2026-09-05; see `groups` below).
  // Message notifications (board #57 → #72): their OWN category, not a row
  // under Appearance (owner, 2026-09-02: "应该在一个单独的 notification 二级
  // 页面"), and not the Hub header. The switch's click is the ONE user gesture
  // that requests system permission and unlocks audio (the preview doubles as
  // "what will it sound like"). The caption reads the platform back: not
  // permitted (site blocked, OS refused, or — inside Tauri — never asked yet),
  // or no Notification API at all (sound only). The TEST row exists because
  // the real alert only fires while you are NOT looking — there is no other
  // way to check on a phone that the tray actually shows one.
  let notifyOn = $state(notifyEnabled());
  let notifyPerm = $state(notifyPermission());
  let notifyTested = $state(false);
  let notifyBusy = $state(false);
  let notifyError = $state('');
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  // The LEVEL (owner, 2026-09-02: "只有完成才通知，还是中间状态都通知"):
  // done < replies < all, each a superset — see notifications.ts.
  let notifyLvl = $state<NotifyLevel>(notifyLevel());
  function setLevel(l: NotifyLevel) { notifyLvl = l; setNotifyLevel(l); }
  async function setNotify(on: boolean) {
    if (notifyBusy) return;
    const before = notifyOn;
    notifyError = '';
    notifyOn = on;
    setNotifyEnabled(on);
    if (!on) return;
    notifyBusy = true;
    try {
      previewCue();
      await ensurePermission();
      if (alive) notifyPerm = notifyPermission();
    } catch (error) {
      setNotifyEnabled(before);
      if (alive) { notifyOn = before; notifyError = errorText(error); }
    } finally { if (alive) notifyBusy = false; }
  }
  async function testNotify() {
    if (notifyBusy) return;
    notifyBusy = true;
    notifyError = '';
    notifyTested = false;
    clearTimeout(notifyTimer);
    try {
      previewCue();
      await ensurePermission();
      if (!alive) return;
      notifyPerm = notifyPermission();
      notifyTested = systemNotify({ title: t('hubNotifyTestTitle'), body: t('hubNotifyTestBody'), tag: 'tmm:test' });
      notifyTimer = setTimeout(() => { notifyTested = false; }, 1500);
    } catch (error) {
      if (alive) notifyError = errorText(error);
    } finally { if (alive) notifyBusy = false; }
  }

  /** Two labelled groups (owner, 2026-09-05: "从上到下这些设置的顺序没有任何
   *  逻辑，看起来很乱…分成两组：1. 关于本身应用层面的一些设置 2. 关于 Agent
   *  层面的设置"): the APP group — Appearance, Notifications, Terminal,
   *  (Shortcuts,) Connection — then the AGENT group's four embedded
   *  AgentsPage sections. Connection ends the APP group as its way out; the
   *  pre-group "Connection stays last in the whole list" rule is superseded.
   *  The flat `tabs` every consumer reads derives FROM the groups, so there
   *  is one source of order. */
  const groups = $derived([
    {
      id: 'app', label: () => t('settingsGroupApp'), rows: [
        { id: 'appearance', label: () => t('settingsAppearance') },
        { id: 'chat', label: () => t('settingsChat') },
        { id: 'notifications', label: () => t('settingsNotifications') },
        ...(showShortcuts ? [{ id: 'shortcuts', label: () => t('settingsShortcuts') }] : []),
        { id: 'connection', label: () => t('settingsConnection') },
      ],
    },
    ...(showAgents ? [{
      id: 'agent', label: () => t('settingsGroupAgent'), rows: [
        { id: 'agents', label: () => t('agentsTitle') },
        { id: 'teams', label: () => t('teamsTitle') },
        { id: 'skills', label: () => t('skillsTitle') },
        { id: 'mcp', label: () => t('mcpTitle') },
      ],
    }] : []),
  ]);
  const tabs = $derived(groups.flatMap((g) => g.rows));
  /** One line per category for the desktop's hover card (motion.md §1.16) —
   *  the row's label is terse, the card says what is inside. Kept apart from
   *  `tabs` so the list stays the shape the source tests pin. */
  const TAB_HINTS: Record<string, string> = {
    appearance: 'settingsAppearanceHint', chat: 'settingsChatHint', notifications: 'settingsNotificationsHint',
    shortcuts: 'settingsShortcutsHint', agents: 'settingsAgentsHint', teams: 'settingsTeamsHint',
    skills: 'settingsSkillsHint', mcp: 'settingsMcpHint', connection: 'settingsConnectionHint',
  };
  // The tab is DERIVED from the one registry (board 316): groups, rows,
  // defaults. A reason that is about this device/server (no Hub, too narrow
  // for split screen, one saved server) disables the row and says why; a
  // reason about the moment (not on the terminal page) is the action's scope,
  // not a reason to refuse a binding.
  const CAPABILITY = new Set(['shortcutNeedHub', 'shortcutNeedWide', 'shortcutNeedServers']);
  const shortcutGroups = SHORTCUT_GROUPS.map((group) => ({ group, defs: SHORTCUTS.filter((d) => d.group === group) }));
  const unavailable = (def: ShortcutDef) => {
    if (!shortcutHost) return '';
    const why = def.need(shortcutHost);
    return CAPABILITY.has(why) ? why : '';
  };
  // An uncustomized field names the face its role renders in (board 312,
  // owner 2026-10-08: "你要在设置页面显示出来，不然我都没办法选"): it used to
  // read a grey "System default" while the titles wore Space Grotesk. Picking
  // that name back stores nothing — it IS the default.
  const shownFont = (pref: typeof fonts) => pref.custom || pref.defaultFace;
  let fontInput = $state(shownFont(fonts));
  // The other two roles (owner, 2026-08-25: "总之就三类…这些可以都是系统设
  // 置里的字体"): content prose and the chrome (titles/buttons/names). Same
  // validate-then-commit contract as the terminal font.
  let uiFontInput = $state(shownFont(uiFont));
  let displayFontInput = $state(shownFont(displayFont));
  // What the pickers OFFER: the suggestion pool filtered to families this
  // device resolves (FontPref.available, board #233) — a listed font that
  // fails validation on pick taught the owner the list was decoration
  // ("很多字体都用不了，用不了前端应该提前过滤一下"). Probed once, at the
  // page; an empty list while probing just means the combo starts blank.
  let fontOptions = $state<{ mono: string[]; ui: string[]; display: string[] }>({ mono: [], ui: [], display: [] });
  $effect(() => {
    let live = true;
    void Promise.all([availableFamilies(fonts), availableFamilies(uiFont), availableFamilies(displayFont)]).then(([mono, ui, display]) => {
      if (live) fontOptions = { mono, ui, display };
    });
    return () => { live = false; };
  });
  const fontState = $state({
    mono: { pending: false, invalid: false },
    ui: { pending: false, invalid: false },
    display: { pending: false, invalid: false },
  });
  let recordingShortcut = $state<ShortcutAction | ''>('');
  let shortcutError = $state('');
  const commandState = () => ({ pending: false, error: '' });
  const connectionCommands = () => ({
    optimize: commandState(), share: commandState(), address: commandState(),
    disconnect: commandState(), setup: commandState(),
  });
  let commands = $state(connectionCommands());
  const zoomCommand = $state(commandState());
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  async function runCommand(state: { pending: boolean; error: string }, action: () => void | Promise<void>) {
    if (state.pending) return;
    state.pending = true;
    state.error = '';
    try { await action(); }
    catch (error) { if (alive) state.error = errorText(error); }
    finally { if (alive) state.pending = false; }
  }

  // ── Failover-set management (board #222) ────────────────────────────────
  // The address list's order IS the failover priority the reconnect
  // round-robin walks. A row's × removes one alternate (the ACTIVE address is
  // not removable — it is the live connection); the grip drags a row to its
  // new priority. The drag speaks the rail's reorder idiom (nav-order.ts):
  // a threshold so a press stays a press, geometry snapshotted at drag start
  // (the carried row moves by transform and reflows nothing), an accent
  // insertion line, and the commit computed from the SAME index on release.
  // Unlike the rail the grip, not the row, is the handle: the row is already
  // a switch command, and on touch a whole-row vertical drag would fight the
  // page's scroll — the grip opts out of scrolling with `touch-action: none`.
  let addrDrag = $state<{ address: string; dy: number; idx: number; listTop: number; rects: { slot: string; top: number; bottom: number }[] } | null>(null);
  let addrPress: { address: string; y: number; el: HTMLElement } | null = null; // pre-threshold bookkeeping; deliberately not reactive

  function removeAddress(address: string) {
    if (pendingAddress || commands.address.pending) return;
    onAddressesChange(addresses.filter((a) => a !== address));
  }

  function addrPointerDown(e: PointerEvent, address: string) {
    if (e.button !== 0 || pendingAddress || commands.address.pending) return;
    addrPress = { address, y: e.clientY, el: e.currentTarget as HTMLElement };
    // Captured at once so a fast drag off the small grip keeps reporting here
    // instead of to whatever it passes over.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function addrPointerMove(e: PointerEvent) {
    if (!addrPress) return;
    const dy = e.clientY - addrPress.y;
    if (!addrDrag) {
      if (Math.abs(dy) < RAIL_DRAG_THRESHOLD) return;
      const list = addrPress.el.closest('.address-list');
      if (!list) return;
      addrDrag = {
        address: addrPress.address, dy, idx: 0,
        listTop: list.getBoundingClientRect().top,
        rects: [...list.querySelectorAll('[data-addr-row]')].map((el) => {
          const r = el.getBoundingClientRect();
          return { slot: (el as HTMLElement).dataset.addrRow!, top: r.top, bottom: r.bottom };
        }),
      };
    }
    addrDrag.dy = dy;
    addrDrag.idx = railDropIndex(addrDrag.rects, e.clientY);
  }
  function addrPointerUp() {
    if (addrDrag) {
      // Committed with the SAME index the insertion line was drawn from, so
      // the row can only land where the line said it would.
      onAddressesChange(listDropAt(addresses, addrDrag.address, addrDrag.rects, addrDrag.idx));
    }
    addrPress = null;
    addrDrag = null;
  }
  function addrCancelDrag() {
    addrPress = null;
    addrDrag = null;
  }
  /** The keyboard form of the same reorder: one step per arrow, committed at
   *  once — there is no drag in flight to cancel. */
  function addrGripKey(e: KeyboardEvent, address: string) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const i = addresses.indexOf(address);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= addresses.length) return;
    const next = [...addresses];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onAddressesChange(next);
  }
  // Escape abandons a drag and a resize invalidates its snapshotted rects —
  // the same dismissal contract every transient layer here follows. The
  // window-level pointerup is a safety net: if the captured grip stops
  // existing mid-drag, the list never sees the release and a carried row
  // would be stranded on screen.
  $effect(() => {
    if (!addrDrag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); addrCancelDrag(); } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', addrCancelDrag);
    window.addEventListener('pointerup', addrPointerUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', addrCancelDrag);
      window.removeEventListener('pointerup', addrPointerUp, true);
    };
  });
  /** The embedded AgentsPage's own back chain, and whether it is showing an
   *  editor (which brings its own page head). */
  // Per guest (③a): each member's editor registers its own, and the page asks
  // the SHOWN one's at use time — a registration made at init must not stand
  // for whichever guest is in front later.
  type Guard = (action: () => void, cancel?: () => void) => void;
  type Guest = { back: (() => boolean) | null; guard: Guard | null };
  // Plain map (handles are identities, not state); `drilled` is the one
  // value the template follows, so it is a reactive map of its own.
  const guestRegs = new Map<object, Guest>();
  let drilledBy = $state.raw(new Map<object, boolean>());
  const reg = (runtime: object): Guest => {
    let r = guestRegs.get(runtime);
    if (!r) { r = { back: null, guard: null }; guestRegs.set(runtime, r); }
    return r;
  };
  /** Does the shown guest take input now: this page on screen, the server
   * not held, the touch guest offered (reviewer P1-2 residual on 9958bbfd)?
   * A held or hidden guest keeps its editor; it is just not asked. */
  const guestInput = $derived(visible && !guestHeld && showAgents);
  const agentsBack = () => (guestShown && guestInput ? guestRegs.get(guestShown)?.back?.() ?? false : false);
  const agentsDrilled = $derived(!!guestShown && AGENT_TABS.includes(tab) && !!drilledBy.get(guestShown));
  const agentsGuard = () => (guestShown && guestInput ? guestRegs.get(guestShown)?.guard ?? null : null);
  /** The guests mounted so far (lazily, on first show) and the section each
   * is on. A guest's section is ITS OWN: it is first set when the guest
   * mounts, and after that changes only through an accepted `selectTab`
   * while that guest is shown — never by another member's choice (reviewer
   * P1-1 residual on 9958bbfd). Let go of with the member. */
  let opened = $state.raw<object[]>([]);
  let sections = $state.raw(new Map<object, string>());
  const sectionOf = (runtime: object) => sections.get(runtime) ?? 'agents';
  $effect(() => {
    const shown = guestShown;
    const t = tab;
    if (!shown || !guestInput || !AGENT_TABS.includes(t)) return;
    untrack(() => {
      if (!opened.includes(shown)) opened = [...opened, shown];
      if (!sections.has(shown)) sections = new Map(sections).set(shown, t);
    });
  });
  // Focus moved to a guest that is on another section: the PAGE follows
  // that guest (its own last section), the guest does not follow the page.
  let lastShown: object | null = null;
  let lastInput = false;
  $effect(() => {
    const shown = guestShown;
    const input = guestInput;
    untrack(() => {
      const thawed = input && !lastInput;
      lastInput = input;
      if (shown === lastShown && !thawed) return;
      lastShown = shown;
      const own = shown ? sections.get(shown) : undefined;
      if (own && AGENT_TABS.includes(tab) && own !== tab) { tab = own; localStorage.setItem(TAB_KEY, own); }
    });
  });
  $effect(() => {
    const live = new Set<object>(guests.map((g) => g.runtime));
    untrack(() => {
      const keep = opened.filter((r) => live.has(r));
      if (keep.length !== opened.length) opened = keep;
      for (const r of [...guestRegs.keys()]) if (!live.has(r)) guestRegs.delete(r);
      if ([...drilledBy.keys()].some((r) => !live.has(r))) drilledBy = new Map([...drilledBy].filter(([r]) => live.has(r)));
      if ([...sections.keys()].some((r) => !live.has(r))) sections = new Map([...sections].filter(([r]) => live.has(r)));
    });
  });
  const setDrilled = (runtime: object, d: boolean) => {
    if (untrack(() => drilledBy.get(runtime)) === d) return;   // a report that changes nothing writes nothing
    drilledBy = new Map(untrack(() => drilledBy)).set(runtime, d);
  };
  let navigation = 0;
  let acceptedAgentRequest = $state<{ serverId: string; name: string; kind?: 'agent' | 'team'; n: number } | null>(null);
  function registerAgentsGuard(runtime: object, guard: Guard) {
    reg(runtime).guard = guard;
    return () => { const r = guestRegs.get(runtime); if (r?.guard === guard) r.guard = null; };
  }

  $effect(() => {
    if ((!showShortcuts && tab === 'shortcuts') || (!showAgents && AGENT_TABS.includes(tab))) {
      // A capability correction uses the same exit guard, without drilling.
      untrack(() => selectTab('appearance', undefined, undefined, false));
    }
  });
  let commandsOwner: string | null = null;
  $effect(() => {
    const owner = connected ? serverInfo.machineId || activeAddress : null;
    untrack(() => {
      if (owner !== commandsOwner) {
        commandsOwner = owner;
        commands = connectionCommands();
      }
    });
  });

  // A one-shot open request (restoring a saved `agents` page on a phone lands
  // here). Tracked by `n` so the same category can be re-opened later.
  let openedRequest = 0;
  $effect(() => {
    const req = openRequest;
    if (!req || req.n === openedRequest) return;
    const edit = agentsEditRequest;
    if (tabs.some((x) => x.id === req.tab)) untrack(() => selectTab(req.tab, () => {
      openedRequest = req.n;
      acceptedAgentRequest = req.tab === (edit?.kind === 'team' ? 'teams' : 'agents') ? edit : null;
    }, () => openRequest?.n === req.n && openRequest.tab === req.tab));
  });

  async function saveFont(role: keyof typeof fontState) {
    const state = fontState[role];
    if (state.pending) return;
    const pref = { mono: fonts, ui: uiFont, display: displayFont }[role];
    const typed = { mono: fontInput, ui: uiFontInput, display: displayFontInput }[role].trim();
    const value = typed === pref.defaultFace ? '' : typed;
    state.pending = true;
    state.invalid = false;
    try {
      const valid = await pref.set(value);
      if (alive) state.invalid = !valid;
    } catch { if (alive) state.invalid = true; }
    finally {
      if (alive) {
        const shown = shownFont(pref);
        if (role === 'mono') fontInput = shown;
        else if (role === 'ui') uiFontInput = shown;
        else displayFontInput = shown;
        state.pending = false;
      }
    }
  }

  function resetFont(role: keyof typeof fontState) {
    if (role === 'mono') fontInput = '';
    else if (role === 'ui') uiFontInput = '';
    else displayFontInput = '';
    void saveFont(role);
  }

  function setLineHeight(value: number) {
    terminalPrefs.setLineHeight(Math.round(value * 100) / 100);
  }

  // Compact drill-down (owner, 2026-08-25: "上边一行三个标签这个风格和别的
  // 页面太不一样"): the phone shows the CATEGORY LIST first — the same shared
  // sidebar every page has — and a tap opens that category full screen, the
  // AgentsPage editor pattern. catOpen governs compact or budget-limited panes.
  let catOpen = $state(false);
  // Drill motion (the navigation grammar in design-language.md §1): opening a
  // category slides it in from the RIGHT, backing out slides the list in from
  // the LEFT — the same 120ms the app-level tab slide speaks. The class
  // toggling fwd↔back is what replays the animation; no timers.
  let drillAnim = $state('');
  let stacked = $state(false);
  const isCompact = () => stacked || window.matchMedia('(max-width: 760px)').matches;
  function measureLayout(node: HTMLElement) {
    const measure = () => {
      if (!node.clientWidth) return;
      const style = getComputedStyle(node);
      const sidebar = parseFloat(style.getPropertyValue('--sidebar-w')) || 240;
      const editor = parseFloat(style.getPropertyValue('--config-editor-width')) || 480;
      stacked = node.clientWidth < sidebar + editor;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const sidebar = node.querySelector(':scope > aside');
    if (sidebar) observer.observe(sidebar);
    measure();
    return { destroy: () => observer.disconnect() };
  }
  let drillPushed = false;
  function closeCat() { catOpen = false; drillAnim = 'back'; drillPushed = false; }
  $effect(() => {
    onGoBack?.(() => {
      // The embedded AgentsPage peels its OWN layers first (delete dialog, then
      // an open editor) — the same order it uses as a page. Only when it has
      // nothing left does back close the category, and only then the page.
      if (AGENT_TABS.includes(tab) && agentsBack()) return true;   // only a guest taking input
      if (catOpen && isCompact()) { closeCat(); return true; }
      return false;
    });
  });

  /** A leave walk asks guest `runtime`'s editor (#335 ③b, reviewer P1-2 on
   * 99566068): show it on ITS OWN section — the page follows the guest, the
   * guest's section is never moved to show a dialog — and give back what
   * puts the page where the person had it. The host (App) has already made
   * this guest the one shown. */
  async function revealGuest(runtime: object): Promise<() => void> {
    const back = { tab, catOpen };
    tab = sectionOf(runtime);
    catOpen = true;
    await tick();
    return () => { tab = back.tab; catOpen = back.catOpen; };
  }

  function selectTab(value: string, applied = () => {}, current = () => true, drill = true) {
    const intent = ++navigation;
    // The guest the choice was made for: a confirmation that answers after
    // focus moved commits nothing for the next one.
    const guestAt = guestShown;
    // A held guest's section cannot move (its guard cannot be asked): an
    // agent category chosen while it is held lands on ITS section, so page
    // and guest never disagree (reviewer P2 on c0969d20).
    if (guestAt && !guestInput && opened.includes(guestAt) && AGENT_TABS.includes(value)) value = sectionOf(guestAt);
    const apply = () => {
      if (!alive || intent !== navigation || !current() || guestShown !== guestAt) return;
      // Only an accepted category jump may push, persist or forward an edit.
      if (drill) {
        if (!catOpen && isCompact()) { drillAnim = 'fwd'; drillPushed = !!onDrill(); }
        catOpen = true;
      }
      tab = value;
      // The shown guest's own section moves only here, accepted, and only
      // while it takes input; a held guest keeps its section.
      if (guestAt && guestInput && AGENT_TABS.includes(value) && opened.includes(guestAt) && sections.get(guestAt) !== value) {
        sections = new Map(sections).set(guestAt, value);
      }
      acceptedAgentRequest = null;
      recordingShortcut = '';
      shortcutError = '';
      localStorage.setItem(TAB_KEY, value);
      applied();
    };
    const guard = agentsGuard();
    // Ask the shown guest whenever its editor would change: leaving the agent
    // categories (as before), or a choice that moves its own section — also
    // from a non-agent category, where the page shows it on another section.
    const movesGuest = !!guestAt && AGENT_TABS.includes(value) && opened.includes(guestAt) && sectionOf(guestAt) !== value;
    if (guard && movesGuest && !AGENT_TABS.includes(tab)) {
      // The editor that has to answer is hidden (the page is on a person
      // category): REVEAL it on its own section first, so its confirmation is
      // seen and answered where it lives; "keep editing" puts the page back
      // (reviewer P1 on c0969d20). Its section is not touched until accepted.
      const back = { tab, catOpen };
      tab = sectionOf(guestAt);
      catOpen = true;
      guard(apply, () => { if (intent === navigation && guestShown === guestAt) { tab = back.tab; catOpen = back.catOpen; } });
      return;
    }
    if (guard && ((value !== tab && AGENT_TABS.includes(tab)) || movesGuest)) guard(apply);
    else apply();
  }

  function recordShortcut(action: ShortcutAction, event: KeyboardEvent) {
    // Typing (IME, AltGr, a dead key) is neither a binding nor a command to
    // the recorder: a composing Backspace must not clear, a composing Escape
    // must not end recording, and the event stays the input method's.
    if (isCharacterInput(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { recordingShortcut = ''; shortcutError = ''; return; }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      shortcuts.set(action, '');
      recordingShortcut = '';
      shortcutError = '';
      return;
    }
    const value = shortcutFromEvent(event);
    if (!value) return;
    const refused = shortcuts.set(action, value);
    if (refused) {
      shortcutError = t(refused).replace('{key}', shortcutLabel(value));
      return;
    }
    recordingShortcut = '';
    shortcutError = '';
  }

  onDestroy(() => {
    alive = false;
    navigation++;
    clearTimeout(notifyTimer);
  });
</script>

<!-- Settings is a PAGE in the unified skeleton (ui-unification.md "Settings
     as a page"): shared sidebar with category rows, main column with a
     page-head. No backdrop, no X — the rail/tab bar is the way out. -->
<section class="preferences" class:config-compact={!AGENT_TABS.includes(tab)} use:measureLayout class:stacked class:cat-open={catOpen} class:drill-fwd={drillAnim === 'fwd'} class:drill-back={drillAnim === 'back'} aria-label={t('settings')}>
  <aside class="sidebar config-navigation">
    <SideHandle />
    <!-- The category list unfolds on first paint (motion.md §1.15, .reveal:
         rows rise in with a 30ms stagger). Only then: on compact the sidebar
         is display-toggled by the drill, and a re-shown list must not replay
         the unfold on top of the drill-back slide (one motion per view). -->
    <div class="side-scroll subtle-scroll" class:reveal={!drillAnim} use:scrollFade>
      <div class="side-h">{t('settings')}</div>
      <!-- The phone's way to the server registry (review, 2026-09-03): the
           desktop rail carries the switcher above its configure group; on the
           touch layout nothing did, so named servers were invisible where
           they matter most. A .side-row like the categories — swap icon, the
           current server's NAME — opening the same popover the rail opens. -->
      {#if onServers}
        <button class="side-row server-row" class:open={serversOpen} title={t('serversTitle')} aria-haspopup="dialog"
          aria-expanded={serversOpen} aria-controls={serversOpen ? serversControls : undefined} onclick={(e) => onServers?.(e)}>
          <span class="quarter-turn" class:on={serversOpen}><Icon name="swap-h" size={14} /></span>
          <span class="r-label">{serverName}</span>
        </button>
      {/if}
      {#each groups as g (g.id)}
        {#if groups.length > 1}<div class="group-label side-h">{g.label()}</div>{/if}
        {#each g.rows as item (item.id)}
          <button class="side-row" class:open={tab === item.id} onclick={() => selectTab(item.id)}
            use:hoverInfo={() => ({ title: item.label(), text: TAB_HINTS[item.id] ? t(TAB_HINTS[item.id]!) : undefined })}>
            <span class="r-label">{item.label()}</span>
          </button>
        {/each}
      {/each}
    </div>
  </aside>
  <div class="pref-shell">
    <!-- The embedded AgentsPage brings its OWN page head once it opens an
         editor, so Settings yields its head there — two stacked title bars is
         most of a phone's first screenful. -->
    {#if !(AGENT_TABS.includes(tab) && agentsDrilled)}
      <div class="page-head config-page-head">
        <div class="config-head-inner">
        <!-- Compact only: the way back to the category list (the back gesture
             does the same through onGoBack). -->
        <span class="back"><CommandButton variant="icon" icon="arrow-left" label={t('settings')}
          onclick={() => drillPushed ? history.back() : closeCat()} /></span>
        <h1>{tabs.find((x) => x.id === tab)?.label() ?? t('settings')}</h1>
        </div>
      </div>
    {/if}

    <!-- The REAL agent configuration page, not a copy of it: on a phone it is
         already a single column (its list is the screen, an editor takes it
         over), which is exactly the shape a Settings category needs. Its back
         chain is spliced into this page's above. ONE instance per member for
         the four categories, narrowed by `section` — Agents / Teams / Skills /
         MCP are separate second-level pages on the phone (owner, 2026-09-02).
         A guest's LIFE is its member's, not this page's tab (③a, reviewer P1-1
         on 6b923c0d): mounted the first time its server is shown here, kept
         across every other category and while another member is shown —
         hidden and inert — and removed only when the member goes. App keeps
         this page mounted once a guest exists, for the same reason. -->
    {#if guestHeld && AGENT_TABS.includes(tab)}<p class="config-error" role="status">{guestHeld}</p>{/if}
    {#if opened.length}
    <div class="agents-embed" class:off={!AGENT_TABS.includes(tab)} inert={!!guestHeld || !AGENT_TABS.includes(tab)}>
      {#each guests.filter((g) => opened.includes(g.runtime)) as g (g.runtime)}
      {@const on = g.runtime === guestShown && AGENT_TABS.includes(tab) && sectionOf(g.runtime) === tab}
      <div class="guest" class:off={!on} inert={!on}>
      <ServerScope runtime={g.runtime} state={g.state}>
      <AgentsPage
        section={sectionOf(g.runtime)}
        visible={on && guestInput}
        editRequest={acceptedAgentRequest?.serverId === g.runtime.id && sectionOf(g.runtime) === (acceptedAgentRequest.kind === 'team' ? 'teams' : 'agents') ? acceptedAgentRequest : null}
        onGuardExit={(guard: Guard) => registerAgentsGuard(g.runtime, guard)}
        guardPage="prefs"
        guardReveal={() => revealGuest(g.runtime)}
        onGoBack={(fn: () => boolean) => { reg(g.runtime).back = fn; }}
        onDrilled={(d: boolean) => setDrilled(g.runtime, d)}
      />
      </ServerScope>
      </div>
      {/each}
    </div>
    {/if}
    {#if !AGENT_TABS.includes(tab)}
    <!-- The accepted category owns this pane and its existing reveal. -->
    {#key tab}
    <div class="pref-content">
    <div class="config-form reveal">
      {#if tab === 'appearance'}
        <div class="config-section">
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('theme')}</strong></div>
            <div class="pref-control">
            <Segmented value={theme} onchange={onTheme} ariaLabel={t('theme')}
              options={[{ value: 'system', label: t('themeAuto') }, { value: 'light', label: t('themeLight') }, { value: 'dark', label: t('themeDark') }]} />
            </div>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('language')}</strong></div>
            <div class="pref-control">
            <Segmented value={i18n.lang as 'en' | 'zh'} onchange={(l) => setLocale(l)} ariaLabel={t('language')}
              options={[{ value: 'en', label: 'EN' }, { value: 'zh', label: '中文' }]} />
            </div>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('layout')}</strong></div>
            <div class="pref-control">
            <Segmented value={layout.mode} onchange={(m) => layout.set(m)} ariaLabel={t('layout')}
              options={[{ value: 'auto', label: t('layoutAuto') }, { value: 'desktop', label: t('layoutDesktop') }, { value: 'mobile', label: t('layoutMobile') }]} />
            </div>
          </div>
          {#if showUiZoom}
            <div class="preference-row">
              <div class="pref-label"><strong class="config-field-label">{t('uiZoom')}</strong></div>
              <fieldset class="pref-control config-fields" aria-busy={zoomCommand.pending}>
                <Stepper value={uiZoom} min={UI_ZOOM_MIN} max={UI_ZOOM_MAX} step={UI_ZOOM_STEP}
                  label={t('uiZoom')} format={(value) => `${Math.round(value * 100)}%`} disabled={zoomCommand.pending}
                  decreaseLabel={`${t('configDecrease')} ${t('uiZoom')}`}
                  increaseLabel={`${t('configIncrease')} ${t('uiZoom')}`}
                  onchange={(value) => runCommand(zoomCommand, () => onUiZoom(value))} />
                {#if zoomCommand.error}<small class="config-error appear" role="alert">{zoomCommand.error}</small>{/if}
              </fieldset>
            </div>
          {/if}
          <div class="preference-row">
            <div class="pref-label" use:hoverInfo={() => ({ title: t('uiFontBody'), text: t('uiFontBodyHint') })}><strong class="config-field-label">{t('uiFontBody')}</strong></div>
            <fieldset class="pref-control config-fields" aria-busy={fontState.ui.pending}>
              <div class="font-field">
                <Select bind:value={uiFontInput} editable fontPreview options={fontOptions.ui}
                  placeholder={t('fontDefaultUi')} ariaLabel={`${t('uiFontBody')} — ${t('uiFontBodyHint')}`}
                  disabled={fontState.ui.pending} onchange={() => saveFont('ui')} />
                <CommandButton variant="icon" icon="undo" label={`${t('configReset')} ${t('uiFontBody')}`}
                  disabled={fontState.ui.pending || !uiFont.custom} onclick={() => resetFont('ui')} />
              </div>
              {#if fontState.ui.invalid}<small class="config-error font-error appear" role="alert">{t('fontFamilyInvalid')}</small>{/if}
            </fieldset>
          </div>
          <div class="preference-row">
            <div class="pref-label" use:hoverInfo={() => ({ title: t('uiFontDisplay'), text: t('uiFontDisplayHint') })}><strong class="config-field-label">{t('uiFontDisplay')}</strong></div>
            <fieldset class="pref-control config-fields" aria-busy={fontState.display.pending}>
              <div class="font-field">
                <Select bind:value={displayFontInput} editable fontPreview options={fontOptions.display}
                  placeholder={t('fontDefaultDisplay')} ariaLabel={`${t('uiFontDisplay')} — ${t('uiFontDisplayHint')}`}
                  disabled={fontState.display.pending} onchange={() => saveFont('display')} />
                <CommandButton variant="icon" icon="undo" label={`${t('configReset')} ${t('uiFontDisplay')}`}
                  disabled={fontState.display.pending || !displayFont.custom} onclick={() => resetFont('display')} />
              </div>
              {#if fontState.display.invalid}<small class="config-error font-error appear" role="alert">{t('fontFamilyInvalid')}</small>{/if}
            </fieldset>
          </div>
          <!-- The terminal's FAMILY stands with the other two font roles — one
               "which fonts" cluster (owner, 2026-09-21, board #233: "终端的显
               示字体和其他字体设置应该在一起"). Its size and line spacing follow
               it here: the owner reads them as the terminal's LOOK, which is
               what this page is (2026-09-24: "Terminal 的一些风格设置，都应该算
               到 Appearance 里面"), and the one-row Terminal category is gone. -->
          <div class="preference-row">
            <div class="pref-label" use:hoverInfo={() => ({ title: t('fontFamily'), text: t('fontFamilyHint') })}><strong class="config-field-label">{t('fontFamily')}</strong></div>
            <fieldset class="pref-control config-fields" aria-busy={fontState.mono.pending}>
              <div class="font-field">
                <Select bind:value={fontInput} editable fontPreview emptyFace="var(--font-mono)" options={fontOptions.mono}
                  placeholder={t('fontFamilySystem')} ariaLabel={`${t('fontFamily')} — ${t('fontFamilyHint')}`}
                  disabled={fontState.mono.pending} onchange={() => saveFont('mono')} />
                <CommandButton variant="icon" icon="undo" label={`${t('configReset')} ${t('fontFamily')}`}
                  disabled={fontState.mono.pending || !fonts.custom} onclick={() => resetFont('mono')} />
              </div>
              {#if fontState.mono.invalid}<small class="config-error font-error appear" role="alert">{t('fontFamilyInvalid')}</small>{/if}
            </fieldset>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('font')}</strong></div>
            <div class="pref-control">
              <Stepper value={fontSize} min={6} max={40} label={t('font')} format={(value) => `${value}px`}
                decreaseLabel={`${t('configDecrease')} ${t('font')}`}
                increaseLabel={`${t('configIncrease')} ${t('font')}`} onchange={onFontSize} />
            </div>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('lineHeight')}</strong></div>
            <div class="pref-control">
              <Slider value={terminalPrefs.lineHeight} min={LINE_HEIGHT_MIN} max={LINE_HEIGHT_MAX} step={0.05}
                label={t('lineHeight')} resetLabel={`${t('configReset')} ${t('lineHeight')}`}
                defaultValue={1} format={(value) => value.toFixed(2)} onchange={setLineHeight} />
            </div>
          </div>
        </div>
      {:else if tab === 'chat'}
        <!-- How much of the CONVERSATION the feed shows: its own category, not
             rows under Appearance — they set what is said, not how it looks
             (owner, 2026-09-24: "梳理的逻辑没有很好…目录结构要清晰一些"). -->
        <div class="config-section">
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('hubFeedLevel')}</strong></div>
            <div class="pref-control">
            <Segmented value={appPrefs.feedLevel} onchange={(l) => appPrefs.setFeedLevel(l)} ariaLabel={t('hubFeedLevel')}
              options={[{ value: 'chat', label: t('hubFeedChat') }, { value: 'status', label: t('hubFeedStatus') }, { value: 'tools', label: t('hubFeedTools') }]} />
            </div>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('hubStepsRows')}</strong></div>
            <div class="pref-control">
              <Stepper value={appPrefs.stepsRows} min={3} max={30} label={t('hubStepsRows')}
                decreaseLabel={`${t('configDecrease')} ${t('hubStepsRows')}`}
                increaseLabel={`${t('configIncrease')} ${t('hubStepsRows')}`} onchange={appPrefs.setStepsRows} />
            </div>
          </div>
        </div>
      {:else if tab === 'notifications'}
        <div class="config-section">
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('hubNotify')}</strong>{#if notifyPerm === 'denied'}<small class="config-note">{t('hubNotifyDenied')}</small>{:else if notifyPerm === 'unsupported'}<small class="config-note">{t('hubNotifySoundOnly')}</small>{/if}</div>
            <fieldset class="pref-control config-fields" aria-busy={notifyBusy}>
              <Switch checked={notifyOn} onchange={setNotify} label={t('hubNotify')} hideLabel disabled={notifyBusy} />
            </fieldset>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('hubNotifyLevel')}</strong></div>
            <div class="pref-control">
            <Segmented value={notifyLvl} onchange={setLevel} ariaLabel={t('hubNotifyLevel')}
              options={NOTIFY_LEVELS.map((l) => ({ value: l, label: t('hubNotifyLevel_' + l) }))} />
            </div>
          </div>
          <div class="preference-row">
            <div class="pref-label"><strong class="config-field-label">{t('hubNotifyTest')}</strong></div>
            <div class="pref-control">
              <CommandButton label={t('hubNotifyTestAction')} icon="bell" pending={notifyBusy} onclick={testNotify} />
              {#if notifyTested}<div class="config-note appear" role="status">{t('hubNotifyTestSent')}</div>{/if}
              {#if notifyError}<div class="config-error appear" role="alert">{notifyError}</div>{/if}
            </div>
          </div>
        </div>
      {:else if tab === 'shortcuts'}
        <div class="config-section">
          {#each shortcutGroups as { group, defs } (group)}
            <div class="side-h shortcut-group">{t(`shortcutGroup_${group}`)}</div>
            {#each defs as def (def.id)}
              {@const why = unavailable(def)}
              <div class="preference-row">
                <div class="pref-label"><strong class="config-field-label">{t(def.label)}</strong>
                  {#if why}<small class="config-note">{t(why)}</small>{/if}</div>
                <div class="pref-control shortcut-control">
                  <button
                    type="button" class="config-input mono shortcut-key" aria-label={t(def.label)}
                    class:recording={recordingShortcut === def.id}
                    disabled={!!why}
                    data-shortcut-recorder
                    onclick={() => { recordingShortcut = def.id; shortcutError = ''; }}
                    onkeydown={(event) => recordShortcut(def.id, event)}
                  >{recordingShortcut === def.id ? t('shortcutPressKeys') : shortcutLabel(shortcuts.get(def.id))}</button>
                  <CommandButton variant="icon" icon="undo" label={`${t('configReset')} ${t(def.label)}`}
                    disabled={!!why || shortcuts.isDefault(def.id)}
                    onclick={() => { const r = shortcuts.resetOne(def.id); shortcutError = r ? t(r).replace('{key}', '') : ''; recordingShortcut = ''; }} />
                </div>
              </div>
              {#if shortcutError && recordingShortcut === def.id}<div class="config-error appear" role="alert">{shortcutError}</div>{/if}
            {/each}
          {/each}
          {#if shortcutError && !recordingShortcut}<div class="config-error appear" role="alert">{shortcutError}</div>{/if}
          <CommandButton label={t('shortcutReset')} icon="undo"
            onclick={() => { shortcuts.reset(); recordingShortcut = ''; shortcutError = ''; }} />
        </div>
      {:else}
        <div class="config-section">
          {#if onConnectionMode}
            <div class="preference-row">
              <div class="pref-label"><strong class="config-field-label">{t('connectionMode')}</strong></div>
              <div class="pref-control">
              <Segmented value={connectionMode} onchange={(m) => onConnectionMode?.(m)} ariaLabel={t('connectionMode')}
                disabled={connectionModeFrozen}
                options={[{ value: 'single', label: t('connectionModeSingle') }, { value: 'aggregate', label: t('connectionModeAggregate') }]} />
              </div>
            </div>
          {/if}
          {#if savedServers}
            <div class="saved-servers" role="group" aria-label={t('serversSaved')}>
              <strong class="config-field-label">{t('serversSaved')}</strong>
              {@render savedServers()}
            </div>
          {/if}
          {#if connected}
            <div class="connection-title">
              <div><strong class="config-field-label">{serverInfo.hostname || 'unknown'}<ServerTag name={serverTag} /></strong><small class="config-note connection-id">{serverInfo.machineId?.slice(0, 8) || '—'}</small></div>
              <div class="conn-actions">
                {#if addresses.length > 1}<CommandButton label={t('sniff')} icon="refresh"
                  pending={optimizing || commands.optimize.pending}
                  onclick={() => { if (!optimizing) void runCommand(commands.optimize, onOptimize); }} />{/if}
                <CommandButton label={t('shareLink')} icon={linkCopied ? 'check' : 'copy'}
                  pending={commands.share.pending} onclick={() => runCommand(commands.share, onShare)} />
              </div>
            </div>
            {#each [commands.optimize, commands.share] as command}
              {#if command.error}<div class="config-error appear" role="alert">{command.error}</div>{/if}
            {/each}
            <!-- One status-dot language (design-language.md §Colour): at rest
                 achromatic, the current address accent, the one still dialing
                 accent + `.live-dot` — the same cue an agent in motion wears.
                 The wrapper row exists so the list can `animate:flip` (Svelte
                 wants the animated element to be the each block's only child);
                 it also CARRIES the dragged row: the inline transform follows
                 the pointer with no transition, and on release the flip
                 measures from that translated rect, so the row settles from
                 under the finger into its new slot instead of jumping back. -->
            <div class="address-list" class:reordering={!!addrDrag} role="group" aria-label={t('addresses')}
              onpointermove={addrPointerMove} onpointerup={addrPointerUp} onpointercancel={addrCancelDrag}>
              {#each (addresses.length ? addresses : [activeAddress]) as address (address)}
                {@const pending = address === pendingAddress}
                {@const active = address === activeAddress}
                <div class="address-row" class:lifted={addrDrag?.address === address}
                  style:transform={addrDrag?.address === address ? `translateY(${addrDrag.dy}px)` : null}
                  data-addr-row={address} animate:flip={{ duration: moveMs() }}>
                  {#if addresses.length > 1}
                    <button type="button" class="addr-grip" aria-label={t('addressDrag')}
                      disabled={!!pendingAddress || commands.address.pending}
                      onpointerdown={(e) => addrPointerDown(e, address)}
                      onkeydown={(e) => addrGripKey(e, address)}>
                      <Icon name="grip" size={13} />
                    </button>
                  {/if}
                  <button type="button" class="config-input address-choice" class:active class:pending aria-busy={pending || undefined}
                    disabled={!!pendingAddress || commands.address.pending}
                    use:hoverInfo={() => ({ title: address, lines: [pending
                      ? { label: t('status'), value: t('connecting'), tone: 'warn' }
                      : active ? { label: t('status'), value: t('serverCurrent'), tone: 'accent' }
                      : { label: t('status'), value: t('addressAlternate') }] })}
                    onclick={() => { if (!active && !pendingAddress) void runCommand(commands.address, () => onAddress(address)); }}>
                    <span class="addr-dot" class:live-dot={pending}></span><span class="addr-text">{address}</span>
                  </button>
                  {#if addresses.length && !active}
                    <!-- The × is the shared danger icon command (rule 6), used
                         exactly as the roster's Stop: the atom carries the hit
                         box (44px on touch), the radius, the quiet→full ink and
                         the focus ring; bare — the row under it already carries
                         the hover. -->
                    <CommandButton variant="danger" iconOnly bare icon="x" label={`${t('delete')} ${address}`}
                      disabled={!!pendingAddress || commands.address.pending}
                      onclick={() => removeAddress(address)} />
                  {/if}
                </div>
              {/each}
              {#if addrDrag}
                <div class="addr-drop appear" aria-hidden="true"
                  style:top="{(railDropOffset(addrDrag.rects, addrDrag.idx) ?? addrDrag.listTop) - addrDrag.listTop}px"></div>
              {/if}
            </div>
            {#if commands.address.error}<div class="config-error appear" role="alert">{commands.address.error}</div>{/if}
          {:else}
            <div class="empty-connection">
              <span class="config-note">{t('notConnected')}</span>
              <CommandButton label={t('connectionSetup')} icon="link" pending={commands.setup.pending}
                onclick={() => runCommand(commands.setup, onConnectionSetup)} />
              {#if commands.setup.error}<div class="config-error appear" role="alert">{commands.setup.error}</div>{/if}
            </div>
          {/if}
        </div>
        {#if connected}
          <div>
            <CommandButton variant="danger" label={t('disconnect')} icon="x" pending={commands.disconnect.pending}
              onclick={() => runCommand(commands.disconnect, onDisconnect)} />
            {#if commands.disconnect.error}<div class="config-error appear" role="alert">{commands.disconnect.error}</div>{/if}
          </div>
        {/if}
      {/if}
    </div>
    </div>
    {/key}
    {/if}
  </div>
</section>

<style>
  /* Page skeleton (ui-unification.md): shared sidebar + main column. */
  .preferences {
    height: 100%; min-height: 0;
    display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    background: var(--bg); color: var(--text);
  }
  .sidebar { position: relative; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .side-scroll { flex: 1; overflow-y: auto; padding: 8px; }
  /* A control among categories: muted like the rail's server control, set
     off from the category rows by a divider; the name ellipsizes. */
  .server-row { color: var(--text2); margin-bottom: 6px; padding-bottom: 8px; border-bottom: 1px solid var(--border2); border-radius: var(--ui-radius-row) var(--ui-radius-row) 0 0; }
  .server-row :global(svg) { flex: none; color: var(--text3); }
  .server-row .r-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r-label { flex: 1; min-width: 0; }
  /* The saved servers sit ABOVE the current machine's address list: two
     layers — which server, then how to reach it (board 315). */
  .saved-servers { display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--border2); }
  .pref-shell { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .back { display: none; }
  .preferences.stacked { grid-template-columns: minmax(0, 1fr); }
  .stacked:not(.cat-open) .pref-shell, .stacked.cat-open .sidebar { display: none; }
  .stacked .sidebar { border-right: none; }
  .stacked .back { display: grid; }
  /* Compact = the drill-down every other page speaks (AgentsPage's editor
     pattern): the category LIST is the first screen — the same shared sidebar,
     full width — and an open category takes the whole screen with a back
     button in its head. The chip row this replaces was a third navigation
     species nothing else wore. */
  @media (max-width: 760px) {
    .preferences { grid-template-columns: minmax(0, 1fr); }
    .preferences:not(.cat-open) .pref-shell { display: none; }
    .preferences.cat-open .sidebar { display: none; }
    .sidebar { border-right: none; }
    .back { display: grid; }
    /* Drill motion, compact only: deeper enters from the right, back from
       the left — same 120ms grammar as the app-level page slide. */
    .preferences.drill-fwd .pref-shell { animation: drill-in-right 0.12s linear; }
    .preferences.drill-back .sidebar { animation: drill-in-left 0.12s linear; }
  }
  @media (prefers-reduced-motion: reduce) {
    .preferences.drill-fwd .pref-shell, .preferences.drill-back .sidebar { animation: none; }
  }
  .pref-content { flex: 1; min-width: 0; min-height: 0; overflow: auto; }
  /* The embedded AgentsPage is a PAGE (its root is height:100%), so it takes the
     shell's remaining height instead of living inside a padded, scrolling pane —
     it brings its own list scroller and its own editor. */
  .agents-embed { flex: 1; min-width: 0; min-height: 0; }
  /* One guest per member (③a): only the shown one takes the box. */
  .guest { display: contents; }
  .guest.off, .agents-embed.off { display: none; }
  .pref-label { display: flex; flex-direction: column; gap: var(--config-label-gap); }
  /* A recorder and its reset: the Slider's field + undo pair (board 316). */
  .shortcut-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .shortcut-control .shortcut-key { flex: 1; min-width: 0; }
  .shortcut-group { padding-inline: 0; }
  .shortcut-key { text-align: center; cursor: pointer; transition: background var(--t-fast), color var(--t-fast); }
  .shortcut-key.recording { border-color: var(--accent-line); background: var(--accent-bg); color: var(--accent-ink); }
  .connection-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--config-field-gap); margin-bottom: var(--config-field-gap); }
  .connection-title > div:first-child { display: flex; flex-direction: column; gap: var(--config-label-gap); min-width: 0; }
  .connection-id { font-family: var(--font-mono); user-select: text; }
  .conn-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .address-list { display: flex; flex-direction: column; gap: 8px; position: relative; }
  .address-row { display: flex; align-items: center; gap: 6px; }
  /* A font field and its reset (board 312): the Slider's field + undo pair. */
  .font-field { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .font-field > :global(.sel-combo) { flex: 1; min-width: 0; }
  /* Lifted = carrying the dragged row: it paints over its neighbours. */
  .address-row.lifted { position: relative; z-index: 2; }
  .address-choice { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer; }
  .address-choice.active { border-color: var(--accent-line); background: var(--accent-bg); color: var(--accent-ink); }
  .addr-text { min-width: 0; overflow-x: auto; white-space: nowrap; font-family: var(--font-mono); }
  .addr-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--status-sleep);transition:background var(--t-fast)}
  .address-list button.active .addr-dot,.address-list button.pending .addr-dot{background:var(--accent)}
  /* The drag handle: quiet at rest, `touch-action: none` so a touch drag
     reorders instead of scrolling the page (the row itself stays a switch
     command, so the gesture needs its own target). A gesture target, not a
     command — but the same hit box the commands get: --control-height is 28px
     on the desktop and the 44px floor on touch. */
  .addr-grip {
    flex: none; width: var(--control-height); height: var(--control-height); padding: 0;
    display: grid; place-items: center;
    border: none; border-radius: var(--ui-radius-control); background: none;
    color: var(--text3); cursor: grab; touch-action: none;
    -webkit-tap-highlight-color: transparent; transition: color var(--t-fast), background var(--t-fast);
  }
  .addr-grip:hover:not(:disabled) { color: var(--text2); background: var(--bg3); }
  .addr-grip:disabled { opacity: 0.4; cursor: default; }
  /* Mid-drag the pointer's row wears the accent selection it already uses for
     "active"; the insertion point is an accent LINE on the edge the row would
     push down — the rail's drag grammar, unchanged. */
  .address-list.reordering { cursor: grabbing; user-select: none; }
  .address-list.reordering .addr-grip { cursor: grabbing; }
  .address-row.lifted .address-choice {
    border-color: var(--accent-line); background: var(--accent-bg); color: var(--accent-ink);
    box-shadow: var(--menu-shadow);
  }
  .addr-drop {
    position: absolute; left: 0; right: 0; height: 2px;
    background: var(--accent); border-radius: 1px;
    z-index: 1; pointer-events: none;
  }
  .empty-connection { display: flex; flex-direction: column; align-items: flex-start; gap: var(--config-field-gap); }
</style>
