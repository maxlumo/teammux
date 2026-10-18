//! Declarative projects: a workspace you can close and reopen.
//!
//! A project is a directory plus the windows it is made of. The declaration
//! lives in `state.db`; the tmux session is a disposable projection of it. See
//! `docs/exec-plans/projects-and-tasks.md` for the product design and
//! `docs/design-docs/features/projects.md` for what is implemented.
//!
//! Desktop-only: the phone is a client of a desktop server, so nothing here
//! would ever run on Android/iOS.
//!
//! This file is the FACADE (board #152): the module tree, the one store
//! handle (`with_store` / `open_once`), the id helpers, and explicit
//! re-exports so every `projects::X` a caller names keeps working. The
//! families live in their own files — `projects` (the verbs), `managed`
//! (identity), `registry`, `board`, `skills` (resolution + central assets),
//! `rooms` (messages + archive), `capture` (the tick) — and a function that
//! lands here instead of in its family is what the guard test at the bottom
//! rejects.

pub mod agents;
pub mod board;
pub mod capture;
pub mod delivery;
pub mod live_config;
pub mod global_prompt;
pub mod managed;
pub mod models;
pub mod projects;
pub(crate) mod recipe;
pub mod reconcile;
pub mod recovery;
pub mod registry;
pub mod restore;
pub mod rooms;
pub mod scratch;
pub(crate) mod skills;
pub mod spawn;
pub mod stalls;
pub mod store;
pub mod teams;
pub mod telemetry;
pub mod vitals;
pub mod wakes;

// Every path a caller names stays `projects::X` (board #152).
pub use board::{BOARD_STATUSES, ISSUE_REF_CHARS, board_counts, board_delete, board_get, board_list, board_note, board_save, issue_ref};
pub use rooms::{archive_msg, archived_ids, archived_msgs, unarchive_msgs};
pub use registry::{global_prompt_get, global_prompt_set, registry_delete, registry_get, registry_list, registry_save, registry_set_model_effort, team_get, teams_delete, teams_list, teams_save};
pub(crate) use registry::{with_registry_mcp, with_registry_skills};
pub use managed::{agent_remove, deliver_chat_line, is_managed_in, joined_team, managed_home, member_of, spawned_by, team_of};
pub use skills::{managed_skills_dir, mcp_delete, mcp_list, mcp_save, seed_builtin_skills, skill_delete, skill_file, skill_files, skill_import, skill_load, skill_read, skill_refresh, skill_save, skills_list};
pub use capture::{SESSION_SETTLE_SECS, capture_loop, capture_once};
pub use projects::{Refused, adopt, auto_adopt_once, create, delete, down, list, mark_agent_stopped, project_for_session, close_window, record_session_kill, rename, set_archived, set_autostart, start_permit, up, up_agent, StartPermit};

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use store::{Project, Slot, Store};

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `state.db` next to the rest of the app's state. `TMM_STATE_DB` overrides it,
/// which is how the tests get an isolated database (and how a second profile on
/// one machine could get its own).
pub(super) fn db_path() -> PathBuf {
    match std::env::var_os("TMM_STATE_DB") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => crate::config::config_dir().join("state.db"),
    }
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

/// Where agent conversation ids come from, installed once by the server (the
/// notification hub). Unset in tests and on a server without hooks, in which
/// case restored agents fall back to a directory-scoped resume.
static SESSIONS: OnceLock<std::sync::Arc<dyn capture::AgentSessions + Send + Sync>> =
    OnceLock::new();

pub fn set_agent_sessions(sessions: std::sync::Arc<dyn capture::AgentSessions + Send + Sync>) {
    let _ = SESSIONS.set(sessions);
}

fn agent_sessions() -> &'static (dyn capture::AgentSessions + Send + Sync) {
    match SESSIONS.get() {
        Some(s) => s.as_ref(),
        None => &capture::NoSessions,
    }
}

/// Run `f` against the process-wide store, opening it on first use. Errors are
/// returned rather than panicking so a broken database degrades to "the
/// Projects page is unavailable" instead of taking the server down.
fn with_store<T>(f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let cell = open_once(&STORE, || Store::open(&db_path()))?;
    #[cfg(test)]
    tests::STORE_WAITING.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let locked = cell.lock();
    #[cfg(test)]
    tests::STORE_WAITING.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    let mut guard = locked.map_err(|_| "state.db lock poisoned".to_string())?;
    #[cfg(test)]
    let _section = tests::Section::enter();
    f(&mut guard)
}


