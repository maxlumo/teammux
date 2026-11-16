// The transfer limit as a setting (board #134): Settings reads and sets it here; the one limiter is
// transfers.ts. Per device, 1 to 8, default 3, applied at once.
import { clampTransferLimit, storedTransferLimit, transferSlots, TRANSFER_LIMIT_KEY } from './transfers.ts';

const state = $state({ limit: storedTransferLimit() });

export const transferPrefs = {
  get limit() { return state.limit; },
  setLimit(value: number) {
    if (!Number.isFinite(value)) return;
    state.limit = clampTransferLimit(value);
    transferSlots.setLimit(state.limit);
    try { localStorage.setItem(TRANSFER_LIMIT_KEY, String(state.limit)); } catch {}
  },
};
