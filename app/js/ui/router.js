// Minimal hash router helpers.
// Each history entry of this app is stamped with its position (history.state.recto = index), so
// the router always knows which hash the PREVIOUS entry holds. "Back" arrows then use
// history.back() when the previous entry is the expected parent (like a native app), and replace
// the current entry otherwise (deep link, reload, parent reached by another path).

const STATE_KEY = 'recto';

let entries = []; // entries[i] = hash of the history entry at position i (unknown = undefined)
let index = 0; // position of the current entry
let pending = null; // navigation initiated by navigate(): { hash, replace }
let onChange = () => {};

/** Canonical form of a hash: '#/path?query' without trailing slash. */
export function normalizeHash(hash) {
  let s = String(hash ?? '').replace(/^#/, '');
  if (!s.startsWith('/')) s = `/${s}`;
  const qi = s.indexOf('?');
  let path = qi >= 0 ? s.slice(0, qi) : s;
  const query = qi >= 0 ? s.slice(qi) : '';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return `#${path}${query === '?' ? '' : query}`;
}

/** Split a hash into { path, query: URLSearchParams }. */
export function parseHash(hash = location.hash) {
  const s = normalizeHash(hash).slice(1);
  const qi = s.indexOf('?');
  return {
    path: qi >= 0 ? s.slice(0, qi) : s,
    query: new URLSearchParams(qi >= 0 ? s.slice(qi + 1) : ''),
  };
}

export function currentHash() {
  return normalizeHash(location.hash);
}

function stampedIndex() {
  const st = history.state;
  return st && typeof st === 'object' && Number.isInteger(st[STATE_KEY]) ? st[STATE_KEY] : null;
}

function stamp() {
  try {
    const st = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState({ ...st, [STATE_KEY]: index }, '');
  } catch {
    /* state not writable: back arrows fall back to replace */
  }
}

/** Keep `entries` / `index` in sync with the browser history after a hash change. */
function track() {
  const hash = currentHash();
  const known = stampedIndex();
  if (known !== null) {
    // Back / forward to an entry we stamped earlier.
    index = known;
    entries[index] = hash;
  } else {
    // A new entry (link, location.hash = …) or a replaced one (location.replace).
    const replaced = pending && pending.hash === hash && pending.replace;
    if (!replaced) index += 1;
    entries.length = index; // forward history is gone
    entries[index] = hash;
    stamp();
  }
  pending = null;
}

/** Go to a hash. Same hash ⇒ re-render (refresh) instead. */
export function navigate(hash, { replace = false } = {}) {
  const target = normalizeHash(hash);
  if (target === currentHash()) {
    onChange({ refresh: true });
    return;
  }
  pending = { hash: target, replace };
  if (replace) location.replace(target);
  else location.hash = target;
}

/** Rewrite the current entry's hash in place: no new entry, no hashchange, no re-render. */
export function replaceHashQuietly(hash) {
  const target = normalizeHash(hash);
  if (target === currentHash()) return;
  try {
    history.replaceState(history.state, '', target);
  } catch {
    return;
  }
  entries[index] = target;
}

/** Go "up" to `fallback`: pops history when it is the previous entry, replaces otherwise. */
export function back(fallback) {
  const target = normalizeHash(fallback);
  if (index > 0 && entries[index - 1] === target) history.back();
  else navigate(target, { replace: true });
}

/** Start listening. `handler({ refresh })` is called for every route change. */
export function startRouter(handler) {
  onChange = handler;
  const known = stampedIndex();
  index = known ?? 0; // after a reload the entry keeps its position; earlier hashes are unknown
  entries = [];
  entries[index] = currentHash();
  if (known === null) stamp();
  window.addEventListener('hashchange', () => {
    track();
    onChange({ refresh: false });
  });
  onChange({ refresh: false });
}
