//! The JSON-RPC request/response shapes and the main method dispatch
//! (everything a single request can do that doesn't need the connection's
//! push machinery), plus subscribe/unsubscribe bookkeeping.
//! Split from server.rs 2026-07-22 — content unchanged.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::fs as rfs;
use crate::tmux;

use super::download::{download_expiry, scope_base, sign_download, streams};

// JSON-RPC style request/response

#[derive(Deserialize, Debug)]
pub(super) struct Request {
    pub(super) id: Option<u64>,
    pub(super) method: String,
    #[serde(default)]
    pub(super) params: serde_json::Value,
}

#[derive(Serialize, Clone)]
pub(super) struct Response {
    pub(super) id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<ErrorInfo>,
}

#[derive(Serialize, Clone)]
pub(super) struct ErrorInfo {
    pub(super) code: i32,
    pub(super) message: String,
    /// Facts a client needs to ACT on this failure, beside the sentence it
    /// shows the human (board #337): the scratch refusal carries which
    /// project holds the name, so the confirmation the reader approves names
    /// that project and the action can only touch it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) data: Option<serde_json::Value>,
}

// Error codes
pub(super) const ERR_PARSE: i32 = -32700;
pub(super) const ERR_METHOD_NOT_FOUND: i32 = -32601;
pub(super) const ERR_INVALID_PARAMS: i32 = -32602;
pub(super) const ERR_INTERNAL: i32 = -32603;
pub(super) const ERR_AUTH: i32 = -32000;
/// A project holds the scratch terminal's reserved session name (board #337).
/// Its own code so the panel can OFFER the way out without reading the
/// sentence the server composed for the human — one definition of the
/// message, one machine-readable fact beside it.
pub(super) const ERR_SCRATCH_HELD: i32 = -32010;
/// A `scratch_release` refused because the holder the reader confirmed is not
/// the holder now — nothing was touched (board #337). Its own code because
/// the panel RECOVERS from it instead of showing it: it drops the stale
/// snapshot and asks `scratch_session` again, which is the one path that says
/// who holds the name now.
pub(super) const ERR_SCRATCH_STALE: i32 = -32011;

impl Response {
    pub(super) fn ok(id: Option<u64>, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }
    pub(super) fn err(id: Option<u64>, code: i32, message: String) -> Self {
        Self {
            id,
            result: None,
            error: Some(ErrorInfo { code, message, data: None }),
        }
    }
    /// The one place an `RpcError` becomes wire bytes (board #146): the code
    /// is the variant's, the message passes through untouched.
    pub(super) fn from_error(id: Option<u64>, e: RpcError) -> Self {
        match e {
            RpcError::InvalidParams(m) => Self::err(id, ERR_INVALID_PARAMS, m),
            RpcError::Internal(m) => Self::err(id, ERR_INTERNAL, m),
            RpcError::MethodNotFound(m) => Self::err(id, ERR_METHOD_NOT_FOUND, m),
            RpcError::ScratchHeld(m, held) => Response {
                id,
                result: None,
                error: Some(ErrorInfo { code: ERR_SCRATCH_HELD, message: m, data: Some(held) }),
            },
            RpcError::ScratchStale(m) => Self::err(id, ERR_SCRATCH_STALE, m),
        }
    }
    /// Fold a dispatcher's `Result` into a response.
    pub(super) fn from_outcome(id: Option<u64>, r: Result<serde_json::Value, RpcError>) -> Self {
        match r {
            Ok(v) => Self::ok(id, v),
            Err(e) => Self::from_error(id, e),
        }
    }
}

/// A dispatcher error that already knows its wire code (board #146). The
/// dispatchers used to spell `match x { Ok(v) => v, Err(e) => return
/// Response::err(id, CODE, e) }` at every site — ~40 times — with the code
/// chosen per site; this carries that choice so the site can say `?`. It is
/// an enum and not a string prefix on purpose: `handle_project_request`
/// classifies by sniffing `starts_with("missing required param")`, and that
/// rule would file the hub's `"id required"` under INTERNAL when every such
/// site says INVALID_PARAMS. The codes are contracts (`tmm` exit classes,
/// the client's old-server detection), so they stay explicit per site.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RpcError {
    InvalidParams(String),
    Internal(String),
    MethodNotFound(String),
    /// `scratch_session` refused because a PROJECT holds the reserved name —
    /// the one refusal the client can act on (board #337). Carries the
    /// holder as DATA, so the confirmation the reader sees and the release
    /// they approve are about one identified project, not about whoever
    /// happens to hold the name when the action runs.
    ScratchHeld(String, serde_json::Value),
    /// `scratch_release` refused because the reader's snapshot is stale and
    /// nothing was touched (board #337). No `data`: who holds the name now is
    /// `scratch_session`'s answer to give, and one definition of that fact is
    /// the point — a second copy on this error could already be out of date
    /// by the time the panel acted on it.
    ScratchStale(String),
}

/// The scratch terminal's session is hidden from every listing (board #326,
/// owner: "不需要作为一个真实的 project 显示出来，就是一个隐藏的会话就好").
/// ONE predicate decides it — `projects::scratch::hidden_session`, derived
/// from `scratch::owned` — and these two methods are the only listing doors
/// (the Sessions page, Terminal's pane picker, the Hub drawer and App's
/// first pick all read them). Targeted calls are untouched: the panel still
/// subscribes, captures, types into and resizes its own pane.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn hidden_session() -> Option<String> {
    crate::projects::scratch::hidden_session()
}
/// A phone is a client of a desktop server and has no projects module, so
/// there is no scratch session of its own to hide.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn hidden_session() -> Option<String> {
    None
}

fn hide_scratch(sessions: Vec<tmux::TmuxSession>) -> Vec<tmux::TmuxSession> {
    without_hidden(sessions, hidden_session().as_deref(), |s| &s.name)
}

/// Drop the hidden session's rows from a listing — the ONE filter both
/// listing doors use, for sessions and for their panes. `None` hides nothing.
fn without_hidden<T>(rows: Vec<T>, hidden: Option<&str>, session_of: impl Fn(&T) -> &str) -> Vec<T> {
    let Some(hidden) = hidden else { return rows };
    rows.into_iter().filter(|r| session_of(r) != hidden).collect()
}

