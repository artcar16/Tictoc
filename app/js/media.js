// Media for Recto: photo capture + full-screen cropper, audio recorder, file picker and a
// small round audio play/pause button. Self-contained browser module (no import from UI files).
// Overlays are styled by css/media.css (injected once), which uses the design tokens of style.css.

import { formatBytes } from './util.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const CSS_URL = new URL('../css/media.css', import.meta.url).href;

const OUTPUT_MAX_SIDE = 1600; // px, longest side of a cropped photo
const OUTPUT_QUALITY = 0.85; // JPEG quality
const PREVIEW_MAX_SIDE = 2048; // px, intermediate bitmap used to paint the cropper preview
const STAGE_PADDING = 24; // px around the image, so the handles at the image edges stay reachable
const HANDLE_REACH = 22; // px: a handle grabs within 22px of its line/corner (44px touch target)
const MIN_CROP_DISPLAY = 48; // px on screen: smallest crop box the user can make

const MAX_RECORD_MS = 5 * 60 * 1000;
const RECORDER_MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const RECORDER_BITRATE = 64000; // plenty for voice, keeps 5 min under ~2.5 Mo
const MAX_AUDIO_FILE_BYTES = 30 * 1024 * 1024;

// File picker fallbacks for browsers that never fire the input 'cancel' event (older iOS Safari).
const PICKER_FOCUS_GRACE_MS = 4000; // after the page regains focus without any file
const PICKER_ARM_DELAY_MS = 600; // interactions earlier than this belong to the opening gesture
const PICKER_INTERACTION_GRACE_MS = 350; // lets a late 'change' event land first

const AUDIO_EXTENSION_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  caf: 'audio/x-caf',
};

/* ------------------------------------------------------------------ */
/* Stylesheet                                                          */
/* ------------------------------------------------------------------ */

let stylesPromise = null;

/** Inject css/media.css once; resolves when it is loaded (or after a short timeout). */
function ensureStyles() {
  if (stylesPromise) return stylesPromise;
  if (typeof document === 'undefined') return Promise.resolve();
  let link = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).find((l) => l.href === CSS_URL);
  if (link && link.sheet) {
    stylesPromise = Promise.resolve();
    return stylesPromise;
  }
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.dataset.media = '';
    document.head.appendChild(link);
  }
  const target = link;
  stylesPromise = new Promise((resolve) => {
    const done = () => resolve();
    target.addEventListener('load', done, { once: true });
    target.addEventListener('error', done, { once: true });
    setTimeout(done, 1500);
  });
  return stylesPromise;
}

// Start loading right away so audio buttons and overlays are styled from their first paint.
ensureStyles();

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

let idCounter = 0;
const nextId = (prefix) => `${prefix}-${++idCounter}`;

