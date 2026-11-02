// `tmm merge` (board #445) on scratch repositories: every row of the
// execution contract that git itself can show. Each repo is a fresh
// `config::test_scratch` directory (board #500); git runs through the same
// `Git` runner as production, so no hook of the developer's runs.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn sh(dir: &Path, args: &[&str]) -> String {
    let o = Git::run_in(dir, args, None).expect("git runs");
    assert_eq!(o.code, 0, "git {args:?}: {}", o.stderr);
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

struct Repo {
    root: PathBuf,
}

impl Repo {
    /// `main` with a.txt and d/keep.txt, committed by the configured author.
    fn new(name: &str) -> Repo {
        let root = crate::config::test_scratch(name);
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "Ada Integrator"), ("user.email", "ada@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            sh(&root, &["config", k, v]);
        }
        let r = Repo { root };
        r.write("a.txt", "one\n\ttwo\nthree\nfour\nfive\nsix\n");
        r.write("d/keep.txt", "keep\n");
        r.write(".gitignore", "*.log\n");
        r.commit("base");
        r
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(rel)).ok()
    }
    fn commit(&self, msg: &str) -> String {
        let f = self.root.join(".git").join("TEST_MSG");
        std::fs::write(&f, msg).unwrap();
        sh(&self.root, &["add", "-A"]);
        sh(&self.root, &["commit", "-q", "-F", f.to_str().unwrap()]);
        self.rev("HEAD")
    }
    fn rev(&self, r: &str) -> String {
        sh(&self.root, &["rev-parse", r])
    }
    fn git(&self, args: &[&str]) -> String {
        sh(&self.root, args)
    }
    /// A branch `feat` off main with `commits`, then back on main.
    fn feature(&self, commits: &[(&str, &str, &str)]) -> String {
        self.git(&["checkout", "-q", "-b", "feat"]);
        for (path, text, msg) in commits {
            self.write(path, text);
            self.commit(msg);
        }
        let tip = self.rev("HEAD");
        self.git(&["checkout", "-q", "main"]);
        tip
    }
    fn opts(&self, expect: &str) -> Options {
        Options { issue: 445, branch: "feat".into(), expect: expect.into(), message_file: None, dry_run: false, cwd: self.root.clone(), operator: "orchestrator".into() }
    }
    fn lock(&self) -> PathBuf {
        self.root.join(".git").join("tmm-merge.lock")
    }
}

type AtFn = Box<dyn FnMut(Gap, &Path) -> bool>;

type FaultFn = Box<dyn FnMut(Fault) -> bool>;

struct Rec {
    notes: Vec<String>,
    answer: NoteResult,
    at: AtFn,
    fault: FaultFn,
}

impl Rec {
    fn new() -> Rec {
        Rec { notes: Vec::new(), answer: NoteResult::Posted, at: Box::new(|_, _| true), fault: Box::new(|_| false) }
    }
    fn at(f: impl FnMut(Gap, &Path) -> bool + 'static) -> Rec {
        Rec { at: Box::new(f), ..Rec::new() }
    }
    fn fault(f: impl FnMut(Fault) -> bool + 'static) -> Rec {
        Rec { fault: Box::new(f), ..Rec::new() }
    }
}

impl Io for Rec {
    fn note(&mut self, text: &str) -> NoteResult {
        self.notes.push(text.to_string());
        self.answer.clone()
    }
    fn at(&mut self, gap: Gap, root: &Path) -> bool {
        (self.at)(gap, root)
    }
    fn fault(&mut self, f: Fault) -> bool {
        (self.fault)(f)
    }
}

/// A pid that existed and is gone: what a killed tmm merge leaves in its lock.
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

/// The lock a stopped run left, as if its process had been killed.
fn orphan(r: &Repo) -> Value {
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
    v["pid"] = json!(dead_pid());
    std::fs::write(r.lock(), serde_json::to_vec(&v).unwrap()).unwrap();
    v
}

const KIRO: &str = "Kiro Agent <244629292+kiro-agent@users.noreply.github.com>";

fn two_commit_branch(r: &Repo) -> String {
    r.feature(&[
        ("b.txt", "bee\n", &format!("feat: add b\n\nCo-authored-by: {KIRO}\n")),
        ("a.txt", "one\n\ttwo\nthree\nfour\nfive\nSIX\n", &format!("feat: change a\n\nCo-authored-by: {KIRO}\n")),
    ])
}

fn message_file(r: &Repo, text: &str) -> PathBuf {
    let p = r.root.join(".git").join("SQUASH_MSG_TEST");
    std::fs::write(&p, text).unwrap();
    p
}

