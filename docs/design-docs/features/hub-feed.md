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
The fixed tap menu and double-click filter shortcut no longer exist.

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

**Double-tapping the held bubble jumps to it** (board #304, owner 2026-10-03: "双击钉住的用户消息 可以跳到那个消息的位置"): on a bubble that is actually `.held`, `dblclick` (mouse) or a double-tap (touch/pen `pointerup` fed to the terminal's ONE `createDoubleTapDetector`, 300 ms / 40 px) runs `jumpToMsg`, the same jump `expandMsg` uses: scroll to the message's natural position 8 px from the top unless its start is already in view. It does not expand and does not unpin; the message simply arrives at its own place and the anchor state machine takes it from there. `jumpToMsg` reads the natural `offsetTop` with that element's stickiness neutralized for the synchronous read, as `syncAsk` does, because Chromium reports a sticky element's HELD offset. The pair's first tap still opens the action row (a single tap's behaviour is unchanged), so the jump closes it and clears any word selection the double-click made; the second tap's echo `click` is consumed (`jumpClick`) so it cannot reopen the row. An unheld bubble's double-click keeps the native word selection. `Feed.mount.test.ts` pins both input paths landing on the natural position (fails without the change); `Feed.source.test.ts` pins one detector and one shared jump.

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

**The drawer has TWO partitions** (owner, 2026-08-28: "右侧边栏，可以展开文件浏览器的分区，类似展示 terminal 面板一样的逻辑"): `drawerView = 'term' | 'files'`, one width handle, a header toggle per partition (on the phone the files toggle JUMPS to the Files tab instead — the same translation the terminal toggle makes to the Terminal tab). The files partition embeds the REAL `Files` component (`session={selected}`, per-project cwd via its module-scoped parked map) in `singlePane` mode — the drawer is 320–900px of a WIDE window, so Files' window-width split heuristic lies there (owner, 2026-08-28: "类似手机的单页模式，不用做成左右分屏") — and its head carries a maximize button that hands the drawer's cwd to the Files PAGE (`openFilesTab` → App sets `filesSession` + a `{path, n}` `navRequest` the page instance consumes; `loadDir` got a `seq` guard so the newest navigation always wins); the terminal body hides under `visibility: hidden`, never `display: none` — a re-laid-out terminal would resize the pane and make the agent repaint (the `.keep-rows` lesson) — and an Esc originating inside `.files-body` passes through (closing would unmount an open editor mid-edit), the same territory rule as `.xterm`.

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

`tmm send --image <path|url>` (repeatable) resolves the reference for a reader who is elsewhere (URL passes through, `~` expands, relative → absolute against the agent's cwd) and appends `![](src)` to the body. The room stays a log — no base64 in a message. The HUMAN's half is the composer's `+` (owner, 2026-08-26; a low-presence transparent dashed circle, same day): ANY file type attaches. An image is downscaled client-side to ≤1568px long edge (Claude's optimal, under GPT's 2048 cap), encoded webp (jpeg where WebKit can't encode webp — the blob's type decides the extension) and lands as `<ws>/.tmm/uploads/<id>.<ext>`, referenced `![](path)`; every OTHER file (PDF…) lands BYTE-IDENTICAL as `<id>-<its_own_sanitized_name>` (`uploadFilePath` — de-spaced, separator-stripped; 32 MB cap per RPC). The composer NEVER shows the path (owner, 2026-08-26: "消息框内部不展示完整的上传图片的 markdown 格式路径，就用一个 Image 的 placeholder 代替"): attachments stage as THUMBNAILS under the textarea (44px, the picked file via object URL, numbered; a file keeps a name chip), ✕ unstages, a project switch clears the staging. POSITION is carried by a visible token: attaching inserts `[img:n]`/`[file:n]` at the CARET (owner, 2026-08-26: "要让我能够看到图片插入的相对位置在哪里" — a textarea cannot style spans, so the token IS the marker, matching the thumbnail's number badge), and send() swaps each token for `![](path)`/path IN PLACE so the prompt keeps the image exactly where the words put it; a token the user deleted falls back to appending its ref (an attachment never silently vanishes), removal strips the token, and a failed post restores chips and text. In the feed, images render INSIDE the bubble (`.shots` in `.m-body`, before the floated meta trailer) and the HELD anchor shows text only (`.msg.held .shots` hidden — a pinned landmark is for re-reading your words, not a tall image). Self-gitignored dir; `imageId()` = time36 + uuid slice; send() delivers the PATH into the agent's pane like any other line. `splitImages` also extracts BARE image refs (http(s) URL or absolute/`~` path ending in an image extension, start-boundary-guarded so `/tmp/a b/shot.png` never yields a bogus `/shot.png`): alone-on-a-line folds into the image strip, mid-sentence keeps the prose AND renders, markdown+bare duplicates render once. The client pulls those refs out of the markdown (`splitImages`) rather than letting the renderer emit `<img>`, because a filesystem path is not a URL a webview can load: `http(s)`/`data:`/`blob:` go straight in, everything else streams through the signed `/dl` endpoint the file browser already uses, and an unresolvable ref renders as the ref itself. **The signature belongs to the FETCH, not to the render** (board #175, owner 2026-09-11: every older image in the room wore the amber failed chip — `ChatImage` minted the `/dl` URL the moment the message rendered while the `<img>` was `loading="lazy"`, so a message that landed while the reader was elsewhere was fetched minutes later with a signature that dies at 60 s, `DL_TOKEN_TTL_SECS`, → 403 → failed): the URL is minted when the image NEARS the viewport (an `IntersectionObserver`, root margin one screen — it IS the laziness, `loading="lazy"` is gone), a load error re-signs exactly once before the reference is declared failed (Files' re-sign-on-retry rule, never a loop), and the Lightbox receives a URL signed at the tap, never the thumbnail's. Pending, the host names the reference in grey; `ChatImage.mount.test.ts` drives a hand-made observer and counts signatures: none at render, one on intersection, one on error, one per view, none after the second error. Tapping a chat image opens the in-app `ui/Lightbox` (owner, 2026-08-26: "看图片的支持" — a new browser tab is not viewing): pinch-zoom/pan/double-tap/wheel, dismissed by backdrop tap (unzoomed only), Escape, ✕, the back gesture (topmost entry in Hub's onGoBack chain), or an unzoomed SWIPE — the drag carries the image, shrinks it and thins the backdrop with distance, releases past ~80px close it, short ones spring back (owner, 2026-08-27: "再一划这个图片，它就自动缩小了"). Feed images render as small THUMBNAILS (`.ci` ≤300×180 — the Lightbox is where an image gets big), composer attachment thumbs open the same viewer, and when a viewer is provided ChatImage renders a BUTTON, never an `<a>` — an anchor to a /dl URL is a tap away from a download ("不是说我点击图片去下载了一个图片"). Chat markdown renders LaTeX (same owner request): `core/markdown.ts` holes out code, feeds RAW TeX to KaTeX (all four delimiter families `$…$`/`$$…$$`/`\(…\)`/`\[…\]`), and splices the rendered HTML back AFTER marked so the escape can't touch it; dollar-inline follows the pandoc money guards so "costs $5, earns $10" stays prose, and no formula body may cross the `\x00` byte that marks a holed-out code span — `cost $5 and \`code\` is 3$` used to hand KaTeX the placeholder and lose the code (2026-09-03). KaTeX CSS is imported by Feed.svelte, never by markdown.ts (which runs under node --test). Link and image targets pass the scheme guard in `core/markedSafeUrl.ts` (see `conventions/frontend.md`, rule 13): text escaping alone does not protect an `href` attribute.

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

