//! The kimi backend's own knowledge (board #224): every fact about how Kimi
//! Code CLI is driven lives here — one file to touch when it changes.
//!
//! Kimi Code CLI 2.0.2 (`~/.kimi-code/bin/kimi`), measured 2026-09-20 on the
//! owner's Bedrock channel (`[providers.bedrock] type="openai"`, base_url
//! `https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1`, model
//! `global.moonshotai.kimi-k3`, key via `api_key_env = "KIMI_API_KEY"`):
//!
//! * `KIMI_CODE_HOME` relocates EVERYTHING (its data-locations doc): config,
//!   `AGENTS.md`, `mcp.json`, `tui.toml`, `sessions/`, `workspace-trust/`,
//!   credentials, logs. The isolated home is that directory.
//! * hooks are `[[hooks]]` rows of `config.toml` (event, optional matcher,
//!   command, timeout) — so the rendered config is OURS, and the user's
//!   `[providers]`/`[models]`/`default_model` are COPIED in (grok's catalog
//!   lesson: an isolated home without the provider table is a config error,
//!   not an agent). Payload keys snake_case: `hook_event_name`, `session_id`
//!   (`session_<uuid>`), `cwd`, `tool_name`, `tool_input`.
//! * `UserPromptSubmit.prompt` is an ARRAY of content parts
//!   (`[{type:"text",text}]`), not a string; `Stop` carries NO reply text
//!   (`stop_hook_active` only); `Interrupt` (reason `cancelled`) fires INSTEAD
//!   of `Stop` when Escape ends a turn; `StopFailure` on an API error.
//! * the reply is the last assistant message of the session wire —
//!   `sessions/<wdKey>/<sid>/agents/main/wire.jsonl`, `agent.message.appended`
//!   rows — which is already written when `Stop` fires (measured: the hook's
//!   own `grep -c` saw the message).
//! * `--auto` is Never Ask (unattended); `-S <id>` resumes exactly (same id,
//!   `SessionStart.source = "resume"`); `-c` continues the cwd's last session.
//! * the folder-trust screen ("Trust this folder?", Enter accepts) is
//!   remembered in `workspace-trust/wd_<basename>_<sha256(cwd)[:12]>` as
//!   `{"root","trustedAt"}` (hash verified against three real keys).
//! * an Enter glued to the text burst is swallowed as paste — codex's beat
//!   (tmux.rs) already covers it.

/// No queue|steer choice (board #245): kimi 2.0.2 always queues (Enter
/// while a turn runs queues; `tui.toml` has no key for it) — measured: the
/// queued line became its own turn with its own prompt hook and reply.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;

/// kimi `[thinking].effort` (its config-files doc): low / medium / high /
/// xhigh / max; bound as `thinkingEffort` in the wire (measured with `max`).
/// A model whose `support_efforts` lacks the value falls back to its default.
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh", "max"]
}

/// kimi models are ALIASES: the keys of the user's `[models]` table
/// (`default_model` and `-m` both name one). An alias kimi does not know is a
/// `config.invalid` error at startup, so the list is authoritative — a typo
/// is rejected at save time. `None` when there is no config to read.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    let text = std::fs::read_to_string(kimi_user_home().join("config.toml")).ok()?;
    let aliases = model_aliases(&text);
    (!aliases.is_empty()).then_some(aliases)
}

/// The alias keys of a kimi `config.toml`, in table order.
pub(crate) fn model_aliases(config: &str) -> Vec<String> {
    let Ok(table) = config.parse::<toml::Table>() else { return Vec::new() };
    table
        .get("models")
        .and_then(toml::Value::as_table)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// Where the user's own Kimi Code lives — `KIMI_CODE_HOME` when the user set
/// it, else `~/.kimi-code`. Only read, never written.
#[cfg(not(test))]
pub(crate) fn kimi_user_home() -> std::path::PathBuf {
    if let Some(h) = std::env::var_os("KIMI_CODE_HOME").filter(|h| !h.is_empty()) {
        return std::path::PathBuf::from(h);
    }
    std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join(".kimi-code")
}

/// Under test the user's home is a per-process temp dir (config.rs's
/// `dirs_next` pattern, board #216): a test that renders or validates must
/// never read — or depend on — the developer's real `~/.kimi-code`.
#[cfg(test)]
pub(crate) fn kimi_user_home() -> std::path::PathBuf {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    // Earlier runs' homes are reclaimed at the door (board #268).
    DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-kimi-user-home")).clone()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

/// kimi's status furniture (measured, 2.0.2, 100 and 44 columns): two footer
/// lines under the input box.
///
/// ```text
/// Never Ask  Kimi K3 on Bedrock thinking  /tmp/kimi-probe/ws  master [±]
///                                                  context: 2% (19.3k/1M)
/// ```
///
/// Line 1 is the `tui.toml [status_line].items` row — mode, model, cwd, git —
/// joined by TWO spaces; the model item is the alias's `display_name` with a
/// ` thinking` tail while thinking is on (the effort level is not painted).
/// On a narrow pane the cwd truncates and the git item drops; the model
/// survives. Line 2 is `context: N% (used/total)`, right-aligned; the literal
/// `context:` word is its anchor. The mode label heads line 1 and is the
/// anchor for the model reading: only the three permission modes
/// (`Never Ask`, `Ask When Needed`, `Always Ask`) start a footer, and the
/// model is the item before the cwd item — the one starting `/`, `~` or `…`
/// (measured live at ~52 columns: kimi paints the truncated cwd with a
/// LEADING ellipsis, `…/work/pr…`; anchoring on `/` alone read no model on
/// any phone-width pane, board #230).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_kimi(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    for line in pane.lines().rev() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if v.context_pct.is_none() {
            if let Some(pct) = kimi_context_item(line) {
                v.context_pct = Some(pct);
                continue;
            }
        }
        if v.model.is_none() {
            if let Some(model) = kimi_footer_model(line) {
                v.model = Some(model);
            }
        }
        if v.model.is_some() && v.context_pct.is_some() {
            break;
        }
    }
    v
}

