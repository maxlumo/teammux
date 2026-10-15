// Source-contract tests for Terminal.svelte (see docs/conventions/testing.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./Terminal.svelte', import.meta.url), 'utf8');

test('copy and connection feedback have separate shared lifetimes and one unframed placement (#167)', () => {
  assert.match(source, /import OperationFeedback from '\.\.\/ui\/OperationFeedback\.svelte';/u);
  assert.match(source, /import \{ createFeedbackLifetime \} from '\.\.\/ui\/feedback-lifetime\.ts';/u);
  for (const slot of ['copy', 'connection']) {
    assert.match(source, new RegExp(`const ${slot}FeedbackLifetime = createFeedbackLifetime\\(value => \\{ ${slot}Feedback = value; \\}\\);`, 'u'));
    assert.match(source, new RegExp(`${slot}FeedbackLifetime\\.dispose\\(\\)`, 'u'));
  }
  assert.match(source, /<OperationFeedback value=\{connectionFeedback\} ondismiss=\{connectionFeedbackLifetime\.clear\}/u);
  assert.match(source, /<OperationFeedback value=\{copyFeedback\} ondismiss=\{copyFeedback\?\.kind === 'error' \? copyFeedbackLifetime\.clear : undefined\}/u,
    'Copied is passive: an auto-expiring success must not create a temporary Close target');
  assert.doesNotMatch(source, /toastMsg|showToast|\.toast\s*\{/u, 'the replaced timer and private paint are removed whole');
  const placement = /\.terminal-feedback \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(placement, /display: flex;[\s\S]*flex-direction: column;/u);
  assert.doesNotMatch(placement, /background:|border:|border-radius:|color:|font-size:/u, 'caller positions only; shared component owns chrome');
});

test('copy captures identity before await and only success clears the same selection (#167)', () => {
  const copy = /copySelection = async \(\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1] ?? '';
  const [before, after] = copy.split('await copyText(text)');
  assert.ok(before && after, 'the real clipboard await separates capture from completion');
  for (const binding of ['copiedTerm = term', 'copiedSelection = selection', 'copiedTarget = target', 'copiedSession = session']) {
    assert.ok(before.includes(binding), binding);
  }
  assert.match(before, /const token = copyFeedbackLifetime\.begin\(\);/u);
  assert.match(after, /!copyFeedbackLifetime\.current\(token\)/u);
  for (const guard of ['term !== copiedTerm', 'selection !== copiedSelection', 'target !== copiedTarget', 'session !== copiedSession', '!visible']) {
    assert.ok(after.includes(guard), guard);
  }
  assert.match(after, /document\.visibilityState !== 'visible'/u);
  assert.match(after, /kind: ok \? 'success' : 'error'/u);
  assert.match(after, /if \(ok\) clearSelection\(\);/u, 'failed copy retains selection and its retry command');
});

test('feedback invalidates on context and teardown; only the second send failure publishes (#167)', () => {
  assert.match(source, /\$effect\(\(\) => \{\s*target; session; visible; termGen;\s*untrack\(clearTerminalFeedback\);/u);
  const hide = source.slice(source.indexOf('const onVisible ='), source.indexOf('const generation = ++resumeGeneration;'));
  assert.match(hide, /clearTerminalFeedback\(\);/u);
  assert.match(source, /return \(\) => \{\s*responseFilter\.reset\(\);\s*clearTerminalFeedback\(\);/u);
  const fail = /function noteSendFailure\(label\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(fail, /sendFailCount === 2/u);
  assert.match(fail, /kind: 'error', message: t\('connectionUnstable'\)/u);
  assert.doesNotMatch(fail, /setTimeout|vibrate|Notification|Audio/u);
  const success = /function noteSendSuccess\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(success, /connectionFeedbackLifetime\.clear\(\);/u);
  assert.doesNotMatch(success, /copyFeedback/u, 'send completion cannot dismiss copy feedback');
});

test('full snapshots use one queued frame without an out-of-band clear (#109)', () => {
  assert.match(source, /import \{ writeTerminalFrame \} from '\.\/terminal-frame\.ts';/u);
  assert.match(source, /writeTerminalFrame\(term, body \+ padAft/u, 'the existing frame body/cursor pipeline uses the tested writer');
  assert.doesNotMatch(source, /term\.(?:clear|reset)\(\)/u, 'no synchronous scroll-to-zero event can trigger another rewrite');
  const writer = source.slice(source.indexOf('writeTerminalFrame(term,'), source.indexOf('// xterm.js setup + subscription'));
  assert.match(writer, /termAtBottom = term\.buffer\.active\.viewportY >= term\.buffer\.active\.baseY;\s*if \(termAtBottom\) hasNewContent = false;/u,
    'completion publishes the final tail state even when a history-free frame emits no scroll event');
  // These gates are deliberately unchanged: reading history defers output,
  // hidden terminals only record it, and showing one replays through the same
  // frame path. The existing resumeLiveTail tests pin every input path.
  assert.match(source, /if \(!visible\) \{\s*if \(content != null\) lastContent = content;\s*return;\s*\}/u);
  assert.match(source, /if \(!visible\) \{ wasVisible = false; return; \}/u);
  assert.match(source, /if \(termAtBottom\) writeToXterm\(content, lastCursor\);\s*else hasNewContent = true;/u);
  assert.match(source, /class="to-tail scroll-btn" class:news=\{hasNewContent\}/u, 'new output still uses the one to-tail control');
});

test('DA/DSR filtering carries across onData callbacks and belongs to one xterm instance (#108)', () => {
  const setup = source.indexOf('const responseFilter = createTerminalResponseFilter();');
  assert.ok(setup > source.indexOf('term = new Terminal('), 'the filter is instance-local, not shared across split panes');
  assert.ok(setup < source.indexOf('term.onData('), 'one carry survives all callbacks for this terminal');
  assert.match(source, /term\.onData\(data => \{\s*data = responseFilter\.push\(data, isPasting\);\s*if \(!data\) return;/u,
    'every non-paste chunk reaches the stateful filter before forwarding');
  assert.match(source, /return \(\) => \{\s*responseFilter\.reset\(\);/u, 'pending bytes never survive pane teardown');
  // The actual Escape key is claimed in hardware capture and bypasses onData,
  // so waiting on a fragmented ESC prefix must not delay a user's Escape.
  assert.match(source, /!event\.isComposing && event\.key === 'Escape'/u);
  const hardware = /const onHardwareKeydown = \(event\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1] ?? '';
  assert.match(hardware, /const data = bareEsc \? '\\x1b' : encodeTerminalShortcut\(event\);/u);
  assert.match(hardware, /enqueueKeys\(data, true\);/u);
});

test('bare Escape is CLAIMED in capture and encoded by hand; no focus guards (board #20, closed)', () => {
  // The hardware-capture handler claims the bare key exactly like the
  // Ctrl/Alt combos, so the \x1b send never depends on whose keydown runs
  // first; mid-IME Escape stays with the composition.
  assert.match(source, /!event\.isComposing && event\.key === 'Escape'/u, 'claimed in onHardwareKeydown');
  assert.match(source, /&& !event\.ctrlKey && !event\.altKey && !event\.metaKey/u, 'bare only — combos keep their encoder');
  // "Esc 让当前框失去焦点" (2026-08-26 … 09-03) was chased through three rounds
  // of blur guards and one native (objc2) patch before the owner traced it to
  // a browser EXTENSION blurring inputs on Esc. All of it is gone (owner:
  // "避免我们过度修复了"); this pins the absence so it does not creep back.
  assert.doesNotMatch(source, /lastEscAt|onEscBlur|onEscKeydown|escGuardTa|hasFocus\(\)/u, 'no Escape focus guard');
  assert.match(source, /BROWSER EXTENSION/u, 'the cause is recorded where the next reader looks');
});

test('the retired unread-notification dots stay retired (2026-09-01)', () => {
  // The old per-window attention dots (unread inbox) were replaced by the
  // project room's auto-post + read cursor and the derived status dots.
  assert.doesNotMatch(source, /agent-notifications\.svelte/u);
  assert.doesNotMatch(source, /NotificationForWindow\(|ham-dot/u);
});

test('the keyboard is an overlay for agent TUIs, not a resize', () => {
  // The costly chain is: keyboard shrinks the viewport → the terminal box
  // shrinks → cols×rows change → tmux resizes the window → a full-screen agent
  // repaints its whole conversation. Pinning the box breaks it at step two.
  assert.match(
    source,
    /const keepRowsOnKeyboard = \$derived\(isMobile && !!agentByBackend\(liveAgent\)\)/u,
    'the whitelist must be the shared agent table, not a hardcoded name',
  );
  // …and the verdict is the server's (board #260): the pushed pane `agent`,
  // reset on a target switch — never a client-side match over a command.
  assert.match(source, /if \(currentCommand !== undefined\) \{\s*liveAgent = agent \?\? null;/u);
  assert.match(source, /\$effect\(\(\) => \{ void target; liveAgent = null; \}\);/u);
  assert.match(
    source,
    /<div class="xterm-wrap" class:keep-rows=\{keepRowsOnKeyboard\}/u,
  );
  // Pinned height + bottom anchor: the element keeps its size and the keyboard
  // covers its top rows.
  assert.match(
    source,
    /:global\(html\.keyboard-open\) \.xterm-wrap\.keep-rows \{[^}]*height: var\(--kb-locked-h, 100%\)/u,
  );
  assert.match(
    source,
    /:global\(html\.keyboard-open\) \.xterm-wrap\.keep-rows \{[^}]*bottom: 0/u,
  );
});

test('the pinned height is captured only while the keyboard is down', () => {
  // Capturing it with the keyboard up would pin the SHRUNK height, which is the
  // bug rather than the fix.
  const body = /function doResize\(\{ assert = false \} = \{\}\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1];
  assert.ok(body, 'doResize must exist');
  assert.match(
    body,
    /if \(!document\.documentElement\.classList\.contains\('keyboard-open'\)\) \{\s*termEl\.style\.setProperty\('--kb-locked-h'/u,
  );
});

test('the keyboard-shift handler still never resizes', () => {
  // Sizing has ONE trigger, the ResizeObserver
  // (docs/design-docs/pages/terminal-sizing.md). The overlay works by keeping
  // the observed box constant, so this handler must stay out of sizing.
  const body = /const onKbShift = \(e\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1];
  assert.ok(body, 'onKbShift must exist');
  assert.doesNotMatch(body, /term\.resize\(|queuePaneResize\(|doResize\(/u);
});

test('every key send returns the display to the live tail', () => {
  // Rendering is suppressed by a pinned selection, an unsettled touch scroll
  // and a scrolled-up viewport. If input does not release them, the typed
  // characters never appear: the server does not re-send a frame it already
  // delivered, so the screen stays frozen on the pre-input snapshot.
  assert.match(
    source,
    /function enqueueKeys\([^)]*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*resumeLiveTailRef\?\.\(\)/u,
  );
  // Paste is input too and bypasses enqueueKeys (it goes to paste_text).
  assert.match(source, /isPasting = false;\s*(?:\/\/[^\n]*\n\s*)*resumeLiveTail\(\)/u);
});

test('resumeLiveTail releases every render-suppressing state', () => {
  const body = /function resumeLiveTail\(\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1];
  assert.ok(body, 'resumeLiveTail must exist');
  assert.match(body, /if \(selection\) clearSelection\(\);/u);
  assert.match(body, /!gestures\.isCoasting\(\)/u);
  assert.match(body, /gestures\.stopMomentum\(\);/u); // a coast re-parks the viewport otherwise
  assert.ok(body.indexOf('clearSelection();') < body.indexOf('gestures.stopMomentum();'));
  assert.match(body, /clearTimeout\(endTouchScrollTimer\);\s*endTouchScrollTimer = null;/u);
  assert.match(body, /touchScrolling = false;/u);
  assert.match(body, /termAtBottom = true;/u);
  assert.match(body, /writeToXterm\(lastContent, lastCursor\)/u);
});

test('unlockKeyboard settles the touch-scroll pin instead of cancelling it', () => {
  const body = /function unlockKeyboard\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1];
  assert.ok(body, 'unlockKeyboard must exist');
  // clearTimeout(endTouchScrollTimer) here dropped the ONLY pending reset of
  // `touchScrolling`, freezing every later frame.
  assert.doesNotMatch(body, /clearTimeout\(endTouchScrollTimer\)/u);
  assert.match(body, /resumeLiveTailRef\?\.\(\)/u);
});

test('the win-bar IS the page head, and carries a title on the desktop', () => {
  // ui-unification.md "Page skeleton": one header dialect app-wide. The bar
  // had the geometry copied into its own rule and no <h1> at all, so Terminal
  // was the one page with a headerless head (owner, 2026-08-19).
  assert.match(source, /<div class="win-bar page-head">/u);
  // Geometry/border/h1 come from the shared class — not re-declared here.
  const rule = /\n  \.win-bar \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.doesNotMatch(rule, /min-height/u);
  assert.doesNotMatch(rule, /border-bottom/u);
  // The strip must not wrap: the phone page-head rule wraps head actions.
  assert.match(rule, /flex-wrap: nowrap/u);

  // Three roles, one branch: a split cell keeps a chip (its own pane picker),
  // a phone keeps a chip (it opens the session sheet), the desktop shows the
  // page title because the sidebar is already on screen beside it.
  const branch = /\{#if embedded\}([\s\S]*?)\{:else\}([\s\S]*?)\{\/if\}/u.exec(source);
  assert.ok(branch, 'the identity branch must exist');
  assert.match(branch[0], /\{:else if onOpenSessions\}/u);
  assert.match(branch[0], /\{@render nameStack\(\)\}/u, 'the page title is the head\'s one Name + tag stack');
  // A cell's chip opens the picker; it must not fall through to a null call.
  assert.match(branch[1] ?? '', /showPanePicker = !showPanePicker/u);
});

test('collapsing the switcher hides the chips, not the desktop page head', () => {
  // The collapsed state is the DEFAULT (tmux_winswitcher unset), so dropping
  // the bar entirely made a fresh desktop install the only page in the app
  // with no header (measured 2026-08-19: no .win-bar, xterm at top 0).
  assert.match(source, /\{#if isMobile\}\s*<div class="win-collapsed-anchor appear">/u);
  const desktopCollapsed = /\{:else\}\s*<div class="win-bar page-head">[\s\S]*?<\/div>/u.exec(source)?.[0] ?? '';
  assert.match(desktopCollapsed, /\{@render nameStack\(\)\}/u);
  assert.match(desktopCollapsed, /chevron="left"/u, 'the chip stays the expand control');
  assert.match(desktopCollapsed, /tmux_winswitcher', '1'/u);
});

test('the phone bar leads with hamburger + name, chips unchanged (board #19)', () => {
  // Chat and Board's lead-in ("三个横线 + 项目名", owner 2026-08-30): the
  // hamburger opens the session drawer, the h1 names the session, and the
  // window chips after it keep their quick-switch behavior.
  const bar = source.slice(source.indexOf('{:else if onOpenSessions}'), source.indexOf('{:else}', source.indexOf('{:else if onOpenSessions}')));
  assert.match(bar, /class="icon-btn ham"[\s\S]{0,120}?onOpenSessions\(\)/u, 'the hamburger opens the drawer');
  assert.match(bar, /<Icon name="menu"/u, 'three lines, like Chat and Board');
  assert.match(bar, /\{@render nameStack\(\)\}/u, 'the name is the title');
  assert.ok(!bar.includes('<AgentChip'), 'the session chip is retired from the lead-in');
  // The window chips keep their switch handler.
  assert.match(source, /onSwitchPane\(`\$\{w\.session\}:\$\{w\.window\}\.\$\{w\.pane\}`\);/u,
    'chip quick-switch untouched');
});

test('the title never stretches the bar apart — chips follow the name (owner, 2026-08-30)', () => {
  // The phone's shared `.page-head h1 { flex: 1 1 auto }` (app.css) grows
  // titles on other pages; on the win-bar it shoved the chips to the far
  // right. The scoped win-title opts out.
  assert.match(source, /\.win-title \{ max-width: 22ch; flex: 0 1 auto; \}/u,
    'content-sized title — the chips strip takes the leftover space');
});

test('the head names its server the way Chat and Board do: ONE Name + tag stack, rendered at the three places the page names itself, no flat h1 + tag pair (board #390)', async () => {
  // Owner, multi-server mode: the tag sat to the RIGHT of the project name and was drawn very
  // large. It was a bare <ServerTag> next to the <h1> in a flex row: a child component's span is
  // not reached by this page's scoped `.win-bar.tab-strip > :not(.win-bar-scroll) { align-self:
  // center }`, so in the tab strip it stretched to the strip's whole height (34px against its own
  // 14px, measured), and nothing ever put it UNDER the name. The fix is not a second rule: it is
  // the Hub's and the Board's stack — app.css `.title-stack` / `.name-line` + ui/title-fit.ts.
  assert.doesNotMatch(source, /<\/h1>\s*<ServerTag/u, 'no flat <h1><ServerTag> sibling pair: the tag lives in the stack');
  const snippet = /\{#snippet nameStack\(\)\}([\s\S]*?)\{\/snippet\}/u.exec(source)?.[1] ?? '';
  assert.match(snippet, /<div class="title-stack" class:stacked=\{stackedHead\} use:titleFit=\{\{ active: !stackedHead, key: `\$\{session\}\|\$\{scope\?\.tag \?\? ''\}` \}\}>\s*<div class="name-line"><h1 class="win-title" title=\{session\}>\{session\}<\/h1><\/div>\s*<ServerTag name=\{scope\?\.tag\} \/>\s*<\/div>/u,
    'the stack: a name line with the h1, then the tag — the markup Hub and Board wear');
  assert.equal((source.match(/\{@render nameStack\(\)\}/gu) ?? []).length, 3, 'the phone lead-in, the desktop title and the collapsed desktop head all render it');
  assert.match(source, /import \{ titleFit \} from '\.\.\/ui\/title-fit\.ts';/u);
  // The stack's mode is the Hub's rule: stacked unconditionally on a phone / a narrow viewport,
  // and the fit action decides otherwise.
  assert.match(source, /const stackedHead = \$derived\(!!onOpenSessions \|\| narrowVp\);/u);
  // The atom is app.css's: this page keeps no private copy of it, and no paint for the tag.
  const style = /<style>([\s\S]*)<\/style>/u.exec(source)?.[1] ?? '';
  assert.doesNotMatch(style, /title-stack|name-line|server-tag/u, 'the stack and the tag are not re-declared here');
  // One markup across the three pages that name a project/session beside a server tag.
  const hub = await readFile(new URL('../hub/Hub.svelte', import.meta.url), 'utf8');
  const board = await readFile(new URL('../hub/Board.svelte', import.meta.url), 'utf8');
  const shape = (text: string) => /<div class="title-stack" class:stacked=\{[^}]+\} use:titleFit=\{\{[\s\S]*?\}\}>\s*<div class="name-line">[\s\S]*?<\/div>\s*(?:\{#if !renaming\})?<ServerTag name=\{scope\?\.tag\} \/>/u.test(text);
  assert.deepEqual([shape(hub), shape(board), shape(snippet)], [true, true, true], 'Chat, Board and Terminal wear the same stack');
});

test('a font, theme or active change is a live option update, never an xterm rebuild (review 2026-09-03)', () => {
  // The lifecycle effect owns dispose → new Terminal → resubscribe → capture
  // → WebGL init → kbLocked. Its ONLY dependency is `target`: the body runs
  // under untrack so the font size/family, line height, theme and `active`
  // it reads synchronously cannot re-trigger it. Before this, a system
  // light/dark auto-switch mid-sentence on the phone rebuilt the terminal
  // and dropped the keyboard.
  assert.match(source, /import \{ untrack \} from 'svelte';/u);
  assert.match(
    source,
    /\$effect\(\(\) => \{\s*target;\s*return untrack\(\(\) => \{/u,
    'the lifecycle effect reads target, then untracks its whole body',
  );
  // The live effects must read their reactive inputs BEFORE any `!term`
  // early return: `term` is a plain let, so an effect that returned first
  // tracked nothing and never ran again (both were dead before this test).
  assert.match(
    source,
    /\$effect\(\(\) => \{\s*termGen;\s*const t = getTermTheme\(\);\s*if \(!term\) return;/u,
    'theme effect: termGen + theme are read, then the instance guard',
  );
  assert.match(
    source,
    /\$effect\(\(\) => \{\s*termGen;\s*const size = fontSize;\s*const family = fonts\.stack;[^\n]*\n\s*const lh = terminalPrefs\.lineHeight;\s*if \(!term\) return;/u,
    'font effect: termGen + fontSize + fonts.stack + lineHeight are read, then the instance guard',
  );
  // The handle those effects wait on is bumped once per build, inside the
  // lifecycle effect, after the instance is complete.
  assert.match(source, /let termGen = \$state\(0\);/u);
  assert.match(source, /termGen\+\+;\s*subscribe\(target\);/u, 'bumped right before the pane is subscribed');
});

test('kbLocked has exactly two writers: unlockKeyboard() and lockKeyboard()', () => {
  // terminal-keyboard.md: `endTouchScroll` and other delayed timers must never
  // lock — a timer racing a fresh unlock is how the keyboard vanished under
  // the user's finger. Every lock site (pane switch, blur timer, keyboard-shift
  // close transition, the bar's close key) goes through the one function so the
  // list of callers is greppable.
  const writes = [...source.matchAll(/^\s*kbLocked = (true|false);/gmu)].map(m => m[1]);
  assert.deepEqual(writes.sort(), ['false', 'true'], 'one lock write and one unlock write');
  assert.match(source, /function lockKeyboard\(\) \{\s*kbLocked = true;\s*\}/u);
  assert.match(/function unlockKeyboard\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '', /kbLocked = false;/u);
  // The known callers, each labelled at the call site.
  for (const label of ['pane switch', 'blur timer', 'keyboard-shift', 'close key']) {
    assert.match(source, new RegExp(`lockKeyboard\\(\\); // ${label}`, 'u'), `caller "${label}" labelled`);
  }
});

test('double-tap is the ONE terminal-area gesture that opens the keyboard (review 2026-09-03)', () => {
  // #148 moves pairing/preventDefault into the executed controller tests.
  // Root still owns the synchronous keyboard command and listener options.
  assert.match(source, /openFromDoubleTap\(\) \{\s*unlockKeyboard\(\); \/\/ double-tap/u);
  assert.doesNotMatch(source, /createDoubleTapDetector|doubleTap\.tap/u);
  assert.match(source, /addEventListener\('touchend', onTouchEnd, \{ passive: false \}\)/u, 'preventDefault needs a non-passive touchend');
  // unlockKeyboard() has exactly one caller, labelled (#296 removed the bar's open key).
  const calls = [...source.matchAll(/unlockKeyboard\(\);(?: \/\/ ([^\n]*))?/gu)].map(m => m[1] ?? '');
  assert.deepEqual(calls, ['double-tap']);
  // endTouchScroll stays out of the keyboard entirely.
  const ets = /function endTouchScroll\(\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.ok(ets, 'endTouchScroll must exist');
  assert.doesNotMatch(ets, /kbLocked|lockKeyboard|unlockKeyboard/u);
});

test('the bar\'s last slot is Enter while the keyboard is down and Close while it is up (#296)', () => {
  // Owner 2026-10-02: double-tap already opens the keyboard, so the slot that
  // used to open it sends Enter instead. Both keys are in the markup and
  // `html.keyboard-open` — the class derived from the real IME height —
  // shows exactly one, so the key under the finger is the key on screen and a
  // tap while the IME is still up (even mid-close) can never send Enter.
  const slot = /<div class="shortcuts">((?:(?!<div class="shortcuts">)[\s\S])*?)<\/div>\s*<\/div>\s*<\/div>\s*\{:else\}/u.exec(source)?.[1] ?? '';
  assert.ok(slot, 'second shortcut row must exist');
  assert.match(slot, /<button class="kb-enter" tabindex="-1" aria-label="Enter" ontouchstart=\{\(\) => pressKey\('Enter'\)\}><span><Icon name="corner-down-left"/u,
    'Enter fires once through pressKey, not startRepeat');
  assert.match(slot, /<button class="kb-close" tabindex="-1" aria-label="Close keyboard" onpointerdown=[\s\S]*?lockKeyboard\(\); \/\/ close key\s*ta\.blur\(\);[\s\S]*?<Icon name="keyboard"/u);
  assert.doesNotMatch(source, /startRepeat\('Enter'\)|kb-toggle/u, 'no repeating Enter and no toggle left behind');
  // One press path: startRepeat = pressKey + the long-press timers.
  assert.match(source, /function pressKey\(key\) \{\s*ctrlOneShot\.disarm\(\);[^\n]*\n\s*navigator\.vibrate\?\.\(8\);[^\n]*\n\s*sendSpecial\(key\);\s*\}\s*function startRepeat\(key\) \{\s*pressKey\(key\);\s*repeatTimer = setTimeout/u);
  // The class decides visibility; the close key keeps the accent it had.
  assert.match(source, /\.shortcuts \.kb-close \{ display: none; \}\s*:global\(html\.keyboard-open\) \.shortcuts \.kb-enter \{ display: none; \}\s*:global\(html\.keyboard-open\) \.shortcuts \.kb-close \{\s*display: flex;\s*background: var\(--accent-bg\);/u);
});

test('the Ctrl one-shot lives in terminal-keyboard.ts; ctrlArmed is only its mirror (review 2026-09-03)', () => {
  // The armed modifier used to be a bare boolean toggled in four places and
  // never expired: a letter typed minutes after tapping Ctrl still became a
  // control character. Arming, consumption and the 4 s expiry are one object
  // now, so the template flag has exactly one writer — the onChange mirror.
  assert.match(source, /import \{[^}]*\bcreateOneShotCtrl\b[^}]*\} from '\.\/terminal-keyboard\.ts';/u);
  assert.match(source, /const ctrlOneShot = createOneShotCtrl\(\{ onChange: \(armed\) => \{ ctrlArmed = armed; \} \}\);/u);
  const writes = [...source.matchAll(/ctrlArmed = ([^;]+);/gu)].map(m => m[1]);
  assert.deepEqual(writes, ['$state(false)', 'armed'], 'the declaration and the mirror — no direct ctrlArmed writes');
  // Both typed-input paths route through apply(): the capture-phase insertText
  // forwarder and onData (after the paste branch has returned).
  assert.match(source, /enqueueKeys\(ctrlOneShot\.apply\(e\.data\), true\);/u);
  assert.match(source, /enqueueKeys\(ctrlOneShot\.apply\(data\), true\);/u);
  // The release sites are labelled like the lock sites.
  for (const label of ['pane switch', 'blur']) {
    assert.match(source, new RegExp(`ctrlOneShot\\.disarm\\(\\); // ${label}`, 'u'), `release "${label}" labelled`);
  }
  // The armed state is visible on the bar and drops with the expiry.
  assert.match(source, /<button class="modifier" class:active=\{ctrlArmed\} aria-pressed=\{ctrlArmed\}/u);
});

// #139: characterize the existing boundaries before extracting the gesture
// decisions. These protect wiring, not Android touch/IME or measured geometry.
test('mobile inputmode stays text while the keyboard lock gates focus (#139)', () => {
  assert.match(source, /kbTa\.setAttribute\('inputmode', 'text'\);/u);
  assert.doesNotMatch(source, /setAttribute\('inputmode', 'none'\)/u,
    'the old none/text toggle broke the first Android InputConnection');
  const focus = source.slice(source.indexOf('onTaFocus = () =>'), source.indexOf("kbTa.addEventListener('focus'"));
  assert.match(focus, /if \(kbLocked\) \{[\s\S]*?kbTa\.blur\(\);\s*return;/u);
});

test('touch listeners keep stable controller refs, passive options and Root ownership (#139, #148)', () => {
  // Priority is executed in terminal-gestures.test.ts, not duplicated here.
  assert.match(source, /const \{ onTouchStart, onTouchMove, onTouchEnd, onTouchCancel \} = gestures;/u);
  for (const [event, handler, passive] of [
    ['touchstart', 'onTouchStart', true], ['touchmove', 'onTouchMove', false],
    ['touchend', 'onTouchEnd', false], ['touchcancel', 'onTouchCancel', true],
  ] as const) {
    assert.ok(source.includes(`termEl.addEventListener('${event}', ${handler}, { passive: ${passive} });`));
    assert.ok(source.includes(`termEl.removeEventListener('${event}', ${handler});`));
  }
});

test('selection uses inclusive buffer endpoints and cannot release its rendering pin (#139)', () => {
  const apply = /function applySelectionToXterm\(\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(apply, /isApplyingSelection = true;/u);
  // #140 moves arithmetic into the canonical model; retain the boundary guard
  // and side effects here, with numeric vectors owned by selection-model.test.
  assert.match(apply, /if \(!selection\) \{ term\.clearSelection\(\); return; \}/u);
  assert.match(apply, /const len = selLength\(selection, term\.cols\);\s*term\.select\(a\.col, a\.row, len\);/u);
  assert.match(apply, /finally \{\s*isApplyingSelection = false;/u);
  const adopt = source.slice(source.indexOf('const onSelChange ='), source.indexOf('let followedTailBeforeHide'));
  assert.match(adopt, /if \(isApplyingSelection\) return;/u);
  assert.match(adopt, /if \(!pos\) return;\s*selection = selFromExclusive\(pos\);/u,
    'the model owns the unchanged end.x=0 clamp; absent native selection stays a boundary no-op');
  const end = /function endTouchScroll\(\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(end, /if \(selection\) return;\s*touchScrolling = false;/u);
  assert.match(adopt, /if \(gestures\.isIdle\(\)\) \{\s*touchScrolling = false;/u);
  const clear = /\n    clearSelection = \(\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1] ?? '';
  assert.match(clear, /if \(gestures\.isIdle\(\)\) \{\s*touchScrolling = false;/u);
});

test('endpoint grab fixes the far endpoint and compensates both coordinates (#139)', () => {
  const grab = /function beginEndpointDrag\(which\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(grab, /if \(!selection\) return;\s*selection = selForDrag\(selection, which\);/u);
  assert.match(source, /selection = \{ anchor: selection\.anchor, head: \{ row: bufRow, col \} \};/u);
  assert.match(source, /return handleGrabOffset\(cx, cy, ep, term\.buffer\.active\.viewportY, r, cell\);/u);
  // #148 controller tests execute grab-before-pin and two-axis compensation.
  // #141 gives numeric capsule/overlap boundaries unit vectors in geometry.
  assert.match(source, /return hitSelectionHandle\(clientX, clientY, rect, selection, selUI\);/u);
  assert.match(source, /\.sel-handle \{[^}]*width: 0; height: 0;/u,
    'the CSS anchor is not the old 44px hit wrapper');
  assert.match(source, /\.sel-handle::after \{[^}]*width: 12px;\s*height: 12px;/u);
});

test('range and word decisions use the existing canonical selection model (#140)', () => {
  assert.match(source, /import \{[^}]*selContains[^}]*wordBounds \} from '\.\/selection-model\.ts';/u);
  assert.match(source, /function isInsideSelection\(bufRow, col\) \{\s*return selContains\(selection, bufRow, col\);\s*\}/u);
  assert.match(source, /const line = term\.buffer\.active\.getLine\(bufRow\);\s*return wordBounds\(line\?\.translateToString\(false\), col\);/u);
});

test('geometry adapters read the live rectangle and the single cellSize source (#141)', () => {
  const cell = /function touchToCell\(clientX, clientY\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(cell, /const rect = termEl\.getBoundingClientRect\(\);\s*const cell = cellSize\(term\);\s*return pointToCell\(clientX, clientY, rect, cell, term\.cols, term\.rows\);/u);
  const drag = /function applyHandleDragAt\(px, py\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(drag, /const rect = termEl\.getBoundingClientRect\(\);\s*const \{ w: cellW \} = cellSize\(term\);/u);
  assert.match(drag, /const cell = touchToCell\(px, py\);\s*const col = snapHandleColumn\(x, cell\.col, rect\.width, cellW, term\.cols, SCROLLBAR_TOUCH_WIDTH\);/u);
  assert.match(drag, /const row = term\.buffer\.active\.viewportY \+ cell\.row;\s*moveHead\(row, col\);/u);
  const view = /function recomputeSelUI\(\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(view, /if \(!selection \|\| !term \|\| !termEl\) \{ selectionLayout = null; return; \}/u);
  assert.match(view, /const \{ w: cellW, h: cellH \} = cellSize\(term\);\s*if \(!cellW \|\| !cellH\) \{ selectionLayout = null; return; \}/u);
  assert.match(view, /const rect = termEl\.getBoundingClientRect\(\);\s*selectionLayout = \{\s*cell: \{ w: cellW, h: cellH \},\s*viewport: \{ top, rows, cols, width: rect\.width, height: termEl\.parentElement\.clientHeight \},/u);
  const hit = /function hitHandle\(clientX, clientY\) \{([\s\S]*?)\n    \}/u.exec(source)?.[1] ?? '';
  assert.match(hit, /if \(!selection \|\| !selUI \|\| !termEl\) return null;\s*const rect = termEl\.getBoundingClientRect\(\);\s*return hitSelectionHandle/u);
});

test('Copy placement uses its measured border-box height and the actual clipping container (#143)', () => {
  // offsetHeight includes the toolbar border and excludes CSS zoom/transforms.
  // Binding updates rederive only geometry; no new resize or gesture callback.
  assert.match(source, /bind:offsetHeight=\{selToolbarHeight\}/u);
  assert.match(source, /style:visibility=\{selToolbarHeight > 0 \? 'visible' : 'hidden'\}/u,
    'an unmeasured first frame must not paint at the old clipped anchor');
  assert.match(source, /const selUI = \$derived\(selection && selectionLayout\s*\? selectionView\(selection, selectionLayout\.cell, selectionLayout\.viewport, selToolbarHeight\) : null\);/u);
  assert.equal([...source.matchAll(/selectionView\(/gu)].length, 1, 'one owner for projection and flip/clamp');
});

test('one lifecycle factory receives six deferred environment operations (#148)', () => {
  assert.match(source, /import \{ createTerminalGestures \} from '\.\/terminal-gestures\.ts';/u);
  assert.equal([...source.matchAll(/createTerminalGestures\(/gu)].length, 1);
  const factory = source.indexOf('const gestures = createTerminalGestures(');
  assert.ok(factory > source.indexOf('term = new Terminal('));
  assert.ok(factory < source.indexOf("termEl.addEventListener('touchstart'"));
  assert.match(source, /createTerminalGestures\(gestureHost, \{\s*now: \(\) => Date\.now\(\),\s*setDelay: \(callback, ms\) => window\.setTimeout\(callback, ms\),\s*clearDelay: \(id\) => window\.clearTimeout\(id\),\s*requestFrame: \(callback\) => window\.requestAnimationFrame\(callback\),\s*cancelFrame: \(id\) => window\.cancelAnimationFrame\(id\),\s*vibrate: \(ms\) => \{ navigator\.vibrate\?\.\(ms\); \},\s*\}\);/u);
  assert.doesNotMatch(source, /let touchId|let touchMode|let velocitySamples|let edgeScrollId|const stopMomentum/u,
    'the controller state and scheduling have no second owner');
});

test('visibility reset and the two cleanup slots preserve Root render/keyboard ordering (#148)', () => {
  const visible = source.slice(source.indexOf('const onVisible ='), source.indexOf("document.addEventListener('visibilitychange'"));
  assert.match(visible, /touchScrolling = false;\s*gestures\.resetAfterVisibility\(\);/u);
  assert.ok(visible.indexOf('gestures.resetAfterVisibility();') < visible.indexOf('if (selection) clearSelection();'));
  assert.doesNotMatch(visible, /gestures\.onTouchCancel|gestures\.cancelHold/u);
  assert.match(source, /clearTimeout\(endTouchScrollTimer\);\s*gestures\.cancelHold\(\);\s*clearTimeout\(kbBlurTimer\);\s*if \(kbTa && onTaBlur\) kbTa\.removeEventListener\('blur', onTaBlur\);\s*if \(kbTa && onTaFocus\) kbTa\.removeEventListener\('focus', onTaFocus\);\s*gestures\.dispose\(\);/u);
  assert.match(source, /function scheduleEndTouchScroll\(ms\) \{\s*clearTimeout\(endTouchScrollTimer\);\s*endTouchScrollTimer = setTimeout\(endTouchScroll, ms\);/u,
    'the shared render-release timer never moves into the gesture controller');
});

test('the gesture Root port has exactly eighteen inert operations and live queries (#148)', () => {
  const file = ts.createSourceFile('Terminal.js', source.slice(source.indexOf('<script>') + 8, source.indexOf('</script>')),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let port: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'gestureHost'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) port = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(port);
  assert.deepEqual(port.properties.map(p => p.name!.getText(file)).sort(), [
    'available', 'hasSelection', 'isPinned', 'pinUpdates', 'requestRenderRelease', 'hitHandle',
    'grabHandle', 'dragHeadAt', 'extendHeadAt', 'tryWordSelection', 'clearSelectionOutside',
    'isScrollbarPoint', 'scrollPosition', 'dragScrollbar', 'lineHeight', 'edgeBounds',
    'scrollLines', 'openFromDoubleTap',
  ].sort());
  for (const property of port.properties) {
    assert.ok(ts.isMethodDeclaration(property) || ts.isShorthandPropertyAssignment(property)
      || (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isIdentifier(property.initializer))),
    'building the port must not invoke a Root operation');
    if (['available', 'hasSelection', 'isPinned'].includes(property.name!.getText(file))) {
      assert.ok(ts.isPropertyAssignment(property) && ts.isArrowFunction(property.initializer), 'query state on use, not at construction');
    }
  }
});

test('input never retargets: each queued key carries its pane; the paste fallback keeps the pasted pane (board #190)', () => {
  // The queue is the tested module; Terminal only adds resumeLiveTail and the pane.
  assert.match(source, /const keyQueue = createKeyQueue\(/u);
  assert.match(source, /keyQueue\.enqueue\(pane, keys, literal\)/u);
  assert.match(source, /keyQueue\.reset\(\); \/\/ queued keys belong to the previous pane/u);
  // The defect: the -32601 catch ran after a round trip and read the LIVE target.
  assert.doesNotMatch(source, /-32601\) \{ enqueueKeys\(data, true\); return; \}/u, 'the fallback must not read the live target after the await');
  assert.match(source, /pasteOrFallback\(target, data, \{/u, 'the pasted pane is captured at the call');
  // Feedback is the pane's on screen: an outcome for a pane the user left is muted (codex's reset-boundary repro).
  assert.match(source, /const forThisPane = \(pane, note\) => \{ if \(pane === target\) note\(\); \};/u);
  assert.match(source, /onSuccess: \(pane\) => forThisPane\(pane, noteSendSuccess\),\s*onFailure: \(pane\) => forThisPane\(pane, \(\) => noteSendFailure\('key'\)\),/u);
  assert.match(source, /onFailure: \(kind, pane\) => forThisPane\(pane, \(\) => noteSendFailure\(kind\)\),/u);
});

test('a terminal that becomes visible re-asserts its pane size, even when its own dims did not change (board #198)', () => {
  // Owner 2026-09-14: "从 terminal 的右侧边栏点击 扩展到 terminal 面板后，画面的尺寸不对，
  // 应该加一次窗口尺寸的设置到新的尺寸". Two instances show one pane (the Hub
  // drawer's, the page's in its hidden layer); each sends resizePane only from
  // its ResizeObserver when fit != dims. Maximize: the drawer had sized tmux to
  // its box; the page's box never changed, so nothing was sent and tmux kept
  // the drawer's cols×rows.
  assert.match(source, /function doResize\(\{ assert = false \} = \{\}\)/u);
  assert.match(source, /if \(fit\.cols === term\.cols && fit\.rows === term\.rows\) \{\s*\n\s*if \(assert\) queuePaneResize\(fit\.cols, fit\.rows\);/u,
    'same dims: the size is still SENT when asserting');
  assert.match(source, /wasVisible = true;\s*\n(?:\s*\/\/[^\n]*\n)*\s*doResizeRef\?\.\(\{ assert: true \}\);\s*\n\s*if \(!term \|\| lastContent == null\) return;/u,
    'the visible effect asserts before it replays the frame');
});

test('a hidden terminal neither sizes nor paints the pane it shares, and a reply outlives no pane (board #395)', () => {
  // The behaviour is driven in Terminal.shared.mount.test.ts; here the gates
  // are pinned where they live, so a refactor cannot move one silently.
  assert.match(source, /--kb-locked-h[^\n]*\n\s*\}\n\s*if \(!visible\) return;\n\s*const fit = calcFit\(\);/u,
    'doResize returns before measuring a fit while hidden');
  assert.match(source, /resizeSendTimer = setTimeout\(\(\) => \{\s*\n\s*resizeSendTimer = 0;\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!visible\) return;\s*\n\s*resizePane\(target, pendingCols, pendingRows\)/u,
    'the SEND re-checks that the terminal is shown (review P1-a)');
  assert.match(source, /\$effect\(\(\) => \{ if \(!visible\) cancelPaneResizeRef\?\.\(\); \}\);/u,
    'hiding withdraws a size not yet sent');
  assert.match(source, /cancelPaneResizeRef = \(\) => \{\s*\n\s*clearTimeout\(resizeSendTimer\);\s*\n\s*resizeSendTimer = 0;\s*\n\s*pendingCols = 0; pendingRows = 0; pendingResizeTs = 0;/u,
    'withdrawn with its pending echo state');
  assert.match(source, /const onReconnected = [\s\S]*?if \(term && visible\) \{\s*\n\s*const fit = calcFit\(\);/u,
    'a reconnect re-sends the size of a shown terminal only');
  assert.match(source, /function _writeToXtermNow\(content, cursor\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!term \|\| touchScrolling \|\| !visible\) return;/u,
    'the ONE draw gate: a hidden terminal records, it never draws');
  // Every capture reply checks the lifetime it was asked in (review P1-b).
  const captures = [...source.matchAll(/capturePane\(target\)\.then\(r => \{\s*\n\s*if \(!alive\b/gu)].length;
  assert.equal(captures, [...source.matchAll(/capturePane\(target\)\.then/gu)].length, 'every capture reply is bound to its pane s lifetime');
  assert.ok(captures >= 3, 'the first capture, the resume capture and the reconnect capture');
  assert.match(source, /return \(\) => \{\s*\n\s*responseFilter\.reset\(\);\s*\n\s*clearTerminalFeedback\(\);\s*\n\s*alive = false;/u, 'the lifetime ends in the cleanup');
});

// #365 (owner 2026-10-14: "Terminal 上方的 Tab 栏和 Chat 上方的 Tab 栏，样式需要做得
// 更加一致一些"; orchestrator ruling: the Terminal adopts the Chat tab grammar).
test('the window strip wears the ONE tab strip atom the Chat roster wears, and paints no tab of its own (#365)', async () => {
  const roster = await readFile(new URL('../hub/Roster.svelte', import.meta.url), 'utf8');
  const appCss = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  for (const [name, src] of [['Terminal', source], ['Roster', roster]] as const) {
    assert.match(src, /import \{ tabShape \} from '\.\.\/ui\/tab-shape\.ts';/u, `${name}: the one outline`);
    assert.match(src, /class="[^"]*\btab-strip\b/u, `${name}: the strip frame`);
    assert.match(src, /class="[^"]*\btab-group\b[^"]*"[^>]*use:slideIndicator=/u, `${name}: the destinations group carries the one marker`);
    assert.match(src, /class="[^"]*\bstrip-tab\b/u, `${name}: tabs are .strip-tab`);
    assert.match(src, /<span class="slide-pill tab"[^>]*aria-hidden="true">\s*<span class="tab-shape" use:tabShape><svg><path class="tab-fill" \/><path class="tab-edge" \/><\/svg><\/span>/u, `${name}: the travelling marker`);
    const css = src.slice(src.indexOf('<style>'));
    assert.doesNotMatch(css, /\n\s*\.(?:tab-strip|strip-tab|slide-pill\.tab|tab-shape|tab-fill|tab-edge)(?:::before)?\s*\{/u, `${name}: no local copy of the atom s rules`);
  }
  assert.match(appCss, /\.tab-group:not\(\.all-lit\) \.strip-tab:not\(\.sel\):not\(\.off\) \{ color: var\(--text2\); \}/u, 'the dim-inactive rule is the atom s');
  assert.match(source, /<div class="win-bar page-head tab-strip">/u, 'the expanded bar is the strip');
  // The marker moves only when slideIndicator re-measures, and it re-measures
  // on a KEY change (a pick changes no layout a ResizeObserver would see).
  // jsdom has no layout, so the mount test cannot see a frozen marker; this
  // pin can: the key is the current window AND the window list (add/close).
  assert.match(source, /use:slideIndicator=\{\{ key: winMarkerKey, active: '\.strip-tab\.sel' \}\}/u, 'the group re-measures on its key');
  assert.match(source, /const winMarkerKey = \$derived\(\[currentWindow, windows\.map\(\(w\) => w\.window\)\.join\(','\)\]\.join\('\|'\)\);/u,
    'the key changes with the current window and with every added or closed window');
  assert.match(source, /\.win-bar\.tab-strip \{\s*--tab-fill: var\(--bg\); --tab-line: var\(--border\);/u, 'the lit window opens into the terminal (the page --bg), the floor line is the head border it replaces');
  const scroll = source.slice(source.indexOf('<div class="win-bar-scroll'), source.indexOf('<div class="win-split">'));
  assert.ok(scroll.length > 0 && /class="strip-tab win-tab"/u.test(scroll), 'the strip region is found');
  assert.doesNotMatch(scroll, /<AgentChip/u, 'AgentChip leaves the window strip whole');
  assert.doesNotMatch(source, /\.win-chip\b/u, 'its flip wrapper went with it');
});

test('the window tab LABEL wears the Chat tab s type, and the scrolled strip fades its clipped edges (#365 review: the ruling, validator P3 1 and 4)', async () => {
  // ONE label rule in the atom (#365 review P2), worn by both strips' names.
  const roster = await readFile(new URL('../hub/Roster.svelte', import.meta.url), 'utf8');
  const appCss = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.match(appCss, /\n\.strip-label \{ font-family: var\(--font-display\); font-size: var\(--fs-ui\); font-weight: 600; white-space: nowrap; \}/u, 'the one label type');
  assert.match(roster, /<span class="a-name strip-label" style:--who-ink=/u, 'the Chat tab name wears it');
  assert.match(source, /<span class="win-tab-name strip-label">/u, 'the window tab name wears it');
  for (const [name, src] of [['Terminal', source], ['Roster', roster]] as const) {
    const css = src.slice(src.indexOf('<style>'));
    assert.doesNotMatch(css, /font-family: var\(--font-(?:display|mono)\)[^}]*font-size: var\(--fs-ui\)/u, `${name}: no local copy of the label type`);
  }
  assert.match(source, /<div class="win-bar-scroll edge-fade appear" use:scrollEdges=\{\{ key: winMarkerKey \}\}>/u, 'the roster s edge fade, re-measured with the window set');
});
