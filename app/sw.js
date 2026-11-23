// Recto service worker: makes the app work offline.
//
// Strategy: every same-origin GET inside the app scope goes to the network first, so a new
// deploy is picked up without bumping VERSION. If the network fails, or takes more than
// NETWORK_TIMEOUT_MS, the cached copy is served instead. Successful responses refresh the
// cache, including responses that arrive after the timeout already fell back to the cache.
// After a timeout or a failure the network is considered unreliable for DEGRADED_MS: cached
// files are then served at once (the network is still asked in the background, to refresh the
// cache), so a stalled connection costs one timeout per startup, not one per level of imports.
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
  './js/back.js',
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
// Stalled connections (metro, weak cellular, Wi-Fi without internet) do not fail: they hang.
// Without this, each level of module imports would wait NETWORK_TIMEOUT_MS (about 4 × 3 s).
const DEGRADED_MS = 30000;
let degradedUntil = 0;
// Start time of the request that last changed degradedUntil: older news is ignored, so a request
// stuck since before the network recovered does not switch back to the degraded mode.
let networkNewsFrom = 0;
// Monotonic clock for these delays: a change of the phone's time must not affect them.
const now = self.performance && typeof self.performance.now === 'function' ? () => self.performance.now() : () => Date.now();
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

  const started = now();
  const network = fetchFromNetwork(request);
  // Registered before anything else reads `network`, so the clone is taken before the page
  // consumes the body (noteNetwork is synchronous). waitUntil keeps the worker alive until a
  // late response is stored, including while the page was answered from the cache.
  const cacheUpdate = network
    .then(
      (response) => {
        noteNetwork(started, now() - started < NETWORK_TIMEOUT_MS);
        return updateCache(request, response);
      },
      () => noteNetwork(started, false),
    )
    .catch(() => {});
  event.waitUntil(cacheUpdate);
  event.respondWith(respond(request, network, started));
});

/**
 * Records how a request that started at `started` went: a quick answer ends the degraded mode,
 * a timeout or a failure (re)starts it for DEGRADED_MS.
 */
function noteNetwork(started, healthy) {
  if (started < networkNewsFrom) return;
  networkNewsFrom = started;
  degradedUntil = healthy ? 0 : now() + DEGRADED_MS;
}

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

async function respond(request, network, started) {
  if (now() < degradedUntil) {
    // The network just proved unreliable: do not wait for it again (it refreshes the cache).
    const cached = await fromCache(request);
    if (cached) return cached;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, TIMED_OUT);
  });
  try {
    const result = await Promise.race([network, timeout]);
    if (result === TIMED_OUT) {
      // Slow network: answer from the cache if possible, otherwise keep waiting for the network.
      noteNetwork(started, false);
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
