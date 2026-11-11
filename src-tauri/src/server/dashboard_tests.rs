//! Board #108: the dashboard read on a seeded store and a real roster. Real tmux, a real managed home, and
//! the fake codex of `exited_hold_tests` (it paints codex's ready line and
//! prints `SUBMIT:<line>` for each Enter; Ctrl-C exits it to the shell).

use super::hub_rpc::handle_hub_request;
use super::test_util::req;
use serde_json::{json, Value};

struct Teardown(String, std::path::PathBuf);
impl Drop for Teardown {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

const FAKE_CODEX: &str = "\
import os, sys, time, tty
tty.setraw(0)
time.sleep(0.5)
sys.stdout.write('Ask Codex to do anything\\r\\n'); sys.stdout.flush()
buf = b''
while True:
    c = os.read(0, 1)
    if c == b'\\x03':
        sys.exit(0)
    if c == b'\\r':
        sys.stdout.write('SUBMIT:' + buf.decode('utf-8', 'replace') + '\\r\\n'); sys.stdout.flush()
        buf = b''
    else:
        buf += c
";

struct Rig {
    session: String,
    ws: std::path::PathBuf,
    target: String,
    cmd: String,
    _teardown: Teardown,
}

impl Rig {
    /// A managed codex window `dev` whose fake CLI is running and ready.
    fn start(tag: &str) -> Option<Rig> {
        crate::projects::tests::use_test_store();
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("tmm-{tag}-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch(&format!("tmm-{tag}-ws"));
        let fake = ws.join("codex.py");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(&fake, FAKE_CODEX).unwrap();
        let cmd = format!("python3 {}", fake.display());
        Self::make_home(&ws, &cmd);
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "200", "-y", "50", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "bash --norc --noprofile"])
            .status()
            .is_ok_and(|s| s.success());
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return None;
        }
        let rig = Rig { target: format!("{session}:dev"), _teardown: Teardown(session.clone(), ws.clone()), session, ws, cmd };
        crate::tmux::new_named_window(&rig.session, "keep", &rig.ws.to_string_lossy()).unwrap();
        crate::projects::adopt(&rig.session, Some(tag)).expect("adopt project");
        crate::tmux::send_command(&rig.target, &rig.cmd).unwrap();
        assert!(wait(&|| rig.agent() == Some("codex") && rig.screen().contains("Ask Codex"), 10000), "the fake codex runs: {:?}", rig.screen());
        Some(rig)
    }
    fn make_home(ws: &std::path::Path, cmd: &str) {
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
    }
    fn screen(&self) -> String {
        crate::tmux::capture_pane_plain(&self.target, Some(200)).unwrap_or_default()
    }
    fn agent(&self) -> Option<&'static str> {
        crate::tmux::list_panes(&self.session).unwrap_or_default().into_iter().find(|p| p.window_name == "dev").and_then(|p| p.agent)
    }
    fn submits(&self, needle: &str) -> usize {
        self.screen().lines().filter(|l| l.starts_with("SUBMIT:") && l.contains(needle)).count()
    }
    fn call(&self, method: &str, mut params: Value) -> Result<Value, String> {
        params["session"] = json!(self.session);
        let r = handle_hub_request(&req(method, params), None);
        match r.error {
            Some(e) => Err(e.message),
            None => Ok(r.result.unwrap_or(Value::Null)),
        }
    }
    #[allow(dead_code)]
    fn ask(&self, from: &str) -> Result<i64, String> {
        let r = self.call("hub_ask", json!({ "from": from, "question": "Which layout?", "options": [{ "key": "A", "label": "own row" }, { "key": "B", "label": "disk to the card" }], "recommend": "A" }))?;
        Ok(r["ask"]["seq"].as_i64().unwrap())
    }
    fn held(&self) -> usize {
        crate::projects::telemetry::held_rows(&self.session, "dev").len()
    }
    fn room_bodies(&self) -> Vec<String> {
        let r = self.call("hub_log", json!({ "limit": 50 })).unwrap();
        r["messages"].as_array().cloned().unwrap_or_default().iter().map(|m| m["body"].as_str().unwrap_or("").to_string()).collect()
    }
}

