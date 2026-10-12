//! The per-user service that keeps the gateway running (board #323): a
//! launchd LaunchAgent on macOS, a systemd user unit on Linux.
//!
//! IDENTITY, not name: an installed file is ours only if it is EXACTLY the
//! shape we write — for this name, running THIS `tmm` (absolute path) as
//! `gateway start --service` with THIS config root (the `XDG_CONFIG_HOME`
//! base in the file's environment; never a token, never in argv). The plist
//! is read as a structure (XML or binary; Label == the file's name, the
//! whole ProgramArguments array, only the keys tmm writes); the unit by a
//! strict, section-aware grammar that refuses anything it does not
//! interpret (a key set twice, an escape the renderer never writes, …).
//! Only a file that does not exist is absent; any other read or parse
//! problem refuses. A file of our name that is not ours is refused with what
//! it names — never adopted, overwritten or removed; `--replace` backs it up
//! first, for a migration, and restores it step by step on failure.
//!
//! `--service` makes the started gateway read config.toml ALONE, so the
//! service and `status` always see the same thing whatever the user
//! manager's environment holds.
//!
//! Native operations go through `Sys` (tests inject a fake): an unload that
//! fails aborts unless the service is confirmed not loaded; install and
//! restart wait (bounded) until OUR instance runs and the probe says Ours,
//! and fail otherwise. Same bytes and running → nothing happens; only
//! `restart` forces one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::probe::Verdict;

/// launchd label (the one clawdbjs already runs, #313; deliberately not the
/// app bundle id `com.tmuxmobile.dev`).
pub const LABEL: &str = "cc.voka.tmux-mobile";
/// systemd user unit.
pub const UNIT: &str = "tmux-mobile-gateway.service";
/// The polling budget install/restart wait for our instance to answer: no
/// new poll starts past it, so the wait ends within READY plus one poll
/// (a probe is bounded at 1.5 s; the native queries have no timeout).
pub const READY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub exe: String,
    /// The XDG base directory (config_dir's parent), not the app dir.
    pub config_home: String,
}

#[derive(Debug, Clone)]
pub struct Spec {
    pub name: String,
    pub id: Identity,
    pub path_env: String,
    pub home: String,
    /// launchd only: where stdout/stderr go.
    pub log: String,
}

/// A service name is a bare file name: no separator, no `..`, no leading
/// `.`/`-`, a conservative character set, and `.service` on Linux.
pub fn valid_name(name: &str, mac: bool) -> Result<(), String> {
    let ok_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'));
    if name.is_empty() || !ok_chars || name.contains("..") || name.starts_with('.') || name.starts_with('-') {
        return Err(format!("{name:?} is not a valid service name"));
    }
    if !mac && !name.ends_with(".service") {
        return Err(format!("{name:?} must end in .service"));
    }
    Ok(())
}

fn no_newline(what: &str, v: &str) -> Result<(), String> {
    if v.contains('\n') || v.contains('\r') || v.contains('\0') {
        Err(format!("{what} contains a newline or NUL: {v:?}"))
    } else {
        Ok(())
    }
}

// ─── systemd ────────────────────────────────────────────────────────────────

/// One argument in an ExecStart= line: double-quoted, `\` and `"` escaped,
/// `%` doubled (specifiers), `$` doubled (variable expansion).
pub(crate) fn systemd_arg(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One `Environment=` assignment: quoted, `\` and `"` escaped, `%` doubled;
/// `$` is literal there (systemd does not expand it in Environment=).
pub(crate) fn systemd_env(key: &str, value: &str) -> String {
    let mut v = String::new();
    for c in value.chars() {
        match c {
            '\\' => v.push_str("\\\\"),
            '"' => v.push_str("\\\""),
            '%' => v.push_str("%%"),
            c => v.push(c),
        }
    }
    format!("Environment=\"{key}={v}\"")
}

/// The inverse of `systemd_arg` for one whole quoted token.
fn unquote_arg(s: &str) -> Option<String> {
    let inner = s.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::new();
    let mut it = inner.chars();
    while let Some(c) = it.next() {
        match c {
            // Only the escapes the renderer writes; systemd reads `\t`, `\n`,
            // `\x..` … as other bytes, so any other escape is not ours.
            '\\' => match it.next()? { c @ ('\\' | '"') => out.push(c), _ => return None },
            '%' => { if it.next()? != '%' { return None; } out.push('%'); }
            '$' => { if it.next()? != '$' { return None; } out.push('$'); }
            '"' => return None,
            c => out.push(c),
        }
    }
    Some(out)
}

/// The inverse of `systemd_env`: `"KEY=value"` → (key, value).
fn unquote_env(s: &str) -> Option<(String, String)> {
    let inner = s.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::new();
    let mut it = inner.chars();
    while let Some(c) = it.next() {
        match c {
            // Only the escapes the renderer writes; systemd reads `\t`, `\n`,
            // `\x..` … as other bytes, so any other escape is not ours.
            '\\' => match it.next()? { c @ ('\\' | '"') => out.push(c), _ => return None },
            '%' => { if it.next()? != '%' { return None; } out.push('%'); }
            '"' => return None,
            c => out.push(c),
        }
    }
    let (k, v) = out.split_once('=')?;
    Some((k.to_string(), v.to_string()))
}

/// `KillMode=process` (board #350): the gateway forks tmux servers (`tmm
/// project up`, the scratch session), and a child inherits its parent's
/// cgroup — so with systemd's default `control-group`, a `systemctl --user
/// restart` of this unit (every `npm run gateway:update`) would kill every
/// tmux server the gateway ever started and every agent pane in them.
/// `process` signals the main process only; children live on. Measured on
/// this host 2026-10-12 08:02: the owner's default tmux server sat inside
/// the DEV unit's cgroup for the same reason, and only a `KillMode=none`
/// drop-in had kept `stop` from taking it down. `none` is rejected here:
/// it kills nothing on stop, so a wedged gateway would never be ended.
/// `systemd-run --scope` for the fork was evaluated and rejected: it is a
/// second place that knows about systemd, it is Linux-only while the
/// forking code is shared with macOS, and it needs the bus from inside the
/// service — `KillMode=` is one line that says the same thing to systemd.
pub const KILL_MODE: &str = "process";

pub fn render_systemd(spec: &Spec) -> Result<String, String> {
    for (w, v) in [("executable", &spec.id.exe), ("config root", &spec.id.config_home), ("PATH", &spec.path_env), ("HOME", &spec.home)] {
        no_newline(w, v)?;
    }
    Ok(format!(
        "# Managed by `tmm gateway install` (board #323). Edit with tmm, not by hand.\n\
         [Unit]\n\
         Description=tmux-mobile gateway\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={} gateway start --service\n\
         {}\n\
         {}\n\
         {}\n\
         Restart=on-failure\n\
         RestartSec=3s\n\
         KillMode={}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        systemd_arg(&spec.id.exe),
        systemd_env("XDG_CONFIG_HOME", &spec.id.config_home),
        systemd_env("HOME", &spec.home),
        systemd_env("PATH", &spec.path_env),
        KILL_MODE,
    ))
}

/// The keys tmm writes, per section. Anything else — another key, a second
/// section of the same name, leading or trailing whitespace, a continuation
/// line, a duplicate key — is syntax we do not interpret, so the unit is
/// not ours (a stricter reader can only refuse more, never adopt more).
const UNIT_KEYS: &[(&str, &[&str])] = &[
    ("Unit", &["Description", "After"]),
    ("Service", &["Type", "ExecStart", "Environment", "Restart", "RestartSec", "KillMode"]),
    ("Install", &["WantedBy"]),
];
/// The environment tmm gives the service; any other variable (LD_PRELOAD,
/// …) could change what runs, so it is not ours.
const ENV_KEYS: &[&str] = &["XDG_CONFIG_HOME", "HOME", "PATH"];

/// The identity a unit names, by the strict grammar we write: only the
/// `[Service]` section's `ExecStart=` (exactly one, `"<exe>" gateway start
/// --service`) and `Environment=` (one per key, in our quoted form) are
/// identity; `[Install]`/`[Unit]` never are.
pub fn unit_identity(text: &str) -> Result<Identity, String> {
    let mut section: Option<&str> = None;
    let mut seen_sections: Vec<&str> = Vec::new();
    let mut seen_keys: Vec<(String, String)> = Vec::new();
    let mut exec: Option<String> = None;
    let mut env: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() || (line.starts_with('#') && !line.ends_with('\\')) {
            continue;
        }
        if line != line.trim() || line.ends_with('\\') || line.contains('\r') {
            return Err(format!("a line in a form tmm does not write: {line:?}"));
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let Some((known, _)) = UNIT_KEYS.iter().find(|(n, _)| *n == name) else { return Err(format!("a section tmm does not write: {line}")) };
            if seen_sections.contains(known) {
                return Err(format!("a second {line} section"));
            }
            seen_sections.push(known);
            section = Some(known);
            continue;
        }
        let sec = section.ok_or_else(|| format!("a line before any section: {line}"))?;
        let (key, value) = line.split_once('=').ok_or_else(|| format!("not a key=value line: {line}"))?;
        let allowed = UNIT_KEYS.iter().find(|(n, _)| *n == sec).map(|(_, k)| *k).unwrap_or(&[]);
        if !allowed.contains(&key) {
            return Err(format!("[{sec}] {key}= is not a key tmm writes"));
        }
        if sec == "Service" && key == "Environment" {
            let (k, v) = unquote_env(value).ok_or_else(|| format!("an Environment= line tmm did not write: {line}"))?;
            if !ENV_KEYS.contains(&k.as_str()) {
                return Err(format!("Environment {k} is not one tmm sets"));
            }
            if env.iter().any(|(e, _)| *e == k) {
                return Err(format!("Environment {k} is set twice"));
            }
            env.push((k, v));
            continue;
        }
        if seen_keys.iter().any(|(s, k)| s == sec && k == key) {
            return Err(format!("[{sec}] {key}= appears twice"));
        }
        seen_keys.push((sec.to_string(), key.to_string()));
        if sec == "Service" && key == "ExecStart" {
            exec = Some(value.to_string());
        }
    }
    let exec = exec.ok_or("no ExecStart= in [Service]")?;
    let quoted = exec.strip_suffix(" gateway start --service").ok_or("ExecStart is not `<tmm> gateway start --service`")?;
    let exe = unquote_arg(quoted).ok_or("ExecStart's executable is not in tmm's quoting")?;
    let config_home = env.into_iter().find(|(k, _)| k == "XDG_CONFIG_HOME").map(|(_, v)| v).ok_or("no XDG_CONFIG_HOME in [Service]")?;
    Ok(Identity { exe, config_home })
}

