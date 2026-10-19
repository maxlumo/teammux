//! The restore BATCH (board #422, round 2): the work in progress of one
//! restore, frozen at its start and advanced one write-ahead step at a time.
//!
//! One family of the store (board #147). `meta restore_batch:<socket>` holds
//! the OPEN batch of a tmux socket; `restore_last:<socket>` the last closed
//! one. Every change is one IMMEDIATE transaction over the whole value, so a
//! successor reads exactly what the owner last wrote — including the tmux
//! step it had issued (`op`) and not yet seen the result of.

use super::*;

/// What a project of the batch is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectState {
    Pending,
    /// The claim (`new-session`) was issued or is about to be.
    CreatingSession,
    /// Our session exists and carries its tag; windows are being made.
    Open,
    Done,
    Skipped,
    Failed,
}

/// What a window of the batch is doing. `LaunchIssued` is written BEFORE the
/// launch line is typed; from then on the window is never killed, renamed or
/// retyped by the automatic path (`LaunchUnknown` when that step's outcome
/// was not seen).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Pending,
    /// `new-window` issued (or about to be); at most an untagged placeholder exists.
    Creating,
    /// Tagged, nothing typed.
    Created,
    LaunchIssued,
    Launched,
    LaunchUnknown,
    Skipped,
    Failed,
}

/// The tmux step an item had issued and not yet seen the result of — what
/// a successor must re-OBSERVE rather than redo (review, round 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchOp {
    Claim,
    TagSession,
    CreateWindow,
    TagWindow,
    Rename,
    Kill,
    /// The holder's kill (only while another window exists, checked in-server).
    HolderKill,
    /// The holder's rename to a plain shell (it is the session's last window).
    HolderRename,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchWindow {
    /// The slot's position; the placeholder name and the window tag carry it.
    pub ord: usize,
    pub name: String,
    pub kind: SlotKind,
    pub managed: bool,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub state: WindowState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// The launch uuid of an agent slot: its hold's generation, and what its
    /// start line carries as `TMM_LAUNCH` (board #422 round 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<BatchOp>,
    /// "Input may have been sent" (board #422 round 4): written true in the
    /// SAME transaction as the `LaunchIssued` that precedes any typing, and
    /// never cleared. `Some(false)` from the plan on; a record from before
    /// the field (`None`) is no proof of "never typed". A retry rebuilds
    /// only a window that was never typed into and is confirmed absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed: Option<bool>,
    /// Its hold was released on positive evidence (board #422 round 4):
    /// written with the release, never cleared; the state and launch decide
    /// everything else, and the reason text stays display only.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub released: bool,
    /// "A create may have taken effect" (board #422 round 4 review P1-C):
    /// true from the write ahead of `new-window`, false again only when the
    /// server refused it. With no ids, only `Some(false)` lets a retry
    /// rebuild the window; `None` (a record from before) does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_issued: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub session: String,
    pub autostart_only: bool,
    pub state: ProjectState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<BatchOp>,
    pub windows: Vec<BatchWindow>,
    /// Set when the project finished (`restore_run::finalize`): its outcome
    /// is then SETTLED from its windows (`settle`), again whenever a release
    /// makes one of them `Launched` (board #422 round 3 review P1-E).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished: Option<Finished>,
}

/// How a project finished: the note its finish carried (the holder's fate).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finished {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The reason of a finished project none of whose windows was restored.
pub const NO_WINDOW: &str = "no window could be restored";

/// A finished project's outcome, from its windows: the ONE rule the owner's
/// finish and a release both apply. Any window `Launched`: done (with the
/// note); none: failed, "no window could be restored". Not finished: as is.
pub fn settle(p: &mut BatchProject) {
    let Some(f) = &p.finished else { return };
    if p.windows.iter().any(|w| w.state == WindowState::Launched) {
        p.state = ProjectState::Done;
        p.reason = f.note.clone();
    } else {
        p.state = ProjectState::Failed;
        p.reason = Some(match &f.note {
            Some(n) if n.starts_with("no window") => n.clone(),
            Some(n) => format!("{NO_WINDOW}; {n}"),
            None => NO_WINDOW.into(),
        });
    }
}

