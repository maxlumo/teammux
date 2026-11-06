  }
  /** Board #43: one immediate edge edit on the open issue — not part of the
   * draft (an edge has no undo of its own: removing it IS the undo). The
   * request owns a frozen context like every other write here, and the
   * issue is read back after it. */
  async function editBlocks(edit: { add?: number[]; remove?: number[] }) {
    if (!sel || busy) return;