/// Does this unit text (already known to be ours) carry the one line that
/// keeps a restart from killing the tmux servers the gateway forked? `None`
/// when the key is absent (a unit from before #350), else its value — only
/// `KILL_MODE` protects; `none` would, but is not what we write.
pub fn unit_kill_mode(text: &str) -> Option<String> {
    let mut in_service = false;
    for line in text.split('\n') {
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_service = name == "Service";
            continue;
        }
        if in_service {
            if let Some(v) = line.strip_prefix("KillMode=") {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// The warning `status` prints, and the reason a stop is refused, for a unit
/// of ours whose EFFECTIVE `KillMode` (the manager's, drop-ins included) is
/// not `process`. Each mode gets its own truth: the default and
/// `control-group` (and `mixed`, whose SIGKILL still sweeps the cgroup) kill
/// the forked tmux servers; `none` spares them but can never end a wedged
/// gateway; an unknown value is treated as the dangerous one.
pub fn kill_mode_warning(name: &str, found: Option<&str>) -> String {
    let hazard = match found {
        None => "no KillMode= in effect (systemd's default, control-group): a restart of this service (every `npm run gateway:update`) would kill every tmux server the gateway started and every agent in them".to_string(),
        Some("control-group") | Some("mixed") => format!("KillMode={} in effect: a restart of this service (every `npm run gateway:update`) would kill every tmux server the gateway started and every agent in them", found.unwrap()),
        Some("none") => "KillMode=none in effect: a stop would spare the tmux servers but could never end a wedged gateway".to_string(),
        Some(other) => format!("KillMode={other} in effect, which tmm does not know; treated as unsafe"),
    };
    format!("{name} — {hazard}. Fix: `tmm gateway install` rewrites the unit with KillMode={KILL_MODE} and applies it in place (daemon-reload; no restart, nothing stopped). If a drop-in sets KillMode, remove it (`systemctl --user cat {name}` shows it) and run `systemctl --user daemon-reload`.")
}

// ─── launchd ────────────────────────────────────────────────────────────────

pub fn render_plist(spec: &Spec) -> Result<String, String> {
    use plist::{Dictionary, Value};
    for (w, v) in [("label", &spec.name), ("executable", &spec.id.exe), ("config root", &spec.id.config_home), ("PATH", &spec.path_env), ("HOME", &spec.home), ("log", &spec.log)] {
        no_newline(w, v)?;
    }
    let mut env = Dictionary::new();
    env.insert("XDG_CONFIG_HOME".into(), Value::String(spec.id.config_home.clone()));
    env.insert("HOME".into(), Value::String(spec.home.clone()));
    env.insert("PATH".into(), Value::String(spec.path_env.clone()));
    let mut d = Dictionary::new();
    d.insert("Label".into(), Value::String(spec.name.clone()));
    d.insert(
        "ProgramArguments".into(),
        Value::Array(["gateway", "start", "--service"].iter().fold(vec![Value::String(spec.id.exe.clone())], |mut a, s| {
            a.push(Value::String((*s).into()));
            a
        })),
    );
    d.insert("EnvironmentVariables".into(), Value::Dictionary(env));
    d.insert("RunAtLoad".into(), Value::Boolean(true));
    d.insert("KeepAlive".into(), Value::Boolean(true));
    d.insert("StandardOutPath".into(), Value::String(spec.log.clone()));
    d.insert("StandardErrorPath".into(), Value::String(spec.log.clone()));
    let mut out = Vec::new();
    Value::Dictionary(d).to_writer_xml(&mut out).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8(out).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
}

/// The identity a plist names, read as a structure: Label == `name`, and
/// ProgramArguments exactly `[<exe>, gateway, start, --service]`.
pub fn plist_identity(bytes: &[u8], name: &str) -> Result<Identity, String> {
    let v = plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| format!("not a readable plist: {e}"))?;
    let d = v.as_dictionary().ok_or("the plist is not a dictionary")?;
    // Only the keys tmm writes: `Program`, `WorkingDirectory`, `UserName`,
    // `inetdCompatibility`, … would change what runs or how.
    const KEYS: &[&str] = &["Label", "ProgramArguments", "EnvironmentVariables", "RunAtLoad", "KeepAlive", "StandardOutPath", "StandardErrorPath"];
    if let Some(k) = d.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(format!("{k} is not a key tmm writes"));
    }
    let label = d.get("Label").and_then(|l| l.as_string()).ok_or("no Label")?;
    if label != name {
        return Err(format!("its Label is {label:?}, not {name:?}"));
    }
    let args: Vec<&str> = d.get("ProgramArguments").and_then(|a| a.as_array()).ok_or("no ProgramArguments")?
        .iter().map(|a| a.as_string()).collect::<Option<_>>().ok_or("a ProgramArguments entry is not a string")?;
    let [exe, "gateway", "start", "--service"] = args.as_slice() else {
        return Err(format!("it runs {args:?}, not `<tmm> gateway start --service`"));
    };
    let env = d.get("EnvironmentVariables").and_then(|e| e.as_dictionary()).ok_or("no EnvironmentVariables")?;
    if let Some(k) = env.keys().find(|k| !ENV_KEYS.contains(&k.as_str())) {
        return Err(format!("EnvironmentVariables {k} is not one tmm sets"));
    }
    let root = env.get("XDG_CONFIG_HOME").and_then(|r| r.as_string()).ok_or("no XDG_CONFIG_HOME")?;
    Ok(Identity { exe: (*exe).to_string(), config_home: root.to_string() })
}

/// Where the file for `name` lives.
pub fn file_for(name: &str, mac: bool, home: &Path) -> PathBuf {
    if mac {
        home.join("Library/LaunchAgents").join(format!("{name}.plist"))
    } else {
        home.join(".config/systemd/user").join(name)
    }
}

// ─── The decision ───────────────────────────────────────────────────────────

/// What is on disk for a name.
#[derive(Debug, PartialEq, Eq)]
pub enum OnDisk {
    Absent,
    Ours { bytes: Vec<u8> },
    NotOurs(String),
}

pub fn read_on_disk(file: &Path, name: &str, me: &Identity, mac: bool) -> OnDisk {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return OnDisk::Absent,
        Err(e) => return OnDisk::NotOurs(format!("{} cannot be read ({e})", file.display())),
    };
    let id = if mac {
        plist_identity(&bytes, name)
    } else {
        std::str::from_utf8(&bytes).map_err(|_| "not UTF-8".to_string()).and_then(unit_identity)
    };
    match id {
        Ok(id) if id == *me => OnDisk::Ours { bytes },
        Ok(id) => OnDisk::NotOurs(format!("{} runs {} with config root {} — not this tmm ({}, {})", file.display(), id.exe, id.config_home, me.exe, me.config_home)),
        Err(why) => OnDisk::NotOurs(format!("{} was not written by tmm gateway for this name ({why})", file.display())),
    }
}

