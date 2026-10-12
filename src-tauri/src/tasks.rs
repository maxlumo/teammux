//! `tmm task` — background tasks as tmux windows. See
//! `docs/design-docs/features/tmm-cli.md`.
//!
//! LOCAL ONLY: nothing here touches the network. `tmm task *` works with no
//! tmux-mobile server running, which is the whole point — the thing an agent
//! most often wants to background *is* the server.
//!
//! Design contract (load-bearing, all three verified on tmux 3.7b):
//! - `remain-on-exit on` is what makes a task observable after it ends: the
//!   pane goes `#{pane_dead}=1` with the exit code in `#{pane_dead_status}`,
//!   and the scrollback stays readable. So status and log retention come from
//!   ONE native mechanism — no pidfiles, no sentinel files, no log files.
//! - It MUST be set with `-w` (window scope). Session scope would turn it on
//!   for every window the user has open in that session, so their shells would
//!   stop closing on exit. That is not ours to change.
//! - The registry is the `@tmm_task` window option, not a file: one
//!   `list-windows -a` call enumerates every task in every session. An agent
//!   whose context was compacted can rediscover what it left running, which a
//!   remembered PID can never do. `@tmm_cmd` / `@tmm_started` ride along so
//!   `list` needs no second lookup.
//!
//! Task names are GLOBALLY unique (the name is the handle an agent holds), so
//! lookups scan all sessions rather than just the current one.
//!
//! Retention is BOUNDED (board #206, owner 2026-09-20: "任务结束后窗口仍保留；停止任务
//! 也不等于删除窗口，这样就导致大量冗余窗口堆积" — 39 of 40 task windows on the live
//! server were dead, the oldest 7 days). A finished task's window lives
//! `TTL` (30 min, `TMM_TASK_TTL_SECS` overrides) past `#{pane_dead_time}` —
//! the epoch second of the LATEST death, empty while the pane is alive again
//! after a respawn (verified on tmux 3.6a) — and every `tmm task` verb reaps
//! what has expired at its door: one mechanism, local, no daemon, no timer, no
//! file, working with the server down. `stop` closes the window once the
//! process is dead (after printing the last lines), `--keep` retains it.

use crate::tmux;
use std::time::{SystemTime, UNIX_EPOCH};

/// Same separator the team helpers in `tmux.rs` use for `-F` output.
const SEP: &str = "<TMM_SEP>";
/// Where tasks land when the caller is not inside tmux and named no session.
pub const FALLBACK_SESSION: &str = "tmm-tasks";

const OPT_TASK: &str = "@tmm_task";
const OPT_CMD: &str = "@tmm_cmd";
const OPT_STARTED: &str = "@tmm_started";
/// The shell command a `--wake` task runs when it dies (board #275), kept in
/// a pane option and expanded by the hook with `E:`: no user text ever goes
/// through tmux's command parser, and `#{pane_dead_status}` /
/// `#{pane_dead_signal}` inside it are filled in at death.
const OPT_WAKE: &str = "@tmm_wake_cmd";
/// Why a task-end wake could not be sent (board #275): kept on the task so
/// `tmm task status|list|logs` say it. A dead pane's tty is closed, so the
/// hook cannot print into the pane itself (measured, tmux 3.6a).
const OPT_WAKE_ERR: &str = "@tmm_wake_err";
const WAKE_HOOK: &str = "run-shell -b \"#{E:@tmm_wake_cmd}\"";

/// How long a FINISHED task's window outlives its process before a `tmm task`
/// verb reaps it (board #206). The env override exists for tests and for an
/// operator who wants logs kept longer; 0 reaps at the next verb.
pub const DEFAULT_TTL_SECS: u64 = 30 * 60;
pub const TTL_ENV: &str = "TMM_TASK_TTL_SECS";

/// How long `stop` waits for the C-c to land before escalating to signals.
const STOP_GRACE_MS: u64 = 2_000;
const SIGNAL_GRACE_MS: u64 = 1_000;
const POLL_MS: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Running,
    /// The command exited; tmux kept the pane and its scrollback.
    Exited(i32),
    /// A signal ended it — tmux names it (`kill`, `int`, `term`). Kept distinct
    /// from `Exited` because reporting a signal death as an exit code is a lie
    /// an agent would then act on.
    Killed(String),
}

