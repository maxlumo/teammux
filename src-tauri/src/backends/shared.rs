//! Backend-neutral launch helpers shared by every agent launcher.
//!
//! Mechanical move from `team/backends.rs` + `team/launch.rs` (board #100,
//! 2026-09-09) — content unchanged. These are the pieces the agents-v2 spawn
//! path (projects/spawn.rs, projects/reconcile.rs) borrows: MCP config
//! rendering per backend, shell quoting, the launch-script pattern (the 2KB
//! tty swallow lesson, 2026-07-23), PATH assembly for supervised servers, and
//! first-run startup-prompt auto-confirmation.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::tmux;

/// An extra MCP server attached to an agent (from the registry `mcp` defs).
/// Either a remote HTTP server (`url` [+ `headers`]) or a local stdio server
/// (`command` [+ `args`/`env`]).
#[derive(serde::Deserialize, Default, Clone)]
pub(crate) struct McpDef {
    /// serde default: central reg_mcp defs store the name as the table KEY,
    /// not inside the JSON — the spawn resolver injects it after parsing.
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) env: std::collections::BTreeMap<String, String>,
}

pub(crate) fn env_reference(value: &str) -> Option<&str> {
    let name = value
        .strip_prefix("${")
        .and_then(|s| s.strip_suffix('}'))
        .or_else(|| value.strip_prefix('$'))?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        Some(name)
    } else {
        None
    }
}

pub(crate) fn header_env_reference(value: &str) -> Option<(&str, bool)> {
    if let Some(name) = value.strip_prefix("Bearer ").and_then(env_reference) {
        Some((name, true))
    } else {
        env_reference(value).map(|name| (name, false))
    }
}

fn interpolated_headers(headers: &std::collections::BTreeMap<String, String>) -> Value {
    let values: std::collections::BTreeMap<String, String> = headers
        .iter()
        .map(|(key, value)| {
            let value = match header_env_reference(value) {
                Some((name, true)) => format!("Bearer ${{{name}}}"),
                Some((name, false)) => format!("${{{name}}}"),
                None => value.clone(),
            };
            (key.clone(), value)
        })
        .collect();
    serde_json::to_value(values).unwrap_or(Value::Null)
}

/// kiro mcpServers entry: remote = `{url,headers}`, local = `{command,args,env}`.
pub(crate) fn kiro_mcp_value(m: &McpDef) -> Value {
    if let Some(url) = &m.url {
        let mut o = serde_json::json!({ "url": url });
        if !m.headers.is_empty() {
            o["headers"] = interpolated_headers(&m.headers);
        }
        o
    } else if let Some(cmd) = &m.command {
        let mut o = serde_json::json!({ "command": cmd, "args": m.args });
        if !m.env.is_empty() {
            o["env"] = serde_json::to_value(&m.env).unwrap_or(Value::Null);
        }
        o
    } else {
        serde_json::json!({})
    }
}

/// claude mcpServers entry: remote gets explicit `type:"http"`.
pub(crate) fn claude_mcp_value(m: &McpDef) -> Value {
    if let Some(url) = &m.url {
        let mut o = serde_json::json!({ "type": "http", "url": url });
        if !m.headers.is_empty() {
            o["headers"] = serde_json::to_value(&m.headers).unwrap_or(Value::Null);
        }
        o
    } else {
        kiro_mcp_value(m) // local stdio form is identical
    }
}

pub(crate) fn codex_config_override(key: &str, value: Value) -> String {
    let assignment = format!("{}={}", key, serde_json::to_string(&value).unwrap());
    format!("-c {}", crate::shell::quote(&assignment))
}

/// The managed codex profile's name (board #448): `--profile tmm-agent`
/// layers `<CODEX_HOME>/tmm-agent.config.toml` over the user's config.toml
/// (codex docs, Advanced Configuration § profiles, 0.134.0 and later).
pub(crate) const CODEX_PROFILE: &str = "tmm-agent";

/// The file `CODEX_PROFILE` names in a codex home. Ours only: the user's
/// `*.config.toml` inheritance skips it.
pub(crate) fn codex_profile_file() -> String {
    format!("{CODEX_PROFILE}.config.toml")
}

/// The managed codex profile (board #448; model and effort since #455): the
/// definition's IDENTITY and MCP servers as one structural TOML document,
/// written privately into the home, so neither a value nor the model rides
/// the launch line (non-negotiable 10).
///
/// `model` and `model_reasoning_effort` are top-level keys, omitted when the
/// definition leaves them empty: "not set at this layer", and codex's own
/// config and resume rules decide (measured on 0.162.1, #455: a resumed
/// session restores its own last pair when the profile names neither, and
/// takes the configured values for both when it names either). The MCP
/// servers are `[mcp_servers.<name>]` tables, keeping the old `-c` form's
/// semantics per field: stdio `command`, `args` and `env` (a literal table);
/// http `url`, `enabled`, `experimental_use_rmcp_client`, an
/// `Authorization: Bearer $VAR` header as `bearer_token_env_var`, a `$VAR`
/// header as `env_http_headers`, a literal header as `http_headers`. Always a
/// whole document: a revoked server, a cleared model, or a person's `/model`
/// default (which codex writes into this file) never survives a render.
pub(crate) fn codex_profile(defs: &[McpDef], model: &str, effort: &str) -> String {
    use toml::Value as T;
    let mut servers = toml::map::Map::new();
    for m in defs.iter().filter(|m| !m.name.is_empty()) {
        let mut t = toml::map::Map::new();
        if let Some(url) = &m.url {
            t.insert("url".into(), T::String(url.clone()));
            t.insert("enabled".into(), T::Boolean(true));
            t.insert("experimental_use_rmcp_client".into(), T::Boolean(true));
            let (mut env_headers, mut headers) = (toml::map::Map::new(), toml::map::Map::new());
            for (key, value) in &m.headers {
                match header_env_reference(value) {
                    Some((name, true)) if key.eq_ignore_ascii_case("authorization") => {
                        t.insert("bearer_token_env_var".into(), T::String(name.to_string()));
                    }
                    Some((name, false)) => {
                        env_headers.insert(key.clone(), T::String(name.to_string()));
                    }
                    _ => {
                        headers.insert(key.clone(), T::String(value.clone()));
                    }
                }
            }
            if !env_headers.is_empty() {
                t.insert("env_http_headers".into(), T::Table(env_headers));
            }
            if !headers.is_empty() {
                t.insert("http_headers".into(), T::Table(headers));
            }
        } else if let Some(cmd) = &m.command {
            t.insert("command".into(), T::String(cmd.clone()));
            if !m.args.is_empty() {
                t.insert("args".into(), T::Array(m.args.iter().map(|a| T::String(a.clone())).collect()));
            }
            if !m.env.is_empty() {
                t.insert("env".into(), T::Table(m.env.iter().map(|(k, v)| (k.clone(), T::String(v.clone()))).collect()));
            }
        } else {
            continue;
        }
        servers.insert(m.name.clone(), T::Table(t));
    }
    let mut doc = toml::map::Map::new();
    if !model.trim().is_empty() {
        doc.insert("model".into(), T::String(model.trim().to_string()));
    }
    if !effort.trim().is_empty() {
        doc.insert("model_reasoning_effort".into(), T::String(effort.trim().to_string()));
    }
    if !servers.is_empty() {
        doc.insert("mcp_servers".into(), T::Table(servers));
    }
    let body = toml::to_string(&T::Table(doc)).unwrap_or_default();
    format!("# Teammux managed codex profile (regenerated on every launch; boards #448, #455)\n{body}")
}

