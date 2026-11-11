# Board dashboard: what needs the human, the current state, an agent-maintained page

Board #104. Proposal, 2026-11-11, written by the leader for the owner's
decision. Nothing here is built. Open decisions are in § 10; each has a
recommendation.

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

So the layer is not "more notifications". It is **state**: a small set of
things that stay where they are until the person has dealt with them, next to
a derived answer to "where are we", next to a page the project's agents keep.

## 2. What we add, in one paragraph

The Board tab gets a second view, **Dashboard**, beside the columns. Top to
bottom it holds four sections, the first three derived by the app, the fourth
written by agents:

1. **Needs you** — the open *asks*: questions an agent put to the person,
   each with its options and the asker's recommendation, answerable with one
   tap. It stays until answered.
2. **Now** — the board's four counts, each agent's derived state with the
   issue it holds and its latest status line, and what finished in the last
   24 hours.
3. **Notes for you** — the messages agents addressed to the person, one line
   each, newest first, unread ones marked; a tap opens the chat at that line.
4. **Project page** — a static page the project's agents maintain as files
   in the workspace, embedded inert, whose buttons can only do one thing:
   offer the person a message to send to an agent.

One new concept (the ask), one new place (the page directory), one verb
family (`tmm ask`) and one path printer (`tmm dashboard path`). Everything else is a projection of what the
room, the board and the hooks already record.

```
Desktop (Board tab, Dashboard view)              Phone (drill-down: project → Dashboard)
┌──────────┬──────────────────────────────────┐  ┌───────────────────────────┐
│ projects │ teammux        [Dashboard|Board] │  │ ‹ teammux  [Dashb.|Board] │
│          ├──────────────────────────────────┤  ├───────────────────────────┤
│ teammux  │ NEEDS YOU · 2                    │  │ NEEDS YOU · 2             │
│  ● 2     │ ┌──────────────────────────────┐ │  │ leader · 7h · #103        │
│ token-p… │ │ leader · 7h · #103           │ │  │ 聚合模式桌面状态条放不下… │
│  ● 1     │ │ 聚合模式桌面状态条放不下服务 │ │  │ [A 名字单独一行 ★]        │
│ sound-f… │ │ 器名 + 三项，取舍：          │ │  │ [B DISK 进卡片]           │
│          │ │ [A 名字单独一行 ★] [B DISK…] │ │  │ [ reply…               ➤] │
│          │ │ [ reply…                  ➤ ] │ │  │ ───────────────────────── │
│          │ └──────────────────────────────┘ │  │ leader · 1d · Fable 5.2   │
│          │ ┌ leader · 1d ─ Fable 5.2 … ───┐ │  │ …                         │
│          │ NOW                              │  │ NOW                       │
│          │ todo 4 · doing 1 · review 0 ·    │  │ todo 4 · doing 1 · …      │
│          │ done 101                         │  │ ● builder  #103  budget…  │
│          │ ● builder   #103  width budget…  │  │ ○ validator idle          │
│          │ ○ validator idle · 6h            │  │ Finished · 24h: 2 ▸       │
│          │ ○ reviewer  idle · 6h            │  │ NOTES FOR YOU             │
│          │ Finished · 24h: #102 #101 ▸      │  │ • leader 23:16 新 APK…    │
│          │ NOTES FOR YOU                    │  │ PROJECT PAGE              │
│          │ • leader 23:16 新 APK：temp/an…  │  │ (the agents' page)        │
│          │ • leader 23:12 #102 已合并部署…  │  │                           │
│          │ PROJECT PAGE · updated 3m ago    │  └───────────────────────────┘
│          │ ┌──────────────────────────────┐ │
│          │ │ (the agents' static page)    │ │
│          │ └──────────────────────────────┘ │
└──────────┴──────────────────────────────────┘
```

The project rows of the sidebar (Board and Chat share `.proj-row`) show the
count of open asks in the accent colour, so "which project needs me" is
answered before any project is opened.

## 3. The ask

**An ask is a room message that expects an answer from the person.** It is
the only new concept, and it exists because that one fact (a question is
open) is what the stream cannot hold.

- **It is a message.** It is recorded in the room like every `@human` line,
  it shows in the chat (with its options as buttons, so it can be answered
  where it is read), it rings the bell at every level, and `tmm log` shows
  it. One room: people and agents read the same record (tenet 5).
