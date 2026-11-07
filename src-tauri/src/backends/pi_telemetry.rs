//! The telemetry extension of the pi family (board #71): omp (a fork of pi)
//! and pi both auto-load a TS extension from `<agent-dir>/extensions/` and
//! speak the same `pi.on(event, handler)` API, so ONE generator writes both.
//! The skeleton (the notify helper, the session id, the text of a message,
//! the tool events) is shared; the prompt receipt, the settle edge and the
//! session edge differ by measured version, and each is its dialect's own
//! block. The payloads are claude's dialect, so the normalizer needs no new
//! shapes.

/// Which CLI the extension is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    /// omp 18.15.0.
    Omp,
    /// pi 1.5.0 (board #71).
    Pi,
}

/// The extension for `dialect`, whose notify helper is the shell line
/// `notify` (quoted path + backend + marker comment).
pub(crate) fn extension(notify: &str, dialect: Dialect) -> String {
    // Embedded as a JSON string literal, which is also a valid TS one.
    let cmd = serde_json::to_string(notify).unwrap();
    let (prompt, settle, session) = match dialect {
        Dialect::Omp => (OMP_PROMPT, OMP_SETTLE, OMP_SESSION),
        Dialect::Pi => (PI_PROMPT, PI_SETTLE, PI_SESSION),
    };
    format!("{}{prompt}{settle}{session}{TAIL}", HEAD.replace("{NOTIFY}", &cmd))
}

/// Everything up to the hook's body; `{NOTIFY}` is the helper's literal.
const HEAD: &str = r#"// Teammux telemetry hook — auto-generated, rewritten on every start
// (refresh_hooks). Forwards turn edges and tool events to the tmm notify
// helper, which is a no-op outside a tmux pane. Do not edit.
import { spawn } from "node:child_process";

const NOTIFY = {NOTIFY};

function send(payload: Record<string, unknown>): void {
  try {
    const child = spawn("/bin/sh", ["-c", NOTIFY], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  } catch {}
}

function sessionId(ctx: any): string {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { return ""; }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
  }
  return "";
}

export default function hook(pi: any): void {
"#;

/// omp 18.15.0's prompt receipt (board #4).
const OMP_PROMPT: &str = r#"  // The prompt receipt (board #4, measured on omp 18.15.0): `input` fires
  // once at submission ingress with exactly the typed text, idle or busy,
  // BEFORE command interpretation and queueing. A typed line that reaches
  // the model arrives as its own `message_end`: a `user` message whose text
  // is the line (an idle prompt and each line steered into a busy run, which
  // gets no new `agent_start`), or for `/skill:<name> args` a `custom`
  // `skill-prompt` message whose `details.prompt` is the typed line (its
  // content and `before_agent_start.prompt` are the expanded skill body).
  // So a typed line is reported when, and only when, a message carrying it
  // ends: once, by content. Typed state that never reaches a message (a
  // builtin like `/hotkeys`, a line withdrawn from the queue) is never
  // attributed to another prompt. Only a message omp attributes to the user
  // (`attribution: "user"`, its own billing/turn-start field; measured on an
  // idle prompt, a steered line and a skill) can carry a typed line, so a
  // stale held line is never matched by an agent redirect or injection with
  // equal text, and a user-attributed message always has its own held entry
  // (equal text reports the same line). Held lines are never evicted or
  // cleared at `agent_end`: a queued line must survive any amount of typing
  // that starts no run, and a line typed as a run ends may start the next
  // one. The list grows only with lines typed that never ran. A message
  // nobody typed (another extension's, a reminder, runtime context) matches
  // nothing. `context` (every model call) is not read.
  let typed: string[] = [];
  const canon = (t: string): string => t.replace(/\s+/g, "");
  pi.on("input", async (event: any, _ctx: any) => {
    if (event?.source !== "interactive" && event?.source !== "rpc") return;
    if (typeof event?.text === "string" && event.text.trim() !== "") typed.push(event.text);
  });
  pi.on("message_end", async (event: any, ctx: any) => {
    try {
      const m = event?.message;
      if (m?.attribution !== "user") return;
      let carried = "";
      if (m?.role === "user") carried = textOf(m.content);
      else if (m?.role === "custom" && m?.customType === "skill-prompt" && typeof m?.details?.prompt === "string") carried = m.details.prompt;
      else return;
      const key = canon(carried);
      if (key === "") return;
      const i = typed.findIndex((t) => canon(t) === key);
      if (i < 0) return;
      const [line] = typed.splice(i, 1);
      send({ hook_event_name: "UserPromptSubmit", prompt: line, session_id: sessionId(ctx) });
    } catch {}
  });
"#;

/// omp's settle edge: `agent_end` unless `willContinue`.
const OMP_SETTLE: &str = r#"  // agent_end with willContinue is an auto-continuation, not a settle.
  pi.on("agent_end", async (event: any, ctx: any) => {
    if (event?.willContinue) return;
    let reply = "";
    let failure: any = null;
    try {
      const messages = event?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m?.role === "assistant") {
          reply = textOf(m.content);
          // Board #39: a turn the provider refused (omp 18.15.0).
          if (m.stopReason === "error") failure = { error_status: m.errorStatus ?? null, error_message: String(m.errorMessage ?? "") };
          break;
        }
      }
    } catch {}
    if (failure) send({ hook_event_name: "StopFailure", ...failure, session_id: sessionId(ctx) });
    else send({ hook_event_name: "Stop", last_assistant_message: reply, session_id: sessionId(ctx) });
  });
