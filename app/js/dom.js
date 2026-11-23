// Tiny DOM helpers shared by the UI modules. No framework, no virtual DOM:
// screens build plain elements with `h()` and re-render when their data changes.

// Keys assigned as DOM properties instead of attributes.
const PROP_KEYS = new Set([
  'value',
  'checked',
  'disabled',
  'selected',
  'hidden',
  'htmlFor',
  'tabIndex',
  'multiple',
  'readOnly',
  'indeterminate',
  'textContent',
  'innerHTML',
]);

function setClass(el, value) {
  if (Array.isArray(value)) el.className = value.filter(Boolean).join(' ');
  else if (value) el.className = String(value);
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') setClass(el, value);
    else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else {
        for (const [k, v] of Object.entries(value)) {
          if (v === null || v === undefined) continue;
          // Custom properties need setProperty().
          if (k.startsWith('--')) el.style.setProperty(k, String(v));
          else el.style[k] = v;
        }
      }
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROP_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Append children (strings, numbers, nodes, nested arrays; null/false/true are skipped). */
export function append(el, ...children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, ...c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

/**
 * Create an element: h('button', { class: 'btn', onClick: fn }, 'Label', iconEl).
 * Props: class (string|array), style (string|object), dataset, text, on<Event> handlers,
 * DOM properties (value, checked, disabled…) and any other attribute.
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

/** Remove all children of an element. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace all children of an element. */
export function setChildren(el, ...children) {
  clear(el);
  return append(el, children);
}

/** Make a textarea grow with its content. Returns the resize function. */
export function autoGrow(textarea, { min = 0 } = {}) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(min, textarea.scrollHeight + 2)}px`;
  };
  textarea.addEventListener('input', resize);
  // Size once the element is in the document.
  requestAnimationFrame(resize);
  return resize;
}

/** True when the event target is a text field (keyboard shortcuts must not fire there). */
export function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file'].includes(type);
  }
  return false;
}

/** Resolve on the next animation frame (used to trigger CSS transitions). */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** True if the user asked the OS for reduced motion. */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → « lundi 30 novembre » (adds the year when it differs from the current one). */
export function formatDayFr(dayKey) {
  const m = DAY_RE.exec(dayKey || '');
  if (!m) return String(dayKey || '');
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const opts = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' };
  if (Number(m[1]) !== new Date().getFullYear()) opts.year = 'numeric';
  try {
    return new Intl.DateTimeFormat('fr-FR', opts).format(date);
  } catch {
    return dayKey;
  }
}

/**
 * French typography for UI text: a non-breaking space after « and before » ? ! : ; so these signs
 * never start or end a line on their own. For display only (never applied to stored data).
 */
export function frSpaces(s) {
  return String(s ?? '')
    .replace(/« /g, '«\u00A0')
    .replace(/ (?=[»?!:;])/g, '\u00A0');
}

/** Accent-insensitive search key. */
export function searchKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
