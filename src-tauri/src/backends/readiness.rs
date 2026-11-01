//! Backend readiness (board #492): for each backend, is its CLI installed on
//! the managed launch PATH, is what a NEW managed agent of it needs set up,
//! and — only where a free authenticated query exists, and only when a
//! person asks — does it answer. The one RPC is `backends_check`; `tmm agent
//! backends` prints the same rows. Design and rules:
//! docs/design-docs/features/agents-overview.md § Backend readiness.
//!
//! WHAT IS CHECKED is a BASELINE, built in the order spawn builds a pane
//! (`projects::spawn::materialize` + `launch_window`): the tmux server's
//! GLOBAL environment, the tmux `default-shell` run as a login + interactive
//! shell (so the user's rc files run, as in every pane), then the recipe
//! layer on top (PATH = `agent_launch_path(tmm_dir, gateway PATH)`, and each
//! backend's render carry). It names no project, so a session's own
//! environment is not in it, and it says what a new agent on the CLI's
//! DEFAULT provider/model would meet — not what a definition that picks
//! another model, or an existing home, would.
//!
//! WHAT IS RETURNED is facts as words: present / missing / unknown, the
//! evidence (`via`), the names of missing variables, and a reason class.
//! Never a value. The login shell's own stdout and stderr go to /dev/null;
//! the answer comes back on fd 3, written by this binary's hidden
//! `tmm readiness-probe` helper as ONE framed line that the gateway parses
//! against fixed fields and word lists. The frame's nonce is a correlation
//! marker against stray output, not authentication: the rc is the user's own
//! trusted code and can read it (reviewer P2-E). Non-exposure rests on the
//! field and value allow-lists.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::Backend;
use crate::probe::{self, Channel, Failure};

/// A Refresh's budget: its REPLY arrives within it, preparation included
/// (`Flight`, orchestrator ruling on #492). The work's own deadline sits
/// inside it (`work_deadline`), so a normal finish near the edge is not a
/// timeout. A file-system call that never returns can keep one worker
/// blocked; until it returns, a Refresh answers `check_timeout` without
/// starting more work.
pub const REFRESH_BUDGET: Duration = Duration::from_secs(15);
/// An explicit Test's whole budget, preparation included: kiro's whoami (at
/// most 10 s) and its model catalogue (the rest, at most 20 s) are two
/// stages inside it.
pub const TEST_BUDGET: Duration = Duration::from_secs(30);
const VERSION_LIMIT: Duration = Duration::from_secs(10);
const TMUX_LIMIT: Duration = Duration::from_secs(2);
const CLAUDE_LIMIT: Duration = Duration::from_secs(5);
const WHOAMI_LIMIT: Duration = Duration::from_secs(10);
const CATALOGUE_LIMIT: Duration = Duration::from_secs(20);
/// What the helper keeps back from the outer deadline, so its own children
/// (each in its own process group) always end before the outer kill comes.
const HELPER_MARGIN: Duration = Duration::from_millis(1500);
/// The most of the helper's frame that is read; a longer one is refused.
/// The worst frame (MAX_NAMES names of 128 bytes, each `"NAME":false,`, and
/// the claude answer) is about 2.4 KB.
const FRAME_CAP: u64 = 4 * 1024;
/// The most of a user config file that is read; a larger one is unknown.
const CONFIG_CAP: u64 = 1024 * 1024;
/// The shells the baseline runs: one POSIX script. Anything else is unknown.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh"];
/// The backends with an explicit Test in phase 1 (orchestrator, #492).
pub const TESTABLE: &[Backend] = &[Backend::Kiro];
/// At most this many variable names are asked about in one probe.
const MAX_NAMES: usize = 16;

/// The ONE script the login shell runs after its rc files: no
/// interpolation, no eval. `$1` is the helper; every other value is an
/// argument. stdin, stdout and stderr were /dev/null before the shell
/// started; only the helper's stdout is moved to fd 3.
const SCRIPT: &str = r#"h=$1; shift; exec "$h" readiness-probe "$@" >&3 2>/dev/null </dev/null"#;

/// A presence fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Present,
    Missing,
    Unknown,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::Present => "present",
            State::Missing => "missing",
            State::Unknown => "unknown",
        }
    }
}

/// Where a 'set up' fact comes from: an artefact's presence, or the CLI's
/// own answer to "are you signed in" (still not "the credentials work").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    Presence,
    Cli,
}

/// What a new managed agent of a backend needs, as found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetUp {
    pub state: State,
    pub basis: Basis,
    /// The evidence, as words and names only (`auth.json`, `env DEEPSEEK_API_KEY`).
    pub via: Option<String>,
    /// Variable names whose absence makes it missing.
    pub missing: Vec<String>,
    /// A reason class (`docs § Backend readiness` lists them).
    pub reason: Option<&'static str>,
}

impl SetUp {
    pub fn present(via: impl Into<String>) -> SetUp {
        SetUp { state: State::Present, basis: Basis::Presence, via: Some(via.into()), missing: Vec::new(), reason: None }
    }
    pub fn missing(names: Vec<String>, reason: &'static str) -> SetUp {
        SetUp { state: State::Missing, basis: Basis::Presence, via: None, missing: names, reason: Some(reason) }
    }
    pub fn unknown(reason: &'static str) -> SetUp {
        SetUp { state: State::Unknown, basis: Basis::Presence, via: None, missing: Vec::new(), reason: Some(reason) }
    }
    pub(crate) fn with_via(mut self, via: impl Into<String>) -> SetUp {
        self.via = Some(via.into());
        self
    }
    fn by_cli(mut self) -> SetUp {
        self.basis = Basis::Cli;
        self
    }
    fn to_json(&self) -> Value {
        json!({
            "state": self.state.word(),
            "basis": match self.basis { Basis::Presence => "presence", Basis::Cli => "cli" },
            "via": self.via,
            "missing": self.missing,
            "reason": self.reason,
        })
    }
}

/// What deciding a backend's 'set up' needs, declared in the backend's own
/// file (`Backend::set_up_need`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    /// Decided from the user's files alone.
    Found(SetUp),
    /// Present when ANY of these variables is set in the baseline, else
    /// missing. Build with `Need::env`, which validates the names.
    Env { any_of: Vec<String> },
    /// Claude Code's own `auth status`, asked in the baseline with the
    /// carried settings (claude).
    ClaudeAuth,
    /// Unknown until a person runs the Test (kiro, ruled (c) on #492).
    TestOnly,
}

impl Need {
    /// `Env`, or unknown when a name is not a variable name: names come from
    /// the user's config files, so they are untrusted (reviewer P1-B).
    pub fn env(any_of: Vec<String>) -> Need {
        if any_of.is_empty() || !any_of.iter().all(|n| env_name_ok(n)) {
            return Need::Found(SetUp::unknown("invalid_env_name"));
        }
        Need::Env { any_of }
    }
}

/// A variable name: a letter or `_`, then letters, digits or `_`, at most 128.
pub fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A user config file, read so it cannot hold the check (reviewer P1-B):
/// opened non-blocking (a FIFO cannot stall the open), checked on the OPEN
/// descriptor to be a regular file, read to at most `CONFIG_CAP`.
/// `Ok(None)` when it is absent; otherwise a reason class.
pub(crate) fn read_small(path: &Path) -> Result<Option<String>, &'static str> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("config_unreadable"),
    };
    let meta = file.metadata().map_err(|_| "config_unreadable")?;
    if !meta.is_file() {
        return Err("config_not_regular");
    }
    // The read itself is the cap: one byte past it is refused.
    let mut text = String::new();
    match file.take(CONFIG_CAP + 1).read_to_string(&mut text) {
        Ok(n) if n as u64 > CONFIG_CAP => Err("config_too_large"),
        Ok(_) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Err("config_invalid"),
        Err(_) => Err("config_unreadable"),
    }
}

/// A TOML file of the user's (`read_small`): `Ok(None)` when it is absent,
/// a reason class when it cannot be read or parsed.
pub(crate) fn read_toml(path: &Path) -> Result<Option<toml::Table>, &'static str> {
    match read_small(path)? {
        Some(text) => text.parse::<toml::Table>().map(Some).map_err(|_| "config_invalid"),
        None => Ok(None),
    }
}

/// The env block Claude's render carries (`shared::claude_env_of`), read
/// with `read_small` so an unreadable or invalid settings file is a reason,
/// never the empty carry an absent one is.
pub(crate) fn claude_carry(path: &Path) -> Result<Value, &'static str> {
    match read_small(path)? {
        None => Ok(json!({})),
        Some(text) => serde_json::from_str::<Value>(&text).map(|v| super::shared::claude_env_of(&v)).map_err(|_| "config_invalid"),
    }
}

/// The variable NAMES a dotenv file sets (`NAME=…`, `export NAME=…`).
/// Values are never kept. Absent file = none.
pub(crate) fn dotenv_names(path: &Path) -> Result<Vec<String>, &'static str> {
    let Some(text) = read_small(path)? else { return Ok(Vec::new()) };
    Ok(text
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let l = l.strip_prefix("export ").map(str::trim_start).unwrap_or(l);
            let (name, _) = l.split_once('=')?;
            let name = name.trim();
            env_name_ok(name).then(|| name.to_string())
        })
        .collect())
}

/// INSTALLED: the launch program on the managed PATH, and its version.
/// `state` is missing only when no PATH directory has it; a directory that
/// could not be looked at, or a probe that was lost, is unknown (P1-D).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub state: State,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub reason: Option<String>,
}

