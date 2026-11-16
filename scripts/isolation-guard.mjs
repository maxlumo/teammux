// The ONE guard of every test entry (board #137; owner, 2026-11-06 15:07: "If you want to test, open a
// virtual environment in Docker; do not test on this machine"). A test tool runs only inside the isolated
// runner (scripts/isolated.mjs): its container exports ISOLATED_RUNNER=1, and the container itself is
// Docker's /.dockerenv, which only root can create on a host; both must hold, so an environment variable
// typed on the host is not enough. Outside it, the entry starts NOTHING and names the command to use.
//
// A person at this terminal may still take over on purpose (the terminal is always theirs): the one
// override is an environment variable with one exact value, never a default, never read from a file.
// Agents never set it (development.md).
//
// Used as a module (`requireIsolated`, by test-rust.mjs) and as the first command of an entry
// (`node scripts/isolation-guard.mjs pnpm test && node --test …`, package.json).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OVERRIDE = 'TEAMMUX_HOST_TESTS';
export const OVERRIDE_VALUE = 'i-am-the-human-at-this-terminal';
/** The exit status of a refusal. */
export const REFUSED = 96;

/** Inside the isolated runner: its marker AND a container. */
export function insideRunner({ env = process.env, dockerenv = '/.dockerenv' } = {}) {
  return env.ISOLATED_RUNNER === '1' && existsSync(dockerenv);
}

/** One word for a POSIX shell: as is when it is plainly safe, else single-quoted ('\'' for a quote), so
 * the advice a person copies is the command that was refused, argument for argument (validator #137). */
export function shellWord(word) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command as a person types it: its words, each quoted where it must be. The ONE rendering path. */
export function shellCommand(words) {
  return words.map(shellWord).join(' ');
}

/** `words`: the refused command's argv (e.g. ['pnpm', 'run', 'test:rust', '--lib', 'x']). */
export function refusal(words) {
  const command = shellCommand(words);
  return [
    `refused: \`${command}\` runs tests, and tests run only inside the isolated runner (owner, 2026-11-06: no test on this host).`,
    `  use: node scripts/isolated.mjs -- ${command}`,
    `  a person at this terminal who means to run it here, and only a person: ${OVERRIDE}=${OVERRIDE_VALUE} ${command}`,
  ].join('\n');
}

/** Returns when the entry may run; otherwise says why and exits `REFUSED`, having started nothing.
 * `words` is the entry's command as argv, never a joined string (its boundaries are kept). */
export function requireIsolated(words, { env = process.env, dockerenv = '/.dockerenv', log = console.error, exit = process.exit } = {}) {
  if (insideRunner({ env, dockerenv }) || env[OVERRIDE] === OVERRIDE_VALUE) return;
  log(refusal(words));
  exit(REFUSED);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) requireIsolated(process.argv.length > 2 ? process.argv.slice(2) : ['this test entry']);
