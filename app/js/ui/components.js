// Reusable UI components: toasts, dialogs, action sheets, folder picker, headers,
// empty states, plus small helpers for async handlers.

import { h, nextFrame, prefersReducedMotion, frSpaces } from '../dom.js';
import { watchClose } from '../back.js';
import { icon } from './icons.js';

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastRoot = null;
let toastTimer = null;

/** Show a short message at the bottom of the screen (one at a time). */
export function toast(message, { duration = 2600 } = {}) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toast-root', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast' }, frSpaces(message));
  toastRoot.replaceChildren(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/** Human readable error message. */
export function errorMessage(err) {
  if (!err) return 'inconnue';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    // Storage full: browsers report it with a technical English name (and often no message).
    if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22) {
      return 'plus assez d’espace de stockage sur ce téléphone. Libère de la place (photos, vidéos, applis) puis réessaie ; les données déjà enregistrées ne sont pas touchées';
    }
    // Safari: lost connection to its storage process, or a full disk.
    if (err.name === 'UnknownError') {
      return 'le stockage du navigateur a rencontré une erreur. Ferme et rouvre l’application puis réessaie ; si cela continue, le téléphone manque peut-être d’espace';
    }
  }
  return err.message || err.name || String(err);
}

/** Toast « Erreur : … » (and keep a trace in the console). */
export function showError(err) {
  console.warn('[recto]', err);
  toast(`Erreur : ${errorMessage(err)}`, { duration: 4200 });
}

/**
 * Wrap an async event handler: ignores re-entrant calls, disables the busy buttons while
 * running (the clicked button by default) and turns exceptions into an error toast.
 */
export function guard(fn, { busy } = {}) {
  let running = false;
  return async (ev) => {
    if (running) return undefined;
    running = true;
    let buttons = [];
    if (typeof busy === 'function') buttons = busy() || [];
    else if (Array.isArray(busy)) buttons = busy;
    else if (ev && ev.currentTarget instanceof HTMLButtonElement) buttons = [ev.currentTarget];
    const previous = buttons.map((b) => b.disabled);
    buttons.forEach((b) => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });
    try {
      return await fn(ev);
    } catch (err) {
      showError(err);
      return undefined;
    } finally {
      running = false;
      buttons.forEach((b, i) => {
        b.disabled = previous[i];
        b.removeAttribute('aria-busy');
      });
    }
  };
}

/** Run async tasks strictly one after the other (DB writes that must keep their order). */
export function serialQueue(onError = showError) {
  let chain = Promise.resolve();
  const run = (task) => {
    const p = chain.then(task);
    chain = p.catch((err) => onError(err));
    return chain;
  };
  run.idle = () => chain;
  return run;
}

/* ------------------------------------------------------------------ */
/* Layers (modal stack, Escape key, scroll lock)                        */
/* ------------------------------------------------------------------ */

const layers = [];

/** True while a dialog, sheet or the card editor is open. */
export function isOverlayOpen() {
  return layers.length > 0;
}

/**
 * Register an overlay. `onEscape` is called when Escape is pressed while it is on top, and for the
 * Android back button / gesture (see back.js). `keepOnNavigate`: survives a route change (the card
 * editor keeps its unsaved card; dialogs and sheets belong to the screen that opened them).
 */
export function pushLayer(layer) {
  layer.restoreFocus = document.activeElement;
  layers.push(layer);
  document.documentElement.classList.add('has-overlay');
  watchBack(layer);
  return layer;
}

/** Close the layer on Android back; watch again if it refused to close (« Continuer »). */
function watchBack(layer) {
  layer.unwatch = watchClose(async () => {
    layer.unwatch = null;
    try {
      await layer.onEscape?.();
    } catch (err) {
      showError(err);
    }
    if (layers.includes(layer) && !layer.unwatch) watchBack(layer);
  });
}

