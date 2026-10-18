// Live props and live scope flags for a mounted fixture (board #357).
//
// `mount(Component, { props })` reads props once per access, so a test that
// needs a parent to CHANGE one later (a request arriving, `visible` flipping)
// hands the component getters over per-prop signals. Only keys given at start
// can change: Svelte reads an absent prop as a constant.
export function reactiveProps(initial: Record<string, unknown>) {
  const props: Record<string, unknown> = {};
  const setters: Record<string, (value: unknown) => void> = {};
  for (const key of Object.keys(initial)) {
    let value = $state.raw(initial[key]);
    Object.defineProperty(props, key, { enumerable: true, get: () => value });
    setters[key] = (next) => { value = next; };
  }
  return {
    props,
    set(patch: Record<string, unknown>) {
      for (const [key, next] of Object.entries(patch)) {
        const set = setters[key];
        if (!set) throw new Error(`prop "${key}" was not given at start, so it cannot change`);
        set(next);
      }
    },
  };
}

/** What the host tells a server-bound page about its binding (`ServerScope.eligible`):
 * flipping it is how a test makes the tree "no longer the focus" or "no
 * longer served" while the component stays mounted and displayed. `tag` is the
 * server's name beside what it owns (null: one server, nothing to name). */
export const scopeFlags = $state<{ eligible: boolean; tag: string | null }>({ eligible: true, tag: null });
