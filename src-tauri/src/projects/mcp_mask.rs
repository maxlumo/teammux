//! MCP secrets never leave through a definition read (board #451).
//!
//! Three read doors return MCP server definitions: `mcp_list` (the central
//! defs), `registry_list` (an agent's inline servers) and `teams_list` (a team
//! member's inline agent). `tmm` reads only through them, and so does the Hub,
//! so masking HERE is the one place a secret stops reaching an agent's context
//! (`tmm mcp list`) or a textarea. The store keeps the values; the
//! materializers read the store (`spawn::mcp_defs`), never these answers.
//!
//! The rule (reviewer + orchestrator, #451): EVERY `env` and `headers` value is
//! replaced by [`VALUE_SET`], references included — whether `$VAR` is a
//! reference depends on the backend that consumes it (a codex/kiro/claude/grok
//! env value is literal text; only dsh reads it as `process.env`), and a
//! central def has no backend. Names stay visible.
//!
//! A save restores each marker from the row AS STORED in the same store
//! section that writes it (the caller's `with_store`), by its full owner path:
//! central (server, field, key); agent (agent, server, field, key); team
//! (team, member, server, field, key). Anything ambiguous or missing is
//! refused before anything is written, and no message carries a value.

use serde_json::Value;

/// The reserved value that means "the stored value, kept". A RESERVED protocol
/// string, not a claim that no token could read so: it can never be entered as
/// a new literal (a marker with no stored value is refused), and a value that
/// is already stored as this text is kept as it is.
pub const VALUE_SET: &str = "<set>";

/// The two value maps of an MCP def (`backends::shared::McpDef`).
const FIELDS: [&str; 2] = ["env", "headers"];

/// The fixed reason a stored field that cannot be read safely is refused with.
const UNREADABLE: &str = "is not valid JSON of the expected shape";

/// WHERE a definition failed to parse, never WHAT it held. serde's message
/// quotes the offending value (`invalid type: string "<value>", expected …`),
/// and a save door answers the client (validator V1 on 60414c91), so every
/// definition parse error a door returns goes through this: line and column
/// only.
pub(crate) fn no_echo(e: &serde_json::Error) -> String {
    format!("(not the expected shape at line {}, column {})", e.line(), e.column())
}

/// One def object is readable when it IS an object and each value map it has
/// is an object. Anything else could hold a secret somewhere masking does not
/// look, so it is never listed (the whole call fails, #451 delta 2).
fn readable_def(def: &Value) -> bool {
    def.as_object().is_some_and(|o| FIELDS.iter().all(|f| o.get(*f).is_none_or(Value::is_object)))
}

/// An agent's `mcp` array: a string names a central server, an object is an
/// inline def. Anything else is unreadable.
fn readable_entries(entries: &[Value]) -> bool {
    entries.iter().all(|e| e.is_string() || readable_def(e))
}

fn mask_def(def: &mut Value) {
    for field in FIELDS {
        if let Some(map) = def.get_mut(field).and_then(Value::as_object_mut) {
            for v in map.values_mut() {
                *v = Value::String(VALUE_SET.into());
            }
        }
    }
}

fn has_marker(def: &Value) -> bool {
    FIELDS.iter().any(|f| def.get(*f).and_then(Value::as_object).is_some_and(|m| m.values().any(|v| v == VALUE_SET)))
}

fn parse_entries(text: &str) -> Option<Vec<Value>> {
    serde_json::from_str::<Vec<Value>>(text).ok().filter(|e| readable_entries(e))
}

