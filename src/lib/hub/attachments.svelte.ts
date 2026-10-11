// The ONE attachment pipeline (board #25, #329): paste or pick → stage →
// upload under <ws>/.tmm/uploads/ → a `[img:n]` / `[file:n]` token at the
// caret → the token swapped for the real ref when the text is saved
// (`attachmentBody`, hub-composer.ts). The chat Composer and the Board's
// editors each own one stager; the code — downscale, encode, upload, the
// staleness guard, the failed chip — exists once, here. Moved out of
// Hub.svelte unchanged (board #329); the history of each rule stays with it.
import type { WsApi } from '../core/ws.ts';
import { t } from '../core/i18n.svelte.ts';
import { imageId, uploadImagePath, uploadFilePath, pastedFiles, textIsThePaste } from './hub.ts';
import { attachToken, attachmentBody } from './hub-composer.ts';

// ── Attach an image (owner, 2026-08-26: "我发送图片时可以有一个小的+按钮，
// 上传到项目下…创建临时目录，随机图片 id，并且转 webp…限制一下原图"). The
// picked image is downscaled CLIENT-side to the models' effective ceiling —
// Claude reads best at ≤1568px on the long edge and GPT caps at 2048, so
// 1568 serves both and a 12 MB phone photo becomes a ~100 KB webp before it
// crosses the wire. Encoding prefers webp; WebKit cannot ENCODE webp, so the
// blob's own type decides the extension (jpeg there). The upload lands in
// <ws>/.tmm/uploads/ via the same fs_upload the file browser uses, and the
// text gains a `![](path)` at save time — an image is a reference, never
// bytes, and every surface renders it through ChatImage.
export const IMG_EDGE = 1568;
export const FILE_CAP = 32 * 1024 * 1024; // base64 over one RPC; beyond this, point the agent at the original path instead

/** A staged attachment. A FAILED one is a chip too (review, 2026-09-03: an
 * oversized file or a failed upload only console.warned, so the user could
 * not tell what the message would carry): no path, no token, no number —
 * rendered in the error state with its reason, removable, and it BLOCKS
 * save until removed. Nothing about an attachment is ever silent. `key` is
 * the each-key: a path for a staged one, a fresh id for a failed one (two
 * failures of the same file are two chips). `n` is the token number the
 * text carries at the INSERTION POINT (owner, 2026-08-26: "要让我能够看到图
 * 片插入的相对位置在哪里"); `thumb` an object URL for a picked image. */
export type Attachment = { key: string; path: string; kind: 'image' | 'file'; name: string; n: number; thumb: string; error?: string };

export type StagerHost = {
  /** The RPCs the uploads go through, the host's own server's (board #335
   * ②b-3). A module, not a component: it has no context to read, so its
   * host hands it the api it read at init. */
  api: Pick<WsApi, 'fsMkdir' | 'fsUpload'>;
  /** The project directory uploads land under (none: nothing stages). */
  ws: () => string | null | undefined;
  getText: () => string;
  setText: (text: string) => void;
  /** Where the tokens land: the caret's last position, else the end. */
  caret?: () => number | null | undefined;
  focus?: () => void;
};

async function encodeImage(file: File): Promise<{ b64: string; ext: string }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, IMG_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.85));
  const out = blob?.type === 'image/webp' ? blob
    : await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!out) throw new Error('encode failed');
  return { b64: toB64(new Uint8Array(await out.arrayBuffer())), ext: out.type === 'image/webp' ? 'webp' : 'jpg' };
}

// Chunked, never one big spread (Key Patterns: base64 large data).
function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

const errText = (err: unknown) => String((err as Error)?.message ?? err ?? '');

/** Paste and picker share one route into a stager. Office image renderings
 * beside real text remain native text pastes, not duplicate attachments. */
export function attachPaste(e: ClipboardEvent, stage: (files: File[]) => unknown): void {
  const files = pastedFiles(e.clipboardData);
  if (!files.length) return;
  if (textIsThePaste(e.clipboardData?.getData('text/plain'), files)) return;
  e.preventDefault();
  stage(files);
}

