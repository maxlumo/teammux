#!/usr/bin/env node
// `pnpm run test:live:docker` — the ONE place a live check with real agent CLIs runs (board #55).
//
// Owner, 2026-11-06 15:07: "Why did you change the system's configuration during development?
// These are things that are forever forbidden. If you want to test, open a virtual environment in
// Docker; do not test on this machine." That day's live checks on this host relinked
// ~/.local/bin/claude four times (scratch claudes at 08:00, 08:55, 09:11; a managed fork at 09:30)
// and rewrote ~/.codex/config.toml twice (14:00, 14:20) through a scratch codex home's symlink.
//
// This file holds the host side of the rig. Its proof that the host was left alone is a snapshot of
// an ALLOW-LIST of the user's config, credential and link paths taken before and after a run
// (orchestrator 15:15): not "everything minus exclusions", because the user's own CLIs write their
// sessions and history while the rig runs, and those would be false alarms. A missing path is
// recorded as absent; one that cannot be read throws, naming it (#48: unknown is not safe).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** The user's files a managed render links or reads, relative to HOME. ~/.codex's profile layers
 * (`*.config.toml`) and every link in ~/.local/bin are added from the directory itself. */
export const HOST_FILES = ['.codex/config.toml', '.codex/auth.json', '.codex/.env', '.claude/settings.json', '.claude.json', '.config/teammux/config.toml'];

/** What stands at `p`: `sha256:<hex>` for a file, `link → <target>` for a link (never followed),
 * `dir` for a directory, null when absent. Anything that cannot be read is pushed to `bad`. */
function stateOf(p, bad) {
  let st;
  try { st = lstatSync(p); } catch (e) {
    if (e.code === 'ENOENT') return null;
    bad.push(`${p}: ${e.code ?? e.message}`);
    return undefined;
  }
  try {
    if (st.isSymbolicLink()) return `link → ${readlinkSync(p)}`;
    if (st.isDirectory()) return 'dir';
    return `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  } catch (e) {
    bad.push(`${p}: ${e.code ?? e.message}`);
    return undefined;
  }
}

const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The names in `dir` that `keep` accepts; [] when it is absent; pushed to `bad` when unreadable. */
function listed(dir, keep, bad) {
  try { return readdirSync(dir).filter(keep).sort(); } catch (e) {
    if (e.code !== 'ENOENT') bad.push(`${dir}: ${e.code ?? e.message}`);
    return [];
  }
}

/** The allow-list's state under `home`, keyed by absolute path. Throws, naming every path, when any
 * of it cannot be read. */
export function hostSnapshot(home) {
  const bad = [];
  const paths = [
    ...HOST_FILES,
    ...listed(join(home, '.codex'), (n) => n.endsWith('.config.toml'), bad).map((n) => `.codex/${n}`),
    // Every LINK in ~/.local/bin (orchestrator 15:15): a CLI's updater relinks there; the user's
    // own regular files there are theirs to install and change.
    ...listed(join(home, '.local', 'bin'), (n) => isLink(join(home, '.local', 'bin', n)), bad).map((n) => `.local/bin/${n}`),
  ];
  const out = {};
  for (const rel of [...new Set(paths)]) {
    const p = join(home, rel);
    out[p] = stateOf(p, bad);
  }
  if (bad.length) throw new Error(`the host's config cannot be read, so it cannot be proven unchanged:\n  ${bad.join('\n  ')}`);
  return out;
}

/** Every difference between two snapshots, one line per path, in path order. */
export function hostChanges(before, after) {
  const out = [];
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = Object.hasOwn(before, p) ? before[p] : null;
    const b = Object.hasOwn(after, p) ? after[p] : null;
    if (a === b) continue;
    if (a === null) out.push(`${p} appeared`);
    else if (b === null) out.push(`${p} was removed`);
    else if (String(a).startsWith('link') || String(b).startsWith('link')) out.push(`${p} changed (${a} is now ${b})`);
    else out.push(`${p} changed`);
  }
  return out;
}
