//! The dsh backend's own knowledge (board #404): every fact about how
//! DeepSeek Harness is driven lives here — one file to touch when it changes.
//!
//! DeepSeek Harness 0.2.0-rc.2 (`npm i -g @deepseek-ai/dsh`, bin `dsh`),
//! measured 2026-10-16 in a scratch `DSH_HOME` and a scratch tmux session:
//!
//! * dsh ships web, desktop, headless, acp and sdk front ends and NO
//!   interactive terminal UI. The owner's shape (10-16): the agent's pane is
//!   an idle shell; a delivered line runs ONE resumed headless turn as a
//!   visible command and the pane returns to its prompt.
//! * `DSH_HOME` relocates everything (profiles, sessions, credentials,
//!   storages, the user-global `AGENTS.md`); `DSH_AGENTS_HOME` the shared
//!   agents root (default `~/.agents`). The isolated home is `<home>/dsh`.
//! * a profile is four files under `profiles/<name>/` (package.json naming
//!   the bundles, pnpm-workspace.yaml, cordis.yml, cordis.patch.yml); the
//!   `tmm` profile here is `dsh-base` + `dsh-headless`, the shipped headless
//!   template's shape. `dsh --profile tmm [--session-id <id>] -- <task>` runs
//!   one turn and exits; `--` keeps a task that starts with `-` a task.
//! * a LOCAL plugin mounts by absolute path (`- insert: [{id, name}]`), and
//!   it MUST sit in a directory whose package.json has a name and a version:
//!   the deepseek-official route sends the active plugin inventory with every
//!   request and otherwise fails each one with `REQUEST_EXTENSION` (measured
//!   both ways). The name is therefore fixed and neutral (`PLUGIN_NAME`).
//! * `session/event (session, ev)` carries every durable event: `turn/start`,
//!   `user/message` (`source.kind == "user"` is the prompt), `tool/call`
//!   `{name, arguments}`, `tool/result`, `assistant/message`
//!   (`message.content[]` text parts, and the step's `usage`: `inputTokens`,
//!   `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`,
//!   where input EXCLUDES the cache reads — 11382 + 384 + 70 = 11836),
//!   `request/context` (`model`, `contextWindow`: 1000000 for deepseek-flash),
//!   `turn/end` (`reason.kind` completed | error). `session.header.id` is
//!   `session-<uuid>`. (Usage and context measured 2026-10-17 on the live
//!   `deepseek` agent's session, board #409.)
//! * `--session-id` resumes exactly (the next turn saw the previous one); an
//!   unknown id fails at once, before any request. Sessions live in
//!   `sessions/<cwd-key>/<id>/`.
//! * SIGINT exits 130 at once and writes NO `turn/end`; the next resumed turn
//!   works and the model knows it was interrupted.
//! * headless has no channel to ask for an approval (the model gave up on an
//!   out-of-workspace write under `ask`), so a managed home runs unattended:
//!   `DSH_PERMISSION_MODE=danger-full-access` — the shipped config's own
//!   switch for sandbox mode AND approval policy `never`.
//! * auth: `DEEPSEEK_API_KEY` from the environment (the deepseek route's own
//!   fallback). A key the user saved through the web UI lives in
//!   `~/.dsh/.credentials.yaml` and is NOT visible in an isolated home.
//! * cold start ≈ 1.7 s before the request.

/// No queue|steer choice: a run owns the TTY in raw mode (Escape), so a line
/// typed while it runs is swallowed (`LOSES_BUSY_INPUT`). Lines for a busy
/// agent are held by delivery and typed after its Stop, which the shell
/// sends once its prompt is back.
pub(crate) const SWITCHES_INPUT_MODE: bool = false;
pub(crate) const LOSES_BUSY_INPUT: bool = true;

/// The deepseek-official route's reasoning levels (dsh providers guide:
/// "its models already offer off, low, high, and max"); written as the
/// profile's `agent-default-model.reasoningEffort`.
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["off", "low", "high", "max"]
}

/// The route lists its models from the account service or its own catalog;
/// there is no CLI to ask without a request, so the model is free text.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    None
}

/// The shipped default model of the deepseek-official route
/// (`agent-default-model` in dsh-base), used when the definition names none.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const DEFAULT_MODEL: &str = "deepseek-flash";

/// The provider every managed dsh agent runs on; its key is `KEY_ENV`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PROVIDER: &str = "deepseek-official";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const KEY_ENV: &str = "DEEPSEEK_API_KEY";

/// The plugin package's identity. dsh sends the name and version of every
/// active plugin to DeepSeek with each request (the inventory above), so it
/// is fixed: no workspace path, no agent name.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PLUGIN_NAME: &str = "tmm-telemetry";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PLUGIN_VERSION: &str = "1.0.0";

/// The launch line: the managed shell REPLACES the pane's own shell (spawn
/// sources the launch script into it), so the managed zsh IS the pane's
/// process — its pid is `#{pane_pid}` — and when it dies the pane dies with
/// it: no ordinary shell is left to read a chat line.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const LAUNCH: &str = "exec zsh -i";

/// The profile a managed home runs, and the prompt its shell shows.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PROFILE: &str = "tmm";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PROMPT: &str = "dsh › ";
/// The prompt while the shell is not yet ready for input (before
/// `zle-line-init` ran): a screen showing `PROMPT` is a shell whose ready
/// file exists.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const PROMPT_WAIT: &str = "dsh · ";
/// The startup waiter's ready marker: the prompt WITHOUT its trailing space,
/// because a pane capture is trimmed at the end (`capture_pane_plain`) and a
/// fresh prompt is the last thing on screen.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const READY_MARKER: &str = "dsh ›";

/// The first segment of the vitals row our plugin writes and our shell
/// paints (board #409): `[dsh] · <model> · ctx <used>/<window>`. Only a line
/// that STARTS with it, at column zero, is read — the same rule as claude's
/// `[CC]` row. That rejects an indented, prompt-prefixed or chat-stamped
/// copy, NOT every copy: an output line that itself starts exactly with
/// `[dsh] · ` is read too, and while a run prints it is the newest.
pub(crate) const VITALS_ANCHOR: &str = "[dsh]";

use serde_json::Value;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::Rendered;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::Vitals;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// The plugin a managed dsh profile mounts: it reports the turn to the
/// notify helper in claude's payload dialect and turns Escape into SIGINT.
/// Every handler is wrapped: telemetry never breaks a run.
///
/// * only the agent's OWN session counts: the first ROOT session (no
///   `parentSession`, not a subagent's origin), checked on every event — a
///   subagent's turn, prompt or reply never becomes the window's (#404 P1-B);
/// * ONE writer: every envelope is published synchronously, in event order,
///   with a rising `TMM_HOOK_SEQ` the inbox orders by, so nothing is in
///   flight when the run ends and the shell's Stop is always last (P1-C);
/// * the first user-sourced `user/message` of a turn → `UserPromptSubmit`;
///   `tool/call` → `PreToolUse`; `tool/result` → `PostToolUse`;
/// * `assistant/message` text is kept, and `turn/end` WRITES the Stop payload
///   (reply + `dsh_reason`) to `$DSH_HOME/tmm/stop.json` — the shell sends it
///   when its prompt is back (see `zshrc`), never the plugin: held lines are
///   typed on Stop, and typed while dsh still owns the TTY they would be lost;
/// * the session id goes to `$DSH_HOME/tmm/session`, the id the next turn
///   resumes;
/// * the vitals row (`VITALS_ANCHOR`, board #409) goes to
///   `$DSH_HOME/tmm/vitals` after every `assistant/message`: the model and
///   window from the last `request/context`, and the context USED, which is
///   the step's `inputTokens + cacheReadTokens + cacheWriteTokens` (what the
///   request carried). The shell paints it when its prompt is back and
///   `sniff_dsh` reads it there;
/// * `requireEnv` (the provider's key variable) unset: the prompt is
///   reported, the Stop is written as an error, ONE plain line goes to
///   stderr and the process exits before any request is made;
/// * the TTY is raw while the run lasts; a lone ESC (what tmux sends for
///   `Escape`) or ^C sends SIGINT to the process — dsh's own exit path.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn plugin_js(notify: &str) -> String {
    // A JSON string literal is also a valid JS string literal.
    let cmd = serde_json::to_string(notify).unwrap();
    format!(
        r#"// tmux-mobile telemetry plugin for DeepSeek Harness — generated, rewritten
// on every start (board #404). Do not edit.
import {{ spawnSync }} from 'node:child_process'
import {{ appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync }} from 'node:fs'
import {{ join }} from 'node:path'

export const name = '{PLUGIN_NAME}'

const NOTIFY = {cmd}
const STATE = join(process.env.DSH_HOME || '.', 'tmm')
const SESSION_ID = /^session-[A-Za-z0-9-]+$/

function put(file, text) {{
  try {{
    mkdirSync(STATE, {{ recursive: true }})
    const tmp = join(STATE, `.${{file}}.${{process.pid}}`)
    writeFileSync(tmp, text)
    renameSync(tmp, join(STATE, file))
  }} catch {{}}
}}

// The run's ONE writer: every envelope is published synchronously, in dsh's
// event order, each with a sequence number (microseconds, strictly rising,
// shared with the shell through tmm/seq) that orders a same-second pair in
// the inbox. Nothing is ever in flight when the process ends, so the Stop the
// shell sends afterwards is always the last envelope of the turn. Bounded:
// a helper that hangs is killed after HOOK_TIMEOUT_MS.
const HOOK_TIMEOUT_MS = 3000
let lastSeq = 0n
function nextSeq() {{
  if (lastSeq === 0n) {{
    try {{ lastSeq = BigInt(readFileSync(join(STATE, 'seq'), 'utf8').trim()) }} catch {{}}
  }}
  const now = BigInt(Date.now()) * 1000n
  lastSeq = now > lastSeq ? now : lastSeq + 1n
  put('seq', String(lastSeq))
  return String(lastSeq)
}}
// True when the helper published it (exit 0 within the bound). A late or
// failed publish is harmless: the inbox drops any envelope whose tmm_seq is
// not above what it already consumed for this window.
let backlog = false
function send(payload) {{
  try {{
    const seq = nextSeq()
    // One envelope shape for both producers: `{{"tmm_seq":<digits>,…}}`.
    const line = JSON.stringify({{ tmm_seq: Number(seq), ...payload }})
    // Older envelopes still unsent: this one queues behind them, never ahead
    // — kept, so it WILL be published in order (true: the shell must not
    // report it a second time).
    if (backlog) {{
      try {{ appendFileSync(join(STATE, 'unsent'), line + '\n'); return true }} catch {{ return false }}
    }}
    const r = spawnSync('/bin/sh', ['-c', NOTIFY], {{
      input: line,
      env: {{ ...process.env, TMM_HOOK_SEQ: seq }},
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: HOOK_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }})
    return !r.error && r.status === 0
  }} catch {{
    return false
  }}
}}

function textOf(content) {{
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('')
}}

// Escape and ^C (raw mode turns ^C into a byte) end the run through dsh's
// own SIGINT exit. The handler runs on the event loop, never inside a
// synchronous publish, so no envelope is cut off by it.
function interruptOnEscape() {{
  if (!process.stdin.isTTY) return
  try {{
    process.stdin.setRawMode(true)
    process.on('exit', () => {{ try {{ process.stdin.setRawMode(false) }} catch {{}} }})
    process.stdin.on('data', (d) => {{
      const s = d.toString('latin1')
      if (s === '\x1b' || s.includes('\x03')) {{
        try {{ process.stdin.setRawMode(false) }} catch {{}}
        process.kill(process.pid, 'SIGINT')
      }}
    }})
    process.stdin.resume()
    process.stdin.unref()
  }} catch {{}}
}}

// The agent's OWN session: the first root session (no parentSession, not a
// subagent's origin) this run sees. A subagent's session — spawned or forked
// in process — never becomes the window's turn, prompt or reply; every event
// is checked against the root, not only the first one.
function isRoot(header) {{
  return header && header.parentSession === undefined && header.origin !== 'subagent'
}}

// Envelopes the previous shell could not publish within its bound
// (tmm/unsent, oldest first) go out first, under their own numbers.
function resendUnsent() {{
  const file = join(STATE, 'unsent')
  let lines = []
  try {{ lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) }} catch {{ return }}
  const left = []
  for (const line of lines) {{
    let seq = ''
    try {{ seq = String(JSON.parse(line).tmm_seq ?? '') }} catch {{}}
    const r = left.length || !/^[0-9]+$/.test(seq) ? null : spawnSync('/bin/sh', ['-c', NOTIFY], {{
      input: line, env: {{ ...process.env, TMM_HOOK_SEQ: seq }}, stdio: ['pipe', 'ignore', 'ignore'], timeout: HOOK_TIMEOUT_MS, killSignal: 'SIGKILL',
    }})
    if (!r || r.error || r.status !== 0) left.push(line)
  }}
  if (left.length) {{ put('unsent', left.join('\n') + '\n'); backlog = true }}
  else try {{ unlinkSync(file) }} catch {{}}
}}

// The vitals row the shell paints when its prompt is back (`sniff_dsh` reads
// it): `[dsh] · <model> · ctx <used>/<window>`, exact token counts — the
// percentage is computed on the hub, by the one formula every backend that
// reports counts goes through. Without a window or a usage yet: no ctx
// segment; a step without usage keeps the last one.
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
// What the step's request carried: input (which EXCLUDES cache reads) plus
// the cached prefix read and written. Output is not in it.
function contextUsed(usage) {{
  const input = count(usage?.inputTokens)
  if (input === null) return null
  return input + (count(usage?.cacheReadTokens) ?? 0) + (count(usage?.cacheWriteTokens) ?? 0)
}}
function vitalsRow(model, window, used) {{
  const m = String(model ?? '').replace(/[\u0000-\u001f\u007f\u00b7]/g, '').trim()
  if (!m) return ''
  const parts = ['{VITALS_ANCHOR}', m]
  if (window && used !== null) parts.push(`ctx ${{used}}/${{window}}`)
  return parts.join(' · ')
}}

export function apply(ctx, config) {{
  const required = typeof config?.requireEnv === 'string' ? config.requireEnv : ''
  resendUnsent()
  interruptOnEscape()
  let root = null
  let sid = ''
  let awaitingPrompt = false
  let reply = ''
  let model = ''
  let window = 0
  let used = null
  ctx.on('session/event', (session, ev) => {{
    try {{
      if (root === null) {{
        let header
        try {{ header = session?.header }} catch {{}}
        const id = String(header?.id ?? '')
        if (!isRoot(header) || !SESSION_ID.test(id)) return
        root = session
        sid = id
        put('session', sid)
      }}
      if (session !== root) return
      const d = ev?.data
      switch (ev?.type) {{
        case 'turn/start':
          awaitingPrompt = true
          reply = ''
          break
        case 'user/message':
          if (awaitingPrompt && d?.source?.kind === 'user') {{
            awaitingPrompt = false
            // Marked only once it is published: otherwise the shell reports it.
            if (send({{ hook_event_name: 'UserPromptSubmit', prompt: textOf(d.content), session_id: sid }})) put('prompted', '')
            if (required && !process.env[required]) {{
              put('stop.json', JSON.stringify({{ hook_event_name: 'Stop', session_id: sid, last_assistant_message: '', dsh_reason: 'error' }}))
              process.stderr.write(`${{required}} is not set\n`)
              process.exit(1)
            }}
          }}
          break
        case 'tool/call': {{
          let input = {{}}
          try {{ input = JSON.parse(d?.arguments ?? '{{}}') }} catch {{}}
          send({{ hook_event_name: 'PreToolUse', tool_name: d?.name ?? 'tool', tool_input: input, session_id: sid }})
          break
        }}
        case 'tool/result':
          send({{ hook_event_name: 'PostToolUse', tool_name: 'tool', session_id: sid }})
          break
        case 'request/context':
          if (typeof d?.model === 'string') model = d.model
          if (count(d?.contextWindow)) window = count(d.contextWindow)
          break
        case 'assistant/message': {{
          const t = textOf(d?.message?.content)
          if (t.trim()) reply = t
          used = contextUsed(d?.usage) ?? used
          const row = vitalsRow(model, window, used)
          if (row) put('vitals', row)
          break
        }}
        case 'turn/end':
          put('stop.json', JSON.stringify({{ hook_event_name: 'Stop', session_id: sid, last_assistant_message: reply, dsh_reason: d?.reason?.kind ?? '' }}))
          break
      }}
    }} catch {{}}
  }})
}}
"#
    )
}

/// The plugin directory's package.json: the neutral identity dsh's
/// inventory sends upstream (`PLUGIN_NAME`, `PLUGIN_VERSION`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn plugin_package_json() -> String {
    format!(
        "{{\n  \"name\": \"{PLUGIN_NAME}\",\n  \"version\": \"{PLUGIN_VERSION}\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"main\": \"index.mjs\"\n}}\n"
    )
}

/// The `tmm` profile's package.json: the shipped headless template's bundles.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_package_json() -> &'static str {
    "{\n  \"name\": \"dsh-profile-tmm\",\n  \"private\": true,\n  \"dependencies\": {},\n  \"dsh\": {\n    \"profile\": {\n      \"bundles\": [\n        \"@deepseek-ai/dsh-base\",\n        \"@deepseek-ai/dsh-headless\"\n      ]\n    }\n  }\n}\n"
}

/// The profile's pnpm workspace file, as the shipped template writes it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_workspace_yaml() -> &'static str {
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
}

