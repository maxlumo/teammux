//! Telemetry rows: the activity log and delivery receipts.
//!
//! One family of the store (board #147): an `impl Store` block over the same
//! connection, the same migration ladder, the same tests — only the file moved.

use super::*;

/// One row of the durable activity log. `id` is the rowid, which doubles as the
/// paging cursor's tiebreak: several events share one millisecond inside a busy
/// turn, so a ts-only cursor would skip or repeat them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityRow {
    pub id: i64,
    /// The window NAME (board #120); pre-v20 rows read back their index as a
    /// decimal string.
    pub window: String,
    pub ts: u64,
    pub kind: String,
    pub text: String,
    pub tool: String,
    pub via: String,
    pub state: String,
    /// The delivery rows this event is about (board #249), a JSON array of
    /// `{id, msg?}`: the rows a `prompt` echo settled, or the one row a `warn`
    /// reported. '' for every other event and for rows before v24.
    pub deliveries: String,
}

/// One persisted turn fact: its row id (the order across restarts), when it
/// was written (ms), and its text/tool columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnFact {
    pub id: i64,
    pub ts: u64,
    pub text: String,
    pub tool: String,
}

/// A window's newest turn facts of each kind (board #249, `turn_facts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnFacts {
    pub window: String,
    pub prompt: Option<TurnFact>,
    pub tool: Option<TurnFact>,
    pub ask: Option<TurnFact>,
    pub end: Option<TurnFact>,
}

/// One outstanding delivery (board #249): the row id is its identity, so two
/// deliveries of the same body are two rows and each settles on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryRow {
    pub id: i64,
    pub window: String,
    pub line: String,
    pub ts: u64,
    /// The chat message this line carries; '' for a line with none (a board
    /// notice, a reply, a typed first prompt) and for pre-v24 rows.
    pub msg_id: String,
    /// Already reported unconfirmed. A reported row stays OUTSTANDING — a late
    /// real echo still settles it — but is never reported twice.
    pub warned: bool,
    /// A slash command's expected echo (board #264, v28) rather than a chat
    /// line: never swept; a prompt takes at most one, the window's oldest
    /// Idle row, settling it if it carries it and dropping it otherwise.
    /// `None` for a chat line.
    pub command: Option<CommandLife>,
    /// Where the stamped line starts in `line` (board #279, v30): its
    /// producer typed a Team context before it. 0 when nothing leads it.
    pub ask_at: usize,
}

impl DeliveryRow {
    /// The line as shown: its ask first (`address::shown`).
    pub fn shown(&self) -> String {
        crate::address::shown(&self.line, self.ask_at)
    }
}

/// Whether a command row can be taken by a prompt yet (board #264). Stored
/// as `deliveries.command` 1 / 2; 0 is a chat line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandLife {
    /// Its CLI runs it next: the window's next prompt not already claimed by
    /// a chat line is its echo or proof there is none.
    Idle,
    /// Typed into a RUNNING turn, so the CLI queued it behind that turn: no
    /// prompt may take it until the turn ends (`end_command_turn`).
    Queued,
}

impl CommandLife {
    fn code(self) -> i64 {
        match self {
            CommandLife::Idle => 1,
            CommandLife::Queued => 2,
        }
    }
    fn from_code(code: i64) -> Option<Self> {
        match code {
            1 => Some(CommandLife::Idle),
            2 => Some(CommandLife::Queued),
            _ => None,
        }
    }
}

impl Store {
    /// Append one observed event. Called on every hook, so it stays a single
    /// INSERT and its failure is the caller's to ignore. Returns the row id:
    /// a turn fact takes it as its order (board #249).
    pub fn insert_activity(
        &self,
        session: &str,
        window: &str,
        ts: u64,
        kind: &str,
        text: &str,
        tool: &str,
        via: &str,
        state: &str,
        deliveries: &str,
    ) -> Result<i64, String> {
        self.insert_activity_with(session, window, ts, kind, text, tool, via, state, deliveries, None)
    }

    /// `insert_activity` plus a prompt row's `requesters` (board #257, v27),
    /// in the SAME statement: the display text and the sender map commit
    /// together or not at all (validator 05:04 — a second UPDATE left a
    /// window where a durable prompt had no senders).
    #[allow(clippy::too_many_arguments)]
    pub fn insert_activity_with(
        &self,
        session: &str,
        window: &str,
        ts: u64,
        kind: &str,
        text: &str,
        tool: &str,
        via: &str,
        state: &str,
        deliveries: &str,
        requesters: Option<&str>,
    ) -> Result<i64, String> {
        // `window` (the INDEX column) is 0 for name-keyed rows; `win` carries
        // the identity (board #120). Old rows read back via the COALESCE below.
        self.conn
            .execute(
                "INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state, deliveries, requesters)
                 VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![session, window, ts as i64, kind, text, tool, via, state, deliveries, requesters],
            )
            .map(|_| self.conn.last_insert_rowid())
            .map_err(|e| format!("insert activity: {e}"))
    }

