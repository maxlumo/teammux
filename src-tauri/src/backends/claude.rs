//! The claude backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// No queue|steer choice (board #245, measured on claude 2.1.283): a line
/// typed while claude runs tools is passed into the SAME turn at the next tool
/// boundary, and the documented `chat:queueSubmit` binding (`keybindings.json`
/// under CLAUDE_CONFIG_DIR, read) does exactly the same for a delivered line:
/// its prompt hook fired at typing time and one Stop answered both senders.
/// Claude has no mode in which a queued line becomes its own turn.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;

/// What releases a restored claude window (board #422 round 3): its
/// `SessionStart`, of any source — measured on Claude Code 2.1.303, a line
/// typed the moment it fires was submitted (agents-overview.md).
pub(crate) const RESTORE_EVIDENCE: Option<super::RestoreEvidence> = Some(super::RestoreEvidence::SessionStart);

/// Claude's own warning text names its effort levels: "Valid values: low,
/// medium, high, xhigh, max" (claude 2.1.239, measured 2026-08-22).
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh", "max"]
}

/// Claude takes model aliases nobody can enumerate — no authoritative list,
/// so no validation (soft degradation, models.rs module doc).
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::{context_pct, Vitals, EFFORTS};

/// Format Claude Code's official statusLine JSON into one compact, stable row.
/// This is invoked by the local `tmm claude-statusline` command configured in
/// Claude settings. The `[CC]` anchor is intentionally unique: `sniff_claude`
/// can read the pane without guessing from ordinary conversation text.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn claude_status_line(input: &str) -> Option<String> {
    let data: serde_json::Value = serde_json::from_str(input).ok()?;
    let model = data
        .pointer("/model/display_name")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| data.pointer("/model/id").and_then(serde_json::Value::as_str))?
        .trim();
    let model = if model.ends_with("context)") {
        model.rfind(" (").map(|i| &model[..i]).unwrap_or(model)
    } else {
        model
    };
    let context = data.get("context_window").and_then(serde_json::Value::as_object);
    let pct = context
        .and_then(|c| c.get("used_percentage"))
        .and_then(serde_json::Value::as_f64)
        .map(|pct| pct.round().clamp(0.0, 100.0) as u8);
    let used = context
        .and_then(|c| c.get("total_input_tokens"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let size = context
        .and_then(|c| c.get("context_window_size"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

    let mut parts = vec!["[CC]".to_string(), model.to_string()];
    if let Some(pct) = pct {
        // Percentage comes BEFORE counts so a narrow pane still preserves the
        // field the card needs; Claude may truncate the right side of the row.
        parts.push(format!("{pct}% ctx"));
        if size > 0 {
            parts.push(format!("{}/{}", short_tokens(used), short_tokens(size)));
        }
    }
    if let Some(effort) = data
        .pointer("/effort/level")
        .and_then(serde_json::Value::as_str)
        .filter(|e| EFFORTS.contains(e))
    {
        parts.push(format!("effort {effort}"));
    }
    Some(parts.join(" · "))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn short_tokens(tokens: u64) -> String {
    fn scaled(tokens: u64, unit: u64, suffix: char) -> String {
        if tokens % unit == 0 {
            format!("{}{suffix}", tokens / unit)
        } else {
            let value = tokens as f64 / unit as f64;
            format!("{value:.1}{suffix}")
        }
    }
    if tokens >= 1_000_000 {
        scaled(tokens, 1_000_000, 'M')
    } else if tokens >= 1_000 {
        scaled(tokens, 1_000, 'K')
    } else {
        tokens.to_string()
    }
}

/// Read the canonical row produced by `tmm claude-statusline`.
///
/// Claude's built-in footer is not a stable machine format; statusLine is its
/// official extension point and hands us exact model/context data. Parsing only
/// our `[CC]` row makes ordinary output (including pasted examples) inert.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_claude(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    for line in pane.lines().rev().take(24) {
        let segs: Vec<&str> = line
            .trim()
            .split('·')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if segs.first() != Some(&"[CC]") {
            continue;
        }
        if let Some(model) = segs.get(1).filter(|s| !s.is_empty()) {
            v.model = Some((*model).to_string());
        }
        for seg in &segs[2..] {
            if v.context_pct.is_none() {
                v.context_pct = context_pct(seg);
            }
            if v.effort.is_none() {
                v.effort = seg
                    .strip_prefix("effort ")
                    .filter(|e| EFFORTS.contains(e))
                    .map(str::to_string);
            }
        }
        v.effort_definitive = v.context_pct.is_some();
        break;
    }
    v
}


use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::{effort_flag, patch_hooks, Rendered};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn claude_hooks(notify: &str) -> Value {
    json!({
        "PreToolUse":  [ { "matcher": "*", "hooks": [ { "type": "command", "command": notify } ] } ],
        "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": notify } ] } ],
        // Turn start — resets the same-turn dedup flag and carries the
        // submitted prompt (the delivery receipt). Shipping Stop WITHOUT this
        // made the flag sticky: the first `tmm send` killed the auto-post for
        // every later turn of that window, and lines typed by
        // `deliver_mentions` were never acked (hollow ring forever). Kiro and
        // grok had it; claude and codex did not (owner, 2026-08-22: 对齐).
        "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "Notification": [ { "matcher": "permission_prompt|agent_needs_input|agent_completed", "hooks": [ { "type": "command", "command": notify } ] } ],
        "Stop": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "StopFailure": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        // A restored window's release evidence (board #422 round 3, measured
        // on 2.1.303: a line typed right after it is read). Never a turn fact.
        "SessionStart": [ { "hooks": [ { "type": "command", "command": notify } ] } ]
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn claude_trust_key(workspace: &Path) -> PathBuf {
    let start = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    start
        .ancestors()
        .find(|path| path.join(".git").exists())
        .unwrap_or(&start)
        .to_path_buf()
}

/// Materialize onboarding + workspace trust in an isolated managed Claude home.
/// Claude's official permissions docs name this exact persisted shape. Merge,
/// never replace: `.claude.json` also owns session history, usage and UI state.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_claude_state(home: &Path, workspace: &Path) -> Result<bool, String> {
    let path = home.join(".claude.json");
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let obj = root.as_object_mut().expect("filtered to object");
    let mut changed = !path.is_file();
    if obj.get("hasCompletedOnboarding") != Some(&json!(true)) {
        obj.insert("hasCompletedOnboarding".into(), json!(true));
        changed = true;
    }
    if !obj.contains_key("theme") {
        obj.insert("theme".into(), json!("dark"));
        changed = true;
    }
    if !obj.get("projects").is_some_and(Value::is_object) {
        obj.insert("projects".into(), json!({}));
        changed = true;
    }
    let trust_key = claude_trust_key(workspace).to_string_lossy().into_owned();
    let projects = obj.get_mut("projects").and_then(Value::as_object_mut).unwrap();
    let entry = projects.entry(trust_key).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
        changed = true;
    }
    let project = entry.as_object_mut().unwrap();
    if project.get("hasTrustDialogAccepted") != Some(&json!(true)) {
        project.insert("hasTrustDialogAccepted".into(), json!(true));
        changed = true;
    }
    if changed {
        let text = format!("{}\n", serde_json::to_string_pretty(&root).unwrap());
        std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).map_err(|e| e.to_string())?.permissions().mode() & 0o777;
        if mode != 0o600 {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("chmod {}: {e}", path.display()))?;
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_claude(
    def: &RegAgent, _name: &str, home: &Path, workspace: &Path,
    system_prompt: &str, skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("claude");

    let mut mcp_servers = json!({});
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            mcp_servers.as_object_mut().unwrap().insert(m.name.clone(), shared::claude_mcp_value(m));
        }
    }
    let mcpfile = home.join("mcp.json");
    std::fs::write(&mcpfile, serde_json::to_string_pretty(&json!({ "mcpServers": mcp_servers })).unwrap())
        .map_err(|e| e.to_string())?;
    // The isolated home is the agent's CLAUDE_CONFIG_DIR (claude's KIRO_HOME:
    // history, session state and .claude.json live here, so a managed agent
    // never leaks into the user's ~/.claude). That relocation also means the
    // USER's settings layer is no longer read — so the channel config is
    // INHERITED: the `env` block of ~/.claude/settings.json (the Bedrock
    // switch: CLAUDE_CODE_USE_BEDROCK/AWS_REGION/ANTHROPIC_MODEL…) is copied
    // into the isolated settings.json, grok's "auth carries, prefs do not"
    // pattern in claude's dialect (owner, 2026-08-22: "都用bedrock渠道…复用
    // 我们全局定义的配置 但是自己管理好类似kirohome这种"). Plugins and
    // marketplaces deliberately do NOT carry.
    let settingsfile = home.join("settings.json");
    std::fs::write(
        &settingsfile,
        serde_json::to_string_pretty(&json!({
            "env": shared::claude_user_env(),
            "statusLine": shared::claude_status_line_config(),
            "skipDangerousModePermissionPrompt": true,
            "hooks": claude_hooks(&notify)
        }))
        .unwrap(),
    )
    .map_err(|e| e.to_string())?;
    // A fresh CLAUDE_CONFIG_DIR otherwise parks at the theme/onboarding and
    // workspace-trust dialogs before the TUI. Claude documents the persisted
    // trust shape (`projects[repo_root].hasTrustDialogAccepted = true`); this
    // home exists only because the user explicitly spawned a managed agent in
    // this workspace, so materialize that decision before launching.
    ensure_claude_state(home, workspace)?;

    // Claude has no native skill mechanism — inject the compact index.
    let full_prompt = if skills.is_empty() {
        system_prompt.to_string()
    } else {
        format!("{}\n\n{}", system_prompt, crate::projects::skills::skills_index_text(skills))
    };
    // The prompt is a FILE, like every other backend now (owner, 2026-09-08:
    // "类似的 Claude omp grok 是不是也是这种文件形式的，保证更加稳定"):
    // claude reads the user-memory `CLAUDE.md` from CLAUDE_CONFIG_DIR — this
    // isolated home — verified live (claude 2.1.239 quoted a marker from a
    // relocated dir's CLAUDE.md and obeyed its instruction). The old
    // `--append-system-prompt <6 KB literal>` was the last launch line bigger
    // than a send-keys burst; every start path is a short line now.
    std::fs::write(home.join("CLAUDE.md"), &full_prompt).map_err(|e| e.to_string())?;
    // An empty model means the BACKEND default — with Bedrock that is the
    // inherited env's ANTHROPIC_MODEL, so no `--model` is passed (the old
    // hardcoded `sonnet` alias overrode the env and does not resolve on
    // Bedrock). A configured model rides `--model`, which wins over env.
    let model_arg = if def.model.trim().is_empty() {
        String::new()
    } else {
        format!(" --model {}", crate::shell::quote(def.model.trim()))
    };
    Ok(Rendered {
        env: vec![("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().to_string())],
        cmd: format!(
            "command claude --mcp-config {} --strict-mcp-config --settings {}{}{} --dangerously-skip-permissions",
            crate::shell::quote(&mcpfile.to_string_lossy()),
            crate::shell::quote(&settingsfile.to_string_lossy()),
            model_arg,
            effort_flag(def),
        ),
        confirmation: Some(shared::StartupConfirmation {
            markers: shared::CLAUDE_FOLDER_TRUST_MARKERS.to_vec(),
            ready_markers: vec!["bypass permissions on"],
            accept_keys: vec!["Down", "Enter"],
            timeout: std::time::Duration::from_secs(120),
        }),
    })
}

/// Merge missing provider-channel keys into a managed Claude settings object.
/// Existing values are per-agent overrides and win; newly introduced global
/// keys (for example ANTHROPIC_DEFAULT_HAIKU_MODEL replacing the deprecated
/// small-fast key) still reach old homes on their next start.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn merge_missing_claude_env(conf: &mut Value, inherited: &Value) -> bool {
    let Some(root) = conf.as_object_mut() else { return false };
    let Some(source) = inherited.as_object().filter(|env| !env.is_empty()) else { return false };
    if !root.get("env").is_some_and(Value::is_object) {
        root.insert("env".into(), Value::Object(source.clone()));
        return true;
    }
    let target = root.get_mut("env").and_then(Value::as_object_mut).unwrap();
    let mut changed = false;
    for (key, value) in source {
        if !target.contains_key(key) {
            target.insert(key.clone(), value.clone());
            changed = true;
        }
    }
    changed
}

