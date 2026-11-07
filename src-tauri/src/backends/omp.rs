//! The omp backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// No queue|steer choice (board #245, measured on omp 18.2.10): Enter
/// steers, and `<home>/keybindings.yml` `app.message.followUp: enter` does
/// queue the line in the pane — but a follow-up continues the same run with no
/// new `agent_start`, so our telemetry extension reports no prompt for it: the
/// line was swept `unconfirmed` and the one Stop replied to the first sender
/// with the second sender's answer. Offering queue would need the extension
/// to report follow-ups first. A STEERED line is reported since board #4
/// (omp 18.15.0, by the `message_end` that carries it); a follow-up is unmeasured.
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

/// omp 18.15.0's composer completes the `@word` at the cursor into a file
/// path on the Enter that should submit the line, and does not submit it
/// (board #36, measured 2026-11-05 on a scratch gateway with real managed agents; a workspace holding `README.md` and `src/lib/files/FilePreview.render.ts`): `…it moves on to @reviewer` with `@reviewer` LAST stayed unsent in
/// the composer as `…moves on to @src/lib/files/FilePreview.render.ts`, a fuzzy
/// match (validator-2's report, 19:59, and 09:03 on #12). Mid-line it arrived
/// intact. Typed as `＠`, the same line submitted unchanged. So a delivery
/// types every `@` as `＠` (`delivery::typed_form`), as for kiro (#436).
pub(crate) const AT_OPENS_FILE_PICKER: bool = true;

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
    shared::write_owned(&home.join("config.yml"), omp_config_yml(&roles, def.omp_tools).as_deref())?;
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

/// omp's own tools a definition turns off unless it opts in (board #72,
/// owner: "plan、ask、goal、out 等 … 默认关闭"). Each is gated by omp's own
/// setting of that name, default true (omp 18.15.0 source: `plan.enabled`
/// in plan-mode/settings.ts, `goal.enabled` in goals/settings.ts,
/// `ask.enabled` and `out.enabled` in tools/settings.ts, read by
/// tools/index.ts `isToolAllowed`). Settings are nested paths in
/// config.yml (`getByPath` over the dotted id), so `ask.enabled` is
/// `ask: {enabled: false}`.
pub(crate) const OWN_TOOLS: &[&str] = &["plan", "ask", "goal", "out"];

/// The isolated home's `config.yml`: those roles, and with `own_tools` off
/// each of `OWN_TOOLS` disabled. `None` (no file) when there is nothing to say.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn omp_config_yml(roles: &serde_yaml_ng::Mapping, own_tools: bool) -> Option<String> {
    use serde_yaml_ng::{Mapping, Value};
    let mut root = Mapping::new();
    if !roles.is_empty() {
        root.insert("modelRoles".into(), Value::Mapping(roles.clone()));
    }
    if !own_tools {
        for tool in OWN_TOOLS {
            let mut off = Mapping::new();
            off.insert("enabled".into(), Value::Bool(false));
            root.insert((*tool).into(), Value::Mapping(off));
        }
    }
    (!root.is_empty()).then(|| serde_yaml_ng::to_string(&root).ok()).flatten()
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
    super::pi_telemetry::extension(notify, super::pi_telemetry::Dialect::Omp)
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

/// The variable by which a process OUTSIDE the pane holds this home (board
/// #26, measured on omp 18.15.0). omp's text-predict worker
/// (`omp __omp_worker_text_predict`) is started by omp's global daemon broker
/// (`__omp_worker_daemon_broker`, parented to init), so it survives the window
/// kill. It is keyed to the home by `OMP_TEXT_PREDICT_AGENT_DIR=<home>`,
/// persists `predict/ngram/` into it up to 5 min after its last activity
/// (its 5 min debounce) and exits after 15 min idle. A remove stops it before
/// deleting the home. It exits about 200 ms after SIGTERM.
pub(crate) const HOME_WORKER_ENV: &str = "OMP_TEXT_PREDICT_AGENT_DIR";

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
/// turn's end, `StopFailure` one the provider refused (board #39); the
/// extension already filters auto-continuations (willContinue), so no
/// reason screening is needed here.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    match event.as_deref() {
        Some("Stop") => Ok("completed"),
        Some("StopFailure") => Ok("failed"),
        _ => Err("unsupported OMP event".into()),
    }
}