    /// Events newer than `since_ts` (ms, exclusive), oldest first. `limit` caps
    /// the NEWEST end: a first load wants the tail of a long history, not its
    /// head, so the rows are selected descending and then reversed.
    pub fn activity_since(
        &self,
        session: &str,
        since_ts: u64,
        limit: usize,
    ) -> Result<Vec<ActivityRow>, String> {
        self.activity_page(session, since_ts, None, limit).map(|(rows, _)| rows)
    }

    /// Visit the prompts newer than this window's last turn end, oldest
    /// first, and return how many were visited (0: the window has carried no
    /// input since its last end). STREAMED, one row at a time: rebuilding a
    /// turn's reply edge after a restart has to see every input — a newest-N
    /// page dropped the turn's FIRST requester once the turn held more than
    /// N (#256 review) — without holding a never-ending turn (grok, #252) in
    /// memory; the caller keeps only what it folds (distinct senders).
    /// `Some(n)` stops after n rows (the per-input "has this turn any input
    /// yet?" question asks for one).
    /// Test-only: every prompt row of a window as (text, requesters) — the
    /// raw columns, to prove the pair was written by one statement.
    #[cfg(test)]
    pub fn prompt_rows(&self, session: &str, window: &str) -> Result<Vec<(String, Option<String>)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT text, requesters FROM activity WHERE session = ?1 AND win = ?2 AND kind = 'prompt' ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![session, window], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn for_each_open_turn_prompt(
        &self,
        session: &str,
        window: &str,
        limit: Option<usize>,
        mut visit: impl FnMut(&str, Option<&str>),
    ) -> Result<usize, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT text, requesters FROM activity
                 WHERE session = ?1 AND COALESCE(NULLIF(win, ''), CAST(window AS TEXT)) = ?2 AND kind = 'prompt'
                   AND id > COALESCE((
                     SELECT MAX(id) FROM activity
                     WHERE session = ?1 AND COALESCE(NULLIF(win, ''), CAST(window AS TEXT)) = ?2 AND kind = 'notif'
                       AND text IN ('completed', 'failed', 'interrupted')
                   ), 0)
                 ORDER BY id LIMIT ?3",
            )
            .map_err(|e| format!("prepare open turn prompts: {e}"))?;
        // SQLite: a negative LIMIT is no limit.
        let mut rows = stmt
            .query(rusqlite::params![session, window, limit.map_or(-1, |n| n as i64)])
            .map_err(|e| format!("query open turn prompts: {e}"))?;
        let mut seen = 0;
        while let Some(row) = rows.next().map_err(|e| format!("read open turn prompts: {e}"))? {
            let text: String = row.get(0).map_err(|e| format!("read open turn prompt: {e}"))?;
            let stored: Option<String> = row.get(1).map_err(|e| format!("read open turn requesters: {e}"))?;
            visit(&text, stored.as_deref());
            seen += 1;
        }
        Ok(seen)
    }

    /// The newest persisted TURN FACT of each kind, per window (board #249):
    /// the latest `prompt`, `tool` call, `permission_required`/`input_required`
    /// ask and turn end (`completed`/`failed`/`interrupted`). Deciding whether
    /// the turn is open is NOT done here: a restart replays these into the
    /// window's record and `derive_from`, the one turn rule, decides (tenet 8).
    pub fn turn_facts(&self, session: &str) -> Result<Vec<TurnFacts>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT COALESCE(NULLIF(win, ''), CAST(window AS TEXT)) AS w,
                        MAX(CASE WHEN kind = 'prompt' THEN id END),
                        MAX(CASE WHEN kind = 'tool' THEN id END),
                        MAX(CASE WHEN kind = 'notif' AND text IN ('permission_required', 'input_required') THEN id END),
                        MAX(CASE WHEN kind = 'notif' AND text IN ('completed', 'failed', 'interrupted') THEN id END)
                 FROM activity WHERE session = ?1 AND kind IN ('prompt', 'tool', 'notif')
                 GROUP BY w",
            )
            .map_err(|e| format!("prepare turn facts: {e}"))?;
        let heads: Vec<(String, [Option<i64>; 4])> = stmt
            .query_map(rusqlite::params![session], |r| Ok((r.get(0)?, [r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?])))
            .map_err(|e| format!("query turn facts: {e}"))?
            .filter_map(Result::ok)
            .collect();
        let fact = |id: Option<i64>| -> Result<Option<TurnFact>, String> {
            let Some(id) = id else { return Ok(None) };
            self.conn
                .query_row("SELECT id, ts, text, tool FROM activity WHERE id = ?1", rusqlite::params![id], |r| {
                    Ok(TurnFact { id: r.get(0)?, ts: r.get::<_, i64>(1)? as u64, text: r.get(2)?, tool: r.get(3)? })
                })
                .optional()
                .map_err(|e| format!("read turn fact: {e}"))
        };
        heads
            .into_iter()
            .map(|(window, [p, t, a, e])| {
                Ok(TurnFacts { window, prompt: fact(p)?, tool: fact(t)?, ask: fact(a)?, end: fact(e)? })
            })
            .collect()
    }

    /// One page of the activity log, always returned OLDEST FIRST so a caller can
    /// append it to a feed without re-sorting.
    ///
    /// Three shapes, one query:
    /// * neither cursor — the newest `limit` rows (what a first load wants: the
    ///   END of a conversation, not its beginning);
    /// * `since_ts > 0` — the tail newer than it, which is the incremental poll;
    /// * `before` — the page strictly OLDER than that (ts, id) cursor, which is
    ///   how a client walks backwards through history it has not loaded yet.
    ///
    /// The cursor is (ts, id) rather than ts alone because event timestamps are
    /// milliseconds and a busy turn puts several rows in one millisecond — paging
    /// on ts alone would either skip them or loop on them. `id` is the rowid, so
    /// the `(session, ts)` index already orders by (ts, id) and the keyset
    /// comparison stays index-only.
    ///
    /// `has_more` reports whether anything older than the returned page exists,
    /// measured by asking for one row more than the caller wanted. Without it a
    /// client cannot tell "you have everything" from "your page happened to end
    /// exactly at the limit".
    pub fn activity_page(
        &self,
        session: &str,
        since_ts: u64,
        before: Option<(u64, i64)>,
        limit: usize,
    ) -> Result<(Vec<ActivityRow>, bool), String> {
        let (b_ts, b_id) = match before {
            Some((ts, id)) => (ts as i64, id),
            None => (i64::MAX, i64::MAX),
        };
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, COALESCE(NULLIF(win, ''), CAST(window AS TEXT)), ts, kind, text, tool, via, state, deliveries FROM activity
                 WHERE session = ?1 AND ts > ?2
                   AND (ts < ?3 OR (ts = ?3 AND id < ?4))
                 ORDER BY ts DESC, id DESC LIMIT ?5",
            )
            .map_err(|e| format!("prepare activity: {e}"))?;
        let rows = stmt
            .query_map(
                rusqlite::params![session, since_ts as i64, b_ts, b_id, limit as i64 + 1],
                |r| {
                    Ok(ActivityRow {
                        id: r.get(0)?,
                        window: r.get::<_, String>(1)?,
                        ts: r.get::<_, i64>(2)? as u64,
                        kind: r.get(3)?,
                        text: r.get(4)?,
                        tool: r.get(5)?,
                        via: r.get(6)?,
                        state: r.get(7)?,
                        deliveries: r.get(8)?,
                    })
                },
            )
            .map_err(|e| format!("query activity: {e}"))?;
        let mut out: Vec<ActivityRow> = rows.filter_map(Result::ok).collect();
        let has_more = out.len() > limit;
        out.truncate(limit);
        out.reverse();
        Ok((out, has_more))
    }

    /// How many events this session has ever recorded (and the whole log's oldest
    /// timestamp), for the storage audit and for a client that wants to say "3 of
    /// 4046 loaded".
    pub fn activity_stats(&self, session: &str) -> Result<(usize, u64, u64), String> {
        self.conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MIN(ts), 0), COALESCE(MAX(ts), 0)
                 FROM activity WHERE session = ?1",
                rusqlite::params![session],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)? as usize,
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, i64>(2)? as u64,
                    ))
                },
            )
            .map_err(|e| format!("activity stats: {e}"))
    }

    /// Keep the newest `keep` events of a session and forget the rest. A log
    /// nobody prunes is a log that eventually costs more than it is worth.
    pub fn prune_activity(&self, session: &str, keep: usize) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM activity WHERE session = ?1 AND id NOT IN
                   (SELECT id FROM activity WHERE session = ?1 ORDER BY id DESC LIMIT ?2)",
                rusqlite::params![session, keep as i64],
            )
            .map_err(|e| format!("prune activity: {e}"))
    }

    /// Remember a line we typed into a pane: the ONE pending-delivery queue
    /// (board #249). Its `userPromptSubmit` echo settles the row; a plain
    /// INSERT (board #122), because the same line delivered again is a new
    /// promise with its own echo.
    pub fn insert_delivery(
        &self,
        session: &str,
        window: &str,
        line: &str,
        ask_at: usize,
        ts: u64,
        msg_id: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO deliveries (session, win, line, ts, msg_id, ask_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![session, window, line, ts as i64, msg_id, ask_at as i64],
            )
            .map(|_| ())
            .map_err(|e| format!("insert delivery: {e}"))
    }

    /// A slash command's expected echo, about to be typed (board #264). Its
    /// id comes back so a pane that refuses the typing can take it away.
    pub fn insert_command_delivery(&self, session: &str, window: &str, line: &str, ts: u64, msg_id: &str, life: CommandLife) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO deliveries (session, win, line, ts, msg_id, command) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![session, window, line, ts as i64, msg_id, life.code()],
            )
            .map(|_| self.conn.last_insert_rowid())
            .map_err(|e| format!("insert command delivery: {e}"))
    }

    /// A turn end's step on a window's command rows, ONE transaction
    /// (board #264, orchestrator 11:51): when `retire`, the oldest Idle
    /// command row goes (one row, never the rows behind it); THEN every
    /// Queued row becomes Idle. Returns whether a row was retired.
    pub fn end_command_turn(&mut self, session: &str, window: &str, retire: bool) -> Result<bool, String> {
        let tx = self.conn.transaction().map_err(|e| format!("command end transaction: {e}"))?;
        let retired = if retire {
            tx.execute(
                "DELETE FROM deliveries WHERE id = (SELECT MIN(id) FROM deliveries WHERE session = ?1 AND win = ?2 AND command = 1)",
                rusqlite::params![session, window],
            )
            .map_err(|e| format!("retire idle command: {e}"))?
                > 0
        } else {
            false
        };
        tx.execute(
            "UPDATE deliveries SET command = 1 WHERE session = ?1 AND win = ?2 AND command = 2",
            rusqlite::params![session, window],
        )
        .map_err(|e| format!("promote queued commands: {e}"))?;
        tx.commit().map_err(|e| format!("commit command end: {e}"))?;
        Ok(retired)
    }

    /// Put one command row back behind the turn that just opened (board #264).
    pub fn requeue_command(&self, id: i64) -> Result<bool, String> {
        self.conn
            .execute("UPDATE deliveries SET command = 2 WHERE id = ?1 AND command = 1", rusqlite::params![id])
            .map(|n| n > 0)
            .map_err(|e| format!("requeue command: {e}"))
    }

    /// A line for a busy queue-mode agent, stored but NOT typed yet (board
    /// #257). Invisible to the echo match and the sweep until
    /// `set_deliveries_held(…, false, …)` marks it typed.
    pub fn insert_held_delivery(&self, session: &str, window: &str, line: &str, ask_at: usize, ts: u64, msg_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO deliveries (session, win, line, ts, msg_id, held, ask_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                rusqlite::params![session, window, line, ts as i64, msg_id, ask_at as i64],
            )
            .map(|_| ())
            .map_err(|e| format!("insert held delivery: {e}"))
    }

    /// A window's held lines, oldest first. `warned` here means the one
    /// "held (pane in copy mode)" report was already made for the row.
    pub fn held_deliveries(&self, session: &str, window: &str) -> Result<Vec<DeliveryRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, win, line, ts, msg_id, warned, command, ask_at FROM deliveries
                 WHERE session = ?1 AND win = ?2 AND held = 1 ORDER BY id",
            )
            .map_err(|e| format!("prepare held deliveries: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![session, window], |r| {
                Ok(DeliveryRow {
                    id: r.get(0)?,
                    window: r.get(1)?,
                    line: r.get(2)?,
                    ts: r.get::<_, i64>(3)? as u64,
                    msg_id: r.get(4)?,
                    warned: r.get::<_, i64>(5)? != 0,
                    command: CommandLife::from_code(r.get::<_, i64>(6)?),
                    ask_at: r.get::<_, i64>(7)?.try_into().unwrap_or(0),
                })
            })
            .map_err(|e| format!("query held deliveries: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Sessions that hold at least one untyped line (the server-start flush).
    pub fn held_sessions(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT session FROM deliveries WHERE held = 1 ORDER BY session")
            .map_err(|e| format!("prepare held sessions: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| format!("query held sessions: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Windows of a session that hold at least one untyped line.
    pub fn held_windows(&self, session: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT win FROM deliveries WHERE session = ?1 AND held = 1 ORDER BY win")
            .map_err(|e| format!("prepare held windows: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![session], |r| r.get(0))
            .map_err(|e| format!("query held windows: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Mark a batch typed (`held = false`: its ack clock starts at `ts`, and
    /// a copy-mode report made while it was held is cleared) or back to held
    /// (the typing failed). ONE transaction for the whole batch (validator /
    /// orchestrator 04:49): either every row flips or none does, so a batch
    /// is never half pending and half held — the held half would be typed
    /// again at the next trigger while the echo could not settle it. A row
    /// that no longer exists (settled or pruned meanwhile) is an error too:
    /// the caller then types nothing.
    pub fn set_deliveries_held(&mut self, ids: &[i64], held: bool, ts: u64) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| format!("delivery batch transaction: {e}"))?;
        for id in ids {
            let n = if held {
                tx.execute("UPDATE deliveries SET held = 1 WHERE id = ?1 AND held = 0", rusqlite::params![id])
            } else {
                tx.execute("UPDATE deliveries SET held = 0, warned = 0, ts = ?2 WHERE id = ?1 AND held = 1", rusqlite::params![id, ts as i64])
            }
            .map_err(|e| format!("set delivery held: {e}"))?;
            if n != 1 {
                return Err(format!("delivery {id} is not {}", if held { "pending" } else { "held" }));
            }
        }
        tx.commit().map_err(|e| format!("commit delivery batch: {e}"))
    }

    /// Delete a batch of HELD rows in one transaction (#276: steered into a
    /// running turn, owed no echo). Every id must still be held, else nothing
    /// changes.
    pub fn delete_held_deliveries(&mut self, ids: &[i64]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| format!("delivery retire transaction: {e}"))?;
        for id in ids {
            let n = tx
                .execute("DELETE FROM deliveries WHERE id = ?1 AND held = 1", rusqlite::params![id])
                .map_err(|e| format!("retire held delivery: {e}"))?;
            if n != 1 {
                return Err(format!("delivery {id} is not held"));
            }
        }
        tx.commit().map_err(|e| format!("commit delivery retire: {e}"))
    }

    /// Outstanding TYPED lines, in the order they were typed (row id). Held
    /// lines (board #257) are not outstanding yet: nothing was typed, so no
    /// echo can carry them and the sweep has nothing to report. `window`
    /// narrows it to one window; `None` is the whole session, which is what
    /// the sweep asks for.
    pub fn pending_deliveries(
        &self,
        session: &str,
        window: Option<&str>,
    ) -> Result<Vec<DeliveryRow>, String> {
        let (sql, args): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match window {
            Some(w) => (
                "SELECT id, win, line, ts, msg_id, warned, command, ask_at FROM deliveries
                 WHERE session = ?1 AND win = ?2 AND held = 0 ORDER BY id",
                vec![Box::new(session.to_string()), Box::new(w.to_string())],
            ),
            None => (
                "SELECT id, win, line, ts, msg_id, warned, command, ask_at FROM deliveries WHERE session = ?1 AND held = 0 ORDER BY id",
                vec![Box::new(session.to_string())],
            ),
        };
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| format!("prepare deliveries: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
                Ok(DeliveryRow {
                    id: r.get(0)?,
                    window: r.get(1)?,
                    line: r.get(2)?,
                    ts: r.get::<_, i64>(3)? as u64,
                    msg_id: r.get(4)?,
                    warned: r.get::<_, i64>(5)? != 0,
                    command: CommandLife::from_code(r.get::<_, i64>(6)?),
                    ask_at: r.get::<_, i64>(7)?.try_into().unwrap_or(0),
                })
            })
            .map_err(|e| format!("query deliveries: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// A line is settled — acknowledged by its echo, or reported as
    /// unconfirmed. By ROW, so a duplicate body's sibling stays outstanding.
    /// Report a row once: true only for the call that flipped it (board #249).
    pub fn mark_delivery_warned(&self, id: i64) -> Result<bool, String> {
        self.conn
            .execute("UPDATE deliveries SET warned = 1 WHERE id = ?1 AND warned = 0", rusqlite::params![id])
            .map(|n| n > 0)
            .map_err(|e| format!("mark delivery warned: {e}"))
    }

    /// The newest activity row id, 0 for none. Row ids only grow, so turn
    /// facts ordered by it keep their order across a restart (board #249).
    pub fn max_activity_id(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT COALESCE(MAX(id), 0) FROM activity", [], |r| r.get(0))
            .map_err(|e| format!("max activity id: {e}"))
    }

    /// The newest delivery row of a session, 0 for none (board #249: the
    /// recovery mark between rows an earlier process typed and ours).
    pub fn max_delivery_id(&self, session: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM deliveries WHERE session = ?1",
                rusqlite::params![session],
                |r| r.get(0),
            )
            .map_err(|e| format!("max delivery id: {e}"))
    }

    /// Test-only: run SQL on the store's own connection (a temp trigger that
    /// makes an INSERT really fail, board #249).
    #[cfg(test)]
    pub fn exec_test_sql(&self, sql: &str) -> Result<(), String> {
        self.conn.execute_batch(sql).map_err(|e| e.to_string())
    }

    /// Test-only: pretend every outstanding row of a session was typed at `ts`.
    #[cfg(test)]
    pub fn backdate_deliveries(&self, session: &str, ts: u64) -> Result<usize, String> {
        self.conn
            .execute("UPDATE deliveries SET ts = ?1 WHERE session = ?2", rusqlite::params![ts as i64, session])
            .map_err(|e| e.to_string())
    }

    pub fn delete_one_delivery(&self, session: &str, window: &str, line: &str) -> Result<bool, String> {
        self.conn
            .execute(
                "DELETE FROM deliveries WHERE id = (
                   SELECT id FROM deliveries
                   WHERE session = ?1 AND win = ?2 AND line = ?3
                   ORDER BY id LIMIT 1
                 )",
                rusqlite::params![session, window, line],
            )
            .map(|n| n > 0)
            .map_err(|e| format!("delete one delivery: {e}"))
    }

    pub fn delete_delivery_id(&self, id: i64) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM deliveries WHERE id = ?1", rusqlite::params![id])
            .map(|n| n > 0)
            .map_err(|e| format!("delete delivery: {e}"))
    }

    /// Forget every outstanding line of a window (it no longer exists, so it can
    /// never ack) or of a whole session.
    pub fn clear_deliveries(&self, session: &str, window: Option<&str>) -> Result<usize, String> {
        match window {
            Some(w) => self.conn.execute(
                "DELETE FROM deliveries WHERE session = ?1 AND win = ?2",
                rusqlite::params![session, w],
            ),
            None => self
                .conn
                .execute("DELETE FROM deliveries WHERE session = ?1", rusqlite::params![session]),
        }
        .map_err(|e| format!("clear deliveries: {e}"))
    }

    /// Drop lines typed before `cutoff`. A delivery nobody ever acked is not
    /// worth resurrecting days later — the agent that would have echoed it is
    /// long gone — and this keeps the table bounded without a sweep of its own.
    /// A HELD line (board #257) was never typed: its `ts` is when it was held,
    /// and it is still owed, so the prune never touches it (validator: a 24 h
    /// copy-mode stretch or turn would otherwise drop it silently).
    pub fn prune_deliveries(&self, cutoff: u64) -> Result<usize, String> {
        self.conn
            .execute("DELETE FROM deliveries WHERE ts < ?1 AND held = 0", rusqlite::params![cutoff as i64])
            .map_err(|e| format!("prune deliveries: {e}"))
    }
}

#[cfg(test)]
mod tests {

    /// Board #257 review: the 24 h prune drops stale TYPED lines and never a
    /// HELD one, however old.
    #[test]
    fn the_prune_never_drops_a_held_line() {
        let store = Store::open_memory().unwrap();
        store.insert_delivery("s", "w", "old typed", 0, 100, "").unwrap();
        store.insert_held_delivery("s", "w", "old held", 0, 100, "").unwrap();
        store.insert_delivery("s", "w", "new typed", 0, 10_000, "").unwrap();
        assert_eq!(store.prune_deliveries(5_000).unwrap(), 1);
        assert_eq!(store.held_deliveries("s", "w").unwrap().iter().map(|r| r.line.as_str()).collect::<Vec<_>>(), vec!["old held"]);
        assert_eq!(store.pending_deliveries("s", Some("w")).unwrap().iter().map(|r| r.line.as_str()).collect::<Vec<_>>(), vec!["new typed"]);
    }
    use super::*;

    /// The durable half of the delivery receipt (board #5). The rows outlive the
    /// process that typed the lines, so the SQL has to answer three questions:
    /// what is still outstanding for a window, what for a whole session (the
    /// sweep's question), and nothing at all for a neighbouring session.
    #[test]
    fn outstanding_deliveries_are_kept_per_window_and_settle_once() {
        let store = Store::open_memory().unwrap();
        store.insert_delivery("s", "w1", "hello", 0, 100, "").unwrap();
        // Delivering the same body again is a SECOND promise with its own row
        // (board #122): the pane was typed into twice, two echoes are coming,
        // and each settles one row, oldest first.
        store.insert_delivery("s", "w1", "hello", 0, 150, "").unwrap();
        store.insert_delivery("s", "w2", "other", 0, 120, "").unwrap();
        store.insert_delivery("t", "w1", "elsewhere", 0, 130, "").unwrap();

        let triple = |rows: Vec<DeliveryRow>| rows.into_iter().map(|r| (r.window, r.line, r.ts)).collect::<Vec<_>>();
        let all = store.pending_deliveries("s", None).unwrap();
        assert_eq!(triple(all.clone()), vec![
            ("w1".to_string(), "hello".to_string(), 100),
            ("w1".to_string(), "hello".to_string(), 150),
            ("w2".to_string(), "other".to_string(), 120),
        ]);
        assert!(all.windows(2).all(|p| p[0].id < p[1].id), "typed order is row order");
        assert_eq!(store.pending_deliveries("s", Some("w2")).unwrap().len(), 1);
        assert_eq!(store.pending_deliveries("t", None).unwrap().len(), 1, "sessions never cross");

        // Each echo settles ONE row, oldest first; leaving past the last is
        // not an error.
        assert!(store.delete_one_delivery("s", "w1", "hello").unwrap());
        assert_eq!(triple(store.pending_deliveries("s", Some("w1")).unwrap()), vec![("w1".to_string(), "hello".to_string(), 150)], "the older row went first");
        assert!(store.delete_one_delivery("s", "w1", "hello").unwrap());
        assert!(!store.delete_one_delivery("s", "w1", "hello").unwrap());
        // A window that no longer exists can never echo: drop its whole queue.
        assert_eq!(store.clear_deliveries("s", Some("w2")).unwrap(), 1);
        assert!(store.pending_deliveries("s", None).unwrap().is_empty());

        // The recovery horizon: a line nobody ever acked is forgotten rather
        // than resurrected days later, and the fresh one stays.
        store.insert_delivery("t", "w2", "ancient", 0, 10, "").unwrap();
        assert_eq!(store.prune_deliveries(100).unwrap(), 1);
        assert_eq!(store.pending_deliveries("t", None).unwrap().len(), 1);
    }

    /// Board #249: a delivery row carries its chat message id and settles by
    /// ROW id, so one of two identical bodies can settle while its sibling
    /// stays; an activity event keeps the ROWS it is about as `{id, msg?}` —
    /// the row id is the key, the message id only rides along.
    #[test]
    fn deliveries_carry_their_message_and_settle_by_row() {
        let store = Store::open_memory().unwrap();
        store.insert_delivery("s", "w1", "same", 0, 100, "m1").unwrap();
        store.insert_delivery("s", "w1", "same", 0, 101, "m2").unwrap();
        store.insert_delivery("s", "w1", "notice", 0, 102, "").unwrap();
        let rows = store.pending_deliveries("s", Some("w1")).unwrap();
        assert_eq!(rows.iter().map(|r| r.msg_id.as_str()).collect::<Vec<_>>(), vec!["m1", "m2", ""]);
        assert!(store.delete_delivery_id(rows[1].id).unwrap(), "the second of two identical bodies");
        assert!(!store.delete_delivery_id(rows[1].id).unwrap(), "settling twice is a no-op");
        let left = store.pending_deliveries("s", Some("w1")).unwrap();
        assert_eq!(left.iter().map(|r| r.msg_id.as_str()).collect::<Vec<_>>(), vec!["m1", ""]);

        let refs = format!(r#"[{{"id":{},"msg":"m1"}}]"#, left[0].id);
        store.insert_activity("s", "w1", 1000, "prompt", "same", "", "app", "", &refs).unwrap();
        store.insert_activity("s", "w1", 1001, "prompt", "typed", "", "local", "", "").unwrap();
        let evs = store.activity_since("s", 0, 10).unwrap();
        assert_eq!(evs.iter().map(|e| e.deliveries.as_str()).collect::<Vec<_>>(), vec![refs.as_str(), ""]);
        // Reported once: only the first call flips the mark, and the row stays.
        assert!(store.mark_delivery_warned(left[0].id).unwrap());
        assert!(!store.mark_delivery_warned(left[0].id).unwrap());
        let after = store.pending_deliveries("s", Some("w1")).unwrap();
        assert_eq!(after.iter().map(|r| r.warned).collect::<Vec<_>>(), vec![true, false], "warned, still outstanding");
    }

    #[test]
    fn the_activity_log_survives_and_stays_bounded() {
        let store = Store::open_memory().unwrap();
        let first = store.insert_activity("s0", "w1", 1, "prompt", "p", "", "", "", "").unwrap();
        let second = store.insert_activity("s0", "w1", 1, "notif", "completed", "", "", "", "").unwrap();
        assert!(second > first, "the returned row id is the insertion order (board #249)");
        for n in 0..5u64 {
            store
                .insert_activity("s1", "w3", 1000 + n, "tool", &format!("file{n}.rs"), "Edit", "", "", "")
                .unwrap();
        }
        // Another session's rows never leak into this one's feed.
        store.insert_activity("s2", "w1", 1002, "tool", "other.rs", "Read", "", "", "").unwrap();

        let all = store.activity_since("s1", 0, 100).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all.first().unwrap().ts, 1000, "oldest first");
        assert_eq!(all.last().unwrap().ts, 1004);
        assert_eq!(all[0].kind, "tool");
        assert_eq!(all[0].tool, "Edit", "the tool name is kept apart from its detail");

        // `since_ts` is exclusive — the client's cursor must not replay a row.
        let tail = store.activity_since("s1", 1002, 100).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].ts, 1003);

        // A limit takes the NEWEST rows: a first load wants the tail of a long
        // history, not its beginning.
        let capped = store.activity_since("s1", 0, 2).unwrap();
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0].ts, 1003);
        assert_eq!(capped[1].ts, 1004);

        // Pruning is no longer automatic (board #9: nothing is thrown away unless
        // a retention was asked for), but it remains the primitive that a
        // configured retention uses — newest kept, other sessions untouched.
        let dropped = store.prune_activity("s1", 2).unwrap();
        assert_eq!(dropped, 3);
        let left = store.activity_since("s1", 0, 100).unwrap();
        assert_eq!(left.len(), 2);
        assert_eq!(left[0].ts, 1003);
        assert_eq!(store.activity_since("s2", 0, 100).unwrap().len(), 1);
    }

    #[test]
    fn open_turn_prompts_survive_the_server_process() {
        let store = Store::open_memory().unwrap();
        let all = |limit: Option<usize>| {
            let mut out = Vec::new();
            let n = store.for_each_open_turn_prompt("s", "w2", limit, |t, _| out.push(t.to_string())).unwrap();
            assert_eq!(n, out.len());
            out
        };
        store.insert_activity("s", "w2", 900, "prompt", "[tmm chat] old: closed turn", "", "app", "", "").unwrap();
        store.insert_activity("s", "w2", 1000, "notif", "completed", "", "", "", "").unwrap();
        store.insert_activity("s", "w2", 1100, "prompt", "[tmm chat] lead: work", "", "app", "", "").unwrap();
        store.insert_activity("s", "w2", 1200, "tool", "file.rs", "Edit", "", "", "").unwrap();
        store.insert_activity("s", "w2", 1250, "prompt", "[tmm chat] peer: [reply] fyi", "", "app", "", "").unwrap();
        // Every input of the OPEN turn, oldest first; the closed turn's is not.
        assert_eq!(
            all(None),
            vec!["[tmm chat] lead: work".to_string(), "[tmm chat] peer: [reply] fyi".to_string()]
        );
        // The bound stops early (oldest first).
        assert_eq!(all(Some(1)), vec!["[tmm chat] lead: work".to_string()]);
        store.insert_activity("s", "w2", 1300, "notif", "completed", "", "", "", "").unwrap();
        assert!(all(None).is_empty());

        // #256 review: an open turn of 200 inputs comes back WHOLE, so the
        // first requester survives recovery; Some(1) reads just one row.
        store.insert_activity("s", "w2", 2000, "prompt", "[tmm chat] orchestrator: request", "", "app", "", "").unwrap();
        for i in 0..199 {
            store.insert_activity("s", "w2", 2001 + i, "prompt", &format!("[tmm chat] builder: [reply] {i}"), "", "app", "", "").unwrap();
        }
        let whole = all(None);
        assert_eq!(whole.len(), 200);
        assert_eq!(whole[0], "[tmm chat] orchestrator: request");
        assert_eq!(whole[199], "[tmm chat] builder: [reply] 198");
        assert_eq!(all(Some(1)), vec!["[tmm chat] orchestrator: request".to_string()]);
    }

    /// Paging backwards through a complete log (board #9). The cursor is (ts, id)
    /// because a busy turn writes several events inside ONE millisecond: a
    /// ts-only cursor either skips them or loops on them for ever.
    #[test]
    fn the_activity_log_pages_backwards_without_losing_a_millisecond_tie() {
        let store = Store::open_memory().unwrap();
        // Six events, and three of them share ts 1002 — the shape a real turn has.
        for (n, ts) in [1000u64, 1001, 1002, 1002, 1002, 1003].into_iter().enumerate() {
            store.insert_activity("s", "w1", ts, "tool", &format!("e{n}"), "Edit", "", "", "").unwrap();
        }
        assert_eq!(store.activity_stats("s").unwrap(), (6, 1000, 1003));

        // The newest page, oldest first, and there IS more behind it.
        let (page1, more1) = store.activity_page("s", 0, None, 2).unwrap();
        assert!(more1, "four older events remain");
        assert_eq!(page1.iter().map(|r| r.text.clone()).collect::<Vec<_>>(), vec!["e4", "e5"]);

        // Walk back with the page's own oldest row as the cursor. The tie at 1002
        // is respected: e3 comes next, not e1 and not e4 again.
        let cur = |p: &Vec<ActivityRow>| (p[0].ts, p[0].id);
        let (page2, more2) = store.activity_page("s", 0, Some(cur(&page1)), 2).unwrap();
        assert!(more2);
        assert_eq!(page2.iter().map(|r| r.text.clone()).collect::<Vec<_>>(), vec!["e2", "e3"]);
        let (page3, more3) = store.activity_page("s", 0, Some(cur(&page2)), 2).unwrap();
        assert_eq!(page3.iter().map(|r| r.text.clone()).collect::<Vec<_>>(), vec!["e0", "e1"]);
        assert!(!more3, "the whole log has been walked, and it says so");

        // Every row appeared exactly once — the property a lazy-loading client
        // depends on (no duplicates to dedupe, no gaps to explain).
        let mut seen: Vec<String> =
            [page1, page2, page3].concat().into_iter().map(|r| r.text).collect();
        seen.sort();
        assert_eq!(seen, vec!["e0", "e1", "e2", "e3", "e4", "e5"]);

        // A cursor with no id tiebreak means "just before that whole millisecond".
        let (before_ms, _) = store.activity_page("s", 0, Some((1002, 0)), 10).unwrap();
        assert_eq!(before_ms.iter().map(|r| r.text.clone()).collect::<Vec<_>>(), vec!["e0", "e1"]);

        // `since_ts` and `before` compose: the window between two cursors. The
        // cursor is EXCLUSIVE on the pair, so the newest row's own (ts, id)
        // excludes exactly itself.
        let head = store.activity_page("s", 0, None, 1).unwrap().0;
        let (window, _) =
            store.activity_page("s", 1000, Some((head[0].ts, head[0].id)), 10).unwrap();
        assert_eq!(window.len(), 4, "1001 and the three 1002s");
    }

    /// The same walk at VOLUME, past the per-page ceiling: 2500 events, pages of
    /// 250. A page cap is not a history horizon — the trace is kept whole, so a
    /// client must be able to reach all of it, and reach each row exactly once.
    #[test]
    fn the_activity_log_walks_past_the_page_ceiling_without_a_gap() {
        let mut store = Store::open_memory().unwrap();
        const TOTAL: usize = 2500;
        let tx = store.conn.transaction().unwrap();
        for n in 0..TOTAL {
            // Deliberately coarse timestamps: 5 events per millisecond, so the
            // walk is forced through same-ms ties on nearly every page boundary.
            tx.execute(
                "INSERT INTO activity (session, window, ts, kind, text, tool, via, state)
                 VALUES ('s', 1, ?1, 'tool', ?2, 'Edit', '', '')",
                rusqlite::params![1_000 + (n as i64) / 5, format!("e{n}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(store.activity_stats("s").unwrap().0, TOTAL);

        let mut cursor: Option<(u64, i64)> = None;
        let mut seen: Vec<String> = Vec::new();
        let mut pages = 0;
        loop {
            let (page, has_more) = store.activity_page("s", 0, cursor, 250).unwrap();
            if page.is_empty() {
                break;
            }
            pages += 1;
            assert!(page.len() <= 250);
            // Oldest first, and strictly older than the cursor we came from.
            assert!(page.windows(2).all(|w| (w[0].ts, w[0].id) < (w[1].ts, w[1].id)));
            if let Some((cts, cid)) = cursor {
                let last = page.last().unwrap();
                assert!((last.ts, last.id) < (cts, cid), "page {pages} overlapped its cursor");
            }
            cursor = Some((page[0].ts, page[0].id));
            let mut older: Vec<String> = page.into_iter().map(|r| r.text).collect();
            older.append(&mut seen);
            seen = older;
            if !has_more {
                break;
            }
        }
        assert_eq!(pages, 10, "2500 rows in pages of 250");
        assert_eq!(seen.len(), TOTAL, "every event exactly once — no duplicate, no hole");
        let expected: Vec<String> = (0..TOTAL).map(|n| format!("e{n}")).collect();
        assert_eq!(seen, expected, "and the walk reassembles the log in order");
    }
}
