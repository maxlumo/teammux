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

fn env_reference(value: &str) -> Option<&str> {
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

fn header_env_reference(value: &str) -> Option<(&str, bool)> {
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

fn codex_key_segment(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap()
    }
}

pub(crate) fn codex_config_override(key: &str, value: Value) -> String {
    let assignment = format!("{}={}", key, serde_json::to_string(&value).unwrap());
    format!("-c {}", crate::shell::quote(&assignment))
}

/// Codex CLI overrides for one extra MCP server. The system config.toml stays
/// intact; agent-specific MCP settings are layered at launch.
pub(crate) fn codex_mcp_overrides(m: &McpDef) -> Vec<String> {
    let name = codex_key_segment(&m.name);
    let prefix = format!("mcp_servers.{}", name);
    let mut args = Vec::new();
    if let Some(url) = &m.url {
        args.push(codex_config_override(&format!("{}.url", prefix), Value::String(url.clone())));
        args.push(codex_config_override(&format!("{}.enabled", prefix), Value::Bool(true)));
        args.push(codex_config_override(
            &format!("{}.experimental_use_rmcp_client", prefix),
            Value::Bool(true),
        ));
        for (key, value) in &m.headers {
            match header_env_reference(value) {
                Some((name, true)) if key.eq_ignore_ascii_case("authorization") => {
                    args.push(codex_config_override(
                        &format!("{}.bearer_token_env_var", prefix),
                        Value::String(name.to_string()),
                    ));
                }
                Some((name, false)) => {
                    args.push(codex_config_override(
                        &format!("{}.env_http_headers.{}", prefix, codex_key_segment(key)),
                        Value::String(name.to_string()),
                    ));
                }
                _ => {
                    args.push(codex_config_override(
                        &format!("{}.http_headers.{}", prefix, codex_key_segment(key)),
                        Value::String(value.clone()),
                    ));
                }
            }
        }
    } else if let Some(cmd) = &m.command {
        args.push(codex_config_override(
            &format!("{}.command", prefix),
            Value::String(cmd.clone()),
        ));
        if !m.args.is_empty() {
            args.push(codex_config_override(
                &format!("{}.args", prefix),
                serde_json::to_value(&m.args).unwrap(),
            ));
        }
        for (key, value) in &m.env {
            args.push(codex_config_override(
                &format!("{}.env.{}", prefix, codex_key_segment(key)),
                Value::String(value.clone()),
            ));
        }
    }
    args
}

/// Keep the managed home's runtime state isolated while sharing the system
/// Codex provider and login. Links follow config/token refreshes without
/// copying credentials. The system home is `codex::codex_user_home` — under
/// test a per-process temp dir, so a render test never links the developer's
/// real `~/.codex` (board #216, #231).
pub(crate) fn inherit_codex_system_files(home: &Path) -> Result<(), String> {
    inherit_codex_system_files_from(home, &super::codex::codex_user_home())
}

/// Replace `path` WHOLE: the text goes to a sibling temp file that is renamed
/// over it, so a reader (a process starting while this runs) sees all of the
/// old file or all of the new, never a truncated or half-written one. For the
/// owned files a running agent may read at any moment (board #411: dsh reads
/// its profile at the start of every turn).
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
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

/// A config file the render OWNS: `Some` writes it, `None` removes it. A home
/// is re-rendered on every spawn, so "nothing to declare" must leave nothing
/// behind; skipping the write kept the previous render's file, and the CLI
/// kept loading a revoked MCP server or an unpinned model (#241, validator).
pub(crate) fn write_owned(path: &Path, content: Option<&str>) -> Result<(), String> {
    match content {
        Some(text) => std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display())),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        },
    }
}

