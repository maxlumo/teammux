//! The project page's three doors (board #111; websocket-rpc.md § page_*).
//! The store and its lock are `projects::page`'s; here are only the wire
//! types, the project the session names, the caller's identity and the mint.
//!
//! - `page_publish` {session, dir, who?}: `dir` absolute; the SERVER reads it
//! - `page_unpublish` {session, who?}
//! - `page_load` {session}: the pointer, the document and the cap in one
//!   critical section (AC2)
//!
//! `who` is checked as `hub_ask` checks `from` (R8): the ONE name resolution
//! (`projects::names::resolve`: a label reaches the physical agent), then a
//! managed agent of THIS project (`projects::is_managed_in`) or `human`. A
//! same-uid caller on the gateway socket can name anyone, as on every other
//! door; no authentication is claimed.

use super::download::{scope_base, DL_STREAM_TTL_SECS};
use super::rpc::RpcError;
use crate::projects::page;
use serde_json::{json, Value};

const KEEP_MS: u64 = DL_STREAM_TTL_SECS * 1000;

fn string<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(RpcError::InvalidParams(format!("{key}: a string; nothing was changed"))),
    }
}

fn workspace(p: &Value) -> Result<(String, String), RpcError> {
    let session = string(p, "session")?.filter(|s| !s.is_empty()).ok_or_else(|| RpcError::InvalidParams("session: required".into()))?;
    match crate::projects::project_for_session(session).map_err(|e| RpcError::Internal(format!("project lookup failed: {e}")))? {
        Some(project) => Ok((session.to_string(), project.path)),
        None => Err(RpcError::InvalidParams(format!("no project for session '{session}'; a page belongs to a project"))),
    }
}

/// The publisher: `human` (absent, empty or that word), or a managed agent
/// of the project, by its physical name.
fn publisher(session: &str, ws: &str, p: &Value) -> Result<String, RpcError> {
    let typed = string(p, "who")?.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("human");
    if typed == "human" {
        return Ok(typed.into());
    }
    let name = crate::projects::names::resolve(session, typed);
    if !crate::projects::is_managed_in(Some(ws), &name) {
        return Err(RpcError::InvalidParams(format!("'{typed}' is not a managed agent of this project; nothing was changed")));
    }
    Ok(name)
}

/// The scope door's ONE wide-root gate (S1, leader note 12): a project whose
/// folder is `/` or the home directory gets no page, as no preview gets a
/// scope rooted there.
fn too_wide(ws: &str) -> bool {
    std::fs::canonicalize(ws).is_ok_and(|p| crate::fs::too_wide(&p))
}

pub(super) fn handle(method: &str, p: &Value, token: &str) -> Result<Value, RpcError> {
    let (session, ws) = workspace(p)?;
    let ws_path = std::path::Path::new(&ws);
    match method {
        "page_publish" => {
            let who = publisher(&session, &ws, p)?;
            if too_wide(&ws) {
                return Err(RpcError::InvalidParams(format!("{ws} is / or the home folder: too wide to share as a page's files; nothing was published")));
            }
            let dir = string(p, "dir")?.filter(|d| d.starts_with('/')).ok_or_else(|| RpcError::InvalidParams("dir: an absolute folder path".into()))?;
            let r = page::publish(ws_path, std::path::Path::new(dir), &who, KEEP_MS, &page::now_ms).map_err(|e| RpcError::InvalidParams(format!("{e}; nothing was published")))?;
            Ok(json!({ "rev": r.rev, "files": r.files, "bytes": r.bytes, "by": who, "warning": r.warning }))
        }
        "page_unpublish" => {
            publisher(&session, &ws, p)?;
            let was = page::unpublish(ws_path, KEEP_MS, &page::now_ms).map_err(RpcError::Internal)?;
            Ok(json!({ "rev": was.as_ref().map(|w| w.0), "warning": was.and_then(|w| w.1) }))
        }
        "page_load" => {
            if too_wide(&ws) {
                return Ok(json!({ "page": null }));
            }
            let loaded = page::load(ws_path, &mut |root, dir| scope_base(token, root, dir)).map_err(RpcError::Internal)?;
            Ok(match loaded {
                None => json!({ "page": null }),
                Some(l) => json!({ "page": { "rev": l.rev, "by": l.by, "at": l.at_ms, "html": l.html, "dir": l.dir, "base": l.base } }),
            })
        }
        other => Err(RpcError::MethodNotFound(format!("unknown page method: {other}"))),
    }
}

/// The dashboard read's page head: `null` for no page (or no workspace), or
/// `Err` when the store could not be read, which is never "no page" (#108).
pub(super) fn head(ws: Option<&str>) -> Result<Value, String> {
    let Some(ws) = ws else { return Ok(Value::Null) };
    if too_wide(ws) {
        return Ok(Value::Null);
    }
    Ok(match page::head(std::path::Path::new(ws))? {
        None => Value::Null,
        Some(h) => json!({ "rev": h.rev, "by": h.by, "at": h.at_ms }),
    })
}

#[cfg(test)]
#[path = "page_rpc_tests.rs"]
mod tests;
