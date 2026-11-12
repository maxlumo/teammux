//! Scheduled wakes (board #275): a room message that does not exist yet.
//!
//! One family of the store (board #147). A row is a DECLARATION — "at
//! `due_at`, post `body` as `sender` into this project's room" — so it lives
//! in state.db and survives a server restart (tenet 7); the one sleeper that
//! fires it is a disposable projection. It is not a `deliveries` row: that is
//! one line already typed (or held) for one window, waiting for its echo,
//! while a wake's recipients are resolved only when it fires.

use super::*;

/// One pending (or settled) wake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wake {
    pub id: i64,
    pub session: String,
    pub sender: String,
    pub body: String,
    /// Unix seconds.
    pub due_at: i64,
    pub created_at: i64,
}

fn wake_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Wake> {
    Ok(Wake { id: r.get(0)?, session: r.get(1)?, sender: r.get(2)?, body: r.get(3)?, due_at: r.get(4)?, created_at: r.get(5)? })
}

const COLS: &str = "id, session, sender, body, due_at, created_at";
const PENDING: &str = "fired_at IS NULL AND cancelled_at IS NULL";

impl Store {
    /// The v29 shape (also a heal floor): the `wakes` table.
    pub(super) fn ensure_wakes(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS wakes (
                   id           INTEGER PRIMARY KEY AUTOINCREMENT,
                   session      TEXT NOT NULL,
                   sender       TEXT NOT NULL,
                   body         TEXT NOT NULL,
                   due_at       INTEGER NOT NULL,
                   created_at   INTEGER NOT NULL,
                   fired_at     INTEGER,
                   cancelled_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS wakes_due ON wakes(due_at) WHERE fired_at IS NULL AND cancelled_at IS NULL;",
            )
            .map_err(|e| format!("ensure wakes: {e}"))
    }

