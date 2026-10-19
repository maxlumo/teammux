//! The restore EXECUTOR (board #422, round 2): one owner at a time brings a
//! frozen plan back, one write-ahead step at a time, on tmux objects it can
//! PROVE it made. Built and tested here; nothing calls `run` at gateway start
//! until round 3's admission barrier exists.
//!
//! Three rules carry it (design + review, 2026-10-18):
//!
//! * **Ownership is a fact on the tmux object.** A session is made by ONE
//!   `new-session -e TMM_RESTORE_BATCH=<uuid> -n tmm-r-<uuid>-holder`, so it
//!   carries the batch in its environment from birth (a taken name fails:
//!   creation is the claim); a window is born with the placeholder name
//!   `tmm-r-<uuid>-<ord>` and then tagged `@tmm_rw=<uuid>:<ord>`; the session
//!   gets `@tmm_rs=<uuid>`. The FULL uuid is the authority everywhere.
//! * **Every write to an owned object is checked by the server that does it.**
//!   One `if-shell -F` on the object's native id, whose condition holds the
//!   server's own identity (`#{pid}`, `#{start_time}`) and the full tags;
//!   a false condition answers REFUSED and changes nothing. Results are
//!   Applied / Refused / Unknown, and only Refused proves "not done".
//! * **Unknown is re-observed, never redone blind.** The step an item had
//!   issued (`op`) is on record before tmux runs it; a create or a kill is
//!   never issued twice; a launch, once `LaunchIssued`, is never retyped,
//!   killed or renamed — tenet 4: our death never ends a running agent.

use super::store::{Batch, BatchOp, BatchProject, BatchWindow, ProjectState, Slot, SlotKind, TmuxInstance, WindowState};
use super::{restore, with_store};
use crate::tmux;

/// What one call of `run` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// Another owner holds the restore lock.
    Busy,
    /// Nothing to do, and why.
    Nothing(String),
    /// A batch was executed (fully or as far as it could go this pass);
    /// `closed` is its closing word when it closed.
    Ran { batch: String, closed: Option<String> },
}

/// The inputs a gateway start (round 3) or a manual run (round 4) supplies.
#[derive(Debug, Clone)]
pub struct RunInputs {
    pub socket: String,
    pub enabled: bool,
    pub boot_now: Option<String>,
    pub include_autostart: bool,
}

// ---- the owner ------------------------------------------------------------

/// The one restore owner per state.db: `flock(LOCK_EX|LOCK_NB)` on
/// `<state dir>/restore.lock`, released by the OS when the process dies.
pub struct OwnerLock {
    _file: std::fs::File,
}

impl OwnerLock {
    pub(crate) fn try_acquire() -> Result<Option<OwnerLock>, String> {
        let path = super::db_path().with_file_name("restore.lock");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        use std::os::unix::io::AsRawFd;
        // SAFETY: a valid open fd; flock has no other preconditions.
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(Some(OwnerLock { _file: f }));
        }
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(None)
        } else {
            Err(format!("restore lock: {e}"))
        }
    }
}

// ---- in-server guarded tmux steps ------------------------------------------

const OK: &str = "TMM-RESTORE-OK";
const REFUSED: &str = "TMM-RESTORE-REFUSED";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    /// The action ran; the lines it printed before the OK marker.
    Applied(String),
    /// The in-server condition was false: nothing ran.
    Refused,
    /// Anything else: it may or may not have run.
    Unknown(String),
}

fn eq(format: &str, value: &str) -> String {
    format!("#{{==:#{{{format}}},{value}}}")
}

/// Every part must hold, folded into tmux's binary `&&`.
fn all(parts: Vec<String>) -> String {
    let mut it = parts.into_iter();
    let first = it.next().unwrap_or_else(|| "1".to_string());
    it.fold(first, |acc, p| format!("#{{&&:{acc},{p}}}"))
}

fn instance_parts(i: &TmuxInstance) -> Vec<String> {
    vec![eq("pid", &i.pid.to_string()), eq("start_time", &i.start_time.to_string())]
}

fn placeholder(batch: &str, ord: usize) -> String {
    format!("tmm-r-{batch}-{ord}")
}

fn holder_name(batch: &str) -> String {
    format!("tmm-r-{batch}-holder")
}

fn classify(out: &str) -> Outcome {
    let lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
    match lines.as_slice() {
        [only] if *only == REFUSED => Outcome::Refused,
        [rest @ .., last] if *last == OK => Outcome::Applied(rest.join("\n")),
        _ => Outcome::Unknown(format!("unclassified tmux answer: {out:?}")),
    }
}

/// Test seams at every step boundary (`Step`): stop the run before the
/// step, run it and stop before its answer is seen, drop its answer, or
/// (the launch only) send the text without its Enter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum Mangle {
    Run,
    HaltBefore,
    RunThenHalt,
    DropReceipt,
    TextOnly,
    /// Do not run the step, and report its answer as lost.
    Lost,
    Abort,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Step {
    pub op: &'static str,
    pub project: String,
    pub ord: Option<usize>,
}

#[cfg(test)]
pub(crate) type StepHook = Box<dyn FnMut(&Step) -> Mangle + Send>;
#[cfg(test)]
pub(crate) static STEP_HOOK: std::sync::Mutex<Option<StepHook>> = std::sync::Mutex::new(None);

fn mangle(_step: &Step) -> Mangle {
    #[cfg(test)]
    if let Some(h) = STEP_HOOK.lock().unwrap().as_mut() {
        return h(_step);
    }
    Mangle::Run
}

/// How long one pass waits for a restored window's shell prompt before it
/// leaves the window for the next pass (nothing typed). A test may shorten it.
fn prompt_wait() -> std::time::Duration {
    #[cfg(test)]
    {
        let ms = PROMPT_WAIT_MS.load(std::sync::atomic::Ordering::SeqCst);
        if ms > 0 {
            return std::time::Duration::from_millis(ms);
        }
    }
    std::time::Duration::from_secs(60)
}

#[cfg(test)]
pub(crate) static PROMPT_WAIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The run stopped where a test (or, one day, a crash) left it.
const HALTED: &str = "restore halted";

fn halt_check(m: Mangle) -> Result<(), String> {
    match m {
        Mangle::HaltBefore => Err(HALTED.into()),
        Mangle::Abort => std::process::abort(),
        _ => Ok(()),
    }
}

/// One guarded step: `if-shell -F -t <target> <cond> '<action> ; display -p OK'
/// 'display -p REFUSED'` on the batch's socket.
fn guarded(socket: &str, step: &Step, target: &str, cond: &str, action: &str) -> Result<Outcome, String> {
    guarded_with(socket, mangle(step), target, cond, action)
}

fn guarded_with(socket: &str, m: Mangle, target: &str, cond: &str, action: &str) -> Result<Outcome, String> {
    halt_check(m)?;
    if m == Mangle::Lost {
        return Ok(Outcome::Unknown("the answer was lost".into()));
    }
    let then = format!("{action} ; display -p {OK}");
    let refused = format!("display -p {REFUSED}");
    let out = tmux::run_tmux_on(Some(socket), &["if-shell", "-F", "-t", target, cond, &then, &refused]);
    if m == Mangle::RunThenHalt {
        return Err(HALTED.into());
    }
    if m == Mangle::DropReceipt {
        return Ok(Outcome::Unknown("the answer was lost".into()));
    }
    Ok(match out {
        Ok(out) => classify(&out),
        Err(e) => Outcome::Unknown(e),
    })
}

// ---- observation (reads, on the batch socket) ------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionSeen {
    Absent,
    /// Exists without our batch in its environment: the person's.
    NotOurs,
    Ours { instance: TmuxInstance, session_id: String },
    Unknown(String),
}

