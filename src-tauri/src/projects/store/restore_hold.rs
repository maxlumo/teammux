//! The input barrier of a restored agent window (board #422 round 3): one row
//! per planned agent slot of a restore batch, bound to the exact incarnation
//! the restore made — this socket's tmux instance, the native session,
//! window and pane, and the launch uuid its start line carries.
//!
//! One family of the store (board #147). A hold outlives its batch: closing a
//! batch releases nothing, and a later batch cannot drop it. Every write that
//! follows a read is CONDITIONAL on the launch uuid it read, in one IMMEDIATE
//! transaction, so a stale writer (another gateway, or a release racing a
//! replace) changes nothing.
//!
//! `restore_decided:<socket>` is the other half: the boot a prepare has
//! decided for. Until it names the tick's boot, a capture tick whose socket
//! still holds another boot's evidence commits nothing (`commit_scanned`).

use super::*;

/// How far the restore got with a held window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldStage {
    /// Written by prepare with the batch; no window yet.
    Planned,
    /// The window exists; its native identity is recorded. Readiness is
    /// never read in this stage.
    Bound,
    /// The launch is about to be typed (or was); written in the same
    /// transaction as the window's `LaunchIssued`.
    Armed,
    /// Positive startup evidence of THIS launch was accepted: input is no
    /// longer blocked, but the generation stays recorded so a late envelope
    /// of another (or no) launch from this pane is still told apart.
    Released,
}

impl HoldStage {
    fn as_str(self) -> &'static str {
        match self {
            HoldStage::Planned => "planned",
            HoldStage::Bound => "bound",
            HoldStage::Armed => "armed",
            HoldStage::Released => "released",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "planned" => Ok(HoldStage::Planned),
            "bound" => Ok(HoldStage::Bound),
            "armed" => Ok(HoldStage::Armed),
            "released" => Ok(HoldStage::Released),
            other => Err(format!("unknown hold stage {other:?}")),
        }
    }
}

/// The native identity of the window a hold was bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldPane {
    pub instance: TmuxInstance,
    pub session_id: String,
    pub window_id: String,
    pub pane_id: String,
    pub pane_pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub socket: String,
    pub project_id: String,
    pub batch: String,
    pub ord: usize,
    /// The planned window name: the logical slot.
    pub slot: String,
    pub launch: String,
    pub stage: HoldStage,
    pub pane: Option<HoldPane>,
    pub since: u64,
    /// The sequence of the first turn fact of this launch that was DURABLY
    /// recorded (`None` while none was): the status' "this incarnation".
    pub accepted_seq: Option<i64>,
    /// The 120 s deadline passed with no evidence: a report, never a release.
    pub not_ready: bool,
    /// The not-ready room line was posted.
    pub reported: bool,
    /// Positive evidence of this launch was accepted but its window could
    /// not yet be given the slot's name (a refused or unconfirmed rename):
    /// still held, and the capture tick retries the merge.
    pub merging: bool,
}

const DECIDED: &str = "restore_decided:";

/// The token a prepare writes when the host's boot cannot be read.
pub const UNKNOWN_BOOT: &str = "unknown";

const COLUMNS: &str = "socket, project_id, batch, ord, slot, launch, stage, inst_socket, inst_pid, inst_start, session_id, window_id, pane_id, pane_pid, since, accepted_seq, not_ready, reported, merging";

fn row_to_hold(r: &rusqlite::Row) -> rusqlite::Result<(Hold, String)> {
    let stage: String = r.get(6)?;
    let inst_socket: Option<String> = r.get(7)?;
    let pane = match (inst_socket, r.get::<_, Option<i64>>(8)?, r.get::<_, Option<i64>>(9)?, r.get::<_, Option<String>>(10)?, r.get::<_, Option<String>>(11)?, r.get::<_, Option<String>>(12)?, r.get::<_, Option<i64>>(13)?) {
        (Some(socket), Some(pid), Some(start), Some(session_id), Some(window_id), Some(pane_id), Some(pane_pid)) => Some(HoldPane {
            instance: TmuxInstance { socket, pid: pid as u32, start_time: start as u64 },
            session_id,
            window_id,
            pane_id,
            pane_pid: pane_pid as u32,
        }),
        _ => None,
    };
    Ok((
        Hold {
            socket: r.get(0)?,
            project_id: r.get(1)?,
            batch: r.get(2)?,
            ord: r.get::<_, i64>(3)? as usize,
            slot: r.get(4)?,
            launch: r.get(5)?,
            stage: HoldStage::Planned,
            pane,
            since: r.get::<_, i64>(14)? as u64,
            accepted_seq: r.get(15)?,
            not_ready: r.get::<_, i64>(16)? != 0,
            reported: r.get::<_, i64>(17)? != 0,
            merging: r.get::<_, i64>(18)? != 0,
        },
        stage,
    ))
}

