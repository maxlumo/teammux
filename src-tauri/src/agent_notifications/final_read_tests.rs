//! Board #121 (validator's note 7, leader's ruling): a numbered Stop whose project
//! read FAILS is not consumed. Through the REAL inbox ingestion: the envelope stays,
//! the window's mark does not move, no final is stored; once the read recovers the
//! next pass posts the final once, in the project's own room, with its reply edge.
//! In a file of its own because agent_notifications.rs is over the size limit.

// The recipe door pin (recipe.rs) reads an inline `mod tests` as test code.
#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::json;

    #[test]
    fn a_numbered_stop_whose_project_read_fails_is_kept_and_its_final_lands_once_after_recovery() {
        crate::projects::tests::use_test_store();
        // The window's mark is durable here, as in production (tests keep it off by default).
        struct Marks;
        impl Drop for Marks {
            fn drop(&mut self) {
                crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
            }
        }
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let _marks = Marks;
        let session = format!("tmm-121-final-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch("tmm-121-final-ws");
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status()
            .is_ok_and(|s| s.success());
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        struct Teardown(String, std::path::PathBuf);
        impl Drop for Teardown {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let root = crate::config::test_scratch("tmm-121-final-hub");
        let _teardown = Teardown(session.clone(), ws.clone());
        assert!(crate::projects::adopt(&session, Some("final-121")).is_ok(), "the project is adopted");
        let room = crate::projects::rooms::session_room(&session).unwrap();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux").args(["display-message", "-p", "-t", &session, "#{pane_id}"]).output().unwrap().stdout,
        ).unwrap().trim().to_string();
        struct Real;
        impl RoomPoster for Real {
            fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String> {
                crate::server::post_final_for_test(session, agent, body, reply_to, |_, _| {})
            }
        }
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.set_room_poster(std::sync::Arc::new(Real));
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let write = |seq: u64, payload: Value| {
            let mut payload = payload;
            payload["tmm_seq"] = json!(seq);
            let bytes = serde_json::to_vec(&json!({"backend": "claude", "pane_id": pane_id, "payload": payload})).unwrap();
            std::fs::write(inbox.join(format!("{seq}-ev.json")), &bytes).unwrap();
        };
        let finals = || -> Vec<(String, Value)> {
            crate::projects::rooms::history_page(&room, None, 20)["messages"].as_array().unwrap().iter()
                .filter(|m| m["body"] == "the answer 121")
                .map(|m| (m["from"].as_str().unwrap_or("").to_string(), m["to"].clone()))
                .collect()
        };
        let in_inbox = || std::fs::read_dir(&inbox).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "json")).count();
        let asked = "[tmm chat 2026-11-12 14:00] lead: @dev answer it";
        write(1, json!({"hook_event_name": "UserPromptSubmit", "prompt": asked, "session_id": "c121"}));
        hub.consume_inbox();
        assert_eq!(crate::projects::telemetry::hook_mark(&session, "dev").unwrap(), 1, "the prompt is accepted");

        write(2, json!({"hook_event_name": "Stop", "last_assistant_message": "the answer 121", "session_id": "c121"}));
        {
            let _away = crate::projects::tests::ProjectsUnreadable::now();
            hub.consume_inbox();
        }
        assert!(finals().is_empty(), "no final while the project could not be read");
        assert_eq!(in_inbox(), 1, "the Stop is kept, not consumed");
        assert_eq!(crate::projects::telemetry::hook_mark(&session, "dev").unwrap(), 1, "the mark did not move");

        hub.consume_inbox();
        assert_eq!(finals(), vec![("dev".to_string(), json!(["lead"]))], "the final lands once, with its reply edge");
        assert_eq!(in_inbox(), 0);
        assert_eq!(crate::projects::telemetry::hook_mark(&session, "dev").unwrap(), 2);
        hub.consume_inbox();
        assert_eq!(finals().len(), 1, "never twice");
    }
}
