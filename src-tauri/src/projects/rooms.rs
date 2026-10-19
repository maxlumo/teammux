//! The project hub's chat rooms (board #107).
//!
//! One room per project (`proj:<session>`, or the room recorded on the
//! project row — see `server/hub_rpc::project_room`). Messages live in
//! state.db (`hub_msgs`), one of the two truth stores (tenet 7); the agora
//! bus that used to hold them was deleted whole with the desktop Team system
//! (owner 2026-09-09, board #100). Rooms are implicit: a room exists exactly
//! when it has messages — there is no register/open step, because a registry
//! separate from the data it indexes is a second source of truth.
//!
//! Message JSON keeps the exact wire shape the bus produced —
//! `{seq, id, ts, room, from, to, kind, body}` — so clients, `tmm log`
//! cursors and the team-context route reconstruction are untouched.
//!
//! The push half is one process-wide broadcast channel: every append is
//! re-serialized and fanned out to each connection's push loop (the
//! `team_message` WS frame, name kept for client compatibility). The
//! obligation graph the bus kept (`requires_reply`) is gone with it — the
//! hub never read it; reply behaviour is owned by hooks and the single
//! reply edge (tenet: derive, never declare).

use std::sync::OnceLock;
use tokio::sync::broadcast;

use super::store::HubMsg;
use super::{now, with_store};

/// Merged message fan-out for the WS push path (all rooms). 1024 deep like
/// the bus channel it replaces; a lagged receiver re-syncs via hub_log.
fn channel() -> &'static broadcast::Sender<String> {
    static TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    TX.get_or_init(|| broadcast::channel(1024).0)
}

