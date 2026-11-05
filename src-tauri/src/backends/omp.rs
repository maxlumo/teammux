//! The omp backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// No queue|steer choice (board #245, measured on omp 18.2.10): Enter
/// steers, and `<home>/keybindings.yml` `app.message.followUp: enter` does
/// queue the line in the pane — but a follow-up continues the same run with no
/// new `agent_start`, so our telemetry extension reports no prompt for it: the
/// line was swept `unconfirmed` and the one Stop replied to the first sender
/// with the second sender's answer. Offering queue would need the extension
/// to report follow-ups first.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;

/// omp 18.0.6 `--thinking` (its own --help): "off, minimal, low, medium,
/// high, xhigh, max, auto".
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]
}

/// What this host DECLARES for omp (board #511), offered as SUGGESTIONS:
/// the selector `<provider>/<id>` of every model under `models.yml`
/// `providers.<p>.models[].id`, then the `config.yml` `modelRoles` values.
/// Files only — `omp models` is NOT run (it rewrites omp's own catalogue
/// cache); omp's bundled catalogue stays reachable as free text.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list() -> Result<(Vec<String>, super::ModelKind), super::ModelReason> {
    let dir = omp_user_agent_dir();
    let models = super::read_model_source(&dir.join("models.yml"))?;
    let config = super::read_model_source(&dir.join("config.yml"))?;
    let ids = declared_models(models.as_deref(), config.as_deref())?;
    if ids.is_empty() {
        return Err(super::ModelReason::NotListed);
    }
    Ok((ids, super::ModelKind::Suggestions))
}

/// The baseline default: `omp_model_roles(config, "")`'s `default` — the
/// SAME function `render_omp` uses for an empty definition.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn baseline_model() -> Result<Option<String>, super::ModelReason> {
    let config = super::read_model_source(&omp_user_agent_dir().join("config.yml"))?;
    if let Some(text) = config.as_deref() {
        serde_yaml_ng::from_str::<serde_yaml_ng::Mapping>(text).map_err(|_| super::ModelReason::Invalid)?;
    }
    Ok(omp_model_roles(config.as_deref(), "").get("default").and_then(serde_yaml_ng::Value::as_str).map(str::to_string))
}

/// Pure: the allow-listed ids from the two files' text, de-duplicated. A
/// file present but not YAML is `Invalid`; nothing else of either file is
/// read (api keys, headers and base URLs sit beside these fields).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn declared_models(models_yml: Option<&str>, config_yml: Option<&str>) -> Result<Vec<String>, super::ModelReason> {
    use serde_yaml_ng::{Mapping, Value};
    let parse = |t: &str| serde_yaml_ng::from_str::<Mapping>(t).map_err(|_| super::ModelReason::Invalid);
    let mut out: Vec<String> = Vec::new();
    let mut push = |id: String, out: &mut Vec<String>| {
        if !out.contains(&id) {
            out.push(id);
        }
    };
    if let Some(text) = models_yml {
        let doc = parse(text)?;
        for (provider, body) in doc.get("providers").and_then(Value::as_mapping).into_iter().flatten() {
            let Some(provider) = provider.as_str() else { continue };
            for m in body.get("models").and_then(Value::as_sequence).into_iter().flatten() {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    push(format!("{provider}/{id}"), &mut out);
                }
            }
        }
    }
    if let Some(text) = config_yml {
        parse(text)?;
        for (_, v) in omp_model_roles(Some(text), "") {
            if let Some(id) = v.as_str() {
                push(id.to_string(), &mut out);
            }
        }
    }
    Ok(out)
}

use serde_json::Value;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

