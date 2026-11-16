//! Board #111: the page store on real directories (no tmux, no gateway).

use super::*;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};

const H: u64 = 4 * 3600 * 1000; // the door's lifetime, in ms

/// A fault named `step`, or `step#n` for its n-th occurrence on this thread.
pub(super) fn fault_hits(step: &str) -> bool {
    FAULT.with(|f| {
        let Some(want) = f.borrow().clone() else { return false };
        let (name, nth) = want.split_once('#').map(|(n, k)| (n.to_string(), k.parse::<u32>().unwrap_or(1))).unwrap_or((want.clone(), 0));
        if name != step { return false; }
        if nth == 0 { return true; }
        let seen = FAULT_SEEN.with(|c| { c.set(c.get() + 1); c.get() });
        seen == nth
    })
}

thread_local! {
    /// Test-only fault injection at a named commit step (#111 notes 18, 23).
    pub(super) static FAULT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static FAULT_SEEN: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// A test seam between publish's validation and its copy (F2).
    pub(super) static AFTER_VALIDATION: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

fn ws(tag: &str) -> PathBuf {
    let d = crate::config::test_scratch(&format!("tmm-111-{tag}"));
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

/// A bundle folder with an index.html and the given extra files.
fn bundle(at: &Path, files: &[(&str, &str)]) -> PathBuf {
    std::fs::create_dir_all(at).unwrap();
    std::fs::write(at.join("index.html"), "<h1>status</h1>").unwrap();
    for (name, body) in files {
        let p = at.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    at.to_path_buf()
}

fn store(ws: &Path) -> PathBuf {
    ws.join(".tmm/dashboard")
}

fn manifest(ws: &Path) -> Manifest {
    serde_json::from_str(&std::fs::read_to_string(store(ws).join("page.json")).unwrap()).unwrap()
}

/// Everything under the store, with each file's bytes: a refusal must leave it identical.
fn snapshot(ws: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, p: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(rd) = std::fs::read_dir(p) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                out.push((format!("{rel}/"), Vec::new()));
                walk(base, &path, out);
            } else {
                out.push((rel, std::fs::read(&path).unwrap_or_default()));
            }
        }
    }
    let mut out = Vec::new();
    walk(&store(ws), &store(ws), &mut out);
    out
}

fn clock(t: u64) -> impl Fn() -> u64 {
    move || t
}

fn mint_ok(root: &str, dir: &[String]) -> Result<String, String> {
    Ok(format!("/dl/s/x/{root}/{}/", dir.join("/")))
}

#[test]
fn a_publication_becomes_the_current_page_and_names_its_publisher() {
    let w = ws("pub");
    let src = bundle(&w.join("work/page"), &[("style.css", "h1{}"), ("img/a.png", "png")]);
    assert_eq!(head(&w).unwrap(), None, "no page before the first publication");
    let p = publish(&w, &src, "leader", H, &clock(1_000)).unwrap();
    assert_eq!(p, Published { rev: 1, files: 3, bytes: 15 + 4 + 3, warning: None });
    assert_eq!(head(&w).unwrap(), Some(Head { rev: 1, by: "leader".into(), at_ms: 1_000 }));
    assert_eq!(std::fs::read_to_string(store(&w).join("1/img/a.png")).unwrap(), "png", "the bundle is COPIED, folders included");
    let loaded = load(&w, &mut mint_ok).unwrap().unwrap();
    assert_eq!((loaded.rev, loaded.by.as_str(), loaded.html.as_str()), (1, "leader", "<h1>status</h1>"));
    assert_eq!(loaded.dir, format!("{}/.tmm/dashboard/1", w.display()));
    // The last publish wins.
    std::fs::write(src.join("index.html"), "<h1>second</h1>").unwrap();
    assert_eq!(publish(&w, &src, "builder", H, &clock(2_000)).unwrap().rev, 2);
    assert_eq!(head(&w).unwrap().unwrap().by, "builder");
    assert_eq!(load(&w, &mut mint_ok).unwrap().unwrap().html, "<h1>second</h1>");
    // The source can change or go after the publication: the revision is a copy.
    std::fs::remove_dir_all(&src).unwrap();
    assert_eq!(load(&w, &mut mint_ok).unwrap().unwrap().html, "<h1>second</h1>");
}

