//! Hub rooms: the message log, the archive, the meta table and the one-time legacy import.
//!
//! One family of the store (board #147): an `impl Store` block over the same
//! connection, the same migration ladder, the same tests — only the file moved.

use super::*;

/// One stored hub message (board #107) — the row shape of `hub_msgs`, column
/// names mirroring the agora `messages` table it replaced so the legacy
/// import is a straight copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubMsg {
    pub seq: i64,
    pub id: String,
    pub ts: i64,
    pub room: String,
    pub sender: String,
    /// JSON array of recipient names (`[]` = broadcast).
    pub to_json: String,
    pub kind: String,
    pub body: String,
}

/// One system line whose message id is its identity (board #422 round 4):
/// the report of one event, written at most once, in the caller's
/// transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnceLine {
    pub room: String,
    pub id: String,
    pub sender: String,
    pub body: String,
}

/// In the caller's transaction: append `line` unless a message with its id
/// exists (`hub_msgs.id` is UNIQUE). `Some(row)` = inserted now, for the
/// caller to push AFTER its commit; `None` = already recorded.
pub(super) fn hub_append_once_in(conn: &rusqlite::Connection, line: &OnceLine, ts: i64) -> Result<Option<HubMsg>, String> {
    let n = conn
        .execute(
            "INSERT INTO hub_msgs (id, ts, room, sender, to_json, kind, body)
             VALUES (?1, ?2, ?3, ?4, '[]', 'msg', ?5) ON CONFLICT(id) DO NOTHING",
            rusqlite::params![line.id, ts, line.room, line.sender, line.body],
        )
        .map_err(|e| format!("append hub message: {e}"))?;
    Ok((n == 1).then(|| HubMsg {
        seq: conn.last_insert_rowid(),
        id: line.id.clone(),
        ts,
        room: line.room.clone(),
        sender: line.sender.clone(),
        to_json: "[]".into(),
        kind: "msg".into(),
        body: line.body.clone(),
    }))
}

/// Shared row mapper for every `SELECT seq, id, ts, room, sender, to_json,
/// kind, body FROM …` read (hub_msgs and the legacy import alike).
fn hub_msg_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HubMsg> {
    Ok(HubMsg {
        seq: r.get(0)?,
        id: r.get(1)?,
        ts: r.get(2)?,
        room: r.get(3)?,
        sender: r.get(4)?,
        to_json: r.get(5)?,
        kind: r.get(6)?,
        body: r.get(7)?,
    })
}

impl Store {
    /// Hide a message: it stays in the room's own store, we stop showing it.
    /// Idempotent, so archiving twice is not an error the UI has to handle.
    pub fn archive_msg(
        &self,
        room: &str,
        msg_id: &str,
        ts: u64,
        sender: &str,
        body: &str,
        now: u64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO msg_archive (room, msg_id, ts, sender, body, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(room, msg_id) DO UPDATE SET archived_at = ?6",
                rusqlite::params![room, msg_id, ts as i64, sender, body, now as i64],
            )
            .map(|_| ())
            .map_err(|e| format!("archive message: {e}"))
    }