/// The word a batch closes with once every project has finished.
pub fn finished_word(b: &Batch) -> &'static str {
    if b.projects.iter().any(|p| p.state == ProjectState::Failed) {
        "done with failures"
    } else {
        "done"
    }
}

/// Settle every finished project again, and a batch closed by its finish
/// with the word that now follows.
fn resettle(b: &mut Batch) {
    b.projects.iter_mut().for_each(settle);
    if matches!(b.closed.as_deref(), Some("done") | Some("done with failures")) {
        b.closed = Some(finished_word(b).into());
    }
}

/// One restore: its full uuid (the authority every native tag carries), the
/// boot and socket it belongs to, the tmux server it made its objects on
/// (recorded by the first creation), the source checkpoint copied whole, and
/// its projects. `closed` is `None` while open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub batch: String,
    pub socket: String,
    pub boot_id: Option<String>,
    pub owner_pid: u32,
    /// Which person-run attempt of this batch the record is (board #422
    /// round 4): 0 for the automatic start's, +1 each time `tmm project
    /// restore --run` reopens it. A continuation consumes only the
    /// (batch, attempt) it was admitted with (`restore_run::Admitted`).
    #[serde(default)]
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<TmuxInstance>,
    pub source: Checkpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<String>,
    pub projects: Vec<BatchProject>,
}

const OPEN: &str = "restore_batch:";
const LAST: &str = "restore_last:";

/// The raw stored values of a socket's open and last batches: what a capture
/// tick scanned under, compared again inside its commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BatchRevision {
    pub open: Option<String>,
    pub last: Option<String>,
}

/// What a capture tick scans under: the socket's open and last batches,
/// decoded from the very bytes `revision` holds. An unreadable value is its
/// own `Err`, so one bad batch holds conservatively without voiding the other.
#[derive(Debug, Clone)]
pub struct BatchScan {
    pub open: Result<Option<Batch>, String>,
    pub last: Result<Option<Batch>, String>,
    pub revision: BatchRevision,
}

/// A test seam that runs just before the one batch read: another connection's
/// write placed here would split "what was scanned" from "the revision" if
/// a caller ever read the two apart.
#[cfg(test)]
pub(crate) static SCAN_HOOK: std::sync::Mutex<Option<Box<dyn Fn() + Send>>> = std::sync::Mutex::new(None);

/// Both batch values in ONE statement, hence one SQLite read snapshot (WAL),
/// and the caller decodes its batches from these same bytes (review round 2,
/// P1-A residual). The scan and `commit_scanned`'s re-check both read here.
pub(super) fn revision_in(conn: &rusqlite::Connection, socket: &str) -> Result<BatchRevision, String> {
    scan_hook();
    let (open_key, last_key) = (format!("{OPEN}{socket}"), format!("{LAST}{socket}"));
    let err = |e: rusqlite::Error| format!("read batch: {e}");
    let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE key IN (?1, ?2)").map_err(err)?;
    let mut rows = stmt.query(params![open_key, last_key]).map_err(err)?;
    let mut rev = BatchRevision::default();
    while let Some(row) = rows.next().map_err(err)? {
        let (key, value): (String, String) = (row.get(0).map_err(err)?, row.get(1).map_err(err)?);
        if key == open_key {
            rev.open = Some(value);
        } else {
            rev.last = Some(value);
        }
    }
    Ok(rev)
}

#[cfg(test)]
fn scan_hook() {
    if let Some(hook) = SCAN_HOOK.lock().unwrap().as_ref() {
        hook();
    }
}

#[cfg(not(test))]
fn scan_hook() {}

/// The reason a window's record carries once its hold was released
/// (board #422 round 3): the release wrote `Launched` for it. Display only;
/// the merge keys on the state and the launch, never on this text.
pub const RELEASED: &str = "released after positive evidence";

