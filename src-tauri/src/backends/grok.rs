//! The grok backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// No queue|steer choice (board #245): grok documents `[ui]
/// follow_up_behavior = "queue" | "steer"` (default queue), but no managed
/// grok turn completes on this host (every turn fails with a Bedrock 400,
/// board #252), so neither mode could be measured. Unmeasured doors are not
/// offered; grok keeps its default, queue.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;

/// grok `/effort` doc: low|medium|high|xhigh (grok 1.0.5, measured).
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh"]
}

/// `grok models` (1.0.5) prints a plain list:
///   Available models:
///     - grok-4.6
///     * bedrock-grok46 (default)
/// The `*` marks the default; a custom model may carry a "(default)" or
/// description suffix — the id is the first token after the bullet.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    let out = std::process::Command::new("grok").arg("models").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let models: Vec<String> = text
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("- ").or_else(|| l.strip_prefix("* "))?;
            rest.split_whitespace().next().map(str::to_string)
        })
        .collect();
    (!models.is_empty()).then_some(models)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

/// Read what grok's screen says about its current state. grok 1.0.5 paints two
/// fixtures (measured live, 2026-08-21/22):
///
/// - a header line, cwd left + context ratio right: `/w/reports   47K / 500K`
///   ("上下文长度在右上角" — the owner's words for where to look). The ratio is
///   used / total tokens, so the percentage is computed, not read.
/// - the input box's bottom border carries the model (and the approval mode):
///   `╰──────── Grok 4.6 (Bedrock) · always-approve ─╯`.
///
/// No agent-name anchor exists in either fixture, so both fields identify
/// themselves BY SHAPE: the ratio must be `N[K|M] / N[K|M]` at the end of a
/// line, the model must sit in a `╰…╯` border. Bottom-up, newest paint wins —
/// the footer is redrawn at the bottom, and stale headers scroll upward.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_grok(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    for line in pane.lines().rev() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if v.model.is_none() {
            if let Some(m) = grok_footer_model(line) {
                v.model = Some(m);
            }
        }
        if v.context_pct.is_none() {
            if let Some(pct) = grok_context_ratio(line) {
                v.context_pct = Some(pct);
            }
        }
        if v.model.is_some() && v.context_pct.is_some() {
            break;
        }
    }
    v
}

/// The model out of grok's input-box bottom border: `╰─── <model> [· mode] ─╯`.
/// The border glyphs are the marker — ordinary output does not draw box
/// corners — and the FIRST `·`-segment inside is the model; what follows is
/// the approval mode (`always-approve`), which changes per keypress and is not
/// a vital.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_footer_model(line: &str) -> Option<String> {
    let s = line.trim();
    if !(s.starts_with('╰') && s.ends_with('╯')) {
        return None;
    }
    let inner = s.trim_matches(|c| matches!(c, '╰' | '╯' | '─')).trim();
    let model = inner.split('·').next()?.trim();
    // An empty border (`╰────╯`, no label) is the box with nothing to say.
    if model.is_empty() || model.chars().all(|c| c == '─' || c.is_whitespace()) {
        return None;
    }
    Some(model.to_string())
}

/// `47K / 500K` at the END of a line → percentage of the context used. Both
/// sides must parse as token counts and the ratio must make sense (used ≤
/// total); a `3 / 5` in ordinary output fails the K/M requirement on the
/// total, which is what keeps arithmetic in a diff from becoming a reading.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_context_ratio(line: &str) -> Option<u8> {
    let s = line.trim_end();
    let (head, total_txt) = s.rsplit_once('/')?;
    let total_txt = total_txt.trim();
    let used_txt = head.trim_end().rsplit(char::is_whitespace).next()?;
    // The total is a model's context budget: it always carries a magnitude
    // suffix (500K, 2M). Requiring it filters out fractions in ordinary text.
    if !total_txt.ends_with(['K', 'M']) {
        return None;
    }
    crate::projects::vitals::used_pct(grok_tokens(used_txt)?, grok_tokens(total_txt)?)
}

/// `47K` → 47_000, `1.2M` → 1_200_000, `800` → 800.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_tokens(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, mult) = match s.strip_suffix('M') {
        Some(n) => (n, 1_000_000.0),
        None => match s.strip_suffix('K') {
            Some(n) => (n, 1_000.0),
            None => (s, 1.0),
        },
    };
    let n: f64 = num.trim().parse().ok()?;
    (n >= 0.0).then_some(n * mult)
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