fn wait(ok: &dyn Fn() -> bool, ms: u64) -> bool {
    (0..ms / 50).any(|_| ok() || { std::thread::sleep(std::time::Duration::from_millis(50)); false })
}


/// AC1: ONE read: the open asks, the board's counts and the oldest LAST
/// CHANGE in doing, each live agent's derived state with the issue it holds
/// and its newest status line, the stopped count, and the issues done in
/// the last 24 h by done_at (an older done issue is left out).
#[test]
fn the_dashboard_is_one_derived_answer() {
    let Some(rig) = Rig::start("dash-read") else { return };
    // A managed home with no window: stopped, only counted.
    let gone = rig.ws.join(".tmm/agents/gone");
    std::fs::create_dir_all(&gone).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "codex", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&gone).unwrap();
    let s = rig.session.clone();
    let doing = crate::projects::board_save(&s, None, Some("wire it"), None, Some("doing"), Some("dev"), "human").unwrap();
    let recent = crate::projects::board_save(&s, None, Some("shipped today"), None, Some("done"), Some("dev"), "human").unwrap();
    let old = crate::projects::board_save(&s, None, Some("shipped long ago"), None, Some("done"), None, "human").unwrap();
    crate::projects::restore_hold::with_store_for_test(|st| st.exec_for_test(&format!("UPDATE issues SET done_at = done_at - {} WHERE session = '{s}' AND project_number = {old}", super::hub_rpc::dashboard::FINISHED_SECS + 60))).unwrap();
    crate::projects::board_save(&s, None, Some("next"), None, None, None, "human").unwrap();
    let ask = rig.call("hub_ask", json!({ "from": "dev", "question": "Which layout?" })).unwrap();
    rig.call("hub_post", json!({ "from": "dev", "body": "compiling the store", "status": true })).unwrap();
    rig.call("hub_post", json!({ "from": "dev", "body": "running the suite", "status": true })).unwrap();
    let d = rig.call("hub_dashboard", json!({})).unwrap();
    assert_eq!(d["asks"].as_array().unwrap().iter().map(|a| a["seq"].clone()).collect::<Vec<_>>(), vec![ask["ask"]["seq"].clone()], "{d}");
    assert_eq!(d["board"]["counts"], json!({ "todo": 1, "doing": 1, "review": 0, "done": 2, "total": 4 }));
    assert_eq!((d["board"]["oldest_doing"]["id"].as_i64(), d["board"]["oldest_doing"]["assignee"].as_str()), (Some(doing), Some("dev")));
    assert!(d["board"]["oldest_doing"]["last_change"].as_i64().is_some(), "named for what it is");
    let agents = d["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1, "live agents only, the roster's own: {d}");
    let dev = &agents[0];
    assert_eq!((dev["name"].as_str(), dev["issue"]["id"].as_i64(), dev["issue"]["title"].as_str()), (Some("dev"), Some(doing), Some("wire it")));
    assert_eq!(dev["status"]["text"].as_str(), Some("running the suite"), "the newest status line, its own words");
    assert!(dev["state"].is_string() && dev.get("detail").is_some() && dev.get("since").is_some(), "the one derivation's state, detail and time: {dev}");
    assert_eq!(d["stopped"].as_i64(), Some(1), "the home with no window is counted, not a row");
    let finished = d["finished"].as_array().unwrap();
    assert_eq!(finished.iter().map(|f| f["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![recent], "24 h by done_at: {finished:?}");
    assert_eq!((finished[0]["title"].as_str(), finished[0]["assignee"].as_str()), (Some("shipped today"), Some("dev")));
    // The roster this read used is hub_agents' own: the same state for dev.
    let roster = rig.call("hub_agents", json!({})).unwrap();
    let card = roster["agents"].as_array().unwrap().iter().find(|a| a["name"] == "dev").unwrap().clone();
    assert_eq!((card["state"].clone(), card["detail"].clone()), (dev["state"].clone(), dev["detail"].clone()));
}

/// AC3: every room's open-ask count in one read, before the session gate;
/// a closed ask does not count.
#[test]
fn every_rooms_open_asks_are_counted_in_one_read() {
    let Some(rig) = Rig::start("dash-counts") else { return };
    let a = rig.call("hub_ask", json!({ "from": "dev", "question": "one" })).unwrap();
    rig.call("hub_ask", json!({ "from": "dev", "question": "two" })).unwrap();
    rig.call("hub_ask_dismiss", json!({ "seq": a["ask"]["seq"] })).unwrap();
    let r = handle_hub_request(&req("hub_ask_counts", json!({})), None).result.unwrap();
    let room = super::hub_rpc::project_room(&rig.session);
    assert_eq!(r["counts"][room.as_str()].as_i64(), Some(1), "{r}");
}

/// Round 2 (reviewer R2): a dashboard agent is a MANAGED agent, the Hub's
/// roster rule; a hand-started CLI window is not a row (hub_agents still
/// lists it with managed=false).
#[test]
fn a_hand_started_cli_window_is_not_a_dashboard_agent() {
    let Some(rig) = Rig::start("dash-manual") else { return };
    // A second fake codex, started by hand: detected as an agent CLI, no home.
    crate::tmux::new_named_window(&rig.session, "manual", &rig.ws.to_string_lossy()).unwrap();
    crate::tmux::send_command(&format!("{}:manual", rig.session), &rig.cmd).unwrap();
    assert!(wait(&|| crate::tmux::list_panes(&rig.session).unwrap_or_default().iter().any(|p| p.window_name == "manual" && p.agent.is_some()), 10000), "the manual CLI is detected");
    let roster = rig.call("hub_agents", json!({})).unwrap();
    let manual = roster["agents"].as_array().unwrap().iter().find(|a| a["name"] == "manual").cloned().unwrap();
    assert_eq!((manual["agent"].is_null(), manual["managed"].as_bool()), (false, Some(false)), "{manual}");
    let d = rig.call("hub_dashboard", json!({})).unwrap();
    let names: Vec<&str> = d["agents"].as_array().unwrap().iter().filter_map(|a| a["name"].as_str()).collect();
    assert_eq!(names, vec!["dev"], "only the managed agent: {d}");
}

/// Round 2 (reviewer R1), pinned to its own cause (round 5 amendment C): the
/// stopped count's directory LISTING alone fails (managed::read_seam), every
/// marker stays readable, so only the listing can refuse; once it works the
/// read answers.
#[test]
fn an_unreadable_agents_directory_is_an_error_not_zero_stopped() {
    let Some(rig) = Rig::start("dash-unread") else { return };
    let agents = rig.ws.join(".tmm/agents");
    *crate::projects::managed::read_seam::AFTER.lock().unwrap() = Some((agents.clone(), 0));
    let e = rig.call("hub_dashboard", json!({}));
    *crate::projects::managed::read_seam::AFTER.lock().unwrap() = None;
    let e = e.unwrap_err();
    assert!(e.contains("its agent homes could not be read") && e.contains("cannot be listed: injected"), "{e}");
    assert!(rig.call("hub_dashboard", json!({})).is_ok(), "listing works again: answered");
}

/// Round 2 (reviewer R1): a pane listing that FAILED is an error of the whole
/// read, never "nobody live, all stopped"; a session tmux says is ABSENT is a
/// real answer: no live agents, every managed home stopped.
#[test]
fn a_failed_pane_listing_is_an_error_and_an_absent_session_counts_its_homes_stopped() {
    let Some(rig) = Rig::start("dash-panes") else { return };
    let room = super::hub_rpc::project_room(&rig.session);
    let ws = || crate::projects::project_for_session(&rig.session);
    let (failed, fws) = super::hub_rpc::roster_with(&rig.session, ws(), |_| Err("error connecting to /tmp/x (Permission denied)".to_string()));
    assert_eq!(failed["panes"].as_str(), Some("failed"), "{failed}");
    let e = super::hub_rpc::dashboard::dashboard(&rig.session, &room, &failed, fws.as_deref()).unwrap_err();
    assert!(format!("{e:?}").contains("its panes could not be listed"), "{e:?}");
    let (absent, aws) = super::hub_rpc::roster_with(&rig.session, ws(), |s| Err(format!("can't find session: {s}")));
    assert_eq!(absent["panes"].as_str(), Some("absent"));
    let d = super::hub_rpc::dashboard::dashboard(&rig.session, &room, &absent, aws.as_deref()).unwrap();
    assert_eq!((d["agents"].as_array().unwrap().len(), d["stopped"].as_i64()), (0, Some(1)), "a known-down project counts its home stopped: {d}");
    let live = rig.call("hub_agents", json!({})).unwrap();
    assert_eq!(live["panes"].as_str(), Some("ok"));
}

/// Round 3 (reviewer, leader): the fold reads the project ONCE. A failed
/// project read marks the observation failed, so the dashboard refuses the
/// whole read instead of "every agent unmanaged, every home stopped"; the
/// dashboard has no second project read to disagree with it.
#[test]
fn a_failed_project_read_in_the_fold_refuses_the_dashboard() {
    let Some(rig) = Rig::start("dash-project") else { return };
    let room = super::hub_rpc::project_room(&rig.session);
    let (roster, ws) = super::hub_rpc::roster_with(&rig.session, Err("state.db: database is locked".to_string()), crate::tmux::list_panes);
    assert_eq!((roster["panes"].as_str(), ws.as_deref()), (Some("failed"), None), "{roster}");
    let e = super::hub_rpc::dashboard::dashboard(&rig.session, &room, &roster, ws.as_deref()).unwrap_err();
    assert!(format!("{e:?}").contains("its project could not be read"), "{e:?}");
    // The same session, read whole: it answers, from the fold's one project read.
    assert_eq!(rig.call("hub_dashboard", json!({})).unwrap()["agents"].as_array().unwrap().len(), 1);
    assert_eq!(rig.call("hub_agents", json!({})).unwrap()["panes"].as_str(), Some("ok"), "hub_agents unchanged for its clients");
}

/// Round 4 (validator note 56, leader): a fold whose project's CURRENT session
/// is not the session it lists is no reading. The door's resolution of a
/// previous session name was lost, so tmux's "absent" is about the wrong
/// session: 'failed', never "all stopped". A consistent fold answers.
#[test]
fn a_fold_listing_another_session_than_its_projects_is_no_reading() {
    let Some(rig) = Rig::start("dash-alias") else { return };
    let room = super::hub_rpc::project_room(&rig.session);
    let mut project = crate::projects::project_for_session(&rig.session).unwrap().unwrap();
    project.session = format!("{}-renamed", rig.session);
    // Listed under the session it was asked with, while the project now names another.
    let (roster, ws) = super::hub_rpc::roster_with(&rig.session, Ok(Some(project)), |s| Err(format!("can't find session: {s}")));
    assert_eq!(roster["panes"].as_str(), Some("failed"), "not 'absent': {roster}");
    assert!(super::hub_rpc::dashboard::dashboard(&rig.session, &room, &roster, ws.as_deref()).is_err());
    let consistent = crate::projects::project_for_session(&rig.session).unwrap();
    let (roster, ws) = super::hub_rpc::roster_with(&rig.session, Ok(consistent), crate::tmux::list_panes);
    assert_eq!(roster["panes"].as_str(), Some("ok"));
    assert_eq!(super::hub_rpc::dashboard::dashboard(&rig.session, &room, &roster, ws.as_deref()).unwrap()["agents"].as_array().unwrap().len(), 1);
}

/// Round 5 (2): the dashboard's room is the fold's project row's, never the
/// dispatcher's. A project whose recorded room is another than proj:<session>
/// (as after a rename) is read there.
#[test]
fn the_dashboard_reads_the_room_of_the_folds_project_row() {
    let Some(rig) = Rig::start("dash-room") else { return };
    let mut project = crate::projects::project_for_session(&rig.session).unwrap().unwrap();
    project.room = format!("proj:{}-before-rename", rig.session);
    let home = crate::projects::asks::home_id(&rig.session, "dev").unwrap().unwrap();
    let input = crate::projects::asks::validate("asked in the recorded room", &[], None, None, &|_| Ok(false)).unwrap();
    let ask = crate::projects::asks::open(&project.room, "dev", &home, &input).unwrap();
    let f = super::hub_rpc::fold(&rig.session, Ok(Some(project.clone())), crate::tmux::list_panes);
    assert_eq!(f.room, project.room);
    let d = super::hub_rpc::dashboard::dashboard(&rig.session, &f.room, &f.roster, f.workspace.as_deref()).unwrap();
    assert_eq!(d["asks"].as_array().unwrap().iter().map(|a| a["seq"].as_i64().unwrap()).collect::<Vec<_>>(), vec![ask.seq], "{d}");
    // A row with no recorded room: session_room_checked's rule, proj:<session>.
    project.room = String::new();
    assert_eq!(super::hub_rpc::fold(&rig.session, Ok(Some(project)), crate::tmux::list_panes).room, format!("proj:{}", rig.session));
}

/// Round 5 (5): a live window whose home marker cannot be READ has no known
/// `managed`: the observation is failed and the dashboard refuses, instead of
/// silently dropping the agent.
#[test]
fn an_unreadable_marker_of_a_live_agent_is_no_reading() {
    use std::os::unix::fs::PermissionsExt;
    let Some(rig) = Rig::start("dash-marker") else { return };
    let home = rig.ws.join(".tmm/agents/dev");
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o000)).unwrap();
    let r = rig.call("hub_dashboard", json!({}));
    let roster = rig.call("hub_agents", json!({})).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let e = r.unwrap_err();
    assert!(e.contains("the home marker of 'dev' could not be read"), "the marker's own cause: {e}");
    assert_eq!(roster["panes"].as_str(), Some("failed"), "{roster}");
    assert_eq!(rig.call("hub_dashboard", json!({})).unwrap()["agents"].as_array().unwrap().len(), 1, "readable again");
}

/// Round 5 (6): a stopped home whose marker cannot be read is not dropped
/// from the stopped count: the whole read refuses.
#[test]
fn an_unreadable_stopped_home_is_an_error_not_a_smaller_count() {
    use std::os::unix::fs::PermissionsExt;
    let Some(rig) = Rig::start("dash-home") else { return };
    let gone = rig.ws.join(".tmm/agents/gone");
    std::fs::create_dir_all(&gone).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "codex", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&gone).unwrap();
    assert_eq!(rig.call("hub_dashboard", json!({})).unwrap()["stopped"].as_i64(), Some(1));
    std::fs::set_permissions(&gone, std::fs::Permissions::from_mode(0o000)).unwrap();
    let r = rig.call("hub_dashboard", json!({}));
    std::fs::set_permissions(&gone, std::fs::Permissions::from_mode(0o700)).unwrap();
    let e = r.unwrap_err();
    assert!(e.contains("agent homes could not be read") && e.contains("gone"), "{e}");
}