/// The profile root: an empty entry list (the tree is composed as patches).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_cordis_yml() -> &'static str {
    "# dsh profile root — an empty entry list; the tree is the bundles' patches\n# plus cordis.patch.yml. Written by tmux-mobile.\n[]\n"
}

/// The profile's own patch layer: the plugin, the model (its config is the
/// ONE place the model lives — never the launch line), the LLM session
/// title switched off (it is an extra model request on every first prompt),
/// the definition's MCP servers as native `dsh-mcp-client` rows
/// (`mcp_rows`), and the skill provider pointed at the agent's own skill
/// root only (board #412). Values are JSON strings, which YAML reads as
/// plain strings.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_patch_yml(plugin_entry: &std::path::Path, model: &str, effort: &str, mcp: &str, skill_root: &std::path::Path) -> String {
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let model = model.trim();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    let effort = effort.trim();
    let effort_line = if effort.is_empty() { String::new() } else { format!("    reasoningEffort: {}\n", q(effort)) };
    format!(
        "# Written by tmux-mobile — regenerated at every spawn and restart (board #404).\n\
         - insert:\n    - id: {PLUGIN_NAME}\n      name: {}\n      config:\n        requireEnv: {}\n{mcp}\
         - id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n{effort_line}\
         - id: session-title-llm\n  disabled: true\n\
         - id: session-log-deepseek\n  config:\n    enabled: false\n\
         - id: plugin-package-inventory-deepseek\n  config:\n    enabled: false\n\
         - id: skill-filesystem\n  config:\n    customSkillDirs: [{}]\n    includeDefaultRoots: false\n",
        q(&plugin_entry.to_string_lossy()),
        q(KEY_ENV),
        q(PROVIDER),
        q(model),
        q(&skill_root.to_string_lossy()),
    )
}

/// The definition's MCP servers as `dsh-mcp-client` rows inside the patch's
/// `insert` list (board #412), the same servers kiro and claude get
/// natively (`spawn::mcp_defs`). stdio = `command`/`args`/`env`; remote =
/// `streamable-http` `url`/`headers`. A value naming an environment
/// variable (`${VAR}`, `$VAR`, `Bearer ${VAR}`) reads it at launch
/// (`!!js process.env.VAR`, the name already validated as an identifier);
/// every other value is a literal JSON string. What dsh cannot express is
/// REFUSED, never guessed: a server name outside dsh's rule, or a server
/// with neither a command nor a url.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn mcp_rows(defs: &[shared::McpDef]) -> Result<String, String> {
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let env_value = |v: &str| match shared::env_reference(v) {
        Some(name) => format!("!!js \"process.env.{name} ?? ''\""),
        None => q(v),
    };
    let mut out = String::new();
    for m in defs {
        let ok_name = (1..=32).contains(&m.name.len()) && m.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !ok_name {
            return Err(format!("MCP server {:?}: dsh needs a name of 1-32 letters, digits, '_' or '-'", m.name));
        }
        out += &format!("    - id: tmm-mcp-{}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: {}\n", m.name, q(&m.name));
        if let Some(url) = &m.url {
            out += &format!("        transport: \"streamable-http\"\n        url: {}\n", q(url));
            if !m.headers.is_empty() {
                out += "        headers:\n";
                for (k, v) in &m.headers {
                    let value = match shared::header_env_reference(v) {
                        Some((name, true)) => format!("!!js \"'Bearer ' + (process.env.{name} ?? '')\""),
                        Some((name, false)) => format!("!!js \"process.env.{name} ?? ''\""),
                        None => q(v),
                    };
                    out += &format!("          {}: {value}\n", q(k));
                }
            }
        } else if let Some(cmd) = &m.command {
            let args: Vec<String> = m.args.iter().map(|a| q(a)).collect();
            out += &format!("        transport: \"stdio\"\n        command: {}\n        args: [{}]\n", q(cmd), args.join(", "));
            if !m.env.is_empty() {
                out += "        env:\n";
                for (k, v) in &m.env {
                    out += &format!("          {}: {}\n", q(k), env_value(v));
                }
            }
        } else {
            return Err(format!("MCP server {:?}: neither a command nor a url", m.name));
        }
    }
    Ok(out)
}

/// Where the agent's own skill root lives (`write_skill_root`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn skill_root(dsh_home: &Path) -> std::path::PathBuf {
    dsh_home.join("tmm").join("skills")
}

/// The agent's own skill root (board #412): one link per skill of its
/// definition, rebuilt at every render, and the ONLY root the skill provider
/// scans (`includeDefaultRoots: false` keeps the owner's `~/.agents`, the
/// project's `.agents/skills` and dsh's bundled skills out — the AGENTS.md
/// rule). dsh announces these skills to the model in its own catalog and
/// loads them with its `skill` tool, so no index is written into the
/// prompt. Each skill's SKILL.md is checked the way dsh's `parseSkillFile`
/// reads it (`dsh_skill_name`); one dsh would skip is refused with the
/// reason, never rewritten.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_skill_root(root: &Path, skills: &[crate::projects::skills::ResolvedSkill]) -> Result<(), String> {
    let names = skills
        .iter()
        .map(|sk| dsh_skill_name(&sk.dir).map_err(|why| format!("skill {:?} ({}): {why}", sk.name, sk.dir.display())))
        .collect::<Result<Vec<_>, _>>()?;
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(|e| format!("clear {}: {e}", root.display()))?;
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for (sk, name) in skills.iter().zip(&names) {
        std::os::unix::fs::symlink(&sk.dir, root.join(name)).map_err(|e| format!("link skill {name}: {e}"))?;
    }
    Ok(())
}

/// The name dsh 0.2.0-rc.2 catalogs a skill bundle under, or why it would
/// skip it. A validated SUBSET mirroring its `parseSkillFile`, not a second
/// copy of its parser (YAML edge cases can still differ): `SKILL.md` opens
/// with a `---` line and a closing `---` line (each with at most ONE `\r`
/// before its newline, as dsh strips) around a YAML mapping; `name` and
/// `description` are non-empty strings (no fallback to the directory name);
/// the name matches `^[a-z0-9]+(-[a-z0-9]+)*$`; the legacy invocation keys
/// are rejected; `disable-model-invocation` / `user-invocable`, when
/// present, read as a boolean (true/false, 1/0 — `1.0` is the number 1 to
/// dsh's YAML too —, yes/no, on/off).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn dsh_skill_name(dir: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(dir.join("SKILL.md")).map_err(|e| format!("no readable SKILL.md ({e})"))?;
    // One `\n`, then at most one `\r`: dsh's `replace(/\r$/, "")`.
    let delim = |l: &str| {
        let l = l.strip_suffix('\n').unwrap_or(l);
        l.strip_suffix('\r').unwrap_or(l) == "---"
    };
    let mut lines = raw.split_inclusive('\n');
    if !lines.next().is_some_and(delim) {
        return Err("SKILL.md does not open with YAML frontmatter".into());
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if delim(line) {
            closed = true;
            break;
        }
        yaml.push_str(line);
    }
    if !closed {
        return Err("SKILL.md frontmatter is not closed by a --- line".into());
    }
    let data: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(&yaml).map_err(|e| format!("invalid YAML frontmatter ({e})"))?;
    let field = |k: &str| data.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let name = field("name").ok_or("the frontmatter needs a `name` (dsh never uses the directory name)")?;
    if field("description").is_none() {
        return Err("the frontmatter needs a `description`".into());
    }
    let ok_name = name.split('-').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    if !ok_name {
        return Err(format!("the name {name:?} is not lowercase letters and digits joined by '-'"));
    }
    for (legacy, canonical) in [("disableModelInvocation", "disable-model-invocation"), ("modelInvocable", "disable-model-invocation"), ("userInvocable", "user-invocable")] {
        if data.contains_key(legacy) {
            return Err(format!("the field {legacy:?} is unsupported; dsh reads {canonical:?}"));
        }
    }
    for key in ["disable-model-invocation", "user-invocable"] {
        let Some(v) = data.get(key) else { continue };
        let ok = match v {
            serde_yaml_ng::Value::Bool(_) => true,
            serde_yaml_ng::Value::Number(n) => n.as_f64().is_some_and(|n| n == 0.0 || n == 1.0),
            serde_yaml_ng::Value::String(s) => matches!(s.to_ascii_lowercase().as_str(), "1" | "0" | "true" | "false" | "yes" | "no" | "on" | "off"),
            _ => false,
        };
        if !ok {
            return Err(format!("the field {key:?} must be a boolean"));
        }
    }
    Ok(name.to_string())
}

/// The managed shell's `.zshenv`: no system rc files (`/etc/zshrc` and
/// friends are the user's interactive furniture), so the pane is exactly
/// what `zshrc` declares. The environment itself — PATH, the provider key —
/// is inherited from the launching shell.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn zshenv() -> &'static str {
    "# Written by tmux-mobile — regenerated at every spawn and restart (board #404).\nunsetopt GLOBAL_RCS\n"
}

/// The managed shell's `.zshrc` — the whole "CLI" a dsh agent's pane runs.
///
/// * `accept-line`: a non-empty line becomes ONE visible command,
///   `dsh --profile tmm [--session-id <id>] -- <line>`, the line quoted by
///   zsh itself (`${(q+)BUFFER}`) — the text is never parsed as shell. A
///   line starting `!` runs as a plain shell command (a person's way out).
/// * `zle-line-init` (the prompt is back, ZLE owns the TTY again): when a
///   run was opened, its turn ends exactly once, by its exit status — the
///   plugin's Stop; else 130 is a reply-less interrupt (completed); else a
///   FAILED launch with the exit code (#404 P2-D). A run that never reported
///   its prompt gets it reported first, so the delivery is acknowledged.
///   Both go out after everything the plugin sent (the shared sequence).
///   Held lines are typed on that Stop and arrive as one bracketed paste.
/// * `precmd`: the run's vitals row (the plugin's `tmm/vitals`) is printed
///   once, just above the prompt, where `sniff_dsh` reads it (board #409).
/// * a run the previous shell left open (the window was killed or restarted
///   mid-turn) is ended at this shell's first prompt, as an interrupt: no
///   Stop would ever come for it, and its held lines would wait forever.
/// * `TMM_DSH_SESSION` (the launch line's resume dialect): unset = a fresh
///   conversation, `recent` = keep the recorded session, an id = that one.
/// * `tmm/new` (the app's `/new`): consumed by the next turn this shell
///   starts, which then has no `--session-id`; a resume id handed back by a
///   restart does not outrank it.
/// * Tab inserts itself: a delivered line is typed with send-keys, and a
///   literal tab must not run completion.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn zshrc(notify: &str) -> String {
    let notify = crate::shell::quote_always(notify);
    format!(
        r#"# Written by tmux-mobile — regenerated at every spawn and restart (board #404).
# The pane of a managed dsh agent: every line you type is a message to it,
# run as one resumed dsh turn; start a line with ! to run a shell command.
zmodload zsh/datetime zsh/zselect
PS1='{PROMPT_WAIT}'
PS2='… '
setopt NO_BANG_HIST INTERACTIVE_COMMENTS
unsetopt FLOW_CONTROL
HISTFILE=$ZDOTDIR/.zsh_history HISTSIZE=1000 SAVEHIST=1000
setopt INC_APPEND_HISTORY
bindkey '^I' self-insert
typeset -g _tmm_state=$DSH_HOME/tmm _tmm_notify={notify} _tmm_status=0
mkdir -p -- $_tmm_state
case ${{TMM_DSH_SESSION-}} in
  '') rm -f -- $_tmm_state/session ;;
  recent) ;;
  *) [[ $TMM_DSH_SESSION =~ '^session-[A-Za-z0-9-]+$' ]] && print -r -- $TMM_DSH_SESSION >| $_tmm_state/session ;;
esac
unset TMM_DSH_SESSION
rm -f -- $_tmm_state/ready
# A run the previous shell never finished — its window was killed or the
# agent restarted mid-turn — still owes its turn an end, or the lines held
# for that turn would wait for a Stop nobody sends: it is ended at this
# shell's first prompt, as an interrupt (the plugin's own Stop if it wrote one).
typeset -g _tmm_stale=0
[[ -e $_tmm_state/open ]] && _tmm_stale=1

