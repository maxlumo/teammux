//! The project task board facade: statuses, issue refs, and the RPC-facing verbs over store::board.
//!
//! One family of `projects` (board #152): moved whole from mod.rs, which stays
//! the facade — every `projects::X` path is a re-export of this file.
//!
//! A kanban over the session, stored beside the projects it serves (owner,
//! 2026-08-29: "借助软件工程，可以把我们的任务管理的更好"). Four fixed columns —
//! a free-text status would fork the vocabulary per agent and the board would
//! stop being readable at a glance. The HUMAN writes issues on the board page;
//! agents read and update them through `tmm board`.

use super::*;

pub const BOARD_STATUSES: [&str; 4] = ["todo", "doing", "review", "done"];

pub(super) fn board_status_ok(status: Option<&str>) -> Result<(), String> {
    match status {
        Some(s) if !BOARD_STATUSES.contains(&s) => Err(format!(
            "status must be one of {} — got '{s}'",
            BOARD_STATUSES.join("|")
        )),
        _ => Ok(()),
    }
}

/// The chars kept when a titleless issue is identified by its body — a card
/// label / message head, not the content (the `…` says the rest lives on the
/// issue).
pub const ISSUE_REF_CHARS: usize = 40;

/// The stable display identity of an issue (board #31: titles are optional,
/// but nothing that SHOWS an issue may render an empty head): the trimmed
/// title when there is one; else the body, whitespace-squashed to one line
/// and cut on a char boundary (Unicode-safe) with a `…` marker; a legacy
/// all-empty issue falls back to `#id`. Every consumer — room lifecycle
/// lines, review/change/note notices, the CLI's list/show — speaks THIS
/// fallback, so the same issue never wears two names.
pub fn issue_ref(title: &str, body: &str, id: i64) -> String {
    let t = title.trim();
    if !t.is_empty() {
        return t.to_string();
    }
    let squashed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if squashed.is_empty() {
        return format!("#{id}");
    }
    if squashed.chars().count() <= ISSUE_REF_CHARS {
        return squashed;
    }
    let cut: String = squashed.chars().take(ISSUE_REF_CHARS).collect();
    format!("{}…", cut.trim_end())
}

pub fn board_list(session: &str) -> Result<Value, String> {
    with_store(|store| Ok(json!({ "issues": store.issues_list(session)?, "statuses": BOARD_STATUSES })))
}

/// Issue counts for EVERY board in one read (board #39): the Board sidebar
/// wants to show per-project column counts and hide projects with an empty
/// board, and asking `board_list` per project is an N+1 over the wire. Shape:
/// `{ "<session>": { todo, doing, review, done, total } }` — the four statuses
/// are zero-filled SERVER-side so the client never guesses the vocabulary,
/// `total` is explicit so "is this board empty" is one field, and a project
/// with NO issues is ABSENT (absence = hide, matching the issue's "如果该项目
/// 完全为空 则直接不显示" — an all-zeros row would make the client re-derive
/// emptiness the total already answers).
pub fn board_counts() -> Result<Value, String> {
    with_store(|store| {
        let mut per = serde_json::Map::new();
        for (session, status, n) in store.issue_counts()? {
            let row = per.entry(session).or_insert_with(|| {
                let mut zero = serde_json::Map::new();
                for s in BOARD_STATUSES {
                    zero.insert(s.to_string(), json!(0));
                }
                zero.insert("total".to_string(), json!(0));
                Value::Object(zero)
            });
            let obj = row.as_object_mut().expect("rows are built as objects above");
            // Only the fixed vocabulary gets a named key (writes validate
            // against BOARD_STATUSES, so anything else is a foreign row in
            // the db) — but total counts every issue the board really has.
            if BOARD_STATUSES.contains(&status.as_str()) {
                obj.insert(status, json!(n));
            }
            let t = obj.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
            obj.insert("total".to_string(), json!(t + n));
        }
        Ok(json!({ "counts": per }))
    })
}

pub fn board_get(session: &str, id: i64) -> Result<Value, String> {
    with_store(|store| {
        store
            .issue_get(session, id)?
            .ok_or_else(|| format!("no issue #{id} on this board"))
    })
}

#[allow(clippy::too_many_arguments)]
pub fn board_save(
    session: &str,
    id: Option<i64>,
    title: Option<&str>,
    body: Option<&str>,
    status: Option<&str>,
    assignee: Option<&str>,
    who: &str,
) -> Result<i64, String> {
    board_status_ok(status)?;
    let now = chrono::Utc::now().timestamp();
    with_store(|store| store.issue_save(session, id, title, body, status, assignee, who, now))
}

pub fn board_note(session: &str, id: i64, author: &str, body: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    with_store(|store| store.issue_note(session, id, author, body, now))
}

