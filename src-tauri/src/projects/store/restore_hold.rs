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
}

impl HoldStage {
    fn as_str(self) -> &'static str {
        match self {
            HoldStage::Planned => "planned",
            HoldStage::Bound => "bound",
            HoldStage::Armed => "armed",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "planned" => Ok(HoldStage::Planned),
            "bound" => Ok(HoldStage::Bound),
            "armed" => Ok(HoldStage::Armed),
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
}

const DECIDED: &str = "restore_decided:";

/// The token a prepare writes when the host's boot cannot be read.
pub const UNKNOWN_BOOT: &str = "unknown";

const COLUMNS: &str = "socket, project_id, batch, ord, slot, launch, stage, inst_socket, inst_pid, inst_start, session_id, window_id, pane_id, pane_pid, since";

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

/// Insert `h` inside the caller's transaction.
pub(super) fn insert_hold(tx: &rusqlite::Transaction, h: &Hold) -> Result<(), String> {
    let p = h.pane.as_ref();
    tx.execute(
        &format!("INSERT INTO restore_holds ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
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
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("write hold: {e}"))
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
            .map_err(|e| format!("heal restore_holds: {e}"))
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
}