/// First use opens the store; every later use finds it. Exactly ONE caller
/// opens (board #150): the cold path is serialised by `OPENING`, and a caller
/// that waited re-reads the cell before opening — with the bare
/// `open → OnceLock::set` shape two first callers both ran the migration
/// ladder on the same file (reproduced in the #149 probe), and the ladder's
/// rebuild steps (deliveries v20/v21 DROP+RENAME) are not safe to run twice at
/// once. A failed open is NOT cached (`get_or_init` would have to cache it):
/// the next caller tries again, so a database that was unavailable for a
/// moment does not take the Projects page down for the process.
fn open_once<'a>(
    cell: &'a OnceLock<Mutex<Store>>,
    open: impl FnOnce() -> Result<Store, String>,
) -> Result<&'a Mutex<Store>, String> {
    static OPENING: Mutex<()> = Mutex::new(());
    if let Some(c) = cell.get() {
        return Ok(c);
    }
    let _opening = OPENING.lock().map_err(|_| "state.db init lock poisoned".to_string())?;
    if let Some(c) = cell.get() {
        return Ok(c);
    }
    let store = open()?;
    let _ = cell.set(Mutex::new(store));
    cell.get().ok_or_else(|| "state.db unavailable".to_string())
}

// ---- ids and names ------------------------------------------------------

/// Deterministic short digest (FNV-1a) so a path always maps to the same id.
fn digest(s: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:06x}", hash & 0xff_ffff)
}

/// tmux-safe, readable component of a name: no dots or colons (tmux target
/// syntax), no spaces, bounded length.
fn slug(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let bounded: String = trimmed.chars().take(24).collect();
    if bounded.is_empty() {
        "project".to_string()
    } else {
        bounded.to_lowercase()
    }
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

fn canonical(path: &str) -> Result<String, String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", tmux::home_dir(), rest)
    } else {
        path.to_string()
    };
    let p = std::fs::canonicalize(&expanded).map_err(|e| format!("{expanded}: {e}"))?;
    if !p.is_dir() {
        return Err(format!("{} is not a directory", p.display()));
    }
    Ok(p.to_string_lossy().to_string())
}

use crate::tmux;

#[cfg(test)]
// pub(crate): `use_test_store` must be reachable from tests in OTHER module
// trees (server/hub_rpc). STORE is a OnceLock — whichever test opens it first
// decides the path for the whole process, so a test that reaches the store
// without pointing it at a throwaway db can send every later test's writes into
// the user's real state.db.
pub(crate) mod tests {
    use super::*;

    /// Threads between asking for the store and holding it (tests observe this
    /// instead of sleeping, to know a caller is really waiting on a holder).
    pub(crate) static STORE_WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// The store section this thread is inside, if any (board #415 round 4):
    /// every `with_store` that holds the store gets a fresh number, so a test
    /// can tell "inside a section" and "the SAME section" without timing.
    pub(crate) fn current_section() -> Option<u64> {
        SECTION.with(|s| s.get())
    }

    thread_local! {
        static SECTION: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    }

    /// Marks this thread inside a store section until dropped (also on a
    /// panic), restoring whatever it was before.
    pub(crate) struct Section(Option<u64>);

    impl Section {
        pub(crate) fn enter() -> Section {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Section(SECTION.with(|s| s.replace(Some(id))))
        }
    }

    impl Drop for Section {
        fn drop(&mut self) {
            SECTION.with(|s| s.set(self.0));
        }
    }

    /// Point the process-wide store at a throwaway database, wiped once per
    /// test process. `STORE` is a `OnceLock`, so every test that touches it must
    /// go through here — the first opener decides the path for the whole run.
    /// pub(crate): spawn's tests reach the store through mcp_defs/
    /// resolve_skill_refs (central-asset resolution), and skipping this once
    /// pointed the WHOLE test process at the user's real state.db.
    pub(crate) fn use_test_store() {
        static TEST_DB: OnceLock<()> = OnceLock::new();
        TEST_DB.get_or_init(|| {
            // A child test process (a fresh-process test, board #249) is
            // handed its parent's scratch database and must not wipe it.
            if let Some(child) = std::env::var_os("TMM_TEST_CHILD_DB").filter(|p| !p.is_empty()) {
                std::env::set_var("TMM_STATE_DB", child);
                return;
            }
            // Per process, and earlier runs' dirs reclaimed (board #268): a
            // shared dir was wiped by a concurrent run.
            let dir = crate::config::fresh_process_dir("tmm-projects-test");
            std::env::set_var("TMM_STATE_DB", dir.join("state.db"));
        });
    }

    /// The restore intents in the test store (board #422), for tests in other
    /// module trees that cannot reach `with_store`.
    pub(crate) fn restore_intents() -> store::RestoreIntents {
        with_store(|s| s.restore_intents()).unwrap()
    }

    /// Forget one agent's Stop mark in the test store (board #422).
    pub(crate) fn forget_stop(id: &str, window: &str) {
        with_store(|s| s.forget_slot_stopped(id, window)).unwrap()
    }

    #[test]
    fn slugs_are_tmux_safe_and_bounded() {
        assert_eq!(slug("my.project"), "my-project");
        assert_eq!(slug("Web App!"), "web-app");
        assert_eq!(slug("---"), "project");
        assert_eq!(slug("a".repeat(40).as_str()).len(), 24);
        assert!(!slug("a:b.c").contains(':'));
    }

