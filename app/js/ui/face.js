// Read-only rendering of a card face (text + image + audio) with media lifecycle:
// object URLs are revoked and audio buttons destroyed when the view is destroyed.

import * as db from '../db.js';
import * as media from '../media.js';
import { h } from '../dom.js';
import { icon } from './icons.js';

/** CSS size modifier from the text length (long texts get smaller type). */
function textSizeClass(text) {
  const n = text.length;
  if (n > 420) return 'is-xs';
  if (n > 220) return 'is-sm';
  if (n > 90) return 'is-md';
  return '';
}

/**
 * Mount a face. Returns { el, destroy() }.
 */
export function mountFace(face, { className = '' } = {}) {
  const f = face || { text: '', imageId: null, audioId: null };
  const el = h('div', { class: ['face', className] });
  const disposers = [];
  let destroyed = false;

  const text = (f.text || '').trim();
  if (text) el.append(h('div', { class: ['face-text', textSizeClass(text)] }, text));

  if (f.imageId) {
    const img = h('img', { class: 'face-img', alt: text ? `Image : ${text.slice(0, 60)}` : 'Image de la carte', decoding: 'async' });
    const box = h('div', { class: 'face-img-box is-loading' }, img);
    el.append(box);
    db.getMedia(f.imageId)
      .then((blob) => {
        if (destroyed) return;
        box.classList.remove('is-loading');
        if (!blob) {
          box.replaceWith(h('div', { class: 'face-missing' }, icon('image', { size: 18 }), 'Image introuvable'));
          return;
        }
        const url = URL.createObjectURL(blob);
        disposers.push(() => URL.revokeObjectURL(url));
        img.src = url;
      })
      .catch(() => {
        if (!destroyed) box.replaceWith(h('div', { class: 'face-missing' }, 'Image indisponible'));
      });
  }

  if (f.audioId) {
    const slot = h('div', { class: 'face-audio' }, h('span', { class: 'audio-placeholder' }));
    el.append(slot);
    db.getMedia(f.audioId)
      .then((blob) => {
        if (destroyed) return;
        if (!blob) {
          slot.replaceChildren(h('div', { class: 'face-missing' }, icon('volume', { size: 18 }), 'Audio introuvable'));
          return;
        }
        const btn = media.createAudioButton(blob);
        disposers.push(() => {
          try {
            btn.destroy?.();
          } catch {
            /* ignore */
          }
        });
        slot.replaceChildren(btn);
      })
      .catch(() => {
        if (!destroyed) slot.replaceChildren(h('div', { class: 'face-missing' }, 'Audio indisponible'));
      });
  }

  if (!text && !f.imageId && !f.audioId) {
    el.append(h('div', { class: 'face-text is-empty' }, '(vide)'));
  }

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const d of disposers) d();
      disposers.length = 0;
    },
  };
}

/** One-line plain preview of a face for lists. */
export function facePreview(face) {
  const text = (face?.text || '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (face?.imageId) return 'Image';
  if (face?.audioId) return 'Audio';
  return '—';
}

/** True when one of the card's faces carries an image / an audio clip. */
export function cardHasImage(card) {
  return !!(card?.front?.imageId || card?.back?.imageId);
}
export function cardHasAudio(card) {
  return !!(card?.front?.audioId || card?.back?.audioId);
}
