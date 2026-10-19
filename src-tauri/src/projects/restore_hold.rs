//! The input barrier of a restored agent window, read (board #422 round 3).
//!
//! A hold (`store/restore_hold.rs`) is the barrier of ONE incarnation: this
//! socket's tmux instance and the native pane the restore made. `held` is
//! the one question every typer asks before typing into an agent window —
//! `delivery::strict_occupied` for every delivery and flush, and
//! `hub_command` for a /command — and `prune` retires the holds whose
//! object is confirmed gone. A hold is released only on measured positive
//! evidence of its own launch (`evidence_for`, `on_prompt`,
//! `on_session_start`, `release_ready`); released, it stays recorded until
//! its pane ends, so a late envelope of another launch is still told apart.

use super::store::{Hold, HoldStage};
use super::{restore, with_store};
use crate::tmux;

/// What may release a held window: the backend's own measured evidence
/// (`Backend::restore_evidence`; the table is in projects.md). A backend
/// with none stays held until a person's own prompt (the accepted
/// `UserPromptSubmit` of this launch) releases it.
pub use crate::backends::RestoreEvidence as Evidence;

pub fn evidence_for(backend: &str) -> Option<Evidence> {
    crate::backends::Backend::parse(backend).and_then(|b| b.restore_evidence())
}

/// The backend a hold's slot runs, from its recipe (`launch.json`).
/// `Ok(None)`: confirmed none (no project, no home, no recipe, no backend
/// named); `Err`: it cannot be read now (H2 review P1-C residual).
fn backend_of(h: &Hold) -> Result<Option<(String, std::path::PathBuf)>, String> {
    let Some(project) = with_store(|s| s.project(&h.project_id))? else { return Ok(None) };
    let Some(home) = super::agents::home_dir(&project.path, &h.slot) else { return Ok(None) };
    let text = match std::fs::read_to_string(home.join("launch.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}'s recipe cannot be read: {e}", h.slot)),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}'s recipe cannot be read: {e}", h.slot))?;
    Ok(v.get("backend").and_then(|b| b.as_str()).map(|b| (b.to_string(), home)))
}

/// An armed hold whose backend's evidence is its own readiness file (dsh):
/// is that file naming THIS launch for this pane's process?
fn ready(h: &Hold) -> bool {
    if h.stage != HoldStage::Armed {
        return false;
    }
    let (Some(p), Ok(Some((backend, home)))) = (&h.pane, backend_of(h)) else { return false };
    if evidence_for(&backend) != Some(Evidence::Readiness) {
        return false;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return crate::backends::dsh::input_ready_for_launch(&home, Some(p.pane_pid), &h.launch);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (p, home);
        false
    }
}

/// What one release attempt did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Release {
    Released,
    /// The evidence was accepted but the window does not carry the slot's
    /// name yet: still held, the capture tick retries.
    Merging,
    /// Nothing changed (not armed, its pane not seen alive, or replaced
    /// meanwhile).
    Not,
}

/// Release an armed hold whose positive evidence of THIS launch was
/// accepted (board #422 round 3), in the design's order: the window's
/// ownership is confirmed in the server and it takes the slot's name, on
/// every path (`merge_held`, H2 review P1-D); the slot's name in its
/// project's session must lead to THIS pane, the one a flush would type into;
/// only then is the hold released with its batch record, in one transaction.
/// The caller flushes; nothing here types. Anything short of that — refused,
/// unconfirmed, another window answering to the slot's name — keeps the
/// hold, marks it merging (the tick retries) and tells the room once. `Err`:
/// a store read or write failed, so the evidence is NOT on record and the
/// caller keeps it for a retry (H2 review P1-C).
fn release(h: &Hold, now: &Result<Option<Listing>, String>) -> Result<Release, String> {
    if h.stage != HoldStage::Armed {
        return Ok(Release::Not);
    }
    let (session, window_name) = match observe(h, now) {
        Seen::Alive { session, window_name } => (session, window_name),
        // Its pane is gone: nothing to release any more.
        Seen::Ended => return Ok(Release::Not),
        // Cannot be verified now: the caller keeps its evidence and retries.
        Seen::Unknown => return Err(format!("the restored {}'s pane cannot be checked now", h.slot)),
    };
    let project = with_store(|s| s.project(&h.project_id))?;
    let pane = h.pane.as_ref().map(|p| p.pane_id.clone());
    let ours = super::restore_run::merge_held(h) == Some(true)
        && project.as_ref().is_some_and(|p| tmux::find_window_by_name(&p.session, &h.slot) == pane);
    if !ours {
        if with_store(|s| s.mark_hold_merging_if(&h.launch))? {
            let posted = project.as_ref().is_some_and(|project| post(project, &format!("[tmm] restored {} is running as {session}:{window_name}", h.slot)).is_ok());
            if !posted {
                let _ = with_store(|s| s.unclaim_merge_report(&h.launch));
            }
        }
        return Ok(Release::Merging);
    }
    Ok(if with_store(|s| s.release_hold_if(&h.launch, &[HoldStage::Armed]))? { Release::Released } else { Release::Not })
}

