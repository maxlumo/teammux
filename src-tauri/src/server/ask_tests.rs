//! Board #106: an ask's answer reaches its asker through the one delivery
//! path, after the commit, exactly once. Real tmux, a real managed home, and
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

/// X1 + I3: a live asker gets the answer typed once, quoting the ask, AFTER
/// the answer is in the room; a retry writes nothing and types nothing.
#[test]
fn a_live_asker_gets_its_answer_once_and_a_retry_types_nothing() {
    let Some(rig) = Rig::start("ask-live") else { return };
    let seq = rig.ask("dev").unwrap();
    assert!(rig.room_bodies().iter().any(|b| b.starts_with("@human [ask] Which layout?\nA · own row (recommended)")), "{:?}", rig.room_bodies());
    let r = rig.call("hub_ask_answer", json!({ "seq": seq, "option": "a", "text": "keep 24px on Single" })).unwrap();
    assert_eq!((r["applied"].as_bool(), r["ask"]["state"].as_str(), r["ask"]["answer_key"].as_str(), r["ask"]["delivery"].as_str()), (Some(true), Some("answered"), Some("A"), Some("found")), "{r}");
    let closing = r["ask"]["closing"].as_str().unwrap().to_string();
    assert!(closing.starts_with("@dev [re dev ") && closing.ends_with("A · own row — keep 24px on Single"), "{closing}");
    assert!(wait(&|| rig.submits("A · own row") == 1, 10000), "typed: {:?}", rig.screen());
    // The retry: the winner's row back, nothing new in the room or the pane.
    let again = rig.call("hub_ask_answer", json!({ "seq": seq, "option": "B" })).unwrap();
    assert_eq!((again["applied"].as_bool(), again["ask"]["answer_key"].as_str()), (Some(false), Some("A")), "{again}");
    assert!(again["refused"].as_str().unwrap().starts_with("already answered at "));
    let dismissed = rig.call("hub_ask_dismiss", json!({ "seq": seq })).unwrap();
    assert_eq!(dismissed["applied"].as_bool(), Some(false));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(rig.submits("A · own row"), 1, "once: {:?}", rig.screen());
    assert_eq!(rig.submits("disk to the card"), 0);
    assert_eq!(rig.room_bodies().iter().filter(|b| b.contains("keep 24px")).count(), 1);
    let listed = rig.call("hub_ask_list", json!({ "all": true })).unwrap();
    assert_eq!(listed["asks"].as_array().unwrap().len(), 1);
    assert!(rig.call("hub_ask_list", json!({})).unwrap()["asks"].as_array().unwrap().is_empty(), "no open ask left");
}

/// X2: the asker's CLI exited to the shell: the answer is held (#77), never
/// typed into the shell, and reaches the restarted CLI once.
#[test]
fn an_answer_to_an_asker_whose_cli_exited_is_held_and_reaches_it_after_a_restart() {
    let Some(rig) = Rig::start("ask-exited") else { return };
    let seq = rig.ask("dev").unwrap();
    crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "C-c"]).unwrap();
    assert!(wait(&|| rig.agent().is_none(), 10000), "it exited: {:?}", rig.screen());
    let marker = rig.ws.join("marker");
    let r = rig.call("hub_ask_dismiss", json!({ "seq": seq })).unwrap();
    assert_eq!((r["applied"].as_bool(), r["ask"]["state"].as_str(), r["ask"]["delivery"].as_str()), (Some(true), Some("dismissed"), Some("found")), "{r}");
    let _ = marker;
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(rig.held(), 1, "held, not typed into the shell: {:?}", rig.screen());
    assert!(!rig.screen().contains("dismissed: I will not"), "nothing in the shell: {:?}", rig.screen());
    let r = rig.call("hub_agent_restart", json!({ "agent": "dev" }));
    assert!(r.is_ok(), "{r:?}");
    assert!(wait(&|| rig.submits("dismissed: I will not answer this") == 1, 20000), "{:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(1000));
    assert_eq!(rig.submits("dismissed: I will not answer this"), 1);
    assert_eq!(rig.held(), 0);
}

