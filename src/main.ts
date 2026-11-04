import '@xterm/xterm/css/xterm.css';
// The ONE UI face, self-hosted (bundled by Vite into dist/ — a CDN <link>
// would go dark exactly where this app lives: the APK offline, a LAN box
// behind no internet). Variable weights make the 550/650 mid-weights the
// design system already asks for render TRUE instead of snapping to 500/700.
import '@fontsource-variable/inter';
// The DISPLAY face for the identity layer only — titles, brand, names
// (--font-display). Space Grotesk: grown out of Space Mono, so it carries
// the terminal's genes into a real display sans (owner, 2026-08-25:
// "标题 名称等特殊 字体可以更特别一点").
import '@fontsource-variable/space-grotesk';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { isTauri } from './lib/core/platform.ts';

// Text fonts come from the system (see the font-strategy comment in
// index.html); only two symbol fonts are bundled in public/fonts/ and
// declared via @font-face there. The browser loads each woff2 lazily when
// the CSS first references its family, so there's nothing to do here.

const app = mount(App, { target: document.getElementById('app')! });

// PWA: register the service worker so the browser treats the web UI as
// installable (enables the `beforeinstallprompt` offer surfaced by
// InstallPrompt.svelte). Skipped inside the Tauri shell — it's already a
// native app — and only on secure origins (https / localhost), which the
// Service Worker API requires.
if (!isTauri && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

export default app;
