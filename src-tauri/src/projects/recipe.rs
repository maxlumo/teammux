//! An agent's launch recipe (`<home>/launch.json`) is ONE record per agent
//! home with ONE read-modify-write door (board #384, reviewer P1-C and the
//! orchestrator's ruling): every production path that reads the recipe in
//! order to write it back goes through `update_recipe` (or, already inside
//! the section, `update_in`), with the read INSIDE the per-home section:
//!
//!   - a spawn / team spawn / fork: `spawn::materialize` → `LaunchRecipe::write`
//!     (a fresh home too: the write is the door, not an exception);
//!   - a restart's `spawn::refresh_agent`, which holds the section from its
//!     read of the recipe through registry/team resolution, model validation
//!     and the backend's materialize (skills, config files) to the write;
//!   - a runtime team move, `spawn::set_agent_team`;
//!   - `refresh_hooks` → kiro's `reconcile_recipe_engine`,
//!     `migrate_launch_model` and the pre-recipe backfill.
//!
//! Without it, a writer that read the recipe before a team move and wrote its
//! whole snapshot back after would undo the move while the room says it
//! happened. Every writer PRESERVES the fields it does not own (`team`,
//! `team_rev`, anything a later feature adds): it changes the keys it owns in
//! the recipe it read, it never rewrites the JSON from a struct of its own.
//!
//! The section is per HOME: one agent's restart does not hold up another's.
//! It is a leaf: a holder never takes another home's section. A writer is
//! atomic (temp file + rename), so a reader that takes no section (a relaunch
//! line, the roster's backend, `team_of`) never sees half a recipe.
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

/// A set of keys, each held by at most one thread at a time.
struct Table {
    held: Mutex<BTreeSet<PathBuf>>,
    freed: Condvar,
    /// Keys a thread is blocked on right now, so a test observes "waiting"
    /// instead of sleeping and hoping.
    #[cfg(test)]
    waiting: Mutex<Vec<PathBuf>>,
}

impl Table {
    const fn new() -> Self {
        Table {
            held: Mutex::new(BTreeSet::new()),
            freed: Condvar::new(),
            #[cfg(test)]
            waiting: Mutex::new(Vec::new()),
        }
    }
}

/// The same home spelled twice (a trailing slash, a `.`) is one key.
fn key(home: &Path) -> PathBuf {
    home.components().collect()
}

/// One held key; released on drop. A poisoned table is still a table.
pub(crate) struct Held {
    table: &'static Table,
    key: PathBuf,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut held = self.table.held.lock().unwrap_or_else(|e| e.into_inner());
        held.remove(&self.key);
        self.table.freed.notify_all();
    }
}

fn enter(table: &'static Table, home: &Path) -> Held {
    let key = key(home);
    let mut held = table.held.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(test)]
    let mut registered = false;
    while held.contains(&key) {
        #[cfg(test)]
        if !registered {
            table.waiting.lock().unwrap_or_else(|e| e.into_inner()).push(key.clone());
            registered = true;
        }
        held = table.freed.wait(held).unwrap_or_else(|e| e.into_inner());
    }
    #[cfg(test)]
    if registered {
        let mut waiting = table.waiting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = waiting.iter().position(|k| *k == key) { waiting.remove(i); }
    }
    held.insert(key.clone());
    Held { table, key }
}

static RECIPES: Table = Table::new();
static ANNOUNCEMENTS: Table = Table::new();

/// How many threads are blocked on `home`'s recipe section now (tests).
#[cfg(test)]
pub(crate) fn recipe_waiters(home: &Path) -> usize {
    let key = key(home);
    RECIPES.waiting.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|k| **k == key).count()
}

/// Proof that the caller holds `home`'s recipe section: the only way to
/// read-for-write or write a recipe.
pub(crate) struct RecipeSection {
    home: PathBuf,
    _held: Held,
}

/// Enter `home`'s recipe section (blocks while another holder has it).
pub(crate) fn recipe_section(home: &Path) -> RecipeSection {
    RecipeSection { _held: enter(&RECIPES, home), home: home.to_path_buf() }
}

impl RecipeSection {
    /// Whether this section is `home`'s.
    pub(crate) fn is_for(&self, home: &Path) -> bool {
        key(&self.home) == key(home)
    }

