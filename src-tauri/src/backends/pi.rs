//! The pi backend's own knowledge (board #71): every fact about how this CLI
//! is driven lives here — one file to touch when it changes. pi 1.5.0
//! (@earendil-works/pi-coding-agent, the pi omp forks), measured in the
//! Docker live rig (#71 notes 9 and 10) and read from its own docs.

/// No queue|steer choice (measured on pi 1.5.0, #71 note 9): Enter while a
/// run is busy STEERS (`input` with `streamingBehavior: "steer"`, its user
/// message inside the same run, one settle for both), as for omp. Alt+Enter
/// queues a follow-up, which our telemetry has not been measured on, so
/// queue is not offered.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;

/// pi's composer opens its file picker on `@word` and Enter ACCEPTS the
/// suggestion instead of submitting (measured: `it moves on to @reviewer`
/// became `it moves on to @src/reviewer-notes.md`, unsent; omp's #36). So a
/// delivery types every `@` as `＠` (`delivery::typed_form`).
pub(crate) const AT_OPENS_FILE_PICKER: bool = true;

/// pi 1.5.0 `--thinking` (its cli docs): off, minimal, low, medium, high,
/// xhigh, max. A model without reasoning forces `off` (measured).
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"]
}

/// What this host DECLARES for pi, offered as SUGGESTIONS: `<provider>/<id>`
/// of every model under the user's `models.json` `providers.<p>.models[]`,
/// then the settings' `defaultProvider/defaultModel`. Files only:
/// `pi --list-models` WRITES `auth.json` and `models-store.json` into the
/// agent dir (measured), so it is not run against the user's. pi's bundled
/// catalogue stays reachable as free text, so nothing is refused.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list() -> Result<(Vec<String>, super::ModelKind), super::ModelReason> {
    let dir = pi_user_agent_dir();
    let models = super::read_model_source(&dir.join("models.json"))?;
    let settings = super::read_model_source(&dir.join("settings.json"))?;
    let ids = declared_models(models.as_deref(), settings.as_deref())?;
    if ids.is_empty() {
        return Err(super::ModelReason::NotListed);
    }
    Ok((ids, super::ModelKind::Suggestions))
}

/// The baseline default: the user's settings `defaultProvider/defaultModel`,
/// which the render carries into an empty definition's settings.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn baseline_model() -> Result<Option<String>, super::ModelReason> {
    let Some(text) = super::read_model_source(&pi_user_agent_dir().join("settings.json"))? else { return Ok(None) };
    let settings: Value = serde_json::from_str(&text).map_err(|_| super::ModelReason::Invalid)?;
    Ok(default_model(&settings))
}

/// `provider/model` (or the model alone) from a settings object.
fn default_model(settings: &Value) -> Option<String> {
    let model = settings.get("defaultModel").and_then(Value::as_str).filter(|m| !m.is_empty())?;
    Some(match settings.get("defaultProvider").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        Some(p) => format!("{p}/{model}"),
        None => model.to_string(),
    })
}

/// Pure: the allow-listed ids from the two files' text, de-duplicated. A
/// file present but not JSON is `Invalid`; nothing else of either file is
/// read (api keys, headers and base URLs sit beside these fields).
pub(crate) fn declared_models(models_json: Option<&str>, settings_json: Option<&str>) -> Result<Vec<String>, super::ModelReason> {
    let parse = |t: Option<&str>| -> Result<Option<Value>, super::ModelReason> {
        t.map(|t| serde_json::from_str::<Value>(t).map_err(|_| super::ModelReason::Invalid)).transpose()
    };
    let mut ids: Vec<String> = Vec::new();
    let mut push = |id: String| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    if let Some(models) = parse(models_json)? {
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            for (p, def) in providers {
                for m in def.get("models").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(id) = m.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()) {
                        push(format!("{p}/{id}"));
                    }
                }
            }
        }
    }
    if let Some(settings) = parse(settings_json)? {
        if let Some(id) = default_model(&settings) {
            push(id);
        }
    }
    Ok(ids)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

