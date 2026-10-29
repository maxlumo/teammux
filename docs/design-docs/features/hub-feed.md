# Hub — the conversation feed

The chat column of the Hub: bubble language, the single user-message anchor, layout mutations through the reading anchor, images, context menus, the sidebar order and per-project drafts. The composer is `hub-composer.md`; the page requirements are `../../requirements/pages/hub.md`.

## Rules and their reasons

### A sent `/command` is the sender's bubble, not a capsule (board #264, 2026-09-28)

The room stores a command the person sent as `[tmm] /goal args → kiro, dev`
(`hub_command`, unchanged, so old rooms render the same way). It used to be
rendered by `sysParts` as a centred lifecycle capsule holding the typed line as
ONE inline-code object on one line with an ellipsis, so a long `/goal` argument
was cut off, and the capsule sat apart from the conversation it was part of
(owner, 2026-09-28: "对于发 slash 指令模式，显示的效果还是很不好，不如直接还是气泡").
Now `sentCommand` recognises that line and `feedBlocks` makes it an outgoing
`msg` block, at every detail level: the same bubble as a chat line, its
recipients in the leading-mention dialect (`@kiro`; a fan-out lists each target
like a message does), the command name in the rendered inline-code dialect
(`.md code`), the arguments as plain wrapping text, never parsed as markdown (they are
data). A long command FOLDS like any long user message (owner, 2026-09-28
16:35: "这个消息怎么好像没有折叠，一个气泡就把我的手机屏幕占满了" — the first cut
never folded it): `foldedCommandArgs` runs the same budget and tail cut as
`elideTail` over the ARGUMENTS alone: the recipients and the name are never
counted or cut, so an argument-less command never folds (validator 16:49:
eight long recipients + `/compact` offered an Expand that changed nothing);
the arguments end in `……`, and the same unfold control shows them whole. It skips `elideTail`'s fence repair: a plain argument never
gains a ```. The block's `body` is what the person typed
(`@kiro /goal args`), so Copy and Raw read the command, not the room's marker.
Lifecycle lines (spawn, stop, restart, interrupt, board moves) keep the capsule;
the capsule's command costume (`.sys-cmd`) is deleted.

**Its echo is its receipt, never an INPUT row.** Measured 2026-09-28 on this
host with the composer's own door (`hub_command` into managed agents of a
scratch stack): most commands fire NO prompt hook on any backend (`/effort`,
`/status`, `/usage`); a command that becomes a turn (`/goal`) is echoed in each
CLI's own shape — kiro 2.22.1 `goal <args>` (slash stripped), Claude Code
2.1.283 `/goal <args>`, omp 18.2.10 and kimi 2.0.2 the arguments alone, codex
0.154.0 nothing (tool and stop only), grok 1.0.41 its own planner prompt ("You
are the Goal Plan Writer…"), which stays an INPUT row because it is not what was
typed. Each backend declares, PER COMMAND and only where a prompt hook was
measured, the shape of its echo (`Backend::command_echo`: today `/goal <args>`
on kiro, claude, omp and kimi; every other `/name` is `None` — validator,
#264: a row for `/effort` would wait for an echo that never comes and could be
settled by an unrelated later prompt). Where it has one, `hub_command` records
a delivery row (v28 `deliveries.command`) carrying the room line's id, BEFORE
typing, and the #249 matcher settles it — the bubble gets the check, the echo
is consumed. The row's life, each rule from a review of #264:

- **Never swept.** An "unconfirmed" warn about a command would be a lie.
- **One prompt, one submission.** A prompt that settled a chat line of ours
  settles no command, so a delivered line that merely contains "goal a" is
  not the command's echo.
- **FIFO, one row per prompt.** A prompt looks only at the window's oldest Idle
  command row (a CLI runs commands in the order typed). It settles the row when
  it EQUALS the declared echo (whitespace-blind, the chat rule; never
  containment, since a command's echo is the whole submission). A prompt of
  nobody's that only QUOTES the echo ("please do goal a", typed by a person)
  puts the row back behind the turn it opened; one that does not even quote it
  drops the row. The rows behind stay owed: two `/goal` queued at one busy
  pane settle in order.
- **Queued behind a running turn.** A command typed into a running turn is
  Queued, untouchable by that turn's prompts, until the turn's end promotes
  it to Idle.
- **An end without a prompt retires one row.** An end (stop, failure,
  interrupt) closing a turn that had no prompt of its own retires the oldest
  Idle row: its CLI ran or failed it without a hook, and a later look-alike
  must not claim it. An end after a prompt retires nothing, because that
  prompt was the previous command's turn.
- **One critical section.** A prompt's read-match-delete-record, an end's
  read-write-retire-promote and a command's read-state-insert each run whole
  under the turn-fact lock, the
  retire and promote in one SQLite transaction, so an echo cannot land
  between an end's read and its retirement.
- Rows go in bulk only with their window (`retain_windows`).

A command bubble shows the check or nothing, never a hollow ring, which would
promise an echo most commands never send. A `/command` is typed by
`hub_command` directly and never passes through #257 holding, so it always
reaches the CLI as a whole line.

### Copy feedback belongs to a message, not its body (#167, 2026-09-12)

Feed and Board use one `message-actions.ts` state model. A click captures the
message key and a fresh attempt before `copyText`; an equal body in another
row is not the same operation. Success alone marks Copied and schedules the
shared completion expiry. Failure remains retryable, while a new row, room,
hidden view or unmount invalidates pending results and expiry callbacks.

The error uses OperationFeedback, not a message menu or another Copy button.
It is positioned from the live Copy control through the existing placement
functions, within the feed scrollport, and measured before `.pop-layer.ready`.
The fixed-corner prototype obscured Copy/Raw on a short tail reply; anchoring
keeps the triggering controls clear without changing row markup or reading
layout. The original Hub capture callbacks still own outside/Escape dismissal
and include this error's Close control in their pointer territory.

### Shared command states, unchanged reading ownership (#166, 2026-09-12)

The owner's Chat-control consistency request is quoted in design-language.md.
Copy/Raw remain the tap-revealed absolute `.m-acts` overlay, never a flow
row or ContextMenu. Their private 26px text-button paint is retired in favor
of shared named icon commands, 28px pointer / 44px coarse targets with
compact inset paint. Raw exposes its actual selected state, and Copy's
existing completion changes the glyph to a check. Board notes reuse the
same Copy command and position owner. Native selection, exact-source copy,
the 1.5s dismissal, path-link priority and room reset stay unchanged.
At the compact tail, the old 6px bottom padding could not contain a 22px
half-target overhang: Chromium 152 measured 16px of new scrollable overflow.
Reserve that half-height in the existing padding regardless of action state.
The shared overlay also falls back to start alignment for incoming bubbles
too narrow for its commands, without intercepting the empty alignment area.

The header and Drawer share one height/spacing owner and native command
boxes instead of overlapping touch overlays. Desktop partition state is
announced as expanded; compact page navigation has no fictitious drawer
state. The drawer's window choices keep their existing data/dot/hover
content and explicitly expose `aria-pressed`. No frame, scroll, transport,
status or Back mechanism changes. The older visual measurements below
describe the pre-adoption command paint, not a second current dialect.

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Agent strip revision (board #168, 2026-09-11)

The owner requested one working-agent strip above the input, with a Stop
on each agent and no inline To control. The current contract is in
[hub-composer.md](hub-composer.md#one-roster-above-the-input-one-stop-operation-board-168-2026-09-11).
It supersedes the older composer-chip/mirror and 260ms card-menu descriptions
below, which remain historical evidence. Roster is still one unkeyed component,
now between Feed and Composer. The owner's 07:09 final choice replaces
`groupRoster` adjacency with busy-first turn recency; team identity remains in
hover/ARIA. The single-line/no-state-word cards can expand in place as a
height-bounded list, with project-owned persistence through `hubPrefs`.
Hub's existing `withReadingAnchor` encloses each expand/collapse mutation;
neither the list nor its height gets a second reading or motion mechanism.
Secondary card actions, including filtering and restart, use only ContextMenu.
A team with nobody running keeps its place in the strip (board #287): its name
over its dimmed stopped cards, the name opening the team menu (`Start stopped`,
`Configure team`); see hub-composer.md § Group verbs.
The fixed tap menu no longer exists. The double-click on a MOUSE card does (board #173, kept in #168): it focuses the agent, i.e. makes it the recipient and toggles the reading filter, through the same `toggleFilter` the menu item uses; since board #432 the filter's face is the search button, not the card.

Feed itself is unchanged: direct child rows, following/newBelow, the three
reading exports, retained resize anchor and `.to-tail` remain its single
reading mechanism. Stopping a card never forces tail-following or remounts
Feed. The drawer's window selector is not another delivery roster and stays.
State dots still use the shared status language; body mentions use one `@`
glyph, not a dashed card ring or a second selected state.

### Every valid @ in a bubble is marked, an invalid one is not (board #273, 2026-09-29)

Owner, 08:01: "一个消息里如果有 @ 多个角色 这些有效的 @ 都应该被高亮起来；如果是无效的 就不要高亮了". The bubble used to mark only the first token at the very start of the first paragraph (`markLeadingMention`, 455efceb: "a mention mid-text is content, not an address"). That premise no longer holds: the server types a body into every agent it names anywhere in it (`deliver_mentions`), so the owner's `@architect @engineer @data @evaluator @reviewer …` reached five agents and showed one. `markMentions(html, managedNames)` replaces it, in user and agent bubbles alike:

- **Valid = what the server reads as an address to someone.** The addresses come from `mentionSpans`, the one tokenizer behind `mentionTokens` (the server's `address::mention_names` rule, #248); one counts when it names a managed agent, `all` or `human`. A removed agent, a wrong case, a longer name (`@builder-2` for `builder`), an email or a host stays plain. So does `@bob看一下`: glued CJK is part of the name the server reads, so it names nobody. `请@bob 看` is marked.
- **Code and links are not addresses.** It reads the rendered HTML's text runs outside `code`, `pre` and `a`. Each run is read on its own, because the tag before it stood for markdown punctuation the server read as a word break.
- **One dialect.** The span is the existing `.m-to`, the same one a sent `/command` uses for its recipients. There is no second style for a mid-text mention.

### The room's transcript lives in state.db, and rooms are implicit (board #107, 2026-09-09)

Hub chat used to sit on the desktop Team's agora bus: hub_rpc's post/page/search/delete all crossed the `TeamBridge` trait into `team.db`. That was a third truth store (tenet 7 allows exactly two — state.db and `<ws>/.tmm/`) and an in-process bus (tenet 4's named anti-pattern), and it chained the Hub's life to a feature the owner deleted whole (board #100). Since board #107 the transcript is state.db's `hub_msgs` (`projects/rooms.rs`), and three decisions there are load-bearing: (1) **rooms are implicit** — a room exists exactly when it has messages; the bus's `open_room` registration step is gone because a registry separate from the data it indexes is a second source of truth (tenet: one definition per concept). (2) **the legacy import preserves `seq`/`id`/`ts` byte-for-byte** — `seq` is the paging cursor already held by every connected client and every `tmm log` walk, so an import that renumbered would strand every cursor mid-conversation; `INSERT OR IGNORE` + a `meta` flag make the one-off import retry-safe, and a legacy `team.db` stays on disk unread (the room is the only record — losing history to a storage migration is not acceptable). (3) **the wire is unchanged** — message JSON `{seq,id,ts,room,from,to,kind,body}` and the `team_message` push frame name survive, because renaming a frame breaks every deployed client for zero behaviour change. The bus's `requires_reply` obligation graph died unmourned: the Hub never read it — reply behaviour is hooks plus the single reply edge (derive, never declare).

### A tool run rides in the reply it produced, folded (board #295, 2026-10-01)

Owner, 15:43: "工具调用这个折叠框和最近的一个消息回复也合并到一起吧，并且如果有回复后，默认工具框就是折叠状态。"

- **Derived in `feedBlocks`, not in the view** (rule 3 in its doc comment). When a window's open `steps` group is ended by THAT window's reply, the group leaves the block list and becomes `msg.steps`. It stays a block of its own in every other case: still running, ended by a prompt, a note or a turn edge, a reply from another lane, a reply that cannot be attributed (no `windowOf`), or a human line. Pinned by `hub.test.ts` (same window, other window, no reply, prompt-closed, human, two agents interleaved, status level).
- **One list markup.** `Feed.svelte` renders a run through ONE snippet, `lane(b, attached)`: `{@render lane(b, false)}` for a block, `{@render lane(b.steps, true)}` inside the reply's bubble, between the #292 header and the words. Attached, it drops the agent name (the bubble already names who) and the live pulse (it is finished), keeps the chevron, the count and the last-call peek, and unfolds to the same capped row list with "show all".
- **Folded by default once attached.** `stepsOpen(b, attached) = stepsChoice[b.key] ?? (!attached && isRunning(b))`. The group keeps its key when it moves into the reply, so a choice made while it ran, or later, holds for the session. (A standalone run's default changed with #298, below.)
- **Width**: a folded strip fits the bubble. An OPEN attached run widens its message to `--msg-max` (`.msg:has(.steps.open)`, since #298 for a standalone run too), so the rows have the lane's room and the middle column pans inside it as before. Measured at 390: the unfolded bubble spans 18–315px of the 390px feed.
- No click inside an attached run reaches the bubble: the head, a row and "show all" are stopped once, at the lane (`.steps` stops propagation when `attached`, the `m-unfold` rule), so reading the run never opens or closes the message's action row; the words still do (validator #295 P1, pinned by `Feed.mount.test.ts`). The card rises once, as its bubble (`appear-rise` stays on the `.msg`, not on the attached lane). The held anchor is a human bubble, and a human line never carries a run, so its clip is unchanged.

### A run of its own is its reply's shape without the words (board #298, 2026-10-03)

Owner: "合并之前的渲染也应该是相类似的结构，只是没有最终 agent 消息内容了，不要有差别，要一致一些". Before #298 a run its reply had not ended (still running, or closed by a prompt, a note or another lane) was a full-width telemetry card with the agent name inside its head; once the reply arrived it became a strip inside an agent bubble, so the same run changed species mid-turn.

- **One shape.** A standalone `steps` block renders as a `.msg` with the #292 `.m-head` (name in `agentHue` ink + `runtimeLabel`) outside, an agent `.bubble`, and the same `lane` inside it. Only the words are missing. The lane no longer carries a name of its own (`.s-who` is gone), and its CSS has no attached variant: `.steps` is the in-bubble card everywhere, with `.steps:last-child` trimming the bottom margin when no words follow.
- **Open only while it runs.** A standalone run defaults to open while `isRunning` (the capped tail is the live view, with the `.live-dot` pulse in place of the chevron) and folds once its agent stopped, like a carried run. An explicit choice still wins, keyed by the group.
- **Width** follows the reply rule: folded fits the bubble, open widens the message to `--msg-max`. The old full-width card is retired, so paths now pan inside the message cap rather than across the feed.
- The standalone bubble has no click handler (it is not a message: no action row). Pinned by `Feed.source.test.ts` (#295 + #298 tests) and `Feed.mount.test.ts` (running: head outside, bubble, open, pulsing, no `.m-body`; idle: folded, opens on its head). Screenshots at 390 and 1280, before and after, are on the issue.

### An agent bubble is headed from outside, by name, runtime and its own ink (board #292, 2026-10-01)

Owner, 14:18, after the promo video: "Agent 回复的消息里，Agent 的名字在气泡外边，是彩色的，而且名字后面有灰色的文字表示它是 runtime 之类的信息，我觉得这个都挺好的"; 14:36, on the colour: "名字多个颜色更好看，可以的".

- `.m-head` is the `.msg`'s first child, ABOVE the bubble, inset by the bubble's 12px text padding so name and words share a left edge. The bubble's tight corner moved from bottom-left to top-left (`6px 18px 18px 18px`), so it hangs from its name. The human's bubble has no header and keeps its bottom-right tail.
- After the name comes `runtimeLabel(agent)`: the backend, then `modelLabel` of the sniffed model, e.g. `kiro · claude-opus-5.5`, in `--fs-micro` mono `--text3`. It ellipsises first on a narrow phone. It is the SAME function as the roster hover's model line, read off the live hub_agents row, so a stopped or removed sender shows no label instead of a guess from history.
- The status-note badge stays on the header row, pushed right.
- The name's colour is `--who-ink`, set per name by `agentHue` (see design-language.md § Colour for the six tokens and the contrast table). The sysline's who and every `@mention` wear the same variable, so one agent has one colour across the feed, the roster and the composer's addresses.
- The room's loading skeleton (`.sk-msg`) wears the same corners as the real bubbles, so the shape does not jump when the room arrives (board #294, validator's #292 P2). `Feed.source.test.ts` compares the two rules.
- Measured at 390px: the action row (`.m-acts`) still straddles the bubble's bottom edge (centre = bubble bottom, before and after), buttons 44px. The held anchor is a human bubble, which has no header, so its clip is unchanged.

### One sender's consecutive bubbles are one run, headed once (board #331, 2026-10-09)

Owner, 2026-10-09: "如果一个 Agent 连续发了好几条消息，那么这个 Agent 的名字只写一次就行了，不用写好几遍，消息气泡依次列出".

- **One rule, in hub.ts.** `continuesRun(prev, b)` decides whether a `msg` block continues the run of the block before it in the rendered list: both are agent messages from the same sender, nothing else sits between them (a sys line, a prompt, a progress line or a note ends the run, so what is filtered out at the current level does not), the same local day, at most `RUN_GAP_MS` (5 min) apart. Two messages carry their own header meaning and start a new run: a status note (its header wears the state badge) and a reply addressed to the human. The human's own bubbles have no header, so they never form runs.
- **Only the header goes.** `Feed.svelte` drops the #292 `.m-head` (name, runtime) on a continuing bubble and gives it `.msg.cont`, which pulls it 6 px closer (4 px under the one before instead of the feed's 10 px; 4 of the compact 9 px). The bubble, its time trailer, its action row, its quote, its `data-msg` jump anchor and its held-anchor behaviour are per message, unchanged. Phone and desktop share the rule.
- A screen reader reads the run under its first bubble's name, the way the eye does.
- Pinned by `hub.test.ts` (the rule's cases, and feedBlocks at two levels: a sys line breaks the run at `status`, the chat level drops it and the bubbles join), `Feed.mount.test.ts` (name once per run, `cont` flags, a continued bubble opens its own action row; dropping `!cont` fails it) and `Feed.source.test.ts`.

### Hub visual language is one Telegram-like adaptive surface, not another component tree

an agent bubble is headed by its name; time (+ delivery ring on your own, right of the time) is a Telegram-style inline trailer FLOATED at the end of the content — last line when it fits, own right-aligned line when not, never a separate row/column (the last `<p>` turns inline so the float shares its line box; `.m-body` is flow-root; both sides hug content via align-self — column-flex stretch stranded short-line times at 76% width); msg == bubble again so a held bubble is that box at full height; incoming/outgoing opaque colours are derived from existing theme tokens, with asymmetric lower corners, restrained border/shadow and bounded widths; telemetry remains subordinate. The composer is ONE capsule: recipient chip pinned top-left, textarea first line indented past it (measured `text-indent` via `bind:clientWidth`, a re-measure dependency of auto-grow) with wrapped lines reclaiming full width, and the up-arrow send — a small rounded square in the capsule's own design language (flat; solid accent CTAs app-wide use --accent-fill/--accent-fill-ink — dark tones the electric cyan to a 60% bg mix, light keeps full accent; strong selection borders use --accent-line; disabled recedes into the surface) in the bottom-right corner, reserving NO column: a hidden mirror div measures the last line and only a colliding tail line adds one line of bottom padding (bubble-meta semantics for the composer). Radii are one TOKENIZED scale (app.css: --ui-radius-control 10 / --ui-radius-row 12 / --ui-radius-panel 14; specials: bubbles 18/6, composer capsule 16/15, dialogs 18; micro tags ≤6px stay hardcoded; swept rules reference the token — re-raised and unified 2026-08-21, squircle corners read tighter than arcs at the same radius); the held clip round and drawn frame follow the bubble radius. Message copy/raw actions are an absolute `.m-acts` overlay on the bubble's bottom-right corner — never a flow row (feed `scrollHeight` must not change when they open), revealed by a plain tap and NEVER by a context-menu card (board #48; owner, 2026-09-07: "我只要消息气泡下边的这两个按钮，不要出现右键那种选项卡"); a touch long-press stays the system's selection gesture. Phone only tightens dimensions/hides the redundant “TO” label — same markup, same behavior. All components draw from the token contract on `:root` in app.css (6-step type scale --fs-*, --meta-ink, --t-fast/--t-move motion pair, primary actions get invisible ≥44px hit overlays, bubbles are TEXT to assistive tech — the meta trailer button is the accessible actions route); a raw px font-size ANYWHERE is a regression, guarded by `src/lib/ui/tokens.source.test.ts` (and the sidebar's BOX by `ui/sidebar.source.test.ts`: `.side-h`/`.side-row` share one 10px inset, and a scoped `.group-label` rule may not re-declare the header's padding or type — that override is what put the Terminal sidebar's "PROJECTS" 4px left of Chat's, twice, since a scoped rule silently outranks a shared class) (six chrome steps; `--fs-hero`/`--fs-display` for the connect card only; `--fs-input-touch: 16px` is the iOS no-auto-zoom BEHAVIOUR, not a step; a rendered document scales in `em` off its own base). The normative token contract is [design-language.md](design-language.md).

**Identity colours are tokens too** (review C, 2026-09-03): the avatar fallback for a backend without an icon paints `--backend-kiro/claude/codex/kimi/grok/other` from app.css `:root` — `backendColor()` in hub.ts only NAMES the token (it used to return the hex literals, which is the "new visual species" design-language.md forbids). Identity is theme-independent; state is not, and state is spoken only by `stateDotColor` + `.live-dot`. Those two halves travel on the SAME element: `ui/statusdot.source.test.ts` fails any tag painted with `stateDotColor` that lacks `class:live-dot` — the drawer's window pills carried the colour without the motion, so a running agent's pill read as resting. The amber half has a card-level form too (review, 2026-09-03): a `waiting`/`blocked` agent's card wears `.acard.needs` — the SAME `--status-warn` token as its dot, as frame + wash + the word `needs you` — because the state that needs the human most was the card's weakest signal; `stateNeedsYou` decides it (see agent-status.md).

**The delivery ring has THREE readings, and a room note is the third** (review, 2026-09-03): the trailer on your own bubble is filled when the agent's `userPromptSubmit` hook echoed the line (`feedBlocks` rule 1), hollow while a line typed into a pane waits for a busy agent's turn to end — and a ROOM NOTE, a body that addresses no managed agent (`hub-composer.md`'s third destination: recorded, typed into nobody), used to wear that same hollow ring with the "fills in when its turn ends" tooltip for ever, because no echo can ever come back for a line nobody was given. The verdict is the server's own, read client-side: `mentionedAgents(body, managedNames)` (pure + tested, the one `mentionTokens` tokenizer `mentionsAgent` and the composer chip share) answers empty when `deliver_mentions` would have typed into nobody — no `@name` on the roster and no `@all` (an email address, a removed agent, a direct window all count as nobody) — and the bubble then wears the recipient picker's own dashed `.note-dot` with its own tooltip, not a ring: one glyph for "reaches nobody live" wherever it shows, achromatic because at rest is grey. A confirmed echo still wins (a delivered line to an agent since removed keeps its filled ring); only an UNCONFIRMED line is judged against the current roster. The hook-post invariants are untouched: this reads bodies, it delivers nothing. A line steered into a busy steer-mode turn (board #276) has no ring at all: the server names it in a `steered` event because no hook will ever echo it, and the bubble reads like a sent `/command` (#264), just the time.

### The Hub has ONE user-message anchor, and it is the real bubble

never render a separate pin, never hold one message at each edge, and never swap to the "nearest" offscreen message at an invisible midpoint — all three look like duplicate components. Direction is the state machine: scrolling down selects the newest user bubble only when it naturally enters, lets that SAME element move upward, then catches it at the top as it exits; scrolling up does the symmetric oldest-visible → bottom behavior. Through a long reply, retain that active bubble until another real user bubble enters. `.held` starts only after the edge is touched; applying it while the bubble travels also looks like a replacement.

**EVERY long user message FOLDS ITS TEXT by default; the bubble is never clipped or capped** (owner, 2026-08-27: "直接后截断的形式 最后文末不用换行三个点 中间不要了，默认用户消息都截断 不要显示太多" — which retired the held-only middle elision; the no-clipping rule is older: 2026-08-19, "消息内容自己内部折叠 不是框截断 … 气泡什么的都要完整的不要任何裁切"): `elideTail` (pure + tested) truncates the BODY at the REAR before render — a VISUAL-row budget, not source lines: each line costs `max(1, ceil(visualUnits / measuredPerLine))`, CJK/fullwidth costs 2 units, and the exhausting line is cut at the remaining units on a word boundary; the `……` marker stays INLINE, an orphaned fence is rebalanced, identity returns when all fits (board #53) — and an in-bubble `Show the whole message` control unfolds it (per message, kept until the project changes; `Fold it away again` reverses it). **The prompt row folds through the SAME mechanism** (board #172, owner 2026-09-11: "有消息没有渲染" — the input row for a 601-char `[board #168 reply]` notice stopped mid-sentence after ~6 lines while the stored echo ran 200 chars further): `.p-body` carried its own `max-height: 7.5em; overflow: hidden`, a second and SILENT fold — no marker, no way to the rest — that told the reader less had been delivered than had. It is gone; the row cuts its text with `elideTail` under the same `foldLines`/`perLineOf` budget and renders the ONE `.m-unfold` control (a `{#snippet unfold}` shared with the bubble). `Feed.source.test.ts` pins that `.p-body` has no height cap or clip and that the button markup exists once; `Feed.render.ts` renders a folded long prompt (`……` + control) beside a short one that shows whole.

**An EXPANDED message is never pinned** (owner, 2026-08-27: "如果展开了消息 就要把钉住用户消息关掉 不然展开就没法上下滑动了"): all three pin classes (`ask-top`/`ask-bottom`/`held`) hang off ONE `pinned` gate that excludes `expanded[key]`, so an unfolded message rejoins the flow and the FEED scrolls the whole of it — which retired the `.held-scroll` in-body scroller (2026-08-20's answer to the same unreachable-bottom-half problem). Unfolding JUMPS the feed to the message's natural position unless its start is already in view (`expandMsg` — the pinned copy was often pages away from the natural spot, so releasing the pin read as the message VANISHING; owner, same day: "现在点击展开 消息就不见了 应该展开跳转到那条消息的位置"), and an expanded message scrolled clean out of the viewport (whole box past a 120px margin) refolds itself through the reading anchor and rejoins the anchor pool ("划走看不到以后 自动折叠 并且钉住"). `Feed.source.test.ts` pins the gate, that `.msg.held`/its bubble carry no max-height, and that no `held-scroll` class or selector returns. The budget is an ESTIMATE from the screen: 20% of the CHAT COLUMN's height (the feed's parent — NEVER the feed itself, which is the flex leftover after the composer: typing a multi-line message shrank it, the next poll re-measured, and every folded message re-cut with no compensation — the parked tail drifting on its own, owner 2026-08-27) ÷ the bubble's computed line box, floor 3. Its WIDTH half is measured too (board #53 review): `measureHeld` derives the max bubble content width from the feed content box/`--msg-max` and divides by the current font's cached average glyph width via `perLineOf`; fixed 80 is only the pre-measure fallback. Window resize and drawer regrid re-measure inside `withReadingAnchor` in the order mutate→settle→measure→settle→restore, so narrow chat columns re-cut immediately without moving a tail/history reader; being a line off just makes the bubble a line taller, because nothing is cut.

**A message's PICTURES are behind its fold, so the pin never changes its box** (board #372, owner 2026-10-14: a human message with a picture or many lines was shown folded while held and in full when scrolled to, and that sometimes flashed the screen — "如果滚动到该消息，也保持折叠吧"). Cause, measured at 390 on a real gateway (a 14-line message with one 600x420 image): `.msg.held .shots { display: none }` made the pinned message 112px and the same message in flow 322px (the 180px thumbnail strip plus its margins), so the instant it un-held, everything below it moved 210px. The fold budget was not it (the text folded to the same two lines in both states) and `expanded[]` is only written by Expand and `autoRefold`. The fix keeps the owner's rule and the held anchor's purpose (a landmark for re-reading your words, not a tall image): a human message with pictures is FOLDABLE like a long one (`foldable` = the text is cut OR it has pictures), the strip renders only once it is unfolded, and while it is folded the bubble says the picture is there with one `[Image]` line (`[Image] ×2` for several; `hubImage`, the Board card's word) above the same Expand control. Expanding unpins the message and jumps to it as before, and an expanded message is never pinned, so no held bubble can hide or grow a strip. `.held` is paint only (the shadow). The other way to keep the box constant, showing the strip in both states, was rejected: it would pin a 322px bubble on a 663px phone feed. Visible consequence: a sent picture reads words + `[Image]` + Expand until the reader opens it, in flow too. Two messages are outside the rule and need none: an agent's picture is unchanged (an agent bubble is never pinned), and a sent `/command` (board #264) folds on its ARGUMENTS only: a picture never makes a command fold by itself, it follows the command's own state (`folded`) — visible with a short command, behind Expand with a long one — and since `.held` hides nothing either, the box is the same held or in flow in both cases. Pinned by `Feed.render.ts` (which messages fold and what they show), `Feed.mount.test.ts` (held and in-flow content identical; Expand is the only growth) and `Feed.source.test.ts` (no rule under `.held` hides, shows or resizes anything).