fn link_codex_system_file(
    home: &Path,
    system_home: &Path,
    filename: &str,
    replace_team_owned: bool,
) -> Result<(), String> {
    let source = system_home.join(filename);
    if !source.is_file() {
        if replace_team_owned {
            let target = home.join(filename);
            match std::fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                    std::fs::remove_file(target).map_err(|e| e.to_string())?;
                }
                Ok(_) => return Err(format!("refusing to replace Codex path: {}", target.display())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        return Ok(());
    }
    let source = std::fs::canonicalize(source).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let target = home.join(filename);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                && std::fs::read_link(&target).is_ok_and(|path| path == source)
            {
                return Ok(());
            }
            if replace_team_owned && (metadata.file_type().is_file() || metadata.file_type().is_symlink()) {
                std::fs::remove_file(&target).map_err(|e| e.to_string())?;
            } else {
                return Err(format!(
                    "refusing to replace existing Codex path: {}",
                    target.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    symlink_file(&source, &target).map_err(|e| {
        format!(
            "failed to inherit Codex system file from {}: {}",
            source.display(),
            e
        )
    })
}

fn inherit_codex_system_files_from(home: &Path, system_home: &Path) -> Result<(), String> {
    // config.toml in the private home was generated by us before MCP settings
    // moved to CLI overrides, so it is the one path we may replace.
    link_codex_system_file(home, system_home, "config.toml", true)?;
    link_codex_system_file(home, system_home, ".env", false)?;
    link_codex_system_file(home, system_home, "auth.json", false)?;
    // Profile layers (`codex --profile <name>` reads `<name>.config.toml`).
    // A machine whose codex auth lives in a profile (e.g. a Bedrock provider
    // with the bearer token in .env, no ChatGPT login) needs these in the
    // isolated home or the agent boots into the sign-in screen.
    if let Ok(entries) = std::fs::read_dir(system_home) {
        for entry in entries.flatten() {
            let filename = entry.file_name();
            let name = filename.to_string_lossy();
            if name.ends_with(".config.toml") && entry.path().is_file() {
                link_codex_system_file(home, system_home, &name, true)?;
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
fn symlink_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, target)
}

fn claude_user_env_from(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("env").cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The provider channel from the user's Claude settings. Managed homes copy
/// only this block: Bedrock auth selection, region and model pins travel with
/// the agent, while plugins and unrelated user preferences do not.
pub(crate) fn claude_user_env() -> Value {
    let path = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude")
        .join("settings.json");
    claude_user_env_from(&path)
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
    std::fs::write(&path, format!("# tmux-mobile team launcher (regenerated on every launch)\n{}\n", full_cmd))
        .map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupConfirmation {
    pub(crate) markers: Vec<&'static str>,
    pub(crate) ready_markers: Vec<&'static str>,
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
    confirmation
        .ready_markers
        .iter()
        .any(|marker| content.contains(marker))
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
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The waiter's decision, on kimi's measured screens (board #224): the
    /// trust dialog is accepted once, a lingering dialog after the accept is
    /// not accepted again, the welcome box is ready, anything else waits.
    #[test]
    fn startup_step_accepts_once_then_waits_for_ready() {
        let c = StartupConfirmation {
            markers: vec!["Trust this folder?", "Don't trust"],
            ready_markers: vec!["Welcome to Kimi Code", "No session yet"],
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
        let dir = std::env::temp_dir().join(format!("tmm-launch-test-{}", std::process::id()));
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
    fn claude_channel_inherits_only_the_user_env_block() {
        let root = std::env::temp_dir().join(format!(
            "teamtest-claude-env-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(
            &settings,
            r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"1","AWS_REGION":"us-west-2"},"enabledPlugins":{"private":true},"theme":"light"}"#,
        )
        .unwrap();
        let inherited = claude_user_env_from(&settings);
        assert_eq!(inherited["CLAUDE_CODE_USE_BEDROCK"], "1");
        assert_eq!(inherited["AWS_REGION"], "us-west-2");
        assert!(inherited.get("enabledPlugins").is_none());
        assert!(inherited.get("theme").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_system_files_link_config_env_and_auth_idempotently() {
        let root = std::env::temp_dir().join(format!("teamtest-codex-system-{}", uuid::Uuid::new_v4()));
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
        let root = std::env::temp_dir().join(format!("teamtest-codex-no-auth-{}", uuid::Uuid::new_v4()));
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
        let root = std::env::temp_dir().join(format!("teamtest-codex-existing-auth-{}", uuid::Uuid::new_v4()));
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

        let remote_overrides = codex_mcp_overrides(&remote).join(" ");
        assert!(remote_overrides.contains("mcp_servers.gh.bearer_token_env_var"));
        assert!(remote_overrides.contains("API_TOKEN"));
        assert!(remote_overrides.contains("mcp_servers.gh.env_http_headers.X-Features"));
        assert!(remote_overrides.contains("FEATURES"));
        assert!(remote_overrides.contains("mcp_servers.gh.http_headers.X-Static"));
        assert!(!remote_overrides.contains("Bearer $API_TOKEN"));

        let local = McpDef { name: "pg".into(), command: Some("mcp-pg".into()), args: vec!["--stdio".into()], ..Default::default() };
        let overrides = codex_mcp_overrides(&local).join(" ");
        assert!(overrides.contains("mcp_servers.pg.command"));
        assert!(overrides.contains("mcp-pg"));
        assert!(overrides.contains("mcp_servers.pg.args"));
        assert!(overrides.contains("--stdio"));
    }

}