/// Q1 (leader, #111 note 8): a page reaches a project file as
/// `../../../<path>`. A store layout change must fail HERE, not in pages.
#[test]
fn a_revision_sits_three_folders_below_the_project_root() {
    let w = ws("depth");
    std::fs::create_dir_all(w.join("EP/out")).unwrap();
    std::fs::write(w.join("EP/out/mix.mp3"), "mp3").unwrap();
    let src = bundle(&w.join("page"), &[]);
    publish(&w, &src, "leader", H, &clock(1)).unwrap();
    let mut seen = Vec::new();
    let l = load(&w, &mut |root: &str, dir: &[String]| { seen = dir.to_vec(); mint_ok(root, dir) }).unwrap().unwrap();
    assert_eq!(seen, vec![".tmm", "dashboard", "1"]);
    let from_page = Path::new(&l.dir).join("../../../EP/out/mix.mp3");
    assert_eq!(std::fs::read_to_string(from_page).unwrap(), "mp3");
}

#[test]
fn every_refusal_changes_nothing() {
    use std::os::unix::fs::symlink;
    let w = ws("refuse");
    let good = bundle(&w.join("good"), &[]);
    publish(&w, &good, "leader", H, &clock(1)).unwrap();
    let before = snapshot(&w);
    let case = |name: &str, setup: &dyn Fn(&Path)| -> String {
        let dir = w.join(format!("case-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        setup(&dir);
        let e = publish(&w, &dir, "leader", H, &clock(9)).expect_err(name);
        assert_eq!(snapshot(&w), before, "{name}: the store is byte-identical after the refusal");
        e
    };
    assert!(case("no-index", &|_| {}).contains("has no index.html"));
    assert!(case("index-link", &|d| symlink(good.join("index.html"), d.join("index.html")).unwrap()).contains("index.html is a symlink"));
    assert!(case("index-dir", &|d| std::fs::create_dir(d.join("index.html")).unwrap()).contains("not a regular file"));
    assert!(case("index-big", &|d| std::fs::write(d.join("index.html"), vec![b'x'; INDEX_MAX_BYTES as usize + 1]).unwrap()).contains("larger than 512 KiB"));
    assert!(case("file-link", &|d| { bundle(d, &[]); symlink("/etc/hostname", d.join("x.css")).unwrap(); }).contains("x.css is a symlink"));
    assert!(case("dir-link", &|d| { bundle(d, &[]); symlink(&w, d.join("up")).unwrap(); }).contains("up is a symlink"));
    assert!(case("deep-link", &|d| { bundle(d, &[("a/b/ok.css", "")]); symlink("/etc", d.join("a/b/etc")).unwrap(); }).contains("a/b/etc is a symlink"));
    assert!(case("fifo", &|d| {
        bundle(d, &[]);
        let c = std::ffi::CString::new(d.join("pipe").to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
    }).contains("pipe is not a regular file"));
    assert!(case("files", &|d| { bundle(d, &[]); for i in 0..BUNDLE_MAX_FILES { std::fs::write(d.join(format!("f{i}.css")), "").unwrap(); } }).contains("more than 500 files"));
    assert!(case("depth", &|d| {
        bundle(d, &[]);
        let deep: PathBuf = (0..=BUNDLE_MAX_DEPTH).map(|i| format!("d{i}")).collect();
        std::fs::create_dir_all(d.join(deep)).unwrap();
    }).contains("deeper than 16 folders"));
    assert!(case("bytes", &|d| {
        bundle(d, &[]);
        let mb = vec![0u8; 1024 * 1024];
        for i in 0..21 { std::fs::write(d.join(format!("p{i}.png")), &mb).unwrap(); }
    }).contains("larger than 20 MiB together"));
    // <dir> itself a symlink, or not a folder.
    symlink(&good, w.join("alias")).unwrap();
    assert!(publish(&w, &w.join("alias"), "leader", H, &clock(9)).unwrap_err().contains("is a symlink"));
    assert!(publish(&w, &good.join("index.html"), "leader", H, &clock(9)).unwrap_err().contains("is not a folder"));
    assert_eq!(snapshot(&w), before);
    assert_eq!(head(&w).unwrap().unwrap().rev, 1);
}

#[test]
fn a_symlinked_store_revision_or_index_shows_no_page() {
    use std::os::unix::fs::symlink;
    // The revision directory replaced by a symlink to a real page.
    let w = ws("link-rev");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "leader", H, &clock(1)).unwrap();
    std::fs::rename(store(&w).join("1"), w.join("moved")).unwrap();
    symlink(w.join("moved"), store(&w).join("1")).unwrap();
    assert_eq!(head(&w).unwrap(), None);
    assert!(load(&w, &mut mint_ok).unwrap().is_none());
    // index.html a symlink inside a real revision.
    let w = ws("link-index");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "leader", H, &clock(1)).unwrap();
    std::fs::remove_file(store(&w).join("1/index.html")).unwrap();
    symlink(src.join("index.html"), store(&w).join("1/index.html")).unwrap();
    assert_eq!(head(&w).unwrap(), None);
    assert!(load(&w, &mut mint_ok).unwrap().is_none());
    // .tmm/dashboard itself a symlink: no page, and a publish refuses.
    let w = ws("link-store");
    let real = ws("link-store-real");
    std::fs::create_dir_all(w.join(".tmm")).unwrap();
    symlink(&real, store(&w)).unwrap();
    assert_eq!(head(&w).unwrap(), None);
    let src = bundle(&w.join("p"), &[]);
    assert!(publish(&w, &src, "leader", H, &clock(1)).unwrap_err().contains("a symlink is never followed"));
    assert!(std::fs::read_dir(&real).unwrap().next().is_none(), "nothing was written through the link");
}

#[test]
fn a_revision_goes_only_after_the_doors_lifetime_out_of_current() {
    let w = ws("gc");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &clock(0)).unwrap(); // 1
    publish(&w, &src, "a", H, &clock(10)).unwrap(); // 2; 1 retired at 10
    // Five more publications within the lifetime: revision 1 stays, as do all the others.
    for i in 0..5 {
        publish(&w, &src, "a", H, &clock(20 + i)).unwrap();
    }
    assert!(store(&w).join("1").is_dir(), "five publications later, inside 4 h, revision 1 is still there");
    // One ms short of 4 h after its retirement: still kept.
    publish(&w, &src, "a", H, &clock(10 + H - 1)).unwrap();
    assert!(store(&w).join("1").is_dir());
    // At 4 h exactly: gone, directory and entry (R7); 2 (retired at 20) not yet.
    publish(&w, &src, "a", H, &clock(10 + H)).unwrap();
    assert!(!store(&w).join("1").exists());
    assert!(store(&w).join("2").is_dir());
    let m = manifest(&w);
    assert!(!m.revisions.iter().any(|r| r.rev == 1), "page.json lists only live revisions");
    assert_eq!(m.current, Some(9));
    // Long after: only the current one and those retired within 4 h remain.
    publish(&w, &src, "a", H, &clock(10 * H)).unwrap();
    let m = manifest(&w);
    assert_eq!(m.revisions.iter().map(|r| r.rev).collect::<Vec<_>>(), vec![9, 10], "the current and the one retired just now");
    assert_eq!(m.current, Some(10));
    let dirs: Vec<String> = std::fs::read_dir(store(&w)).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with('.') && n != "page.json").collect();
    let mut dirs = dirs;
    dirs.sort();
    assert_eq!(dirs, vec!["10", "9"]);
}