impl Installed {
    fn to_json(&self) -> Value {
        json!({
            "state": self.state.word(),
            "path": self.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            "version": self.version,
            "reason": self.reason,
        })
    }
}

/// The PATH walk (`tmux::find_on_path`, no subprocess) + `--version`
/// through the one runner. Missing ONLY when no PATH directory has the
/// program; a directory that could not be looked at is unknown; a version
/// that times out or fails is installed with its version unknown (P2-D).
pub fn installed(program: &str, path: &str, deadline: Instant) -> Installed {
    #[cfg(test)]
    test_seam::walking();
    let abs = match crate::tmux::find_on_path(program, path.as_ref()) {
        Ok(Some(abs)) => abs,
        Ok(None) => return Installed { state: State::Missing, path: None, version: None, reason: Some("not_found".into()) },
        Err(_) => return Installed { state: State::Unknown, path: None, version: None, reason: Some("path_unreadable".into()) },
    };
    // The walk above came out of the same deadline (reviewer P1-B residual);
    // nothing starts once it has passed.
    let limit = VERSION_LIMIT.min(deadline.saturating_duration_since(Instant::now()));
    if limit.is_zero() {
        return Installed { state: State::Present, path: Some(abs), version: None, reason: Some("version_timeout".into()) };
    }
    let mut cmd = std::process::Command::new(&abs);
    cmd.arg("--version").env("PATH", path);
    match probe::run(cmd, limit, Channel::Stdout, probe::READ_CAP) {
        Ok(out) => match version_word(&out) {
            Some(v) => Installed { state: State::Present, path: Some(abs), version: Some(v), reason: None },
            None => Installed { state: State::Present, path: Some(abs), version: None, reason: Some("version_unreadable".into()) },
        },
        Err(f) => Installed { state: State::Present, path: Some(abs), version: None, reason: Some(format!("version_{}", f.word())) },
    }
}

/// The version in a `--version` answer: the first word of its first line
/// (split at spaces and `/`) that starts with a digit and has a dot, of
/// version characters only, at most 32. Measured shapes (2026-11-01):
/// `kiro-cli 2.34.0`, `2.1.304 (Claude Code)`, `codex-cli 0.162.1`,
/// `grok 1.0.52 (0920c8169e27) [alpha]`, `omp/18.2.10`, `2.1.1`,
/// `0.2.0-rc.2`. Anything else is no version, never the raw line.
pub fn version_word(out: &str) -> Option<String> {
    out.lines().next()?.split(|c: char| c.is_whitespace() || c == '/').find_map(|w| {
        let ok = w.len() <= 32
            && w.starts_with(|c: char| c.is_ascii_digit())
            && w.contains('.')
            && w.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
        ok.then(|| w.to_string())
    })
}

/// The baseline a pane would start from (see the module doc).
#[derive(Debug, Clone)]
pub struct Baseline {
    pub shell: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub home: PathBuf,
}

/// Is `shell` one the baseline runs?
pub fn shell_ok(shell: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    shell.is_absolute()
        && shell.file_name().and_then(|n| n.to_str()).is_some_and(|n| SHELLS.contains(&n))
        && std::fs::metadata(shell).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The baseline from the RUNNING tmux server: its global environment and
/// default-shell. Never starts tmux, never falls back to the gateway's own
/// environment.
fn baseline(deadline: Instant) -> Result<Baseline, &'static str> {
    let tmux = |args: &[&str]| {
        let mut cmd = std::process::Command::new(crate::tmux::find_tmux());
        if let Some(socket) = crate::tmux::get_socket() {
            cmd.args(["-S", &socket]);
        }
        cmd.args(args);
        let limit = TMUX_LIMIT.min(deadline.saturating_duration_since(Instant::now()));
        probe::run(cmd, limit, Channel::Stdout, probe::READ_CAP)
    };
    let env_text = tmux(&["show-environment", "-g"]).map_err(|f| match f {
        Failure::Exit | Failure::NotFound => "no_tmux",
        Failure::Timeout => "probe_timeout",
        _ => "probe_failed",
    })?;
    let shell = tmux(&["show", "-gv", "default-shell"]).map_err(|_| "no_tmux")?;
    let env = parse_tmux_env(&env_text);
    let home = env.iter().find(|(k, _)| k == "HOME").map(|(_, v)| PathBuf::from(v)).ok_or("baseline_incomplete")?;
    let shell = PathBuf::from(shell.trim());
    if !shell_ok(&shell) {
        return Err("shell_unsupported");
    }
    Ok(Baseline { shell, env, home })
}

/// `tmux show-environment -g` as pairs: `NAME=value` rows, `-NAME` (removed
/// from the environment) dropped.
pub fn parse_tmux_env(text: &str) -> Vec<(OsString, OsString)> {
    text.lines()
        .filter(|l| !l.starts_with('-'))
        .filter_map(|l| l.split_once('='))
        .filter(|(k, _)| env_name_ok(k))
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

/// A private scratch directory (0700), removed with everything in it when
/// dropped, on every exit path.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new() -> std::io::Result<Scratch> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("tmm-readiness-{}", uuid::Uuid::new_v4().simple()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Scratch(dir))
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    /// A 0600 file in it, through the one private writer (`safe_fs::publish`
    /// into the held directory: `write_private` only writes under a `.tmm`
    /// directory, and the scratch is not one).
    pub fn write(&self, name: &str, body: &str) -> std::io::Result<PathBuf> {
        let dir = crate::safe_fs::private_dir(&self.0)?;
        crate::safe_fs::publish(&dir, name, body.as_bytes())?;
        Ok(self.0.join(name))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What the probe asks the helper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ask {
    /// Which of `names` are set; and, with a config dir, Claude's sign-in.
    Refresh { names: Vec<String>, claude_dir: Option<PathBuf> },
    /// kiro's whoami, then its model catalogue.
    KiroTest,
}

/// Claude Code's answer to `auth status`, as words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeAnswer {
    pub signed_in: Option<bool>,
    pub method: Option<String>,
    pub provider: Option<String>,
    pub fail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhoamiAnswer {
    pub signed_in: Option<bool>,
    pub method: Option<String>,
    pub fail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogueAnswer {
    pub answers: Option<bool>,
    pub count: Option<u32>,
    pub fail: Option<String>,
}

/// The helper's one frame, after the nonce.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, tag = "mode", rename_all = "kebab-case")]
pub enum Frame {
    Refresh { env: BTreeMap<String, bool>, claude: Option<ClaudeAnswer> },
    KiroTest { whoami: WhoamiAnswer, models: CatalogueAnswer },
}

const CLAUDE_METHODS: &[&str] = &["oauth", "api_key", "third_party", "other"];
const CLAUDE_PROVIDERS: &[&str] = &["first_party", "bedrock", "vertex", "foundry", "other"];
const KIRO_METHODS: &[&str] = &["iam_identity_center", "builder_id", "other"];
const FAIL_WORDS: &[&str] = &["not_found", "spawn_failed", "timeout", "exit", "unreadable", "lost", "overflow", "bad_answer"];

fn word_in(w: &Option<String>, set: &[&str]) -> bool {
    w.as_deref().is_none_or(|w| set.contains(&w))
}

/// Read the helper's fd-3 text as exactly one frame for `ask`, or the
/// reason class `probe_protocol`: one line, `<nonce> <json>`, the fields of
/// the asked mode only, the asked names only, words from the lists only.
pub fn parse_frame(text: &str, nonce: &str, ask: &Ask) -> Result<Frame, &'static str> {
    const BAD: &str = "probe_protocol";
    let line = text.strip_suffix('\n').ok_or(BAD)?;
    if line.contains('\n') {
        return Err(BAD);
    }
    let body = line.strip_prefix(nonce).and_then(|r| r.strip_prefix(' ')).ok_or(BAD)?;
    let frame: Frame = serde_json::from_str(body).map_err(|_| BAD)?;
    match (&frame, ask) {
        (Frame::Refresh { env, claude }, Ask::Refresh { names, claude_dir }) => {
            let asked: std::collections::BTreeSet<&String> = names.iter().collect();
            let got: std::collections::BTreeSet<&String> = env.keys().collect();
            if asked != got || claude.is_some() != claude_dir.is_some() {
                return Err(BAD);
            }
            if let Some(c) = claude {
                if !word_in(&c.method, CLAUDE_METHODS) || !word_in(&c.provider, CLAUDE_PROVIDERS) || !word_in(&c.fail, FAIL_WORDS) {
                    return Err(BAD);
                }
            }
        }
        (Frame::KiroTest { whoami, models }, Ask::KiroTest) => {
            if !word_in(&whoami.method, KIRO_METHODS) || !word_in(&whoami.fail, FAIL_WORDS) || !word_in(&models.fail, FAIL_WORDS) {
                return Err(BAD);
            }
        }
        _ => return Err(BAD),
    }
    Ok(frame)
}

/// Run the baseline's login shell with the fixed script and read the
/// helper's frame from fd 3. The environment is the baseline's ONLY (the
/// gateway's own is cleared); control values travel as arguments.
pub fn shell_probe(base: &Baseline, helper: &Path, overlay_path: &str, ask: &Ask, deadline: Instant) -> Result<Frame, &'static str> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining < HELPER_MARGIN * 2 {
        return Err("probe_timeout");
    }
    let helper_deadline = std::time::SystemTime::now() + remaining - HELPER_MARGIN;
    let helper_deadline_ms = helper_deadline.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut cmd = std::process::Command::new(&base.shell);
    cmd.env_clear().envs(base.env.iter().map(|(k, v)| (k, v))).current_dir(&base.home);
    cmd.args(["-l", "-i", "-c", SCRIPT, "tmm-readiness"]).arg(helper).arg(&nonce).arg(helper_deadline_ms.to_string()).arg(overlay_path);
    match ask {
        Ask::Refresh { names, claude_dir } => {
            cmd.arg("refresh").arg(claude_dir.as_deref().map(Path::as_os_str).unwrap_or("-".as_ref()));
            cmd.args(names);
        }
        Ask::KiroTest => {
            cmd.args(["kiro-test", "-"]);
        }
    }
    let text = probe::run(cmd, remaining, Channel::Fd3, FRAME_CAP).map_err(|f| match f {
        Failure::Timeout => "probe_timeout",
        Failure::Overflow => "probe_protocol",
        _ => "probe_failed",
    })?;
    parse_frame(&text, nonce.as_str(), ask)
}