/// A team's members, each with an optional inline `agent` whose `mcp` is JSON
/// TEXT inside the members JSON. Readable only when EVERY member is an object
/// (reviewer P1-A on 60414c91: a member wrapped in an array or encoded as a
/// string would otherwise pass through unmasked), its `agent` is absent, null
/// or an object, and that agent's mcp is readable.
fn parse_members(text: &str) -> Option<Vec<Value>> {
    let members = serde_json::from_str::<Vec<Value>>(text).ok()?;
    let ok = members.iter().all(|m| m.is_object() && match m.get("agent") {
        None | Some(Value::Null) => true,
        Some(a) => a.is_object() && match a.get("mcp") {
            None => true,
            Some(Value::String(t)) => parse_entries(t).is_some(),
            Some(_) => false,
        },
    });
    ok.then_some(members)
}

/// A server's name exactly as the materializers key it (`McpDef::name`, used
/// verbatim): no trimming, so " s " is not "s" (reviewer P2 on 60414c91).
fn server_name(def: &Value) -> &str {
    def.get("name").and_then(Value::as_str).unwrap_or("")
}

// ─── The read doors ──────────────────────────────────────────────────────────

/// A central def's stored text, masked; `Err` names the server only.
pub(crate) fn masked_central(name: &str, text: &str) -> Result<String, String> {
    let mut def: Value = serde_json::from_str(text).ok().filter(readable_def).ok_or_else(|| unreadable_central(name))?;
    mask_def(&mut def);
    Ok(def.to_string())
}

/// An agent's stored `mcp` text, masked.
pub(crate) fn masked_agent(agent: &str, text: &str) -> Result<String, String> {
    let mut entries = parse_entries(text).ok_or_else(|| unreadable_agent(agent))?;
    entries.iter_mut().filter(|e| e.is_object()).for_each(mask_def);
    Ok(Value::Array(entries).to_string())
}

/// A team's stored `members` text, every inline agent's servers masked — also
/// a member's `agent` beside a `base`, which spawn ignores but the answer
/// would still carry.
pub(crate) fn masked_team(team: &str, text: &str) -> Result<String, String> {
    let mut members = parse_members(text).ok_or_else(|| unreadable_team(team))?;
    for m in &mut members {
        let Some(agent) = m.get_mut("agent").filter(|a| a.is_object()) else { continue };
        let Some(t) = agent.get("mcp").and_then(Value::as_str) else { continue };
        let masked = masked_agent("", t).map_err(|_| unreadable_team(team))?;
        agent["mcp"] = Value::String(masked);
    }
    Ok(Value::Array(members).to_string())
}

fn unreadable_central(name: &str) -> String {
    format!("mcp server '{name}': its stored def {UNREADABLE}, so no MCP definition is listed — save it again in full (tmm mcp save --name {name} --def '…') or delete it (tmm mcp delete {name})")
}

fn unreadable_agent(agent: &str) -> String {
    format!("agent '{agent}': its stored mcp {UNREADABLE}, so no agent definition is listed — save it again with its mcp in full (tmm registry save --name {agent} … --mcp '[…]') or delete it")
}

fn unreadable_team(team: &str) -> String {
    format!("team '{team}': its stored members {UNREADABLE}, so no team is listed — save it again with its members in full (tmm teams save --name {team} --def '[…]') or delete it")
}

// ─── The save doors ──────────────────────────────────────────────────────────

/// What a save door accepts is what a read door can list: a central def that
/// is a readable object. Checked before the store is touched.
pub(crate) fn check_central(name: &str, text: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(text).ok().filter(readable_def).map(|_| ())
        .ok_or_else(|| format!("mcp server '{name}': def must be a JSON object whose env and headers are objects"))
}

/// An agent's incoming `mcp`: readable, and no two inline servers share a name
/// (every materializer keys servers by name, so a duplicate is already a
/// silently broken def — and it would make a marker ambiguous).
pub(crate) fn check_agent(path: &str, text: &str) -> Result<(), String> {
    let entries = parse_entries(text)
        .ok_or_else(|| format!("{path}: mcp must be a JSON array of server names and def objects whose env and headers are objects"))?;
    let mut seen = std::collections::BTreeSet::new();
    for e in entries.iter().filter(|e| e.is_object()) {
        let n = server_name(e);
        if !n.is_empty() && !seen.insert(n.to_string()) {
            return Err(format!("{path}: two MCP servers are named '{n}' — a server name must be unique"));
        }
    }
    Ok(())
}

