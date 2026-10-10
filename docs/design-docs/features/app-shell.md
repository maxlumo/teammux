# App Shell — one chrome per context

**Reading this record (2026-09-10, board #159 / #154):** the original shell decision
and its verification below describe the rollout, including retired tab/bus
names; they are not a current navigation inventory or new runtime acceptance.
Later dated rules supersede that history. Configuration layout/control rules
belong in [design-language.md](design-language.md), with #155/#156 implementation;
motion in [motion.md](motion.md). This update does not reorganize global tabs.

## Context

Until agents-v2 the app had ONE shell on every platform: a top bar with four
nav pills (Sessions / Terminal / Team / Files) plus a gear. The Hub made it
five, and the top bar started working against both platforms at once:

- On desktop the Hub already contains the projects list and an embedded
  terminal, so the top pills mostly duplicated what the sidebar shows — while
  eating ~45px of vertical space on the page where vertical space is the
  product (a terminal).
- On a phone the pills sit in the hardest-to-reach part of the screen, and
  every added page shrank the tap targets.

## Decision

Historical rollout; later scoped decisions below supersede its inventory.

Three shell shapes, chosen by context, never mixed:

| context | chrome | why |
|---|---|---|
| connected desktop | **left icon rail** (46px, fixed): Hub / Sessions / Terminal / Agents / Files, gear at the bottom | the VSCode/Slack pattern — switching stays one always-visible click, the top edge belongs to content, and the rail composes with the Hub's own sidebar instead of stacking a second horizontal bar over it |
| connected mobile | **bottom tab bar** (icons + labels, safe-area padded) | thumb reach; the top edge goes back to content. Hidden under `html.keyboard-open` so immersive typing (terminal, editor) costs nothing — the ONLY writer of that class is App's viewport handler, so there is no second source of truth. The one other hide is `main.immersive`, set from a page's explicit `onimmersive` signal while that page is on screen (Files' reading mode, board #226) — the same cut, a second named reason, no second class writer on `<html>` |
| disconnected | the old **top brand bar** with the gear (both platforms) | before auth there is nothing to navigate; brand + settings is the whole story |
| switching servers (board 315) | the **connected** shell stays (rail / tab bar); the content area shows the switch panel | a switch is not a logout: the user keeps their place. Connecting: the whole shell is inert. Failed: only the server control and the panel's exits work, the page buttons are disabled. The content tree is unmounted throughout, so nothing of the old server can be acted on |

Desktop lands on the **Hub by default** (fresh state); a guard falls back to
Sessions once the bus probe answers negative (`hub`/`agents` need the bus).

The Hub is CHAT-FIRST (owner-directed rework 2026-08-01): a project's default
view is its conversation, full width; the terminal is a DRAWER behind a
button — terminal is terminal, project is project, never parallel equals.
Agent definitions live on their own Agents page (rail icon / bottom-bar tab).
The Team tab is retired — the Hub's per-project chat + spawn + telemetry
replaced it; the team_* backend stays (the bus IS the hub substrate) and
legacy tmm-team-* sessions appear as plain sessions in the list.

## Mechanics worth recording

- The rail is `position: fixed`; content clears it via `main.with-rail
  { padding-left: 46px }` rather than a flex re-nest, so the page-layer
  keep-alive structure (Team/Files/Terminal/Hub stay mounted) is untouched.
- Every nav item — rail icons, the rail's server control, the phone's tab
  bar, the gear — is in the Tab order and shows the global
  `button:focus-visible` ring (accent outline, 2px offset); the current page
  is `aria-current="page"`. They all carried `tabindex="-1"` from v0.3.0 with
  no recorded reason, which left the whole navigation unreachable by keyboard
  (review, 2026-09-03). `App.source.test.ts` pins it.
- Fixed overlays cannot assume a top bar anymore. `Preferences` used
  `inset: calc(49px + var(--sat)) 0 0`; it now reads
  `--shell-top` / `--shell-left`, which App sets per context (49px top when
  disconnected, 46px left on connected desktop, zero on connected mobile).
  Anything else `position: fixed` that wants to clear the chrome should use
  the same two vars.
- The mobile tab bar hides with CSS (`:global(html.keyboard-open) .tabbar
  { display: none }`), not JS — it inherits exactly the keyboard lifecycle
  the terminal already fights hard to get right, including the Android
  native-height path.
- Tab order for swipe navigation is unchanged (`tabs()`), and the gear is a
  toggle, not a page — it never participates in swipes.

## The rail has two groups: where you work, and what you configure

Top: Chat, Terminal, Files — the places work happens. Bottom, after the
spacer: Agents (agent/skill/MCP definitions) and Settings. Agents moved down
there on 2026-08-19 (owner ask): it is a configuration surface, visited when
setting something up rather than while working, and pairing it with the gear
says that without a label. Order within the pair puts Agents above the gear,
which stays the last item in the rail as the app-wide convention.

## The scratch terminal is a shell panel, not a page (board #324)

Owner, 2026-10-09: "帮我再加一个全局可呼出的 Terminal 菜单…有点像 iTerm 或 Ghost
里的那种全局 Terminal 模式…可以放到桌面版的左下角。至于是从下侧还是左侧弹出，可以加个按钮让我自己去设定…这个
Terminal 只是临时用的，并且跟你的项目没有关系". Desktop only (the #316 gate,
`!layout.isTouchDevice`).

- **Doors.** A control in the SYSTEM STATUS BAR, beside the vitals
  (`aria-pressed`, hover card with its shortcut), and the registry shortcut
  `toggleScratch` (⌘⌥` / Ctrl+Alt+`, free of the reserved chords). Both toggle;
  so does the panel's × . **Escape belongs to the shell** (vim, readline, agent
  TUIs): it closes the panel only from the head's own controls.
  It was a rail control until #326, at the top of the bottom group. Owner,
  2026-10-09: "左下角的快捷 Terminal 按钮和上方的 Terminal 按钮感觉有一点重叠，
  看起来一样了…我想到 可以把它放到我们的系统状态栏里 我们不是有一个系统状态栏嘛
  在旁边可以画一个小选项 用来打开快捷 terminal" — in a column of page icons a
  second terminal glyph reads as a second Terminal PAGE, which it is not;
  beside the readings it reads as what it is, something the server offers.
  App owns it (like the rail buttons and the sidebar toggle) and renders it
  INSIDE `aside.sys-sidebar`, not inside `SystemStatus.svelte`: that component
  is deliberately transport-dumb and renders nothing until its first reading
  lands, and a toggle that appears a poll later is not a door.
  `--sys-ctl`/`--sys-sidebar-h` are ONE pair, because every desktop sidebar
  reserves that height as bottom padding and the bar clips its own content: a
  mouse gets a 20px target inside the 24px bar (its vertical padding gives way,
  not its height). **Both numbers are fixed on every pointer type** (owner,
  2026-10-10: "现在把那一栏整体撑得特别高，不是我想要的，需要维持得小一点";
  board #339). #326 let `@media (any-pointer: coarse)` take the control to
  `--control-height` and grew the bar to match, for a touch device running the
  desktop layout. Measured on the shipped build with `any-pointer: coarse`
  emulated at a 1440px viewport: the strip went 24px → **48px** and the control
  20px → 44px, which also truncated the readings beside it ("38/6…", "0.7/…").
  A pointer that reports coarse does not say a mouse is absent, so the DESKTOP
  layout now keeps the compact strip the owner asked for, and a coarse pointer
  gets a bigger HIT AREA instead (`.sys-scratch::after`, `inset: -2px -6px` →
  24×32), bounded by the bar's own box: an overlay taller than the strip would
  take clicks from the sidebar content above it, where this control is not.
  A deliberate size trade-off, not a proof that nobody taps (review #339, P2):
  the control hangs off `!layout.isTouchDevice`, which is an overridable LAYOUT
  choice (`layout.svelte.ts`), so a touch user who forces Desktop reads false
  here and gets the 20px paint with the wider hit box.
  The paint stays 20px with the dense-group corner, and the background is
  there for **hover and press only**
  — the icon-only family's two states (`.icon-btn`: `--surface2` wash, then the
  `--accent-bg` press wash), gone at rest, with an OPEN panel marked by accent
  INK rather than a wash, because a wash is a background that shows all the
  time: "那个背景不用一直显示，就是我鼠标移上去，或者我点击的时候能看到的形状".
  **Consequence, accepted:** the bar retracts with the
  primary sidebar (`.with-rail.side-collapsed .sys-sidebar`, owner #200
  "左侧边栏收起的时候，底下的系统状态显示也要收起"), so the control retracts with
  it; the shortcut is the door that is always open.
- **Panel.** `app/ScratchPanel.svelte`, fixed over the content area right of the
  rail, no backdrop (a tool panel, not a modal), one `--t-move` slide (reduced
  motion: none). Edge `bottom` (default) or `right`, chosen in its own head by
  TWO ICONS (one place, no Settings row; `tmux_scratch_edge`) — the one
  `ui/Segmented` in its icon mode (`panel-bottom` / `panel-right`, each
  option's word kept as its accessible name), because the owner asked for the
  words to go: "这个 terminal 应该可以显示在下方或右侧 上面的按钮不用写'bottom'
  之类的文字了 你用两个小图标去做状态切换" (2026-10-09). The vertical dock was
  the LEFT edge until #326; it is the same axis and the same stored size, so
  `scratch-edge.ts` migrates a stored `left` to `right` on read and writes it
  back once (a reader that only recognised `right` would have thrown every
  existing user back to the bottom edge — hence a tested function rather than
  a ternary in App). Its size per edge through the one
  `SideHandle` (`edge="top"` on `--scratch-h`, `edge="left"` on `--scratch-w`,
  `always`, clamped to the viewport), restored by App like `--sidebar-w`, and clamped by the layout itself (`min(var, viewport − 80px)`, zoom-corrected) so a size stored on a larger window, or a window shrunk with the panel open, keeps the head and handle on screen (measured: h=1200/w=1400 into 900×600 then 700×420, both edges). Closed
  it is off-screen, `visibility: hidden` after the slide and `inert`, so nothing
  in it takes focus. Opening focuses the terminal once it is mounted and shown;
  closing returns focus to what had it, only if focus is still in the panel and
  that control is still there and visible.
- **Only the reader ensures, and opening converges on a LIVE session.** Opening the panel (and an explicit "Open again") is the only thing that calls `scratch_session`; the effect tracks `open`/`live` only, so a refusal is a stable error with its reason, not a retry loop. The Terminal takes the session name the server returned.
  #326 added `ended` to the states an open ensures from, which is the client half of 「点开 Terminal 之后，我现在经常看到里面什么都没有」. A hidden Terminal stays SUBSCRIBED (rule 7), so a session that ended behind the panel's back — before #326 the shell's own `exit` ended it, see projects.md — delivered `pane_closed` while the panel was CLOSED and left `phase = 'ended'` with no target; the open effect re-ensured only from `idle | error`, so the next open rendered the bare "Session ended" line. Both halves are mount-tested; the retry-loop guard is unchanged.
  **Known limit, accepted (orchestrator, 2026-10-09, #326 review):** a `ready`
  panel still trusts the pane it has, so a session killed from OUTSIDE
  (`kill-session`, `kill-server`) and reopened before its `pane_closed` arrives
  shows the stale pane for that moment; once the subscription reports it the
  state is `ended` and the next open re-ensures. Closing that window means
  ensuring on EVERY open, which #324 decided against ("no second ensure for a
  session that is still there") — and the owner's bug was the self-inflicted
  `exit` path, now fixed at the tmux layer. The window is mount-tested as it
  stands, so a future change to it is a deliberate one.
- **Session.** `scratch_session` ensures the one project-less session the server
  owns (projects.md § the scratch terminal's session) and answers its concrete
  `session:window.pane`; the panel embeds the ONE Terminal on it (`embedded
  chromeless`, app `fontSize`, same keys/resize contract). Close HIDES (the
  session runs on; the Terminal stays mounted and records frames without
  rendering, rule 7); the head's stop icon is Kill, behind a ConfirmDialog
  (close ≠ kill). A session that ends (Ctrl-D, external kill) shows "Session
  ended · Open again"; nothing recreates it in the background. A name held by a
  plain session or a project shows the server's refusal with the same re-try —
  and when a PROJECT holds it (board #337), the refusal also offers **Release
  the name**, behind a confirmation that NAMES the project and the session it
  renames. The action is keyed on the server's error CODE (`-32010`), never on
  the text of its message: the sentence is the server's one composition for the
  human, and reading it in the client would be a second copy of it. The code's
  `data` (`{projectId, projectName, session}`) is kept as a snapshot and sent
  back with the release, so the project the reader saw is the only one that can
  be renamed; a refusal we cannot identify a holder for offers the retry alone.
  The code lives in `core/rpc-codes.ts`, NOT in `ws.ts`: every mount fixture
  mocks `ws.ts`, so a constant defined there reads as `undefined` in a test and
  a feature keyed on it looks disabled — which is exactly how this action first
  failed its own test.
- **Server boundary (#315).** App keeps the frame's state (open, edge, sizes)
  outside the server key; the panel and its Terminal mount INSIDE
  `{#key serverEpoch}`, so a switch destroys them with the subscription. The
  panel closes the moment a switch starts (`switching`), its `live` goes false so
  every pending ensure/kill/focus completion is dropped (one intent counter, also
  bumped on destroy, whatever order the keyed tree is torn down in), and
  nothing ensures on the new server until the reader opens it there.
- **Independence.** The Terminal page's window switcher, split and the Hub
  drawer never retarget to it, and it is not a project. Since #326 it is also
  HIDDEN from every session listing and its shell can exit without ending it —
  both are server rules, with their measurements, in
  [projects.md § the scratch terminal's session](projects.md).

`ScratchPanel.mount.test.ts` pins lazy ensure, focus in and back, inert when
closed, hide-not-kill, Kill behind its confirmation, "Open again", the edge
switch, a switch dropping a pending ensure without re-ensuring, a refusal that
stays an error until Open again, and a kill completion after the keyed tree was
destroyed (negative controls: no intent guard, ensure on every open, no `inert`,
the effect tracking the phase, no destroy bump);
`ScratchPanel.source.test.ts` pins the shared Terminal/SideHandle, the tempo, the
head-only Escape and App's mount inside the key; since #326 also the right
dock's `--sat` and `translateX(100%)`, the two edge icons, and the open effect's
`ready ? focus : ensure`. `App.source.test.ts` pins the rail WITHOUT a scratch
control and the status bar WITH one, including that NO pointer type overrides
`--sys-ctl`/`--sys-sidebar-h` (one declaration of each), that the one coarse
block carries the hit area and not a resize, and the control's rest/hover/press
paint (#339).

## The tab slide belongs to the swipe, not to the app

`switchTab` plays a one-shot `slide-in-left/right` on the page layer — but only
on a TOUCH layout (`layout.isTouchDevice`, 2026-08-19). It is the visual half
of the swipe gesture: content follows the finger, so the direction carries
meaning. A desktop switches tabs by clicking a rail button, where nothing moved
horizontally and the slide just made the page lurch (owner report) — most
visibly on the wide three-column pages, where a whole workspace slid. The
animation is not deleted, because on a phone removing it would leave a swipe
whose content does not follow the thumb.

## Verified

Original rollout observations only, not current configuration acceptance:

Desktop 1440x900: rail with Hub/Sessions/Terminal/Team/Files/Settings, no
top bar, `main` padding 46px, Hub as the fresh-state default, Files
switching, Preferences opening at `left: 46px`. Mobile 390x844 (touch
emulation): bottom bar with active states, tapping a project window lands in
a rendering terminal with the bar visible, `keyboard-open` computes
`display: none` for it. Disconnected: top brand bar, no tab bar.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

Later scoped decisions supersede explicitly retired descriptions; a historical
measurement is not evidence that a new configuration implementation was tested.

### Tab swipe priority

App-level left/right tab swipe is lowest priority. Suppressed when any child gesture is active (`defaultPrevented` or vertical movement > 10px).

### The phone's BACK gesture peels layers; it never reads as the browser navigating

App seeds/re-pushes `{app:true}` history entries and routes `popstate` to the visible page's own `onGoBack` closure — the Files page defined the contract (git panel → editor-with-confirm → preview → directory up → floor) and the owner named it the reference ("chat agent配置等页面 对于返回手势适配不太好 像是网页刷新了。像文件管理页面就很好", 2026-08-24). Hub peels its fixed local priority sequence, listed below; this is separate from its Escape/pointerdown listeners. On compact, a bare conversation lifts the project list (the list is the FLOOR, like Files' `/`: back with it open falls through, so it cannot cycle open/close). Terminal on compact follows the same floor rule (board #58): a bare terminal lifts the session drawer; with it open Back falls through/re-pushes instead of closing it, so no close/open cycle; a Chat-jumped Terminal returns to Chat before the floor lift. AgentsPage: pending delete dialog → whichever editor is open (compact: the editor takes the screen) → floor. Settings: the open category → the category list (its compact layout is the same drill-down — the list is the first screen, a chip row was a third navigation species; owner, 2026-08-25) → floor (leaves the page). A CONSUMED pop re-pushes in App so the next back always has an entry to spend; only an unconsumed one reaches the re-push floor. Pages register via the same `onGoBack={(fn) => xGoBack = fn}` prop pattern Files uses — a page never installs its own `popstate` listener.

**Hub dispatch ownership** (board #119, 2026-09-09): one per-Hub
`hub-back.ts` registry replaces the closure-wide flag chain. Its fixed order
is lightbox -> ContextMenu -> palette ->
action confirmation -> trash confirmation ->
agent picker -> create project -> rename -> agent filter -> Files delegate ->
drawer close -> compact project-list floor. This is not registration order
or a chronological stack. Each callback reads its owner's live state;
the registry keeps no duplicate open flags. Missing callbacks fall through.
Each disposer belongs to one registration, so an old owner cannot remove
its replacement even when both register the same function.

Hub still publishes one callback through `onGoBack`; cleanup removes each
owner's registrations. Board #168 (2026-09-11) removes the agent tap menu,
recipient popup and send-arm mechanism whole, including their Back slots
and the obsolete card-menu capture effect. Composer registers only palette;
Hub owns the other eleven slots. The relative order is unchanged. Board #167
(2026-09-12) deliberately replaces busy-confirmation fallthrough: an open
action/purge confirmation consumes Back while pending and dismisses only
when idle. It must not close the drawer beneath its in-flight operation.
The other guards remain: a truthy palette consumes even
without items, and Files is called
only for an open Files partition and consumes only on a true return.
Message actions/raw view are not Back layers; Board delegation is not added.
The Escape/pointerdown listeners and their capture order stay in Hub,
including the terminal/Files/Board focus territories. The registry neither
installs listeners nor calls browser history. Desktop still uses in-pane
Files Back/breadcrumbs; a narrow desktop is not a reason to trap browser Back.

**Terminal's confirmations have a local delegate** (#167, 2026-09-12).
Sessions exposes the same `onGoBack` contract: pending kill confirmation
first, then its nested Projects confirmation, otherwise false. Busy consumes
without dismissal; idle confirmation dismisses, and an idle list falls
through. App consults that callback inside its existing touch-only Terminal
branch before `jumpedFrom` or the session-drawer floor. Previously neither
child participated, so Back could leave a busy confirmation for Chat.
No listener, global modal history trap or desktop history rule is added.
Sessions/Projects mounts exercise pending/idle behavior; App's source contract
pins the delegate before both existing fallthrough branches.
Unit traces cover every layer and overlap; a mounted Hub test exercises
ContextMenu/palette priority, the compact floor and registration cleanup.
Since board #134 (2026-09-09), Feed owns Copy/Raw state and registers live
`isOpen`/`outside`/`escape` callbacks with Hub's existing capture listener.
No flags are copied and no new listener or Back layer is installed.
Board #136 (2026-09-09) moves the Drawer view without moving those listeners
or its parent-owned state. Its controlled Files directory and Back callback
preserve the existing dispatcher path; Terminal stays keyed by target and
hidden partitions retain the original visibility gates.

**The dance is the phone's** (review, 2026-09-03). Everything above — the seed, the re-push after a consumed pop, the `popstate` router — is gated on `layout.isTouchDevice`, and `navPush()` is a no-op that returns `false` on a desktop layout. A desktop browser has no back gesture to protect, and the unconditional seed + re-push had made the app a page you could not Back out of: the browser's Back button did nothing, forever. On the phone nothing changed. Callers that later spend an entry with `history.back()` (the gear's toggle via `prefsPushed`, Settings' compact drill via `onDrill`'s return value → `drillPushed`) only do so when their push was real, so a narrow desktop window never `history.back()`s out of the app. The gate is reactive: switching the layout mode in Settings installs or removes the router live (entries already pushed before a switch to desktop are simply popped by the browser with nothing listening). `App.source.test.ts` pins the gate. Files' own `navPush` (a page-local push, Files-owned) still pushes on desktop; those entries are consumed silently by Back until the app's real root is reached — harmless, but the one remaining desktop push.

### Where you left off is persisted, and the tab is part of it

`tmux_state` carries `{ v: 2, page, pane, splitLayout, splitCells }`, where a
pane is a `PaneRef` that NAMES ITS SERVER (board #335 ②b-2,
`src/lib/app/nav-saved.ts`): `work:1.0` on its own does not say whose `work`
it is, and a restore runs against exactly one runtime. The record is written
whenever `connected` — it used to be gated on `terminalTarget`, so reading the
chat and refreshing dropped you on the device default (owner, 2026-08-19:
"每次切换或者刷新都会变") — and, since ②b-2, not until the restore for the
bound runtime has finished, because the record this effect writes is the one
the restore is about to read.

Reading is where the care goes, and three rules carry it:

- **Ownership is WHO PUT IT THERE, and only the shell knows.** A pre-#335
  record has no serverId, and it cannot be worked out from the content: two
  servers can hold byte-identical records, and `work:1.0` on A reads exactly
  like `work:1.0` on B (orchestrator, 2026-10-10 — an earlier version
  compared the live bytes with a boot snapshot and filed B's record under A).
  So App TRACKS the provenance instead: at boot the live record belongs to
  whatever CURRENT names, validated against the saved registry rather than
  trusted as a string, and from then on it belongs to whichever server the app
  ARRIVED at — a deep link, a switch, a connect — because while `pointTo` is
  still in service (②b-4 retires it) arriving is what surfaces that server's
  parked record into the live key.
- **An input nobody can be shown to own is quarantined, not guessed.** Its
  bytes are copied to `tmux_state::unattributed` with the machine id the
  legacy mirror named at that moment, before the shell can save over them;
  ②b-4 lets a server claim them by PROVING that machine is its own. Being the
  next server to authenticate is not evidence of having written them.
- **An absorbed entry takes its navigation with it, and only an absorbed
  one.** `recordServer` folds a machine's twin entries into one — an
  address-only entry that just learned it is the machine already saved —
  deletes the absorbed entry and moves CURRENT to the survivor. Everything
  that named the deleted id follows: the tracked provenance, every ref App
  holds, and the refs inside the record itself (`reownRef`, `reownSavedNav`).
  Without that the restore filtered out the navigation of the very machine the
  app had just connected to, and then saved the emptiness over it (reviewer
  P1, 2026-10-10). WHICH ids moved is the identity layer's own record of the
  merges it made — `tmux_server_merges`, written where the absorption happens,
  read through `servers.mergedInto` — never an inference from an id being
  absent from the registry. A forgotten entry or a record from a server this
  client never saved is absent too, and handing it to the current server
  would open that server's same-named pane (reviewer P1-a; a first version
  did exactly that). An id nothing explains keeps its server and is filtered
  out. This runs in `swapScope`, the one reader of CURRENT, so every path that
  records identity follows the same merges.
- **The restore is filtered to the runtime it runs against**, and runs only
  after that runtime is bound — never during the tick in which a swap shows
  nothing, which silently dropped every pane of the server being brought up. A
  foreign cell empties and keeps its place, so the split keeps its shape; a
  restore for a runtime that is no longer on screen does nothing. Restore is `restorePage` (`src/lib/app/nav-state.ts`, pure + tested): an unknown/stale name (a retired tab, an older build) falls back to `defaultPage` — Chat (the Hub) on every form factor since #333 (owner, 2026-10-09: "整个应用一打开的时候 默认已打开的窗口应该是第一个 chat 页面 而不是 terminal 页面"; it used to be terminal on touch) — never to a page that no longer renders. A connect from the Settings connect card also lands on `defaultPage` instead of a hard-coded Terminal; on a server without the Hub, the one hubless redirect (`hubState.probed && !hubState.available`) turns Chat into Terminal. The Hub's open project is `tmux_hub_project` via `hubPrefs.setProject`, verified against the current list on load (a project can be deleted between two visits) and only then falling back to the top row. Files is the deliberate exception: its cwd FOLLOWS the tmux session's cwd — but the SESSION it follows is whichever the user touched LAST (a terminal pane or the chat's selected project; it used to be terminal-only, so browsing a project in chat never moved Files — owner, 2026-08-22), and switching projects PARKS the in-Files browse position per session (in-memory, not a preference) and restores it on return, with the follow rule still outranking the parked position when that project's real cwd moved meanwhile. That parked map is MODULE-scoped in Files.svelte (owner, 2026-08-28: "每个 project 自己记录自己的 current路径"): every Files instance shares it and it outlives any one instance — which is what lets the Hub's drawer mount a fresh Files per open and still wake up where that project left off (a new instance restores its session's parked cwd at mount and parks on unmount).

### Shell motion follows the one vocabulary (2026-09-03)

Every state change in the shell moves on the tempo tokens and nothing else
([motion.md](motion.md)): the tab bar and gear cross-fade colour on `--t-fast`
and the gear TURNS 30° while Settings is open (a state is a movement, not a
swap); the reconnect banner, the rail's insertion line and the vitals sidebar strip's
first reading `.appear` (opacity only — never height, so the banner cannot
push the page); the split toggle is a `.state-ctl`; the server switcher's
180°-symmetric swap glyph is a `.quarter-turn` that turns 90° while its
popover is open (180° would look unchanged; the popover itself uses the
shared popover intro); the page slides still under
`prefers-reduced-motion` like the compact drill pair. The rail's icons sit in
a per-slot `.rail-slot` wrapper because Svelte's `animate:flip` must be the
keyed each's only child: the wrapper carries the dragged icon's inline
transform (no transition — the finger is the animation), so on release the
flip measures from under the pointer and the icon SETTLES into its new slot
on `moveMs()` instead of jumping back and sliding. `transform` is deliberately
absent from `.rail-btn`'s transition list for the same reason.

### The desktop primary sidebar collapses from its own head row (2026-09-11 #174; 2026-09-14 #202; revised 2026-09-20 #217)

**Current (board #217).** Owner, 2026-09-20, with two reference frames
(`.tmm/uploads/mu9nqemo-804b2fd0.webp`, `mu9nqlt0-f7bda893.webp`): "折叠按钮放到
侧边栏上吧，类似这个设计我觉得挺好的" — the toggle at the sidebar head's LEFT end
beside its title; collapsed, the same square at the same screen point leading
the page head. Four placements led here: #174 head-right (two nodes), #197 one
node riding the partition right→left (~190px from under the pointer: "手感卡卡
的"), #202 the rail, #215 the rail grouped and dimmed. The left end is what
makes the owner's frames work: the sidebar track shrinks from the RIGHT with
its content pinned left, so a control at the left edge has the same screen
coordinates open and collapsed — "on the sidebar" and "under the pointer" at
once, which no earlier seat managed. Mechanism: ONE shell node (`App.svelte`
`.side-toggle`, rendered beside the rail under the same desktop-connected
guard), `position: fixed` at `left: 46px + --side-toggle-x` (8px), centred on
the `--page-head-h` row; the same `CommandButton` `panel-left` glyph whose
chevron turns (open `<`, closed `>`, #215), as `secondary iconOnly` so its
quiet surface reads over a terminal; the same `toggleShellSidebar` delegate
(#199/#201/#200). It does NOT ride `--side-open`. The rows it visually joins
make room through one app.css rule set keyed on the shell state: open, each
desktop sidebar's first head wears `.side-toggle-row` (Chat's projects head,
Terminal's projects group label, Board's projects head) and becomes the
page-head row — `min-height: --page-head-h`, `margin-top: -8px` absorbing the
scroller's padding so its text centre is the page head's, `padding-left: 8px +
28px` so its text starts 8px after the square; collapsed, `.page-head` takes
`padding-left: 44px` on `--t-move`, so the title slides with the track. The
Terminal page with an open terminal already has a `.page-head` row above the
grid (the window title), so the square never covers terminal cells and the
grid's geometry is untouched. **Only the three pages that have the sidebar
show it** (board #219, owner 2026-09-20: "files页面里，多显示了折叠左侧边栏的按钮，还有
设置这些页面也都没兼容好"): `pageHasSidebar` (hub/terminal/board) gates the node
and puts `.side-page` on `<main>`, and the page-head room rule is keyed on
it — Files, Settings and Agents have no sidebar, so no toggle and no indent;
the collapsed STATE stays app-wide (#200) so hidden Terminal/Board tracks
keep their rest position. The node is `.shell-side-toggle` (the Board owns a
phone-only `.side-toggle` of its own). The rail is brand + tabs again; #215's head
group and rule went with the toggle (a rule with no reason is not kept).
Measured at 1440 on Chat, Terminal and Board, open → collapsed → open: the
square at x=54/y=7 (28×28) in every state; head text centre 21 = square
centre 21 = h1 centre 20.5; open, head text at x=90; collapsed, h1 (or the
terminal's window title) at x=90 with `padding-left` 44px, sidebar track 240 →
0; the terminal's `.xterm-screen` stays at y=42, h=848 throughout. Pins:
`App.source.test.ts` (one node, fixed seat, no ride, rail without toggle,
app.css rules, the three head classes), `Sidebar.source.test.ts`.

**History (#174 → #202), kept for the reasons.**

The desktop primary sidebar (the Hub's projects, Terminal's sessions and the
Board's projects; the phone has its sheet + scrim) is one app-wide state:
`hubPrefs.sidebarCollapsed` / `tmux_hub_sidebar`. Every page is a REVEAL track
on `--side-open`: its content is pinned at the final width,
`hub/reveal.ts` moves only the registered factor on `--t-move`, and at rest
collapsed content is `visibility: hidden` — unreachable, not narrowed.
The system-status bar retracts with it (#200).

#174 put the control in the Hub sidebar head; #197 moved one node with the
partition to make a 180° turn visible. That node existed only on Chat and,
crucially, moved about 190px away from the pointer on the click that pressed
it — the owner reported "点上去手感非常怪，感觉卡卡的". Board #202 removes that
whole mechanism: **THE one control lives in the desktop rail, under the
brand**, so it is stable under the pointer and present on every page.

The icon is drawn, not the owner's typed `→|`: `Icon`'s `panel-left` is a
window frame with a left pane and a `.turn` chevron in its content area. The
frame remains still; the chevron alone turns 180° on `--t-move`: it points
at the pane while it is open (collapse), away while it is closed (expand).
It is the normal rail icon command (achromatic at rest, the existing hover /
press wash), outside the travelling page-tab pill. Its click calls the active
page's `pageReselect` delegate — the same act as reselecting that rail tab:
the Hub retains `setSidebar`'s reading-anchor sequence; Terminal and Board
flip the shared preference and their reveal effects follow. The phone gets no
rail control because its sheet has its own opener. Owner #202: "除了 chat
以外，其他几个页面的折叠展开按钮好像还没有" and "现在这个按钮你要重新给我画。不是说把我打的
那个字符写上去，是给我画一个 icon 呀，对不对？".

Measured at 1440: the rail button stays at x=9/y=48 on Hub, Terminal and
Board while it changes state; its frame has no transform, chevron 180° → 14°
mid-turn → 0°. Guards: `App.source.test.ts` (rail location, shell delegate),
`Hub.source.test.ts` (no local control), `CommandButton.source.test.ts`
(drawn icon and `.turn` atom).

**A second click on the active rail tab brings the sidebar back (2026-09-14,
board #199).** Owner: "我应该在左侧的选项卡已经选中二次再点击的时候，也是自动帮我展开侧边栏".
`switchTab` returns when the target is the current page, so the rail used to
swallow the click. Now `railActivate` hands the ACTIVE page a "reselect"
(`pageReselect[page]`), registered by the page the way it registers its back
chain (`onReselect`); the **rail's stable panel control** invokes that same
delegate. #199 opened it only; #201 (owner 14:10 "选中点击也能展开，也能折叠") made
a reselect a toggle, and #202 makes the rail icon the direct, all-page way to
perform the same toggle. Terminal/Board flip the shared state; Hub uses its
`setSidebar` writer. Desktop only: the phone has no rail, and its sheet has
its own opener. Pins: `App.source.test.ts`, `Hub.source.test.ts`.

**ONE sidebar state for the whole shell (2026-09-14, board #200).** Owner: "左侧边栏
收起的时候，底下的系统状态显示也要收起，而且这个折叠收起在不同的页面是同步的，不然我点击chat
terminal board，展开状态不一致". `hubPrefs.sidebarCollapsed` was app-wide by intent
(#174) but only the Hub's grid read it: the Terminal page's `term-side` and the
Board's `.sidebar` were fixed `--sidebar-w` tracks and the fixed system-status
bar (#85) was always shown, so Chat collapsed and Terminal/Board did not. Now
App derives `shellSideCollapsed` (desktop, connected) and puts `.side-collapsed`
on `<main>`; the Terminal page and the Board are REVEAL tracks on the same
`--side-open` factor as the Hub — registered ONCE in `app.css` — moved by
`hub/reveal.ts` (pin at width, gate, hidden at rest) when the state changes
while they are on screen; the system-status bar retracts to width 0 on
`--t-move` and is unreachable at rest. The rail's stable panel control (#202)
and the rail reselect on any of the three pages (#199/#201, a toggle) change
it — `pageReselect.terminal = pageReselect.board = () =>
hubPrefs.setSidebarCollapsed(!hubPrefs.sidebarCollapsed)`. Measured at 1440 on a live server:
collapse in Chat → Terminal and Board tracks at factor 0, sidebars hidden,
status bar 1px/hidden, on every page; reselect on Board → `.moving` with the
sidebar pinned at 240px, factor 0 → 0.99 at 188ms → 1 unpinned by 279ms, the
status bar 1 → 237 → 240 in step; the Terminal page likewise (0 → 0.77 at
111ms → 1 by 211ms). Pins: `App.source.test.ts`, `Board.source.test.ts`,
`Hub.source.test.ts` (no second `@property`).

**The rail head is chrome: brand + toggle in one group, closed by a rule
(2026-09-20, board #215).** Owner: "左侧的折叠展开按钮放到了侧边栏上 好像和其他图标混淆在
一起了 你看帮我优化一下吧 感觉这个按钮显示得有点让人费解了". #202 put the toggle under
the brand at the tabs' pitch, in the tabs' column, with the icon variant's
default `--text` ink — BRIGHTER than a tab at rest (`--text3`) — so it read
as one more page tab, though it is a different kind of control (a sidebar
state toggle, not a destination). No new icon and no second mechanism: the
brand and the toggle now sit in `.rail-head`, a 30px-wide group (gap 2px)
whose `border-bottom: 1px solid var(--border)` is the divider — shorter than
the 46px rail so it reads as a rule, not a frame — with 6px padding above it
and 4px + the rail's 4px gap below, so the first tab, its hover wash and the
travelling pill start 8px under the rule. The toggle keeps its 28px hit box,
the wash-family hover and the `panel-left` glyph whose chevron turns; at rest
it is the tabs' `--text3` with a 15px glyph (a tab's is 17px), hover `--text`
like a tab — told apart by its group and the rule, never by being brighter.
The pill only ever finds `.rail-btn.active`, and nothing in the head is a
`.rail-btn`, a drop anchor or a drag handle. Measured at 1440: toggle at
x=8.5/y=38 (28×28, glyph 15) in every state, rule at y=73 width 30, first tab
at y=81 (8px gap), pill 34×32 at y=81/117 as Chat/Terminal are chosen and
never over the toggle (bottom 66); rest ink `rgba(26,26,46,0.35)` =
`--text3`, hover `rgb(26,26,46)` = `--text`; chevron `matrix(-1,0,0,-1)` ↔
`none` across a collapse and back. Pins: `App.source.test.ts` (#202 pin
updated, #215 pin). Review of #215 also fixed the chevron's DIRECTION: the
base `panel-left` polyline pointed left, and `.flip.on` (sidebar open) turned
it to point right — the reverse of the rule above and of the common
convention. The base now points right (closed = "expand"), so the open
state turns it left, at the pane (measured: open `<`, closed `>`); pin in
`CommandButton.source.test.ts`.

### The chosen tab is marked by ONE highlight that travels (2026-09-04, #86)

**Current scope:** the desktop rail retains its travelling wash. The phone
tab bar's wash described below was retired on 2026-09-05; phone tabs select
by foreground ink alone, with no background or marker (motion principle 14).
The original 2026-09-04 description and owner quote remain historical evidence,
not permission to restore the phone wash. Configuration Segmented controls
still use a travelling marker; the phone-tab exception is not a global rule.

The tab bar and the rail each hold a single `.slide-pill` (motion.md §1.14,
`ui/indicator.ts`): the accent WASH behind the active phone tab (inset so it
hugs icon + label) and behind the active rail icon. When the page changes the
wash GLIDES to the new item on `--t-move` while the buttons' own ink still
cross-fades on `--t-fast` — the change reads as a movement rather than one
icon switching off and another on. The buttons themselves paint no active
background any more; the pill carries it. There is no bar: the first cut drew
a 2px line under the tab / beside the icon, and the owner retired it the same
day ("线条都去掉，直接用 icon 上面的背景阴影来滑动"). Two mechanics matter:

- **Measured by layout offsets, never client rects.** The first cut read
  `getBoundingClientRect()` and divided by `uiZoom()`; on the phone the marker
  "乱滑" — it slid somewhere wrong, then corrected itself. A rect includes
  every transform on the way: the tab's press `scale(0.95)` while the finger is
  still down, a `.rail-slot` mid-`animate:flip`, the root's CSS `zoom`. The
  action now walks `offsetParent` from the item and from the container to
  their common root and subtracts (`boxFromOffsets`, pure and tested): the
  layout box is where the item WILL rest, so the pill goes straight there.
- **Hidden while the rail is being rearranged.** `hidden: !!railDrag`
  collapses the pill during an icon drag and re-measures on release, with a
  second read after `moveMs()` for a layout that is still settling.
### The rail explains itself on hover (2026-09-04, #86)

A rail icon, the server switcher, the gear and the split toggle wear
`use:hoverInfo` (motion.md §1.16): resting a pointer opens the ONE shared
card — a page's name with its shortcut as the note (read live from
`shortcuts`, so a rebinding shows at once; every rail page has one since board 316, and the server switcher's card carries the switcher binding),
the switcher's current server with its address and connection state, the
gear's and the split toggle's names. Their native `title`s were removed: a
browser tooltip next to the card is a second tooltip species, which is the
thing the rule forbids. `aria-label`s stay — the card is pointer/keyboard-
focus only and the label is for everyone; on touch there is no card and
nothing was lost, since touch never showed a title either. The phone's tab
bar gets no card for the same reason.
