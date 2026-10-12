//! The kiro backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// queue|steer is kiro's own setting, `chat.defaultInterruptBehavior` in
/// `settings/cli.json` (board #245, measured on kiro-cli 2.22.1): `queue` makes
/// a line typed at a busy agent its own prompt after the turn (hook ack, reply
/// to its sender); `steer` injects it into the running turn with NO
/// `userPromptSubmit`, so the line is swept `unconfirmed` after the turn and
/// its sender enters no reply edge.
pub(crate) const SWITCHES_INPUT_MODE: bool = true;

/// The cli.json key that carries the definition's input mode.
const INTERRUPT_KEY: &str = "chat.defaultInterruptBehavior";

/// The session can switch the mode LIVE: Ctrl+S (a named key) toggles it,
/// idle or mid-turn, for this session only — `settings/cli.json` is never
/// rewritten and a restart starts from it again (board #271, measured on
/// kiro-cli 2.22.1 `--agent-engine v3`).
pub(crate) const LIVE_INPUT_TOGGLE: Option<&str> = Some("C-s");

/// The mode this pane RUNS now, read off its screen (board #271) — `None`
/// when the screen does not say, and the caller falls back to the launch
/// recipe's start mode. kiro paints it in two measured shapes, both matched
/// by the shape of the LINE so a quoted copy (a chat delivery under its `›`
/// stamp, tool output under a `●` head) never counts:
/// - the confirmation of a Ctrl+S, a column-zero line that is only
///   `<bullet> Switched to Steer mode` / `… Queue mode`; kiro keeps only the
///   newest one, so the bottom-most is the current mode;
/// - while a turn runs, the prompt line `›  Kiro is working · 19m 10s · Type
///   to steer · Ctrl+S to queue`. Idle, kiro paints no mode at all.
/// The confirmation outranks the footer (orchestrator, #271): both follow the
/// latest toggle, and the confirmation is also there while idle.
///
/// Board #346: BOTH shapes had drifted and the toggle could no longer be
/// confirmed in either state — the bullet became `•` (U+2022) where 2.22.1
/// painted `●` (U+25CF), and the footer gained an elapsed segment between
/// the label and the hints. Measured on kiro-cli 2.28.0 on this host
/// (`capture-pane -p -J -S -0 | cat -A`): `• Switched to Steer mode`,
/// `›  Kiro is working · 1m 27s · Type to steer · Ctrl+S to queue`,
/// `›  Kiro is working · 19s · Type to queue · Ctrl+S to steer`. So neither
/// shape is matched by one fixed prefix any more: the toast's bullet is one
/// of a NAMED set of glyphs (`TOAST_BULLETS`) and the footer's hints are read
/// as segments. The 2.22.1 forms still match. A bullet outside the set is a
/// miss we can see and name — add the glyph there with the version that
/// painted it; "any glyph" would instead accept a line a person or a delivery
/// can write.
pub(crate) fn live_input_mode(pane: &str) -> Option<&'static str> {
    let lines: Vec<&str> = pane.lines().collect();
    for line in lines.iter().rev() {
        if let Some(m) = toast_mode(line.trim_end()) {
            return Some(m);
        }
    }
    for line in lines.iter().rev() {
        if let Some(m) = footer_mode(line.trim_end()) {
            return Some(m);
        }
    }
    None
}

/// The one word kiro uses for each mode, in either case.
fn mode_word(word: &str) -> Option<&'static str> {
    match word {
        "queue" | "Queue" => Some("queue"),
        "steer" | "Steer" => Some("steer"),
        _ => None,
    }
}

/// The glyphs kiro has been seen to paint a toast with: `●` on kiro-cli
/// 2.22.1 and `•` on 2.28.0 are MEASURED on this host; the other four are
/// the same bullet family kiro uses elsewhere in its chrome, listed so a
/// minor repaint is not another outage (#346). Deliberately a closed set and
/// not "any glyph": a toast is otherwise an ordinary sentence, and anything
/// a person or a delivery can put at the start of a line — kiro's own input
/// stamp `›`, a quote marker, a dash — would become a mode switch.
const TOAST_BULLETS: [char; 6] = ['●', '•', '○', '◦', '◆', '◇'];

/// kiro's own confirmation of a Ctrl+S: at column zero, one bullet from
/// `TOAST_BULLETS`, a space, and EXACTLY `Switched to <Mode> mode`. The
/// bullet is read as a glyph rather than as part of a fixed prefix because it
/// changed between builds and broke the toggle (#346); a leading space (tool
/// output, the queued-count line) and anything outside the set are not
/// confirmations.
fn toast_mode(line: &str) -> Option<&'static str> {
    let bullet = line.chars().next()?;
    if !TOAST_BULLETS.contains(&bullet) {
        return None;
    }
    let rest = line[bullet.len_utf8()..].strip_prefix(' ')?.trim_start();
    let rest = rest.strip_prefix("Switched to ")?;
    rest.strip_suffix(" mode").and_then(mode_word)
}

/// The footer kiro paints while a turn runs. The line must BE that footer —
/// the label at column zero, after kiro's stamp and its two spaces or (older
/// builds) one optional space — and the two hints are then read as SEGMENTS
/// of it: the word after `· Type to ` is the mode it is in, the word after
/// `· Ctrl+S to ` the other one. Reading segments instead of one fixed
/// prefix is what survives 2.28.0's elapsed time (`· 19m 10s ·`) between
/// them, and reading them as whole words is what keeps "the line mentions
/// steer" from being an answer.
fn footer_mode(line: &str) -> Option<&'static str> {
    let body = match line.strip_prefix('›') {
        Some(after) if after.starts_with(' ') => after.trim_start(),
        Some(_) => return None,
        None => line.strip_prefix(' ').unwrap_or(line),
    };
    let rest = body.strip_prefix("Kiro is working")?;
    let now = mode_word(segment_after(rest, " · Type to ")?)?;
    let other = mode_word(segment_after(rest, " · Ctrl+S to ")?)?;
    // A footer that offers the mode it is already in says nothing.
    (now != other).then_some(now)
}

/// What follows `marker` up to the next ` · ` — one segment of the footer.
fn segment_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let at = line.find(marker)? + marker.len();
    let tail = &line[at..];
    Some(tail.split(" · ").next().unwrap_or(tail).trim_end())
}

/// Reasoning-effort levels kiro-cli accepts (`kiro-cli chat --effort`,
/// measured 2026-08-22: "e.g. low, medium, high, xhigh, max").
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh", "max"]
}