#[test]
fn an_unlisted_leftover_goes_once_older_than_the_lifetime() {
    let w = ws("orphan");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &clock(1)).unwrap();
    std::fs::create_dir_all(store(&w).join(".staging-dead/x")).unwrap();
    std::fs::create_dir_all(store(&w).join("77")).unwrap();
    let now_ms = now_ms();
    publish(&w, &src, "a", H, &clock(now_ms)).unwrap();
    assert!(store(&w).join(".staging-dead").is_dir() && store(&w).join("77").is_dir(), "young leftovers stay");
    publish(&w, &src, "a", H, &clock(now_ms + H + 2000)).unwrap();
    assert!(!store(&w).join(".staging-dead").exists() && !store(&w).join("77").exists(), "old leftovers go");
    // A publication never reuses a number that exists.
    assert!(manifest(&w).current.unwrap() > 2);
}

#[test]
fn unpublish_takes_the_page_down_and_retires_it() {
    let w = ws("unpub");
    assert_eq!(unpublish(&w, H, &clock(1)).unwrap(), None, "no page: nothing to take down");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &clock(1)).unwrap();
    assert_eq!(unpublish(&w, H, &clock(5)).unwrap(), Some((1, None)));
    assert_eq!(head(&w).unwrap(), None);
    assert!(load(&w, &mut mint_ok).unwrap().is_none());
    assert!(store(&w).join("1").is_dir(), "a document loaded before keeps its files for the lifetime");
    assert_eq!(manifest(&w).revisions[0].retired_ms, Some(5));
    publish(&w, &src, "a", H, &clock(5 + H)).unwrap();
    assert!(!store(&w).join("1").exists());
    assert_eq!(head(&w).unwrap().unwrap().rev, 2);
}

