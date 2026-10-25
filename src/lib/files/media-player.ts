// The Files media player's rules (board #453), pure so they are tested
// without a media element. The player itself is files/MediaPlayer.svelte; the
// one new atom is ui/MediaRange.svelte.

/** `m:ss`, or `h:mm:ss` once the reference (the duration) reaches an hour.
 * Not a number, or negative: `--:--`. */
export function fmtTime(seconds: number, reference = seconds): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return Number.isFinite(reference) && reference >= 3600 ? `${h}:${two(m)}:${two(r)}` : `${Math.floor(s / 60)}:${two(r)}`;
}

export type Span = { start: number; end: number };

/** A TimeRanges as plain spans. */
export function spans(ranges: TimeRanges | null | undefined): Span[] {
  const out: Span[] = [];
  if (!ranges) return out;
  for (let i = 0; i < ranges.length; i++) out.push({ start: ranges.start(i), end: ranges.end(i) });
  return out;
}

/** Where a seek may go, or null when it may not go anywhere yet (#453 P1-A):
 * the duration when it is finite and positive, else the end of the seekable
 * ranges, else nothing (before metadata, NaN, 0, or Infinity with nothing
 * seekable). The BUFFERED ranges never limit it: a seek into a part not yet
 * loaded is the point of a seek bar. */
export function seekWindow(duration: number, seekable: Span[]): { lo: number; hi: number } | null {
  if (Number.isFinite(duration) && duration > 0) {
    return seekable.length ? { lo: Math.max(0, seekable[0]!.start), hi: Math.min(duration, seekable.at(-1)!.end) || duration } : { lo: 0, hi: duration };
  }
  if (seekable.length && seekable.at(-1)!.end > 0) return { lo: Math.max(0, seekable[0]!.start), hi: seekable.at(-1)!.end };
  return null;
}

/** Where a seek to `t` lands (#453 review P2): inside the window, and when
 * the seekable ranges have holes, at the NEAREST seekable point (a time in a
 * hole goes to the closer edge; a tie goes forward). No ranges known: the
 * window alone. Buffered ranges never enter here. */
export function clampTo(t: number, win: { lo: number; hi: number }, seekable: Span[] = []): number {
  const x = Math.min(win.hi, Math.max(win.lo, t));
  let best = x, gap = Infinity;
  for (const r of seekable) {
    const lo = Math.max(r.start, win.lo), hi = Math.min(r.end, win.hi);
    if (hi < lo) continue;
    if (x >= lo && x <= hi) return x;
    const near = x < lo ? lo : hi, d = Math.abs(near - x);
    if (d < gap || (d === gap && near > best)) { best = near; gap = d; }
  }
  return best;
}

/** Which third of the picture a tap landed in. */
export function third(x: number, width: number): 'left' | 'middle' | 'right' {
  if (!(width > 0)) return 'middle';
  return x < width / 3 ? 'left' : x > (2 * width) / 3 ? 'right' : 'middle';
}

/** A media error, classified (#453 P2): the file cannot play here (play and
 * the range are disabled), or a transient failure that another try may cure. */
export function errorKind(code: number | undefined): 'unplayable' | 'transient' {
  // MEDIA_ERR_ABORTED 1, MEDIA_ERR_NETWORK 2, MEDIA_ERR_DECODE 3, MEDIA_ERR_SRC_NOT_SUPPORTED 4.
  return code === 3 || code === 4 ? 'unplayable' : 'transient';
}

/** The host facts the two modes are offered on (#453 P2: separately). */
export type Host = { android: boolean; androidFullscreen: boolean };

/** Fullscreen of the player container (#454): the API must be there, and in
 * the Android app the native custom-view host must say it is installed —
 * Android's WebView reports `fullscreenEnabled` whether or not the app shows
 * the custom view, so there the API alone cannot decide. The macOS app turns
 * WebKit's fullscreen on (`macOSPrivateApi`), so there the API decides. */
export function canFullscreen(host: Host, doc: { fullscreenEnabled?: boolean }, el: { requestFullscreen?: unknown } | null): boolean {
  return (!host.android || host.androidFullscreen) && !!doc.fullscreenEnabled && typeof el?.requestFullscreen === 'function';
}

/** The event the Android host dispatches on `window` whenever its answer
 * flips (`FullscreenHost` in the app's Kotlin): ask again. */
export const ANDROID_FULLSCREEN_EVENT = 'androidfullscreenchange';

/** The Android host's answer (`FullscreenHost.available()` in the app's
 * Kotlin): false when the interface is missing or the call throws. */
export function androidFullscreen(win: { AndroidFullscreen?: { available?: () => unknown } }): boolean {
  try { return win.AndroidFullscreen?.available?.() === true; } catch { return false; }
}

/** Picture-in-picture: the API alone decides (no host rule). */
export function canPip(doc: { pictureInPictureEnabled?: boolean }, video: { requestPictureInPicture?: unknown; disablePictureInPicture?: boolean } | null): boolean {
  return !!doc.pictureInPictureEnabled && typeof video?.requestPictureInPicture === 'function' && !video.disablePictureInPicture;
}

export type Kind = 'play' | 'fullscreen' | 'pip' | 'seek';

/** The operation owner records (#453 P1-C, delta 3). Each kind keeps its
 * LATEST intent `{ gen, on }`; `on` is play / enter, `off` is pause / exit.
 * A request captures `{ life, gen }`. `life` ends on hide, eligibility loss,
 * a source change and destroy; ending it makes every kind's latest intent
 * `off` at a new gen. A callback is current only while both still match;
 * a stale one never starts anything and never undoes by element identity:
 * it re-asserts its kind's CURRENT intent (`settle`). */
export class Intents {
  life = 0;
  private latest: Record<Kind, { gen: number; on: boolean }> = {
    play: { gen: 0, on: false }, fullscreen: { gen: 0, on: false }, pip: { gen: 0, on: false }, seek: { gen: 0, on: false },
  };

  /** A new intent of `kind`; the ticket a request carries. */
  begin(kind: Kind, on: boolean): { kind: Kind; life: number; gen: number } {
    const g = this.latest[kind].gen + 1;
    this.latest[kind] = { gen: g, on };
    return { kind, life: this.life, gen: g };
  }

  current(t: { kind: Kind; life: number; gen: number }): boolean {
    return t.life === this.life && t.gen === this.latest[t.kind].gen;
  }

  /** What a STALE callback of `kind` must leave behind: `on` when a newer
   * request asked for the state (leave it alone), `off` otherwise. */
  wants(kind: Kind): boolean {
    return this.latest[kind].on;
  }

  /** End this life: every kind's latest intent becomes off. */
  endLife(): void {
    this.life++;
    for (const k of Object.keys(this.latest) as Kind[]) this.latest[k] = { gen: this.latest[k].gen + 1, on: false };
  }
}