/// A team's incoming members: each one an object, and each inline agent's mcp
/// passes `check_agent` — what the save accepts, the list can read.
pub(crate) fn check_team(team: &str, text: &str) -> Result<(), String> {
    let Ok(members) = serde_json::from_str::<Vec<Value>>(text) else { return Ok(()) }; // teams::validate names it
    for (i, m) in members.iter().enumerate() {
        if !m.is_object() {
            return Err(format!("team '{team}': member {} must be a JSON object", i + 1));
        }
        let Some(agent) = m.get("agent").filter(|a| !a.is_null()) else { continue };
        let path = format!("team '{team}', member '{}'", m.get("name").and_then(Value::as_str).unwrap_or(""));
        if !agent.is_object() {
            return Err(format!("{path}: agent must be a JSON object"));
        }
        match agent.get("mcp") {
            None => {}
            Some(Value::String(t)) => check_agent(&path, t)?,
            Some(_) => return Err(format!("{path}: mcp must be JSON text")),
        }
    }
    Ok(())
}

/// Put the stored value back for every marker in ONE def. `stored` is the def
/// at the same owner path as it is stored now; `None` when there is none.
fn restore_def(path: &str, incoming: &mut Value, stored: Option<&Value>) -> Result<(), String> {
    for field in FIELDS {
        let Some(map) = incoming.get_mut(field).and_then(Value::as_object_mut) else { continue };
        for (key, v) in map.iter_mut().filter(|(_, v)| *v == VALUE_SET) {
            let kept = stored.and_then(|s| s.get(field)).and_then(|m| m.get(key))
                .ok_or_else(|| format!("{path}: {field}.{key} is {VALUE_SET:?} (keep the stored value), but no value is stored there — give the value"))?;
            *v = kept.clone();
        }
    }
    Ok(())
}

/// A central def's incoming text with its markers restored from `stored` (the
/// row as stored now). Text without a marker comes back byte for byte: a full
/// replacement needs no stored read, and repairs an unreadable row.
pub(crate) fn restore_central(name: &str, incoming: &str, stored: Option<&str>) -> Result<String, String> {
    let mut def: Value = serde_json::from_str(incoming).map_err(|_| format!("mcp server '{name}': def must be a JSON object"))?;
    if !has_marker(&def) {
        return Ok(incoming.to_string());
    }
    let path = format!("mcp server '{name}'");
    let stored = match stored {
        None => None,
        Some(t) => Some(serde_json::from_str::<Value>(t).ok().filter(readable_def)
            .ok_or_else(|| format!("{path}: its stored def {UNREADABLE}, so {VALUE_SET:?} has nothing to keep — give every value"))?),
    };
    restore_def(&path, &mut def, stored.as_ref())?;
    Ok(def.to_string())
}

/// An agent's incoming `mcp` text with its markers restored from `stored`, by
/// server NAME: the one stored inline server of that name, never an index.
pub(crate) fn restore_agent(path: &str, incoming: &str, stored: Option<&str>) -> Result<String, String> {
    let Ok(mut entries) = serde_json::from_str::<Vec<Value>>(incoming) else { return Ok(incoming.to_string()) };
    if !entries.iter().any(has_marker) {
        return Ok(incoming.to_string());
    }
    let stored = match stored {
        None => Vec::new(),
        Some(t) => parse_entries(t)
            .ok_or_else(|| format!("{path}: its stored mcp {UNREADABLE}, so {VALUE_SET:?} has nothing to keep — give every value"))?,
    };
    for def in entries.iter_mut().filter(|e| has_marker(e)) {
        let name = server_name(def).to_string();
        if name.is_empty() {
            return Err(format!("{path}: an MCP server without a name cannot keep a stored value ({VALUE_SET:?}) — name it, or give the value"));
        }
        let server_path = format!("{path}, MCP server '{name}'");
        let mut same = stored.iter().filter(|s| s.is_object() && server_name(s) == name);
        let found = same.next();
        if same.next().is_some() {
            return Err(format!("{server_path}: the stored definition has more than one server of this name, so {VALUE_SET:?} is ambiguous — give every value"));
        }
        restore_def(&server_path, def, found)?;
    }
    Ok(Value::Array(entries).to_string())
}