/// Round 5 amendment A: each window's marker is read ONCE, and that one
/// observation decides both the conclusiveness and the row. A reader that
/// answers Managed first and Unknown on any later read of the same home
/// cannot make the row unmanaged behind an 'ok'.
#[test]
fn the_fold_builds_rows_from_one_marker_observation() {
    let Some(rig) = Rig::start("dash-once") else { return };
    let reads = std::cell::RefCell::new(std::collections::HashMap::<String, usize>::new());
    let marker = |ws: &str, name: &str| {
        let mut r = reads.borrow_mut();
        let n = r.entry(name.to_string()).or_insert(0);
        *n += 1;
        if *n == 1 { crate::projects::managed::managed_state(ws, name) } else { crate::projects::managed::ManagedState::Unknown("a second read".into()) }
    };
    let project = crate::projects::project_for_session(&rig.session);
    let (roster, _) = super::hub_rpc::roster_with_markers(&rig.session, project, crate::tmux::list_panes, &marker);
    assert_eq!(roster["panes"].as_str(), Some("ok"), "{roster}");
    let dev = roster["agents"].as_array().unwrap().iter().find(|a| a["name"] == "dev").unwrap();
    assert_eq!((dev["managed"].as_bool(), dev["home_managed"].as_bool()), (Some(true), Some(true)), "{dev}");
    assert_eq!(reads.borrow().get("dev"), Some(&1), "read once");
}

