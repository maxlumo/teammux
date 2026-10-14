// The build's identity (board #368): version, short commit, UTC minute. The UI
// bakes its own at build time (vite.config.js `define`); the server says its
// own in the login answer (src-tauri/src/build_info.rs). Putting the two side
// by side is how a phone running a cached old UI is told apart from "the bug
// is not fixed".

export interface BuildInfo {
  version: string;
  commit: string;
  built: string;
}

/** This UI's own build. Under `vite dev` it is NOT a release build (#368
 * review P1-B): the config is read once at start, so a commit or time frozen
 * then would keep naming itself after hot reloads and main moving. A dev
 * server is therefore `dev` + the time it STARTED, flagged, and never compared. */
export interface UiBuild extends BuildInfo {
  devServer?: boolean;
}

/** `dev` / `unknown`: where nothing could say (no git, or no Vite define). */
export const NO_COMMIT = 'dev';
export const NO_TIME = 'unknown';

// `__TMM_BUILD__` / `__TMM_LICENSE__` are Vite defines (src/ambient.d.ts).
/** This UI's own build. Outside Vite (the unit tests) it is the unknown one. */
export const uiBuild: UiBuild = typeof __TMM_BUILD__ === 'undefined'
  ? { version: '0.0.0', commit: NO_COMMIT, built: NO_TIME }
  : __TMM_BUILD__;

export const uiLicense: string = typeof __TMM_LICENSE__ === 'undefined' ? '' : __TMM_LICENSE__;

/** A login answer's `build`, or null for an older server that sends none (or
 * anything that is not three plain strings: never a partial build). */
export function parseBuild(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const { version, commit, built } = raw as Record<string, unknown>;
  for (const v of [version, commit, built]) if (typeof v !== 'string' || !v) return null;
  return { version: version as string, commit: commit as string, built: built as string };
}

/** The two halves of a build line: what it IS (`v1.0.0 · 46392f16`) and when
 * it was made (`2026-10-14 07:40 UTC`, or `unknown`). About stacks them so a
 * narrow column breaks between the halves, never inside a timestamp. */
export function buildParts(b: BuildInfo): { id: string; when: string } {
  return { id: `v${b.version} · ${b.commit}`, when: b.built === NO_TIME ? b.built : `${b.built} UTC` };
}

/** `v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC`: the one line, the same words
 * `tmm gateway status` prints. */
export function formatBuild(b: BuildInfo): string {
  const { id, when } = buildParts(b);
  return `${id} · ${when}`;
}

/** The same commit, whichever abbreviation each side got: `git --short=8` is
 * AT LEAST 8 characters (a collision lengthens it), so one may be a prefix of
 * the other. Prefix compare; a short-hash collision is not detected. The aim
 * is the stale-PWA tell, not proof of identity: the full object id would widen
 * the login answer for no gain the owner can see. */
export function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Are these two sides different builds — the stale-PWA tell? Only when BOTH
 * name a real commit: a `dev` build, a dev server or a server that sent
 * nothing cannot be compared, and saying "mismatch" about it would be a guess. */
export function buildsDiffer(ui: UiBuild, server: BuildInfo | null | undefined): boolean {
  if (!server || ui.devServer) return false;
  if (ui.commit === NO_COMMIT || server.commit === NO_COMMIT) return false;
  return !sameCommit(ui.commit, server.commit);
}

/** `HH:MM UTC` of a build's minute (`2026-10-14 15:38`), or `unknown`. */
export function clockOf(built: string): string {
  return /^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(built) ? `${built.slice(11)} UTC` : built;
}