/// The helper (`tmm readiness-probe`), run by the fixed script inside the
/// baseline shell. Local only: it never calls the gateway and never starts
/// an agent. Arguments: nonce, deadline (unix ms), overlay PATH, mode,
/// claude config dir or `-`, then the variable names. Prints its one frame
/// on stdout (the script made that fd 3); exit 2 with nothing printed when
/// an argument is not what the gateway sends.
pub fn helper_main(args: &[String]) -> i32 {
    // The fixed script gave this process fd 3 as well as stdout; a CLI it
    // runs must not inherit it, or a CLI's lingering child would hold the
    // gateway's read open until the deadline.
    // SAFETY: a plain fcntl on a descriptor number; a closed fd 3 only
    // makes it fail, which is fine.
    unsafe {
        libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    match helper_frame(args, &|n| std::env::var_os(n).is_some_and(|v| !v.is_empty())) {
        Some(line) => {
            print!("{line}");
            0
        }
        None => 2,
    }
}

/// `helper_main`'s frame, with the environment lookup injected. Pure but
/// for the CLIs it runs.
pub fn helper_frame(args: &[String], is_set: &dyn Fn(&str) -> bool) -> Option<String> {
    let [nonce, deadline, overlay, mode, claude_dir, names @ ..] = args else { return None };
    if nonce.len() != 32 || !nonce.chars().all(|c| c.is_ascii_hexdigit()) || overlay.is_empty() {
        return None;
    }
    let deadline_ms: u64 = deadline.parse().ok()?;
    let deadline = std::time::UNIX_EPOCH + Duration::from_millis(deadline_ms);
    let left = |cap: Duration| cap.min(deadline.duration_since(std::time::SystemTime::now()).unwrap_or_default());
    let frame = match mode.as_str() {
        "refresh" => {
            if names.len() > MAX_NAMES || !names.iter().all(|n| env_name_ok(n)) {
                return None;
            }
            let env = names.iter().map(|n| (n.clone(), is_set(n))).collect();
            let claude = match claude_dir.as_str() {
                "-" => None,
                dir if Path::new(dir).is_absolute() => Some(claude_status(overlay, Path::new(dir), left(CLAUDE_LIMIT))),
                _ => return None,
            };
            Frame::Refresh { env, claude }
        }
        "kiro-test" if names.is_empty() && claude_dir == "-" => {
            let whoami = kiro_whoami(overlay, left(WHOAMI_LIMIT));
            // The catalogue takes what the whoami left, at most 20 s.
            let models = kiro_catalogue(overlay, left(CATALOGUE_LIMIT));
            Frame::KiroTest { whoami, models }
        }
        _ => return None,
    };
    Some(format!("{nonce} {}\n", serde_json::to_string(&frame).ok()?))
}

/// `claude auth status` with the carried settings: its JSON read for the
/// three fields, each mapped onto a word list. Nothing else of it is kept.
fn claude_status(overlay: &str, config_dir: &Path, limit: Duration) -> ClaudeAnswer {
    let mut cmd = std::process::Command::new("claude");
    cmd.args(["auth", "status"]).env("PATH", overlay).env("CLAUDE_CONFIG_DIR", config_dir);
    let fail = |w: &str| ClaudeAnswer { signed_in: None, method: None, provider: None, fail: Some(w.into()) };
    let (out, code) = match probe::run_status_as(cmd, limit, Channel::Stdout, probe::READ_CAP, probe::Group::Caller) {
        Ok(r) => r,
        Err(f) => return fail(f.word()),
    };
    let logged_in = serde_json::from_str::<Value>(&out).ok().and_then(|v| v.get("loggedIn").and_then(Value::as_bool));
    // Only the measured pairs (2.1.304, board #492): signed in is exit 0 with
    // `loggedIn: true`; signed out is exit 1 with `loggedIn: false`. Any
    // other exit, or a pair that disagrees, is no answer.
    let signed_in = match (logged_in, code) {
        (Some(true), Some(0)) => true,
        (Some(false), Some(1)) => false,
        (_, Some(0)) => return fail("bad_answer"),
        _ => return fail("exit"),
    };
    let Ok(v) = serde_json::from_str::<Value>(&out) else { return fail("bad_answer") };
    let method = v.get("authMethod").and_then(Value::as_str).map(|m| match m {
        "oauth_token" | "oauth" | "claude.ai" => "oauth",
        "api_key" | "apiKey" => "api_key",
        "third_party" => "third_party",
        _ => "other",
    });
    let provider = v.get("apiProvider").and_then(Value::as_str).map(|p| match p {
        "firstParty" => "first_party",
        "bedrock" => "bedrock",
        "vertex" => "vertex",
        "foundry" => "foundry",
        _ => "other",
    });
    ClaudeAnswer { signed_in: Some(signed_in), method: method.map(String::from), provider: provider.map(String::from), fail: None }
}

/// `kiro-cli whoami`: exit 0 is signed in (the method from its first line,
/// as a word; the start URL and account never kept). Signed out was never
/// measured, so any failing exit is no answer (`exit`), never "signed out".
fn kiro_whoami(overlay: &str, limit: Duration) -> WhoamiAnswer {
    let mut cmd = std::process::Command::new("kiro-cli");
    cmd.arg("whoami").env("PATH", overlay);
    match probe::run_status_as(cmd, limit, Channel::Stdout, probe::READ_CAP, probe::Group::Caller) {
        Ok((out, Some(0))) => {
            let first = out.lines().next().unwrap_or("");
            let method = if first.contains("IAM Identity Center") {
                "iam_identity_center"
            } else if first.contains("Builder ID") {
                "builder_id"
            } else {
                "other"
            };
            WhoamiAnswer { signed_in: Some(true), method: Some(method.into()), fail: None }
        }
        Ok(_) => WhoamiAnswer { signed_in: None, method: None, fail: Some("exit".into()) },
        Err(f) => WhoamiAnswer { signed_in: None, method: None, fail: Some(f.word().into()) },
    }
}

/// kiro's model catalogue (`chat --list-models`, the free authenticated
/// query `models_fetch` already uses): answers when it lists a model.
fn kiro_catalogue(overlay: &str, limit: Duration) -> CatalogueAnswer {
    let mut cmd = std::process::Command::new("kiro-cli");
    cmd.args(["chat", "--list-models", "-f", "json"]).env("PATH", overlay);
    match probe::run_status_as(cmd, limit, Channel::Stdout, probe::READ_CAP, probe::Group::Caller) {
        Ok((_, code)) if code != Some(0) => CatalogueAnswer { answers: None, count: None, fail: Some("exit".into()) },
        Ok((out, _)) => match serde_json::from_str::<Value>(&out).ok().and_then(|v| v.get("models")?.as_array().map(Vec::len)) {
            Some(0) => CatalogueAnswer { answers: Some(false), count: Some(0), fail: None },
            Some(n) => CatalogueAnswer { answers: Some(true), count: Some(n.min(u32::MAX as usize) as u32), fail: None },
            None => CatalogueAnswer { answers: None, count: None, fail: Some("bad_answer".into()) },
        },
        Err(f) => CatalogueAnswer { answers: None, count: None, fail: Some(f.word().into()) },
    }
}

/// A reason class in words, for `tmm agent backends` (the app's own text is
/// its i18n table, keyed by the same class).
pub fn reason_text(code: &str) -> &'static str {
    match code {
        "not_found" => "not on the managed PATH",
        "version_timeout" => "its --version timed out",
        "version_exit" => "its --version failed",
        "version_unreadable" => "its --version answer was not a version",
        "version_not_found" | "version_spawn_failed" | "version_lost" => "its --version could not run",
        "no_tmux" => "no tmux server is running to read the pane environment from",
        "baseline_incomplete" => "the tmux environment has no HOME",
        "shell_unsupported" => "the tmux default-shell is not sh, bash, zsh, dash or ksh",
        "helper_missing" => "tmm is not next to the server binary",
        "scratch_failed" => "a private scratch directory could not be made",
        "probe_timeout" => "the login-shell check timed out",
        "probe_failed" => "the login-shell check failed",
        "probe_lost" => "the check stopped without an answer",
        "probe_protocol" => "the login-shell check gave no well-formed answer",
        "config_unreadable" => "its config could not be read",
        "config_invalid" => "its config is not valid TOML",
        "config_absent" => "it has no config file",
        "invalid_env_name" => "its config names an invalid variable",
        "aws_chain" => "an AWS credential chain, known at its first run",
        "unrecognised_provider" => "its provider is not one this check knows",
        "credential_store_unverified" => "its credential store is not checked",
        "test_only" => "only a Test can tell: tmm agent backends --test kiro",
        "check_timeout" => "the check did not answer in time (a hung file system can hold it; it answers this until that call returns)",
        "not_signed_in" => "the CLI says it is not signed in",
        "cli_not_found" => "the CLI was not found by the check",
        "cli_spawn_failed" => "the CLI would not start",
        "cli_timeout" => "the CLI's own check timed out",
        "cli_exit" => "the CLI's own check exited with a failure it does not explain",
        "cli_unreadable" | "cli_bad_answer" | "cli_overflow" => "the CLI's own check gave no answer this check reads",
        "cli_lost" => "the CLI's own check stopped without an answer",
        "path_unreadable" => "a directory on the managed PATH could not be looked at",
        "config_not_regular" => "its config is not a regular file",
        "config_too_large" => "its config is larger than 1 MiB",
        "env_unset" => "not set in the login shell's environment",
        "no_auth" => "no auth.json and no config: run grok's login or add a [model.*] with env_key",
        "first_run" => "known at its first run",
        "empty_catalogue" => "it listed no models",
        _ => "unknown reason",
    }
}

