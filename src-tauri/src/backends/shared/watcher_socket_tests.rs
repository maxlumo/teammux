//! Board #140 (builder-2's diagnosis on #136): a startup-prompt watcher is a detached thread
//! that outlives its starter. It read the process-GLOBAL tmux socket on every poll, so once
//! another test (or anything) pointed the global elsewhere, it captured, and typed its accept
//! keys into, a same-named pane of THAT server. It is bound to the server it started on.
//! Validator note 12 (ruled, note 13): the proof counts every tmux command per SERVER (the
//! `tmux::CALLS` recorder), so a capture alone following the global is red too, and the
//! caller's closure TYPES (as a typed brief does), so its keys are proven to stay on A.
use super::{confirm_startup_prompt_or, StartupConfirmation};
use crate::tmux::test_support::{GlobalSocket, PrivateServer, PrivateTmux};
use std::time::{Duration, Instant};

/// Poll `cond` until it holds or `bound` passes (testing.md: wait for the fact, never a clock).
fn until(bound: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + bound;
    while !cond() {
        assert!(Instant::now() < deadline, "{what} within {bound:?}");
        std::thread::yield_now();
    }
}

/// Stop recording however the test ends.
struct Recording;
impl Drop for Recording {
    fn drop(&mut self) {
        *crate::tmux::CALLS.lock().unwrap() = None;
    }
}

#[test]
fn a_watcher_never_follows_the_global_socket_to_another_servers_same_named_pane() {
    let scope = GlobalSocket::hold();
    // A: the server the watcher is started for; its pane never shows the dialog, and echoes keys.
    let a = PrivateTmux::start(&scope, "w140-a");
    a.run(&["new-session", "-d", "-s", "w140", "-n", "w", "sh", "-c", "exec cat"]).unwrap();
    // B: another server with a SAME-NAMED pane that does paint the dialog, and echoes keys.
    let b = PrivateServer::new("w140-b");
    b.run(&["new-session", "-d", "-s", "w140", "-n", "w", "sh", "-c", "printf 'TRUST-THIS-140\\n'; exec cat"]).unwrap();
    let screen = |srv: &dyn Fn(&[&str]) -> Result<String, String>| srv(&["capture-pane", "-p", "-t", "w140:w"]).unwrap_or_default();
    until(Duration::from_secs(10), "B paints the dialog", || screen(&|x| b.run(x)).contains("TRUST-THIS-140"));
    let (a_sock, b_sock) = (a.socket().to_string(), b.socket.clone());

    let _recording = Recording;
    *crate::tmux::CALLS.lock().unwrap() = Some(Vec::new());
    let (tx, rx) = std::sync::mpsc::channel::<&'static str>();
    let (ready, timeout) = (tx.clone(), tx);
    let c = StartupConfirmation { markers: vec!["TRUST-THIS-140"], ready_markers: vec!["never-ready-140"], loading: None, accept_keys: vec!["x", "Enter"], timeout: Duration::from_millis(2500) };
    confirm_startup_prompt_or(
        "w140:w".into(),
        c,
        Some(Box::new(move || { let _ = ready.send("ready"); })),
        // The caller's closure types, through the global-resolving path a typed brief takes.
        Some(Box::new(move || {
            let _ = crate::tmux::send_keys("w140:w", "TYPED-140", true);
            let _ = timeout.send("timeout");
        })),
    );
    // The global moves on, as the next test (or another caller) moves it.
    scope.set(Some(b_sock.clone()));

    assert_eq!(rx.recv_timeout(Duration::from_secs(10)).ok(), Some("timeout"), "it watched A, where no dialog ever showed");
    let calls = crate::tmux::CALLS.lock().unwrap().take().unwrap_or_default();
    let on = |sock: &str| calls.iter().filter(|(s, _)| s.as_deref() == Some(sock)).collect::<Vec<_>>();
    let (on_a, on_b) = (on(&a_sock), on(&b_sock));
    assert!(on_b.is_empty(), "no tmux command of the watcher reached B: {on_b:?}");
    assert!(on_a.iter().any(|(_, args)| args.first().map(String::as_str) == Some("capture-pane")), "it captured A: {calls:?}");
    assert!(on_a.iter().any(|(_, args)| args.first().map(String::as_str) == Some("send-keys")), "its closure typed on A: {calls:?}");
    until(Duration::from_secs(10), "the closure's line reaches A's pane", || screen(&|x| a.run(x)).contains("TYPED-140"));
    let b_screen = screen(&|x| b.run(x));
    assert!(!b_screen.contains("TYPED-140") && !b_screen.lines().any(|l| l.trim() == "x"), "nothing reached B's same-named pane:\n{b_screen}");
    scope.set(Some(a_sock));
}
