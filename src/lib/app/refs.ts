// What the app points AT, once there can be more than one tmux server
// (board #335 ②). A name alone stopped being an address: two servers may both
// have a session called `work`, a room called `proj:work` and an issue `#3`,
// and a reference that carries only the name would silently resolve against
// whichever server happens to be current.
//
// A ref is an IDENTITY, never a payload. It carries the server plus the
// smallest thing tmux or the bus needs to resolve the object, and nothing
// else: a ProjectRef holds `projectId`, not the project's path, name or room,
// because then two modules would define what a project is and the copy in the
// ref would go stale on the first rename.
//
// HARD RULE — the serverId never reaches the wire. It names which CONNECTION
// carries a call; the call's own `session`, `target` and `room` arguments are
// exactly the strings a single-server build sends today. Nothing here builds a
// wire string, and this module imports no transport, so it cannot send one.
// `refKey` DOES mix the serverId into a string, and that string is a JSON
// tuple precisely so it can never be mistaken for a `session:window.pane`
// target if it leaks into the wrong argument — it would fail loudly.
import { retarget } from './nav-state.ts';

/** `ServerEntry.id` from `app/servers.ts`, which stays the one authority on
 * which saved server is which. Never a URL, a hostname or a machine id: an
 * address is a candidate route to a server, not a second identity. */
export type ServerId = string;

/** A tmux session on one server. The base ref: Files, Board and the Hub all
 * address a project by its session name. */
export interface SessionRef {
  kind: 'session';
  serverId: ServerId;
  session: string;
}

/** One pane. `target` is tmux's own `session:window.pane`, so it repeats the
 * session name; both are kept because that is how the app holds a pane
 * (`terminalTarget` + `terminalSession`), and a rename has to move both. */
export interface PaneRef {
  kind: 'pane';
  serverId: ServerId;
  session: string;
  target: string;
}

/** A bus room. A room name (`proj:<session>` for a project) is already unique
 * within a server, and it deliberately does NOT follow a session rename — the
 * room is recorded on the project so a rename cannot orphan the chat. */
export interface RoomRef {
  kind: 'room';
  serverId: ServerId;
  room: string;
}

/** A board issue. `id` is the session-local durable number, so it only means
 * anything together with its session. */
export interface IssueRef {
  kind: 'issue';
  serverId: ServerId;
  session: string;
  id: number;
}

/** A declared project. Addressed by `Project.id`, which is why projects have
 * an id at all: it survives every rename of name, session and path. */
export interface ProjectRef {
  kind: 'project';
  serverId: ServerId;
  projectId: string;
}

export type Ref = SessionRef | PaneRef | RoomRef | IssueRef | ProjectRef;

export const sessionRef = (serverId: ServerId, session: string): SessionRef =>
  ({ kind: 'session', serverId, session });

export const paneRef = (serverId: ServerId, session: string, target: string): PaneRef =>
  ({ kind: 'pane', serverId, session, target });

export const roomRef = (serverId: ServerId, room: string): RoomRef =>
  ({ kind: 'room', serverId, room });

export const issueRef = (serverId: ServerId, session: string, id: number): IssueRef =>
  ({ kind: 'issue', serverId, session, id });

export const projectRef = (serverId: ServerId, projectId: string): ProjectRef =>
  ({ kind: 'project', serverId, projectId });

/**
 * One unambiguous string per referenced object, for the places that need a map
 * key or a list key: unread watermarks, open drafts, download rows, a union
 * list's `{#each}` key.
 *
 * A JSON tuple rather than `a|b|c`, because every part is user data — a
 * session may contain any character a human types — and a separator that can
 * appear inside a part makes two different objects share a key. The leading
 * kind tag keeps a room called `1.0` apart from a pane target, so one map can
 * hold refs of several kinds without collisions.
 */
export function refKey(ref: Ref): string {
  switch (ref.kind) {
    case 'session':
      return JSON.stringify(['session', ref.serverId, ref.session]);
    // The target already names the session, so keying on both would mint two
    // keys for one pane the moment they disagreed.
    case 'pane':
      return JSON.stringify(['pane', ref.serverId, ref.target]);
    case 'room':
      return JSON.stringify(['room', ref.serverId, ref.room]);
    case 'issue':
      return JSON.stringify(['issue', ref.serverId, ref.session, ref.id]);
    case 'project':
      return JSON.stringify(['project', ref.serverId, ref.projectId]);
  }
}

/**
 * Follow an identity MERGE: a ref whose server was absorbed into another
 * entry names the survivor (board #335 ②b-2, reviewer P1, 2026-10-10).
 *
 * `recordServer` folds a machine's twin entries into one — an address-only
 * entry learns it is the machine we already know — and the absorbed entry is
 * deleted from the registry. Nothing about the OBJECT changed: it is the same
 * session on the same machine, and only the entry that names its connection
 * was merged. So the serverId moves and nothing else does.
 *
 * `survivorOf` is the identity layer's answer (`servers.mergedInto`): the id
 * itself while saved, the survivor of a merge that actually happened, or ''.
 * Only the middle case moves a ref. An id that is merely ABSENT from the
 * registry is not evidence of anything (reviewer P1-a): re-pointing it at the
 * current server would open that server's same-named pane. Returns the same
 * object whenever nothing moved.
 */
export function reownRef<R extends Ref>(ref: R, survivorOf: (id: ServerId) => ServerId): R {
  const into = survivorOf(ref.serverId);
  return into && into !== ref.serverId ? { ...ref, serverId: into } : ref;
}

/** A session rename that happened on ONE server. The serverId travels with
 * `from`/`to` so a call site cannot apply server A's rename to server B's
 * identically named session — the bug this type exists to make unwritable. */
export interface SessionRename {
  serverId: ServerId;
  from: string;
  to: string;
}

/**
 * Follow a session rename, in the same prefix-exact way a single-server build
 * does (`nav-state.retarget` is the one definition of that rule), and only
 * within the server the rename happened on.
 *
 * Returns the ref UNCHANGED — the same object, so a caller can compare by
 * identity and a `$state` holder does not churn — when the rename belongs to
 * another server, when it is a no-op, or when this kind of ref does not move:
 *
 *   - a RoomRef never moves. A project's room is recorded on the project, so
 *     renaming the session leaves the conversation where it is.
 *   - a ProjectRef never moves. `Project.id` is stable across every rename.
 */
export function retargetRef<R extends Ref>(ref: R, rename: SessionRename): R {
  const { serverId, from, to } = rename;
  if (ref.serverId !== serverId || !from || !to || from === to) return ref;
  switch (ref.kind) {
    case 'session':
      return ref.session === from ? { ...ref, session: to } : ref;
    case 'pane': {
      const session = ref.session === from ? to : ref.session;
      const target = retarget(ref.target, from, to);
      return session === ref.session && target === ref.target ? ref : { ...ref, session, target };
    }
    case 'issue':
      return ref.session === from ? { ...ref, session: to } : ref;
    case 'room':
    case 'project':
      return ref;
  }
}
