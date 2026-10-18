//! The restore evidence (board #422): the last COMPLETE observation of a tmux
//! server, and the durable intents a person's down and Stop leave behind.
//!
//! One family of the store (board #147). All of it lives in `meta`:
//!
//! * `restore_checkpoint:<socket>` — ONE JSON value per tmux socket, written
//!   by the capture tick in the SAME transaction as the slot folds it was
//!   observed with (`commit_tick`), and only when that tick saw the whole
//!   server (`projects::restore::checkpoint_from`): a refused fold or a crash
//!   leaves the previous checkpoint and the previous slots together;
//! * `restore_checkpoint_prev:<socket>` — the last checkpoint that saw a
//!   server, kept while the latest saw none (a tmux death in the last tick
//!   before a reboot must not erase the evidence);
//! * `project_down:<id>` — written BEFORE `down` kills the session;
//! * `slot_stopped:<id>:<window>` — written BEFORE a managed agent's Stop kills
//!   its window.
//!
//! An intent's value is its VERSION, from the monotonic `restore_intent_seq`
//! counter (never a clock: two acts in one second are two versions). A start
//! reads the versions it may clear at its beginning and clears exactly those
//! at its end (`clear_*_if`), so a down or Stop written while it ran stands.
//!
//! Project ids are `slug-digest` (no `:`), so the first `:` after the prefix
//! splits a stopped key into its project and its window.

use super::*;
use std::collections::HashSet;

/// Which tmux server a checkpoint saw: its socket and the server process'
/// identity on it. A new server on the same socket has another pid or start
/// time, so "the server that held the sessions is gone" is derived from this,
/// never from a clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxInstance {
    pub socket: String,
    pub pid: u32,
    pub start_time: u64,
}

/// One window that was LIVE when the checkpoint was taken, as the slot fold
/// of the same transaction declared it. `managed` is the window's provenance
/// at that moment (`is_managed_in`): a managed agent may only come back
/// through its own recipe, never the bare backend line. `backend` and
/// `agent_session_id` are the declared agent identity the planner must find
/// unchanged (both `None` for a shell).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointWindow {
    pub name: String,
    pub kind: SlotKind,
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointProject {
    pub id: String,
    pub session: String,
    pub windows: Vec<CheckpointWindow>,
}

/// The last complete observation of one tmux socket. `tmux: None` with no
/// projects is the honest record of "no server was running": the last tick
/// before a reboot then says nothing was up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// Assigned by `publish_checkpoint`: one more than the socket's previous.
    pub gen: u64,
    /// Unix seconds of the tick (for the explanation only; nothing compares it).
    pub at: u64,
    /// The host's boot identity at the tick; `None` when it could not be read.
    pub boot_id: Option<String>,
    pub tmux: Option<TmuxInstance>,
    pub projects: Vec<CheckpointProject>,
}

/// The durable intents the planner subtracts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreIntents {
    /// Projects a person took down.
    pub down: HashSet<String>,
    /// `(project id, window)` of managed agents a person stopped.
    pub stopped: HashSet<(String, String)>,
}

const CHECKPOINT: &str = "restore_checkpoint:";
const CHECKPOINT_PREV: &str = "restore_checkpoint_prev:";
const DOWN: &str = "project_down:";
const STOPPED: &str = "slot_stopped:";
const INTENT_SEQ: &str = "restore_intent_seq";

impl Store {
    /// One capture tick's writes, in ONE IMMEDIATE transaction: the checkpoint
    /// (numbered one past the socket's previous) and every slot fold of the
    /// tick. Any failure rolls the whole tick back, so the checkpoint never
    /// describes slots that were not written with it. `checkpoint: None` (an
    /// incomplete observation) folds and advances no evidence. Returns the
    /// published gen.
    pub fn commit_tick(&mut self, folds: &[(String, Vec<Slot>)], checkpoint: Option<(&str, Checkpoint)>) -> Result<Option<u64>, String> {
        Ok(self.commit_scanned(folds, checkpoint, None)?.flatten())
    }

