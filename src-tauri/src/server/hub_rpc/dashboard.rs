//! The dashboard read (board #108; docs/exec-plans/board-dashboard.md § 4,
//! design docs/design-docs/features/dashboard.md): ONE derived answer per
//! project, and every board's open-ask count in one grouped read. Nothing in
//! it is an agent's own claim except the status line, shown as its words.
//!
//! - `hub_dashboard` {session}
//! - `hub_ask_counts` {} (about every room, so it answers before the session gate)
//!
//! Who "needs a person" is NOT decided here (leader, #108 note 6): the agents
//! carry the one derivation's state, detail and time, and the client
//! classifies them with its one definition (`needsPerson`), so the roster card
//! and the dashboard row cannot disagree. Notes for you is the client's too.

use super::RpcError;
use crate::projects::asks;
use serde_json::{json, Value};

/// The Finished window, in the board's unit (seconds, as `issues.updated_at`).
pub(in crate::server) const FINISHED_SECS: i64 = 24 * 3600;

/// `ws` is the workspace the roster fold read (ONE project read, round 3).
pub(in crate::server) fn dashboard(session: &str, room: &str, roster: &Value, ws: Option<&str>) -> Result<Value, RpcError> {
    dashboard_with(session, room, roster, ws, &crate::projects::managed::managed_state)
}

/// `dashboard` with the marker read the fold used (round 5): the stopped walk
/// reads only the homes the fold did NOT observe, through the same reader.
pub(in crate::server) fn dashboard_with(session: &str, room: &str, roster: &Value, ws: Option<&str>, marker: &dyn Fn(&str, &str) -> crate::projects::managed::ManagedState) -> Result<Value, RpcError> {
    // "Could not ask" is never "none" (reviewer R1, round 2): a pane listing
    // that failed is no reading of who is live, so the whole read refuses and
    // the client keeps its last complete data. A session tmux says is absent
    // IS a reading: nobody is live, every managed home is stopped.
    if roster["panes"].as_str() == Some("failed") {
        let why = roster["inconclusive"].as_str().unwrap_or("its observation was not conclusive");
        return Err(RpcError::Internal(format!("{session}: {why}; no summary")));
    }
    let open: Vec<Value> = asks::list(room, false).map_err(RpcError::Internal)?.iter().map(|a| asks::ask_json(a, None)).collect();
    let counts = crate::projects::board_counts().map_err(RpcError::Internal)?;
    let zero = json!({ "todo": 0, "doing": 0, "review": 0, "done": 0, "total": 0 });
    let board_counts = counts["counts"].get(session).cloned().unwrap_or(zero);
    let (oldest, finished, held) = crate::projects::board::dashboard_board(session, chrono::Utc::now().timestamp() - FINISHED_SECS).map_err(RpcError::Internal)?;
    // A dashboard agent is a MANAGED one, the Hub roster's rule (Hub.svelte
    // managedAgents; reviewer R2): a CLI started by hand in a window is a
    // terminal thing, never a row or a count.
    // Membership is the home marker (amendment B), the fold's one observation;
    // the detected CLI kind is display only.
    let live: Vec<&Value> = roster["agents"].as_array().into_iter().flatten().filter(|a| a["home_managed"].as_bool() == Some(true)).collect();
    let wanted: Vec<String> = live.iter().filter_map(|a| a["name"].as_str().map(str::to_string)).collect();
    let status = crate::projects::rooms::latest_status(room, &wanted).map_err(RpcError::Internal)?;
    let agents: Vec<Value> = live
        .iter()
        .map(|a| {
            let name = a["name"].as_str().unwrap_or("");
            let issue = held.iter().find(|(who, _, _)| who == name).map(|(_, n, t)| json!({ "id": n, "title": t }));
            let line = status.get(name).map(|(text, ts)| json!({ "text": text, "ts": ts }));
            json!({ "name": name, "label": a["label"], "state": a["state"], "detail": a["detail"], "since": a["since"], "issue": issue, "status": line })
        })
        .collect();
    // A home with a live window is never stopped, whatever its row shows; the
    // fold already observed its marker, so the walk skips it (round 5).
    let live_names: Vec<String> = roster["agents"].as_array().into_iter().flatten().filter_map(|a| a["name"].as_str().map(str::to_string)).collect();
    // The stopped count is a reading too: a project or a homes directory that
    // could not be read is an error of the whole read, never 0 (reviewer R1).
    // The fold's own workspace: no second project read that could disagree
    // with the managed flags above (round 3).
    let homes = match ws {
        Some(path) => crate::projects::managed::managed_names_checked_except(path, &live_names, marker).map_err(|e| RpcError::Internal(format!("{session}: its agent homes could not be read: {e}")))?,
        None => Vec::new(),
    };
    let stopped = homes.len();
    Ok(json!({
        "session": session,
        "asks": open,
        "board": {
            "counts": board_counts,
            // The column's issue whose LAST CHANGE is oldest: any edit or note
            // moves it, so it is never "in doing since" (leader, note 4).
            "oldest_doing": oldest.map(|(id, title, assignee, at)| json!({ "id": id, "title": title, "assignee": assignee, "last_change": at })),
        },
        "agents": agents,
        "stopped": stopped,
        "finished": finished.into_iter().map(|(id, title, assignee, at)| json!({ "id": id, "title": title, "assignee": assignee, "done_at": at })).collect::<Vec<_>>(),
        "labels": roster["labels"],
        "generated_at": crate::projects::rooms::now_ms(),
    }))
}

pub(super) fn ask_counts() -> Result<Value, RpcError> {
    let rows = asks::open_counts().map_err(RpcError::Internal)?;
    let counts: serde_json::Map<String, Value> = rows.into_iter().map(|(room, n)| (room, json!(n))).collect();
    Ok(json!({ "counts": counts }))
}
