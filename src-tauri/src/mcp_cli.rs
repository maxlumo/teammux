//! `tmm mcp` — ONE MCP door for every agent (owner, 2026-08-28: "可以不用各种
//! agent 内部的 mcp 工具调用了，可以用 MCP Inspector CLI 来统一来做").
//!
//! Instead of materializing MCP servers into each backend's NATIVE config
//! (kiro agents/<name>.json, claude mcp.json, codex `-c` overrides, grok
//! config.toml — four dialects, loaded once at CLI start, so adding a server
//! meant restarting the agent), agents call tools through the MCP Inspector
//! CLI, which connects per call, invokes one method, prints, and exits:
//!
//!   tmm mcp servers                        # who is configured
//!   tmm mcp tools [<server>]               # tools/list
//!   tmm mcp call <server> <tool> [k=v ...] # tools/call
//!
//! The config is a STANDARD mcp.json (`{"mcpServers": {...}}`) at
//! `<workspace>/.tmm/mcp.json` — the agent can edit it, and because the
//! inspector reads it per call, a new server is live on the NEXT call with no
//! restart. `spawn` seeds it from the registry defs and points the agent at it
//! via $TMM_MCP_CONFIG; without the env var we walk up from cwd like git does.
//!
//! The inspector itself is named by $TMM_MCP_CLI (the same pattern that makes
//! tmm findable via PATH), defaulting to `npx -y @modelcontextprotocol/inspector
//! --cli`. This module is LOCAL like `tmm task`: no server socket, dispatched
//! before `Config::load()`.

use std::path::{Path, PathBuf};

/// Default inspector invocation when $TMM_MCP_CLI is unset.
pub const DEFAULT_INSPECTOR: &str = "npx -y @modelcontextprotocol/inspector --cli";

/// Walk up from `start` looking for `.tmm/mcp.json` — the config belongs to
/// the WORKSPACE, and an agent may be deep inside it when it calls.
pub fn find_config(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let candidate = d.join(".tmm").join("mcp.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

/// $TMM_MCP_CONFIG beats the walk-up: spawn sets it, so a managed agent finds
/// its project's config from ANY cwd.
pub fn resolve_config(env_val: Option<String>, cwd: &Path) -> Option<PathBuf> {
    match env_val.filter(|s| !s.trim().is_empty()) {
        Some(p) => Some(PathBuf::from(p)),
        None => find_config(cwd),
    }
}

/// The inspector command as an argv. Whitespace-split is deliberate: the value
/// is a COMMAND LINE ("npx -y @modelcontextprotocol/inspector --cli"), not a
/// single path, and none of its realistic components carry spaces.
///
/// The DEFAULT prefers an installed `mcp-inspector` binary and only falls back
/// to `npx -y`: npx re-resolves against the registry EVERY run, which measured
/// 12s of a 15s call on this host — the whole call drops to ~3s with the
/// binary (2026-08-28). `npm i -g @modelcontextprotocol/inspector` is the
/// one-time fix the fallback exists to survive without.
pub fn inspector_argv(env_val: Option<String>) -> Vec<String> {
    if let Some(line) = env_val.filter(|s| !s.trim().is_empty()) {
        return line.split_whitespace().map(|s| s.to_string()).collect();
    }
    if path_has("mcp-inspector") {
        return vec!["mcp-inspector".into(), "--cli".into()];
    }
    DEFAULT_INSPECTOR.split_whitespace().map(|s| s.to_string()).collect()
}

/// Is `bin` an executable file on $PATH?
fn path_has(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&paths).any(|d| {
        let p = d.join(bin);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            p.is_file()
        }
    })
}