#[test]
fn an_unreadable_page_json_is_an_error_not_no_page() {
    let w = ws("corrupt");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &clock(1)).unwrap();
    std::fs::write(store(&w).join("page.json"), "{not json").unwrap();
    assert!(head(&w).unwrap_err().contains("page.json is not readable"));
    assert!(load(&w, &mut mint_ok).is_err());
    assert!(publish(&w, &src, "a", H, &clock(2)).is_err());
}

/// AC2 (#104 note 15): reading the pointer and minting are ONE operation,
/// ordered against the pointer move. The seam is the mint itself: while it
/// runs, a publication is started on another thread. It must not move the
/// pointer until the load has returned, so the loaded revision's retirement
/// is never earlier than the mint.
#[test]
fn a_publication_racing_a_load_waits_for_its_mint() {
    let w = ws("race");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &now_ms).unwrap();
    let moved = Arc::new(Mutex::new(None::<u64>));
    let mut minted_at = 0u64;
    let mut racer = None;
    let loaded = load(&w, &mut |root: &str, dir: &[String]| {
        let (w2, src2, moved2) = (w.clone(), src.clone(), moved.clone());
        let started = Arc::new(Barrier::new(2));
        let s2 = started.clone();
        racer = Some(std::thread::spawn(move || {
            s2.wait();
            publish(&w2, &src2, "b", H, &now_ms).unwrap();
            *moved2.lock().unwrap() = Some(now_ms());
        }));
        started.wait();
        std::thread::sleep(std::time::Duration::from_millis(300));
        minted_at = now_ms();
        assert_eq!(*moved.lock().unwrap(), None, "the pointer did not move while the cap was being minted");
        mint_ok(root, dir)
    }).unwrap().unwrap();
    racer.unwrap().join().unwrap();
    assert_eq!(loaded.rev, 1);
    let retired = manifest(&w).revisions.iter().find(|r| r.rev == 1).unwrap().retired_ms.unwrap();
    assert!(retired >= minted_at, "revision 1 was retired ({retired}) no earlier than its cap was minted ({minted_at})");
    assert_eq!(head(&w).unwrap().unwrap().rev, 2);
}

/// The same invariant with no seam: loads and publications from several
/// threads at once; every load's revision was current when it minted.
#[test]
fn concurrent_loads_and_publications_never_mint_for_a_retired_revision() {
    let w = ws("stress");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &now_ms).unwrap();
    let mints = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
    let mut threads = Vec::new();
    for _ in 0..3 {
        let (w, src) = (w.clone(), src.clone());
        threads.push(std::thread::spawn(move || for _ in 0..15 { publish(&w, &src, "b", H, &now_ms).unwrap(); }));
    }
    for _ in 0..3 {
        let (w, mints) = (w.clone(), mints.clone());
        threads.push(std::thread::spawn(move || for _ in 0..40 {
            let mut at = 0;
            let l = load(&w, &mut |r: &str, d: &[String]| { at = now_ms(); mint_ok(r, d) }).unwrap().unwrap();
            mints.lock().unwrap().push((l.rev, at));
        }));
    }
    for t in threads { t.join().unwrap(); }
    let m = manifest(&w);
    let mints = mints.lock().unwrap();
    assert_eq!(mints.len(), 120);
    for (rev, at) in mints.iter() {
        let r = m.revisions.iter().find(|r| r.rev == *rev).expect("a revision minted within 4 h is still listed");
        assert!(r.retired_ms.is_none_or(|t| t >= *at), "revision {rev} retired at {:?} before its mint at {at}", r.retired_ms);
    }
    assert_eq!(m.current, Some(46));
}

