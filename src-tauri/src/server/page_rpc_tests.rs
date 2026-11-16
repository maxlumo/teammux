//! Board #111: the page doors on a real project (real tmux for the session,
//! a managed home, the test store), and the cap through the existing scope door.

use super::super::download::handle_http_download;
use super::super::hub_rpc::handle_hub_request;
use super::super::rpc::handle_request;
use super::super::test_util::req;
use serde_json::{json, Value};
use std::sync::Arc;

struct Rig {
    session: String,
    ws: std::path::PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.session)]).stderr(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.ws);
    }
}

impl Rig {
    fn start(tag: &str) -> Option<Rig> {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-{tag}-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch(&format!("tmm-{tag}-ws"));
        std::fs::create_dir_all(&ws).unwrap();
        let ws = ws.canonicalize().unwrap();
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "keep", "-c", &ws.to_string_lossy(), "bash --norc --noprofile"])
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eprintln!("no tmux server — skipping");
            return None;
        }
        let rig = Rig { session, ws };
        crate::projects::adopt(&rig.session, Some(tag)).expect("adopt project");
        let home = rig.ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: "true", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
        Some(rig)
    }
    fn call(&self, method: &str, mut params: Value) -> Result<Value, String> {
        params["session"] = json!(self.session);
        let r = handle_request(&req(method, params), "tok");
        match r.error {
            Some(e) => Err(e.message),
            None => Ok(r.result.unwrap_or(Value::Null)),
        }
    }
    fn dashboard(&self) -> Value {
        let r = handle_hub_request(&req("hub_dashboard", json!({ "session": self.session })), None);
        r.result.unwrap_or_else(|| panic!("hub_dashboard: {:?}", r.error.map(|e| e.message)))
    }
    fn bundle(&self, html: &str) -> String {
        let dir = self.ws.join("work/page");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), html).unwrap();
        std::fs::write(dir.join("style.css"), "h1{color:red}").unwrap();
        dir.to_string_lossy().into_owned()
    }
}

async fn get(target: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut client, server) = tokio::io::duplex(1 << 16);
    client.write_all(format!("GET {target} HTTP/1.1\r\nHost: h\r\n\r\n").as_bytes()).await.unwrap();
    handle_http_download(server, "127.0.0.1:1".parse().unwrap(), Arc::new("tok".into())).await;
    let mut out = String::new();
    client.read_to_string(&mut out).await.unwrap();
    out
}

#[test]
fn a_published_page_is_the_dashboards_head_and_loads_with_its_door() {
    let Some(rig) = Rig::start("page-rpc") else { return };
    assert_eq!(rig.dashboard()["page"], Value::Null, "no page yet");
    let dir = rig.bundle("<h1>hello</h1>");
    let r = rig.call("page_publish", json!({ "dir": dir, "who": "dev" })).unwrap();
    assert_eq!((r["rev"].as_u64(), r["files"].as_u64(), r["by"].as_str()), (Some(1), Some(2), Some("dev")));
    let head = rig.dashboard()["page"].clone();
    assert_eq!((head["rev"].as_u64(), head["by"].as_str()), (Some(1), Some("dev")));
    assert!(head["at"].as_u64().is_some());
    assert!(head.get("html").is_none(), "the dashboard read carries only the head");
    let page = rig.call("page_load", json!({})).unwrap()["page"].clone();
    assert_eq!(page["html"], "<h1>hello</h1>");
    assert_eq!(page["dir"], format!("{}/.tmm/dashboard/1", rig.ws.display()));
    let base = page["base"].as_str().unwrap().to_string();
    assert!(base.starts_with("/dl/s/") && base.ends_with("/.tmm/dashboard/1/"), "{base}");
    // The page's own file and a project file by `../../../`, through the ONE scope door.
    std::fs::create_dir_all(rig.ws.join("EP/out")).unwrap();
    std::fs::write(rig.ws.join("EP/out/cover.png"), "PNG").unwrap();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let css = rt.block_on(get(&format!("{base}style.css")));
    assert!(css.starts_with("HTTP/1.1 200 OK\r\n") && css.contains("Content-Type: text/css") && css.ends_with("h1{color:red}"), "{css}");
    let project_root = base.trim_end_matches(".tmm/dashboard/1/");
    let png = rt.block_on(get(&format!("{project_root}EP/out/cover.png")));
    assert!(png.starts_with("HTTP/1.1 200 OK\r\n") && png.ends_with("PNG"), "{png}");
    let doc = rt.block_on(get(&format!("{base}index.html")));
    assert!(doc.starts_with("HTTP/1.1 403"), "never a document off the door: {doc}");
}

