// « Cartes » tab: folder browser (#/cards, #/cards/<folderId>) with search at the root.

import * as db from '../db.js';
import * as sel from '../selection.js';
import { plural, debounce } from '../util.js';
import { h, searchKey } from '../dom.js';
import { icon } from './icons.js';
import {
  topbar,
  pageHead,
  emptyState,
  iconButton,
  actionSheet,
  promptDialog,
  confirmDialog,
  pickFolder,
  guard,
  toast,
} from './components.js';
import { navigate, back } from './router.js';
import { openCardEditor } from './editor.js';
import { facePreview, cardHasImage, cardHasAudio } from './face.js';

const MAX_RESULTS = 150;

function enc(id) {
  return encodeURIComponent(id);
}

function folderHash(id) {
  return id ? `#/cards/${enc(id)}` : '#/cards';
}

/** Recursive card count per folder. */
function recursiveCounts(tree) {
  const counts = new Map();
  const walk = (folderId) => {
    let n = (tree.cardsOf.get(folderId) || []).length;
    for (const child of tree.childrenOf.get(folderId) || []) n += walk(child.id);
    counts.set(folderId, n);
    return n;
  };
  for (const root of tree.childrenOf.get(null) || []) walk(root.id);
  return counts;
}

function folderRow(folder, count, subCount) {
  const meta = [plural(count, 'carte')];
  if (subCount) meta.unshift(plural(subCount, 'dossier'));
  return h(
    'a',
    { class: 'row row-link folder-row', href: folderHash(folder.id) },
    h('span', { class: 'row-icon is-folder' }, icon('folder', { size: 22 })),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title ellipsis' }, folder.name), h('span', { class: 'row-sub' }, meta.join(' · '))),
    icon('chevronRight', { size: 20, className: 'muted-icon' }),
  );
}

function cardRow(card, onOpen, caption = '') {
  const badges = [];
  if (cardHasImage(card)) badges.push(icon('image', { size: 16 }));
  if (cardHasAudio(card)) badges.push(icon('volume', { size: 16 }));
  return h(
    'button',
    { type: 'button', class: 'row row-link card-row', onClick: onOpen },
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'card-front ellipsis' }, facePreview(card.front)),
      h('span', { class: 'card-back ellipsis' }, facePreview(card.back)),
      caption ? h('span', { class: 'card-caption ellipsis' }, caption) : null,
    ),
    badges.length ? h('span', { class: 'card-badges', 'aria-label': 'Contient des médias' }, badges) : null,
  );
}