/// pi's footer, measured on pi 1.5.0 (#71 note 9): under the editor's
/// bottom rule, two lines,
///
/// `/work/p (master)`
/// `↑2.3k ↓1 1.8%/128k (auto)        …        (ust) claude-haiku-5-5 • low`
///
/// the cwd, then the token counts, the used context as `N.N%/<window>`, and
/// right-aligned the model: `(provider) ` only when more than one provider
/// is available, ` • <level>` for a reasoning model, ` • thinking off`, or
/// `no-model`. An optional third line holds extension statuses.
///
/// The footer is a POSITION, not a pattern (this project's room messages
/// quote footers): the two lines directly under the LAST full-width rule of
/// `─`. The rule above the editor shows `── ⠧ Working ──` while a run is
/// busy, so it is never the last pure rule. A quoted footer in a message
/// has no rule under the editor below it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_pi(pane: &str) -> Vitals {
    let lines: Vec<&str> = pane.lines().collect();
    let is_rule = |l: &str| {
        let t = l.trim_end();
        t.chars().count() >= 20 && t.chars().all(|c| c == '─')
    };
    let Some(r) = lines.iter().rposition(|l| is_rule(l)) else { return Vitals::default() };
    let Some(stats) = lines.get(r + 2) else { return Vitals::default() };
    let mut v = Vitals::default();
    // The used context: the token before `/<window>` ending in `%`.
    for word in stats.split_whitespace() {
        if let Some((pct, _window)) = word.split_once("%/") {
            if let Ok(p) = pct.parse::<f32>() {
                if (0.0..=100.0).contains(&p) {
                    v.context_pct = Some(p.round() as u8);
                }
            }
        }
    }
    // The model: the right-aligned segment, after the last run of spaces.
    let right = stats.trim_end().rsplit("  ").next().unwrap_or("").trim();
    let right = match right.strip_prefix('(') {
        Some(rest) => rest.split_once(") ").map(|(_, m)| m).unwrap_or(right),
        None => right,
    };
    if !right.is_empty() && right != "no-model" && !right.contains("%/") {
        let (model, level) = match right.split_once(" • ") {
            Some((m, l)) => (m.trim(), Some(l.trim())),
            None => (right, None),
        };
        if !model.is_empty() && !model.contains(char::is_whitespace) {
            v.model = Some(model.to_string());
            v.effort_definitive = true;
            match level {
                Some("thinking off") => v.effort = Some("off".to_string()),
                Some(l) if effort_values().contains(&l) => v.effort = Some(l.to_string()),
                _ => {}
            }
        }
    }
    v
}

/// Is pi's completion menu open on `screen` (board #71, measured on pi
/// 1.5.0)? It opens under the editor on `@word` (files) and on a typed
/// `/command` (commands, then their arguments: `/thinking high` showed
/// `→ high`, `/model ust/claude-sonnet-5-5` showed `→ claude-sonnet-5-5
/// ust`), and while it is open Enter ACCEPTS the highlighted entry and does
/// not submit; Escape closes it and leaves the line, and the next Enter
/// submits (measured). By position, like the footer: the line right under
/// the editor's bottom rule (the last full-width `─` rule) starts with `→ `.
pub fn picker_open(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().collect();
    let is_rule = |l: &str| {
        let t = l.trim_end();
        t.chars().count() >= 20 && t.chars().all(|c| c == '─')
    };
    lines
        .iter()
        .rposition(|l| is_rule(l))
        .and_then(|r| lines.get(r + 1))
        .is_some_and(|l| l.trim_start().starts_with("→ "))
}

use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::Rendered;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// The extension file a managed pi home carries.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const EXTENSION: &str = "tmm-telemetry.ts";