/// Keep the managed home's runtime state isolated while sharing the system
/// Codex provider and login. Links follow config/token refreshes without
/// copying credentials. The system home is `codex::codex_user_home` — under
/// test a per-process temp dir, so a render test never links the developer's
/// real `~/.codex` (board #216, #231).
pub(crate) fn inherit_codex_system_files(home: &Path) -> Result<(), String> {
    inherit_codex_system_files_from(home, &super::codex::codex_user_home())
}

/// Replace `path` WHOLE and PRIVATELY (board #448): a reader sees all of the
/// old file or all of the new (board #411: dsh reads its profile at the start
/// of every turn), and on Unix the file is published by
/// `safe_fs::write_private` — its directory held and 0700, the file 0600
/// from its first byte, a symlink or another user's file at the target an
/// error. Every file a render writes into an agent home goes through here,
/// because any of them may carry a definition's MCP env or header value.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    #[cfg(unix)]
    return crate::safe_fs::write_private(path, text);
    #[cfg(not(unix))]
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let tmp = path.with_file_name(format!(".{name}.tmp-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&tmp, text)
            .and_then(|_| std::fs::rename(&tmp, path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("{}: {e}", path.display())
            })
    }
}

/// Copy a user file into an agent home PRIVATELY (board #448): read, then
/// published like every other home file. `std::fs::copy` kept the source's
/// mode and followed a link at the destination.
pub(crate) fn copy_private(from: &Path, to: &Path) -> Result<(), String> {
    let bytes = std::fs::read(from).map_err(|e| format!("{}: {e}", from.display()))?;
    #[cfg(unix)]
    return crate::safe_fs::write_private_bytes(to, &bytes);
    #[cfg(not(unix))]
    return std::fs::write(to, bytes).map_err(|e| format!("{}: {e}", to.display()));
}

/// A config file the render OWNS: `Some` writes it (`write_atomic`, private),
/// `None` removes it. A home is re-rendered on every spawn, so "nothing to
/// declare" must leave nothing behind; skipping the write kept the previous
/// render's file, and the CLI kept loading a revoked MCP server or an
/// unpinned model (#241, validator).
pub(crate) fn write_owned(path: &Path, content: Option<&str>) -> Result<(), String> {
    match content {
        Some(text) => write_atomic(path, text),
        #[cfg(unix)]
        None => crate::safe_fs::remove_private(path),
        #[cfg(not(unix))]
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        },
    }
}

/// One link of the user's codex file `filename` into the held home
/// directory (board #448: every step relative to the one `Dir` walked from
/// the project entry, never by pathname, so a link inside the home cannot
/// redirect the change to an outside directory). `replace_team_owned`: a
/// file or link of ours by that name may be replaced; otherwise an
/// existing entry is refused.
#[cfg(unix)]
fn link_codex_system_file(home: &crate::safe_fs::Dir, system_home: &Path, filename: &str, replace_team_owned: bool) -> Result<(), String> {
    use crate::safe_fs::{euid, is_file};
    let entry = |st: &libc::stat| st.st_mode & libc::S_IFMT == libc::S_IFLNK || is_file(st);
    let existing = home.stat_at(filename).map_err(|e| format!("{filename}: {e}"))?;
    let source = system_home.join(filename);
    if !source.is_file() {
        if replace_team_owned {
            match existing {
                Some(st) if entry(&st) && st.st_uid == euid() => home.unlink(filename).map_err(|e| format!("{filename}: {e}"))?,
                Some(_) => return Err(format!("refusing to replace Codex path: {filename}")),
                None => {}
            }
        }
        return Ok(());
    }
    let source = std::fs::canonicalize(source).map_err(|e| e.to_string())?;
    if let Some(st) = existing {
        if st.st_mode & libc::S_IFMT == libc::S_IFLNK && home.read_link(filename).is_ok_and(|p| p == source) {
            return Ok(());
        }
        if replace_team_owned && entry(&st) && st.st_uid == euid() {
            home.unlink(filename).map_err(|e| format!("{filename}: {e}"))?;
        } else {
            return Err(format!("refusing to replace existing Codex path: {filename}"));
        }
    }
    home.symlink(&source, filename)
        .map_err(|e| format!("failed to inherit Codex system file from {}: {e}", source.display()))
}

#[cfg(unix)]
fn inherit_codex_system_files_from(home: &Path, system_home: &Path) -> Result<(), String> {
    // The codex home, held through the private walk from the project entry
    // BEFORE anything in it changes (board #448 P1-A residual).
    let dir = crate::safe_fs::private_subdir(home).map_err(|e| format!("{}: {e}", home.display()))?;
    // config.toml in the private home was generated by us before MCP settings
    // moved to CLI overrides, so it is the one path we may replace.
    link_codex_system_file(&dir, system_home, "config.toml", true)?;
    link_codex_system_file(&dir, system_home, ".env", false)?;
    link_codex_system_file(&dir, system_home, "auth.json", false)?;
    // Profile layers (`codex --profile <name>` reads `<name>.config.toml`).
    // A machine whose codex auth lives in a profile (e.g. a Bedrock provider
    // with the bearer token in .env, no ChatGPT login) needs these in the
    // isolated home or the agent boots into the sign-in screen.
    if let Ok(entries) = std::fs::read_dir(system_home) {
        for entry in entries.flatten() {
            let filename = entry.file_name();
            let name = filename.to_string_lossy();
            // The managed profile (board #448) is never a user's: a user
            // file of the same name stays where it is, unread.
            if name.ends_with(".config.toml") && name != codex_profile_file() && entry.path().is_file() {
                link_codex_system_file(&dir, system_home, &name, true)?;
            }
        }
    }
    // A LINK by that name, made by an older inheritance, is removed itself
    // (never followed); its target, the user's file, is untouched. A regular
    // file there is ours and the render replaces it.
    let ours = codex_profile_file();
    if dir.stat_at(&ours).map_err(|e| format!("{ours}: {e}"))?.is_some_and(|st| st.st_mode & libc::S_IFMT == libc::S_IFLNK) {
        dir.unlink(&ours).map_err(|e| format!("{ours}: {e}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn inherit_codex_system_files_from(home: &Path, system_home: &Path) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    for name in ["config.toml", ".env", "auth.json"] {
        let source = system_home.join(name);
        let target = home.join(name);
        if source.is_file() && std::fs::symlink_metadata(&target).is_err() {
            symlink_file(&std::fs::canonicalize(source).map_err(|e| e.to_string())?, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn symlink_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, target)
}

fn read_json_or_empty(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The `env` block of parsed Claude settings when it is an object, else an
/// empty one (model discovery reads the carried env through this).
pub(crate) fn claude_env_of(settings: &Value) -> Value {
    settings.get("env").cloned().filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}))
}

/// Claude Code's documented credential COMMANDS (settings reference, read
/// 2026-11-05 for 2.1.318): `apiKeyHelper` "Generate the API credential with
/// your own command", `awsAuthRefresh` "Refresh expired Bedrock credentials",
/// `awsCredentialExport` "Supply Bedrock credentials as JSON", `gcpAuthRefresh`
/// "Refresh Google Cloud credentials". `apiKeyHelper` is the measured one
/// (board #2: without it an interactive managed Claude is "Not logged in").
/// `forceLoginMethod` (a login restriction) and `otelHeadersHelper`
/// (telemetry) are not credentials and stay behind.
pub(crate) const CLAUDE_AUTH_KEYS: &[&str] = &["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];

/// What a managed Claude home carries from parsed user settings: the `env`
/// block (the provider channel) plus each string-valued `CLAUDE_AUTH_KEYS`
/// entry. Auth carries, prefs do not. The ONE definition for the renderer,
/// the start-time backfill and backend readiness (board #492, #2).
pub(crate) fn claude_carry_of(settings: &Value) -> Value {
    let mut carry = serde_json::Map::new();
    carry.insert("env".into(), claude_env_of(settings));
    for key in CLAUDE_AUTH_KEYS {
        if let Some(v) = settings.get(*key).filter(|v| v.is_string()) {
            carry.insert((*key).into(), v.clone());
        }
    }
    Value::Object(carry)
}

/// `claude_carry_of` the user's Claude settings (absent or invalid: env only,
/// empty).
pub(crate) fn claude_user_carry() -> Value {
    claude_carry_of(&read_json_or_empty(&claude_user_settings()))
}

/// The user's Claude settings file: the ONE path the renderer carries from
/// and model discovery reads (board #511).
#[cfg(not(test))]
pub(crate) fn claude_user_settings() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude")
        .join("settings.json")
}

/// Under test the user's Claude home is a per-process temp dir (the kimi,
/// grok and codex pattern, board #515): a render or a model list never reads
/// the developer's real `~/.claude/settings.json`.
#[cfg(test)]
pub(crate) fn claude_user_settings() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-claude-user-home")).join(".claude").join("settings.json")
}

/// Claude Code's official statusLine extension point. The colocated `tmm`
/// command reads Claude's JSON stdin and prints the one canonical row that the
/// pane sniffer recognizes; no jq/Python dependency and no API/token cost.
pub(crate) fn claude_status_line_config() -> Value {
    serde_json::json!({
        "type": "command",
        "command": "tmm claude-statusline"
    })
}

/// Build the PATH used by managed agent launch scripts. The server is often
/// supervised with a deliberately small service PATH, while user-installed
/// CLIs (`claude`, `uvx`, cargo tools) live under the standard per-user bin
/// directories. A launch recipe must be self-sufficient: inheriting only the
/// server PATH made a configured Claude agent open a shell and fail with
/// `command not found: claude`.
fn agent_launch_path_from(home: Option<&Path>, prepend: Option<&Path>, base: &str) -> String {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(p) = prepend.filter(|p| !p.as_os_str().is_empty()) {
        parts.push(p.to_path_buf());
    }
    if let Some(home) = home {
        parts.push(home.join(".local/bin"));
        parts.push(home.join("bin"));
        parts.push(home.join(".cargo/bin"));
        // Kimi Code's installer puts its one binary here (its install doc);
        // a documented per-user bin like .cargo/bin, not a backend literal.
        parts.push(home.join(".kimi-code/bin"));
    }
    parts.extend(std::env::split_paths(base));
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| seen.insert(p.as_os_str().to_os_string()));
    std::env::join_paths(parts)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn agent_launch_path(prepend: Option<&Path>, base: &str) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    agent_launch_path_from(home.as_deref(), prepend, base)
}

