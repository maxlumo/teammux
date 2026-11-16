//! Board #508: `ensure_socket_dir` and tmux's socket diagnostic. No tmux
//! is run here; every directory is a private scratch one.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn mode(p: &Path) -> u32 {
    std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777
}

/// `<scratch>/sockdir/tmm.sock` with `<scratch>` made 0700, `sockdir` absent.
fn fixture(tag: &str) -> (PathBuf, PathBuf, String) {
    let grand = crate::config::test_scratch(&format!("tmm-sockdir-{tag}"));
    std::fs::create_dir_all(&grand).unwrap();
    std::fs::set_permissions(&grand, std::fs::Permissions::from_mode(0o700)).unwrap();
    let dir = grand.join("sockdir");
    let socket = dir.join("tmm.sock").to_string_lossy().to_string();
    (grand, dir, socket)
}

fn with_umask<T>(m: libc::mode_t, f: impl FnOnce() -> T) -> T {
    let old = unsafe { libc::umask(m) };
    let r = f();
    unsafe { libc::umask(old) };
    r
}

#[test]
fn a_missing_socket_dir_is_made_private_and_verified_again_at_every_call() {
    let (grand, dir, socket) = fixture("make");
    assert!(!dir.exists());
    with_umask(0o022, || ensure_socket_dir(&socket)).unwrap();
    assert!(std::fs::symlink_metadata(&dir).unwrap().is_dir());
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&grand), 0o700, "the parent above is never changed");
    ensure_socket_dir(&socket).unwrap();
    // Verified again, never remembered: the same path made wide is refused now.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ensure_socket_dir(&socket).is_err());
    std::fs::remove_dir_all(&grand).ok();
}

#[test]
fn an_existing_socket_dir_that_is_not_private_is_refused_and_left_as_it_is() {
    // 0755: refused, mode unchanged.
    let (grand, dir, socket) = fixture("wide");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = ensure_socket_dir(&socket).unwrap_err();
    assert_eq!(e, "its mode is 755; other users can reach it (tmux's own is 700)");
    assert_eq!(mode(&dir), 0o755);
    std::fs::remove_dir_all(&grand).ok();

    // A link to a private directory of ours: refused, link and target unchanged.
    let (grand, dir, socket) = fixture("link");
    let target = grand.join("real");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&target, &dir).unwrap();
    assert_eq!(ensure_socket_dir(&socket).unwrap_err(), "it is a link");
    assert_eq!(std::fs::read_link(&dir).unwrap(), target);
    assert_eq!((mode(&target), std::fs::read_dir(&target).unwrap().count()), (0o700, 0));
    std::fs::remove_dir_all(&grand).ok();

    // A regular file: refused, content unchanged.
    let (grand, dir, socket) = fixture("file");
    std::fs::write(&dir, "not a dir").unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(ensure_socket_dir(&socket).unwrap_err(), "it is not a directory");
    assert_eq!((std::fs::read_to_string(&dir).unwrap().as_str(), mode(&dir)), ("not a dir", 0o600));
    std::fs::remove_dir_all(&grand).ok();

    // Another owner (the seam stands in for a chown we cannot do): refused, unchanged.
    let (grand, dir, socket) = fixture("owner");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let other = crate::safe_fs::euid() + 1;
    *SOCKET_DIR_OWNER.lock().unwrap() = Some(other);
    let r = ensure_socket_dir(&socket);
    *SOCKET_DIR_OWNER.lock().unwrap() = None;
    assert_eq!(r.unwrap_err(), format!("it belongs to uid {}, not this user", crate::safe_fs::euid()));
    assert_eq!(mode(&dir), 0o700);
    ensure_socket_dir(&socket).unwrap();
    std::fs::remove_dir_all(&grand).ok();
}

#[test]
fn a_missing_grandparent_or_a_relative_socket_is_refused_and_nothing_is_made() {
    let (grand, _, _) = fixture("grand");
    let missing = grand.join("gone");
    let socket = missing.join("sockdir/tmm.sock").to_string_lossy().to_string();
    assert_eq!(ensure_socket_dir(&socket).unwrap_err(), format!("its parent {} does not exist", missing.display()));
    assert!(!missing.exists(), "nothing was created");
    // A relative path whose parent exists (the test's working directory):
    // refused before anything is resolved.
    let name = format!("tmm-rel-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let rel = format!("./{name}/tmm.sock");
    let made = std::env::current_dir().unwrap().join(&name);
    let r = ensure_socket_dir(&rel);
    let created = made.exists();
    std::fs::remove_dir(&made).ok();
    assert_eq!(r.unwrap_err(), "the socket path is relative");
    assert!(!created, "nothing was created under the working directory");
    std::fs::remove_dir_all(&grand).ok();
}

#[test]
fn a_dir_a_concurrent_creator_made_first_is_verified_not_assumed() {
    for (m, ok) in [(0o700, true), (0o755, false)] {
        let (grand, dir, socket) = fixture("race");
        *BEFORE_SOCKET_MKDIR.lock().unwrap() = Some(Box::new(move |d: &Path| {
            std::fs::create_dir(d).unwrap();
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(m)).unwrap();
        }));
        let r = ensure_socket_dir(&socket);
        *BEFORE_SOCKET_MKDIR.lock().unwrap() = None;
        assert_eq!(r.is_ok(), ok, "mode {m:o}: {r:?}");
        assert_eq!(mode(&dir), m, "left as the other creator made it");
        std::fs::remove_dir_all(&grand).ok();
    }
}

#[test]
fn only_tmuxs_exact_socket_diagnostic_for_this_socket_is_classified() {
    let s = "/tmp/tmux-1000/default";
    let enoent = Some("No such file or directory".to_string());
    assert_eq!(socket_create_error("error creating /tmp/tmux-1000/default (No such file or directory)\n", s), enoent);
    assert_eq!(socket_create_error("  error creating /tmp/tmux-1000/default (Permission denied)  ", s), Some("Permission denied".into()));
    for other in [
        "",
        "error creating /tmp/tmux-1000/other (No such file or directory)",
        "error creating /tmp/tmux-1000/default (No such file or directory)\nsomething else",
        "warning\nerror creating /tmp/tmux-1000/default (No such file or directory)",
        "error creating /tmp/tmux-1000/default (No such file or directory) trailing",
        "error creating /tmp/tmux-1000/default (a (b) c)",
        "error creating /tmp/tmux-1000/default ()",
        "error creating /tmp/tmux-1000/defaultX (No such file or directory)",
        "no server running on /tmp/tmux-1000/default",
    ] {
        assert_eq!(socket_create_error(other, s), None, "{other:?}");
    }
    let long = format!("error creating {s} ({})", "x".repeat(121));
    assert_eq!(socket_create_error(&long, s), None);
    let edge = format!("error creating {s} ({})", "x".repeat(120));
    assert_eq!(socket_create_error(&edge, s), Some("x".repeat(120)));
}