/// `kiro-cli chat --list-models -f json` enumerates real model ids.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    let out = std::process::Command::new("kiro-cli")
        .args(["chat", "--list-models", "-f", "json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let models: Vec<String> = parsed
        .get("models")?
        .as_array()?
        .iter()
        .filter_map(|m| m.get("model_id")?.as_str().map(str::to_string))
        .collect();
    (!models.is_empty()).then_some(models)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::{branch, context_pct, looks_like_model, Vitals, EFFORTS};

/// Read what the last lines of a pane say about the agent's current state.
///
/// `agent` is normally the first status segment (the managed window name).
/// Resumed legacy conversations may retain the exact built-in `kiro_default`
/// identity, which is accepted as the one narrow fallback. The anchor is not a
/// filter: fields that identify themselves by shape (context and branch) are
/// read even when it never appears, because narrow panes wrap later segments.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_kiro(pane: &str, agent: &str) -> Vitals {
    let mut v = Vitals::default();
    // Bottom-up: the newest paint of the status line is the last one.
    for line in pane.lines().rev().take(12) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A WIDE pane keeps `location · branch` right-aligned on the SAME line
        // as the left segments, joined not by `·` but by the padding run of
        // spaces — so the last left segment arrives glued to the location
        // (`◔ 5%       /local/home/cfu/temp`) and its parser refuses it
        // (owner, 2026-08-26: context missing on the chat project). A run of
        // two or more spaces is that gap and never occurs INSIDE a segment
        // (`◔ 5%` is single-spaced), so it is a segment boundary too. Narrow
        // panes wrap the right side onto its own line and are unaffected.
        let segs: Vec<&str> = line
            .split('·')
            .flat_map(|s| s.split("  "))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        // The activity line ("Kiro is working · Type to queue · …") shares the
        // dot separator with the status line, and its words are not segments.
        if segs.iter().any(|s| s.starts_with("Kiro is ") || *s == "Type to queue") {
            continue;
        }

        // Is this the status line proper? Usually kiro's left side starts with
        // the managed window/registry name. A resumed conversation can retain
        // Kiro's exact built-in identity `kiro_default` even though the app
        // window was later named `chat`; that line is still the TUI's own
        // status and therefore the runtime-model authority. Keep the exception
        // exact — arbitrary first segments remain ordinary output.
        // Effort has no identifying glyph, so it is read ONLY on this anchored
        // line and only as the segment immediately before the context segment.
        // Matching bare low/medium/high words elsewhere made ordinary output
        // look like a runtime setting.
        let anchored = segs.first().is_some_and(|s| *s == agent || *s == "kiro_default");
        if anchored && v.effort.is_none() && !v.effort_definitive {
            if let Some(ci) = segs.iter().position(|s| context_pct(s).is_some()) {
                let word = segs[ci.saturating_sub(1)].to_ascii_lowercase();
                if ci > 0 && EFFORTS.contains(&word.as_str()) {
                    v.effort = Some(word);
                }
            }
        }

        for (i, seg) in segs.iter().enumerate() {
            if v.context_pct.is_none() {
                if let Some(pct) = context_pct(seg) {
                    v.context_pct = Some(pct);
                    continue;
                }
            }
            if v.branch.is_none() {
                if let Some(b) = branch(seg) {
                    v.branch = Some(b.to_string());
                    continue;
                }
            }
            // The model is positional — it is whatever follows the agent name
            // (and the optional `Autonomous` flag). Anchoring on the name the
            // caller gave us is what keeps a cwd or a tangent from being read as
            // a model id.
            if v.model.is_none() && i == 0 && anchored {
                let next = segs
                    .iter()
                    .skip(1)
                    .find(|s| !s.eq_ignore_ascii_case("Autonomous"));
                // v2 prints the slug (`claude-sonnet-5`), the v3 engine the
                // DISPLAY name (`Claude Sonnet 5`, board #207) — both are the
                // model, and only here, right after the anchor, is a name
                // with spaces one.
                if let Some(m) = next.filter(|m| looks_like_model(m) || looks_like_model_name(m)) {
                    v.model = Some((*m).to_string());
                }
            }
        }
        // The anchored line carrying its context segment is the FULL left side
        // (`agent · [autonomous] · model · [effort] · context`): whatever it
        // says about effort — including "nothing" — is the verdict. kiro omits
        // the segment when the effort is the backend default, so absence here
        // is a reading, not a miss, and backfill must not overwrite it.
        if anchored && v.context_pct.is_some() {
            v.effort_definitive = true;
        }
    }
    v
}


use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::{effort_flag, Rendered};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// The hook set for each backend, in ONE place. `render_*` writes it at spawn
/// and `refresh_hooks` rewrites it on every start, so a config on disk can
/// never be older than the app that reads its events. (It was: agents spawned
/// before `userPromptSubmit` existed kept a three-hook config, and since that
/// hook is the only reset of the same-turn dedup flag, their first `tmm send`
/// silently killed the stop-hook auto-post for the rest of the window's life.)
#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// A model DISPLAY name as kiro-cli --v3's status line prints it: words of
/// letters/digits/dots/dashes separated by single spaces, at least one letter,
/// ≤ 48 chars ("Claude Sonnet 5", "GPT 5.1 Codex"). Read only right after the
/// anchor — the position is what makes a name with spaces a model and not a
/// path, a branch, a "Midway: 19h 19m" segment (the colon fails) or a "◔ 4%".
pub(crate) fn looks_like_model_name(s: &str) -> bool {
    let word_ok = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    !s.is_empty()
        && s.len() <= 48
        && s.chars().any(|c| c.is_ascii_alphabetic())
        && !s.contains("  ")
        && s.split(' ').all(word_ok)
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

pub(crate) fn kiro_hooks(notify: &str) -> Value {
    // The 3.0 profile shape (kiro-cli 2.22.1, board #207): an ARRAY of named
    // hooks. The v2 engine accepts it and fires all four (measured,
    // hooks-v2b.log); v3 fires prompt/stop and gates the tool hooks behind
    // its featureFlags.v2Hooks. Writing this shape means the CLI's
    // "agent configs are still in the 2.0 format" upgrade never runs on our
    // homes — no startup modal, no `.bak`, no rewrite churn against refresh.
    // No `matcher` on any hook: in 3.0 the matcher is a regex and the 2.0
    // glob "*" makes the whole profile invalid ("agent … not found, using
    // default" — measured); a hook without a matcher fires for every tool.
    let hook = |name: &str, trigger: &str| {
        json!({
            "name": name,
            "trigger": trigger,
            "action": { "type": "command", "command": notify },
            "timeout": 10,
        })
    };
    json!([
        // The notify helper feeds notifications AND telemetry (tool events are
        // recognized by hook_event_name and routed to telemetry only).
        hook("tmm-pre-tool", "preToolUse"),
        hook("tmm-post-tool", "postToolUse"),
        // Turn start — the ONLY reset of the same-turn dedup flag, and the
        // event that carries the submitted prompt.
        hook("tmm-prompt", "userPromptSubmit"),
        hook("tmm-stop", "stop"),
    ])
}

/// The 3.0 profile's permission block, the equivalent of `--trust-all-tools`
/// spelled in the config (the CLI's own upgrade writes exactly this).
pub(crate) fn kiro_permissions() -> Value {
    json!({ "rules": [ { "capability": "all", "effect": "allow" } ] })
}

/// Bring a managed profile to the 3.0 shape without churn: hooks replaced
/// only when they differ (either old shape), `permissions` added only when
/// absent (a block the user or the CLI wrote is theirs). Returns true on
/// change.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn patch_profile(path: &Path, hooks: Value) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(obj) = root.as_object_mut() else { return false };
    let mut changed = false;
    if obj.get("hooks") != Some(&hooks) {
        obj.insert("hooks".into(), hooks);
        changed = true;
    }
    if !obj.contains_key("permissions") {
        obj.insert("permissions".into(), kiro_permissions());
        changed = true;
    }
    changed && std::fs::write(path, serde_json::to_string_pretty(&root).unwrap_or(text)).is_ok()
}

/// The CLI settings every managed kiro agent runs with (`<home>/settings/
/// cli.json`, read because the pane launches with `KIRO_HOME=<home>`).
///
/// `chat.defaultInterruptBehavior` is NOT in this list: it is the
/// definition's input mode (board #245), written by `render_kiro` from the def
/// and only backfilled by `ensure_kiro_settings`. Queue is the default (owner,
/// 2026-08-20: "所有 Agent 在 kiro 里边发送指令的模式 默认给我设计成 Queue 队列模式吧
/// 不要 steer 模式"): a line typed at a BUSY agent waits for the turn to end
/// and is read whole, as its own prompt — the contract the delivery pipeline
/// assumes (`overdue_rows` pauses the ack clock while a turn is open). The
/// setting is only the START mode: kiro 2.22.1 v3 toggles it per session on
/// Ctrl+S or from its settings menu, and a STEERED line fires no
/// `userPromptSubmit`, so it can never be acknowledged (board #249).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kiro_cli_settings() -> Vec<(&'static str, Value)> {
    vec![
        ("chat.disableTrustAllConfirmation", json!(true)),
        // MCP tool schemas are DEFERRED into a compact list and loaded on
        // demand via kiro's own tool_search (owner, 2026-08-28: "给 kiro 的
        // mcp 工具开启 toolsearch"). Thresholds 0/0 = defer whenever any MCP
        // tools are present, which is the progressive behavior asked for.
        ("toolSearch.enabled", json!(true)),
        ("toolSearch.minPct", json!(0)),
        ("toolSearch.minTokens", json!(0)),
        // kiro-cli 2.22.1 --v3 (board #207): without this the CLI parks an
        // unattended pane on "Your agent configs are still in the 2.0 format.
        // Upgrade?". Our profiles are already 3.0-shaped, so with it set the
        // upgrade is a no-op — no `.bak`, no rewrite.
        ("chat.enableAutoAgentUpgrade", json!(true)),
    ]
}

