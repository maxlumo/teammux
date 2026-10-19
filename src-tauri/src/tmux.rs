/// tmux 操作封装层
/// 通过调用 tmux CLI 来管理 session/window/pane
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub windows: usize,
    pub attached: bool,
    pub created: String,
    /// Unix seconds of the last time this session was opened via tmux-mobile,
    /// persisted across server restarts. `None` if never opened from the app.
    /// Clients use this to sort the most-recently-used sessions to the top.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxPane {
    pub session: String,
    pub window: usize,
    pub pane: usize,
    pub width: usize,
    pub height: usize,
    pub current_command: String,
    pub window_name: String,
    pub pane_title: String,
    /// Current working directory of the pane's process (tmux pane_current_path).
    /// Used by the client to show a cwd hint alongside the command name.
    pub current_path: String,
    /// Whether this is the window's active pane. Clients use it to pick the
    /// representative pane for window chips (active pane's command/title,
    /// not whatever pane happens to list first).
    pub active: bool,
    /// argv of the foreground-most descendant of the pane's shell, e.g.
    /// "node /…/@openai/codex/bin/codex.js". `pane_current_command` only
    /// reports the immediate process name ("node", "2.1.141"), which is
    /// useless for detecting interpreter-launched agent CLIs — the real
    /// identity lives in the argv. Empty when the pane runs a bare shell.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub child_cmd: String,
    /// The agent CLI this pane's PROCESSES run (backend name), or `None` for
    /// anything else — derived once, here, by `agents::detect_processes` over
    /// the process name, the pane process's own argv and its descendants'
    /// (board #260). Never from `pane_title` or `window_name`: those are
    /// labels a CLI sets and nothing resets, so a shell where grok had exited
    /// still said "grok". Every reader, server and client, takes this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<&'static str>,
}

use std::sync::{OnceLock, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};

static TMUX_SOCKET: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static SCROLLBACK: AtomicUsize = AtomicUsize::new(500);

pub fn set_scrollback(n: usize) { SCROLLBACK.store(n, Ordering::Relaxed); }
pub fn get_scrollback() -> usize { SCROLLBACK.load(Ordering::Relaxed) }

fn socket_lock() -> &'static RwLock<Option<String>> {
    TMUX_SOCKET.get_or_init(|| RwLock::new(None))
}

pub fn set_socket(socket: Option<String>) {
    *socket_lock().write().unwrap() = socket;
}

pub fn get_socket() -> Option<String> {
    socket_lock().read().unwrap().clone()
}

/// 执行 tmux 命令，返回 stdout
fn find_tmux() -> String {
    // Try PATH first via `which`
    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }
    // Fallback: common locations
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.local/bin/tmux", home),
        "/opt/homebrew/bin/tmux".into(),
        "/usr/local/bin/tmux".into(),
        "/usr/bin/tmux".into(),
        "/bin/tmux".into(),
        "/opt/local/bin/tmux".into(),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    "tmux".to_string()
}

pub(crate) fn run_tmux(args: &[&str]) -> Result<String, String> {
    run_tmux_on(get_socket().as_deref(), args)
}

/// `run_tmux` with the server named by the CALLER, not by the process global:
/// `-S socket` when given, else whatever tmux resolves on its own (`$TMUX`
/// inside a pane, the default socket outside). A command that must land on
/// one particular server — above all a destructive one — passes its socket
/// here, so what it hits is decided where it is written and cannot be moved
/// by another thread between a read of the global and the spawn (board #349:
/// a test helper's `kill-server` read the global, another test had just set
/// it to `None`, and the developer's default server died with every session
/// on the host).
pub(crate) fn run_tmux_on(socket: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(find_tmux());
    if let Some(socket) = socket {
        cmd.args(["-S", socket]);
    }
    let output = cmd
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("tmux error: {}", stderr))
    }
}

/// Where a bare `tmux` (no `-S`, no `-L`) would go from this process: the
/// server of the pane we are in (`$TMUX` = `path,pid,index`), else the
/// per-user default socket under `$TMUX_TMPDIR` or `/tmp`. Read-only — it
/// never asks tmux, which would start a server to answer.
pub(crate) fn implicit_socket() -> std::path::PathBuf {
    if let Some(path) = std::env::var("TMUX").ok().and_then(|t| t.split(',').next().map(str::to_string)).filter(|p| !p.is_empty()) {
        return std::path::PathBuf::from(path);
    }
    let dir = std::env::var_os("TMUX_TMPDIR").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    dir.join(format!("tmux-{uid}")).join("default")
}

/// A session NAME as an exact `-t` target: `=name:`. tmux resolves a bare
/// target as exact name, then PREFIX of a name, then fnmatch glob — so with
/// only `dev-2` alive, `has-session -t dev` says yes and `kill-session -t dev`
/// kills `dev-2`; a name holding `*` or `?` is a pattern. `=` turns that off,
/// and the trailing `:` says "the session half of a target" — without it,
/// commands that take a target-WINDOW/pane (`list-panes -s`, `new-window`,
/// `display-message`) read `=dev` as a window name and fall back to the prefix
/// search anyway. `=name:` is accepted uniformly by has-session, kill-session,
/// rename-session, list-windows, list-panes, new-window and display-message
/// (verified on tmux 3.6a). `set-option` and `set-hook` targets reject `=`,
/// which is why `ensure_session`/`set_resize_hook` pass the bare name.
fn exact_session(session: &str) -> String {
    if session.starts_with('=') { session.to_string() } else { format!("={session}:") }
}

/// True when a tmux error says the session (or the whole server) is simply
/// not THERE, as opposed to tmux being unreachable (board #347 review P1-A:
/// "no session" and "could not check" are different facts, and only the first
/// may be called a stopped agent). Measured on tmux 3.6a with an isolated
/// socket, 2026-10-15:
///
/// * no server and no socket file → `error connecting to <sock> (No such file or directory)`
/// * a server without that session → `can't find session: <name>`
/// * a socket we may not open → `error connecting to <sock> (Permission denied)`
///
/// plus `no server running on <sock>`, tmux's own words for a stale socket.
/// A miss on a future wording is the SAFE direction: it reads as "could not
/// check", never as a confident "stopped".
pub(crate) fn session_confirmed_absent(error: &str) -> bool {
    error.contains("can't find session")
        || error.contains("no server running")
        || (error.contains("error connecting to") && error.contains("No such file or directory"))
}

/// Quote a string for a tmux COMMAND LINE (a hook body, a key binding), where
/// tmux's own parser splits on spaces and `;` and expands `$VAR`. Double quotes
/// with `\`, `"` and `$` escaped survive that parser byte-for-byte (verified on
/// tmux 3.6a); single quotes cannot carry an embedded `'`. Not needed for argv
/// arguments — those go to tmux as separate strings and are never re-parsed.
pub(crate) fn tmux_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if matches!(c, '\\' | '"' | '$') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// 列出所有 session
pub fn list_sessions() -> Result<Vec<TmuxSession>, String> {
    // Delimiter: a printable token, NOT a control byte. tmux >= 3.4
    // octal-escapes control bytes (e.g. 0x1f -> "\037") in `-F` output, so a
    // unit-separator delimiter never survives and the whole line lands in one
    // field. A distinctive printable token is emitted verbatim and is
    // implausible in real session/window names or paths. See TMUX_FIELD_SEP.
    let output = run_tmux(&[
        "list-sessions",
        "-F",
        "#{session_name}<TMM_SEP>#{session_windows}<TMM_SEP>#{session_attached}<TMM_SEP>#{session_activity}",
    ])?;

    let mut sessions: Vec<TmuxSession> = output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split("<TMM_SEP>").collect();
            TmuxSession {
                name: parts.first().unwrap_or(&"").to_string(),
                windows: parts.get(1).unwrap_or(&"0").parse().unwrap_or(0),
                attached: parts.get(2).unwrap_or(&"0") == &"1",
                created: parts.get(3).unwrap_or(&"0").to_string(),
                last_opened: None,
            }
        })
        .collect();

    // Annotate with the last time each session was opened via tmux-mobile
    // (persisted, per-server). The client uses this to sort MRU-first.
    let usage = crate::config::get_session_usage();
    for s in sessions.iter_mut() {
        s.last_opened = usage.get(&s.name).copied();
    }

    // Sort by tmux session_activity timestamp descending as a baseline; the
    // client applies its own MRU-first sort on top using `last_opened`.
    sessions.sort_by(|a, b| {
        let ta: u64 = b.created.parse().unwrap_or(0);
        let tb: u64 = a.created.parse().unwrap_or(0);
        ta.cmp(&tb)
    });

    Ok(sessions)
}

/// `session_name -> session_created` (unix seconds) for every live session.
/// The projects auto-tracker needs a session's AGE, which `list_sessions`
/// cannot answer: its `created` field actually carries `session_activity`
/// (it drives MRU sorting) and that ticks forward on every keystroke.
pub fn session_created_times() -> Vec<(String, u64)> {
    let out = match run_tmux(&[
        "list-sessions",
        "-F",
        "#{session_name}<TMM_SEP>#{session_created}",
    ]) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    out.lines()
        .filter_map(|line| {
            let mut it = line.split("<TMM_SEP>");
            match (it.next(), it.next()) {
                (Some(name), Some(created)) if !name.is_empty() => {
                    Some((name.to_string(), created.parse().unwrap_or(0)))
                }
                _ => None,
            }
        })
        .collect()
}

/// (window index, last activity unix seconds) for every window of `session`.
/// The telemetry fallback signal: a backend with no tool hooks still shows
/// "working" while its pane produces output.
pub fn window_activity_times(session: &str) -> Vec<(usize, u64)> {
    let target = exact_session(session);
    let out = match run_tmux(&[
        "list-windows",
        "-t",
        &target,
        "-F",
        "#{window_index}<TMM_SEP>#{window_activity}",
    ]) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    out.lines()
        .filter_map(|line| {
            let mut it = line.split("<TMM_SEP>");
            match (it.next(), it.next()) {
                (Some(idx), Some(ts)) => Some((idx.parse().ok()?, ts.parse().unwrap_or(0))),
                _ => None,
            }
        })
        .collect()
}

/// The directory a session was made in: `new-session -c`, else the making
/// client's cwd. A declaration, stable for the session's life — unlike a
/// pane's `#{pane_current_path}`, which is wherever its foreground process
/// happens to be at the instant of the read (board #421).
pub fn session_path(session: &str) -> Result<String, String> {
    let out = run_tmux(&["display-message", "-p", "-t", &exact_session(session), "#{session_path}"])?;
    Ok(out.trim_end_matches(['\r', '\n']).to_string())
}

/// 列出某个 session 的所有 pane
pub fn list_panes(session: &str) -> Result<Vec<TmuxPane>, String> {
    let target = exact_session(session);
    let output = run_tmux(&[
        "list-panes",
        "-s",
        "-t",
        &target,
        "-F",
        PANE_FORMAT,
    ])?;
    Ok(parse_pane_lines(&output))
}

const PANE_FORMAT: &str = "#{session_name}<TMM_SEP>#{window_index}<TMM_SEP>#{pane_index}<TMM_SEP>#{pane_width}<TMM_SEP>#{pane_height}<TMM_SEP>#{pane_current_command}<TMM_SEP>#{window_name}<TMM_SEP>#{pane_title}<TMM_SEP>#{pane_current_path}<TMM_SEP>#{pane_active}<TMM_SEP>#{pane_pid}";

type ProcessTable = std::collections::HashMap<u32, (u32, String)>;

#[cfg(test)]
static PS_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

thread_local! {
    // A dispatch-scoped snapshot (board #145): `Some` while inside
    // `with_process_snapshot`, holding the table once it has been read.
    static SNAPSHOT: std::cell::RefCell<Option<Option<std::rc::Rc<ProcessTable>>>> =
        const { std::cell::RefCell::new(None) };
}

/// Run `f` with ONE process-table snapshot shared by every `list_panes`
/// inside it (board #145). Measured on this host (521 processes, 7 live
/// projects): `ps -axo` is 29 ms of `list_panes`' 41 ms, and one capture tick
/// called it 2 × N times — `observe` and `recovery::check_once` walk the same
/// sessions milliseconds apart and already treat their readings as one moment
/// in time, so sharing the snapshot changes no verdict; it only stops asking
/// the kernel fourteen times for an answer that cannot have changed.
/// Thread-local by design: a scope covers exactly the synchronous work of one
/// dispatch (the tick runs whole on one blocking thread) and never leaks into
/// the next request, so there is no TTL and no staleness window to reason
/// about — the failure mode a time-based cache would have introduced (a CLI
/// launched inside the window reads as a plain shell until it expires).
pub fn with_process_snapshot<T>(f: impl FnOnce() -> T) -> T {
    let outer = SNAPSHOT.with(|s| s.replace(Some(None)));
    let out = f();
    SNAPSHOT.with(|s| *s.borrow_mut() = outer);
    out
}

/// Snapshot of the process table: pid -> (ppid, args). One `ps` subprocess
/// per pane-listing call, shared across all panes — far cheaper than a
/// per-pane lookup and portable across macOS / Linux. Inside
/// `with_process_snapshot` the first call's table serves the whole scope.
fn process_table() -> std::rc::Rc<ProcessTable> {
    let cached = SNAPSHOT.with(|s| s.borrow().as_ref().and_then(|inner| inner.clone()));
    if let Some(t) = cached {
        return t;
    }
    let table = std::rc::Rc::new(read_process_table());
    SNAPSHOT.with(|s| {
        if let Some(inner) = s.borrow_mut().as_mut() {
            *inner = Some(table.clone());
        }
    });
    table
}