/// A `StopFailure` a person must clear (board #39), as its text: the
/// extension reports the last assistant message's `errorStatus` and
/// `errorMessage` (omp 18.15.0).
pub(crate) fn provider_failure(payload: &serde_json::Map<String, Value>) -> Option<String> {
    if crate::agent_notifications::string_field(payload, &["hook_event_name"]).as_deref() != Some("StopFailure") {
        return None;
    }
    let status = payload.get("error_status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok());
    let message = crate::agent_notifications::string_field(payload, &["error_message"]).unwrap_or_default();
    super::shared::provider_failure(status, None, &message)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Board #72: with omp's own tools off (the default), the home's
    /// config.yml turns off plan, ask, goal and out by omp's own settings, as
    /// nested paths, beside any model roles; on writes none of them, so with
    /// no roles there is no file at all and omp's defaults apply.
    #[test]
    fn omp_own_tools_are_off_unless_the_definition_opts_in() {
        let mut roles = serde_yaml_ng::Mapping::new();
        roles.insert("default".into(), "ust/claude-opus-5-5".into());
        let off: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(&omp_config_yml(&roles, false).unwrap()).unwrap();
        for tool in ["plan", "ask", "goal", "out"] {
            assert_eq!(off[tool]["enabled"].as_bool(), Some(false), "{tool}: {off:?}");
        }
        assert_eq!(off["modelRoles"]["default"].as_str(), Some("ust/claude-opus-5-5"), "roles stay beside them");
        assert!(off.get("todo").is_none() && off.get("task").is_none(), "only the four the owner named");
        let on: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(&omp_config_yml(&roles, true).unwrap()).unwrap();
        assert_eq!(on.len(), 1, "on: nothing but the roles: {on:?}");
        assert_eq!(omp_config_yml(&serde_yaml_ng::Mapping::new(), true), None, "on, no roles: no file");
        assert!(omp_config_yml(&serde_yaml_ng::Mapping::new(), false).is_some(), "off, no roles: the file still turns them off");
    }

    /// Run the generated telemetry extension under node with a stand-in
    /// `pi` (omp's documented `pi.on(event, handler)`), replaying `events`
    /// (`[name, payload]` pairs) in order. The notify helper is a shell line
    /// appending each payload to a file, so what comes back is exactly what
    /// the hub would receive. `None` without node.
    fn replay(events: Value) -> Option<Vec<Value>> {
        let node = crate::backends::dsh::tests::which("node")?;
        let dir = crate::config::test_scratch("tmm-omp-ext");
        std::fs::create_dir_all(&dir).unwrap();
        let sink = dir.join("sink");
        std::fs::create_dir_all(&sink).unwrap();
        // One file per payload: the extension's children run concurrently.
        let notify = format!("cat > {}/$$.json", crate::shell::quote_always(&sink.to_string_lossy()));
        std::fs::write(dir.join("ext.ts"), omp_telemetry_extension(&notify)).unwrap();
        std::fs::write(
            dir.join("driver.ts"),
            format!(
                "import hook from './ext.ts';\nconst h: Record<string, any[]> = {{}};\n\
                 hook({{ on: (e: string, f: any) => {{ (h[e] ??= []).push(f); }} }});\n\
                 const ctx = {{ sessionManager: {{ getSessionId: () => 'sess-1' }} }};\n\
                 for (const [e, p] of {events}) for (const f of h[e] ?? []) await f(p, ctx);\n"
            ),
        )
        .unwrap();
        let out = std::process::Command::new(node).arg("driver.ts").current_dir(&dir).stdin(std::process::Stdio::null()).output().unwrap();
        assert!(out.status.success(), "driver failed: {}", String::from_utf8_lossy(&out.stderr));
        // node exits only after its children, so every payload is written.
        let hooks = std::fs::read_dir(&sink).unwrap().map(|e| serde_json::from_str(&std::fs::read_to_string(e.unwrap().path()).unwrap()).unwrap()).collect();
        let _ = std::fs::remove_dir_all(&dir);
        Some(hooks)
    }

    /// The reported prompts as a sorted multiset: the helper children run
    /// concurrently, so arrival order is not part of the contract here, but
    /// the count is (each line exactly once).
    fn prompts(hooks: &[Value]) -> Vec<String> {
        let mut p: Vec<String> = hooks
            .iter()
            .filter(|h| h["hook_event_name"] == "UserPromptSubmit")
            .map(|h| h["prompt"].as_str().unwrap_or("").to_string())
            .collect();
        p.sort();
        p
    }

    /// A message a person typed: omp 18.15.0 stamps `attribution: "user"`
    /// on it (measured on an idle prompt, a steered line and a skill).
    fn user(text: &str) -> Value {
        json!({"role": "user", "content": [{"type": "text", "text": text}], "attribution": "user"})
    }

    /// Board #28, measured on omp 18.15.0 (scratch home, a logging
    /// extension): `/new` fires `session_before_switch {reason: "new"}` with
    /// the OLD session id, then `session_switch {reason: "new"}` with ctx on
    /// the NEW one, whose session file is written at once. The extension
    /// reports the switch as claude's SessionStart, so the hub records the
    /// conversation a restart must resume. The before-switch reports nothing.
    #[test]
    fn a_new_conversation_is_reported_as_a_session_start_with_its_id() {
        let Some(hooks) = replay(json!([
            ["session_before_switch", {"type": "session_before_switch", "reason": "new"}],
            ["session_switch", {"type": "session_switch", "reason": "new", "previousSessionFile": "/x/old.jsonl"}],
        ])) else {
            eprintln!("no node: skipped");
            return;
        };
        assert_eq!(hooks, vec![json!({"hook_event_name": "SessionStart", "source": "new", "session_id": "sess-1"})]);
    }

    /// Board #4, the event order measured on omp 18.15.0 (scratch home,
    /// 2026-11-05): a line typed into a busy run fires `input` at typing and
    /// `before_agent_start {reason: "prompt"}` when it is dequeued, with NO
    /// new `agent_start`, while `context` fires on every model call (a
    /// session-title side request included). Each user line is reported once.
    #[test]
    fn a_line_steered_into_a_busy_omp_is_reported_once_as_its_own_prompt() {
        let first = "FIRST-LINE run sleep 25";
        let steer = "STEER-LINE say BANANA";
        let Some(hooks) = replay(json!([
            ["session_start", {"type": "session_start"}],
            ["input", {"source": "interactive", "text": first}],
            ["before_agent_start", {"reason": "prompt", "prompt": first}],
            ["agent_start", {}],
            ["context", {"messages": [user(first)]}],
            ["turn_start", {}],
            ["message_end", {"message": user(first)}],
            ["context", {"messages": [user(first), {"role": "developer", "content": "<system-reminder>side-channel</system-reminder>"}, user("<title-request>SENTINEL</title-request>")]}],
            ["tool_call", {"toolName": "bash", "input": {"command": "sleep 25"}}],
            ["input", {"source": "interactive", "text": steer}],
            ["tool_result", {"toolName": "bash"}],
            ["turn_end", {}],
            ["before_agent_start", {"reason": "prompt", "prompt": steer}],
            ["context", {"messages": [user(first), user(steer)]}],
            ["turn_start", {}],
            ["message_end", {"message": {"role": "user", "content": [{"type": "text", "text": steer}], "attribution": "user", "steering": true}}],
            ["context", {"messages": [user(first), user(steer)]}],
            ["agent_end", {"messages": [{"role": "assistant", "content": [{"type": "text", "text": "DONE BANANA"}]}]}]
        ])) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(prompts(&hooks), [first, steer], "FIRST < STEER sorted");
        let stops: Vec<&Value> = hooks.iter().filter(|h| h["hook_event_name"] == "Stop").collect();
        assert_eq!(stops.len(), 1);
        assert_eq!(stops[0]["last_assistant_message"], "DONE BANANA");
        assert!(hooks.iter().all(|h| h["session_id"] == "sess-1"));
    }

    /// Board #39 AC1, measured on omp 18.15.0 (builder-2, scratch home,
    /// invalid key): a turn the provider refused ends with `agent_end` whose
    /// last assistant message has `stopReason: "error"`, `errorStatus` and
    /// `errorMessage`, and no content. The extension reports it as a
    /// `StopFailure` with them, not as a Stop with an empty reply; a turn
    /// that ended well is still a Stop.
    #[test]
    fn a_turn_the_provider_refused_is_reported_as_a_stop_failure_with_its_error() {
        let error = r#"401 {"type":"error","error":{"type":"authentication_error","message":"invalid API key"},"request_id":"req_011"}"#;
        let Some(hooks) = replay(json!([
            ["agent_end", {"messages": [user("say hi"), {"role": "assistant", "content": [], "stopReason": "error", "errorStatus": 401, "errorMessage": error}]}],
            ["agent_end", {"messages": [{"role": "assistant", "content": [{"type": "text", "text": "hi"}], "stopReason": "stop"}]}]
        ])) else {
            eprintln!("skipped: no node");
            return;
        };
        let failed: Vec<&Value> = hooks.iter().filter(|h| h["hook_event_name"] == "StopFailure").collect();
        assert_eq!(failed, vec![&json!({"hook_event_name": "StopFailure", "error_status": 401, "error_message": error, "session_id": "sess-1"})]);
        let stops: Vec<&Value> = hooks.iter().filter(|h| h["hook_event_name"] == "Stop").collect();
        assert_eq!((stops.len(), stops[0]["last_assistant_message"].as_str()), (1, Some("hi")));
        let payload = failed[0].as_object().unwrap();
        assert_eq!(normalize_kind(payload), Ok("failed"));
        assert_eq!(provider_failure(payload).as_deref(), Some(error));
        let busy = json!({"hook_event_name": "StopFailure", "error_status": 429, "error_message": "429 rate limited"});
        assert_eq!(provider_failure(busy.as_object().unwrap()), None, "it retries by itself");
    }

    fn skill_message(typed: &str, body: &str) -> Value {
        json!({"message": {"role": "custom", "customType": "skill-prompt", "content": body, "display": true, "attribution": "user",
            "details": {"name": "sk", "args": "x", "prompt": typed, "__queueChipText": typed}}})
    }

    /// Board #4 AC2, measured shapes (omp 18.15.0): a skill's run carries the
    /// EXPANDED body in `before_agent_start.prompt` and a `custom`
    /// `skill-prompt` message whose `details.prompt` is the typed line, so the
    /// report is the typed line; a builtin command (`/hotkeys`) fires `input`
    /// and no message, and never becomes a prompt; a subagent revive, runtime
    /// context and a user-role message nobody typed are never prompts.
    #[test]
    fn only_what_the_user_typed_becomes_a_prompt() {
        let skill_body = "[IMPORTANT: User invoked the \"probe-skill\" skill; follow its instructions. Full skill below.]\n\nSKILL-BODY-SENTINEL";
        let Some(hooks) = replay(json!([
            ["input", {"source": "interactive", "text": "/skill:probe-skill please"}],
            ["before_agent_start", {"reason": "prompt", "prompt": skill_body}],
            ["agent_start", {}],
            ["context", {"messages": [{"role": "custom", "customType": "skill-prompt", "content": skill_body}]}],
            ["message_end", skill_message("/skill:probe-skill please", skill_body)],
            ["agent_end", {"messages": []}],
            ["input", {"source": "interactive", "text": "/hotkeys"}],
            ["input", {"source": "interactive", "text": "a plain line"}],
            ["before_agent_start", {"reason": "prompt", "prompt": "a plain line"}],
            ["agent_start", {}],
            ["context", {"messages": [user("SENTINEL runtime context"), user("a plain line")]}],
            ["message_end", {"message": user("a plain line")}],
            ["message_end", {"message": {"role": "developer", "content": "SENTINEL reminder"}}],
            ["message_end", {"message": user("SENTINEL a user-role message nobody typed")}],
            ["agent_end", {"messages": []}],
            ["before_agent_start", {"reason": "revive", "prompt": "SENTINEL revive"}],
            ["agent_start", {}],
            ["message_end", {"message": user("SENTINEL revive")}],
            ["agent_end", {"messages": []}]
        ])) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(prompts(&hooks), ["/skill:probe-skill please", "a plain line"]);
        assert!(!serde_json::to_string(&hooks).unwrap().contains("SENTINEL"), "{hooks:?}");
        assert!(!serde_json::to_string(&hooks).unwrap().contains("hotkeys"), "{hooks:?}");
    }

    /// Board #4 review (reviewer 06:09/06:10): typed state is reported only
    /// for the message that carries it. Measured on omp 18.15.0, a line, a
    /// builtin and two skills typed into a busy run: each skill was dequeued
    /// with its own `before_agent_start`, and the builtin never was. A line
    /// typed and withdrawn (alt+up) never reaches a message, so it is never
    /// attributed to the next, unrelated prompt.
    #[test]
    fn typed_state_is_reported_only_with_the_message_that_carries_it() {
        let one = "/skill:sk-one ARGS-ONE";
        let two = "/skill:sk-two ARGS-TWO";
        let Some(hooks) = replay(json!([
            ["input", {"source": "interactive", "text": "RUN sleep 25"}],
            ["before_agent_start", {"reason": "prompt", "prompt": "RUN sleep 25"}],
            ["agent_start", {}],
            ["message_end", {"message": user("RUN sleep 25")}],
            ["input", {"source": "interactive", "text": "STEER-A say APPLE"}],
            ["input", {"source": "interactive", "text": "WITHDRAWN-SENTINEL"}],
            ["before_agent_start", {"reason": "prompt", "prompt": "STEER-A say APPLE"}],
            ["message_end", {"message": user("STEER-A say APPLE")}],
            ["input", {"source": "interactive", "text": "/hotkeys"}],
            ["input", {"source": "interactive", "text": one}],
            ["input", {"source": "interactive", "text": two}],
            ["before_agent_start", {"reason": "prompt", "prompt": "[IMPORTANT: … sk-one … ARGS-ONE"}],
            ["message_end", skill_message(one, "body one")],
            ["before_agent_start", {"reason": "prompt", "prompt": "[IMPORTANT: … sk-two … ARGS-TWO"}],
            ["message_end", skill_message(two, "body two")],
            // The withdrawn line's text comes back on a message nobody typed
            // (agent-attributed, as omp marks redirects and injections):
            // never the withdrawn line's receipt (reviewer, 06:34).
            ["message_end", {"message": {"role": "user", "content": [{"type": "text", "text": "WITHDRAWN-SENTINEL"}], "attribution": "agent"}}],
            ["message_end", {"message": {"role": "custom", "customType": "skill-prompt", "content": "x", "attribution": "agent", "details": {"prompt": "WITHDRAWN-SENTINEL"}}}],
            ["agent_end", {"messages": []}],
            ["input", {"source": "interactive", "text": "NEXT"}],
            ["before_agent_start", {"reason": "prompt", "prompt": "NEXT"}],
            ["agent_start", {}],
            ["message_end", {"message": user("NEXT")}],
            ["agent_end", {"messages": []}],
            // A queued line is never evicted by later typing that starts no
            // run (reviewer, 06:34: a 64-entry cap would drop it).
            ["input", {"source": "interactive", "text": "LATE-QUEUED"}]
        ]).as_array().unwrap().iter().cloned()
            .chain((0..70).map(|i| json!(["input", {"source": "interactive", "text": format!("/hotkeys {i}")}])))
            .chain([json!(["message_end", {"message": user("LATE-QUEUED")}])])
            .collect::<Vec<_>>()
            .into()) else {
            eprintln!("skipped: no node");
            return;
        };
        let mut want = vec!["NEXT", "RUN sleep 25", "STEER-A say APPLE", one, two, "LATE-QUEUED"];
        want.sort();
        assert_eq!(prompts(&hooks), want);
        let all = serde_json::to_string(&hooks).unwrap();
        assert!(!all.contains("WITHDRAWN") && !all.contains("hotkeys"), "{all}");
    }
}
