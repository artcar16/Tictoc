// Fetch strategy of the service worker (app/sw.js) on a bad connection, with a fake clock,
// fake network and fake Cache API. A stalled connection (metro, Wi-Fi without internet) does not
// fail, it hangs: the app must pay the network timeout once per startup, not once per level of
// module imports, and go back to network-first as soon as the network answers quickly again.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SW_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'sw.js'), 'utf8');
const SCOPE = 'https://example.test/app/';
const TIMEOUT = 3000;
const DEGRADED = 30000;

/** Lets pending promise callbacks (and their follow-ups) run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Loads sw.js with a controllable clock, network and cache. */
function loadWorker() {
  let now = 1_000_000;
  let timers = [];
  const clock = {
    now: () => now,
    /** Moves time forward, firing due timers in order. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn(...next.args);
        await flush();
      }
      now = end;
      await flush();
    },
  };
  let timerId = 0;
  const fakeSetTimeout = (fn, ms, ...args) => {
    const id = ++timerId;
    timers.push({ id, at: now + ms, fn, args });
    return id;
  };
  const fakeClearTimeout = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };

  // Network: every fetch stays pending until the test settles it.
  const fetches = [];
  const fakeFetch = (request) =>
    new Promise((resolve, reject) => {
      fetches.push({ url: request.url, resolve, reject });
    });

  // Cache API: one cache, keyed by URL.
  const store = new Map();
  const cache = {
    async match(request) {
      return store.get(typeof request === 'string' ? request : request.url) || undefined;
    },
    async put(request, response) {
      store.set(typeof request === 'string' ? request : request.url, response);
    },
    async addAll() {},
  };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };

  class FakeResponse {
    constructor(body, { status = 200, label = body } = {}) {
      this.body = body;
      this.label = label;
      this.status = status;
      this.ok = status >= 200 && status < 300;
      this.type = 'basic';
      this.redirected = false;
    }
    clone() {
      return new FakeResponse(this.body, { status: this.status, label: this.label });
    }
  }
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }

  const listeners = {};
  const sandbox = {
    URL,
    Date: FakeDate,
    Request: class {
      constructor() {
        throw new TypeError('not copyable'); // fetchFromNetwork then uses the request as is
      }
    },
    Response: FakeResponse,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    fetch: fakeFetch,
    caches,
    self: {
      location: { href: `${SCOPE}sw.js`, origin: 'https://example.test' },
      registration: { scope: SCOPE },
      performance: { now: () => now - 999_000 }, // monotonic clock of the worker
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' });

  /** Dispatches a fetch event; returns a handle on what the page receives. */
  function request(path, { mode = 'no-cors' } = {}) {
    const req = { method: 'GET', url: new URL(path, SCOPE).href, mode, headers: { has: () => false } };
    const handle = { settled: false, response: undefined, error: undefined, waitUntil: [] };
    listeners.fetch({
      request: req,
      respondWith(promise) {
        Promise.resolve(promise).then(
          (response) => Object.assign(handle, { settled: true, response }),
          (error) => Object.assign(handle, { settled: true, error }),
        );
      },
      waitUntil(promise) {
        handle.waitUntil.push(promise);
      },
    });
    handle.fetch = fetches[fetches.length - 1];
    return handle;
  }

  const seed = (path, label) => store.set(new URL(path, SCOPE).href, new FakeResponse(label));
  const cached = (path) => store.get(new URL(path, SCOPE).href)?.label;
  return { clock, request, seed, cached, fetches, Response: FakeResponse };
}

test('healthy network: the network answer is served and refreshes the cache', async () => {
  const sw = loadWorker();
  sw.seed('js/app.js', 'old');
  const r = sw.request('js/app.js');
  await sw.clock.advance(50);
  r.fetch.resolve(new sw.Response('new'));
  await flush();
  assert.equal(r.response.label, 'new');
  assert.equal(sw.cached('js/app.js'), 'new');
});

test('stalled network: only the first request waits for the timeout, later ones come from the cache at once', async () => {
  const sw = loadWorker();
  for (const path of ['', 'js/app.js', 'js/ui/data.js', 'js/db.js']) sw.seed(path, `cached ${path}`);

  const nav = sw.request('', { mode: 'navigate' });
  await sw.clock.advance(TIMEOUT - 1);
  assert.equal(nav.settled, false, 'network-first: waits for the network up to the timeout');
  await sw.clock.advance(1);
  assert.equal(nav.response.label, 'cached ', 'cache after the timeout');

  // Next import levels: answered without waiting, while the network is still asked.
  for (const path of ['js/app.js', 'js/ui/data.js', 'js/db.js']) {
    const fetchesBefore = sw.fetches.length;
    const r = sw.request(path);
    await flush();
    assert.equal(r.settled, true, `${path} must not wait for a stalled network`);
    assert.equal(r.response.label, `cached ${path}`);
    assert.equal(sw.fetches.length, fetchesBefore + 1, `${path}: the network is still asked (cache refresh)`);
  }

  // A late answer still refreshes the cache.
  sw.fetches[1].resolve(new sw.Response('fresh app.js'));
  await flush();
  assert.equal(sw.cached('js/app.js'), 'fresh app.js');
});

test('stalled network: a file missing from the cache still waits for the network', async () => {
  const sw = loadWorker();
  sw.seed('', 'shell');
  sw.request('', { mode: 'navigate' });
  await sw.clock.advance(TIMEOUT);
  const r = sw.request('js/new-module.js');
  await sw.clock.advance(TIMEOUT + 100);
  assert.equal(r.settled, false, 'nothing cached: keeps waiting for the network');
  r.fetch.resolve(new sw.Response('late'));
  await flush();
  assert.equal(r.response.label, 'late');
});

test('a quick answer ends the degraded mode (network-first again, a new deploy is picked up)', async () => {
  const sw = loadWorker();
  sw.seed('', 'shell v1');
  sw.seed('js/app.js', 'app v1');
  sw.request('', { mode: 'navigate' });
  await sw.clock.advance(TIMEOUT); // degraded

  const a = sw.request('js/app.js');
  await flush();
  assert.equal(a.response.label, 'app v1', 'degraded: from the cache');
  await sw.clock.advance(100);
  a.fetch.resolve(new sw.Response('app v2')); // quick answer in the background
  await flush();

  // Network-first again: a fresh answer wins over the cache.
  const nav = sw.request('', { mode: 'navigate' });
  await flush();
  assert.equal(nav.settled, false, 'no longer answered from the cache at once');
  nav.fetch.resolve(new sw.Response('shell v2'));
  await flush();
  assert.equal(nav.response.label, 'shell v2');
});

test('the degraded mode expires, and an old request answering late does not restart it', async () => {
  const sw = loadWorker();
  sw.seed('', 'shell');
  sw.seed('js/app.js', 'app');
  const stuck = sw.request('', { mode: 'navigate' });
  await sw.clock.advance(TIMEOUT); // degraded for DEGRADED_MS
  assert.equal(stuck.response.label, 'shell');

  await sw.clock.advance(DEGRADED); // expired: network-first again
  const b = sw.request('js/app.js');
  await flush();
  assert.equal(b.settled, false, 'after DEGRADED_MS the network is tried first again');
  b.fetch.resolve(new sw.Response('app 2'));
  await flush();
  assert.equal(b.response.label, 'app 2');

  // The request stuck since before finally fails: old news, the network is fine now.
  stuck.fetch.reject(new TypeError('Failed to fetch'));
  await flush();
  const c = sw.request('js/app.js');
  await flush();
  assert.equal(c.settled, false, 'still network-first');
  c.fetch.resolve(new sw.Response('app 3'));
  await flush();
  assert.equal(c.response.label, 'app 3');
});

test('a network failure falls back to the cache and skips the wait for the next requests', async () => {
  const sw = loadWorker();
  sw.seed('', 'shell');
  sw.seed('js/app.js', 'app');
  const nav = sw.request('', { mode: 'navigate' });
  nav.fetch.reject(new TypeError('Failed to fetch'));
  await flush();
  assert.equal(nav.response.label, 'shell');
  const r = sw.request('js/app.js');
  await flush();
  assert.equal(r.response.label, 'app', 'answered from the cache without waiting');
});

test('an answer slower than the timeout keeps the degraded mode', async () => {
  const sw = loadWorker();
  sw.seed('', 'shell');
  sw.seed('js/app.js', 'app');
  const nav = sw.request('', { mode: 'navigate' });
  await sw.clock.advance(TIMEOUT + 500);
  nav.fetch.resolve(new sw.Response('slow shell')); // arrives after 3.5 s
  await flush();
  assert.equal(sw.cached(''), 'slow shell', 'cache refreshed');
  const r = sw.request('js/app.js');
  await flush();
  assert.equal(r.response.label, 'app', 'still answered from the cache at once');
});