/// pi 1.5.0. Its whole agent state lives in ONE directory that
/// `PI_CODING_AGENT_DIR` relocates (its environment-variables docs; omp
/// inherited the variable), so the isolated home IS that directory:
///
/// * the user's `auth.json` and `models.json` are LINKED, through codex's
///   one mechanism (`shared::link_user_file`; orchestrator, #71 note 5):
///   one login, so a refreshed token is the owner's, and one catalogue, so
///   the picker and the agent read the same bytes. pi writes auth.json IN
///   PLACE (`writeFileSync`, its auth-storage), so the link holds.
/// * `settings.json` is OURS, rewritten whole every render: the model
///   (`defaultProvider`/`defaultModel`), the thinking level, project trust
///   (`defaultProjectTrust: trusted`, or a prompt blocks the start), the
///   skill dirs (`skills`) and no install telemetry. pi writes this file
///   itself (it added `lastChangelogVersion`, measured), so a link would let
///   a pane change the owner's own pi.
/// * the model also rides `--model` and the level `--thinking`: a resumed
///   session restores its own model over the settings (measured: it kept a
///   model picked by /model before the restart), and both flags win.
/// * the system prompt is a FILE handed to `--append-system-prompt` —
///   append, so pi's own tool prompt stays.
/// * telemetry: pi auto-loads `<agent-dir>/extensions/*.ts`; the generated
///   one (`pi_telemetry`, pi's dialect) forwards turn edges and tool events
///   to the notify helper in claude's payload dialect.
/// * MCP is native: `<home>/mcp.json`, the `mcpServers` shape of claude and
///   omp (its mcp docs).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_pi(
    def: &RegAgent, _name: &str, home: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    std::fs::create_dir_all(home.join("extensions")).map_err(|e| e.to_string())?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    shared::write_atomic(&home.join("extensions").join(EXTENSION), &telemetry_extension(&notifications.helper_command("pi")))?;

    link_user_files(home, &pi_user_agent_dir())?;

    let user_settings = std::fs::read_to_string(pi_user_agent_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let settings = pi_settings(user_settings.as_ref(), &def.model, &def.effort, skills);
    shared::write_atomic(&home.join("settings.json"), &serde_json::to_string_pretty(&settings).unwrap())?;

    let mut servers = serde_json::Map::new();
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            servers.insert(m.name.clone(), shared::claude_mcp_value(m));
        }
    }
    // No servers removes the file: a revoked server must not stay loaded.
    let mcp = (!servers.is_empty()).then(|| serde_json::to_string_pretty(&json!({ "mcpServers": servers })).unwrap());
    shared::write_owned(&home.join("mcp.json"), mcp.as_deref())?;

    let prompt_path = home.join("system-prompt.md");
    shared::write_atomic(&prompt_path, system_prompt)?;

    let model_flag = default_model(&settings).map(|m| format!(" --model {}", crate::shell::quote(&m))).unwrap_or_default();
    let thinking = settings
        .get("defaultThinkingLevel")
        .and_then(Value::as_str)
        .filter(|_| !def.effort.trim().is_empty())
        .map(|l| format!(" --thinking {}", crate::shell::quote(l)))
        .unwrap_or_default();
    Ok(Rendered {
        // No update notice and no install report (its environment docs);
        // pi never updates itself.
        env: vec![
            ("PI_CODING_AGENT_DIR".into(), home.to_string_lossy().to_string()),
            ("PI_SKIP_VERSION_CHECK".into(), "1".into()),
            ("PI_TELEMETRY".into(), "0".into()),
        ],
        cmd: format!(
            "command pi --append-system-prompt {}{}{}",
            crate::shell::quote(&prompt_path.to_string_lossy()),
            model_flag,
            thinking,
        ),
        confirmation: None,
    })
}

/// The isolated home's settings: the user's model and thinking defaults
/// (an empty definition runs on the user's own), the definition's model
/// (`provider/id` splits at the first `/`) and effort over them, trust, the
/// skills and no install telemetry. Nothing else of the user's settings
/// carries (UI prefs and packages are what isolation is for).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn pi_settings(user: Option<&Value>, model: &str, effort: &str, skills: &[crate::projects::skills::ResolvedSkill]) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["defaultProvider", "defaultModel", "defaultThinkingLevel"] {
        if let Some(v) = user.and_then(|u| u.get(key)).filter(|v| v.is_string()) {
            out.insert(key.into(), v.clone());
        }
    }
    let model = model.trim();
    if !model.is_empty() {
        match model.split_once('/') {
            Some((p, m)) if !p.is_empty() && !m.is_empty() => {
                out.insert("defaultProvider".into(), json!(p));
                out.insert("defaultModel".into(), json!(m));
            }
            _ => {
                out.remove("defaultProvider");
                out.insert("defaultModel".into(), json!(model));
            }
        }
    }
    if !effort.trim().is_empty() {
        out.insert("defaultThinkingLevel".into(), json!(effort.trim()));
    }
    out.insert("defaultProjectTrust".into(), json!("trusted"));
    out.insert("enableInstallTelemetry".into(), json!(false));
    if !skills.is_empty() {
        out.insert("skills".into(), json!(skills.iter().map(|s| s.dir.to_string_lossy().to_string()).collect::<Vec<_>>()));
    }
    Value::Object(out)
}