/// `release`, then the held lines of the logical slot flushed by its
/// existing busy/queue/steer rules, through the one send door, which from
/// now on binds this slot to the released generation's own pane (`held`,
/// `send_gate`; H2 review P1-D residuals).
fn release_and_flush(h: &Hold, now: &Result<Option<Listing>, String>) -> Result<Release, String> {
    let r = release(h, now)?;
    if r == Release::Released {
        #[cfg(test)]
        if let Some(hook) = AFTER_RELEASE.lock().unwrap().take() {
            hook();
        }
        if let Some(p) = with_store(|s| s.project(&h.project_id))? {
            super::delivery::flush(&p.session, &h.slot);
        }
    }
    Ok(r)
}

/// Test seam: runs once between a release and its flush.
#[cfg(test)]
pub(crate) static AFTER_RELEASE: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

/// The live hold of `launch` whose pane is `pane_id` on this socket.
fn hold_of(launch: &str, pane_id: &str) -> Result<Option<Hold>, String> {
    let h = with_store(|s| s.hold_by_launch(launch))?;
    Ok(h.filter(|h| h.socket == restore::socket_key() && h.pane.as_ref().is_some_and(|p| p.pane_id == pane_id)))
}

/// A prompt of this launch, recorded under the logical slot (board #422
/// round 3): while held nothing of ours is typed, so it is a person's. It
/// releases ANY backend, and only once its fact reached the log (`row`). Its
/// row, the hold's first accepted fact and "evidence accepted, release
/// pending" (`merging`) were committed together, under its generation
/// (`Store::settle_prompt_in` / `publish_activity_in`), so a release this
/// call cannot complete is completed by the capture tick. A write that
/// failed keeps the hold and flushes nothing.
pub fn on_prompt(launch: &str, pane_id: &str, row: Option<i64>) -> Result<Release, String> {
    if row.is_none() {
        return Ok(Release::Not);
    }
    let Some(h) = hold_of(launch, pane_id)? else { return Ok(Release::Not) };
    release_and_flush(&h, &list(&h.socket))
}

/// A `SessionStart` envelope of this launch: evidence where it was measured
/// to be (claude: any source; kimi: `resume` only, a restore always resumes).
/// It writes no fact, so an `Err` (a store read or write failed) keeps the
/// envelope for a retry: the one SessionStart is never consumed unrecorded.
pub fn on_session_start(launch: &str, pane_id: &str, source: Option<&str>) -> Result<Release, String> {
    let Some(h) = hold_of(launch, pane_id)? else { return Ok(Release::Not) };
    let counts = match backend_of(&h)?.and_then(|(backend, _)| evidence_for(&backend)) {
        Some(Evidence::SessionStart) => true,
        Some(Evidence::SessionStartResume) => source == Some("resume"),
        _ => false,
    };
    if !counts {
        return Ok(Release::Not);
    }
    release_and_flush(&h, &list(&h.socket))
}

/// One line in the project's room.
fn post(project: &super::store::Project, text: &str) -> Result<(), String> {
    let room = if project.room.is_empty() { format!("proj:{}", project.session) } else { project.room.clone() };
    super::rooms::post(&room, "tmm", text).map(|_| ())
}

