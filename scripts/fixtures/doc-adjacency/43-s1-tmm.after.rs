const MCP_MASKED: &str = "mcp_masked";

/// `rpc` for a call that only an up-to-date server can do (board #377): the
/// login answer's `caps` is read BEFORE the call is sent, so a server that
/// lacks `need` is refused with nothing written. Without this a `tmm board
/// assign` against an older gateway would save a label no agent is ever told
/// about and print a success line.
/// What a write needing `need` says when the server's login lacks it (board
/// #377; #382 for `spawn_join`): what it cannot do, how to get it, and that
/// nothing was written.
/// The list row's tail for an issue that is still blocked (board #43):
/// ` · blocked by #38`. An issue whose blockers are all done says nothing.
fn blocked_note(issue: &Value) -> String {
    if issue.get("blocked").and_then(|v| v.as_bool()) != Some(true) {
        return String::new();
    }
    let list = issue.get("blocked_by").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|n| n.as_i64()).map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    format!(" · blocked by {list}")
}

/// A list of issue numbers as typed: `38`, `#38`, `38,39` (board #43).
/// Anything else, or nothing, is a usage error naming the expected shape.
fn issue_numbers(raw: &str, verb: &str) -> Vec<i64> {
    let parsed: Option<Vec<i64>> = raw
        .split(',')
        .map(|t| t.trim().trim_start_matches('#').parse::<i64>().ok().filter(|n| *n > 0))
        .collect();
    match parsed {
        Some(v) if !v.is_empty() => v,
        _ => fail(EXIT_USAGE, &format!("{verb} needs issue numbers like 38 or 38,39 — got {raw:?}")),
    }
}

fn cap_refusal(need: &str) -> String {
    match need {
