// Minimal service worker for PWA installability.
//
// Teammux is useless offline (it needs a live WebSocket server), so this
// SW deliberately does NOT cache assets — caching would only risk serving a
// stale build after an update. Its sole purpose is to satisfy the browser's
// "installable" criteria (a registered SW with a fetch handler) so the
// `beforeinstallprompt` event fires and the user can add the app to their
// home screen / app launcher.
//
// `skipWaiting` + `clients.claim` make a new SW take over immediately on
// update instead of waiting for all tabs to close, so we never get pinned to
// an old worker.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. We don't call respondWith(), so the browser
// handles every request normally over the network — but the handler's mere
// presence is what some Chromium versions check for installability.
self.addEventListener('fetch', () => {});
