// The ONE token for an operation whose answer belongs to the gesture that asked and to the owner
// it was asked for (board #144's rule, extracted for #150, leader note 19; testing.md § Rules for
// the next async operation). An operation is minted FOR an owner at the call, synchronously,
// before its first await; it is retired for good by a newer operation, by the owner becoming
// anything other than the one it was minted for (an edge: away and back stays dead), and by the
// host's end; a change TO the owner it was minted for never retires it, whichever runs first.

export class OwnedToken {
  #token = 0;
  #owner: string | null = null;

  /** Retire every pending operation for good; the token a new one would hold. */
  retire(): number {
    return ++this.#token;
  }

  /** An operation starts under `owner`: every older one retires, the new token is minted for it. */
  begin(owner: string): number {
    this.#owner = owner;
    return this.retire();
  }

  /** The host's owner is now `now`: a token minted for any other owner retires (true); one minted
   * for `now` stays (false). */
  own(now: string): boolean {
    if (this.#owner === now) return false;
    this.#owner = now;
    this.retire();
    return true;
  }

  /** Is `token` still the current, unretired operation? */
  live(token: number): boolean {
    return token === this.#token;
  }
}