#[test]
fn a_clean_squash_lands_from_its_own_reads_and_notes_once() {
    let r = Repo::new("merge-clean");
    let old = r.rev("main");
    let tip = two_commit_branch(&r);
    let base = r.git(&["merge-base", "main", "feat"]);
    let mut o = r.opts(&tip[..8]);
    o.message_file = Some(message_file(&r, "Feature: a and b (#445)\n\nTwo changes.\n"));
    let mut io = Rec::new();
    let rep = run(&o, &mut io);
    assert_eq!(rep.kind, Kind::Landed, "{}", rep.line);
    assert!(rep.ok());
    let new = r.rev("main");
    assert_ne!(new, old);
    assert_eq!(r.git(&["rev-list", "--parents", "-n", "1", "main"]), format!("{new} {old}"), "exactly one parent, the old main");
    assert_eq!(r.git(&["log", "-1", "--format=%an <%ae>", "main"]), "Ada Integrator <ada@example.com>", "the configured author");
    assert_eq!(r.git(&["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly,unfold)", "main"]), KIRO, "the branch's trailer, once");
    assert_eq!(r.git(&["log", "-1", "--format=%B", "main"]), format!("Feature: a and b (#445)\n\nTwo changes.\n\nCo-authored-by: {KIRO}"));
    assert_eq!(r.git(&["rev-parse", "main^{tree}"]), r.git(&["rev-parse", "feat^{tree}"]), "the squash holds exactly the branch's tree here");
    assert_eq!(r.read("b.txt").as_deref(), Some("bee\n"), "the checkout follows");
    assert_eq!(r.git(&["status", "--porcelain"]), "");
    assert_eq!(io.notes.len(), 1);
    let n = &io.notes[0];
    for want in [
        format!("refs/heads/feat at {} (2 commits on {})", &tip[..8], &base[..8]),
        format!("squashed onto refs/heads/main as {}, parent {}", &new[..8], &old[..8]),
        "author Ada Integrator <ada@example.com>".to_string(),
        format!("trailers: {KIRO}"),
        "byte-exact".to_string(),
        format!("Tip locked by --expect {}; the gates were confirmed by orchestrator, not checked by this command.", &tip[..8]),
        "Not pushed or deployed; the branch is kept.".to_string(),
    ] {
        assert!(n.contains(&want), "the note says {want:?}: {n}");
    }
    assert_eq!(rep.line, *n, "it prints the note it posted");
    assert!(!r.lock().exists(), "a landed and noted merge leaves no lock");
    assert_eq!(r.rev("feat"), tip, "the branch is kept");
}

#[test]
fn a_one_commit_branch_keeps_its_message_and_other_trailers_and_the_coauthor_set_is_replaced() {
    let r = Repo::new("merge-one");
    let tip = r.feature(&[("b.txt", "bee\n", &format!(
        "feat: add b\n\nWhy it matters.\n\nSigned-off-by: Ada <ada@example.com>\nco-authored-by: {KIRO}\nCo-authored-by: {KIRO}\n"
    ))]);
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert_eq!(rep.kind, Kind::Landed, "{}", rep.line);
    assert_eq!(r.git(&["log", "-1", "--format=%B", "main"]), format!("feat: add b\n\nWhy it matters.\n\nSigned-off-by: Ada <ada@example.com>\nCo-authored-by: {KIRO}"),
        "Signed-off-by stays; the Co-authored-by set is the branch's distinct values, written once");
}

#[test]
fn trailers_come_from_the_branch_in_first_seen_order_and_none_means_none() {
    let r = Repo::new("merge-trailers");
    let tip = r.feature(&[
        ("b.txt", "1\n", "one\n\nCo-authored-by: Codex <noreply@openai.com>\n"),
        ("c.txt", "2\n", &format!("two\n\nCo-authored-by: {KIRO}\nCo-authored-by: Codex <noreply@openai.com>\n")),
    ]);
    let mut o = r.opts(&tip);
    o.message_file = Some(message_file(&r, "Both\n"));
    assert_eq!(run(&o, &mut Rec::new()).kind, Kind::Landed);
    assert_eq!(r.git(&["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly,unfold,separator=|)", "main"]), format!("Codex <noreply@openai.com>|{KIRO}"));
    let r2 = Repo::new("merge-notrailer");
    let tip2 = r2.feature(&[("b.txt", "1\n", "human change\n")]);
    let mut io = Rec::new();
    assert_eq!(run(&r2.opts(&tip2), &mut io).kind, Kind::Landed);
    assert_eq!(r2.git(&["log", "-1", "--format=%B", "main"]), "human change", "the merging agent adds nothing of its own");
    assert!(io.notes[0].contains("trailers: none"));
}

#[test]
fn expect_must_be_eight_hex_and_name_the_branch_tip() {
    let r = Repo::new("merge-expect");
    let tip = two_commit_branch(&r);
    let old = r.rev("main");
    for (bad, why) in [(&tip[..7], "at least 8 hex"), ("zzzzzzzz", "at least 8 hex"), ("deadbeefdeadbeef", "does not name exactly one commit")] {
        let rep = run(&r.opts(bad), &mut Rec::new());
        assert_eq!(rep.kind, Kind::Refused, "{bad}");
        assert!(rep.line.contains(why) && rep.line.contains("Nothing was merged."), "{bad}: {}", rep.line);
    }
    let rep = run(&r.opts(&old), &mut Rec::new());
    assert!(rep.line.contains("not at --expect"), "a real commit that is not the tip: {}", rep.line);
    assert_eq!(r.rev("main"), old);
}

