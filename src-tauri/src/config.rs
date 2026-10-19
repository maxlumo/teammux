use serde::Deserialize;
use serde_json;
use std::path::PathBuf;

#[derive(Deserialize, Default, Clone)]
struct FileConfig {
    host: Option<String>,
    port: Option<u16>,
    token: Option<String>,
    tmux_socket: Option<String>,
    tls_cert: Option<String>,
    tls_key: Option<String>,
    scrollback: Option<usize>,
    // Seconds to wait after the last client on a resized tmux window
    // disconnects before restoring that window to auto-size. 0 = restore
    // immediately (legacy behavior). Default 600 (10 min) so short
    // reconnects (backgrounded app, network blip) skip the reflow cycle.
    disconnect_grace_secs: Option<u64>,
    // The kiro-cli agent engine managed kiro agents launch with: "v2" (the
    // CLI's default, ours too) or "v3" (kiro-cli 2.22.1's KAS engine). Read
    // at spawn and at every refresh; an agent takes it at its next restart
    // (board #207).
    kiro_engine: Option<String>,
    // A built web UI directory (`dist/`) the gateway serves on its own port
    // (board #323). Absolute. Unset: the UI embedded in the binary (feature
    // `embed-ui`), else none. Read from config.toml only.
    ui_dir: Option<String>,
    // Bring back, at gateway start, the sessions and agents a host reboot
    // took down (board #422). Default false until the live acceptance of
    // round 4; read once per start (and per decision a capture tick needs).
    restore_on_start: Option<bool>,
}

#[derive(Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub machine_id: String,
    pub tmux_socket: Option<String>,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub scrollback: usize,
    pub disconnect_grace_secs: u64,
    pub kiro_engine: String,
    pub ui_dir: Option<String>,
}

/// `restore_on_start` in config.toml (board #422), side-effect free; false
/// when unset or unreadable.
pub fn restore_on_start() -> bool {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| toml::from_str::<FileConfig>(&t).ok())
        .and_then(|c| c.restore_on_start)
        .unwrap_or(false)
}

/// The kiro engine door, side-effect free (no token/machine-id seeding — the
/// backend reads it at spawn/refresh time): `KIRO_ENGINE` env, else
/// `kiro_engine` in config.toml, else "v2". Anything but v2/v3 is v2 with a
/// note on stderr.
pub fn kiro_engine() -> String {
    let raw = std::env::var("KIRO_ENGINE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(config_path())
                .ok()
                .and_then(|t| toml::from_str::<FileConfig>(&t).ok())
                .and_then(|c| c.kiro_engine)
        })
        .unwrap_or_default();
    normalize_engine(&raw)
}

pub fn normalize_engine(raw: &str) -> String {
    match raw.trim() {
        "" | "v2" => "v2".into(),
        "v3" => "v3".into(),
        other => {
            eprintln!("config: kiro_engine {other:?} is not v2|v3 — using v2");
            "v2".into()
        }
    }
}

/// Parse `text` as config.toml with the ONE schema `Config::load` reads
/// (board #323: `tmm setup` writes through this, never a second schema).
/// Unknown keys are allowed, as they always were.
///
/// The error NEVER quotes the file: toml's own message prints the offending
/// line, and that line may hold the token (board #323 review). Only the
/// kind of problem and where it is.
pub fn validate_file(text: &str) -> Result<(), String> {
    toml::from_str::<FileConfig>(text).map(|_| ()).map_err(|e| {
        let at = e.span().map(|r| {
            let before = &text[..r.start.min(text.len())];
            let line = before.matches('\n').count() + 1;
            let col = before.rsplit('\n').next().map(|l| l.chars().count()).unwrap_or(0) + 1;
            format!(" at line {line}, column {col}")
        }).unwrap_or_default();
        let kind = if text.parse::<toml::Table>().is_err() { "not valid TOML" } else { "a value of the wrong type or out of range" };
        format!("{kind}{at}")
    })
}