    /// `commit_tick` for a tick that SCANNED with a snapshot of the socket's
    /// restore batches (`batch_scan`): the batches are read again INSIDE
    /// the same IMMEDIATE transaction, and when either changed since the scan
    /// (a restore opened, advanced or closed meanwhile — in this process or
    /// another gateway on the same state.db) the tick commits NOTHING and
    /// answers `Ok(None)` (review round 2, P1-A residual). The batch writer
    /// takes the same write lock, so no restore can begin between this check
    /// and the commit.
    pub fn commit_scanned(&mut self, folds: &[(String, Vec<Slot>)], checkpoint: Option<(&str, Checkpoint)>, scan: Option<(&str, &super::BatchRevision)>) -> Result<Option<Option<u64>>, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("tick transaction: {e}"))?;
        if let Some((socket, seen)) = scan {
            if super::restore_batch::revision_in(&tx, socket)? != *seen {
                return Ok(None);
            }
        }
        let gen = match checkpoint {
            Some((socket, cp)) => Some(write_checkpoint(&tx, socket, cp)?),
            None => None,
        };
        for (id, slots) in folds {
            super::projects::write_slots(&tx, id, slots)?;
        }
        tx.commit().map_err(|e| format!("commit tick: {e}"))?;
        Ok(Some(gen))
    }

    /// The socket's checkpoint. `Ok(None)` = none was ever published (the
    /// first start after the upgrade); an unreadable value is an `Err`, which
    /// a restore treats as "unknown" and acts on nothing.
    pub fn checkpoint(&self, socket: &str) -> Result<Option<Checkpoint>, String> {
        match self.meta_get(&format!("{CHECKPOINT}{socket}"))? {
            None => Ok(None),
            Some(v) => serde_json::from_str(&v).map(Some).map_err(|e| format!("unreadable checkpoint for {socket}: {e}")),
        }
    }

    /// The last checkpoint that saw a server, kept while the latest saw none
    /// (`restore_checkpoint_prev:<socket>`); `None` otherwise.
    pub fn checkpoint_prev(&self, socket: &str) -> Result<Option<Checkpoint>, String> {
        match self.meta_get(&format!("{CHECKPOINT_PREV}{socket}"))? {
            None => Ok(None),
            Some(v) => serde_json::from_str(&v).map(Some).map_err(|e| format!("unreadable previous checkpoint for {socket}: {e}")),
        }
    }

    /// Record a person's down; returns the mark's version.
    pub fn set_project_down(&mut self, id: &str) -> Result<u64, String> {
        self.set_intent(&format!("{DOWN}{id}"))
    }

    /// Record a person's Stop of one agent; returns the mark's version.
    pub fn set_slot_stopped(&mut self, id: &str, window: &str) -> Result<u64, String> {
        self.set_intent(&format!("{STOPPED}{id}:{window}"))
    }

    pub fn project_down_version(&self, id: &str) -> Result<Option<String>, String> {
        self.meta_get(&format!("{DOWN}{id}"))
    }

    pub fn slot_stopped_version(&self, id: &str, window: &str) -> Result<Option<String>, String> {
        self.meta_get(&format!("{STOPPED}{id}:{window}"))
    }

    /// Clear the down mark only if it is still `version`; `true` if cleared.
    pub fn clear_project_down_if(&self, id: &str, version: &str) -> Result<bool, String> {
        self.clear_intent_if(&format!("{DOWN}{id}"), version)
    }

    /// Clear one Stop mark only if it is still `version`; `true` if cleared.
    pub fn clear_slot_stopped_if(&self, id: &str, window: &str, version: &str) -> Result<bool, String> {
        self.clear_intent_if(&format!("{STOPPED}{id}:{window}"), version)
    }

    /// Forget one agent's Stop whatever its version: the agent itself is
    /// being removed (`agent_remove`), so there is nothing left to suppress.
    pub fn forget_slot_stopped(&self, id: &str, window: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM meta WHERE key = ?1", params![format!("{STOPPED}{id}:{window}")])
            .map(|_| ())
            .map_err(|e| format!("forget stop intent: {e}"))
    }

    /// The next version and the mark, in one IMMEDIATE transaction: two
    /// writers (two gateways on one state.db) can never share a version.
    fn set_intent(&mut self, key: &str) -> Result<u64, String> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("intent transaction: {e}"))?;
        let prev: Option<String> = tx
            .query_row("SELECT value FROM meta WHERE key = ?1", params![INTENT_SEQ], |r| r.get(0))
            .optional()
            .map_err(|e| format!("read intent counter: {e}"))?;
        let version = prev.and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) + 1;
        for (k, v) in [(INTENT_SEQ, version.to_string()), (key, version.to_string())] {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![k, v],
            )
            .map_err(|e| format!("write intent: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit intent: {e}"))?;
        Ok(version)
    }

    fn clear_intent_if(&self, key: &str, version: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM meta WHERE key = ?1 AND value = ?2", params![key, version])
            .map(|n| n > 0)
            .map_err(|e| format!("clear intent: {e}"))
    }

    /// Every down and Stop intent, read in one statement so the planner sees
    /// one consistent set.
    pub fn restore_intents(&self) -> Result<RestoreIntents, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT key FROM meta WHERE substr(key, 1, length(?1)) = ?1 OR substr(key, 1, length(?2)) = ?2")
            .map_err(|e| format!("read intents: {e}"))?;
        let keys = stmt
            .query_map(params![DOWN, STOPPED], |r| r.get::<_, String>(0))
            .map_err(|e| format!("read intents: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read intents: {e}"))?;
        let mut out = RestoreIntents::default();
        for key in keys {
            if let Some(id) = key.strip_prefix(DOWN) {
                out.down.insert(id.to_string());
            } else if let Some((id, window)) = key.strip_prefix(STOPPED).and_then(|rest| rest.split_once(':')) {
                out.stopped.insert((id.to_string(), window.to_string()));
            }
        }
        Ok(out)
    }
}