/// omp's persistent footer is one line of `>`-separated segments: a head,
/// then, width permitting, the model with its thinking level, the cwd, the
/// session cost and a context gauge. It has had two shapes:
///
/// * the BOX shape (omp 18.0.6 to 18.2.10, and `composer.shape: box` on
///   later builds), the top border of the input box:
///   `╭── π  > ⬢ Fable 5.1 (Bedrock, 1M) · ◒ high > 📁 /path > $0.45 ▶─3%─┃1M───╮`
/// * the BAND shape (omp 18.15.0, the default `composer.shape: band`, measured
///   2026-11-05): no border, the thinking level is a glyph in front of the
///   model, and the head is `π` when idle and a spinner with the turn's
///   elapsed time while a turn runs:
///   ` π > ◒ Opus 5.5 (UST) > 🗑 /tmp ▶─1%────╎┃──────1M─`
///   ` ⠼ 7s > ⬢ Opus 5.5 (UST) > 🗑 /tmp ▶─2%────╎┃──────1M─`
///   `╰─                       ⇧⇥ to change thinking effort`
///
/// The line is RESPONSIVE: a fresh session has no gauge yet, and a pane too
/// narrow for the cwd drops the model segment (`… 32s > 📁 …mmux ▶──17%─╎┃1M─`
/// was measured live) — so every field is independently optional and
/// `backfill` carries an older wide reading across a narrow capture. The
/// segments are read by MARK, not position: a glyph heads the model
/// (`⬢` = the model has no thinking levels, `⦸ ○ ◔ ◑ ◒ ◕ ⟳` = off, minimal,
/// low, medium, high, xhigh, auto; the box shape and
/// `statusLine.compactThinkingLevel: false` spell the level as a `· ◒ high`
/// sub-segment instead), `▶ … ┃` frames the used-context percentage. Cost and
/// the window size have no Vitals field and are not read.
///
/// The BAND footer has no border to authenticate it, and this project's own
/// room messages quote footers verbatim, so it is a POSITION: the line
/// directly above a line that starts with `╰─` in column 0 (the prompt's
/// own corner), whose head is `π` or a braille spinner and which carries the
/// `▶` gauge. A quote in a message, a tool card (`│ …`) or an indented
/// paste has no `╰─` under it at column 0.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_omp(pane: &str) -> Vitals {
    let lines: Vec<&str> = pane.lines().collect();
    for (i, line) in lines.iter().enumerate().rev() {
        let s = line.trim();
        // BOX signature: an input-box top border that carries omp's π mark.
        // Tool cards and plain output draw boxes too, but never with π.
        let boxed = s.starts_with('╭') && s.ends_with('╮') && s.contains(" π ");
        // BAND signature: see the position rule above.
        let banded = !boxed
            && line.starts_with(' ')
            && !line.starts_with("  ")
            && lines.get(i + 1).is_some_and(|next| next.starts_with("╰─"))
            && s.contains('▶')
            && s.split(" > ").next().is_some_and(is_band_head);
        if !(boxed || banded) {
            continue;
        }
        let mut v = Vitals::default();
        for segment in s.split(" > ") {
            let segment = segment.trim();
            // `<mark> <model> [· <glyph> <effort>]`: the box shape's mark is
            // always `⬢` with the level as a sub-segment, the band shape's
            // is the level glyph itself.
            let Some((mark, model_part)) = segment.chars().next().map(|c| (c, &segment[c.len_utf8()..])) else {
                continue;
            };
            let glyph_effort = match mark {
                '⬢' => None,
                '⦸' => Some("off"),
                '○' => Some("minimal"),
                '◔' => Some("low"),
                '◑' => Some("medium"),
                '◒' => Some("high"),
                '◕' => Some("xhigh"),
                '⟳' => Some("auto"),
                _ => continue,
            };
            if !model_part.starts_with(' ') {
                continue;
            }
            let mut parts = model_part.split(" · ");
            let model = parts.next().unwrap_or("").trim();
            if !model.is_empty() {
                v.model = Some(model.to_string());
                // The model segment is the one that carries the level:
                // seeing it without one is a verdict, not a truncation.
                v.effort_definitive = true;
                if let Some(level) = glyph_effort {
                    v.effort = Some(level.to_string());
                }
            }
            // The glyph varies with the level, so the effort is read as the
            // sub-segment's last word, gated on omp's own enum.
            for extra in parts {
                if let Some(word) = extra.split_whitespace().last() {
                    if matches!(word, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto") {
                        v.effort = Some(word.to_string());
                    }
                }
            }
        }
        // `▶ … NN% … ┃` — the gauge frames the used share. The ┃ (or the
        // closing ╮ on a gauge that has no limit mark yet) bounds the scan so
        // a percentage in the cwd segment can never be read as context.
        if let Some(bar) = s.find('▶').map(|i| &s[i..]) {
            let bar = bar.split('┃').next().unwrap_or(bar);
            if let Some(end) = bar.find('%') {
                let digits: String = bar[..end]
                    .chars()
                    .rev()
                    .take_while(char::is_ascii_digit)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                if let Ok(pct) = digits.parse::<u8>() {
                    if pct <= 100 {
                        v.context_pct = Some(pct);
                    }
                }
            }
        }
        return v; // the last footer is the live one; older ones scrolled by
    }
    Vitals::default()
}

