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

/// The model fields of the user's `settings.json` that may leave as data
/// (board #511, an EXACT allow-list): the carried env's model variables
/// that Claude Code documents, then the top-level `model`. No wildcard, no
/// name a caller chooses; every other key — credentials included — is
/// never output.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const MODEL_ENV: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/// Claude takes aliases nobody can enumerate, so what this host DECLARES is
/// offered as SUGGESTIONS: never a whitelist, and free text stays valid.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list() -> Result<(Vec<String>, super::ModelKind), super::ModelReason> {
    let Some(settings) = user_settings()? else { return Err(super::ModelReason::NotListed) };
    let ids = declared_models(&settings);
    if ids.is_empty() {
        return Err(super::ModelReason::NotListed);
    }
    Ok((ids, super::ModelKind::Suggestions))
}

/// The baseline default: the CARRIED env's `ANTHROPIC_MODEL`, read through
/// the same `claude_env_of` `render_claude` copies from. The top-level
/// `model` is not carried into the home, so it is a suggestion, never this.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn baseline_model() -> Result<Option<String>, super::ModelReason> {
    Ok(user_settings()?.and_then(|s| carried_model(&s)))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn user_settings() -> Result<Option<serde_json::Value>, super::ModelReason> {
    let Some(text) = super::read_model_source(&shared::claude_user_settings())? else { return Ok(None) };
    serde_json::from_str(&text).map(Some).map_err(|_| super::ModelReason::Invalid)
}

/// Pure: the allow-listed ids, de-duplicated, in that order.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn declared_models(settings: &serde_json::Value) -> Vec<String> {
    let env = shared::claude_env_of(settings);
    let mut out: Vec<String> = Vec::new();
    let named = MODEL_ENV.iter().map(|k| env.get(*k)).chain(std::iter::once(settings.get("model")));
    for id in named.flatten().filter_map(serde_json::Value::as_str) {
        if !out.iter().any(|o| o == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// Pure: the carried env's `ANTHROPIC_MODEL`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn carried_model(settings: &serde_json::Value) -> Option<String> {
    shared::claude_env_of(settings).get("ANTHROPIC_MODEL").and_then(serde_json::Value::as_str).map(str::to_string)
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
// `Path` is shared: the restart line (`resume_command`, board #22) is built
// on every platform; `PathBuf` only by the desktop-only home renderer.
use std::path::Path;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::PathBuf;

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

/// Materialize onboarding, workspace trust and the LSP-recommendation off
/// switch in an isolated managed Claude home.
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
    // Board #3 (2.1.318): the modal "LSP plugin recommendation" dialog
    // offered rust-analyzer-lsp to a restarted managed agent, and a delivered
    // digit or Enter could answer "Yes, install". `lspRecommendationDisabled`
    // is the documented off switch in `.claude.json` (code-intelligence docs
    // § Turn recommendations back on). A managed home carries no plugins and
    // nobody answers its dialogs, so the value is held at true.
    if obj.get("lspRecommendationDisabled") != Some(&json!(true)) {
        obj.insert("lspRecommendationDisabled".into(), json!(true));
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
        shared::write_atomic(&path, &text).map_err(|e| format!("write {e}"))?;
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
    shared::write_atomic(&mcpfile, &serde_json::to_string_pretty(&json!({ "mcpServers": mcp_servers })).unwrap())?;
    // The isolated home is the agent's CLAUDE_CONFIG_DIR (claude's KIRO_HOME:
    // history, session state and .claude.json live here, so a managed agent
    // never leaks into the user's ~/.claude). That relocation also means the
    // USER's settings layer is no longer read — so the channel config is
    // INHERITED: the `env` block of ~/.claude/settings.json (the Bedrock
    // switch: CLAUDE_CODE_USE_BEDROCK/AWS_REGION/ANTHROPIC_MODEL…) is copied
    // into the isolated settings.json, grok's "auth carries, prefs do not"
    // pattern in claude's dialect (owner, 2026-08-22: "都用bedrock渠道…复用
    // 我们全局定义的配置 但是自己管理好类似kirohome这种"). Plugins and
    // marketplaces deliberately do NOT carry. The documented credential
    // commands (`apiKeyHelper` and kin) DO carry with the env: without the
    // helper an interactive managed Claude was "Not logged in" (board #2,
    // 2.1.318). What carries is `shared::claude_carry_of`, nothing else.
    let settingsfile = home.join("settings.json");
    let mut settings = shared::claude_user_carry();
    let root = settings.as_object_mut().expect("the carry is an object");
    root.insert("statusLine".into(), shared::claude_status_line_config());
    root.insert("skipDangerousModePermissionPrompt".into(), json!(true));
    root.insert("hooks".into(), claude_hooks(&notify));
    shared::write_atomic(&settingsfile, &serde_json::to_string_pretty(&settings).unwrap())?;
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
    shared::write_atomic(&home.join("CLAUDE.md"), &full_prompt)?;
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
        env: vec![
            ("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().to_string()),
            // Board #50: CLAUDE_CONFIG_DIR is the agent's, but HOME is the
            // user's, so claude's own updater installed into the user's
            // ~/.local/share/claude/versions and relinked ~/.local/bin/claude
            // (four times on 2026-11-06, once a downgrade to 2.1.318). kimi's
            // KIMI_CODE_NO_AUTO_UPDATE and codex's check_for_update_on_startup
            // keep those CLIs out of the user's install the same way. The
            // documented switch, read by 2.1.319; `DISABLE_UPDATES` would also
            // block a typed `claude update`, so it is not set.
            ("DISABLE_AUTOUPDATER".into(), "1".into()),
        ],
        cmd: format!(
            "command claude --mcp-config {} --strict-mcp-config --settings {}{}{} --dangerously-skip-permissions",
            crate::shell::quote(&mcpfile.to_string_lossy()),
            crate::shell::quote(&settingsfile.to_string_lossy()),
            model_arg,
            effort_flag(def),
        ),
        confirmation: startup_confirmation(),
    })
}

/// claude's folder-trust dialog and its ready footer: a spawn's waiter and a
/// restart's ready edge (board #38) read it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn startup_confirmation() -> Option<shared::StartupConfirmation> {
    Some(shared::StartupConfirmation {
        markers: shared::CLAUDE_FOLDER_TRUST_MARKERS.to_vec(),
        ready_markers: vec!["bypass permissions on"],
        loading: None,
        accept_keys: vec!["Down", "Enter"],
        timeout: std::time::Duration::from_secs(120),
    })
}