#[test]
fn a_multi_commit_branch_needs_a_message_file() {
    let r = Repo::new("merge-msg");
    let tip = two_commit_branch(&r);
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("has 2 commits; give the squash message with --message-file"), "{}", rep.line);
}

#[test]
fn refusals_before_landing_change_nothing() {
    // A dirty tracked file.
    let r = Repo::new("merge-dirty");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let old = r.rev("main");
    r.write("a.txt", "changed\n");
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("tracked files have changes"), "{}", rep.line);
    assert_eq!((r.rev("main"), r.read("a.txt").unwrap()), (old.clone(), "changed\n".into()));
    r.git(&["checkout", "--", "a.txt"]);
    // An unrelated untracked file is no obstacle.
    r.write("notes.txt", "mine\n");
    assert_eq!(run(&r.opts(&tip), &mut Rec::new()).kind, Kind::Landed);
    assert_eq!(r.read("notes.txt").as_deref(), Some("mine\n"));

    // A conflict.
    let c = Repo::new("merge-conflict");
    let tip = c.feature(&[("a.txt", "ONE\n", "branch a\n")]);
    c.write("a.txt", "uno\n");
    c.commit("main a");
    let old = c.rev("main");
    let rep = run(&c.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("the merge has conflicts (\"a.txt\")"), "{}", rep.line);
    assert_eq!(c.rev("main"), old);

    // A detached HEAD, an operation in progress, nothing to merge.
    let d = Repo::new("merge-states");
    let tip = d.feature(&[("b.txt", "bee\n", "b\n")]);
    d.git(&["checkout", "-q", "--detach"]);
    assert!(run(&d.opts(&tip), &mut Rec::new()).line.contains("HEAD is detached"));
    d.git(&["checkout", "-q", "main"]);
    std::fs::write(d.root.join(".git/MERGE_HEAD"), format!("{tip}\n")).unwrap();
    assert!(run(&d.opts(&tip), &mut Rec::new()).line.contains("MERGE_HEAD exists"));
    std::fs::remove_file(d.root.join(".git/MERGE_HEAD")).unwrap();
    d.git(&["branch", "-f", "feat", "main"]);
    let main = d.rev("main");
    assert!(run(&d.opts(&main), &mut Rec::new()).line.contains("has no commit that refs/heads/main lacks"));
    for r in [&r, &c, &d] {
        assert!(!r.lock().exists(), "a refusal leaves no lock");
    }
}

#[test]
fn whitespace_drift_next_to_a_hunk_refuses_where_stable_patch_id_would_match() {
    let r = Repo::new("merge-drift");
    // The branch changes line 5; main changes only the WHITESPACE of line 2,
    // which is in the branch hunk's context.
    let tip = r.feature(&[("a.txt", "one\n\ttwo\nthree\nfour\nFIVE\nsix\n", "five\n")]);
    r.write("a.txt", "one\n    two\nthree\nfour\nfive\nsix\n");
    r.commit("main: spaces for the tab");
    let old = r.rev("main");
    let base = r.git(&["merge-base", "main", "feat"]);
    let mt = r.git(&["merge-tree", "--write-tree", &old, &tip]);
    let stable = |a: &str, b: &str| {
        let d = Git { root: r.root.clone() }.bytes(&["diff", a, b]).unwrap();
        String::from_utf8_lossy(&Git { root: r.root.clone() }.piped(&["patch-id", "--stable"], &d).unwrap()).split_whitespace().next().unwrap().to_string()
    };
    assert_eq!(stable(&base, &tip), stable(&old, mt.lines().next().unwrap()), "the control: --stable cannot tell these apart");
    let mut io = Rec::new();
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Refused);
    assert!(rep.line.contains("not byte-for-byte the branch diff") && rep.line.contains("rebase the branch"), "{}", rep.line);
    assert_eq!(r.rev("main"), old);
    assert!(io.notes.is_empty());
}