/** Create an element: el('button', 'cls', { type: 'button' }, child, 'text'). */
function el(tag, className, attrs, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

const ICONS = {
  rotate: '<path d="M21 4v6h-6"/><path d="M20.5 15a8.5 8.5 0 1 1-2-8.8L21 10"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  micOff:
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.4 2.3M12 18v3M4 4l16 16"/>',
  play: '<path d="M8.5 5.6v12.8a.8.8 0 0 0 1.2.7l10.1-6.4a.8.8 0 0 0 0-1.4L9.7 4.9a.8.8 0 0 0-1.2.7Z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
};

/** Inline stroke icon (static markup only). */
function icon(name, className = 'mo-icon') {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return tpl.content.firstElementChild;
}

function button(className, label, { iconName, ariaLabel, onClick } = {}) {
  const btn = el('button', className, { type: 'button', 'aria-label': ariaLabel });
  if (iconName) btn.append(icon(iconName));
  if (label) btn.append(el('span', null, null, label));
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 'm:ss' */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Overlay stack: scroll lock, Escape, focus trap & restore            */
/* ------------------------------------------------------------------ */

const overlayStack = [];

function isVisible(node) {
  return !node.hidden && node.getClientRects().length > 0;
}

function focusables(root) {
  return Array.from(root.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(isVisible);
}

// While a media overlay is open it owns the keyboard: screens and sheets below must not react
// (study shortcuts, the editor's Escape...). Default actions (button activation) still happen.
function onOverlayKeyDown(e) {
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return;
  e.stopImmediatePropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    top.onEscape();
    return;
  }
  if (e.key === 'Tab') {
    const list = focusables(top.el);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (active === top.el || !top.el.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  top.onKey?.(e);
}

/** Show an overlay element on top of everything. */
function openOverlay(node, { onEscape, onKey, initialFocus }) {
  const entry = { el: node, onEscape, onKey, restoreFocus: document.activeElement };
  overlayStack.push(entry);
  if (overlayStack.length === 1) {
    document.documentElement.classList.add('media-lock');
    window.addEventListener('keydown', onOverlayKeyDown, true);
  }
  document.body.appendChild(node);
  const target = initialFocus && isVisible(initialFocus) ? initialFocus : node;
  try {
    target.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  return entry;
}

function closeOverlay(entry) {
  const i = overlayStack.indexOf(entry);
  if (i >= 0) overlayStack.splice(i, 1);
  if (!overlayStack.length) {
    document.documentElement.classList.remove('media-lock');
    window.removeEventListener('keydown', onOverlayKeyDown, true);
  }
  entry.el.remove();
  // Restore focus once the caller had a chance to re-enable its (busy) button.
  const back = entry.restoreFocus;
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try {
        back.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }, 0);
}

/* ------------------------------------------------------------------ */
/* File picker                                                         */
/* ------------------------------------------------------------------ */

const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];

/**
 * Open the native file picker. Resolves with the chosen File, or null when the user cancels.
 * Must be called from a user gesture (click handler), before any await.
 * Cancel detection: the input 'cancel' event where supported; otherwise best effort (page regains
 * focus without a file, or the user starts using the page again), so callers never stay blocked.
 */
export function pickFile({ accept, capture } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    if (capture) input.setAttribute('capture', capture === true ? 'environment' : String(capture));
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    // Kept in the DOM while the picker is open (required by iOS Safari), but invisible.
    Object.assign(input.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    });

    const openedAt = Date.now();
    let settled = false;
    let leftPage = false; // the picker took the focus / hid the page
    let timer = 0;

    const takeFile = () => (input.files && input.files.length ? input.files[0] : null);
    const finish = (file) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const type of INTERACTION_EVENTS) window.removeEventListener(type, onInteraction, true);
      input.remove();
      resolve(file || null);
    };
    const giveUpIn = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(takeFile()), ms);
    };

    const onChange = () => finish(takeFile());
    const onCancel = () => finish(null);
    const onBlur = () => {
      leftPage = true;
    };
    const onFocus = () => {
      if (leftPage) giveUpIn(PICKER_FOCUS_GRACE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') leftPage = true;
      else if (leftPage) giveUpIn(PICKER_FOCUS_GRACE_MS);
    };
    const onInteraction = () => {
      if (Date.now() - openedAt > PICKER_ARM_DELAY_MS) giveUpIn(PICKER_INTERACTION_GRACE_MS);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    for (const type of INTERACTION_EVENTS) window.addEventListener(type, onInteraction, true);

    document.body.appendChild(input);
    try {
      input.click();
    } catch {
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

/**
 * Take a photo ('camera') or choose one ('gallery'), then let the user crop it.
 * Resolves with a JPEG Blob, or null if cancelled at any step.
 */
export async function captureImage({ source = 'gallery' } = {}) {
  // pickFile is called synchronously so the picker opens within the user gesture.
  const file = await pickFile({ accept: 'image/*', capture: source === 'camera' ? 'environment' : undefined });
  if (!file) return null;
  return cropImage(file);
}

/** Decode an image URL. <img> applies the EXIF orientation (naturalWidth/Height and drawImage). */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error('empty image'));
        return;
      }
      const decoded = typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve();
      decoded.then(() => resolve(img));
    };
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), type, quality);
      return;
    }
    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const [head, b64] = dataUrl.split(',');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] || type }));
    } catch (err) {
      reject(err);
    }
  });
}

/** Free the pixel memory of a canvas right away (matters on iOS). */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Full-screen cropper. Resolves with a JPEG Blob of the chosen region (longest side ≤ 1600px),
 * or null on cancel. Throws (French message) when the image cannot be decoded.
 */
export async function cropImage(blobOrFile) {
  if (!blobOrFile) return null;
  const stylesReady = ensureStyles();
  const url = URL.createObjectURL(blobOrFile);
  let img;
  try {
    img = await loadImage(url);
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Impossible de lire cette image (format non pris en charge ?)');
  }
  await stylesReady;
  return runCropper(img, () => {
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
  });
}

const CURSORS = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