/// The user's `auth.json` and `models.json`, linked into the home through
/// the held, private walk (codex's mechanism); a link that already points
/// there stays. `auth.json` is NEVER ours to replace (review R1, codex's own
/// auth policy): with no user file, pi creates the home's and a /login in
/// the pane writes real credentials into it, so a render leaves it, and a
/// user file that appears later refuses the render instead of deleting
/// either login. `models.json` holds no credentials of pi's making (pi has
/// no write path to it), so an older file of ours by that name may go.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn link_user_files(home: &Path, user_dir: &Path) -> Result<(), String> {
    let dir = crate::safe_fs::private_subdir(home).map_err(|e| format!("{}: {e}", home.display()))?;
    shared::link_user_file(&dir, user_dir, "auth.json", false, "pi").map_err(|e| auth_conflict(e, home, user_dir))?;
    shared::link_user_file(&dir, user_dir, "models.json", true, "pi")
}

/// The refusal for two logins (validator, #71 note 33): both paths, and the
/// one step that resolves it. Nothing is removed by us.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn auth_conflict(e: String, home: &Path, user_dir: &Path) -> String {
    if !e.starts_with("refusing to replace existing pi path: auth.json") {
        return e;
    }
    let (managed, user) = (home.join("auth.json"), user_dir.join("auth.json"));
    format!(
        "refusing to replace existing pi path: auth.json. This agent's home holds its own pi login, {}, and your pi login, {}, now exists too. Neither was changed, and the agent was not started. To give the agent your login, back up and then remove {}, and start the agent again.",
        managed.display(), user.display(), managed.display()
    )
}

/// The telemetry extension of a managed pi home (pi's dialect of the one
/// generator).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn telemetry_extension(notify: &str) -> String {
    super::pi_telemetry::extension(notify, super::pi_telemetry::Dialect::Pi)
}

/// Where the user's own pi agent state lives: `PI_CODING_AGENT_DIR` when the
/// user set it, else `~/.pi/agent`. Only read, never written.
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn pi_user_agent_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".pi").join("agent")
}

/// Under test the user's pi state is a per-process temp dir: a test never
/// reads, links or depends on the developer's real `~/.pi`.
#[cfg(test)]
pub(crate) fn pi_user_agent_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-pi-user-home")).clone()
}

/// The pi half of `refresh_hooks`: the extension is a generated FILE,
/// rewritten whole when this build's text differs.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> Result<bool, String> {
    let ext = home.join("extensions").join(EXTENSION);
    if !ext.is_file() {
        return Ok(false);
    }
    let fresh = telemetry_extension(notify);
    if std::fs::read_to_string(&ext).ok().as_deref() != Some(fresh.as_str()) {
        return shared::write_atomic(&ext, &fresh).map(|_| true);
    }
    Ok(false)
}

/// pi's exact resume: `--session-id <id>` opens the cwd's session with that
/// id (its cli docs; measured: the chat came back and answered from its
/// history). `--session <id>` would offer a FORK for another directory's
/// session, so it is not used. The ONE construction `resume_command` and
/// `resume_exact` share.
fn exact_line(cmd: &str, id: &str) -> String {
    format!("{cmd} --session-id {}", crate::shell::quote(id))
}

/// The strict form for a restore after a reboot (board #422).
pub(crate) fn resume_exact(cmd: &str, id: &str) -> Option<String> {
    (!cmd.trim().is_empty() && super::shared::exact_id_ok(id)).then(|| exact_line(cmd, id))
}

/// The recipe dialect: the exact session, else `--continue`, the most
/// recent session for the cwd inside this agent's own home.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    match id {
        Some(id) => exact_line(cmd, id),
        None => format!("{cmd} --continue"),
    }
}

/// This backend's detection/relaunch row. pi sets its process title, so the
/// pane's process is named `pi` (measured: pane_current_command `pi`, comm
/// `pi`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "pi",
        programs: &["pi"],
        launch: "pi",
        resume_recent: Some("pi --continue"),
        resume_id: Some("pi --session-id {id}"),
        versioned_binary_dir: None,
    }
}

/// What a NEW managed pi needs set up: unknown, as for omp. The providers
/// live in models.json, whose keys may be literals or `$VAR` names; a file's
/// presence is said, nothing inside it is read.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn set_up_need() -> super::readiness::Need {
    use super::readiness::{Need, SetUp};
    let dir = pi_user_agent_dir();
    let via = if dir.join("models.json").is_file() || dir.join("auth.json").is_file() { "provider config present" } else { "no provider config" };
    Need::Found(SetUp::unknown("credential_store_unverified").with_via(via))
}

