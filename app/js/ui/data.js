// « Données » tab: JSON import (preview + merge), format & AI prompt, backup / restore,
// storage info and the danger zone.

import * as db from '../db.js';
import * as sel from '../selection.js';
import * as importer from '../importer.js';
import * as format from '../format.js';
import * as media from '../media.js';
import { plural, formatBytes } from '../util.js';
import { h, frSpaces } from '../dom.js';
import { icon } from './icons.js';
import { pageHead, confirmDialog, guard, toast, copyText, folderOptions, errorMessage, isIOSBrowserTab, iosTabNotice } from './components.js';

export const APP_VERSION = '1.0.0';

const PERSIST_ASKED_KEY = 'persistRequested';
const LAST_BACKUP_KEY = 'lastBackupAt';
// A chosen file bigger than this (characters) is analysed without being put in the text box:
// a huge text there freezes the phone for seconds.
const MAX_TEXTAREA_CHARS = 1_000_000;

function section(title, iconName, ...children) {
  return h(
    'section',
    { class: 'data-section' },
    h('h2', { class: 'data-title' }, h('span', { class: 'data-title-icon' }, icon(iconName, { size: 18 })), title),
    ...children,
  );
}

function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isMobileDevice() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function sinceLabel(ms) {
  if (!ms) return "Aucune sauvegarde exportée pour l'instant.";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "Dernière sauvegarde : aujourd'hui.";
  if (days === 1) return 'Dernière sauvegarde : hier.';
  return `Dernière sauvegarde : il y a ${days} jours.`;
}