export async function renderLibrary(root, ctx) {
  const folderId = ctx.params.id || null;
  const [folders, cards] = await Promise.all([db.getFolders(), db.getCards()]);
  if (!ctx.alive()) return;
  const tree = sel.buildTree(folders, cards);
  if (folderId && !tree.folderById.has(folderId)) {
    toast('Dossier introuvable');
    navigate('#/cards', { replace: true });
    return;
  }
  const folder = folderId ? tree.folderById.get(folderId) : null;
  const path = folder ? sel.folderPath(folderId, tree) : [];
  const counts = recursiveCounts(tree);
  const parentId = folder ? folder.parentId ?? null : null;

  const openCard = (cardId) =>
    guard(async () => {
      await openCardEditor({ cardId });
      if (ctx.alive()) ctx.refresh();
    });

  /* --- header --- */
  if (folder) {
    root.append(
      topbar({
        title: folder.name,
        onBack: () => back(folderHash(parentId)),
        actions: [iconButton('more', 'Options du dossier', () => folderMenu())],
      }),
    );
    if (path.length >= 2) {
      const crumbs = [h('a', { href: '#/cards' }, 'Cartes')];
      for (const f of path.slice(0, -1)) crumbs.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), h('a', { href: folderHash(f.id) }, f.name));
      root.append(h('nav', { class: 'breadcrumb', 'aria-label': "Fil d'Ariane" }, crumbs));
    }
  } else {
    root.append(
      pageHead({
        title: 'Cartes',
        subtitle: cards.length ? `${plural(folders.length, 'dossier')} · ${plural(cards.length, 'carte')}` : '',
      }),
    );
  }

  /* --- content --- */
  const content = h('div', { class: 'library-content' });
  const subFolders = tree.childrenOf.get(folderId) || [];
  const folderCards = folderId ? tree.cardsOf.get(folderId) || [] : [];

  function renderListing() {
    const parts = [];
    if (!folder && !folders.length) {
      parts.push(
        emptyState({
          iconName: 'folder',
          title: "Aucune carte pour l'instant",
          text: 'Importe ton cours au format JSON (un dossier par chapitre), ou crée un dossier pour ajouter des cartes à la main.',
          actions: [
            h('a', { class: 'btn btn-primary btn-block', href: '#/data' }, icon('upload', { size: 20 }), 'Importer du JSON'),
            h('button', { type: 'button', class: 'btn btn-secondary btn-block', onClick: guard(() => newFolder()) }, icon('folder', { size: 20 }), 'Nouveau dossier'),
          ],
        }),
      );
    } else if (folder && !subFolders.length && !folderCards.length) {
      parts.push(
        emptyState({
          iconName: 'folder',
          title: 'Dossier vide',
          text: 'Ajoute une carte avec le bouton +, ou importe du JSON directement dans ce dossier.',
          actions: [
            h('button', { type: 'button', class: 'btn btn-primary btn-block', onClick: guard(() => newCard()) }, icon('plus', { size: 20 }), 'Nouvelle carte'),
            h('a', { class: 'btn btn-secondary btn-block', href: `#/data?dest=${enc(folderId)}` }, icon('upload', { size: 20 }), 'Importer du JSON ici'),
          ],
        }),
      );
    } else {
      if (subFolders.length) {
        parts.push(
          h(
            'div',
            { class: 'list' },
            subFolders.map((f) => folderRow(f, counts.get(f.id) || 0, (tree.childrenOf.get(f.id) || []).length)),
          ),
        );
      }
      if (folderCards.length) {
        parts.push(
          h('h2', { class: 'section-title' }, plural(folderCards.length, 'carte')),
          h(
            'div',
            { class: 'list' },
            folderCards.map((c) => cardRow(c, openCard(c.id))),
          ),
        );
      }
    }
    content.replaceChildren(...parts);
  }

  /* --- search (root only) --- */
  if (!folder && cards.length) {
    let index = null; // lazily built [card, searchKey, courseRank]
    const pathLabel = (fid) => sel.folderPath(fid, tree).map((f) => f.name).join(' › ');
    const input = h('input', {
      type: 'search',
      class: 'input search-input',
      placeholder: 'Rechercher une carte',
      'aria-label': 'Rechercher une carte',
      value: ctx.state.query || '',
      autocomplete: 'off',
      enterkeyhint: 'search',
    });
    const runSearch = () => {
      const q = searchKey(input.value);
      ctx.state.query = input.value;
      if (!q) {
        renderListing();
        return;
      }
      if (!index) {
        index = sel.courseOrder(folders, cards, tree).map((c) => [c, searchKey(`${c.front?.text || ''}\n${c.back?.text || ''}`)]);
      }
      const terms = q.split(' ');
      const ordered = [];
      for (const [c, key] of index) {
        if (terms.every((t) => key.includes(t))) ordered.push(c);
      }
      const shown = ordered.slice(0, MAX_RESULTS);
      const parts = [];
      if (!shown.length) {
        parts.push(h('p', { class: 'hint center' }, 'Aucune carte ne correspond.'));
      } else {
        parts.push(
          h('h2', { class: 'section-title' }, plural(ordered.length, 'résultat')),
          h(
            'div',
            { class: 'list' },
            shown.map((c) => cardRow(c, openCard(c.id), pathLabel(c.folderId))),
          ),
        );
        if (ordered.length > shown.length) parts.push(h('p', { class: 'hint center' }, `${ordered.length - shown.length} autres résultats : affine ta recherche.`));
      }
      content.replaceChildren(...parts);
    };
    input.addEventListener('input', debounce(runSearch, 120));
    root.append(h('div', { class: 'search' }, icon('search', { size: 18, className: 'search-icon' }), input));
    if (input.value) runSearch();
    else renderListing();
  } else {
    renderListing();
  }
  root.append(content);

  /* --- floating + button --- */
  const fab = h('button', { type: 'button', class: 'fab', 'aria-label': 'Ajouter' }, icon('plus', { size: 26, strokeWidth: 2.2 }));
  fab.addEventListener(
    'click',
    guard(() =>
      actionSheet(
        folder
          ? [
              { label: 'Nouvelle carte', icon: 'plus', onSelect: () => newCard() },
              { label: 'Nouveau sous-dossier', icon: 'folder', onSelect: () => newFolder(folderId) },
              { label: 'Importer du JSON ici', icon: 'upload', onSelect: () => navigate(`#/data?dest=${enc(folderId)}`) },
            ]
          : [
              { label: 'Nouveau dossier', icon: 'folder', onSelect: () => newFolder(null) },
              { label: 'Importer du JSON', icon: 'upload', onSelect: () => navigate('#/data') },
            ],
      ),
    ),
  );
  root.append(fab);

  /* --- actions --- */
  async function newCard() {
    await openCardEditor({ folderId });
    if (ctx.alive()) ctx.refresh();
  }

  async function newFolder(parent = folderId) {
    const name = await promptDialog({
      title: parent ? 'Nouveau sous-dossier' : 'Nouveau dossier',
      label: 'Nom du dossier',
      placeholder: parent ? 'Ex. Chapitre 4' : 'Ex. Comptabilité',
      confirmLabel: 'Créer',
    });
    if (!name) return;
    const created = await db.createFolder({ name, parentId: parent || null });
    toast('Dossier créé');
    if (ctx.alive()) navigate(folderHash(created.id));
  }

  async function folderMenu() {
    await actionSheet(
      [
        { label: 'Renommer', icon: 'edit', onSelect: () => renameFolder() },
        { label: 'Déplacer', icon: 'folderMove', onSelect: () => moveFolder() },
        { label: "S'entraîner", icon: 'shuffle', onSelect: () => navigate(`#/practice/folder/${enc(folderId)}`) },
        { label: 'Supprimer', icon: 'trash', danger: true, onSelect: () => deleteFolder() },
      ],
      { title: folder.name },
    );
  }

  async function renameFolder() {
    const name = await promptDialog({ title: 'Renommer le dossier', label: 'Nom', value: folder.name, confirmLabel: 'Renommer' });
    if (!name || name === folder.name) return;
    await db.updateFolder(folderId, { name });
    if (ctx.alive()) ctx.refresh();
  }

  async function moveFolder() {
    const excluded = new Set(sel.descendantFolderIds(folderId, tree));
    const choice = await pickFolder({
      title: `Déplacer « ${folder.name} » vers…`,
      tree,
      disabledIds: excluded,
      currentId: parentId,
      allowRoot: true,
    });
    if (!choice) return;
    const dest = choice.id || null;
    if (dest === parentId) return;
    if (dest && excluded.has(dest)) {
      toast('Impossible de déplacer un dossier dans lui-même');
      return;
    }
    const siblings = tree.childrenOf.get(dest) || [];
    const order = siblings.reduce((m, f) => Math.max(m, Number(f.order) || 0), 0) + 1;
    await db.updateFolder(folderId, { parentId: dest, order });
    toast('Dossier déplacé');
    if (ctx.alive()) ctx.refresh();
  }

  async function deleteFolder() {
    const ids = sel.descendantFolderIds(folderId, tree);
    const nCards = counts.get(folderId) || 0;
    const ok = await confirmDialog({
      title: `Supprimer « ${folder.name} » ?`,
      message: `${plural(ids.length, 'dossier')} et ${plural(nCards, 'carte')} seront supprimés, ainsi que leur progression. Cette action est irréversible.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    await db.deleteFolder(folderId);
    toast('Dossier supprimé');
    if (ctx.alive()) back(folderHash(parentId));
  }
}