/// X3: a STOPPED asker: nothing typed, nothing queued, the outcome recorded.
#[test]
fn an_answer_to_a_stopped_asker_is_recorded_and_neither_typed_nor_queued() {
    let Some(rig) = Rig::start("ask-stopped") else { return };
    let seq = rig.ask("dev").unwrap();
    rig.call("hub_agent_stop", json!({ "agent": "dev" })).unwrap();
    assert!(wait(&|| !crate::tmux::list_panes(&rig.session).unwrap_or_default().iter().any(|p| p.window_name == "dev"), 10000), "stopped");
    let r = rig.call("hub_ask_answer", json!({ "seq": seq, "text": "later" })).unwrap();
    assert_eq!((r["applied"].as_bool(), r["ask"]["state"].as_str(), r["ask"]["delivery"].as_str()), (Some(true), Some("answered"), Some("stopped")), "{r}");
    assert_eq!(rig.held(), 0, "no second queue");
    let listed = rig.call("hub_ask_list", json!({ "all": true })).unwrap();
    assert_eq!(listed["asks"][0]["delivery"].as_str(), Some("stopped"), "the outcome is on the ask: {listed}");
}

/// W1: a same-name replacement is not the asker: the answer is recorded,
/// delivery `gone`, nothing typed; the new agent cannot withdraw it.
#[test]
fn a_same_name_replacement_is_not_the_asker() {
    let Some(rig) = Rig::start("ask-replaced") else { return };
    let seq = rig.ask("dev").unwrap();
    let home = rig.ws.join(".tmm/agents/dev");
    std::fs::remove_dir_all(&home).unwrap();
    Rig::make_home(&rig.ws, &rig.cmd);
    let w = rig.call("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": "mine now" })).unwrap_err();
    assert!(w.contains("only the asker withdraws") && w.contains("replaced"), "{w}");
    let r = rig.call("hub_ask_answer", json!({ "seq": seq, "option": "B" })).unwrap();
    assert_eq!((r["applied"].as_bool(), r["ask"]["delivery"].as_str()), (Some(true), Some("gone")), "{r}");
    std::thread::sleep(std::time::Duration::from_millis(1200));
    assert_eq!(rig.submits("disk to the card"), 0, "never typed to somebody else: {:?}", rig.screen());
}

/// D4 + R1/R5/R9 and the cited message's room (leader, note 4): the doors.
/// Every refusal stores nothing.
#[test]
fn the_doors_refuse_and_store_nothing_and_a_withdrawal_cites_this_room_only() {
    let Some(rig) = Rig::start("ask-doors") else { return };
    let before = rig.room_bodies().len();
    for (params, want) in [
        (json!({ "from": "stranger", "question": "q" }), "is not one"),
        (json!({ "from": "human", "question": "q" }), "only a managed agent"),
        (json!({ "from": "dev", "question": "q", "issue": 999 }), "no issue #999"),
        (json!({ "from": "dev", "question": " " }), "needs a question"),
        (json!({ "from": "dev", "question": "q", "options": [{ "key": "A", "label": "x" }], "recommend": "Z" }), "not one of the options"),
    ] {
        let e = rig.call("hub_ask", params.clone()).unwrap_err();
        assert!(e.contains(want), "{params}: {e}");
    }
    assert_eq!(rig.room_bodies().len(), before, "nothing stored");
    assert!(rig.call("hub_ask_list", json!({ "all": true })).unwrap()["asks"].as_array().unwrap().is_empty());

    let seq = rig.ask("dev").unwrap();
    assert!(rig.call("hub_ask_answer", json!({ "seq": seq })).unwrap_err().contains("an option or some text"));
    assert!(rig.call("hub_ask_answer", json!({ "seq": seq, "option": "Q" })).unwrap_err().contains("not an option"));
    assert!(rig.call("hub_ask_withdraw", json!({ "seq": seq, "from": "keep", "why": "x" })).unwrap_err().contains("only the asker"));
    assert!(rig.call("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": " " })).unwrap_err().contains("says why"));
    // A message of ANOTHER room cannot be cited.
    let other = crate::projects::rooms::post("proj:elsewhere", "human", "可以").unwrap();
    let e = rig.call("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": "answered in chat", "re": other["seq"] })).unwrap_err();
    assert!(e.contains("no message"), "{e}");
    assert_eq!(rig.call("hub_ask_list", json!({})).unwrap()["asks"][0]["state"].as_str(), Some("open"), "still open after every refusal");
    // The person says 可以 in chat; the asker withdraws citing it: withdrawn, never answered.
    let said = rig.call("hub_post", json!({ "from": "human", "body": "可以", "record_only": true })).unwrap();
    let w = rig.call("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": "answered in chat", "re": said["seq"] })).unwrap();
    assert_eq!((w["applied"].as_bool(), w["ask"]["state"].as_str(), w["ask"]["answer_key"].as_str()), (Some(true), Some("withdrawn"), None), "{w}");
    let closing = w["ask"]["closing"].as_str().unwrap();
    assert!(closing.contains("withdrawn: answered in chat — citing [re human ") && closing.contains("可以"), "{closing}");
    // An ask in another project's room is not this room's.
    assert!(rig.call("hub_ask_answer", json!({ "seq": seq + 1000, "text": "x" })).unwrap_err().contains("no ask"));
}

