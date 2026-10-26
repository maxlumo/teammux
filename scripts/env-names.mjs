// One rule for an environment variable that was renamed with the project: tmux-mobile
// became Teammux (board #472, phase B2). `TMUX_MOBILE_X` is now `TEAMMUX_X`.
//
//   - The source is chosen by whether the NEW name is PROVIDED (present, even empty).
//     A provided new value is the one in use, and each consumer then applies its own
//     parsing for empty, zero or invalid to it, exactly as it did to the old name: an
//     invalid new value is an error, never a silent return to the old one.
//   - The old name alone still works.
//   - Both set and different: the new one wins, and the line says so.
//   - The line names the VARIABLES and never a value (a host or a token path can be
//     in them), at most once per process per old variable.
//
// The reader is a function so a test can hand it its own sink and its own "said"
// memory; the one the scripts use writes to stderr.

export function createEnvReader(warn = (line) => process.stderr.write(`[teammux] ${line}\n`)) {
  const said = new Set();
  const say = (legacy, line) => {
    if (said.has(legacy)) return;
    said.add(legacy);
    warn(line);
  };
  return function read(env, name, legacy) {
    if (env[name] !== undefined) {
      if (env[legacy] !== undefined && env[legacy] !== env[name]) {
        say(legacy, `${name} and ${legacy} are both set and differ; ${name} is used (${legacy} is deprecated)`);
      }
      return env[name];
    }
    if (env[legacy] !== undefined) {
      say(legacy, `${legacy} is deprecated; use ${name}`);
      return env[legacy];
    }
    return undefined;
  };
}

/** The reader the scripts share: stderr, once per process per old variable. */
export const readEnv = createEnvReader();
