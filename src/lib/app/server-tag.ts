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
