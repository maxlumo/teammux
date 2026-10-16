// Reading a connection QR code in the browser and the PWA (board #403): a live
// camera, or a photo. One decoder (`qr/decode.js`, the same library that draws
// the code), no native BarcodeDetector branch. Nothing here logs, stores or
// uploads a frame or what it decodes: the text goes to the caller and nowhere
// else, and the caller treats it as a secret (it is a connection link).
import decodeQR from 'qr/decode.js';

/** Raw RGBA pixels, the shape of a canvas ImageData. */
export interface Frame { width: number; height: number; data: Uint8ClampedArray }

/** Why the camera could not be used: the page is not a secure context (the
 * camera needs https or localhost), there is no camera, access was refused, or
 * something else went wrong. */
export type CameraFailure = 'insecure' | 'none' | 'denied' | 'failed';
export class CameraError extends Error {
  readonly reason: CameraFailure;
  constructor(reason: CameraFailure) { super(reason); this.reason = reason; }
}

export interface Camera {
  /** The text of a code in the current frame, or null. Cheap enough to call per animation frame. */
  readFrame(): string | null;
  /** Release the camera. */
  stop(): void;
}

/** One decode attempt: the code's text, or null when the frame holds none.
 * A photo gets the thorough setting, a live frame the quick one. */
export function decodeFrame(frame: Frame, photo = false): string | null {
  try {
    const text = decodeQR(frame, photo ? { effort: Infinity, timeLimit: Infinity } : {});
    return text || null;
  } catch { return null; }
}

/** The longest side a live frame is decoded at: a code fills the frame it is
 * held to, and a smaller frame is faster. */
const LIVE_SIDE = 720;

function failureOf(error: unknown): CameraFailure {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'none';
  return 'failed';
}

/** Open the rear camera into `video` and return a frame reader. Rejects with a
 * `CameraError` saying why it could not. */
export async function openCamera(video: HTMLVideoElement): Promise<Camera> {
  if (typeof window === 'undefined' || !window.isSecureContext) throw new CameraError('insecure');
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) throw new CameraError('none');
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (error) { throw new CameraError(failureOf(error)); }
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    readFrame() {
      if (!context || !video.videoWidth || !video.videoHeight) return null;
      const scale = Math.min(1, LIVE_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { width, height, data } = context.getImageData(0, 0, canvas.width, canvas.height);
      return decodeFrame({ width, height, data });
    },
    stop() {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}

/** The pixels of an image file, at most `PHOTO_SIDE` on its longest side. */
const PHOTO_SIDE = 2000;
async function fileToFrame(file: Blob): Promise<Frame> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no canvas');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const { width, height, data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width, height, data };
}

/** The text of the code in a photo, or null when there is none or the file is
 * not an image. Works on a plain-http page, and needs no camera permission. */
export async function decodePhoto(file: Blob, toFrame: (file: Blob) => Promise<Frame> = fileToFrame): Promise<string | null> {
  try { return decodeFrame(await toFrame(file), true); } catch { return null; }
}
