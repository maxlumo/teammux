//! Asks (board #106; design docs/design-docs/features/asks.md): an agent's
//! question to the person is ONE `hub_msgs` row (kind `ask`) plus a companion
//! `hub_asks` row that holds only its structure and its state.
//!
//! The state changes only through `ask_close`, ONE transaction that appends
//! the closing message under an id derived from the ask (`ask:<seq>:close`,
//! `hub_msgs.id` is UNIQUE) and moves `state` off `open` with one guarded
//! UPDATE. Whoever commits first wins; every later close, a retry of the same
//! one included, writes nothing and reads the winner back.

use super::*;

/// The states of an ask. `Open` is the only one that ends.
pub const ASK_OPEN: &str = "open";
pub const ASK_ANSWERED: &str = "answered";
pub const ASK_DISMISSED: &str = "dismissed";
pub const ASK_WITHDRAWN: &str = "withdrawn";

/// One ask: its message's place in the room and its companion row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskRow {
    pub seq: i64,
    pub room: String,
    pub ts: i64,
    /// The asker's window name, and the identity of the managed home that
    /// asked (`projects::asks::home_id`): a same-name replacement has another.
    pub asker: String,
    pub asker_home: String,
    pub question: String,
    /// `(key, label)`, in the asker's order.
    pub options: Vec<(String, String)>,
    pub recommend: Option<String>,
    pub issue: Option<i64>,
    pub state: String,
    /// The closing message (answer, dismissal or withdrawal) and its time.
    pub closed_seq: Option<i64>,
    pub closed_at: Option<i64>,
    /// The option the person chose, when the answer named one.
    pub answer_key: Option<String>,
    /// The closing act in its own words, without the quote of the ask:
    /// `B · beta — keep 24px`, `dismissed: …`, `withdrawn: why — citing …`
    /// (validator F3: a reader of a long question must still see the answer).
    pub said: Option<String>,
    /// What the one delivery path did with the closing line, recorded after
    /// the commit (`found`, `stopped`, `unknown`, `unchecked`, `gone`), or
    /// `None` when nothing was to be delivered (a withdrawal) or not yet.
    pub delivery: Option<String>,
}

/// What a new ask stores; validated by the caller (`projects::asks`).
pub struct NewAsk<'a> {
    pub room: &'a str,
    pub id: &'a str,
    pub asker: &'a str,
    pub asker_home: &'a str,
    pub question: &'a str,
    pub options: &'a [(String, String)],
    pub recommend: Option<&'a str>,
    pub issue: Option<i64>,
    /// The composed body old clients and `tmm log` print.
    pub body: &'a str,
}

/// One closing edge.
pub struct AskClose<'a> {
    pub seq: i64,
    /// `answered`, `dismissed` or `withdrawn`.
    pub state: &'a str,
    pub answer_key: Option<&'a str>,
    /// The act's own words (`AskRow::said`).
    pub said: &'a str,
    pub sender: &'a str,
    pub to_json: &'a str,
    pub body: &'a str,
}

/// The result of a close: `applied` only for the call that moved the state;
/// `message` is the closing row it wrote (push it after this returns), and
/// `ask` is the row as it now stands, the winner's when not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskClosed {
    pub applied: bool,
    pub message: Option<HubMsg>,
    pub ask: AskRow,
}

/// The one id of an ask's closing message: one per ask, whatever closes it.
pub fn ask_close_id(seq: i64) -> String {
    format!("ask:{seq}:close")
}

const ASK_COLUMNS: &str = "a.seq, m.room, m.ts, a.asker, a.asker_home, a.question, a.options_json, a.recommend, a.issue,
                           a.state, a.closed_seq, a.closed_at, a.answer_key, a.delivery, a.said";

fn ask_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AskRow> {
    let options_json: String = r.get(6)?;
    let options = serde_json::from_str::<Vec<(String, String)>>(&options_json).unwrap_or_default();
    Ok(AskRow {
        seq: r.get(0)?,
        room: r.get(1)?,
        ts: r.get(2)?,
        asker: r.get(3)?,
        asker_home: r.get(4)?,
        question: r.get(5)?,
        options,
        recommend: r.get(7)?,
        issue: r.get(8)?,
        state: r.get(9)?,
        closed_seq: r.get(10)?,
        closed_at: r.get(11)?,
        answer_key: r.get(12)?,
        delivery: r.get(13)?,
        said: r.get(14)?,
    })
}

fn ask_get_in(conn: &rusqlite::Connection, seq: i64) -> Result<Option<AskRow>, String> {
    conn.query_row(
        &format!("SELECT {ASK_COLUMNS} FROM hub_asks a JOIN hub_msgs m ON m.seq = a.seq WHERE a.seq = ?1"),
        rusqlite::params![seq],
        ask_from_row,
    )
    .optional()
    .map_err(|e| format!("read ask: {e}"))
}