/// What `install` will do (pure).
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Create,
    Keep,
    Update,
    /// Ours, and the ONLY difference from what we would write now is the
    /// missing `KillMode=` (board #350) — a unit from before the fix. The
    /// protection is applied in place (write + daemon-reload); no restart.
    Protect,
    Refuse(String),
}

pub fn plan(on_disk: &OnDisk, rendered: &str) -> Plan {
    match on_disk {
        OnDisk::Absent => Plan::Create,
        OnDisk::Ours { bytes } if bytes.as_slice() == rendered.as_bytes() => Plan::Keep,
        OnDisk::Ours { bytes } if only_kill_mode_differs(bytes, rendered) => Plan::Protect,
        OnDisk::Ours { .. } => Plan::Update,
        OnDisk::NotOurs(why) => Plan::Refuse(format!("{why}; use --replace to back it up and take over")),
    }
}

/// Is `rendered` exactly `on_disk` plus our `KillMode=` line? (Only a
/// systemd unit can differ this way; a plist is never `Protect`.)
fn only_kill_mode_differs(on_disk: &[u8], rendered: &str) -> bool {
    let Ok(text) = std::str::from_utf8(on_disk) else { return false };
    let line = format!("KillMode={KILL_MODE}\n");
    rendered.contains(&line) && rendered.replacen(&line, "", 1) == text
}

// ─── Effects, through an injectable system ──────────────────────────────────

pub struct Sys {
    pub mac: bool,
    pub home: PathBuf,
    pub uid: String,
    pub me: Identity,
    pub path_env: String,
    /// Run a native command: Ok(stdout) or Err(stderr).
    pub run: Box<dyn Fn(&str, &[&str]) -> Result<String, String>>,
    /// The local probe of the config the service reads.
    pub probe: Box<dyn Fn() -> Verdict>,
    pub sleep: Box<dyn Fn(Duration)>,
}