    /// The ids hidden in a room — what `hub_log` filters the history against.
    pub fn archived_ids(&self, room: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT msg_id FROM msg_archive WHERE room = ?1")
            .map_err(|e| format!("prepare archived ids: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![room], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query archived ids: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// The archive itself, newest first — a list you review before forgetting.
    pub fn archived_msgs(
        &self,
        room: &str,
    ) -> Result<Vec<(String, u64, String, String, u64)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT msg_id, ts, sender, body, archived_at FROM msg_archive
                 WHERE room = ?1 ORDER BY archived_at DESC, ts DESC",
            )
            .map_err(|e| format!("prepare archive: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![room], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)? as u64,
                ))
            })
            .map_err(|e| format!("query archive: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Take messages back out of the archive (restore), or forget the archive rows
    /// after the messages themselves have been deleted (purge). Returns how many
    /// rows went away.
    pub fn unarchive_msgs(&self, room: &str, ids: &[String]) -> Result<usize, String> {
        let mut n = 0;
        for id in ids {
            n += self
                .conn
                .execute(
                    "DELETE FROM msg_archive WHERE room = ?1 AND msg_id = ?2",
                    rusqlite::params![room, id],
                )
                .map_err(|e| format!("unarchive message: {e}"))?;
        }
        Ok(n)
    }

    /// Append one message and hand the stored row back (seq assigned here).
    pub fn hub_append(
        &self,
        room: &str,
        id: &str,
        ts: i64,
        sender: &str,
        to_json: &str,
        kind: &str,
        body: &str,
    ) -> Result<HubMsg, String> {
        self.conn
            .execute(
                "INSERT INTO hub_msgs (id, ts, room, sender, to_json, kind, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, ts, room, sender, to_json, kind, body],
            )
            .map_err(|e| format!("append hub message: {e}"))?;
        let seq = self.conn.last_insert_rowid();
        Ok(HubMsg {
            seq,
            id: id.to_string(),
            ts,
            room: room.to_string(),
            sender: sender.to_string(),
            to_json: to_json.to_string(),
            kind: kind.to_string(),
            body: body.to_string(),
        })
    }

    /// One page of `room`'s messages, oldest first, walking backwards.
    /// `before_seq` is exclusive; `None` is the newest page. Returns
    /// `(messages, has_more, head_seq)` — `head_seq` is the room's newest seq.
    pub fn hub_page(
        &self,
        room: &str,
        before_seq: Option<i64>,
        limit: i64,
    ) -> Result<(Vec<HubMsg>, bool, i64), String> {
        let limit = limit.clamp(1, 1000);
        let head_seq: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM hub_msgs WHERE room = ?1",
                rusqlite::params![room],
                |r| r.get(0),
            )
            .map_err(|e| format!("hub head seq: {e}"))?;
        // Fetch limit+1 newest-first to learn has_more, then flip to oldest-first.
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
                 WHERE room = ?1 AND (?2 IS NULL OR seq < ?2)
                 ORDER BY seq DESC LIMIT ?3",
            )
            .map_err(|e| format!("prepare hub page: {e}"))?;
        let mut rows: Vec<HubMsg> = stmt
            .query_map(rusqlite::params![room, before_seq, limit + 1], hub_msg_row)
            .map_err(|e| format!("query hub page: {e}"))?
            .filter_map(Result::ok)
            .collect();
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        rows.reverse();
        Ok((rows, has_more, head_seq))
    }

    /// `(seq, sender, body head)` of every row of `room` strictly above a read
    /// watermark — `seq` when the client has one, else its legacy `ts` — oldest
    /// first (board #322, the unread summary). Only the first 256 characters
    /// of a body come back: the news rule reads a marker prefix, never prose.
    pub fn hub_above(&self, room: &str, after_seq: Option<i64>, after_ts: i64) -> Result<Vec<(i64, String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT seq, sender, substr(body, 1, 256) FROM hub_msgs
                 WHERE room = ?1 AND (CASE WHEN ?2 IS NULL THEN ts > ?3 ELSE seq > ?2 END)
                 ORDER BY seq",
            )
            .map_err(|e| format!("prepare hub above: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![room, after_seq, after_ts], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| format!("query hub above: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// The v31 shape (also a heal floor, board #334): the human's read mark
    /// per room. One row per room because a server has one human reader
    /// today; every client of that human reads and writes the same row.
    pub(super) fn ensure_hub_read(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS hub_read (
                   room TEXT PRIMARY KEY,
                   seq  INTEGER NOT NULL,
                   ts   INTEGER NOT NULL
                 );",
            )
            .map_err(|e| format!("ensure hub_read: {e}"))
    }

    /// The stored read mark of `room`, `(seq, ts)`.
    pub fn hub_read_mark(&self, room: &str) -> Result<Option<(i64, i64)>, String> {
        self.conn
            .prepare_cached("SELECT seq, ts FROM hub_read WHERE room = ?1")
            .and_then(|mut st| st.query_row(rusqlite::params![room], |r| Ok((r.get(0)?, r.get(1)?))).optional())
            .map_err(|e| format!("read hub_read: {e}"))
    }

    /// v31 only (board #334): every room that already has messages starts
    /// READ to its head — the upgrade counts as "read up to now", because a
    /// per-client mark was the only read state before and a fresh client
    /// lost it. Runs in the migration transaction, never on heal: a room
    /// born later starts without a mark and every message in it counts.
    pub(super) fn seed_hub_read(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "INSERT OR IGNORE INTO hub_read (room, seq, ts)
                   SELECT room, MAX(seq), MAX(ts) FROM hub_msgs GROUP BY room;",
            )
            .map_err(|e| format!("seed hub_read: {e}"))
    }

