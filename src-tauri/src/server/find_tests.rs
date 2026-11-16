//! Board #144: the RPC finds a reference under the session's DECLARED project root, which the
//! server derives (the client never sends a root); a bad reference is refused at the door.
use super::rpc::handle_request;
use super::test_util::req;
use serde_json::json;

#[test]
fn the_rpc_finds_the_reference_under_the_sessions_declared_root() {
    crate::projects::tests::use_test_store();
    let root = crate::config::test_scratch("find-rpc");
    std::fs::create_dir_all(root.join("worktree/w1/temp/111")).unwrap();
    std::fs::write(root.join("worktree/w1/temp/111/out.png"), "x").unwrap();
    let wanted = format!("find-rpc-{}", uuid::Uuid::new_v4());
    let created = crate::projects::create(&root.to_string_lossy(), Some(&wanted), Some(&wanted), None).unwrap();
    let session = created["session"].as_str().expect("the project's session").to_string();
    let r = handle_request(&req("fs_find_tail", json!({ "session": session, "ref": "temp/111/out.png" })), "tok");
    let v = r.result.unwrap_or_else(|| panic!("answered: {:?}", r.error.map(|e| e.message)));
    assert_eq!(v["matches"], json!(["worktree/w1/temp/111/out.png"]), "{v}");
    assert_eq!(v["more"], false);
    assert!(v.get("stopped").is_none());
    assert_eq!(v["root"].as_str(), Some(std::fs::canonicalize(&root).unwrap().to_string_lossy().as_ref()));
    for bad in ["../x", "/etc/passwd", "~/x"] {
        let r = handle_request(&req("fs_find_tail", json!({ "session": session, "ref": bad })), "tok");
        assert!(r.result.is_none() && r.error.is_some(), "{bad} refused");
    }
    let _ = std::fs::remove_dir_all(&root);
}