/// A receiver of newly-appended messages across ALL rooms, each pre-serialized
/// to JSON (the `room` field is inside). The client filters to the room in view.
pub fn subscribe() -> broadcast::Receiver<String> {
    channel().subscribe()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The stored row in the wire shape every consumer already speaks.
fn message_json(m: &HubMsg) -> serde_json::Value {
    let to: serde_json::Value =
        serde_json::from_str(&m.to_json).unwrap_or_else(|_| serde_json::json!([]));
    serde_json::json!({
        "seq": m.seq,
        "id": m.id,
        "ts": m.ts,
        "room": m.room,
        "from": m.sender,
        "to": to,
        "kind": m.kind,
        "body": m.body,
    })
}

/// Post with server-known recipients stored in the message envelope — the
/// durable route `team_context` reconstruction reads. Returns the stored
/// message JSON and broadcasts it to every connected client.
pub fn post_routed(
    room: &str,
    from: &str,
    body: &str,
    to: &[String],
) -> Result<serde_json::Value, String> {
    post_routed_as(room, &uuid::Uuid::new_v4().to_string(), from, body, to)
}

/// `post_routed` under an id the caller chose — for a record whose id must
/// exist before the message does (a command's receipt rows, board #264).
pub fn post_routed_as(
    room: &str,
    id: &str,
    from: &str,
    body: &str,
    to: &[String],
) -> Result<serde_json::Value, String> {
    let to_json = serde_json::to_string(to).unwrap_or_else(|_| "[]".into());
    let stored = with_store(|s| s.hub_append(room, id, now_ms(), from, &to_json, "msg", body))?;
    let json = message_json(&stored);
    let _ = channel().send(json.to_string());
    Ok(json)
}

/// Post without recipients (lifecycle `[tmm] …` lines, status rows).
pub fn post(room: &str, from: &str, body: &str) -> Result<serde_json::Value, String> {
    post_routed(room, from, body, &[])
}

/// Push rows a store transaction already committed (a line recorded once by
/// its id, board #422 round 4) through the same channel `post` uses.
pub fn push_stored(msgs: &[HubMsg]) {
    for m in msgs {
        let _ = channel().send(message_json(m).to_string());
    }
}

/// One PAGE of `room`'s messages, oldest first, walking backwards:
/// `{ messages, has_more, head_seq }`. `before_seq` is exclusive; `None` is
/// the newest page.
pub fn history_page(room: &str, before_seq: Option<i64>, limit: i64) -> serde_json::Value {
    let (msgs, has_more, head_seq) =
        with_store(|s| s.hub_page(room, before_seq, limit)).unwrap_or((Vec::new(), false, 0));
    serde_json::json!({
        "messages": msgs.iter().map(message_json).collect::<Vec<_>>(),
        "has_more": has_more,
        "head_seq": head_seq,
    })
}

/// The jump window's page (board #322): `room`'s messages around `seq`, in
/// `history_page`'s shape plus `newer_more` ("rows newer than this page
/// exist", so the window is not the tail).
pub fn around_page(room: &str, seq: i64, limit: i64) -> serde_json::Value {
    let (msgs, has_more, newer_more) = with_store(|s| s.hub_around(room, seq, limit)).unwrap_or((Vec::new(), false, false));
    serde_json::json!({
        "messages": msgs.iter().map(message_json).collect::<Vec<_>>(),
        "has_more": has_more,
        "newer_more": newer_more,
    })
}

/// ONE message by its id, however old — exact lookup, never a page scan.
pub fn message_by_id(room: &str, id: &str) -> Option<serde_json::Value> {
    with_store(|s| s.hub_message_by_id(room, id))
        .ok()
        .flatten()
        .map(|m| message_json(&m))
}

/// ONE message of `room` by its id or, when `re` is all digits, its seq
/// (board #290). A message of another room is not found.
pub fn message_by_ref(room: &str, re: &str) -> Option<serde_json::Value> {
    let found = match re.parse::<i64>() {
        Ok(seq) => with_store(|s| s.hub_message_by_seq(room, seq)),
        Err(_) => with_store(|s| s.hub_message_by_id(room, re)),
    };
    found.ok().flatten().map(|m| message_json(&m))
}

/// The newest `limit` messages matching ANY of `terms`, oldest first:
/// `{ "messages": [...] }`. `room = None` searches EVERY room; each hit's
/// `room` field says where it was said.
pub fn search_messages(room: Option<&str>, terms: &[String], limit: i64) -> serde_json::Value {
    let msgs = with_store(|s| s.hub_search(room, terms, limit)).unwrap_or_default();
    serde_json::json!({ "messages": msgs.iter().map(message_json).collect::<Vec<_>>() })
}

/// Newest message timestamp (ms) per room: `{ "<room>": ts }` — orders the
/// project list, so it covers every room that ever spoke.
pub fn room_latest() -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = with_store(|s| s.hub_room_latest())
        .unwrap_or_default()
        .into_iter()
        .map(|(room, ts)| (room, serde_json::json!(ts)))
        .collect();
    serde_json::Value::Object(map)
}

/// What kind of news a message is — ONE rule for the room unread summary
/// (`unread`), the client's unread dot and its notification centre (board
/// #322; TS twin `newsKind` in hub/notifications.ts runs this file's case
/// table, so the two cannot drift). Your own words are never news; app
/// narration (`[tmm] `, and the retired `⚡ `/`✔ ` markers) is not news
/// EXCEPT a board move to review/done; that and a `done` status note
/// (`[tmm done]`) are "a task finished", which rings at every level; any
/// other status note is progress (`all` only); everything else an agent
/// says is a reply (notifications.md's levels, unchanged).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewsKind {
    None,
    Reply,
    Status,
    Finished,
}

impl NewsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NewsKind::None => "none",
            NewsKind::Reply => "reply",
            NewsKind::Status => "status",
            NewsKind::Finished => "finished",
        }
    }
}

/// The lifecycle markers (TS `systemLine`).
const SYS_MARKERS: [&str; 3] = ["[tmm] ", "\u{26a1} ", "\u{2714} "];

pub fn news_kind(sender: &str, body: &str) -> NewsKind {
    if sender.is_empty() || sender == "human" {
        return NewsKind::None;
    }
    if let Some(line) = SYS_MARKERS.iter().find_map(|m| body.strip_prefix(m)) {
        return if board_finished(line.trim()) { NewsKind::Finished } else { NewsKind::None };
    }
    match status_note(body) {
        Some("done") => NewsKind::Finished,
        Some(_) => NewsKind::Status,
        None => NewsKind::Reply,
    }
}

