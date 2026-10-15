//! hub_* RPC dispatch: the project hub (agents-v2). One chat room per project
//! (bus room `proj:<session>`), agent status declarations, and derived agent
//! states. This is the server side of the `tmm` CLI — the CLI-only message
//! substrate from docs/exec-plans/agents-v2.md (§4.1/§4.4): what an agent SAYS
//! arrives here via tmm; what we OBSERVE arrives via hooks into
//! projects::telemetry, and `hub_agents` joins the two at read time.
//!
//! Desktop-only in effect: everything needs state.db (the projects module,
//! desktop-gated — messages live in its `hub_msgs` table since board #107),
//! so mobile answers method-not-found and clients degrade gracefully.

use super::rpc::{param, Request, Response, RpcError};
#[cfg(any(target_os = "android", target_os = "ios"))]
use super::rpc::ERR_METHOD_NOT_FOUND;

/// Bus room for a project's hub chat.
///
/// Recorded ON THE PROJECT (schema v8) rather than derived from the session
/// name, because the session name can now change: renaming a project renames its
/// tmux session, and a room id derived from it would have left the conversation
/// behind. `proj:<session>` stays the FALLBACK — it is what every room created
/// before v8 is called, and what an untracked session gets.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn project_room(session: &str) -> String {
    crate::projects::project_for_session(session)
        .ok()
        .flatten()
        .map(|p| p.room)
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| format!("proj:{session}"))
}

/// The hub dispatcher proper (board #146): every arm is a `Result`, so a
/// missing param or a store error is a `?` with its wire code already chosen
/// (`RpcError`), and `handle_hub_request` below is the one place a
/// `Response` is built (`Response::from_outcome`). Arm order and every message are exactly what the
/// inline `match … return Response::err` shape produced.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn dispatch_hub(req: &Request, notifications: Option<&crate::agent_notifications::AgentNotificationHub>) -> Result<serde_json::Value, RpcError> {
    use crate::projects::rooms;
    use crate::projects::telemetry;

    let p = &req.params;
    // The one method that is about EVERY room: when did we last talk in each?
    // It answers before the session gate below, because it has no session to
    // resolve — the sidebar asks it once to order the whole project list.
    if req.method == "hub_rooms" {
        // The sidebar's summary read: newest message per room AND every
        // hook-known window's derived state, keyed "<session>:<window>". Both
        // are about EVERY project, which is why this answers before the
        // session gate below.
        let mut states = serde_json::Map::new();
        for (s, w, st) in crate::projects::telemetry::all_states() {
            states.insert(format!("{s}:{w}"), serde_json::Value::String(st));
        }
        return Ok(serde_json::json!({ "rooms": crate::projects::rooms::room_latest(), "states": states }));
    }
    // The unread summary of every room the client asks about (board #322):
    // `{rooms: {"<room>": {seq} | {ts}}}` — the reader's watermark, seq when
    // it has one, a legacy ts otherwise — answers `{rooms: {"<room>": {count,
    // first_seq, last_seq}}}` over the messages `rooms::news_kind` calls news.
    // A room with none is absent. Like `hub_rooms`, it is about many rooms,
    // so it answers before the session gate.
    //
    // The server's read mark (board #334, `hub_read`) is the shared truth:
    // the watermark is the LATER of it and the client's cached one (a fresh
    // client sends `{}` and inherits the server's; a cached mark not yet
    // ACKed still counts for this client), and `marks` answers the PERSISTED
    // mark of every asked room that has one — never that effective max — so
    // the client's cache follows another client's reading.
    if req.method == "hub_unread" {
        let mut out = serde_json::Map::new();
        let mut marks = serde_json::Map::new();
        if let Some(asked) = p.get("rooms").and_then(|v| v.as_object()) {
            for (room, mark) in asked.iter().take(256) {
                let mut seq = mark.get("seq").and_then(|v| v.as_i64()).filter(|n| *n > 0);
                let mut ts = mark.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
                // The client's cached mark is validated at the door: a seq or
                // ts past the room's newest message cannot be a real read (a
                // cache from a wiped or another database), so it is DROPPED,
                // not clamped — clamped, a cache that keeps re-sending it
                // would hide every next message as it arrives.
                let Some((head_seq, head_ts)) = rooms::room_head(room) else { continue };
                seq = seq.filter(|n| *n <= head_seq);
                if ts > head_ts {
                    ts = 0;
                }
                if let Some((s, t)) = rooms::read_mark(room) {
                    // A legacy ts-only client mark is first resolved to the
                    // room's seq (the newest message at or before it), THEN
                    // compared: a newer legal ts must not lose to the seq.
                    let client = seq.or_else(|| (ts > 0).then(|| rooms::seq_at_or_before(room, ts)).flatten());
                    seq = Some(client.map_or(s, |c| c.max(s)));
                    marks.insert(room.clone(), serde_json::json!({ "seq": s, "ts": t }));
                }
                if let Some(sum) = rooms::unread(room, seq, ts) {
                    out.insert(room.clone(), sum);
                }
            }
        }
        return Ok(serde_json::json!({ "rooms": out, "marks": marks }));
    }
    // The human read a room (board #334): `{rooms: {"<room>": {seq} | {ts}}}`
    // moves each room's ONE server-side mark forward — resolved by the server
    // to a real message (a seq clamped to the room's newest, a legacy ts to
    // the newest message at or before it), never backwards — and answers the
    // PERSISTED marks, which are the client's ACK. The Hub calls it when a
    // room is read and re-sends it until ACKed. `tmm` never calls it: an
    // agent reading the room is not the human reading it. Many rooms, so it
    // answers before the session gate.
    if req.method == "hub_read" {
        let mut marks = serde_json::Map::new();
        if let Some(asked) = p.get("rooms").and_then(|v| v.as_object()) {
            for (room, mark) in asked.iter().take(256) {
                let seq = mark.get("seq").and_then(|v| v.as_i64()).filter(|n| *n > 0);
                let ts = mark.get("ts").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
                if seq.is_none() && ts == 0 {
                    continue;
                }
                if let Some((s, t)) = rooms::mark_read(room, seq, ts).map_err(RpcError::Internal)? {
                    marks.insert(room.clone(), serde_json::json!({ "seq": s, "ts": t }));
                }
            }
        }
        return Ok(serde_json::json!({ "rooms": marks }));
    }
    // The board twin of `hub_rooms`: issue counts per column for EVERY
    // project's board, one grouped read (board #39) — the Board sidebar
    // shows per-project counts and hides empty boards, and a per-project
    // `hub_board_list` walk is the N+1 this exists to prevent. No `session`
    // param by design, so it answers before the session gate like the other
    // all-rooms reads; same authenticated reader as everything here.
    if req.method == "hub_board_counts" {
        return Ok(crate::projects::board_counts().map_err(RpcError::Internal)?);
    }
    let asked = param(p, "session")?;
    // Resolve the caller's session name to the project's CURRENT one, ONCE, here.
    // Renaming a project renames its tmux session, but a running agent carries
    // `TMM_PROJECT` from the moment it started — and half of these methods reach
    // straight into tmux (`window_of_agent`, `list_panes`), where a stale name
    // finds nothing. Measured the hard way: right after a rename, a tmm call
    // answered "no window named 'builder-2' in session 'tmm-tasks'" — the deaf
    // agent again, one layer below the project lookup that already handled it.
    let current = crate::projects::project_for_session(asked)
        .ok()
        .flatten()
        .map(|proj| proj.session)
        .unwrap_or_else(|| asked.to_string());
    let session: &str = &current;
    let room = project_room(session);

    match req.method.as_str() {
        // Post to the project chat. `from` is the agent name (tmm exports
        // TMM_AGENT) or "human" for the operator.
        // A SLASH COMMAND is for the CLI, not for the model. `/model`, `/clear`,
        // `/compact`, `/tools` are things the agent's TUI interprets, and only
        // when they are the whole line — delivered the normal way, prefixed with
        // `[tmm chat …] human:`, they arrive as ordinary prose and the model
        // answers them instead of the CLI running them (owner, 2026-08-19: "支持
        // /命令 这个直接发送 不加消息时间戳之类的").
        //
        // So this path types the text VERBATIM into the agent's pane: no stamp,
        // no sender, no @address. It is recorded in the room as a lifecycle line
        // (`[tmm] `) rather than a message, because it is an instruction to a
        // program, not something said to a person — and record-only, so the
        // mention scanner never sees it.
        "hub_command" => {
            let agent = param(p, "agent")?;
            let text = param(p, "text")?.trim();
            if !text.starts_with('/') {
                return Err(RpcError::InvalidParams("a command must start with '/'".into()));
            }
            // Who sent it (board #274): the composer omits it (the human),
            // `tmm send "@bob /compact"` passes the calling agent. An agent's
            // command to itself is refused — it would be typed into the very
            // turn that sent it — and `all` skips the sender for the same
            // reason.
            let from = p.get("from").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("human");
            if agent == from {
                return Err(RpcError::InvalidParams(format!("'{from}' cannot send a command to itself")));
            }
            let ws = crate::projects::project_for_session(session).ok().flatten().map(|pr| pr.path);
            let panes = crate::tmux::list_panes(session).unwrap_or_default();
            // The room line's id exists before the typing (board #264): each
            // receipt row carries it, and an echo can race the post.
            let msg_id = uuid::Uuid::new_v4().to_string();
            let (name, args) = match text.split_once(char::is_whitespace) {
                Some((n, a)) => (n, a.trim()),
                None => (text, ""),
            };
            let mut sent: Vec<String> = Vec::new();
            let mut refused: Vec<String> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for pane in &panes {
                if !seen.insert(pane.window) || !pane.active {
                    continue;
                }
                if (agent != "all" && pane.window_name != agent) || pane.window_name == from {
                    continue;
                }
                // Same managed-only gate as delivery: typing into a window the
                // user started by hand is not ours to do, and typing a slash
                // command into a SHELL would execute a stray path.
                if !crate::projects::is_managed_in(ws.as_deref(), &pane.window_name) {
                    continue;
                }
                let target = format!("{}:{}.{}", session, pane.window, pane.pane);
                // The receipt, recorded BEFORE typing like every delivery:
                // only where this backend declares what its prompt hook
                // echoes for a command (`Backend::command_echo`).
                let receipt = crate::projects::agents::detect_pane(ws.as_deref(), pane)
                    .and_then(|a| crate::backends::Backend::parse(a.backend))
                    .and_then(|b| b.command_echo(name, args))
                    .and_then(|echo| {
                        crate::projects::telemetry::record_command_delivery(session, &pane.window_name, &echo, &msg_id)
                    });
                match crate::tmux::send_command(&target, text) {
                    Ok(()) => sent.push(pane.window_name.clone()),
                    // Board #250: a pane in copy-mode refuses. The same plain
                    // warn as a refused chat line, on THAT window, whatever the
                    // others did: an `all` where one pane took it answers
                    // success, and the refused one must not vanish with it.
                    Err(e) => {
                        if let Some(id) = receipt {
                            crate::projects::telemetry::forget_delivery(id);
                        }
                        crate::projects::telemetry::record_undelivered(session, &pane.window_name, text, e.trim());
                        refused.push(format!("{}: {}", pane.window_name, e.trim()));
                    }
                }
            }
            if sent.is_empty() && !refused.is_empty() {
                return Err(RpcError::Internal(format!("not sent — {}", refused.join("; "))));
            }
            if sent.is_empty() {
                return Err(RpcError::InvalidParams(format!("no managed agent named '{agent}' in session '{session}'")));
            }
            let _ = rooms::post_routed_as(&room, &msg_id, from, &format!("[tmm] {} → {}", text, sent.join(", ")), &[]);
            Ok(serde_json::json!({ "sent": sent, "command": text }))
        }

        "hub_post" => {
            let raw_body = param(p, "body")?;
            let from = p.get("from").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("human");
            let is_status = p.get("status").and_then(|v| v.as_bool()).unwrap_or(false);
            // A reply (board #290): `re` names a message of THIS room by id or
            // seq, and the quote token is built here, from the stored row —
            // one formatter for the composer and `tmm send --re`, the sender
            // and time from the record, never the client.
            let quote = match p.get("re").and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string()))) {
                Some(re) if !re.trim().is_empty() => {
                    let m = rooms::message_by_ref(&room, re.trim())
                        .ok_or_else(|| RpcError::InvalidParams(format!("no message '{re}' in this room")))?;
                    let when = quote_when(m["ts"].as_i64().unwrap_or(0), chrono::Local::now());
                    crate::address::quote_token(m["from"].as_str().unwrap_or("?"), &when, m["body"].as_str().unwrap_or(""))
                }
                _ => String::new(),
            };
            let raw_body = if quote.is_empty() { raw_body.to_string() } else { quote_into(&quote, raw_body) };
            let raw_body = raw_body.as_str();
            let body = if is_status {
                format!("[tmm status working] {raw_body}")
            } else {
                raw_body.to_string()
            };
            // record_only = true means the message is stored but NEVER typed
            // into any agent's pane. Required for hook-sourced auto-replies:
            // if an automatic post addresses a peer, delivery would type into
            // that peer's pane, triggering their own stop hook, which then
            // auto-posts back — a ping-pong loop. The caller is responsible
            // for setting this when the origin is a hook.
            let record_only =
                is_status || p.get("record_only").and_then(|v| v.as_bool()).unwrap_or(false);
            let msg = if record_only {
                let recipients = crate::address::mention_names(&body);
                rooms::post_routed(&room, from, &body, &recipients).map_err(RpcError::Internal)?
            } else {
                // DELIVERY: an idle agent sits at its prompt and reads
                // nothing — @mentions are typed into the mentioned agents'
                // panes so the chat actually reaches them. (An agent that
                // is mid-task sees the line queued in its input box.)
                // Hook-sourced posts skip delivery entirely to prevent
                // reply loops (see record_only comment above).
                //
                // `detached` (board #285): the CLI found the call is not the
                // sender agent's own turn (a watcher it left behind, cron),
                // so its copy is typed like a wake's. A courtesy flag, as
                // `from` is: the skip only stops a turn looping into itself.
                let detached = p.get("detached").and_then(|v| v.as_bool()).unwrap_or(false);
                post_and_deliver(session, &room, from, &body, detached).map_err(RpcError::Internal)?
            };
            Ok(msg)
        }

        // Read the project chat, optionally incremental (`since_ts`, exclusive)
        // — the multica-style cursor so an agent polls without re-reading — or
        // backwards by page (`before_seq`), which is how a client reaches history
        // it never loaded. Nothing is ever pruned from the room, so paging is the
        // only honest way to keep a first load small (board #9).
        "hub_log" => {
            let limit = p.get("limit").and_then(|v| v.as_i64()).unwrap_or(100).clamp(1, 1000);
            let since_ts = p.get("since_ts").and_then(|v| v.as_i64()).unwrap_or(0);
            // The bus's own cursor is `seq`, the message's log position — stable,
            // gapless and already on every message the client holds, which a ts is
            // not (two messages can share a millisecond).
            let before_seq = p.get("before_seq").and_then(|v| v.as_i64()).filter(|n| *n > 0);
            // `around_seq` (board #322): the page of THIS room around one of its
            // messages, for a jump to it — the one documented helper; it wins
            // over before_seq/since_ts and adds `newer_more`.
            let around_seq = p.get("around_seq").and_then(|v| v.as_i64()).filter(|n| *n > 0);
            let since_ts = if around_seq.is_some() { 0 } else { since_ts };
            let mut history = match around_seq {
                Some(seq) => rooms::around_page(&room, seq, limit),
                None => rooms::history_page(&room, before_seq, limit),
            };
            // An archived message is hidden, not gone: the room's own store still
            // has it (that is what makes a restore free), so the hiding happens
            // here, on the way out.
            let hidden = crate::projects::archived_ids(&room);
            // Set by the since_ts branch below; false means "rows newer than the
            // cursor may still lie behind this page".
            let mut reached_cursor = true;
            if let Some(msgs) = history.get_mut("messages").and_then(|m| m.as_array_mut()) {
                // The RAW page's oldest position, read BEFORE any filtering. It is
                // the cursor of last resort: a page can lose every row to the
                // filters (one archived stretch, or a `since_ts` tail), and then a
                // survivor-derived cursor does not exist — the client would be told
                // `has_more: true` with nothing to ask for and the walk would stop
                // dead at a hidden run. The raw seq always advances, so the next
                // request lands strictly further back.
                let raw_oldest = msgs.first().and_then(|m| m.get("seq")).and_then(|v| v.as_i64());
                let raw_oldest_ts = msgs.first().and_then(|m| m.get("ts")).and_then(|v| v.as_i64());
                if since_ts > 0 {
                    msgs.retain(|m| m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0) > since_ts);
                    // An incremental poll asks "what is NEWER than since_ts", and
                    // the page is the newest `limit` rows — so when more than
                    // `limit` messages arrived since the cursor, the older ones are
                    // simply not on it. `has_more` then means "newer-than-since_ts
                    // rows remain behind this page": true only while the RAW page
                    // did not reach back to since_ts (2026-09-03, review C — the
                    // client took the page as complete and its cursor jumped past
                    // the rest, a permanent hole in the feed).
                    reached_cursor = raw_oldest_ts.is_none_or(|ts| ts <= since_ts);
                }
                if !hidden.is_empty() {
                    msgs.retain(|m| {
                        !m.get("id").and_then(|v| v.as_str()).is_some_and(|i| hidden.iter().any(|h| h == i))
                    });
                }
                // Prefer a SURVIVING row's seq — a visible message is what the user
                // is looking at, so the next page continues from what they can see —
                // and fall back to the raw one when nothing survived.
                let oldest = msgs
                    .first()
                    .and_then(|m| m.get("seq"))
                    .and_then(|v| v.as_i64())
                    .or(raw_oldest);
                if let Some(obj) = history.as_object_mut() {
                    if let Some(seq) = oldest {
                        obj.insert("oldest_seq".into(), serde_json::json!(seq));
                    }
                }
            }
            if since_ts > 0 {
                if let Some(obj) = history.as_object_mut() {
                    let more = obj.get("has_more").and_then(|v| v.as_bool()).unwrap_or(false);
                    obj.insert("has_more".into(), serde_json::json!(more && !reached_cursor));
                }
            }
            Ok(history)
        }

        // Keyword search over the room's FULL history — `hub_log` pages, this
        // finds (owner, 2026-09-07: "log是不是也加上关键字搜索能力…也可以加一个
        // --global 跨项目会话全局搜索"). `grep` is a term LIST, any-match,
        // substring, ASCII-case-insensitive, against body and sender.
        // `global: true` widens the scope to EVERY room; each hit carries its
        // `room` field so a cross-project answer stays readable. Newest `limit`
        // hits, oldest first, archived messages filtered out per room on the
        // way — same one-way mirror as `hub_log`.
        "hub_search" => {
            let terms: Vec<String> = p
                .get("grep")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if terms.iter().all(|t| t.trim().is_empty()) {
                return Err(RpcError::InvalidParams("grep must be a non-empty array of search terms".into()));
            }
            let global = p.get("global").and_then(|v| v.as_bool()).unwrap_or(false);
            let limit = p.get("limit").and_then(|v| v.as_i64()).unwrap_or(50).clamp(1, 500);
            let scope = if global { None } else { Some(room.as_str()) };
            let mut result = rooms::search_messages(scope, &terms, limit);
            if let Some(msgs) = result.get_mut("messages").and_then(|m| m.as_array_mut()) {
                // Archived = hidden everywhere, including from search. The ids
                // are per room, so a global result set asks once per room it
                // actually touched.
                let rooms: std::collections::BTreeSet<String> = msgs
                    .iter()
                    .filter_map(|m| m.get("room").and_then(|v| v.as_str()).map(str::to_string))
                    .collect();
                for r in rooms {
                    let hidden = crate::projects::archived_ids(&r);
                    if hidden.is_empty() {
                        continue;
                    }
                    msgs.retain(|m| {
                        m.get("room").and_then(|v| v.as_str()) != Some(r.as_str())
                            || !m.get("id").and_then(|v| v.as_str()).is_some_and(|i| hidden.iter().any(|h| h == i))
                    });
                }
            }
            Ok(result)
        }

        // Deleting a message is TWO steps, because a transcript is a record and a
        // misclick on a record should be recoverable (owner, 2026-08-19): archive
        // hides it — reversibly, the message never leaves the room's store — and
        // deleting it IN the archive is what forgets it. `hub_msg_purge` is the
        // only one of the three that destroys anything.
        "hub_msg_archive" | "hub_msg_restore" | "hub_msg_purge" => {
            let ids: Vec<String> = p
                .get("ids")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return Err(RpcError::InvalidParams("ids must be a non-empty array".into()));
            }
            match req.method.as_str() {
                "hub_msg_archive" => {
                    // The archive row carries a copy of the message, so the archive
                    // view needs no second lookup and no history window. The bodies
                    // come from the room, not from the client: what gets stored is
                    // what was actually said — and by EXACT id, so a message the
                    // user scrolled back to is as archivable as a fresh one (this
                    // used to scan the newest 1000, which quietly excluded
                    // everything older).
                    let mut done = 0usize;
                    for mid in &ids {
                        let Some(m) = rooms::message_by_id(&room, mid) else { continue };
                        let ok = crate::projects::archive_msg(
                            &room,
                            mid,
                            m.get("ts").and_then(|v| v.as_i64()).unwrap_or(0) as u64,
                            m.get("from").or_else(|| m.get("sender")).and_then(|v| v.as_str()).unwrap_or(""),
                            m.get("body").and_then(|v| v.as_str()).unwrap_or(""),
                        );
                        if ok.is_ok() {
                            done += 1;
                        }
                    }
                    Ok(serde_json::json!({ "archived": done }))
                }
                "hub_msg_restore" => {
                    let n = crate::projects::unarchive_msgs(&room, &ids).map_err(RpcError::Internal)?;
                    Ok(serde_json::json!({ "restored": n }))
                },
                _ => {
                    // Forget the message itself first: if that fails the archive row
                    // stays, so the message is still listed and can be tried again.
                    let n = rooms::delete_messages(&room, &ids).map_err(RpcError::Internal)?;
                    let _ = crate::projects::unarchive_msgs(&room, &ids);
                    Ok(serde_json::json!({ "deleted": n }))
                }
            }
        }

        // What is hidden in this room, newest first. Self-contained rows: the
        // archive is a list you review before forgetting anything.
        "hub_archive" => {
            let rows: Vec<serde_json::Value> = crate::projects::archived_msgs(&room)
                .into_iter()
                .map(|(id, ts, sender, body, at)| {
                    serde_json::json!({ "id": id, "ts": ts, "from": sender, "body": body, "archived_at": at })
                })
                .collect();
            Ok(serde_json::json!({ "messages": rows }))
        }

        // Derived agent states for a session: one row per live window, agent
        // detection + status derivation joined at read time.
        "hub_agents" => Ok(agent_states(session)),

        // ---- the project task board (owner, 2026-08-29): the human writes
        // issues on the board page, agents read/update through `tmm board`.
        // Session-scoped like the chat room; note/move/save record WHO acted.
        "hub_board_list" => Ok(crate::projects::board_list(session).map_err(RpcError::InvalidParams)?),
        "hub_board_get" => {
            let Some(issue_id) = p.get("id").and_then(|v| v.as_i64()) else {
                return Err(RpcError::InvalidParams("id required".into()));
            };
            Ok(crate::projects::board_get(session, issue_id).map_err(RpcError::InvalidParams)?)
        }
        "hub_board_save" => board_save(
            session,
            &room,
            p,
            &HandOff {
                post: &|who, brief| post_and_deliver(session, &room, who, brief, false),
                managed: &|name| {
                    crate::projects::project_for_session(session)
                        .ok()
                        .flatten()
                        .is_some_and(|proj| crate::projects::is_managed_in(Some(&proj.path), name))
                },
                read: &|session, id| crate::projects::board_get(session, id),
            },
        ),
        "hub_board_note" => {
            let Some(issue_id) = p.get("id").and_then(|v| v.as_i64()) else {
                return Err(RpcError::InvalidParams("id required".into()));
            };
            let body = p.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let author = p.get("who").and_then(|v| v.as_str()).unwrap_or("human");
            crate::projects::board_note(session, issue_id, author, body).map_err(RpcError::InvalidParams)?;
            // A Board reply is communication, not just storage (board
            // #26, #255): after the note is durable, wake the issue's
            // assignee AND reporter (minus the author and the human) with
            // the same targeted pane delivery/receipt path used by review
            // handoffs. Every miss is fail-soft — an issue with only the
            // author/human on it has nobody to notify, and an offline or
            // unmanaged target reads the persisted thread later instead
            // of turning a successful note into an RPC failure.
            if let Ok(issue) = crate::projects::board_get(session, issue_id) {
                if let Some((targets, notice)) = board_note_notice(&issue, author, body) {
                    let line = format!("[tmm chat {}] {author}: {notice}", stamp_now());
                    for target in &targets {
                        deliver_chat_line(session, target, &line);
                    }
                }
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "hub_board_delete" => {
            let Some(issue_id) = p.get("id").and_then(|v| v.as_i64()) else {
                return Err(RpcError::InvalidParams("id required".into()));
            };
            match crate::projects::board_delete(session, issue_id) {
                Ok(true) => Ok(serde_json::json!({ "ok": true })),
                Ok(false) => Err(RpcError::InvalidParams(format!("no issue #{issue_id} on this board"))),
                Err(e) => Err(RpcError::InvalidParams(e)),
            }
        }

        // The activity feed: recent observed telemetry events (tool calls,
        // status declarations, notifications) for the chat timeline. The durable
        // log keeps EVERYTHING (board #9), so this read is the bounded half:
        // newest page by default, `before_ts`/`before_id` walks backwards, and
        // `limit` is capped server-side however loudly a client asks.
        //
        // An older client sends only `since_ts` and still gets exactly what it
        // got before: the newest page, oldest first, under the same default cap.
        "hub_activity" => {
            let since_ts = p.get("since_ts").and_then(|v| v.as_u64()).unwrap_or(0);
            let limit = p
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .unwrap_or(telemetry::LOAD_EVENTS)
                .clamp(1, telemetry::MAX_PAGE_EVENTS);
            // The cursor is (ts, id): several events share one millisecond inside
            // a busy turn, so ts alone cannot address a position in the log. The
            // server hands `oldest: {ts, id}` back with every page, so a client
            // should always have the exact pair. Omitting `before_id` falls back
            // to "everything strictly older than that whole millisecond": it can
            // skip same-millisecond siblings the client had not received, but it
            // always makes PROGRESS, and a cursor that can loop for ever is the
            // worse failure for a scroll-to-load.
            let before = p
                .get("before_ts")
                .and_then(|v| v.as_u64())
                .map(|ts| (ts, p.get("before_id").and_then(|v| v.as_i64()).unwrap_or(0)));
            // A client asking for the feed is exactly when an undelivered line
            // matters, so account for the ones that timed out before reading.
            // Only on the LIVE page: a walk back through history must not make
            // the app warn about deliveries again.
            if before.is_none() {
                telemetry::sweep_deliveries(session);
                // The third flush trigger (board #257): held lines for an
                // agent that is idle now — a stop that raced the hold, or
                // lines a restart left held — are typed here.
                crate::projects::delivery::flush_idle(session);
            }
            let (events, has_more) = telemetry::events_page(session, since_ts, before, limit);
            // The oldest row of this page IS the cursor for the next one, handed
            // back so a client never has to reconstruct it.
            let oldest = events.first().map(|e| serde_json::json!({ "ts": e.ts, "id": e.id }));
            let (total, first_ts, _last_ts) = telemetry::events_stats(session);
            Ok(serde_json::json!({
                    "events": events,
                    "has_more": has_more,
                    "oldest": oldest,
                    "total": total,
                    "first_ts": first_ts,
                }))
        }

        // Stop / restart ONE agent. The window is the agent's life: killing it
        // ends the process and keeps the declaration, so `restart` is kill +
        // `projects::up_agent`, which recreates THAT slot's window from its
        // recipe and prefers the resume flags — the agent comes back to its
        // own conversation rather than to a blank prompt. Never the project-
        // wide `up`: that resumed every other stopped agent too (board #210).
        // Managed-only: we stop what we started.
        // Interrupt: type Escape into the agent's own pane — the only channel
        // that reaches a BUSY agent, since a chat message is read between
        // turns. Named key, never a raw \x1b: with extended-keys on, tmux
        // drops raw C0 bytes sent to a pane in extended mode. Server-side so
        // the CLI and the UI share ONE implementation.
        "hub_agent_interrupt" => {
            let agent = param(p, "agent")?;
            if crate::projects::managed_home(session, agent).is_none() {
                return Err(RpcError::InvalidParams(format!("'{agent}' is not an agent this app started")));
            }
            let Some(window) = window_of_agent(session, agent) else {
                return Err(RpcError::InvalidParams(format!("no window named '{agent}' in session '{session}'")));
            };
            // Reset the derived state BEFORE the key goes in, never after. A
            // cancelled turn produces no stop hook, so without this the newest
            // fact stays the `userPromptSubmit` that opened it and the card
            // reads `running` for ever; and an interrupted agent usually starts
            // something else within seconds, whose own turn re-derives
            // `running` — so a reset that raced the next turn would be
            // indistinguishable from no reset at all, i.e. an interrupt that
            // looked like it never landed (owner, 2026-08-29).
            // Its held lines are dropped with it (board #257 decision 1),
            // under the window's delivery lock. Every END edge also closes the
            // reply edge, not only a Stop (#256, orchestrator 03:50): the
            // interrupted turn's requesters are dropped where its end is
            // recorded, so a tool-only turn that follows cannot answer them.
            crate::projects::delivery::interrupt(session, agent, || telemetry::record_interrupt(session, agent));
            if let Some(hub) = notifications {
                hub.end_turn(session, agent);
            }
            crate::tmux::send_keys(&format!("{session}:{window}"), "Escape", false).map_err(RpcError::Internal)?;
            // The room records what the app did on a person's behalf —
            // same rule as stop/restart/remove. The client's sys
            // grammar already speaks `interrupted` (amber: a turn was
            // cut short, not an ending); the feed row was the missing
            // half of the composer's interrupt affordance (owner,
            // 2026-08-24: "发送 interrupt 的状态在消息列表里也要展示").
            let _ = rooms::post(&room, agent, &format!("[tmm] interrupted {agent}"));
            Ok(serde_json::json!({ "interrupted": agent }))
        }

        // Switch a running agent between queue and steer for THIS session
        // (board #271, orchestrator 03:58): the CLI's own live toggle, typed
        // as its named key — exactly what a person does in the pane. The
        // declaration (registry `input_mode`, #245) is untouched and a
        // restart starts from it. Idempotent and verified: nothing is typed
        // when the pane already runs `mode`, and after ONE key the screen
        // must show the new mode, or the call fails — never a blind second
        // press that could toggle it back.
        // Scheduled wakes (board #275): `tmm send "@name text" --in/--at`
        // declares one; the server's sleeper fires it (`fire_wake`).
        "hub_wake_add" => {
            let from = p.get("from").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("human");
            let body = param(p, "body")?;
            let due = p.get("due").and_then(|v| v.as_i64()).ok_or_else(|| RpcError::InvalidParams("missing required param: due".into()))?;
            let w = crate::projects::wakes::schedule(session, from, body, due).map_err(RpcError::InvalidParams)?;
            Ok(serde_json::to_value(&w).unwrap_or_default())
        }
        "hub_wake_list" => {
            let all = p.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
            let wakes = crate::projects::wakes::pending(if all { None } else { Some(session) });
            Ok(serde_json::json!({ "wakes": wakes }))
        }
        "hub_wake_cancel" => {
            let id = p.get("id").and_then(|v| v.as_i64()).ok_or_else(|| RpcError::InvalidParams("missing required param: id".into()))?;
            let by = p.get("by").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("human");
            crate::projects::wakes::cancel(session, id, by).map_err(RpcError::InvalidParams)?;
            Ok(serde_json::json!({ "id": id, "cancelled": true }))
        }

        // An existing agent's RUNTIME team (board #384): the Hub's drag of a
        // card onto a team, "Move to team" / "Leave team", `tmm agent team`.
        // `team` = a team present in this project, or "" to leave. Only the
        // recipe changes (`spawn::set_agent_team`); the team's definition is
        // never edited, the running CLI is neither rewritten nor restarted.
        // The moved agent, the new team's live members (#382's join notice)
        // and the old team's live members are told in their panes.
        "hub_agent_set_team" => {
            let agent = param(p, "agent")?;
            let team = p.get("team").and_then(|v| v.as_str()).map(str::trim)
                .ok_or_else(|| RpcError::InvalidParams("missing required param: team (a team, or \"\" to leave)".into()))?;
            let Some(project) = crate::projects::project_for_session(session).map_err(RpcError::InvalidParams)? else {
                return Err(RpcError::InvalidParams(format!("no project for session '{session}'")));
            };
            if crate::projects::managed_home(session, agent).is_none() {
                return Err(RpcError::InvalidParams(format!("'{agent}' is not an agent this app started")));
            }
            // The first move seeds the announcer's ledger with the old team's
            // live members: its prompt or a join notice told them.
            let seed = |old: &str| team_members(session, old, agent);
            let (left, changed, rev) = crate::projects::spawn::set_agent_team(&project.path, agent, team, &seed)
                .map_err(RpcError::InvalidParams)?;
            let mut told = Announced::default();
            if changed {
                // This agent's announcements one at a time; only the latest
                // revision's speaks, and it says what is true now against what
                // was told (P1-B). Never under the recipe section: delivery is slow.
                let home = crate::projects::spawn::agent_home(&project.path, agent);
                let turn = crate::projects::recipe::announcement(&home);
                let by = p.get("by").and_then(|v| v.as_str()).unwrap_or("");
                told = announce_move(session, &room, &project.path, agent, rev, &move_line(agent, team, &left), by, &turn);
            }
            // Who was owed a notice and did not get it, said to the caller
            // (board #388; `tmm agent team` notes it on stderr).
            Ok(serde_json::json!({ "agent": agent, "team": if team.is_empty() { serde_json::Value::Null } else { serde_json::json!(team) }, "left": if left.is_empty() { serde_json::Value::Null } else { serde_json::json!(left) }, "changed": changed, "untold": told.untold, "unread": told.unread }))
        }
        "hub_agent_input_mode" => {
            let agent = param(p, "agent")?;
            let mode = param(p, "mode")?;
            if !matches!(mode, "queue" | "steer") {
                return Err(RpcError::InvalidParams(format!("mode must be queue or steer, not '{mode}'")));
            }
            if crate::projects::managed_home(session, agent).is_none() {
                return Err(RpcError::InvalidParams(format!("'{agent}' is not an agent this app started")));
            }
            let key = agent_backend(session, agent).and_then(|b| b.live_input_toggle()).ok_or_else(|| {
                RpcError::InvalidParams(format!("'{agent}' cannot switch queue/steer while it runs"))
            })?;
            // The delivery target, so the switch serializes with every line
            // typed into this pane: the window's delivery lock (the one the
            // mode is read under, validator 04:48), then its send lock (04:31).
            let Some(target) = crate::projects::delivery::agent_target(session, agent) else {
                return Err(RpcError::InvalidParams(format!("no live window named '{agent}' in session '{session}'")));
            };
            let want = if mode == "steer" { "steer" } else { "queue" };
            let changed = crate::projects::delivery::switch_input_mode(session, agent, &target, want, key)
                .map_err(|e| RpcError::Internal(format!("{agent}: {e}")))?;
            if changed {
                let _ = rooms::post(&room, agent, &format!("[tmm] switched {agent} — {mode} mode (this session)"));
            }
            Ok(serde_json::json!({ "agent": agent, "mode": mode, "changed": changed }))
        }

        // Eject an agent from the project: stop it, drop its slot, remove its
        // isolated home. Stop is the pause button, this is the delete button.
        "hub_agent_remove" => {
            let agent = param(p, "agent")?;
            let v = crate::projects::agent_remove(session, agent).map_err(RpcError::InvalidParams)?;
            let _ = rooms::post(&room, agent, &format!("[tmm] removed {agent}"));
            Ok(v)
        }

        "hub_agent_stop" | "hub_agent_restart" => {
            let agent = param(p, "agent")?;
            if crate::projects::managed_home(session, agent).is_none() {
                return Err(RpcError::InvalidParams(format!("'{agent}' is not an agent this app started")));
            }
            let restart = req.method == "hub_agent_restart";
            let live = window_of_agent(session, agent);
            // Stop needs something to stop. Restart does not: the isolated home
            // outlives the window, so `restart` doubles as "start it again"
            // after a stop — which is what the button does when it reads Start.
            match (live, restart) {
                (None, false) => {
                    return Err(RpcError::InvalidParams(format!("no window named '{agent}' in session '{session}'")));
                }
                (Some(window), _) => {
                    if let Err(e) = crate::tmux::kill_window(&format!("{session}:{window}")) {
                        return Err(RpcError::Internal(e));
                    }
                }
                (None, true) => {}
            }
            if !restart {
                let _ = rooms::post(&room, agent, &format!("[tmm] stopped {agent}"));
                return Ok(serde_json::json!({ "stopped": agent }));
            }
            let resumed = start_agent(session, agent).map_err(|e| RpcError::Internal(format!("restart failed: {e}")))?;
            let _ = rooms::post(&room, agent, &format!("[tmm] restarted {agent}"));
            Ok(serde_json::json!({ "restarted": agent, "resumed": resumed }))
        }

        // A team restart ALIGNS the team with its current definition (board
        // #286, owner 2026-09-30: an edited dev-squad kept its old roster):
        // members it no longer has are stopped (homes kept), members it
        // gained are spawned, and every member it still has is restarted
        // from the definition (a stopped one is started). Per-agent restart
        // stays a recipe replay. One room line per member, as ever.
        // `only` (a retry, validator 06:53): the names a previous run reported
        // failed — members by window, a spawn by member name. Everything else
        // succeeded and is never run again (#258: a success is never retried).
        "hub_team_restart" => {
            let team = param(p, "team")?;
            let only: Option<Vec<String>> = p.get("only").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
            let plan = crate::projects::spawn::team_plan_for(session, team).map_err(RpcError::InvalidParams)?;
            let plan = match &only {
                Some(names) => crate::projects::spawn::only_names(plan, names),
                None => plan,
            };
            let mut errors = Vec::new();
            let mut stopped = Vec::new();
            for w in &plan.stop {
                match window_of_agent(session, w).map(|n| crate::tmux::kill_window(&format!("{session}:{n}"))) {
                    Some(Err(e)) => errors.push(serde_json::json!({ "name": w, "error": e })),
                    _ => {
                        let _ = rooms::post(&room, w, &format!("[tmm] stopped {w} — no longer in team {team}"));
                        stopped.push(w.clone());
                    }
                }
            }
            // New members first, so the restarted members' rosters name them.
            let mut spawned = Vec::new();
            if !plan.spawn.is_empty() {
                let wanted: Vec<String> = plan.spawn.iter().map(|(_, m)| m.clone()).collect();
                let r = crate::projects::spawn::spawn_team_members(session, team, "", "", true, Some(&wanted)).map_err(RpcError::InvalidParams)?;
                for m in r.get("spawned").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                    let win = m.get("window_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let _ = rooms::post(&room, &win, &format!("[tmm] spawned {win} — team {team}"));
                    spawned.push(win);
                }
                errors.extend(r.get("errors").and_then(|v| v.as_array()).cloned().unwrap_or_default());
            }
            let mut restarted = Vec::new();
            for w in &plan.restart {
                if let Some(n) = window_of_agent(session, w) {
                    if let Err(e) = crate::tmux::kill_window(&format!("{session}:{n}")) {
                        errors.push(serde_json::json!({ "name": w, "error": e }));
                        continue;
                    }
                }
                match start_agent(session, w) {
                    Ok(_) => {
                        let _ = rooms::post(&room, w, &format!("[tmm] restarted {w}"));
                        restarted.push(w.clone());
                    }
                    Err(e) => errors.push(serde_json::json!({ "name": w, "error": format!("restart failed: {e}") })),
                }
            }
            // The agents that JOINED the team at runtime (board #382) are not
            // in its definition, and a restart aligns the team with the
            // definition: they are left as they are, and the room says so
            // (once, not on a retry of the failed names).
            let mut kept = Vec::new();
            if only.is_none() {
                if let Ok(Some(project)) = crate::projects::project_for_session(session) {
                    for w in crate::projects::spawn::joined_windows(&project.path, team) {
                        if window_of_agent(session, &w).is_some() {
                            let _ = rooms::post(&room, &w, &kept_line(&w, team));
                            kept.push(w);
                        }
                    }
                }
            }
            Ok(serde_json::json!({ "team": team, "restarted": restarted, "stopped": stopped, "spawned": spawned, "kept": kept, "errors": errors }))
        }

        // Spawn a registry agent into this project (tmm spawn / the UI's
        // "+ agent"). Capped per project; no per-definition hiring gate.
        // A configured TEAM, started at once (board #74): every member spawns
        // as an ordinary managed agent; the room records one `spawned` line
        // per member, in the grammar the client already reads.
        "hub_spawn_team" => {
            let team = param(p, "team")?;
            let brief = p.get("brief").and_then(|v| v.as_str()).unwrap_or("");
            let by = p.get("by").and_then(|v| v.as_str()).unwrap_or("");
            let result = crate::projects::spawn::spawn_team(session, team, brief, by).map_err(RpcError::InvalidParams)?;
            let who = if by.is_empty() { "human" } else { by };
            let empty = Vec::new();
            for m in result.get("spawned").and_then(|v| v.as_array()).unwrap_or(&empty) {
                let win = m.get("window_name").and_then(|v| v.as_str()).unwrap_or("");
                let line = if brief.is_empty() {
                    format!("[tmm] spawned {win} — team {team}")
                } else {
                    format!("[tmm] spawned {win} — team {team}: {brief}")
                };
                let _ = rooms::post(&room, who, &line);
            }
            Ok(result)
        }
        "hub_spawn" => {
            let agent = param(p, "agent")?;
            let brief = p.get("brief").and_then(|v| v.as_str()).unwrap_or("");
            let by = p.get("by").and_then(|v| v.as_str()).unwrap_or("");
            // `join` (board #382): put the agent in a RUNNING team of this
            // project at runtime; absent or empty = standalone, as before.
            // The team's definition is never edited (tenet 7).
            let join = p.get("join").and_then(|v| v.as_str()).map(str::trim).filter(|t| !t.is_empty());
            let mut result = crate::projects::spawn::spawn(&crate::projects::spawn::SpawnRequest {
                session, agent, brief, by, team: join.map(str::to_string), ..Default::default()
            })
            .map_err(RpcError::InvalidParams)?;
            // The spawn is chat-visible: the room is the record.
            let who = if by.is_empty() { "human" } else { by };
            let win = result.get("window_name").and_then(|v| v.as_str()).unwrap_or(agent).to_string();
            // `[tmm] ` marks a lifecycle line: the client renders it
            // as a system row rather than a chat bubble. A machine
            // marker, not a glyph — how it LOOKS is the UI's call.
            let _ = rooms::post(&room, who, &spawn_line(&win, join, brief));
            // The room line is the human's record; the team's members hear
            // it in their panes (reviewer P1-B on 56a3ad44).
            if let Some(team) = join {
                let backend = result.get("backend").and_then(|v| v.as_str()).unwrap_or("").to_string();
                tell_team_of_join(session, team, &win, &backend, by, brief);
            }
            result["team"] = serde_json::json!(join);
            Ok(result)
        }

        other => Err(RpcError::MethodNotFound(format!("unknown hub method: {other}"))),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn handle_hub_request(req: &Request, notifications: Option<&crate::agent_notifications::AgentNotificationHub>) -> Response {
    Response::from_outcome(req.id, dispatch_hub(req, notifications))
}


#[cfg(any(target_os = "android", target_os = "ios"))]
pub(super) fn handle_hub_request(req: &Request, _notifications: Option<&crate::agent_notifications::AgentNotificationHub>) -> Response {
    Response::err(req.id, ERR_METHOD_NOT_FOUND, "hub not available on this platform".into())
}

/// Window index whose NAME is the agent name. Spawned agents own their window
/// name (projects `up` renames by slot); adopted agents match by window name
/// too, which is the best identity tmux offers.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The backend of a managed agent's live pane, from its processes (#260).
fn agent_backend(session: &str, agent: &str) -> Option<crate::backends::Backend> {
    let panes = crate::tmux::list_panes(session).ok()?;
    let p = panes.iter().find(|p| p.window_name == agent && p.active)?;
    p.agent.and_then(crate::backends::Backend::parse)
}

/// Start a managed agent whose window is gone, from its CURRENT definition
/// (the restart after the kill, or a start after a stop). Recreates THIS
/// slot from the declaration; a window younger than the capture loop's
/// 120 s rule may not be in it yet, so it falls back to a fresh spawn — a
/// new conversation instead of a resumed one, still better than an agent
/// that does not come back. True when it resumed; `Err` is the spawn's own
/// error, which the caller reports as `restart failed: …`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn start_agent(session: &str, agent: &str) -> Result<bool, String> {
    let mut resumed = false;
    // A joined agent (board #382: a team in its recipe, no member) stays in
    // its team when the fallback below spawns it fresh.
    let mut joined = None;
    if let Ok(Some(project)) = crate::projects::project_for_session(session) {
        joined = crate::projects::joined_team(Some(&project.path), agent);
        // Bring the agent's materials up to date with the CURRENT
        // definition + app-wide AGENTS.md first: the recipe replay is
        // verbatim, so whatever is on disk now is what the agent will
        // be. `refresh_agent` re-materializes prompt/config/recipe
        // when the window name resolves to a registry def; when it
        // cannot (a uniquified teammate, a team-role synthetic), the
        // hooks refresh below still repairs observation, exactly as
        // before.
        if !crate::projects::spawn::refresh_agent(&project.path, session, agent) {
            crate::projects::spawn::refresh_hooks(&project.path, agent);
        }
        resumed = crate::projects::up_agent(&project.id, agent).unwrap_or(false) && window_of_agent(session, agent).is_some();
    }
    if !resumed {
        crate::projects::spawn::spawn(&crate::projects::spawn::SpawnRequest {
            session, agent, brief: "", by: "", team: joined, resume: true, ..Default::default()
        })?;
    }
    Ok(resumed)
}

/// A solo spawn's room line, in the lifecycle grammar `sysParts` reads
/// (verb, subject, detail). A join names its team (board #382) the way a team
/// spawn does (`— team t`), so the existing members, who are not
/// re-materialized, learn of their new teammate from the room.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn spawn_line(win: &str, join: Option<&str>, brief: &str) -> String {
    match (join, brief.is_empty()) {
        (None, true) => format!("[tmm] spawned {win}"),
        (None, false) => format!("[tmm] spawned {win} — {brief}"),
        (Some(t), true) => format!("[tmm] spawned {win} — joined team {t}"),
        (Some(t), false) => format!("[tmm] spawned {win} — joined team {t}: {brief}"),
    }
}