/// The band footer's head: `π` when idle, a braille spinner (and the turn's
/// elapsed time, `⠼ 7s`) while a turn runs.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_band_head(head: &str) -> bool {
    let head = head.trim();
    head == "π" || head.chars().next().is_some_and(|c| ('\u{2800}'..='\u{28ff}').contains(&c))
}


use serde_json::json;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::Rendered;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// omp (oh-my-pi) 18.x. The whole agent state — auth store (`agent.db`),
/// `config.yml`, `mcp.json`, sessions, extensions — lives in ONE directory
/// that `PI_CODING_AGENT_DIR` relocates (its settings docs: "the global
/// config.yml, the auth store (agent.db), and everything else under the
/// agent directory move with it"; verified live 2026-09-07, omp 18.0.6: a
/// fresh dir answers prompts and grows its own agent.db). The isolated home
/// IS that directory:
///
/// * auth carry: the user's `~/.omp/agent/agent.db` is the credential store
///   (`auth_credentials` table), so it is copied in — grok's auth.json
///   lesson; env-keyed providers (Bedrock bearer tokens) need nothing.
/// * the MODEL lives in `<home>/config.yml` under `modelRoles.default`
///   (identity in config); the user's own `modelRoles` carry, so an
///   unpinned model is the user's default. The same default role also rides
///   `--model`, because a resumed session otherwise restores its own last
///   model over the config. EFFORT rides `--thinking`,
///   omp's own knob, enumerated in `models::effort_values`.
/// * the system prompt is a FILE handed to `--append-system-prompt` —
///   APPEND, deliberately not `--system-prompt`: omp's builtin prompt
///   teaches its own tool harness (hashline edits, LSP, subagents), and
///   replacing it would lobotomize the tools. (Verified live: a file path
///   is read and its text reaches the prompt.)
/// * telemetry: omp auto-loads TS extensions from `<agent-dir>/extensions/`
///   (its extension-loading docs; the path honors PI_CODING_AGENT_DIR). The
///   generated hook forwards turn edges and tool events to the tmm notify
///   helper in claude's payload dialect, so the normalizer needs no new
///   shapes — only the `omp` backend arm.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_omp(
    def: &RegAgent, _name: &str, home: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    std::fs::create_dir_all(home.join("extensions")).map_err(|e| e.to_string())?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    shared::write_atomic(
        &home.join("extensions").join("tmm-telemetry.ts"),
        &omp_telemetry_extension(&notifications.helper_command("omp")),
    )?;

    // Auth carry: agent.db holds `auth_credentials` — an isolated home
    // without it is a logged-out agent for OAuth-keyed providers. Best
    // effort, like grok's auth.json copy.
    let user_db = omp_user_agent_dir().join("agent.db");
    if user_db.is_file() {
        shared::copy_private(&user_db, &home.join("agent.db"))?;
    }
    // Model-catalog carry (grok's config.toml lesson, in omp's dialect): the
    // user's `models.yml` declares the custom providers/models the bundled
    // catalog lacks (a Bedrock trio, a private gateway — whatever that host
    // has), and the user's default role or a registry def names exactly such
    // a model. An isolated home without the catalog cannot resolve it, so the
    // file carries; UI prefs and hooks deliberately do NOT (that is what
    // isolation is for).
    let user_models = omp_user_agent_dir().join("models.yml");
    if user_models.is_file() {
        shared::copy_private(&user_models, &home.join("models.yml"))?;
    }

    // config.yml: the model is identity, so it lives in the config the owner
    // can read (kiro's lesson). The user's own `modelRoles` carry (kimi's
    // `default_model` lesson): an empty registry model is the USER's default,
    // not omp's bundled one, which on a host without its provider key is a
    // 403 (2026-11-03). Nothing to write removes the previous render's file.
    let user_config = std::fs::read_to_string(omp_user_agent_dir().join("config.yml")).ok();
    let roles = omp_model_roles(user_config.as_deref(), &def.model);
    shared::write_owned(&home.join("config.yml"), omp_config_yml(&roles).as_deref())?;
    // ...and the same `default` role rides `--model` (omp 18.15.0, measured
    // 2026-11-03): a resumed session restores the model it last ran
    // (`model_change` in its jsonl) over config.yml, so a restart after a
    // definition change kept the old model; `--model` wins over both. A bad
    // id is a visible `Warning: Model … not found` and a `no-model` footer,
    // never kiro's silent fallback, so the line costs no visibility.
    let model_flag = roles
        .get("default")
        .and_then(serde_yaml_ng::Value::as_str)
        .map(|m| format!(" --model {}", crate::shell::quote(m)))
        .unwrap_or_default();

    // mcp.json in this home's user scope — claude's local-stdio/http shape
    // is omp's too (its mcp-config docs name `~/.omp/agent/mcp.json`).
    let mut servers = serde_json::Map::new();
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            servers.insert(m.name.clone(), shared::claude_mcp_value(m));
        }
    }
    // No servers removes the file: a revoked server must not stay loaded.
    let mcp = (!servers.is_empty()).then(|| serde_json::to_string_pretty(&json!({ "mcpServers": servers })).unwrap());
    shared::write_owned(&home.join("mcp.json"), mcp.as_deref())?;

    // The prompt file --append-system-prompt reads. Skills have no isolated-
    // home mechanism we control, so the compact index rides the prompt, like
    // grok and claude.
    let full_prompt = if skills.is_empty() {
        system_prompt.to_string()
    } else {
        format!("{}\n\n{}", system_prompt, crate::projects::skills::skills_index_text(skills))
    };
    let prompt_path = home.join("system-prompt.md");
    shared::write_atomic(&prompt_path, &full_prompt)?;

    let effort = def.effort.trim();
    let thinking = if effort.is_empty() {
        String::new()
    } else {
        format!(" --thinking {}", crate::shell::quote(effort))
    };
    Ok(Rendered {
        // OMP_SKIP_SETUP: a fresh isolated home has no `setupVersion`, so omp
        // 18.2.10 opens its provider-setup wizard ("Setup step 1 of 5") and
        // the pane sits there; every typed line and /command lands in the
        // wizard (measured 2026-09-27, #243). omp's own door: `selectSetupScenes`
        // returns no scenes when OMP_SKIP_SETUP is truthy. Auth already
        // carries (agent.db / env-keyed providers), so nothing is lost.
        env: vec![
            ("PI_CODING_AGENT_DIR".into(), home.to_string_lossy().to_string()),
            ("OMP_SKIP_SETUP".into(), "1".into()),
        ],
        cmd: format!(
            "command omp --auto-approve --append-system-prompt {}{}{}",
            crate::shell::quote(&prompt_path.to_string_lossy()),
            model_flag,
            thinking,
        ),
        confirmation: None,
    })
}