/// `context: 2% (19.3k/1M)` → 2. The `context:` word and the `%` are both
/// required; a bare percentage in prose is never a reading.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kimi_context_item(line: &str) -> Option<u8> {
    let rest = line.trim().strip_prefix("context:")?.trim_start();
    let (num, tail) = rest.split_once('%')?;
    let n = num.trim().parse::<u16>().ok().filter(|n| *n <= 100)?;
    tail.trim_start().starts_with('(').then_some(n as u8)
}

/// The model out of the items row: the item before the cwd item, minus the
/// ` thinking` tail; `None` unless the row starts with a permission-mode
/// label and has a cwd item to anchor against. A truncated cwd keeps its
/// LEADING ellipsis (`…/work/pr…`), so `…` anchors like `/` and `~`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kimi_footer_model(line: &str) -> Option<String> {
    const MODES: [&str; 3] = ["Never Ask", "Ask When Needed", "Always Ask"];
    let items: Vec<&str> = line.trim().split("  ").map(str::trim).filter(|s| !s.is_empty()).collect();
    if items.len() < 3 || !MODES.contains(&items[0]) {
        return None;
    }
    let cwd = items.iter().position(|i| i.starts_with('/') || i.starts_with('~') || i.starts_with('…'))?;
    if cwd < 2 {
        return None;
    }
    let model = items[cwd - 1].strip_suffix(" thinking").unwrap_or(items[cwd - 1]).trim();
    (!model.is_empty()).then(|| model.to_string())
}

use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::Rendered;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// The events a managed kimi subscribes to — the same six the other
/// backends read, in kimi's own names. `Interrupt` is the Escape end of a
/// turn (fires INSTEAD of `Stop`); without it an interrupted turn never
/// closes. `timeout` is kimi's per-hook cap in seconds (default 30) — the
/// helper only appends one file, 5 s is generous.
pub(crate) const HOOK_EVENTS: [&str; 7] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "Interrupt",
];

/// The `[[hooks]]` rows as TOML values, one per event.
pub(crate) fn kimi_hooks(notify: &str) -> toml::value::Array {
    HOOK_EVENTS
        .iter()
        .map(|event| {
            let mut row = toml::value::Table::new();
            row.insert("event".into(), toml::Value::String((*event).to_string()));
            row.insert("command".into(), toml::Value::String(notify.to_string()));
            row.insert("timeout".into(), toml::Value::Integer(5));
            toml::Value::Table(row)
        })
        .collect()
}

/// The isolated home's `config.toml`: the user's provider/model catalog and
/// `default_model` carried over (auth is `api_key_env` — the env var reaches
/// the pane from the interactive shell — or a plain `api_key`, both inside the
/// copied provider table; nothing else of the user's file carries: hooks,
/// permission rules and UI prefs are what isolation is for), Never Ask as the
/// default mode (the launch line says `--auto` too), telemetry off, the
/// registry effort as `[thinking].effort`, and the telemetry hooks.
///
/// TRAP, paid for once on grok: toml 1.x parses a DOCUMENT via
/// `toml::Table`; `Value::from_str` fails on any real config.
pub(crate) fn kimi_config_toml_from(user_config: Option<&str>, effort: &str, notify: &str) -> String {
    let mut root = toml::value::Table::new();
    if let Some(user) = user_config.and_then(|t| t.parse::<toml::Table>().ok()) {
        for key in ["default_model", "providers", "models"] {
            if let Some(v) = user.get(key) {
                root.insert(key.into(), v.clone());
            }
        }
    }
    root.insert("default_permission_mode".into(), toml::Value::String("auto".into()));
    root.insert("telemetry".into(), toml::Value::Boolean(false));
    let effort = effort.trim();
    if !effort.is_empty() {
        let mut thinking = toml::value::Table::new();
        thinking.insert("enabled".into(), toml::Value::Boolean(true));
        thinking.insert("effort".into(), toml::Value::String(effort.to_string()));
        root.insert("thinking".into(), toml::Value::Table(thinking));
    }
    root.insert("hooks".into(), toml::Value::Array(kimi_hooks(notify)));
    let body = toml::to_string(&root).unwrap_or_default();
    format!("# Written by tmux-mobile — regenerated at every spawn and restart.\n{body}")
}

