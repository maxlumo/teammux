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

/// omp models ride its own catalog files; no authoritative list to ask.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    None
}

use serde_json::Value;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

/// omp's persistent footer is the TOP border of its input box — one line
/// carrying the π mark and, width permitting, the model, thinking level,
/// cwd, session cost and a context gauge (measured, omp 18.0.6):
///
/// `╭── π  > ⬢ Fable 5.1 (Bedrock, 1M) · ◒ high > 📁 /path > $0.45 ▶─3%─┃1M───╮`
///
/// The line is RESPONSIVE: a fresh session has no gauge yet
/// (`… > 📁 /path ▶────────╮`), and a narrow pane drops the model/effort
/// segments entirely (`╭── π  > 📁 …work ▶────13%───┃────1M───╮` was
/// measured live) — so every field is independently optional and `backfill`
/// carries an older wide reading across a narrow capture. The `>`-separated
/// segments are read by MARK, not position: `⬢` heads the model (with the
/// thinking level as its `·` sub-segment), `▶ … ┃` frames the used-context
/// percentage. Cost and the window size have no Vitals field and are not
/// read.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_omp(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    for line in pane.lines().rev() {
        let s = line.trim();
        // The signature: an input-box top border that carries omp's π mark.
        // Tool cards and plain output draw boxes too, but never with π.
        if !(s.starts_with('╭') && s.ends_with('╮') && s.contains(" π ")) {
            continue;
        }
        for segment in s.split(" > ") {
            let segment = segment.trim();
            if let Some(model_part) = segment.strip_prefix('⬢') {
                // `⬢ <model> [· <glyph> <effort>]` — the glyph varies with
                // the level, so the effort is read as the sub-segment's last
                // word, gated on omp's own enum.
                let mut parts = model_part.split(" · ");
                let model = parts.next().unwrap_or("").trim();
                if !model.is_empty() {
                    v.model = Some(model.to_string());
                    // The model segment is the one that carries the level:
                    // seeing it without one is a verdict, not a truncation.
                    v.effort_definitive = true;
                }
                for extra in parts {
                    if let Some(word) = extra.split_whitespace().last() {
                        if matches!(word, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto") {
                            v.effort = Some(word.to_string());
                        }
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
        break; // the last π border is the live footer; older ones scrolled by
    }
    v
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
///   (identity in config, never the launch line); EFFORT rides `--thinking`,
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
    // catalog lacks — on this host the Bedrock trio (fable-5-1/opus/gpt-5.6)
    // under `bedrock-extra` — and a registry def may name exactly such a
    // model. An isolated home without the catalog cannot resolve it, so the
    // file carries; UI prefs and hooks deliberately do NOT (that is what
    // isolation is for).
    let user_models = omp_user_agent_dir().join("models.yml");
    if user_models.is_file() {
        shared::copy_private(&user_models, &home.join("models.yml"))?;
    }

    // config.yml: the model is identity, so it lives in the config the owner
    // can read, not on the launch line (kiro's lesson). Empty = omp default,
    // so an unpinned model removes the previous render's file.
    let model = def.model.trim();
    let config = (!model.is_empty()).then(|| format!("modelRoles:\n  default: {model}\n"));
    shared::write_owned(&home.join("config.yml"), config.as_deref())?;

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
            "command omp --auto-approve --append-system-prompt {}{}",
            crate::shell::quote(&prompt_path.to_string_lossy()),
            thinking,
        ),
        confirmation: None,
    })
}

/// Where the user's own omp agent state lives. Only read, never written.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn omp_user_agent_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".omp").join("agent")
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
        r#"// tmux-mobile telemetry hook — auto-generated, rewritten on every start
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