/// The model roles a managed omp runs with: the user's `modelRoles` and
/// nothing else of their `config.yml` (UI prefs and hooks are what isolation
/// is for), with a pinned registry model as the `default` role. Empty when
/// there is neither, so omp falls back to its bundled default. An unreadable
/// user file carries nothing rather than failing the spawn.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn omp_model_roles(user_config: Option<&str>, model: &str) -> serde_yaml_ng::Mapping {
    use serde_yaml_ng::{Mapping, Value};
    let mut roles = user_config
        .and_then(|t| serde_yaml_ng::from_str::<Mapping>(t).ok())
        .and_then(|m| m.get("modelRoles").and_then(Value::as_mapping).cloned())
        .unwrap_or_default();
    let model = model.trim();
    if !model.is_empty() {
        roles.insert("default".into(), model.into());
    }
    roles
}

/// The isolated home's `config.yml` for those roles; `None` (no file) when
/// there are none.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn omp_config_yml(roles: &serde_yaml_ng::Mapping) -> Option<String> {
    if roles.is_empty() {
        return None;
    }
    let mut root = serde_yaml_ng::Mapping::new();
    root.insert("modelRoles".into(), serde_yaml_ng::Value::Mapping(roles.clone()));
    serde_yaml_ng::to_string(&root).ok()
}

