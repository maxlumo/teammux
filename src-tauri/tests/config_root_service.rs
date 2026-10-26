//! Board #472, B1: the root the gateway service records, through the REAL service code. Both
//! names are links to one directory on another disk; the process asks `Sys::real()` for its
//! identity and the spec of a service, renders the unit, and then a child that gets only the
//! environment the unit records picks the same root. One test in this file (the root is
//! process-wide).
#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::Command;

#[test]
fn the_unit_records_the_base_and_the_log_lives_in_the_chosen_root() {
    let top = std::env::temp_dir().join(format!("config-root-service-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&top);
    let base = top.join("cfg");
    let ext = top.join("disk/state");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::create_dir_all(&ext).unwrap();
    std::os::unix::fs::symlink(&ext, base.join("teammux")).unwrap();
    std::os::unix::fs::symlink(&ext, base.join("tmux-mobile")).unwrap();
    std::fs::create_dir_all(top.join("home")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &base);
    std::env::set_var("HOME", top.join("home"));

    use tmux_mobile::gateway::service::{render_systemd, unit_identity, Sys};
    let sys = Sys::real().expect("the real system for this process");
    assert_eq!(sys.root, base.join("teammux"), "the logical root, never the disk the links lead to");
    assert_eq!(sys.me.config_home, base.to_string_lossy(), "the identity's XDG base is the base as given");
    let spec = sys.spec("teammux-gateway-test.service");
    assert_eq!(spec.log, base.join("teammux/gateway.log").to_string_lossy(), "the log is under the chosen root");

    let unit = render_systemd(&spec).unwrap();
    let recorded = unit_identity(&unit).unwrap().config_home;
    assert_eq!(recorded, base.to_string_lossy(), "the unit records the base, never /disk/state");

    let out = Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(["gateway", "status"])
        .env_clear()
        .env("HOME", top.join("home"))
        .env("XDG_CONFIG_HOME", &recorded)
        .env("PATH", "/usr/bin:/bin")
        .env("TMUX_TMPDIR", top.join("home"))
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let line = text.lines().find(|l| l.starts_with("config ")).unwrap_or("").trim_start_matches("config").trim().to_string();
    assert_eq!(Path::new(&line), base.join("teammux"), "the service's process picks the same root: {text}");
    let _ = std::fs::remove_dir_all(&top);
}
