//! Board #472, B1: a REFUSAL is decided once too. One test in this file (the answer is
//! process-wide): the base starts ambiguous, one of the two directories is then removed, and
//! this process still refuses, so it never starts on a root it did not choose at the start.
#![cfg(target_os = "linux")]

#[test]
fn a_refusal_is_remembered_and_its_consumers_stop_loudly() {
    let base = std::env::temp_dir().join(format!("config-root-refusal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("teammux")).unwrap();
    std::fs::create_dir_all(base.join("tmux-mobile")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &base);
    std::env::set_var("HOME", &base);

    let first = tmux_mobile::config::init_root().unwrap_err();
    assert!(first.contains("Two configuration directories exist"), "{first}");

    std::fs::remove_dir_all(base.join("teammux")).unwrap();
    assert_eq!(tmux_mobile::config::init_root().unwrap_err(), first, "the same refusal, not a fresh look");
    let stray = std::panic::catch_unwind(tmux_mobile::config::config_dir);
    assert!(stray.is_err(), "a consumer that never called init_root stops loudly instead of using another root");
    let _ = std::fs::remove_dir_all(&base);
}
