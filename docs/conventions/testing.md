# Testing Conventions

Frontend tests and repository development-script tests run with `pnpm test`
(`node --test`, no framework, no tmux needed). Rust tests: `pnpm run test:rust`
(`cargo test -- --test-threads=1`, needs a running tmux). Multi-server work has a
third environment, Docker, with its own smoke `pnpm run test:e2e:docker`
(below). This file governs the frontend side, the one Rust rule below, and
that environment.

Every change under `src-tauri/` also runs the Android compile check,
`pnpm run check:android` (`cargo check --lib` for `aarch64-linux-android` with
the NDK `build:android` uses; no emulator), and it must report zero errors. A
builder runs it before handing over, and a validator runs it on every such
change (board #32: main stopped compiling for Android after three desktop-green
merges in one day). Always the lib: `build:android` builds only the lib, and
the bins do not compile for Android. The command and the reason are in
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

- **A full `pnpm run test:rust` runs EVERY test target** (board #11): the
  wrapper always passes `--no-fail-fast` (a caller's own is not repeated;
  `--lib`, `-p` and filters still narrow). Without it cargo stops at the
  first failing test binary, and on this host the lib always has its known
  host failures, so the `tmm` bin, `main.rs` and all 21 integration targets
  never ran: every "full run" cited on #2 to #7 covered the lib only (#8,
  validator, 2026-11-05). #8 measured the cost of running them: about 45 s
  for all non-lib targets together, against about 330 s for the lib. The
  exit status is still non-zero when any test in any target fails.
- **`pnpm run test:rust` isolates the test process from every real tmux.** It
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
  which takes cargo's own arguments: `pnpm run test:rust -- <filter|--lib|-p …>
  [-- <harness args>]`. When cargo must be run by hand, the equivalent is
  `env -u TMUX -u TMUX_PANE -u TOKEN $(env | sed -n 's/^\(TMM_[A-Za-z0-9_]*\)=.*/-u \1/p')
  TMUX_TMPDIR=$(mktemp -d /tmp/tmm-iso-XXXX) cargo test --no-fail-fast … -- --test-threads=1`
  (every `TMM_*` the shell has, not a list; checked in bash and zsh). The split of guarantees: the wrapper guarantees
  the directory is FRESH; the Rust gate guarantees only that the process is
  NOT looking at the real tmux (`$TMUX`/`$TMUX_PANE` unset, some
  `TMUX_TMPDIR` set) — it cannot tell a fresh dir from a reused one, and the
  private servers' own sockets live under `std::env::temp_dir()`, not under
  `TMUX_TMPDIR`. The cleanup claim is for the wrapper's normal and error exit
  (its `finally`); a wrapper killed with SIGKILL leaves the dir, which the
  next run does not reuse.
- **The wrapper runs cargo under a umask with no group/other write bits**
  (`caller | 022`, restored afterwards; 2026-11-03). The store refuses a
  `state.db` whose directory or any ancestor another user can write
  (`safe_fs::trusted`), which is right for production; but the suite makes its
  directories with the process umask, and on an Ubuntu host with the
  user-private-group umask `002` every one was `775`: 449 of 1252 tests
  failed in one run, 414 of them with `Permission denied: … other users can
  write to it`. A hand-run cargo needs `umask 022` in front too.

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

So `pnpm run test:rust` is the command, and the only one: a bare `cargo test`
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

## A rig cannot reach the live gateway, by network or by socket (board #440)

Incident, 2026-10-20 14:52:36 to 14:53:37: a validator's #438 rig ran `tmm gateway install` with a rig HOME but no rig config.toml. Its preflight probed the DEFAULT port 9899 (the live gateway) with the rig's token. Five failures tripped the per-IP auth lockout (MAX_AUTH_FAILURES 5, AUTH_LOCKOUT_SECS 60) for 127.0.0.1, which is every agent's tmm on this host, so for a minute every `tmm` call was refused. No hook envelope was lost, because the hook helper only writes the inbox and opens no socket (`the_hook_helper_never_opens_a_network_connection`). The product half is websocket-server.md § Two transports: this host's own tmm now reaches its gateway over a 0600 socket that has no lockout.

The rule, on top of #406 and #425: **a rig that starts a gateway or runs `tmm` cannot reach the live one, by any path.**
- **Its own config.toml.** Under its own `XDG_CONFIG_HOME`, written before the first command: `port`, `host = "127.0.0.1"`, `token` and an ABSOLUTE `tmux_socket`. Env overrides alone are not enough, because `--service` and `install` read the file. A relative `tmux_socket` becomes `tmux -S <name>` in the gateway's cwd: a #439 rig left `tmux -S rig439` running in /tmp/builder439 that way.
- **`env -i`** with only `HOME`, `PATH`, the rig's `XDG_*` and the rig's own values. No inherited `XDG_CONFIG_HOME`, `TMM_SERVER`, `TMM_SOCKET` or `TMM_TOKEN` can point back at the owner's.
- **A network namespace** whenever a step could dial a default port: `install`, `status`, a probe, or a `tmm` with no `--server`. Use `unshare -rn sh -c 'ip link set lo up; …'`. Checked on this host: inside `unshare -rn`, a dial to 127.0.0.1:9899 fails with "Network is unreachable".
- **The netns does not isolate the socket.** A filesystem socket is reached by its path, not over the network. What keeps a rig's tmm off the owner's `<config>/sock/gateway.sock` is the rig's own `XDG_CONFIG_HOME` (its derived socket path is then its own) and `env -i` (no inherited `TMM_SOCKET`). "9899 is unreachable in the netns" is never counted as proof that the rig cannot reach the live gateway.

## A full suite runs where the live gateway does not exist (board #503)

Incident, 2026-11-02: every full gate of the day left 3 loopback `Auth failed … invalid proof` lines on this host's LIVE gateway (bursts at 07:11 to 13:17, read from its journal). A test in our own suites reached the real service, and two such runs within a minute spend 6 of the 5-attempt lockout on 127.0.0.1. Two interim recipes failed on the way, measured by kiro:
- `unshare --map-current-user -n` (and `unshare -rn` for a whole suite): a user namespace cannot show real root, so `/`, `/tmp` and `/local` stat as uid 65534 and `safe_fs::trusted` refuses every state.db; with `--map-current-user`, `ip link set lo up` is also not permitted. The trust check is never relaxed for tests.
- `docker run --network none` with the real HOME mounted: no TCP, but the live socket, config, token, state.db and agent homes are all reachable by path (reviewer, 13:29).

The rule: **on this Linux host, a full `pnpm test` or `pnpm run test:rust` runs through `node scripts/isolated.mjs -- <command>`, started from a LINKED worktree** (orchestrator, 2026-11-02: required on any host that runs a live gateway, after #503 lands too, because only a physical boundary stops the next regression; it is not wired into `pnpm test` itself, which would change every developer's loop). It is Linux-only: it mounts this host's `/usr`, `/lib` and toolchain into a container from an empty image. It is not verified on macOS or any other platform. Elsewhere the protection is only that the tests themselves keep off the default port, which #503 fixes and guards. Before any docker call it refuses:
- the main or launch checkout (its git dir is the repository's own);
- a target that is HOME or holds it, or holds the main checkout;
- a worktree with `.tmm/`;
- an inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` or `GIT_INDEX_FILE`.

