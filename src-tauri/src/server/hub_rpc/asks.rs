//! The ask RPCs (board #106; docs/design-docs/features/asks.md). The doors
//! are as strong as every other RPC's: a same-uid caller on the gateway socket
//! can call any method and names its own `from`, so an ask's answer is as
//! authentic as any message recorded as the person's. No authentication is
//! claimed here.
//!
//! - `hub_ask` {from, question, options:[{key,label}], recommend?, issue?}
//! - `hub_ask_answer` {seq, option?, text?}: always the person's
//! - `hub_ask_dismiss` {seq}: always the person's
//! - `hub_ask_withdraw` {seq, from, why, re?}: only the asker's same home
//! - `hub_ask_list` {all?}

use super::{quote_into, quote_when, RpcError};
use crate::projects::asks;
use crate::projects::store::asks::{AskClose, AskRow, ASK_ANSWERED, ASK_DISMISSED, ASK_OPEN, ASK_WITHDRAWN};
use serde_json::{json, Value};

/// How the one delivery path is reached: injected so the doors and the
/// order (commit, then deliver) are testable without a pane.
/// `(session, to, body, room, msg_seq, msg_id, home)`: the line goes to `to`,
/// the asker, ALONE (validator F2: an `@name` inside a label or a comment is
/// text, not a recipient), and only to its LIFETIME `home` (board #116: the
/// delivery's write step checks it, so a same-name agent created after the
/// check below is never typed, nor held for).
pub(in crate::server) type Deliver<'a> = &'a dyn Fn(&str, &str, &str, &str, i64, &str, &str) -> (Vec<String>, Vec<(String, &'static str)>);

// The wire door (validator F1, security.md § 1): every supplied field has its
// one type, or the call is refused before anything is written. Absent and
// null mean "not given"; any other type is never defaulted away.
fn bad(key: &str, want: &str) -> RpcError {
    RpcError::InvalidParams(format!("{key}: {want}; nothing was written"))
}

fn opt_str<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(bad(key, "a string")),
    }
}

/// A board or room number: an integer, or its digits as a string (`#` allowed).
fn opt_number(p: &Value, key: &str) -> Result<Option<i64>, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(|| bad(key, "an integer")),
        Some(Value::String(s)) => s.trim().trim_start_matches('#').parse().map(Some).map_err(|_| bad(key, "an integer")),
        Some(_) => Err(bad(key, "an integer")),
    }
}

fn opt_bool(p: &Value, key: &str) -> Result<bool, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(bad(key, "true or false")),
    }
}

fn options_of(p: &Value) -> Result<Vec<(String, String)>, RpcError> {
    let list = match p.get("options") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(bad("options", "a list of {key, label}")),
    };
    list.iter()
        .map(|o| match (o.get("key"), o.get("label")) {
            (Some(Value::String(k)), Some(Value::String(l))) if o.as_object().is_some_and(|m| m.len() == 2) => Ok((k.clone(), l.clone())),
            _ => Err(bad("options", "a list of {key, label}, both strings")),
        })
        .collect()
}

fn seq_of(p: &Value) -> Result<i64, RpcError> {
    opt_number(p, "seq")?.ok_or_else(|| RpcError::InvalidParams("seq: the ask's id is required".into()))
}

fn ask_in_room(room: &str, seq: i64) -> Result<AskRow, RpcError> {
    match asks::get(seq).map_err(RpcError::Internal)? {
        Some(a) if a.room == room => Ok(a),
        _ => Err(RpcError::InvalidParams(format!("no ask {seq} in this room"))),
    }
}

/// The project's labels, on EVERY answer that carries an ask row (leader,
/// round 3), so each reader shows the asker by its current label.
fn labels(session: &str) -> Value {
    json!(crate::projects::names::names(session).labels())
}

fn answer_json(session: &str, a: &AskRow, applied: bool) -> Value {
    let closing = a.closed_seq.and_then(|s| asks::body_of(&a.room, s));
    let mut v = json!({ "applied": applied, "ask": asks::ask_json(a, closing.as_deref()), "labels": labels(session) });
    if !applied {
        v["refused"] = json!(asks::closed_words(a));
    }
    v
}

