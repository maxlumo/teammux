// Board #132: the Hub's layout measurements, next to the pure rule they feed (drawer-fit.ts).
// The Hub constructs one during its init and reads `narrow`, `drawerFits` and `chatMin`; it
// owns no observer itself (code-quality.md § 2: Hub.svelte gains wiring only).
import { drawerFits, chatHeadMin } from './drawer-fit.ts';

export class HubLayout {
  /** The 760 px compact width (unchanged since before #132). */
  narrow = $state(false);
  coarse = $state(false);
  /** The Hub's own width: drawing or hiding the drawer does not change it, so the rule cannot flap. */
  width = $state(0);
  /** The width the sidebar asks for (--sidebar-w), as it is now. */
  sidebar = $state(240);
  #collapsed: () => boolean;

  constructor(root: () => HTMLElement | null, collapsed: () => boolean) {
    this.#collapsed = collapsed;
    if (typeof window === 'undefined') return;
    this.width = window.innerWidth;
    for (const [query, set] of [
      ['(max-width: 760px)', (v: boolean) => { this.narrow = v; }],
      ['(any-pointer: coarse)', (v: boolean) => { this.coarse = v; }],
    ] as const) {
      set(window.matchMedia(query).matches);
      $effect(() => {
        const mq = window.matchMedia(query);
        const onChange = () => set(mq.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
      });
    }
    $effect(() => {
      const el = root();
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const w = entries[entries.length - 1]?.contentRect?.width;
        if (w !== undefined && w > 0) this.width = w;
      });
      ro.observe(el);
      return () => ro.disconnect();
    });
    // Validator-2, #132 note 5: the sidebar's handle (SideHandle) and App's restore write
    // --sidebar-w on the document root, which resizes no element the Hub observes; every
    // writer goes through that one style, so the width is read whenever it is written. The
    // REQUESTED width, not the rendered track: the track yields while the drawer is drawn
    // (305 for a 420 request in the repro) and sweeps through every width while the sidebar
    // collapses or expands, so judging on it would make the rule depend on its own outcome.
    $effect(() => {
      const doc = document.documentElement;
      const read = () => {
        this.sidebar = parseFloat(doc.style.getPropertyValue('--sidebar-w'))
          || parseFloat(getComputedStyle(doc).getPropertyValue('--sidebar-w')) || 240;
      };
      read();
      const mo = new MutationObserver(read);
      mo.observe(doc, { attributes: true, attributeFilter: ['style'] });
      return () => mo.disconnect();
    });
  }

  get drawerFits(): boolean {
    return drawerFits({ content: this.width, sidebar: this.#collapsed() ? 0 : this.sidebar, coarse: this.coarse });
  }

  get chatMin(): number { return chatHeadMin(this.coarse); }
}