#[test]
fn the_cli_lines_say_what_happened() {
    let r = serde_json::json!({ "rev": 7, "files": 3, "bytes": 2048 });
    assert_eq!(cli::published_line(&r, "teammux"), "✓ published revision 7 of teammux's page (3 files, 2 KiB)");
    assert_eq!(cli::unpublished_line(&serde_json::json!({ "rev": 7 }), "teammux"), "✓ took teammux's page down (revision 7); the Dashboard shows no page");
    assert_eq!(cli::unpublished_line(&serde_json::json!({ "rev": null }), "teammux"), "teammux has no page published; nothing changed");
    assert_eq!(cli::warning_line(&serde_json::json!({ "rev": 7, "warning": "page.json is written but the store folder could not be synced: EIO" })).as_deref(), Some("warning: page.json is written but the store folder could not be synced: EIO"));
    assert_eq!(cli::warning_line(&serde_json::json!({ "rev": 7, "warning": null })), None);
}

/// From #136: the lock must be released by LOCK_UN, not by the close. A
/// second open file description of the same `.lock` is kept open (as a forked
/// child's would be, until its execve) and the guard is dropped; a
/// non-blocking acquire on a THIRD description must then succeed.
#[test]
fn the_store_lock_is_released_while_another_reference_to_it_lives() {
    let w = ws("unlock");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "a", H, &clock(1)).unwrap();
    let (_, root) = root_of(&w).unwrap();
    let store_dir = store_of(&root, false).unwrap().unwrap();
    let held = lock(&store_dir).unwrap();
    // The SAME open file description, duplicated: what fork gives the child.
    let child = held.file().try_clone().unwrap();
    drop(held);
    let other = || std::fs::OpenOptions::new().read(true).write(true).open(store(&w).join(".lock")).unwrap();
    let taken = crate::flock::Flock::try_exclusive(other()).unwrap();
    assert!(taken.is_some(), "the lock is free although a duplicate of its descriptor is still open");
    drop(taken);
    drop(child);
    // The real case (#136): a child forked while the lock is held, parked before its exec.
    let held = lock(&store_dir).unwrap();
    let parked = crate::flock::parked_child::ParkedChild::spawn();
    drop(held);
    assert!(crate::flock::Flock::try_exclusive(other()).unwrap().is_some(), "the lock is free although a forked child still holds its description");
    drop(parked);
}

// ── Validator's early-partial findings (#111 note 11), each its reproducer ──

/// F1: a refusal on a project with NO store creates nothing at all.
#[test]
fn a_refused_first_publication_leaves_no_store_folder() {
    use std::os::unix::fs::symlink;
    let w = ws("f1-fresh");
    let src = bundle(&w.join("p"), &[]);
    symlink("/etc/hostname", src.join("bad.css")).unwrap();
    assert!(publish(&w, &src, "human", H, &clock(1)).unwrap_err().contains("bad.css is a symlink"));
    assert!(!w.join(".tmm").exists(), "no .tmm made for a refusal");
    std::fs::create_dir(w.join(".tmm")).unwrap();
    assert!(publish(&w, &src, "human", H, &clock(1)).is_err());
    assert!(!store(&w).exists(), "no .tmm/dashboard made for a refusal");
    // A socket in the bundle, with a store already there: byte-identical.
    std::fs::remove_file(src.join("bad.css")).unwrap();
    publish(&w, &src, "human", H, &clock(1)).unwrap();
    let before = snapshot(&w);
    let _sock = std::os::unix::net::UnixListener::bind(src.join("socket")).unwrap();
    assert!(publish(&w, &src, "human", H, &clock(2)).unwrap_err().contains("socket is not a regular file"));
    assert_eq!(snapshot(&w), before);
}

/// F1: a failed commit (page.json.tmp a directory) leaves the store as it
/// was: no orphan revision, and nothing collected.
#[test]
fn a_failed_manifest_commit_removes_its_revision_and_collects_nothing() {
    let w = ws("f1-commit");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "human", H, &clock(0)).unwrap();
    publish(&w, &src, "human", H, &clock(1)).unwrap(); // revision 1 retired at 1
    std::fs::create_dir(store(&w).join("page.json.tmp")).unwrap();
    let before = snapshot(&w);
    let e = publish(&w, &src, "human", H, &clock(H + 1)).unwrap_err();
    assert!(e.contains("page.json.tmp"), "{e}");
    assert_eq!(snapshot(&w), before, "revision 1 (expired) is still there and no revision 3 was left");
    assert_eq!(head(&w).unwrap().unwrap().rev, 2);
}

