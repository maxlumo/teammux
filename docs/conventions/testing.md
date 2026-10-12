# Testing Conventions

Frontend tests and repository development-script tests run with `npm test`
(`node --test`, no framework, no tmux needed). Rust tests: `npm run test:rust`
(`cargo test -- --test-threads=1`, needs a running tmux). This file governs the
frontend side, and the one Rust rule below.

## The Rust suite runs SEQUENTIALLY and ISOLATED, and never kills a server it did not make (board #349)

Incident 2026-10-12 05:51: a bare `cargo test … --lib` — no `--test-threads=1`
— killed the developer's DEFAULT tmux server; every session on this host
(four projects' agents, the owner's shells) was lost. Mechanism: the tasks
tests' private-server helper issued `kill-server` through the process-global
socket (`tmux::set_socket`); run in parallel, the gateway probe tests, which
start a server and so set that global to `None`, had just reset it, and the
kill landed on whatever `tmux` resolves on its own — the default server.
The only protection was a sentence in a comment saying "sequential tests".

Incident #2, the same day, 07:12:21: the fix for 05:51 was under review, and a
negative control on it — a mutation that deliberately put the 05:51 bug back
(`kill-server` through the global) to prove a test would notice — was run in
the developer's own shell: `$TMUX` set, no `TMUX_TMPDIR`, no throwaway victim.
The new scope had restored the global to `None` before the mutated kill ran,
so the deliberately broken kill went to the real default server. Every session
on the host was lost a second time. Two lessons that are now mechanism, not
rules of conduct: a test process must never be able to SEE a real tmux, and a
helper must destroy its server before anything restores the global.

Four mechanical rules replaced the comment, the first in `scripts/test-rust.mjs`
and the rest in `tmux::test_support`:

- **`npm run test:rust` isolates the test process from every real tmux.** It
  runs cargo with `TMUX` and `TMUX_PANE` unset and `TMUX_TMPDIR` set to a fresh
  `mkdtemp` directory, always with `--test-threads=1` last (so nothing a caller
  adds can raise it), and afterwards kills — each by its own `-S` path — any
  server a test left under that directory, then removes it. The "default"
  server a test could reach is an empty throwaway that did not exist before
  the run. The real server's socket is simply not where the process will look.
  Any other cargo test invocation on this host wraps itself the same way:
  `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$(mktemp -d /tmp/tmm-iso-XXXX) cargo
  test … -- --test-threads=1`. The split of guarantees: the wrapper guarantees
  the directory is FRESH; the Rust gate guarantees only that the process is
  NOT looking at the real tmux (`$TMUX`/`$TMUX_PANE` unset, some
  `TMUX_TMPDIR` set) — it cannot tell a fresh dir from a reused one, and the
  private servers' own sockets live under `std::env::temp_dir()`, not under
  `TMUX_TMPDIR`. The cleanup claim is for the wrapper's normal and error exit
  (its `finally`); a wrapper killed with SIGKILL leaves the dir, which the
  next run does not reuse.

- **A destructive command names its server on the command line.**
  `destroy_private_server(socket)` runs `tmux -S <socket> kill-server` through
  `run_tmux_on`, never through the global — the type cannot express "no
  socket" — and refuses, with a panic a test cannot shrug off, anything
  `is_private_socket` rejects: not absolute, not under the temp dir, not a
  `tmm-test-*` file name, or the implicit socket (`tmux::implicit_socket()`:
  `$TMUX`'s path, else `$TMUX_TMPDIR`-or-`/tmp` `tmux-<uid>/default`, read
  from the environment without asking tmux). That is "a private test server's";
  it does not prove this test created it and does not claim to. Every private
  server is a `PrivateServer` (RAII: destroyed by its own socket on drop, on a
  passing test and on an assertion failure alike); `PrivateTmux` wraps one and
  its `Drop` does not consult the global at all.
- **A test touches the global inside ONE `GlobalSocket` scope.** Opening it
  locks the global and snapshots its value; dropping it restores the snapshot
  and only then unlocks — on a normal exit and on a panic — so the next test
  finds what it would have found, and no test writes the global outside a held
  scope (`GlobalSocket::set` is the only sanctioned write). Every `PrivateTmux`
  is started inside a scope the test holds; every probe test that starts a
  real server opens one first.