/// Type the join notice (`delivery::join_notice`) into the pane of every
/// CURRENT member of team `root` in this session (board #382, reviewer P1-B
/// on 56a3ad44): a live managed window whose recipe puts it in that team,
/// other than the joiner. Not a solo agent, not another team's member, not
/// the joiner itself; nobody is restarted or re-materialized. Through the one
/// delivery door (`deliver_chat_line`), so a busy queue-mode member gets it
/// at its turn's end like any other line. Returns who it was typed to.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tell_team_of_join(session: &str, root: &str, joiner: &str, backend: &str, by: &str, brief: &str) -> Vec<String> {
    let notice = crate::projects::delivery::join_notice(joiner, root, backend, by, brief, &stamp_now());
    tell_team(session, root, joiner, &notice, &|| true)
}

/// Announce `agent`'s team as it stands (board #384), from FACTS, not
/// replayed from the request (P1-B residual and the orchestrator's ruling):
/// the recipe's current team against the announcer's ledger (`recipe::Told`,
/// what each recipient was last told). Run in the agent's announcement turn
/// (`recipe::announcement`), for the revision `rev` it committed; a turn whose
/// revision is no longer current says nothing, because the latest one covers
/// what it skipped. Otherwise: the room line, then exactly the difference
/// (`recipe::plan`): "x left your team" to every recipient told x is its
/// teammate who no longer has it, the join notice to every current live
/// member not yet told, and the agent its current team once. Each notice goes
/// through the one delivery door gated on `rev` (`deliver_if`), and the
/// ledger records a recipient only when the door delivered (typed or held)
/// to it, so a fan-out cut short by a newer move leaves the rest to that
/// move's turn. The ledger never decides membership: the recipe does.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn announce_move(session: &str, room: &str, ws: &str, agent: &str, rev: u64, room_line: &str, by: &str, _turn: &crate::projects::recipe::Held) -> Announced {
    use crate::projects::recipe::{plan, update_recipe, current_team_rev, Told};
    let home = crate::projects::spawn::agent_home(ws, agent);
    let current = || current_team_rev(&home) == rev;
    if !current() {
        return Announced::default();
    }
    let _ = crate::projects::rooms::post(room, agent, room_line);
    let Ok(Some((team, told))) = update_recipe(&home, |r| r.as_ref().map(|r| {
        let team = r.get("team").and_then(|v| v.as_str()).unwrap_or("").split('/').next().unwrap_or("").to_string();
        (team, Told::of(r).unwrap_or_default())
    })) else { return Announced::default() };
    // A team whose live members cannot be read (tmux could not be asked) is
    // NOT a team with nobody in it (board #388): nobody of it is told it
    // joined or left, and the next announcement retries.
    let read = if team.is_empty() { Ok(Vec::new()) } else { team_members(session, &team, agent) };
    let unread = read.as_ref().err().map(|e| { eprintln!("projects: move of '{agent}': team '{team}' members could not be read ({e}); they are told at its next move"); team.clone() });
    let todo = plan(&told, &team, &members_or_told(read, &told, &team));
    let stamp = stamp_now();
    let backend = std::cell::OnceCell::new();
    let deliver = |to: &str, owed: &Owed| {
        let line = match owed {
            Owed::Left(was) => crate::projects::delivery::left_notice(agent, was, &stamp),
            // The one reading of a pane's agent, recipe first: a managed
            // window that fell back to a shell is still kiro.
            Owed::Joined => crate::projects::delivery::moved_in_notice(agent, &team, backend.get_or_init(|| crate::tmux::list_panes(session).unwrap_or_default().iter()
                .find(|p| p.window_name == agent && p.active)
                .and_then(|p| crate::projects::agents::detect_pane(Some(ws), p))
                .map(|a| a.backend).unwrap_or("")), by, &stamp),
            Owed::Mover => {
                let mates = if team.is_empty() { Vec::new() } else { crate::projects::spawn::team_mates(ws, &team, agent) };
                crate::projects::delivery::moved_notice(agent, &team, &told.mover, &mates, &stamp)
            }
        };
        crate::projects::delivery::agent_target(session, to)
            .is_some_and(|target| crate::projects::delivery::deliver_if(session, to, &target, &line, &current))
    };
    let mut out = tell_difference(&home, agent, &team, &todo, &deliver);
    for to in &out.unrecorded {
        eprintln!("projects: move of '{agent}': @{to} was told, but the recipe could not record it; a later move may tell it again");
    }
    out.unread = unread;
    out
}

/// What an announcement owes one recipient (board #384).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum Owed<'a> {
    /// "x left your team", for the team the recipient was told.
    Left(&'a str),
    /// "x joined your team", for the agent's current team.
    Joined,
    /// The agent itself: its current team.
    Mover,
}

/// How an announcement went (board #388), for the caller to say so.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Default, PartialEq)]
struct Announced {
    /// The recipients the delivery door did not take a notice for: still
    /// owed, so the ledger is unchanged for them and the next announcement
    /// tells them.
    untold: Vec<String>,
    /// Told, but the ledger write failed: a later announcement may tell them
    /// again (at least once, never silently "recorded").
    unrecorded: Vec<String>,
    /// The current team, when its live members could not be read.
    unread: Option<String>,
}

/// The bookkeeping half of an announcement (board #384/#388), the delivery
/// injected: each owed notice goes through `deliver`, and the ledger
/// (`team_told`, through the recipe's door) takes a recipient only when the
/// door delivered to it. A refused one stays as it was, so the next
/// announcement owes it again. A failed write is reported, never taken as
/// recorded.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tell_difference(home: &std::path::Path, agent: &str, team: &str, todo: &crate::projects::recipe::Plan, deliver: &dyn Fn(&str, &Owed) -> bool) -> Announced {
    use crate::projects::recipe::{update_recipe, Told};
    let mut out = Announced::default();
    let record = |change: &dyn Fn(&mut Told)| update_recipe(home, |r| match r.as_mut() {
        Some(r) => { let mut t = Told::of(r).unwrap_or_default(); change(&mut t); r["team_told"] = t.to_value(); true }
        None => false,
    }).unwrap_or(false);
    let mut settle = |to: &str, owed: Owed, change: &dyn Fn(&mut Told)| {
        if !deliver(to, &owed) {
            out.untold.push(to.to_string());
        } else if !record(change) {
            out.unrecorded.push(to.to_string());
        }
    };
    for (to, was) in &todo.left {
        settle(to, Owed::Left(was), &|t| { if t.members.get(to) == Some(was) { t.members.remove(to); } });
    }
    for to in &todo.joined {
        settle(to, Owed::Joined, &|t| { t.members.insert(to.clone(), team.to_string()); });
    }
    if todo.mover {
        settle(agent, Owed::Mover, &|t| t.mover = team.to_string());
    }
    out
}

/// The current team's live members for an announcement's plan (board #388):
/// as read, or, when they could not be read, exactly the recipients already
/// told for this team, so the plan owes nobody of it a "joined" or a "left"
/// (an unread team is not an empty one), while recipients told for another
/// team are still told they left.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn members_or_told(read: Result<Vec<String>, String>, told: &crate::projects::recipe::Told, team: &str) -> Vec<String> {
    read.unwrap_or_else(|_| told.members.iter().filter(|(_, t)| t.as_str() == team).map(|(r, _)| r.clone()).collect())
}

/// The CURRENT live managed members of team `root` in this session other
/// than `except`, by window (board #382/#384): the one reading of "the
/// team's live members" the join, move and leave notices share. `Err` when
/// they cannot be read (no project, tmux could not be asked): never an
/// empty team (board #388).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn team_members(session: &str, root: &str, except: &str) -> Result<Vec<String>, String> {
    let project = crate::projects::project_for_session(session)?.ok_or_else(|| format!("no project for session '{session}'"))?;
    let ws = Some(project.path.as_str());
    let mut members: Vec<String> = crate::tmux::list_panes(session)?
        .into_iter()
        .map(|p| p.window_name)
        .filter(|name| name != except && crate::projects::is_managed_in(ws, name))
        .filter(|name| crate::projects::team_of(ws, name).is_some_and(|t| t.split('/').next() == Some(root)))
        .collect();
    members.sort();
    members.dedup();
    Ok(members)
}

/// Type `notice` into the pane of every CURRENT live member of team `root`
/// in this session other than `except` (board #382/#384): the one reading of
/// "the team's live members" the join, move and leave notices share, through
/// the one delivery door; `still_due` is its gate (`deliver_if`, checked in
/// the step that types or holds). Returns who it was typed to.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tell_team(session: &str, root: &str, except: &str, notice: &str, still_due: &dyn Fn() -> bool) -> Vec<String> {
    // #382's join notice at spawn stays best effort: an unread team tells nobody.
    team_members(session, root, except).unwrap_or_default().into_iter()
        .filter(|name| crate::projects::delivery::agent_target(session, name)
            .is_some_and(|target| crate::projects::delivery::deliver_if(session, name, &target, notice, still_due)))
        .collect()
}

/// The room line of a runtime team move (board #384), in the lifecycle
/// grammar `sysParts` reads, verb first.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn move_line(agent: &str, team: &str, left: &str) -> String {
    match (team.is_empty(), left.is_empty()) {
        (false, true) => format!("[tmm] moved {agent} — to team {team}"),
        (false, false) => format!("[tmm] moved {agent} — to team {team}, from team {left}"),
        (true, _) => format!("[tmm] left {agent} — team {left}, now standalone"),
    }
}

/// What a team restart says about an agent that JOINED the team at runtime
/// (board #382): the restart aligns the team with its definition, which does
/// not list it, so it is left running as it was. One line per such agent.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn kept_line(win: &str, team: &str) -> String {
    format!("[tmm] kept {win} — joined team {team}, not in its definition: the restart left it as it is")
}

fn window_of_agent(session: &str, agent: &str) -> Option<usize> {
    let panes = crate::tmux::list_panes(session).ok()?;
    panes.iter().find(|p| p.window_name == agent).map(|p| p.window)
}

