// Recto — entry point: hash router, tab bar, screen lifecycle, service worker registration.

import { startRouter, parseHash, currentHash, navigate } from './ui/router.js';
import { showError, errorBlock, loadingBlock, isOverlayOpen } from './ui/components.js';
import { renderMethods } from './ui/methods.js';
import { renderMethod } from './ui/method.js';
import { renderSelect } from './ui/select.js';
import { renderStudy } from './ui/study.js';
import { renderLibrary } from './ui/library.js';
import { renderData } from './ui/data.js';

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// tab: which tab is highlighted (null = full-screen, tab bar hidden).
const ROUTES = [
  { re: /^\/$/, tab: 'review', render: renderMethods, refreshOnShow: true },
  { re: /^\/method\/([^/]+)$/, tab: 'review', render: renderMethod, refreshOnShow: true },
  { re: /^\/method\/([^/]+)\/select$/, tab: 'review', render: renderSelect },
  { re: /^\/study\/([^/]+)$/, tab: null, render: (el, ctx) => renderStudy(el, ctx, 'study') },
  { re: /^\/practice\/method\/([^/]+)$/, tab: null, render: (el, ctx) => renderStudy(el, ctx, 'practice-method') },
  { re: /^\/practice\/folder\/([^/]+)$/, tab: null, render: (el, ctx) => renderStudy(el, ctx, 'practice-folder') },
  { re: /^\/cards$/, tab: 'cards', render: renderLibrary },
  { re: /^\/cards\/([^/]+)$/, tab: 'cards', render: renderLibrary },
  { re: /^\/data$/, tab: 'data', render: renderData },
];

const TAB_ROOTS = { review: '#/', cards: '#/cards', data: '#/data' };
const lastHashByTab = { ...TAB_ROOTS };

function matchRoute(path) {
  for (const route of ROUTES) {
    const m = route.re.exec(path);
    if (m) {
      let id = null;
      try {
        id = m[1] !== undefined ? decodeURIComponent(m[1]) : null;
      } catch {
        id = m[1];
      }
      return { route, params: { id } };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Screen lifecycle                                                    */
/* ------------------------------------------------------------------ */

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');

let current = null; // { hash, route, cleanups, dead, state, renderedAt }
let seq = 0;

function kill(entry) {
  if (!entry || entry.dead) return;
  entry.dead = true;
  for (const fn of entry.cleanups.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.warn('[recto] cleanup', err);
    }
  }
}

function updateChrome(route) {
  const tab = route.tab;
  document.body.classList.toggle('is-fullscreen', !tab);
  if (tabbar) {
    tabbar.hidden = !tab;
    for (const a of tabbar.querySelectorAll('[data-tab]')) {
      const active = a.dataset.tab === tab;
      a.classList.toggle('is-active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }
}

async function render({ refresh = false } = {}) {
  const hash = currentHash();
  const { path, query } = parseHash(hash);
  const match = matchRoute(path);
  if (!match) {
    navigate('#/', { replace: true });
    return;
  }
  const { route, params } = match;
  const isRefresh = refresh || (current && current.hash === hash && !current.dead);
  const scrollY = isRefresh ? window.scrollY : 0;
  const state = isRefresh && current ? current.state : {};

  if (route.tab) lastHashByTab[route.tab] = route.tab === 'data' ? TAB_ROOTS.data : hash;

  const entry = { hash, route, cleanups: [], dead: false, state, renderedAt: Date.now(), id: ++seq };
  const ctx = {
    params,
    query,
    state,
    hash,
    alive: () => !entry.dead && current === entry,
    onCleanup: (fn) => {
      if (entry.dead) fn();
      else entry.cleanups.push(fn);
    },
    refresh: () => {
      if (!entry.dead && current === entry) render({ refresh: true });
    },
  };

  // The previous screen stays visible while the new one loads (avoids flashes);
  // after a short delay the new one is shown with its loading state.
  const previous = current;
  current = entry;
  const el = document.createElement('div');
  el.className = `screen${isRefresh ? '' : ' is-entering'}`;
  let swapped = false;
  const swap = () => {
    if (swapped || entry.dead) return;
    swapped = true;
    kill(previous);
    updateChrome(route);
    view.replaceChildren(el);
    window.scrollTo(0, scrollY);
  };
  const timer = setTimeout(() => {
    if (!el.childNodes.length) el.append(loadingBlock());
    swap();
  }, 220);

  try {
    await route.render(el, ctx);
  } catch (err) {
    if (!entry.dead) {
      showError(err);
      el.replaceChildren(errorBlock(err, () => render({ refresh: true })));
    }
  } finally {
    clearTimeout(timer);
  }
  if (entry.dead) return;
  // Remove the loading block if the screen rendered next to it.
  const loading = el.querySelector(':scope > .loading');
  if (loading && el.childNodes.length > 1) loading.remove();
  swap();
  if (isRefresh) window.scrollTo(0, scrollY);
}

/* ------------------------------------------------------------------ */
/* Tab bar                                                             */
/* ------------------------------------------------------------------ */

if (tabbar) {
  tabbar.addEventListener('click', (e) => {
    const a = e.target.closest('[data-tab]');
    if (!a) return;
    e.preventDefault();
    const tab = a.dataset.tab;
    const activeTab = current?.route?.tab;
    // Tapping the active tab goes back to its root; another tab restores where you were.
    navigate(activeTab === tab ? TAB_ROOTS[tab] : lastHashByTab[tab] || TAB_ROOTS[tab]);
  });
}

// After « Tout effacer » / a restore, the remembered screens of each tab may point to deleted items.
window.addEventListener('recto:data-replaced', () => {
  Object.assign(lastHashByTab, TAB_ROOTS);
});

/* ------------------------------------------------------------------ */
/* Refresh some screens when the app comes back to the foreground      */
/* (the study day may have changed overnight).                         */
/* ------------------------------------------------------------------ */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !current || current.dead) return;
  if (!current.route.refreshOnShow || isOverlayOpen()) return;
  if (Date.now() - current.renderedAt < 30000) return;
  render({ refresh: true });
});

/* ------------------------------------------------------------------ */
/* Safety net: surface unexpected async errors to the user.            */
/* ------------------------------------------------------------------ */

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  // Interrupted media playback / denied gestures are not worth a toast.
  if (reason && (reason.name === 'AbortError' || reason.name === 'NotAllowedError')) return;
  showError(reason);
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

startRouter(({ refresh }) => {
  render({ refresh }).catch(showError);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}