fn collect(rows: impl Iterator<Item = rusqlite::Result<(Hold, String)>>) -> Result<Vec<Hold>, String> {
    rows.map(|r| {
        let (mut h, stage) = r.map_err(|e| format!("read hold: {e}"))?;
        h.stage = HoldStage::parse(&stage)?;
        Ok(h)
    })
    .collect()
}

/// Insert `h` inside the caller's transaction. Any OTHER hold of the same
/// slot (socket, project, slot name; any batch, e.g. an earlier boot's) is
/// retired in the same transaction: a slot has ONE current incarnation, the
/// one every read answers by (H2 review P1-A residual).
pub(super) fn insert_hold(tx: &rusqlite::Transaction, h: &Hold) -> Result<(), String> {
    retire_others_in(tx, h)?;
    let p = h.pane.as_ref();
    tx.execute(
        &format!("INSERT INTO restore_holds ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"),
        params![
            h.socket,
            h.project_id,
            h.batch,
            h.ord as i64,
            h.slot,
            h.launch,
            h.stage.as_str(),
            p.map(|p| p.instance.socket.clone()),
            p.map(|p| p.instance.pid as i64),
            p.map(|p| p.instance.start_time as i64),
            p.map(|p| p.session_id.clone()),
            p.map(|p| p.window_id.clone()),
            p.map(|p| p.pane_id.clone()),
            p.map(|p| p.pane_pid as i64),
            h.since as i64,
            h.accepted_seq,
            h.not_ready as i64,
            h.reported as i64,
            h.merging as i64,
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("write hold: {e}"))
}

/// In the caller's transaction: retire every hold of `h`'s slot that is not
/// `h`'s own launch.
fn retire_others_in(tx: &rusqlite::Transaction, h: &Hold) -> Result<(), String> {
    tx.execute(
        "DELETE FROM restore_holds WHERE socket = ?1 AND project_id = ?2 AND slot = ?3 AND launch != ?4",
        params![h.socket, h.project_id, h.slot, h.launch],
    )
    .map(|_| ())
    .map_err(|e| format!("retire older holds: {e}"))
}

/// Set the decided boot inside the caller's transaction.
pub(super) fn write_decided(tx: &rusqlite::Transaction, socket: &str, boot: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![format!("{DECIDED}{socket}"), boot],
    )
    .map(|_| ())
    .map_err(|e| format!("write restore decision: {e}"))
}

pub(super) fn decided_in(conn: &rusqlite::Connection, socket: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![format!("{DECIDED}{socket}")], |r| r.get(0))
        .optional()
        .map_err(|e| format!("read restore decision: {e}"))
}

