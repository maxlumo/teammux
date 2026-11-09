//! `tmm task` — background tasks as tmux windows. See
//! `docs/design-docs/features/tmm-cli.md`.
//!
//! LOCAL ONLY: nothing here touches the network. `tmm task *` works with no
//! Teammux server running, which is the whole point — the thing an agent
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
/// When a `tmm task` verb first saw the pane dead, unix seconds (board #92):
/// the death clock on a tmux whose `#{pane_dead_time}` is empty (3.2a, this
/// host). Cleared when the pane runs again.
const OPT_DEAD_AT: &str = "@tmm_dead_at";
/// A fresh id per run (board #92 round 2, reviewer note 20, orchestrator
/// note 21): written by every `start` before the command runs, so a guarded
/// stamp or reap can tell one run from the next even within one second.
const OPT_RUN: &str = "@tmm_run";
/// A run id's prefix while `start` is still preparing the window (board #92
/// round 4, orchestrator's rule note 35): no reaper acts on such a window.
const STARTING: &str = "starting:";
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
    /// `@tmm_dead_at` (board #92): unix seconds when a verb first saw it dead,
    /// 0 when unstamped.
    pub dead_stamp: u64,
    /// `@tmm_run`: this run's id, empty for a window an older build started.
    pub run: String,
}

impl Task {
    pub fn target(&self) -> String {
        format!("{}:{}", self.session, self.window)
    }

    pub fn state_str(&self) -> String {
        if self.is_starting() {
            return "starting".into();
        }
        match &self.state {
            State::Running => "running".into(),
            State::Exited(code) => format!("exited:{code}"),
            State::Killed(sig) => format!("killed:{sig}"),
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, State::Running)
    }

    /// `start` is still preparing this window, or died doing so (round 4).
    pub fn is_starting(&self) -> bool {
        self.run.starts_with(STARTING) || self.is_abandoned_start()
    }

