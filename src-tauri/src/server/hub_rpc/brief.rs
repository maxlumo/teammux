//! The board hand-off's brief (boards #377, #42, #120): the ONE composer of
//! what an assignment types into the assignee's pane, in its two forms (the
//! whole issue the first time a name holds it, a pointer after), and the one
//! derivation of "has held it before" from the stored `brief` rows. Moved out
//! of hub_rpc.rs whole (#120 round 2, code-quality.md § 2); the hand-off
//! handler (`board_save`) and the router there call it.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The characters of note thread a hand-off may carry (board #42). The whole
/// original title and body ride in full; only the discussion under the issue
/// gets a budget, so a long thread — or ONE giant note — can never inject an
/// unbounded wall of text into the agent's pane.
pub(super) const ASSIGN_NOTES_BUDGET: usize = 1200;
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
pub(super) fn board_assign_notes(id: i64, notes: &[serde_json::Value], budget: usize) -> String {
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
pub(super) fn board_assign_brief(id: i64, issue: &serde_json::Value, who: &str, name: &str) -> String {
    use crate::address::unaddressed;

    let title = brief_title(id, issue);
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
    format!("{}{} {BRIEF_VERB}: {title}{body}{notes}\n{}", brief_head(name, id), unaddressed(who), brief_take(id))
}

/// The brief's head and verb (board #120): written HERE only.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn brief_head(name: &str, id: i64) -> String {
    format!("@{name} [board #{id}] ")
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) const BRIEF_VERB: &str = "assigned this to you";
/// The kind the hand-off row is stored as (board #120, leader's ruling, note
/// 27): a RECORD of what the server wrote, read and routed as an ordinary
/// message everywhere. "Has held it" is the issue's own `issue_handoffs`
/// (note 37), never derived from these rows.
// The team-context router that also reads it is dead code on the phone.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub(super) const BRIEF_KIND: &str = "brief";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn brief_take(id: i64) -> String {
    format!("Please `tmm board take {id}` to start, note findings on it, move to review when done.")
}

/// A titleless issue is named by its id: its body already rides in full.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn brief_title(id: i64, issue: &serde_json::Value) -> String {
    let title = issue["title"].as_str().unwrap_or("").trim();
    if title.is_empty() { format!("#{id}") } else { crate::address::unaddressed(title) }
}


/// The hand-off to an agent that has held the issue before (board #120,
/// owner 2026-11-12: "不用重复发送相同的内容"): the title, how many notes came
/// since its last brief (`since`, ms) and those notes alone, under the same
/// budget and cut rule, then the take line. The body is not repeated: the
/// agent has it, and `tmm board show` has it again.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(super) fn board_assign_pointer(id: i64, issue: &serde_json::Value, who: &str, name: &str, since: i64) -> String {
    // A note's `at` is in seconds: one written in the brief's own second may
    // be shown once more, none is missed.
    let floor = since.div_euclid(1000);
    let fresh: Vec<serde_json::Value> = issue["notes"]
        .as_array()
        .map(|n| n.iter().filter(|n| n["at"].as_i64().unwrap_or(0) >= floor).cloned().collect())
        .unwrap_or_default();
    let count = match fresh.len() {
        1 => "1 new note".to_string(),
        k => format!("{k} new notes"),
    };
    format!(
        "{}{} {BRIEF_VERB} again: {} — {count} since you last held it — `tmm board show {id}`{}\n{}",
        brief_head(name, id),
        crate::address::unaddressed(who),
        brief_title(id, issue),
        board_assign_notes(id, &fresh, ASSIGN_NOTES_BUDGET),
        brief_take(id)
    )
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    /// Board #120 (owner 2026-11-12): an agent that has held the issue gets a
    /// POINTER: the title, the count of notes since its last brief and only
    /// those, the take line; never the body again.
    #[test]
    fn a_later_hand_off_is_a_pointer_with_only_the_newer_notes() {
        let issue = serde_json::json!({
            "title": "Fix the delivery to @all", "body": "THE WHOLE BODY TEXT", "notes": [
                { "author": "lead", "body": "old note, already seen", "at": 10 },
                { "author": "qa", "body": "newer: ask @reviewer", "at": 30 },
                { "author": "human", "body": "in the brief s own second", "at": 20 },
            ],
        });
        let p = super::board_assign_pointer(7, &issue, "lead", "dev", 20_500);
        assert!(p.starts_with("@dev [board #7] lead assigned this to you again: Fix the delivery to ＠all — 2 new notes since you last held it — `tmm board show 7`"), "{p}");
        assert!(!p.contains("THE WHOLE BODY TEXT"), "no body: {p}");
        assert!(!p.contains("old note"), "only notes since the last hand-off: {p}");
        assert!(p.contains("\n\nNotes (2):\n- human: in the brief s own second\n- qa: newer: ask ＠reviewer\n"), "same-second note shown once more, never missed; chronological: {p}");
        assert!(p.ends_with("Please `tmm board take 7` to start, note findings on it, move to review when done."), "take LAST: {p}");
        assert_eq!(crate::address::mention_names(&p), vec!["dev".to_string()], "{p}");
        // Nothing new: the count says so and no notes block follows.
        let quiet = super::board_assign_pointer(7, &issue, "lead", "dev", 31_000);
        assert_eq!(quiet, "@dev [board #7] lead assigned this to you again: Fix the delivery to ＠all — 0 new notes since you last held it — `tmm board show 7`\nPlease `tmm board take 7` to start, note findings on it, move to review when done.");
        // The same budget and cut rule as the first brief.
        let long = serde_json::json!({ "title": "T", "body": "B", "notes": [
            { "author": "a", "body": "n".repeat(700), "at": 5 }, { "author": "b", "body": "n".repeat(700), "at": 6 }, { "author": "c", "body": "unreached", "at": 7 },
        ] });
        let cut = super::board_assign_pointer(7, &long, "lead", "dev", 1_000);
        assert!(cut.contains("— 3 new notes since") && cut.contains("\n… +1 more — `tmm board show 7`\nPlease") && !cut.contains("unreached"), "{cut}");
    }

    /// Board #120: a `brief` row is a record of what the server wrote, and it
    /// routes as a message does (Team background, the reply edge's input).
    #[test]
    fn a_brief_row_routes_as_a_message() {
        let rows = vec![serde_json::json!({ "kind": super::BRIEF_KIND, "from": "lead", "body": "@a_b [board #7] lead assigned this to you: T.", "to": ["a_b"], "id": "x", "seq": 1, "ts": 1 })];
        assert_eq!(super::super::route_chat_history(&rows, &["a_b".to_string()]).len(), 1, "a brief is routed like a msg");
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
}