/// Write `cp` as the socket's checkpoint inside the caller's transaction,
/// numbered one past the value it replaces (an unreadable previous value
/// restarts the numbering; it is replaced by a readable one either way).
fn write_checkpoint(tx: &rusqlite::Transaction<'_>, socket: &str, mut cp: Checkpoint) -> Result<u64, String> {
    let key = format!("{CHECKPOINT}{socket}");
    let prev: Option<String> = tx
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| format!("read checkpoint: {e}"))?;
    let prev_cp = prev.and_then(|v| serde_json::from_str::<Checkpoint>(&v).ok());
    let prev_gen = prev_cp.as_ref().map(|c| c.gen).unwrap_or(0);
    cp.gen = prev_gen + 1;
    // A tick that finds no server keeps the last evidence of a server
    // (orchestrator's F4 decision): tmux dying in the last tick before a
    // reboot must not erase what was up. A tick that sees a server again
    // makes the kept one stale.
    let kept = format!("{CHECKPOINT_PREV}{socket}");
    match (&cp.tmux, prev_cp) {
        (None, Some(last)) if last.tmux.is_some() => {
            let value = serde_json::to_string(&last).map_err(|e| format!("encode checkpoint: {e}"))?;
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![kept, value],
            )
            .map_err(|e| format!("keep previous checkpoint: {e}"))?;
        }
        (None, _) => {}
        (Some(_), _) => {
            tx.execute("DELETE FROM meta WHERE key = ?1", params![kept]).map_err(|e| format!("drop previous checkpoint: {e}"))?;
        }
    }
    let value = serde_json::to_string(&cp).map_err(|e| format!("encode checkpoint: {e}"))?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map_err(|e| format!("write checkpoint: {e}"))?;
    Ok(cp.gen)
}