/// L1/L2: the asks follow the room through a rename and an archive.
#[test]
fn asks_follow_the_room_through_a_rename_and_an_archive() {
    let Some(rig) = Rig::start("ask-rename") else { return };
    let seq = rig.ask("dev").unwrap();
    let project = crate::projects::project_for_session(&rig.session).unwrap().unwrap();
    crate::projects::set_archived(&project.id, true).unwrap();
    let listed = rig.call("hub_ask_list", json!({})).unwrap();
    assert_eq!(listed["asks"][0]["seq"].as_i64(), Some(seq), "archived: {listed}");
    crate::projects::set_archived(&project.id, false).unwrap();
    // A unique new name, and a guard that follows the rename (validator S2:
    // the rig's guard held the old name and the renamed session outlived it).
    // A session name is the slug of the project name, at most 24 characters.
    let renamed = format!("ask-rn-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let follows = Teardown(renamed.clone(), rig.ws.join("no-such-dir"));
    crate::projects::rename(&project.id, &renamed).unwrap();
    let session = crate::projects::project_for_session(&renamed).ok().flatten().map(|p| p.session).expect("the renamed project");
    assert_eq!(session, renamed, "the tmux session follows the project's name");
    let r = handle_hub_request(&req("hub_ask_list", json!({ "session": session })), None).result.unwrap();
    assert_eq!(r["asks"][0]["seq"].as_i64(), Some(seq), "renamed: {r}");
    let old = rig.session.clone();
    drop(follows);
    drop(rig);
    for name in [old, renamed] {
        let alive = std::process::Command::new("tmux").args(["has-session", "-t", &format!("={name}")]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
        assert!(!alive, "nothing of this test is left: {name}");
    }
}

/// Item 3: nothing is typed before the commit. The delivery seam sees the
/// ask already closed and its closing message already in the room, and a
/// close that did not apply never reaches it.
#[test]
fn the_line_is_handed_to_delivery_only_after_the_commit_and_only_once() {
    let Some(rig) = Rig::start("ask-order") else { return };
    let seq = rig.ask("dev").unwrap();
    let calls = std::cell::Cell::new(0);
    let deliver = |_s: &str, to: &str, body: &str, room: &str, msg_seq: i64, _id: &str| {
        calls.set(calls.get() + 1);
        assert_eq!(to, "dev", "the asker, alone");
        let a = crate::projects::asks::get(seq).unwrap().unwrap();
        assert_eq!((a.state.as_str(), a.closed_seq), ("answered", Some(msg_seq)), "committed before delivery");
        assert_eq!(crate::projects::asks::body_of(room, msg_seq).as_deref(), Some(body), "the line is the stored message");
        (vec!["dev".to_string()], Vec::new())
    };
    let room = super::hub_rpc::project_room(&rig.session);
    let p = json!({ "seq": seq, "option": "A" });
    let r = super::hub_rpc::asks::answer(&rig.session, &room, &p, &deliver).unwrap();
    assert_eq!((r["applied"].as_bool(), calls.get()), (Some(true), 1));
    let r = super::hub_rpc::asks::answer(&rig.session, &room, &p, &deliver).unwrap();
    assert_eq!((r["applied"].as_bool(), calls.get()), (Some(false), 1), "a refused close delivers nothing");
}

/// Validator F1 (round 1): a supplied field of the wrong type is refused at
/// the door, never defaulted away; nothing is stored.
#[test]
fn a_wrong_typed_field_is_refused_and_nothing_is_stored() {
    let Some(rig) = Rig::start("ask-types") else { return };
    let before = rig.room_bodies().len();
    for (params, want) in [
        (json!({ "from": "dev", "question": "q", "options": { "A": "alpha", "B": "beta" } }), "options: a list"),
        (json!({ "from": "dev", "question": "q", "options": [{ "key": "A", "label": "alpha", "extra": 1 }] }), "options: a list"),
        (json!({ "from": "dev", "question": "q", "options": [{ "key": 1, "label": "alpha" }] }), "options: a list"),
        (json!({ "from": "dev", "question": "q", "options": [{ "key": "A", "label": "alpha" }], "recommend": 7 }), "recommend: a string"),
        (json!({ "from": "dev", "question": 42 }), "question: a string"),
        (json!({ "from": "dev", "question": "q", "issue": true }), "issue: an integer"),
        (json!({ "from": ["dev"], "question": "q" }), "from: a string"),
    ] {
        let e = rig.call("hub_ask", params.clone()).unwrap_err();
        assert!(e.contains(want) && e.contains("nothing was written"), "{params}: {e}");
    }
    assert_eq!(rig.room_bodies().len(), before, "nothing stored");
    let seq = rig.ask("dev").unwrap();
    for (method, params, want) in [
        ("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": "x", "re": true }), "re: a room message"),
        ("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": 5 }), "why: a string"),
        ("hub_ask_answer", json!({ "seq": seq, "option": 1 }), "option: a string"),
        ("hub_ask_answer", json!({ "seq": seq, "text": ["x"] }), "text: a string"),
        ("hub_ask_answer", json!({ "seq": true, "text": "x" }), "seq: an integer"),
        ("hub_ask_list", json!({ "all": "yes" }), "all: true or false"),
    ] {
        let e = rig.call(method, params.clone()).unwrap_err();
        assert!(e.contains(want), "{method} {params}: {e}");
    }
    let open = rig.call("hub_ask_list", json!({})).unwrap();
    assert_eq!(open["asks"][0]["state"].as_str(), Some("open"), "still open: {open}");
    assert_eq!(rig.room_bodies().len(), before + 1, "only the ask itself was stored");
    // Round 2 (validator note 44, leader note 37): the types are checked
    // BEFORE the state is read, so a malformed field on a CLOSED ask is still
    // -32602, never "already answered"; a well-formed retry still reads the
    // winner back.
    rig.call("hub_ask_answer", json!({ "seq": seq, "option": "A" })).unwrap();
    let closed = rig.room_bodies().len();
    for (method, params, want) in [
        ("hub_ask_answer", json!({ "seq": seq, "option": 1 }), "option: a string"),
        ("hub_ask_answer", json!({ "seq": seq, "text": [] }), "text: a string"),
        ("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": "x", "re": true }), "re: a room message"),
        ("hub_ask_withdraw", json!({ "seq": seq, "from": "dev", "why": 5 }), "why: a string"),
        ("hub_ask_withdraw", json!({ "seq": seq, "from": 3, "why": "x" }), "from: a string"),
    ] {
        let e = rig.call(method, params.clone()).unwrap_err();
        assert!(e.contains(want), "closed ask, {method} {params}: {e}");
    }
    let retry = rig.call("hub_ask_answer", json!({ "seq": seq, "option": "B" })).unwrap();
    assert_eq!((retry["applied"].as_bool(), retry["ask"]["answer_key"].as_str()), (Some(false), Some("A")), "{retry}");
    assert_eq!(rig.room_bodies().len(), closed, "nothing written after the close");
}

