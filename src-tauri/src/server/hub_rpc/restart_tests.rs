//! Board #74 review R1: a restart's room line says what ITS launch decided.
//! In a file of its own because hub_rpc.rs is over code-quality.md's
//! 2000-line limit.

use super::*;

/// The notice is read after the start's refresh, from the files the launch
/// reads. Before #74 R1 it was read before: an old managed profile naming
/// the chat's provider A made the reading say "resumes", the refresh then
/// rewrote the profile without a provider, and the launch went fresh under
/// the config's B with no reason in the room.
#[test]
#[cfg(unix)]
fn the_restart_notice_is_the_launch_decision_after_the_refresh() {
    let session = format!("r74-{}", uuid::Uuid::new_v4());
    let ws = crate::config::test_scratch("tmm-r74");
    let wss = ws.to_string_lossy().to_string();
    let home = ws.join(".tmm/agents/cx");
    let codex = home.join("codex");
    let id = "01a1b6a1-7c52-7461-96ad-2b987988a3f6";
    std::fs::create_dir_all(codex.join("sessions/2026/11/07")).unwrap();
    let def = format!("r74-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    crate::projects::registry_save(&serde_json::json!({ "name": def, "backend": "codex", "model": "", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "command codex --profile tmm-agent", spawned_by: "", team: None, agent_def: &def, member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
    // The user's config (which the render links) is on B; the chat ran on A;
    // the old managed profile still names A.
    let user = crate::backends::codex::codex_user_home().join("config.toml");
    std::fs::write(&user, "model_provider = \"b\"\n").unwrap();
    std::fs::write(codex.join("config.toml"), "model_provider = \"b\"\n").unwrap();
    std::fs::write(codex.join(crate::backends::shared::codex_profile_file()), "model_provider = \"a\"\n").unwrap();
    let meta = serde_json::json!({ "type": "session_meta", "payload": { "id": id, "cwd": wss, "model_provider": "a" } });
    std::fs::write(codex.join(format!("sessions/2026/11/07/rollout-2026-11-07T15-29-58-{id}.jsonl")), format!("{meta}\n")).unwrap();
    crate::backends::codex::set_test_version(Some("0.166.0"));
    crate::projects::restore_hold::with_store_for_test(|st| {
        st.insert_project(&crate::projects::store::Project {
            id: session.clone(), name: session.clone(), path: wss.clone(), icon: None,
            session: session.clone(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })?;
        st.replace_slots(&session, &[crate::projects::store::Slot {
            id: None, ord: 0, window_name: "cx".into(), cwd: String::new(), kind: crate::projects::store::SlotKind::Agent,
            command: Some("codex".into()), auto_run: true, agent_session_id: Some(id.into()), first_seen_at: 1, settled_at: Some(2),
        }])
    }).unwrap();
    // Read before the refresh, as the start did before R1: the old profile's
    // A matches the chat, so it says nothing.
    assert_eq!(crate::projects::spawn::restart_notice::resume_notice_for(&session, "cx"), None, "the stale reading");
    let project = crate::projects::project_for_session(&session).unwrap().unwrap();
    let notice = std::cell::RefCell::new(None);
    let _ = resume_slot(&project, &session, "cx", None, Some(&notice));
    let said = notice.into_inner().expect("the launch's own reason");
    assert!(said.contains("started on a") && said.contains("now on b"), "{said}");
    let line = crate::projects::spawn::relaunch_line(&wss, "cx", Some(id), Some("codex")).unwrap().unwrap();
    assert!(!line.contains(" resume "), "the launch is fresh, as the room says: {line}");
    crate::backends::codex::set_test_version(None);
    crate::projects::restore_hold::with_store_for_test(|st| st.delete_project(&session)).ok();
    crate::projects::registry_delete(&def).ok();
    std::fs::remove_file(&user).ok();
    std::fs::remove_dir_all(&ws).ok();
}
