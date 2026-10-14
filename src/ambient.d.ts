// App-wide ambient globals. The ONE place window augmentations live —
// don't re-declare these per-module.
export {};

declare global {
  interface Window {
    /** Present inside the Tauri shell (desktop/Android), absent in browsers. */
    __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> } };
    __TAURI_INTERNALS__?: unknown;
  }

  /** Vite `define`s (vite.config.js): the UI's own build identity and licence.
   *  Undefined where nothing ran Vite (node --test); read through
   *  core/build-info.ts, never directly. */
  const __TMM_BUILD__: { version: string; commit: string; built: string; devServer?: boolean } | undefined;
  const __TMM_LICENSE__: string | undefined;

  interface ImportMetaEnv {
    readonly DEV: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