/// `tui.toml` for an UNATTENDED pane: no self-update (a restart replays the
/// recipe; an update mid-session is a surprise nobody watches), no "cache
/// expired" dialog on resume (a modal nobody sees, blocking the composer),
/// no rating prompt, no desktop notifications (the Hub has its own).
pub(crate) fn kimi_tui_toml() -> &'static str {
    "# Written by tmux-mobile — regenerated at every spawn and restart.\n\
     cache_expiry_hint = false\n\
     disable_feedback_survey = true\n\n\
     [notifications]\nenabled = false\n\n\
     [upgrade]\nauto_install = false\n"
}

/// kimi's `workspace-trust/<key>` file name for a working directory:
/// `wd_<basename>_<sha256(path)[:12]>` (its data-locations doc calls it the
/// `workDirKey`; the hash half verified against three keys kimi wrote).
pub(crate) fn workspace_trust_key(workspace: &str) -> String {
    use sha2::Digest;
    let base = std::path::Path::new(workspace)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let digest = sha2::Sha256::digest(workspace.as_bytes());
    format!("wd_{base}_{}", &hex::encode(digest)[..12])
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_kimi(
    def: &RegAgent, _name: &str, home: &Path, workspace: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    let kimi_home = home.join("kimi");
    std::fs::create_dir_all(kimi_home.join("workspace-trust")).map_err(|e| e.to_string())?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("kimi");

    let user_config = std::fs::read_to_string(kimi_user_home().join("config.toml")).ok();
    std::fs::write(
        kimi_home.join("config.toml"),
        kimi_config_toml_from(user_config.as_deref(), &def.effort, &notify),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(kimi_home.join("tui.toml"), kimi_tui_toml()).map_err(|e| e.to_string())?;

    // The prompt is a FILE (codex's pattern): kimi reads `$KIMI_CODE_HOME/
    // AGENTS.md` as its global instructions on every start, and this home is
    // ours to write. Skills have no isolated-home mechanism we control, so the
    // compact index rides the prompt like everywhere else.
    let full_prompt = if skills.is_empty() {
        system_prompt.to_string()
    } else {
        format!("{}\n\n{}", system_prompt, crate::projects::skills::skills_index_text(skills))
    };
    std::fs::write(kimi_home.join("AGENTS.md"), &full_prompt).map_err(|e| e.to_string())?;

    // mcp.json in this home's user scope — `{command,args,env}` / `{url,
    // headers}`, kiro's shape (kimi's mcp doc: no `type` key).
    let mut servers = serde_json::Map::new();
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            servers.insert(m.name.clone(), shared::kiro_mcp_value(m));
        }
    }
    // No servers removes the file: a revoked server must not stay loaded.
    let mcp = (!servers.is_empty()).then(|| serde_json::to_string_pretty(&json!({ "mcpServers": servers })).unwrap());
    shared::write_owned(&kimi_home.join("mcp.json"), mcp.as_deref())?;

    // Folder trust, PRESEEDED: the workspace is the user's own project,
    // spawned deliberately, and the trust screen would otherwise sit in a
    // pane nobody watches. Canonical path, because kimi hashes the cwd as the
    // process sees it. A key that does not match (kimi changes its slug
    // rule) only means the screen shows and the confirmer below answers it.
    let canonical = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let ws = canonical.to_string_lossy();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let trust = kimi_home.join("workspace-trust").join(workspace_trust_key(&ws));
    if !trust.is_file() {
        std::fs::write(&trust, serde_json::to_string(&json!({ "root": ws, "trustedAt": now_ms })).unwrap())
            .map_err(|e| e.to_string())?;
    }

    // `-m <alias>` only when the registry pins one; empty = the user's own
    // `default_model`, carried in the config above. The alias was validated
    // against the user's `[models]` at save time (`models_fetch`).
    let mut cmd = String::from("command kimi --auto");
    let model = def.model.trim();
    if !model.is_empty() {
        cmd.push_str(&format!(" -m {}", crate::shell::quote(model)));
    }
    Ok(Rendered {
        env: vec![
            ("KIMI_CODE_HOME".into(), kimi_home.to_string_lossy().to_string()),
            // Belt to tui.toml's braces: the documented env switch disables
            // the update preflight entirely (no check, no prompt).
            ("KIMI_CODE_NO_AUTO_UPDATE".into(), "1".into()),
        ],
        cmd,
        confirmation: Some(shared::StartupConfirmation {
            markers: KIMI_FOLDER_TRUST_MARKERS.to_vec(),
            ready_markers: vec!["Welcome to Kimi Code", "No session yet"],
            accept_keys: vec!["Enter"],
            timeout: std::time::Duration::from_secs(120),
        }),
    })
}