/// What a hook envelope from a pane is, read against that pane's hold
/// (board #422 round 3). Applied to every event kind right after the pane
/// is resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attribution {
    /// No live hold of this pane: as today.
    Normal,
    /// This launch of a hold still blocking: every fact is the logical
    /// slot's, in its project's session, whatever the window is called now.
    Slot { session: String, slot: String, launch: String },
    /// This launch of a released hold: routed as today, its facts written
    /// only while the hold still carries this launch.
    Own { launch: String },
    /// Not this incarnation (another launch, or none): no fact, no ack, no
    /// reply edge. The reason is for the log.
    Drop(String),
    /// The hold or its pane cannot be read: the envelope is kept and tried
    /// again, never taken as normal and never dropped (H2 review P1-C).
    Unknown(String),
}

/// The rule (H2 review, STAGE ruling with its non-degradation clause): an
/// envelope that CARRIES a launch is attributed only by its generation — the
/// live hold row of that launch, on this socket, bound to this pane:
///
/// | envelope | hold row | answer |
/// |---|---|---|
/// | launch L | L's, this pane, bound/armed | `Slot` |
/// | launch L | L's, this pane, released | `Own` |
/// | launch L | none (retired, never, another pane or socket, its pane ended) | `Drop` |
/// | no launch | a live hold of this pane | `Drop` |
/// | no launch | none (or its pane confirmed ended) | `Normal` |
/// | either | cannot be read | `Unknown` |
///
/// A launch is never "legacy normal": a restore-launched CLI's envelope that
/// was checked before its pane was killed and its row retired, and attributed
/// after, writes nothing for the slot's next, ordinary incarnation.
/// `Slot` and `Own` only ROUTE: the consumer writes their facts under the
/// generation (`telemetry::with_generation`), so a replace between this
/// answer and the write writes nothing.
pub fn attribute(pane_id: &str, launch: Option<&str>) -> Attribution {
    let socket = restore::socket_key();
    if let Some(launch) = launch {
        let h = match with_store(|s| s.hold_by_launch(launch)) {
            Ok(Some(h)) if h.socket == socket && h.pane.as_ref().is_some_and(|p| p.pane_id == pane_id) => h,
            Ok(_) => return Attribution::Drop(format!("launch {launch} has no live restore generation on this pane")),
            Err(e) => return Attribution::Unknown(format!("the restore holds cannot be read ({e})")),
        };
        return match observe(&h, &list(&socket)) {
            Seen::Ended => Attribution::Drop(format!("the restored {}'s pane ended", h.slot)),
            Seen::Unknown => Attribution::Unknown(format!("the restored {}'s pane cannot be read", h.slot)),
            Seen::Alive { .. } => match h.stage {
                HoldStage::Released => Attribution::Own { launch: h.launch.clone() },
                HoldStage::Bound | HoldStage::Armed | HoldStage::Planned => match with_store(|s| s.project(&h.project_id)) {
                    Ok(Some(p)) => Attribution::Slot { session: p.session, slot: h.slot.clone(), launch: h.launch.clone() },
                    Ok(None) => Attribution::Drop(format!("the restored {} has no project", h.slot)),
                    Err(e) => Attribution::Unknown(format!("the restored {}'s project cannot be read ({e})", h.slot)),
                },
            },
        };
    }
    let holds = match with_store(|s| s.socket_holds(&socket)) {
        Ok(h) => h,
        Err(e) => return Attribution::Unknown(format!("the restore holds cannot be read ({e})")),
    };
    let mine: Vec<&Hold> = holds.iter().filter(|h| h.pane.as_ref().is_some_and(|p| p.pane_id == pane_id)).collect();
    if mine.is_empty() {
        return Attribution::Normal;
    }
    let now = list(&socket);
    for h in mine {
        match observe(h, &now) {
            Seen::Ended => continue,
            Seen::Unknown => return Attribution::Unknown(format!("the restored {}'s pane cannot be read", h.slot)),
            Seen::Alive { .. } => return Attribution::Drop(format!("no launch, from the restored {}'s pane", h.slot)),
        }
    }
    Attribution::Normal
}

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
/// never a `display-message -t %N`: a gone `%N` is no error there (`display
/// -p -t %99999 x` prints `x`). tmux 3.6a answers it with EMPTY pane fields
/// (measured 2026-10-19), other builds have been reported to answer with
/// another pane's; neither is the pane asked for.
struct Listing {
    instance: (u32, u64),
    /// pane id → (pane pid, session name, window name).
    panes: std::collections::HashMap<String, (String, String, String)>,
}