#[test]
fn normalising_drops_only_index_lines_and_hunk_numbers() {
    let a = b"diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ fn f()\n a\n-\tb\n+    b\n";
    let b = b"diff --git a/x b/x\nindex 333..444 100644\n--- a/x\n+++ b/x\n@@ -7,3 +9,3 @@ fn f()\n a\n-\tb\n+    b\n";
    assert_eq!(normalise(a), normalise(b));
    assert_eq!(normalise(a), b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ @@ fn f()\n a\n-\tb\n+    b\n".to_vec());
    let ws = b"diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ fn f()\n a\n-\tb\n+  b\n";
    assert_ne!(normalise(a), normalise(ws), "whitespace is content");
    let content_line = b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+index stays\n";
    assert_eq!(normalise(content_line), b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ @@\n-x\n+index stays\n".to_vec());
}

#[test]
fn a_submodule_change_is_refused() {
    let r = Repo::new("merge-gitlink");
    r.git(&["checkout", "-q", "-b", "feat"]);
    let some = r.rev("HEAD");
    r.git(&["update-index", "--add", "--cacheinfo", &format!("160000,{some},sub")]);
    r.git(&["commit", "-q", "-m", "a gitlink"]);
    let tip = r.rev("HEAD");
    r.git(&["checkout", "-q", "main"]);
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("submodule (gitlink)"), "{}", rep.line);
}

#[test]
fn an_ignored_file_where_the_merge_adds_a_path_is_refused_and_kept() {
    // git read-tree -m -u overwrites an ignored file (measured 2.50.1); this
    // command checks the paths itself.
    let r = Repo::new("merge-ignored");
    r.git(&["checkout", "-q", "-b", "feat"]);
    r.write("keep.log", "from the branch\n");
    r.git(&["add", "-f", "keep.log"]);
    r.git(&["commit", "-q", "-m", "track a log"]);
    let tip = r.rev("HEAD");
    r.git(&["checkout", "-q", "main"]);
    r.write("keep.log", "mine\n");
    let old = r.rev("main");
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("\"keep.log\" exists (untracked or ignored) where the merge adds a path"), "{}", rep.line);
    assert_eq!((r.rev("main"), r.read("keep.log").unwrap()), (old, "mine\n".into()));
    // A plain file where the merge needs a DIRECTORY is refused too.
    let r2 = Repo::new("merge-ancestor");
    let tip2 = r2.feature(&[("x/y.txt", "y\n", "x/y\n")]);
    r2.write("x", "a file\n");
    assert!(run(&r2.opts(&tip2), &mut Rec::new()).line.contains("\"x\" exists"));
}

#[test]
fn no_hook_runs() {
    let r = Repo::new("merge-hooks");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let marker = r.root.join(".git").join("HOOK_RAN");
    let hooks = r.root.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for h in ["post-checkout", "post-merge", "post-index-change", "reference-transaction", "pre-commit", "commit-msg", "post-commit"] {
        let p = hooks.join(h);
        std::fs::write(&p, format!("#!/bin/sh\necho {h} >> '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert_eq!(run(&r.opts(&tip), &mut Rec::new()).kind, Kind::Landed);
    assert!(!marker.exists(), "hooks ran: {:?}", std::fs::read_to_string(&marker));
}

#[test]
fn the_dry_run_changes_no_ref_index_or_file_and_posts_nothing() {
    let r = Repo::new("merge-dry");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let refs = r.git(&["for-each-ref"]);
    let mut o = r.opts(&tip);
    o.dry_run = true;
    let mut io = Rec::new();
    let rep = run(&o, &mut io);
    assert_eq!(rep.kind, Kind::Planned, "{}", rep.line);
    assert!(rep.line.contains("No ref, index or file was changed and no note was posted"));
    assert_eq!(r.git(&["for-each-ref"]), refs);
    assert_eq!(r.git(&["status", "--porcelain"]), "");
    assert!(r.read("b.txt").is_none());
    assert!(io.notes.is_empty() && !r.lock().exists());
}

#[test]
fn before_the_swap_another_branch_at_the_same_oid_or_a_moved_target_refuses() {
    // HEAD switched to a twin branch at OLD: the swap must not go anywhere.
    let r = Repo::new("merge-twin");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let old = r.rev("main");
    let mut io = Rec::at(|g, root| {
        if g == Gap::BeforeSwap {
            sh(root, &["checkout", "-q", "-b", "twin"]);
        }
        true
    });
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Refused, "{}", rep.line);
    assert!(rep.line.contains("HEAD now points at refs/heads/twin"), "{}", rep.line);
    assert_eq!((r.rev("main"), r.rev("twin")), (old.clone(), old));
    assert!(io.notes.is_empty() && !r.lock().exists());
    // The target moved to an ancestor (a soft reset): the swap's OLD no longer holds.
    let r2 = Repo::new("merge-ancestor-move");
    r2.write("c.txt", "c\n");
    r2.commit("second main commit");
    let tip2 = r2.feature(&[("b.txt", "bee\n", "b\n")]);
    let mut io2 = Rec::at(|g, root| {
        if g == Gap::BeforeSwap {
            sh(root, &["update-ref", "refs/heads/main", "HEAD~1"]);
        }
        true
    });
    let before = r2.rev("main~1");
    let rep2 = run(&r2.opts(&tip2), &mut io2);
    assert_eq!(rep2.kind, Kind::Refused, "{}", rep2.line);
    assert_eq!(r2.rev("main"), before, "left where the other writer put it");
}

#[test]
fn a_takeover_after_the_swap_stops_before_any_index_or_file_write() {
    let r = Repo::new("merge-takeover");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let old = r.rev("main");
    let index_before = std::fs::read(r.root.join(".git/index")).unwrap();
    let mut io = Rec::at(move |g, root| {
        if g == Gap::AfterSwap {
            sh(root, &["symbolic-ref", "HEAD", "refs/heads/other"]);
            sh(root, &["update-ref", "refs/heads/other", &old]);
        }
        true
    });
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::RefLandedCheckoutNotStarted, "{}", rep.line);
    assert!(rep.line.contains("did NOT finish") && rep.line.contains("taken over after the swap (HEAD now points at refs/heads/other"), "{}", rep.line);
    assert_ne!(r.rev("main"), r.rev("other"), "the target ref did move");
    assert!(r.read("b.txt").is_none(), "no file was written");
    assert_eq!(std::fs::read(r.root.join(".git/index")).unwrap(), index_before, "the index is byte-identical");
    assert_eq!(io.notes.len(), 1, "the note says what happened");
    assert!(r.lock().exists(), "the unsettled state stays recorded");
}

#[test]
fn a_file_appearing_at_a_new_path_after_the_swap_is_not_overwritten() {
    let r = Repo::new("merge-appear");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let mut io = Rec::at(|g, root| {
        if g == Gap::AfterSwap {
            std::fs::write(root.join("b.txt"), "someone else's\n").unwrap();
        }
        true
    });
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::RefLandedCheckoutNotStarted, "{}", rep.line);
    assert!(rep.line.contains("\"b.txt\" now exists where the merge adds a path"));
    assert_eq!(r.read("b.txt").as_deref(), Some("someone else's\n"));
}