/// Merge the missing part of the carry (`shared::claude_carry_of`: the env
/// channel and the credential commands) into a managed Claude settings
/// object. Existing values are per-agent overrides and win, inside `env` and
/// at the top level; newly introduced global keys (for example
/// ANTHROPIC_DEFAULT_HAIKU_MODEL, or an `apiKeyHelper` a home rendered before
/// board #2 lacks) still reach old homes on their next start.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn merge_missing_claude_carry(conf: &mut Value, carry: &Value) -> bool {
    let Some(root) = conf.as_object_mut() else { return false };
    let Some(carry) = carry.as_object() else { return false };
    let mut changed = false;
    for (key, value) in carry {
        if key == "env" {
            let Some(source) = value.as_object().filter(|env| !env.is_empty()) else { continue };
            if !root.get("env").is_some_and(Value::is_object) {
                root.insert("env".into(), Value::Object(source.clone()));
                changed = true;
                continue;
            }
            let target = root.get_mut("env").and_then(Value::as_object_mut).unwrap();
            for (k, v) in source {
                if !target.contains_key(k) {
                    target.insert(k.clone(), v.clone());
                    changed = true;
                }
            }
        } else if !root.contains_key(key) {
            root.insert(key.clone(), value.clone());
            changed = true;
        }
    }
    changed
}