/// Where the user's own omp agent state lives. Only read, never written.
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
pub(crate) fn omp_user_agent_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".omp").join("agent")
}

/// Under test the user's omp state is a per-process temp dir (codex's
/// pattern): a render test never reads, or copies, the developer's real
/// `~/.omp` (board #448 P2: the agent.db and models.yml copies are driven
/// against it).
#[cfg(test)]
pub(crate) fn omp_user_agent_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-omp-user-home")).clone()
}

/// The telemetry extension a managed omp home carries: a hook factory (omp's
/// documented extension shape — default export receiving the `pi` API) that
/// forwards turn edges and tool events to the notify helper on stdin, in
/// claude's payload dialect. Every handler is wrapped in try/catch and the
/// child ignores errors: telemetry must never break the agent. TMUX_PANE
/// reaches the helper because the child inherits omp's env, which inherits
/// the pane's.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn omp_telemetry_extension(notify: &str) -> String {
    // The helper command is a shell line (quoted path + backend + marker
    // comment); embed it as a JSON string literal, which is also a valid TS
    // string literal.
    let cmd = serde_json::to_string(notify).unwrap();
    format!(
        r#"// Teammux telemetry hook — auto-generated, rewritten on every start
// (refresh_hooks). Forwards turn edges and tool events to the tmm notify
// helper, which is a no-op outside a tmux pane. Do not edit.
import {{ spawn }} from "node:child_process";

const NOTIFY = {cmd};

function send(payload: Record<string, unknown>): void {{
  try {{
    const child = spawn("/bin/sh", ["-c", NOTIFY], {{ stdio: ["pipe", "ignore", "ignore"] }});
    child.on("error", () => {{}});
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  }} catch {{}}
}}

function sessionId(ctx: any): string {{
  try {{ return String(ctx?.sessionManager?.getSessionId?.() ?? ""); }} catch {{ return ""; }}
}}

function textOf(content: unknown): string {{
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {{
    return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
  }}
  return "";
}}

export default function hook(pi: any): void {{
  // agent_start fires once per user prompt, but the prompt itself is not in
  // the session branch yet at that moment (measured, omp 18.0.6: the branch
  // tail is still model/thinking entries). The FIRST context event after it
  // carries the messages bound for the model — the newest user message there
  // is the submitted prompt, the delivery receipt tmm acks against.
  let awaitingPrompt = false;
  pi.on("agent_start", async (_event: any, _ctx: any) => {{
    awaitingPrompt = true;
  }});
  pi.on("context", async (event: any, ctx: any) => {{
    if (!awaitingPrompt) return;
    awaitingPrompt = false;
    let prompt = "";
    try {{
      const messages = event?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {{
        const m = messages[i] as any;
        if (m?.role === "user") {{ prompt = textOf(m.content); break; }}
      }}
    }} catch {{}}
    send({{ hook_event_name: "UserPromptSubmit", prompt, session_id: sessionId(ctx) }});
  }});
  // agent_end with willContinue is an auto-continuation, not a settle.
  pi.on("agent_end", async (event: any, ctx: any) => {{
    if (event?.willContinue) return;
    awaitingPrompt = false;
    let reply = "";
    try {{
      const messages = event?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {{
        const m = messages[i] as any;
        if (m?.role === "assistant") {{ reply = textOf(m.content); break; }}
      }}
    }} catch {{}}
    send({{ hook_event_name: "Stop", last_assistant_message: reply, session_id: sessionId(ctx) }});
  }});
  pi.on("tool_call", async (event: any, ctx: any) => {{
    send({{ hook_event_name: "PreToolUse", tool_name: event?.toolName ?? "tool", tool_input: event?.input ?? {{}}, session_id: sessionId(ctx) }});
  }});
  pi.on("tool_result", async (event: any, ctx: any) => {{
    send({{ hook_event_name: "PostToolUse", tool_name: event?.toolName ?? "tool", session_id: sessionId(ctx) }});
  }});
}}
"#
    )
}