fn list(socket: &str) -> Result<Option<Listing>, String> {
    #[cfg(test)]
    if LIST_FAILS.with(|f| f.get()) {
        return Err("test: the listing cannot be read".into());
    }
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
        accepted_seq: None,
        not_ready: false,
        reported: false,
        merging: false,
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
        // Released: input is no longer blocked — but the slot is BOUND to
        // that generation's own pane (H2 review P1-D residuals): while its
        // name leads anywhere else (the window moved away, a same-name
        // window first) or it cannot be checked, typing into the slot is
        // barred, for every trigger, until the bound pane is where the name
        // leads or a lifecycle operation ends the binding. A pane confirmed
        // ended ends it.
        HoldStage::Released => in_project(h) && h.slot == window && match observe(h, &now) {
            Seen::Ended => false,
            Seen::Unknown => true,
            Seen::Alive { session: s, window_name } => {
                let pane = h.pane.as_ref().map(|p| p.pane_id.clone());
                !(s == session && window_name == window && tmux::find_window_by_name(session, window) == pane)
            }
        },
        HoldStage::Planned => in_project(h) && h.slot == window,
        HoldStage::Bound | HoldStage::Armed => match observe(h, &now) {
            // A dsh window already named as its slot whose readiness names
            // this launch is released here, on the read that would otherwise
            // hold it (no merge and no flush on a read: the tick does those).
            Seen::Alive { ref window_name, .. } if *window_name == h.slot && ready(h) && release(h, &now) == Ok(Release::Released) => false,
            Seen::Alive { session: s, window_name } => (s == session && window_name == window) || (in_project(h) && h.slot == window),
            Seen::Ended => false,
            Seen::Unknown => true,
        },
    })
}

/// What a launch door may type (board #422 round 3, review P1-B).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// Confirmed: no restore hold for this slot. A plain launch.
    NoHold,
    /// The slot's restore generation was replaced by this new launch uuid,
    /// installed before anything is typed; the line carries it as
    /// `TMM_LAUNCH`.
    Replaced(String),
}