export function popLayer(layer) {
  layer.unwatch?.();
  layer.unwatch = null;
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  if (!layers.length) document.documentElement.classList.remove('has-overlay');
  const f = layer.restoreFocus;
  if (f && f.isConnected && typeof f.focus === 'function') {
    try {
      f.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Cancel the open dialogs and sheets (the card editor stays): called when the screen changes under
 * them (back without CloseWatcher support), so their actions never run against a screen that is gone.
 */
export function closeTransientLayers() {
  for (const layer of [...layers].reverse()) {
    if (layer.keepOnNavigate || !layers.includes(layer)) continue;
    try {
      layer.onEscape?.();
    } catch (err) {
      console.warn('[recto] close layer', err);
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length) return;
  const top = layers[layers.length - 1];
  // Media overlays (cropper/recorder) sit above our layers and handle Escape themselves.
  const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  if (hit && top.el && !top.el.contains(hit)) return;
  e.preventDefault();
  top.onEscape?.();
});

/** Animate an overlay element in (adds .is-open on the next frame). */
async function animateIn(el) {
  await nextFrame();
  el.classList.add('is-open');
}

/** Animate out then remove (hidden from assistive tech and inert while fading). */
function animateOut(el) {
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
  const delay = prefersReducedMotion() ? 0 : 220;
  setTimeout(() => el.remove(), delay);
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function baseDialog({ title, describedBy, className = '' }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  const box = h('div', {
    class: ['dialog', className],
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': title ? titleId : null,
    'aria-describedby': describedBy || null,
  });
  if (title) box.append(h('h2', { class: 'dialog-title', id: titleId }, frSpaces(title)));
  const backdrop = h('div', { class: 'dialog-backdrop' }, box);
  return { backdrop, box };
}

/** Confirmation dialog → Promise<boolean>. */
export function confirmDialog({
  title,
  message = '',
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const msgId = `msg-${Math.random().toString(36).slice(2, 9)}`;
    const { backdrop, box } = baseDialog({ title, describedBy: message ? msgId : null });
    let done = false;
    const layer = { el: backdrop, onEscape: () => close(false) };
    const close = (value) => {
      if (done) return;
      done = true;
      popLayer(layer);
      animateOut(backdrop);
      resolve(value);
    };
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => close(false) }, cancelLabel);
    const okBtn = h(
      'button',
      { type: 'button', class: ['btn', danger ? 'btn-danger' : 'btn-primary'], onClick: () => close(true) },
      confirmLabel,
    );
    if (message) box.append(h('p', { class: 'dialog-message', id: msgId }, frSpaces(message)));
    box.append(h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    document.body.appendChild(backdrop);
    pushLayer(layer);
    animateIn(backdrop);
    (danger ? cancelBtn : okBtn).focus({ preventScroll: true });
  });
}

/** Text prompt → Promise<string|null> (trimmed, never empty). */
export function promptDialog({
  title,
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'Valider',
  cancelLabel = 'Annuler',
  maxLength = 200,
} = {}) {
  return new Promise((resolve) => {
    const { backdrop, box } = baseDialog({ title });
    let done = false;
    const layer = { el: backdrop, onEscape: () => close(null) };
    const close = (v) => {
      if (done) return;
      done = true;
      input.blur();
      popLayer(layer);
      animateOut(backdrop);
      resolve(v);
    };
    const inputId = `in-${Math.random().toString(36).slice(2, 9)}`;
    const input = h('input', {
      id: inputId,
      class: 'input',
      type: 'text',
      value,
      placeholder,
      maxlength: maxLength,
      autocomplete: 'off',
      enterkeyhint: 'done',
    });
    const okBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, confirmLabel);
    const sync = () => {
      okBtn.disabled = !input.value.trim();
    };
    input.addEventListener('input', sync);
    sync();
    const form = h(
      'form',
      {
        class: 'dialog-form',
        onSubmit: (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (v) close(v);
        },
      },
      label ? h('label', { class: 'field-label', htmlFor: inputId }, frSpaces(label)) : null,
      input,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => close(null) }, cancelLabel),
        okBtn,
      ),
    );
    box.append(form);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.appendChild(backdrop);
    pushLayer(layer);
    animateIn(backdrop);
    input.focus({ preventScroll: true });
    input.select();
  });
}

/* ------------------------------------------------------------------ */
/* Bottom sheets                                                       */
/* ------------------------------------------------------------------ */