/// The one per-agent setting: v3 IGNORES the profile's `model` and reads
/// `chat.defaultModel` from the home settings (board #207). The profile keeps
/// `model` for v2; both come from the same definition, so they cannot
/// disagree. An empty model means the backend default: the key is OMITTED,
/// and a stale key is DELETED when the model is cleared — otherwise an old
/// pin outlives the config.
pub(crate) const DEFAULT_MODEL_KEY: &str = "chat.defaultModel";

/// Force the canonical CLI settings into a managed kiro home, leaving any
/// other keys alone. Creates the file when it is missing (pre-settings homes),
/// no-op write when everything already matches — the same contract as
/// `patch_hooks`, because the app owns these configs. Returns true on change.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_kiro_settings(home: &Path, model: &str) -> bool {
    let dir = home.join("settings");
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let path = dir.join("cli.json");
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let obj = root.as_object_mut().expect("filtered to object above");
    let mut changed = !path.is_file();
    for (key, value) in kiro_cli_settings() {
        if obj.get(key) != Some(&value) {
            obj.insert(key.to_string(), value);
            changed = true;
        }
    }
    // The input mode is the DEFINITION's (render_kiro writes it at spawn and
    // restart); this repair path has no def, so it keeps a valid value and
    // only backfills a home that predates the key (board #245).
    if !matches!(obj.get(INTERRUPT_KEY).and_then(Value::as_str), Some("queue" | "steer")) {
        obj.insert(INTERRUPT_KEY.into(), json!("queue"));
        changed = true;
    }
    let model = model.trim();
    if model.is_empty() {
        changed |= obj.remove(DEFAULT_MODEL_KEY).is_some();
    } else if obj.get(DEFAULT_MODEL_KEY).and_then(Value::as_str) != Some(model) {
        obj.insert(DEFAULT_MODEL_KEY.into(), json!(model));
        changed = true;
    }
    changed && std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).is_ok()
}

/// The model a managed profile pins (its `model` key), or "" — what refresh
/// mirrors into `chat.defaultModel` so the v3 engine reads the same id v2 does.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn profile_model(config: &Path) -> String {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// ` --agent-engine v3` when the app-wide engine door is open, else nothing
/// — the v2 launch line is byte-for-byte what it was, so flipping the door
/// back leaves no trace (board #207). The door is `kiro_engine` in
/// config.toml (`KIRO_ENGINE` overrides), read at spawn and at refresh: an
/// agent takes the new engine at its next restart, so one scratch agent can be
/// flipped alone before the owner restarts the real ones.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn engine_flag() -> String {
    match crate::config::kiro_engine().as_str() {
        "v3" => " --agent-engine v3".into(),
        _ => String::new(),
    }
}

/// Bring a launch recipe's engine segment in line with the door: add
/// ` --agent-engine v3` after `--trust-all-tools` when the door is open and
/// the line lacks it, drop any ` --agent-engine <x>` when it is closed. Exact
/// token surgery on the recorded line, like `migrate_launch_model`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn reconcile_recipe_engine(home: &Path) -> bool {
    let recipe_path = home.join("launch.json");
    let Ok(text) = std::fs::read_to_string(&recipe_path) else { return false };
    let Ok(mut recipe) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(cmd) = recipe.get("cmd").and_then(Value::as_str).map(str::to_string) else { return false };
    let Some(next) = reconcile_engine_in(&cmd, &engine_flag()) else { return false };
    recipe["cmd"] = json!(next);
    std::fs::write(&recipe_path, serde_json::to_string_pretty(&recipe).unwrap_or(text)).is_ok()
}

/// The pure half: `Some(new line)` when the engine segment has to change.
pub(crate) fn reconcile_engine_in(cmd: &str, flag: &str) -> Option<String> {
    let mut tokens: Vec<&str> = cmd.split_whitespace().collect();
    let has = tokens.iter().position(|t| *t == "--agent-engine");
    let want: Vec<&str> = flag.split_whitespace().collect();
    match (has, want.is_empty()) {
        (Some(at), true) => {
            tokens.drain(at..(at + 2).min(tokens.len()));
            Some(tokens.join(" "))
        }
        (Some(at), false) => {
            if tokens.get(at + 1) == want.get(1) {
                return None;
            }
            if at + 1 < tokens.len() {
                tokens[at + 1] = want[1];
            } else {
                tokens.push(want[1]);
            }
            Some(tokens.join(" "))
        }
        (None, true) => None,
        (None, false) => Some(format!("{cmd}{flag}")),
    }
}

/// The v3 engine's Stop payload carries no reply text; the final response of
/// the turn is the last `assistant` entry of the GLOBAL session file
/// `~/.kiro/sessions/<cwd-hash>/sess_<id>/messages.jsonl` (board #207; the
/// hook's `session_id` names the directory). Each line is
/// `{id, timestamp, payload: {type, content, …}}`; a turn is `turn_start` …
/// `turn_end` and may hold several `assistant` entries (text between tool
/// calls, then the final text) — the reply is the LAST assistant entry after
/// the LAST `turn_start`. Bad lines are skipped, never fatal.
pub(crate) fn kiro_reply_from_session(jsonl: &str) -> Option<String> {
    let mut reply: Option<String> = None;
    for line in jsonl.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        let payload = row.get("payload").unwrap_or(&row);
        match payload.get("type").and_then(Value::as_str) {
            Some("turn_start") => reply = None,
            Some("assistant") => {
                if let Some(text) = payload.get("content").and_then(Value::as_str) {
                    let text = text.trim();
                    // KAS closes a turn with a placeholder assistant row
                    // (`"..."`, measured 2.22.1 through a managed spawn) after
                    // the real text; a row without one letter or digit is
                    // not the reply (board #213: it posted "..." to the room).
                    if text.chars().any(char::is_alphanumeric) {
                        reply = Some(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    reply
}

/// Locate and read the session's reply — `sessions_root` is `~/.kiro/sessions`
/// in production and a temp dir in tests. `None` when nothing is found.
/// Desktop only, like the rest of the spawn/observe surface: the mobile shell
/// never reads an agent's session store (the Android build broke on the
/// desktop-only `Path` import, 2026-09-20, the first APK after #207).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn session_reply(sessions_root: &Path, session_id: &str) -> Option<String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return None;
    }
    let dirs = std::fs::read_dir(sessions_root).ok()?;
    for entry in dirs.flatten() {
        let file = entry.path().join(session_id).join("messages.jsonl");
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Some(reply) = kiro_reply_from_session(&text) {
                return Some(reply);
            }
        }
    }
    None
}

/// The v3 fallback wired into the notify helper: the kiro Stop payload has no
/// text, the session file has.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn reply_fallback(payload: &serde_json::Map<String, Value>) -> Option<String> {
    let id = crate::agent_notifications::string_field(payload, &["session_id", "sessionId"])?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    session_reply(&home.join(".kiro").join("sessions"), &id)
}

/// Move a `--model <id>` an older build put on the launch line into the agent
/// config, where kiro actually honours it, and drop it from the recipe so the
/// two cannot disagree. Exact information, so nothing is guessed: the id is
/// read off the line that was really used.
///
/// Why it matters beyond tidiness: `refresh_hooks` also BACKFILLS recipes for
/// pre-recipe agents, and that backfilled line has no `--model` at all — so an
/// agent restarted through that path silently lost its model. Once the id is in
/// the config it survives every start (`up`, restart, resume) because they all
/// pass `--agent`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn migrate_launch_model(home: &Path, config: &Path) -> bool {
    let recipe_path = home.join("launch.json");
    let Ok(text) = std::fs::read_to_string(&recipe_path) else { return false };
    let Ok(mut recipe) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(cmd) = recipe.get("cmd").and_then(Value::as_str).map(str::to_string) else {
        return false;
    };
    // Model ids never contain whitespace, so token splitting is exact here.
    let mut tokens: Vec<&str> = cmd.split_whitespace().collect();
    let Some(at) = tokens.iter().position(|t| *t == "--model") else { return false };
    let model = tokens
        .get(at + 1)
        .map(|m| m.trim_matches('\'').trim_matches('"').to_string())
        .filter(|m| !m.is_empty() && !m.starts_with('-'));
    tokens.drain(at..(at + 2).min(tokens.len()));
    recipe["cmd"] = json!(tokens.join(" "));
    let recipe_written = std::fs::write(
        &recipe_path,
        serde_json::to_string_pretty(&recipe).unwrap_or(text),
    )
    .is_ok();
    // Only fill a config that has no model of its own: a value already there
    // came from a newer spawn (or the user) and outranks the old launch line.
    let Some(model) = model else { return recipe_written };
    // And only if the backend actually accepts it. An id it rejects was never
    // the agent's model — kiro fell back to its default and said so above the
    // splash — so carrying the typo into the config would turn a working agent
    // into a mute one on its next restart. Dropping it preserves what was
    // really running.
    if let Err(e) = crate::projects::models::validate("kiro", &model) {
        eprintln!("projects: dropping the launch line's model for a managed agent — {e}");
        return recipe_written;
    }
    let config_written = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|mut root| {
            let obj = root.as_object_mut()?;
            if obj.contains_key("model") {
                return None;
            }
            obj.insert("model".into(), json!(model));
            Some(std::fs::write(config, serde_json::to_string_pretty(&root).unwrap()).is_ok())
        })
        .unwrap_or(false);
    recipe_written || config_written
}