impl Store {
    /// The v39 shape, also a heal floor: created only when absent.
    pub(super) fn ensure_hub_asks(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS hub_asks (
                   seq          INTEGER PRIMARY KEY REFERENCES hub_msgs(seq) ON DELETE CASCADE,
                   asker        TEXT NOT NULL,
                   asker_home   TEXT NOT NULL,
                   question     TEXT NOT NULL,
                   options_json TEXT NOT NULL DEFAULT '[]',
                   recommend    TEXT,
                   issue        INTEGER,
                   state        TEXT NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open', 'answered', 'dismissed', 'withdrawn')),
                   closed_seq   INTEGER,
                   closed_at    INTEGER,
                   answer_key   TEXT,
                   delivery     TEXT,
                   said         TEXT
                 );
                 CREATE INDEX IF NOT EXISTS hub_asks_state ON hub_asks(state);",
            )
            .map_err(|e| format!("ensure hub_asks: {e}"))
    }

    /// Record a new ask: its message and its companion row, in one
    /// transaction. Returns both; the caller pushes the message.
    pub fn ask_open(&mut self, a: &NewAsk<'_>, ts: i64) -> Result<(HubMsg, AskRow), String> {
        let options_json = serde_json::to_string(a.options).map_err(|e| format!("ask options: {e}"))?;
        let tx = self.conn.transaction().map_err(|e| format!("ask transaction: {e}"))?;
        tx.execute(
            "INSERT INTO hub_msgs (id, ts, room, sender, to_json, kind, body) VALUES (?1, ?2, ?3, ?4, '[\"human\"]', 'ask', ?5)",
            rusqlite::params![a.id, ts, a.room, a.asker, a.body],
        )
        .map_err(|e| format!("append ask: {e}"))?;
        let seq = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO hub_asks (seq, asker, asker_home, question, options_json, recommend, issue)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![seq, a.asker, a.asker_home, a.question, options_json, a.recommend, a.issue],
        )
        .map_err(|e| format!("record ask: {e}"))?;
        let row = ask_get_in(&tx, seq)?.ok_or("the ask just written is not there")?;
        tx.commit().map_err(|e| format!("commit ask: {e}"))?;
        let msg = HubMsg {
            seq,
            id: a.id.to_string(),
            ts,
            room: a.room.to_string(),
            sender: a.asker.to_string(),
            to_json: "[\"human\"]".into(),
            kind: "ask".into(),
            body: a.body.to_string(),
        };
        Ok((msg, row))
    }

    pub fn ask_get(&self, seq: i64) -> Result<Option<AskRow>, String> {
        ask_get_in(&self.conn, seq)
    }

    /// A room's asks, oldest first; only the open ones unless `all`.
    pub fn ask_list(&self, room: &str, all: bool) -> Result<Vec<AskRow>, String> {
        let filter = if all { "" } else { " AND a.state = 'open'" };
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {ASK_COLUMNS} FROM hub_asks a JOIN hub_msgs m ON m.seq = a.seq WHERE m.room = ?1{filter} ORDER BY a.seq"))
            .map_err(|e| format!("prepare asks: {e}"))?;
        let rows = stmt.query_map(rusqlite::params![room], ask_from_row).map_err(|e| format!("query asks: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("read asks: {e}"))
    }

    /// Close an ask: append the closing message under `ask_close_id` and move
    /// the state off `open`, both or neither. A close that finds the ask
    /// already closed (or its closing id taken) writes nothing and returns the
    /// row as the winner left it.
    pub fn ask_close(&mut self, c: &AskClose<'_>, ts: i64) -> Result<AskClosed, String> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| format!("ask close transaction: {e}"))?;
        let Some(ask) = ask_get_in(&tx, c.seq)? else {
            return Err(format!("no ask {}", c.seq));
        };
        if ask.state != ASK_OPEN {
            return Ok(AskClosed { applied: false, message: None, ask });
        }
        let id = ask_close_id(c.seq);
        let inserted = tx
            .execute(
                "INSERT INTO hub_msgs (id, ts, room, sender, to_json, kind, body) VALUES (?1, ?2, ?3, ?4, ?5, 'msg', ?6)
                 ON CONFLICT(id) DO NOTHING",
                rusqlite::params![id, ts, ask.room, c.sender, c.to_json, c.body],
            )
            .map_err(|e| format!("append ask close: {e}"))?;
        if inserted != 1 {
            // An open ask whose closing id is taken is a broken record, not a
            // race (the state and the message commit together): say so.
            return Err(format!("ask {}: its closing message exists but the ask is open", c.seq));
        }
        let closing = tx.last_insert_rowid();
        let moved = tx
            .execute(
                "UPDATE hub_asks SET state = ?2, closed_seq = ?3, closed_at = ?4, answer_key = ?5, said = ?6 WHERE seq = ?1 AND state = 'open'",
                rusqlite::params![c.seq, c.state, closing, ts, c.answer_key, c.said],
            )
            .map_err(|e| format!("close ask: {e}"))?;
        if moved != 1 {
            return Err(format!("ask {}: the state did not move", c.seq));
        }
        let row = ask_get_in(&tx, c.seq)?.ok_or("the ask just closed is not there")?;
        tx.commit().map_err(|e| format!("commit ask close: {e}"))?;
        let message = HubMsg {
            seq: closing,
            id,
            ts,
            room: ask.room,
            sender: c.sender.to_string(),
            to_json: c.to_json.to_string(),
            kind: "msg".into(),
            body: c.body.to_string(),
        };
        Ok(AskClosed { applied: true, message: Some(message), ask: row })
    }

    /// What the delivery path did with the closing line, recorded after it ran.
    pub fn ask_set_delivery(&self, seq: i64, delivery: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE hub_asks SET delivery = ?2 WHERE seq = ?1", rusqlite::params![seq, delivery])
            .map(|_| ())
            .map_err(|e| format!("record ask delivery: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, l)| (k.to_string(), l.to_string())).collect()
    }

    fn open_one(s: &mut Store, room: &str, id: &str) -> AskRow {
        let o = opts(&[("A", "own row"), ("B", "disk to the card")]);
        let (_, row) = s
            .ask_open(&NewAsk { room, id, asker: "leader", asker_home: "h-1", question: "which?", options: &o, recommend: Some("A"), issue: Some(103), body: "@human which?" }, 100)
            .unwrap();
        row
    }

    fn answer<'a>(seq: i64, key: Option<&'a str>, body: &'a str) -> AskClose<'a> {
        AskClose { seq, state: ASK_ANSWERED, answer_key: key, said: body, sender: "human", to_json: "[\"leader\"]", body }
    }

    #[test]
    fn an_ask_is_one_message_to_the_person_and_one_open_row() {
        let mut s = Store::open_memory().unwrap();
        let row = open_one(&mut s, "proj:a", "q1");
        assert_eq!((row.state.as_str(), row.asker.as_str(), row.asker_home.as_str()), (ASK_OPEN, "leader", "h-1"));
        assert_eq!(row.options, opts(&[("A", "own row"), ("B", "disk to the card")]));
        assert_eq!((row.recommend.as_deref(), row.issue, row.closed_seq, row.delivery.as_deref()), (Some("A"), Some(103), None, None));
        let (msgs, _, _) = s.hub_page("proj:a", None, 10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!((msgs[0].seq, msgs[0].kind.as_str(), msgs[0].to_json.as_str(), msgs[0].sender.as_str()), (row.seq, "ask", "[\"human\"]", "leader"));
        assert_eq!(s.ask_list("proj:a", false).unwrap(), vec![row]);
    }

    /// D1-D4: each closing edge moves the state once and writes ONE closing
    /// message under the derived id, in the ask's room.
    #[test]
    fn each_closing_edge_writes_one_message_and_one_state() {
        for (state, key, sender, to) in [(ASK_ANSWERED, Some("A"), "human", "[\"leader\"]"), (ASK_ANSWERED, None, "human", "[\"leader\"]"), (ASK_DISMISSED, None, "human", "[\"leader\"]"), (ASK_WITHDRAWN, None, "leader", "[]")] {
            let mut s = Store::open_memory().unwrap();
            let row = open_one(&mut s, "proj:a", "q1");
            let out = s.ask_close(&AskClose { seq: row.seq, state, answer_key: key, said: "closing", sender, to_json: to, body: "closing" }, 200).unwrap();
            assert!(out.applied, "{state}");
            let m = out.message.unwrap();
            assert_eq!((m.id.as_str(), m.room.as_str(), m.sender.as_str(), m.to_json.as_str(), m.kind.as_str()), ("ask:1:close", "proj:a", sender, to, "msg"));
            assert_eq!((out.ask.state.as_str(), out.ask.closed_seq, out.ask.closed_at, out.ask.answer_key.as_deref(), out.ask.said.as_deref()), (state, Some(m.seq), Some(200), key, Some("closing")));
            assert!(s.ask_list("proj:a", false).unwrap().is_empty(), "not open any more");
            assert_eq!(s.ask_list("proj:a", true).unwrap(), vec![out.ask.clone()]);
        }
    }

    /// D5 + I3: on a closed ask every close (a retry of the winner's included)
    /// writes nothing and reads the winner back.
    #[test]
    fn a_closed_ask_refuses_every_close_and_shows_the_winner() {
        let mut s = Store::open_memory().unwrap();
        let row = open_one(&mut s, "proj:a", "q1");
        let won = s.ask_close(&answer(row.seq, Some("A"), "A · own row"), 200).unwrap();
        for (state, sender) in [(ASK_ANSWERED, "human"), (ASK_DISMISSED, "human"), (ASK_WITHDRAWN, "leader")] {
            let again = s.ask_close(&AskClose { seq: row.seq, state, answer_key: Some("B"), said: "late", sender, to_json: "[]", body: "late" }, 300).unwrap();
            assert_eq!((again.applied, again.message.clone(), again.ask.clone()), (false, None, won.ask.clone()), "{state}");
        }
        let (msgs, _, _) = s.hub_page("proj:a", None, 10).unwrap();
        assert_eq!(msgs.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(), vec!["@human which?", "A · own row"], "nothing added");
    }

    /// I1/I2: two connections close the same ask; the second, which never saw
    /// the first, is refused with the first's row. One closing message exists.
    #[test]
    fn two_connections_closing_one_ask_one_wins() {
        let scratch = crate::tmux::Scratch::new("store-asks-race");
        let path = std::path::Path::new(&scratch.path()).join("state.db");
        let mut a = Store::open(&path).unwrap();
        let seq = open_one(&mut a, "proj:a", "q1").seq;
        let mut b = Store::open(&path).unwrap();
        let first = a.ask_close(&answer(seq, Some("A"), "A from client 1"), 200).unwrap();
        let second = b.ask_close(&AskClose { seq, state: ASK_WITHDRAWN, answer_key: None, said: "withdrawn", sender: "leader", to_json: "[]", body: "withdrawn" }, 201).unwrap();
        assert!(first.applied && !second.applied);
        assert_eq!(second.ask, first.ask, "the loser reads the winner's answer");
        let n: i64 = b.conn.query_row("SELECT COUNT(*) FROM hub_msgs WHERE id = 'ask:1:close'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // And truly at once: threads on two connections, both waiting on the
        // write lock; exactly one applies.
        let seq2 = open_one(&mut a, "proj:a", "q2").seq;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|i| {
                let (path, barrier) = (path.clone(), barrier.clone());
                std::thread::spawn(move || {
                    let mut s = Store::open(&path).unwrap();
                    s.conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    let body = format!("client {i}");
                    s.ask_close(&answer(seq2, Some("A"), &body), 300 + i).unwrap().applied
                })
            })
            .collect();
        let applied: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(applied.iter().filter(|x| **x).count(), 1, "{applied:?}");
    }

    /// I4: an open ask whose closing id is already taken is a broken record:
    /// an error, and nothing changes.
    #[test]
    fn an_open_ask_with_a_taken_closing_id_is_an_error_and_changes_nothing() {
        let mut s = Store::open_memory().unwrap();
        let row = open_one(&mut s, "proj:a", "q1");
        s.hub_append("proj:a", &ask_close_id(row.seq), 150, "x", "[]", "msg", "squatter").unwrap();
        let err = s.ask_close(&answer(row.seq, Some("A"), "A"), 200).unwrap_err();
        assert!(err.contains("closing message exists"), "{err}");
        assert_eq!(s.ask_get(row.seq).unwrap().unwrap().state, ASK_OPEN);
    }

    /// L3: purging the ask's message takes its row with it.
    #[test]
    fn a_purged_ask_message_takes_its_row() {
        let mut s = Store::open_memory().unwrap();
        // The store's REAL setting, as `init` leaves it (leader, note 4): the
        // cascade below fires because enforcement is on, not by a test pragma.
        let fk: i64 = s.conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "init leaves foreign keys on");
        open_one(&mut s, "proj:a", "q1");
        assert_eq!(s.hub_delete("proj:a", &["q1".to_string()]).unwrap(), 1);
        assert!(s.ask_list("proj:a", true).unwrap().is_empty());
    }

    #[test]
    fn delivery_is_recorded_beside_the_state() {
        let mut s = Store::open_memory().unwrap();
        let row = open_one(&mut s, "proj:a", "q1");
        s.ask_close(&answer(row.seq, None, "x"), 200).unwrap();
        s.ask_set_delivery(row.seq, "stopped").unwrap();
        let r = s.ask_get(row.seq).unwrap().unwrap();
        assert_eq!((r.state.as_str(), r.delivery.as_deref()), (ASK_ANSWERED, Some("stopped")));
    }
}
