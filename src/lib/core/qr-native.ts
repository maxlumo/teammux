// The Android scan (board #403, commit 3): the Tauri barcode-scanner plugin,
// which reads the camera natively (CameraX, with ML Kit through Google Play
// services) and draws the preview BEHIND the transparent webview. Everything
// else about a scan is shared with the browser path: this module only turns the
// plugin's calls into one outcome, and decodes nothing itself.
//
// The plugin is loaded on demand, so a build or a page that never scans never
// touches it, and a test hands in a fake.

export type NativeOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'denied' }       // the camera permission was refused: use the photo path
  | { kind: 'failed' };      // the plugin said no for any other reason

/** The part of the plugin this module uses. */
export interface ScannerPlugin {
  checkPermissions(): Promise<string>;
  requestPermissions(): Promise<string>;
  scan(options: { windowed: boolean; formats: string[] }): Promise<{ content: string }>;
  cancel(): Promise<void>;
  Format: { QRCode: string };
}

export interface NativeScan {
  /** Settles once: the text, or why there is none. */
  done: Promise<NativeOutcome>;
  /** Stops the camera. Safe to call at any time, and more than once. */
  cancel(): void;
}

const loadPlugin = (): Promise<ScannerPlugin> => import('@tauri-apps/plugin-barcode-scanner') as unknown as Promise<ScannerPlugin>;

/**
 * Ask for the camera if it is not yet granted, then scan for a QR code only,
 * windowed (the page is transparent and ours to draw on). `onlive` runs right
 * before the camera starts, so the caller makes its page transparent only when
 * there is a preview to show through it, never behind the permission prompt.
 */
export function startNativeScan(onlive: () => void, load: () => Promise<ScannerPlugin> = loadPlugin): NativeScan {
  let cancelled = false;
  let plugin: ScannerPlugin | null = null;
  let stop!: (outcome: NativeOutcome) => void;
  // The plugin's `scan()` never settles on a device with no camera, even after
  // `cancel()`: the person's Cancel must end the scan on its own, whatever the
  // plugin does.
  const stopped = new Promise<NativeOutcome>((resolve) => { stop = resolve; });
  const work = (async (): Promise<NativeOutcome> => {
    try {
      plugin = await load();
      let state = await plugin.checkPermissions();
      if (state !== 'granted') state = await plugin.requestPermissions();
      if (state !== 'granted') return { kind: 'denied' };
      if (cancelled) return { kind: 'cancelled' };
      onlive();
      const scanned = await plugin.scan({ windowed: true, formats: [plugin.Format.QRCode] });
      return typeof scanned?.content === 'string' && scanned.content !== '' ? { kind: 'text', text: scanned.content } : { kind: 'failed' };
    } catch {
      return cancelled ? { kind: 'cancelled' } : { kind: 'failed' };
    }
  })();
  return {
    done: Promise.race([work, stopped]),
    cancel() {
      if (cancelled) return;
      cancelled = true;
      plugin?.cancel().catch(() => {});
      stop({ kind: 'cancelled' });
    },
  };
}