/// grok 1.0.5 hook schema (its own docs, `~/.grok/docs/user-guide/10-hooks.md`,
/// verified live 2026-08-21: an isolated `GROK_HOME/hooks/*.json` loads as an
/// always-trusted "global" hook and fires). Payload keys are camelCase
/// (`hookEventName`, `toolName`, `sessionId`, `lastAssistantMessage`), event
/// VALUES snake_case (`user_prompt_submit`, `stop`). A `stop` fires once with
/// `reason: "end_turn"` for the turn AND once at session end (`"shutdown"`) —
/// the normalizer filters on the reason. An omitted matcher matches everything.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_hooks(notify: &str) -> Value {
    json!({
        "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "PreToolUse":  [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "PostToolUse": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "Stop": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "StopFailure": [ { "hooks": [ { "type": "command", "command": notify } ] } ]
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_grok(
    def: &RegAgent, name: &str, home: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    std::fs::create_dir_all(home.join("agents")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(home.join("hooks")).map_err(|e| e.to_string())?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("grok");

    // Telemetry hooks: `<GROK_HOME>/hooks/*.json` is that home's "global"
    // scope, always trusted — no folder-trust dance (verified live, grok
    // 1.0.5: loaded by `grok inspect`, fired on a real turn).
    std::fs::write(
        home.join("hooks").join("tmux-mobile.json"),
        serde_json::to_string_pretty(&json!({ "hooks": grok_hooks(&notify) })).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    // config.toml: folder trust off (the workspace is the user's own project,
    // spawned deliberately; an untrusted folder would gate project rules and
    // sit the TUI at a prompt nobody sees), MCP servers, and the USER's model
    // catalog carried over — grok auth is HOME-scoped (`auth.json` + custom
    // [model.*] entries whose keys ride env vars), so an isolated home without
    // the catalog is a logged-out agent (measured: "You are not authenticated").
    std::fs::write(home.join("config.toml"), grok_config_toml(&crate::projects::spawn::mcp_defs(def)))
        .map_err(|e| e.to_string())?;
    let user_auth = grok_user_home().join("auth.json");
    if user_auth.is_file() {
        let _ = std::fs::copy(&user_auth, home.join("auth.json"));
    }

    // The agent definition: kiro's pattern in grok's dialect — YAML
    // frontmatter + the system prompt as the body, selected via `--agent`.
    // The MODEL lives here, not on the launch line (same lesson as kiro:
    // verified that a frontmatter `model:` is honored, and it survives every
    // start path because they all pass --agent). Skills have no isolated-home
    // mechanism we control, so the compact index rides the prompt like claude.
    let full_prompt = if skills.is_empty() {
        system_prompt.to_string()
    } else {
        format!("{}\n\n{}", system_prompt, crate::projects::skills::skills_index_text(skills))
    };
    let mut fm = format!("---\nname: {name}\ndescription: {} (registry agent)\n", def.name);
    let model = def.model.trim();
    if !model.is_empty() {
        fm.push_str(&format!("model: {model}\n"));
    }
    fm.push_str("---\n\n");
    std::fs::write(home.join("agents").join(format!("{name}.md")), format!("{fm}{full_prompt}"))
        .map_err(|e| e.to_string())?;

    Ok(Rendered {
        env: vec![("GROK_HOME".into(), home.to_string_lossy().to_string())],
        cmd: format!(
            "command grok --always-approve --agent {}{}",
            crate::shell::quote(name),
            effort_flag(def),
        ),
        confirmation: None,
    })
}

/// Where the user's own grok lives. Only read, never written.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".grok")
}

/// The isolated home's config.toml: folder-trust off, the user's model
/// catalog (`[models]` + `[model.*]` — the auth-bearing half of grok config;
/// hooks/MCP/UI prefs deliberately do NOT carry, that is what isolation is
/// for), and the registry MCP servers in grok's `[mcp_servers.<name>]` shape.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_config_toml(mcps: &[shared::McpDef]) -> String {
    let user = std::fs::read_to_string(grok_user_home().join("config.toml")).ok();
    grok_config_toml_from(mcps, user.as_deref())
}

/// The pure half, so the catalog carry is testable. TRAP, already paid for
/// once: toml 1.x parses a DOCUMENT via `toml::Table` — `Value::from_str`
/// parses a single value and fails on any real config with "expected nothing",
/// which silently dropped the whole catalog and left every spawned grok at a
/// login screen (caught live, 2026-08-21).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn grok_config_toml_from(mcps: &[shared::McpDef], user_config: Option<&str>) -> String {
    let mut root = toml::value::Table::new();
    let mut trust = toml::value::Table::new();
    trust.insert("enabled".into(), toml::Value::Boolean(false));
    root.insert("folder_trust".into(), toml::Value::Table(trust));
    if let Some(user) = user_config.and_then(|t| t.parse::<toml::Table>().ok()) {
        for key in ["models", "model"] {
            if let Some(v) = user.get(key) {
                root.insert(key.into(), v.clone());
            }
        }
    }
    let mut servers = toml::value::Table::new();
    for m in mcps {
        let Some(cmd) = m.command.as_deref().filter(|c| !c.is_empty()) else { continue };
        if m.name.is_empty() {
            continue;
        }
        let mut t = toml::value::Table::new();
        t.insert("command".into(), toml::Value::String(cmd.to_string()));
        if !m.args.is_empty() {
            t.insert(
                "args".into(),
                toml::Value::Array(m.args.iter().map(|a| toml::Value::String(a.clone())).collect()),
            );
        }
        if !m.env.is_empty() {
            let mut env = toml::value::Table::new();
            for (k, v) in &m.env {
                env.insert(k.clone(), toml::Value::String(v.clone()));
            }
            t.insert("env".into(), toml::Value::Table(env));
        }
        servers.insert(m.name.clone(), toml::Value::Table(t));
    }
    if !servers.is_empty() {
        root.insert("mcp_servers".into(), toml::Value::Table(servers));
    }
    let body = toml::to_string(&root).unwrap_or_default();
    format!("# Written by tmux-mobile — regenerated at every spawn.\n{body}")
}


/// The grok half of `refresh_hooks`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> bool {
    let hooks = home.join("hooks").join("tmux-mobile.json");
    hooks.is_file() && patch_hooks(&hooks, grok_hooks(notify))
}