impl Sys {
    /// The real system for this process.
    pub fn real() -> Result<Sys, String> {
        let me = current_identity()?;
        Ok(Sys {
            mac: cfg!(target_os = "macos"),
            home: std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?,
            // SAFETY: getuid has no preconditions.
            uid: unsafe { libc::getuid() }.to_string(),
            me,
            path_env: std::env::var("PATH").unwrap_or_default(),
            run: Box::new(|cmd, args| {
                let out = std::process::Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
                if out.status.success() {
                    Ok(String::from_utf8_lossy(&out.stdout).into())
                } else {
                    Err(format!("{cmd} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
                }
            }),
            probe: Box::new(|| {
                let cfg = crate::config::Config::peek_service();
                tokio::runtime::Builder::new_current_thread().enable_all().build()
                    .map(|rt| rt.block_on(super::probe::probe(&cfg)))
                    .unwrap_or_else(|e| Verdict::Occupied(e.to_string()))
            }),
            sleep: Box::new(std::thread::sleep),
        })
    }

    pub fn file(&self, name: &str) -> PathBuf {
        file_for(name, self.mac, &self.home)
    }

    pub fn spec(&self, name: &str) -> Spec {
        let log = Path::new(&self.me.config_home).join("tmux-mobile").join("gateway.log");
        Spec { name: name.into(), id: self.me.clone(), path_env: self.path_env.clone(), home: self.home.to_string_lossy().into(), log: log.to_string_lossy().into() }
    }

    fn target(&self, name: &str) -> String {
        format!("gui/{}/{name}", self.uid)
    }

    /// The running pid of the service, if it runs.
    pub fn running(&self, name: &str) -> Option<u32> {
        if self.mac {
            let out = (self.run)("launchctl", &["print", &self.target(name)]).ok()?;
            out.lines().find_map(|l| l.trim().strip_prefix("pid = ")).and_then(|p| p.trim().parse().ok())
        } else {
            let out = (self.run)("systemctl", &["--user", "show", name, "--property=ActiveState,MainPID"]).ok()?;
            let active = out.lines().any(|l| l.trim() == "ActiveState=active");
            let pid = out.lines().find_map(|l| l.trim().strip_prefix("MainPID=")).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
            (active && pid > 0).then_some(pid)
        }
    }

    /// The `KillMode` the MANAGER will use when it stops `name` now — not
    /// what any file says. `systemctl show -p KillMode` answers from the
    /// loaded unit, drop-ins included; measured 2026-10-12 on this host:
    /// after a `daemon-reload` the value follows the file for an
    /// already-running unit (same MainPID), so protection can be applied
    /// without a restart, and read back before anything is stopped. Linux
    /// only; `None` when the manager will not say.
    pub fn effective_kill_mode(&self, name: &str) -> Option<String> {
        if self.mac {
            return None;
        }
        let out = (self.run)("systemctl", &["--user", "show", name, "--property=KillMode"]).ok()?;
        out.lines().find_map(|l| l.trim().strip_prefix("KillMode=")).map(str::to_string).filter(|v| !v.is_empty())
    }

    /// The ONE question every path that would stop a RUNNING systemd unit of
    /// ours asks first (board #350): will the manager signal only our
    /// process, or the whole cgroup — which holds every tmux server the
    /// gateway forked and every agent pane in them? Only an effective
    /// `KillMode=process` passes. `none` would spare the children but can
    /// never end a wedged gateway, so it is refused too; anything else, or no
    /// answer, is refused: an unknown stop policy is treated as the dangerous
    /// one. launchd has no cgroup kill: always allowed.
    pub fn stop_allowed(&self, name: &str) -> Result<(), String> {
        if self.mac || self.running(name).is_none() {
            return Ok(());
        }
        match self.effective_kill_mode(name) {
            Some(v) if v == KILL_MODE => Ok(()),
            found => Err(format!("refusing to stop or restart {name}: {}", kill_mode_warning(name, found.as_deref()))),
        }
    }

    /// Is the service loaded at all (so an unload is needed)? Only an
    /// explicit "not loaded" answer is false; a query that fails for any
    /// other reason is an error, never "stopped".
    fn loaded(&self, name: &str) -> Result<bool, String> {
        if self.mac {
            match (self.run)("launchctl", &["print", &self.target(name)]) {
                Ok(_) => Ok(true),
                // launchctl's own answer for a label that is not loaded.
                Err(e) if e.contains("Could not find service") => Ok(false),
                Err(e) => Err(format!("cannot tell whether {name} is loaded: {e}")),
            }
        } else {
            let out = (self.run)("systemctl", &["--user", "show", name, "--property=LoadState,ActiveState,UnitFileState"])
                .map_err(|e| format!("cannot tell whether {name} is loaded: {e}"))?;
            let not_found = out.lines().any(|l| l.trim() == "LoadState=not-found");
            let inactive = out.lines().any(|l| l.trim() == "ActiveState=inactive");
            let disabled = out.lines().any(|l| matches!(l.trim(), "UnitFileState=disabled" | "UnitFileState="));
            Ok(!(not_found || (inactive && disabled)))
        }
    }

    fn load(&self, name: &str, file: &Path) -> Result<(), String> {
        if self.mac {
            (self.run)("launchctl", &["bootstrap", &format!("gui/{}", self.uid), &file.to_string_lossy()]).map(|_| ())
        } else {
            (self.run)("systemctl", &["--user", "daemon-reload"])?;
            (self.run)("systemctl", &["--user", "enable", "--now", name]).map(|_| ())
        }
    }

    /// Write the unit and make the manager load it, WITHOUT stopping
    /// anything: `daemon-reload` applies `KillMode=` to a running unit.
    fn reload_file(&self, file: &Path, text: &str) -> Result<(), String> {
        self.write(file, text)?;
        if !self.mac {
            (self.run)("systemctl", &["--user", "daemon-reload"])?;
        }
        Ok(())
    }

    /// Stop and unload; a failure is fine only when it is confirmed not loaded.
    /// Goes through `stop_allowed` first: this is the boundary at which a
    /// control-group kill would take the forked tmux servers down.
    fn unload(&self, name: &str) -> Result<(), String> {
        self.stop_allowed(name)?;
        let r = if self.mac {
            (self.run)("launchctl", &["bootout", &self.target(name)]).map(|_| ())
        } else {
            (self.run)("systemctl", &["--user", "disable", "--now", name]).map(|_| ())
        };
        match r {
            Ok(()) => Ok(()),
            Err(e) => match self.loaded(name) {
                Ok(false) => Ok(()),
                Ok(true) => Err(format!("could not stop {name}: {e}")),
                Err(q) => Err(format!("could not stop {name}: {e}; {q}")),
            },
        }
    }

    /// Wait (bounded) until OUR instance runs (a stable pid) and the probe
    /// says Ours.
    fn ready(&self, name: &str) -> Result<u32, String> {
        let step = Duration::from_millis(250);
        // The deadline counts the sleeps AND the time spent probing and
        // querying, so the wait is READY in total, not READY of sleeping.
        let start = std::time::Instant::now();
        let mut slept = Duration::ZERO;
        let mut last = String::from("it did not start");
        loop {
            let busy = start.elapsed().saturating_sub(slept.min(start.elapsed()));
            if slept + busy > READY {
                break;
            }
            if let Some(pid) = self.running(name) {
                match (self.probe)() {
                    Verdict::Ours { .. } if self.running(name) == Some(pid) => return Ok(pid),
                    Verdict::Ours { .. } => last = "it restarted while being checked".into(),
                    Verdict::Occupied(w) => last = w,
                    Verdict::None => last = "it runs but does not listen yet".into(),
                }
            } else {
                last = format!("{name} is not running");
            }
            (self.sleep)(step);
            slept += step;
        }
        Err(format!("{name} is not answering after {} s: {last}", READY.as_secs()))
    }

    fn write(&self, file: &Path, text: &str) -> Result<(), String> {
        let dir = file.parent().ok_or("service file has no directory")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{}.tmm-new", file.file_name().unwrap_or_default().to_string_lossy()));
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, file).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
    }
}

/// This tmm and this config root.
pub fn current_identity() -> Result<Identity, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let dir = crate::config::config_dir();
    let dir = if dir.is_absolute() { dir } else { std::env::current_dir().map_err(|e| e.to_string())?.join(dir) };
    let base = dir.parent().ok_or("config dir has no parent")?.to_path_buf();
    Ok(Identity { exe: exe.to_string_lossy().into(), config_home: base.to_string_lossy().into() })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Done {
    Installed(u32),
    AlreadyRunning(u32),
    Started(u32),
    Updated(u32),
    /// The unit gained `KillMode=` and the manager applied it to the
    /// running instance (daemon-reload); nothing was restarted.
    Protected(u32),
    Replaced { pid: u32, backup: PathBuf },
}

/// A backup name no earlier backup has.
fn backup_for(file: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let base = file.file_name().unwrap_or_default().to_string_lossy().to_string();
    for n in 0..1000 {
        let p = file.with_file_name(format!("{base}.bak-{stamp}-{n}"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("no free backup name".into())
}

/// Install (or keep) the service `name` for this tmm and config root.
pub fn install(sys: &Sys, name: &str, replace: bool) -> Result<Done, String> {
    valid_name(name, sys.mac)?;
    let spec = sys.spec(name);
    let rendered = if sys.mac { render_plist(&spec)? } else { render_systemd(&spec)? };
    let file = sys.file(name);
    let on_disk = read_on_disk(&file, name, &sys.me, sys.mac);
    let ours_running = matches!(on_disk, OnDisk::Ours { .. }) && sys.running(name).is_some();
    if sys.mac {
        std::fs::create_dir_all(Path::new(&spec.log).parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    }
    match plan(&on_disk, &rendered) {
        Plan::Keep if ours_running => {
            let pid = sys.ready(name)?;
            Ok(Done::AlreadyRunning(pid))
        }
        Plan::Keep => {
            port_free(sys)?;
            sys.unload(name)?;
            sys.load(name, &file)?;
            Ok(Done::Started(sys.ready(name)?))
        }
        Plan::Create => {
            port_free(sys)?;
            sys.write(&file, &rendered)?;
            sys.load(name, &file)?;
            Ok(Done::Installed(sys.ready(name)?))
        }
        // An Update stops the running instance to start the new text, and
        // Protect exists because that stop may be the dangerous one. So on a
        // running unit BOTH first establish the protection without stopping
        // anything — write the new text, `daemon-reload`, read the manager's
        // effective KillMode back — and only an effective `process` lets the
        // stop proceed. If the manager does not confirm it (a reload error, a
        // drop-in forcing another mode, an older systemd), nothing is stopped:
        // the old instance keeps running and the error says what to look at.
        Plan::Update | Plan::Protect if ours_running => {
            let protecting = matches!(plan(&on_disk, &rendered), Plan::Protect);
            let previous = match &on_disk { OnDisk::Ours { bytes } => bytes.clone(), _ => Vec::new() };
            sys.reload_file(&file, &rendered)?;
            if let Err(e) = sys.stop_allowed(name) {
                // The manager did not take the protection: put the old text
                // back so the file does not claim what is not in effect.
                let _ = sys.write(&file, &String::from_utf8_lossy(&previous));
                return Err(format!("{e}; the unit file was rewritten with KillMode={KILL_MODE} but the manager does not report it in effect, so it was restored — nothing was stopped"));
            }
            if protecting {
                // Protection applied in place; the running instance is the
                // right binary already. No restart.
                return Ok(Done::Protected(sys.running(name).unwrap_or(0)));
            }
            // The new text is loaded, protection in effect: now the stop is
            // safe. If it still fails, the file goes back to what runs.
            if let Err(e) = sys.unload(name) {
                let _ = sys.reload_file(&file, &String::from_utf8_lossy(&previous));
                return Err(e);
            }
            sys.load(name, &file)?;
            Ok(Done::Updated(sys.ready(name)?))
        }
        Plan::Update | Plan::Protect => {
            port_free(sys)?;
            sys.unload(name)?;
            sys.write(&file, &rendered)?;
            sys.load(name, &file)?;
            Ok(Done::Updated(sys.ready(name)?))
        }
        Plan::Refuse(why) if !replace => Err(why),
        // The migration: the old service of THIS name may be the one
        // answering on the port (the #313 hand plist). It is backed up and
        // stopped FIRST; only then must the port be free — so an unrelated
        // occupant still refuses, and the old service is put back.
        Plan::Refuse(_) => {
            let backup = backup_for(&file)?;
            std::fs::copy(&file, &backup).map_err(|e| format!("back up {}: {e}", file.display()))?;
            let was_running = sys.running(name);
            sys.unload(name).map_err(|e| format!("{e}; nothing changed, the old file is still in place (copy at {})", backup.display()))?;
            let up = port_free(sys)
                .map_err(|e| format!("{e} (after stopping the old {name})"))
                .and_then(|_| sys.write(&file, &rendered))
                .and_then(|_| sys.load(name, &file))
                .and_then(|_| sys.ready(name));
            match up {
                Ok(pid) => Ok(Done::Replaced { pid, backup }),
                Err(e) => {
                    let restored = sys.unload(name)
                        .and_then(|_| std::fs::copy(&backup, &file).map(|_| ()).map_err(|e| format!("copy back: {e}")))
                        .and_then(|_| sys.load(name, &file))
                        .and_then(|_| if was_running.is_none() || sys.running(name).is_some() { Ok(()) } else { Err("the restored service did not start".into()) });
                    match restored {
                        Ok(()) if was_running.is_some() => Err(format!("{e}; the previous service was restored from {} and runs again", backup.display())),
                        Ok(()) => Err(format!("{e}; the previous file was restored from {}", backup.display())),
                        Err(r) => Err(format!("{e}; restoring the previous service ALSO failed ({r}) — the old file is kept at {}", backup.display())),
                    }
                }
            }
        }
    }
}

/// Nothing of ours runs: the port must be free, or a new instance could
/// only fail — and another gateway answering would mask that.
fn port_free(sys: &Sys) -> Result<(), String> {
    match (sys.probe)() {
        Verdict::None => Ok(()),
        Verdict::Ours { url, .. } => Err(format!("this machine's gateway already answers at {url}, outside this service (a foreground `tmm gateway start`, or another service); stop it first")),
        Verdict::Occupied(who) => Err(format!("the port is held: {who}")),
    }
}

fn ours_installed(sys: &Sys, name: &str) -> Result<Option<PathBuf>, String> {
    valid_name(name, sys.mac)?;
    let file = sys.file(name);
    match read_on_disk(&file, name, &sys.me, sys.mac) {
        OnDisk::Absent => Ok(None),
        OnDisk::Ours { .. } => Ok(Some(file)),
        OnDisk::NotOurs(why) => Err(format!("{why}; refusing")),
    }
}

pub fn uninstall(sys: &Sys, name: &str) -> Result<bool, String> {
    let Some(file) = ours_installed(sys, name)? else { return Ok(false) };
    sys.unload(name)?;
    std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    if !sys.mac {
        (sys.run)("systemctl", &["--user", "daemon-reload"])?;
    }
    Ok(true)
}

pub fn restart(sys: &Sys, name: &str) -> Result<u32, String> {
    let file = ours_installed(sys, name)?.ok_or_else(|| format!("{name} is not installed: run tmm gateway install"))?;
    // `npm run gateway:update` comes through here after every merge: the
    // manager's effective KillMode decides whether this restart is safe.
    sys.stop_allowed(name)?;
    if sys.mac {
        if (sys.run)("launchctl", &["kickstart", "-k", &sys.target(name)]).is_err() {
            sys.load(name, &file)?;
        }
    } else {
        (sys.run)("systemctl", &["--user", "restart", name])?;
    }
    sys.ready(name)
}

/// Installed (ours?) and the running pid — read-only.
pub fn state(sys: &Sys, name: &str) -> (Result<bool, String>, Option<u32>) {
    (ours_installed(sys, name).map(|f| f.is_some()), sys.running(name))
}

/// For an installed unit of ours on systemd: the warning to print when the
/// protection is not in effect (board #350), else `None`. Read-only. The
/// EFFECTIVE value — the manager's — is what matters while the unit runs;
/// when it does not run, the file is the only thing that will be loaded, so
/// the file is read. `None` for launchd, an absent unit, or one not ours.
pub fn protection_warning(sys: &Sys, name: &str) -> Option<String> {
    if sys.mac {
        return None;
    }
    let file = ours_installed(sys, name).ok()??;
    let found = if sys.running(name).is_some() {
        sys.effective_kill_mode(name)
    } else {
        std::fs::read_to_string(file).ok().and_then(|t| unit_kill_mode(&t))
    };
    match found {
        Some(v) if v == KILL_MODE => None,
        found => Some(kill_mode_warning(name, found.as_deref())),
    }
}

/// The command that shows the service's log — for OUR service only.
pub fn logs_command(sys: &Sys, name: &str, follow: bool) -> Result<(String, Vec<String>), String> {
    ours_installed(sys, name)?.ok_or_else(|| format!("{name} is not installed"))?;
    Ok(if sys.mac {
        let mut a = vec!["-n".to_string(), "100".into()];
        if follow { a.push("-f".into()); }
        a.push(sys.spec(name).log);
        ("tail".into(), a)
    } else {
        let mut a = vec!["--user".to_string(), "-u".into(), name.into(), "-n".into(), "100".into(), "--no-pager".into()];
        if follow { a.push("-f".into()); }
        ("journalctl".into(), a)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn spec_with(exe: &str, root: &str) -> Spec {
        Spec {
            name: "tmux-mobile-gateway-test.service".into(),
            id: Identity { exe: exe.into(), config_home: root.into() },
            path_env: "/usr/bin:/bin".into(),
            home: "/home/u".into(),
            log: "/home/u/.config/tmux-mobile/gateway.log".into(),
        }
    }

    #[test]
    fn systemd_quoting_escapes_specifiers_expansion_quotes_and_backslashes() {
        assert_eq!(systemd_arg("/opt/tmm"), "\"/opt/tmm\"");
        assert_eq!(systemd_arg("/a b/%h/$X/\"q\"\\z"), "\"/a b/%%h/$$X/\\\"q\\\"\\\\z\"");
        assert_eq!(systemd_env("PATH", "/a b:%p:$HOME"), "Environment=\"PATH=/a b:%%p:$HOME\"");
        assert!(render_systemd(&spec_with("/bin/tmm\nExecStartPre=/bin/rm", "/r")).is_err(), "a newline cannot smuggle a directive");
    }

    #[test]
    fn a_rendered_unit_and_plist_read_back_as_the_same_identity() {
        // `$$` in a root must stay `$$` (Environment= does not fold it), `%` doubles.
        let s = spec_with("/home/u/My Tools/$tmm", "/home/u/.config $$x/%y");
        let unit = render_systemd(&s).unwrap();
        assert!(unit.contains("ExecStart=\"/home/u/My Tools/$$tmm\" gateway start --service\n"));
        assert!(unit.contains("Environment=\"XDG_CONFIG_HOME=/home/u/.config $$x/%%y\"\n"));
        assert!(!unit.contains("sh -c") && !unit.to_lowercase().contains("token"), "no shell, no secret");
        assert_eq!(unit_identity(&unit), Ok(s.id.clone()));
        let plist = render_plist(&s).unwrap();
        assert_eq!(plist_identity(plist.as_bytes(), &s.name), Ok(s.id.clone()));
        let odd = spec_with("/a&b/<tmm>", "/r'\"");
        assert_eq!(plist_identity(render_plist(&odd).unwrap().as_bytes(), &odd.name), Ok(odd.id), "XML round-trips");
    }

    #[test]
    fn identity_is_structural_and_strict() {
        let s = spec_with("/opt/tmm", "/home/u/.config");
        let unit = render_systemd(&s).unwrap();
        // Only [Service] is identity: our root in [Install] cannot make a
        // unit whose real [Service] root is elsewhere look like ours.
        let elsewhere = unit.replace("XDG_CONFIG_HOME=/home/u/.config", "XDG_CONFIG_HOME=/elsewhere");
        let in_install = format!("{elsewhere}Environment=\"XDG_CONFIG_HOME=/home/u/.config\"\n");
        assert!(unit_identity(&in_install).is_err(), "[Install] Environment= is not identity");
        assert_eq!(unit_identity(&elsewhere).unwrap().config_home, "/elsewhere", "the [Service] value is the one read");
        // Syntax we do not interpret is never ours.
        let svc = "[Service]\n";
        for (what, bad) in [
            ("a duplicate key", unit.replace(svc, &format!("{svc}Environment=\"XDG_CONFIG_HOME=/elsewhere\"\n"))),
            ("leading whitespace", unit.replace(svc, &format!("{svc}  Environment=\"XDG_CONFIG_HOME=/elsewhere\"\n"))),
            ("a continuation", unit.replace(" gateway start --service", " gateway start --service \\\n  --evil")),
            ("a second [Service]", format!("{unit}[Service]\nExecStartPre=/bin/true\n")),
            ("an unknown key", unit.replace(svc, &format!("{svc}User=root\n"))),
            ("an injected variable", unit.replace(svc, &format!("{svc}Environment=\"LD_PRELOAD=/x.so\"\n"))),
            ("an ExecStart prefix", unit.replace("ExecStart=\"", "ExecStart=-\"")),
            ("a CR", unit.replace("[Service]\n", "[Service]\r\n")),
        ] {
            assert!(unit_identity(&bad).is_err(), "{what}: {bad}");
        }
        assert!(unit_identity(&format!("{unit}ExecStartPre=/bin/true\n")).is_err(), "an extra pre-step is not ours");
        assert!(unit_identity(&format!("{unit}EnvironmentFile=/x\n")).is_err());
        assert!(unit_identity(&unit.replace("ExecStart=", "ExecStart=\"/x\" gateway start --service\nExecStart=")).is_err(), "two ExecStart");
        // systemd decodes `\t`, `\n`, … to other bytes: only our own escapes
        // (`\\`, `\"`) read back, so these name another exe / another root.
        assert!(unit_identity(&unit.replace("\"/opt/tmm\"", "\"/opt/\\tmm\"")).is_err(), "\\t is a TAB to systemd");
        assert!(unit_identity(&unit.replace("XDG_CONFIG_HOME=/home/u/.config", "XDG_CONFIG_HOME=/home/u/.co\\nfig")).is_err(), "\\n is a newline to systemd");
        // systemd decodes `\t`, `\n`, … to other bytes: only our own escapes read back.
        assert!(unit_identity(&unit.replace("\"/opt/tmm\"", "\"/opt/\\tmm\"")).is_err(), "\\t is a TAB to systemd, not /opt/tmm");
        assert!(unit_identity(&unit.replace("XDG_CONFIG_HOME=/home/u/.config", "XDG_CONFIG_HOME=/home/u/.co\\nfig")).is_err(), "\\n is a newline to systemd");
        assert!(unit_identity(&unit.replace(" --service", "")).is_err(), "not the managed start");
        // plist: Label must be this name; the whole argv must be ours.
        let plist = render_plist(&s).unwrap();
        assert!(plist_identity(plist.as_bytes(), "other.label").is_err(), "Label mismatch");
        let wrong_argv = plist.replace("<string>--service</string>", "<string>--evil</string>");
        assert!(plist_identity(wrong_argv.as_bytes(), &s.name).is_err());
        let extra_argv = plist.replace("<string>--service</string>", "<string>--service</string>\n\t\t<string>x</string>");
        assert!(plist_identity(extra_argv.as_bytes(), &s.name).is_err());
        // Program decides what launchd runs; any key tmm does not write is not ours.
        let program = plist.replace("<key>ProgramArguments</key>", "<key>Program</key>\n\t<string>/other/exe</string>\n\t<key>ProgramArguments</key>");
        assert!(plist_identity(program.as_bytes(), &s.name).unwrap_err().contains("Program"), "Program=/other");
        let workdir = plist.replace("<key>RunAtLoad</key>", "<key>WorkingDirectory</key>\n\t<string>/x</string>\n\t<key>RunAtLoad</key>");
        assert!(plist_identity(workdir.as_bytes(), &s.name).is_err());
        let preload = plist.replace("<key>HOME</key>", "<key>DYLD_INSERT_LIBRARIES</key>\n\t\t<string>/x.dylib</string>\n\t\t<key>HOME</key>");
        assert!(plist_identity(preload.as_bytes(), &s.name).is_err(), "an injected variable");
        // A binary plist is parsed, not mistaken for absent.
        let mut bin = Vec::new();
        plist::Value::from_reader(std::io::Cursor::new(plist.as_bytes())).unwrap().to_writer_binary(&mut bin).unwrap();
        assert_eq!(plist_identity(&bin, &s.name), Ok(s.id.clone()));
        // The #313 hand-written plist.
        let old = "<plist><dict><key>Label</key><string>cc.voka.tmux-mobile</string><key>ProgramArguments</key><array><string>/Users/clawd/workplace/tmux-mobile/src-tauri/target/release/server</string></array></dict></plist>";
        assert!(plist_identity(old.as_bytes(), LABEL).is_err());
    }

    #[test]
    fn names_are_bare_and_the_test_name_never_addresses_the_real_one() {
        for bad in ["", "../x.service", "a/b.service", ".hidden.service", "-x.service", "a..b.service", "x.service\n", "x y.service"] {
            assert!(valid_name(bad, false).is_err(), "{bad:?}");
        }
        assert!(valid_name("tmux-mobile-gateway", false).is_err(), "Linux needs .service");
        assert!(valid_name(UNIT, false).is_ok() && valid_name(LABEL, true).is_ok() && valid_name("cc.voka.tmux-mobile.test", true).is_ok());
        let home = Path::new("/home/u");
        for mac in [false, true] {
            let real = file_for(if mac { LABEL } else { UNIT }, mac, home);
            let test = file_for(if mac { "cc.voka.tmux-mobile.test" } else { "tmux-mobile-gateway-test.service" }, mac, home);
            assert_ne!(real.file_name(), test.file_name(), "exact names, no prefix match");
        }
    }

    // ─── Native operations against a fake system ────────────────────────────

    /// A fake init system: records calls; `fail` makes a command fail;
    /// `pid` is what `show`/`print` reports; the probe answers `verdict`.
    struct Fake {
        calls: Rc<RefCell<Vec<String>>>,
        fail: Rc<RefCell<Vec<&'static str>>>,
        pid: Rc<RefCell<Option<u32>>>,
        verdict: Rc<RefCell<Verdict>>,
        loaded: Rc<RefCell<bool>>,
        /// Something unrelated on the port: the probe answers this no matter what runs.
        occupant: Rc<RefCell<Option<Verdict>>>,
        /// What the manager has LOADED for KillMode (follows the file only on daemon-reload).
        kill_mode: Rc<RefCell<Option<String>>>,
    }

    fn fake(home: &Path, mac: bool) -> (Sys, Fake) {
        let f = Fake {
            calls: Rc::default(), fail: Rc::default(), pid: Rc::new(RefCell::new(None)),
            verdict: Rc::new(RefCell::new(Verdict::None)), loaded: Rc::new(RefCell::new(false)), occupant: Rc::default(),
            kill_mode: Rc::new(RefCell::new(None)),
        };
        let occupant = f.occupant.clone();
        let (calls, fail, pid, verdict, loaded) = (f.calls.clone(), f.fail.clone(), f.pid.clone(), f.verdict.clone(), f.loaded.clone());
        let kill_mode = f.kill_mode.clone();
        let unit_file = file_for(if mac { LABEL } else { N }, mac, home);
        let (pid2, verdict2) = (f.pid.clone(), f.verdict.clone());
        let sys = Sys {
            mac,
            home: home.to_path_buf(),
            uid: "501".into(),
            me: Identity { exe: "/opt/tmm".into(), config_home: home.join(".config").to_string_lossy().into() },
            path_env: "/usr/bin".into(),
            run: Box::new(move |cmd, args| {
                let line = format!("{cmd} {}", args.join(" "));
                calls.borrow_mut().push(line.clone());
                if let Some(f) = fail.borrow().iter().find(|f| line.contains(**f)) {
                    return Err(format!("{f} failed"));
                }
                let verb = args.iter().find(|a| ["enable", "disable", "restart", "bootstrap", "bootout", "kickstart", "show", "print", "daemon-reload"].contains(a)).copied().unwrap_or("");
                match verb {
                    // The manager re-reads the unit FILE here, and only here —
                    // the measured behaviour on this host (2026-10-12): a
                    // running unit's KillMode follows the file after a reload.
                    "daemon-reload" => {
                        *kill_mode.borrow_mut() = std::fs::read_to_string(&unit_file).ok().and_then(|t| unit_kill_mode(&t));
                        Ok(String::new())
                    }
                    "enable" | "bootstrap" | "restart" | "kickstart" => {
                        *loaded.borrow_mut() = true;
                        let next = pid.borrow().map(|p| p + 1).unwrap_or(100);
                        *pid.borrow_mut() = Some(next);
                        *verdict.borrow_mut() = Verdict::Ours { machine_id: "m".into(), url: "ws://x".into() };
                        Ok(String::new())
                    }
                    "disable" | "bootout" => {
                        *loaded.borrow_mut() = false;
                        *pid.borrow_mut() = None;
                        *verdict.borrow_mut() = Verdict::None;
                        Ok(String::new())
                    }
                    "show" => {
                        let p = *pid.borrow();
                        let l = *loaded.borrow();
                        // The manager's KillMode: what it loaded, else systemd's default.
                        let km = kill_mode.borrow().clone().unwrap_or_else(|| "control-group".to_string());
                        Ok(format!("ActiveState={}\nMainPID={}\nLoadState={}\nUnitFileState={}\nKillMode={km}\n",
                            if p.is_some() { "active" } else { "inactive" }, p.unwrap_or(0),
                            if l { "loaded" } else { "not-found" }, if l { "enabled" } else { "" }))
                    }
                    "print" => match (*loaded.borrow(), *pid.borrow()) {
                        (false, _) => Err("Could not find service \"x\" in domain for port".into()),
                        (true, Some(p)) => Ok(format!("state = running\npid = {p}\n")),
                        (true, None) => Ok("state = waiting\n".into()),
                    },
                    _ => Ok(String::new()),
                }
            }),
            probe: Box::new(move || occupant.borrow().clone().unwrap_or_else(|| verdict2.borrow().clone())),
            sleep: Box::new(move |_| { let _ = &pid2; }),
        };
        (sys, f)
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("svc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    const N: &str = "tmux-mobile-gateway-test.service";

    #[test]
    fn install_creates_waits_for_our_instance_and_is_a_no_op_the_second_time() {
        let home = scratch("create");
        let (sys, f) = fake(&home, false);
        assert_eq!(install(&sys, N, false), Ok(Done::Installed(100)));
        assert!(sys.file(N).exists());
        f.calls.borrow_mut().clear();
        assert_eq!(install(&sys, N, false), Ok(Done::AlreadyRunning(100)), "same bytes and running");
        assert!(!f.calls.borrow().iter().any(|c| c.contains("enable") || c.contains("disable") || c.contains("restart")), "{:?}", f.calls.borrow());
        assert_eq!(restart(&sys, N), Ok(101), "restart is the forced one");
        assert_eq!(uninstall(&sys, N), Ok(true));
        assert!(!sys.file(N).exists());
        std::fs::remove_dir_all(&home).ok();
    }

    /// Board #350: the unit we write must not take down the tmux servers
    /// the gateway forked when it is restarted. Pinned on the rendered text,
    /// since the live effect (a cgroup kill) cannot be measured in a test.
    #[test]
    fn the_rendered_unit_keeps_children_alive_across_a_restart() {
        let text = render_systemd(&spec_with("/t/tmm", "/h/.config")).unwrap();
        let service = text.split("[Service]").nth(1).unwrap().split("[Install]").next().unwrap();
        assert!(service.contains("\nKillMode=process\n"), "KillMode=process, in [Service]:\n{text}");
        assert_eq!(service.matches("KillMode=").count(), 1);
        assert!(service.contains("\nRestart=on-failure\n"), "the restart policy stays");
        assert_eq!(unit_kill_mode(&text).as_deref(), Some(KILL_MODE));
        // And it is still OURS by the strict grammar — a key we write.
        assert_eq!(unit_identity(&text).unwrap(), Identity { exe: "/t/tmm".into(), config_home: "/h/.config".into() });
        // `none` would also keep children alive, but would never end a wedged
        // gateway: it is not what we write, and reads as a gap.
        let none = text.replace("KillMode=process", "KillMode=none");
        assert_eq!(unit_kill_mode(&none).as_deref(), Some("none"));
        assert!(kill_mode_warning(N, Some("none")).contains("KillMode=none"));
        assert!(kill_mode_warning(N, None).contains("control-group"), "the default is named when the key is absent");
        assert!(kill_mode_warning(N, None).contains("tmm gateway install") && kill_mode_warning(N, None).contains("daemon-reload"), "and so is the way out, which stops nothing");
        assert!(!kill_mode_warning(N, Some("none")).contains("kill every tmux"), "none spares the children and the warning says so");
    }

    /// A unit of ours from before #350 (no KillMode=) is OURS, is reported as
    /// unprotected by `status` from the MANAGER's effective value, and
    /// `install` protects it IN PLACE — write, daemon-reload, read back — with
    /// no stop and no restart. The stop boundary refuses until the manager
    /// confirms `process`.
    #[test]
    fn a_pre_350_unit_is_protected_in_place_without_a_stop() {
        let home = scratch("protect");
        let (sys, f) = fake(&home, false);
        assert_eq!(install(&sys, N, false), Ok(Done::Installed(100)));
        assert_eq!(protection_warning(&sys, N), None, "a fresh unit is protected");
        assert_eq!(sys.effective_kill_mode(N).as_deref(), Some("process"), "and the manager says so");
        // What this host had: the pre-#350 file, loaded by a manager with the default.
        let file = sys.file(N);
        let text = std::fs::read_to_string(&file).unwrap();
        let old = text.replace(&format!("KillMode={KILL_MODE}\n"), "");
        std::fs::write(&file, &old).unwrap();
        *f.kill_mode.borrow_mut() = None;
        assert!(matches!(read_on_disk(&file, N, &sys.me, false), OnDisk::Ours { .. }), "still ours: same identity");
        assert_eq!(plan(&read_on_disk(&file, N, &sys.me, false), &render_systemd(&sys.spec(N)).unwrap()), Plan::Protect);
        let w = protection_warning(&sys, N).expect("status warns");
        assert!(w.contains("control-group") && w.contains("tmm gateway install"), "{w}");
        // Nothing of ours may stop it in this state.
        assert!(sys.stop_allowed(N).unwrap_err().contains("refusing to stop or restart"));
        assert!(restart(&sys, N).unwrap_err().contains("refusing to stop or restart"), "gateway:update's restart is refused");
        assert!(uninstall(&sys, N).unwrap_err().contains("refusing to stop or restart"), "and so is uninstall");

        // install: write + daemon-reload + read back; NO disable/enable/restart.
        f.calls.borrow_mut().clear();
        assert_eq!(install(&sys, N, false), Ok(Done::Protected(100)), "same pid: nothing restarted");
        let calls = f.calls.borrow().clone();
        assert!(calls.iter().any(|c| c.contains("daemon-reload")), "{calls:?}");
        assert!(!calls.iter().any(|c| c.contains("disable") || c.contains("enable") || c.contains("restart")), "no stop, no start: {calls:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text, "the protected text is on disk");
        assert_eq!(sys.effective_kill_mode(N).as_deref(), Some("process"), "and in effect");
        assert_eq!(protection_warning(&sys, N), None);
        assert_eq!(install(&sys, N, false), Ok(Done::AlreadyRunning(100)), "then a no-op");
        assert!(restart(&sys, N).is_ok(), "and a restart is allowed again");
        std::fs::remove_dir_all(&home).ok();
    }

    /// Reviewer P1-2: the protection is a fact about the MANAGER, not the
    /// file. If the reload does not make `process` effective — a drop-in
    /// forcing another mode, a reload error, an older systemd — the running
    /// instance is left alone and the error says so; and a file that says
    /// `process` while the manager has not loaded it is not "protected".
    #[test]
    fn protection_must_be_in_effect_before_anything_stops() {
        let home = scratch("ineffect");
        let (sys, f) = fake(&home, false);
        install(&sys, N, false).unwrap();
        let file = sys.file(N);
        let text = std::fs::read_to_string(&file).unwrap();
        let old = text.replace(&format!("KillMode={KILL_MODE}\n"), "");
        // (a) A drop-in pins control-group: the reload "succeeds" but the
        // manager still reports control-group. Modelled as a manager that does
        // not follow the file.
        std::fs::write(&file, &old).unwrap();
        *f.kill_mode.borrow_mut() = None;
        f.fail.borrow_mut().push("daemon-reload");
        let e = install(&sys, N, false).unwrap_err();
        assert!(e.contains("daemon-reload failed"), "{e}");
        assert_eq!(*f.pid.borrow(), Some(100), "the old instance still runs");
        assert!(!f.calls.borrow().iter().any(|c| c.contains("disable") || c.contains("restart")), "nothing stopped");
        f.fail.borrow_mut().clear();
        // (b) File says process, manager has not loaded it: NOT protected.
        std::fs::write(&file, &text).unwrap();
        *f.kill_mode.borrow_mut() = Some("control-group".into());
        assert!(protection_warning(&sys, N).is_some(), "the file is not evidence; the manager is");
        assert!(restart(&sys, N).is_err());
        // (c) Not running: the file is what will be loaded, so the file is read.
        *f.pid.borrow_mut() = None; *f.loaded.borrow_mut() = false; *f.verdict.borrow_mut() = Verdict::None;
        assert_eq!(protection_warning(&sys, N), None, "a stopped unit with the line will start protected");
        std::fs::write(&file, &old).unwrap();
        assert!(protection_warning(&sys, N).is_some());
        assert!(sys.stop_allowed(N).is_ok(), "nothing runs: nothing to kill");
        std::fs::remove_dir_all(&home).ok();
    }

    /// Reviewer P1-1: a PATH change on an old unit is an Update, and an
    /// Update stops the running instance — so it too must establish the
    /// protection first. The stop happens only after the manager confirms
    /// `process`; a unit with an explicit control-group/mixed is refused the
    /// same way.
    #[test]
    fn an_update_of_an_unprotected_running_unit_protects_before_it_stops() {
        let home = scratch("updold");
        let (sys, f) = fake(&home, false);
        install(&sys, N, false).unwrap();
        let file = sys.file(N);
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, text.replace(&format!("KillMode={KILL_MODE}\n"), "")).unwrap();
        *f.kill_mode.borrow_mut() = None;
        let sys2 = Sys { path_env: "/new/path".into(), ..sys };
        assert_eq!(plan(&read_on_disk(&file, N, &sys2.me, false), &render_systemd(&sys2.spec(N)).unwrap()), Plan::Update);
        f.calls.borrow_mut().clear();
        let Ok(Done::Updated(_)) = install(&sys2, N, false) else { panic!("updated") };
        let calls = f.calls.borrow().clone();
        let reload = calls.iter().position(|c| c.contains("daemon-reload")).expect("reload happened");
        let stop = calls.iter().position(|c| c.contains("disable")).expect("then the stop");
        assert!(reload < stop, "protection was loaded BEFORE the stop: {calls:?}");
        assert!(std::fs::read_to_string(&file).unwrap().contains("/new/path"));
        // Explicit control-group written by hand: ours? no — not our grammar
        // value — but the manager's effective value is what the boundary reads.
        *f.kill_mode.borrow_mut() = Some("mixed".into());
        assert!(restart(&sys2, N).unwrap_err().contains("KillMode=mixed"));
        std::fs::remove_dir_all(&home).ok();
    }

    /// `Protect` is only the missing-KillMode difference. Any other change
    /// (a new PATH, a moved tmm) is the ordinary `Update` — whose restart
    /// was always part of changing the unit — even when KillMode is missing
    /// too, so an old unit that also needs updating takes the Update path.
    #[test]
    fn protect_is_exactly_the_missing_kill_mode_and_nothing_else() {
        let spec = spec_with("/t/tmm", "/h/.config");
        let rendered = render_systemd(&spec).unwrap();
        let line = format!("KillMode={KILL_MODE}\n");
        let me = spec.id.clone();
        let ours = |text: &str| OnDisk::Ours { bytes: text.as_bytes().to_vec() };
        assert_eq!(plan(&ours(&rendered), &rendered), Plan::Keep);
        assert_eq!(plan(&ours(&rendered.replacen(&line, "", 1)), &rendered), Plan::Protect);
        let other_path = render_systemd(&Spec { path_env: "/other".into(), ..spec.clone() }).unwrap();
        assert_eq!(plan(&ours(&other_path), &rendered), Plan::Update, "a different PATH is an update");
        assert_eq!(plan(&ours(&other_path.replacen(&line, "", 1)), &rendered), Plan::Update, "old AND different: an update");
        assert_eq!(plan(&ours(&rendered.replace("KillMode=process", "KillMode=none")), &rendered), Plan::Update, "a wrong value is an update, not a protect");
        let _ = me;
    }

    #[test]
    fn a_service_that_exits_or_never_answers_is_a_failed_install() {
        let home = scratch("notready");
        let (sys, f) = fake(&home, false);
        // It starts, but the probe never says Ours (e.g. it exited on a held port).
        f.fail.borrow_mut().push("never");
        let sys = Sys { probe: Box::new(|| Verdict::None), ..sys };
        let e = install(&sys, N, false).unwrap_err();
        assert!(e.contains("not answering"), "{e}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_held_port_refuses_before_writing_anything() {
        let home = scratch("held");
        let (sys, f) = fake(&home, false);
        *f.verdict.borrow_mut() = Verdict::Occupied("another gateway".into());
        assert!(install(&sys, N, false).unwrap_err().contains("held"));
        assert!(!sys.file(N).exists(), "nothing written");
        *f.verdict.borrow_mut() = Verdict::Ours { machine_id: "m".into(), url: "ws://x".into() };
        assert!(install(&sys, N, false).unwrap_err().contains("outside this service"), "a foreground gateway would mask a dead service");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_failed_stop_aborts_before_the_file_changes() {
        let home = scratch("stopfail");
        let (sys, f) = fake(&home, false);
        install(&sys, N, false).unwrap();
        let before = std::fs::read(sys.file(N)).unwrap();
        let sys = Sys { path_env: "/new/path".into(), ..sys }; // an Update
        f.fail.borrow_mut().push("disable");
        let e = install(&sys, N, false).unwrap_err();
        assert!(e.contains("could not stop"), "{e}");
        assert_eq!(std::fs::read(sys.file(N)).unwrap(), before, "the file is untouched");
        let e = uninstall(&sys, N).unwrap_err();
        assert!(e.contains("could not stop") && sys.file(N).exists(), "uninstall keeps the file when the stop fails");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_failed_load_is_an_error_not_an_install() {
        let home = scratch("loadfail");
        let (sys, f) = fake(&home, false);
        f.fail.borrow_mut().push("enable");
        assert!(install(&sys, N, false).unwrap_err().contains("enable failed"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn replace_backs_up_restores_on_failure_and_reports_a_failed_restore() {
        let home = scratch("replace");
        let (sys, f) = fake(&home, true);
        let file = sys.file(LABEL);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let old = "<plist><dict><key>Label</key><string>cc.voka.tmux-mobile</string><key>ProgramArguments</key><array><string>/old/server</string></array></dict></plist>";
        std::fs::write(&file, old).unwrap();
        assert!(install(&sys, LABEL, false).unwrap_err().contains("--replace"), "not ours: refused without --replace");
        // Success: ours runs, the old file is backed up.
        let done = install(&sys, LABEL, true).unwrap();
        let Done::Replaced { backup, .. } = &done else { panic!("{done:?}") };
        assert_eq!(std::fs::read_to_string(backup).unwrap(), old);
        // Two backups in one second do not collide.
        std::fs::write(&file, old).unwrap();
        *f.pid.borrow_mut() = None; *f.loaded.borrow_mut() = false; *f.verdict.borrow_mut() = Verdict::None;
        let Done::Replaced { backup: b2, .. } = install(&sys, LABEL, true).unwrap() else { panic!() };
        assert_ne!(&b2, backup);
        // Failure: ours never answers → the old file is put back and loaded.
        std::fs::write(&file, old).unwrap();
        *f.pid.borrow_mut() = None; *f.loaded.borrow_mut() = false; *f.verdict.borrow_mut() = Verdict::None;
        let never = Sys { probe: Box::new(|| Verdict::None), ..fake(&home, true).0 };
        let e = install(&never, LABEL, true).unwrap_err();
        // The old one was not running, so only its file is put back.
        assert!(e.contains("previous file was restored"), "{e}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), old, "the old file is back");
        // Failure, and the restore fails too: both errors, the backup kept.
        let (bad, bf) = fake(&home, true);
        let bad = Sys { probe: Box::new(|| Verdict::None), ..bad };
        std::fs::write(&file, old).unwrap();
        bf.fail.borrow_mut().push("bootstrap");
        let e = install(&bad, LABEL, true).unwrap_err();
        assert!(e.contains("ALSO failed") && e.contains("kept at"), "{e}");
        std::fs::remove_dir_all(&home).ok();
    }

    const OLD_PLIST: &str = "<plist><dict><key>Label</key><string>cc.voka.tmux-mobile</string><key>ProgramArguments</key><array><string>/old/server</string></array></dict></plist>";
    fn ours_answering() -> Verdict { Verdict::Ours { machine_id: "m".into(), url: "ws://x".into() } }

    /// clawdbjs's case: the #313 hand plist RUNS and is the gateway on the
    /// port. --replace backs it up and stops it before the port check.
    #[test]
    fn replace_migrates_a_running_legacy_service() {
        let home = scratch("legacy");
        let (sys, f) = fake(&home, true);
        let file = sys.file(LABEL);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, OLD_PLIST).unwrap();
        *f.loaded.borrow_mut() = true; *f.pid.borrow_mut() = Some(50); *f.verdict.borrow_mut() = ours_answering();
        assert!(install(&sys, LABEL, false).unwrap_err().contains("--replace"), "without --replace: refused, untouched");
        assert_eq!(*f.pid.borrow(), Some(50), "the legacy service still runs");
        let Done::Replaced { pid, backup } = install(&sys, LABEL, true).unwrap() else { panic!() };
        assert_eq!(pid, 100, "ours runs (a fresh start after the old one stopped)");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), OLD_PLIST);
        let calls = f.calls.borrow();
        let stop = calls.iter().position(|c| c.contains("bootout")).unwrap();
        let start = calls.iter().position(|c| c.contains("bootstrap")).unwrap();
        assert!(stop < start, "stopped before ours is loaded: {calls:?}");
        std::fs::remove_dir_all(&home).ok();
    }

    /// An unrelated occupant is not the legacy service: after stopping the
    /// old one the port is still held, so nothing is written and the old
    /// service is put back and runs again.
    #[test]
    fn replace_with_an_unrelated_occupant_restores_the_legacy_service() {
        let home = scratch("occupant");
        let (sys, f) = fake(&home, true);
        let file = sys.file(LABEL);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, OLD_PLIST).unwrap();
        *f.loaded.borrow_mut() = true; *f.pid.borrow_mut() = Some(50);
        *f.occupant.borrow_mut() = Some(Verdict::Occupied("another program".into()));
        let e = install(&sys, LABEL, true).unwrap_err();
        assert!(e.contains("port is held") && e.contains("after stopping") && e.contains("runs again"), "{e}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), OLD_PLIST, "the old file is back");
        assert!(f.pid.borrow().is_some(), "the old service runs again");
        // A held port with nothing of this name: refused before anything is written.
        let (sys2, f2) = fake(&scratch("occupant2"), true);
        *f2.occupant.borrow_mut() = Some(Verdict::Occupied("another program".into()));
        assert!(install(&sys2, LABEL, false).unwrap_err().contains("held") && !sys2.file(LABEL).exists());
        std::fs::remove_dir_all(&home).ok();
    }

    /// macOS: bootout fails and launchctl print cannot answer either →
    /// unknown is NOT "stopped": the files stay as they were.
    #[test]
    fn mac_an_unqueryable_stop_fails_closed() {
        let home = scratch("macprint");
        let (sys, f) = fake(&home, true);
        install(&sys, LABEL, false).unwrap();
        let before = std::fs::read(sys.file(LABEL)).unwrap();
        f.fail.borrow_mut().extend(["bootout", "print"]);
        let e = uninstall(&sys, LABEL).unwrap_err();
        assert!(e.contains("could not stop") && e.contains("cannot tell"), "{e}");
        assert_eq!(std::fs::read(sys.file(LABEL)).unwrap(), before, "uninstall left the file");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn an_unreadable_or_foreign_file_is_never_absent() {
        let home = scratch("foreign");
        let (sys, _f) = fake(&home, false);
        let file = sys.file(N);
        std::fs::create_dir_all(&file).unwrap(); // a directory where the file should be: read fails, not NotFound
        assert!(matches!(read_on_disk(&file, N, &sys.me, false), OnDisk::NotOurs(_)));
        assert!(install(&sys, N, false).is_err(), "never Create over something unreadable");
        std::fs::remove_dir_all(&file).unwrap();
        std::fs::write(&file, "[Service]\nExecStart=/usr/bin/node server.js\n").unwrap();
        assert!(uninstall(&sys, N).is_err() && file.exists(), "a hand-written unit is never removed");
        assert!(logs_command(&sys, N, false).is_err(), "logs follow the same identity check");
        // A unit that only LOOKS like ours under a lax unescape: refused, and
        // no native stop is ever issued for it.
        let ours = render_systemd(&sys.spec(N)).unwrap();
        for (what, from, to) in [("\\t in the exe", "\"/opt/tmm\"", "\"/opt/\\tmm\""), ("\\n in the root", ".config\"", ".co\\nfig\"")] {
            let bad = ours.replacen(from, to, 1);
            assert_ne!(bad, ours, "{what}: fixture applied");
            std::fs::write(&file, &bad).unwrap();
            _f.calls.borrow_mut().clear();
            assert!(uninstall(&sys, N).is_err() && file.exists(), "{what}: refused, kept");
            assert!(!_f.calls.borrow().iter().any(|c| c.contains("disable") || c.contains("stop")), "{what}: no stop: {:?}", _f.calls.borrow());
        }
        assert!(install(&sys, "../../evil.service", false).is_err(), "a name cannot leave the service directory");
        std::fs::remove_dir_all(&home).ok();
    }
}