/// Backfill a managed claude settings.json with missing inherited channel keys
/// (see `backends_shared::claude_user_env`). Fail-soft: refresh must never
/// block a start. Returns true when the file changed.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_claude_env(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(mut conf) = serde_json::from_str::<Value>(&text) else { return false };
    let inherited = shared::claude_user_env();
    if !merge_missing_claude_env(&mut conf, &inherited) {
        return false;
    }
    std::fs::write(path, serde_json::to_string_pretty(&conf).unwrap()).is_ok()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_claude_status_line(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(mut conf) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(root) = conf.as_object_mut() else { return false };
    let canonical = shared::claude_status_line_config();
    if root.get("statusLine") == Some(&canonical) {
        return false;
    }
    root.insert("statusLine".into(), canonical);
    std::fs::write(path, serde_json::to_string_pretty(&conf).unwrap()).is_ok()
}


/// The claude half of `refresh_hooks`: hooks, channel drift (missing global
/// Bedrock keys backfilled without overwriting per-agent overrides), the
/// official statusLine, and pre-seeded workspace trust.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, workspace: &Path, notify: &str) -> bool {
    let mut changed = false;
    let settings = home.join("settings.json");
    if settings.is_file() {
        changed |= patch_hooks(&settings, claude_hooks(notify));
        changed |= ensure_claude_env(&settings);
        changed |= ensure_claude_status_line(&settings);
        changed |= ensure_claude_state(home, workspace).unwrap_or(false);
    }
    changed
}