/// Backfill a managed claude settings.json with the missing carry (see
/// `merge_missing_claude_carry`). Fail-soft: refresh must never block a
/// start. Returns true when the file changed.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_claude_carry(path: &Path) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(false) };
    let Ok(mut conf) = serde_json::from_str::<Value>(&text) else { return Ok(false) };
    if !merge_missing_claude_carry(&mut conf, &shared::claude_user_carry()) {
        return Ok(false);
    }
    shared::write_atomic(path, &serde_json::to_string_pretty(&conf).unwrap()).map(|_| true)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_claude_status_line(path: &Path) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(false) };
    let Ok(mut conf) = serde_json::from_str::<Value>(&text) else { return Ok(false) };
    let Some(root) = conf.as_object_mut() else { return Ok(false) };
    let canonical = shared::claude_status_line_config();
    if root.get("statusLine") == Some(&canonical) {
        return Ok(false);
    }
    root.insert("statusLine".into(), canonical);
    shared::write_atomic(path, &serde_json::to_string_pretty(&conf).unwrap()).map(|_| true)
}


/// The claude half of `refresh_hooks`: hooks, carry drift (missing global
/// channel keys and credential commands backfilled without overwriting
/// per-agent overrides), the
/// official statusLine, and pre-seeded workspace trust.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, workspace: &Path, notify: &str) -> Result<bool, String> {
    let mut changed = false;
    let settings = home.join("settings.json");
    if settings.is_file() {
        changed |= patch_hooks(&settings, claude_hooks(notify))?;
        changed |= ensure_claude_carry(&settings)?;
        changed |= ensure_claude_status_line(&settings)?;
        changed |= ensure_claude_state(home, workspace)?;
    }
    Ok(changed)
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

/// The restart line (board #22). Measured on Claude Code 2.1.318: `--continue`
/// with no transcript for the cwd, and `--resume <id>` with no transcript for
/// that id, both print "No conversation found…" and exit 1, parking the pane
/// at the shell. A SessionStart id is recorded at startup, but the transcript
/// is written only after the first turn. So with a home, this resumes only
/// what the home holds. A RECORDED id resumes exactly when
/// `projects/*/<id>.jsonl` exists and otherwise starts fresh: falling back to
/// the cwd's newest would revive an OLDER conversation with the wrong history
/// (review P1-R1). With no recorded id, the newest transcript of the launch
/// cwd is continued when there is one, else a fresh start. Without a home it
/// keeps the unchecked forms.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return match id {
            Some(id) => exact_line(cmd, id),
            None => format!("{cmd} --continue"),
        };
    };
    match id {
        Some(id) if holds_transcript(home, id) => exact_line(cmd, id),
        Some(_) => cmd.to_string(),
        None if cwd_has_transcript(home) => format!("{cmd} --continue"),
        None => cmd.to_string(),
    }
}

/// Whether the home holds the transcript of conversation `id` under any cwd.
fn holds_transcript(home: &Path, id: &str) -> bool {
    if !super::shared::exact_id_ok(id) || id.contains('/') || id.starts_with('.') {
        return false;
    }
    let file = format!("{id}.jsonl");
    std::fs::read_dir(home.join("projects"))
        .map(|dirs| dirs.flatten().any(|d| d.path().join(&file).is_file()))
        .unwrap_or(false)
}

/// Whether the launch cwd has a transcript `--continue` can pick. The cwd is
/// the workspace, from the managed layout `<ws>/.tmm/agents/<name>`,
/// canonicalized: claude files transcripts under its REAL cwd (measured on
/// 2.1.318: run from a symlink to `repo/sub`, the transcript went to
/// `…-repo-sub`). That is not `claude_trust_key`, which walks up to the git
/// root because it answers trust. A home outside that layout counts any
/// transcript at all.
fn cwd_has_transcript(home: &Path) -> bool {
    let has_jsonl = |dir: &Path| {
        std::fs::read_dir(dir)
            .map(|files| files.flatten().any(|f| f.path().extension().is_some_and(|e| e == "jsonl")))
            .unwrap_or(false)
    };
    let projects = home.join("projects");
    let Ok(dirs) = std::fs::read_dir(&projects) else { return false };
    let agents = home.parent();
    let workspace = agents
        .filter(|a| a.file_name().is_some_and(|n| n == "agents"))
        .and_then(Path::parent)
        .filter(|t| t.file_name().is_some_and(|n| n == ".tmm"))
        .and_then(Path::parent);
    match workspace {
        Some(ws) => {
            let ws = std::fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
            let (exact, long_prefix) = project_dir_name(&ws.to_string_lossy());
            dirs.flatten().any(|d| {
                let name = d.file_name().to_string_lossy().to_string();
                let ours = match &long_prefix {
                    Some(prefix) => name.starts_with(prefix.as_str()),
                    None => name == exact,
                };
                ours && has_jsonl(&d.path())
            })
        }
        None => dirs.flatten().any(|d| has_jsonl(&d.path())),
    }
}