#[test]
fn a_checkout_failure_is_classified_by_read_back() {
    // Refused before writing anything: the only new path is in a read-only dir.
    let r = Repo::new("merge-ro");
    let tip = r.feature(&[("d/new.txt", "new\n", "d/new\n")]);
    let d = r.root.join("d");
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o555)).unwrap();
    let rep = run(&r.opts(&tip), &mut Rec::new());
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(rep.kind, Kind::RefLandedCheckoutNotStarted, "{}", rep.line);
    assert!(rep.line.contains("untouched") && rep.line.contains("git read-tree -m -u"), "{}", rep.line);
    // Failed partway: a.txt is rewritten before d/new.txt cannot be created.
    let r2 = Repo::new("merge-partial");
    let tip2 = r2.feature(&[("a.txt", "rewritten\n", "a\n"), ("d/new.txt", "new\n", "d/new\n")]);
    let mut o = r2.opts(&tip2);
    o.message_file = Some(message_file(&r2, "Both\n"));
    let d2 = r2.root.join("d");
    std::fs::set_permissions(&d2, std::fs::Permissions::from_mode(0o555)).unwrap();
    let rep2 = run(&o, &mut Rec::new());
    std::fs::set_permissions(&d2, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(rep2.kind, Kind::RefLandedCheckoutIncomplete, "{}", rep2.line);
    assert!(rep2.line.contains("may be partly updated") && !rep2.line.contains("git read-tree -m -u"), "no replay is suggested: {}", rep2.line);
}

#[test]
fn a_second_merge_and_a_stale_lock_refuse_with_what_to_check() {
    let r = Repo::new("merge-lock");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    std::fs::write(r.lock(), serde_json::to_string(&json!({ "pid": std::process::id(), "phase": "bound" })).unwrap()).unwrap();
    assert!(run(&r.opts(&tip), &mut Rec::new()).line.contains(&format!("another tmm merge (pid {}) is running", std::process::id())));
    // A dead pid: what it recorded, and that it is never removed here.
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    std::fs::write(r.lock(), serde_json::to_string(&json!({
        "pid": dead, "phase": "checked-out", "issue": 445, "target": "refs/heads/main", "old": "o", "src": "s", "new": "n", "note": "tmm merge #445: saved"
    })).unwrap()).unwrap();
    let rep = run(&r.opts(&tip), &mut Rec::new());
    assert!(rep.line.contains("stopped without finishing") && rep.line.contains("phase 'checked-out'") && rep.line.contains("tmm board show 445")
        && rep.line.contains("Saved note: tmm merge #445: saved") && rep.line.contains("remove"), "{}", rep.line);
    assert!(r.lock().exists());
}

#[test]
fn an_interruption_after_the_checkout_leaves_the_recorded_phase() {
    let r = Repo::new("merge-interrupt");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let mut io = Rec::at(|g, _| g != Gap::AfterCheckout);
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Interrupted);
    assert!(io.notes.is_empty());
    let lock: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
    assert_eq!(lock["phase"], "checked-out");
    assert_eq!(lock["new"].as_str(), Some(r.rev("main").as_str()), "the lock names the commit that landed");
    assert_eq!(lock["target"], "refs/heads/main");
}

#[test]
fn a_note_that_was_refused_or_lost_is_said_and_the_merge_is_not_rerun() {
    for (answer, says) in [
        (NoteResult::Refused("no issue #445 on this board".into()), "NOTE NOT POSTED"),
        (NoteResult::Unknown("rpc timeout".into()), "NOTE UNKNOWN"),
    ] {
        let r = Repo::new("merge-note");
        let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
        let mut io = Rec::new();
        io.answer = answer;
        let rep = run(&r.opts(&tip), &mut io);
        assert_eq!(rep.kind, Kind::Landed);
        assert!(!rep.ok(), "a merge whose note did not post is not a success");
        assert!(rep.line.contains(says) && rep.line.starts_with(&io.notes[0]), "{}", rep.line);
        let lock: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
        assert_eq!(lock["note"].as_str(), Some(io.notes[0].as_str()), "the note text is saved for posting by hand");
        // A second run refuses at the lock, and would refuse on the diff too.
        std::fs::remove_file(r.lock()).unwrap();
        let again = run(&r.opts(&tip), &mut Rec::new());
        assert_eq!(again.kind, Kind::Refused, "{}", again.line);
    }
}