fn read_process_table() -> ProcessTable {
    #[cfg(test)]
    PS_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut map = std::collections::HashMap::new();
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,ppid=,args="]).output() else {
        return map;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // `ps` right-aligns the numeric pid/ppid columns, so consecutive
        // fields are separated by RUNS of spaces, not single spaces. Read the
        // two leading numbers off a whitespace-collapsing iterator, then take
        // args as the rest of the line after the ppid token. (splitn on a
        // single whitespace char would yield an empty ppid field on every
        // padded row and drop the entire process table — the bug this fixes.)
        let mut it = line.split_whitespace();
        let (Some(pid_tok), Some(ppid_tok)) = (it.next(), it.next()) else { continue };
        let (Ok(pid), Ok(ppid)) = (pid_tok.parse::<u32>(), ppid_tok.parse::<u32>()) else { continue };
        // args = whatever the iterator has left, rejoined with single spaces.
        // (Original spacing inside argv is irrelevant — we only substring-match
        // against it.)
        let args = it.collect::<Vec<_>>().join(" ");
        map.insert(pid, (ppid, args));
    }
    map
}

/// The argv of each process on the first-child chain under `root` (the
/// pane's shell), shallow → deep, up to 4 levels. Agent CLIs sit directly
/// under the shell or behind one wrapper level (script launcher → node), but
/// they also spawn their own subprocesses (tool executions) — so EVERY
/// level is kept, and `agents::detect_processes` reads each level's
/// executable on its own (board #260: joined into one string, `rg grok`'s
/// ARGUMENT read as the grok CLI). Each level is capped so a pathological
/// argv doesn't bloat every pane listing.
fn descendant_argvs(table: &ProcessTable, root: u32) -> Vec<String> {
    const MAX_ARGS_PER_LEVEL: usize = 160;
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (&pid, &(ppid, _)) in table.iter() {
        children.entry(ppid).or_default().push(pid);
    }
    let mut cur = root;
    let mut acc = Vec::new();
    for _ in 0..4 {
        let Some(kids) = children.get(&cur) else { break };
        // Lowest pid = first-spawned ≈ the foreground job.
        let Some(&next) = kids.iter().min() else { break };
        if let Some((_, args)) = table.get(&next) {
            if !args.is_empty() {
                let mut end = MAX_ARGS_PER_LEVEL.min(args.len());
                while end < args.len() && !args.is_char_boundary(end) {
                    end += 1;
                }
                acc.push(args[..end].to_string());
            }
        }
        cur = next;
    }
    acc
}

/// The chain as one display string (`TmuxPane::child_cmd`).
#[cfg(test)]
fn descendant_cmd(table: &ProcessTable, root: u32) -> String {
    descendant_argvs(table, root).join(" ")
}

fn parse_pane_lines(output: &str) -> Vec<TmuxPane> {
    let mut panes: Vec<(TmuxPane, u32)> = output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split("<TMM_SEP>").collect();
            let pane = TmuxPane {
                session: parts.first().unwrap_or(&"").to_string(),
                window: parts.get(1).unwrap_or(&"0").parse().unwrap_or(0),
                pane: parts.get(2).unwrap_or(&"0").parse().unwrap_or(0),
                width: parts.get(3).unwrap_or(&"0").parse().unwrap_or(0),
                height: parts.get(4).unwrap_or(&"0").parse().unwrap_or(0),
                current_command: parts.get(5).unwrap_or(&"").to_string(),
                window_name: parts.get(6).unwrap_or(&"").to_string(),
                pane_title: parts.get(7).unwrap_or(&"").to_string(),
                current_path: parts.get(8).unwrap_or(&"").to_string(),
                active: parts.get(9).unwrap_or(&"0") == &"1",
                child_cmd: String::new(),
                agent: None,
            };
            let pid: u32 = parts.get(10).unwrap_or(&"0").parse().unwrap_or(0);
            (pane, pid)
        })
        .collect();
    // Single ps snapshot serves every pane in this listing.
    let table = panes.iter().any(|(_, pid)| *pid > 0).then(process_table);
    for (pane, pid) in panes.iter_mut() {
        // Shallow → deep: the pane process's own argv, then its descendants'.
        let argvs: Vec<String> = table.as_deref().filter(|_| *pid > 0).map_or_else(Vec::new, |t| {
            let chain = descendant_argvs(t, *pid);
            pane.child_cmd = chain.join(" ");
            t.get(pid).map(|(_, args)| args.clone()).into_iter().chain(chain).collect()
        });
        // The detection table lives with the projects (desktop-only, like the
        // store): a phone is a client of a desktop server, never a server
        // whose panes run agents, so its listing simply carries no verdict.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let argvs: Vec<&str> = argvs.iter().map(String::as_str).collect();
            pane.agent = crate::projects::agents::detect_processes(&pane.current_command, &argvs).map(|a| a.backend);
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let _ = argvs;
    }
    panes.into_iter().map(|(p, _)| p).collect()
}

/// The agent CLI running in ONE pane (`TmuxPane::agent`), for the terminal
/// stream's command-change push (board #260): the same listing and the same
/// derivation as `list_panes`, just for one target.
pub fn pane_agent(target: &str) -> Option<&'static str> {
    let output = run_tmux(&["display-message", "-p", "-t", target, PANE_FORMAT]).ok()?;
    parse_pane_lines(&output).into_iter().next()?.agent
}

/// List panes across ALL sessions in one tmux call. Avoids the N+1 RPC
/// pattern where the client previously did `list_sessions` + N ×
/// `list_panes(session)`. tmux's `-a` flag iterates every server-known
/// session in a single subprocess; the client groups by session_name.
pub fn list_all_panes() -> Result<Vec<TmuxPane>, String> {
    let output = run_tmux(&["list-panes", "-a", "-F", PANE_FORMAT])?;
    Ok(parse_pane_lines(&output))
}

/// Resolve tmux's stable pane id (for example `%18`) to the current target.
/// Agent lifecycle hooks inherit `TMUX_PANE`, so this is the authoritative
/// association between an agent event and the window shown by the client.
/// Returns the window NAME, not its index (board #120): the name is the
/// agent's identity everywhere (managed_home, launch.json, the roster), and
/// with `renumber-windows on` an index shifts when a lower window dies — a
/// store keyed by it hands one agent's turn edges to whichever window
/// inherits the number (measured 2026-09-09: kill index 1 and window @788
/// "dev" resolves 2 → 1 while a newcomer takes the freed high index).
pub fn resolve_pane_id(pane_id: &str) -> Result<(String, String, usize), String> {
    if !pane_id.starts_with('%') || !pane_id[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid tmux pane id".into());
    }
    let output = run_tmux(&[
        "display-message", "-t", pane_id, "-p",
        "#{session_name}<TMM_SEP>#{window_name}<TMM_SEP>#{pane_index}",
    ])?;
    let mut fields = output.trim().split("<TMM_SEP>");
    let session = fields.next().filter(|s| !s.is_empty()).ok_or("missing session")?.to_string();
    let window = fields.next().filter(|s| !s.is_empty()).ok_or("missing window")?.to_string();
    let pane = fields.next().ok_or("missing pane")?.parse().map_err(|_| "invalid pane")?;
    Ok((session, window, pane))
}

/// The window NAME a pane is in and the pid of the process tmux started in
/// it (`#{pane_pid}`) — what `tmm send` needs to tell a call made by the
/// agent's own turn (a descendant of that pid) from a script it left behind
/// (board #285).
pub fn pane_window_and_pid(pane_id: &str) -> Result<(String, u32), String> {
    if !pane_id.starts_with('%') || !pane_id[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid tmux pane id".into());
    }
    let output = run_tmux(&["display-message", "-t", pane_id, "-p", "#{window_name}<TMM_SEP>#{pane_pid}"])?;
    let (window, pid) = output.trim().split_once("<TMM_SEP>").ok_or("missing fields")?;
    let pid = pid.parse().map_err(|_| "invalid pane pid")?;
    if window.is_empty() {
        return Err("missing window".into());
    }
    Ok((window.to_string(), pid))
}

/// Get current command of a pane
pub fn pane_command(target: &str) -> Result<String, String> {
    run_tmux(&[
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_current_command}",
    ])
    .map(|s| s.trim().to_string())
}

/// Get cursor position (x, y), pane height and pane width
pub fn cursor_info(target: &str) -> Result<(usize, usize, usize, usize), String> {
    let out = run_tmux(&[
        "display-message",
        "-t",
        target,
        "-p",
        "#{cursor_x},#{cursor_y},#{pane_height},#{pane_width}",
    ])?;
    let parts: Vec<&str> = out.trim().split(',').collect();
    let x = parts.first().unwrap_or(&"0").parse().unwrap_or(0);
    let y = parts.get(1).unwrap_or(&"0").parse().unwrap_or(0);
    let h = parts.get(2).unwrap_or(&"24").parse().unwrap_or(24);
    let w = parts.get(3).unwrap_or(&"80").parse().unwrap_or(80);
    Ok((x, y, h, w))
}

/// Same as `cursor_info` but also returns `pane_current_command`. tmux's
/// `display-message` formats can carry both in a single subprocess call,
/// so this lets the subscription loop piggyback the running command on
/// every snapshot tick — replacing a separate per-pane 3 s polling RPC
/// from the client. Use this where the running command actually matters
/// (currently only `subscription_loop`); other call sites stay on the
/// shorter signature to avoid threading a String everywhere.
pub fn cursor_info_with_cmd(
    target: &str,
) -> Result<(usize, usize, usize, usize, String), String> {
    let out = run_tmux(&[
        "display-message",
        "-t",
        target,
        "-p",
        // Printable delimiter (see list_sessions): tmux 3.4 octal-escapes
        // control bytes in -F output, so a 0x1f delimiter does not survive.
        "#{cursor_x}<TMM_SEP>#{cursor_y}<TMM_SEP>#{pane_height}<TMM_SEP>#{pane_width}<TMM_SEP>#{pane_current_command}",
    ])?;
    let parts: Vec<&str> = out.trim_end_matches('\n').split("<TMM_SEP>").collect();
    let x = parts.first().unwrap_or(&"0").parse().unwrap_or(0);
    let y = parts.get(1).unwrap_or(&"0").parse().unwrap_or(0);
    let h = parts.get(2).unwrap_or(&"24").parse().unwrap_or(24);
    let w = parts.get(3).unwrap_or(&"80").parse().unwrap_or(80);
    let cmd = parts.get(4).unwrap_or(&"").to_string();
    Ok((x, y, h, w, cmd))
}

/// 捕获 pane 内容（屏幕输出，保留 ANSI 转义序列）
/// Uses -J to join tmux-wrapped lines, then fixes CJK double-width
/// wrapping where tmux doesn't set the WRAPPED flag (last column left
/// empty because a 2-cell character didn't fit).
pub fn capture_pane(target: &str, lines: Option<usize>) -> Result<String, String> {
    capture_pane_with_width(target, lines, 0).map(|(content, _)| content)
}

/// Capture pane text without ANSI escapes for prompt/control-flow detection.
pub fn capture_pane_plain(target: &str, lines: Option<usize>) -> Result<String, String> {
    let start_line = lines
        .map(|n| format!("-{}", n))
        .unwrap_or_else(|| format!("-{}", get_scrollback()));
    let output = run_tmux(&[
        "capture-pane",
        "-t",
        target,
        "-p",
        "-J",
        "-S",
        &start_line,
    ])?;
    Ok(output.trim_end().to_string())
}

/// Capture with a known pane width (avoids extra tmux call).
/// Returns (content, lines_trimmed_from_end).
pub fn capture_pane_with_width(
    target: &str,
    lines: Option<usize>,
    width: usize,
) -> Result<(String, usize), String> {
    let start_line = lines
        .map(|n| format!("-{}", n))
        .unwrap_or_else(|| format!("-{}", get_scrollback()));
    let output = run_tmux(&[
        "capture-pane",
        "-t",
        target,
        "-p",
        "-e",
        "-J",
        "-S",
        &start_line,
    ])?;

    let trimmed = output.trim_end();

    // Count trailing empty pane rows that were removed by trim_end.
    // tmux terminates EVERY line with \n (including the last non-empty one),
    // so we subtract 1 to avoid counting that terminator as an empty line.
    let trailing_newlines = output[trimmed.len()..]
        .bytes()
        .filter(|&b| b == b'\n')
        .count();
    let trailing_empty = if trimmed.is_empty() {
        trailing_newlines
    } else {
        trailing_newlines.saturating_sub(1)
    };

    if width == 0 {
        return Ok((trimmed.to_string(), trailing_empty));
    }

    Ok((join_unflagged_wraps(trimmed, width), trailing_empty))
}

/// Join wrapped lines that tmux -J missed.
///
/// tmux -J already joins wraps that carry the WRAPPED flag. The one case it
/// misses: a double-width char didn't fit in the last column, so tmux left
/// that column empty WITHOUT setting the flag. Signature: visible width ==
/// pane_width - 1 AND the next line starts with the wide char that didn't
/// fit. Anything else — including exactly-full lines — is a complete row;
/// joining it shifts every following row (kimi's full-width box borders
/// swallowed their next line and the whole screen sheared).
pub fn join_unflagged_wraps(trimmed: &str, width: usize) -> String {
    let raw_lines: Vec<&str> = trimmed.split('\n').collect();
    let mut result = String::with_capacity(trimmed.len());
    let mut i = 0;
    while i < raw_lines.len() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(raw_lines[i]);
        while i + 1 < raw_lines.len() {
            if visible_width(raw_lines[i]) == width.saturating_sub(1)
                && first_visible_char(raw_lines[i + 1]).is_some_and(is_wide_char)
            {
                i += 1;
                result.push_str(raw_lines[i]);
            } else {
                break;
            }
        }
        i += 1;
    }
    result
}