/// Board #43 P1-R1: file a NEW issue with its initial blockers in one
/// transaction: the issue and every edge, or nothing.
#[allow(clippy::too_many_arguments)]
pub fn board_create_blocked(
    session: &str,
    title: Option<&str>,
    body: Option<&str>,
    status: Option<&str>,
    assignee: Option<&str>,
    who: &str,
    blocked_by: &[i64],
) -> Result<i64, String> {
    board_status_ok(status)?;
    let now = chrono::Utc::now().timestamp();
    with_store(|store| store.issue_create_blocked(session, title, body, status, assignee, who, now, blocked_by))
}

/// Board #43: add and remove blocking edges of issue `id`; answers the
/// edges that really changed (added, removed).
pub fn board_block(session: &str, id: i64, add: &[i64], remove: &[i64]) -> Result<(Vec<i64>, Vec<i64>), String> {
    with_store(|store| store.issue_blocks_set(session, id, add, remove))
}

pub fn board_delete(session: &str, id: i64) -> Result<bool, String> {
    with_store(|store| store.issue_delete(session, id))
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::*;

    #[test]
    fn issue_ref_speaks_one_fallback_language() {
        // A real title wins, trimmed.
        assert_eq!(issue_ref("  Fix login  ", "whatever", 7), "Fix login");
        // No title → the body, squashed to one line.
        assert_eq!(issue_ref("", "the flow\n  breaks   at step 2", 7), "the flow breaks at step 2");
        // Long bodies cut on a CHAR boundary with the … marker (Unicode-safe:
        // 40 chars of CJK is 40 chars, not a split codepoint panic).
        let long = "标题可以为空".repeat(10);
        let r = issue_ref(" ", &long, 7);
        assert_eq!(r.chars().count(), ISSUE_REF_CHARS + 1, "cut + one … char");
        assert!(r.ends_with('…'));
        assert!(r.starts_with("标题可以为空"));
        // Exactly at the budget: no marker — the message is complete.
        let exact = "x".repeat(ISSUE_REF_CHARS);
        assert_eq!(issue_ref("", &exact, 7), exact);
        // Legacy all-empty → the id.
        assert_eq!(issue_ref("", "   ", 7), "#7");
    }

    #[test]
    fn board_counts_zero_fill_the_vocabulary_and_omit_empty_boards() {
        use_test_store();
        // Unique names: the store is process-wide and sequential tests leave
        // their own boards behind — this test asserts ITS sessions only.
        let sa = format!("counts-a-{}", uuid::Uuid::new_v4());
        let sb = format!("counts-b-{}", uuid::Uuid::new_v4());
        let se = format!("counts-empty-{}", uuid::Uuid::new_v4());
        let a1 = board_save(&sa, None, Some("one"), None, None, None, "human").unwrap();
        board_save(&sa, None, Some("two"), None, None, None, "human").unwrap();
        board_save(&sa, Some(a1), None, None, Some("review"), None, "human").unwrap();
        let b1 = board_save(&sb, None, Some("three"), None, None, None, "human").unwrap();
        board_save(&sb, Some(b1), None, None, Some("done"), None, "human").unwrap();

        let v = board_counts().unwrap();
        let counts = v["counts"].as_object().unwrap();
        // Cross-session: each board counts its own, in one RPC-shaped read.
        assert_eq!(counts[&sa]["todo"], 1);
        assert_eq!(counts[&sa]["review"], 1);
        assert_eq!(counts[&sb]["done"], 1);
        // All four statuses are PRESENT on every returned row (server-side
        // zero fill) and total is explicit — the client never sums or guesses.
        for s in BOARD_STATUSES {
            assert!(counts[&sa][s].is_i64(), "{s} zero-filled on a");
            assert!(counts[&sb][s].is_i64(), "{s} zero-filled on b");
        }
        assert_eq!(counts[&sa]["doing"], 0);
        assert_eq!(counts[&sa]["done"], 0);
        assert_eq!(counts[&sa]["total"], 2);
        assert_eq!(counts[&sb]["total"], 1);
        // A project whose board is EMPTY is absent — the issue's own
        // semantics ("完全为空 则直接不显示"), not an all-zeros row.
        assert!(!counts.contains_key(&se), "empty board ⇒ no key");
        // And deleting the last issue removes the row again: absence tracks
        // the LIVE state, not creation history.
        let only = board_save(&se, None, Some("transient"), None, None, None, "human").unwrap();
        assert_eq!(board_counts().unwrap()["counts"][&se]["total"], 1);
        board_delete(&se, only).unwrap();
        assert!(!board_counts().unwrap()["counts"].as_object().unwrap().contains_key(&se));
    }
}
