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
}

/// The extension for `dialect`, whose notify helper is the shell line
/// `notify` (quoted path + backend + marker comment).
pub(crate) fn extension(notify: &str, dialect: Dialect) -> String {
    // Embedded as a JSON string literal, which is also a valid TS one.
    let cmd = serde_json::to_string(notify).unwrap();
    let (prompt, settle, session) = match dialect {
        Dialect::Omp => (OMP_PROMPT, OMP_SETTLE, OMP_SESSION),
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

/// The tool events and the hook's end, the same in every dialect.
const TAIL: &str = r#"  pi.on("tool_call", async (event: any, ctx: any) => {
    send({ hook_event_name: "PreToolUse", tool_name: event?.toolName ?? "tool", tool_input: event?.input ?? {}, session_id: sessionId(ctx) });
  });
  pi.on("tool_result", async (event: any, ctx: any) => {
    send({ hook_event_name: "PostToolUse", tool_name: event?.toolName ?? "tool", session_id: sessionId(ctx) });
  });
}
"#;