# The recorded session, if dsh still has it.
_tmm_session() {{
  local sid= ; local -a seen
  [[ -r $_tmm_state/session ]] && sid=$(<$_tmm_state/session)
  [[ $sid =~ '^session-[A-Za-z0-9-]+$' ]] || return 0
  seen=($DSH_HOME/sessions/*/$sid(N/))
  (( $#seen )) && print -r -- $sid
}}

# One JSON string literal in REPLY.
_tmm_json() {{
  local s=$1
  s=${{s//\\/\\\\}}; s=${{s//\"/\\\"}}
  s=${{s//$'\n'/\\n}}; s=${{s//$'\r'/\\r}}; s=${{s//$'\t'/\\t}}
  s=${{s//[$'\x01'-$'\x1f']/}}
  REPLY="\"$s\""
}}

# Publish one numbered envelope, bounded: the helper's exit status IS the
# receipt (0 only once the envelope is in the inbox, TMM_HOOK_SEQ makes it
# say so); still running after 3 s it is killed. Non-zero = not published.
_tmm_publish() {{
  setopt local_options no_monitor no_notify
  local json=$1 seq=$2 pid i
  print -r -- $json | TMM_HOOK_SEQ=$seq /bin/sh -c $_tmm_notify >/dev/null 2>&1 &
  pid=$!
  for (( i = 0; i < 60; i++ )); do
    if ! kill -0 $pid 2>/dev/null; then
      wait $pid
      return
    fi
    zselect -t 5
  done
  # Past the bound: TERM, then KILL — a helper that ignores TERM cannot
  # hold the prompt either (review P2) — and reap it.
  kill $pid 2>/dev/null
  zselect -t 10
  kill -KILL $pid 2>/dev/null
  wait $pid 2>/dev/null
  return 1
}}

# Envelopes a killed publish left behind (tmm/unsent), oldest first, under
# their own numbers: sent before anything newer, so the order holds (a copy
# that did land after all is dropped by the inbox as not above its mark).
_tmm_resend() {{
  [[ -s $_tmm_state/unsent ]] || return 0
  local -a lines left; local json
  lines=("${{(@f)$(<$_tmm_state/unsent)}}")
  for json in $lines; do
    [[ -n $json ]] || continue
    if (( $#left )) || ! _tmm_publish $json ${{${{json#\{{\"tmm_seq\":}}%%[^0-9]*}}; then left+=($json); fi
  done
  if (( $#left )); then print -rl -- $left >| $_tmm_state/unsent; else rm -f -- $_tmm_state/unsent; fi
  (( ! $#left ))
}}

# Publish one envelope after everything the run's plugin sent: the sequence
# continues the plugin's (tmm/seq) and only rises, and rides the payload as
# tmm_seq (the inbox drops what is not above its high-water mark).
_tmm_send() {{
  local now last=0 json
  printf -v now '%.0f' $(( EPOCHREALTIME * 1000000 ))
  [[ -r $_tmm_state/seq ]] && last=$(<$_tmm_state/seq)
  [[ $last == <-> ]] || last=0
  (( now > last )) || now=$(( last + 1 ))
  print -r -- $now >| $_tmm_state/seq
  json="{{\"tmm_seq\":$now,${{1#\{{}}"
  if _tmm_resend && _tmm_publish $json $now; then return 0; fi
  print -r -- $json >> $_tmm_state/unsent
}}

_tmm_accept() {{
  # Whatever runs now owns the TTY until the next prompt.
  [[ -n ${{BUFFER//[[:space:]]/}} ]] && rm -f -- $_tmm_state/ready
  if [[ $BUFFER == '!'* ]]; then
    BUFFER=${{BUFFER#!}}
  elif [[ -n ${{BUFFER//[[:space:]]/}} ]]; then
    local sid=
    # The new conversation the app asked for (tmm/new) is consumed HERE, by the
    # turn it applies to: it outranks the session the previous shell recorded
    # and a resume id a restart handed back (TMM_DSH_SESSION wrote it above).
    if [[ -e $_tmm_state/new ]]; then rm -f -- $_tmm_state/session $_tmm_state/new; else sid=$(_tmm_session); fi
    rm -f -- $_tmm_state/prompted $_tmm_state/stop.json $_tmm_state/vitals
    print -rn -- $BUFFER >| $_tmm_state/line
    BUFFER="dsh --profile {PROFILE}${{sid:+ --session-id $sid}} -- ${{(q+)BUFFER}}"
    : >| $_tmm_state/open
  fi
  zle .accept-line
}}
zle -N accept-line _tmm_accept

# The run's vitals row, printed once just above the prompt (the card reads it
# there, board #409).
_tmm_status_of_run() {{
  _tmm_status=$?
  PS1='{PROMPT_WAIT}'
  if [[ -r $_tmm_state/vitals ]]; then
    print -r -- "$(<$_tmm_state/vitals)"
    rm -f -- $_tmm_state/vitals
  fi
}}
precmd_functions=(_tmm_status_of_run $precmd_functions)

# The prompt is back: end the run's turn, exactly once. The plugin's own Stop
# when it wrote one; else exit 130 (Escape, ^C) is an interrupt — completed,
# no reply — and any other end without a Stop is a FAILED launch (dsh missing,
# a bad profile, a crash), with no invented reply. A run that never reported
# its prompt reports it here first, so the delivery is acknowledged.
# zsh turns bracketed paste on only AFTER zle-line-init returns (measured on
# zsh 5.9: a paste landing inside the hook was split into one line per turn), so
# the ready work runs from a one-shot fd handler, which ZLE calls once it is
# waiting for input — paste on, the TTY its own.
_tmm_init() {{
  local fd
  exec {{fd}}</dev/null
  zle -F -w $fd _tmm_ready
}}
zle -N zle-line-init _tmm_init

_tmm_ready() {{
  local fd=$1
  zle -F $fd
  exec {{fd}}<&-
  # The shell is ready for a typed line, and says so first — naming itself,
  # so a file this shell outlives is never believed.
  print -r -- "$$ ${{TMUX_PANE-}}" >| $_tmm_state/ready
  PS1='{PROMPT}'
  zle reset-prompt
  [[ -e $_tmm_state/open ]] || return 0
  local st=$_tmm_status sid=$(_tmm_session) line= payload
  (( _tmm_stale )) && st=130 _tmm_stale=0
  if [[ ! -e $_tmm_state/prompted ]]; then
    [[ -r $_tmm_state/line ]] && IFS= read -r -d '' line < $_tmm_state/line
    _tmm_json $line
    _tmm_send '{{"hook_event_name":"UserPromptSubmit","session_id":"'$sid'","prompt":'$REPLY'}}'
  fi
  if [[ -r $_tmm_state/stop.json ]]; then
    payload=$(<$_tmm_state/stop.json)
  elif (( st == 130 )); then
    payload='{{"hook_event_name":"Stop","session_id":"'$sid'","last_assistant_message":"","dsh_reason":"interrupted"}}'
  else
    payload='{{"hook_event_name":"Stop","session_id":"'$sid'","last_assistant_message":"","dsh_reason":"error","dsh_exit":'$st'}}'
  fi
  rm -f -- $_tmm_state/open $_tmm_state/prompted $_tmm_state/line $_tmm_state/stop.json
  _tmm_send $payload
}}
zle -N _tmm_ready
"#
    )
}

/// Write every file this backend owns in `home` that depends only on the
/// notify helper: the plugin and the shell. Shared by render and refresh;
/// true when a file changed.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_runtime(home: &Path, notify: &str) -> Result<bool, String> {
    let plugin = home.join("dsh").join("plugins").join(PLUGIN_NAME);
    let zsh = home.join("zsh");
    std::fs::create_dir_all(&plugin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&zsh).map_err(|e| e.to_string())?;
    let mut changed = false;
    for (path, text) in [
        (plugin.join("index.mjs"), plugin_js(notify)),
        (plugin.join("package.json"), plugin_package_json()),
        (zsh.join(".zshenv"), zshenv().to_string()),
        (zsh.join(".zshrc"), zshrc(notify)),
    ] {
        if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
            shared::write_owned(&path, Some(&text))?;
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_dsh(
    def: &RegAgent, _name: &str, home: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    let dsh_home = home.join("dsh");
    let profile = dsh_home.join("profiles").join(PROFILE);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    write_runtime(home, &notifications.helper_command("dsh"))?;

    let entry = dsh_home.join("plugins").join(PLUGIN_NAME).join("index.mjs");
    shared::write_owned(&profile.join("package.json"), Some(profile_package_json()))?;
    shared::write_owned(&profile.join("pnpm-workspace.yaml"), Some(profile_workspace_yaml()))?;
    shared::write_owned(&profile.join("cordis.yml"), Some(profile_cordis_yml()))?;
    let mcp = mcp_rows(&crate::projects::spawn::mcp_defs(def))?;
    let skill_root = skill_root(&dsh_home);
    write_skill_root(&skill_root, skills)?;
    shared::write_atomic(&profile.join("cordis.patch.yml"), &profile_patch_yml(&entry, &def.model, &def.effort, &mcp, &skill_root))?;

    // The prompt is the harness home's user-global AGENTS.md (dsh-agent-
    // instructions reads `$DSH_HOME/AGENTS.md` first); DSH_AGENTS_HOME points
    // at the same home, so the user's own `~/.agents/AGENTS.md` stays out.
    // The skills are announced by dsh's own catalog (board #412).
    shared::write_owned(&dsh_home.join("AGENTS.md"), Some(system_prompt))?;

    let dsh = dsh_home.to_string_lossy().to_string();
    Ok(Rendered {
        env: vec![
            ("DSH_HOME".into(), dsh.clone()),
            ("DSH_AGENTS_HOME".into(), dsh),
            ("ZDOTDIR".into(), home.join("zsh").to_string_lossy().to_string()),
            // The shipped config's own switches: unattended (sandbox off,
            // approval never — headless cannot ask), and the OTel session
            // telemetry row removed (any non-empty value opts out, board
            // #408). The two request fields are off in the profile patch.
            ("DSH_PERMISSION_MODE".into(), "danger-full-access".into()),
            ("DSH_TELEMETRY_DISABLED".into(), "1".into()),
        ],
        // `exec`: no outer shell remains for a chat line to fall through to
        // when the managed shell dies (review P1-A2).
        cmd: LAUNCH.into(),
        // No first-use dialog: the empty marker list is "accepted" at once
        // with no keys; readiness is the shell's prompt.
        confirmation: Some(shared::StartupConfirmation {
            markers: Vec::new(),
            ready_markers: vec![READY_MARKER],
            accept_keys: Vec::new(),
            timeout: std::time::Duration::from_secs(60),
        }),
    })
}

/// Re-render ONLY the profile's patch layer in a home that already has its
/// profile (board #411), from the definition: the model and the effort, and
/// with them the rest of that one document — the definition's MCP rows and
/// the skill provider's root (board #412), which a live write must carry, not
/// drop. Every dsh turn is a fresh process that reads the profile, so this is
/// all a model or effort change needs for the NEXT turn: no restart, no other
/// file rewritten under a running agent (the skill root's links are the
/// render's). The patch is replaced whole (`write_atomic`). `NoConfig` when the
/// home has no profile (never rendered): nothing was written, and nothing is
/// known about what the agent runs; `AlreadyCurrent` when the text is right.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn write_profile_patch(home: &Path, def: &RegAgent) -> Result<super::LiveWrite, String> {
    use super::LiveWrite;
    let dsh_home = home.join("dsh");
    let profile = dsh_home.join("profiles").join(PROFILE);
    if !profile.is_dir() {
        return Ok(LiveWrite::NoConfig);
    }
    let entry = dsh_home.join("plugins").join(PLUGIN_NAME).join("index.mjs");
    let mcp = mcp_rows(&crate::projects::spawn::mcp_defs(def))?;
    let text = profile_patch_yml(&entry, &def.model, &def.effort, &mcp, &skill_root(&dsh_home));
    let path = profile.join("cordis.patch.yml");
    if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
        return Ok(LiveWrite::AlreadyCurrent);
    }
    shared::write_atomic(&path, &text)?;
    Ok(LiveWrite::Written)
}

/// Whether `home` was rendered for dsh (it has the `dsh` directory).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn has_rendered_files(home: &Path) -> bool {
    home.join("dsh").is_dir()
}

/// `/new`: the NEXT turn starts a new conversation, durably (board #411
/// review). The marker `tmm/new` IS the command-side commit, and the only thing
/// the command writes: the managed shell consumes it when it starts the next
/// turn (`_tmm_accept`), removes the recorded session itself and starts the run
/// with no `--session-id`, whatever was recorded or a restart handed back as
/// `TMM_DSH_SESSION`. The command never deletes `tmm/session` after
/// publishing: a shell that consumed the marker meanwhile, and a plugin that
/// recorded the FRESH id, would otherwise lose it to a late delete and the turn
/// after would start fresh again. The old session stays on disk under dsh's
/// `sessions/`. `true` when there was a recorded session to leave.
///
/// REFUSED while a turn runs (`tmm/open` exists from the shell's accept to its
/// prompt): the running turn's plugin records its session when its first event
/// arrives, which could land after the command and be taken for the new
/// conversation; refusing removes that race instead of racing it. The caller
/// sends `/new` again when the prompt is back.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn new_conversation(home: &Path) -> Result<bool, String> {
    let state = home.join("dsh").join("tmm");
    if state.join("open").exists() {
        return Err("a turn is running: wait for it to end, then send /new again".into());
    }
    std::fs::create_dir_all(&state).map_err(|e| e.to_string())?;
    let had = state.join("session").exists();
    shared::write_atomic(&state.join("new"), "")?;
    Ok(had)
}

/// The dsh half of `refresh_hooks`: the plugin and the shell are generated
/// files, rewritten whole when this build's text differs (omp's rule).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> bool {
    if !home.join("dsh").join("profiles").join(PROFILE).is_dir() {
        return false;
    }
    write_runtime(home, notify).unwrap_or(false)
}

/// Is this managed home's shell at its prompt, ready for a typed line (board
/// #404 review)? The shell's own fact: `zle-line-init` writes `tmm/ready`
/// once ZLE owns the TTY (bracketed paste on), and `accept-line` removes it
/// before running anything. The run between owns the TTY raw, so delivery
/// types into this pane only while the file exists — an app-side end edge
/// (an interrupt) or a lost Stop is never taken for readiness.
///
/// The file names its owner — the managed shell's pid — and is believed only
/// when that pid is the LIVE input owner (review P1-A2): alive, and the
/// pane's own process (`pane_pid`; the managed zsh replaced the pane's shell
/// at launch). A file a dead shell left behind, or one naming any other
/// process, is never a ready pane. Alive excludes a ZOMBIE (board #413): a
/// killed shell its parent has not reaped yet still answers signal 0, but it
/// can read nothing — see `owns_input`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn input_ready(home: &Path, pane_pid: Option<u32>) -> bool {
    let Ok(text) = std::fs::read_to_string(home.join("dsh").join("tmm").join("ready")) else { return false };
    let Some(pid) = text.split_whitespace().next().and_then(|p| p.parse::<i32>().ok()).filter(|p| *p > 1) else { return false };
    if pane_pid != Some(pid as u32) {
        return false;
    }
    owns_input(pid)
}

/// Can process `pid` still read its TTY: it exists and is not a zombie (board
/// #413). Signal 0 answers "exists" for a zombie too. That is the INFERRED
/// cause of the one `the_pane_ends_…` failure in 17 runs (not captured with
/// a `Z` state): tmux closes a pane on its pty's EOF, which can come before
/// the SIGCHLD that reaps the shell, so for a moment the pane is gone and its
/// killed shell is still in the process table. The state comes from
/// `/proc/<pid>/stat` (the field after the `)` that ends the command name,
/// which may itself hold spaces or parens), else from `ps -o stat=` where
/// there is no /proc (macOS) — the same two doors as tmm's `parent_pid`.
/// Anything not read cleanly is UNKNOWN, and unknown is not live. Out of
/// scope: a pid reused by a new process, and a death right after the check.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn owns_input(pid: i32) -> bool {
    // Signal 0 only asks whether the process exists (EPERM: it does).
    let exists = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !exists {
        return false;
    }
    let state = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().next()).map(str::to_string),
        // A /proc without this pid: it went between the two questions.
        Err(_) if Path::new("/proc/self/stat").exists() => return false,
        Err(_) => ps_state(std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().ok()),
    };
    owner_verdict(state.as_deref())
}

/// The owner question's answer from what was observed: a live state is an
/// owner; a zombie, a dead task, no observation or a word that is not a state
/// is not — unknown is never taken for live.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn owner_verdict(state: Option<&str>) -> bool {
    state.and_then(state_is_live).unwrap_or(false)
}

/// `ps -o stat=`'s answer for one pid, or `None` when there is no clean one:
/// ps failed, or printed anything but one state word.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn ps_state(out: Option<std::process::Output>) -> Option<String> {
    let out = out.filter(|o| o.status.success())?;
    let text = String::from_utf8(out.stdout).ok()?;
    let mut words = text.split_whitespace();
    let word = words.next()?;
    words.next().is_none().then(|| word.to_string())
}

/// A process state word: `/proc/<pid>/stat` field 3 (one letter), or ps's
/// `stat` (the letter, then flags: `Ss+`, `Z+`). `Some(false)` for a zombie
/// (`Z`) or a dead task (`X`, older kernels `x`), `Some(true)` for any other
/// KNOWN state letter followed only by known flags, and `None` for anything
/// else — `ERROR` or a `STAT` header is a word, not a state. The letters are
/// Linux's (`proc(5)`: R S D Z T t X x K W P I) and macOS's `U`; the flags
/// are procps's (`< N L s l +`) and macOS ps's (`> A E S V W X`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn state_is_live(word: &str) -> Option<bool> {
    const STATES: &[char] = &['R', 'S', 'D', 'Z', 'T', 't', 'X', 'x', 'K', 'W', 'P', 'I', 'U'];
    const FLAGS: &[char] = &['<', 'N', 'L', 's', 'l', '+', '>', 'A', 'E', 'S', 'V', 'W', 'X'];
    let mut chars = word.chars();
    let first = chars.next().filter(|c| STATES.contains(c))?;
    if !chars.all(|c| FLAGS.contains(&c)) {
        return None;
    }
    Some(!matches!(first, 'Z' | 'X' | 'x'))
}

/// dsh resume dialect, read by the managed shell at start: an exact id, or
/// `recent` for the session the home last recorded.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    match id {
        Some(id) => format!("TMM_DSH_SESSION={} {cmd}", crate::shell::quote(id)),
        None => format!("TMM_DSH_SESSION=recent {cmd}"),
    }
}

/// No prompt hook echoes a command: a line is a task for one headless turn.
pub(crate) fn command_echo(_name: &str, _args: &str) -> Option<String> {
    None
}

/// A running dsh agent re-reads its profile at the start of every turn (each
/// turn is a fresh process), so a saved model or effort reaches it without a
/// restart (board #411). `registry_save` projects the definition into the
/// running homes on this word.
pub(crate) const CONFIG_READ_EVERY_TURN: bool = true;

/// The slash commands the APP runs for a dsh agent (board #411). dsh-headless
/// has none (`dsh-commands`, `dsh-command-compact` and `dsh-command-goal` serve
/// its UI clients; a `/word` typed into the pane is just a task string for the
/// model), so `hub_command` does not type these into the pane: it changes the
/// agent's definition, or asks for a new conversation, and the NEXT turn — a
/// fresh process that reads the profile and the recorded session — is the
/// changed one. `None` for anything else: typed verbatim as before. A
/// `Some(Err)` is the command's own usage error, refused to the caller.
///
/// `/compact` is NOT here, on purpose: `dsh-command-compact` calls
/// `ctx.compaction.compactNow(agent, …)` with the running AGENT of a live
/// process and fails with "the agent is not idle" otherwise. A headless turn
/// is one process that starts a model turn the moment it has a task; between
/// turns no process exists to compact, and a plugin cannot call it from inside
/// a run without racing the turn it is part of. dsh compacts under context
/// pressure by itself (`compaction-basic`'s automatic trigger).
pub(crate) fn app_command(name: &str, args: &str) -> Option<Result<super::AppCommand, String>> {
    let args = args.trim();
    let one = |what: &str| -> Result<String, String> {
        if args.is_empty() || args.split_whitespace().count() != 1 {
            Err(format!("usage: {name} <{what}>"))
        } else {
            Ok(args.to_string())
        }
    };
    match name {
        "/model" => Some(one("model").map(super::AppCommand::Model)),
        "/effort" => Some(one("off|low|high|max").map(super::AppCommand::Effort)),
        "/new" => Some(if args.is_empty() { Ok(super::AppCommand::NewConversation) } else { Err("usage: /new".to_string()) }),
        _ => None,
    }
}

/// Model ids the deepseek-official route lists in its own catalog (dsh-llm-
/// deepseek 0.2.0-rc.2 README: "omitted `models` advertises … `deepseek-flash`
/// alongside … `deepseek-v4-pro`"). Advisory only: "the model id passes through
/// to the wire, so new DeepSeek models need no re-registration", so any id of
/// `model_id_error` allows and the palette just offers these two.
pub(crate) fn known_models() -> &'static [&'static str] {
    &["deepseek-flash", "deepseek-v4-pro"]
}

/// The syntax a model id must have, checked at the SHARED validation door
/// (`models::validate`, so the editor, `tmm registry save`, a team member and
/// `/model` agree): one token of letters, digits and `._:/-`, at most 100 long.
/// The route passes the id to the wire and nothing here parses it, so no list
/// is consulted (`models_fetch` is `None`: dsh has nothing to ask without a
/// request).
pub(crate) fn model_id_error(model: &str) -> Option<String> {
    let ok = model.len() <= 100 && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'));
    (!ok).then(|| format!("'{model}' is not a dsh model id (letters, digits and . _ : / - only, at most 100)"))
}

/// Detection row (board #129): `dsh` runs as `node …/bin/dsh`. An unmanaged
/// pane relaunches the web UI, dsh's own interactive front end; there is no
/// conversation to resume from a bare pane.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "dsh",
        programs: &["dsh"],
        launch: "dsh web",
        resume_recent: None,
        resume_id: None,
        versioned_binary_dir: None,
    }
}

/// dsh paints no status furniture of its own, so the managed shell paints
/// ours: the vitals row the plugin built from dsh's own events, printed once
/// above the prompt after every run (board #409). It is the LAST COMPLETED
/// RUN's input, not a live figure: nothing is painted while a run lasts. The
/// NEWEST row wins (read bottom-up), and only one that starts at column zero
/// with `VITALS_ANCHOR` (see there for what that does not exclude).
/// The percentage comes from `vitals::used_pct`, the one formula for a
/// backend that reports token counts. No effort: dsh's levels (`off`…) are
/// not the card's effort words, and the row does not carry one.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_dsh(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    let Some(row) = pane.lines().rev().take(24).find(|l| {
        l.strip_prefix(VITALS_ANCHOR).is_some_and(|rest| rest.starts_with(" · "))
    }) else {
        return v;
    };
    let segs: Vec<&str> = row.trim_end().split(" · ").collect();
    v.model = segs.get(1).map(|m| m.trim()).filter(|m| !m.is_empty() && !m.starts_with("ctx ")).map(str::to_string);
    v.context_pct = segs.iter().skip(2).find_map(|seg| {
        let (used, window) = seg.trim().strip_prefix("ctx ")?.split_once('/')?;
        crate::projects::vitals::used_pct(used.parse().ok()?, window.parse().ok()?)
    });
    v
}

/// The payload dialect our plugin and shell write: claude's keys. `Stop`
/// ends every turn — completed, interrupted (no reply), or an error
/// (`dsh_reason: "error"`: a failed request, the missing key).
pub(crate) fn normalize_kind(payload: &serde_json::Map<String, Value>) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    match event.as_deref() {
        Some("Stop") => match crate::agent_notifications::string_field(payload, &["dsh_reason"]).as_deref() {
            Some("error") => Ok("failed"),
            _ => Ok("completed"),
        },
        _ => Err("unsupported dsh event".into()),
    }
}

pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload.get("hook_event_name").and_then(Value::as_str) == Some("UserPromptSubmit")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::backends::LiveWrite;
    use serde_json::json;

    #[test]
    fn hook_dialect_is_claudes_and_every_stop_ends_the_turn() {
        let kind = |v: Value| normalize_kind(v.as_object().unwrap());
        assert_eq!(kind(json!({"hook_event_name":"Stop","last_assistant_message":"pong","dsh_reason":"completed"})), Ok("completed"));
        assert_eq!(kind(json!({"hook_event_name":"Stop","last_assistant_message":"","dsh_reason":"interrupted"})), Ok("completed"), "a killed run ends its turn");
        assert_eq!(kind(json!({"hook_event_name":"Stop","dsh_reason":"error"})), Ok("failed"));
        assert_eq!(kind(json!({"hook_event_name":"Stop","dsh_reason":"error","dsh_exit":127})), Ok("failed"), "a failed launch");
        for other in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart"] {
            assert!(kind(json!({"hook_event_name": other})).is_err(), "{other}");
        }
        assert!(is_user_prompt_submit(&json!({"hook_event_name":"UserPromptSubmit","prompt":"hi"})));
        assert!(!is_user_prompt_submit(&json!({"hook_event_name":"Stop"})));
    }

    #[test]
    fn resume_dialect_is_read_by_the_shell() {
        assert_eq!(resume_command("exec zsh -i", Some("session-ab12")), "TMM_DSH_SESSION=session-ab12 exec zsh -i");
        assert_eq!(resume_command("exec zsh -i", None), "TMM_DSH_SESSION=recent exec zsh -i");
        assert_eq!(resume_command("exec zsh -i", Some("x y")), "TMM_DSH_SESSION='x y' exec zsh -i", "quoted; the shell then refuses a non-id");
    }

    #[test]
    fn the_patch_holds_the_model_the_plugin_and_no_title_request() {
        let entry = Path::new("/ws/.tmm/agents/d1/dsh/plugins/tmm-telemetry/index.mjs");
        let root = Path::new("/ws/.tmm/agents/d1/dsh/tmm/skills");
        let patch = profile_patch_yml(entry, "", "", "", root);
        assert!(patch.contains("    model: \"deepseek-flash\"\n"), "empty = the route's shipped default\n{patch}");
        assert!(patch.contains("    provider: \"deepseek-official\"\n"));
        assert!(!patch.contains("reasoningEffort"), "empty effort = dsh's default");
        assert!(patch.contains("      name: \"/ws/.tmm/agents/d1/dsh/plugins/tmm-telemetry/index.mjs\"\n"));
        assert!(patch.contains("        requireEnv: \"DEEPSEEK_API_KEY\"\n"));
        assert!(patch.contains("- id: session-title-llm\n  disabled: true\n"));
        // Board #408: nothing but the model request leaves the machine.
        assert!(patch.contains("- id: session-log-deepseek\n  config:\n    enabled: false\n"), "{patch}");
        assert!(patch.contains("- id: plugin-package-inventory-deepseek\n  config:\n    enabled: false\n"), "{patch}");
        let pinned = profile_patch_yml(entry, " deepseek-v4-pro ", "max", "", root);
        assert!(pinned.contains("    model: \"deepseek-v4-pro\"\n    reasoningEffort: \"max\"\n"), "{pinned}");
        let odd = profile_patch_yml(entry, "a\"b: c", "", "", root);
        assert!(odd.contains("    model: \"a\\\"b: c\"\n"), "a value is one JSON string, never YAML syntax");
        // Board #412: the skill provider scans the agent's own root only.
        assert!(patch.contains("- id: skill-filesystem\n  config:\n    customSkillDirs: [\"/ws/.tmm/agents/d1/dsh/tmm/skills\"]\n    includeDefaultRoots: false\n"), "{patch}");
    }

    /// A dsh definition with only a model and an effort (board #411's tests).
    fn model_def(model: &str, effort: &str) -> RegAgent {
        serde_json::from_value(json!({"name": "d1", "backend": "dsh", "model": model, "effort": effort})).unwrap()
    }

    /// A loopback stand-in for the DeepSeek Messages API (boards #408,
    /// #412): records each request (its first line and JSON body) and
    /// answers the n-th with `script[n]` — `Some((tool, input))` = one
    /// tool call — or, past the script, with the text "OK". A fake key and
    /// `DEEPSEEK_BASE_URL` point a real dsh at it: zero model calls.
    pub(crate) fn messages_stand_in(script: Vec<(String, Value)>) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { return };
                let mut reader = std::io::BufReader::new(conn.try_clone().unwrap());
                let (mut first, mut len) = (String::new(), 0usize);
                reader.read_line(&mut first).unwrap();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let n = {
                    let mut log = log.lock().unwrap();
                    log.push((first.trim().to_string(), serde_json::from_slice(&body).unwrap_or(Value::Null)));
                    log.len() - 1
                };
                let ev = |t: &str, d: Value| format!("event: {t}\ndata: {d}\n\n");
                let start = ev("message_start", json!({"type":"message_start","message":{"id":format!("m{n}"),"type":"message","role":"assistant","model":"deepseek-flash","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}));
                let sse = match script.get(n) {
                    Some((tool, input)) => [
                        start,
                        ev("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":format!("call_{n}"),"name":tool,"input":{}}})),
                        ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}})),
                        ev("content_block_stop", json!({"type":"content_block_stop","index":0})),
                        ev("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}})),
                        ev("message_stop", json!({"type":"message_stop"})),
                    ]
                    .concat(),
                    None => [
                        start,
                        ev("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
                        ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}})),
                        ev("content_block_stop", json!({"type":"content_block_stop","index":0})),
                        ev("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}})),
                        ev("message_stop", json!({"type":"message_stop"})),
                    ]
                    .concat(),
                };
                let _ = write!(conn, "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}", sse.len());
            }
        });
        (port, seen)
    }

    /// Board #412, through the REAL dsh against the stand-in (zero model
    /// calls): an agent whose definition names one stdio MCP server and one
    /// skill gets them NATIVELY. The server's tool is in the request's tool
    /// list as `mcp__echo__echo` and a call reaches the server; the skill is
    /// in dsh's own catalog and the `skill` tool returns its body; the
    /// prompt (AGENTS.md) carries no second skills index; the owner's
    /// `~/.agents/skills` stays out (`includeDefaultRoots: false`).
    #[test]
    fn the_managed_profile_gives_dsh_native_mcp_tools_and_skills() {
        let (Some(dsh), Some(node)) = (which("dsh"), which("node")) else {
            eprintln!("skipped: no dsh or node on PATH");
            return;
        };
        let ws = std::env::temp_dir().join(format!("tmm-dsh-412-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/d1");
        std::fs::create_dir_all(&home).unwrap();
        let server = ws.join("echo.mjs");
        std::fs::write(&server, MCP_ECHO).unwrap();
        let mcp_log = ws.join("mcp.jsonl");
        let http_log = ws.join("http.jsonl");
        // The Streamable HTTP server, started first: its url names its port.
        let port_file = ws.join("http.port");
        // Killed when the test ends, however it ends, and holding none of the
        // test's own pipes (a leftover child would keep cargo's output open).
        struct KillOnDrop(std::process::Child);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _http_server = KillOnDrop(
            std::process::Command::new(&node)
                .arg(&server)
                .args(["--http", &port_file.to_string_lossy()])
                .env("MCP_LOG", &http_log)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_for("the HTTP MCP server", 10, || std::fs::read_to_string(&port_file).is_ok_and(|p| !p.is_empty()));
        let http_port = std::fs::read_to_string(&port_file).unwrap();
        // A literal that LOOKS like code, with quotes and a newline: it must
        // arrive as text, never be evaluated.
        let lit = "!!js process.exit(7) \" ' ${NOT_A_REF}\nsecond line";
        let header_lit = "!!js process.exit(7) \" '";
        let skill = ws.join("lib/hello-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: hello-skill\ndescription: Greet in the special way.\n---\n\nSay HELLO-412.\n").unwrap();
        // A skill in a default root (the project's `.agents/skills`; the
        // cwd has no .git, so it is the project root) that must NOT be seen.
        std::fs::create_dir_all(ws.join(".agents/skills/owner-skill")).unwrap();
        std::fs::write(ws.join(".agents/skills/owner-skill/SKILL.md"), "---\nname: owner-skill\ndescription: The owner's own.\n---\n").unwrap();
        let def: RegAgent = serde_json::from_value(json!({
            "name": "d1", "backend": "dsh",
            "mcp": json!([
                {"name": "echo", "command": node.to_string_lossy(), "args": [server.to_string_lossy()], "env": {"MCP_LOG": mcp_log.to_string_lossy(), "REF": "${TMM_412_REF}", "LIT": lit}},
                {"name": "web", "url": format!("http://127.0.0.1:{http_port}/mcp"), "headers": {"Authorization": "Bearer ${TMM_412_TOKEN}", "X-Lit": header_lit}},
            ]).to_string(),
        }))
        .unwrap();
        let skills = vec![crate::projects::skills::ResolvedSkill { name: "hello-skill".into(), dir: skill.clone(), description: "Greet in the special way.".into() }];
        let r = render_dsh(&def, "d1", &home, "You are d1.", &skills).unwrap();
        assert_eq!(std::fs::read_to_string(home.join("dsh/AGENTS.md")).unwrap(), "You are d1.", "no second skills index");
        let script = vec![
            ("mcp__echo__echo".to_string(), json!({"text": "hi"})),
            ("mcp__web__echo".to_string(), json!({"text": "over http"})),
            ("skill".to_string(), json!({"name": "hello-skill"})),
        ];
        let (port, seen) = messages_stand_in(script);
        let mut cmd = std::process::Command::new(&dsh);
        cmd.args(["--profile", PROFILE, "--", "use the echo tool, then the skill"])
            .current_dir(&ws)
            .env_clear()
            .env("HOME", &ws)
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("DEEPSEEK_API_KEY", "not-a-key")
            .env("DEEPSEEK_BASE_URL", format!("http://127.0.0.1:{port}"))
            .env("TMM_412_REF", "ref-412")
            .env("TMM_412_TOKEN", "tok-412")
            .stdin(std::process::Stdio::null());
        for (k, v) in &r.env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 4, "two tool calls, the skill call, the answer");
        // The references were read from the launch env; the literals arrived
        // byte for byte (the stdio child's env, the HTTP request's headers).
        let logged = |f: &Path| std::fs::read_to_string(f).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).collect::<Vec<_>>();
        let stdio_env = logged(&mcp_log).into_iter().find_map(|e| e.get("env").cloned()).unwrap();
        assert_eq!(stdio_env, json!({"REF": "ref-412", "LIT": lit}));
        let headers: Vec<Value> = logged(&http_log).into_iter().filter_map(|e| e.get("headers").cloned()).collect();
        assert!(!headers.is_empty() && headers.iter().all(|h| *h == json!({"authorization": "Bearer tok-412", "x-lit": header_lit})), "{headers:?}");
        assert!(logged(&http_log).iter().any(|e| e["method"] == "tools/call"), "the HTTP call reached its server");
        assert!(seen[2].1["messages"].to_string().contains("echo: over http"));
        let tools: Vec<String> = seen[0].1["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert!(tools.iter().any(|t| t == "mcp__echo__echo") && tools.iter().any(|t| t == "mcp__web__echo"), "{tools:?}");
        assert!(tools.iter().any(|t| t == "skill"), "{tools:?}");
        let first = seen[0].1["messages"].to_string();
        assert!(first.contains("hello-skill") && first.contains("Greet in the special way."), "dsh's catalog announces the skill");
        assert!(!first.contains("owner-skill"), "the owner's skills stay out");
        assert!(std::fs::read_to_string(&mcp_log).unwrap().contains("\"tools/call\""), "the call reached the server");
        assert!(seen[1].1["messages"].to_string().contains("echo: hi"), "the tool result came back");
        assert!(seen[3].1["messages"].to_string().contains("Say HELLO-412."), "the skill body was loaded");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #412: the agent's skill root is exactly its definition's skills,
    /// rebuilt at every render — a skill dropped from the definition has no
    /// link left, not even a dangling one — and each SKILL.md is checked the
    /// way dsh reads it: a bundle dsh would skip is refused with the reason,
    /// and its file is left exactly as it was.
    #[test]
    fn the_skill_root_is_the_definitions_skills_and_odd_ones_are_refused() {
        let ws = std::env::temp_dir().join(format!("tmm-dsh-skills-{}", uuid::Uuid::new_v4()));
        let root = ws.join("root");
        let sk = |dir: &str, front: &str| {
            let d = ws.join(dir);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), format!("---\n{front}---\n\nBody.\n")).unwrap();
            crate::projects::skills::ResolvedSkill { name: dir.into(), dir: d, description: "from the index".into() }
        };
        let re = |x: &crate::projects::skills::ResolvedSkill| crate::projects::skills::ResolvedSkill { name: x.name.clone(), dir: x.dir.clone(), description: x.description.clone() };
        let a = sk("a-dir", "name: a-1\ndescription: one\nuser-invocable: \"off\"\ndisable-model-invocation: 1.0\n");
        let b = sk("b", "name: b\ndescription: two\n");
        write_skill_root(&root, &[re(&a), re(&b)]).unwrap();
        assert_eq!(std::fs::read_link(root.join("a-1")).unwrap(), ws.join("a-dir"), "linked under dsh's catalog name, not the folder's");
        write_skill_root(&root, &[re(&b)]).unwrap();
        assert!(root.join("a-1").symlink_metadata().is_err(), "revoked: no link left, dangling or not");
        assert!(root.join("b").symlink_metadata().unwrap().file_type().is_symlink());
        let cases = [
            ("no-name", "description: no name here\n", "needs a `name`"),
            ("no-desc", "name: no-desc\n", "needs a `description`"),
            ("upper", "name: Upper\ndescription: x\n", "is not lowercase"),
            ("double", "name: a--b\ndescription: x\n", "is not lowercase"),
            ("legacy", "name: legacy\ndescription: x\nuserInvocable: true\n", "unsupported"),
            ("policy", "name: policy\ndescription: x\nuser-invocable: maybe\n", "must be a boolean"),
            ("policy2", "name: policy2\ndescription: x\ndisable-model-invocation: 2\n", "must be a boolean"),
        ];
        for (dir, front, why) in cases {
            let bad = sk(dir, front);
            let before = std::fs::read_to_string(bad.dir.join("SKILL.md")).unwrap();
            let err = write_skill_root(&root, &[re(&b), re(&bad)]).unwrap_err();
            assert!(err.contains(why) && err.contains(dir), "{dir}: {err}");
            assert_eq!(std::fs::read_to_string(bad.dir.join("SKILL.md")).unwrap(), before, "{dir}: never rewritten");
        }
        std::fs::create_dir_all(ws.join("bare")).unwrap();
        std::fs::write(ws.join("bare/SKILL.md"), "no frontmatter\n").unwrap();
        assert!(dsh_skill_name(&ws.join("bare")).unwrap_err().contains("does not open"));
        std::fs::write(ws.join("bare/SKILL.md"), "---\nname: x\n").unwrap();
        assert!(dsh_skill_name(&ws.join("bare")).unwrap_err().contains("not closed"));
        // One CR before a delimiter's newline is stripped, as dsh does; two
        // are not, so that file is no frontmatter to dsh either.
        std::fs::write(ws.join("bare/SKILL.md"), "---\r\nname: crlf\r\ndescription: x\r\n---\r\n").unwrap();
        assert_eq!(dsh_skill_name(&ws.join("bare")).unwrap(), "crlf");
        std::fs::write(ws.join("bare/SKILL.md"), "---\r\r\nname: cr2\ndescription: x\n---\n").unwrap();
        assert!(dsh_skill_name(&ws.join("bare")).unwrap_err().contains("does not open"));
        std::fs::write(ws.join("bare/SKILL.md"), "---\nname: cr2\ndescription: x\n---\r\r\n").unwrap();
        assert!(dsh_skill_name(&ws.join("bare")).unwrap_err().contains("not closed"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// An MCP server in one file, one tool `echo`: stdio (newline-delimited
    /// JSON-RPC), or Streamable HTTP with `--http <port file>` (JSON
    /// responses). It logs its `REF`/`LIT` environment at start, each
    /// request's `authorization`/`x-lit` headers, and every method, to
    /// `$MCP_LOG`.
    const MCP_ECHO: &str = r#"import fs from 'node:fs'
import http from 'node:http'
import readline from 'node:readline'
const log = (m) => process.env.MCP_LOG && fs.appendFileSync(process.env.MCP_LOG, JSON.stringify(m) + '\n')
const answer = (m) => {
  log({ method: m.method })
  if (m.id === undefined) return undefined
  if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } }
  if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } }
  if (m.method === 'tools/call') return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + (m.params?.arguments?.text ?? '') }] } }
  if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }
}
log({ env: { REF: process.env.REF ?? null, LIT: process.env.LIT ?? null } })
const at = process.argv.indexOf('--http')
if (at < 0) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    const r = answer(m)
    if (r) process.stdout.write(JSON.stringify(r) + '\n')
  })
} else {
  const server = http.createServer((req, res) => {
    log({ headers: { authorization: req.headers['authorization'] ?? null, 'x-lit': req.headers['x-lit'] ?? null } })
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let m
      try { m = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      const out = (Array.isArray(m) ? m : [m]).map(answer).filter(Boolean)
      if (!out.length) { res.writeHead(202).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(m) ? out : out[0]))
    })
  })
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[at + 1], String(server.address().port)))
}
"#;

    /// Board #408, through the REAL dsh when one is installed, against a
    /// loopback stand-in for the Messages API (a fake key; zero model
    /// calls): a run of the rendered managed profile sends ONE request, the
    /// model request, with neither of dsh's default-on extra fields —
    /// `dsh_session_log` (the session's events, tool results included) and
    /// `dsh_plugin_packages` (the plugin inventory). Measured on 0.2.0-rc.2:
    /// the shipped headless profile sends both, plus a title request.
    #[test]
    fn the_managed_profile_sends_the_model_request_only() {
        let Some(dsh) = which("dsh") else {
            eprintln!("skipped: no dsh on PATH");
            return;
        };
        let ws = std::env::temp_dir().join(format!("tmm-dsh-408-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/d1");
        std::fs::create_dir_all(&home).unwrap();
        let def: RegAgent = serde_json::from_value(json!({"name":"d1","backend":"dsh"})).unwrap();
        let r = render_dsh(&def, "d1", &home, "You are d1.", &[]).unwrap();
        let (port, seen) = messages_stand_in(Vec::new());
        let mut cmd = std::process::Command::new(&dsh);
        cmd.args(["--profile", PROFILE, "--", "Reply with exactly: OK"])
            .current_dir(&ws)
            .env_clear()
            .env("HOME", &ws)
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("DEEPSEEK_API_KEY", "not-a-key")
            .env("DEEPSEEK_BASE_URL", format!("http://127.0.0.1:{port}"))
            .stdin(std::process::Stdio::null());
        for (k, v) in &r.env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one request, the model's: {:?}", seen.iter().map(|s| &s.0).collect::<Vec<_>>());
        assert_eq!(seen[0].0, "POST /v1/messages HTTP/1.1");
        let keys: Vec<&String> = seen[0].1.as_object().unwrap().keys().collect();
        assert!(keys.iter().any(|k| *k == "messages"), "{keys:?}");
        for field in ["dsh_session_log", "dsh_plugin_packages"] {
            assert!(!keys.iter().any(|k| *k == field), "{field} left the machine: {keys:?}");
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #411, through the REAL dsh when one is installed, against the
    /// loopback stand-in (zero model calls): after the profile's patch layer is
    /// re-rendered, the NEXT run sends its request with the new model and
    /// effort. The model on the wire is what answers, so this is the live fact
    /// the commands promise, measured without a key or a token.
    #[test]
    fn a_rerendered_profile_changes_the_model_and_effort_on_the_wire_of_the_next_run() {
        let Some(dsh) = which("dsh") else {
            eprintln!("skipped: no dsh on PATH");
            return;
        };
        let ws = std::env::temp_dir().join(format!("tmm-dsh-411-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/d1");
        std::fs::create_dir_all(&home).unwrap();
        let def: RegAgent = serde_json::from_value(json!({"name":"d1","backend":"dsh","model":"deepseek-flash"})).unwrap();
        let r = render_dsh(&def, "d1", &home, "You are d1.", &[]).unwrap();
        let (port, seen) = messages_stand_in(Vec::new());
        let run = || {
            let mut cmd = std::process::Command::new(&dsh);
            cmd.args(["--profile", PROFILE, "--", "Reply with exactly: OK"])
                .current_dir(&ws)
                .env_clear()
                .env("HOME", &ws)
                .env("PATH", std::env::var_os("PATH").unwrap())
                .env("DEEPSEEK_API_KEY", "not-a-key")
                .env("DEEPSEEK_BASE_URL", format!("http://127.0.0.1:{port}"))
                .stdin(std::process::Stdio::null());
            for (k, v) in &r.env {
                cmd.env(k, v);
            }
            let out = cmd.output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            seen.lock().unwrap().last().cloned().expect("a request").1
        };
        let first = run();
        assert_eq!(first["model"], "deepseek-flash");
        assert_eq!(first.pointer("/output_config/effort").and_then(Value::as_str), Some("high"), "no effort named: dsh's own default");

        // Between runs, as `/model` and `/effort` do it.
        assert_eq!(write_profile_patch(&home, &model_def("deepseek-v4-pro", "max")).unwrap(), crate::backends::LiveWrite::Written);
        let second = run();
        assert_eq!(second["model"], "deepseek-v4-pro", "the next run answered from the new model: {second}");
        assert_eq!(second.pointer("/output_config/effort").and_then(Value::as_str), Some("max"), "{second}");
        assert_eq!(seen.lock().unwrap().len(), 2, "one request per run");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #412: the definition's MCP servers become dsh-mcp-client rows
    /// inside the patch's insert list. A variable reference is read from the
    /// environment at launch, every other value is a literal JSON string, and
    /// what dsh cannot express is refused.
    #[test]
    fn mcp_servers_render_as_native_dsh_rows_and_odd_ones_are_refused() {
        let def = |v: Value| -> shared::McpDef { serde_json::from_value(v).unwrap() };
        let rows = mcp_rows(&[
            def(json!({"name": "files", "command": "npx", "args": ["-y", "srv", "a\"b"], "env": {"TOKEN": "${GH_TOKEN}", "MODE": "ro $x"}})),
            def(json!({"name": "web_2", "url": "https://h/mcp", "headers": {"Authorization": "Bearer ${MCP_TOKEN}", "X-Id": "$ID", "X-Lit": "plain"}})),
        ])
        .unwrap();
        assert_eq!(
            rows,
            "    - id: tmm-mcp-files\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: \"files\"\n\
             \x20       transport: \"stdio\"\n        command: \"npx\"\n        args: [\"-y\", \"srv\", \"a\\\"b\"]\n        env:\n\
             \x20         \"MODE\": \"ro $x\"\n          \"TOKEN\": !!js \"process.env.GH_TOKEN ?? ''\"\n\
             \x20   - id: tmm-mcp-web_2\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: \"web_2\"\n\
             \x20       transport: \"streamable-http\"\n        url: \"https://h/mcp\"\n        headers:\n\
             \x20         \"Authorization\": !!js \"'Bearer ' + (process.env.MCP_TOKEN ?? '')\"\n\
             \x20         \"X-Id\": !!js \"process.env.ID ?? ''\"\n          \"X-Lit\": \"plain\"\n"
        );
        assert!(mcp_rows(&[def(json!({"name": "has space", "command": "x"}))]).unwrap_err().contains("1-32"));
        assert!(mcp_rows(&[def(json!({"name": "a".repeat(33), "command": "x"}))]).is_err());
        assert!(mcp_rows(&[def(json!({"name": "empty"}))]).unwrap_err().contains("neither a command nor a url"));
        assert_eq!(mcp_rows(&[]).unwrap(), "");
    }

    #[test]
    fn the_plugin_identity_is_neutral() {
        // Literal pins: this identity goes to DeepSeek with every request.
        let pkg: Value = serde_json::from_str(&plugin_package_json()).unwrap();
        assert_eq!(pkg["name"], "tmm-telemetry");
        assert_eq!(pkg["version"], "1.0.0");
        let js = plugin_js("/bin/sh '/x/helper' dsh # m");
        assert!(js.contains("export const name = 'tmm-telemetry'"));
        assert!(js.contains(r#"const NOTIFY = "/bin/sh '/x/helper' dsh # m""#), "the helper rides a JSON literal");
        for needle in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "'stop.json'", "setRawMode(true)", "'SIGINT'", "is not set\\n"] {
            assert!(js.contains(needle), "{needle}");
        }
    }

    /// Render writes the whole home, owns every file (a second render is
    /// byte-identical; a stale plugin is rewritten by refresh), and nothing
    /// about the model or a key reaches the launch line or the environment.
    #[test]
    fn render_writes_an_isolated_home_and_refresh_rewrites_the_runtime() {
        let ws = std::env::temp_dir().join(format!("tmm-dsh-render-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm").join("agents").join("d1");
        std::fs::create_dir_all(&home).unwrap();
        let def: RegAgent = serde_json::from_value(json!({"name":"d1","backend":"dsh","model":"deepseek-v4-pro","effort":"high"})).unwrap();
        let r = render_dsh(&def, "d1", &home, "You are d1.", &[]).unwrap();
        let dsh = home.join("dsh");
        assert_eq!(std::fs::read_to_string(dsh.join("AGENTS.md")).unwrap(), "You are d1.");
        let patch = std::fs::read_to_string(dsh.join("profiles/tmm/cordis.patch.yml")).unwrap();
        assert!(patch.contains("deepseek-v4-pro") && patch.contains("reasoningEffort: \"high\""));
        assert!(patch.contains(&dsh.join("plugins/tmm-telemetry/index.mjs").to_string_lossy().to_string()));
        for f in ["package.json", "pnpm-workspace.yaml", "cordis.yml"] {
            assert!(dsh.join("profiles/tmm").join(f).is_file(), "{f}");
        }
        assert!(dsh.join("plugins/tmm-telemetry/package.json").is_file());
        assert!(home.join("zsh/.zshrc").is_file() && home.join("zsh/.zshenv").is_file());
        assert_eq!(r.cmd, "exec zsh -i", "the managed shell replaces the pane's own");
        assert!(!r.cmd.contains("deepseek"), "the model lives in the config");
        let env: std::collections::HashMap<_, _> = r.env.iter().cloned().collect();
        assert_eq!(env["DSH_HOME"], dsh.to_string_lossy());
        assert_eq!(env["DSH_AGENTS_HOME"], dsh.to_string_lossy());
        assert_eq!(env["ZDOTDIR"], home.join("zsh").to_string_lossy());
        assert_eq!(env["DSH_PERMISSION_MODE"], "danger-full-access");
        assert_eq!(env["DSH_TELEMETRY_DISABLED"], "1", "board #408: the OTel row is removed");
        assert!(r.env.iter().all(|(k, _)| !k.contains("KEY")), "no key in the recipe");
        let c = r.confirmation.as_ref().unwrap();
        assert_eq!(super::shared::startup_step("dsh ›", c, true), super::shared::StartupStep::Ready, "a trimmed capture of the prompt");
        assert_eq!(super::shared::startup_step("$ . /ws/launch-d1.sh", c, true), super::shared::StartupStep::Wait);

        // The identity written to disk names neither the agent nor the workspace.
        let written = std::fs::read_to_string(dsh.join("plugins/tmm-telemetry/package.json")).unwrap();
        assert_eq!(written, plugin_package_json());
        assert!(!written.contains("d1") && !written.contains(&ws.to_string_lossy().to_string()));

        // Every rendered file is OWNED: a re-render rewrites what changed,
        // drops what is no longer declared (the effort line), and restores
        // whatever was edited or emptied in between.
        let owned = [
            "dsh/AGENTS.md", "dsh/profiles/tmm/package.json", "dsh/profiles/tmm/pnpm-workspace.yaml",
            "dsh/profiles/tmm/cordis.yml", "dsh/profiles/tmm/cordis.patch.yml",
            "dsh/plugins/tmm-telemetry/index.mjs", "dsh/plugins/tmm-telemetry/package.json", "zsh/.zshenv", "zsh/.zshrc",
        ];
        let fresh: Vec<String> = owned.iter().map(|f| std::fs::read_to_string(home.join(f)).unwrap()).collect();
        for f in owned {
            std::fs::write(home.join(f), "stale").unwrap();
        }
        render_dsh(&def, "d1", &home, "You are d1.", &[]).unwrap();
        for (f, want) in owned.iter().zip(&fresh) {
            assert_eq!(&std::fs::read_to_string(home.join(f)).unwrap(), want, "{f} was not rewritten");
        }
        let plain: RegAgent = serde_json::from_value(json!({"name":"d1","backend":"dsh"})).unwrap();
        render_dsh(&plain, "d1", &home, "You are d1, again.", &[]).unwrap();
        let patch = std::fs::read_to_string(dsh.join("profiles/tmm/cordis.patch.yml")).unwrap();
        assert!(patch.contains("model: \"deepseek-flash\"") && !patch.contains("reasoningEffort"), "{patch}");
        assert_eq!(std::fs::read_to_string(dsh.join("AGENTS.md")).unwrap(), "You are d1, again.");
        assert!(!refresh(&home, &crate::agent_notifications::AgentNotificationHub::load().helper_command("dsh")), "nothing stale");
        std::fs::write(dsh.join("plugins/tmm-telemetry/index.mjs"), "// edited").unwrap();
        assert!(refresh(&home, &crate::agent_notifications::AgentNotificationHub::load().helper_command("dsh")));
        assert!(std::fs::read_to_string(dsh.join("plugins/tmm-telemetry/index.mjs")).unwrap().contains("tmm-telemetry"));
        assert!(!refresh(&ws.join("not-a-home"), "x"), "a home without the profile is not ours");
        let _ = std::fs::remove_dir_all(&ws);
    }

    pub(crate) fn which(program: &str) -> Option<std::path::PathBuf> {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).map(|d| d.join(program)).find(|f| f.is_file()))
            .unwrap_or(None)
    }

    pub(crate) fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if f() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("timed out waiting for {what}");
    }

    /// The pane id of a fresh one-pane session: `session:0.0` assumes the
    /// default base-index, which a user's tmux.conf may change.
    pub(crate) fn pane_id(session: &str) -> String {
        crate::tmux::run_tmux(&["display-message", "-p", "-t", session, "#{pane_id}"]).unwrap_or_default().trim().to_string()
    }

    /// A notify line that keeps every envelope as `<TMM_HOOK_SEQ>.json` in
    /// `dir`: the order the producers NAMED, which is what the inbox honours.
    pub(crate) fn seq_sink(dir: &Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        // Write then rename, as the real helper does: a reader never sees half.
        let d = crate::shell::quote_always(&dir.to_string_lossy());
        format!("cat > {d}/.part.$$ && mv {d}/.part.$$ {d}/$TMM_HOOK_SEQ.json")
    }

    /// The envelopes a sink holds, in sequence order (the seqs are equal-width
    /// microsecond numbers, so the name order is the numeric order).
    pub(crate) fn sunk(dir: &Path) -> Vec<Value> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .map(|d| d.map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
            .unwrap_or_default();
        files.sort();
        files.iter().map(|f| serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap()).collect()
    }

    fn events(hooks: &[Value]) -> Vec<String> {
        hooks.iter().map(|h| h["hook_event_name"].as_str().unwrap_or_default().to_string()).collect()
    }

    /// A managed dsh pane for real: the rendered `.zshrc` in an interactive
    /// zsh inside a scratch tmux session, with a FAKE `dsh` on PATH that
    /// records its argv (NUL-separated, one file per run) and plays the
    /// plugin's part — it records a session, marks the prompt reported and
    /// writes the Stop payload. `mode` changes that: `kill` dies with 130 and
    /// `fail` with 3, both before reporting anything. Envelopes land in a
    /// sequence-ordered sink.
    struct ScratchPane {
        dir: std::path::PathBuf,
        session: String,
        target: String,
        cmd: String,
    }

    impl ScratchPane {
        fn start(tag: &str, extra_path: &[std::path::PathBuf]) -> Option<ScratchPane> {
            let zsh = which("zsh")?;
            let dir = std::env::temp_dir().join(format!("tmm-dsh-{tag}-{}", uuid::Uuid::new_v4()));
            let (bin, zdot, dsh_home) = (dir.join("bin"), dir.join("zsh"), dir.join("dsh"));
            for d in [&bin, &zdot, &dsh_home] {
                std::fs::create_dir_all(d).unwrap();
            }
            std::fs::write(zdot.join(".zshenv"), zshenv()).unwrap();
            std::fs::write(zdot.join(".zshrc"), zshrc(&seq_sink(&dir.join("hooks")))).unwrap();
            let fake = "#!/bin/sh\n\
                n=$(ls \"$FAKE_D\" | grep -c '^argv-'); n=$((n+1))\n\
                [ -f \"$DSH_HOME/profiles/tmm/cordis.patch.yml\" ] && cp \"$DSH_HOME/profiles/tmm/cordis.patch.yml\" \"$FAKE_D/patch-$n\"\n\
                : > \"$FAKE_D/argv-$n.part\"\n\
                for a in \"$@\"; do printf '%s\\0' \"$a\" >> \"$FAKE_D/argv-$n.part\"; done\n\
                mv \"$FAKE_D/argv-$n.part\" \"$FAKE_D/argv-$n\"\n\
                case \"$(cat \"$FAKE_D/mode\" 2>/dev/null)\" in kill) exit 130 ;; fail) exit 3 ;; hang) : > \"$DSH_HOME/tmm/prompted\"; exec sleep 600 ;; slow) while [ ! -f \"$FAKE_D/release\" ]; do sleep 0.1; done ;; esac\n\
                sid=session-0000-test; [ -f \"$FAKE_D/per-run\" ] && sid=$(printf 'session-%04d-test' \"$n\")\n\
                mkdir -p \"$DSH_HOME/tmm\" \"$DSH_HOME/sessions/k/$sid\"\n\
                printf '%s' \"$sid\" > \"$DSH_HOME/tmm/session\"\n\
                : > \"$DSH_HOME/tmm/prompted\"\n\
                printf '[dsh] · fake-model · ctx %s/1000000' $((n * 250000)) > \"$DSH_HOME/tmm/vitals\"\n\
                printf '{\"hook_event_name\":\"Stop\",\"session_id\":\"%s\",\"last_assistant_message\":\"ok %s\",\"dsh_reason\":\"completed\"}' \"$sid\" \"$n\" > \"$DSH_HOME/tmm/stop.json\"\n";
            std::fs::write(bin.join("dsh"), fake).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join("dsh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            let session = format!("tmm-dsh-test-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            let q = |p: &std::path::Path| crate::shell::quote_always(&p.to_string_lossy());
            let mut path = vec![bin.to_string_lossy().to_string()];
            path.extend(extra_path.iter().map(|p| p.to_string_lossy().to_string()));
            path.extend(["/usr/bin".to_string(), "/bin".to_string()]);
            let cmd = format!(
                "env -i HOME={} TERM=xterm-256color LANG=C.UTF-8 PATH={} ZDOTDIR={} DSH_HOME={} DSH_TELEMETRY_DISABLED=1 FAKE_D={} {} -i",
                q(&dir), crate::shell::quote_always(&path.join(":")), q(&zdot), q(&dsh_home), q(&dir), q(&zsh)
            );
            let started = crate::tmux::run_tmux(&["new-session", "-d", "-s", &session, "-x", "200", "-y", "50", "-c", &dir.to_string_lossy(), &cmd]);
            if started.is_err() {
                let _ = std::fs::remove_dir_all(&dir);
                return None;
            }
            let pane = ScratchPane { dir, target: pane_id(&session), session, cmd };
            wait_for("the dsh prompt", 15, || pane.screen().contains(READY_MARKER));
            Some(pane)
        }
        /// Kill the pane mid-whatever and start the same agent again (what a
        /// restart does: a new window over the same home).
        fn relaunch(&mut self) {
            let _ = crate::tmux::run_tmux(&["kill-session", "-t", &self.session]);
            crate::tmux::run_tmux(&["new-session", "-d", "-s", &self.session, "-x", "200", "-y", "50", "-c", &self.dir.to_string_lossy(), &self.cmd]).unwrap();
            self.target = pane_id(&self.session);
            wait_for("the relaunched prompt", 15, || self.screen().contains(READY_MARKER));
        }
        /// A restart that hands the old conversation back, the way
        /// `relaunch_line` does (`TMM_DSH_SESSION=<id>` on the launch line).
        fn relaunch_resuming(&mut self, id: &str) {
            let _ = crate::tmux::run_tmux(&["kill-session", "-t", &self.session]);
            let cmd = self.cmd.replacen("env -i ", &format!("env -i TMM_DSH_SESSION={id} "), 1);
            crate::tmux::run_tmux(&["new-session", "-d", "-s", &self.session, "-x", "200", "-y", "50", "-c", &self.dir.to_string_lossy(), &cmd]).unwrap();
            self.target = pane_id(&self.session);
            wait_for("the relaunched prompt", 15, || self.screen().contains(READY_MARKER));
        }
        fn target(&self) -> String {
            self.target.clone()
        }
        fn screen(&self) -> String {
            crate::tmux::capture_pane_plain(&self.target(), Some(50)).unwrap_or_default()
        }
        fn runs(&self) -> usize {
            std::fs::read_dir(&self.dir).unwrap().filter(|e| {
                let n = e.as_ref().unwrap().file_name();
                let n = n.to_string_lossy();
                n.starts_with("argv-") && !n.ends_with(".part")
            }).count()
        }
        fn argv(&self, n: usize) -> Vec<String> {
            let bytes = std::fs::read(self.dir.join(format!("argv-{n}"))).unwrap();
            let mut out: Vec<String> = bytes.split(|b| *b == 0).map(|s| String::from_utf8(s.to_vec()).unwrap()).collect();
            out.pop();
            out
        }
        fn hooks(&self) -> Vec<Value> {
            sunk(&self.dir.join("hooks"))
        }
        fn stops(&self) -> Vec<Value> {
            self.hooks().into_iter().filter(|h| h["hook_event_name"] == "Stop").collect()
        }
        /// Type one line through the REAL delivery primitive and wait for the
        /// Stop the shell sends when the prompt is back.
        fn deliver(&self, line: &str) -> usize {
            let stops = self.stops().len();
            crate::tmux::send_command(&self.target(), line).unwrap();
            wait_for("the Stop", 10, || self.stops().len() > stops);
            self.runs()
        }
        fn mode(&self, mode: Option<&str>) {
            match mode {
                Some(m) => std::fs::write(self.dir.join("mode"), m).unwrap(),
                None => {
                    let _ = std::fs::remove_file(self.dir.join("mode"));
                }
            }
        }
    }

    impl Drop for ScratchPane {
        fn drop(&mut self) {
            let _ = crate::tmux::run_tmux(&["kill-session", "-t", &self.session]);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Board #404 condition 1: a message reaches dsh's argv byte-exact and
    /// NOTHING in it runs — quotes, `$VAR`, backticks, `$(…)`, `;`, `&`, `|`,
    /// `>` and a newline (delivered as a bracketed paste), a tab (typed), and
    /// lines that start with `-` or `--`. A line starting `!` is a plain
    /// shell command, by design. Every turn after the first resumes the
    /// session the run recorded.
    #[test]
    fn a_delivered_line_is_one_quoted_argument_and_nothing_in_it_runs() {
        let Some(pane) = ScratchPane::start("quote", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        let canary = |n: &str| pane.dir.join(format!("canary-{n}"));
        let c = |n: &str| canary(n).to_string_lossy().to_string();
        let evil = format!(
            "hello 'single' \"double\" $HOME `touch {}` $(touch {}) ; touch {} & | > {}\nsecond line \\ end",
            c("bt"), c("subst"), c("semi"), c("redir")
        );
        let n = pane.deliver(&evil);
        assert_eq!(pane.argv(n), vec!["--profile", "tmm", "--", evil.as_str()], "the first turn starts a session");
        for (i, line) in ["-n not a flag", "--help", "col1\tcol2 & echo $((1+1))"].into_iter().enumerate() {
            let n = pane.deliver(line);
            assert_eq!(pane.argv(n), vec!["--profile", "tmm", "--session-id", "session-0000-test", "--", line], "line {i}");
        }
        for name in ["bt", "subst", "semi", "redir"] {
            assert!(!canary(name).exists(), "{name} ran");
        }
        assert_eq!(pane.stops()[0]["last_assistant_message"], "ok 1", "the run's own Stop is the one sent");
        assert!(!pane.hooks().iter().any(|h| h["hook_event_name"] == "UserPromptSubmit"), "a run that reported its prompt is not reported twice");

        let (runs, hooks) = (pane.runs(), pane.hooks().len());
        crate::tmux::send_command(&pane.target(), &format!("!touch {}", c("bang"))).unwrap();
        wait_for("the ! command", 10, || canary("bang").exists());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!((pane.runs(), pane.hooks().len()), (runs, hooks), "a shell line is no turn");
    }

    /// Board #411: a model or effort change is the NEXT turn's, in the same
    /// pane, with no restart. Every dsh turn is a fresh process that reads the
    /// profile, so re-rendering the patch layer is all it takes; the fake dsh
    /// copies the patch it was started with, which is what the real one reads.
    /// `/new` forgets the recorded session and the turn after it has no
    /// `--session-id`, while an ordinary turn resumes.
    #[test]
    fn a_model_effort_and_new_conversation_reach_the_next_turn_without_a_restart() {
        let Some(pane) = ScratchPane::start("live411", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        let profile = pane.dir.join("dsh").join("profiles").join(PROFILE);
        assert_eq!(write_profile_patch(&pane.dir, &model_def("x", "")).unwrap(), LiveWrite::NoConfig, "a home with no profile is rendered by spawn: nothing is written, and nothing is known about what runs");
        assert!(!profile.exists(), "and nothing was created");
        std::fs::create_dir_all(&profile).unwrap();
        assert_eq!(write_profile_patch(&pane.dir, &model_def("deepseek-flash", "")).unwrap(), LiveWrite::Written);
        let patch = |n: usize| std::fs::read_to_string(pane.dir.join(format!("patch-{n}"))).unwrap();

        let n = pane.deliver("one");
        assert!(patch(n).contains("model: \"deepseek-flash\"") && !patch(n).contains("reasoningEffort"), "{}", patch(n));
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"), "the first turn starts a conversation");

        // The change lands between turns, in the running pane.
        assert_eq!(write_profile_patch(&pane.dir, &model_def("deepseek-v4-pro", "max")).unwrap(), LiveWrite::Written, "the patch changed");
        assert_eq!(write_profile_patch(&pane.dir, &model_def("deepseek-v4-pro", "max")).unwrap(), LiveWrite::AlreadyCurrent, "and the same text is not rewritten");
        let n = pane.deliver("two");
        assert!(patch(n).contains("model: \"deepseek-v4-pro\"") && patch(n).contains("reasoningEffort: \"max\""), "the next turn read the new profile: {}", patch(n));
        assert_eq!(pane.argv(n)[..4], ["--profile", "tmm", "--session-id", "session-0000-test"], "and it is still the same conversation");

        // /new: the next line starts another one.
        assert!(new_conversation(&pane.dir).unwrap(), "there was a session to leave");
        let n = pane.deliver("three");
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"), "a fresh conversation: {:?}", pane.argv(n));
        assert!(patch(n).contains("deepseek-v4-pro"), "the model change persists across /new");
        assert!(!pane.dir.join("dsh/tmm/new").exists(), "and the shell consumed the request with that turn");
        assert_eq!(pane.runs(), 3);
    }

    /// Board #411 review P1-D: `/new` is a decision that outlives what could
    /// undo a bare deletion of the recorded session — a restart handing the old
    /// conversation back, and a running turn's plugin writing the session after
    /// the command (cold start, a turn in flight). The next turn is fresh, the
    /// one after resumes THAT fresh session, and the old one stays on disk.
    #[test]
    fn a_new_conversation_survives_a_restart_and_is_refused_while_a_turn_runs() {
        let Some(mut pane) = ScratchPane::start("new411", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        std::fs::write(pane.dir.join("per-run"), "").unwrap();
        let sessions = pane.dir.join("dsh/sessions/k");
        let id = |n: usize| format!("session-{n:04}-test");

        let n = pane.deliver("one");
        assert_eq!(n, 1);
        assert!(sessions.join(id(1)).is_dir(), "the first conversation");

        // Idle /new, then a restart that hands the old conversation back.
        new_conversation(&pane.dir).unwrap();
        pane.relaunch_resuming(&id(1));
        let n = pane.deliver("two");
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"), "the restart did not bring the old conversation back: {:?}", pane.argv(n));
        let n = pane.deliver("three");
        assert_eq!(pane.argv(n)[..4], ["--profile", "tmm", "--session-id", id(2).as_str()], "and the next turn resumes the FRESH session");
        assert!(sessions.join(id(1)).is_dir(), "the old conversation is kept on disk");

        // /new while a turn runs is REFUSED: the run records its session after the command, and
        // refusing removes that race. Nothing is written; the turn ends; then it is accepted.
        pane.mode(Some("slow"));
        let before = pane.runs();
        crate::tmux::send_command(&pane.target(), "slow turn").unwrap();
        wait_for("the slow run to start", 10, || pane.runs() > before);
        let err = new_conversation(&pane.dir).unwrap_err();
        assert!(err.contains("wait for it to end"), "{err}");
        assert!(!pane.dir.join("dsh/tmm/new").exists(), "a refused /new leaves no request behind");
        let stops = pane.stops().len();
        std::fs::write(pane.dir.join("release"), "").unwrap();
        wait_for("the slow run's Stop", 10, || pane.stops().len() > stops);
        pane.mode(None);
        wait_for("the prompt", 10, || !pane.dir.join("dsh/tmm/open").exists());
        assert!(new_conversation(&pane.dir).unwrap(), "at the prompt it is accepted");
        let n = pane.deliver("five");
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"), "{:?}", pane.argv(n));
        let last = pane.runs();
        let n = pane.deliver("six");
        assert_eq!(n, last + 1);
        assert_eq!(pane.argv(n)[..4], ["--profile", "tmm", "--session-id", id(last).as_str()], "resumes the fresh one");
    }

    /// Review P1-D residual: the command's only write is the marker. The shell
    /// that consumes it owns the session cleanup, so a delayed command-side
    /// delete cannot remove the id the plugin recorded for the FRESH
    /// conversation: publish, let the shell consume it and record a fresh id,
    /// "finish the command" (it has nothing left to do), and the next turn
    /// resumes that fresh id.
    #[test]
    fn the_command_publishes_the_marker_and_the_shell_owns_the_cleanup() {
        let Some(pane) = ScratchPane::start("commit411", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        std::fs::write(pane.dir.join("per-run"), "").unwrap();
        let session = pane.dir.join("dsh/tmm/session");
        let id = |n: usize| format!("session-{n:04}-test");
        pane.deliver("one");
        assert_eq!(std::fs::read_to_string(&session).unwrap(), id(1));

        assert!(new_conversation(&pane.dir).unwrap());
        assert_eq!(std::fs::read_to_string(&session).unwrap(), id(1), "the command did not touch the recorded session: only the shell does, when it consumes the marker");
        assert!(pane.dir.join("dsh/tmm/new").exists());

        // The shell consumes the marker with the next turn; the plugin records the fresh id.
        let n = pane.deliver("two");
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"));
        assert_eq!(std::fs::read_to_string(&session).unwrap(), id(2), "the fresh conversation is recorded");

        // The command's tail, had it a delayed delete, would land here: it has none, so the
        // next turn resumes the fresh id (this is the barrier after publication).
        let n = pane.deliver("three");
        assert_eq!(pane.argv(n)[..4], ["--profile", "tmm", "--session-id", id(2).as_str()]);
        // Saying /new when the marker already stands is harmless and still one request.
        assert!(new_conversation(&pane.dir).unwrap());
        assert!(new_conversation(&pane.dir).unwrap());
        let n = pane.deliver("four");
        assert!(!pane.argv(n).iter().any(|a| a == "--session-id"));
    }

    /// Boards #411 x #412: a live model change re-renders the WHOLE patch
    /// from the definition, so the definition's MCP rows and the skill
    /// provider's root survive it — the live write and the render are one
    /// document, never a model-only patch that drops the agent's tools.
    #[test]
    fn a_live_model_change_keeps_the_mcp_rows_and_the_skill_root() {
        let home = std::env::temp_dir().join(format!("tmm-dsh-live412-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let mcp = json!([{"name": "echo", "command": "node", "args": ["srv.mjs"]}]).to_string();
        let def = |model: &str| -> RegAgent { serde_json::from_value(json!({"name": "d1", "backend": "dsh", "model": model, "mcp": mcp})).unwrap() };
        // One real skill, so the live write is seen to leave its link alone.
        let skill = home.join("lib/hello-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: hello-skill\ndescription: Greet.\n---\n\nSay hello.\n").unwrap();
        let skills = [crate::projects::skills::ResolvedSkill { name: "hello-skill".into(), dir: skill.clone(), description: "Greet.".into() }];
        render_dsh(&def("deepseek-flash"), "d1", &home, "You are d1.", &skills).unwrap();
        let link = home.join("dsh/tmm/skills/hello-skill");
        let path = home.join("dsh/profiles/tmm/cordis.patch.yml");
        let rendered = std::fs::read_to_string(&path).unwrap();
        assert_eq!(write_profile_patch(&home, &def("deepseek-flash")).unwrap(), crate::backends::LiveWrite::AlreadyCurrent, "the live write renders exactly what spawn did");
        assert_eq!(write_profile_patch(&home, &def("deepseek-v4-pro")).unwrap(), crate::backends::LiveWrite::Written);
        let live = std::fs::read_to_string(&path).unwrap();
        assert!(live.contains("model: \"deepseek-v4-pro\""));
        assert!(live.contains("- id: tmm-mcp-echo\n") && live.contains("customSkillDirs: ["), "{live}");
        assert_eq!(live.replace("deepseek-v4-pro", "deepseek-flash"), rendered, "only the model changed");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink(), "the skill link survives the live write");
        assert_eq!(std::fs::read_link(&link).unwrap(), skill, "with its target");
        assert_eq!(std::fs::read_to_string(link.join("SKILL.md")).unwrap(), "---\nname: hello-skill\ndescription: Greet.\n---\n\nSay hello.\n", "and its content");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Review P1-B: the live patch is replaced WHOLE. A reader that opens it
    /// while it is being rewritten — a dsh turn starting — sees all of one
    /// document or all of the other, never an empty or half-written file.
    #[test]
    fn a_reader_at_publication_sees_a_whole_patch() {
        let dir = std::env::temp_dir().join(format!("tmm-dsh-atomic-{}", uuid::Uuid::new_v4()));
        let profile = dir.join("dsh").join("profiles").join(PROFILE);
        std::fs::create_dir_all(&profile).unwrap();
        let entry = dir.join("dsh").join("plugins").join(PLUGIN_NAME).join("index.mjs");
        let root = skill_root(&dir.join("dsh"));
        let (a, b) = (profile_patch_yml(&entry, "deepseek-flash", "", "", &root), profile_patch_yml(&entry, "deepseek-v4-pro", "max", "", &root));
        assert_eq!(write_profile_patch(&dir, &model_def("deepseek-flash", "")).unwrap(), crate::backends::LiveWrite::Written);
        let path = profile.join("cordis.patch.yml");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (reader_stop, reader_path, docs) = (stop.clone(), path.clone(), [a.clone(), b.clone()]);
        let reader = std::thread::spawn(move || {
            let mut reads = 0usize;
            while !reader_stop.load(std::sync::atomic::Ordering::Relaxed) {
                let text = std::fs::read_to_string(&reader_path).expect("the file is never absent");
                assert!(docs.contains(&text), "a torn read ({} bytes): {text:?}", text.len());
                reads += 1;
            }
            reads
        });
        for i in 0..400 {
            let (m, e) = if i % 2 == 0 { ("deepseek-v4-pro", "max") } else { ("deepseek-flash", "") };
            write_profile_patch(&dir, &model_def(m, e)).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0, "the reader ran");
        let leftovers: Vec<_> = std::fs::read_dir(&profile).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).filter(|n| n.contains(".tmp-")).collect();
        assert!(leftovers.is_empty(), "no temp file is left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_commands_the_app_runs_and_the_model_ids_it_accepts() {
        use super::super::AppCommand::*;
        let parse = |n: &str, a: &str| app_command(n, a);
        assert_eq!(parse("/model", "deepseek-v4-pro"), Some(Ok(Model("deepseek-v4-pro".into()))));
        assert_eq!(parse("/model", "  deepseek-flash  "), Some(Ok(Model("deepseek-flash".into()))));
        assert_eq!(parse("/effort", "max"), Some(Ok(Effort("max".into()))));
        assert_eq!(parse("/new", ""), Some(Ok(NewConversation)));
        for (n, a) in [("/model", ""), ("/model", "a b"), ("/effort", ""), ("/effort", "high low"), ("/new", "now")] {
            assert!(matches!(parse(n, a), Some(Err(e)) if e.starts_with("usage: ")), "{n} {a}");
        }
        for c in ["/compact", "/clear", "/goal", "/models", "model", "/MODEL", "/"] {
            assert_eq!(parse(c, ""), None, "{c} is not ours: typed as before");
        }
        for m in ["", "deepseek-flash", "deepseek-v4-pro", "vendor/model:1.5_x"] {
            assert_eq!(model_id_error(m), None, "{m}");
        }
        for m in ["a b", "a;b", "$(x)", "a\nb", "m'", &"x".repeat(101)] {
            assert!(model_id_error(m).is_some(), "{m:?}");
        }
        for k in known_models() {
            assert_eq!(model_id_error(k), None);
        }
    }

    #[test]
    fn every_run_ends_its_turn_once_and_a_failed_launch_is_failed() {
        let node_dir = which("node").and_then(|n| n.parent().map(Path::to_path_buf));
        let real = which("dsh").and_then(|d| d.parent().map(Path::to_path_buf));
        let extra: Vec<_> = [node_dir, real.clone()].into_iter().flatten().collect();
        let Some(pane) = ScratchPane::start("ends", &extra) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        let line = "a \"quoted\" back\\slash, a\ttab, é 中文 and $HOME";
        let check = |mode: &str, want_reason: &str, want_exit: Option<i64>| {
            let before = pane.hooks().len();
            pane.deliver(line);
            let new: Vec<Value> = pane.hooks().split_off(before);
            assert_eq!(events(&new), ["UserPromptSubmit", "Stop"], "{mode}: {new:?}");
            assert_eq!(new[0]["prompt"], line, "{mode}: the prompt is reported for the run, byte-exact");
            assert_eq!(new[1]["dsh_reason"], want_reason, "{mode}");
            assert_eq!(new[1]["last_assistant_message"], "", "{mode}: no invented reply");
            assert_eq!(new[1].get("dsh_exit").and_then(Value::as_i64), want_exit, "{mode}");
            normalize_kind(new[1].as_object().unwrap()).unwrap()
        };
        pane.mode(Some("kill"));
        assert_eq!(check("kill", "interrupted", None), "completed");
        pane.mode(Some("fail"));
        assert_eq!(check("fail", "error", Some(3)), "failed");
        pane.mode(None);
        if real.is_some() {
            // The real dsh, with a DSH_HOME that has no `tmm` profile.
            std::fs::remove_file(pane.dir.join("bin/dsh")).unwrap();
            assert_eq!(check("bad profile", "error", Some(1)), "failed");
        } else {
            eprintln!("no real dsh on PATH: the bad-profile case is skipped");
        }
    }

    /// A run that never ends — dsh wedged, the window killed or the agent
    /// restarted mid-turn — sends no Stop; the NEXT shell over the same home
    /// ends that turn at its first prompt, as an interrupt, so lines held for
    /// it are not held forever (dsh takes no overdue release). Exactly one
    /// end: the shell after that sends nothing more.
    #[test]
    fn a_run_left_open_by_a_dead_shell_is_ended_by_the_next_one() {
        let Some(mut pane) = ScratchPane::start("restart", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        pane.mode(Some("hang"));
        crate::tmux::send_command(&pane.target(), "a turn that never ends").unwrap();
        wait_for("the hung run", 10, || pane.runs() == 1);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(pane.stops().is_empty(), "nothing ends a run that is still running");
        pane.mode(None);
        pane.relaunch();
        wait_for("the stale turn's end", 10, || pane.stops().len() == 1);
        let stop = pane.stops().pop().unwrap();
        assert_eq!(stop["dsh_reason"], "interrupted");
        assert_eq!(stop["last_assistant_message"], "");
        assert_eq!(normalize_kind(stop.as_object().unwrap()), Ok("completed"));
        assert!(!pane.hooks().iter().any(|h| h["hook_event_name"] == "UserPromptSubmit"), "its prompt was already reported");
        pane.relaunch();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(pane.stops().len(), 1, "one end, not one per shell");
        pane.deliver("the next turn works");
        assert_eq!(pane.stops().len(), 2);
    }

    /// Board #413 review P2-A: a process state is read only from a clean
    /// observation. ps must succeed and print exactly one state word; a
    /// state word must start with a state letter. Anything else is unknown,
    /// and `owns_input` takes unknown as not live.
    #[test]
    fn a_process_state_is_believed_only_from_a_clean_observation() {
        use std::os::unix::process::ExitStatusExt;
        let ps = |code: i32, out: &str| Some(std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: out.as_bytes().to_vec(),
            stderr: Vec::new(),
        });
        assert_eq!(ps_state(ps(0, "Ss+\n")).as_deref(), Some("Ss+"));
        assert_eq!(ps_state(ps(0, "  Z\n")).as_deref(), Some("Z"));
        assert_eq!(ps_state(ps(1, "")), None, "ps found no such pid");
        assert_eq!(ps_state(ps(1, "S\n")), None, "a failed ps is no answer, whatever it printed");
        assert_eq!(ps_state(ps(0, "")), None);
        assert_eq!(ps_state(ps(0, "S\nZ\n")), None, "two answers for one pid");
        assert_eq!(ps_state(ps(0, "STAT S\n")), None, "a header is not a state");
        assert_eq!(ps_state(ps(0, "S garbage\n")), None, "a state and more is not one answer");
        assert_eq!(ps_state(None), None, "ps could not run");
        for live in ["S", "R", "D", "T", "t", "I", "W", "Ss+", "R+", "S<l", "SN", "Ss", "U", "S+", "I<"] {
            assert_eq!(state_is_live(live), Some(true), "{live}");
        }
        for dead in ["Z", "Z+", "X", "x", "Zs"] {
            assert_eq!(state_is_live(dead), Some(false), "{dead}");
        }
        for junk in ["", "z", "1234", "+S", "S\u{7}", "é", "ERROR", "STAT", "Sgarbage", "S1", "Q", "RUNNING"] {
            assert_eq!(state_is_live(junk), None, "{junk:?}");
            assert!(!owner_verdict(Some(junk)), "unknown is not live: {junk:?}");
        }
        assert!(!owner_verdict(None), "no observation is not live");
        assert!(!owner_verdict(Some("Z+")));
        assert!(owner_verdict(Some("Ss+")));
    }

    /// Review P1-A2: the ready file is believed only while the shell it names
    /// is alive — a stale file (its shell killed) or a nameless one is not
    /// readiness. Board #413: nor is a zombie (exited, not yet reaped).
    #[test]
    fn a_ready_file_is_believed_only_while_its_owner_lives() {
        let home = std::env::temp_dir().join(format!("tmm-dsh-owner-{}", uuid::Uuid::new_v4()));
        let file = home.join("dsh/tmm/ready");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let me = std::process::id();
        assert!(!input_ready(&home, Some(me)), "no file");
        std::fs::write(&file, format!("{me} %3")).unwrap();
        assert!(input_ready(&home, Some(me)), "a live owner that is the pane's process");
        assert!(!input_ready(&home, Some(me + 1)), "alive, but not the pane's process");
        assert!(!input_ready(&home, None), "a pane whose process cannot be read");
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let dead = gone.id();
        gone.wait().unwrap();
        std::fs::write(&file, format!("{dead} %3")).unwrap();
        assert!(!input_ready(&home, Some(dead)), "its owner is dead");
        // Board #413: an owner that has exited but is not reaped yet — a
        // zombie, which signal 0 still finds — is not alive either. A child
        // of this test that exits and is not waited for is exactly that.
        let mut zombie = std::process::Command::new("true").spawn().unwrap();
        let z = zombie.id();
        wait_for("the child to become a zombie", 5, || {
            std::fs::read_to_string(format!("/proc/{z}/stat")).ok().and_then(|s| s.rsplit_once(')').map(|(_, r)| r.trim_start().starts_with('Z'))).unwrap_or_else(|| {
                // No /proc (macOS): ps's state column.
                std::process::Command::new("ps").args(["-o", "stat=", "-p", &z.to_string()]).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim().starts_with('Z'))
            })
        });
        assert_eq!(unsafe { libc::kill(z as i32, 0) }, 0, "signal 0 still finds a zombie");
        std::fs::write(&file, format!("{z} %3")).unwrap();
        assert!(!input_ready(&home, Some(z)), "a zombie owner reads nothing");
        zombie.wait().unwrap();
        for junk in ["", "abc", "1 %1", "0"] {
            std::fs::write(&file, junk).unwrap();
            assert!(!input_ready(&home, Some(me)), "{junk:?}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Review P1-A2, through the PRODUCTION launcher: the launch script is
    /// sourced into the pane's own ordinary shell, exactly as spawn types it,
    /// and `exec`s the managed zsh — which therefore IS the pane's process
    /// (`pane_pid`), the only owner a ready file may name. Killed while idle
    /// (SIGKILL: no trap runs), it takes the pane with it — no ordinary shell
    /// is left to read a chat line with `;` and `$( )` — and the ready file it
    /// leaves behind is not believed. Starting it again makes a new owner.
    #[test]
    fn the_pane_ends_with_its_managed_shell_and_its_stale_ready_file_is_not_believed() {
        let Some(zsh) = which("zsh") else {
            eprintln!("skipped: no zsh");
            return;
        };
        let dir = std::env::temp_dir().join(format!("tmm-dsh-launch-{}", uuid::Uuid::new_v4()));
        let home = dir.join("home");
        let (bin, zdot) = (dir.join("bin"), home.join("zsh"));
        for d in [&bin, &zdot, &home.join("dsh")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(zdot.join(".zshenv"), zshenv()).unwrap();
        std::fs::write(zdot.join(".zshrc"), zshrc(&seq_sink(&dir.join("hooks")))).unwrap();
        let q = |p: &Path| crate::shell::quote_always(&p.to_string_lossy());
        let zsh_dir = zsh.parent().unwrap().to_path_buf();
        let prefix = format!(
            "ZDOTDIR={} DSH_HOME={} PATH={}",
            q(&zdot), q(&home.join("dsh")), crate::shell::quote_always(&format!("{}:{}:/usr/bin:/bin", bin.display(), zsh_dir.display()))
        );
        let script = super::super::shared::write_launch_script(&home, "d1", &format!("{prefix} {LAUNCH}")).unwrap();
        let canary = dir.join("canary");
        struct Kill(Vec<String>, std::path::PathBuf);
        impl Drop for Kill {
            fn drop(&mut self) {
                for s in &self.0 {
                    let _ = crate::tmux::run_tmux(&["kill-session", "-t", s]);
                }
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let mut guard = Kill(Vec::new(), dir.clone());
        let launch = |guard: &mut Kill| -> Option<(String, String)> {
            let session = format!("tmm-dsh-launch-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            let outer = format!("env -i HOME={} TERM=xterm-256color LANG=C.UTF-8 PS1='outer$ ' /bin/sh", q(&dir));
            crate::tmux::run_tmux(&["new-session", "-d", "-s", &session, "-x", "160", "-y", "30", "-c", &dir.to_string_lossy(), &outer]).ok()?;
            guard.0.push(session.clone());
            let target = pane_id(&session);
            let screen = || crate::tmux::capture_pane_plain(&target, Some(30)).unwrap_or_default();
            wait_for("the outer shell", 10, || screen().contains("outer$"));
            crate::tmux::send_command(&target, &format!(". {}", q(&script))).unwrap();
            wait_for("the managed prompt", 15, || screen().contains(READY_MARKER));
            Some((session, target))
        };
        let Some((session, target)) = launch(&mut guard) else {
            eprintln!("skipped: no tmux server");
            return;
        };
        let pane_pid = |t: &str| crate::tmux::pane_format(t, "#{pane_pid}").and_then(|p| p.parse::<u32>().ok());
        let owner = pane_pid(&target);
        assert!(input_ready(&home, owner), "the managed zsh is the pane's own process");
        let ready = std::fs::read_to_string(home.join("dsh/tmm/ready")).unwrap();
        let pid: i32 = ready.split_whitespace().next().unwrap().parse().unwrap();
        assert_eq!(Some(pid as u32), owner, "exec: no outer shell between the pane and its managed zsh");
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        wait_for("the pane to close with its managed shell", 10, || {
            crate::tmux::run_tmux(&["has-session", "-t", &session]).is_err()
        });
        assert!(home.join("dsh/tmm/ready").is_file(), "SIGKILL left the file behind…");
        assert!(!input_ready(&home, pane_pid(&target)), "…and it is not believed");
        assert!(!input_ready(&home, owner), "…not even against the dead owner's pid");
        let line = format!("[tmm chat 2026-10-16 14:30] lead: @d1 hi; touch {} $(touch {})", q(&canary), q(&canary));
        assert!(crate::tmux::send_command(&target, &line).is_err(), "nothing left to type into");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!canary.exists(), "no chat text ran as a command");

        let Some((_, again_target)) = launch(&mut guard) else { panic!("relaunch") };
        let new_owner = pane_pid(&again_target);
        assert!(input_ready(&home, new_owner), "the new managed shell is the new owner");
        assert_ne!(new_owner, owner);
    }

    /// Review P2: a notifier that IGNORES TERM is still bounded on both
    /// producers — the plugin's publish (spawnSync, KILL at the bound) and
    /// the shell's (TERM, then KILL) — so the run and the prompt go on; and
    /// neither counts it as published.
    #[test]
    fn a_notifier_that_ignores_term_is_still_bounded() {
        let stubborn = "trap '' TERM; sleep 10; cat > /dev/null";
        // The plugin.
        let Some(node) = which("node") else {
            eprintln!("skipped: no node");
            return;
        };
        let dir = std::env::temp_dir().join(format!("tmm-dsh-stubborn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.mjs"), plugin_js(stubborn)).unwrap();
        std::fs::write(
            dir.join("driver.mjs"),
            "import * as p from './index.mjs'\nlet h\np.apply({ on: (e, f) => { if (e === 'session/event') h = f } }, {})\n\
             const root = { header: { id: 'session-x-1' } }\nh(root, { type: 'turn/start', data: { turn: 1 } })\n\
             h(root, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } })\n",
        )
        .unwrap();
        let at = std::time::Instant::now();
        let out = std::process::Command::new(node).arg("driver.mjs").current_dir(&dir).env("DSH_HOME", &dir).stdin(std::process::Stdio::null()).output().unwrap();
        assert!(out.status.success());
        assert!(at.elapsed() < std::time::Duration::from_secs(6), "the plugin's publish was bounded: {:?}", at.elapsed());
        assert!(!dir.join("tmm/prompted").exists(), "a killed publish is not a receipt");
        let _ = std::fs::remove_dir_all(&dir);

        // The shell.
        let Some(pane) = ScratchPane::start("stubborn", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        std::fs::write(pane.dir.join("zsh/.zshrc"), zshrc(stubborn)).unwrap();
        let mut pane = pane;
        pane.relaunch();
        let at = std::time::Instant::now();
        crate::tmux::send_command(&pane.target(), "a run whose Stop hangs").unwrap();
        wait_for("the run", 10, || pane.runs() == 1);
        wait_for("the prompt back", 10, || pane.dir.join("dsh/tmm/ready").is_file() && pane.dir.join("dsh/tmm/unsent").is_file());
        assert!(at.elapsed() < std::time::Duration::from_secs(6), "the shell's publish was bounded: {:?}", at.elapsed());
        assert!(std::fs::read_to_string(pane.dir.join("dsh/tmm/unsent")).unwrap().contains("\"Stop\""), "kept for the next publisher");
    }

    /// The missing executable: PATH without any dsh is a failed launch (127).
    #[test]
    fn a_missing_dsh_executable_is_a_failed_launch() {
        let Some(pane) = ScratchPane::start("nodsh", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        std::fs::remove_file(pane.dir.join("bin/dsh")).unwrap();
        pane.deliver("hello");
        let hooks = pane.hooks();
        assert_eq!(events(&hooks), ["UserPromptSubmit", "Stop"]);
        assert_eq!(hooks[0]["prompt"], "hello");
        assert_eq!(hooks[1]["dsh_exit"], 127);
        assert_eq!(normalize_kind(hooks[1].as_object().unwrap()), Ok("failed"));
    }

    /// A line typed the moment a Stop arrives — what a flush does — lands in
    /// ZLE as ONE bracketed paste: one run, the whole two-line text in one
    /// argument. (The production hold-and-flush path is pinned end to end in
    /// agent_notifications.rs, `a_busy_dsh_turn_holds_lines_and_ends_in_order`.)
    #[test]
    fn a_line_typed_after_stop_is_one_paste() {
        let Some(pane) = ScratchPane::start("paste", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        pane.deliver("a normal turn");
        let runs = pane.runs();
        let held = "[tmm chat 2026-10-16 11:30] human: first held line\nsecond held line";
        pane.deliver(held);
        assert_eq!(pane.runs(), runs + 1, "one paste, one run");
        assert_eq!(pane.argv(runs + 1).last().map(String::as_str), Some(held));
    }

    /// Run the generated plugin under node with a stand-in `ctx`: the driver
    /// replays `events` (`[session, event]` pairs, the session named in
    /// `sessions`) into its `session/event` listener. Returns the exit
    /// status, stderr, the envelopes in the order they were NAMED, and the
    /// state directory. `None` without node.
    pub(crate) fn run_plugin(config: Value, sessions: Value, events: Value) -> Option<(Option<i32>, String, Vec<Value>, std::path::PathBuf)> {
        let node = which("node")?;
        let dir = std::env::temp_dir().join(format!("tmm-dsh-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.mjs"), plugin_js(&seq_sink(&dir.join("hooks")))).unwrap();
        std::fs::write(
            dir.join("driver.mjs"),
            format!(
                "import * as p from './index.mjs'\nconst sessions = {sessions}\nlet h\n\
                 p.apply({{ on: (e, f) => {{ if (e === 'session/event') h = f }} }}, {config})\n\
                 for (const [s, ev] of {events}) h(sessions[s], ev)\n"
            ),
        )
        .unwrap();
        let out = std::process::Command::new(node)
            .arg("driver.mjs")
            .current_dir(&dir)
            .env("DSH_HOME", &dir)
            .env_remove("TMM_TEST_UNSET_KEY")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let hooks = sunk(&dir.join("hooks"));
        Some((out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned(), hooks, dir))
    }

    fn root_and_child() -> Value {
        json!({
            "root": {"header": {"id": "session-root-1"}},
            "child": {"header": {"id": "session-child-1", "parentSession": "session-root-1", "origin": "subagent"}}
        })
    }

    /// The plugin maps dsh's durable events to the turn edges IN ORDER: the
    /// prompt, the tool lane, and a Stop (written, for the shell to send)
    /// carrying the turn's last assistant TEXT — reasoning parts are not the
    /// reply, the runtime-context message is not the prompt.
    #[test]
    fn the_plugin_reports_the_prompt_the_tools_and_writes_the_stop() {
        let events_in = json!([
            ["root", {"type":"turn/start","data":{"turn":1}}],
            ["root", {"type":"user/message","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"Run true, then reply ok"}]}}],
            ["root", {"type":"user/message","data":{"role":"user","source":{"kind":"runtime"},"content":[{"type":"text","text":"Current runtime context."}]}}],
            ["root", {"type":"tool/call","data":{"turn":1,"name":"bash","arguments":"{\"command\": \"true\"}"}}],
            ["root", {"type":"tool/result","data":{"turn":1}}],
            ["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"ok"}]}}}],
            ["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"only thoughts"}]}}}],
            ["root", {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}]
        ]);
        let Some((code, _, hooks, dir)) = run_plugin(json!({"requireEnv": ""}), root_and_child(), events_in) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(code, Some(0));
        assert_eq!(events(&hooks), ["UserPromptSubmit", "PreToolUse", "PostToolUse"], "dsh's own order");
        assert_eq!(hooks[0]["prompt"], "Run true, then reply ok");
        assert_eq!(hooks[0]["session_id"], "session-root-1");
        assert_eq!(hooks[1]["tool_name"], "bash");
        assert_eq!(hooks[1]["tool_input"]["command"], "true");
        let stop: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tmm/stop.json")).unwrap()).unwrap();
        assert_eq!(stop["last_assistant_message"], "ok");
        assert_eq!(stop["dsh_reason"], "completed");
        assert_eq!(std::fs::read_to_string(dir.join("tmm/session")).unwrap(), "session-root-1");
        assert!(dir.join("tmm/prompted").exists(), "the shell must not report the prompt again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P1-B: only the agent's OWN (root) session is the window's turn. A
    /// subagent session — even one seen FIRST — never opens a turn, becomes
    /// the prompt, resets or supplies the reply, or writes the Stop: not
    /// while the root runs, not when it ends, and not after the root ended.
    #[test]
    fn a_subagent_session_never_becomes_the_windows_turn() {
        let child_turn = |text: &str| {
            vec![
                json!(["child", {"type":"turn/start","data":{"turn":1}}]),
                json!(["child", {"type":"user/message","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":format!("child brief {text}")}]}}]),
                json!(["child", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"text","text":format!("CHILD ANSWER {text}")}]}}}]),
                json!(["child", {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}]),
            ]
        };
        // The child ends while the root still runs, and the root is then
        // killed before its own turn/end: no Stop may be written at all —
        // the shell's reply-less interrupt is the truth, not the child's text.
        let mut interrupted = child_turn("early");
        interrupted.extend([
            json!(["root", {"type":"turn/start","data":{"turn":1}}]),
            json!(["root", {"type":"user/message","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"delegate it"}]}}]),
            json!(["root", {"type":"tool/call","data":{"turn":1,"name":"subagent","arguments":"{}"}}]),
        ]);
        interrupted.extend(child_turn("mid"));
        let Some((_, _, hooks, dir)) = run_plugin(json!({}), root_and_child(), Value::Array(interrupted.clone())) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(events(&hooks), ["UserPromptSubmit", "PreToolUse"]);
        assert_eq!(hooks[0]["prompt"], "delegate it");
        assert_eq!(hooks[0]["session_id"], "session-root-1", "the child seen first did not claim the window");
        assert!(!dir.join("tmm/stop.json").exists(), "a child's end is not the window's Stop");
        assert_eq!(std::fs::read_to_string(dir.join("tmm/session")).unwrap(), "session-root-1");
        let _ = std::fs::remove_dir_all(&dir);

        // The root ends with its own text; a child event AFTER that changes
        // nothing.
        let mut finished = interrupted;
        finished.extend([
            json!(["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"text","text":"root answer"}]}}}]),
            json!(["root", {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}]),
        ]);
        finished.extend(child_turn("late"));
        let (_, _, hooks, dir) = run_plugin(json!({}), root_and_child(), Value::Array(finished)).unwrap();
        assert_eq!(events(&hooks), ["UserPromptSubmit", "PreToolUse"]);
        let stop: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tmm/stop.json")).unwrap()).unwrap();
        assert_eq!(stop["last_assistant_message"], "root answer");
        assert_eq!(stop["session_id"], "session-root-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #409: the plugin turns dsh's own numbers into the vitals row —
    /// the model and window from `request/context`, the context USED from the
    /// step's `usage` (input + cache read + cache write; output is not in
    /// it). A step without usage keeps the last one; a subagent's usage and
    /// window never reach the row.
    #[test]
    fn the_plugin_writes_the_vitals_row_from_dshs_own_usage() {
        let usage = json!({"inputTokens": 11382, "outputTokens": 70, "cacheReadTokens": 384, "cacheWriteTokens": 0, "totalTokens": 11836});
        // A second root step that WROTE cache: dsh's totalTokens is input +
        // output + cacheRead + cacheWrite (dsh-llm-deepseek updateUsage), so
        // the context used is total − output = 20000 + 500 + 3000.
        let written = json!({"inputTokens": 20000, "outputTokens": 900, "cacheReadTokens": 500, "cacheWriteTokens": 3000, "totalTokens": 24400});
        let events_in = json!([
            ["root", {"type":"turn/start","data":{"turn":1}}],
            ["root", {"type":"request/context","data":{"provider":"deepseek-official","model":"deepseek-flash","contextWindow":1000000}}],
            ["root", {"type":"assistant/message","data":{"turn":1,"step":1,"usage":usage,"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}}],
            ["child", {"type":"request/context","data":{"model":"child-model","contextWindow":64000}}],
            ["child", {"type":"assistant/message","data":{"usage":{"inputTokens":60000},"message":{"role":"assistant","content":[{"type":"text","text":"child"}]}}}],
            ["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"text","text":"no usage on this step"}]}}}],
            ["root", {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}]
        ]);
        let Some((code, _, _, dir)) = run_plugin(json!({}), root_and_child(), events_in) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(code, Some(0));
        let row = std::fs::read_to_string(dir.join("tmm/vitals")).unwrap();
        assert_eq!(row, "[dsh] · deepseek-flash · ctx 11766/1000000");
        let v = sniff_dsh(&row);
        assert_eq!((v.model.as_deref(), v.context_pct), (Some("deepseek-flash"), Some(1)));
        let _ = std::fs::remove_dir_all(&dir);

        let cached = json!([
            ["root", {"type":"request/context","data":{"model":"deepseek-flash","contextWindow":100000}}],
            ["root", {"type":"assistant/message","data":{"usage":written,"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}}]
        ]);
        let (_, _, _, dir) = run_plugin(json!({}), root_and_child(), cached).unwrap();
        let row = std::fs::read_to_string(dir.join("tmm/vitals")).unwrap();
        assert_eq!(row, "[dsh] · deepseek-flash · ctx 23500/100000", "cache writes count");
        assert_eq!(sniff_dsh(&row).context_pct, Some(24));
        let _ = std::fs::remove_dir_all(&dir);

        // Before any usage there is no ctx segment, only the model.
        let early = json!([
            ["root", {"type":"request/context","data":{"model":"deepseek-flash","contextWindow":1000000}}],
            ["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[]}}}]
        ]);
        let (_, _, _, dir) = run_plugin(json!({}), root_and_child(), early).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("tmm/vitals")).unwrap(), "[dsh] · deepseek-flash");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #409: only a row at column zero, `[dsh] · ` first, is read, and
    /// the newest one wins. An indented, prompt-prefixed, chat-stamped or
    /// mid-line copy is not; an output line starting exactly with `[dsh] · `
    /// would be (the anchor's stated limit). An impossible ratio is no
    /// percentage.
    #[test]
    fn only_a_column_zero_vitals_row_is_read() {
        let pane = "[dsh] · deepseek-flash · ctx 100000/1000000\nanswer text\n[dsh] · deepseek-pro · ctx 333000/1000000\ndsh › ";
        let v = sniff_dsh(pane);
        assert_eq!((v.model.as_deref(), v.context_pct), (Some("deepseek-pro"), Some(33)), "the newest row");
        assert!(v.effort.is_none() && v.branch.is_none());
        for quoted in [
            "  [dsh] · m · ctx 1/2\n",
            "dsh › [dsh] · m · ctx 1/2\n",
            "[tmm chat 2026-10-17 02:10] human: [dsh] · m · ctx 1/2\n",
            "[dsh]· m · ctx 1/2\n",
            "the row looks like [dsh] · m · ctx 1/2\n",
        ] {
            assert!(sniff_dsh(quoted).is_empty(), "{quoted:?}");
        }
        let over = sniff_dsh("[dsh] · m · ctx 3/2\n");
        assert_eq!((over.model.as_deref(), over.context_pct), (Some("m"), None), "more than the window is no reading");
        assert_eq!(sniff_dsh("[dsh] · m · ctx 1/0\n").context_pct, None);
        assert_eq!(sniff_dsh("[dsh] · m · ctx x/9\n").context_pct, None);
        assert_eq!(sniff_dsh("[dsh] · m · ctx 1000000/1000000\n").context_pct, Some(100));
        assert_eq!(crate::backends::Backend::Dsh.sniff("[dsh] · m · ctx 5/10\n", "deepseek").context_pct, Some(50), "the dispatch reaches it");
    }

    /// Board #409, end to end in a real pane: the shell prints the run's
    /// vitals row once, above the prompt, and the sniff reads the newest.
    /// A shell line (`!true`) after it prints no second copy.
    #[test]
    fn the_shell_paints_each_runs_vitals_row_once_above_the_prompt() {
        let Some(pane) = ScratchPane::start("vitals", &[]) else {
            eprintln!("skipped: no zsh or no tmux server");
            return;
        };
        pane.deliver("first");
        pane.deliver("second");
        wait_for("the prompt after the second run", 10, || pane.screen().trim_end().ends_with(READY_MARKER));
        let screen = pane.screen();
        assert_eq!(screen.matches("[dsh] · fake-model · ctx 250000/1000000").count(), 1, "{screen}");
        assert_eq!(screen.matches("[dsh] · fake-model · ctx 500000/1000000").count(), 1, "{screen}");
        assert_eq!(sniff_dsh(&screen).context_pct, Some(50), "the newest row: {screen}");
        assert!(!pane.dir.join("dsh/tmm/vitals").exists(), "printed once, then gone");
        crate::tmux::send_command(&pane.target(), "!true").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(pane.screen().matches("[dsh] · fake-model").count(), 2, "a shell line repaints nothing");
    }

    /// Board #404 condition 3: with the provider's key unset, the first
    /// prompt is reported, the turn is written as failed, ONE plain line
    /// names the variable, and the process exits before any request.
    #[test]
    fn a_missing_key_fails_the_turn_at_once_with_one_line() {
        let events_in = json!([
            ["root", {"type":"turn/start","data":{"turn":1}}],
            ["root", {"type":"user/message","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"hi"}]}}],
            ["root", {"type":"assistant/message","data":{"message":{"role":"assistant","content":[{"type":"text","text":"never reached"}]}}}]
        ]);
        let Some((code, stderr, hooks, dir)) = run_plugin(json!({"requireEnv": "TMM_TEST_UNSET_KEY"}), root_and_child(), events_in) else {
            eprintln!("skipped: no node");
            return;
        };
        assert_eq!(code, Some(1));
        assert_eq!(stderr, "TMM_TEST_UNSET_KEY is not set\n");
        assert_eq!(events(&hooks), ["UserPromptSubmit"]);
        let stop: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tmm/stop.json")).unwrap()).unwrap();
        assert_eq!(normalize_kind(stop.as_object().unwrap()), Ok("failed"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Escape on a running turn: the plugin holds the TTY raw and a lone ESC
    /// (what tmux sends for the `Escape` key) ends the process by SIGINT.
    #[test]
    fn escape_interrupts_a_run_through_the_plugin() {
        let Some(node) = which("node") else {
            eprintln!("skipped: no node");
            return;
        };
        let dir = std::env::temp_dir().join(format!("tmm-dsh-esc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.mjs"), plugin_js("cat > /dev/null")).unwrap();
        std::fs::write(dir.join("driver.mjs"), "import * as p from './index.mjs'\np.apply({ on() {} }, {})\nprocess.stdout.write('RUNNING\\n')\nsetInterval(() => {}, 1000)\n").unwrap();
        let session = format!("tmm-dsh-esc-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let cmd = format!(
            "cd {} && DSH_HOME=. {} driver.mjs; echo EXIT=$?; sleep 30",
            crate::shell::quote_always(&dir.to_string_lossy()),
            crate::shell::quote_always(&node.to_string_lossy())
        );
        if crate::tmux::run_tmux(&["new-session", "-d", "-s", &session, "-x", "120", "-y", "20", &cmd]).is_err() {
            eprintln!("skipped: no tmux server");
            return;
        }
        // Killed on every exit, a failed assertion included.
        struct Kill(String, std::path::PathBuf);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = crate::tmux::run_tmux(&["kill-session", "-t", &self.0]);
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _kill = Kill(session.clone(), dir.clone());
        let target = pane_id(&session);
        let screen = || crate::tmux::capture_pane_plain(&target, Some(20)).unwrap_or_default();
        wait_for("the run", 10, || screen().contains("RUNNING"));
        crate::tmux::send_keys(&target, "a", false).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!screen().contains("EXIT="), "an ordinary key does not end the run");
        crate::tmux::send_keys(&target, "Escape", false).unwrap();
        wait_for("the interrupt", 5, || screen().contains("EXIT=130"));
    }
}
