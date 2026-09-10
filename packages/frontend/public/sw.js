// A server administration console must not serve stale application entrypoints.
// Keep this worker to retire caches created by earlier releases safely.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('fleetdeck-cache-'))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// No fetch handler: HTML, API responses and assets use normal HTTP semantics.