/// The session's batch env AND the server identity, from ONE connection —
/// so both answers come from the same server.
fn observe_session(socket: &str, session: &str, batch: &str) -> SessionSeen {
    let target = format!("={session}:");
    let out = tmux::run_tmux_on(
        Some(socket),
        &["show-environment", "-t", &target, "TMM_RESTORE_BATCH", ";", "display", "-p", "-t", &target, &format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{socket_path}}{SEP}#{{session_id}}")],
    );
    match out {
        // `show-environment` words a missing session "no such session"
        // (tmux 3.6a, measured with a server up), not "can't find session".
        Err(e) if tmux::session_confirmed_absent(&e) || e.contains("no such session") => SessionSeen::Absent,
        Err(e) if e.contains("unknown variable") => SessionSeen::NotOurs,
        Err(e) => SessionSeen::Unknown(e),
        Ok(out) => {
            let mut lines = out.lines();
            let env = lines.next().unwrap_or("");
            if env != format!("TMM_RESTORE_BATCH={batch}") {
                return SessionSeen::NotOurs;
            }
            let f: Vec<&str> = lines.next().unwrap_or("").split(SEP).collect();
            match f.as_slice() {
                [pid, start, sock, sid] => match (pid.parse(), start.parse()) {
                    (Ok(pid), Ok(start_time)) => SessionSeen::Ours {
                        instance: TmuxInstance { socket: sock.to_string(), pid, start_time },
                        session_id: sid.to_string(),
                    },
                    _ => SessionSeen::Unknown(format!("unreadable identity: {out:?}")),
                },
                _ => SessionSeen::Unknown(format!("unreadable identity: {out:?}")),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowSeen {
    id: String,
    pane: String,
    pane_pid: Option<u32>,
    name: String,
    tag: String,
}

/// The windows of our session `$N`, with their tags, from the server whose
/// identity is checked in the same answer. `Err` = could not be read, or
/// the answering server is not the batch's.
fn observe_windows(socket: &str, session_id: &str, instance: &TmuxInstance) -> Result<Option<Vec<WindowSeen>>, String> {
    let fmt = format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{window_id}}{SEP}#{{pane_id}}{SEP}#{{pane_pid}}{SEP}#{{window_name}}{SEP}#{{@tmm_rw}}");
    let out = match tmux::run_tmux_on(Some(socket), &["list-windows", "-t", session_id, "-F", &fmt]) {
        Ok(out) => out,
        Err(e) if tmux::session_confirmed_absent(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut seen = Vec::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split(SEP).collect();
        let [pid, start, id, pane, pane_pid, name, tag] = f[..] else { return Err(format!("unreadable list-windows line: {line}")) };
        if pid != instance.pid.to_string() || start != instance.start_time.to_string() {
            return Err("another tmux server answered".into());
        }
        seen.push(WindowSeen { id: id.into(), pane: pane.into(), pane_pid: pane_pid.parse().ok(), name: name.into(), tag: tag.into() });
    }
    Ok(Some(seen))
}

// ---- the run ---------------------------------------------------------------

/// Take the owner lock, continue the socket's open batch from the batch
/// ALONE, or — with none open — judge the reboot trigger on the evidence and
/// start a batch from round 1's plan; then execute it as far as it can go.
/// `prepare` and one `continue_batch` pass, in one call.
pub fn run(inputs: &RunInputs) -> Result<RunOutcome, String> {
    match prepare(inputs)? {
        Prepared::Busy => Ok(RunOutcome::Busy),
        Prepared::Nothing(why) => Ok(RunOutcome::Nothing(why)),
        Prepared::Closed { batch, closed } => Ok(RunOutcome::Ran { batch, closed: Some(closed) }),
        Prepared::Ready { lease, batch } => continue_batch(lease, batch),
    }
}

/// What a prepare decided.
pub enum Prepared {
    /// Another owner holds the restore lock; it decides.
    Busy,
    /// Nothing to restore, and why; the decision is recorded.
    Nothing(String),
    /// An open batch of another boot was closed FAILED.
    Closed { batch: String, closed: String },
    /// A batch to execute, with the lease that guards it.
    Ready { lease: OwnerLock, batch: Batch },
}

/// The small durable decision a gateway start AWAITS before its capture and
/// deliveries start (board #422 round 3, P1-A): the gate, the lock, the open
/// batch or the trigger and the plan — SQLite plus one `list-sessions`. A
/// batch it opens is written with a planned hold for every agent slot and
/// this boot's `restore_decided`, in one transaction; every other outcome
/// records the decision alone. Until that marker names this boot, no capture
/// tick of any gateway commits over another boot's evidence. Window creation
/// is `continue_batch`'s, in the background.
pub fn prepare(inputs: &RunInputs) -> Result<Prepared, String> {
    let socket = inputs.socket.as_str();
    let decided = inputs.boot_now.clone().unwrap_or_else(|| super::store::UNKNOWN_BOOT.to_string());
    let nothing = |why: &str| -> Result<Prepared, String> {
        with_store(|s| s.set_restore_decided(socket, &decided))?;
        Ok(Prepared::Nothing(why.to_string()))
    };
    // Every branch that PUBLISHES a decision does so under the owner lease
    // (review H1 P1-A): a decision written while another owner is reading
    // the old evidence would let captures move it first. Busy writes
    // nothing; that owner decides.
    let Some(lease) = OwnerLock::try_acquire()? else { return Ok(Prepared::Busy) };
    // The gate holds for BOTH paths, before any batch write (review P1-D):
    // off, or a boot that cannot be read, does nothing — an open batch is
    // neither continued nor closed.
    if !inputs.enabled {
        return nothing("restore on start is off");
    }
    if inputs.boot_now.is_none() {
        return nothing("the host's boot identity is unknown");
    }
    let open = with_store(|s| s.restore_batch(socket))?;
    match open {
        Some(b) if b.boot_id.is_some() && b.boot_id == inputs.boot_now => {
            with_store(|s| s.set_restore_decided(socket, &decided))?;
            Ok(Prepared::Ready { lease, batch: b })
        }
        Some(b) if b.boot_id.is_none() => nothing("the open restore's boot identity is unknown; left as is"),
        Some(mut b) => {
            // A second host reboot during a half-done batch: its objects died
            // with the old server. Closed FAILED; nothing is re-planned
            // automatically (orchestrator, 23:54).
            close(&mut b, "failed: the host rebooted during the restore")?;
            with_store(|s| s.set_restore_decided(socket, &decided))?;
            Ok(Prepared::Closed { batch: b.batch, closed: b.closed.unwrap_or_default() })
        }
        None => match start_batch(inputs)? {
            Ok(b) => {
                let holds = planned_holds(&b);
                with_store(|s| s.open_batch(&b, &holds, &decided))?;
                Ok(Prepared::Ready { lease, batch: b })
            }
            Err(why) => nothing(&why),
        },
    }
}

// ---- the gateway start and the continuation schedule (round 3) ---------

/// The restore inputs a gateway start reads: this socket, the config's
/// `restore_on_start` (on by default since round 4's live acceptance), the
/// host's boot, and autostart projects (shells only when not in the
/// checkpoint).
pub fn start_inputs() -> RunInputs {
    RunInputs {
        socket: restore::socket_key(),
        enabled: crate::config::restore_on_start(),
        boot_now: restore::boot_id(),
        include_autostart: true,
    }
}

/// What a gateway runs in the background after its awaited prepare.
pub enum Start {
    /// The first pass, under the lease prepare took, then the schedule.
    Pass(OwnerLock, Batch),
    /// Another owner held the lock: observe on the schedule; take over only
    /// when the lock is ours.
    Observe,
}

/// The awaited half of a gateway start: `prepare`, said on stderr. `None`
/// when nothing runs in the background (decided, closed, or an error that
/// leaves no batch of ours).
pub fn prepare_on_start(inputs: &RunInputs) -> Option<Start> {
    match prepare(inputs) {
        Ok(Prepared::Ready { lease, batch }) => {
            eprintln!("projects: restore {} after a host reboot: {} project(s)", batch.batch, batch.projects.len());
            Some(Start::Pass(lease, batch))
        }
        Ok(Prepared::Busy) => {
            eprintln!("projects: another gateway owns the restore; observing");
            Some(Start::Observe)
        }
        Ok(Prepared::Nothing(why)) => {
            eprintln!("projects: no restore at start: {why}");
            None
        }
        Ok(Prepared::Closed { batch, closed }) => {
            eprintln!("projects: restore {batch}: {closed}");
            None
        }
        Err(e) => {
            eprintln!("projects: the restore could not be prepared: {e}");
            Some(Start::Observe)
        }
    }
}

/// The passes after the first, as ABSOLUTE offsets in seconds from the
/// schedule's start (one start instant; a long pass shortens the next wait,
/// never shifts the plan): an open batch that a pass could not finish (a
/// shell not ready, an Unknown to re-observe, an error) is continued at
/// each; nothing else is (orchestrator ruling 1).
pub const PASS_DELAYS: [u64; 3] = [30, 120, 600];

/// Test seam: a nonzero value is the length of one "second" in ms.
#[cfg(test)]
pub(crate) static PASS_SECOND_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Sleep until `offset` seconds after `start`, whatever the passes took.
fn wait_until(start: std::time::Instant, offset: u64) {
    #[allow(unused_mut)]
    let mut second = std::time::Duration::from_secs(1);
    #[cfg(test)]
    {
        let unit = PASS_SECOND_MS.load(std::sync::atomic::Ordering::SeqCst);
        if unit > 0 {
            second = std::time::Duration::from_millis(unit);
        }
    }
    let target = second * offset as u32;
    if let Some(left) = target.checked_sub(since(start)) {
        sleep_for(left);
    }
}

/// Test seam: a virtual clock in ms since the schedule's start. While set,
/// the schedule reads it instead of the wall clock and its waits advance it
/// instead of sleeping, so a test of the plan is exact, not timed.
#[cfg(test)]
pub(crate) static VIRTUAL_MS: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

fn since(start: std::time::Instant) -> std::time::Duration {
    #[cfg(test)]
    if let Some(ms) = *VIRTUAL_MS.lock().unwrap() {
        return std::time::Duration::from_millis(ms);
    }
    start.elapsed()
}

fn sleep_for(d: std::time::Duration) {
    #[cfg(test)]
    if let Some(ms) = VIRTUAL_MS.lock().unwrap().as_mut() {
        *ms += d.as_millis() as u64;
        return;
    }
    std::thread::sleep(d);
}

/// How a schedule ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleEnd {
    /// The batch closed (by a pass, or by another owner), or no batch is open.
    Finished,
    /// Exhausted while another owner held the lock: nothing written.
    Observed,
    /// Exhausted holding the lock: the batch was closed FAILED.
    GaveUp(String),
}

/// The background half: the first pass (or none, when observing), then a
/// pass at each `PASS_DELAYS` offset while the batch stays open. Every later
/// pass re-enters `run`, which re-checks the gate, the boot and the lock and
/// never retypes a `launch_issued` window. Exhausted holding the lock: the
/// batch is closed FAILED with the last reason and one room line per
/// unfinished project; exhausted while Busy: nothing.
pub fn continue_schedule(inputs: RunInputs, start: Start) -> ScheduleEnd {
    // Every pass after the first consumes only the (batch, attempt) the
    // schedule was admitted with (`resume`): a batch abandoned, closed or
    // continued by another attempt ends it, and it never admits anything on
    // its own afterwards (board #422 round 4). An observer has no admission
    // until its own prepare takes the lease (round 4 review P1-A): from then
    // on it is an owner of exactly that admission. A follower that never
    // took one never closes or kills anything.
    let (mut first, mut admitted) = match start {
        Start::Pass(lease, b) => {
            let a = Admitted { batch: b.batch.clone(), attempt: b.attempt };
            (Some((lease, b)), Some(a))
        }
        Start::Observe => (None, None),
    };
    let mut last = String::new();
    let mut busy = false;
    // Owner: a pass now, then one at each offset. Observer: only the offsets.
    let start = std::time::Instant::now();
    let offsets: Vec<u64> = if first.is_some() { std::iter::once(0).chain(PASS_DELAYS).collect() } else { PASS_DELAYS.to_vec() };
    for offset in offsets {
        wait_until(start, offset);
        let outcome = match (first.take(), admitted.clone()) {
            (Some((lease, b)), _) => continue_batch(lease, b),
            (None, Some(a)) => resume(&inputs.socket, &a),
            (None, None) => match prepare(&inputs) {
                Ok(Prepared::Ready { lease, batch: b }) => {
                    admitted = Some(Admitted { batch: b.batch.clone(), attempt: b.attempt });
                    continue_batch(lease, b)
                }
                Ok(Prepared::Busy) => Ok(RunOutcome::Busy),
                Ok(Prepared::Nothing(why)) => Ok(RunOutcome::Nothing(why)),
                Ok(Prepared::Closed { batch, closed }) => Ok(RunOutcome::Ran { batch, closed: Some(closed) }),
                Err(e) => Err(e),
            },
        };
        busy = false;
        match outcome {
            Ok(RunOutcome::Busy) => {
                busy = true;
                last = "another owner is restoring".into();
            }
            Ok(RunOutcome::Nothing(_)) => return ScheduleEnd::Finished,
            Ok(RunOutcome::Ran { closed: Some(_), .. }) => return ScheduleEnd::Finished,
            Ok(RunOutcome::Ran { closed: None, .. }) => last = "windows not finished".into(),
            Err(e) => {
                eprintln!("projects: restore pass failed: {e}");
                last = e;
            }
        }
    }
    if busy {
        eprintln!("projects: the restore schedule ended while another owner restores; it continues that batch");
        return ScheduleEnd::Observed;
    }
    // Only an admitted owner gives its own attempt up.
    match admitted.map(|a| give_up(&inputs, &a.batch, Some(a.attempt), &last)) {
        Some(Ok(end)) => end,
        Some(Err(e)) => {
            eprintln!("projects: the restore could not be closed: {e}");
            ScheduleEnd::GaveUp(e)
        }
        None => ScheduleEnd::Finished,
    }
}

/// Close an exhausted batch: only BY the lock holder, only the batch this
/// schedule ran (re-read under the lock) and, for an admitted owner, only
/// the attempt it was admitted with, killing the windows it made and never
/// typed into (round 2's guarded kill: their holds retire with them), then
/// one room line per project left unfinished.
fn give_up(inputs: &RunInputs, id: &str, attempt: Option<u32>, reason: &str) -> Result<ScheduleEnd, String> {
    let Some(_lease) = OwnerLock::try_acquire()? else { return Ok(ScheduleEnd::Observed) };
    let Some(mut b) = with_store(|s| s.restore_batch(&inputs.socket))? else { return Ok(ScheduleEnd::Finished) };
    if b.batch != id || attempt.is_some_and(|a| a != b.attempt) {
        return Ok(ScheduleEnd::Finished);
    }
    for pi in 0..b.projects.len() {
        for wi in 0..b.projects[pi].windows.len() {
            let w = &b.projects[pi].windows[wi];
            match (w.state, w.op, w.window_id.is_some()) {
                // A kill already issued is only re-observed, never re-sent.
                (WindowState::Created, Some(BatchOp::Kill), _) => observe_kill(&mut b, pi, wi)?,
                (WindowState::Created, _, true) => kill_owned(&mut b, pi, wi, "not started before the restore gave up".into())?,
                _ => {}
            }
        }
    }
    let word = format!("failed: not finished after {} passes: {reason}", PASS_DELAYS.len() + 1);
    // Each project left unfinished is reported in the close's own
    // transaction, once per attempt (board #422 round 4).
    let unfinished: Vec<(String, String)> = b
        .projects
        .iter()
        .filter(|p| !matches!(p.state, ProjectState::Done | ProjectState::Skipped | ProjectState::Failed))
        .map(|p| (p.id.clone(), project_room(p)))
        .collect();
    b.closed = Some(word.clone());
    let pushed = with_store(|s| s.close_batch_reporting(&mut b, |m| report_lines(m, &unfinished, EVENT_GAVE_UP, reason)))?;
    super::rooms::push_stored(&pushed);
    Ok(ScheduleEnd::GaveUp(word))
}

// ---- the manual doors (round 4): `tmm project restore [--run|--abandon]` --

/// The (batch, attempt) a continuation was admitted with: the only batch
/// its later passes may execute (`resume`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub batch: String,
    pub attempt: u32,
}

/// What a refused door says when another owner holds the restore lock.
pub const BUSY: &str = "another gateway is restoring; nothing was run";

/// One later pass of an admitted continuation: under the lock, the socket's
/// open batch when it is still the admitted one, else nothing — a batch
/// abandoned, closed, or reopened by another attempt is not this pass's.
pub fn resume(socket: &str, admitted: &Admitted) -> Result<RunOutcome, String> {
    let Some(lease) = OwnerLock::try_acquire()? else { return Ok(RunOutcome::Busy) };
    match with_store(|s| s.restore_batch(socket))? {
        Some(b) if b.batch == admitted.batch && b.attempt == admitted.attempt => continue_batch(lease, b),
        _ => Ok(RunOutcome::Nothing("the admitted restore is no longer open".into())),
    }
}

/// A person's `--run`, admitted: the lease, the batch as saved, and how it
/// came to be (`continue` | `retry` | `new`).
pub struct Admission {
    pub lease: OwnerLock,
    pub batch: Batch,
    pub mode: &'static str,
}

/// The manual door's admission (board #422 round 4, revision 1), under the
/// lock and before any tmux write: an open batch of this boot is continued
/// as it stands; one of another boot is closed FAILED as a start closes it;
/// one whose boot is unknown is left for `--abandon`; this boot's last
/// closed batch is retried under its own uuid (`retry_batch`) while its
/// server still answers; otherwise a NEW batch from the latest checkpoint.
/// The person asserts the loss, so the switch
/// (R0), the reboot test (R2/R3) and "this boot was already restored" do not
/// apply; a checkpoint (R1), the plan, the suppression and the executor's
/// rereads do. An unknown boot runs nothing.
pub fn admit_manual(socket: &str, boot_now: Option<&str>, include_autostart: bool) -> Result<Admission, String> {
    let Some(boot) = boot_now else {
        return Err("the host's boot identity is unknown; nothing was run (`tmm project restore` and `--abandon` still work)".into());
    };
    let Some(lease) = OwnerLock::try_acquire()? else { return Err(BUSY.into()) };
    match with_store(|s| s.restore_batch(socket))? {
        // Continued as it stands, as a new attempt: the schedule that ran it
        // so far stops at its next pass, so one continuation owns it.
        Some(mut b) if b.boot_id.as_deref() == Some(boot) => {
            b.attempt += 1;
            save(&mut b)?;
            return Ok(Admission { lease, batch: b, mode: "continue" });
        }
        Some(b) if b.boot_id.is_none() => {
            return Err(format!("the open restore {}'s boot identity is unknown; left as is (`tmm project restore --abandon` closes it)", b.batch));
        }
        Some(mut b) => close(&mut b, "failed: the host rebooted during the restore")?,
        None => {}
    }
    // This boot's last closed batch is RETRIED under its own uuid, while the
    // server it made its objects on still answers; gone, its objects died
    // with it and a new batch plans afresh. Unreadable is never "gone".
    let scan = with_store(|s| s.batch_scan(socket))?;
    let last = scan.last.map_err(|e| format!("{e}; nothing was run"))?;
    if let (Some(last), Some(raw)) = (last.filter(|l| l.boot_id.as_deref() == Some(boot)), scan.revision.last.as_deref()) {
        if let Some((b, holds)) = retry_batch(socket, last)? {
            if !with_store(|s| s.reopen_batch(raw, &b, &holds))? {
                return Err("the last restore or a slot's launch changed meanwhile; nothing was run (run it again)".into());
            }
            return Ok(Admission { lease, batch: b, mode: "retry" });
        }
    }
    let (latest, prev) = with_store(|s| Ok((s.checkpoint(socket)?, s.checkpoint_prev(socket)?)))?;
    let Some(cp) = restore::evidence(latest.as_ref(), prev.as_ref()) else {
        return Err("no checkpoint for this tmux socket yet; nothing was run".into());
    };
    match plan_batch(socket, Some(boot.to_string()), cp, include_autostart)? {
        Ok(mut b) => {
            // A person's attempt: 1, never the automatic start's 0.
            b.attempt = 1;
            let holds = planned_holds(&b);
            with_store(|s| s.open_batch(&b, &holds, boot))?;
            Ok(Admission { lease, batch: b, mode: "new" })
        }
        Err(why) => Err(format!("{why}; nothing was run")),
    }
}

/// The same-boot retry of a closed batch (board #422 round 4, revision 1's
/// tables), computed under the lock from one read, nothing cleared beyond
/// them. `None` = the batch's server is gone, or it never had one: none of
/// its objects can exist, so its uuid authorizes nothing and a new batch
/// plans afresh. `Err` = the server cannot be read: nothing is run.
///
/// Per window: Pending stays and runs; Creating and Created (an issued create
/// or kill included) are continued and re-observed by the executor, never
/// re-sent; LaunchIssued, LaunchUnknown, Launched and Skipped are shown
/// only; Failed is rebuilt ONLY when it was never typed into (`typed ==
/// Some(false)`) and its pane is confirmed absent from the whole instance —
/// then Pending again with its ids cleared and, for an agent, a fresh
/// planned generation. An agent slot another launch holds now is shown
/// only. Per project: Skipped is shown only; Pending, CreatingSession and
/// Open are continued as they stand; a finished project with something to
/// retry reopens when its session is ours on this instance (the executor's
/// guarded steps check every object again), is claimed again when its
/// session is confirmed gone, and is shown only otherwise.
fn retry_batch(socket: &str, mut b: Batch) -> Result<Option<(Batch, Vec<(super::store::Hold, Option<String>)>)>, String> {
    let Some(inst) = b.instance.clone() else { return Ok(None) };
    match restore::tmux_now_on(Some(socket)) {
        restore::TmuxNow::Unknown(e) => return Err(format!("the tmux server cannot be read ({e}); nothing was run")),
        restore::TmuxNow::Present { instance, .. } if instance == inst => {}
        _ => return Ok(None),
    }
    enum Dispose {
        AsIs,
        Reopen,
        Reclaim,
        ShowOnly,
    }
    let mut holds = Vec::new();
    for pi in 0..b.projects.len() {
        let dispose = match b.projects[pi].state {
            ProjectState::Skipped => Dispose::ShowOnly,
            ProjectState::Pending | ProjectState::CreatingSession | ProjectState::Open => Dispose::AsIs,
            ProjectState::Done | ProjectState::Failed => match b.projects[pi].session_id {
                None => Dispose::Reclaim,
                Some(_) => match observe_session(socket, &b.projects[pi].session, &b.batch) {
                    SessionSeen::Ours { instance, .. } if instance == inst => Dispose::Reopen,
                    SessionSeen::Absent => Dispose::Reclaim,
                    _ => Dispose::ShowOnly,
                },
            },
        };
        if matches!(dispose, Dispose::ShowOnly) {
            continue;
        }
        let pid = b.projects[pi].id.clone();
        let held: std::collections::HashMap<String, String> = with_store(|s| s.project_holds(socket, &pid))?.into_iter().map(|h| (h.slot, h.launch)).collect();
        let mut work = false;
        for wi in 0..b.projects[pi].windows.len() {
            let w = b.projects[pi].windows[wi].clone();
            let agent = w.kind == SlotKind::Agent;
            // Another launch's generation holds this slot now: not ours to plan.
            let taken = agent && held.get(&w.name).is_some_and(|l| w.launch.as_ref() != Some(l));
            match w.state {
                WindowState::Pending if taken => {
                    let ww = &mut b.projects[pi].windows[wi];
                    ww.state = WindowState::Skipped;
                    ww.reason = Some("another launch holds this slot now".into());
                }
                WindowState::Pending => {
                    work = true;
                    if let (Some(launch), false) = (w.launch.clone(), held.contains_key(&w.name)) {
                        holds.push((planned_hold(&b, &pid, &w, launch), None));
                    }
                }
                WindowState::Creating | WindowState::Created => work = true,
                WindowState::Failed if !taken && w.typed == Some(false) && w.op.is_none() && confirmed_absent(socket, &inst, &b.projects[pi], &w) => {
                    let launch = agent.then(|| uuid::Uuid::new_v4().to_string());
                    let ww = &mut b.projects[pi].windows[wi];
                    ww.state = WindowState::Pending;
                    ww.reason = None;
                    ww.window_id = None;
                    ww.pane_id = None;
                    ww.pane_pid = None;
                    ww.op = None;
                    ww.create_issued = Some(false);
                    ww.launch = launch.clone();
                    if let Some(launch) = launch {
                        let w = ww.clone();
                        // Conditional, in the reopen, on exactly what this
                        // read saw in the slot (P1-B).
                        holds.push((planned_hold(&b, &pid, &w, launch), held.get(&w.name).cloned()));
                    }
                    work = true;
                }
                _ => {}
            }
        }
        if !work {
            continue;
        }
        let p = &mut b.projects[pi];
        match dispose {
            Dispose::Reopen => {
                p.state = ProjectState::Open;
                p.holder_id = None;
            }
            Dispose::Reclaim => {
                p.state = ProjectState::Pending;
                p.session_id = None;
                p.holder_id = None;
            }
            _ => continue,
        }
        p.reason = None;
        p.op = None;
        p.finished = None;
    }
    b.attempt += 1;
    b.closed = None;
    b.owner_pid = std::process::id();
    Ok(Some((b, holds)))
}

/// Is the window's pane confirmed gone from the batch's instance — wherever
/// it might be now (`restore_hold::pane_ended`, the whole server)? With no
/// ids, only a create that was never issued, or that the server refused,
/// is (`create_issued == Some(false)`): a create whose outcome was not seen
/// may have made a window no id names, so it is shown only (round 4 review
/// P1-C). Anything that cannot be confirmed is not.
fn confirmed_absent(socket: &str, inst: &TmuxInstance, p: &BatchProject, w: &BatchWindow) -> bool {
    match (&w.window_id, &w.pane_id, w.pane_pid) {
        (None, None, _) => w.create_issued == Some(false),
        (Some(window_id), Some(pane_id), Some(pane_pid)) => {
            let pane = super::store::HoldPane { instance: inst.clone(), session_id: p.session_id.clone().unwrap_or_default(), window_id: window_id.clone(), pane_id: pane_id.clone(), pane_pid };
            super::restore_hold::pane_ended(socket, &pane) == Some(true)
        }
        _ => false,
    }
}

/// A planned hold for window `w` of project `project_id` in batch `b`.
fn planned_hold(b: &Batch, project_id: &str, w: &BatchWindow, launch: String) -> super::store::Hold {
    super::store::Hold {
        socket: b.socket.clone(),
        project_id: project_id.to_string(),
        batch: b.batch.clone(),
        ord: w.ord,
        slot: w.name.clone(),
        launch,
        stage: super::store::HoldStage::Planned,
        pane: None,
        since: super::now(),
        accepted_seq: None,
        not_ready: false,
        reported: false,
        merging: false,
    }
}

/// `--abandon`: under the lock, close the socket's open batch FAILED
/// "abandoned". Nothing is written in tmux; holds and held lines stay, as
/// they outlive every batch. `None` = nothing was open (idempotent).
pub fn abandon(socket: &str) -> Result<Option<String>, String> {
    let Some(_lease) = OwnerLock::try_acquire()? else { return Err(BUSY.into()) };
    let Some(mut b) = with_store(|s| s.restore_batch(socket))? else { return Ok(None) };
    close(&mut b, ABANDONED)?;
    Ok(Some(b.batch))
}

/// The word an abandoned batch closes with.
pub const ABANDONED: &str = "failed: abandoned";

/// A batch as a person reads it: each project's and window's state and
/// reason, without the source checkpoint.
pub fn batch_view(b: &Batch) -> serde_json::Value {
    serde_json::json!({
        "batch": b.batch,
        "attempt": b.attempt,
        "boot_id": b.boot_id,
        "closed": b.closed,
        "projects": b.projects.iter().map(|p| serde_json::json!({
            "name": p.name,
            "session": p.session,
            "state": p.state,
            "reason": p.reason,
            "windows": p.windows.iter().map(|w| serde_json::json!({
                "name": w.name,
                "kind": w.kind,
                "state": w.state,
                "reason": w.reason,
                "released": w.released,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

/// `tmm project restore` (read-only): what a `--run` would start from NOW —
/// the open batch; else this boot's last closed batch; else the plan from
/// the latest checkpoint — with each reason, the switch and the boot. A
/// snapshot: `--run` reads again under the lock. Takes no lock, writes
/// nothing.
pub fn show(socket: &str, boot_now: Option<&str>, enabled: bool, include_autostart: bool) -> Result<serde_json::Value, String> {
    let mut out = serde_json::json!({ "socket": socket, "restore_on_start": enabled, "boot_id": boot_now });
    let open = with_store(|s| s.restore_batch(socket))?;
    let last = with_store(|s| s.last_batch(socket))?;
    if let Some(b) = open {
        out["source"] = "open".into();
        out["batch"] = batch_view(&b);
    } else if let Some(b) = last.filter(|b| b.boot_id.is_some() && b.boot_id.as_deref() == boot_now) {
        out["source"] = "last".into();
        out["batch"] = batch_view(&b);
    } else {
        let (latest, prev) = with_store(|s| Ok((s.checkpoint(socket)?, s.checkpoint_prev(socket)?)))?;
        match restore::evidence(latest.as_ref(), prev.as_ref()) {
            Some(cp) => {
                let plan = restore::plan(cp, &declared()?, &with_store(|s| s.restore_intents())?, include_autostart, &restore::LiveFacts);
                out["source"] = "plan".into();
                out["plan"] = plan_view(&plan)?;
            }
            None => {
                out["source"] = "none".into();
                out["reason"] = "no checkpoint for this tmux socket yet".into();
            }
        }
    }
    Ok(out)
}

/// The plan as a person reads it: every skip carries its reason's words
/// (`text`) beside its word.
fn plan_view(plan: &restore::Plan) -> Result<serde_json::Value, String> {
    let mut v = serde_json::to_value(plan).map_err(|e| format!("encode plan: {e}"))?;
    for (i, p) in plan.skipped.iter().enumerate() {
        v["skipped"][i]["text"] = p.reason.text().into();
    }
    for (pi, p) in plan.projects.iter().enumerate() {
        for (wi, w) in p.skipped.iter().enumerate() {
            v["projects"][pi]["skipped"][wi]["text"] = w.reason.text().into();
        }
    }
    Ok(v)
}

/// The one RPC behind `tmm project restore` (`project_restore`): `show`,
/// `run` (admission under the lock, then the existing background
/// continuation; it answers within the RPC, before any window is made) or
/// `abandon`.
pub fn restore_rpc(action: &str) -> Result<serde_json::Value, String> {
    let socket = restore::socket_key();
    let boot = restore::boot_id();
    let enabled = crate::config::restore_on_start();
    match action {
        "show" => show(&socket, boot.as_deref(), enabled, true),
        "run" => {
            let a = admit_manual(&socket, boot.as_deref(), true)?;
            let reply = serde_json::json!({ "accepted": true, "mode": a.mode, "batch": a.batch.batch, "attempt": a.batch.attempt, "items": batch_view(&a.batch) });
            let inputs = RunInputs { socket, enabled, boot_now: boot, include_autostart: true };
            spawn_schedule(inputs, Start::Pass(a.lease, a.batch));
            Ok(reply)
        }
        "abandon" => Ok(match abandon(&socket)? {
            Some(batch) => serde_json::json!({ "abandoned": true, "batch": batch }),
            None => serde_json::json!({ "abandoned": false, "reason": "no restore is open" }),
        }),
        other => Err(format!("unknown restore action '{other}' (show, run or abandon)")),
    }
}

/// The admitted continuation, on its own thread like the start's.
fn spawn_schedule(inputs: RunInputs, start: Start) {
    #[cfg(test)]
    if let Some(hook) = SPAWN_HOOK.lock().unwrap().take() {
        return hook(inputs, start);
    }
    std::thread::spawn(move || continue_schedule(inputs, start));
}

/// Test seam: receives the next admitted continuation instead of a thread.
#[cfg(test)]
pub(crate) static SPAWN_HOOK: std::sync::Mutex<Option<Box<dyn FnOnce(RunInputs, Start) + Send>>> = std::sync::Mutex::new(None);

/// Before a capture tick (board #422 round 3): when the tick's boot is
/// known and no prepare has decided for it — the boot became readable, or a
/// decision write failed — prepare now, as a start does, and run its
/// schedule in the background. Said once per change of reason when it
/// cannot decide, so a tick never refuses silently.
pub fn decide_if_needed() {
    static SAID: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let Some(boot) = restore::tick_boot() else { return };
    let inputs = start_inputs();
    match with_store(|s| s.restore_decided(&inputs.socket)) {
        Ok(Some(b)) if b == boot => return,
        Ok(_) => {}
        Err(e) => {
            let mut said = SAID.lock().unwrap();
            if *said != e {
                eprintln!("projects: the restore decision cannot be read: {e}");
                *said = e;
            }
            return;
        }
    }
    let inputs = RunInputs { boot_now: Some(boot), ..inputs };
    let said = |why: String| {
        let mut said = SAID.lock().unwrap();
        if *said != why {
            eprintln!("projects: the restore decision for this boot is not made yet: {why}");
            *said = why;
        }
    };
    match prepare(&inputs) {
        Ok(Prepared::Ready { lease, batch }) => {
            std::thread::spawn(move || continue_schedule(inputs, Start::Pass(lease, batch)));
        }
        // The owner decides; its decision lets the ticks commit.
        Ok(Prepared::Busy) => said("another owner holds the restore lock".into()),
        Ok(_) => {}
        Err(e) => said(e),
    }
}

/// One planned hold per agent slot of a new batch.
fn planned_holds(b: &Batch) -> Vec<super::store::Hold> {
    let since = super::now();
    b.projects
        .iter()
        .flat_map(|p| {
            p.windows.iter().filter_map(move |w| {
                w.launch.clone().map(|launch| super::store::Hold {
                    socket: b.socket.clone(),
                    project_id: p.id.clone(),
                    batch: b.batch.clone(),
                    ord: w.ord,
                    slot: w.name.clone(),
                    launch,
                    stage: super::store::HoldStage::Planned,
                    pane: None,
                    since,
                    accepted_seq: None,
                    not_ready: false,
                    reported: false,
                    merging: false,
                })
            })
        })
        .collect()
}

/// Execute an open batch as far as it can go this pass, under the lease
/// `prepare` (or a later pass's own acquire) took — never a second fd.
pub fn continue_batch(lease: OwnerLock, mut b: Batch) -> Result<RunOutcome, String> {
    let _lease = lease;
    b.owner_pid = std::process::id();
    save(&mut b)?;
    match execute(&mut b) {
        Ok(()) => {}
        Err(e) if e == HALTED => return Ok(RunOutcome::Ran { batch: b.batch, closed: None }),
        Err(e) => return Err(e),
    }
    Ok(RunOutcome::Ran { batch: b.batch.clone(), closed: b.closed.clone() })
}

/// A new batch from the evidence, or why there is none.
fn start_batch(inputs: &RunInputs) -> Result<Result<Batch, String>, String> {
    let socket = inputs.socket.as_str();
    if let Some(last) = with_store(|s| s.last_batch(socket))? {
        if last.boot_id.is_some() && last.boot_id == inputs.boot_now {
            return Ok(Err("this boot was already restored".into()));
        }
    }
    let (latest, prev) = with_store(|s| Ok((s.checkpoint(socket)?, s.checkpoint_prev(socket)?)))?;
    let evidence = restore::evidence(latest.as_ref(), prev.as_ref());
    let now = restore::tmux_now_on(Some(socket));
    if let restore::Trigger::Skip(why) = restore::reboot_trigger(inputs.enabled, evidence, inputs.boot_now.as_deref(), &now) {
        return Ok(Err(why));
    }
    let Some(cp) = evidence else { return Ok(Err("no evidence".into())) };
    plan_batch(socket, inputs.boot_now.clone(), cp, inputs.include_autostart)
}

/// A new batch from the checkpoint `cp` and the declaration as it is now, or
/// why there is none: the one planning step the start and the manual door
/// share.
fn plan_batch(socket: &str, boot_now: Option<String>, cp: &super::store::Checkpoint, include_autostart: bool) -> Result<Result<Batch, String>, String> {
    let declared = declared()?;
    let intents = with_store(|s| s.restore_intents())?;
    let plan = restore::plan(cp, &declared, &intents, include_autostart, &restore::LiveFacts);
    if plan.projects.is_empty() {
        return Ok(Err("nothing to restore".into()));
    }
    let projects = plan
        .projects
        .into_iter()
        .map(|p| BatchProject {
            id: p.id,
            name: p.name,
            path: p.path,
            session: p.session,
            autostart_only: p.autostart_only,
            state: ProjectState::Pending,
            reason: None,
            session_id: None,
            holder_id: None,
            op: None,
            finished: None,
            windows: p
                .windows
                .into_iter()
                .enumerate()
                .map(|(ord, w)| BatchWindow {
                    ord,
                    name: w.name,
                    kind: w.kind,
                    managed: w.managed,
                    cwd: w.cwd,
                    backend: w.backend,
                    agent_session_id: w.agent_session_id,
                    state: WindowState::Pending,
                    reason: None,
                    window_id: None,
                    pane_id: None,
                    pane_pid: None,
                    launch: (w.kind == SlotKind::Agent).then(|| uuid::Uuid::new_v4().to_string()),
                    op: None,
                    typed: Some(false),
                    released: false,
                    create_issued: Some(false),
                })
                .collect(),
        })
        .collect();
    Ok(Ok(Batch {
        batch: uuid::Uuid::new_v4().to_string(),
        socket: socket.to_string(),
        boot_id: boot_now,
        owner_pid: std::process::id(), attempt: 0,
        instance: None,
        source: cp.clone(),
        closed: None,
        projects,
    }))
}

fn declared() -> Result<Vec<restore::Declared>, String> {
    with_store(|s| {
        let mut out = Vec::new();
        for project in s.list_projects(true)? {
            let slots = s.slots(&project.id)?;
            out.push(restore::Declared { project, slots });
        }
        Ok(out)
    })
}

fn save(b: &mut Batch) -> Result<(), String> {
    with_store(|s| s.save_batch(b))
}

fn close(b: &mut Batch, word: &str) -> Result<(), String> {
    b.closed = Some(word.to_string());
    with_store(|s| s.close_batch(b))
}

fn execute(b: &mut Batch) -> Result<(), String> {
    for pi in 0..b.projects.len() {
        if matches!(b.projects[pi].state, ProjectState::Done | ProjectState::Skipped | ProjectState::Failed) {
            continue;
        }
        // The server the batch made its objects on must still be the one
        // answering; an instance change closes the batch FAILED.
        if let Some(inst) = b.instance.clone() {
            match restore::tmux_now_on(Some(&b.socket)) {
                restore::TmuxNow::Present { instance, .. } if instance == inst => {}
                restore::TmuxNow::Unknown(e) => {
                    eprintln!("projects: restore {}: tmux unknown, left open: {e}", b.batch);
                    return Ok(());
                }
                _ => {
                    close(b, "failed: the tmux server restarted during the restore")?;
                    return Ok(());
                }
            }
        }
        step_project(b, pi)?;
        if b.closed.is_some() {
            return Ok(());
        }
    }
    let unfinished = b.projects.iter().any(|p| !matches!(p.state, ProjectState::Done | ProjectState::Skipped | ProjectState::Failed));
    if !unfinished {
        close(b, super::store::finished_word(b))?;
    }
    Ok(())
}

fn set_project(b: &mut Batch, pi: usize, state: ProjectState, reason: Option<String>, op: Option<BatchOp>) -> Result<(), String> {
    let p = &mut b.projects[pi];
    p.state = state;
    p.reason = reason;
    p.op = op;
    // A project that ends here (skipped whole, or failed before its windows)
    // is reported in the same transaction (board #422 round 4).
    if matches!(state, ProjectState::Skipped | ProjectState::Failed) {
        return save_reporting(b, pi, EVENT_FINISHED, "");
    }
    save(b)
}

fn set_window(b: &mut Batch, pi: usize, wi: usize, state: WindowState, reason: Option<String>, op: Option<BatchOp>) -> Result<(), String> {
    let w = &mut b.projects[pi].windows[wi];
    // A slot that ends with NOTHING of ours known to exist (skipped before a
    // create, a refused create) retires its hold in the same transaction
    // (board #422 round 3). A window we made keeps it until its pane is
    // confirmed gone (`set_window_retiring` after a confirmed kill, or the
    // prune): untyped is not ended (review H1 P1-D).
    let untyped = matches!(w.state, WindowState::Pending | WindowState::Creating | WindowState::Created);
    let retire = (untyped && w.window_id.is_none() && matches!(state, WindowState::Skipped | WindowState::Failed)).then(|| w.launch.clone()).flatten();
    w.state = state;
    w.reason = reason;
    w.op = op;
    match retire {
        Some(launch) => with_store(|s| s.save_batch_retiring(b, &launch)),
        None => save(b),
    }
}

/// `set_window` for a window whose pane is CONFIRMED gone (a kill applied
/// in-server, or observed absent): its hold retires in the same transaction.
fn set_window_retiring(b: &mut Batch, pi: usize, wi: usize, state: WindowState, reason: Option<String>) -> Result<(), String> {
    let w = &mut b.projects[pi].windows[wi];
    w.state = state;
    w.reason = reason;
    w.op = None;
    match w.launch.clone() {
        Some(launch) => with_store(|s| s.save_batch_retiring(b, &launch)),
        None => save(b),
    }
}

/// The window is tagged and nothing is typed: `Created`, with its hold bound
/// to this exact window in the same transaction (board #422 round 3). A hold
/// that is no longer planned and not already bound to this pane means the
/// barrier is not this window's: it is never launched.
fn set_created(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    let Some(launch) = w.launch.clone() else {
        return set_window(b, pi, wi, WindowState::Created, None, None);
    };
    let pane = match (b.instance.clone(), b.projects[pi].session_id.clone(), w.window_id.clone(), w.pane_id.clone(), w.pane_pid) {
        (Some(instance), Some(session_id), Some(window_id), Some(pane_id), Some(pane_pid)) => {
            super::store::HoldPane { instance, session_id, window_id, pane_id, pane_pid }
        }
        _ => return set_window(b, pi, wi, WindowState::Failed, Some("no window identity for its input barrier".into()), None),
    };
    {
        let w = &mut b.projects[pi].windows[wi];
        w.state = WindowState::Created;
        w.reason = None;
        w.op = None;
    }
    if with_store(|s| s.save_batch_binding(b, &launch, &pane))? {
        return Ok(());
    }
    match with_store(|s| s.hold_by_launch(&launch))? {
        Some(h) if h.pane.as_ref() == Some(&pane) => save(b),
        _ => set_window(b, pi, wi, WindowState::Failed, Some("its input barrier is gone; nothing was typed".into()), None),
    }
}

/// The declaration as it is NOW against the FROZEN plan: the old plan is no
/// permission to override a later act (a down, an archive, a delete, a
/// moved-away directory), nor to act on a project that is no longer the one
/// planned — a renamed session or a moved path is refused (review P1-B).
fn reread_block(p: &BatchProject) -> Result<Option<String>, String> {
    Ok(reread(p)?.err())
}

/// The row, validated against the frozen plan, or why it refuses. The ONE
/// validated row a launch uses for its recipe, identity and staging (review
/// round 2, P1-B residual): no later, unchecked read of the row.
fn reread(p: &BatchProject) -> Result<Result<super::store::Project, String>, String> {
    let (row, intents) = with_store(|s| Ok((s.project(&p.id)?, s.restore_intents()?)))?;
    Ok(match row {
        None => Err("the project was deleted".into()),
        Some(r) if r.archived => Err("the project is archived".into()),
        Some(_) if intents.down.contains(&p.id) => Err("the project was taken down".into()),
        Some(r) if r.session != p.session || r.path != p.path => Err("the project changed since the plan (session or path)".into()),
        Some(r) if !std::path::Path::new(&r.path).is_dir() => Err("the project's directory is gone".into()),
        Some(r) => Ok(r),
    })
}

fn step_project(b: &mut Batch, pi: usize) -> Result<(), String> {
    let id = b.projects[pi].id.clone();
    halt_check(mangle(&Step { op: "project", project: id.clone(), ord: None }))?;
    let block = reread_block(&b.projects[pi])?;
    match b.projects[pi].state {
        ProjectState::Pending => {
            if let Some(why) = block {
                return set_project(b, pi, ProjectState::Skipped, Some(why), None);
            }
            claim(b, pi)?;
        }
        ProjectState::CreatingSession => takeover(b, pi)?,
        _ => {}
    }
    if b.projects[pi].state == ProjectState::Open && b.projects[pi].op == Some(BatchOp::TagSession) {
        tag_session(b, pi)?;
    }
    if b.projects[pi].state != ProjectState::Open || b.closed.is_some() {
        return Ok(());
    }
    if let Some(why) = reread_block(&b.projects[pi])? {
        for wi in 0..b.projects[pi].windows.len() {
            if b.projects[pi].windows[wi].state == WindowState::Pending {
                set_window(b, pi, wi, WindowState::Skipped, Some(why.clone()), None)?;
            }
        }
    }
    for wi in 0..b.projects[pi].windows.len() {
        step_window(b, pi, wi)?;
        if b.projects[pi].state != ProjectState::Open {
            return Ok(());
        }
    }
    finish_project(b, pi)
}

/// The claim: ONE `new-session` that makes the session with our batch in
/// its environment and the holder as its first window.
fn claim(b: &mut Batch, pi: usize) -> Result<(), String> {
    set_project(b, pi, ProjectState::CreatingSession, None, Some(BatchOp::Claim))?;
    let p = b.projects[pi].clone();
    let step = Step { op: "claim", project: p.id.clone(), ord: None };
    let m = mangle(&step);
    halt_check(m)?;
    let env = format!("TMM_RESTORE_BATCH={}", b.batch);
    let holder = holder_name(&b.batch);
    let out = tmux::run_tmux_on(
        Some(&b.socket),
        &["new-session", "-d", "-s", &p.session, "-c", &p.path, "-e", &env, "-n", &holder, "-P", "-F", &format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{socket_path}}{SEP}#{{session_id}}{SEP}#{{window_id}}")],
    );
    if m == Mangle::RunThenHalt {
        return Err(HALTED.into());
    }
    let out = if m == Mangle::DropReceipt { Err("the answer was lost".to_string()) } else { out };
    match out {
        Ok(line) => {
            let f: Vec<&str> = line.trim_end_matches('\n').split(SEP).collect();
            if let [pid, start, sock, sid, hid] = f.as_slice() {
                if let (Ok(pid), Ok(start_time)) = (pid.parse(), start.parse()) {
                    let inst = TmuxInstance { socket: sock.to_string(), pid, start_time };
                    if !adopt_instance(b, &inst)? {
                        return Ok(());
                    }
                    let p = &mut b.projects[pi];
                    p.session_id = Some(sid.to_string());
                    p.holder_id = Some(hid.to_string());
                    return tag_session(b, pi);
                }
            }
            takeover(b, pi)
        }
        Err(e) if e.contains("duplicate session") => match observe_session(&b.socket, &p.session, &b.batch) {
            SessionSeen::Ours { .. } => takeover(b, pi),
            SessionSeen::Unknown(e) => set_project(b, pi, ProjectState::CreatingSession, Some(format!("indeterminate: {e}")), Some(BatchOp::Claim)),
            _ => set_project(b, pi, ProjectState::Skipped, Some("session exists".into()), None),
        },
        Err(_) => takeover(b, pi),
    }
}

/// Record the batch's server on its first creation, or check it; `false`
/// when the batch was closed because another server answered.
fn adopt_instance(b: &mut Batch, inst: &TmuxInstance) -> Result<bool, String> {
    match &b.instance {
        None => {
            b.instance = Some(inst.clone());
            save(b)?;
            Ok(true)
        }
        Some(known) if known == inst => Ok(true),
        Some(_) => {
            close(b, "failed: the tmux server restarted during the restore")?;
            Ok(false)
        }
    }
}

/// A claim whose answer was not seen (or a successor finding one): ours
/// only when the session carries our FULL batch in its environment, read in
/// the same connection as the server identity, in the batch's own boot.
fn takeover(b: &mut Batch, pi: usize) -> Result<(), String> {
    let p = b.projects[pi].clone();
    match observe_session(&b.socket, &p.session, &b.batch) {
        // The batch is this boot's: `run` continues an open batch only when
        // both boots are known and equal (review P1-D), so a session with our
        // full uuid in its env was made by this batch on a server of this boot.
        SessionSeen::Ours { instance, session_id } => {
            if !adopt_instance(b, &instance)? {
                return Ok(());
            }
            let holder = holder_name(&b.batch);
            let holder_id = observe_windows(&b.socket, &session_id, &instance)?
                .unwrap_or_default()
                .into_iter()
                .find(|w| w.name == holder)
                .map(|w| w.id);
            let p = &mut b.projects[pi];
            p.session_id = Some(session_id);
            p.holder_id = holder_id;
            tag_session(b, pi)
        }
        SessionSeen::Absent => set_project(b, pi, ProjectState::Failed, Some("indeterminate: new-session".into()), None),
        SessionSeen::NotOurs => set_project(b, pi, ProjectState::Skipped, Some("session exists".into()), None),
        SessionSeen::Unknown(e) => set_project(b, pi, ProjectState::CreatingSession, Some(format!("indeterminate: {e}")), Some(BatchOp::Claim)),
    }
}

/// Install the session tag, guarded by the env the session was born with.
fn tag_session(b: &mut Batch, pi: usize) -> Result<(), String> {
    let (Some(inst), Some(sid)) = (b.instance.clone(), b.projects[pi].session_id.clone()) else {
        return set_project(b, pi, ProjectState::Failed, Some("no session identity".into()), None);
    };
    set_project(b, pi, ProjectState::Open, None, Some(BatchOp::TagSession))?;
    let step = Step { op: "tag_session", project: b.projects[pi].id.clone(), ord: None };
    let action = format!("set-option -t {} @tmm_rs {}", tmux::tmux_quote(&sid), tmux::tmux_quote(&b.batch));
    let cond = session_boot_cond(&inst, &sid, &b.batch);
    let first = guarded(&b.socket, &step, &sid, &cond, &action)?;
    if let Outcome::Applied(_) = first {
        return set_project(b, pi, ProjectState::Open, None, None);
    }
    // Re-observe on the batch's server: tagged (by us or a predecessor) is
    // done; present, ours by env and untagged is NOT foreign — after an
    // Unknown the idempotent install is redone under the same bootstrap
    // guard (review P2); only a different env or another server is "not ours".
    match session_tags(&b.socket, &sid) {
        Ok(Some((i, rs, env))) if i == (inst.pid, inst.start_time) && env == b.batch && rs == b.batch => set_project(b, pi, ProjectState::Open, None, None),
        Ok(Some((i, rs, env))) if i == (inst.pid, inst.start_time) && env == b.batch && rs.is_empty() => {
            if matches!(first, Outcome::Unknown(_)) {
                if let Outcome::Applied(_) = guarded(&b.socket, &step, &sid, &cond, &action)? {
                    return set_project(b, pi, ProjectState::Open, None, None);
                }
            }
            set_project(b, pi, ProjectState::Failed, Some("tag unconfirmed".into()), None)
        }
        Ok(Some(_)) => set_project(b, pi, ProjectState::Failed, Some("the session is not ours".into()), None),
        Ok(None) => set_project(b, pi, ProjectState::Failed, Some("our session is gone".into()), None),
        Err(e) => set_project(b, pi, ProjectState::Open, Some(format!("indeterminate: {e}")), Some(BatchOp::TagSession)),
    }
}

/// A session's server identity, `@tmm_rs` and restore env by its native id;
/// `None` = confirmed gone.
fn session_tags(socket: &str, sid: &str) -> Result<Option<((u32, u64), String, String)>, String> {
    let fmt = format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{@tmm_rs}}{SEP}#{{TMM_RESTORE_BATCH}}");
    match tmux::run_tmux_on(Some(socket), &["display", "-p", "-t", sid, &fmt]) {
        Ok(out) => {
            let f: Vec<&str> = out.trim_end_matches('\n').split(SEP).collect();
            match f[..] {
                [pid, start, rs, env] => match (pid.parse(), start.parse()) {
                    (Ok(p), Ok(st)) => Ok(Some(((p, st), rs.to_string(), env.to_string()))),
                    _ => Err(format!("unreadable session identity: {out:?}")),
                },
                _ => Err(format!("unreadable session identity: {out:?}")),
            }
        }
        Err(e) if tmux::session_confirmed_absent(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The structured delimiter every parsed tmux answer here uses (socket paths
/// and names may hold spaces).
const SEP: &str = "<TMM_SEP>";

/// The session tag's BOOTSTRAP guard: the server, the native session id,
/// the env the session was born with (the full uuid), and no tag yet.
fn session_boot_cond(inst: &TmuxInstance, sid: &str, batch: &str) -> String {
    let mut parts = instance_parts(inst);
    parts.extend([eq("session_id", sid), eq("TMM_RESTORE_BATCH", batch), eq("@tmm_rs", "")]);
    all(parts)
}

/// The window tag's BOOTSTRAP guard: the server, the parent session's id,
/// env and tag, the window's native id and its full-uuid birth name, and no
/// window tag yet.
fn window_boot_cond(inst: &TmuxInstance, sid: &str, wid: &str, ord: usize, batch: &str) -> String {
    let mut parts = instance_parts(inst);
    parts.extend([
        eq("session_id", sid),
        eq("window_id", wid),
        eq("window_name", &placeholder(batch, ord)),
        eq("TMM_RESTORE_BATCH", batch),
        eq("@tmm_rs", batch),
        eq("@tmm_rw", ""),
    ]);
    all(parts)
}

/// The session-level condition every window creation needs.
fn session_cond(b: &Batch, pi: usize) -> Option<(String, String)> {
    let inst = b.instance.as_ref()?;
    let sid = b.projects[pi].session_id.clone()?;
    let mut parts = instance_parts(inst);
    parts.extend([eq("session_id", &sid), eq("TMM_RESTORE_BATCH", &b.batch), eq("@tmm_rs", &b.batch)]);
    Some((sid, all(parts)))
}

/// The condition on one of our windows once tagged: the server, the full
/// batch tags, and the window's OWN frozen identity — its native id inside
/// its project's native session (the ord alone repeats across projects,
/// review P1-B).
fn tagged_cond(b: &Batch, pi: usize, w: &BatchWindow, with_placeholder: bool) -> Option<String> {
    let inst = b.instance.as_ref()?;
    let sid = b.projects[pi].session_id.as_deref()?;
    let wid = w.window_id.as_deref()?;
    let mut parts = instance_parts(inst);
    parts.extend([
        eq("session_id", sid),
        eq("window_id", wid),
        eq("TMM_RESTORE_BATCH", &b.batch),
        eq("@tmm_rs", &b.batch),
        eq("@tmm_rw", &format!("{}:{}", b.batch, w.ord)),
    ]);
    if with_placeholder {
        parts.push(eq("window_name", &placeholder(&b.batch, w.ord)));
    }
    Some(all(parts))
}

/// Advance one window as far as it goes in this pass: each step is one
/// write-ahead transition; it stops at a final state or where a step made
/// no progress (left for the next pass to re-observe).
fn step_window(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    for _ in 0..8 {
        let before = (b.projects[pi].windows[wi].state, b.projects[pi].windows[wi].op);
        step_window_once(b, pi, wi)?;
        let after = (b.projects[pi].windows[wi].state, b.projects[pi].windows[wi].op);
        let done = matches!(after.0, WindowState::Launched | WindowState::LaunchUnknown | WindowState::Skipped | WindowState::Failed);
        if done || after == before || b.projects[pi].state != ProjectState::Open || b.closed.is_some() {
            break;
        }
    }
    Ok(())
}

fn step_window_once(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    match (w.state, w.op) {
        (WindowState::Pending, _) => {
            let id = b.projects[pi].id.clone();
            let stopped = with_store(|s| s.restore_intents())?.stopped.contains(&(id, w.name.clone()));
            if stopped {
                return set_window(b, pi, wi, WindowState::Skipped, Some("the agent was stopped".into()), None);
            }
            create_window(b, pi, wi)
        }
        (WindowState::Creating, Some(BatchOp::CreateWindow)) => observe_created(b, pi, wi),
        (WindowState::Creating, Some(BatchOp::TagWindow)) => tag_window(b, pi, wi),
        (WindowState::Created, Some(BatchOp::Kill)) => observe_kill(b, pi, wi),
        (WindowState::Created, _) => launch(b, pi, wi),
        // A predecessor wrote LaunchIssued and did not see the typing's end:
        // the launch may have run. Never touched again.
        (WindowState::LaunchIssued, _) => set_window(b, pi, wi, WindowState::LaunchUnknown, Some("the start command may have run; left as is".into()), None),
        _ => Ok(()),
    }
}

fn create_window(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let Some((sid, cond)) = session_cond(b, pi) else {
        return set_window(b, pi, wi, WindowState::Failed, Some("no session identity".into()), None);
    };
    let name = b.projects[pi].windows[wi].name.clone();
    // The "a person made this window" decision is in-server too: the create
    // runs only while no window of the slot's name exists in the session
    // (review round 2 / orchestrator). A name the format grammar cannot hold
    // literally is not guarded, so it is not created.
    if name.contains(['#', '{', '}', ',']) {
        return set_window(b, pi, wi, WindowState::Skipped, Some("a window name the restore cannot guard".into()), None);
    }
    let cond = all(vec![cond, format!("#{{==:#{{W:#{{?#{{==:#{{window_name}},{name}}},x,}}}},}}")]);
    // From this write on, a window may exist that no id of ours names (a
    // lost receipt): only an in-server refusal proves it does not (round 4
    // review P1-C).
    b.projects[pi].windows[wi].create_issued = Some(true);
    set_window(b, pi, wi, WindowState::Creating, None, Some(BatchOp::CreateWindow))?;
    let w = b.projects[pi].windows[wi].clone();
    let cwd = super::reconcile::absolute_cwd(&b.projects[pi].path, &w.cwd);
    let action = format!(
        "new-window -d -t {} -n {} -c {} -P -F {}",
        tmux::tmux_quote(&sid),
        tmux::tmux_quote(&placeholder(&b.batch, w.ord)),
        tmux::tmux_quote(&cwd),
        tmux::tmux_quote("#{window_id} #{pane_id} #{pane_pid}")
    );
    let step = Step { op: "create_window", project: b.projects[pi].id.clone(), ord: Some(w.ord) };
    match guarded(&b.socket, &step, &sid, &cond, &action)? {
        Outcome::Applied(ids) => {
            let mut it = ids.split_whitespace();
            match (it.next(), it.next(), it.next().and_then(|p| p.parse::<u32>().ok())) {
                (Some(wid), Some(pane), Some(pid)) if wid.starts_with('@') && pane.starts_with('%') => {
                    let w = &mut b.projects[pi].windows[wi];
                    w.window_id = Some(wid.into());
                    w.pane_id = Some(pane.into());
                    w.pane_pid = Some(pid);
                    tag_window(b, pi, wi)
                }
                _ => observe_created(b, pi, wi),
            }
        }
        Outcome::Refused => {
            // Nothing was created. A window of the slot's name in OUR session
            // is the person's; anything else means the session is not ours.
            b.projects[pi].windows[wi].create_issued = Some(false);
            let inst = b.instance.clone();
            let theirs = inst.and_then(|i| observe_windows(&b.socket, &sid, &i).ok().flatten()).is_some_and(|v| v.iter().any(|s| s.name == name && s.tag.is_empty()));
            if theirs {
                return set_window(b, pi, wi, WindowState::Skipped, Some("window exists".into()), None);
            }
            set_window(b, pi, wi, WindowState::Failed, Some("our session is gone or not ours".into()), None)?;
            set_project(b, pi, ProjectState::Failed, Some("our session is gone or not ours".into()), None)
        }
        Outcome::Unknown(_) => observe_created(b, pi, wi),
    }
}

/// A creation whose answer was not seen: find the window by its FULL
/// placeholder name in our session. Never a second `new-window`.
fn observe_created(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let (Some(inst), Some(sid)) = (b.instance.clone(), b.projects[pi].session_id.clone()) else {
        return set_window(b, pi, wi, WindowState::Failed, Some("no session identity".into()), None);
    };
    let w = b.projects[pi].windows[wi].clone();
    let name = placeholder(&b.batch, w.ord);
    match observe_windows(&b.socket, &sid, &inst) {
        Ok(Some(seen)) => match seen.into_iter().find(|s| s.name == name || s.tag == format!("{}:{}", b.batch, w.ord)) {
            Some(s) => {
                let w = &mut b.projects[pi].windows[wi];
                w.window_id = Some(s.id);
                w.pane_id = Some(s.pane);
                w.pane_pid = s.pane_pid;
                tag_window(b, pi, wi)
            }
            None => set_window(b, pi, wi, WindowState::Failed, Some("indeterminate: new-window".into()), None),
        },
        Ok(None) => set_window(b, pi, wi, WindowState::Failed, Some("our session is gone".into()), None),
        Err(e) => set_window(b, pi, wi, WindowState::Creating, Some(format!("indeterminate: {e}")), Some(BatchOp::CreateWindow)),
    }
}

/// Install the window tag, guarded by the FULL placeholder name it was born
/// with and its parent session's env and tag (the bootstrap form).
fn tag_window(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let (Some(inst), Some(sid)) = (b.instance.clone(), b.projects[pi].session_id.clone()) else {
        return set_window(b, pi, wi, WindowState::Failed, Some("no session identity".into()), None);
    };
    let w = b.projects[pi].windows[wi].clone();
    let Some(wid) = w.window_id.clone() else { return observe_created(b, pi, wi) };
    set_window(b, pi, wi, WindowState::Creating, None, Some(BatchOp::TagWindow))?;
    let tag = format!("{}:{}", b.batch, w.ord);
    let cond = window_boot_cond(&inst, &sid, &wid, w.ord, &b.batch);
    let step = Step { op: "tag_window", project: b.projects[pi].id.clone(), ord: Some(w.ord) };
    let tag_action = format!("set-option -w -t {} @tmm_rw {}", tmux::tmux_quote(&wid), tmux::tmux_quote(&tag));
    let outcome = guarded(&b.socket, &step, &wid, &cond, &tag_action)?;
    if let Outcome::Applied(_) = outcome {
        return set_created(b, pi, wi);
    }
    // Refused or Unknown: re-observe by id on the batch's server.
    match observe_windows(&b.socket, &sid, &inst) {
        Ok(Some(seen)) => match seen.into_iter().find(|s| s.id == wid) {
            Some(s) if s.tag == tag => set_created(b, pi, wi),
            Some(s) if s.tag.is_empty() && s.name == placeholder(&b.batch, w.ord) && matches!(outcome, Outcome::Unknown(_)) => {
                // Present, ours by birth name, untagged: the install is
                // redone under the same guard (idempotent, not blind).
                match guarded(&b.socket, &step, &wid, &cond, &tag_action)? {
                    Outcome::Applied(_) => set_created(b, pi, wi),
                    _ => set_window(b, pi, wi, WindowState::Creating, Some("indeterminate: tag".into()), Some(BatchOp::TagWindow)),
                }
            }
            Some(_) => set_window(b, pi, wi, WindowState::Failed, Some("the window is not ours".into()), None),
            None => set_window(b, pi, wi, WindowState::Failed, Some("the window is gone".into()), None),
        },
        Ok(None) => set_window(b, pi, wi, WindowState::Failed, Some("our session is gone".into()), None),
        Err(e) => set_window(b, pi, wi, WindowState::Creating, Some(format!("indeterminate: {e}")), Some(BatchOp::TagWindow)),
    }
}

/// Type the exact launch, then give the window its slot name.
fn launch(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    let p = b.projects[pi].clone();
    if w.window_id.is_none() {
        return set_window(b, pi, wi, WindowState::Failed, Some("no window identity".into()), None);
    }
    let slot = Slot {
        id: None,
        ord: w.ord as i64,
        window_name: w.name.clone(),
        cwd: w.cwd.clone(),
        kind: w.kind,
        command: w.backend.clone(),
        auto_run: w.kind == SlotKind::Agent,
        agent_session_id: w.agent_session_id.clone(),
        first_seen_at: 0,
        settled_at: Some(0),
    };
    // The reread at the door: a Stop, a down or an archive since the plan.
    let id = p.id.clone();
    let stopped = with_store(|s| s.restore_intents())?.stopped.contains(&(id.clone(), w.name.clone()));
    let row = if stopped { Err("the agent was stopped".to_string()) } else { reread(&p)? };
    // A seam between the validation and everything built from it.
    halt_check(mangle(&Step { op: "door", project: p.id.clone(), ord: Some(w.ord) }))?;
    let line = match &row {
        Err(why) => Err(why.clone()),
        Ok(row) => super::reconcile::slot_command_exact(&row.path, &slot, w.managed),
    };
    let line = match line {
        Ok(line) => line,
        Err(why) => return kill_owned(b, pi, wi, why),
    };
    if let (Some(line), Ok(row)) = (line, &row) {
        let text = super::reconcile::launch_text(row, &slot, &line, w.launch.as_deref());
        // The launch is typed ONLY into a shell whose prompt was seen — the
        // observable edge, never a timeout (validator load finding,
        // orchestrator 00:55): a shell still starting when the host is busy
        // drops typed-ahead input, and a lost launch must never be recorded
        // as Launched. Not seen in time: nothing is typed, the window stays
        // Created, and the next pass looks again.
        let ready = match &w.pane_id {
            Some(pane) => tmux::wait_for_shell_on(Some(&b.socket), pane, prompt_wait()),
            None => false,
        };
        if !ready {
            return set_window(b, pi, wi, WindowState::Created, Some("shell not ready; not started".into()), None);
        }
        // A dsh home's readiness files are reset BEFORE the hold is armed
        // (board #422 round 3, P1-C): readiness is read only in `armed`, so a
        // file of any earlier start cannot be taken for this launch's. A
        // reset that fails types nothing.
        if w.launch.is_some() && w.backend.as_deref() == Some("dsh") {
            if let Err(e) = reset_dsh_readiness(&row.path, &w.name) {
                return set_window(b, pi, wi, WindowState::Created, Some(format!("readiness could not be reset: {e}")), None);
            }
        }
        // Write-ahead: from here the window is never killed, renamed or
        // retyped. An agent's hold is armed in the same transaction, and a
        // hold that cannot be armed types nothing (board #422 round 3). The
        // same write records `typed` — input may be sent from here on —
        // before anything is (round 4): monotonic, never cleared.
        match w.launch.clone() {
            Some(launch) => {
                {
                    let ww = &mut b.projects[pi].windows[wi];
                    ww.state = WindowState::LaunchIssued;
                    ww.reason = None;
                    ww.op = None;
                    ww.typed = Some(true);
                }
                if !with_store(|s| s.save_batch_arming(b, &launch))? {
                    // Not committed: nothing was recorded, nothing typed.
                    b.projects[pi].windows[wi].typed = w.typed;
                    return set_window(b, pi, wi, WindowState::Failed, Some("its input barrier is not this window's; nothing was typed".into()), None);
                }
            }
            None => {
                b.projects[pi].windows[wi].typed = Some(true);
                set_window(b, pi, wi, WindowState::LaunchIssued, None, None)?
            }
        }
        // The typing goes to the PANE the window was created with, and only
        // while that window still has exactly that one pane (review P1-B):
        // a split or a moved window refuses, nothing is typed.
        let (Some(cond), Some(pane)) = (tagged_cond(b, pi, &w, true), w.pane_id.clone()) else {
            return set_window(b, pi, wi, WindowState::Failed, Some("no window identity; nothing was typed".into()), None);
        };
        let cond = all(vec![cond, eq("pane_id", &pane), eq("window_panes", "1")]);
        let step = Step { op: "launch", project: p.id.clone(), ord: Some(w.ord) };
        let m = mangle(&step);
        let q = tmux::tmux_quote(&pane);
        let enter = if m == Mangle::TextOnly { String::new() } else { format!(" ; send-keys -t {q} Enter") };
        let action = format!("send-keys -t {q} -l {}{enter}", tmux::tmux_quote(&text));
        match guarded_with(&b.socket, m, &pane, &cond, &action)? {
            Outcome::Applied(_) if !enter.is_empty() => {}
            Outcome::Refused => return set_window(b, pi, wi, WindowState::Failed, Some("the window is not ours; nothing was typed".into()), None),
            _ => return set_window(b, pi, wi, WindowState::LaunchUnknown, Some("the start command's outcome is unknown; left as is".into()), None),
        }
    }
    rename(b, pi, wi)
}

/// The ownership check every release makes, and the merge of a held window
/// into its slot (board #422 round 3, H2 review P1-D), as ONE guarded step:
/// in the server, the window must still be the hold's own object — the
/// instance, the NATIVE SESSION it was bound in, the window, the pane and its
/// process — carry either its placeholder or the slot's name, and be
/// AUTHORIZED as this hold's: either the restore made it (the window's
/// `@tmm_rw`, the session's `@tmm_rs` and `TMM_RESTORE_BATCH` all name this
/// batch) or the launch door that installed this generation made it (the
/// window's `@tmm_rl` names this launch, `before_launch`). A missing or
/// empty tag is NOT ownership (H2 review P1-D residual). Then it is given
/// the slot's name (a no-op when it has it). `Some(true)` Applied,
/// `Some(false)` Refused, `None` its answer was not seen.
pub(crate) fn merge_held(h: &super::store::Hold) -> Option<bool> {
    let p = h.pane.as_ref()?;
    let either = |a: String, b: String| format!("#{{||:{a},{b}}}");
    let restored = all(vec![eq("@tmm_rw", &format!("{}:{}", h.batch, h.ord)), eq("@tmm_rs", &h.batch), eq("TMM_RESTORE_BATCH", &h.batch)]);
    let mut parts = instance_parts(&p.instance);
    parts.extend([
        eq("session_id", &p.session_id),
        eq("window_id", &p.window_id),
        eq("pane_id", &p.pane_id),
        eq("pane_pid", &p.pane_pid.to_string()),
        either(eq("window_name", &placeholder(&h.batch, h.ord)), eq("window_name", &h.slot)),
        either(restored, eq("@tmm_rl", &h.launch)),
    ]);
    let step = Step { op: "merge", project: h.project_id.clone(), ord: Some(h.ord) };
    let action = format!("rename-window -t {} {}", tmux::tmux_quote(&p.window_id), tmux::tmux_quote(&h.slot));
    match guarded(&h.socket, &step, &p.pane_id, &all(parts), &action) {
        Ok(Outcome::Applied(_)) => Some(true),
        Ok(Outcome::Refused) => Some(false),
        _ => None,
    }
}

fn rename(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    let agent = w.kind == SlotKind::Agent;
    let unsure = if agent { WindowState::LaunchUnknown } else { WindowState::Failed };
    let (Some(wid), Some(cond)) = (w.window_id.clone(), tagged_cond(b, pi, &w, true)) else {
        return set_window(b, pi, wi, unsure, Some("no window identity".into()), None);
    };
    let state_now = if agent { WindowState::LaunchIssued } else { WindowState::Created };
    set_window(b, pi, wi, state_now, None, Some(BatchOp::Rename))?;
    let step = Step { op: "rename", project: b.projects[pi].id.clone(), ord: Some(w.ord) };
    let action = format!("rename-window -t {} {}", tmux::tmux_quote(&wid), tmux::tmux_quote(&w.name));
    match guarded(&b.socket, &step, &wid, &cond, &action)? {
        Outcome::Applied(_) => set_window(b, pi, wi, WindowState::Launched, None, None),
        _ => {
            let (inst, sid) = (b.instance.clone(), b.projects[pi].session_id.clone());
            let seen = match (inst, sid) {
                (Some(i), Some(s)) => observe_windows(&b.socket, &s, &i).ok().flatten(),
                _ => None,
            };
            let tag = format!("{}:{}", b.batch, w.ord);
            match seen.and_then(|v| v.into_iter().find(|s| s.id == wid)) {
                Some(s) if s.tag == tag && s.name == w.name => set_window(b, pi, wi, WindowState::Launched, None, None),
                Some(s) if s.tag == tag && !agent => {
                    // A shell: nothing was typed; the rename is redone once under its guard.
                    match guarded(&b.socket, &step, &wid, &cond, &action)? {
                        Outcome::Applied(_) => set_window(b, pi, wi, WindowState::Launched, None, None),
                        _ => set_window(b, pi, wi, WindowState::Failed, Some(format!("rename indeterminate ({})", s.name)), None),
                    }
                }
                _ => set_window(b, pi, wi, unsure, Some("rename not confirmed; left as is".into()), None),
            }
        }
    }
}

/// Kill a window WE made and never typed into (a door refusal, a reread
/// block). The kill is never issued twice: an Unknown answer is re-observed.
fn kill_owned(b: &mut Batch, pi: usize, wi: usize, why: String) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    let (Some(wid), Some(cond)) = (w.window_id.clone(), tagged_cond(b, pi, &w, false)) else {
        return set_window(b, pi, wi, WindowState::Failed, Some(why), None);
    };
    set_window(b, pi, wi, WindowState::Created, Some(why.clone()), Some(BatchOp::Kill))?;
    let step = Step { op: "kill", project: b.projects[pi].id.clone(), ord: Some(w.ord) };
    match guarded(&b.socket, &step, &wid, &cond, &format!("kill-window -t {}", tmux::tmux_quote(&wid)))? {
        // The window is gone; its PANE may not be (moved out by break-pane
        // or move-pane before the kill): retired only on the same whole-
        // server judgment the barrier makes (review H1 P1-D, Applied half).
        Outcome::Applied(_) => match pane_of(b, pi, wi).and_then(|p| super::restore_hold::pane_ended(&b.socket, &p)) {
            Some(true) => set_window_retiring(b, pi, wi, WindowState::Failed, Some(why)),
            _ => set_window(b, pi, wi, WindowState::Failed, Some(format!("{why}; window killed, its pane not confirmed gone")), None),
        },
        // Refused: our guard did not hold, so the kill did not run and the
        // window may still be there — its hold stays (the prune decides).
        Outcome::Refused => set_window(b, pi, wi, WindowState::Failed, Some(format!("{why}; kill refused, left in place")), None),
        Outcome::Unknown(_) => observe_kill(b, pi, wi),
    }
}

/// A kill whose answer was not seen: gone is done; present is left in place
/// and reported — never killed a second time.
/// Remove a dsh home's readiness files; absent is reset.
fn reset_dsh_readiness(project_path: &str, window: &str) -> Result<(), String> {
    let home = super::agents::home_dir(project_path, window).ok_or("no agent home")?;
    for f in ["ready", "steer-ready"] {
        match std::fs::remove_file(home.join("dsh").join("tmm").join(f)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{f}: {e}")),
        }
    }
    Ok(())
}

/// The native identity of a window this batch made, as its hold records it.
fn pane_of(b: &Batch, pi: usize, wi: usize) -> Option<super::store::HoldPane> {
    let w = &b.projects[pi].windows[wi];
    Some(super::store::HoldPane {
        instance: b.instance.clone()?,
        session_id: b.projects[pi].session_id.clone()?,
        window_id: w.window_id.clone()?,
        pane_id: w.pane_id.clone()?,
        pane_pid: w.pane_pid?,
    })
}

fn observe_kill(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let why = b.projects[pi].windows[wi].reason.clone().unwrap_or_default();
    let Some(pane) = pane_of(b, pi, wi) else {
        return set_window(b, pi, wi, WindowState::Failed, Some(why), None);
    };
    // Decided by the window's PANE on the whole server (review H1 P1-D
    // residual): a window moved to another session is not gone.
    match super::restore_hold::pane_ended(&b.socket, &pane) {
        Some(true) => set_window_retiring(b, pi, wi, WindowState::Failed, Some(why)),
        // Present: left in place, reported, final — never killed a second time.
        Some(false) => set_window(b, pi, wi, WindowState::Failed, Some(format!("{why}; kill indeterminate, left in place")), Some(BatchOp::Kill)),
        // Not readable: the step stays issued, to be re-observed next pass.
        None => set_window(b, pi, wi, WindowState::Created, Some(why), Some(BatchOp::Kill)),
    }
}

/// Every window is final (or left in place): the holder's fate is decided BY
/// THE SERVER that acts — it is killed only while `#{session_windows} > 1`
/// in the same `if-shell`; otherwise it is renamed to a plain shell and the
/// project is reported NOT restored. Never zero windows (review P1-C). Each
/// holder step is written ahead (`HolderKill` / `HolderRename`) and a
/// successor consumes it by re-observation: a holder kill is never issued
/// twice, and an unconfirmed step is never reported as cleaned up.
fn finish_project(b: &mut Batch, pi: usize) -> Result<(), String> {
    let p = b.projects[pi].clone();
    let open = p.windows.iter().any(|w| matches!(w.state, WindowState::Pending | WindowState::Creating | WindowState::Created | WindowState::LaunchIssued));
    if open {
        return Ok(());
    }
    let (Some(inst), Some(sid), Some(hid)) = (b.instance.clone(), p.session_id.clone(), p.holder_id.clone()) else {
        return finalize(b, pi, None);
    };
    let step_kill = Step { op: "holder_kill", project: p.id.clone(), ord: None };
    let step_rename = Step { op: "holder_rename", project: p.id.clone(), ord: None };
    let batch_id = b.batch.clone();
    let base = || {
        let mut parts = instance_parts(&inst);
        parts.extend([
            eq("session_id", &sid),
            eq("window_id", &hid),
            eq("window_name", &holder_name(&batch_id)),
            eq("TMM_RESTORE_BATCH", &batch_id),
            eq("@tmm_rs", &batch_id),
        ]);
        parts
    };
    let shell = std::env::var("SHELL").ok().and_then(|s| s.rsplit('/').next().map(str::to_string)).filter(|s| !s.is_empty()).unwrap_or_else(|| "zsh".into());
    let rename_action = format!("rename-window -t {} {}", tmux::tmux_quote(&hid), tmux::tmux_quote(&shell));
    match p.op {
        // A successor finding an issued holder kill: never a second kill.
        Some(BatchOp::HolderKill) => {
            return match holder_seen(b, &sid, &inst, &hid) {
                Ok(HolderSeen::Gone) => finalize(b, pi, None),
                Ok(HolderSeen::Ours(_)) => finalize(b, pi, Some("holder kill unconfirmed; left in place".into())),
                Ok(HolderSeen::Foreign) => finalize(b, pi, Some("the holder is no longer ours; left as is".into())),
                Err(e) => set_project(b, pi, ProjectState::Open, Some(format!("holder indeterminate: {e}")), Some(BatchOp::HolderKill)),
            };
        }
        // An issued rename is idempotent: redone under its guard once seen ours.
        Some(BatchOp::HolderRename) => return holder_rename(b, pi, &step_rename, &hid, &all(base()), &rename_action, &sid, &inst),
        _ => {}
    }
    set_project(b, pi, ProjectState::Open, None, Some(BatchOp::HolderKill))?;
    let mut kill_parts = base();
    kill_parts.push("#{>:#{session_windows},1}".to_string());
    match guarded(&b.socket, &step_kill, &hid, &all(kill_parts), &format!("kill-window -t {}", tmux::tmux_quote(&hid)))? {
        Outcome::Applied(_) => finalize(b, pi, None),
        Outcome::Refused => match holder_seen(b, &sid, &inst, &hid) {
            // The holder is the session's last window: it becomes one plain shell.
            Ok(HolderSeen::Ours(1)) => {
                set_project(b, pi, ProjectState::Open, None, Some(BatchOp::HolderRename))?;
                holder_rename(b, pi, &step_rename, &hid, &all(base()), &rename_action, &sid, &inst)
            }
            Ok(HolderSeen::Gone) => finalize(b, pi, None),
            // Ours with other windows but refused: the guard saw otherwise;
            // nothing was done and nothing is retried blind.
            Ok(HolderSeen::Ours(_)) => finalize(b, pi, Some("holder kill refused; left in place".into())),
            Ok(HolderSeen::Foreign) => finalize(b, pi, Some("the holder is no longer ours; left as is".into())),
            Err(e) => set_project(b, pi, ProjectState::Open, Some(format!("holder indeterminate: {e}")), Some(BatchOp::HolderKill)),
        },
        Outcome::Unknown(e) => match holder_seen(b, &sid, &inst, &hid) {
            Ok(HolderSeen::Gone) => finalize(b, pi, None),
            Ok(HolderSeen::Ours(_)) => finalize(b, pi, Some(format!("holder kill unconfirmed ({e}); left in place"))),
            Ok(HolderSeen::Foreign) => finalize(b, pi, Some("the holder is no longer ours; left as is".into())),
            Err(e) => set_project(b, pi, ProjectState::Open, Some(format!("holder indeterminate: {e}")), Some(BatchOp::HolderKill)),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HolderSeen {
    Gone,
    /// Present and ours (its id, its birth name, and the session's env and
    /// tag carry the full uuid); the session's window count.
    Ours(usize),
    /// Present under that id but no longer provably ours.
    Foreign,
}

/// The holder by its native id, judged by every native fact — not only its
/// id and name (review P2). `Err` = could not be read.
fn holder_seen(b: &Batch, sid: &str, inst: &TmuxInstance, hid: &str) -> Result<HolderSeen, String> {
    let fmt = format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{window_id}}{SEP}#{{window_name}}{SEP}#{{@tmm_rs}}{SEP}#{{TMM_RESTORE_BATCH}}");
    let out = match tmux::run_tmux_on(Some(&b.socket), &["list-windows", "-t", sid, "-F", &fmt]) {
        Ok(out) => out,
        Err(e) if tmux::session_confirmed_absent(&e) => return Ok(HolderSeen::Gone),
        Err(e) => return Err(e),
    };
    let lines: Vec<Vec<&str>> = out.lines().filter(|l| !l.is_empty()).map(|l| l.split(SEP).collect()).collect();
    if lines.iter().any(|f| f.len() != 6 || f[0] != inst.pid.to_string() || f[1] != inst.start_time.to_string()) {
        return Err("another tmux server answered, or an unreadable listing".into());
    }
    Ok(match lines.iter().find(|f| f[2] == hid) {
        None => HolderSeen::Gone,
        Some(f) if f[3] == holder_name(&b.batch) && f[4] == b.batch && f[5] == b.batch => HolderSeen::Ours(lines.len()),
        Some(_) => HolderSeen::Foreign,
    })
}

#[allow(clippy::too_many_arguments)]
fn holder_rename(b: &mut Batch, pi: usize, step: &Step, hid: &str, cond: &str, action: &str, sid: &str, inst: &TmuxInstance) -> Result<(), String> {
    match guarded(&b.socket, step, hid, cond, action)? {
        Outcome::Applied(_) => finalize(b, pi, Some("no window could be restored; one shell left".into())),
        _ => match holder_seen(b, sid, inst, hid) {
            Ok(HolderSeen::Gone) => finalize(b, pi, Some("no window could be restored".into())),
            Ok(HolderSeen::Foreign) => finalize(b, pi, Some("no window could be restored; the holder is no longer ours".into())),
            Ok(HolderSeen::Ours(_)) => set_project(b, pi, ProjectState::Open, Some("holder rename unconfirmed".into()), Some(BatchOp::HolderRename)),
            Err(e) => set_project(b, pi, ProjectState::Open, Some(format!("holder indeterminate: {e}")), Some(BatchOp::HolderRename)),
        },
    }
}

/// The project's result from its windows: Done when one was restored,
/// otherwise Failed; `note` is what the holder step left to say.
/// The project finished: its outcome is settled from its windows by the
/// store's one rule (`store::settle`), which a later release applies again.
fn finalize(b: &mut Batch, pi: usize, note: Option<String>) -> Result<(), String> {
    let p = &mut b.projects[pi];
    p.finished = Some(super::store::Finished { note });
    p.op = None;
    super::store::settle(p);
    save_reporting(b, pi, EVENT_FINISHED, "")
}

// ---- the project's room line (round 4) -----------------------------------

/// The report events of a project in one attempt of a batch.
pub const EVENT_FINISHED: &str = "finished";
pub const EVENT_GAVE_UP: &str = "gave_up";

/// The project's room, as every other line of it names it.
fn project_room(p: &BatchProject) -> String {
    with_store(|s| s.project(&p.id))
        .ok()
        .flatten()
        .map(|r| if r.room.is_empty() { format!("proj:{}", r.session) } else { r.room })
        .unwrap_or_else(|| format!("proj:{}", p.session))
}

/// A report's identity (revision 1, P1-B): one line per project per
/// attempt per event. A pass within the same attempt is the same event and
/// records nothing new; a person's retry is a new attempt and its own line.
pub fn report_id(b: &Batch, p: &BatchProject, event: &str) -> String {
    format!("restore:{}:{}:{}:{event}", b.batch, b.attempt, p.id)
}

/// The project's report as it stands NOW — the execution summary at this
/// moment, claiming nothing it has not seen: a window counts as created when
/// the restore confirmed it (`Launched`); an agent among them as relaunched
/// with its saved conversation, and as ready only once its hold was released
/// on evidence. A launch written ahead but not confirmed (LaunchIssued,
/// LaunchUnknown) is "launch result unconfirmed", never relaunched; `typed`
/// proves nothing about a start either.
pub fn report_body(b: &Batch, p: &BatchProject, event: &str, why: &str) -> String {
    let manual = b.attempt > 0;
    if event == EVENT_GAVE_UP {
        let what = if manual { "the restore run by `tmm project restore`" } else { "the restore after a host reboot" };
        return format!("[tmm] {what} did not finish ({why}); start what is missing with `tmm project up {}`", p.session);
    }
    let done = if manual { format!("restored by `tmm project restore` (attempt {})", b.attempt) } else { "restored after a host reboot".to_string() };
    if p.state == ProjectState::Skipped {
        return format!("[tmm] not {done}: {}", p.reason.as_deref().unwrap_or("skipped"));
    }
    let names = |f: &dyn Fn(&BatchWindow) -> bool| p.windows.iter().filter(|w| f(w)).map(|w| w.name.clone()).collect::<Vec<_>>();
    let created = names(&|w| w.state == WindowState::Launched);
    let agents = p.windows.iter().filter(|w| w.state == WindowState::Launched && w.kind == SlotKind::Agent).count();
    let ready = p.windows.iter().filter(|w| w.state == WindowState::Launched && w.kind == SlotKind::Agent && w.released).count();
    let unconfirmed = names(&|w| matches!(w.state, WindowState::LaunchIssued | WindowState::LaunchUnknown));
    let unfinished = names(&|w| matches!(w.state, WindowState::Pending | WindowState::Creating | WindowState::Created));
    let plural = |n: usize, one: &str, many: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {many}") };
    let mut parts = vec![{
        let mut s = plural(created.len(), "window created", "windows created");
        if agents > 0 {
            let r = plural(agents, "agent relaunched with its saved conversation", "agents relaunched with their saved conversation");
            s.push_str(&format!(" ({r}, {ready} confirmed ready)"));
        }
        s
    }];
    if !unconfirmed.is_empty() {
        parts.push(format!("{} launch result unconfirmed ({})", unconfirmed.len(), unconfirmed.join(", ")));
    }
    let mut skipped: Vec<(String, Vec<String>)> = Vec::new();
    for w in p.windows.iter().filter(|w| w.state == WindowState::Skipped) {
        let r = w.reason.clone().unwrap_or_else(|| "skipped".into());
        match skipped.iter_mut().find(|(k, _)| *k == r) {
            Some((_, v)) => v.push(w.name.clone()),
            None => skipped.push((r, vec![w.name.clone()])),
        }
    }
    if !skipped.is_empty() {
        let n: usize = skipped.iter().map(|(_, v)| v.len()).sum();
        let detail = skipped.iter().map(|(r, v)| format!("{r}: {}", v.join(", "))).collect::<Vec<_>>().join("; ");
        parts.push(format!("{n} skipped ({detail})"));
    }
    let failed: Vec<String> = p.windows.iter().filter(|w| w.state == WindowState::Failed).map(|w| format!("{}: {}", w.name, w.reason.as_deref().unwrap_or("failed"))).collect();
    if !failed.is_empty() {
        parts.push(format!("{} failed ({})", failed.len(), failed.join("; ")));
    }
    if !unfinished.is_empty() {
        parts.push(format!("{} not finished ({})", unfinished.len(), unfinished.join(", ")));
    }
    if p.autostart_only {
        parts.push("shells only; agents not started".into());
    }
    format!("[tmm] {done}: {}", parts.join(", "))
}

/// The save that makes project `pi` terminal, with its report in the SAME
/// transaction, built from the batch as stored (a release meanwhile
/// merged); the row is pushed only after the commit, and only by the call
/// that inserted it.
fn save_reporting(b: &mut Batch, pi: usize, event: &str, why: &str) -> Result<(), String> {
    let (room, pid) = (project_room(&b.projects[pi]), b.projects[pi].id.clone());
    let pushed = with_store(|s| s.save_batch_reporting(b, |m| report_lines(m, &[(pid, room)], event, why)))?;
    super::rooms::push_stored(&pushed);
    Ok(())
}

/// The report lines of `projects` (id, room) of the batch `m` for `event`.
fn report_lines(m: &Batch, projects: &[(String, String)], event: &str, why: &str) -> Vec<super::store::OnceLine> {
    projects
        .iter()
        .filter_map(|(id, room)| m.projects.iter().find(|p| &p.id == id).map(|p| (p, room)))
        .map(|(p, room)| super::store::OnceLine { room: room.clone(), id: report_id(m, p, event), sender: "tmm".into(), body: report_body(m, p, event, why) })
        .collect()
}

/// The windows of `project`'s session that belong to `b` and were NOT
/// restored (a `launch_unknown` start, a kill left in place, the holder):
/// owned by the native facts — the session's env and tag carry the batch's
/// full uuid, the window's `@tmm_rw` names this batch and the window's ord,
/// its native id is the one the batch recorded, on the batch's server — and
/// never by a name prefix (review P1-A). A plain window called `tmm-r-…` is
/// nobody's placeholder. Each is named by `(window index, name)` from the
/// same listing that proved it ours, so the exclusion follows THAT window
/// through the observation, not every window sharing its name (review P2).
/// `Err` = could not be read.
pub fn unrestored_windows(b: &Batch, project_id: &str) -> Result<std::collections::HashSet<(usize, String)>, String> {
    let mut out = std::collections::HashSet::new();
    let (Some(inst), Some(p)) = (b.instance.as_ref(), b.projects.iter().find(|p| p.id == project_id)) else { return Ok(out) };
    let Some(sid) = p.session_id.as_deref() else { return Ok(out) };
    let sep = "<TMM_SEP>";
    let fmt = format!("#{{pid}}{sep}#{{start_time}}{sep}#{{window_index}}{sep}#{{window_id}}{sep}#{{window_name}}{sep}#{{@tmm_rw}}{sep}#{{@tmm_rs}}{sep}#{{TMM_RESTORE_BATCH}}");
    let listing = match tmux::run_tmux_on(Some(&b.socket), &["list-windows", "-t", sid, "-F", &fmt]) {
        Ok(l) => l,
        Err(e) if tmux::session_confirmed_absent(&e) => return Ok(out),
        Err(e) => return Err(e),
    };
    for line in listing.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split(sep).collect();
        let [pid, start, index, wid, name, rw, rs, env] = f[..] else { return Err(format!("unreadable list-windows line: {line}")) };
        let Ok(index) = index.parse::<usize>() else { return Err(format!("unreadable list-windows line: {line}")) };
        if pid != inst.pid.to_string() || start != inst.start_time.to_string() {
            // Another server holds a session of that id: none of it is ours.
            return Ok(std::collections::HashSet::new());
        }
        if rs != b.batch || env != b.batch {
            continue;
        }
        let holder = p.holder_id.as_deref() == Some(wid) && name == holder_name(&b.batch);
        let unrestored = p.windows.iter().any(|w| {
            w.window_id.as_deref() == Some(wid) && rw == format!("{}:{}", b.batch, w.ord) && w.state != WindowState::Launched
        });
        if holder || unrestored {
            out.insert((index, name.to_string()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    //! Every test runs on a real private tmux server (by `-S`), with fake
    //! CLIs that count their own starts, an injected boot id, and the step
    //! hook as the barrier. Each pins one row of the design's tables.
    use super::super::store::{Checkpoint, CheckpointProject, CheckpointWindow, Project, Slot, SlotKind};
    use super::super::tests::use_test_store;
    use super::*;
    use crate::tmux::test_support::{GlobalSocket, PrivateTmux};
    use std::path::{Path, PathBuf};

    /// A workspace with managed fake agents (claude recipes running a
    /// counting script) and a declared project.
    struct Proj {
        id: String,
        session: String,
        ws: PathBuf,
    }

    fn fake_agent(ws: &Path, name: &str) {
        let home = ws.join(".tmm/agents").join(name);
        std::fs::create_dir_all(&home).unwrap();
        let script = home.join("fake.sh");
        std::fs::write(&script, "n=$(cat \"$0.count\" 2>/dev/null || echo 0); echo $((n+1)) > \"$0.count\"; echo \"$$ $*\" >> \"$0.log\"; exec sleep 600\n").unwrap();
        let recipe = serde_json::json!({ "backend": "claude", "cmd": format!("sh {}", script.display()), "env": [] });
        std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
    }

    fn starts(p: &Proj, name: &str) -> u32 {
        std::fs::read_to_string(p.ws.join(".tmm/agents").join(name).join("fake.sh.count")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }

    /// The fake CLI's OWN start, as an observed edge: its counter reaching
    /// `n`, bounded generously (a loaded host can take seconds to exec a
    /// script after a correct launch — validator, 2026-10-19).
    fn wait_starts(p: &Proj, name: &str, n: u32) -> u32 {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while starts(p, name) < n && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        starts(p, name)
    }

    fn agent_slot(name: &str) -> Slot {
        Slot {
            id: None,
            ord: 0,
            window_name: name.into(),
            cwd: String::new(),
            kind: SlotKind::Agent,
            command: Some("claude".into()),
            auto_run: true,
            agent_session_id: Some(format!("conv-{name}")),
            first_seen_at: 1,
            settled_at: Some(2),
        }
    }

    fn shell_slot(name: &str) -> Slot {
        Slot { kind: SlotKind::Shell, command: None, auto_run: false, agent_session_id: None, ..agent_slot(name) }
    }

    /// Declare a project with these slots (agents get fake homes) and return it.
    fn declare(tag: &str, slots: Vec<Slot>) -> Proj {
        let ws = std::env::temp_dir().join(format!("tmm-r2-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&ws).unwrap();
        let ws = ws.canonicalize().unwrap();
        for s in slots.iter().filter(|s| s.kind == SlotKind::Agent) {
            fake_agent(&ws, &s.window_name);
        }
        let id = format!("{tag}-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]);
        let session = id.clone();
        let project = Project {
            id: id.clone(),
            name: id.clone(),
            path: ws.to_string_lossy().to_string(),
            icon: None,
            session: session.clone(),
            adopted: false,
            autostart: false,
            created_at: 1,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),
        };
        with_store(|s| s.insert_project(&project)).unwrap();
        with_store(|s| s.replace_slots(&id, &slots)).unwrap();
        Proj { id, session, ws }
    }

    /// The checkpoint a pre-reboot tick would have published for these
    /// projects: every declared slot live, as declared.
    /// The private test server runs /bin/sh for every window the restore
    /// makes: a loaded test must not wait on the user's zsh rc. An anchor
    /// session starts the server (another instance than the checkpoint's,
    /// which the trigger requires anyway); the late-prompt test overrides
    /// the shell to prove the product's own wait.
    fn fast_shell(socket: &str) {
        let _ = tmux::run_tmux_on(Some(socket), &["new-session", "-d", "-s", "zz-anchor", "/bin/sh"]);
        tmux::run_tmux_on(Some(socket), &["set-option", "-g", "default-shell", "/bin/sh"]).unwrap();
    }

    fn publish(socket: &str, projects: &[&Proj]) {
        fast_shell(socket);
        *super::super::restore::TICK_BOOT.lock().unwrap() = Some("boot-after".into());
        // This boot is decided, as a gateway start's prepare would have it,
        // so the test's own capture ticks commit; a test of the undecided
        // window clears it (`undecide`).
        with_store(|s| s.set_restore_decided(socket, "boot-after")).unwrap();
        let mut cps = Vec::new();
        for p in projects {
            let slots = with_store(|s| s.slots(&p.id)).unwrap();
            let windows = slots
                .iter()
                .map(|s| CheckpointWindow {
                    name: s.window_name.clone(),
                    kind: s.kind,
                    managed: s.kind == SlotKind::Agent,
                    backend: s.command.clone().filter(|_| s.kind == SlotKind::Agent),
                    agent_session_id: s.agent_session_id.clone(),
                })
                .collect();
            cps.push(CheckpointProject { id: p.id.clone(), session: p.session.clone(), windows });
        }
        let cp = Checkpoint {
            gen: 0,
            at: 1,
            boot_id: Some("boot-before".into()),
            tmux: Some(TmuxInstance { socket: socket.into(), pid: 1, start_time: 1 }),
            projects: cps,
        };
        with_store(|s| s.commit_tick(&[], Some((socket, cp)))).unwrap();
    }

    /// The restore inputs of a test, and the boot its capture ticks name.
    fn inputs(socket: &str) -> RunInputs {
        *super::super::restore::TICK_BOOT.lock().unwrap() = Some("boot-after".into());
        RunInputs { socket: socket.into(), enabled: true, boot_now: Some("boot-after".into()), include_autostart: false }
    }

    fn set_hook(h: Option<StepHook>) {
        *STEP_HOOK.lock().unwrap() = h;
    }

    /// Mangle the FIRST step matching `op` (and `ord`, when given) of `project`.
    fn once(project: &str, op: &'static str, ord: Option<usize>, m: Mangle) -> StepHook {
        let project = project.to_string();
        let mut done = false;
        Box::new(move |s: &Step| {
            if !done && s.op == op && s.project == project && (ord.is_none() || s.ord == ord) {
                done = true;
                return m;
            }
            Mangle::Run
        })
    }

    /// `(window name, pane pid)` of a session, by the server's own listing.
    fn windows(server: &PrivateTmux, session: &str) -> Vec<(String, String)> {
        let out = server.run(&["list-windows", "-t", &format!("={session}:"), "-F", "#{window_name}\t#{pane_pid}"]).unwrap_or_default();
        let mut v: Vec<(String, String)> = out.lines().filter_map(|l| l.split_once('\t')).map(|(a, b)| (a.to_string(), b.to_string())).collect();
        v.sort();
        v
    }

    fn names(server: &PrivateTmux, session: &str) -> Vec<String> {
        windows(server, session).into_iter().map(|(n, _)| n).collect()
    }

    fn batch_of(socket: &str) -> Batch {
        with_store(|s| s.restore_batch(socket)).unwrap().or_else(|| with_store(|s| s.last_batch(socket)).unwrap()).expect("a batch")
    }

    fn window_state(socket: &str, project: &str, name: &str) -> (WindowState, Option<String>) {
        let b = batch_of(socket);
        let w = b.projects.iter().find(|p| p.id == project).unwrap().windows.iter().find(|w| w.name == name).unwrap().clone();
        (w.state, w.reason)
    }

    fn project_state(socket: &str, project: &str) -> (ProjectState, Option<String>) {
        let b = batch_of(socket);
        let p = b.projects.iter().find(|p| p.id == project).unwrap();
        (p.state, p.reason.clone())
    }

    fn replace_server(socket: &str) {
        crate::tmux::test_support::destroy_private_server(socket).unwrap();
        let gone = (0..200).any(|_| {
            let absent = tmux::run_tmux_on(Some(socket), &["list-sessions"]).is_err_and(|e| tmux::session_confirmed_absent(&e));
            if !absent {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            absent
        });
        assert!(gone, "the old server exited");
    }

    // ---- the happy path, its controls, and "once per boot" ---------------

    #[test]
    fn a_restore_brings_back_the_live_windows_once_with_their_exact_conversation() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-happy");
        let socket = server.socket().to_string();
        let p = declare("happy", vec![agent_slot("dev"), shell_slot("sh1"), agent_slot("paused")]);
        with_store(|s| s.set_slot_stopped(&p.id, "paused")).unwrap();
        publish(&socket, &[&p]);

        let got = run(&inputs(&socket)).unwrap();
        assert_eq!(got, RunOutcome::Ran { batch: batch_of(&socket).batch, closed: Some("done".into()) });
        assert_eq!(names(&server, &p.session), ["dev", "sh1"], "the holder is gone; the stopped agent stays stopped");
        assert_eq!(wait_starts(&p, "dev", 1), 1);
        let log = std::fs::read_to_string(p.ws.join(".tmm/agents/dev/fake.sh.log")).unwrap();
        assert!(log.contains("--resume conv-dev"), "the exact conversation: {log}");
        assert_eq!(starts(&p, "paused"), 0);
        // Native ownership is on the objects.
        let env = server.run(&["show-environment", "-t", &format!("={}:", p.session), "TMM_RESTORE_BATCH"]).unwrap();
        assert_eq!(env.trim(), format!("TMM_RESTORE_BATCH={}", batch_of(&socket).batch));
        // Control: the same boot is never restored twice.
        let before = windows(&server, &p.session);
        assert_eq!(run(&inputs(&socket)).unwrap(), RunOutcome::Nothing("this boot was already restored".into()));
        assert_eq!(windows(&server, &p.session), before);
        assert_eq!(starts(&p, "dev"), 1);
    }

    // ---- T7 / T18a: a session the person made is theirs -------------------

    #[test]
    fn t7_a_session_the_person_made_is_skipped_untouched() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t7");
        let socket = server.socket().to_string();
        let mine = declare("t7a", vec![shell_slot("sh1")]);
        let theirs = declare("t7b", vec![agent_slot("dev")]);
        server.run(&["new-session", "-d", "-s", &theirs.session, "-n", "dev"]).unwrap();
        let before = windows(&server, &theirs.session);
        publish(&socket, &[&mine, &theirs]);

        run(&inputs(&socket)).unwrap();
        assert_eq!(project_state(&socket, &theirs.id), (ProjectState::Skipped, Some("session exists".into())));
        assert_eq!(windows(&server, &theirs.session), before, "pane pid and windows unchanged");
        assert_eq!(starts(&theirs, "dev"), 0, "nothing typed into the person's window");
        assert_eq!(names(&server, &mine.session), ["sh1"], "control: the other project is restored");
    }

    /// A session carrying ANOTHER batch's env (an older restore's) is not
    /// ours either: the env must name this batch's full uuid.
    #[test]
    fn t7_a_session_of_another_batch_is_not_ours() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t7b");
        let socket = server.socket().to_string();
        let p = declare("t7c", vec![agent_slot("dev")]);
        let env = format!("TMM_RESTORE_BATCH={}", uuid::Uuid::new_v4());
        server.run(&["new-session", "-d", "-s", &p.session, "-e", &env, "-n", "older"]).unwrap();
        let before = windows(&server, &p.session);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        assert_eq!(project_state(&socket, &p.id), (ProjectState::Skipped, Some("session exists".into())));
        assert_eq!(windows(&server, &p.session), before);
    }

    /// A claim recorded as issued whose session does not exist: never a
    /// second `new-session` — the project is failed, indeterminate.
    #[test]
    fn a_claim_issued_but_unseen_with_no_session_is_failed_not_retried() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-claim");
        let socket = server.socket().to_string();
        let p = declare("claim", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "claim", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(project_state(&socket, &p.id).0, ProjectState::CreatingSession);
        run(&inputs(&socket)).unwrap();
        assert_eq!(project_state(&socket, &p.id), (ProjectState::Failed, Some("indeterminate: new-session".into())));
        assert!(names(&server, &p.session).is_empty(), "no second new-session");
    }

    /// The production guards carry the batch's server identity: the same
    /// session and tags, judged against a WRONG recorded instance, refuse.
    #[test]
    fn the_guards_carry_the_batch_instance() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-inst");
        let socket = server.socket().to_string();
        let p = declare("inst", vec![shell_slot("sh1")]);
        server.run(&["new-session", "-d", "-s", "anchor"]).unwrap();
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let mut b = batch_of(&socket);
        let pi = b.projects.iter().position(|q| q.id == p.id).unwrap();
        let step = Step { op: "test", project: p.id.clone(), ord: None };
        let (sid, cond) = session_cond(&b, pi).unwrap();
        assert!(matches!(guarded(&socket, &step, &sid, &cond, "display -p x").unwrap(), Outcome::Applied(_)), "control: the true instance");
        let real = b.instance.clone().unwrap();
        for wrong in [TmuxInstance { pid: real.pid + 1, ..real.clone() }, TmuxInstance { start_time: real.start_time + 1, ..real.clone() }] {
            b.instance = Some(wrong);
            let (sid, cond) = session_cond(&b, pi).unwrap();
            assert_eq!(guarded(&socket, &step, &sid, &cond, "display -p x").unwrap(), Outcome::Refused);
        }
    }

    // ---- round 3: holds through the executor ----------------------------

    fn holds(socket: &str, p: &Proj) -> Vec<super::super::store::Hold> {
        with_store(|s| s.project_holds(socket, &p.id)).unwrap()
    }

    /// A prepare that opens a batch writes, in the same transaction, a
    /// PLANNED hold for every agent slot (none for a shell) and this boot's
    /// decision. The window create binds it to the exact native window; the
    /// door arms it BEFORE the launch is typed.
    #[test]
    fn holds_are_planned_with_the_batch_bound_at_create_and_armed_before_typing() {
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-hold");
        let socket = server.socket().to_string();
        let p = declare("r3hold", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        with_store(|s| s.set_restore_decided(&socket, "older")).unwrap();
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"), "decided with the batch");
        let planned = holds(&socket, &p);
        assert_eq!(planned.len(), 1, "one hold, for the agent slot only: {planned:?}");
        assert_eq!((planned[0].slot.as_str(), planned[0].stage, planned[0].pane.is_none()), ("dev", HoldStage::Planned, true));
        let launch = batch.projects[0].windows.iter().find(|w| w.name == "dev").unwrap().launch.clone();
        assert_eq!(launch.as_deref(), Some(planned[0].launch.as_str()), "the batch window carries its hold's generation");
        // At the door, the hold is already armed and bound to the window made.
        let (sock, pid) = (socket.clone(), p.id.clone());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let at_door = seen.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "launch" && s.ord == Some(0) {
                let h = with_store(|st| st.project_holds(&sock, &pid)).unwrap();
                let b = with_store(|st| st.restore_batch(&sock)).unwrap().unwrap();
                *at_door.lock().unwrap() = Some((h, b));
            }
            Mangle::Run
        })));
        continue_batch(lease, batch).unwrap();
        set_hook(None);
        let (h, b) = seen.lock().unwrap().clone().expect("the launch step ran");
        let w = b.projects[0].windows.iter().find(|w| w.name == "dev").unwrap();
        assert_eq!(w.state, WindowState::LaunchIssued);
        assert_eq!(h[0].stage, HoldStage::Armed, "armed before the typing");
        let pane = h[0].pane.clone().expect("bound");
        assert_eq!(Some(pane.pane_id.clone()), w.pane_id);
        assert_eq!(Some(pane.window_id.clone()), w.window_id);
        assert_eq!(Some(pane.session_id.clone()), b.projects[0].session_id);
        assert_eq!(Some(pane.instance.clone()), b.instance);
        assert_eq!(Some(pane.pane_pid), w.pane_pid);
        assert_eq!(starts(&p, "dev"), 1);
        assert_eq!(holds(&socket, &p)[0].stage, HoldStage::Armed, "a launched window keeps its hold");
    }

    /// A slot that ends before anything is typed (here a Stop at the door)
    /// retires its hold with the window's record. A halt right after the
    /// write-ahead `LaunchIssued` leaves the hold armed: the typing may have
    /// happened.
    #[test]
    fn a_slot_ended_untyped_retires_its_hold_and_a_halt_after_the_write_ahead_keeps_it() {
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-retire");
        let socket = server.socket().to_string();
        let p = declare("r3retire", vec![agent_slot("dev"), agent_slot("dev2")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "tag_window" && s.ord == Some(0) {
                fired = true;
                with_store(|st| st.set_slot_stopped(&pid, "dev")).unwrap();
            }
            if s.op == "launch" && s.ord == Some(1) {
                return Mangle::HaltBefore;
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Failed);
        assert_eq!(window_state(&socket, &p.id, "dev2").0, WindowState::LaunchIssued);
        let left = holds(&socket, &p);
        assert_eq!(left.len(), 1, "{left:?}");
        assert_eq!((left[0].slot.as_str(), left[0].stage), ("dev2", HoldStage::Armed));
    }

    // ---- round 3: the decision gate at the capture tick -----------------

    /// A1 / A7: a capture of this boot's server, before any prepare decided
    /// for this boot, moves neither the old boot's evidence nor the slots a
    /// plan compares it with (an extra window is not added, a vanished shell
    /// not dropped). A second connection — another gateway — that opens a
    /// batch while the tick scans voids it too. Once decided, a tick commits.
    #[test]
    fn a_capture_before_the_decision_moves_neither_the_evidence_nor_the_slots() {
        use super::super::capture::{TickPhase, TICK_HOOK};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-gate");
        let socket = server.socket().to_string();
        let p = declare("r3gate", vec![shell_slot("sh1"), shell_slot("sh2")]);
        publish(&socket, &[&p]);
        with_store(|s| s.set_restore_decided(&socket, "older")).unwrap();
        let cwd = p.ws.to_string_lossy().to_string();
        server.run(&["new-session", "-d", "-s", &p.session, "-c", &cwd, "-n", "sh1"]).unwrap();
        tmux::new_named_window(&p.session, "extra", &cwd).unwrap();
        let slots = || with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        let evidence = || with_store(|s| s.checkpoint(&socket)).unwrap();
        let (was, cp) = (slots(), evidence());
        super::super::capture_once().unwrap();
        assert_eq!(slots(), was, "no fold before the decision");
        assert_eq!(evidence(), cp, "no checkpoint before the decision");
        let plan_has_sh2 = || {
            let intents = with_store(|s| s.restore_intents()).unwrap();
            let plan = restore::plan(cp.as_ref().unwrap(), &declared().unwrap(), &intents, false, &restore::LiveFacts);
            plan.projects.iter().any(|q| q.windows.iter().any(|w| w.name == "sh2"))
        };
        assert!(plan_has_sh2(), "the plan still has every window");
        // Another gateway's prepare lands while this tick scans: decision and
        // batch through a SECOND connection.
        let db = super::super::db_path();
        let mut other_batch = with_store(|s| s.restore_batch(&socket)).unwrap();
        assert!(other_batch.is_none());
        let fake = Batch {
            batch: uuid::Uuid::new_v4().to_string(),
            socket: socket.clone(),
            boot_id: Some("boot-after".into()),
            owner_pid: 0, attempt: 0,
            instance: None,
            source: cp.clone().unwrap(),
            closed: None,
            projects: vec![],
        };
        other_batch = Some(fake.clone());
        *TICK_HOOK.lock().unwrap() = Some(Box::new(move |phase| {
            if phase == TickPhase::Listed {
                if let Some(b) = other_batch.take() {
                    let mut s = super::super::store::Store::open(&db).unwrap();
                    s.open_batch(&b, &[], "boot-after").unwrap();
                }
            }
        }));
        super::super::capture_once().unwrap();
        *TICK_HOOK.lock().unwrap() = None;
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"), "the other gateway decided");
        assert_eq!(slots(), was, "a tick that scanned before that decision commits nothing");
        assert_eq!(evidence(), cp);
        assert!(plan_has_sh2());
        // Control: with the batch closed and the boot decided, a tick commits.
        let mut closed = fake;
        closed.closed = Some("done".into());
        with_store(|s| s.close_batch(&mut closed.clone())).unwrap();
        super::super::capture_once().unwrap();
        assert!(slots().contains(&"extra".to_string()), "{:?}", slots());
        assert_ne!(evidence(), cp);
    }

    // ---- round 3: the barrier ---------------------------------------------

    fn screen_of(pane: &str) -> String {
        tmux::capture_pane_plain(pane, Some(0)).unwrap_or_default()
    }

    /// T8 and B1/B2/B5: a window the restore launched is HELD for every
    /// typer — a new delivery, and a held line at the server-start flush —
    /// whatever its pane arrangement or name becomes: split with another
    /// pane active, renamed. Only its original pane ending ends the hold;
    /// the tick's prune then retires it, and the normal rules apply.
    #[test]
    fn a_restored_window_is_held_however_it_is_arranged_until_its_pane_ends() {
        use super::super::restore_hold::{held, prune};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-held");
        let socket = server.socket().to_string();
        let p = declare("r3held", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Launched);
        assert_eq!(wait_starts(&p, "dev", 1), 1);
        let b = batch_of(&socket);
        let w = b.projects[0].windows[0].clone();
        let (pane, wid) = (w.pane_id.clone().unwrap(), w.window_id.clone().unwrap());
        assert!(held(&p.session, "dev"));
        // A new delivery is held, not typed.
        assert!(super::super::delivery::deliver(&p.session, "dev", &pane, "TOKEN-ONE", 0, ""));
        assert_eq!(super::super::telemetry::held_rows(&p.session, "dev").len(), 1);
        // The server-start flush types nothing either.
        super::super::delivery::flush_on_start();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!screen_of(&pane).contains("TOKEN-ONE"), "nothing typed");
        // Split, the new pane active: still held.
        server.run(&["split-window", "-t", &wid, "/bin/sh"]).unwrap();
        assert!(held(&p.session, "dev"), "a split is not the end of the pane");
        // Renamed: held under both names.
        server.run(&["rename-window", "-t", &wid, "devx"]).unwrap();
        assert!(held(&p.session, "devx") && held(&p.session, "dev"));
        assert!(prune().is_empty(), "nothing to retire while the pane lives");
        // The original pane ends: void, and the prune retires it.
        server.run(&["kill-pane", "-t", &pane]).unwrap();
        assert!(!held(&p.session, "devx") && !held(&p.session, "dev"));
        assert_eq!(prune().len(), 1);
        assert!(holds(&socket, &p).is_empty());
    }

    /// B4: another tmux instance on the socket — its `%N` and pids may be
    /// reused — is not the hold's object: void, retired.
    #[test]
    fn a_new_server_on_the_socket_voids_the_hold() {
        use super::super::restore_hold::{held, prune};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-inst");
        let socket = server.socket().to_string();
        let p = declare("r3inst", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        assert!(held(&p.session, "dev"));
        let _ = server.run(&["kill-server"]);
        let mut started = Err(String::new());
        for _ in 0..50 {
            started = server.run(&["new-session", "-d", "-s", &p.session, "-n", "dev", "/bin/sh"]).map(|_| ());
            if started.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        started.expect("a new server on the same socket");
        // Reuse the hold's own `%N` on the new server: the instance, not the
        // pane id, is what says it is another object.
        let pane = holds(&socket, &p)[0].pane.clone().unwrap().pane_id;
        for _ in 0..20 {
            let panes = server.run(&["list-panes", "-a", "-F", "#{pane_id}"]).unwrap();
            if panes.lines().any(|l| l == pane) {
                break;
            }
            server.run(&["new-window", "-d", "-t", &p.session, "/bin/sh"]).unwrap();
        }
        assert!(server.run(&["list-panes", "-a", "-F", "#{pane_id}"]).unwrap().lines().any(|l| l == pane), "the pane id is reused");
        assert!(!held(&p.session, "dev"), "another instance");
        assert_eq!(prune().len(), 1);
    }

    /// B6: an answer that cannot be read is no proof the pane ended: held,
    /// and the prune retires nothing. Here the socket refuses the connection
    /// (its mode taken away), an error that is not "no server".
    #[test]
    fn an_unreadable_answer_holds_and_retires_nothing() {
        use super::super::restore_hold::{held, prune};
        use std::os::unix::fs::PermissionsExt;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-unk");
        let socket = server.socket().to_string();
        let p = declare("r3unk", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        assert!(held(&p.session, "dev"));
        let mode = std::fs::metadata(&socket).unwrap().permissions().mode();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = tmux::run_tmux_on(Some(&socket), &["list-panes", "-a"]);
        let (still, retired) = (held(&p.session, "dev"), prune());
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(unreadable.as_ref().is_err_and(|e| !tmux::session_confirmed_absent(e)), "the fixture makes an unreadable answer: {unreadable:?}");
        assert!(still, "an unreadable answer holds");
        assert!(retired.is_empty(), "and retires nothing");
        assert_eq!(holds(&socket, &p).len(), 1);
    }

    /// A planned hold whose batch is no longer open was never bound (nothing
    /// was made for it): the prune retires it. While its batch is open it
    /// holds its slot's name.
    #[test]
    fn a_planned_hold_holds_its_slot_while_its_batch_is_open() {
        use super::super::restore_hold::{held, prune};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-plan");
        let socket = server.socket().to_string();
        let p = declare("r3plan", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        drop(lease);
        assert!(held(&p.session, "dev"));
        assert!(!held(&p.session, "other"), "only its slot");
        assert!(prune().is_empty(), "its batch is open");
        let mut c = batch;
        c.closed = Some("failed: test".into());
        with_store(|s| s.close_batch(&mut c.clone())).unwrap();
        assert_eq!(prune().len(), 1);
        assert!(!held(&p.session, "dev"));
    }

    // ---- round 3: the start and the continuation schedule ---------------

    fn pass_unit(ms: u64) {
        PASS_SECOND_MS.store(ms, std::sync::atomic::Ordering::SeqCst);
    }

    fn slow_shell(p: &Proj, socket: &str, secs: u32) -> StepHook {
        let slow = p.ws.join("slow-shell.sh");
        std::fs::write(&slow, format!("#!/bin/sh\nsleep {secs}\nexec /bin/sh -i\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (sock, slow_s) = (socket.to_string(), slow.to_string_lossy().to_string());
        let mut fired = false;
        Box::new(move |s: &Step| {
            if !fired && s.op == "create_window" {
                fired = true;
                tmux::run_tmux_on(Some(&sock), &["set-option", "-g", "default-shell", &slow_s]).unwrap();
            }
            Mangle::Run
        })
    }

    /// A2: a pass that leaves the batch open (a shell not ready) is followed
    /// by the next scheduled pass, which launches once the prompt is there;
    /// nothing is typed ahead and nothing twice.
    #[test]
    fn an_open_batch_is_continued_on_the_schedule_until_its_shell_is_ready() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-sched");
        let socket = server.socket().to_string();
        let p = declare("r3sched", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(slow_shell(&p, &socket, 3)));
        PROMPT_WAIT_MS.store(1000, std::sync::atomic::Ordering::SeqCst);
        pass_unit(50);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let end = continue_schedule(inputs(&socket), Start::Pass(lease, batch));
        set_hook(None);
        PROMPT_WAIT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        pass_unit(0);
        assert_eq!(end, ScheduleEnd::Finished);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Launched);
        assert_eq!(wait_starts(&p, "dev", 1), 1, "launched once");
    }

    /// A3: an observer (its prepare found the lock held) continues the same
    /// batch once the owner is gone — the OS released its lock.
    #[test]
    fn an_observer_takes_over_the_batch_once_the_owner_is_gone() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-obs");
        let socket = server.socket().to_string();
        let p = declare("r3obs", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, .. } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        pass_unit(20);
        let i = inputs(&socket);
        let observer = std::thread::spawn(move || continue_schedule(i, Start::Observe));
        std::thread::sleep(std::time::Duration::from_millis(1200));
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Pending, "busy: the observer did nothing yet");
        drop(lease);
        let end = observer.join().unwrap();
        pass_unit(0);
        assert_eq!(end, ScheduleEnd::Finished);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Launched);
    }

    /// A8: an observer that exhausts its schedule while the owner lives
    /// writes nothing and closes nothing.
    #[test]
    fn an_observer_never_closes_a_live_owners_batch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-obs2");
        let socket = server.socket().to_string();
        let p = declare("r3obs2", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, .. } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let before = with_store(|s| s.restore_batch(&socket)).unwrap();
        pass_unit(1);
        let end = continue_schedule(inputs(&socket), Start::Observe);
        pass_unit(0);
        assert_eq!(end, ScheduleEnd::Observed);
        assert_eq!(with_store(|s| s.restore_batch(&socket)).unwrap(), before, "byte for byte");
        drop(lease);
    }

    /// A4: exhausted holding the lock, the batch is closed FAILED with its
    /// reason; the window it made and never typed into is killed (guarded),
    /// its hold retired with it, and the project's room is told once.
    #[test]
    fn an_exhausted_schedule_closes_the_batch_and_says_so() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-give");
        let socket = server.socket().to_string();
        let p = declare("r3give", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(slow_shell(&p, &socket, 600)));
        PROMPT_WAIT_MS.store(200, std::sync::atomic::Ordering::SeqCst);
        pass_unit(1);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let end = continue_schedule(inputs(&socket), Start::Pass(lease, batch));
        set_hook(None);
        PROMPT_WAIT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        pass_unit(0);
        let ScheduleEnd::GaveUp(word) = end else { panic!("{end:?}") };
        assert!(word.starts_with("failed: not finished after 4 passes"), "{word}");
        let last = with_store(|s| s.last_batch(&socket)).unwrap().unwrap();
        assert_eq!(last.closed.as_deref(), Some(word.as_str()));
        let w = &last.projects[0].windows[0];
        assert_eq!(w.state, WindowState::Failed);
        assert!(holds(&socket, &p).is_empty(), "its hold retired with the kill");
        let names = server.run(&["list-windows", "-t", &p.session, "-F", "#{window_name}"]).unwrap_or_default();
        assert!(!names.lines().any(|n| n == placeholder(&last.batch, w.ord)), "the untyped window is gone: {names}");
        let room = format!("proj:{}", p.session);
        let page = super::super::rooms::history_page(&room, None, 20).to_string();
        assert_eq!(page.matches("the restore after a host reboot did not finish").count(), 1, "{page}");
        assert_eq!(starts(&p, "dev"), 0, "nothing typed");
    }

    /// A5 / R7: off (the default) and "nothing to restore" schedule nothing;
    /// both record the decision for this boot.
    #[test]
    fn a_start_with_restore_off_or_nothing_to_do_schedules_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-off");
        let socket = server.socket().to_string();
        let p = declare("r3off", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        with_store(|s| s.set_restore_decided(&socket, "older")).unwrap();
        assert!(crate::config::restore_on_start(), "on unless config.toml says false (round 4)");
        let off = RunInputs { enabled: false, ..inputs(&socket) };
        assert!(prepare_on_start(&off).is_none());
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"));
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "no batch");
        assert!(holds(&socket, &p).is_empty());
        // A boot already restored: nothing, decided.
        run(&inputs(&socket)).unwrap();
        with_store(|s| s.set_restore_decided(&socket, "older")).unwrap();
        assert!(prepare_on_start(&inputs(&socket)).is_none());
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"));
    }

    /// A9: the first background pass runs under the lease prepare handed
    /// over, never a second acquire (which would be Busy against it).
    #[test]
    fn the_first_pass_runs_under_the_lease_prepare_took() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-lease");
        let socket = server.socket().to_string();
        let p = declare("r3lease", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let in_pass = seen.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "claim" {
                *in_pass.lock().unwrap() = Some(OwnerLock::try_acquire().unwrap().is_none());
            }
            Mangle::Run
        })));
        pass_unit(10_000);
        let t0 = std::time::Instant::now();
        let end = continue_schedule(inputs(&socket), Start::Pass(lease, batch));
        pass_unit(0);
        set_hook(None);
        assert_eq!(end, ScheduleEnd::Finished);
        assert!(t0.elapsed() < std::time::Duration::from_secs(60), "the FIRST pass did the work, before any wait: {:?}", t0.elapsed());
        assert_eq!(*seen.lock().unwrap(), Some(true), "and held the lease while it did");
    }

    /// The unknown → known path: a marker that does not name the tick's
    /// boot (here `unknown`, as a start with an unreadable boot writes)
    /// refuses the ticks until `decide_if_needed` prepares for the boot now
    /// readable; then a tick commits.
    #[test]
    fn a_boot_that_becomes_readable_is_decided_before_the_next_tick() {
        use_test_store();
        // Decided with the switch OFF (it is on by default since round 4):
        // the decision, not a restore, is what this pins.
        let _off = ConfigFor::test("restore_on_start = false\n");
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-known");
        let socket = server.socket().to_string();
        let p = declare("r3known", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        with_store(|s| s.set_restore_decided(&socket, super::super::store::UNKNOWN_BOOT)).unwrap();
        let cwd = p.ws.to_string_lossy().to_string();
        server.run(&["new-session", "-d", "-s", &p.session, "-c", &cwd, "-n", "sh1"]).unwrap();
        tmux::new_named_window(&p.session, "extra", &cwd).unwrap();
        let slots = || with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        super::super::capture_once().unwrap();
        assert!(!slots().contains(&"extra".to_string()), "refused while undecided");
        decide_if_needed();
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"));
        super::super::capture_once().unwrap();
        assert!(slots().contains(&"extra".to_string()), "{:?}", slots());
    }

    // ---- round 3 H1 review: the append ----------------------------------

    /// P1-A: a decision is published only under the owner lease. While
    /// another owner holds it (and may be reading the old evidence), a
    /// prepare with restore off, or with an unknown boot, is Busy and writes
    /// nothing, so a capture still commits nothing over the evidence.
    #[test]
    fn a_decision_is_published_only_under_the_owner_lease() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-lease2");
        let socket = server.socket().to_string();
        let p = declare("r3lease2", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        with_store(|s| s.set_restore_decided(&socket, "older")).unwrap();
        let cwd = p.ws.to_string_lossy().to_string();
        server.run(&["new-session", "-d", "-s", &p.session, "-c", &cwd, "-n", "sh1"]).unwrap();
        tmux::new_named_window(&p.session, "extra", &cwd).unwrap();
        let owner = OwnerLock::try_acquire().unwrap().expect("the other owner");
        let off = RunInputs { enabled: false, ..inputs(&socket) };
        let blind = RunInputs { boot_now: None, ..inputs(&socket) };
        assert!(matches!(prepare(&off).unwrap(), Prepared::Busy));
        assert!(matches!(prepare(&blind).unwrap(), Prepared::Busy));
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("older"), "nothing published");
        let slots = || with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        super::super::capture_once().unwrap();
        assert!(!slots().contains(&"extra".to_string()), "the gate still holds");
        drop(owner);
        assert!(matches!(prepare(&off).unwrap(), Prepared::Nothing(_)));
        assert_eq!(with_store(|s| s.restore_decided(&socket)).unwrap().as_deref(), Some("boot-after"));
    }

    /// P1-B: a renamed window, or one moved to another session, stays held;
    /// and when the socket cannot be read every window is held (it cannot be
    /// excluded that the target is the hold's pane) — a delivery is kept,
    /// not typed.
    #[test]
    fn a_renamed_or_moved_window_stays_held_and_an_unreadable_answer_holds_every_window() {
        use super::super::restore_hold::held;
        use std::os::unix::fs::PermissionsExt;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-move");
        let socket = server.socket().to_string();
        let p = declare("r3move", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let w = batch_of(&socket).projects[0].windows[0].clone();
        let (pane, wid) = (w.pane_id.unwrap(), w.window_id.unwrap());
        server.run(&["rename-window", "-t", &wid, "devx"]).unwrap();
        server.run(&["new-session", "-d", "-s", "elsewhere", "/bin/sh"]).unwrap();
        server.run(&["move-window", "-s", &wid, "-t", "elsewhere:"]).unwrap();
        assert!(held("elsewhere", "devx"), "moved: held where it is now");
        assert!(held(&p.session, "dev"), "and under its slot's name");
        assert!(!held("elsewhere", "sh"), "another window of that session is not");
        let mode = std::fs::metadata(&socket).unwrap().permissions().mode();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o000)).unwrap();
        let any = (held("elsewhere", "devx"), held(&p.session, "anything"));
        let kept = super::super::delivery::deliver("elsewhere", "devx", &pane, "TOKEN-UNK", 0, "");
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(any, (true, true), "unreadable: every window held");
        assert!(kept && super::super::telemetry::held_rows("elsewhere", "devx").len() == 1, "the line is kept");
        assert!(!screen_of(&pane).contains("TOKEN-UNK"));
    }

    /// P1-C: prune's verdict is conditional on the row it judged. A planned
    /// hold (its batch no longer open) that is bound and armed between the
    /// verdict and the retire is not deleted.
    #[test]
    fn prune_never_retires_a_hold_that_moved_on_after_its_verdict() {
        use super::super::restore_hold::{prune, PRUNE_HOOK};
        use super::super::store::{HoldPane, HoldStage};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-race");
        let socket = server.socket().to_string();
        let p = declare("r3race", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        drop(lease);
        let mut closed = batch;
        closed.closed = Some("failed: test".into());
        with_store(|s| s.close_batch(&mut closed.clone())).unwrap();
        let db = super::super::db_path();
        let sock = socket.clone();
        *PRUNE_HOOK.lock().unwrap() = Some(Box::new(move |h| {
            if h.stage == HoldStage::Planned {
                let pane = HoldPane {
                    instance: TmuxInstance { socket: sock.clone(), pid: 1, start_time: 1 },
                    session_id: "$1".into(),
                    window_id: "@1".into(),
                    pane_id: "%1".into(),
                    pane_pid: 1,
                };
                super::super::store::Store::open(&db).unwrap().advance_hold_for_test(&h.launch, &pane).unwrap();
            }
        }));
        let retired = prune();
        *PRUNE_HOOK.lock().unwrap() = None;
        assert!(retired.is_empty(), "{retired:?}");
        let left = holds(&socket, &p);
        assert_eq!((left.len(), left[0].stage), (1, HoldStage::Armed), "the armed row stands");
    }

    /// P1-D: a kill our guard refused, or one whose answer was lost while the
    /// window is still there, keeps the hold; an exhausted close never
    /// re-sends a kill already issued — it re-observes.
    #[test]
    fn a_kill_not_confirmed_keeps_the_hold_and_is_never_sent_twice() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-kill");
        let socket = server.socket().to_string();
        let p = declare("r3kill", vec![agent_slot("dev"), agent_slot("dev2"), agent_slot("dev3")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let (sock, kills) = (socket.clone(), std::sync::Arc::new(std::sync::Mutex::new(Vec::new())));
        let seen = kills.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            // Each agent is stopped after its window is made, so its door
            // refuses and kills the window it made.
            if s.op == "tag_window" {
                let name = ["dev", "dev2", "dev3"][s.ord.unwrap()];
                with_store(|st| st.set_slot_stopped(&pid, name)).unwrap();
            }
            if s.op == "kill" {
                seen.lock().unwrap().push(s.ord);
                return match s.ord {
                    // dev: the guard refuses (its tag taken away first).
                    Some(0) => {
                        let b = with_store(|st| st.restore_batch(&sock)).unwrap().unwrap();
                        let wid = b.projects[0].windows[0].window_id.clone().unwrap();
                        tmux::run_tmux_on(Some(&sock), &["set-option", "-w", "-u", "-t", &wid, "@tmm_rw"]).unwrap();
                        Mangle::Run
                    }
                    // dev2: the answer is lost, and the window is moved to
                    // another session meanwhile: its pane is still alive.
                    Some(1) => {
                        let b = with_store(|st| st.restore_batch(&sock)).unwrap().unwrap();
                        let wid = b.projects[0].windows[1].window_id.clone().unwrap();
                        let _ = tmux::run_tmux_on(Some(&sock), &["new-session", "-d", "-s", "moved-to", "/bin/sh"]);
                        tmux::run_tmux_on(Some(&sock), &["move-window", "-s", &wid, "-t", "moved-to:"]).unwrap();
                        Mangle::Lost
                    }
                    // dev3: issued, the run stops before it runs.
                    _ => Mangle::HaltBefore,
                };
            }
            Mangle::Run
        })));
        let _ = run(&inputs(&socket));
        set_hook(None);
        let b = batch_of(&socket);
        let state = |n: &str| b.projects[0].windows.iter().find(|w| w.name == n).unwrap().clone();
        assert_eq!(state("dev").state, WindowState::Failed);
        assert!(state("dev").reason.unwrap_or_default().contains("kill refused, left in place"));
        assert!(state("dev2").reason.unwrap_or_default().contains("left in place"));
        assert_eq!((state("dev3").state, state("dev3").op), (WindowState::Created, Some(BatchOp::Kill)));
        let names: Vec<String> = holds(&socket, &p).into_iter().map(|h| h.slot).collect();
        assert_eq!(names, ["dev", "dev2", "dev3"], "every unconfirmed kill keeps its hold");
        // Exhausted: dev3's issued kill is re-observed, never re-sent.
        let id = b.batch.clone();
        set_hook(Some(Box::new({
            let seen = kills.clone();
            move |s: &Step| {
                if s.op == "kill" {
                    seen.lock().unwrap().push(s.ord);
                }
                Mangle::Run
            }
        })));
        give_up(&inputs(&socket), &id, None, "test").unwrap();
        set_hook(None);
        assert_eq!(*kills.lock().unwrap(), [Some(0), Some(1), Some(2)], "one kill step per window, ever");
        let last = with_store(|s| s.last_batch(&socket)).unwrap().unwrap();
        assert!(last.projects[0].windows[2].reason.clone().unwrap_or_default().contains("left in place"), "{:?}", last.projects[0].windows[2]);
        assert_eq!(holds(&socket, &p).len(), 3);
    }

    /// P1-D, Applied half: a kill applied to the window is not the end of
    /// the hold's pane when that pane was moved out first (split, then
    /// break-pane): the hold stays, and still holds the pane where it is.
    #[test]
    fn an_applied_kill_of_a_window_whose_pane_moved_out_keeps_the_hold() {
        use super::super::restore_hold::held;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-break");
        let socket = server.socket().to_string();
        let p = declare("r3break", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let sock = socket.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "tag_window" {
                with_store(|st| st.set_slot_stopped(&pid, "dev")).unwrap();
            }
            if s.op == "kill" {
                let b = with_store(|st| st.restore_batch(&sock)).unwrap().unwrap();
                let w = &b.projects[0].windows[0];
                let (wid, pane) = (w.window_id.clone().unwrap(), w.pane_id.clone().unwrap());
                tmux::run_tmux_on(Some(&sock), &["split-window", "-d", "-t", &wid, "/bin/sh"]).unwrap();
                tmux::run_tmux_on(Some(&sock), &["break-pane", "-d", "-s", &pane, "-n", "broke-out"]).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (st, why) = window_state(&socket, &p.id, "dev");
        assert_eq!(st, WindowState::Failed);
        assert!(why.unwrap_or_default().contains("its pane not confirmed gone"));
        assert_eq!(holds(&socket, &p).len(), 1, "the pane lives on: the hold stays");
        assert!(held(&p.session, "broke-out"), "and holds the pane where it went");
    }

    /// P1D-b (validator, 1dff73e9): an unseen kill whose pane cannot be
    /// judged — the same %N alive under another process (respawn-pane -k) —
    /// is neither retired nor re-killed: the window stays Created with its
    /// kill issued, the hold stays, and a later pass only re-observes.
    #[test]
    fn an_unseen_kill_whose_pane_cannot_be_judged_keeps_everything() {
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-unseen");
        let socket = server.socket().to_string();
        let p = declare("r3unseen", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let sock = socket.clone();
        let kills = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = kills.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "tag_window" {
                with_store(|st| st.set_slot_stopped(&pid, "dev")).unwrap();
            }
            if s.op == "kill" {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let b = with_store(|st| st.restore_batch(&sock)).unwrap().unwrap();
                let pane = b.projects[0].windows[0].pane_id.clone().unwrap();
                tmux::run_tmux_on(Some(&sock), &["respawn-pane", "-k", "-t", &pane, "/bin/sh"]).unwrap();
                return Mangle::Lost;
            }
            Mangle::Run
        })));
        let _ = run(&inputs(&socket));
        let _ = run(&inputs(&socket));
        set_hook(None);
        let w = batch_of(&socket).projects[0].windows[0].clone();
        assert_eq!((w.state, w.op), (WindowState::Created, Some(BatchOp::Kill)), "the kill stays issued, to be re-observed");
        let h = holds(&socket, &p);
        assert_eq!((h.len(), h[0].stage), (1, HoldStage::Bound), "the hold stays");
        assert_eq!(kills.load(std::sync::atomic::Ordering::SeqCst), 1, "never re-sent, across passes");
    }

    /// P2: the schedule's offsets are absolute from its start: a slow pass
    /// shortens the next wait instead of pushing the plan back. On the
    /// virtual clock (no sleep, no tolerance), a first pass that takes 2 s
    /// still has the passes start at exactly 0, 30, 120 and 600 s.
    #[test]
    fn the_schedule_runs_at_offsets_from_its_start() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-offs");
        let socket = server.socket().to_string();
        let p = declare("r3offs", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let starts_at = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = starts_at.clone();
        let mut slow = slow_shell(&p, &socket, 600);
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "project" {
                let mut clock = VIRTUAL_MS.lock().unwrap();
                let now = clock.unwrap();
                let mut v = seen.lock().unwrap();
                v.push(now);
                if v.len() == 1 {
                    *clock = Some(now + 2000);
                }
            }
            slow(s)
        })));
        PROMPT_WAIT_MS.store(50, std::sync::atomic::Ordering::SeqCst);
        *VIRTUAL_MS.lock().unwrap() = Some(0);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let end = continue_schedule(inputs(&socket), Start::Pass(lease, batch));
        *VIRTUAL_MS.lock().unwrap() = None;
        set_hook(None);
        PROMPT_WAIT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(end, ScheduleEnd::GaveUp(_)), "{end:?}");
        assert_eq!(*starts_at.lock().unwrap(), [0, 30_000, 120_000, 600_000]);
    }

    // ---- round 3 H1: the validator's surviving controls, pinned ----------

    /// B-g: the hold's `%N` alive with ANOTHER pane process (respawned) is
    /// not proof of anything: held. B-h: a hold row the store cannot read
    /// holds too.
    #[test]
    fn a_respawned_pane_or_an_unreadable_hold_row_holds() {
        use super::super::restore_hold::held;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-pid");
        let socket = server.socket().to_string();
        let p = declare("r3pid", vec![agent_slot("dev"), agent_slot("dev2")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let b = batch_of(&socket);
        let pane = b.projects[0].windows[0].pane_id.clone().unwrap();
        server.run(&["rename-window", "-t", b.projects[0].windows[0].window_id.as_deref().unwrap(), "devx"]).unwrap();
        server.run(&["respawn-pane", "-k", "-t", &pane, "/bin/sh"]).unwrap();
        let pid = server.run(&["display-message", "-p", "-t", &pane, "#{pane_pid}"]).unwrap();
        assert_ne!(pid.trim(), b.projects[0].windows[0].pane_pid.unwrap().to_string(), "another process under the same %N");
        assert!(held(&p.session, "devx"), "a pid mismatch is unknown: held, renamed or not");
        assert!(held(&p.session, "unrelated"), "unknown holds every window, not only its own");
        assert_eq!(super::super::restore_hold::prune().len(), 0, "and never retired");
        let launch = b.projects[0].windows[1].launch.clone().unwrap();
        server.run(&["kill-pane", "-t", &pane]).unwrap();
        assert!(!held(&p.session, "unrelated"), "control: with that pane gone, an unrelated window is free");
        with_store(|s| s.corrupt_hold_for_test(&launch)).unwrap();
        assert!(held(&p.session, "unrelated"), "an unreadable store holds");
    }

    /// L-a / L-b: only the lock holder closes, and only the batch it ran.
    #[test]
    fn give_up_closes_only_under_the_lock_and_only_its_own_batch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-gu");
        let socket = server.socket().to_string();
        let p = declare("r3gu", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let before = with_store(|s| s.restore_batch(&socket)).unwrap();
        assert_eq!(give_up(&inputs(&socket), &batch.batch, None, "test").unwrap(), ScheduleEnd::Observed, "another owner holds the lock");
        assert_eq!(with_store(|s| s.restore_batch(&socket)).unwrap(), before, "untouched");
        drop(lease);
        assert_eq!(give_up(&inputs(&socket), "another-batch", None, "test").unwrap(), ScheduleEnd::Finished, "not the batch it ran");
        assert_eq!(with_store(|s| s.restore_batch(&socket)).unwrap(), before, "untouched");
        assert!(matches!(give_up(&inputs(&socket), &batch.batch, None, "test").unwrap(), ScheduleEnd::GaveUp(_)), "its own, under the lock");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none());
    }

    // ---- round 3 H2: release on measured evidence ------------------------

    /// dsh: the door resets the home's readiness files before arming; a
    /// readiness file of another start (an old one, another launch's uuid)
    /// does not release; one naming THIS launch for this pane's process does,
    /// and the hold stays as `released` with its generation.
    #[test]
    fn a_dsh_hold_is_released_only_by_readiness_naming_its_launch() {
        use super::super::restore_hold::held;
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-dsh");
        let socket = server.socket().to_string();
        let slot = Slot { command: Some("dsh".into()), agent_session_id: Some("session-r3d1".into()), ..agent_slot("d1") };
        let p = declare("r3dsh", vec![slot]);
        let home = p.ws.join(".tmm/agents/d1");
        let mut recipe: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        recipe["backend"] = "dsh".into();
        std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
        let state = home.join("dsh/tmm");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("ready"), format!("{} %0", std::process::id())).unwrap();
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let w = batch_of(&socket).projects[0].windows[0].clone();
        assert!(matches!(w.state, WindowState::Launched | WindowState::LaunchIssued | WindowState::LaunchUnknown), "{:?} {:?}", w.state, w.reason);
        assert!(!state.join("ready").exists(), "the door reset the old readiness file");
        let (launch, pane, pane_pid) = (w.launch.clone().unwrap(), w.pane_id.clone().unwrap(), w.pane_pid.unwrap());
        let staged = std::fs::read_to_string(home.join("launch-d1.sh")).unwrap();
        assert!(staged.contains(&format!("TMM_LAUNCH={launch} ")), "the start line carries this launch: {staged}");
        assert!(held(&p.session, "d1"));
        std::fs::write(state.join("ready"), format!("{pane_pid} {pane} {}", uuid::Uuid::new_v4())).unwrap();
        assert!(held(&p.session, "d1"), "another launch's readiness is not this one's");
        std::fs::write(state.join("ready"), format!("{pane_pid} {pane}")).unwrap();
        assert!(held(&p.session, "d1"), "a file naming no launch is not either");
        std::fs::write(state.join("ready"), format!("{pane_pid} {pane} {launch}")).unwrap();
        assert!(!held(&p.session, "d1"), "this launch's readiness releases");
        assert_eq!(holds(&socket, &p)[0].stage, HoldStage::Released, "the row stays, released");
    }

    /// Replace and the STAGE ruling (H2 review P1-B residual): a restart of a
    /// slot whose restore is still in progress installs a NEW armed
    /// generation before anything is typed. A restart of a RELEASED slot is
    /// an ordinary restart: its row is retired once the restart's kill ended
    /// its pane, no hold is installed, the line names no launch, and a late
    /// envelope of the released launch is dropped. The verb consumes only the
    /// generation it read before its kill: a prune between its kill and its
    /// door installs that generation again; another launch's generation
    /// appearing meanwhile makes its door type nothing. A hold or a pane
    /// that cannot be read types nothing.
    #[test]
    fn a_restart_of_a_held_slot_installs_a_new_generation_before_typing() {
        use super::super::restore_hold::{attribute, before_launch, held, prune, Attribution};
        use super::super::store::{HoldPane, HoldStage};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-repl");
        let socket = server.socket().to_string();
        let p = declare("r3repl", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let old = holds(&socket, &p)[0].clone();
        assert_eq!(old.stage, HoldStage::Armed);
        // Another window keeps the session alive while dev's is gone.
        server.run(&["new-window", "-d", "-t", &format!("={}:", p.session), "-n", "spare", "/bin/sh"]).unwrap();
        let staged = || std::fs::read_to_string(p.ws.join(".tmm/agents/dev/launch-dev.sh")).unwrap_or_default();
        let kill = |h: &super::super::store::Hold| server.run(&["kill-window", "-t", &h.pane.clone().unwrap().window_id]).unwrap();
        let dev_pane = || -> HoldPane {
            let id = tmux::find_window_by_name(&p.session, "dev").unwrap();
            let f: Vec<String> = server.run(&["display-message", "-p", "-t", &id, "#{pane_pid}\t#{window_id}\t#{session_id}\t#{pid}\t#{start_time}"]).unwrap().trim().split('\t').map(str::to_string).collect();
            HoldPane { instance: TmuxInstance { socket: socket.clone(), pid: f[3].parse().unwrap(), start_time: f[4].parse().unwrap() }, session_id: f[2].clone(), window_id: f[1].clone(), pane_id: id, pane_pid: f[0].parse().unwrap() }
        };
        // 1. Still in progress: a new armed generation on the new pane.
        kill(&old);
        let r = super::super::up_agent(&p.id, "dev").unwrap().unwrap();
        assert_eq!((r.status, r.error.as_deref()), ("created", None), "{r:?}");
        let now = holds(&socket, &p);
        assert_eq!(now.len(), 1);
        assert_ne!(now[0].launch, old.launch, "a new generation");
        assert_eq!(now[0].stage, HoldStage::Armed);
        assert_eq!(Some(dev_pane().pane_id), now[0].pane.clone().map(|p| p.pane_id), "bound to the new pane");
        assert!(staged().contains(&format!("TMM_LAUNCH={} ", now[0].launch)), "{}", staged());
        assert!(with_store(|s| s.hold_by_launch(&old.launch)).unwrap().is_none(), "the old uuid is gone");
        // 2. Released, then restarted: an ordinary restart.
        let gen2 = now[0].clone();
        with_store(|s| s.release_hold_if(&gen2.launch, &[HoldStage::Armed])).unwrap();
        kill(&gen2);
        // (Its row pruned between the door's read and its retire, and no
        // successor: still an ordinary restart.)
        *super::super::restore_hold::BEFORE_RETIRE.lock().unwrap() = Some(Box::new(|| {
            assert_eq!(super::super::restore_hold::prune().len(), 1);
        }));
        super::super::up_agent(&p.id, "dev").unwrap();
        assert!(holds(&socket, &p).is_empty(), "the released row is retired, no new hold");
        assert!(!staged().contains("TMM_LAUNCH="), "the line names no launch: {}", staged());
        assert!(!held(&p.session, "dev"), "today's admission");
        let p3 = dev_pane().pane_id;
        assert!(matches!(attribute(&gen2.pane.clone().unwrap().pane_id, Some(&gen2.launch)), Attribution::Drop(_)), "a late END of the released launch writes nothing");
        assert!(matches!(attribute(&p3, Some(&gen2.launch)), Attribution::Drop(_)), "whatever pane it names");
        assert_eq!(attribute(&p3, None), Attribution::Normal, "the new CLI's own envelopes are ordinary");
        // A restore generation in progress again, for the next cases.
        let arm = |launch: &str| {
            let h = super::super::store::Hold { launch: launch.into(), stage: HoldStage::Armed, pane: Some(dev_pane()), since: super::super::now(), ..gen2.clone() };
            with_store(|s| s.install_hold(&gen2, launch, HoldStage::Armed, h.pane.as_ref().unwrap(), h.since)).unwrap();
            holds(&socket, &p)[0].clone()
        };
        // V9/V9b (validator): the ordinary restart's fail-closed arms — a
        // released slot whose pane is still alive, or cannot be checked,
        // types nothing.
        let alive = arm(&uuid::Uuid::new_v4().to_string());
        with_store(|s| s.release_hold_if(&alive.launch, &[HoldStage::Armed])).unwrap();
        let target = dev_pane().pane_id;
        let r = before_launch(&p.session, "dev", &target);
        assert!(r.as_ref().is_err_and(|e| e.contains("still running")), "{r:?}");
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(true));
        let r = before_launch(&p.session, "dev", &target);
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(false));
        assert!(r.as_ref().is_err_and(|e| e.contains("cannot be checked")), "{r:?}");
        assert!(with_store(|s| s.retire_hold_if(&alive.launch)).unwrap());
        // 2a. Released again; between the door's read and its retire, another
        //     launch installs a successor: the retire is lost, nothing typed.
        let rel = arm(&uuid::Uuid::new_v4().to_string());
        with_store(|s| s.release_hold_if(&rel.launch, &[HoldStage::Armed])).unwrap();
        let rel = holds(&socket, &p)[0].clone();
        kill(&rel);
        let succ = uuid::Uuid::new_v4().to_string();
        let (r2, s2) = (rel.clone(), succ.clone());
        *super::super::restore_hold::BEFORE_RETIRE.lock().unwrap() = Some(Box::new(move || {
            assert!(with_store(|s| s.install_hold(&r2, &s2, HoldStage::Armed, r2.pane.as_ref().unwrap(), super::super::now())).unwrap());
        }));
        let typed = staged();
        let r = super::super::up_agent(&p.id, "dev").unwrap().unwrap();
        assert!(r.error.as_deref().is_some_and(|e| e.contains("replaced by another launch")), "{r:?}");
        assert_eq!(staged(), typed, "nothing staged or typed");
        assert_eq!(holds(&socket, &p)[0].launch, succ, "the successor is kept");
        assert_eq!(prune(), vec![succ.clone()], "(its pane is the killed one)");
        // 2b. A verb that began with NO hold, and a restore generation
        //     appears before its door: it is another launch's, nothing typed.
        let permit = super::super::start_permit(&p.session, "dev").unwrap();
        let appeared = arm(&uuid::Uuid::new_v4().to_string());
        let typed = staged();
        kill(&appeared);
        let r = super::super::up_agent(&p.id, "dev").unwrap().unwrap();
        assert!(r.error.as_deref().is_some_and(|e| e.contains("appeared after this start began")), "{r:?}");
        assert_eq!(staged(), typed, "nothing staged or typed");
        drop(permit);
        assert_eq!(prune(), vec![appeared.launch.clone()]);
        // 3. A restart whose kill is followed by the prune before its door.
        let armed = arm(&uuid::Uuid::new_v4().to_string());
        let permit = super::super::start_permit(&p.session, "dev").unwrap();
        kill(&armed);
        assert_eq!(prune(), vec![armed.launch.clone()], "its pane ended: the prune retired it");
        assert!(holds(&socket, &p).is_empty());
        super::super::up_agent(&p.id, "dev").unwrap();
        let gen4 = holds(&socket, &p);
        assert_eq!(gen4.len(), 1, "the verb's door installed the generation it started from");
        assert_eq!(gen4[0].stage, HoldStage::Armed);
        assert!(held(&p.session, "dev"), "the barrier is there");
        permit.finish(true).unwrap();
        // 4. Verb A starts from gen4; another launch B installs gen5 before
        //    A's door: A types nothing and gen5 stays.
        let permit = super::super::start_permit(&p.session, "dev").unwrap();
        let gen5 = uuid::Uuid::new_v4().to_string();
        assert!(with_store(|s| s.install_hold(&gen4[0], &gen5, HoldStage::Armed, gen4[0].pane.as_ref().unwrap(), super::super::now())).unwrap());
        let typed = staged();
        kill(&gen4[0]);
        let r = super::super::up_agent(&p.id, "dev").unwrap().unwrap();
        assert!(r.error.as_deref().is_some_and(|e| e.contains("since this start began")), "{r:?}");
        assert_eq!(staged(), typed, "nothing staged or typed");
        assert_eq!(holds(&socket, &p)[0].launch, gen5, "B's generation is kept");
        drop(permit);
        // 5. Nothing is typed when the hold or the pane cannot be read.
        assert!(before_launch(&p.session, "dev", "%99999").is_err(), "a pane that cannot be read");
        with_store(|s| s.corrupt_hold_for_test(&gen5)).unwrap();
        assert!(super::super::start_permit(&p.session, "dev").is_err(), "the verb is refused before its kill");
        // (A's door made its window and typed nothing into it.)
        server.run(&["kill-window", "-t", &dev_pane().window_id]).unwrap();
        let r = super::super::up_agent(&p.id, "dev").unwrap().unwrap();
        assert!(r.error.is_some(), "{r:?}");
        assert_eq!(staged(), typed, "no launch line was staged or typed");
    }

    /// V11 (validator, 95b78e72): the launch door's identity read must name
    /// the pane it asked about. A new pane that is gone before the read, and
    /// an answer for ANOTHER pane (the door would bind the generation to it),
    /// both type nothing: no generation installed, no window tagged.
    #[test]
    fn a_launch_door_whose_pane_is_gone_or_answered_for_another_installs_nothing() {
        use super::super::restore_hold::{before_launch, PANE_ANSWER};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-gone");
        let socket = server.socket().to_string();
        let p = declare("r3gone", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let before = holds(&socket, &p);
        assert_eq!(before.len(), 1);
        let dev = before[0].pane.clone().unwrap();
        let tag = || server.run(&["show-options", "-wqv", "-t", &dev.window_id, "@tmm_rl"]).unwrap_or_default();
        let tagged = tag();
        let gone = server.run(&["new-window", "-d", "-t", &format!("={}:", p.session), "-n", "spare", "-P", "-F", "#{pane_id}", "/bin/sh"]).unwrap().trim().to_string();
        let other = server.run(&["display-message", "-p", "-t", &dev.pane_id, "#{pane_id}\t#{pane_pid}\t#{window_id}\t#{session_id}\t#{pid}\t#{start_time}"]).unwrap().trim().to_string();
        server.run(&["kill-pane", "-t", &gone]).unwrap();
        let same = |hs: Vec<super::super::store::Hold>| hs.iter().map(|h| (h.launch.clone(), h.stage, h.pane.clone())).collect::<Vec<_>>();
        // Gone before the read.
        let r = before_launch(&p.session, "dev", &gone);
        assert!(r.is_err(), "{r:?}");
        assert_eq!(same(holds(&socket, &p)), same(before.clone()), "no generation installed");
        // Answered for another pane (the restored dev's own, alive).
        PANE_ANSWER.with(|a| *a.borrow_mut() = Some(other));
        let r = before_launch(&p.session, "dev", &gone);
        assert!(r.as_ref().is_err_and(|e| e.contains("unreadable")), "{r:?}");
        assert_eq!(same(holds(&socket, &p)), same(before), "not bound to the other pane");
        assert_eq!(tag(), tagged, "its window is not tagged");
    }

    /// K-spawn (validator, 95b78e72): the SPAWN door (`spawn::launch_window`,
    /// a hire or a restart's fallback) asks `before_launch` like reconcile's:
    /// spawning into a slot a restore still holds installs a new armed
    /// generation bound to the new pane before anything is typed, and its
    /// launch line names it as `TMM_LAUNCH`.
    #[test]
    fn a_spawn_into_a_held_slot_replaces_its_generation_and_names_it_on_the_line() {
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-spawn");
        let socket = server.socket().to_string();
        let p = declare("r3spawn", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let old = holds(&socket, &p)[0].clone();
        assert_eq!(old.stage, HoldStage::Armed);
        server.run(&["new-window", "-d", "-t", &format!("={}:", p.session), "-n", "spare", "/bin/sh"]).unwrap();
        server.run(&["kill-window", "-t", &old.pane.clone().unwrap().window_id]).unwrap();
        super::super::registry_save(&serde_json::json!({ "name": "r3spdef", "backend": "kiro", "system": "Spawn door.", "skills": "[]", "mcp": "[]" })).unwrap();
        let r = super::super::spawn::spawn(&super::super::spawn::SpawnRequest {
            session: &p.session,
            agent: "r3spdef",
            window_name: Some("dev".into()),
            resume: true,
            ..Default::default()
        });
        super::super::registry_delete("r3spdef").ok();
        assert!(r.is_ok(), "{r:?}");
        let now = holds(&socket, &p);
        assert_eq!(now.len(), 1);
        assert_ne!(now[0].launch, old.launch, "a new generation");
        assert_eq!(now[0].stage, HoldStage::Armed);
        let pane = tmux::find_window_by_name(&p.session, "dev").unwrap();
        assert_eq!(now[0].pane.clone().map(|h| h.pane_id), Some(pane), "bound to the spawned pane");
        let staged = std::fs::read_to_string(p.ws.join(".tmm/agents/dev/launch-dev.sh")).unwrap_or_default();
        assert!(staged.contains(&format!("TMM_LAUNCH={} ", now[0].launch)), "the line names it: {staged}");
    }

    /// 3d: past the deadline with no evidence, a held window is reported once
    /// in its room and derives idle + restore_not_ready; a room line that
    /// could not be posted is not "reported" and the next tick posts it. The
    /// status is read from the hold row at read time (review P1-A): a fact
    /// of this launch accepted while a tick is paused between its read and
    /// its writes still takes the window out, with no tick after it; so does
    /// the release. The deadline itself writes no turn fact.
    #[test]
    fn a_held_window_past_its_deadline_is_reported_once_and_shown_as_needing_a_person() {
        use super::super::restore_hold::{tick_not_ready, TICK_HOOK};
        use super::super::store::HoldStage;
        use super::super::telemetry::{derive, RESTORE_NOT_READY_DETAIL};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-nr");
        let socket = server.socket().to_string();
        let p = declare("r3nr", vec![agent_slot("dev"), Slot { ord: 1, ..agent_slot("dev2") }, Slot { ord: 2, ..agent_slot("dev3") }]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let hold_of = |slot: &str| holds(&socket, &p).into_iter().find(|h| h.slot == slot).unwrap();
        let (h, h2, h3) = (hold_of("dev"), hold_of("dev2"), hold_of("dev3"));
        tick_not_ready();
        // V10 (validator): dev3's evidence was accepted but its merge was
        // refused (merging): past the deadline it is NOT "not ready" — no
        // room line, no mark, no detail.
        with_store(|s| s.mark_hold_merging_if(&h3.launch)).unwrap();
        with_store(|s| s.age_hold_for_test(&h3.launch, 200)).unwrap();
        tick_not_ready();
        assert!(!hold_of("dev3").not_ready && !hold_of("dev3").reported, "a merging hold is not reported");
        assert_ne!(derive(&p.session, "dev3", 0).detail, RESTORE_NOT_READY_DETAIL);
        let any_line = || super::super::rooms::history_page(&format!("proj:{}", p.session), None, 50).to_string();
        assert!(!any_line().contains("dev3 was restored but has not shown it is ready"), "{}", any_line());
        assert_ne!(derive(&p.session, "dev", 0).detail, RESTORE_NOT_READY_DETAIL, "not before the deadline");
        // dev2: a tick paused between its read and its writes while this
        // launch's first fact is accepted: the window is out at once.
        with_store(|s| s.age_hold_for_test(&h2.launch, 200)).unwrap();
        let launch2 = h2.launch.clone();
        *TICK_HOOK.lock().unwrap() = Some(Box::new(move || {
            with_store(|s| s.accept_hold_fact_if(&launch2, 1)).unwrap();
        }));
        tick_not_ready();
        *TICK_HOOK.lock().unwrap() = None;
        assert!(!hold_of("dev2").not_ready && !hold_of("dev2").reported, "the claim re-checks in its own write: nothing from the stale read");
        assert_ne!(derive(&p.session, "dev2", 0).detail, RESTORE_NOT_READY_DETAIL, "the accepted fact wins over the paused tick");
        assert!(!super::super::rooms::history_page(&format!("proj:{}", p.session), None, 50).to_string().contains("dev2 was restored but has not shown it is ready"), "no wrong room line");
        with_store(|s| s.age_hold_for_test(&h.launch, 200)).unwrap();
        let facts_before = super::super::telemetry::turn_version(&p.session, "dev");
        let room = format!("proj:{}", p.session);
        let lines = || super::super::rooms::history_page(&room, None, 20).to_string().matches("dev was restored but has not shown it is ready").count();
        // The room cannot take the line: not reported, so the next tick posts it.
        let sql = |q: &str| with_store(|s| s.exec_test_sql(q)).unwrap();
        sql("CREATE TEMP TRIGGER nr422 BEFORE INSERT ON hub_msgs BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
        tick_not_ready();
        sql("DROP TRIGGER nr422;");
        assert_eq!(lines(), 0);
        assert!(!hold_of("dev").reported, "a line that was not posted is not reported");
        tick_not_ready();
        tick_not_ready();
        assert_eq!(lines(), 1, "posted once the room takes it, and only once");
        let st = derive(&p.session, "dev", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", RESTORE_NOT_READY_DETAIL));
        assert_eq!(super::super::telemetry::turn_version(&p.session, "dev"), facts_before, "the deadline writes no turn fact");
        // This launch's first accepted fact: out at once, no tick after it.
        with_store(|s| s.accept_hold_fact_if(&h.launch, 1)).unwrap();
        assert_ne!(derive(&p.session, "dev", 0).detail, RESTORE_NOT_READY_DETAIL);
        // Released: no detail either.
        with_store(|s| s.release_hold_if(&h.launch, &[HoldStage::Armed])).unwrap();
        assert_ne!(derive(&p.session, "dev", 0).detail, RESTORE_NOT_READY_DETAIL);
    }

    /// 3c, a person's prompt (B7, B9, C2, C2b, R3): only a prompt of THIS
    /// launch from the hold's pane whose fact reached the log releases. A
    /// window still carrying its placeholder is merged first: a lost or a
    /// refused rename keeps the hold (merging, one room line) and the tick
    /// retries; once merged, the hold is released with its batch record
    /// (`Launched`, so the capture observes it) and the held line is flushed
    /// by the slot's own rules — the prompt opened a turn, so it waits for
    /// that turn's end.
    #[test]
    fn a_persisted_prompt_of_this_launch_merges_releases_and_flushes_by_the_slots_rules() {
        use super::super::restore_hold::{held, on_prompt, release_ready, Release};
        use super::super::store::HoldStage;
        use super::super::telemetry::{held_rows, record_notification, record_prompt_outcome, PERSIST_IN_TEST};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-pr");
        let socket = server.socket().to_string();
        let p = declare("r3pr", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        // The launch is typed without its Enter: the window keeps its placeholder.
        set_hook(Some(once(&p.id, "launch", Some(0), Mangle::TextOnly)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let b = batch_of(&socket);
        let w = b.projects[0].windows[0].clone();
        assert_eq!(w.state, WindowState::LaunchUnknown);
        let (launch, pane, wid) = (w.launch.clone().unwrap(), w.pane_id.clone().unwrap(), w.window_id.clone().unwrap());
        let ph = placeholder(&b.batch, 0);
        assert!(names(&server, &p.session).contains(&ph));
        assert!(super::super::delivery::deliver(&p.session, "dev", &pane, "TOKEN-PR", 0, ""));
        assert_eq!(held_rows(&p.session, "dev").len(), 1);
        let stage = || holds(&socket, &p)[0].clone();
        // C2: a prompt whose write failed; another pane; another launch.
        assert_eq!(on_prompt(&launch, &pane, None), Ok(Release::Not));
        assert_eq!(on_prompt(&launch, "%99999", Some(1)), Ok(Release::Not));
        assert_eq!(on_prompt(&uuid::Uuid::new_v4().to_string(), &pane, Some(1)), Ok(Release::Not));
        assert_eq!((stage().stage, stage().accepted_seq), (HoldStage::Armed, None));
        // A person's prompt, persisted (C2b: not acked, persisted).
        PERSIST_IN_TEST.with(|f| f.set(true));
        // Recorded as the consumer records an attributed prompt: under its
        // generation, the row and the hold's acceptance in one transaction.
        let (typed, went) = super::super::telemetry::with_generation(Some((&p.session, "dev", &launch)), || record_prompt_outcome(&p.session, "dev", "a person typed this"));
        assert_eq!(went, super::super::telemetry::GenerationWrite::Ok);
        PERSIST_IN_TEST.with(|f| f.set(false));
        assert!(!typed.acked && typed.persisted(), "{typed:?}");
        // B9: the merge's answer is lost: held, merging, told once.
        set_hook(Some(once(&p.id, "merge", Some(0), Mangle::Lost)));
        assert_eq!(on_prompt(&launch, &pane, typed.row), Ok(Release::Merging));
        set_hook(None);
        assert_eq!((stage().stage, stage().merging, stage().accepted_seq), (HoldStage::Armed, true, typed.row));
        assert!(held(&p.session, "dev"));
        // B7: renamed by a person meanwhile: the tick's merge is refused.
        server.run(&["rename-window", "-t", &wid, "mine"]).unwrap();
        assert!(release_ready().is_empty());
        assert!(held(&p.session, "dev") && names(&server, &p.session).contains(&"mine".to_string()), "a person's name is not overwritten");
        let room = || super::super::rooms::history_page(&format!("proj:{}", p.session), None, 20).to_string();
        assert_eq!(room().matches("restored dev is running as").count(), 1, "{}", room());
        // Its placeholder back: the tick merges and releases.
        server.run(&["rename-window", "-t", &wid, &ph]).unwrap();
        assert_eq!(release_ready(), vec![launch.clone()]);
        assert!(names(&server, &p.session).contains(&"dev".to_string()));
        assert_eq!((stage().stage, stage().merging), (HoldStage::Released, false));
        assert_eq!(window_state(&socket, &p.id, "dev"), (WindowState::Launched, Some(super::super::store::RELEASED.into())));
        assert!(unrestored_windows(&batch_of(&socket), &p.id).unwrap().is_empty(), "the capture observes it now");
        // R3: the prompt's turn is open, so the line waits for its end.
        assert!(!held(&p.session, "dev"));
        assert_eq!(held_rows(&p.session, "dev").len(), 1, "kept for the turn's end");
        record_notification(&p.session, "dev", "completed");
        super::super::delivery::flush(&p.session, "dev");
        assert!(held_rows(&p.session, "dev").is_empty());
        let typed_in = (0..100).any(|_| {
            let seen = screen_of(&pane).contains("TOKEN-PR");
            if !seen {
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            seen
        });
        assert!(typed_in, "flushed into the merged window");
    }

    /// 3c, the envelope rule (S1, C1 and the no-uuid cell of revision 4):
    /// while held, this launch's envelope is the logical slot's and any other
    /// (another uuid, none) is dropped; released, its own launch is normal and
    /// a late one of another or no launch is still dropped; a pane with no
    /// hold, or whose pane ended, is normal.
    #[test]
    fn an_envelope_is_attributed_by_its_panes_hold_and_its_launch() {
        use super::super::restore_hold::{attribute, Attribution};
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-attr");
        let socket = server.socket().to_string();
        let p = declare("r3attr", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let w = batch_of(&socket).projects[0].windows[0].clone();
        let (launch, pane, wid) = (w.launch.clone().unwrap(), w.pane_id.clone().unwrap(), w.window_id.clone().unwrap());
        let other = uuid::Uuid::new_v4().to_string();
        let dropped = |a: Attribution| matches!(a, Attribution::Drop(_));
        // Renamed by a person: still the slot's.
        server.run(&["rename-window", "-t", &wid, "mine"]).unwrap();
        assert_eq!(attribute(&pane, Some(&launch)), Attribution::Slot { session: p.session.clone(), slot: "dev".into(), launch: launch.clone() });
        assert!(dropped(attribute(&pane, Some(&other))), "another launch");
        assert!(dropped(attribute(&pane, None)), "no launch");
        assert_eq!(attribute("%99999", None), Attribution::Normal, "a pane with no hold");
        // V6: its pane cannot be checked — this launch's and a launch-less
        // envelope are kept as Unknown, never Normal; another launch has no
        // generation here at all and is dropped.
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(true));
        let unchecked = (attribute(&pane, Some(&launch)), attribute(&pane, None), attribute(&pane, Some(&other)));
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(false));
        assert!(matches!(unchecked, (Attribution::Unknown(_), Attribution::Unknown(_), Attribution::Drop(_))), "{unchecked:?}");
        with_store(|s| s.release_hold_if(&launch, &[HoldStage::Armed])).unwrap();
        assert_eq!(attribute(&pane, Some(&launch)), Attribution::Own { launch: launch.clone() }, "released: its own launch is routed as usual, under its generation");
        assert!(dropped(attribute(&pane, Some(&other))), "a late envelope of an old launch after the release");
        assert!(dropped(attribute(&pane, None)), "and one with no launch");
        // Another window keeps the session alive while dev's pane ends.
        server.run(&["new-window", "-d", "-t", &format!("={}:", p.session), "-n", "spare", "/bin/sh"]).unwrap();
        server.run(&["kill-pane", "-t", &pane]).unwrap();
        assert_eq!(attribute(&pane, None), Attribution::Normal, "its pane ended: nothing of the restore's is left there");
        assert!(dropped(attribute(&pane, Some(&launch))), "but an envelope carrying its launch is never legacy normal");
        // Its row retired too (the ordinary restart): still dropped.
        assert_eq!(super::super::restore_hold::prune(), vec![launch.clone()]);
        assert!(dropped(attribute(&pane, Some(&launch))), "a launch with no live generation is dropped");
    }

    /// Review P1-E: a release lands while the owner still holds its copy in
    /// which the window is `launch_unknown` — between its window action and
    /// the holder step that finishes the project. The owner's finish reads
    /// the merged state: the window is Launched, the project done, the batch
    /// closed "done", and the next capture observes the window.
    #[test]
    fn a_release_between_the_owners_window_action_and_its_finish_is_what_the_finish_reads() {
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-own");
        let socket = server.socket().to_string();
        let p = declare("r3own", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let (id, sock) = (p.id.clone(), socket.clone());
        let mut typed = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if s.project != id {
                return Mangle::Run;
            }
            match s.op {
                // The launch's Enter is not sent: the owner records launch_unknown.
                "launch" if !typed => {
                    typed = true;
                    Mangle::TextOnly
                }
                // Before the finish: the window's evidence arrives and releases it.
                // (merged into its slot first, as every release does).
                "holder_kill" => {
                    let h = with_store(|st| st.socket_holds(&sock)).unwrap().into_iter().next().unwrap();
                    // (by hand: `merge_held` asks this very hook for its step)
                    let wid = h.pane.clone().unwrap().window_id;
                    tmux::run_tmux_on(Some(&sock), &["rename-window", "-t", &wid, "dev"]).unwrap();
                    assert!(with_store(|st| st.release_hold_if(&h.launch, &[HoldStage::Armed])).unwrap());
                    Mangle::Run
                }
                _ => Mangle::Run,
            }
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let b = batch_of(&socket);
        assert_eq!(b.projects[0].windows[0].state, WindowState::Launched, "{:?}", b.projects[0].windows[0]);
        assert_eq!(project_state(&socket, &p.id), (ProjectState::Done, None), "the finish read the merged window");
        assert_eq!(b.closed.as_deref(), Some("done"));
        assert!(unrestored_windows(&b, &p.id).unwrap().is_empty());
        super::super::capture_once().unwrap();
        let cp = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap();
        let names: Vec<String> = cp.projects.iter().find(|q| q.id == p.id).map(|q| q.windows.iter().map(|w| w.name.clone()).collect()).unwrap_or_default();
        assert_eq!(names, vec!["dev".to_string()], "the released window is observed as its slot");
    }

    /// Review P1-D: every release confirms in the server that the window is
    /// still the hold's own object in its own native session, carries no
    /// other restore's tags, and is the one the slot's name leads to in its
    /// project's session (where a flush types). Moved to another session, a
    /// same-name window at the old place, a session tagged by another
    /// restore, a NEW session under the project's name holding the window,
    /// the restore's window tag stripped: held, the line not typed anywhere.
    /// Released, then the target swapped before the flush: the flush, and
    /// every later ordinary flush, resolves through the one delivery door,
    /// bound to the released generation's own pane — held while the name
    /// leads elsewhere, typed into that `%id` once it leads to it again
    /// (review P1-D residuals).
    #[test]
    fn a_release_types_only_into_the_holds_own_window_in_its_own_session() {
        use super::super::restore_hold::{held, on_session_start, release_ready, Release};
        use super::super::store::HoldStage;
        use super::super::telemetry::held_rows;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-own2");
        let socket = server.socket().to_string();
        let p = declare("r3mv", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let w = batch_of(&socket).projects[0].windows[0].clone();
        let (launch, pane, wid) = (w.launch.clone().unwrap(), w.pane_id.clone().unwrap(), w.window_id.clone().unwrap());
        let batch = batch_of(&socket).batch;
        let at = format!("={}:", p.session);
        server.run(&["new-window", "-d", "-t", &at, "-n", "spare", "/bin/sh"]).unwrap();
        // V7 (validator): in place, but the ownership step's answer is lost:
        // not confirmed, so not released.
        set_hook(Some(once(&p.id, "merge", Some(0), Mangle::Lost)));
        assert_eq!(on_session_start(&launch, &pane, Some("startup")), Ok(Release::Merging), "an unconfirmed ownership check is not a release");
        set_hook(None);
        assert_eq!(holds(&socket, &p)[0].stage, HoldStage::Armed);
        assert!(super::super::delivery::deliver(&p.session, "dev", &pane, "TOKEN-MV", 0, ""));
        // Moved to another session, and a same-name window at the old place.
        server.run(&["new-session", "-d", "-s", "elsewhere", "/bin/sh"]).unwrap();
        server.run(&["move-window", "-s", &wid, "-t", "=elsewhere:"]).unwrap();
        let impostor = server.run(&["new-window", "-d", "-t", &at, "-n", "dev", "-P", "-F", "#{pane_id}", "/bin/sh"]).unwrap().trim().to_string();
        let stage = || holds(&socket, &p)[0].stage;
        assert_eq!(on_session_start(&launch, &pane, Some("startup")), Ok(Release::Merging), "moved: not released");
        assert_eq!(stage(), HoldStage::Armed);
        assert!(held(&p.session, "dev"), "the moved window keeps its barrier");
        // Back in its session, but the slot's name leads to the impostor first.
        server.run(&["move-window", "-s", &wid, "-t", &at]).unwrap();
        assert!(release_ready().is_empty(), "the name leads to another window: not released");
        server.run(&["kill-pane", "-t", &impostor]).unwrap();
        // Its session tagged by another restore.
        server.run(&["set-option", "-t", &at, "@tmm_rs", "another-batch"]).unwrap();
        assert!(release_ready().is_empty(), "another restore's session: not released");
        assert_eq!(held_rows(&p.session, "dev").len(), 1, "nothing was typed meanwhile");
        server.run(&["set-option", "-t", &at, "@tmm_rs", &batch]).unwrap();
        // Its session renamed away and a NEW session under the project's
        // name taking the window: the name leads to it, but it is not in
        // the native session it was bound in.
        let sid = server.run(&["display-message", "-p", "-t", &at, "#{session_id}"]).unwrap().trim().to_string();
        server.run(&["rename-session", "-t", &sid, "r3mv-old"]).unwrap();
        server.run(&["new-session", "-d", "-s", &p.session, "/bin/sh"]).unwrap();
        server.run(&["move-window", "-s", &wid, "-t", &at]).unwrap();
        assert!(release_ready().is_empty(), "another native session under the same name: not released");
        server.run(&["move-window", "-s", &wid, "-t", "=r3mv-old:"]).unwrap();
        server.run(&["kill-session", "-t", &at]).unwrap();
        server.run(&["rename-session", "-t", &sid, &p.session]).unwrap();
        // The restore's window tag stripped: not this hold's object any more.
        server.run(&["set-option", "-w", "-t", &wid, "-u", "@tmm_rw"]).unwrap();
        assert!(release_ready().is_empty(), "a missing tag is not ownership");
        server.run(&["set-option", "-w", "-t", &wid, "@tmm_rw", &format!("{batch}:0")]).unwrap();
        // Released, then — before its flush types — the window is moved away
        // and a same-name window takes the old place: the verified pane is
        // checked again at the moment of typing, and the line stays held.
        let (sock, wid2, at2) = (socket.clone(), wid.clone(), at.clone());
        let impostor2 = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let imp = impostor2.clone();
        *super::super::restore_hold::AFTER_RELEASE.lock().unwrap() = Some(Box::new(move || {
            tmux::run_tmux_on(Some(&sock), &["move-window", "-s", &wid2, "-t", "=elsewhere:"]).unwrap();
            *imp.lock().unwrap() = tmux::run_tmux_on(Some(&sock), &["new-window", "-d", "-t", &at2, "-n", "dev", "-P", "-F", "#{pane_id}", "/bin/sh"]).unwrap().trim().to_string();
        }));
        assert_eq!(release_ready(), vec![launch.clone()], "its own window, in its own session: released");
        assert_eq!(stage(), HoldStage::Released);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(held_rows(&p.session, "dev").len(), 1, "the target changed between the release and the typing: kept");
        assert!(!screen_of(&impostor2.lock().unwrap()).contains("TOKEN-MV") && !screen_of(&pane).contains("TOKEN-MV"), "typed nowhere");
        // Every later ORDINARY flush goes through the same door, bound to
        // the released generation's pane: still held, typed nowhere.
        super::super::delivery::flush(&p.session, "dev");
        super::super::delivery::flush_idle(&p.session);
        super::super::delivery::flush_on_start();
        assert!(held(&p.session, "dev"), "the name leads to another object: typing into the slot is barred");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(held_rows(&p.session, "dev").len(), 1, "an ordinary flush does not bypass the binding");
        assert!(!screen_of(&impostor2.lock().unwrap()).contains("TOKEN-MV") && !screen_of(&pane).contains("TOKEN-MV"), "typed nowhere");
        // Back in its own session, but the name still leads to the same-name
        // window first: still no target.
        server.run(&["move-window", "-s", &wid, "-t", &at]).unwrap();
        assert!(held(&p.session, "dev"), "the name leads to the other window first: still barred");
        super::super::delivery::flush(&p.session, "dev");
        assert_eq!(held_rows(&p.session, "dev").len(), 1);
        // The authorized object where the name leads: typed into its %id.
        server.run(&["kill-pane", "-t", &impostor2.lock().unwrap()]).unwrap();
        assert!(!held(&p.session, "dev"), "its own pane where the name leads");
        super::super::delivery::flush(&p.session, "dev");
        let typed = (0..100).any(|_| {
            let seen = screen_of(&pane).contains("TOKEN-MV");
            if !seen {
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            seen
        });
        assert!(typed, "flushed into the hold's own pane");
        let _ = server.run(&["kill-session", "-t", "=elsewhere"]);
    }

    /// V5 (validator): a hold of ANOTHER gateway's socket — its own server,
    /// whose pane carries the same `%id` as this one's restored pane — is
    /// never released by evidence this gateway consumes: the other socket's
    /// hold stays armed, and so does this one's (the evidence names a launch
    /// that is not its own).
    #[test]
    fn evidence_never_releases_another_sockets_hold_with_the_same_pane_id() {
        use super::super::restore_hold::{on_prompt, on_session_start, Release};
        use super::super::store::{HoldPane, HoldStage};
        use_test_store();
        let scope = GlobalSocket::hold();
        let other = crate::tmux::test_support::PrivateServer::new("r3-v5o");
        let server = PrivateTmux::start(&scope, "r3-v5");
        let socket = server.socket().to_string();
        let p = declare("r3v5", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let mine = holds(&socket, &p)[0].clone();
        let pane = mine.pane.clone().unwrap().pane_id;
        // The other server: panes until one has the same id, in a window named as the slot.
        let on = |args: &[&str]| tmux::run_tmux_on(Some(&other.socket), args).unwrap();
        on(&["new-session", "-d", "-s", "o", "/bin/sh"]);
        let mut theirs = on(&["display-message", "-p", "-t", "=o:", "#{pane_id}"]).trim().to_string();
        while theirs != pane {
            theirs = on(&["new-window", "-d", "-t", "=o:", "-P", "-F", "#{pane_id}", "/bin/sh"]).trim().to_string();
        }
        let f: Vec<String> = on(&["display-message", "-p", "-t", &theirs, "#{pane_pid}\t#{window_id}\t#{session_id}\t#{pid}\t#{start_time}"]).trim().split('\t').map(str::to_string).collect();
        on(&["rename-window", "-t", &f[1], "dev"]);
        let launch = uuid::Uuid::new_v4().to_string();
        // Authorized as that generation's window, as a launch door tags it.
        on(&["set-option", "-w", "-t", &f[1], "@tmm_rl", &launch]);
        let foreign = super::super::store::Hold {
            socket: other.socket.clone(),
            project_id: p.id.clone(),
            batch: "b-other".into(),
            ord: 0,
            slot: "dev".into(),
            launch: launch.clone(),
            stage: HoldStage::Armed,
            pane: Some(HoldPane {
                instance: TmuxInstance { socket: other.socket.clone(), pid: f[3].parse().unwrap(), start_time: f[4].parse().unwrap() },
                session_id: f[2].clone(),
                window_id: f[1].clone(),
                pane_id: theirs.clone(),
                pane_pid: f[0].parse().unwrap(),
            }),
            since: super::super::now(),
            accepted_seq: None,
            not_ready: false,
            reported: false,
            merging: false,
        };
        let unrelated = Batch { batch: "b-other".into(), socket: format!("{}-unrelated", other.socket), boot_id: None, owner_pid: 0, attempt: 0, instance: None, source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] }, closed: None, projects: vec![] };
        with_store(|s| s.open_batch(&unrelated, &[foreign], "x")).unwrap();
        assert_eq!(on_session_start(&launch, &pane, Some("startup")), Ok(Release::Not), "another socket's hold is not this gateway's");
        // V5b: an envelope carrying that launch from this gateway's pane of
        // the same id is not attributed to the other socket's row.
        assert!(matches!(super::super::restore_hold::attribute(&pane, Some(&launch)), super::super::restore_hold::Attribution::Drop(_)), "another socket's generation routes nothing here");
        // Even when that other socket key names THIS server (an alias of the
        // same tmux), bound to this very pane: its row is not this gateway's.
        let alias = uuid::Uuid::new_v4().to_string();
        let ours = holds(&socket, &p)[0].clone();
        let aliased = super::super::store::Hold { socket: format!("{socket}-alias"), batch: "b-alias".into(), slot: "dev-alias".into(), launch: alias.clone(), ..ours.clone() };
        with_store(|s| s.open_batch(&unrelated, &[aliased], "x")).unwrap();
        assert!(matches!(super::super::restore_hold::attribute(&pane, Some(&alias)), super::super::restore_hold::Attribution::Drop(_)), "a row of another socket key, on this server's own pane, routes nothing here");
        assert_eq!(on_prompt(&launch, &pane, Some(1)), Ok(Release::Not));
        assert_eq!(with_store(|s| s.hold_by_launch(&launch)).unwrap().unwrap().stage, HoldStage::Armed, "the other socket's hold stays armed");
        assert_eq!(holds(&socket, &p)[0].stage, HoldStage::Armed, "and so does this one's");
    }

    /// Review P1-A residual: a slot has ONE current incarnation. A newer
    /// generation (a later boot's plan) retires the slot's older rows in its
    /// own transaction, so an old row reported not ready never decides the
    /// new incarnation's status: its accepted fact reads running, no prune
    /// needed.
    #[test]
    fn a_newer_generation_retires_the_slots_older_rows_and_its_own_state_shows() {
        use super::super::restore_hold::tick_not_ready;
        use super::super::store::HoldStage;
        use super::super::telemetry::{derive, record_tool, with_generation, GenerationWrite, PERSIST_IN_TEST, RESTORE_NOT_READY_DETAIL};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-cur");
        let socket = server.socket().to_string();
        let p = declare("r3cur", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let l1 = holds(&socket, &p)[0].clone();
        with_store(|s| s.age_hold_for_test(&l1.launch, 200)).unwrap();
        tick_not_ready();
        assert_eq!(derive(&p.session, "dev", 0).detail, RESTORE_NOT_READY_DETAIL);
        // The next plan's generation of the same slot, in another batch.
        let l2 = super::super::store::Hold { batch: "b-next".into(), launch: uuid::Uuid::new_v4().to_string(), stage: HoldStage::Armed, since: super::super::now(), not_ready: false, reported: false, ..l1.clone() };
        let unrelated = Batch { batch: "b-next".into(), socket: format!("{socket}-unrelated"), boot_id: None, owner_pid: 0, attempt: 0, instance: None, source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] }, closed: None, projects: vec![] };
        with_store(|s| s.open_batch(&unrelated, &[l2.clone()], "x")).unwrap();
        let now: Vec<String> = holds(&socket, &p).into_iter().map(|h| h.launch).collect();
        assert_eq!(now, vec![l2.launch.clone()], "the older row is retired with the install");
        PERSIST_IN_TEST.with(|f| f.set(true));
        let (_, went) = with_generation(Some((&p.session, "dev", &l2.launch)), || record_tool(&p.session, "dev", "Bash", "ls"));
        PERSIST_IN_TEST.with(|f| f.set(false));
        assert_eq!(went, GenerationWrite::Ok);
        assert_eq!(derive(&p.session, "dev", 0).state, "running", "the current incarnation's own state");
    }

    /// 3c, SessionStart: evidence exactly where it was measured — claude's
    /// of any source, kimi's only with `source: resume`, no other backend's
    /// (grok here; kiro is v1 not-ready the same way)
    /// — and only of this launch from the hold's pane.
    #[test]
    fn a_session_start_of_this_launch_releases_only_where_it_was_measured() {
        use super::super::restore_hold::{on_session_start, Release};
        use super::super::store::HoldStage;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r3-ss");
        let socket = server.socket().to_string();
        let mut slots = vec![agent_slot("c1"), agent_slot("k1"), agent_slot("x1")];
        for (i, s) in slots.iter_mut().enumerate() {
            s.ord = i as i64;
        }
        let p = declare("r3ss", slots);
        for (name, backend) in [("k1", "kimi"), ("x1", "grok")] {
            let home = p.ws.join(".tmm/agents").join(name);
            let mut recipe: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
            recipe["backend"] = backend.into();
            std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
        }
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let b = batch_of(&socket);
        let of = |name: &str| {
            let w = b.projects[0].windows.iter().find(|w| w.name == name).unwrap_or_else(|| panic!("{name}: {:?}", b.projects[0].windows));
            assert!(w.launch.is_some(), "{name}: {w:?}");
            (w.launch.clone().unwrap(), w.pane_id.clone().unwrap())
        };
        let stage = |launch: &str| with_store(|s| s.hold_by_launch(launch)).unwrap().map(|h| h.stage);
        assert_eq!(holds(&socket, &p).len(), 3, "{:?}", b.projects[0].windows);
        let (c, cp) = of("c1");
        assert!(super::super::delivery::deliver(&p.session, "c1", &cp, "TOKEN-SS", 0, ""));
        assert_eq!(super::super::telemetry::held_rows(&p.session, "c1").len(), 1);
        assert_eq!(on_session_start(&uuid::Uuid::new_v4().to_string(), &cp, Some("startup")), Ok(Release::Not), "another launch");
        assert_eq!(on_session_start(&c, "%99999", Some("startup")), Ok(Release::Not), "another pane");
        assert_eq!(on_session_start(&c, &cp, Some("startup")), Ok(Release::Released), "claude: any source");
        assert_eq!(stage(&c), Some(HoldStage::Released));
        assert!(super::super::telemetry::held_rows(&p.session, "c1").is_empty(), "no turn is open: its held line is flushed at the release");
        let (k, kp) = of("k1");
        assert_eq!(on_session_start(&k, &kp, Some("startup")), Ok(Release::Not), "kimi: a fresh start is no evidence");
        assert_eq!(on_session_start(&k, &kp, None), Ok(Release::Not));
        assert_eq!(on_session_start(&k, &kp, Some("resume")), Ok(Release::Released));
        let (x, xp) = of("x1");
        assert_eq!(on_session_start(&x, &xp, Some("resume")), Ok(Release::Not), "no measured evidence for grok");
        assert_eq!(stage(&x), Some(HoldStage::Armed));
    }

    // ---- review round 2: P1-A ownership-based capture exclusion ----------

    #[test]
    fn capture_excludes_only_windows_a_batch_owns_never_by_name() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-own");
        let socket = server.socket().to_string();
        let q = declare("own", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&q]);
        set_hook(Some(once(&q.id, "launch", Some(0), Mangle::TextOnly)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &q.id, "dev").0, WindowState::LaunchUnknown);
        let b = batch_of(&socket);
        assert!(b.closed.is_some(), "closed with a launch_unknown window left");
        // Two plain windows of the person's: one with the prefix, one even in
        // the exact placeholder format of THIS batch — but untagged.
        let cwd = q.ws.to_string_lossy().to_string();
        let look_alike = placeholder(&b.batch, 7);
        tmux::new_named_window(&q.session, "tmm-r-report", &cwd).unwrap();
        tmux::new_named_window(&q.session, &look_alike, &cwd).unwrap();
        // And a person's window with the SAME name as the owned placeholder:
        // the exclusion follows the owned window's index, not its name.
        tmux::new_named_window(&q.session, &placeholder(&b.batch, 0), &cwd).unwrap();
        super::super::capture_once().unwrap();
        let slots: Vec<String> = with_store(|s| s.slots(&q.id)).unwrap().into_iter().map(|s| s.window_name).collect();
        assert!(slots.contains(&"tmm-r-report".to_string()), "a user's window is folded whatever its name: {slots:?}");
        assert!(slots.contains(&look_alike), "an untagged look-alike is the user's: {slots:?}");
        assert!(slots.contains(&"sh1".to_string()));
        let owned = placeholder(&b.batch, 0);
        let declared = with_store(|s| s.slots(&q.id)).unwrap();
        let same_name: Vec<_> = declared.iter().filter(|s| s.window_name == owned).collect();
        assert_eq!(same_name.len(), 1, "the person's same-name window is folded, once: {slots:?}");
        let cp = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap();
        let in_cp = cp.projects.iter().find(|p| p.id == q.id).map(|p| p.windows.iter().filter(|w| w.name == owned).count()).unwrap_or(0);
        assert_eq!(in_cp, 1, "and appears once in the checkpoint — the owned one is excluded by its index");
    }

    /// Validator P2: an UNREADABLE batch holds only the projects whose session
    /// carries a restore's env; every other project folds as usual, and no
    /// checkpoint is published until the batch reads again.
    #[test]
    fn an_unreadable_batch_holds_only_restore_sessions() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-unread");
        let socket = server.socket().to_string();
        let plain = declare("plain", vec![shell_slot("sh1")]);
        let ours = declare("ours", vec![shell_slot("sh1")]);
        let cwd = plain.ws.to_string_lossy().to_string();
        server.run(&["new-session", "-d", "-s", &plain.session, "-c", &cwd, "-n", "sh1"]).unwrap();
        server.run(&["new-session", "-d", "-s", &ours.session, "-e", "TMM_RESTORE_BATCH=x", "-n", "sh1"]).unwrap();
        tmux::new_named_window(&plain.session, "extra", &cwd).unwrap();
        tmux::new_named_window(&ours.session, "extra", &cwd).unwrap();
        publish(&socket, &[]);
        let gen = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen;
        with_store(|s| s.meta_set(&format!("restore_batch:{socket}"), "{broken")).unwrap();
        super::super::capture_once().unwrap();
        let slots = |id: &str| with_store(|s| s.slots(id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        assert!(slots(&plain.id).contains(&"extra".to_string()), "a plain project still folds");
        assert!(!slots(&ours.id).contains(&"extra".to_string()), "a restore's session is held");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint");
        // (an unreadable open batch is never overwritten: it is removed first)
        with_store(|s| s.exec_test_sql(&format!("DELETE FROM meta WHERE key = 'restore_batch:{socket}'"))).unwrap();
        with_store(|s| s.close_batch(&mut Batch { batch: "x".into(), socket: socket.clone(), boot_id: None, owner_pid: 0, attempt: 0, instance: None, source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] }, closed: Some("cleanup".into()), projects: vec![] })).unwrap();
    }

    /// C5: capture's exclusion needs the SESSION's facts too — a window whose
    /// own tag still names the batch, in a session that no longer carries
    /// the batch's tag, is not provably ours and is folded.
    #[test]
    fn c5_an_owned_window_in_a_session_no_longer_tagged_is_folded() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-c5");
        let socket = server.socket().to_string();
        let q = declare("c5", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&q]);
        set_hook(Some(once(&q.id, "launch", Some(0), Mangle::TextOnly)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let b = batch_of(&socket);
        let owned = placeholder(&b.batch, 0);
        super::super::capture_once().unwrap();
        let slots = || with_store(|s| s.slots(&q.id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        assert!(!slots().contains(&owned), "control: ours, excluded");
        server.run(&["set-option", "-u", "-t", &format!("={}:", q.session), "@tmm_rs"]).unwrap();
        super::super::capture_once().unwrap();
        assert!(slots().contains(&owned), "without the session's tag it is not provably ours: {:?}", slots());
    }

    /// C3: no checkpoint while ANY batch is open — also when none of its
    /// projects has a live session yet (nothing to hold, still a restore).
    #[test]
    fn c3_no_checkpoint_while_a_batch_is_open_even_before_its_first_session() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-c3");
        let socket = server.socket().to_string();
        let p = declare("c3", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert!(names(&server, &p.session).is_empty(), "no session of the batch exists yet");
        let gen = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen;
        super::super::capture_once().unwrap();
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint while a restore is open");
    }

    // ---- P1-B: the frozen identity -----------------------------------------

    #[test]
    fn a_project_renamed_or_moved_after_the_plan_is_refused() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-frozen");
        let socket = server.socket().to_string();
        let renamed = declare("ren", vec![shell_slot("sh1")]);
        let moved = declare("mov", vec![shell_slot("sh1")]);
        publish(&socket, &[&renamed, &moved]);
        set_hook(Some(once(&renamed.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let new_name = format!("{}-new", renamed.session);
        with_store(|s| s.set_session(&renamed.id, &new_name, &renamed.session)).unwrap();
        // Move `moved` to another directory: same id, another path.
        let mut row = with_store(|s| s.project(&moved.id)).unwrap().unwrap();
        let elsewhere = std::env::temp_dir().join(format!("tmm-r2-elsewhere-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        row.path = elsewhere.to_string_lossy().to_string();
        let slots = with_store(|s| s.slots(&moved.id)).unwrap();
        with_store(|s| s.delete_project(&moved.id).map(|_| ())).unwrap();
        with_store(|s| s.insert_project(&row)).unwrap();
        with_store(|s| s.replace_slots(&moved.id, &slots)).unwrap();

        run(&inputs(&socket)).unwrap();
        for p in [&renamed, &moved] {
            let (st, why) = project_state(&socket, &p.id);
            assert_eq!(st, ProjectState::Skipped, "{}", p.id);
            assert!(why.unwrap_or_default().contains("changed since the plan"));
        }
        assert!(names(&server, &renamed.session).is_empty() && names(&server, &new_name).is_empty(), "nothing under either name");
        assert!(names(&server, &moved.session).is_empty(), "nothing at the old path or the new");
    }

    #[test]
    fn a_window_moved_or_split_before_the_launch_gets_nothing_typed() {
        use_test_store();
        for change in ["move", "split", "rename"] {
            let scope = GlobalSocket::hold();
            let server = PrivateTmux::start(&scope, &format!("r2-pane-{change}"));
            let socket = server.socket().to_string();
            let other = declare("pother", vec![shell_slot("sh1")]);
            let a = declare("pa", vec![agent_slot("dev")]);
            publish(&socket, &[&other, &a]);
            let (sock, other_session) = (socket.clone(), other.session.clone());
            let mut fired = false;
            let aid = a.id.clone();
            let ch = change.to_string();
            let socket_for_hook = socket.clone();
            set_hook(Some(Box::new(move |s: &Step| {
                if !fired && s.op == "launch" && s.project == aid {
                    fired = true;
                    let b = with_store(|st| st.restore_batch(&socket_for_hook)).unwrap().unwrap();
                    let w = b.projects.iter().find(|p| p.id == aid).unwrap().windows[0].window_id.clone().unwrap();
                    if ch == "move" {
                        // Into ANOTHER of our sessions (same batch, same ord 0).
                        tmux::run_tmux_on(Some(&sock), &["move-window", "-s", &w, "-t", &format!("={other_session}:")]).unwrap();
                    } else if ch == "rename" {
                        // Its birth name is gone: it is no longer the window planned.
                        tmux::run_tmux_on(Some(&sock), &["rename-window", "-t", &w, "renamed-by-someone"]).unwrap();
                    } else {
                        tmux::run_tmux_on(Some(&sock), &["split-window", "-d", "-t", &w]).unwrap();
                        tmux::run_tmux_on(Some(&sock), &["select-pane", "-t", &format!("{w}.1")]).unwrap();
                    }
                }
                Mangle::Run
            })));
            run(&inputs(&socket)).unwrap();
            set_hook(None);
            let (st, why) = window_state(&socket, &a.id, "dev");
            assert_eq!(st, WindowState::Failed, "{change}: {why:?}");
            assert!(why.unwrap_or_default().contains("nothing was typed"), "{change}");
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert_eq!(starts(&a, "dev"), 0, "{change}: the launch went nowhere");
            assert_eq!(names(&server, &other.session).into_iter().filter(|n| n == "sh1").count(), 1, "{change}: the other session's window is intact");
            drop(server);
        }
    }

    // ---- P1-C: the holder ------------------------------------------------------

    #[test]
    fn the_holder_kill_is_written_ahead_never_repeated_and_never_empties_a_session() {
        use_test_store();
        for (case, m) in [("halt", Mangle::HaltBefore), ("ran", Mangle::RunThenHalt), ("lost", Mangle::DropReceipt)] {
            let scope = GlobalSocket::hold();
            let server = PrivateTmux::start(&scope, &format!("r2-holder-{case}"));
            let socket = server.socket().to_string();
            let p = declare("hold", vec![shell_slot("sh1")]);
            publish(&socket, &[&p]);
            set_hook(Some(once(&p.id, "holder_kill", None, m)));
            run(&inputs(&socket)).unwrap();
            set_hook(None);
            let holder_present = names(&server, &p.session).iter().any(|n| n.ends_with("-holder"));
            if case != "lost" {
                assert_eq!(batch_of(&socket).projects[0].op, Some(BatchOp::HolderKill), "{case}: the issued holder step is on record");
                run(&inputs(&socket)).unwrap();
            }
            let after = names(&server, &p.session);
            match case {
                // Never run: the successor does NOT kill it — left in place, said so.
                "halt" => {
                    assert!(holder_present && after.iter().any(|n| n.ends_with("-holder")), "{case}: {after:?}");
                    assert!(project_state(&socket, &p.id).1.unwrap_or_default().contains("left in place"));
                }
                _ => assert_eq!(after, ["sh1"], "{case}: gone, observed done"),
            }
            assert_eq!(project_state(&socket, &p.id).0, ProjectState::Done, "{case}");
            drop(server);
        }
    }

    #[test]
    fn a_holder_that_became_the_last_window_is_renamed_not_killed() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-holder-last");
        let socket = server.socket().to_string();
        let p = declare("last", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let (sock, session) = (socket.clone(), p.session.clone());
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "holder_kill" {
                fired = true;
                // The other window exits between the read and the kill.
                tmux::run_tmux_on(Some(&sock), &["kill-window", "-t", &format!("={session}:sh1")]).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let after = windows(&server, &p.session);
        assert_eq!(after.len(), 1, "the session keeps one window: {after:?}");
        assert!(!after[0].0.starts_with("tmm-r-"), "the holder became a plain shell: {after:?}");
    }

    // ---- P1-D: the gate holds for an open batch too ---------------------------

    #[test]
    fn an_open_batch_is_left_untouched_when_restore_is_off_or_the_boot_is_unknown() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-gate");
        let socket = server.socket().to_string();
        let p = declare("gate", vec![shell_slot("sh1"), shell_slot("sh2")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "create_window", Some(1), Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let frozen = with_store(|s| s.restore_batch(&socket)).unwrap().expect("a half-done batch");
        let before = windows(&server, &p.session);
        let mut off = inputs(&socket);
        off.enabled = false;
        assert_eq!(run(&off).unwrap(), RunOutcome::Nothing("restore on start is off".into()));
        let mut blind = inputs(&socket);
        blind.boot_now = None;
        assert!(matches!(run(&blind).unwrap(), RunOutcome::Nothing(_)));
        assert_eq!(with_store(|s| s.restore_batch(&socket)).unwrap(), Some(frozen), "the batch is preserved byte for byte");
        assert_eq!(windows(&server, &p.session), before, "no tmux write");
        // Control: the same boot continues it.
        assert!(matches!(run(&inputs(&socket)).unwrap(), RunOutcome::Ran { closed: Some(_), .. }));
    }

    // ---- P2: an unseen session tag is re-observed, not called foreign ----------

    #[test]
    fn a_lost_session_tag_install_is_completed_not_called_foreign() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-tag");
        let socket = server.socket().to_string();
        let p = declare("tag", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "tag_session", None, Mangle::Lost)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(project_state(&socket, &p.id).0, ProjectState::Done, "present, ours, untagged: the install was completed");
        assert_eq!(names(&server, &p.session), ["sh1"]);
    }

    // ---- the launch door never types on a timeout (validator load finding) --

    #[test]
    fn a_shell_that_prompts_late_is_never_typed_into_blind() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-late");
        let socket = server.socket().to_string();
        let p = declare("late", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        // A shell that shows its prompt only after the pass has given up.
        let slow = p.ws.join("slow-shell.sh");
        std::fs::write(&slow, "#!/bin/sh\nsleep 3\nexec /bin/sh -i\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (sock, slow_s) = (socket.clone(), slow.to_string_lossy().to_string());
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "create_window" {
                fired = true;
                tmux::run_tmux_on(Some(&sock), &["set-option", "-g", "default-shell", &slow_s]).unwrap();
            }
            Mangle::Run
        })));
        PROMPT_WAIT_MS.store(1000, std::sync::atomic::Ordering::SeqCst);
        let first = run(&inputs(&socket));
        set_hook(None);
        assert!(matches!(first.unwrap(), RunOutcome::Ran { closed: None, .. }), "the batch stays open");
        let (state, why) = window_state(&socket, &p.id, "dev");
        assert_eq!(state, WindowState::Created, "nothing typed: not LaunchIssued");
        assert_eq!(why.as_deref(), Some("shell not ready; not started"));
        std::thread::sleep(std::time::Duration::from_millis(3500));
        assert_eq!(starts(&p, "dev"), 0, "nothing was typed ahead into the late shell");
        // The next pass sees the prompt and launches, once.
        run(&inputs(&socket)).unwrap();
        PROMPT_WAIT_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Launched);
        assert_eq!(wait_starts(&p, "dev", 1), 1);
    }

    // ---- the validator's surviving controls, pinned ---------------------------

    /// G1/G5: only the exact markers classify; a tmux error is Unknown.
    #[test]
    fn only_the_exact_markers_classify_and_an_error_is_unknown() {
        assert_eq!(classify(&format!("{OK}\n")), Outcome::Applied(String::new()));
        assert_eq!(classify(&format!("@1 %1\n{OK}\n")), Outcome::Applied("@1 %1".into()));
        assert_eq!(classify(&format!("{REFUSED}\n")), Outcome::Refused);
        for odd in ["", "OK\n", "x\n", &format!("{OK}\nx\n"), &format!("x\n{REFUSED}\n")] {
            assert!(matches!(classify(odd), Outcome::Unknown(_)), "{odd:?}");
        }
        let step = Step { op: "test", project: "g5".into(), ord: None };
        let nowhere = std::env::temp_dir().join(format!("tmm-test-nowhere-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&nowhere, "").unwrap();
        let got = guarded(&nowhere.to_string_lossy(), &step, "@0", "1", "display -p x").unwrap();
        let _ = std::fs::remove_file(&nowhere);
        assert!(matches!(got, Outcome::Unknown(_)), "an unreachable server is not a refusal: {got:?}");
    }

    /// G7/G8/G11/G10 through the PRODUCTION guard builders, on a real server.
    #[test]
    fn the_production_guards_refuse_what_they_claim_to() {
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-guards");
        let socket = server.socket().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let line = server.run(&["new-session", "-d", "-s", "own", "-e", &format!("TMM_RESTORE_BATCH={b}"), "-n", &holder_name(&b), "-P", "-F", "#{pid} #{start_time} #{session_id}"]).unwrap();
        let f: Vec<&str> = line.split_whitespace().collect();
        let inst = TmuxInstance { socket: socket.clone(), pid: f[0].parse().unwrap(), start_time: f[1].parse().unwrap() };
        let sid = f[2].to_string();
        let step = Step { op: "test", project: "guards".into(), ord: None };
        let applied = |o: Outcome| matches!(o, Outcome::Applied(_));
        // G11: a session with our env but NOT yet tagged takes no window.
        let batch = Batch {
            batch: b.clone(),
            socket: socket.clone(),
            boot_id: Some("x".into()),
            owner_pid: 0, attempt: 0,
            instance: Some(inst.clone()),
            source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![BatchProject {
                id: "own".into(), name: "own".into(), path: "/".into(), session: "own".into(), autostart_only: false,
                state: ProjectState::Open, reason: None, session_id: Some(sid.clone()), holder_id: None, op: None, finished: None, windows: vec![],
            }],
        };
        let (_, scond) = session_cond(&batch, 0).unwrap();
        assert_eq!(guarded(&socket, &step, &sid, &scond, "display -p x").unwrap(), Outcome::Refused, "G11: untagged");
        // G8: the session boot guard needs our env — a person's session refuses.
        let other = server.run(&["new-session", "-d", "-s", "theirs", "-P", "-F", "#{session_id}"]).unwrap().trim().to_string();
        assert_eq!(guarded(&socket, &step, &other, &session_boot_cond(&inst, &other, &b), "display -p x").unwrap(), Outcome::Refused, "G8");
        assert!(applied(guarded(&socket, &step, &sid, &session_boot_cond(&inst, &sid, &b), &format!("set-option -t {} @tmm_rs {b}", tmux::tmux_quote(&sid))).unwrap()));
        assert!(applied(guarded(&socket, &step, &sid, &scond, "display -p x").unwrap()), "control: tagged, it takes windows");
        // G7: the window tag installs once.
        let wid = server.run(&["new-window", "-d", "-t", &sid, "-n", &placeholder(&b, 0), "-P", "-F", "#{window_id}"]).unwrap().trim().to_string();
        let wcond = window_boot_cond(&inst, &sid, &wid, 0, &b);
        let tag = format!("set-option -w -t {wid} @tmm_rw {b}:0");
        assert!(applied(guarded(&socket, &step, &wid, &wcond, &tag).unwrap()));
        assert_eq!(guarded(&socket, &step, &wid, &wcond, &tag).unwrap(), Outcome::Refused, "G7: a second install");
        // G6: the window boot guard needs the full-uuid BIRTH name.
        let renamed = server.run(&["new-window", "-d", "-t", &sid, "-n", "not-the-birth-name", "-P", "-F", "#{window_id}"]).unwrap().trim().to_string();
        let rcond = window_boot_cond(&inst, &sid, &renamed, 1, &b);
        assert_eq!(guarded(&socket, &step, &renamed, &rcond, &format!("set-option -w -t {renamed} @tmm_rw {b}:1")).unwrap(), Outcome::Refused, "G6");
        // G10: a listing from another server is not ours to read.
        let wrong = TmuxInstance { pid: inst.pid + 1, ..inst.clone() };
        assert!(observe_windows(&socket, &sid, &wrong).is_err(), "G10");
        assert!(observe_windows(&socket, &sid, &inst).unwrap().is_some(), "control");
    }

    /// O5: a server replaced right before a claim is caught when the claim
    /// prints another server's identity — the batch closes FAILED.
    #[test]
    fn o5_a_claim_answered_by_another_server_closes_the_batch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-o5");
        let socket = server.socket().to_string();
        let a = declare("o5a", vec![shell_slot("sh1")]);
        let b = declare("o5b", vec![shell_slot("sh1")]);
        publish(&socket, &[&a, &b]);
        let (sock, bid) = (socket.clone(), b.id.clone());
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "claim" && s.project == bid {
                fired = true;
                replace_server(&sock);
                tmux::run_tmux_on(Some(&sock), &["new-session", "-d", "-s", "anchor"]).unwrap();
            }
            Mangle::Run
        })));
        let got = run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert!(matches!(got, RunOutcome::Ran { closed: Some(ref c), .. } if c.contains("tmux server restarted")), "{got:?}");
    }

    /// O7 + U5: an unseen window create is never repeated, and a window the
    /// person made under a slot's name is theirs.
    #[test]
    fn o7_u5_no_second_create_and_a_persons_window_is_skipped() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-o7");
        let socket = server.socket().to_string();
        let p = declare("o7", vec![shell_slot("sh1"), shell_slot("sh2")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "create_window", Some(0), Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        server.run(&["new-window", "-d", "-t", &format!("={}:", p.session), "-n", "sh2"]).unwrap();
        let theirs = windows(&server, &p.session).into_iter().find(|(n, _)| n == "sh2").unwrap();
        run(&inputs(&socket)).unwrap();
        assert_eq!(window_state(&socket, &p.id, "sh1"), (WindowState::Failed, Some("indeterminate: new-window".into())), "U5");
        assert!(!names(&server, &p.session).contains(&placeholder(&batch_of(&socket).batch, 0)), "U5: no second new-window");
        assert_eq!(window_state(&socket, &p.id, "sh2"), (WindowState::Skipped, Some("window exists".into())), "O7");
        assert!(windows(&server, &p.session).contains(&theirs), "O7: the person's window untouched");
    }

    /// U8: a kill whose answer is unknown and which did NOT run is never
    /// reported done: re-observed present, left in place.
    #[test]
    fn u8_an_unseen_kill_that_did_not_run_is_left_in_place() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-u8");
        let socket = server.socket().to_string();
        let p = declare("u8", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        std::fs::remove_file(p.ws.join(".tmm/agents/dev/launch.json")).unwrap();
        set_hook(Some(once(&p.id, "kill", Some(0), Mangle::Lost)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (st, why) = window_state(&socket, &p.id, "dev");
        assert_eq!(st, WindowState::Failed);
        assert!(why.unwrap_or_default().contains("left in place"));
        assert!(names(&server, &p.session).contains(&placeholder(&batch_of(&socket).batch, 0)), "not killed");
    }

    /// L6: a Stop written after the window was made and before its launch is
    /// honoured AT the door: nothing typed, the window we made is removed.
    #[test]
    fn l6_the_door_rereads_a_stop_written_after_the_window_was_made() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-l6");
        let socket = server.socket().to_string();
        let p = declare("l6", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "tag_window" && s.ord == Some(0) {
                fired = true;
                with_store(|st| st.set_slot_stopped(&pid, "dev")).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (st, why) = window_state(&socket, &p.id, "dev");
        assert_eq!(st, WindowState::Failed);
        assert_eq!(why.as_deref(), Some("the agent was stopped"));
        assert_eq!(names(&server, &p.session), ["sh1"]);
        assert_eq!(starts(&p, "dev"), 0);
    }

    /// L6 (validator, 297b5851): the door validates the declaration ITSELF,
    /// not only the step's reread before it. A down written after the step
    /// reread and before the door is honoured there: nothing typed, the
    /// window we made is removed.
    #[test]
    fn l6_a_down_written_after_the_step_reread_is_refused_at_the_door() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-l6b");
        let socket = server.socket().to_string();
        let p = declare("l6b", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let pid = p.id.clone();
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "tag_window" && s.ord == Some(0) {
                fired = true;
                with_store(|st| st.set_project_down(&pid).map(|_| ())).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (st, why) = window_state(&socket, &p.id, "dev");
        assert_eq!(st, WindowState::Failed);
        assert_eq!(why.as_deref(), Some("the project was taken down"));
        assert!(!names(&server, &p.session).contains(&"dev".to_string()));
        assert_eq!(starts(&p, "dev"), 0, "nothing typed");
    }

    /// U7 (validator, 297b5851): only an UNKNOWN tag install is redone. A
    /// REFUSED one proved its condition false (here the session's restore env
    /// was taken away), so the untagged placeholder is not ours to tag: no
    /// second install, the window fails.
    #[test]
    fn u7_a_refused_window_tag_is_not_redone() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-u7");
        let socket = server.socket().to_string();
        let p = declare("u7", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let (sock, session) = (socket.clone(), p.session.clone());
        let installs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = installs.clone();
        set_hook(Some(Box::new(move |s: &Step| {
            if s.op == "tag_window" && s.ord == Some(0) {
                if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    tmux::run_tmux_on(Some(&sock), &["set-environment", "-t", &session, "-u", "TMM_RESTORE_BATCH"]).unwrap();
                }
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (st, why) = window_state(&socket, &p.id, "sh1");
        assert_eq!(st, WindowState::Failed);
        assert_eq!(why.as_deref(), Some("the window is not ours"));
        assert_eq!(installs.load(std::sync::atomic::Ordering::SeqCst), 1, "a refused install is not redone");
    }

    /// L10: a project with nothing restored is reported NOT restored, and its
    /// session keeps one plain shell.
    #[test]
    fn l10_a_project_with_nothing_restored_is_failed_with_one_shell_left() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-l10");
        let socket = server.socket().to_string();
        let p = declare("l10", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        std::fs::remove_file(p.ws.join(".tmm/agents/dev/launch.json")).unwrap();
        run(&inputs(&socket)).unwrap();
        let (st, why) = project_state(&socket, &p.id);
        assert_eq!(st, ProjectState::Failed);
        assert!(why.unwrap_or_default().starts_with("no window could be restored"));
        let left = names(&server, &p.session);
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(!left[0].starts_with("tmm-r-"), "a plain shell: {left:?}");
    }

    /// C4: a holder left in place after a closed batch is never folded.
    #[test]
    fn c4_a_holder_left_in_place_is_not_folded() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-c4");
        let socket = server.socket().to_string();
        let p = declare("c4", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "holder_kill", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        run(&inputs(&socket)).unwrap();
        let holder = holder_name(&batch_of(&socket).batch);
        assert!(names(&server, &p.session).contains(&holder), "left in place");
        super::super::capture_once().unwrap();
        let slots: Vec<String> = with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect();
        assert!(!slots.contains(&holder), "{slots:?}");
        assert!(slots.contains(&"sh1".to_string()));
    }

    // ---- review round 2, residuals ---------------------------------------------

    /// P1-A residual: a restore that begins (or ends) while a capture tick is
    /// scanning voids that tick — no fold, no checkpoint — cross-process,
    /// because the batch is re-read inside the commit's write transaction.
    #[test]
    fn a_tick_that_scanned_under_another_batch_state_commits_nothing() {
        use super::super::capture::{TickPhase, TICK_HOOK};
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-stale");
        let socket = server.socket().to_string();
        let p = declare("stale", vec![shell_slot("sh1")]);
        let cwd = p.ws.to_string_lossy().to_string();
        server.run(&["new-session", "-d", "-s", &p.session, "-c", &cwd, "-n", "sh1"]).unwrap();
        tmux::new_named_window(&p.session, "extra", &cwd).unwrap();
        publish(&socket, &[]);
        let gen = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen;
        let slots = || with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect::<Vec<_>>();
        let before = slots();
        let fake = Batch {
            batch: uuid::Uuid::new_v4().to_string(),
            socket: socket.clone(),
            boot_id: Some("b".into()),
            owner_pid: 0, attempt: 0,
            instance: None,
            source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![],
        };
        // A batch opens mid-scan.
        let (f, sock) = (fake.clone(), socket.clone());
        *TICK_HOOK.lock().unwrap() = Some(Box::new(move |phase| {
            if phase == TickPhase::Listed {
                with_store(|s| s.save_batch(&mut f.clone())).unwrap();
            }
            let _ = &sock;
        }));
        super::super::capture_once().unwrap();
        *TICK_HOOK.lock().unwrap() = None;
        assert_eq!(slots(), before, "no fold");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint");
        // The open batch closes mid-scan.
        let f2 = fake.clone();
        *TICK_HOOK.lock().unwrap() = Some(Box::new(move |phase| {
            if phase == TickPhase::Listed {
                let mut c = f2.clone();
                c.closed = Some("done".into());
                with_store(|s| s.close_batch(&mut c.clone())).unwrap();
            }
        }));
        super::super::capture_once().unwrap();
        *TICK_HOOK.lock().unwrap() = None;
        assert_eq!(slots(), before, "no fold");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint");
        // Another connection (another gateway) opens a batch holding this
        // project just as the tick reads the batches: the tick holds the
        // project by that batch only if what it scanned and the revision it
        // commits under are one read. Were the decoded batch read apart from
        // the revision, the tick would fold the old view and its re-check
        // would pass against the new revision.
        let other = std::sync::Mutex::new(Some(crate::projects::store::Store::open(&super::super::db_path()).unwrap()));
        let mut f3 = fake.clone();
        f3.projects = vec![BatchProject {
            id: p.id.clone(),
            name: "stale".into(),
            path: cwd.clone(),
            session: p.session.clone(),
            autostart_only: false,
            state: ProjectState::Pending,
            reason: None,
            session_id: None,
            holder_id: None,
            op: None,
            finished: None,
            windows: vec![],
        }];
        *super::super::store::SCAN_HOOK.lock().unwrap() = Some(Box::new(move || {
            if let Some(mut s) = other.lock().unwrap().take() {
                s.save_batch(&mut f3.clone()).unwrap();
            }
        }));
        super::super::capture_once().unwrap();
        *super::super::store::SCAN_HOOK.lock().unwrap() = None;
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_some(), "the other gateway's batch landed");
        assert_eq!(slots(), before, "no fold");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint");
        let mut c = fake.clone();
        c.closed = Some("done".into());
        with_store(|s| s.close_batch(&mut c.clone())).unwrap();
        // Control: an undisturbed tick commits.
        super::super::capture_once().unwrap();
        assert!(slots().contains(&"extra".to_string()));
        assert!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen > gen);
    }

    /// P1-B residual: a launch uses the ONE row it validated; a rename after
    /// that point does not leak into what is typed — the staged line carries
    /// the frozen identity.
    #[test]
    fn a_launch_carries_the_identity_it_validated() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-row");
        let socket = server.socket().to_string();
        let p = declare("row", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        let (pid, old) = (p.id.clone(), p.session.clone());
        let new_name = format!("{old}-renamed");
        let nn = new_name.clone();
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            // Between the validation and the recipe/identity/staging built from it.
            if !fired && s.op == "door" {
                fired = true;
                with_store(|st| st.set_session(&pid, &nn, &old)).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let script = std::fs::read_to_string(p.ws.join(".tmm/agents/dev/launch-dev.sh")).unwrap();
        assert!(script.contains(&format!("TMM_PROJECT={}", p.session)), "{script}");
        assert!(!script.contains(&new_name), "no mixed identity: {script}");
    }

    /// The in-server name guard on window creation: a window of the slot's
    /// name that appears between the Rust read and the create makes the
    /// create Refused — never a second window of that name.
    #[test]
    fn a_same_name_window_appearing_before_the_create_is_the_persons() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-name");
        let socket = server.socket().to_string();
        let p = declare("name", vec![shell_slot("sh1"), shell_slot("sh2")]);
        publish(&socket, &[&p]);
        let (sock, session) = (socket.clone(), p.session.clone());
        let mut fired = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !fired && s.op == "create_window" && s.ord == Some(1) {
                fired = true;
                tmux::run_tmux_on(Some(&sock), &["new-window", "-d", "-t", &format!("={session}:"), "-n", "sh2"]).unwrap();
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &p.id, "sh2"), (WindowState::Skipped, Some("window exists".into())));
        assert_eq!(names(&server, &p.session), ["sh1", "sh2"], "one sh2: the person's");
    }

    /// P2: a holder no longer provably ours (renamed by a person) is left as
    /// it is and the project closes — not kept open, not killed.
    #[test]
    fn a_holder_a_person_took_over_is_left_and_the_project_closes() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-hforeign");
        let socket = server.socket().to_string();
        let p = declare("hf", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "holder_kill", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let hid = batch_of(&socket).projects[0].holder_id.clone().unwrap();
        server.run(&["rename-window", "-t", &hid, "mine"]).unwrap();
        run(&inputs(&socket)).unwrap();
        let (st, why) = project_state(&socket, &p.id);
        assert_eq!(st, ProjectState::Done);
        assert!(why.unwrap_or_default().contains("no longer ours"));
        assert!(names(&server, &p.session).contains(&"mine".to_string()), "the person's window survives");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "the batch closed");
    }

    // ---- T10: one owner ----------------------------------------------------

    #[test]
    fn t10_a_second_owner_is_busy_and_does_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t10");
        let socket = server.socket().to_string();
        let p = declare("t10", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let held = OwnerLock::try_acquire().unwrap().expect("the lock is free");
        assert_eq!(run(&inputs(&socket)).unwrap(), RunOutcome::Busy);
        assert!(names(&server, &p.session).is_empty(), "nothing was created");
        drop(held);
        assert!(matches!(run(&inputs(&socket)).unwrap(), RunOutcome::Ran { .. }), "control: free again, it runs");
        assert_eq!(names(&server, &p.session), ["sh1"]);
    }

    // ---- T9 + T17: the owner dies; a successor continues from the batch ----

    #[test]
    fn t9_t17_an_owner_that_dies_is_continued_from_the_batch_alone() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t9");
        let socket = server.socket().to_string();
        let a = declare("t9a", vec![agent_slot("dev")]);
        let b = declare("t9b", vec![agent_slot("dev")]);
        publish(&socket, &[&a, &b]);
        let db = std::env::var("TMM_STATE_DB").unwrap();
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "projects::restore_run::tests::restore_owner_child", "--ignored", "--test-threads=1", "--nocapture"])
            .env("TMM_TEST_CHILD_DB", &db)
            .env("TMM_R2_SOCKET", &socket)
            .env("TMM_R2_ABORT_AT", &b.id)
            .output()
            .unwrap();
        // The child's whole output rides on every assertion that follows: its
        // stderr is where tmux warnings go (the evidence ad4fdc1c lost).
        let child = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(!out.status.success(), "the child owner died mid-batch:\n{child}");
        assert_eq!(project_state(&socket, &a.id).0, ProjectState::Done, "A was finished by the dead owner:\n{child}");
        assert_eq!(project_state(&socket, &b.id).0, ProjectState::Pending, "{child}");
        let a_before = windows(&server, &a.session);
        assert_eq!(wait_starts(&a, "dev", 1), 1, "A's CLI started:\n{child}");
        // T17: a new checkpoint lands while the batch is open; it is not the source.
        with_store(|s| s.commit_tick(&[], Some((&socket, Checkpoint { gen: 0, at: 2, boot_id: Some("boot-after".into()), tmux: None, projects: vec![] })))).unwrap();

        let got = run(&inputs(&socket)).unwrap();
        assert!(matches!(got, RunOutcome::Ran { closed: Some(ref c), .. } if c == "done"), "{got:?}");
        assert_eq!(names(&server, &b.session), ["dev"], "the successor created B from the batch");
        assert_eq!(wait_starts(&b, "dev", 1), 1);
        assert_eq!(windows(&server, &a.session), a_before, "A untouched: same panes");
        assert_eq!(starts(&a, "dev"), 1, "and never retyped");
    }

    /// The child half of `t9_t17_…`: runs the owner and ABORTS (the OS frees
    /// the lock) when it reaches the named project. Ignored on its own.
    #[test]
    #[ignore]
    fn restore_owner_child() {
        use_test_store();
        let socket = std::env::var("TMM_R2_SOCKET").expect("run by the parent");
        let at = std::env::var("TMM_R2_ABORT_AT").unwrap();
        set_hook(Some(once(&at, "project", None, Mangle::Abort)));
        let _ = run(&inputs(&socket));
        panic!("the abort did not happen");
    }

    // ---- B1: the claim ran, its answer was not recorded ------------------

    #[test]
    fn b1_a_session_made_but_not_recorded_is_recognised_by_its_env() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-b1");
        let socket = server.socket().to_string();
        let p = declare("b1", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "claim", None, Mangle::RunThenHalt)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(project_state(&socket, &p.id).0, ProjectState::CreatingSession);
        assert_eq!(batch_of(&socket).instance, None, "nothing about the session was recorded");
        assert_eq!(names(&server, &p.session).len(), 1, "but the session (its holder) exists");

        run(&inputs(&socket)).unwrap();
        assert_eq!(project_state(&socket, &p.id).0, ProjectState::Done);
        assert_eq!(names(&server, &p.session), ["dev"], "one session, continued — no second new-session");
        assert_eq!(wait_starts(&p, "dev", 1), 1);
    }

    // ---- B2: our session gone, a same-name one is the person's ------------

    #[test]
    fn b2_a_same_name_session_after_ours_vanished_is_not_ours() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-b2");
        let socket = server.socket().to_string();
        let p = declare("b2", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        // An unrelated session keeps the SAME server alive across the kill.
        server.run(&["new-session", "-d", "-s", "anchor"]).unwrap();
        set_hook(Some(once(&p.id, "create_window", Some(0), Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        server.run(&["kill-session", "-t", &format!("={}:", p.session)]).unwrap();
        server.run(&["new-session", "-d", "-s", &p.session, "-n", "mine"]).unwrap();
        let before = windows(&server, &p.session);

        run(&inputs(&socket)).unwrap();
        assert_eq!(windows(&server, &p.session), before, "the person's session is untouched");
        assert_eq!(starts(&p, "dev"), 0);
        assert_eq!(project_state(&socket, &p.id).0, ProjectState::Failed);
        assert!(batch_of(&socket).closed.as_deref().is_some_and(|c| c.starts_with("done")), "the same server: the batch ends normally");
    }

    // ---- B3: the server is replaced mid-batch ------------------------------

    #[test]
    fn b3_an_instance_change_closes_the_batch_failed_and_touches_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-b3");
        let socket = server.socket().to_string();
        let a = declare("b3a", vec![shell_slot("sh1")]);
        let b = declare("b3b", vec![shell_slot("sh1")]);
        publish(&socket, &[&a, &b]);
        set_hook(Some(once(&b.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        replace_server(&socket);
        server.run(&["new-session", "-d", "-s", &a.session, "-n", "theirs"]).unwrap();
        let before = windows(&server, &a.session);

        let got = run(&inputs(&socket)).unwrap();
        assert!(matches!(got, RunOutcome::Ran { closed: Some(ref c), .. } if c.contains("tmux server restarted")), "{got:?}");
        assert_eq!(windows(&server, &a.session), before);
        assert!(names(&server, &b.session).is_empty(), "B was not created on the new server");
    }

    // ---- B3b: a server replaced between the read and each write ------------

    #[test]
    fn b3b_a_server_replaced_before_a_write_refuses_it_in_server() {
        use_test_store();
        for op in ["create_window", "tag_window", "launch", "rename", "kill"] {
            let scope = GlobalSocket::hold();
            let server = PrivateTmux::start(&scope, &format!("r2-b3b-{op}"));
            let socket = server.socket().to_string();
            let p = declare("b3b", vec![agent_slot("dev")]);
            publish(&socket, &[&p]);
            if op == "kill" {
                // The door refuses (recipe gone AFTER the plan) → the kill path.
                set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
                run(&inputs(&socket)).unwrap();
                std::fs::remove_file(p.ws.join(".tmm/agents/dev/launch.json")).unwrap();
            }
            let (sock, session) = (socket.clone(), p.session.clone());
            let mut fired = false;
            set_hook(Some(Box::new(move |s: &Step| {
                if !fired && s.op == op {
                    fired = true;
                    // The new server holds a same-name session whose first
                    // window reuses @0/%0 — exactly the ids we recorded.
                    replace_server(&sock);
                    tmux::run_tmux_on(Some(&sock), &["new-session", "-d", "-s", &session, "-n", "theirs"]).unwrap();
                }
                Mangle::Run
            })));
            let _ = run(&inputs(&socket));
            set_hook(None);
            assert_eq!(names(&server, &p.session), ["theirs"], "{op}: nothing added, renamed or killed on the new server");
            let screen = server.run(&["capture-pane", "-p", "-t", &format!("={}:theirs", p.session)]).unwrap_or_default();
            assert!(!screen.contains("launch-dev") && !screen.contains("fake.sh"), "{op}: nothing typed: {screen}");
            // Only the rename comes after the (old server's) launch, which the
            // server's destruction may kill before the fake counts; the new
            // server never gets one.
            assert!(starts(&p, "dev") <= u32::from(op == "rename"), "{op}: no launch on the new server");
            assert_ne!(window_state(&socket, &p.id, "dev").0, WindowState::Launched, "{op}: never reported launched");
            drop(server);
        }
    }

    // ---- B4/B5b: a placeholder made but not recorded ------------------------

    #[test]
    fn b4_an_unrecorded_placeholder_is_adopted_and_launched_once() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-b4");
        let socket = server.socket().to_string();
        let p = declare("b4", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "create_window", Some(0), Mangle::RunThenHalt)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::Creating);
        run(&inputs(&socket)).unwrap();
        assert_eq!(names(&server, &p.session), ["dev"], "one window: never a second new-window");
        assert_eq!(wait_starts(&p, "dev", 1), 1, "one launch");
    }

    // ---- B5a: the launch was typed, `launched` not recorded -----------------

    #[test]
    fn b5a_an_issued_launch_is_never_touched_again() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-b5a");
        let socket = server.socket().to_string();
        let p = declare("b5a", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "launch", Some(0), Mangle::RunThenHalt)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(wait_starts(&p, "dev", 1), 1, "the fake CLI really started");
        let before = windows(&server, &p.session);
        let cli_pids = std::fs::read_to_string(p.ws.join(".tmm/agents/dev/fake.sh.log")).unwrap();

        run(&inputs(&socket)).unwrap();
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::LaunchUnknown);
        assert_eq!(windows(&server, &p.session).iter().filter(|(n, _)| n.starts_with("tmm-r-")).count(), 1, "the window is left, under its placeholder name");
        let after = windows(&server, &p.session);
        assert!(before.iter().filter(|(n, _)| n.ends_with("-0")).all(|w| after.contains(w)), "same pane pid");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(starts(&p, "dev"), 1, "never retyped");
        assert_eq!(std::fs::read_to_string(p.ws.join(".tmm/agents/dev/fake.sh.log")).unwrap(), cli_pids, "the same CLI process");
        // A third pass: the closed batch leaves it as it is.
        run(&inputs(&socket)).unwrap();
        assert_eq!(starts(&p, "dev"), 1);
    }

    // ---- R1: answers lost --------------------------------------------------

    #[test]
    fn r1_a_lost_answer_is_re_observed_never_redone_blind() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-r1");
        let socket = server.socket().to_string();
        let p = declare("r1", vec![agent_slot("dev"), agent_slot("ops")]);
        publish(&socket, &[&p]);
        // dev: the create's AND the tag's answers are dropped; both ran.
        let mut seen = 0;
        set_hook(Some(Box::new(move |s: &Step| {
            if s.ord == Some(0) && (s.op == "create_window" || s.op == "tag_window") && seen < 2 {
                seen += 1;
                return Mangle::DropReceipt;
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(names(&server, &p.session), ["dev", "ops"], "re-observed and continued: one window each");
        assert_eq!(wait_starts(&p, "dev", 1), 1);
        assert_eq!(wait_starts(&p, "ops", 1), 1);
    }

    #[test]
    fn r1_a_kill_whose_answer_is_unknown_is_never_issued_twice() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-r1k");
        let socket = server.socket().to_string();
        let p = declare("r1k", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        std::fs::remove_file(p.ws.join(".tmm/agents/dev/launch.json")).unwrap();
        // The owner records the kill as issued and dies before running it.
        set_hook(Some(once(&p.id, "kill", Some(0), Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let b = batch_of(&socket);
        let dev = b.projects.iter().find(|q| q.id == p.id).unwrap().windows.iter().find(|w| w.name == "dev").unwrap().clone();
        assert_eq!(dev.op, Some(BatchOp::Kill), "the issued kill is on record");
        // The successor re-observes: present → left in place, never killed.
        run(&inputs(&socket)).unwrap();
        let (state, reason) = window_state(&socket, &p.id, "dev");
        assert_eq!(state, WindowState::Failed);
        assert!(reason.unwrap_or_default().contains("left in place"));
        let placeholder_left = names(&server, &p.session).into_iter().filter(|n| n.starts_with("tmm-r-") && !n.ends_with("holder")).count();
        assert_eq!(placeholder_left, 1, "the window was not killed by the successor");
        // And a third owner neither.
        run(&inputs(&socket)).unwrap();
        assert_eq!(names(&server, &p.session).into_iter().filter(|n| n.starts_with("tmm-r-") && !n.ends_with("holder")).count(), 1);
        assert_eq!(starts(&p, "dev"), 0, "nothing typed into it");
    }

    /// Control for the above: a kill that RAN but whose answer was lost is
    /// re-observed as done — the window is gone, and it was killed once.
    #[test]
    fn r1_a_kill_that_ran_with_its_answer_lost_is_observed_done() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-r1k2");
        let socket = server.socket().to_string();
        let p = declare("r1k2", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        std::fs::remove_file(p.ws.join(".tmm/agents/dev/launch.json")).unwrap();
        set_hook(Some(once(&p.id, "kill", Some(0), Mangle::DropReceipt)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let (state, reason) = window_state(&socket, &p.id, "dev");
        assert_eq!(state, WindowState::Failed);
        assert!(!reason.unwrap_or_default().contains("left in place"));
        assert_eq!(names(&server, &p.session), ["sh1"]);
    }

    // ---- R2: the text was sent, the Enter was not ----------------------------

    #[test]
    fn r2_text_without_enter_is_launch_unknown_and_the_cli_never_started() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-r2");
        let socket = server.socket().to_string();
        let p = declare("r2", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "launch", Some(0), Mangle::TextOnly)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &p.id, "dev").0, WindowState::LaunchUnknown);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(starts(&p, "dev"), 0, "the Enter never ran: the CLI never started");
        let before = windows(&server, &p.session);
        run(&inputs(&socket)).unwrap();
        assert_eq!(windows(&server, &p.session), before, "never retyped or killed");
        assert_eq!(starts(&p, "dev"), 0);
    }

    // ---- R3: the bootstrap guards, in-server -------------------------------

    #[test]
    fn r3_bootstrap_guards_refuse_a_second_install_and_a_foreign_object() {
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-r3");
        let socket = server.socket().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let env = format!("TMM_RESTORE_BATCH={b}");
        let line = server.run(&["new-session", "-d", "-s", "own", "-e", &env, "-n", &holder_name(&b), "-P", "-F", "#{pid} #{start_time} #{session_id}"]).unwrap();
        let f: Vec<&str> = line.split_whitespace().collect();
        let inst = TmuxInstance { socket: socket.clone(), pid: f[0].parse().unwrap(), start_time: f[1].parse().unwrap() };
        let sid = f[2].to_string();
        let step = Step { op: "test", project: "r3".into(), ord: None };
        let session_boot = |sid: &str| {
            let mut parts = instance_parts(&inst);
            parts.extend([eq("session_id", sid), eq("TMM_RESTORE_BATCH", &b), eq("@tmm_rs", "")]);
            all(parts)
        };
        let tag = format!("set-option -t {} @tmm_rs {}", tmux::tmux_quote(&sid), b);
        assert!(matches!(guarded(&socket, &step, &sid, &session_boot(&sid), &tag).unwrap(), Outcome::Applied(_)));
        assert_eq!(guarded(&socket, &step, &sid, &session_boot(&sid), &tag).unwrap(), Outcome::Refused, "a second install is refused");
        // A session without our env (the person's) refuses the same guard.
        let other = server.run(&["new-session", "-d", "-s", "theirs", "-P", "-F", "#{session_id}"]).unwrap().trim().to_string();
        let tag2 = format!("set-option -t {} @tmm_rs {}", tmux::tmux_quote(&other), b);
        assert_eq!(guarded(&socket, &step, &other, &session_boot(&other), &tag2).unwrap(), Outcome::Refused);
        assert_eq!(server.run(&["display", "-p", "-t", &other, "#{@tmm_rs}"]).unwrap().trim(), "", "not tagged");
        // A placeholder-named window in the person's session is not ours either.
        let wid = server.run(&["new-window", "-d", "-t", &other, "-n", &placeholder(&b, 0), "-P", "-F", "#{window_id}"]).unwrap().trim().to_string();
        let mut wparts = instance_parts(&inst);
        wparts.extend([eq("window_id", &wid), eq("window_name", &placeholder(&b, 0)), eq("TMM_RESTORE_BATCH", &b), eq("@tmm_rs", &b), eq("@tmm_rw", "")]);
        assert_eq!(guarded(&socket, &step, &wid, &all(wparts), &format!("kill-window -t {wid}")).unwrap(), Outcome::Refused);
        assert!(server.run(&["has-session", "-t", "=theirs:"]).is_ok());
        assert_eq!(names(&server, "theirs").len(), 2, "nothing killed");
        // A wrong server identity refuses even on our own session.
        let mut wrong = vec![eq("pid", "1"), eq("start_time", &inst.start_time.to_string())];
        wrong.push(eq("session_id", &sid));
        assert_eq!(guarded(&socket, &step, &sid, &all(wrong), "kill-session").unwrap(), Outcome::Refused);
        assert!(server.run(&["has-session", "-t", "=own:"]).is_ok());
    }

    // ---- T19 (door) and B6 (acts after the plan) ----------------------------

    #[test]
    fn t19_b6_the_door_and_the_reread_refuse_what_changed_after_the_plan() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t19");
        let socket = server.socket().to_string();
        let a = declare("t19a", vec![agent_slot("gone"), agent_slot("ok"), shell_slot("sh1")]);
        let downed = declare("t19d", vec![shell_slot("sh1")]);
        let stopped = declare("t19s", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&a, &downed, &stopped]);
        // The batch is written; then a person acts before the owner gets there.
        set_hook(Some(once(&a.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        std::fs::remove_file(a.ws.join(".tmm/agents/gone/launch.json")).unwrap();
        with_store(|s| s.set_project_down(&downed.id)).unwrap();
        with_store(|s| s.set_slot_stopped(&stopped.id, "dev")).unwrap();

        run(&inputs(&socket)).unwrap();
        let (st, why) = window_state(&socket, &a.id, "gone");
        assert_eq!(st, WindowState::Failed);
        assert!(why.as_deref().unwrap_or_default().contains("managed home is missing"), "{why:?}");
        assert_eq!(names(&server, &a.session), ["ok", "sh1"], "the refused window was killed (ours, nothing typed); the others came back");
        assert_eq!(project_state(&socket, &downed.id), (ProjectState::Skipped, Some("the project was taken down".into())));
        assert!(names(&server, &downed.session).is_empty());
        assert_eq!(window_state(&socket, &stopped.id, "dev").0, WindowState::Skipped);
        assert_eq!(names(&server, &stopped.session), ["sh1"]);
        assert_eq!(starts(&stopped, "dev"), 0);
    }

    #[test]
    fn the_strict_door_never_falls_back() {
        let ws = std::env::temp_dir().join(format!("tmm-r2-door-{}", uuid::Uuid::new_v4().simple()));
        let ws_s = ws.to_string_lossy().to_string();
        fake_agent(&ws, "dev");
        let door = |slot: &Slot, managed| super::super::reconcile::slot_command_exact(&ws_s, slot, managed);
        assert!(door(&agent_slot("dev"), true).unwrap().unwrap().contains("--resume conv-dev"), "control");
        let mut no_id = agent_slot("dev");
        no_id.agent_session_id = Some("  ".into());
        assert!(door(&no_id, true).is_err(), "an empty id is refused");
        assert!(door(&agent_slot("nohome"), true).is_err(), "no managed home");
        // An adopted window: only a CLI with an exact resume_id.
        let mut adopted = agent_slot("x");
        adopted.command = Some("dsh".into());
        assert!(door(&adopted, false).is_err(), "dsh has no generic exact resume");
        adopted.command = Some("claude".into());
        assert_eq!(door(&adopted, false).unwrap().as_deref(), Some("claude --resume conv-x"));
        // Review P1-E: the id is ONE quoted data argument, never shell source;
        // a recent selector is refused.
        adopted.agent_session_id = Some("a b;touch /tmp/x".into());
        assert_eq!(door(&adopted, false).unwrap().as_deref(), Some("claude --resume 'a b;touch /tmp/x'"));
        adopted.agent_session_id = Some("--continue".into());
        assert!(door(&adopted, false).is_err());
        assert_eq!(door(&shell_slot("sh1"), false).unwrap(), None, "a shell replays nothing");
        // A managed kiro recipe whose conversation kiro's own store does not
        // hold: refused, never the manual `--resume-id`/`--resume` line.
        let kiro_home = ws.join(".tmm/agents/kdev");
        std::fs::create_dir_all(&kiro_home).unwrap();
        std::fs::write(kiro_home.join("launch.json"), r#"{"backend":"kiro","cmd":"command kiro-cli chat --agent kdev"}"#).unwrap();
        let mut kdev = agent_slot("kdev");
        kdev.command = Some("kiro".into());
        assert!(door(&kdev, true).is_err(), "kiro with no stored conversation");
        // A recipe naming an unknown backend.
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), r#"{"backend":"nope","cmd":"x"}"#).unwrap();
        assert!(door(&agent_slot("dev"), true).is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }

    // ---- T11: capture while a batch is open, and after ---------------------

    #[test]
    fn t11_capture_leaves_a_restoring_project_and_every_placeholder_alone() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-t11");
        let socket = server.socket().to_string();
        let p = declare("t11", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "create_window", Some(1), Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let gen = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen;
        let slots_before = with_store(|s| s.slots(&p.id)).unwrap();
        super::super::capture_once().unwrap();
        assert_eq!(with_store(|s| s.slots(&p.id)).unwrap(), slots_before, "a half-built session prunes nothing");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint while restoring");

        run(&inputs(&socket)).unwrap();
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "closed");
        super::super::capture_once().unwrap();
        let cp = with_store(|s| s.checkpoint(&socket)).unwrap().unwrap();
        assert!(cp.gen > gen, "control: published again after the close");
        let slots: Vec<String> = with_store(|s| s.slots(&p.id)).unwrap().into_iter().map(|s| s.window_name).collect();
        assert!(!slots.iter().any(|n| n.starts_with("tmm-r-")), "no placeholder became a slot: {slots:?}");
        // A launch_unknown placeholder after the close is not folded either.
        let q = declare("t11q", vec![agent_slot("dev")]);
        publish(&socket, &[&q]);
        with_store(|s| { let mut l = s.last_batch(&socket)?.unwrap(); l.boot_id = Some("older".into()); s.close_batch(&mut l.clone()) }).unwrap();
        set_hook(Some(once(&q.id, "launch", Some(0), Mangle::TextOnly)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        assert_eq!(window_state(&socket, &q.id, "dev").0, WindowState::LaunchUnknown);
        super::super::capture_once().unwrap();
        let qslots: Vec<String> = with_store(|s| s.slots(&q.id)).unwrap().into_iter().map(|s| s.window_name).collect();
        assert!(!qslots.iter().any(|n| n.starts_with("tmm-r-")), "{qslots:?}");
        assert!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().projects.iter().all(|p| p.windows.iter().all(|w| !w.name.starts_with("tmm-r-"))));
    }

    // ---- a second reboot during a batch ----------------------------------

    #[test]
    fn a_second_reboot_mid_batch_closes_it_failed_and_plans_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r2-reboot2");
        let socket = server.socket().to_string();
        let p = declare("rb2", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let mut later = inputs(&socket);
        later.boot_now = Some("boot-third".into());
        let got = run(&later).unwrap();
        assert!(matches!(got, RunOutcome::Ran { closed: Some(ref c), .. } if c.contains("host rebooted")), "{got:?}");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none());
        assert!(names(&server, &p.session).is_empty(), "nothing re-planned automatically");
    }

    // ---- round 4: the manual doors ---------------------------------------

    fn store_dump() -> String {
        with_store(|s| s.dump_for_test(&["meta", "restore_holds", "hub_msgs", "projects", "slots"])).unwrap()
    }

    /// A test's own config.toml for its duration; the one before comes back.
    struct ConfigFor(std::path::PathBuf, Option<String>);
    impl ConfigFor {
        fn test(text: &str) -> Self {
            let path = crate::config::config_dir().join("config.toml");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let before = std::fs::read_to_string(&path).ok();
            std::fs::write(&path, text).unwrap();
            ConfigFor(path, before)
        }
    }
    impl Drop for ConfigFor {
        fn drop(&mut self) {
            match &self.1 {
                Some(t) => std::fs::write(&self.0, t).unwrap(),
                None => {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
        }
    }

    /// T12a: `tmm project restore` reads only — the plan from the latest
    /// checkpoint with each reason, then an open batch, then this boot's last
    /// closed one — and writes nothing (the store's rows identical) and
    /// creates nothing in tmux.
    #[test]
    fn the_read_only_restore_shows_its_source_and_writes_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-show");
        let socket = server.socket().to_string();
        let p = declare("r4show", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let before = store_dump();
        let v = show(&socket, Some("boot-after"), false, false).unwrap();
        assert_eq!(store_dump(), before, "the plan read wrote nothing");
        assert!(names(&server, &p.session).is_empty(), "and made nothing");
        assert_eq!((v["source"].as_str(), v["restore_on_start"].as_bool()), (Some("plan"), Some(false)), "{v}");
        let plan = v["plan"]["projects"].as_array().unwrap();
        assert!(plan.iter().any(|q| q["session"] == p.session.as_str()), "{v}");
        // An open batch is what a run continues.
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let before = store_dump();
        let v = show(&socket, Some("boot-after"), true, false).unwrap();
        assert_eq!(store_dump(), before);
        assert_eq!(v["source"], "open", "{v}");
        assert_eq!(v["batch"]["projects"][0]["windows"][0]["name"], "dev", "{v}");
        // Closed: this boot's last batch; another boot's is not shown.
        let mut b = batch_of(&socket);
        close(&mut b, "done").unwrap();
        assert_eq!(show(&socket, Some("boot-after"), true, false).unwrap()["source"], "last");
        assert_eq!(show(&socket, Some("boot-next"), true, false).unwrap()["source"], "plan");
    }

    /// M3/M6 (revision 1): `--run` is admitted under the lock, saves its batch
    /// and answers BEFORE any window exists; the continuation then runs it in
    /// the background with the switch OFF, which governs only the automatic
    /// start. The admitted continuation is the batch's only consumer.
    #[test]
    fn a_manual_run_is_admitted_first_and_its_continuation_runs_with_the_switch_off() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-run");
        let socket = server.socket().to_string();
        let p = declare("r4run", vec![agent_slot("dev"), shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        assert_eq!((a.mode, a.batch.attempt), ("new", 1));
        assert!(names(&server, &p.session).is_empty(), "admitted, nothing made yet");
        assert_eq!(batch_of(&socket).batch, a.batch.batch, "the batch is saved before the answer");
        assert_eq!(holds(&socket, &p).len(), 1, "with a planned hold for the agent slot");
        assert_eq!(admit_manual(&socket, Some("boot-after"), false).err().as_deref(), Some(BUSY), "the lease is the admission's");
        let mut off = inputs(&socket);
        off.enabled = false;
        assert_eq!(continue_schedule(off, Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!(names(&server, &p.session), ["dev", "sh1"], "the switch off did not stop it");
        assert!(batch_of(&socket).closed.is_some());
    }

    /// M4 + continue (revision 1): a continuation consumes only the (batch,
    /// attempt) it was admitted with. `--abandon` between two passes closes
    /// the batch FAILED, writes nothing in tmux and leaves the holds; the old
    /// continuation's next pass then does nothing and opens nothing. A person
    /// continuing an open batch makes a new attempt: the schedule that ran it
    /// before stops, and its give-up cannot close the new attempt.
    #[test]
    fn a_continuation_consumes_only_its_admitted_attempt_and_stops_after_abandon() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-abandon");
        let socket = server.socket().to_string();
        let p = declare("r4ab", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        // The automatic start's batch, attempt 0, halted before its project.
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let auto = batch_of(&socket);
        let first = Admitted { batch: auto.batch.clone(), attempt: 0 };
        // A person continues it: a new attempt; the old schedule stops.
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        assert_eq!((a.mode, a.batch.batch.as_str(), a.batch.attempt), ("continue", auto.batch.as_str(), 1));
        drop(a.lease);
        assert!(matches!(resume(&socket, &first).unwrap(), RunOutcome::Nothing(_)), "attempt 0 is no longer admitted");
        assert_eq!(give_up(&inputs(&socket), &auto.batch, Some(0), "test").unwrap(), ScheduleEnd::Finished, "nor can it give the new attempt up");
        assert!(batch_of(&socket).closed.is_none(), "untouched");
        // Abandoned between two passes of attempt 1.
        let second = Admitted { batch: auto.batch.clone(), attempt: 1 };
        let held = holds(&socket, &p);
        let before = names(&server, &p.session);
        assert_eq!(abandon(&socket).unwrap().as_deref(), Some(auto.batch.as_str()));
        assert_eq!(batch_of(&socket).closed.as_deref(), Some(ABANDONED));
        assert_eq!(holds(&socket, &p), held, "holds stay");
        assert!(matches!(resume(&socket, &second).unwrap(), RunOutcome::Nothing(_)));
        assert_eq!(names(&server, &p.session), before, "no tmux write");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "nothing reopened");
        assert_eq!(abandon(&socket).unwrap(), None, "idempotent");
    }

    /// M5: an unknown boot refuses `--run` (show and abandon work); a held
    /// lock refuses run and abandon; an open batch of another boot is closed
    /// FAILED and the run plans afresh; an unknown action is refused.
    #[test]
    fn the_manual_doors_refuse_an_unknown_boot_a_held_lock_and_an_unknown_action() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-refuse");
        let socket = server.socket().to_string();
        let p = declare("r4ref", vec![shell_slot("sh1")]);
        publish(&socket, &[&p]);
        let before = store_dump();
        let e = admit_manual(&socket, None, false).err().unwrap();
        assert!(e.contains("boot identity is unknown"), "{e}");
        assert_eq!(store_dump(), before, "nothing written");
        assert!(show(&socket, None, true, false).is_ok());
        assert_eq!(abandon(&socket).unwrap(), None);
        {
            let _other = OwnerLock::try_acquire().unwrap().unwrap();
            assert_eq!(admit_manual(&socket, Some("boot-after"), false).err().as_deref(), Some(BUSY));
            assert_eq!(abandon(&socket).err().as_deref(), Some(BUSY));
        }
        // Another boot's open batch.
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let old = batch_of(&socket).batch;
        let a = admit_manual(&socket, Some("boot-next"), false).unwrap();
        assert_eq!(a.mode, "new");
        assert_ne!(a.batch.batch, old);
        assert!(with_store(|s| s.last_batch(&socket)).unwrap().unwrap().closed.unwrap().contains("host rebooted"));
        drop(a);
        assert!(restore_rpc("bogus").err().unwrap().contains("unknown restore action"));
        assert!(names(&server, &p.session).is_empty());
    }

    /// Rewrite the socket's stored last batch (a fixture's way to put its
    /// windows in the states the retry table names).
    fn edit_last(socket: &str, f: impl FnOnce(&mut Batch)) {
        let mut b = with_store(|s| s.last_batch(socket)).unwrap().expect("a closed batch");
        f(&mut b);
        let json = serde_json::to_string(&b).unwrap().replace('\'', "''");
        with_store(|s| s.exec_test_sql(&format!("UPDATE meta SET value = '{json}' WHERE key = 'restore_last:{socket}'"))).unwrap();
    }

    fn pane_pid_of(server: &PrivateTmux, session: &str, window: &str) -> String {
        server.run(&["display-message", "-p", "-t", &format!("={session}:{window}"), "#{pane_pid}"]).unwrap().trim().to_string()
    }

    /// M1 (revision 1's per-window table): a same-boot retry reopens the
    /// closed batch under its OWN uuid as a new attempt, and rebuilds only
    /// what was never typed into and is confirmed gone. A LaunchUnknown agent
    /// and a typed-then-Failed shell are left alone (no send-keys, no kill:
    /// the agent's process is the same); a Failed window with no `typed`
    /// record (legacy) is not proof of "never typed"; an issued kill whose
    /// pane is still there is re-observed, never sent again; a pane that
    /// cannot be checked is not "gone".
    #[test]
    fn a_retry_rebuilds_only_untyped_windows_confirmed_gone_and_never_retouches_a_launch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-retry");
        let socket = server.socket().to_string();
        let p = declare("r4retry", vec![agent_slot("a1"), shell_slot("s1"), shell_slot("s2"), shell_slot("s3"), shell_slot("s4"), shell_slot("s5")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let done = with_store(|s| s.last_batch(&socket)).unwrap().expect("closed");
        assert_eq!(names(&server, &p.session), ["a1", "s1", "s2", "s3", "s4", "s5"]);
        // The typed fact as the executor writes it: the agent's launch line
        // was typed (written ahead of it); a plain shell got nothing typed.
        let typed = |n: &str| done.projects[0].windows.iter().find(|w| w.name == n).unwrap().typed;
        assert_eq!((typed("a1"), typed("s1")), (Some(true), Some(false)));
        let agent_pid = pane_pid_of(&server, &p.session, "a1");
        let s4_pid = pane_pid_of(&server, &p.session, "s4");
        for gone in ["s1", "s2", "s3", "s5"] {
            server.run(&["kill-window", "-t", &format!("={}:{gone}", p.session)]).unwrap();
        }
        let set = |w: &mut BatchWindow, state: WindowState, typed: Option<bool>, op: Option<BatchOp>| {
            w.state = state;
            w.typed = typed;
            w.op = op;
            w.reason = Some("fixture".into());
        };
        edit_last(&socket, |b| {
            let pr = &mut b.projects[0];
            pr.state = ProjectState::Failed;
            for w in pr.windows.iter_mut() {
                match w.name.as_str() {
                    "a1" => set(w, WindowState::LaunchUnknown, Some(true), None),
                    "s1" => set(w, WindowState::Failed, Some(true), None),
                    "s2" => set(w, WindowState::Failed, Some(false), None),
                    "s3" => {
                        set(w, WindowState::Pending, Some(false), None);
                        (w.window_id, w.pane_id, w.pane_pid) = (None, None, None);
                    }
                    "s4" => set(w, WindowState::Created, Some(false), Some(BatchOp::Kill)),
                    _ => set(w, WindowState::Failed, None, None),
                }
            }
        });
        // A pane that cannot be checked is not gone: nothing rebuilt.
        let last = with_store(|s| s.last_batch(&socket)).unwrap().unwrap();
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(true));
        let (blind, _) = retry_batch(&socket, last).unwrap().unwrap();
        super::super::restore_hold::LIST_FAILS.with(|f| f.set(false));
        assert_eq!(blind.projects[0].windows[2].state, WindowState::Failed, "s2 unconfirmed stays Failed");
        // The retry itself.
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        assert_eq!((a.mode, a.batch.batch.as_str(), a.batch.attempt), ("retry", done.batch.as_str(), 1), "its own uuid, a new attempt");
        assert!(with_store(|s| s.last_batch(&socket)).unwrap().is_none(), "it is the open batch now");
        let st = |b: &Batch, n: &str| b.projects[0].windows.iter().find(|w| w.name == n).map(|w| (w.state, w.op)).unwrap();
        assert_eq!(st(&a.batch, "a1"), (WindowState::LaunchUnknown, None));
        assert_eq!(st(&a.batch, "s1"), (WindowState::Failed, None), "typed: never rebuilt");
        assert_eq!(st(&a.batch, "s2"), (WindowState::Pending, None), "untyped and gone: rebuilt");
        assert_eq!(st(&a.batch, "s3"), (WindowState::Pending, None));
        assert_eq!(st(&a.batch, "s4"), (WindowState::Created, Some(BatchOp::Kill)), "an issued kill stays issued");
        assert_eq!(st(&a.batch, "s5"), (WindowState::Failed, None), "no typed record is no proof");
        assert_eq!(a.batch.projects[0].state, ProjectState::Open, "our session, reopened");
        assert_eq!(continue_schedule(inputs(&socket), Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!(names(&server, &p.session), ["a1", "s2", "s3", "s4"], "only s2 and s3 came back");
        assert_eq!(pane_pid_of(&server, &p.session, "a1"), agent_pid, "the agent's process is untouched");
        assert_eq!(pane_pid_of(&server, &p.session, "s4"), s4_pid, "the issued kill was not sent again");
        let b = batch_of(&socket);
        assert_eq!(st(&b, "s4").0, WindowState::Failed, "re-observed: left in place");
        assert_eq!((st(&b, "s2").0, st(&b, "s3").0), (WindowState::Launched, WindowState::Launched));
    }

    /// M2 (revision 1's per-project table): our own session reopens and gets
    /// only its retryable windows; a session of the same name that is not
    /// ours is never touched, whatever the record says; our session confirmed
    /// gone is claimed again and gets only the untyped windows.
    #[test]
    fn a_retry_reopens_our_session_never_a_foreign_one_and_reclaims_one_that_is_gone() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-own");
        let socket = server.socket().to_string();
        let ours = declare("r4own", vec![shell_slot("o1"), shell_slot("o2")]);
        let theirs = declare("r4foreign", vec![shell_slot("f1")]);
        publish(&socket, &[&ours, &theirs]);
        run(&inputs(&socket)).unwrap();
        // The person's session under the other project's name.
        server.run(&["kill-session", "-t", &format!("={}", theirs.session)]).unwrap();
        server.run(&["new-session", "-d", "-s", &theirs.session, "-n", "f1", "/bin/sh"]).unwrap();
        let foreign_pid = pane_pid_of(&server, &theirs.session, "f1");
        server.run(&["kill-window", "-t", &format!("={}:o2", ours.session)]).unwrap();
        edit_last(&socket, |b| {
            for pr in b.projects.iter_mut() {
                pr.state = ProjectState::Failed;
                for w in pr.windows.iter_mut().filter(|w| w.name != "o1") {
                    (w.state, w.typed) = (WindowState::Failed, Some(false));
                }
            }
        });
        // The foreign session's window is "gone" by its record's pane id.
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        let proj = |b: &Batch, id: &str| b.projects.iter().find(|q| q.id == id).unwrap().state;
        assert_eq!(proj(&a.batch, &ours.id), ProjectState::Open);
        assert_eq!(proj(&a.batch, &theirs.id), ProjectState::Failed, "not ours: shown only");
        assert_eq!(continue_schedule(inputs(&socket), Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!(names(&server, &ours.session), ["o1", "o2"]);
        assert_eq!(names(&server, &theirs.session), ["f1"]);
        assert_eq!(pane_pid_of(&server, &theirs.session, "f1"), foreign_pid, "the person's session is untouched");
        // Our session gone entirely: claimed again, its untyped windows only.
        server.run(&["kill-session", "-t", &format!("={}", ours.session)]).unwrap();
        edit_last(&socket, |b| {
            let pr = b.projects.iter_mut().find(|q| q.id == ours.id).unwrap();
            pr.state = ProjectState::Done;
            for w in pr.windows.iter_mut() {
                let o1 = w.name == "o1";
                (w.state, w.typed) = (if o1 { WindowState::LaunchUnknown } else { WindowState::Failed }, Some(o1));
            }
        });
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        assert_eq!((a.mode, a.batch.attempt), ("retry", 2));
        assert_eq!(proj(&a.batch, &ours.id), ProjectState::Pending, "claimed again");
        assert_eq!(continue_schedule(inputs(&socket), Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!(names(&server, &ours.session), ["o2"], "the typed o1 is not rebuilt");
    }

    /// Round 4 review P1-C: no native ids is not "never created". A create
    /// whose receipt was lost (its window made, then moved elsewhere) ends
    /// Failed with no ids: a retry rebuilds nothing for it and makes no
    /// second window; a window whose create was never issued (or refused)
    /// is rebuilt.
    #[test]
    fn a_retry_never_rebuilds_a_window_whose_create_may_have_happened() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-create");
        let socket = server.socket().to_string();
        let p = declare("r4create", vec![shell_slot("s1"), shell_slot("lost"), shell_slot("never")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        // "lost" was made, its receipt lost, and the window moved away.
        server.run(&["new-session", "-d", "-s", "elsewhere", "/bin/sh"]).unwrap();
        server.run(&["move-window", "-s", &format!("={}:lost", p.session), "-t", "=elsewhere:"]).unwrap();
        server.run(&["kill-window", "-t", &format!("={}:never", p.session)]).unwrap();
        edit_last(&socket, |b| {
            b.projects[0].state = ProjectState::Failed;
            for w in b.projects[0].windows.iter_mut().filter(|w| w.name != "s1") {
                let lost = w.name == "lost";
                (w.state, w.typed, w.create_issued) = (WindowState::Failed, Some(false), Some(lost));
                w.reason = Some(if lost { "indeterminate: new-window" } else { "our session is gone or not ours" }.into());
                (w.window_id, w.pane_id, w.pane_pid) = (None, None, None);
            }
        });
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        let st = |b: &Batch, n: &str| b.projects[0].windows.iter().find(|w| w.name == n).unwrap().state;
        assert_eq!((st(&a.batch, "lost"), st(&a.batch, "never")), (WindowState::Failed, WindowState::Pending));
        assert_eq!(continue_schedule(inputs(&socket), Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!(names(&server, &p.session), ["never", "s1"], "only the never-created window came back");
        assert_eq!(names(&server, "elsewhere").iter().filter(|n| *n == "lost").count(), 1, "the lost window is not duplicated");
    }

    /// Control F9: a create the server REFUSED made nothing, so it counts as
    /// never created and a retry rebuilds it (the write-ahead `create_issued`
    /// goes back to false on the refusal).
    #[test]
    fn a_refused_create_is_retried() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-refused");
        let socket = server.socket().to_string();
        let p = declare("r4refused", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        // Right before the create, the session loses its tag: the in-server
        // guard refuses the create.
        let (sock, pid) = (socket.clone(), p.id.clone());
        let mut done = false;
        set_hook(Some(Box::new(move |s: &Step| {
            if !done && s.op == "create_window" && s.project == pid {
                done = true;
                for sid in tmux::run_tmux_on(Some(&sock), &["list-sessions", "-F", "#{session_id}"]).unwrap().lines() {
                    tmux::run_tmux_on(Some(&sock), &["set-option", "-u", "-t", sid, "@tmm_rs"]).unwrap();
                }
            }
            Mangle::Run
        })));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let w = batch_of(&socket).projects[0].windows[0].clone();
        assert_eq!((w.state, w.window_id.is_none(), w.create_issued), (WindowState::Failed, true, Some(false)), "refused: nothing was created");
        if with_store(|s| s.restore_batch(&socket)).unwrap().is_some() {
            let mut b = batch_of(&socket);
            close(&mut b, "test").unwrap();
        }
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        assert_eq!(a.batch.projects[0].windows[0].state, WindowState::Pending, "a refused create is retried");
    }

    /// Round 4 review P1-B: the reopen is conditional on the hold rows the
    /// retry read, not only on the batch bytes. Another connection installs a
    /// generation for the slot between the retry's read and its reopen (as a
    /// restart's launch door does: no restore lock, no batch write): the
    /// reopen refuses atomically, that generation stays, nothing reopens.
    #[test]
    fn a_retry_never_replaces_a_generation_installed_after_its_read() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-gen");
        let socket = server.socket().to_string();
        let p = declare("r4gen", vec![agent_slot("dev")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        server.run(&["kill-window", "-t", &format!("={}:dev", p.session)]).unwrap();
        edit_last(&socket, |b| {
            let w = &mut b.projects[0].windows[0];
            (w.state, w.typed, w.reason) = (WindowState::Failed, Some(false), Some("fixture".into()));
        });
        let scan = with_store(|s| s.batch_scan(&socket)).unwrap();
        let (raw, last) = (scan.revision.last.clone().unwrap(), scan.last.unwrap().unwrap());
        let (b, planned) = retry_batch(&socket, last).unwrap().expect("a retry");
        assert_eq!(planned.len(), 1, "a fresh generation for dev, conditional on what was read");
        // Between the read and the reopen: another connection's generation.
        let path = std::env::var_os("TMM_STATE_DB").unwrap();
        let mut other = super::super::store::Store::open(std::path::Path::new(&path)).unwrap();
        let l2 = uuid::Uuid::new_v4().to_string();
        let unrelated = Batch { batch: "b-other".into(), socket: format!("{socket}-unrelated"), boot_id: None, owner_pid: 0, attempt: 0, instance: None, source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] }, closed: None, projects: vec![] };
        let gen2 = super::super::store::Hold { launch: l2.clone(), stage: super::super::store::HoldStage::Planned, ..planned[0].0.clone() };
        other.open_batch(&unrelated, &[gen2], "x").unwrap();
        assert_eq!(with_store(|s| s.batch_scan(&socket)).unwrap().revision.last.as_deref(), Some(raw.as_str()), "the batch bytes did not change");
        assert!(!with_store(|s| s.reopen_batch(&raw, &b, &planned)).unwrap(), "the reopen refuses");
        assert_eq!(holds(&socket, &p).into_iter().map(|h| h.launch).collect::<Vec<_>>(), vec![l2], "the newer generation is kept");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "nothing reopened");
        assert!(!names(&server, &p.session).contains(&"dev".to_string()), "nothing made");
    }

    /// Validator survivors M3/M4/M7 (round 4 baseline): a `--run` on an open
    /// batch whose boot is unknown leaves it as it is (only `--abandon`
    /// closes it); an unreadable last batch is an error, never a fresh plan;
    /// and a person's run with the automatic switch OFF in config.toml still
    /// runs, through the RPC and its background continuation.
    #[test]
    fn a_manual_run_leaves_an_unknown_boots_batch_refuses_an_unreadable_last_and_ignores_the_switch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-m347");
        let socket = server.socket().to_string();
        let p = declare("r4m347", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        // M3: an open batch of an unknown boot.
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        run(&inputs(&socket)).unwrap();
        set_hook(None);
        let mut open = batch_of(&socket);
        open.boot_id = None;
        with_store(|s| s.save_batch(&mut open)).unwrap();
        let before = store_dump();
        let e = admit_manual(&socket, Some("boot-after"), false).err().unwrap();
        assert!(e.contains("boot identity is unknown; left as is"), "{e}");
        assert_eq!(store_dump(), before, "left exactly as it was");
        assert_eq!(abandon(&socket).unwrap().as_deref(), Some(open.batch.as_str()), "the person's way out");
        // M4: an unreadable last batch.
        with_store(|s| s.exec_test_sql(&format!("UPDATE meta SET value = '{{' WHERE key = 'restore_last:{socket}'"))).unwrap();
        let e = admit_manual(&socket, Some("boot-after"), false).err().unwrap();
        assert!(e.contains("unreadable") && e.contains("nothing was run"), "{e}");
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "no fresh plan");
        with_store(|s| s.exec_test_sql(&format!("DELETE FROM meta WHERE key = 'restore_last:{socket}'"))).unwrap();
        // M7: the switch off in config.toml; the RPC's run still runs.
        let _off = ConfigFor::test("restore_on_start = false\n");
        assert!(!crate::config::restore_on_start());
        let handed: std::sync::Arc<std::sync::Mutex<Option<(RunInputs, Start)>>> = Default::default();
        let h = handed.clone();
        *SPAWN_HOOK.lock().unwrap() = Some(Box::new(move |i, s| *h.lock().unwrap() = Some((i, s))));
        let r = restore_rpc("run").unwrap();
        assert_eq!(r["accepted"].as_bool(), Some(true), "{r}");
        let (i, s) = handed.lock().unwrap().take().unwrap();
        assert!(!i.enabled, "the continuation runs with the switch off");
        assert_eq!(continue_schedule(i, s), ScheduleEnd::Finished);
        assert_eq!(names(&server, &p.session), ["s1"]);
    }

    /// The RPC itself (`project_restore`): `run` answers accepted with its
    /// batch and attempt and hands the admitted continuation to the
    /// background (the spawn seam receives it, nothing is made before);
    /// `show` then reads that batch; `abandon` with nothing open answers so.
    /// And the reopen is conditional on the last batch's bytes.
    #[test]
    fn the_restore_rpc_runs_in_the_background_and_a_stale_reopen_writes_nothing() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-rpc");
        let socket = server.socket().to_string();
        assert_eq!(super::super::restore::socket_key(), socket, "the RPC addresses this server");
        let p = declare("r4rpc", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        let handed: std::sync::Arc<std::sync::Mutex<Option<(RunInputs, Start)>>> = Default::default();
        let h = handed.clone();
        *SPAWN_HOOK.lock().unwrap() = Some(Box::new(move |i, s| *h.lock().unwrap() = Some((i, s))));
        let r = restore_rpc("run").unwrap();
        assert_eq!((r["accepted"].as_bool(), r["mode"].as_str(), r["attempt"].as_u64()), (Some(true), Some("new"), Some(1)), "{r}");
        assert!(names(&server, &p.session).is_empty(), "answered before any window");
        let (inputs, start) = handed.lock().unwrap().take().expect("the continuation was handed to the background");
        assert!(matches!(&start, Start::Pass(_, b) if b.batch == r["batch"].as_str().unwrap()));
        assert_eq!(continue_schedule(inputs, start), ScheduleEnd::Finished);
        assert_eq!(names(&server, &p.session), ["s1"]);
        assert_eq!(restore_rpc("show").unwrap()["batch"]["batch"], r["batch"]);
        assert_eq!(restore_rpc("abandon").unwrap()["abandoned"], false);
        // The reopen CAS: bytes other than the stored last batch write nothing.
        let last = with_store(|s| s.last_batch(&socket)).unwrap().unwrap();
        assert!(!with_store(|s| s.reopen_batch("stale bytes", &last, &[])).unwrap());
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "nothing reopened");
    }

    /// Control A7: an older schedule's LATER passes never execute a batch a
    /// person has continued as a new attempt — they stop at the first one
    /// (`resume`), and the batch stays the new attempt's, untouched.
    #[test]
    fn an_older_schedule_stops_once_a_person_continues_its_batch() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-older");
        let socket = server.socket().to_string();
        let p = declare("r4older", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        pass_unit(100);
        set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
        let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
        let id = batch.batch.clone();
        let sched = std::thread::spawn({
            let i = inputs(&socket);
            move || continue_schedule(i, Start::Pass(lease, batch))
        });
        // Its first pass halts; while it waits for the next, a person continues.
        let a = loop {
            match admit_manual(&socket, Some("boot-after"), false) {
                Ok(a) => break a,
                Err(e) if e == BUSY => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(e) => panic!("{e}"),
            }
        };
        set_hook(None);
        assert_eq!((a.mode, a.batch.attempt), ("continue", 1));
        drop(a.lease);
        assert_eq!(sched.join().unwrap(), ScheduleEnd::Finished);
        pass_unit(0);
        let b = with_store(|s| s.restore_batch(&socket)).unwrap().expect("still open");
        assert_eq!((b.batch.as_str(), b.attempt), (id.as_str(), 1), "the new attempt's, untouched");
        assert!(names(&server, &p.session).is_empty(), "the older schedule made nothing");
    }

    /// Round 4 review P1-A: an observer that takes the lease over (the owner
    /// died) becomes the owner of exactly that admission. Its later passes
    /// stop once a person continues the batch as a new attempt — nothing
    /// made, nothing closed — and once a person abandons it — nothing
    /// reopened.
    #[test]
    fn an_observer_that_takes_over_owns_only_that_admission() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-observe");
        let socket = server.socket().to_string();
        let p = declare("r4obs", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        pass_unit(100);
        for person in ["continue", "abandon"] {
            // The owner's batch, halted before its project; the owner died.
            if let Some(mut open) = with_store(|s| s.restore_batch(&socket)).unwrap() {
                close(&mut open, "test").unwrap();
                with_store(|s| s.exec_test_sql(&format!("DELETE FROM meta WHERE key = 'restore_last:{socket}'"))).unwrap();
            }
            set_hook(Some(once(&p.id, "project", None, Mangle::HaltBefore)));
            let Prepared::Ready { lease, batch } = prepare(&inputs(&socket)).unwrap() else { panic!("a batch") };
            let id = batch.batch.clone();
            assert!(matches!(continue_batch(lease, batch).unwrap(), RunOutcome::Ran { closed: None, .. }));
            // The observer takes over at its first pass, which halts too.
            let took = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let t = took.clone();
            let pid = p.id.clone();
            set_hook(Some(Box::new(move |s: &Step| {
                if s.op == "project" && s.project == pid && !t.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return Mangle::HaltBefore;
                }
                Mangle::Run
            })));
            let sched = std::thread::spawn({
                let i = inputs(&socket);
                move || continue_schedule(i, Start::Observe)
            });
            while !took.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let lock = || loop {
                match OwnerLock::try_acquire().unwrap() {
                    Some(l) => break l,
                    None => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            };
            drop(lock()); // its takeover pass is over
            match person {
                "continue" => {
                    let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
                    assert_eq!((a.mode, a.batch.attempt), ("continue", 1));
                }
                _ => assert_eq!(abandon(&socket).unwrap().as_deref(), Some(id.as_str())),
            }
            assert_eq!(sched.join().unwrap(), ScheduleEnd::Finished, "{person}");
            set_hook(None);
            match person {
                "continue" => {
                    let b = with_store(|s| s.restore_batch(&socket)).unwrap().expect("still open");
                    assert_eq!((b.batch.as_str(), b.attempt, b.closed.as_deref()), (id.as_str(), 1, None), "the new attempt's, untouched");
                }
                _ => {
                    assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_none(), "nothing reopened");
                    assert_eq!(with_store(|s| s.last_batch(&socket)).unwrap().unwrap().closed.as_deref(), Some(ABANDONED));
                }
            }
            assert!(names(&server, &p.session).is_empty(), "{person}: the old schedule made nothing");
        }
        pass_unit(0);
    }

    // ---- round 4: the project's room line, once per attempt --------------

    fn bw(name: &str, kind: SlotKind, state: WindowState, reason: Option<&str>) -> BatchWindow {
        BatchWindow {
            ord: 0,
            name: name.into(),
            kind,
            managed: kind == SlotKind::Agent,
            cwd: String::new(),
            backend: None,
            agent_session_id: None,
            state,
            reason: reason.map(str::to_string),
            window_id: None,
            pane_id: None,
            pane_pid: None,
            launch: None,
            op: None,
            typed: Some(state != WindowState::Pending),
            released: false,
            create_issued: Some(state != WindowState::Pending),
        }
    }

    /// R7: the line is the execution summary at that moment. Confirmed
    /// windows are created; an agent among them is relaunched, and ready only
    /// on a released hold; a launch written ahead and not confirmed — the
    /// owner died after `LaunchIssued`, before typing — is "launch result
    /// unconfirmed", never relaunched; a created window with an error is
    /// failed; a person's run never says "after a host reboot".
    #[test]
    fn the_room_line_counts_only_what_the_restore_confirmed() {
        let mut b = Batch {
            batch: "u".into(),
            socket: "/s".into(),
            boot_id: None,
            owner_pid: 0,
            attempt: 0,
            instance: None,
            source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![BatchProject {
                id: "p".into(),
                name: "App".into(),
                path: "/w".into(),
                session: "app".into(),
                autostart_only: false,
                state: ProjectState::Done,
                reason: None,
                session_id: None,
                holder_id: None,
                op: None,
                finished: None,
                windows: vec![
                    BatchWindow { released: true, ..bw("lead", SlotKind::Agent, WindowState::Launched, Some(super::super::store::RELEASED)) },
                    bw("dev", SlotKind::Agent, WindowState::Launched, None),
                    bw("rev", SlotKind::Agent, WindowState::LaunchUnknown, Some("the start command may have run; left as is")),
                    bw("sh", SlotKind::Shell, WindowState::Launched, None),
                    bw("dev2", SlotKind::Agent, WindowState::Skipped, Some("no saved conversation")),
                    bw("aux", SlotKind::Shell, WindowState::Failed, Some("rename indeterminate (x)")),
                ],
            }],
        };
        let line = |b: &Batch| report_body(b, &b.projects[0], EVENT_FINISHED, "");
        assert_eq!(
            line(&b),
            "[tmm] restored after a host reboot: 3 windows created (2 agents relaunched with their saved conversation, 1 confirmed ready), 1 launch result unconfirmed (rev), 1 skipped (no saved conversation: dev2), 1 failed (aux: rename indeterminate (x))"
        );
        b.attempt = 2;
        b.projects[0].windows.truncate(1);
        b.projects[0].windows[0].state = WindowState::LaunchIssued;
        assert_eq!(line(&b), "[tmm] restored by `tmm project restore` (attempt 2): 0 windows created, 1 launch result unconfirmed (lead)");
        b.projects[0].state = ProjectState::Skipped;
        b.projects[0].reason = Some("session exists".into());
        assert_eq!(line(&b), "[tmm] not restored by `tmm project restore` (attempt 2): session exists");
        b.attempt = 0;
        assert_eq!(report_body(&b, &b.projects[0], EVENT_GAVE_UP, "windows not finished"), "[tmm] the restore after a host reboot did not finish (windows not finished); start what is missing with `tmm project up app`");
    }

    fn lines_with(room: &str, id: &str) -> usize {
        let page = super::super::rooms::history_page(room, None, 200);
        page["messages"].as_array().unwrap().iter().filter(|m| m["id"] == id).count()
    }

    /// R1–R5 (revision 1, P1-B): the line's once is the hub_msgs row, its id
    /// the (batch, attempt, project, event). Written in the transaction that
    /// makes the project terminal: a failure inside it leaves neither the row
    /// nor the terminal state and the next pass writes both once; a failure
    /// after the commit (before the push) leaves the row, and nothing writes
    /// it again — not a re-finalize, not an old owner's stale save, not a
    /// second gateway's connection; a later batch replacing `restore_last`
    /// does not touch it; only the call that inserted it pushes.
    #[test]
    fn the_room_line_is_one_row_per_attempt_whatever_dies_or_races() {
        use super::super::store::restore_batch::REPORT_FAIL;
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-once");
        let socket = server.socket().to_string();
        let p = declare("r4once", vec![shell_slot("s1")]);
        publish(&socket, &[&p]);
        let room = format!("proj:{}", p.session);
        let mut rx = super::super::rooms::subscribe();
        // R2: inside the transaction.
        REPORT_FAIL.with(|f| f.set(1));
        assert!(run(&inputs(&socket)).is_err());
        let b0 = batch_of(&socket);
        assert!(b0.closed.is_none() && b0.projects[0].state != ProjectState::Done, "no terminal state without its row");
        let id = report_id(&b0, &b0.projects[0], EVENT_FINISHED);
        assert_eq!(lines_with(&room, &id), 0);
        let stale = b0.clone();
        // R1: after the commit, before the push.
        REPORT_FAIL.with(|f| f.set(2));
        assert!(run(&inputs(&socket)).is_err());
        assert_eq!(lines_with(&room, &id), 1, "the row is there");
        assert!(!std::iter::from_fn(|| rx.try_recv().ok()).any(|m| m.contains(&id)), "nothing was pushed");
        // R4: an old owner's stale copy saved over it, then a re-finalize.
        let mut old = stale;
        with_store(|s| s.save_batch(&mut old)).unwrap();
        run(&inputs(&socket)).unwrap();
        assert_eq!(batch_of(&socket).projects[0].state, ProjectState::Done);
        assert_eq!(lines_with(&room, &id), 1, "the same event: no second row");
        // R3: a second gateway's own connection reports the same event.
        let path = std::env::var_os("TMM_STATE_DB").unwrap();
        let mut other = super::super::store::Store::open(std::path::Path::new(&path)).unwrap();
        let mut copy = batch_of(&socket);
        let line = |m: &Batch| report_lines(m, &[(p.id.clone(), room.clone())], EVENT_FINISHED, "");
        assert!(other.save_batch_reporting(&mut copy, line).unwrap().is_empty(), "the other gateway inserts nothing");
        assert_eq!(lines_with(&room, &id), 1);
        // R5: a later batch replaces restore_last; the row stays.
        let mut next = batch_of(&socket);
        next.batch = uuid::Uuid::new_v4().to_string();
        with_store(|s| s.close_batch(&mut next)).unwrap();
        assert_eq!(with_store(|s| s.last_batch(&socket)).unwrap().unwrap().batch, next.batch);
        assert_eq!(lines_with(&room, &id), 1);
        let pushed: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).filter(|m| m.contains(&id)).collect();
        assert!(pushed.is_empty(), "the call that inserted it failed before its push; no later call pushed: {pushed:?}");
    }

    /// R6: a person's retry is a new attempt and records its own line; the
    /// first attempt's stays.
    #[test]
    fn a_retry_records_its_own_line_and_keeps_the_first() {
        use_test_store();
        let scope = GlobalSocket::hold();
        let server = PrivateTmux::start(&scope, "r4-line2");
        let socket = server.socket().to_string();
        let p = declare("r4line2", vec![shell_slot("s1"), shell_slot("s2")]);
        publish(&socket, &[&p]);
        run(&inputs(&socket)).unwrap();
        let first = with_store(|s| s.last_batch(&socket)).unwrap().unwrap();
        let room = format!("proj:{}", p.session);
        let id0 = report_id(&first, &first.projects[0], EVENT_FINISHED);
        assert_eq!(lines_with(&room, &id0), 1);
        server.run(&["kill-window", "-t", &format!("={}:s2", p.session)]).unwrap();
        edit_last(&socket, |b| {
            let w = b.projects[0].windows.iter_mut().find(|w| w.name == "s2").unwrap();
            (w.state, w.typed, w.reason) = (WindowState::Failed, Some(false), Some("fixture".into()));
        });
        let a = admit_manual(&socket, Some("boot-after"), false).unwrap();
        let id1 = report_id(&a.batch, &a.batch.projects[0], EVENT_FINISHED);
        assert_ne!(id0, id1);
        assert_eq!(continue_schedule(inputs(&socket), Start::Pass(a.lease, a.batch)), ScheduleEnd::Finished);
        assert_eq!((lines_with(&room, &id0), lines_with(&room, &id1)), (1, 1));
        let page = super::super::rooms::history_page(&room, None, 200).to_string();
        assert!(page.contains("restored by `tmm project restore` (attempt 1): 2 windows created"), "{page}");
    }
}
