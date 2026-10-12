<script>
  import { untrack } from 'svelte';
  import { useServerScope } from '../app/server-context.ts';
  import ServerTag from '../ui/ServerTag.svelte';
  import { Terminal } from '@xterm/xterm';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import Icon from '../ui/Icon.svelte';
  import AgentChip from '../ui/AgentChip.svelte';
  import PanePicker from '../sessions/PanePicker.svelte';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import OperationFeedback from '../ui/OperationFeedback.svelte';
  import { createFeedbackLifetime } from '../ui/feedback-lifetime.ts';
  import { anchorOf } from '../ui/placement.ts';
  import { flip } from 'svelte/animate';
  import { moveMs } from '../ui/motion.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { agentByBackend, paneIsAgent, paneAgent } from '../core/agents.ts';
  import { copyText } from '../core/clipboard.ts';
  import { fonts } from '../app/fonts.svelte.ts';
  import { terminalPrefs } from '../app/terminal-prefs.svelte.ts';
  import { adaptAnsiColors } from './ansi-colors.ts';
  import { compactLineGeometry } from './terminal-line-geometry.ts';
  import { selStart, selContains, selLength, selForDrag, selFromExclusive, wordBounds } from './selection-model.ts';
  import { pointToCell, handleGrabOffset, snapHandleColumn, selectionView, hitSelectionHandle } from './terminal-gesture-geometry.ts';
  import { createTerminalGestures } from './terminal-gestures.ts';
  import { computeCursorLayout } from './cursor-layout.ts';
  import { restoreViewportAfterPaneSwitch } from './terminal-viewport.ts';
  import { cycleItem } from '../app/shortcuts.ts';
  import { createOneShotCtrl, encodeTerminalShortcut } from './terminal-keyboard.ts';
  import { createTerminalResponseFilter } from './terminal-responses.ts';
  import { writeTerminalFrame } from './terminal-frame.ts';
  import { createKeyQueue, pasteOrFallback } from './terminal-input.ts';
  import { openExternalUrl } from '../core/external-links.ts';

  // Timing constants
  const WINDOW_LIST_POLL_MS = 5000;
  // Max wait for server to echo our resize. If never confirmed (external resize
  // or slow tmux), client falls back to trusting server-reported dimensions.
  const RESIZE_CONFIRM_TIMEOUT_MS = 5000;

  // xterm.js fallback cell size ratios (used when render dimensions unavailable)
  const CELL_W_RATIO = 0.6;
  const CELL_H_RATIO = 1.2;

  const SCROLLBAR_TOUCH_WIDTH = 30;

  // `embedded` = rendered inside a split-screen cell. The cell uses this
  // Terminal's OWN window-switcher bar as its header (same form as the
  // single-pane view), so when embedded we always show that bar and add a
  // close button to it. `onClose` (split only) closes the cell.
  // `active` (split only): is this the focused cell? Only the active cell
  // grabs DOM focus for its hidden xterm textarea — there is exactly ONE
  // focusable textarea per document, so N cells auto-focusing on mount/rebuild
  // fight each other and end up with input going nowhere. Single-pane is
  // always active.
  // `chromeless` = embedded with NO window-switcher bar (used by the desktop
  // agent grid, where each cell is pinned to one agent's pane — there is
  // nothing to switch to, so the bar would only steal vertical space).
  let { target, session, fontSize = 14, embedded = false, active = true, chromeless = false, visible = true, onSwitchPane = null, onPaneExit = () => {}, onClose = null, onOpenSessions = null, splitEligible = false, splitActive = false, splitLayout = 1, onSetLayout = null } = $props();
  // This server's pane stream and RPCs, read once at init (board #335 ②b).
  // The stream (subscribe and its listeners) lives on the CONNECTION, not the
  // api, so Terminal takes the runtime. It stays on the raw connection on
  // purpose: teardown has to unsubscribe even after the handle is detached,
  // and the provider tears the old tree down before the next one mounts.
  // No fallback: a Terminal outside a provider has no server to show.
  const scope = useServerScope();
  const runtime = scope?.runtime ?? null;
  if (!runtime) throw new Error('Terminal needs a server scope');
  const { subscribe, unsubscribe, addPaneOutputListener, removePaneOutputListener, addPaneClosedListener, removePaneClosedListener } = runtime.connection;
  const { sendKeys, pasteText, listPanes, capturePane, resizePane, newWindow } = runtime.api;
  // The chip bar's layout menu is the shared `ui/ContextMenu`, anchored to
  // its toggle exactly like the shell's floating one in split mode (App.svelte).
  // It was a hand-rolled `position:absolute` strip with a backdrop — no
  // Escape, no close on scroll/resize, no viewport clamp (review, 2026-09-03).
  let splitMenuAt = $state(null);
  const SPLIT_CHOICES = [1, 2, 3, 4, 6];
  const splitMenuItems = $derived(SPLIT_CHOICES.map((n) => ({
    label: n === 1 ? t('splitSingle') : t('splitPanes').replace('{n}', String(n)),
    checked: n === 1 ? !splitActive : (splitActive && splitLayout === n),
    onselect: () => onSetLayout?.(n),
  })));
  function toggleSplitMenu(e) {
    e.stopPropagation();
    splitMenuAt = splitMenuAt ? null : { anchor: anchorOf(e.currentTarget), trigger: e.currentTarget };
  }

  // The agent backend the shown pane runs, as the server derived it from the
  // pane's processes (board #260): pushed with every current_command change
  // on pane_output, and forgotten when the target changes so a switch never
  // carries the previous pane's verdict.
  let liveAgent = $state(null);
  $effect(() => { void target; liveAgent = null; });

  // Keyboard as an OVERLAY instead of a resize, for agent TUIs only.
  //
  // Opening the phone keyboard shrinks the viewport, which shrinks the terminal
  // box, which changes cols×rows, which makes tmux resize the window — and a
  // full-screen agent CLI answers that by repainting its entire conversation.
  // On a long session that takes seconds, and every keyboard open AND close pays
  // it. So for those apps we keep the terminal's box (see the `.keep-rows` rule
  // in this file's CSS): the element stays its full height, bottom-anchored, and
  // the keyboard simply covers its top rows. tmux is never told anything, so
  // nothing reflows.
  //
  // Editors are deliberately NOT in this set: `vim` repaints cheaply and it
  // genuinely needs to lay itself out inside the visible area, so it keeps the
  // normal resize behaviour. The verdict is the server's pane `agent` — the
  // same one that paints the agent icons — so "which apps are chat TUIs" is
  // answered in one place.
  const keepRowsOnKeyboard = $derived(isMobile && !!agentByBackend(liveAgent));
  let termEl;
  // `term` is a plain let on purpose: it is read in hundreds of places and
  // must not turn every effect that touches it into a dependency. The
  // reactive HANDLE is `termGen` — bumped once per xterm build by the
  // lifecycle effect — so an effect that wants "the current instance" reads
  // `termGen` first and then `term`.
  let term;
  let termGen = $state(0);
  let termAtBottom = $state(true);
  let hasNewContent = $state(false); // set when new output arrives while user is scrolled up
  // The newest frame for THIS target, component-scoped so the repaint-on-show
  // effect can replay it. Plain lets on purpose: a frame arriving must never
  // re-run an effect. Reset at the top of the subscription effect.
  let lastContent = '';
  let lastCursor = null;
  let copyFeedback = $state(null);
  let connectionFeedback = $state(null);
  const copyFeedbackLifetime = createFeedbackLifetime(value => { copyFeedback = value; });
  const connectionFeedbackLifetime = createFeedbackLifetime(value => { connectionFeedback = value; });

  function clearTerminalFeedback() {
    copyFeedbackLifetime.clear();
    connectionFeedbackLifetime.clear();
    sendFailCount = 0;
  }

  $effect(() => {
    target; session; visible; termGen;
    untrack(clearTerminalFeedback);
  });
  $effect(() => () => {
    copyFeedbackLifetime.dispose();
    connectionFeedbackLifetime.dispose();
  });
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Visual width of xterm's overlay scrollbar (passed to the Terminal ctor
  // below). It floats ON TOP of the content's right edge and does NOT
  // reserve layout space — calcFit deliberately uses the full width so the
  // pane gets the maximum column count; the trade-off is the scrollbar
  // briefly overlapping the last glyph. Kept narrow so it doesn't feel
  // visually heavy; on mobile it stays a touch wider for fingertip drag.
  const SCROLLBAR_W = isMobile ? 12 : 8;
  let kbBlurTimer = null;
  let kbLocked = true; // true = keyboard must not show; false = keyboard allowed
  let unlockUntil = 0; // grace window after explicit unlock; auto-lock paths must respect it
  let unlockRetries = 0; // blur re-focus attempts inside the current grace window
  const UNLOCK_RETRY_MAX = 2;
  let endTouchScrollTimer = null;
  let kbTa = null; // set in $effect after term.open
  // The shortcut bar's Ctrl one-shot (terminal-keyboard.md). The arming,
  // consumption and 4 s expiry live in terminal-keyboard.ts; `ctrlArmed` is
  // the template's reactive mirror and is written ONLY through onChange.
  let ctrlArmed = $state(false);
  const ctrlOneShot = createOneShotCtrl({ onChange: (armed) => { ctrlArmed = armed; } });

  function preparePaneSwitch() {
    document.activeElement?.blur();
    touchScrolling = false;
    restoreViewportAfterPaneSwitch({
      isMobile,
      fullHeight: window.__fullHeight?.() || window.innerHeight,
      root: document.documentElement,
    });
  }

  $effect(() => {
    target;
    ctrlOneShot.disarm(); // pane switch
    return () => ctrlOneShot.disarm(); // teardown: no expiry timer outlives the component
  });

  // The ONLY two writers of `kbLocked` (terminal-keyboard.md): unlockKeyboard()
  // opens, lockKeyboard() closes. Its four callers — pane switch, the blur
  // timer, the keyboard-shift close transition, and the bar's close key —
  // are the sanctioned lock sites; `endTouchScroll` and every other timer path
  // must never lock, because a delayed timer racing a fresh unlock is how the
  // keyboard used to vanish under the user's finger. unlockKeyboard() has ONE
  // caller of its own — the double-tap (#296 retired the bar's open key) —
  // labelled at the call site.
  function lockKeyboard() {
    kbLocked = true;
  }

  function unlockKeyboard() {
    clearTimeout(kbBlurTimer);
    // Opening the keyboard means the user is about to type, so settle any
    // suppressed-rendering state instead of merely cancelling its timer.
    // Cancelling was the old behaviour and it leaked: an unlock
    // within TOUCH_END_DELAY_MS of a scroll killed the only pending
    // endTouchScroll, leaving `touchScrolling` pinned forever — every later
    // frame was dropped and the characters the user then typed never appeared.
    resumeLiveTailRef?.();
    kbLocked = false;
    unlockUntil = Date.now() + 1500;
    unlockRetries = 0;
    // inputmode is pinned to "text" at init; no toggle here.
    if (kbTa) {
      // If the textarea is somehow already focused while the IME is
      // hidden (e.g. user closed IME via the system keyboard's own button
      // or back gesture, leaving view focus untouched), a fresh focus()
      // is a no-op and the IME stays down. blur() first to make the next
      // focus a true focus transition.
      if (document.activeElement === kbTa) kbTa.blur();
      kbTa.focus();
    }
  }

  let theme = $state(document.documentElement.getAttribute('data-theme') || 'dark');

  $effect(() => {
    const obs = new MutationObserver(() => {
      theme = document.documentElement.getAttribute('data-theme') || 'dark';
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  });

  const darkTheme = {
    background: '#0a0a0f', foreground: '#c9d1d9', cursor: '#00d4ff',
    selectionBackground: 'rgba(0, 212, 255, 0.18)',
    // Overlay scrollbar slider — kept very translucent so it barely occludes
    // terminal content at rest, lifting slightly on hover/drag.
    scrollbarSliderBackground: 'rgba(201, 209, 217, 0.12)',
    scrollbarSliderHoverBackground: 'rgba(201, 209, 217, 0.28)',
    scrollbarSliderActiveBackground: 'rgba(201, 209, 217, 0.40)',
    black: '#0a0a0f', brightBlack: '#484848',
    red: '#ff5050', brightRed: '#ff6b6b',
    green: '#4ade80', brightGreen: '#6ee7a0',
    yellow: '#fbbf24', brightYellow: '#fcd34d',
    blue: '#00d4ff', brightBlue: '#38bdf8',
    magenta: '#c084fc', brightMagenta: '#d8b4fe',
    cyan: '#22d3ee', brightCyan: '#67e8f9',
    white: '#c9d1d9', brightWhite: '#f1f5f9',
  };
  const lightTheme = {
    background: '#f5f5f7', foreground: '#1a1a2e', cursor: '#0088cc',
    selectionBackground: 'rgba(0, 136, 204, 0.18)',
    scrollbarSliderBackground: 'rgba(26, 26, 46, 0.12)',
    scrollbarSliderHoverBackground: 'rgba(26, 26, 46, 0.26)',
    scrollbarSliderActiveBackground: 'rgba(26, 26, 46, 0.38)',
    black: '#f5f5f7', brightBlack: '#9ca3af',
    red: '#dc2626', brightRed: '#ef4444',
    green: '#16a34a', brightGreen: '#22c55e',
    yellow: '#ca8a04', brightYellow: '#eab308',
    blue: '#0088cc', brightBlue: '#2563eb',
    magenta: '#9333ea', brightMagenta: '#a855f7',
    cyan: '#0891b2', brightCyan: '#06b6d4',
    white: '#1a1a2e', brightWhite: '#0f0f1a',
  };

  function getTermTheme() {
    return theme === 'light' ? lightTheme : darkTheme;
  }

  // LIVE option updates. A theme / font / line-height change is an
  // `term.options` write on the running instance — never a rebuild. These two
  // effects read `termGen` FIRST: `term` itself is not reactive, and an effect
  // that returned on `!term` before reading anything reactive tracked nothing
  // and never ran again (the pre-2026-09-03 state: both were dead, and every
  // such change fell through to the lifecycle effect's full teardown).
  $effect(() => {
    termGen;
    const t = getTermTheme();
    if (!term) return;
    term.options.theme = t;
    if (termEl) {
      termEl.style.background = t.background;
    }
  });

  $effect(() => {
    termGen;
    const size = fontSize;
    const family = fonts.stack; // follows the custom-font setting live
    const lh = terminalPrefs.lineHeight;
    if (!term) return;
    // The lifecycle effect constructs xterm with the current values, so the
    // run this triggers right after a build changes nothing and must not
    // schedule a refit (which would send a redundant resize_pane).
    if (term.options.fontSize === size && term.options.fontFamily === family && term.options.lineHeight === lh) return;
    term.options.fontSize = size;
    term.options.fontFamily = family;
    term.options.lineHeight = lh;
    // xterm re-measures cell geometry on the next render, not synchronously.
    // Defer refit by two frames so calcFit reads the new cell width/height.
    // doResizeRef is set by the lifecycle effect after term is created.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => doResizeRef?.());
    });
  });
  let doResizeRef = null;
  // Set by the main $effect (needs its `lastContent` closure). Releases every
  // state that suppresses rendering — see resumeLiveTail().
  let resumeLiveTailRef = null;

  // pane_output snapshots carry `current_command` + `agent` on every command
  // change; the pane-output listener below keeps `liveAgent` fresh from them,
  // no separate polling RPC needed.

  // Window switcher
  let windowPanes = $state([]);
  let showWindowCmd = $state(localStorage.getItem('tmux_winswitcher') === '1');
  let showPanePicker = $state(false); // session-badge → jump-to-any-pane popover

  // Desktop split: when this cell becomes the active one, pull DOM focus to
  // its xterm textarea so keystrokes route here. (Single-pane: active is
  // always true; the mousedown/mount focus covers it.)
  $effect(() => {
    termGen;
    if (!embedded || isMobile || !active || !term) return;
    requestAnimationFrame(() => { try { term?.focus(); } catch {} });
  });

  // Coming back to a hidden terminal replays the newest frame. While hidden,
  // onPaneOutputCb records frames without rendering them (the whole pipeline —
  // color adaptation, full-screen write, WebGL draw — ran invisibly for every
  // busy pane and cooked the machine; owner, 2026-08-22). `lastContent` and
  // friends are plain lets, so this effect re-runs on `visible` alone.
  let wasVisible = true;
  $effect(() => {
    if (!visible) { wasVisible = false; return; }
    if (wasVisible) return;
    wasVisible = true;
    // Our box did not change while hidden (the page layer keeps its layout),
    // so no ResizeObserver tick will come — but tmux may now hold another
    // instance's size for this pane. Assert ours once (owner, 2026-09-14:
    // "应该加一次窗口尺寸的设置到新的尺寸"; board #198).
    doResizeRef?.({ assert: true });
    if (!term || lastContent == null) return;
    if (termAtBottom) {
      writeToXterm(lastContent, lastCursor);
      term.refresh(0, term.rows - 1);
    } else {
      // The reader was in scrollback: keep their place, light the pill.
      hasNewContent = true;
    }
  });

  let currentWindow = $derived(target.split(':')[1]?.split('.')[0] || '');

  // A chip's facts for the hover card (motion.md principle 16): the same
  // pane data the strip is built from. Chrome only — the card is a fixed
  // layer of its own and nothing here touches xterm's box (principle 9).
  function windowInfo(w) {
    const agent = paneAgent(w);
    const lines = [];
    if (w.current_command) lines.push({ label: t('hoverCommand'), value: w.child_cmd || w.current_command });
    lines.push({ label: t('hoverPanes'), value: String(windowPanes.filter(p => p.window === w.window).length) });
    if (agent) lines.push({ label: t('hoverAgent'), value: agent.tag, tone: 'accent' });
    return { title: `${w.window}:${w.window_name}`, lines };
  }

  // Group panes by window. Representative pane preference:
  //   agent pane > active pane > first listed.
  // The old "first listed" pick made a window whose layout is
  // [zsh | claude] show a zsh chip — the agent badge silently vanished.
  let windows = $derived.by(() => {
    const map = new Map();
    for (const p of windowPanes) {
      const cur = map.get(p.window);
      if (!cur) { map.set(p.window, p); continue; }
      const curScore = paneIsAgent(cur) ? 2 : cur.active ? 1 : 0;
      const pScore = paneIsAgent(p) ? 2 : p.active ? 1 : 0;
      if (pScore > curScore) map.set(p.window, p);
    }
    return [...map.values()];
  });

  $effect(() => {
    if (!active || chromeless) return;
    const onWindowShortcut = (event) => {
      const items = windows;
      if (!onSwitchPane || items.length < 2) return;
      const current = items.find(item => String(item.window) === currentWindow) || items[0];
      const next = cycleItem(items, current, event.detail.direction);
      if (!next || String(next.window) === currentWindow) return;
      preparePaneSwitch();
      onSwitchPane(`${next.session}:${next.window}.${next.pane}`);
    };
    window.addEventListener('terminal-window-shortcut', onWindowShortcut);
    return () => window.removeEventListener('terminal-window-shortcut', onWindowShortcut);
  });

  // Agent (if any) running in the currently-shown window.
  let currentWinAgent = $derived.by(() => {
    const cur = windows.find(w => String(w.window) === currentWindow);
    if (!cur) return null;
    return paneAgent(cur);
  });

  // The switcher is always shown (except chromeless agent-grid cells, which
  // have no chrome at all). It isn't just for switching windows — it also
  // carries the session picker, the new-window button, and the split-layout
  // control, so hiding it for a single-window session strands those too.
  // The collapsed state is a floating chip that steals no vertical space.
  let showSwitcher = $derived(!chromeless);

  $effect(() => {
    if (!session) return;
    // Chromeless cells (agent grid) have no switcher, so the window-list poll
    // is pure waste — skip it entirely (N agent cells would otherwise each
    // poll listPanes every few seconds).
    if (chromeless) return;
    // In-flight guard: on a slow link a poll RPC can outlive the 5 s
    // interval; without the guard, ticks stack unbounded requests on a
    // link that is already struggling.
    let polling = false;
    const load = async () => {
      if (polling) return;
      polling = true;
      try {
        const p = await listPanes(session);
        windowPanes = p;
      } catch {}
      polling = false;
    };
    load();
    const id = setInterval(load, WINDOW_LIST_POLL_MS);
    return () => clearInterval(id);
  });

  // Read xterm's actual rendered cell dimensions (falls back to font-size-based estimate
  // before first paint). Single source of truth for calcFit / touch mapping / momentum scroll.
  function cellSize(t) {
    if (!t) return { w: 0, h: 0 };
    const core = t._core;
    return {
      w: core?._renderService?.dimensions?.css?.cell?.width || (t.options.fontSize * CELL_W_RATIO),
      h: core?._renderService?.dimensions?.css?.cell?.height || (t.options.fontSize * CELL_H_RATIO),
    };
  }

  function syncCompactLineGeometry() {
    if (!term || !termEl) return;
    const core = term._core;
    const dimensions = core?._renderService?.dimensions;
    const devicePixelRatio = core?._coreBrowserService?.dpr || window.devicePixelRatio || 1;
    const geometry = compactLineGeometry(
      dimensions?.device?.char?.height,
      dimensions?.css?.cell?.height,
      devicePixelRatio,
      term.options.lineHeight,
    );
    termEl.classList.toggle('compact-lines', !!geometry);
    if (!geometry) {
      termEl.style.removeProperty('--xterm-char-height');
      termEl.style.removeProperty('--xterm-line-offset');
      return;
    }
    termEl.style.setProperty('--xterm-char-height', `${geometry.charCssHeight}px`);
    termEl.style.setProperty('--xterm-line-offset', `${geometry.offset}px`);
  }

  // Calculate optimal cols/rows based on current container size
  function calcFit() {
    if (!term || !termEl) return null;
    const { w: cellW, h: cellH } = cellSize(term);
    // Use the full container width. The overlay scrollbar floats ON TOP of
    // the rightmost column rather than reserving space — that's acceptable
    // (a brief overlap of the last glyph) in exchange for more usable
    // columns. Because cols = floor(w / cellW), cols × cellW ≤ w, so the
    // text's right edge never spills past the screen.
    const w = termEl.clientWidth;
    const h = termEl.clientHeight;
    if (!w || !h || !cellW || !cellH) return null;
    return { cols: Math.max(2, Math.floor(w / cellW)), rows: Math.max(1, Math.floor(h / cellH)) };
  }

  let touchScrolling = false; // set by touch handler, pauses content updates

  // ─── Mobile text selection ────────────────────────────────────────────────
  // First principle: a selection is an *object* (anchor + head, both inclusive
  // buffer-row/col), not a transient state of the touch handler. Once made
  // (long-press, double/triple-tap), it lives until the user explicitly copies
  // (toolbar) or cancels (tap outside, new long-press, pane switch).
  //
  // The two endpoints are independently draggable via handles. We never store
  // pre-sorted (start, end) in the source-of-truth — selStart/selEnd derive
  // them from anchor/head so a handle drag that crosses the other endpoint
  // just flips which one is "leading" without any swap bookkeeping.
  let selection = $state(null); // null | { anchor: {row, col}, head: {row, col} }
  let selectionLayout = $state(null); // live cell/viewport measurements, refreshed at the existing geometry call sites
  let selToolbarHeight = $state(0);
  const selUI = $derived(selection && selectionLayout
    ? selectionView(selection, selectionLayout.cell, selectionLayout.viewport, selToolbarHeight) : null);
  let isApplyingSelection = false; // guard onSelectionChange while we drive term.select ourselves
  // Toolbar button handlers — assigned inside the $effect that owns `term`,
  // `lastContent`, etc. The template guards on `selection != null`, which can
  // only happen after the effect has run, so the assignment is always live
  // when the buttons can be clicked.
  let copySelection = () => {};
  let clearSelection = () => {};

  // Resize confirmation: after local resize, we expect server to echo cursor.w/cursor.h
  // matching pendingCols/pendingRows. Until confirmed, ignore server dims (stale).
  let pendingCols = 0, pendingRows = 0, pendingResizeTs = 0;



  // Write content + position cursor in xterm.js. The color adapter tracks
  // effective SGR foreground/background pairs across the complete snapshot.
  let lastColorInput = '';
  let lastColorTheme = '';
  let lastColorOutput = '';
  function adaptColors(text) {
    const terminalTheme = getTermTheme();
    const themeKey = `${terminalTheme.foreground}/${terminalTheme.background}`;
    if (text === lastColorInput && themeKey === lastColorTheme) return lastColorOutput;
    lastColorInput = text;
    lastColorTheme = themeKey;
    lastColorOutput = adaptAnsiColors(text, terminalTheme);
    return lastColorOutput;
  }

  // Coalesce high-frequency snapshots into one render per animation frame.
  // When token streams arrive at 30–60 Hz, multiple snapshots collapse into
  // a single xterm write — saves CPU, eliminates the "two writes painting at
  // once" jitter, and bounded latency is the rAF interval (~16 ms, well
  // below human flicker threshold).
  // The pending frame holds only the LATEST content/cursor (older snapshots
  // are intentionally dropped — they are replaced wholesale, not appended).
  let _pendingContent = null;
  let _pendingCursor = null;
  let _pendingRaf = 0;

  function _flushPending() {
    _pendingRaf = 0;
    const c = _pendingContent;
    const cur = _pendingCursor;
    _pendingContent = null;
    _pendingCursor = null;
    if (c == null) return;
    _writeToXtermNow(c, cur);
  }

  function writeToXterm(content, cursor) {
    _pendingContent = content;
    _pendingCursor = cursor;
    if (_pendingRaf) return;
    _pendingRaf = requestAnimationFrame(_flushPending);
  }

  function _writeToXtermNow(content, cursor) {
    if (!term || touchScrolling) return;
    // Reconcile terminal dimensions with server-reported ones.
    // If we have a pending local resize, only clear it when server echoes matching dims;
    // otherwise ignore stale dims. If no pending (or expired), trust server.
    if (cursor?.w && cursor?.h) {
      const pendingActive = pendingResizeTs && Date.now() - pendingResizeTs < RESIZE_CONFIRM_TIMEOUT_MS;
      if (pendingActive) {
        if (cursor.w === pendingCols && cursor.h === pendingRows) {
          pendingResizeTs = 0; // confirmed
        }
        // else: stale, ignore
      } else if (term.cols !== cursor.w || term.rows !== cursor.h) {
        term.resize(cursor.w, cursor.h);
        pendingResizeTs = 0;
      }
    }
    const buf = term.buffer.active;
    const atBottom = buf.viewportY >= buf.baseY;
    const prevViewport = buf.viewportY;

    let cursorSeq = '', afterPad = '';
    if (cursor) {
      const layout = computeCursorLayout(content, cursor, term.rows, term.cols);
      afterPad = layout.afterPad;
      if (layout.row > 0 && layout.row <= term.rows) {
        cursorSeq = `\x1b[${layout.row};${cursor.x + 1}H`;
      }
    }

    // Build the body so each line ends with SGR reset + erase-to-EOL. This
    // overwrites the previous frame's cells *in place* — xterm never has a
    // "fully blank" intermediate state, so there is no visible flash.
    // Compare with the old `\x1b[2J` (clear-screen) which emptied every cell
    // before painting, producing a one-frame flicker on every snapshot.
    const adapted = adaptColors(content);
    const lines = adapted.split('\n');
    let body = '';
    for (let i = 0; i < lines.length; i++) {
      body += lines[i] + '\x1b[0m\x1b[K';
      if (i < lines.length - 1) body += '\n';
    }
    // afterPad is a sequence of '\n'; we add \x1b[K after each so any stale
    // cells on those rows are wiped without flashing. After the body,
    // erase-below (\x1b[0J) wipes rows a previous, taller frame painted —
    // content is top-aligned, so everything below it must be blank.
    const padAft = afterPad ? afterPad.replace(/\n/g, '\x1b[0m\x1b[K\n') : '';
    // Synchronized Output (mode 2026): tell xterm to defer rendering until
    // the whole batch is parsed. Effectively wraps the entire frame in a
    // single render commit, avoiding any partial-paint glimpses.
    writeTerminalFrame(term, body + padAft + '\x1b[0m\x1b[0J' + cursorSeq, () => {
      if (!term || touchScrolling) return;
      if (atBottom) {
        term.scrollToBottom();
      } else {
        term.scrollToLine(Math.min(prevViewport, term.buffer.active.baseY));
      }
      // A history-free replacement can finish without any onScroll event.
      // Publish the final position, not a user gesture that requeues a frame.
      termAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      if (termAtBottom) hasNewContent = false;
    });
  }

  // xterm.js setup + subscription
  // THE LIFECYCLE EFFECT: builds xterm for one pane, tears it down for the
  // next. Its only dependency is `target` — read here, before the body — and
  // the body runs under `untrack` so nothing it reads synchronously (the font
  // size and family, the line height, the theme, `active`, any $state it
  // resets) can re-trigger it. Those are live option updates owned by the
  // small effects above; before this guard existed each of them tore the
  // terminal down: dispose, resubscribe, capture_pane, WebGL re-init, and
  // `kbLocked = true` — a system light/dark auto-switch mid-sentence on the
  // phone dropped the keyboard (review, 2026-09-03).
  // The body keeps its original indentation: it is 1300 lines, and the
  // source tests match its functions by their closing brace column.
  $effect(() => {
    target;
    return untrack(() => {
    touchScrolling = false; // reset on pane switch
    pendingCols = 0; pendingRows = 0; pendingResizeTs = 0;
    lockKeyboard(); // pane switch
    selection = null; selectionLayout = null;
    keyQueue.reset(); // queued keys belong to the previous pane
    lastContent = ''; lastCursor = null; // frames belong to the previous pane

    const estCellW = fontSize * CELL_W_RATIO;
    const estCellH = fontSize * CELL_H_RATIO;
    const containerW = termEl?.clientWidth || 300;
    const containerH = termEl?.clientHeight || 400;
    const initCols = Math.max(2, Math.floor(containerW / estCellW));
    const initRows = Math.max(1, Math.floor(containerH / estCellH));
    term = new Terminal({
      cols: initCols,
      rows: initRows,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: false,
      fontSize,
      lineHeight: terminalPrefs.lineHeight,
      // Literal stack, NOT var(--font-mono): this string is consumed by xterm.js
      // for canvas/WebGL glyph measurement, not parsed as CSS, so a CSS custom
      // property would not resolve here. fonts.stack = the same stack the CSS
      // var carries (user's custom family first when set).
      fontFamily: fonts.stack,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      theme: getTermTheme(),
      scrollback: 500,
      convertEol: true,
      allowTransparency: false,
      scrollbar: { showScrollbar: true, width: SCROLLBAR_W },
    });

    term.open(termEl);
    term.loadAddon(new WebLinksAddon((e, url) => {
      e.preventDefault();
      void openExternalUrl(url).catch((error) => {
        console.error('Failed to open terminal link', error);
      });
    }));

    // Box-drawing / block-element glyphs (█ ▀ ▄ ▐▛…) must fill the ENTIRE
    // cell rect or any lineHeight > 1 tears contiguous ASCII art (e.g. the
    // Claude Code logo) into stripes — the DOM renderer draws them as font
    // text, whose ink stays font-sized inside the taller cell. The WebGL
    // addon rasterizes those codepoints to the cell rect instead
    // (customGlyphs, on by default), the same trick kitty/wezterm use.
    // Falls back to the DOM renderer wherever WebGL is unavailable.
    const webglOwner = term;
    (async () => {
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (term !== webglOwner) return; // pane switched while importing
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); }); // DOM renderer takes over
        webglOwner.loadAddon(addon);
      } catch { /* stay on the DOM renderer */ }
    })();

    termEl.style.background = getTermTheme().background;

    // Mobile keyboard control:
    //   We pin inputmode="text" for the whole session and gate IME via the
    //   focus state (kbLocked + onTaFocus). Earlier we toggled
    //   inputmode="none" ↔ "text" around explicit unlocks, but that hit a
    //   nasty Android InputMethodManager quirk: when the textarea was
    //   created with inputmode="none", the very first focus after the
    //   first switch-to-"text" was ignored — the IME's InputConnection had
    //   already cached "this view doesn't want the soft keyboard" and only
    //   reset on a full blur+focus cycle. Users had to tap the toggle 3
    //   times to open the keyboard on a fresh page load.
    //
    //   Defenses against accidental IME we still have:
    //     - tabindex="-1" on every shortcut button (no focus stealing).
    //     - onTaFocus blurs immediately whenever kbLocked=true, so even
    //       if something does focus the textarea we don't get the IME up.
    //
    // The xterm.js helper textarea is recreated when xterm rebuilds its
    // DOM (e.g. fontSize change), so re-pinning inputmode is cheap to
    // repeat from any path that might rebuild it; we currently only set
    // it once and rely on xterm not changing it.
    kbTa = isMobile ? termEl.querySelector('.xterm-helper-textarea') : null;
    if (kbTa) {
      kbTa.setAttribute('inputmode', 'text');
    }

    // Forward keyboard input to tmux — skip when input box is open
    let isPasting = false;
    let isComposing = false;
    let lastInputComposing = false; // per-event composition signal (see input listener)
    let onTextInsert = null;
    {
      // Desktop included: printable keys are routed through the textarea
      // (see attachCustomKeyEventHandler), so paste/composition tracking and
      // the force-clear below apply on every platform.
      const ta = termEl?.querySelector('.xterm-helper-textarea');
      if (ta) {
        // Capture phase: xterm's own paste handler is registered on this
        // textarea BEFORE ours and emits onData SYNCHRONOUSLY from inside
        // it — a same-phase listener would set the flag after onData
        // already ran and the paste would be misrouted as keystrokes.
        ta.addEventListener('paste', () => {
          isPasting = true;
          // Safety reset: if onData never fires (xterm swallowed it, or paste
          // produced no data), the flag would persist and misclassify the
          // next keystroke as paste.
          setTimeout(() => { isPasting = false; }, 200);
        }, { capture: true });
        ta.addEventListener('compositionstart', () => { isComposing = true; });
        // Also reset lastInputComposing: Chromium's commit order is
        // input(insertCompositionText) → compositionend with no trailing input
        // event, so the flag would stay true and permanently suppress the
        // auto-pair clear for IMEs that DO fire composition events (GBoard).
        ta.addEventListener('compositionend', () => { isComposing = false; lastInputComposing = false; });
        ta.addEventListener('input', (e) => {
          // Some Android IMEs (suggestion-bar keyboards common on pads, e.g.
          // Samsung Keyboard) drive the field with insertCompositionText
          // input events WITHOUT ever firing compositionstart, so the
          // isComposing flag above stays false for them. Track composition
          // per-event as a second signal: while the IME is mid-word we must
          // not force-clear the textarea below, or the IME's InputConnection
          // desyncs from the real field content and later edits garble.
          // Tracked per-event (not sticky) so IMEs that also never fire
          // compositionend still get the auto-pair clear once they commit
          // via a plain insertText.
          lastInputComposing = !!(e.isComposing || (e.inputType || '').startsWith('insertComposition'));
        });
        // Forward plain text insertions ourselves: printable keydowns are
        // handed back to the browser (see attachCustomKeyEventHandler) so
        // CJK IMEs can convert punctuation. xterm v6 handles insertText
        // only SOMETIMES (`!e.composed || !_keyDownSeen` — i.e. exactly the
        // no-keydown IME commits WKWebView produces for CJK punctuation),
        // so leaving both handlers live sent those characters TWICE. This
        // listener sits on termEl in the CAPTURE phase — parent capture
        // runs before the textarea target listeners — and claims the event
        // with stopImmediatePropagation so xterm never sees it: exactly ONE
        // forwarder for every non-composition insertText, on every engine.
        // e.data carries the IME-converted text (， 。). Composition input
        // stays with xterm's CompositionHelper (→ onData): skip while
        // EITHER composition signal is set (Chromium commits as
        // insertCompositionText, WebKit as insertFromComposition — both
        // filtered by inputType — but an IME that commits via plain
        // insertText before compositionend must not be sent twice).
        // Paste stays with xterm's paste handler (insertFromPaste).
        // Named + registered with capture on termEl (which survives pane
        // switches): removed in the effect cleanup below, like
        // onHardwareKeydown, so re-runs don't stack forwarders.
        onTextInsert = (e) => {
          if (e.target !== ta) return;
          const composing = !!(e.isComposing || (e.inputType || '').startsWith('insertComposition'));
          if (e.inputType === 'insertText' && e.data && !composing && !isComposing) {
            e.stopImmediatePropagation();
            lastInputComposing = false;
            ta.value = '';
            enqueueKeys(ctrlOneShot.apply(e.data), true);
          }
        };
        termEl.addEventListener('input', onTextInsert, { capture: true });
      }
    }
    const responseFilter = createTerminalResponseFilter();
    term.onData(data => {
      data = responseFilter.push(data, isPasting);
      if (!data) return;
      // Force-clear xterm's hidden textarea after keyboard input to prevent
      // accumulation from auto-paired quotes/brackets. Applies to desktop
      // too: printable keys are routed through the textarea input pipeline
      // (see attachCustomKeyEventHandler) so the same accumulation applies.
      // Skip paste so xterm.js can fully process the pasted content. Also
      // skip while an IME composition is in progress — clearing
      // textarea.value mid-composition breaks CJK/Japanese input (e.g.
      // drops pinyin the user is currently typing).
      if (!isPasting && !isComposing) {
        requestAnimationFrame(() => {
          // Re-check both signals here: onData fires synchronously inside the
          // textarea's input dispatch BEFORE our own input listener updates
          // lastInputComposing, so only this post-dispatch check sees the
          // current event's composition state.
          if (isComposing || lastInputComposing) return;
          const ta = termEl?.querySelector('.xterm-helper-textarea');
          if (ta && ta.value) ta.value = '';
        });
      }
      if (isPasting) {
        isPasting = false;
        // Paste is input too: same live-tail reset as a keystroke.
        resumeLiveTail();
        // Paste is NOT keystrokes: sent as keys, every line separator acts
        // as an Enter press and each pasted line executes. Route it through
        // tmux's paste buffer instead — `paste-buffer -p` wraps the block
        // in bracketed-paste markers exactly when the pane app enabled
        // mode ?2004 (shells, agent TUIs), matching what a real terminal
        // emits; legacy apps still get the raw text. xterm has already
        // normalized paste line endings to \r, same as a real terminal.
        // Pre-paste_text server (-32601 method-not-found): fall back to the
        // old keystroke path rather than dropping the paste — into the pane
        // that was pasted into, captured at the call (board #190: the answer
        // arrives after a round trip; the live target may have moved on).
        void pasteOrFallback(target, data, {
          paste: pasteText,
          enqueue: (pane, keys, literal) => enqueueKeys(keys, literal, pane),
          onSuccess: (pane) => forThisPane(pane, noteSendSuccess),
          onFailure: (kind, pane) => forThisPane(pane, () => noteSendFailure(kind)),
        });
        return;
      }
      // Paste returned above, so a pasted single letter never consumes Ctrl.
      enqueueKeys(ctrlOneShot.apply(data), true);
    });
    // Plain printable keys must go through the browser's input pipeline
    // (textarea `input` event), NOT xterm's keydown fast path. CJK IMEs
    // convert punctuation (， 。 、) at the input stage WITHOUT composition
    // events; xterm's keydown handler sees the raw ASCII key (`,` `.`),
    // emits it and calls preventDefault — the IME conversion is silently
    // dropped and the user gets English punctuation. Returning false hands
    // the key back to the browser; the inserted (possibly IME-converted)
    // text then reaches onData via the input event, same as mobile typing.
    // Modified combos and named keys (Enter, arrows, F-keys: key.length > 1)
    // keep xterm's keydown path; Ctrl/Alt combos are claimed even earlier by
    // the capture-phase hardware handler below.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' && event.type !== 'keypress') return true;
      if (event.ctrlKey || event.altKey || event.metaKey) return true;
      return (event.key?.length ?? 0) !== 1;
    });

    // Forward every unclaimed hardware Ctrl / Option combination straight to
    // tmux. Browser/WKWebView textareas otherwise consume editing bindings
    // such as Ctrl+X / Ctrl+F and Option dead keys before xterm emits onData.
    // Touch capability is not a reliable hardware-keyboard test: desktop
    // Chromium and WKWebView may expose touch APIs, and phones can have a
    // physical keyboard. App shortcuts run first in window capture.
    const onHardwareKeydown = (event) => {
      // Bare Escape is claimed HERE, same as the Ctrl/Alt combos, and encoded
      // by hand — the send never depends on whose keydown runs first or on
      // where focus lands afterwards. IME composition keeps its Escape
      // (cancelling the composition is what the user meant).
      //
      // History (board #20, three rounds 2026-08-26 … 09-03): "Esc 让当前框失去
      // 焦点" on the desktop was chased as a WebKit default action, then as a
      // native first-responder loss — and finally traced by the owner to a
      // BROWSER EXTENSION on their machine (the classic: a keyboard-navigation
      // extension blurs the focused input on Esc, before the page sees the
      // key). Nothing in this file can or should defend against that; the
      // blur guards were removed (owner: "避免我们过度修复了"). If Esc drops
      // focus again, check the browser's extensions before this code.
      const bareEsc = !event.isComposing && event.key === 'Escape'
        && !event.ctrlKey && !event.altKey && !event.metaKey;
      const data = bareEsc ? '\x1b' : encodeTerminalShortcut(event);
      if (!data) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      enqueueKeys(data, true);
    };
    termEl.addEventListener('keydown', onHardwareKeydown, { capture: true });

    let focusTerm = null;
    if (!isMobile) {
      // Desktop has no on-screen keyboard / toggle, so focus the xterm sink
      // on click so ordinary typing (and our handler) works. Auto-focus on
      // mount ONLY for the active terminal — otherwise multiple split cells
      // race for the single document focus and input lands nowhere.
      focusTerm = () => { try { term.focus(); } catch {} };
      termEl.addEventListener('mousedown', focusTerm);
      if (active) requestAnimationFrame(focusTerm);
    }

    // Uses outer endTouchScrollTimer so unlockKeyboard() and effect cleanup can clear it.
    function endTouchScroll() {
      endTouchScrollTimer = null;
      // Selection holds the pin; releasing it would clear+rewrite and wipe
      // xterm's native selection visuals. Stay pinned until the selection is
      // cleared (toolbar copy, tap outside, pane switch).
      if (selection) return;
      touchScrolling = false;
      if (lastContent && termAtBottom) writeToXterm(lastContent, lastCursor);
    }
    function scheduleEndTouchScroll(ms) {
      clearTimeout(endTouchScrollTimer);
      endTouchScrollTimer = setTimeout(endTouchScroll, ms);
    }

    // Helper: convert touch coordinates to terminal cell (col, row in viewport)
    function touchToCell(clientX, clientY) {
      const rect = termEl.getBoundingClientRect();
      const cell = cellSize(term);
      return pointToCell(clientX, clientY, rect, cell, term.cols, term.rows);
    }

    // Helper: find word boundaries at buffer row + col
    function wordBoundsAt(bufRow, col) {
      const line = term.buffer.active.getLine(bufRow);
      return wordBounds(line?.translateToString(false), col);
    }

    // These adapters close over live Root state; construction reads nothing.
    const gestureHost = {
      available: () => !!term,
      hasSelection: () => !!selection,
      isPinned: () => touchScrolling,
      pinUpdates: () => { touchScrolling = true; },
      requestRenderRelease: scheduleEndTouchScroll,
      hitHandle,
      grabHandle(which, cx, cy) {
        beginEndpointDrag(which);
        const r = termEl.getBoundingClientRect();
        const cell = cellSize(term);
        const ep = selection.head;
        return handleGrabOffset(cx, cy, ep, term.buffer.active.viewportY, r, cell);
      },
      dragHeadAt: applyHandleDragAt,
      extendHeadAt(clientX, clientY) {
        const { row, col } = touchToBufferCell(clientX, clientY);
        moveHead(row, col);
      },
      tryWordSelection(startCX, startCY) {
        const textarea = termEl.querySelector('.xterm-helper-textarea');
        if (textarea) textarea.blur();
        const cell = touchToCell(startCX, startCY);
        const bufRow = term.buffer.active.viewportY + cell.row;
        if (selection && isInsideSelection(bufRow, cell.col)) return false;
        if (selection) clearSelection();
        setSelectionFromWord(bufRow, cell.col);
        return true;
      },
      clearSelectionOutside(clientX, clientY) {
        const { row, col } = touchToBufferCell(clientX, clientY);
        if (!isInsideSelection(row, col)) clearSelection();
      },
      isScrollbarPoint(cx) {
        const rect = termEl.getBoundingClientRect();
        return (rect.right - cx) < SCROLLBAR_TOUCH_WIDTH;
      },
      scrollPosition: () => term.buffer.active.viewportY,
      dragScrollbar(scrollbarStartY, scrollbarStartViewport, clientY) {
        const deltaY = clientY - scrollbarStartY;
        const trackH = termEl.clientHeight;
        const totalScroll = term.buffer.active.baseY;
        if (totalScroll > 0 && trackH > 0) {
          const scrollTarget = scrollbarStartViewport + (deltaY / trackH) * totalScroll;
          term.scrollToLine(Math.max(0, Math.min(totalScroll, Math.round(scrollTarget))));
        }
      },
      lineHeight: () => cellSize(term).h || (fontSize * CELL_H_RATIO),
      edgeBounds() {
        const rect = termEl.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      },
      scrollLines: (lines) => term.scrollLines(lines),
      openFromDoubleTap() {
        unlockKeyboard(); // double-tap
      },
    };

    const gestures = createTerminalGestures(gestureHost, {
      now: () => Date.now(),
      setDelay: (callback, ms) => window.setTimeout(callback, ms),
      clearDelay: (id) => window.clearTimeout(id),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      vibrate: (ms) => { navigator.vibrate?.(ms); },
    });

    // Local input means "show me the live tail".
    //
    // Four states suppress rendering: a pinned selection, an unsettled touch
    // scroll (`touchScrolling`), a live momentum coast, and a viewport parked
    // in scrollback (`termAtBottom === false`, frames deferred as
    // `hasNewContent`). None of them used to end on input, and the server
    // never re-sends a frame it already delivered — so `lastContent` kept
    // advancing while the screen stayed frozen, and the characters the user
    // typed only surfaced when some unrelated event (resize, visibility
    // change, pane switch) happened to repaint. Real terminals snap to the
    // tail and drop the selection on input; do the same, on every send path.
    function resumeLiveTail() {
      if (!term) return;
      if (!selection && !touchScrolling && termAtBottom && !gestures.isCoasting()) return;
      if (selection) clearSelection();
      // A live coast would scroll the viewport straight back off the tail
      // (measured: typing mid-coast re-armed the deferral one frame later).
      gestures.stopMomentum();
      if (touchScrolling) {
        clearTimeout(endTouchScrollTimer);
        endTouchScrollTimer = null;
        touchScrolling = false;
      }
      if (!termAtBottom) {
        termAtBottom = true;
        hasNewContent = false;
        term.scrollToBottom();
      }
      if (lastContent) writeToXterm(lastContent, lastCursor);
    }
    resumeLiveTailRef = resumeLiveTail;

    // Recompute pixel positions for handles + toolbar from current selection
    // and viewport. Called whenever selection, scroll, resize, or render
    // geometry changes.
    function recomputeSelUI() {
      if (!selection || !term || !termEl) { selectionLayout = null; return; }
      const { w: cellW, h: cellH } = cellSize(term);
      if (!cellW || !cellH) { selectionLayout = null; return; }
      const buf = term.buffer.active;
      const top = buf.viewportY;
      const rows = term.rows;
      const cols = term.cols;
      const rect = termEl.getBoundingClientRect();
      selectionLayout = {
        cell: { w: cellW, h: cellH },
        viewport: { top, rows, cols, width: rect.width, height: termEl.parentElement.clientHeight },
      };
    }

    // Drive xterm.js native selection from our selection model. xterm.select
    // takes (col, row, length) where length is across rows and assumes fixed
    // cols; we compute it inclusive-of-end.
    function applySelectionToXterm() {
      if (!term) return;
      isApplyingSelection = true;
      try {
        if (!selection) { term.clearSelection(); return; }
        const a = selStart(selection);
        const len = selLength(selection, term.cols);
        term.select(a.col, a.row, len);
      } finally {
        isApplyingSelection = false;
      }
    }

    clearSelection = () => {
      if (!selection) return;
      selection = null;
      selectionLayout = null;
      isApplyingSelection = true;
      try { term?.clearSelection(); } finally { isApplyingSelection = false; }
      // Resume content updates (selection had pinned them).
      if (gestures.isIdle()) {
        touchScrolling = false;
        if (lastContent && termAtBottom) writeToXterm(lastContent, lastCursor);
      }
    };

    copySelection = async () => {
      const copiedTerm = term;
      const copiedSelection = selection;
      const copiedTarget = target;
      const copiedSession = session;
      if (!copiedTerm?.hasSelection() || !visible || document.visibilityState !== 'visible') return;
      const text = copiedTerm.getSelection();
      if (!text) return;
      const token = copyFeedbackLifetime.begin();
      const ok = await copyText(text);
      if (!copyFeedbackLifetime.current(token) || term !== copiedTerm || selection !== copiedSelection
        || target !== copiedTarget || session !== copiedSession || !visible || document.visibilityState !== 'visible') return;
      copyFeedbackLifetime.update(token, {
        kind: ok ? 'success' : 'error', message: ok ? t('copied') : t('copyFailed'),
      });
      if (ok) clearSelection();
    };

    // ─── Selection extension helpers ────────────────────────────────────────
    function setSelectionFromWord(bufRow, col) {
      const bounds = wordBoundsAt(bufRow, col);
      const a = { row: bufRow, col: bounds.start };
      const b = { row: bufRow, col: bounds.end - 1 };
      selection = { anchor: a, head: b };
      applySelectionToXterm();
      recomputeSelUI();
      touchScrolling = true; // pin content updates while selection is live
    }
    function moveHead(bufRow, col) {
      if (!selection) return;
      selection = { anchor: selection.anchor, head: { row: bufRow, col } };
      applySelectionToXterm();
      recomputeSelUI();
    }
    // Called once at grab time: rewrite the selection so the endpoint being
    // dragged becomes `head` and the stationary one becomes `anchor`. From
    // then on every touchmove just rewrites `head` — the anchor can never
    // move, so dragging one handle past the other flips the selection's
    // direction (native behavior) instead of perturbing the far end.
    //
    // The old code addressed endpoints by geometric role ('start'/'end')
    // per-move: after a crossover the roles swap, but dragHandle still said
    // 'end', so the NEXT move rewrote the wrong endpoint and both ends
    // visibly jumped.
    function beginEndpointDrag(which) {
      if (!selection) return;
      selection = selForDrag(selection, which);
    }

    // Cell from clientX/clientY in buffer-row coords (row is absolute, not viewport-relative)
    function touchToBufferCell(clientX, clientY) {
      const cell = touchToCell(clientX, clientY);
      return { row: term.buffer.active.viewportY + cell.row, col: cell.col };
    }

    // Map a (compensated) drag point to a buffer cell with edge snapping,
    // and move `head` there. Snap zones make line starts/ends reachable:
    // the first/last ~60% of a cell at each horizontal edge snaps to col 0
    // / last col — matching OS text selection, where dragging past the text
    // edge selects to the line boundary even though the finger can't
    // physically center on the first/last character.
    function applyHandleDragAt(px, py) {
      const rect = termEl.getBoundingClientRect();
      const { w: cellW } = cellSize(term);
      const x = px - rect.left;
      const cell = touchToCell(px, py);
      const col = snapHandleColumn(x, cell.col, rect.width, cellW, term.cols, SCROLLBAR_TOUCH_WIDTH);
      const row = term.buffer.active.viewportY + cell.row;
      moveHead(row, col);
    }

    // Hit-test handles. Each handle is a lollipop (dot + stem); the visible
    // dot is 12 px but the *touchable* zone is much larger so the user
    // doesn't have to aim. Capsule axis runs along the stem, with generous
    // buffer in both directions.
    //
    // Sizing rationale: a thumb-pad on a phone is ~44 px wide at the tip
    // and lays down a roughly oval contact patch. We use 28 px half-width
    // (= 56 px wide hit zone) and extend ±22 px past the dot end of the
    // capsule, which means anywhere in a ~56 × (cellH + 44) rectangle hits.
    //
    // Conflicts handled below:
    //   - Short single-row selection (start/end in same row, close
    //     together): the two capsules overlap. We split the overlap at the
    //     midpoint between start.X and end.X so each handle owns its half.
    //   - col 0:    extend start capsule LEFT to the container edge so a
    //               miss to the left of the dot still hits.
    //   - col cols-1: extend end capsule RIGHT to the container edge,
    //               which also swallows the scrollbar's 30 px touch zone
    //               for that range. handle is tested before scrollbar in
    //               onTouchStart so the priority is right.
    function hitHandle(clientX, clientY) {
      if (!selection || !selUI || !termEl) return null;
      const rect = termEl.getBoundingClientRect();
      return hitSelectionHandle(clientX, clientY, rect, selection, selUI);
    }

    // Hit-test whether a buffer-row/col is inside the current selection
    function isInsideSelection(bufRow, col) {
      return selContains(selection, bufRow, col);
    }

    const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = gestures;
    termEl.addEventListener('touchstart', onTouchStart, { passive: true });
    termEl.addEventListener('touchmove', onTouchMove, { passive: false });
    // touchend is non-passive: the double-tap branch calls preventDefault()
    // to suppress the synthetic dblclick (see onTouchEnd). It never blocks
    // scrolling — that is touchmove's job.
    termEl.addEventListener('touchend', onTouchEnd, { passive: false });
    termEl.addEventListener('touchcancel', onTouchCancel, { passive: true });

    // Adopt selections that originate outside our touch flow — double-tap,
    // triple-tap (xterm.js handles those internally), keyboard Cmd+A on
    // desktop, mouse drag. Skip the events we triggered ourselves
    // (applySelectionToXterm sets isApplyingSelection=true).
    const onSelChange = term.onSelectionChange(() => {
      if (isApplyingSelection) return;
      if (!term.hasSelection()) {
        // Native cleared (e.g., user clicked outside on desktop). Drop our
        // model too. clearSelection() guards against re-clearing xterm.
        if (selection) {
          selection = null;
          selectionLayout = null;
          if (gestures.isIdle()) {
            touchScrolling = false;
            if (lastContent && termAtBottom) writeToXterm(lastContent, lastCursor);
          }
        }
        return;
      }
      const pos = term.getSelectionPosition();
      if (!pos) return;
      selection = selFromExclusive(pos);
      recomputeSelUI();
      touchScrolling = true; // pin while selection is live
    });
    // Safety net: if the app is backgrounded mid-selection or mid-scroll, touchcancel
    // may never fire and touchScrolling can stay stuck true, which freezes
    // writeToXterm. A suspended WebView can also keep its WebSocket OPEN while
    // pane pushes stop, so visibility recovery must pull a fresh snapshot rather
    // than merely repainting the pre-suspend cache.
    let followedTailBeforeHide = true;
    let resumeGeneration = 0;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') {
        clearTerminalFeedback();
        followedTailBeforeHide = termAtBottom;
        resumeGeneration++;
        return;
      }
      const generation = ++resumeGeneration;
      const resumeAtTail = followedTailBeforeHide;
      touchScrolling = false;
      gestures.resetAfterVisibility();
      // Drop the selection — re-attaching to a clipboard from before
      // backgrounding is rarely useful and could surprise the user.
      if (selection) clearSelection();
      if (resumeAtTail) {
        // Layout/keyboard changes while suspended can make xterm emit a stale
        // scroll position on resume. Preserve the user's intent (live tail)
        // rather than interpreting that geometry change as manual scrollback.
        termAtBottom = true;
        hasNewContent = false;
        term?.scrollToBottom();
      }
      doResizeRef?.();
      if (lastContent && resumeAtTail) writeToXterm(lastContent, lastCursor);
      term?.refresh(0, term.rows - 1);

      // App.svelte re-sends the wire subscription on the same visibility event.
      // This explicit snapshot closes the gap even if that OPEN socket is only
      // half-alive: a successful send_keys/capture response proves the RPC path
      // and immediately converges the display to tmux's actual contents.
      capturePane(target).then(r => {
        if (generation !== resumeGeneration || !term) return;
        const content = r.output ?? r.content;
        if (content == null) return;
        const changed = content !== lastContent;
        lastContent = content;
        if (resumeAtTail) {
          writeToXterm(content, lastCursor);
          requestAnimationFrame(() => term?.scrollToBottom());
        } else if (changed) {
          hasNewContent = true;
        }
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);

    // Mobile keyboard: opened only by a DOUBLE-tap on the terminal
    // (onTouchEnd); the bar's slot is Enter while it is down (#296). A single tap does NOT open it —
    // users found stray taps while reading scrollback (or near the selection
    // handles) surprising.
    // Single layer: kbLocked flag, enforced by onTaFocus (it blurs whenever
    // a focus lands while locked). inputmode is pinned to "text" — see init
    // for the InputMethodManager bug that motivated removing the toggle.
    let onTaBlur, onTaFocus;

    if (kbTa) {
      onTaBlur = () => {
        clearTimeout(kbBlurTimer);
        // Focus left the terminal: whatever is typed next goes elsewhere, so
        // the armed Ctrl must not wait for it. (The bar's own buttons
        // preventDefault their touchstart and never blur the textarea.)
        ctrlOneShot.disarm(); // blur
        kbBlurTimer = setTimeout(() => {
          if (Date.now() < unlockUntil && unlockRetries < UNLOCK_RETRY_MAX) {
            unlockRetries++;
            // Retry focus within grace window — the blur was likely system-initiated
            // (e.g., Android pad where IME didn't come up yet).
            if (kbTa && !kbLocked && document.activeElement !== kbTa) kbTa.focus();
            return;
          }
          lockKeyboard(); // blur timer
        }, 150);
      };
      kbTa.addEventListener('blur', onTaBlur);

      onTaFocus = () => {
        clearTimeout(kbBlurTimer);
        if (kbLocked) {
          kbTa.blur();
          return;
        }
      };
      kbTa.addEventListener('focus', onTaFocus);
    }

    term.onScroll(() => {
      const buf = term.buffer.active;
      const wasAtBottom = termAtBottom;
      termAtBottom = buf.viewportY >= buf.baseY;
      // Returning to bottom → flush the latest snapshot we deferred while scrolled up
      if (!wasAtBottom && termAtBottom && lastContent && !touchScrolling) {
        writeToXterm(lastContent, lastCursor);
      }
      if (termAtBottom) hasNewContent = false;
      // Selection lives in buffer-row space; viewport scroll moves the
      // pixel-space handles. Recompute on every scroll tick.
      if (selection) recomputeSelUI();
    });

    // Resize tmux pane to fit screen.
    //
    // First principle: the terminal's (cols, rows) must always equal
    //   floor(termEl.clientWidth / cellW) × floor(termEl.clientHeight / cellH).
    // Everything else — keyboard open/close, orientation change, window
    // resize, flex reflow, safe-area shifts — is just a cause of container
    // size change. The only thing we actually need to observe is
    // termEl's box. ResizeObserver does exactly that, including cases the
    // old code relied on intermediate custom events for.
    //
    // Secondary detail: xterm computes real cell dimensions asynchronously
    // (after first render). Until then calcFit falls back to a font-size
    // estimate that can be off by 1-2 rows, which is why initial paint
    // sometimes left the bottom rows blank. We run one more fit on
    // term.onRender's first fire so the first real fit uses real metrics.
    let resizeSendTimer = 0;
    function queuePaneResize(cols, rows) {
      pendingCols = cols;
      pendingRows = rows;
      pendingResizeTs = Date.now();
      clearTimeout(resizeSendTimer);
      resizeSendTimer = setTimeout(() => {
        resizeSendTimer = 0;
        resizePane(target, pendingCols, pendingRows).catch(() => {});
      }, 120);
    }

    // `assert`: send the size even when it equals ours — another instance of
    // this pane (the Hub drawer's / the page's) may have sized tmux to ITS box
    // while we were hidden and our box never changed (board #198).
    function doResize({ assert = false } = {}) {
      syncCompactLineGeometry();
      // Remember the height the terminal has with NO keyboard. While the
      // keyboard is up and we are in overlay mode the element is pinned to this
      // value, so it has to be captured whenever the keyboard is down — it
      // changes with rotation, font size and split view.
      if (!document.documentElement.classList.contains('keyboard-open')) {
        termEl.style.setProperty('--kb-locked-h', `${termEl.clientHeight}px`);
      }
      const fit = calcFit();
      if (!fit) return;
      if (fit.cols === term.cols && fit.rows === term.rows) {
        if (assert) queuePaneResize(fit.cols, fit.rows);
        // Same dims but cell metrics may have changed (font size); refresh
        // selection UI either way.
        if (selection) recomputeSelUI();
        return;
      }
      queuePaneResize(fit.cols, fit.rows);
      term.resize(fit.cols, fit.rows);
      // Resize wipes xterm's buffer-row mapping — re-anchor our selection
      // before the rewrite so the visuals stay consistent.
      if (selection) {
        applySelectionToXterm();
        recomputeSelUI();
      }
      // Immediately rewrite content so display is clean during the ~200ms server catch-up
      if (lastContent) writeToXterm(lastContent, lastCursor);
    }
    doResizeRef = doResize;

    // Single observer for all container-size changes.
    const resizeObs = new ResizeObserver(() => doResize());
    resizeObs.observe(termEl);
    const onAppZoom = () => doResize();
    window.addEventListener('app-zoom-change', onAppZoom);

    // First real paint → real cell metrics available → refit once so the
    // initial ResizeObserver tick (which ran with estimated metrics) gets
    // corrected. term.onRender fires on every render, so we disarm after
    // the first call.
    let firstRenderDone = false;
    const onFirstRender = term.onRender(() => {
      syncCompactLineGeometry();
      if (firstRenderDone) return;
      firstRenderDone = true;
      doResize();
    });

    // Re-measure once webfonts settle.
    //
    // The TEXT font is now a system family (or a locally-installed custom
    // font), so cell-width measurement at open() is already correct — the
    // historical "characters stuck together" class of bugs (async text
    // webfont swapping in after xterm measured the fallback) is gone by
    // construction. Only the two bundled SYMBOL fonts load async; they don't
    // drive cell metrics, but their glyphs land in the atlas, so refresh
    // once after document.fonts.ready to repaint any tofu drawn before the
    // symbol fonts decoded. Kept cheap: atlas clear + repaint, no refit.
    let fontReadyHandled = false;
    const remeasureAfterFonts = () => {
      if (fontReadyHandled || !term) return;
      fontReadyHandled = true;
      try {
        term._core?._renderService?.clearTextureAtlas?.();
      } catch {}
      term.refresh(0, term.rows - 1);
    };
    if (document.fonts?.ready) {
      document.fonts.ready.then(remeasureAfterFonts).catch(() => {});
    }

    // Keyboard state (lock/unlock) is driven by keyboard-shift events.
    // Resize is NOT — ResizeObserver handles any container change caused by
    // the keyboard. We keep this handler purely for the kbLocked lifecycle.
    let lastKbHeight = 0;
    const onKbShift = (e) => {
      if (!termEl || !term) return;
      termEl.style.marginTop = '0'; // remove legacy shift
      const kbH = e.detail?.kbHeight ?? 0;
      // When keyboard closes (was open, now 0), lock + blur to prevent accidental re-open
      // from shortcut buttons. Key scenario: user taps terminal (unlock), keyboard opens,
      // then keyboard dismissed by Android back/system — textarea stays focused but keyboard
      // is gone. Without this, any subsequent touch (shortcut button) causes IME to re-show.
      // Guard: only trigger on the open→close transition. A bare kbH=0 event (e.g., Android
      // pad where IME never actually rose) must NOT re-lock — that would kill the
      // double-tap the user just made.
      if (kbTa && kbH === 0 && lastKbHeight > 0 && Date.now() >= unlockUntil) {
        lockKeyboard(); // keyboard-shift: open → close transition
        if (document.activeElement === kbTa) kbTa.blur();
      }
      lastKbHeight = kbH;
      // Keep the cursor area visible when the keyboard just appeared.
      // The actual resize has already been (or will be) picked up by
      // ResizeObserver; we just nudge scroll on the next frame so the
      // scroll is applied to the post-resize geometry.
      if (kbH > 0 && termAtBottom && term) {
        requestAnimationFrame(() => term?.scrollToBottom());
      }
    };
    window.addEventListener('keyboard-shift', onKbShift);

    // Reconnect recovery: the previous server's resize_tracker cleanup auto-fits the pane
    // back to an arbitrary size on disconnect. Clear stale pending confirmation and
    // re-send resize so the new server's tmux pane matches our terminal again.
    // Only for THIS Terminal's server (board #335 ②b-4).
    const onReconnected = (e) => {
      if (e?.detail?.serverId !== runtime.id) return;
      pendingCols = 0; pendingRows = 0; pendingResizeTs = 0;
      // Force doResize to actually send by invalidating the cur===fit check.
      // We do this by momentarily pretending term has different dims.
      if (term) {
        const fit = calcFit();
        if (fit) {
          queuePaneResize(fit.cols, fit.rows);
          // term.resize is a no-op if dims already match, which is fine.
          term.resize(fit.cols, fit.rows);
          if (lastContent) writeToXterm(lastContent, lastCursor);
        }
      }
      // Pull a fresh snapshot immediately rather than waiting up to 200 ms
      // for the server's subscribe loop to push the first frame. Otherwise
      // the user sees stale content right after the reconnect dialog
      // disappears, which feels broken on flaky networks.
      capturePane(target).then(r => {
        const c = r.output || r.content;
        if (c && c !== lastContent) {
          lastContent = c;
          if (termAtBottom) writeToXterm(c, lastCursor);
          else hasNewContent = true;
        }
      }).catch(() => {});
    };
    window.addEventListener('ws-reconnected', onReconnected);

    // Named refs so cleanup removes EXACTLY this cell's listener — two cells
    // on the same target each register their own; removing by reference
    // leaves the other's intact.
    const onPaneOutputCb = (t, content, cursor, currentCommand, agent) => {
      if (t !== target) return;
      if (cursor) lastCursor = cursor;
      // Pane's running command + agent, only present on first push and on
      // changes. Drives the keyboard overlay (keepRowsOnKeyboard).
      if (currentCommand !== undefined) {
        liveAgent = agent ?? null;
      }
      // A HIDDEN terminal only records the frame. The page-layers keep every
      // page mounted (`visibility: hidden`) so state survives tab switches —
      // which meant every busy pane kept running the full pipeline (ANSI
      // color adaptation over the whole snapshot + a full-screen xterm write
      // + a WebGL draw) at the server's 5 fps cadence, invisibly, per pane
      // (× cells in split mode). That is CPU-as-heat for nothing: the owner
      // reported the fans (2026-08-22, "发热挺厉害"). The repaint-on-show
      // effect below replays the newest frame, which is all a returning
      // reader can see anyway.
      if (!visible) {
        if (content != null) lastContent = content;
        return;
      }
      if (content != null && content !== lastContent) {
        lastContent = content;
        // Defer rendering while user is reading scrollback; flush on scroll-to-bottom
        if (termAtBottom) writeToXterm(content, lastCursor);
        else hasNewContent = true;
      } else if (cursor && term && lastContent && termAtBottom) {
        // Cursor-only update — share the wrap-aware layout math with
        // writeToXterm so the row matches the frame already on screen.
        const { row } = computeCursorLayout(lastContent, cursor, term.rows, term.cols);
        if (row > 0 && row <= term.rows) {
          term.write(`\x1b[${row};${cursor.x + 1}H`);
        }
      }
    };
    const onPaneClosedCb = (t) => { if (t === target) onPaneExit(target); };
    addPaneOutputListener(target, onPaneOutputCb);
    addPaneClosedListener(target, onPaneClosedCb);

    // The instance is complete: let the live-option / focus / refresh effects
    // see it. (Written, never read, inside this effect — no self-dependency.)
    termGen++;

    subscribe(target);
    capturePane(target).then(r => {
      if (lastContent) return; // subscription already delivered content
      const c = r.output || r.content;
      if (c) {
        lastContent = c;
        writeToXterm(c, lastCursor);
      }
    }).catch(() => {});

    return () => {
      responseFilter.reset();
      clearTerminalFeedback();
      resizeObs.disconnect();
      clearTimeout(resizeSendTimer);
      window.removeEventListener('app-zoom-change', onAppZoom);
      try { onFirstRender.dispose(); } catch {}
      try { onSelChange.dispose(); } catch {}
      doResizeRef = null;
      resumeLiveTailRef = null;
      termEl?.classList.remove('compact-lines');
      termEl?.style.removeProperty('--xterm-char-height');
      termEl?.style.removeProperty('--xterm-line-offset');
      clearTimeout(endTouchScrollTimer);
      gestures.cancelHold();
      clearTimeout(kbBlurTimer);
      if (kbTa && onTaBlur) kbTa.removeEventListener('blur', onTaBlur);
      if (kbTa && onTaFocus) kbTa.removeEventListener('focus', onTaFocus);
      gestures.dispose();
      if (_pendingRaf) { cancelAnimationFrame(_pendingRaf); _pendingRaf = 0; }
      _pendingContent = null;
      _pendingCursor = null;
      window.removeEventListener('ws-reconnected', onReconnected);
      window.removeEventListener('keyboard-shift', onKbShift);
      document.removeEventListener('visibilitychange', onVisible);
      termEl.removeEventListener('touchstart', onTouchStart);
      termEl.removeEventListener('touchmove', onTouchMove);
      termEl.removeEventListener('touchend', onTouchEnd);
      termEl.removeEventListener('touchcancel', onTouchCancel);
      termEl.removeEventListener('keydown', onHardwareKeydown, { capture: true });
      if (onTextInsert) termEl.removeEventListener('input', onTextInsert, { capture: true });
      if (focusTerm) termEl.removeEventListener('mousedown', focusTerm);
      // Server's resize_tracker auto-restores this window via `resize-window -A` on WS disconnect
      unsubscribe(target);
      removePaneOutputListener(target, onPaneOutputCb);
      removePaneClosedListener(target, onPaneClosedCb);
      try { term.dispose(); } catch {}
      term = null;
      copySelection = () => {};
      clearSelection = () => {};
    };
    }); // untrack
  });

  // One full repaint after each build, once the first layout has happened.
  $effect(() => {
    termGen;
    if (term) {
      requestAnimationFrame(() => term?.refresh(0, term.rows - 1));
    }
  });

  // Track consecutive send failures so the user gets a visible connection error
  // well before the heartbeat detector fires its 10-15s disconnect. One stray
  // failure is ignored (could be a single dropped packet). Two in a row on any
  // channel (shortcut, Enter, or raw key-through) surfaces a persistent error.
  let sendFailCount = 0;
  function noteSendFailure(label) {
    sendFailCount++;
    if (sendFailCount === 2 && visible && document.visibilityState === 'visible') {
      connectionFeedbackLifetime.update(connectionFeedbackLifetime.begin(), {
        kind: 'error', message: t('connectionUnstable'),
      });
    }
  }
  function noteSendSuccess() {
    if (sendFailCount > 0) sendFailCount = 0;
    connectionFeedbackLifetime.clear();
  }

  // ─── Keystroke send queue ────────────────────────────────────────────────
  // One RPC per keystroke melts down on slow links: fast typing or the 80 ms
  // long-press repeat stacks dozens of in-flight send_keys, each competing
  // with pane snapshots for the link. Instead, only one send_keys is in
  // flight at a time; keys pressed meanwhile queue up, and consecutive
  // LITERAL chars merge into a single string (tmux send-keys -l applies it
  // as one write). Special keys can't merge (each is a distinct key name)
  // but still serialize through the queue so ordering with typed chars is
  // preserved.
  // The queue itself (merge, cap, one in flight, drop-on-failure) is the
  // tested module terminal-input.ts; every item carries the pane it was typed
  // into (board #190), so a send that lands after a pane switch still goes
  // where the user typed.
  // Feedback is scoped to the pane on screen: an outcome that arrives for a
  // pane the user has since left is not this pane's news (board #190).
  const forThisPane = (pane, note) => { if (pane === target) note(); };
  const keyQueue = createKeyQueue({
    send: sendKeys,
    onSuccess: (pane) => forThisPane(pane, noteSendSuccess),
    onFailure: (pane) => forThisPane(pane, () => noteSendFailure('key')),
  });

  function enqueueKeys(keys, literal, pane = target) {
    // Any keystroke returns the display to the live tail (see resumeLiveTail).
    resumeLiveTailRef?.();
    keyQueue.enqueue(pane, keys, literal);
  }

  function sendSpecial(key) {
    enqueueKeys(key, false);
  }

  function toggleCtrl() {
    stopRepeat();
    ctrlOneShot.toggle();
    navigator.vibrate?.(8);
  }

  // Long-press repeat for shortcut keys
  let repeatTimer = null;
  let repeatInterval = null;

  // One press of a shortcut key. Enter stops here (#296); the repeatable
  // keys go through startRepeat, which adds the long-press repeat.
  function pressKey(key) {
    ctrlOneShot.disarm(); // a shortcut key is not "the next letter"
    navigator.vibrate?.(8); // haptic tick on press; silent during repeat interval
    sendSpecial(key);
  }
  function startRepeat(key) {
    pressKey(key);
    repeatTimer = setTimeout(() => {
      repeatInterval = setInterval(() => sendSpecial(key), 80);
    }, 400);
  }
  function stopRepeat() {
    clearTimeout(repeatTimer);
    clearInterval(repeatInterval);
    repeatTimer = null;
    repeatInterval = null;
  }

  // Svelte 5 registers touchstart as passive, so e.preventDefault() is ignored.
  // We need non-passive touchstart to prevent keyboard popup on shortcut buttons.
  function nonPassiveShortcuts(node) {
    let activeBtn = null;
    const onStart = (e) => {
      // preventDefault on ALL buttons (including the close key) to prevent synthetic
      // mousedown from stealing focus away from xterm's textarea after ta.focus().
      const btn = e.target.closest('button');
      if (btn && node.contains(btn)) {
        e.preventDefault();
        btn.classList.add('pressed');
        activeBtn = btn;
      }
    };
    const onEnd = () => {
      if (activeBtn) { activeBtn.classList.remove('pressed'); activeBtn = null; }
    };
    node.addEventListener('touchstart', onStart, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });
    node.addEventListener('touchcancel', onEnd, { passive: true });
    return { destroy() {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onEnd);
    }};
  }


