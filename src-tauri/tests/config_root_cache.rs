//! Board #472, B1: the configuration root is decided ONCE per process. One test in this file,
//! because the answer is process-wide: the choice is made on a base that holds only the old
//! directory, then the disk changes underneath it. A process that probed again would see two
//! different places and refuse, or switch to the other name and read another token.
#![cfg(target_os = "linux")]

#[test]
fn a_later_change_on_disk_does_not_re_choose_the_root() {
    let base = std::env::temp_dir().join(format!("config-root-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("tmux-mobile")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &base);
    std::env::set_var("HOME", &base);

    let first = tmux_mobile::config::init_root().expect("only the old directory: it is the root");
    assert_eq!(first, base.join("tmux-mobile"));

    // Another process now creates the other name, a DIFFERENT place: a second look would refuse.
    std::fs::create_dir_all(base.join("teammux")).unwrap();
    assert_eq!(tmux_mobile::config::config_dir(), first, "the consumers keep the first answer");
    assert_eq!(tmux_mobile::config::init_root().unwrap(), first, "asking again returns the same answer, not a refusal");

    // And the chosen directory disappearing changes nothing either.
    std::fs::remove_dir_all(base.join("tmux-mobile")).unwrap();
    assert_eq!(tmux_mobile::config::config_dir(), first);
    let _ = std::fs::remove_dir_all(&base);
}