/// In the caller's transaction: the window of `project_id`'s slot `ord` in
/// batch `batch` whose launch uuid is `launch` becomes `Launched`
/// (`RELEASED`), in whichever of the socket's open and last batches IS that
/// batch. A newer batch, another launch, or a window that was never typed
/// into is left alone.
pub(super) fn mark_released_in(tx: &rusqlite::Transaction, socket: &str, project_id: &str, batch: &str, ord: usize, launch: &str) -> Result<(), String> {
    for key in [format!("{OPEN}{socket}"), format!("{LAST}{socket}")] {
        let value: Option<String> = tx
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(|e| format!("read batch: {e}"))?;
        let Some(mut b) = decode(&key, value.as_ref())?.filter(|b| b.batch == batch) else { continue };
        let w = b.projects.iter_mut().filter(|p| p.id == project_id).flat_map(|p| p.windows.iter_mut()).find(|w| w.ord == ord && w.launch.as_deref() == Some(launch));
        if let Some(w) = w.filter(|w| matches!(w.state, WindowState::LaunchIssued | WindowState::LaunchUnknown | WindowState::Launched)) {
            if w.state != WindowState::Launched {
                w.state = WindowState::Launched;
                w.reason = Some(RELEASED.into());
            }
            // The fact, whatever the owner wrote before (round 4): a window
            // it already confirmed `Launched` is released all the same.
            w.released = true;
            resettle(&mut b);
            let value = serde_json::to_string(&b).map_err(|e| format!("encode batch: {e}"))?;
            tx.execute("UPDATE meta SET value = ?2 WHERE key = ?1", params![key, value]).map_err(|e| format!("write batch: {e}"))?;
        }
    }
    Ok(())
}

/// The owner writes its batch whole from its own copy, which a release
/// (another process, or the hook consumer) may have advanced meanwhile: a
/// stored window the release made `Launched` (same project, ord and launch)
/// stays so, and is merged INTO the owner's copy, whose finished projects
/// are settled again — so every later decision of the owner reads the same
/// state the store holds (review P1-E). A stored value that cannot be read
/// is an error: it is never overwritten blind.
fn keep_released(tx: &rusqlite::Transaction, b: &mut Batch) -> Result<(), String> {
    let key = format!("{OPEN}{}", b.socket);
    let value: Option<String> = tx
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| format!("read batch: {e}"))?;
    let Some(stored) = decode(&key, value.as_ref())?.filter(|s| s.batch == b.batch) else { return Ok(()) };
    let mut changed = false;
    for sp in &stored.projects {
        for sw in sp.windows.iter().filter(|w| w.state == WindowState::Launched && w.launch.is_some()) {
            let mine = b.projects.iter_mut().filter(|p| p.id == sp.id).flat_map(|p| p.windows.iter_mut()).find(|w| w.ord == sw.ord && w.launch == sw.launch);
            if let Some(w) = mine {
                if w.state != WindowState::Launched {
                    w.state = WindowState::Launched;
                    w.reason = sw.reason.clone();
                    changed = true;
                }
                // Released is monotonic: the owner's copy never takes it back
                // (round 4: the room line counts a ready agent by it).
                if sw.released && !w.released {
                    w.released = true;
                    changed = true;
                }
            }
        }
    }
    if changed {
        resettle(b);
    }
    Ok(())
}

fn decode(key: &str, value: Option<&String>) -> Result<Option<Batch>, String> {
    value.map(|v| serde_json::from_str(v).map_err(|e| format!("unreadable {key}: {e}"))).transpose()
}

/// The report lines in the caller's transaction; the rows inserted now.
fn report_in(tx: &rusqlite::Connection, lines: &[OnceLine]) -> Result<Vec<HubMsg>, String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut inserted = Vec::new();
    for l in lines {
        inserted.extend(super::rooms::hub_append_once_in(tx, l, ts)?);
    }
    report_hook(1)?;
    Ok(inserted)
}

