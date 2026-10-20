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

/// What one unconfirmed report wrote (`Store::report_unconfirmed`, board
/// #437): the feed's warn row and, when it had one to write, the room line.
#[derive(Debug, Clone)]
pub struct Unconfirmed {
    pub activity_id: i64,
    pub ts: u64,
    pub message: Option<HubMsg>,
}

/// The activity row of a settled prompt (`Store::settle_prompt`); its `ts`
/// is the store's stamp, handed to the builder.
pub struct PromptRow {
    pub session: String,
    pub window: String,
    pub text: String,
    pub via: String,
    pub deliveries: String,
    pub requesters: Option<String>,
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

/// The `meta` key of the durable fact "person-needed paint `sig` (its
/// `<shape>|<Request ID>`) of `window` was accepted" (board #362 c), whose
/// value is the activity row id of the exact end it belongs to. ONE fact
/// per paint, kept for good (orchestrator's ruling on accepted-once): no
/// set with a capacity, because a paint evicted from it could end a later
/// turn when it is the newest on the screen again. Sessions and agent names
/// hold no ':' (`slug`, `agents::valid_name`).
pub fn person_paint_key(session: &str, window: &str, sig: &str) -> String {
    format!("{}{sig}", person_paint_prefix(session, Some(window)))
}

/// The key prefix of every such fact of a session, or of one window in it.
pub fn person_paint_prefix(session: &str, window: Option<&str>) -> String {
    match window {
        Some(w) => format!("person_paint:{session}:{w}:"),
        None => format!("person_paint:{session}:"),
    }
}

/// Test-only: runs once inside the next `publish_activity`, after its stamp
/// and before its INSERT — inside the store's write section (board #414).
#[cfg(test)]
static IN_PUBLISH_HOOK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

/// The wall clock in ms: what an observed activity row is stamped from.
pub(super) fn wall_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Store {
    /// The activity log's ordering rule (board #414), ONE place: an observed
    /// row's `ts` is `max(clock, high-water + 1)`, taken inside the store's
    /// write section (the caller holds the one store lock across the stamp
    /// and its INSERT), so `ts` rises strictly in INSERT order across EVERY
    /// writer — turn facts, the numbered prompt and missed-end transactions,
    /// warns, steered rows — and a tail from any cursor it handed out
    /// (`since_ts`, exclusive) sees every row published after it. A stamp
    /// whose INSERT then fails leaves a gap, never a duplicate.
    fn stamp_activity(&self) -> u64 {
        let ts = (self.activity_clock)().max(self.activity_hw.get() + 1);
        self.activity_hw.set(ts);
        ts
    }

    /// Where the high-water starts: the newest `ts` the log holds, read once
    /// at open, so a restart — or a wall clock that stepped back — never
    /// stamps a row behind one a client already holds.
    pub(super) fn seed_activity_hw(&self) -> Result<(), String> {
        let max: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(ts), 0) FROM activity", [], |r| r.get(0))
            .map_err(|e| format!("activity high-water: {e}"))?;
        self.activity_hw.set(max.max(0) as u64);
        Ok(())
    }

    /// Test-only: the clock `stamp_activity` reads, and back to the wall.
    #[cfg(test)]
    pub fn set_activity_clock(&mut self, clock: impl Fn() -> u64 + Send + 'static) {
        self.activity_clock = Box::new(clock);
    }
    #[cfg(test)]
    pub fn reset_activity_clock(&mut self) {
        self.activity_clock = Box::new(wall_ms);
    }
    /// Test-only: `f` runs once inside the next `publish_activity`, after
    /// its stamp and before its INSERT (`IN_PUBLISH_HOOK`).
    #[cfg(test)]
    pub fn hold_next_publish(f: Box<dyn FnOnce() + Send>) {
        *IN_PUBLISH_HOOK.lock().unwrap() = Some(f);
    }
    #[cfg(test)]
    pub fn activity_high_water(&self) -> u64 {
        self.activity_hw.get()
    }

