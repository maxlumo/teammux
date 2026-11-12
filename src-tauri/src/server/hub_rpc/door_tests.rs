//! Board #118: a hub request whose project read FAILS is an error, never a silent
//! fallback to the name it was asked with; the same for every re-read inside a
//! method, and a wake whose project cannot be read is not claimed. In a file of its
//! own because hub_rpc.rs is over code-quality.md's 2000-line limit.

use super::*;
use super::super::test_util::req;
use crate::projects::rooms;
use super::tests::{project_with, unique};

/// Board #118: the door's project read FAILS (the test store's `projects` table is
/// renamed away for the guard's lifetime; the suite is sequential), the store
/// itself stays up. Restored on drop, even when the test panics.
struct ProjectsUnreadable;
impl ProjectsUnreadable {
    fn now() -> ProjectsUnreadable {
        crate::projects::restore_hold::with_store_for_test(|s| s.exec_test_sql("ALTER TABLE projects RENAME TO projects_118_away")).unwrap();
        assert!(crate::projects::project_for_session("any").is_err(), "the project read genuinely fails");
        ProjectsUnreadable
    }
}
impl Drop for ProjectsUnreadable {
    fn drop(&mut self) {
        crate::projects::restore_hold::with_store_for_test(|s| s.exec_test_sql("ALTER TABLE projects_118_away RENAME TO projects")).unwrap();
    }
}

/// Board #118 (validator's #108 note 56, builder's note 57): a caller with a PREVIOUS
/// session name (a running agent's TMM_PROJECT after a rename) whose door read FAILS
/// used to be served under that stale name (an empty roster, a post into the default
/// room, the old board key), each a valid-looking answer made from a failed read. A
/// failed read is now the request's -32603 for every method, and nothing is stored.
#[test]
fn a_failed_project_read_at_the_door_is_an_error_never_the_asked_name() {
    let current = project_with(&["lead"]);
    let project = crate::projects::project_for_session(&current).unwrap().unwrap();
    let old = format!("{current}-before");
    crate::projects::restore_hold::with_store_for_test(|s| s.set_session(&project.id, &current, &old)).unwrap();
    assert_eq!(crate::projects::project_for_session(&old).unwrap().map(|p| p.session).as_deref(), Some(current.as_str()), "the old name is a live alias");
    let before = rooms::room_latest();
    let answers: Vec<(&str, Response)> = {
        let _away = ProjectsUnreadable::now();
        // The two hand-off paths (#120's) use the door's row too: they fail here, never "unmanaged".
        ["hub_agents", "hub_board_list", "hub_post", "hub_board_save", "hub_board_note"].into_iter().map(|m| {
            let params = match m {
                "hub_post" => serde_json::json!({ "session": old, "from": "human", "body": "said while the store could not be asked" }),
                "hub_board_save" => serde_json::json!({ "session": old, "title": "t118", "assignee": "lead", "who": "human" }),
                "hub_board_note" => serde_json::json!({ "session": old, "id": 1, "body": "n118", "who": "human", "notify": ["lead"] }),
                _ => serde_json::json!({ "session": old }),
            };
            (m, handle_hub_request(&req(m, params), None))
        }).collect()
    };
    for (m, r) in &answers {
        eprintln!("[118] {m} with a previous session name and a failed project read: result={:?} error={:?}", r.result, r.error.as_ref().map(|e| (e.code, e.message.clone())));
    }
    for (m, r) in &answers {
        let e = r.error.as_ref().unwrap_or_else(|| panic!("{m}: a failed read answered {:?}", r.result));
        assert_eq!(e.code, -32603, "{m}: an internal error, not a valid-looking answer");
        assert!(e.message.contains("project lookup failed"), "{m}: says what failed: {}", e.message);
    }
    assert_eq!(rooms::room_latest(), before, "nothing was posted into any room");
    crate::projects::restore_hold::with_store_for_test(|s| s.delete_project(&project.id)).ok();
}