"#;

/// omp's session edge: `session_switch` (board #28).
const OMP_SESSION: &str = r#"  // Board #28: `/new` (and a fork) switches to a NEW session, written at
  // once; reported as claude's SessionStart so a restart resumes it.
  pi.on("session_switch", async (event: any, ctx: any) => {
    send({ hook_event_name: "SessionStart", source: String(event?.reason ?? "switch"), session_id: sessionId(ctx) });
  });
"#;

/// pi 1.5.0's prompt receipt (board #71, measured in the live rig, #71 note
/// 9). `input` fires once per typed line with its exact text, idle or
/// steered; the line reaches the model as a `user` message_end (a steered
/// one inside the running turn, with no new `agent_start`), and
/// `/skill:<name> args` as a user message whose text is the expanded
/// `<skill name="<name>" …>…</skill>` then a blank line and the args. pi's
/// messages carry no `attribution` (omp's gate), so a held line is matched
/// by its text, or by its skill name and args.
const PI_PROMPT: &str = r#"  let typed: string[] = [];
  const canon = (t: string): string => t.replace(/\s+/g, "");
  pi.on("input", async (event: any, _ctx: any) => {
    if (event?.source !== "interactive" && event?.source !== "rpc") return;
    if (typeof event?.text === "string" && event.text.trim() !== "") typed.push(event.text);
  });
  const skillOf = (t: string): [string, string] | null => {
    const m = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(t.trim());
    return m ? [m[1], canon(m[2] ?? "")] : null;
  };
  const expandedSkill = (t: string): [string, string] | null => {
    const m = /^<skill name="([^"]+)"[^>]*>[\s\S]*<\/skill>(?:\n\n([\s\S]*))?$/.exec(t);
    return m ? [m[1], canon(m[2] ?? "")] : null;
  };
  pi.on("message_end", async (event: any, ctx: any) => {
    try {
      const m = event?.message;
      if (m?.role !== "user") return;
      const carried = textOf(m.content);
      const key = canon(carried);
      if (key === "") return;
      let i = typed.findIndex((t) => canon(t) === key);
      const skill = i < 0 ? expandedSkill(carried) : null;
      if (skill) i = typed.findIndex((t) => { const s = skillOf(t); return !!s && s[0] === skill[0] && s[1] === skill[1]; });
      if (i < 0) return;
      const [line] = typed.splice(i, 1);
      send({ hook_event_name: "UserPromptSubmit", prompt: line, session_id: sessionId(ctx) });
    } catch {}
  });
"#;

/// pi's settle edge: `agent_end` repeats on a retry, a compaction retry or
/// queued follow-ups, and `agent_settled` is its final edge (its extension
/// docs; measured: one per turn, after `agent_before_settle`). The reply is
/// the last assistant message of the last `agent_end`. pi's assistant
/// message has `stopReason` and `errorMessage` but no `errorStatus`.
const PI_SETTLE: &str = r#"  let ended: any[] | null = null;
  pi.on("agent_end", async (event: any, _ctx: any) => {
    ended = Array.isArray(event?.messages) ? event.messages : [];
  });
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    let reply = "";
    let failure: any = null;
    try {
      const messages = ended ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m?.role === "assistant") {
          reply = textOf(m.content);
          if (m.stopReason === "error") failure = { error_status: null, error_message: String(m.errorMessage ?? "") };
          break;
        }
      }
    } catch {}
    ended = null;
    if (failure) send({ hook_event_name: "StopFailure", ...failure, session_id: sessionId(ctx) });
    else send({ hook_event_name: "Stop", last_assistant_message: reply, session_id: sessionId(ctx) });
  });
