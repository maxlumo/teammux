# Board dashboard: what needs the person, the current state, an agent-maintained page

Board #104. Proposal v3, 2026-11-11, written by the leader for the owner's
decision, after a first-principles look by reviewer (design), pentester (the
page's threat model) and builder (feasibility); their notes and the rulings
are on the issue. Nothing here is built. The owner's decisions are in § 10.

Owner, 2026-11-11 05:23: "我想加一个功能，在board页面增加一个dashboard功能，
包括现在状态的统计，以及agent给人类的状态信息等，留言，让人有更好的交互，现在
还是agent信息量太大了，人处理不过来，或者错过重要信息。另外这个dashboad可以
支持agent自己写的能力，就是agent可以维护一个静态网页代码，嵌入在dashboard里，
人可以在不同的项目里有不同的交互。这个你们可以好好想想，给我设计好。"

## 1. The problem, from first principles

The person is the scarce resource; the agents are not. Everything an agent
tells the person today is a **message in a stream**, and a stream has no
state:

- **A question to the person has no "open / answered".** It is a chat line.
  When the next twenty lines arrive it is gone from view, so the asker repeats
  it. Measured in this project's room: the leader sent the Fable 5.2 question
  four times in 20 hours (11-10 03:0x, 17:20, 22:00, 23:16), and on 11-09
  16:28 listed six decisions and five things to verify on the phone in one
  paragraph. None of them can be answered in place, ticked off, or found
  again without scrolling.
- **"Needs you" and "for your information" look the same.** Of the last 1000
  room messages in this project, 44 were addressed to the owner (15,500
  characters); he wrote 14. At the "To me" level the bell treats all 44
  alike.
- **The state of the project must be read out of prose.** Who is working on
  what, what finished since yesterday, whether the team is idle or blocked on
  him: all derivable from the board and the hooks, but shown only as the
  roster's cards (per agent) and the board's columns (per issue), never as
  one answer.
- **Every project is shown the same way.** A music pipeline, an API gateway
  and this app have different things worth seeing (a mix to listen to, a
  deploy to approve, an APK to install). Only the agents working there know
  what those are.

So the layer is not "more notifications". It is **durable attention**: a
small set of things that stay where they are until the person has dealt with
them, beside a derived answer to "where are we", beside a page the project's
agents keep.

## 2. What we add, in one paragraph

The Board tab gets a second view, **Dashboard**, beside the columns. Top to
bottom it holds four sections; the first three are derived by the app, the
fourth is written by agents:

1. **Needs you** — the open *asks*: questions an agent put to the person,
   each with its options and the asker's recommendation, answered with one
   tap. An ask stays until the person answers or dismisses it, or the asker
   withdraws it.
2. **Now** — two summary lines (the board's four counts; how many agents are
   working, waiting, idle, down), a row for each agent that is working,
   waiting or failed, and what finished in the last 24 hours. A summary with
   a way into the roster and the board, not a second roster.
3. **Notes for you** — the three newest messages agents addressed to the
   person, one line each, unread ones marked; a tap opens the chat there.
4. **Project page** — one static page the project's agents publish, embedded
   inert, whose buttons can do one thing: propose a message for the person to
   send to an agent.

One new concept (the ask), one new artifact (the published page), two verb
families (`tmm ask`, `tmm dashboard publish`). Everything else is a
projection of what the room, the board and the hooks already record.

```
Desktop (Board tab, Dashboard view)              Phone (project → Dashboard)
┌──────────┬──────────────────────────────────┐  ┌───────────────────────────┐
│ projects │ teammux        [Dashboard|Board] │  │ ‹ teammux  [Dashb.|Board] │
│          ├──────────────────────────────────┤  ├───────────────────────────┤
│ teammux  │ NEEDS YOU · 2                    │  │ NEEDS YOU · 2             │
│ 等你2 4·1│ ┌──────────────────────────────┐ │  │ leader · 7h · #103        │
│ token-p… │ │ leader · 7h · #103           │ │  │ 聚合模式桌面状态条放不下… │
│ 等你1 2·0│ │ 聚合模式桌面状态条放不下服务 │ │  │ [A 名字单独一行 ★]        │
│ sound-f… │ │ 器名 + 三项，取舍：          │ │  │ [B DISK 进卡片]           │
│          │ │ [A 名字单独一行 ★] [B DISK…] │ │  │ [ answer…              ➤] │
│          │ │ [ answer…        ➤ ] Dismiss │ │  │ Dismiss · Discuss in chat │
│          │ └──────────────────────────────┘ │  │ ───────────────────────── │
│          │ ┌ leader · 1d · Fable 5.2 … ───┐ │  │ leader · 1d · Fable 5.2 … │
│          │ NOW                              │  │ NOW                       │
│          │ todo 4 · doing 1 · review 0 ·    │  │ todo 4 · doing 1 · …      │
│          │ done 101 │ 1 working · 4 idle    │  │ 1 working · 4 idle        │
│          │ ● builder  #103  width budget…   │  │ ● builder #103 budget…    │
│          │ Finished · 24h: 2 ▸              │  │ Finished · 24h: 2 ▸       │
│          │ NOTES FOR YOU                    │  │ NOTES FOR YOU             │
│          │ • leader 23:16 新 APK：temp/an…  │  │ • leader 23:16 新 APK…    │
│          │ • leader 23:12 #102 已合并部署…  │  │ PROJECT PAGE · leader 3m  │
│          │ PROJECT PAGE · by leader · 3m    │  │ (the agents' page)        │
│          │ ┌──────────────────────────────┐ │  └───────────────────────────┘
│          │ │ (the agents' static page)    │ │
│          │ └──────────────────────────────┘ │
└──────────┴──────────────────────────────────┘
```

## 3. The ask

**An ask is a room message that expects the person's answer.** It is the one
new concept, and it exists because that one fact (a question is open) is
what the stream cannot hold.

- **It is a message.** Recorded in the room like every `@human` line, shown
  in the chat as a bubble with its options as buttons (so it can be answered
  where it is read), printed by `tmm log`. One room: people and agents read
  the same record (tenet 5). The message is the one record of the question;
  a companion row holds only its structure and state.
- **It carries structure, not a body to parse:** the question (markdown), up
  to six options (a short key and a label each), the asker's recommendation,
  and optionally the issue it belongs to. The body that an older client and
  `tmm log` print is composed from that structure by one server function.
- **It is bound to the asker's lifetime**, not to its name: the identity of
  the managed home that asked. An agent removed and created again under the
  same name is somebody else and never receives the old ask's answer.
- **Only the person answers; only a managed agent of the project asks.**
  Agents ask each other with `tmm send`, as today.

### Decision state: explicit acts only

| state | reached by | shown as |
|---|---|---|
| open | `tmm ask` | a card in Needs you; a bubble with live buttons |
| answered | the person taps an option (with or without a comment), or sends text from the card's box, which says **Answer** | the answer, who, when |
| dismissed | the person taps Dismiss: "I will not answer this" | dismissed, when |
| withdrawn | the asker closes it, with a line of why, and may cite a room message (`tmm ask close <id> "why" --re <seq>`) | "withdrawn by <asker>: why", the cited message quoted |

All three closings are terminal. **Only the person's own act on the ask
makes it answered**: the card and the chat bubble are the two places to do
it, and both name the ask. An approval is never inferred. A "可以" typed
into the chat names no ask (on 11-10 the same word could have meant the
phone's 48 px or the desktop's, #102 and #103), so an asker that reads it as
its answer can only **withdraw**, citing that message; the record then says
what happened: the agent's reading, with the person's words beside it. A
question back ("A 的 48px 只在聚合模式吗？") is not an answer either:
**Discuss in chat** opens the chat at the ask's bubble with Reply armed, and
the ask stays open.

### Delivery state: the one delivery path's, shown beside the decision

The answer (and a dismissal) is a message from the person to the asker.
**One SQLite transaction** appends that message and changes the ask's state;
nothing is typed before it commits. **After the commit** the line goes
through the one delivery path like a composer message, with that path's own
failures and reports. What happened to the line is shown next to "answered"
and never merged into it:

| asker at that moment | what happens |
|---|---|
| live pane | typed, quoting the ask; an unconfirmed typing is reported as for any message (#437) |
| CLI exited, pane at the shell | held and typed once at its restart (the #77 rule) |
| stopped | nothing is typed and nothing is queued (hub-composer.md: no second queue). The card says "answered · not delivered: asker stopped"; the asker reads its answers with `tmm ask list` when it starts |
| gone (removed; or a same-name replacement) | recorded only; the card says "asker is gone" |

### Interleavings (written as tests before code; the lesson of #92/#95/#98/#100)

| event | result |
|---|---|
| two clients answer at once | one guarded update decides (`state='open'` → changed rows = 1); the loser gets "already answered at HH:MM" with the winner's answer, sends nothing, repaints |
| the person answers while the asker withdraws | first commit wins; the other is refused with the winner shown |
| the answer's reply is lost and the client retries | the id is derived from the ask and the edge: the retry returns the same row, nothing is typed twice |
| the server stops after the commit, before typing | the decision stands (it is committed); the line's fate is whatever the delivery path does for a composer message today, reported as such; no ask-specific queue, and never a send before the commit |
| answer, dismiss or withdraw on a closed ask | refused, state shown |
| the project is renamed, archived, removed | asks follow the room, as issues follow the board |

What an ask is **not**: a board issue (work with acceptance and four
columns; questions would bury the plan), a permission prompt in a pane (the
CLI's own, shown as `waiting` on the card, unchanged), a priority flag on a
message (a flag has no end).

Nothing caps how many asks an agent may open: a cap loses questions. The
list shows every open ask as a compact card (the question clamped, expanded
by a tap), oldest first, the asker and the age on each, and the person can
dismiss. An agent that floods it is visible at once.

## 4. Now: the derived summary

One read, `hub_dashboard(session)`, computed by the server from state.db and
the live roster. Nothing in it is an agent's own claim except the status
line, which is shown as the agent's words.

- **Line 1, the board:** the four counts in the existing chips. A tap opens
  the Board view.
- **Line 2, the agents:** how many are working, waiting, idle, not running,
  failed. A declared-stopped agent is not a problem and is only counted.
- **Rows:** only agents that are working, waiting on a prompt in their pane,
  or failed: the status dot (the one colour language), name, the issue it
  holds (assignee of an issue in doing), its latest `tmm send --status` line
  with its age. A tap opens the chat with that agent. Idle and stopped
  agents have no row.
- **Finished · 24h:** issues moved to done in the last 24 hours, a count that
  unfolds to title, who and when. A fixed window, not "since your last
  visit": it needs no new read mark and is the same on every device.

No sums across servers; in Aggregate the dashboard body is the focused
project's server's, like the board body.

## 5. Notes for you

The three newest messages addressed to the person in this project, by the
**same predicate the bell's "To me" uses** (one definition of "addressed to
the person": explicit `@human` lines and the replies to his own messages),
asks excluded since they are above. One line each (sender, time, first
line); unread ones marked by the room's existing read mark; "all in chat"
below. A tap opens the chat at that message through the existing jump.
Looking at the dashboard never moves the room's read mark. No new state.

## 6. The project page

**What it is.** One static page per project, `index.html` with the files
beside it, that the project's agents author wherever they work (a worktree,
a versioned folder) and **publish**:

```
tmm dashboard publish <dir>
```

The door validates (an `index.html`, regular files only, no symlinks, a size
ceiling), copies the bundle into its own **revision** directory under
`<ws>/.tmm/dashboard/` and then moves the "current" pointer, recording who
published and when. So a reader never sees a half-written page, several
agents cannot interleave their writes (the last publish wins, with its
author's name on the section header), and an agent confined to its worktree
or its sandbox can still publish. A loaded document's own files (its
stylesheet, its pictures) are read from **its** revision, so a page kept on
screen while a newer one is published stays one consistent snapshot; the
revision before the current one is kept for that, older ones are removed at
the next publish. Project files a page points at outside its bundle (a mix,
a report) are live by declared policy: they are the project's, not the
page's. `<ws>/.tmm/` is already one of the two stores (tenet 7).

**How it is shown.** Exactly as the Files page previews an HTML file today
(board #433), mounted as the dashboard's last section:

- **inert**: the preview's frame, which shares the app's origin and runs **no
  scripts** (that pairing is what lets the app read the page's clicks and
  form fields, and it is why scripts can never be added to this frame). The
  app's content policy on top; no network except the signed, read-only door
  to the project's own files (styles, images, fonts, audio, video; never
  html, js or json). It cannot run code, navigate the app, open windows,
  submit forms or reach another origin;
- **the project's own files, not copies**: the door's root is the project,
  as for any previewed HTML, so a page can play the mix in
  `EP/03_music/out/` or show a chart the agents rendered, by a relative
  path. This gives nobody access they lack: the reader is the person, who
  reads every project file in Files; the author is an agent with a shell
  there; an inert page observes nothing. (Pentester proposed rooting the
  door at the page directory; not taken, for this reason, recorded on #104.)
- **the app's look for free**: the app injects its tokens (the current
  theme's colours, the font roles, the type steps) as a base stylesheet, so
  plain semantic HTML (headings, tables, lists, `<details>`, `<audio>`,
  inline SVG) looks native in dark and light, on a 320 px phone and a wide
  desktop. A page may add its own CSS;
- **one scroll**: the frame is as tall as its content, re-measured when a
  late image loads; the dashboard scrolls as one page;
- **the app's chrome is outside it**: the section header ("Project page · by
  leader · 3m ago") and everything above are the app's. The page is the last
  section, so it can neither draw over "Needs you" nor push it away.
- a page directory or `index.html` that is a symlink shows no page; links
  use the preview's one handler (`..` above the root refused, `javascript:`
  and `data:` dead, web links leave the app).

**How it interacts: one verb, always confirmed.** The page is a projection
the agents keep; the person acts on it by saying something to an agent,
which then acts and publishes again. The app handles the click, not the page:

- `data-tmm-send="@name text"` on a button or link; on a `<form>`, the named
  fields are appended as `name: value` lines (the app reads them; the form
  never submits).
- **Every send is confirmed**, in the app's one confirm dialog, drawn outside
  the frame: the recipient on its own line and the **full assembled text,
  verbatim**. Never remembered, never skipped; one confirm at a time, further
  requests dropped while it stands. This is a rule of the design, not a
  setting: the message carries the person's name, and a button's label is
  whatever the page says it is.
- Refused by the app, on the assembled text: a recipient that is not a
  managed agent or team of this project; a text beginning with `/` (a slash
  command is typed verbatim into a CLI); empty; over the composer's limit.
- A relative link opens that file in the app's preview or download (the
  APK, a report), as a path in chat does, and Back returns to the dashboard
  through the app's existing return. v1 is one file: a link to another
  `.html` opens in Files like any file, so the page has no history of its
  own. `tmm:issue/103` opens the issue.

**Its lifetime: nothing changes under the person's hands.**

- The gesture freezes the **action envelope**: server, project, recipient,
  the exact text with the form's values, and the revision it came from. The
  confirm shows and sends that envelope; a page published meanwhile, a
  project switch or a focus move cannot rewrite or redirect it.
- A newer revision is **adopted automatically only when nothing is in
  progress**: no edited field, no playing media, no standing confirm, the
  scroll position kept. Otherwise the header offers **Refresh**. This is the
  ONE adoption rule: a first entry has no document and loads the newest;
  returning to a document the app kept (after a look at Chat, or a hidden
  tab) goes through the same guard, so a half-filled form is still there.
  Refresh on a page with edited fields, and leaving the project, discard
  them through the app's existing discard confirm.
- The file door's signature is renewed at each load (it lasts 4 hours).

**Why no scripts in v1.** The page is written by an agent that may have read
anything on the web. The app that shows it holds the gateway token, the
encryption keys, the native bridge of the phone and desktop apps, and in
Aggregate the connections to other servers. The existing rules (never
scripts and same-origin in one frame; `script-src 'self'`) already forbid
it. What is lost: sorting a table, a hover on a chart, an editor inside the
page. A scripted page would be a different frame (no origin, no network, a
message bridge for the same one verb with a gesture the app can verify),
served by a new door, and is acceptable only if a measurement on the real
Android and macOS apps shows the native bridge cannot be reached from it;
if it can, the answer is no. See D1.

```
agent publishes the page ───────────────▶ app shows it (inert)
        ▲                                        │ person taps "Approve mix 4"
        │                                        ▼
agent acts, publishes again ◀── pane ◀── confirm: To @composer — "Approve mix 4"
```

Every arrow is one of the three primitives the shell already has: a file in
the workspace, text typed into a pane, `tmm` invoked by the agent.

## 7. The agent's side (CLI parity)

```
tmm ask "question" [--option KEY=label]… [--recommend KEY] [--issue N]
                                 one question to the person; prints its id. It stays
                                 on the dashboard until closed. Never repeat it.
tmm ask list [--all]             this project's open asks; --all: closed ones with
                                 their answers (read this after a restart)
tmm ask close <id> "why" [--re <seq>]
                                 withdraw it; --re cites a room message (e.g. the
                                 person's reply in chat). It never marks it answered.
tmm dashboard publish <dir>      publish <dir>/index.html and its files as the project page
```

There is no `tmm dashboard` text view: `tmm ask list`, `tmm board` and
`tmm agent list` already print each part, and a command no agent needs is
not added (tenet 6). The shipped `tmm` teaching (the prompt block and the
tmm-cli skill) gains three sentences: a question only the person can answer
goes through `tmm ask`, one question with its options and a recommendation;
an open ask is never repeated; a project page is optional and published with
`tmm dashboard publish`.

## 8. Where it shows, and what it must hold in

**Surfaces**

| surface | behaviour |
|---|---|
| Board tab, desktop | `ui/Segmented` in the page head: Dashboard · Board, remembered per device; default per D2 |
| Board tab, phone | project list ⇄ the same two views; Back peels to the list; one column; nothing is hover-only |
| Hub drawer's embedded board | Board only: the drawer is the room's side tool |
| Chat feed | an ask is a bubble with its options and both states; answering there or on the dashboard is the same act |
| Bell and notification centre | **an ask rings at every level**, like a finished task and the unconfirmed-typing report: an explicit amendment to notifications.md's list of what is news, under the existing away, mute, dedup and cooldown rules and the running-client limit. Its entry opens the chat at that message through the existing jump and its viewed-on-success rule; there is no second jump |
| Board sidebar row | the open-ask count as one more chip leading the row's count line, in the chip language, from one bulk read like `hub_board_counts`. The Chat row keeps its single unread count; no second number there |

**Lifetimes and combinations** (each a test or a measured case, not a note)

| case | rule |
|---|---|
| Aggregate, servers of mixed capability | the view switch, the chip and `tmm ask` exist per server that announces the `dashboard` capability; a server without it shows today's Board |
| Aggregate, a server disconnected or its read failed | its last complete data stays, muted, "not connected"; a failed read never reads as "no asks" |
| same-named projects on two servers | keyed by server and session, as the Board's union is |
| focus A → B → A with reads or a page load in flight | every read belongs to a generation bound to the runtime handle; a late answer of an old owner is dropped (the #335 rule); a same-id reconnected runtime is a new owner |
| first load, failed load, stale data | nothing is drawn before the first success; a failed poll keeps the last; the view says when its data is not live |
| hidden, then shown | the poll stops while hidden and reads at once on return |
| older server, newer app | no capability: no switch, no chip, no ask bubbles |
| newer server, older app | an ask is a plain message with its options as text; a reply in chat does not close it; the asker links it or the person answers on an updated client |
| authoring from a worktree, several agents, a sandboxed CLI | `tmm dashboard publish`: the last publish wins, atomically, attributed; a document on screen keeps its own revision's files |
| no page published | the fourth section is absent |
| input | keyboard only (options are buttons in focus order); an IME's Enter never sends the answer box (the note box's rule); wide touch targets; six long options wrap |
| widths and themes | 320 / 390 / 1280, dark and light, real Chromium, by natural widths with the longest realistic names, server tags and numbers, for the sidebar row, the cards and the confirm with a very long text (the #102/#103 lesson) |

## 9. Phasing (each ticket verifiable alone, in this order)

| | ticket | outcome |
|---|---|---|
| 1a | Asks, server | the store with the state table as tests, `tmm ask`, the RPCs, delivery, the capability, the teaching text |
| 1b | Asks, client | the chat bubble with options and both states; the bell amendment |
| 2a | Dashboard read | `hub_dashboard`, the bulk ask count, the Board sidebar chip |
| 2b | Dashboard view | the switch, Needs you (answer, dismiss, discuss), Now, Notes for you |
| 3 | Project page, read-only | `tmm dashboard publish`, the inert embed, tokens, height, revisions and Refresh, links and media |
| 4 | Page actions | `data-tmm-send` with the frozen envelope and the confirm, forms, issue links |

1a–2b answer "I cannot keep up and I miss what matters". 3–4 answer "each
project its own interaction". 1a–2b ship without 3–4.

Before ticket 3 is designed further, one measurement: in real Chromium in
the rig, then by pentester on the Android and macOS apps, the script-less
same-origin frame — does anything in it ever execute (SVG `onload`, meta
refresh, `javascript:` links, CSS-triggered loads); do the app's click
listeners and field reads work; is the content height readable; does any
request leave for an origin other than the signed door. Pentester verifies
ticket 3 before it ships.

## 10. Decisions for the owner

| | question | options | recommendation |
|---|---|---|---|
| D1 | What should a project page let you do? v1 as designed: see whatever the agents lay out (tables, charts as pictures, status), play audio and video, open and download files, and tap buttons or fill small forms that send your message to an agent (each one confirmed). Not in v1: anything that needs code running in the page — sorting or filtering a table yourself, live-updating charts, an editor in the page. | (a) Start with that. (b) You already have an interaction in mind that needs code in the page: tell us which, and it becomes its own ticket after a security measurement on the real phone and desktop apps. | (a) |
| D2 | What does the Board tab open on? | (a) Dashboard, with Board one tap away. (b) Board, as today, with Dashboard one tap away. | (a): the tab's first answer becomes "what needs me" |
| D3 | One list of asks across all projects? | (a) v1: the count on each project's row in the Board sidebar. (b) Also an "All projects" list of every open ask. | (a) first; (b) if the counts prove not enough |

Stated behaviour you can veto, not questions: an ask rings at every
notification level; a page button's message is always confirmed with its
exact text; the words are Dashboard · Board and Needs you / Now / Notes for
you / Project page (概览 · 看板；等你处理 / 现状 / 留言 / 项目页).

## 11. Considered and rejected

- **An ask as a board issue assigned to the person.** Reuses everything, but
  a question is not work: no review column, it buries the plan of record
  under answered questions, and it cannot be answered with one tap.
- **A "handled" tick on every message to the person.** A second notification
  centre, and it puts "for your information" back in the list with "needs
  you", which is the confusion this removes.
- **Priority levels on messages.** Every message is important to its author.
  A level has no end state; an ask does.
- **An agent-written summary as the dashboard's top.** A summary is a claim;
  the counts, the states and the finished list are derived (tenet 8). The
  agents' words have their places: the status line, the notes, the page.
- **An asker marking its ask answered, even by linking the person's chat
  message.** A message that names no ask does not say which ask it answers;
  linking it is still the agent's interpretation. The asker withdraws and
  cites; only the person's act on the ask is an answer.
- **A row for every agent in Now.** A second roster. The roster is one tap
  away; Now lists who is active and counts the rest.
- **"Finished since your last visit".** A new read mark, and an answer to
  "when is a visit". A fixed 24 hours is the same on every screen.
- **A dashboard band above the board's columns.** The board page never
  scrolls and its columns share the height; a band takes it from them.
- **Agents writing the page's files in place.** No atomic change, no author,
  no revision, and out of reach for an agent confined to its worktree.
- **The page as markdown.** Safer still, but the owner asked for a web page,
  and media, layout and buttons are what make projects differ.
- **A widget kit the app renders from JSON.** An engine: every new need is a
  new widget in the app. A page the agents own is a file.
- **Reminders and escalation for old asks.** The dashboard holds them and
  the age is on the card. A reminder is the stream again.
- **A cap on open asks.** It loses questions. Compact cards and Dismiss
  bound the cost to the person instead.

## 12. What this does not change

The room stays the one record. The board's columns, rules and CLI are
untouched. Delivery is still typing into a pane, with no new queue. The
room's read mark moves only by reading the room. The notification levels
keep their meaning for everything that exists today; the one amendment is
that an ask, a new kind of news, rings at all of them.
