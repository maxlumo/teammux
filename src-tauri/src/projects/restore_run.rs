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
pub struct RunInputs {
    pub socket: String,
    pub enabled: bool,
    pub boot_now: Option<String>,
    pub include_autostart: bool,
}

// ---- the owner ------------------------------------------------------------

/// The one restore owner per state.db: `flock(LOCK_EX|LOCK_NB)` on
/// `<state dir>/restore.lock`, released by the OS when the process dies.
pub(crate) struct OwnerLock {
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
    name: String,
    tag: String,
}

/// The windows of our session `$N`, with their tags, from the server whose
/// identity is checked in the same answer. `Err` = could not be read, or
/// the answering server is not the batch's.
fn observe_windows(socket: &str, session_id: &str, instance: &TmuxInstance) -> Result<Option<Vec<WindowSeen>>, String> {
    let fmt = format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{window_id}}{SEP}#{{pane_id}}{SEP}#{{window_name}}{SEP}#{{@tmm_rw}}");
    let out = match tmux::run_tmux_on(Some(socket), &["list-windows", "-t", session_id, "-F", &fmt]) {
        Ok(out) => out,
        Err(e) if tmux::session_confirmed_absent(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut seen = Vec::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split(SEP).collect();
        let [pid, start, id, pane, name, tag] = f[..] else { return Err(format!("unreadable list-windows line: {line}")) };
        if pid != instance.pid.to_string() || start != instance.start_time.to_string() {
            return Err("another tmux server answered".into());
        }
        seen.push(WindowSeen { id: id.into(), pane: pane.into(), name: name.into(), tag: tag.into() });
    }
    Ok(Some(seen))
}

// ---- the run ---------------------------------------------------------------