### Right-click and long press are ONE mechanism

`ui/ContextMenu.svelte` (the agent menu's popover dialect, anchored on a POINT via `placement.pointAnchor` — one placement rule with the trigger menus, but the DEFAULT alignment follows the anchor kind: a point puts the menu's TOP-LEFT at the click, the OS convention (owner, 2026-09-07: "应该都为左上角点"), while a trigger rect keeps the right-aligned dot-menu dialect; both flip above and clamp as before) + `ui/longpress.ts` (touch ONLY — a mouse has a right button, and a held left button would fire a menu mid-selection; >10px of travel is a SCROLL via the pure `isScroll`, a second finger cancels, and the following click is swallowed so a row does not both open its menu and activate itself). One App capture listener suppresses native browser context menus for every mouse/keyboard event: a surface opens its own shared menu or no-ops, never browser chrome. Wired to the agent card and the sidebar project row, each offering the verbs it ALREADY has elsewhere (a context menu with its own action set is a second source of truth). **Two reading verbs were unreachable and are menu rows now** (review, 2026-09-03): the one-agent feed FILTER (`filterBlocks`, board #3) existed only as an undocumented double-click on the card — and a selected card waits 260 ms for its menu, so the gesture fought the tap — so both card menus (the tap menu and the right-click/long-press ContextMenu, from the same `agentItems`) carry `Only its messages` / `Show everything` through ONE `toggleFilter`, a reading verb seated with Message/Watch before configure, offered for a STOPPED agent too (its history is what you narrow to once it is gone; the toggle does not seat it as recipient, unlike the double-click, which stays as the shortcut). And the feed's DETAIL LEVEL (`hubPrefs.feedLevel`: chat / + status / + tools) was reachable only from Settings, its Hub `cycleFeedLevel` control dead code: the project TITLE's menu — the one menu about "this conversation" — now lists the three levels between Rename and Close, the chosen one ticked (`check` vs hollow `circle`, radio semantics through icons the menu already has), writing the same pref Settings reads. Not a header switch: the header keeps no spare switches (board #72). **Only mine** (board #289, owner 2026-09-30: "消息比较多不太好筛选，很多都是 Agent 之间的会话") sits right after the three levels in that same menu, a toggle ticked while on. It is the SAME reading filter with the human as its subject (`toggleFilter(HUMAN)`, `filterBlocks(blocks, 'human')`): the human's own messages, a message whose recorded `to` names the human (an agent's final reply to a turn the human asked in, agent-status.md § reply edge; an `@human` send), and a body that says `@human`. `@all` means every agent and does not count; the human has no window, so no prompt/progress/steps block shows; sys lines stay only where they name the human. Being the one filter state, Only mine and an agent's "Only its messages" exclude each other, the room switch resets it, and Back peels it. No agent card wears the filter mark for it (the roster gets no filter while it is on): its state is the tick. Rows recorded before #289 carry no `to` for a reply, so older agent answers are not matched. `Hub.source.test.ts` pins both routes and that the cycle control stays gone. The message bubble has NO context menu (board #48; owner, 2026-09-04: "点击消息气泡，还是会呼出一个类似右键的 Copy 选项卡菜单……其实我们都不要了", then 2026-09-07: "我只要消息气泡下边的这两个按钮，不要出现右键那种选项卡"): its verbs live ONLY in the tap-revealed `.m-acts` row under the bubble (Copy / Raw / Reply — Reply since board #290, a quote by content, hub-composer.md § A reply quotes a message; a body carrying the quote token renders it as the bubble's own blockquote; Raw wears the `code` `</>` glyph since board #218 — owner 2026-09-20: "raw 的图标我理解不了，可以用类似源码的图标"; the ⌘ it replaced read as a key and left with it) — no `openCtx` from a bubble, no desktop right-click card. The bubble's `contextmenu` handler never calls preventDefault: it only arms the passive `selectionClickGuard` mark, so a touch/pen hold stays the system's selection gesture and its Android/WebKit compatibility click is consumed before it can open the row; a genuinely non-collapsed selection independently wins over any bubble tap. Message bodies explicitly opt into text selection. Board notes keep the same passive mark/consume `selectionClickGuard` for their `.m-acts` Copy overlay.

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

The drawer's single bar is the window pills (state dot, name, `direct` tag) + roster count + open-full/close — the count's "N running" and the pills' live dots are ONE definition, `stateIsLive` (board #179: a private `=== 'working'` in the count, the pre-2026-08 name of today's `running`, showed "3 · 0 running" beside a live dot; `Drawer.render.ts` renders running + waiting + legacy working as "3 · 2 running", and the Feed's steps-group live pulse uses the same function); the tmux-style statusline underneath was merged away (owner: "上面和下面有两个 bar…可以把它们合并一下" — it listed the same windows and called the same `pickWindow`; the pills carry state and actions, so they survived). The bar shows AGENT windows only (board #92: "只 filter 出当前有效的 agent window，其他 window 可以帮我折叠起来"): shells fold behind a `+N` pill of the same family, one tap unfolds (the pill becomes `−`), a room switch folds back — with two exceptions, both in ONE pure function `hub.ts drawerWindowPills`: the window the terminal is currently SHOWING keeps its pill even inside the folded set, because the bar may never hide the current pane; and the project's SHELL window — the lowest-indexed non-agent window, the one `up` creates first, derived rather than assumed to be 0 — is always the FIRST pill and never counted in `+N` (board #320, owner 2026-10-08: "我想要窗口里可以呼出一个终端用，好像就类似于你启动的项目里有一个0的 window，这个在侧边栏应该不要自动给我hide起来，让我更容易用到"); a session with no non-agent window gets no pill for it. Other shells still fold — #92's intent, agents visible and noise folded, stands. While the partition is open, selecting an agent in the chat (card click, composer picker, "talk to") retargets the drawer to that agent's window through the same `pickWindow` (board #91) — choosing who you talk to is choosing whose pane you watch, the reading `openDrawer` already makes when it seats the recipient's window first (board #76); it only follows a name that matches a roster window (@all and the room do not) and never opens a closed drawer. **Whose pane the partition shows has ONE definition, `pickDrawerAgent(agents, recipient)` in hub.ts** (board #209, owner 2026-09-20: "chat 切换别的 project，再回来的时候，选中的 agent card，好像保留了，但是右边侧边栏对应的 terminal 好像没有保留到我选的 agent，这样左右不同步了"): the recipient's managed window when the recipient is a named agent, else the first managed agent, else anything. `openDrawer` (#76) and the #91 retarget always said so, but the room-switch restore in `selectProject` and the late seat in `loadDetails` (a first visit after reload restores before any roster exists) each carried a private `agents.find(managed) ?? agents[0]` — so returning to a room restored the SELECTED card from `hubPrefs.lead` and seated the pane beside the FIRST managed agent. All three now ask the one function; `termTarget` is never persisted, it is derived from the recipient (tenet 8). Measured on the live server (kiro is window 3, claude window 2 = first managed): select kiro, open the partition, switch to another project and back — main: card kiro, pane `2:claude`; fixed: card kiro, pane `3:kiro`; with All or the room selected, back seats `2:claude` (no single recipient → the old default). The divider is a real splitter: the drawer column is `var(--hub-drawer-w)` (320–900, default 520, persisted `tmux_hub_drawer_w`), reusing the parametric `SideHandle` (ONE resize affordance, ui-unification) — it was a fixed grid that looked draggable and was not.

### The chat header opens, closes and NAMES the project (moved from tmm-cli.md, board #102)

The header carries exactly ONE of Open (`project_up`, no live session) or Close (`project_down`, session up) — only Open existed, and the owner could not close a project from the chat; Close confirms like stopping an agent (it kills every pane) and the copy says what survives. Beside the title sits the FULL path, not `shortPath`'s stub — whole when it fits, a hidden-scrollbar horizontal scroller when not (owner's three rules verbatim: "展示得下完整展示 / 展示不下再隐藏 / 支持滑动查看，不要省略号", 2026-08-20), `wheelX` pans it, `user-select:text` overrides the shell so a drag selects, and double-click selects + copies the exact untruncated value through `copyText`. Desktop only — the phone header never showed the path. `project_create`'s session name follows the NAME when given (`session ?? name ?? basename(path)`) — it fell through to the folder, so `--name closetest` made a session called `tmp`, the same folder-name-wins bug the Hub dialog hit from the other side.

### The feed's per-poll work is bounded by what changed, not by how much history is loaded

Four costs grew with paged history and were paid on every 5–10 s tick or scroll event (review C, 2026-09-03): (1) `onFeedScroll` ran `syncAsk` — write `position:static` on the stickies, read every `[data-ask]` box, write it back — plus `autoRefold`'s queries synchronously per scroll event, several times a frame under momentum; it now coalesces everything after the `following` decision into ONE pending `requestAnimationFrame` (the browser lays out once per frame anyway; the 16px direction hysteresis works on the frame's net delta, which is what it meant). (2) `feedBlocks` paired every app-echo with every message and re-ran `squashWs` per PAIR — P × M regex passes per tick; `squashOf` caches the squash per OBJECT in a WeakMap (messages and events are stable objects across polls because `mergeMessages`/`mergeEvents` keep the existing ones), and a test pins that the blocks are identical for the same objects twice and for fresh copies. (3) `core/markdown.ts` cleared its WHOLE cache past 500 bodies, so a long feed re-parsed everything with marked + KaTeX until it refilled; it is a `core/lru.ts` LRU now (evict one oldest; a hit refreshes), same bound. (4) `onPush` called `hub_agents` per pushed message — a burst of 30 was 30 RPCs; a message IS a turn edge so the roster refresh stays (the 5 s poll would lag), but through one trailing 300 ms debounce, cleared with the listener.

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