/// The environment a managed kiro pane launches with — ONE definition for
/// the spawn recipe and the launch.json backfill.
///
/// `KIRO_HOME` is the isolated home (the agent's identity). `KIRO_SKIP_MIDWAY_CHECK`
/// (board #183, owner 2026-09-12: "跳过这个提示，避免启动被阻塞住"): a managed
/// pane is unattended, and kiro-cli's launch-time "Your Midway session has
/// expired or is missing. Refresh it now with mwinit? [y/N]" parks the agent
/// until a human types. kiro-cli 2.21.4 reads this switch right beside that
/// prompt (`crates/chat-cli/src/launch/midway.rs`); there is no flag or
/// setting for it. Skipping the CHECK changes nothing about kiro's own login —
/// Midway only gates internal endpoints, and an expired session fails those
/// calls instead of freezing the launch.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kiro_launch_env(home: &Path) -> Vec<(String, String)> {
    vec![
        ("KIRO_HOME".into(), home.to_string_lossy().to_string()),
        ("KIRO_SKIP_MIDWAY_CHECK".into(), "1".into()),
    ]
}

/// The v3 engine's door to an agent's identity is the WORKSPACE, not
/// `KIRO_HOME` (board #207, measured on kiro-cli 2.22.1 with a private home:
/// the same profile is "not found" under any other name or from any other
/// cwd, and found the moment it sits in `<ws>/.kiro/agents/`). So, only while
/// the engine door is open, the workspace carries ONE entry per managed agent:
/// `<ws>/.kiro/agents/<name>.json` → symlink → the isolated home's profile.
/// The truth does not fork — v3 reads THROUGH the link, the CLI's own
/// upgrade writes through it — and v2 sees no change at all.
///
/// Rules: idempotent on every start; an existing file that is NOT our symlink
/// is never clobbered (fail loud, naming it); the path goes into
/// `.git/info/exclude` when the workspace is a git checkout, so an agent's
/// `git add -A` cannot commit it; removed with the agent.
pub(crate) const WS_AGENTS_DIR: &str = ".kiro/agents";
const GIT_EXCLUDE_MARK: &str = "# tmux-mobile managed kiro entries (board #207)";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn workspace_entry_path(workspace: &Path, name: &str) -> std::path::PathBuf {
    workspace.join(WS_AGENTS_DIR).join(format!("{name}.json"))
}

/// Ensure (engine v3) or retire (engine v2) the workspace entry. Returns true
/// when the workspace changed; an error names the file that stands in the way.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_workspace_entry(workspace: &Path, home: &Path, name: &str) -> Result<bool, String> {
    let open = crate::config::kiro_engine() == "v3";
    let link = workspace_entry_path(workspace, name);
    let target = home.join("agents").join(format!("{name}.json"));
    let meta = std::fs::symlink_metadata(&link).ok();
    if !open {
        // Door closed: our link goes; anything else there is not ours.
        return Ok(meta.is_some_and(|m| m.file_type().is_symlink()
            && std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()))
            && std::fs::remove_file(&link).is_ok());
    }
    if let Some(m) = meta {
        if m.file_type().is_symlink() {
            if std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) {
                return Ok(false); // already ours, pointing right
            }
            std::fs::remove_file(&link).map_err(|e| format!("replace stale link {}: {e}", link.display()))?;
        } else {
            return Err(format!(
                "{} exists and is not a tmux-mobile link — the v3 engine would read it as '{name}'; move it aside or rename the agent",
                link.display()
            ));
        }
    }
    std::fs::create_dir_all(link.parent().unwrap()).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("link {}: {e}", link.display()))?;
    exclude_from_git(workspace, name);
    Ok(true)
}

/// Remove the entry an agent left in the workspace (agent removal). Only a
/// symlink into `.tmm/agents/` is ours to remove.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn remove_workspace_entry(workspace: &Path, name: &str) -> bool {
    let link = workspace_entry_path(workspace, name);
    let ours = std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink())
        && std::fs::read_link(&link).is_ok_and(|t| t.to_string_lossy().contains("/.tmm/agents/"));
    ours && std::fs::remove_file(&link).is_ok()
}