/// Server names out of a standard mcp.json, sorted for stable output.
pub fn server_names(text: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut names: Vec<String> = v
        .get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Inspector arguments for one method against one config-named server.
/// `kv` entries are passed through as repeated `--tool-arg` (the inspector
/// JSON-coerces values itself); `args_json` becomes `--tool-args-json`.
pub fn method_args(
    config: &Path,
    server: &str,
    method: &str,
    tool: Option<&str>,
    kv: &[String],
    args_json: Option<&str>,
) -> Vec<String> {
    let mut a = vec![
        "--config".into(),
        config.to_string_lossy().to_string(),
        "--server".into(),
        server.to_string(),
        "--method".into(),
        method.to_string(),
    ];
    if let Some(t) = tool {
        a.push("--tool-name".into());
        a.push(t.to_string());
    }
    if let Some(j) = args_json {
        a.push("--tool-args-json".into());
        a.push(j.to_string());
    } else {
        for pair in kv {
            a.push("--tool-arg".into());
            a.push(pair.clone());
        }
    }
    a
}

/// PROGRESSIVE discovery (owner, 2026-08-28: "渐进式加载…避免一次性加载太多
/// 上下文，有点像 toolsearch"): the tools listing an agent reads by default is
/// ONE LINE PER TOOL — name and first sentence of the description — never the
/// schemas, which for a big server are pages of JSON nobody asked for yet.
/// The schema of ONE tool is its own tier (`tool_schema`), read just before a
/// call. Input is the inspector's `--format json` output for `tools/list`.
pub fn compact_tools(json_text: &str) -> Vec<(String, String)> {
    let v: serde_json::Value = match serde_json::from_str(json_text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    // The CLI prints either the raw result or an envelope with `.result`.
    let tools = v
        .get("tools")
        .or_else(|| v.get("result").and_then(|r| r.get("tools")))
        .and_then(|t| t.as_array());
    tools
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name")?.as_str()?.to_string();
                    let desc = t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some((name, desc))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The full record of ONE tool (schema included) out of a tools/list result —
/// the second discovery tier, read only when the agent has picked its tool.
pub fn tool_schema(json_text: &str, tool: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(json_text).ok()?;
    let tools = v
        .get("tools")
        .or_else(|| v.get("result").and_then(|r| r.get("tools")))?
        .as_array()?;
    tools.iter().find(|t| t.get("name").and_then(|n| n.as_str()) == Some(tool)).cloned()
}

/// A `key=value` shape check BEFORE the inspector sees it: a stray positional
/// ("weather" instead of "city=weather") would otherwise surface as the
/// inspector's own usage error, which names flags the agent never typed.
pub fn is_kv(s: &str) -> bool {
    match s.split_once('=') {
        Some((k, _)) => !k.trim().is_empty(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_config_walks_up() {
        let root = crate::config::test_scratch("mcpcli-test");
        let deep = root.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(root.join(".tmm")).unwrap();
        std::fs::write(root.join(".tmm").join("mcp.json"), "{}").unwrap();
        let found = find_config(&deep).expect("walk up finds it");
        assert_eq!(found, root.join(".tmm").join("mcp.json"));
        assert!(find_config(Path::new("/nonexistent-mcpcli")).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn env_var_beats_walk_up() {
        let cwd = Path::new("/tmp");
        assert_eq!(
            resolve_config(Some("/x/mcp.json".into()), cwd),
            Some(PathBuf::from("/x/mcp.json"))
        );
        // Empty env value falls through to the walk-up, never to "".
        assert_eq!(resolve_config(Some("  ".into()), Path::new("/nonexistent-mcpcli")), None);
    }

    #[test]
    fn inspector_default_and_override() {
        // The default is environment-dependent (an installed binary wins over
        // npx), but it is always one of the two known shapes and the OVERRIDE
        // is always verbatim.
        let d = inspector_argv(None);
        assert!(
            d == vec!["mcp-inspector".to_string(), "--cli".into()]
                || d == vec!["npx".to_string(), "-y".into(), "@modelcontextprotocol/inspector".into(), "--cli".into()],
            "{d:?}"
        );
        assert_eq!(inspector_argv(Some("my-inspector --cli --flag".into())), vec!["my-inspector", "--cli", "--flag"]);
        assert_eq!(inspector_argv(Some("  ".into())), inspector_argv(None)); // blank = default
    }

    #[test]
    fn server_names_from_config() {
        let names = server_names(r#"{"mcpServers":{"zeta":{},"alpha":{"command":"x"}}}"#);
        assert_eq!(names, vec!["alpha", "zeta"]);
        assert!(server_names("not json").is_empty());
        assert!(server_names("{}").is_empty());
    }

    #[test]
    fn call_args_shape() {
        let a = method_args(
            Path::new("/w/.tmm/mcp.json"),
            "files",
            "tools/call",
            Some("read_file"),
            &["path=/tmp/x".into(), "count=2".into()],
            None,
        );
        assert_eq!(
            a,
            vec![
                "--config", "/w/.tmm/mcp.json", "--server", "files",
                "--method", "tools/call", "--tool-name", "read_file",
                "--tool-arg", "path=/tmp/x", "--tool-arg", "count=2",
            ]
        );
        // JSON args replace k=v entirely (the inspector rejects both at once).
        let b = method_args(Path::new("/c"), "s", "tools/call", Some("t"), &["ignored=1".into()], Some(r#"{"a":1}"#));
        assert!(b.contains(&"--tool-args-json".to_string()));
        assert!(!b.contains(&"--tool-arg".to_string()));
        // tools/list carries no tool flags.
        let c = method_args(Path::new("/c"), "s", "tools/list", None, &[], None);
        assert!(!c.iter().any(|x| x.starts_with("--tool")));
    }

    #[test]
    fn compact_listing_is_one_line_per_tool() {
        let out = r#"{"tools":[
            {"name":"echo","description":"Echoes back the input string\nSecond line nobody needs","inputSchema":{"type":"object","properties":{"message":{"type":"string"}}}},
            {"name":"add","inputSchema":{}}
        ]}"#;
        let c = compact_tools(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], ("echo".into(), "Echoes back the input string".into()));
        assert_eq!(c[1].1, ""); // no description stays empty, not invented
        // The `.result` envelope form parses too.
        let env = r#"{"result":{"tools":[{"name":"x"}]}}"#;
        assert_eq!(compact_tools(env)[0].0, "x");
        assert!(compact_tools("nope").is_empty());
    }

    #[test]
    fn one_tool_schema_tier() {
        let out = r#"{"tools":[{"name":"echo","inputSchema":{"required":["message"]}}]}"#;
        let t = tool_schema(out, "echo").unwrap();
        assert_eq!(t["inputSchema"]["required"][0], "message");
        assert!(tool_schema(out, "missing").is_none());
    }

    #[test]
    fn kv_shape() {
        assert!(is_kv("city=Boston"));
        assert!(is_kv("q=a=b")); // value may contain '='
        assert!(!is_kv("Boston"));
        assert!(!is_kv("=x"));
    }
}