- **It carries structure, not a body to parse:** the question (markdown), up
  to a handful of options (a short key and a label each), the asker's
  recommendation, and optionally the issue it belongs to. The body that old
  clients and `tmm log` print is composed from that structure by one
  function on the server.
- **Its state is two edges, never a field an agent sets:** open until (a) the
  person answers it, or (b) the asker closes it (withdrawn, or "answered in
  chat: 可以"). Both are room messages that quote the ask; the state changes
  in the same transaction that records the message. Terminal either way.
- **The answer is delivered like any message from the person:** typed into
  the asker's pane through the one delivery path, quoting the ask
  (`[tmm chat …] human: [re ask: 「…」] A · 名字单独一行 — and keep 24px on
  Single`). A stopped asker gets it at its next start, once (the #77 rule).
  An option tap sends the key and label; the reply box adds free text; a
  free-text answer alone is always possible.
- **Only the person answers; only a managed agent of the project asks.**
  Agents ask each other with `tmm send`, as today.

State machine and the interleavings (to be written out as tests before code,
the lesson of #92/#95/#98/#100):

| event | open | answered | closed |
|---|---|---|---|
| person answers (any client) | → answered; delivered once | refused: "already answered at HH:MM" with the answer shown; nothing sent | refused: "the asker closed it"; nothing sent |
| asker closes | → closed; a room line | refused, answer stands | no-op |
| asker removed from the project | stays open, marked "asker is gone"; an answer is recorded only | — | — |
| two clients answer at once | first commit wins; the second gets the refusal above and repaints | | |
| answer while the asker is stopped | answered; held and typed at the next start | | |

What an ask is **not**: a board issue (an issue is work with acceptance and
four columns; a question would fill the board with non-work), a permission
prompt in a pane (that is the agent's own CLI asking, shown as `waiting` on
its card, unchanged), or a priority flag on a message (a flag has no end).

Volume: nothing caps asks in v1. The asker's name and the age are on every
card; an agent that floods the list is visible at once, and the remedy is its
prompt. A cap is added only on evidence.

## 4. Now: the derived state

One read, `hub_dashboard(session)`, computed by the server from state.db and
the live roster; nothing in it is an agent's own claim except the status line,
which is shown as the agent's words.

- **Board:** the four counts (the existing chips and colours); the number of
  issues in review; the oldest issue in doing with its age.
- **Agents:** one row each: the status dot (the one colour language), name,
  the issue it holds (assignee of an issue in doing), its latest
  `tmm send --status` line with its age, and context use when the vitals have
  it. Failed and not-running agents sort first.
- **Finished · 24h:** issues moved to done in the last 24 hours, collapsed to
  a count, expandable to title, who and when. A fixed window, not "since your
  last visit": it needs no new read mark and reads the same on every device.

No sums across servers; in Aggregate the dashboard body is the focused
project's server's, like the board body.

## 5. Notes for you

The explicit messages agents addressed to the person (`tmm send "@human …"`;
not asks, not the turn-final replies of a conversation he is in), newest
first, one line each (sender, time, first line), the unread ones marked by the
room's existing read mark, the last ten with "all in chat". A tap opens the
chat at that message (the notification centre's jump). No new state: it is a
filter of the room. This is where "merged and deployed", "the APK is at …"
and "I made this mistake" live, below what needs him, without ringing louder
than they should.

## 6. The project page

**What it is.** A directory in the workspace, `<ws>/.tmm/dashboard/`, whose
`index.html` the project's agents write with their own file tools, like any
file. `<ws>/.tmm/` is already one of the two stores (tenet 7) and ignores
itself in git. `tmm dashboard path` prints it. No upload protocol, no build
step, no server-side templating: the app shows what is on disk and re-reads
it when it changes (with the dashboard's poll, and on return to the view).

**How it is shown.** Exactly as the Files page previews an HTML file today
(board #433), mounted in the dashboard:

- an **inert document**: a sandboxed frame with **no scripts**, the app's own
  content policy on top, no network except the signed, read-only door to the
  project's own files (styles, images, fonts, audio and video; never html, js
  or json). The frame cannot run code, navigate the app, open windows, submit
  forms or reach any other origin;
- **the app's look for free**: the app injects its tokens (colours of the
  current theme, the font roles, the type steps) as a base stylesheet, so
  plain semantic HTML (headings, tables, lists, `<details>`, `<audio>`,
  inline SVG) looks native in dark and light, on a 320 px phone and a wide
  desktop. A page may add its own CSS;
- **one scroll**: the frame is as tall as its content, so the dashboard
  scrolls as one page;
- **a frame the app draws**: the section header ("Project page · updated 3m
  ago") belongs to the app. A page cannot draw over "Needs you" or imitate
  app chrome outside its own box.

**How it interacts: one verb.** The page is a projection the agents keep; a
person acts on it by talking to an agent, which then acts and rewrites the
page. The app, not the page, handles the click:

- `data-tmm-send="@name text"` on a button or link: the app shows its one
  confirm dialog with the **exact recipient and text**, and on Yes sends it as
  the person's message through the composer's path. On a `<form>`, the named
  fields are appended as `name: value` lines (the app reads them; the form
  itself never submits).
- an ordinary relative link: opens that file in the app's preview or
  download (the APK, a report, a mix), as a path in chat does. A link to
  another `.html` inside the page directory loads it in the same frame.
- a link to an issue (`#103` as `tmm:issue/103`): opens the issue.

Refused, by the app: a recipient that is not a managed agent or team of this
project, a text that begins with `/` (a slash command is typed verbatim into
a CLI), an empty text, a text over the composer's limit.

**Why no scripts in v1.** The page is written by an agent that may have read
anything on the web. The app that shows it holds the gateway token, the
encryption keys, the native bridge of the phone and the desktop app, and in
Aggregate the connections to other servers. A script in that app is a script
with all of it. The existing rule (never scripts and same-origin in one
frame) and the existing content policy (`script-src 'self'`) already forbid
it, and the static form covers what a project page is for: showing state,
playing media, linking files, and asking the person to say something.
Sorting a table or a hover on a chart is what is lost. § 10 D1 gives the
scripted variant and what it would cost.

**The loop.**

```
agent writes .tmm/dashboard/index.html ─▶ app shows it (inert)
        ▲                                        │ person taps "Approve mix 4"
        │                                        ▼
agent acts, rewrites the page ◀── pane ◀── confirm: "Send to @composer: Approve mix 4"
```

Every arrow is one of the three primitives the shell already has: a file in
the workspace, text typed into a pane, `tmm` invoked by the agent.

## 7. The agent's side (CLI parity)

```
tmm ask "question" [--option KEY=label]… [--recommend KEY] [--issue N]
                                 one question to the person; prints its id; it stays
                                 on the dashboard until answered. Do not repeat it.
tmm ask list [--all]             this project's open asks (--all: answered and closed too)
tmm ask close <id> ["why"]       withdraw it, or record an answer given elsewhere
tmm dashboard path               where the project page lives
```

There is no `tmm dashboard` text view: `tmm ask list`, `tmm board` and
`tmm agent list` already print each part, and a command no agent needs is not
added (tenet 6). `tmm dashboard path` exists because the location has one
definition and an agent working in a worktree must not guess it, and
`<ws>/.tmm/` ignores itself in git.

The answer arrives in the asker's pane as a chat line. The shipped `tmm`
teaching (the prompt block and the tmm-cli skill) gains three sentences: a
question only the person can answer goes through `tmm ask`, one question with
its options and a recommendation; never repeat an open ask; a project page is
optional and lives at `tmm dashboard path`.

## 8. Where it shows, and every mode it must hold in

| surface / mode | behaviour |
|---|---|
| Board tab, desktop | `ui/Segmented` in the page head: Dashboard · Board; remembered per device; the default is § 10 D2 |
| Board tab, phone | project list ⇄ the same two views; back peels to the list; all four sections in one column; touch has no hover, so nothing is hover-only |
| Hub drawer's embedded board | Board only (the drawer is the room's side tool; the dashboard is a page) |
| Chat feed | an ask is a bubble with its option buttons and its state; answering there or on the dashboard is the same act |
| Notification centre / bell | an ask rings at every level and is emphasised like a reply to you; the tap opens the dashboard at that ask |
| Sidebar rows (Chat and Board) | open-ask count in the accent colour, from one bulk read like `hub_board_counts` |
| Aggregate (several servers) | the sidebar's counts are each server's own; the dashboard body, the page and its file door are the focused project's server's |
| Older server | a `dashboard` capability in the login answer: without it the view switch is absent and `tmm ask` refuses before sending, like the other caps |
| Dark / light, 320 / 390 / 1280 | measured in real Chromium by natural widths, with the longest realistic names and numbers (the #102 lesson) |
| No page directory | the fourth section is absent; nothing is drawn for it |
| Project archived / removed | asks follow the room's fate, as issues follow the board's |

## 9. Phasing (each ticket verifiable alone, in this order)

1. **Asks**: the store, `tmm ask`, the answer's delivery, the chat bubble,
   the bell rule, the capability, the teaching text. Outcome: an agent asks,
   the person answers in chat, nothing is asked twice.
2. **Dashboard view**: `hub_dashboard`, the view switch, Needs you (answer in
   place), Now, Notes for you, the sidebar count.
3. **Project page, read-only**: the directory, the inert embed through the
   #433 pipeline, the token stylesheet, the content-height frame, refresh on
   change, relative links and media. Pentester verifies the frame before it
   ships.
4. **Page actions**: `data-tmm-send` with the confirm, forms, issue links.

1 and 2 answer "I miss what matters"; 3 and 4 answer "each project its own
interaction". 1–2 can ship without 3–4.

## 10. Decisions for the owner

| | question | options | recommendation |
|---|---|---|---|
| D1 | May a project page run scripts? | (a) No: static HTML/CSS/media, interaction only through `data-tmm-send` and links. (b) Yes, later: served by the gateway into a script-enabled frame with no origin, no network and a message bridge limited to the same verbs; needs a security measurement on the real Android and macOS apps first (whether the native bridge is reachable from such a frame), a new HTTP door, and a wider frame policy. | (a) for v1; (b) only as its own ticket after pentester's measurement, if static proves too little |
| D2 | What does the Board tab open on? | (a) Dashboard, with Board one tap away. (b) Board, as today, with Dashboard one tap away. | (a): the tab's first answer becomes "what needs me" |
| D3 | A message a page button sends carries your name. Confirm each one? | (a) Always, showing the exact text and recipient. (b) Only the first time per button text. (c) Never. | (a): a disguised button must not be able to say "yes" for you |
| D4 | One list of asks across all projects? | (a) v1: only the per-project count on each sidebar row. (b) Also an "All projects" dashboard listing every open ask. | (a) first; (b) if the counts prove not enough |
| D5 | The words | Dashboard / Board; sections "Needs you", "Now", "Notes for you", "Project page" (zh: 概览 / 看板；等你处理、现状、留言、项目页) | as listed |

## 11. Considered and rejected

- **An ask as a board issue assigned to the person.** Reuses everything, but
  a question is not work: it has no review column, it would bury the plan of
  record under answered questions, and it cannot be answered with one tap.
- **An inbox with a "handled" tick on every message to the person.** A
  second notification centre, and it puts "for your information" back into
  the same list as "needs you", which is the confusion this removes.
- **Priority levels on messages.** Every agent's message is important to its
  author. A level has no end state; an ask does.
- **An agent-written summary as the dashboard's top.** A summary is a claim;
  the counts, the states and the finished list are derived (tenet 8). The
  agents' words have their place: the status line, the notes, the page.
- **"Finished since your last visit".** Needs a new read mark per device or
  per person, and an answer to "when is a visit". A fixed 24 hours is the
  same on every screen.
- **A dashboard band above the board's columns.** The board page never
  scrolls and its columns share the height; a band takes it from them.
- **The page as markdown.** Safer still, but the owner asked for a web page,
  and media, layout and buttons are what make projects differ.
- **A widget kit the app renders from JSON.** That is an engine: every new
  need is a new widget in the app. A page the agents own is a file.
- **Reminders and escalation for old asks.** The dashboard holds them; the
  age is on the card. A reminder is the stream again.

## 12. What this does not change

The room stays the one record. The board's columns, rules and CLI are
untouched. Delivery is still typing into a pane. Notification levels keep
their meaning. No agent is told to stop writing to the person; it gains a
better door for the one kind of message that needs him.