export async function renderData(root, ctx) {
  const [folders, cards, methods, lastBackup] = await Promise.all([
    db.getFolders(),
    db.getCards(),
    db.getMethods(),
    db.getMeta(LAST_BACKUP_KEY, null).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  const tree = sel.buildTree(folders, cards);
  const state = ctx.state;

  root.append(pageHead({ title: 'Données', subtitle: 'Import, sauvegarde et stockage' }));
  if (isIOSBrowserTab()) root.append(iosTabNotice({ hasCards: cards.length > 0 }));

  /* ---------------------------------------------------------------- */
  /* 1. Import                                                         */
  /* ---------------------------------------------------------------- */
  const queryDest = ctx.query.get('dest');
  if (state.dest === undefined) state.dest = queryDest && tree.folderById.has(queryDest) ? queryDest : '';
  if (state.dest && !tree.folderById.has(state.dest)) state.dest = '';

  const destSelect = h('select', { id: 'imp-dest', class: 'input' }, folderOptions(tree, state.dest || null, { rootLabel: 'Racine' }));
  const textarea = h('textarea', {
    id: 'imp-text',
    class: 'input code-input',
    rows: 8,
    placeholder: 'Colle ton JSON ici',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    value: state.text || '',
  });
  const preview = h('div', { class: 'import-preview', 'aria-live': 'polite' });
  const analyseBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Analyser');
  const fileBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('file', { size: 18 }), 'Choisir un fichier .json');
  const canPaste = !!(navigator.clipboard && typeof navigator.clipboard.readText === 'function' && window.isSecureContext);
  const pasteBtn = canPaste ? h('button', { type: 'button', class: 'btn btn-secondary' }, icon('paste', { size: 18 }), 'Coller') : null;

  let parsed = null; // last successful parseImport result
  let parsedFile = null; // name of the (large) file `parsed` comes from, when not in the text box
  const resultBox = h('div');

  const resetPreview = () => {
    parsed = null;
    parsedFile = null;
    preview.replaceChildren();
  };

  /** Show the import summary for the current text & destination. */
  function showPlan() {
    if (!parsed) return;
    let plan;
    try {
      plan = importer.planImport(parsed.tree, { targetFolderId: destSelect.value || null, folders, cards });
    } catch (err) {
      preview.replaceChildren(h('div', { class: 'notice is-error' }, icon('alert', { size: 18 }), h('span', null, errorMessage(err))));
      return;
    }
    const s = plan.summary;
    const cell = (n, label) => h('div', { class: 'sum-cell' }, h('div', { class: 'sum-value' }, String(n)), h('div', { class: 'sum-label' }, label));
    // Cards kept because they were corrected in the app are not something to import.
    const nothing = !s.foldersNew && !s.cardsNew && !s.cardsUpdated;
    const importBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block btn-lg', disabled: nothing }, icon('download', { size: 20 }), 'Importer');
    importBtn.addEventListener('click', guard(() => doImport(), { busy: [importBtn, analyseBtn] }));
    const warnings = [...(parsed.warnings || []), ...(plan.warnings || [])];
    const kept = (plan.keptCards || []).length;
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const list = (items, render) => [
      h('ul', null, items.slice(0, 200).map(render)),
      items.length > 200 ? h('p', { class: 'muted' }, `… et ${items.length - 200} autres.`) : null,
    ];
    preview.replaceChildren(
      h(
        'div',
        { class: 'preview-card' },
        h('div', { class: 'preview-title' }, "Aperçu de l'import"),
        parsedFile ? h('p', { class: 'hint import-file' }, icon('file', { size: 16 }), parsedFile) : null,
        h(
          'div',
          { class: 'sum-grid' },
          cell(s.foldersNew, s.foldersNew > 1 ? 'dossiers créés' : 'dossier créé'),
          cell(s.foldersReused, s.foldersReused > 1 ? 'dossiers réutilisés' : 'dossier réutilisé'),
          cell(s.cardsNew, s.cardsNew > 1 ? 'cartes nouvelles' : 'carte nouvelle'),
          cell(s.cardsUpdated, s.cardsUpdated > 1 ? 'mises à jour' : 'mise à jour'),
          cell(s.cardsUnchanged, s.cardsUnchanged > 1 ? 'inchangées' : 'inchangée'),
        ),
        plan.updatedCards.length
          ? h(
              'details',
              { class: 'warnings is-info import-updates', open: plan.updatedCards.length <= 5 },
              h('summary', null, icon('edit', { size: 16 }), `${plural(plan.updatedCards.length, 'verso remplacé', 'versos remplacés')} par celui du fichier`),
              ...list(plan.updatedCards, (u) => {
                const card = cardById.get(u.id);
                return h(
                  'li',
                  null,
                  h('strong', null, card ? card.front.text || '(sans texte)' : '?'),
                  ' : ',
                  h('span', { class: 'change-old' }, card ? card.back.text || '(vide)' : ''),
                  ' → ',
                  u.back,
                );
              }),
            )
          : null,
        kept
          ? h(
              'p',
              { class: 'hint import-kept' },
              `${plural(kept, 'carte corrigée', 'cartes corrigées')} dans l’app : ${kept > 1 ? 'leurs versos sont conservés' : 'son verso est conservé'}.`,
            )
          : null,
        warnings.length
          ? h(
              'details',
              { class: 'warnings', open: warnings.length <= 5 },
              h('summary', null, icon('alert', { size: 16 }), plural(warnings.length, 'avertissement')),
              ...list(warnings, (w) => h('li', null, w)),
            )
          : null,
        nothing ? h('p', { class: 'hint' }, 'Rien de nouveau : toutes ces cartes sont déjà présentes.') : null,
        importBtn,
      ),
    );
  }

  /** Parse `text` (the text box by default; `fileName` when it comes from a file not shown there). */
  function analyse(text = textarea.value, fileName = null) {
    state.importResult = null;
    if (!text.trim()) {
      resetPreview();
      preview.replaceChildren(h('div', { class: 'notice is-error' }, icon('alert', { size: 18 }), h('span', null, "Colle d'abord ton JSON, ou choisis un fichier.")));
      return;
    }
    const res = importer.parseImport(text);
    if (!res.ok) {
      parsed = null;
      parsedFile = null;
      preview.replaceChildren(h('div', { class: 'notice is-error' }, icon('alert', { size: 18 }), h('span', null, frSpaces(res.error))));
      return;
    }
    parsed = res;
    parsedFile = fileName;
    showPlan();
  }

  /** A full backup chosen in the import picker: say so, and offer to restore it from here. */
  function showBackupFound(backup) {
    textarea.value = '';
    state.text = '';
    state.importResult = null;
    resultBox.replaceChildren();
    resetPreview();
    const restoreHere = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('upload', { size: 18 }), 'Restaurer cette sauvegarde');
    restoreHere.addEventListener('click', guard(() => restoreFrom(backup)));
    preview.replaceChildren(
      h(
        'div',
        { class: 'notice is-error' },
        icon('alert', { size: 18 }),
        h('span', null, frSpaces('Ce fichier est une sauvegarde complète, pas des cartes à importer. Pour remplacer tout le contenu par cette sauvegarde : « Restaurer cette sauvegarde ».')),
      ),
      h('div', { class: 'btn-row' }, restoreHere),
    );
  }

  async function doImport() {
    if (!parsed) return;
    const target = destSelect.value || null;
    // Re-plan against the latest data right before writing.
    const [curFolders, curCards] = await Promise.all([db.getFolders(), db.getCards()]);
    const plan = importer.planImport(parsed.tree, { targetFolderId: target, folders: curFolders, cards: curCards });
    const res = await db.applyImportPlan(plan);
    // Ask once for persistent storage after the first import.
    try {
      if (!(await db.getMeta(PERSIST_ASKED_KEY, false))) {
        await db.setMeta(PERSIST_ASKED_KEY, true);
        await db.requestPersistence();
      }
    } catch {
      /* best effort */
    }
    const parts = [];
    if (res.cardsCreated) parts.push(plural(res.cardsCreated, 'carte ajoutée', 'cartes ajoutées'));
    if (res.cardsUpdated) parts.push(plural(res.cardsUpdated, 'carte mise à jour', 'cartes mises à jour'));
    if (res.foldersCreated) parts.push(plural(res.foldersCreated, 'dossier créé', 'dossiers créés'));
    if (res.cardsKept) parts.push(plural(res.cardsKept, 'carte corrigée conservée', 'cartes corrigées conservées'));
    toast(parts.length ? `Import terminé : ${parts.join(', ')}` : 'Import terminé');
    state.text = '';
    state.dest = target || '';
    state.importResult = { target, message: parts.join(' · ') || 'Aucun changement', reveal: true };
    if (ctx.alive()) ctx.refresh();
  }

  textarea.addEventListener('input', () => {
    state.text = textarea.value;
    state.importResult = null;
    resultBox.replaceChildren();
    if (parsed) resetPreview();
  });
  destSelect.addEventListener('change', () => {
    state.dest = destSelect.value;
    if (parsed) showPlan();
  });
  analyseBtn.addEventListener('click', () => analyse());
  fileBtn.addEventListener(
    'click',
    guard(async () => {
      const file = await media.pickFile({ accept: '.json,application/json,text/plain' });
      if (!file) return;
      // A backup is a .json too: recognised without loading it (it can weigh 100 MB with photos);
      // db.openBackupFile reads only the beginning of the backups this app exports.
      const backup = await db.openBackupFile(file).catch(() => null); // not JSON: a text to analyse
      if (!ctx.alive()) return;
      if (backup && importer.isBackupObject(backup.head)) {
        showBackupFound(backup);
        return;
      }
      const text = await file.text();
      if (!ctx.alive()) return;
      if (text.length > MAX_TEXTAREA_CHARS) {
        textarea.value = '';
        state.text = '';
        analyse(text, file.name || 'fichier.json');
        return;
      }
      textarea.value = text;
      state.text = text;
      analyse();
    }),
  );
  if (pasteBtn) {
    pasteBtn.addEventListener(
      'click',
      guard(async () => {
        let text = '';
        try {
          text = await navigator.clipboard.readText();
        } catch {
          toast('Collage refusé : maintiens le doigt dans la zone de texte puis « Coller ».');
          return;
        }
        if (!text) {
          toast('Le presse-papiers est vide');
          return;
        }
        textarea.value = text;
        state.text = text;
        analyse();
      }),
    );
  }

  if (state.importResult) {
    const r = state.importResult;
    resultBox.append(
      h(
        'div',
        { class: 'notice is-success' },
        icon('checkCircle', { size: 20 }),
        h('div', { class: 'notice-body' }, h('strong', null, 'Import terminé'), h('span', null, r.message)),
        h('a', { class: 'btn btn-small btn-secondary', href: r.target ? `#/cards/${encodeURIComponent(r.target)}` : '#/cards' }, 'Voir les cartes'),
      ),
    );
    if (r.reveal) {
      // Bring the confirmation into view once the router has restored the scroll position.
      r.reveal = false;
      setTimeout(() => {
        if (ctx.alive()) resultBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 60);
    }
  }

  root.append(
    section(
      'Importer des cartes (JSON)',
      'upload',
      resultBox,
      h('label', { class: 'field-label', htmlFor: 'imp-dest' }, 'Destination'),
      destSelect,
      h('label', { class: 'field-label', htmlFor: 'imp-text' }, 'JSON'),
      textarea,
      h('div', { class: 'btn-row' }, fileBtn, pasteBtn),
      h('div', { class: 'btn-row' }, analyseBtn),
      preview,
      cards.length ? null : h('p', { class: 'hint' }, frSpaces('Pas encore de JSON ? Copie le prompt pour une IA dans « Format JSON », plus bas.')),
    ),
  );
  if (state.text && !state.importResult) analyse();

  /* ---------------------------------------------------------------- */
  /* 2. Format                                                         */
  /* ---------------------------------------------------------------- */
  const copyFormatBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('copy', { size: 18 }), 'Copier le format');
  copyFormatBtn.addEventListener(
    'click',
    guard(async () => {
      await copyText(format.FORMAT_EXAMPLE);
      toast('Copié');
    }),
  );
  const copyPromptBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('sparkle', { size: 18 }), 'Copier le prompt pour une IA');
  copyPromptBtn.addEventListener(
    'click',
    guard(async () => {
      await copyText(format.buildAIPrompt());
      toast('Copié');
    }),
  );
  root.append(
    section(
      'Format JSON',
      'file',
      h('div', { class: 'help' }, String(format.FORMAT_HELP || '').split('\n').filter(Boolean).map((p) => h('p', null, frSpaces(p)))),
      h('pre', { class: 'code-block', tabindex: '0', 'aria-label': 'Exemple de JSON' }, h('code', null, format.FORMAT_EXAMPLE)),
      h('div', { class: 'btn-row' }, copyFormatBtn, copyPromptBtn),
      h('p', { class: 'hint' }, 'Colle ce prompt dans ChatGPT/Claude avec ton cours pour générer le JSON, puis colle la réponse ci-dessus.'),
    ),
  );

  /* ---------------------------------------------------------------- */
  /* 3. Backup                                                         */
  /* ---------------------------------------------------------------- */
  const exportBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('share', { size: 18 }), 'Exporter une sauvegarde');
  exportBtn.addEventListener(
    'click',
    guard(async () => {
      const name = `recto-sauvegarde-${localDateKey()}.json`;
      // Built one media at a time: never the whole library as one string in memory.
      const file = await db.exportBackupFile(name);
      let shared = false;
      if (isMobileDevice() && navigator.canShare?.({ files: [file] })) {
        const share = () => navigator.share({ files: [file], title: 'Sauvegarde Recto' });
        try {
          await share();
          shared = true;
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user closed the share sheet
          // iOS: preparing a big backup can outlast the tap's permission to open the share sheet.
          // A second tap (in this dialog) grants it again.
          if (err && err.name === 'NotAllowedError') {
            const again = await confirmDialog({
              title: 'Sauvegarde prête',
              message: `${name} — enregistre-la dans Fichiers, Drive ou envoie-la-toi.`,
              confirmLabel: 'Partager',
            });
            if (!again) return;
            try {
              await share();
              shared = true;
            } catch (err2) {
              if (err2 && err2.name === 'AbortError') return;
            }
          }
        }
      }
      if (!shared) downloadFile(file);
      await db.setMeta(LAST_BACKUP_KEY, Date.now()).catch(() => {});
      lastBackupEl.textContent = sinceLabel(Date.now());
      toast('Sauvegarde exportée');
    }),
  );
  const restoreBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('upload', { size: 18 }), 'Restaurer une sauvegarde');
  restoreBtn.addEventListener(
    'click',
    guard(async () => {
      const file = await media.pickFile({ accept: '.json,application/json' });
      if (!file) return;
      // Reads only the beginning of the file (media are read during the restore, one at a time).
      await restoreFrom(await db.openBackupFile(file));
    }),
  );

  /** Confirm, then replace everything with `backup` (from db.openBackupFile). */
  async function restoreFrom(backup) {
    const head = backup.head;
    if (!head || head.app !== 'recto' || head.kind !== 'backup') {
      toast("Ce fichier n'est pas une sauvegarde Recto. Pour ajouter des cartes, utilise l'import JSON.", { duration: 4500 });
      return;
    }
    const nCards = Array.isArray(head.cards) ? head.cards.length : 0;
    const nMethods = Array.isArray(head.methods) ? head.methods.length : 0;
    const when = head.exportedAt ? new Date(head.exportedAt) : null;
    const whenText = when && !Number.isNaN(when.getTime()) ? ` du ${when.toLocaleDateString('fr-FR')}` : '';
    const ok = await confirmDialog({
      title: 'Restaurer cette sauvegarde ?',
      message: `Sauvegarde${whenText} : ${plural(nCards, 'carte')}, ${plural(nMethods, 'méthode')}. Elle remplace tout le contenu actuel (cartes, méthodes, progression).`,
      confirmLabel: 'Tout remplacer',
      danger: true,
    });
    if (!ok) return;
    await backup.restore();
    window.dispatchEvent(new Event('recto:data-replaced'));
    toast('Sauvegarde restaurée');
    state.dest = '';
    // Nothing left to analyse again on the refresh (the text may be a whole backup).
    state.text = '';
    state.importResult = null;
    if (ctx.alive()) ctx.refresh();
  }
  const lastBackupEl = h('p', { class: 'hint' }, sinceLabel(lastBackup));
  root.append(
    section(
      'Sauvegarde',
      'shield',
      h(
        'p',
        { class: 'help-text' },
        // iOS: Safari and the app added to the Home Screen do not share their data.
        `Tes cartes et ta progression restent uniquement sur ce téléphone${'standalone' in navigator ? " (dans l'app ajoutée à l'écran d'accueil, pas dans Safari)" : ''}. Exporte une sauvegarde régulièrement (par exemple dans Fichiers ou Drive) pour ne rien perdre.`,
      ),
      h('div', { class: 'btn-row' }, exportBtn, restoreBtn),
      lastBackupEl,
    ),
  );

  /* ---------------------------------------------------------------- */
  /* 4. Storage                                                        */
  /* ---------------------------------------------------------------- */
  const storageBox = h('div', { class: 'list' }, h('div', { class: 'row' }, h('span', { class: 'row-main muted' }, 'Calcul…')));
  root.append(section('Stockage', 'database', storageBox));

  const infoRow = (label, value, extra = null) =>
    h('div', { class: 'row row-info' }, h('span', { class: 'row-label' }, label), h('span', { class: 'row-value' }, value), extra);

  async function renderStorage() {
    const info = await db.storageInfo();
    if (!ctx.alive()) return;
    const rows = [
      infoRow('Contenu', `${plural(folders.length, 'dossier')} · ${plural(cards.length, 'carte')} · ${plural(methods.length, 'méthode')}`),
      infoRow(
        'Espace utilisé',
        info.usage == null ? 'inconnu' : info.quota ? `${formatBytes(info.usage)} sur ${formatBytes(info.quota)}` : formatBytes(info.usage),
      ),
    ];
    let persistBtn = null;
    if (info.persisted === false) {
      persistBtn = h('button', { type: 'button', class: 'btn btn-small btn-secondary' }, 'Activer');
      persistBtn.addEventListener(
        'click',
        guard(async () => {
          const ok = await db.requestPersistence();
          toast(ok ? 'Stockage persistant activé' : "Refusé par le navigateur (souvent accordé aux applis ajoutées à l'écran d'accueil)", { duration: 4200 });
          await renderStorage();
        }),
      );
    }
    rows.push(infoRow('Stockage persistant', info.persisted == null ? 'inconnu' : info.persisted ? 'oui' : 'non', persistBtn));
    storageBox.replaceChildren(...rows);
  }
  renderStorage().catch(() => {
    storageBox.replaceChildren(infoRow('Espace utilisé', 'inconnu'));
  });

  /* ---------------------------------------------------------------- */
  /* 5. Danger zone                                                    */
  /* ---------------------------------------------------------------- */
  const wipeBtn = h('button', { type: 'button', class: 'btn btn-danger-outline btn-block' }, icon('trash', { size: 18 }), 'Tout effacer');
  wipeBtn.addEventListener(
    'click',
    guard(async () => {
      const first = await confirmDialog({
        title: 'Tout effacer ?',
        message: 'Toutes les cartes, photos, audios, méthodes et la progression seront supprimés de ce téléphone.',
        confirmLabel: 'Continuer',
        danger: true,
      });
      if (!first) return;
      const second = await confirmDialog({
        title: 'Vraiment tout effacer ?',
        message: 'Cette action est irréversible. Pense à exporter une sauvegarde avant.',
        confirmLabel: 'Tout effacer',
        danger: true,
      });
      if (!second) return;
      await db.clearAll();
      window.dispatchEvent(new Event('recto:data-replaced'));
      toast('Toutes les données ont été effacées');
      state.dest = '';
      state.text = '';
      state.importResult = null;
      if (ctx.alive()) ctx.refresh();
    }),
  );
  root.append(
    section(
      'Zone dangereuse',
      'alert',
      h('p', { class: 'help-text' }, "Supprime définitivement toutes les données de l'application sur cet appareil."),
      wipeBtn,
    ),
  );

  root.append(h('footer', { class: 'app-footer' }, `Recto · version ${APP_VERSION}`));

}
