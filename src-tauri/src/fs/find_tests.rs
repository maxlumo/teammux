//! Board #144: the owner's rule, a literal table. "必须后边完全匹配才算": a candidate is
//! <root>/<one or more folders>/<ref>, the ref matching as WHOLE trailing segments.
use super::*;
use std::path::Path;

fn tree(tag: &str, files: &[&str], dirs: &[&str]) -> std::path::PathBuf {
    let root = crate::config::test_scratch(&format!("find-{tag}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    for d in dirs { std::fs::create_dir_all(root.join(d)).unwrap(); }
    for f in files {
        let p = root.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }
    std::fs::canonicalize(root).unwrap()
}

fn find(root: &Path, r: &str) -> Found {
    find_tail(root, r, LIMITS).unwrap()
}

#[test]
fn whole_trailing_segments_match_at_any_depth_and_nothing_else_does() {
    let root = tree("table", &["x/b/c.txt", "x/y/b/c.txt", "x/ab/c.txt", "b/c.txt.bak", "q/B/c.txt", "z/b/c.txt/inner"], &[]);
    let got = find(&root, "b/c.txt");
    assert_eq!(got.matches, vec!["x/b/c.txt", "z/b/c.txt", "x/y/b/c.txt"], "nearest first, then by name; never x/ab/c.txt, b/c.txt.bak or q/B/c.txt (case-sensitive)");
    assert!(!got.more);
    assert_eq!(got.stopped, None);
}

#[test]
fn a_directory_matches_too_and_the_root_itself_is_not_a_candidate() {
    let root = tree("dirs", &["b/c.txt"], &["w/b"]);
    assert_eq!(find(&root, "b").matches, vec!["w/b"], "a folder named by the ref; the root's own b is today's lookup, not a candidate");
}

#[test]
fn stores_are_not_entered_and_ignored_folders_are() {
    let root = tree("skip", &["node_modules/p/b/c.txt", ".git/b/c.txt", "target/debug/b/c.txt", "temp/111/b/c.txt", "worktree/w/b/c.txt"], &[]);
    assert_eq!(find(&root, "b/c.txt").matches, vec!["temp/111/b/c.txt", "worktree/w/b/c.txt"]);
}

#[test]
fn symlinked_directories_are_not_followed_and_a_loop_ends() {
    let root = tree("links", &["real/b/c.txt"], &[]);
    let outside = tree("links-outside", &["b/c.txt"], &[]);
    std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
    std::os::unix::fs::symlink(&root, root.join("real/loop")).unwrap();
    std::os::unix::fs::symlink(outside.join("b"), root.join("leak")).unwrap();
    std::fs::create_dir_all(root.join("via")).unwrap();
    std::os::unix::fs::symlink(outside.join("b"), root.join("via/b")).unwrap();
    let got = find(&root, "b/c.txt");
    assert_eq!(got.matches, vec!["real/b/c.txt"], "no followed link, no result outside the root (via/b points out)");
    assert_eq!(got.stopped, None, "the loop ended the walk normally");
}

#[test]
fn the_limits_stop_the_walk_and_say_so() {
    let mut dirs = Vec::new();
    for i in 0..50 { dirs.push(format!("d{i:02}/e")); }
    let refs: Vec<&str> = dirs.iter().map(String::as_str).collect();
    let root = tree("limits", &["d49/e/b/c.txt"], &refs);
    let few = find_tail(&root, "b/c.txt", Limits { dirs: 10, ms: 60_000 }).unwrap();
    assert_eq!((few.matches.len(), few.stopped), (0, Some("dirs")));
    let none = find_tail(&root, "b/c.txt", Limits { dirs: 100_000, ms: 0 }).unwrap();
    assert_eq!(none.stopped, Some("time"));
    assert_eq!(find(&root, "b/c.txt").matches, vec!["d49/e/b/c.txt"]);
}

#[test]
fn twenty_one_are_collected_and_more_is_said() {
    let files: Vec<String> = (0..30).map(|i| format!("m{i:02}/b/c.txt")).collect();
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    let root = tree("many", &refs, &[]);
    let got = find(&root, "b/c.txt");
    assert_eq!(got.matches.len(), 21);
    assert!(got.more);
    assert_eq!(got.matches[0], "m00/b/c.txt");
}

#[test]
fn a_wide_root_is_never_searched() {
    assert!(find_tail(Path::new("/"), "b/c.txt", LIMITS).is_err());
    let home = dirs::home_dir().unwrap();
    assert!(find_tail(&home, "b/c.txt", LIMITS).is_err());
}

#[test]
fn only_a_relative_reference_without_parent_steps_is_searched() {
    for bad in ["", "/etc/passwd", "~/x", "../x", "a/../b", "a\u{0}b", "."] {
        assert!(reference(bad).is_err(), "{bad:?}");
    }
    assert_eq!(reference("./b/c.txt").unwrap(), "b/c.txt");
    assert_eq!(reference("b/c.txt").unwrap(), "b/c.txt");
}

/// Validator-2, #144 note 12, as ruled (leader, note 13): (b) one FILE reached directly and
/// through a symlinked segment of the reference is ONE match, the nearest spelling kept, so a
/// single file never opens a chooser; (a) a reference that names a skipped store is found: the
/// skip list limits the walk, not what an agent may name.
#[test]
fn one_file_reached_two_ways_is_one_match_the_nearest_spelling_kept() {
    let root = tree("canonical", &["real/b/c.txt", "deep/er/real2/b/d.txt"], &[]);
    std::fs::create_dir_all(root.join("via")).unwrap();
    std::os::unix::fs::symlink(root.join("real/b"), root.join("via/b")).unwrap();
    assert_eq!(find(&root, "b/c.txt").matches, vec!["real/b/c.txt"], "real/b/c.txt and via/b/c.txt are one file: one match");
    std::fs::create_dir_all(root.join("near")).unwrap();
    std::os::unix::fs::symlink(root.join("deep/er/real2/b"), root.join("near/b")).unwrap();
    assert_eq!(find(&root, "b/d.txt").matches, vec!["near/b/d.txt"], "the nearer spelling of the one file is the one kept");
}

#[test]
fn a_reference_that_names_a_skipped_store_is_found() {
    let root = tree("store-ref", &["x/node_modules/pkg/value.txt", "y/pkg/value.txt"], &[]);
    assert_eq!(find(&root, "node_modules/pkg/value.txt").matches, vec!["x/node_modules/pkg/value.txt"], "the agent named it: found");
    assert_eq!(find(&root, "pkg/value.txt").matches, vec!["y/pkg/value.txt"], "but the walk itself never enters x/node_modules");
}

/// Validator-2 note 39 (ruled note 40): a directory whose listing fails is not empty data. Its
/// probe: `a/locked` may be searched through (x) but not listed (no r); the one match the walk
/// can see, `b/file.md`, must not read as complete and unique, and the walk goes on past it.
#[test]
fn a_directory_that_cannot_be_listed_makes_the_answer_incomplete_and_the_walk_goes_on() {
    use std::os::unix::fs::PermissionsExt;
    let root = tree("unreadable", &["a/locked/deep/file.md", "b/file.md"], &[]);
    let locked = root.join("a/locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o111)).unwrap();
    let listable = std::fs::read_dir(&locked).is_ok(); // root reads anything: the case cannot be made
    let got = find_tail(&root, "file.md", LIMITS);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!listable, "the fixture: a/locked cannot be listed by this user");
    assert_eq!(got.unwrap(), Found { matches: vec!["b/file.md".into()], more: false, stopped: Some("unreadable") });
    // The root itself unlistable: nothing found, and the answer says why.
    let r2 = tree("unreadable-root", &["x/file.md"], &[]);
    std::fs::set_permissions(&r2, std::fs::Permissions::from_mode(0o111)).unwrap();
    let got = find_tail(&r2, "file.md", LIMITS);
    std::fs::set_permissions(&r2, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(got.unwrap(), Found { matches: vec![], more: false, stopped: Some("unreadable") });
}
