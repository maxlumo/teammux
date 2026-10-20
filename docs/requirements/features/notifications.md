# Message Notifications — requirements

Board #57. New project-chat messages can alert a reader who is not currently looking at that conversation.

## Channels

- Play the bundled placeholder cue (`/assets/notify.wav`). The owner will choose the final sound later; replacing the asset must not change notification logic.
- When the Web Notification API exists and permission is granted, also post a system notification — through the service worker where one is registered (Android Chrome refuses the page constructor), else the page constructor. One tray card per project (`tag`), replaced on each burst.
- Inside the Tauri app (Android, macOS) the same path reaches the OS notification tray through `tauri-plugin-notification`'s `window.Notification` shim; Android 13+ asks its runtime permission when the setting is turned on.
- The notification switch has two controls on one setting: the Settings toggle (Settings → Notifications, its own category) and the notification centre's Mute (board #423). Permission is requested, and the sound unlocked, only by an explicit click that turns the switch ON, from either control, never as a side effect of opening the bell, receiving or sending a message, or loading. A denied permission leaves the sound on its own. If the setting cannot be saved, neither control claims it changed, and each says so. While muted, every bell shows a crossed bell and says muted. The category also offers a Test row that plays the cue and posts one notification on demand. The toggle persists enabled/muted state and its caption says when only the sound can play (site blocked, or no Notification API as in the Android webview). The Hub header carries no notification switch (board #72).
- Unsupported APIs, denied permission, and blocked audio all fail soft.

This is a **running-client** notification path for browser/PWA/webview. It does not claim remote push after the page or app has been closed.

## Level

Settings → Notifications carries a level, persisted to `tmux_notify_level`, three nested rungs over the bell (board #334; the stored values did not change):

- **Finished** (`done`, default since #333): an agent's board move to review/done, plus `[tmm done]` notes.
- **To me** (`replies`): Finished plus every reply addressed to you.
- **To me + progress** (`all`): To me plus `[tmm status …]` notes addressed to you.

Only a finished task, a reply / status note addressed to you, or the app's report that a typed message was never confirmed (board #437; it rings at every level), can ever ring or reach the bell; agents talking to each other count as room unread only. App narration and the human's own messages are never news at any level. Every legal stored value is kept when the default changes (a stored `replies` stays `replies`); only an absent or unknown value reads as the default.

## What counts as news

A message may alert only when the reader is away from that conversation: the document is hidden, the window is unfocused, another app page is visible, or the message belongs to a project other than the selected one (its notification names that project).

- The check runs on the live `team_message` push, which arrives for every room on every page; the visible-only `hub_log` poll is the fallback. A message seen by both alerts once.

- Initial room loads, history pages, cache restores, and inclusive-poll replays never alert.
- Every observed message is remembered by server id, falling back to its `(from, ts, body)` identity. The same message alerts at most once.
- Human-authored messages, nameless rows, `[tmm]` lifecycle narration, and ambient `[tmm status working]` updates do not alert below `all`.
- Agent replies, historical `[tmm done]` summaries, and an agent's board move to review or done ("who finished what": `#N → review · title`) are news. Moves to doing, spawns, and the human's own moves are not.
- Batches produce at most one cue and one system notification; the cue has a short cooldown.
- Messages observed while looking or muted are still remembered, so leaving the page or unmuting cannot backfill old alerts.

## Safety and races

A failed audio play rolls back only its own cooldown claim. A delayed rejection from an older play must never reopen the cooldown claimed by a newer successful cue. The seen-key set is bounded so a long-running client cannot grow notification memory without limit.

## Notification centre (board #322)

- Every bell message (a finished task, or a reply / status note addressed to you; all levels, muted or not) is recorded in an in-app list, one entry per message (a turn that finishes a task and answers you leaves two): project, sender, a one-line excerpt, time; newest first; the last 50; per server.
- Desktop: a bell in the rail above the server switcher with an unviewed count. Phone: a dot on the Hub tab and a bell in the Hub header.
- Default view All; replies addressed to you are emphasised, with a To me filter. Clear empties the list only.
- Tapping an entry opens its project at that exact message (loading the page around it when needed, revealing it through a filter or the chat-only level without changing the setting) and marks it seen; if the message cannot be reached, the entry stays with the reason.
- Every project row shows its unread count in the accent colour; red stays only for a real agent failure.

## Read state (board #334)

- One read mark per room, kept by the server for the human: every client of that server shows the same unread after its next read (the 20 s sidebar read, a push, or a reconnect). A fresh client inherits it.
- Upgrading marked every existing room read to its newest message; a room created later counts every message until it is read.
- A read is retried until the server confirms it, for as long as the Hub stays open; a read still unconfirmed when the app closes is lost, and the server's mark is used on the next open.
- Agents reading the room (`tmm log`) never mark it read.