#[test]
fn the_publisher_is_checked_at_the_door_and_a_refusal_writes_nothing() {
    let Some(rig) = Rig::start("page-who") else { return };
    let dir = rig.bundle("<p>x</p>");
    let e = rig.call("page_publish", json!({ "dir": dir, "who": "stranger" })).unwrap_err();
    assert!(e.contains("'stranger' is not a managed agent of this project"), "{e}");
    assert!(rig.call("page_publish", json!({ "dir": dir, "who": 7 })).unwrap_err().contains("who: a string"));
    assert!(rig.call("page_publish", json!({ "dir": "work/page", "who": "dev" })).unwrap_err().contains("dir: an absolute folder path"));
    assert!(rig.call("page_publish", json!({ "dir": format!("{}/nowhere", rig.ws.display()), "who": "dev" })).unwrap_err().contains("nothing was published"));
    assert!(!rig.ws.join(".tmm/dashboard/page.json").exists(), "no refusal wrote the store");
    // The person publishes as human (absent `who`).
    assert_eq!(rig.call("page_publish", json!({ "dir": dir })).unwrap()["by"], "human");
    let e = handle_request(&req("page_load", json!({ "session": "no-such-session" })), "tok").error.unwrap().message;
    assert!(e.contains("no project for session"), "{e}");
}

#[test]
fn unpublish_makes_no_page_reachable_and_an_unreadable_store_is_not_no_page() {
    let Some(rig) = Rig::start("page-down") else { return };
    let dir = rig.bundle("<p>x</p>");
    assert_eq!(rig.call("page_unpublish", json!({ "who": "dev" })).unwrap()["rev"], Value::Null);
    rig.call("page_publish", json!({ "dir": dir, "who": "dev" })).unwrap();
    assert_eq!(rig.call("page_unpublish", json!({ "who": "dev" })).unwrap()["rev"], 1);
    assert_eq!(rig.dashboard()["page"], Value::Null);
    assert_eq!(rig.call("page_load", json!({})).unwrap()["page"], Value::Null);
    std::fs::write(rig.ws.join(".tmm/dashboard/page.json"), "{broken").unwrap();
    let d = rig.dashboard();
    assert!(d.get("page").is_none(), "an unreadable store never reads as 'no page'");
    assert!(d["page_error"].as_str().unwrap().contains("page.json is not readable"), "{d}");
    assert!(d["asks"].is_array(), "the rest of the dashboard read stands");
}

#[test]
fn the_login_announces_the_page_doors() {
    assert!(super::super::LOGIN_CAPS.contains(&"dashboard_page"));
}

/// S1 (#111 note 11, leader note 12): the page goes through the scope door's
/// ONE wide-root gate. A project whose folder is the home directory gets no
/// page: publish refuses, and a store already there is neither a head nor a
/// load.
#[test]
fn a_project_at_home_gets_no_page() {
    crate::projects::tests::use_test_store();
    let home = dirs::home_dir().unwrap().canonicalize().unwrap();
    assert!(crate::fs::too_wide(&home) && crate::fs::too_wide(std::path::Path::new("/")));
    let session = format!("tmm-page-home-{}", uuid::Uuid::new_v4());
    let ok = std::process::Command::new("tmux")
        .args(["new-session", "-d", "-s", &session, "-n", "keep", "-c", &home.to_string_lossy(), "bash --norc --noprofile"])
        .status().is_ok_and(|s| s.success());
    if !ok { eprintln!("no tmux server — skipping"); return; }
    struct Kill(String);
    impl Drop for Kill { fn drop(&mut self) { let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).status(); } }
    let _kill = Kill(session.clone());
    crate::projects::adopt(&session, Some("home-proj")).expect("adopt");
    let project = crate::projects::project_for_session(&session).unwrap().unwrap();
    assert_eq!(std::path::Path::new(&project.path).canonicalize().unwrap(), home, "the project's folder IS home");
    let page = home.join("work-page");
    std::fs::create_dir_all(&page).unwrap();
    std::fs::write(page.join("index.html"), "<p>x</p>").unwrap();
    let call = |method: &str, params: Value| {
        let mut params = params;
        params["session"] = json!(session);
        let r = handle_request(&req(method, params), "tok");
        r.error.map(|e| Err(e.message)).unwrap_or_else(|| Ok(r.result.unwrap_or(Value::Null)))
    };
    let e = call("page_publish", json!({ "dir": page.to_string_lossy() })).unwrap_err();
    assert!(e.contains("too wide") && e.contains("nothing was published"), "{e}");
    assert!(!home.join(".tmm/dashboard").exists(), "nothing written");
    // A store made by hand (or by an older gateway) is still no page.
    crate::projects::page::publish(&home, &page, "human", 1000, &|| 1).unwrap();
    assert_eq!(call("page_load", json!({})).unwrap()["page"], Value::Null);
    let r = handle_hub_request(&req("hub_dashboard", json!({ "session": session })), None);
    assert_eq!(r.result.unwrap()["page"], Value::Null);
    let _ = std::fs::remove_dir_all(home.join(".tmm/dashboard"));
    let _ = std::fs::remove_dir_all(&page);
}
