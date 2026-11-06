const MCP_MASKED: &str = "mcp_masked";

/// `rpc` for a call that only an up-to-date server can do (board #377): the
/// login answer's `caps` is read BEFORE the call is sent, so a server that
/// lacks `need` is refused with nothing written. Without this a `tmm board
/// assign` against an older gateway would save a label no agent is ever told
/// about and print a success line.
/// What a write needing `need` says when the server's login lacks it (board
/// #377; #382 for `spawn_join`): what it cannot do, how to get it, and that
/// nothing was written.
fn cap_refusal(need: &str) -> String {
    match need {
