// Orbit service worker — НАМЕРЕННО БЕЗ КЭШИРОВАНИЯ.
// Единственная цель этого файла — сделать сайт "устанавливаемым" как PWA
// (браузеры требуют наличие обработчика fetch у service worker для этого).
// Само приложение всё равно работает только при наличии интернета (WebRTC),
// поэтому офлайн-кэш почти бесполезен, а риск показать устаревшую версию —
// куда важнее избежать. Каждый запрос всегда идёт напрямую в сеть.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
