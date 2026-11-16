// Board #144 (owner, 2026-11-16 14:27: "我发现agent 经常返回给我的路径是一个相对于某个子文件夹下的路径 …
// 如果文件你找不到，你能不能帮我去find一下 … 如果匹配到一个，直接显示，如果匹配到多个，就显示一个选项卡，
// 让人二次选择"): after Files' OWN not-found for an agent's reference, the server searches where it
// ends (fs_find_tail: <root>/<one or more folders>/<ref>, nearest first, bounded). One match opens,
// several ask through the chooser, none is today's not-found. A search that did not cover the tree
// (a limit stopped it, or a folder could not be read) is never a unique match and says why. The
// answer belongs to the tap that asked: one permanent token (`retire()`).

/** The login capability a server that can search announces (an older one: today's behaviour). */
export const PATH_FIND = 'path_find';
/** How many matches the chooser shows (the server collects up to 21). */
export const SHOWN = 10;

export type FindRequest = { session: string; ref: string };
export type FindAnswer = { root: string; matches: string[]; more: boolean; stopped?: 'time' | 'dirs' | 'unreadable' };
/** Why an answer is not complete: a limit ended the walk early, or a folder could not be read
 * (#144 note 40); null when the walk covered the tree. Either is never a unique match. */
export type Stop = 'early' | 'unreadable' | null;

type Opener = (abs: string, rel: string) => void;
type Choices = { root: string; shown: string[]; more: boolean; stopped: Stop; token: number; open: Opener; missing: (stopped: Stop) => void };

const under = (root: string, rel: string) => `${root.replace(/\/+$/u, '')}/${rel}`;

export class PathFind {
  /** The open chooser, or null. */
  choices = $state<Choices | null>(null);
  #ask: (session: string, ref: string) => Promise<FindAnswer>;
  #caps: () => string[] | undefined | null;
  /** ONE permanent retirement (leader's ruling, #144 note 24): every find holds the token it
   * started with; `retire()` moves it on for good, so a late answer or a pick from an older
   * reference applies nothing, whatever the state looks like when it lands. */
  #token = 0;
  /** The owner (Files' session, server and scope) the current token was minted FOR (#144 note 45). */
  #owner: string | null = null;

  constructor(ask: (session: string, ref: string) => Promise<FindAnswer>, caps: () => string[] | undefined | null) {
    this.#ask = ask;
    this.#caps = caps;
  }

  /** Search for `find` after Files did not find it; `open` an absolute path, or report it
   * `missing` (with why the search was not complete, or null). `token` is the one `retire()` returned when the
   * operation BEGAN, before its first await (#144 note 29): a miss that lands after its owner
   * was retired asks nothing. */
  async afterMiss(find: FindRequest, token: number, open: Opener, missing: (stopped: Stop) => void): Promise<void> {
    if (token !== this.#token) return;
    if (!this.#caps()?.includes(PATH_FIND)) { missing(null); return; }
    let answer: FindAnswer;
    try {
      answer = await this.#ask(find.session, find.ref);
    } catch {
      if (token === this.#token) missing(null);
      return;
    }
    if (token !== this.#token) return;
    const stopped: Stop = answer.stopped === 'unreadable' ? 'unreadable' : answer.stopped ? 'early' : null;
    if (answer.matches.length === 0) { missing(stopped); return; }
    // Exactly one opens only from a COMPLETE search (leader's ruling, note 16): a walk that
    // stopped early left folders unread, so its single match is a choice, not a fact.
    if (answer.matches.length === 1 && !stopped) { open(under(answer.root, answer.matches[0]!), answer.matches[0]!); return; }
    this.choices = { root: answer.root, shown: answer.matches.slice(0, SHOWN), more: answer.more || answer.matches.length > SHOWN, stopped, token, open, missing };
  }

  pick(i: number): void {
    const c = this.choices;
    this.choices = null;
    const rel = c?.shown[i];
    if (c && rel !== undefined && c.token === this.#token) c.open(under(c.root, rel), rel);
  }

  /** What Files shows or who owns it changed (another entry, a directory navigation, a file,
   * session, server or scope change in either direction, the unmount): every pending find and
   * the chooser of an older reference are retired for good. */
  retire(): number {
    this.choices = null;
    return ++this.#token;
  }

  /** A reference is raised under `owner`: every older find retires, and the new token is minted
   * for that owner. */
  begin(owner: string): number {
    this.#owner = owner;
    return this.retire();
  }

  /** Files' owner is now `now`: a token minted for any other owner retires; one minted for
   * `now` stays, whichever of `begin` and `own` runs first (#144 note 45). */
  own(now: string): void {
    if (this.#owner !== now) { this.#owner = now; this.retire(); }
  }

  dismiss(): void {
    const c = this.choices;
    this.choices = null;
    if (c && c.token === this.#token) c.missing(null);
  }
}