/// First visible (non-escape) character of a line, skipping ANSI escapes
/// with the same rules as `visible_width`.
fn first_visible_char(s: &str) -> Option<char> {
    let mut in_esc = false;
    for c in s.chars() {
        if in_esc {
            if c.is_ascii_alphabetic() {
                in_esc = false;
            }
        } else if c == '\x1b' {
            in_esc = true;
        } else {
            return Some(c);
        }
    }
    None
}

/// Count visible character width, skipping ANSI escapes, counting CJK as 2.
pub fn visible_width(s: &str) -> usize {
    let mut w = 0;
    let mut in_esc = false;
    for c in s.chars() {
        if in_esc {
            if c.is_ascii_alphabetic() {
                in_esc = false;
            }
        } else if c == '\x1b' {
            in_esc = true;
        } else {
            w += if is_wide_char(c) { 2 } else { 1 };
        }
    }
    w
}

fn is_wide_char(c: char) -> bool {
    let cp = c as u32;
    matches!(cp,
        0x1100..=0x115F | 0x231A..=0x231B | 0x2329..=0x232A |
        0x23E9..=0x23F3 | 0x23F8..=0x23FA | 0x25FD..=0x25FE |
        0x2614..=0x2615 | 0x2648..=0x2653 | 0x267F | 0x2693 |
        0x26A1 | 0x26AA..=0x26AB | 0x26BD..=0x26BE |
        0x26C4..=0x26C5 | 0x26CE | 0x26D4 | 0x26EA |
        0x26F2..=0x26F3 | 0x26F5 | 0x26FA | 0x26FD |
        0x2702 | 0x2705 | 0x2708..=0x270D | 0x270F |
        0x2712 | 0x2714 | 0x2716 | 0x271D | 0x2721 |
        0x2728 | 0x2733..=0x2734 | 0x2744 | 0x2747 |
        0x274C | 0x274E | 0x2753..=0x2755 | 0x2757 |
        0x2763..=0x2764 | 0x2795..=0x2797 | 0x27A1 |
        0x27B0 | 0x27BF | 0x2934..=0x2935 |
        0x2B05..=0x2B07 | 0x2B1B..=0x2B1C | 0x2B50 | 0x2B55 |
        0x2E80..=0x303E | 0x3040..=0x33BF | 0x3400..=0x4DBF |
        0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xA960..=0xA97F |
        0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFE10..=0xFE6F |
        0xFF01..=0xFF60 | 0xFFE0..=0xFFE6 |
        0x1F000..=0x1FAFF | 0x20000..=0x2FA1F | 0x30000..=0x3134F
    )
}

/// tmux named key for a C0 control byte, for bytes that must not be sent
/// literally (see send_keys). `\t` `\n` `\r` and ESC stay literal: they are
/// ordinary text bytes (or, for ESC, the prefix of a longer sequence).
fn c0_key_name(c: char) -> Option<&'static str> {
    const CTRL_LETTERS: [&str; 26] = [
        "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h", "C-i", "C-j",
        "C-k", "C-l", "C-m", "C-n", "C-o", "C-p", "C-q", "C-r", "C-s", "C-t",
        "C-u", "C-v", "C-w", "C-x", "C-y", "C-z",
    ];
    match c {
        '\t' | '\n' | '\r' | '\x1b' => None,
        '\0' => Some("C-Space"),
        '\x01'..='\x1a' => Some(CTRL_LETTERS[c as usize - 1]),
        '\x1c' => Some("C-\\"),
        '\x1d' => Some("C-]"),
        '\x1e' => Some("C-^"),
        '\x1f' => Some("C-_"),
        _ => None,
    }
}

/// 向 pane 发送按键
///
/// Literal mode splits C0 control bytes out as tmux *named* keys: with
/// `extended-keys on`, tmux silently DROPS raw C0 bytes sent via
/// `send-keys -l` to panes whose app enabled an extended keyboard protocol
/// (modifyOtherKeys / kitty — `#{pane_key_mode}` = `Ext …`, which every
/// modern agent TUI does). Named keys are re-encoded by tmux to match the
/// pane's key mode, so they work for both legacy and extended panes.
/// An ESC directly before a control byte is the client's Ctrl+Alt encoding;
/// it becomes one `M-C-x` key so no stray ESC leaks into the pane.
pub fn send_keys(target: &str, keys: &str, literal: bool) -> Result<(), String> {
    if !literal {
        // `--` ends option parsing: a key string starting with `-` (`-R`,
        // `-X`) is a key name — or literal text, tmux's fallback for a name it
        // does not know — never a send-keys flag. Verified on tmux 3.6a.
        run_tmux(&["send-keys", "-t", target, "--", keys])?;
        return Ok(());
    }
    let flush = |buf: &mut String| -> Result<(), String> {
        if !buf.is_empty() {
            run_tmux(&["send-keys", "-t", target, "-l", "--", buf])?;
            buf.clear();
        }
        Ok(())
    };
    let mut buf = String::new();
    let mut chars = keys.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if let Some(name) = chars.peek().copied().and_then(c0_key_name) {
                chars.next();
                flush(&mut buf)?;
                run_tmux(&["send-keys", "-t", target, "--", &format!("M-{name}")])?;
                continue;
            }
        }
        match c0_key_name(c) {
            Some(name) => {
                flush(&mut buf)?;
                run_tmux(&["send-keys", "-t", target, "--", name])?;
            }
            None => buf.push(c),
        }
    }
    flush(&mut buf)?;
    Ok(())
}

/// One mutex per pane target, so concurrent deliveries cannot interleave.
/// `send_command` is text → 200 ms beat → Enter: two unsynchronized callers
/// weave A-text, B-text, A-Enter, B-Enter — A and B arrive GLUED as one
/// submitted line and the second Enter submits nothing (measured 2026-09-09,
/// board #122: four racing sends to a `cat` pane produced one concatenated
/// row). The map is keyed by the caller's target string; every burst path
/// (deliver_mentions, board notices, hub_command) addresses a pane as
/// `session:window.pane`, so a burst serializes. Entries are tiny and pruned
/// opportunistically past 256 (a dead pane's mutex is just a few bytes, but a
/// map that only grows is a leak).
fn pane_send_lock(target: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let map = LOCKS.get_or_init(Default::default);
    let mut map = map.lock().unwrap();
    if map.len() > 256 {
        map.retain(|_, lock| std::sync::Arc::strong_count(lock) > 1);
    }
    map.entry(target.to_string()).or_default().clone()
}

/// Run `f` holding `target`'s send lock — the same one `send_command` takes,
/// so nothing typed through it interleaves with `f`. For a read → key →
/// verify sequence that must be one step (#271's queue/steer switch). `f`
/// must not call `send_command` on the same target (the lock is not
/// reentrant); `send_keys` does not lock.
pub fn with_pane_send_lock<R>(target: &str, f: impl FnOnce() -> R) -> R {
    let lock = pane_send_lock(target);
    let _guard = lock.lock().unwrap();
    f()
}

/// The error `send_command` returns for a pane in copy-mode (board #250).
pub const PANE_IN_MODE: &str = "pane is in copy mode";

/// Is this pane in a mode (copy-mode, view-mode, a chooser) right now?
pub fn pane_in_mode(target: &str) -> Result<bool, String> {
    Ok(run_tmux(&["display-message", "-p", "-t", target, "#{pane_in_mode}"])?.trim() == "1")
}

