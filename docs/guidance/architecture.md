# Guidance: Architecture and Boundaries

> Tenets: 2 (shell), 4 (no central node), 7 (declaration is truth),
> 8 (derive, never self-report).
> Review questions: **Does this code cross the shell's boundary? Where is
> the truth? What happens when the server dies?**
> Draft · 2026-09-09 · English edition of the Chinese discussion draft.

## 1. Principles

1. **The shell owns four things:** connection, room, identity and window.
   For any other capability, first look for a native integration point in
   the underlying tool: environment, configuration, hooks or launch arguments.
   If none exists, explain why in the design document.
2. **Truth has only two stores:** state.db and `<ws>/.tmm/`. Window names,
   pane text, processes and in-memory caches are disposable, rebuildable projections.
3. **The server is an observer:** a flow that leaves a person or agent
   blocked when the server process dies is a design error.
4. **One definition function per concept:** decisions such as `managed_home`,
   `detect_pane`, `valid_name` and `SPAWNABLE_BACKENDS` have one implementation
   shared by every entry point.
5. **Contain backend differences:** each CLI needs its own configuration,
   hook dialect and status-line implementation. Adding a backend must add
   only one backend file, not another downstream branch. The full list of what
   a new backend must answer is [adding-a-backend.md](adding-a-backend.md).
6. **Follow external systems' documentation:** tmux, CLIs and SQLite have
   versions and parsing rules. Verify format strings, targets and migration
   semantics against those rules, and record the version in comments.

## 2. Required and Forbidden

**Required**
- Idempotence: repeated `up`, restart, refresh and migration operations have
  the same result.
- Record before acting: write `launch.json` before creating the window;
  failure to write it fails the spawn.
- Delete in order: successfully `down`, then remove the home, then the row.
  Ignoring a `down` failure leaves an orphan session that `auto_adopt` can revive.
- Use exact tmux targets, `=name:`; `-t name` performs prefix/glob matching.
  Escape delimiters according to the installed tmux version.
- Run synchronous I/O (rusqlite, tmux subprocesses, sleep) in `spawn_blocking`.
  Do not hold a `std::Mutex` guard across `await` or a store lock while observing tmux
  (tested for `projects/mod.rs`: `no_tmux_work_runs_under_the_store_lock`, board #149).
- Use `PRAGMA foreign_keys=OFF` for SQLite migrations; PATCH updates each
  field through COALESCE.
- Treat agent configuration on disk as code. Hook/prompt structure changes
  must make `refresh_hooks`/`refresh_agent` self-heal homes on the next launch.
- A `#[cfg]` gate applies to the next item. Before inserting a function below
  it, verify that the original item remains gated. Protect Android build
  boundaries with desktop-side source-contract tests.

**Forbidden**
- Reimplementing existing underlying capabilities: process management,
  session recovery, tool loops or message buses.
- In-process buses, daemons requiring persistent connections, or private
  protocols only the server understands.
- Treating a window name, pane text or process existence as identity or truth.
- Defining the same backend fact twice: resume syntax, allowlists or hook names.
- Branching on backend strings in a generic module such as `tmux.rs`.
  Screen-triggered adaptations require measurements and tests.

## 3. Review Checklist

- [ ] Does the change belong to connection, room, identity or window? If not,
  were native integration points investigated?
- [ ] Where is new state stored? Can state.db + `.tmm/` reconstruct it?
  Is it still correct after restart?
- [ ] Would killing the server now leave a person or agent blocked?
- [ ] Is there a second definition of managed identity, detection, validation
  or the backend list?
- [ ] Do backend literals (`"kiro"|"claude"|"codex"|"grok"|"omp"`) appear outside backend files? (Tested: `backends::tests::backend_literals_live_only_in_backends`, `core/backends.source.test.ts` — a measured quirk in generic code needs a `// backend-quirk(measured):` marker.)
- [ ] Were tmux targets and format strings checked against the relevant version?
- [ ] Is synchronous I/O running on a tokio worker, or a lock held across await?
- [ ] Does migration work on an old database with `foreign_keys=OFF`?
- [ ] Will existing agents receive repaired hooks/prompts/configuration at next launch?

## 4. Lessons and Evidence

- 2026-08-18: recipe-free restart used user-space configuration, leaving the
  agent "能答但聋"; this led to `launch.json`.
- 2026-09-03: `spawn` wrote the recipe last and ignored failure. A full disk
  produced a running agent that lost its input integration after restart;
  the recipe now comes first.
- 2026-09-08: replaying old recipes verbatim never delivered new AGENTS.md
  instructions; `refresh_agent` rematerializes them.
- 2026-09-03: `kill_session("dev")` killed `dev-2` through `-t` prefix
  matching; exact `=name:` targets replaced it.
- 2026-06-15: tmux >=3.4 octal-escaped `\x1f`, breaking a delimiter that
  had replaced `|` only the previous day.
- 2026-09-03: inline `@all` fan-out on a tokio worker blocked every
  connection's pushes; capture ticks traversed tmux while holding the store lock.
- 2026-08-30: inserting a function below `#[cfg]` moved the gate to the
  wrong item; two commits later Android had ten compilation errors.
- 2026-09-07: two backend allowlists let omp spawn but rejected
  `registry save`; `SPAWNABLE_BACKENDS` unified them.
- 2026-09-03: one of seven hand-built detection haystacks omitted the window
  name; `detect_pane` replaced them.
- 2026-09-03: `agent_remove("../..")` could delete the workspace;
  `valid_name` now validates the allowlist at entry.
- The snapshots table held one entry per project in measurement, and
  `restore` did not update running state; the table was deleted.
- The agora bus required persistent `wait` connections. Server failure
  silenced the team, so the owner decided to delete the bus entirely.
- `auto_adopt_once`: every session is a project; the server follows tmux.