/// The quote every closing line carries: the ask, as `--re` would quote it.
fn quote_of(a: &AskRow) -> String {
    let body = asks::body_of(&a.room, a.seq).unwrap_or_default();
    crate::address::quote_token(&a.asker, &quote_when(a.ts, chrono::Local::now()), &body)
}

pub(super) fn ask(session: &str, room: &str, p: &Value) -> Result<Value, RpcError> {
    let typed = opt_str(p, "from")?.map(str::trim).filter(|s| !s.is_empty() && *s != "human")
        .ok_or_else(|| RpcError::InvalidParams("only a managed agent of the project asks: name it in 'from'".into()))?;
    // The ONE resolution, at the door (agents-overview.md § physical name and
    // label; reviewer R2): a label or a previous label reaches the physical
    // agent, which is what the home check uses and the row stores.
    let from = &crate::projects::names::resolve(session, typed);
    // Every field's type first, so a wrong one is refused whoever calls.
    let question = opt_str(p, "question")?.unwrap_or("");
    let options = options_of(p)?;
    let recommend = opt_str(p, "recommend")?;
    let issue = opt_number(p, "issue")?;
    let home = match asks::home_id(session, from) {
        Ok(Some(h)) => h,
        Ok(None) => return Err(RpcError::InvalidParams(format!("only a managed agent of the project asks; '{from}' is not one"))),
        Err(e) => return Err(RpcError::InvalidParams(format!("'{from}': its managed home could not be read ({e}); nothing was asked"))),
    };
    let input = asks::validate(question, &options, recommend, issue, &|n| crate::projects::board_get(session, n).map(|_| true).or_else(|e| if e.contains("not found") || e.contains("no issue") { Ok(false) } else { Err(e) }))
        .map_err(RpcError::InvalidParams)?;
    let row = asks::open(room, from, &home, &input).map_err(RpcError::Internal)?;
    Ok(json!({ "ask": asks::ask_json(&row, None), "labels": labels(session) }))
}