    #[test]
    fn digest_is_stable_and_path_specific() {
        assert_eq!(digest("/w/app"), digest("/w/app"));
        assert_ne!(digest("/w/app"), digest("/w/app2"));
        assert_eq!(digest("/w/app").len(), 6);
    }

    #[test]
    fn basename_handles_trailing_slashes() {
        assert_eq!(basename("/w/app"), "app");
        assert_eq!(basename("/w/app/"), "app");
        assert_eq!(basename("app"), "app");
    }

    /// architecture.md Must: never hold the store lock while observing tmux
    /// (board #149; the capture tick once queued every RPC behind a tmux walk,
    /// 2026-09-03, and adopt/list did the same in smaller doses — measured here:
    /// an adopt held the lock 90 ms, a list ~9 ms per project). Every
    /// `with_store(|…| …)` closure in this file must be SQLite only. The one
    /// deliberate exception carries `// store-lock(tmux-ok):` with its reason
    /// (rename keeps the session rename and the row re-key under one lock).
    #[test]
    fn no_tmux_work_runs_under_the_store_lock() {
        // Every file of the projects family (board #152 moved the closures out
        // of mod.rs; the rule follows them), production text only.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/projects");
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "rs")).collect();
        files.sort();
        let mut checked = 0;
        let mut bad = Vec::new();
        for path in &files {
            let src = std::fs::read_to_string(path).unwrap();
            let prod = match src.find("\n#[cfg(test)]\n") { Some(k) => &src[..k], None => &src[..] };
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let mut at = 0;
            while let Some(k) = prod[at..].find("with_store(|") {
                let start = at + k;
                let mut depth = 0i32;
                let mut end = start + "with_store".len();
                for (off, c) in prod[start + "with_store".len()..].char_indices() {
                    depth += (c == '(') as i32 - (c == ')') as i32;
                    if depth == 0 {
                        end = start + "with_store".len() + off + 1;
                        break;
                    }
                }
                let body = &prod[start..end];
                checked += 1;
                let touches_tmux = ["tmux::", "observe(", "session_workspace("].iter().any(|t| body.contains(t));
                if touches_tmux && !body.contains("// store-lock(tmux-ok):") {
                    let line = prod[..start].matches('\n').count() + 1;
                    bad.push(format!("{name}:{line}"));
                }
                at = end;
            }
        }
        assert!(checked >= 40, "scan found only {checked} with_store closures");
        assert!(bad.is_empty(), "tmux work under the store lock at {bad:?}");
    }

    /// Two threads first-calling a cold store together must produce ONE open:
    /// the migration ladder has rebuild steps (deliveries v20/v21 DROP+RENAME)
    /// that are not safe to run twice at once (board #150; reproduced in #149's
    /// probe as "migrate to 1: table projects already exists"). The open here
    /// is slow on purpose so both callers are inside the cold window.
    #[test]
    fn a_cold_store_is_opened_exactly_once_under_a_race() {
        static CELL: OnceLock<Mutex<Store>> = OnceLock::new();
        static OPENS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let slow_open = || {
            OPENS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(80));
            Store::open_memory()
        };
        let a = std::thread::spawn(move || open_once(&CELL, slow_open).map(|_| ()));
        let b = std::thread::spawn(move || open_once(&CELL, slow_open).map(|_| ()));
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
        assert_eq!(OPENS.load(std::sync::atomic::Ordering::SeqCst), 1, "both first callers opened (and would have migrated) the store");
    }

    /// The facade holds the module tree, the store handle and the id helpers
    /// — nothing else (board #152). A family verb that lands here instead of
    /// in projects/managed/registry/board/skills/rooms/capture is the drift the
    /// split exists to stop; the line cap is the second tripwire.
    #[test]
    fn the_projects_facade_holds_only_the_store_handle_and_id_helpers() {
        let src = include_str!("mod.rs");
        let body = &src[..src.find("\n#[cfg(test)]\n").unwrap()];
        let fns: Vec<&str> = body
            .lines()
            .filter_map(|l| {
                let t = l.strip_prefix("pub ").or(l.strip_prefix("pub(crate) ")).or(l.strip_prefix("pub(super) ")).unwrap_or(l);
                t.strip_prefix("fn ").map(|rest| rest.split(['(', '<']).next().unwrap_or(rest))
            })
            .collect();
        assert_eq!(
            fns,
            ["now", "db_path", "set_agent_sessions", "agent_sessions", "with_store", "open_once", "digest", "slug", "basename", "canonical"],
            "a family function is back in the facade"
        );
        let lines = body.lines().count();
        assert!(lines <= 200, "projects/mod.rs grew to {lines} lines before its tests; it is the facade only");
    }
}