/// One backend's row.
fn row(b: Backend, installed: &Installed, set_up: &SetUp, answers: Value) -> Value {
    json!({
        "name": b.name(),
        "program": b.launch_program(),
        "installed": installed.to_json(),
        "set_up": set_up.to_json(),
        "answers": answers,
    })
}

/// Fold a backend's need with the baseline probe's answer.
pub fn decide(need: &Need, probe: &Result<Frame, &'static str>) -> SetUp {
    match need {
        Need::Found(s) => s.clone(),
        Need::TestOnly => SetUp::unknown("test_only"),
        Need::Env { any_of } => match probe {
            Err(reason) => SetUp::unknown(reason),
            Ok(Frame::Refresh { env, .. }) => match any_of.iter().find(|n| env.get(*n) == Some(&true)) {
                Some(n) => SetUp::present(format!("env {n}")),
                None if any_of.iter().all(|n| env.get(n) == Some(&false)) => SetUp::missing(any_of.clone(), "env_unset"),
                None => SetUp::unknown("probe_protocol"),
            },
            Ok(_) => SetUp::unknown("probe_protocol"),
        },
        Need::ClaudeAuth => match probe {
            Err(reason) => SetUp::unknown(reason),
            Ok(Frame::Refresh { claude: Some(c), .. }) => match (c.signed_in, &c.fail) {
                (Some(true), _) => SetUp::present(format!(
                    "{}/{}",
                    c.method.as_deref().unwrap_or("other"),
                    c.provider.as_deref().unwrap_or("other")
                ))
                .by_cli(),
                (Some(false), _) => SetUp::missing(Vec::new(), "not_signed_in").by_cli(),
                (None, fail) => SetUp::unknown(cli_reason(fail.as_deref())).by_cli(),
            },
            Ok(_) => SetUp::unknown("probe_protocol"),
        },
    }
}

/// A CLI's failure class as the reason a row carries (P1-D: the class is
/// kept to the RPC and the CLI text, never folded into one word).
fn cli_reason(fail: Option<&str>) -> &'static str {
    match fail {
        Some("not_found") => "cli_not_found",
        Some("spawn_failed") => "cli_spawn_failed",
        Some("timeout") => "cli_timeout",
        Some("exit") => "cli_exit",
        Some("unreadable") => "cli_unreadable",
        Some("lost") => "cli_lost",
        Some("overflow") => "cli_overflow",
        _ => "cli_bad_answer",
    }
}

/// The Test's facts: whoami as 'set up (per the CLI)', the catalogue as
/// 'answers'.
pub fn decide_test(probe: &Result<Frame, &'static str>) -> (SetUp, Value) {
    let unknown_answers = |reason: &str| json!({ "state": "unknown", "count": null, "reason": reason });
    match probe {
        Err(reason) => (SetUp::unknown(reason), unknown_answers(reason)),
        Ok(Frame::KiroTest { whoami, models }) => {
            let set_up = match whoami.signed_in {
                Some(true) => SetUp::present(whoami.method.clone().unwrap_or_else(|| "other".into())).by_cli(),
                Some(false) => SetUp::missing(Vec::new(), "not_signed_in").by_cli(),
                None => SetUp::unknown(cli_reason(whoami.fail.as_deref())).by_cli(),
            };
            let answers = match models.answers {
                Some(true) => json!({ "state": "yes", "count": models.count, "reason": null }),
                Some(false) => json!({ "state": "no", "count": 0, "reason": "empty_catalogue" }),
                None => unknown_answers(cli_reason(models.fail.as_deref())),
            };
            (set_up, answers)
        }
        Ok(_) => (SetUp::unknown("probe_protocol"), unknown_answers("probe_protocol")),
    }
}

/// The helper binary: `tmm` next to the server.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn helper() -> Option<PathBuf> {
    let h = crate::projects::spawn::tmm_dir()?.join("tmm");
    h.is_file().then_some(h)
}

/// The user's Claude settings, the file `shared::claude_user_env` reads.
#[cfg(not(test))]
fn claude_settings_path() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".claude").join("settings.json")
}

/// Under test, an empty PATH: a Refresh in a unit test finds no CLI and
/// starts none of the developer's.
#[cfg(test)]
fn overlay_path() -> String {
    crate::config::fresh_process_dir("tmm-rdy-fixture-path").to_string_lossy().into_owned()
}

/// Seams for the unit tests of the Refresh's own threads (reviewer P1-B,
/// round 3): a delay after the preparation, a gate the PATH walk waits on,
/// and a count of the version threads started. Test builds only.
#[cfg(test)]
mod test_seam {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex};
    pub static PREP_DELAY_MS: AtomicU64 = AtomicU64::new(0);
    pub static PANIC_AFTER_SPAWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    /// A controlled panic after the version threads exist (the P2 row).
    pub fn maybe_panic() {
        if PANIC_AFTER_SPAWN.swap(false, Ordering::SeqCst) {
            panic!("test_seam: a controlled panic after the spawn");
        }
    }
    pub static SPAWNS: AtomicUsize = AtomicUsize::new(0);
    pub static GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
    pub fn prepared() {
        let ms = PREP_DELAY_MS.load(Ordering::SeqCst);
        if ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }
    pub fn spawned() {
        SPAWNS.fetch_add(1, Ordering::SeqCst);
    }
    /// Waits while the gate is closed.
    pub fn walking() {
        let (lock, open) = &GATE;
        let closed = lock.lock().unwrap_or_else(|p| p.into_inner());
        drop(open.wait_while(closed, |c| *c).unwrap_or_else(|p| p.into_inner()));
    }
    pub fn close() {
        *GATE.0.lock().unwrap_or_else(|p| p.into_inner()) = true;
    }
    pub fn open() {
        *GATE.0.lock().unwrap_or_else(|p| p.into_inner()) = false;
        GATE.1.notify_all();
    }
}

/// Under test, never the developer's real settings (the backends' own
/// `*_user_home` pattern).
#[cfg(test)]
fn claude_settings_path() -> PathBuf {
    crate::config::fresh_process_dir("tmm-rdy-fixture-claude").join("settings.json")
}

/// The managed PATH, the same call spawn makes.
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
fn overlay_path() -> String {
    super::shared::agent_launch_path(crate::projects::spawn::tmm_dir().as_deref(), &std::env::var("PATH").unwrap_or_default())
}

/// The baseline probe for a Refresh: the claude carry (already read, see
/// `refresh`) written into a scratch dir that lives exactly as long as the
/// probe.
fn refresh_probe(needs: &[(Backend, Need)], claude_env: Option<&Value>, deadline: Instant) -> Result<Frame, &'static str> {
    let names: Vec<String> = {
        let mut all: Vec<String> = needs.iter().flat_map(|(_, n)| match n { Need::Env { any_of } => any_of.clone(), _ => Vec::new() }).collect();
        all.sort();
        all.dedup();
        all
    };
    let wants_claude = claude_env.is_some() && needs.iter().any(|(_, n)| *n == Need::ClaudeAuth);
    if names.is_empty() && !wants_claude {
        return Ok(Frame::Refresh { env: BTreeMap::new(), claude: None });
    }
    let base = baseline(deadline)?;
    let helper = helper().ok_or("helper_missing")?;
    let scratch = Scratch::new().map_err(|_| "scratch_failed")?;
    let claude_dir = if wants_claude {
        let settings = json!({ "env": claude_env }).to_string();
        scratch.write("settings.json", &settings).map_err(|_| "scratch_failed")?;
        Some(scratch.path().to_path_buf())
    } else {
        None
    };
    let ask = Ask::Refresh { names, claude_dir };
    let got = shell_probe(&base, &helper, &overlay_path(), &ask, deadline);
    drop(scratch);
    got
}

