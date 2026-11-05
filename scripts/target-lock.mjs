// ONE guard for a cargo target directory (board #35): `test:rust` and
// `check:android` never run in it at the same time. Retro on #25, 2026-11-05:
// an Android check beside a Rust test run left 5 tests failing with
// `current_exe` ENOENT (validator-2), each passing alone. cargo's own
// build-directory lock covers its BUILDS only; the damage lands while
// `cargo test` RUNS the test binaries, after that lock is released, so this
// lock is held for the whole command.
//
// The lock is an exclusive advisory flock on `<target>/.tmm-run.lock`, taken
// and held by the host's own perl (in base macOS and Linux; Node has no
// flock, and the util-linux `flock` CLI is not on macOS). perl runs the
// command as its child and waits for it, so the lock lives exactly as long
// as the run. Its fd is close-on-exec: the command's children do not inherit
// it, so a daemon a test leaves behind never holds the directory. The kernel
// drops the lock when perl exits, by any path, kill -9 included; there is no
// stale-file logic. A second run refuses at once with exit 75, naming the
// holder line the first wrote (pid, label, command, start) and the way out.
// It does NOT stop a `git commit` in the worktree during a run (build.rs
// watches HEAD): testing.md § one run per target directory.
import { isAbsolute, join, resolve } from 'node:path';

export const LOCK_REFUSED = 75; // EX_TEMPFAIL: try again later

/** Where cargo puts its artifacts for this repo: CARGO_TARGET_DIR (relative
 * to the repo root, where both runners start cargo) or src-tauri/target. */
export function targetDir(env, repoRoot) {
  const set = env.CARGO_TARGET_DIR;
  if (set) return isAbsolute(set) ? set : resolve(repoRoot, set);
  return join(repoRoot, 'src-tauri', 'target');
}

export function lockFile(target) {
  return join(target, '.tmm-run.lock');
}

const HOLD = String.raw`
use strict; use warnings; use Fcntl qw(:flock); use File::Path qw(make_path);
my ($target, $lock, $label, @cmd) = @ARGV;
make_path($target);
open(my $fh, '+>>', $lock) or die "[$label] cannot open $lock: $!\n";
unless (flock($fh, LOCK_EX | LOCK_NB)) {
  seek($fh, 0, 0); local $/; my $holder = <$fh> // ''; chomp $holder;
  print STDERR "[$label] refused: another run holds the target directory $target\n"
    . "  holder: " . ($holder eq '' ? 'unknown (it is starting)' : $holder) . "\n"
    . "  Wait for it to finish, or run in another worktree (its own target directory).\n";
  exit 75;
}
my $pid = fork() // die "[$label] fork: $!\n";
if ($pid == 0) { { exec { $cmd[0] } @cmd } print STDERR "[$label] $cmd[0]: $!\n"; exit 127; }
truncate($fh, 0); seek($fh, 0, 0);
print $fh "pid $$ ($label, child $pid) since " . scalar(localtime) . ": @cmd\n";
$fh->flush;
for my $sig (qw(INT TERM HUP)) { $SIG{$sig} = sub { kill $sig, $pid }; }
waitpid($pid, 0);
exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
`;

/** `[cmd, args]` that run `command args` holding the lock on `target`, for
 * spawn/spawnSync. The exit status is the command's, or 75 when refused. */
export function lockedCommand(target, label, command, args) {
  return ['perl', ['-e', HOLD, target, lockFile(target), label, command, ...args]];
}
