/* ============================================================================
   Choreo-Planer – Service Worker
   - App-Shell wird precached (Cache-First) -> UI öffnet auch offline.
   - CDN-Module (jsDelivr: Wavesurfer, Alpine, Supabase, Dexie) -> Stale-While-Revalidate.
   - Supabase REST/Storage -> Netz (kein SW-Cache; Audio liegt in IndexedDB/Dexie).
   ========================================================================== */

const SHELL_CACHE = 'choreo-shell-v1';
const CDN_CACHE = 'choreo-cdn-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== CDN_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase (REST / Auth / Storage) immer übers Netz – nie cachen.
  if (url.hostname.endsWith('.supabase.co')) return;

  // CDN-Module: Stale-While-Revalidate
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-Origin (App-Shell): Cache-First mit Netz-Fallback
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // sonst: Standardverhalten (Netz)
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && new URL(req.url).origin === self.location.origin) {
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // Navigationsanfragen offline -> App-Shell ausliefern
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  return cached || network || fetch(req);
}