/// Failures are typed rather than stringly, because the CLI maps them onto
/// tmm's tiered exit codes and sniffing message text for that would rot.
#[derive(Debug)]
pub enum Error {
    /// The request cannot work as asked: bad name, no command, or a name a
    /// live task already holds.
    Invalid(String),
    /// No task by that name.
    NotFound(String),
    /// tmux itself failed — not running, target gone, no permission.
    Tmux(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Invalid(m) | Error::NotFound(m) => write!(f, "{m}"),
            Error::Tmux(m) => write!(f, "{m}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Task {
    pub name: String,
    pub session: String,
    pub window: String,
    /// Pane id (`%NN`). Used as the tmux target because it is stable across
    /// window renumbering, unlike `session:index`.
    pub pane: String,
    pub cmd: String,
    pub state: State,
    pub pid: String,
    /// Unix seconds, 0 when unknown.
    pub started: u64,
    /// `#{pane_dead_time}`: unix seconds of the latest death, 0 while running
    /// (tmux clears it on respawn) or when tmux does not report it.
    pub dead_at: u64,
    /// Why its `--wake` could not be sent (board #275); empty otherwise.
    pub wake_error: String,
}

impl Task {
    pub fn target(&self) -> String {
        format!("{}:{}", self.session, self.window)
    }

    pub fn state_str(&self) -> String {
        match &self.state {
            State::Running => "running".into(),
            State::Exited(code) => format!("exited:{code}"),
            State::Killed(sig) => format!("killed:{sig}"),
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, State::Running)
    }

    /// Seconds since start, or `None` when the start time is unknown — which is
    /// not the same thing as "just started".
    pub fn age(&self, now: u64) -> Option<u64> {
        if self.started == 0 {
            None
        } else {
            Some(now.saturating_sub(self.started))
        }
    }
}

/// Every task in every session. Never fails: no tmux server means no tasks.
pub fn list() -> Vec<Task> {
    match tmux::run_tmux(&["list-windows", "-a", "-F", &list_format()]) {
        Ok(out) => out.lines().filter_map(parse_line).collect(),
        Err(_) => Vec::new(),
    }
}

/// Field order here is the field order `parse_line` reads. `@tmm_cmd` goes last
/// because it is the only field that may contain anything at all.
fn list_format() -> String {
    [
        format!("#{{{OPT_TASK}}}"),
        "#{session_name}".to_string(),
        "#{window_index}".to_string(),
        "#{pane_id}".to_string(),
        "#{pane_dead}".to_string(),
        "#{pane_dead_status}".to_string(),
        "#{pane_dead_signal}".to_string(),
        "#{pane_pid}".to_string(),
        format!("#{{{OPT_STARTED}}}"),
        "#{pane_dead_time}".to_string(),
        format!("#{{{OPT_WAKE_ERR}}}"),
        format!("#{{{OPT_CMD}}}"),
    ]
    .join(SEP)
}

/// The retention TTL in seconds: `TMM_TASK_TTL_SECS` when set to a number,
/// else 30 minutes.
pub fn ttl_secs() -> u64 {
    std::env::var(TTL_ENV).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(DEFAULT_TTL_SECS)
}

/// Close every task window whose process died more than the TTL ago (board
/// #206). Only windows carrying `@tmm_task` (that is all `list` returns) and
/// only dead ones with a reported death time — a running task is never
/// touched, nor a plain window that happens to be dead. `except` shields the
/// verb's own target so `logs`/`status`/`rm` on an expired task still answer;
/// callers reap AFTER their own work. Returns what was closed.
pub fn reap_expired(except: Option<&str>) -> Vec<Task> {
    let ttl = ttl_secs();
    let now = unix_now();
    let mut reaped = Vec::new();
    for t in list() {
        if t.is_running() || t.dead_at == 0 || Some(t.name.as_str()) == except {
            continue;
        }
        if now.saturating_sub(t.dead_at) < ttl {
            continue;
        }
        if tmux::kill_window(&t.pane).is_ok() {
            reaped.push(t);
        }
    }
    reaped
}

/// The task called `name`, wherever it lives.
pub fn find(name: &str) -> Option<Task> {
    list().into_iter().find(|t| t.name == name)
}

/// Start `argv` detached in its own tmux window called `name`.
///
/// The window is created empty and then respawned with the command, because the
/// `remain-on-exit` option has to be in place BEFORE the command runs — a
/// command that exits in milliseconds would otherwise take its window (and its
/// output) down with it.
///
/// `env` is set on the command's process (`respawn-window -e`), so the task
/// runs as whoever started it (board #291): a fresh or reused window otherwise
/// has the tmux SERVER's environment, not the starter's.
pub fn start(
    name: &str,
    argv: &[String],
    session: Option<&str>,
    replace: bool,
    wake: Option<&str>,
    env: &[(String, String)],
) -> Result<Task> {
    validate_name(name)?;
    if argv.is_empty() {
        return Err(Error::Invalid(
            "no command — usage: tmm task start <name> -- <cmd...>".into(),
        ));
    }
    let cmd = join_cmd(argv);
    let session = match session {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => current_session().unwrap_or_else(|| FALLBACK_SESSION.to_string()),
    };
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let pane = match find(name) {
        Some(t) if t.is_running() && !replace => {
            return Err(Error::Invalid(format!(
                "task '{name}' is already running in {} (pid {}) — stop it, or pass --replace",
                t.target(),
                t.pid
            )));
        }
        // Dead, or --replace: reuse the window when it is already in the target
        // session, otherwise drop it so the task does not exist twice.
        Some(t) if t.session == session => t.pane,
        Some(t) => {
            // If the old window will not go, starting a second one would make
            // the task exist twice — the one thing the registry promises not to.
            tmux::kill_window(&t.pane).map_err(Error::Tmux)?;
            create_window(&session, name, &cwd)?
        }
        None => create_window(&session, name, &cwd)?,
    };

    let now = unix_now();
    set_opt(&pane, "remain-on-exit", "on")?;
    set_opt(&pane, OPT_TASK, name)?;
    set_opt(&pane, OPT_CMD, &cmd)?;
    set_opt(&pane, OPT_STARTED, &now.to_string())?;
    // The wake hook is set or cleared on EVERY start: a reused window must not
    // keep a previous run's hook. Measured on tmux 3.6a: `pane-died` fires
    // once per death with the status or signal, and not for a command that
    // `respawn -k` replaces.
    // A new run starts clean: an earlier run's recorded wake failure is
    // cleared on EVERY start, with or without --wake (validator 09:54).
    let _ = tmux::run_tmux(&["set-option", "-w", "-u", "-t", &pane, OPT_WAKE_ERR]);
    match wake {
        Some(shell) => {
            tmux::run_tmux(&["set-option", "-p", "-t", &pane, OPT_WAKE, shell]).map_err(Error::Tmux)?;
            tmux::run_tmux(&["set-hook", "-p", "-t", &pane, "pane-died", WAKE_HOOK]).map_err(Error::Tmux)?;
        }
        None => clear_wake(&pane),
    }
    let pairs: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let mut args = vec!["respawn-window", "-k"];
    for pair in &pairs {
        args.extend(["-e", pair.as_str()]);
    }
    args.extend(["-t", pane.as_str(), cmd.as_str()]);
    tmux::run_tmux(&args).map_err(Error::Tmux)?;

    find(name).ok_or_else(|| Error::Tmux(format!("started '{name}' but it vanished from tmux")))
}

/// Last `limit` lines of the task's output, optionally only lines containing
/// `grep` (case-insensitive substring). The scan covers the whole scrollback;
/// only the returned slice is bounded, because the caller is usually an agent
/// paying for every line in its context.
pub fn logs(name: &str, limit: usize, grep: Option<&str>) -> Result<String> {
    let task = need(name)?;
    let out = tmux::run_tmux(&["capture-pane", "-p", "-J", "-S", "-", "-t", &task.pane])
        .map_err(Error::Tmux)?;
    let out = if task.is_running() {
        out
    } else {
        strip_dead_marker(&out)
    };
    Ok(tail_lines(out.trim_end(), limit, grep))
}

/// Ask the task to stop, escalating only as far as it has to: C-c first (a real
/// TTY, so the whole foreground process group gets it — this is what a
/// `nohup`-ed process cannot be given), then TERM, then KILL to the pane's
/// PROCESS GROUP. Then — board #206 — the last `STOP_TAIL_LINES` of output are
/// read and the window is CLOSED unless `keep`: stopping is finishing, and a
/// finished task's window is the agent's to close ("停止任务也不等于删除窗口" was the
/// complaint). Stopping an already finished task closes it the same way.
///
/// The group, not the pid: `#{pane_pid}` is the `sh -c` wrapper tmux runs the
/// command with, and a TERM to the wrapper alone leaves its children — `npm run
/// dev`, a pipeline, anything that did not `exec` — orphaned and running while
/// the pane goes dead and the task reports `killed:term`. tmux starts every
/// pane as a session leader, so the wrapper's pgid is its own pid and the group
/// is exactly the process tree the task started (minus anything that `setsid`
/// itself away, which is its own choice).
pub const STOP_TAIL_LINES: usize = 20;

/// What `stop` hands back: the task as it ended and the last lines of its
/// output, read before the window went (empty when `keep` left it in place —
/// `logs` still has it then).
pub struct Stopped {
    pub task: Task,
    pub tail: String,
    pub closed: bool,
}

pub fn stop(name: &str, keep: bool) -> Result<Stopped> {
    let task = need(name)?;
    // Whoever stops a task already knows it ended: no wake (board #275).
    clear_wake(&task.pane);
    let dead = if task.is_running() { end_process(&task)? } else { task };
    let tail = if keep { String::new() } else { logs(name, STOP_TAIL_LINES, None).unwrap_or_default() };
    let closed = !keep && tmux::kill_window(&dead.pane).is_ok();
    Ok(Stopped { task: dead, tail, closed })
}

/// C-c → TERM → KILL until the pane is dead; the task as it ended.
fn end_process(task: &Task) -> Result<Task> {
    let name = task.name.as_str();
    tmux::send_keys(&task.pane, "C-c", false).map_err(Error::Tmux)?;
    if let Some(t) = wait_dead(name, STOP_GRACE_MS) {
        return Ok(t);
    }
    for sig in [libc::SIGTERM, libc::SIGKILL] {
        signal_group(&task.pid, sig);
        if let Some(t) = wait_dead(name, SIGNAL_GRACE_MS) {
            return Ok(t);
        }
    }
    Err(Error::Tmux(format!(
        "task '{name}' ignored C-c, TERM and KILL — inspect it with `tmux attach -t {}`",
        task.target()
    )))
}

/// Send `sig` to the process group of `pid` (the pane's shell), falling back
/// to the pid alone when the group cannot be read. Never fails loudly: the
/// caller polls the pane for the outcome, which is the only truth that matters.
fn signal_group(pid: &str, sig: libc::c_int) {
    let Ok(pid) = pid.trim().parse::<libc::pid_t>() else { return };
    if pid <= 1 {
        return; // never a real task; and never signal init or "everything"
    }
    let pgid = process_group(pid).unwrap_or(pid);
    // SAFETY: killpg/kill are plain syscalls; both ids are positive integers
    // read from tmux/ps for a process we started, and a stale id merely fails
    // with ESRCH (or reaches an unrelated group only if the OS reused a pgid in
    // the milliseconds since — the same window every `kill` on a pid has).
    unsafe {
        if libc::killpg(pgid, sig) != 0 {
            libc::kill(pid, sig);
        }
    }
}

/// The process group of `pid`, via `ps` — portable across Linux and macOS,
/// unlike /proc.
fn process_group(pid: libc::pid_t) -> Option<libc::pid_t> {
    let out = std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Forget a finished task, closing its window. Refuses while it runs: removing
/// a live task would look like it stopped, and its log would be gone.
pub fn remove(name: &str) -> Result<Task> {
    let task = need(name)?;
    if task.is_running() {
        return Err(Error::Invalid(format!(
            "task '{name}' is still running — `tmm task stop {name}` first"
        )));
    }
    tmux::kill_window(&task.pane).map_err(Error::Tmux)?;
    Ok(task)
}

fn need(name: &str) -> Result<Task> {
    find(name).ok_or_else(|| Error::NotFound(format!("no task '{name}' — try `tmm task list`")))
}

/// Poll for up to `budget_ms` waiting for the task's pane to go dead.
fn wait_dead(name: &str, budget_ms: u64) -> Option<Task> {
    let mut waited = 0;
    while waited < budget_ms {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        waited += POLL_MS;
        match find(name) {
            Some(t) if !t.is_running() => return Some(t),
            Some(_) => {}
            // The window went away entirely (remain-on-exit lost): nothing to
            // report, but it is certainly not running.
            None => return None,
        }
    }
    None
}

/// A detached window, so starting a task never steals the user's focus.
/// (`tmux::new_named_window` deliberately does take focus — the Team tab wants
/// that when it opens an agent.)
fn create_window(session: &str, name: &str, cwd: &str) -> Result<String> {
    tmux::ensure_session(session, cwd).map_err(Error::Tmux)?;
    let mut args = vec![
        "new-window", "-d", "-t", session, "-n", name, "-P", "-F", "#{pane_id}",
    ];
    if !cwd.is_empty() {
        args.push("-c");
        args.push(cwd);
    }
    Ok(tmux::run_tmux(&args).map_err(Error::Tmux)?.trim().to_string())
}

/// Who started a task, as the environment its processes run with (board
/// #291): the ONE definition both the task command (`start`'s `env`) and its
/// `--wake` hook carry. `TMM_PROJECT` and `TMM_AGENT` are always present, EMPTY
/// when the starter has none (tmm reads empty as unset), so a stale identity in
/// the tmux server's environment never leaks in: a task the human starts
/// speaks as the human. Config dir and server travel only when the starter has
/// them — an empty `TMM_SERVER` would be read as a server address.
pub fn starter_env(project: Option<&str>, agent: Option<&str>, config: Option<&str>, server: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("TMM_PROJECT".to_string(), project.unwrap_or_default().to_string()),
        ("TMM_AGENT".to_string(), agent.unwrap_or_default().to_string()),
    ];
    if let Some(c) = config { env.push(("XDG_CONFIG_HOME".into(), c.into())); }
    if let Some(s) = server { env.push(("TMM_SERVER".into(), s.into())); }
    env
}

/// `text` as a literal inside a tmux format (the wake command is one): `#`
/// doubled, so only the caller's own `#{…}` placeholders are expanded.
pub fn format_literal(text: &str) -> String {
    text.replace('#', "##")
}

/// Drop a pane's wake hook, command and any recorded failure.
fn clear_wake(pane: &str) {
    let _ = tmux::run_tmux(&["set-hook", "-p", "-u", "-t", pane, "pane-died"]);
    let _ = tmux::run_tmux(&["set-option", "-p", "-u", "-t", pane, OPT_WAKE]);
    let _ = tmux::run_tmux(&["set-option", "-w", "-u", "-t", pane, OPT_WAKE_ERR]);
}

/// Record on task `name` that its wake could not be sent (board #275), so
/// the next `tmm task status|list|logs` says it — the visible trace the
/// design promises. No retry: a wake is best-effort.
pub fn note_wake_failure(name: &str, why: &str) -> Result<()> {
    let task = need(name)?;
    let line: String = why.lines().next().unwrap_or("").chars().take(200).collect();
    set_opt(&task.pane, OPT_WAKE_ERR, &line)
}

fn set_opt(pane: &str, name: &str, value: &str) -> Result<()> {
    tmux::run_tmux(&["set-option", "-w", "-t", pane, name, value])
        .map(|_| ())
        .map_err(Error::Tmux)
}

/// The session the caller sits in, or `None` when it is not inside tmux.
/// Gated on `$TMUX`: without it `display-message` would answer for whichever
/// session tmux considers current, and the task would land somewhere random.
fn current_session() -> Option<String> {
    if std::env::var("TMUX").ok().filter(|v| !v.is_empty()).is_none() {
        return None;
    }
    let pane = std::env::var("TMUX_PANE").unwrap_or_default();
    let out = if pane.is_empty() {
        tmux::run_tmux(&["display-message", "-p", "#{session_name}"])
    } else {
        tmux::run_tmux(&["display-message", "-p", "-t", &pane, "#{session_name}"])
    };
    out.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Unix seconds. Shared with the CLI so ages are computed against one clock.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- pure helpers

/// A task name has to survive being pasted into a tmux target (`session:window`
/// with `.pane`), and has to not look like a flag.
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::Invalid("task name is empty".into()));
    }
    if name.starts_with('-') {
        return Err(Error::Invalid(format!(
            "task name '{name}' cannot start with '-'"
        )));
    }
    if let Some(bad) = name.chars().find(|c| matches!(c, ':' | '.') || c.is_whitespace()) {
        return Err(Error::Invalid(format!(
            "task name '{name}' cannot contain '{bad}' — tmux reads ':' and '.' as target separators"
        )));
    }
    Ok(())
}