/// 向 pane 发送文本 + Enter
pub fn send_command(target: &str, command: &str) -> Result<(), String> {
    // Serialize per pane (board #122): the text→Enter pair below must land
    // whole before another caller's does.
    let lock = pane_send_lock(target);
    let _guard = lock.lock().unwrap();
    // A pane in a mode (copy-mode, a chooser) routes every key and paste to
    // the MODE: the text is swallowed, and the mode's own bindings may even
    // leave it (`q`, Enter), after which tmux reported success and nothing had
    // been typed (board #250, measured on tmux 3.6a: send-keys and
    // paste-buffer both vanish, `pane_in_mode` 1 → 0). The mode is a person
    // reading scrollback, so it is never cancelled for them; the send fails
    // instead and the caller says so.
    if pane_in_mode(target)? {
        return Err(PANE_IN_MODE.to_string());
    }
    if command.contains('\n') {
        // A newline cannot ride send-keys: literal mode passes it as a raw C0
        // byte inside `-l`, and with `extended-keys on` tmux silently DROPS
        // raw C0 bytes for panes in an extended key mode — every modern agent
        // TUI. The lines arrived GLUED together ("AgenticAI\nAgentic" reached
        // the composer as "AgenticAIAgentic"), which both corrupted what the
        // agent read and broke the delivery receipt (owner, 2026-08-24: "多行
        // 内容…没办法正确已读"). Naming it `Enter` instead would submit the
        // half-typed line. Bracketed paste is the one channel that carries a
        // newline INTO a composer: paste_text wraps the block in ?2004 markers
        // exactly when the pane app asked for them, and an agent TUI inserts
        // the break instead of submitting.
        paste_text(target, command)?;
    } else {
        send_keys(target, command, true)?;
    }
    // backend-quirk(measured): codex-cli 0.148.0 needs a beat before Enter.
    // A beat between the text and the Enter. An agent TUI that receives the
    // burst back-to-back can treat the Enter as part of a paste and leave the
    // line sitting in its composer unsubmitted — measured live on codex-cli
    // 0.148.0 (a delivered @mention parked in the input box; grok/kiro/claude
    // tolerate the burst). Team's nudge_pane learned the same lesson earlier
    // ("the TUI needs a beat to settle"). 200 ms is imperceptible next to a
    // model turn; shells do not care either way.
    std::thread::sleep(std::time::Duration::from_millis(200));
    // backend-quirk(measured): kiro-cli 2.18.1 opens a file picker on `@`.
    // kiro-cli's terminal UI (2.18.1) opens a fuzzy FILE PICKER the moment an
    // `@` is typed — pasted or keyed, idle or mid-turn — and filters it with
    // the text that follows. Every delivery starts `@name`, so in a workspace
    // holding a file that fuzzy-matches the agent's name (kirocrew-agentcore:
    // `@kiro` → `runtime/kirocrew-artifact.json`) the picker is still open when
    // our Enter arrives, and Enter there means SELECT: the whole mention became
    // `@file:runtime/kirocrew-artifact.json` and kiro answered "Received
    // runtime/kirocrew-artifact.json…" (owner, 2026-09-03, board #10 there).
    // Escape closes the picker and leaves the typed line intact, and while the
    // picker is open it reaches ONLY the picker — measured on a 12-second
    // streaming turn, which ran to its end. With no picker open, Escape is
    // kiro's cancel-agent / clear-queue key, so it is sent only when the
    // picker's own footer is on screen. Nothing else is touched: an `@`-less
    // line skips the capture, and no other backend draws that footer.
    if command.contains('@') && file_picker_open(&capture_pane_plain(target, Some(8)).unwrap_or_default()) {
        send_keys(target, "Escape", false)?;
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    send_keys(target, "Enter", false)?;
    Ok(())
}

/// backend-quirk(measured): kiro-cli 2.18.1's picker footer is the only gate.
/// kiro-cli's `@` file picker, recognised by its footer ("esc to cancel · ↵ to
/// select"). Both halves are required: a running turn shows "Thinking…
/// (esc to cancel)" with nothing to select, and Escape there would cancel it.
pub fn file_picker_open(screen: &str) -> bool {
    screen
        .lines()
        .any(|l| l.contains("esc to cancel") && l.contains("to select"))
}

#[cfg(test)]
thread_local! {
    /// Test-only: a pause between load-buffer and paste-buffer, so two
    /// concurrent pastes really interleave (board #250).
    pub(crate) static PASTE_GAP: std::cell::Cell<std::time::Duration> = const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

/// Paste text into a pane the way a real terminal does.
///
/// send_keys treats every byte as keystrokes, so newlines in a multi-line
/// paste arrive as Enter presses and each line executes. Real terminals use
/// bracketed paste: when the pane app enabled mode ?2004, the block is
/// wrapped in \x1b[200~ … \x1b[201~ and treated as ONE paste. tmux tracks
/// that state per pane, and `paste-buffer -p` inserts the wrapper exactly
/// when the app asked for it — legacy apps get the raw text, unchanged.
/// The text goes through `load-buffer -` (stdin) into a dedicated named
/// buffer so user buffers are untouched; -d deletes it after pasting.
pub fn paste_text(target: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = Command::new(find_tmux());
    if let Some(socket) = get_socket() {
        cmd.args(["-S", &socket]);
    }
    // One buffer per CALL (board #250): tmux buffers are server-global, and
    // the send lock is per pane, so two panes pasting at once through one
    // shared name swapped each other's text or found it already deleted
    // (measured: 20 concurrent pairs, 38 pastes in the wrong pane, 20 lost).
    let buffer = format!("tmm-paste-{}", uuid::Uuid::new_v4());
    let mut child = cmd
        .args(["load-buffer", "-b", &buffer, "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;
    child
        .stdin
        .take()
        .ok_or("tmux stdin unavailable")?
        .write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write paste buffer: {}", e))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    #[cfg(test)]
    PASTE_GAP.with(|gap| std::thread::sleep(gap.get()));
    if let Err(e) = run_tmux(&["paste-buffer", "-p", "-d", "-b", &buffer, "-t", target]) {
        // -d deletes only on success; leave no named buffer behind.
        let _ = run_tmux(&["delete-buffer", "-b", &buffer]);
        return Err(e);
    }
    Ok(())
}

pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default())
}

/// Get the working directory of the active pane in a session/target.
pub fn pane_cwd(target: &str) -> Result<String, String> {
    let path = run_tmux(&["display-message", "-t", target, "-p", "#{pane_current_path}"])?;
    let path = path.trim().to_string();
    if path.is_empty() {
        Ok(home_dir())
    } else {
        Ok(path)
    }
}

/// 创建新 session
pub fn new_session(name: &str, path: Option<&str>, command: Option<&str>) -> Result<(), String> {
    // Check if session name already exists to prevent grouped sessions. Exact:
    // with only `dev-2` alive, `dev` must be creatable.
    if session_exists(name) {
        return Err(format!("session '{}' already exists", name));
    }
    let mut args = vec!["new-session", "-d", "-s", name];
    let resolved;
    let home = home_dir();
    if let Some(p) = path {
        if !p.is_empty() {
            resolved = crate::fs::resolve(p);
            args.push("-c");
            args.push(&resolved);
        } else if !home.is_empty() {
            args.push("-c");
            args.push(&home);
        }
    } else if !home.is_empty() {
        args.push("-c");
        args.push(&home);
    }
    let cmd_str;
    if let Some(cmd) = command {
        if !cmd.is_empty() {
            cmd_str = cmd.to_string();
            args.push(&cmd_str);
        }
    }
    run_tmux(&args)?;
    Ok(())
}

/// 关闭 session
pub fn kill_session(name: &str) -> Result<(), String> {
    // Exact, or with no `dev` alive this would kill `dev-2`.
    run_tmux(&["kill-session", "-t", &exact_session(name)])?;
    Ok(())
}

/// 创建新 window（继承当前 pane 的工作目录）
pub fn new_window(session: &str) -> Result<(), String> {
    let target = exact_session(session);
    // Get the active pane's working directory so new window starts there
    let cwd = run_tmux(&["display-message", "-t", &target, "-p", "#{pane_current_path}"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let dir = if cwd.is_empty() { home_dir() } else { cwd };
    if dir.is_empty() {
        run_tmux(&["new-window", "-t", &target])?;
    } else {
        run_tmux(&["new-window", "-t", &target, "-c", &dir])?;
    }
    Ok(())
}

/// 关闭 window
pub fn kill_window(target: &str) -> Result<(), String> {
    run_tmux(&["kill-window", "-t", target])?;
    Ok(())
}

/// A user option of one session (`@name`), read through the exact target
/// (display-message accepts `=name:`); None when unset or the session is gone.
pub fn session_option(session: &str, option: &str) -> Option<String> {
    let fmt = format!("#{{{option}}}");
    run_tmux(&["display-message", "-t", &exact_session(session), "-p", &fmt])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Set a user option on a session. `set-option` rejects the `=` exact form
/// (see `exact_session`), so the caller must have just created or verified
/// the session by its exact name.
pub fn set_session_option(session: &str, option: &str, value: &str) -> Result<(), String> {
    run_tmux(&["set-option", "-t", session, option, value]).map(|_| ())
}

/// True if a tmux session with this exact name exists.
pub fn session_exists(session: &str) -> bool {
    run_tmux(&["has-session", "-t", &exact_session(session)]).is_ok()
}

/// Rename a live session. `-t` is the exact current name; tmux refuses when the
/// new name is already taken, which is why the caller picks a free one first.
pub fn rename_session(from: &str, to: &str) -> Result<(), String> {
    run_tmux(&["rename-session", "-t", &exact_session(from), to]).map(|_| ())
}

/// Ensure `session` exists (detached), creating it at `cwd` if missing. Used
/// before spawning agent windows into a session that may not exist yet.
pub fn ensure_session(session: &str, cwd: &str) -> Result<(), String> {
    if session_exists(session) {
        return Ok(());
    }
    let dir = if cwd.is_empty() { home_dir() } else { cwd.to_string() };
    if dir.is_empty() {
        run_tmux(&["new-session", "-d", "-s", session])?;
    } else {
        run_tmux(&["new-session", "-d", "-s", session, "-c", &dir])?;
    }
    // Deep scrollback so an agent's history survives in its window. set-option
    // rejects an `=` target; the exact session exists as of the line above, and
    // tmux tries the exact name before any prefix, so the bare name is safe here.
    let _ = run_tmux(&["set-option", "-t", session, "history-limit", "100000"]);
    Ok(())
}

/// One window, named by everything a destructive act must agree on: the
/// server that holds it, its session, its index and name, and its native
/// `@id` — the id never follows a renumber, an index and a name do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowIdentity {
    /// The server incarnation, as the restore checkpoint names it: socket,
    /// pid and start time (a new server can reuse a pid and an `@id`).
    pub socket: String,
    pub server_pid: u32,
    pub server_start: u64,
    pub session: String,
    pub index: usize,
    pub name: String,
    pub id: String,
}

impl WindowIdentity {
    /// The same tmux server incarnation holds both.
    pub fn same_server(&self, other: &WindowIdentity) -> bool {
        (self.socket.as_str(), self.server_pid, self.server_start) == (other.socket.as_str(), other.server_pid, other.server_start)
    }
}

/// Resolve a window target — `session:index`, `session:name` (a `.pane`
/// suffix is ignored) or a native `@id` — by LISTING windows, never by
/// `display-message`, which answers a missing target with some other window
/// or with nothing and exit 0 (measured on tmux 3.6a, 2026-10-18).
/// `Ok(None)` = confirmed absent (no server, no such session, no such
/// window); `Err` = could not be checked.
pub fn resolve_window(target: &str) -> Result<Option<WindowIdentity>, String> {
    let fmt = "#{socket_path}<TMM_SEP>#{pid}<TMM_SEP>#{start_time}<TMM_SEP>#{session_name}<TMM_SEP>#{window_index}<TMM_SEP>#{window_name}<TMM_SEP>#{window_id}";
    let (listing, want): (Result<String, String>, Box<dyn Fn(&WindowIdentity) -> bool>) = if target.starts_with('@') {
        let id = target.to_string();
        (run_tmux(&["list-windows", "-a", "-F", fmt]), Box::new(move |w: &WindowIdentity| w.id == id))
    } else {
        let (session, window) = target.split_once(':').ok_or_else(|| format!("'{target}' names no window"))?;
        let window = window.split('.').next().unwrap_or(window).to_string();
        let index = window.parse::<usize>().ok();
        (
            run_tmux(&["list-windows", "-t", &exact_session(session), "-F", fmt]),
            Box::new(move |w: &WindowIdentity| match index {
                Some(i) => w.index == i,
                None => w.name == window,
            }),
        )
    };
    let out = match listing {
        Ok(out) => out,
        Err(e) if session_confirmed_absent(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split("<TMM_SEP>").collect();
        let [socket, pid, start, session, index, name, id] = f[..] else { return Err(format!("unreadable list-windows line: {line}")) };
        let (Ok(server_pid), Ok(server_start), Ok(index)) = (pid.parse(), start.parse(), index.parse()) else {
            return Err(format!("unreadable list-windows line: {line}"));
        };
        let w = WindowIdentity { socket: socket.into(), server_pid, server_start, session: session.into(), index, name: name.into(), id: id.into() };
        if want(&w) {
            return Ok(Some(w));
        }
    }
    Ok(None)
}

/// Find the active pane id of a window named `name` in `session`, if one exists.
/// Used by the team supervisor to adopt an already-open agent window instead of
/// launching a duplicate (idempotent across server restarts).
pub fn find_window_by_name(session: &str, name: &str) -> Option<String> {
    let out = run_tmux(&[
        "list-windows", "-t", &exact_session(session), "-F", "#{window_name}<TMM_SEP>#{pane_id}",
    ])
    .ok()?;
    for line in out.lines() {
        let mut it = line.split("<TMM_SEP>");
        if let (Some(wname), Some(pane)) = (it.next(), it.next()) {
            if wname == name {
                return Some(pane.to_string());
            }
        }
    }
    None
}

/// All `(window_name, pane_id)` pairs in `session`. Used by team recovery to
/// nudge every agent window back online after a server restart.
pub fn list_named_windows(session: &str) -> Vec<(String, String)> {
    match run_tmux(&["list-windows", "-t", &exact_session(session), "-F", "#{window_name}<TMM_SEP>#{pane_id}"]) {
        Ok(out) => out
            .lines()
            .filter_map(|line| {
                let mut it = line.split("<TMM_SEP>");
                match (it.next(), it.next()) {
                    (Some(n), Some(p)) if !n.is_empty() && !p.is_empty() => {
                        Some((n.to_string(), p.to_string()))
                    }
                    _ => None,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Create a new window named `name` in `session` rooted at `cwd`, returning the
/// new pane id (`%NN`). The window name lets the Team tab map an agent to its
/// pane by `window_name`.
pub fn new_named_window(session: &str, name: &str, cwd: &str) -> Result<String, String> {
    let dir = if cwd.is_empty() { home_dir() } else { cwd.to_string() };
    let target = exact_session(session);
    let mut args = vec!["new-window", "-t", &target, "-n", name, "-P", "-F", "#{pane_id}"];
    if !dir.is_empty() {
        args.push("-c");
        args.push(&dir);
    }
    let out = run_tmux(&args)?;
    Ok(out.trim().to_string())
}

/// How long a fresh pane may take to show its prompt before typing anyway.
pub const SHELL_READY: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait until the shell in a FRESH pane has drawn its prompt, so a line
/// typed into it lands (board #325). Bytes that reach the pty before the
/// shell's line editor is up are echoed by the tty and then lost: zsh's zle
/// init (and any rc step that reads or flushes the terminal) discards the
/// pending input, and the window is left at a bare prompt — measured on
/// clawdbjs (macOS, zsh 5.9 login shell + starship) 2026-10-09: every agent
/// restart typed `. launch-<agent>.sh` into nothing. A fixed sleep only
/// races a slow init.
///
/// Ready = the cursor sits after something on its row (a prompt ends with
/// the cursor past column 0; a banner line ends at column 0) and the screen
/// and cursor are unchanged across two polls, so a prompt still being
/// drawn is waited out. Bounded by `deadline`: on timeout (an empty PS1, a
/// shell that never settles) it returns false and the caller types anyway —
/// never a hang. A dead pane returns false at once.
pub fn wait_for_shell(pane: &str, deadline: std::time::Duration) -> bool {
    let ready = wait_for_shell_on(get_socket().as_deref(), pane, deadline);
    if !ready {
        eprintln!("[tmux] {pane}: no shell prompt within {} ms — typing anyway", deadline.as_millis());
    }
    ready
}

/// `wait_for_shell` on a server named by the caller (board #422: the
/// restore executor binds every tmux call to its batch's socket).
pub(crate) fn wait_for_shell_on(socket: Option<&str>, pane: &str, deadline: std::time::Duration) -> bool {
    let run_tmux = |args: &[&str]| run_tmux_on(socket, args);
    let start = std::time::Instant::now();
    let mut last: Option<String> = None;
    loop {
        let state = run_tmux(&["display-message", "-p", "-t", pane, "#{pane_dead} #{cursor_x} #{cursor_y}"]);
        let Ok(state) = state else { return false };
        let mut it = state.split_whitespace();
        let (dead, x) = (it.next() == Some("1"), it.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0));
        if dead {
            return false;
        }
        if x > 0 {
            let screen = run_tmux(&["capture-pane", "-p", "-t", pane]).unwrap_or_default();
            let now = format!("{state}\n{screen}");
            if last.as_deref() == Some(now.as_str()) {
                return true;
            }
            last = Some(now);
        } else {
            last = None;
        }
        // `false` is the caller's to judge: `wait_for_shell`'s callers type
        // anyway; the restore executor never does (board #422).
        if start.elapsed() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Rename the window at `target` (`session:index`, `session:^`, or a pane id).
/// Used when reconciling a project: a freshly created session already owns one
/// window named after the shell, and the first slot takes it over instead of
/// leaving a stray window behind.
pub fn rename_window(target: &str, name: &str) -> Result<(), String> {
    run_tmux(&["rename-window", "-t", target, name]).map(|_| ())
}

/// Resize the window containing target pane to given cols × rows.
/// Only effective when no terminal client is attached to the session.
pub fn resize_pane(target: &str, cols: usize, rows: usize) -> Result<(), String> {
    run_tmux(&[
        "resize-window",
        "-t",
        target,
        "-x",
        &cols.to_string(),
        "-y",
        &rows.to_string(),
    ])?;
    Ok(())
}

/// Restore a window to auto-size based on attached clients.
pub fn run_resize_window_auto(target: &str) -> Result<(), String> {
    run_tmux(&["resize-window", "-t", target, "-A"])?;
    Ok(())
}

/// Set a tmux hook so the next client that attaches to this session auto-resizes windows.
pub fn set_resize_hook(session: &str) -> Result<(), String> {
    // client-session-changed fires when a client switches to this session.
    // The hook runs resize-window -A (auto-fit) then removes itself (one-shot).
    // The hook body is a tmux COMMAND LINE that tmux re-parses when it fires,
    // so the session name inside it is quoted — bare, a name with a space or
    // `;` became extra commands. (set-hook's own `-t` is argv and needs no
    // quoting; it does not accept an `=` prefix.)
    let hook_cmd = format!(
        "resize-window -A ; set-hook -u -t {} client-session-changed",
        tmux_quote(session)
    );
    set_hook(session, "client-session-changed", &hook_cmd)?;
    Ok(())
}

/// Set a tmux hook on a session. The body is a tmux COMMAND LINE that tmux
/// re-parses when the hook fires, so a caller embedding data in it must
/// `tmux_quote` that data; the `-t` target is argv and does not accept an
/// `=` prefix (see `exact_session`).
pub fn set_hook(session: &str, hook: &str, command: &str) -> Result<(), String> {
    run_tmux(&["set-hook", "-t", session, hook, command]).map(|_| ())
}

/// Read a hook back (hooks are options in tmux 3.x — `show-options -v` is the
/// one reader). `None` when unset. Bare name, like `set-hook`.
pub fn session_hook(session: &str, hook: &str) -> Option<String> {
    run_tmux(&["show-options", "-t", session, "-v", hook])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Set a WINDOW option through any target in that window (a pane target is
/// accepted). `remain-on-exit` is a window option, so a session target would
/// only ever reach that session's CURRENT window.
pub fn set_window_option(target: &str, option: &str, value: &str) -> Result<(), String> {
    run_tmux(&["set-option", "-w", "-t", target, option, value]).map(|_| ())
}

/// One tmux FORMAT read against a pane/window target (`#{pane_pid}`,
/// `#{pane_dead}`, …). A pane target is passed through as given: the `=name:`
/// exact form names a SESSION and would break `sess:win.pane`.
pub fn pane_format(target: &str, fmt: &str) -> Option<String> {
    run_tmux(&["display-message", "-t", target, "-p", fmt])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Read a WINDOW option back through any target in that window.
pub fn window_option(target: &str, option: &str) -> Option<String> {
    run_tmux(&["show-options", "-w", "-t", target, "-v", option])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// A pane's liveness as tmux reports it: `Some(true)` while its command runs,
/// `Some(false)` for tmux's DEAD state (the command exited while
/// `remain-on-exit` was on, so the pane is still there with nothing running),
/// and `None` when the answer cannot be read OR is not one tmux promises.
/// ONE reading of the fact, so no caller has to decide what an unreadable
/// answer means by itself.
///
/// STRICT on purpose (#326 review): `#{pane_dead}` is `0` or `1`, and
/// anything else — a missing pane's empty answer, a format tmux stops
/// supporting, a future value — is UNKNOWN. Mapping "not 1" to live is how an
/// unreadable pane would have been handed out as ready.
pub fn pane_live(target: &str) -> Option<bool> {
    liveness(pane_format(target, "#{pane_dead}").as_deref())
}

/// The pure mapping, so the three answers can be tested without tmux.
fn liveness(raw: Option<&str>) -> Option<bool> {
    match raw? {
        "0" => Some(true),
        "1" => Some(false),
        _ => None,
    }
}

/// Restart a DEAD pane's command IN PLACE, keeping the pane (and therefore its
/// `session:window.pane` target and `%id`) and its original start directory.
///
/// Deliberately WITHOUT `-k`: tmux refuses ("pane … still active") when the
/// pane's command is still running, which makes "only a dead pane" ONE atomic
/// tmux decision instead of a check-then-kill in our code. A caller that read
/// `pane_live` first cannot rely on that reading — a `pane-died` hook or a
/// concurrent caller may have revived the pane in between, and `-k` would then
/// have killed a live shell and whatever it had started. So a refusal is not a
/// failure to handle: it means someone else won the race and the pane is
/// running, which was the point. Verified on tmux 3.6a, including two
/// concurrent respawns of one dead pane (one wins, the other is refused, the
/// surviving shell keeps its pid) and a repair attempt against a pane running
/// `sleep 120` (refused, pid unchanged).
pub fn respawn_pane(target: &str) -> Result<(), String> {
    run_tmux(&["respawn-pane", "-t", target]).map(|_| ())
}

/// 检查 tmux server 是否运行
pub fn is_server_running() -> bool {
    run_tmux(&["list-sessions"]).is_ok()
}

/// Scratch tmux sessions and directories for lib tests (board #268). Every
/// cargo run on the host shares ONE tmux server and one temp dir, so a fixed
/// name let a concurrent run kill another run's session or delete its
/// directory mid-test — and a leaked `tmm-test-share-a` was auto-adopted as a
/// live project. Names carry the pid; the guard is taken before anything
/// exists and, on drop (also on panic), kills its sessions and removes its
/// directory (the #251 rule).
#[cfg(test)]
pub(crate) struct Scratch {
    tag: String,
    sessions: Vec<String>,
    dir: std::path::PathBuf,
}

#[cfg(test)]
impl Scratch {
    /// `tmm-test-<tag>-<pid>`, with a fresh empty directory of that name.
    pub(crate) fn new(tag: &str) -> Self {
        let tag = format!("tmm-test-{tag}-{}", std::process::id());
        let dir = std::env::temp_dir().join(&tag);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create the scratch dir");
        Scratch { tag, sessions: Vec::new(), dir }
    }
    /// A session name owned by this guard (killed now if a crashed run of
    /// this same pid left it, and again on drop).
    pub(crate) fn session(&mut self, part: &str) -> String {
        let name = format!("{}-{part}", self.tag);
        let _ = kill_session(&name);
        self.sessions.push(name.clone());
        name
    }
    /// The canonical scratch directory path.
    pub(crate) fn path(&self) -> String {
        self.dir.canonicalize().unwrap_or_else(|_| self.dir.clone()).to_string_lossy().to_string()
    }
}

#[cfg(test)]
impl Drop for Scratch {
    fn drop(&mut self) {
        for s in &self.sessions {
            let _ = kill_session(s);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Test support for anything that touches the process-global tmux socket
/// (board #349). Incident 2026-10-12 05:51: a bare `cargo test --lib` (no
/// `--test-threads=1`) ran the `tasks.rs` private-server tests in parallel
/// with the gateway probe tests, which start a server and so set the global
/// to `None`; a private server's `kill-server`, issued THROUGH the global,
/// went to the socket tmux resolves on its own — the developer's default
/// server — and every session on the host died. Three rules follow, all
/// here:
/// - a destructive command names its server itself (`destroy_private_server`
///   → `run_tmux_on(Some(socket), …)`), never through the global;
/// - a test that reads or writes the global does so inside ONE
///   `GlobalSocket` scope: taking it locks the global and snapshots its value,
///   dropping it restores the snapshot and only then unlocks — on a normal
///   exit and on a panic alike — so the next test finds what it would have
///   found, and no write happens outside a held scope;
/// - that scope REFUSES to open unless the test run is serial: before any
///   tmux command or global write it checks the test binary's own argv for
///   `--test-threads=1` (or `RUST_TEST_THREADS=1`), and panics with the
///   incident and the two allowed commands otherwise. A mistake fails at
///   once, with no contention needed and before a side effect; `npm run
///   test:rust` passes the flag and is never affected.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn lock() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

    pub const PARALLEL_MESSAGE: &str = "tmux-touching tests must run SEQUENTIALLY (incident 2026-10-12 05:51: a bare `cargo test --lib` killed the developer's default tmux server and every session on the host). Run `npm run test:rust`, or `cargo test … -- --test-threads=1`.";

    pub const UNISOLATED_MESSAGE: &str = "tmux-touching tests must run in an ISOLATED tmux environment — TMUX and TMUX_PANE unset, TMUX_TMPDIR set to a throwaway directory (incident 2026-10-12 07:12: a test run in the developer's own shell killed the real default tmux server). Run `npm run test:rust`, which sets this up, or wrap cargo in `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$(mktemp -d)`.";

    /// Is this test process kept away from any real tmux: no `$TMUX`
    /// (inherited pane), no `$TMUX_PANE`, and a `$TMUX_TMPDIR` so the
    /// "default" server it could reach is one under a throwaway dir, not the
    /// user's `/tmp/tmux-<uid>/default`. Pure; the shapes are tested.
    pub fn isolated_run(tmux: Option<&str>, tmux_pane: Option<&str>, tmux_tmpdir: Option<&str>) -> bool {
        tmux.is_none() && tmux_pane.is_none() && tmux_tmpdir.map(|d| !d.trim().is_empty()).unwrap_or(false)
    }

    fn this_run_is_isolated() -> bool {
        isolated_run(
            std::env::var("TMUX").ok().as_deref(),
            std::env::var("TMUX_PANE").ok().as_deref(),
            std::env::var("TMUX_TMPDIR").ok().as_deref(),
        )
    }

    /// Is this test run serial, by what libtest itself reads: the binary's
    /// argv (`--test-threads=N` / `--test-threads N`; last one wins, as in
    /// libtest), else `RUST_TEST_THREADS`, else libtest's default — the
    /// machine's parallelism. A bare `--` ENDS libtest's option parsing and
    /// everything after it is a test-name filter (measured 2026-10-12:
    /// `--test-threads=4 -- --test-threads=1` runs 4 threads), so the scan
    /// stops there too — a `--test-threads=1` in the filter zone is a filter,
    /// not a promise (reviewer P1 on 6e166901). Pure; the shapes are tested.
    pub fn serial_run(args: impl IntoIterator<Item = String>, env_threads: Option<&str>, parallelism: usize) -> bool {
        let mut from_args: Option<String> = None;
        let mut args = args.into_iter();
        while let Some(a) = args.next() {
            if a == "--" {
                break;
            }
            if let Some(v) = a.strip_prefix("--test-threads=") {
                from_args = Some(v.to_string());
            } else if a == "--test-threads" {
                from_args = args.next();
            }
        }
        let threads = from_args.as_deref().or(env_threads).and_then(|v| v.trim().parse::<usize>().ok());
        match threads {
            Some(n) => n == 1,
            None => parallelism == 1,
        }
    }

    fn this_run_is_serial() -> bool {
        serial_run(
            std::env::args(),
            std::env::var("RUST_TEST_THREADS").ok().as_deref(),
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(usize::MAX),
        )
    }

    /// The one scope a test holds while it touches the process-global tmux
    /// socket: lock + snapshot on open, restore then unlock on close.
    pub struct GlobalSocket {
        snapshot: Option<String>,
        _hold: MutexGuard<'static, ()>,
    }

    impl GlobalSocket {
        /// Refuses a parallel or an unisolated run BEFORE taking the lock or
        /// reading anything — the two incidents, each its own check.
        pub fn hold() -> Self {
            assert!(this_run_is_serial(), "{}", PARALLEL_MESSAGE);
            assert!(this_run_is_isolated(), "{}", UNISOLATED_MESSAGE);
            // Serial by contract; a second taker can only be a bug in a
            // test holding two scopes, and that would deadlock here rather
            // than pass. The message names the rule for that case too.
            let hold = match lock().try_lock() {
                Ok(g) => g,
                Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => panic!("a GlobalSocket scope is already open on another thread — {}", PARALLEL_MESSAGE),
            };
            Self { snapshot: super::get_socket(), _hold: hold }
        }

        /// The only sanctioned write to the global from a test.
        pub fn set(&self, socket: Option<String>) {
            super::set_socket(socket);
        }

        pub fn get(&self) -> Option<String> {
            super::get_socket()
        }
    }

    impl Drop for GlobalSocket {
        fn drop(&mut self) {
            // Restore first; the lock (`_hold`) is released after this body.
            super::set_socket(self.snapshot.take());
        }
    }

    /// The prefix every private test server's socket carries.
    pub const PRIVATE_PREFIX: &str = "tmm-test-";

    /// What `destroy_private_server` checks, as a pure predicate: the socket
    /// is an absolute path INSIDE `temp` whose file name starts with
    /// `PRIVATE_PREFIX`, and is not `implicit` (the server a bare `tmux` would
    /// reach from this process). That is "a private test server's" — the
    /// temp dir and the prefix are where and how `PrivateServer` creates them;
    /// it does not prove THIS test created it, and does not claim to.
    pub fn is_private_socket(socket: &Path, temp: &Path, implicit: &Path) -> bool {
        let name = socket.file_name().and_then(|n| n.to_str()).unwrap_or("");
        socket.is_absolute() && socket.starts_with(temp) && name.starts_with(PRIVATE_PREFIX) && socket != implicit
    }

    /// `kill-server` on exactly `socket`, named on the command line. Refuses,
    /// with a panic a test cannot shrug off, anything `is_private_socket`
    /// does not accept.
    pub fn destroy_private_server(socket: &str) -> Result<String, String> {
        assert!(
            is_private_socket(Path::new(socket), &std::env::temp_dir(), &super::implicit_socket()),
            "refusing to kill-server on {socket:?}: not a private test server (an absolute {PRIVATE_PREFIX}* path under {}, and never the implicit socket)",
            std::env::temp_dir().display()
        );
        super::run_tmux_on(Some(socket), &["kill-server"])
    }

    /// A tmux server on its own socket under the temp dir, destroyed when
    /// dropped — on a passing test and on an assertion failure alike, so no
    /// test leaves a server behind. It never touches the global.
    pub struct PrivateServer {
        pub socket: String,
    }

    impl PrivateServer {
        pub fn new(tag: &str) -> Self {
            let socket: PathBuf = std::env::temp_dir().join(format!("{PRIVATE_PREFIX}{tag}-{}.sock", std::process::id()));
            let socket = socket.to_string_lossy().to_string();
            let _ = destroy_private_server(&socket);
            Self { socket }
        }

        pub fn run(&self, args: &[&str]) -> Result<String, String> {
            super::run_tmux_on(Some(&self.socket), args)
        }
    }

    impl Drop for PrivateServer {
        fn drop(&mut self) {
            let _ = destroy_private_server(&self.socket);
            let _ = std::fs::remove_file(&self.socket);
        }
    }

    /// A private server that production code under test will reach: its
    /// socket is set as the global for the test's body, through the scope
    /// the test holds. `Drop` destroys the server by ITS socket — the global
    /// is not consulted — and puts the global back to what it was when this
    /// started; the scope's own drop restores the test's entry value after.
    ///
    /// Drop ORDER is part of the contract (board #349 item 6, incident
    /// 07:12): the server is destroyed FIRST, while the global still names
    /// it, and only then is the global put back. With the explicit `-S` the
    /// order changes nothing; it is the layer that holds if the `-S` is ever
    /// lost — then a kill that reads the global still finds this server's
    /// socket there, not whatever the restore would have put back (at 07:12:
    /// `None`, the developer's default). Rust drops fields in declaration
    /// order after the `Drop` body, so `server` is declared first AND the
    /// body destroys it explicitly before touching the global; the test
    /// `a_private_tmux_destroys_before_its_scope_restores` pins the order.
    pub struct PrivateTmux<'g> {
        server: Option<PrivateServer>,
        socket: String,
        guard: &'g GlobalSocket,
        previous: Option<String>,
    }

    impl<'g> PrivateTmux<'g> {
        pub fn start(guard: &'g GlobalSocket, tag: &str) -> Self {
            let server = PrivateServer::new(tag);
            let socket = server.socket.clone();
            let previous = guard.get();
            guard.set(Some(socket.clone()));
            Self { server: Some(server), socket, guard, previous }
        }

        pub fn socket(&self) -> &str {
            &self.socket
        }

        /// Run a command on this private server, by its socket.
        pub fn run(&self, args: &[&str]) -> Result<String, String> {
            super::run_tmux_on(Some(&self.socket), args)
        }
    }

    impl Drop for PrivateTmux<'_> {
        fn drop(&mut self) {
            // 1. destroy the server, by its own socket, while the global still
            //    names it; 2. only then put the global back.
            drop(self.server.take());
            self.guard.set(self.previous.take());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #422 (validator K9): a window identity's server is the full
    /// incarnation — socket, pid AND start time — because a new server can
    /// reuse a pid and an `@id`. Each half is pinned: the same pid with
    /// another start time is another server, and so is another socket.
    #[test]
    fn same_server_compares_the_whole_incarnation() {
        let w = WindowIdentity { socket: "/tmp/s".into(), server_pid: 7, server_start: 900, session: "a".into(), index: 1, name: "dev".into(), id: "@3".into() };
        assert!(w.same_server(&w.clone()), "control: the same incarnation");
        assert!(!w.same_server(&WindowIdentity { server_start: 950, ..w.clone() }), "same pid, a later start: a new server");
        assert!(!w.same_server(&WindowIdentity { socket: "/tmp/other".into(), ..w.clone() }), "same pid and start, another socket");
        assert!(!w.same_server(&WindowIdentity { server_pid: 8, ..w.clone() }));
        assert!(w.same_server(&WindowIdentity { index: 2, name: "x".into(), ..w.clone() }), "the window fields are not the server's");
    }

    /// Board #349: the destructive helper names its server on the command
    /// line, so a global pointed elsewhere cannot redirect it — proven with a
    /// SECOND private server standing in for "the server the global now
    /// points at" (at 05:51: None, the developer's default): it must survive
    /// the first one's Drop. Every write to the global is through the one
    /// held scope, and both servers are RAII — an assertion failure leaves
    /// nothing behind.
    #[test]
    fn a_private_servers_kill_goes_to_its_own_socket_whatever_the_global_says() {
        let scope = test_support::GlobalSocket::hold();
        let b = test_support::PrivateServer::new("own-b");
        b.run(&["new-session", "-d", "-s", "b-lives-here"]).unwrap();
        let a = test_support::PrivateTmux::start(&scope, "own-a");
        let a_socket = a.socket().to_string();
        a.run(&["new-session", "-d", "-s", "a-lives-here"]).unwrap();
        assert_eq!(scope.get().as_deref(), Some(a_socket.as_str()), "production code would reach A");
        // The incident's move: the global now names another server.
        scope.set(Some(b.socket.clone()));
        drop(a);
        assert!(b.run(&["has-session", "-t", "=b-lives-here:"]).is_ok(), "B is untouched by A's Drop");
        assert!(run_tmux_on(Some(&a_socket), &["has-session", "-t", "=a-lives-here:"]).is_err(), "A's own server is gone");
        assert!(!std::path::Path::new(&a_socket).exists(), "and its socket file with it");
    }

    /// P1-1: one scope = lock + snapshot; restore then unlock on drop, on a
    /// normal exit and on a panic. Whatever a scope did — moved the global to
    /// None as starting a real server does, to a private socket as a
    /// PrivateTmux does, or died half-way — the value after it is the value
    /// before it, so the previous test's tail cannot change the next test's
    /// choice. Two controlled private paths; never the default.
    #[test]
    fn a_scope_restores_the_global_it_found_on_every_exit() {
        let entry = get_socket();
        let p1 = std::env::temp_dir().join("tmm-test-restore-1.sock").to_string_lossy().to_string();
        let p2 = std::env::temp_dir().join("tmm-test-restore-2.sock").to_string_lossy().to_string();
        // Normal exit after writing None (a probe test's shape).
        {
            let scope = test_support::GlobalSocket::hold();
            assert_eq!(scope.get(), entry, "a scope opens on the live value");
            scope.set(None);
        }
        assert_eq!(get_socket(), entry, "a normal exit put it back");
        // Normal exit after writing a private socket.
        {
            let scope = test_support::GlobalSocket::hold();
            scope.set(Some(p1.clone()));
            assert_eq!(get_socket().as_deref(), Some(p1.as_str()), "production code inside the scope sees the write");
        }
        assert_eq!(get_socket(), entry);
        // A panic while the global is moved.
        let r = std::panic::catch_unwind(|| {
            let scope = test_support::GlobalSocket::hold();
            scope.set(Some(p2.clone()));
            panic!("a failing test, mid-scope");
        });
        assert!(r.is_err());
        assert_eq!(get_socket(), entry, "a panic exit put it back too");
        // A PrivateTmux inside a scope: its Drop returns the global to what
        // the scope had at its start; the scope's drop returns the entry value.
        {
            let scope = test_support::GlobalSocket::hold();
            scope.set(Some(p1.clone()));
            {
                let p = test_support::PrivateTmux::start(&scope, "restore-inner");
                assert_eq!(scope.get().as_deref(), Some(p.socket()));
            }
            assert_eq!(scope.get().as_deref(), Some(p1.as_str()), "PrivateTmux's Drop restored the scope's value");
        }
        assert_eq!(get_socket(), entry);
        // Two scopes in sequence, the second seeing the restored value and
        // not the first's write — the "tail changes the next test" hole.
        {
            let first = test_support::GlobalSocket::hold();
            first.set(Some(p2.clone()));
        }
        {
            let second = test_support::GlobalSocket::hold();
            assert_eq!(second.get(), entry, "the second scope opens on the entry value, not on the first's write");
        }
    }

    /// P1-2: the serial check reads what libtest reads, on fake inputs — the
    /// two argv spellings (last one wins), the env var, and libtest's default
    /// of the machine's parallelism when neither is given.
    #[test]
    fn the_serial_check_reads_what_libtest_reads() {
        use test_support::serial_run;
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(serial_run(args(&["bin", "--test-threads=1"]), None, 64));
        assert!(serial_run(args(&["bin", "--test-threads", "1"]), None, 64));
        assert!(!serial_run(args(&["bin", "--test-threads=4"]), None, 1), "explicit 4 is parallel even on one core");
        assert!(!serial_run(args(&["bin", "--test-threads", "8"]), Some("1"), 1), "argv wins over the env, as in libtest");
        assert!(serial_run(args(&["bin", "--test-threads=4", "--test-threads=1"]), None, 64), "the last argv value wins");
        assert!(serial_run(args(&["bin", "tmux::tests"]), Some("1"), 64), "RUST_TEST_THREADS=1 is a serial run");
        assert!(!serial_run(args(&["bin", "tmux::tests"]), Some("3"), 64));
        assert!(!serial_run(args(&["bin"]), None, 64), "nothing said on a 64-way machine: libtest runs 64 threads");
        assert!(serial_run(args(&["bin"]), None, 1), "nothing said on a 1-way machine: libtest runs 1");
        assert!(!serial_run(args(&["bin", "--test-threads=garbage"]), None, 64), "unparseable is not a promise");
        // A bare `--` ends libtest's option parsing: what follows is filters.
        assert!(!serial_run(args(&["bin", "--test-threads=4", "--", "--test-threads=1"]), None, 64), "the =1 after -- is a filter string; libtest runs 4");
        assert!(!serial_run(args(&["bin", "--", "--test-threads=1"]), None, 64), "only a filter; libtest runs the default");
        assert!(serial_run(args(&["bin", "--test-threads=1", "--", "--test-threads=4"]), None, 64), "the =4 after -- is a filter; libtest runs 1");
        assert!(serial_run(args(&["bin", "--", "anything"]), Some("1"), 64), "the env still decides when argv says nothing before --");
    }

    /// P1-2, end to end on THIS test binary in a subprocess: one protected
    /// test selected alone — no contention possible — is refused when the
    /// run is not declared serial, and runs under either declaration.
    #[test]
    fn a_protected_test_refuses_to_run_in_an_undeclared_parallel_run() {
        let exe = std::env::current_exe().unwrap();
        // The fixture is a test that opens a scope and does NOTHING else — no
        // tmux, no private server, no destroy path — so the subprocess under
        // the unisolated shapes exercises only the gate (reviewer P2-C on
        // a7b7a5cd: a fixture that builds a PrivateTmux would, with a broken
        // gate, run a destroy inside an unisolated child).
        let target = "tmux::tests::opening_a_scope_is_the_gate";
        let iso = std::env::temp_dir().join(format!("tmm-test-iso-{}", std::process::id()));
        std::fs::create_dir_all(&iso).unwrap();
        // `tmux_env`: what the child sees of tmux — None = the isolated shape
        // (TMUX/TMUX_PANE unset, TMUX_TMPDIR = a throwaway dir); Some(k, v) =
        // that one variable set INSTEAD, the unisolated shapes.
        let run = |args: &[&str], env_threads: Option<&str>, tmux_env: Option<(&str, &str)>| {
            let mut c = std::process::Command::new(&exe);
            c.arg("--exact").arg(target).args(args)
                .env_remove("RUST_TEST_THREADS").env_remove("TMUX").env_remove("TMUX_PANE").env_remove("TMUX_TMPDIR");
            if let Some(n) = env_threads {
                c.env("RUST_TEST_THREADS", n);
            }
            match tmux_env {
                None => { c.env("TMUX_TMPDIR", &iso); }
                Some((k, v)) => { c.env(k, v); }
            }
            let out = c.output().expect("the test binary runs");
            (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
        };
        // Parallelism (incident 05:51).
        let (ok, text) = run(&["--test-threads=4"], None, None);
        assert!(!ok, "an explicit parallel run must be refused:\n{text}");
        assert!(text.contains("2026-10-12 05:51") && text.contains("npm run test:rust"), "the refusal names the incident and the command:\n{text}");
        let (ok, text) = run(&[], Some("2"), None);
        assert!(!ok, "RUST_TEST_THREADS=2 must be refused:\n{text}");
        // Isolation (incident 07:12): serial, but in a real shell.
        let (ok, text) = run(&["--test-threads=1"], None, Some(("TMUX", "/tmp/tmux-1000/default,1,0")));
        assert!(!ok && text.contains("2026-10-12 07:12"), "$TMUX set must be refused, naming the incident:\n{text}");
        let (ok, text) = run(&["--test-threads=1"], None, Some(("TMUX_PANE", "%1")));
        assert!(!ok, "$TMUX_PANE set must be refused:\n{text}");
        let (ok, text) = run(&["--test-threads=1"], None, Some(("HOME", "/nowhere")));
        assert!(!ok, "no TMUX_TMPDIR must be refused:\n{text}");
        // Both satisfied: runs, in each spelling.
        let (ok, text) = run(&["--test-threads=1"], None, None);
        assert!(ok, "--test-threads=1 runs:\n{text}");
        let (ok, text) = run(&["--test-threads", "1"], None, None);
        assert!(ok, "--test-threads 1 runs:\n{text}");
        let (ok, text) = run(&[], Some("1"), None);
        assert!(ok, "RUST_TEST_THREADS=1 runs:\n{text}");
        let _ = std::fs::remove_dir_all(&iso);
    }

    /// The gate and nothing else: the fixture the subprocess test selects.
    /// Opens a scope (which runs both checks) and closes it. No tmux.
    #[test]
    fn opening_a_scope_is_the_gate() {
        let scope = test_support::GlobalSocket::hold();
        let _ = scope.get();
    }

    /// Item 3 (07:15): the isolation predicate on its shapes.
    #[test]
    fn the_isolation_check_wants_no_inherited_tmux_and_a_throwaway_tmpdir() {
        use test_support::isolated_run;
        assert!(isolated_run(None, None, Some("/tmp/tmm-iso-abc")));
        assert!(!isolated_run(Some("/tmp/tmux-1000/default,1,0"), None, Some("/tmp/x")), "$TMUX: a pane we are in");
        assert!(!isolated_run(None, Some("%1"), Some("/tmp/x")), "$TMUX_PANE alone is still a real pane");
        assert!(!isolated_run(None, None, None), "no TMUX_TMPDIR: the default is the user's");
        assert!(!isolated_run(None, None, Some("")), "an empty TMUX_TMPDIR is unset to tmux");
    }

    /// Item 6: a PrivateTmux destroys its server BEFORE its scope restores
    /// the global — observed through the global itself: at the moment the
    /// server dies, the global still names it. Modelled with the real drop
    /// and a server whose death is detectable by its socket file, since the
    /// explicit -S makes the order invisible to the kill.
    #[test]
    fn a_private_tmux_destroys_before_its_scope_restores() {
        let scope = test_support::GlobalSocket::hold();
        let entry = std::env::temp_dir().join("tmm-test-order-entry.sock").to_string_lossy().to_string();
        scope.set(Some(entry.clone()));
        let p = test_support::PrivateTmux::start(&scope, "order");
        let sock = p.socket().to_string();
        p.run(&["new-session", "-d", "-s", "order-lives-here"]).unwrap();
        assert_eq!(scope.get().as_deref(), Some(sock.as_str()));
        assert!(std::path::Path::new(&sock).exists(), "the server is up");
        // The order is a property of Drop's body; it is pinned by reading the
        // source of that body, because no observer can run between its two
        // statements. The runtime half: after drop, the server is gone AND
        // the global is back — both halves happened.
        drop(p);
        assert!(run_tmux_on(Some(&sock), &["has-session", "-t", "=order-lives-here:"]).is_err(), "destroyed");
        assert_eq!(scope.get().as_deref(), Some(entry.as_str()), "restored");
        let src = include_str!("tmux.rs");
        let body = src[src.find("impl Drop for PrivateTmux<'_>").unwrap()..].to_string();
        let body = &body[..body.find("\n    }\n").unwrap()];
        let destroy = body.find("drop(self.server.take())").expect("the Drop body destroys the server explicitly");
        let restore = body.find("self.guard.set(self.previous.take())").expect("and restores the global");
        assert!(destroy < restore, "destroy comes BEFORE restore in PrivateTmux's Drop (incident 07:12)");
        // And the field order agrees, for the implicit drops after the body.
        let decl = &src[src.find("pub struct PrivateTmux<'g> {").unwrap()..];
        let decl = &decl[..decl.find('}').unwrap()];
        assert!(decl.find("server:").unwrap() < decl.find("guard:").unwrap(), "`server` is declared before `guard`");
    }

    /// The destroy path cannot be aimed at the server a developer sits in,
    /// nor at anything that is not a private test server — checked on the
    /// pure predicate with controlled paths, never a real user socket.
    #[test]
    fn destroy_refuses_anything_but_a_private_test_server() {
        use std::path::Path;
        use test_support::is_private_socket;
        let temp = Path::new("/tmp");
        let implicit = Path::new("/tmp/tmux-1000/default");
        assert!(is_private_socket(Path::new("/tmp/tmm-test-x-1.sock"), temp, implicit));
        assert!(!is_private_socket(Path::new(""), temp, implicit));
        assert!(!is_private_socket(Path::new("tmm-test-x.sock"), temp, implicit), "relative");
        assert!(!is_private_socket(Path::new("/tmp/default"), temp, implicit), "not our prefix");
        assert!(!is_private_socket(Path::new("/tmp/tmux-1000/default"), temp, implicit), "the implicit socket");
        assert!(!is_private_socket(Path::new("/home/x/tmm-test-x.sock"), temp, implicit), "outside the temp dir");
        assert!(!is_private_socket(Path::new("/tmp/tmux-1000/tmm-test-x"), temp, Path::new("/tmp/tmux-1000/tmm-test-x")), "implicit, even with our prefix");
        // And the refusal is a panic, not a quiet Err — a test cannot shrug it off.
        let msg = std::panic::catch_unwind(|| test_support::destroy_private_server("/nowhere/default")).unwrap_err();
        let text = msg.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(text.contains("refusing to kill-server"), "{text}");
    }

    /// Where a bare `tmux` would land from this process, read without asking
    /// tmux (which would start a server): `$TMUX` first, then the default.
    #[test]
    fn the_implicit_socket_is_read_from_the_environment_only() {
        let _scope = test_support::GlobalSocket::hold();
        let saved = (std::env::var_os("TMUX"), std::env::var_os("TMUX_TMPDIR"));
        std::env::set_var("TMUX", "/tmp/tmux-7/default,123,0");
        assert_eq!(implicit_socket(), std::path::PathBuf::from("/tmp/tmux-7/default"));
        std::env::remove_var("TMUX");
        std::env::set_var("TMUX_TMPDIR", "/x");
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        assert_eq!(implicit_socket(), std::path::PathBuf::from(format!("/x/tmux-{uid}/default")));
        match saved.0 { Some(v) => std::env::set_var("TMUX", v), None => std::env::remove_var("TMUX") }
        match saved.1 { Some(v) => std::env::set_var("TMUX_TMPDIR", v), None => std::env::remove_var("TMUX_TMPDIR") }
    }

    #[test]
    fn a_scratch_guard_owns_unique_names_and_cleans_up_on_drop() {
        let (session, dir) = {
            let mut s = Scratch::new("scratch");
            let session = s.session("x");
            assert!(session.starts_with("tmm-test-scratch-") && session.contains(&std::process::id().to_string()));
            if new_session(&session, Some(&s.path()), None).is_err() {
                eprintln!("no tmux server — skipping");
                return;
            }
            assert!(session_exists(&session));
            (session, s.path())
        };
        assert!(!session_exists(&session), "the guard killed its session");
        assert!(!std::path::Path::new(&dir).exists(), "and removed its directory");
        let panicked = std::panic::catch_unwind(|| {
            let mut s = Scratch::new("scratch-panic");
            let name = s.session("y");
            new_session(&name, None, None).unwrap();
            panic!("{name}");
        });
        let name = *panicked.unwrap_err().downcast::<String>().unwrap();
        assert!(!session_exists(&name), "a panicking test still cleans up");
        // A directory-only guard (no session) — how the file-only tests use
        // it (#269) — removes its directory when the test fails mid-way.
        let failed = std::panic::catch_unwind(|| {
            let s = Scratch::new("scratch-dir-panic");
            std::fs::write(std::path::Path::new(&s.path()).join("state.db"), "x").unwrap();
            panic!("{}", s.path());
        });
        let dir = *failed.unwrap_err().downcast::<String>().unwrap();
        assert!(!std::path::Path::new(&dir).exists(), "a failing file-only test leaves no directory");
    }

    /// Board #347: tmux's three answers to "list this session's panes", as
    /// measured on 3.6a. Only the first two mean the session is not there.
    #[test]
    fn a_missing_session_is_told_from_an_unreachable_tmux() {
        assert!(session_confirmed_absent("tmux error: can't find session: nope\n"));
        assert!(session_confirmed_absent("tmux error: error connecting to /tmp/x/sock (No such file or directory)\n"));
        assert!(session_confirmed_absent("tmux error: no server running on /tmp/x/sock\n"));
        assert!(!session_confirmed_absent("tmux error: error connecting to /tmp/x/sock (Permission denied)\n"));
        assert!(!session_confirmed_absent("Failed to run tmux: No such file or directory (os error 2)"));
        assert!(!session_confirmed_absent(""));
    }

    #[test]
    fn exact_session_prefixes_once() {
        assert_eq!(exact_session("dev"), "=dev:");
        assert_eq!(exact_session("=dev:"), "=dev:", "an already-exact target is left alone");
        assert_eq!(exact_session("a b"), "=a b:");
    }

    /// `#{pane_dead}` is `0` or `1`; everything else is UNKNOWN, never live
    /// (#326 review). The three states exist so a caller cannot read an
    /// unanswerable pane as ready — the mapping is pure, so it is pinned
    /// here rather than inferred from a live session.
    #[test]
    fn liveness_is_strict_about_what_tmux_promises() {
        assert_eq!(liveness(Some("0")), Some(true));
        assert_eq!(liveness(Some("1")), Some(false));
        for odd in [None, Some(""), Some(" "), Some("2"), Some("true"), Some("01"), Some("1\n")] {
            assert_eq!(liveness(odd), None, "{odd:?} is not an answer tmux promises");
        }
    }

    #[test]
    fn tmux_quote_escapes_what_the_command_parser_expands() {
        assert_eq!(tmux_quote("dev"), r#""dev""#);
        assert_eq!(tmux_quote("a b"), r#""a b""#);
        assert_eq!(tmux_quote("it's"), r#""it's""#, "an apostrophe needs no escape inside double quotes");
        assert_eq!(tmux_quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(tmux_quote("$HOME"), r#""\$HOME""#, "tmux expands $VAR inside double quotes");
        assert_eq!(tmux_quote(r"a\b"), r#""a\\b""#);
        assert_eq!(tmux_quote("x ; kill-server"), r#""x ; kill-server""#, "a quoted `;` is not a command separator");
    }

    /// Live against the running tmux: a session NAME resolves to itself and
    /// never to a sibling that merely starts with it. The names are unique per
    /// process so parallel suites sharing this tmux cannot collide.
    #[test]
    fn session_targets_are_exact_never_prefix_matches() {
        let base = format!("tmm-exact-{}", std::process::id());
        let sibling = format!("{base}-2");
        let _ = run_tmux(&["kill-session", "-t", &exact_session(&base)]);
        let _ = run_tmux(&["kill-session", "-t", &exact_session(&sibling)]);

        run_tmux(&["new-session", "-d", "-s", &sibling]).expect("create sibling");
        // Only `<base>-2` is alive. Bare `-t <base>` would prefix-match it.
        assert!(!session_exists(&base), "prefix match leaked into session_exists");
        assert!(list_panes(&base).is_err(), "list_panes answered for the sibling");
        new_session(&base, None, None).expect("the exact name is free, creation must succeed");
        assert!(session_exists(&base));
        assert!(session_exists(&sibling));
        assert_eq!(list_panes(&base).unwrap().len(), 1);

        kill_session(&base).expect("kill base");
        assert!(!session_exists(&base));
        assert!(session_exists(&sibling), "kill_session took the sibling instead of the exact name");
        // A glob in the name is a name, not a pattern.
        assert!(!session_exists(&format!("{base}*")));

        // A name with a space survives the hook body's re-parse.
        let spaced = format!("{base} sp");
        run_tmux(&["new-session", "-d", "-s", &spaced]).expect("create spaced");
        set_resize_hook(&spaced).expect("set_resize_hook on a spaced name");
        let hooks = run_tmux(&["show-hooks", "-t", &spaced]).unwrap_or_default();
        assert!(hooks.contains(&format!("-t \"{spaced}\"")), "hook body keeps the name quoted: {hooks}");

        kill_session(&spaced).expect("kill spaced");
        kill_session(&sibling).expect("kill sibling");
    }

    /// kiro-cli 2.18.1 screens as captured live (2026-09-03): the picker is
    /// recognised by its own footer, never by the turn's "esc to cancel".
    #[test]
    fn kiro_file_picker_is_recognised_by_its_footer_only() {
        let picker = "[tmm chat] human: @kiro [board #10] hello there\n\
                      @runtime/kirocrew-artifact.json\n\
                      ────────────────\n\
                       esc to cancel · ↵ to select\n";
        assert!(file_picker_open(picker));
        let streaming = "⠹ Thinking... (esc to cancel)\n\
                         ● 8 MCP failures — see /mcp\n\
                          Kiro is working · Type to steer · Ctrl+S to queue\n";
        assert!(!file_picker_open(streaming), "a running turn is not a picker");
        assert!(!file_picker_open("[tmm chat] human: @zzqx hello there\n"), "no match, no picker");
        assert!(!file_picker_open(""));
    }

    fn table(entries: &[(u32, u32, &str)]) -> std::collections::HashMap<u32, (u32, String)> {
        entries.iter().map(|&(pid, ppid, args)| (pid, (ppid, args.to_string()))).collect()
    }

    #[test]
    fn descendant_cmd_finds_interpreter_launched_agent() {
        // zsh(100) → node codex.js(200): the codex case where
        // pane_current_command only says "node".
        let t = table(&[
            (100, 1, "-zsh"),
            (200, 100, "node /Users/x/node_modules/@openai/codex/bin/codex.js"),
        ]);
        let cmd = descendant_cmd(&t, 100);
        assert!(cmd.contains("codex"), "got: {}", cmd);
    }

    #[test]
    fn descendant_cmd_keeps_all_levels() {
        // zsh(100) → claude(200) → tool subprocess(300). The agent's own
        // subprocess must not REPLACE the agent argv in the result.
        let t = table(&[
            (100, 1, "-zsh"),
            (200, 100, "claude --dangerously-skip-permissions"),
            (300, 200, "git status"),
        ]);
        let cmd = descendant_cmd(&t, 100);
        assert!(cmd.contains("claude"), "got: {}", cmd);
        assert!(cmd.contains("git status"), "got: {}", cmd);
    }

    #[test]
    fn descendant_cmd_idle_shell_is_empty() {
        let t = table(&[(100, 1, "-zsh")]);
        assert_eq!(descendant_cmd(&t, 100), "");
    }

    #[test]
    fn descendant_cmd_caps_runaway_argv() {
        let long = format!("node {}", "x".repeat(2000));
        let t = table(&[(100, 1, "-zsh"), (200, 100, long.as_str())]);
        assert!(descendant_cmd(&t, 100).len() <= 200);
    }

    // ── join_unflagged_wraps ──────────────────────────────────────────

    #[test]
    fn full_width_box_border_is_not_joined() {
        // kimi-style TUI frame: the border lines fill the pane exactly.
        // They are complete rows — joining them sheared the whole screen.
        let width = 10;
        let content = "╭────────╮\n│ hello  │\n╰────────╯";
        assert_eq!(visible_width("╭────────╮"), width);
        assert_eq!(join_unflagged_wraps(content, width), content);
    }

    #[test]
    fn unflagged_cjk_wrap_is_joined() {
        // 4 CJK chars = 8 cells; width 9 leaves the last column empty and
        // tmux forgets the WRAPPED flag. Next line starts with the wide
        // char that didn't fit → join.
        let content = "中文宽字\n符";
        assert_eq!(visible_width("中文宽字"), 8);
        assert_eq!(join_unflagged_wraps(content, 9), "中文宽字符");
    }

    #[test]
    fn width_minus_one_text_line_is_not_joined() {
        // A 9-cell ASCII line at width 10 is just a complete short row;
        // the next line starting with ASCII must stay separate.
        let content = "abcdefghi\njklmnop";
        assert_eq!(join_unflagged_wraps(content, 10), content);
    }

    #[test]
    fn chained_unflagged_wraps_join_across_segments() {
        // Each captured segment is width-1 wide and the continuation
        // starts wide → the chain collapses into one logical line.
        let content = "中中中中\n文文文文\n字";
        assert_eq!(join_unflagged_wraps(content, 9), "中中中中文文文文字");
    }

    #[test]
    fn ansi_escapes_are_ignored_when_matching() {
        // SGR-wrapped border: escapes must not count toward width and the
        // continuation check must skip escapes to find the first char.
        let border = "\x1b[31m╭────────╮\x1b[0m";
        let content = format!("{}\n\x1b[31m│ x      │\x1b[0m", border);
        assert_eq!(join_unflagged_wraps(&content, 10), content);
        let wrap = "\x1b[31m中文宽字\x1b[0m\n\x1b[31m符\x1b[0m";
        assert_eq!(join_unflagged_wraps(wrap, 9), "\x1b[31m中文宽字\x1b[0m\x1b[31m符\x1b[0m");
    }
    /// Kills its session when dropped, so a test that fails part-way leaves no
    /// live session behind: a leaked one is adopted as a project by the
    /// server running on the same tmux (2026-09-27: four `cat` sessions from
    /// the #250 negative controls became live projects rooted at $HOME).
    struct KillOnDrop(String);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = kill_session(&self.0);
        }
    }

    /// A session with two `cat` panes; the targets, or None without tmux.
    fn two_cat_panes(session: &str) -> Option<(KillOnDrop, Vec<String>)> {
        let _ = kill_session(session);
        if new_session(session, None, Some("cat")).is_err() {
            eprintln!("no tmux server — skipping");
            return None;
        }
        // Guarded from the moment it exists (validator, #251).
        let guard = KillOnDrop(session.to_string());
        let _ = run_tmux(&["new-window", "-d", "-t", &format!("={session}:"), "cat"]);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let targets: Vec<String> = run_tmux(&["list-panes", "-s", "-t", &format!("={session}"), "-F", "#{session_name}:#{window_index}.#{pane_index}"])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(targets.len(), 2);
        Some((guard, targets))
    }

    /// Board #250 (orchestrator 17:00): 20 concurrent two-pane multi-line
    /// pairs — the measured race (38 misdelivered, 20 lost with one shared
    /// buffer name) — lose nothing and swap nothing. Every thread holds its
    /// load and its paste 20 ms apart, so the pastes of the two panes overlap.
    #[test]
    fn concurrent_multiline_sends_to_two_panes_keep_their_own_text() {
        let session = format!("tmm-paste2-{}", std::process::id());
        let Some((_session, targets)) = two_cat_panes(&session) else { return };
        // Buffers are server-global and this tmux is shared (the live server,
        // a negative-control run): only buffers this test added count.
        let buffers = || -> std::collections::HashSet<String> {
            run_tmux(&["list-buffers", "-F", "#{buffer_name}"]).unwrap_or_default().lines().map(str::to_string).collect()
        };
        let before = buffers();
        const PAIRS: usize = 20;
        let handles: Vec<_> = (0..PAIRS)
            .flat_map(|i| targets.iter().enumerate().map(move |(n, t)| (i, n, t.clone())))
            .map(|(i, n, t)| {
                std::thread::spawn(move || {
                    PASTE_GAP.with(|g| g.set(std::time::Duration::from_millis(20)));
                    send_command(&t, &format!("p{n}-m{i}-first\np{n}-m{i}-second"))
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("every paste succeeds");
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
        let panes: Vec<String> = targets.iter().map(|t| capture_pane_plain(t, Some(400)).unwrap_or_default()).collect();
        let leftover: Vec<String> = buffers().difference(&before).filter(|b| b.starts_with("tmm-paste")).cloned().collect();
        let _ = kill_session(&session);
        for (n, text) in panes.iter().enumerate() {
            let lost: Vec<usize> = (0..PAIRS)
                .filter(|i| !(text.contains(&format!("p{n}-m{i}-first")) && text.contains(&format!("p{n}-m{i}-second"))))
                .collect();
            assert!(lost.is_empty(), "pane {n} lost {lost:?}:\n{text}");
            assert!(!text.contains(&format!("p{}-", 1 - n)), "pane {n} got the other pane's text:\n{text}");
        }
        assert!(leftover.is_empty(), "no buffer left behind: {leftover:?}");
    }

    /// Board #250: a pane in copy-mode swallows both send-keys and
    /// paste-buffer, and the mode's bindings can even end it — so the send
    /// is refused before anything is typed, and the mode (a person reading
    /// scrollback) is left exactly as it was. The other pane is unaffected.
    /// Board #325: a slow shell whose init DISCARDS pending input (zle init,
    /// an rc step that flushes the tty) loses a line typed right after the
    /// window opens; `wait_for_shell` waits for its prompt and the line runs.
    /// The shell is real (`zsh -f -i`, else `sh -i`) behind a 1 s init that
    /// sleeps, then flushes the tty input queue the way zle does.
    #[test]
    fn a_line_typed_into_a_fresh_pane_lands_only_after_the_prompt() {
        let mut guard = Scratch::new("shellready");
        let session = guard.session("s");
        if ensure_session(&session, &guard.path()).is_err() { return }
        let shell = if std::path::Path::new("/bin/zsh").exists() || std::path::Path::new("/usr/bin/zsh").exists() { "zsh -f -i" } else { "sh -i" };
        let slow = format!("sleep 1; python3 -c 'import termios,sys; termios.tcflush(0, termios.TCIFLUSH)'; PS1='rdy> ' exec {shell}");
        let open = |n: &str| {
            let out = run_tmux(&["new-window", "-d", "-t", &exact_session(&session), "-n", n, "-P", "-F", "#{pane_id}", "sh", "-c", &slow]).unwrap();
            out.trim().to_string()
        };
        let landed = |pane: &str, marker: &str| {
            for _ in 0..60 {
                let screen = run_tmux(&["capture-pane", "-p", "-t", pane]).unwrap_or_default();
                if screen.lines().any(|l| l.trim() == marker) { return true; }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            false
        };
        // The line spells the marker only when it RUNS (the echo shows it split).
        // Without the wait: typed into the flush, gone.
        let raw = open("raw");
        send_command(&raw, "echo MARK-$((6*7))-raw").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let lost = !landed(&raw, "MARK-42-raw");
        // With it: the prompt is waited for, the line runs.
        let ready = open("ready");
        let t = std::time::Instant::now();
        assert!(wait_for_shell(&ready, SHELL_READY), "the prompt was seen");
        assert!(t.elapsed() >= std::time::Duration::from_millis(900), "it waited out the slow init ({:?})", t.elapsed());
        send_command(&ready, "echo MARK-$((6*7))-ready").unwrap();
        assert!(landed(&ready, "MARK-42-ready"), "{}", run_tmux(&["capture-pane", "-p", "-t", &ready]).unwrap_or_default());
        assert!(lost, "negative control: without the wait the line is lost ({})", run_tmux(&["capture-pane", "-p", "-t", &raw]).unwrap_or_default());
        // Bounded: a pane that never shows a prompt returns false, no hang.
        let mute = run_tmux(&["new-window", "-d", "-t", &exact_session(&session), "-P", "-F", "#{pane_id}", "sleep", "30"]).unwrap();
        let t = std::time::Instant::now();
        assert!(!wait_for_shell(mute.trim(), std::time::Duration::from_millis(400)));
        assert!(t.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn send_command_refuses_a_pane_in_copy_mode_and_leaves_the_mode() {
        let session = format!("tmm-copymode-{}", std::process::id());
        let Some((_session, targets)) = two_cat_panes(&session) else { return };
        let (reading, free) = (&targets[0], &targets[1]);
        run_tmux(&["copy-mode", "-t", reading]).unwrap();
        assert!(pane_in_mode(reading).unwrap());
        let single = send_command(reading, "single-line q");
        let multi = send_command(reading, "multi-first\nmulti-second");
        let still = pane_in_mode(reading).unwrap();
        let other = send_command(free, "free-line");
        run_tmux(&["send-keys", "-t", reading, "-X", "cancel"]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let typed = capture_pane_plain(reading, Some(40)).unwrap_or_default();
        let free_text = capture_pane_plain(free, Some(40)).unwrap_or_default();
        let _ = kill_session(&session);
        assert_eq!(single, Err(PANE_IN_MODE.to_string()));
        assert_eq!(multi, Err(PANE_IN_MODE.to_string()));
        assert!(still, "the mode is never cancelled for us");
        assert!(!typed.contains("single-line") && !typed.contains("multi-"), "nothing typed: {typed:?}");
        assert_eq!(other, Ok(()));
        assert!(free_text.contains("free-line"), "{free_text:?}");
    }

    /// Board #122 (2): concurrent deliveries to ONE pane must not interleave.
    /// `send_command` types the text, sleeps 200 ms, then sends Enter — two
    /// unsynchronized callers could weave A-text, B-text, A-Enter, B-Enter,
    /// gluing A and B into one submitted line and submitting an empty second
    /// one. The per-target lock serializes the pair; this test races four
    /// threads at a `cat` pane and requires every line to arrive whole, alone
    /// on its own row.
    #[test]
    fn concurrent_sends_to_one_pane_never_interleave() {
        let session = format!("tmm-burst-{}", std::process::id());
        let _ = kill_session(&session);
        if new_session(&session, None, Some("cat")).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        // base-index is host config; ask tmux for the real pane target.
        let target = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &format!("={session}:"), "#{session_name}:#{window_index}.#{pane_index}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let lines: Vec<String> = (0..4).map(|n| format!("burst-line-{n}-{}", "x".repeat(24))).collect();
        let handles: Vec<_> = lines
            .iter()
            .map(|l| {
                let (t, l) = (target.clone(), l.clone());
                std::thread::spawn(move || send_command(&t, &l))
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("send ok");
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
        let text = capture_pane_plain(&target, Some(60)).unwrap_or_default();
        let _ = kill_session(&session);
        for l in &lines {
            // Each line must appear WHOLE on a row of its own (cat echoes the
            // submitted line): a glued "burst-line-0-…burst-line-1-…" row or a
            // missing line is the interleave this pins against.
            assert!(
                text.lines().any(|row| row.trim() == l),
                "line arrived whole and alone: {l}\n--- pane ---\n{text}"
            );
        }
    }


    /// The snapshot scope is the whole saving (board #145): two listings
    /// inside one scope read `ps` once; outside a scope each reads its own.
    /// (Pane lines are synthetic — the pid is this test's own, so the table
    /// lookup exercises the real `ps`.) Counts are deltas on a process-wide
    /// counter, which is why the Rust suite runs sequentially (testing.md).
    #[test]
    fn a_snapshot_scope_reads_ps_once_for_every_listing_inside_it() {
        let line = format!(
            "s<TMM_SEP>0<TMM_SEP>0<TMM_SEP>80<TMM_SEP>24<TMM_SEP>bash<TMM_SEP>w<TMM_SEP>t<TMM_SEP>/<TMM_SEP>1<TMM_SEP>{}",
            std::process::id()
        );
        let before = PS_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let _ = parse_pane_lines(&line);
        let _ = parse_pane_lines(&line);
        assert_eq!(PS_CALLS.load(std::sync::atomic::Ordering::SeqCst) - before, 2, "no scope: one ps per listing");

        let before = PS_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let (a, b) = with_process_snapshot(|| (parse_pane_lines(&line), parse_pane_lines(&line)));
        assert_eq!(PS_CALLS.load(std::sync::atomic::Ordering::SeqCst) - before, 1, "one scope: one ps");
        assert_eq!(a[0].child_cmd, b[0].child_cmd, "both listings saw the same snapshot");

        // The scope does not leak: the next listing reads afresh.
        let before = PS_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let _ = parse_pane_lines(&line);
        assert_eq!(PS_CALLS.load(std::sync::atomic::Ordering::SeqCst) - before, 1);
    }

    /// Board #260 on a real tmux: a pane's agent comes from its processes,
    /// never its title. A plain process wearing an agent's stale title (what
    /// an exited CLI leaves behind) lists as no agent; a process whose argv
    /// names an agent lists as that agent under an ordinary title, in the
    /// listing and in the one-pane `pane_agent` the terminal stream reads.
    #[test]
    fn a_real_pane_is_an_agent_by_its_processes_not_its_title() {
        let session = format!("tmm-detect-{}", std::process::id());
        let _ = kill_session(&session);
        if new_session(&session, None, Some("cat")).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        let _guard = KillOnDrop(session.clone());
        run_tmux(&["select-pane", "-t", &format!("={session}:"), "-T", "grok"]).expect("set title");
        // `exec -a` sets argv[0]: the process is `sleep`, its argv says kiro-cli.
        run_tmux(&["new-window", "-d", "-t", &format!("={session}:"), "bash -c 'exec -a kiro-cli sleep 300'"])
            .expect("agent-argv window");
        // …and an ordinary program with an agent's name in an ARGUMENT
        // (validator, #260: `rg grok` read as grok): a process whose argv is
        // `rg -c sleep 301; true grok` (bash renamed; `; true` keeps it alive
        // as the parent of `sleep`, so `grok` stays in a live argv).
        run_tmux(&["new-window", "-d", "-t", &format!("={session}:"), "bash -c 'exec -a rg bash -c \"sleep 301; true\" grok'"])
            .expect("argument window");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let panes = list_panes(&session).expect("list");
        assert_eq!(panes.len(), 3);
        let stale = panes.iter().find(|p| p.pane_title == "grok").expect("the stale-title pane");
        assert_eq!(stale.agent, None, "a title is not a process: {stale:?}");
        let arg = panes.iter().find(|p| p.window == panes.iter().map(|p| p.window).max().unwrap()).unwrap();
        assert_eq!(arg.agent, None, "an argument is not a program: {arg:?}");
        let agent = panes.iter().find(|p| p.pane_title != "grok" && p.window != arg.window).expect("the argv pane");
        assert_eq!(agent.agent, Some("kiro"), "{agent:?}");
        let target = |p: &TmuxPane| format!("{}:{}.{}", p.session, p.window, p.pane);
        assert_eq!(pane_agent(&target(stale)), None);
        assert_eq!(pane_agent(&target(agent)), Some("kiro"));
    }
}