/// Take the owner lock, continue the socket's open batch from the batch
/// ALONE, or — with none open — judge the reboot trigger on the evidence and
/// start a batch from round 1's plan; then execute it as far as it can go.
pub fn run(inputs: &RunInputs) -> Result<RunOutcome, String> {
    // The gate holds for BOTH paths, before any write (review P1-D): off, or
    // a boot that cannot be read, does nothing — an open batch is neither
    // continued nor closed.
    if !inputs.enabled {
        return Ok(RunOutcome::Nothing("restore on start is off".into()));
    }
    if inputs.boot_now.is_none() {
        return Ok(RunOutcome::Nothing("the host's boot identity is unknown".into()));
    }
    let Some(_lock) = OwnerLock::try_acquire()? else { return Ok(RunOutcome::Busy) };
    let socket = inputs.socket.as_str();
    let open = with_store(|s| s.restore_batch(socket))?;
    let mut b = match open {
        Some(b) if b.boot_id.is_some() && b.boot_id == inputs.boot_now => b,
        Some(b) if b.boot_id.is_none() => {
            return Ok(RunOutcome::Nothing("the open restore's boot identity is unknown; left as is".into()));
        }
        Some(mut b) => {
            // A second host reboot during a half-done batch: its objects died
            // with the old server. Closed FAILED; nothing is re-planned
            // automatically (orchestrator, 23:54).
            close(&mut b, "failed: the host rebooted during the restore")?;
            return Ok(RunOutcome::Ran { batch: b.batch, closed: b.closed });
        }
        None => match start_batch(inputs)? {
            Ok(b) => b,
            Err(why) => return Ok(RunOutcome::Nothing(why)),
        },
    };
    b.owner_pid = std::process::id();
    save(&b)?;
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
    let declared = declared()?;
    let intents = with_store(|s| s.restore_intents())?;
    let plan = restore::plan(cp, &declared, &intents, inputs.include_autostart, &restore::LiveFacts);
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
                    op: None,
                })
                .collect(),
        })
        .collect();
    Ok(Ok(Batch {
        batch: uuid::Uuid::new_v4().to_string(),
        socket: socket.to_string(),
        boot_id: inputs.boot_now.clone(),
        owner_pid: std::process::id(),
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

fn save(b: &Batch) -> Result<(), String> {
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
        let failed = b.projects.iter().any(|p| p.state == ProjectState::Failed);
        close(b, if failed { "done with failures" } else { "done" })?;
    }
    Ok(())
}

fn set_project(b: &mut Batch, pi: usize, state: ProjectState, reason: Option<String>, op: Option<BatchOp>) -> Result<(), String> {
    let p = &mut b.projects[pi];
    p.state = state;
    p.reason = reason;
    p.op = op;
    save(b)
}

fn set_window(b: &mut Batch, pi: usize, wi: usize, state: WindowState, reason: Option<String>, op: Option<BatchOp>) -> Result<(), String> {
    let w = &mut b.projects[pi].windows[wi];
    w.state = state;
    w.reason = reason;
    w.op = op;
    save(b)
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
    set_window(b, pi, wi, WindowState::Creating, None, Some(BatchOp::CreateWindow))?;
    let w = b.projects[pi].windows[wi].clone();
    let cwd = super::reconcile::absolute_cwd(&b.projects[pi].path, &w.cwd);
    let action = format!(
        "new-window -d -t {} -n {} -c {} -P -F {}",
        tmux::tmux_quote(&sid),
        tmux::tmux_quote(&placeholder(&b.batch, w.ord)),
        tmux::tmux_quote(&cwd),
        tmux::tmux_quote("#{window_id} #{pane_id}")
    );
    let step = Step { op: "create_window", project: b.projects[pi].id.clone(), ord: Some(w.ord) };
    match guarded(&b.socket, &step, &sid, &cond, &action)? {
        Outcome::Applied(ids) => {
            let mut it = ids.split_whitespace();
            match (it.next(), it.next()) {
                (Some(wid), Some(pane)) if wid.starts_with('@') && pane.starts_with('%') => {
                    let w = &mut b.projects[pi].windows[wi];
                    w.window_id = Some(wid.into());
                    w.pane_id = Some(pane.into());
                    tag_window(b, pi, wi)
                }
                _ => observe_created(b, pi, wi),
            }
        }
        Outcome::Refused => {
            // Nothing was created. A window of the slot's name in OUR session
            // is the person's; anything else means the session is not ours.
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
        return set_window(b, pi, wi, WindowState::Created, None, None);
    }
    // Refused or Unknown: re-observe by id on the batch's server.
    match observe_windows(&b.socket, &sid, &inst) {
        Ok(Some(seen)) => match seen.into_iter().find(|s| s.id == wid) {
            Some(s) if s.tag == tag => set_window(b, pi, wi, WindowState::Created, None, None),
            Some(s) if s.tag.is_empty() && s.name == placeholder(&b.batch, w.ord) && matches!(outcome, Outcome::Unknown(_)) => {
                // Present, ours by birth name, untagged: the install is
                // redone under the same guard (idempotent, not blind).
                match guarded(&b.socket, &step, &wid, &cond, &tag_action)? {
                    Outcome::Applied(_) => set_window(b, pi, wi, WindowState::Created, None, None),
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
        let text = super::reconcile::launch_text(row, &slot, &line);
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
        // Write-ahead: from here the window is never killed, renamed or retyped.
        set_window(b, pi, wi, WindowState::LaunchIssued, None, None)?;
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
        Outcome::Applied(_) | Outcome::Refused => set_window(b, pi, wi, WindowState::Failed, Some(why), None),
        Outcome::Unknown(_) => observe_kill(b, pi, wi),
    }
}

/// A kill whose answer was not seen: gone is done; present is left in place
/// and reported — never killed a second time.
fn observe_kill(b: &mut Batch, pi: usize, wi: usize) -> Result<(), String> {
    let w = b.projects[pi].windows[wi].clone();
    let why = w.reason.clone().unwrap_or_default();
    let (Some(inst), Some(sid), Some(wid)) = (b.instance.clone(), b.projects[pi].session_id.clone(), w.window_id.clone()) else {
        return set_window(b, pi, wi, WindowState::Failed, Some(why), None);
    };
    match observe_windows(&b.socket, &sid, &inst) {
        // Present: left in place, reported, final — never killed a second time.
        Ok(Some(seen)) if seen.iter().any(|s| s.id == wid) => {
            set_window(b, pi, wi, WindowState::Failed, Some(format!("{why}; kill indeterminate, left in place")), Some(BatchOp::Kill))
        }
        Ok(_) => set_window(b, pi, wi, WindowState::Failed, Some(why), None),
        // Not readable: the step stays issued, to be re-observed next pass.
        Err(_) => set_window(b, pi, wi, WindowState::Created, Some(why), Some(BatchOp::Kill)),
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
fn finalize(b: &mut Batch, pi: usize, note: Option<String>) -> Result<(), String> {
    let launched = b.projects[pi].windows.iter().any(|w| w.state == WindowState::Launched);
    if launched {
        set_project(b, pi, ProjectState::Done, note, None)
    } else {
        let why = match note {
            Some(n) if n.starts_with("no window") => n,
            Some(n) => format!("no window could be restored; {n}"),
            None => "no window could be restored".into(),
        };
        set_project(b, pi, ProjectState::Failed, Some(why), None)
    }
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

    fn inputs(socket: &str) -> RunInputs {
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
        with_store(|s| s.meta_set(&format!("restore_batch:{socket}"), "")).ok();
        with_store(|s| s.close_batch(&Batch { batch: "x".into(), socket: socket.clone(), boot_id: None, owner_pid: 0, instance: None, source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] }, closed: Some("cleanup".into()), projects: vec![] })).unwrap();
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
            owner_pid: 0,
            instance: Some(inst.clone()),
            source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![BatchProject {
                id: "own".into(), name: "own".into(), path: "/".into(), session: "own".into(), autostart_only: false,
                state: ProjectState::Open, reason: None, session_id: Some(sid.clone()), holder_id: None, op: None, windows: vec![],
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
            owner_pid: 0,
            instance: None,
            source: Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![],
        };
        // A batch opens mid-scan.
        let (f, sock) = (fake.clone(), socket.clone());
        *TICK_HOOK.lock().unwrap() = Some(Box::new(move |phase| {
            if phase == TickPhase::Listed {
                with_store(|s| s.save_batch(&f)).unwrap();
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
                with_store(|s| s.close_batch(&c)).unwrap();
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
            windows: vec![],
        }];
        *super::super::store::SCAN_HOOK.lock().unwrap() = Some(Box::new(move || {
            if let Some(mut s) = other.lock().unwrap().take() {
                s.save_batch(&f3).unwrap();
            }
        }));
        super::super::capture_once().unwrap();
        *super::super::store::SCAN_HOOK.lock().unwrap() = None;
        assert!(with_store(|s| s.restore_batch(&socket)).unwrap().is_some(), "the other gateway's batch landed");
        assert_eq!(slots(), before, "no fold");
        assert_eq!(with_store(|s| s.checkpoint(&socket)).unwrap().unwrap().gen, gen, "no checkpoint");
        let mut c = fake.clone();
        c.closed = Some("done".into());
        with_store(|s| s.close_batch(&c)).unwrap();
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
        with_store(|s| { let mut l = s.last_batch(&socket)?.unwrap(); l.boot_id = Some("older".into()); s.close_batch(&l) }).unwrap();
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
}
