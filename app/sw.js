// Recto service worker: makes the app work offline.
//
// Strategy: every same-origin GET inside the app scope goes to the network first, so a new
// deploy is picked up without bumping VERSION. If the network fails, or takes more than
// NETWORK_TIMEOUT_MS, the cached copy is served instead. Successful responses refresh the
// cache, including responses that arrive after the timeout already fell back to the cache.
//
// ASSETS must list every file of app/ except this one (checked by tests/unit/sw-assets.test.mjs).

const VERSION = 'recto-v1';
const CACHE_PREFIX = 'recto-';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './css/media.css',
  './js/app.js',
  './js/dom.js',
  './js/db.js',
  './js/srs.js',
  './js/selection.js',
  './js/importer.js',
  './js/format.js',
  './js/media.js',
  './js/util.js',
  './js/ui/components.js',
  './js/ui/data.js',
  './js/ui/editor.js',
  './js/ui/face.js',
  './js/ui/icons.js',
  './js/ui/library.js',
  './js/ui/method.js',
  './js/ui/methods.js',
  './js/ui/router.js',
  './js/ui/select.js',
  './js/ui/stats.js',
  './js/ui/study.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const NETWORK_TIMEOUT_MS = 3000;
const TIMED_OUT = Symbol('timed-out');
// App shell served for navigations when offline (hash routing: one page serves every screen).
const SHELL_URL = new URL('./index.html', self.location.href).href;

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only our own caches: on <user>.github.io several sites share the same origin.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== VERSION).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function precache() {
  const cache = await caches.open(VERSION);
  // `cache: 'reload'` bypasses the HTTP cache so the precache matches what is deployed right now.
  await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
}

/* ------------------------------------------------------------------ */
/* Fetch: network first, cache as fallback                             */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;
  // Partial content (media seeking) cannot be cached: leave it to the browser.
  if (request.headers.has('range')) return;

  const network = fetchFromNetwork(request);
  // Registered before anything else reads `network`, so the clone is taken before the page
  // consumes the body. waitUntil keeps the worker alive until a late response is stored.
  const cacheUpdate = network.then((response) => updateCache(request, response)).catch(() => {});
  event.waitUntil(cacheUpdate);
  event.respondWith(respond(request, network));
});

/** Fetch from the network, revalidating with the server rather than trusting the HTTP cache. */
function fetchFromNetwork(request) {
  let fresh = request;
  try {
    // GitHub Pages sends max-age=600: without this, a new deploy could be ignored for minutes.
    // Unchanged files only cost a 304.
    fresh = new Request(request, { cache: 'no-cache' });
  } catch {
    // Engine refused to copy the request (e.g. some navigations): use it as is.
  }
  const attempt = fetch(fresh);
  return fresh === request ? attempt : attempt.catch(() => fetch(request));
}

async function respond(request, network) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, TIMED_OUT);
  });
  try {
    const result = await Promise.race([network, timeout]);
    if (result === TIMED_OUT) {
      // Slow network: answer from the cache if possible, otherwise keep waiting for the network.
      return (await fromCache(request)) || (await network);
    }
    if (result.ok || result.type === 'opaqueredirect') return result;
    // 404/5xx (e.g. during a deploy): a cached copy is more useful than an error page.
    return (await fromCache(request)) || result;
  } catch {
    // Offline or network failure.
    return (await fromCache(request)) || offlineResponse();
  } finally {
    clearTimeout(timer);
  }
}

/** Stores a successful same-origin response. Must be called synchronously after it resolves. */
function updateCache(request, response) {
  if (!isCacheable(response)) return undefined;
  const copy = response.clone();
  return caches.open(VERSION).then((cache) => cache.put(cacheKey(request), copy));
}

/** Only complete, non-opaque, non-redirected 200 responses are cached (206/opaque/errors never). */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic' && !response.redirected;
}

/** Navigations are stored without their query string (the hash is never sent). */
function cacheKey(request) {
  if (request.mode !== 'navigate') return request;
  const url = new URL(request.url);
  url.search = '';
  return url.href;
}

async function fromCache(request) {
  try {
    const cache = await caches.open(VERSION);
    if (request.mode === 'navigate') {
      return (
        (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
        (await cache.match(SHELL_URL, { ignoreVary: true })) ||
        null
      );
    }
    return (await cache.match(request, { ignoreVary: true })) || null;
  } catch {
    return null;
  }
}

function offlineResponse() {
  return new Response('Hors ligne : ce contenu n’est pas disponible sans connexion.', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