#[cfg(test)]
mod tests {
    #![cfg(not(any(target_os = "android", target_os = "ios")))]
    use super::*;

    /// The measured footer (pi 1.5.0, #71 note 9), idle and busy, with and
    /// without a provider prefix, a level, `thinking off`, and `no-model`.
    #[test]
    fn the_footer_is_read_under_the_last_rule() {
        let rule = "─".repeat(60);
        let screen = |stats: &str| format!(" ready\n{rule}\n\n{rule}\n/work/p (master)\n{stats}\n");
        let v = sniff_pi(&screen("↑2.3k ↓1 1.8%/128k (auto)                                       (ust) claude-haiku-5-5 • low"));
        assert_eq!((v.model.as_deref(), v.effort.as_deref(), v.context_pct), (Some("claude-haiku-5-5"), Some("low"), Some(2)));
        let v = sniff_pi(&screen("↑15k ↓807 2.3%/128k (auto)                                          (ust-openai) gpt-6-astra"));
        assert_eq!((v.model.as_deref(), v.effort, v.context_pct), (Some("gpt-6-astra"), None, Some(2)));
        let v = sniff_pi(&screen("0.0%/128k (auto)                                         claude-opus-5-5 • thinking off"));
        assert_eq!((v.model.as_deref(), v.effort.as_deref()), (Some("claude-opus-5-5"), Some("off")));
        let v = sniff_pi(&screen("0.0%/128k (auto)                                                   no-model"));
        assert_eq!(v.model, None);
        // Busy: the editor's top rule says Working; the bottom rule is pure.
        let busy = format!(" tell @reviewer hi\n── ⠧ Working {}\n\n{rule}\n/work/p (master)\n↑7.0k ↓137 1.9%/128k (auto)            (ust) claude-haiku-5-5 • high\n", "─".repeat(40));
        assert_eq!(sniff_pi(&busy).effort.as_deref(), Some("high"));
        // A quoted footer in the transcript, with no rule under it, is not read.
        assert_eq!(sniff_pi(" /work/p (master)\n ↑1 ↓1 9.0%/128k (auto)    (x) fake • max\n"), Vitals::default());
    }

