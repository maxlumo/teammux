// When a server is NAMED beside what it owns (board #335 ③c-1).
//
// The ②a ruling (reviewer 2026-10-10, kept through ③): the tag shows when
// MORE THAN ONE server is included in what the app shows — the source set,
// not how many answered. A member that is offline, failing or still dialling
// still counts: a list that lost a server must keep saying where its
// remaining rows are from. Single mode includes one server and so never
// tags; Aggregate with one included server does not either.
//
// ONE definition, read by every tag site: a page head, a union row, the Hub
// head, a notification title. A site that computed its own "do I show the
// server" would drift from the others — the one thing a tag must not do.
import type { ServerId } from './refs.ts';

/** The servers currently included: every saved entry Aggregate connects to,
 * or the one Single is on. Health is not consulted. */
export interface TagScope {
  readonly included: readonly { id: ServerId; name: string }[];
}

/** Should a server be named at all right now? */
export function tagsShown(scope: TagScope): boolean {
  return scope.included.length > 1;
}

/** The name to show for `serverId`, or null: not shown (one server), or not
 * an included server (an orphan, a stranger's ref — then the id itself is
 * better than nothing, because an unnamed foreign row is the ambiguity the
 * tag exists to remove). */
export function serverTag(scope: TagScope, serverId: ServerId | null | undefined): string | null {
  if (!serverId || !tagsShown(scope)) return null;
  return scope.included.find((s) => s.id === serverId)?.name ?? serverId;
}

/** A tag's SHORT form, for a door that must stay small (Files' path line,
 * #366; owner 2026-10-14: "用一个非常小的 button 来做切换，保留机器的前几个字母
 * 就好"): the name's first word (split on space, dot, dash, underscore), at
 * most `SHORT_TAG_MAX` (8) characters — 8, not 6, so the owner's
 * own "devbox" and "macmini" stay whole. A short form that another included
 * server's would also produce names neither, so then the full name is used —
 * a door that cannot tell two machines apart is no door. Null exactly when
 * `serverTag` is null (the one rule decides WHETHER; this decides how long). */
export const SHORT_TAG_MAX = 8;
const shortOf = (name: string) => (name.split(/[\s._-]+/u).find(Boolean) ?? name).slice(0, SHORT_TAG_MAX);
export function shortServerTag(scope: TagScope, serverId: ServerId | null | undefined): string | null {
  const full = serverTag(scope, serverId);
  if (full === null) return null;
  const short = shortOf(full);
  const clash = scope.included.some((s) => s.id !== serverId && shortOf(s.name) === short);
  return clash ? full : short;
}
