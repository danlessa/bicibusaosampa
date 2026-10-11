// Service worker of the PWA. Served at /sw.js by functions/sw.js.js, which replaces
// __VERSION__ with the deployed commit: every deploy is a new worker byte-for-byte, so
// the browser installs it and the page offers a reload (public/js/ui.js). Locally the
// version is "dev" and the worker caches nothing, so development never serves stale files.
//
// Caching, per kind of request:
// - The app shell and every static file of this deploy: cache-first, in a cache named
//   after the version. Static files only change with a deploy, which brings a new worker
//   and a new cache. They're fetched with ?v=<version>, so neither the browser nor
//   Cloudflare's edge hands back an older copy.
// - The trip planner's network (/data/routing/*, ~18 MB): kept across versions, served
//   from the cache and re-checked at most once a day with If-None-Match, so a phone
//   downloads it once instead of on every deploy.
// - /api/*, map tiles and other sites: straight to the network.

const VERSION = '__VERSION__';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'planner-data';
const DAY = 86400000;
const DEV = VERSION === 'dev';

const SHELL = [
  '/', '/style.css', '/manifest.webmanifest',
  '/icons/icon-32.png', '/icons/icon-192.png', '/icons/metro.svg', '/icons/cptm.svg',
  '/js/app.js', '/js/geocode.js', '/js/heading.js', '/js/live-trips.js', '/js/locate.js',
  '/js/offset.js', '/js/parking.js', '/js/planner.js', '/js/planner-worker.js', '/js/raptor.js',
  '/js/rail.js', '/js/schedule.js', '/js/streets.js', '/js/time.js', '/js/ui.js',
  '/vendor/leaflet-rotate/leaflet-rotate.js',
  '/data/rail-lines.json', '/data/bike-buses.json', '/data/rail.geojson', '/data/bus-routes.geojson',
];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

const versioned = (pathAndQuery) => pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'v=' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    if (!DEV) {
      const cache = await caches.open(SHELL_CACHE);
      const jobs = SHELL.map(async (path) => {
        const res = await fetch(versioned(path), { cache: 'reload' });
        if (res.ok) await cache.put(path, res);
      }).concat(CDN.map(async (url) => {
        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) await cache.put(url, res);
      }));
      await Promise.all(jobs.map((job) => job.catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function fromShell(req, key) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const url = new URL(req.url);
  const res = await fetch(url.origin === location.origin ? versioned(url.pathname + url.search) : req);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set('x-checked', String(Date.now()));
  return new Response(await res.blob(), { status: 200, headers });
}

async function plannerData(req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req);
  if (!hit) {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, await stamped(res.clone()));
    return res;
  }
  if (Date.now() - Number(hit.headers.get('x-checked') || 0) > DAY) {
    const etag = hit.headers.get('etag');
    fetch(req.url, { headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 304) await cache.put(req, await stamped(hit.clone()));
        else if (res.ok) await cache.put(req, await stamped(res));
      })
      .catch(() => {});
  }
  return hit;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (DEV || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    if (url.pathname.startsWith('/data/routing/')) return e.respondWith(plannerData(req));
    return e.respondWith(fromShell(req, req.mode === 'navigate' ? '/' : url.pathname + url.search));
  }
  if (CDN.includes(req.url)) e.respondWith(fromShell(req, req.url));
});