"#;

/// pi's session edge: `session_start` with its reason (`startup`, `new`,
/// `resume`, `fork`; measured: `startup` at launch, `new` after `/new`
/// under the new id), reported as claude's SessionStart so a restart
/// resumes the session the pane is in.
const PI_SESSION: &str = r#"  pi.on("session_start", async (event: any, ctx: any) => {
    send({ hook_event_name: "SessionStart", source: String(event?.reason ?? "startup"), session_id: sessionId(ctx) });
  });
"#;

/// The tool events and the hook's end, the same in every dialect.
const TAIL: &str = r#"  pi.on("tool_call", async (event: any, ctx: any) => {
    send({ hook_event_name: "PreToolUse", tool_name: event?.toolName ?? "tool", tool_input: event?.input ?? {}, session_id: sessionId(ctx) });
  });
  pi.on("tool_result", async (event: any, ctx: any) => {
    send({ hook_event_name: "PostToolUse", tool_name: event?.toolName ?? "tool", session_id: sessionId(ctx) });
  });
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Run the generated extension under node with a stand-in `pi`
    /// (`pi.on(event, handler)`), replaying `events` (`[name, payload]`) in
    /// order; the notify helper appends each payload to a file, so what
    /// comes back is what the hub would receive. `None` without node.
    fn replay(dialect: Dialect, events: Value) -> Option<Vec<Value>> {
        let node = crate::backends::dsh::tests::which("node")?;
        let dir = crate::config::test_scratch("tmm-pi-ext");
        let sink = dir.join("sink");
        std::fs::create_dir_all(&sink).unwrap();
        let notify = format!("cat > {}/$$.json", crate::shell::quote_always(&sink.to_string_lossy()));
        std::fs::write(dir.join("ext.ts"), extension(&notify, dialect)).unwrap();
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
        let hooks = std::fs::read_dir(&sink).unwrap().map(|e| serde_json::from_str(&std::fs::read_to_string(e.unwrap().path()).unwrap()).unwrap()).collect();
        let _ = std::fs::remove_dir_all(&dir);
        Some(hooks)
    }

    fn of(hooks: &[Value], event: &str, field: &str) -> Vec<String> {
        let mut v: Vec<String> = hooks.iter().filter(|h| h["hook_event_name"] == event).map(|h| h[field].as_str().unwrap_or("").to_string()).collect();
        v.sort();
        v
    }

    fn typed(text: &str) -> Value {
        json!(["input", { "type": "input", "text": text, "source": "interactive" }])
    }
    fn user(text: &str) -> Value {
        json!(["message_end", { "type": "message_end", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }])
    }
    fn end(reply: &str) -> Value {
        json!(["agent_end", { "type": "agent_end", "messages": [{ "role": "assistant", "content": [{ "type": "text", "text": reply }], "stopReason": "stop" }] }])
    }
    fn settled() -> Value {
        json!(["agent_settled", { "type": "agent_settled", "aborted": false }])
    }

    /// The measured idle turn (pi 1.5.0, #71 note 9): input, a system
    /// message_end, the user message_end, agent_end, agent_settled. One
    /// prompt, one Stop with the reply.
    #[test]
    fn a_pi_turn_reports_its_prompt_and_one_stop() {
        let system = json!(["message_end", { "type": "message_end", "message": { "role": "system", "content": "" } }]);
        let before = json!(["agent_before_settle", { "type": "agent_before_settle", "outcome": "completed" }]);
        let Some(h) = replay(Dialect::Pi, json!([typed("reply with ready"), system, user("reply with ready"), end("ready"), before, settled()])) else { return };
        assert_eq!(of(&h, "UserPromptSubmit", "prompt"), ["reply with ready"]);
        assert_eq!(of(&h, "Stop", "last_assistant_message"), ["ready"]);
        assert!(h.iter().all(|p| p["session_id"] == "sess-1"));
    }

    /// A line steered into a busy run (measured: `streamingBehavior: steer`,
    /// its user message inside the same run): both lines are reported, once
    /// each, and the run settles once.
    #[test]
    fn a_steered_line_is_its_own_prompt_and_the_run_settles_once() {
        let steer = json!(["input", { "type": "input", "text": "also say steered", "source": "interactive", "streamingBehavior": "steer" }]);
        let Some(h) = replay(Dialect::Pi, json!([typed("run it"), user("run it"), steer, user("also say steered"), end("finished steered"), settled()])) else { return };
        assert_eq!(of(&h, "UserPromptSubmit", "prompt"), ["also say steered", "run it"]);
        assert_eq!(of(&h, "Stop", "last_assistant_message"), ["finished steered"]);
    }

    /// `/skill:greet now` reaches the model as the expanded skill (measured
    /// shape); it is reported as the typed line. Another skill's or other
    /// args' expansion does not match it.
    #[test]
    fn a_skill_line_is_matched_by_its_expansion() {
        let expanded = "<skill name=\"greet\" location=\"/h/skills/greet/SKILL.md\">\nReferences are relative to /h/skills/greet.\n\nSay the word GREETED.\n</skill>\n\nnow";
        let Some(h) = replay(Dialect::Pi, json!([typed("/skill:greet now"), user(expanded), end("GREETED"), settled()])) else { return };
        assert_eq!(of(&h, "UserPromptSubmit", "prompt"), ["/skill:greet now"]);
        let other = expanded.replace("\n\nnow", "\n\nlater");
        let Some(h) = replay(Dialect::Pi, json!([typed("/skill:greet now"), user(&other), end("x"), settled()])) else { return };
        assert!(of(&h, "UserPromptSubmit", "prompt").is_empty(), "other args are another prompt");
    }

    /// Typed state that never reaches a message (a builtin such as
    /// `/hotkeys`) is never attributed to another line, and a user message
    /// nobody typed (an extension's) reports nothing.
    #[test]
    fn only_a_typed_line_that_reaches_the_model_is_reported() {
        let Some(h) = replay(Dialect::Pi, json!([typed("/hotkeys"), user("injected by an extension"), typed("hello"), user("hello"), end("hi"), settled()])) else { return };
        assert_eq!(of(&h, "UserPromptSubmit", "prompt"), ["hello"]);
    }

    /// `agent_end` repeats on a retry; only `agent_settled` ends the turn,
    /// with the LAST run's reply. A provider error on the final run is a
    /// StopFailure with its message (pi has no errorStatus).
    #[test]
    fn a_retry_settles_once_and_an_error_is_a_stop_failure() {
        let failed = json!(["agent_end", { "type": "agent_end", "messages": [{ "role": "assistant", "content": [], "stopReason": "error", "errorMessage": "403 Forbidden" }] }]);
        let Some(h) = replay(Dialect::Pi, json!([typed("go"), user("go"), failed.clone(), end("recovered"), settled()])) else { return };
        assert_eq!(of(&h, "Stop", "last_assistant_message"), ["recovered"]);
        assert!(of(&h, "StopFailure", "error_message").is_empty());
        let Some(h) = replay(Dialect::Pi, json!([typed("go"), user("go"), failed, settled()])) else { return };
        assert_eq!(of(&h, "StopFailure", "error_message"), ["403 Forbidden"]);
        assert!(h.iter().filter(|p| p["hook_event_name"] == "StopFailure").all(|p| p["error_status"].is_null()));
        assert!(of(&h, "Stop", "last_assistant_message").is_empty());
    }

    /// `session_start` (measured: `startup`, then `new` after `/new`) is
    /// claude's SessionStart with its reason.
    #[test]
    fn a_pi_session_start_is_reported_with_its_reason() {
        let Some(h) = replay(Dialect::Pi, json!([["session_start", { "type": "session_start", "reason": "new" }]])) else { return };
        assert_eq!(of(&h, "SessionStart", "source"), ["new"]);
    }

    /// omp's dialect keeps its own blocks: pi's settle edge and session
    /// edge are not in omp's extension, and omp's are not in pi's.
    #[test]
    fn each_dialect_carries_only_its_own_edges() {
        let omp = extension("N", Dialect::Omp);
        let pi = extension("N", Dialect::Pi);
        assert!(omp.contains("willContinue") && omp.contains("\"session_switch\"") && !omp.contains("agent_settled"));
        assert!(pi.contains("\"agent_settled\"") && pi.contains("\"session_start\"") && !pi.contains("willContinue") && !pi.contains("attribution"));
    }
}
