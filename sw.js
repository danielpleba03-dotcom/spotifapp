const CACHE = 'spotifyp-web-v5-access';
const APP_PATH = '/spotifapp/';
const APP_URL = new URL(APP_PATH, self.location.origin);
const FILES = ['initial-access.css?v=1','initial-access.mjs?v=1','', 'index.html', 'style.css', 'app.js', 'core.js?v=20261120-fetch', 'config.js', 'manifest.webmanifest', 'assets/icon-192.png', 'assets/icon-512.png'];
const SHELL = FILES.map(file => new URL(file, APP_URL).href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('spotifyp-web-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(APP_PATH)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && !url.search) {
        try { await cache.put(event.request, response.clone()); } catch {}
      }
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await cache.match(new URL('index.html', APP_URL).href);
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
