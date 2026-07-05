/* ============================================================================
   Choreo-Planer – Service Worker
   WICHTIG: App-Shell läuft NETWORK-FIRST, damit neue Deploys sofort ankommen
   (online immer frisch, offline aus Cache). Cache-Name ist versioniert -> bei
   Version-Bump werden alte Caches gelöscht.
   - CDN-Module (jsDelivr) -> Stale-While-Revalidate.
   - Supabase REST/Storage -> Netz (kein SW-Cache; Audio liegt in IndexedDB/Dexie).
   ========================================================================== */

const VERSION = 'v30';
const SHELL_CACHE = `choreo-shell-${VERSION}`;
const CDN_CACHE = `choreo-cdn-${VERSION}`;

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
      .catch(() => self.skipWaiting())
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

  // CDN-Module: Stale-While-Revalidate (Versionspinning in der URL)
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-Origin (App-Shell): NETWORK-FIRST mit Cache-Fallback
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }
  // sonst: Standardverhalten (Netz)
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
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
