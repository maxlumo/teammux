# Testing Conventions

Frontend tests and repository development-script tests run with `npm test`
(`node --test`, no framework, no tmux needed). Rust tests: `npm run test:rust`
(`cargo test -- --test-threads=1`, needs a running tmux). Multi-server work has a
third environment, Docker, with its own smoke `npm run test:e2e:docker`
(below). This file governs the frontend side, the one Rust rule below, and
that environment.

A change to Rust the phone compiles (the `backends/` leaf, anything not behind
`cfg(not(any(target_os = "android", target_os = "ios")))`) also runs the
Android compile check, `cargo check … --lib` for `aarch64-linux-android`. Always
with `--lib`: `build:android` builds only the lib, and the bins do not compile
for Android. The command and the reason are in
[android-platform.md](../design-docs/features/android-platform.md#the-android-compile-check-is-the-lib-never-the-bins-board-378).

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
  runs cargo with `TMUX`, `TMUX_PANE`, every `TMM_*` and `TOKEN` unset and
  `TMUX_TMPDIR` set to a fresh `mkdtemp` directory, with `--test-threads=1` FIRST in libtest's option region
  (right after the cargo/harness `--`, before any second `--` the caller
  passes — libtest stops reading options there and treats the rest as test
  filters, measured 2026-10-12) and any `--test-threads` the caller wrote in
  that region dropped, so there is exactly one and it is ours; afterwards it
  kills — each by its own `-S` path — any
  server a test left under that directory, then removes it. The "default"
  server a test could reach is an empty throwaway that did not exist before
  the run. The real server's socket is simply not where the process will look.
  `TMM_*` and `TOKEN` go one layer up (board #407, 2026-10-16): a runner
  whose environment carried `TMM_SERVER=ws://127.0.0.1:9899` (measured on
  tasks run before 17:38 that day; an agent pane carries `TMM_PROJECT`,
  `TMM_AGENT` and `TMM_MCP_CONFIG`, not `TMM_SERVER`) made
  `a_task_runs_with_its_starters_identity` read that real gateway as the
  server of a task whose starter had none; `TOKEN` is the
  credential `Config::load` reads before `config.toml`. This removes the
  caller's inherited routing, identity and credential, nothing more: it is
  not a network sandbox, and `HOME`, `XDG_CONFIG_HOME`, `HOST`/`PORT` and
  `config.toml` still resolve, so a test that talks to a gateway sets its own
  endpoint, token and config dir on its child process.
  Any other cargo test invocation on this host goes through the wrapper,
  which takes cargo's own arguments: `npm run test:rust -- <filter|--lib|-p …>
  [-- <harness args>]`. When cargo must be run by hand, the equivalent is
  `env -u TMUX -u TMUX_PANE -u TOKEN $(env | sed -n 's/^\(TMM_[A-Za-z0-9_]*\)=.*/-u \1/p')
  TMUX_TMPDIR=$(mktemp -d /tmp/tmm-iso-XXXX) cargo test … -- --test-threads=1`
  (every `TMM_*` the shell has, not a list; checked in bash and zsh). The split of guarantees: the wrapper guarantees
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
  binary's argv for `--test-threads=1` / `--test-threads 1` (last one wins,
  and only up to the first bare `--`: libtest stops reading options there, so a
  `=1` in the filter zone is a filter, not a promise), else
  `RUST_TEST_THREADS=1`, else libtest's default of the machine's
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

## A hand-built rig names its tmux server on every destructive command (board #406)

Incident #3, 2026-10-16 17:38:32: every tmux session on the host died again.
The cargo path above was not involved. The cause was a validator's
hand-written shell rig (a throwaway gateway with its own HOME and tmux for
#404), whose `init.sh` ran, in this order:

```sh
source env.sh        # exports TMUX_TMPDIR=/tmp/val404r5/tmuxdir, which does not exist yet
tmux kill-server     # bare, no -S
mkdir -p $M/tmuxdir  # the directory is created only here
```

Measured on tmux 3.6a (this host), with `TMUX` unset: when `TMUX_TMPDIR`
names a directory that does not exist, tmux does NOT fail. It falls back to
the real default server: `tmux ls` lists the owner's sessions and exits 0,
and `display -p '#{socket_path}'` prints `/tmp/tmux-<uid>/default`. When the
directory exists but holds no server, `tmux ls` fails with
`error connecting to <dir>/tmux-<uid>/default` and exits 1. So `TMUX_TMPDIR`
isolates nothing until its directory exists, and the bare kill went to the
owner's server. `scripts/test-rust.mjs` is safe because it `mkdtemp`s the
directory before anything runs. An ad-hoc rig has no wrapper and no Rust
gate, so these rules apply to every tmux command outside cargo, in scripts
too:

- **A destructive tmux command names its server.** `kill-server`,
  `kill-session` and any sweep run as `tmux -S <absolute private socket> …`.
  A bare `tmux kill-server` is forbidden everywhere. A rig defines its socket
  once (for example `TSOCK=$M/tmuxdir/tmux-$(id -u)/default`), refuses to
  continue if `TSOCK` is not under the rig's own directory, and sends every
  tmux call through it.
- **Create `TMUX_TMPDIR` before exporting it.** Run `mkdir -p` on the
  directory in the same line that exports the variable, before any tmux
  command, and stop if the `mkdir` fails. A teardown works in this order:
  stop the rig's server through its socket and confirm it is gone, and only
  then remove the socket and the other files. Keep the directory itself while
  a later step can still run tmux. A kill that was only attempted, or a
  socket path that disappeared, does not mean the server is gone; deleting
  the socket of a live server leaves it running and unreachable.
- **A teardown kills what the rig owns, by its own identity.** Kill the tmux
  server by its socket path, and the rig's other processes by pid after
  checking that the process environment carries the rig's `HOME`. Never kill
  whatever tmux resolves on its own. A leftover server whose socket file was
  unlinked cannot be reached with `-S`. Kill it by pid only after `ss -xlpn`
  shows that the pid listens on the rig's socket path.

The 17:37 teardown of the previous rig, whose directory existed, was scoped
correctly. Cleanup after the incident (2026-10-16) killed the leftover rig
servers this way: three by `-S`, and four `tmm-test-own-a-*` servers from
10-12 by pid, since their socket files were already gone.

## A rig owns its whole environment, not just HOME (board #425)

Incident, 2026-10-19 03:17: a validator's browser rig started a release
gateway with `HOME=/tmp/val424rig/home` and a private `TMUX_SOCKET`, but the
shell exported `XDG_CONFIG_HOME=/home/cfu/.config`, and the config directory is
`$XDG_CONFIG_HOME/tmux-mobile` first, `$HOME/.config/tmux-mobile` only without
it (`config::dirs_next`). The "isolated" gateway ran on the REAL config: it
consumed and dropped eleven real hook notifications from the real inbox,
rewrote the real notify helper and could have written to the real `state.db`.
(Checked afterwards: the real `state.db` has no `restore_checkpoint*` key and no
row naming the rig's socket; the live build predates the checkpoint code, so
nothing inert was written either. The eleven envelopes were deleted and are not
recoverable; the product half, [agent-notifications.md](../design-docs/features/agent-notifications.md),
now keeps an envelope instead of dropping it when tmux cannot be reached.) The
same rig recipe was used for #420.

The rule, next to #406's: **a rig that starts a gateway, `tmm` or anything that
reads the config sets, to its own directory, every variable that decides where
that thing looks**, and proves it before the first start:
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` (setting only
  `HOME` does nothing while `XDG_CONFIG_HOME` is exported);
- `TMUX_TMPDIR` (created first, see above) and `TMUX_SOCKET` (which a gateway's
  config prefers to `TMUX_TMPDIR`, so an exported path to the real server would be
  followed whatever the directory is);
- every `TMM_*` and `TOKEN` (unset, or set to the rig's own).
- **Assert the resolved config dir before starting.** Print it from the
  binary or compute it the way `config::dirs_next` does, and stop unless it is
  under the rig's directory: `case "$cfg" in "$RIG"/*) ;; *) echo "config dir
  outside the rig: $cfg"; exit 1;; esac`. A rig that cannot show its config dir
  is not isolated.
- A rig started from an agent's shell inherits that shell's variables; start it
  with `env -i` plus an explicit list, not with a few overrides on top of the
  inheritance.
`scripts/test-rust.mjs` is the one helper the repository itself ships for a
test process, so the rule is baked in there once: `TMUX_TMPDIR` and the three
XDG roots are subdirectories of its throwaway dir, and `TMUX`, `TMUX_PANE`,
`TMUX_SOCKET`, every `TMM_*` and `TOKEN` are removed (pinned by
`scripts/test-rust.test.ts`, the poison values never connected to); `HOME` is left
alone because the Rust toolchain lives under it. It is not a network sandbox:
`HOST`, `PORT`, `TLS_*` and `config.toml` still resolve, so a test that starts a
gateway sets its own endpoint. An ad-hoc rig has no wrapper, so the list above is its checklist.

The same ownership rule covers PROCESSES: a test that starts a process tree (a fake
`tmux` the helper probes, a hung child) starts it in a process group of its own
(`process_group(0)`), has the fake write its own pid first, and cleans up and checks
through that group and that pid. It never runs `pkill -f` or `pgrep -f` on a command
line: a pattern is shared by every parallel run and by other agents' tasks on this host,
and a control that breaks the product on purpose would reach the wrong process. Signal
the group while its leader is not yet reaped; signal 0 still finds a zombie, so "gone"
means reaped.

## Multi-server work ends in the Docker environment (board #352)

Owner, 2026-10-12: "像你测试整体效果的时候，比如模拟多个连接，可以用 docker 做环境隔离来最终测试".
The multi-server feature (#335 ③, several gateways in one app) was verified
against ONE real gateway plus fakes, and its two-member browser check against
scratch gateways built on this host — their own ports and config dirs, but the
host's kernel, users, `/tmp` and the owner's tmux server. Every incident above
came from test infrastructure sharing the host with the owner's sessions.

Every change that touches more than one server is verified in this
environment, and in two parts: `npm run test:e2e:docker`
(`scripts/e2e-docker.mjs`) is the ENVIRONMENT SMOKE — it proves the machines
are real, distinct and isolated, nothing more — and the validator's browser
pass against the kept machines is the functional verdict (the ③ matrix:
reviewer M1 + validator E1–E3). Running the smoke alone does not pass a
multi-server change; the stand-in `kiro-cli` produces no real hook or turn
edge, so "managed, running" is a fixture check, not an agent-workflow check.
The smoke brings up
`docker/validator/compose.yaml`: three containers (`gw-a`, `gw-b`, `gw-c`),
each a real `tmm gateway` with its own tmux server, config root (a token
generated in the container, its own `machine_id`, `state.db`), a managed
project `demo` with one MANAGED agent `kiro` (isolated home, launch recipe;
the `kiro-cli` inside is a stand-in that echoes, so no hook fires and nothing
calls a service), and its own address on the compose network. The agent is
made by `tmm spawn`, not `project create --with-agent`: measured in `gw-a`
on 2026-10-12, `--with-agent kiro` seeds a plain shell slot (`tmm agent list`
shows `kiro (shell)`, `managed: false`, no `/work/.tmm/agents/` home), which
is not what the multi-server pass reads. The image builds
THIS checkout's web UI, `tmm` and `server` inside the container (`embed-ui`);
no host binary, host path or host socket is ever mounted, and the script runs
no tmux, no systemctl and not the host's `tmm`. The smoke then logs in from the
host through each published `127.0.0.1` port, which answers with that
machine's id; checks `demo` is up, `/` serves the web UI and the agent is
managed and running; checks the three ids and tokens differ and each id is the
one in that container's file; runs one probe command twice inside `gw-a` —
`tmm --server … project list` against its OWN gateway, which must list (the
probe works), and against the host (the network's gateway address, read from
docker, never from the owner's config), which must end with tmm's own "server
not reachable" (exit 2) or "auth rejected" (exit 3) and nothing else: a probe
that did not run (spawn error, signal, `timeout`'s 124, exec codes) is a
failed run, not evidence (the issue's negative control: a test that depends
on the host gateway must fail inside the network); restarts
`gw-b` and requires the same identity, project and agent back — the mechanism
the browser matrix will use for "server dies" and "reconnect reaches another
machine". Teardown is part of the verdict: `down -v --remove-orphans` runs
before `up` (fresh machines — a kept environment from an earlier `--keep` has
stopped agents and written rooms), after a pass and after a failure; a `down`
that fails fails the run, PASS is printed only once the machines are gone,
and SIGINT/SIGTERM run the down themselves (JS `finally` does not run on a
signal). Every compose call carries `-p tmm-e2e`, which outranks a
`COMPOSE_PROJECT_NAME` in the caller's shell, so the down can never be aimed
at another local project; one fixed name also means one environment per
host — two checkouts running it at once would tear each other down. So a
kept environment is EXCLUSIVE: while someone holds one (`--keep`), nobody
else on the host runs `npm run test:e2e:docker` or a compose `down` on
`tmm-e2e` — say so in the room before starting, and ask before ending one
you did not start (incident 2026-10-12 16:19: the validator's kept
environment on the review tip was torn down by the builder's own P2 check,
and the live run had to begin again). A
container's health is "ready", not "listening": the entrypoint drops a marker
at start and writes it after the project and agent are in place, and the
health check needs the marker, so `compose --wait` returns usable machines on
a slow cold start or restart. `--keep` leaves the machines up and prints
each `ws://` address and token for a browser session by hand. The image is
built from the CHECKOUT THAT RUNS THE SCRIPT — the build context is the repo
root the script resolves from its own path — so the UI the containers serve
is that checkout's: to verify a branch's UI in the browser (the ③ pass needs
the Aggregate UI), run `npm run test:e2e:docker -- --keep` FROM that branch's
worktree, not from main. The first run compiles
tmm + server in release inside the image (minutes; the cargo registry and
target are BuildKit cache mounts, so later builds are incremental); a warm
run is ≈ 45 s. Measured on Docker 25.0.14 / Compose v5.5.0, host
tmux session count unchanged across every run.

**The image knows what it was built from (board #368).** `.dockerignore` keeps
`.git` out of the context, on purpose, so inside the image there is no git and
both the UI (vite) and the gateway (build.rs) would call themselves `dev` — and
the stale-UI tell on Settings › About (UI commit ≠ server commit) could never
show. The script hands the image the checkout's PUBLIC source revision as build
args instead: `SOURCE_COMMIT` (`git rev-parse --short=8 HEAD`) and
`SOURCE_TIME` (the UTC minute), which vite and build.rs read FIRST, then git,
then `dev`. A hash and a minute; no path, remote or credential, and no context
widening. A value already in your environment wins, but it only LABELS what the
image says it is: the image is still built from the files of the checkout the
script runs in, so `SOURCE_COMMIT=<A>` does not give you commit A's code. To
produce the MISMATCH on the kept machines, run the script from a checkout AT
commit A (gateways at A; its git supplies the label), then serve a `vite build`
of a checkout at B against one of them and open Settings › About: the server
line turns amber and names A. A `vite` dev server never shows a commit (it is
not a build). The two sides compare by commit PREFIX (`git --short=8` is at
least 8 characters), which is a best-effort tell, not proof that two builds are
the same source: equal prefixes of different commits are possible in principle.

One limit, written down so it is not mistaken for a guarantee: the compose
network is not `internal` — on Docker 25 published ports do not forward from
an internal network (measured: the host could not connect at all), and a
browser on the host must reach the gateways. A container can therefore route
to the host's bridge address; the host gateway stays out of reach because it
binds `127.0.0.1` (as on this host) and because no container holds its token.
The smoke asserts the outcome, not the route.

The browser matrix itself (alias/canonical absorb, address redial, block and
Retry, orphan ask — reviewer M1 + validator E1–E3) is the follow-up on #352;
until it lands, the validator uses `--keep` and runs those cells by hand.

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
- A fixture may REPLACE a heavy package with a stand-in of its own, named by
  exact specifier (`compileMount(..., { standIns })`). The real package is
  still never bundled, and the stand-in paints nothing: it records calls.
  `Terminal.isolation.mount.test.ts` (#335 ③a) is the one user — two real
  runtimes, a real Terminal bound to each, and `test/xterm-stand-in.ts`
  recording which terminal each frame reached.

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
- A test that proves "B waited for A's critical section" observes B INSIDE
  that section — from the test hook that holds it, after the pause that gives
  B time to get in — and asserts the observation after the call. It never
  asserts "B has not finished" once A's call has returned: the return is what
  releases B, so the assertion races B's wake-up and passes only when the
  asserting thread happens to run first. Reason: board #386 —
  `a_command_recorded_during_an_end_is_not_retired_by_it` failed once in a
  full gate and 36 of 640 runs (two loops of 8 parallel runners under ~2x CPU
  oversubscription), always at that late assertion; its sibling
  `an_end_racing_an_echo_waits_and_keeps_the_next_command` has the same shape
  and flakes too, less often: 0 of 320 runs in the first investigation, 2 of
  640 in the validator's own loop on the old code. The same fix covers it.
  Looping the one test under load can reproduce a suspected race and show a
  fix holds; #386 did it with 8 parallel runners and 96 busy-loop processes on
  a 48-core host (~2x oversubscription), before and after. That is the
  configuration of one investigation, not a default every race inquiry must
  fill a shared host with: keep it bounded in time, off the tmux server and
  state of the live system (the isolation rules above), and clean up the
  burners. A negative control that fails in such a run shows the test bites in
  that run, not under every load.
- A wait observes the SAME fact the next assertion reads. A fake that writes
  a file whose content is asserted writes it under another name and renames
  it into place, so a wait for its existence or count is a wait for its
  content. Reason: board #421, `a_nul_or_a_bang_in_a_typed_line_never_runs_as_shell_code`
  failed twice under load (at load ~246, and at ~210-240 in the #422 gate):
  `tasks() == 2` was observed, then `task(2)` read an empty file the dsh
  stand-in had created and not yet written.
  A fixed sleep is the same mistake with a clock: board #429,
  `two_empty_turns_before_a_nudge_send_exactly_one_for_the_latest` asserted a
  1 s stall timer's nudge after `sleep(3500 ms)` and read an empty log at load
  29. It now waits for the nudge (30 s bound) and then gives a second one a
  grace; a wait for something that must NOT happen can only miss, never flake.
  How a writer's bytes fall into a reader's `read()` calls is scheduling,
  not behaviour: the tmux key probes (`main.rs` t08/t09) assert on their
  reads concatenated into one byte stream (`probe_reads`), waited for; even
  the ESC + C0 bytes of a Ctrl+Alt key are two adjacent bytes of that stream,
  never one read (a read boundary is not a key boundary, review P1). Reason:
  board #430 — t08 asserted a read `'ab'` and failed at load ~30 when `ab`
  and `\x03` arrived as one.
- A test that feeds a child's stdin writes only what that child reads. Where
  the child rightly exits before reading (the hook helper with no pane, or an
  inbox `mktemp` cannot write into), the test lets it exit, tolerates the
  broken pipe of a late write, and asserts the exit code alone. Reason: board
  #428 — `the_helpers_exit_is_a_receipt_only_for_a_numbered_producer` wrote
  unconditionally and got EPIPE in 1 of 20 runs writing at once and 20 of 20
  after a 0.2 s delay (validator, #425 gate).
- A rig cleans up only what has stopped writing, and forgets what it put in
  the shared store. `kill-session` returns before the pane's processes have
  exited, and a dying shell still writes its state files, so `DshRig`'s drop
  removes the workspace only once the pane's process session — the pane pid
  taken at start, verified as its session's leader — is OBSERVED gone
  (`pgrep -s` exits 1; SIGKILL to that session only, after 5 s). A failed
  observation (`pgrep` missing or exiting 2, no pane pid at start) or a
  session still alive after the SIGKILL is not gone: the drop keeps the
  workspace and prints one `DshRig cleanup incomplete: …` line (review P1-B).
  It deletes the project row it adopted into the per-process test store in
  every case. Reason: board #421 — at load ~105-246 the old drop
  left `/tmp/tmm-dsh-e2e-…/.tmm/agents/d1/` half-removed (`ready`, `seq`,
  `.zsh_history` rewritten by the dying shell, no `launch.json`) with its row
  still in the store, and four `live_config` tests plus a `hub_rpc` test that
  walk every project failed on "d1 (not confirmed) … it has no launch
  recipe". `a_dropped_rig_leaves_no_workspace_and_no_project_row` pins the
  clean path, `a_rig_drop_settles_only_on_an_observed_gone` and
  `a_rig_drop_keeps_its_workspace_unless_its_processes_are_gone` the rest,
  and `a_pgrep_that_cannot_answer_is_unknown` the `pgrep` mapping itself (a
  missing program and one exiting 2, run for real: an injected observer pins
  nothing about the mapping, validator C6/C7).
  The settle fixture runs its budget on a simulated clock (`RigClock`) with
  observations that each take 120 ms of real time: on the wall clock, a
  writer that ends inside the 150 ms budget was killed whenever the host
  scheduled the test late (review P2).
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
| `ui/InstallPrompt.source.test.ts` | the PWA install banner fits the window (viewport width, content wraps) and the space it takes is measured at runtime and published as `--install-reserve`, never a literal; the connect page scroller ends above it |
| `app/Settings.source.test.ts` | the connect page is its own vertical scroller (`min-height: 0` + `overflow-y: auto`, no sideways scroll) and the card centres with auto margins, never `align-items: center` |
| `app/preferences.source.test.ts` | Settings embeds the real AgentsPage (never a copy), the category exists only where Agents is not a page, back peels the embedded page first, one head at a time |
| `files/Files.source.test.ts` | back retraces the user's steps; drag-drop uploads into the current directory; markdown preview goes through the ONE safe renderer (never a bare `marked.parse`); heavy preview libraries load on first use; the lined preview is capped |
| `files/DirPicker.source.test.ts` | ONE directory picker under `src/lib` (rule 6); the newest listing wins; it can create the folder it picks |
| `hub/Board.source.test.ts` | the issue detail is a draft (explicit save, guarded exits), assignment is one dispatch, the layout hierarchy, sidebar order, notes as a timeline, columns scroll alone |
| `system/system.source.test.ts` | the vitals corner takes its transport by injection, polls low-frequency and stops while hidden, fails soft, wears tokens |
| `ui/totail.source.test.ts` | the to-tail atoms live in app.css once; both records wear the shared class |
| `ui/motion.source.test.ts` | the micro-motion vocabulary (motion.md): `.chev`/`.flip`, the three intro keyframes and `.state-ctl` live once in app.css on the two tempo tokens and still under reduced motion; `ui/motion.ts` mirrors the tokens; no component redefines an atom, imports `svelte/transition`, uses `animate:flip` without `moveMs()`, or runs an `infinite` loop without a reduced-motion rule |
| `ui/indicator.test.ts`, `ui/hover.test.ts` | the sliding indicator's box→variables mapping and the hover card's dwell/hop timing (pure halves of `ui/indicator.ts` / `ui/hover.ts`) |
| `ui/popover.source.test.ts` | every fixed popover (Select, ContextMenu, PanePicker) dismisses on an outside ancestor scroll but never on its own list scrolling |
