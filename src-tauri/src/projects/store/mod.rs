//! Persistence for declarative projects.
//!
//! `state.db` is ours and holds only what the machine observed: which projects
//! exist, which windows they are made of, and the topology history. Anything a
//! human writes by hand (agent definitions with their skills) stays in files —
//! see `docs/exec-plans/projects-and-tasks.md` §5.
//!
//! Since board #107 it also holds the hub rooms' messages (`hub_msgs`) — the
//! bus that used to keep them is gone.
//!
//! ONE `Store`, one connection, one migration ladder (board #147). This file
//! is the hub: the type, `open`/`open_memory`/`init`/`heal`, the family
//! declarations and the row-type re-exports. Each table family is an
//! `impl Store` block in its own file — `schema` (the ladder and the on-open
//! repairs), `projects`, `registry`, `board`, `activity`, `rooms`, `restore`
//! (the reboot evidence, board #422), `restore_batch` (its work in progress), `restore_hold` (the input barrier of a restored window) — with its
//! tests beside it; a method that lands here instead of in its family is what
//! the guard test at the bottom rejects.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

mod activity;
mod board;
mod projects;
mod registry;
mod restore;
pub(crate) mod restore_batch;
mod restore_hold;
mod rooms;
mod schema;
mod wakes;
pub use activity::{person_paint_key, person_paint_prefix, ActivityRow, CommandLife, DeliveryRow, PromptRow, TurnFact, TurnFacts, GENERATION_REPLACED};
pub use projects::{Project, Slot, SlotKind};
pub use restore::{Checkpoint, CheckpointProject, CheckpointWindow, RestoreIntents, TmuxInstance};
pub use restore_batch::{finished_word, settle, Batch, BatchOp, BatchProject, BatchRevision, BatchScan, BatchWindow, Finished, ProjectState, WindowState, NO_WINDOW, RELEASED};
pub use restore_hold::{Hold, HoldPane, HoldStage, UNKNOWN_BOOT};
pub use registry::{RegAgent, RegMcp, RegSkill, RegTeam};
pub use rooms::{HubMsg, OnceLine};
pub use wakes::Wake;

pub struct Store {
    conn: Connection,
    /// The activity log's high-water `ts` in ms (board #414): every OBSERVED
    /// row is stamped strictly above it, inside the store's write section
    /// (`Store::stamp_activity`), so `ts` rises in INSERT order. Seeded from
    /// the log at open, so a restart or a wall clock that stepped back never
    /// stamps a row behind one a client has already seen.
    activity_hw: std::cell::Cell<u64>,
    /// The wall clock in ms that stamp reads; a test injects its own
    /// (`set_activity_clock`).
    activity_clock: Box<dyn Fn() -> u64 + Send>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| format!("pragma: {e}"))?;
        let mut store = Self { conn, activity_hw: std::cell::Cell::new(0), activity_clock: Box::new(activity::wall_ms) };
        // Migrations MUST run with foreign keys off: a schema change rebuilds
        // `projects`, and with enforcement on SQLite performs an implicit
        // DELETE FROM before the DROP, which cascades every slot and snapshot
        // away. Off has to be explicit — libsqlite3-sys builds its bundled
        // SQLite with SQLITE_DEFAULT_FOREIGN_KEYS=1, so the connection default
        // is ON, not the SQLite upstream default of OFF.
        store
            .conn
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .map_err(|e| format!("pragma: {e}"))?;
        store.migrate()?;
        store.heal()?;
        store.seed_activity_hw()?;
        store
            .conn
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("pragma: {e}"))?;
        Ok(store)
    }

    /// Tables that must simply EXIST, created idempotently on every open.
    ///
    /// A version step is the right home for a schema change with data to carry
    /// forward; `deliveries` has none — it holds only lines still waiting for
    /// their echo, seconds to minutes old. What it does need is to be there even
    /// when `user_version` LIES about it, which is not hypothetical: a binary
    /// built from a tree where the version bump had landed and its migration
    /// block had not stamps the database at the new version without the table,
    /// and every later build then skips the step for ever (measured on this dev
    /// host, 2026-08-29 — the watcher rebuilt in the seconds between the two
    /// edits). The v13 step below still creates it for a database coming from
    /// v12; this is the floor under both.
    fn heal(&mut self) -> Result<(), String> {
        // Additive Board state gets the same partial-build protection as
        // deliveries below: never trust a version stamp more than the schema.
        self.ensure_issue_edit_lock()?;
        self.ensure_issue_numbering()?;
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS deliveries (
                   id      INTEGER PRIMARY KEY AUTOINCREMENT,
                   session TEXT NOT NULL,
                   window  INTEGER NOT NULL,
                   line    TEXT NOT NULL,
                   ts      INTEGER NOT NULL,
                   UNIQUE (session, window, line)
                 );
                 CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session, window);
                 CREATE TABLE IF NOT EXISTS hub_msgs (
                   seq     INTEGER PRIMARY KEY AUTOINCREMENT,
                   id      TEXT NOT NULL UNIQUE,
                   ts      INTEGER NOT NULL,
                   room    TEXT NOT NULL,
                   sender  TEXT NOT NULL,
                   to_json TEXT NOT NULL DEFAULT '[]',
                   kind    TEXT NOT NULL DEFAULT 'msg',
                   body    TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS hub_msgs_room_seq ON hub_msgs(room, seq);
                 CREATE TABLE IF NOT EXISTS meta (
                   key   TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 );",
            )
            .map_err(|e| format!("heal deliveries: {e}"))?;
        // Board #120: a binary built between the v20 stamp and its migration
        // block must still get the name columns (the v13 lesson, same floor).
        self.ensure_activity_names()?;
        self.ensure_delivery_names()?;
        self.ensure_delivery_duplicates()?;
        self.ensure_delivery_msg_ids()?;
        self.ensure_input_mode()?;
        self.ensure_delivery_held()?;
        self.ensure_activity_requesters()?;
        self.ensure_delivery_command()?;
        self.ensure_delivery_ask_at()?;
        self.ensure_wakes()?;
        self.ensure_restore_holds()?;
        self.ensure_hub_read()
    }

    // ---- archived messages ----------------------------------------------

    // ---- hub messages (board #107) ---------------------------------------
    //
    // The project room's transcript. This is the store `server/hub_rpc.rs`
    // reads and writes directly — the agora bus that used to hold it was
    // deleted whole with the Team system (board #100). `seq` is the paging
    // cursor: stable, gapless within a room, already on every message a
    // client holds (a millisecond timestamp is not — two messages can share
    // one). Nothing is ever pruned; hiding is `msg_archive`'s job, deletion
    // is explicit.

    // ---- activity log ---------------------------------------------------

    // ---- outstanding deliveries -----------------------------------------

    // ---- projects -------------------------------------------------------

    // ---- slots ----------------------------------------------------------

    // ---- agent registry (agents-v2) ------------------------------------

    // ---- agent teams (board #74) -----------------------------------------

    // ---- central skills / MCP assets (agents-v2, state.db v6) ----------

    // ---- the project task board (issues) ----------------------------------

}