/// `require_str` as a `?`-able INVALID_PARAMS — the missing-param message is
/// byte-identical to what every `match require_str` site returned.
pub(super) fn param<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str, RpcError> {
    require_str(params, key).map_err(RpcError::InvalidParams)
}

// Per-connection subscription state: target -> last captured content
pub(super) type Subscriptions = Arc<Mutex<HashMap<String, String>>>;

pub(super) fn require_str<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing required param: {}", key))
}

pub(super) fn valid_process_arg(arg: &str) -> bool {
    !arg.contains('\0')
}

/// The dispatcher proper (board #146): every arm is a `Result`, so a missing
/// param or a tmux/fs error is a `?` with its wire code already chosen
/// (`RpcError`), and `handle_request` below is the one place a `Response`
/// is built (`Response::from_outcome`). Arm order and every message are exactly what the inline
/// `match … return Response::err` shape produced.
fn dispatch(req: &Request, token: &str) -> Result<serde_json::Value, RpcError> {
    let p = &req.params;

    match req.method.as_str() {
        "ping" => Ok(serde_json::json!("pong")),

        // Does this gateway serve the web UI on its own port (board #323)?
        // The same source rule and check the static requests use, so `tmm ui`
        // never says ok for a ui_dir that 404s. Authenticated like every
        // method; no params; nothing about the token.
        "ui_info" => {
            let src = super::ui::source();
            Ok(match super::ui::check(&src) {
                Ok(kind) => serde_json::json!({ "served": true, "source": kind }),
                Err(why) => serde_json::json!({ "served": false, "reason": why }),
            })
        }

        // The backends this server can spawn, with the client's resource
        // names for each (board #130). No params, no session, no gate: the
        // list lives in the ungated `backends` leaf, so a phone-hosted
        // server answers too. The client drops its hand-kept mirrors for
        // this and falls back to them only when an OLDER server says
        // method-not-found.
        "backends_list" => {
            Ok(serde_json::json!({ "backends": crate::backends::Backend::list_json() }))
        }

        // ---- server system vitals (board #56) ------------------------------
        // Desktop-only like the project_* methods: the sampler is not
        // compiled for Android/iOS (a phone is a client of a desktop server),
        // where this reports method-not-found and the client shows nothing.
        // No params, fail-soft by construction: a reading is always returned,
        // with unknowable fields as null/0 for the client's verdict rule.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        "system_status" => {
            Ok(serde_json::to_value(crate::system_status::read()).unwrap())
        }

        "list_sessions" => {
            let sessions = hide_scratch(tmux::list_sessions().map_err(RpcError::Internal)?);
            Ok(serde_json::to_value(&sessions).unwrap())
        },

        "list_panes" => {
            let session = param(p, "session")?;
            let panes = tmux::list_panes(session).map_err(RpcError::Internal)?;
            Ok(serde_json::to_value(&panes).unwrap())
        }

        // Combined sessions + panes in one round-trip. The Sessions page
        // needs both to render its summary chips (cwd, current command, AI
        // detection) — issuing them as 1 + N RPCs added perceivable latency
        // when N grew beyond a handful. Single tmux call now returns
        // everything; client groups panes by session_name client-side.
        "list_sessions_with_panes" => {
            let sessions = match tmux::list_sessions() {
                Ok(v) => v,
                Err(e) => return Err(RpcError::Internal(e)),
            };
            let panes = match tmux::list_all_panes() {
                Ok(v) => v,
                Err(e) => return Err(RpcError::Internal(e)),
            };
            let hidden = hidden_session();
            Ok(serde_json::json!({
                "sessions": without_hidden(sessions, hidden.as_deref(), |s| &s.name),
                "panes": without_hidden(panes, hidden.as_deref(), |p| &p.session),
            }))
        }

        "capture_pane" => {
            let target = param(p, "target")?;
            let lines = p.get("lines").and_then(|v| v.as_u64()).map(|n| n as usize);
            let output = tmux::capture_pane(target, lines).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "output": output }))
        }

        "send_keys" => {
            let target = param(p, "target")?;
            let keys = param(p, "keys")?;
            let literal = p.get("literal").and_then(|v| v.as_bool()).unwrap_or(false);
            tmux::send_keys(target, keys, literal).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "paste_text" => {
            let target = param(p, "target")?;
            let text = param(p, "text")?;
            tmux::paste_text(target, text).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "send_command" => {
            let target = param(p, "target")?;
            let command = param(p, "command")?;
            tmux::send_command(target, command).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // resize_pane is handled in the connection message loop (needs per-connection state)
        "resize_pane" => Err(RpcError::Internal("resize_pane handled elsewhere".into())),

        "new_session" => {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("untitled");
            let path = p.get("path").and_then(|v| v.as_str());
            let command = p.get("command").and_then(|v| v.as_str());
            tmux::new_session(name, path, command).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        // The scratch terminal's session (board #324): ensure answers
        // {session, target}; kill only ever kills OUR session.
        // Desktop-gated like `projects` (lib.rs): a phone is a client of a
        // desktop server, so on Android/iOS these are MethodNotFound.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        "scratch_session" => crate::projects::scratch::ensure().map_err(|why| {
            // One refusal the panel can DO something about: a project holds
            // the name. Classified by asking the same predicate the refusal
            // came from, never by reading its sentence, and the holder travels
            // with it so the reader confirms a named project (board #337).
            match crate::projects::scratch::holder() {
                Some(held) => RpcError::ScratchHeld(why, held),
                None => RpcError::Internal(why),
            }
        }),
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        "scratch_kill" => crate::projects::scratch::kill().map_err(RpcError::Internal),
        // Board #337: the reserved name is held by a project, so the panel is
        // refused — this is the reader's confirmed way out. Never automatic:
        // it renames someone's project row, so only they can ask for it.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        "scratch_release" => {
            // The project the reader approved, not whoever holds the name when
            // this arrives (board #337 review): the server renames only if
            // that project still declares that session right now.
            let project = param(p, "projectId")?;
            let session = param(p, "session")?;
            // The refusal's own classification, not a sentence read here
            // (board #337): a stale snapshot is the one the panel recovers
            // from, so it travels as its own code.
            crate::projects::scratch::release(project, session).map_err(|e| match e {
                crate::projects::Refused::Stale(m) => RpcError::ScratchStale(m),
                crate::projects::Refused::Failed(m) => RpcError::Internal(m),
            })
        }

        "kill_session" => {
            let name = param(p, "name")?;
            // A person's down, durable before the kill (board #422, F3).
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            crate::projects::record_session_kill(name)
                .map_err(|e| RpcError::Internal(format!("'{name}' was not killed — its down could not be recorded: {e}")))?;
            tmux::kill_session(name).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "new_window" => {
            let session = param(p, "session")?;
            tmux::new_window(session).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "kill_window" => {
            let target = param(p, "target")?;
            // ONE close operation (board #422, F3): resolve the window to its
            // native @id, record a managed agent's Stop, kill that @id.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            crate::projects::close_window(target).map_err(|e| RpcError::Internal(format!("'{target}' was not killed: {e}")))?;
            #[cfg(any(target_os = "android", target_os = "ios"))]
            tmux::kill_window(target).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "pane_command" => {
            let target = param(p, "target")?;
            let cmd = tmux::pane_command(target).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "command": cmd }))
        }

        "set_socket" => {
            let socket = p
                .get("socket")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            tmux::set_socket(socket);
            Ok(serde_json::json!({ "ok": true }))
        }

        "get_bookmarks" => {
            let bookmarks = crate::config::get_bookmarks();
            Ok(serde_json::json!({ "bookmarks": bookmarks }))
        }

        "save_bookmarks" => {
            let bookmarks: Vec<String> = p
                .get("bookmarks")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            crate::config::save_bookmarks(&bookmarks).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "get_prefs" => {
            Ok(crate::config::get_prefs())
        }

        "set_pref" => {
            let key = param(p, "key")?;
            let value = p.get("value").cloned().unwrap_or(serde_json::Value::Null);
            crate::config::set_prefs(key, value).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "fs_cwd" => {
            let session = param(p, "session")?;
            let path = rfs::get_cwd(session).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "path": path }))
        }

        "fs_list" => {
            let path = param(p, "path")?;
            let show_hidden = p
                .get("show_hidden")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let entries = rfs::list_dir(path, show_hidden).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "entries": entries, "path": path }))
        }

        "fs_stat" => {
            let path = param(p, "path")?;
            let stat = rfs::stat_file(path).map_err(RpcError::Internal)?;
            Ok(serde_json::to_value(&stat).unwrap())
        }

        "fs_read" => {
            let path = param(p, "path")?;
            // `revision` (board #434): the sha256 of the very bytes the content
            // was decoded from, so a review never compares a second read.
            let (content, revision) = rfs::read_file_with_revision(path).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "content": content, "revision": revision }))
        }

        "fs_write" => {
            let path = param(p, "path")?;
            // Allow empty content (creating empty files is valid)
            let content = p.get("content").and_then(|v| v.as_str()).unwrap_or("");
            rfs::write_file(path, content).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "fs_mkdir" => {
            let path = param(p, "path")?;
            rfs::create_dir(path).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "fs_delete" => {
            let path = param(p, "path")?;
            rfs::delete_path(path).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "fs_rename" => {
            let from = param(p, "from")?;
            let to = param(p, "to")?;
            rfs::rename_path(from, to).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "fs_download" => {
            let path = param(p, "path")?;
            let (name, data) = rfs::download_file(path).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "name": name, "data": data }))
        }

        "fs_download_url" => {
            let path = param(p, "path")?;
            // `stream: true` = a media element will keep coming back to this
            // URL for the whole playback (board #182); the expiry and the
            // mode are signed, and only what a <video> plays may stream.
            let stream = p.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
            if stream && !streams(path) {
                return Err(RpcError::InvalidParams("stream: not a media file".into()));
            }
            let exp = download_expiry(stream);
            let sig = sign_download(token, stream, path, exp);
            let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("file");
            let qs = format!("/dl?path={}&exp={}&sig={}{}", urlencoding::encode(path), exp, sig, if stream { "&stream=1" } else { "" });
            Ok(serde_json::json!({ "url": qs, "name": name }))
        }

        "fs_preview_base" => {
            // An HTML preview's directory cap (board #433). The client sends
            // ONLY the HTML path; the root is derived and canonicalized here.
            let path = param(p, "path")?;
            let (root, dir) = preview_scope(path, &declared_project_paths()).map_err(RpcError::InvalidParams)?;
            let base = scope_base(token, &root, &dir).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "base": base }))
        }

        "fs_upload" => {
            let path = param(p, "path")?;
            let data = param(p, "data")?;
            rfs::upload_file(path, data).map_err(RpcError::Internal)?;
            Ok(serde_json::json!({ "ok": true }))
        }

        "git" => {
            let subcmd = param(p, "subcmd")?;
            let args: Vec<String> = p
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cwd = p.get("cwd").and_then(|v| v.as_str());

            const ALLOWED: &[&str] = &[
                "status", "diff", "log", "show", "branch", "rev-parse", "push", "add", "commit", "restore",
            ];
            if !ALLOWED.contains(&subcmd) {
                return Err(RpcError::InvalidParams(format!("git subcommand not allowed: {}", subcmd)));
            }
            // Arguments go directly to Command::args; no shell parses them.
            // Characters such as `|` are data (git log format separators),
            // not operators. Only NUL is impossible to represent in argv.
            for arg in &args {
                if !valid_process_arg(arg) {
                    return Err(RpcError::InvalidParams("invalid characters in argument".into()));
                }
            }

            let mut child = std::process::Command::new("git");
            child.arg(subcmd);
            child.args(&args);
            if let Some(d) = cwd {
                child.current_dir(d);
            }
            let output = child.output().map_err(|e| RpcError::Internal(e.to_string()))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(serde_json::json!({ "stdout": stdout, "stderr": stderr, "code": output.status.code() }))
        }

        // ---- projects (declarative workspaces) ----------------------------
        // Desktop-only: state.db and the reconciler are not compiled for
        // Android/iOS, where these methods report method-not-found and the
        // client hides the page (same contract as the team_* methods).
        "project_list" | "project_create" | "project_adopt" | "project_up" | "project_down"
        | "project_archive" | "project_delete" | "project_autostart" | "project_rename"
        | "registry_list" | "registry_save" | "registry_delete" | "models_list"
        | "global_prompt_get" | "global_prompt_set"
        | "teams_list" | "teams_save" | "teams_delete"
        | "skills_list" | "skills_save" | "skills_delete" | "skills_refresh" | "skills_read"
        | "skills_import" | "skills_files" | "skills_file" | "skills_load"
        | "mcp_list" | "mcp_save" | "mcp_delete" | "project_restore"
        | "review_list" | "review_add" | "review_update" | "review_delete" | "review_feedback" => {
            handle_project_request(req.method.as_str(), p)
        }

        "fs_convert" => {
            let path = param(p, "path")?;
            let format = p.get("format").and_then(|v| v.as_str()).unwrap_or("html");
            if format != "html" {
                return Err(RpcError::InvalidParams("only html format supported".into()));
            }
            let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            match ext.as_str() {
                "pptx" => {
                    let html = crate::pptx::to_html(std::path::Path::new(path)).map_err(RpcError::Internal)?;
                    Ok(serde_json::json!({ "html": html }))
                },
                _ => Err(RpcError::InvalidParams(format!("unsupported file type: .{}", ext))),
            }
        }

        _ => Err(RpcError::MethodNotFound(format!("unknown method: {}", req.method))),
    }
}

