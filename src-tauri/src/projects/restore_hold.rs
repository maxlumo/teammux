//! The input barrier of a restored agent window, read (board #422 round 3).
//!
//! A hold (`store/restore_hold.rs`) is the barrier of ONE incarnation: this
//! socket's tmux instance and the native pane the restore made. `held` is
//! the one question every typer asks before typing into an agent window —
//! `delivery::strict_occupied` for every delivery and flush, and
//! `hub_command` for a /command — and `prune` retires the holds whose
//! object is confirmed gone. Round 3's first hand-off has no release: a hold
//! lasts until its pane ends.

use super::store::{Hold, HoldStage};
use super::{restore, with_store};
use crate::tmux;

/// What a hold's object is now, observed on this gateway's socket.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seen {
    /// The hold's own pane, same instance, same pane process; and where it
    /// is now (it may have been renamed or moved).
    Alive { session: String, window_name: String },
    /// Confirmed gone: the pane is not in this instance, or the instance
    /// itself is gone. The hold is void and may be retired.
    Ended,
    /// Anything else, an error included: held, never void.
    Unknown,
}

/// Every pane of the socket's server, with the server's identity in the same
/// answer: `None` = no server; `Err` = it could not be read. ONE listing,
/// never a `display-message -t %N`, which on tmux 3.6a answers for ANOTHER
/// pane when `%N` is gone (measured: `display -p -t %99999 x` prints `x`).
struct Listing {
    instance: (u32, u64),
    /// pane id → (pane pid, session name, window name).
    panes: std::collections::HashMap<String, (String, String, String)>,
}

fn list(socket: &str) -> Result<Option<Listing>, String> {
    let fmt = "#{pid}\t#{start_time}\t#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_name}";
    let out = match tmux::run_tmux_on(Some(socket), &["list-panes", "-a", "-F", fmt]) {
        Ok(out) => out,
        Err(e) if tmux::session_confirmed_absent(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut instance = None;
    let mut panes = std::collections::HashMap::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.splitn(6, '\t').collect();
        let [pid, start, pane, pane_pid, session, name] = f[..] else { return Err(format!("unreadable list-panes line: {line}")) };
        let here = (pid.parse::<u32>().map_err(|e| e.to_string())?, start.parse::<u64>().map_err(|e| e.to_string())?);
        if instance.is_some_and(|i| i != here) {
            return Err("two servers answered one listing".into());
        }
        instance = Some(here);
        panes.insert(pane.to_string(), (pane_pid.to_string(), session.to_string(), name.to_string()));
    }
    // A server with no pane does not exist: tmux exits with its last session.
    Ok(instance.map(|instance| Listing { instance, panes }))
}

fn observe(h: &Hold, now: &Result<Option<Listing>, String>) -> Seen {
    let Some(p) = &h.pane else { return Seen::Unknown };
    match now {
        Err(_) => Seen::Unknown,
        Ok(None) => Seen::Ended,
        Ok(Some(l)) if l.instance != (p.instance.pid, p.instance.start_time) => Seen::Ended,
        Ok(Some(l)) => match l.panes.get(&p.pane_id) {
            None => Seen::Ended,
            Some((pid, session, name)) if *pid == p.pane_pid.to_string() => Seen::Alive { session: session.clone(), window_name: name.clone() },
            Some(_) => Seen::Unknown,
        },
    }
}

/// Is this pane (of this instance) still on the socket's server, wherever
/// it is? `Some(true)` = confirmed ended (not in this instance, or the
/// instance is gone), `Some(false)` = alive, `None` = cannot tell. The one
/// judgment a restore's kill observation and the barrier share.
pub(crate) fn pane_ended(socket: &str, pane: &super::store::HoldPane) -> Option<bool> {
    let h = Hold {
        socket: socket.to_string(),
        project_id: String::new(),
        batch: String::new(),
        ord: 0,
        slot: String::new(),
        launch: String::new(),
        stage: HoldStage::Bound,
        pane: Some(pane.clone()),
        since: 0,
    };
    match observe(&h, &list(socket)) {
        Seen::Ended => Some(true),
        Seen::Alive { .. } => Some(false),
        Seen::Unknown => None,
    }
}

/// Is typing into `session`'s window `window` held by a restore? Every live
/// hold of this SOCKET is asked, so a window moved to another session keeps
/// its barrier. A planned hold holds its slot's name in its project; a bound
/// or armed one holds while its native pane is alive — wherever it is and
/// whatever it is called now — for that pane's window and for its slot's
/// name. An answer that cannot be read holds every window (review H1
/// P1-B): it cannot exclude that the target is the hold's pane. A store that
/// cannot be read holds too.
pub fn held(session: &str, window: &str) -> bool {
    let socket = restore::socket_key();
    let holds = match with_store(|s| s.socket_holds(&socket)) {
        Ok(h) => h,
        Err(_) => return true,
    };
    if holds.is_empty() {
        return false;
    }
    // The project this session is, for a slot-name match; unreadable: any.
    let project = super::project_for_session(session).map(|p| p.map(|p| p.id));
    let in_project = |h: &Hold| match &project {
        Ok(Some(id)) => *id == h.project_id,
        Ok(None) => false,
        Err(_) => true,
    };
    let now = list(&socket);
    holds.iter().any(|h| match h.stage {
        HoldStage::Planned => in_project(h) && h.slot == window,
        HoldStage::Bound | HoldStage::Armed => match observe(h, &now) {
            Seen::Alive { session: s, window_name } => (s == session && window_name == window) || (in_project(h) && h.slot == window),
            Seen::Ended => false,
            Seen::Unknown => true,
        },
    })
}

/// Retire every hold of this socket whose object is confirmed gone, and every
/// planned hold whose batch is no longer the open one (it was never bound:
/// nothing was made for it). Each retire is conditional on the launch uuid
/// read. Run by the capture tick. Returns the retired launches.
pub fn prune() -> Vec<String> {
    let socket = restore::socket_key();
    let Ok(holds) = with_store(|s| s.socket_holds(&socket)) else { return Vec::new() };
    if holds.is_empty() {
        return Vec::new();
    }
    let open = with_store(|s| s.restore_batch(&socket)).ok();
    let now = list(&socket);
    let mut retired = Vec::new();
    for h in holds {
        let gone = match h.stage {
            HoldStage::Planned => matches!(&open, Some(o) if o.as_ref().map(|b| b.batch.as_str()) != Some(h.batch.as_str())),
            HoldStage::Bound | HoldStage::Armed => observe(&h, &now) == Seen::Ended,
        };
        #[cfg(test)]
        if gone {
            if let Some(hook) = PRUNE_HOOK.lock().unwrap().as_ref() {
                hook(&h);
            }
        }
        // Conditional on the snapshot the verdict was made from — the same
        // generation AND the same stage and pane (review H1 P1-C): a planned
        // row that was bound and armed meanwhile is not the row judged.
        if gone && with_store(|s| s.retire_hold_as_seen(&h)).unwrap_or(false) {
            retired.push(h.launch);
        }
    }
    retired
}

/// Test seam: runs between prune's verdict on a hold and its retire.
#[cfg(test)]
pub(crate) static PRUNE_HOOK: std::sync::Mutex<Option<Box<dyn Fn(&Hold) + Send>>> = std::sync::Mutex::new(None);

/// The store, for tests outside `projects` that stage a hold.
#[cfg(test)]
pub(crate) fn with_store_for_test<T>(f: impl FnOnce(&mut super::store::Store) -> Result<T, String>) -> Result<T, String> {
    with_store(f)
}
