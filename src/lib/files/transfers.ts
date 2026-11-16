// The app's ONE transfer limiter (board #134, leader note 2). One per app instance, shared by every
// server: the cap protects this device's link and memory, which two servers' transfers share. Plain
// TypeScript, so the transfer cores (save-file.ts, http-upload.ts) and their node tests load it; the
// setting's reactive face is transfers.svelte.ts.
import { createTransferSlots } from './transfer-slots.ts';

export const TRANSFER_LIMIT_KEY = 'tmux_transfer_limit';
export const TRANSFER_LIMIT_MIN = 1;
export const TRANSFER_LIMIT_MAX = 8;
export const TRANSFER_LIMIT_DEFAULT = 3;

export const clampTransferLimit = (n: number) => Math.max(TRANSFER_LIMIT_MIN, Math.min(TRANSFER_LIMIT_MAX, Math.round(n)));

/** The stored limit (per device), or the default. */
export function storedTransferLimit(): number {
  try {
    const n = Number.parseInt(globalThis.localStorage?.getItem(TRANSFER_LIMIT_KEY) ?? '', 10);
    return Number.isFinite(n) ? clampTransferLimit(n) : TRANSFER_LIMIT_DEFAULT;
  } catch { return TRANSFER_LIMIT_DEFAULT; }
}

/** Every download and upload goes through this one instance. */
export const transferSlots = createTransferSlots(storedTransferLimit());