function runCropper(img, releaseImage) {
  return new Promise((resolve) => {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    // Crop rectangle in natural pixels of the ROTATED image (rot = quarter turns clockwise).
    const st = {
      rot: 0,
      crop: { x: 0, y: 0, w: natW, h: natH },
      scale: 1, // screen px per natural px
      ox: 0, // image position inside the stage
      oy: 0,
      drag: null,
      busy: false,
      closed: false,
    };
    const rotW = () => (st.rot % 2 ? natH : natW);
    const rotH = () => (st.rot % 2 ? natW : natH);

    /* --- DOM --- */
    const titleId = nextId('mc-title');
    const canvas = el('canvas', 'mc-canvas', { 'aria-hidden': 'true' });
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((m) =>
      el('span', `mc-h mc-h-${m}${m.length === 2 ? ' mc-h-corner' : ' mc-h-edge'}`, { 'aria-hidden': 'true' }),
    );
    const grid = el('span', 'mc-grid', { 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'));
    const box = el(
      'div',
      'mc-box',
      {
        tabindex: '0',
        role: 'group',
        'aria-label': 'Zone de recadrage. Flèches : déplacer ; Maj + flèches : redimensionner.',
      },
      grid,
      ...handles,
    );
    const stage = el('div', 'mc-stage', null, canvas, box);
    const errorEl = el('p', 'mo-error mc-error', { role: 'alert', hidden: true });
    const rotateBtn = button('mo-tool', 'Pivoter', { iconName: 'rotate', onClick: () => rotate() });
    const resetBtn = button('mo-tool', 'Tout', { iconName: 'expand', onClick: () => reset() });
    resetBtn.title = 'Sélectionner toute l’image';
    const cancelBtn = button('mo-btn mo-btn-secondary', 'Annuler', { onClick: () => close(null) });
    const okBtn = button('mo-btn mo-btn-primary', 'Valider', { onClick: () => validate() });
    const root = el(
      'div',
      'media-overlay media-cropper',
      { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      el('header', 'mo-head', null, el('h2', 'mo-title', { id: titleId }, 'Recadrer la photo')),
      stage,
      el(
        'footer',
        'mo-foot mc-foot',
        null,
        el('div', 'mc-tools', null, rotateBtn, resetBtn),
        errorEl,
        el('div', 'mo-actions', null, cancelBtn, okBtn),
      ),
    );

    /* --- preview painting --- */
    let previewSource = null;
    function getPreviewSource() {
      if (previewSource) return previewSource;
      const longest = Math.max(natW, natH);
      if (longest <= PREVIEW_MAX_SIDE) {
        previewSource = img;
      } else {
        // One good-quality downscale; later repaints (rotate/resize) start from this bitmap.
        const k = PREVIEW_MAX_SIDE / longest;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(natW * k));
        c.height = Math.max(1, Math.round(natH * k));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        previewSource = c;
      }
      return previewSource;
    }

    let paintedKey = '';
    function paintPreview(dispW, dispH) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const bs = Math.min(1, st.scale * dpr); // backing pixels per natural pixel
      const bw = Math.max(1, Math.round(rotW() * bs));
      const bh = Math.max(1, Math.round(rotH() * bs));
      canvas.style.width = `${dispW}px`;
      canvas.style.height = `${dispH}px`;
      const key = `${bw}x${bh}@${st.rot}`;
      if (key === paintedKey) return;
      paintedKey = key;
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      ctx.translate(bw / 2, bh / 2);
      ctx.rotate((st.rot * Math.PI) / 2);
      const dw = st.rot % 2 ? bh : bw;
      const dh = st.rot % 2 ? bw : bh;
      ctx.drawImage(getPreviewSource(), -dw / 2, -dh / 2, dw, dh);
    }

    /* --- geometry --- */
    function minSize() {
      const m = MIN_CROP_DISPLAY / st.scale;
      return { minW: Math.min(m, rotW()), minH: Math.min(m, rotH()) };
    }

    function clampCrop() {
      const { minW, minH } = minSize();
      let { x, y, w, h } = st.crop;
      w = clamp(w, minW, rotW());
      h = clamp(h, minH, rotH());
      x = clamp(x, 0, rotW() - w);
      y = clamp(y, 0, rotH() - h);
      st.crop = { x, y, w, h };
    }

    function layout() {
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) return;
      const availW = Math.max(1, sw - 2 * STAGE_PADDING);
      const availH = Math.max(1, sh - 2 * STAGE_PADDING);
      st.scale = Math.min(availW / rotW(), availH / rotH());
      const dispW = rotW() * st.scale;
      const dispH = rotH() * st.scale;
      st.ox = (sw - dispW) / 2;
      st.oy = (sh - dispH) / 2;
      canvas.style.transform = `translate(${st.ox}px, ${st.oy}px)`;
      paintPreview(dispW, dispH);
      clampCrop();
      renderBox();
    }

    function renderBox() {
      const s = st.scale;
      const c = st.crop;
      const w = c.w * s;
      const h = c.h * s;
      box.style.transform = `translate(${st.ox + c.x * s}px, ${st.oy + c.y * s}px)`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.classList.toggle('is-small', w < 88 || h < 88);
    }

    let raf = 0;
    function scheduleRender() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderBox();
      });
    }

    /** Which part of the crop box is under a stage-local point: corner, edge, 'move' or null. */
    function hitTest(px, py) {
      const s = st.scale;
      const c = st.crop;
      const L = st.ox + c.x * s;
      const T = st.oy + c.y * s;
      const R = L + c.w * s;
      const B = T + c.h * s;
      // Handles reach 22px outward, and inward at most a quarter of the box so it can still be moved.
      const inX = Math.min(HANDLE_REACH, (R - L) / 4);
      const inY = Math.min(HANDLE_REACH, (B - T) / 4);
      if (px < L - HANDLE_REACH || px > R + HANDLE_REACH || py < T - HANDLE_REACH || py > B + HANDLE_REACH) {
        return null;
      }
      let hz = '';
      if (px <= L + inX) hz = 'w';
      else if (px >= R - inX) hz = 'e';
      let vz = '';
      if (py <= T + inY) vz = 'n';
      else if (py >= B - inY) vz = 's';
      if (hz || vz) return vz + hz;
      return 'move';
    }

    /* --- pointer interaction --- */
    function onPointerDown(e) {
      if (st.drag || st.busy) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const stageRect = stage.getBoundingClientRect();
      const mode = hitTest(e.clientX - stageRect.left, e.clientY - stageRect.top);
      if (!mode) return;
      e.preventDefault();
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer may already be gone */
      }
      st.drag = { pointerId: e.pointerId, mode, x0: e.clientX, y0: e.clientY, rect: { ...st.crop } };
      stage.style.cursor = CURSORS[mode];
      root.classList.add('is-dragging');
    }

    function onPointerMove(e) {
      const d = st.drag;
      if (!d) {
        // Desktop affordance: cursor reflects what a drag would do.
        if (e.pointerType === 'mouse') {
          const r = stage.getBoundingClientRect();
          stage.style.cursor = CURSORS[hitTest(e.clientX - r.left, e.clientY - r.top)] || '';
        }
        return;
      }
      if (e.pointerId !== d.pointerId) return;
      e.preventDefault();
      const dx = (e.clientX - d.x0) / st.scale;
      const dy = (e.clientY - d.y0) / st.scale;
      const r = d.rect;
      if (d.mode === 'move') {
        st.crop = {
          x: clamp(r.x + dx, 0, rotW() - r.w),
          y: clamp(r.y + dy, 0, rotH() - r.h),
          w: r.w,
          h: r.h,
        };
      } else {
        const { minW, minH } = minSize();
        let left = r.x;
        let top = r.y;
        let right = r.x + r.w;
        let bottom = r.y + r.h;
        if (d.mode.includes('w')) left = clamp(r.x + dx, 0, right - minW);
        if (d.mode.includes('e')) right = clamp(right + dx, left + minW, rotW());
        if (d.mode.includes('n')) top = clamp(r.y + dy, 0, bottom - minH);
        if (d.mode.includes('s')) bottom = clamp(bottom + dy, top + minH, rotH());
        st.crop = { x: left, y: top, w: right - left, h: bottom - top };
      }
      scheduleRender();
    }

    function onPointerEnd(e) {
      if (!st.drag || e.pointerId !== st.drag.pointerId) return;
      st.drag = null;
      root.classList.remove('is-dragging');
      if (e.pointerType !== 'mouse') stage.style.cursor = '';
      try {
        stage.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      renderBox();
    }

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerEnd);
    stage.addEventListener('pointercancel', onPointerEnd);
    stage.addEventListener('lostpointercapture', onPointerEnd);
    // Old iOS: make sure touch scrolling never starts on the stage.
    stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    /* --- tools --- */
    function rotate() {
      if (st.busy) return;
      // 90° clockwise: a point (x, y) of the current view goes to (H - y, x).
      const c = st.crop;
      const h = rotH();
      st.crop = { x: h - (c.y + c.h), y: c.x, w: c.h, h: c.w };
      st.rot = (st.rot + 1) % 4;
      st.drag = null;
      root.classList.remove('is-dragging');
      layout();
    }

    function reset() {
      if (st.busy) return;
      st.crop = { x: 0, y: 0, w: rotW(), h: rotH() };
      renderBox();
    }

    // Keyboard: arrows move the box, Shift + arrows resize it (when the box has the focus).
    function onKey(e) {
      if (document.activeElement !== box || st.busy) return;
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dirs[e.key];
      if (!d) return;
      e.preventDefault();
      const stepX = Math.max(1, rotW() * 0.02);
      const stepY = Math.max(1, rotH() * 0.02);
      const c = { ...st.crop };
      if (e.shiftKey) {
        c.w += d[0] * stepX;
        c.h += d[1] * stepY;
      } else {
        c.x += d[0] * stepX;
        c.y += d[1] * stepY;
      }
      st.crop = c;
      clampCrop();
      renderBox();
    }

    /* --- output --- */
    function exportCrop() {
      const rw = rotW();
      const rh = rotH();
      // Integer crop rectangle inside the rotated image.
      const x = clamp(Math.round(st.crop.x), 0, rw - 1);
      const y = clamp(Math.round(st.crop.y), 0, rh - 1);
      const w = clamp(Math.round(st.crop.x + st.crop.w) - x, 1, rw - x);
      const h = clamp(Math.round(st.crop.y + st.crop.h) - y, 1, rh - y);
      // Same rectangle in the unrotated (natural, EXIF-oriented) image.
      let src;
      switch (st.rot) {
        case 1:
          src = { x: y, y: natH - x - w, w: h, h: w };
          break;
        case 2:
          src = { x: natW - x - w, y: natH - y - h, w, h };
          break;
        case 3:
          src = { x: natW - y - h, y: x, w: h, h: w };
          break;
        default:
          src = { x, y, w, h };
      }
      const k = Math.min(1, OUTPUT_MAX_SIDE / Math.max(w, h));
      const outW = Math.max(1, Math.round(w * k));
      const outH = Math.max(1, Math.round(h * k));
      // Only the cropped region is drawn, into a canvas of the output size (safe for 12 MP photos).
      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d', { alpha: false }) || out.getContext('2d');
      ctx.fillStyle = '#ffffff'; // transparent PNG areas become white, not black
      ctx.fillRect(0, 0, outW, outH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate((st.rot * Math.PI) / 2);
      const dw = st.rot % 2 ? outH : outW;
      const dh = st.rot % 2 ? outW : outH;
      ctx.drawImage(img, src.x, src.y, src.w, src.h, -dw / 2, -dh / 2, dw, dh);
      return canvasToBlob(out, 'image/jpeg', OUTPUT_QUALITY).finally(() => releaseCanvas(out));
    }

    function setBusy(on) {
      st.busy = on;
      root.classList.toggle('is-busy', on);
      for (const b of [rotateBtn, resetBtn, okBtn]) b.disabled = on;
      okBtn.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    async function validate() {
      if (st.busy || st.closed) return;
      setBusy(true);
      errorEl.hidden = true;
      try {
        const blob = await exportCrop();
        close(blob);
      } catch (err) {
        if (st.closed) return;
        console.warn('[media] crop export failed', err);
        errorEl.textContent = 'Impossible de créer l’image. Réessaie, ou choisis une zone plus petite.';
        errorEl.hidden = false;
        setBusy(false);
      }
    }

    /* --- lifecycle --- */
    let ro = null;
    const onWindowResize = () => layout();

    function close(result) {
      if (st.closed) return;
      st.closed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      closeOverlay(entry);
      releaseCanvas(canvas);
      if (previewSource && previewSource !== img) releaseCanvas(previewSource);
      releaseImage();
      resolve(result || null);
    }

    // Focus the dialog itself: after a native picker, focusing a button would often draw a focus ring.
    const entry = openOverlay(root, { onEscape: () => close(null), onKey, initialFocus: root });
    layout();
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        if (!st.closed) layout();
      });
      ro.observe(stage);
    } else {
      window.addEventListener('resize', onWindowResize);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Audio playback button                                               */
/* ------------------------------------------------------------------ */

let currentPlayer = null; // the audio button currently playing (only one at a time)

const RING_R = 16.5;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Round play/pause button for an audio Blob. Starting one stops any other.
 * Call el.destroy() when it is removed: stops playback and revokes its object URL.
 */
export function createAudioButton(blob) {
  ensureStyles();
  const btn = el('button', 'media-audio-btn', { type: 'button', 'aria-label': 'Écouter l’audio' });
  const ringNS = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(ringNS, 'svg');
  ring.setAttribute('class', 'mab-ring');
  ring.setAttribute('viewBox', '0 0 36 36');
  ring.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS(ringNS, 'circle');
  arc.setAttribute('cx', '18');
  arc.setAttribute('cy', '18');
  arc.setAttribute('r', String(RING_R));
  arc.setAttribute('stroke-dasharray', String(RING_C));
  arc.setAttribute('stroke-dashoffset', String(RING_C));
  ring.append(arc);
  btn.append(ring, icon('play', 'mab-icon mab-play'), icon('pause', 'mab-icon mab-pause'));

  let url = null;
  let audio = null;
  let destroyed = false;

  const setProgress = (ratio) => {
    arc.setAttribute('stroke-dashoffset', String(RING_C * (1 - clamp(ratio, 0, 1))));
  };

  const setPlaying = (on) => {
    btn.classList.toggle('is-playing', on);
    btn.setAttribute('aria-label', on ? 'Mettre l’audio en pause' : 'Écouter l’audio');
    if (on) currentPlayer = controller;
    else if (currentPlayer === controller) currentPlayer = null;
  };

  const setError = () => {
    setPlaying(false);
    btn.classList.add('is-error');
    btn.title = 'Lecture impossible sur cet appareil';
    btn.setAttribute('aria-label', 'Audio illisible');
  };

  const ensureAudio = () => {
    if (audio) return audio;
    url = URL.createObjectURL(blob);
    const a = new Audio();
    a.preload = 'auto';
    // Events can still arrive after destroy() (e.g. while the element unloads): ignore them.
    a.addEventListener('timeupdate', () => {
      if (destroyed) return;
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) setProgress(a.currentTime / d);
    });
    a.addEventListener('pause', () => {
      if (!destroyed) setPlaying(false);
    });
    a.addEventListener('playing', () => {
      if (!destroyed) setPlaying(true);
    });
    a.addEventListener('ended', () => {
      if (destroyed) return;
      setPlaying(false);
      setProgress(0);
    });
    a.addEventListener('error', () => {
      if (!destroyed) setError();
    });
    a.src = url;
    audio = a;
    return a;
  };

  /** Stop and rewind. */
  const stop = () => {
    if (!audio) return;
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    setProgress(0);
    setPlaying(false);
  };

  const play = () => {
    if (currentPlayer && currentPlayer !== controller) currentPlayer.stop();
    btn.classList.remove('is-error');
    const a = ensureAudio();
    setPlaying(true);
    const p = a.play(); // synchronous call within the tap (iOS)
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (destroyed || (err && err.name === 'AbortError')) return;
        if (err && err.name === 'NotAllowedError') setPlaying(false); // autoplay policy, not a broken file
        else setError();
      });
    }
  };

  const controller = { stop };

  if (!(blob instanceof Blob) || !blob.size) {
    btn.disabled = true;
    btn.classList.add('is-error');
    btn.setAttribute('aria-label', 'Audio indisponible');
  }

  btn.addEventListener('click', (e) => {
    // The button often sits inside a tappable card: playing must not also flip/reveal it.
    e.stopPropagation();
    if (destroyed) return;
    if (audio && !audio.paused) audio.pause(); // keeps the position; play resumes
    else play();
  });

  btn.stop = stop;
  btn.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (currentPlayer === controller) currentPlayer = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      try {
        audio.load(); // releases the media resource
      } catch {
        /* ignore */
      }
      audio = null;
    }
    if (url) URL.revokeObjectURL(url);
    url = null;
    btn.classList.remove('is-playing');
  };
  return btn;
}