/// A team's incoming members text with each inline agent's markers restored
/// from the SAME member (by name) of the team as stored now.
pub(crate) fn restore_team(team: &str, incoming: &str, stored: Option<&str>) -> Result<String, String> {
    let Ok(mut members) = serde_json::from_str::<Vec<Value>>(incoming) else { return Ok(incoming.to_string()) };
    let marked = |m: &Value| m.get("agent").and_then(|a| a.get("mcp")).and_then(Value::as_str)
        .and_then(|t| serde_json::from_str::<Vec<Value>>(t).ok())
        .is_some_and(|e| e.iter().any(has_marker));
    if !members.iter().any(marked) {
        return Ok(incoming.to_string());
    }
    let stored = match stored {
        None => Vec::new(),
        Some(t) => parse_members(t)
            .ok_or_else(|| format!("team '{team}': its stored members {UNREADABLE}, so {VALUE_SET:?} has nothing to keep — give every value"))?,
    };
    let member_name = |m: &Value| m.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    for m in members.iter_mut().filter(|m| marked(m)) {
        let name = member_name(m);
        let path = format!("team '{team}', member '{name}'");
        let mut same = stored.iter().filter(|s| member_name(s) == name);
        let found = same.next();
        if same.next().is_some() {
            return Err(format!("{path}: the stored team has more than one member of this name, so {VALUE_SET:?} is ambiguous — give every value"));
        }
        let stored_mcp = found.and_then(|s| s.get("agent")).and_then(|a| a.get("mcp")).and_then(Value::as_str);
        let text = m["agent"]["mcp"].as_str().unwrap_or("[]").to_string();
        m["agent"]["mcp"] = Value::String(restore_agent(&path, &text, stored_mcp)?);
    }
    Ok(Value::Array(members).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const S: &str = "SENTINEL-451-value";

    #[test]
    fn every_env_and_header_value_is_masked_references_included() {
        // The reviewer's table (P1-A): a literal that looks like a reference,
        // real references, a Bearer reference, mixed text, an invalid name,
        // an empty value — all masked, in both maps; names and the rest stay.
        let values = ["$LiteralPassword", "${VAR}", "$VAR", "Bearer $TOKEN", "pre-$VAR", "${VAR:-x}", "$1abc", "", S];
        let map: serde_json::Map<String, Value> = values.iter().enumerate().map(|(i, v)| (format!("K{i}"), json!(v))).collect();
        let def = json!({ "command": "srv", "args": ["--x"], "env": map, "headers": map }).to_string();
        let out = masked_central("s", &def).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for field in FIELDS {
            for i in 0..values.len() {
                assert_eq!(v[field][format!("K{i}")], VALUE_SET, "{field}.K{i} is masked");
            }
        }
        assert_eq!(v["command"], "srv");
        assert_eq!(v["args"], json!(["--x"]), "args are not filtered (#451 scope)");
        assert!(!out.contains(S) && !out.contains("LiteralPassword") && !out.contains("TOKEN"));
    }

    #[test]
    fn an_unreadable_stored_field_lists_nothing_and_says_no_value() {
        for bad in [format!("{{\"env\":\"{S}\"}}"), format!("[\"{S}\"]"), format!("not json {S}"), format!("{{\"headers\":[\"{S}\"]}}")] {
            let e = masked_central("s", &bad).unwrap_err();
            assert!(!e.contains(S) && e.contains("mcp server 's'"), "{e}");
        }
        for bad in [format!("[{{\"name\":\"a\",\"env\":\"{S}\"}}]"), format!("[42, \"{S}\"]"), format!("{{\"{S}\":1}}")] {
            let e = masked_agent("x", &bad).unwrap_err();
            assert!(!e.contains(S) && e.contains("agent 'x'"), "{e}");
        }
        let inner = format!("[{{\"name\":\"a\",\"env\":\"{S}\"}}]");
        let bad = json!([{ "name": "m", "agent": { "name": "", "backend": "kiro", "mcp": inner } }]).to_string();
        let e = masked_team("t", &bad).unwrap_err();
        assert!(!e.contains(S) && e.contains("team 't'"), "{e}");
        // A member that is not an object (P1-A on 60414c91) is unreadable too,
        // whatever it carries: wrapped in an array, encoded as a string, null, a scalar.
        let member = json!({ "name": "m", "agent": { "name": "", "backend": "kiro", "mcp": json!([{ "name": "a", "env": { "K": S } }]).to_string() } });
        for bad in [json!([[member.clone()]]), json!([member.to_string()]), json!([member.clone(), null]), json!([5])] {
            let e = masked_team("t", &bad.to_string()).unwrap_err();
            assert!(!e.contains(S) && e.contains("team 't'"), "{bad}: {e}");
            assert!(check_team("t", &bad.to_string()).is_err(), "the save door refuses what the list cannot read: {bad}");
        }
    }

    #[test]
    fn a_team_masks_every_inline_agent_including_one_beside_a_base() {
        let mcp = json!([{ "name": "a", "command": "c", "env": { "K": S } }, "central"]).to_string();
        let members = json!([
            { "name": "bare", "agent": { "name": "", "backend": "kiro", "mcp": mcp } },
            { "name": "based", "base": "b", "agent": { "name": "", "backend": "kiro", "mcp": mcp } },
            { "name": "plain", "base": "b" },
            { "team": "sub", "role": "r" },
        ]).to_string();
        let out = masked_team("t", &members).unwrap();
        assert!(!out.contains(S), "{out}");
        let v: Vec<Value> = serde_json::from_str(&out).unwrap();
        let inner: Vec<Value> = serde_json::from_str(v[1]["agent"]["mcp"].as_str().unwrap()).unwrap();
        assert_eq!(inner[0]["env"]["K"], VALUE_SET);
        assert_eq!(inner[1], "central", "a central name stays as it is");
    }

    #[test]
    fn a_marker_takes_the_value_stored_now_by_its_full_path() {
        // Listed while the key was OLD, rotated to NEW by another save, then
        // the listed def saved back: the marker keeps NEW (P1-B).
        let listed = masked_central("s", &json!({ "command": "c", "env": { "K": "OLD", "E": "x" }, "headers": { "K": "H" } }).to_string()).unwrap();
        let rotated = json!({ "command": "c", "env": { "K": "NEW", "E": "x" }, "headers": { "K": "H" } }).to_string();
        let v: Value = serde_json::from_str(&restore_central("s", &listed, Some(&rotated)).unwrap()).unwrap();
        assert_eq!(v["env"]["K"], "NEW");
        assert_eq!(v["headers"]["K"], "H", "env and headers are separate fields with the same key");
    }

    #[test]
    fn a_save_without_a_marker_is_byte_for_byte_and_repairs_an_unreadable_row() {
        let text = "{ \"command\": \"c\",  \"env\": {\"K\": \"v\"} }";
        assert_eq!(restore_central("s", text, Some("not json")).unwrap(), text);
        let mcp = r#"[ {"name":"a","env":{"K":"v"}} ]"#;
        assert_eq!(restore_agent("agent 'x'", mcp, Some("garbage")).unwrap(), mcp);
    }

    #[test]
    fn a_marker_with_nothing_to_keep_is_refused_naming_the_path_only() {
        let incoming = json!({ "command": "c", "env": { "K": VALUE_SET } }).to_string();
        let stored = json!({ "command": "c", "env": { "OTHER": S } }).to_string();
        for stored in [None, Some(stored.as_str()), Some("not json")] {
            let e = restore_central("s", &incoming, stored).unwrap_err();
            assert!(e.contains("mcp server 's'") && !e.contains(S), "{e}");
        }
        // A literal "<set>" for a brand-new key is the same refusal: the
        // marker is reserved, never a new value.
        assert!(restore_central("new", &incoming, None).is_err());
    }

    #[test]
    fn an_agent_marker_is_matched_by_server_name_never_by_index() {
        let stored = json!([{ "name": "b", "env": { "K": "B" } }, { "name": "a", "env": { "K": "A" } }]).to_string();
        let incoming = json!([{ "name": "a", "env": { "K": VALUE_SET } }, { "name": "b", "env": { "K": VALUE_SET } }]).to_string();
        let v: Vec<Value> = serde_json::from_str(&restore_agent("agent 'x'", &incoming, Some(&stored)).unwrap()).unwrap();
        assert_eq!((v[0]["env"]["K"].as_str(), v[1]["env"]["K"].as_str()), (Some("A"), Some("B")));
        // A renamed server finds nothing; an unnamed one cannot be matched;
        // duplicates in the stored row are ambiguous.
        let renamed = json!([{ "name": "c", "env": { "K": VALUE_SET } }]).to_string();
        assert!(restore_agent("agent 'x'", &renamed, Some(&stored)).is_err());
        // The name is the materializers' key, verbatim: " a " is another
        // server, not "a" (P2 on 60414c91), so it keeps nothing of "a"'s.
        let spaced = json!([{ "name": " a ", "env": { "K": VALUE_SET } }]).to_string();
        assert!(restore_agent("agent 'x'", &spaced, Some(&stored)).unwrap_err().contains("MCP server ' a '"));
        let unnamed = json!([{ "env": { "K": VALUE_SET } }]).to_string();
        assert!(restore_agent("agent 'x'", &unnamed, Some(&stored)).unwrap_err().contains("without a name"));
        let dup = json!([{ "name": "a", "env": { "K": S } }, { "name": "a", "env": { "K": S } }]).to_string();
        let e = restore_agent("agent 'x'", &json!([{ "name": "a", "env": { "K": VALUE_SET } }]).to_string(), Some(&dup)).unwrap_err();
        assert!(e.contains("ambiguous") && !e.contains(S), "{e}");
        assert!(check_agent("agent 'x'", &dup).unwrap_err().contains("two MCP servers are named 'a'"));
    }

    #[test]
    fn a_team_marker_comes_from_the_same_member_only() {
        let mcp = |v: &str| json!([{ "name": "s", "env": { "K": v } }]).to_string();
        let stored = json!([
            { "name": "one", "agent": { "name": "", "backend": "kiro", "mcp": mcp("ONE") } },
            { "name": "two", "agent": { "name": "", "backend": "kiro", "mcp": mcp("TWO") } },
        ]).to_string();
        let listed = masked_team("t", &stored).unwrap();
        let back: Vec<Value> = serde_json::from_str(&restore_team("t", &listed, Some(&stored)).unwrap()).unwrap();
        let k = |i: usize| serde_json::from_str::<Vec<Value>>(back[i]["agent"]["mcp"].as_str().unwrap()).unwrap()[0]["env"]["K"].clone();
        assert_eq!((k(0), k(1)), (json!("ONE"), json!("TWO")));
        let renamed = listed.replace("\"two\"", "\"three\"");
        assert!(restore_team("t", &renamed, Some(&stored)).unwrap_err().contains("member 'three'"));
    }
}