/// One Refresh: every backend's row. Never runs a Test.
pub fn refresh(deadline: Instant) -> Value {
    let path = overlay_path();
    // Each preparation step reads through `read_small`; after EACH one the
    // same deadline decides whether to go on (reviewer P1-B, round 3). One
    // that ran past it starts nothing more: the reply has gone (timed out),
    // and this result would not be read.
    let claude_env = claude_carry(&claude_settings_path());
    #[cfg(test)]
    test_seam::prepared();
    if Instant::now() >= deadline {
        return refresh_timed_out();
    }
    let mut needs: Vec<(Backend, Need)> = Vec::new();
    for b in Backend::ALL {
        let need = b.set_up_need();
        needs.push(match (&need, &claude_env) {
            // Unreadable settings: the carry is unknown, so is claude.
            (Need::ClaudeAuth, Err(r)) => (b, Need::Found(SetUp::unknown(r))),
            _ => (b, need),
        });
        if Instant::now() >= deadline {
            return refresh_timed_out();
        }
    }
    // From here on the threads this work starts are ITS OWN: they run in a
    // `std::thread::scope`, which joins every one before the scope ends on
    // ANY way out, a panic in the spawn or the shell probe included
    // (reviewer P2 on #492 phase 1), so the flight stays taken until they
    // have all ended and a stuck one is never piled on. Only the CALLER
    // times out, through the flight's deadline.
    std::thread::scope(|scope| {
        let versions: Vec<_> = Backend::ALL
            .iter()
            .map(|b| {
                let (program, path) = (b.launch_program(), path.as_str());
                #[cfg(test)]
                test_seam::spawned();
                scope.spawn(move || installed(program, path, deadline))
            })
            .collect();
        #[cfg(test)]
        test_seam::maybe_panic();
        let probe = refresh_probe(&needs, claude_env.as_ref().ok(), deadline);
        let rows: Vec<Value> = needs
            .iter()
            .zip(versions)
            .map(|((b, need), v)| {
                let installed = v.join().unwrap_or(Installed { state: State::Unknown, path: None, version: None, reason: Some("probe_lost".into()) });
                let answers = if TESTABLE.contains(b) {
                    json!({ "state": "unknown", "count": null, "reason": "test_only" })
                } else {
                    json!({ "state": "unknown", "count": null, "reason": "first_run" })
                };
                row(*b, &installed, &decide(need, &probe), answers)
            })
            .collect();
        json!({ "backends": rows, "scope": "default", "baseline": probe.as_ref().err().copied() })
    })
}

/// One explicit Test of `b` (in `TESTABLE`).
pub fn test(b: Backend, deadline: Instant) -> Value {
    let probe = (|| {
        let base = baseline(deadline)?;
        let helper = helper().ok_or("helper_missing")?;
        shell_probe(&base, &helper, &overlay_path(), &Ask::KiroTest, deadline)
    })();
    let (set_up, answers) = decide_test(&probe);
    json!({ "test": { "name": b.name(), "set_up": set_up.to_json(), "answers": answers } })
}

/// One flight per key: a second caller while one runs gets the SAME answer
/// instead of starting another (reviewer P1-C). A Refresh and a Test are
/// different keys, so neither ever stands in for the other.
///
/// The work never runs on a caller's thread (reviewer P1-B residual): it
/// runs on ONE worker, and every caller, the one that started it included,
/// waits at most until the flight's own deadline (its budget, fixed when it
/// starts), then answers `timed_out`. What no deadline can
/// end is a file-system call that never returns; then that one worker stays
/// blocked, the flight stays taken, and every later caller joins it and
/// answers `timed_out` at once, so no second worker starts.
pub struct Flight {
    slot: std::sync::Mutex<Option<std::sync::Arc<Shared>>>,
}

struct Shared {
    deadline: Instant,
    /// The work's answer and when it came: an answer that came after the
    /// deadline never replaces the timed-out reply.
    done: std::sync::Mutex<Option<(Value, Instant)>>,
    ready: std::sync::Condvar,
}

/// Where the work's own deadline sits inside a flight's: a tenth of the
/// budget before it, derived from the one budget constant, so the work ends
/// and its answer is read before the reply is due.
pub fn work_deadline(flight_deadline: Instant, budget: Duration) -> Instant {
    flight_deadline - budget / 10
}

impl Flight {
    pub const fn new() -> Flight {
        Flight { slot: std::sync::Mutex::new(None) }
    }

    /// Run `work` on a worker, or join the run in flight; answer within the
    /// flight's `budget` (fixed when it starts) or `timed_out()`. `work` is
    /// handed `work_deadline` of that same budget.
    pub fn run(&'static self, budget: Duration, timed_out: impl Fn() -> Value, work: impl FnOnce(Instant) -> Value + Send + 'static) -> Value {
        let shared = {
            let mut slot = self.slot.lock().unwrap_or_else(|p| p.into_inner());
            match slot.as_ref() {
                Some(s) => s.clone(),
                None => {
                    let deadline = Instant::now() + budget;
                    let s = std::sync::Arc::new(Shared { deadline, done: std::sync::Mutex::new(None), ready: std::sync::Condvar::new() });
                    *slot = Some(s.clone());
                    let worker = s.clone();
                    let work_until = work_deadline(deadline, budget);
                    std::thread::spawn(move || {
                        let v = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(work_until))).unwrap_or_else(|_| json!({ "error": "check_failed" }));
                        *worker.done.lock().unwrap_or_else(|p| p.into_inner()) = Some((v, Instant::now()));
                        worker.ready.notify_all();
                        // Only THIS flight is cleared: the slot holds it until now.
                        let mut slot = self.slot.lock().unwrap_or_else(|p| p.into_inner());
                        if slot.as_ref().is_some_and(|cur| std::sync::Arc::ptr_eq(cur, &worker)) {
                            slot.take();
                        }
                    });
                    s
                }
            }
        };
        let wait = shared.deadline.saturating_duration_since(Instant::now());
        let done = shared.done.lock().unwrap_or_else(|p| p.into_inner());
        let (done, _) = shared.ready.wait_timeout_while(done, wait, |d| d.is_none()).unwrap_or_else(|p| p.into_inner());
        match done.as_ref() {
            Some((v, at)) if *at <= shared.deadline => v.clone(),
            _ => timed_out(),
        }
    }
}

static REFRESH: Flight = Flight::new();
static KIRO_TEST: Flight = Flight::new();

/// A Refresh that did not answer by its deadline: every backend, every fact
/// unknown, `check_timeout`. The shape of a normal reply.
fn refresh_timed_out() -> Value {
    let rows: Vec<Value> = Backend::ALL
        .iter()
        .map(|b| {
            let unknown = Installed { state: State::Unknown, path: None, version: None, reason: Some("check_timeout".into()) };
            row(*b, &unknown, &SetUp::unknown("check_timeout"), json!({ "state": "unknown", "count": null, "reason": "check_timeout" }))
        })
        .collect();
    json!({ "backends": rows, "scope": "default", "baseline": "check_timeout" })
}

/// A Test that did not answer by its deadline.
fn test_timed_out(b: Backend) -> Value {
    json!({ "test": { "name": b.name(), "set_up": SetUp::unknown("check_timeout").to_json(), "answers": { "state": "unknown", "count": null, "reason": "check_timeout" } } })
}

