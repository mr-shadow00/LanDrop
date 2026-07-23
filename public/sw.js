// public/sw.js
// Intentionally does no caching — LanDrop's whole point is live peers and
// live transfers, so a stale cache would do more harm than good. This file
// exists only so browsers recognize the app as installable.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