The container has:
- `--network none`;
- the host's system dirs and toolchain mounted READ-ONLY, so real root ownership is what the trust check sees;
- only the worktree, its own git dir and a private `/tmp` writable;
- HOME, XDG_*, CARGO_HOME and TMPDIR inside that `/tmp`, and an empty environment, so no `TMM_*`, `TOKEN` or `TMUX*` crosses.
- node, resolved from the RUNNING node (`realpathSync(process.execPath)`, `nodeRuntime`), never a guessed path, and it is the node everything inside runs: the tripwire, and `pnpm`'s scripts and `env node` through PATH. Under `/usr`, `/lib`, `/lib64`, `/bin` or `/sbin` it is already visible at its own path. When it is also the node the container's PATH (`/usr/local/bin`, `/usr/bin`, `/bin`) picks, nothing is added; when it is not (reviewer, #9 round 2: `/usr/local/node-v26/bin/node` is visible but off PATH, or PATH finds another node first), it is linked first on PATH, with no mount. A `/usr/bin/node` that is a symlink OUT of `/usr` resolves to its real file, which is then mounted like any other; before #9 that link was broken inside. The tripwire quotes the node path, so an install path with a space is one shell word. Elsewhere an ALLOWLIST is mounted read-only under the neutral `/opt/node`: the node binary itself. Never the install prefix: a prefix inside `~/.ssh`, `~/.aws`, the config dir, `.tmm` or `~/.local/share` would expose that dir (validator-2, #9 round 1), and a denylist misses the next sensitive dir. Never the real path either: under HOME that is `~/.local`, which the self-check refuses to see (validator, #8). PATH gains a private `/tmp/node-bin` holding the links. A node path holding `:` or `,` (docker's `-v` cannot carry it) or a node that is not a regular file refuses before any docker call, naming the path and the fix.
- pnpm (board #33; npm and npx are no longer linked), the one the host's PATH finds, by its real path. Under a system dir it is linked at its own path. Elsewhere exactly its binary and the `dist/` beside it are mounted read-only under `/opt/pnpm`, never the directory holding them: here that is `~/.local/share/pnpm-app/{pnpm,dist}`, measured with pnpm 12.16.1, a native binary. It is linked in `/tmp/node-bin`. The same `:`/`,` and regular-file refusals apply. With no pnpm on the host, nothing is linked.

**The runner could not start on this host while its node lived outside `/usr`** (board #9, found by validator on #8, 2026-11-05). The tripwire ran a hardcoded `/usr/bin/node`, and this host's node is `~/.local/share/node/bin/node`, outside every mount: the runner refused in under 3 s ("/usr/bin/node: No such file or directory", "the default-port tripwire could not start", exit 97). The full runs cited on #2 to #7 were run without it. (The image's creation time, 07:36 that day, shows only that it was created then, not that no earlier run happened; reviewer on #8.) The tripwire, the inside-only behaviour rows of `scripts/isolated.test.ts` and the command's own `npm`/`node` now all use the resolved node. Measured after the fix: `node scripts/isolated.mjs -- npm run test:rust -- backends::omp::tests` passed the self-check and ran 3 tests inside (exit 0), and `node scripts/isolated.mjs -- node --test scripts/isolated.test.ts` ran all 30 rows, the 4 tripwire rows included (re-measured in review round 2; npm ran inside with only its own package mounted). Pinned by the #9 rows in `scripts/isolated.test.ts` (the node PATH already picks changes nothing; a visible node PATH would not pick is linked first on PATH with no mount; the tripwire quotes its node; a node inside `.local/share`, `.ssh`, `.aws`, `.config/teammux` or `.tmm/agents/<x>` mounts only its binary and npm's package, never the dir holding a SECRET sibling; a node without npm mounts the binary alone; each refusal names the path and the fix; node comes from the running process and is checked before any docker call).

A self-check runs first and refuses to start the command (exit 97), in this order:
1. the real HOME's contents, the real config dir or its gateway socket are visible, or the main checkout's `.tmm/` (agents, uploads, teams) is;
2. a forbidden variable is set;
3. an ancestor of the worktree shows anything but the way down (plus `.git` in the main checkout), such as another agent's worktree, or cannot be listed. The walk is a quoted `"$dir"/*` with `nullglob dotglob`, so a name with a space or a lone `*` is read as one name. This proves only that the mount list exposes nothing else along the path. It says nothing about what the explicit mounts themselves hold: that is the mount list's job, and its test's. Only a worktree NESTED under its main checkout runs (`worktree/<agent>-<task>`, this repository's layout). A sibling-layout worktree beside the checkout is refused, fail-closed, because the read-only `<checkout>/.git` mount then shows up beside the way down (validator's P2 on d16b9ca0);
4. a step of the private HOME's setup fails;
5. only then, 127.0.0.1:9899 or an outside address answers.

It tests the socket only with `[ -e ]` and never opens it. Every refusal that a test triggers on the host comes before the TCP probes, so no test probes the real 9899.

**An incomplete pnpm install refuses the run** (board #514). Before any docker call, after the target checks, a worktree with a `package.json` must have a finished install. If it doesn't, the runner exits 97 with a fixed reason that names the worktree and the fix: run `pnpm install --frozen-lockfile` alone there, wait for it to exit, then retry. It refuses when:
- a pnpm `install`, `i` or `add` process is running with the worktree as its cwd, read from `/proc`. pnpm 12.16.1 is a native binary and its argv is plain words (measured: `pnpm install --frozen-lockfile`), so the scan matches a `pnpm` word, bare or a path ending in `/pnpm`, followed by the verb. pnpm writes the marker BEFORE it runs the root scripts (`install`, `postinstall`, …; measured with a root `postinstall` held by a sentinel), so a marker alone does not show that pnpm has exited. A shell string such as `sh -c "pnpm install"` is one element and does not match, and the raw cmdline is never printed;
- `node_modules/.modules.yaml` is missing or is not a regular file. It is not proof that pnpm exited successfully;
- that file is older than `pnpm-lock.yaml` and `node_modules/.pnpm/lock.yaml`, pnpm's record of what it installed, differs from the lock's project document. This is a conservative staleness test, not proof that the contents match. The content check exists because `pnpm install --frozen-lockfile` on a lock rewritten with the same content (by `pnpm install --lockfile-only`) answers "Lockfile is up to date" and leaves `.modules.yaml` as it was; without the check, the refusal's own fix never cleared it (measured, pnpm 12.16.1, #33);
- `pnpm-lock.yaml` cannot be stat'ed for any reason other than being absent. An absent lock only skips the staleness test.

Until board #33 (2026-11-05) this rule read npm's marker (`node_modules/.package-lock.json`) and npm 10's two argv shapes (`node …/npm-cli.js ci`, then the one-element title `npm ci`, measured with npm 10.9.9 on 2026-11-04).

This is a start-time preflight, not mutual exclusion for the whole run. An install that starts after the scan, or a process this user cannot read in `/proc`, is not seen. So the rule stands: run `pnpm install --frozen-lockfile` alone, and start the run only after it has exited.

The incident: a test run that started while `npm ci` was still writing gave a partial red run (validator, #511: 2978 tests, 20 fails, `Cannot find package …/jsdom`). The trigger was an install and a run issued as parallel tool calls. The rule is one check for every command. `test:rust` itself loads only node built-ins, so this is a workspace policy with a named fix, not a guess at which command needs `node_modules`.

**The tripwire.** After the self-check, the container holds 127.0.0.1:9899, where a live gateway listens on a real host, with a listener that reads NO peer bytes. On each accept it counts the connection, stamps the time, writes its record and destroys the socket, synchronously and first. So a connection that sends nothing, sends half a request, or arrives at the very end is still counted, and nothing a test sends (a token, a cookie, a signed path) can reach the output. When the command ends, the shell asks the listener to stop, and it drains what is pending and writes a final record marked `ok`.
- Any counted connection fails the run with exit 98, printing only the count and the times.
- A listener that could not start, died, did not stop or ended non-zero, and a record that cannot be read or has no final marker, all fail closed with 97.
- So the next test that dials the default port fails its own gate instead of showing up in the owner's journal.

Measured on 2026-11-02: before the fix, `--test config_root_cli --test config_root_service` tripped with 3 connections. That is the old probe of `gateway status` on a fresh config, which logged in with an empty token, now refused in `gateway::probe`. After the fix, 0. `scripts/isolated.test.ts` pins the mounts, the environment, every refusal and the tripwire's place, using sentinel repositories only. Its tripwire behaviour rows run only inside the runner (`ISOLATED_RUNNER=1`), on a test port:
- a connection held with no data, half a head, and a connection at the very end;
- credential and cookie sentinels that never appear in the output;
- a killed listener;
- an unwritable record. The production journal is only ever READ to check that a run left nothing.

## One run per target directory (board #35)

`pnpm run test:rust` and `pnpm run check:android` take ONE exclusive lock on their cargo target directory (`src-tauri/target`, or `CARGO_TARGET_DIR`), `<target>/.tmm-run.lock`, for the whole run, test binaries included. The second one refuses at once with exit 75, naming the holder (pid, which runner, its command, since when) and the way out: wait for it, or run in another worktree, which has its own target directory. Incident (retro on #25, 2026-11-05): a `check:android` beside an isolated Rust run left 5 tests failing with `current_exe` ENOENT, each passing alone (validator-2). cargo's own build-directory lock covers its BUILDS only; the damage lands while `cargo test` RUNS the binaries, after that lock is released, so this lock covers the whole command.

It is `scripts/target-lock.mjs` (`lockedCommand`): the host's own perl takes a `flock` on the file and runs the command as its child (Node has no flock, and macOS has no `flock` command). The kernel drops the lock when perl exits by any path, kill -9 included, so there is no stale file to clean. The fd is close-on-exec, so a daemon a test leaves behind never holds the directory. The price of that: a kill -9 of the runner's perl ALONE frees the directory while cargo and its tests keep running (validator-2, measured on Linux), so a second run can then start beside them. The guard covers the normal paths, a test that crashes, Ctrl-C and a killed process group (`tmm task stop`'s killpg), which stop perl, cargo and the tests together; it is not a guarantee against a targeted kill of perl. Inside `scripts/isolated.mjs` the lock is on the same bind-mounted file, so it holds across the container boundary; the pid it names is then the container's (measured: `pid 71 (test:rust, child 72)`, and the host's `check:android` refused in 0.15 s). Pinned by `scripts/target-lock.test.ts` (a held lock refuses within 3 s, names the holder, runs nothing; after a kill -9 the same command runs; the exit status passes through) and the #35 rows in `scripts/test-rust.test.ts` and `scripts/preflight.test.ts` (both runners' cargo goes through the lock; a held lock refuses `check:android` before cargo runs).

**It does not stop a `git commit` in the worktree during a run.** build.rs watches `.git/HEAD`, so a commit mid-run rebuilds and replaces the running test binary (six fake failures on #25: five `Os NotFound` and `build_info`'s head test). Verify a frozen review version: commit before the run, or after it ends.

## The known failures on this host (board #12)

Every verification on 2026-11-05 rebuilt a clean-main baseline from scratch, about 6 minutes per Rust run, to tell this host's failures from a regression (#2, #3, #6, #7, both validators). This is that baseline, versioned. Compare a branch's isolated run with it instead.

**Measured** on `49882cd0` (main after #11), 2026-11-05 08:34–08:42 UTC, with the default isolated command: `node scripts/isolated.mjs -- npm run test:rust` from a frozen linked worktree (no extra args: `--no-fail-fast` is the default since #11, so every target runs). Result: all 25 targets ran (self-check passed, tripwire silent, exit 101, about 8 minutes). The lib had 1273 passed and 34 failed, `tests/merge_cli.rs` 2 passed and 3 failed, every other target passed: the 36 fixed rows below plus the flaky `projects::scratch` row, which failed this time. Isolated `npm test` on the same commit: 3723 of 3723 passed, so the frontend has no entry.

**It is not a pass list** (reviewer, #7, 07:33). A listed name that fails for a DIFFERENT reason is a failure: compare the failure message with the one below, not only the name. Nine `merge::tests` rows print only an assertion, never the git refusal (for example `no_hook_runs`: `left: Refused`, `right: Landed`). Their git cause was proven only by a throwaway probe that printed the refusal reason (#12), so a name and message match on those rows does NOT prove the git cause: a different refusal would print the same assertion. Rows marked so are re-proven with the probe whenever their message is the only evidence.

The record above was measured with npm, before board #33. Re-measure with `node scripts/isolated.mjs -- pnpm run test:rust` after a `pnpm install --frozen-lockfile`. The Rust suite loads no `node_modules`, so the switch changes nothing in this record; board #33 measured it again with pnpm on `3c7d1f7e` (2026-11-05, about 7 minutes, exit 101): the lib had 1358 passed and 34 failed, `tests/merge_cli.rs` 3 failed, and the 37 failures are the 36 fixed rows plus the flaky `projects::scratch` row, as in the npm run.

**Re-measure** when a host fact changes (git, openssl, tmux, node, the kernel), or when a commit touches a listed test or the code it exercises, and replace the whole record with the new run.

| test | target | cause (as observed) and the message it prints | flaky |
|---|---|---|---|
| `merge::tests::a_checkout_failure_is_classified_by_read_back` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_clean_squash_lands_from_its_own_reads_and_notes_once` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_crash_between_the_swap_and_its_record_is_read_from_git` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Interrupted` | no |
| `merge::tests::a_dry_run_and_a_refusal_leave_the_index_bytes_alone_with_a_stale_stat_cache` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_file_appearing_at_a_new_path_after_the_swap_is_not_overwritten` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_half_written_record_and_an_unreadable_lock_are_handled` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `called Result::unwrap() on an Err value: Os { code: 2, kind: NotFound, … }` (the record the refused merge never wrote) | no |
| `merge::tests::a_landed_merge_whose_note_record_is_lost_posts_nothing_and_fails` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_multi_commit_branch_needs_a_message_file` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::an_ignored_file_where_the_merge_adds_a_path_is_refused_and_kept` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::an_ignored_file_with_a_quoted_or_non_utf8_name_is_still_found_and_kept` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::an_interruption_after_the_checkout_leaves_the_recorded_phase` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Interrupted` | no |
| `merge::tests::a_note_that_was_refused_or_lost_is_said_and_the_merge_is_not_rerun` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Landed` | no |
| `merge::tests::an_unsettled_outcome_whose_record_is_lost_posts_nothing` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_one_commit_branch_keeps_its_message_and_other_trailers_and_the_coauthor_set_is_replaced` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_path_that_cannot_be_checked_refuses` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_read_back_that_does_not_match_after_the_checkout_is_unconfirmed` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_record_that_cannot_be_saved_after_the_swap_stops_with_the_previous_record` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_record_write_cut_halfway_leaves_the_previous_record` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_run_stopped_after_the_swap_or_the_checkout_is_reported_by_the_next_run` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Interrupted` | no |
| `merge::tests::a_submodule_change_is_refused` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_swap_reported_as_failed_but_done_is_unconfirmed_and_touches_nothing` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_takeover_after_the_swap_stops_before_any_index_or_file_write` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::a_target_moved_after_the_re_read_is_never_overwritten` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `the other writer's commit is still the target: nothing was overwritten` with two different commit ids (they change every run) | no |
| `merge::tests::before_the_swap_another_branch_at_the_same_oid_or_a_moved_target_refuses` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::no_hook_runs` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Landed` | no |
| `merge::tests::refusals_before_landing_change_nothing` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Landed` | no |
| `merge::tests::the_dry_run_changes_no_ref_index_or_file_and_posts_nothing` | lib | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `merge::tests::trailers_come_from_the_branch_in_first_seen_order_and_none_means_none` | lib | host git 2.34.1 (`git merge-tree` needs 2.38), proven only by the #12 probe that printed the refusal reason; the test itself prints `left: Refused`, `right: Landed` | no |
| `merge::tests::whitespace_drift_next_to_a_hunk_refuses_where_stable_patch_id_would_match` | lib | host git 2.34.1, shown by its own message: `git ["merge-tree", "--write-tree", …]: fatal: unknown rev --write-tree`, `left: 128`, `right: 0` | no |
| `a_merge_reads_the_issue_first_and_posts_exactly_the_line_it_prints` | `tests/merge_cli.rs` | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `a_refused_or_lost_note_is_said_and_fails_the_command` | `tests/merge_cli.rs` | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `expect_is_required_and_the_dry_run_posts_nothing` | `tests/merge_cli.rs` | host git 2.34.1: `git merge-tree --write-tree` needs 2.38, message `git merge-tree failed (git 2.38 or newer is needed)` | no |
| `gateway::probe::tests::a_tls_gateway_is_ours_only_for_the_configured_valid_leaf_naming_the_address` | lib | host openssl cannot make the TLS fixture, message `openssl could not make the fixture (req: Use -help for summary.)` | no |
| `server::hub_rpc::tests::the_mode_toggle_and_the_interrupt_go_through_the_send_door` | lib | fails on clean main on this host; cause not diagnosed (the pane capture, `key:023` then `● Switched to steer mode`, looks like capture timing, not a host fact); message `one toggle, never an Enter` | no |
| `tasks::tests::expired_finished_tasks_are_reaped_and_nothing_else_is` | lib | fails on clean main on this host; cause not diagnosed (candidate host fact: this host's tmux); message `tmux reports the death time` | no |
| `tasks::tests::stop_closes_the_window_with_its_tail_unless_kept` | lib | fails on clean main on this host; cause not diagnosed (candidate host fact: this host's tmux); message `the tail was read before closing` (the pane shows `Pane is dead (signal 2, …)`) | no |
| `projects::scratch::tests::the_shell_can_exit_without_ending_the_session_and_a_dead_pane_is_repaired` | lib | timing of a dead pane; not diagnosed; message `the pane-died hook respawns the shell in place` | **yes**: failed on #8's isolated run, passed in two isolated runs on #11, failed again in this record's run |
| `backends::dsh::tests::the_steer_reader_frames_bytes_and_hands_off_only_a_clean_state` | lib | node itself aborted (V8 `Lazy deopt`) while another isolated full run shared the host; not a code failure | **yes**: failed once in an overlapping run (validator-2, #7, 08:32), passed alone isolated (08:37) and 3 times for builder-3. Only that abort message counts as this flake; any other message is a failure |

**Isolated and unisolated differ.** `server::local_socket::tests::a_dead_socket_is_reclaimed_a_live_one_or_a_foreign_node_never_is` fails only when run on the host next to the live gateway, and passes isolated (validator, #8). It does not belong in this record: a full run on this host is isolated (§ above).

**The 21 frontend failures seen on 2026-11-05 were the install, not the host.** Every unisolated `npm test` that showed them ran on a `node_modules` installed by `pnpm` (this host's interactive zsh aliases `npm` to `pnpm`, which ignores `package-lock.json`), and that tree held Vite 6.4.5 where the lock pins 6.4.2 (builder-3 and builder-4, #14/#13). Measured on `49882cd0`: an UNISOLATED `npm test` on a `bash -c 'npm ci'` install (real npm, Vite 6.4.2) gave 0 failures, the same as isolated. So install with real npm (`command npm ci` or `bash -c 'npm ci'`) before comparing a frontend run with this record, and say so when citing a run from a `pnpm` tree.

## The reboot restore has one live acceptance, and it gates the default (board #422 round 4)

`scripts/restore-acceptance.sh <tmm>` runs a real gateway (`tmm gateway
start`) and a real private tmux server on a rig of its own, with fake
`claude` and `kiro-cli` on PATH that log their argv and every typed line and
fire their own hooks through the helper the app wrote. The rig covers the
claude and kiro fakes only; the real generated dsh shell's restore chain
(readiness naming its launch, through the production launch door) is
covered by the Rust fixtures `a_dsh_hold_is_released_only_by_readiness_naming_its_launch`
and `a_real_dsh_shell_from_the_restart_door_names_its_launch_in_readiness_and_hooks`
(the real generated shell), which the validator runs on the final
tree (orchestrator ruling, 2026-10-19 22:42). It proves the
baseline capture (a checkpoint naming both agents' conversation ids), the
four negatives (old tmux still running; unchanged boot; `restore_on_start =
false`; no checkpoint: nothing restored), the positive on the DEFAULT config
(both sessions back, each agent with its exact id and launch uuid, claude
released by its SessionStart, the fake kiro HELD with its backlog untyped
until the rig types into its pane as a person, then released and the
backlog delivered, one restore line per room), the person's door through
the real CLI and the authenticated RPC with the switch off (`tmm project
restore --run` accepted and run in the background, both sessions back;
`--abandon` with nothing open says so and touches no pane), and that a
wrong token executes nothing. `restore_on_start` defaults to true only
because this passes; a change to the restore runs it again.

- **The boot id is injected by a namespace only.** The gateway runs under
  `unshare --user --map-root-user --mount` with a file bind-mounted over
  `/proc/sys/kernel/random/boot_id` (measured on kernel 6.12 / util-linux
  2.37: the fake id reads back inside, the host's is unchanged outside, and
  tmux clients cross the boundary both ways). There is no production env
  door for the boot id: a process's environment must not be able to fake a
  reboot. The rig checks the host's own boot id before and after.
- **In Docker the rig container runs with `--security-opt
  seccomp=unconfined`.** Docker's default seccomp profile refuses `unshare`
  ("Operation not permitted", measured on Docker 25.0.14), and runc refuses a
  `-v` mount over a `/proc` path. The flag belongs to that disposable test
  container only, which mounts no owner credentials, real config or host
  tmux socket and keeps a private/loopback network and the RPC auth. It is
  not a relaxation of the production or the general e2e configuration. A
  rig that cannot inject the boot id fails; a skip is not acceptance.
- **It follows #406 and #425.** `env -i` with only HOME, PATH,
  XDG_CONFIG/DATA/STATE_HOME, TMUX_TMPDIR, LANG, TERM and SHELL, all under
  the rig; host `127.0.0.1` set explicitly (the default is `0.0.0.0`);
  config, `state.db` and socket asserted inside the rig before each start;
  the gateway is stopped only by the pid it recorded and only while that
  pid carries the rig's HOME; tmux only through `-S` on the rig's socket. No
  owner login is read and no model is called.

## Multi-server work ends in the Docker environment (board #352)

Owner, 2026-10-12: "像你测试整体效果的时候，比如模拟多个连接，可以用 docker 做环境隔离来最终测试".
The multi-server feature (#335 ③, several gateways in one app) was verified
against ONE real gateway plus fakes, and its two-member browser check against
scratch gateways built on this host — their own ports and config dirs, but the
host's kernel, users, `/tmp` and the owner's tmux server. Every incident above
came from test infrastructure sharing the host with the owner's sessions.

Every change that touches more than one server is verified in this
environment, and in two parts: `pnpm run test:e2e:docker`
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
else on the host runs `pnpm run test:e2e:docker` or a compose `down` on
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
the Aggregate UI), run `pnpm run test:e2e:docker -- --keep` FROM that branch's
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

## Two rules for measuring in a real browser (boards #467, #468)

**Coarse-pointer CSS is measured under a real coarse match, on the unmodified
stylesheet (#468).** A rule inside `@media (any-pointer: coarse)` is measured
in a context where `matchMedia('(any-pointer: coarse)')` is true, and the
check reads `getComputedStyle`. What was measured in #468: with the
agent-browser used there (Chromium 152), `set device "iPhone 14"` left that
query false, and Playwright's touch emulation (`hasTouch` and `isMobile`, via
`playwright-core` from `node_modules`) made it true on Chromium 152 and, for the
validator, 153. That is a measured configuration, not a capability of any
version or tool, so every run asserts the `matchMedia` result first, then reads
the computed value, and runs the fine pointer too. Never set the variable on `:root` by hand: that skips the cascade, which is
the thing under test. Incident: the turn rail's touch override
(`--turn-tick-edge: 10px`) was declared 340 lines BEFORE the unconditional
default (24px). A media query adds no specificity, so the later default won on
a phone too. A measurement that wrote 10px onto the root passed, and the
reviewer found the bug by reading the file. On the unmodified stylesheet the
reviewed build computed 24px under touch and the fixed one 10px. A source pin
now holds the order.

**Geometry read inside a `requestAnimationFrame` can precede that frame's
ResizeObserver correction, so a rig states its sampling phase and keeps a
control that must drift (#467).** An rAF callback runs before the frame's
ResizeObserver step; a read taken there can be the state before the observers
have re-anchored. A rig therefore says when it samples, takes its baseline
BEFORE the trigger, and orders its reads after the writes it is testing. A read
deferred to the next task or the next frame is a sampling strategy for that rig,
not a reconstruction of the previous frame: other rAF callbacks, or the read's
own forced layout, may already have moved things, and a write queued for the
next frame (the old composer-shell notification wrote the tail one frame later)
would turn a one-frame drift into a 0. A 0 in the next sample does not prove the
earlier non-zero was never shown. In #467 the validator's rig scored sample
k+1 as frame k; the only non-zero tail samples were single ones on attachment
changes, and both builds had them, each back to 0 at the next sample (1280: 46
and 42px; 390: 116px on `main`, 174px a frame later on the tip).
They are pre-correction differences read in rAF with later samples settled, not
proven un-presented drift. Keep a control with the mechanism removed: with the
feed's ResizeObserver doing nothing ("noro"), the tail drifted 57, 62, 174 and
62px at 390 (46, 42, 46 and 344px at 1280, the viewport shrink never
recovered), so this rig can see a drift of that kind. One control that is
caught does not show that every transient is. Reports say "sampled geometry"
(no sampled frame drifted), never "no frame drifted"; a claim about presented
frames needs a trace or a screenshot, and a case the script did not exercise (a
thumbnail whose size arrives late) is not named as covered.

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
- A source test reads files with Node's own API (`readdirSync`,
  `readFileSync`), never by spawning a host tool (`rg`, `grep`, `find`).
  The project declares no such tool, and the isolation runner rightly does
  not mount one: `harness.source.test.ts` shelled out to ripgrep and failed
  under isolation with `spawnSync rg ENOENT` (board #10, 2026-11-05). `git`
  is the exception, being the repository's own tool.

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
agents share this host, so two `pnpm test` runs at once — the launch checkout
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
`pnpm test` runs on the fix are both green with 24678 never bound; with
`ws: false` removed the guard fails and a single render test binds the port.
The same holds for the Rust suite (board #476, 2026-10-28): two agents' Rust
gates ran at once and `tests/setup_cli.rs`'s gateway, told to listen on the
fixed port 19977, failed in the second with "Address already in use". A test
takes a free port from the OS (`std::net::TcpListener::bind("127.0.0.1:0")`,
then `local_addr()`), as every other integration test already did. That is
probe-then-release, not a lease held until the child binds: it removes the
certain collision of a fixed port; another process could still take the port
in between (two and three concurrent runs passed on the fix; two on main
reproduced the collision). `scripts/test-rust.test.ts` is a CONVENTION guard
for that shape, not a proof about every Rust spelling: it fails on two literal
forms — a loopback `host:N` (N of 1–5 digits, not 0) in a file under
`src-tauri/tests/`, and `bind("host:N")` / `bind(("host", N))` with a literal
N > 0 in any Rust source — and a self-test pins what its matcher catches and
lets through. A port passed through a constant or a variable, or written with
digit separators, is not seen; parsed or compared port values outside the
tests (fixtures) are not binds and are left alone.

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
  dev-server cache (`.vite/`), public assets or project `dist` is involved.
- Heavy packages (`pdfjs-dist`, Mermaid, highlight.js, KaTeX and xterm)
  are excluded at the test-build boundary; bare lazy package imports stay
  deferred. Attempting to use them fails explicitly. Never modify production
  components to make a fixture cheaper.
- A fixture may REPLACE a heavy package with a stand-in of its own, named by
  exact specifier (`compileMount(..., { standIns })`), for a static and a
  lazy `import()` alike (`test/tauri-stand-in.ts` records Files' Tauri plugin
  calls, board #474). The real package is
  still never bundled, and the stand-in paints nothing: it records calls.
  Two kinds of user: the Terminal fixtures (`Terminal.isolation.mount.test.ts`,
  #335 ③a, and their siblings: two real runtimes, a real Terminal bound to
  each, and `test/xterm-stand-in.ts` recording which terminal each frame
  reached) and `Files.upload.mount.test.ts` (#474: which upload path a
  gesture took, through `test/tauri-stand-in.ts`).

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
  type stripping, and `pnpm run check` verifies test code against the
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
  - A per-test directory the test does not remove itself (a declared
    project's workspace, a review fixture, a sibling "outside" path):
    `config::test_scratch(name)`, a path `<root>/<name>-<uuid>` inside this
    process's ONE `fresh_process_dir("tmm-scratch")`, so it goes with that
    root at the next run's door. It creates nothing; the test creates,
    canonicalizes or removes as before. A file path takes
    `.with_extension(…)` on it (a probe script, a socket, a log). Never a
    bare `std::env::temp_dir()` in test code: `config.rs`'s
    `test_code_takes_temp_space_from_the_one_mechanism` scans every
    `tests/` file and every `src/` item whose cfg REQUIRES test (`test`,
    or an `all(…)` listing it anywhere; `any(test, …)` and `not(test)` are
    production) and fails on one. A site whose LOCATION is the point carries
    `temp-dir: allow (<reason>)` on its line or the line above; there are
    three, all about the top of the temp dir itself (the private-socket
    guard and its message in `tmux.rs`, `fresh_process_dir`'s own reclaim
    test). The suffix is 12 hex digits, not a full uuid, because some of
    these paths are tmux sockets and a Unix socket path is capped near 108
    bytes.
  Reason: board #265 (t06 flaked during #264) and #268 (the lib tests #265
  missed; validator 15:30, the per-process store dir grew by one per run).
  A passing full `pnpm run test:rust` leaves nothing in the temp dir but one
  `fresh_process_dir` per prefix (board #269, measured by diffing `/tmp`
  across a run: `tmm-gp-*` and `tmm-spawn-codex-*` had grown by one per run,
  ~130 each, and the symlink fixtures used fixed names). Board #500
  (2026-11-02) found that rule broken again: one full run with an empty
  private `TMPDIR` left 216 entries, ~180 of them per-test directories
  joined straight onto `temp_dir()` (`tmm-r2-*` 115, `tmm-review*` 30,
  `tmm-root-*` 13, `tmm-handoff-ws-*` 9, `tmm-dl-*` 1), and the host had
  ~2400 `tmm-*` entries. Measure it the same way: run the suite with
  `TMPDIR` set to an empty directory and list what is left.
- **No suite test runs a host agent CLI or reads the real user's CLI
  config** (board #515). Where production code asks a CLI or a user file,
  the `#[cfg(test)]` twin of that door points at a per-process stand-in:
  `kiro::models_cli()` is a `kiro-cli` written into
  `fresh_process_dir("tmm-kiro-cli")` that answers only
  `chat --list-models -f json` with a fixed catalogue (`auto`,
  `claude-sonnet-4.5`, `claude-haiku-4.5`); `kimi_user_home()`,
  `grok_user_home()`, `codex_user_home()` and `claude_user_settings()`
  (`shared.rs`) are per-process temp paths. So a test
  that needs the CLI's answer RUNS and can fail in every environment,
  never `return`s early on "CLI unavailable". Before this, two model-list
  tests ran the host `kiro-cli` in a bare `cargo test` (builder-2, #511:
  it touches the real kiro state) and skipped silently inside the isolated
  runner, where no `kiro-cli` is on PATH (kiro, 2026-11-04, main 302bfd8a:
  both printed "kiro-cli unavailable" and passed). `grok models` has the
  same shape, but a search of the suite (kiro, 2026-11-04) found no grok
  definition that saves a model, and an empty model is never validated.

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