### The header's server tag is inline on the desktop and stacked under the name on the phone (#356, 2026-10-13)

Since ③c-1 the Hub head names its server with `ui/ServerTag` beside the
project name. On a 390px phone the tag (`flex: none`) beside four head icons
left the name five characters ("tmux-mo…" — owner 2026-10-13 21:48: 放到项目名
下面，紧挨着). One markup, `.title-stack`, holds the name and the tag; on
`compact` it is a column (`gap: 2px`, the project rows' stack rhythm) with the
name on top at full width and the tag tight under it; on the desktop it is
inline. Single mode has no tag either way (the ③c-1 rule). No new token, no
new atom; the title-group's priorities (name over path, never over the
buttons) are unchanged.

### An unsent line belongs to its project

the composer's draft is per session (`hubPrefs.draft/setDraft`, `tmux_hub_drafts`), so switching projects parks the old draft and picks up that project's own — carrying the text across put a half-written line in front of the wrong agents — and a reload restores it, because a half-written message is work (owner, 2026-08-19). Written on every keystroke: one small JSON string, and a debounce loses the last characters exactly when the tab goes away. `draftUpdate()` (pure + tested) holds the two rules that regress silently — an empty draft REMOVES its key (else every project ever visited leaves a row) and the text is capped at `DRAFT_MAX` so a pasted file cannot fill localStorage and take the other prefs with it — and returns the SAME object when nothing changed, which is how the keystroke path skips the write. `renameSession` moves the draft key with the lead and read marker.

