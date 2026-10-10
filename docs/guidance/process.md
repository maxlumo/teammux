# Guidance: Process, Testing and Documentation

> Tenets: 12 (rules beside their design, with reasons and incidents),
> 13 (isolate, verify, commit small), 1 (understand the root cause).
> Review questions: **How was this verified, on which device and build?
> Did the documentation follow? Do tests protect the wiring or only a helper?
> Does each commit express one idea?**
> Draft · 2026-09-09.

## 1. Principles

1. **Worktree isolation:** one worktree per task. The launch checkout is
   for reading, coordination and integration only.
2. **One idea per commit:** commit after verification, append instead of
   amending, and separate mechanical moves from logic changes.
3. **Test wiring with negative controls:** a passing helper does not prove
   its component is wired correctly. Break one thing and verify that exactly
   one corresponding test fails. Every regression fix starts with a failing test.
   `scripts/negative-controls.mjs` runs a list of such breaks against the
   committed tree and restores it from git, never from memory (an earlier
   scratch version once left a mutated file to be committed; #335 ②a-4).
4. **Documentation and code share a commit:** behavior changes update the
   design document's Rules and their reasons. Record decision, reason,
   date and triggering incident or measurement.
5. **Measure instead of guessing:** verify external-system behavior on real
   versions and record those versions in comments and documentation.
6. **Green is not proof:** acceptance concerns the client's actual build.
   Four incidents involved an old APK, desktop binary or unrefreshed page.
   A fix must reach the entry point the owner uses.
7. **Discuss large changes first:** present architecture, design-language
   and feature-removal plans in the room.
8. **Communicate concisely:** lead with conclusions, do not repeat, answer
   addressed messages and consolidate backlogs. Search history or ask
   when context is unclear. Speak Chinese to the owner; use English for
   documentation, code, commits and injected process instructions.
9. **Divide work and review independently:** the lead prevents conflicts
   without taking over implementation. Use adversarial review, not only
   implementer self-tests. Board states are todo -> doing -> review -> done;
   only the reviewer moves work to done.

## 2. Required and Forbidden

**Required**
- Create a worktree before the first tracked-file edit:
  `<repo>/worktree/<agent>-<task>` (gitignored, never outside the repository),
  branch `agent/<agent>/<task>`. Use absolute paths in commands.
- Commit bodies contain root cause, remedy, verification with device/version,
  related issue and co-author trailer.
- New modules include `<module>.test.ts` in the same commit. Source-contract
  tests explain why; prefer testable pure functions over regexes.
- Update both i18n branches together. README, design documents and scripts
  follow the code.
- Run Rust tests with `--test-threads=1`; isolate flaky shared-tmux tests
  on a separate socket.
- During negative verification, undo the temporary breakage by stashing or
  keeping a copy — never `git checkout` a file with uncommitted work in it
  (2026-09-09, board #113: the checkout restored HEAD and silently discarded
  the entire uncommitted fix, which had to be rebuilt from session notes).
- UI changes include screenshots or device observations for both layouts.
  CLI changes identify the tested CLI version.
- Update progress through `tmm status working`, finish with `tmm done`,
  and hand off through board `move review`.

**Forbidden**
- Editing tracked files in the launch checkout, absorbing another dirty
  tree or committing `agent-team-page/`.
- Amending handed-off commits or mixing two issues' hunks in one commit.
- Updating code without its documentation, documentation without its
  corresponding tests, or pinning implementation text instead of invariants.
- Marking self-tested work done or bypassing review.
- Asserting expected behavior without measurement or making external-behavior
  claims without a version.
- Redundant prompts, documentation or copy. After writing, remove a third.

## 3. Review Checklist

- [ ] Was the change developed in a worktree, with only this task's hunks committed?
- [ ] Does the commit describe the root cause, verification and device/version?
- [ ] Did a failing regression test precede the fix, and was a negative control used?
- [ ] Do tests protect component wiring/user-visible behavior or only helper functions?
- [ ] Is the design rule updated with its date and incident?
- [ ] Were both layouts checked? Which build was tested, and can the owner's client see it?
- [ ] Do external-system claims name a version?
- [ ] Are `npm test`, `npm run check` and `test:rust` results reported?
- [ ] Was every addressed message answered? Was `tmm done` used and the board moved to review?
- [ ] Were design-level changes discussed beforehand?

## 4. Lessons

- 2026-09-01: shared-checkout work mixed #44 hunks into #43, left styles
  incomplete between commits and broke other people's checks.
  An interrupted editor inserted duplicate tests.
- 2026-08-31: "helpers being green must not cover a rewired component".
  A false-alarm test was fixed on 2026-08-20 ("crying wolf"); since late August,
  fix commit bodies commonly state "negative-controlled".
- By 2026-05-03 a signature change had already broken `cargo test`.
  fetch-fonts.sh output disagreed with index.html; three documents promised
  an unimplemented double-tap gesture; CLAUDE.md named nonexistent symbols.
- 2026-08-30: board #22 source tests passed while the owner used an old
  macOS bundle. #31/#90/#97/#99 repeatedly required identifying the actual
  entry point and build: "哪个入口/哪个构建".
- Development traps included a server-injected `release/` PATH with only
  a debug tmm build, a Gradle symlink to another checkout's APK, a Vite patch
  missing in dev, and a build between version stamping and migration that
  permanently omitted a table until `Store::heal`.
- 2026-08-05: shared tmux state made `adopt_then_down_then_up` flaky;
  use an isolated `-S` socket.
- 2026-09-20 (board #208): `t07_capture_scrollback` waited a FIXED 1 s for 100 echo lines on the shared tmux and failed under a parallel cargo build (load ~6), passing alone. A test that waits for the terminal must poll for the expected paint with a deadline (`pane_shows` in `main.rs`), never sleep a guessed number; verified 5× green under a concurrent build at load ~15.
- 2026-09-20 (board #216): a test suite must not read the operator's config. Opening the live `kiro_engine = "v3"` door turned three v2-default lib tests red on EVERY branch, because `config::kiro_engine()` fell back to the real `~/.config/tmux-mobile/config.toml`; the same class had earlier pointed the whole test process at the real `state.db`. Per-test opt-in (`use_test_store`) is forgettable; the isolation door belongs where the path is resolved (`cfg(test)` temp dir in `config::dirs_next()`, see testing.md), so green means the same thing on every host.
- Board lessons: #19 took three rounds to find the cause; #97 had three
  kiro lang/stack changes before claude found font features; #56 treated
  click-through ("点击
  穿透") as an occlusion problem; #89 turned extra menu options
  ("其他选项菜单") into a visible three-dot button; #38's global numbering decision was reversed.
- 2026-09-02: CLAUDE.md shrank from 117KB to an 11KB map.
  Owner: "源代码文件夹里不应该有 claude.md，入口太乱了".
- Repeated owner guidance: "先讨论方案，不要直接修改代码";
  "保持中文语言风格干练，不啰嗦"; "流程应该用英文，保持一致性".
- 2026-09-08: "大家要分工明确，lead 不要过分代劳，不同人要对抗评审，对立统一".
- A dependency change (package.json / Cargo.toml) is installed in the launch checkout at merge time, and the reviewer runs the suite THERE, not only in the branch worktree — a worktree with private node_modules can be green while the integration checkout is red (2026-09-09: jsdom from board #115 lived only in one worktree; main’s npm test failed for an hour before anyone ran it in place). Match the checkout’s package-manager layout (this host: pnpm) when installing.
- An evidence run closes what it opened, in a `finally`: browser, playwright/agent-browser daemon, preview server. 2026-09-12: five leaked playwright-cli daemons with headless Chromium (17 h to 3.8 days old, two GPU processes at 99% CPU) drove the host to load average 54, and every render test in a review run timed out at 60 s — read first as a branch defect (board #177). A reviewer who sees a burst of timeouts checks the host (`uptime`, `pgrep -fa headless`) before returning FIX FIRST.

## 5. The Review Flow (board #105, 2026-09-10)

How an issue travels, as practised on 2026-09-09 across ~50 issues.

**Assignment.** The lead files the issue with the finish line in the body
(scope, constraints, how to verify) and either `--assignee` at creation or an
addressed `@name` message; the implementer answers with `tmm board take`.
One issue at a time per agent; the next is sent after the previous lands.

**Plan first** for anything that touches more than ~1000 lines, crosses
module boundaries, or changes a storage key or wire shape: the implementer
posts a measured plan as board notes (map with line ranges, target shape,
mechanical step order with the tests that pin each step, non-negotiables);
the lead approves or corrects on the issue and splits it into child issues.
No code before approval.

**Implementation** happens in the implementer's own worktree. Mechanical
moves and behaviour changes are separate commits. Every commit carries its
verification in the body: root cause, tests (red first for fixes), negative
control, browser/device matrix and versions. A defect found on the way is
filed as its own issue, never fixed inside a move. When ready:
`tmm board move <id> review` with a note that names the branch, HEAD, the
base commit and the evidence.

**Review** is done by the reporter (the lead) or, for large changes, by
one reviewer per guidance lens — architecture, agent bridge, code quality,
UI/interaction, security, process — each posting findings as board notes
tagged with the lens; the lead consolidates. The reviewer reads the commits
against the matching checklists, then runs the suites **in the integration
checkout** (a worktree with private `node_modules` can be green while main
is red). Verdict goes on the issue as a note.

**Merge** is the reviewer's act, from the integration checkout: fast-forward
when the branch is on main, cherry-pick when main has moved under it
(rebase requests go back to the implementer only when a conflict needs
their judgement). The implementer never merges its own work — a deletion
merged ahead of review on 2026-09-09 was accepted only because tests and a
grep backed it. After a Rust merge the supervised watcher restarts the
server; after a wire change the signed APK and any desktop bundle are
rebuilt from main. The implementer removes its worktree and branch.

**Done** is the reviewer's move. Owner-visible behaviour (a click the owner
reported, a gesture on the phone) stays in `review` after the code is merged
until the owner confirms on their own client or device; the note records the
build hash they tested.

**Signals that the flow is failing:** an implementer's turn ends at an
acknowledgement with no worktree, commit or note behind it (verify progress
with `tmm board show` and `git worktree list`, not with replies); a review
sits unanswered for hours (the lead scans the review column every turn);
a branch is "ready" but based on a stale main (always state the base).