impl Store {
    /// The holds table: created on every open (the `heal` floor), so a
    /// version stamp can never claim it exists when it does not.
    pub(super) fn ensure_restore_holds(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS restore_holds (
                   socket      TEXT NOT NULL,
                   project_id  TEXT NOT NULL,
                   batch       TEXT NOT NULL,
                   ord         INTEGER NOT NULL,
                   slot        TEXT NOT NULL,
                   launch      TEXT NOT NULL UNIQUE,
                   stage       TEXT NOT NULL,
                   inst_socket TEXT,
                   inst_pid    INTEGER,
                   inst_start  INTEGER,
                   session_id  TEXT,
                   window_id   TEXT,
                   pane_id     TEXT,
                   pane_pid    INTEGER,
                   since       INTEGER NOT NULL,
                   PRIMARY KEY (socket, project_id, batch, ord)
                 );
                 CREATE INDEX IF NOT EXISTS restore_holds_project ON restore_holds(socket, project_id);",
            )
            .map_err(|e| format!("heal restore_holds: {e}"))?;
        // Round 3 H2 columns, added where a round-3 H1 database lacks them.
        for (col, ddl) in [
            ("accepted_seq", "ALTER TABLE restore_holds ADD COLUMN accepted_seq INTEGER"),
            ("not_ready", "ALTER TABLE restore_holds ADD COLUMN not_ready INTEGER NOT NULL DEFAULT 0"),
            ("reported", "ALTER TABLE restore_holds ADD COLUMN reported INTEGER NOT NULL DEFAULT 0"),
            ("merging", "ALTER TABLE restore_holds ADD COLUMN merging INTEGER NOT NULL DEFAULT 0"),
            ("merge_reported", "ALTER TABLE restore_holds ADD COLUMN merge_reported INTEGER NOT NULL DEFAULT 0"),
        ] {
            let has: bool = self
                .conn
                .query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('restore_holds') WHERE name = ?1)", params![col], |r| r.get(0))
                .map_err(|e| format!("inspect restore_holds.{col}: {e}"))?;
            if !has {
                self.conn.execute_batch(ddl).map_err(|e| format!("add restore_holds.{col}: {e}"))?;
            }
        }
        Ok(())
    }

    /// The boot a prepare has decided for on `socket`, if any.
    pub fn restore_decided(&self, socket: &str) -> Result<Option<String>, String> {
        decided_in(&self.conn, socket)
    }

    /// Record a decision that opened nothing (off, no trigger, already
    /// restored, empty plan).
    pub fn set_restore_decided(&mut self, socket: &str, boot: &str) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("decision transaction: {e}"))?;
        write_decided(&tx, socket, boot)?;
        tx.commit().map_err(|e| format!("commit decision: {e}"))
    }

    /// Every live hold of one project on one socket: one range read.
    pub fn project_holds(&self, socket: &str, project_id: &str) -> Result<Vec<Hold>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM restore_holds WHERE socket = ?1 AND project_id = ?2 ORDER BY batch, ord"))
            .map_err(|e| format!("read holds: {e}"))?;
        let rows = stmt.query_map(params![socket, project_id], row_to_hold).map_err(|e| format!("read holds: {e}"))?;
        collect(rows)
    }

    /// Every live hold on one socket.
    pub fn socket_holds(&self, socket: &str) -> Result<Vec<Hold>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM restore_holds WHERE socket = ?1 ORDER BY project_id, batch, ord"))
            .map_err(|e| format!("read holds: {e}"))?;
        let rows = stmt.query_map(params![socket], row_to_hold).map_err(|e| format!("read holds: {e}"))?;
        collect(rows)
    }

    /// The hold whose launch uuid is `launch`, if it is live.
    pub fn hold_by_launch(&self, launch: &str) -> Result<Option<Hold>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM restore_holds WHERE launch = ?1"))
            .map_err(|e| format!("read hold: {e}"))?;
        let rows = stmt.query_map(params![launch], row_to_hold).map_err(|e| format!("read hold: {e}"))?;
        Ok(collect(rows)?.into_iter().next())
    }

    /// Delete the hold only if it is still exactly as `seen` (generation,
    /// stage and pane); `true` if it was.
    pub fn retire_hold_as_seen(&mut self, seen: &Hold) -> Result<bool, String> {
        self.conn
            .execute(
                "DELETE FROM restore_holds WHERE launch = ?1 AND stage = ?2 AND pane_id IS ?3",
                params![seen.launch, seen.stage.as_str(), seen.pane.as_ref().map(|p| p.pane_id.clone())],
            )
            .map(|n| n > 0)
            .map_err(|e| format!("retire hold: {e}"))
    }

    /// Release the hold of `launch` if it is still in one of `from`: the
    /// stage becomes `released`, the row and its generation stay. In the
    /// SAME transaction its window's record in its batch becomes `Launched`
    /// ("released after positive evidence"), conditional on the batch uuid
    /// and the window's launch uuid, and only while that batch is still the
    /// socket's open or last one: the capture then observes the window like
    /// any other. `true` if the hold was released.
    pub fn release_hold_if(&mut self, launch: &str, from: &[HoldStage]) -> Result<bool, String> {
        let stages: Vec<&str> = from.iter().map(|s| s.as_str()).collect();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("release transaction: {e}"))?;
        let row: Option<(String, String, String, String, i64)> = tx
            .query_row("SELECT stage, socket, project_id, batch, ord FROM restore_holds WHERE launch = ?1", params![launch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()
            .map_err(|e| format!("read hold: {e}"))?;
        let Some((_, socket, project_id, batch, ord)) = row.filter(|(s, ..)| stages.contains(&s.as_str())) else {
            return Ok(false);
        };
        tx.execute("UPDATE restore_holds SET stage = 'released', not_ready = 0, merging = 0, merge_reported = 0 WHERE launch = ?1", params![launch])
            .map_err(|e| format!("release hold: {e}"))?;
        super::restore_batch::mark_released_in(&tx, &socket, &project_id, &batch, ord as usize, launch)?;
        tx.commit().map_err(|e| format!("commit release: {e}"))?;
        Ok(true)
    }

    /// The not-ready report of `launch` was not posted: unclaimed, so a
    /// later tick posts it.
    pub fn unclaim_hold_report(&mut self, launch: &str) -> Result<(), String> {
        self.conn.execute("UPDATE restore_holds SET reported = 0 WHERE launch = ?1", params![launch]).map(|_| ()).map_err(|e| format!("unclaim hold report: {e}"))
    }

    /// Mark `launch` merging (its evidence was accepted, its rename was not
    /// seen) and CLAIM its one room line; `Ok(true)` when this call claimed
    /// it. `Ok(false)`: merging already, its line claimed. A line that could
    /// not be posted gives the claim back (`unclaim_merge_report`).
    pub fn mark_hold_merging_if(&mut self, launch: &str) -> Result<bool, String> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| format!("merging transaction: {e}"))?;
        let n = tx.execute("UPDATE restore_holds SET merging = 1 WHERE launch = ?1 AND stage = 'armed'", params![launch]).map_err(|e| format!("mark hold merging: {e}"))?;
        if n == 0 {
            return Err(format!("no armed hold {launch} to mark merging"));
        }
        let claimed = tx.execute("UPDATE restore_holds SET merge_reported = 1 WHERE launch = ?1 AND merge_reported = 0", params![launch]).map_err(|e| format!("claim merge report: {e}"))? > 0;
        tx.commit().map_err(|e| format!("commit merging: {e}"))?;
        Ok(claimed)
    }

    /// The merging line of `launch` was not posted: unclaimed.
    pub fn unclaim_merge_report(&mut self, launch: &str) -> Result<(), String> {
        self.conn.execute("UPDATE restore_holds SET merge_reported = 0 WHERE launch = ?1", params![launch]).map(|_| ()).map_err(|e| format!("unclaim merge report: {e}"))
    }

    /// The (session, slot) of every hold on `socket` that is reported not
    /// ready, still blocking, not merging, and has NO durably accepted fact
    /// of its launch: the status' `restore_not_ready`, read at read time
    /// (board #422 round 3 review P1-A). A fact of this launch accepted a
    /// moment ago takes the window out at once.
    pub fn restore_not_ready_window(&self, socket: &str, session: &str, slot: &str) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM restore_holds h JOIN projects p ON p.id = h.project_id
                   WHERE h.socket = ?1 AND p.session = ?2 AND h.slot = ?3 AND h.not_ready = 1 AND h.accepted_seq IS NULL
                     AND h.merging = 0 AND h.stage IN ('bound', 'armed'))",
                params![socket, session, slot],
                |r| r.get(0),
            )
            .map_err(|e| format!("read not-ready holds: {e}"))
    }

    /// Test seam: record `seq` as `launch`'s first accepted fact. The product
    /// records it in the fact's own transaction (`accept_in_generation`).
    #[cfg(test)]
    pub fn accept_hold_fact_if(&mut self, launch: &str, seq: i64) -> Result<bool, String> {
        self.conn
            .execute("UPDATE restore_holds SET accepted_seq = ?2 WHERE launch = ?1 AND accepted_seq IS NULL", params![launch, seq])
            .map(|n| n > 0)
            .map_err(|e| format!("accept hold fact: {e}"))
    }

    /// Mark `launch` not ready (the deadline passed) and CLAIM its one room
    /// report; `true` when this call claimed it. A report that could not be
    /// posted gives the claim back (`unclaim_hold_report`), so `reported`
    /// means the line was posted.
    pub fn mark_hold_not_ready_if(&mut self, launch: &str) -> Result<bool, String> {
        self.conn
            .execute(
                // The claim re-checks, in its own write, what the tick read:
                // an accepted fact or a merge pending since then is not "not
                // ready" (validator V10 interleave).
                "UPDATE restore_holds SET not_ready = 1, reported = 1
                 WHERE launch = ?1 AND reported = 0 AND stage IN ('bound', 'armed') AND accepted_seq IS NULL AND merging = 0",
                params![launch],
            )
            .map(|n| n > 0)
            .map_err(|e| format!("mark hold not ready: {e}"))
    }

    /// Install a new generation for a slot that is being launched again (a
    /// restart, `up`, a spawn), in ONE transaction: the generation `old` the
    /// launch started from is replaced — `launch`, `stage` (armed for a
    /// hold still blocking, released for a released one), the new pane and
    /// `since`. If that row was retired meanwhile (its pane ended and the
    /// prune ran between the verb's kill and this launch), the generation is
    /// installed again under the same key. `false` = ANOTHER generation holds
    /// the key or the slot now: nothing is written. Every other hold of the
    /// slot is retired in the same transaction (one current incarnation).
    pub fn install_hold(&mut self, old: &Hold, new_launch: &str, stage: HoldStage, pane: &HoldPane, since: u64) -> Result<bool, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("install transaction: {e}"))?;
        let n = tx
            .execute(
                "UPDATE restore_holds SET launch = ?2, stage = ?3, inst_socket = ?4, inst_pid = ?5, inst_start = ?6, session_id = ?7, window_id = ?8, pane_id = ?9, pane_pid = ?10,
                   since = ?11, accepted_seq = NULL, not_ready = 0, reported = 0, merging = 0, merge_reported = 0
                 WHERE launch = ?1",
                params![old.launch, new_launch, stage.as_str(), pane.instance.socket, pane.instance.pid as i64, pane.instance.start_time as i64, pane.session_id, pane.window_id, pane.pane_id, pane.pane_pid as i64, since as i64],
            )
            .map_err(|e| format!("install hold: {e}"))?;
        if n > 0 {
            retire_others_in(&tx, &Hold { launch: new_launch.into(), ..old.clone() })?;
        }
        if n == 0 {
            let taken: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM restore_holds WHERE (socket = ?1 AND project_id = ?2 AND batch = ?3 AND ord = ?4) OR (socket = ?1 AND project_id = ?2 AND slot = ?5))",
                    params![old.socket, old.project_id, old.batch, old.ord as i64, old.slot],
                    |r| r.get(0),
                )
                .map_err(|e| format!("read hold key: {e}"))?;
            if taken {
                return Ok(false);
            }
            let fresh = Hold { launch: new_launch.into(), stage, pane: Some(pane.clone()), since, accepted_seq: None, not_ready: false, reported: false, merging: false, ..old.clone() };
            insert_hold(&tx, &fresh)?;
        }
        tx.commit().map_err(|e| format!("commit install: {e}"))?;
        Ok(true)
    }

    /// The ordinary restart of a released slot retires its row (board #422,
    /// STAGE ruling) in ONE transaction: the released row exactly as `seen`
    /// is deleted; if it is not there any more, `true` only when the slot has
    /// NO other hold (the prune retired it, and no successor). `false` = a
    /// successor generation holds the slot: the restart must not start.
    pub fn retire_released_as_seen(&mut self, seen: &Hold) -> Result<bool, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("retire transaction: {e}"))?;
        let n = tx
            .execute(
                "DELETE FROM restore_holds WHERE launch = ?1 AND stage = 'released' AND pane_id IS ?2",
                params![seen.launch, seen.pane.as_ref().map(|p| p.pane_id.clone())],
            )
            .map_err(|e| format!("retire hold: {e}"))?;
        let free = n > 0
            || !tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM restore_holds WHERE socket = ?1 AND project_id = ?2 AND slot = ?3)",
                    params![seen.socket, seen.project_id, seen.slot],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|e| format!("read holds: {e}"))?;
        tx.commit().map_err(|e| format!("commit retire: {e}"))?;
        Ok(free)
    }

    /// Delete the hold only if it still carries `launch`; `true` if it did.
    pub fn retire_hold_if(&mut self, launch: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM restore_holds WHERE launch = ?1", params![launch])
            .map(|n| n > 0)
            .map_err(|e| format!("retire hold: {e}"))
    }
}

