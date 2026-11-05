// Upload feedback (board #214, owner 2026-09-20: "文件上传要有个进度或者提示，
// 让我知道传上去了没有"). Since board #23 a file goes over the HTTP upload
// channel in chunks (http-upload.ts), and the server says after each one how
// many bytes it holds: the line shows those bytes of the total, and the
// percentage. `uploaded` is the last chunk's commit, never a send returning.

import type { FeedbackValue } from '../ui/feedback-lifetime.ts';

export interface UploadStep {
  name: string;
  /** 1-based position in the batch. */
  index: number;
  total: number;
  /** Bytes of THIS file the server holds. */
  sent: number;
  size: number;
}

export interface UploadOutcome {
  ok: string[];
  failed: { name: string; error: string }[];
}

export interface UploadStrings {
  uploading: string;      // 'Uploading {name} ({index}/{total})'
  uploadBytes: string;    // '{sent} of {size}'
  uploaded: string;       // 'Uploaded {name}'
  uploadedMany: string;   // 'Uploaded {count} files'
  uploadFailed: string;   // 'Upload failed: {names}'
  uploadPartial: string;  // '{ok} uploaded, {failed} failed: {names}'
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

/** The in-flight line: bytes the server holds of the total, and the target
 * directory. The percentage is `progress`, which OperationFeedback draws as
 * its bar and its one percent label: a second one here disagreed with it by
 * rounding (70% vs 71%, the #23 live run). `size` formats a byte count the
 * way the page does. */
export function uploadProgress(step: UploadStep, dir: string, s: UploadStrings, size: (n: number) => string): FeedbackValue {
  const message = fill(s.uploading, { name: step.name, index: step.index, total: step.total });
  const pct = step.size > 0 ? Math.min(100, (step.sent / step.size) * 100) : 100;
  const bytes = fill(s.uploadBytes, { sent: size(Math.min(step.sent, step.size)), size: size(step.size) });
  return { kind: 'progress', message, detail: `${bytes} · ${dir}`, progress: pct };
}

/** The closing line. Any failure names the files that failed (owner: know
 * WHICH one did not land); a clean batch says how many landed. */
export function uploadSummary(outcome: UploadOutcome, dir: string, s: UploadStrings): FeedbackValue {
  const names = outcome.failed.map((f) => f.name).join(', ');
  if (outcome.failed.length && outcome.ok.length) {
    return { kind: 'error', message: fill(s.uploadPartial, { ok: outcome.ok.length, failed: outcome.failed.length, names }), detail: `${outcome.failed[0]!.name}: ${outcome.failed[0]!.error}` };
  }
  if (outcome.failed.length) {
    return { kind: 'error', message: fill(s.uploadFailed, { names }), detail: `${outcome.failed[0]!.name}: ${outcome.failed[0]!.error}` };
  }
  if (outcome.ok.length === 1) return { kind: 'success', message: fill(s.uploaded, { name: outcome.ok[0]! }), detail: dir };
  return { kind: 'success', message: fill(s.uploadedMany, { count: outcome.ok.length }), detail: dir };
}