pub(super) fn handle_request(req: &Request, token: &str) -> Response {
    Response::from_outcome(req.id, dispatch(req, token))
}


/// Where an HTML preview's cap is rooted (board #433), and the HTML's
/// directory below that root, both CANONICAL: the longest declared project
/// path that contains the file, else the file's own directory. A root of `/`
/// or of the home directory would be a whole-machine or whole-home cap, so it
/// falls back to the file's directory, and if that is one of them too, no cap
/// is minted. Only .html/.htm regular files get one, and not through a
/// symlink of their own (review P2): its resources would come from the
/// target's directory while Files opens its links from the link's, so v1
/// previews it without resources. A directory symlink on the way is fine:
/// both resolve to the same physical directory.
fn preview_scope(path: &str, projects: &[String]) -> Result<(String, Vec<String>), String> {
    let spelled = rfs::expand_path(path);
    if std::fs::symlink_metadata(&spelled).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{path}: a symlinked HTML file is previewed without its resources"));
    }
    let html = std::fs::canonicalize(&spelled).map_err(|e| format!("{path}: {e}"))?;
    let meta = std::fs::metadata(&html).map_err(|e| format!("{path}: {e}"))?;
    let ext = html.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !meta.is_file() || !(ext == "html" || ext == "htm") {
        return Err(format!("{path}: not an HTML file"));
    }
    let parent = html.parent().ok_or_else(|| format!("{path}: no directory"))?.to_path_buf();
    let home = dirs::home_dir().and_then(|h| std::fs::canonicalize(h).ok());
    let too_wide = |p: &std::path::Path| p == std::path::Path::new("/") || home.as_deref() == Some(p);
    let declared = projects.iter()
        .filter_map(|p| std::fs::canonicalize(rfs::expand_path(p)).ok())
        .filter(|p| parent.starts_with(p) && !too_wide(p))
        .max_by_key(|p| p.components().count());
    let root = match declared {
        Some(root) => root,
        None if !too_wide(&parent) => parent.clone(),
        None => return Err(format!("{path}: its directory is too wide to share as a preview scope")),
    };
    let dir = parent.strip_prefix(&root).map_err(|_| format!("{path}: outside its scope"))?
        .components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    Ok((root.to_string_lossy().into_owned(), dir))
}

