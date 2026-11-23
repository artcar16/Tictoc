// Card editor: full-screen overlay usable from the library and from the study screen.
// openCardEditor({ cardId }) edits a card; openCardEditor({ folderId }) creates one.
// Resolves with the last saved Card, or null (cancelled / deleted).
//
// Media lifecycle: new photos/audio stay in memory (Blob) until « Enregistrer »; on save we
// putMedia() each new blob, write the card, THEN deleteMedia() the replaced/removed ids.
// Cancelling just drops the in-memory blobs. Object URLs / audio buttons are released on
// every re-render and on close.

import * as db from '../db.js';
import * as media from '../media.js';
import * as sel from '../selection.js';
import { h, autoGrow, prefersReducedMotion, nextFrame } from '../dom.js';
import { icon } from './icons.js';
import {
  iconButton,
  confirmDialog,
  pushLayer,
  popLayer,
  toast,
  showError,
  guard,
  folderOptions,
  errorMessage,
} from './components.js';

let pending = null;

/** Open the editor. Only one editor at a time: a second call returns the pending promise. */
export function openCardEditor(opts = {}) {
  if (pending) return pending;
  pending = runEditor(opts)
    .catch((err) => {
      showError(err);
      return null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

const FACE_KEYS = ['front', 'back'];
const FACE_LABELS = { front: 'Recto', back: 'Verso' };
const FACE_PLACEHOLDERS = {
  front: 'Ex. Résultat net',
  back: 'Ex. Résultat net = Total des produits − Total des charges',
};

/** Editable state of a face: media entries are { id: string|null (null = not saved yet), blob }. */
function faceState(face) {
  return {
    text: face?.text || '',
    image: face?.imageId ? { id: face.imageId, blob: null } : null,
    audio: face?.audioId ? { id: face.audioId, blob: null } : null,
    orig: { text: face?.text || '', imageId: face?.imageId || null, audioId: face?.audioId || null },
  };
}

async function loadBlobs(fs) {
  const jobs = [];
  for (const kind of ['image', 'audio']) {
    const entry = fs[kind];
    if (entry && entry.id && !entry.blob) {
      jobs.push(
        db
          .getMedia(entry.id)
          .then((blob) => {
            entry.blob = blob || null;
          })
          .catch(() => {
            entry.blob = null;
          }),
      );
    }
  }
  await Promise.all(jobs);
}

async function runEditor({ cardId = null, folderId = null } = {}) {
  const [folders, card] = await Promise.all([db.getFolders(), cardId ? db.getCard(cardId) : Promise.resolve(null)]);
  if (cardId && !card) {
    toast('Carte introuvable');
    return null;
  }
  const tree = sel.buildTree(folders, []);
  const initialFolder = card?.folderId || folderId || null;
  if (!initialFolder || !tree.folderById.has(initialFolder)) {
    if (!folders.length) {
      toast("Crée d'abord un dossier");
      return null;
    }
  }

  const st = {
    card, // null while creating
    folderId: initialFolder && tree.folderById.has(initialFolder) ? initialFolder : folders[0]?.id ?? null,
    origFolderId: card?.folderId ?? null,
    faces: { front: faceState(card?.front), back: faceState(card?.back) },
    lastSaved: null,
    saving: false,
  };
  await Promise.all(FACE_KEYS.map((k) => loadBlobs(st.faces[k])));

  return new Promise((resolve) => {
    /* --- media views lifecycle --- */
    const disposers = { front: [], back: [] };
    const disposeFace = (key) => {
      for (const d of disposers[key]) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      disposers[key] = [];
    };

    /* --- layout --- */
    const titleEl = h('h1', { class: 'editor-title' });
    const errorEl = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const body = h('div', { class: 'editor-body' });
    const foot = h('footer', { class: 'editor-foot' });
    const closeBtn = iconButton('close', 'Fermer', () => requestClose());
    const overlay = h(
      'div',
      { class: 'editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Éditeur de carte' },
      h('header', { class: 'editor-head' }, closeBtn, titleEl, h('span', { class: 'topbar-spacer' })),
      body,
      foot,
    );

    const textareas = {};
    const mediaBoxes = {};
    let folderSelect = null;
    const allButtons = () => Array.from(overlay.querySelectorAll('button, select, textarea'));

    function setSaving(on) {
      st.saving = on;
      overlay.classList.toggle('is-saving', on);
      for (const el of allButtons()) {
        if (el === closeBtn) continue;
        if (on) {
          el.dataset.wasDisabled = el.disabled ? '1' : '';
          el.disabled = true;
        } else {
          el.disabled = el.dataset.wasDisabled === '1';
          delete el.dataset.wasDisabled;
        }
      }
    }

    function showFormError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    }

    function isDirty() {
      if (st.card && st.folderId !== st.origFolderId) return true;
      for (const key of FACE_KEYS) {
        const fs = st.faces[key];
        if (fs.text !== fs.orig.text) return true;
        const imageId = fs.image ? fs.image.id || 'new' : null;
        const audioId = fs.audio ? fs.audio.id || 'new' : null;
        if (imageId !== fs.orig.imageId || audioId !== fs.orig.audioId) return true;
      }
      return false;
    }

    /* --- media area of a face --- */
    function renderMedia(key) {
      disposeFace(key);
      const fs = st.faces[key];
      const box = mediaBoxes[key];
      const items = [];

      if (fs.image) {
        let thumb;
        if (fs.image.blob) {
          const url = URL.createObjectURL(fs.image.blob);
          disposers[key].push(() => URL.revokeObjectURL(url));
          thumb = h('img', { class: 'media-thumb', src: url, alt: `Image du ${FACE_LABELS[key].toLowerCase()}` });
        } else {
          thumb = h('div', { class: 'media-thumb is-missing' }, icon('image', { size: 22 }), h('span', null, 'Image introuvable'));
        }
        const cropBtn = h('button', { type: 'button', class: 'btn btn-small btn-secondary', disabled: !fs.image.blob }, icon('crop', { size: 18 }), 'Recadrer');
        cropBtn.addEventListener(
          'click',
          guard(async () => {
            const blob = await media.cropImage(fs.image.blob);
            if (!blob) return;
            fs.image = { id: null, blob };
            renderMedia(key);
          }),
        );
        const delBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small btn-ghost is-danger',
            onClick: () => {
              fs.image = null;
              renderMedia(key);
            },
          },
          icon('trash', { size: 18 }),
          'Supprimer',
        );
        items.push(h('div', { class: 'media-item media-image' }, thumb, h('div', { class: 'media-item-actions' }, cropBtn, delBtn)));
      }

      if (fs.audio) {
        let player;
        if (fs.audio.blob) {
          player = media.createAudioButton(fs.audio.blob);
          disposers[key].push(() => player.destroy?.());
        } else {
          player = h('span', { class: 'muted' }, 'Audio introuvable');
        }
        const delBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small btn-ghost is-danger',
            onClick: () => {
              fs.audio = null;
              renderMedia(key);
            },
          },
          icon('trash', { size: 18 }),
          'Supprimer',
        );
        items.push(
          h(
            'div',
            { class: 'media-item media-audio' },
            player,
            h('span', { class: 'media-audio-label' }, icon('volume', { size: 18 }), 'Audio'),
            delBtn,
          ),
        );
      }
      box.replaceChildren(...items);
      box.hidden = !items.length;
      showFormError('');
    }

    /* --- one face section --- */
    function faceSection(key) {
      const fs = st.faces[key];
      const label = FACE_LABELS[key];
      const taId = `ed-${key}`;
      const ta = h('textarea', {
        id: taId,
        class: 'input editor-text',
        rows: 2,
        placeholder: FACE_PLACEHOLDERS[key],
        value: fs.text,
        autocapitalize: 'sentences',
      });
      ta.addEventListener('input', () => {
        fs.text = ta.value;
        showFormError('');
      });
      autoGrow(ta, { min: 56 });
      textareas[key] = ta;
      mediaBoxes[key] = h('div', { class: 'media-box' });

      const captureImage = (source) =>
        guard(async () => {
          const blob = await media.captureImage({ source });
          if (!blob) return;
          fs.image = { id: null, blob };
          renderMedia(key);
        });
      const photoBtn = h('button', { type: 'button', class: 'btn btn-small btn-secondary' }, icon('camera', { size: 18 }), 'Photo');
      photoBtn.addEventListener('click', captureImage('camera'));
      const galleryBtn = h('button', { type: 'button', class: 'btn btn-small btn-secondary' }, icon('image', { size: 18 }), 'Galerie');
      galleryBtn.addEventListener('click', captureImage('gallery'));
      const audioBtn = h('button', { type: 'button', class: 'btn btn-small btn-secondary' }, icon('mic', { size: 18 }), 'Audio');
      audioBtn.addEventListener(
        'click',
        guard(async () => {
          const blob = await media.captureAudio();
          if (!blob) return;
          fs.audio = { id: null, blob };
          renderMedia(key);
        }),
      );

      const section = h(
        'section',
        { class: 'editor-face' },
        h('label', { class: 'editor-face-label', htmlFor: taId }, label),
        ta,
        mediaBoxes[key],
        h('div', { class: 'media-buttons' }, photoBtn, galleryBtn, audioBtn),
      );
      renderMedia(key);
      return section;
    }

    /* --- whole form (re-run after « Enregistrer et nouvelle ») --- */
    function renderForm() {
      disposeFace('front');
      disposeFace('back');
      titleEl.textContent = st.card ? 'Modifier la carte' : 'Nouvelle carte';
      folderSelect = h('select', { id: 'ed-folder', class: 'input' }, folderOptions(tree, st.folderId));
      folderSelect.addEventListener('change', () => {
        st.folderId = folderSelect.value;
      });

      const parts = [
        faceSection('front'),
        faceSection('back'),
        h('section', { class: 'editor-folder' }, h('label', { class: 'field-label', htmlFor: 'ed-folder' }, 'Dossier'), folderSelect),
        errorEl,
      ];
      if (st.card) {
        const delBtn = h('button', { type: 'button', class: 'btn btn-ghost is-danger btn-block' }, icon('trash', { size: 18 }), 'Supprimer la carte');
        delBtn.addEventListener('click', guard(deleteCard));
        parts.push(h('div', { class: 'editor-danger' }, delBtn));
      }
      body.replaceChildren(...parts);
      body.scrollTop = 0;

      const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Enregistrer');
      saveBtn.addEventListener('click', guard(() => save({ andNew: false })));
      const btns = [];
      if (!st.card) {
        const saveNewBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-lg' }, 'Enregistrer et nouvelle');
        saveNewBtn.addEventListener('click', guard(() => save({ andNew: true })));
        btns.push(saveNewBtn);
      }
      btns.push(saveBtn);
      foot.replaceChildren(...btns);
      foot.classList.toggle('has-two', btns.length === 2);
    }

    /* --- save --- */
    async function save({ andNew }) {
      if (st.saving) return;
      for (const key of FACE_KEYS) {
        const fs = st.faces[key];
        if (!fs.text.trim() && !fs.image && !fs.audio) {
          const which = key === 'front' ? 'Le recto' : 'Le verso';
          showFormError(`${which} est vide : ajoute un texte, une photo ou un audio.`);
          textareas[key].focus();
          return;
        }
      }
      if (!st.folderId) {
        showFormError('Choisis un dossier.');
        return;
      }

      setSaving(true);
      const created = []; // media written during this save (removed again if the save fails)
      try {
        const faces = {};
        for (const key of FACE_KEYS) {
          const fs = st.faces[key];
          const face = { text: fs.text.trim(), imageId: null, audioId: null };
          for (const kind of ['image', 'audio']) {
            const entry = fs[kind];
            if (!entry) continue;
            let mediaId = entry.id;
            if (!mediaId) {
              mediaId = await db.putMedia(entry.blob);
              created.push(mediaId);
            }
            face[`${kind}Id`] = mediaId;
          }
          faces[key] = face;
        }

        let saved;
        if (st.card) {
          const patch = { front: faces.front, back: faces.back };
          if (st.folderId !== st.card.folderId) patch.folderId = st.folderId;
          saved = await db.updateCard(st.card.id, patch);
        } else {
          saved = await db.createCard({ folderId: st.folderId, front: faces.front, back: faces.back });
        }
        created.length = 0; // the card now references them

        // Only now delete media that were replaced or removed.
        const keep = new Set();
        for (const key of FACE_KEYS) {
          if (faces[key].imageId) keep.add(faces[key].imageId);
          if (faces[key].audioId) keep.add(faces[key].audioId);
        }
        for (const key of FACE_KEYS) {
          for (const oldId of [st.faces[key].orig.imageId, st.faces[key].orig.audioId]) {
            if (oldId && !keep.has(oldId)) {
              try {
                await db.deleteMedia(oldId);
              } catch {
                /* an orphan media is harmless */
              }
            }
          }
        }

        st.lastSaved = saved || null;
        if (andNew) {
          toast('Carte enregistrée');
          st.card = null;
          st.origFolderId = null;
          st.faces = { front: faceState(null), back: faceState(null) };
          setSaving(false);
          renderForm();
          textareas.front.focus();
          return;
        }
        setSaving(false);
        toast(st.card ? 'Carte enregistrée' : 'Carte ajoutée');
        close(st.lastSaved);
      } catch (err) {
        for (const mediaId of created) {
          try {
            await db.deleteMedia(mediaId);
          } catch {
            /* ignore */
          }
        }
        setSaving(false);
        showFormError(`Enregistrement impossible : ${errorMessage(err)}`);
        throw err;
      }
    }

    /* --- delete --- */
    async function deleteCard() {
      if (!st.card) return;
      const ok = await confirmDialog({
        title: 'Supprimer la carte ?',
        message: 'La carte, ses photos et audios, et sa progression seront supprimés.',
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) return;
      setSaving(true);
      try {
        await db.deleteCard(st.card.id);
      } finally {
        setSaving(false);
      }
      toast('Carte supprimée');
      close(null);
    }

    /* --- close --- */
    let closed = false;
    // Escape / Android back ask before dropping changes; a route change does not close the editor.
    const layer = { el: overlay, onEscape: () => requestClose(), keepOnNavigate: true };

    async function requestClose() {
      if (st.saving || closed) return;
      if (isDirty()) {
        const ok = await confirmDialog({
          title: 'Abandonner les modifications ?',
          message: 'Les changements non enregistrés seront perdus.',
          confirmLabel: 'Abandonner',
          cancelLabel: 'Continuer',
          danger: true,
        });
        if (!ok) return;
      }
      close(st.lastSaved);
    }

    function close(result) {
      if (closed) return;
      closed = true;
      disposeFace('front');
      disposeFace('back');
      document.removeEventListener('keydown', onKey, true);
      popLayer(layer);
      overlay.classList.remove('is-open');
      overlay.classList.add('is-closing');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.inert = true;
      setTimeout(() => overlay.remove(), prefersReducedMotion() ? 0 : 220);
      resolve(result);
    }

    // Ctrl/Cmd + Enter saves.
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && overlay.isConnected) {
        e.preventDefault();
        guard(() => save({ andNew: false }))();
      }
    };
    document.addEventListener('keydown', onKey, true);

    renderForm();
    document.body.appendChild(overlay);
    pushLayer(layer);
    // Focus right away (never later: it could steal focus from a field the user already chose).
    if (!st.card) textareas.front.focus({ preventScroll: true });
    else closeBtn.focus({ preventScroll: true });
    nextFrame().then(() => overlay.classList.add('is-open'));
  });
}