/// F2: what is published is what was COPIED. index.html removed after the
/// validation, before the copy: refused, nothing published.
#[test]
fn an_index_removed_between_validation_and_copy_is_refused() {
    let w = ws("f2");
    let src = bundle(&w.join("p"), &[("a.css", "x")]);
    let index = src.join("index.html");
    AFTER_VALIDATION.with(|h| *h.borrow_mut() = Some(Box::new(move || std::fs::remove_file(&index).unwrap())));
    let r = publish(&w, &src, "human", H, &clock(1));
    AFTER_VALIDATION.with(|h| *h.borrow_mut() = None);
    assert!(r.unwrap_err().contains("the copied page has no index.html"));
    assert_eq!(head(&w).unwrap(), None);
    // Leader note 23 (A): the empty skeleton may remain, and nothing else.
    let left: Vec<String> = std::fs::read_dir(store(&w)).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(left.is_empty(), "no revision, no staging, no page.json, no tmp: {left:?}");
}

/// F3: a page.json or .lock that is a FIFO is an error at once, for every
/// reader, never a blocked call.
#[test]
fn a_fifo_in_the_store_is_an_error_at_once_never_a_block() {
    fn fifo(p: &Path) {
        let _ = std::fs::remove_file(p);
        let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
    }
    fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(f()); });
        rx.recv_timeout(std::time::Duration::from_secs(2)).expect("returned within 2 s, not blocked")
    }
    let w = ws("f3");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "human", H, &clock(1)).unwrap();
    fifo(&store(&w).join("page.json"));
    let w2 = w.clone();
    assert!(within(move || head(&w2)).unwrap_err().contains("page.json is not a regular file"));
    let w2 = w.clone();
    assert!(within(move || load(&w2, &mut mint_ok).map(|_| ())).is_err());
    let (w2, s2) = (w.clone(), src.clone());
    assert!(within(move || publish(&w2, &s2, "human", H, &clock(2)).map(|_| ())).is_err());
    let w2 = w.clone();
    assert!(within(move || unpublish(&w2, H, &clock(2)).map(|_| ())).is_err());
    std::fs::remove_file(store(&w).join("page.json")).unwrap();
    fifo(&store(&w).join(".lock"));
    let w2 = w.clone();
    assert!(within(move || load(&w2, &mut mint_ok).map(|_| ())).unwrap_err().contains(".lock is not a regular file"));
}

/// F4: the first creation of the store is idempotent: concurrent first
/// publications all succeed and the last wins.
#[test]
fn concurrent_first_publications_all_succeed() {
    for round in 0..10 {
        let w = ws(&format!("f4-{round}"));
        let src = bundle(&w.join("p"), &[]);
        std::fs::create_dir(w.join(".tmm")).unwrap();
        let go = Arc::new(Barrier::new(9));
        let threads: Vec<_> = (0..8).map(|_| {
            let (w, src, go) = (w.clone(), src.clone(), go.clone());
            std::thread::spawn(move || { go.wait(); publish(&w, &src, "human", H, &now_ms) })
        }).collect();
        go.wait();
        for t in threads { t.join().unwrap().expect("a valid first publication is never refused"); }
        assert_eq!(head(&w).unwrap().unwrap().rev, 8);
    }
}