/// claude resume dialect: `--resume <id>` exact, `--continue` recent
/// (cwd-scoped, and the isolated home is this one agent's).
/// The exact-resume line, the ONE construction `resume_command` and
/// `resume_exact` share (board #422).
fn exact_line(cmd: &str, id: &str) -> String {
    format!("{cmd} --resume {}", crate::shell::quote(id))
}

/// The strict form for a restore after a reboot (board #422): `Some` only
/// when this builder put the exact id on the line; an empty id or command
/// is `None`, never a recent or blank start.
pub(crate) fn resume_exact(cmd: &str, id: &str) -> Option<String> {
    (!cmd.trim().is_empty() && super::shared::exact_id_ok(id)).then(|| exact_line(cmd, id))
}

pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    match id {
        Some(id) => exact_line(cmd, id),
        None => format!("{cmd} --continue"),
    }
}

/// This backend's detection/relaunch row (board #129). `claude --help`:
/// `-c/--continue` — most recent conversation in this directory;
/// `--resume <id>` exact. The recipe dialect is `resume_command` above.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on Claude Code
/// 2.1.283: `/goal <args>` is echoed VERBATIM. Declared per command, only
/// where a prompt hook was measured: `/effort` and friends fire none.
pub(crate) fn command_echo(name: &str, args: &str) -> Option<String> {
    (name == "/goal" && !args.is_empty()).then(|| format!("/goal {args}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "claude",
        programs: &["claude"],
        launch: "claude",
        resume_recent: Some("claude --continue"),
        resume_id: Some("claude --resume {id}"),
        // The native installer's layout: the binary is
        // ~/.local/share/claude/versions/<version>, so the process is named
        // after the version (board #260).
        versioned_binary_dir: Some("claude/versions"),
    }
}

/// claude's hook payload dialect (board #129): `Notification` subtypes carry
/// the ask kinds; `Stop`/`StopFailure` end a turn. The idle nudge is NOT an
/// ask (board #75) — `is_idle_nudge` below screens it before this runs.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    let notification_type =
        crate::agent_notifications::string_field(payload, &["notification_type"]);
    match (event.as_deref(), notification_type.as_deref()) {
        (Some("Notification"), Some("permission_prompt")) => Ok("permission_required"),
        (Some("Notification"), Some("agent_needs_input")) => Ok("input_required"),
        (Some("Notification"), Some("agent_completed")) | (Some("Stop"), _) => Ok("completed"),
        (Some("StopFailure"), _) => Ok("failed"),
        _ => Err("unsupported Claude event".into()),
    }
}