/// Where config.toml lives.
pub fn config_file() -> PathBuf {
    config_path()
}

fn config_path() -> PathBuf {
    dirs_next().join("config.toml")
}

/// The tmux-mobile config directory (`~/.config/tmux-mobile`).
pub fn config_dir() -> PathBuf {
    dirs_next()
}

#[cfg(not(test))]
fn dirs_next() -> PathBuf {
    // Follow the XDG Base Directory convention: $XDG_CONFIG_HOME if set,
    // else ~/.config. App state lives under the `tmux-mobile/` subdir.
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("tmux-mobile")
}

/// The unit-test process never sees the operator's config directory. Every
/// `config_dir()` consumer (config.toml, AGENTS.md, the hooks helper,
/// skills-cache, the default state.db) resolves to ONE empty temp directory
/// created once per test process — so a test cannot forget to isolate
/// itself, and the file defaults (`kiro_engine` = v2, no AGENTS.md, …) are
/// what every test measures. Per-test opt-in had already failed once (the
/// spawn tests once pointed the whole process at the real state.db, see
/// `projects::tests::use_test_store`), and it failed again when the live
/// `kiro_engine = "v3"` turned three v2-default assertions red on this host
/// (board #216, 2026-09-20). Tests that WRITE config files use their own
/// subdirectory under this one, not its root.
#[cfg(test)]
fn dirs_next() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| fresh_process_dir("tmm-config-test")).clone()
}