/// The omp half of `refresh_hooks`: its hook is a generated FILE, not a key
/// in someone else's config — rewritten whole when this build's text differs
/// (helper path moves, new events), same ownership rule as patch_hooks.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> Result<bool, String> {
    let ext = home.join("extensions").join("tmm-telemetry.ts");
    if !ext.is_file() {
        return Ok(false);
    }
    let fresh = omp_telemetry_extension(notify);
    if std::fs::read_to_string(&ext).ok().as_deref() != Some(fresh.as_str()) {
        return shared::write_atomic(&ext, &fresh).map(|_| true);
    }
    Ok(false)
}

/// omp resume dialect: `--resume <id>` (id prefix), `--continue` follows the
/// cwd-scoped breadcrumb inside the isolated PI_CODING_AGENT_DIR.
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

/// This backend's detection/relaunch row (board #129). oh-my-pi is one `omp`
/// ELF binary, so pane_current_command says "omp" directly; detection
/// matches the program NAME exactly (`agents::by_program`, board #260), so
/// docker-compose and every other word containing "omp" stay shells. `--continue` is
/// cwd-scoped (sessions live under `~/.omp/agent/sessions/<encoded-cwd>/`),
/// `--resume <id>` takes an id prefix. Recipe dialect: `resume_command`.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on omp 18.2.10:
/// `/goal <args>` is echoed as the ARGUMENTS alone; `/usage` fires nothing.
/// Only `/goal` is declared: an args-only echo of any other command would be
/// a bare word that ordinary prose could contain.
pub(crate) fn command_echo(name: &str, args: &str) -> Option<String> {
    (name == "/goal" && !args.is_empty()).then(|| args.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "omp",
        programs: &["omp"],
        launch: "omp",
        resume_recent: Some("omp --continue"),
        resume_id: Some("omp --resume {id}"),
        versioned_binary_dir: None,
    }
}

/// omp's hook payload dialect (board #129): payloads are GENERATED by our
/// own telemetry extension in claude's dialect (`omp_telemetry_extension`
/// in this file): `Stop` with `last_assistant_message` + `session_id` is a
/// turn's end; the extension already filters auto-continuations
/// (willContinue), so no reason screening is needed here.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    if !matches!(event.as_deref(), Some("Stop")) {
        return Err("unsupported OMP event".into());
    }
    Ok("completed")
}

/// omp speaks claude's dialect by construction — the telemetry extension
/// EMITS claude-shaped payloads, so no third spelling exists.
pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))
}

/// What a NEW managed omp needs set up (board #492): ALWAYS unknown in phase
/// 1. Render copies the credential store (`agent.db`), but a row in it does
/// not prove the selected provider is set up (reviewer P2-F), so only the
/// file's presence is said, and nothing inside it is read.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn set_up_need() -> super::readiness::Need {
    set_up_need_in(&omp_user_agent_dir())
}

/// `set_up_need` against a given omp agent dir.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn set_up_need_in(dir: &Path) -> super::readiness::Need {
    use super::readiness::{Need, SetUp};
    let via = if dir.join("agent.db").is_file() { "credential store present" } else { "no credential store" };
    Need::Found(SetUp::unknown("credential_store_unverified").with_via(via))
}