/// claude shares kiro's snake_case key with PascalCase values
/// ("UserPromptSubmit"). It shipped WITHOUT this arm once, which made the
/// dedup flag sticky for its windows: the first `tmm send` suppressed the
/// auto-post for every later turn, and deliveries were never acked.
pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))
}

/// Claude Code's idle reminder (`Notification` / `idle_prompt`): fires ~60 s
/// after a turn ended with nobody typing. Not an ask — the consumer drops it
/// before normalize runs (board #75).
pub(crate) fn is_idle_nudge(payload: &Value) -> bool {
    payload.get("hook_event_name").and_then(Value::as_str) == Some("Notification")
        && payload.get("notification_type").and_then(Value::as_str) == Some("idle_prompt")
}
// ---- transient model errors: the auto-continue shapes (projects/recovery.rs, board #280) ----

/// Claude Code's shape (Claude Code 2.1.284 on Amazon Bedrock, board #280,
/// 2026-09-29): `● API Error: 503 Bedrock is unable to process your request.
/// This is a server-side issue, usually temporary — try again in a moment.
/// If it persists, check your Amazon Bedrock service status.`, the `●`
/// bullet flush-left and the rest hard-wrapped with two-space indents
/// (captured at 100 and 57 columns). It carries no request id, so the block
/// must be EXACTLY this text with only whitespace collapsed; its own words
/// say it is transient ("usually temporary — try again"). The status code is
/// the only variable part, and it must be a 5xx.
const CLAUDE_BEDROCK_5XX: (&str, &str) = (
    "● API Error: ",
    " Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your Amazon Bedrock service status.",
);