/// `.git/info/exclude` — local, untracked, idempotent: the workspace's own
/// `.gitignore` is the project's, not ours to edit. ONE line per agent, our
/// file only: hiding the whole `.kiro/agents/` would hide the agents the user
/// wrote there from their own `git status`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn exclude_from_git(workspace: &Path, name: &str) {
    let git = workspace.join(".git");
    if !git.is_dir() {
        return;
    }
    let path = git.join("info").join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let line = format!("/{WS_AGENTS_DIR}/{name}.json");
    if current.lines().any(|l| l.trim() == line) {
        return;
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    let mark = if current.contains(GIT_EXCLUDE_MARK) { String::new() } else { format!("{GIT_EXCLUDE_MARK}\n") };
    let _ = std::fs::write(&path, format!("{current}{sep}{mark}{line}\n"));
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_kiro(
    def: &RegAgent, name: &str, home: &Path, workspace: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    std::fs::create_dir_all(home.join("agents")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(home.join("settings")).map_err(|e| e.to_string())?;
    // Fail-loud at spawn (a home without settings/cli.json would re-enable the
    // trust-all confirmation, which nobody is there to answer); refresh_hooks
    // reuses the same canonical list fail-soft via ensure_kiro_settings.
    let mut settings: serde_json::Map<String, Value> =
        kiro_cli_settings().into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    settings.insert(INTERRUPT_KEY.into(), json!(if def.input_mode == "steer" { "steer" } else { "queue" }));
    if !def.model.trim().is_empty() {
        settings.insert(DEFAULT_MODEL_KEY.into(), json!(def.model.trim()));
    }
    std::fs::write(
        home.join("settings").join("cli.json"),
        serde_json::to_string_pretty(&Value::Object(settings)).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("kiro");

    let resources: Vec<String> = skills
        .iter()
        .map(|sk| format!("skill://{}/SKILL.md", sk.dir.to_string_lossy()))
        .collect();
    let mut mcp_servers = json!({});
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            mcp_servers.as_object_mut().unwrap().insert(m.name.clone(), shared::kiro_mcp_value(m));
        }
    }
    let mut conf = json!({
        "name": name,
        "description": format!("{} (registry agent)", def.name),
        "prompt": system_prompt,
        "tools": ["*"],
        "allowedTools": ["*"],
        "resources": resources,
        // Native MCP again (owner, 2026-08-28: "mcp 工具还是用原生的方式调用
        // 吧") — the context cost is handled by toolSearch instead
        // (kiro_cli_settings enables it): schemas are DEFERRED into a compact
        // list and loaded on demand via kiro's own tool_search. The `tmm mcp`
        // CLI stays available as a SKILL, never taught in the prompt.
        "mcpServers": mcp_servers,
        "hooks": kiro_hooks(&notify),
        "permissions": kiro_permissions(),
    });
    // The model belongs to the agent's IDENTITY, not to one launch of it. It
    // used to ride on `--model`, which had two costs: it was invisible in the
    // config the owner reads (`.tmm/agents/<name>/agents/<name>.json`), and
    // kiro-cli's TUI answers an unknown id with a warning above the splash and
    // then runs its DEFAULT model — so a typo'd id was a silent downgrade. In
    // the config, kiro reports it as a real error on the first turn instead,
    // and every later start (resume, restart, `up`) reads the same field.
    // `registry_save` rejects unknown ids up front.
    //
    // An empty model means what the editor's placeholder says — the BACKEND's
    // default — so the key is omitted rather than set to a hardcoded id (the
    // old launch line pinned `claude-sonnet-4.6`, which silently contradicted
    // the UI and would have outlived that model).
    let model = def.model.trim();
    if !model.is_empty() {
        conf["model"] = json!(model);
    }
    std::fs::write(home.join("agents").join(format!("{name}.json")), serde_json::to_string_pretty(&conf).unwrap())
        .map_err(|e| e.to_string())?;
    // v3 finds the identity through the workspace (fail loud: a foreign file
    // there would be read as this agent).
    ensure_workspace_entry(workspace, home, name)?;

    Ok(Rendered {
        env: kiro_launch_env(home),
        cmd: format!(
            "command kiro-cli chat --agent {} --trust-all-tools{}{}",
            crate::shell::quote(name),
            effort_flag(def),
            engine_flag(),
        ),
        confirmation: None,
    })
}


/// The kiro half of `refresh_hooks` (board #128): hooks, launch-model
/// migration, canonical settings, and the pre-recipe backfill — a home whose
/// `agents/<name>.json` exists but whose recipe does not is an old spawn
/// whose restart identity is reconstructible from the isolated home itself.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, window_name: &str, workspace: &Path, notify: &str) -> bool {
    let mut changed = false;
    let config = home.join("agents").join(format!("{window_name}.json"));
    if config.is_file() {
        // The workspace entry follows the engine door at every start (#207);
        // refresh is fail-soft, so a foreign file only logs.
        match ensure_workspace_entry(workspace, home, window_name) {
            Ok(c) => changed |= c,
            Err(e) => eprintln!("projects: kiro v3 workspace entry for '{window_name}': {e}"),
        }
        changed |= patch_profile(&config, kiro_hooks(notify));
        changed |= migrate_launch_model(home, &config);
        // Settings drift is config drift: agents spawned before queue-mode
        // (or before settings existed at all) get the canonical file on their
        // next start, same as hooks; the v3 model mirror follows the profile.
        changed |= ensure_kiro_settings(home, &profile_model(&config));
        // The engine door is read at every start (board #207).
        changed |= reconcile_recipe_engine(home);
        if !home.join("launch.json").exists() {
            // Best effort: a backfill that cannot be written changes nothing,
            // and the restart then takes the generic launch path.
            changed |= crate::projects::spawn::LaunchRecipe {
                backend: "kiro",
                env: &kiro_launch_env(home),
                cmd: &format!(
                    "command kiro-cli chat --agent {} --trust-all-tools{} kick",
                    crate::shell::quote(window_name),
                    engine_flag(),
                ),
                // A backfilled recipe cannot know who spawned the agent — the
                // provenance does not exist for pre-recipe spawns; refresh
                // falls back to the window name.
                spawned_by: "",
                team: None,
                agent_def: "",
                member: "",
                input_mode: "",
            }
            .write(home)
            .is_ok();
        }
    }
    changed
}

/// kiro resume dialect, per engine (the engine is read off the launch line —
/// `reconcile_recipe_engine` has already brought it in line with the door).
///
/// v2: `--resume-id <id>` exact, `--resume` recent (the isolated KIRO_HOME
/// scopes the store to this one agent, so "recent" is safe).
///
/// v3 (board #213): the store is the GLOBAL `~/.kiro/sessions/<cwd-hash>/`,
/// keyed by cwd — every managed agent of a project shares it — and its ids
/// are `sess_<uuid>`. Only an exact v3 id resumes (measured, kiro-cli
/// 2.22.1: same session appended, agentMode and model kept, earlier context
/// recalled). A v2 id handed to v3 loaded a rootless "Default · Auto" session
/// whose reply never reached the room (claude, #213), and `--resume` under v3
/// would take the newest session of the DIRECTORY — possibly a teammate's or
/// the human's. So anything else starts fresh; losing the v2 thread once at
/// the switch is the owner's accepted trade ("没关系，我可以重新再开").
///
/// The rule is symmetric: an id is handed only to the engine that minted it.
/// v2 given a v3 id (the rollback case — the hook recorded `sess_…` while
/// the door was open) also came up `agent "kiro" not found, using "default"`
/// (measured), so under v2 a v3 id falls back to `--resume`, which is the
/// pre-switch v2 thread of this home.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    let v3_id = id.is_some_and(|i| i.starts_with(V3_SESSION_PREFIX));
    if launch_engine_is_v3(cmd) {
        return match id {
            Some(id) if v3_id => format!("{cmd} --resume-id {}", crate::shell::quote(id)),
            _ => cmd.to_string(),
        };
    }
    match id {
        Some(id) if !v3_id => format!("{cmd} --resume-id {}", crate::shell::quote(id)),
        _ => format!("{cmd} --resume"),
    }
}

/// v3 session ids as the hook and the global store spell them.
const V3_SESSION_PREFIX: &str = "sess_";

/// Whether a recorded launch line runs the v3 engine (`--agent-engine v3` or
/// the CLI's `--v3` alias).
pub(crate) fn launch_engine_is_v3(cmd: &str) -> bool {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    tokens.iter().any(|t| *t == "--v3")
        || tokens.windows(2).any(|w| w[0] == "--agent-engine" && w[1] == "v3")
}

/// This backend's detection/relaunch row (board #129). Resume flags from
/// `kiro-cli chat --help`: `-r/--resume` — "Resume the most recent
/// conversation from this directory"; `--resume-id <SESSION_ID>` exact.
/// The recipe-based resume dialect lives in `resume_command` above — same
/// knowledge, the template form serves adopted/hand-started windows.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on kiro-cli 2.22.1
/// v3: `/goal <args>` is echoed WITHOUT its slash, `goal <args>`. Declared per
/// command, only where a prompt hook was measured: `/effort` and the other
/// settings commands fire none, so they get no receipt row (validator, #264).
pub(crate) fn command_echo(name: &str, args: &str) -> Option<String> {
    (name == "/goal" && !args.is_empty()).then(|| format!("goal {args}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "kiro",
        programs: &["kiro-cli", "kiro-cli-chat"],
        launch: "kiro-cli chat",
        resume_recent: Some("kiro-cli chat --resume"),
        resume_id: Some("kiro-cli chat --resume-id {id}"),
        versioned_binary_dir: None,
    }
}

/// kiro's hook payload dialect (board #129): snake_case `hook_event_name`,
/// a turn's end is `stop`/`Stop`.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    if !matches!(event.as_deref(), Some("stop" | "Stop")) {
        return Err("unsupported Kiro event".into());
    }
    Ok("completed")
}

/// kiro marks a new user turn with `hook_event_name: userPromptSubmit`
/// (case-insensitive) — resets the auto-post dedup flag.
/// kiro-cli v3 (KAS) runs its memory auto-capture as `memory` TOOL calls AFTER
/// the turn's Stop — measured 2026-09-20 in state.db on two agents
/// (kiro-v3-roll:kiro 03:58, kirocrew-ppt:aws-expert 10:42): prompt → tools →
/// `completed` → three `memory` calls 10–30 s apart with no new prompt. Read
/// as work, the newest tool reopened the turn and the card said "working"
/// until the next message (board #227; the owner: "结束了还一直显示在工作").
/// The agent also calls `memory` INSIDE a turn (`memory list/add`), so the
/// name alone is not the verdict — the consumer records it only while a turn
/// is open. This names the tool whose calls are the harness's housekeeping.
pub(crate) fn is_housekeeping_tool(payload: &Value) -> bool {
    payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .and_then(Value::as_str)
        .is_some_and(|t| t == "memory")
}

pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))
}

// ---- transient model errors: the auto-continue shapes (projects/recovery.rs, board #280) ----

/// The error's own header, canonicalized. Everything kiro streams out of a
/// dead turn starts with this sentence — and since ~2026-08-31 (board #24)
/// kiro HARD-wraps the paint: header flush-left, the struct dump indented on
/// real newlines that capture -J cannot rejoin, so the transient markers sit
/// many physical lines below the header. Detection therefore matches the
/// reassembled paint BLOCK, and the header must OPEN it (`starts_with`, not
/// `contains`) — quoted copies always paint under a stamp or bullet head.
const HEADER: &str = "anunexpectederroroccurred";
/// Transient markers — the reasons that mean "try again later", canonicalized.
pub(crate) const TRANSIENT: [&str; 3] = [
    "unexpectedlyhighload",
    "modeltemporarilyunavailable",
    "pleasetryagain",
];
/// Second kiro shape (owner, 2026-08-26): `The model you've selected is
/// temporarily unavailable. Please use '/model' to select a different model
/// and try again. (request_id: …)`. No "unexpected error" header — the whole
/// first sentence IS the header, and it is specific enough on its own: it
/// self-contains the transient reason ("temporarily unavailable"), so a block
/// opening with it needs no second marker.
const MODEL_UNAVAILABLE: &str = "themodelyouveselectedistemporarilyunavailable";
/// Third kiro shape (kiro-cli 2.22.1, `--agent-engine v3`, board #267,
/// 2026-09-28): `● <model> is experiencing high traffic. Try again, or select
/// another model. (Request ID: <uuid>)`, hard-wrapped under the `●` bullet
/// head that v3 also gives its prose and tool calls. It has no header of its
/// own, so the block must be EXACTLY the error, punctuation included, with
/// only whitespace collapsed (a hard wrap is a space): the bullet, a short
/// model name, this sentence, a canonical 8-4-4-4-12 uuid and the closing
/// `)` at block end. Letters alone are not enough (validator 15:04): a
/// rewording without the parenthesis, the colon or the close paren is prose
/// ABOUT the error, and a false hit types `continue` into a working agent.
const HIGH_TRAFFIC: &str = " is experiencing high traffic. Try again, or select another model. (Request ID: ";
/// "Claude Opus 4.1 (1M context)" is five.
const MODEL_NAME_WORDS: usize = 5;

/// `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hex digits only.
fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Is this block, its lines joined with spaces, exactly the high-traffic error?
fn high_traffic(spaced: &str) -> bool {
    let flat = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(body) = flat.strip_prefix("● ") else { return false };
    let Some(at) = body.find(HIGH_TRAFFIC) else { return false };
    let name = &body[..at];
    let words = name.split(' ').count();
    if name.is_empty()
        || words > MODEL_NAME_WORDS
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || " .-()".contains(c))
    {
        return false;
    }
    body[at + HIGH_TRAFFIC.len()..].strip_suffix(')').is_some_and(is_uuid)
}