**Double-tapping the held bubble jumps to it** (board #304, owner 2026-10-03: "双击钉住的用户消息 可以跳到那个消息的位置"): on a bubble that is actually `.held`, `dblclick` (mouse) or a double-tap (touch/pen `pointerup` fed to the terminal's ONE `createDoubleTapDetector`, 300 ms / 40 px) runs `jumpToMsg`, the same jump `expandMsg` uses: scroll to the message's natural position 8 px from the top unless its start is already in view. It does not expand and does not unpin; the message simply arrives at its own place and the anchor state machine takes it from there. `jumpToMsg` reads the natural position in the feed (`rowTop`, board #439: the same measure as the centre's `showMsg`) with that element's stickiness neutralized for the synchronous read, as `syncAsk` does, because Chromium reports a sticky element's HELD offset. The pair's first tap still opens the action row (a single tap's behaviour is unchanged), so the jump closes it and clears any word selection the double-click made; the second tap's echo `click` is consumed (`jumpClick`) so it cannot reopen the row. An unheld bubble's double-click keeps the native word selection. `Feed.mount.test.ts` pins both input paths landing on the natural position (fails without the change); `Feed.source.test.ts` pins one detector and one shared jump.

**A held bubble lifts by shadow only** (board #302, owner 2026-10-04 with a phone screenshot: "圆角后边的阴影有问题"). `.msg.held` used to carry `backdrop-filter: blur(10px)`. The `.msg` box is square while the bubble inside it is opaque and rounded (18px, 6px corner), so the blur was visible ONLY in the square corners outside the bubble's curve: a grey, blurred patch behind the left corners (the right ones sat under the to-tail control in the owner's shot). Moving the blur onto the bubble would paint nothing, the bubble being opaque, so it is deleted; the `0 6px 20px` shadow remains the whole lift. Measured at 390 dpr 3, light and dark, before/after crops on the issue; pinned in `Feed.source.test.ts`.

**One guard stays**: `.feed { overflow-anchor: none }` (Chromium's scrollTop compensation was the root of the `一闪一闪` blink — measured: assigning 2261 landed on 2221↔2298). The old second guard — a folded bubble reporting its UNFOLDED height to the boundary test (`naturalH`) — retired with fold-on-hold: folding no longer toggles at the hold boundary, so the box height only changes on an explicit unfold click and the real offsetHeight is the right answer. Direction commits only after 16px of travel against it (trackpad/touch rest jitter is 1–3px). Chromium moves sticky `offsetTop`, so `syncAsk` neutralizes `position` during its synchronous natural-position read; programmatic tail jumps call it explicitly. Pure transition rules live in `pickAnchor()` tests; live validation must scan DOM for `max(.ask-top,.ask-bottom) == 1` and observe one bubble's rect reach the edge before `.held`.

**Reading decision ownership** (board #116, 2026-09-09): `hub-reading.ts`
now owns the previously inline direction/travel update, held-edge hysteresis
and refold eligibility. The extraction keeps the same thresholds: reversal
at 16px, first contact within 1px, same-key held-edge retention through 8px,
and refold only after the whole box passes the strict 120px margin.
`pickAnchor`, `foldLines`, `perLineOf` and `elideTail` remain in `hub.ts`;
Feed owns the DOM reads, sticky neutralization, state, tick/rAF and CSS
since the mechanical view extraction in #134.
A jump resets the `pickAnchor` seed, not the separately tracked held state.
Unit boundary vectors exercise these decisions; the source contract pins
their wiring. This separates testable arithmetic from layout without changing
the reading behavior or claiming simulated geometry proves browser layout.

**Feed extraction characterization** (board #134, 2026-09-09): before moving
the view, the mounted Hub exercises actual Copy/Raw handlers, selection and
compatibility-click suppression, the existing shared capture dismissal,
copy timing, per-room resets, persistent tool disclosure and path/Board
intents. Earlier mount characterizations remain unchanged. Its canvas
measurement is unavailable rather than simulated: geometry belongs to the
real Chromium fixture, with fonts and the referenced image decoded before
the comparison starts.
The Chromium 152.0.7977.64 baseline captures 60 states across desktop/compact,
light/dark and reduced-motion variants, including one real pinned bubble,
expand/refold, prepend, drawer transactions, hidden/show tail intent, news
and read markers, native tool-list wheel chaining and rendered path links.

The baseline also distinguishes a native viewport resize from a mutation
inside the reading transaction: Chromium reflows before the `resize` listener
can capture a reference. On 152.0.7977.64, the fixed compact fixture at
390 -> 370px displaced its pre-resize row by 519.1875px on the original code;
drawer open/close stayed within 1.25px. #134 deliberately preserved that
displacement; #135 changes native resizing through the retained snapshot
described below, in a separate behavior commit.

**Feed view ownership** (board #134, 2026-09-09): `Feed.svelte` owns the
unchanged `.feed-wrap`/`.feed` pair, direct rows, local disclosure/selection
state and measurement/scroll adapters. `measureHeld` still reads the same
`feedEl.parentElement`, physically `.feed-wrap`; no wrapper or per-project
key changes its geometry or lifetime. The move preserved the former resize
behavior; the subsequent #135 fix is separate.

Its only reading exports are `scrollToTail`, `withReadingAnchor` and
`resetForRoom`. Hub retains blocks/feed/activity, RPC/push/poll/cache, paging,
seen preferences and the two explicit `following`/`newBelow` bindings.
Reset clears expanded/message-action/raw choices and, since #135, the
room-owned resize snapshot; tool disclosures, copied-label timing and glyph
caches keep their previous lifetime. Path, Board, Lightbox and filter
actions are narrow intents; the empty-room preset remains a Hub-owned
snippet at the same direct-child position, retaining spawn coordination and
its existing CSS. `.feed > :global(*)` retains non-shrinking layout for that
parent-owned row without changing selector specificity.

Copy/Raw state moves with Feed, but the shared capture listeners stay in Hub
in their original order. Through one registration prop, Feed supplies live
`isOpen`/`outside`/`escape` callbacks, with identity-safe cleanup and no copied
open flag. These are not Back layers. The one safe Markdown renderer,
path-link handler, `.to-tail` and status/motion atoms remain shared.

Verification on Node 22.23.2 / Svelte 5.53.5 / Vite 6.4.1: 12 moved handlers
and 11 retained coordinator handlers are AST-identical after the tail-method
rename; the 101 moved CSS rules form an exact partition of the original
styles. All 60 Chromium 152.0.7977.64 text/rectangle/scroll/style signatures
match, including the existing 519.1875px compact resize displacement. The
negative control bypassed only the drawer-close reading transaction and
failed at -1118.25px reference displacement. Restoring the call restored the
strict drawer assertion. Real image clicks also reach the existing Lightbox,
whose Back layer remains in Hub.

### The turn rail: a floating navigator at the right edge, one tick per human message (boards #461, #463, #465, 2026-10-24)

Owner, 2026-10-24 (#461): "在 chat 消息里上下导航很好的交互，可以鼠标直接找到之前某次我发送的消息，而且鼠标悬停还有预览，手势也可以滑动预览找到我先跳转的消息的位置" (modelled on KiroCrew's chat navigator). Owner after trying it, 2026-10-24 16:55 (#463): "出现之后一直钉死在左边，而且把其他消息都挤开了。 1. 位置与交互：把快速滑动的区域钉死在右侧中间悬浮，不要挤占原始气泡的任何横向空间。并且在上面上下搓的时候，高亮的那一项是在变化的，类似于拨动时间滚轮的感觉。 2. 预览效果：只预览当前选中的那个大一点的气泡，上下两个小的气泡就不显示了。" So: a **rail** that FLOATS over the right edge of the feed, vertically centred, one tick per HUMAN message of the loaded feed, taking no space from the bubbles (the first build, a left gutter, squeezed them: -34.6px of bubble width at 390, then a left overlay on padding; both are gone). Code: `hub/TurnRail.svelte` (markup, pointer wiring, placement), `hub/hub-turn-rail.ts` (the input protocol, DOM-free), `hub/hub-turns.ts` (turns, labels, ticks, scrub arithmetic), `ui/placement.ts` (`menuPlacementIn`, `side: 'left'`).

- **The rail is shown only while it is wanted, and that is DERIVED (board #465).** Owner, 2026-10-24 23:12: "现在消息的快速选择区域，这里不应该是常驻显示的，应该是我在有手势或者在上下滚动的时候才动态出现的，如果停留一段时间就隐藏，注意出现和隐藏要有流畅的动画交互". `hub-turn-visibility.ts` holds the whole rule: shown = any HOLD is on, or less than one dwell has passed since the last activity. Activity is a PULSE (a scroll of the reader that is off the tail: `Feed.onFeedScroll` nudges only when `following` is false, so tail-follow, a new message and the room-load park never flash it) or the END of a HOLD (a probe is open, the band has keyboard focus, or a mouse is inside the rail's column). A hold is a live fact: while one lasts the rail stays, and the dwell counts from the end of the LAST one, never from its start. Never-active is `null`, so a fake clock at 0 does not light it, and the rail is hidden on first load until the first scroll. The dwell is ONE token, `--turn-rail-dwell` (1500ms, app.css); JS reads it from the computed style when a hide is scheduled (a missing token is 0: it hides at once, which shows up), and the one timer lives in the visibility module, not in the component. Reason and precedent for the figure: [motion.md](motion.md).
- **Hidden means inert, not gone.** The component renders `.shown` from the visibility object. Hidden, the band takes no pointer and no `touch-action` (`pointer-events: none; touch-action: auto`), so a finger or a wheel over the right edge scrolls the feed and a tap there never jumps. The node is NOT `inert`, `hidden` or `visibility:hidden`, so Tab still reaches it and `:focus-visible` shows it. The controller's host has two gates: `operable()` (= shown) for everything that ACTS (a press, a hover probe, a key, `admitted()` on a held press) and the component's own wake paths for everything that only REVEALS: a mouse or a hovering pen entering the column (a `pointermove` on the feed-wrap tested against the column's rect; touch and a pressing pen never reveal; `pointerleave` of the wrap, a button down, a focus change or the host gate falling releases the hold), and keyboard focus. A touch that began while hidden and whose scroll then shows the rail does not become a jump on its old release. A pointer in the corridor or the popover is held by the live probe. A band that kept focus while hidden (a mouse focused it, so `:focus-visible` never matched, and the dwell ran out) sends no new focus event, so a NAVIGATING key (`RAIL_KEYS`, one list in the controller) on the band takes the focus hold before the protocol sees it: ArrowUp/Down, Home, End, Enter and Space wake and act at once, Tab, Escape and letters do not, and the hold lasts until blur. Pointer input stays refused while hidden.
- **Motion: one transition, on an inner layer.** `.turn-rail` (the inert column) and `.tr-band` (the 44px hit layer that `host.band()` measures and `admitted()` compares at a 0.5px tolerance) NEVER carry a transform: a fade-in that moved the measured layer would reject a press begun mid-fade (reviewer, #465). Only `.tr-paint`, which holds the ticks, animates and it is never a target (`pointer-events: none`, ticks included): the translated box reaches past the fixed band, and a press on that overhang or on a scrollbar's clearance belongs to what is underneath; the band alone takes input. It animates: `opacity` and a small `translateX(var(--turn-rail-shift))` from the edge, `--t-move`, ease-out, the same pair in both directions (the reason it is allowed an outro at all is in motion.md). The popover and the corridor stay fixed siblings after the column, outside any transformed ancestor. Nothing waits for `transitionend`: a press or a key during the fade-in commits once; a probe, a mouse or focus during the fade-out reverses it in place with no remount; a real resize still retires. Under `prefers-reduced-motion` the transform is dropped and only opacity fades. Retire sites are unchanged. `retire()` also drops the old reading's pulse and timer (`vis.reset()`); a hold that is still true (keyboard focus, a mouse in the column) keeps the rail shown, because it is a fact about now, not about the old reading. Only the gate falling (`vis.clear()`) clears every hold. Geometry retirement inside the component resets nothing.
- **A turn is what the anchor tracks, by one rule.** `askTurns` (hub-turns.ts) is the only definition of "a human message in the feed"; `blockKey` moved there too, and the markup's `isAsk` reads the turn set, so the rail and the user-message anchor cannot disagree on which message is which. An agent bubble is never a turn. Labels are computed only for the rows a preview lists, through the bubble's own pipeline (status note, quote, images; `[Image]` for a picture-only turn; the command text of a sent `/command`).
- **ONE tick is emphasised, and it is the probe's while a probe is open.** Idle, it is the anchor's `askKey` projection, read-only (the rail has no "current turn" rule of its own: a second rule would differ from `pickAnchor` in direction, visibility and the long-reply hold; a feed too short to scroll has no anchor and lights nothing). While a hover, a press-and-drag or the arrow keys are probing, the PROBED tick is the emphasised one and moves with the pointer tick by tick, like a picker wheel, and the anchor's tick goes back to rest; when the probe closes (leave, cancel, commit, Escape, retire) the emphasis returns to the anchor's. Two states of one tick atom (`--text` long for the anchor's, `--accent-ink` long for the probe's, `--text3` at rest), a `--t-fast` background change and a cut in length (a length is never animated: motion.md). The probe writes nothing: not `askKey`, `following` or `markSeen`. After a jump the emphasis is whatever the anchor says next, which can be a neighbour when several human messages are on screen (the anchor prefers the newest visible one) — the same as the double-tap jump (#304), kept rather than patched with a second selection.
- **ONE jump.** A click, a release, a popover row and Enter all end in `jumpToMsg(key)` (natural position through `rowTop`, sticky neutralised). It now reports `moved`, `in-view` (the start was already on screen, so it only re-seeds the anchor) or `missing` (not mounted: nothing moved, nothing is claimed).
- **Tokens and atoms only.** The hit column is `--turn-rail-hit` (44px, both screens); the paint is `--turn-tick-*`, the clearances `--turn-rail-inset` / `--turn-rail-clear`, all defined once in app.css. The preview is the popover surface (`menu-surface pop-layer`, one `menu-item` row, placed by `menuPlacementIn` with `side: 'left'` inside the feed-wrap so it clears the header and the composer, growing from the edge that touches the band) — NOT HoverCard: it is operable. It shows ONE row, the probed turn's first line at the bubble's own type step (`--fs-body`, up to three lines), and the footer 'Turn N of M[+] · time'; no neighbours. Being a single row measured from its content (one to three lines plus the footer), it is anchored to the PROBED tick (centred on its measured height, clamped into the feed-wrap box) and follows the probe without churn and without replaying the pop-in. The band-to-popover gap is a CORRIDOR, not a timer: an invisible element on the band's left, the width of the gap (`POPOVER_GAP`, the shared constant) and the height of the WHOLE band, part of the cluster band + corridor + popover that the hover lives in (a real element: a pseudo-element outside a clipping surface lost the pointer in the gap, reviewer #461). Only a `--t-fast` colour transition on the tick; no keyframes of its own.
- **A floating overlay that reserves nothing.** `.turn-rail` is absolutely positioned inside `.feed-wrap` at the inline end (right), between `--turn-rail-inset` at the top and `--turn-rail-clear` at the bottom, and the band (as tall as its ticks) is centred in that. The feed's padding, the bubbles and the reading position are exactly what they were before #461: the rail mounts with a plain `{#if}` (two human messages and a settled room), no class, no variable, no reading-anchor transaction, and a source pin forbids any rule of `.feed` or `.feed-wrap` from reading a rail token. The column is inert (`pointer-events: none`) except the band, so a wheel or a finger that starts beside, above or below the band reaches the scroller natively (no forwarder); only the band refuses the browser's scroll (`touch-action: none`), and only while the rail is shown (below). Ticks end at the column's OUTER (right, the screen's) edge, one token, `--turn-tick-edge`, the distance from that edge to the tick's outer end; the emphasised tick is longer and grows INWARD, so every outer end lines up (board #468). Owner, 2026-10-26: "这个快速消息滚动条在手机上可以更靠近边缘一些". The value is 24px on a desktop (the emphasised tick where the inner-aligned ticks had put it; the resting ones moved 6px toward the edge) and 10px under `any-pointer: coarse`, so the phone's ticks end 10px from the screen edge (they ended 30px, the emphasised one 24px, before). It is paint only: the 44px column, the band, the popover, the corridor and the fine adjust read the band's rectangle and do not move (measured, below). `--turn-rail-clear` keeps the band above the back-to-tail control, hit area included (bottom 12px + 38px + the 3px its `::before` overhangs + a gap; a source pin parses both rules). A classic scrollbar's width is read from the scroller (`offsetWidth - clientWidth`, `--turn-rail-edge`; 0 for overlay scrollbars and in headless Chromium, so the 8px desktop case is code-read, not measured) and the rail stands to its left; a scrollbar that appears or goes retires the rail. **The cost, accepted by the owner:** on a 390px phone the 44px column covers the right 34px of the user's own bubbles over the band's height, and a tap there is the rail's, not the bubble's; on a desktop there is no overlap (1280px: the user's bubbles end at 1228.8px, the column starts at 1236px). Measured in Chromium 152 (headless), 12 turns: the agent bubble is 336.7px wide at 390 and 1177.6px at 1280, the same as before #461; hit-testing above and below the band belongs to the feed, on the band to the band. **Tick edge, measured (#468, Chromium 152, 390px, 14 turns):** before, the resting ticks ended 30px and the emphasised one 24px from the screen edge; with 10px every tick ends 10px from it (24px: the emphasised one unchanged, the resting ones at 24). The column (346..390), the band, the popover (40..340 wide at the probe) and the corridor are identical to the pixel across the old layout, 10px and 24px. The touch row is a REAL coarse pointer: `playwright-core` (already in node_modules) driving the same Chromium 152 with `hasTouch` and `isMobile` makes `matchMedia('(any-pointer: coarse)')` true, and the unmodified stylesheet then computes `--turn-tick-edge` 10px with every tick 10px from the edge (fine pointer, 390 and 1280: 24px). The first build declared the override 340 lines BEFORE the default, so the later default won on touch too (a media query adds no specificity): measured 24px on that build, 10px after moving it below, and a source pin now holds the order. (An earlier row that set the token on the root by hand skipped the cascade and proved nothing about it.) The gesture-zone behaviour is the owner's phone row.
- **Input is one transaction per gesture, and it only previews.** `hub-turn-rail.ts` holds hover, press and key intents under one generation. Every handler first checks the host gate, the generation, the ordered turn keys and the band rectangle, and `commit` resolves the key against the CURRENT turns and clears every intent before the host moves: a second release, a trailing click, a repeating Enter or a second finger finds nothing. `pointercancel` and a lost capture cancel with no jump; a cancelled pointer's remaining events stay dead until it lifts; a touch has no hover. Mouse and pen drag outside the band and release anywhere; Escape cancels a press. The ground the rail was measured on moving is a retirement CALLED at the change as well: a window or visual-viewport resize (a keyboard, a header), the interface zoom (`app-zoom-change`), or a new size of the column, the band or the feed-wrap closes the preview and cancels a held press, so nothing stays at a stale position and a geometry that changes and changes back cannot bring an old press back (the rectangle compare at each event is the second line, not the first).
- **`retire()` is CALLED where the reading context changes, never inferred.** An effect watching a boolean cannot see A→B→A inside one flush, a counter can: `Feed.resetForRoom()` (every room selection, cached or not), Hub's `newReading()` (a jump, a return, a room switch; every write of `windowed` sits beside one), the one filter writer `setFilter`, destroy, and the host gate falling. `hub/TurnRail.source.test.ts` pins that every write of `windowed` and `filterAgent` in Hub.svelte sits in a function that retires. Evidence is two-tier and should be read that way: `TurnRail.test.svelte` calls `resetForRoom`/`retireTurnRail` by hand and proves the Feed wiring and the same-flush cases; `Hub.mount.test.ts` ("the turn rail's held press does not survive a room switch or a filter") goes through the page's own room list and agent-card double click, with the filter keeping the very same turns so only the called retirement can end the press. The turn set's key string is compared at every entry as well, so a prepend, a human append or a removal under a held press cancels it without a call. An agent-only update (same keys) retires nothing.
- **Stated limit (owner/orchestrator, 2026-10-24):** a `visible` hide followed by a show inside ONE flush (the page is written at ~35 sites in App.svelte) never paints and changes no turn, so no reading context reached the person. The gesture survives it and `commit` still resolves the key against the current turns behind the gate and generation (fixture: "a hide then show inside ONE flush"). A real hide then show, across tasks, retires through the gate edge.
- **Every loaded turn is reachable by touch.** Ticks compress the DRAWING (`tickCapacity`), never the turns. A press maps absolute once; after that the scrub is an integrator whose factor grows as the pointer slides away from the band (LEFT, toward the feed) (one pixel then moves at most one turn at the far end), carried across every change so nothing jumps. The price: after a fine excursion the lit preview tick and the finger can sit offset until the next press. `hub-turns.test.ts` reaches EVERY index with integer pointer positions, including feeds far above the band height squared.
- **Keyboard and assistive tech.** The band is `role="slider"` (vertical, `Tab` leaves, handled keys do not scroll the feed); focus-visible opens a preview of the current turn, ArrowUp/Down/Home/End move it, Enter or Space commits it, Escape closes it. `aria-valuenow`/`valuetext` follow the PREVIEW while one is open ("Turn N of M: label"). Focus never enters the popover (rows are not tabbable; a press on it never moves focus) and an outside press never steals focus back. A preview is a Hub back layer, right after the context menu.
- **The count is the LOADED feed.** "Turn N of M" counts the turns loaded; while older history can still load it reads `M+` and says so ("older history is not loaded yet"); never a total the feed does not know.
- **Unmeasured:** the Android system back-gesture edge zone, now at the RIGHT edge (the OS owns it on both edges, CSS cannot see it; the ticks now end 10px from the screen edge on touch, which puts a finger that aims at a tick inside the zone more often: the OS may take it as a back gesture, which arrives as a `pointercancel`, zero jump, already handled. This is the price of the owner's request, to be judged on the phone, and the touch value is one token to move back in; the whole column is not claimed to be outside the zone either); real touch on a phone (Chromium here has the mouse only: touch-action and capture are verified by computed style and by the mount fixtures, not by a finger); a classic scrollbar's width on a desktop (headless Chromium has none).

### Native resizing retains the last stable reading snapshot (#135, 2026-09-09)

Changing the callback alone cannot recover an old position. On Chromium
152.0.7977.64, the same compact 390 -> 370px experiment measured
519.1875px displacement with the old window callback, 519.1875px with only
`ResizeObserver` substituted, and 0.1875px when the prior stable snapshot
was supplied to the transaction. Both callbacks read the new box.

Feed now keeps one room/element-tagged reading snapshot and observes the
scrolling column's content box with one `ResizeObserver`. The window
resize listener is removed. Explicit drawer/history mutations capture a
fresh snapshot; native box changes supply the retained one to the SAME
`withReadingAnchor` transaction. Once its two Svelte settles and fold
measurement complete, a settled tail is written before paint, or the
history row is restored. Each await checks the captured room and element.

The snapshot uses the existing `ui/indicator.ts` `boxFromOffsets` layout
coordinates, not transformed client rectangles: caching mid-intro left
about 4.8px of animation in the initial prototype. Sticky rows, including
the filter label, cannot be references. The search walks from its previous
row, avoiding a whole-history scan on ordinary scroll frames. The native
resize acceptance bar is 1 CSS pixel, including offset rounding.

Scroll/settled render, disclosure, image and font updates maintain the
snapshot but do not introduce another resize writer. While box dimensions
differ, neither a queued capture nor a layout-generated scroll may replace
the pre-resize snapshot or the live tail decision. A completed transaction
records the new size, so the observer does not repeat a drawer's work.
Hidden views disconnect the observer and retain the snapshot; reconnecting
on show handles a size changed while hidden. A room reset clears it, and
zero-sized boxes never replace a usable snapshot.

The existing cached-image room-return gap/following issue was kept separate
as #137 (resource completion below). Resize tail checks first establish the
live-tail state; #135 did not fix that room-return behavior.

Verification: the original 519.1875px regression fails the 1px check before
the fix, then measures -0.8125px after it. Width/height changes, container-only
resizing, hidden/show, a native scroll clamp, filtered history, room resets
and established live tail pass across desktop/compact; the six-variant
reading matrix still passes. The negative control keeps RO but drops its
retained-snapshot argument: 519.1875px returns and fails. Restoring the
argument returns green. A mounted observer spy verifies one registration
across data updates and disposal on unmount; it does not simulate geometry.

### Image completion preserves live tail after settling (#137, 2026-09-09)

An image can acquire its intrinsic height after the room's initial tail
write. Feed's load/error capture previously only updated the reading
snapshot, leaving the physical tail behind. This is not cache-specific:
on Chromium 152.0.7977.64, a controlled cold HTTP image grew from a 2px
border-only box to 82px and left exactly 80px of gap. A decoded data-URL
room return reproduced the same gap intermittently; warm HTTP cache often
made the dimensions available before the initial write. Cached load events
still fired. `following` could remain true at the wrong physical position,
or a subsequent scroll could turn that gap into history intent.

Feed now captures the room, element and tail intent at resource completion,
awaits Svelte's `settled()` (capture precedes ChatImage's loaded/error update),
and uses the existing `writeTail` only if the identity and live intent still
hold. A history reader only updates the existing reading snapshot. The
writer's visibility gate still defers hidden jumps to the existing show
path. No timer, extra observer, image-size estimate or second tail writer
is introduced; `following`/`newBelow` remain parent-owned bindings.

The real-Hub mount regression fails before the fix and proves load/error
wiring and fallback-before-write ordering, without inventing jsdom geometry.
Chromium checks cold loads, HTTP/data cache returns, filtering/resizing before
return, native history scrolling with news, hidden loading/show and outgoing
room completion across desktop/compact and light/dark/reduced motion.
All 48 tail checks finish at 0px. Restoring only the old capture-handler
wiring fails the mounted regression and restores the 80px cold-load gap;
restoring the handler returns both checks to green. Node 22.23.2,
Svelte 5.53.5 and Vite 6.4.1 were used for the isolated build.

### A layout mutation goes through `withReadingAnchor`

the terminal drawer regrids the columns and every message rewraps, so the same scrollTop points at different content and the reader's message drifts (owner, 2026-08-20). Scroll anchoring is OFF on purpose (`overflow-anchor: none` ended the held-ask blink), so the helper re-anchors by hand — topmost visible block, same element back at the same offset after `tick()`, sticky variants skipped as references (a pinned rect does not move with the flow), tail stays tail. All drawer toggles route through `openDrawer`/`closeDrawer`; `Hub.source.test.ts` counts bare `termOpen =` writes.

**A font is a layout mutation that arrives through no other door** (board
#189, found by codex during #186). The reading transaction had three
entrances: a block change, the feed's own `ResizeObserver` (the container's
content box), and web-font completion (`document.fonts` `loadingdone` — which
only re-captured the reading). A global font-role change (`uiFont.set`, the
Settings font picker) rewrites `--font-ui` on `<html>`: every bubble re-wraps
and the scroll content grows, while the container does not resize, no block
changes, and a SYSTEM family fires no `document.fonts` event at all (0 events,
status `loaded`). Measured in Chromium 152 on the isolated Hub fixture, 24
messages: at 390×844 `uiFont.set("DejaVu Sans Mono")` grew `scrollHeight`
2563 → 2795 with `scrollTop` frozen at 1839 — a 232 px tail gap under a feed
that still believed it was `following` (so no to-tail control either); at
1440×900 the same swap left 28 px (codex's message set left 457 / 0). Now
`fonts.apply()` announces every role swap on `document` (`tmux:font`,
`FONT_CHANGE_EVENT`), and the Feed routes that event AND `fonts.loadingdone`
through the ONE `withReadingAnchor` transaction: following re-measures the
fold and re-takes the tail; a history reader keeps their row. After: gap 0 at
both sizes; a reader at scrollTop 300 kept their row at the same −71 px offset
through the swap. No timer, no second tail mechanism. `Hub.mount.test.ts`
drives the event with a grown `scrollHeight` (red on main with the measured
232 px gap) and, for the history reader, gives every row a box (100 px, then
120 px after the swap) so it asserts the reader is back on the SAME ROW at the
SAME OFFSET (row 3, 30 px in → scrollTop 390), not merely "not the tail"
(codex's P2 on the first cut); the live measurement above (−71 px → −71 px)
is the evidence that the stub's shape — rows grow, the offset holds — is
reality's. `Feed.source.test.ts` pins the single handler for both signals.

**The drawer has TWO partitions** (owner, 2026-08-28: "右侧边栏，可以展开文件浏览器的分区，类似展示 terminal 面板一样的逻辑"): `drawerView = 'term' | 'files'`, one width handle, a header toggle per partition (on the phone the files toggle JUMPS to the Files tab instead — the same translation the terminal toggle makes to the Terminal tab). The files partition embeds the REAL `Files` component (`session={selected}`, per-project cwd via its module-scoped parked map) in `singlePane` mode — the drawer is 320–900px of a WIDE window, so Files' window-width split heuristic lies there (owner, 2026-08-28: "类似手机的单页模式，不用做成左右分屏") — and its head carries a maximize button that hands the drawer's cwd, and the file it shows (#479), to the Files PAGE (`openFilesTab` → App sets `filesSession` + a `{path, file, n}` `navRequest` the page instance consumes; `loadDir` got a `seq` guard so the newest navigation always wins); the terminal body hides under `visibility: hidden`, never `display: none` — a re-laid-out terminal would resize the pane and make the agent repaint (the `.keep-rows` lesson) — and an Esc originating inside `.files-body` passes through (closing would unmount an open editor mid-edit), the same territory rule as `.xterm`.

### The drawer hands over the file it shows (#479, 2026-10-28)

The owner pressed the drawer head's maximize ("Open in Files tab") on a
playing video and the Files tab opened on the list: Hub passed
`drawerFilesDir` only, so the page's `navRequest` took its directory branch.
Files now exports `currentPath` beside `currentDir`, a read-only projection of
its own view (the file of a preview, editor or info card; '' in a listing and
the git/local views), and `onfiles` passes it as `openFilesTab`'s third
argument into the existing file branch (`openFileRef`). The player's own full
screen was not the cause: in headless Chromium 153 against main 3a10184b it
kept the preview on the page and in the drawer, leaving by the Exit button and
by `document.exitFullscreen()`, and across a 1920x1080 resize while in it. Not
measured: a real Escape (a synthetic one did not leave full screen there), the
Mac app, a real window full screen.

The same field rides Files' parked position, so a drawer that dies under a
760px window wakes on its file. The park is a PATH: the wake re-opens it
through `openFileRef` (stat, a fresh signature, no autoplay, never an edit
buffer), only after the follow rule kept the parked cwd and its listing
landed, and only if no navigation happened since: the wake holds the fileNav
generation taken right after the instance's own listing starts, and any
intent (a file, a link, a directory step, Back, a request) moves it. A choice
still waiting for its stat or content, or one that failed, is therefore never
taken back by the older park (review P1: checking only the view and cwd let
the wake reopen A over a B whose stat was in flight). A request is taken once
per server's Files record (`memory.consume`, by identity), not per instance:
the remounted drawer receives the `drawerFilesReq` its previous instance
already took, and replaying it overrode the file browsed since. So every
request is a new object; changing `n` on the same object asks nothing new. A
missing file shows the existing miss once. A session switch inside one Files
wakes the same way, so a project returns to its preview as well as its
directory: the park restores what it keeps, the cwd already comes back on a
switch, and dropping the file there would be a second rule (orchestrator
ruling, 2026-10-28). `Files.mount.test.ts` (remount cases)
and `Hub.mount.test.ts` (the real maximize) pin it.

### Drawer widths are bounded requests (#158, parent #154, 2026-09-10)

The open-drawer grid treated both side widths as fixed tracks. At 1000x800,
46px rail + 240px sidebar + 280px chat floor + 520px drawer reached 1086px;
maximize and close were outside the viewport. Both side tracks now use
`minmax(0, requested width)`. Chat keeps its 280px floor and takes the
remaining space. CSS allocates the available container width, without a
second sizing controller, breakpoint change or resize-triggered navigation.

Since board #174 the three tracks are always declared and each side track is
`minmax(0, requested × open factor)` — the factor (`--side-open`,
`--drawer-open`, registered `@property` numbers) is what the partition motion
animates, so the yield formula is the same at rest and mid-move; see
motion.md principle 8. The existing SideHandle still writes the requested
320-900px drawer width (default 520); the actual track can be smaller. Neither saved preference
is clamped by layout, so widening restores it. Both side tracks must yield:
at 761px with a 420px sidebar, yielding only the drawer leaves it 15px wide
and still loses its actions. The bounded grid gives each side 217.5px.
Explicit toggles retain `withReadingAnchor`; native track changes use Feed's
existing resize snapshot. Drawer mounts, terminal gates and Back are unchanged.

Chromium 152.0.7977.64, Node 22.23.2, Svelte 5.53.5 and Vite 6.4.1:
the actual worktree bundle at 1000x800 measures a 434px drawer ending at
1000px, with maximize at 926-954px and close at 962-990px. Desktop
761/800/1000/1440px, container-only resizing and SideHandle drag/key/reset
retain width preferences; 19 history-anchor checks stay within 0.5px and
live tail stays at tail. The source contract and real geometry fail first.
Restoring only the fixed sidebar fails the contract and puts close at
809-837px in the 761px browser case; restoring the bound passes both.
Twelve further light/dark desktop/compact fixture states mount Hub directly
from the `5d847127`-based worktree. Desktop header clicks exercise Terminal
and Files, then the Board button's `drawerView = 'board'` branch
(`.board-body`, with an empty route recorder). This checks that component
branch, not the full App's Board-tab handoff; the compact cases check only
Files handoff. Xterm retains its instance on switching/resizing, suppresses
hidden writes, replays on return and disposes on close. The browser fixtures
use fixed RPC responses. All 751 frontend tests, svelte-check and the
production build pass. No Android
or native desktop build was exercised.

### An image is a reference, never bytes

`tmm send --image <path|url>` (repeatable) resolves the reference for a reader who is elsewhere (URL passes through, `~` expands, relative → absolute against the agent's cwd) and appends `![](src)` to the body. The room stays a log — no base64 in a message. The HUMAN's half is the composer's `+` (owner, 2026-08-26; a low-presence transparent dashed circle, same day): ANY file type attaches. An image is downscaled client-side to ≤1568px long edge (Claude's optimal, under GPT's 2048 cap), encoded webp (jpeg where WebKit can't encode webp — the blob's type decides the extension) and lands as `<ws>/.tmm/uploads/<id>.<ext>`, referenced `![](path)`; every OTHER file (PDF…) lands BYTE-IDENTICAL as `<id>-<its_own_sanitized_name>` (`uploadFilePath` — de-spaced, separator-stripped; 32 MB cap per RPC). The composer NEVER shows the path (owner, 2026-08-26: "消息框内部不展示完整的上传图片的 markdown 格式路径，就用一个 Image 的 placeholder 代替"): attachments stage as THUMBNAILS under the textarea (44px, the picked file via object URL, numbered; a file keeps a name chip), ✕ unstages, a project switch clears the staging. POSITION is carried by a visible token: attaching inserts `[img:n]`/`[file:n]` at the CARET (owner, 2026-08-26: "要让我能够看到图片插入的相对位置在哪里" — a textarea cannot style spans, so the token IS the marker, matching the thumbnail's number badge), and send() swaps each token for `![](path)`/path IN PLACE so the prompt keeps the image exactly where the words put it; a token the user deleted falls back to appending its ref (an attachment never silently vanishes), removal strips the token, and a failed post restores chips and text. In the feed, an agent's images render INSIDE the bubble (`.shots` in `.m-body`, before the floated meta trailer); a human message's images are behind its fold (board #372, below; a sent `/command` folds on its ARGUMENTS only: a picture does not make a command fold, it follows the command's own folded state, shown when the arguments fit and behind Expand when they are cut, the same held or in flow): a folded one shows its words, an `[Image]` line (`[Image] ×2` for several) and Expand, and the strip appears only once it is expanded — the same in flow and when held. Self-gitignored dir; `imageId()` = time36 + uuid slice; send() delivers the PATH into the agent's pane like any other line. `splitImages` also extracts BARE image refs (http(s) URL or absolute/`~` path ending in an image extension, start-boundary-guarded so `/tmp/a b/shot.png` never yields a bogus `/shot.png`): alone-on-a-line folds into the image strip, mid-sentence keeps the prose AND renders, markdown+bare duplicates render once. The client pulls those refs out of the markdown (`splitImages`) rather than letting the renderer emit `<img>`, because a filesystem path is not a URL a webview can load: `http(s)`/`data:`/`blob:` go straight in, everything else streams through the signed `/dl` endpoint the file browser already uses, and an unresolvable ref renders as the ref itself. **The signature belongs to the FETCH, not to the render** (board #175, owner 2026-09-11: every older image in the room wore the amber failed chip — `ChatImage` minted the `/dl` URL the moment the message rendered while the `<img>` was `loading="lazy"`, so a message that landed while the reader was elsewhere was fetched minutes later with a signature that dies at 60 s, `DL_TOKEN_TTL_SECS`, → 403 → failed): the URL is minted when the image NEARS the viewport (an `IntersectionObserver`, root margin one screen — it IS the laziness, `loading="lazy"` is gone), a load error re-signs exactly once before the reference is declared failed (Files' re-sign-on-retry rule, never a loop), and the Lightbox receives a URL signed at the tap, never the thumbnail's. Pending, the host names the reference in grey; `ChatImage.mount.test.ts` drives a hand-made observer and counts signatures: none at render, one on intersection, one on error, one per view, none after the second error. Tapping a chat image opens the in-app `ui/Lightbox` (owner, 2026-08-26: "看图片的支持" — a new browser tab is not viewing): pinch-zoom/pan/double-tap/wheel, dismissed by backdrop tap (a tap whose gesture started unzoomed and did not change the zoom, #449; file-handling.md § An image preview opens the one Lightbox), Escape, ✕, the back gesture (topmost entry in Hub's onGoBack chain), or an unzoomed SWIPE — the drag carries the image, shrinks it and thins the backdrop with distance, releases past ~80px close it, short ones spring back (owner, 2026-08-27: "再一划这个图片，它就自动缩小了"). Feed images render as small THUMBNAILS (`.ci` ≤300×180 — the Lightbox is where an image gets big), composer attachment thumbs open the same viewer, and when a viewer is provided ChatImage renders a BUTTON, never an `<a>` — an anchor to a /dl URL is a tap away from a download ("不是说我点击图片去下载了一个图片"). Chat markdown renders LaTeX (same owner request): `core/markdown.ts` holes out code, feeds RAW TeX to KaTeX (all four delimiter families `$…$`/`$$…$$`/`\(…\)`/`\[…\]`), and splices the rendered HTML back AFTER marked so the escape can't touch it; dollar-inline follows the pandoc money guards so "costs $5, earns $10" stays prose, and no formula body may cross the `\x00` byte that marks a holed-out code span — `cost $5 and \`code\` is 3$` used to hand KaTeX the placeholder and lose the code (2026-09-03). KaTeX CSS is imported by Feed.svelte, never by markdown.ts (which runs under node --test). Link and image targets pass the scheme guard in `core/markedSafeUrl.ts` (see `conventions/frontend.md`, rule 13): text escaping alone does not protect an `href` attribute.

### A chat image's viewer can save its file (board #447, 2026-10-22)

Owner: "我在图片消息里，点开预览放大图片的时候，应该有可以直接下载的按钮". The thumbnail is still a BUTTON, never an `<a>`: a tap opens the viewer and never downloads. The viewer (`ui/Lightbox`) gets an explicit download control beside ✕, offered only when the picture is a SERVER FILE (a path reference). The URL the viewer shows and the reference its download saves are ONE record taken at the tap (`ChatImage.view()` takes `ref = src` before the signature is asked for; the Hub, like Board, accepts only the answer to the latest tap through `hub/view-claim.ts`), so a late signature or a changed prop cannot show one picture and save another. The download goes through the Files page's own attempt (`files/save-file.ts`): a fresh signature at the download tap, the same sinks, the same save path, the same Downloads record; its feedback is the one `OperationFeedback` inside the viewer, bound to that open. http(s), data and blob references (and the composer's attachment thumbnails, which are local blobs) show no control. The Hub retires an open viewer, its claim and its feedback on its own `visible && scope.eligible()` gate, because a hidden Hub is not destroyed. The rules and fixtures: file-handling.md § The viewer saves the file it shows.

### A path reference in a bubble is a DOOR, not a dead anchor

Agents talk in file paths — `[temp/AGENTS.global.draft.md](/local/…/temp/AGENTS.global.draft.md)` — and marked renders a schemeless href as a plain `<a>` the webview would 404 on. Board #99 (owner: "这种路径引用，最好能够点击直接右侧侧边栏文件预览打开"): the bubble's click handler consumes a PATH link first. `core/path-links.ts` owns the shared classification and path decoder: `#anchor`, `//host`, HTTP(S) and mailto keep their existing behavior, while paths lose `#Lnn` and grep-style `:line[:column]` suffixes. A relative path resolves against the project's DECLARED path (board #181; `fs_cwd` only for a session with no project declaration), captured at click time; `~` is expanded by the server. Desktop routes into the RIGHT DRAWER's embedded Files via `drawerFilesReq` (`{ file, n }`); compact hands off through `openFilesTab`. Files opens through its existing stat/previewability/recents path, positions the parent listing and retains the previous preview for Back. The path route wins over the bubble's tap-toggle (`.m-acts`).

Board #106 (2026-09-09, Chromium 152): ordinary clicks actually opened BOTH
Files and a browser tab, because the App capture handler externalized resolved
path hrefs before this bubble handler ran. External classification now uses
the literal URL, not a filesystem path resolved against the HTTP origin.
Primary, Cmd/Ctrl and middle clicks all use the shared path handler; Hub's
Back handler delegates into the Files drawer before closing it. See
[file-handling.md](file-handling.md#file-references-stay-in-files-106-2026-09-09)
for preview/iframe routing and the event-order evidence.

**A bare path is the same door (board #431, 2026-10-20).** The owner asked
for better recognition of the file paths in chat ("对聊天会话里出现的文件路径
链接内容做更好的识别 … 现在的文件路径识别还不完善"). Agents write paths as
plain text far more often than as links: `src/lib/hub/Feed.svelte:118`,
`/tmp/val422/h2/`, `~/.config/tmux-mobile/config.toml`. `core/path-grammar.ts`
defines what a path is, and `core/markedSafeUrl.ts` renders one as the SAME
`<a href="path">` a markdown path link produces. Everything above (the
decoder, `:line`, the project-relative resolution, the drawer/tab routing and
the click priority) is unchanged. There is one mechanism, so the feed scans
for nothing itself (pinned in `Feed.source.test.ts`).
- **The grammar** has four forms, each with an optional `:line[:col]`:
  absolute with at least two slashes (`/compact` stays a slash command), `~/…`,
  `./…` / `../…`, and workspace-relative (at least one slash, a file-like last
  segment, a first segment that is not a domain). Segments are ASCII; a path
  stops at a CJK or fullwidth character and never starts after a letter,
  digit, `/`, `.`, `:` or `@`. Dates, fractions, `and/or`, `github.com/a/b.js`
  and URL queries are not paths. The rows of `path-grammar.cases.json` are the
  contract, run by the TS test and by #432's Rust twin.
- **Where it applies:** prose, and an inline code span whose WHOLE content is
  one path (`cargo test src/a.rs` stays plain code, so a command stays a
  command to copy). A code span also takes a workspace DIRECTORY, two or more
  segments and a trailing slash (`lab/out/x_audition/`, board #443, owner
  2026-10-20 screenshot): backticks are the writer marking a name, while prose
  `foo/bar/` stays text because it is too often prose. `codeSpanPath` is that
  rule; a corpus row's optional `code` field pins it, and Rust's
  `code_span_path` reads the same rows, so Files mode lists the directory the
  bubble links (`message-paths.cases.json`). A linked
  code span already wears the link colour (`.md a`, measured in the running
  Hub, #443; the underline appears on hover only since #478). Fenced blocks are never linked, and neither is anything in
  a link's or an image's text: the decision is made at the token stage while
  marked still knows it is inside `[…](…)`, `[…][ref]` or `![…](…)`, so there
  is never a nested anchor (#431 review P1-B). At a URL the URL wins: the
  path tokenizer refuses at a scheme, and the URL tokenizer takes the whole
  URL.
- **The href** is encoded as a PATH, not a URL: a `%` in a file name stays a
  literal byte (`encodeHref(raw, 'path')`, no "undo double encoding"), so the
  click opens exactly the path that matched (#431 review P1-A). A trailing
  full stop is prose, but `..` and a lone `.` segment are never trimmed into
  another directory.
- **Nothing is checked at render time:** the link is a claim, Files is the
  truth. A missing path keeps the friendly "file missing" line (#99).
- **A directory link lists the directory** (Files, same issue). A link always
  opened as a FILE, so a directory landed on the file info card. Now
  `openEntry`'s linked branch sees the stat's `dir` type and lists it. From a
  preview, the link pushes a REAL directory-history entry that IS that
  preview (`fileNav.rememberLink`), even into the directory already listed.
  The entry also carries that preview's linked-file history, and popping it
  restores that history, so a file or a subdirectory opened in the linked
  listing cannot cut the preview off from where it came from (#431 review P1
  residual). So the
  toolbar Back, the shared/Android Back and the swipe all go through `popDir`,
  return to the preview, and continue to wherever that preview came from.
  From a listing, a link is an ordinary directory step. A depth mark standing
  in for an entry lost the chain (#431 review P1); `Files.mount.test.ts` pins
  the sequences: a same-directory link on an empty and a full history,
  preview -> linked preview -> directory, preview -> directory -> preview ->
  directory, a link then a directory by hand, a second link while listing,
  preview -> linked preview -> directory -> a file or a subdirectory -> Back,
  a late stat, and a late listing after Back.
- The same anchor appears in every markdown renderer (Files' markdown
  preview, skill previews), because they share `renderMarkdown`.
- **A tool call's argument shares the door (board #475, 2026-10-28).** The
  owner: "在工具调用栏里出现的路径，也支持直接点击预览". In the open run's rows
  (`read_file <path>`, `execute_bash cd <dir> && wc -l a/b.js`), the argument is
  scanned with the body's recogniser, `findPaths`, and each path becomes the
  same `<a href>` (`encodeHref(raw, 'path')`) the body writes. `pathLinkParts`
  in `core/path-links.ts` is that one wrapper; the feed holds no second
  recogniser, and a click goes through the lane's `openPathRef`, the bubble's
  one route, to `routePathRef`, so a row's path opens the same Files preview
  with the same payload as a path in a message, a directory its listing, `:12`
  dropped. Shape, not existence (the preview says when the file is missing).
  What is NOT a path stays text: `2>/dev/null` (no path starts after `>`), a
  URL, a word with a space in it. The collapsed head is a button, so its
  one-line peek stays plain text; no anchor lives inside it. On a fine
  pointer the lane is exactly what it was: one line per call, the argument
  cell the only scroller, `white-space: nowrap`, and a link has no layout of its
  own; its colour and its hover-only underline are app.css's one prose-link rule (#478). On touch (`any-pointer: coarse`, the
  capability query, not a 760px width) the rows change locally, accepted for
  the 44px touch target (design-language rule; reviewer ruling, 2026-10-28):
  the row takes `--control-height`, its argument cell fills it, and the
  anchor ITSELF is an in-flow box of that height and at least that width, so a
  short path (`/a/b`) is still a 44px target, neighbouring links never overlap
  and the extra width stays inside the argument scroller (a short path leaves
  a gap after it; an absolute overhang is not used: the scroller would clip it
  and it would cover the next row). The "N rows, then scroll" cap counts rows
  in one variable, `--step-row` (the row height plus its 2px gap), so taller
  rows do not turn "ten rows" into four. The tool name and the time stay
  outside the scroller, so focusing a link scrolls only the argument cell;
  a pan that starts on a link pans and does not open it. The lane hands a path
  click and a middle click to `openPathRef` BEFORE it stops the click for an
  attached run, so a path is the path's click and any other tap in the run is
  still not a tap on the message (no action row). A standalone tool group has
  no message bubble around it, so the lane's listeners are its only door.
  **A relative path is resolved against the project root, as in a message, and
  not against a `cd` earlier in the same command**: in `cd /other && wc -l
  worlds/uki.js` the second path opens `<project>/worlds/uki.js`, which may
  not be the file the command read. An absolute path is exact. No shell is
  interpreted and there is no second router; spaces, non-ASCII and redirect
  boundaries keep the message grammar's existing limits.

### A `#<id>` in a bubble is a door to that issue (board #340, 2026-10-15)

A `#<id>` a person or an agent writes in a message renders as a link
(`markIssueRefs`, `hub.ts`) only when the last board snapshot Hub read for
THIS project has that issue; any other number stays text (another project's
number, a typo, a CSS colour). The snapshot is not live: an issue deleted
after it stays a link until the next read, which then opens a board without
it. The reading is `issueSpans`: a `#` at
the start or after a character that is not part of a word, an HTML entity
(`&#39;`) or a path (`/#12`), followed by digits that end the word. Like a
mention it reads only text outside `code`, `pre` and `a`; both walk the
rendered HTML through the one `mapTextRuns`. A tap goes through the bubble's
one reference route (`openPathRef`, which now also routes an issue link):
the issue opens where a board line's jump opens it (desktop: the drawer's
Board; compact: `openBoardTab`), and the tap is not a tap on the bubble
(no action row). System lines are not linked: a board line carries its own
jump.

What Hub keeps for this (`issueBoards`, shared with the composer's `#`
palette; see hub-composer.md) is three things kept apart (reviewer P1 on
0d48bdda, where one "asked" set had made a single attempt a permanent
verdict: a timed-out first read, or a reference made before its issue was
filed, never linked):

- **Knowledge** is the last SUCCESSFUL snapshot of the project's board. A
  failed read writes nothing, so it never stands for "no such issue".
- **Reads** are numbered per project; an answer lands only if it is newer
  than the snapshot it would replace, so two reads finishing out of order
  never move the list back (P2-A).
- **Triggers** start a read: a `#` query being entered in the composer, and
  a MESSAGE naming an id above the snapshot's newest, once per message per
  visit (`issueTriggered`, cleared when the room is entered). Issue ids only
  grow, so within a successful snapshot a missing id at or below its newest
  was deleted; one above it may be filed later (an orchestrator files an
  issue, then names it), so a NEW message naming it, a revisit or a typed `#`
  asks again. Nothing retries by itself after a failure, and nothing polls.

The scan reads the raw message text, so a `#id` inside code can start a read
although it is never linked. A room whose messages name no issue reads no
board. Pinned by the Hub mount tests "a #id this project has is a link…",
"a failed board read is not a verdict…" and "two board reads finishing out
of order…", and the `issueSpans`/`markIssueRefs` unit test.

### Right-click and long press are ONE mechanism

`ui/ContextMenu.svelte` (the agent menu's popover dialect, anchored on a POINT via `placement.pointAnchor` — one placement rule with the trigger menus, but the DEFAULT alignment follows the anchor kind: a point puts the menu's TOP-LEFT at the click, the OS convention (owner, 2026-09-07: "应该都为左上角点"), while a trigger rect keeps the right-aligned dot-menu dialect; both flip above and clamp as before) + `ui/longpress.ts` (touch ONLY — a mouse has a right button, and a held left button would fire a menu mid-selection; >10px of travel is a SCROLL via the pure `isScroll`, a second finger cancels, and the following click is swallowed so a row does not both open its menu and activate itself). One App capture listener suppresses native browser context menus for every mouse/keyboard event: a surface opens its own shared menu or no-ops, never browser chrome. Wired to the agent card and the sidebar project row, each offering the verbs it ALREADY has elsewhere (a context menu with its own action set is a second source of truth). **Two reading verbs were unreachable and are menu rows now** (review, 2026-09-03): the one-agent feed FILTER (`filterBlocks`, board #3) existed only as an undocumented double-click on the card — and a selected card waits 260 ms for its menu, so the gesture fought the tap — so both card menus (the tap menu and the right-click/long-press ContextMenu, from the same `agentItems`) carry `Only its messages` / `Show everything` through ONE `toggleFilter`, a reading verb seated with Message/Watch before configure, offered for a STOPPED agent too (its history is what you narrow to once it is gone). Since board #482 showing a live agent also selects it as the recipient, and while one agent is shown no other target can be chosen and a send that reaches anyone else is refused (hub-composer.md § The reading filter locks the target); the double-click stays as the shortcut. And the feed's DETAIL LEVEL (`hubPrefs.feedLevel`: chat / + status / + tools) was reachable only from Settings, its Hub `cycleFeedLevel` control dead code: the project TITLE's menu — the one menu about "this conversation" — now lists the three levels between Rename and Close, the chosen one ticked (`check` vs hollow `circle`, radio semantics through icons the menu already has), writing the same pref Settings reads. Not a header switch: the header keeps no spare switches (board #72). **Only mine** (board #289, owner 2026-09-30: "消息比较多不太好筛选，很多都是 Agent 之间的会话") sits right after the three levels in that same menu, a toggle ticked while on. It is the SAME reading filter with the human as its subject (`toggleFilter(HUMAN)`, `filterBlocks(blocks, 'human')`): the human's own messages, a message whose recorded `to` names the human (an agent's final reply to a turn the human asked in, agent-status.md § reply edge; an `@human` send), and a body that says `@human`. `@all` means every agent and does not count; the human has no window, so no prompt/progress/steps block shows; sys lines stay only where they name the human. Being the one filter state, Only mine and an agent's "Only its messages" exclude each other, the room switch resets it, and Back peels it. No agent card wears the filter mark for it (the roster gets no filter while it is on): its state is the tick. Rows recorded before #289 carry no `to` for a reply, so older agent answers are not matched. `Hub.source.test.ts` pins both routes and that the cycle control stays gone. The message bubble has NO context menu (board #48; owner, 2026-09-04: "点击消息气泡，还是会呼出一个类似右键的 Copy 选项卡菜单……其实我们都不要了", then 2026-09-07: "我只要消息气泡下边的这两个按钮，不要出现右键那种选项卡"): its verbs live ONLY in the tap-revealed `.m-acts` row under the bubble (Copy / Raw / Reply — Reply since board #290, a quote by content, hub-composer.md § A reply quotes a message; a body carrying the quote token renders it as the bubble's own blockquote; Raw wears the `code` `</>` glyph since board #218 — owner 2026-09-20: "raw 的图标我理解不了，可以用类似源码的图标"; the ⌘ it replaced read as a key and left with it) — no `openCtx` from a bubble, no desktop right-click card. The bubble's `contextmenu` handler never calls preventDefault: it only arms the passive `selectionClickGuard` mark, so a touch/pen hold stays the system's selection gesture and its Android/WebKit compatibility click is consumed before it can open the row; a genuinely non-collapsed selection independently wins over any bubble tap. Message bodies explicitly opt into text selection. Board notes keep the same passive mark/consume `selectionClickGuard` for their `.m-acts` Copy overlay.

### The feed has no holes: an incremental poll walks back to its cursor

`loadFeed` polls `hub_log(since_ts = lastTs)` and the server answers the NEWEST page minus what is older than the cursor. When more than a page arrived since the cursor — a room parked in `roomCache` while the team talked, because `onPush` merges only the selected room — the older new rows were not on the page and `lastTs` jumped past them: a permanent hole until reload (review C, 2026-09-03). On a `since_ts` query the server's `has_more` now means "newer-than-cursor rows remain behind this page" (true only while the RAW page did not reach back to `since_ts`; the API contract row spells it out), and the client walks `before_seq` pages from `oldest_seq` — `gapWalkStep()` (pure + tested) decides per page which rows are new and whether to continue — until a page reaches the cursor, merging by id through `mergeMessages`. Bounded at 50 pages; the first load keeps its paging meaning. The gap's messages are history that arrived unwatched, so they do not raise the new-message cue — the poll's own batch does that once.

**Gap-walk ownership** (board #118, 2026-09-09): `hub-history.ts` owns only
the existing 50-page loop, with captured session, timestamp floor and starting
cursor, plus `readPage`/`stillCurrent`/`mergePage` callbacks. `gapWalkStep`
remains the sole page decision in `hub.ts`. Pages merge as they arrive, before
the next read; empty pages stop, errors propagate, and a stale reply returns
false without merging. Hub keeps the RPC's 100-row size, feed/cache ownership,
`loadOlder`, first-page handling, notifications and the final poll batch.
The helper adds a return-await boundary, so Hub rechecks the room there too
before adopting that batch. Unit tests cover order, dedupe, stop conditions,
the exact bound and room changes at each read await; source checks pin the
coordinator boundary. No new history store or replay mechanism is introduced.

### The trace is COMPLETE; the READ is what is bounded (board #9; moved from tmm-cli.md, board #102)

The two pulls — "记录完整" and "不要过多地占用前端和网络通信的资源" (owner, 2026-08-29) — conflict only if one number bounds both, which the old design did. **Retention is GONE, not configurable-and-defaulted-off**: `KEEP_EVENTS` (2000/session, pruned every 256 inserts) stood to delete the older half of the busiest session (4046 rows at the audit), postponed only by restarts resetting the per-process prune counter — an accident, not a policy — and a deleted row is indistinguishable from an event that never happened, which is what makes a trace unanalysable. The recorder prunes NOTHING and a `telemetry.rs` source test stands guard (no prune call in the write path, no private env knob); a future retention belongs in `Config` with a documented key. **The cost moved to the read**: both feeds page backwards with their old newest-page defaults intact — `hub_log` on the store's `seq` (stable, gapless per room, already on every message a client holds; a millisecond timestamp is none of those), `hub_activity` on `(ts, id)` (a busy turn writes several events per millisecond, so ts alone skips or loops); `message_by_id` is an exact indexed lookup, never a page scan ("the newest 1000" is not a place where correctness may live); `has_more` is MEASURED (each store call asks for limit+1); a page that loses every row to the archive/since_ts filters still hands back a cursor (`oldest_seq` prefers a survivor, falls back to the RAW page's oldest — `has_more: true` with no cursor is a walk that stops dead); limits are capped server-side so one RPC can never become a multi-megabyte frame; the delivery sweep runs on the LIVE page only. Verified live against the real databases: the busiest session's whole log walked in 22 pages of 200 with no duplicate and no gap; two deliberate truncations remain (a prompt event keeps 1024 chars, a tool event 2048 of its argument — what an agent SAID is a message and is never truncated).

### The terminal drawer has ONE switcher, and it shows agents (moved from tmm-cli.md, board #102)

Before the Drawer view extraction (#136, 2026-09-09), its shared `.spacer`
and `.empty` rules move once into `hub-atoms.css`. The selectors retain the
former two-class specificity and name only the existing direct parents:
page/drawer heads for the filler, feed/terminal body for the empty state.
Embedded pages do not inherit a generic override and no component copies
the declarations.

**Drawer view ownership** (#136, 2026-09-09): `Drawer.svelte` owns the
unchanged section, private CSS, window-list derivations and window hover
description. Hub keeps the `termOpen && !compact` mount gate, all persistent
open/view/target/request/expanded state, per-room preferences, navigation
commands and capture listeners. The view emits narrow pick/expand/close/
maximize/new-issue intents. Files' current directory remains one controlled
binding and its Back callback still reaches the parent dispatcher.

The real Terminal remains keyed only by `termTarget`, laid out while another
partition is visible, and receives the original active/visible gates.
Files and Board retain their existing conditional mounts, and Board gains
no Back delegation. Shared SideHandle, status dots and one-header rules
remain the same mechanisms. The optional ~60-line agent picker stays with
spawn coordination: moving it would add a wide interface for little
reduction, and it does not justify a HubDialogs wrapper around shared dialogs.

Verification on Node 22.23.2 / Svelte 5.53.5 / Vite 6.4.1: four moved
declarations/functions, all 43 retained functions and the 11 Hub effects
match their prior bodies; the 16 private CSS rules form an exact partition.
Chromium 152.0.7977.64 uses the real Terminal/Files/Board and xterm 6.0.0,
with only fixed RPC responses and build-layer instance/write counters.
Six variants cover target-key replacement, hidden-frame suppression and
replay, window folding, native modified links, Files Back, navigation,
per-room restore and the actual SideHandle drag/reset. All 42 captured
layout/style signatures match. The negative control passes a hidden
terminal `visible=true`: its write count rises from 2 to 3 on a hidden frame
and the assertion fails. Restoring the partition gate returns green.

The drawer's single bar is the window pills (state dot, name, `direct` tag) + open-full/close. It carries no roster count: the "N · M running" the retired statusline left behind was removed (board #338, owner: it takes room the pills need), and the pills' live dots are the one running cue — `stateIsLive` decides them, the same function the Feed's steps-group live pulse uses (board #179: a private `=== 'working'`, the pre-2026-08 name of today's `running`, showed "3 · 0 running" beside a live dot; that count is gone, the dot's definition stays). `Drawer.render.ts` renders running + waiting + legacy working and pins both halves: no count in the head, and live dots on running and legacy working only. `Drawer` is not handed `managedAgents` any more (pinned in `Hub.source.test.ts`); the tmux-style statusline underneath was merged away (owner: "上面和下面有两个 bar…可以把它们合并一下" — it listed the same windows and called the same `pickWindow`; the pills carry state and actions, so they survived). The bar shows AGENT windows only (board #92: "只 filter 出当前有效的 agent window，其他 window 可以帮我折叠起来"): shells fold behind a `+N` pill of the same family, one tap unfolds (the pill becomes `−`), a room switch folds back — with two exceptions, both in ONE pure function `hub.ts drawerWindowPills`: the window the terminal is currently SHOWING keeps its pill even inside the folded set, because the bar may never hide the current pane; and the project's SHELL window — the lowest-indexed non-agent window, the one `up` creates first, derived rather than assumed to be 0 — is always the FIRST pill and never counted in `+N` (board #320, owner 2026-10-08: "我想要窗口里可以呼出一个终端用，好像就类似于你启动的项目里有一个0的 window，这个在侧边栏应该不要自动给我hide起来，让我更容易用到"); a session with no non-agent window gets no pill for it. Other shells still fold — #92's intent, agents visible and noise folded, stands. While the partition is open, selecting an agent in the chat (card click, composer picker, "talk to") retargets the drawer to that agent's window through the same `pickWindow` (board #91) — choosing who you talk to is choosing whose pane you watch, the reading `openDrawer` already makes when it seats the recipient's window first (board #76); it only follows a name that matches a roster window (@all and the room do not) and never opens a closed drawer. **Whose pane the partition shows has ONE definition, `pickDrawerAgent(agents, recipient)` in hub.ts** (board #209, owner 2026-09-20: "chat 切换别的 project，再回来的时候，选中的 agent card，好像保留了，但是右边侧边栏对应的 terminal 好像没有保留到我选的 agent，这样左右不同步了"): the recipient's managed window when the recipient is a named agent, else the first managed agent, else anything. `openDrawer` (#76) and the #91 retarget always said so, but the room-switch restore in `selectProject` and the late seat in `loadDetails` (a first visit after reload restores before any roster exists) each carried a private `agents.find(managed) ?? agents[0]` — so returning to a room restored the SELECTED card from `hubPrefs.lead` and seated the pane beside the FIRST managed agent. All three now ask the one function; `termTarget` is never persisted, it is derived from the recipient (tenet 8). Measured on the live server (kiro is window 3, claude window 2 = first managed): select kiro, open the partition, switch to another project and back — main: card kiro, pane `2:claude`; fixed: card kiro, pane `3:kiro`; with All or the room selected, back seats `2:claude` (no single recipient → the old default). The divider is a real splitter: the drawer column is `var(--hub-drawer-w)` (320–900, default 520, persisted `tmux_hub_drawer_w`), reusing the parametric `SideHandle` (ONE resize affordance, ui-unification) — it was a fixed grid that looked draggable and was not.

### The chat header opens, closes and NAMES the project (moved from tmm-cli.md, board #102)

The header carries exactly ONE of Open (`project_up`, no live session) or Close (`project_down`, session up) — only Open existed, and the owner could not close a project from the chat; Close confirms like stopping an agent (it kills every pane) and the copy says what survives. Beside the title sits the FULL path, not `shortPath`'s stub — whole when it fits, a hidden-scrollbar horizontal scroller when not (owner's three rules verbatim: "展示得下完整展示 / 展示不下再隐藏 / 支持滑动查看，不要省略号", 2026-08-20), `wheelX` pans it, `user-select:text` overrides the shell so a drag selects, and double-click selects + copies the exact untruncated value through `copyText`. Desktop only — the phone header never showed the path. `project_create`'s session name follows the NAME when given (`session ?? name ?? basename(path)`) — it fell through to the folder, so `--name closetest` made a session called `tmp`, the same folder-name-wins bug the Hub dialog hit from the other side.

### The Hub searches the room's history from its header (board #432, 2026-10-20)

Owner, 2026-10-20: "增加搜索功能，比如有一个搜索的按钮，点开放大成一个搜索框，然后模糊搜索关键字". A search icon is the FIRST of the header's tools. It opens a field that covers the header row (`HubSearch.svelte`, an OVERLAY: the title, path and tools underneath are not moved or resized), and the results are a popover of the notification centre's dialect (`menu-surface`/`menu-list`/`pop-layer`, `menuPlacement`), not a new species. Mechanisms, not looks:

- **One search, extended.** The box asks `hub_search` (the RPC `tmm log --grep` already uses) with `all: true`: every word must match, so typing another word NARROWS, which is what a search box does. The RPC default and `tmm log --grep` stay any-term; `tmm log --grep a --grep b --all` gives an agent the same power. "Fuzzy" is defined, not implied: a case-insensitive substring of every term, in the body or the sender. There is no Unicode case folding: SQLite's `lower()` is ASCII-only and folding would need a Cargo feature for letters this chat does not hold; CJK has no case.
- **Newest first, in the UI only.** The server answers oldest first (its contract is shared with `tmm log`); the list reverses it, because a search answers "where did I see that", usually recently, and the page cap should cut the OLD end. `more` (older hits exist) is said under the list, and the way to reach them is another word.
- **A tap is the bell's jump.** A hit opens through the same `openAt` as a notification-centre row (room switch, one page around the message as a history window, the filter cleared visibly, the ring), but it is not a notification: nothing is recorded in the AlertLog and no bell or unread state moves. `openAt` reports through a `report` its asker may bring; the bell's is the AlertLog entry by key, the search's is bound to the search generation that asked.
- **One lifecycle, written as rules** (`hub-search.svelte.ts`). Every change that makes an answer wrong (the query, the scope, closing, choosing another project) bumps a generation SYNCHRONOUSLY at the input; the debounce only delays SENDING, so there is no window in which an old answer lands in a newer query's panel. A stale answer is dropped: it neither fills nor clears. A failure keeps the previous rows with the label of the query they answered (`Results for “x” · this room`); it is an error with Retry, never "No matches". An error from the store reaches the box as an error: `search_messages` used to end in `unwrap_or_default()`, so a broken database read as an empty room. A jump's report counts only for the generation that started it, and the room it changes does not close the box (a reader's own project choice does).
- **Collapse follows the region, not the input.** The region is the bar AND the results. A focus move between its parts (Tab to the scope control, a click on bare space in the results, a result button) is not leaving; an EMPTY box collapses when focus leaves them all or on Escape, a typed query never collapses on blur, and an outside press hides only the results. Escape belongs to an IME while it composes, and is consumed here so a dialog behind it does not also close. Both surfaces are focusable containers, which is what makes a mouse click on non-focusable space land focus inside.
- **The composer is not involved.** The field has its own value; opening it focuses it, closing returns focus to whatever held it (the composer included, caret intact). Only one popover at a time: opening the search dismisses the bell's centre, and the centre opening dismisses the search.
- **Motion** is the shared `.appear` fade on the overlay and the `.pop-layer` intro on the results: no width or height is animated (motion.md §3), so the feed and the title do not shift.

- **The agent filter lives in the search button** (board #432, owner 2026-10-20: "原来过滤某一个agent的选项应该也融合到这个搜索按钮里边，比如双击agent，这个按钮就变成这个agent过滤了，原来的标识不要了"). There is still ONE state, `filterAgent`, and ONE writer, `Hub.setFilter(next, source)`: the card's double-click, its ContextMenu item (the touch and keyboard door), "Only mine", the token's x, Backspace in an empty field and Back all end there. The funnel glyph on the card is gone; the dimming of the other cards stays, because it is how a reader finds the card to double-click again. While a filter is on, the search button is a chip with the agent's name in its hue ("you" for Only mine), and the open box shows it as a token. The filter scopes the search by SENDER (`hub_search` `from`): the feed filter shows the agent's THREAD (its messages, messages that mention it, its tool and prompt activity), the search asks what that agent SAID, and the results label says `from kiro` so the two are not mistaken; `@kiro` is a plain search. Closing the box never clears the filter (it is a reading state of the room, not part of the box); Back closes the box first, then peels the filter. The filter is part of the request: a change by the USER (another card, the x, Back) bumps the generation at once and CANCELS the jump the box owns. The one exception is the filter clear that jump's own `openAt` performs: `setFilter(…, { jump: n })` with the n the box owns is adopted without a new generation, so the jump can land and report. The exception is bound to that one verified jump, never to "a jump is pending".
- **A search-owned jump is cancelled, not just unreported.** The box remembers the centre n of the jump it started (`ownedJump`) and consumes it when its generation goes stale, so a late `hubLogAround` answer cannot replace the feed, clear the filter or scroll; a bell jump has another n and is never touched. A room change closes the box unless it is the one made by that jump (`selectProject(session, claim)`). App keeps every server's Hub alive and only toggles it, so `visible=false` or a server that lost the focus disposes the box at once (timer cleared, generation bumped, jump cancelled), and destroying the Hub does the same.

- **Files mode lists the files the chat names** (owner 2026-10-20: "列出产出的资源文件之类的"). The popover head holds ONE Segmented, Messages | Files (the existing control, not a tab strip). Files asks the same `hub_search` door with `files: true`; no word is needed (an empty box lists every file, an agent token alone lists that agent's), and words narrow the PATHS, ASCII-case-insensitively, `all` as in Messages. Rust is the only implementation of "what a message mentions" (`message_paths.rs`, one grammar with the renderer's link detection, #431); the list is a NAMED SUBSET of what the feed links, never "the exact set". Its closed gap list, pinned by the shared corpus `message-paths.cases.json` (the renderer's real output on one side, `paths_in_body` on the other): reference-style links, a path glued to an emphasis marker, link text holding brackets, indented lines, link titles. A fenced block, a URL, link text and an image are not mentions, and a URL swallows what is inside it: `https://h.dev/?q=[x](README.md)` is one external link, so the bracket and the backtick spans inside it list nothing. The renderer's tokenizers race by START, so a URL that begins inside a code span or a link (`[https://h.dev/a](docs/x.md)`) belongs to that construct and the link still lists; `hole_urls` decides this left to right before any other pass, and leaves an inert filler (`URL_HOLE`), not a region: a formula (`\(https://h.dev/a src/file.rs\)`, `$…$`, `$$…$$`) or a fence that CONTAINS a URL is still that formula or fence, and the path next to the URL inside it is not listed. A link target is read the way marked reads it: a backslash before ASCII punctuation is that character (`docs/a\_b.md` opens `docs/a_b.md`). The note under the rows says so in one line and says how many messages were read.
- **A row is the file's newest mention.** Dedup is by the path for an absolute or `~` path (one row wherever it was named) and by (room, path) for a relative one (`./x` and `x` are one file); `count` adds every mention in the range read, which is said as "in the N newest messages", never "ever". A row shows the name (and `:line:col` when the mention carried one), the folder, who, when, the project when "All rooms" is on, and a chat button that jumps to the message through the same `openAt` as a result. Tapping the row opens the file against the project that NAMED it, never the selected one. Each row is stamped, when its page lands, with that project as the Hub knows it then (`source`: id, session, declared folder); opening checks it is still the very same project (id, session, folder and room) at the click and again after any lookup, and otherwise says "That project has changed since this list was made" and opens nothing (the 20-second project refresh does not touch the search, so a list can outlive its project). Resolution: a relative path is that project's, resolved against its declared folder (else `fsCwd` of that session); the selected project's file takes the feed's own route (the drawer, or the Files page on a phone), another project's opens on the Files page with its own session. A file whose folder was still being asked when the box closed, or when the project changed, is not opened.
- **Pages never split a message.** The server scans candidate messages (`body` holding `/` or `](`, not archived) newest to oldest and stops AFTER the message that brings the page to `limit` distinct files, or after 5000 messages, returning `next` (that message's seq) as the cursor. "Read older messages" asks the next page with `before_seq`, which is the SAME question and folds into the rows by key. A cursor belongs to the answer that returned it: the button exists only while the rows on screen answer the CURRENT question (`canOlder`, `answerGen === gen`), so after a word, a scope, an agent or a mode change, or while the new question is pending or failed, the old rows are labelled and cannot be read on from; an older page in flight is dropped by the change. A page can hold no file and still have a cursor, which the box shows as "No files named here" with the button. `tmm log --files [--grep word…] [--from name] [--global] [--before N]` is the same list for an agent, following the cursor up to `--limit` files or 20 pages; a run that stopped early prints the `--before` to continue with (and `next` in `--output json`). **A gateway that predates Files mode cannot be told from its answer alone**: it refuses the EMPTY search (the default way into Files) as a bad request before it looks at `files`, and answers a worded one with messages. So Files asks for the login cap `hub_files` first (`hubFiles` in ws-api; `tmm log --files` through `rpc_needing`) and says "this server cannot list files yet" without sending anything; the answer's shape is still checked at the door (`filesAnswer`, `files_page`) as the second line, and never reads as an empty list. The last good rows are kept.

Reasons: a search hit that wrote an AlertLog entry would have rung the bell for something the reader asked for; a debounce that delayed invalidation lets last keystroke's answer land under this keystroke's query; a blur-driven collapse would close the box before the click on a result lands. Pinned by `hub-search.test.ts`, `hub-search.server.test.ts`, `HubSearch.mount.test.ts`, `HubSearch.source.test.ts` and the Hub mount tests marked #432; the server half by `hub_search_*` and `hub_files_*` in `store/rooms.rs` and `hub_rpc.rs`, the grammar by `message-paths.test.ts` and `message_paths.rs` over the shared corpus.

### The feed's per-poll work is bounded by what changed, not by how much history is loaded

Four costs grew with paged history and were paid on every 5–10 s tick or scroll event (review C, 2026-09-03): (1) `onFeedScroll` ran `syncAsk` — write `position:static` on the stickies, read every `[data-ask]` box, write it back — plus `autoRefold`'s queries synchronously per scroll event, several times a frame under momentum; it now coalesces everything after the `following` decision into ONE pending `requestAnimationFrame` (the browser lays out once per frame anyway; the 16px direction hysteresis works on the frame's net delta, which is what it meant). (2) `feedBlocks` paired every app-echo with every message and re-ran `squashWs` per PAIR — P × M regex passes per tick; `squashOf` caches the squash per OBJECT in a WeakMap (messages and events are stable objects across polls because `mergeMessages`/`mergeEvents` keep the existing ones), and a test pins that the blocks are identical for the same objects twice and for fresh copies. (3) `core/markdown.ts` cleared its WHOLE cache past 500 bodies, so a long feed re-parsed everything with marked + KaTeX until it refilled; it is a `core/lru.ts` LRU now (evict one oldest; a hit refreshes), same bound. (4) `onPush` called `hub_agents` per pushed message — a burst of 30 was 30 RPCs; a message IS a turn edge so the roster refresh stays (the 5 s poll would lag), but through one trailing 300 ms debounce, cleared with the listener.

**Typing must not wait for a poll on a bad link** (board #444, owner 2026-10-20: "在手机上网络连接比较差的时候，在 chat 界面输入感觉一卡一卡的"). Typing sends nothing; the cost is the main thread. The rig (`/tmp/builder444` on the issue: a TCP shaping proxy between the page and the gateway with delay, jitter, 20 KB/s and a 2.5 s stall every 5 s; Chromium at 390 px with 6x CPU; real key events and pinyin IME composition) found that the poll answers queued during a stall land together and are decoded and dispatched back to back while the person types. **One read of a kind in flight per context, owned by the read** (`core/poll.ts`): every polled read is a `single(task, key)` loader (Hub's list, and its feed, activity and roster per room; Board's projects and issues; Terminal's window list; Sessions' list), and every entry calls it: the timer's ticks, the first read on entering a room, a push, a refresh after an action. setInterval had put two `hub_agents` and two `hub_activity` requests on an 8 s stall, both answered at once on recovery. The state is the read's, not a timer's (#444 review P1-A): hiding and showing the page restarts the timers but not the read. A tick while the read is pending is skipped, never queued; the next tick asks again. A read that must see what happened before it was asked (an entry, a push, which is a turn edge, a refresh after an action) waits for the pending one and the callers that came meanwhile share ONE follow-up read: never dropped, never doubled. A read for another context starts at once, so a room switch never waits behind the old room's answer, which the loaders' own generation checks drop; no lock spans rooms. The task reads the CURRENT context when it starts, so a queued read whose room was left by its turn RETIRES instead of running (its callers resolve): it would otherwise ask for the new room under the old room's key, beside the new room's own read (#444 review P1-A residual); back in the room before its turn, it runs for that room. A loader is disposed with its page, and a read queued then is never sent. A failure is the read's, and each caller decides what it means (#444 review P1-B): the task throws, `loader({ report: true })` (the refresh after an action) rejects with it and shows "refreshing failed", any other caller swallows it, so a push that joined the read cannot turn the refresh's failure into a success. Arguments are not merged: a loader takes none but `report`. A read ends when its RPC settles, and the client's 6 s RPC timeout settles it: on a link that stalls longer than that, the next tick may ask again while the timed-out request's answer is still on the wire (measured on the #444 rig, 8 s stalls: up to two requests per method on the wire). That late answer is decrypted and dropped by the RPC layer (`connection.ts`: no pending id), never dispatched into the page's state. Terminal had its own guard; it is gone. Pinned by `poll.test.ts`, `poll.source.test.ts` (every polled read is a loader, nothing calls its raw read around it, every timer is `poll(loader.tick)`, any other interval is a clock tick or a key repeat) and held-answer Hub mounts: pending → hide → show, the first read crossing the first tick, a push during a pending roster read, a project switch beside a pending read, a queued read retiring when its room is left (the new room keeps one read in flight), A → B → A (the queued read runs for A once), a read queued when the Hub goes away (never sent), and a refresh after an action sharing a failed read with a push in either order (the failure is shown); the #167 mutation-refresh mounts (Hub, Board) now see the second refresh as the one follow-up. **A poll answer that changes nothing assigns nothing** (`core/adopt.ts`, the one content check at the store boundary): Hub keeps the CURRENT value of `agents`, `stoppedTeams`, `agentStates`, `feed`, `talkMap`, `rows`, `trash` and `panes` when the answer has the same JSON content, so the `$state` assignment is a no-op. Every 5 s `hub_agents` answered the same roster as a new array, and everything that reads it ran again: `feedBlocks` over the whole loaded history (it resolves senders through `agents`), the Feed's `syncAsk` layout, the roster and the completion lists. At 6x CPU with nobody typing that was 1152-1186 ms of main-thread blocking per 40 s; with `adopt`, 5-276 ms. Pinned by `adopt.test.ts` (content, not reference or key order; any difference adopts the answer; every Hub poll assignment goes through it). The steady per-key part is the composer's measurement, now once per frame (hub-composer.md § the measurement runs once per frame).

### Messages are NOT deletable in the UI; projects delete through a recycle bin

the two-step message archive (2026-08-19) was retired on owner request (2026-08-21, "没有消息删除 不需要这个功能，彻底去掉吧") — a tapped message offers exactly Copy and Raw, and the room stays the record. The `hub_msg_archive/restore/purge` RPCs, the `msg_archive` snapshot table (state.db v10) and `hub_log`'s filter against `projects::archived_ids` all REMAIN as server API (an older client's hidden messages stay hidden; purge deletes from the room's own store — state.db `hub_msgs` since board #107 — messages first, archive rows after).

### The sidebar is ordered: open projects first, then by activity

**Since 2026-09-23** (owner: "已打开的优先排在前面，没有打开的排在后面；然后
分别按照时间由近到远进行排序"; the report: a project just created, still
without an agent, "直接排到后面了"): `sortRows` puts live projects before
closed ones and orders each group by ACTIVITY, newest first — the newest of
the room's last message and the project's `last_up_at`/`created_at`. A fresh
empty project therefore heads its group. The conversation-only order below
is what it supersedes; its reason for refusing `last_seen_at` still holds
and still applies. The same day the three project sidebars — Chat, Terminal,
Board — moved the open row's wash onto ONE travelling `.slide-pill.soft`
placed by `slideIndicator` (motion principle 14: "阴影直接滑动过来"), so
picking another project glides the wash there instead of one row switching
off and another on; the rows keep `.open` for state and draw no wash in
place. Chat's and Terminal's **New project** command sits at the head of
the list as an `icon-btn` ("每次还得滚动到最下边才能新建"); the Terminal's
foot row remains only while there is no list to head. The row's ⋯ rides
the TITLE line (2026-09-24, "三个小点…挤占了底下列出的 Agent 的空间…放到标题
行"): as a column beside the whole row it took 24px + 8px from every agent
line as well — measured 157px of 203px for the chips; now the chips take the
full 189px and only the title line keeps the room. It is absolute (a pick
button cannot nest a menu button), centred on the 20px title line at
`top: 6px`; `.proj-row:has(.row-menu)` scopes the room, so Board rows, which
have no menu, reserve nothing. The Terminal's dense rows follow the same rule.

### The conversation order it replaced (2026-08-19 → 2026-09-23)

`sortRows(rows, talk)` sorts by the newest message per room (`hub_rooms` → one `SELECT room, MAX(ts) … GROUP BY room`, answered BEFORE `handle_hub_request`'s session gate because it is about every room), because `last_seen_at` is rewritten by the capturer on every tick — for a live project it always means "just now", so every live project floated to the top in whatever order tmux was captured, which is no signal at all (owner, 2026-08-19: "把我们最近的对话默认排在最上面"). Projects nobody has talked in keep the old rule underneath (live first, then `last_seen_at`): there is no conversation to order them by and they must not outrank one that exists. Two traps, both tested: the projects table is in SECONDS and the bus in MILLISECONDS, and a row with no `room` falls back to `proj:<session>`. Chat, Terminal and Board all load the grouped map and render `projectAgeLabel(row, talk, now)`: conversation timestamp first, tmux last-seen/up/creation only when no room has spoken, one formatter everywhere. The optional `talk` default survives only for callers on a server without Hub support.

**And each row is a SUMMARY, not just a name** (owner, 2026-08-24: "上次回复的时间 … 当前几个 Agent 的简单 logo 状态"; then "应该和terminal侧边栏一样 … 这两个可以共用"): the same `talk` map renders the last-reply time on the row (`agoShort` — ONE unit, "5m"/"2h"/"3d"; `fmtElapsed`'s "2h14m" is running-timer language), and under the name sit the project's agents as quiet mono chips (11px backend logo + name + a chat-only state dot in the one status language). The LOOK is shared with the Terminal sidebar by construction: `.side-age`/`.side-win(-name/-dot)`/`.side-wins` live in app.css next to `.side-h`/`.side-row`, both sidebars wear them (Projects.svelte dense mode swaps its scoped `.win`/`.age` classes for the shared ones), and `ui/sidebar.source.test.ts` forbids either component from restyling the atoms — a scoped rule outranks app.css silently, which is the drift that split the two headers. A component may only POSITION the shared containers (the Terminal's `.wins-indent`). States for ALL projects come on `hub_rooms` itself (`telemetry::all_states` — pure memory, derive over every hook-known window, no tmux call, no sniff; a window with no hook facts is absent, and the client reads absence as idle). A LIVE row reads its real windows via the window switcher's own `paneAgent` detection; a CLOSED row shows its DECLARED agent slots dimmed with no dot — a roster `up` would restore, not anything running.

**Sidebar summary ownership** (board #121, 2026-09-09): `sidebar.ts` owns
`rowAgents` and `rowAgentCounts`, with explicit row, pane and state-map inputs.
A row lists EVERY agent — live windows for a live project, declared agent
slots for a closed one — wrapping in `.side-wins`; the hover card adds the
live/stopped split. There is no chip cap: the four-chip cap it had hid a
project's fifth agent behind a hover count, so tmux-mobile's archivist and
blog's last two members read as absent (owner, 2026-09-28, board #261). Live
chip states use the window-name keys introduced by #120. Agent detection/icons and conversation-first time
still use the shared helpers, not another formatter or backend table.
`Sidebar.svelte` owns the unchanged aside/scrim/rows/trash markup and private
styles. It stays mounted with Hub, so its private trash-fold state survives
project switches as before. Hub retains selection/cache, the clock, sidebar
Back floor, ContextMenu action construction, confirmations and RPCs; callbacks
carry the clicked row identity. No wrapper, per-project key or copied shared
style atom is introduced.

**Historical roster grouping ownership** (board #132, 2026-09-09; retired by
the owner's 07:09 choice in #168): `roster.ts` owned the
existing team-tree construction. Solo agents and groups keep first-appearance
order at each level; full team paths distinguish nested groups with the same
leaf name. Agent objects retain identity. This is a mechanical extraction,
not a new grouping or sorting policy.
The physical `.st` box is now one declaration in `hub-atoms.css`, shared by
the roster, composer, receipt and drawer. Its Hub/parent-scoped selector has
the former rule's specificity; the 9px receipt override still wins, and
embedded pages do not receive a generic `.st` style. `.live-dot` motion and
state colors remain the existing app-wide mechanisms.
`Roster.svelte` owns the roster and fixed tap-menu roots, timer, anchor and
measurements as one Hub-length lifetime. Its selected gate stays internal;
there is no per-project key or wrapper. Hub still owns recipient/filter and
agent verbs. Two controlled bindings (`menuFor`, `cardsEl`) preserve project
reset, Back and the existing dismissal effect without a second open-state
copy or moving window capture listeners. Shared state-label/tone formatters
remain in Hub. The original 260ms mounted characterization is unchanged.
Verification on Chromium 152.0.7977.64 used nested/live/stopped cards in
1440x900 and 390x844 layouts, light/dark and reduced-motion spots. All 36
captured text/rectangle/style signatures matched; 29 PNGs were byte-identical,
with 3-39 edge pixels differing in the others (under 0.0031% of a frame).
The 44 moved private rule bodies and Hub effects/order were unchanged.
An intentionally premature menu on first selection failed the original
mounted characterization. A separate mounted case covers double-click
filter toggling and the stopped card's explicit Resume control.

### The header's server tag wraps under the name when they do not fit; the phone always stacks (#356, #359, 2026-10-13)

Since ③c-1 the Hub head names its server with `ui/ServerTag` beside the
project name. On a 390px phone the tag (`flex: none`) beside four head icons
left the name five characters ("tmux-mo…" — owner 2026-10-13 21:48: 放到项目名
下面，紧挨着); #356 stacked it by mode. The owner then asked for the same on
the desktop whenever the name would be cut (#359, 22:34), so the trigger is
FIT: `.title-stack` is a row (nowrap since #369; one class, `fit-wrapped`,
puts it in its column form — see design-language.md § Name + tag) whose first
item is the NAME LINE —
the name (or the rename input) with its chevron glued to the right edge, one
non-wrapping unit that hugs its text and does not grow or shrink for the tag
— and whose only item that moves is the tag. So inline: name ▾ tag; wrapped:
line 1 = name ▾, line 2 = tag. The first cut put the chevron OUTSIDE the stack
as a sibling, and on a wrap it centred against the two-line block, leaving a
hole right of the name (owner 22:57, two screenshots) — the chevron belongs
to the name it expands (owner 2026-08-30), on every line arrangement. Inside
the line the name shrinks (ellipsis) so the chevron stays glued when the name
alone is too long; `max-width: 100%` keeps the line inside the group. The
menu still anchors on the name element; the chevron keeps its touch box.
`compact` still stacks unconditionally. No new token, no new atom, no
measurement; the title-group's priorities (name over path, never over the
buttons) are unchanged.

### A tagged sidebar row is two lines: identity, then source (#360, 2026-10-13)

In Aggregate every sidebar row wears its server's `ServerTag` (③c-2). It sat
on `.p-top`, the row's one flex line, between the name and the unread ·
age — and there the name was the only shrinkable item, so a 240px sidebar
read "laminar-…", "tmux-m…", "Ling…" (owner 2026-10-13 22:58, screenshot):
the #356 disease in a second place. The row takes the notification row's
grammar (§ Unread, #356): **line 1 = identity** — `.p-top`: the name (the
only shrinkable item) … unread · age, short items that are the row's STATE,
`flex: none`; **line 2 = source** — `.p-source`: the tag alone, the widest
element, which yields to the name (design-language: the tag yields to the
name). `.p-source` is a flex line in app.css beside `.p-top` (a component
may not restyle the shared row atoms — `ui/sidebar.source.test.ts`), rendered
only `{#if e.tag}`: Single, or one included server, has no tag and the row
stays one line, as before #335. The ⋯ stays on the title line (its 32px room
is `.p-top`'s), the agent chips stay under both. Missing/unavailable rows are
unchanged — their name IS the server's.

### An unsent line belongs to its project

the composer's draft is per session (`hubPrefs.draft/setDraft`, `tmux_hub_drafts`), so switching projects parks the old draft and picks up that project's own — carrying the text across put a half-written line in front of the wrong agents — and a reload restores it, because a half-written message is work (owner, 2026-08-19). Written on every keystroke: one small JSON string, and a debounce loses the last characters exactly when the tab goes away. `draftUpdate()` (pure + tested) holds the two rules that regress silently — an empty draft REMOVES its key (else every project ever visited leaves a row) and the text is capped at `DRAFT_MAX` so a pasted file cannot fill localStorage and take the other prefs with it — and returns the SAME object when nothing changed, which is how the keystroke path skips the write. `renameSession` moves the draft key with the lead and read marker.

### Motion: what arrives rises, what was already there is a cut

The grammar is [motion.md](motion.md); the feed's own law is its principle 10 (the feed drives its own scroll, so nothing animates a height). What moves: a block that arrives AFTER the room settled rises in (`.appear-rise`, transform/opacity only — `scrollFeed` and the tail math measure nothing different), gated by `b.ts > openedAt`, where `openedAt` is the newest block timestamp once `selectProject`'s first load has landed and `Infinity` while a room loads — so history, an older page (`loadOlder` only prepends older timestamps) and a cached room never animate. The fold caret is ONE glyph that TURNS in `.flip` (the body is a cut), the tool-lane caret turns in `.chev`, the `.m-acts` row fades in (`.appear`; absolutely positioned, no layout), the to-tail button pops in (app.css gives `.to-tail` its `pop-in`) and its news dot with it. Roster: a card that JOINS a settled roster pops in — `rosterBase` is the set of names present when the room settled, so a project switch replays nothing for the cards already there; the unread dot pops, the needs-you word fades. Sidebar: trash rows fade in when the bin opens. The picker's scrim fades and its phone sheet rises (`sheet-up`, `--t-move`; exit is a cut). State controls cross-fade on `--t-fast`: `.acard`'s frame, wash, ring and opacity (`.sel`, `.needs`, `.off`, `.busy` — a transition, never an `animation`: waiting is not in motion), the `.st` dots' background colour (never their opacity — the statusdot contract), the drawer's `.win-pill` (`.state-ctl`), the composer's `.to-chip` costume (recipient → Everyone → note). A chat image fades in once loaded (`ChatImage` `.ci.loaded`, opacity on `--t-move`; a cached image that is already `complete` is marked loaded by an effect, so it never stays invisible) and its failed reference cross-fades to the warn tone. Reorders: sidebar project rows (keyed by project id) move with `animate:flip` on `moveMs()` — the conversation order changing is the one place a row's new position is the message — and a project that joins after the first fill fades in (`rowsBase`); stopped roster cards flip too. The LIVE roster cards render through a snippet behind an `{#if}` inside their keyed each, which `animate:` does not allow, so they do not flip yet (a wrapper element would change the strip's flex geometry). Never: an outro, a slide on a fold or the tool lane, an intro on a whole list.

**A room unfolds** (principle 15, wave 8): switching to an UNCACHED room (a `roomCache` miss, so `roomReady` is false) shows, in place of a blank feed, three bubble-shaped skeletons alternating sides and parked at the tail (`.skel-wrap.sk-feed`, `margin-top: auto`) and three card-sized skeletons in the roster (`.sk-cards`); `.skel-wrap` keeps them invisible for the first 150ms, so a fast answer never flashes one, and they never overflow, so no scrollTop is parked — `loadFeed`'s own `scrollFeed()` lands the real blocks at the tail exactly as before (`rise-in` is transform-only, so the tail math measures nothing different). When the first load lands `selectProject` calls `unfold()` ONLY for the uncached case: `justLoaded` puts `.reveal-tail` on `.feed` (rows rise from the newest, 30ms apart) and `.reveal` on `.cards`, and a timer clears it after `revealMs()` (one move + the atom's longest 210ms stagger + margin; zero-plus-margin under reduced motion, where the atom is inert). Cleared rather than left on, because the atoms animate every child that MOUNTS while the class is present — an older page prepended by `loadOlder` or the empty-room panel would rise (principle 13). A cached room switch stays instant: no skeleton, no reveal.

**Unread, per room, for every room** (board #322, owner 2026-10-09: "我经常听到「嘟嘟」的通知了，但是都不知道是哪个窗口的提示…在左侧的会话窗口增加提示"): the read mark is the SERVER's, one per room for the human (board #334, notifications.md § The read mark is the server's); `hubPrefs.seen(session) = {seq, ts}` is this client's cache of it — seq, because two messages can share a millisecond. `markSeen` (the newest message reached the bottom of the feed, or you sent) moves the cache and sends `hub_read`; every `hub_unread` answer carries the persisted marks, which the cache adopts when nothing of its own is pending, so every client of the server shows the same unread after its next read. What counts is ONE rule, `newsKind` (hub.ts; Rust twin `rooms::news_kind`, one case table read by both suites): your own words and app narration are not news, except a finished task (a board move to review/done, `[tmm done]`). The open room's roster dot (`unreadSenders`) reads it over the loaded feed; every other room asks the server: `hub_unread` with every row's mark, answered `{count, first_seq, last_seq}` over ALL rows above it, so newer narration cannot hide an older reply. Hub asks on every sidebar read (the 20 s `hub_rooms` cadence), 400 ms after a push for that room, and for the open room when `markSeen` moves its mark (the cue clears at once, the answer confirms); an answer asked under an older mark than the room has now is dropped. A jump to a centre entry (notifications.md § The notification centre) can replace the feed with a HISTORY WINDOW; while it is on screen `markSeen` refuses, and every feed/cursor/anchor write is owned by one reading generation (§ One reading generation). The project row shows the count beside its age in `--accent-ink` (`.side-unread`, name at 650 weight, ARIA "N unread", the hover's Unread line), and the roster card wears the same `.unread-dot` — never red (design-language.md § Unread is accent ink). The phone list is the same `Sidebar`.

**Hover explains** (principle 16, wave 9): on a pointer device the roster card, the stopped card, the sidebar project row and the drawer's window pill open the ONE hover card (`use:hoverInfo`, `ui/HoverCard`) — the getter runs at open time, so it reads live state. Card: name; state (tone from the `stateDotColor` family: running → accent, waiting/blocked → warn, failed → danger, idle → none) with the detail line, backend · model (`modelLabel`), context used, how long in this state (`fmtElapsed` — `since` is epoch seconds), the `session:window` target, the project path; note "Click: address · Right-click: menu". Stopped card: stopped, the slot's backend, the path. Row: path, "N live · M stopped" (the FULL count — the row's chips stop at four), last message age (`agoShort`), unread count for the open room. Pill: command, pane count, state. No second formatter anywhere, and the live card's native `title` is gone — the one-line reading lives in its `aria-label`. Touch never sees the card; the long-press menu is its "more".