/// The capture tick's batch-read seam (board #422), for the tests outside
/// this module that place another connection's write at that read.
#[cfg(test)]
pub(crate) use restore_batch::SCAN_HOOK;

#[cfg(test)]
pub(super) mod test_support {
    //! Row builders the family test modules share (board #147).
    use super::*;

    pub(super) fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: format!("/tmp/{id}"),
            icon: None,
            session: id.into(),
            adopted: false,
            autostart: false,
            created_at: 100,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),
        }
    }

    pub(super) fn issue_row_id(store: &Store, session: &str, number: i64) -> i64 {
        store.conn.query_row(
            "SELECT id FROM issues WHERE session = ?1 AND project_number = ?2",
            rusqlite::params![session, number],
            |r| r.get(0),
        ).unwrap()
    }

    pub(super) fn slot(name: &str, ord: i64) -> Slot {
        Slot {
            id: None,
            ord,
            window_name: name.into(),
            cwd: String::new(),
            kind: SlotKind::Shell,
            command: None,
            auto_run: false,
            agent_session_id: None,
            first_seen_at: 100,
            settled_at: Some(200),
        }
    }
}

#[cfg(test)]
mod tests {
    /// The hub file holds the connection and nothing else (board #147): the
    /// only functions allowed here are `open`, `open_memory`, `init` and
    /// `heal`; a table-family method that lands here instead of in its family
    /// file is the drift this split exists to stop. The line cap is the
    /// second tripwire for the same thing.
    #[test]
    fn the_store_hub_file_holds_only_the_connection() {
        let src = include_str!("mod.rs");
        let body: String = src.lines().take_while(|l| !l.starts_with("#[cfg(test)]")).map(|l| format!("{l}\n")).collect();
        let fns: Vec<&str> = body
            .lines()
            .filter_map(|l| {
                let t = l.trim_start();
                let t = t.strip_prefix("pub ").or(t.strip_prefix("pub(crate) ")).or(t.strip_prefix("pub(super) ")).unwrap_or(t);
                t.strip_prefix("fn ").map(|rest| rest.split('(').next().unwrap_or(rest))
            })
            .collect();
        assert_eq!(fns, ["open", "open_memory", "init", "heal"], "a family method is back in the hub file");
        let lines = body.lines().count();
        assert!(lines <= 200, "store/mod.rs grew to {lines} lines; it holds the connection only");
    }
}
