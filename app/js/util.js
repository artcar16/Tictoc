// Shared helpers. Pure ES module: importable from Node (tests) and the browser.
// Nothing here touches the DOM or IndexedDB at import time.

/** Hour (local time) at which a new "study day" starts. Studying at 1am still counts as the previous day. */
export const DAY_START_HOUR = 4;

/** Random unique id (UUID v4 when available). */
export function uid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * The study day for a given instant, as 'YYYY-MM-DD' (local calendar),
 * shifted so that the day starts at DAY_START_HOUR.
 */
export function studyDay(date = new Date()) {
  const d = new Date(date.getTime());
  d.setHours(d.getHours() - DAY_START_HOUR);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayToUTC(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) throw new Error(`Invalid day key: ${dayKey}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** addDays('2026-01-31', 1) === '2026-02-01'. DST-safe (pure calendar arithmetic). */
export function addDays(dayKey, n) {
  const d = new Date(dayToUTC(dayKey) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Number of days from a to b (b - a). dayDiff('2026-01-01', '2026-01-03') === 2. */
export function dayDiff(a, b) {
  return Math.round((dayToUTC(b) - dayToUTC(a)) / 86400000);
}

const collator =
  typeof Intl !== 'undefined' ? new Intl.Collator('fr', { numeric: true, sensitivity: 'base' }) : null;

/** Natural, accent-insensitive French comparison ("Chapitre 2" < "Chapitre 10"). */
export function compareText(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  return collator ? collator.compare(a, b) : a.localeCompare(b);
}

/** Key used to match texts: NFC, trimmed, whitespace collapsed, lower-cased. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Fisher–Yates shuffle returning a NEW array. `rng` returns a float in [0, 1). */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** French plural helper: plural(2, 'carte') === '2 cartes'. */
export function plural(n, singular, pluralForm = `${singular}s`) {
  return `${n} ${Math.abs(n) >= 2 ? pluralForm : singular}`;
}

/** Human readable size, e.g. formatBytes(1536) === '1,5 Ko'. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const v = i === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0).replace('.', ',');
  return `${v} ${units[i]}`;
}

/** ArrayBuffer -> base64 string (works in browser and Node). */
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 string -> ArrayBuffer. */
export function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Debounce a function. */
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