    /// Publish one OBSERVED event: the store stamps it (`stamp_activity`)
    /// and returns that `ts` — the one time the live record, the ring and
    /// the log all carry — with the row id, or the INSERT's error. The stamp
    /// is returned EITHER WAY (board #414 review P1, round 3): a fact whose
    /// write failed keeps the time the store gave it, so a fail-soft live
    /// update never falls back to an earlier clock and undoes a later fact.
    /// Called on every hook, so it stays a single INSERT and its failure is
    /// the caller's to ignore. A prompt row's `requesters` ride in the SAME
    /// statement (board #257, v27): the display text and the sender map
    /// commit together or not at all.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_activity(
        &self,
        session: &str,
        window: &str,
        kind: &str,
        text: &str,
        tool: &str,
        via: &str,
        state: &str,
        deliveries: &str,
        requesters: Option<&str>,
    ) -> (u64, Result<i64, String>) {
        let ts = self.stamp_activity();
        #[cfg(test)]
        if let Some(hook) = IN_PUBLISH_HOOK.lock().unwrap().take() {
            hook();
        }
        (ts, self.insert_row(session, window, ts, kind, text, tool, via, state, deliveries, requesters))
    }

    /// A HISTORICAL row at a time its caller names (a test's chosen time):
    /// never stamped, and outside the cursor contract — it may sit behind or
    /// ahead of a cursor already handed out, and it does not move this
    /// process's high-water (a test's simulated timeline five minutes ahead
    /// must not stamp every later observed row there). TEST-ONLY, by the
    /// compiler (board #414 review P2-A): no build that ships can date a row.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_dated_activity(
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
        self.insert_dated_activity_with(session, window, ts, kind, text, tool, via, state, deliveries, None)
    }

    /// `insert_dated_activity` with a prompt row's `requesters`.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_dated_activity_with(
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
        self.insert_row(session, window, ts, kind, text, tool, via, state, deliveries, requesters)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_row(
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

    /// A turn end recorded from the SCREEN (board #362 c, review P1-E on
    /// f998b599) and, when the paint has a global identity, its acceptance
    /// fact, in ONE transaction: the `notif failed` row (its `tool` the
    /// detail), then `meta` `accept_key` = that row's id. Both or neither: a
    /// fact with no end would make a restart skip a turn that never ended,
    /// and an end with no fact would let the same paint end a later turn.
    /// The end's row id. Real hook telemetry stays fail-soft and outside this.
    /// Its `ts` is the store's stamp (`stamp_activity`), returned with the
    /// row id.
    pub fn insert_missed_end(&mut self, session: &str, window: &str, detail: &str, accept_key: Option<&str>) -> Result<(i64, u64), String> {
        let ts_ms = self.stamp_activity();
        self.missed_end_at(session, window, ts_ms, detail, accept_key)
    }

    /// `insert_missed_end` at a time its caller names (`insert_dated_activity`'s
    /// terms). Test-only.
    #[cfg(test)]
    pub fn insert_dated_missed_end(&mut self, session: &str, window: &str, ts_ms: u64, detail: &str, accept_key: Option<&str>) -> Result<(i64, u64), String> {
        self.missed_end_at(session, window, ts_ms, detail, accept_key)
    }

    fn missed_end_at(&mut self, session: &str, window: &str, ts_ms: u64, detail: &str, accept_key: Option<&str>) -> Result<(i64, u64), String> {
        let tx = self.conn.transaction().map_err(|e| format!("missed end transaction: {e}"))?;
        tx.execute(
            "INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state, deliveries, requesters)
             VALUES (?1, 0, ?2, ?3, 'notif', 'failed', ?4, '', '', '', NULL)",
            rusqlite::params![session, window, ts_ms as i64, detail],
        )
        .map_err(|e| format!("insert missed end: {e}"))?;
        let row = tx.last_insert_rowid();
        if let Some(key) = accept_key {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, row.to_string()],
            )
            .map_err(|e| format!("accept missed end: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit missed end: {e}"))?;
        Ok((row, ts_ms))
    }

    /// Forget the accepted person-needed paints of ONE agent's identity
    /// (board #362, orchestrator's ruling on accepted-once): called only when
    /// that identity is explicitly removed (`agent_remove`), never on a stop,
    /// a restart or a window missing from one tmux listing. Another agent's
    /// records, a name that merely starts with this one included, are kept.
    pub fn forget_person_paints(&self, session: &str, window: &str) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM meta WHERE substr(key, 1, length(?1)) = ?1",
                rusqlite::params![person_paint_prefix(session, Some(window))],
            )
            .map_err(|e| format!("forget person paints: {e}"))
    }

    /// Every session the activity log holds a row for (board #394: the
    /// sessions a server start replays, `telemetry::recover_on_start`). Read
    /// off the `(session, ts)` index.
    pub fn activity_sessions(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT session FROM activity ORDER BY session")
            .map_err(|e| format!("prepare activity sessions: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| format!("query activity sessions: {e}"))?;
        rows.collect::<Result<Vec<String>, _>>().map_err(|e| format!("read activity sessions: {e}"))
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
        // A head row that cannot be decoded fails the whole read (board #394
        // review P1): dropping it would replay the session without that
        // window and call the replay complete.
        let heads: Vec<(String, [Option<i64>; 4])> = stmt
            .query_map(rusqlite::params![session], |r| Ok((r.get(0)?, [r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?])))
            .map_err(|e| format!("query turn facts: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("read turn facts: {e}"))?;
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
        self.delivery_rows(sql, args)
    }

    /// The rows of `session` the unconfirmed sweep may still report (board
    /// #437 review P2): typed chat lines not yet warned — what the partial
    /// index `deliveries_unreported` holds — so a sweep never loads the
    /// warned or command rows again.
    pub fn unreported_deliveries(&self, session: &str) -> Result<Vec<DeliveryRow>, String> {
        self.delivery_rows(
            "SELECT id, win, line, ts, msg_id, warned, command, ask_at FROM deliveries
             WHERE session = ?1 AND warned = 0 AND held = 0 AND command = 0 ORDER BY id",
            vec![Box::new(session.to_string())],
        )
    }

    fn delivery_rows(&self, sql: &str, args: Vec<Box<dyn rusqlite::ToSql>>) -> Result<Vec<DeliveryRow>, String> {
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

    /// The sessions holding a typed chat line not yet reported (board #437):
    /// what the capture tick sweeps. Warned, held and command rows are never
    /// asked about again.
    pub fn sessions_with_unreported_deliveries(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT session FROM deliveries WHERE warned = 0 AND held = 0 AND command = 0")
            .map_err(|e| format!("prepare unreported sessions: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query unreported sessions: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Report ONE delivery row unconfirmed (board #437), as one IMMEDIATE
    /// transaction: the row is re-checked as still pending (it exists, not
    /// held, not a command, not warned) and marked warned, the feed's `warn`
    /// activity row and — when its sender is known — the room line are
    /// inserted, the line once by its stable id. A row settled or reported
    /// meanwhile reports nothing (`Ok(None)`); any failure rolls everything
    /// back, so the row keeps its right to be reported and the next sweep
    /// tries again (review P1-B: a mark without its report was a permanent
    /// miss). The caller pushes the returned rows after the commit.
    #[allow(clippy::too_many_arguments)]
    pub fn report_unconfirmed(
        &mut self,
        id: i64,
        session: &str,
        window: &str,
        warn: &str,
        deliveries: &str,
        line: Option<&super::OnceLine>,
    ) -> Result<Option<Unconfirmed>, String> {
        let ts = self.stamp_activity();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("report transaction: {e}"))?;
        let marked = tx
            .execute(
                "UPDATE deliveries SET warned = 1 WHERE id = ?1 AND warned = 0 AND held = 0 AND command = 0",
                rusqlite::params![id],
            )
            .map_err(|e| format!("mark delivery warned: {e}"))?;
        if marked == 0 {
            return Ok(None); // the transaction rolls back on drop
        }
        tx.execute(
            "INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state, deliveries, requesters)
             VALUES (?1, 0, ?2, ?3, 'warn', ?4, '', '', '', ?5, NULL)",
            rusqlite::params![session, window, ts as i64, warn, deliveries],
        )
        .map_err(|e| format!("insert activity: {e}"))?;
        let activity_id = tx.last_insert_rowid();
        let message = match line {
            Some(l) => super::rooms::hub_append_once_in(&tx, l, ts as i64)?,
            None => None,
        };
        tx.commit().map_err(|e| format!("commit report: {e}"))?;
        Ok(Some(Unconfirmed { activity_id, ts, message }))
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

    /// Test-only: every row of `tables`, as text, in rowid order — what a
    /// "writes nothing" test compares before and after.
    #[cfg(test)]
    pub fn dump_for_test(&self, tables: &[&str]) -> Result<String, String> {
        let mut out = String::new();
        for t in tables {
            let mut stmt = self.conn.prepare(&format!("SELECT * FROM {t} ORDER BY rowid")).map_err(|e| e.to_string())?;
            let n = stmt.column_count();
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let cells: Vec<String> = (0..n).map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).ok())).collect();
                out.push_str(&format!("{t}: {}\n", cells.join(" | ")));
            }
        }
        Ok(out)
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

    /// A NUMBERED producer's prompt (board #404 round 6): the delivery rows
    /// it settles are retired and its activity row is written in ONE
    /// transaction, so either both are durable or neither is — a retried
    /// prompt finds exactly the receipts the failed attempt matched. Each
    /// candidate counts only if this transaction deleted it (two echoes
    /// racing for one row cannot both call it theirs); `row` builds the
    /// activity row from the ids that were won and the row's stamp (its `ts`,
    /// `stamp_activity`). Returns them, the row id and that ts.
    pub fn settle_prompt(&mut self, candidates: &[i64], row: impl FnOnce(&[i64], u64) -> PromptRow) -> Result<(Vec<i64>, i64, u64), String> {
        self.settle_prompt_in(candidates, None, row)
    }

    /// `settle_prompt` for a restored window's envelope of `generation`
    /// (board #422 round 3, H2 review P1-C): the receipts, the prompt row
    /// AND the hold's acceptance are one transaction, committed only while
    /// the hold still carries that launch (`accept_in_generation`). Replaced
    /// meanwhile: nothing is written, `Err(GENERATION_REPLACED)`.
    pub fn settle_prompt_in(&mut self, candidates: &[i64], generation: Option<&str>, row: impl FnOnce(&[i64], u64) -> PromptRow) -> Result<(Vec<i64>, i64, u64), String> {
        let ts = self.stamp_activity();
        let tx = self.conn.transaction().map_err(|e| format!("prompt settlement transaction: {e}"))?;
        let mut won = Vec::new();
        for id in candidates {
            let n = tx
                .execute("DELETE FROM deliveries WHERE id = ?1", rusqlite::params![id])
                .map_err(|e| format!("settle delivery: {e}"))?;
            if n > 0 {
                won.push(*id);
            }
        }
        let r = row(&won, ts);
        tx.execute(
            "INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state, deliveries, requesters)
             VALUES (?1, 0, ?2, ?3, 'prompt', ?4, '', ?5, '', ?6, ?7)",
            rusqlite::params![r.session, r.window, ts as i64, r.text, r.via, r.deliveries, r.requesters],
        )
        .map_err(|e| format!("insert activity: {e}"))?;
        let id = tx.last_insert_rowid();
        if let Some(launch) = generation {
            accept_in_generation(&tx, launch, id, true)?;
        }
        tx.commit().map_err(|e| format!("prompt settlement commit: {e}"))?;
        Ok((won, id, ts))
    }

    /// `publish_activity` for a restored window's envelope of `generation`:
    /// the row and the hold's acceptance in ONE transaction, committed only
    /// while the hold still carries that launch. Replaced meanwhile: no row.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_activity_in(
        &mut self,
        generation: &str,
        session: &str,
        window: &str,
        kind: &str,
        text: &str,
        tool: &str,
        via: &str,
        state: &str,
        deliveries: &str,
        requesters: Option<&str>,
    ) -> (u64, Result<i64, String>) {
        let ts = self.stamp_activity();
        let written = (|| {
            let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| format!("activity transaction: {e}"))?;
            tx.execute(
                "INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state, deliveries, requesters)
                 VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![session, window, ts as i64, kind, text, tool, via, state, deliveries, requesters],
            )
            .map_err(|e| format!("insert activity: {e}"))?;
            let id = tx.last_insert_rowid();
            accept_in_generation(&tx, generation, id, kind == "prompt")?;
            tx.commit().map_err(|e| format!("commit activity: {e}"))?;
            Ok(id)
        })();
        (ts, written)
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

    /// Board #404 round 6: a numbered prompt's settlement and its row are
    /// ONE transaction. While it runs, the durable state a restarted
    /// process would read (a second connection) still holds the receipt;
    /// when the row INSERT fails, the receipt is still pending and no row
    /// exists; once it succeeds, the receipt is retired and the row names
    /// its id and message — never one without the other.
    #[test]
    fn a_numbered_prompt_settles_its_receipts_with_its_row_or_not_at_all() {
        let path = std::env::temp_dir().join(format!("tmm-settle-{}.db", uuid::Uuid::new_v4()));
        let mut store = Store::open(&path).unwrap();
        store.insert_delivery("s", "w", "[tmm chat 2026-10-16 21:30] lead: @w go", 0, 100, "m-1").unwrap();
        let d = store.pending_deliveries("s", Some("w")).unwrap()[0].id;
        let other = || rusqlite::Connection::open(&path).unwrap();
        let durable = |c: &rusqlite::Connection| {
            let pending: i64 = c.query_row("SELECT COUNT(*) FROM deliveries WHERE id = ?1", [d], |r| r.get(0)).unwrap();
            let rows: Vec<(String, String)> = c
                .prepare("SELECT via, deliveries FROM activity WHERE session = 's' AND kind = 'prompt'")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (pending, rows)
        };
        let row = |won: &[i64], _ts: u64| PromptRow {
            session: "s".into(),
            window: "w".into(),
            text: "go".into(),
            via: if won.is_empty() { "local" } else { "app" }.into(),
            deliveries: serde_json::to_string(&won.iter().map(|id| serde_json::json!({"id": id, "msg": "m-1"})).collect::<Vec<_>>()).unwrap(),
            requesters: None,
        };
        store.exec_test_sql("CREATE TEMP TRIGGER no_prompt BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        for _ in 0..3 {
            let err = store.settle_prompt(&[d], |won, ts| {
                assert_eq!(won, [d], "this transaction deleted it");
                assert_eq!(durable(&other()), (1, vec![]), "mid-transaction, a restart still reads the receipt pending");
                row(won, ts)
            });
            assert!(err.is_err());
            assert_eq!(durable(&other()), (1, vec![]), "the failed INSERT rolled the retirement back");
        }
        store.exec_test_sql("DROP TRIGGER no_prompt;").unwrap();
        drop(store);
        let mut store = Store::open(&path).unwrap();
        let (won, _, _) = store.settle_prompt(&[d], row).unwrap();
        assert_eq!(won, [d]);
        let (pending, rows) = durable(&other());
        assert_eq!(pending, 0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "app", "never converted to local input");
        assert!(rows[0].1.contains(&format!("\"id\":{d}")) && rows[0].1.contains("m-1"), "{}", rows[0].1);
        let (won, _, _) = store.settle_prompt(&[d], row).unwrap();
        assert!(won.is_empty(), "a second echo cannot take the same receipt");
        let _ = std::fs::remove_file(&path);
    }

    /// Board #414: the stamp is the store's, across EVERY writer and across a
    /// REAL restart. A process whose clock ran an hour ahead publishes a
    /// prompt (the settlement transaction), an end, a missed end; the next
    /// process opens the same file on the wall clock — an hour BEHIND that
    /// durable high-water — and its first rows are still stamped above it, so
    /// a client holding the old process's last cursor sees them. A dated row
    /// is written as dated and moves nothing.
    #[test]
    fn a_restart_never_stamps_below_the_durable_high_water() {
        let path = std::env::temp_dir().join(format!("tmm-hw-{}.db", uuid::Uuid::new_v4()));
        let ahead = wall_ms() + 3_600_000;
        let mut store = Store::open(&path).unwrap();
        store.set_activity_clock(move || ahead);
        let (_, _, p_ts) = store.settle_prompt(&[], |_, _| PromptRow {
            session: "s".into(),
            window: "w".into(),
            text: "go".into(),
            via: "local".into(),
            deliveries: String::new(),
            requesters: None,
        }).unwrap();
        let (n_ts, written) = store.publish_activity("s", "w", "notif", "completed", "", "", "", "", None);
        written.unwrap();
        let (_, m_ts) = store.insert_missed_end("s", "w", "auth_expired", None).unwrap();
        assert_eq!((p_ts, n_ts, m_ts), (ahead, ahead + 1, ahead + 2), "stamped in order on the clock that stands still");
        store.insert_dated_activity("s", "w", 5, "tool", "old.rs", "Edit", "", "", "").unwrap();
        assert_eq!(store.activity_high_water(), ahead + 2, "a dated row moves nothing");
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.activity_high_water(), ahead + 2, "seeded from the log");
        let (next, written) = store.publish_activity("s", "w", "warn", "after the restart", "", "", "", "", None);
        written.unwrap();
        assert_eq!(next, ahead + 3, "above the durable high-water, not on the wall clock behind it");
        let tail: Vec<String> = store.activity_since("s", m_ts, 10).unwrap().into_iter().map(|r| r.text).collect();
        assert_eq!(tail, ["after the restart"], "the old process's last cursor sees it");
        let _ = std::fs::remove_file(&path);
    }

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
        store.insert_dated_activity("s", "w1", 1000, "prompt", "same", "", "app", "", &refs).unwrap();
        store.insert_dated_activity("s", "w1", 1001, "prompt", "typed", "", "local", "", "").unwrap();
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
        let first = store.insert_dated_activity("s0", "w1", 1, "prompt", "p", "", "", "", "").unwrap();
        let second = store.insert_dated_activity("s0", "w1", 1, "notif", "completed", "", "", "", "").unwrap();
        assert!(second > first, "the returned row id is the insertion order (board #249)");
        for n in 0..5u64 {
            store
                .insert_dated_activity("s1", "w3", 1000 + n, "tool", &format!("file{n}.rs"), "Edit", "", "", "")
                .unwrap();
        }
        // Another session's rows never leak into this one's feed.
        store.insert_dated_activity("s2", "w1", 1002, "tool", "other.rs", "Read", "", "", "").unwrap();

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
        store.insert_dated_activity("s", "w2", 900, "prompt", "[tmm chat] old: closed turn", "", "app", "", "").unwrap();
        store.insert_dated_activity("s", "w2", 1000, "notif", "completed", "", "", "", "").unwrap();
        store.insert_dated_activity("s", "w2", 1100, "prompt", "[tmm chat] lead: work", "", "app", "", "").unwrap();
        store.insert_dated_activity("s", "w2", 1200, "tool", "file.rs", "Edit", "", "", "").unwrap();
        store.insert_dated_activity("s", "w2", 1250, "prompt", "[tmm chat] peer: [reply] fyi", "", "app", "", "").unwrap();
        // Every input of the OPEN turn, oldest first; the closed turn's is not.
        assert_eq!(
            all(None),
            vec!["[tmm chat] lead: work".to_string(), "[tmm chat] peer: [reply] fyi".to_string()]
        );
        // The bound stops early (oldest first).
        assert_eq!(all(Some(1)), vec!["[tmm chat] lead: work".to_string()]);
        store.insert_dated_activity("s", "w2", 1300, "notif", "completed", "", "", "", "").unwrap();
        assert!(all(None).is_empty());

        // #256 review: an open turn of 200 inputs comes back WHOLE, so the
        // first requester survives recovery; Some(1) reads just one row.
        store.insert_dated_activity("s", "w2", 2000, "prompt", "[tmm chat] orchestrator: request", "", "app", "", "").unwrap();
        for i in 0..199 {
            store.insert_dated_activity("s", "w2", 2001 + i, "prompt", &format!("[tmm chat] builder: [reply] {i}"), "", "app", "", "").unwrap();
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
            store.insert_dated_activity("s", "w1", ts, "tool", &format!("e{n}"), "Edit", "", "", "").unwrap();
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

/// What a fenced write answers when the hold no longer carries its launch.
pub const GENERATION_REPLACED: &str = "its restore generation was replaced";

/// In the caller's transaction: the hold of `launch` takes `row` as its first
/// accepted fact (if none), and a PROMPT while it is armed marks its
/// evidence accepted and its release pending (`merging`: the capture tick
/// completes a release this call's caller could not). No hold with that
/// launch: `Err(GENERATION_REPLACED)`, and the caller rolls back.
fn accept_in_generation(tx: &rusqlite::Transaction, launch: &str, row: i64, prompt: bool) -> Result<(), String> {
    let n = tx
        .execute(
            "UPDATE restore_holds SET accepted_seq = COALESCE(accepted_seq, ?2),
               merging = CASE WHEN ?3 AND stage = 'armed' THEN 1 ELSE merging END
             WHERE launch = ?1",
            rusqlite::params![launch, row, prompt],
        )
        .map_err(|e| format!("accept in generation: {e}"))?;
    if n == 0 {
        return Err(GENERATION_REPLACED.into());
    }
    Ok(())
}