/// kimi 2.0.2's trust screen (measured): the cursor rests on "Trust this
/// folder", so Enter accepts.
pub(crate) const KIMI_FOLDER_TRUST_MARKERS: &[&str] = &["Trust this folder?", "Don't trust"];

/// The kimi half of `refresh_hooks`: the hooks are an array INSIDE our own
/// config.toml, so the array is replaced and everything else (the carried
/// catalog, the effort) left alone. A no-op when it already matches.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> bool {
    let path = home.join("kimi").join("config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    let Ok(mut root) = text.parse::<toml::Table>() else { return false };
    let fresh = toml::Value::Array(kimi_hooks(notify));
    if root.get("hooks") == Some(&fresh) {
        return false;
    }
    root.insert("hooks".into(), fresh);
    let Ok(body) = toml::to_string(&root) else { return false };
    std::fs::write(&path, format!("# Written by tmux-mobile — regenerated at every spawn and restart.\n{body}")).is_ok()
}

/// kimi resume dialect: `-S <id>` exact, `-c` the cwd's previous session
/// (scoped to the isolated home, so it cannot cross into another agent's).
/// The exact-resume line, shared by `resume_command` and `resume_exact` (board #422).
fn exact_line(cmd: &str, id: &str) -> String {
    format!("{cmd} -S {}", crate::shell::quote(id))
}

/// The strict form for a restore after a reboot (board #422): `Some` only
/// when the exact id is on the line.
pub(crate) fn resume_exact(cmd: &str, id: &str) -> Option<String> {
    (!cmd.trim().is_empty() && super::shared::exact_id_ok(id)).then(|| exact_line(cmd, id))
}

pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    match id {
        Some(id) => exact_line(cmd, id),
        None => format!("{cmd} -c"),
    }
}

/// This backend's detection/relaunch row (board #129). Kimi Code 2.0.2 is one
/// `kimi` binary (`pane_current_command` says "kimi"); `-c` is cwd-scoped
/// ("Continue the previous session for the working directory"), `-S <id>`
/// exact. Recipe dialect: `resume_command` above.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on kimi 2.0.2:
/// `/goal <args>` is echoed as the ARGUMENTS alone; `/usage` fires nothing.
/// Only `/goal` is declared: an args-only echo of any other command would be
/// a bare word that ordinary prose could contain.
pub(crate) fn command_echo(name: &str, args: &str) -> Option<String> {
    (name == "/goal" && !args.is_empty()).then(|| args.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "kimi",
        programs: &["kimi", "kimi-code"],
        launch: "kimi",
        resume_recent: Some("kimi -c"),
        resume_id: Some("kimi -S {id}"),
        versioned_binary_dir: None,
    }
}

/// kimi's hook payload dialect (measured 2.0.2): claude's key spelling.
/// `Stop` ends a turn; so does `Interrupt` (Escape — fires in place of Stop,
/// and a turn that never closes would pin the agent at `working`);
/// `StopFailure` is the API-error end; `PermissionRequest` the ask (never
/// seen under `--auto`, kept for a home the user switched to a manual mode).
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    match event.as_deref() {
        Some("Stop") | Some("Interrupt") => Ok("completed"),
        Some("StopFailure") => Ok("failed"),
        Some("PermissionRequest") => Ok("permission_required"),
        _ => Err("unsupported Kimi event".into()),
    }
}

/// kimi spells the turn-start event like claude/codex (measured).
pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))
}

/// The final assistant text of the LAST turn in a session wire. Rows are
/// `agent.message.appended` with `message.message.{role,content}`; a turn
/// begins at `turn.prompt`. The reply is the last assistant message with
/// text after the last prompt (an interrupted turn that produced none yields
/// `None`, never an older turn's answer). `think` parts are not the reply.
pub(crate) fn kimi_reply_from_wire(jsonl: &str) -> Option<String> {
    let mut reply: Option<String> = None;
    for line in jsonl.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        match row.get("type").and_then(Value::as_str) {
            Some("turn.prompt") => reply = None,
            Some("agent.message.appended") => {
                let Some(msg) = row.pointer("/message/message") else { continue };
                if msg.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                let text = crate::agent_notifications::content_text(msg.get("content").unwrap_or(&Value::Null));
                let text = text.trim();
                if text.chars().any(char::is_alphanumeric) {
                    reply = Some(text.to_string());
                }
            }
            _ => {}
        }
    }
    reply
}