/// What the delivery path did with the line, in the ask's words.
fn delivery_word(asker: &str, found: &[String], offline: &[(String, &'static str)]) -> &'static str {
    // A refusal at the bind (#116: `gone`, `unchecked`) outranks `found`: the
    // asker's pane was found, and the line was neither typed nor held.
    if let Some((_, why)) = offline.iter().find(|(n, _)| n == asker) {
        return why;
    }
    if found.iter().any(|n| n == asker) {
        return "found";
    }
    "unknown"
}

/// After an applied close by the person: type the line through the one
/// path iff the asker's home is still the one that asked; record the outcome.
fn deliver_close(session: &str, a: &AskRow, body: &str, msg_seq: i64, msg_id: &str, deliver: Deliver<'_>) -> String {
    let word = match asks::home_id(session, &a.asker) {
        Ok(Some(h)) if h == a.asker_home => {
            let (found, offline) = deliver(session, &a.asker, body, &a.room, msg_seq, msg_id, &a.asker_home);
            delivery_word(&a.asker, &found, &offline).to_string()
        }
        Ok(_) => "gone".to_string(),
        Err(_) => "unchecked".to_string(),
    };
    let _ = asks::set_delivery(a.seq, &word);
    word
}

/// Close an open ask by the person's act; the room and the seq are the row's.
fn close_by_person(session: &str, a: &AskRow, state: &'static str, key: Option<String>, said: String, deliver: Deliver<'_>) -> Result<Value, RpcError> {
    let body = quote_into(&quote_of(a), &format!("@{} {said}", a.asker));
    let to = serde_json::to_string(&[&a.asker]).unwrap_or_else(|_| "[]".into());
    let out = asks::close(&AskClose { seq: a.seq, state, answer_key: key.as_deref(), said: &said, sender: "human", to_json: &to, body: &body }).map_err(RpcError::Internal)?;
    if !out.applied {
        return Ok(answer_json(session, &out.ask, false));
    }
    let m = out.message.as_ref().expect("an applied close has its message");
    let word = deliver_close(session, &out.ask, &body, m.seq, &m.id, deliver);
    let mut ask = out.ask.clone();
    ask.delivery = Some(word);
    Ok(answer_json(session, &ask, true))
}

pub(in crate::server) fn answer(session: &str, room: &str, p: &Value, deliver: Deliver<'_>) -> Result<Value, RpcError> {
    // Every supplied field's type BEFORE the ask's state is read (validator
    // note 44): a malformed call is refused whatever the state; only a
    // well-formed one reaches the state, where a retry reads the winner.
    let seq = seq_of(p)?;
    let key = opt_str(p, "option")?;
    let text = opt_str(p, "text")?.unwrap_or("");
    let a = ask_in_room(room, seq)?;
    if a.state != ASK_OPEN {
        return Ok(answer_json(session, &a, false));
    }
    let (key, said) = asks::answer_text(&a, key, text).map_err(RpcError::InvalidParams)?;
    close_by_person(session, &a, ASK_ANSWERED, key, said, deliver)
}

pub(super) fn dismiss(session: &str, room: &str, p: &Value, deliver: Deliver<'_>) -> Result<Value, RpcError> {
    let seq = seq_of(p)?;
    let a = ask_in_room(room, seq)?;
    if a.state != ASK_OPEN {
        return Ok(answer_json(session, &a, false));
    }
    close_by_person(session, &a, ASK_DISMISSED, None, "dismissed: I will not answer this".into(), deliver)
}

pub(super) fn withdraw(session: &str, room: &str, p: &Value) -> Result<Value, RpcError> {
    // The types first, as in `answer` (validator note 44).
    let seq = seq_of(p)?;
    let typed = opt_str(p, "from")?.map(str::trim).unwrap_or("");
    let why = opt_str(p, "why")?.map(str::trim).unwrap_or("");
    let re = match p.get("re") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) if n.as_i64().is_some() => Some(n.to_string()),
        Some(_) => return Err(bad("re", "a room message's seq or id")),
    };
    let a = ask_in_room(room, seq)?;
    // Resolved once, before the lifetime check (reviewer R2).
    let resolved = crate::projects::names::resolve(session, typed);
    let from = resolved.as_str();
    let same = from == a.asker && matches!(asks::home_id(session, from), Ok(Some(h)) if h == a.asker_home);
    if !same {
        return Err(RpcError::InvalidParams(format!("only the asker withdraws ask {seq} (it was asked by {}'s home{})", a.asker, if from == a.asker { ", which has since been replaced" } else { "" })));
    }
    if why.is_empty() || why.chars().count() > asks::MAX_WHY {
        return Err(RpcError::InvalidParams(format!("a withdrawal says why, in 1-{} characters", asks::MAX_WHY)));
    }
    let cite = match re {
        Some(re) => {
            let m = crate::projects::rooms::message_by_ref(room, &re)
                .ok_or_else(|| RpcError::InvalidParams(format!("no message '{re}' in this room to cite")))?;
            let when = quote_when(m["ts"].as_i64().unwrap_or(0), chrono::Local::now());
            format!(" — citing {}", crate::address::quote_token(m["from"].as_str().unwrap_or("?"), &when, m["body"].as_str().unwrap_or("")).trim_end())
        }
        None => String::new(),
    };
    if a.state != ASK_OPEN {
        return Ok(answer_json(session, &a, false));
    }
    let said = format!("withdrawn: {why}{cite}");
    let body = format!("{}{said}", quote_of(&a));
    let out = asks::close(&AskClose { seq, state: ASK_WITHDRAWN, answer_key: None, said: &said, sender: from, to_json: "[]", body: &body }).map_err(RpcError::Internal)?;
    Ok(answer_json(session, &out.ask, out.applied))
}

pub(super) fn list(session: &str, room: &str, p: &Value) -> Result<Value, RpcError> {
    let all = opt_bool(p, "all")?;
    let rows = asks::list(room, all).map_err(RpcError::Internal)?;
    let asks: Vec<Value> = rows.iter().map(|a| asks::ask_json(a, a.closed_seq.and_then(|s| asks::body_of(&a.room, s)).as_deref())).collect();
    // The project's labels, so a reader shows each asker by its current one
    // (as `hub_board_list` does); the rows keep the physical name.
    Ok(json!({ "asks": asks, "labels": labels(session) }))
}