/// A conversation id the STRICT restore resume accepts (board #422 review
/// P1-E): one data token — non-empty, not an option (`--last` is a CLI's
/// recent selector, not an id), no control characters (a newline would
/// submit half a line). The caller still shell-quotes it; each backend adds
/// its own reserved selectors on top (dsh: `recent`).
pub(crate) fn exact_id_ok(id: &str) -> bool {
    !id.trim().is_empty() && !id.starts_with('-') && !id.chars().any(char::is_control)
}

/// Write the full launch command to `<agent home>/launch-<name>.sh`. The home
/// is self-gitignored, and the script carries the same data as the backend
/// config files beside it, so this adds no new exposure. Overwritten on every
/// (re)launch.
///
/// NEVER send the full launch line via send-keys: claude/codex inline the
/// multi-KB system prompt on the command line, and terminal-integration shims
/// that proxy the pane's tty silently SWALLOW input bursts ≳2 KB (reproduced
/// at exactly ≥2000 bytes on 2026-07-23). Writing the command to a script and
/// sourcing it keeps the typed line ~60 bytes regardless of prompt size.
pub(crate) fn write_launch_script(home: &std::path::Path, name: &str, full_cmd: &str) -> Result<std::path::PathBuf, String> {
    let path = home.join(format!("launch-{}.sh", name));
    // The line carries the launch env; written privately (board #448).
    write_atomic(&path, &format!("# Teammux team launcher (regenerated on every launch)\n{}\n", full_cmd))
        .map_err(|e| format!("write {e}"))?;
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupConfirmation {
    pub(crate) markers: Vec<&'static str>,
    pub(crate) ready_markers: Vec<&'static str>,
    /// The backend's own reading of a screen that is still LOADING even with
    /// a ready marker on it (board #47: a resuming codex paints its composer
    /// placeholder while `Resuming session…`, and drops an Enter typed then).
    /// A structural reader in the backend's file, never a substring: words a
    /// transcript quotes must not hold a loaded CLI (#47 round 1, reviewer
    /// P1-R1). `None` for a backend with no such state.
    pub(crate) loading: Option<fn(&str) -> bool>,
    /// Named tmux keys used to accept the detected prompt. Claude 2.1.258
    /// defaults its folder-trust cursor to "No, exit", so Enter alone exits;
    /// Codex still defaults to the affirmative row.
    pub(crate) accept_keys: Vec<&'static str>,
    pub(crate) timeout: Duration,
}

pub(crate) const CLAUDE_FOLDER_TRUST_MARKERS: &[&str] = &[
    "Accessing workspace:",
    "Yes, I trust this folder",
    "Enter to confirm",
];

pub(crate) const CODEX_FOLDER_TRUST_MARKERS: &[&str] = &[
    "Do you trust the contents of this directory?",
    "1. Yes, continue",
    "Press enter to continue",
];

fn prompt_markers_visible(content: &str, markers: &[&str]) -> bool {
    markers.iter().all(|marker| content.contains(marker))
}

pub(crate) fn startup_prompt_visible(content: &str, confirmation: &StartupConfirmation) -> bool {
    prompt_markers_visible(content, &confirmation.markers)
}

pub(crate) fn startup_already_ready(content: &str, confirmation: &StartupConfirmation) -> bool {
    confirmation.ready_markers.iter().any(|marker| content.contains(marker))
        && !confirmation.loading.is_some_and(|loading| loading(content))
}

/// What one pane capture tells the startup waiter to do next.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupStep {
    /// The first-use dialog is on screen and has not been answered: send the
    /// accept keys.
    Accept,
    /// The CLI's own furniture is on screen: the pane is ready.
    Ready,
    /// Neither yet.
    Wait,
}

/// The pure decision behind `confirm_startup_prompt`: the dialog is answered
/// once (`accepted` remembers it — the accepted screen lingers a repaint or
/// two, and a second Enter would submit an empty composer line), and readiness
/// is the CLI's ready markers.
pub(crate) fn startup_step(content: &str, confirmation: &StartupConfirmation, accepted: bool) -> StartupStep {
    if !accepted && startup_prompt_visible(content, confirmation) {
        StartupStep::Accept
    } else if startup_already_ready(content, confirmation) {
        StartupStep::Ready
    } else {
        StartupStep::Wait
    }
}

/// Confirm a known first-use dialog without serializing the launch loop. No
/// key is sent when the workspace is already trusted or the UI differs.
///
/// `on_ready` runs ONCE when the CLI's ready markers are on screen (after
/// the dialog, if there was one) — the door for a backend whose first prompt
/// is TYPED rather than passed on the launch line (`Backend::first_prompt`,
/// kimi, board #224). Without it the waiter stops as soon as the dialog is
/// answered, exactly as before. A pane that never becomes ready within the
/// timeout is logged: typing a brief into whatever is there (a shell, after
/// a failed launch) would be worse than dropping it.
pub(crate) fn confirm_startup_prompt(
    pane: String,
    confirmation: StartupConfirmation,
    on_ready: Option<Box<dyn FnOnce() + Send + 'static>>,
) {
    confirm_startup_prompt_or(pane, confirmation, on_ready, None);
}