/// `board #N <from> → review|done[ — title]` (TS `boardLine` + `taskFinished`).
fn board_finished(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("board #") else { return false };
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let mut words = rest[digits..].strip_prefix(' ').unwrap_or("\u{0}").splitn(3, ' ');
    let (Some(from), Some("\u{2192}"), Some(tail)) = (words.next(), words.next(), words.next()) else { return false };
    if from.is_empty() || !from.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    let to: String = tail.chars().take_while(|c| c.is_ascii_lowercase()).collect();
    let after = &tail[to.len()..];
    (after.is_empty() || after.starts_with(" \u{2014}")) && (to == "review" || to == "done")
}

/// `[tmm status <word>] text` / `[tmm done] text` with non-empty text → the
/// state word (TS `statusNote`).
fn status_note(body: &str) -> Option<&str> {
    let (state, rest) = if let Some(r) = body.strip_prefix("[tmm status ") {
        let n = r.chars().take_while(|c| c.is_ascii_lowercase()).count();
        if n == 0 {
            return None;
        }
        (&r[..n], r[n..].strip_prefix(']')?)
    } else {
        ("done", body.strip_prefix("[tmm done]")?)
    };
    (!rest.trim().is_empty()).then_some(state)
}

/// The unread summary of one room above the reader's watermark (board #322):
/// `{count, first_seq, last_seq}` over the messages `news_kind` calls news,
/// archived ones excluded; `None` when there are none. Every row above the
/// watermark is read (an indexed range on `(room, seq)`), so a run of own or
/// narration lines can never hide an older reply.
pub fn unread(room: &str, after_seq: Option<i64>, after_ts: i64) -> Option<serde_json::Value> {
    let rows = with_store(|s| s.hub_above(room, after_seq, after_ts)).unwrap_or_default();
    let hidden = crate::projects::archived_ids(room);
    let mut count = 0;
    let (mut first, mut last) = (0, 0);
    for (seq, sender, body) in &rows {
        if news_kind(sender, body) == NewsKind::None {
            continue;
        }
        if !hidden.is_empty() && is_hidden(room, *seq, &hidden) {
            continue;
        }
        if count == 0 {
            first = *seq;
        }
        last = *seq;
        count += 1;
    }
    (count > 0).then(|| serde_json::json!({ "count": count, "first_seq": first, "last_seq": last }))
}

/// The human's read mark of `room` on this server (board #334), `(seq, ts)`.
/// One reader per server: every client of the human shares it.
pub fn read_mark(room: &str) -> Option<(i64, i64)> {
    with_store(|s| s.hub_read_mark(room)).ok().flatten()
}

/// Move `room`'s read mark forward (resolved and clamped by the server,
/// never backwards) and return where it now is. Only the human's clients
/// call this (`hub_read`); an agent reading the room with `tmm log` is not
/// the human reading it.
pub fn mark_read(room: &str, seq: Option<i64>, ts: i64) -> Result<Option<(i64, i64)>, String> {
    with_store(|s| s.hub_mark_read(room, seq, ts))
}

/// `(seq, ts)` of `room`'s newest message (the clamp for a client's mark).
pub fn room_head(room: &str) -> Option<(i64, i64)> {
    with_store(|s| s.hub_room_head(room)).ok().flatten()
}

/// The seq of `room`'s newest message at or before `ts` (a legacy ts mark
/// resolved to the room's own order, board #334).
pub fn seq_at_or_before(room: &str, ts: i64) -> Option<i64> {
    with_store(|s| s.hub_seq_at_or_before(room, ts)).ok().flatten()
}

fn is_hidden(room: &str, seq: i64, hidden: &[String]) -> bool {
    with_store(|s| s.hub_message_by_seq(room, seq))
        .ok()
        .flatten()
        .is_some_and(|m| hidden.iter().any(|h| *h == m.id))
}

/// Forget messages by id, for good — the irreversible half of deleting
/// (`msg_archive` is the reversible half).
pub fn delete_messages(room: &str, ids: &[String]) -> Result<usize, String> {
    with_store(|s| s.hub_delete(room, ids))
}