/// Join argv for `/bin/sh`, which is what tmux runs the command with, through
/// the one quoter (`crate::shell::quote`, board #125). Building the string
/// ourselves is the point: an agent passes argv, so nothing it contains can
/// turn into shell syntax.
fn join_cmd(argv: &[String]) -> String {
    argv.iter()
        .map(|a| crate::shell::quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// One `list-windows -F` row → a task, or `None` for windows that are not tasks
/// (no `@tmm_task`) or rows tmux truncated.
fn parse_line(line: &str) -> Option<Task> {
    let f: Vec<&str> = line.split(SEP).collect();
    if f.len() < 12 || f[0].is_empty() {
        return None;
    }
    let state = if f[4] != "1" {
        State::Running
    } else if !f[6].is_empty() {
        State::Killed(f[6].to_string())
    } else {
        // Dead with neither a status nor a signal: tmux told us nothing, so say
        // -1 rather than inventing a success.
        State::Exited(f[5].parse().unwrap_or(-1))
    };
    Some(Task {
        name: f[0].to_string(),
        session: f[1].to_string(),
        window: f[2].to_string(),
        pane: f[3].to_string(),
        state,
        pid: f[7].to_string(),
        started: f[8].parse().unwrap_or(0),
        dead_at: f[9].parse().unwrap_or(0),
        wake_error: f[10].to_string(),
        // The command can contain the separator only if a user put it there;
        // rejoin so it survives round-tripping regardless.
        cmd: f[11..].join(SEP),
    })
}

/// tmux writes `Pane is dead (…)` into the pane itself, on the bottom row, and
/// pads the gap above it with blank rows. That is tmux UI text, not the task's
/// output, and leaving it in would spend a bounded tail entirely on padding —
/// the real last lines would fall out of view. So `logs` returns output only
/// and `status` stays the one place that says how the task ended. Applied only
/// to dead tasks, so a running task's output is never second-guessed.
fn strip_dead_marker(text: &str) -> String {
    text.lines()
        .filter(|l| !(l.starts_with("Pane is dead (") && l.ends_with(')')))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Last `limit` lines, optionally filtered first.
fn tail_lines(text: &str, limit: usize, grep: Option<&str>) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if let Some(pat) = grep {
        let pat = pat.to_lowercase();
        lines.retain(|l| l.to_lowercase().contains(&pat));
    }
    let start = lines.len().saturating_sub(limit);
    lines[start..].join("\n")
}

/// Compact age for `list`, so an agent can tell a stuck task from a new one
/// without doing arithmetic on timestamps. `None` (unknown start) reads as "-".
pub fn fmt_age(secs: Option<u64>) -> String {
    match secs {
        None => "-".into(),
        Some(s) if s < 60 => format!("{s}s"),
        Some(s) if s < 3600 => format!("{}m", s / 60),
        Some(s) if s < 86400 => format!("{}h", s / 3600),
        Some(s) => format!("{}d", s / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_argv_into_one_sh_command() {
        let argv: Vec<String> = ["npm", "run", "tauri:dev:release"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(join_cmd(&argv), "npm run tauri:dev:release");

        let argv: Vec<String> = ["sh", "-c", "echo hi; exit 3"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(join_cmd(&argv), "sh -c 'echo hi; exit 3'");
    }

    #[test]
    fn rejects_names_tmux_would_misread() {
        assert!(validate_name("build").is_ok());
        assert!(validate_name("build-web_2").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("--replace").is_err());
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("a.b").is_err());
        assert!(validate_name("a b").is_err());
    }

    fn row(fields: &[&str]) -> String {
        fields.join(SEP)
    }

    /// Field order: task, session, window, pane, dead, status, signal, pid,
    /// started, dead_time, wake_error, cmd.
    #[test]
    fn parses_a_running_task() {
        let t = parse_line(&row(&[
            "dev", "tmux", "3", "%518", "0", "", "", "4242", "1700000000", "", "", "npm run dev",
        ]))
        .expect("row is a task");
        assert_eq!(t.name, "dev");
        assert_eq!(t.state, State::Running);
        assert_eq!(t.state_str(), "running");
        assert_eq!(t.target(), "tmux:3");
        assert_eq!(t.pane, "%518");
        assert_eq!(t.pid, "4242");
        assert_eq!(t.cmd, "npm run dev");
        assert!(t.is_running());
        assert_eq!(t.dead_at, 0, "alive: tmux reports no death time");
        assert_eq!(t.age(1700000030), Some(30));
        // A task started "now" is 0s old, not unknown.
        assert_eq!(fmt_age(t.age(1700000000)), "0s");
    }

    #[test]
    fn parses_exit_code_of_a_finished_task() {
        let t = parse_line(&row(&[
            "build", "tmm-tasks", "1", "%9", "1", "7", "", "0", "0", "1700000900", "", "cargo build",
        ]))
        .expect("row is a task");
        assert_eq!(t.state, State::Exited(7));
        assert_eq!(t.state_str(), "exited:7");
        assert!(!t.is_running());
        assert_eq!(t.dead_at, 1700000900, "#206: the death time rides along for the TTL");
        // Unknown start time must not become a bogus age.
        assert_eq!(t.age(1700000000), None);
    }

    #[test]
    fn a_signal_death_is_not_an_exit_code() {
        let t = parse_line(&row(&[
            "x", "s", "1", "%1", "1", "", "kill", "0", "0", "1700000000", "", "sleep 30",
        ]))
        .unwrap();
        assert_eq!(t.state, State::Killed("kill".into()));
        assert_eq!(t.state_str(), "killed:kill");
        assert!(!t.is_running());
    }

    #[test]
    fn ignores_windows_that_are_not_tasks() {
        // A plain window: @tmm_task is empty.
        assert!(parse_line(&row(&["", "tmux", "1", "%1", "0", "", "", "1", "0", "", "", ""])).is_none());
        assert!(parse_line("garbage").is_none());
    }

    #[test]
    fn dead_pane_without_a_status_is_not_reported_as_success() {
        let t = parse_line(&row(&["x", "s", "1", "%1", "1", "", "", "0", "0", "", "", "c"])).unwrap();
        assert_eq!(t.state, State::Exited(-1));
    }

    #[test]
    fn command_containing_the_separator_round_trips() {
        let t = parse_line(&row(&[
            "x", "s", "1", "%1", "0", "", "", "1", "0", "", "", "echo <TMM_SEP> hi",
        ]))
        .unwrap();
        assert_eq!(t.cmd, "echo <TMM_SEP> hi");
    }

    #[test]
    fn dead_marker_and_its_padding_leave_the_log() {
        // The exact shape capture-pane returns for a finished task: output,
        // blank rows to the bottom of the pane, then tmux's own annotation.
        let captured = "starting\nwork done\n\n\n\nPane is dead (signal int, Wed Aug  5 07:30:08 2026)";
        let cleaned = strip_dead_marker(captured);
        assert_eq!(tail_lines(cleaned.trim_end(), 2, None), "starting\nwork done");
        // Stripped wherever it sits, leaving no gap behind.
        assert_eq!(
            strip_dead_marker("Pane is dead (status 0, x)\nreal output"),
            "real output"
        );
    }

    #[test]
    fn tail_is_bounded_and_keeps_the_end() {
        let text = "a\nb\nc\nd";
        assert_eq!(tail_lines(text, 2, None), "c\nd");
        assert_eq!(tail_lines(text, 99, None), "a\nb\nc\nd");
        assert_eq!(tail_lines("", 5, None), "");
    }

    #[test]
    fn grep_is_case_insensitive_and_still_bounded() {
        let text = "ok\nERROR one\nfine\nerror two\nlast";
        assert_eq!(tail_lines(text, 10, Some("error")), "ERROR one\nerror two");
        // Bounded to the LAST matches, which is what a tail means.
        assert_eq!(tail_lines(text, 1, Some("error")), "error two");
        assert_eq!(tail_lines(text, 10, Some("nope")), "");
    }

    /// The bug: `stop` signalled `#{pane_pid}` — the `sh -c` wrapper — so a
    /// child that survived C-c kept running after the pane went dead and the
    /// task reported killed. Here the wrapper ignores INT (its child inherits
    /// the ignore, so C-c cannot end either), which forces the signal path,
    /// and the child is `nohup`-ed: when the wrapper alone dies the kernel's
    /// SIGHUP to the foreground group is exactly what such a child shrugs
    /// off, and it is what a daemonising dev server does. A signal to the
    /// GROUP reaches it regardless. Needs a tmux server, like the rest of the
    /// Rust suite.
    #[test]
    fn stop_ends_the_whole_process_group_not_just_the_wrapper() {
        let name = format!("tmm-test-pg-{}", std::process::id());
        let mut scratch = tmux::Scratch::new("tasks");
        let session = &scratch.session("s");
        let argv: Vec<String> = ["bash", "-c", "trap '' INT; nohup sleep 300 >/dev/null 2>&1; echo never"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let task = start(&name, &argv, Some(session), true, None, &[]).expect("task starts");
        assert!(task.is_running());
        // Find the sleep: the wrapper's only child. Give bash a moment to fork it.
        let mut child = String::new();
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let out = std::process::Command::new("pgrep").args(["-P", &task.pid]).output().unwrap();
            child = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !child.is_empty() {
                break;
            }
        }
        assert!(!child.is_empty(), "the wrapper (pid {}) forked its sleep", task.pid);
        let alive = |pid: &str| {
            std::process::Command::new("kill").args(["-0", pid]).output().map(|o| o.status.success()).unwrap_or(false)
        };
        assert!(alive(&child), "sleep {child} is running before stop");

        let stopped = stop(&name, true).expect("stop reports the outcome").task;
        assert!(!stopped.is_running(), "the pane went dead: {}", stopped.state_str());
        // The point of the test: the child did not outlive the wrapper.
        let mut gone = false;
        for _ in 0..20 {
            if !alive(&child) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(gone, "sleep {child} was orphaned by stop — only the sh wrapper died");

        let _ = remove(&name);
    }

    /// A PRIVATE tmux server for tests that sweep: a TTL-0 reap on the shared
    /// default server would close every dead task window the developer has —
    /// the production effect, not a test's. The helpers live with the socket
    /// global they guard (`tmux::test_support`, board #349): a test opens ONE
    /// `GlobalSocket` scope (serial check, lock, snapshot; restore on drop)
    /// and starts its private server inside it; the kill names its own socket
    /// on the command line.
    use crate::tmux::test_support::{GlobalSocket, PrivateTmux};

    /// Board #206: a finished task's window is closed by the next `tmm task`
    /// verb once its death is older than the TTL — never a running task, never
    /// a plain dead window, never the verb's own target. Real tmux, TTL 0.
    #[test]
    fn expired_finished_tasks_are_reaped_and_nothing_else_is() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "reap");
        let session = "tmm-test-reap";
        let pid = std::process::id();
        let done = format!("tmm-test-done-{pid}");
        let live = format!("tmm-test-live-{pid}");
        let shielded = format!("tmm-test-shield-{pid}");
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        start(&done, &sh("exit 0"), Some(session), true, None, &[]).expect("done starts");
        start(&shielded, &sh("exit 0"), Some(session), true, None, &[]).expect("shielded starts");
        let running = start(&live, &sh("sleep 300"), Some(session), true, None, &[]).expect("live starts");
        // A plain window that dies with remain-on-exit but no @tmm_task: not ours.
        let plain = tmux::run_tmux(&["new-window", "-d", "-t", session, "-n", "plain", "-P", "-F", "#{pane_id}"])
            .expect("plain window").trim().to_string();
        tmux::run_tmux(&["set-option", "-w", "-t", &plain, "remain-on-exit", "on"]).unwrap();
        tmux::run_tmux(&["respawn-window", "-k", "-t", &plain, "sh -c 'exit 1'"]).unwrap();
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let both_dead = !find(&done).map(|t| t.is_running()).unwrap_or(true)
                && !find(&shielded).map(|t| t.is_running()).unwrap_or(true);
            if both_dead { break; }
        }
        let dead = find(&done).expect("done is still registered");
        assert!(!dead.is_running() && dead.dead_at > 0, "tmux reports the death time: {dead:?}");

        std::env::set_var(TTL_ENV, "0");
        let reaped = reap_expired(Some(&shielded));
        std::env::remove_var(TTL_ENV);
        let names: Vec<&str> = reaped.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec![done.as_str()], "only the expired, unshielded task");
        assert!(find(&done).is_none(), "its window is gone");
        assert!(find(&shielded).is_some(), "the verb's own target is read first, reaped later");
        assert!(find(&live).map(|t| t.is_running()).unwrap_or(false), "a running task is never touched");
        let plain_alive = tmux::run_tmux(&["display", "-p", "-t", &plain, "#{pane_dead}"]).map(|o| o.trim() == "1").unwrap_or(false);
        assert!(plain_alive, "a dead window without @tmm_task is not ours to close");

        // Default TTL: a fresh death is NOT expired.
        assert!(reap_expired(None).is_empty(), "30 min have not passed for the shielded task");
        let _ = stop(&live, false);
        let _ = remove(&shielded);
        let _ = tmux::kill_session(session);
        let _ = running;
    }

    /// Board #206: `stop` ends the process, hands back the last lines and
    /// closes the window; `--keep` leaves the window (and its log) in place.
    #[test]
    fn stop_closes_the_window_with_its_tail_unless_kept() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "stopclose");
        let session = "tmm-test-stopclose";
        let pid = std::process::id();
        let closing = format!("tmm-test-close-{pid}");
        let kept = format!("tmm-test-keep-{pid}");
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        start(&closing, &sh("echo line-one; echo line-two; sleep 300"), Some(session), true, None, &[]).unwrap();
        start(&kept, &sh("echo kept-output; sleep 300"), Some(session), true, None, &[]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));

        let out = stop(&closing, false).expect("stop reports");
        assert!(!out.task.is_running());
        assert!(out.closed, "the window is closed");
        assert!(out.tail.contains("line-one") && out.tail.contains("line-two"), "the tail was read before closing: {:?}", out.tail);
        assert!(find(&closing).is_none(), "no window left behind");

        let kept_out = stop(&kept, true).expect("stop --keep reports");
        assert!(!kept_out.closed && kept_out.tail.is_empty());
        let still = find(&kept).expect("--keep leaves the window");
        assert!(!still.is_running());
        assert!(logs(&kept, 5, None).unwrap().contains("kept-output"), "the log is still readable");
        // Stopping an already finished task closes it too.
        let again = stop(&kept, false).expect("stop on a finished task");
        assert!(again.closed && find(&kept).is_none());
        let _ = tmux::kill_session(session);
    }

    /// Board #275: a `--wake` task runs its wake command exactly once when it
    /// ends by itself, with its exit status filled in; a restart without
    /// `--wake` on the same window clears the hook, and `stop` never wakes.
    #[test]
    fn a_wake_task_runs_its_command_once_at_its_own_end() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "wake");
        let session = "tmm-test-wake";
        let pid = std::process::id();
        let log = std::env::temp_dir().join(format!("tmm-test-wake-{pid}.log"));
        let _ = std::fs::remove_file(&log);
        let wake = format!("echo \"$0 status=#{{pane_dead_status}} sig=#{{pane_dead_signal}} {}\" >> {}", format_literal("#x"), log.display());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let (ended, stopped, cleared) = (format!("tmm-test-w1-{pid}"), format!("tmm-test-w2-{pid}"), format!("tmm-test-w3-{pid}"));
        start(&ended, &sh("sleep 0.3; exit 7"), Some(session), true, Some(&wake), &[]).unwrap();
        start(&stopped, &sh("sleep 300"), Some(session), true, Some(&wake), &[]).unwrap();
        start(&cleared, &sh("sleep 300"), Some(session), true, Some(&wake), &[]).unwrap();
        start(&cleared, &sh("sleep 0.3; exit 3"), Some(session), true, None, &[]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        stop(&stopped, true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let lines: Vec<String> = std::fs::read_to_string(&log).unwrap_or_default().lines().map(str::to_string).collect();
        let _ = std::fs::remove_file(&log);
        let _ = tmux::kill_session(session);
        assert_eq!(lines, vec!["sh status=7 sig= #x".to_string()], "one wake, for the task that ended by itself; a literal # survives");
    }

    /// Board #275 (validator / orchestrator 09:33): a wake that could not be
    /// sent is recorded ON the task, where `task status|list|logs` read it;
    /// a restart of the task clears it.
    #[test]
    fn a_wake_failure_is_recorded_on_the_task_until_it_restarts() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "wakefail");
        let session = "tmm-test-wakefail";
        let name = format!("tmm-test-wf-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        start(&name, &sh("exit 1"), Some(session), true, Some("true"), &[]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(find(&name).unwrap().wake_error, "");
        note_wake_failure(&name, "@lead was not woken (connection refused)\nsecond line dropped").unwrap();
        assert_eq!(find(&name).unwrap().wake_error, "@lead was not woken (connection refused)");
        assert!(list().iter().any(|t| t.name == name && !t.wake_error.is_empty()), "list carries it too");
        start(&name, &sh("sleep 300"), Some(session), true, Some("true"), &[]).unwrap();
        assert_eq!(find(&name).unwrap().wake_error, "", "a new run WITH --wake starts clean (validator 09:54)");
        note_wake_failure(&name, "@lead was not woken (again)").unwrap();
        start(&name, &sh("sleep 300"), Some(session), true, None, &[]).unwrap();
        assert_eq!(find(&name).unwrap().wake_error, "", "and without it");
        let _ = tmux::kill_session(session);
    }

    /// Board #291: a task runs as its starter — `TMM_PROJECT`/`TMM_AGENT`
    /// from `starter_env` reach the command, over whatever the tmux server's
    /// environment says, in a fresh window and in a reused one; a task the
    /// human starts has an empty `TMM_AGENT`, never a stale one.
    #[test]
    fn a_task_runs_with_its_starters_identity() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "starter");
        let session = "tmm-test-starter";
        let name = format!("tmm-test-id-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let print = sh("echo \"agent=[$TMM_AGENT] project=[$TMM_PROJECT] server=[$TMM_SERVER]\"; sleep 300");
        let said = |name: &str| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            logs(name, 5, Some("agent=")).unwrap()
        };
        tmux::ensure_session(session, "/tmp").unwrap();
        tmux::run_tmux(&["set-environment", "-g", "TMM_AGENT", "stale"]).unwrap();
        tmux::run_tmux(&["set-environment", "-g", "TMM_PROJECT", "stale"]).unwrap();

        let dev = starter_env(Some("my proj#x"), Some("dev"), None, Some("ws://h:1"));
        start(&name, &print, Some(session), true, None, &dev).unwrap();
        assert!(said(&name).contains("agent=[dev] project=[my proj#x] server=[ws://h:1]"), "{}", said(&name));

        let human = starter_env(Some("blog"), None, None, None);
        start(&name, &print, Some(session), true, None, &human).unwrap();
        let out = said(&name);
        assert!(out.lines().last().unwrap_or("").contains("agent=[] project=[blog] server=[]"), "a reused window, the human: {out}");
        let _ = tmux::kill_session(session);
    }

    #[test]
    fn ages_read_at_a_glance() {
        assert_eq!(fmt_age(None), "-");
        assert_eq!(fmt_age(Some(0)), "0s");
        assert_eq!(fmt_age(Some(5)), "5s");
        assert_eq!(fmt_age(Some(59)), "59s");
        assert_eq!(fmt_age(Some(60)), "1m");
        assert_eq!(fmt_age(Some(3599)), "59m");
        assert_eq!(fmt_age(Some(3600)), "1h");
        assert_eq!(fmt_age(Some(86399)), "23h");
        assert_eq!(fmt_age(Some(86400)), "1d");
    }
}