### Motion: what arrives rises, what was already there is a cut

The grammar is [motion.md](motion.md); the feed's own law is its principle 10 (the feed drives its own scroll, so nothing animates a height). What moves: a block that arrives AFTER the room settled rises in (`.appear-rise`, transform/opacity only — `scrollFeed` and the tail math measure nothing different), gated by `b.ts > openedAt`, where `openedAt` is the newest block timestamp once `selectProject`'s first load has landed and `Infinity` while a room loads — so history, an older page (`loadOlder` only prepends older timestamps) and a cached room never animate. The fold caret is ONE glyph that TURNS in `.flip` (the body is a cut), the tool-lane caret turns in `.chev`, the `.m-acts` row fades in (`.appear`; absolutely positioned, no layout), the to-tail button pops in (app.css gives `.to-tail` its `pop-in`) and its news dot with it. Roster: a card that JOINS a settled roster pops in — `rosterBase` is the set of names present when the room settled, so a project switch replays nothing for the cards already there; the unread dot pops, the needs-you word fades. Sidebar: trash rows fade in when the bin opens. The picker's scrim fades and its phone sheet rises (`sheet-up`, `--t-move`; exit is a cut). State controls cross-fade on `--t-fast`: `.acard`'s frame, wash, ring and opacity (`.sel`, `.needs`, `.off`, `.busy` — a transition, never an `animation`: waiting is not in motion), the `.st` dots' background colour (never their opacity — the statusdot contract), the drawer's `.win-pill` (`.state-ctl`), the composer's `.to-chip` costume (recipient → Everyone → note). A chat image fades in once loaded (`ChatImage` `.ci.loaded`, opacity on `--t-move`; a cached image that is already `complete` is marked loaded by an effect, so it never stays invisible) and its failed reference cross-fades to the warn tone. Reorders: sidebar project rows (keyed by project id) move with `animate:flip` on `moveMs()` — the conversation order changing is the one place a row's new position is the message — and a project that joins after the first fill fades in (`rowsBase`); stopped roster cards flip too. The LIVE roster cards render through a snippet behind an `{#if}` inside their keyed each, which `animate:` does not allow, so they do not flip yet (a wrapper element would change the strip's flex geometry). Never: an outro, a slide on a fold or the tool lane, an intro on a whole list.

**A room unfolds** (principle 15, wave 8): switching to an UNCACHED room (a `roomCache` miss, so `roomReady` is false) shows, in place of a blank feed, three bubble-shaped skeletons alternating sides and parked at the tail (`.skel-wrap.sk-feed`, `margin-top: auto`) and three card-sized skeletons in the roster (`.sk-cards`); `.skel-wrap` keeps them invisible for the first 150ms, so a fast answer never flashes one, and they never overflow, so no scrollTop is parked — `loadFeed`'s own `scrollFeed()` lands the real blocks at the tail exactly as before (`rise-in` is transform-only, so the tail math measures nothing different). When the first load lands `selectProject` calls `unfold()` ONLY for the uncached case: `justLoaded` puts `.reveal-tail` on `.feed` (rows rise from the newest, 30ms apart) and `.reveal` on `.cards`, and a timer clears it after `revealMs()` (one move + the atom's longest 210ms stagger + margin; zero-plus-margin under reduced motion, where the atom is inert). Cleared rather than left on, because the atoms animate every child that MOUNTS while the class is present — an older page prepended by `loadOlder` or the empty-room panel would rise (principle 13). A cached room switch stays instant: no skeleton, no reveal.