/// claude's directory name for a cwd under `projects/`, read from the 2.1.318
/// binary: `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, per UTF-16 unit; longer than
/// 200 units it becomes `slice(0, 200) + "-" + hash`. The hash is not
/// reproduced: a long name returns the `slice + "-"` prefix to match on.
fn project_dir_name(cwd: &str) -> (String, Option<String>) {
    let units: Vec<char> = cwd
        .chars()
        .flat_map(|c| std::iter::repeat(if c.is_ascii_alphanumeric() { c } else { '-' }).take(c.len_utf16()))
        .collect();
    let exact: String = units.iter().collect();
    if units.len() <= 200 {
        (exact, None)
    } else {
        let prefix: String = units[..200].iter().collect();
        (exact, Some(format!("{prefix}-")))
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

/// The fact that shows the reset command `name` took effect (board #45),
/// measured 2026-11-06 on Claude Code 2.1.319 (scratch gateway, a hook spy):
/// `/clear` fires `SessionStart {source: clear}` ~0.3 s after its Enter, and
/// `/compact` fires `SessionStart {source: compact}` when compaction ends.
pub(crate) fn command_effect(name: &str) -> Option<super::CommandEffect> {
    match name {
        "/clear" => Some(super::CommandEffect::SessionStart("clear")),
        "/compact" => Some(super::CommandEffect::SessionStart("compact")),
        _ => None,
    }
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

/// A `StopFailure` a person must clear (board #39), as its text: claude
/// 2.1.318 names the error's kind in `error` and says it in
/// `last_assistant_message` (the transcript's `isApiErrorMessage` row says
/// the same). `None` for any other event or an ordinary failure.
pub(crate) fn provider_failure(payload: &serde_json::Map<String, Value>) -> Option<String> {
    let field = |k: &str| crate::agent_notifications::string_field(payload, &[k]);
    if field("hook_event_name").as_deref() != Some("StopFailure") {
        return None;
    }
    super::shared::provider_failure(None, field("error").as_deref(), &field("last_assistant_message").unwrap_or_default())
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

/// The prompt Claude Code submits ITSELF when a background task finishes
/// (board #13, measured on 2.1.318, 2026-11-05): the whole prompt is one
/// `<task-notification>` block, its children one per line in this order —
/// `task-id`, `tool-use-id`, `output-file`, `status` (`completed`/`failed`),
/// `summary` — and, for a background Agent, `note` then `result`. The hook
/// payload carries no origin field, so the structure is the only evidence:
/// anything else, including this XML pasted inside other text or quoted on a
/// `[tmm chat]` line, is ordinary input. Returns the summary, unescaped,
/// which is all the feed shows (never the output file's path).
pub(crate) fn task_notification(prompt: &str) -> Option<String> {
    const COMMAND: [&str; 5] = ["task-id", "tool-use-id", "output-file", "status", "summary"];
    const AGENT_TAIL: [&str; 2] = ["note", "result"];
    let body = prompt.trim().strip_prefix("<task-notification>\n")?.strip_suffix("\n</task-notification>")?;
    let mut rest = body;
    let mut values = Vec::with_capacity(COMMAND.len());
    for tag in COMMAND {
        values.push(xml_child(&mut rest, tag, false)?);
    }
    if !rest.is_empty() {
        xml_child(&mut rest, AGENT_TAIL[0], false)?;
        // Its answer is free text, but never a second block glued on.
        if xml_child(&mut rest, AGENT_TAIL[1], true)?.contains("</task-notification>") {
            return None;
        }
    }
    if !rest.is_empty() || [values[0], values[3], values[4]].iter().any(|v| v.trim().is_empty()) {
        return None;
    }
    Some(unescape_xml(values[4].trim()))
}

/// The next `<tag>…</tag>` child at the front of `rest`, then its newline.
/// Claude escapes these values, so a child ends at its first close and holds
/// no `<`; only the agent's `result`, its whole answer, may hold any text, so
/// it is `last` and ends at the LAST close.
fn xml_child<'a>(rest: &mut &'a str, tag: &str, last: bool) -> Option<&'a str> {
    let inner = rest.strip_prefix(&format!("<{tag}>"))?;
    let close = format!("</{tag}>");
    let at = if last { inner.rfind(&close)? } else { inner.find(&close)? };
    let after = &inner[at + close.len()..];
    let value = &inner[..at];
    if !last && value.contains('<') {
        return None;
    }
    *rest = if last || after.is_empty() { after } else { after.strip_prefix('\n')? };
    Some(value)
}

fn unescape_xml(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
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
/// fixture (`recovery::tests::FIXTURES`). No screen grammar was measured for
/// Claude Code (`Backend::newest_block` is `None`), so its 5xx keeps the
/// ungated send (board #473).
pub(crate) const RECOVERY_SHAPES: &[super::Measured] = &[
    super::Measured { shape: "bedrock_5xx", version: "2.1.284", at_most: false, screen_grammar: false, words: "Bedrock 5xx" },
];

/// The program whose `--version` names the Claude Code a pane runs.
pub(crate) const VERSION_PROGRAM: &str = "claude";

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    const SENTINEL: &str = "SENTINEL-511";

    /// Board #39 AC1, measured on 2.1.318 (builder-2, scratch home, invalid
    /// key) and in the incident's transcript: `StopFailure` carries the
    /// error's kind in `error` and its text in `last_assistant_message`.
    #[test]
    fn a_stop_failure_a_person_must_clear_carries_its_text() {
        let failure = |error: &str, text: &str| provider_failure(serde_json::json!({"hook_event_name":"StopFailure","error":error,"last_assistant_message":text,"session_id":"s"}).as_object().unwrap());
        assert_eq!(failure("authentication_failed", "Please run /login · API Error: 401 invalid API key").as_deref(), Some("authentication_failed: Please run /login · API Error: 401 invalid API key"));
        assert_eq!(failure("unknown", "API Error: 402 insufficient credit; contact your tenant owner").as_deref(), Some("unknown: API Error: 402 insufficient credit; contact your tenant owner"));
        assert!(failure("invalid_request", "Request too large (max 32MB). Run /compact").is_some());
        assert_eq!(failure("rate_limit", "API Error: 429"), None, "it retries by itself");
        assert_eq!(failure("server_error", "API Error: 500"), None);
        let stop = serde_json::json!({"hook_event_name":"Stop","last_assistant_message":"401 tests pass"});
        assert_eq!(provider_failure(stop.as_object().unwrap()), None, "only a failed end is read");
    }

    /// Board #22: `--continue` is chosen only when claude's OWN directory for
    /// the workspace holds a transcript. claude 2.1.318 names it by replacing
    /// each non-alphanumeric UTF-16 unit with '-' (`翻译` is two units, `😀`
    /// two), and a name over 200 units is cut to 200 plus "-<hash>".
    #[test]
    fn continue_needs_a_transcript_in_claudes_own_directory_for_the_workspace() {
        let scratch = crate::config::test_scratch("tmm-claude-dir");
        let cmd = "command claude";
        let case = |ws: &Path, dir: &str| {
            let home = ws.join(".tmm/agents/cl");
            let other = home.join("projects/-elsewhere");
            std::fs::create_dir_all(&other).unwrap();
            shared::write_atomic(&other.join("a.jsonl"), "{}\n").unwrap();
            assert_eq!(resume_command(cmd, None, Some(&home)), cmd, "another cwd's transcript is not this one's: {dir}");
            let ours = home.join("projects").join(dir);
            std::fs::create_dir_all(&ours).unwrap();
            assert_eq!(resume_command(cmd, None, Some(&home)), cmd, "an empty directory holds no conversation: {dir}");
            shared::write_atomic(&ours.join("b.jsonl"), "{}\n").unwrap();
            assert_eq!(resume_command(cmd, None, Some(&home)), "command claude --continue", "{dir}");
        };
        let s = scratch.to_str().unwrap();
        let s_dir: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        case(&scratch.join("翻译😀.x"), &format!("{s_dir}------x"));
        let long = scratch.join("a".repeat(240));
        let prefix: String = format!("{s_dir}-{}", "a".repeat(240)).chars().take(200).collect();
        case(&long, &format!("{prefix}-1k2j3h"));
        std::fs::remove_dir_all(&scratch).ok();
    }

    /// Board #22 round 1 (measured on 2.1.318): claude files a transcript
    /// under its encoding of the CANONICAL cwd. Run from a symlink to
    /// `repo/sub`, the transcript went to `…-repo-sub`, not to the link's
    /// name, and not to the git root `…-repo` that `claude_trust_key` answers
    /// for trust.
    #[test]
    fn the_transcript_directory_is_the_canonical_workspace_not_its_link_or_git_root() {
        let scratch = crate::config::test_scratch("tmm-claude-canon");
        std::fs::create_dir_all(&scratch).unwrap();
        let scratch = std::fs::canonicalize(scratch).unwrap();
        let sub = scratch.join("repo/sub");
        std::fs::create_dir_all(scratch.join("repo/.git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        let link = scratch.join("link");
        std::os::unix::fs::symlink(&sub, &link).unwrap();
        let home = link.join(".tmm/agents/cl");
        std::fs::create_dir_all(&home).unwrap();
        let enc = |p: &Path| -> String { p.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect() };
        let put = |dir: &str| {
            let d = home.join("projects").join(dir);
            std::fs::create_dir_all(&d).unwrap();
            shared::write_atomic(&d.join("a.jsonl"), "{}\n").unwrap();
        };
        put(&enc(&link));
        put(&enc(&scratch.join("repo")));
        assert_eq!(resume_command("claude", None, Some(&home)), "claude", "the link's name and the git root are not claude's directory");
        put(&enc(&sub));
        assert_eq!(resume_command("claude", None, Some(&home)), "claude --continue", "the canonical cwd is");
        std::fs::remove_dir_all(&scratch).ok();
    }

    /// Board #511 review P1-C: only the allow-listed model fields leave, and
    /// the baseline default is the CARRIED env's ANTHROPIC_MODEL (P1-B). Every
    /// other key sits beside them carrying a sentinel.
    #[test]
    fn only_the_allow_listed_model_fields_leave_and_the_default_is_the_carried_env() {
        let settings = serde_json::json!({
            "model": "top-model",
            "apiKeyHelper": SENTINEL,
            "env": {
                "ANTHROPIC_MODEL": "env-model",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-id",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-id",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-id",
                "ANTHROPIC_FOO_MODEL": SENTINEL,
                "ANTHROPIC_API_KEY": SENTINEL,
                "AWS_SECRET_ACCESS_KEY": SENTINEL,
                "CLAUDE_CODE_USE_BEDROCK": "1",
            },
        });
        let ids = declared_models(&settings);
        assert_eq!(ids, ["env-model", "opus-id", "sonnet-id", "haiku-id", "top-model"]);
        assert_eq!(carried_model(&settings).as_deref(), Some("env-model"));
        assert!(!format!("{ids:?}{:?}", carried_model(&settings)).contains(SENTINEL));
        // The renderer carries exactly the env the default reads.
        assert_eq!(shared::claude_env_of(&settings)["ANTHROPIC_MODEL"], "env-model");

        // Conflicting sources: the top-level model is NOT carried into the
        // home, so with only it set there is no default, just a suggestion.
        let top_only = serde_json::json!({ "model": "top-model", "env": { "AWS_REGION": "us-west-2" } });
        assert_eq!(carried_model(&top_only), None);
        assert_eq!(declared_models(&top_only), ["top-model"]);
        // Nothing declared; a non-string value is not an id.
        assert!(declared_models(&serde_json::json!({})).is_empty());
        assert_eq!(carried_model(&serde_json::json!({ "env": { "ANTHROPIC_MODEL": 7 } })), None);
    }

    /// Board #13, measured on Claude Code 2.1.318 (scratch home, 2026-11-05):
    /// the whole `UserPromptSubmit.prompt` of a background Bash command that
    /// finished, and of one that failed.
    const BG_DONE: &str = "<task-notification>\n<task-id>b4hc3uwf8</task-id>\n<tool-use-id>toolu_bdrk_01MYxHQnP3B8gZudJRYkWRNv</tool-use-id>\n<output-file>/tmp/claude-1000/-tmp-b4-13-measure-ws/1f055bf3-8ea9-4336-9521-5e580b650aee/tasks/b4hc3uwf8.output</output-file>\n<status>completed</status>\n<summary>Background command \"Sleep 4s then print ok-b4\" completed (exit code 0)</summary>\n</task-notification>";
    const BG_FAILED: &str = "<task-notification>\n<task-id>baf797rux</task-id>\n<tool-use-id>toolu_bdrk_01Jhpe5uF3xZe4rVqefPN9Ze</tool-use-id>\n<output-file>/tmp/claude-1000/-tmp-b4-13-measure-ws/1f055bf3-8ea9-4336-9521-5e580b650aee/tasks/baf797rux.output</output-file>\n<status>failed</status>\n<summary>Background command \"Sleep 6s, print bad, exit with code 3\" failed with exit code 3</summary>\n</task-notification>";
    /// The background-AGENT shape, from state.db (sound-factory, 2026-11-05,
    /// the same 2.1.318): the five children, then `<note>` and `<result>`.
    /// The result is the agent's whole answer and may span lines.
    const AGENT_DONE: &str = "<task-notification>\n<task-id>acaef99e9f1b99278</task-id>\n<tool-use-id>toolu_bdrk_01KLzr7mAQotpWoRxRyThSbT</tool-use-id>\n<output-file>/tmp/claude-1000/-home-ubuntu-work-projects-sound-factory/cf3eb3d2/tasks/acaef99e9f1b99278.output</output-file>\n<status>completed</status>\n<summary>Agent \"Research open models for painted anime\" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n<result>I wrote the report.\n\nIt covers about 40 candidates.</result>\n</task-notification>";

    #[test]
    fn a_finished_background_task_is_the_clis_own_prompt_and_shows_only_its_summary() {
        assert_eq!(task_notification(BG_DONE).as_deref(), Some("Background command \"Sleep 4s then print ok-b4\" completed (exit code 0)"));
        assert_eq!(task_notification(BG_FAILED).as_deref(), Some("Background command \"Sleep 6s, print bad, exit with code 3\" failed with exit code 3"));
        assert_eq!(task_notification(AGENT_DONE).as_deref(), Some("Agent \"Research open models for painted anime\" finished"));
        // Claude escapes the summary (state.db 2026-11-05: `&gt;`, `&amp;`): shown unescaped.
        let escaped = BG_DONE.replace("\"Sleep 4s then print ok-b4\"", "\"(a &gt; /tmp/x 2&gt;&amp;1)\"");
        assert_eq!(task_notification(&escaped).as_deref(), Some("Background command \"(a > /tmp/x 2>&1)\" completed (exit code 0)"));
        // Surrounding whitespace is not content.
        assert!(task_notification(&format!("\n{BG_DONE}\n")).is_some());
    }

    /// Sentinels: the same XML that is not the WHOLE prompt, or not the
    /// measured children, is a person's (or a teammate's) input.
    #[test]
    fn task_notification_xml_inside_other_text_is_ordinary_input() {
        for not_own in [
            format!("look at this: {BG_DONE}"),
            format!("{BG_DONE}\nwhat does it mean?"),
            format!("[tmm chat 2026-11-05 08:30] lead: @dev {BG_DONE}"),
            format!("{BG_DONE}\n{BG_FAILED}"),
            format!("{AGENT_DONE}\n{AGENT_DONE}"),
            BG_DONE.replace("<status>completed</status>\n", ""),
            BG_DONE.replace("<task-id>b4hc3uwf8</task-id>", "<task-id></task-id>"),
            BG_DONE.replace("<summary>", "<summary>x</summary>\n<extra>").replace("</summary>\n</task", "</extra>\n</task"),
            AGENT_DONE.replace("<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n", ""),
            "<task-notification></task-notification>".to_string(),
            String::new(),
        ] {
            assert_eq!(task_notification(&not_own), None, "{not_own:?}");
        }
    }
}