impl Store {
    /// Test seam: bind and arm a planned hold in one step (another writer
    /// racing a reader that saw it planned).
    #[cfg(test)]
    pub fn advance_hold_for_test(&mut self, launch: &str, p: &HoldPane) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        bind_hold_in(&tx, launch, p)?;
        arm_hold_in(&tx, launch)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Test seam: make a hold `secs` older.
    #[cfg(test)]
    pub fn age_hold_for_test(&mut self, launch: &str, secs: u64) -> Result<(), String> {
        self.conn.execute("UPDATE restore_holds SET since = since - ?2 WHERE launch = ?1", params![launch, secs as i64]).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Test seam: a row the store can no longer read.
    #[cfg(test)]
    pub fn corrupt_hold_for_test(&mut self, launch: &str) -> Result<(), String> {
        self.conn.execute("UPDATE restore_holds SET stage = 'bogus' WHERE launch = ?1", params![launch]).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// In the caller's transaction: bind the hold carrying `launch` to the
/// window just made, only from `Planned`. `false` = it was not there or not
/// planned any more (nothing changed).
pub(super) fn bind_hold_in(tx: &rusqlite::Transaction, launch: &str, p: &HoldPane) -> Result<bool, String> {
    tx.execute(
        "UPDATE restore_holds SET stage = 'bound', inst_socket = ?2, inst_pid = ?3, inst_start = ?4, session_id = ?5, window_id = ?6, pane_id = ?7, pane_pid = ?8
         WHERE launch = ?1 AND stage = 'planned'",
        params![launch, p.instance.socket, p.instance.pid as i64, p.instance.start_time as i64, p.session_id, p.window_id, p.pane_id, p.pane_pid as i64],
    )
    .map(|n| n > 0)
    .map_err(|e| format!("bind hold: {e}"))
}

/// In the caller's transaction: arm the hold carrying `launch`, only from
/// `Bound`.
pub(super) fn arm_hold_in(tx: &rusqlite::Transaction, launch: &str) -> Result<bool, String> {
    tx.execute("UPDATE restore_holds SET stage = 'armed' WHERE launch = ?1 AND stage = 'bound'", params![launch])
        .map(|n| n > 0)
        .map_err(|e| format!("arm hold: {e}"))
}

/// In the caller's transaction: delete the hold carrying `launch`.
pub(super) fn retire_hold_in(tx: &rusqlite::Transaction, launch: &str) -> Result<bool, String> {
    tx.execute("DELETE FROM restore_holds WHERE launch = ?1", params![launch])
        .map(|n| n > 0)
        .map_err(|e| format!("retire hold: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hold(launch: &str, ord: usize) -> Hold {
        Hold {
            socket: "/s".into(),
            project_id: "p".into(),
            batch: "b".into(),
            ord,
            slot: format!("dev{ord}"),
            launch: launch.into(),
            stage: HoldStage::Planned,
            pane: None,
            since: 7,
            accepted_seq: None,
            not_ready: false,
            reported: false,
            merging: false,
        }
    }

    fn pane() -> HoldPane {
        HoldPane { instance: TmuxInstance { socket: "/s".into(), pid: 10, start_time: 20 }, session_id: "$1".into(), window_id: "@2".into(), pane_id: "%3".into(), pane_pid: 44 }
    }

    /// A hold is planned with its batch, bound and armed only from the stage
    /// before, and every write is conditional on the launch uuid: a writer
    /// holding an old uuid changes nothing.
    #[test]
    fn holds_move_forward_only_and_every_write_names_its_generation() {
        let mut store = Store::open_memory().unwrap();
        {
            let tx = store.conn.transaction().unwrap();
            insert_hold(&tx, &hold("L1", 0)).unwrap();
            insert_hold(&tx, &hold("L2", 1)).unwrap();
            write_decided(&tx, "/s", "boot").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(store.restore_decided("/s").unwrap().as_deref(), Some("boot"));
        assert_eq!(store.project_holds("/s", "p").unwrap().len(), 2);
        assert!(store.project_holds("/other", "p").unwrap().is_empty(), "another socket's holds are its own");
        {
            let tx = store.conn.transaction().unwrap();
            assert!(!arm_hold_in(&tx, "L1").unwrap(), "planned cannot be armed");
            assert!(bind_hold_in(&tx, "L1", &pane()).unwrap());
            assert!(!bind_hold_in(&tx, "L1", &pane()).unwrap(), "bound once");
            assert!(arm_hold_in(&tx, "L1").unwrap());
            assert!(!bind_hold_in(&tx, "old", &pane()).unwrap(), "an unknown generation binds nothing");
            tx.commit().unwrap();
        }
        let h = store.hold_by_launch("L1").unwrap().unwrap();
        assert_eq!(h.stage, HoldStage::Armed);
        assert_eq!(h.pane, Some(pane()));
        assert!(!store.retire_hold_if("old").unwrap());
        assert!(store.retire_hold_if("L1").unwrap());
        assert!(store.hold_by_launch("L1").unwrap().is_none());
        assert_eq!(store.socket_holds("/s").unwrap().len(), 1);
    }

    /// H2: release keeps the row and its generation; the first accepted fact
    /// is recorded once; the not-ready report is due once; a replace swaps the
    /// generation in one step, conditional on the old one — and every one of
    /// them is a no-op for a stale generation.
    #[test]
    fn release_accept_report_and_replace_are_one_generation_each() {
        let mut store = Store::open_memory().unwrap();
        {
            let tx = store.conn.transaction().unwrap();
            insert_hold(&tx, &hold("L1", 0)).unwrap();
            bind_hold_in(&tx, "L1", &pane()).unwrap();
            tx.commit().unwrap();
        }
        assert!(!store.release_hold_if("L1", &[HoldStage::Armed]).unwrap(), "only from the stages named");
        assert!(store.mark_hold_not_ready_if("L1").unwrap());
        assert!(!store.mark_hold_not_ready_if("L1").unwrap(), "reported once");
        assert!(store.accept_hold_fact_if("L1", 41).unwrap());
        assert!(!store.accept_hold_fact_if("L1", 42).unwrap(), "the FIRST accepted fact");
        assert!(store.release_hold_if("L1", &[HoldStage::Bound, HoldStage::Armed]).unwrap());
        let h = store.hold_by_launch("L1").unwrap().unwrap();
        assert_eq!((h.stage, h.accepted_seq, h.not_ready), (HoldStage::Released, Some(41), false), "the row stays, released");
        assert!(!store.release_hold_if("old", &[HoldStage::Armed]).unwrap());
        let mut p2 = pane();
        p2.pane_id = "%9".into();
        let l1 = store.hold_by_launch("L1").unwrap().unwrap();
        let stale = Hold { launch: "old".into(), ..l1.clone() };
        assert!(!store.install_hold(&stale, "L2", HoldStage::Armed, &p2, 9).unwrap(), "another generation holds the key: nothing is written");
        assert!(store.hold_by_launch("L2").unwrap().is_none());
        assert!(store.install_hold(&l1, "L2", HoldStage::Released, &p2, 9).unwrap(), "a released hold is replaced by a released generation");
        assert!(store.hold_by_launch("L1").unwrap().is_none());
        let h = store.hold_by_launch("L2").unwrap().unwrap();
        assert_eq!((h.stage, h.pane.clone().unwrap().pane_id, h.accepted_seq, h.since), (HoldStage::Released, "%9".to_string(), None, 9));
        // Its row retired meanwhile (the prune): installed again, same key.
        assert!(store.retire_hold_if("L2").unwrap());
        assert!(store.install_hold(&h, "L3", HoldStage::Armed, &p2, 10).unwrap());
        let h3 = store.hold_by_launch("L3").unwrap().unwrap();
        assert_eq!((h3.stage, h3.slot.clone(), h3.batch.clone(), h3.ord), (HoldStage::Armed, h.slot.clone(), h.batch.clone(), h.ord));
    }

    /// A release makes its window's batch record `Launched` in the same
    /// transaction — only that batch, that project's slot, that launch, a
    /// window that was typed into — and the batch owner's stale copy never
    /// takes it back, neither on a save nor on the close.
    #[test]
    fn a_release_marks_its_batch_window_launched_and_the_owners_copy_keeps_it() {
        use super::super::restore_batch::RELEASED;
        let mut store = Store::open_memory().unwrap();
        let window = |ord: usize, launch: &str, state: WindowState| BatchWindow {
            ord,
            name: format!("dev{ord}"),
            kind: SlotKind::Agent,
            managed: true,
            cwd: String::new(),
            backend: Some("claude".into()),
            agent_session_id: None,
            state,
            reason: None,
            window_id: None,
            pane_id: None,
            pane_pid: None,
            launch: Some(launch.into()),
            op: None,
            typed: Some(true),
            released: false,
            create_issued: Some(true),
        };
        let project = |id: &str, windows: Vec<BatchWindow>| BatchProject {
            id: id.into(),
            name: id.into(),
            path: "/w".into(),
            session: id.into(),
            autostart_only: false,
            state: ProjectState::Open,
            reason: None,
            session_id: None,
            holder_id: None,
            op: None,
            finished: None,
            windows,
        };
        let owner = Batch {
            batch: "b".into(),
            socket: "/s".into(),
            boot_id: None,
            owner_pid: 1, attempt: 0,
            instance: None,
            source: Checkpoint { gen: 0, at: 1, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![
                project("p", vec![window(0, "L1", WindowState::LaunchUnknown), window(1, "L2", WindowState::Created)]),
                // Another project's slot of the same ord.
                project("q", vec![window(0, "L1", WindowState::LaunchUnknown)]),
                // A window the owner already confirmed `Launched`.
                project("r", vec![window(0, "L5", WindowState::Launched)]),
            ],
        };
        let mut holds = vec![hold("L1", 0), hold("L2", 1), Hold { project_id: "r".into(), ..hold("L5", 0) }];
        for h in &mut holds {
            h.stage = HoldStage::Armed;
            h.pane = Some(pane());
        }
        store.open_batch(&owner, &holds, "boot").unwrap();
        let rec = |store: &Store, open: bool, pi: usize, wi: usize| {
            let b = if open { store.restore_batch("/s") } else { store.last_batch("/s") }.unwrap().unwrap();
            let w = &b.projects[pi].windows[wi];
            (w.state, w.reason.clone())
        };
        assert!(store.release_hold_if("L1", &[HoldStage::Armed]).unwrap());
        assert_eq!(rec(&store, true, 0, 0), (WindowState::Launched, Some(RELEASED.into())));
        assert_eq!(rec(&store, true, 1, 0).0, WindowState::LaunchUnknown, "another project's slot is not this hold's");
        assert!(store.release_hold_if("L2", &[HoldStage::Armed]).unwrap());
        assert_eq!(rec(&store, true, 0, 1).0, WindowState::Created, "a window never typed into is not made Launched");
        // Confirmed Launched by the owner before its release: marked all the same.
        assert!(store.release_hold_if("L5", &[HoldStage::Armed]).unwrap());
        assert!(store.restore_batch("/s").unwrap().unwrap().projects[2].windows[0].released, "marked released all the same");
        // The owner saves and closes from its copy taken before the release;
        // its copy comes back merged, and its finished projects settled again.
        let mut copy = owner.clone();
        copy.projects[0].finished = Some(Finished { note: None });
        settle(&mut copy.projects[0]);
        assert_eq!(copy.projects[0].state, ProjectState::Failed, "the stale copy alone would fail the project");
        store.save_batch(&mut copy).unwrap();
        assert_eq!(rec(&store, true, 0, 0), (WindowState::Launched, Some(RELEASED.into())), "a save does not take it back");
        assert_eq!(copy.projects[0].windows[0].state, WindowState::Launched, "the owner's copy is the merged state");
        assert_eq!((copy.projects[0].state, copy.projects[0].reason.clone()), (ProjectState::Done, None), "and its outcome follows its windows");
        // Released BEFORE the owner's own `Launched` (its rename): the
        // release stays recorded in the owner's copy and the store.
        let mut renamed = owner.clone();
        (renamed.projects[0].windows[0].state, renamed.projects[0].windows[0].reason) = (WindowState::Launched, None);
        store.save_batch(&mut renamed).unwrap();
        assert!(renamed.projects[0].windows[0].released, "merged into the owner's copy");
        let stored = store.restore_batch("/s").unwrap().unwrap();
        assert!(stored.projects[0].windows[0].released, "the rename does not take the release back");
        let mut closing = owner.clone();
        closing.closed = Some("done with failures".into());
        store.close_batch(&mut closing).unwrap();
        let last = store.last_batch("/s").unwrap().unwrap();
        assert!(last.projects[0].windows[0].state == WindowState::Launched && last.projects[0].windows[0].released, "nor does the close");
        // A stored batch that cannot be read is an error, never overwritten.
        let mut again = owner.clone();
        again.batch = "b".into();
        store.save_batch(&mut again).unwrap();
        store.meta_set("restore_batch:/s", "{").unwrap();
        assert!(store.save_batch(&mut owner.clone()).is_err());
        assert_eq!(store.meta_get("restore_batch:/s").unwrap().as_deref(), Some("{"), "the unreadable value is left for a person");
        store.conn.execute("DELETE FROM meta WHERE key = 'restore_batch:/s'", []).unwrap();
        // A newer batch: a late release of the old one's hold changes neither.
        let mut newer = owner.clone();
        newer.batch = "b2".into();
        store.save_batch(&mut newer.clone()).unwrap();
        let mut late = hold("L3", 2);
        late.stage = HoldStage::Armed;
        {
            let tx = store.conn.transaction().unwrap();
            insert_hold(&tx, &late).unwrap();
            tx.commit().unwrap();
        }
        assert!(store.release_hold_if("L3", &[HoldStage::Armed]).unwrap());
        assert_eq!(store.restore_batch("/s").unwrap(), Some(newer), "a newer batch is never written");
    }
}