/// Pump newly-appended hub messages to one connection (board #107). The wire
/// frame keeps the `team_message` method name the client has always listened
/// for — renaming the frame would break every deployed client for zero
/// behaviour change. Lagged receivers re-sync via hub_log on demand.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) async fn hub_push_loop(out_tx: tokio::sync::mpsc::UnboundedSender<super::Outbound>) {
    let mut rx = crate::projects::rooms::subscribe();
    loop {
        match rx.recv().await {
            Ok(msg_json) => {
                let frame = serde_json::json!({
                    "id": null,
                    "method": "team_message",
                    "params": { "message": serde_json::from_str::<serde_json::Value>(&msg_json).unwrap_or(serde_json::Value::Null) },
                });
                if out_tx.send(super::Outbound::Encrypted(serde_json::to_string(&frame).unwrap())).is_err() {
                    return; // send task gone
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// When the quoted message was said (board #290, validator 12:23 P2):
/// `HH:MM` today, `YYYY-MM-DD HH:MM` otherwise — the client's `localWhen`
/// rule, so a quote from yesterday does not read as today. Pure over `now`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn quote_when(ts_ms: i64, now: chrono::DateTime<chrono::Local>) -> String {
    let Some(t) = chrono::DateTime::from_timestamp_millis(ts_ms).map(|t| t.with_timezone(&chrono::Local)) else { return String::new() };
    if t.date_naive() == now.date_naive() { t.format("%H:%M").to_string() } else { t.format("%Y-%m-%d %H:%M").to_string() }
}

/// Put a reply's quote after the body's leading addresses (board #290):
/// `@builder [re …] text` — the addresses stay first, where every reader of
/// a delivered line looks for them.
fn quote_into(quote: &str, body: &str) -> String {
    let mut rest = body.trim_start();
    let mut head: Vec<&str> = Vec::new();
    while rest.starts_with('@') {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        head.push(&rest[..end]);
        rest = rest[end..].trim_start();
    }
    let head = if head.is_empty() { String::new() } else { format!("{} ", head.join(" ")) };
    format!("{head}{quote}{rest}")
}

/// Local wall-clock stamp for a line an agent will read: `2026-08-17 16:31`.
/// Minute precision on purpose — this is context, not a log timestamp.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn stamp_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// Typing one stamped line into one managed agent's pane lives in
/// `projects::managed` since board #224 (the spawn path types a kimi brief
/// through the same door); this is the same function under its old name.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) use crate::projects::deliver_chat_line;

/// How a board save reaches the world beyond the board (board #377): the two
/// things the hand-off needs from outside, injected so the whole handler can be
/// driven with a post that fails or a roster that says no — which is the only
/// honest test of "the save landed and the telling did not".
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct HandOff<'a> {
    /// Post the brief as `who` and type it into the mentioned pane
    /// (`post_and_deliver`); the answer is the stored row, with `offline` when
    /// the mention reached no pane.
    post: &'a dyn Fn(&str, &str) -> Result<serde_json::Value, String>,
    /// Is `name` a managed agent DECLARED by this project (its home carries the
    /// launch recipe)? Declaration, not liveness: a stopped agent is still this
    /// project's agent, and "not running" is reported as `offline`.
    managed: &'a dyn Fn(&str) -> bool,
    /// Read the issue back after the save (`board_get`). It can fail AFTER the
    /// write committed, and that must not turn a saved issue into an error.
    read: &'a dyn Fn(&str, i64) -> Result<serde_json::Value, String>,
}

/// `hub_board_save`: create or patch an issue, record an assignee change in the
/// room, and — only when the request ASKS (`dispatch: true`, board #377) — hand
/// the issue to the assignee.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn board_save(session: &str, room: &str, p: &serde_json::Value, hand: &HandOff) -> Result<serde_json::Value, RpcError> {
    use crate::projects::rooms;

    let issue_id = p.get("id").and_then(|v| v.as_i64());
    let s = |k: &str| p.get(k).and_then(|v| v.as_str());
    let who = s("who").unwrap_or("human");
    // The recipient is decided HERE, at the door, once (board #377 review
    // P1-C): the assignee is "" (a clear), `human`, or ONE agent name. It is
    // never re-read out of text later, so a name like "dev @all" cannot widen
    // into two addresses and "all" cannot broadcast. Nothing is saved or
    // posted for an assignee that is not one of those.
    let assignee = match s("assignee") {
        None => None,
        Some(raw) => Some(board_assignee(raw).map_err(RpcError::InvalidParams)?),
    };
    // The board and the agents' live states are TWO AXES (an issue's
    // lifecycle vs a window's turn), joined at EVENTS, not merged: a
    // status change is recorded in the room so the flow is visible,
    // and a move to REVIEW is a HANDOFF — the reporter (created_by)
    // gets the line typed into its pane, because a review nobody is
    // told about is how issues rot in the third column (owner,
    // 2026-08-29: the ideal loop is 人填 issue → lead 派 → 子 agent
    // 完成交 review → 通过标 done). Reporter "human" reads the board
    // itself; the actor is never notified of its own move.
    let prev = issue_id.and_then(|iid| crate::projects::board_get(session, iid).ok());
    let saved = crate::projects::board_save(session, issue_id, s("title"), s("body"), s("status"), assignee, who).map_err(RpcError::InvalidParams)?;
    // EVERYTHING from here on is the "saved" branch (board #377 review, P1-A
    // residual): the write has committed, so no step below may leave through
    // `?` and turn a saved issue into an RPC error — a page that kept its
    // create form open on an error would file it twice. A step that fails
    // says so in the answer's `dispatch`; the id always comes back.
    //
    // The issue as it is STORED now (new values won, notes and all): the room
    // line names it and the brief is built from it, so a request that edits
    // the title and assigns in one go cannot announce the old title. If it
    // cannot be read back, the issue is named by its id and the hand-off
    // (which needs the whole issue) reports why it did not go.
    let issue = (hand.read)(session, saved);
    let named = match &issue {
        Ok(i) => crate::projects::issue_ref(i["title"].as_str().unwrap_or(""), i["body"].as_str().unwrap_or(""), saved),
        Err(_) => format!("#{saved}"),
    };
    // An assignment is a board CHANGE like a status move, so it leaves the
    // same kind of record (board #367): one room line, from whichever surface
    // made it — the UI's picker, `tmm board assign`, `tmm board take`. Only
    // when the assignee really CHANGES.
    let was = prev.as_ref().and_then(|p| p["assignee"].as_str()).unwrap_or("");
    if let Some(line) = board_assign_line(was, &named, assignee, saved) {
        let _ = rooms::post(room, who, &line);
    }
    // And the assignee is TOLD (board #377; the UI's rule since board #11,
    // owner 2026-08-29 "Assign 给某个 Agent 去做"). The hand-off is made HERE,
    // once, so the page and `tmm board assign` carry no brief of their own and
    // differ only in `who`. It is OPT-IN per request (`dispatch: true`, sent
    // only by clients that know this server can do it, see `LOGIN_CAPS`): an
    // older client posts its own brief after a plain save, and a server that
    // dispatched that save as well would tell the agent twice. Naming the
    // assignee tells it — also when it is the one it already has, which is how
    // a person re-sends a hand-off to an agent that was offline the first
    // time. The save has already landed, so how the telling went is part of
    // the ANSWER, never an error: a failed post must not read as a failed
    // save (a form kept open for a retry would file the issue twice).
    let mut answer = serde_json::json!({ "ok": true, "id": saved });
    let wants = p.get("dispatch").and_then(|v| v.as_bool()) == Some(true);
    if let (true, Some(name)) = (wants, board_assign_target(assignee, who)) {
        let outcome = board_dispatch(name, (hand.managed)(name), || {
            let issue = issue.as_ref().map_err(|e| format!("#{saved} was saved but could not be read back to build the hand-off: {e}"))?;
            let brief = board_assign_brief(saved, issue, who, name);
            (hand.post)(who, &brief)
        });
        answer["dispatch"] = serde_json::json!(outcome.state);
        if let Some(error) = outcome.error {
            answer["dispatch_error"] = serde_json::json!(error);
        }
        // A mention no pane received comes back as `offline`, as `hub_post`'s
        // does, so `tmm board assign` can say it where its user is looking
        // (#347).
        if let Some(offline) = outcome.offline {
            answer["offline"] = offline;
        }
    }
    if let (Some(prev), Some(new_status)) = (&prev, s("status")) {
        let old_status = prev["status"].as_str().unwrap_or("");
        if old_status != new_status {
            // Titles are optional (board #31): every surface
            // that NAMES an issue speaks issue_ref's fallback
            // (title → body excerpt → #id), so a titleless
            // issue never renders an empty head or a dangling
            // separator.
            let title = crate::projects::issue_ref(
                prev["title"].as_str().unwrap_or(""),
                prev["body"].as_str().unwrap_or(""),
                saved,
            );
            let _ = rooms::post(&room, who, &format!("[tmm] board #{saved} {old_status} → {new_status} — {title}"));
            if new_status == "review" {
                let reporter = prev["created_by"].as_str().unwrap_or("");
                if !reporter.is_empty() && reporter != "human" && reporter != who {
                    // The handoff CARRIES the mover's last note —
                    // their own account of what was done — so the
                    // reviewer can usually decide from the message
                    // (owner, 2026-08-30: concise, no busywork).
                    let last_note = prev["notes"].as_array()
                        .and_then(|n| n.last())
                        .and_then(|n| n["body"].as_str())
                        .map(|b| format!(" — {}", excerpt(b, NOTICE_EXCERPT)))
                        .unwrap_or_default();
                    let line = format!(
                        "[tmm chat {}] {who}: [board #{saved} review] {title}{last_note}. `tmm board move {saved} done` to accept, or note what to fix + move doing.",
                        stamp_now()
                    );
                    deliver_chat_line(session, reporter, &line);
                }
            }
        }
    }
    // A change SOMEBODY ELSE made to your issue is only real
    // once you hear about it (owner, 2026-08-30: "不然这个更
    // 改就没有起任何作用。消息就是发给被 assign 的人"): the
    // ASSIGNEE gets the change typed into its pane. The pure
    // half (`board_change_notice`) decides; skips are part of
    // its contract — the actor never hears its own edit, an
    // unassigned issue and the human assignee have nobody to
    // wake, and a save that NAMES an assignee is a
    // (re)assignment with its own hand-off (the brief above),
    // where a second line would be noise.
    if let Some(prev) = &prev {
        if let Some(what) = board_change_notice(prev, who, s("title"), s("body"), s("status"), assignee.is_some()) {
            let assignee = prev["assignee"].as_str().unwrap_or("");
            // The head names the issue as it NOW reads (new
            // values win), through the same issue_ref fallback.
            let title = crate::projects::issue_ref(
                s("title").unwrap_or(prev["title"].as_str().unwrap_or("")),
                s("body").unwrap_or(prev["body"].as_str().unwrap_or("")),
                saved,
            );
            // The change itself travels in the line (values, not
            // "something changed"); the `…` in a long excerpt is
            // the one signal that `tmm board show` has more.
            let line = format!(
                "[tmm chat {}] {who}: [board #{saved}] {title}: {what}",
                stamp_now()
            );
            deliver_chat_line(session, assignee, &line);
        }
    }
    Ok(answer)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The room line an assignee CHANGE leaves (board #367), or `None` when this
/// save does not change one. Written in the lifecycle grammar every other
/// `[tmm]` line speaks (`sysParts`: verb, subject, detail), so the feed reads
/// it with the atoms it already has: `assigned <name> — board #N <title>`,
/// and `unassigned <name> — …` when the issue is handed back to nobody, which
/// names who LOST it because that is the fact a reader needs. `was` is the
/// stored assignee (empty for a new issue) and `named` the issue as the save
/// leaves it, through `issue_ref`.
fn board_assign_line(was: &str, named: &str, assignee: Option<&str>, id: i64) -> Option<String> {
    let next = assignee?.trim();
    let old = was.trim();
    if next == old {
        return None;
    }
    Some(if next.is_empty() {
        format!("[tmm] unassigned {old} — board #{id} {named}")
    } else {
        format!("[tmm] assigned {next} — board #{id} {named}")
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The assignee a save may name (board #377 review P1-C): empty (a clear),
/// `human`, or ONE agent name that `agents::valid_name` accepts. Anything else
/// is refused before a byte is saved or posted. `all` passes `valid_name` (it
/// is only letters) but is `@all`, the broadcast, so it is refused by name;
/// "dev @all" and "dev ops" fail `valid_name`'s character rule. Returns the
/// trimmed name the rest of the handler uses.
fn board_assignee(raw: &str) -> Result<&str, String> {
    let name = raw.trim();
    if name.is_empty() || name == "human" {
        return Ok(name);
    }
    if name.eq_ignore_ascii_case("all") {
        return Err("assignee 'all' is the broadcast address, not an agent".into());
    }
    crate::projects::agents::valid_name(name)
        .map_err(|e| format!("assignee must be one agent's name, `human`, or empty: {e}"))?;
    Ok(name)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// Who a save HANDS the issue to (board #377), or `None` when nobody is told:
/// no assignee in the save, a clear (nobody to tell), `human` (reads the board
/// itself) or the actor (`tmm board take` is a claim, and your own edit is not
/// news). `assignee` is the name `board_assignee` validated.
fn board_assign_target<'a>(assignee: Option<&'a str>, who: &str) -> Option<&'a str> {
    let name = assignee?.trim();
    (!name.is_empty() && name != "human" && name != who).then_some(name)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// How the telling went, for the save's answer (board #377 review P1-A).
struct Dispatch {
    /// `sent` (the brief was POSTED and delivery found a live pane for the
    /// name — not proof it was typed: a pane in copy mode or a held queue is
    /// reported separately, as for any message), `offline` (saved, but nothing
    /// was delivered: the name is not this project's agent, or its agent is
    /// stopped or could not be asked) or `failed` (the read-back or the post
    /// itself failed).
    state: &'static str,
    error: Option<String>,
    /// `hub_post`'s own `offline` rows (#347), when the brief was posted.
    offline: Option<serde_json::Value>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// Tell `name`: only a managed agent of THIS project is dispatched to (any
/// other name is saved and reported `offline`, with nothing posted), and a
/// failed post is an outcome, not an error — the issue is already saved.
fn board_dispatch(name: &str, managed: bool, post: impl FnOnce() -> Result<serde_json::Value, String>) -> Dispatch {
    if !managed {
        return Dispatch {
            state: "offline",
            error: Some(format!("{name} is not a managed agent of this project, so nothing was posted")),
            offline: None,
        };
    }
    match post() {
        Err(e) => Dispatch { state: "failed", error: Some(e), offline: None },
        Ok(msg) => {
            let rows = msg.get("offline").cloned().filter(|v| v.as_array().is_some_and(|a| !a.is_empty()));
            Dispatch { state: if rows.is_some() { "offline" } else { "sent" }, error: None, offline: rows }
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The characters of note thread a hand-off may carry (board #42). The whole
/// original title and body ride in full; only the discussion under the issue
/// gets a budget, so a long thread — or ONE giant note — can never inject an
/// unbounded wall of text into the agent's pane.
const ASSIGN_NOTES_BUDGET: usize = 1200;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// Below this many characters of remaining budget a partial note is not worth
/// a fragment: the truncation marker speaks for it instead.
const NOTE_SLICE_MIN: usize = 48;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The note thread an assignment carries (board #42: the discussion under an
/// issue is context the agent must not miss). A block the caller APPENDS to
/// the brief — a blank line and a counted `Notes (N):` header keep it clearly
/// apart from the description — or `""` when there are no notes.
///
/// Chronological (`at` ascending, whatever order the caller holds), one line
/// per note with its author; a note's inner whitespace squashes to single
/// spaces so a note stays a line and the budget stays character math. Lines
/// stop at `budget` characters in total — a note that does not fit whole is
/// sliced on the remaining room (dropped when the room is a sliver) — and any
/// cut ends the block with the one pointer to the rest: `tmm board show <id>`.
/// Authors and bodies are quoted text: they pass through `unaddressed`.
fn board_assign_notes(id: i64, notes: &[serde_json::Value], budget: usize) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut ordered: Vec<&serde_json::Value> = notes.iter().collect();
    ordered.sort_by_key(|n| n["at"].as_i64().unwrap_or(0));
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut shown = 0usize; // notes visible at all: whole, or the one budget-cut slice
    let mut cut = false;
    for n in &ordered {
        let body = n["body"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
        let line = crate::address::unaddressed(&format!("- {}: {body}", n["author"].as_str().unwrap_or("")));
        let len = line.chars().count();
        let room = budget.saturating_sub(used);
        if len <= room {
            lines.push(line);
            used += len;
            shown += 1;
        } else {
            if room >= NOTE_SLICE_MIN {
                let slice: String = line.chars().take(room).collect();
                lines.push(format!("{}…", slice.trim_end()));
                shown += 1; // partly visible: the `…` speaks for its rest, not "+1 more"
            }
            cut = true;
            break;
        }
    }
    let more = ordered.len() - shown; // notes the pane never sees at all
    let tail = if cut || more > 0 {
        format!("\n…{} — `tmm board show {id}`", if more > 0 { format!(" +{more} more") } else { String::new() })
    } else {
        String::new()
    };
    format!("\n\nNotes ({}):\n{}{tail}", ordered.len(), lines.join("\n"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The hand-off an assignment types into the assignee's pane (board #377):
/// the ONE brief, from the page, `tmm board assign` and `add --assignee`.
/// It reads as a hand-off — who assigned it comes FIRST, then the ENTIRE
/// original title and body (the agent's task input; never an excerpt: the
/// paste path has no 400-character ceiling), then the note thread under its
/// own budget, and the instruction to `take` it LAST (boards #42, #51, #79;
/// owner 2026-08-29: "Assign 给某个 Agent 去做" means the agent starts with the
/// complete issue plus bounded discussion). Plain English, not an i18n atom:
/// it is input to an agent.
///
/// It leads with an `@mention` so the ONE delivery path types it into that
/// pane, and `name` (the validated assignee) is the only address in it: the
/// title, body, notes and `who` are quoted text and become `＠` through the
/// project's one de-addressing rule (board #367 review P1-A — "修复 @all 的
/// 投递" would otherwise have typed the hand-off into every pane). The stored
/// issue is untouched. `issue` is the stored row, notes included.
fn board_assign_brief(id: i64, issue: &serde_json::Value, who: &str, name: &str) -> String {
    use crate::address::unaddressed;

    let title = issue["title"].as_str().unwrap_or("").trim();
    // A titleless issue is named by its id: its body already rides in full.
    let title = if title.is_empty() { format!("#{id}") } else { unaddressed(title) };
    let body = issue["body"].as_str().unwrap_or("").trim();
    // A body that already ends its sentence is not given a second full stop
    // ("…is quiet.." read as a typo to the agent; found by the validator).
    let body = if body.is_empty() {
        ".".to_string()
    } else if body.ends_with(['.', '。', '!', '?', '！', '？']) {
        format!(" — {}", unaddressed(body))
    } else {
        format!(" — {}.", unaddressed(body))
    };
    let notes = issue["notes"].as_array().map(|n| board_assign_notes(id, n, ASSIGN_NOTES_BUDGET)).unwrap_or_default();
    format!(
        "@{name} [board #{id}] {} assigned this to you: {title}{body}{notes}\n\
         Please `tmm board take {id}` to start, note findings on it, move to review when done.",
        unaddressed(who)
    )
}

/// The ONE carrier of a posted line to its readers: store it, route it to the
/// names it `@mention`s and type it into their panes (`deliver_mentions`).
/// `hub_post` and an assignment's hand-off (board #377) both come through
/// here, so a hand-off is delivered exactly as a person's message is. The
/// answer is the stored row, with `offline` (#347) when a mention reached no
/// pane.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn post_and_deliver(session: &str, room: &str, from: &str, body: &str, detached: bool) -> Result<serde_json::Value, String> {
    use crate::projects::rooms;

    let recipients = crate::address::mention_names(body);
    let mut msg = rooms::post_routed(room, from, body, &recipients)?;
    let seq = msg.get("seq").and_then(|v| v.as_i64());
    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let offline = deliver_mentions(session, from, body, room, seq, &id, detached);
    if !offline.is_empty() {
        // The answer carries it so the CALLER can say it where its user is
        // looking — `tmm send` on stderr (#347).
        let rows: Vec<serde_json::Value> = offline
            .iter()
            .map(|(name, why)| serde_json::json!({ "name": name, "why": why }))
            .collect();
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("offline".into(), serde_json::Value::Array(rows));
        }
    }
    Ok(msg)
}

/// Pure half of the assignee notification (owner, 2026-08-30): given the
/// PREVIOUS issue row and what this save carries, decide whether the assignee
/// should hear about it and name the change. `None` when: nobody is assigned,
/// the assignee is the actor (your own edit is not news), the assignee is the
/// human (who reads the board itself), the save NAMES an assignee (that has its own
/// hand-off, the brief), the save MOVES the issue to done (board #30, owner
/// 2026-08-31: "如果任务我标记为done可以不用给agent发送提示了" — acceptance
/// ENDS the work, there is nothing left for the executor to act on, so even
/// title/body riding along with the closing save stay quiet; the room's
/// `[tmm] board … → done` line still records it, and a LATER edit to an
/// already-done issue — a reopen included — is ordinary news again), or
/// nothing actually changed (a save echoing the stored values is a no-op,
/// not an event).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn board_change_notice(
    prev: &serde_json::Value,
    who: &str,
    title: Option<&str>,
    body: Option<&str>,
    status: Option<&str>,
    assigns: bool,
) -> Option<String> {
    let assignee = prev["assignee"].as_str().unwrap_or("");
    if assignee.is_empty() || assignee == who || assignee == "human" || assigns {
        return None;
    }
    let mut changes: Vec<String> = Vec::new();
    if let Some(ns) = status {
        let old = prev["status"].as_str().unwrap_or("");
        // The closing act suppresses the WHOLE save, not just the status
        // atom: a mixed save's title/body arrived as part of accepting the
        // work, and a wake with the status line stripped would still wake.
        if ns == "done" && old != "done" {
            return None;
        }
        if old != ns {
            changes.push(format!("status {old} → {ns}"));
        }
    }
    if let Some(t) = title {
        if t != prev["title"].as_str().unwrap_or("") {
            changes.push(format!("title → \"{t}\""));
        }
    }
    if let Some(b) = body {
        if b != prev["body"].as_str().unwrap_or("") {
            changes.push(format!("body now: {}", excerpt(b, NOTICE_EXCERPT)));
        }
    }
    if changes.is_empty() { None } else { Some(changes.join("; ")) }
}

/// A note on an issue reaches BOTH declared parties — its current assignee
/// and its reporter (`created_by`) — minus the note's author and minus the
/// human, who reads the board itself (board #26, #255). The recipients are
/// derived from the issue, never from what the note says: a reviewer's SHIP
/// note on an issue the lead opened reaches the lead (the merger) as well as
/// the implementer, which is exactly the route that was missing when five of
/// six 2026-09-27 stalls left the merger unaware (temp/stall-analysis.md).
/// Pure half: decide whom to wake and carry enough issue context that each
/// recipient can act without first fetching the board. Delivery itself is
/// still `deliver_chat_line`, whose managed/live gate and receipt bookkeeping
/// are the authority. No recipients when only the author/human is left —
/// persistence remains the fallback, never an RPC error or a self-prompt.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn board_note_notice(
    issue: &serde_json::Value,
    author: &str,
    body: &str,
) -> Option<(Vec<String>, String)> {
    let mut targets: Vec<String> = Vec::new();
    for key in ["assignee", "created_by"] {
        let who = issue[key].as_str().unwrap_or("");
        if !who.is_empty() && who != "human" && who != author && !targets.iter().any(|t| t == who) {
            targets.push(who.to_string());
        }
    }
    if targets.is_empty() {
        return None;
    }
    let id = issue["id"].as_i64().unwrap_or(0);
    let title = crate::projects::issue_ref(
        issue["title"].as_str().unwrap_or(""),
        issue["body"].as_str().unwrap_or(""),
        id,
    );
    let note = excerpt(body, NOTICE_EXCERPT);
    if note.is_empty() {
        return None;
    }
    let notice = format!(
        "[board #{id} reply] {title} — {note}. Reply on the issue with `tmm board note {id} \"...\"`."
    );
    Some((targets, notice))
}

/// The delivered-message budget (owner, 2026-08-30: "尽量保证我们发送的内容
/// 比较简洁，避免 Agent 去做过多无谓的消耗"): a notification CARRIES its
/// context so the reader usually needs no lookup round-trip, but never a
/// wall of text. The `…` is the truncation signal — an agent that sees it
/// knows `tmm board show N` has the rest; a message without it is complete.
const NOTICE_EXCERPT: usize = 400;

/// First `max` chars, cut on a char boundary, `…`-marked when shortened.
fn excerpt(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

const TEAM_CONTEXT_HISTORY_LIMIT: i64 = 1000;
const TEAM_CONTEXT_MAX_MESSAGES: usize = 40;
const TEAM_CONTEXT_MAX_CHARS: usize = 12 * 1024;
const TEAM_CONTEXT_BODY_CHARS: usize = 1600;

#[derive(Debug, Clone, PartialEq)]
struct RoutedChat {
    ts: i64,
    from: String,
    to: Vec<String>,
    body: String,
    hidden: bool,
}

fn context_noise(body: &str) -> bool {
    let body = body.trim_start();
    body.starts_with("[tmm] ")
        || body.starts_with("[tmm status ")
        || body.starts_with("[tmm done]")
}

/// Read sender → recipient edges from the room's durable `to` field. Older
/// hook replies with no stored route fall back to the senders waiting on that
/// agent; only legacy/test rows that lack `to` parse mentions from prose.
#[cfg(test)]
fn route_chat_history(messages: &[serde_json::Value], agents: &[String]) -> Vec<RoutedChat> {
    route_chat_history_hiding(messages, agents, &std::collections::HashSet::new())
}

fn route_chat_history_hiding(
    messages: &[serde_json::Value],
    agents: &[String],
    hidden_ids: &std::collections::HashSet<String>,
) -> Vec<RoutedChat> {
    let known: std::collections::HashSet<&str> = agents.iter().map(String::as_str).collect();
    let mut pending: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut routed = Vec::new();
    for message in messages {
        if message
            .get("kind")
            .and_then(|value| value.as_str())
            .is_some_and(|kind| kind != "msg")
        {
            continue;
        }
        let from = message.get("from").and_then(|v| v.as_str()).unwrap_or("").trim();
        let body = message.get("body").and_then(|v| v.as_str()).unwrap_or("").trim();
        if from.is_empty() || body.is_empty() || context_noise(body) {
            continue;
        }
        let stored_to_field = message.get("to").and_then(|value| value.as_array());
        let stored_to: Vec<String> = stored_to_field
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let has_stored_to = stored_to_field.is_some();
        let mentions = if has_stored_to { stored_to } else { crate::address::mention_names(body) };
        let to = if mentions.is_empty() {
            if from == "human" {
                vec!["room".to_string()]
            } else {
                pending.remove(from).unwrap_or_else(|| vec!["room".to_string()])
            }
        } else {
            for mention in &mentions {
                let targets: Vec<&str> = if mention == "all" {
                    known.iter().copied().filter(|target| *target != from).collect()
                } else if has_stored_to || known.contains(mention.as_str()) {
                    vec![mention]
                } else {
                    Vec::new()
                };
                for target in targets {
                    let senders = pending.entry(target.to_string()).or_default();
                    if !senders.iter().any(|sender| sender == from) {
                        senders.push(from.to_string());
                    }
                }
            }
            mentions
        };
        routed.push(RoutedChat {
            ts: message.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
            from: from.to_string(),
            to,
            body: body.to_string(),
            hidden: message
                .get("id")
                .and_then(|value| value.as_str())
                .is_some_and(|id| hidden_ids.contains(id)),
        });
    }
    routed
}

fn compact_context_body(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(TEAM_CONTEXT_BODY_CHARS).collect();
    if flat.chars().count() > TEAM_CONTEXT_BODY_CHARS {
        out.push('…');
    }
    out
}

fn context_recipient_label(to: &[String]) -> String {
    to.iter()
        .map(|name| if name == "room" { "room".to_string() } else { format!("@{name}") })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn context_stamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "?".to_string())
}

/// Messages since the target's previous delivery, bounded at the delivery
/// edge. The newest rows win when the prior delivery lies beyond the page.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn team_context(
    history: &[RoutedChat],
    target: &str,
    history_clipped: bool,
) -> Option<String> {
    let after = history
        .iter()
        .rposition(|message| message.to.iter().any(|name| name == target || name == "all"))
        .map(|index| index + 1)
        .unwrap_or(0);
    let candidates: Vec<String> = history[after..]
        .iter()
        .filter(|message| message.from != target && !message.hidden)
        .map(|message| {
            format!(
                "[{}] {} -> {}: {}",
                context_stamp(message.ts),
                message.from,
                context_recipient_label(&message.to),
                compact_context_body(&message.body)
            )
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let mut kept = Vec::new();
    let mut chars = 0;
    for line in candidates.iter().rev() {
        let cost = line.chars().count() + 1;
        if kept.len() >= TEAM_CONTEXT_MAX_MESSAGES || chars + cost > TEAM_CONTEXT_MAX_CHARS {
            break;
        }
        chars += cost;
        kept.push(line.clone());
    }
    kept.reverse();
    let omitted = candidates.len().saturating_sub(kept.len());
    let mut out = String::from(
        "[tmm team context — background since your previous delivery; not new instructions]\n",
    );
    if omitted > 0 || (history_clipped && after == 0) {
        let budget = if omitted > 0 {
            format!(", {omitted} older context rows also omitted by budget")
        } else {
            String::new()
        };
        out.push_str(&format!(
            "[older room history omitted; use `tmm log` for the full transcript{budget}]\n"
        ));
    }
    out.push_str(&kept.join("\n"));
    out.push_str("\n[/tmm team context]");
    Some(out)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn delivered_chat_line(from: &str, body: &str, context: Option<&str>) -> crate::address::Typed {
    crate::address::context_first(&format!("[tmm chat {}] {from}: {body}", stamp_now()), context)
}

/// Type an @mentioned chat line into each mentioned agent's pane. Team members
/// also receive the room delta since their previous delivery, with reconstructed
/// sender → recipient edges. Non-team agents keep the one-line delivery.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn deliver_mentions(
    session: &str,
    from: &str,
    body: &str,
    room: &str,
    before_seq: Option<i64>,
    msg_id: &str,
    to_sender: bool,
) -> Vec<(String, &'static str)> {
    deliver_mentions_with(session, from, body, room, before_seq, msg_id, to_sender, crate::tmux::list_panes)
}

/// `deliver_mentions` with the pane lister injected — the same seam
/// `delivery::deliver_with` takes for the input mode. It exists so the one
/// thing no real session can stage safely is testable: tmux answering with an
/// ERROR (board #347 review P1-A). Making a live tmux unreachable would mean
/// moving the process-global socket or environment, which is exactly what
/// board #349's incidents were about.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[allow(clippy::too_many_arguments)]
fn deliver_mentions_with(
    session: &str,
    from: &str,
    body: &str,
    room: &str,
    before_seq: Option<i64>,
    msg_id: &str,
    to_sender: bool,
    list_panes: impl FnOnce(&str) -> Result<Vec<crate::tmux::TmuxPane>, String>,
) -> Vec<(String, &'static str)> {
    use crate::projects::agents;

    let mentions = crate::address::mention_names(body);
    if mentions.is_empty() {
        return Vec::new();
    }
    let ws = crate::projects::project_for_session(session).ok().flatten().map(|p| p.path);
    // A session we cannot list is a session that typed NOTHING, so every
    // mention is unreachable and the sender must still hear it (board #347
    // review P1-B: the whole session being stopped was the one case that
    // stayed silent). `offline_report` runs with no panes and no deliveries.
    let panes = match list_panes(session) {
        Ok(panes) => panes,
        // Two different facts (review P1-A, 02:30): tmux SAYS the session is
        // not there — then every declared name is honestly `stopped` — or
        // tmux could not be asked at all, and then we cannot call anyone
        // stopped, only `unchecked`.
        Err(e) => {
            let checked = crate::tmux::session_confirmed_absent(&e);
            return offline_report(session, room, from, &mentions, &[], ws.as_deref(), checked);
        }
    };
    let managed_names: Vec<String> = panes
        .iter()
        .filter(|pane| crate::projects::is_managed_in(ws.as_deref(), &pane.window_name))
        .map(|pane| pane.window_name.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let needs_context = panes.iter().any(|pane| {
        mentions.iter().any(|name| name == &pane.window_name || name == "all")
            && crate::projects::team_of(ws.as_deref(), &pane.window_name).is_some()
    });
    let (history, history_clipped) = if needs_context {
        let page = crate::projects::rooms::history_page(room, before_seq, TEAM_CONTEXT_HISTORY_LIMIT);
        let hidden: std::collections::HashSet<String> =
            crate::projects::archived_ids(room).into_iter().collect();
        let messages: Vec<serde_json::Value> = page
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        (
            route_chat_history_hiding(&messages, &managed_names, &hidden),
            page.get("has_more").and_then(|v| v.as_bool()).unwrap_or(false),
        )
    } else {
        (Vec::new(), false)
    };
    let mut seen = std::collections::HashSet::new();
    // Who was FOUND: a live managed pane that a mention matched. Whether the
    // one delivery path then typed the line, held it for a busy queue-mode
    // agent (#257) or had it refused by the pane (copy mode, #250) is
    // `deliver`'s to say — the last has its own `undelivered` warn — so none
    // of the three makes a found agent "offline". Deriving offline from "not
    // accepted" reported a live agent whose pane merely refused as `stopped`
    // (review P1-A, 02:30).
    let mut found: Vec<String> = Vec::new();
    for p in &panes {
        if !seen.insert(p.window) || !p.active {
            continue;
        }
        let is_agent = agents::detect_pane(ws.as_deref(), p).is_some();
        // The sender is skipped: a line is never typed back into the pane
        // that sent it. A fired wake is the one exception (`to_sender`,
        // board #275): an agent that scheduled "@me later" must be woken;
        // so is a post the CLI found detached from the sender's turn (#285).
        if !is_agent || (p.window_name == from && !to_sender) {
            continue;
        }
        // MANAGED windows only. `@all` would otherwise type into a kiro the user
        // started by hand in this directory — the app does not own that session,
        // and injecting a chat line into it is not ours to do. Same gate as
        // hub_agents' participant list and the stop-hook auto-post.
        if !crate::projects::is_managed_in(ws.as_deref(), &p.window_name) {
            continue;
        }
        let matched = mentions.iter().any(|m| m == &p.window_name || m == "all");
        if !matched {
            continue;
        }
        let target = format!("{}:{}.{}", session, p.window, p.pane);
        // The stamp is for the agent, not for us: a CLI reads this line inside a
        // conversation that may have been idle for hours, and "when was this
        // said" is context it otherwise has no way to recover — its own clock
        // only tells it `now`. Local wall time, minute precision; seconds would
        // be noise in a chat line.
        let context = crate::projects::team_of(ws.as_deref(), &p.window_name)
            .and_then(|_| team_context(&history, &p.window_name, history_clipped));
        let line = delivered_chat_line(from, body, context.as_deref());
        // The one delivery path (board #257): typed now, or — for a busy
        // queue-mode agent — held and typed combined at its turn's end. The
        // context is computed HERE, at the line's own moment, so held lines'
        // deltas abut instead of overlapping. Typed is not confirmed: the
        // agent's userPromptSubmit echo settles it, and a pane that refused
        // it (#250, copy mode) is said in the feed.
        found.push(p.window_name.clone());
        crate::projects::delivery::deliver(session, &p.window_name, &target, &line.text, line.ask_at, msg_id);
    }
    // A mention that matched no live managed agent is SAID (board #347,
    // owner: "当这个 agent 不在会话，或者停止什么的时候要返回一个 warning，提示
    // agent 不在线"). It used to be dropped in silence, which reads exactly
    // like a delivery that landed — the sender waits for an answer that
    // cannot come. `offline_report` writes the record and tells the sender's
    // pane; `tmm send` prints the same words on stderr from the list this
    // returns. The `declared` half inside it — which of these names this
    // project HAS a managed home for — is what separates a stopped teammate
    // from a name that was never here.
    offline_report(session, room, from, &mentions, &found, ws.as_deref(), true)
}

/// Say which mentions matched no live managed agent, and return them for the
/// caller's own answer (board #347). Two channels, because they reach
/// different readers: one room line per name — the record, which the feed
/// and `tmm log` show — and ONE line typed into the SENDER's pane, which is
/// the only thing that reaches an agent sender (the team context drops every
/// `[tmm]` row and a Team agent's delta excludes its own messages: review
/// P1-A). A human or a UI sender has no pane, and `deliver_chat_line` is
/// quiet about that; a sender pane that refuses the notice gets the ordinary
/// `undelivered` warn and nothing is retried.
///
/// `checked` is whether tmux could answer at all. When it could not, no
/// name is called stopped: `declared` is withheld and every name reads
/// `unchecked`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn offline_report(
    session: &str, room: &str, from: &str, mentions: &[String], found: &[String],
    ws: Option<&str>, checked: bool,
) -> Vec<(String, &'static str)> {
    let declared: Vec<String> = mentions
        .iter()
        .filter(|name| crate::projects::is_managed_in(ws, name))
        .cloned()
        .collect();
    let offline = crate::projects::delivery::offline_mentions(
        mentions, found, checked.then_some(declared.as_slice()), from,
    );
    if offline.is_empty() {
        return Vec::new();
    }
    for (name, why) in &offline {
        // Posted under the SENDER's name with no recipients, which is what
        // the feed's `offline` row reads. Addressing it to the sender looked
        // like the way to reach them and is the way to hide it: `team_context`
        // takes the newest row whose `to` holds the target as that target's
        // delivery cursor, so the delta would start AFTER the warning (and
        // would drop a row whose `from` is the target anyway). The sender's
        // pane gets its own copy below instead.
        let _ = crate::projects::rooms::post(
            room,
            from,
            &crate::projects::delivery::offline_line(name, why, from),
        );
    }
    let notice = crate::projects::delivery::offline_notice(&offline, &stamp_now());
    crate::projects::deliver_chat_line(session, from, &notice);
    offline.into_iter().map(|(name, why)| (name.to_string(), why)).collect()
}

/// The soonest pending wake addressed to `name` (an `@name` or `@all` in
/// its body), for the card's hover: `{due_at, from, more}` where `more` is
/// how many others follow; null when none (board #275).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn next_wake(wakes: &[crate::projects::store::Wake], name: &str) -> serde_json::Value {
    let mut mine = wakes
        .iter()
        .filter(|w| crate::projects::wakes::addressed_to(w, name));
    match mine.next() {
        Some(w) => serde_json::json!({ "due_at": w.due_at, "from": w.sender, "more": mine.count() }),
        None => serde_json::Value::Null,
    }
}

/// Fire one scheduled wake (board #275), called by `projects::wakes::run`
/// on a blocking thread with the wake's id. Claim first, so a wake posts at
/// most once, and fire with the row the claim read — its CURRENT session,
/// whatever renames happened while the sleeper waited; then the
/// ordinary post-and-deliver path as its scheduler, with the sender included
/// (a self-wake reaches its own pane). The project is resolved NOW, so a
/// rename since scheduling still finds it; recipients are read NOW.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn fire_wake(id: i64) {
    let Some(w) = crate::projects::wakes::claim(id) else { return };
    let w = &w;
    let session = crate::projects::project_for_session(&w.session)
        .ok()
        .flatten()
        .map(|p| p.session)
        .unwrap_or_else(|| w.session.clone());
    let room = project_room(&session);
    let body = crate::projects::wakes::fired_body(w, crate::projects::now() as i64);
    let recipients = crate::address::mention_names(&body);
    let Ok(msg) = crate::projects::rooms::post_routed(&room, &w.sender, &body, &recipients) else { return };
    let seq = msg.get("seq").and_then(|v| v.as_i64());
    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    // A fired wake has no caller to answer: its room line is the record.
    let _ = deliver_mentions(&session, &w.sender, &body, &room, seq, id, true);
}

/// One row per live window: name, command, agent detection, derived status,
/// and whether the window is MANAGED — spawned from the registry into an
/// isolated home. Managed agents are chat participants; direct windows
/// (shells, agents the user started by hand) are terminal things and the UI
/// presents them only there. The marker is the isolated home dir itself:
/// <workspace>/.tmm/agents/<window_name>/ exists iff spawn materialized it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn agent_states(session: &str) -> serde_json::Value {
    use crate::projects::{agents, telemetry};

    let ws = crate::projects::project_for_session(session)
        .ok()
        .flatten()
        .map(|p| p.path);
    let panes = crate::tmux::list_panes(session).unwrap_or_default();
    let activity: std::collections::HashMap<usize, u64> =
        crate::tmux::window_activity_times(session).into_iter().collect();

    // Group panes by window, represent each window by its active pane (the
    // same rule the projects capture uses).
    let mut windows: std::collections::BTreeMap<usize, &crate::tmux::TmuxPane> = std::collections::BTreeMap::new();
    for p in &panes {
        windows
            .entry(p.window)
            .and_modify(|cur| {
                if p.active {
                    *cur = p;
                }
            })
            .or_insert(p);
    }
    let live: Vec<String> = windows.values().map(|p| p.window_name.clone()).collect();
    telemetry::retain_windows(session, &live);
    crate::projects::vitals::retain_windows(session, &live);

    // Each window's pane id: the live input mode is remembered per pane (#271).
    let pane_ids: std::collections::HashMap<String, String> = crate::tmux::list_named_windows(session).into_iter().collect();
    // Pending wakes, soonest first (board #275): each card's hover names the
    // next one addressed to it.
    let wakes = crate::projects::wakes::pending(Some(session));
    let rows: Vec<serde_json::Value> = windows
        .values()
        .map(|p| {
            let agent = agents::detect_pane(ws.as_deref(), p);
            let st = telemetry::derive(session, &p.window_name, activity.get(&p.window).copied().unwrap_or(0));
            let managed = agent.is_some() && crate::projects::is_managed_in(ws.as_deref(), &p.window_name);
            // What the agent's own status line says: model, context used, effort,
            // branch. There is no API for a CLI's live state, so it is SNIFFED
            // from the last lines of the pane — hence managed agents only (we
            // know their status line's shape), every field optional, and the
            // object omitted entirely when nothing could be read. One
            // capture-pane per agent, capped at 4 per project.
            // A miss is normal — the pane may be mid-repaint, a tool's output may
            // have pushed the status line up — so the reading REMEMBERS: gaps are
            // filled field by field from the last good one (1 h TTL), and the
            // memory is kept WARM by `sniff_window_soon` at every hook edge and
            // delivered chat line, so this poll usually just reads it. Treating
            // every miss as "no information" is what made the card blink empty.
            // The same capture also says which queue/steer mode the session
            // RUNS (#271): the one derivation, `delivery::input_mode_seen`.
            let screen = if managed {
                crate::tmux::capture_pane_plain(&format!("{session}:{}", p.window), Some(0)).ok()
            } else {
                None
            };
            let vitals = screen
                .as_deref()
                .map(|text| {
                    crate::projects::vitals::sniff_remembered(
                        session,
                        &p.window_name,
                        text,
                        &p.window_name,
                        agent.map(|a| a.backend).unwrap_or(""),
                    )
                })
                .unwrap_or_default();
            let input_mode = screen.as_deref().and_then(|text| {
                let pane = pane_ids.get(&p.window_name).map(String::as_str).unwrap_or("");
                crate::projects::delivery::input_mode_seen(session, &p.window_name, pane, text)
            });
            serde_json::json!({
                "window": p.window,
                "name": p.window_name,
                "command": p.current_command,
                "agent": agent.map(|a| a.backend),
                "managed": managed,
                // The configured team this window was started as part of
                // (board #74) — the Hub groups same-team cards; null = solo.
                "team": if managed { crate::projects::team_of(ws.as_deref(), &p.window_name) } else { None },
                // In that team by a JOIN, not by its definition (board #382):
                // a team restart leaves it as it is, a team stop stops it.
                "joined": managed && crate::projects::joined_team(ws.as_deref(), &p.window_name).is_some(),
                "state": if agent.is_some() { st.state.as_str() } else { "shell" },
                "detail": st.detail,
                "since": st.since,
                "vitals": if vitals.is_empty() { serde_json::Value::Null } else { serde_json::to_value(&vitals).unwrap_or(serde_json::Value::Null) },
                // queue|steer this session runs, where the backend has the choice (#271).
                "input_mode": input_mode,
                "wake": if managed { next_wake(&wakes, &p.window_name) } else { serde_json::Value::Null },
            })
        })
        .collect();
    let stopped_teams = stopped_teams(ws.as_deref(), &live);
    serde_json::json!({ "session": session, "agents": rows, "stopped_teams": stopped_teams })
}

/// The team of every agent home whose window is NOT live (board #258): a
/// stopped card carries no row in `hub_agents`, and a team's "Start stopped"
/// needs to know which stopped identities are its members. Read off each
/// home's launch recipe — the same `team_of` a live row uses; a solo agent,
/// or a home without a recipe, is simply absent. So is a member the team's
/// CURRENT definition no longer has (board #287, validator 06:53): its recipe
/// still names the team, but starting the team must not bring it back.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn stopped_teams(ws: Option<&str>, live: &[String]) -> serde_json::Map<String, serde_json::Value> {
    stopped_teams_in(ws, live, crate::projects::spawn::in_current_team)
}

/// `stopped_teams` with the membership test injected (`current(path, member)`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn stopped_teams_in(ws: Option<&str>, live: &[String], current: impl Fn(&str, &str) -> bool) -> serde_json::Map<String, serde_json::Value> {
    ws.and_then(|w| std::fs::read_dir(std::path::Path::new(w).join(".tmm").join("agents")).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !live.contains(name))
        .filter_map(|name| {
            let team = crate::projects::team_of(ws, &name)?;
            let member = crate::projects::member_of(ws, &name);
            // A pre-#113 recipe names no member: kept, as before.
            (member.is_empty() || current(&team, &member)).then(|| (name, team.into()))
        })
        .collect()
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::super::test_util::req;
    use super::*;
    use crate::projects::rooms;
    use crate::projects::telemetry;

    /// Every store-touching test seeds its own unique session/room: the test
    /// store (state.db under TMM_STATE_DB) is one file per process, and the
    /// hub's messages now live in it for real — the Bridge double died with
    /// TeamBridge (board #107).
    fn unique(prefix: &str) -> (String, String) {
        let session = format!("{prefix}-{}", uuid::Uuid::new_v4());
        let room = format!("proj:{session}");
        (session, room)
    }

    /// A registered project in a scratch workspace with one DECLARED agent home
    /// per name (the launch recipe is what makes a home managed), so the
    /// handler's "is this a managed agent of THIS project" check has an answer
    /// without a tmux server. Answers its session.
    fn project_with(names: &[&str]) -> String {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let ws = std::env::temp_dir().join(format!("tmm-handoff-ws-{tag}"));
        let recipe = serde_json::json!({ "backend": "kiro", "cmd": "kiro-cli chat --agent x", "team": "" }).to_string();
        for name in names {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), &recipe).unwrap();
        }
        let label = format!("handoff-{tag}");
        let made = crate::projects::create(&ws.to_string_lossy(), Some(&label), Some(&label), None).expect("project");
        made["session"].as_str().expect("session").to_string()
    }

    /// One `hub_board_save` through the RPC, the way either surface makes it.
    /// Answers the whole result.
    fn save_issue(session: &str, mut params: serde_json::Value) -> serde_json::Value {
        params["session"] = serde_json::json!(session);
        let r = handle_hub_request(&req("hub_board_save", params), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        r.result.expect("result")
    }

    fn issue_id(answer: &serde_json::Value) -> i64 {
        answer["id"].as_i64().expect("the saved id")
    }

    /// The room's messages, oldest first.
    fn room(session: &str) -> Vec<serde_json::Value> {
        let r = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session, "limit": 200 })), None);
        r.result.expect("result")["messages"].as_array().expect("messages").clone()
    }

    /// The messages addressed to somebody: the hand-offs.
    fn told(session: &str) -> Vec<serde_json::Value> {
        room(session).into_iter().filter(|m| m["to"].as_array().is_some_and(|t| !t.is_empty())).collect()
    }

    /// The `[tmm] assigned` / `unassigned` records.
    fn records(session: &str) -> Vec<String> {
        room(session)
            .iter()
            .filter_map(|m| m["body"].as_str())
            .filter(|b| b.starts_with("[tmm] assigned") || b.starts_with("[tmm] unassigned"))
            .map(str::to_string)
            .collect()
    }

    /// The real read-back: what the handler uses.
    fn stored(session: &str, id: i64) -> Result<serde_json::Value, String> {
        crate::projects::board_get(session, id)
    }

    fn issue_count(session: &str) -> usize {
        crate::projects::board_list(session).expect("board")["issues"].as_array().map_or(0, |a| a.len())
    }

    /// The assignee-notification decision (owner, 2026-08-30): pure, so the
    /// skips are pinned without tmux. The delivery half reuses the same
    /// `deliver_chat_line` the review handoff and done-summary edges use.
    /// Board #258: stopped members are named with their recipe team; live
    /// windows and solo agents are not in the map.
    #[test]
    fn stopped_teams_names_each_stopped_member_by_its_recipe_team() {
        let ws = std::env::temp_dir().join(format!("tmm-stopped-teams-{}", uuid::Uuid::new_v4()));
        for (name, team, member) in [("qa", "squad", "qa"), ("sub", "squad/inner", "sub"), ("solo", "", ""), ("lead", "squad", "lead"), ("gone", "squad", "archivist"), ("old", "squad", "")] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "team": team, "member": member }).to_string()).unwrap();
        }
        // Board #287: `archivist` left the team's definition; a pre-#113
        // recipe (no member) is kept.
        let current = |_: &str, m: &str| m != "archivist";
        let map = super::stopped_teams_in(ws.to_str(), &["lead".to_string()], current);
        let mut got: Vec<(String, String)> = map.into_iter().map(|(k, v)| (k, v.as_str().unwrap().to_string())).collect();
        got.sort();
        assert_eq!(got, vec![("old".into(), "squad".into()), ("qa".into(), "squad".into()), ("sub".into(), "squad/inner".into())]);
        assert!(super::stopped_teams(None, &[]).is_empty());
        let _ = std::fs::remove_dir_all(ws);
    }

    /// Board #382: a join is recorded where everyone reads it, in the
    /// grammar the feed already parses, and so is a team restart that leaves
    /// a joined agent as it is.
    #[test]
    fn a_join_and_a_kept_joiner_leave_room_lines() {
        assert_eq!(super::spawn_line("helper", None, ""), "[tmm] spawned helper");
        assert_eq!(super::spawn_line("helper", None, "go"), "[tmm] spawned helper — go");
        assert_eq!(super::spawn_line("helper", Some("squad"), ""), "[tmm] spawned helper — joined team squad");
        assert_eq!(super::spawn_line("helper", Some("squad"), "go"), "[tmm] spawned helper — joined team squad: go");
        assert_eq!(super::kept_line("helper", "squad"), "[tmm] kept helper — joined team squad, not in its definition: the restart left it as it is");
    }

    /// Board #382 reviewer P1-B, on REAL panes: a join is typed to the team's
    /// current members and to nobody else: not the joiner, not a solo agent,
    /// not another team's member. Nobody is restarted (each pane keeps its
    /// process). Every window is `cat`, so a pane shows what was typed.
    #[test]
    fn a_join_is_typed_to_the_teams_current_members_only() {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let session = format!("tmm-join-{tag}");
        let ws = std::env::temp_dir().join(format!("tmm-join-ws-{tag}"));
        let windows = [("lead", "squad", "lead"), ("rev", "squad/review", "r1"), ("helper", "squad", ""), ("solo", "", ""), ("other", "ops", "dev")];
        for (name, team, member) in windows {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            let recipe = serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": team, "member": member });
            std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status().map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        for (name, _, _) in &windows[1..] {
            assert!(std::process::Command::new("tmux").args(["new-window", "-d", "-t", &format!("={session}:"), "-n", name, "-c", &ws.to_string_lossy(), "cat"]).status().unwrap().success());
        }
        crate::projects::adopt(&session, Some("join-live-test")).expect("adopt project");
        let pid = |name: &str| crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("{session}:{name}"), "#{pane_pid}"]).unwrap_or_default();
        let before: Vec<String> = windows.iter().map(|(n, _, _)| pid(n)).collect();

        let told = super::tell_team_of_join(&session, "squad", "helper", "kiro", "", "");
        assert_eq!(told, ["lead", "rev"], "the team's live members, sub-team included");
        let wanted = "tmm: [reply] @helper joined your team squad";
        let pane = |name: &str| crate::tmux::capture_pane_plain(&format!("{session}:{name}"), Some(0)).unwrap_or_default();
        for name in ["lead", "rev"] {
            let mut text = String::new();
            for _ in 0..30 {
                text = pane(name);
                if text.contains(wanted) { break; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            assert!(text.contains(wanted) && text.contains("[tmm chat "), "{name} got the notice in the stamped result shape: {text:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for name in ["helper", "solo", "other"] {
            assert!(!pane(name).contains("joined your team"), "{name} is not told: {:?}", pane(name));
        }
        let after: Vec<String> = windows.iter().map(|(n, _, _)| pid(n)).collect();
        assert_eq!(before, after, "nobody was restarted");
    }

    /// Board #384: a runtime move is recorded in the lifecycle grammar.
    #[test]
    fn a_move_leaves_one_room_line_in_the_lifecycle_grammar() {
        assert_eq!(super::move_line("helper", "squad", ""), "[tmm] moved helper — to team squad");
        assert_eq!(super::move_line("helper", "squad", "ops"), "[tmm] moved helper — to team squad, from team ops");
        assert_eq!(super::move_line("helper", "", "squad"), "[tmm] left helper — team squad, now standalone");
    }

    /// Board #384, on REAL panes: moving a running agent into a team edits
    /// its recipe only; the moved agent, the new team's live members and (on
    /// a leave) the old team's live members are told; a solo bystander and
    /// another team's member are not; nobody restarts; a definition member
    /// cannot be moved; a team not here is refused before anything changes.
    #[test]
    fn a_move_is_told_to_the_mover_and_both_teams_and_restarts_nobody() {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let session = format!("tmm-move-{tag}");
        let ws = std::env::temp_dir().join(format!("tmm-move-ws-{tag}"));
        let windows = [("lead", "squad", "lead"), ("helper", "", ""), ("solo", "", ""), ("other", "ops", "dev")];
        for (name, team, member) in windows {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            let recipe = serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": team, "member": member, "agent_def": name });
            std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status().map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        for (name, _, _) in &windows[1..] {
            assert!(std::process::Command::new("tmux").args(["new-window", "-d", "-t", &format!("={session}:"), "-n", name, "-c", &ws.to_string_lossy(), "cat"]).status().unwrap().success());
        }
        crate::projects::adopt(&session, Some("move-live-test")).expect("adopt project");
        let pid = |name: &str| crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("{session}:{name}"), "#{pane_pid}"]).unwrap_or_default();
        let before: Vec<String> = windows.iter().map(|(n, _, _)| pid(n)).collect();
        let pane = |name: &str| crate::tmux::capture_pane_plain(&format!("{session}:{name}"), Some(0)).unwrap_or_default();
        let wait_for = |name: &str, text: &str| {
            for _ in 0..30 {
                if pane(name).contains(text) { return true; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            false
        };
        let set = |agent: &str, team: &str| handle_hub_request(&req("hub_agent_set_team", serde_json::json!({ "session": session, "agent": agent, "team": team })), None);
        let recipe = |name: &str| -> serde_json::Value { serde_json::from_str(&std::fs::read_to_string(ws.join(".tmm/agents").join(name).join("launch.json")).unwrap()).unwrap() };

        let refused = set("helper", "ghost");
        assert!(refused.error.unwrap().message.contains("team 'ghost' has no member in this project"));
        assert_eq!(recipe("helper")["team"], "", "nothing changed");
        assert!(set("lead", "").error.unwrap().message.contains("change it in Agents > Teams"), "a definition member stays");

        let moved = set("helper", "squad");
        assert!(moved.error.is_none(), "{:?}", moved.error.map(|e| e.message));
        assert_eq!(moved.result.unwrap(), serde_json::json!({ "agent": "helper", "team": "squad", "left": null, "changed": true, "untold": [], "unread": null }));
        assert_eq!(recipe("helper")["team"], "squad");
        assert_eq!(recipe("helper")["member"], "", "a joined member");
        assert!(wait_for("lead", "tmm: [reply] @helper joined your team squad"), "the team's member is told: {:?}", pane("lead"));
        // The backend is the recipe's (`detect_pane`), not only a sniff of the
        // process: these panes run `cat`, as a managed window that fell back
        // to a shell does (live proof, 2026-10-15: "a  agent moved in").
        assert!(pane("lead").contains("a kiro agent moved in by human"), "its backend, and who moved it, not who started it: {:?}", pane("lead"));
        assert!(wait_for("helper", "tmm: [reply] @helper: you were moved into team squad at runtime"), "the mover is told: {:?}", pane("helper"));
        assert!(pane("helper").contains("Your prompt changes at your next start"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        for name in ["solo", "other"] {
            assert!(!pane(name).contains("[reply]"), "{name} is not told: {:?}", pane(name));
        }

        let again = set("helper", "squad");
        assert_eq!(again.result.unwrap()["changed"], false, "already there: nothing typed, nothing posted");

        let out = set("helper", "");
        assert_eq!(out.result.unwrap(), serde_json::json!({ "agent": "helper", "team": null, "left": "squad", "changed": true, "untold": [], "unread": null }));
        assert!(wait_for("lead", "tmm: [reply] @helper left your team squad"), "{:?}", pane("lead"));
        assert!(wait_for("helper", "you left team squad and are standalone now"), "{:?}", pane("helper"));
        let lines: Vec<String> = room(&session).iter().filter_map(|m| m["body"].as_str().map(str::to_string)).filter(|b| b.starts_with("[tmm] moved") || b.starts_with("[tmm] left")).collect();
        assert_eq!(lines, ["[tmm] moved helper — to team squad", "[tmm] left helper — team squad, now standalone"]);
        let after: Vec<String> = windows.iter().map(|(n, _, _)| pid(n)).collect();
        assert_eq!(before, after, "nobody was restarted");
    }

    /// Board #384, reviewer P1-B and its residual, on REAL panes with a
    /// barrier, starting from a REAL old team (helper joined squad by its
    /// recipe; no ledger is filled by hand). A move's announcement says what
    /// is true against what was told, and an overtaken one says nothing:
    ///   A -> B overtaken by B -> C: A (squad's lead) hears "left" once, B
    ///   (ops) hears nothing, C (core) hears "joined", the mover its current
    ///   team once, the room only the move that stands;
    ///   then A -> B overtaken by B -> A: nobody hears anything.
    /// And one agent's announcements wait their turn.
    #[test]
    fn an_announcement_tells_the_difference_and_an_overtaken_move_says_nothing() {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let session = format!("tmm-mvrev-{tag}");
        let ws = std::env::temp_dir().join(format!("tmm-mvrev-ws-{tag}"));
        let windows = [("lead", "squad", "lead"), ("helper", "squad", ""), ("ops1", "ops", "ops1"), ("core1", "core", "core1"), ("solo", "", "")];
        for (name, team, member) in windows {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            let recipe = serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": team, "member": member, "agent_def": name });
            std::fs::write(home.join("launch.json"), recipe.to_string()).unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status().map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        for (name, _, _) in &windows[1..] {
            assert!(std::process::Command::new("tmux").args(["new-window", "-d", "-t", &format!("={session}:"), "-n", name, "-c", &ws.to_string_lossy(), "cat"]).status().unwrap().success());
        }
        crate::projects::adopt(&session, Some("mvrev-live-test")).expect("adopt project");
        let pane = |name: &str| crate::tmux::capture_pane_plain(&format!("{session}:{name}"), Some(0)).unwrap_or_default();
        // A `cat` pane shows a typed line twice (the tty's echo, then cat's).
        let times = |name: &str, text: &str| pane(name).matches(text).count() / 2;
        let wait_for = |name: &str, text: &str| (0..30).any(|_| { let hit = pane(name).contains(text); if !hit { std::thread::sleep(std::time::Duration::from_millis(100)); } hit });
        let lines = || -> Vec<String> { room(&session).iter().filter_map(|m| m["body"].as_str().map(str::to_string)).filter(|b| b.starts_with("[tmm] moved") || b.starts_with("[tmm] left")).collect() };
        let ws_s = ws.to_string_lossy().to_string();
        let room_id = super::project_room(&session);
        let home = crate::projects::spawn::agent_home(&ws_s, "helper");
        let seed = |old: &str| super::team_members(&session, old, "helper");
        let set = |team: &str| handle_hub_request(&req("hub_agent_set_team", serde_json::json!({ "session": session, "agent": "helper", "team": team })), None);
        let quiet = |names: &[&str]| { std::thread::sleep(std::time::Duration::from_millis(400)); for n in names { assert!(!pane(n).contains("[reply]"), "{n} hears nothing: {:?}", pane(n)); } };

        // A -> B (squad -> ops) commits; its announcement is held back.
        let (_, changed1, rev1) = crate::projects::spawn::set_agent_team(&ws_s, "helper", "ops", &seed).unwrap();
        assert!(changed1);
        // B -> C (ops -> core) commits and is announced: the difference from
        // what was told (squad: lead), not a replay of its request (ops).
        assert_eq!(set("core").result.unwrap()["left"], "ops");
        assert!(wait_for("lead", "@helper left your team squad"), "the old team is told: {:?}", pane("lead"));
        assert!(wait_for("core1", "@helper joined your team core"), "{:?}", pane("core1"));
        assert!(wait_for("helper", "you were moved into team core"), "{:?}", pane("helper"));
        // Move 1's announcement is released: overtaken, it says nothing.
        super::announce_move(&session, &room_id, &ws_s, "helper", rev1, &super::move_line("helper", "ops", "squad"), "", &crate::projects::recipe::announcement(&home));
        quiet(&["ops1", "solo"]);
        assert_eq!(times("lead", "@helper left your team squad"), 1, "squad hears it left exactly once");
        assert_eq!(times("lead", "joined your team"), 0);
        assert_eq!(times("core1", "@helper joined your team core"), 1);
        assert_eq!(times("helper", "you were moved into team"), 1, "the mover is told once, its current team");
        assert!(!pane("helper").contains("moved into team ops"));
        assert_eq!(lines(), ["[tmm] moved helper — to team core, from team ops"], "the room says only the move that stands");

        // A -> B (core -> ops) overtaken by B -> A (ops -> core): core was
        // told helper is its teammate and still is; nobody hears anything.
        let (_, _, rev3) = crate::projects::spawn::set_agent_team(&ws_s, "helper", "ops", &seed).unwrap();
        assert!(set("core").error.is_none());
        super::announce_move(&session, &room_id, &ws_s, "helper", rev3, &super::move_line("helper", "ops", "core"), "", &crate::projects::recipe::announcement(&home));
        quiet(&["ops1", "solo"]);
        assert_eq!((times("core1", "tmm: [reply] @helper"), times("lead", "tmm: [reply] @helper"), times("helper", "tmm: [reply]")), (1, 1, 1), "A -> B -> A tells nobody anything new");

        // One agent's announcements in commit order: while one is told, the
        // next commits at once but is told after it.
        let turn = crate::projects::recipe::announcement(&home);
        let mover = { let s = session.clone(); std::thread::spawn(move || handle_hub_request(&req("hub_agent_set_team", serde_json::json!({ "session": s, "agent": "helper", "team": "" })), None)) };
        std::thread::sleep(std::time::Duration::from_millis(300));
        let recipe: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert_eq!((recipe["team"].as_str(), recipe["team_rev"].as_u64()), (Some(""), Some(5)), "committed at once");
        let before = lines().len();
        drop(turn);
        assert!(mover.join().unwrap().error.is_none());
        assert_eq!(lines().len(), before + 1, "told once the earlier turn ended");
        assert!(wait_for("core1", "@helper left your team core"));
    }

    /// Board #388 (validator R5/R5b): a notice the delivery door does not take
    /// records nothing, and the next announcement owes exactly that one again;
    /// a recipient the door took is recorded once. The mover too. A failed
    /// ledger write is reported, never taken as recorded.
    #[test]
    fn a_refused_notice_is_not_recorded_and_the_next_announcement_retries_it() {
        use crate::projects::recipe::{plan, update_recipe, Told};
        use std::cell::RefCell;
        let home = std::env::temp_dir().join(format!("tmm-told-{}", uuid::Uuid::new_v4())).join(".tmm/agents/helper");
        std::fs::create_dir_all(&home).unwrap();
        let seeded = Told { mover: "squad".into(), members: [("lead", "squad"), ("dev", "squad")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        update_recipe(&home, |r| *r = Some(serde_json::json!({ "team": "core", "team_told": seeded.to_value() }))).unwrap();
        let told = || Told::of(&serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap()).unwrap();
        let members = vec!["c1".to_string(), "c2".to_string()];
        let sent = RefCell::new(Vec::<String>::new());
        let refuse: RefCell<Vec<&str>> = RefCell::new(vec!["dev", "c2", "helper"]);
        let deliver = |to: &str, owed: &super::Owed| {
            let what = match owed { super::Owed::Left(t) => format!("left:{t}"), super::Owed::Joined => "joined".into(), super::Owed::Mover => "mover".into() };
            sent.borrow_mut().push(format!("{to}={what}"));
            !refuse.borrow().contains(&to)
        };
        // First announcement: dev's "left", c2's "joined" and the mover's notice are refused.
        let out = super::tell_difference(&home, "helper", "core", &plan(&told(), "core", &members), &deliver);
        assert_eq!(out.untold, ["dev", "c2", "helper"]);
        assert!(out.unrecorded.is_empty());
        assert_eq!(told(), Told { mover: "squad".into(), members: [("dev", "squad"), ("c1", "core")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() },
            "lead's left and c1's join are recorded; dev, c2 and the mover are as they were");
        // The next announcement owes exactly those again, and they now land.
        refuse.borrow_mut().clear();
        sent.borrow_mut().clear();
        let again = plan(&told(), "core", &members);
        let out = super::tell_difference(&home, "helper", "core", &again, &deliver);
        assert_eq!(*sent.borrow(), ["dev=left:squad", "c2=joined", "helper=mover"], "only what is still owed");
        assert_eq!(out, super::Announced::default());
        assert_eq!(told(), Told { mover: "core".into(), members: [("c1", "core"), ("c2", "core")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() });
        assert!(plan(&told(), "core", &members).left.is_empty() && plan(&told(), "core", &members).joined.is_empty() && !plan(&told(), "core", &members).mover, "nothing is owed now");

        // A delivered notice whose ledger write fails is reported, not recorded.
        let breaking = |to: &str, _: &super::Owed| { std::fs::write(home.join("launch.json"), "{ half").unwrap(); let _ = to; true };
        let todo = plan(&Told { mover: "core".into(), members: Default::default() }, "core", &["c3".to_string()]);
        let out = super::tell_difference(&home, "helper", "core", &todo, &breaking);
        assert_eq!(out.unrecorded, ["c3"], "told, but not recorded: said so");
        assert!(out.untold.is_empty());
        let _ = std::fs::remove_dir_all(home.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// Board #388: an unread team is not an empty team. Its members are taken
    /// as the ones already told for it, so the plan owes none of them a
    /// "joined" or a "left", while recipients told for another team are
    /// still told they left.
    #[test]
    fn an_unread_team_tells_none_of_its_own_and_still_tells_the_old_team() {
        use crate::projects::recipe::{plan, Told};
        let told = Told { mover: "squad".into(), members: [("lead", "squad"), ("c1", "core")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        let members = super::members_or_told(Err("tmux could not be asked".into()), &told, "core");
        assert_eq!(members, ["c1"]);
        let todo = plan(&told, "core", &members);
        assert_eq!(todo.left, [("lead".to_string(), "squad".to_string())], "the old team is still told");
        assert!(todo.joined.is_empty(), "nobody of the unread team is told it joined");
        assert_eq!(super::members_or_told(Ok(vec!["c2".into()]), &told, "core"), ["c2"], "a read list is used as read");
    }

    /// Board #382: a join into a team with nobody in this project is refused
    /// by name, before any window is opened (no tmux needed to see it).
    #[test]
    fn a_join_into_a_team_that_is_not_here_is_refused() {
        let session = project_with(&["solo"]);
        crate::projects::registry_save(&serde_json::json!({ "name": "jnr-helper", "backend": "kiro", "system": "", "skills": "[]", "mcp": "[]" })).unwrap();
        let r = handle_hub_request(&req("hub_spawn", serde_json::json!({ "session": session, "agent": "jnr-helper", "join": "squad" })), None);
        let e = r.error.expect("refused");
        assert_eq!((e.code, e.message.as_str()), (super::super::rpc::ERR_INVALID_PARAMS, "team 'squad' has no member in this project — start the team first, or spawn the agent standalone"));
        assert!(room(&session).iter().all(|m| !m["body"].as_str().unwrap_or("").contains("spawned")), "nothing was spawned or recorded");
        crate::projects::registry_delete("jnr-helper").ok();
    }

    /// Board #367: a reassignment used to leave NO trace in the room — only
    /// the new assignee heard, through the UI's brief. One line now, from
    /// whichever surface saved it, in the lifecycle grammar `sysParts`
    /// already reads (verb, subject, detail).
    #[test]
    fn an_assignee_change_leaves_one_room_line() {
        let named = "Fix the login flow";
        assert_eq!(
            super::board_assign_line("builder", named, Some("builder-2"), 12).as_deref(),
            Some("[tmm] assigned builder-2 — board #12 Fix the login flow")
        );
        // Handed back to nobody: the line names who LOST it.
        assert_eq!(
            super::board_assign_line("builder", named, Some(""), 12).as_deref(),
            Some("[tmm] unassigned builder — board #12 Fix the login flow")
        );
        // Saves that do not change the assignee say nothing — a status move,
        // a note, a re-save of the same name.
        assert_eq!(super::board_assign_line("builder", named, None, 12), None);
        assert_eq!(super::board_assign_line("builder", named, Some("builder"), 12), None);
        assert_eq!(super::board_assign_line("builder", named, Some(" builder "), 12), None, "whitespace is not a change");
        assert_eq!(super::board_assign_line("", named, Some(""), 12), None, "nobody to nobody is not a change");
        // A titleless issue is named by issue_ref's fallback, like every
        // other notice (board #31).
        let bare = crate::projects::issue_ref("", "   ", 9);
        assert_eq!(super::board_assign_line("", &bare, Some("dev"), 9).as_deref(), Some("[tmm] assigned dev — board #9 #9"));
    }

    /// Board #377: who a save hands the issue to. A validated name that is not
    /// the actor, not `human` and not empty — and nothing else.
    #[test]
    fn a_save_hands_the_issue_to_a_named_agent_who_is_not_the_actor() {
        let target = super::board_assign_target;
        assert_eq!(target(Some("builder-2"), "human"), Some("builder-2"), "the UI's picker");
        assert_eq!(target(Some("builder-2"), "lead"), Some("builder-2"), "tmm board assign");
        assert_eq!(target(Some("lead"), "lead"), None, "`take` is a claim: your own edit is not news");
        assert_eq!(target(Some("human"), "lead"), None, "the human reads the board itself");
        assert_eq!(target(Some(""), "lead"), None, "a clear has nobody to tell");
        assert_eq!(target(None, "lead"), None, "a save without an assignee hands nothing over");
    }

    /// Board #377 review P1-C: the recipient is validated at the save door.
    #[test]
    fn the_assignee_is_empty_human_or_one_agent_name() {
        let ok = super::board_assignee;
        assert_eq!(ok("builder-2"), Ok("builder-2"));
        assert_eq!(ok("  builder-2 "), Ok("builder-2"), "trimmed once, here");
        assert_eq!(ok("翻译"), Ok("翻译"), "any script is a name");
        assert_eq!(ok(""), Ok(""), "a clear");
        assert_eq!(ok("human"), Ok("human"));
        for bad in ["all", "All", "ALL", "dev @all", "@x", "@dev", "dev ops", "dev,ops", "a/b", "-dev", "x".repeat(65).as_str()] {
            assert!(ok(bad).is_err(), "{bad:?} must be refused");
        }
    }

    /// Board #377. The brief is the owner's (2026-08-29): who assigned it
    /// FIRST, the ENTIRE title and body, the notes in order, and the take
    /// instruction LAST — and the only address in it is the assignee.
    #[test]
    fn the_brief_carries_the_whole_issue_and_addresses_only_the_assignee() {
        let long_body = format!("Step one @lead. {} End.", "x".repeat(2000));
        let issue = serde_json::json!({
            "title": "Fix the delivery to @all", "body": long_body, "notes": [
                { "author": "lead", "body": "second: ask @reviewer", "at": 20 },
                { "author": "human", "body": "first:\n  check   the cache", "at": 10 },
            ],
        });
        let brief = super::board_assign_brief(7, &issue, "human @all", "builder-2");
        assert!(brief.starts_with("@builder-2 [board #7] human ＠all assigned this to you: Fix the delivery to ＠all — Step one ＠lead. "), "{brief}");
        assert!(brief.contains(&format!("{} End.", "x".repeat(2000))), "the WHOLE body, not an excerpt");
        let first = brief.find("- human: first: check the cache").expect("the first note, squashed to a line");
        let second = brief.find("- lead: second: ask ＠reviewer").expect("the second note");
        assert!(first < second, "chronological, whatever order they were stored in");
        assert!(brief.contains("\n\nNotes (2):\n"), "{brief}");
        assert!(brief.ends_with("Please `tmm board take 7` to start, note findings on it, move to review when done."), "take LAST: {brief}");
        assert_eq!(
            crate::address::mention_names(&brief),
            vec!["builder-2".to_string()],
            "title, body, notes and who are quoted text: they route nowhere\n{brief}"
        );
        // The brief applies the PRODUCTION budget: a long thread is cut in the
        // brief itself, and the cut points at the rest.
        let long_thread = serde_json::json!({
            "title": "T", "body": "B", "notes": [
                { "author": "a", "body": "n".repeat(700), "at": 1 },
                { "author": "b", "body": "n".repeat(700), "at": 2 },
                { "author": "c", "body": "unreached", "at": 3 },
            ],
        });
        let cut = super::board_assign_brief(7, &long_thread, "human", "dev");
        assert!(cut.contains("\n… +1 more — `tmm board show 7`\nPlease `tmm board take 7`"), "{cut}");
        assert!(!cut.contains("unreached") && cut.chars().count() < 1500, "bounded, however long the discussion: {} chars", cut.chars().count());
        // A body that already ends a sentence gets no second full stop.
        let ended = serde_json::json!({ "title": "T", "body": "It is quiet.", "notes": [] });
        assert!(super::board_assign_brief(7, &ended, "human", "dev").contains("T — It is quiet.\nPlease"), "one full stop, not two");
        let ended_cjk = serde_json::json!({ "title": "T", "body": "已经安静了。", "notes": [] });
        assert!(super::board_assign_brief(7, &ended_cjk, "human", "dev").contains("T — 已经安静了。\nPlease"));
        // No notes, no title: nothing appended, the id names the issue.
        let bare = serde_json::json!({ "title": "  ", "body": "", "notes": [] });
        assert_eq!(
            super::board_assign_brief(9, &bare, "human", "dev"),
            "@dev [board #9] human assigned this to you: #9.\nPlease `tmm board take 9` to start, note findings on it, move to review when done."
        );
    }

    /// Board #42, moved to the server with the brief (#377): the thread is
    /// chronological, authored, separated, and nothing is appended when there
    /// is none.
    #[test]
    fn the_note_thread_is_chronological_authored_and_separated() {
        let note = |author: &str, body: &str, at: i64| serde_json::json!({ "author": author, "body": body, "at": at });
        assert_eq!(super::board_assign_notes(7, &[], 1200), "");
        let out = super::board_assign_notes(42, &[
            note("builder-2", "second finding", 20),
            note("human", "first: check the cache", 10),
            note("lead", "third — ship it", 30),
        ], 1200);
        assert_eq!(out, "\n\nNotes (3):\n- human: first: check the cache\n- builder-2: second finding\n- lead: third — ship it");
        assert_eq!(
            super::board_assign_notes(5, &[note("a", "line one\n  line two\n\nline three", 1)], 1200),
            "\n\nNotes (1):\n- a: line one line two line three",
            "a note's inner newlines squash to spaces: one note stays ONE line"
        );
    }

    /// Board #42: the budget. One giant note cannot flood the pane, and every
    /// cut points at `tmm board show`.
    #[test]
    fn an_explicit_budget_truncates_and_points_at_the_rest() {
        let note = |author: &str, body: &str, at: i64| serde_json::json!({ "author": author, "body": body, "at": at });
        let giant = super::board_assign_notes(9, &[note("a", &"x".repeat(5000), 1)], 200);
        let lines: Vec<&str> = giant.split('\n').collect();
        assert_eq!(lines[2], "Notes (1):");
        assert!(lines[3].chars().count() <= 201, "the sliced line respects the budget (+ the … marker)");
        assert!(lines[3].ends_with('…'), "a partial note is marked");
        assert_eq!(lines[4], "… — `tmm board show 9`", "nothing wholly omitted, but the pointer to the rest stands");

        let many = super::board_assign_notes(11, &[
            note("a", &"k".repeat(90), 1),
            note("b", &"k".repeat(90), 2),
            note("c", "unreached", 3),
            note("d", "unreached too", 4),
        ], 200);
        assert!(many.ends_with("\n… +2 more — `tmm board show 11`"), "{many}");
        assert!(!many.contains("unreached"), "past-budget notes are not leaked");

        let sliver = super::board_assign_notes(3, &[note("a", &"k".repeat(180), 1), note("b", "a real point that matters", 2)], 200);
        assert!(!sliver.contains("- b:"), "a fragment under the minimum slice is not worth emitting");
        assert!(sliver.contains("+1 more"));

        let fits = super::board_assign_notes(4, &[note("a", "short", 1)], 200);
        assert!(!fits.contains("tmm board show"), "a fitting thread needs no pointer");
        // The budget counts CHARACTERS, not bytes: CJK is one each.
        let cjk = super::board_assign_notes(6, &[note("a", &"字".repeat(100), 1), note("b", &"字".repeat(100), 2)], 130);
        assert!(cjk.contains("- a: ") && cjk.chars().count() < 400, "{cjk}");
    }

    /// Board #377. The server, not the surface, makes the hand-off: one save
    /// through the RPC is exactly one line addressed to exactly the assignee,
    /// the same text whether the page's request (no `who`, so `human`) or
    /// `tmm board assign` (`who` = the agent) asked.
    #[test]
    fn a_flagged_save_hands_the_issue_over_once_whichever_surface_asked() {
        let session = project_with(&["builder-2"]);
        let issue = serde_json::json!({ "title": "Fix the login flow", "body": "Reproduce on a cold start" });
        let ui = issue_id(&save_issue(&session, issue.clone()));
        let cli = issue_id(&save_issue(&session, issue));
        assert_eq!(room(&session).len(), 0, "filing an unassigned issue says nothing");

        let a = save_issue(&session, serde_json::json!({ "id": ui, "assignee": "builder-2", "dispatch": true })); // the page
        let b = save_issue(&session, serde_json::json!({ "id": cli, "assignee": "builder-2", "who": "lead", "dispatch": true })); // tmm board assign
        // Declared but not running: saved, the room has it, nothing was typed.
        assert_eq!((a["dispatch"].as_str(), b["dispatch"].as_str()), (Some("offline"), Some("offline")));

        let rows = told(&session);
        assert_eq!(rows.len(), 2, "one hand-off per save, nothing else is addressed to anyone: {rows:?}");
        for (m, id, by) in [(&rows[0], ui, "human"), (&rows[1], cli, "lead")] {
            assert_eq!(m["to"], serde_json::json!(["builder-2"]), "exactly the assignee");
            assert_eq!(m["from"], by, "from whoever asked");
            assert_eq!(
                m["body"],
                format!(
                    "@builder-2 [board #{id}] {by} assigned this to you: Fix the login flow — Reproduce on a cold start.\n\
                     Please `tmm board take {id}` to start, note findings on it, move to review when done."
                )
            );
        }
        assert_eq!(records(&session), [
            format!("[tmm] assigned builder-2 — board #{ui} Fix the login flow"),
            format!("[tmm] assigned builder-2 — board #{cli} Fix the login flow"),
        ]);
    }

    /// Board #377 review P1-B. Dispatch is OPT-IN per request: an older page
    /// or `tmm` posts its own brief after a plain save, and a server that
    /// dispatched that save too would tell the agent twice. Without the flag
    /// the save is what it was before #377 — the record, no hand-off.
    #[test]
    fn a_save_without_the_dispatch_flag_hands_nothing_over() {
        let session = project_with(&["builder-2"]);
        let id = issue_id(&save_issue(&session, serde_json::json!({ "title": "T" })));
        let answer = save_issue(&session, serde_json::json!({ "id": id, "assignee": "builder-2", "who": "lead" }));
        assert!(answer.get("dispatch").is_none(), "{answer}");
        assert_eq!(told(&session).len(), 0, "an old client brings its own brief: the server posts none");
        assert_eq!(records(&session).len(), 1, "the record is the server's either way");
        let answer = save_issue(&session, serde_json::json!({ "id": id, "assignee": "builder-2", "who": "lead", "dispatch": false }));
        assert!(answer.get("dispatch").is_none() && told(&session).is_empty());
    }

    /// Board #377 (and the #367 note): the issue is named as the save LEAVES
    /// it. A request that edits the title and assigns in one go used to
    /// announce the old title, because the line read the stored row.
    #[test]
    fn a_save_that_renames_and_assigns_announces_the_new_name() {
        let session = project_with(&["builder-2"]);
        let id = issue_id(&save_issue(&session, serde_json::json!({ "title": "Old name" })));
        save_issue(&session, serde_json::json!({ "id": id, "title": "New name", "assignee": "builder-2", "dispatch": true }));
        let bodies: Vec<String> = room(&session).iter().filter_map(|m| m["body"].as_str().map(str::to_string)).collect();
        assert!(bodies.contains(&format!("[tmm] assigned builder-2 — board #{id} New name")), "{bodies:?}");
        let brief = bodies.iter().find(|b| b.starts_with("@builder-2 ")).expect("the hand-off");
        assert!(brief.contains("New name") && !brief.contains("Old name"), "{brief}");
        assert!(!bodies.iter().any(|b| b.contains("Old name")), "nothing in the room still says the old title: {bodies:?}");
    }

    /// Board #377. An issue filed WITH an assignee is handed over at birth —
    /// the page's create dialog always did it (#11), `tmm board add
    /// --assignee` only wrote a label.
    #[test]
    fn an_issue_filed_with_an_assignee_is_handed_over_at_birth() {
        let session = project_with(&["builder-2"]);
        let id = issue_id(&save_issue(&session, serde_json::json!({ "title": "Ship it", "body": "Today", "assignee": "builder-2", "who": "lead", "dispatch": true })));
        assert_eq!(records(&session), [format!("[tmm] assigned builder-2 — board #{id} Ship it")]);
        let rows = told(&session);
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["body"].as_str().unwrap().starts_with(&format!("@builder-2 [board #{id}] lead assigned this to you: Ship it — Today.")));
    }

    /// Board #377. Who is NOT told, who is, and the one case that is told
    /// again.
    #[test]
    fn only_a_managed_agent_other_than_the_actor_is_told_and_naming_it_again_tells_it_again() {
        let session = project_with(&["builder-2"]);
        let id = issue_id(&save_issue(&session, serde_json::json!({ "title": "T" })));
        let save = |params: serde_json::Value| {
            let mut p = params;
            p["id"] = serde_json::json!(id);
            p["who"] = serde_json::json!("lead");
            p["dispatch"] = serde_json::json!(true);
            save_issue(&session, p)
        };

        // `tmm board take`: a claim, the actor is the assignee.
        assert!(save(serde_json::json!({ "assignee": "lead", "status": "doing" })).get("dispatch").is_none());
        // The human assignee reads the board itself; a clear has nobody to tell.
        assert!(save(serde_json::json!({ "assignee": "human" })).get("dispatch").is_none());
        assert!(save(serde_json::json!({ "assignee": "" })).get("dispatch").is_none());
        // A save that does not touch the assignee never hands anything over.
        assert!(save(serde_json::json!({ "status": "review" })).get("dispatch").is_none());
        assert_eq!((told(&session).len(), records(&session).len()), (0, 3), "recorded, nobody woken");

        // A name this project never declared is saved and reported, but NOTHING
        // is posted: there is no agent to type it to.
        let ghost = save(serde_json::json!({ "assignee": "ghost" }));
        assert_eq!(ghost["dispatch"], "offline");
        assert!(ghost["dispatch_error"].as_str().unwrap().contains("not a managed agent of this project"), "{ghost}");
        assert_eq!(told(&session).len(), 0);

        // A declared agent is told; naming the SAME one again tells it again
        // (the record is a change record and says nothing the second time).
        // That is how a person re-sends a hand-off to an agent that was
        // offline the first time.
        save(serde_json::json!({ "assignee": "builder-2" }));
        assert_eq!((told(&session).len(), records(&session).len()), (1, 5));
        save(serde_json::json!({ "assignee": "builder-2" }));
        assert_eq!((told(&session).len(), records(&session).len()), (2, 5), "told again, no second record");
    }

    /// Board #377 review P1-C. An assignee that is not one name is refused AT
    /// THE DOOR: nothing saved, nothing posted — through the create path and
    /// the patch path, with the flag and without.
    #[test]
    fn an_assignee_that_is_not_one_name_is_refused_with_nothing_saved_or_posted() {
        let session = project_with(&["dev"]);
        let id = issue_id(&save_issue(&session, serde_json::json!({ "title": "T" })));
        for bad in ["dev @all", "all", "All", "@x", "dev ops", "a/b"] {
            for dispatch in [true, false] {
                let create = handle_hub_request(&req("hub_board_save", serde_json::json!({ "session": session, "title": "Nope", "assignee": bad, "dispatch": dispatch })), None);
                assert!(create.error.is_some(), "create with {bad:?} must be refused");
                let patch = handle_hub_request(&req("hub_board_save", serde_json::json!({ "session": session, "id": id, "assignee": bad, "dispatch": dispatch })), None);
                assert_eq!(patch.error.as_ref().map(|e| e.code), Some(-32602), "{bad:?}: {:?}", patch.error.map(|e| e.message));
            }
        }
        assert_eq!(issue_count(&session), 1, "no refused create left an issue behind");
        assert_eq!(crate::projects::board_get(&session, id).unwrap()["assignee"], "", "no refused patch changed the assignee");
        assert_eq!((room(&session).len(), told(&session).len()), (0, 0), "and nothing was posted");
    }

    /// Board #377 review P1-A. The save is COMMITTED before the telling is
    /// attempted, so a failed post is an outcome in the answer, never an error:
    /// a page that kept its create form open on an error would file the issue
    /// twice. Driven through the real handler with a post that fails.
    #[test]
    fn a_failed_post_after_the_save_is_an_answer_not_an_error() {
        let session = project_with(&["builder-2"]);
        let room_name = project_room(&session);
        let broken = HandOff { post: &|_, _| Err("the room is full".into()), managed: &|_| true, read: &stored };

        // The create path: one issue exists afterwards, assigned, and the answer
        // says the telling failed.
        let params = serde_json::json!({ "session": session, "title": "Ship it", "assignee": "builder-2", "who": "lead", "dispatch": true });
        let answer = super::board_save(&session, &room_name, &params, &broken).expect("a failed post is not an RPC error");
        assert_eq!(answer["dispatch"], "failed");
        assert_eq!(answer["dispatch_error"], "the room is full");
        let id = issue_id(&answer);
        assert_eq!(issue_count(&session), 1);
        assert_eq!(crate::projects::board_get(&session, id).unwrap()["assignee"], "builder-2", "the assignment is on the board");

        // The recovery: saving the same assignee again tells it, and does not
        // file a second issue.
        let seen = std::cell::Cell::new(0);
        let working = HandOff { post: &|_, brief| { seen.set(seen.get() + 1); assert!(brief.starts_with("@builder-2 ")); Ok(serde_json::json!({})) }, managed: &|_| true, read: &stored };
        let again = serde_json::json!({ "session": session, "id": id, "assignee": "builder-2", "who": "lead", "dispatch": true });
        let answer = super::board_save(&session, &room_name, &again, &working).unwrap();
        assert_eq!((answer["dispatch"].as_str(), seen.get()), (Some("sent"), 1));
        assert_eq!(issue_count(&session), 1);

        // An agent the project does not declare is never posted to.
        let ghost = serde_json::json!({ "session": session, "id": id, "assignee": "ghost", "who": "lead", "dispatch": true });
        let nobody = HandOff { post: &|_, _| panic!("no post for an undeclared agent"), managed: &|_| false, read: &stored };
        assert_eq!(super::board_save(&session, &room_name, &ghost, &nobody).unwrap()["dispatch"], "offline");
    }

    /// Board #377 review, P1-A residual. The read-back after the commit can
    /// fail too, and it used to leave through `?` as an RPC error — the id
    /// never reached the client, the create form stayed open, and the retry
    /// filed the issue twice. Every step after the write is the "saved"
    /// branch. A save that did NOT happen stays an error, so the two are told
    /// apart.
    #[test]
    fn a_read_back_that_fails_after_the_commit_still_answers_saved() {
        let session = project_with(&["builder-2"]);
        let room_name = project_room(&session);
        let unreadable = HandOff { post: &|_, _| panic!("nothing to post without the issue"), managed: &|_| true, read: &|_, _| Err("database is locked".into()) };

        // Asked to hand it over: saved once, the id comes back, and the answer says why nobody was told.
        let params = serde_json::json!({ "session": session, "title": "Ship it", "assignee": "builder-2", "who": "lead", "dispatch": true });
        let answer = super::board_save(&session, &room_name, &params, &unreadable).expect("a committed save is never an RPC error");
        assert_eq!((answer["ok"].as_bool(), answer["dispatch"].as_str()), (Some(true), Some("failed")));
        assert!(answer["dispatch_error"].as_str().unwrap().contains("could not be read back") && answer["dispatch_error"].as_str().unwrap().contains("database is locked"), "{answer}");
        let id = issue_id(&answer);
        assert_eq!(issue_count(&session), 1, "exactly one issue exists, so a retry has nothing to create");
        assert_eq!(crate::projects::board_get(&session, id).unwrap()["assignee"], "builder-2");

        // Not asked to hand it over: still an ordinary saved answer.
        let plain = serde_json::json!({ "session": session, "id": id, "status": "doing", "who": "lead" });
        let answer = super::board_save(&session, &room_name, &plain, &unreadable).expect("saved");
        assert_eq!(answer, serde_json::json!({ "ok": true, "id": id }));

        // A save that did NOT happen is an error, with nothing created.
        let gone = serde_json::json!({ "session": session, "id": 9999, "title": "No such issue", "who": "lead" });
        let err = super::board_save(&session, &room_name, &gone, &unreadable).expect_err("the write failed");
        assert!(matches!(err, RpcError::InvalidParams(_)), "a failed write is the client's to retry");
        assert_eq!(issue_count(&session), 1);
    }

    #[test]
    fn board_change_notice_decides_who_hears() {
        let prev = serde_json::json!({
            "title": "T", "body": "B", "status": "doing", "assignee": "builder", "created_by": "human",
        });
        // A human status change reaches the assignee, named.
        assert_eq!(
            super::board_change_notice(&prev, "human", None, None, Some("todo"), false).as_deref(),
            Some("status doing → todo")
        );
        // Edits CARRY the new values (owner, 2026-08-30: the message is the
        // context — no lookup round-trip for a short change).
        assert_eq!(
            super::board_change_notice(&prev, "human", Some("T2"), Some("B2"), Some("review"), false).as_deref(),
            Some("status doing → review; title → \"T2\"; body now: B2")
        );
        // A long body is excerpted, and the `…` is the only pointer needed.
        let long = "x".repeat(500);
        let noticed = super::board_change_notice(&prev, "human", None, Some(&long), None, false).unwrap();
        assert!(noticed.starts_with("body now: xxx"));
        assert!(noticed.ends_with('…'));
        assert!(noticed.chars().count() < 420);
        // The actor's own edit is not news.
        assert_eq!(super::board_change_notice(&prev, "builder", None, None, Some("done"), false), None);
        // A save echoing the stored values is a no-op, not an event.
        assert_eq!(super::board_change_notice(&prev, "human", Some("T"), Some("B"), Some("doing"), false), None);
        // A (re)assignment has its own dispatch channel — no second line.
        assert_eq!(super::board_change_notice(&prev, "human", None, None, Some("todo"), true), None);
        // Nobody assigned / the human assignee: nobody to wake.
        let unassigned = serde_json::json!({ "title": "T", "body": "B", "status": "todo", "assignee": "" });
        assert_eq!(super::board_change_notice(&unassigned, "human", None, None, Some("doing"), false), None);
        let human_owned = serde_json::json!({ "title": "T", "body": "B", "status": "todo", "assignee": "human" });
        assert_eq!(super::board_change_notice(&human_owned, "lead", None, None, Some("doing"), false), None);
    }

    #[test]
    fn a_move_to_done_never_wakes_the_assignee() {
        let prev = serde_json::json!({
            "title": "T", "body": "B", "status": "review", "assignee": "builder",
        });
        // Acceptance is the END of the work — there is nothing for the
        // executor to act on, so the whole save stays quiet (board #30).
        assert_eq!(super::board_change_notice(&prev, "human", None, None, Some("done"), false), None);
        let todo = serde_json::json!({ "title": "T", "body": "B", "status": "todo", "assignee": "builder" });
        assert_eq!(super::board_change_notice(&todo, "human", None, None, Some("done"), false), None);
        // Even a MIXED save (title/body riding along with the acceptance) is
        // suppressed wholesale — the fields arrived as part of closing it.
        assert_eq!(
            super::board_change_notice(&prev, "human", Some("T2"), Some("B2"), Some("done"), false),
            None
        );
        // But an ALREADY-done issue edited later is ordinary news again: the
        // suppression is about the closing act, not the done state.
        let done = serde_json::json!({ "title": "T", "body": "B", "status": "done", "assignee": "builder" });
        assert_eq!(
            super::board_change_notice(&done, "human", Some("T2"), None, None, false).as_deref(),
            Some("title → \"T2\"")
        );
        // ... including when the save echoes status "done" back unchanged.
        assert_eq!(
            super::board_change_notice(&done, "human", None, Some("B2"), Some("done"), false).as_deref(),
            Some("body now: B2")
        );
        // And REOPENING (done → doing) is exactly the wake the rule preserves.
        assert_eq!(
            super::board_change_notice(&done, "human", None, None, Some("doing"), false).as_deref(),
            Some("status done → doing")
        );
    }

    #[test]
    fn board_note_notice_reaches_both_parties_but_never_the_author_or_human() {
        let issue = serde_json::json!({
            "id": 26, "title": "Reply delivery", "assignee": "builder", "created_by": "human",
        });
        let (targets, notice) = super::board_note_notice(
            &issue,
            "human",
            "please revise the retry path",
        )
        .expect("a human reply wakes the assigned agent");
        assert_eq!(targets, vec!["builder".to_string()]);
        assert_eq!(
            notice,
            "[board #26 reply] Reply delivery — please revise the retry path. Reply on the issue with `tmm board note 26 \"...\"`."
        );

        let long = "x".repeat(500);
        let (_, shortened) = super::board_note_notice(&issue, "lead", &long).unwrap();
        assert!(shortened.contains('…'), "a long note names that more is on the issue");
        assert!(shortened.chars().count() < 500, "the interrupt stays concise");

        // The human reporter reads the board itself: the assignee's own
        // note on a human-filed issue wakes nobody.
        assert_eq!(super::board_note_notice(&issue, "builder", "my own note"), None);
        let unassigned = serde_json::json!({ "id": 1, "title": "T", "assignee": "" });
        assert_eq!(super::board_note_notice(&unassigned, "human", "hello"), None);
        let human = serde_json::json!({ "id": 1, "title": "T", "assignee": "human" });
        assert_eq!(super::board_note_notice(&human, "lead", "hello"), None);

        // #255 regression (temp/stall-analysis.md #248/#241): a THIRD
        // party's note — validator's SHIP on an issue orchestrator opened
        // and builder holds — reaches both declared parties, not the author.
        let shared = serde_json::json!({
            "id": 248, "title": "Addresses", "assignee": "builder", "created_by": "orchestrator",
        });
        let (both, _) = super::board_note_notice(&shared, "validator", "SHIP @5138fec8").unwrap();
        assert_eq!(both, vec!["builder".to_string(), "orchestrator".to_string()]);
        // The assignee's own note reaches the reporter (what board.md always
        // said and the code never did) ...
        let (up, _) = super::board_note_notice(&shared, "builder", "ready").unwrap();
        assert_eq!(up, vec!["orchestrator".to_string()]);
        // ... and the reporter's note reaches the assignee.
        let (down, _) = super::board_note_notice(&shared, "orchestrator", "merged").unwrap();
        assert_eq!(down, vec!["builder".to_string()]);
        // An unassigned issue still reaches its agent reporter.
        let filed = serde_json::json!({ "id": 7, "title": "T", "assignee": "", "created_by": "orchestrator" });
        let (r, _) = super::board_note_notice(&filed, "validator", "repro attached").unwrap();
        assert_eq!(r, vec!["orchestrator".to_string()]);
        // A self-filed, self-held issue has nobody else on it; the same
        // name twice (reporter == assignee) is one delivery to a third party.
        let own = serde_json::json!({ "id": 251, "title": "T", "assignee": "builder", "created_by": "builder" });
        assert_eq!(super::board_note_notice(&own, "builder", "done"), None);
        let (once, _) = super::board_note_notice(&own, "validator", "SHIP").unwrap();
        assert_eq!(once, vec!["builder".to_string()]);

        // A TITLELESS issue (board #31) is named by its body through the
        // shared issue_ref fallback — never an empty head + dangling dash.
        let titleless = serde_json::json!({
            "id": 31, "title": "", "body": "issue标题可以为空，截前几个字显示", "assignee": "builder",
        });
        let (_, n) = super::board_note_notice(&titleless, "human", "ok").unwrap();
        assert_eq!(
            n,
            "[board #31 reply] issue标题可以为空，截前几个字显示 — ok. Reply on the issue with `tmm board note 31 \"...\"`."
        );
    }

    #[test]
    fn board_counts_answers_without_a_session_like_hub_rooms() {
        crate::projects::tests::use_test_store();
        let session = format!("counts-rpc-{}", uuid::Uuid::new_v4());
        crate::projects::board_save(&session, None, Some("count me"), None, None, None, "human").unwrap();
        // NO `session` in params, by design: the method is about EVERY board,
        // so it must answer BEFORE the session gate — a "session required"
        // error here means it slid below the gate (the hub_rooms precedent).
        let r = handle_hub_request(&req("hub_board_counts", serde_json::json!({})), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        let v = r.result.expect("result");
        let counts = v["counts"].as_object().expect("counts object");
        let row = counts.get(&session).expect("the seeded board is present");
        assert_eq!(row["todo"], 1);
        assert_eq!(row["doing"], 0, "zero-filled vocabulary over the wire");
        assert_eq!(row["total"], 1, "emptiness is one explicit field");
    }

    /// Board #322: the unread summary answers before the session gate, per
    /// asked room, with archived messages excluded and quiet rooms absent.
    #[test]
    fn hub_unread_summarises_each_asked_room() {
        crate::projects::tests::use_test_store();
        let room = format!("proj:unread-rpc-{}", uuid::Uuid::new_v4());
        let quiet = format!("proj:quiet-{}", uuid::Uuid::new_v4());
        let base = rooms::seed_msg(&room, "u0", 100, "lead", &[], "seen");
        let a = rooms::seed_msg(&room, "u1", 200, "lead", &[], "first");
        let b = rooms::seed_msg(&room, "u2", 300, "dev", &[], "second");
        rooms::seed_msg(&quiet, "q0", 100, "human", &[], "only me");
        crate::projects::archive_msg(&room, "u2", 300, "dev", "second").unwrap();
        let ask = serde_json::json!({ "rooms": { &room: { "seq": base["seq"] }, &quiet: { "ts": 0 } } });
        let r = handle_hub_request(&req("hub_unread", ask), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        let v = r.result.unwrap();
        assert_eq!(v["rooms"][&room], serde_json::json!({ "count": 1, "first_seq": a["seq"], "last_seq": a["seq"] }), "the archived one is not unread");
        assert!(v["rooms"].get(&quiet).is_none(), "own words are never unread");
        let _ = b;
    }

    /// Board #334: ONE read mark per room on the server. `hub_read` only moves
    /// forward and never past the room's newest message; `hub_unread` reads
    /// from the later of the server's mark and the client's, so a fresh
    /// client (no mark of its own) sees what the human has not read, and a
    /// stale cache cannot resurrect what another client read.
    #[test]
    fn hub_read_is_one_monotonic_mark_and_the_default_watermark() {
        crate::projects::tests::use_test_store();
        let room = format!("proj:read-rpc-{}", uuid::Uuid::new_v4());
        let m: Vec<_> = (0..4).map(|i| rooms::seed_msg(&room, &format!("r{i}-{room}"), 100 * (i + 1), "lead", &["human".into()], &format!("m{i}"))).collect();
        let seq = |i: usize| m[i]["seq"].as_i64().unwrap();
        let read = |mark: serde_json::Value| handle_hub_request(&req("hub_read", serde_json::json!({ "rooms": { &room: mark } })), None).result.unwrap()["rooms"][&room].clone();
        let unread = |mark: serde_json::Value| handle_hub_request(&req("hub_unread", serde_json::json!({ "rooms": { &room: mark } })), None).result.unwrap();

        // A fresh client, nothing read anywhere: the whole room.
        let v = unread(serde_json::json!({}));
        assert_eq!(v["rooms"][&room]["count"], 4);
        assert!(v["marks"].get(&room).is_none(), "no server mark yet");

        // One client reads to m1; a fresh client now inherits it.
        assert_eq!(read(serde_json::json!({ "seq": seq(1), "ts": 200 })), serde_json::json!({ "seq": seq(1), "ts": 200 }));
        let v = unread(serde_json::json!({}));
        assert_eq!(v["rooms"][&room]["count"], 2, "the server's mark is the default watermark");
        assert_eq!(v["marks"][&room], serde_json::json!({ "seq": seq(1), "ts": 200 }));
        // A stale cached mark below the server's does not resurrect m1.
        assert_eq!(unread(serde_json::json!({ "seq": seq(0) }))["rooms"][&room]["count"], 2);
        // A cached mark ABOVE the server's (not yet pushed) wins for the count.
        assert_eq!(unread(serde_json::json!({ "seq": seq(2) }))["rooms"][&room]["count"], 1);

        // Never backwards.
        assert_eq!(read(serde_json::json!({ "seq": seq(0), "ts": 100 })), serde_json::json!({ "seq": seq(1), "ts": 200 }));
        // Never past what exists: a mark from a wiped database is clamped.
        assert_eq!(read(serde_json::json!({ "seq": seq(3) + 1_000_000, "ts": 9_999 })), serde_json::json!({ "seq": seq(3), "ts": 400 }));
        assert!(unread(serde_json::json!({}))["rooms"].get(&room).is_none(), "all read");
        let later = rooms::seed_msg(&room, &format!("r9-{room}"), 500, "lead", &[], "after the clamp");
        assert_eq!(unread(serde_json::json!({}))["rooms"][&room]["first_seq"], later["seq"], "the clamp did not hide the next message");
    }

    /// Board #334: the server resolves every mark. A legacy ts becomes the
    /// newest message at or before it (and stores THAT message's ts, not the
    /// client's clock); an empty mark and an empty room write nothing; a
    /// future seq or ts carried by a stale cache in `hub_unread` is dropped
    /// at the door (the server mark reads) and hides nothing, however often re-sent.
    #[test]
    fn the_server_resolves_every_mark_and_drops_impossible_ones() {
        crate::projects::tests::use_test_store();
        let room = format!("proj:push-{}", uuid::Uuid::new_v4());
        let empty = format!("proj:empty-{}", uuid::Uuid::new_v4());
        let a = rooms::seed_msg(&room, &format!("p0-{room}"), 1_000, "lead", &[], "a");
        let b = rooms::seed_msg(&room, &format!("p1-{room}"), 2_000, "lead", &[], "b");
        let ask = serde_json::json!({ "rooms": { &room: { "ts": 1_500 }, &empty: { "seq": 7 } } });
        let v = handle_hub_request(&req("hub_read", ask), None).result.unwrap();
        assert_eq!(v["rooms"][&room], serde_json::json!({ "seq": a["seq"], "ts": 1_000 }));
        assert!(v["rooms"].get(&empty).is_none(), "nothing to have read");
        assert!(rooms::read_mark(&empty).is_none());
        let v = handle_hub_request(&req("hub_read", serde_json::json!({ "rooms": { &room: {} } })), None).result.unwrap();
        assert!(v["rooms"].get(&room).is_none(), "an empty mark is not a read");
        assert_eq!(rooms::read_mark(&room), Some((a["seq"].as_i64().unwrap(), 1_000)));

        // A stale cache from a wiped database carries a future seq / ts.
        let unread = |mark: serde_json::Value| handle_hub_request(&req("hub_unread", serde_json::json!({ "rooms": { &room: mark } })), None).result.unwrap();
        assert_eq!(unread(serde_json::json!({ "seq": 9_000_000 }))["rooms"][&room]["first_seq"], b["seq"], "an impossible mark is dropped: the server's mark reads");
        rooms::seed_msg(&room, &format!("p2-{room}"), 3_000, "lead", &[], "c");
        assert_eq!(unread(serde_json::json!({ "seq": 9_000_000 }))["rooms"][&room]["count"], 2, "re-sent, the future seq still hides nothing (b and c)");
        // A legacy future ts in a room the server has no mark for yet.
        let fresh = format!("proj:fresh-{}", uuid::Uuid::new_v4());
        rooms::seed_msg(&fresh, &format!("f0-{fresh}"), 1_000, "lead", &[], "f0");
        let ask = |mark: serde_json::Value| handle_hub_request(&req("hub_unread", serde_json::json!({ "rooms": { &fresh: mark } })), None).result.unwrap();
        assert_eq!(ask(serde_json::json!({ "ts": 9_000_000 }))["rooms"][&fresh]["count"], 1, "a future ts is dropped too");
        assert_eq!(ask(serde_json::json!({ "ts": 1_000 }))["rooms"].get(&fresh), None, "a real ts mark still reads");
        // A server mark AND a newer legal legacy ts: the ts is resolved to
        // its seq and wins; an older ts loses to the server mark.
        let legacy = format!("proj:legacy-{}", uuid::Uuid::new_v4());
        let l0 = rooms::seed_msg(&legacy, &format!("l0-{legacy}"), 100, "lead", &[], "l0");
        rooms::seed_msg(&legacy, &format!("l1-{legacy}"), 200, "lead", &[], "l1");
        let l2 = rooms::seed_msg(&legacy, &format!("l2-{legacy}"), 300, "lead", &[], "l2");
        rooms::mark_read(&legacy, l0["seq"].as_i64(), 0).unwrap();
        let lask = |mark: serde_json::Value| handle_hub_request(&req("hub_unread", serde_json::json!({ "rooms": { &legacy: mark } })), None).result.unwrap();
        assert_eq!(lask(serde_json::json!({ "ts": 250 }))["rooms"][&legacy], serde_json::json!({ "count": 1, "first_seq": l2["seq"], "last_seq": l2["seq"] }), "the newer ts reads as l1's seq");
        assert_eq!(lask(serde_json::json!({ "ts": 50 }))["rooms"][&legacy]["count"], 2, "an older ts loses to the server mark");
        // The answer's mark is the PERSISTED one, never the effective max.
        assert_eq!(unread(serde_json::json!({ "seq": 9_000_000 }))["marks"][&room], serde_json::json!({ "seq": a["seq"], "ts": 1_000 }));
    }

    /// Board #322: `around_seq` pages THIS room around a message, even when
    /// other rooms' messages interleave its seqs.
    #[test]
    fn hub_log_around_seq_pages_the_room_around_its_message() {
        crate::projects::tests::use_test_store();
        let session = format!("around-{}", uuid::Uuid::new_v4());
        let room = format!("proj:{session}");
        let noise = format!("proj:noise-{}", uuid::Uuid::new_v4());
        let mut mine = Vec::new();
        for i in 0..20 {
            mine.push(rooms::seed_msg(&room, &format!("a{i}-{session}"), 100 + i, "lead", &[], &format!("m{i}")));
            rooms::seed_msg(&noise, &format!("n{i}-{session}"), 100 + i, "x", &[], "other room");
        }
        let target = mine[10]["seq"].as_i64().unwrap();
        let r = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session, "around_seq": target, "limit": 6 })), None);
        let v = r.result.expect("page");
        let bodies: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap()).collect();
        assert_eq!(bodies, ["m7", "m8", "m9", "m10", "m11", "m12"], "three before, the target and two after");
        assert_eq!(v["has_more"], true);
        assert_eq!(v["newer_more"], true);
        assert_eq!(v["oldest_seq"], mine[7]["seq"], "the older walk continues from here");
        let last = mine[19]["seq"].as_i64().unwrap();
        let v = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session, "around_seq": last, "limit": 6 })), None).result.unwrap();
        assert_eq!(v["newer_more"], false, "the newest message's window is the tail");
        assert_eq!(v["messages"].as_array().unwrap().last().unwrap()["body"], "m19");
    }

    /// A page can lose EVERY row to the archive filter, and the walk still has to
    /// continue: `has_more` says there is history behind it, so if no cursor comes
    /// back with it the client has nothing to ask for and scroll-up stops dead at
    /// the hidden run. The cursor falls back to the RAW page's oldest seq — the
    /// position always advances, even when nothing survived to be shown.
    #[test]
    fn a_fully_hidden_page_still_hands_back_a_cursor_to_the_older_visible_ones() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("hid");
        // Five messages; the middle stretch (3rd and 4th) is archived, so one
        // whole page of two is invisible. seq is store-global, so every
        // position below is read off the seeded rows, never assumed.
        let seeded: Vec<serde_json::Value> = (1..=5)
            .map(|n| rooms::seed_msg(&room, &format!("{room}-m{n}"), n * 10, "human", &[], &format!("body{n}")))
            .collect();
        let seq = |n: usize| seeded[n - 1]["seq"].as_i64().unwrap();
        for n in [3, 4] {
            crate::projects::archive_msg(&room, seeded[n - 1]["id"].as_str().unwrap(), (n as u64) * 10, "human", "x").unwrap();
        }
        let page = |before: Option<i64>| {
            let mut params = serde_json::json!({ "session": session, "limit": 2 });
            if let Some(b) = before {
                params["before_seq"] = serde_json::json!(b);
            }
            handle_hub_request(&req("hub_log", params), None).result.expect("result")
        };

        // Page 1: raw [m4, m5], m4 hidden → the visible tail, cursor from the
        // SURVIVOR (what the user can actually see).
        let p1 = page(None);
        let bodies = |v: &serde_json::Value| {
            v["messages"].as_array().unwrap().iter()
                .map(|m| m["body"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(bodies(&p1), vec!["body5"]);
        assert_eq!(p1["oldest_seq"], seq(5));
        assert_eq!(p1["has_more"], true);

        // Page 2: raw [m3, m4] — BOTH hidden. Nothing to render, but the page must
        // still carry the raw cursor or the walk cannot go on.
        let p2 = page(p1["oldest_seq"].as_i64());
        assert!(bodies(&p2).is_empty(), "the whole page is hidden");
        assert_eq!(p2["has_more"], true, "and there is more behind it");
        assert_eq!(p2["oldest_seq"], seq(3), "the raw oldest seq is the cursor of last resort");

        // Page 3: continuing from that cursor reaches the older VISIBLE messages,
        // which is the behaviour the fallback exists for.
        let p3 = page(p2["oldest_seq"].as_i64());
        assert_eq!(bodies(&p3), vec!["body1", "body2"]);
        assert_eq!(p3["has_more"], false, "that is the start of the conversation");
        assert_eq!(p3["oldest_seq"], seq(1));

        // Every visible message was reached exactly once across the walk.
        let seen: Vec<String> = [bodies(&p3), bodies(&p2), bodies(&p1)].concat();
        assert_eq!(seen, vec!["body1", "body2", "body5"]);
    }

    /// Board #9: the room keeps everything, so the client needs a way to ask for
    /// a SMALL first page and then walk back. Two contracts are pinned here — a
    /// client with no cursor gets exactly the newest page, and `before_seq`
    /// walks backwards with a cursor handed back for the step after it.
    #[test]
    fn hub_log_answers_the_newest_page_and_pages_backwards_on_request() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("page");
        let older = rooms::seed_msg(&room, &format!("{room}-1"), 50, "a", &[], "older");
        let old = rooms::seed_msg(&room, &format!("{room}-2"), 100, "a", &[], "old");
        let new = rooms::seed_msg(&room, &format!("{room}-3"), 200, "b", &[], "new");

        // A client with no cursor: the newest page under its limit.
        let r = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session, "limit": 2 })), None);
        let v = r.result.expect("result");
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "the newest page");
        assert_eq!(msgs[0]["body"], "old", "oldest first");
        assert_eq!(v["has_more"], true, "and it says history remains behind it");
        assert_eq!(v["oldest_seq"], old["seq"], "the cursor for the next page back");
        assert_eq!(v["head_seq"], new["seq"]);

        // Scrolled up: the client asks for what is behind its oldest message.
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "before_seq": old["seq"], "limit": 50 })),
            None,
        );
        let v = r.result.expect("result");
        assert_eq!(v["messages"].as_array().unwrap().len(), 1);
        assert_eq!(v["messages"][0]["body"], "older");
        assert_eq!(v["messages"][0]["id"], older["id"]);
        assert_eq!(v["has_more"], false, "the conversation begins there");

        // A nonsense cursor is no cursor: 0/negative means "the newest page",
        // never a query that could return nothing for ever.
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "before_seq": 0, "limit": 2 })),
            None,
        );
        assert_eq!(r.result.expect("result")["messages"].as_array().unwrap().len(), 2);
    }

    /// `hub_search` finds instead of paging (owner, 2026-09-07): a term list,
    /// any-match, over the room's history — and the archive mirror applies to
    /// search exactly as it does to `hub_log`, or a hidden message would come
    /// back the moment someone greps for it.
    #[test]
    fn hub_search_matches_terms_validates_them_and_hides_the_archived() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("srch");
        rooms::seed_msg(&room, &format!("{room}-1"), 100, "a", &[], "old");
        let newer = rooms::seed_msg(&room, &format!("{room}-2"), 200, "b", &[], "new");
        // No terms (or all-blank terms) is a caller error, not "match everything".
        for bad in [serde_json::json!({ "session": session }),
                    serde_json::json!({ "session": session, "grep": ["  "] })] {
            let r = handle_hub_request(&req("hub_search", bad), None);
            assert!(r.error.is_some(), "empty grep must be rejected");
        }
        // Any-match over the room's history ("old" by a, "new" by b): one term
        // hits one message; two terms hit both; a sender name is searchable too.
        let search = |grep: serde_json::Value| {
            let r = handle_hub_request(
                &req("hub_search", serde_json::json!({ "session": session, "grep": grep })),
                None,
            );
            r.result.expect("result")["messages"].as_array().unwrap().clone()
        };
        assert_eq!(search(serde_json::json!(["OLD"])).len(), 1, "case-insensitive body match");
        assert_eq!(search(serde_json::json!(["old", "new"])).len(), 2, "a term list is any-match");
        assert_eq!(search(serde_json::json!(["b"])).len(), 1, "the sender matches too");
        // Archiving hides from search as it does from the log.
        crate::projects::archive_msg(&room, newer["id"].as_str().unwrap(), 200, "b", "new").unwrap();
        let msgs = search(serde_json::json!(["old", "new"]));
        assert_eq!(msgs.len(), 1, "the archived hit is filtered: {msgs:?}");
        assert_eq!(msgs[0]["body"], "old");
    }

    /// `global: true` widens the scope to EVERY room; each hit carries its
    /// `room` field so a cross-project answer stays readable. (The store
    /// enumerates rooms itself now — the "pageless bridge degrades to empty"
    /// contract died with the TeamBridge trait, board #107.)
    #[test]
    fn hub_search_global_searches_every_room_and_names_it() {
        crate::projects::tests::use_test_store();
        let (session_a, room_a) = unique("gsrch-a");
        let (_, room_b) = unique("gsrch-b");
        let needle = format!("needle-{}", uuid::Uuid::new_v4());
        rooms::seed_msg(&room_a, &format!("{room_a}-1"), 100, "a", &[], &format!("{needle} in a"));
        rooms::seed_msg(&room_b, &format!("{room_b}-1"), 200, "b", &[], &format!("{needle} in b"));
        let r = handle_hub_request(
            &req("hub_search", serde_json::json!({ "session": session_a, "grep": [needle], "global": true })),
            None,
        );
        let msgs = r.result.expect("result")["messages"].as_array().unwrap().clone();
        assert_eq!(msgs.len(), 2, "both rooms are searched: {msgs:?}");
        let rooms_hit: Vec<&str> = msgs.iter().map(|m| m["room"].as_str().unwrap()).collect();
        assert!(rooms_hit.contains(&room_a.as_str()) && rooms_hit.contains(&room_b.as_str()));
    }

    /// The activity feed's half of the same contract. The durable log keeps every
    /// event, so this read is where the bound lives: a default page, a hard cap,
    /// and a (ts, id) cursor handed back for walking backwards.
    #[test]
    fn hub_activity_pages_and_caps_and_reports_what_it_holds() {
        crate::projects::tests::use_test_store();
        let session = format!("act-rpc-{}", uuid::Uuid::new_v4());
        for n in 0..6 {
            telemetry::record_tool(&session, "w1", "Edit", &format!("f{n}.rs"));
        }
        // An older client sends only since_ts and gets the newest page.
        let r = handle_hub_request(
            &req("hub_activity", serde_json::json!({ "session": session, "since_ts": 0 })),
            None,
        );
        let v = r.result.expect("result");
        let evs = v["events"].as_array().unwrap();
        assert_eq!(evs.len(), 6, "everything this session has, under the default cap");
        assert!(v.get("has_more").is_some(), "the client is told whether more exists");

        // A limit is honoured, and the page carries the cursor for the next one.
        let r = handle_hub_request(
            &req("hub_activity", serde_json::json!({ "session": session, "limit": 2 })),
            None,
        );
        let v = r.result.expect("result");
        assert_eq!(v["events"].as_array().unwrap().len(), 2);
        let oldest = v["oldest"].clone();
        assert!(oldest["ts"].as_u64().unwrap() > 0, "a usable cursor, got {oldest:?}");

        // And it is a CAP, not a suggestion.
        let r = handle_hub_request(
            &req("hub_activity", serde_json::json!({ "session": session, "limit": 99999 })),
            None,
        );
        assert!(
            r.result.expect("result")["events"].as_array().unwrap().len()
                <= telemetry::MAX_PAGE_EVENTS
        );
    }

    #[test]
    fn hub_post_lands_in_the_project_room_with_the_sender() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("post");
        let r = handle_hub_request(
            &req("hub_post", serde_json::json!({ "session": session, "from": "lead", "body": "@reviewer 看一下" })),
            None,
        );
        assert!(r.error.is_none(), "{}", r.error.map(|e| e.message).unwrap_or_default());
        let msg = r.result.clone().expect("the stored message comes back");
        assert_eq!(msg["room"], room);
        assert_eq!(msg["from"], "lead");
        assert_eq!(msg["to"], serde_json::json!(["reviewer"]), "the route is stored in the envelope");
        // And it is durably in the room, not just in the response.
        let page = rooms::history_page(&room, None, 10);
        let msgs = page["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["body"], "@reviewer 看一下");
        // Board #347: this session has no tmux at all, so NOTHING was typed
        // and the room says so — one line per unreached name, from the real
        // RPC path (which is what makes the emission tested without tmux).
        // `unknown` here because this scratch project declares no agent; a
        // real stopped session declares its slots and reads `stopped`.
        assert_eq!(msgs.len(), 2, "the chat line and one offline line: {msgs:?}");
        assert_eq!(
            msgs[1]["body"],
            "[tmm] offline reviewer — lead's message was not typed in (unknown); nothing is queued for it"
        );
        assert_eq!(
            r.result.as_ref().map(|v| v["offline"].clone()),
            Some(serde_json::json!([{ "name": "reviewer", "why": "unknown" }])),
            "and the answer carries it, which is how `tmm send` can say it"
        );
    }

    /// Board #347 review P1-A (02:30), on REAL panes: "offline" means no live
    /// managed agent matched the name — not "the line was not accepted". A
    /// pane in copy mode REFUSES the line (#250, which says so itself with an
    /// `undelivered` warn); that agent is found and alive, so it is neither
    /// `stopped` nor reported twice. A name the project declares but nothing
    /// runs is `stopped`; one it never declared is `unknown`.
    #[test]
    fn a_live_pane_that_refuses_is_not_offline_but_a_stopped_slot_is() {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let session = format!("tmm-offl-{tag}");
        let ws = std::env::temp_dir().join(format!("tmm-offl-ws-{tag}"));
        let recipe = serde_json::json!({ "backend": "kiro", "cmd": "kiro-cli chat --agent dev", "team": "" }).to_string();
        for name in ["dev", "ghost"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), &recipe).unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        crate::projects::adopt(&session, Some("offline-live-test")).expect("adopt project");
        let target = format!("{session}:dev");
        let post = |body: &str| {
            let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "lead", "body": body })), None);
            assert!(r.error.is_none(), "{}", r.error.map(|e| e.message).unwrap_or_default());
            r.result.expect("posted")
        };
        let offline_of = |msg: &serde_json::Value| msg.get("offline").cloned().unwrap_or(serde_json::json!([]));
        let room = project_room(&session);
        let lines = || -> Vec<String> {
            rooms::history_page(&room, None, 50)["messages"].as_array().unwrap().iter()
                .map(|m| m["body"].as_str().unwrap_or_default().to_string()).collect()
        };
        let warns = || -> Vec<String> {
            crate::projects::telemetry::recent_events(&session, 0).into_iter()
                .filter(|e| e.kind == "warn").map(|e| e.text).collect()
        };

        // The live pane REFUSES: copy mode swallows the line. Found, alive,
        // refused — and nobody is offline.
        assert!(crate::tmux::run_tmux(&["copy-mode", "-t", &target]).is_ok());
        let refused = post("@dev are you there");
        assert_eq!(offline_of(&refused), serde_json::json!([]), "a found agent is not offline: {refused}");
        assert!(
            warns().iter().any(|w| w.starts_with("undelivered (pane is in copy mode)")),
            "the refusal keeps ITS OWN warn: {:?}", warns()
        );
        assert!(
            !lines().iter().any(|l| l.starts_with("[tmm] offline")),
            "and the room says nothing more: {:?}", lines()
        );

        // Leave copy mode; a typed line is found and fine too.
        let _ = crate::tmux::run_tmux(&["send-keys", "-t", &target, "-X", "cancel"]);
        let typed = post("@dev again");
        assert_eq!(offline_of(&typed), serde_json::json!([]), "{typed}");

        // A declared slot with no window is `stopped`; an undeclared name is
        // `unknown`. One room line each, and the answer carries both.
        let gone = post("@ghost @nobody hello");
        assert_eq!(
            offline_of(&gone),
            serde_json::json!([{ "name": "ghost", "why": "stopped" }, { "name": "nobody", "why": "unknown" }]),
            "{gone}"
        );
        let offline_lines: Vec<String> = lines().into_iter().filter(|l| l.starts_with("[tmm] offline")).collect();
        assert_eq!(offline_lines.len(), 2, "one per name: {offline_lines:?}");
        assert!(offline_lines[0].starts_with("[tmm] offline ghost —") && offline_lines[0].contains("(stopped)"), "{offline_lines:?}");
        assert!(offline_lines[1].starts_with("[tmm] offline nobody —") && offline_lines[1].contains("(unknown)"), "{offline_lines:?}");

        // The SENDER hears it in its own pane (review P2, 02:45: the posts
        // above come from `lead`, who has no pane, so they prove the room
        // and the answer and nothing about the notification call). `dev`
        // is a live managed agent here, so when IT mentions a stopped slot
        // the server types ONE stamped result line into `dev`'s pane — the
        // `cat` window echoes what is typed, so the pane shows what arrived.
        let from_dev = handle_hub_request(
            &req("hub_post", serde_json::json!({ "session": session, "from": "dev", "body": "@ghost are you back" })),
            None,
        );
        assert!(from_dev.error.is_none());
        let wanted = "tmm: [reply] offline \u{2014} @ghost (stopped)";
        let mut pane = String::new();
        for _ in 0..30 {
            pane = crate::tmux::capture_pane_plain(&target, Some(0)).unwrap_or_default();
            if pane.contains(wanted) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(pane.contains(wanted), "the sender's own pane got the notice: {pane:?}");
        assert!(pane.contains("[tmm chat "), "in the stamped result shape: {pane:?}");
    }

    /// Board #347 review P1-A (02:30): when tmux cannot LIST the panes, "the
    /// session is gone" and "tmux could not be asked" are different facts.
    /// Both leave every mention unreached and both must say so; only the
    /// first may be called by a name a project knows, and the second must
    /// not claim anything stopped. The lister is injected, so no tmux is
    /// moved or broken to stage it.
    #[test]
    fn an_unreachable_tmux_is_unchecked_and_a_missing_session_is_not() {
        crate::projects::tests::use_test_store();
        let run = |error: &str| {
            let (session, room) = unique("unchecked");
            let offline = deliver_mentions_with(
                &session, "lead", "@dev @ghost hi", &room, None, "m1", false,
                |_| Err(error.to_string()),
            );
            let rows: Vec<String> = rooms::history_page(&room, None, 20)["messages"].as_array().unwrap().iter()
                .map(|m| m["body"].as_str().unwrap_or_default().to_string()).collect();
            (offline, rows)
        };

        // tmux says the session is not there (measured 3.6a): honest, and the
        // project declares nothing here, so the words are `unknown`.
        let (gone, rows) = run("tmux error: can't find session: nope\n");
        assert_eq!(gone, vec![("dev".to_string(), "unknown"), ("ghost".to_string(), "unknown")]);
        assert!(rows.iter().all(|r| r.contains("(unknown)")), "{rows:?}");

        // tmux could not be asked: NOTHING is asserted about any process.
        let (blind, rows) = run("tmux error: error connecting to /tmp/x/sock (Permission denied)\n");
        assert_eq!(blind, vec![("dev".to_string(), "unchecked"), ("ghost".to_string(), "unchecked")]);
        assert_eq!(rows.len(), 2, "still one row per name — silence is the bug: {rows:?}");
        assert!(rows.iter().all(|r| r.contains("(unchecked: tmux could not be asked)")), "{rows:?}");
        assert!(rows.iter().all(|r| !r.contains("stopped")), "never a confident stopped: {rows:?}");
    }

    #[test]
    fn hub_post_record_only_skips_delivery_but_stores_message() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("rec");
        let r = handle_hub_request(
            &req("hub_post", serde_json::json!({
                "session": session, "from": "lead",
                "body": "@reviewer 自动结果", "record_only": true
            })),
            None,
        );
        assert!(r.error.is_none(), "{}", r.error.map(|e| e.message).unwrap_or_default());
        // The message is stored in the room even though delivery was skipped.
        let msgs = rooms::history_page(&room, None, 10);
        let msgs = msgs["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1, "record-only posts are stored in the room");
        assert_eq!(msgs[0]["body"], "@reviewer 自动结果");
    }

    #[test]
    fn hub_post_status_is_an_ambient_agent_message() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("stat");
        let r = handle_hub_request(
            &req("hub_post", serde_json::json!({
                "session": session, "from": "lead",
                "body": "reviewing @reviewer output", "status": true
            })),
            None,
        );
        assert!(r.error.is_none(), "{}", r.error.map(|e| e.message).unwrap_or_default());
        let msgs = rooms::history_page(&room, None, 10);
        let msgs = msgs["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["from"], "lead");
        assert_eq!(msgs[0]["body"], "[tmm status working] reviewing @reviewer output");
    }

    #[test]
    fn team_context_reconstructs_routes_since_the_targets_previous_delivery() {
        let messages = vec![
            serde_json::json!({ "ts": 1000, "from": "lead", "to": ["writer"], "body": "draft it; source is a@b.example" }),
            serde_json::json!({ "ts": 2000, "from": "researcher", "body": "@lead check this fact" }),
            serde_json::json!({ "ts": 3000, "from": "lead", "body": "the source is primary" }),
            serde_json::json!({ "ts": 4000, "from": "writer", "body": "draft ready" }),
            serde_json::json!({ "ts": 5000, "from": "review-style", "body": "@review-reader compare notes" }),
            serde_json::json!({ "ts": 6000, "from": "review-reader", "body": "reader concern confirmed" }),
            serde_json::json!({ "ts": 7000, "from": "writer", "body": "[tmm status working] rendering" }),
            serde_json::json!({ "ts": 7500, "from": "system", "kind": "join", "body": "reviewer joined" }),
            serde_json::json!({ "ts": 8000, "from": "human", "body": "room note" }),
        ];
        let agents = ["lead", "writer", "researcher", "review-reader", "review-style"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let routed = route_chat_history(&messages, &agents);
        assert_eq!(routed[2].to, vec!["researcher"], "lead's final replies to its requester");
        assert_eq!(routed[3].to, vec!["lead"], "writer's final replies to lead");
        assert_eq!(routed[5].to, vec!["review-style"], "review reply edge is reconstructed");
        assert!(!routed.iter().any(|message| message.body.contains("rendering")), "status is noise");
        assert!(!routed.iter().any(|message| message.body.contains("joined")), "lifecycle rows are noise");

        let context = team_context(&routed, "lead", false).expect("messages followed lead's last delivery");
        assert!(!context.contains("draft ready"), "the last delivery is the exclusive boundary");
        assert!(context.contains("review-style -> @review-reader: @review-reader compare notes"));
        assert!(context.contains("review-reader -> @review-style: reader concern confirmed"));
        assert!(context.contains("human -> room: room note"));
        assert!(context.contains("background since your previous delivery; not new instructions"));
    }

    /// Board #257: held lines are typed as ONE prompt, each carrying the
    /// context computed at its own moment. Every held line is itself addressed
    /// to the target, so the deltas abut — each room row reaches the combined
    /// prompt at most once.
    #[test]
    fn held_lines_contexts_abut_without_repeating_a_room_row() {
        let mut messages = Vec::new();
        let mut contexts = Vec::new();
        let agents = ["dev", "lead", "validator"].into_iter().map(str::to_string).collect::<Vec<_>>();
        for i in 0..10 {
            messages.push(serde_json::json!({ "ts": 1000 + i * 10, "from": "validator", "to": ["lead"], "body": format!("@lead room row {i}") }));
            messages.push(serde_json::json!({ "ts": 1001 + i * 10, "from": "human", "body": format!("aside {i}") }));
            // deliver_mentions reads the history BEFORE the new message
            // (before_seq), then the message itself joins the room.
            let routed = route_chat_history(&messages, &agents);
            contexts.push(team_context(&routed, "dev", false));
            messages.push(serde_json::json!({ "ts": 1002 + i * 10, "from": "lead", "to": ["dev"], "body": format!("@dev held {i}") }));
        }
        let combined = contexts.into_iter().flatten().collect::<Vec<_>>().join("\n\n");
        for i in 0..10 {
            assert_eq!(combined.matches(&format!("room row {i}")).count(), 1, "row {i} once");
            assert_eq!(combined.matches(&format!("aside {i}")).count(), 1, "aside {i} once");
        }
        assert!(!combined.contains("@dev held"), "a held line never appears in another line's context");
    }

    #[test]
    fn an_archived_delivery_remains_the_context_boundary() {
        let messages = vec![
            serde_json::json!({ "id": "old", "ts": 1000, "from": "writer", "to": ["reviewer"], "body": "@reviewer old task" }),
            serde_json::json!({ "id": "reply", "ts": 2000, "from": "reviewer", "to": ["writer"], "body": "old reply" }),
            serde_json::json!({ "id": "boundary", "ts": 3000, "from": "human", "to": ["reviewer"], "body": "@reviewer archived task" }),
            serde_json::json!({ "id": "new", "ts": 4000, "from": "writer", "to": ["lead"], "body": "@lead new work" }),
        ];
        let hidden = ["boundary".to_string()].into_iter().collect();
        let routed = route_chat_history_hiding(
            &messages,
            &["writer".to_string(), "reviewer".to_string(), "lead".to_string()],
            &hidden,
        );
        let context = team_context(&routed, "reviewer", false).expect("new work follows the boundary");
        assert!(!context.contains("old task"));
        assert!(!context.contains("archived task"));
        assert!(context.contains("writer -> @lead: @lead new work"));
    }

    /// Board #290: a reply's quote goes after the leading addresses, and
    /// `re` must name a message of THIS room (orchestrator 11:30).
    #[test]
    fn a_reply_quotes_a_message_of_its_own_room_after_the_addresses() {
        assert_eq!(quote_into("[re a 1:00: 「x」] ", "@builder @lead which one?"), "@builder @lead [re a 1:00: 「x」] which one?");
        assert_eq!(quote_into("[re a 1:00: 「x」] ", "no address"), "[re a 1:00: 「x」] no address");
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 9, 30, 12, 0, 0).unwrap();
        let at = |d, h, m| chrono::Local.with_ymd_and_hms(2026, 9, d, h, m, 0).unwrap().timestamp_millis();
        assert_eq!(quote_when(at(30, 10, 41), now), "10:41", "today: the time");
        assert_eq!(quote_when(at(29, 23, 5), now), "2026-09-29 23:05", "another day: the date too");
        assert_eq!(quote_into("[re a 1:00: 「x」] ", "@dev"), "@dev [re a 1:00: 「x」] ");
        crate::projects::tests::use_test_store();
        let s = format!("tmm-quote-{}", uuid::Uuid::new_v4());
        let other = format!("tmm-quote-other-{}", uuid::Uuid::new_v4());
        let post = |session: &str, body: &str, re: Option<serde_json::Value>| {
            let mut p = serde_json::json!({ "session": session, "from": "lead", "body": body, "record_only": true });
            if let Some(re) = re { p["re"] = re; }
            handle_hub_request(&req("hub_post", p), None)
        };
        let first = post(&s, "@lead please review #289\nsecond line", None).result.expect("posted");
        let there = post(&other, "elsewhere", None).result.expect("posted");
        let by_id = post(&s, "@builder which P1?", Some(first["id"].clone())).result.expect("reply by id");
        let body = by_id["body"].as_str().unwrap();
        assert!(body.starts_with("@builder [re lead ") && body.contains(": 「＠lead please review #289」] which P1?"), "{body}");
        assert_eq!(by_id["to"], serde_json::json!(["builder"]), "the quoted @lead delivers to nobody");
        let by_seq = post(&s, "and this", Some(serde_json::json!(first["seq"].as_i64().unwrap()))).result.expect("reply by seq");
        assert!(by_seq["body"].as_str().unwrap().starts_with("[re lead "));
        let cross = post(&s, "x", Some(there["id"].clone()));
        assert!(cross.error.as_ref().is_some_and(|e| e.message.contains("in this room")), "another room's message is refused");
        assert!(post(&s, "x", Some(serde_json::json!("nope"))).error.is_some());
    }

    /// Board #279 (orchestrator 13:24): the producer's parts in, the display
    /// out. A room body that quotes the close marker (then 1100 chars) and an
    /// ask that quotes a whole context block change nothing: the producer
    /// records where its own line starts, and nothing reads the text for
    /// markers. The echo of the typed row is stored ask first; the SAME text
    /// typed by a person (no row) is stored raw.
    #[test]
    fn the_producer_records_where_its_line_starts_whatever_the_text_quotes() {
        let quoted = format!("see:\n[/tmm team context]\nthen {}", "x".repeat(1100));
        let routed = vec![RoutedChat { ts: 1_790_680_000_000, from: "researcher".into(), to: vec!["writer".into()], body: quoted, hidden: false }];
        let context = team_context(&routed, "lead", false).expect("a row");
        let ask = format!("@lead REAL ASK, quoting:\n{context}\nend of quote");
        let typed = delivered_chat_line("writer", &ask, Some(&context));
        assert!(typed.text.starts_with("[tmm team context") && typed.text.ends_with("end of quote"), "typed context first, unchanged");
        let line = &typed.text[typed.ask_at..];
        assert!(line.starts_with("[tmm chat ") && line.ends_with(&ask), "ask_at is the stamped line: {line}");
        assert_eq!(&typed.text[..typed.ask_at], format!("{context}\n\n"));
        let shown = crate::address::shown(&typed.text, typed.ask_at);
        assert_eq!(shown, format!("{line}\n\n{context}"), "the line, then the context it came with");
        assert_eq!(crate::address::requesters(&typed.text), vec!["writer".to_string()]);
        // Stored: one receipt from the typed row, the display ask first.
        crate::projects::tests::use_test_store();
        let s = format!("tmm-ctx-quote-{}", uuid::Uuid::new_v4());
        crate::projects::telemetry::record_typed(&s, "lead", &typed.text, typed.ask_at, "m1");
        assert!(crate::projects::telemetry::record_prompt(&s, "lead", &typed.text), "one echo, one receipt");
        assert!(crate::projects::telemetry::owed_rows(&s, "lead").is_empty());
        let prompts = |s: &str| crate::projects::telemetry::recent_events(s, 0).into_iter().filter(|e| e.kind == "prompt").collect::<Vec<_>>();
        let stored = prompts(&s).pop().unwrap();
        assert!(stored.text.starts_with(line.get(..1000).unwrap()), "the 1024-char stored text keeps the ask: {}", stored.text);
        // Negative control: the same text with no row of ours is raw.
        let h = format!("tmm-ctx-paste-{}", uuid::Uuid::new_v4());
        assert!(!crate::projects::telemetry::record_prompt(&h, "lead", &typed.text));
        let raw = prompts(&h).pop().unwrap();
        assert!(raw.text.starts_with("[tmm team context"), "a pasted block is stored as typed, not reordered: {}", raw.text);
    }

    #[test]
    fn team_context_keeps_the_current_request_first_and_handles_all() {
        let messages = vec![
            serde_json::json!({ "ts": 1000, "from": "human", "body": "@all start" }),
            serde_json::json!({ "ts": 2000, "from": "writer", "body": "writer done" }),
            serde_json::json!({ "ts": 3000, "from": "reviewer", "body": "review done" }),
        ];
        let agents = vec!["writer".to_string(), "reviewer".to_string()];
        let routed = route_chat_history(&messages, &agents);
        assert_eq!(routed[1].to, vec!["human"]);
        assert_eq!(routed[2].to, vec!["human"]);

        let context = team_context(&routed, "lead", true).expect("lead has no prior boundary");
        let delivered = delivered_chat_line("human", "@lead decide", Some(&context)).text;
        // Board #279: the context first, the ask LAST.
        assert!(delivered.starts_with("[tmm team context"), "{delivered}");
        assert!(delivered.find("[/tmm team context]").unwrap() < delivered.find("[tmm chat ").unwrap());
        assert!(delivered.ends_with(": @lead decide"), "the last thing read is the ask: {delivered}");
        let from_agent = delivered_chat_line("writer", "@lead decide", Some(&context));
        assert_eq!(crate::address::requesters(&from_agent.text), vec!["writer".to_string()], "the reply edge still finds the requester");
        assert!(!delivered.contains("older room history omitted"), "@all is lead's prior delivery");
        assert!(!delivered_chat_line("human", "@solo decide", None).text.contains("[tmm team context"));
    }

    /// Kills the test session and removes its workspace when dropped, so a
    /// test that fails part-way leaves no live session for the server on the
    /// same tmux to adopt as a project (2026-09-27, the #250 negative controls).
    struct KillOnDrop(String, std::path::PathBuf);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    /// Board #250 (validator 16:31), on the real delivery path: two
    /// multi-line messages to two DIFFERENT managed panes, posted at the same
    /// moment, each held between its paste buffer's load and paste. Each pane
    /// gets its own text and only its own; with the old shared buffer name one
    /// paste failed or landed in the other pane.
    #[test]
    fn concurrent_multiline_mentions_to_two_panes_each_arrive_whole() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-paste-hub-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-paste-hub-ws-{}", uuid::Uuid::new_v4()));
        for name in ["lead", "solo"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": "" }).to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        // The session exists from here on: guard it before any later step
        // can panic (validator, #251 — a failed new-window used to leak it).
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "solo", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("paste-hub-test")).expect("adopt project");
        let posts: Vec<_> = ["lead", "solo"]
            .into_iter()
            .map(|name| {
                let session = session.clone();
                std::thread::spawn(move || {
                    crate::tmux::PASTE_GAP.with(|g| g.set(std::time::Duration::from_millis(150)));
                    handle_hub_request(
                        &req("hub_post", serde_json::json!({
                            "session": session, "from": "human",
                            "body": format!("@{name} first line for {name}\nsecond line for {name}"),
                        })),
                        None,
                    )
                })
            })
            .collect();
        for p in posts {
            let r = p.join().unwrap();
            assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        }
        std::thread::sleep(std::time::Duration::from_millis(600));
        let lead = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        let solo = crate::tmux::capture_pane_plain(&format!("{session}:solo"), Some(0)).unwrap_or_default();
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
        assert!(lead.contains("first line for lead") && lead.contains("second line for lead"), "lead: {lead:?}");
        assert!(solo.contains("first line for solo") && solo.contains("second line for solo"), "solo: {solo:?}");
        assert!(!lead.contains("for solo") && !solo.contains("for lead"), "no cross-pane text: {lead:?} / {solo:?}");
    }

    /// Board #250 (orchestrator 17:00/17:21), through hub_post: a message to
    /// an agent whose pane is in copy-mode is refused, not typed — the mode
    /// stays, no pending row is written, and ONE plain warn names the window,
    /// the reason and the line at once, with no delivery reference. The other recipient of the same message is
    /// delivered as usual.
    #[test]
    fn a_mention_to_a_pane_in_copy_mode_warns_at_once_and_owes_nothing() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-copymode-hub-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-copymode-hub-ws-{}", uuid::Uuid::new_v4()));
        for name in ["lead", "solo"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": "" }).to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        // The session exists from here on: guard it before any later step
        // can panic (validator, #251 — a failed new-window used to leak it).
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "solo", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("copymode-hub-test")).expect("adopt project");
        let lead = format!("{session}:lead");
        crate::tmux::run_tmux(&["copy-mode", "-t", &lead]).unwrap();
        let r = handle_hub_request(
            &req("hub_post", serde_json::json!({ "session": session, "from": "human", "body": "@lead @solo read this" })),
            None,
        );
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
        let msg_id = r.result.as_ref().and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap().to_string();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let still = crate::tmux::pane_in_mode(&lead).unwrap();
        let owed = crate::projects::telemetry::owed_message_ids(&session);
        let warns: Vec<_> = crate::projects::telemetry::recent_events(&session, 0).into_iter().filter(|e| e.kind == "warn").collect();
        crate::tmux::run_tmux(&["send-keys", "-t", &lead, "-X", "cancel"]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let lead_text = crate::tmux::capture_pane_plain(&lead, Some(0)).unwrap_or_default();
        let solo_text = crate::tmux::capture_pane_plain(&format!("{session}:solo"), Some(0)).unwrap_or_default();
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
        assert!(still, "copy-mode is never cancelled for a delivery");
        assert!(!lead_text.contains("read this"), "nothing typed into the reading pane: {lead_text:?}");
        assert!(solo_text.contains("read this"), "the other recipient still gets it: {solo_text:?}");
        assert_eq!(owed, vec![msg_id.clone()], "only solo's line is owed; lead's refused line is no pending row");
        assert_eq!(warns.len(), 1, "{warns:?}");
        assert_eq!(warns[0].window, "lead");
        assert!(warns[0].text.starts_with("undelivered (pane is in copy mode): "), "{}", warns[0].text);
        assert!(warns[0].text.contains("@lead @solo read this"), "the note carries the line: {}", warns[0].text);
        // No row, so no reference: `deliveries` names real rows only (#249),
        // and the wire form has no `deliveries` key at all.
        assert!(warns[0].deliveries.is_empty(), "{:?}", warns[0].deliveries);
        assert!(serde_json::to_value(&warns[0]).unwrap().get("deliveries").is_none());
    }

    /// Board #264 × #257 (orchestrator 11:29): a CLI reads a command only as a
    /// whole line, so `hub_command` never goes through delivery holding. At a
    /// BUSY queue-mode kiro the chat line is held while the command is typed
    /// at once, stays out of the held batch, and owns only its receipt row.
    #[test]
    fn a_command_to_a_busy_queue_mode_agent_is_typed_now_never_held() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-cmd-busy-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-cmd-busy-ws-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/lead");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("launch.json"),
            serde_json::json!({ "backend": "kiro", "cmd": "kiro-cli chat --agent lead", "team": "", "input_mode": "queue" }).to_string(),
        )
        .unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        crate::projects::adopt(&session, Some("cmd-busy-test")).expect("adopt project");
        // A turn is open: lead is running, so chat lines are held (#257).
        crate::projects::telemetry::record_prompt(&session, "lead", "a long task");
        let chat = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "human", "body": "@lead read this later" })), None);
        assert!(chat.error.is_none(), "{:?}", chat.error.map(|e| e.message));
        let cmd = handle_hub_request(&req("hub_command", serde_json::json!({ "session": session, "agent": "lead", "text": "/goal next step" })), None);
        assert!(cmd.error.is_none(), "{:?}", cmd.error.map(|e| e.message));
        // A command with no measured prompt hook: typed, and no row at all.
        let effort = handle_hub_request(&req("hub_command", serde_json::json!({ "session": session, "agent": "lead", "text": "/effort medium" })), None);
        assert!(effort.error.is_none(), "{:?}", effort.error.map(|e| e.message));
        std::thread::sleep(std::time::Duration::from_millis(400));
        let text = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        let held: Vec<String> = crate::projects::telemetry::held_rows(&session, "lead").into_iter().map(|r| r.line).collect();
        let owed = crate::projects::telemetry::owed_rows(&session, "lead");
        assert!(text.contains("/goal next step"), "the command is typed at once, whole: {text:?}");
        assert!(text.contains("/effort medium"), "{text:?}");
        assert!(!text.contains("read this later"), "the chat line waits for the turn's end: {text:?}");
        assert_eq!(held.len(), 1, "{held:?}");
        assert!(held[0].contains("read this later") && !held[0].contains("/goal"), "the command is never in the held batch: {held:?}");
        assert_eq!(owed.len(), 1, "only the /goal receipt is a typed row; /effort has none: {owed:?}");
        assert_eq!(owed[0].line, "goal next step", "kiro's declared echo");
        assert_eq!(owed[0].command, Some(crate::projects::store::CommandLife::Queued), "typed into a running turn");
    }

    /// Board #274: a command an AGENT sends (`tmm send "@bob /compact"`)
    /// is recorded under that agent, never under "human"; `all` reaches every
    /// OTHER managed agent, not the sender's own pane; and a command to
    /// itself is refused before anything is typed. Control: the composer's
    /// call (no `from`) still records as the human.
    #[test]
    fn an_agents_command_names_it_skips_it_and_is_refused_to_itself() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-cmd-from-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-cmd-from-ws-{}", uuid::Uuid::new_v4()));
        for name in ["lead", "dev"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": "" }).to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("cmd-from-test")).expect("adopt project");
        let call = |params: serde_json::Value| handle_hub_request(&req("hub_command", params), None);
        let one = call(serde_json::json!({ "session": session, "agent": "dev", "text": "/compact", "from": "lead" }));
        let all = call(serde_json::json!({ "session": session, "agent": "all", "text": "/clear", "from": "lead" }));
        let own = call(serde_json::json!({ "session": session, "agent": "lead", "text": "/compact", "from": "lead" }));
        let human = call(serde_json::json!({ "session": session, "agent": "lead", "text": "/effort medium" }));
        std::thread::sleep(std::time::Duration::from_millis(400));
        let lead_text = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        let dev_text = crate::tmux::capture_pane_plain(&format!("{session}:dev"), Some(0)).unwrap_or_default();
        let room: Vec<(String, String)> = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session })), None)
            .result
            .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| Some((m.get("from")?.as_str()?.to_string(), m.get("body")?.as_str()?.to_string())))
            .collect();
        assert!(one.error.is_none(), "{:?}", one.error.map(|e| e.message));
        assert_eq!(all.result.as_ref().and_then(|v| v.get("sent")).cloned(), Some(serde_json::json!(["dev"])), "all = everyone but the sender");
        assert!(own.error.as_ref().is_some_and(|e| e.message.contains("cannot send a command to itself")), "{:?}", own.error.map(|e| e.message));
        assert!(human.error.is_none(), "{:?}", human.error.map(|e| e.message));
        assert!(dev_text.contains("/compact") && dev_text.contains("/clear"), "{dev_text:?}");
        assert!(!lead_text.contains("/compact") && !lead_text.contains("/clear"), "nothing typed into the sender: {lead_text:?}");
        assert!(lead_text.contains("/effort medium"), "the human's command still reaches lead: {lead_text:?}");
        assert_eq!(
            room,
            vec![
                ("lead".to_string(), "[tmm] /compact → dev".to_string()),
                ("lead".to_string(), "[tmm] /clear → dev".to_string()),
                ("human".to_string(), "[tmm] /effort medium → lead".to_string()),
            ],
            "one line per command, under its sender; the refused one records nothing"
        );
    }

    /// Board #275: a fired wake is posted ONCE, as its scheduler, and typed
    /// into the scheduler's own pane when it names itself — the one exception
    /// to "never back into the sender". Controls in the same test: an
    /// ordinary `hub_post` from dev to `@dev` types nothing, and a second
    /// fire of the same wake does nothing (claimed).
    #[test]
    fn a_fired_wake_reaches_its_own_sender_once() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-wake-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-wake-ws-{}", uuid::Uuid::new_v4()));
        for name in ["dev", "lead"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": "" }).to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("wake-test")).expect("adopt project");
        let control = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "dev", "body": "@dev note to self now" })), None);
        assert!(control.error.is_none(), "{:?}", control.error.map(|e| e.message));
        let now = crate::projects::now() as i64;
        let add = handle_hub_request(&req("hub_wake_add", serde_json::json!({ "session": session, "from": "dev", "body": "@dev check the build", "due": now })), None);
        let w: crate::projects::store::Wake = serde_json::from_value(add.result.expect("scheduled")).unwrap();
        fire_wake(w.id);
        fire_wake(w.id);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let dev = crate::tmux::capture_pane_plain(&format!("{session}:dev"), Some(0)).unwrap_or_default();
        let lead = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        let room: Vec<(String, String)> = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session })), None)
            .result
            .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| Some((m.get("from")?.as_str()?.to_string(), m.get("body")?.as_str()?.to_string())))
            .collect();
        assert!(!dev.contains("note to self now"), "an ordinary line is never typed back into its sender: {dev:?}");
        assert!(dev.contains("dev: [wake] @dev check the build"), "the wake reaches its own sender: {dev:?}");
        // Once: `cat` shows a typed line twice (tty echo + its output), so the
        // count is the delivery row the one typing recorded.
        let owed = crate::projects::telemetry::owed_rows(&session, "dev");
        assert_eq!(owed.len(), 1, "typed once, not per fire: {owed:?}");
        assert!(!lead.contains("[wake]"), "nobody else was addressed: {lead:?}");
        assert_eq!(
            room.iter().filter(|(_, b)| b.starts_with("[wake]")).cloned().collect::<Vec<_>>(),
            vec![("dev".to_string(), "[wake] @dev check the build".to_string())],
            "one room record, at fire time, under its scheduler"
        );
        let list = handle_hub_request(&req("hub_wake_list", serde_json::json!({ "session": session })), None);
        assert_eq!(list.result.unwrap()["wakes"], serde_json::json!([]), "a fired wake is no longer pending");
        // Board #285: a post the CLI found DETACHED from dev's turn (its
        // watcher, left behind) reaches dev too, and @lead as ever.
        let watcher = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "dev", "body": "@lead @dev [watcher] job done", "detached": true })), None);
        assert!(watcher.error.is_none(), "{:?}", watcher.error.map(|e| e.message));
        std::thread::sleep(std::time::Duration::from_millis(400));
        let dev = crate::tmux::capture_pane_plain(&format!("{session}:dev"), Some(0)).unwrap_or_default();
        let lead = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        assert!(dev.contains("dev: @lead @dev [watcher] job done"), "the detached copy reaches its sender: {dev:?}");
        assert!(lead.contains("dev: @lead @dev [watcher] job done"), "{lead:?}");
        assert!(!dev.contains("note to self now"), "the in-turn line still did not: {dev:?}");
    }

    /// Board #275 (validator 09:31): a wake follows the project through a
    /// rename. After A → B the list, the card hover and cancel find it under
    /// B; after A → B → C (A no longer resolves) it fires ONCE into the real
    /// pane of the project's current session and room.
    #[test]
    fn a_wake_follows_two_renames_and_fires_once_into_the_real_pane() {
        crate::projects::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let session = format!("tmm-wren-{tag}");
        let ws = std::env::temp_dir().join(format!("tmm-wren-ws-{tag}"));
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro-cli chat --agent dev", "team": "" }).to_string()).unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let (b, c) = (format!("tmm-wren-b-{tag}"), format!("tmm-wren-c-{tag}"));
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        let _cleanup_b = KillOnDrop(b.clone(), ws.clone());
        let _cleanup_c = KillOnDrop(c.clone(), ws.clone());
        crate::projects::adopt(&session, Some("wake-rename-test")).expect("adopt project");
        let id = crate::projects::project_for_session(&session).unwrap().expect("tracked").id;
        let call = |m: &str, params: serde_json::Value| handle_hub_request(&req(m, params), None);
        let now = crate::projects::now() as i64;
        let keep = call("hub_wake_add", serde_json::json!({ "session": session, "from": "lead", "body": "@dev after two renames", "due": now + 3600 }));
        let gone = call("hub_wake_add", serde_json::json!({ "session": session, "from": "lead", "body": "@dev to cancel", "due": now + 3600 }));
        // The sleeper's view, taken BEFORE the renames (validator 09:54): it
        // must not decide where the wake goes.
        let keep: crate::projects::store::Wake = serde_json::from_value(keep.result.expect("scheduled")).unwrap();
        assert_eq!(keep.session, session, "the snapshot says A");
        let gone_id = gone.result.expect("scheduled")["id"].as_i64().unwrap();

        crate::projects::rename(&id, &b).expect("rename to B");
        let listed = call("hub_wake_list", serde_json::json!({ "session": b })).result.unwrap();
        assert_eq!(listed["wakes"].as_array().map(|a| a.len()), Some(2), "B lists both: {listed}");
        let hover = agent_states(&b);
        let dev = hover["agents"].as_array().unwrap().iter().find(|a| a["name"] == "dev").cloned().unwrap();
        assert_eq!(dev["wake"]["from"], "lead", "the card hover still names it: {dev}");
        assert!(call("hub_wake_cancel", serde_json::json!({ "session": b, "id": gone_id, "by": "lead" })).error.is_none(), "cancel in B");

        crate::projects::rename(&id, &c).expect("rename to C");
        assert!(crate::projects::project_for_session(&session).unwrap().is_none(), "A no longer resolves");
        let w = crate::projects::wakes::pending(None).into_iter().find(|w| w.id == keep.id).expect("still pending");
        assert_eq!(w.session, c, "the row followed both renames");
        fire_wake(keep.id);
        fire_wake(keep.id);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let pane = crate::tmux::capture_pane_plain(&format!("{c}:dev"), Some(0)).unwrap_or_default();
        assert!(pane.contains("lead: [wake] @dev after two renames"), "typed into the real pane: {pane:?}");
        assert_eq!(crate::projects::telemetry::owed_rows(&c, "dev").len(), 1, "once");
        let room: Vec<String> = call("hub_log", serde_json::json!({ "session": c })).result
            .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned()).unwrap_or_default()
            .iter().filter_map(|m| m.get("body").and_then(|b| b.as_str()).map(str::to_string)).filter(|b| b.starts_with("[wake]")).collect();
        assert_eq!(room, vec!["[wake] @dev after two renames".to_string()], "one record, in the project's room");
    }

    /// Board #250 (validator 17:35): `hub_command` to `all` where one pane is
    /// in copy-mode and the other is not. The one that took it is recorded
    /// and answered as success; the refused one gets the same immediate plain
    /// warn as a refused chat line (target, reason, command; no deliveries),
    /// its mode kept, nothing typed. A single target that refuses stays an
    /// RPC error — nothing ran, so there is no success to repeat — and warns.
    #[test]
    fn a_command_to_all_with_one_pane_in_copy_mode_warns_for_it_and_runs_the_rest() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-copymode-cmd-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-copymode-cmd-ws-{}", uuid::Uuid::new_v4()));
        for name in ["lead", "solo"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({ "backend": "kiro", "cmd": format!("kiro-cli chat --agent {name}"), "team": "" }).to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "lead", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        // The session exists from here on: guard it before any later step
        // can panic (validator, #251 — a failed new-window used to leak it).
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "solo", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("copymode-cmd-test")).expect("adopt project");
        let lead = format!("{session}:lead");
        crate::tmux::run_tmux(&["copy-mode", "-t", &lead]).unwrap();
        let all = handle_hub_request(&req("hub_command", serde_json::json!({ "session": session, "agent": "all", "text": "/compact now" })), None);
        let one = handle_hub_request(&req("hub_command", serde_json::json!({ "session": session, "agent": "lead", "text": "/clear" })), None);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let still = crate::tmux::pane_in_mode(&lead).unwrap();
        let warns: Vec<_> = crate::projects::telemetry::recent_events(&session, 0).into_iter().filter(|e| e.kind == "warn").collect();
        let room: Vec<String> = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session })), None)
            .result
            .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m.get("body").and_then(|b| b.as_str()).map(str::to_string))
            .collect();
        crate::tmux::run_tmux(&["send-keys", "-t", &lead, "-X", "cancel"]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let lead_text = crate::tmux::capture_pane_plain(&lead, Some(0)).unwrap_or_default();
        let solo_text = crate::tmux::capture_pane_plain(&format!("{session}:solo"), Some(0)).unwrap_or_default();
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
        // all: the taker is the success, the refused one is a warn.
        assert!(all.error.is_none(), "{:?}", all.error.map(|e| e.message));
        assert_eq!(all.result.as_ref().and_then(|v| v.get("sent")).cloned(), Some(serde_json::json!(["solo"])));
        assert!(solo_text.contains("/compact now"), "{solo_text:?}");
        // single target, refused: an error, and a warn of its own.
        let err = one.error.expect("a single refused target is an error").message;
        assert!(err.contains("lead: pane is in copy mode"), "{err}");
        assert!(still, "copy-mode is never cancelled for a command");
        assert!(!lead_text.contains("/compact") && !lead_text.contains("/clear"), "nothing typed: {lead_text:?}");
        assert_eq!(room, vec!["[tmm] /compact now → solo".to_string()], "the room records only what ran");
        let texts: Vec<(&str, &str)> = warns.iter().map(|w| (w.window.as_str(), w.text.as_str())).collect();
        assert_eq!(
            texts,
            vec![("lead", "undelivered (pane is in copy mode): /compact now"), ("lead", "undelivered (pane is in copy mode): /clear")],
        );
        assert!(warns.iter().all(|w| w.deliveries.is_empty()), "no delivery reference");
    }

    /// Board #248, on the real delivery path: an in-word `@` (an email, `a@bob`)
    /// types into nobody and is stored with no recipient, while `(@bob)` —
    /// punctuation around a real address — reaches bob.
    #[test]
    fn an_in_word_at_delivers_to_nobody_but_a_bracketed_address_does() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-inword-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-inword-ws-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/bob");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("launch.json"),
            serde_json::json!({ "backend": "kiro", "cmd": "kiro-cli chat --agent bob", "team": "" }).to_string(),
        )
        .unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "bob", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        crate::projects::adopt(&session, Some("inword-test")).expect("adopt project");
        let post = |body: &str| {
            let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "human", "body": body })), None);
            assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
            r.result.unwrap()
        };
        let email = post("mail me at a@bob.dev or ping a@bob");
        std::thread::sleep(std::time::Duration::from_millis(400));
        let after_email = crate::tmux::capture_pane_plain(&format!("{session}:bob"), Some(0)).unwrap_or_default();
        let bracket = post("(@bob) please look");
        std::thread::sleep(std::time::Duration::from_millis(400));
        let after_bracket = crate::tmux::capture_pane_plain(&format!("{session}:bob"), Some(0)).unwrap_or_default();
        assert!(!after_email.contains("mail me"), "an in-word @ types into nobody: {after_email:?}");
        assert_eq!(email.get("to"), Some(&serde_json::json!([])), "and is stored with no recipient: {email}");
        assert!(after_bracket.contains("(@bob) please look"), "a bracketed address reaches bob: {after_bracket:?}");
        assert_eq!(bracket.get("to"), Some(&serde_json::json!(["bob"])), "{bracket}");
    }

    #[test]
    fn mention_delivery_adds_context_only_to_the_team_member() {
        crate::projects::tests::use_test_store();
        // The guard exists before anything it cleans (#268/#269, validator
        // 12:38): every exit path, a panic included, kills and removes.
        let mut scratch = crate::tmux::Scratch::new("team-context");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        for (name, team) in [("lead", "content"), ("solo", "")] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                home.join("launch.json"),
                serde_json::json!({
                    "backend": "kiro",
                    "cmd": format!("kiro-cli chat --agent {name}"),
                    "team": team,
                })
                .to_string(),
            )
            .unwrap();
        }
        let created = std::process::Command::new("tmux")
            .args([
                "new-session", "-d", "-s", &session, "-n", "lead", "-c",
                &ws.to_string_lossy(), "cat",
            ])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        std::process::Command::new("tmux")
            .args(["new-window", "-d", "-t", &session, "-n", "solo", "-c", &ws.to_string_lossy(), "cat"])
            .status()
            .unwrap();
        crate::projects::adopt(&session, Some("team-context-test")).expect("adopt project");
        let room = project_room(&session);
        // Room history BEFORE the current message — the catch-up the team
        // member must receive. Stored routes are what the reconstruction reads.
        rooms::seed_msg(&room, &format!("{room}-1"), 1000, "human", &["lead".into()], "@lead old task");
        rooms::seed_msg(&room, &format!("{room}-2"), 2000, "writer", &["researcher".into()], "@researcher verify");
        rooms::seed_msg(&room, &format!("{room}-3"), 3000, "researcher", &[], "evidence ready");

        let response = handle_hub_request(
            &req("hub_post", serde_json::json!({
                "session": session, "from": "human", "body": "@lead @solo decide",
            })),
            None,
        );
        assert!(response.error.is_none(), "{:?}", response.error.map(|error| error.message));
        std::thread::sleep(std::time::Duration::from_millis(500));
        let lead = crate::tmux::capture_pane_plain(&format!("{session}:lead"), Some(0)).unwrap_or_default();
        let solo = crate::tmux::capture_pane_plain(&format!("{session}:solo"), Some(0)).unwrap_or_default();
        assert!(lead.contains("@lead @solo decide"), "lead receives the current request: {lead:?}");
        assert!(lead.contains("[tmm team context"), "team member receives catch-up: {lead:?}");
        assert!(lead.contains("writer -> @researcher"), "explicit route is named: {lead:?}");
        assert!(lead.contains("researcher -> @writer"), "automatic reply route is named: {lead:?}");
        // What was TYPED (the row), not the pane: `cat` echoes a typed line
        // back a timing-dependent number of times.
        let typed_lead = crate::projects::telemetry::owed_rows(&session, "lead").into_iter().next().expect("lead's row").line;
        assert_eq!(typed_lead.matches("@lead @solo decide").count(), 1, "the current message is not part of its own catch-up: {typed_lead}");
        assert!(solo.contains("@lead @solo decide"), "solo receives the current request: {solo:?}");
        assert!(!solo.contains("[tmm team context"), "solo stays one-line: {solo:?}");
        // Each typed line names the message it carries (board #249), so its
        // echo can mark that message delivered on any client.
        let id = response.result.as_ref().and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap().to_string();
        let owed = crate::projects::telemetry::owed_message_ids(&session);
        assert_eq!(owed, vec![id.clone(), id], "one row per typed pane, each naming the message");

        // Board #279: the team member reads the context FIRST and the ask
        // LAST; its one echo (what kiro submits: the typed text) settles its
        // row, the stored prompt shows the ask first, and the solo line's
        // row stays owed.
        let ctx_at = lead.find("[tmm team context").unwrap();
        let ask_at = lead.find("[tmm chat ").unwrap();
        assert!(ctx_at < ask_at, "context before the ask in the pane: {lead:?}");
        let typed = typed_lead;
        assert!(typed.starts_with("[tmm team context") && typed.ends_with("human: @lead @solo decide"), "{typed}");
        assert!(crate::projects::telemetry::record_prompt(&session, "lead", &typed), "one echo, one receipt");
        assert!(crate::projects::telemetry::owed_rows(&session, "lead").is_empty());
        assert_eq!(crate::projects::telemetry::owed_rows(&session, "solo").len(), 1, "solo's own row is untouched");
        let stored = crate::projects::telemetry::recent_events(&session, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap();
        assert!(stored.text.starts_with("[tmm chat ") && stored.text.contains("@lead @solo decide"), "stored ask first: {}", stored.text);
        assert_eq!(stored.deliveries.len(), 1, "the receipt names the row");
    }

    /// A Board reply is first persisted, then delivered into the assigned
    /// managed pane. This real-tmux edge pins the part a pure decision test
    /// cannot: the note actually reaches INPUT through `deliver_chat_line`.
    #[test]
    fn a_board_reply_is_persisted_and_typed_into_the_assignees_pane() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-board-reply-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-board-reply-ws-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("launch.json"),
            r#"{"backend":"kiro","cmd":"kiro-cli chat --agent dev"}"#,
        )
        .unwrap();
        let created = std::process::Command::new("tmux")
            .args([
                "new-session", "-d", "-s", &session, "-n", "dev", "-c",
                &ws.to_string_lossy(), "cat",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        crate::projects::adopt(&session, Some("board-reply-test")).expect("adopt test project");
        let issue_id = crate::projects::board_save(
            &session,
            None,
            Some("Retry edge"),
            Some("Keep the receipt semantics"),
            None,
            Some("dev"),
            "human",
        )
        .unwrap();

        let r = handle_hub_request(
            &req("hub_board_note", serde_json::json!({
                "session": session, "id": issue_id, "who": "human",
                "body": "Please cover the restart case",
            })),
            None,
        );
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));

        let issue = crate::projects::board_get(&session, issue_id).unwrap();
        assert_eq!(issue["notes"][0]["body"], "Please cover the restart case");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let pane = crate::tmux::capture_pane_plain(&format!("{session}:dev"), Some(0)).unwrap_or_default();
        assert!(pane.contains(&format!("[board #{issue_id} reply] Retry edge")), "pane: {pane:?}");
        assert!(pane.contains("Please cover the restart case"), "pane: {pane:?}");

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Stop/restart act on a process, so the gate is the same one delivery and
    /// auto-post use: only agents this app started. The room records the act.
    #[test]
    fn stopping_a_managed_agent_kills_the_window_and_says_so() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-stop-{}", std::process::id());
        let ws = std::env::temp_dir().join(format!("tmm-stop-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        // Start it IN the workspace: `adopt` derives the project path from the
        // panes' cwd, so this is what makes managed_home resolve to <ws>/.tmm.
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c",
                   &ws.to_string_lossy(), "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        // A project must claim the session for managed_home to resolve.
        let created_project = crate::projects::adopt(&session, Some("stop-test")).is_ok();

        let r = handle_hub_request(
            &req("hub_agent_stop", serde_json::json!({ "session": session, "agent": "dev" })),
            None,
        );
        if !created_project {
            eprintln!("could not adopt a project — skipping the positive half");
        } else {
            assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
            let panes = crate::tmux::list_panes(&session).unwrap_or_default();
            assert!(!panes.iter().any(|p| p.window_name == "dev"), "the window is gone");
            let msgs = rooms::history_page(&project_room(&session), None, 10);
            let msgs = msgs["messages"].as_array().unwrap();
            assert!(
                msgs.iter().any(|m| m["body"].as_str().unwrap_or("").contains("[tmm] stopped dev")),
                "the room records it: {msgs:?}"
            );
        }
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Interrupt, against real tmux: the window SURVIVES (Escape cancels a
    /// turn, it does not kill a process), the derived state is reset to `idle`
    /// BEFORE the key is typed, and the room records the act — the feed row is
    /// half of the composer's interrupt affordance (owner, 2026-08-24: "发送
    /// interrupt 的状态在消息列表里也要展示出来").
    #[test]
    fn interrupting_a_managed_agent_leaves_the_window_and_says_so() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-int-{}", std::process::id());
        let ws = std::env::temp_dir().join(format!("tmm-int-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c",
                   &ws.to_string_lossy(), "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        // Cleanup even when an assertion panics (#251).
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        let created_project = crate::projects::adopt(&session, Some("int-test")).is_ok();
        // A turn is OPEN on that window: the state we are interrupting, with
        // a requester on its reply edge.
        let (hub, hub_root) = crate::agent_notifications::AgentNotificationHub::scratch_with_turn(
            &session, "dev", "[tmm chat 2026-09-28 03:50] lead: @dev do the long thing");
        telemetry::record_prompt(&session, "dev", "do the long thing");
        assert_eq!(telemetry::derive(&session, "dev", 0).state, "running");
        assert!(hub.holds_edge(&session, "dev"));

        let r = handle_hub_request(
            &req("hub_agent_interrupt", serde_json::json!({ "session": session, "agent": "dev" })),
            Some(&hub),
        );
        let _ = std::fs::remove_dir_all(hub_root);
        if !created_project {
            eprintln!("could not adopt a project — skipping the positive half");
        } else {
            assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
            let panes = crate::tmux::list_panes(&session).unwrap_or_default();
            assert!(panes.iter().any(|p| p.window_name == "dev"), "the window survives an interrupt");
            assert_eq!(
                telemetry::derive(&session, "dev", 0).state,
                "idle",
                "the cancelled turn is closed by the interrupt itself — no stop hook is coming"
            );
            assert!(!hub.holds_edge(&session, "dev"),
                "#256: the interrupt's end edge drops the turn's reply edge at the call site");
            let msgs = rooms::history_page(&project_room(&session), None, 10);
            let msgs = msgs["messages"].as_array().unwrap();
            assert!(
                msgs.iter().any(|m| m["body"].as_str().unwrap_or("").contains("[tmm] interrupted dev")),
                "the room records it: {msgs:?}"
            );
        }
    }

    #[test]
    fn hub_log_since_ts_filters_older_messages() {
        crate::projects::tests::use_test_store();
        let (session, room) = unique("since");
        rooms::seed_msg(&room, &format!("{room}-1"), 100, "a", &[], "old");
        rooms::seed_msg(&room, &format!("{room}-2"), 200, "b", &[], "new");
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "since_ts": 100 })),
            None,
        );
        let msgs = r.result.unwrap();
        let msgs = msgs.get("messages").and_then(|m| m.as_array()).unwrap();
        assert_eq!(msgs.len(), 1, "only the ts>100 message survives");
        assert_eq!(msgs[0].get("body").and_then(|b| b.as_str()), Some("new"));
    }

    /// Review C (2026-09-03): an incremental poll takes the newest `limit` rows
    /// and THEN drops what is older than `since_ts`. When more than `limit`
    /// messages arrived since the cursor, the older ones were never on the page
    /// and the client's cursor jumped past them — a permanent hole. On a since_ts
    /// query `has_more` therefore means "newer-than-since_ts rows remain behind
    /// this page", and the client walks `before_seq` until it reaches the cursor.
    #[test]
    fn hub_log_since_ts_reports_when_the_page_did_not_reach_the_cursor() {
        crate::projects::tests::use_test_store();
        // 250 messages, ts = n * 10. The client last saw ts 1000 (the 100th):
        // 150 messages are newer, one page holds 100.
        let (session, room) = unique("cursor");
        let seeded: Vec<serde_json::Value> = (1..=250)
            .map(|n| rooms::seed_msg(&room, &format!("{room}-m{n}"), n * 10, "human", &[], format!("b{n}").as_str()))
            .collect();
        let seq = |n: usize| seeded[n - 1]["seq"].as_i64().unwrap();
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "since_ts": 1000, "limit": 100 })),
            None,
        );
        let v = r.result.expect("result");
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 100, "the newest page, all newer than the cursor");
        assert_eq!(msgs[0]["seq"], seq(151));
        assert_eq!(v["has_more"], true, "rows 101..150 are newer than the cursor and NOT on this page");
        assert_eq!(v["oldest_seq"], seq(151), "the cursor for the walk back");

        // The walk back: the page behind the 151st, still bounded by since_ts.
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "since_ts": 1000, "limit": 100, "before_seq": seq(151) })),
            None,
        );
        let v = r.result.expect("result");
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 50, "rows 101..150 survive the since_ts filter");
        assert_eq!(msgs[0]["seq"], seq(101));
        assert_eq!(v["has_more"], false, "the raw page reached back past the cursor: nothing newer remains");

        // A poll whose page reaches the cursor says so even when the room has
        // plenty of older history behind it.
        let r = handle_hub_request(
            &req("hub_log", serde_json::json!({ "session": session, "since_ts": 2400, "limit": 100 })),
            None,
        );
        let v = r.result.expect("result");
        assert_eq!(v["messages"].as_array().unwrap().len(), 10);
        assert_eq!(v["has_more"], false, "everything newer than the cursor is on this page");

        // And a first load (no since_ts) keeps the paging meaning: history remains.
        let r = handle_hub_request(&req("hub_log", serde_json::json!({ "session": session, "limit": 100 })), None);
        assert_eq!(r.result.expect("result")["has_more"], true);
    }

    /// `crate::projects` is compiled out on android/ios, so every item in
    /// these files that reads it MUST carry the desktop cfg gate. Nothing in
    /// the normal loop catches a missing one: `cargo test`, `cargo build` and
    /// the dev server all target the desktop, where the module exists — the
    /// error only appears in `npm run build:android`, which nobody runs per
    /// change. It broke exactly that way (board #16): `deliver_chat_line` was
    /// inserted directly beneath `deliver_mentions`' `#[cfg]`, adopted the
    /// gate (a doc comment between an attribute and its item is legal, so the
    /// attribute binds to whatever item follows), and left `deliver_mentions`
    /// ungated — 10 errors, two commits before anyone noticed. `chrono` is a
    /// desktop-gated dependency exactly like `crate::projects` (Cargo.toml
    /// target block) and broke the build the same silent way on 2026-09-09
    /// (context_stamp/delivered_chat_line, found by the board #100 smoke
    /// build).
    ///
    /// Since board #129 the same contract holds for `src/backends/*.rs` (an
    /// UNGATED leaf: the enum and the hook payload dialects compile on the
    /// phone, while render/sniff/refresh/known reach into `crate::projects`
    /// and gate themselves item by item) and for `agent_notifications.rs`
    /// (the inbox consumer the phone compiles). So the guard is a source
    /// contract, checked on the desktop where it is cheap, instead of a
    /// cross-compile nobody runs. Negative control on 2026-09-09: removing
    /// the gate above `kiro::render_kiro` failed this test naming it.
    #[test]
    fn projects_readers_are_desktop_gated() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<std::path::PathBuf> =
            vec![root.join("server/hub_rpc.rs"), root.join("agent_notifications.rs")];
        let mut backends: Vec<_> = std::fs::read_dir(root.join("backends"))
            .expect("src/backends exists")
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "rs"))
            .collect();
        backends.sort();
        assert!(backends.len() >= 6, "expected the five backend files + mod/shared, found {}", backends.len());
        files.extend(backends);

        let mut total = 0usize;
        let mut ungated: Vec<String> = Vec::new();
        for path in &files {
            let src = std::fs::read_to_string(path).unwrap();
            let (checked, bad) = ungated_desktop_readers(&src);
            total += checked;
            let name = path.strip_prefix(&root).unwrap().display().to_string();
            ungated.extend(bad.into_iter().map(|l| format!("{name}: {l}")));
        }

        assert!(
            ungated.is_empty(),
            "these read crate::projects / chrono with no desktop gate, so they break the Android build: {ungated:#?}"
        );
        // A guard that silently stops finding anything is not a guard. hub_rpc
        // alone holds the three delivery helpers the regression hit, and every
        // backend file gates at least its renderer; if the scan stops matching,
        // this count is the tripwire that says so.
        assert!(
            total >= 12,
            "expected at least 12 gated projects readers across these files, found {total} — did the scan stop matching?"
        );
    }

    /// The scan behind `projects_readers_are_desktop_gated`: every top-level
    /// item (`fn`, `use`, `impl` method) whose text reaches `crate::projects`
    /// or `chrono::` must have the desktop gate somewhere in the contiguous
    /// run of attributes and comments above it — the rule is "gated", not
    /// "gated on a particular line". Column-0 items and the methods of a
    /// column-0 `impl` are checked; anything deeper inherits its parent's
    /// gate, and the file's `#[cfg(test)]` module (column 0, always last) ends
    /// the scan. A gate on the item's own statements is also accepted (the
    /// inbox consumer's shape). Returns (items checked, offending signatures).
    fn ungated_desktop_readers(src: &str) -> (usize, Vec<String>) {
        const GATE: &str = "target_os = \"android\"";
        let lines: Vec<&str> = src.lines().collect();
        let end = lines.iter().position(|l| l.starts_with("#[cfg(test)]")).unwrap_or(lines.len());
        let is_fn = |t: &str| {
            ["fn ", "pub fn ", "pub(crate) fn ", "pub(super) fn "].iter().any(|p| t.starts_with(p))
        };
        let reaches = |text: &str| text.contains("crate::projects") || text.contains("chrono::");

        let mut checked = 0usize;
        let mut ungated = Vec::new();
        let mut depth = 0i32;
        let mut in_impl = false;
        for (i, line) in lines[..end].iter().enumerate() {
            let indent = line.len() - line.trim_start().len();
            let t = line.trim_start();
            if depth == 0 && t.starts_with("impl ") {
                in_impl = true;
            }
            let top_use = depth == 0 && (t.starts_with("use ") || t.starts_with("pub use ") || t.starts_with("pub(crate) use "));
            let item_fn = is_fn(t) && (depth == 0 || (depth == 1 && in_impl && indent == 4));
            if top_use || item_fn {
                // The item's text: a `use` is its line(s) up to `;`, a fn runs
                // until its braces balance again.
                let mut body = String::new();
                let mut d = 0i32;
                for l in &lines[i..] {
                    body.push_str(l);
                    body.push('\n');
                    d += l.chars().filter(|c| *c == '{').count() as i32;
                    d -= l.chars().filter(|c| *c == '}').count() as i32;
                    if top_use && l.contains(';') && d <= 0 {
                        break;
                    }
                    if item_fn && d <= 0 && body.contains('{') {
                        break;
                    }
                }
                if reaches(&body) {
                    checked += 1;
                    // A body that gates its own statements (`consume_file`
                    // reaches telemetry only under `#[cfg]` blocks) is the
                    // other legal shape; the cross-compile is what proves it
                    // covers every reference, this guard only rejects the
                    // wholly ungated item.
                    let mut gated = body.contains(GATE);
                    for l in lines[..i].iter().rev() {
                        let a = l.trim_start();
                        if !(a.starts_with('#') || a.starts_with("//")) {
                            break;
                        }
                        if a.contains(GATE) {
                            gated = true;
                            break;
                        }
                    }
                    if !gated {
                        ungated.push(t.to_string());
                    }
                }
            }
            depth += line.chars().filter(|c| *c == '{').count() as i32;
            depth -= line.chars().filter(|c| *c == '}').count() as i32;
            if depth <= 0 {
                in_impl = false;
            }
        }
        (checked, ungated)
    }
}
