// Coquille hors ligne : l'application s'ouvre sans réseau. Les données, elles, sont gardées par
// l'application (cache des lectures, file des paiements), pas par ce service worker.
const SHELL = 'appgn-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // L'API n'est jamais servie par le cache du navigateur : l'application décide quoi garder.
  if (request.method !== 'GET' || url.pathname.includes('/v1/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(SHELL).then((cache) => cache.put(request, copy));
      return response;
    })));
  }
});