/* ------------------------------------------------------------------ */
/* Audio recording                                                     */
/* ------------------------------------------------------------------ */

function pickRecorderMime() {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return (
    RECORDER_MIME_TYPES.find((t) => {
      try {
        return MR.isTypeSupported(t);
      } catch {
        return false;
      }
    }) || ''
  );
}

function createRecorder(stream, mime) {
  const attempts = [];
  if (mime) attempts.push({ mimeType: mime, audioBitsPerSecond: RECORDER_BITRATE }, { mimeType: mime });
  attempts.push({ audioBitsPerSecond: RECORDER_BITRATE }, undefined);
  let lastError;
  for (const options of attempts) {
    try {
      return options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

/** Why recording is impossible on this device, or '' if it should work. */
function recordingUnavailableReason() {
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return 'Le micro n’est accessible que sur une connexion sécurisée (https). Tu peux importer un fichier audio.';
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return 'Ce navigateur ne donne pas accès au micro. Tu peux importer un fichier audio.';
  }
  if (typeof window.MediaRecorder !== 'function') {
    return 'Ce navigateur ne permet pas d’enregistrer de l’audio. Tu peux importer un fichier audio.';
  }
  return '';
}

function micErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Accès au micro refusé. Autorise le micro pour cette app dans les réglages du navigateur, ou importe un fichier audio.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Aucun micro n’a été trouvé sur cet appareil. Tu peux importer un fichier audio.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Le micro est indisponible (utilisé par une autre app ?). Réessaie, ou importe un fichier audio.';
    default:
      return 'Impossible d’accéder au micro. Réessaie, ou importe un fichier audio.';
  }
}