/// Board #118 (leader note 7): a due wake whose project read FAILS fires nothing:
/// nothing is posted (least of all into proj:<stale name>), the wake is NOT claimed
/// and stays due, so the sleeper's next try after its back-off fires it, once,
/// into the project's own room.
#[test]
fn a_wake_whose_project_read_fails_claims_nothing_and_fires_later_in_its_own_room() {
    let current = project_with(&["lead"]);
    let project = crate::projects::project_for_session(&current).unwrap().unwrap();
    let old = format!("{current}-before");
    let w = crate::projects::wakes::schedule(&old, "lead", "@lead check the build", crate::projects::now() as i64).unwrap();
    crate::projects::restore_hold::with_store_for_test(|s| s.set_session(&project.id, &current, &old)).unwrap();
    let room = crate::projects::rooms::session_room(&current);
    let bodies = |r: &str| -> Vec<String> { rooms::history_page(r, None, 50)["messages"].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap_or("").to_string()).collect() };
    {
        let _away = ProjectsUnreadable::now();
        fire_wake(w.id);
    }
    assert!(bodies(&format!("proj:{old}")).is_empty(), "nothing in the stale room");
    assert!(!bodies(&room).iter().any(|b| b.contains("check the build")), "nothing fired yet");
    assert!(crate::projects::wakes::pending(None).iter().any(|p| p.id == w.id), "still due: nothing was claimed");
    fire_wake(w.id);
    assert_eq!(bodies(&room).iter().filter(|b| b.contains("check the build")).count(), 1, "fired once, in the project's room");
    assert!(!crate::projects::wakes::pending(None).iter().any(|p| p.id == w.id));
    crate::projects::restore_hold::with_store_for_test(|s| s.delete_project(&project.id)).ok();
}

/// Board #118 (c) and (b): the per-method re-reads. A routed delivery whose project
/// read fails calls nobody stopped or unmanaged: every mention is `unchecked` and
/// nothing is typed (the panes are given, so only the project read fails); a start
/// whose project read fails is an error and never falls through to a respawn.
#[test]
fn a_failed_re_read_inside_a_method_is_unchecked_or_an_error_never_a_fallback() {
    let current = project_with(&["dev"]);
    let room = crate::projects::rooms::session_room(&current);
    let names = crate::address::Names::default();
    let respawned = std::cell::Cell::new(false);
    let permit = crate::projects::start_permit(&current, "dev").unwrap();
    let (typed, offline, start) = {
        let _away = ProjectsUnreadable::now();
        let (typed, offline) = deliver_routed_with(
            Routed { session: &current, from: "lead", body: "@dev look", room: &room, before_seq: None, msg_id: "m118", to_sender: false, names, to: vec!["dev".into()], home: None },
            |_| Ok(Vec::new()),
        );
        let start = start_agent_with(&current, "dev", permit, |_, _, _| None, |_: &str, _: &str| { respawned.set(true); Ok(serde_json::json!({})) });
        (typed, offline, start)
    };
    assert!(typed.is_empty(), "nothing typed");
    assert_eq!(offline, vec![("dev".to_string(), crate::projects::delivery::OFFLINE_UNCHECKED)], "unchecked, never stopped or unknown");
    assert!(start.as_ref().is_err_and(|e| e.contains("project lookup failed")), "{start:?}");
    assert!(!respawned.get(), "no respawn on a failed read");
    let project = crate::projects::project_for_session(&current).unwrap().unwrap();
    crate::projects::restore_hold::with_store_for_test(|s| s.delete_project(&project.id)).ok();
}

/// The other half of #118's rule: a positively ABSENT project keeps the documented
/// default (the asked name, proj:<name>), how a session without a project is served;
/// and a renamed project's old name reaches its CURRENT session and persisted room.
#[test]
fn an_absent_project_keeps_the_asked_name_and_a_renamed_one_its_current_session_and_room() {
    crate::projects::tests::use_test_store();
    let (none, none_room) = unique("p118-none");
    let r = handle_hub_request(&req("hub_board_list", serde_json::json!({ "session": none })), None);
    assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": none, "from": "human", "body": "hello nobody" })), None);
    assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    assert!(rooms::history_page(&none_room, None, 10)["messages"].as_array().unwrap().iter().any(|m| m["body"] == "hello nobody"), "the default room");
    let current = project_with(&["lead"]);
    let project = crate::projects::project_for_session(&current).unwrap().unwrap();
    let old = format!("{current}-before");
    crate::projects::restore_hold::with_store_for_test(|s| s.set_session(&project.id, &current, &old)).unwrap();
    let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": old, "from": "human", "body": "hello by the old name" })), None);
    assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    let room = crate::projects::rooms::session_room(&current);
    assert!(rooms::history_page(&room, None, 10)["messages"].as_array().unwrap().iter().any(|m| m["body"] == "hello by the old name"), "the project's own room");
    crate::projects::restore_hold::with_store_for_test(|s| s.delete_project(&project.id)).ok();
}