- **That scope refuses to open unless the run is serial AND isolated.** Before
  any tmux command or global write it reads what libtest reads — the test
  binary's argv for `--test-threads=1` / `--test-threads 1` (last one wins),
  else `RUST_TEST_THREADS=1`, else libtest's default of the machine's
  parallelism — and separately that `TMUX` and `TMUX_PANE` are unset and
  `TMUX_TMPDIR` is set; each failure panics with its incident's date and the
  commands that satisfy it. A mistake fails at once, needs no contention, and
  happens before a side effect. Pure-function and `Scratch` tests that never
  touch the global are not gated.
- **A `PrivateTmux` destroys its server BEFORE its scope restores the global.**
  Its `Drop` body kills the server by its own socket first and only then puts
  the global back, and `server` is declared before `guard` so the implicit
  drops agree. With the explicit `-S` the order changes nothing; it is the
  layer that holds if the `-S` is ever lost — the 07:12 kill found `None` in
  the global because the restore had already happened. A test pins both the
  body's statement order and the field order.

So `npm run test:rust` is the command, and the only one: a bare `cargo test`
fails fast at the first tmux-touching test — on parallelism, or on seeing a
real tmux — and kills nothing. Negative controls that touch a destroy path
(`kill-server`, socket removal, a sweep) are run only by the validator, on an
isolated victim, never in a developer's shell; a builder's evidence for such a
control is "left to validator". Reproduced on an isolated
`TMUX_TMPDIR` standing in for the default: before the fix one parallel run of
`tasks::tests gateway::probe::tests` killed it; after, every protected test
(12 of them) refused at the gate on each of three runs, no tmux command ran,
and the victim stayed alive. Controls, each on the committed code: dropping
the `-S` from the destroy path fails the own-socket test (a second private
server stands in for "the server the global now points at" and must survive
the first one's `Drop`); dropping a scope's restore fails the restore test
(two scopes in sequence, the second must open on the entry value); dropping
the serial check lets a protected test run under `--test-threads=4` in a
subprocess, which the gate test refuses to allow; dropping the refusal fails
the predicate test. An earlier control that removed only the probe tests'
locks did NOT revive the kill (the `-S` alone prevents it) — that was recorded
as such, and is why the lock's own contract is now tested as state
restoration, not as a prevented kill. `CARGO_TARGET_DIR` and worktrees are
fine.

## Three Test Tiers

### 1. Unit tests — `<module>.test.ts`

One test file per module, colocated, named EXACTLY after the module it
tests (`ws.test.ts` tests `ws.ts`; `agent-notifications.test.ts` tests
`agent-notifications.svelte.ts`). They import the module and test
behavior. If a module is worth extracting, its invariants are worth
pinning here.

Runes modules (`*.svelte.ts`) are testable in node with the shim:

```js
globalThis.$state = value => value;
```

### 2. Component Contracts: Source and Rendered Markup

`<Component>.source.test.ts` reads source and asserts deliberate wiring or
CSS contracts: which query a template calls, which navigation states exist,
or which cell owns overflow. These assertions do not execute handlers.

- Named after the component, colocated (`Terminal.source.test.ts` next
  to `Terminal.svelte`; `App.source.test.ts` next to `src/App.svelte`).
- One component per file. A cross-component contract gets one file per
  component, each asserting that component's half.
- When one fails after an intentional change, update the assertion —
  the failure means the change must be deliberate, not that it's wrong.
- Prefer upgrading to a real unit test whenever the logic can move into
  an importable module — source regexes are a last resort, and each one
  should explain WHY the invariant matters.

`<Component>.render.ts` compiles the real component through Vite SSR and
asserts its emitted markup (`Board.render.ts` was the first, as
`Board.render.test.ts`). A suite is a plain module of `test()` calls beside
its component that loads it through the ONE warm harness —
`const h = await renderHarness()` from `src/lib/test/ssr.ts`, then
`h.load('/src/lib/hub/X.svelte')`, `h.render`, `h.fragment(html)` — and it is
collected by `src/lib/test/render.test.ts`, the tier's single process. Every
suite runs under `{ timeout: RENDER_TIMEOUT_MS }`; the harness installs the
one browser-like environment (a jsdom window), so a suite sets no globals
and closes nothing. Prefer it over source regexes for rendered branches and
attributes. SSR does not run client effects or event handlers; it cannot
establish timing, listener order or reactive behavior after a click.

**The render tier is one process with a measured budget** (board #178, lead
2026-09-12: in three review runs every render test — seven of them — timed
out at 60 s together while reruns passed; passing runs showed 35–42 s each).
Measured on this host (16 cores, load ~20) a render process paid, before its
one test could start: import jsdom 1.1 s CPU, import vite 0.3 s,
createServer 0.7–0.9 s, the component graph 1.9–2.6 s (56 of Feed's 80
modules are the svelte runtime, recompiled identically in every process),
render + parse 0.25 s — 5.1 s CPU per file, 44 s CPU for seven files that
ran 2.5–5.4 s alone and 8 s inside the parallel suite; a host at load 54
(leaked headless browsers) stretched that to 35–42 s, and 60 s was 1.5× the
typical, not a budget. The tier is now one process behind one warm server:
the fixed cost is paid once at import, outside any test's timer, and each
suite's timer sees only its own component files. After: 5.9 s wall / 9.8 s
CPU for the whole tier alone; inside the suite the slowest suites are Drawer
3.4 s (xterm through `noExternal`) and Board 2.6 s, the rest 0.04–0.5 s.
`RENDER_TYPICAL_MS` (4 s, that slowest typical) and `RENDER_TIMEOUT_MS`
(20 s, 5× it; the rule is ≥ 3×) are the harness's contract;
`harness.source.test.ts` pins the ratio, that no `*.render.test.ts` process
creeps back, that every `*.render.ts` is on the collector's list, uses the
harness, sets no literal timeout and reaches for neither vite nor jsdom.

**A test harness holds no fixed port** (board #177, lead 2026-09-12). Several
agents share this host, so two `npm test` runs at once — the launch checkout
and a worktree — are normal, not a mistake. They collided: every render and
mount case in one run timed out at 60 s behind "WebSocket server error: Port
24678 is already in use", and a rerun minutes later was green. Vite 6's
`createServer` in middleware mode opens its OWN http server for the HMR
websocket on the fixed default 24678 even with `server.hmr: false` — that
flag only stops the update messages; `server.ws: false` is what opens no
socket (Vite 6.4.2, `if (config.server.ws === false)`). The render tier
therefore obtains its one server from the ONE helper, `src/lib/test/ssr.ts`
(`ssrServer({ cacheDir, … })`: middleware mode, `hmr: false`, `ws: false`,
no port), and the mount tier builds without serving.
`src/lib/test/harness.source.test.ts` pins both and that `createServer(`
appears nowhere else under `src/` or `scripts/`. Proof: two concurrent
`npm test` runs on the fix are both green with 24678 never bound; with
`ws: false` removed the guard fails and a single render test binds the port.

### 3. Client Behavior: `<Component>.mount.test.ts`

Board #115 adds one helper, `src/lib/test/mount.ts`, for executing the real
Svelte client component under `node --test`. `compileMount(component,
mockedModules)` builds once; its `mount(context, options)` creates a fresh
jsdom window for each scenario. Module implementations in `options.modules`
match the declared module order. Keep fixtures and assertions beside the
component, not in a general mock framework.

- Compile client output with browser export conditions, not `ssrLoadModule`.
  The component and `mount`/`tick`/`flushSync`/`unmount` share one Svelte runtime.
- Execute only the trusted test bundle in `getInternalVMContext()` with
  `runScripts: outside-only`. Never assign `global.window` in Node or allow
  document scripts/resources to execute.
- Mock the RPC boundary with explicit responses or controlled promises.
  Replies are JSON-cloned into the client realm. Unknown exports, network
  calls and jsdom errors fail the fixture even if the component catches them.
- Compile before enabling Node's mock clock. `advance(ms)` advances timers;
  `flush()` settles Svelte and the queued rAF callbacks. Do not sleep for
  timing assertions or run active mounts concurrently in one test process.
- Always close the mount in `finally`: unmount, clear frames, close the
  window and reset timers. Cleanup is also registered with the test context.
  Fresh localStorage and a new realm prevent one scenario seeding the next.
- Vite uses `configFile:false`, `write:false` and a unique temporary
  `cacheDir`, removed after compilation. No listener, optimizer, live
  `node_modules/.vite`, public assets or project `dist` is involved.
- Heavy packages (`pdfjs-dist`, Mermaid, highlight.js, KaTeX and xterm)
  are excluded at the test-build boundary; bare lazy package imports stay
  deferred. Attempting to use them fails explicitly. Never modify production
  components to make a fixture cheaper.

The initial proof is one `Hub.mount.test.ts` characterization: actual card
clicks select the recipient, defer its menu until 260ms, cancel a pending
menu when another card is clicked, and release the push subscription on
unmount. Three repeats of this same scenario reuse the bundle but not the DOM.
Its negative control removed the per-card guard and failed with `bob` where
the clicked recipient was `alice`.

**Scope:** this tier proves synthetic DOM event wiring, closures, reactive
updates, controlled async ordering, timers and cleanup. It does not prove
layout, sticky geometry, paint, browser navigation, native selection/IME,
clipboard/user activation or renderer output. jsdom has no layout engine;
the inert ResizeObserver and matchMedia defaults are environment fixtures,
not measured geometry. Use real Chromium for those claims.

**Measured cost** (2026-09-09, Node 22.23.2, Svelte 5.53.5, Vite 6.4.1,
jsdom 30.0.1, canonical npm lock): the initial all-dependency bundle took
21.38s with observed RSS around 1.4 GiB. Excluding heavy packages gave five
fresh-process runs at 7.56-7.88s wall time, including 5.13-5.45s compilation;
additional fresh-DOM repeats took 76-87ms, with 388-413 MiB peak RSS on Linux.
Each process had a fresh Vite cache; the OS page cache was not flushed.
Keep added cold-test cost within 10s and additional bundled scenarios below
500ms; remeasure before expanding the tier. These are budget evidence, not
flaky wall-clock assertions in the test.

## Rules

- New module → its `<module>.test.ts` lands in the same commit.
- Tests are TypeScript (`.test.ts`) — node executes them natively via
  type stripping, and `npm run check` verifies test code against the
  typed modules it exercises. Deliberately-partial test doubles are cast
  once at the boundary (`as unknown as X`) with a comment; don't build
  full fakes just to satisfy the checker.
- No test file without a clear subject; no subject with two test files of
  the same kind. A component may have source, SSR render and client-mount
  files: structure, emitted markup and executing behavior are different
  contracts. Use the cheapest tier that actually proves the claim.
- Every regression fix starts with a failing test that reproduces it.
- Rust tests never see the operator's `~/.config/tmux-mobile`. Under
  `cfg(test)` the lib's `config::dirs_next()` is ONE empty temp directory
  per test process (`/tmp/tmm-config-test-<pid>`), so every
  `config_dir()` consumer (config.toml, AGENTS.md, the hooks helper,
  skills-cache, the default state.db) reads defaults and writes scratch;
  a test cannot forget to isolate itself. Integration test crates build
  the lib without `cfg(test)` and point `XDG_CONFIG_HOME` — the app's one
  config-dir override — at a temp dir once per process
  (`isolate_config_dir` in `tests/concurrent_rpc.rs`). A test that WRITES
  a config file uses its own subdirectory, never the shared root. Reason:
  board #216 (2026-09-20) — the live `kiro_engine = "v3"` turned three
  v2-default assertions red on every branch, and earlier the spawn tests
  had pointed the whole process at the real `state.db`.
- A Rust test's tmux sessions and scratch paths are named for its process,
  because every cargo run on the host shares one tmux server and one temp
  dir: a fixed name let a second run kill, reuse or delete the first run's
  session or directory mid-test, and a leaked `tmm-test-share-a` was
  auto-adopted by the live server as a project. Two mechanisms, by lifetime:
  - One test's session or directory: `tmux::Scratch::new(tag)` in the lib
    (sessions `tmm-test-<tag>-<pid>-<part>`, directory
    `<temp>/tmm-test-<tag>-<pid>`), `TestSession` in `main.rs`
    (`_tmux_mobile_test_<pid>_<test>`). The guard is taken before anything
    exists and kills and removes on drop, also on panic (the #251 rule).
  - A directory held for the whole process (the test store, the config
    dir, the kimi/codex homes, the integration crate's config dir, the symlink
    fixtures):
    `config::fresh_process_dir(prefix)`. It has no drop, so it is reclaimed
    at the door: each run first removes every `<prefix>-<pid>` whose
    process is gone, then creates its own.
  Reason: board #265 (t06 flaked during #264) and #268 (the lib tests #265
  missed; validator 15:30, the per-process store dir grew by one per run).
  A passing full `npm run test:rust` leaves nothing in the temp dir but one
  `fresh_process_dir` per prefix (board #269, measured by diffing `/tmp`
  across a run: `tmm-gp-*` and `tmm-spawn-codex-*` had grown by one per run,
  ~130 each, and the symlink fixtures used fixed names).

## Current source-contract inventory

| File | Pins |
|------|------|
| `src/App.source.test.ts` | notification refresh on every connect path; terminal nav/page-layer structure |
| `projects/Projects.source.test.ts` | Terminal Projects consumes the same conversation-first update clock/formatter as Chat |
| `sessions/Sessions.source.test.ts` | notification-state import wiring |
| `sessions/PanePicker.source.test.ts` | Team-dot suppression in the picker; it is a fixed popover placed from its opener with the shared dismissal set |
| `terminal/Terminal.source.test.ts` | Terminal chrome uses only Team-filtered queries |
| `team/Team.source.test.ts` | roster chip wrap/overflow CSS contract; the composer's Enter rule; the team switcher is the shared ContextMenu and names teams by project |
| `team/TeamTemplates.source.test.ts` | the phone's template picker is `ui/Select`, never a hand-rolled panel |
| `ui/tokens.source.test.ts` | one type scale: no raw px font-size outside the listed exceptions |
| `ui/confirm.source.test.ts` | every destructive verb goes through the shared confirmation |
| `hub/Hub.source.test.ts` | room/paging/send coordination, the narrow component boundaries and capture-listener order |
| `hub/Feed.source.test.ts` | a tool-lane row is one line (`nowrap`, never `pre`), the argument is never truncated (the lane pans instead), the row cap stays expressed in rows, and reading geometry stays in the one Feed |
| `ui/sidebar.source.test.ts` | one sidebar box: a section header takes its padding and type from `.side-h`, and `.side-h`/`.side-row` keep the same 10px inset |
| `ui/statusdot.source.test.ts` | the running cue: `--status-sleep` stays achromatic, `.live-dot` is defined once in app.css (halo + `dot-breathe` scale, never an opacity fade) and stills under reduced motion, and no component re-implements it |
| `app/preferences.source.test.ts` | Settings embeds the real AgentsPage (never a copy), the category exists only where Agents is not a page, back peels the embedded page first, one head at a time |
| `files/Files.source.test.ts` | back retraces the user's steps; drag-drop uploads into the current directory; markdown preview goes through the ONE safe renderer (never a bare `marked.parse`); heavy preview libraries load on first use; the lined preview is capped |
| `files/DirPicker.source.test.ts` | ONE directory picker under `src/lib` (rule 6); the newest listing wins; it can create the folder it picks |
| `hub/Board.source.test.ts` | the issue detail is a draft (explicit save, guarded exits), assignment is one dispatch, the layout hierarchy, sidebar order, notes as a timeline, columns scroll alone |
| `system/system.source.test.ts` | the vitals corner takes its transport by injection, polls low-frequency and stops while hidden, fails soft, wears tokens |
| `ui/totail.source.test.ts` | the to-tail atoms live in app.css once; both records wear the shared class |
| `ui/motion.source.test.ts` | the micro-motion vocabulary (motion.md): `.chev`/`.flip`, the three intro keyframes and `.state-ctl` live once in app.css on the two tempo tokens and still under reduced motion; `ui/motion.ts` mirrors the tokens; no component redefines an atom, imports `svelte/transition`, uses `animate:flip` without `moveMs()`, or runs an `infinite` loop without a reduced-motion rule |
| `ui/indicator.test.ts`, `ui/hover.test.ts` | the sliding indicator's box→variables mapping and the hover card's dwell/hop timing (pure halves of `ui/indicator.ts` / `ui/hover.ts`) |
| `ui/popover.source.test.ts` | every fixed popover (Select, ContextMenu, PanePicker) dismisses on an outside ancestor scroll but never on its own list scrolling |