#[cfg(test)]
thread_local! {
    /// Test seam: fail a reporting write at stage 1 (inside its transaction,
    /// after the insert) or 2 (after the commit, before the caller's push).
    pub(crate) static REPORT_FAIL: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

fn report_hook(_stage: u8) -> Result<(), String> {
    #[cfg(test)]
    if REPORT_FAIL.with(|f| f.get()) == _stage {
        REPORT_FAIL.with(|f| f.set(0));
        return Err(format!("test: the reporting write failed at stage {_stage}"));
    }
    Ok(())
}

impl Store {
    /// The socket's OPEN batch. An unreadable value is an `Err`: a restore
    /// that cannot read its own progress does nothing.
    pub fn restore_batch(&self, socket: &str) -> Result<Option<Batch>, String> {
        self.read_batch(&format!("{OPEN}{socket}"))
    }

    /// The socket's batches for a tick to scan under: one read, and the
    /// decoded batches and the revision come from the same bytes.
    pub fn batch_scan(&self, socket: &str) -> Result<BatchScan, String> {
        let revision = revision_in(&self.conn, socket)?;
        Ok(BatchScan {
            open: decode(&format!("{OPEN}{socket}"), revision.open.as_ref()),
            last: decode(&format!("{LAST}{socket}"), revision.last.as_ref()),
            revision,
        })
    }

    /// The socket's last CLOSED batch.
    pub fn last_batch(&self, socket: &str) -> Result<Option<Batch>, String> {
        self.read_batch(&format!("{LAST}{socket}"))
    }

    fn read_batch(&self, key: &str) -> Result<Option<Batch>, String> {
        decode(key, self.meta_get(key)?.as_ref())
    }

    /// Write the open batch whole, in one IMMEDIATE transaction. `b` comes
    /// back as written: merged with what a release stored meanwhile.
    pub fn save_batch(&mut self, b: &mut Batch) -> Result<(), String> {
        self.save_batch_with(b, |_, _| Ok(true)).map(|_| ())
    }

    /// Open a batch with a planned hold for each of its agent slots and the
    /// boot decision that opened it, in ONE transaction (board #422 round 3).
    pub fn open_batch(&mut self, b: &Batch, holds: &[Hold], boot: &str) -> Result<(), String> {
        let mut b = b.clone();
        let socket = b.socket.clone();
        self.save_batch_with(&mut b, |tx, _| {
            for h in holds {
                super::restore_hold::insert_hold(tx, h)?;
            }
            super::restore_hold::write_decided(tx, &socket, boot)?;
            Ok(true)
        })
        .map(|_| ())
    }

    /// Write the batch and bind the planned hold `launch` to `pane`, in one
    /// transaction. `false` = the hold was no longer planned (a newer
    /// generation, or gone): NOTHING is written.
    pub fn save_batch_binding(&mut self, b: &mut Batch, launch: &str, pane: &HoldPane) -> Result<bool, String> {
        self.save_batch_with(b, |tx, _| super::restore_hold::bind_hold_in(tx, launch, pane))
    }

    /// Write the batch (its window now `LaunchIssued`) and arm the bound hold
    /// `launch`, in one transaction; `false` = nothing written.
    pub fn save_batch_arming(&mut self, b: &mut Batch, launch: &str) -> Result<bool, String> {
        self.save_batch_with(b, |tx, _| super::restore_hold::arm_hold_in(tx, launch))
    }

    /// Write the batch and retire the hold `launch` (a slot skipped or a
    /// window killed before any typing), in one transaction. A hold already
    /// gone is no reason to lose the batch write.
    pub fn save_batch_retiring(&mut self, b: &mut Batch, launch: &str) -> Result<(), String> {
        self.save_batch_with(b, |tx, _| super::restore_hold::retire_hold_in(tx, launch).map(|_| true)).map(|_| ())
    }

    /// The batch write plus `also`, in one IMMEDIATE transaction; committed
    /// only when `also` answers true.
    fn save_batch_with(&mut self, b: &mut Batch, also: impl FnOnce(&rusqlite::Transaction, &Batch) -> Result<bool, String>) -> Result<bool, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("batch transaction: {e}"))?;
        keep_released(&tx, b)?;
        let value = serde_json::to_string(&*b).map_err(|e| format!("encode batch: {e}"))?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![format!("{OPEN}{}", b.socket), value],
        )
        .map_err(|e| format!("write batch: {e}"))?;
        if !also(&tx, b)? {
            return Ok(false);
        }
        tx.commit().map_err(|e| format!("commit batch: {e}"))?;
        Ok(true)
    }

    /// Close the batch: it becomes the socket's `restore_last` and the open
    /// key goes, in one transaction.
    pub fn close_batch(&mut self, b: &mut Batch) -> Result<(), String> {
        self.close_batch_reporting(b, |_| Vec::new()).map(|_| ())
    }

    /// Write the batch and record the `lines` built from it as stored —
    /// merged with any release meanwhile (board #422 round 4: a project's
    /// report, its message id its identity) — in ONE transaction. The rows
    /// this call inserted come back for the caller to push after the commit;
    /// a line already recorded inserts nothing.
    pub fn save_batch_reporting(&mut self, b: &mut Batch, lines: impl FnOnce(&Batch) -> Vec<OnceLine>) -> Result<Vec<HubMsg>, String> {
        let mut inserted = Vec::new();
        self.save_batch_with(b, |tx, merged| {
            inserted = report_in(tx, &lines(merged))?;
            Ok(true)
        })?;
        report_hook(2)?;
        Ok(inserted)
    }

    /// `close_batch` and `lines` in the same transaction.
    pub fn close_batch_reporting(&mut self, b: &mut Batch, lines: impl FnOnce(&Batch) -> Vec<OnceLine>) -> Result<Vec<HubMsg>, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("batch transaction: {e}"))?;
        keep_released(&tx, b)?;
        let value = serde_json::to_string(&*b).map_err(|e| format!("encode batch: {e}"))?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![format!("{LAST}{}", b.socket), value],
        )
        .map_err(|e| format!("write last batch: {e}"))?;
        tx.execute("DELETE FROM meta WHERE key = ?1", params![format!("{OPEN}{}", b.socket)])
            .map_err(|e| format!("drop open batch: {e}"))?;
        let inserted = report_in(&tx, &lines(b))?;
        tx.commit().map_err(|e| format!("commit batch close: {e}"))?;
        report_hook(2)?;
        Ok(inserted)
    }

    /// A person's retry (board #422 round 4): the socket's last closed batch
    /// becomes its OPEN batch again as `b` (a new attempt), with `holds`
    /// planned, in ONE transaction — only while no batch is open, the stored
    /// last batch is still exactly `expected` (the bytes the admission read:
    /// a release that marked a window meanwhile is never overwritten), and
    /// each planned hold's slot still holds exactly what the admission saw
    /// there: no row (`None`), or that one generation (round 4 review P1-B:
    /// a restart or spawn installs a generation without the restore lock and
    /// without touching the batch). `false` = nothing written.
    pub fn reopen_batch(&mut self, expected: &str, b: &Batch, holds: &[(Hold, Option<String>)]) -> Result<bool, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("batch transaction: {e}"))?;
        let rev = revision_in(&tx, &b.socket)?;
        if rev.open.is_some() || rev.last.as_deref() != Some(expected) {
            return Ok(false);
        }
        for (h, seen) in holds {
            let mut stmt = tx
                .prepare("SELECT launch FROM restore_holds WHERE socket = ?1 AND project_id = ?2 AND slot = ?3")
                .map_err(|e| format!("read holds: {e}"))?;
            let now: Vec<String> = stmt
                .query_map(params![h.socket, h.project_id, h.slot], |r| r.get(0))
                .map_err(|e| format!("read holds: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("read holds: {e}"))?;
            if now != seen.iter().cloned().collect::<Vec<_>>() {
                return Ok(false);
            }
        }
        let value = serde_json::to_string(b).map_err(|e| format!("encode batch: {e}"))?;
        tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", params![format!("{OPEN}{}", b.socket), value])
            .map_err(|e| format!("write batch: {e}"))?;
        tx.execute("DELETE FROM meta WHERE key = ?1", params![format!("{LAST}{}", b.socket)])
            .map_err(|e| format!("drop last batch: {e}"))?;
        for (h, _) in holds {
            super::restore_hold::insert_hold(&tx, h)?;
        }
        tx.commit().map_err(|e| format!("commit batch reopen: {e}"))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch() -> Batch {
        Batch {
            batch: "0f8e1c2a-1111-4222-8333-444455556666".into(),
            socket: "/s".into(),
            boot_id: Some("boot".into()),
            owner_pid: 1, attempt: 0,
            instance: None,
            source: Checkpoint { gen: 3, at: 1, boot_id: Some("old".into()), tmux: None, projects: vec![] },
            closed: None,
            projects: vec![BatchProject {
                id: "p".into(),
                name: "p".into(),
                path: "/w/p".into(),
                session: "p".into(),
                autostart_only: false,
                state: ProjectState::Pending,
                reason: None,
                session_id: None,
                holder_id: None,
                op: None,
                finished: None,
                windows: vec![],
            }],
        }
    }

    /// The batch round-trips whole; closing moves it to `restore_last` and
    /// leaves no open batch, in one transaction.
    #[test]
    fn a_batch_round_trips_and_closing_moves_it() {
        let mut store = Store::open_memory().unwrap();
        assert_eq!(store.restore_batch("/s").unwrap(), None);
        let mut b = batch();
        store.save_batch(&mut b.clone()).unwrap();
        b.projects[0].state = ProjectState::CreatingSession;
        b.projects[0].op = Some(BatchOp::Claim);
        store.save_batch(&mut b.clone()).unwrap();
        assert_eq!(store.restore_batch("/s").unwrap(), Some(b.clone()), "the issued step is on record");
        b.closed = Some("done".into());
        store.close_batch(&mut b.clone()).unwrap();
        assert_eq!(store.restore_batch("/s").unwrap(), None);
        assert_eq!(store.last_batch("/s").unwrap(), Some(b));
        store.meta_set("restore_batch:/s", "{").unwrap();
        assert!(store.restore_batch("/s").is_err(), "unreadable progress is an error, not 'no batch'");
    }

    /// P1-A residual, the commit side across connections: a scan, then
    /// another connection (another gateway on the same state.db) opens a
    /// batch; the commit made under the scan refuses, and the previous
    /// checkpoint stands. The scan side is `a_tick_that_scanned_under_another_
    /// batch_state_commits_nothing` (the capture tick, through `SCAN_HOOK`).
    #[test]
    fn a_batch_opened_by_another_connection_after_a_scan_voids_its_commit() {
        let dir = std::env::temp_dir().join(format!("tmm-scan-{}", uuid::Uuid::new_v4()));
        let path = dir.join("state.db");
        let mut ours = Store::open(&path).unwrap();
        let mut theirs = Store::open(&path).unwrap();
        let mut old = batch();
        old.closed = Some("done".into());
        ours.close_batch(&mut old.clone()).unwrap();
        let cp = || Checkpoint { gen: 0, at: 1, boot_id: Some("boot".into()), tmux: None, projects: vec![] };
        let gen = ours.commit_tick(&[], Some(("/s", cp()))).unwrap();
        let scan = ours.batch_scan("/s").unwrap();
        assert_eq!(scan.open, Ok(None));
        assert_eq!(scan.last, Ok(Some(old)));
        theirs.save_batch(&mut batch().clone()).unwrap();
        assert_eq!(ours.commit_scanned(&[], Some(("/s", cp())), Some(("/s", &scan.revision, Some("boot")))).unwrap(), None, "a stale scan commits nothing");
        assert_eq!(ours.checkpoint("/s").unwrap().unwrap().gen, gen.unwrap(), "the previous checkpoint stands");
        // Control: a scan of the current state commits.
        let now = ours.batch_scan("/s").unwrap();
        assert_eq!(now.open, Ok(Some(batch())));
        assert!(ours.commit_scanned(&[], Some(("/s", cp())), Some(("/s", &now.revision, Some("boot")))).unwrap().is_some());
        drop((ours, theirs));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Each value decodes on its own: an unreadable last batch is its `Err`
    /// while the open one still reads, both from the scanned bytes.
    #[test]
    fn a_scan_decodes_each_batch_from_the_bytes_it_compares() {
        let mut store = Store::open_memory().unwrap();
        store.save_batch(&mut batch().clone()).unwrap();
        store.meta_set("restore_last:/s", "{").unwrap();
        let scan = store.batch_scan("/s").unwrap();
        assert_eq!(scan.open, Ok(Some(batch())));
        assert!(scan.last.is_err());
        assert_eq!(scan.revision.last.as_deref(), Some("{"));
        assert_eq!(scan.revision.open, Some(serde_json::to_string(&batch()).unwrap()));
    }
}