function baseSheet({ title, className = '' }) {
  const sheet = h('div', { class: ['sheet', className], role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Menu' });
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);
  if (title) sheet.append(h('div', { class: 'sheet-title' }, frSpaces(title)));
  return { backdrop, sheet };
}

/**
 * Action sheet. items: [{ label, icon?, danger?, disabled?, onSelect }].
 * Resolves once closed (after the selected item's onSelect has run).
 */
export function actionSheet(items, { title = '' } = {}) {
  return new Promise((resolve) => {
    const { backdrop, sheet } = baseSheet({ title });
    let done = false;
    const layer = { el: backdrop, onEscape: () => close(null) };
    const close = async (item) => {
      if (done) return;
      done = true;
      popLayer(layer);
      animateOut(backdrop);
      if (item && typeof item.onSelect === 'function') {
        try {
          await item.onSelect();
        } catch (err) {
          showError(err);
        }
      }
      resolve(item || null);
    };
    const group = h('div', { class: 'sheet-group' });
    for (const item of items.filter(Boolean)) {
      group.append(
        h(
          'button',
          {
            type: 'button',
            class: ['sheet-item', item.danger && 'is-danger'],
            disabled: !!item.disabled,
            onClick: () => close(item),
          },
          item.icon ? icon(item.icon) : null,
          h('span', null, item.label),
        ),
      );
    }
    const cancel = h(
      'div',
      { class: 'sheet-group' },
      h('button', { type: 'button', class: 'sheet-item sheet-cancel', onClick: () => close(null) }, 'Annuler'),
    );
    sheet.append(group, cancel);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.appendChild(backdrop);
    pushLayer(layer);
    animateIn(backdrop);
    group.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
  });
}

/**
 * Pick a folder (or the root) in a sheet.
 * tree: selection.buildTree result. disabledIds: Set of ids that cannot be chosen.
 * Resolves { id: string|null } or null when cancelled.
 */
export function pickFolder({ title = 'Choisir un dossier', tree, disabledIds = new Set(), currentId, allowRoot = true }) {
  return new Promise((resolve) => {
    const { backdrop, sheet } = baseSheet({ title, className: 'sheet-tall' });
    let done = false;
    const layer = { el: backdrop, onEscape: () => close(null) };
    const close = (v) => {
      if (done) return;
      done = true;
      popLayer(layer);
      animateOut(backdrop);
      resolve(v);
    };
    const list = h('div', { class: 'sheet-group sheet-scroll' });
    const row = (id, label, depth, isRoot) => {
      const disabled = id === currentId || (!isRoot && disabledIds.has(id));
      return h(
        'button',
        {
          type: 'button',
          class: ['sheet-item', 'folder-pick', id === currentId && 'is-current'],
          style: { paddingLeft: `${16 + depth * 18}px` },
          disabled,
          onClick: () => close({ id }),
        },
        icon(isRoot ? 'layers' : 'folder', { size: 20 }),
        h('span', { class: 'ellipsis' }, label),
        id === currentId ? h('span', { class: 'folder-pick-note' }, 'actuel') : null,
      );
    };
    if (allowRoot) list.append(row(null, 'Racine', 0, true));
    for (const { folder, depth } of flattenFolders(tree)) {
      list.append(row(folder.id, folder.name, depth + (allowRoot ? 1 : 0), false));
    }
    sheet.append(
      list,
      h(
        'div',
        { class: 'sheet-group' },
        h('button', { type: 'button', class: 'sheet-item sheet-cancel', onClick: () => close(null) }, 'Annuler'),
      ),
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.appendChild(backdrop);
    pushLayer(layer);
    animateIn(backdrop);
  });
}

/** Depth-first list of folders: [{ folder, depth }] (siblings in tree order). */
export function flattenFolders(tree) {
  const out = [];
  const walk = (parentId, depth) => {
    for (const f of tree.childrenOf.get(parentId) || []) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** <option> elements for a folder <select> (indented with non-breaking spaces). */
export function folderOptions(tree, selectedId, { rootLabel = null } = {}) {
  const opts = [];
  if (rootLabel !== null) opts.push(h('option', { value: '', selected: !selectedId }, rootLabel));
  for (const { folder, depth } of flattenFolders(tree)) {
    const indent = '   '.repeat(depth + (rootLabel !== null ? 1 : 0));
    opts.push(h('option', { value: folder.id, selected: folder.id === selectedId }, `${indent}${folder.name}`));
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Layout pieces                                                       */
/* ------------------------------------------------------------------ */

/** Round icon-only button with an accessible label. */
export function iconButton(name, label, onClick, { className = '', size = 22 } = {}) {
  return h(
    'button',
    { type: 'button', class: ['icon-btn', className], 'aria-label': label, title: label, onClick },
    icon(name, { size }),
  );
}

/**
 * Sticky top bar for nested screens.
 * back: a function (called on tap) or null. actions: extra nodes on the right.
 */
export function topbar({ title, onBack = null, actions = [], subtitle = '' }) {
  return h(
    'header',
    { class: 'topbar' },
    onBack ? iconButton('back', 'Retour', onBack, { className: 'topbar-back' }) : h('span', { class: 'topbar-spacer' }),
    h(
      'div',
      { class: 'topbar-titles' },
      h('h1', { class: 'topbar-title' }, title),
      subtitle ? h('div', { class: 'topbar-subtitle' }, subtitle) : null,
    ),
    h('div', { class: 'topbar-actions' }, actions),
  );
}

/** Large title used at the top of each tab root. */
export function pageHead({ title, subtitle = '', actions = [] }) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', { class: 'page-head-text' }, h('h1', { class: 'page-title' }, title), subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-head-actions' }, actions) : null,
  );
}

/** Calm empty state block. */
export function emptyState({ iconName = 'info', title, text = '', actions = [] }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 26 })),
    h('h2', { class: 'empty-title' }, frSpaces(title)),
    text ? h('p', { class: 'empty-text' }, frSpaces(text)) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null,
  );
}