/// The intent keys a permanently deleted project takes with it, for
/// `delete_project`'s transaction: its down mark, and its stopped agents
/// (the trailing `:` keeps `abc` from matching `abc1`).
pub(super) fn intent_keys(id: &str) -> (String, String) {
    (format!("{DOWN}{id}"), format!("{STOPPED}{id}:"))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn win(name: &str) -> CheckpointWindow {
        CheckpointWindow { name: name.into(), kind: SlotKind::Shell, managed: false, backend: None, agent_session_id: None }
    }

    fn cp(projects: &[&str]) -> Checkpoint {
        Checkpoint {
            gen: 0,
            at: 1_000,
            boot_id: Some("boot-a".into()),
            tmux: Some(TmuxInstance { socket: "/s".into(), pid: 7, start_time: 900 }),
            projects: projects
                .iter()
                .map(|id| CheckpointProject { id: (*id).into(), session: (*id).into(), windows: vec![win("w")] })
                .collect(),
        }
    }

    /// A checkpoint is one value per socket, replaced whole and numbered; the
    /// other socket's is untouched, and an unreadable value is an error, not
    /// "nothing was up".
    #[test]
    fn a_checkpoint_is_replaced_whole_per_socket_and_numbered() {
        let mut store = Store::open_memory().unwrap();
        assert_eq!(store.checkpoint("/s").unwrap(), None, "none published yet: the first start after the upgrade");

        assert_eq!(store.commit_tick(&[], Some(("/s", cp(&["a", "b"])))).unwrap(), Some(1));
        assert_eq!(store.commit_tick(&[], Some(("/s", cp(&["a"])))).unwrap(), Some(2));
        let got = store.checkpoint("/s").unwrap().unwrap();
        assert_eq!(got.gen, 2);
        assert_eq!(got.projects.len(), 1, "replaced, not merged");
        // Control: an incomplete tick advances nothing; another socket has its own numbering.
        assert_eq!(store.commit_tick(&[], None).unwrap(), None);
        assert_eq!(store.commit_tick(&[], Some(("/other", cp(&["x"])))).unwrap(), Some(1));
        assert_eq!(store.checkpoint("/s").unwrap().unwrap().gen, 2);

        store.meta_set("restore_checkpoint:/s", "{not json").unwrap();
        assert!(store.checkpoint("/s").is_err(), "unreadable is unknown");
        assert_eq!(store.commit_tick(&[], Some(("/s", cp(&[])))).unwrap(), Some(1), "a readable value replaces it");
    }

    /// F4 decision: a tick that finds no server keeps the last checkpoint
    /// that saw one; a further empty tick keeps it still; a tick that sees a
    /// server again drops it.
    #[test]
    fn an_empty_tick_keeps_the_last_evidence_of_a_server() {
        let mut store = Store::open_memory().unwrap();
        let mut absent = cp(&[]);
        absent.tmux = None;
        store.commit_tick(&[], Some(("/s", cp(&["a"])))).unwrap();
        assert_eq!(store.checkpoint_prev("/s").unwrap(), None, "control: nothing kept while a server is seen");
        store.commit_tick(&[], Some(("/s", absent.clone()))).unwrap();
        let kept = store.checkpoint_prev("/s").unwrap().expect("the server's last checkpoint is kept");
        assert_eq!((kept.gen, kept.projects.len()), (1, 1));
        store.commit_tick(&[], Some(("/s", absent.clone()))).unwrap();
        assert_eq!(store.checkpoint_prev("/s").unwrap().map(|c| c.gen), Some(1), "an empty tick never replaces it");
        assert_eq!(store.checkpoint("/s").unwrap().unwrap().gen, 3);
        store.commit_tick(&[], Some(("/s", cp(&[])))).unwrap();
        assert_eq!(store.checkpoint_prev("/s").unwrap(), None, "a server seen again makes it stale");
    }

    /// Board #422 review P1-B: the checkpoint and the folds it was observed
    /// with are ONE transaction. A fold the store refuses AFTER the checkpoint
    /// was written (here: two slots with one name, the UNIQUE constraint)
    /// rolls back the checkpoint AND every other fold of the tick — the
    /// previous checkpoint and the previous slots stay together.
    #[test]
    fn a_refused_fold_rolls_back_the_checkpoint_and_the_whole_tick() {
        let mut store = Store::open_memory().unwrap();
        store.insert_project(&project("a")).unwrap();
        store.insert_project(&project("b")).unwrap();
        assert_eq!(store.commit_tick(&[("a".into(), vec![slot("old", 0)])], Some(("/s", cp(&["a"])))).unwrap(), Some(1));

        let folds = vec![
            ("a".to_string(), vec![slot("new", 0)]),
            ("b".to_string(), vec![slot("dup", 0), slot("dup", 1)]),
        ];
        assert!(store.commit_tick(&folds, Some(("/s", cp(&["a", "b"])))).is_err(), "the store refused b's fold");
        let kept = store.checkpoint("/s").unwrap().unwrap();
        assert_eq!((kept.gen, kept.projects.len()), (1, 1), "the previous checkpoint stands");
        let names: Vec<String> = store.slots("a").unwrap().into_iter().map(|s| s.window_name).collect();
        assert_eq!(names, ["old"], "and a's previous slots with it: no new evidence beside old slots, nor the reverse");

        // Control: the same tick without the refused fold commits both together.
        assert_eq!(store.commit_tick(&folds[..1], Some(("/s", cp(&["a"])))).unwrap(), Some(2));
        assert_eq!(store.slots("a").unwrap()[0].window_name, "new");
    }

    /// Down and Stop intents carry a version from one monotonic counter; a
    /// conditional clear removes only the version it names (P1-A), and a name
    /// that merely starts with another is another identity.
    #[test]
    fn intents_are_versioned_cleared_conditionally_and_scoped_exactly() {
        let mut store = Store::open_memory().unwrap();
        store.insert_project(&project("abc")).unwrap();
        store.insert_project(&project("abc1")).unwrap();
        let v1 = store.set_project_down("abc").unwrap();
        let v2 = store.set_project_down("abc").unwrap();
        assert!(v2 > v1, "two downs, even in one second, are two versions");
        store.set_slot_stopped("abc", "dev").unwrap();
        store.set_slot_stopped("abc", "dev:2").unwrap();
        store.set_slot_stopped("abc1", "dev").unwrap();
        let got = store.restore_intents().unwrap();
        assert!(got.down.contains("abc") && !got.down.contains("abc1"));
        assert!(got.stopped.contains(&("abc".into(), "dev".into())));
        assert!(got.stopped.contains(&("abc".into(), "dev:2".into())), "a window name may hold ':'");
        assert!(got.stopped.contains(&("abc1".into(), "dev".into())));

        // A clear of an older version is a no-op; the current version clears.
        assert!(!store.clear_project_down_if("abc", &v1.to_string()).unwrap());
        assert!(store.restore_intents().unwrap().down.contains("abc"), "the later down stands");
        assert_eq!(store.project_down_version("abc").unwrap(), Some(v2.to_string()));
        assert!(store.clear_project_down_if("abc", &v2.to_string()).unwrap());
        let dev = store.slot_stopped_version("abc", "dev").unwrap().unwrap();
        assert!(store.clear_slot_stopped_if("abc", "dev", &dev).unwrap());
        let got = store.restore_intents().unwrap();
        assert!(got.down.is_empty());
        assert!(!got.stopped.contains(&("abc".into(), "dev".into())));
        assert!(got.stopped.contains(&("abc1".into(), "dev".into())), "control: the other identity keeps its mark");
        store.forget_slot_stopped("abc", "dev:2").unwrap();

        // A permanently deleted project takes its intents with it; abc1 keeps its own.
        store.set_project_down("abc").unwrap();
        assert!(store.delete_project("abc").unwrap());
        let got = store.restore_intents().unwrap();
        assert!(got.down.is_empty(), "delete forgets the down mark");
        assert_eq!(got.stopped, HashSet::from([("abc1".to_string(), "dev".to_string())]));
    }
}