#[test]
fn a_read_back_that_does_not_match_after_the_checkout_is_unconfirmed() {
    let r = Repo::new("merge-readback");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    // Someone edits a tracked file right after the checkout.
    let mut io = Rec::at(|g, root| {
        if g == Gap::AfterCheckout {
            std::fs::write(root.join("a.txt"), "edited meanwhile\n").unwrap();
        }
        true
    });
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Unconfirmed, "{}", rep.line);
    assert!(rep.line.contains("did NOT finish") && rep.line.contains("a tracked file does not match the index"), "{}", rep.line);
    assert_eq!(r.read("a.txt").as_deref(), Some("edited meanwhile\n"), "nothing rolled back or overwritten");
    assert!(r.lock().exists(), "the unsettled state stays recorded");
}

// ── reviewer's implementation findings on f3a34d16 ──

/// P1-A: a path git would QUOTE in text output is checked by its real bytes.
#[test]
fn an_ignored_file_with_a_quoted_or_non_utf8_name_is_still_found_and_kept() {
    use std::os::unix::ffi::OsStrExt;
    for name in ["中文.log".as_bytes(), b"tab\there.log", b"new\nline.log", b"\xffbad.log"] {
        let r = Repo::new("merge-names");
        let path = r.root.join(std::ffi::OsStr::from_bytes(name));
        r.git(&["checkout", "-q", "-b", "feat"]);
        std::fs::write(&path, "from the branch\n").unwrap();
        let o = Git::command(&r.root).args(["add", "-f", "--"]).arg(std::ffi::OsStr::from_bytes(name)).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        r.git(&["commit", "-q", "-m", "track an odd name"]);
        let tip = r.rev("HEAD");
        r.git(&["checkout", "-q", "main"]);
        std::fs::write(&path, "mine\n").unwrap();
        let old = r.rev("main");
        let rep = run(&r.opts(&tip), &mut Rec::new());
        assert_eq!(rep.kind, Kind::Refused, "{name:?}: {}", rep.line);
        assert!(rep.line.contains("exists (untracked or ignored) where the merge adds a path"), "{name:?}: {}", rep.line);
        assert_eq!(std::fs::read(&path).unwrap(), b"mine\n", "{name:?}: the user's bytes are kept");
        assert_eq!(r.rev("main"), old);
    }
}

/// P1-A: a path that cannot be looked at is never treated as free.
#[test]
fn a_path_that_cannot_be_checked_refuses() {
    let r = Repo::new("merge-unchecked");
    let tip = r.feature(&[("locked/x.txt", "x\n", "x\n")]);
    let locked = r.root.join("locked");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let old = r.rev("main");
    let rep = run(&r.opts(&tip), &mut Rec::new());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(rep.kind, Kind::Refused, "{}", rep.line);
    assert!(rep.line.contains("cannot be checked") && rep.line.contains("cannot be confirmed free"), "{}", rep.line);
    assert_eq!(r.rev("main"), old);
}

/// P1-B: the checks before landing never write the index, even when its
/// stat cache is stale for a file whose content did not change.
#[test]
fn a_dry_run_and_a_refusal_leave_the_index_bytes_alone_with_a_stale_stat_cache() {
    let r = Repo::new("merge-stat");
    let tip = two_commit_branch(&r);
    // Same bytes, an mtime well off the index entry's (not a "racy" one): a
    // plain `git diff --quiet` rewrites the index here (measured, git 2.50.1).
    let f = std::fs::OpenOptions::new().write(true).open(r.root.join("a.txt")).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(30)).unwrap();
    drop(f);
    let index = || std::fs::read(r.root.join(".git/index")).unwrap();
    let before = index();
    let mut o = r.opts(&tip);
    o.dry_run = true;
    o.message_file = Some(message_file(&r, "Both\n"));
    let rep = run(&o, &mut Rec::new());
    assert_eq!(rep.kind, Kind::Planned, "a stale stat cache is not a change: {}", rep.line);
    assert_eq!(index(), before, "the dry run wrote the index");
    let rep = run(&r.opts(&tip), &mut Rec::new()); // refused: two commits, no message file
    assert_eq!(rep.kind, Kind::Refused);
    assert_eq!(index(), before, "a refusal wrote the index");
}