/** Loading placeholder shown while a screen fetches its data. */
export function loadingBlock() {
  return h('div', { class: 'loading', 'aria-busy': 'true' }, h('span', { class: 'spinner' }), 'Chargement…');
}

/** Error block when a screen cannot load. */
export function errorBlock(err, onRetry) {
  return emptyState({
    iconName: 'alert',
    title: 'Impossible de charger les données',
    text: errorMessage(err),
    actions: onRetry ? [h('button', { type: 'button', class: 'btn btn-secondary', onClick: onRetry }, 'Réessayer')] : [],
  });
}

/* ------------------------------------------------------------------ */
/* iPhone: Safari tab vs app added to the Home Screen                  */
/* ------------------------------------------------------------------ */

/**
 * True in an iPhone / iPad browser tab, false in the app added to the Home Screen and on other
 * systems (navigator.standalone only exists in iOS WebKit). The two have separate storage, and
 * Safari erases a site's data after 7 days of use without a visit (Home Screen apps are exempt).
 */
export function isIOSBrowserTab() {
  return typeof navigator !== 'undefined' && navigator.standalone === false;
}

/** Calm notice asking to install the app before relying on it (see isIOSBrowserTab). */
export function iosTabNotice({ hasCards = false, onDismiss = null } = {}) {
  const text =
    "Sur iPhone, ajoute Recto à l'écran d'accueil (Partager → Sur l'écran d'accueil) et utilise toujours l'app installée : " +
    "dans Safari, les données peuvent être effacées après 7 jours sans visite, et l'app installée a ses propres données." +
    (hasCards ? " Exporte d'abord une sauvegarde ici (onglet Données), puis restaure-la dans l'app installée." : '');
  const el = h('div', { class: 'notice is-info ios-notice', role: 'note' }, icon('info', { size: 18 }), h('p', { class: 'notice-text' }, frSpaces(text)));
  if (onDismiss) {
    el.append(
      iconButton(
        'close',
        'Masquer ce message',
        () => {
          el.remove();
          onDismiss();
        },
        { className: 'notice-close', size: 18 },
      ),
    );
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

/** Copy text to the clipboard (with a fallback for older / non-secure contexts). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = h('textarea', {
    value: text,
    readonly: true,
    style: { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none', fontSize: '16px' },
  });
  document.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok) throw new Error('copie impossible sur cet appareil');
  return true;
}