</script>

<div class="terminal">
  {#if copyFeedback || connectionFeedback}
    <div class="terminal-feedback appear">
      <OperationFeedback value={connectionFeedback} ondismiss={connectionFeedbackLifetime.clear} />
      <OperationFeedback value={copyFeedback} ondismiss={copyFeedback?.kind === 'error' ? copyFeedbackLifetime.clear : undefined} />
    </div>
  {/if}
  {#if showSwitcher}
    {#if showWindowCmd || embedded}
      <!--
        Expanded switcher: a top-of-page horizontal tab bar for the current
        session's windows. The session chip opens the all-session picker.
      -->
      <div class="win-bar page-head">
        <!-- Who this bar belongs to, in one of three forms — because the bar
             plays three roles and only one of them is a page header:
             · a split CELL has no sidebar of its own, so its badge stays a
               chip and opens the cross-session pane picker (what the cell
               header always promised);
             · on a PHONE the chip opens the session sheet, which is that
               layout's sidebar;
             · on the DESKTOP the sidebar is already on screen, so a chip
               would be a second door to the same room (owner, 2026-08-19)
               and what belongs here instead is the page TITLE — the same h1
               dialect Chat / Agents / Settings carry. The win-bar IS the
               Terminal page's header and it was the only head in the app
               with no title (owner, 2026-08-19: visual consistency). -->
        {#if embedded}
          <AgentChip
            label={session}
            variant="active"
            title={session}
            onclick={(e) => { e.stopPropagation(); showPanePicker = !showPanePicker; }}
          />
        {:else if onOpenSessions}
          <!-- The phone's lead-in matches Chat and Board (owner, 2026-08-30:
               "三个横线 + 项目名"): the hamburger opens the session drawer,
               the name is the title — the window chips after it keep their
               quick-switch behavior untouched. The chip's attention cue
               survives as a dot on the hamburger. -->
          <button class="icon-btn ham" title={t('sessions')} aria-label={t('sessions')}
            onclick={(e) => { e.stopPropagation(); onOpenSessions(); }}>
            <Icon name="menu" size={16} />
          </button>
          <h1 class="win-title" title={session}>{session}</h1><ServerTag name={scope?.tag} />
        {:else}
          <h1 class="win-title" title={session}>{session}</h1><ServerTag name={scope?.tag} />
        {/if}
        {#if showPanePicker}
          <PanePicker
            currentTarget={target}
            onPick={(p) => {
              showPanePicker = false;
              if (`${p.session}:${p.window}.${p.pane}` !== target && onSwitchPane) {
                preparePaneSwitch();
                onSwitchPane(`${p.session}:${p.window}.${p.pane}`);
              }
            }}
            onClose={() => showPanePicker = false}
          />
        {/if}
        <!-- Motion (motion.md): the strip fades in when the bar expands; a
             chip fades in when its window appears and MOVES when tmux
             renumbers or reorders (keyed by window index, animate:flip).
             Nothing here touches .term-wrap — only the chrome moves. -->
        <div class="win-bar-scroll appear">
          {#each windows as w (w.window)}
            {@const wAgent = paneAgent(w)}
            <!-- An agent window used to render as a bare icon, which told you
                 a kiro was there but not WHICH agent — unreadable in a project
                 with three of them (owner). Now every chip reads
                 `<index>:<name>`, the same coordinate the project drawer's
                 pills use; the icon stays as the backend's mark. A shell keeps
                 its command as the name, which is what identifies it. -->
            <!-- The hover card (use:hoverInfo) carries the window's facts; the
                 chip gets title={null}: the card speaks, no native tooltip beside it. -->
            <div class="win-chip appear" animate:flip={{ duration: moveMs() }} use:hoverInfo={() => windowInfo(w)}>
              <AgentChip
                agent={wAgent}
                title={null}
                label={`${w.window}:${wAgent ? w.window_name : (w.current_command || w.window_name)}`}
                variant={String(w.window) === currentWindow ? 'active' : 'default'}
                onclick={(e) => {
                  e.stopPropagation();
                  if (String(w.window) !== currentWindow && onSwitchPane) {
                    preparePaneSwitch();
                    onSwitchPane(`${w.session}:${w.window}.${w.pane}`);
                  }
                }}
              />
            </div>
          {/each}

          <AgentChip
            variant="add"
            iconName="plus"
            title="New window"
            onclick={async (e) => {
              e.stopPropagation();
              try {
                await newWindow(session);
                const ps = await listPanes(session);
                windowPanes = ps;
                const p = ps[ps.length - 1];
                if (p && onSwitchPane) {
                  preparePaneSwitch();
                  onSwitchPane(`${p.session}:${p.window}.${p.pane}`);
                }
              } catch {}
            }}
          />

        </div>

        {#if !embedded && splitEligible && onSetLayout}
          <div class="win-split">
            <button class="win-bar-collapse win-split-btn" class:on={splitActive} title={t('split')} aria-label={t('split')}
              aria-haspopup="menu" aria-expanded={!!splitMenuAt} onclick={toggleSplitMenu}>
              <Icon name="layout" size={12} />
            </button>
            <ContextMenu at={splitMenuAt} items={splitMenuItems} oncancel={() => (splitMenuAt = null)} />
          </div>
        {/if}
        {#if embedded && onClose}
          <!-- Split cell: close button instead of the collapse chevron
               (collapsing makes no sense — the bar IS the cell header). -->
          <button class="win-bar-collapse" aria-label="Close pane" onclick={(e) => { e.stopPropagation(); onClose(); }}>
            <Icon name="x" size={12} />
          </button>
        {:else}
          <button class="win-bar-collapse" aria-label="Collapse" onclick={() => { showWindowCmd = false; localStorage.setItem('tmux_winswitcher', '0'); }}>
            <Icon name="chevron-right" size={12} />
          </button>
        {/if}
      </div>
    {:else}
      {@const cur = windows.find(w => String(w.window) === currentWindow)}
      {@const curAgent = currentWinAgent}
      <!--
        Collapsed state: a single chip using the exact chip visual language
        from the expanded bar. Conceptually the switcher hasn't become
        "something else" — it has been compressed to the right end of the bar.

        On a DESKTOP the bar itself stays, because it is this page's
        `.page-head`: collapsing hides the window CHIPS, not the page's title
        and border. Dropping the whole bar left the Terminal tab as the only
        page in the app with no header — and since the collapsed state is the
        DEFAULT (`tmux_winswitcher` unset), that was what a fresh install
        looked like (measured 2026-08-19: no `.win-bar` in the DOM, xterm at
        top: 0). A phone still gets the floating chip alone: there the
        terminal needs every pixel of height.
      -->
      {#if isMobile}
        <div class="win-collapsed-anchor appear">
          <AgentChip
            agent={curAgent}
            label={curAgent ? '' : (cur?.current_command || cur?.window_name || '?')}
            chevron="left"
            onclick={() => { showWindowCmd = true; localStorage.setItem('tmux_winswitcher', '1'); }}
          />
        </div>
      {:else}
        <div class="win-bar page-head">
          <h1 class="win-title" title={session}>{session}</h1><ServerTag name={scope?.tag} />
          <span class="win-bar-spacer"></span>
          <AgentChip
            agent={curAgent}
            label={curAgent ? '' : (cur?.current_command || cur?.window_name || '?')}
            chevron="left"
            onclick={() => { showWindowCmd = true; localStorage.setItem('tmux_winswitcher', '1'); }}
          />
        </div>
      {/if}
    {/if}
  {/if}

  <div class="term-wrap">
    <div class="xterm-wrap" class:keep-rows={keepRowsOnKeyboard} bind:this={termEl}></div>
    {#if isMobile && selection && selUI}
      {#if selUI.startInView}
        <div class="sel-handle sel-handle-start appear" style="left: {selUI.startX}px; top: {selUI.startY}px; --cell-h: {selUI.cellH}px; --dot-shift-x: {selUI.startDotShiftX}px;" aria-hidden="true"></div>
      {/if}
      {#if selUI.endInView}
        <div class="sel-handle sel-handle-end appear" style="left: {selUI.endX}px; top: {selUI.endY}px; --cell-h: {selUI.cellH}px; --dot-shift-x: {selUI.endDotShiftX}px;" aria-hidden="true"></div>
      {/if}
      {#if selUI.toolbarVisible}
        <div class="sel-toolbar appear" class:below={selUI.toolbarBelow} style="left: {selUI.toolbarX}px; top: {selUI.toolbarY}px;"
          style:visibility={selToolbarHeight > 0 ? 'visible' : 'hidden'} bind:offsetHeight={selToolbarHeight}>
          <button class="sel-toolbar-btn" onpointerdown={(e) => { e.stopPropagation(); e.preventDefault(); copySelection(); }}>{t('copy')}</button>
        </div>
      {/if}
    {/if}
    {#if !termAtBottom}
      <button class="to-tail scroll-btn" class:news={hasNewContent} onclick={() => term?.scrollToBottom()} aria-label={hasNewContent ? t('newOutput') : t('scrollToBottom')}
        use:hoverInfo={() => ({ note: t('hoverToTailOutput') })}>
        <Icon name="arrow-down" size={16} />
      </button>
    {/if}
  </div>
  {#if !chromeless}
  <div class="input-area">
    {#if isMobile}
      <div class="input-bar">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="shortcut-rows" use:nonPassiveShortcuts ontouchend={stopRepeat} ontouchcancel={stopRepeat} oncontextmenu={(e) => e.preventDefault()} onmouseup={stopRepeat}>
          <div class="shortcuts">
            <button tabindex="-1" ontouchstart={() => startRepeat('Escape')}><span>Esc</span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('Tab')}><span>Tab</span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('C-a')}><span><Icon name="skip-left" size={13} /></span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('Up')}><span><Icon name="arrow-up" size={13} /></span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('C-e')}><span><Icon name="skip-right" size={13} /></span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('BSpace')}><span><Icon name="delete" size={13} /></span></button>
          </div>
          <div class="shortcuts">
            <button class="modifier" class:active={ctrlArmed} aria-pressed={ctrlArmed} tabindex="-1" ontouchstart={toggleCtrl}><span>Ctrl</span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('C-c')}><span>^C</span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('Left')}><span><Icon name="arrow-left" size={13} /></span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('Down')}><span><Icon name="arrow-down" size={13} /></span></button>
            <button tabindex="-1" ontouchstart={() => startRepeat('Right')}><span><Icon name="arrow-right" size={13} /></span></button>
            <!-- One slot, two keys, switched by `html.keyboard-open` — the
                 class App.svelte derives from the real IME height, so the key
                 the finger lands on is the key on screen (#296). Keyboard
                 down: Enter, sent once (double-tap is what opens the
                 keyboard). Keyboard up: close it. -->
            <button class="kb-enter" tabindex="-1" aria-label="Enter" ontouchstart={() => pressKey('Enter')}><span><Icon name="corner-down-left" size={13} /></span></button>
            <button class="kb-close" tabindex="-1" aria-label="Close keyboard" onpointerdown={(e) => {
              // Keep the touch out of the terminal-touch handlers.
              e.stopPropagation();
              e.stopImmediatePropagation();
              const ta = kbTa;
              if (!ta) return;
              // Cancel any pending unlock-grace retries so the blur
              // timer doesn't bounce focus back. See 73957f5.
              unlockUntil = 0;
              unlockRetries = 0;
              lockKeyboard(); // close key
              ta.blur();
            }}><span><Icon name="keyboard" size={13} /></span></button>
          </div>
        </div>
      </div>
    {:else}
      <!-- Desktop: no input bar, keyboard goes directly to xterm.js -->
    {/if}
  </div>
  {/if}
</div>

<style>
  .terminal {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: var(--bg);
    position: relative;
  }

  /* Collapsed: single chip floating top-right. The chip itself is an
     <AgentChip>, so its size/color come from that component. This wrapper
     only handles positioning. */
  .win-collapsed-anchor {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 10;
  }
  /* The flip wrapper around a chip: a box for animate:flip to move (the chip
     itself is a component). Same flex posture as the chip so the strip does
     not change shape. */
  .win-chip { display: flex; flex: none; }

  /* Expanded: horizontal tab bar pinned to the top of the Terminal view.
     Holds current-session windows; chip visuals live in AgentChip.
     Geometry, border and the h1 dialect come from the shared .page-head
     (ui-unification.md "Page skeleton") — this block only keeps what is
     win-bar-specific. The gap stays denser than the head's 10px because
     the bar is a chip strip, not a title-and-actions row. */
  .win-bar {
    gap: var(--ui-gap);
    position: relative; /* anchor for the PanePicker popover */
    /* The phone `.page-head` rule wraps head actions under the title; this
       head is a horizontal SCROLL strip, so it must stay one line — the
       chips scroll instead of stacking. */
    flex-wrap: nowrap;
  }
  /* The title is identity, the chips are navigation: cap the title so a long
     session name never squeezes the window chips off the bar. */
  /* Content-sized, never stretched: the phone's shared `.page-head h1
     { flex: 1 1 auto }` makes OTHER pages' titles take the row — here it
     shoved the window chips to the far right and filled the middle with
     blank (owner, 2026-08-30: "window紧跟着项目名称就行 中间不用那么大空
     白"). The chips strip is this bar's body; the title only names it. */
  .win-title { max-width: 22ch; flex: 0 1 auto; }
  .ham { position: relative; flex: none; }
  /* Collapsed head (desktop): the chip sits at the RIGHT end of the bar,
     which is what "compressed to the right end of the bar" always meant. */
  .win-bar-spacer { flex: 1; min-width: 0; }
  .win-bar-scroll {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--ui-gap);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .win-bar-scroll::-webkit-scrollbar { display: none; }
  .win-bar-collapse {
    flex-shrink: 0;
    width: var(--ui-control-height); height: var(--ui-control-height);
    padding: 0;
    border: none;
    border-radius: var(--ui-radius-control);
    background: transparent;
    color: var(--text3);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast), background var(--t-fast);
  }
  .win-bar-collapse:active { color: var(--accent); background: var(--surface2); }

  .win-split { position: relative; flex-shrink: 0; display: flex; }
  .win-split-btn.on { color: var(--accent); }


  .term-wrap {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
    /* Global UI zoom (web/Android CSS zoom) scales the chrome, NOT the
       terminal: counter-zoom back to 1.0 so xterm's cell metrics stay in
       physical pixels (terminal text size is its own setting). Tauri
       desktop zooms the webview instead — --ui-zoom stays 1 there. */
    zoom: calc(1 / var(--ui-zoom, 1));
  }

  .terminal-feedback {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    gap: calc(2 * var(--ui-gap));
    width: max-content;
    max-width: calc(100% - 4 * var(--ui-gap));
    z-index: 20;
  }

  /* No transition here, ever: this is xterm's container (motion.md
     principle 9). The old `margin-top 0.15s` had one writer, which set 0. */
  .xterm-wrap {
    height: 100%;
  }
  /* Keyboard as an overlay (agent TUIs only — see keepRowsOnKeyboard).
     `html.keyboard-open` is toggled by App.svelte in the same layout pass that
     shrinks --app-height, so the pinned height applies immediately and the
     element's box NEVER changes size: the ResizeObserver stays the single
     re-fit trigger (docs/design-docs/pages/terminal-sizing.md) and simply has
     nothing to report, which is why no resize_pane is sent and the agent does
     not repaint. The terminal is still its full height — the keyboard just
     covers the top of it, and .term-wrap already clips (overflow: hidden). */
  :global(html.keyboard-open) .xterm-wrap.keep-rows {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--kb-locked-h, 100%);
  }
  :global(.xterm-wrap.compact-lines .xterm-glyph) {
    display: inline-block;
    height: var(--xterm-char-height) !important;
    line-height: var(--xterm-char-height) !important;
    transform: translateY(calc(-1 * var(--xterm-line-offset)));
    font-weight: inherit !important;
    text-decoration: inherit;
    text-decoration-color: inherit;
  }
  /* xterm scrollbar: invisible at rest, fades in only while the user is
     interacting (xterm toggles `.invisible` ↔ `.visible` on hover/active
     scroll). On mobile we keep `pointer-events: auto` on the resting state
     so a finger can still grab the slider area, even though it's barely
     drawn. */
  .xterm-wrap :global(.xterm-scrollable-element > .invisible) {
    opacity: 0 !important;
    pointer-events: auto !important;
    transition: opacity 0.35s ease 0.2s !important;
  }
  .xterm-wrap :global(.xterm-scrollable-element > .visible) {
    opacity: 1 !important;
    transition: opacity 0.12s ease !important;
  }
  .xterm-wrap :global(.slider) {
    min-height: 40px !important;
    border-radius: 4px !important;
  }

  /* ─── Mobile selection handles + toolbar ──────────────────────────────── */
  /* iOS-style lollipop. The .sel-handle root is positioned at the precise
     anchor point on the selection edge (no negative margins — let JS land
     the anchor exactly on the cell corner). The stem (::before) rides ALONG
     the cell's vertical edge for one row of height; the dot (::after) is
     attached to the FREE end of the stem, away from the selection. */
  .sel-handle {
    position: absolute;
    width: 0; height: 0;
    z-index: 8;
    pointer-events: none; /* hit-test done in JS */
  }
  /* The .sel-handle div is 0×0 and positioned exactly on the anchor (cell
     corner). Both ::before (stem) and ::after (dot) are positioned relative
     to that single point.
     Invariant: stem and dot are both centered on the anchor's X (translateX(-50%)).
     The dot's near edge meets the stem's far end with no gap. */
  .sel-handle::before {
    /* Stem: 2px wide, one cell tall. */
    content: '';
    position: absolute;
    width: 2px;
    height: var(--cell-h, 16px);
    background: var(--accent, #00d4ff);
    transform: translateX(-50%);
    left: 0;
  }
  .sel-handle::after {
    /* Dot: 12px circle. translateX(-50%) centers it on the anchor X.
       --dot-shift-x is normally 0; when the handle is at column 0 / cols-1,
       JS sets it to ±6 px so the dot stays fully inside the touchable
       area instead of half-clipped against the screen edge. */
    content: '';
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent, #00d4ff);
    box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    transform: translateX(calc(-50% + var(--dot-shift-x, 0px)));
    left: 0;
  }
  /* Start handle: anchor at cell top-left.
       stem occupies [0, +cellH] (down through selection's first row)
       dot occupies  [+cellH, +cellH+12] (BELOW the stem, same side as the
       end handle's dot — keeps the touch target below the fingertip so the
       endpoint stays visible while dragging) */
  .sel-handle-start::before { top: 0; }
  .sel-handle-start::after  { top: calc(var(--cell-h, 16px)); }
  /* End handle: anchor at cell bottom-right.
       stem occupies [-cellH, 0] (up into selection's last row)
       dot occupies  [0, +12] (below anchor, outside selection) */
  .sel-handle-end::before { top: calc(0px - var(--cell-h, 16px)); }
  .sel-handle-end::after  { top: 0; }

  .sel-toolbar {
    position: absolute;
    transform: translate(-50%, -100%);
    z-index: 9;
    background: rgba(20, 20, 28, 0.95);
    border: 1px solid var(--border, #2a2a3a);
    border-radius: var(--ui-radius-row);
    padding: 4px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    display: flex;
    gap: 2px;
  }
  .sel-toolbar.below {
    transform: translate(-50%, 0);
  }
  :global(html[data-theme="light"]) .sel-toolbar {
    background: rgba(245, 245, 247, 0.95);
  }
  .sel-toolbar-btn {
    background: transparent;
    border: none;
    color: var(--accent, #00d4ff);
    font-size: var(--fs-body);
    font-weight: 500;
    padding: 6px 14px;
    border-radius: var(--ui-radius-control);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    min-width: 56px;
    min-height: 32px;
  }
  .sel-toolbar-btn:active {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  /* Back to the live tail: the LOOK is the shared .to-tail in app.css
     (board #49 unified it with the chat feed's — one circle, one surface,
     one news dot, one 44px overlay) — only the placement lives here. */
  .scroll-btn { bottom: 12px; right: 16px; z-index: 5; }

  .input-area {
    flex-shrink: 0;
    /* Plain 10px, no env(safe-area-inset-bottom): this bar sits above the
       app's TAB BAR, which already pads for the gesture bar (--sab) — the
       same double-inset that opened a band under the chat composer (owner,
       2026-08-21: "terminal的快捷键区和下方标签按钮区上下间距也有点大").
       Keyboard-open keeps its own tighter override below. */
    padding: 0 10px 10px;
  }
  :global(html.keyboard-open) .input-area { padding: 0 4px 2px; }

  .input-bar {
    background: rgba(10,10,15,0.65);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: var(--ui-radius-panel);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  :global(html[data-theme="light"]) .input-bar { background: rgba(245,245,247,0.65); }
  :global(html.keyboard-open) .input-bar {
    border-radius: var(--ui-radius-row);
    padding: 4px 6px;
    gap: 4px;
  }

  .shortcut-rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .shortcuts {
    display: flex;
    gap: 3px;
    height: var(--ui-control-height);
    padding: 0;
    box-sizing: border-box;
  }
  .shortcuts::-webkit-scrollbar { display: none; }

  .shortcuts button {
    flex: 1;
    height: var(--ui-control-height);
    padding: 0;
    box-sizing: border-box;
    border: 1px solid var(--input-border);
    border-radius: var(--ui-radius-control);
    background: var(--input-bg);
    color: var(--text2);
    font-size: var(--ui-font-control);
    line-height: 1.3;
    font-family: var(--font-mono);
    font-weight: 500;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
    /* Colour cross-fades (covers the armed Ctrl pill and the keyboard
       toggle's highlight); `transform` is deliberately NOT in the list so
       the press translateY(1px) lands instantly under the finger. */
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .shortcuts button:active,
  .shortcuts :global(button.pressed) {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--accent);
    transform: translateY(1px);
    box-shadow: none;
  }
  .shortcuts button > span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transform: translateY(1px);
  }
  .shortcuts button.modifier.active {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--accent);
    box-shadow: none;
  }
  .shortcuts .kb-close { display: none; }
  :global(html.keyboard-open) .shortcuts .kb-enter { display: none; }
  :global(html.keyboard-open) .shortcuts .kb-close {
    display: flex;
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--accent);
  }


</style>