**Unread, per room, for every room** (board #322, owner 2026-10-09: "我经常听到「嘟嘟」的通知了，但是都不知道是哪个窗口的提示…在左侧的会话窗口增加提示"): the read mark is the SERVER's, one per room for the human (board #334, notifications.md § The read mark is the server's); `hubPrefs.seen(session) = {seq, ts}` is this client's cache of it — seq, because two messages can share a millisecond. `markSeen` (the newest message reached the bottom of the feed, or you sent) moves the cache and sends `hub_read`; every `hub_unread` answer carries the persisted marks, which the cache adopts when nothing of its own is pending, so every client of the server shows the same unread after its next read. What counts is ONE rule, `newsKind` (hub.ts; Rust twin `rooms::news_kind`, one case table read by both suites): your own words and app narration are not news, except a finished task (a board move to review/done, `[tmm done]`). The open room's roster dot (`unreadSenders`) reads it over the loaded feed; every other room asks the server: `hub_unread` with every row's mark, answered `{count, first_seq, last_seq}` over ALL rows above it, so newer narration cannot hide an older reply. Hub asks on every sidebar read (the 20 s `hub_rooms` cadence), 400 ms after a push for that room, and for the open room when `markSeen` moves its mark (the cue clears at once, the answer confirms); an answer asked under an older mark than the room has now is dropped. A jump to a centre entry (notifications.md § The notification centre) can replace the feed with a HISTORY WINDOW; while it is on screen `markSeen` refuses, and every feed/cursor/anchor write is owned by one reading generation (§ One reading generation). The project row shows the count beside its age in `--accent-ink` (`.side-unread`, name at 650 weight, ARIA "N unread", the hover's Unread line), and the roster card wears the same `.unread-dot` — never red (design-language.md § Unread is accent ink). The phone list is the same `Sidebar`.

**Hover explains** (principle 16, wave 9): on a pointer device the roster card, the stopped card, the sidebar project row and the drawer's window pill open the ONE hover card (`use:hoverInfo`, `ui/HoverCard`) — the getter runs at open time, so it reads live state. Card: name; state (tone from the `stateDotColor` family: running → accent, waiting/blocked → warn, failed → danger, idle → none) with the detail line, backend · model (`modelLabel`), context used, how long in this state (`fmtElapsed` — `since` is epoch seconds), the `session:window` target, the project path; note "Click: address · Right-click: menu". Stopped card: stopped, the slot's backend, the path. Row: path, "N live · M stopped" (the FULL count — the row's chips stop at four), last message age (`agoShort`), unread count for the open room. Pill: command, pane count, state. No second formatter anywhere, and the live card's native `title` is gone — the one-line reading lives in its `aria-label`. Touch never sees the card; the long-press menu is its "more".