/// Every declared project's path, archived included: the candidates for a
/// preview's scope root. The mobile server declares none.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn declared_project_paths() -> Vec<String> {
    let Ok(listed) = crate::projects::list(true) else { return Vec::new() };
    listed["projects"].as_array().map(|rows| rows.iter()
        .filter_map(|r| r["project"]["path"].as_str().map(str::to_string))
        .collect()).unwrap_or_default()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn declared_project_paths() -> Vec<String> {
    Vec::new()
}

/// The `project_*` methods. One function so the platform gate lives in exactly
/// one place: on mobile every method reports method-not-found and the client
/// hides the Projects page.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_project_request(method: &str, p: &serde_json::Value) -> Result<serde_json::Value, RpcError> {
    use crate::projects;

    let need_id = |key: &str| -> Result<String, String> { require_str(p, key).map(str::to_string) };
    let flag = |key: &str, default: bool| p.get(key).and_then(|v| v.as_bool()).unwrap_or(default);

    let outcome = match method {
        "project_list" => projects::list(flag("include_archived", false)),
        "project_create" => need_id("path").and_then(|path| {
            projects::create(
                &path,
                p.get("name").and_then(|v| v.as_str()),
                p.get("session").and_then(|v| v.as_str()),
                p.get("agent").and_then(|v| v.as_str()),
            )
        }),
        "project_adopt" => need_id("session").and_then(|session| {
            projects::adopt(&session, p.get("name").and_then(|v| v.as_str()))
        }),
        "project_up" => need_id("id").and_then(|id| projects::up(&id)),
        // Board #434: review annotations on a project's files. The server
        // alone resolves the project (by id, or a `tmm` caller's session),
        // its verified root and the canonical relpath (`projects::review`).
        "review_list" => projects::review::list(p),
        "review_add" => projects::review::add(p),
        "review_update" => projects::review::update(p),
        "review_delete" => projects::review::delete(p),
        "review_feedback" => projects::review::feedback_rpc(p),
        // Board #422 round 4: the reboot restore's manual doors, one RPC.
        "project_restore" => projects::restore_run::restore_rpc(p.get("action").and_then(|v| v.as_str()).unwrap_or("show")),
        "project_down" => need_id("id").and_then(|id| projects::down(&id)),
        // The name is a label, so this touches nothing else: the session stays
        // the project's identity and the chat room keeps its key.
        "project_rename" => need_id("id")
            .and_then(|id| need_id("name").and_then(|name| projects::rename(&id, &name))),
        // Archive hides and is reversible; delete forgets the project and wipes
        // the isolated homes of the agents it owned.
        "project_delete" => need_id("id").and_then(|id| projects::delete(&id)),
        "project_archive" => {
            need_id("id").and_then(|id| projects::set_archived(&id, flag("archived", true)))
        }
        "project_autostart" => {
            need_id("id").and_then(|id| projects::set_autostart(&id, flag("autostart", true)))
        }
        // Agent registry (agents-v2): centrally-defined agents, spawnable into
        // any project. See docs/design-docs/features/tmm-cli.md.
        "registry_list" => projects::registry_list(),
        "registry_save" => match p.get("def") {
            Some(def) => projects::registry_save(def),
            None => Err("missing required param: def".into()),
        },
        "registry_delete" => need_id("name").and_then(|n| projects::registry_delete(&n)),
        // The app-wide agent instructions (`<config>/AGENTS.md`): one file,
        // prepended to every managed agent's prompt at spawn.
        "global_prompt_get" => projects::global_prompt_get(),
        "global_prompt_set" => match p.get("text").and_then(|v| v.as_str()) {
            Some(text) => projects::global_prompt_set(text),
            None => Err("missing required param: text".into()),
        },
        // Agent teams (board #74): a named list of members derived from
        // registry agents (+ role) or defined inline for this team only.
        "teams_list" => projects::teams_list(),
        "teams_save" => match p.get("def") {
            Some(def) => projects::teams_save(def),
            None => Err("missing required param: def".into()),
        },
        "teams_delete" => need_id("name").and_then(|n| projects::teams_delete(&n)),
        // The model ids a backend accepts, so the agent editor can offer them
        // instead of letting a one-character typo through. `null` means the
        // backend cannot enumerate them (claude/codex) — the field stays free
        // text there.
        "models_list" => {
            // Absent backend = the documented default (board #127); the literal
            // lived inline here and was invisible to the backend map.
            let backend = p.get("backend").and_then(|v| v.as_str()).unwrap_or(crate::backends::Backend::DEFAULT.name());
            Ok(serde_json::json!({
                "backend": backend,
                "models": projects::models::list(backend),
            }))
        }
        // Central skills / MCP assets (owner: "集中化管理") — referenced from
        // agent defs by name, resolved at spawn.
        "skills_list" => projects::skills_list(),
        "skills_save" => match p.get("def") {
            Some(def) => projects::skill_save(def),
            None => Err("missing required param: def".into()),
        },
        "skills_delete" => need_id("name").and_then(|n| projects::skill_delete(&n)),
        "skills_refresh" => need_id("name").and_then(|n| projects::skill_refresh(&n)),
        "skills_read" => need_id("name").and_then(|n| projects::skill_read(&n)),
        "skills_import" => require_str(p, "source").and_then(|s| projects::skill_import(s)),
        "skills_files" => need_id("name").and_then(|n| projects::skill_files(&n)),
        "skills_load" => need_id("name").and_then(|n| projects::skill_load(&n)),
        "skills_file" => need_id("name").and_then(|n| {
            require_str(p, "path").and_then(|f| projects::skill_file(&n, f))
        }),
        "mcp_list" => projects::mcp_list(),
        "mcp_save" => match p.get("def") {
            Some(def) => projects::mcp_save(def),
            None => Err("missing required param: def".into()),
        },
        "mcp_delete" => need_id("name").and_then(|n| projects::mcp_delete(&n)),
        other => Err(format!("unknown project method: {other}")),
    };

    // A missing/blank param is the client's fault, everything else is ours.
    // (A string sniff, kept as it was — board #146 typed the outcome without
    // changing which code any message gets.)
    outcome.map_err(|e| {
        if e.starts_with("missing required param") {
            RpcError::InvalidParams(e)
        } else {
            RpcError::Internal(e)
        }
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn handle_project_request(method: &str, _p: &serde_json::Value) -> Result<serde_json::Value, RpcError> {
    Err(RpcError::MethodNotFound(format!("{method} is unavailable on this platform")))
}

// Subscription polling task: captures pane content and sends diffs
pub(super) fn handle_subscribe(params: &serde_json::Value, subs: &mut HashMap<String, String>) -> Response {
    // Subscriptions answer without an id (they are notifications on the wire).
    let target = match param(params, "target") {
        Ok(t) => t,
        Err(e) => return Response::from_error(None, e),
    };
    subs.insert(target.to_string(), String::new());
    // Record "last opened from tmux-mobile" for MRU sorting on the Sessions
    // page. Target is "name:window.pane"; the session name is everything
    // before the first colon.
    let session_name = target.split(':').next().unwrap_or(target);
    if !session_name.is_empty() {
        let _ = crate::config::touch_session(session_name);
    }
    Response::ok(None, serde_json::json!({ "subscribed": target }))
}

pub(super) fn handle_unsubscribe(params: &serde_json::Value, subs: &mut HashMap<String, String>) -> Response {
    let target = match param(params, "target") {
        Ok(t) => t,
        Err(e) => return Response::from_error(None, e),
    };
    subs.remove(target);
    Response::ok(None, serde_json::json!({ "unsubscribed": target }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one listing filter (board #326): both doors drop the hidden
    /// session's rows — the session AND its panes — and nothing else, while a
    /// `None` verdict (not ours, or a failed read) hides nothing. The owner's
    /// quick terminal is reached through its panel, not through a list.
    #[test]
    fn the_hidden_session_leaves_both_listings_but_nothing_else_does() {
        let sessions = ["tmm-scratch", "work", "tmm-scratchpad"];
        let kept = without_hidden(sessions.to_vec(), Some("tmm-scratch"), |s| s);
        assert_eq!(kept, ["work", "tmm-scratchpad"], "exact name only — a prefix is a different session");
        assert_eq!(without_hidden(sessions.to_vec(), None, |s| s), sessions, "no verdict hides nothing");
        // Panes are filtered by the session they belong to, through the same
        // definition — a listing that kept the panes would still leak it.
        let panes = [("tmm-scratch", 1usize), ("work", 0)];
        let kept = without_hidden(panes.to_vec(), Some("tmm-scratch"), |p| p.0);
        assert_eq!(kept, [("work", 0usize)]);
    }

    /// The typed error reproduces the exact wire shape of the hand-written
    /// sites it replaces (board #146).
    #[test]
    fn rpc_error_carries_its_code_and_passes_the_message_through() {
        let r = Response::from_error(Some(7), RpcError::InvalidParams("missing required param: x".into()));
        let e = r.error.unwrap();
        assert_eq!((r.id, e.code, e.message.as_str()), (Some(7), ERR_INVALID_PARAMS, "missing required param: x"));
        let e = Response::from_error(None, RpcError::Internal("boom".into())).error.unwrap();
        assert_eq!((e.code, e.message.as_str()), (ERR_INTERNAL, "boom"));
        let e = Response::from_error(None, RpcError::MethodNotFound("unknown method: z".into())).error.unwrap();
        assert_eq!((e.code, e.message.as_str()), (ERR_METHOD_NOT_FOUND, "unknown method: z"));
        assert_eq!(param(&serde_json::json!({}), "session"), Err(RpcError::InvalidParams("missing required param: session".into())));
        assert_eq!(param(&serde_json::json!({"session": ""}), "session"), Err(RpcError::InvalidParams("missing required param: session".into())));
        assert_eq!(param(&serde_json::json!({"session": "s"}), "session"), Ok("s"));
        let ok = Response::from_outcome(Some(1), Ok(serde_json::json!({"a": 1})));
        assert!(ok.error.is_none() && ok.result.is_some());
    }


    #[test]
    fn git_arguments_allow_literal_log_separators() {
        assert!(valid_process_arg("--format=%h|%s|%ar|%an"));
        assert!(valid_process_arg("subject; $HOME & <literal>"));
        assert!(!valid_process_arg("bad\0argument"));
    }

    /// Board #422 (validator F3): a kill through the Sessions page is a
    /// person's down / Stop, recorded before the kill — the session of a
    /// project gets a down mark, a managed agent's window a Stop mark, and a
    /// window that is no managed agent's gets none.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn sessions_page_kills_record_the_persons_intent() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-kill-{}", std::process::id());
        let ws = std::env::temp_dir().join(format!("tmm-kill-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let cwd = ws.to_string_lossy().to_string();
        assert!(tmux::new_session(&session, Some(&cwd), Some("sleep 600")).is_ok());
        tmux::rename_window(&format!("{session}:^"), "dev").unwrap();
        tmux::new_named_window(&session, "plain", &cwd).unwrap();
        tmux::new_named_window(&session, "keep", &cwd).unwrap();
        crate::projects::adopt(&session, Some("kill-test")).unwrap();
        let id = crate::projects::project_for_session(&session).unwrap().unwrap().id;
        let call = |method: &str, params: serde_json::Value| handle_request(&Request { id: Some(1), method: method.into(), params }, "");
        let intents = crate::projects::tests::restore_intents;

        let r = call("kill_window", serde_json::json!({ "target": format!("{session}:plain") }));
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        assert!(!intents().stopped.contains(&(id.clone(), "plain".to_string())), "control: a plain window is no agent's Stop");
        let r = call("kill_window", serde_json::json!({ "target": format!("{session}:dev") }));
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        assert!(intents().stopped.contains(&(id.clone(), "dev".to_string())), "a managed agent's window: its Stop");
        assert!(!intents().down.contains(&id));
        let r = call("kill_session", serde_json::json!({ "name": session }));
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        assert!(intents().down.contains(&id), "a project's session: its down");
        assert!(!tmux::session_exists(&session));

        let _ = crate::projects::delete(&id);
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #56: the router answers `system_status` with the documented
    /// wire shape — no params required, never an error (fail-soft is the
    /// module's contract; the router must not add a failure mode).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn system_status_routes_and_answers_the_wire_shape() {
        let req = Request {
            id: Some(7),
            method: "system_status".into(),
            params: serde_json::json!({}),
        };
        let resp = handle_request(&req, "");
        assert!(resp.error.is_none(), "system_status must be fail-soft");
        let v = resp.result.expect("a reading");
        for k in ["cpu_pct", "mem_used", "mem_total", "disk_used", "disk_total"] {
            assert!(v.get(k).is_some(), "missing key {k}");
        }
        assert!(v["mem_total"].as_u64().unwrap_or(0) > 0, "memory reads on a live machine");
    }

    fn convert(path: &str) -> Response {
        let req = Request {
            id: Some(1),
            method: "fs_convert".into(),
            params: serde_json::json!({ "path": path }),
        };
        handle_request(&req, "")
    }

    #[test]
    fn fs_convert_reports_errors_without_shelling_out() {
        // Conversion runs in-process, so failures are short messages — not a
        // Python traceback leaking into the preview pane.
        let err = convert("/nonexistent/deck.pptx").error.expect("error");
        assert_eq!(err.code, ERR_INTERNAL);
        assert!(err.message.starts_with("open:"), "{}", err.message);

        let err = convert("/tmp/notes.txt").error.expect("error");
        assert_eq!(err.code, ERR_INVALID_PARAMS);
        assert!(err.message.contains("unsupported file type: .txt"), "{}", err.message);
    }

    /// Board #433: the preview cap's root is derived HERE, canonical, from
    /// the declared projects and the file's real location; the client only
    /// names the file.
    #[test]
    fn a_preview_scope_is_the_longest_declared_project_else_the_files_directory() {
        let base = std::env::temp_dir().join(format!("tmm-433-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("proj/site/pages")).unwrap();
        let base = base.canonicalize().unwrap();
        let html = base.join("proj/site/pages/index.html");
        std::fs::write(&html, "<p>x</p>").unwrap();
        std::fs::write(base.join("proj/site/notes.txt"), "x").unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().to_string();
        let proj = s(&base.join("proj"));
        let site = s(&base.join("proj/site"));
        // The longest declared project that contains the file wins.
        let (root, dir) = preview_scope(&s(&html), &[proj.clone(), site.clone(), "/elsewhere".into()]).unwrap();
        assert_eq!((root.as_str(), dir), (site.as_str(), vec!["pages".to_string()]));
        // No declaration: the file's own directory, nothing below it.
        let (root, dir) = preview_scope(&s(&html), &[]).unwrap();
        assert_eq!((root, dir), (s(&base.join("proj/site/pages")), Vec::<String>::new()));
        // A project at '/' is a whole-machine cap: the file's directory instead.
        let (root, _) = preview_scope(&s(&html), &["/".into()]).unwrap();
        assert_eq!(root, s(&base.join("proj/site/pages")));
        // A spelling through a symlink resolves to the same canonical root.
        std::os::unix::fs::symlink(base.join("proj"), base.join("alias")).unwrap();
        let (root, _) = preview_scope(&s(&base.join("alias/site/pages/index.html")), &[s(&base.join("alias"))]).unwrap();
        assert_eq!(root, proj, "canonical, never the symlink's spelling");
        // The HTML file itself as a symlink: refused, so its resources and
        // its clicked links can never come from two directories.
        std::os::unix::fs::symlink(&html, base.join("proj/link.html")).unwrap();
        let refused = preview_scope(&s(&base.join("proj/link.html")), &[]).unwrap_err();
        assert!(refused.contains("symlinked"), "{refused}");
        // Only an HTML file gets a cap.
        assert!(preview_scope(&s(&base.join("proj/site/notes.txt")), &[]).is_err());
        assert!(preview_scope(&s(&base.join("proj/site")), &[]).is_err(), "a directory");
        assert!(preview_scope(&s(&base.join("proj/missing.html")), &[]).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Validator V1 on 60414c91: a save door's parse error never quotes what was
    /// submitted (serde's `invalid type: string "<value>"`), at every shape a
    /// value can sit in that is not the expected one.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_save_with_a_value_in_the_wrong_shape_is_refused_without_echoing_it() {
        use serde_json::json;
        crate::projects::tests::use_test_store();
        let secret = format!("SENTINEL-451v-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let call = |method: &str, params: serde_json::Value| handle_request(&Request { id: Some(1), method: method.into(), params }, "");
        let quoted = serde_json::to_string(&secret).unwrap();
        let bare = |skills: &str, mcp: &str| json!({ "name": "m", "agent": { "name": "", "backend": "kiro", "model": "", "effort": "", "system": "x", "skills": skills, "mcp": mcp } });
        let cases = [
            ("teams_save", json!({ "def": { "name": "v451t", "members": json!([secret]).to_string() } })),
            ("teams_save", json!({ "def": { "name": "v451t", "members": json!([[{ "env": { "K": secret } }]]).to_string() } })),
            ("teams_save", json!({ "def": { "name": "v451t", "members": json!([bare(&quoted, "[]")]).to_string() } })),
            ("teams_save", json!({ "def": { "name": "v451t", "members": json!([bare("[]", &quoted)]).to_string() } })),
            ("teams_save", json!({ "def": { "name": "v451t", "members": quoted.clone() } })),
            ("registry_save", json!({ "def": { "name": "v451a", "backend": "kiro", "system": "x", "skills": quoted.clone(), "mcp": "[]" } })),
            ("registry_save", json!({ "def": { "name": "v451a", "backend": "kiro", "system": "x", "skills": "[]", "mcp": quoted.clone() } })),
            ("mcp_save", json!({ "def": { "name": "v451c", "def": quoted.clone() } })),
        ];
        for (method, params) in cases {
            let r = call(method, params.clone());
            let e = r.error.unwrap_or_else(|| panic!("{method} {params}: accepted")).message;
            assert!(!e.contains(&secret), "{method} {params}: echoed: {e}");
        }
        assert!(crate::projects::team_get("v451t").unwrap().is_none() && crate::projects::registry_get("v451a").unwrap().is_none(), "nothing was written");
    }

    /// Board #451: no definition read carries an MCP env or header value —
    /// the three read doors, as a client calls them — while the store keeps
    /// every value, a listed definition saved back unchanged keeps them, and
    /// a marker with nothing behind it writes nothing. `tmm` reads only these
    /// answers, so this is also what `tmm mcp list` and the `--json` lists print.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn no_definition_read_carries_an_mcp_value_and_a_listed_definition_saves_back_whole() {
        use serde_json::json;
        crate::projects::tests::use_test_store();
        let tag = &uuid::Uuid::new_v4().to_string()[..8];
        let secret = format!("SENTINEL-451-{tag}");
        let (central, agent, team) = (format!("c451-{tag}"), format!("a451-{tag}"), format!("t451-{tag}"));
        let call = |method: &str, params: serde_json::Value| handle_request(&Request { id: Some(1), method: method.into(), params }, "");
        let ok = |method: &str, params: serde_json::Value| {
            let r = call(method, params);
            assert!(r.error.is_none(), "{method}: {:?}", r.error.map(|e| e.message));
            r.result.unwrap()
        };
        struct Cleanup(String, String, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = crate::projects::mcp_delete(&self.0);
                let _ = crate::projects::registry_delete(&self.1);
                let _ = crate::projects::teams_delete(&self.2);
            }
        }
        let _cleanup = Cleanup(central.clone(), agent.clone(), team.clone());

        let inline_agent = |mcp: serde_json::Value| json!({ "name": "", "backend": "kiro", "model": "", "effort": "", "system": "x", "skills": "[]", "mcp": mcp.to_string() });
        ok("mcp_save", json!({ "def": { "name": central, "def": json!({ "url": "https://mcp.example", "headers": { "Authorization": format!("Bearer {secret}") } }).to_string() } }));
        ok("registry_save", json!({ "def": { "name": agent, "backend": "kiro", "system": "x", "skills": "[]",
            "mcp": json!([central, { "name": "inl", "command": "c", "env": { "K": secret, "R": "${HOME}" } }]).to_string() } }));
        ok("teams_save", json!({ "def": { "name": team, "members": json!([
            { "name": "bare", "agent": inline_agent(json!([{ "name": "inl", "command": "c", "env": { "K": secret } }])) },
        ]).to_string() } }));

        let lists = || ["mcp_list", "registry_list", "teams_list"].map(|m| ok(m, json!({})));
        for (m, r) in ["mcp_list", "registry_list", "teams_list"].iter().zip(lists()) {
            assert!(!r.to_string().contains(&secret), "{m} carries the secret");
        }
        let [mcps, agents, teams] = lists();
        let row = |list: &serde_json::Value, key: &str, name: &str| list[key].as_array().unwrap().iter().find(|r| r["name"] == name).unwrap().clone();
        let listed_central = row(&mcps, "mcp", &central);
        let listed_agent = row(&agents, "agents", &agent);
        let listed_team = row(&teams, "teams", &team);
        let def: serde_json::Value = serde_json::from_str(listed_central["def"].as_str().unwrap()).unwrap();
        assert_eq!(def["headers"]["Authorization"], crate::projects::mcp_mask::VALUE_SET, "the name stays, the value is the marker");
        let inline: serde_json::Value = serde_json::from_str(listed_agent["mcp"].as_str().unwrap()).unwrap();
        assert_eq!((inline[0].as_str(), inline[1]["env"]["R"].as_str()), (Some(central.as_str()), Some("<set>")), "a central name stays; a reference is masked too");

        // Saved back exactly as listed: every value is the stored one still.
        ok("mcp_save", json!({ "def": listed_central }));
        ok("registry_save", json!({ "def": listed_agent }));
        ok("teams_save", json!({ "def": listed_team }));
        let stored = crate::projects::registry_get(&agent).unwrap().unwrap();
        let defs = crate::projects::spawn::mcp_defs(&stored);
        let by = |n: &str| defs.iter().find(|d| d.name == n).unwrap();
        assert_eq!(by(&central).headers["Authorization"], format!("Bearer {secret}"), "the central def materializes its value");
        assert_eq!((by("inl").env["K"].as_str(), by("inl").env["R"].as_str()), (secret.as_str(), "${HOME}"));
        let members = crate::projects::team_get(&team).unwrap().unwrap().members;
        assert!(members.contains(&secret), "the team member keeps its value");

        // Rotated by another save after the list: the old listed def keeps the NEW value.
        let rotated = format!("{secret}-rotated");
        ok("mcp_save", json!({ "def": { "name": central, "def": json!({ "url": "https://mcp.example", "headers": { "Authorization": rotated } }).to_string() } }));
        ok("mcp_save", json!({ "def": listed_central }));
        let kept = crate::projects::with_registry_mcp()[&central].clone();
        assert!(kept.contains(&rotated), "{kept}");

        // A marker with nothing behind it: refused, naming the path, no value, nothing written.
        let before = crate::projects::registry_get(&agent).unwrap().unwrap().mcp;
        let r = call("registry_save", json!({ "def": { "name": agent, "backend": "kiro", "system": "x", "skills": "[]",
            "mcp": json!([{ "name": "inl", "command": "c", "env": { "NEW": "<set>" } }]).to_string() } }));
        let e = r.error.expect("refused").message;
        assert!(e.contains("env.NEW") && e.contains(&format!("agent '{agent}'")) && !e.contains(&secret), "{e}");
        assert_eq!(crate::projects::registry_get(&agent).unwrap().unwrap().mcp, before, "nothing was written");
    }

    /// Board #451 delta 2: a stored MCP-bearing field that does not parse fails
    /// the WHOLE list — no text, no half definition — and a full save repairs it.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn an_unreadable_stored_mcp_field_fails_the_list_without_its_text_and_a_full_save_repairs_it() {
        use serde_json::json;
        crate::projects::tests::use_test_store();
        let tag = &uuid::Uuid::new_v4().to_string()[..8];
        let secret = format!("SENTINEL-451u-{tag}");
        let call = |method: &str, params: serde_json::Value| handle_request(&Request { id: Some(1), method: method.into(), params }, "");
        let raw = |f: &dyn Fn(&mut crate::projects::store::Store) -> Result<(), String>| crate::projects::restore_hold::with_store_for_test(|st| f(st)).unwrap();

        let central = format!("u451-{tag}");
        raw(&|st| st.mcp_save(&crate::projects::store::RegMcp { name: central.clone(), def: format!("{{\"env\":\"{secret}\"}}") }, 1));
        let r = call("mcp_list", json!({}));
        let e = r.error.expect("the whole list fails").message;
        assert!(e.contains(&format!("mcp server '{central}'")) && !e.contains(&secret), "{e}");
        assert!(r.result.is_none());
        let r = call("mcp_save", json!({ "def": { "name": central, "def": json!({ "command": "c", "env": { "K": "<set>" } }).to_string() } }));
        assert!(r.error.is_some_and(|e| !e.message.contains(&secret)), "a marker over an unreadable row is refused");
        let r = call("mcp_save", json!({ "def": { "name": central, "def": json!({ "command": "c", "env": { "K": "fresh" } }).to_string() } }));
        assert!(r.error.is_none(), "a full save repairs it");
        assert!(call("mcp_list", json!({})).error.is_none(), "it lists again");
        let _ = crate::projects::mcp_delete(&central);

        let agent = format!("u451a-{tag}");
        crate::projects::registry_save(&json!({ "name": agent, "backend": "kiro", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let mut row = crate::projects::registry_get(&agent).unwrap().unwrap();
        row.mcp = format!("[{{\"name\":\"s\",\"env\":\"{secret}\"}}]");
        raw(&|st| st.reg_save(&row, 1));
        let r = call("registry_list", json!({}));
        let e = r.error.expect("the whole list fails").message;
        assert!(e.contains(&format!("agent '{agent}'")) && !e.contains(&secret), "{e}");
        let r = call("registry_save", json!({ "def": { "name": agent, "backend": "kiro", "system": "x", "skills": "[]", "mcp": "[]" } }));
        assert!(r.error.is_none(), "a full save repairs it");
        assert!(call("registry_list", json!({})).error.is_none());
        let _ = crate::projects::registry_delete(&agent);

        let team = format!("u451t-{tag}");
        let member = json!({ "name": "m", "agent": { "name": "", "backend": "kiro", "mcp": json!([{ "name": "s", "env": { "K": secret } }]).to_string() } });
        // An unreadable inline mcp, and members that are not objects (reviewer
        // P1-A on 60414c91): wrapped in an array, encoded as a string, null.
        for members in [
            json!([{ "name": "m", "agent": { "name": "", "backend": "kiro", "mcp": format!("{{\"env\":\"{secret}\"}}") } }]),
            json!([[member.clone()]]),
            json!([member.to_string()]),
            json!([member.clone(), null]),
        ] {
            raw(&|st| st.team_save(&crate::projects::store::RegTeam { name: team.clone(), description: String::new(), members: members.to_string() }, 1));
            let r = call("teams_list", json!({}));
            assert!(r.result.is_none(), "{members}: no half list");
            let e = r.error.expect("the whole list fails").message;
            assert!(e.contains(&format!("team '{team}'")) && !e.contains(&secret), "{members}: {e}");
            let _ = crate::projects::teams_delete(&team);
        }
        assert!(call("teams_list", json!({})).error.is_none());
    }
}
