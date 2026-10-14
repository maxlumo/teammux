<script>
  import CommandButton from '../ui/CommandButton.svelte';
  import { onDestroy, untrack, tick as settled } from 'svelte';
  import Icon from '../ui/Icon.svelte';
  import ChatImage from './ChatImage.svelte';
  import 'katex/dist/katex.min.css';
  import { t, i18n, hanLang } from '../core/i18n.svelte.ts';
  import { copyText } from '../core/clipboard.ts';
  import OperationFeedback from '../ui/OperationFeedback.svelte';
  import { feedbackPosition } from '../ui/feedback-position.ts';
  import { scheduleCompletion } from '../ui/feedback-lifetime.ts';
  import { MESSAGE_ACTS_IDLE, messageActsSet, messageActsCopyLanded, messageActsCopyFailed, messageActsExpired } from './message-actions.ts';
  import { renderMarkdown } from '../core/markdown.ts';
  import { handlePathLinkClick } from '../core/path-links.ts';
  import { selectionClickGuard } from '../ui/native-context-menu.ts';
  import { boxFromOffsets } from '../ui/indicator.ts';
  import { createDoubleTapDetector } from '../terminal/terminal-keyboard.ts';
  import { heldAnchor, readingDirection, refoldEligible, sameReadingSize } from './hub-reading.ts';
  import { FONT_CHANGE_EVENT } from '../app/fonts.svelte.ts';
  import { parseQuote, TAIL_GAP, bottomGap, tailAfterScroll, markMentions, mentionedAgents, splitImages, toolColor, pickAnchor, toolEventParts, elideTail, foldedCommandArgs, foldLines, statusNote, noteStateColor, runtimeLabel, agentHue, sysParts, sysVerbColor, boardLine, boardStatusColor, promptParts, sameDay, continuesRun, perLineOf, STEPS_ROWS, stateIsLive } from './hub.ts';

  let {
    blocks = [], agents = [], managedNames = [], selected = '', visible = false, compact = false,
    roomReady = false, justLoaded = false, openedAt = Infinity,
    loadingOlder = false, histMore = false, actMore = false, stepsRows = STEPS_ROWS,
    following = $bindable(true), newBelow = $bindable(false),
    stateLabel = (state) => state, emptyFeed = null,
    onseen: markSeen = () => {}, onolder: loadOlder = async () => {},
    onpath: routePathRef = () => {}, onboard = () => {}, onimage = () => {}, onreply = null,
    registerActions = null,
    /** A jump's history window is on screen (board #322): it is not the
     * tail, so nothing here follows, marks seen or writes the tail — the
     * to-tail control asks Hub for the latest page instead (`onlatest`). */
    windowed = false, onlatest = () => {},
  } = $props();

  // A resize snapshot belongs to one room. Tool disclosures, copied-label
  // timing and glyph/held-anchor state retain their old lifetime.
  export function resetForRoom() {
    reading = null;
    expanded = {};
    setMessageActions(-1);
    rawOpen = '';
  }

  // Hub installs its capture listeners in their original order. Registration
  // hands it live operations, never a copied flag or a fourth reading export.
  $effect(() => registerActions?.({
    isOpen: () => !!msgOpen,
    outside: (e) => {
      const t = e.target;
      if (msgOpen && !t?.closest?.('.m-acts, .bubble, .message-feedback')) setMessageActions(-1);
    },
    escape: (e) => { if (msgOpen) { setMessageActions(-1); e.stopPropagation(); } },
  }));

  let feedEl = $state(null);
  let reading = null;
  let captureQueued = false;

  function readingSize() {
    if (!feedEl) return null;
    const cs = getComputedStyle(feedEl);
    const width = feedEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const height = feedEl.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  const rowTop = (row) => boxFromOffsets(row, feedEl).offsetTop;
  const readableRow = (row) => row instanceof HTMLElement && getComputedStyle(row).position !== 'sticky';

  function captureReading(size = readingSize()) {
    if (!feedEl || !size) return null;
    // Start at the previous row and walk only what the scroll crossed. A
    // full-history scan on every scroll frame would make this cache costly.
    let ref = reading?.session === selected && reading.ref?.parentElement === feedEl
      ? reading.ref : feedEl.firstElementChild;
    const top = feedEl.scrollTop;
    while (ref?.previousElementSibling && (!readableRow(ref) || rowTop(ref) > top + 1)) {
      ref = ref.previousElementSibling;
    }
    while (ref && (!readableRow(ref) || rowTop(ref) + ref.offsetHeight <= top + 1)) {
      ref = ref.nextElementSibling;
    }
    return { session: selected, element: feedEl, size, ref, offset: ref ? rowTop(ref) - top : 0 };
  }
  function rememberReading(acceptResize = false) {
    if (!visible) return;
    const size = readingSize();
    if (!size) return;
    if (!acceptResize && reading?.session === selected && !sameReadingSize(reading.size, size)) return;
    reading = captureReading(size);
  }
  function queueReadingCapture() {
    if (captureQueued) return;
    captureQueued = true;
    settled().then(() => { captureQueued = false; rememberReading(); });
  }
  async function onContentLoad() {
    const element = feedEl, session = selected, tail = following;
    // Capture runs before ChatImage updates its loaded/error view. Finish that
    // update before measuring, without turning a history reader into live tail.
    await settled();
    if (feedEl !== element || selected !== session) return;
    if (tail && following) writeTail();
    else queueReadingCapture();
  }
  function resizePending() {
    return reading?.session === selected && reading.element === feedEl
      && !sameReadingSize(reading.size, readingSize());
  }

  /** A click inside a bubble that landed on a PATH link (board #99). Returns
   * true when the click is ours — the caller stops the bubble's own toggle. */
  function openPathRef(e) {
    return handlePathLinkClick(e, routePathRef);
  }

  /** Follow the tail — but only while the user is AT the tail. Yanking someone
   * back down while they read history is worse than a missed autoscroll, so new
   * content only scrolls when `following`; sending forces it, because you plainly
   * want to see what you just sent. */
  export function scrollToTail(force = false) {
    // A history window (#322) is not the tail: going there is Hub's "Back to latest".
    if (windowed) { if (force) onlatest(); return; }
    if (!force && !following) return;
    requestAnimationFrame(writeTail);
  }
  function writeTail() {
    // Hidden, the jump is DEFERRED, not lost: data may update freely and the
    // visible-restore effect forces the tail when the page comes back.
    if (!feedEl || !visible) return;
    feedEl.scrollTop = feedEl.scrollHeight;
    // Programmatic jumps have no continuous path to preserve. Seed from the
    // destination (latest passed message), and do not depend on a scroll event
    // — assigning the same scrollTop emits none.
    askScrollTop = feedEl.scrollTop;
    askDir = 'down';
    askDirTravel = 0;
    syncAsk('down', true);
    following = true;
    newBelow = false;
    markSeen();
    rememberReading(true);
    queueReadingCapture();
  }


  const atBottom = () => !feedEl || bottomGap(feedEl) < TAIL_GAP;

  let askKey = $state('');        // the ONE user-message anchor on screen
  let askEdge = $state('');       // which edge that same bubble catches
  let askHeld = $state(false);    // true only after it has actually hit the edge
  let askScrollTop = 0;           // last observed position
  let askDir = 'down';            // committed direction — flips only after real travel
  let askDirTravel = 0;           // accumulated movement AGAINST the committed direction


  function onFeedScroll() {
    // Layout can clamp scrollTop before RO runs. It is not a new user intent,
    // and must not overwrite either the old reference or the tail decision.
    if (visible && resizePending()) return;
    // Tail intent goes through the ONE transition rule: a hidden page's
    // scroll events (layout noise from other tabs, content growing under a
    // hidden feed) must not pollute `following` in either direction — and
    // nothing below is worth doing off-screen either; the visible-restore
    // effect re-parks the tail (board #38).
    following = !windowed && tailAfterScroll(visible, following, feedEl ? bottomGap(feedEl) : 0);
    if (!visible) return;
    // Everything below reads layout (syncAsk neutralizes the stickies, then
    // reads every [data-ask] box; autoRefold queries each expanded key) and a
    // scroll event fires several times per frame under momentum, so it is
    // coalesced into ONE pending animation frame — the browser has to lay out
    // once for the frame anyway (review C, 2026-09-03). Direction hysteresis
    // works on the frame's net delta, which is what the 16px threshold meant.
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!feedEl || !visible) return;
      const top = feedEl.scrollTop;
      // Near the top: reach for the previous page. 120px of runway starts the
      // fetch before the reader actually hits the edge.
      if (top < 120 && roomReady) loadOlder();
      const delta = top - askScrollTop;
      askScrollTop = top;
      const motion = readingDirection(delta, askDir, askDirTravel);
      askDir = motion.direction;
      askDirTravel = motion.travel;
      syncAsk(askDir);
      if (following) {
        newBelow = false;
        markSeen();
      }
      autoRefold();
      queueReadingCapture();
    });
  }
  let scrollFrame = 0;

  /** One bubble, one continuous motion: select it while it is naturally inside
   * the viewport, then let CSS sticky catch that SAME element as it leaves in
   * the current scroll direction. In an empty stretch of a long reply, retain
   * it; never swap to another invisible message at an arbitrary midpoint. */
  /** The height a folded message should not exceed — a fifth of the
   * conversation, the owner's number. It is an ESTIMATE that feeds the line
   * budget below, never a cap on the box: the bubble is never clipped, the
   * text is folded to fit. Measured on the CHAT COLUMN (the feed's parent),
   * never the feed itself: the feed is the flex leftover after the composer,
   * so typing a multi-line message shrank it, the next `blocks` tick
   * re-measured, the budget dropped a line, and EVERY folded message re-cut —
   * heights shifting with no compensation, which read as the parked tail
   * drifting on its own (owner, 2026-08-27: "我打字输入，原来是最下方，但是一
   * 会儿又变化了"). The column holds still while the composer grows. */
  let heldBasis = $state(0);
  let heldLine = $state(20);        // measured line box of a bubble, px
  /** The measured halves of perLine (board #53 review blocker): the widest
   * content line a bubble can wrap at, and the bubble font's average latin
   * glyph. The default 80 was only right at ~1280px; a 420px drawer line is
   * ~38 glyphs, so the fold under-priced wrapping ~2.1× and a "folded"
   * bubble rendered ~8 lines on a 4-line budget. Both start unmeasured (0):
   * `perLineOf` answers the historic default until the first real bubble is
   * seen — the same pre-measure posture as the Board's chip columns. */
  let heldWidth = $state(0);
  let heldGlyph = $state(0);
  /** One canvas measures every font once — measureHeld runs on every blocks
   * tick, and layout-thrashing a probe span there would be a poll tax. */
  let glyphCanvas = null;
  const glyphCache = new Map();
  function glyphWidth(font) {
    if (!font) return 0;
    const hit = glyphCache.get(font);
    if (hit !== undefined) return hit;
    glyphCanvas ??= document.createElement('canvas');
    const gctx = glyphCanvas.getContext('2d');
    if (!gctx) return 0;
    gctx.font = font;
    // A representative chat line, not the alphabet: word spacing, case mix
    // and digits at their natural frequency. CJK is deliberately absent —
    // elideTail prices it separately at 2 units.
    const sample = 'the quick brown fox jumps over the lazy dog, THE QUICK BROWN FOX 0123456789.';
    const w = gctx.measureText(sample).width / sample.length;
    glyphCache.set(font, w);
    return w;
  }
  function measureHeld() {
    if (!feedEl) return;
    heldBasis = feedEl.parentElement?.clientHeight || feedEl.clientHeight;
    const bubble = feedEl.querySelector('.bubble');
    if (!bubble) return;
    const cs = getComputedStyle(bubble);
    const lh = parseFloat(cs.lineHeight);
    if (Number.isFinite(lh) && lh > 6) heldLine = lh;
    // The widest line a folded bubble can wrap at: the feed's content box ×
    // the --msg-max cap (min(84%, 1360px) — the CSS constant, pinned by the
    // source test so the two cannot drift apart), minus the bubble's own
    // horizontal padding. Never the sampled bubble's width: bubbles hug
    // their content, so a short message's bubble lies about the line.
    const feedW = readingSize()?.width ?? 0;
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const w = Math.min(feedW * 0.84, 1360) - padX;
    if (w > 0) heldWidth = w;
    const g = glyphWidth(cs.font || `${cs.fontSize} ${cs.fontFamily}`);
    if (g > 0) heldGlyph = g;
  }
  $effect(() => {
    void blocks; void visible;
    measureHeld();
    queueReadingCapture();
  });
  $effect(() => {
    void expanded; void rawOpen;
    Object.values(stepsChoice); Object.values(stepsAll);
    queueReadingCapture();
  });
  $effect(() => {
    if (!feedEl || !visible) return;
    const ro = new ResizeObserver(() => {
      const size = readingSize();
      if (!size) return;
      const before = reading?.session === selected && reading.element === feedEl ? reading : null;
      if (before && sameReadingSize(before.size, size)) return;
      void withReadingAnchor(measureHeld, before);
    });
    ro.observe(feedEl);
    // A FONT is a layout mutation that arrives through no other door (board
    // #189): the container does not resize, no block changes, and a system
    // family fires no `document.fonts` event at all — yet every bubble
    // re-wraps. Measured at 390×844 with 24 messages: uiFont.set("DejaVu Sans
    // Mono") grew scrollHeight 2563 → 2795 while scrollTop stayed 1839, a
    // 232 px gap under a feed that still believed it was following. Both the
    // web-font completion and the app's own font-role swap (`tmux:font`,
    // dispatched by fonts.apply) run the ONE reading transaction: following
    // re-measures the fold and re-takes the tail; a reader keeps their row.
    const onFontChange = () => { void withReadingAnchor(() => {}, reading); };
    document.fonts?.addEventListener('loadingdone', onFontChange);
    document.addEventListener(FONT_CHANGE_EVENT, onFontChange);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener('loadingdone', onFontChange);
      document.removeEventListener(FONT_CHANGE_EVENT, onFontChange);
    };
  });
  /** How many whole lines a folded user message may show — the mapping is
   * `foldLines` in hub.ts (pure, tested; board #4): a flat small budget on
   * compact (the keyboard resize cannot move it), the screen-derived fifth
   * on desktop. */
  const heldLines = $derived(foldLines(compact, heldBasis, heldLine));
  /** perLine, measured — the ONE mapping is perLineOf (pure, tested). */
  const heldPerLine = $derived(perLineOf(heldWidth, heldGlyph));
  /** The body a folded user message shows: a plain rear truncation (owner,
   * 2026-08-27: "直接后截断的形式 … 中间不要了，默认用户消息都截断"). Identity
   * when it already fits, so the common case re-renders nothing. */
  const foldBody = (text) => elideTail(text, heldLines, heldPerLine);
  /** A sent /command folds through the same budget; `null` when it fits. */
  const foldCmd = (cmd) => foldedCommandArgs(cmd, heldLines, heldPerLine);
  /** Messages the reader unfolded by hand, by key. Folding is the DEFAULT for
   * every long user message, so an unfold is a choice that stays until the
   * project changes — resetting it whenever the anchor moved would re-fold a
   * message the reader is still reading. */
  let expanded = $state({});
  /** Double-tap on a HELD bubble jumps to it (board #304). Touch uses the
   * terminal's one double-tap detector; a mouse has native dblclick. */
  const heldDoubleTap = createDoubleTapDetector();
  // The pair's second tap still produces a click; it must not reopen the
  // action row the jump just closed.
  let jumpClick = null;
  function jumpHeld(key) {
    getSelection?.()?.removeAllRanges();
    setMessageActions(-1);
    jumpToMsg(key);
  }
  /** Expanding releases the pin (see `pinned` in the markup), so the bubble
   * returns to its natural flow position — often pages away from the viewport
   * that was showing its pinned copy, which read as the message VANISHING
   * (owner, 2026-08-27: "现在点击展开 消息就不见了 应该展开跳转到那条消息的位
   * 置"). Jump the feed to the message's own position, unless its start is
   * already in view — then expansion just grows downward in place. */
  async function expandMsg(key) {
    expanded = { ...expanded, [key]: true };
    await settled();
    jumpToMsg(key);
  }
  /** Bring a user message's NATURAL position into view — the one jump shared
   * by expanding and by double-tapping a held bubble (board #304). A held
   * bubble is sticky, and Chromium reports a sticky element's HELD offsetTop,
   * so stickiness is neutralized for this synchronous read (as in syncAsk). */
  function jumpToMsg(key) {
    if (!feedEl) return;
    const el = feedEl.querySelector(`[data-ask="${CSS.escape(key)}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.style.position = 'static';
    const at = el.offsetTop;
    el.style.removeProperty('position');
    const top = feedEl.scrollTop;
    if (at >= top && at < top + feedEl.clientHeight - 60) {
      syncAsk();
      return;
    }
    feedEl.scrollTop = Math.max(0, at - 8);
    // Programmatic jump: seed the anchor path from the destination, the way
    // scrollToTail does — the scroll event this assignment fires then sees a
    // zero delta and invents no direction.
    askScrollTop = feedEl.scrollTop;
    askDirTravel = 0;
    syncAsk(askDir, true);
  }
  /** Bring ONE message — a bubble or a lifecycle row, by its id — to its
   * natural place 8px from the top and ring it once (board #322, the
   * notification centre's jump). Returns false when it is not mounted, so the
   * caller never claims a landing it did not make. */
  let hitId = $state('');
  let hitTimer = 0;
  export function showMsg(id) {
    if (!feedEl || !id) return false;
    const el = feedEl.querySelector(`[data-msg="${CSS.escape(String(id))}"]`);
    if (!(el instanceof HTMLElement)) return false;
    el.style.position = 'static';
    let at = 0;
    for (let n = el; n && n !== feedEl; n = n.offsetParent) at += n.offsetTop;
    el.style.removeProperty('position');
    following = false;
    feedEl.scrollTop = Math.max(0, at - 8);
    askScrollTop = feedEl.scrollTop;
    askDirTravel = 0;
    syncAsk(askDir, true);
    hitId = String(id);
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => { hitId = ''; }, 1600);
    return true;
  }
  onDestroy(() => clearTimeout(hitTimer));
  /** An expanded message the reader scrolled clean away from folds itself back
   * and rejoins the anchor pool (owner, 2026-08-27: "划走看不到以后 自动折叠
   * 并且钉住"). "Away" is the whole box out of the viewport by a margin, so a
   * pixel of overshoot does not snap it shut; the refold changes heights
   * outside the viewport, so it goes through the reading anchor. */
  function autoRefold() {
    if (!feedEl) return;
    const keys = Object.keys(expanded);
    if (!keys.length) return;
    const top = feedEl.scrollTop;
    const bottom = top + feedEl.clientHeight;
    const gone = keys.filter((k) => {
      const el = feedEl.querySelector(`[data-ask="${CSS.escape(k)}"]`);
      return el instanceof HTMLElement
        && refoldEligible({ top: el.offsetTop, height: el.offsetHeight }, top, bottom);
    });
    if (!gone.length) return;
    const next = { ...expanded };
    for (const k of gone) delete next[k];
    withReadingAnchor(() => { expanded = next; });
  }

  function syncAsk(direction = askDir, reset = false) {
    if (!feedEl) { askKey = ''; askEdge = ''; askHeld = false; return; }
    // Chromium's offsetTop for a sticky element is its HELD position. Read that
    // and the old anchor appears naturally visible, so the next anchor is never
    // selected. Neutralize the one current sticky element for this synchronous
    // layout read; the inline override is removed before the browser can paint.
    const stickies = [...feedEl.querySelectorAll('.ask-top, .ask-bottom')];
    for (const el of stickies) el.style.position = 'static';
    const items = [...feedEl.querySelectorAll('[data-ask]')].map((el) => {
      // Folding is a default property of the TEXT now, never a held-state side
      // effect, so the box is the same height held or not and the real
      // offsetHeight is the right answer. (The old naturalH phantom-height
      // cache existed for fold-on-hold, where holding shrank the box, that
      // unheld it, and the blink came back sourced from the text.)
      const key = el.dataset.ask ?? '';
      return { key, top: el.offsetTop, height: el.offsetHeight };
    });
    for (const el of stickies) el.style.removeProperty('position');
    const picked = pickAnchor(
      items,
      feedEl.scrollTop,
      feedEl.clientHeight,
      feedEl.scrollHeight,
      direction,
      reset ? undefined : { key: askKey, edge: askEdge },
    );
    const chosen = items.find((it) => it.key === picked.key);
    const anchor = heldAnchor(picked, chosen,
      { key: askKey, edge: askEdge, held: askHeld },
      feedEl.scrollTop, feedEl.scrollTop + feedEl.clientHeight);
    askKey = anchor.key;
    askEdge = anchor.edge;
    askHeld = anchor.held;
  }
  $effect(() => {
    void blocks;   // a new message changes both the set and the geometry
    requestAnimationFrame(syncAsk);
  });

  // Coming back to the page lands where the reader LEFT it (board #38): at
  // the tail when they were following — messages kept arriving while the page
  // was hidden and the physical scroll was deferred — and exactly where they
  // parked when they were reading history (a reader must never be yanked to
  // the bottom). Settle Svelte first, then scrollToTail's own rAF forces the
  // tail and re-seeds the ask anchor + seen marker.
  let hubWasVisible = false;
  $effect(() => {
    if (!visible) { hubWasVisible = false; return; }
    if (hubWasVisible) return;
    hubWasVisible = true;
    if (!following) return;
    settled().then(() => scrollToTail(true));
  });

  // The keyboard shrinks the visible viewport (App sets --app-height and fires
  // this), which otherwise leaves the tail below the fold: the feed keeps its
  // scrollTop while its box gets shorter. Re-park at the tail instead.
  $effect(() => {
    if (!visible) return;
    const onKb = () => { if (following) scrollToTail(true); };
    window.addEventListener('keyboard-shift', onKb);
    return () => window.removeEventListener('keyboard-shift', onKb);
  });


  /** Run a layout-changing mutation without losing the reader's place.
   *
   * Opening or closing the terminal drawer regrids the columns: the feed
   * narrows, every message rewraps to a new height, and the same scrollTop now
   * points at different content — the reader's message drifts away (owner,
   * 2026-08-20: "点击右侧 terminal 按钮后，当前消息变窄，导致当前消息位置漂移").
   * `overflow-anchor` cannot help — it is off on purpose (the held-ask blink) —
   * so this does the anchoring by hand: remember the topmost visible block and
   * its offset from the feed's top edge, mutate, then put the SAME element back
   * at the SAME offset. Svelte's keyed each preserves the DOM node, so identity
   * is the element itself; a pinned (sticky) ask is skipped as the reference
   * because its rect does not move with the flow. At the tail, just stay at the
   * tail — that is what "where I was" means there. */
  export async function withReadingAnchor(mutate, before = null) {
    if (!feedEl) { mutate(); return; }
    const element = feedEl, session = selected;
    const current = () => feedEl === element && selected === session;
    if (following) {
      mutate();
      await settled();
      if (!current()) return;
      // The mutation may have changed the COLUMN WIDTH without a window
      // resize (the drawer regrid is exactly that), and the fold budget is
      // MEASURED (board #46 second blocker): re-read the new line, let every
      // folded message re-cut at the new perLine, and only then take the
      // tail — a tail taken before the re-cut lands on heights about to move.
      measureHeld();
      await settled();
      if (!current()) return;
      writeTail();
      return;
    }
    if (before?.session !== session || before?.element !== element) before = captureReading();
    mutate();
    await settled();
    if (!current()) return;
    // Same rule for the history reader: the reference offset is only worth
    // restoring against FINAL heights, and heights are final only after the
    // measured fold has re-cut for the new width. One measureHeld call is
    // the whole re-read — width, glyph and line box all live there.
    measureHeld();
    await settled();
    if (!current()) return;
    if (before?.ref?.isConnected && before.ref.parentElement === feedEl) {
      feedEl.scrollTop += rowTop(before.ref) - feedEl.scrollTop - before.offset;
    }
    // The anchor machinery reads geometry; it must re-decide for the new widths.
    syncAsk();
    rememberReading(true);
    queueReadingCapture();
  }


  // A block's `window` IS the agent name since board #120; the lookup
  // survives only as the fallback costume for a window with no live agent.
  const windowName = (w) => agents.find((a) => a.name === w)?.name ?? `${w}`;


  // Disclosure lives outside the row: `undefined` means "nobody chose", and the
  // default is OPEN — what an agent is doing is the thing you came to watch
  // (owner, 2026-08-19; it used to open only while the agent was working, so a
  // finished run needed a click to read). An explicit choice sticks. Keyed by
  // group so re-renders can't lose it.
  let stepsChoice = $state({});
  let stepsAll = $state({});        // group key → lift the 10-row cap
  let messageActs = $state(MESSAGE_ACTS_IDLE);
  let copyTrigger = $state(null);
  const msgOpen = $derived(messageActs.open === -1 ? '' : messageActs.open);
  let cancelCopyExpiry = () => {};
  function setMessageActions(key) {
    cancelCopyExpiry(); cancelCopyExpiry = () => {};
    copyTrigger = null;
    messageActs = messageActsSet(messageActs, key);
  }
  $effect(() => { if (!visible) untrack(() => setMessageActions(-1)); });
  onDestroy(() => setMessageActions(-1));
  // Native touch selection may emit a compatibility click after contextmenu.
  // Consume that one click per bubble before it can open the action row.
  const msgSelectionClicks = selectionClickGuard();
  let rawOpen = $state('');         // message key showing its raw source
  /** Copy a message as the agent wrote it — markdown, image refs and all.
   * copyText carries the insecure-context fallback (LAN http:// dev). */
  async function copyMsg(key, body, trigger) {
    if (msgOpen !== key || !(trigger instanceof HTMLElement)) return;
    setMessageActions(key);
    copyTrigger = trigger;
    const attempt = messageActs.gen;
    const ok = await copyText(body ?? '');
    const next = ok ? messageActsCopyLanded(messageActs, attempt)
      : messageActsCopyFailed(messageActs, attempt, t('copyFailed'));
    if (next === messageActs) return;
    messageActs = next;
    if (ok) {
      const gen = next.gen;
      cancelCopyExpiry = scheduleCompletion(() => { messageActs = messageActsExpired(messageActs, gen); });
    }
  }
  const isRunning = (b) =>
    b.key === newestSteps[b.window] &&
    stateIsLive(agents.find((a) => a.name === b.window)?.state ?? '');
  // A run its reply carries is folded until someone opens it (#295): the
  // answer is the thing to read, the steps are how it got there.
  // A run of its own (#298) is open only while it RUNS — the capped tail is
  // the live view — and folds like a carried run once it stopped.
  const stepsOpen = (b, attached = false) => stepsChoice[b.key] ?? (!attached && isRunning(b));
  const toggleSteps = (b, open) => { stepsChoice[b.key] = open; };

  /** Keep a capped step list showing its NEWEST row, the way a log tail does —
   * unless the user has scrolled up inside it, which is a deliberate look at
   * history and must not be yanked back. `use:stickBottom={events.length}`
   * re-runs on every appended call. */
  function stickBottom(node) {
    let stick = true;
    const onScroll = () => { stick = node.scrollHeight - node.scrollTop - node.clientHeight < 24; };
    node.addEventListener('scroll', onScroll, { passive: true });
    const toBottom = () => { if (stick) requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; }); };
    toBottom();
    return { update: toBottom, destroy: () => node.removeEventListener('scroll', onScroll) };
  }
  /** Per window, the key of its LAST step group: only that one can be running. */
  const newestSteps = $derived.by(() => {
    const last = {};
    for (const b of blocks) {
      if (b.type === 'steps') last[b.window] = b.key;
      else if (b.type === 'msg' && b.steps) last[b.steps.window] = b.steps.key;
    }
    return last;
  });
  const blockKey = (b, i) =>
    b.type === 'msg' ? (b.msg.id ?? `m${b.ts}-${i}`) : b.type === 'steps' || b.type === 'sys' ? b.key : `${b.type}${b.ts}-${i}`;


  // Notification kinds get a human label; unknown kinds fall back to the raw
  // text (t() returns the key on a miss, so detect that).
  function activityLabel(e) {
    if (e.kind !== 'notif') return e.text;
    const label = t('hubNotif_' + e.text);
    return label.startsWith('hubNotif_') ? e.text : label;
  }


  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /** The date separator's label: Today / Yesterday in the app's own words,
   * otherwise a local-format date (year only when it differs — a chat is
   * mostly about this week). */
  const fmtDay = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (days === 0) return t('hubToday');
    if (days === 1) return t('hubYesterday');
    const opts = { month: 'short', day: 'numeric', weekday: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(i18n.lang === 'zh' ? 'zh-CN' : 'en-US', opts);
  };

</script>

<div class="feed-wrap">
<div class="feed subtle-scroll" class:reveal-tail={justLoaded} bind:this={feedEl} onscroll={onFeedScroll}
  onloadcapture={onContentLoad} onerrorcapture={onContentLoad}>
  <!-- Low-presence paging feedback at the very top: fetching, or the
       confirmed beginning once both walks are parked (board #9). -->
  {#if roomReady && (loadingOlder || (!histMore && !actMore))}
    <div class="older-hint">{loadingOlder ? t('hubOlderLoading') : t('hubFeedStart')}</div>
  {:else if roomReady && (histMore || actMore)}
    <!-- A first page shorter than the viewport never fires a scroll
         event, so the walk needs a hand-hold too (#9 review). Same
         whisper voice; scrolling near the top still auto-loads. -->
    <button class="older-hint older-more" onclick={loadOlder}>{t('hubOlderMore')}</button>
  {/if}
  <!-- An uncached room's stand-in (principle 15): three bubble-shaped
       skeletons, alternating sides, parked at the TAIL where the eye
       lands (margin-top: auto in the column). A cached room is ready
       at once and never shows them. Nothing scrolls yet — the block is
       shorter than the viewport — so no scrollTop is parked; loadFeed's
       own scrollToTail() lands the real blocks at the tail as before. -->
  {#if selected && !roomReady}
    <div class="skel-wrap sk-feed" aria-hidden="true">
      <span class="skel sk-msg"></span>
      <span class="skel sk-msg me"></span>
      <span class="skel sk-msg"></span>
    </div>
  {/if}
  <!-- The way to the whole text and back — ONE control for the user bubble
       and the prompt row (board #172: the prompt row used to clip silently
       at 7.5em beside this mechanism). A button, because this is the one
       thing you might want from a folded text — the surrounding row is
       inert prose. ONE button for both directions so its caret can TURN
       (motion.md principle 4) — the body itself is a cut, never a slide
       (principle 10: the feed owns its scroll). stopPropagation keeps the
       bubble's own click (the action row) from firing on it. -->
  <!-- Tool calls between two replies: one collapsible run per window (rule
       3). The SAME list in both places it can live (board #295): a block of
       its own while it runs or when nothing of its agent answered, and,
       once its agent's reply ended it, a strip at the top of that reply's
       bubble, folded by default because the answer is right below. -->
  {#snippet lane(b, attached)}
    {@const open = stepsOpen(b, attached)}
      <!-- Inside a reply's bubble, NO click on the run reaches the bubble's
           own click (which opens the message's action row): head, rows and
           "show all" alike, the m-unfold rule, stopped once at the lane
           (validator #295 P1). -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="steps" class:open
        onclick={(e) => { if (attached) e.stopPropagation(); }}>
        <button class="s-head" aria-expanded={open} onclick={() => toggleSteps(b, !open)}>
          {#if !attached && isRunning(b)}
            <span class="s-live live-dot" aria-hidden="true"></span>
          {:else}
            <span class="chev" class:open><Icon name="chevron-right" size={12} /></span>
          {/if}
          <span class="s-count">{t('hubStepsN').replace('{n}', String(b.events.length))}</span>
          {#if !open}
            {@const last = b.events[b.events.length - 1]}
            {@const lp = last ? toolEventParts(last) : { tool: '', text: '' }}
            <span class="s-peek">{#if lp.tool}<span class="tname" style:color={toolColor(lp.tool)}>{lp.tool}</span> {/if}{lp.text}</span>
          {/if}
        </button>
        {#if open}
          {@const capped = !stepsAll[b.key] && b.events.length > stepsRows}
          <!-- Every call is in the DOM; the CAP is a viewport on it, so a
               live run stops growing the conversation after the configured
               rows (stepsRows) and the tail stays where the eye
               already is. -->
          <div class="s-body" class:capped style:--steps-rows={stepsRows}
            use:stickBottom={capped ? b.events.length : 0}>
            {#each b.events as e, j (`${e.ts}-${j}`)}
              {@const ep = toolEventParts(e)}
              <div class="step">
                <!-- The tool NAME is the scannable half: its own colour by
                     what the tool does. toolEventParts splits the name off
                     legacy events that glued it onto the text — those were
                     the "still grey" rows. -->
                {#if ep.tool}<span class="tname" style:color={toolColor(ep.tool)}>{ep.tool}</span>{/if}
                <!-- The argument is the ONLY scrolling cell: the name and
                     the time are ordinary flex children BESIDE it, so the
                     panning text is clipped by this box and structurally
                     cannot show through them or slide past the lane's edge.
                     The sticky-column build could not guarantee that — a
                     sticky column covers its own box but not the lane
                     padding beside it, which is where the text bled through
                     (owner, 2026-08-20: "参数穿模到工具名左侧了"). -->
                <span class="st-scroll" tabindex="-1"><span class="st-text">{ep.text}</span></span>
                <span class="st-ts">{fmtTime(e.ts)}</span>
              </div>
            {/each}
          </div>
          {#if b.events.length > stepsRows}
            <!-- Outside the scroller on purpose: a control that scrolls
                 away is a control you cannot find. -->
            <button class="s-all" onclick={() => { stepsAll[b.key] = !stepsAll[b.key]; }}>
              {capped ? t('hubStepsAll').replace('{n}', String(b.events.length)) : t('hubStepsCap')}
            </button>
          {/if}
        {/if}
      </div>
  {/snippet}

  {#snippet unfold(key, folded)}
    <button class="m-unfold" onclick={(e) => { e.stopPropagation(); if (folded) expandMsg(key); else { const { [key]: _gone, ...rest } = expanded; expanded = rest; } }}>
      <span class="flip" class:on={!folded}><Icon name="chevron-down" size={11} /></span>{folded ? t('hubUnfold') : t('hubRefold')}
    </button>
  {/snippet}
  {#each blocks as b, i (blockKey(b, i))}
    <!-- A new calendar day gets a centred date pill before its first
         block — the times alone never said WHICH day a message was from
         (owner, 2026-08-20). Local-time days (sameDay), Today/Yesterday
         in the app's words. Not sticky: a pinned rect would fight the
         ask-anchor's edge math. -->
    {#if i === 0 || !sameDay(blocks[i - 1].ts, b.ts)}
      <div class="day-sep" aria-hidden="true"><span class="day-pill">{fmtDay(b.ts)}</span></div>
    {/if}
    {#if b.type === 'sys'}
      <!-- The app's own record (spawn/stop/restart, a /command typed into
           a pane). Consecutive lines still fold into ONE capsule — a stop
           plus its restart is one fact — and every line speaks ONE grammar:
           who it is about, what happened, the detail ("都用统一的 ui 来展示
           …agent 的名字，状态，或者发送的指令", owner 2026-08-24). The name
           wears the bubble header's ink, the action wears the status-note
           badge dialect (dot + word, sysVerbColor), and a /command's badge
           is the command itself in the composer's monospace — badge + args
           read back as exactly the line that was typed. Hidden entirely at
           the chat-only level (feedBlocks drops them). -->
      <div class="sysline" class:appear-rise={b.ts > openedAt}>
        {#each b.items as item, j (`${j}-${item}`)}
          {@const bl = boardLine(item)}
          {#if bl}
            <!-- A board move in the sys grammar's own atoms (board #13):
                 the issue number is the WHO, the destination status the
                 coloured badge (one progressive status language — review
                 is amber because it WAITS for a person), the title the
                 detail. The FROM stays visible because the transition is
                 the message: done → todo reads as a REOPEN. The row is a
                 BUTTON: tapping it jumps to that issue on the board page
                 (same route the header's layout icon takes). -->
            <button class="sys-item sys-jump" class:jump-hit={!!hitId && b.ids?.[j] === hitId} title={t('board')} data-msg={b.ids?.[j] || undefined}
              onclick={() => onboard(Number(bl.id))}>
              <span class="sys-who">#{bl.id}</span>
              <span class="sys-from">{t(`boardStatus_${bl.from}`)} →</span>
              <span class="sys-verb" style:color={boardStatusColor(bl.to)}><span class="sv-dot" aria-hidden="true"></span>{t(`boardStatus_${bl.to}`)}</span>
              {#if bl.title}<span class="sys-text">{bl.title}</span>{/if}
            </button>
          {:else}
          {@const p = sysParts(item)}
          {@const c = sysVerbColor(p.verb)}
          <div class="sys-item" class:jump-hit={!!hitId && b.ids?.[j] === hitId} data-msg={b.ids?.[j] || undefined}>
            {#if p.who}<span class="sys-who" style:--who-ink={agentHue(p.who)}>{p.who}</span>{/if}
            {#if p.verb}
              <span class="sys-verb" style:color={c}><span class="sv-dot" aria-hidden="true"></span>{p.verb}</span>
            {/if}
            {#if p.text}<span class="sys-text">{p.text}</span>{/if}
          </div>
          {/if}
        {/each}
      </div>
    {:else if b.type === 'msg'}
      {@const m = b.msg}
      <!-- An agent's note about its own work — a `tmm status` note or a
           `tmm done` summary. Only the MARKER is client-side: it is a message
           from the agent, so it wears exactly the same bubble as any other
           ("status 消息的样式要和普通消息一样就行", owner 2026-08-19). A
           second visual species for the same thing is what made it read as
           telemetry in the first place. -->
      {@const note = statusNote(m.body)}
      {@const quote = parseQuote(note ? note.text : m.body)}
      {@const parts = splitImages(quote ? quote.text : note ? note.text : m.body)}
        <!-- Every user message can become the landmark, but exactly ONE
             does. The real bubble enters with the feed, then that SAME
             element catches the edge as it is about to leave; there is no
             duplicate and no invisible midpoint swap. -->
        {@const key = blockKey(b, i)}
        {@const isAsk = m.from === 'human'}
        <!-- Folding is a property of the TEXT, and the DEFAULT for every
             long user message (owner, 2026-08-27: "默认用户消息都截断 不要
             显示太多"): the bubble renders a rear-truncated body until the
             reader unfolds it by hand. -->
        <!-- A sent /command folds like any long user message (owner,
             2026-09-28 16:35: one /goal filled the phone screen): its
             recipients and name stay, its arguments are cut, and the same
             unfold control shows them whole. -->
        {@const cmdFold = isAsk && b.command ? foldCmd(b.command) : null}
        <!-- Images are behind the fold too (board #372): a message with a
             picture folds like a long one and the picture opens with the same
             control, so scrolling to a message never changes its box. -->
        {@const foldable = isAsk && (b.command ? cmdFold !== null : foldBody(parts.text) !== parts.text || parts.images.length > 0)}
        {@const folded = foldable && !expanded[key]}
        <!-- An EXPANDED message is never pinned: sticky ignores the feed's
             scrolling, so a pinned screen-tall message had an unreachable
             bottom half (owner, 2026-08-27: "如果展开了消息 就要把钉住用户
             消息关掉 不然展开就没法上下滑动了" — which retired the held-scroll
             in-body scroller, 2026-08-20's answer to the same problem: the
             feed itself is the scroller now). It rejoins the anchor pool
             when folded again. -->
        {@const pinned = isAsk && askKey === key && !expanded[key]}
        <!-- A run of one sender (board #331): the header once, on the first
             bubble; the rest sit closer, headerless. Each bubble keeps its
             own time, actions, quote and jump anchor. -->
        {@const cont = continuesRun(blocks[i - 1], b)}
        <!-- A block that arrives after the room settled rises in
             (motion.md principle 10: transform/opacity only — the tail
             math measures nothing different). -->
        <div class="msg" class:me={m.from === 'human'} class:cont class:appear-rise={b.ts > openedAt}
          class:ask-top={pinned && askEdge === 'top'}
          class:ask-bottom={pinned && askEdge === 'bottom'}
          class:held={pinned && askHeld}
          class:jump-hit={!!hitId && String(m.id ?? '') === hitId}
          data-ask={isAsk ? key : undefined} data-msg={m.id ?? undefined}>
          <!-- Telegram-style bubble: agent name heads the bubble; the
               time — and on your own messages the delivery ring, right
               of it — is an inline trailer FLOATED at the end of the
               text, sharing the last line when it fits and dropping to
               its own right-aligned line when it doesn't. Never a
               separate row or column outside the bubble. -->
          <!-- The bubble is TEXT to assistive tech (role="button" made
               every message announce as one giant button and Tab walk
               the whole transcript); its click is a pointer convenience
               that reveals the action row BELOW the bubble — never a
               context-menu card (owner, 2026-09-07: "我只要消息气泡下边
               的这两个按钮，不要出现右键那种选项卡"). The contextmenu
               handler stays NATIVE: it only marks a touch-owned hold so
               the system's selection gesture and its compatibility
               click never open the row. The accessible path to the row
               is the meta-trailer button below. -->
          {#if m.from !== 'human' && !cont}
            <!-- The sender heads the bubble from OUTSIDE it (board #292,
                 owner 2026-10-01: "Agent 的名字在气泡外边…名字后面有灰色的
                 文字表示它是 runtime"): the name, then what it runs on in
                 meta ink — `runtimeLabel`, the roster hover's own line, so
                 a stopped or removed sender has none. A status note keeps
                 the ordinary bubble, but its header says what the words are
                 ABOUT. The first cut was `name → state`, and the arrow read
                 as an ADDRESSEE — "像是这个 Agent 给另外一个 working 的人发的"
                 (owner, 2026-08-20) — so the state is a BADGE in the app's
                 existing state-pill dialect (.pg-tag): a dot + the state
                 word in its own status colour, "entered this state". -->
            {@const runtime = runtimeLabel(agents.find((a) => a.managed && a.name === m.from))}
            <div class="m-head" style:--who-ink={agentHue(m.from)}><span class="m-who">{m.from}</span>{#if runtime}<span class="m-runtime">{runtime}</span>{/if}{#if note}<span class="m-note-state" style:color={noteStateColor(note.state)}><span class="mns-dot" aria-hidden="true"></span>{stateLabel(note.state)}</span>{/if}</div>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="bubble md"
            oncontextmenu={(e) => { msgSelectionClicks.mark(e, key); }}
            onauxclick={openPathRef}
            ondblclick={() => { if (pinned && askHeld) jumpHeld(key); }}
            onpointerup={(e) => { if (e.pointerType === 'mouse') return; if (heldDoubleTap.tap({ x: e.clientX, y: e.clientY, t: e.timeStamp }) && pinned && askHeld) { jumpClick = key; jumpHeld(key); } }}
            onpointercancel={() => heldDoubleTap.reset()}
            onclick={(e) => { if (jumpClick === key) { jumpClick = null; return; } if (openPathRef(e)) return; if (msgSelectionClicks.consume(key)) return; if (typeof getSelection === 'function' && !(getSelection()?.isCollapsed ?? true)) return; setMessageActions(msgOpen === key ? -1 : key); }}>
            {#if b.steps}{@render lane(b.steps, true)}{/if}
            <div class="m-body" lang={hanLang(m.body ?? '')}>
              <!-- A reply's quote (board #290): the bubble's own markdown
                   blockquote, the sender and time over the quoted line. -->
              {#if quote && rawOpen !== key}
                <blockquote class="m-quote"><span class="m-quote-who">{quote.from} · {quote.time}</span> {quote.excerpt}</blockquote>
              {/if}
              {#if b.command && rawOpen !== key}
                <!-- The command in the bubble's own atoms, as plain text (no
                     markdown: arguments are data): the recipients in the
                     mention dialect, the name in the rendered inline-
                     code dialect, the arguments wrapping in full. -->
                <p>{#each b.command.to as n, k (n)}<span class="m-to" style:--who-ink={agentHue(n)}>@{n}</span>{k < b.command.to.length - 1 ? ' ' : ''}{/each}{b.command.to.length ? ' ' : ''}<code>{b.command.name}</code>{#if b.command.args}{' '}{folded ? cmdFold : b.command.args}{/if}</p>
              {:else if parts.text}
                {#if rawOpen === key}
                  <pre class="raw">{m.body}</pre>
                {:else}
                  <!-- Folded: the start of the message, cut where the
                       budget runs out, …… glued to the last kept line.
                       Raw view and agent messages render in full. -->
                  {@html markMentions(renderMarkdown(folded ? foldBody(parts.text) : parts.text), managedNames)}
                {/if}
              {/if}
              <!-- One unfold control for a folded command and a folded text. -->
              {#if folded && parts.images.length}
                <!-- The picture is behind the fold; this line says it is
                     there (the Board card's `[Image]`). It is the same line
                     held or in flow, so the box never changes with the pin
                     (board #372, owner 2026-10-14: scrolled to, a folded
                     message stays folded). -->
                <div class="m-imgs">[{t('hubImage')}]{parts.images.length > 1 ? ` ×${parts.images.length}` : ''}</div>
              {/if}
              {#if foldable}{@render unfold(key, folded)}{/if}
              {#if parts.images.length && !folded}
                <!-- Inside the bubble (owner, 2026-08-26): part of the
                     message, clipped by the bubble's own radius. A human
                     message shows them once unfolded — and an unfolded one
                     is never pinned, so no held bubble hides or grows a strip. -->
                <div class="shots">
                  {#each parts.images as src, k (`${k}-${src}`)}
                    <ChatImage {src} alt={m.from} onview={onimage} />
                  {/each}
                </div>
              {/if}
              <button class="m-meta" aria-label={t('hubMsgActions')} aria-expanded={msgOpen === key}
                onclick={(e) => { e.stopPropagation(); setMessageActions(msgOpen === key ? -1 : key); }}>
                <span class="m-time">{fmtTime(m.ts)}</span>
                {#if m.from === 'human'}
                  <!-- Three readings, not two (review, 2026-09-03). Filled:
                       the agent's prompt hook echoed the line. Hollow does
                       not mean failed: a busy agent QUEUES the line and
                       accepts it when its turn ends. And a ROOM NOTE —
                       a body that addresses no managed agent — was typed
                       into nobody's pane, so a ring that promises to fill
                       in would wait for ever: it wears the recipient
                       picker's own dashed note-dot instead, the glyph that
                       already means "recorded, nobody interrupted". -->
                  {#if b.delivered}
                    <span class="m-state ok" title={t('hubDeliveredHint')}><Icon name="circle-check" size={11} /></span>
                  {:else if b.command || b.steered}
                    <!-- A /command carries no promise (board #264): most never
                         reach a prompt hook, so a hollow ring would wait for
                         ever. It gains the check only when its echo settles
                         it; otherwise just the time. A line steered into a
                         busy turn (#276) reads the same way: typed into the
                         running turn, no check to wait for. -->
                  {:else if !mentionedAgents(m.body ?? '', managedNames).length}
                    <span class="m-state note" title={t('hubNoteHint')}><i class="st note-dot"></i></span>
                  {:else}
                    <span class="m-state" title={t('hubPendingHint')}><Icon name="circle" size={11} /></span>
                  {/if}
                {/if}
              </button>
            </div>
          </div>
          {#if msgOpen === key}
            <div class="m-acts appear">
              <CommandButton iconOnly icon={messageActs.copied ? 'check' : 'copy'}
                label={messageActs.copied ? t('hubCopied') : t('hubCopy')} onclick={(event) => copyMsg(key, m.body, event.currentTarget)} />
              <CommandButton iconOnly icon="code" label={t('hubRaw')} pressed={rawOpen === key}
                onclick={() => { rawOpen = rawOpen === key ? '' : key; }} />
              {#if onreply && m.id}
                <CommandButton iconOnly icon="arc-left" label={t('hubReply')}
                  onclick={() => { setMessageActions(-1); onreply(m); }} />
              {/if}
            </div>
          {/if}
        </div>
    {:else if b.type === 'prompt'}
      <!-- The input half: what this agent was asked, which only the
           userPromptSubmit hook can tell us. -->
      {@const pp = promptParts(b.text)}
      {@const key = blockKey(b, i)}
      <!-- A long prompt folds its TEXT through the same budget as a user
           bubble and shows the same control (board #172, owner 2026-09-11
           "有消息没有渲染": a 601-char board notice stopped mid-sentence —
           `.p-body` had its own `max-height: 7.5em; overflow: hidden`, a
           second, SILENT fold that lied about what was delivered). -->
      {@const foldable = foldBody(pp.text) !== pp.text}
      {@const folded = foldable && !expanded[key]}
      <div class="prompt" class:appear-rise={b.ts > openedAt}>
        <!-- The machine stamp comes OFF (owner, 2026-08-30): the sender
             joins the head, and a board delivery wears the board
             dialect — issue chip (+ review/reply badge) — instead of raw
             log text. ONE badge for every tagged shape, coloured by
             boardStatusColor: review is a status and takes its colour,
             reply is not and takes the function's default reading ink
             (board #172 — no new colour, no per-shape markup). -->
        <div class="p-head"><span class="p-who">{windowName(b.window)}</span><span class="p-tag">{t('hubPromptIn')}</span>{#if pp.from}<span class="p-from">{pp.from}</span>{/if}<span>{fmtTime(b.ts)}</span></div>
        <div class="p-body">
          {#if pp.board}<span class="p-chip">#{pp.board.id}</span>{#if pp.board.tag}<span class="p-badge" style:color={boardStatusColor(pp.board.tag)}><span class="pb-dot" aria-hidden="true"></span>{pp.board.tag === 'review' ? t('boardStatus_review') : t('boardReply')}</span>{/if}{/if}{folded ? foldBody(pp.text) : pp.text}
        </div>
        {#if foldable}{@render unfold(key, folded)}{/if}
      </div>
    {:else if b.type === 'progress'}
      <!-- What the agent says it is doing (`tmm status <state> "note"`).
           Hooks can see that a turn is open, never what it is about, so
           this is the only account of work in progress — it reads as a
           line the agent spoke, not as a telemetry row, and a blocked or
           waiting note carries the colour of something that needs a
           human. -->
      <div class="prog" class:blocked={b.state === 'blocked' || b.state === 'waiting'} class:appear-rise={b.ts > openedAt}>
        <span class="pg-bar" aria-hidden="true"></span>
        <span class="pg-who">{windowName(b.window)}</span>
        {#if b.state && b.state !== 'working'}<span class="pg-tag">{stateLabel(b.state)}</span>{/if}
        <span class="pg-text">{b.text}</span>
        <span class="pg-ts">{fmtTime(b.ts)}</span>
      </div>
    {:else if b.type === 'note'}
      <div class="note" class:warn={b.event.kind === 'warn'} class:appear-rise={b.ts > openedAt}>
        {#if b.event.kind === 'warn'}<Icon name="info" size={11} />{/if}
        <span class="n-who">{windowName(b.window)}</span>
        <span class="n-text">{activityLabel(b.event)}</span>
        <span class="n-ts">{fmtTime(b.ts)}</span>
      </div>
    {:else}
      <!-- A run its reply has not (yet) ended wears the reply's own shape
           (board #298, owner 2026-10-03: "合并之前的渲染也应该是相类似的结构
           ……不要有差别"): the name + runtime head outside, the agent bubble,
           the same lane inside it — only the words are missing. -->
      {@const runtime = runtimeLabel(agents.find((a) => a.managed && a.name === b.window))}
      <div class="msg" class:appear-rise={b.ts > openedAt}>
        <div class="m-head" style:--who-ink={agentHue(b.window)}><span class="m-who">{windowName(b.window)}</span>{#if runtime}<span class="m-runtime">{runtime}</span>{/if}</div>
        <div class="bubble">{@render lane(b, false)}</div>
      </div>
    {/if}
  {/each}
  {#if !blocks.length && roomReady}
    {@render emptyFeed?.()}
  {/if}
</div>
{#if messageActs.error}
  <div class="message-feedback pop-layer" use:feedbackPosition={{ trigger: copyTrigger, bounds: feedEl, keepClear: copyTrigger?.closest('.msg')?.querySelector('.m-meta') }}>
    <OperationFeedback value={{ kind: 'error', message: messageActs.error }} ondismiss={() => setMessageActions(messageActs.open)} />
  </div>
{/if}
<!-- Parked away from the tail: one tap back, with a dot when something
     arrived while you were reading. -->
{#if !following || windowed}
  <button class="to-tail to-bottom" class:news={newBelow} title={windowed ? t('hubBackToLatest') : t('hubToBottom')} aria-label={windowed ? t('hubBackToLatest') : t('hubToBottom')} onclick={() => (windowed ? onlatest() : scrollToTail(true))}>
    <Icon name="arrow-down" size={16} />
  </button>
{/if}
</div>

<style>
  .message-feedback { position: fixed; z-index: 8; }
  /* Bottom padding tight against the composer: the capsule brings its own 8px
     (owner, 2026-08-21: "最后一个消息框，和发送框中间的高度也有点大"). */
  :global(.hub-root.compact) .feed { padding: 14px 10px max(6px, calc(var(--control-height) / 2)); gap: 9px; }
  :global(.hub-root.compact) .msg, :global(.hub-root.compact) .prompt { max-width: 91%; }

  :global(.hub-root.compact) .s-head { min-height: 34px; }
  .sk-feed { margin-top: auto; display: flex; flex-direction: column; gap: 10px; }
  /* The placeholders wear the real bubbles' corners: an incoming bubble hangs
     from its name since board #292, so its tight corner is top-left (#294). */
  .sk-msg { height: 44px; width: min(62%, 420px); border-radius: 6px 18px 18px 18px; align-self: flex-start; }
  .sk-msg.me { height: 34px; width: min(44%, 300px); border-radius: 18px 18px 6px 18px; align-self: flex-end; }

  /* Chat canvas: one quiet tone derived from the theme. It had two radial
     glows for "depth"; the accent one read as a faint blue shadow over the
     conversation and the owner asked for it gone — flat is calmer. */
  .feed-wrap { flex: 1; position: relative; display: flex; min-height: 0; background: var(--chat-canvas); }
  .feed {
    flex: 1; overflow-y: auto; padding: 18px clamp(18px, 4vw, 64px) 24px;
    display: flex; flex-direction: column; gap: 10px;
    /* THE reason a held bubble may change its own height. Chromium's scroll
       anchoring compensated `scrollTop` whenever the held bubble grew or shrank;
       that compensation moved the geometry the boundary test reads, which
       unheld it, which restored the height — the "一闪一闪" infinite blink
       (measured: assigning scrollTop 2261 landed on 2221↔2298). With anchoring
       off, a height change is just a height change. The feed follows its tail
       explicitly anyway (scrollFeed), so nothing here depended on it. */
    overflow-anchor: none;
  }
  /* Feed rows must NEVER flex-shrink. The feed always overflows, and a column
     flex container compresses shrinkable children before scrolling; children
     with `overflow: visible` are saved by their min-content height, but any
     row with `overflow: hidden` has a spec minimum of ZERO — the sysline was
     crushed to its padding (10px of 23px) and read as an empty little bar
     (owner report, measured live). One rule retires the whole bug class. */
  .feed > :global(*) { flex: none; }
  /* The active anchor is the message itself. It enters and moves with the feed;
     only when that SAME element reaches an edge does sticky hold it there. */
  .msg.ask-top { position: sticky; top: 0; z-index: 6; }
  .msg.ask-bottom { position: sticky; bottom: 0; z-index: 6; }
  /* Floating treatment begins only after the bubble is actually held. Normal
     and held use the SAME opaque surface, so catching the edge changes depth,
     never identity or colour.

     A held bubble shows ALL of itself. It used to be clipped to a 33px window
     — one line — which turned every multi-line question into a single truncated
     line at the edge (owner, 2026-08-19: "保留原始样式完整显示就好，不用截断").
     What replaced it is nothing at all: no clip, no transform, no drawn frame.
     That is also the safest possible change here, because the ONE hazard in
     this feature is layout, not paint. The first version collapsed the bubble
     with max-height, which changed its flow height; the browser's scroll
     anchoring compensated scrollTop, that flipped the boundary condition back,
     and the anchor blinked in an infinite feedback loop (measured: setting
     scrollTop=2261 landed on 2221↔2298). So a cap is not available even as a
     safety net: any max-height on `.held` brings the loop back, and a generous
     clip window would be truncation again. The bubble is as tall as the message
     — a deliberately long question held at an edge covers more of the feed, and
     that is the trade the owner asked for.

     Depth is the only thing `.held` adds: a lifted shadow, paint-only, so a
     bubble overlapping the scrolling content below it reads as floating rather
     than as a rendering glitch. No backdrop blur (board #302): it sat on the
     SQUARE .msg box while the opaque bubble is rounded, so it was visible only
     in the corners outside the bubble's curve, as a grey smear behind them. */
  /* NOTHING is clipped or capped here. The bubble keeps its whole box — border,
     radius, padding, meta trailer — and stays as tall as the text it is showing;
     what shrinks is the TEXT, folded by elideTail before it is rendered (owner,
     2026-08-19: "我希望是消息内容自己内部折叠 不是框截断 … 气泡什么的都要完整的不要
     任何裁切"). A cap or a clip would cut the bubble itself, which is exactly the
     thing that read as broken in the two earlier attempts. */
  .msg.held .bubble { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28); }
  /* Back to the tail: the LOOK is the shared .to-tail in app.css (board #49
     unified it with the Terminal's) — only the feed placement lives here. */
  .to-bottom { right: 14px; bottom: 12px; z-index: 7; }
  .msg { position: relative; display: flex; flex-direction: column; max-width: var(--msg-max); }
  /* A run's later bubbles (board #331) sit 4px under the one before instead
     of the feed's 10px (9px compact) gap: one speaker, one block. */
  .msg.cont { margin-top: -6px; }
  :global(.hub-root.compact) .msg.cont { margin-top: -5px; }
  /* The centre's jump landed here (board #322): one accent ring that fades
     out on the shared tempo — no new keyframe, no layout change. */
  .msg, .sys-item { transition: box-shadow var(--t-move) ease; }
  .jump-hit { box-shadow: 0 0 0 2px var(--accent-ink); border-radius: var(--ui-radius-control); }
  /* Both sides hug their content (default column-flex STRETCH made every
     agent bubble 76% wide, leaving a short line's inline time stranded at
     the far right). */
  .msg { align-self: flex-start; }
  .msg.me { align-self: flex-end; }
  /* iOS-style CONTINUOUS corners live in app.css (the app-wide
     `corner-shape: squircle` policy block): svelte-check's CSS service does
     not know the property yet and the house bar is zero warnings. */
  .bubble {
    position: relative;
    background: var(--bubble-in); border: 1px solid var(--bubble-line);
    border-radius: 6px 18px 18px 18px; padding: 8px 12px 9px;
    color: var(--text); font-size: var(--fs-body); line-height: 1.48;
    word-break: break-word; overflow-wrap: anywhere; cursor: text;
    box-shadow: 0 1px 2px rgba(0,0,0,0.10);
    transition: border-color var(--t-fast) ease, box-shadow var(--t-fast) ease;
    -webkit-tap-highlight-color: transparent;
  }
  .bubble:hover { border-color: var(--input-border); }
  .msg.me .bubble {
    background: var(--bubble-out); border-color: color-mix(in srgb, var(--accent) 18%, transparent);
    border-radius: 18px 18px 6px 18px;
  }
  /* Agent name heads the bubble (your own carries none — the right-aligned
     accent bubble already says "yours"). */
  /* Agent name heads the bubble (your own carries none — the right-aligned
     accent bubble already says "yours"). A flex row so the status badge can
     sit at the bubble's TOP-RIGHT ("放到这个消息的右侧 往右上角放", owner
     2026-08-20) while the name keeps the left edge. */
  /* Since board #292 it sits OUTSIDE the bubble, over its top-left corner,
     inset by the bubble's own text padding so name and words share one left
     edge. A name's ink is ONE variable, --who-ink, set per name by
     `agentHue` (hub.ts) wherever a name shows — header, sysline who, the
     @mention — and --accent where no name sets it (a board issue number). */
  .feed { --who-ink: var(--accent); }
  .m-head {
    display: flex; align-items: baseline; gap: 8px; min-width: 0;
    padding: 0 12px; margin: 0 0 4px; line-height: 1.2; user-select: none;
  }
  .m-head .m-who {
    flex: none; font-family: var(--font-display);
    color: var(--who-ink); font-weight: 650; font-size: var(--fs-ui); letter-spacing: 0.1px;
  }
  /* What it runs on: meta ink, mono (it is data), the line's one part that
     gives way on a narrow phone. */
  .m-head .m-runtime {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--text3);
  }
  /* The status-note header's state BADGE: the .pg-tag pill dialect (micro,
     uppercase, bordered) plus a leading dot, coloured by noteStateColor via
     inline `color` — border and dot follow through currentColor. A pill with
     a dot reads as a state the agent ENTERED; the first cut's arrow read as
     an addressee (owner, 2026-08-20). Pushed to the row's right edge. */
  /* A reply's quote rides the bubble's own .md blockquote (board #290); its
     head is the meta ink, like the time. */
  .m-quote-who { color: var(--text3); font-size: var(--fs-meta); }
  .m-head .m-note-state {
    display: inline-flex; align-items: center; gap: 4px;
    margin-left: auto; padding: 0 5px; border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 55%, transparent);
    font-size: var(--fs-micro); font-weight: 650;
    text-transform: uppercase; letter-spacing: 0.6px; line-height: 1.6;
  }
  .m-head .mns-dot {
    width: 5px; height: 5px; border-radius: 50%; flex: none;
    background: currentColor;
  }
  /* The Telegram inline trailer: time (+ delivery ring on your own messages,
     to its right) FLOATS at the end of the content. On the last line when it
     fits, its own right-aligned line when it doesn't — never a separate
     row/column. Two pieces make it work with rendered markdown: the last
     content element (when it is a <p>) turns inline so the float can share
     its line box, and .m-body is flow-root so the bubble's height contains
     the float. The 7px top margin bottoms the 10px trailer within the
     ~20px line box. Selectable ON PURPOSE (board #48): the app shell's
     global user-select:none would otherwise reach the message text, and the
     phone's long-press-to-select — which the bubble's contextmenu handler
     now yields to — would have nothing to grab. Head and meta already opt
     out: a drag that starts on the words must not smear into chrome. */
  .m-body { min-width: 0; display: flow-root; user-select: text; -webkit-user-select: text; }
  .m-body > :global(p:nth-last-child(2)) { display: inline; }
  /* The leading @recipient — the address — reads apart from the words
     without shouting: weight and a quiet accent lean, no chip, no box. */
  .m-body :global(.m-to) { font-weight: 600; color: color-mix(in srgb, var(--who-ink) 62%, var(--text)); }
  .m-body :global(.katex-display) { overflow-x: auto; overflow-y: hidden; margin: 8px 0; padding: 2px 0; }
  .m-body :global(.katex) { font-size: 1.06em; }
  /* A real <button>: the accessible route to the copy/raw row (the bubble
     itself is text). Styled to stay a quiet trailer. */
  .m-meta {
    float: right; display: inline-flex; align-items: center; gap: 3px;
    margin: 7px 0 0 8px; color: var(--meta-ink); font-size: var(--fs-meta); line-height: 1;
    user-select: none; background: none; border: none; padding: 0;
    font-family: inherit; cursor: pointer;
  }
  /* "Show the rest": a quiet inline control inside the bubble, not a chip on
     top of it — the bubble is complete, this is part of its content. */
  .m-unfold {
    display: inline-flex; align-items: center; gap: 4px; margin-top: 4px;
    background: none; border: none; padding: 2px 0; cursor: pointer;
    color: var(--accent); font-family: inherit; font-size: var(--fs-sub);
  }
  .m-unfold:hover { text-decoration: underline; text-underline-offset: 2px; }
  .m-unfold :global(svg) { flex: none; }
  .m-state { display: inline-flex; opacity: 0.55; }
  .m-state.ok { color: var(--status-ok); opacity: 1; }
  /* The room-note mark is the picker's .note-dot at the ring's size — one
     glyph for "reaches nobody live", wherever it shows. */
  .m-state.note .st { width: 9px; height: 9px; }
  .m-time { font-variant-numeric: tabular-nums; }
  .bubble .raw { margin: 0; font-family: var(--font-mono); font-size: var(--fs-sub); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text2); }
  /* What you can DO with a message, revealed by tapping it: the action row
     (.m-acts) is a SHARED atom in app.css since board #46 — the Board's note
     bubbles wear the same row, and a scoped copy here is the dialect drift
     the source tests forbid. */
  /* Referenced images, under the text they came with. */
  .shots { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; border-radius: var(--ui-radius-control); overflow: hidden; clear: both; }
  .m-body > .shots:first-child { margin-top: 2px; }
  /* The folded picture's marker: one quiet line, the same held or in flow. */
  .m-imgs { margin-top: 4px; color: var(--text2); font-size: var(--fs-sub); }
  /* Lifecycle lines are the app narrating real actions (an agent stopped, a
     /command typed into a pane) — reading ink and body-adjacent size, not fine
     print the reader has to squint at ("不要只用灰色小字，让我看不太清", owner
     2026-08-20). Still a centred capsule: it is narration, not a speaker. One
     ROW per line inside it, because a folded group joined by `·` read as one
     run-on string (owner, 2026-08-24). */
  .sysline {
    align-self: center; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    max-width: min(92%, 620px); padding: 5px 12px; border-radius: var(--ui-radius-row);
    color: var(--text2); background: color-mix(in srgb, var(--bubble-in) 88%, transparent);
    border: 1px solid var(--border2); box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    font-size: var(--fs-sub);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  }
  .sysline .sys-item { display: flex; align-items: baseline; gap: 6px; max-width: 100%; min-width: 0; }
  /* The three atoms of a narrated line, each in a dialect the feed already
     speaks (owner, 2026-08-24: "都用统一的 ui 来展示…不要随意瞎写"):
     the NAME wears the bubble header's ink (.m-head — 650-weight accent), the
     ACTION wears the status-note badge (.m-note-state — dot + word in a
     currentColor pill, coloured by the one progressive status language). A
     sent /command is not a capsule: it is the person's own bubble (#264). */
  .sysline .sys-who { flex: none; font-weight: 650; color: var(--who-ink); letter-spacing: 0.1px; }
  .sysline .sys-verb {
    flex: none; display: inline-flex; align-items: center; gap: 4px;
    font-size: var(--fs-micro); font-weight: 650;
    text-transform: uppercase; letter-spacing: 0.6px; line-height: 1.6;
  }
  .sysline .sys-verb .sv-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: currentColor; }
  .sysline .sys-text {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text);
  }
  /* A board move's origin status: quiet reading ink — the destination badge
     carries the colour, the origin only situates the transition. */
  .sysline .sys-from { flex: none; font-size: var(--fs-micro); color: var(--text3); }
  /* The board row is tappable: bare button in the row-hover family (surface2
     wash, no border — it is a row, not a control), inheriting the capsule's
     type. */
  .sysline .sys-jump {
    background: none; border: none; font: inherit; color: inherit;
    padding: 1px 5px; margin: -1px -5px; border-radius: 6px;
    cursor: pointer; text-align: left;
    transition: background var(--t-fast);
  }
  .sysline .sys-jump:hover { background: var(--surface2); }

  /* The feed's date separators: a centred pill in the sysline's capsule
     dialect, marking where a new calendar day starts. */
  .day-sep { align-self: center; display: flex; justify-content: center; padding: 6px 0 2px; user-select: none; }
  .day-pill {
    font-size: var(--fs-meta); font-weight: 600; letter-spacing: 0.3px;
    color: var(--text2); background: color-mix(in srgb, var(--bubble-in) 88%, transparent);
    border: 1px solid var(--border2); border-radius: 999px; padding: 2px 11px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  }

  /* The input half of a turn — what the agent was asked. */
  /* The delivered line's atoms (owner, 2026-08-30): the sender in the name
     ink, the issue chip in the sys-who mono dialect, the review badge in the
     status-badge dialect — the same vocabulary the sysline speaks. */
  .prompt .p-from { color: var(--accent); font-weight: 650; }
  .prompt .p-chip { font-family: var(--font-mono); color: var(--accent); font-weight: 650; margin-right: 6px; }
  .prompt .p-badge {
    display: inline-flex; align-items: center; gap: 4px; margin-right: 6px;
    font-size: var(--fs-micro); font-weight: 650;
    text-transform: uppercase; letter-spacing: 0.6px;
  }
  .prompt .p-badge .pb-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: currentColor; }

  .prompt { align-self: flex-start; max-width: var(--msg-max); border-left: 2px solid var(--border); padding-left: 9px; margin: 1px 6px; }
  .p-head { display: flex; align-items: baseline; gap: 7px; font-size: var(--fs-meta); color: var(--text3); margin-bottom: 2px; }
  .p-head .p-who { font-family: var(--font-mono); font-weight: 600; color: var(--text2); }
  .p-tag { text-transform: uppercase; letter-spacing: 0.8px; font-size: var(--fs-micro); color: var(--text3); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
  .p-body { font-size: var(--fs-ui); color: var(--text2); white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }

  /* A single observed fact: status declaration, lifecycle hook, warning. */
  .note {
    display: flex; align-items: baseline; gap: 8px; width: var(--msg-max);
    font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text3);
    padding: 1px 8px; max-width: 100%;
  }
  .note .n-who { flex: none; font-weight: 600; }
  .note .n-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .note .n-ts { flex: none; margin-left: auto; opacity: 0.6; }
  .note.warn { color: var(--status-warn); }
  .note.warn :global(svg) { flex: none; align-self: center; }

  /* A progress note: what the agent SAYS it is doing. Between a bubble and a
     telemetry row on purpose — it is prose the agent chose to write, so it gets
     the reading font and full-strength ink, but it is about work rather than
     addressed to anyone, so it wears a lane bar instead of a bubble. */
  .prog {
    display: flex; align-items: baseline; gap: 8px; width: 100%; max-width: 100%;
    font-size: var(--fs-sub); color: var(--text2);
    padding: 3px 10px 3px 0; position: relative;
  }
  .pg-bar {
    flex: none; align-self: stretch; width: 2px; min-height: 1em;
    background: var(--accent); opacity: 0.55; border-radius: 2px; margin-right: 2px;
  }
  .pg-who { flex: none; font-family: var(--font-mono); font-weight: 650; color: var(--text3); }
  .pg-tag {
    flex: none; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--status-warn); border: 1px solid var(--status-warn); border-radius: 4px; padding: 0 3px;
  }
  .pg-text { min-width: 0; overflow-wrap: break-word; }
  .pg-ts { flex: none; margin-left: auto; font-size: var(--fs-meta); color: var(--meta-ink); font-variant-numeric: tabular-nums; }
  /* Waiting on a human is not the same colour as making progress. */
  .prog.blocked .pg-bar { background: var(--status-warn); opacity: 0.9; }
  .prog.blocked .pg-text { color: var(--text); }

  /* Collapsible run of tool calls between two replies. */
  /* One card inside an agent bubble, wherever the run lives (#295 inside its
     reply, #298 on its own): the head owns no border of its own, the body is
     separated by a line rather than indented with a margin+border guide (that
     guide made the left edge jog when the group opened). */
  .steps {
    display: flex; flex-direction: column; margin: 2px 0 6px; cursor: default;
    /* The lane's painted colour as one value: the feed canvas underneath, the
       same 3% wash on top. Nothing needs to COVER anything since the middle cell
       became the only scroller, but the token stays — it is the lane's colour,
       and the next thing that must match it should have one name to reach for. */
    --lane-bg: linear-gradient(var(--surface), var(--surface)), var(--chat-canvas);
    /* 30px = the head's padding (10) + chevron (12) + gap (7): every row, the
       pinned name column and the "show all" button line up under the head's TEXT,
       which is the column the eye follows. ONE number, on the element they all
       inherit from — a second copy is how the column and the rows drift apart. */
    --lane-indent: 30px; --lane-pad-r: 10px;
    background: var(--lane-bg); border: 1px solid var(--border2); border-radius: var(--ui-radius-panel);
    overflow: hidden;
  }
  /* With no words under it (#298) the lane is the bubble's whole content. */
  .steps:last-child { margin-bottom: 2px; }
  /* An OPEN run needs the lane's width, not the reply's: the bubble grows to
     the message cap while it is open, and the rows pan inside it as usual. */
  .msg:has(.steps.open) { width: var(--msg-max); }
  .s-head {
    display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
    background: none; border: none; border-radius: 0;
    padding: 5px 10px; cursor: pointer; color: var(--text3);
    font-family: var(--font-mono); font-size: var(--fs-sub);
    transition: color var(--t-fast);
  }
  .steps:hover { border-color: var(--input-border); }
  .s-head:hover { color: var(--text2); }
  /* .chev / .chev.open are the app.css turning-glyph atom (design-language §1 Micro-motion). */
  /* A run in motion pulses in the MOTION colour (the accent — see the status
     colour language in hub.ts): green would say "ended well" about something
     still going. The pulse itself is the app-wide `.live-dot` cue in app.css
     (halo + breathe, never an opacity fade — that fade is what made a running
     dot read dimmer than a resting one), worn alongside this class. */
  .s-live { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .s-count { flex: none; }
  .s-peek { min-width: 0; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s-body {
    display: flex; flex-direction: column; gap: 2px;
    padding: 5px var(--lane-pad-r) 6px var(--lane-indent);
    border-top: 1px solid var(--border2);
    /* One em == one step row's font size, so the cap below is expressed in ROWS
       and follows the type scale instead of a magic pixel height. */
    font-size: var(--fs-sub);
    /* The ARGUMENT is the interesting half of a tool call and it is routinely
       wider than the lane — a path, a command, a heredoc. It used to be cut with
       an ellipsis, so the one thing you opened the lane to read was the one thing
       you could not (owner, 2026-08-20: "这些参数应该左右可以滑动，查看完整的参
       数"). Each row's MIDDLE CELL pans instead — see .st-scroll: the lane itself
       never scrolls horizontally, which is what makes bleed-through impossible. */
    overflow-x: hidden;
  }
  /* Ten rows, then scroll. Each step is exactly one line (rows never wrap), so
     rows and lines are the same thing here.
     overscroll-behavior stays AUTO on purpose: when the pointer/finger is over
     this inner scroller and it reaches its top or bottom, the scroll must
     CHAIN to the feed — `contain` trapped the gesture and the page "stuck"
     the moment you scrolled across a tool group (owner, 2026-08-21: "手势点在
     工具调用框框，就卡住了滚不上去了"). The feed itself never flings from
     this: chaining only starts at the lane's edge, which is exactly the owner's
     rule ("小窗口到顶，就继续滚外部的消息框"). */
  .s-body.capped {
    max-height: calc(var(--steps-rows) * (1.5em + 2px) + 11px);
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .s-all {
    align-self: flex-start; background: none; border: none; color: var(--text3);
    font-size: var(--fs-meta); cursor: pointer; font-family: var(--font-mono);
    padding: 2px var(--lane-pad-r) 5px var(--lane-indent);
  }
  .s-all:hover { color: var(--accent); }
  .step {
    display: flex; align-items: baseline; gap: 8px; line-height: 1.5;
    font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text3);
  }
  /* The tool name: the part the eye scans down a column. A plain flex child —
     it sits OUTSIDE the scroller, so the argument cannot be panned under it. */
  .tname { flex: none; color: var(--accent); font-weight: 650; }
  .step .tname { min-width: 6.5em; max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.hub-root.compact) .step .tname { min-width: 0; }
  .s-peek .tname { min-width: 0; margin-right: 5px; }
  /* The middle column, and the ONLY scroller. It takes the leftover width, clips
     its own overflow, and pans on wheel/touch — so the full argument is reachable
     ("中间参数是可以左右滑动查看的") while the name and the time never move. Its
     scrollbar is hidden: ten rows each drawing one is a ruler collection, and the
     cut-off text itself is the affordance. */
  .step .st-scroll { flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .step .st-scroll::-webkit-scrollbar { display: none; }
  /* No ellipsis: what does not fit is scrolled to, not cut. Still `nowrap`, NOT
     `pre`: a tool detail routinely contains real newlines (a heredoc, a multi-line
     command), and `pre` would turn one call into a three-line row — breaking both
     one-row-per-call and the 10-row cap, whose height is single-line math. */
  .step .st-text { display: inline-block; white-space: nowrap; color: var(--text2); }
  /* The right column: a plain flex child after the scroller, always at the lane's
     right edge no matter how far the argument is panned. */
  .step .st-ts { flex: none; opacity: 0.55; }

  /* Paging feedback: a whisper at the very top of the scrollback, never a
     component — it shares the sys-line grey and costs one line. */
  .older-hint { text-align: center; color: var(--text3); font-size: var(--fs-micro); padding: 2px 0 6px; }
  .older-more { display: block; width: 100%; background: none; border: none; cursor: pointer; transition: color var(--t-fast); }
  .older-more:hover { color: var(--accent); }
</style>