    /// The recipe as it is now: `None` when there is none, `Err` when there
    /// is one that does not parse (never overwritten by an update).
    pub(crate) fn read(&self) -> Result<Option<Value>, String> {
        let path = self.home.join("launch.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("launch recipe {} is not readable: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read launch recipe {}: {e}", path.display())),
        }
    }

    fn write(&self, recipe: &Value) -> Result<(), String> {
        let path = self.home.join("launch.json");
        let tmp = self.home.join("launch.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(recipe).unwrap())
            .and_then(|_| std::fs::rename(&tmp, &path))
            .map_err(|e| format!("write launch recipe {}: {e}", path.display()))
    }
}

/// THE door: enter `home`'s section, read its recipe, let `apply` change it
/// (`None` = there is none yet; setting it creates one), and write it whole
/// if it changed. `apply`'s answer is returned; a recipe that does not parse
/// is an error and `apply` is not called.
pub(crate) fn update_recipe<R>(home: &Path, apply: impl FnOnce(&mut Option<Value>) -> R) -> Result<R, String> {
    let section = recipe_section(home);
    update_in(&section, apply)
}

/// `update_recipe` for a caller already inside the section (a restart's
/// `refresh_agent` → `materialize`): the mutex is not reentrant.
pub(crate) fn update_in<R>(section: &RecipeSection, apply: impl FnOnce(&mut Option<Value>) -> R) -> Result<R, String> {
    let before = section.read()?;
    let mut recipe = before.clone();
    let out = apply(&mut recipe);
    if recipe != before {
        if let Some(r) = &recipe {
            section.write(r)?;
        }
    }
    Ok(out)
}

/// The runtime membership revision a recipe records (board #384, P1-B): 0
/// before the first move; every `set_agent_team` that changes the team adds
/// one. A move's notices carry the revision they announce.
pub(crate) fn team_rev(recipe: &Value) -> u64 {
    recipe.get("team_rev").and_then(Value::as_u64).unwrap_or(0)
}

/// `home`'s current revision, read without the section (the write is
/// atomic): what a move's announcement checks before each notice.
pub(crate) fn current_team_rev(home: &Path) -> u64 {
    std::fs::read_to_string(home.join("launch.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|r| team_rev(&r))
        .unwrap_or(0)
}

/// What has been TOLD about an agent's team (board #384, P1-B residual): the
/// announcer's ledger, kept in the agent's recipe as `team_told`. It records
/// only what was announced, never who is in a team: membership is the
/// recipe's `team`, and nothing reads this to decide it.
///
/// `mover` is the team the agent itself was last told it is in ('' =
/// standalone); `members` is every recipient who was last told "this agent is
/// your teammate", with the team root it was told for. A recipient enters on
/// a delivered (typed or held) join notice and leaves on a delivered "left"
/// notice, so a fan-out cut short leaves the rest as they were and the next
/// announcement covers them.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Told {
    pub mover: String,
    pub members: std::collections::BTreeMap<String, String>,
}

impl Told {
    pub(crate) fn of(recipe: &Value) -> Option<Told> {
        let t = recipe.get("team_told")?;
        let mover = t.get("mover").and_then(Value::as_str).unwrap_or("").to_string();
        let members = t.get("members").and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        Some(Told { mover, members })
    }

    pub(crate) fn to_value(&self) -> Value {
        serde_json::json!({ "mover": self.mover, "members": self.members })
    }
}

/// What one announcement says, computed from FACTS (the ruling): `told`
/// against the agent's CURRENT team and that team's live members now.
#[derive(Debug, PartialEq)]
pub(crate) struct Plan {
    /// (recipient, the team it was told) to tell "the agent left your team".
    pub left: Vec<(String, String)>,
    /// Recipients to tell "the agent joined your team".
    pub joined: Vec<String>,
    /// Whether the agent is told its current team (it was last told another).
    pub mover: bool,
}

/// The difference between what was told and what is true. Pure.
pub(crate) fn plan(told: &Told, team: &str, members_now: &[String]) -> Plan {
    let left = told.members.iter()
        .filter(|(r, t)| team.is_empty() || t.as_str() != team || !members_now.contains(r))
        .map(|(r, t)| (r.clone(), t.clone()))
        .collect();
    let joined = if team.is_empty() { Vec::new() } else {
        members_now.iter().filter(|r| told.members.get(*r).map(String::as_str) != Some(team)).cloned().collect()
    };
    Plan { left, joined, mover: told.mover != team }
}

/// One agent's move announcements, one at a time and in the order their
/// revisions were committed (board #384, P1-B): the room line and the typed
/// notices of one move are told before the next move of the SAME agent is,
/// and each is skipped once a newer revision exists. Separate from the recipe
/// section, which is never held across the slow multi-pane delivery.
pub(crate) fn announcement(home: &Path) -> Held {
    enter(&ANNOUNCEMENTS, home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    fn home() -> PathBuf {
        let h = std::env::temp_dir().join(format!("tmm-recipe-{}", uuid::Uuid::new_v4())).join(".tmm/agents/dev");
        std::fs::create_dir_all(&h).unwrap();
        h
    }
    fn read(h: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(h.join("launch.json")).unwrap()).unwrap()
    }

    #[test]
    fn the_door_creates_changes_and_leaves_alone() {
        let h = home();
        assert_eq!(update_recipe(&h, |r| r.is_none()).unwrap(), true, "none yet");
        update_recipe(&h, |r| *r = Some(json!({ "cmd": "a", "team": "squad", "team_rev": 3 }))).unwrap();
        update_recipe(&h, |r| r.as_mut().unwrap()["cmd"] = json!("b")).unwrap();
        assert_eq!(read(&h), json!({ "cmd": "b", "team": "squad", "team_rev": 3 }), "a writer keeps the fields it does not own");
        let before = std::fs::metadata(h.join("launch.json")).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        update_recipe(&h, |_| ()).unwrap();
        assert_eq!(std::fs::metadata(h.join("launch.json")).unwrap().modified().unwrap(), before, "no change, no write");
        assert!(!h.join("launch.json.tmp").exists());
        std::fs::write(h.join("launch.json"), "{ half").unwrap();
        let mut called = false;
        assert!(update_recipe(&h, |_| called = true).unwrap_err().contains("not readable"));
        assert!(!called, "a recipe that does not parse is never overwritten");
        let _ = std::fs::remove_dir_all(h.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// The reviewer's P1-C shape, on the door itself: a writer paused AFTER
    /// its read (inside the section) and a second writer of another field.
    /// The second waits; both changes survive.
    #[test]
    fn a_writer_paused_after_its_read_does_not_undo_another() {
        let h = home();
        update_recipe(&h, |r| *r = Some(json!({ "cmd": "kiro-cli chat --model m", "team": "" }))).unwrap();
        let read_done = Arc::new(Barrier::new(2));
        let (go, resume) = mpsc::channel::<()>();
        let migration = {
            let (h, read_done) = (h.clone(), read_done.clone());
            std::thread::spawn(move || update_recipe(&h, |r| {
                read_done.wait();
                resume.recv().unwrap();
                r.as_mut().unwrap()["cmd"] = json!("kiro-cli chat");
            }).unwrap())
        };
        read_done.wait();
        let mover = { let h = h.clone(); std::thread::spawn(move || update_recipe(&h, |r| r.as_mut().unwrap()["team"] = json!("squad")).unwrap()) };
        std::thread::sleep(Duration::from_millis(150));
        assert!(!mover.is_finished(), "the second writer waits for the section");
        go.send(()).unwrap();
        migration.join().unwrap();
        mover.join().unwrap();
        assert_eq!(read(&h), json!({ "cmd": "kiro-cli chat", "team": "squad" }), "the migration and the move both survive");
        let _ = std::fs::remove_dir_all(h.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// The plan is the difference between what was told and what is true:
    /// A -> B -> C tells A "left", C "joined", the mover once, B nothing;
    /// A -> B -> A tells nobody anything; a recipient a cut-short fan-out
    /// never reached is still owed its notice.
    #[test]
    fn an_announcement_says_exactly_what_changed_since_the_last_one() {
        let told = |mover: &str, m: &[(&str, &str)]| Told { mover: mover.into(), members: m.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let a = told("A", &[("a1", "A"), ("a2", "A")]);
        assert_eq!(plan(&a, "C", &names(&["c1"])), Plan { left: vec![("a1".into(), "A".into()), ("a2".into(), "A".into())], joined: names(&["c1"]), mover: true });
        assert_eq!(plan(&a, "A", &names(&["a1", "a2"])), Plan { left: vec![], joined: vec![], mover: false }, "back where it was told: nothing");
        assert_eq!(plan(&a, "", &[]), Plan { left: vec![("a1".into(), "A".into()), ("a2".into(), "A".into())], joined: vec![], mover: true });
        let half = told("C", &[("a2", "A"), ("c1", "C")]);
        assert_eq!(plan(&half, "C", &names(&["c1", "c2"])), Plan { left: vec![("a2".into(), "A".into())], joined: names(&["c2"]), mover: false }, "the untold rest of a cut-short fan-out");
        assert_eq!(plan(&told("A", &[("a1", "A")]), "A", &names(&["a1", "a3"])), Plan { left: vec![], joined: names(&["a3"]), mover: false }, "a member who arrived since is told");
        // Validator R2 (board #388): a recipient told under A who is now a
        // live member of C was told the agent is in A: it hears it left A
        // AND that it joined C (only `t != team` separates this case).
        assert_eq!(plan(&told("A", &[("x", "A")]), "C", &names(&["x"])), Plan { left: vec![("x".into(), "A".into())], joined: names(&["x"]), mover: true });
        let v = a.to_value();
        assert_eq!(Told::of(&json!({ "team_told": v })), Some(a));
        assert_eq!(Told::of(&json!({})), None, "no ledger yet: the caller seeds it from the recipe");
    }

    #[test]
    fn the_section_is_per_home() {
        let (a, b) = (home(), home());
        let held = recipe_section(&a);
        assert!(held.is_for(&a.join(".")) && !held.is_for(&b));
        let other = { let b = b.clone(); std::thread::spawn(move || update_recipe(&b, |r| *r = Some(json!({}))).unwrap()) };
        std::thread::sleep(Duration::from_millis(100));
        assert!(other.is_finished(), "another agent's home is not held up");
        let same = { let a = a.join("."); std::thread::spawn(move || update_recipe(&a, |r| *r = Some(json!({}))).unwrap()) };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!same.is_finished(), "the same home, spelled otherwise, is");
        drop(held);
        same.join().unwrap();
        other.join().unwrap();
        for h in [a, b] { let _ = std::fs::remove_dir_all(h.parent().unwrap().parent().unwrap().parent().unwrap()); }
    }
}

/// The source pin behind the door (board #384, P1-C): outside this file, no
/// PRODUCTION code writes a recipe itself. Test modules are cut out by brace
/// matching (strings and comments skipped), and every remaining line that
/// names `launch.json` must not also write, rename or create a file. A new
/// writer has to go through `update_recipe` / `update_in`.
#[cfg(test)]
mod door_pin {
    /// `src` without its `#[cfg(test)]` / `#[cfg(all(test, …))]` modules.
    pub(super) fn production(src: &str) -> String {
        let b = src.as_bytes();
        let mut out = String::new();
        let mut i = 0;
        while i < b.len() {
            let rest = &src[i..];
            if rest.starts_with("#[cfg(test)]") || rest.starts_with("#[cfg(all(test") {
                let attr_end = rest.find(']').map(|e| i + e + 1).unwrap_or(b.len());
                let after = src[attr_end..].trim_start();
                if after.starts_with("mod ") {
                    if let Some(open) = src[attr_end..].find('{') {
                        i = skip_block(src, attr_end + open);
                        continue;
                    }
                }
            }
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
        out
    }

    /// The index after the `}` that closes the `{` at `open`.
    fn skip_block(src: &str, open: usize) -> usize {
        let b = src.as_bytes();
        let (mut depth, mut i) = (0usize, open);
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => { while i < b.len() && b[i] != b'\n' { i += 1; } continue; }
                b'"' => {
                    i += 1;
                    while i < b.len() && b[i] != b'"' { if b[i] == b'\\' { i += 1; } i += 1; }
                }
                b'r' if b.get(i + 1) == Some(&b'#') && b.get(i + 2) == Some(&b'"') => {
                    i += 3;
                    while i + 1 < b.len() && !(b[i] == b'"' && b[i + 1] == b'#') { i += 1; }
                    i += 1;
                }
                b'\'' if b.get(i + 2) == Some(&b'\'') || (b.get(i + 1) == Some(&b'\\') && b.get(i + 3) == Some(&b'\'')) => {
                    i += if b.get(i + 1) == Some(&b'\\') { 3 } else { 2 };
                }
                b'{' => depth += 1,
                b'}' => { depth -= 1; if depth == 0 { return i + 1; } }
                _ => {}
            }
            i += 1;
        }
        b.len()
    }

    const WRITES: [&str; 5] = ["fs::write", "rename(", "File::create", "OpenOptions", "fs::copy"];

    /// The production lines of `src` that write a recipe themselves: a write
    /// on a line naming `launch.json`, or a write through a name bound to it
    /// (`let recipe_path = home.join("launch.json");` … `fs::write(&recipe_path`).
    pub(super) fn raw_writers(src: &str) -> Vec<String> {
        let prod = production(src);
        let lines: Vec<&str> = prod.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
        let bound: Vec<String> = lines.iter()
            .filter(|l| l.contains("launch.json"))
            .filter_map(|l| l.trim_start().strip_prefix("let "))
            .map(|l| l.trim_start_matches("mut ").split(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap_or("").to_string())
            .filter(|n| !n.is_empty())
            .collect();
        // A write's arguments may wrap onto the next lines.
        (0..lines.len())
            .filter(|&i| WRITES.iter().any(|w| lines[i].contains(w)))
            .map(|i| lines[i..(i + 3).min(lines.len())].iter().map(|l| l.trim()).collect::<Vec<_>>().join(" "))
            .filter(|call| call.contains("launch.json") || bound.iter().any(|n| call.contains(&format!("&{n}")) || call.contains(&format!("({n}")) || call.contains(&format!(" {n},"))))
            .collect()
    }

    #[test]
    fn the_pin_cuts_test_modules_and_finds_a_raw_writer() {
        let src = "fn real(h: &Path) { std::fs::write(h.join(\"launch.json\"), \"{\").ok(); }\n#[cfg(test)]\nmod tests {\n    fn t() { let s = \"}\"; std::fs::write(h.join(\"launch.json\"), s); }\n}\nfn after() { let _ = '{'; }\n";
        assert_eq!(raw_writers(src).len(), 1, "the production writer, not the test's");
        assert!(production(src).contains("fn after()"), "code after a test module is still production");
        assert!(raw_writers("// std::fs::write(h.join(\"launch.json\"))\nfn ok() {}").is_empty(), "a comment is not a writer");
        let bound = "fn m(home: &Path) {\n    let recipe_path = home.join(\"launch.json\");\n    let t = std::fs::read_to_string(&recipe_path);\n    std::fs::write(&recipe_path, t).ok();\n}\n";
        assert_eq!(raw_writers(bound).len(), 1, "a write through a name bound to the recipe path");
        let wrapped = "fn m(home: &Path) {\n    let recipe_path = home.join(\"launch.json\");\n    let ok = std::fs::write(\n        &recipe_path,\n        \"{}\",\n    );\n}\n";
        assert_eq!(raw_writers(wrapped).len(), 1, "a write whose arguments wrap");
    }

    #[test]
    fn no_production_code_writes_a_recipe_but_the_door() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root.clone()];
        let mut found = Vec::new();
        let mut scanned = 0;
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); continue; }
                if p.extension().and_then(|x| x.to_str()) != Some("rs") || p.ends_with("projects/recipe.rs") { continue; }
                scanned += 1;
                for line in raw_writers(&std::fs::read_to_string(&p).unwrap()) {
                    found.push(format!("{}: {line}", p.strip_prefix(&root).unwrap().display()));
                }
            }
        }
        assert!(scanned > 40, "scanned the crate ({scanned} files)");
        assert!(found.is_empty(), "a recipe written outside the door: {found:#?}");
    }
}