/// Is this reassembled paint block one of kiro's OWN transient-error shapes
/// (board #280: each backend owns its shapes)? `glued` is the block with its
/// lines joined without separators, `spaced` with spaces.
pub(crate) fn transient_error(glued: &str, spaced: &str) -> bool {
    let c = super::canonical(glued);
    (c.starts_with(HEADER) && TRANSIENT.iter().any(|m| c.contains(m)))
        || c.starts_with(MODEL_UNAVAILABLE)
        || high_traffic(spaced)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #271: panes captured on kiro-cli 2.22.1 v3 (capture-pane -p).
    #[test]
    fn the_live_input_mode_is_read_off_the_screen() {
        let busy_queue = "● Shell sleep 40\n────\nkiro · Claude Opus 5.5 · high · ◔ 1% · Midway: expired   /tmp/steer/ws\n›  Kiro is working · Type to queue · Ctrl+S to steer\n";
        let busy_steer = "kiro · Claude Opus 5.5 · high · ◑ 35%\n›  Kiro is working · Type to steer · Ctrl+S to queue\n";
        let idle = "────\nkiro · Claude Opus 5.5 · high · ◔ 1%\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
        assert_eq!(live_input_mode(busy_queue), Some("queue"));
        assert_eq!(live_input_mode(busy_steer), Some("steer"));
        assert_eq!(live_input_mode(idle), None, "idle kiro paints no mode");
        // Older build (vitals.rs fixture): no `›`, one leading space.
        assert_eq!(live_input_mode(" Kiro is working · Type to queue · Ctrl+S to steer\n"), Some("queue"));
        // A Ctrl+S confirmation, idle; it outranks the footer.
        let switched = format!("● Switched to Steer mode\n\n{idle}");
        assert_eq!(live_input_mode(&switched), Some("steer"));
        assert_eq!(live_input_mode(&format!("● Switched to Queue mode\n{busy_steer}")), Some("queue"),
            "the confirmation is read first (orchestrator, #271)");
        // Only the bottom-most confirmation counts.
        assert_eq!(live_input_mode("● Switched to Steer mode\nx\n● Switched to Queue mode\n"), Some("queue"));
    }

    /// Board #346: the same screens on kiro-cli 2.28.0, captured on this host
    /// with `tmux capture-pane -p -J -S -0 | cat -A` (builder, 2026-10-12).
    /// The toast's bullet is U+2022 where 2.22.1 painted U+25CF, and the
    /// footer carries an elapsed segment the old prefix never allowed for —
    /// each one alone was enough to make `switch_input_mode` time out with
    /// "the pane did not confirm <mode> mode" while the pane had switched.
    #[test]
    fn kiro_2_28_toast_and_footer_are_read() {
        // Idle, the toast is the only evidence there is.
        let idle = "Default · claude-opus-5 · thinking · high · ◔ 2% · Midway: 6h 10m    /tmp\n\n›  ask a question or describe a task ↵\n                       /sessions to resume · /copy to clipboard\n";
        assert_eq!(live_input_mode(idle), None, "idle kiro still paints no mode");
        assert_eq!(live_input_mode(&format!("• Switched to Steer mode\n{idle}")), Some("steer"));
        assert_eq!(live_input_mode(&format!("• Switched to Queue mode\n{idle}")), Some("queue"));
        // Busy, the footer is — with the elapsed time between label and hints.
        assert_eq!(live_input_mode("›  Kiro is working · 1m 27s · Type to steer · Ctrl+S to queue\n"), Some("steer"));
        assert_eq!(live_input_mode("›  Kiro is working · 19s · Type to queue · Ctrl+S to steer\n"), Some("queue"));
        // The queued-count line kiro paints above that footer in queue mode
        // is not a mode: it counts messages, and its own word is "queued".
        assert_eq!(live_input_mode(" ◇ 1 message queued · ctrl+x expand\n"), None);
        assert_eq!(live_input_mode("◇ 2 messages queued · ctrl+x expand\n"), None);
        let queued = " ◇ 1 message queued · ctrl+x expand\n›  Kiro is working · 32s · Type to queue · Ctrl+S to steer\n";
        assert_eq!(live_input_mode(queued), Some("queue"), "the footer still answers");
        // The bullet set is closed (reviewer's P1 on the first tip): the two
        // measured glyphs and the four of kiro's own family, nothing else.
        assert_eq!(TOAST_BULLETS, ['●', '•', '○', '◦', '◆', '◇']);
        for bullet in TOAST_BULLETS {
            assert_eq!(live_input_mode(&format!("{bullet} Switched to Steer mode\n")), Some("steer"), "{bullet}");
        }
        for other in ['*', '-', '+', '#', '>', '›', '|', '"'] {
            assert_eq!(live_input_mode(&format!("{other} Switched to Queue mode\n")), None, "{other} is not a kiro bullet");
        }
    }

    #[test]
    fn a_quoted_mode_line_is_not_the_pane_mode() {
        // The owner's own words, delivered as chat, and tool output reading a pane.
        let chat = "  › [tmm chat 2026-09-29 03:47] human: @builder Switched to Steer mode 我观察到\n    ● Switched to Steer mode\n    Kiro is working · Type to steer · Ctrl+S to queue\n";
        assert_eq!(live_input_mode(chat), None);
        let tool = "● Shell tmux capture-pane -p -t x\n    ╰ output:\n        ● Switched to Queue mode\n        ›  Kiro is working · Type to queue · Ctrl+S to steer\n";
        assert_eq!(live_input_mode(tool), None);
        assert_eq!(live_input_mode("● Switched to Steer mode, then I pressed it again\n"), None, "prose around it");
        assert_eq!(live_input_mode("›  Kiro is working · Type to queue · Ctrl+S to queue\n"), None, "a self-contradiction");
        assert_eq!(live_input_mode("›Kiro is working · Type to steer · Ctrl+S to queue\n"), None);
        assert_eq!(live_input_mode(""), None);
        // Board #346: a bullet is matched by shape, so the two glyphs that
        // carry what was TYPED must stay out — otherwise a person or a
        // delivery saying the sentence would switch the mode by saying it.
        assert_eq!(live_input_mode("›  Switched to Steer mode\n"), None, "kiro's input stamp");
        assert_eq!(live_input_mode("> Switched to Queue mode\n"), None);
        assert_eq!(live_input_mode("  • Switched to Steer mode\n"), None, "indented: not column zero");
        // And the footer is still the footer, not any line that says the word.
        assert_eq!(live_input_mode("›  Type to steer · Ctrl+S to queue\n"), None, "no label");
        assert_eq!(live_input_mode("›  Kiro is working · 19s · press Ctrl+S to steer\n"), None, "one hint only");
    }

    /// v3's post-turn `memory` auto-capture is the housekeeping tool (board
    /// #227); every other tool, in either key spelling, is the agent's work.
    #[test]
    fn memory_is_the_housekeeping_tool() {
        assert!(is_housekeeping_tool(&json!({"hook_event_name":"postToolUse","tool_name":"memory","tool_input":{}})));
        assert!(is_housekeeping_tool(&json!({"hookEventName":"postToolUse","toolName":"memory"})));
        assert!(!is_housekeeping_tool(&json!({"hook_event_name":"postToolUse","tool_name":"execute_bash","tool_input":{"command":"ls"}})));
        assert!(!is_housekeeping_tool(&json!({"hook_event_name":"stop"})));
    }

    /// Board #207: the engine door edits the recorded launch line exactly.
    #[test]
    fn engine_segment_is_added_replaced_or_removed_exactly() {
        let base = "command kiro-cli chat --agent dev --trust-all-tools";
        assert_eq!(reconcile_engine_in(base, ""), None, "closed door, no segment: nothing to do");
        assert_eq!(reconcile_engine_in(base, " --agent-engine v3").as_deref(), Some("command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3"));
        let v3 = "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3";
        assert_eq!(reconcile_engine_in(v3, " --agent-engine v3"), None, "already open: idempotent");
        assert_eq!(reconcile_engine_in(v3, "").as_deref(), Some(base), "door closed: the segment goes, the line is what it was");
        let kick = "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3 kick";
        assert_eq!(reconcile_engine_in(kick, "").as_deref(), Some("command kiro-cli chat --agent dev --trust-all-tools kick"));
        assert_eq!(reconcile_engine_in("x --agent-engine v2", " --agent-engine v3").as_deref(), Some("x --agent-engine v3"));
    }

    /// Board #207: v3 keeps the reply in the global session file. Real row
    /// shape from ~/.kiro/sessions/…/messages.jsonl (kiro-cli 2.22.1):
    /// {id, timestamp, payload:{type, content, …}}.
    #[test]
    fn v3_reply_is_the_last_assistant_entry_of_the_last_turn() {
        let row = |t: &str, extra: &str| format!(r#"{{"id":"x","timestamp":"2026-09-20T02:00:00Z","payload":{{"type":"{t}"{extra}}}}}"#);
        let jsonl = [
            row("user", r#","content":"first question""#),
            row("turn_start", r#","executionId":"e1""#),
            row("assistant", r#","content":"old answer""#),
            row("turn_end", r#","stopReason":"end_turn""#),
            row("user", r#","content":"Run the shell command: echo debug-probe""#),
            row("turn_start", r#","executionId":"e2""#),
            row("tool_call", r#","toolName":"execute_bash""#),
            row("assistant", r#","content":"Running it.""#),
            row("tool_result", r#","content":"Output:\ndebug-probe""#),
            "this line is not json".to_string(),
            row("assistant", r#","content":"```\ndebug-probe\n```\nExit code: 0""#),
            row("turn_end", r#","stopReason":"end_turn""#),
            row("session_start", r#","content":"You are a probe.""#),
        ].join("\n");
        assert_eq!(kiro_reply_from_session(&jsonl).as_deref(), Some("```\ndebug-probe\n```\nExit code: 0"));
        assert_eq!(kiro_reply_from_session(&row("user", r#","content":"q""#)), None, "no assistant yet");
        assert_eq!(kiro_reply_from_session(""), None);
        // Bare rows (no payload wrapper) are read too.
        assert_eq!(kiro_reply_from_session(r#"{"type":"assistant","content":"bare"}"#).as_deref(), Some("bare"));
    }

    #[test]
    fn session_reply_finds_the_session_under_any_cwd_hash() {
        let root = std::env::temp_dir().join(format!("tmm-kiro-sessions-{}", std::process::id()));
        let sess = root.join("1f1f982434702399").join("sess_abc");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join("messages.jsonl"), "{\"payload\":{\"type\":\"turn_start\"}}\n{\"payload\":{\"type\":\"assistant\",\"content\":\"done and verified\"}}\n{\"payload\":{\"type\":\"turn_end\"}}").unwrap();
        assert_eq!(session_reply(&root, "sess_abc").as_deref(), Some("done and verified"));
        assert_eq!(session_reply(&root, "sess_nope"), None);
        assert_eq!(session_reply(&root, "../etc"), None, "a path is not a session id");
        assert_eq!(session_reply(&root, ""), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Board #207: the v3 status line prints the model's DISPLAY name.
    #[test]
    fn display_name_models_are_read_only_after_the_anchor() {
        assert!(looks_like_model_name("Claude Sonnet 5"));
        assert!(looks_like_model_name("GPT 5.1 Codex"));
        assert!(!looks_like_model_name("Midway: 19h 19m"), "a colon is not a model");
        assert!(!looks_like_model_name("◔ 4%"));
        assert!(!looks_like_model_name("/local/home/cfu/temp/kiro-v3-test/ws"));
        assert!(!looks_like_model_name("(probe-branch)"));
        let v3 = "probe · Claude Sonnet 5 · high · ◔ 4% · Midway: 19h 19m   /local/home/cfu/temp/kiro-v3-test/ws · (probe-branch)\n";
        let v = sniff_kiro(v3, "probe");
        assert_eq!(v.model.as_deref(), Some("Claude Sonnet 5"));
        assert_eq!(v.effort.as_deref(), Some("high"));
        assert_eq!(v.context_pct, Some(4));
        assert_eq!(v.branch.as_deref(), Some("probe-branch"));
        let v2 = "probe · claude-sonnet-5 · high · ◔ 1% · Midway: 19h 19m   /local/home/cfu/temp/kiro-v3-test/ws · (probe-branch)\n";
        let v = sniff_kiro(v2, "probe");
        assert_eq!(v.model.as_deref(), Some("claude-sonnet-5"));
        // Negative control: the same words on an UNANCHORED line are prose.
        let prose = "I switched to Claude Sonnet 5 · high · ◔ 4%\n";
        assert_eq!(sniff_kiro(prose, "probe").model, None);
    }

    /// Board #213, measured on a managed v3 spawn: the turn's last assistant
    /// row is a `"..."` placeholder AFTER the real text; a second turn after a
    /// `session_start` row must not fall back to the first turn's text.
    #[test]
    fn session_reply_skips_the_placeholder_row_and_stays_in_the_last_turn() {
        let rows = [
            r#"{"id":1,"timestamp":1,"payload":{"type":"user","content":"[tmm chat] human: say hi"}}"#,
            r#"{"id":2,"timestamp":2,"payload":{"type":"turn_start"}}"#,
            r#"{"id":3,"timestamp":3,"payload":{"type":"assistant","content":"v3 ready."}}"#,
            r#"{"id":4,"timestamp":4,"payload":{"type":"assistant","content":"..."}}"#,
            r#"{"id":5,"timestamp":5,"payload":{"type":"turn_end"}}"#,
        ];
        assert_eq!(kiro_reply_from_session(&rows.join("\n")).as_deref(), Some("v3 ready."));
        let second = [
            r#"{"id":6,"timestamp":6,"payload":{"type":"session_start","content":"prompt"}}"#,
            r#"{"id":7,"timestamp":7,"payload":{"type":"turn_start"}}"#,
            r#"{"id":8,"timestamp":8,"payload":{"type":"assistant","content":"…"}}"#,
            r#"{"id":9,"timestamp":9,"payload":{"type":"turn_end"}}"#,
        ];
        let all = format!("{}\n{}", rows.join("\n"), second.join("\n"));
        assert_eq!(kiro_reply_from_session(&all), None, "a turn with only placeholders has no reply");
    }

    /// Board #213: resume follows the engine on the launch line.
    #[test]
    fn resume_dialect_follows_the_engine_on_the_launch_line() {
        let v2 = "command kiro-cli chat --agent dev --trust-all-tools";
        assert_eq!(resume_command(v2, Some("0d1b8e2a-1111")), format!("{v2} --resume-id 0d1b8e2a-1111"));
        assert_eq!(resume_command(v2, Some("sess_abc")), format!("{v2} --resume"), "a v3 id never reaches the v2 engine: its own recent thread");
        assert_eq!(resume_command(v2, None), format!("{v2} --resume"));

        let v3 = format!("{v2} --agent-engine v3");
        assert_eq!(resume_command(&v3, Some("sess_abc")), format!("{v3} --resume-id sess_abc"), "an exact v3 id resumes");
        assert_eq!(resume_command(&v3, Some("0d1b8e2a-1111")), v3, "a v2 id never reaches the v3 engine: fresh");
        assert_eq!(resume_command(&v3, None), v3, "no --resume under v3: the store is per directory, not per agent");
        assert!(launch_engine_is_v3("kiro-cli chat --v3"));
        assert!(!launch_engine_is_v3("kiro-cli chat --agent-engine v2"));
        // Flipping the door back (reconcile drops the segment) restores the v2 dialect untouched.
        let back = reconcile_engine_in(&v3, "").unwrap();
        assert_eq!(resume_command(&back, Some("0d1b8e2a-1111")), format!("{v2} --resume-id 0d1b8e2a-1111"));
    }

    /// Board #207: the exact 3.0 hooks we write — no `matcher` anywhere (the
    /// 2.0 glob "*" invalidates a 3.0 profile, measured), four named hooks.
    #[test]
    fn hooks_shape_is_the_3_0_array_without_matchers() {
        let hooks = kiro_hooks("/usr/bin/tmm-notify kiro");
        let list = hooks.as_array().expect("an array");
        assert_eq!(list.len(), 4);
        assert!(list.iter().all(|h| h.get("matcher").is_none()), "no matcher: {hooks}");
        assert!(list.iter().all(|h| h["action"]["type"] == "command" && h["action"]["command"] == "/usr/bin/tmm-notify kiro" && h["timeout"] == 10));
        let names: Vec<&str> = list.iter().map(|h| h["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["tmm-pre-tool", "tmm-post-tool", "tmm-prompt", "tmm-stop"]);
    }

    /// Board #207 option A: the v3 engine finds the agent through the
    /// WORKSPACE, so the door being open puts a symlink there and closing it
    /// takes the link away; a foreign file is never clobbered.
    #[test]
    fn workspace_entry_follows_the_engine_door_and_never_clobbers() {
        let root = std::env::temp_dir().join(format!("tmm-kiro-wsentry-{}", std::process::id()));
        let ws = root.join("ws");
        let home = ws.join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        std::fs::create_dir_all(ws.join(".git").join("info")).unwrap();
        std::fs::write(home.join("agents").join("dev.json"), "{}").unwrap();
        let link = workspace_entry_path(&ws, "dev");

        // Door closed (default): zero change to the workspace.
        std::env::remove_var("KIRO_ENGINE");
        assert!(!ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert!(!link.exists() && !ws.join(".kiro").exists(), "v2 leaves no trace");

        // Door open: the link, idempotent, and the git exclude.
        std::env::set_var("KIRO_ENGINE", "v3");
        assert!(ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert_eq!(std::fs::read_link(&link).unwrap(), home.join("agents").join("dev.json"));
        assert!(!ensure_workspace_entry(&ws, &home, "dev").unwrap(), "second start: nothing to do");
        let exclude = std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == "/.kiro/agents/dev.json"), "our file only, not the directory: {exclude}");
        assert!(!exclude.contains("/.kiro/agents/\n"), "the user's own agents stay visible to their git status");
        ensure_workspace_entry(&ws, &home, "dev").unwrap();
        assert_eq!(std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap(), exclude, "exclude is written once");
        // A second agent adds its own line under the one mark.
        let home2 = ws.join(".tmm").join("agents").join("ops2");
        std::fs::create_dir_all(home2.join("agents")).unwrap();
        std::fs::write(home2.join("agents").join("ops2.json"), "{}").unwrap();
        ensure_workspace_entry(&ws, &home2, "ops2").unwrap();
        let exclude2 = std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap();
        assert!(exclude2.lines().any(|l| l == "/.kiro/agents/ops2.json"));
        assert_eq!(exclude2.matches(GIT_EXCLUDE_MARK).count(), 1, "one mark: {exclude2}");
        remove_workspace_entry(&ws, "ops2");
        // Writing THROUGH the link lands in the home (what the CLI's upgrade does).
        std::fs::write(&link, "{\"name\":\"dev\"}").unwrap();
        assert_eq!(std::fs::read_to_string(home.join("agents/dev.json")).unwrap(), "{\"name\":\"dev\"}");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "still a link, no copy");

        // A foreign file in the way: fail loud, naming it, leave it alone.
        let other = workspace_entry_path(&ws, "ops");
        std::fs::write(&other, "{\"name\":\"ops\",\"mine\":true}").unwrap();
        let err = ensure_workspace_entry(&ws, &home, "ops").unwrap_err();
        assert!(err.contains("ops.json") && err.contains("not a tmux-mobile link"), "{err}");
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "{\"name\":\"ops\",\"mine\":true}");
        assert!(!remove_workspace_entry(&ws, "ops"), "not ours to remove");

        // Door closed again: our link goes, the foreign file stays.
        std::env::set_var("KIRO_ENGINE", "v2");
        assert!(ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert!(!link.exists() && other.exists());
        // Removal helper: ours only.
        std::env::set_var("KIRO_ENGINE", "v3");
        ensure_workspace_entry(&ws, &home, "dev").unwrap();
        assert!(remove_workspace_entry(&ws, "dev") && !link.exists());
        std::env::remove_var("KIRO_ENGINE");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Board #207: the 3.0 profile is written once and never churned — a home
    /// the CLI already upgraded (array + permissions) is left byte-identical.
    #[test]
    fn patch_profile_is_idempotent_on_both_shapes() {
        let dir = std::env::temp_dir().join(format!("tmm-kiro-profile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        std::fs::write(&path, serde_json::to_string_pretty(&json!({
            "name": "a", "prompt": "p", "hooks": { "stop": [ { "command": "old" } ] }
        })).unwrap()).unwrap();
        assert!(patch_profile(&path, kiro_hooks("n")), "2.0 object → 3.0 array + permissions");
        let once = std::fs::read_to_string(&path).unwrap();
        assert!(!patch_profile(&path, kiro_hooks("n")), "already 3.0: no write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), once);
        let v: Value = serde_json::from_str(&once).unwrap();
        assert!(v["hooks"].is_array());
        assert_eq!(v["permissions"]["rules"][0]["capability"], "all");
        // A permissions block someone else wrote is theirs.
        std::fs::write(&path, serde_json::to_string_pretty(&json!({
            "name": "a", "hooks": kiro_hooks("n"), "permissions": { "rules": [ { "capability": "shell", "effect": "ask" } ] }
        })).unwrap()).unwrap();
        assert!(!patch_profile(&path, kiro_hooks("n")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