/// Test seeding with a controlled clock (the paging and `since_ts` contracts
/// in `server/hub_rpc` need deterministic timestamps). Returns the stored
/// message JSON; does NOT broadcast.
#[cfg(test)]
pub(crate) fn seed_msg(
    room: &str,
    id: &str,
    ts: i64,
    from: &str,
    to: &[String],
    body: &str,
) -> serde_json::Value {
    let to_json = serde_json::to_string(to).unwrap_or_else(|_| "[]".into());
    let stored =
        with_store(|s| s.hub_append(room, id, ts, from, &to_json, "msg", body)).expect("seed");
    message_json(&stored)
}

// ---- one-off legacy import (board #107) -----------------------------------

const IMPORT_FLAG: &str = "hub_import_done";

/// Where the retired Team bus kept its database. The `TEAM_DB` env var and the
/// `team_db` config key (with its `crew_db`/`agora_db` pre-rebrand aliases) are
/// read RAW here rather than through `config::Config`, because the Team system
/// and its config surface are deleted — this importer is the one consumer left,
/// and it must keep finding a legacy custom path after that deletion.
fn legacy_db_path() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("TEAM_DB").filter(|p| !p.is_empty()) {
        return std::path::PathBuf::from(p);
    }
    let config = crate::config::config_dir().join("config.toml");
    if let Ok(text) = std::fs::read_to_string(&config) {
        if let Ok(value) = text.parse::<toml::Value>() {
            for key in ["team_db", "crew_db", "agora_db"] {
                if let Some(path) = value.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    return std::path::PathBuf::from(path);
                }
            }
        }
    }
    crate::config::config_dir().join("team.db")
}

