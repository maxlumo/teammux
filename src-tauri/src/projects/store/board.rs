//! The task board: issues, their notes and per-project numbering.
//!
//! One family of the store (board #147): an `impl Store` block over the same
//! connection, the same migration ladder, the same tests — only the file moved.

use super::*;

/// Board #43: the ONE definition of an issue's blocking state, as SQL over
/// the issue aliased `i`. `blocked_by` is its blockers' project numbers in
/// order (a JSON array); `blocked` is true while ANY blocker is not done.
/// Both are derived on every read: nothing stores "ready", so moving a
/// blocker out of done blocks its dependants again on the next read.
const BLOCKED_BY_SQL: &str = "(SELECT json_group_array(n) FROM (
        SELECT b.project_number AS n FROM issue_blocks e JOIN issues b ON b.id = e.blocker_id
         WHERE e.issue_id = i.id ORDER BY n))";
const BLOCKED_SQL: &str = "EXISTS (SELECT 1 FROM issue_blocks e JOIN issues b ON b.id = e.blocker_id
         WHERE e.issue_id = i.id AND b.status <> 'done')";

fn blocked_by_json(text: String) -> serde_json::Value {
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!([]))
}

/// The chain of project numbers from `from` to `to` following blocked-by
/// edges (`from`, its blocker, that one's blocker, …, `to`), or None when
/// `to` is not reachable. A breadth-first walk, so the chain is a shortest
/// one; the board is small and the walk visits each issue once.
fn blocker_path(conn: &rusqlite::Connection, from: i64, to: i64) -> Result<Option<Vec<i64>>, String> {
    let mut next = conn
        .prepare("SELECT blocker_id FROM issue_blocks WHERE issue_id = ?1 ORDER BY blocker_id")
        .map_err(|e| e.to_string())?;
    let mut parent: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut queue = std::collections::VecDeque::from([from]);
    let mut seen = std::collections::HashSet::from([from]);
    while let Some(at) = queue.pop_front() {
        if at == to {
            let mut rows = vec![at];
            let mut cur = at;
            while let Some(&p) = parent.get(&cur) {
                rows.push(p);
                cur = p;
            }
            rows.reverse();
            let mut number = conn
                .prepare("SELECT project_number FROM issues WHERE id = ?1")
                .map_err(|e| e.to_string())?;
            return rows
                .into_iter()
                .map(|r| number.query_row([r], |x| x.get(0)).map_err(|e| e.to_string()))
                .collect::<Result<Vec<i64>, String>>()
                .map(Some);
        }
        let blockers = next
            .query_map([at], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for b in blockers {
            if seen.insert(b) {
                parent.insert(b, at);
                queue.push_back(b);
            }
        }
    }
    Ok(None)
}

/// The one edge writer (board #43): resolve every number on `session`'s
/// board, refuse a self-edge and a cycle, add and remove, and answer the
/// edges that really changed. It runs inside the caller's transaction, so an
/// edit and a create-with-blockers share one set of rules and are each all or
/// nothing.
fn write_blocks(conn: &rusqlite::Connection, session: &str, id: i64, add: &[i64], remove: &[i64]) -> Result<(Vec<i64>, Vec<i64>), String> {
    let row = |n: i64| -> Result<i64, String> {
        conn.query_row(
            "SELECT id FROM issues WHERE session = ?1 AND project_number = ?2",
            rusqlite::params![session, n],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no issue #{n} on this board"))
    };
    let issue = row(id)?;
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    for &n in add {
        let blocker = row(n)?;
        if blocker == issue {
            return Err(format!("#{n} cannot block itself"));
        }
        if let Some(path) = blocker_path(conn, blocker, issue)? {
            let chain: Vec<String> = std::iter::once(id).chain(path).map(|k| format!("#{k}")).collect();
            return Err(format!("#{n} cannot block #{id}: that makes a cycle {}", chain.join(" → ")));
        }
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO issue_blocks (issue_id, blocker_id) VALUES (?1, ?2)",
                rusqlite::params![issue, blocker],
            )
            .map_err(|e| e.to_string())?;
        if inserted > 0 {
            added.push(n);
        }
    }
    for &n in remove {
        let blocker = row(n)?;
        let deleted = conn
            .execute(
                "DELETE FROM issue_blocks WHERE issue_id = ?1 AND blocker_id = ?2",
                rusqlite::params![issue, blocker],
            )
            .map_err(|e| e.to_string())?;
        if deleted > 0 {
            removed.push(n);
        }
    }
    Ok((added, removed))
}


impl Store {
    /// Every additive Board shape, as the heal floor sees it: the v15 edit
    /// lock, the v16 numbering, the v34 blocking edges (board #43) and the
    /// v35 agreement flag (board #44). One
    /// family call, so `heal` in mod.rs stays the connection's.
    pub(super) fn ensure_board_shape(&self) -> Result<(), String> {
        self.ensure_issue_edit_lock()?;
        self.ensure_issue_numbering()?;
        self.ensure_issue_blocks()?;
        self.ensure_issue_agreement()
    }

    /// The v35 shape (board #44; also a heal floor): `issue_notes.agreement`,
    /// added only when absent. Existing notes stay plain notes.
    pub(super) fn ensure_issue_agreement(&self) -> Result<(), String> {
        let has_column: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('issue_notes') WHERE name = 'agreement')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect Board agreement: {e}"))?;
        if !has_column {
            self.conn
                .execute_batch("ALTER TABLE issue_notes ADD COLUMN agreement INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("add Board agreement: {e}"))?;
        }
        Ok(())
    }

    /// The v34 shape (also a heal floor): blocking edges between issues of
    /// one board, keyed by the hidden row ids so a project rename carries
    /// them and deleting either issue drops the edge.
    pub(super) fn ensure_issue_blocks(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS issue_blocks (
                   issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
                   blocker_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
                   PRIMARY KEY (issue_id, blocker_id)
                 );
                 CREATE INDEX IF NOT EXISTS issue_blocks_blocker ON issue_blocks(blocker_id);",
            )
            .map_err(|e| format!("ensure issue blocks: {e}"))
    }

    /// Add and remove blocking edges of issue `id` on `session`'s board, in
    /// one transaction. Returns the edges that really changed (added,
    /// removed), so a caller records only real changes; an existing edge
    /// added or an absent one removed is a no-op.
    pub fn issue_blocks_set(&self, session: &str, id: i64, add: &[i64], remove: &[i64]) -> Result<(Vec<i64>, Vec<i64>), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let changed = write_blocks(&tx, session, id, add, remove)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    /// File a NEW issue together with its initial blockers, in ONE
    /// transaction (board #43 P1-R1, reviewer on 450dfe7d): the issue and
    /// every edge are published together or nothing is. The edges go through
    /// the same `write_blocks` as every edit (missing, another board, self,
    /// cycle), so a blocker deleted after the caller looked fails the whole
    /// create after its INSERT and it rolls back, the number with it (nobody
    /// was ever told that number). Before this the create committed first
    /// and the edges followed in a second transaction, so a frontier read
    /// between them, or a failed edge write, showed the issue unblocked.
    #[allow(clippy::too_many_arguments)]
    pub fn issue_create_blocked(
        &self,
        session: &str,
        title: Option<&str>,
        body: Option<&str>,
        status: Option<&str>,
        assignee: Option<&str>,
        who: &str,
        now: i64,
        blocked_by: &[i64],
    ) -> Result<i64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let id = self.issue_save(session, None, title, body, status, assignee, who, now)?;
        write_blocks(&tx, session, id, blocked_by, &[])?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// Allocate one visible number atomically for a session. The sequence is
    /// advanced before the issue INSERT; a failed insert may leave a gap (like
    /// AUTOINCREMENT) but can never reuse a number that was already observed.
    pub(super) fn next_issue_number(&self, session: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "INSERT INTO issue_sequences (session, next_number) VALUES (?1, 2)
                 ON CONFLICT(session) DO UPDATE SET
                   next_number = issue_sequences.next_number + 1
                 RETURNING next_number - 1",
                [session],
                |r| r.get(0),
            )
            .map_err(|e| format!("allocate Board project number: {e}"))
    }

    /// All issues of one project's board, newest movement first inside each
    /// status. `notes` is a COUNT here — the thread comes with `issue_get`.
    pub fn issues_list(&self, session: &str) -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT i.project_number, i.title, i.body, i.status, i.assignee, i.created_by,
                        i.created_at, i.updated_at, i.agent_touched,
                        (SELECT COUNT(*) FROM issue_notes n WHERE n.issue_id = i.id),
                        {BLOCKED_BY_SQL}, {BLOCKED_SQL}
                   FROM issues i WHERE i.session = ?1
                  ORDER BY i.updated_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([session], |r| {
                let assignee = r.get::<_, String>(4)?;
                let agent_touched = r.get::<_, i64>(8)? != 0;
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "body": r.get::<_, String>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "assignee": assignee,
                    "created_by": r.get::<_, String>(5)?,
                    "created_at": r.get::<_, i64>(6)?,
                    "updated_at": r.get::<_, i64>(7)?,
                    "editable": assignee.is_empty() && !agent_touched,
                    "notes": r.get::<_, i64>(9)?,
                    "blocked_by": blocked_by_json(r.get::<_, String>(10)?),
                    "blocked": r.get::<_, i64>(11)? != 0,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Issue counts per (session, status) — ONE grouped query over every
    /// board (board #39): the sidebar wants "which projects have work, how
    /// much, in which column" for ALL projects at once, and asking
    /// `issues_list` per project is the N+1 the grouped read exists to
    /// prevent. Raw rows here; the projects layer shapes them (zero-fill,
    /// totals) so the SQL stays a plain aggregate.
    pub fn issue_counts(&self) -> Result<Vec<(String, String, i64)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT session, status, COUNT(*) FROM issues GROUP BY session, status")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// One issue with its full note thread, or None.
    pub fn issue_get(&self, session: &str, id: i64) -> Result<Option<serde_json::Value>, String> {
        let issue = self
            .conn
            .query_row(
                &format!(
                    "SELECT i.id, i.project_number, i.title, i.body, i.status, i.assignee, i.created_by,
                            i.created_at, i.updated_at, i.agent_touched, {BLOCKED_BY_SQL}, {BLOCKED_SQL}
                       FROM issues i WHERE i.session = ?1 AND i.project_number = ?2"
                ),
                rusqlite::params![session, id],
                |r| {
                    let assignee = r.get::<_, String>(5)?;
                    let agent_touched = r.get::<_, i64>(9)? != 0;
                    Ok((r.get::<_, i64>(0)?, serde_json::json!({
                        "id": r.get::<_, i64>(1)?,
                        "title": r.get::<_, String>(2)?,
                        "body": r.get::<_, String>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "assignee": assignee,
                        "created_by": r.get::<_, String>(6)?,
                        "created_at": r.get::<_, i64>(7)?,
                        "updated_at": r.get::<_, i64>(8)?,
                        "editable": assignee.is_empty() && !agent_touched,
                        "blocked_by": blocked_by_json(r.get::<_, String>(10)?),
                        "blocked": r.get::<_, i64>(11)? != 0,
                    })))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((row_id, mut issue)) = issue else { return Ok(None) };
        // Board #44: the thread in row-id order, the order notes were written
        // (an `at` can step back with the clock; the id cannot). Each note's
        // `n` is its position in that order, and the agreement state is
        // derived here, on every read: the newest agreement note is current
        // and each earlier one is superseded by the next. Nothing is stored
        // as a pointer, and no note is ever updated.
        let mut stmt = self
            .conn
            .prepare("SELECT author, body, at, agreement FROM issue_notes WHERE issue_id = ?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let mut notes = stmt
            .query_map([row_id], |r| {
                Ok(serde_json::json!({
                    "author": r.get::<_, String>(0)?,
                    "body": r.get::<_, String>(1)?,
                    "at": r.get::<_, i64>(2)?,
                    "agreement": r.get::<_, i64>(3)? != 0,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut later: Option<i64> = None;
        for (i, note) in notes.iter_mut().enumerate().rev() {
            let n = i as i64 + 1;
            note["n"] = serde_json::json!(n);
            let is_agreement = note["agreement"] == true;
            note["superseded_by"] = match (is_agreement, later) {
                (true, Some(next)) => serde_json::json!(next),
                _ => serde_json::Value::Null,
            };
            if is_agreement {
                later = Some(n);
            }
        }
        issue["agreement"] = notes
            .iter()
            .rev()
            .find(|n| n["agreement"] == true)
            .map(|n| serde_json::json!({ "n": n["n"], "author": n["author"], "body": n["body"], "at": n["at"] }))
            .unwrap_or(serde_json::Value::Null);
        issue["notes"] = serde_json::Value::Array(notes);
        Ok(Some(issue))
    }

    /// Create (id = None) or update. Update patches only the given fields, so
    /// an agent's `move` cannot erase a body the human wrote meanwhile.
    #[allow(clippy::too_many_arguments)]
    pub fn issue_save(
        &self,
        session: &str,
        id: Option<i64>,
        title: Option<&str>,
        body: Option<&str>,
        status: Option<&str>,
        assignee: Option<&str>,
        who: &str,
        now: i64,
    ) -> Result<i64, String> {
        match id {
            None => {
                // A title is OPTIONAL (board #31) — the one rule is that an
                // issue is never CONTENTLESS: at least one of title/body must
                // say something. An empty title is stored EMPTY, verbatim;
                // display fallbacks are the reader's job (`issue_ref`), never
                // fabricated into persistence.
                let title = title.unwrap_or("").trim();
                if title.is_empty() && body.unwrap_or("").trim().is_empty() {
                    return Err("an issue needs a title or a body".into());
                }
                let number = self.next_issue_number(session)?;
                self.conn
                    .execute(
                        "INSERT INTO issues
                           (session, project_number, title, body, status, assignee, created_by, created_at, updated_at, agent_touched)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                        rusqlite::params![
                            session,
                            number,
                            title,
                            body.unwrap_or(""),
                            status.unwrap_or("todo"),
                            assignee.unwrap_or(""),
                            who,
                            now,
                            (who != "human") as i64
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                Ok(number)
            }
            Some(id) => {
                // The contentless rule holds through PATCHES too: a save may
                // clear the title (Some("")) only if what it leaves behind —
                // patched or kept — still has a body, and vice versa.
                let cur: Option<(String, String, String, bool)> = self
                    .conn
                    .query_row(
                        "SELECT title, body, assignee, agent_touched
                           FROM issues WHERE session = ?1 AND project_number = ?2",
                        rusqlite::params![session, id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some((cur_title, cur_body, cur_assignee, agent_touched)) = cur else {
                    return Err(format!("no issue #{id} on this board"));
                };
                // The original brief is history after dispatch or Agent work.
                // Workflow fields remain patchable — status/assignee are how
                // the issue continues moving — but title/body cannot be
                // rewritten under the discussion that already followed them.
                if (title.is_some() || body.is_some())
                    && (!cur_assignee.is_empty() || agent_touched)
                {
                    return Err("issue title/body are locked after assignment or Agent activity".into());
                }
                if title.unwrap_or(&cur_title).trim().is_empty()
                    && body.unwrap_or(&cur_body).trim().is_empty()
                {
                    return Err("an issue needs a title or a body".into());
                }
                let n = self
                    .conn
                    .execute(
                        "UPDATE issues SET
                           title    = COALESCE(?3, title),
                           body     = COALESCE(?4, body),
                           status   = COALESCE(?5, status),
                           assignee = COALESCE(?6, assignee),
                           updated_at = ?7,
                           agent_touched = CASE WHEN ?8 <> 'human' THEN 1 ELSE agent_touched END
                         WHERE session = ?1 AND project_number = ?2",
                        rusqlite::params![session, id, title, body, status, assignee, now, who],
                    )
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err(format!("no issue #{id} on this board"));
                }
                Ok(id)
            }
        }
    }

    pub fn issue_note(&self, session: &str, id: i64, author: &str, body: &str, now: i64) -> Result<i64, String> {
        self.issue_note_as(session, id, author, body, now, false)
    }

    /// A note, or (board #44) a note DECLARED as the issue's current
    /// agreement. Declared at write only: an existing note is never re-marked,
    /// so the thread stays append-only and keeps the order agreements were
    /// made in (orchestrator, plan approval). Everything else is a note's.
    /// Answers the note's number `n` as `issue_get` reads it (board #42): a
    /// notice names exactly this note, never "the last one".
    pub fn issue_note_as(&self, session: &str, id: i64, author: &str, body: &str, now: i64, agreement: bool) -> Result<i64, String> {
        let body = body.trim();
        if body.is_empty() {
            return Err("an empty note says nothing".into());
        }
        // Resolve the session-local visible number to the hidden global row
        // key in the same gated statement. Notes keep their existing FK.
        let row_id: Option<i64> = self
            .conn
            .query_row(
                "UPDATE issues
                    SET updated_at = ?3,
                        agent_touched = CASE WHEN ?4 <> 'human' THEN 1 ELSE agent_touched END
                  WHERE session = ?1 AND project_number = ?2
                  RETURNING id",
                rusqlite::params![session, id, now, author],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(row_id) = row_id else {
            return Err(format!("no issue #{id} on this board"));
        };
        self.conn
            .execute(
                "INSERT INTO issue_notes (issue_id, author, body, at, agreement) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![row_id, author, body, now, agreement as i64],
            )
            .map_err(|e| e.to_string())?;
        // `n` is the note's position by row id within its issue — the ONE
        // numbering `issue_get` uses (#44). The connection is the store's
        // own, so the inserted row id is this write's.
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM issue_notes WHERE issue_id = ?1 AND id <= last_insert_rowid()",
                [row_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn issue_delete(&self, session: &str, id: i64) -> Result<bool, String> {
        self.conn
            .execute(
                "DELETE FROM issues WHERE session = ?1 AND project_number = ?2",
                rusqlite::params![session, id],
            )
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_issues_live_move_and_remember() {
        let store = Store::open_memory().unwrap();
        // Create, then patch FIELD BY FIELD: an agent's `move` must not erase
        // the body the human wrote meanwhile (COALESCE semantics).
        let id = store
            .issue_save("proj", None, Some("fix login"), Some("the flow breaks at step 2"), None, None, "human", 100)
            .unwrap();
        store.issue_save("proj", Some(id), None, None, Some("doing"), Some("builder"), "builder", 200).unwrap();
        let got = store.issue_get("proj", id).unwrap().unwrap();
        assert_eq!(got["status"], "doing");
        assert_eq!(got["assignee"], "builder");
        assert_eq!(got["body"], "the flow breaks at step 2", "move kept the body");
        assert_eq!(got["created_by"], "human");

        // Notes thread in order and bump updated_at; the count rides the list.
        store.issue_note("proj", id, "builder", "root cause found", 300).unwrap();
        store.issue_note("proj", id, "human", "ship it", 400).unwrap();
        let got = store.issue_get("proj", id).unwrap().unwrap();
        let notes = got["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0]["author"], "builder");
        assert_eq!(got["updated_at"], 400, "a note is board activity");
        let list = store.issues_list("proj").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["notes"], 2);

        // The board is SESSION-scoped: another project sees nothing, and a
        // guessed id cannot cross boards (note, update, get, delete alike).
        assert!(store.issues_list("other").unwrap().is_empty());
        assert!(store.issue_get("other", id).unwrap().is_none());
        assert!(store.issue_note("other", id, "x", "sneak", 500).is_err());
        assert!(store.issue_save("other", Some(id), None, None, Some("done"), None, "x", 500).is_err());
        assert!(!store.issue_delete("other", id).unwrap());

        // A CONTENTLESS create is refused; a body alone is enough (board
        // #31: the title is optional) and the empty title persists EMPTY —
        // no fabricated fallback in storage.
        assert!(store.issue_save("proj", None, Some("  "), None, None, None, "human", 600).is_err());
        assert!(store.issue_save("proj", None, None, Some("  "), None, None, "human", 600).is_err());
        let bare = store.issue_save("proj", None, None, Some("body only, no title"), None, None, "human", 610).unwrap();
        assert_eq!(bare, 2, "rejected contentless creates do not consume a visible number");
        let got = store.issue_get("proj", bare).unwrap().unwrap();
        assert_eq!(got["title"].as_str().unwrap(), "");
        assert_eq!(got["body"].as_str().unwrap(), "body only, no title");
        // A patch may CLEAR the title while a body remains…
        store.issue_save("proj", Some(bare), Some(""), None, None, None, "human", 620).unwrap();
        // …but never the last content: emptying the body of a title-less
        // issue (or both at once) is refused, patched-and-kept alike.
        assert!(store.issue_save("proj", Some(bare), None, Some("  "), None, None, "human", 630).is_err());
        assert!(store.issue_save("proj", Some(bare), Some(""), Some(""), None, None, "human", 630).is_err());
        // The other direction: clearing the BODY is fine while a title holds.
        store.issue_save("proj", Some(bare), Some("now titled"), Some(""), None, None, "human", 640).unwrap();
        assert!(store.issue_delete("proj", bare).unwrap());

        assert!(store.issue_delete("proj", id).unwrap());
        assert!(store.issue_get("proj", id).unwrap().is_none());
    }

    #[test]
    fn original_issue_text_locks_on_assignment_or_agent_activity() {
        let store = Store::open_memory().unwrap();

        let id = store.issue_save("proj", None, Some("brief"), Some("body"), None, None, "human", 100).unwrap();
        assert_eq!(store.issue_get("proj", id).unwrap().unwrap()["editable"], true);

        // Assignment locks immediately, but undoing it before the Agent acts
        // reopens the text: current assignment and durable activity are the
        // two independent gates from board #43.
        store.issue_save("proj", Some(id), None, None, None, Some("builder"), "human", 110).unwrap();
        assert_eq!(store.issue_get("proj", id).unwrap().unwrap()["editable"], false);
        assert!(store.issue_save("proj", Some(id), Some("rewrite"), None, None, None, "human", 120).is_err());
        store.issue_save("proj", Some(id), None, None, None, Some(""), "human", 130).unwrap();
        assert_eq!(store.issue_get("proj", id).unwrap().unwrap()["editable"], true);
        store.issue_save("proj", Some(id), Some("clarified"), None, None, None, "human", 140).unwrap();

        // Any Agent mutation is durable: unassigning or moving back cannot
        // make the original brief editable again. Workflow still moves.
        store.issue_save("proj", Some(id), None, None, Some("doing"), Some("builder"), "builder", 150).unwrap();
        store.issue_save("proj", Some(id), None, None, Some("todo"), Some(""), "human", 160).unwrap();
        let got = store.issue_get("proj", id).unwrap().unwrap();
        assert_eq!(got["editable"], false);
        assert_eq!(got["title"], "clarified");
        assert!(store.issue_save("proj", Some(id), None, Some("rewrite history"), None, None, "human", 170).is_err());

        let noted = store.issue_save("proj", None, Some("note lock"), None, None, None, "human", 200).unwrap();
        store.issue_note("proj", noted, "builder", "started", 210).unwrap();
        assert_eq!(store.issue_get("proj", noted).unwrap().unwrap()["editable"], false);

        let agent_owned = store.issue_save("proj", None, Some("agent filed"), None, None, None, "builder", 300).unwrap();
        assert_eq!(store.issue_get("proj", agent_owned).unwrap().unwrap()["editable"], false);
    }

    #[test]
    fn issue_numbers_start_at_one_per_project_and_never_reuse() {
        let store = Store::open_memory().unwrap();
        let a1 = store.issue_save("a", None, Some("a1"), None, None, None, "human", 10).unwrap();
        let b1 = store.issue_save("b", None, Some("b1"), None, None, None, "human", 11).unwrap();
        let a2 = store.issue_save("a", None, Some("a2"), None, None, None, "human", 12).unwrap();
        assert_eq!((a1, b1, a2), (1, 1, 2), "each project owns a sequence starting at one");

        // The same visible #1 resolves independently through session + number.
        store.issue_save("a", Some(1), None, None, Some("doing"), None, "human", 13).unwrap();
        store.issue_note("b", 1, "human", "only b", 14).unwrap();
        assert_eq!(store.issue_get("a", 1).unwrap().unwrap()["title"], "a1");
        assert_eq!(store.issue_get("a", 1).unwrap().unwrap()["notes"].as_array().unwrap().len(), 0);
        assert_eq!(store.issue_get("b", 1).unwrap().unwrap()["title"], "b1");
        assert_eq!(store.issue_get("b", 1).unwrap().unwrap()["notes"].as_array().unwrap().len(), 1);

        // Deleting the high card never reuses a number somebody may have seen
        // in chat/CLI history; each session advances independently.
        assert!(store.issue_delete("a", 2).unwrap());
        assert_eq!(store.issue_save("a", None, Some("a3"), None, None, None, "human", 15).unwrap(), 3);
        assert_eq!(store.issue_save("b", None, Some("b2"), None, None, None, "human", 16).unwrap(), 2);
        assert!(store.issue_get("a", 2).unwrap().is_none(), "the deleted number stays a gap");
        assert!(store.issue_delete("a", 1).unwrap());
        assert!(store.issue_delete("a", 3).unwrap());
        assert_eq!(
            store.issue_save("a", None, Some("a4"), None, None, None, "human", 17).unwrap(),
            4,
            "even an empty board remembers its next number until the project is permanently deleted",
        );
    }

    #[test]
    fn issue_counts_group_across_sessions_in_one_read() {
        let store = Store::open_memory().unwrap();
        // Two boards, mixed statuses — the grouped read must keep them apart
        // and count within (session, status), never across (board #39).
        let a1 = store.issue_save("proj-a", None, Some("t1"), None, None, None, "human", 100).unwrap();
        store.issue_save("proj-a", None, Some("t2"), None, None, None, "human", 110).unwrap();
        store.issue_save("proj-a", Some(a1), None, None, Some("doing"), None, "human", 120).unwrap();
        let b1 = store.issue_save("proj-b", None, Some("t3"), None, None, None, "human", 130).unwrap();
        store.issue_save("proj-b", Some(b1), None, None, Some("done"), None, "human", 140).unwrap();

        let rows = store.issue_counts().unwrap();
        let n = |s: &str, st: &str| rows.iter().find(|(a, b, _)| a == s && b == st).map(|(_, _, n)| *n);
        assert_eq!(n("proj-a", "todo"), Some(1));
        assert_eq!(n("proj-a", "doing"), Some(1));
        assert_eq!(n("proj-b", "done"), Some(1));
        // A (session, status) cell with no issues yields NO row — absence,
        // not zero: the shaping layer owns the vocabulary fill.
        assert_eq!(n("proj-a", "done"), None);
        assert_eq!(n("proj-b", "todo"), None);
        // A session with no issues at all appears nowhere.
        assert!(!rows.iter().any(|(s, _, _)| s == "proj-empty"));
    }

    /// Board #43: an issue is blocked while ANY blocker is not done. It is
    /// derived on every read, never stored, so a reopened blocker blocks again.
    #[test]
    fn an_issue_is_blocked_while_a_blocker_is_not_done() {
        let store = Store::open_memory().unwrap();
        let a = store.issue_save("p", None, Some("blocker a"), None, None, None, "human", 10).unwrap();
        let b = store.issue_save("p", None, Some("blocker b"), None, None, None, "human", 11).unwrap();
        let c = store.issue_save("p", None, Some("waits"), None, None, None, "human", 12).unwrap();
        let get = |id: i64| store.issue_get("p", id).unwrap().unwrap();
        let listed = |id: i64| store.issues_list("p").unwrap().into_iter().find(|i| i["id"] == id).unwrap();

        // No edge: not blocked, an empty list.
        assert_eq!(get(c)["blocked"], false);
        assert_eq!(get(c)["blocked_by"], serde_json::json!([]));

        let changed = store.issue_blocks_set("p", c, &[a, b], &[]).unwrap();
        assert_eq!(changed, (vec![a, b], vec![]), "both edges are new");
        for row in [get(c), listed(c)] {
            assert_eq!(row["blocked_by"], serde_json::json!([1, 2]));
            assert_eq!(row["blocked"], true);
        }
        // A blocker is not itself blocked by being one.
        assert_eq!(get(a)["blocked"], false);

        // One blocker done is not enough; both done unblocks.
        store.issue_save("p", Some(a), None, None, Some("done"), None, "human", 20).unwrap();
        assert_eq!(get(c)["blocked"], true);
        store.issue_save("p", Some(b), None, None, Some("done"), None, "human", 21).unwrap();
        assert_eq!(get(c)["blocked"], false);
        assert_eq!(listed(c)["blocked"], false);
        assert_eq!(get(c)["blocked_by"], serde_json::json!([1, 2]), "the edges stay after the blockers are done");

        // Reopen: a blocker moved out of done blocks again.
        store.issue_save("p", Some(b), None, None, Some("review"), None, "human", 22).unwrap();
        assert_eq!(get(c)["blocked"], true);

        // Adding an edge that exists, or removing one that does not, is a no-op.
        assert_eq!(store.issue_blocks_set("p", c, &[a], &[]).unwrap(), (vec![], vec![]));
        assert_eq!(store.issue_blocks_set("p", a, &[], &[b]).unwrap(), (vec![], vec![]));
        // Removing b leaves only the done a: unblocked.
        assert_eq!(store.issue_blocks_set("p", c, &[], &[b]).unwrap(), (vec![], vec![b]));
        assert_eq!(get(c)["blocked_by"], serde_json::json!([1]));
        assert_eq!(get(c)["blocked"], false);

        // A blocked issue may still be moved to done: a blocker informs, it never forbids.
        store.issue_blocks_set("p", c, &[b], &[]).unwrap();
        store.issue_save("p", Some(c), None, None, Some("done"), None, "human", 30).unwrap();
        assert_eq!(get(c)["status"], "done");
    }

    /// Board #43 AC2: a self-edge, a cycle, or a number from another board is
    /// refused, and a refused call writes nothing (one transaction).
    #[test]
    fn a_blocking_edge_refuses_a_self_edge_a_cycle_and_another_board() {
        let store = Store::open_memory().unwrap();
        for t in ["one", "two", "three"] {
            store.issue_save("p", None, Some(t), None, None, None, "human", 10).unwrap();
        }
        store.issue_save("q", None, Some("other board"), None, None, None, "human", 10).unwrap();
        store.issue_save("q", None, Some("other board 2"), None, None, None, "human", 10).unwrap();
        store.issue_save("q", None, Some("other board 3"), None, None, None, "human", 10).unwrap();
        store.issue_save("q", None, Some("other board 4"), None, None, None, "human", 10).unwrap();
        let by = |id: i64| store.issue_get("p", id).unwrap().unwrap()["blocked_by"].clone();

        let e = store.issue_blocks_set("p", 1, &[1], &[]).unwrap_err();
        assert_eq!(e, "#1 cannot block itself");

        // 2 blocked by 1, 3 blocked by 2: 1 blocked by 3 closes 1 → 3 → 2 → 1.
        store.issue_blocks_set("p", 2, &[1], &[]).unwrap();
        store.issue_blocks_set("p", 3, &[2], &[]).unwrap();
        let e = store.issue_blocks_set("p", 1, &[3], &[]).unwrap_err();
        assert_eq!(e, "#3 cannot block #1: that makes a cycle #1 → #3 → #2 → #1");
        // The direct two-issue cycle too.
        let e = store.issue_blocks_set("p", 1, &[2], &[]).unwrap_err();
        assert_eq!(e, "#2 cannot block #1: that makes a cycle #1 → #2 → #1");
        assert_eq!(by(1), serde_json::json!([]));

        // #4 exists only on board q: on p it is not found.
        let e = store.issue_blocks_set("p", 1, &[4], &[]).unwrap_err();
        assert_eq!(e, "no issue #4 on this board");

        // All or nothing: a valid edge in the same call as a refused one is not kept.
        assert!(store.issue_blocks_set("p", 3, &[1, 3], &[]).is_err());
        assert_eq!(by(3), serde_json::json!([2]));
    }

    /// Board #43 P1-R1 (reviewer, 450dfe7d): an issue filed with blockers is
    /// published WITH every edge or not at all. A blocker that is missing
    /// when the edges are written (deleted after the caller looked) fails
    /// after the issue INSERT, and the whole create rolls back: no issue, no
    /// partial edge, and its number is not consumed.
    #[test]
    fn an_issue_filed_with_blockers_is_published_whole_or_not_at_all() {
        let store = Store::open_memory().unwrap();
        let a = store.issue_save("p", None, Some("a"), None, None, None, "human", 10).unwrap();
        let b = store.issue_save("p", None, Some("b"), None, None, None, "human", 10).unwrap();
        // The caller saw #b; it is deleted before the create runs.
        assert!(store.issue_delete("p", b).unwrap());
        let e = store.issue_create_blocked("p", Some("waits"), None, None, None, "human", 20, &[a, b]).unwrap_err();
        assert_eq!(e, format!("no issue #{b} on this board"));
        assert_eq!(store.issues_list("p").unwrap().len(), 1, "nothing was filed");
        let edges: i64 = store.conn.query_row("SELECT COUNT(*) FROM issue_blocks", [], |r| r.get(0)).unwrap();
        assert_eq!(edges, 0, "the surviving blocker's edge did not land either");
        // The number the failed create took is released with it.
        let next = store.issue_create_blocked("p", Some("waits"), None, None, None, "human", 30, &[a]).unwrap();
        assert_eq!(next, b + 1, "#{b} stays a gap (deleted), the failed create used none");
        let got = store.issue_get("p", next).unwrap().unwrap();
        assert_eq!(got["blocked_by"], serde_json::json!([a]));
        assert_eq!(got["blocked"], true);
        // The contentless rule still holds on this path.
        assert!(store.issue_create_blocked("p", Some(" "), None, None, None, "human", 40, &[a]).is_err());
    }

    /// Board #44: an agreement is a note DECLARED when written; the current
    /// one is the newest such note by row id, every earlier one reads as
    /// superseded by the next, and nothing is ever rewritten. Each note's
    /// number `n` is its position by row id within the issue, so a clock that
    /// steps back cannot shift it.
    #[test]
    fn the_newest_agreement_note_is_current_and_the_earlier_ones_stay_superseded() {
        let store = Store::open_memory().unwrap();
        let id = store.issue_save("p", None, Some("scope"), Some("the original brief"), None, None, "human", 10).unwrap();
        let get = || store.issue_get("p", id).unwrap().unwrap();
        assert_eq!(get()["agreement"], serde_json::Value::Null, "no agreement yet");

        store.issue_note("p", id, "builder", "plan: one table", 20).unwrap();
        store.issue_note_as("p", id, "orchestrator", "agreed: one table, v35", 30, true).unwrap();
        store.issue_note("p", id, "reviewer", "P1 found", 40).unwrap();
        // A clock that stepped back: this note is written later but stamped earlier.
        store.issue_note_as("p", id, "orchestrator", "agreed: one table, v35, plus the cap", 25, true).unwrap();

        let got = get();
        let notes = got["notes"].as_array().unwrap();
        let ns: Vec<i64> = notes.iter().map(|n| n["n"].as_i64().unwrap()).collect();
        assert_eq!(ns, vec![1, 2, 3, 4], "numbered and listed by row id, whatever the clock said");
        assert_eq!(notes[3]["body"], "agreed: one table, v35, plus the cap");
        let flags: Vec<bool> = notes.iter().map(|n| n["agreement"].as_bool().unwrap()).collect();
        assert_eq!(flags, vec![false, true, false, true]);
        assert_eq!(notes[1]["superseded_by"], 4, "the earlier agreement points at the one that replaced it");
        assert_eq!(notes[3]["superseded_by"], serde_json::Value::Null);
        assert_eq!(notes[0]["superseded_by"], serde_json::Value::Null, "a plain note supersedes nothing and is not superseded");
        assert_eq!(
            got["agreement"],
            serde_json::json!({ "n": 4, "author": "orchestrator", "body": "agreed: one table, v35, plus the cap", "at": 25 })
        );
        // Nothing was rewritten: the original text and the first agreement are as written.
        assert_eq!(got["body"], "the original brief");
        assert_eq!(notes[1]["body"], "agreed: one table, v35");
        // An agreement note is a note: the empty rule and the board gate hold.
        assert!(store.issue_note_as("p", id, "x", "  ", 50, true).is_err());
        assert!(store.issue_note_as("other", id, "x", "sneak", 50, true).is_err());
    }

    /// Board #42 AC1: a write answers with the number its note is READ under,
    /// so a notice can name exactly that note even when another note lands
    /// before anybody reads it.
    #[test]
    fn a_note_write_returns_the_number_the_thread_shows_it_under() {
        let store = Store::open_memory().unwrap();
        let id = store.issue_save("p", None, Some("t"), None, None, None, "human", 10).unwrap();
        let other = store.issue_save("p", None, Some("u"), None, None, None, "human", 10).unwrap();
        assert_eq!(store.issue_note("p", id, "validator", "SHIP", 20).unwrap(), 1);
        assert_eq!(store.issue_note("p", other, "x", "another issue's note", 21).unwrap(), 1, "numbered per issue");
        assert_eq!(store.issue_note_as("p", id, "orchestrator", "agreed", 15, true).unwrap(), 2, "by row id, not by clock");
        assert_eq!(store.issue_note("p", id, "reviewer", "CLEAR", 30).unwrap(), 3);
        let got = store.issue_get("p", id).unwrap().unwrap();
        assert_eq!(got["notes"][0]["n"], 1);
        assert_eq!(got["notes"][0]["body"], "SHIP");
        assert_eq!(got["notes"][2]["body"], "CLEAR");
    }

    /// Board #43 AC3: deleting an issue takes every edge it is in, on either
    /// side; the dependant stays, no longer blocked by a number that is gone.
    #[test]
    fn deleting_an_issue_drops_its_blocking_edges() {
        let store = Store::open_memory().unwrap();
        for t in ["blocker", "middle", "dependant"] {
            store.issue_save("p", None, Some(t), None, None, None, "human", 10).unwrap();
        }
        store.issue_blocks_set("p", 2, &[1], &[]).unwrap();
        store.issue_blocks_set("p", 3, &[2], &[]).unwrap();
        assert!(store.issue_delete("p", 2).unwrap());
        let edges: i64 = store.conn.query_row("SELECT COUNT(*) FROM issue_blocks", [], |r| r.get(0)).unwrap();
        assert_eq!(edges, 0, "both edges of #2 went with it");
        let dep = store.issue_get("p", 3).unwrap().unwrap();
        assert_eq!(dep["blocked_by"], serde_json::json!([]));
        assert_eq!(dep["blocked"], false);
    }
}