/// Round 5 amendment B: membership is the marker. A managed home whose CLI
/// exited to the shell and whose launch.json CONTENT cannot be read (the
/// file exists, so the marker is conclusive) is still a dashboard agent, and
/// its live window is never counted stopped.
#[test]
fn a_managed_home_with_an_unreadable_recipe_is_still_counted() {
    use std::os::unix::fs::PermissionsExt;
    let Some(rig) = Rig::start("dash-recipe") else { return };
    crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "C-c"]).unwrap();
    assert!(wait(&|| rig.agent().is_none(), 10000), "the CLI exited to the shell");
    let recipe = rig.ws.join(".tmm/agents/dev/launch.json");
    std::fs::set_permissions(&recipe, std::fs::Permissions::from_mode(0o000)).unwrap();
    let d = rig.call("hub_dashboard", json!({}));
    std::fs::set_permissions(&recipe, std::fs::Permissions::from_mode(0o600)).unwrap();
    let d = d.unwrap();
    let names: Vec<&str> = d["agents"].as_array().unwrap().iter().filter_map(|a| a["name"].as_str()).collect();
    assert_eq!((names, d["stopped"].as_i64()), (vec!["dev"], Some(0)), "{d}");
    // Its state is the fold's DERIVED one (validator note 81): its CLI exited
    // to the shell, so 'exited' (exited::shown), never 'shell', which is for a
    // window that is no agent and no home.
    assert_eq!(d["agents"][0]["state"].as_str(), Some("exited"), "{d}");
}