/// Import every `proj:*` room's transcript out of the legacy team.db, exactly
/// once (a `meta` flag remembers). The file itself is left on disk, unread
/// from then on — the room is the only record, and losing chat history to a
/// storage migration is not acceptable. Called at server startup; every miss
/// (no file, no flag write) is fail-soft.
pub fn import_legacy() {
    let already = with_store(|s| s.meta_get(IMPORT_FLAG)).ok().flatten().is_some();
    if already {
        return;
    }
    let legacy = legacy_db_path();
    if legacy.is_file() {
        match with_store(|s| s.hub_import_from(&legacy)) {
            Ok(n) => println!("🜂 hub: imported {n} legacy messages from {}", legacy.display()),
            Err(e) => {
                // Leave the flag unset so the next start retries: an import
                // that failed halfway is re-run, and INSERT OR IGNORE keeps
                // the retry additive.
                eprintln!("⚠️  hub: legacy import failed: {e}");
                return;
            }
        }
    }
    let _ = with_store(|s| s.meta_set(IMPORT_FLAG, "1"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #322: the ONE news case table. `hub.test.ts` reads these rows
    /// out of this file and runs `newsKind` over them, so the unread summary
    /// and the client's dot/centre cannot disagree: keep each row on one
    /// line, `("<sender>", "<body>", "<kind>"),`.
    #[test]
    fn news_kind_is_one_rule() {
        let cases: &[(&str, &str, &str)] = &[
            ("human", "@lead go", "none"),
            ("", "orphan", "none"),
            ("lead", "here is the plan", "reply"),
            ("lead", "[tmm] spawned dev", "none"),
            ("lead", "[tmm] board #12 todo → doing — start", "none"),
            ("lead", "[tmm] board #12 doing → review — ship it", "finished"),
            ("lead", "[tmm] board #12 review → done", "finished"),
            ("lead", "[tmm] board #x doing → review", "none"),
            ("lead", "\u{26a1} board #3 doing → done — old marker", "finished"),
            ("lead", "\u{2714} restarted dev", "none"),
            ("lead", "[tmm done] shipped #12", "finished"),
            ("lead", "[tmm status done] wrapped up", "finished"),
            ("lead", "[tmm status running] compiling", "status"),
            ("lead", "[tmm status running]   ", "reply"),
            ("lead", "[tmm done]", "reply"),
            ("lead", "[tmm]no space", "reply"),
        ];
        for (sender, body, want) in cases {
            assert_eq!(news_kind(sender, body).as_str(), *want, "{sender}: {body:?}");
        }
    }

    #[test]
    fn unread_counts_news_above_the_watermark_however_much_noise_is_newer() {
        crate::projects::tests::use_test_store();
        let room = format!("proj:unread-{}", uuid::Uuid::new_v4());
        let read = seed_msg(&room, &uuid::Uuid::new_v4().to_string(), 1_000, "lead", &[], "read already");
        let mark = read["seq"].as_i64().unwrap();
        assert!(unread(&room, Some(mark), 0).is_none(), "nothing above the watermark");
        let reply = seed_msg(&room, &uuid::Uuid::new_v4().to_string(), 2_000, "lead", &[], "older reply");
        // 30 own and narration rows land after it: they must not hide it.
        for i in 0..30 {
            let (from, body) = if i % 2 == 0 { ("human", "me again") } else { ("lead", "[tmm] board #1 todo → doing") };
            seed_msg(&room, &uuid::Uuid::new_v4().to_string(), 3_000 + i, from, &[], body);
        }
        let sum = unread(&room, Some(mark), 0).expect("the reply is unread");
        assert_eq!(sum["count"], 1);
        assert_eq!(sum["first_seq"], reply["seq"]);
        assert_eq!(sum["last_seq"], reply["seq"]);
        // Two in one millisecond: both count, ordered by seq, not ts.
        let a = seed_msg(&room, &uuid::Uuid::new_v4().to_string(), 9_000, "dev", &[], "[tmm done] a");
        let b = seed_msg(&room, &uuid::Uuid::new_v4().to_string(), 9_000, "qa", &[], "b");
        let sum = unread(&room, Some(mark), 0).unwrap();
        assert_eq!(sum["count"], 3);
        assert_eq!(sum["last_seq"], b["seq"]);
        // Read to the tail: the watermark moves to the newest seq while the
        // room's newest ts does not change, and the summary is empty.
        assert!(unread(&room, b["seq"].as_i64(), 0).is_none());
        assert!(unread(&room, a["seq"].as_i64(), 0).unwrap()["count"] == 1, "same-ms neighbour above a");
        // A legacy ts watermark reads by ts.
        assert_eq!(unread(&room, None, 8_999).unwrap()["count"], 2);
        assert!(unread(&room, None, 9_000).is_none());
    }

    #[test]
    fn a_posted_message_keeps_the_bus_wire_shape_and_pages_backwards() {
        crate::projects::tests::use_test_store();
        let room = format!("proj:rooms-{}", uuid::Uuid::new_v4());
        let mut rx = subscribe();
        let m1 = post_routed(&room, "human", "@lead start", &["lead".into()]).unwrap();
        // The wire shape is the bus's: from/to/kind/seq/id/ts/room/body.
        assert_eq!(m1["from"], "human");
        assert_eq!(m1["to"], serde_json::json!(["lead"]));
        assert_eq!(m1["kind"], "msg");
        assert_eq!(m1["room"], room);
        assert!(m1["seq"].as_i64().unwrap() > 0);
        assert!(!m1["id"].as_str().unwrap().is_empty());
        // The append was pushed to subscribers, pre-serialized.
        let pushed: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("a push frame")).unwrap();
        assert_eq!(pushed, m1);

        let m2 = post(&room, "lead", "done").unwrap();
        assert_eq!(m2["to"], serde_json::json!([]));

        // Newest page, oldest first; head_seq names the room's newest.
        let page = history_page(&room, None, 100);
        let msgs = page["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["body"], "@lead start");
        assert_eq!(page["has_more"], false);
        assert_eq!(page["head_seq"], m2["seq"]);

        // Walking backwards: the page behind m2 is m1, and the walk ends there.
        let back = history_page(&room, m2["seq"].as_i64(), 1);
        assert_eq!(back["messages"].as_array().unwrap().len(), 1);
        assert_eq!(back["messages"][0]["id"], m1["id"]);
        assert_eq!(back["has_more"], false);

        // Exact lookup, search, room ordering, deletion.
        assert_eq!(message_by_id(&room, m1["id"].as_str().unwrap()).unwrap(), m1);
        let hits = search_messages(Some(&room), &["START".into()], 10);
        assert_eq!(hits["messages"].as_array().unwrap().len(), 1, "case-insensitive body match");
        let latest = room_latest();
        assert_eq!(latest[&room], m2["ts"], "the room's newest ts orders the sidebar");
        assert_eq!(delete_messages(&room, &[m1["id"].as_str().unwrap().to_string()]).unwrap(), 1);
        assert_eq!(history_page(&room, None, 100)["messages"].as_array().unwrap().len(), 1);
    }

    /// The legacy rows carry seqs far above any the process-shared test
    /// store holds: an earlier test that posts to a room (board #422's
    /// restore give-up line) takes seq 1..n, and `INSERT OR IGNORE` would
    /// skip a legacy row of the same seq.
    #[test]
    fn legacy_import_copies_proj_rooms_once_and_skips_team_rooms() {
        crate::projects::tests::use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("team.db");
        {
            let conn = rusqlite::Connection::open(&legacy).unwrap();
            conn.execute_batch(
                "CREATE TABLE messages (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                   ts INTEGER NOT NULL, room TEXT NOT NULL, sender TEXT NOT NULL,
                   to_json TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL
                 );
                 INSERT INTO messages (seq, id, ts, room, sender, to_json, kind, body) VALUES
                   (900000001, 'a', 100, 'proj:blog', 'human', '[\"lead\"]', 'msg', 'old task'),
                   (900000002, 'b', 200, 'content-team', 'manager', '[]', 'msg', 'team room stays'),
                   (900000003, 'c', 300, 'proj:blog', 'lead', '[]', 'msg', 'old reply');",
            )
            .unwrap();
        }
        let n = crate::projects::with_store(|s| s.hub_import_from(&legacy)).unwrap();
        assert_eq!(n, 2, "proj:* rooms only");
        let page = history_page("proj:blog", None, 10);
        let msgs = page["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        // Seq/id/ts survive the copy — cursors held by clients stay valid.
        assert_eq!(msgs[0]["seq"], 900000001);
        assert_eq!(msgs[1]["seq"], 900000003);
        assert_eq!(msgs[0]["id"], "a");
        // The team room did not come along.
        assert!(history_page("content-team", None, 10)["messages"].as_array().unwrap().is_empty());
        // A retry is additive-idempotent (INSERT OR IGNORE), never a duplicate.
        let again = crate::projects::with_store(|s| s.hub_import_from(&legacy)).unwrap();
        assert_eq!(again, 0);
        // New appends continue ABOVE the imported log positions.
        let fresh = post("proj:blog", "human", "new work").unwrap();
        assert!(fresh["seq"].as_i64().unwrap() > 900000003);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---- archived messages (moved from projects/mod.rs, board #152) ----------
//
// The archive is OUR state (state.db): hiding a message is this app's idea.
// These are the four verbs the hub RPCs need, each fail-soft in the direction
// that keeps the UI honest — a read that fails hides nothing, a write that
// fails is reported.

/// Ids hidden in a room. A failure here must not blank the conversation, so it
/// degrades to "nothing is hidden".
pub fn archived_ids(room: &str) -> Vec<String> {
    with_store(|s| s.archived_ids(room)).unwrap_or_default()
}

/// The archive itself, newest first, each row carrying its own copy of the
/// message.
pub fn archived_msgs(room: &str) -> Vec<(String, u64, String, String, u64)> {
    with_store(|s| s.archived_msgs(room)).unwrap_or_default()
}

/// Hide one message.
pub fn archive_msg(room: &str, msg_id: &str, ts: u64, sender: &str, body: &str) -> Result<(), String> {
    with_store(|s| s.archive_msg(room, msg_id, ts, sender, body, now()))
}

/// Take messages out of the archive — a restore, or the bookkeeping half of a
/// purge once the messages themselves are gone.
pub fn unarchive_msgs(room: &str, ids: &[String]) -> Result<usize, String> {
    with_store(|s| s.unarchive_msgs(room, ids))
}
