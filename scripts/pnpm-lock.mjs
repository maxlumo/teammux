// The versions pnpm-lock.yaml resolves for the root project's direct
// dependencies (board #33): one reader for the tests that pin a version to
// the lock (the Vite stamp, #396; the tauri crate match). It reads only the
// `importers: '.':` block, whose shape lockfileVersion 9.0 fixes:
//   '<name>':            (quoted when it starts with @)
//     specifier: <range>
//     version: <version>[(<peer suffix>)]
// A peer suffix is dropped. Nothing else of the lock is read.
// With `packageManager` set, pnpm 12 writes pnpm itself into a FIRST YAML
// document (the env lockfile, its own `importers: '.':`); the project is the
// LAST document, so that is the one read.

/** `{ name: version }` for every direct dependency of the root project. */
export function rootVersions(lock) {
  const text = projectDocument(lock);
  const start = text.indexOf("\nimporters:\n");
  const root = start === -1 ? -1 : text.indexOf("\n  .:\n", start);
  if (root === -1) throw new Error("pnpm-lock.yaml has no importers '.' block");
  const next = text.slice(root + 1).search(/\n(?: {2}\S|\S)/);
  const block = next === -1 ? text.slice(root) : text.slice(root, root + 1 + next);
  const out = {};
  for (const m of block.matchAll(/^ {6}'?([^':\n]+)'?:\n {8}specifier: [^\n]*\n {8}version: ([^\n(]+)/gm)) out[m[1]] = m[2].trim();
  return out;
}

/** The project's document of a lock: the text after its last `---` line, or
 * the whole lock when it has none. It is what pnpm records as installed in
 * node_modules/.pnpm/lock.yaml, byte for byte (measured with 12.16.1, #33). */
export function projectDocument(lock) {
  const m = [...lock.matchAll(/^---\n/gm)].at(-1);
  return m ? lock.slice(m.index + m[0].length) : lock;
}