    /// `(seq, ts)` of `room`'s newest message, `None` for an empty room.
    pub fn hub_room_head(&self, room: &str) -> Result<Option<(i64, i64)>, String> {
        self.conn
            .prepare_cached("SELECT seq, ts FROM hub_msgs WHERE room = ?1 ORDER BY seq DESC LIMIT 1")
            .and_then(|mut st| st.query_row(rusqlite::params![room], |r| Ok((r.get(0)?, r.get(1)?))).optional())
            .map_err(|e| format!("read room head: {e}"))
    }

    /// The seq of `room`'s newest message at or before `ts`.
    pub fn hub_seq_at_or_before(&self, room: &str, ts: i64) -> Result<Option<i64>, String> {
        self.conn
            .prepare_cached("SELECT MAX(seq) FROM hub_msgs WHERE room = ?1 AND ts <= ?2")
            .and_then(|mut st| st.query_row(rusqlite::params![room, ts], |r| r.get(0)))
            .map_err(|e| format!("resolve ts: {e}"))
    }

    /// Move `room`'s read mark FORWARD (board #334) and return where it now
    /// is. The SERVER resolves the mark: a `seq` is clamped to the room's
    /// newest message (a cache from a wiped database cannot hide the next
    /// messages), a legacy `ts`-only mark becomes the newest seq at or before
    /// it, and the stored `ts` is always the resolved message's, never a
    /// client clock. An older mark is a no-op: the row only grows.
    pub fn hub_mark_read(&self, room: &str, seq: Option<i64>, ts: i64) -> Result<Option<(i64, i64)>, String> {
        let resolved: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT seq, ts FROM hub_msgs
                  WHERE room = ?1 AND (CASE WHEN ?2 IS NULL THEN ts <= ?3 ELSE seq <= ?2 END)
                  ORDER BY seq DESC LIMIT 1",
                rusqlite::params![room, seq, ts],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("resolve read mark: {e}"))?;
        if let Some((seq, ts)) = resolved {
            self.conn
                .execute(
                    "INSERT INTO hub_read (room, seq, ts) VALUES (?1, ?2, ?3)
                     ON CONFLICT(room) DO UPDATE SET seq = MAX(seq, excluded.seq), ts = MAX(ts, excluded.ts)",
                    rusqlite::params![room, seq, ts],
                )
                .map_err(|e| format!("write hub_read: {e}"))?;
        }
        self.hub_read_mark(room)
    }

    /// The page of `room` AROUND one of its messages (board #322, the jump
    /// window): up to `limit / 2` rows at or after `seq` and the rest before
    /// it, oldest first. seq is global across rooms, so `before_seq = seq + N`
    /// would not mean N rows of THIS room. Returns `(messages, older_exist,
    /// newer_exist)`.
    pub fn hub_around(&self, room: &str, seq: i64, limit: i64) -> Result<(Vec<HubMsg>, bool, bool), String> {
        let limit = limit.clamp(2, 1000);
        let after = limit / 2;
        let before = limit - after;
        let mut newer: Vec<HubMsg> = self
            .conn
            .prepare_cached(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
                 WHERE room = ?1 AND seq >= ?2 ORDER BY seq ASC LIMIT ?3",
            )
            .map_err(|e| format!("prepare hub around: {e}"))?
            .query_map(rusqlite::params![room, seq, after + 1], hub_msg_row)
            .map_err(|e| format!("query hub around: {e}"))?
            .filter_map(Result::ok)
            .collect();
        let newer_more = newer.len() as i64 > after;
        newer.truncate(after as usize);
        let mut older: Vec<HubMsg> = self
            .conn
            .prepare_cached(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
                 WHERE room = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
            )
            .map_err(|e| format!("prepare hub around: {e}"))?
            .query_map(rusqlite::params![room, seq, before + 1], hub_msg_row)
            .map_err(|e| format!("query hub around: {e}"))?
            .filter_map(Result::ok)
            .collect();
        let older_more = older.len() as i64 > before;
        older.truncate(before as usize);
        older.reverse();
        older.extend(newer);
        Ok((older, older_more, newer_more))
    }

    /// ONE message by its id, however old it is.
    pub fn hub_message_by_id(&self, room: &str, id: &str) -> Result<Option<HubMsg>, String> {
        self.conn
            .query_row(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
                 WHERE room = ?1 AND id = ?2",
                rusqlite::params![room, id],
                hub_msg_row,
            )
            .optional()
            .map_err(|e| format!("hub message by id: {e}"))
    }

    /// ONE message by its room seq (board #290: `tmm send --re <seq>`).
    pub fn hub_message_by_seq(&self, room: &str, seq: i64) -> Result<Option<HubMsg>, String> {
        self.conn
            .query_row(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
                 WHERE room = ?1 AND seq = ?2",
                rusqlite::params![room, seq],
                hub_msg_row,
            )
            .optional()
            .map_err(|e| format!("hub message by seq: {e}"))
    }

    /// The newest `limit` messages matching ANY of `terms` (substring,
    /// ASCII-case-insensitive, body or sender), oldest first. `room = None`
    /// searches every room.
    ///
    /// The match runs in SQL (board #124): the old shape selected every row
    /// of the scope newest-first and filtered with `contains()` in Rust —
    /// fine while hits were dense, but a rare or absent term materialized the
    /// whole table (34 ms at 50k rows, measured). `LIKE` with `%`/`_`/`\`
    /// escaped keeps substring semantics; `lower()` matches the old
    /// `to_ascii_lowercase` exactly because SQLite's `lower()` is ASCII-only
    /// without ICU — case-insensitivity for ASCII, byte-verbatim for
    /// everything else, which is the behaviour the Rust path always had.
    pub fn hub_search(
        &self,
        room: Option<&str>,
        terms: &[String],
        limit: i64,
    ) -> Result<Vec<HubMsg>, String> {
        let limit = limit.clamp(1, 500);
        let terms: Vec<String> = terms
            .iter()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        // One `%term%` pattern per term, LIKE-escaped so a literal `%`/`_` in
        // the query stays literal.
        let escape = |t: &str| t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let patterns: Vec<String> = terms.iter().map(|t| format!("%{}%", escape(t))).collect();
        let clause = patterns
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let p = i + 2; // ?1 is the room
                format!("lower(body) LIKE ?{p} ESCAPE '\\' OR lower(sender) LIKE ?{p} ESCAPE '\\'")
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = format!(
            "SELECT seq, id, ts, room, sender, to_json, kind, body FROM hub_msgs
             WHERE (?1 IS NULL OR room = ?1) AND ({clause})
             ORDER BY seq DESC LIMIT {limit}"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| format!("prepare hub search: {e}"))?;
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(room.map(str::to_string))];
        for p in &patterns {
            args.push(Box::new(p.clone()));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), hub_msg_row)
            .map_err(|e| format!("query hub search: {e}"))?;
        let mut hits: Vec<HubMsg> = rows.filter_map(Result::ok).collect();
        hits.reverse();
        Ok(hits)
    }

    /// Newest message timestamp (ms) per room — what orders the project list.
    pub fn hub_room_latest(&self) -> Result<Vec<(String, i64)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT room, MAX(ts) FROM hub_msgs GROUP BY room")
            .map_err(|e| format!("prepare room latest: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("query room latest: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Forget messages by id, for good — the irreversible half of deleting
    /// (`msg_archive` is the reversible half).
    pub fn hub_delete(&self, room: &str, ids: &[String]) -> Result<usize, String> {
        let mut n = 0;
        for id in ids {
            n += self
                .conn
                .execute(
                    "DELETE FROM hub_msgs WHERE room = ?1 AND id = ?2",
                    rusqlite::params![room, id],
                )
                .map_err(|e| format!("delete hub message: {e}"))?;
        }
        Ok(n)
    }

    /// One-shot flag store (v19 `meta`).
    pub fn meta_get(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("meta get: {e}"))
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, value],
            )
            .map(|_| ())
            .map_err(|e| format!("meta set: {e}"))
    }

    /// The one-off legacy import (board #107): copy every `proj:*` room out of
    /// an agora `team.db` whose schema this mirrors. Seq/id/ts are preserved so
    /// existing clients' cursors stay valid; INSERT OR IGNORE makes a retried
    /// partial import safe. Team rooms (`tmm-team-*` sessions' slugs) are the
    /// deleted feature's data and stay behind.
    pub fn hub_import_from(&mut self, legacy_db: &Path) -> Result<usize, String> {
        let src = Connection::open_with_flags(
            legacy_db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("open legacy team.db: {e}"))?;
        let mut stmt = src
            .prepare(
                "SELECT seq, id, ts, room, sender, to_json, kind, body FROM messages
                 WHERE room LIKE 'proj:%' ORDER BY seq",
            )
            .map_err(|e| format!("prepare legacy read: {e}"))?;
        let rows: Vec<HubMsg> = stmt
            .query_map([], hub_msg_row)
            .map_err(|e| format!("read legacy messages: {e}"))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        let tx = self.conn.transaction().map_err(|e| format!("import tx: {e}"))?;
        let mut n = 0;
        for m in &rows {
            n += tx
                .execute(
                    "INSERT OR IGNORE INTO hub_msgs (seq, id, ts, room, sender, to_json, kind, body)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![m.seq, m.id, m.ts, m.room, m.sender, m.to_json, m.kind, m.body],
                )
                .map_err(|e| format!("import hub message: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit import: {e}"))?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archiving_hides_a_message_and_restoring_gives_it_back() {
        let store = Store::open_memory().unwrap();
        store.archive_msg("proj:a", "m1", 100, "human", "a test probe", 900).unwrap();
        store.archive_msg("proj:a", "m2", 200, "dev", "another", 901).unwrap();
        store.archive_msg("proj:b", "m3", 300, "human", "other room", 902).unwrap();

        // The filter list is per room: another room's archive cannot hide a
        // message here.
        let mut ids = store.archived_ids("proj:a").unwrap();
        ids.sort();
        assert_eq!(ids, vec!["m1", "m2"]);
        assert_eq!(store.archived_ids("proj:b").unwrap(), vec!["m3"]);

        // The archive view is self-contained: it carries the message itself, so it
        // needs no join across two databases and no history window.
        let rows = store.archived_msgs("proj:a").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "m2", "newest archived first");
        assert_eq!(rows[0].2, "dev");
        assert_eq!(rows[1].3, "a test probe");

        // Archiving twice is not an error — the UI must not have to care.
        store.archive_msg("proj:a", "m1", 100, "human", "a test probe", 950).unwrap();
        assert_eq!(store.archived_msgs("proj:a").unwrap().len(), 2);

        // Restoring is dropping the row; the message never left the room's store.
        assert_eq!(store.unarchive_msgs("proj:a", &["m1".to_string()]).unwrap(), 1);
        assert_eq!(store.archived_ids("proj:a").unwrap(), vec!["m2"]);
        // Unknown ids are simply not there.
        assert_eq!(store.unarchive_msgs("proj:a", &["nope".to_string()]).unwrap(), 0);
    }

    /// Board #124: the match moved into SQL `LIKE`, and a literal `%` or `_`
    /// in the query must stay literal — unescaped they are wildcards, and
    /// "50%" would match "50x" while "r_s" matched any "rXs".
    #[test]
    fn hub_search_escapes_like_wildcards() {
        let store = Store::open_memory().unwrap();
        store.hub_append("proj:esc", "e1", 10, "human", "[]", "msg", "take 50% off today").unwrap();
        store.hub_append("proj:esc", "e2", 20, "human", "[]", "msg", "take 50x off today").unwrap();
        store.hub_append("proj:esc", "e3", 30, "human", "[]", "msg", "an under_score name").unwrap();
        store.hub_append("proj:esc", "e4", 40, "human", "[]", "msg", "an underXscore name").unwrap();
        let hits = |term: &str| {
            store.hub_search(Some("proj:esc"), &[term.to_string()], 50).unwrap()
                .into_iter().map(|m| m.id).collect::<Vec<_>>()
        };
        assert_eq!(hits("50%"), vec!["e1"], "a literal % is not a wildcard");
        assert_eq!(hits("under_s"), vec!["e3"], "a literal _ is not a wildcard");
        assert_eq!(hits("UNDER_S"), vec!["e3"], "ASCII case-insensitive, as before");
        assert!(hits("zzz").is_empty());
    }
}
