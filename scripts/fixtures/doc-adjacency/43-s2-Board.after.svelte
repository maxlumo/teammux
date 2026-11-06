  }
  /** Board #43: one immediate edge edit on the open issue — not part of the
   * draft (an edge has no undo of its own: removing it IS the undo). The
   * request owns a frozen context like every other write here, and the
   * issue is read back after it. */
  /** Bumped when an edge edit ends, however it ended: the picker is rebuilt
   * from it, so it shows nothing chosen after a refusal too, not only after
   * the edges changed (validator-2 F1 on 78f4287a). */
  let blockPicks = $state(0);
  async function editBlocks(edit: { add?: number[]; remove?: number[] }) {
    if (!sel || busy) return;