export function createStager(host: StagerHost) {
  const { fsMkdir, fsUpload } = host.api;
  // The staged set's generation: bumped whenever it is invalidated (project
  // switch, explicit clear). An async stage job snapshots it at entry and
  // refuses to touch the staged set or the text once stale — without this,
  // an upload finishing AFTER a project switch refilled the NEW room's
  // composer with the OLD room's attachment (lead review, board #25).
  let attachGen = $state(0);
  // In-flight stage jobs, each remembering the GENERATION it belongs to. A
  // list and not a flag (paste + picker overlap; a flag dropped the gate when
  // the first job finished), and per-generation so `attaching` answers for
  // the set on screen: a stale job neither holds the new set closed nor —
  // via its finally — unlocks a job the new set started, because every job
  // adds and removes only its OWN entry (lead review, board #25).
  let jobGens = $state<number[]>([]);
  let pending = $state<Attachment[]>([]);
  let attachSeq = 1;
  const failedAttachment = (f: File, error: string): Attachment => ({
    key: `err-${imageId()}`, path: '', kind: f.type?.startsWith('image/') ? 'image' : 'file',
    name: f.name, n: 0, thumb: '', error,
  });

  return {
    get pending() { return pending; },
    set pending(v: Attachment[]) { pending = v; },
    get attaching() { return jobGens.includes(attachGen); },
    /** A failed chip is not content, and while one is staged nothing saves. */
    get failed() { return pending.some((a) => a.error); },
    /** Text or at least one good attachment. */
    sendable(text: string) { return !!text.trim() || pending.some((a) => !a.error); },
    /** `raw` with every token swapped for its ref, in place. */
    body(raw: string) { return attachmentBody(raw, pending); },
    /** The numbering restarts once a set has been delivered. */
    resetSeq() { attachSeq = 1; },

    remove(i: number) {
      const a = pending[i];
      if (!a) return;
      if (a.n) {
        const tok = attachToken(a);
        // Strip the token (and one adjacent space) wherever the user left it.
        host.setText(host.getText().replace(new RegExp(`\\s?${tok.replace(/[[\]]/g, '\\$&')}`), ''));
      }
      if (a.thumb) URL.revokeObjectURL(a.thumb);
      pending = pending.filter((_, j) => j !== i);
      if (!pending.length) attachSeq = 1;
    },

    clear() {
      attachGen++; // any in-flight stage job is now stale — it must not refill
      for (const a of pending) if (a.thumb) URL.revokeObjectURL(a.thumb);
      pending = [];
      attachSeq = 1;
    },

    async stage(files: File[]) {
      const ws = host.ws();
      if (!ws || !files.length) return;
      // The file dialog blurs the box but the selection survives; a paste's
      // caret is live.
      let at = host.caret?.() ?? host.getText().length;
      // Generation snapshot: every await below is a chance for the user to
      // switch context (clear() bumps the gen). A stale job may still finish
      // its upload — a harmless orphan in .tmm/uploads — but must never touch
      // the staged set, the text or the sequence counter again.
      const gen = attachGen;
      const stale = () => gen !== attachGen;
      jobGens = [...jobGens, gen];
      try {
        await fsMkdir(`${ws}/.tmm/uploads`); // create_dir_all — idempotent
        if (stale()) return;
        // Self-gitignored like the other .tmm runtime dirs — an attachment
        // must never show up in the project's `git status`.
        await fsUpload(`${ws}/.tmm/uploads/.gitignore`, btoa('*\n'));
        if (stale()) return;
        for (const f of files) {
          let item: Attachment;
          // Per FILE: one bad file must not take the others down with it, and
          // its failure must land as a chip the user can see and remove.
          try {
            if (f.type.startsWith('image/')) {
              // Images are re-encoded (webp, capped long edge).
              const { b64, ext } = await encodeImage(f);
              if (stale()) return;
              const path = uploadImagePath(ws, imageId(), ext);
              await fsUpload(path, b64);
              if (stale()) return;
              item = { key: path, path, kind: 'image', name: f.name, n: attachSeq++, thumb: URL.createObjectURL(f) };
            } else {
              // Everything else lands BYTE-IDENTICAL under its own name.
              if (f.size > FILE_CAP) {
                // No await since the last check, so the verdict still holds.
                pending = [...pending, failedAttachment(f, t('hubAttachTooLarge').replace('{mb}', String(FILE_CAP / 1024 / 1024)))];
                continue;
              }
              const b64 = toB64(new Uint8Array(await f.arrayBuffer()));
              if (stale()) return;
              const path = uploadFilePath(ws, imageId(), f.name);
              await fsUpload(path, b64);
              if (stale()) return;
              item = { key: path, path, kind: 'file', name: f.name, n: attachSeq++, thumb: '' };
            }
          } catch (err) {
            // The throw came out of an await, so the context may have changed
            // under it: a guard, not a return — the loop goes on.
            if (!stale()) pending = [...pending, failedAttachment(f, t('hubAttachFailed').replace('{err}', errText(err)))];
            continue;
          }
          // No await between the last check and these mutations — the commit
          // is atomic with the verdict that this job's set is still on screen.
          pending = [...pending, item];
          // The visible position marker, at the caret.
          const tok = attachToken(item);
          const text = host.getText();
          const pre = text.slice(0, at), post = text.slice(at);
          const sep = pre && !/\s$/.test(pre) ? ' ' : '';
          host.setText(`${pre}${sep}${tok}${post}`);
          at += sep.length + tok.length;
        }
        if (!stale()) host.focus?.(); // never the editor of a context that replaced this one
      } catch (err) {
        // The uploads dir itself could not be prepared: every file of this job
        // failed, and each says so as a chip (same staleness guard as above).
        if (!stale()) pending = [...pending, ...files.map((f) => failedAttachment(f, t('hubAttachFailed').replace('{err}', errText(err))))];
      } finally {
        // Remove exactly THIS job's entry — never a blanket reset.
        const i = jobGens.indexOf(gen);
        if (i >= 0) jobGens = [...jobGens.slice(0, i), ...jobGens.slice(i + 1)];
      }
    },
  };
}

export type Stager = ReturnType<typeof createStager>;
