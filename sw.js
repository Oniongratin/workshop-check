const CACHE = 'changsin-checkme-v11';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './logo-original.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isAppCode = url.origin === location.origin && (url.pathname.endsWith('/') || /\.(html|js|webmanifest)$/.test(url.pathname));
  if (isAppCode) {
    event.respondWith(fetch(event.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match(event.request).then(r => r || caches.match('./index.html'))));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