    /// The declared list: models.json `provider/id`, then the settings'
    /// default, de-duplicated; secrets beside them are never read out; a
    /// file that is not JSON is Invalid.
    #[test]
    fn declared_models_are_provider_slash_id() {
        let models = r#"{"providers":{"ust":{"baseUrl":"https://x","apiKey":"SECRET-1","models":[{"id":"claude-opus-5-5"},{"id":"claude-haiku-5-5"}]},"ust-openai":{"apiKey":"$UST_API_KEY","models":[{"id":"gpt-6-astra"}]}}}"#;
        let settings = r#"{"defaultProvider":"ust","defaultModel":"claude-opus-5-5","defaultThinkingLevel":"medium"}"#;
        let ids = declared_models(Some(models), Some(settings)).unwrap();
        assert_eq!(ids, ["ust/claude-opus-5-5", "ust/claude-haiku-5-5", "ust-openai/gpt-6-astra"]);
        assert!(ids.iter().all(|i| !i.contains("SECRET")));
        assert_eq!(declared_models(None, Some(r#"{"defaultModel":"m"}"#)).unwrap(), ["m"]);
        assert_eq!(declared_models(Some("not json"), None), Err(super::super::ModelReason::Invalid));
    }

    /// The settings a home gets: the user's defaults under an empty
    /// definition; the definition's `provider/id` and effort over them;
    /// trust and no telemetry always; nothing else of the user's file.
    #[test]
    fn settings_carry_the_definition_over_the_users_defaults() {
        let user = serde_json::json!({"defaultProvider":"ust","defaultModel":"claude-opus-5-5","defaultThinkingLevel":"medium","theme":"dark","packages":["x"]});
        let s = pi_settings(Some(&user), "", "", &[]);
        assert_eq!(default_model(&s).as_deref(), Some("ust/claude-opus-5-5"));
        assert_eq!(s["defaultThinkingLevel"], "medium");
        assert_eq!((s["defaultProjectTrust"].as_str(), s["enableInstallTelemetry"].as_bool()), (Some("trusted"), Some(false)));
        assert!(s.get("theme").is_none() && s.get("packages").is_none(), "UI prefs and packages do not carry");
        let s = pi_settings(Some(&user), "ust-openai/gpt-6-astra", "high", &[]);
        assert_eq!((s["defaultProvider"].as_str(), s["defaultModel"].as_str(), s["defaultThinkingLevel"].as_str()), (Some("ust-openai"), Some("gpt-6-astra"), Some("high")));
        let s = pi_settings(Some(&user), "bare-model", "", &[]);
        assert_eq!((s.get("defaultProvider"), s["defaultModel"].as_str()), (None, Some("bare-model")), "a bare id names no provider");
    }

    /// The measured menu screens: `→ high` under the bottom rule is open;
    /// the same screen after Escape, and the idle footer, are not; a `→` in
    /// the transcript above the editor is not the menu.
    #[test]
    fn the_completion_menu_is_read_under_the_editor() {
        let rule = "─".repeat(60);
        let open = format!(" Thinking level: high\n{rule}\n/thinking high\n{rule}\n→ high\n/work/live\n0.0%/128k (auto)     claude-haiku-5-5 • low\n");
        assert!(picker_open(&open));
        let model = format!("{rule}\n/model ust/claude-sonnet-5-5\n{rule}\n→ claude-sonnet-5-5               ust\n/work/live\n0.0%/128k (auto)     x\n");
        assert!(picker_open(&model));
        let closed = format!("{rule}\n/thinking high\n{rule}\n/work/live\n0.0%/128k (auto)     claude-haiku-5-5 • low\n");
        assert!(!picker_open(&closed));
        let quoted = format!(" → high was the answer\n{rule}\n\n{rule}\n/work/live\n0.0%/128k (auto)  x\n");
        assert!(!picker_open(&quoted));
    }

    /// Review R1 (#71): pi's own credentials in the home are never deleted.
    /// With no user auth.json, pi creates <home>/auth.json and a /login
    /// writes it; renders keep it. A user auth.json that appears later
    /// refuses the render and touches neither file. A correct link stays.
    #[cfg(unix)]
    #[test]
    fn a_managed_pi_login_survives_every_render() {
        let root = crate::config::test_scratch("tmm-pi-auth");
        let user = root.join("user");
        let home = root.join("home");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("auth.json"), r#"{"anthropic":{"type":"oauth","refresh":"SENTINEL-native"}}"#).unwrap();
        link_user_files(&home, &user).unwrap();
        link_user_files(&home, &user).unwrap();
        assert_eq!(std::fs::read_to_string(home.join("auth.json")).unwrap(), r#"{"anthropic":{"type":"oauth","refresh":"SENTINEL-native"}}"#, "no user source: the home's own login stays");
        std::fs::write(user.join("auth.json"), r#"{"user":"SENTINEL-user"}"#).unwrap();
        let err = link_user_files(&home, &user).unwrap_err();
        assert!(err.contains("refusing to replace existing pi path: auth.json"), "{err}");
        let (m, u) = (home.join("auth.json"), user.join("auth.json"));
        assert!(err.contains(&format!("back up and then remove {}", m.display())) && err.contains(&u.display().to_string()), "both paths, and which to remove: {err}");
        assert!(std::fs::read_to_string(home.join("auth.json")).unwrap().contains("SENTINEL-native"), "the home's login is not replaced");
        assert!(std::fs::read_to_string(user.join("auth.json")).unwrap().contains("SENTINEL-user"), "the user's is not touched");
        // A home that never had its own: the user's is linked, and stays linked.
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        link_user_files(&fresh, &user).unwrap();
        link_user_files(&fresh, &user).unwrap();
        assert!(std::fs::symlink_metadata(fresh.join("auth.json")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(fresh.join("auth.json")).unwrap(), std::fs::canonicalize(user.join("auth.json")).unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    /// The resume dialect: `--session-id <id>` exact, `--continue` recent.
    #[test]
    fn resume_is_session_id_or_continue() {
        assert_eq!(resume_command("command pi -x", Some("01a1b70f-02a9-74b8-bc52-bd9d1ffc429d")), "command pi -x --session-id 01a1b70f-02a9-74b8-bc52-bd9d1ffc429d");
        assert_eq!(resume_command("command pi -x", None), "command pi -x --continue");
        assert_eq!(resume_exact("command pi", ""), None);
    }
}
