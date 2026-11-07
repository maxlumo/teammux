//! A hook envelope past the read ceiling (board #65 item 1).
//!
//! Over MAX_INBOX_BYTES (256 KiB) an envelope used to be refused whole as
//! `payload too large`, losing its turn end and reply with one server log
//! line. Up to MAX_HOOK_PAYLOAD_BYTES it is now read and consumed like any
//! other (the reply is stored cut, #42). Past it only its HEAD is read: the
//! helper writes `{"backend":…,"pane_id":…,["tmm_tmux":…,]["launch":…,]`
//! first, in plain characters, then `"payload":`. That head is judged by the
//! SAME pane, incarnation and restore-launch attribution as every envelope
//! (validator P1 on round 0): another server's stays in the inbox, a stale
//! incarnation's is dropped, one that cannot be judged is kept, and only an
//! envelope this gateway owns gets the one room notice.

use super::{AgentNotificationHub, Consume, InboxEnvelope};
use std::path::Path;

/// The ceiling on one envelope that is still READ: 32 times the old bound
/// and about 570 times the largest real reply measured (14 634 chars, #42),
/// so only a runaway reaches it; it bounds what one read holds in memory.
pub(super) const MAX_HOOK_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// The whole envelope, as before.
pub(super) fn whole_envelope(path: &Path) -> Result<InboxEnvelope, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("invalid envelope: {e}"))
}

/// The envelope's head only, its payload left out (null).
pub(super) fn head_envelope(path: &Path) -> Result<InboxEnvelope, String> {
    use std::io::Read;
    let mut head = vec![0u8; 4096];
    let got = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).map_err(|e| e.to_string())?;
    let head = String::from_utf8_lossy(&head[..got]);
    let at = head.find("\"payload\":").ok_or("payload too large, and its head names no payload")?;
    serde_json::from_str(&format!("{}\"payload\":null}}", &head[..at])).map_err(|e| format!("payload too large, and its head is not an envelope: {e}"))
}