/// Round 5 closing test (validator note 94, leader): THROUGH THE DASHBOARD
/// PATH, a reader that is conclusive the first time a home is read and
/// Unknown on any later read of it. The fold, the state of a shell-parked
/// managed agent and the stopped walk each use the first observation only,
/// so hub_dashboard still answers, correctly.
#[test]
fn the_dashboard_reads_each_home_marker_once() {
    let Some(rig) = Rig::start("dash-once-all") else { return };
    let gone = rig.ws.join(".tmm/agents/gone");
    std::fs::create_dir_all(&gone).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "codex", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&gone).unwrap();
    crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "C-c"]).unwrap();
    assert!(wait(&|| rig.agent().is_none(), 10000), "dev's CLI exited to the shell");
    let reads = std::cell::RefCell::new(std::collections::HashMap::<String, usize>::new());
    let marker = |ws: &str, name: &str| {
        let mut r = reads.borrow_mut();
        let n = r.entry(name.to_string()).or_insert(0);
        *n += 1;
        if *n > 1 {
            return crate::projects::managed::ManagedState::Unknown("a second read".into());
        }
        let first = crate::projects::managed::managed_state(ws, name);
        // From now on any REAL read of dev's marker (a hidden fail-open
        // reread, e.g. exited::classify's own) cannot read it.
        if name == "dev" {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(std::path::Path::new(ws).join(".tmm/agents/dev"), std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        first
    };
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(rig.ws.join(".tmm/agents/dev"));
    let f = super::hub_rpc::fold_with(&rig.session, crate::projects::project_for_session(&rig.session), crate::tmux::list_panes, &marker);
    let d = super::hub_rpc::dashboard::dashboard_with(&rig.session, &f.room, &f.roster, f.workspace.as_deref(), &marker).unwrap();
    let agents = d["agents"].as_array().unwrap();
    assert_eq!(agents.iter().map(|a| (a["name"].as_str().unwrap(), a["state"].as_str().unwrap())).collect::<Vec<_>>(), vec![("dev", "exited")], "{d}");
    assert_eq!(d["stopped"].as_i64(), Some(1), "gone, read once by the walk: {d}");
    let r = reads.borrow();
    assert_eq!((r.get("dev"), r.get("gone")), (Some(&1), Some(&1)), "each home's marker read once: {r:?}");
}

/// Leader's amended status rule (no window): an agent's latest status is its
/// newest row the ONE parser accepts, however much unrelated traffic came
/// after it, and a newer malformed status-looking row does not hide it.
#[test]
fn the_latest_status_survives_traffic_and_a_malformed_newer_candidate() {
    let Some(rig) = Rig::start("dash-status") else { return };
    let room = super::hub_rpc::project_room(&rig.session);
    rig.call("hub_post", json!({ "from": "dev", "body": "compiled the store", "status": true })).unwrap();
    for i in 0..2001 {
        crate::projects::rooms::post(&room, "human", &format!("unrelated {i}")).unwrap();
    }
    // Newer, from the same sender, status-shaped but not a status note.
    crate::projects::rooms::post(&room, "dev", "[tmm status broken").unwrap();
    crate::projects::rooms::post(&room, "dev", "[tmm status working]   ").unwrap();
    let d = rig.call("hub_dashboard", json!({})).unwrap();
    assert_eq!(d["agents"][0]["status"]["text"].as_str(), Some("compiled the store"), "{}", d["agents"][0]);
}

/// The read's cost without a window (leader's amended rule), measured once on
/// a real-sized room: 12,600 messages (this host's room log at 2026-11-11,
/// seq 12590), the wanted agent's only status line the OLDEST row, the worst
/// case. The figure is written in dashboard.md; the bound here is generous.
#[test]
fn the_latest_status_read_cost_on_a_real_sized_room() {
    let Some(rig) = Rig::start("dash-cost") else { return };
    let room = super::hub_rpc::project_room(&rig.session);
    crate::projects::rooms::seed_msg(&room, "cost-status", 1, "dev", &[], "[tmm status working] the oldest line");
    for i in 0..12_600 {
        crate::projects::rooms::seed_msg(&room, &format!("cost-{i}"), 2 + i, if i % 3 == 0 { "dev" } else { "human" }, &[], &format!("message {i}"));
    }
    let t = std::time::Instant::now();
    let s = crate::projects::rooms::latest_status(&room, &["dev".to_string()]).unwrap();
    let status_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = std::time::Instant::now();
    let d = rig.call("hub_dashboard", json!({})).unwrap();
    let dash_ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("[cost-108] room of 12601 messages, status at the oldest row: latest_status {status_ms:.1} ms, hub_dashboard {dash_ms:.1} ms");
    assert_eq!(s.get("dev").map(|(t, _)| t.as_str()), Some("the oldest line"));
    assert_eq!(d["agents"][0]["status"]["text"].as_str(), Some("the oldest line"));
    assert!(status_ms < 1000.0 && dash_ms < 3000.0, "status {status_ms} ms, dashboard {dash_ms} ms");
}
