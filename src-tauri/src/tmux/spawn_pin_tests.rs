//! Board #140 (leader's ruling, note 3): a detached std::thread in non-test src-tauri that
//! reaches tmux starts through `tmux::spawn_bound` or passes an explicit socket, so a new
//! watcher cannot go back to the process global by omission. Whether a thread reaches tmux
//! is a call-graph question a source scan cannot answer, so the pin is an ALLOW-LIST: every
//! bare `std::thread::spawn` / `thread::Builder` in PRODUCTION code is listed here with why it
//! may stay bare; a new one, anywhere, fails until it is `spawn_bound` or listed with its reason.
//! The pin FAILS CLOSED (leader's ruling 26, replacing 13 and 21: a source test cannot classify
//! Rust without a parser, and two rounds went into the holes of a hand-written lexer). It
//! excludes only what is unmistakable: (i) test files by name (`*_tests.rs`), and (ii) a test
//! MODULE in the one standard shape: a line that is exactly `#[cfg(test)]` or
//! `#[cfg(all(test, …))]`, directly followed by a `mod NAME {` line (any visibility) at the same
//! indentation, up to the first later line that is exactly `}` at that indentation. Everything
//! else counts as production, a cfg(test) fn, use, static or impl included, so a mistake of this
//! scan is a false RED on the tree, seen at once, never a hidden production spawn. Accepted
//! limit: text shaped exactly like (ii) inside a string or a block comment; the pin guards
//! against omission in this repository's code, it is not a parser.
use std::collections::BTreeMap;
use std::path::Path;

/// file (relative to src-tauri/src) → (bare spawns allowed, why it cannot reach tmux through
/// the global, read by its call graph; board #140 round 1).
const ALLOWED: &[(&str, usize, &str)] = &[
    ("tmux.rs", 1, "spawn_bound itself: the one bound spawn"),
    ("probe.rs", 1, "run_status_as's pipe reader: read_to_string on the child's pipe, then a channel send; nothing else"),
    ("gateway/mod.rs", 1, "stamp_fd's job: stamp_stream copies a pipe to a fd with a chrono timestamp; nothing else"),
    ("backends/dsh.rs", 1, "TEST code (dsh's test module, a stand-in's reader thread at the module's end), counted because a JS fixture inside a raw string has a lone '}' line at column 0, which ends the scan's exclusion early: the accepted limit, failing closed"),
    ("projects/mod.rs", 2, "TEST code (projects' test module, two threads racing open_once), counted because a comment sits between its #[cfg(test)] and its 'pub(crate) mod tests {', which is not the standard shape: failing closed"),
    ("lib.rs", 1, "the embedded gateway's runtime thread: it IS the gateway; the server's start sets the process global from inside it (server/mod.rs set_socket) and the set_socket RPC changes it later, so a binding would pin it to the pre-start value and override both"),
];

/// `src` without its standard test modules (rule (ii) above); every other line is kept.
fn production(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(end) = standard_test_module(&lines, i) {
            i = end + 1;
            continue;
        }
        out.push_str(lines[i]);
        out.push('\n');
        i += 1;
    }
    out
}

/// The index of the closing `}` line when `lines[at]` opens a standard test module.
fn standard_test_module(lines: &[&str], at: usize) -> Option<usize> {
    let attr = lines[at];
    let indent = &attr[..attr.len() - attr.trim_start().len()];
    let a = attr.trim();
    if !(a == "#[cfg(test)]" || (a.starts_with("#[cfg(all(test,") && a.ends_with(")]"))) { return None; }
    let m = lines.get(at + 1)?;
    let rest = m.strip_prefix(indent)?;
    if rest.starts_with(char::is_whitespace) { return None; }
    let rest = rest.strip_prefix("pub(crate) ").or_else(|| rest.strip_prefix("pub(super) ")).or_else(|| rest.strip_prefix("pub ")).unwrap_or(rest);
    let name = rest.strip_prefix("mod ")?.strip_suffix(" {")?;
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') { return None; }
    let close = format!("{indent}}}");
    (at + 2..lines.len()).find(|&k| lines[k] == close)
}

fn bare_spawns_in(src: &str) -> usize {
    production(src).lines().filter(|l| !l.trim_start().starts_with("//") && (l.contains("thread::spawn(") || l.contains("thread::Builder::new("))).count()
}

fn bare_spawns(dir: &Path, root: &Path, out: &mut BTreeMap<String, usize>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() { bare_spawns(&p, root, out); continue; }
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".rs") || name.ends_with("_tests.rs") { continue; }
        let n = bare_spawns_in(&std::fs::read_to_string(&p).unwrap());
        if n > 0 { out.insert(p.strip_prefix(root).unwrap().to_string_lossy().to_string(), n); }
    }
}

#[test]
fn every_bare_detached_thread_is_listed_with_why_it_needs_no_bound_socket() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = BTreeMap::new();
    bare_spawns(&root, &root, &mut found);
    let allowed: BTreeMap<String, usize> = ALLOWED.iter().map(|(f, n, _)| (f.to_string(), *n)).collect();
    assert_eq!(found, allowed, "a detached thread that reaches tmux starts through tmux::spawn_bound (board #140); one that cannot reach tmux is listed in ALLOWED with its reason");
}

/// The ruling's controls (note 26): the production spawn after each form counts; a spawn
/// inside a standard test module does not; anything not in that shape counts (fail closed).
#[test]
fn the_pin_fails_closed() {
    let prod = "fn prod() { std::thread::spawn(|| {}); }\n";
    let after: &[(&str, &str)] = &[
        ("a one-line helper", "#[cfg(test)]\nfn helper() {}\n"),
        ("a commented use", "#[cfg(test)]\nuse std::thread; // helper import\n"),
        ("an inline extra attribute", "#[cfg(test)]\n#[allow(dead_code)] fn helper() {}\n"),
        ("a same-line sibling", "#[cfg(test)] fn helper() {} "),
        ("a same-line module", "#[cfg(test)] mod tests {} "),
        ("nested block comments", "#[cfg(test)]\nfn helper() { /* outer /* inner */ { */ }\n"),
        ("a standard test module before it", "#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n"),
    ];
    for (what, before) in after {
        assert_eq!(bare_spawns_in(&format!("{before}{prod}")), 1, "{what}: the production spawn after it counts");
    }
    let inside = "#[cfg(test)]\npub(crate) mod parked_child {\n    fn spawn() { std::thread::spawn(|| {}); }\n    mod inner {\n        fn b() {}\n    }\n}\n";
    assert_eq!(bare_spawns_in(inside), 0, "a spawn inside a standard test module is not production");
    let all = "#[cfg(all(test, not(target_os = \"android\")))]\nmod t {\n    fn s() { std::thread::spawn(|| {}); }\n}\n";
    assert_eq!(bare_spawns_in(all), 0, "the cfg(all(test, …)) form too");
    assert_eq!(bare_spawns_in("#[cfg(test)]\nfn helper() { std::thread::spawn(|| {}); }\n"), 1, "a cfg(test) fn outside a module counts");
    assert_eq!(bare_spawns_in("#[cfg(test)]\n#[allow(unused)]\nmod t {\n    fn s() { std::thread::spawn(|| {}); }\n}\n"), 1, "a module in another shape counts");
    let literal = "#[cfg(test)]\nmod t {\n    const S: &str = r\"\n}\n\";\n    fn s() { std::thread::spawn(|| {}); }\n}\n";
    assert_eq!(bare_spawns_in(literal), 1, "a literal's '}}' line at the module's indentation ends the exclusion there, and what follows counts (fail closed)");
}