/// Test support, shared by the lib tests and the integration crate (boards
/// #216, #268): a fresh, empty `<temp>/<prefix>-<pid>` for THIS process. The
/// name is per process so concurrent cargo runs never share (or wipe) one;
/// but a process-wide directory is held for the whole run and has no drop to
/// remove it, so it is reclaimed at the door instead: every
/// `<prefix>-<n>` sibling whose process `n` is gone is removed first. A live
/// process's directory is never touched; a reused pid only keeps an old
/// directory one run longer.
#[doc(hidden)]
pub fn fresh_process_dir(prefix: &str) -> PathBuf {
    let tmp = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let pid = name
                .to_str()
                .and_then(|n| n.strip_prefix(prefix))
                .and_then(|n| n.strip_prefix('-'))
                .and_then(|n| n.parse::<libc::pid_t>().ok());
            if pid.is_some_and(|pid| !process_alive(pid)) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let dir = tmp.join(format!("{prefix}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the per-process test dir");
    dir
}

/// `kill(pid, 0)`: alive, or alive but not ours (EPERM). Nonsense pids count
/// as alive so they are never reclaimed.
fn process_alive(pid: libc::pid_t) -> bool {
    if pid <= 0 {
        return true;
    }
    // SAFETY: signal 0 performs only the existence and permission check.
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn optional_env_override(value: Option<String>, fallback: Option<String>) -> Option<String> {
    match value {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value),
        None => fallback,
    }
}

/// The environment variables that override config.toml (`Config::load`).
pub const ENV_OVERRIDES: &[&str] = &["HOST", "PORT", "TOKEN", "TMUX_SOCKET", "TLS_CERT", "TLS_KEY", "SCROLLBACK", "DISCONNECT_GRACE_SECS", "KIRO_ENGINE"];

impl Config {
    /// Where a client on THIS machine reaches the gateway this config
    /// describes — the ONE rule (board #323): a wildcard bind (`0.0.0.0`,
    /// `::`) on the matching loopback, a specific address on itself (IPv6
    /// in brackets), `wss` when both TLS files are set. The gateway probe,
    /// `tmm ui` and the desktop app's first address all use it.
    pub fn local_url(&self) -> String {
        let host = match self.host.trim() {
            "" | "0.0.0.0" => "127.0.0.1".to_string(),
            "::" | "[::]" => "[::1]".to_string(),
            h if h.contains(':') && !h.starts_with('[') => format!("[{h}]"),
            h => h.to_string(),
        };
        let scheme = if self.tls_cert.is_some() && self.tls_key.is_some() { "wss" } else { "ws" };
        format!("{scheme}://{host}:{}", self.port)
    }

    /// Load config: file < env vars. Auto-generates token if missing everywhere.
    pub fn load() -> Self {
        Self::load_with(&|k| std::env::var(k).ok())
    }

    /// What the installed gateway service runs with (board #323): config.toml
    /// ALONE — `tmm gateway start --service` loads this, so whatever the user
    /// manager's environment holds, the service and `tmm gateway status`
    /// read the same thing. Creates a token / machine id on a first start,
    /// as any start does.
    pub fn load_service() -> Self {
        Self::load_with(&|_| None)
    }

    /// The same file-only view, READ-ONLY: nothing is created (no token, no
    /// machine id), so `status` never makes a machine look configured. A
    /// missing token or id is empty.
    pub fn peek_service() -> Self {
        Self::peek_at(&dirs_next())
    }

    fn peek_at(dir: &std::path::Path) -> Self {
        let file_cfg = std::fs::read_to_string(dir.join("config.toml"))
            .ok()
            .and_then(|s| toml::from_str::<FileConfig>(&s).ok())
            .unwrap_or_default();
        let machine_id = std::fs::read_to_string(dir.join("machine_id")).map(|s| s.trim().to_string()).unwrap_or_default();
        Self::from_parts(&|_| None, file_cfg, String::new(), machine_id)
    }

    fn load_with(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let file_cfg = std::fs::read_to_string(config_path())
            .ok()
            .and_then(|s| toml::from_str::<FileConfig>(&s).ok())
            .unwrap_or_default();

        let token = env("TOKEN")
            .or(file_cfg.token.clone())
            .unwrap_or_else(|| {
                let t = uuid::Uuid::new_v4().to_string();
                let _ = save_token(&t);
                t
            });

        Self::from_parts(env, file_cfg, token, load_or_create_machine_id())
    }

    fn from_parts(env: &dyn Fn(&str) -> Option<String>, file_cfg: FileConfig, token: String, machine_id: String) -> Self {
        let token = if token.is_empty() { env("TOKEN").or(file_cfg.token.clone()).unwrap_or_default() } else { token };
        Config {
            host: env("HOST")
                .or(file_cfg.host)
                .unwrap_or("0.0.0.0".into()),
            port: env("PORT")
                .and_then(|p| p.parse().ok())
                .or(file_cfg.port)
                .unwrap_or(9899),
            token,
            machine_id,
            tmux_socket: env("TMUX_SOCKET").or(file_cfg.tmux_socket),
            tls_cert: optional_env_override(env("TLS_CERT"), file_cfg.tls_cert),
            tls_key: optional_env_override(env("TLS_KEY"), file_cfg.tls_key),
            scrollback: env("SCROLLBACK")
                .and_then(|s| s.parse().ok())
                .or(file_cfg.scrollback)
                .unwrap_or(500),
            disconnect_grace_secs: env("DISCONNECT_GRACE_SECS")
                .and_then(|s| s.parse().ok())
                .or(file_cfg.disconnect_grace_secs)
                .unwrap_or(600),
            kiro_engine: normalize_engine(
                &env("KIRO_ENGINE").or(file_cfg.kiro_engine).unwrap_or_default(),
            ),
            ui_dir: file_cfg.ui_dir.filter(|d| !d.trim().is_empty()),
        }
    }
}

fn load_or_create_machine_id() -> String {
    let path = dirs_next().join("machine_id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() { return id; }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(dirs_next());
    let _ = std::fs::write(&path, &id);
    id
}

fn save_token(token: &str) -> std::io::Result<()> {
    let dir = dirs_next();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("config.toml");
    // Read existing or start fresh
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    if content.contains("token") {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("token = \"{}\"\n", token));
    std::fs::write(&path, content)?;
    // The token is a session-wide secret; any local user who can read
    // this file can impersonate the owner. Tighten to 0600 so cohabiting
    // accounts (shared Macs, multi-user Linux) can't trivially pick it up.
    // We only set perms when we're the writer — we do NOT tighten existing
    // files to avoid surprising users who intentionally relaxed them.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Tighten permissions on existing config.toml if we can. Safe to call on
/// every startup: no-op on non-unix; no-op if file absent; clamps to 0600
/// otherwise. This is a belt-and-braces measure for configs written by
/// older versions (pre-hardening) or by a manual edit that widened perms.
#[cfg(unix)]
pub fn harden_config_perms() {
    harden_path_0600(&config_path());
}
#[cfg(not(unix))]
pub fn harden_config_perms() {}

/// Clamp `path`'s mode to 0600 if any group/other bits are set. No-op on
/// non-unix. Extracted so it can be unit-tested without touching
/// `~/.config/tmux-mobile`.
#[cfg(unix)]
fn harden_path_0600(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}
#[cfg(not(unix))]
#[allow(dead_code)]
fn harden_path_0600(_path: &std::path::Path) {}

#[cfg(all(test, unix))]
mod tests {

    /// Board #323: the service view reads config.toml ALONE (the environment
    /// is never consulted), and the read-only view creates nothing.
    #[test]
    fn the_service_view_ignores_the_environment_and_peeking_creates_nothing() {
        let env = |k: &str| match k { "PORT" => Some("1".to_string()), "HOST" => Some("9.9.9.9".to_string()), "TOKEN" => Some("from-env".to_string()), _ => None };
        let file = FileConfig { port: Some(19877), host: Some("127.0.0.1".into()), token: Some("from-file".into()), ..Default::default() };
        let svc = Config::from_parts(&|_| None, file.clone(), String::new(), "m".into());
        assert_eq!((svc.port, svc.host.as_str(), svc.token.as_str()), (19877, "127.0.0.1", "from-file"));
        let shell = Config::from_parts(&env, file, String::new(), "m".into());
        assert_eq!((shell.port, shell.host.as_str(), shell.token.as_str()), (1, "9.9.9.9", "from-env"), "an interactive load still honours overrides");
        // peek: nothing written where nothing existed; a file is read as is.
        let dir = dirs_next().join("peek-323");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = Config::peek_at(&dir);
        assert!(p.token.is_empty() && p.machine_id.is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "status never configures a machine");
        std::fs::write(dir.join("config.toml"), "port = 19878\ntoken = \"t\"\n").unwrap();
        std::fs::write(dir.join("machine_id"), "mid\n").unwrap();
        let p = Config::peek_at(&dir);
        assert_eq!((p.port, p.token.as_str(), p.machine_id.as_str()), (19878, "t", "mid"));
    }

    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_CTR: AtomicUsize = AtomicUsize::new(0);

    fn mkfile(mode: u32) -> std::path::PathBuf {
        let n = TEST_CTR.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir()
            .join(format!("tmux_mobile_cfg_test_{}_{}", std::process::id(), n));
        std::fs::write(&p, b"token = \"x\"\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    #[test]
    fn harden_tightens_0644_to_0600() {
        let p = mkfile(0o644);
        harden_path_0600(&p);
        let m = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600, "expected 0600, got {:o}", m);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn harden_leaves_0600_alone() {
        let p = mkfile(0o600);
        harden_path_0600(&p);
        let m = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_dead_process_dir_is_reclaimed_and_a_live_one_kept() {
        let prefix = "tmm-reclaim-test";
        let mut dead = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = dead.id();
        dead.wait().unwrap(); // exited and reaped: kill(pid, 0) says ESRCH
        let mut live = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let tmp = std::env::temp_dir();
        let dead_dir = tmp.join(format!("{prefix}-{dead_pid}"));
        let live_dir = tmp.join(format!("{prefix}-{}", live.id()));
        let other = tmp.join(format!("{prefix}-notapid"));
        for d in [&dead_dir, &live_dir, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        let own = fresh_process_dir(prefix);
        assert_eq!(own, tmp.join(format!("{prefix}-{}", std::process::id())));
        assert!(own.is_dir() && std::fs::read_dir(&own).unwrap().next().is_none(), "own dir is fresh and empty");
        assert!(!dead_dir.exists(), "a dead process's dir is reclaimed");
        assert!(live_dir.exists(), "a live process's dir is never touched");
        assert!(other.exists(), "a non-pid suffix is not ours to judge");
        let _ = live.kill();
        let _ = live.wait();
        for d in [&own, &live_dir, &other] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn harden_on_missing_file_is_noop() {
        let p = std::env::temp_dir().join("tmux_mobile_cfg_test_nonexistent");
        let _ = std::fs::remove_file(&p);
        harden_path_0600(&p); // must not panic
    }

    #[test]
    fn empty_optional_env_value_disables_file_fallback() {
        let fallback = Some("configured.pem".to_string());
        assert_eq!(
            optional_env_override(Some(String::new()), fallback.clone()),
            None
        );
        assert_eq!(optional_env_override(None, fallback.clone()), fallback);
        assert_eq!(
            optional_env_override(Some("override.pem".to_string()), None),
            Some("override.pem".to_string()),
        );
    }
}

/// Bookmarks: read/write ~/.config/tmux-mobile/bookmarks.json
fn bookmarks_path() -> std::path::PathBuf {
    dirs_next().join("bookmarks.json")
}

pub fn get_bookmarks() -> Vec<String> {
    std::fs::read_to_string(bookmarks_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub fn save_bookmarks(bookmarks: &[String]) -> Result<(), String> {
    let dir = dirs_next();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(bookmarks).map_err(|e| e.to_string())?;
    std::fs::write(bookmarks_path(), json).map_err(|e| e.to_string())
}

/// User preferences: synced key-value store at ~/.config/tmux-mobile/prefs.json
fn prefs_path() -> std::path::PathBuf {
    dirs_next().join("prefs.json")
}

pub fn get_prefs() -> serde_json::Value {
    std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}))
}

pub fn set_prefs(key: &str, value: serde_json::Value) -> Result<(), String> {
    let dir = dirs_next();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut prefs: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    prefs.insert(key.to_string(), value);
    let json = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(prefs_path(), json).map_err(|e| e.to_string())
}

/// Tauri command: return config for frontend auto-fill
pub fn get_config_json() -> serde_json::Value {
    let cfg = Config::load();
    serde_json::json!({
        "host": cfg.host,
        "port": cfg.port,
        "token": cfg.token,
        "tmux_socket": cfg.tmux_socket,
        // The desktop app's first address (board #323): the same rule the
        // gateway probe dials, so bind address, IPv6 and TLS agree.
        "url": cfg.local_url(),
    })
}

/// Per-session "last opened in tmux-mobile" timestamp store.
/// Persisted to ~/.config/tmux-mobile/session_usage.json as a name → unix-seconds map.
/// Used by the Sessions page to sort recently-used sessions to the top.
fn session_usage_path() -> std::path::PathBuf {
    dirs_next().join("session_usage.json")
}

pub fn get_session_usage() -> std::collections::HashMap<String, u64> {
    std::fs::read_to_string(session_usage_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn touch_session(name: &str) -> Result<(), String> {
    let dir = dirs_next();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut map = get_session_usage();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    map.insert(name.to_string(), now);
    let json = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    std::fs::write(session_usage_path(), json).map_err(|e| e.to_string())
}


#[cfg(test)]
mod engine_tests {
    use super::normalize_engine;
    /// Board #207: the kiro engine door has two positions; anything else is the default.
    #[test]
    fn engine_door_is_v2_or_v3() {
        assert_eq!(normalize_engine(""), "v2");
        assert_eq!(normalize_engine("v2"), "v2");
        assert_eq!(normalize_engine(" v3 "), "v3");
        assert_eq!(normalize_engine("v1"), "v2", "v1 is not offered: v2");
        assert_eq!(normalize_engine("kas"), "v2");
    }
}
