// FactFlow frontend — a TikTok-style vertical scroller.
//
// Strategy:
//  - Render cards one-by-one into a vertical snap-scroll container.
//  - Stay PREFETCH_AHEAD cards ahead of the user's current position.
//  - When the user gets within PREFETCH_TRIGGER of the end, fetch another batch.
//  - The backend keeps its own larger buffer, so a "fetch" is usually instant.

const feed = document.getElementById('feed');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

const PREFETCH_AHEAD = 25;    // target number of cards kept beyond the user
const PREFETCH_TRIGGER = 20;  // start fetching when remaining drops below this
const BATCH_FETCH = 10;       // how many cards we ask the backend for per call

const cards = [];
let currentIndex = 0;
let fetching = false;
let loaderEl = null;

// ---- Rendering ----

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  if (card.gradient) el.style.background = card.gradient;

  el.innerHTML = `
    <div class="card__inner">
      <span class="card__category">${escapeHtml(card.category)}</span>
      <div class="card__emoji">${escapeHtml(card.emoji)}</div>
      <h1 class="card__title">${escapeHtml(card.title)}</h1>
      <p class="card__body">${escapeHtml(card.body)}</p>
    </div>
    <div class="card__source">${escapeHtml(card.source_hint || '')}</div>
  `;

  // Always insert before the trailing loader so the spinner stays last.
  if (loaderEl && loaderEl.parentNode === feed) {
    feed.insertBefore(el, loaderEl);
  } else {
    feed.appendChild(el);
  }
  cards.push(el);
}

function ensureLoader() {
  if (loaderEl && loaderEl.parentNode === feed) return;
  loaderEl = document.createElement('div');
  loaderEl.className = 'card card--loader';
  loaderEl.innerHTML = '<div class="spinner"></div>';
  feed.appendChild(loaderEl);
}

function removeLoader() {
  if (loaderEl && loaderEl.parentNode === feed) {
    feed.removeChild(loaderEl);
  }
  loaderEl = null;
}

// ---- Network ----

async function fetchMore(count = BATCH_FETCH) {
  if (fetching) return;
  fetching = true;
  // Only show a spinner when the user actually has nothing else to see.
  // Proactive background prefetches should be invisible.
  if (cards.length === 0) ensureLoader();
  try {
    const r = await fetch(`/api/feed?count=${count}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    const data = await r.json();

    if (!data.cards || data.cards.length === 0) {
      statusEl.textContent = data.error ? 'error' : 'empty';
      return;
    }

    for (const c of data.cards) renderCard(c);

    statusEl.textContent = `ready · buf ${data.bufferSize}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'offline';
  } finally {
    fetching = false;
    // Only hide the loader once we actually have cards to show.
    if (cards.length > 0) removeLoader();
  }
}

// ---- Scroll handling ----

function onScroll() {
  const h = feed.clientHeight;
  const idx = Math.round(feed.scrollTop / h);
  if (idx !== currentIndex) {
    currentIndex = idx;
    if (idx > 0) hintEl.classList.add('hidden');
  }

  const remaining = cards.length - currentIndex - 1;
  if (remaining < PREFETCH_TRIGGER && !fetching) {
    fetchMore();
  }
}

feed.addEventListener('scroll', onScroll, { passive: true });

// Keyboard fallback for desktop testing.
window.addEventListener('keydown', (e) => {
  const h = feed.clientHeight;
  if (e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    feed.scrollBy({ top: h, behavior: 'smooth' });
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    feed.scrollBy({ top: -h, behavior: 'smooth' });
  }
});

// ---- Boot ----

(async () => {
  statusEl.textContent = 'loading…';
  // Fetch until we have at least PREFETCH_AHEAD cards queued up before the user
  // ever scrolls. Bail out if a fetch returns nothing, to avoid a spin loop.
  while (cards.length < PREFETCH_AHEAD) {
    const before = cards.length;
    await fetchMore(BATCH_FETCH);
    if (cards.length === before) break;
  }
})();