/// grok resume dialect: `--resume <id>` exact, `--continue` recent.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    match id {
        Some(id) => format!("{cmd} --resume {}", crate::shell::quote(id)),
        None => format!("{cmd} --continue"),
    }
}

/// This backend's detection/relaunch row (board #129). grok 1.0.5 --help:
/// `-c/--continue` — "Continue the most recent session for the current
/// working directory" (cwd-scoped, so safe, unlike codex's machine-wide
/// --last); `--resume <id>` exact. Recipe dialect: `resume_command` above.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on grok 1.0.41:
/// no echo of OUR text. `/goal` submits grok's own planner prompt ("You are
/// the Goal Plan Writer for the xAI Grok Build harness…"), which stays an
/// INPUT row — it is not what was typed and has no stable shape; `/effort`
/// fires nothing.
pub(crate) fn command_echo(_name: &str, _args: &str) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "grok",
        programs: &["grok"],
        launch: "grok",
        resume_recent: Some("grok --continue"),
        resume_id: Some("grok --resume {id}"),
        versioned_binary_dir: None,
    }
}

/// grok's hook payload dialect (board #129), measured on grok 1.0.5: the key
/// is camelCase `hookEventName`; a turn's true end is `stop` with reason
/// "end_turn" — a second observe-only stop fires at session teardown
/// ("shutdown"/"channel_closed") and must not read as a completion.
/// `stop_failure` is the API-error end of a turn.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hookEventName"]);
    match event.as_deref() {
        Some("stop") => {
            let reason = crate::agent_notifications::string_field(payload, &["reason"]);
            if reason.as_deref() != Some("end_turn") {
                return Err("grok stop without end_turn is not a completion".into());
            }
            Ok("completed")
        }
        Some("stop_failure") => Ok("failed"),
        _ => Err("unsupported grok event".into()),
    }
}

/// grok 1.0.5: camelCase key, snake_case value (measured).
pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hookEventName")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("user_prompt_submit"))
}