/** Type of an imported audio file (some systems give an empty type). */
function audioTypeOf(file) {
  if (file.type) return file.type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]?.toLowerCase();
  return (ext && AUDIO_EXTENSION_TYPES[ext]) || '';
}

/** Duration in ms of an audio blob, or null when unknown. Never rejects. */
function probeDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      try {
        a.load();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 4000);
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => finish(Number.isFinite(a.duration) ? a.duration * 1000 : null));
    a.addEventListener('error', () => finish(null));
    a.src = url;
  });
}

/**
 * Full-screen audio recorder (with « Importer un fichier audio »).
 * Resolves with an audio Blob, or null on cancel. The microphone is released on every exit path.
 */
export async function captureAudio() {
  await ensureStyles();
  return new Promise((resolve) => {
    const unavailable = recordingUnavailableReason();

    // phase: idle | requesting | recording | stopping | preview | unavailable
    const st = {
      phase: unavailable ? 'unavailable' : 'idle',
      closed: false,
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: 0,
      elapsed: 0,
      autoStopped: false,
      interrupted: false,
      result: null,
      picking: false,
    };
    let tick = 0;
    let preview = null;

    /* --- DOM --- */
    const titleId = nextId('mr-title');
    const closeBtn = button('mo-icon-btn', null, { iconName: 'close', ariaLabel: 'Annuler', onClick: () => close(null) });
    const timerEl = el('div', 'mr-timer', { 'aria-hidden': 'true' }, '0:00');
    const limitEl = el('div', 'mr-limit', null, `${formatDuration(MAX_RECORD_MS)} maximum`);
    const recDot = el('span', 'mr-rec-dot', { 'aria-hidden': 'true' });
    const recBtn = el('button', 'mr-rec', { type: 'button', 'aria-label': 'Démarrer l’enregistrement' }, recDot);
    const offEl = el('div', 'mr-off', { 'aria-hidden': 'true' }, icon('micOff'));
    const previewSlot = el('div', 'mr-preview');
    const centerEl = el('div', 'mr-center', null, recBtn, offEl, previewSlot);
    const statusEl = el('p', 'mr-status', { role: 'status', 'aria-live': 'polite' });
    const errorEl = el('p', 'mo-error mr-error', { role: 'alert', hidden: true });
    const retryBtn = button('mo-btn mo-btn-secondary', 'Recommencer', { onClick: () => restart() });
    const okBtn = button('mo-btn mo-btn-primary', 'Valider', { onClick: () => validate() });
    const actionsEl = el('div', 'mo-actions', null, retryBtn, okBtn);
    const importBtn = button('mo-btn mo-btn-link mr-import', 'Importer un fichier audio', {
      iconName: 'upload',
      onClick: () => importFile(),
    });
    const root = el(
      'div',
      'media-overlay media-recorder',
      { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      el(
        'header',
        'mo-head',
        null,
        closeBtn,
        el('h2', 'mo-title', { id: titleId }, 'Enregistrer un audio'),
        el('span', 'mo-spacer', { 'aria-hidden': 'true' }),
      ),
      el('div', 'mr-main', null, timerEl, limitEl, centerEl, statusEl, errorEl),
      el('footer', 'mo-foot mr-foot', null, actionsEl, importBtn),
    );

    /* --- rendering --- */
    function showError(message) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    function render() {
      const p = st.phase;
      root.dataset.phase = p;
      const recording = p === 'recording';
      recBtn.hidden = p === 'preview' || p === 'unavailable';
      recBtn.disabled = p === 'requesting' || p === 'stopping';
      recBtn.classList.toggle('is-recording', recording);
      recBtn.setAttribute('aria-label', recording ? 'Arrêter l’enregistrement' : 'Démarrer l’enregistrement');
      offEl.hidden = p !== 'unavailable';
      previewSlot.hidden = p !== 'preview';
      actionsEl.hidden = p !== 'preview';
      limitEl.hidden = p === 'preview' || p === 'unavailable';
      timerEl.hidden = p === 'unavailable';
      importBtn.disabled = recording || p === 'requesting' || p === 'stopping' || st.picking;
      importBtn.classList.toggle('mo-btn-primary', p === 'unavailable');
      importBtn.classList.toggle('mo-btn-link', p !== 'unavailable');
      const status = {
        idle: 'Appuie sur le bouton pour enregistrer.',
        requesting: 'Autorisation du micro…',
        recording: 'Enregistrement… Appuie pour arrêter.',
        stopping: 'Finalisation…',
        preview: st.result?.label || 'Écoute l’enregistrement, puis valide.',
        unavailable: '',
      }[p];
      statusEl.textContent = status;
    }

    function updateTimer() {
      timerEl.textContent = formatDuration(st.elapsed);
    }

    /* --- recording --- */
    function clearResult() {
      if (preview) preview.destroy();
      preview = null;
      previewSlot.replaceChildren();
      st.result = null;
    }

    function releaseMic() {
      stopStream(st.stream);
      st.stream = null;
    }

    async function startRecording() {
      if (st.closed || (st.phase !== 'idle' && st.phase !== 'preview')) return;
      clearResult();
      showError('');
      st.elapsed = 0;
      updateTimer();
      st.phase = 'requesting';
      render();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (st.closed) return;
        st.phase = 'idle';
        render();
        showError(micErrorMessage(err));
        return;
      }
      if (st.closed) {
        stopStream(stream); // the overlay was closed while the permission prompt was open
        return;
      }
      st.stream = stream;
      let recorder;
      try {
        recorder = createRecorder(stream, pickRecorderMime());
      } catch {
        releaseMic();
        st.phase = 'idle';
        render();
        showError('Impossible de démarrer l’enregistrement sur ce navigateur. Tu peux importer un fichier audio.');
        return;
      }
      st.recorder = recorder;
      st.chunks = [];
      st.autoStopped = false;
      st.interrupted = false;
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) st.chunks.push(e.data);
      });
      recorder.addEventListener('stop', () => onRecorderStop(recorder));
      recorder.addEventListener('error', () => {
        if (st.closed || st.recorder !== recorder) return;
        clearInterval(tick);
        st.recorder = null;
        releaseMic();
        st.phase = 'idle';
        render();
        showError('L’enregistrement a échoué. Réessaie, ou importe un fichier audio.');
      });
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (st.recorder === recorder && st.phase === 'recording') {
            st.interrupted = true;
            stopRecording();
          }
        });
      }
      try {
        recorder.start(1000); // regular chunks: nothing is lost if the page is interrupted
      } catch {
        st.recorder = null;
        releaseMic();
        st.phase = 'idle';
        render();
        showError('Impossible de démarrer l’enregistrement. Réessaie, ou importe un fichier audio.');
        return;
      }
      st.startedAt = performance.now();
      st.phase = 'recording';
      render();
      tick = setInterval(() => {
        st.elapsed = performance.now() - st.startedAt;
        if (st.elapsed >= MAX_RECORD_MS) {
          st.elapsed = MAX_RECORD_MS;
          st.autoStopped = true;
          stopRecording();
        }
        updateTimer();
      }, 200);
    }

    function stopRecording() {
      if (st.phase !== 'recording' || !st.recorder) return;
      clearInterval(tick);
      st.elapsed = Math.min(MAX_RECORD_MS, performance.now() - st.startedAt);
      updateTimer();
      st.phase = 'stopping';
      render();
      try {
        st.recorder.stop(); // 'stop' event follows the last 'dataavailable'
      } catch {
        onRecorderStop(st.recorder);
      }
    }

    function onRecorderStop(recorder) {
      if (st.recorder !== recorder) return;
      st.recorder = null;
      clearInterval(tick);
      releaseMic();
      if (st.closed) return;
      const type = (recorder.mimeType || pickRecorderMime() || 'audio/webm').split(';')[0].trim();
      const blob = new Blob(st.chunks, { type });
      st.chunks = [];
      if (!blob.size) {
        st.phase = 'idle';
        render();
        showError('Aucun son n’a été enregistré. Réessaie.');
        return;
      }
      let label = 'Écoute l’enregistrement, puis valide.';
      if (st.autoStopped) label = `Durée maximale atteinte (${formatDuration(MAX_RECORD_MS)}). ${label}`;
      else if (st.interrupted) label = `L’enregistrement a été interrompu. ${label}`;
      showPreview(blob, label);
    }

    function showPreview(blob, label) {
      clearResult();
      st.result = { blob, label };
      preview = createAudioButton(blob);
      preview.classList.add('is-large');
      previewSlot.replaceChildren(preview);
      st.phase = 'preview';
      render();
      updateTimer();
      try {
        okBtn.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }

    function restart() {
      if (st.phase !== 'preview') return;
      clearResult();
      showError('');
      st.elapsed = 0;
      updateTimer();
      st.phase = unavailable ? 'unavailable' : 'idle';
      render();
      if (unavailable) showError(unavailable);
      else recBtn.focus({ preventScroll: true });
    }

    function validate() {
      if (st.phase !== 'preview' || !st.result) return;
      close(st.result.blob);
    }

    async function importFile() {
      if (st.picking || st.phase === 'recording' || st.phase === 'requesting' || st.phase === 'stopping') return;
      st.picking = true;
      render();
      let file;
      try {
        file = await pickFile({ accept: 'audio/*' });
      } finally {
        st.picking = false;
        if (!st.closed) render();
      }
      if (!file || st.closed) return;
      const type = audioTypeOf(file);
      if (type && !type.startsWith('audio/') && !/^video\/(mp4|webm|ogg|quicktime)$/.test(type)) {
        showError('Ce fichier n’est pas un fichier audio.');
        return;
      }
      if (file.size > MAX_AUDIO_FILE_BYTES) {
        showError(`Fichier trop volumineux (${formatBytes(file.size)}). Maximum : ${formatBytes(MAX_AUDIO_FILE_BYTES)}.`);
        return;
      }
      if (!file.size) {
        showError('Ce fichier est vide.');
        return;
      }
      showError('');
      const blob = type === file.type ? file : new Blob([file], { type });
      st.elapsed = 0;
      showPreview(blob, `Fichier importé : ${file.name || 'audio'}`);
      timerEl.textContent = '–:––';
      const ms = await probeDuration(blob);
      if (st.closed || st.result?.blob !== blob) return;
      if (ms == null) {
        timerEl.textContent = '–:––';
        showError('Ce format audio risque de ne pas être lisible sur cet appareil.');
      } else {
        st.elapsed = ms;
        updateTimer();
      }
    }

    recBtn.addEventListener('click', () => {
      if (st.phase === 'recording') stopRecording();
      else startRecording();
    });

    // iOS cuts the microphone in the background: keep what was recorded so far.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && st.phase === 'recording') {
        st.interrupted = true;
        stopRecording();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    /* --- lifecycle --- */
    function close(result) {
      if (st.closed) return;
      st.closed = true;
      clearInterval(tick);
      const recorder = st.recorder;
      st.recorder = null;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      releaseMic();
      if (preview) preview.destroy();
      preview = null;
      document.removeEventListener('visibilitychange', onVisibility);
      closeOverlay(entry);
      resolve(result || null);
    }

    render();
    if (unavailable) showError(unavailable);
    const entry = openOverlay(root, {
      onEscape: () => close(null),
      initialFocus: unavailable ? importBtn : recBtn,
    });
  });
}