/// Validator F2 (round 1): the answer goes to the asker ALONE. An `@name` or
/// `@all` inside an option label or the person's comment is text: another
/// managed agent's pane gets nothing.
#[test]
fn an_answer_naming_another_agent_reaches_only_the_asker() {
    let Some(rig) = Rig::start("ask-route") else { return };
    // A second managed agent, a plain `cat` pane that would echo anything typed.
    let other = rig.ws.join(".tmm/agents/other");
    std::fs::create_dir_all(&other).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "cat", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&other).unwrap();
    crate::tmux::new_named_window(&rig.session, "other", &rig.ws.to_string_lossy()).unwrap();
    crate::tmux::send_command(&format!("{}:other", rig.session), "cat").unwrap();
    let r = rig.call("hub_ask", json!({ "from": "dev", "question": "Who reviews?", "options": [{ "key": "A", "label": "consult @other marker-route" }, { "key": "B", "label": "everyone @all" }] })).unwrap();
    let seq = r["ask"]["seq"].as_i64().unwrap();
    let a = rig.call("hub_ask_answer", json!({ "seq": seq, "option": "A", "text": "and tell @all" })).unwrap();
    assert_eq!((a["applied"].as_bool(), a["ask"]["delivery"].as_str()), (Some(true), Some("found")), "{a}");
    assert!(wait(&|| rig.submits("marker-route") == 1, 10000), "the asker got it: {:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let theirs = crate::tmux::capture_pane_plain(&format!("{}:other", rig.session), Some(200)).unwrap_or_default();
    assert!(!theirs.contains("marker-route"), "never typed into another agent: {theirs:?}");
    let rows = crate::projects::telemetry::recent_events(&rig.session, 0).into_iter().filter(|e| e.kind == "prompt" && e.text.contains("marker-route")).map(|e| e.window).collect::<Vec<_>>();
    assert!(rows.iter().all(|w| w == "dev"), "one recipient's delivery rows only: {rows:?}");
    assert_eq!(a["ask"]["said"].as_str(), Some("A · consult @other marker-route — and tell @all"));
}