/// #111 note 18, the commit point: after ANY failure either the store is
/// byte-identical to before, or the pointer names an existing complete
/// revision; never a dangling pointer, never a leftover tmp. Validator's two
/// injections (the tmp fsync, the folder fsync after the rename) and every
/// other step of the commit, for a publish and an unpublish.
#[test]
fn a_fault_at_any_commit_step_leaves_the_old_store_or_a_complete_new_page() {
    fn with_fault<T>(at: &str, f: impl FnOnce() -> T) -> T {
        FAULT_SEEN.with(|c| c.set(0));
        FAULT.with(|x| *x.borrow_mut() = Some(at.to_string()));
        let r = f();
        FAULT.with(|x| *x.borrow_mut() = None);
        r
    }
    fn intact(w: &Path) {
        assert!(!store(w).join("page.json.tmp").exists(), "no leftover tmp");
        if let Some(h) = head(w).unwrap() {
            assert!(store(w).join(h.rev.to_string()).join("index.html").is_file(), "the pointer names a complete revision");
        }
    }
    for at in ["tmp-write", "tmp-sync", "rename", "dir-sync"] {
        let w = ws(&format!("commit-{at}"));
        let src = bundle(&w.join("p"), &[]);
        publish(&w, &src, "human", H, &clock(0)).unwrap();
        publish(&w, &src, "human", H, &clock(1)).unwrap(); // revision 1 retired at 1: expired at H + 1
        let before = snapshot(&w);
        let r = with_fault(at, || publish(&w, &src, "human", H, &clock(H + 1)));
        intact(&w);
        match at {
            "dir-sync" => {
                // After the commit: published, with a durability warning; nothing the pointer names is gone.
                let p = r.expect("a folder-sync error after the commit is not a refusal");
                assert_eq!(p.rev, 3);
                assert!(p.warning.as_deref().unwrap().contains("could not be synced"), "{p:?}");
                assert_eq!(head(&w).unwrap().unwrap().rev, 3);
                assert!(store(&w).join("2").is_dir(), "the previous page is kept");
                assert!(store(&w).join("1").is_dir(), "and nothing was collected on a warning");
            }
            _ => {
                let e = r.expect_err(at);
                assert!(e.contains("Input/output error"), "{at}: {e}");
                assert_eq!(snapshot(&w), before, "{at}: before the commit the store is byte-identical");
                assert_eq!(head(&w).unwrap().unwrap().rev, 2, "{at}: the previous page stays current");
            }
        }
        // Unpublish through the same commit.
        let before = snapshot(&w);
        let r = with_fault(at, || unpublish(&w, H, &clock(H + 2)));
        intact(&w);
        match at {
            "dir-sync" => {
                let (_, warning) = r.unwrap().unwrap();
                assert!(warning.is_some());
                assert_eq!(head(&w).unwrap(), None);
            }
            _ => {
                assert!(r.is_err(), "{at}");
                assert_eq!(snapshot(&w), before, "{at}: unpublish refused, store unchanged");
            }
        }
    }
}

/// Leader note 23 (B): after a synced commit, collection's own rewrite is
/// committed BEFORE any folder goes; a failure there, or its folder sync, is
/// the publication's warning; nothing page.json lists is deleted.
#[test]
fn a_fault_in_collections_rewrite_is_a_warning_and_deletes_nothing_listed() {
    for (at, removed) in [("tmp-sync#2", false), ("rename#2", false), ("dir-sync#2", true)] {
        let w = ws(&format!("gc-fault-{}", at.replace('#', "-")));
        let src = bundle(&w.join("p"), &[]);
        publish(&w, &src, "human", H, &clock(0)).unwrap();
        publish(&w, &src, "human", H, &clock(1)).unwrap(); // 1 retired at 1
        FAULT_SEEN.with(|c| c.set(0));
        FAULT.with(|x| *x.borrow_mut() = Some(at.to_string()));
        let p = publish(&w, &src, "human", H, &clock(H + 1));
        FAULT.with(|x| *x.borrow_mut() = None);
        let p = p.unwrap_or_else(|e| panic!("{at}: a collection fault never fails the publication: {e}"));
        assert_eq!(p.rev, 3, "{at}");
        assert!(p.warning.is_some(), "{at}: reported, not swallowed");
        assert_eq!(head(&w).unwrap().unwrap().rev, 3);
        assert!(!store(&w).join("page.json.tmp").exists(), "{at}: no tmp");
        let listed: Vec<u64> = manifest(&w).revisions.iter().map(|r| r.rev).collect();
        for rev in &listed { assert!(store(&w).join(rev.to_string()).join("index.html").is_file(), "{at}: listed revision {rev} exists"); }
        assert_eq!(!store(&w).join("1").exists(), removed, "{at}: revision 1 removed only once the shortened list was committed");
        assert_eq!(listed.contains(&1), !removed, "{at}");
    }
    // Unpublish's collection, the same rule.
    let w = ws("gc-fault-unpub");
    let src = bundle(&w.join("p"), &[]);
    publish(&w, &src, "human", H, &clock(0)).unwrap();
    publish(&w, &src, "human", H, &clock(1)).unwrap();
    FAULT_SEEN.with(|c| c.set(0));
    FAULT.with(|x| *x.borrow_mut() = Some("rename#2".to_string()));
    let r = unpublish(&w, H, &clock(H + 1));
    FAULT.with(|x| *x.borrow_mut() = None);
    let (_, warning) = r.unwrap().unwrap();
    assert!(warning.unwrap().contains("not collected"));
    assert_eq!(head(&w).unwrap(), None);
    assert!(store(&w).join("1").is_dir(), "listed, so kept");
}