    pub fn insert_wake(&self, session: &str, sender: &str, body: &str, due_at: i64, now: i64) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO wakes (session, sender, body, due_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session, sender, body, due_at, now],
            )
            .map_err(|e| format!("insert wake: {e}"))?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn wake(&self, id: i64) -> Result<Option<Wake>, String> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM wakes WHERE id = ?1 AND {PENDING}"), params![id], wake_row)
            .optional()
            .map_err(|e| format!("read wake: {e}"))
    }

    /// Pending wakes, soonest first: one project's, or every project's.
    pub fn pending_wakes(&self, session: Option<&str>) -> Result<Vec<Wake>, String> {
        let (sql, arg) = match session {
            Some(s) => (format!("SELECT {COLS} FROM wakes WHERE session = ?1 AND {PENDING} ORDER BY due_at, id"), Some(s)),
            None => (format!("SELECT {COLS} FROM wakes WHERE {PENDING} ORDER BY due_at, id"), None),
        };
        let mut stmt = self.conn.prepare(&sql).map_err(|e| format!("prepare wakes: {e}"))?;
        let rows = match arg {
            Some(s) => stmt.query_map(params![s], wake_row),
            None => stmt.query_map([], wake_row),
        }
        .map_err(|e| format!("read wakes: {e}"))?;
        rows.collect::<Result<_, _>>().map_err(|e| format!("read wakes: {e}"))
    }

    /// Claim a pending wake for firing: true for exactly ONE caller, and only
    /// while it is neither fired nor cancelled. The claim is written BEFORE
    /// the post, so a wake fires at most once (orchestrator: never twice).
    pub fn claim_wake(&self, id: i64, now: i64) -> Result<bool, String> {
        self.conn
            .execute(&format!("UPDATE wakes SET fired_at = ?2 WHERE id = ?1 AND {PENDING}"), params![id, now])
            .map(|n| n == 1)
            .map_err(|e| format!("claim wake: {e}"))
    }

    /// FIRE wake `id` (board #122): in ONE transaction on this one connection, claim it, read
    /// it as it is now, let `compose` resolve its room and compose its line from that row
    /// (`(extra, room, to_json, body)`), and append the line (kind `msg`, at `ts` ms). The claim
    /// and the room line are both stored or neither is: a failure anywhere (the project read,
    /// the room INSERT) rolls the claim back, so the wake stays due and the sleeper retries it.
    /// None when it is no longer pending (cancelled, or fired by another).
    pub fn wake_fire<T>(
        &self,
        id: i64,
        now: i64,
        ts: i64,
        compose: impl FnOnce(&Store, &Wake) -> Result<(T, String, String, String), String>,
    ) -> Result<Option<(Wake, T, super::HubMsg)>, String> {
        self.in_transaction("fire wake", || {
            if !self.claim_wake(id, now)? {
                return Ok(None);
            }
            let Some(w) = self.wake_row(id)? else { return Ok(None) };
            let (extra, room, to_json, body) = compose(self, &w)?;
            let msg = self.hub_append(&room, &uuid::Uuid::new_v4().to_string(), ts, &w.sender, &to_json, "msg", &body)?;
            Ok(Some((w, extra, msg)))
        })
    }

    /// A wake by id whatever its state: the row a fire reads AFTER claiming
    /// it (#275), so it posts with the row's CURRENT session, never a
    /// snapshot a rename has since moved.
    pub fn wake_row(&self, id: i64) -> Result<Option<Wake>, String> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM wakes WHERE id = ?1"), params![id], wake_row)
            .optional()
            .map_err(|e| format!("read wake: {e}"))
    }

    /// Cancel a pending wake: true when this call cancelled it.
    pub fn cancel_wake(&self, id: i64, now: i64) -> Result<bool, String> {
        self.conn
            .execute(&format!("UPDATE wakes SET cancelled_at = ?2 WHERE id = ?1 AND {PENDING}"), params![id, now])
            .map(|n| n == 1)
            .map_err(|e| format!("cancel wake: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #122 (validator-2 note 8): a COMMIT that fails rolls the transaction back, so
    /// the claim is not left uncommitted and the connection is not left inside it: the next
    /// fire starts its own transaction and fires the wake once. A deferred foreign key makes
    /// the COMMIT itself fail.
    #[test]
    fn a_failed_commit_rolls_the_fire_back_and_the_next_fire_starts_clean() {
        let s = Store::open_memory().unwrap();
        s.exec_test_sql("CREATE TABLE p122 (id INTEGER PRIMARY KEY); CREATE TABLE c122 (pid INTEGER REFERENCES p122(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
        let w = s.insert_wake("proj", "lead", "@dev check", 100, 50).unwrap();
        let compose = |st: &Store, _: &Wake| -> Result<((), String, String, String), String> {
            st.exec_test_sql("INSERT INTO c122 VALUES (99);")?; // violates the deferred key: COMMIT fails
            Ok(((), "proj:proj".into(), "[]".into(), "[wake] @dev check".into()))
        };
        let err = s.wake_fire(w, 200, 200_000, compose).unwrap_err();
        assert!(err.contains("commit"), "{err}");
        let pending: i64 = s.conn.query_row("SELECT COUNT(*) FROM wakes WHERE id = ?1 AND fired_at IS NULL", [w], |r| r.get(0)).unwrap();
        assert_eq!(pending, 1, "the claim rolled back: still due");
        let rows: i64 = s.conn.query_row("SELECT COUNT(*) FROM hub_msgs WHERE room = 'proj:proj'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "and its line with it");
        let fired = s.wake_fire(w, 210, 210_000, |_, _| Ok(((), "proj:proj".into(), "[]".into(), "[wake] @dev check".into()))).unwrap();
        assert!(fired.is_some(), "the next fire is not 'within a transaction': it fires");
        assert!(s.wake_fire(w, 220, 220_000, |_, _| Ok(((), "proj:proj".into(), "[]".into(), "x".into()))).unwrap().is_none(), "once");
    }

    #[test]
    fn a_wake_is_claimed_once_and_a_cancel_beats_a_later_claim() {
        let s = Store::open_memory().unwrap();
        let a = s.insert_wake("p", "lead", "@dev a", 200, 100).unwrap();
        let b = s.insert_wake("p", "dev", "@dev b", 150, 100).unwrap();
        let c = s.insert_wake("q", "x", "@y c", 300, 100).unwrap();
        let ids = |v: Vec<Wake>| v.into_iter().map(|w| w.id).collect::<Vec<_>>();
        assert_eq!(ids(s.pending_wakes(Some("p")).unwrap()), vec![b, a], "soonest first, one project");
        assert_eq!(ids(s.pending_wakes(None).unwrap()), vec![b, a, c], "every project");
        assert!(s.claim_wake(a, 201).unwrap());
        assert!(!s.claim_wake(a, 202).unwrap(), "a second claim changes nothing");
        assert!(!s.cancel_wake(a, 203).unwrap(), "a fired wake cannot be cancelled");
        assert!(s.cancel_wake(b, 140).unwrap());
        assert!(!s.claim_wake(b, 151).unwrap(), "a cancelled wake never fires");
        assert_eq!(s.wake(b).unwrap(), None);
        assert_eq!(ids(s.pending_wakes(None).unwrap()), vec![c]);
    }
}