/// P1-B: a lock is read FIRST, so a real stop after the swap is reported with
/// what it recorded and what git says now, not bound over.
#[test]
fn a_run_stopped_after_the_swap_or_the_checkout_is_reported_by_the_next_run() {
    for (gap, phase, index_says) in [(Gap::AfterSwap, "swapped", "the index matches OLD"), (Gap::AfterCheckout, "checked-out", "the index matches NEW")] {
        let r = Repo::new("merge-restart");
        let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
        let rep = run(&r.opts(&tip), &mut Rec::at(move |g, _| g != gap));
        assert_eq!(rep.kind, Kind::Interrupted);
        let rec = orphan(&r);
        let new = rec["new"].as_str().unwrap().to_string();
        let mut o = r.opts(&tip);
        o.dry_run = true; // even a dry run reads the lock first
        let again = run(&o, &mut Rec::new());
        assert_eq!(again.kind, Kind::Refused);
        assert!(again.line.ends_with("This run did nothing.") && !again.line.contains("Nothing was merged"), "it does not deny what the earlier run did: {}", again.line);
        assert!(again.line.contains(&format!("(read in this checkout, {})", r.root.display())), "{}", again.line);
        for want in [format!("recorded phase '{phase}'"), format!("is now NEW {new}: the swap happened"), index_says.to_string(), "never removes it".to_string()] {
            assert!(again.line.contains(&want), "{phase}: {want:?} in {}", again.line);
        }
        assert!(r.lock().exists());
    }
}

/// P1-C: the intent is recorded before the swap, so a crash between a
/// successful swap and its record still says what git shows.
#[test]
fn a_crash_between_the_swap_and_its_record_is_read_from_git() {
    let r = Repo::new("merge-swapdone");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let rep = run(&r.opts(&tip), &mut Rec::at(|g, _| g != Gap::SwapDone));
    assert_eq!(rep.kind, Kind::Interrupted);
    let rec = orphan(&r);
    assert_eq!(rec["phase"], "swapping", "the durable intent");
    let again = run(&r.opts(&tip), &mut Rec::new());
    assert!(again.line.contains("recorded phase 'swapping'") && again.line.contains(&format!("is now NEW {}: the swap happened", rec["new"].as_str().unwrap())), "{}", again.line);
}

/// P1-C: a swap git reports as failed is classified by reading the ref.
#[test]
fn a_swap_reported_as_failed_but_done_is_unconfirmed_and_touches_nothing() {
    let r = Repo::new("merge-swaperr");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let old = r.rev("main");
    let mut io = Rec::fault(|f| f == Fault::SwapReportsError);
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Unconfirmed, "{}", rep.line);
    assert!(rep.line.contains("the swap reported an error") && rep.line.contains("reads NEW"), "{}", rep.line);
    assert_ne!(r.rev("main"), old, "the ref did move");
    assert!(r.read("b.txt").is_none(), "no checkout after an unconfirmed swap");
    assert!(r.lock().exists() && !rep.ok());
    assert!(io.notes[0].contains("did NOT finish"), "the note never claims success");
}

/// P1-C: a record that cannot be saved after the swap stops the run and keeps
/// the previous valid record.
#[test]
fn a_record_that_cannot_be_saved_after_the_swap_stops_with_the_previous_record() {
    for (phase, kept) in [("swapped", "swapping"), ("checking-out", "swapped"), ("checked-out", "checking-out")] {
        let r = Repo::new("merge-recfail");
        let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
        // A lost record after the swap ENDS the run: no later record, no
        // note (reviewer P1-C residual on 8533a8cf).
        let mut io = Rec::fault(move |f| f == Fault::Record(phase));
        let rep = run(&r.opts(&tip), &mut io);
        assert_eq!(rep.kind, Kind::Unconfirmed, "{phase}: {}", rep.line);
        assert!(rep.line.contains("could not be saved") && rep.line.contains("did NOT finish") && rep.line.contains("no note was posted"), "{phase}: {}", rep.line);
        assert!(io.notes.is_empty(), "{phase}: nothing is posted after a lost record");
        assert!(!rep.ok() && rep.record_lost.is_some());
        assert_eq!((rep.json["record"]["state"].as_str(), rep.json["note"]["state"].as_str()), (Some("lost"), Some("not_attempted")), "{phase}");
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
        assert_eq!(rec["phase"].as_str(), Some(kept), "{phase}: the previous valid record is kept, nothing written after it");
        if phase != "checked-out" {
            assert!(r.read("b.txt").is_none(), "{phase}: stopped before the checkout");
        }
    }
}

/// P1-C: a record write interrupted halfway leaves the previous valid one,
/// and an unreadable lock refuses and is kept.
#[test]
fn a_half_written_record_and_an_unreadable_lock_are_handled() {
    let r = Repo::new("merge-halfwrite");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let _ = run(&r.opts(&tip), &mut Rec::at(|g, _| g != Gap::AfterSwap));
    orphan(&r);
    std::fs::write(r.lock().with_extension("lock.tmp"), b"{\"phase\": \"che").unwrap();
    let again = run(&r.opts(&tip), &mut Rec::new());
    assert!(again.line.contains("recorded phase 'swapped'"), "the intact record is read: {}", again.line);
    std::fs::write(r.lock(), b"not json").unwrap();
    let broken = run(&r.opts(&tip), &mut Rec::new());
    assert!(broken.line.contains("cannot be read") && r.lock().exists(), "{}", broken.line);
}

