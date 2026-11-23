// Selection screen: tri-state folder/card tree; every tap is saved immediately.

import * as db from '../db.js';
import * as sel from '../selection.js';
import { plural } from '../util.js';
import { h } from '../dom.js';
import { icon } from './icons.js';
import { topbar, emptyState, serialQueue, toast } from './components.js';
import { navigate, back } from './router.js';
import { facePreview } from './face.js';

/** Tri-state checkbox button. state: 'checked'|'unchecked'|'partial'. */
function triBox(state, label, onToggle) {
  const aria = state === 'checked' ? 'true' : state === 'partial' ? 'mixed' : 'false';
  return h(
    'button',
    {
      type: 'button',
      class: 'tri-btn',
      role: 'checkbox',
      'aria-checked': aria,
      'aria-label': label,
      onClick: onToggle,
    },
    h(
      'span',
      { class: ['tri', `is-${state}`] },
      state === 'checked' ? icon('check', { size: 16, strokeWidth: 3 }) : state === 'partial' ? icon('minus', { size: 16, strokeWidth: 3 }) : null,
    ),
  );
}

export async function renderSelect(root, ctx) {
  const id = ctx.params.id;
  const [method, folders, cards] = await Promise.all([db.getMethod(id), db.getFolders(), db.getCards()]);
  if (!ctx.alive()) return;
  if (!method) {
    toast('Méthode introuvable');
    navigate('#/', { replace: true });
    return;
  }

  const methodHash = `#/method/${encodeURIComponent(id)}`;
  const tree = sel.buildTree(folders, cards);
  let rules = { ...(method.rules || {}) };
  const save = serialQueue();

  // Expanded folders survive refreshes of this screen.
  if (!ctx.state.expanded) {
    ctx.state.expanded = new Set();
    const roots = tree.childrenOf.get(null) || [];
    if (roots.length === 1) ctx.state.expanded.add(roots[0].id);
  }
  const expanded = ctx.state.expanded;

  // Total cards per folder subtree (static for this render).
  const totalOf = new Map();
  const countTotal = (folderId) => {
    let n = (tree.cardsOf.get(folderId) || []).length;
    for (const child of tree.childrenOf.get(folderId) || []) n += countTotal(child.id);
    totalOf.set(folderId, n);
    return n;
  };
  for (const f of tree.childrenOf.get(null) || []) countTotal(f.id);

  const head = topbar({ title: 'Cartes de la méthode', subtitle: method.name, onBack: () => back(methodHash) });
  head.classList.add('is-solid');
  root.append(head);

  if (!folders.length) {
    root.append(
      emptyState({
        iconName: 'folder',
        title: "Aucune carte pour l'instant",
        text: "Importe d'abord tes cartes (un dossier par chapitre), puis reviens choisir celles de cette méthode.",
        actions: [h('a', { class: 'btn btn-primary btn-block', href: '#/data' }, icon('upload', { size: 20 }), 'Importer du JSON')],
      }),
    );
    return;
  }

  const countEl = h('div', { class: 'select-count', 'aria-live': 'polite' });
  const treeEl = h('div', { class: 'tree', role: 'tree' });

  const toggle = (node) => {
    rules = sel.toggleNode(rules, node, tree);
    const snapshot = rules;
    save(() => db.updateMethod(id, { rules: snapshot }));
    renderTree();
  };

  const toggleExpand = (folderId) => {
    if (expanded.has(folderId)) expanded.delete(folderId);
    else expanded.add(folderId);
    renderTree();
  };

  function renderTree() {
    // Included count per folder subtree, computed in one pass over the cards.
    const includedOf = new Map();
    let total = 0;
    for (const card of cards) {
      if (!sel.isCardIncluded(rules, card, tree)) continue;
      total++;
      let fid = card.folderId;
      let guardDepth = 0;
      while (fid && guardDepth++ < 100) {
        includedOf.set(fid, (includedOf.get(fid) || 0) + 1);
        fid = tree.folderById.get(fid)?.parentId ?? null;
      }
    }
    countEl.textContent = plural(total, 'carte sélectionnée', 'cartes sélectionnées');

    const rows = [];
    const walk = (parentId, depth) => {
      for (const folder of tree.childrenOf.get(parentId) || []) {
        const subFolders = tree.childrenOf.get(folder.id) || [];
        const folderCards = tree.cardsOf.get(folder.id) || [];
        const hasChildren = subFolders.length > 0 || folderCards.length > 0;
        const isOpen = expanded.has(folder.id);
        const state = sel.folderState(rules, folder.id, tree);
        const totalCards = totalOf.get(folder.id) || 0;
        const included = includedOf.get(folder.id) || 0;
        rows.push(
          h(
            'div',
            { class: 'tree-row is-folder', role: 'treeitem', 'aria-expanded': hasChildren ? String(isOpen) : null, style: { '--depth': depth } },
            hasChildren
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: ['tree-chevron', isOpen && 'is-open'],
                    'aria-label': isOpen ? `Replier ${folder.name}` : `Déplier ${folder.name}`,
                    onClick: () => toggleExpand(folder.id),
                  },
                  icon('chevronRight', { size: 18 }),
                )
              : h('span', { class: 'tree-chevron-spacer' }),
            triBox(state, `Sélectionner le dossier ${folder.name}`, () => toggle({ type: 'folder', id: folder.id })),
            h(
              'button',
              {
                type: 'button',
                class: 'tree-label',
                onClick: () => (hasChildren ? toggleExpand(folder.id) : toggle({ type: 'folder', id: folder.id })),
              },
              icon('folder', { size: 18, className: 'tree-folder-icon' }),
              h('span', { class: 'ellipsis tree-name' }, folder.name),
              h('span', { class: 'tree-count' }, totalCards ? `${included}/${totalCards}` : '0'),
            ),
          ),
        );
        if (isOpen) {
          walk(folder.id, depth + 1);
          for (const card of folderCards) {
            const cState = sel.cardState(rules, card, tree);
            const label = facePreview(card.front);
            rows.push(
              h(
                'div',
                { class: 'tree-row is-card', role: 'treeitem', style: { '--depth': depth + 1 } },
                h('span', { class: 'tree-chevron-spacer' }),
                triBox(cState, `Sélectionner la carte ${label}`, () => toggle({ type: 'card', id: card.id })),
                h(
                  'button',
                  { type: 'button', class: 'tree-label', onClick: () => toggle({ type: 'card', id: card.id }) },
                  h('span', { class: 'ellipsis tree-name' }, label),
                ),
              ),
            );
          }
        }
      }
    };
    walk(null, 0);
    treeEl.replaceChildren(...rows);
  }

  renderTree();

  root.append(
    h('div', { class: 'select-head' }, countEl),
    h(
      'p',
      { class: 'hint' },
      'Coche un dossier entier pour que les cartes ajoutées plus tard y soient incluses automatiquement.',
    ),
    treeEl,
    h(
      'div',
      { class: 'sticky-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-block btn-lg',
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            await save.idle(); // make sure the last change is written before leaving
            back(methodHash);
          },
        },
        'Terminé',
      ),
    ),
  );

  // Flush pending writes if the user leaves another way.
  ctx.onCleanup(() => save.idle());
}