/// Refuse an attributed envelope that was not read: the room says so once,
/// as the agent's own `[tmm]` line to the human, for a managed window.
pub(super) fn refuse(hub: &AgentNotificationHub, envelope: &InboxEnvelope, bytes: u64) -> Consume {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some((session, window, _)) = envelope.resolved.as_ref() {
        let poster = hub.state.lock().unwrap().poster.clone();
        if let (Some(poster), Some(_)) = (poster, crate::projects::managed_home(session, window)) {
            let body = format!(
                "[tmm] a hook payload of {:.1} MiB was over the {} MiB limit and was not read: this turn's end and reply were not recorded",
                bytes as f64 / (1024.0 * 1024.0),
                MAX_HOOK_PAYLOAD_BYTES / (1024 * 1024)
            );
            if let Err(e) = poster.post_final(session, window, &body, &[crate::address::HUMAN.to_string()]) {
                eprintln!("⚠  the oversized-payload notice of {session}:{window} was not recorded in the room: {e}");
            }
        }
    }
    Consume::Drop(format!("payload too large ({bytes} bytes, over the {} MiB limit)", MAX_HOOK_PAYLOAD_BYTES / (1024 * 1024)))
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::MAX_HOOK_PAYLOAD_BYTES;
    use serde_json::json;

    /// Board #65 item 1: a hook payload over the inbox bound used to be
    /// refused whole ("payload too large"), losing that turn's end AND its
    /// reply with only a server log line. Up to MAX_HOOK_PAYLOAD_BYTES it is
    /// consumed like any other: the turn ends and the reply is stored cut
    /// with its marker. Past that it is refused, and the room says so once.
    #[test]
    fn an_oversized_hook_payload_still_ends_its_turn_and_a_runaway_one_is_said() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-big-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch("tmm-big-ws");
        struct Teardown(String, Vec<std::path::PathBuf>);
        impl Drop for Teardown {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                for d in &self.1 {
                    let _ = std::fs::remove_dir_all(d);
                }
            }
        }
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let root = crate::config::test_scratch("tmm-big-hub");
        let _teardown = Teardown(session.clone(), vec![ws.clone(), root.clone()]);
        assert!(crate::projects::adopt(&session, Some("big-test")).is_ok(), "the project is adopted");
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
        let (_, win, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let mut n = 0;
        let mut feed = |payload: Value| {
            n += 1;
            let bytes = serde_json::to_vec(&json!({"backend": "claude", "pane_id": pane_id, "payload": payload})).unwrap();
            std::fs::write(inbox.join(format!("{n}-ev.json")), &bytes).unwrap();
            hub.consume_inbox();
            bytes.len()
        };
        let rows = || {
            let page = crate::projects::rooms::history_page(&crate::projects::rooms::session_room(&session), None, 10);
            page["messages"].as_array().unwrap().iter().map(|m| m["body"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>()
        };
        let status = || crate::projects::telemetry::derive(&session, "dev", 0);

        // 1. 300 KiB of reply: over the old 256 KiB inbox bound.
        let asked = "[tmm chat 2026-11-07 19:10] human: @dev write it all out";
        hub.start_turn(&session, &win, reply_targets("", asked));
        feed(json!({"hook_event_name": "UserPromptSubmit", "prompt": asked, "session_id": "c1"}));
        assert_eq!(status().state, "running");
        let size = feed(json!({"hook_event_name": "Stop", "last_assistant_message": "x".repeat(300 * 1024), "session_id": "c1"}));
        assert!(size as u64 > 256 * 1024, "the envelope is past the old bound: {size}");
        assert_eq!(status().state, "idle", "the turn ended");
        assert!(rows().iter().any(|b| b.ends_with("[reply cut at 256 KiB]")), "the reply is stored, cut, and says so");

        // 2. A runaway payload past the ceiling: refused, and said once.
        feed(json!({"hook_event_name": "UserPromptSubmit", "prompt": asked, "session_id": "c1"}));
        let size = feed(json!({"hook_event_name": "Stop", "last_assistant_message": "y".repeat(9 * 1024 * 1024), "session_id": "c1"}));
        assert!(size as u64 > MAX_HOOK_PAYLOAD_BYTES);
        let said: Vec<String> = rows().into_iter().filter(|b| b.starts_with("[tmm] a hook payload")).collect();
        assert_eq!(said, vec!["[tmm] a hook payload of 9.0 MiB was over the 8 MiB limit and was not read: this turn's end and reply were not recorded".to_string()]);
        assert_eq!(std::fs::read_dir(&inbox).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "json")).count(), 0, "the file is gone, not retried");
    }

    /// Validator P1 on round 0: an over-limit envelope is judged by its head
    /// with the same attribution as any other BEFORE a notice. Another
    /// server's stays in the inbox, a stale incarnation's is dropped, and
    /// neither posts; only one this gateway owns gets the one line.
    #[test]
    fn an_oversized_envelope_is_attributed_before_any_notice() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-bigown-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch("tmm-bigown-ws");
        struct Teardown(String, Vec<std::path::PathBuf>);
        impl Drop for Teardown {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                for d in &self.1 {
                    let _ = std::fs::remove_dir_all(d);
                }
            }
        }
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status()
            .is_ok_and(|s| s.success());
        let root = crate::config::test_scratch("tmm-bigown-hub");
        let _teardown = Teardown(session.clone(), vec![ws.clone(), root.clone()]);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        crate::projects::adopt(&session, Some("bigown-test")).expect("adopt");
        let pane_id = String::from_utf8(std::process::Command::new("tmux").args(["display-message", "-p", "-t", &session, "#{pane_id}"]).output().unwrap().stdout).unwrap().trim().to_string();
        struct Count(std::sync::Mutex<usize>);
        impl RoomPoster for Count {
            fn post_final(&self, _: &str, _: &str, _: &str, _: &[String]) -> Result<(), String> {
                *self.0.lock().unwrap() += 1;
                Ok(())
            }
        }
        let posts = std::sync::Arc::new(Count(std::sync::Mutex::new(0)));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.set_room_poster(posts.clone());
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let me = crate::tmux::server_incarnation().expect("the private server answers");
        let big = "z".repeat(MAX_HOOK_PAYLOAD_BYTES as usize + 1024);
        // In the helper's own order: identity first, the payload last.
        let write = |name: &str, made_by: &str| {
            let payload = json!({"hook_event_name": "Stop", "last_assistant_message": big});
            let path = inbox.join(format!("{name}.json"));
            std::fs::write(&path, format!(r#"{{"backend":"claude","pane_id":"{pane_id}","tmm_tmux":"{made_by}","payload":{payload}}}"#)).unwrap();
            path
        };
        let count = || *posts.0.lock().unwrap();

        let foreign = write("1-foreign", &format!("/tmp/tmm-b2-nowhere-{}.sock,1,1", std::process::id()));
        hub.consume_inbox();
        assert!(foreign.exists(), "another server's envelope stays in the inbox");
        assert_eq!(count(), 0, "and says nothing here");
        std::fs::remove_file(&foreign).unwrap();

        let stale = write("2-stale", &format!("{},{},{}", me.socket, me.pid, me.start + 1));
        hub.consume_inbox();
        assert!(!stale.exists(), "a stale incarnation's is dropped");
        assert_eq!(count(), 0, "with no notice");

        let own = write("3-own", &format!("{},{},{}", me.socket, me.pid, me.start));
        hub.consume_inbox();
        assert!(!own.exists());
        assert_eq!(count(), 1, "only an owned envelope gets the one line");
    }
}
