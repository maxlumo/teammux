# PWA Install Offer (web only)

## Context
The web UI (Vite + Svelte, served over a browser — Tailscale HTTPS, a reverse
proxy, or `npm run preview`) is a long-lived companion screen. Browsers can
"install" such a page as a standalone app (own window, home-screen icon, no
URL bar). We surface that offer in-app instead of leaving it to the browser's
easily-missed mini-infobar. The Tauri desktop/Android shells are already
native apps, so this is strictly a **browser-context** feature.

## Decision
Minimal hand-rolled PWA (no `vite-plugin-pwa` dependency): a static manifest +
a no-op service worker satisfy installability, and a small Svelte banner
(`InstallPrompt.svelte`) drives the offer. No offline caching.

## Pieces
| File | Role |
|------|------|
| `public/manifest.webmanifest` | App metadata + icons (192/512 `any`, 512 `maskable`). `display: standalone`, theme/background `#0a0a0f` (dark bg). **No `orientation` member** — see below. |
| `public/sw.js` | Service worker registered **only** to make the page installable. Network-passthrough `fetch` handler (no `respondWith`) — present purely because some Chromium versions gate installability on a fetch handler. `skipWaiting` + `clients.claim` so updates take over immediately. |
| `public/pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png` | Generated from `src-tauri/icons/icon.png` (1024²) via `sips`. The maskable one scales the glyph to ~72% over an opaque black field so it survives Android's circular mask (the source icon has transparent rounded corners — unusable as maskable directly). |
| `index.html` | `<link rel="manifest">` + `theme-color` + `apple-*` tags (iOS "Add to Home Screen" reads these; there's no JS install API on iOS). |
| `src/main.ts` | Registers `/sw.js` — gated on `!isTauri && 'serviceWorker' in navigator && window.isSecureContext`. |
| `src/lib/ui/InstallPrompt.svelte` | The banner. Mounted once in `App.svelte`. |

## Why the manifest has no `orientation`
The installed PWA must follow the phone's own auto-rotate switch, like every
native app does. Chromium maps manifest `orientation: "any"` to Android's
`SCREEN_ORIENTATION_FULL_SENSOR`, which rotates with the sensor even when the
user has rotation locked — so the app kept turning while the rest of the phone
stayed put (owner report, 2026-09-03). Leaving the member out yields
`UNSPECIFIED`, which honours the system lock. The Tauri Android shell sets no
`android:screenOrientation` for the same reason. Never add `"orientation"`
back to the manifest, and do not call `screen.orientation.lock()`.

## Why no offline caching
tmux-mobile is useless without a live WebSocket server — there's nothing
meaningful to serve offline. A caching SW would only add risk: serving a stale
build after deploy. So the SW deliberately caches nothing; it exists solely for
the installability signal.

## InstallPrompt behavior
Two paths, because install APIs differ by engine:
- **Chromium (Chrome/Edge/Android/Samsung):** the browser fires
  `beforeinstallprompt`; we `preventDefault()` it, stash the event, show our
  banner, and call the stashed event's `prompt()` when the user taps Install.
- **iOS Safari:** no programmatic API exists. We detect iOS Safari (UA, with
  the iPadOS-masquerades-as-Mac touch check) and show "Share → Add to Home
  Screen" instructions after a short delay. In-app browsers / CriOS / FxiOS are
  excluded (only Safari can add to home screen on iOS).

Suppression rules (never nag):
- Hidden inside Tauri (`__TAURI__`/`__TAURI_INTERNALS__`).
- Hidden when already running standalone (`display-mode: standalone` /
  `navigator.standalone`).
- Dismissal is remembered in `localStorage` (`tmux_pwa_dismissed`) for a 14-day
  cooldown. `appinstalled` clears it.

## The banner never covers the page's primary action (board #387, 2026-10-15)
Found by the validator while checking #381: at interface scale 150-180%, and
in the CSS viewports browser zoom 200% leaves (195x422, 260x563), the fixed
banner sat on the connect page's Connect / Share, and on narrow windows its
actions stuck 22-36 px out past the edge. The cause was the banner's own
layout: the actions were a fixed column beside the text, so a narrow banner
squeezed the description to one word per line (12 lines, up to 400 px tall)
and pushed the actions out.

- **It fits the window.** The width stays `min(440px, 100vw / --ui-zoom -
  24px)` with `box-sizing: border-box`, and the content WRAPS: the text stays
  beside the icon with a readable measure (`flex: 1 1 0`, `min-width: 9em`,
  `overflow-wrap: anywhere`) and the actions are what move to their own line,
  at the end (`margin-left: auto`).
- **The page reserves its space.** While the banner shows, `InstallPrompt`
  publishes the space it takes on the root as `--install-reserve`: its
  `offsetHeight` plus its computed `bottom` (its own 12 px plus `--sab`),
  both layout values in the root zoom's units, MEASURED from the banner's box
  and re-read by a `ResizeObserver` when it reflows; removed when the banner
  goes. No constant stands for the banner's height. The connect page's
  scroller ends above it (`margin-bottom: var(--install-reserve, 0px)` on
  Settings' `.wrapper`), so Connect and Share scroll into view clear of it.
  Other pages do not reserve: the banner shows on first run, where the
  connect page is what is on screen.
- Measured in Chromium (the #381 matrix plus the small viewports, a synthetic
  `beforeinstallprompt`): before, Connect/Share were under the banner in 9 of
  12 cells and it overhung by 24-36 px in 3; after, no overhang in any cell
  and both buttons reachable and free in all 12. The reserve the browser
  reported was 87 px on desktop and 128-196 px on a phone, which is the
  measured value, not a number in the code. Where the banner is narrowest
  (390x560 at 180%, about 190 CSS px wide) the icon takes its own line too;
  the text still keeps its measure and the page still ends above it. Pinned by
  `InstallPrompt.source.test.ts` (sizing, wrap, measured reserve, the page
  rule) and `InstallPrompt.mount.test.ts` (the reserve appears with the
  banner and goes when it is dismissed).

## Gotchas / constraints
- **HTTPS required.** Service workers + `beforeinstallprompt` only work on
  secure origins (https or `localhost`). Plain `http://<LAN-ip>:5173` (the
  default dev/preview path over LAN) is **not** a secure context, so the offer
  won't appear there — this is expected, not a bug. The intended install path
  is the Tailscale HTTPS serve (see README) or any TLS reverse proxy.
- **iOS timing.** The iOS banner is delayed ~2.5 s so it doesn't collide with
  first paint / the connect screen.
- Icons are committed PNGs (regenerate with `sips` from `src-tauri/icons/icon.png`
  if the brand icon changes).
