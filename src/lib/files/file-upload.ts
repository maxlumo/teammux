// Upload feedback (board #214, owner 2026-09-20: "文件上传要有个进度或者提示，
// 让我知道传上去了没有"). One file is ONE atomic `fs_upload` RPC — its base64
// body rides in a single WebSocket message and nothing observes the send —
// so the only honest progress is per file: the LOCAL read (FileReader reports
// bytes) then a discrete "sending" beat that ends when the server answers.
// `uploaded` is the RPC resolving, never the send returning.

import type { FeedbackValue } from '../ui/feedback-lifetime.ts';

/** The server refuses a WebSocket message above this many bytes
 * (`WS_MAX_MESSAGE_BYTES`, connection.rs; a source test pins the two equal).
 * One `fs_upload` carries its whole file in ONE message. */
export const WS_MAX_MESSAGE_BYTES = 80 * 1024 * 1024;
/** What the encrypted wire adds to a message's JSON when it is not
 * compressed: the framing byte and the AES-GCM tag (connection.ts
 * encodeWirePayload/encryptMsg). Compression is used only when it is
 * smaller, so the uncompressed form is the largest a message can be, and
 * the plain-token text frame is smaller still. */
export const E2E_OVERHEAD_BYTES = 1 + 16;
const MIB = 1024 * 1024;

/** The largest file one `fs_upload` to `path` can carry (board #498). A
 * fixed 60 MB cap was wrong at its own edge: 60 MiB of base64 is exactly the
 * 80 MiB limit before the JSON around it, so a file at the cap was refused
 * by the server as "Message too long" and the person saw "connection lost"
 * (measured on #497's rig). The wrapper is priced by serializing it, as
 * `call()` does, at the largest request id, in UTF-8 bytes: a path's quotes,
 * backslashes, control characters and CJK cost what they cost on the wire. */
/* `null` when not even an empty file fits: the wrapper alone is over the
 * limit, which is not the same as a capacity of 0 bytes (review P2-A). */
export function maxUploadBytes(path: string): number | null {
  const wrapper = new TextEncoder().encode(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method: 'fs_upload', params: { path, data: '' } })).length;
  const room = WS_MAX_MESSAGE_BYTES - wrapper - E2E_OVERHEAD_BYTES;
  return room < 0 ? null : Math.floor(room / 4) * 3;
}

export type UploadPhase = 'reading' | 'sending';

export interface UploadStep {
  name: string;
  /** 1-based position in the batch. */
  index: number;
  total: number;
  phase: UploadPhase;
  /** Bytes of THIS file read so far; only meaningful while `reading`. */
  loaded: number;
  size: number;
}

export interface UploadOutcome {
  ok: string[];
  failed: { name: string; error: string }[];
}

export interface UploadStrings {
  uploading: string;      // 'Uploading {name} ({index}/{total})'
  uploadSending: string;  // 'Sending'
  uploadReading: string;  // 'Reading'
  uploaded: string;       // 'Uploaded {name}'
  uploadedMany: string;   // 'Uploaded {count} files'
  uploadFailed: string;   // 'Upload failed: {names}'
  uploadPartial: string;  // '{ok} uploaded, {failed} failed: {names}'
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

/** The in-flight line. Reading shows a real percentage (FileReader bytes);
 * sending shows the phase with an indeterminate spinner — a percentage there
 * would be invented. */
export function uploadProgress(step: UploadStep, dir: string, s: UploadStrings): FeedbackValue {
  const message = fill(s.uploading, { name: step.name, index: step.index, total: step.total });
  if (step.phase === 'reading' && step.size > 0) {
    return { kind: 'progress', message, detail: `${s.uploadReading} · ${dir}`, progress: Math.min(100, (step.loaded / step.size) * 100) };
  }
  return { kind: 'progress', message, detail: `${s.uploadSending} · ${dir}`, progress: null };
}

/** The closing line. Any failure names the files that failed (owner: know
 * WHICH one did not land); a clean batch says how many landed. */
export function uploadSummary(outcome: UploadOutcome, dir: string, s: UploadStrings): FeedbackValue {
  const names = outcome.failed.map((f) => f.name).join(', ');
  if (outcome.failed.length && outcome.ok.length) {
    return { kind: 'error', message: fill(s.uploadPartial, { ok: outcome.ok.length, failed: outcome.failed.length, names }), detail: outcome.failed[0]!.error };
  }
  if (outcome.failed.length) {
    return { kind: 'error', message: fill(s.uploadFailed, { names }), detail: outcome.failed[0]!.error };
  }
  if (outcome.ok.length === 1) return { kind: 'success', message: fill(s.uploaded, { name: outcome.ok[0]! }), detail: dir };
  return { kind: 'success', message: fill(s.uploadedMany, { count: outcome.ok.length }), detail: dir };
}

/** `null` when the file may go to `path`; otherwise the reason it may not.
 * The limit is shown in MiB floored to two decimals, so it never claims more
 * than fits (about 59.99 MiB for an ordinary path). */
export function uploadSizeError(size: number, path: string, tooLarge: string): string | null {
  const max = maxUploadBytes(path);
  if (max !== null && Number.isFinite(size) && size >= 0 && size <= max) return null;
  return fill(tooLarge, { size: `${(Math.floor(((max ?? 0) / MIB) * 100) / 100).toFixed(2)} MiB` });
}