/// P1-C: a record write cut halfway (the process died in it) leaves the
/// previous valid record readable.
#[test]
fn a_record_write_cut_halfway_leaves_the_previous_record() {
    let r = Repo::new("merge-torn");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let mut io = Rec::fault(|f| f == Fault::TornRecord("swapped"));
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Unconfirmed, "{}", rep.line);
    assert!(io.notes.is_empty(), "nothing is posted after a lost record");
    let rec: Value = serde_json::from_slice(&std::fs::read(r.lock()).unwrap()).expect("the lock still parses");
    assert_eq!(rec["phase"], "swapping", "the record before the torn one");
    assert!(r.read("b.txt").is_none());
}

/// P2-E: a revision is not a branch.
#[test]
fn a_revision_expression_is_not_accepted_as_a_branch() {
    let r = Repo::new("merge-rev");
    let tip = two_commit_branch(&r);
    let mut o = r.opts(&tip);
    o.branch = "feat~1".into();
    let rep = run(&o, &mut Rec::new());
    assert!(rep.line.contains("no branch refs/heads/feat~1 here (a branch name, not a revision)"), "{}", rep.line);
}

/// P1-C residual on 8533a8cf: a merge that LANDED and read back, whose final
/// record cannot be saved, posts nothing and is not a success.
#[test]
fn a_landed_merge_whose_note_record_is_lost_posts_nothing_and_fails() {
    let r = Repo::new("merge-noting");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let old = r.rev("main");
    let mut io = Rec::fault(|f| f == Fault::Record("noting"));
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::Landed, "the ref did land and read back: {}", rep.line);
    assert!(!rep.ok(), "but the run is not a success");
    assert!(io.notes.is_empty(), "the note is not posted without its record");
    assert!(rep.line.contains("RECORD NOT SAVED") && rep.line.contains("The merge LANDED and every read-back matched") && rep.line.contains("no note was posted"), "{}", rep.line);
    assert_eq!((rep.json["record"]["state"].as_str(), rep.json["note"]["state"].as_str(), rep.json["outcome"].as_str()), (Some("lost"), Some("not_attempted"), Some("Landed")));
    assert_ne!(r.rev("main"), old, "never described as not merged");
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
    assert_eq!(rec["phase"], "checked-out");
}

/// The same for a classified failure: its record lost means no note.
#[test]
fn an_unsettled_outcome_whose_record_is_lost_posts_nothing() {
    let r = Repo::new("merge-unsettled");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    let mut io = Rec::at(|g, root| {
        if g == Gap::AfterSwap {
            std::fs::write(root.join("b.txt"), "someone else's\n").unwrap();
        }
        true
    });
    io.fault = Box::new(|f| f == Fault::Record("unsettled"));
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(rep.kind, Kind::RefLandedCheckoutNotStarted, "{}", rep.line);
    assert!(io.notes.is_empty() && !rep.ok() && rep.record_lost.is_some());
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.lock()).unwrap()).unwrap();
    assert_eq!(rec["phase"], "swapped");
}

/// X7 (orchestrator ruling 13:31): an outside writer moves the target AFTER
/// the pre-swap re-read and before update-ref. Only the compare-and-swap
/// stands between that writer's commit and a silent overwrite.
#[test]
fn a_target_moved_after_the_re_read_is_never_overwritten() {
    let r = Repo::new("merge-cas");
    let tip = r.feature(&[("b.txt", "bee\n", "b\n")]);
    // Someone else's commit, ready to be put on main inside the window.
    r.write("c.txt", "theirs\n");
    r.git(&["add", "c.txt"]);
    let tree = r.git(&["write-tree"]);
    let old = r.rev("main");
    let theirs = r.git(&["commit-tree", &tree, "-p", &old, "-m", "theirs"]);
    r.git(&["reset", "-q", "--", "c.txt"]);
    std::fs::remove_file(r.root.join("c.txt")).unwrap();
    let index_before = std::fs::read(r.root.join(".git/index")).unwrap();
    let a_before = r.read("a.txt");
    let moved = theirs.clone();
    let mut io = Rec::at(move |g, root| {
        if g == Gap::BeforeCas {
            sh(root, &["update-ref", "refs/heads/main", &moved]);
        }
        true
    });
    let rep = run(&r.opts(&tip), &mut io);
    assert_eq!(r.rev("main"), theirs, "the other writer's commit is still the target: nothing was overwritten");
    assert_ne!(rep.kind, Kind::Landed, "{}", rep.line);
    assert!(!rep.ok());
    // The existing read-back classification stands: git refused the write,
    // and the target now holds a THIRD commit, so this is unconfirmed, never
    // "nothing was merged" (reviewer 13:31).
    assert_eq!(rep.kind, Kind::Unconfirmed, "{}", rep.line);
    assert!(rep.line.contains("the swap reported an error") && rep.line.contains("neither OLD") && !rep.line.contains("Nothing was merged"), "{}", rep.line);
    assert_eq!(std::fs::read(r.root.join(".git/index")).unwrap(), index_before, "the index is byte-identical");
    assert!(r.read("b.txt").is_none() && r.read("a.txt") == a_before, "the worktree is untouched");
}