/// Is this block, its lines joined with spaces, exactly Claude Code's
/// transient Bedrock server error?
fn claude_bedrock_5xx(spaced: &str) -> bool {
    let flat = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(rest) = flat.strip_prefix(CLAUDE_BEDROCK_5XX.0) else { return false };
    let Some(code) = rest.strip_suffix(CLAUDE_BEDROCK_5XX.1) else { return false };
    code.len() == 3 && code.starts_with('5') && code.chars().all(|c| c.is_ascii_digit())
}


/// Which of Claude Code's OWN transient-error shapes this block is (#362:
/// by name), or `None`.
pub(crate) fn transient_shape(_glued: &str, spaced: &str) -> Option<&'static str> {
    claude_bedrock_5xx(spaced).then_some("bedrock_5xx")
}

/// The Claude Code version each shape above was MEASURED on (board #362):
/// `bedrock_5xx` on 2.1.284 (#280). Raise it only with a new capture as its
/// fixture (`recovery::tests::FIXTURES`).
pub(crate) const RECOVERY_SHAPES: &[super::Measured] = &[
    super::Measured { shape: "bedrock_5xx", version: "2.1.284", at_most: false },
];

/// The program whose `--version` names the Claude Code a pane runs.
pub(crate) const VERSION_PROGRAM: &str = "claude";