    /// A start that died before its first writes landed (board #92 round 5,
    /// orchestrator notes 50-54): `@tmm_task` but no run id, no command and
    /// no start time. A PRE-UPGRADE task has its command and start time (only
    /// the run id is new), so it is an ordinary task with the ordinary death
    /// clock and is reaped by the TTL.
    pub fn is_abandoned_start(&self) -> bool {
        self.run.is_empty() && self.cmd.is_empty() && self.started == 0
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
    try_list().unwrap_or_default()
}

/// `list`, but "tmux could not be asked" is an error and not "no tasks": a
/// caller that acts on the absence of a running task must tell the two apart.
pub fn try_list() -> std::result::Result<Vec<Task>, String> {
    tmux::run_tmux(&["list-windows", "-a", "-F", &list_format()]).map(|out| out.lines().filter_map(parse_line).collect())
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
        format!("#{{{OPT_DEAD_AT}}}"),
        format!("#{{{OPT_RUN}}}"),
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
/// #206), by the one death clock (`death_step`, board #92). Only windows
/// carrying `@tmm_task` (that is all `list` returns) and only dead ones — a
/// running task is never touched (only a stale stamp is cleared), nor a
/// plain window that happens to be dead. `except` shields the
/// verb's own target so `logs`/`status`/`rm` on an expired task still answer;
/// callers reap AFTER their own work. Returns what was closed.
pub fn reap_expired(except: Option<&str>) -> Vec<Task> {
    let ttl = ttl_secs();
    let now = unix_now();
    let mut reaped = Vec::new();
    for t in list() {
        let shielded = Some(t.name.as_str()) == except;
        let step = death_step(t.is_starting(), t.is_running(), t.dead_at, t.dead_stamp, now, ttl);
        #[cfg(test)]
        if !matches!(step, DeathStep::Nothing | DeathStep::Wait) {
            if let Some(hook) = BEFORE_REAP_MUTATION.lock().unwrap().as_ref() {
                hook(&t.name);
            }
        }
        match step {
            DeathStep::Clear => { let _ = if_same_run(&t, false, &format!("set-option -w -u -t {} {OPT_DEAD_AT}", t.pane)); }
            DeathStep::Stamp => { let _ = if_same_run(&t, true, &format!("set-option -w -t {} {OPT_DEAD_AT} {now}", t.pane)); }
            DeathStep::Reap if !shielded => {
                let _ = if_same_run(&t, true, &format!("kill-window -t {}", t.pane));
                // Gone is read from the pane list: on tmux 3.2a `display -t`
                // of a killed pane still exits 0 (measured).
                let alive = tmux::run_tmux(&["list-panes", "-a", "-F", "#{pane_id}"]).map(|o| o.lines().any(|l| l == t.pane)).unwrap_or(true);
                if !alive {
                    reaped.push(t);
                }
            }
            DeathStep::Reap | DeathStep::Wait | DeathStep::Nothing => {}
        }
    }
    reaped
}

/// A fresh window's first write (round 5): its task name and its start's
/// transitional run id, in ONE tmux invocation.
fn publish_fresh(pane: &str, name: &str, transitional: &str) -> Result<()> {
    tmux::run_tmux(&["set-option", "-w", "-t", pane, OPT_TASK, name, ";", "set-option", "-w", "-t", pane, OPT_RUN, transitional])
        .map(|_| ())
        .map_err(Error::Tmux)
}

/// Run one tmux command for the start that owns the window by its
/// transitional id `tr` (board #92 round 4, orchestrator note 40): one native
/// `if-shell -F` on `@tmm_run == tr`, then the id is read back; another id
/// means a later start took the window, and the caller stops. Each argument
/// is single-quoted for tmux's parser (measured on 3.2a: quotes, `$`, `;`,
/// `#{}`, `~`, braces, backslashes and newlines round-trip).
fn guarded(pane: &str, tr: &str, name: &str, argv: &[&str]) -> Result<()> {
    let command = argv.iter().map(|a| tmux_quote(a)).collect::<Vec<_>>().join(" ");
    let cond = format!("#{{==:#{{{OPT_RUN}}},{tr}}}");
    tmux::run_tmux(&["if-shell", "-F", "-t", pane, &cond, &command]).map_err(Error::Tmux)?;
    owned_by(pane, tr, name)
}

/// The window's run id is `id`, else a later start owns it.
fn owned_by(pane: &str, id: &str, name: &str) -> Result<()> {
    if read_run(pane)? == id { Ok(()) } else { Err(superseded(name)) }
}

fn read_run(pane: &str) -> Result<String> {
    tmux::run_tmux(&["display-message", "-p", "-t", pane, &format!("#{{{OPT_RUN}}}")])
        .map(|s| s.trim().to_string())
        .map_err(Error::Tmux)
}

fn superseded(name: &str) -> Error {
    Error::Invalid(format!("task '{name}': a later start took its window before this one finished; it is that start's now"))
}

/// `s` as ONE word for tmux's command parser: single quotes, an embedded `'`
/// written as `'"'"'` (adjacent quoted parts join, as in sh).
fn tmux_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Run `command` only if the window still holds the RUN `t` observed, in the
/// state it was observed in (board #92 round 2, reviewer notes 17 and 20,
/// orchestrator's rules 19 and 21): its run id `@tmm_run` (a whole-second
/// `@tmm_started` cannot tell two quick runs apart) and its pane pid are the
/// observed ones, and it is dead (`dead`) or alive (`!dead`). One `if-shell
/// -F` evaluated by the tmux server, which serialises every client, so a
/// `tmm task start` in another process that reuses the window between our
/// look and our write leaves the replacement unstamped and unkilled. No lock
/// of ours, no daemon, no wait. Measured on tmux 3.2a: `#{&&:…}` and
/// `#{==:…}` evaluate in `if-shell -F`.
fn if_same_run(t: &Task, dead: bool, command: &str) -> std::result::Result<String, String> {
    let cond = format!(
        "#{{&&:#{{==:#{{{OPT_RUN}}},{}}},#{{&&:#{{==:#{{pane_pid}},{}}},#{{==:#{{pane_dead}},{}}}}}}}",
        t.run, t.pid, if dead { 1 } else { 0 }
    );
    tmux::run_tmux(&["if-shell", "-F", "-t", &t.pane, &cond, command])
}

/// Test seam: inside `start`, right after the new run id is written and
/// before anything else (validator note 27's boundary).
#[cfg(test)]
pub(crate) static AFTER_RUN_ID: std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>> = std::sync::Mutex::new(None);

/// Call a `start` seam without holding its lock: the hook is taken out for
/// the call and put back after, so a hook that runs another `start` (which
/// passes the same seam) neither deadlocks nor recurses.
#[cfg(test)]
fn seam(slot: &std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>>, pane: &str) {
    let hook = slot.lock().unwrap().take();
    if let Some(hook) = hook {
        hook(pane);
        let mut back = slot.lock().unwrap();
        if back.is_none() { *back = Some(hook); }
    }
}

/// Test seam: inside `start`, right before its guarded respawn (reviewer
/// note 39's boundary).
#[cfg(test)]
pub(crate) static BEFORE_RESPAWN: std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>> = std::sync::Mutex::new(None);

/// Test seam: inside `start`, after the respawn and before the final id is
/// published (reviewer note 37's boundary).
#[cfg(test)]
pub(crate) static BEFORE_PUBLISH: std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>> = std::sync::Mutex::new(None);

/// Test seam: after the reaper observed a task and decided to change it,
/// before its guarded write (reviewer note 17's interleaving).
#[cfg(test)]
pub(crate) static BEFORE_REAP_MUTATION: std::sync::Mutex<Option<Box<dyn Fn(&str) + Send>>> = std::sync::Mutex::new(None);

/// What the reaper does with one task window (board #92): ONE death clock,
/// tmux's `#{pane_dead_time}` when it reports one (3.6a), else the
/// `@tmm_dead_at` stamp the first verb that saw the pane dead wrote (3.2a
/// reports nothing). A dead, unstamped pane is stamped now and is not reaped
/// this time; a pane running again loses its stamp, so a respawn starts a
/// new death clock. A window in the middle of a start (a transitional run
/// id, board #92 round 4) is never acted on: its pane, pid and clock may
/// still be the previous run's.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeathStep { Nothing, Clear, Stamp, Wait, Reap }

pub(crate) fn death_step(starting: bool, running: bool, dead_at: u64, stamp: u64, now: u64, ttl: u64) -> DeathStep {
    if starting {
        return DeathStep::Nothing;
    }
    if running {
        return if stamp > 0 { DeathStep::Clear } else { DeathStep::Nothing };
    }
    let clock = if dead_at > 0 { dead_at } else { stamp };
    if clock == 0 {
        DeathStep::Stamp
    } else if now.saturating_sub(clock) >= ttl {
        DeathStep::Reap
    } else {
        DeathStep::Wait
    }
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

    // A fresh window has nothing to invalidate; a reused one does.
    let mut fresh = false;
    let pane = match find(name) {
        // An abandoned start (round 5) is taken over, never refused.
        Some(t) if t.is_running() && !replace && !t.is_starting() => {
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
            fresh = true;
            create_window(&session, name, &cwd)?
        }
        None => { fresh = true; create_window(&session, name, &cwd)? }
    };

    // A TRANSITIONAL run id FIRST (board #92 rounds 2-4; validator note 27,
    // orchestrator's rules notes 28 and 35): before anything else of the
    // window is touched, so from the first mutation on no reaper guard bound
    // to the previous run (`if_same_run`) can pass, and a reaper that looks
    // now (new id, old dead pane, old clock: reviewer note 34) does nothing
    // (`death_step`). The final id is published after the respawn.
    let run = uuid::Uuid::new_v4().to_string();
    let transitional = format!("{STARTING}{run}");
    if fresh {
        // A window this start just made (round 5, orchestrator notes 50 and
        // 52): its name and the transitional id are published in ONE tmux
        // invocation, so no reader sees one without the other. tmux runs a
        // client's command list in one go when no command in it waits (the
        // client queue runs until an item blocks), and `set-option` never
        // does; measured on 3.2a by `a_fresh_start_publishes_its_name_and_
        // its_transition_together`. A reused window already carries its
        // name, so the transitional id stays its first write.
        publish_fresh(&pane, name, &transitional)?;
    } else {
        set_opt(&pane, OPT_RUN, &transitional)?;
    }
    #[cfg(test)]
    seam(&AFTER_RUN_ID, &pane);
    // Every later mutation belongs to THIS start (reviewer note 39,
    // orchestrator note 40): each runs through the native guard on our
    // transitional id, and the first one that finds another id means a later
    // start owns the window; this one stops without touching it.
    let own = |argv: &[&str]| guarded(&pane, &transitional, name, argv);
    let now = unix_now();
    own(&["set-option", "-w", "-t", &pane, "remain-on-exit", "on"])?;
    own(&["set-option", "-w", "-t", &pane, OPT_TASK, name])?;
    own(&["set-option", "-w", "-t", &pane, OPT_CMD, &cmd])?;
    own(&["set-option", "-w", "-t", &pane, OPT_STARTED, &now.to_string()])?;
    // The wake hook is set or cleared on EVERY start: a reused window must not
    // keep a previous run's hook. Measured on tmux 3.6a: `pane-died` fires
    // once per death with the status or signal, and not for a command that
    // `respawn -k` replaces.
    // A new run starts clean: an earlier run's recorded wake failure is
    // cleared on EVERY start, with or without --wake (validator 09:54).
    own(&["set-option", "-w", "-u", "-t", &pane, OPT_WAKE_ERR])?;
    // A new run is a new life (board #92 round 1, validator note 7): a reused
    // window's death stamp is cleared BEFORE the command runs, so a run that
    // exits before any verb sees it alive is never judged by the old death.
    // It must not fail silently: a stale stamp would reap the new run's
    // output at once, so a start that cannot clear it is refused.
    own(&["set-option", "-w", "-u", "-t", &pane, OPT_DEAD_AT])?;
    match wake {
        Some(shell) => {
            own(&["set-option", "-p", "-t", &pane, OPT_WAKE, shell])?;
            own(&["set-hook", "-p", "-t", &pane, "pane-died", WAKE_HOOK])?;
        }
        None => {
            own(&["set-hook", "-p", "-u", "-t", &pane, "pane-died"])?;
            own(&["set-option", "-p", "-u", "-t", &pane, OPT_WAKE])?;
        }
    }
    let pairs: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let mut args = vec!["respawn-window", "-k"];
    for pair in &pairs {
        args.extend(["-e", pair.as_str()]);
    }
    args.extend(["-t", pane.as_str(), cmd.as_str()]);
    #[cfg(test)]
    seam(&BEFORE_RESPAWN, &pane);
    own(&args)?;
    // The run is complete: publish its final id, only over our own
    // transitional one, through the same guard (reviewer note 37): a later
    // start that already wrote its own transition keeps it, and this one
    // reports that (orchestrator note 38).
    #[cfg(test)]
    seam(&BEFORE_PUBLISH, &pane);
    let cond = format!("#{{==:#{{{OPT_RUN}}},{transitional}}}");
    let publish = ["set-option", "-w", "-t", &pane, OPT_RUN, &run].map(tmux_quote).join(" ");
    tmux::run_tmux(&["if-shell", "-F", "-t", &pane, &cond, &publish]).map_err(Error::Tmux)?;
    owned_by(&pane, &run, name)?;

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
    // `new-window -t` takes a target WINDOW: a bare session name resolved to a
    // window whose name starts with it, and tmux aimed the new window at that
    // window's index ("index 1 in use", board #58). `=session:` names the
    // session exactly and lets tmux pick the next free index.
    let target = tmux::exact_session(session);
    let mut args = vec![
        "new-window", "-d", "-t", &target, "-n", name, "-P", "-F", "#{pane_id}",
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
/// speaks as the human. `TMM_SERVER` is always present too, for the same
/// reason (board #407: a server inherited from the tmux server's environment
/// sent a human's task to a gateway its starter never named). The config dir
/// travels only when the starter has one: it is not ours to blank for every
/// program the task runs. `TMM_SOCKET` (board #440) travels like
/// `TMM_SERVER`: always written, the starter's EFFECTIVE local socket after
/// tmm's selection table, empty when it had none, so a stale tmux-global
/// value never sends a task's tmm to another gateway's socket.
pub fn starter_env(project: Option<&str>, agent: Option<&str>, config: Option<&str>, server: Option<&str>, socket: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("TMM_PROJECT".to_string(), project.unwrap_or_default().to_string()),
        ("TMM_AGENT".to_string(), agent.unwrap_or_default().to_string()),
    ];
    if let Some(c) = config { env.push(("XDG_CONFIG_HOME".into(), c.into())); }
    env.push(("TMM_SERVER".into(), server.unwrap_or_default().into()));
    env.push(("TMM_SOCKET".into(), socket.unwrap_or_default().into()));
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
    if f.len() < 14 || f[0].is_empty() {
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
        dead_stamp: f[11].parse().unwrap_or(0),
        run: f[12].to_string(),
        // The command can contain the separator only if a user put it there;
        // rejoin so it survives round-tripping regardless.
        cmd: f[13..].join(SEP),
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
        // tmux 3.2a pads the annotation to the pane's width (board #58).
        .filter(|l| !(l.starts_with("Pane is dead (") && l.trim_end().ends_with(')')))
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
    /// started, dead_time, wake_error, dead_stamp, run, cmd.
    #[test]
    fn parses_a_running_task() {
        let t = parse_line(&row(&[
            "dev", "tmux", "3", "%518", "0", "", "", "4242", "1700000000", "", "", "", "", "npm run dev",
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
            "build", "tmm-tasks", "1", "%9", "1", "7", "", "0", "0", "1700000900", "", "", "", "cargo build",
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
            "x", "s", "1", "%1", "1", "", "kill", "0", "0", "1700000000", "", "", "", "sleep 30",
        ]))
        .unwrap();
        assert_eq!(t.state, State::Killed("kill".into()));
        assert_eq!(t.state_str(), "killed:kill");
        assert!(!t.is_running());
    }

    /// Board #92: ONE death clock, tmux's when it reports one, else the stamp
    /// the first verb that saw the pane dead wrote; a running pane loses its
    /// stamp. Literal times: death at 1000, TTL 60.
    #[test]
    fn the_death_clock_is_tmux_s_or_the_first_verb_s_stamp() {
        assert_eq!(death_step(false, false, 1000, 0, 1059, 60), DeathStep::Wait, "3.6a: tmux's clock, inside the TTL");
        assert_eq!(death_step(false, false, 1000, 0, 1060, 60), DeathStep::Reap, "3.6a: TTL after tmux's death time");
        assert_eq!(death_step(false, false, 0, 0, 1060, 60), DeathStep::Stamp, "3.2a: dead and unstamped is stamped, not reaped");
        assert_eq!(death_step(false, false, 0, 1000, 1059, 60), DeathStep::Wait, "stamped, inside the TTL");
        assert_eq!(death_step(false, false, 0, 1000, 1060, 60), DeathStep::Reap, "stamped more than TTL ago");
        assert_eq!(death_step(false, false, 1000, 500, 1059, 60), DeathStep::Wait, "tmux's clock wins over a stamp");
        assert_eq!(death_step(false, true, 0, 1000, 5000, 60), DeathStep::Clear, "running again: the stamp is cleared");
        assert_eq!(death_step(false, true, 0, 0, 5000, 60), DeathStep::Nothing, "a running task is never touched");
        assert_eq!(death_step(true, false, 0, 1000, 5000, 60), DeathStep::Nothing, "mid-start (round 4): an expired clock is not acted on");
        assert_eq!(death_step(true, false, 0, 0, 5000, 60), DeathStep::Nothing, "mid-start: no stamp either");
        assert_eq!(death_step(true, true, 0, 1000, 5000, 60), DeathStep::Nothing, "mid-start: no clear either");
        let t = parse_line(&row(&["x", "s", "1", "%1", "1", "0", "", "0", "0", "", "", "1700000100", "", "c"])).unwrap();
        assert_eq!((t.dead_at, t.dead_stamp), (0, 1700000100), "the stamp rides along as its own field");
    }

    /// Board #92 round 2 (reviewer note 17, orchestrator note 19): an old
    /// reaper paused after observing a dead run, while the same name is
    /// restarted (another tmm process, here the hook) and its new run exits at
    /// once, never stamps nor kills the replacement on resume: the guarded
    /// write re-checks the observed run at the tmux server. Both decisions:
    /// the stamp (no death time on 3.2a) and the reap (an expired stamp).
    #[test]
    fn a_paused_reaper_never_stamps_or_kills_a_run_that_replaced_the_one_it_saw() {
        let session = "tmm-test-race";
        let name = format!("tmm-test-race-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let wait_dead = |n: &str| {
            for _ in 0..30 {
                if find(n).is_some_and(|t| !t.is_running()) { return; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { *BEFORE_REAP_MUTATION.lock().unwrap() = None; } }
        let _reset = Reset;
        for (case, old_stamp) in [("stamp", None), ("reap", Some("1"))] {
            start(&name, &sh("echo old-run"), Some(session), true, None, &[]).expect("old run");
            wait_dead(&name);
            let old = find(&name).expect("old window");
            if let Some(v) = old_stamp { set_opt(&old.pane, OPT_DEAD_AT, v).unwrap(); }
            let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (n, f) = (name.clone(), fired.clone());
            *BEFORE_REAP_MUTATION.lock().unwrap() = Some(Box::new(move |seen: &str| {
                if seen != n || f.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
                let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
                start(&n, &sh("echo new-run"), Some("tmm-test-race"), true, None, &[]).expect("the name is reused meanwhile");
                for _ in 0..30 {
                    if find(&n).is_some_and(|t| !t.is_running()) { break; }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }));
            std::env::remove_var(TTL_ENV);
            let reaped = reap_expired(None);
            *BEFORE_REAP_MUTATION.lock().unwrap() = None;
            assert!(fired.load(std::sync::atomic::Ordering::SeqCst), "{case}: the reaper paused at its write");
            assert!(!reaped.iter().any(|t| t.name == name), "{case}: the replacement is not reaped");
            let now = find(&name).expect("the replacement's window stays");
            assert_eq!(now.pane, old.pane, "{case}: the same window was reused");
            assert_ne!(now.pid, old.pid, "{case}: a new run");
            assert!(!now.run.is_empty() && !old.run.is_empty() && now.run != old.run, "{case}: each run has its own id ({} vs {})", old.run, now.run);
            eprintln!("{case}: old started {} new started {} (same second: {})", old.started, now.started, old.started == now.started);
            assert_eq!(now.dead_stamp, 0, "{case}: no stamp from the old observation: {now:?}");
            assert!(logs(&name, 20, None).unwrap().contains("new-run"), "{case}: its output stays");
        }
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Board #92 round 4 (reviewer note 34, orchestrator's rule note 35): a
    /// FRESH reaper that looks at the window in the middle of a start (new
    /// id, old dead pane, old expired stamp) sees a transitional run and does
    /// nothing; the start completes, with its final id, and keeps its output.
    #[test]
    fn a_fresh_reaper_in_the_middle_of_a_start_leaves_the_window_alone() {
        let session = "tmm-test-midstart";
        let name = format!("tmm-test-midstart-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let wait_dead = || {
            for _ in 0..30 {
                if find(&name).is_some_and(|t| !t.is_running()) { return; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { *AFTER_RUN_ID.lock().unwrap() = None; std::env::remove_var(TTL_ENV); } }
        let _reset = Reset;
        start(&name, &sh("echo old-run"), Some(session), true, None, &[]).expect("old run");
        wait_dead();
        let old = find(&name).expect("old run listed");
        tmux::run_tmux(&["set-option", "-w", "-t", &old.pane, OPT_DEAD_AT, "1"]).expect("an expired death stamp");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
        let record = seen.clone();
        let target = name.clone();
        *AFTER_RUN_ID.lock().unwrap() = Some(Box::new(move |_pane: &str| {
            // A new reaper, TTL 0, observing NOW.
            std::env::set_var(TTL_ENV, "0");
            let reaped = reap_expired(None);
            std::env::remove_var(TTL_ENV);
            let now = find(&target).map(|t| (t.run.clone(), t.state_str()));
            record.lock().unwrap().push((format!("reaped {}", reaped.len()), format!("{now:?}")));
        }));
        let started = start(&name, &sh("echo new-run"), Some(session), true, None, &[]);
        *AFTER_RUN_ID.lock().unwrap() = None;
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "the hook ran once");
        assert!(seen[0].0 == "reaped 0", "the mid-start reaper reaped nothing: {seen:?}");
        assert!(seen[0].1.contains("starting:") && seen[0].1.contains("\"starting\""), "listed as starting, transitional id: {seen:?}");
        let started = started.expect("the start completes");
        assert!(!started.run.is_empty() && !started.run.starts_with(STARTING), "the final id is published: {}", started.run);
        wait_dead();
        let t = find(&name).expect("the new run's window stays");
        assert_eq!(t.run, started.run);
        assert_eq!(t.dead_stamp, 0, "no stamp inherited");
        assert!(logs(&name, 20, None).unwrap().contains("new-run"));
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Reviewer note 37: a start whose window a LATER start took over (its
    /// own transition written) before the first published its final id
    /// leaves the later transition untouched.
    #[test]
    fn a_stale_finalizer_leaves_a_newer_transition_untouched() {
        let session = "tmm-test-publish";
        let name = format!("tmm-test-publish-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { *BEFORE_PUBLISH.lock().unwrap() = None; } }
        let _reset = Reset;
        let newer = format!("{STARTING}newer-start");
        let write = newer.clone();
        *BEFORE_PUBLISH.lock().unwrap() = Some(Box::new(move |pane: &str| {
            tmux::run_tmux(&["set-option", "-w", "-t", pane, OPT_RUN, &write]).expect("the later start's transition");
        }));
        let first = start(&name, &sh("sleep 5"), Some(session), true, None, &[]);
        *BEFORE_PUBLISH.lock().unwrap() = None;
        let err = first.expect_err("the earlier start reports it lost the window").to_string();
        assert!(err.contains("a later start took its window"), "{err}");
        assert_eq!(find(&name).unwrap().run, newer);
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Reviewer note 39, orchestrator note 40: start A paused right before its
    /// respawn while start B of the same name runs to completion; A resumes,
    /// finds B's id, reports superseded, and B's PROCESS survives (same pid,
    /// running, its final id), not only B's id.
    #[test]
    fn an_earlier_start_resuming_before_its_respawn_leaves_the_later_run_running() {
        let session = "tmm-test-interleave";
        let name = format!("tmm-test-interleave-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { *BEFORE_RESPAWN.lock().unwrap() = None; } }
        let _reset = Reset;
        start(&name, &sh("true"), Some(session), true, None, &[]).expect("a first run makes the window");
        let b_seen = std::sync::Arc::new(std::sync::Mutex::new(None::<Task>));
        let record = b_seen.clone();
        let (n, s) = (name.clone(), session.to_string());
        let once = std::sync::atomic::AtomicBool::new(false);
        *BEFORE_RESPAWN.lock().unwrap() = Some(Box::new(move |_pane: &str| {
            // B, the later start, runs whole while A waits here; B passes its
            // own seam straight through (the seam's lock is held, so it is
            // not taken again, see `seam` in start).
            if once.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
            let b = start(&n, &["sh".into(), "-c".into(), "echo B; sleep 30".into()], Some(&s), true, None, &[]).expect("B starts");
            *record.lock().unwrap() = Some(b);
        }));
        let a = start(&name, &sh("echo A"), Some(session), true, None, &[]);
        let err = a.expect_err("A reports it lost the window").to_string();
        assert!(err.contains("a later start took its window"), "{err}");
        let b = b_seen.lock().unwrap().clone().expect("B ran inside the seam");
        let now = find(&name).expect("B's window");
        assert!(now.is_running(), "B's process still runs: {now:?}");
        assert_eq!(now.pid, b.pid, "the same process B started: A's respawn never ran");
        assert_eq!(now.run, b.run, "B's final id");
        assert!(now.cmd.contains("echo B") && !now.cmd.contains("echo A"), "B's command, not A's: {}", now.cmd);
        let _ = stop(&name, false);
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Round 5 (orchestrator notes 50-54): a fresh window's name and its
    /// transitional id land together. An observer polling every window
    /// while 150 fresh windows get their first write never sees a name
    /// without a run id (measured on this tmux).
    #[test]
    fn a_fresh_start_publishes_its_name_and_its_transition_together() {
        let session = "tmm-test-pair";
        let cwd = { let d = crate::config::test_scratch("tmm-task-cwd"); std::fs::create_dir_all(&d).unwrap(); d.to_string_lossy().to_string() };
        tmux::ensure_session(session, &cwd).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = std::sync::Arc::new(std::sync::Mutex::new((0usize, Vec::<String>::new())));
        let (st, sn) = (stop.clone(), seen.clone());
        let observer = std::thread::spawn(move || {
            while !st.load(std::sync::atomic::Ordering::SeqCst) {
                if let Ok(out) = tmux::run_tmux(&["list-windows", "-t", session, "-F", &format!("#{{{OPT_TASK}}}|#{{{OPT_RUN}}}")]) {
                    let mut g = sn.lock().unwrap();
                    g.0 += 1;
                    for l in out.lines() {
                        let (task, run) = l.split_once('|').unwrap_or((l, ""));
                        if !task.is_empty() && run.is_empty() { g.1.push(l.to_string()); }
                    }
                }
            }
        });
        for i in 0..150 {
            let name = format!("pair-{i}");
            let pane = create_window(session, &name, &cwd).unwrap();
            publish_fresh(&pane, &name, &format!("{STARTING}{i}")).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        observer.join().unwrap();
        let (reads, split) = seen.lock().unwrap().clone();
        assert!(reads > 20, "the observer read the windows {reads} times");
        assert!(split.is_empty(), "a name without its run id was seen: {split:?}");
        let _ = tmux::kill_session(session);
    }

    /// Round 5 (reviewer note 55, orchestrator note 54): a fresh window that
    /// got only its NAME (a start interrupted right after its first write,
    /// as an older order could leave it) is listed as starting, never as
    /// running or absent, and a default start takes it over. A PRE-UPGRADE
    /// task (name, command and start time, no run id) is an ordinary task:
    /// finished, the TTL reaps it.
    #[test]
    fn an_abandoned_fresh_start_is_listed_and_taken_over_and_a_legacy_task_is_still_reaped() {
        let session = "tmm-test-abandon";
        let name = format!("tmm-test-abandon-{}", std::process::id());
        let cwd = { let d = crate::config::test_scratch("tmm-task-cwd"); std::fs::create_dir_all(&d).unwrap(); d.to_string_lossy().to_string() };
        tmux::ensure_session(session, &cwd).unwrap();
        let pane = create_window(session, &name, &cwd).unwrap();
        set_opt(&pane, OPT_TASK, &name).unwrap();
        let t = find(&name).expect("an abandoned start is listed");
        assert_eq!(t.state_str(), "starting", "{t:?}");
        assert!(t.is_running(), "(its pane is the fresh shell)");
        std::env::set_var(TTL_ENV, "0");
        assert!(!reap_expired(None).iter().any(|r| r.name == name), "never reaped");
        std::env::remove_var(TTL_ENV);
        let started = start(&name, &["sh".into(), "-c".into(), "echo taken".into()], Some(session), false, None, &[]).expect("a default start takes it over");
        assert!(!started.is_starting() && !started.run.is_empty());
        let _ = remove(&name);

        // A pre-upgrade finished task: name, command and start time; no run id.
        let legacy = format!("tmm-test-legacy-{}", std::process::id());
        let lp = create_window(session, &legacy, &cwd).unwrap();
        set_opt(&lp, "remain-on-exit", "on").unwrap();
        set_opt(&lp, OPT_TASK, &legacy).unwrap();
        set_opt(&lp, OPT_CMD, "sh -c true").unwrap();
        set_opt(&lp, OPT_STARTED, &unix_now().to_string()).unwrap();
        tmux::run_tmux(&["respawn-pane", "-k", "-t", &lp, "true"]).unwrap();
        for _ in 0..30 { if find(&legacy).is_some_and(|t| !t.is_running()) { break; } std::thread::sleep(std::time::Duration::from_millis(100)); }
        let t = find(&legacy).expect("listed");
        assert!(!t.is_starting() && t.run.is_empty(), "a legacy task is not a start: {t:?}");
        std::env::set_var(TTL_ENV, "0");
        let first = reap_expired(None);
        let second = reap_expired(None);
        std::env::remove_var(TTL_ENV);
        assert!(first.iter().chain(second.iter()).any(|r| r.name == legacy), "reaped by the TTL (stamp, then reap on 3.2a)");
        let _ = tmux::kill_session(session);
    }

    /// A start that died mid-way leaves a transitional id: the TTL never
    /// reaps it, `list` names it `starting`, and the next start replaces it.
    #[test]
    fn a_transitional_window_is_never_reaped_and_the_next_start_replaces_it() {
        let session = "tmm-test-transit";
        let name = format!("tmm-test-transit-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        start(&name, &sh("true"), Some(session), true, None, &[]).expect("a run");
        for _ in 0..30 { if find(&name).is_some_and(|t| !t.is_running()) { break; } std::thread::sleep(std::time::Duration::from_millis(100)); }
        let t = find(&name).unwrap();
        tmux::run_tmux(&["set-option", "-w", "-t", &t.pane, OPT_RUN, &format!("{STARTING}abandoned")]).unwrap();
        tmux::run_tmux(&["set-option", "-w", "-t", &t.pane, OPT_DEAD_AT, "1"]).unwrap();
        std::env::set_var(TTL_ENV, "0");
        let reaped = reap_expired(None);
        std::env::remove_var(TTL_ENV);
        assert!(!reaped.iter().any(|r| r.name == name), "a transitional window is not reaped");
        let t = find(&name).expect("still listed");
        assert_eq!(t.state_str(), "starting");
        let again = start(&name, &sh("echo again"), Some(session), true, None, &[]).expect("the next start");
        assert!(!again.run.starts_with(STARTING), "replaced by a final id");
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Board #92 round 3 (validator note 27, orchestrator note 28): a reaper
    /// paused between its observation of the OLD run and its guarded write,
    /// resuming at the start boundary right after the new run id is written
    /// (and before the old stamp is cleared), can neither stamp nor kill:
    /// its guard names the old run. Both paths, stamp and reap.
    #[test]
    fn a_reaper_resuming_at_the_start_boundary_cannot_touch_the_new_run() {
        let session = "tmm-test-boundary";
        let name = format!("tmm-test-boundary-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let wait_dead = || {
            for _ in 0..30 {
                if find(&name).is_some_and(|t| !t.is_running()) { return; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { *AFTER_RUN_ID.lock().unwrap() = None; } }
        let _reset = Reset;
        for case in ["stamp", "reap"] {
            start(&name, &sh("echo old-run"), Some(session), true, None, &[]).expect("old run");
            wait_dead();
            let observed = find(&name).expect("the reaper's observation of the old run");
            let (seen, c) = (observed.clone(), case);
            *AFTER_RUN_ID.lock().unwrap() = Some(Box::new(move |_pane: &str| {
                // The paused reaper resumes HERE, with its old observation.
                let cmd = if c == "stamp" { format!("set-option -w -t {} {OPT_DEAD_AT} 1", seen.pane) } else { format!("kill-window -t {}", seen.pane) };
                let _ = if_same_run(&seen, true, &cmd);
            }));
            start(&name, &sh("echo new-run"), Some(session), true, None, &[]).expect("the name is reused");
            *AFTER_RUN_ID.lock().unwrap() = None;
            wait_dead();
            let now = find(&name).expect(&format!("{case}: the new run's window stays"));
            assert_eq!(now.pane, observed.pane, "{case}: same window");
            assert_ne!(now.run, observed.run, "{case}: a new run id");
            assert_eq!(now.dead_stamp, 0, "{case}: the old observation left no stamp: {now:?}");
            std::env::remove_var(TTL_ENV);
            assert!(!reap_expired(None).iter().any(|t| t.name == name), "{case}: not reaped by the default TTL");
            assert!(logs(&name, 20, None).unwrap().contains("new-run"), "{case}: its output stays");
        }
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    /// Board #92 round 1 (validator note 7): a name reused for a run that
    /// exits at once is judged by ITS death, never the old run's stamp. Real
    /// tmux (3.2a in the isolated runner): the old window carries an expired
    /// stamp; the new run finishes before any verb sees it alive; with the
    /// default TTL the reaper keeps its window and output.
    #[test]
    fn a_reused_name_is_never_judged_by_the_old_run_s_stamp() {
        let session = "tmm-test-reuse";
        let name = format!("tmm-test-reuse-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let wait_dead = || {
            for _ in 0..30 {
                if find(&name).is_some_and(|t| !t.is_running()) { return; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        start(&name, &sh("echo old-run"), Some(session), true, None, &[]).expect("old run starts");
        wait_dead();
        let old = find(&name).expect("the old run's window");
        set_opt(&old.pane, OPT_DEAD_AT, "1").expect("an old, long-expired stamp");
        start(&name, &sh("echo new-run"), Some(session), true, None, &[]).expect("the name is reused");
        wait_dead();
        let new = find(&name).expect("the new run's window");
        assert_eq!(new.pane, old.pane, "the same window is reused");
        assert_eq!(new.dead_stamp, 0, "the start cleared the old stamp: {new:?}");
        std::env::remove_var(TTL_ENV);
        let reaped = reap_expired(None);
        assert!(!reaped.iter().any(|t| t.name == name), "the new run is not reaped by the old death");
        let kept = find(&name).expect("its window and output stay");
        assert!(kept.dead_at > 0 || kept.dead_stamp > 1, "and it now carries its own death clock: {kept:?}");
        assert!(logs(&name, 20, None).expect("logs read").contains("new-run"), "the new run's output is readable");
        let _ = remove(&name);
        let _ = tmux::kill_session(session);
    }

    #[test]
    fn ignores_windows_that_are_not_tasks() {
        // A plain window: @tmm_task is empty.
        assert!(parse_line(&row(&["", "tmux", "1", "%1", "0", "", "", "1", "0", "", "", "", "", ""])).is_none());
        assert!(parse_line("garbage").is_none());
    }

    #[test]
    fn dead_pane_without_a_status_is_not_reported_as_success() {
        let t = parse_line(&row(&["x", "s", "1", "%1", "1", "", "", "0", "0", "", "", "", "", "c"])).unwrap();
        assert_eq!(t.state, State::Exited(-1));
    }

    #[test]
    fn command_containing_the_separator_round_trips() {
        let t = parse_line(&row(&[
            "x", "s", "1", "%1", "0", "", "", "1", "0", "", "", "", "", "echo <TMM_SEP> hi",
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
        // Board #58, measured on tmux 3.2a (this host's): the annotation is
        // padded with spaces to the pane's width, and a capture keeps them, so
        // the marker stayed and the blank rows above it filled the whole tail
        // (testing.md's "cause not diagnosed" row for stop's tail).
        let padded = format!("line-one\nline-two\n^C\n\n\n\nPane is dead (signal 2, Sat Nov  7 04:23:12 2026){}", " ".repeat(31));
        assert_eq!(tail_lines(strip_dead_marker(&padded).trim_end(), 20, None), "line-one\nline-two\n^C");
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
        assert!(!dead.is_running(), "{dead:?}");
        let version = tmux::run_tmux(&["-V"]).unwrap_or_default();
        eprintln!("tasks reap test on {} (pane_dead_time: {})", version.trim(), if dead.dead_at > 0 { "reported" } else { "empty" });

        std::env::set_var(TTL_ENV, "0");
        // Board #92: on a tmux that reports no death time (3.2a) the first
        // verb STAMPS the dead pane and reaps nothing; the next one reaps it.
        // Where tmux reports it (3.6a) the first verb reaps.
        let mut reaped = reap_expired(Some(&shielded));
        if dead.dead_at == 0 {
            assert!(reaped.is_empty(), "an unstamped death is stamped, not reaped");
            assert!(find(&done).is_some_and(|t| t.dead_stamp > 0), "the first verb stamps it");
            reaped = reap_expired(Some(&shielded));
        }
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

    /// Board #58 (validator, auditing #57): `new-window -t <session>` takes a
    /// target WINDOW, so a bare session name resolved to a window whose name
    /// starts with it, and the second task in a session named like its first
    /// failed with "index 1 in use". A task window is created in exactly its
    /// session, at the next free index, whatever the other windows are called.
    #[test]
    fn a_task_window_is_created_in_its_session_whatever_its_windows_are_named() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "prefixnames");
        let session = "tmm-test-prefix";
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let first = format!("{session}-close");
        let second = format!("{session}-keep");
        start(&first, &sh("sleep 300"), Some(session), true, None, &[]).expect("the first task starts");
        start(&second, &sh("sleep 300"), Some(session), true, None, &[]).expect("a second task named like the first starts too");
        assert!(find(&first).is_some() && find(&second).is_some(), "both windows exist");
        let _ = tmux::kill_session(session);
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
        let log = crate::config::test_scratch("tmm-test-wake").with_extension("log");
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
    /// human starts has an empty `TMM_AGENT`, never a stale one. Board #407:
    /// the same for `TMM_SERVER` — a starter with no server gives the task
    /// none, whatever the server's environment (or the test runner's) says.
    #[test]
    fn a_task_runs_with_its_starters_identity() {
        let scope = GlobalSocket::hold();
        let _server = PrivateTmux::start(&scope, "starter");
        let session = "tmm-test-starter";
        let name = format!("tmm-test-id-{}", std::process::id());
        let sh = |c: &str| -> Vec<String> { vec!["sh".into(), "-c".into(), c.into()] };
        let print = sh("echo \"agent=[$TMM_AGENT] project=[$TMM_PROJECT] server=[$TMM_SERVER] socket=[$TMM_SOCKET]\"; sleep 300");
        let said = |name: &str| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            logs(name, 5, Some("agent=")).unwrap()
        };
        tmux::ensure_session(session, "/tmp").unwrap();
        tmux::run_tmux(&["set-environment", "-g", "TMM_AGENT", "stale"]).unwrap();
        tmux::run_tmux(&["set-environment", "-g", "TMM_PROJECT", "stale"]).unwrap();
        tmux::run_tmux(&["set-environment", "-g", "TMM_SERVER", "ws://stale:1"]).unwrap();
        // Board #440: another gateway's socket in the tmux server's environment.
        tmux::run_tmux(&["set-environment", "-g", "TMM_SOCKET", "/stale/sock/gateway.sock"]).unwrap();

        let dev = starter_env(Some("my proj#x"), Some("dev"), None, Some("ws://h:1"), Some("/cfg/sock/gateway.sock"));
        start(&name, &print, Some(session), true, None, &dev).unwrap();
        assert!(said(&name).contains("agent=[dev] project=[my proj#x] server=[ws://h:1] socket=[/cfg/sock/gateway.sock]"), "{}", said(&name));

        let human = starter_env(Some("blog"), None, None, None, None);
        start(&name, &print, Some(session), true, None, &human).unwrap();
        let out = said(&name);
        assert!(out.lines().last().unwrap_or("").contains("agent=[] project=[blog] server=[] socket=[]"), "a reused window, the human: {out}");
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