thread_local! {
    /// The hold each running start verb found for its slot BEFORE its kill
    /// (`intent`), so a prune between that kill and the door cannot read as
    /// "there was no hold". Keyed by (session, slot); scoped by the guard.
    static INTENTS: std::cell::RefCell<Vec<((String, String), Option<Hold>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A start verb's record of the slot's restore hold as it stood when the verb
/// began (taken with its `StartPermit`, before any kill). Dropped with it.
#[must_use]
pub struct Intent {
    key: (String, String),
}

impl Drop for Intent {
    fn drop(&mut self) {
        INTENTS.with(|i| i.borrow_mut().retain(|(k, _)| *k != self.key));
    }
}

/// Read the slot's hold now (`Err`: it cannot be read, and the verb does not
/// start) and keep it for the verb's doors.
pub fn intent(session: &str, window: &str) -> Result<Intent, String> {
    let found = find_hold(session, window)?.map(|(h, _)| h);
    let key = (session.to_string(), window.to_string());
    INTENTS.with(|i| {
        let mut i = i.borrow_mut();
        i.retain(|(k, _)| *k != key);
        i.push((key.clone(), found));
    });
    Ok(Intent { key })
}

/// The hold of `session`'s slot `window` on this socket — by its slot name,
/// or by its live pane now being called `window` — with the project.
/// `Ok(None)`: confirmed none. `Err`: it cannot be read.
fn find_hold(session: &str, window: &str) -> Result<Option<(Hold, super::store::Project)>, String> {
    let socket = restore::socket_key();
    let Some(project) = super::project_for_session(session)? else { return Ok(None) };
    let holds = with_store(|s| s.project_holds(&socket, &project.id))?;
    if holds.is_empty() {
        return Ok(None);
    }
    let now = list(&socket);
    Ok(holds
        .into_iter()
        .find(|h| h.slot == window || matches!(observe(h, &now), Seen::Alive { window_name, .. } if window_name == window))
        .map(|h| (h, project)))
}

/// Every door that types an agent's launch into `session`'s window `window`
/// (pane `target`) asks this first (board #422 round 3, H2 review P1-B and
/// the STAGE ruling). It consumes ONLY the generation the running start verb
/// read before its kill (`intent`): a hold that appeared or was replaced
/// since then is another launch's, and this door types NOTHING (`Err`). The
/// hold it consumes:
/// * still in progress (planned, bound, armed — not ready or merging
///   included): REPLACED by a new armed generation bound to the target
///   pane, BEFORE anything is typed, the window tagged with it (`@tmm_rl`,
///   its creation authorization for `merge_held`) and the line carrying it
///   as `TMM_LAUNCH`;
/// * released: an ordinary restart. Its row is retired once its pane is
///   confirmed ended (the restart's own kill), no new hold is installed and
///   the launch has today's admission (`NoHold`); a pane still alive or not
///   readable types nothing.
/// No hold confirmed: `NoHold`. A store or pane that cannot be read, or a
/// CAS lost to another launch: `Err`, nothing typed.
pub fn before_launch(session: &str, window: &str, target: &str) -> Result<Launch, String> {
    let socket = restore::socket_key();
    let intended = INTENTS.with(|i| i.borrow().iter().find(|(k, _)| k.0 == session && k.1 == window).map(|(_, h)| h.clone()));
    let current = find_hold(session, window)?.map(|(h, _)| h);
    let h = match intended {
        Some(started) => match (started, current) {
            (None, None) => return Ok(Launch::NoHold),
            (None, Some(_)) => return Err(format!("a restore barrier for {window} appeared after this start began; nothing was typed")),
            (Some(s), Some(c)) if c.launch != s.launch => return Err(format!("{window}'s restore barrier was replaced by another launch since this start began; nothing was typed")),
            (Some(s), _) => s,
        },
        None => match current {
            None => return Ok(Launch::NoHold),
            Some(c) => c,
        },
    };
    if h.stage == HoldStage::Released {
        return match observe(&h, &list(&socket)) {
            Seen::Ended => {
                #[cfg(test)]
                if let Some(hook) = BEFORE_RETIRE.lock().unwrap().take() {
                    hook();
                }
                // The retire is the authorization: lost to a successor, the
                // restart does not start (H2 review P1-B residual).
                if with_store(|s| s.retire_released_as_seen(&h))? {
                    Ok(Launch::NoHold)
                } else {
                    Err(format!("{window}'s restore barrier was replaced by another launch meanwhile; nothing was typed"))
                }
            }
            Seen::Alive { .. } => Err(format!("{window}'s restored pane is still running; nothing was typed")),
            Seen::Unknown => Err(format!("{window}'s restored pane cannot be checked; nothing was typed")),
        };
    }
    let fmt = "#{pane_id}\t#{pane_pid}\t#{window_id}\t#{session_id}\t#{pid}\t#{start_time}";
    let out = tmux::run_tmux_on(Some(&socket), &["display-message", "-p", "-t", target, fmt]).map_err(|e| format!("the new pane cannot be read ({e}); nothing was typed"))?;
    #[cfg(test)]
    let out = PANE_ANSWER.with(|a| a.borrow_mut().take()).unwrap_or(out);
    let unreadable = || format!("the new pane's identity is unreadable ({out:?}); nothing was typed");
    let f: Vec<&str> = out.trim_end().splitn(6, '\t').collect();
    let [pane_id, pane_pid, window_id, session_id, pid, start] = f[..] else { return Err(unreadable()) };
    // The answer must name the pane asked about. A gone target is no error:
    // tmux 3.6a answers it with empty pane fields (the parse below refuses
    // them), other builds have been reported to answer with ANOTHER pane's
    // (refused here).
    if target.starts_with('%') && pane_id != target {
        return Err(unreadable());
    }
    let pane = super::store::HoldPane {
        instance: super::store::TmuxInstance { socket: socket.clone(), pid: pid.parse().map_err(|_| unreadable())?, start_time: start.parse().map_err(|_| unreadable())? },
        session_id: session_id.into(),
        window_id: window_id.into(),
        pane_id: pane_id.into(),
        pane_pid: pane_pid.parse().map_err(|_| unreadable())?,
    };
    let launch = uuid::Uuid::new_v4().to_string();
    // The window's creation authorization for this generation, before the
    // generation exists: a window left tagged by a lost CAS is harmless.
    tmux::run_tmux_on(Some(&socket), &["set-option", "-w", "-t", window_id, "@tmm_rl", &launch]).map_err(|e| format!("the new window cannot be tagged ({e}); nothing was typed"))?;
    if with_store(|s| s.install_hold(&h, &launch, HoldStage::Armed, &pane, super::now()))? {
        Ok(Launch::Replaced(launch))
    } else {
        Err(format!("{window}'s restore barrier was replaced by another launch meanwhile; nothing was typed"))
    }
}

/// Test seam: runs once between the door's read of a released hold and its retire.
#[cfg(test)]
pub(crate) static BEFORE_RETIRE: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

/// How the send door may write into `session`'s window `window` through
/// `target` (board #422 round 3, H2 review P1-D residuals), decided from ONE
/// read of the slot's current holds, at the moment of the write:
/// * `Ordinary`: no live hold of this slot is confirmed — written as always;
/// * `Bound(guard)`: written into the hold's own pane only, under the
///   in-server guard of its identity — for a RELEASED hold; and, for the one
///   interrupt (`interrupt`, readiness-exempt: a person may always cancel), for
///   a bound or armed hold too;
/// * `Err`: a hold of this slot is still in progress (planned, bound, armed:
///   its pane may be a cold-starting CLI or a shell) and this is not the
///   interrupt; or the holds or the pane cannot be read; or `target` does not
///   lead to the bound pane (the screen a caller read, or the window it
///   named, is another object) — nothing is written, the caller keeps its line.
pub enum SendGate {
    Ordinary,
    Bound(tmux::WriteGuard),
}

pub fn send_gate(session: &str, window: &str, target: &str, interrupt: bool) -> Result<SendGate, String> {
    #[cfg(test)]
    if let Some(hook) = BEFORE_SEND_GATE.lock().unwrap().take() {
        hook();
    }
    let socket = restore::socket_key();
    let Some(project) = super::project_for_session(session)? else { return Ok(SendGate::Ordinary) };
    let holds = with_store(|s| s.project_holds(&socket, &project.id))?;
    if holds.is_empty() {
        return Ok(SendGate::Ordinary);
    }
    let now = list(&socket);
    let mut bound: Option<&Hold> = None;
    for h in &holds {
        let seen = observe(h, &now);
        let this_slot = h.slot == window || matches!(&seen, Seen::Alive { session: s, window_name } if s == session && window_name == window);
        if !this_slot {
            continue;
        }
        match (h.stage, seen) {
            (_, Seen::Ended) => continue,
            // Not the restore's window yet: an interrupt reaches whatever is there.
            (HoldStage::Planned, _) if interrupt => continue,
            (HoldStage::Released, Seen::Alive { .. }) => bound = Some(h),
            (HoldStage::Bound | HoldStage::Armed, Seen::Alive { .. }) if interrupt => bound = Some(h),
            (HoldStage::Released, Seen::Unknown) => return Err(format!("the restored {window}'s pane cannot be checked; nothing was typed")),
            (_, Seen::Unknown) if interrupt => return Err(format!("the restored {window}'s pane cannot be checked; nothing was typed")),
            (_, _) => return Err(format!("{window} is restoring, not ready; nothing was typed")),
        }
    }
    let Some(h) = bound else { return Ok(SendGate::Ordinary) };
    let p = h.pane.as_ref().expect("a bound hold has its pane");
    let leads = tmux::run_tmux_on(Some(&socket), &["display-message", "-p", "-t", target, "#{pane_id}"]).ok().map(|o| o.trim().to_string());
    if leads.as_deref() != Some(p.pane_id.as_str()) {
        return Err(format!("{target} is not the restored {window}'s pane; nothing was typed"));
    }
    Ok(SendGate::Bound(tmux::WriteGuard { pid: p.instance.pid, start_time: p.instance.start_time, pane_id: p.pane_id.clone(), pane_pid: p.pane_pid }))
}

/// Test seam: runs once right before the send door reads the slot's holds.
#[cfg(test)]
pub(crate) static BEFORE_SEND_GATE: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

/// How long a held window may go without evidence before it is reported
/// not ready (board #422 round 3). A report only: it never releases.
pub const NOT_READY_SECS: u64 = 120;

/// The capture tick's not-ready pass: a bound or armed hold past
/// `NOT_READY_SECS` with no evidence is marked once and its project's room is
/// told once. The status reads the mark from the hold row itself
/// (`telemetry::restore_view`); nothing here feeds it. A line that could not
/// be posted is unclaimed, and the next tick posts it.
pub fn tick_not_ready() {
    let socket = restore::socket_key();
    let Ok(holds) = with_store(|s| s.socket_holds(&socket)) else { return };
    #[cfg(test)]
    if let Some(hook) = TICK_HOOK.lock().unwrap().as_ref() {
        hook();
    }
    let now = super::now();
    for h in &holds {
        // A merging hold has shown its evidence: it is not "not ready".
        let blocking = matches!(h.stage, HoldStage::Bound | HoldStage::Armed) && !h.merging;
        // A hold with an accepted fact of its launch has shown life.
        if !blocking || h.reported || h.accepted_seq.is_some() || now.saturating_sub(h.since) < NOT_READY_SECS {
            continue;
        }
        let Ok(Some(project)) = with_store(|s| s.project(&h.project_id)) else { continue };
        if with_store(|s| s.mark_hold_not_ready_if(&h.launch)).unwrap_or(false) {
            let held = super::telemetry::held_rows(&project.session, &h.slot).len();
            let lines = match held {
                0 => String::new(),
                1 => "; 1 line held".into(),
                n => format!("; {n} lines held"),
            };
            if post(&project, &format!("[tmm] {} was restored but has not shown it is ready{lines}; type a prompt into it", h.slot)).is_err() {
                let _ = with_store(|s| s.unclaim_hold_report(&h.launch));
            }
        }
    }
}

/// Test seam: runs between the not-ready pass's read of the holds and its
/// writes.
#[cfg(test)]
pub(crate) static TICK_HOOK: std::sync::Mutex<Option<Box<dyn Fn() + Send>>> = std::sync::Mutex::new(None);

/// The capture tick's release pass (board #422 round 3): an armed hold
/// whose backend's readiness evidence names this launch, or whose accepted
/// evidence is waiting for its merge, is merged and released, and its held
/// lines are flushed by the existing rules. Returns the released launches.
pub fn release_ready() -> Vec<String> {
    let socket = restore::socket_key();
    let Ok(holds) = with_store(|s| s.socket_holds(&socket)) else { return Vec::new() };
    let due: Vec<&Hold> = holds.iter().filter(|h| h.stage == HoldStage::Armed && (h.merging || ready(h))).collect();
    if due.is_empty() {
        return Vec::new();
    }
    let now = list(&socket);
    // A store failure is retried at the next tick.
    due.into_iter().filter(|h| release_and_flush(h, &now) == Ok(Release::Released)).map(|h| h.launch.clone()).collect()
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
            HoldStage::Bound | HoldStage::Armed | HoldStage::Released => observe(&h, &now) == Seen::Ended,
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

#[cfg(test)]
thread_local! {
    /// Test seam: this thread's listings of the server fail.
    pub(crate) static LIST_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Test seam: the launch door's next identity read answers this instead
    /// (V11: an answer for another pane than the one asked about).
    pub(crate) static PANE_ANSWER: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Test seam: runs between prune's verdict on a hold and its retire.
#[cfg(test)]
pub(crate) static PRUNE_HOOK: std::sync::Mutex<Option<Box<dyn Fn(&Hold) + Send>>> = std::sync::Mutex::new(None);

/// The store, for tests outside `projects` that stage a hold.
#[cfg(test)]
pub(crate) fn with_store_for_test<T>(f: impl FnOnce(&mut super::store::Store) -> Result<T, String>) -> Result<T, String> {
    with_store(f)
}