/// The session's wire inside ONE managed kimi home (`<agent home>/kimi`):
/// its `session_index.jsonl` maps `{sessionId, sessionDir, workDir}` per
/// line, and the wire is `<sessionDir>/agents/main/wire.jsonl`. The home is
/// resolved by the agent's NAME at the call site (pane → window →
/// `managed_home`), never by searching the workspace: two kimi agents in one
/// project must not be able to read each other's session.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn session_reply(kimi_home: &Path, session_id: &str) -> Option<String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return None;
    }
    let text = std::fs::read_to_string(kimi_home.join("session_index.jsonl")).ok()?;
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        if row.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        let Some(dir) = row.get("sessionDir").and_then(Value::as_str) else { continue };
        let wire = Path::new(dir).join("agents").join("main").join("wire.jsonl");
        if let Ok(text) = std::fs::read_to_string(&wire) {
            if let Some(reply) = kimi_reply_from_wire(&text) {
                return Some(reply);
            }
        }
    }
    None
}

/// The reply fallback wired into the notify path: kimi's Stop has no text,
/// the wire has. `home` is the agent's managed home (`<ws>/.tmm/agents/
/// <name>`); an unmanaged window has none and gets no reply.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn reply_fallback(payload: &serde_json::Map<String, Value>, home: &Path) -> Option<String> {
    let id = crate::agent_notifications::string_field(payload, &["session_id"])?;
    session_reply(&home.join("kimi"), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The measured 2.0.2 payload shapes: a Stop and an Interrupt both end
    /// the turn, StopFailure fails it, the prompt event is recognised, and
    /// an unknown event is refused.
    #[test]
    fn hook_dialect_measured_on_2_0_2() {
        let stop = json!({"hook_event_name":"Stop","session_id":"session_e855c5d9-b204-4ec3-971d-c84c015e4b4a","cwd":"/tmp/ws","client_type":"kimi_code_cli","stop_hook_active":false});
        assert_eq!(normalize_kind(stop.as_object().unwrap()), Ok("completed"));
        let interrupt = json!({"hook_event_name":"Interrupt","session_id":"session_x","cwd":"/tmp/ws","turn_id":2,"reason":"cancelled"});
        assert_eq!(normalize_kind(interrupt.as_object().unwrap()), Ok("completed"), "Escape ends the turn in place of Stop");
        let failure = json!({"hook_event_name":"StopFailure","session_id":"session_x","cwd":"/tmp/ws"});
        assert_eq!(normalize_kind(failure.as_object().unwrap()), Ok("failed"));
        let ask = json!({"hook_event_name":"PermissionRequest","tool_name":"Bash"});
        assert_eq!(normalize_kind(ask.as_object().unwrap()), Ok("permission_required"));
        for other in ["SessionStart", "TurnStarted", "SessionEnd", "PostToolUse"] {
            assert!(normalize_kind(json!({"hook_event_name": other}).as_object().unwrap()).is_err(), "{other}");
        }
        let prompt = json!({"hook_event_name":"UserPromptSubmit","session_id":"session_x","cwd":"/tmp/ws","prompt":[{"type":"text","text":"Reply with exactly the word PONG."}],"is_steer":false});
        assert!(is_user_prompt_submit(&prompt));
        assert_eq!(
            crate::agent_notifications::prompt_text(&prompt).as_deref(),
            Some("Reply with exactly the word PONG."),
            "the prompt is an array of parts"
        );
        assert!(!is_user_prompt_submit(&stop));
    }

    /// The wire (measured): the reply is the last assistant text after the
    /// last prompt; think parts and tool rows are not it; a turn interrupted
    /// before any text yields nothing rather than the previous answer.
    #[test]
    fn reply_is_the_last_turns_final_assistant_text() {
        let wire = concat!(
            r#"{"type":"metadata","protocol_version":"1.5"}"#, "\n",
            r#"{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"Read a.txt"}],"turnId":0}"#, "\n",
            r#"{"message":{"message":{"role":"user","content":[{"type":"text","text":"Read a.txt"}]},"meta":{"source":"input"}},"type":"agent.message.appended","kind":"event"}"#, "\n",
            r#"{"message":{"message":{"role":"assistant","content":[{"type":"think","think":"Let me read it."}],"toolCalls":[{"id":"Read_0","name":"Read"}]}},"type":"agent.message.appended","kind":"event"}"#, "\n",
            r#"{"message":{"message":{"role":"tool","content":[{"type":"text","text":"1\thi"}],"toolCallId":"Read_0"}},"type":"agent.message.appended","kind":"event"}"#, "\n",
            r#"{"message":{"message":{"role":"assistant","content":[{"type":"think","think":"It says hi."},{"type":"text","text":"PONG"}],"toolCalls":[]}},"type":"agent.message.appended","kind":"event"}"#, "\n",
            r#"{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed"}"#, "\n",
        );
        assert_eq!(kimi_reply_from_wire(wire).as_deref(), Some("PONG"));
        let interrupted = format!(
            "{wire}{}\n{}\n",
            r#"{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"sleep 40"}],"turnId":1}"#,
            r#"{"message":{"message":{"role":"assistant","content":[{"type":"think","think":"Running it."}],"toolCalls":[{"id":"Bash_0","name":"Bash"}]}},"type":"agent.message.appended","kind":"event"}"#,
        );
        assert_eq!(kimi_reply_from_wire(&interrupted), None, "no text in the interrupted turn — not the old PONG");
        assert_eq!(kimi_reply_from_wire("not json\n"), None);
    }

    /// `session_reply` follows ONE home's index to the wire; a foreign or
    /// malformed id finds nothing, and a sibling agent's home is never read.
    #[test]
    fn session_reply_follows_this_homes_index_only() {
        let ws = std::env::temp_dir().join(format!("tmm-kimi-reply-{}", uuid::Uuid::new_v4()));
        let write_home = |name: &str, reply: &str| {
            let home = ws.join(".tmm").join("agents").join(name);
            let kimi = home.join("kimi");
            let sdir = kimi.join("sessions").join("wd_x_000000000000").join("session_abc");
            std::fs::create_dir_all(sdir.join("agents").join("main")).unwrap();
            std::fs::write(
                kimi.join("session_index.jsonl"),
                format!(
                    "{}\n",
                    json!({"sessionId":"session_abc","sessionDir":sdir.to_string_lossy(),"workDir":ws.to_string_lossy()})
                ),
            )
            .unwrap();
            std::fs::write(
                sdir.join("agents").join("main").join("wire.jsonl"),
                format!(
                    "{}\n{}\n",
                    r#"{"type":"turn.prompt","input":[{"type":"text","text":"hi"}]}"#,
                    json!({"message":{"message":{"role":"assistant","content":[{"type":"text","text":reply}]}},"type":"agent.message.appended"})
                ),
            )
            .unwrap();
            home
        };
        let k1 = write_home("k1", "Hello from k1.");
        let k2 = write_home("k2", "Hello from k2.");
        assert_eq!(session_reply(&k1.join("kimi"), "session_abc").as_deref(), Some("Hello from k1."));
        assert_eq!(session_reply(&k2.join("kimi"), "session_abc").as_deref(), Some("Hello from k2."));
        assert_eq!(session_reply(&k1.join("kimi"), "session_other"), None);
        assert_eq!(session_reply(&k1.join("kimi"), "../session_abc"), None);
        let payload = json!({"hook_event_name":"Stop","session_id":"session_abc","cwd":ws.to_string_lossy()});
        assert_eq!(reply_fallback(payload.as_object().unwrap(), &k1).as_deref(), Some("Hello from k1."));
        assert_eq!(reply_fallback(payload.as_object().unwrap(), &ws.join("nowhere")), None);
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// The two footer lines as measured at 100 and 44 columns; prose with a
    /// path or a percentage is not a reading.
    #[test]
    fn sniff_reads_the_measured_footer() {
        let wide = "\n ╭──╮\n │ >  │\n ╰──╯\n Never Ask  Kimi K3 on Bedrock thinking  /tmp/kimi-probe/ws  master [±]\n                                                                             context: 2% (19.3k/1M)\n";
        let v = sniff_kimi(wide);
        assert_eq!(v.model.as_deref(), Some("Kimi K3 on Bedrock"));
        assert_eq!(v.context_pct, Some(2));
        assert_eq!(v.effort, None, "kimi paints no effort level");
        let narrow = " Never Ask  Kimi K3 on Bedrock thinking  /…\n                     context: 0% (0/1M)\n";
        let v = sniff_kimi(narrow);
        assert_eq!(v.model.as_deref(), Some("Kimi K3 on Bedrock"));
        assert_eq!(v.context_pct, Some(0));
        // Measured live at ~52 columns (board #230): the truncated cwd keeps a
        // LEADING ellipsis, not a leading slash — the anchor must read it.
        let phone = " Never Ask  Kimi K3 on Bedrock thinking  …/work/pr…\n                             context: 21% (212k/1M)\n";
        let v = sniff_kimi(phone);
        assert_eq!(v.model.as_deref(), Some("Kimi K3 on Bedrock"));
        assert_eq!(v.context_pct, Some(21));
        let busy = " Never Ask  Kimi K3 on Bedrock thinking  /tmp/kimi-probe/ws  master [±]              ctrl+c: cancel\n";
        assert_eq!(sniff_kimi(busy).model.as_deref(), Some("Kimi K3 on Bedrock"));
        let no_thinking = " Ask When Needed  Kimi K3 on Bedrock  ~/work  main\n";
        assert_eq!(sniff_kimi(no_thinking).model.as_deref(), Some("Kimi K3 on Bedrock"));
        let prose = " I read /tmp/kimi-probe/ws and it is 2% done  really\n context 5% of the way\n";
        assert!(sniff_kimi(prose).is_empty());
        assert_eq!(kimi_context_item("context: 100% (1M/1M)"), Some(100));
        assert_eq!(kimi_context_item("context: 101% (x)"), None);
    }

    /// The rendered config carries ONLY the catalog half of the user's file,
    /// sets the unattended mode, the effort and the hooks; `refresh` swaps
    /// the hooks array and nothing else; the trust key matches kimi's own.
    #[test]
    fn config_carries_catalog_and_hooks_and_refresh_swaps_hooks_only() {
        let user = r#"default_model = "bedrock-kimi-k3"
default_permission_mode = "manual"
telemetry = true

[providers.bedrock]
type = "openai"
base_url = "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1"
api_key_env = "KIMI_API_KEY"

[models.bedrock-kimi-k3]
provider = "bedrock"
model = "global.moonshotai.kimi-k3"
max_context_size = 1048576

[[hooks]]
event = "Notification"
command = "terminal-notifier"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"
"#;
        let cfg = kimi_config_toml_from(Some(user), "high", "/bin/sh helper kimi # tmm");
        let t: toml::Table = cfg.parse().unwrap();
        assert_eq!(t["default_model"].as_str(), Some("bedrock-kimi-k3"));
        assert_eq!(t["default_permission_mode"].as_str(), Some("auto"));
        assert_eq!(t["telemetry"].as_bool(), Some(false));
        assert_eq!(t["providers"]["bedrock"]["api_key_env"].as_str(), Some("KIMI_API_KEY"));
        assert_eq!(t["models"]["bedrock-kimi-k3"]["model"].as_str(), Some("global.moonshotai.kimi-k3"));
        assert_eq!(t["thinking"]["effort"].as_str(), Some("high"));
        assert!(t.get("permission").is_none(), "the user's rules do not carry");
        let hooks = t["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len(), "the user's Notification hook is replaced by ours");
        assert!(hooks.iter().all(|h| h["command"].as_str() == Some("/bin/sh helper kimi # tmm")));
        assert!(hooks.iter().any(|h| h["event"].as_str() == Some("Interrupt")));
        assert_eq!(model_aliases(user), vec!["bedrock-kimi-k3".to_string()]);
        assert!(model_aliases("not = [toml").is_empty());
        let plain = kimi_config_toml_from(None, "", "x");
        let t: toml::Table = plain.parse().unwrap();
        assert!(t.get("thinking").is_none() && t.get("models").is_none());

        let dir = std::env::temp_dir().join(format!("tmm-kimi-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("kimi")).unwrap();
        std::fs::write(dir.join("kimi").join("config.toml"), &cfg).unwrap();
        assert!(!refresh(&dir, "/bin/sh helper kimi # tmm"), "same hooks: no rewrite");
        assert!(refresh(&dir, "/bin/sh moved kimi # tmm"));
        let t: toml::Table = std::fs::read_to_string(dir.join("kimi").join("config.toml")).unwrap().parse().unwrap();
        assert!(t["hooks"].as_array().unwrap().iter().all(|h| h["command"].as_str() == Some("/bin/sh moved kimi # tmm")));
        assert_eq!(t["thinking"]["effort"].as_str(), Some("high"), "the rest survives");
        assert_eq!(t["models"]["bedrock-kimi-k3"]["provider"].as_str(), Some("bedrock"));
        let _ = std::fs::remove_dir_all(&dir);

        // Three keys kimi wrote on this host (workspaces.json ↔ workspace-trust/).
        assert_eq!(workspace_trust_key("/tmp/kimi-probe/ws"), "wd_ws_8134d477aa6a");
        assert_eq!(workspace_trust_key("/local/home/cfu/work/projects/learn-english"), "wd_learn-english_13c0722d7b09");
        assert_eq!(workspace_trust_key("/local/home/cfu"), "wd_cfu_b1525dd5ffa6");
    }

    /// `render_kimi` end to end against a fake user home: the isolated home
    /// carries the catalog, the prompt, the MCP shim, the quiet tui.toml and a
    /// preseeded trust file; the launch line pins the alias and Never Ask;
    /// `models_fetch` validates against the same fake catalog.
    #[test]
    fn render_writes_the_isolated_home_and_the_launch_line() {
        std::fs::write(
            kimi_user_home().join("config.toml"),
            "default_model = \"bedrock-kimi-k3\"\n[providers.bedrock]\ntype = \"openai\"\napi_key_env = \"KIMI_API_KEY\"\n[models.bedrock-kimi-k3]\nprovider = \"bedrock\"\nmodel = \"global.moonshotai.kimi-k3\"\nmax_context_size = 1048576\n",
        )
        .unwrap();
        assert_eq!(models_fetch(), Some(vec!["bedrock-kimi-k3".to_string()]));

        let ws = std::env::temp_dir().join(format!("tmm-kimi-render-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).unwrap();
        let home = ws.join(".tmm").join("agents").join("k1");
        let def = RegAgent {
            name: "k1".into(),
            backend: "kimi".into(),
            model: "bedrock-kimi-k3".into(),
            effort: "high".into(),
            input_mode: "queue".into(),
            system: String::new(),
            skills: "[]".into(),
            mcp: r#"[{"name":"kiro-web-search","command":"uvx","args":["kiro-web-search==0.1.3"]}]"#.into(),
        };
        let r = render_kimi(&def, "k1", &home, &ws, "You are k1.", &[]).unwrap();
        assert_eq!(r.cmd, "command kimi --auto -m bedrock-kimi-k3");
        let kimi = home.join("kimi");
        assert!(r.env.iter().any(|(k, v)| k == "KIMI_CODE_HOME" && *v == kimi.to_string_lossy()));
        assert!(r.env.iter().any(|(k, v)| k == "KIMI_CODE_NO_AUTO_UPDATE" && v == "1"));
        let c = r.confirmation.expect("the trust screen has a confirmer");
        assert_eq!(c.markers, KIMI_FOLDER_TRUST_MARKERS.to_vec());
        assert_eq!(c.accept_keys, vec!["Enter"]);
        assert!(!c.ready_markers.is_empty(), "a Typed first prompt needs ready markers to wait for");
        assert_eq!(std::fs::read_to_string(kimi.join("AGENTS.md")).unwrap(), "You are k1.");
        let cfg: toml::Table = std::fs::read_to_string(kimi.join("config.toml")).unwrap().parse().unwrap();
        assert_eq!(cfg["default_model"].as_str(), Some("bedrock-kimi-k3"));
        assert_eq!(cfg["providers"]["bedrock"]["api_key_env"].as_str(), Some("KIMI_API_KEY"));
        assert_eq!(cfg["thinking"]["effort"].as_str(), Some("high"));
        assert_eq!(cfg["hooks"].as_array().unwrap().len(), HOOK_EVENTS.len());
        let mcp: Value = serde_json::from_str(&std::fs::read_to_string(kimi.join("mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["kiro-web-search"]["command"], "uvx");
        assert!(mcp["mcpServers"]["kiro-web-search"].get("type").is_none(), "kimi's shape has no type key");
        assert!(std::fs::read_to_string(kimi.join("tui.toml")).unwrap().contains("auto_install = false"));
        let canonical = ws.canonicalize().unwrap();
        let trust = kimi.join("workspace-trust").join(workspace_trust_key(&canonical.to_string_lossy()));
        let t: Value = serde_json::from_str(&std::fs::read_to_string(&trust).unwrap()).unwrap();
        assert_eq!(t["root"], canonical.to_string_lossy().as_ref());
        assert!(t["trustedAt"].as_u64().unwrap() > 0);

        // Empty model and effort: no `-m`, no [thinking]; the user's
        // default_model still carries.
        let plain = RegAgent { model: String::new(), effort: String::new(), mcp: "[]".into(), ..def };
        let r = render_kimi(&plain, "k1", &home, &ws, "You are k1.", &[]).unwrap();
        assert_eq!(r.cmd, "command kimi --auto");
        let cfg: toml::Table = std::fs::read_to_string(kimi.join("config.toml")).unwrap().parse().unwrap();
        assert!(cfg.get("thinking").is_none());
        assert_eq!(cfg["default_model"].as_str(), Some("bedrock-kimi-k3"));
        assert!(!kimi.join("mcp.json").exists(), "an emptied MCP set re-renders to NO mcp.json, not the old servers (#241)");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn resume_dialect() {
        assert_eq!(resume_command("command kimi --auto", Some("session_ab c")), "command kimi --auto -S 'session_ab c'");
        assert_eq!(resume_command("command kimi --auto -m k3", None), "command kimi --auto -m k3 -c");
    }
}