/// `confirm_startup_prompt`, with `on_timeout` run once when the ready
/// markers never showed (board #38: a restart says so, and types nothing).
pub(crate) fn confirm_startup_prompt_or(
    pane: String,
    confirmation: StartupConfirmation,
    on_ready: Option<Box<dyn FnOnce() + Send + 'static>>,
    on_timeout: Option<Box<dyn FnOnce() + Send + 'static>>,
) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + confirmation.timeout;
        let mut accepted = false;
        let mut on_ready = on_ready;
        while std::time::Instant::now() < deadline {
            if let Ok(content) = tmux::capture_pane_plain(&pane, Some(80)) {
                match startup_step(&content, &confirmation, accepted) {
                    StartupStep::Accept => {
                        println!("🜂 team: confirming folder trust in new pane {}", pane);
                        for key in &confirmation.accept_keys {
                            let _ = tmux::send_keys(&pane, key, false);
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        accepted = true;
                        if on_ready.is_none() {
                            return;
                        }
                    }
                    StartupStep::Ready => {
                        if let Some(f) = on_ready.take() {
                            f();
                        }
                        return;
                    }
                    StartupStep::Wait => {}
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if on_ready.is_some() {
            eprintln!("projects: pane {pane} never showed its ready markers — the first prompt was not typed");
            if let Some(f) = on_timeout {
                f();
            }
        }
    });
}

/// The longest provider-error text an agent's status and its notice carry
/// (board #39): enough for the status, the kind and the provider's sentence.
pub(crate) const PROVIDER_ERROR_MAX_CHARS: usize = 300;

/// HTTP statuses a provider answers when only a person can clear it: a bad
/// or expired credential (401, 403), no credit (402), a request too large
/// to be accepted again (413). A retry fails the same way every time.
const PERSON_STATUSES: [u16; 4] = [401, 402, 403, 413];

/// claude's `StopFailure` `error` values (2.1.318) that a person must clear,
/// and the ones that clear by themselves. Anything else is read by its text.
const PERSON_KINDS: [&str; 3] = ["authentication_failed", "billing_error", "invalid_request"];
const ORDINARY_KINDS: [&str; 3] = ["rate_limit", "server_error", "max_output_tokens"];

/// Measured sentences that say the same without a status (board #39 AC1:
/// kimi 2.5.1 "invalid API key"; the incident's claude "Request too large";
/// codex 0.166.0 "Payload Too Large"; the gateway's "insufficient credit").
const PERSON_PHRASES: [&str; 5] = ["invalid api key", "insufficient credit", "request too large", "payload too large", "please run /login"];

/// The ONE reading of a turn that ended on a provider error (board #39):
/// `Some(text)` when only a person can clear it, the text redacted and
/// bounded, with the CLI's error `kind` and the `status` in front when the
/// provider's message does not already say them; `None` for an ordinary
/// failure, which retries by itself and stays plain rest (#354). Each
/// backend's file extracts (status, kind, text) from its own payload.
pub(crate) fn provider_failure(status: Option<u16>, kind: Option<&str>, text: &str) -> Option<String> {
    let text = text.trim();
    let kind = kind.map(str::trim).filter(|k| !k.is_empty());
    if kind.is_some_and(|k| ORDINARY_KINDS.contains(&k)) {
        return None;
    }
    let lower = text.to_lowercase();
    let person = kind.is_some_and(|k| PERSON_KINDS.contains(&k))
        || status.is_some_and(|s| PERSON_STATUSES.contains(&s))
        || PERSON_STATUSES.iter().any(|s| has_number(text, *s))
        || PERSON_PHRASES.iter().any(|p| lower.contains(p));
    if !person {
        return None;
    }
    let mut out = String::new();
    for head in [kind.map(str::to_string), status.map(|s| s.to_string())].into_iter().flatten() {
        if !text.contains(&head) {
            out.push_str(&head);
            out.push_str(": ");
        }
    }
    out.push_str(&redact(text));
    if out.chars().count() > PROVIDER_ERROR_MAX_CHARS {
        out = out.chars().take(PROVIDER_ERROR_MAX_CHARS).collect::<String>() + "…";
    }
    Some(out)
}

/// `n` as a whole number in `text`, not part of a longer one.
fn has_number(text: &str, n: u16) -> bool {
    let n = n.to_string();
    text.match_indices(&n).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + n.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_digit()) && !after.is_some_and(|c| c.is_ascii_digit())
    })
}

const REDACTED: &str = "<REDACTED>";

/// Where a secret key's value starts, when `chars[after..]` is what follows a
/// key name: `=`, or `:` (a JSON key's closing quote first), then optional
/// spaces and an opening quote. `None` when no assignment follows, so a key
/// word in prose is left alone.
fn secret_value_start(chars: &[char], after: usize) -> Option<usize> {
    let mut j = after;
    if chars.get(j) == Some(&'"') {
        j += 1;
    }
    if !matches!(chars.get(j), Some('=') | Some(':')) {
        return None;
    }
    j += 1;
    while chars.get(j) == Some(&' ') {
        j += 1;
    }
    if matches!(chars.get(j), Some('"') | Some('\'')) {
        j += 1;
    }
    Some(j)
}
/// The secret words a key name may END with (orchestrator, round 2): a
/// name is normalised first (`secret_name`), so `x-api-key`, `X-Api-Key`,
/// `OPENAI_API_KEY` and `app.secret` all end with one, while `keyboard` and
/// `monkey` do not (the word must be the whole name or follow a `_`).
const SECRET_WORDS: [&str; 13] = ["api_key", "apikey", "key", "token", "access_token", "refresh_token", "secret", "client_secret", "password", "passwd", "authorization", "sig", "signature"];

/// Whether a key NAME (letters, digits, `_`, `-`, `.`) names a secret:
/// lowercased, `-` and `.` read as `_`, and a secret word as the whole
/// name or its last `_`-joined part(s).
fn secret_name(name: &str) -> bool {
    let n: String = name.chars().map(|c| if matches!(c, '-' | '.') { '_' } else { c.to_ascii_lowercase() }).collect();
    SECRET_WORDS.iter().any(|w| n == *w || n.ends_with(&format!("_{w}")))
}