/// The `backends_check` RPC: a Refresh, or with `test` an explicit Test of a
/// `TESTABLE` backend. `Err` is an invalid-params message.
pub fn check(test_of: Option<&str>) -> Result<Value, String> {
    match test_of {
        None => Ok(REFRESH.run(REFRESH_BUDGET, refresh_timed_out, refresh)),
        Some(name) => {
            let b = Backend::parse(name).ok_or_else(|| format!("unknown backend '{name}'"))?;
            if !TESTABLE.contains(&b) {
                return Err(format!("no Test for {} in this phase", b.name()));
            }
            Ok(KIRO_TEST.run(TEST_BUDGET, move || test_timed_out(b), move |deadline| test(b, deadline)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_variable_name_is_validated_before_it_reaches_anything() {
        for ok in ["A", "_x", "KIMI_API_KEY", "a1_B2"] {
            assert!(env_name_ok(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A B", "$(touch X)", "a;b", "A=B", "Ä", &"A".repeat(129)] {
            assert!(!env_name_ok(bad), "{bad:?}");
        }
        assert_eq!(Need::env(s(&["$(touch X)"])), Need::Found(SetUp::unknown("invalid_env_name")));
        assert_eq!(Need::env(Vec::new()), Need::Found(SetUp::unknown("invalid_env_name")));
        assert_eq!(Need::env(s(&["OK"])), Need::Env { any_of: s(&["OK"]) });
    }

    #[test]
    fn a_dotenv_gives_names_only() {
        let dir = crate::config::fresh_process_dir("tmm-rdy-fixture-dotenv");
        let f = dir.join(".env");
        std::fs::write(&f, "# c\nOPENAI_API_KEY=sk-SENTINEL\nexport  AWS_X = v\nbad-name=1\n=x\nplain\n").unwrap();
        assert_eq!(dotenv_names(&f).unwrap(), s(&["OPENAI_API_KEY", "AWS_X"]));
        assert_eq!(dotenv_names(&dir.join("absent")).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn the_tmux_environment_drops_removed_and_malformed_rows() {
        let env = parse_tmux_env("HOME=/h\n-DISPLAY\nPATH=/a:/b\nbad name=x\nX=a=b\n");
        let keys: Vec<_> = env.iter().map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy())).collect();
        assert_eq!(keys, ["HOME=/h", "PATH=/a:/b", "X=a=b"]);
    }

    #[test]
    fn only_a_listed_absolute_executable_shell_is_run() {
        assert!(shell_ok(Path::new("/bin/sh")));
        assert!(!shell_ok(Path::new("sh")), "relative");
        assert!(!shell_ok(Path::new("/usr/bin/env")), "not a listed shell");
        assert!(!shell_ok(Path::new("/nonexistent/zsh")), "absent");
    }

    #[test]
    fn installed_is_not_found_only_when_the_program_is_absent() {
        let dir = crate::config::fresh_process_dir("tmm-rdy-fixture-installed");
        let write = |name: &str, body: &str| {
            use std::os::unix::fs::PermissionsExt;
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write("good", "#!/bin/sh\necho 'good 1.2.3'\n");
        write("hang", "#!/bin/sh\nsleep 30\n");
        write("fails", "#!/bin/sh\nexit 4\n");
        write("words", "#!/bin/sh\necho no version here\n");
        // The fixtures' own dir first, then the system's: a fixture script
        // needs `sleep`, and the child gets this PATH like a pane does.
        let path = format!("{}:/usr/bin:/bin", dir.to_string_lossy());
        let limit = Duration::from_millis(800);
        assert_eq!(installed("tmm-absent-cli", &path, Instant::now() + limit), Installed { state: State::Missing, path: None, version: None, reason: Some("not_found".into()) });
        let good = installed("good", &path, Instant::now() + limit);
        assert_eq!((good.version.as_deref(), good.reason), (Some("1.2.3"), None));
        assert_eq!(installed("hang", &path, Instant::now() + limit).reason.as_deref(), Some("version_timeout"));
        assert_eq!(installed("fails", &path, Instant::now() + limit).reason.as_deref(), Some("version_exit"));
        assert_eq!(installed("words", &path, Instant::now() + limit).reason.as_deref(), Some("version_unreadable"));
        for p in ["hang", "fails", "words"] {
            assert!(installed(p, &path, Instant::now() + limit).path.is_some(), "{p}: installed, version unknown");
        }
        assert_eq!(installed("good", &path, Instant::now() + limit).to_json()["state"], "present");
        assert_eq!(installed("tmm-absent-cli", &path, Instant::now() + limit).to_json()["state"], "missing");
        // A PATH directory that cannot be looked at: unknown, never missing.
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = dir.join("locked");
            std::fs::create_dir_all(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let got = installed("tmm-absent-cli", &format!("{}:/usr/bin", locked.display()), Instant::now() + limit);
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!((got.state, got.reason.as_deref()), (State::Unknown, Some("path_unreadable")));
        }
    }

    #[test]
    fn a_version_is_a_word_from_the_measured_shapes_and_nothing_else() {
        for (out, want) in [
            ("kiro-cli 2.34.0\n", Some("2.34.0")),
            ("2.1.304 (Claude Code)\n", Some("2.1.304")),
            ("codex-cli 0.162.1\n", Some("0.162.1")),
            ("grok 1.0.52 (0920c8169e27) [alpha]\n", Some("1.0.52")),
            ("omp/18.2.10\n", Some("18.2.10")),
            ("2.1.1\n", Some("2.1.1")),
            ("0.2.0-rc.2\n", Some("0.2.0-rc.2")),
            ("no version here\n", None),
            ("", None),
            ("tool 12\n", None),
            ("x 1.2.3;rm\n", None),
        ] {
            assert_eq!(version_word(out).as_deref(), want, "{out:?}");
        }
    }

    fn nonce() -> String {
        "0123456789abcdef0123456789abcdef".into()
    }

    #[test]
    fn a_frame_is_one_line_with_the_asked_fields_and_words_only() {
        let ask = Ask::Refresh { names: s(&["A", "B"]), claude_dir: None };
        let ok = format!("{} {{\"mode\":\"refresh\",\"env\":{{\"A\":true,\"B\":false}},\"claude\":null}}\n", nonce());
        assert!(parse_frame(&ok, &nonce(), &ask).is_ok());
        let bad = [
            ok.trim_end().to_string(),                                       // no newline
            format!("{ok}{ok}"),                                              // two frames
            ok.replace(&nonce(), "ffffffffffffffffffffffffffffffff"),         // wrong nonce
            ok.replace("\"B\":false", "\"B\":false,\"C\":true"),              // a name not asked
            ok.replace(",\"B\":false", ""),                                   // a name missing
            ok.replace("\"claude\":null", "\"claude\":null,\"extra\":1"),     // an unknown field
            ok.replace("true", "\"sk-SENTINEL\""),                            // a value, not a boolean
            format!("noise\n{ok}"),                                           // stray output first
        ];
        for b in &bad {
            assert_eq!(parse_frame(b, &nonce(), &ask), Err("probe_protocol"), "{b:?}");
        }
        let with_claude = Ask::Refresh { names: Vec::new(), claude_dir: Some(PathBuf::from("/x")) };
        let c = |m: &str| format!("{} {{\"mode\":\"refresh\",\"env\":{{}},\"claude\":{{\"signed_in\":true,\"method\":\"{m}\",\"provider\":\"bedrock\",\"fail\":null}}}}\n", nonce());
        assert!(parse_frame(&c("third_party"), &nonce(), &with_claude).is_ok());
        assert_eq!(parse_frame(&c("alice@example.com"), &nonce(), &with_claude), Err("probe_protocol"), "a word outside the list");
        assert_eq!(parse_frame(&ok, &nonce(), &Ask::KiroTest), Err("probe_protocol"), "another mode's frame");
    }

    #[test]
    fn the_helper_refuses_arguments_the_gateway_never_sends() {
        let set = |n: &str| n == "SET";
        let far = (std::time::SystemTime::now() + Duration::from_secs(60)).duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
        let args = |rest: &[&str]| -> Vec<String> { [nonce().as_str(), far.as_str(), "/p"].iter().chain(rest).map(|x| x.to_string()).collect() };
        let line = helper_frame(&args(&["refresh", "-", "SET", "UNSET"]), &set).expect("a well-formed ask");
        let ask = Ask::Refresh { names: s(&["SET", "UNSET"]), claude_dir: None };
        let Ok(Frame::Refresh { env, claude }) = parse_frame(&line, &nonce(), &ask) else { panic!("{line}") };
        assert_eq!((env.get("SET"), env.get("UNSET"), claude), (Some(&true), Some(&false), None));
        for bad in [
            args(&["refresh", "-", "$(touch X)"]),
            args(&["refresh", "relative/dir"]),
            args(&["other", "-"]),
            args(&["kiro-test", "-", "NAME"]),
            vec!["short".into(), far.clone(), "/p".into(), "refresh".into(), "-".into()],
        ] {
            assert_eq!(helper_frame(&bad, &set), None, "{bad:?}");
        }
        let many: Vec<String> = (0..=MAX_NAMES).map(|i| format!("N{i}")).collect();
        let mut too_many = args(&["refresh", "-"]);
        too_many.extend(many);
        assert_eq!(helper_frame(&too_many, &set), None);
    }

    #[test]
    fn env_and_claude_needs_are_decided_from_the_frame_never_guessed() {
        let frame = |env: &[(&str, bool)], claude: Option<ClaudeAnswer>| -> Result<Frame, &'static str> {
            Ok(Frame::Refresh { env: env.iter().map(|(k, v)| (k.to_string(), *v)).collect(), claude })
        };
        let need = Need::env(s(&["A", "B"]));
        assert_eq!(decide(&need, &frame(&[("A", false), ("B", true)], None)), SetUp::present("env B"));
        assert_eq!(decide(&need, &frame(&[("A", false), ("B", false)], None)), SetUp::missing(s(&["A", "B"]), "env_unset"));
        assert_eq!(decide(&need, &Err("no_tmux")), SetUp::unknown("no_tmux"), "no baseline is unknown, never missing");
        let c = |signed_in, fail: Option<&str>| ClaudeAnswer { signed_in, method: Some("third_party".into()), provider: Some("bedrock".into()), fail: fail.map(String::from) };
        assert_eq!(decide(&Need::ClaudeAuth, &frame(&[], Some(c(Some(true), None)))).via.as_deref(), Some("third_party/bedrock"));
        assert_eq!(decide(&Need::ClaudeAuth, &frame(&[], Some(c(Some(true), None)))).basis, Basis::Cli);
        assert_eq!(decide(&Need::ClaudeAuth, &frame(&[], Some(c(Some(false), None)))).reason, Some("not_signed_in"));
        assert_eq!(decide(&Need::ClaudeAuth, &frame(&[], Some(c(None, Some("timeout"))))), SetUp::unknown("cli_timeout").by_cli(), "the class is kept");
        assert_eq!(decide(&Need::ClaudeAuth, &frame(&[], Some(c(None, Some("exit"))))).reason, Some("cli_exit"));
        assert_eq!(decide(&Need::TestOnly, &frame(&[], None)), SetUp::unknown("test_only"));
    }

    #[test]
    fn a_test_is_never_joined_with_a_refresh_and_a_joiner_gets_the_same_answer() {
        static F: Flight = Flight::new();
        static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let go = || {
            std::thread::spawn(|| {
                F.run(Duration::from_secs(5), || json!({ "timed_out": true }), |_| {
                    RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(300));
                    json!({ "n": 1 })
                })
            })
        };
        let a = go();
        std::thread::sleep(Duration::from_millis(50));
        let b = go();
        assert_eq!(a.join().unwrap(), json!({ "n": 1 }));
        assert_eq!(b.join().unwrap(), json!({ "n": 1 }));
        assert_eq!(RUNS.load(std::sync::atomic::Ordering::SeqCst), 1, "the second caller joined");
        assert!(!std::ptr::eq(&REFRESH, &KIRO_TEST), "a Refresh and a Test are separate flights");
        assert_eq!(check(Some("claude")), Err("no Test for claude in this phase".into()));
        assert_eq!(check(Some("nope")), Err("unknown backend 'nope'".into()));
    }

    /// Reviewer P1-B residual: the reply is bounded even when the WORK
    /// (preparation included) is not. The caller that started it answers
    /// timed-out at the flight's deadline; a caller while it is still stuck
    /// answers at once and starts nothing; once it ends, a new call runs.
    #[test]
    fn a_stuck_flight_answers_timed_out_by_its_deadline_and_starts_no_second_worker() {
        static F: Flight = Flight::new();
        static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let call = || {
            F.run(Duration::from_millis(200), || json!({ "timed_out": true }), |_| {
                RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(800));
                json!({ "n": 1 })
            })
        };
        let t0 = Instant::now();
        // a joiner that comes BEFORE the deadline answers at that same
        // deadline, not 200 ms after it came
        let early = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let v = call();
            (v, t0.elapsed())
        });
        assert_eq!(call(), json!({ "timed_out": true }));
        let took = t0.elapsed();
        let (v, joined_took) = early.join().unwrap();
        assert_eq!(v, json!({ "timed_out": true }));
        assert!(joined_took < Duration::from_millis(280), "the early joiner shared the flight's deadline: {joined_took:?}");
        assert!(took >= Duration::from_millis(190) && took < Duration::from_millis(500), "the starter answered at the deadline: {took:?}");
        let t1 = Instant::now();
        assert_eq!(call(), json!({ "timed_out": true }));
        assert!(t1.elapsed() < Duration::from_millis(100), "past its deadline, a joiner answers at once: {:?}", t1.elapsed());
        assert_eq!(RUNS.load(std::sync::atomic::Ordering::SeqCst), 1, "no second worker while the first is stuck");
        std::thread::sleep(Duration::from_millis(900));
        // The stuck work ended and cleared its flight: the next call runs.
        let next = F.run(Duration::from_secs(2), || json!({ "timed_out": true }), |_| json!({ "n": 2 }));
        assert_eq!(next, json!({ "n": 2 }));
        assert_eq!(RUNS.load(std::sync::atomic::Ordering::SeqCst), 1);
        // the work is handed a deadline inside the flight's, from the one budget
        static G: Flight = Flight::new();
        let t = Instant::now();
        let got = G.run(Duration::from_secs(10), || json!(null), move |d| json!(d.saturating_duration_since(t).as_millis() as u64));
        let ms = got.as_u64().unwrap();
        assert!((9000..=9100).contains(&ms), "work deadline at nine tenths of the budget: {ms} ms");
        // and the timed-out Refresh has a normal reply's shape
        let t = refresh_timed_out();
        assert_eq!(t["backends"].as_array().map(Vec::len), Some(Backend::ALL.len()));
        assert_eq!(t["backends"][0]["installed"]["state"], "unknown");
        assert_eq!(t["backends"][0]["set_up"]["reason"], "check_timeout");
    }

    #[test]
    fn each_backend_reads_its_own_files_and_says_unknown_rather_than_guess() {
        let home = |tag: &str, files: &[(&str, &str)]| {
            let d = crate::config::fresh_process_dir(&format!("tmm-rdy-fixture-{tag}"));
            for (name, body) in files {
                std::fs::write(d.join(name), body).unwrap();
            }
            d
        };
        use crate::backends::{codex, grok, kimi, omp};
        // codex
        assert_eq!(codex::set_up_need_in(&home("cx0", &[])), Need::env(s(&["OPENAI_API_KEY"])), "no config: openai, its key asked");
        assert_eq!(codex::set_up_need_in(&home("cx1", &[("auth.json", "{}")])), Need::Found(SetUp::present("auth.json")));
        assert_eq!(codex::set_up_need_in(&home("cx2", &[(".env", "OPENAI_API_KEY=sk-SENTINEL\n")])), Need::Found(SetUp::present(".env OPENAI_API_KEY")));
        let aws = "model_provider = \"br\"\n[model_providers.br]\nname = \"b\"\n[model_providers.br.aws]\nprofile = \"p\"\n";
        assert_eq!(codex::set_up_need_in(&home("cx3", &[("config.toml", aws)])), Need::Found(SetUp::unknown("aws_chain").with_via("provider br")));
        let keyed = "model_provider = \"x\"\n[model_providers.x]\nenv_key = \"X_KEY\"\n";
        assert_eq!(codex::set_up_need_in(&home("cx4", &[("config.toml", keyed)])), Need::env(s(&["X_KEY"])));
        assert_eq!(codex::set_up_need_in(&home("cx5", &[("config.toml", "model_provider = \"gone\"\n")])), Need::Found(SetUp::unknown("unrecognised_provider")));
        assert_eq!(codex::set_up_need_in(&home("cx6", &[("config.toml", "not = = toml")])), Need::Found(SetUp::unknown("config_invalid")));
        let evil = "model_provider = \"x\"\n[model_providers.x]\nenv_key = \"$(touch X)\"\n";
        assert_eq!(codex::set_up_need_in(&home("cx7", &[("config.toml", evil)])), Need::Found(SetUp::unknown("invalid_env_name")));
        let odd = "model_provider = \"a b\\nc\"\n[model_providers.\"a b\\nc\"]\n[model_providers.\"a b\\nc\".aws]\nprofile = \"p\"\n";
        assert_eq!(codex::set_up_need_in(&home("cx9", &[("config.toml", odd)])), Need::Found(SetUp::unknown("aws_chain")), "an id outside the plain shape is not carried");
        // grok
        assert_eq!(grok::set_up_need_in(&home("gk0", &[])), Need::Found(SetUp::missing(Vec::new(), "no_auth")));
        assert_eq!(grok::set_up_need_in(&home("gk1", &[("auth.json", "{}")])), Need::Found(SetUp::present("auth.json")));
        let g = "[models]\ndefault = \"m\"\n[model.m]\nenv_key = \"AWS_BEARER_TOKEN_BEDROCK\"\n";
        assert_eq!(grok::set_up_need_in(&home("gk2", &[("config.toml", g)])), Need::env(s(&["AWS_BEARER_TOKEN_BEDROCK"])));
        assert_eq!(grok::set_up_need_in(&home("gk3", &[("config.toml", "[models]\ndefault = \"m\"\n")])), Need::Found(SetUp::unknown("unrecognised_provider")));
        // kimi
        assert_eq!(kimi::set_up_need_in(&home("km0", &[])), Need::Found(SetUp::unknown("config_absent")));
        let k = |p: &str| format!("default_model = \"d\"\n[models.d]\nprovider = \"p\"\n[providers.p]\n{p}\n");
        assert_eq!(kimi::set_up_need_in(&home("km1", &[("config.toml", &k("api_key_env = \"KIMI_API_KEY\""))])), Need::env(s(&["KIMI_API_KEY"])));
        assert_eq!(kimi::set_up_need_in(&home("km2", &[("config.toml", &k("api_key = \"sk-SENTINEL\""))])), Need::Found(SetUp::present("config api_key")));
        assert_eq!(kimi::set_up_need_in(&home("km3", &[("config.toml", "default_model = \"nope\"\n")])), Need::Found(SetUp::unknown("unrecognised_provider")));
        // omp: always unknown, the store only stat'ed
        assert_eq!(omp::set_up_need_in(&home("op0", &[])), Need::Found(SetUp::unknown("credential_store_unverified").with_via("no credential store")));
        assert_eq!(omp::set_up_need_in(&home("op1", &[("agent.db", "not even sqlite")])), Need::Found(SetUp::unknown("credential_store_unverified").with_via("credential store present")));
        // no value from a file ever reaches a need
        for n in [codex::set_up_need_in(&home("cx8", &[(".env", "OPENAI_API_KEY=sk-SENTINEL\n")])), kimi::set_up_need_in(&home("km4", &[("config.toml", &k("api_key = \"sk-SENTINEL\""))]))] {
            assert!(!format!("{n:?}").contains("SENTINEL"), "{n:?}");
        }
        // the launch programs
        let programs: Vec<_> = Backend::ALL.iter().map(|b| b.launch_program()).collect();
        assert_eq!(programs, ["kiro-cli", "claude", "codex", "grok", "omp", "kimi", "dsh"]);
    }

    /// Reviewer P1-B: a config file cannot hold the check. A FIFO is refused
    /// at once (the open does not wait for a writer), as is a directory, a
    /// file over 1 MiB and text that is not UTF-8.
    #[test]
    fn a_config_read_is_bounded_and_regular_files_only() {
        let dir = crate::config::fresh_process_dir("tmm-rdy-fixture-read");
        let fifo = dir.join("config.toml");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a plain syscall on a path this test owns.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let t0 = Instant::now();
        assert_eq!(read_small(&fifo), Err("config_not_regular"));
        assert_eq!(read_toml(&fifo), Err("config_not_regular"));
        assert!(t0.elapsed() < Duration::from_secs(1), "no wait on the FIFO: {:?}", t0.elapsed());
        assert_eq!(read_small(&dir), Err("config_not_regular"), "a directory");
        let big = dir.join("big");
        std::fs::write(&big, vec![b'#'; CONFIG_CAP as usize + 1]).unwrap();
        assert_eq!(read_small(&big), Err("config_too_large"));
        let exact = dir.join("exact");
        std::fs::write(&exact, vec![b'#'; CONFIG_CAP as usize]).unwrap();
        assert_eq!(read_small(&exact).map(|t| t.map(|t| t.len())), Ok(Some(CONFIG_CAP as usize)));
        let bin = dir.join("bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_small(&bin), Err("config_invalid"));
        assert_eq!(read_small(&dir.join("absent")), Ok(None));
        // the claude carry: absent is the empty carry, unreadable is a reason
        assert_eq!(claude_carry(&dir.join("absent")), Ok(json!({})));
        let bad = dir.join("settings.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert_eq!(claude_carry(&bad), Err("config_invalid"));
        std::fs::write(&bad, r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"},"theme":"dark"}"#).unwrap();
        assert_eq!(claude_carry(&bad), Ok(json!({ "CLAUDE_CODE_USE_BEDROCK": "1" })));
        assert_eq!(claude_carry(&fifo), Err("config_not_regular"));
    }

    /// Reviewer P1-D: Claude's sign-in is read only from the measured pairs
    /// (2.1.304: exit 0 + loggedIn true, exit 1 + loggedIn false); kiro's
    /// failing whoami is no answer, never "signed out".
    #[test]
    fn a_cli_answer_counts_only_in_its_measured_shape() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::config::fresh_process_dir("tmm-rdy-fixture-cli");
        let cc = dir.join("cc");
        std::fs::create_dir_all(&cc).unwrap();
        let far = (std::time::SystemTime::now() + Duration::from_secs(60)).duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
        let overlay = format!("{}:/usr/bin:/bin", dir.display());
        let fake = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let claude = |body: &str| {
            fake("claude", body);
            let args: Vec<String> = [nonce().as_str(), far.as_str(), overlay.as_str(), "refresh", &cc.to_string_lossy()].iter().map(|x| x.to_string()).collect();
            let line = helper_frame(&args, &|_| false).unwrap();
            let ask = Ask::Refresh { names: Vec::new(), claude_dir: Some(cc.clone()) };
            match parse_frame(&line, &nonce(), &ask) {
                Ok(Frame::Refresh { claude: Some(c), .. }) => (c.signed_in, c.fail),
                other => panic!("{other:?}"),
            }
        };
        let json = |b: bool| format!("echo '{{\"loggedIn\":{b},\"authMethod\":\"api_key\",\"apiProvider\":\"firstParty\"}}'");
        assert_eq!(claude(&json(true)), (Some(true), None));
        assert_eq!(claude(&format!("{}; exit 1", json(false))), (Some(false), None));
        assert_eq!(claude(&format!("{}; exit 1", json(true))), (None, Some("exit".into())), "a failing exit never says signed in");
        assert_eq!(claude(&json(false)), (None, Some("bad_answer".into())), "a pair never measured");
        assert_eq!(claude(&format!("{}; exit 2", json(false))), (None, Some("exit".into())));
        assert_eq!(claude("echo not json"), (None, Some("bad_answer".into())));
        fake("kiro-cli", "[ \"$1\" = whoami ] && { echo 'Not logged in'; exit 1; }; echo '{\"models\":[{\"model_id\":\"a\"}]}'");
        let args: Vec<String> = [nonce().as_str(), far.as_str(), overlay.as_str(), "kiro-test", "-"].iter().map(|x| x.to_string()).collect();
        let line = helper_frame(&args, &|_| false).unwrap();
        let Ok(Frame::KiroTest { whoami, models }) = parse_frame(&line, &nonce(), &Ask::KiroTest) else { panic!("{line}") };
        assert_eq!((whoami.signed_in, whoami.fail.as_deref()), (None, Some("exit")), "signed out was never measured");
        assert_eq!((models.answers, models.count), (Some(true), Some(1)));
        let (set_up, answers) = decide_test(&Ok(Frame::KiroTest { whoami, models }));
        assert_eq!(set_up, SetUp::unknown("cli_exit").by_cli());
        assert_eq!(answers["state"], "yes");
    }

    /// Orchestrator ruling on #492: a preparation that ran past the work's
    /// deadline starts no probe, and a `--version` starts nothing once the
    /// deadline has passed; the reply is the timed-out shape.
    #[test]
    fn a_refresh_past_its_deadline_starts_no_probe() {
        let t0 = Instant::now();
        let v = refresh(Instant::now() - Duration::from_millis(1));
        assert!(t0.elapsed() < Duration::from_secs(2), "nothing waited: {:?}", t0.elapsed());
        assert_eq!(v, refresh_timed_out());
        let dir = crate::config::fresh_process_dir("tmm-rdy-fixture-late");
        {
            use std::os::unix::fs::PermissionsExt;
            let p = dir.join("slow");
            std::fs::write(&p, "#!/bin/sh\necho started > \"$0.ran\"\necho 'slow 1.0'\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let got = installed("slow", &dir.to_string_lossy(), Instant::now() - Duration::from_millis(1));
        assert_eq!((got.state, got.reason.as_deref()), (State::Present, Some("version_timeout")));
        assert!(!dir.join("slow.ran").exists(), "the --version was never started");
    }

    /// Reviewer P1-B, round 3: the Refresh's own threads. A preparation
    /// that overran starts no version work; while a PATH walk is stuck, a
    /// second Refresh joins the SAME flight and starts no thread; once it is
    /// released and the work has ended, a Refresh runs fresh. One test, as
    /// the seams are process-wide.
    #[test]
    fn a_refresh_owns_its_threads_and_a_stuck_one_is_never_piled_on() {
        use std::sync::atomic::Ordering;
        static F: Flight = Flight::new();
        let spawns = || test_seam::SPAWNS.load(Ordering::SeqCst);
        let base = spawns();
        // (1) preparation delayed past the budget: no version work starts
        test_seam::PREP_DELAY_MS.store(400, Ordering::SeqCst);
        let t0 = Instant::now();
        assert_eq!(F.run(Duration::from_millis(300), refresh_timed_out, refresh), refresh_timed_out());
        assert!(t0.elapsed() < Duration::from_millis(390), "the caller answered at the deadline: {:?}", t0.elapsed());
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(spawns(), base, "an overrun preparation started no version thread");
        test_seam::PREP_DELAY_MS.store(0, Ordering::SeqCst);
        // (2) a PATH walk held: the first call times out, the work keeps
        // its threads, a second call joins and starts nothing
        test_seam::close();
        let t1 = Instant::now();
        assert_eq!(F.run(Duration::from_millis(300), refresh_timed_out, refresh), refresh_timed_out());
        assert!(t1.elapsed() < Duration::from_millis(390), "{:?}", t1.elapsed());
        let first_batch = spawns();
        assert_eq!(first_batch, base + Backend::ALL.len(), "one batch of version threads");
        let t2 = Instant::now();
        assert_eq!(F.run(Duration::from_millis(300), refresh_timed_out, refresh), refresh_timed_out());
        assert!(t2.elapsed() < Duration::from_millis(100), "past its deadline the stuck flight answers at once: {:?}", t2.elapsed());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(spawns(), first_batch, "no second batch while the first is stuck");
        assert!(F.slot.lock().unwrap().is_some(), "the stuck work still holds its flight");
        // (3) released: the work ends, its flight clears, a Refresh runs fresh
        test_seam::open();
        for _ in 0..100 {
            if F.slot.lock().unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(F.slot.lock().unwrap().is_none(), "the flight cleared when its work ended");
        let fresh = F.run(Duration::from_secs(5), refresh_timed_out, refresh);
        assert_eq!(spawns(), first_batch + Backend::ALL.len(), "a fresh run");
        assert_ne!(fresh["baseline"], "check_timeout", "{fresh}");
    }

    /// Reviewer P2 on #492 phase 1: a PANIC after the version threads exist
    /// does not detach them. The work still holds its flight until every
    /// thread has ended, a second Refresh meanwhile starts none, and the
    /// panic surfaces as the flight's `check_failed` once they are done.
    #[test]
    fn a_panic_after_the_spawn_keeps_the_threads_owned() {
        use std::sync::atomic::Ordering;
        static F: Flight = Flight::new();
        let spawns = || test_seam::SPAWNS.load(Ordering::SeqCst);
        test_seam::close();
        test_seam::PANIC_AFTER_SPAWN.store(true, Ordering::SeqCst);
        let base = spawns();
        assert_eq!(F.run(Duration::from_millis(300), refresh_timed_out, refresh), refresh_timed_out());
        assert_eq!(spawns(), base + Backend::ALL.len());
        std::thread::sleep(Duration::from_millis(150));
        assert!(F.slot.lock().unwrap().is_some(), "the panicked work still holds its flight while its threads run");
        assert_eq!(F.run(Duration::from_millis(300), refresh_timed_out, refresh), refresh_timed_out());
        assert_eq!(spawns(), base + Backend::ALL.len(), "no second batch");
        test_seam::open();
        for _ in 0..100 {
            if F.slot.lock().unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(F.slot.lock().unwrap().is_none(), "the flight cleared once the threads ended");
        assert_eq!(spawns(), base + Backend::ALL.len());
    }

    /// Control (b), made reachable without a production seam (reviewer,
    /// round 3): a flight whose answer was stored AFTER its deadline,
    /// joined through the real `Flight::run`, answers the caller's own
    /// timed-out value.
    #[test]
    fn a_late_answer_never_replaces_the_timed_out_reply() {
        static F: Flight = Flight::new();
        let deadline = Instant::now() - Duration::from_millis(10);
        let late = std::sync::Arc::new(Shared {
            deadline,
            done: std::sync::Mutex::new(Some((json!({ "late": true }), deadline + Duration::from_millis(5)))),
            ready: std::sync::Condvar::new(),
        });
        *F.slot.lock().unwrap() = Some(late);
        assert_eq!(F.run(Duration::from_secs(1), || json!({ "timed_out": true }), |_| json!({ "ran": true })), json!({ "timed_out": true }));
        let on_time = std::sync::Arc::new(Shared {
            deadline,
            done: std::sync::Mutex::new(Some((json!({ "on_time": true }), deadline))),
            ready: std::sync::Condvar::new(),
        });
        *F.slot.lock().unwrap() = Some(on_time);
        assert_eq!(F.run(Duration::from_secs(1), || json!({ "timed_out": true }), |_| json!({ "ran": true })), json!({ "on_time": true }));
        F.slot.lock().unwrap().take();
    }

    #[test]
    fn a_scratch_dir_is_private_and_gone_on_drop() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new().unwrap();
        let dir = s.path().to_path_buf();
        let f = s.write("settings.json", "{}").unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        drop(s);
        assert!(!dir.exists());
    }
}