/// Reviewer R2 (round 3): every door resolves a name through the ONE
/// `Names`: the physical name, the current label and a previous label all
/// reach the asker; the row and the wire keep the physical name; the list
/// carries the labels; another agent's label is not the asker.
#[test]
fn the_ask_doors_resolve_labels_and_the_list_carries_them() {
    let Some(rig) = Rig::start("ask-labels") else { return };
    let other = rig.ws.join(".tmm/agents/other");
    std::fs::create_dir_all(&other).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "cat", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&other).unwrap();
    crate::projects::names::rename(&rig.session, "dev", Some("robin")).unwrap();
    crate::projects::names::rename(&rig.session, "other", Some("olive")).unwrap();
    // Asked under the CURRENT label: stored and sent as the physical name.
    let first = rig.call("hub_ask", json!({ "from": "robin", "question": "q1" })).unwrap();
    assert_eq!(first["ask"]["asker"].as_str(), Some("dev"), "{first}");
    // A label change before the list and before the close: the old label is
    // now a PREVIOUS label and still reaches it.
    crate::projects::names::rename(&rig.session, "dev", Some("robert")).unwrap();
    let second = rig.call("hub_ask", json!({ "from": "robin", "question": "q2" })).unwrap();
    assert_eq!(second["ask"]["asker"].as_str(), Some("dev"));
    let third = rig.call("hub_ask", json!({ "from": "dev", "question": "q3" })).unwrap();
    assert_eq!(third["ask"]["asker"].as_str(), Some("dev"), "the physical name too");
    let list = rig.call("hub_ask_list", json!({})).unwrap();
    let names = crate::address::Names::from_json(&list["labels"]);
    assert_eq!(names.shown("dev"), "robert", "the list carries the labels: {list}");
    let line = crate::projects::asks::cli::ask_line(&list["asks"][0], &names);
    assert!(line.contains(" robert: q1"), "the CLI shows the asker by its current label: {line}");
    // Withdraw under each of its names; another agent's label is refused.
    let seq = |v: &Value| v["ask"]["seq"].as_i64().unwrap();
    let e = rig.call("hub_ask_withdraw", json!({ "seq": seq(&first), "from": "olive", "why": "x" })).unwrap_err();
    assert!(e.contains("only the asker"), "{e}");
    for (ask, name) in [(&first, "robert"), (&second, "robin"), (&third, "dev")] {
        let w = rig.call("hub_ask_withdraw", json!({ "seq": seq(ask), "from": name, "why": "done" })).unwrap();
        assert_eq!((w["applied"].as_bool(), w["ask"]["state"].as_str()), (Some(true), Some("withdrawn")), "{name}: {w}");
        assert_eq!(crate::address::Names::from_json(&w["labels"]).shown("dev"), "robert", "every ask answer carries the labels: {w}");
    }
    // Every ask answer carries the labels (leader, round 3): the ask itself,
    // an answer, and a refusal, whose CLI line shows the current label.
    assert_eq!(crate::address::Names::from_json(&first["labels"]).shown("dev"), "robin", "{first}");
    let fourth = rig.call("hub_ask", json!({ "from": "robert", "question": "q4" })).unwrap();
    let a = rig.call("hub_ask_answer", json!({ "seq": seq(&fourth), "text": "yes" })).unwrap();
    assert_eq!(crate::address::Names::from_json(&a["labels"]).shown("dev"), "robert", "{a}");
    let refused = rig.call("hub_ask_dismiss", json!({ "seq": seq(&fourth) })).unwrap();
    let said = crate::projects::asks::cli::outcome(&refused).unwrap_err();
    assert!(said.contains(" robert: q4") && said.contains("already answered"), "{said}");
}