/// Masks what is shaped like a credential in a provider's error text
/// (orchestrator, board #39): a URL's query string is dropped, `sk-…`, the
/// token after `Bearer`, the value of `key=`/`token=`/… and any run of 32 or
/// more key characters holding both letters and digits are `<REDACTED>`. A
/// request id survives (a UUID's groups are short), so does the status.
fn redact(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let key_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_');
    let token_end = |from: usize| (from..chars.len()).find(|&j| !(key_char(chars[j]) || matches!(chars[j], '-' | '.'))).unwrap_or(chars.len());
    let at = |i: usize, word: &str| {
        let w: Vec<char> = word.chars().collect();
        i + w.len() <= chars.len() && chars[i..i + w.len()].iter().zip(&w).all(|(a, b)| a.eq_ignore_ascii_case(b))
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_url = false;
    while i < chars.len() {
        let c = chars[i];
        let boundary = i == 0 || !key_char(chars[i - 1]) && chars[i - 1] != '-';
        if c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ')' | '<' | '>') {
            in_url = false;
        }
        if !in_url && boundary && (at(i, "https://") || at(i, "http://")) {
            in_url = true;
            // URL userinfo (`user:pass@host`) is dropped whole.
            let host = i + if at(i, "https://") { 8 } else { 7 };
            let authority_end = (host..chars.len()).find(|&j| chars[j].is_whitespace() || matches!(chars[j], '/' | '?' | '#' | '"' | '\'' | ',' | ')' | '<' | '>')).unwrap_or(chars.len());
            if let Some(user_end) = (host..authority_end).rev().find(|&j| chars[j] == '@') {
                out.extend(&chars[i..host]);
                i = user_end + 1;
                continue;
            }
        }
        if in_url && c == '?' {
            // The whole query, up to where the URL ends.
            while i < chars.len() && !(chars[i].is_whitespace() || matches!(chars[i], '"' | '\'' | ',' | ')' | '<' | '>')) {
                i += 1;
            }
            in_url = false;
            continue;
        }
        if boundary && at(i, "sk-") {
            out.push_str(REDACTED);
            i = token_end(i);
            continue;
        }
        if let Some(scheme) = ["bearer ", "basic "].into_iter().find(|w| boundary && at(i, w)) {
            let start = i + scheme.len();
            let end = token_end(start);
            if end > start {
                out.extend(&chars[i..start]);
                out.push_str(REDACTED);
                i = end;
                continue;
            }
        }
        // A key NAME at a name boundary, followed by an assignment: `k=v`,
        // `k="v"`, `k: v` (a header or YAML) and `"k":"v"` (JSON).
        let name_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.');
        if c.is_ascii_alphabetic() && (i == 0 || !name_char(chars[i - 1])) {
            let name_end = (i..chars.len()).find(|&j| !name_char(chars[j])).unwrap_or(chars.len());
            let name: String = chars[i..name_end].iter().collect();
            if let Some(start) = secret_name(&name).then(|| secret_value_start(&chars, name_end)).flatten() {
                out.extend(&chars[i..start]);
                // `Authorization: Bearer <t>`: the scheme stays and its
                // credential is masked by the scheme rule next.
                if ["bearer ", "basic "].iter().any(|w| at(start, w)) {
                    i = start;
                    continue;
                }
                let end = (start..chars.len()).find(|&j| chars[j].is_whitespace() || matches!(chars[j], '&' | '"' | '\'' | ',' | ';' | ')' | '}')).unwrap_or(chars.len());
                if end > start {
                    out.push_str(REDACTED);
                }
                i = end;
                continue;
            }
        }
        if boundary && key_char(c) {
            let end = (i..chars.len()).find(|&j| !key_char(chars[j])).unwrap_or(chars.len());
            let run = &chars[i..end];
            if run.len() >= 32 && run.iter().any(|c| c.is_ascii_digit()) && run.iter().any(|c| c.is_ascii_alphabetic()) {
                out.push_str(REDACTED);
                i = end;
                continue;
            }
            out.extend(run);
            i = end;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #39: the failures only a person can clear, from the texts the
    /// incident and builder-2's AC1 measurement captured; the ordinary ones
    /// (they retry by themselves) are not.
    #[test]
    fn a_provider_failure_a_person_must_clear_is_told_from_an_ordinary_one() {
        let claude_401 = "Please run /login · API Error: 401 invalid API key";
        assert_eq!(provider_failure(None, Some("authentication_failed"), claude_401).as_deref(), Some("authentication_failed: Please run /login · API Error: 401 invalid API key"));
        let too_large = "Request too large (max 32MB). Accumulated images and attachments in the conversation. Run /compact";
        assert_eq!(provider_failure(None, Some("invalid_request"), too_large).as_deref(), Some(format!("invalid_request: {too_large}").as_str()));
        let credit = "API Error: 402 insufficient credit; contact your tenant owner";
        assert_eq!(provider_failure(None, Some("unknown"), credit).as_deref(), Some(format!("unknown: {credit}").as_str()), "claude files the gateway's 402 as unknown");
        assert!(provider_failure(None, Some("billing_error"), "Your credit balance is too low").is_some());
        assert_eq!(provider_failure(None, Some("APIStatusError"), "invalid API key").as_deref(), Some("APIStatusError: invalid API key"), "kimi 2.5.1");
        let omp = r#"401 {"type":"error","error":{"type":"authentication_error","message":"invalid API key"}}"#;
        assert_eq!(provider_failure(Some(401), None, omp).as_deref(), Some(omp), "a status the text already says is not said twice");
        assert_eq!(provider_failure(Some(413), None, "Payload Too Large").as_deref(), Some("413: Payload Too Large"));
        assert!(provider_failure(Some(403), None, "forbidden").is_some());
        // Ordinary: they retry by themselves, and stay plain rest (#354).
        assert_eq!(provider_failure(None, Some("rate_limit"), "API Error: 429 rate limited"), None);
        assert_eq!(provider_failure(None, Some("server_error"), "API Error: 500 internal server error"), None);
        assert_eq!(provider_failure(None, Some("max_output_tokens"), "output limit"), None);
        assert_eq!(provider_failure(None, Some("unknown"), "API Error: Connection error."), None);
        assert_eq!(provider_failure(Some(429), None, "429 too many requests"), None);
        assert_eq!(provider_failure(Some(529), None, "overloaded"), None);
        assert_eq!(provider_failure(None, Some("APIStatusError"), "Error code: 500"), None);
        assert_eq!(provider_failure(None, None, "took 4013 ms"), None, "a status is a whole number");
        assert_eq!(provider_failure(None, None, ""), None);
    }

    /// Board #39 (orchestrator, 07:48): the text goes to the room, panes and
    /// the wire, so a credential-shaped string and a URL's query are masked;
    /// the status, the CLI's error kind and the provider's message stay.
    #[test]
    fn a_provider_failures_text_is_redacted_and_bounded() {
        let fake = "sk-ant-api03-FAKEfakeFAKEfake0123456789abcdefABCDEF";
        let got = provider_failure(None, Some("authentication_failed"), &format!("API Error: 401 invalid x-api-key {fake}")).unwrap();
        assert_eq!(got, "authentication_failed: API Error: 401 invalid x-api-key <REDACTED>");
        let got = provider_failure(Some(401), None, "401 Authorization: Bearer abc.DEF-ghi_123 rejected").unwrap();
        assert_eq!(got, "401 Authorization: Bearer <REDACTED> rejected");
        let got = provider_failure(Some(401), None, "unexpected status 401 Unauthorized, url: https://gw.example/v1/responses?key=SECRET&x=1, request id: req_0a1b2c").unwrap();
        assert_eq!(got, "unexpected status 401 Unauthorized, url: https://gw.example/v1/responses, request id: req_0a1b2c");
        let got = provider_failure(Some(402), None, "402 token=abc123 api_key=\"zz9\" denied").unwrap();
        assert_eq!(got, "402 token=<REDACTED> api_key=\"<REDACTED>\" denied", "a quoted value keeps its quotes");
        // validator's round-0 P2: the JSON, colon, Basic-auth and userinfo
        // forms of the same shapes.
        let got = provider_failure(Some(401), None, r#"401 {"error":"bad key","api_key":"AbCd1234EfGh5678"}"#).unwrap();
        assert_eq!(got, r#"401 {"error":"bad key","api_key":"<REDACTED>"}"#);
        let got = provider_failure(Some(401), None, "401 rejected api_key: AbCd1234EfGh5678 for this org").unwrap();
        assert_eq!(got, "401 rejected api_key: <REDACTED> for this org");
        let got = provider_failure(Some(401), None, "401 Authorization: Basic dXNlcjpwYXNzd29yZA== refused").unwrap();
        assert_eq!(got, "401 Authorization: Basic <REDACTED> refused");
        let got = provider_failure(Some(401), None, "401 url: https://user:hunter2pass@api.example.com/v1/messages").unwrap();
        assert_eq!(got, "401 url: https://api.example.com/v1/messages");
        let got = provider_failure(Some(401), None, "401 Unauthorized: API_KEY: AbCd1234EfGh5678 TOKEN=zz9").unwrap();
        assert_eq!(got, "401 Unauthorized: API_KEY: <REDACTED> TOKEN=<REDACTED>", "any case");
        let combined = r#"413 POST https://alice:s3cret@gw.example/v1/messages?key=Q1 failed: {"error":{"message":"too large","api_key": "AbCd1234EfGh5678"}} Authorization: Basic dXNlcjpwYXNzd29yZA== Bearer eyJ.abc"#;
        assert_eq!(provider_failure(Some(413), None, combined).unwrap(),
            r#"413 POST https://gw.example/v1/messages failed: {"error":{"message":"too large","api_key": "<REDACTED>"}} Authorization: Basic <REDACTED> Bearer <REDACTED>"#, "one combined payload");
        let got = provider_failure(Some(401), None, "401 Unauthorized: Authentication failed").unwrap();
        assert_eq!(got, "401 Unauthorized: Authentication failed", "a word after a colon is not a value");
        // Round 2 (validator's x-api-key, orchestrator: close the class): a
        // key name is normalised (lowercase, '-' and '.' to '_') and a secret
        // word at the END of a compound name counts, in every form.
        let v = "AbCd1234EfGh5678";
        for (raw, want) in [
            (format!("401 x-api-key: {v} rejected"), "401 x-api-key: <REDACTED> rejected".to_string()),
            (format!("401 X-Api-Key={v} rejected"), "401 X-Api-Key=<REDACTED> rejected".to_string()),
            (format!(r#"401 {{"x-api-key":"{v}"}}"#), r#"401 {"x-api-key":"<REDACTED>"}"#.to_string()),
            (format!("401 headers:\n  x-api-key: {v}\n"), "401 headers:\n  x-api-key: <REDACTED>".to_string()),
            (format!("401 x-goog-api-key: {v}"), "401 x-goog-api-key: <REDACTED>".to_string()),
            (format!("401 OPENAI_API_KEY={v}"), "401 OPENAI_API_KEY=<REDACTED>".to_string()),
            (format!("401 anthropic-api-key: {v}"), "401 anthropic-api-key: <REDACTED>".to_string()),
            (format!("401 refresh_token={v} client_secret: {v} passwd={v}"), "401 refresh_token=<REDACTED> client_secret: <REDACTED> passwd=<REDACTED>".to_string()),
            (format!("401 app.secret={v}"), "401 app.secret=<REDACTED>".to_string()),
        ] {
            assert_eq!(provider_failure(Some(401), None, &raw).unwrap(), want, "{raw}");
        }
        // The false-positive guard: a secret word inside another word is not one.
        let got = provider_failure(Some(401), None, "401 keyboard: ok monkey=1 turnkey solution, tokens: 12").unwrap();
        assert_eq!(got, "401 keyboard: ok monkey=1 turnkey solution, tokens: 12");
        // The scheme after `Authorization:` is kept and its credential masked.
        let got = provider_failure(Some(401), None, &format!("401 authorization: Bearer {v}")).unwrap();
        assert_eq!(got, "401 authorization: Bearer <REDACTED>");
        let got = provider_failure(Some(401), None, &format!("401 Authorization: {v}")).unwrap();
        assert_eq!(got, "401 Authorization: <REDACTED>", "a bare credential after the header name");
        let hex = "0123456789abcdef0123456789abcdef01234567";
        let got = provider_failure(Some(401), None, &format!("401 credential {hex} expired (Request ID: 6f1c2d3e-aaaa-4bbb-8ccc-0123456789ab)")).unwrap();
        assert_eq!(got, "401 credential <REDACTED> expired (Request ID: 6f1c2d3e-aaaa-4bbb-8ccc-0123456789ab)", "a long run goes; a request id stays");
        let long = format!("413 {}", "x ".repeat(400));
        let got = provider_failure(Some(413), None, &long).unwrap();
        assert!(got.chars().count() <= PROVIDER_ERROR_MAX_CHARS + 1 && got.ends_with('…'), "{got}");
    }

    /// Board #38 round 1: a pane that never shows its ready furniture runs
    /// `on_timeout` once, and never `on_ready`.
    #[test]
    fn a_waiter_that_times_out_says_so_and_never_runs_on_ready() {
        let (tx, rx) = std::sync::mpsc::channel::<&'static str>();
        let (t1, t2) = (tx.clone(), tx);
        let c = StartupConfirmation { markers: Vec::new(), ready_markers: vec!["never"], loading: None, accept_keys: Vec::new(), timeout: Duration::from_millis(700) };
        confirm_startup_prompt_or("no-such-session-38:0".into(), c, Some(Box::new(move || { let _ = t1.send("ready"); })), Some(Box::new(move || { let _ = t2.send("timeout"); })));
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).ok(), Some("timeout"));
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "once, and on_ready never");
    }

    /// Board #515: under test the user's Claude settings are a per-process
    /// temp file, never the developer's `~/.claude/settings.json` (the path
    /// both the renderer's carry and claude's model discovery read).
    #[test]
    fn the_users_claude_settings_are_a_per_process_path_under_test() {
        let path = claude_user_settings();
        let home = path.parent().and_then(Path::parent).and_then(|d| d.file_name()).and_then(|d| d.to_str()).unwrap_or_default().to_string();
        assert_eq!(home, format!("tmm-claude-user-home-{}", std::process::id()), "{}", path.display());
        assert!(path.ends_with(".claude/settings.json"), "{}", path.display());
    }

    /// The waiter's decision, on kimi's measured screens (board #224): the
    /// trust dialog is accepted once, a lingering dialog after the accept is
    /// not accepted again, the welcome box is ready, anything else waits.
    #[test]
    fn startup_step_accepts_once_then_waits_for_ready() {
        let c = StartupConfirmation {
            markers: vec!["Trust this folder?", "Don't trust"],
            ready_markers: vec!["Welcome to Kimi Code", "No session yet"],
            loading: None,
            accept_keys: vec!["Enter"],
            timeout: Duration::from_secs(1),
        };
        let dialog = "  Trust this folder?\n  ↑↓ navigate · Enter select · Esc exit\n   ❯ Trust this folder\n     Don't trust\n";
        assert_eq!(startup_step(dialog, &c, false), StartupStep::Accept);
        assert_eq!(startup_step(dialog, &c, true), StartupStep::Wait, "the accepted dialog lingers a repaint — no second Enter");
        let welcome = " │  ▐█▛█▛█▌  Welcome to Kimi Code!  │\n   No session yet — one will be created on your first message.\n";
        assert_eq!(startup_step(welcome, &c, true), StartupStep::Ready);
        assert_eq!(startup_step(welcome, &c, false), StartupStep::Ready, "a remembered trust skips the dialog");
        assert_eq!(startup_step("$ . /ws/.tmm/agents/k1/launch-k1.sh\n", &c, false), StartupStep::Wait);
    }

    #[test]
    fn managed_agent_path_includes_user_cli_bins_even_with_a_service_path() {
        let home = Path::new("/home/tester");
        let path = agent_launch_path_from(
            Some(home),
            Some(Path::new("/opt/tmm/bin")),
            "/usr/bin:/home/tester/.local/bin:/usr/bin",
        );
        let parts: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(parts[0], PathBuf::from("/opt/tmm/bin"));
        assert_eq!(parts[1], PathBuf::from("/home/tester/.local/bin"));
        assert!(parts.contains(&PathBuf::from("/home/tester/bin")));
        assert!(parts.contains(&PathBuf::from("/home/tester/.cargo/bin")));
        assert_eq!(
            parts.iter().filter(|p| *p == &PathBuf::from("/usr/bin")).count(),
            1
        );
        assert_eq!(
            parts
                .iter()
                .filter(|p| *p == &PathBuf::from("/home/tester/.local/bin"))
                .count(),
            1
        );
    }

    #[test]
    fn launch_script_keeps_typed_line_short() {
        // The typed `. '<script>'` line must stay tiny no matter how large the
        // inline system prompt grows — kiro-cli-term swallows ≥2 KB bursts.
        let dir = crate::config::test_scratch("tmm-launch-test");
        std::fs::create_dir_all(&dir).unwrap();
        let huge_cmd = format!("TEAM_AGENT='x' claude --append-system-prompt '{}' 'kick'", "p".repeat(8000));
        let script = write_launch_script(&dir, "planner", &huge_cmd).unwrap();
        let written = std::fs::read_to_string(&script).unwrap();
        assert!(written.contains(&huge_cmd));
        assert!(script.file_name().unwrap().to_string_lossy() == "launch-planner.sh");
        let typed = format!(". {}", crate::shell::quote(&script.to_string_lossy()));
        assert!(typed.len() < 200, "typed line must stay far below the ~2KB swallow threshold, got {}", typed.len());
        // Relaunch overwrites, not appends.
        let script2 = write_launch_script(&dir, "planner", "echo v2").unwrap();
        let w2 = std::fs::read_to_string(&script2).unwrap();
        assert!(w2.contains("echo v2") && !w2.contains("claude"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_carry_is_the_env_block_and_the_credential_commands_only() {
        let settings = serde_json::json!({
            "env": {"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-west-2"},
            "apiKeyHelper": "print-key",
            "awsAuthRefresh": "aws sso login",
            "awsCredentialExport": "export-creds",
            "gcpAuthRefresh": "gcloud auth login",
            "enabledPlugins": {"SENTINEL": true},
            "theme": "SENTINEL",
            "forceLoginMethod": "SENTINEL",
            "otelHeadersHelper": "SENTINEL",
            "model": "SENTINEL"
        });
        assert_eq!(
            claude_carry_of(&settings),
            serde_json::json!({
                "env": {"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-west-2"},
                "apiKeyHelper": "print-key",
                "awsAuthRefresh": "aws sso login",
                "awsCredentialExport": "export-creds",
                "gcpAuthRefresh": "gcloud auth login"
            })
        );
        // A non-string helper or env is not a credential command or a channel.
        assert_eq!(
            claude_carry_of(&serde_json::json!({"env": 7, "apiKeyHelper": {"SENTINEL": 1}})),
            serde_json::json!({"env": {}})
        );
    }

    #[test]
    fn codex_system_files_link_config_env_and_auth_idempotently() {
        let root = crate::config::test_scratch("teamtest-codex-system");
        let system_home = root.join("system");
        let agent_home = root.join("agent");
        std::fs::create_dir_all(&system_home).unwrap();
        std::fs::write(system_home.join("config.toml"), "model_provider = \"custom\"").unwrap();
        std::fs::write(system_home.join(".env"), "PROVIDER_TOKEN=secret").unwrap();
        std::fs::write(system_home.join("auth.json"), "{}").unwrap();
        std::fs::write(system_home.join("personal.config.toml"), "model_provider = \"bedrock\"").unwrap();

        inherit_codex_system_files_from(&agent_home, &system_home).unwrap();
        inherit_codex_system_files_from(&agent_home, &system_home).unwrap();

        for filename in ["config.toml", ".env", "auth.json", "personal.config.toml"] {
            let target = agent_home.join(filename);
            assert!(std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        assert_eq!(
            std::fs::read_to_string(agent_home.join("config.toml")).unwrap(),
            "model_provider = \"custom\""
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_system_files_missing_source_removes_only_team_config() {
        let root = crate::config::test_scratch("teamtest-codex-no-auth");
        let agent_home = root.join("agent");
        std::fs::create_dir_all(&agent_home).unwrap();
        std::fs::write(agent_home.join("config.toml"), "[mcp_servers.team]").unwrap();

        inherit_codex_system_files_from(&agent_home, &root.join("system")).unwrap();

        assert!(!agent_home.join("config.toml").exists());
        assert!(!agent_home.join(".env").exists());
        assert!(!agent_home.join("auth.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_auth_does_not_replace_an_existing_private_file() {
        let root = crate::config::test_scratch("teamtest-codex-existing-auth");
        let system_home = root.join("system");
        let agent_home = root.join("agent");
        std::fs::create_dir_all(&system_home).unwrap();
        std::fs::create_dir_all(&agent_home).unwrap();
        std::fs::write(system_home.join("auth.json"), "system").unwrap();
        std::fs::write(agent_home.join("auth.json"), "private").unwrap();

        let error = inherit_codex_system_files_from(&agent_home, &system_home).unwrap_err();

        assert!(error.contains("refusing to replace"));
        assert_eq!(std::fs::read_to_string(agent_home.join("auth.json")).unwrap(), "private");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Board #448 P1-A residual, the full render: the codex home of a managed
    /// agent is a link to an outside directory of the same user. The render
    /// is refused BEFORE the inheritance changes anything there: the
    /// outside config.toml and a file named like the managed profile are
    /// neither replaced, deleted nor chmodded.
    #[test]
    #[cfg(unix)]
    fn a_linked_codex_home_is_refused_before_the_inheritance_touches_it() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::test_scratch("teamtest-codex-linked");
        let user = super::super::codex::codex_user_home();
        std::fs::create_dir_all(&user).unwrap();
        let user_cfg = user.join("config.toml");
        let had = user_cfg.exists();
        if !had { std::fs::write(&user_cfg, "model = \"user\"").unwrap(); }
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        for (name, body) in [("config.toml", "outside config"), ("tmm-agent.config.toml", "outside profile")] {
            std::fs::write(outside.join(name), body).unwrap();
            std::fs::set_permissions(outside.join(name), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let home = root.join("ws/.tmm/agents/cx");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("codex")).unwrap();
        let def = crate::projects::store::RegAgent { name: "cx".into(), backend: "codex".into(), model: String::new(), effort: String::new(), input_mode: "queue".into(), system: "x".into(), skills: "[]".into(), mcp: "[]".into() };
        let r = super::super::codex::render_codex(&def, "cx", &home, &root.join("ws"), "prompt", &[]);
        if !had { std::fs::remove_file(&user_cfg).ok(); }
        assert!(r.is_err(), "refused");
        let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
        for (name, body) in [("config.toml", "outside config"), ("tmm-agent.config.toml", "outside profile")] {
            let p = outside.join(name);
            assert!(std::fs::symlink_metadata(&p).unwrap().is_file(), "{name} is still a regular file, not a link");
            assert_eq!((std::fs::read_to_string(&p).unwrap().as_str(), mode(&p)), (body, 0o644), "{name} untouched");
        }
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 2, "nothing added outside");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(unix)]
    fn an_owned_file_is_removed_only_when_it_is_a_regular_file_of_ours() {
        // Board #448: `write_owned(None)` removes through the held directory;
        // a link by that name is an error and its target stays.
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::test_scratch("teamtest-owned");
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let target = root.join("user.json");
        std::fs::write(&target, "the user's").unwrap();
        std::os::unix::fs::symlink(&target, home.join("mcp.json")).unwrap();
        assert!(write_owned(&home.join("mcp.json"), None).is_err());
        assert!(std::fs::symlink_metadata(home.join("mcp.json")).unwrap().file_type().is_symlink(), "the link is left");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "the user's");
        std::fs::remove_file(home.join("mcp.json")).unwrap();
        write_owned(&home.join("mcp.json"), Some("{}")).unwrap();
        assert_eq!(std::fs::metadata(home.join("mcp.json")).unwrap().permissions().mode() & 0o777, 0o600);
        write_owned(&home.join("mcp.json"), None).unwrap();
        assert!(!home.join("mcp.json").exists(), "a regular file of ours is removed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(unix)]
    fn the_managed_codex_profile_is_never_a_users_and_is_rewritten_whole() {
        // Board #448 P1-C: a user profile named like ours stays as it is
        // (content and mode), a stale LINK to it is removed itself, and our
        // profile is a private file rewritten whole on every render.
        use std::os::unix::fs::PermissionsExt;
        let root = crate::config::test_scratch("teamtest-codex-profile");
        let (system_home, agent_home) = (root.join("system"), root.join("agent"));
        std::fs::create_dir_all(&system_home).unwrap();
        std::fs::create_dir_all(&agent_home).unwrap();
        let user = system_home.join(codex_profile_file());
        std::fs::write(&user, "model = \"the user's own\"").unwrap();
        std::fs::set_permissions(&user, std::fs::Permissions::from_mode(0o644)).unwrap();
        // An older inheritance linked it into the home.
        std::os::unix::fs::symlink(&user, agent_home.join(codex_profile_file())).unwrap();
        inherit_codex_system_files_from(&agent_home, &system_home).unwrap();
        let ours = agent_home.join(codex_profile_file());
        assert!(std::fs::symlink_metadata(&ours).is_err(), "the stale link is gone and nothing was linked in its place");
        let server = |name: &str| McpDef { name: name.into(), command: Some("mcp".into()), env: [("K".to_string(), format!("SENTINEL-{name}"))].into(), ..Default::default() };
        write_atomic(&ours, &codex_profile(&[server("a"), server("b")], "", "")).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&ours), 0o600);
        // A second inheritance (every launch) keeps our regular file.
        inherit_codex_system_files_from(&agent_home, &system_home).unwrap();
        assert!(std::fs::read_to_string(&ours).unwrap().contains("SENTINEL-a"));
        // Revocation: the next render writes the whole profile without it.
        write_atomic(&ours, &codex_profile(&[server("b")], "", "")).unwrap();
        let text = std::fs::read_to_string(&ours).unwrap();
        assert!(!text.contains("SENTINEL-a") && !text.contains("[mcp_servers.a]") && text.contains("SENTINEL-b"), "{text}");
        assert_eq!((std::fs::read_to_string(&user).unwrap().as_str(), mode(&user)), ("model = \"the user's own\"", 0o644), "the user's file is untouched");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mcp_value_remote_and_local_per_backend() {
        let remote = McpDef {
            name: "gh".into(),
            url: Some("https://x/mcp".into()),
            headers: [
                ("Authorization".to_string(), "Bearer $API_TOKEN".to_string()),
                ("X-Features".to_string(), "${FEATURES}".to_string()),
                ("X-Static".to_string(), "literal".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };
        // kiro remote omits an explicit type; claude tags it http.
        assert!(kiro_mcp_value(&remote).get("type").is_none());
        assert_eq!(claude_mcp_value(&remote)["type"], "http");
        assert_eq!(kiro_mcp_value(&remote)["url"], "https://x/mcp");
        assert_eq!(
            kiro_mcp_value(&remote)["headers"]["Authorization"],
            "Bearer ${API_TOKEN}"
        );
        assert_eq!(
            claude_mcp_value(&remote)["headers"]["X-Features"],
            "${FEATURES}"
        );
        assert_eq!(kiro_mcp_value(&remote)["headers"]["X-Static"], "literal");

        // codex (board #448): the same semantics, as a structural profile file.
        let local = McpDef {
            name: "pg".into(), command: Some("mcp-pg".into()), args: vec!["--stdio".into()],
            env: [("API_KEY".to_string(), "SENTINEL-env".to_string())].into(), ..Default::default()
        };
        let mut lit = remote.clone();
        lit.name = "lit".into();
        lit.headers = [("Authorization".to_string(), "Bearer SENTINEL-literal".to_string())].into();
        let doc: toml::Table = codex_profile(&[remote.clone(), local.clone(), lit], "", "").parse().unwrap();
        let gh = &doc["mcp_servers"]["gh"];
        assert_eq!(gh["url"].as_str(), Some("https://x/mcp"));
        assert_eq!(gh["bearer_token_env_var"].as_str(), Some("API_TOKEN"), "Bearer $VAR is a name");
        assert_eq!(gh["env_http_headers"]["X-Features"].as_str(), Some("FEATURES"), "$VAR is a name");
        assert_eq!(gh["http_headers"]["X-Static"].as_str(), Some("literal"));
        assert!(gh.get("http_headers").and_then(|h| h.get("Authorization")).is_none());
        let pg = &doc["mcp_servers"]["pg"];
        assert_eq!((pg["command"].as_str(), pg["args"][0].as_str()), (Some("mcp-pg"), Some("--stdio")));
        assert_eq!(pg["env"]["API_KEY"].as_str(), Some("SENTINEL-env"), "a stdio env value is a literal table entry");
        assert_eq!(doc["mcp_servers"]["lit"]["http_headers"]["Authorization"].as_str(), Some("Bearer SENTINEL-literal"), "a literal Authorization stays a literal header");
        // No server and no identity: only the header comment, so a revoked
        // server leaves nothing.
        let empty = codex_profile(&[], "", "");
        assert!(empty.starts_with('#') && empty.parse::<toml::Table>().unwrap().is_empty(), "{empty}");

        // Board #455: model and effort are top-level keys of the SAME whole
        // document. Setting, changing or clearing either keeps the MCP tables,
        // and revoking the servers keeps the identity.
        let read = |model: &str, effort: &str, defs: &[McpDef]| -> toml::Table { codex_profile(defs, model, effort).parse().unwrap() };
        let with = read("gpt-6-luna", "high", std::slice::from_ref(&local));
        assert_eq!((with["model"].as_str(), with["model_reasoning_effort"].as_str()), (Some("gpt-6-luna"), Some("high")));
        assert_eq!(with["mcp_servers"]["pg"]["env"]["API_KEY"].as_str(), Some("SENTINEL-env"));
        let changed = read("gpt-6-astra", "minimal", std::slice::from_ref(&local));
        assert_eq!((changed["model"].as_str(), changed["model_reasoning_effort"].as_str()), (Some("gpt-6-astra"), Some("minimal")));
        assert!(changed["mcp_servers"].get("pg").is_some(), "a model change keeps the servers");
        for (model, effort) in [("", "high"), ("gpt-6-luna", ""), ("", "")] {
            let doc = read(model, effort, std::slice::from_ref(&local));
            assert_eq!(doc.contains_key("model"), !model.is_empty(), "an empty model is NOT SET at this layer: {doc:?}");
            assert_eq!(doc.contains_key("model_reasoning_effort"), !effort.is_empty(), "{doc:?}");
            assert!(doc["mcp_servers"].get("pg").is_some(), "clearing keeps the servers: {doc:?}");
        }
        let revoked = read("gpt-6-luna", "high", &[]);
        assert!(!revoked.contains_key("mcp_servers"), "a revoked server leaves nothing");
        assert_eq!((revoked["model"].as_str(), revoked["model_reasoning_effort"].as_str()), (Some("gpt-6-luna"), Some("high")), "and the identity stays");
    }

}
