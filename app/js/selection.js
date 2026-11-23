// Folder tree helpers and method card selection (rules with "nearest rule wins" inheritance).
// Pure ES module (no DOM, no IndexedDB): importable from Node for unit tests.
//
// A method's `rules` map node keys to booleans: 'f:<folderId>' or 'c:<cardId>'.
// A card is included iff the NEAREST rule found walking up [card, its folder, parent, …, root] is
// true; no rule at all ⇒ excluded. Checking a folder therefore includes the cards added there later.

import { compareText } from './util.js';

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

const folderKey = (id) => `f:${id}`;
const cardKey = (id) => `c:${id}`;

/** Own boolean rule for a key, or undefined when there is none (non-boolean values are ignored). */
function ruleOf(rules, key) {
  if (!rules) return undefined;
  const v = rules[key];
  return v === true || v === false ? v : undefined;
}

/** Sort key for `order` (missing / invalid orders go last). */
function orderOf(x) {
  return Number.isFinite(x?.order) ? x.order : Number.MAX_SAFE_INTEGER;
}

function compareFolders(a, b) {
  return orderOf(a) - orderOf(b) || compareText(a.name, b.name);
}

function compareCards(a, b) {
  return orderOf(a) - orderOf(b);
}

/** Effective parent of a folder in the tree (null for roots, broken links and cut cycles). */
function parentOf(tree, folderId) {
  if (tree.parentOf) return tree.parentOf.has(folderId) ? tree.parentOf.get(folderId) : null;
  return tree.folderById.get(folderId)?.parentId ?? null; // tree built elsewhere: raw parent link
}

/**
 * Resolved value of a folder = nearest rule from the folder upward (default false). O(depth).
 * Bulk operations do not call this per card: `walk` passes the resolved value down the tree,
 * so each folder is resolved once per call.
 */
function resolveFolder(rules, folderId, tree) {
  let id = folderId;
  while (id != null && tree.folderById.has(id)) {
    const own = ruleOf(rules, folderKey(id));
    if (own !== undefined) return own;
    id = parentOf(tree, id);
  }
  return false;
}

/** Inclusion of a card given the resolved value of its folder. */
function includedWith(rules, card, folderValue) {
  const own = ruleOf(rules, cardKey(card.id));
  return own !== undefined ? own : folderValue;
}

/**
 * Iterative pre-order DFS over the subtree of `startIds` (in tree order).
 * visitFolder(folder, value) is called with the folder's resolved value; then each own card via
 * visitCard(card, included); then sub-folders. `inheritedOf(id)` gives the value above a start folder.
 * A visitor returning `false` stops the walk.
 */
function walk(rules, tree, startIds, inheritedOf, visitFolder, visitCard) {
  // Stack of [folderId, inheritedValue]; pushed in reverse so that siblings come out in order.
  const stack = [];
  for (let i = startIds.length - 1; i >= 0; i--) stack.push([startIds[i], inheritedOf(startIds[i])]);
  while (stack.length) {
    const [id, inherited] = stack.pop();
    const folder = tree.folderById.get(id);
    if (!folder) continue;
    const own = ruleOf(rules, folderKey(id));
    const value = own !== undefined ? own : inherited;
    if (visitFolder && visitFolder(folder, value) === false) return;
    if (visitCard) {
      for (const card of tree.cardsOf.get(id) || []) {
        if (visitCard(card, includedWith(rules, card, value)) === false) return;
      }
    }
    const children = tree.childrenOf.get(id) || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i].id, value]);
  }
}

/** Root folder ids in tree order. */
function rootIds(tree) {
  return (tree.childrenOf.get(null) || []).map((f) => f.id);
}

/* ------------------------------------------------------------------------ */
/* Tree                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Index folders & cards.
 * → { folderById: Map<id, Folder>, childrenOf: Map<folderId|null, Folder[]> (by order, then name),
 *     cardsOf: Map<folderId, Card[]> (by order), cardById: Map<id, Card>,
 *     parentOf: Map<folderId, folderId|null> (effective parent) }
 * Corrupt data is tolerated: a folder whose parent is missing becomes a root, and parent cycles are cut,
 * so the structure is always a forest. Every folder (and null) has an entry in childrenOf / cardsOf.
 */
export function buildTree(folders, cards) {
  const folderById = new Map();
  for (const f of folders || []) if (f && f.id != null) folderById.set(f.id, f);

  // Effective parents: each folder is visited once (`done`), cycles are cut where detected.
  const parent = new Map();
  const done = new Set();
  for (const startId of folderById.keys()) {
    const path = [];
    const onPath = new Set();
    let id = startId;
    while (id != null && !done.has(id)) {
      if (onPath.has(id)) {
        parent.set(path[path.length - 1], null); // cut the link that closes the cycle
        break;
      }
      onPath.add(id);
      path.push(id);
      const p = folderById.get(id).parentId;
      const valid = p != null && folderById.has(p) ? p : null;
      parent.set(id, valid);
      id = valid;
    }
    for (const p of path) done.add(p);
  }

  const childrenOf = new Map([[null, []]]);
  const cardsOf = new Map();
  for (const id of folderById.keys()) {
    childrenOf.set(id, []);
    cardsOf.set(id, []);
  }
  for (const f of folderById.values()) childrenOf.get(parent.get(f.id)).push(f);
  for (const list of childrenOf.values()) list.sort(compareFolders);

  const cardById = new Map();
  for (const c of cards || []) {
    if (!c || c.id == null) continue;
    cardById.set(c.id, c);
    let list = cardsOf.get(c.folderId);
    if (!list) cardsOf.set(c.folderId, (list = [])); // orphan card: indexed but unreachable
    list.push(c);
  }
  for (const list of cardsOf.values()) list.sort(compareCards);

  return { folderById, childrenOf, cardsOf, cardById, parentOf: parent };
}

/**
 * Cards in course order: depth-first over the tree; within a folder its own cards first (by order),
 * then its sub-folders (by order). Cards outside the tree (missing folder) are left out.
 */
export function courseOrder(folders, cards, tree = buildTree(folders, cards)) {
  const out = [];
  walk(null, tree, rootIds(tree), () => false, null, (card) => {
    out.push(card);
  });
  return out;
}

/** Folder ids of the subtree of `folderId` (itself first, pre-order). null = every folder. */
export function descendantFolderIds(folderId, tree) {
  const start = folderId == null ? rootIds(tree) : tree.folderById.has(folderId) ? [folderId] : [];
  const out = [];
  walk(null, tree, start, () => false, (folder) => {
    out.push(folder.id);
  });
  return out;
}

/** Folders from the root down to `folderId` (inclusive), for breadcrumbs. [] if unknown. */
export function folderPath(folderId, tree) {
  const path = [];
  let id = folderId;
  while (id != null && tree.folderById.has(id)) {
    path.push(tree.folderById.get(id));
    id = parentOf(tree, id);
  }
  return path.reverse();
}

/* ------------------------------------------------------------------------ */
/* Selection                                                                */
/* ------------------------------------------------------------------------ */

/** Whether a card is part of the selection (nearest rule wins; default excluded). */
export function isCardIncluded(rules, card, tree) {
  if (!card) return false;
  const own = ruleOf(rules, cardKey(card.id));
  if (own !== undefined) return own;
  return resolveFolder(rules, card.folderId, tree);
}

/** Included cards in course order. `tree` may be passed to avoid rebuilding it. */
export function resolveMethodCards(rules, folders, cards, tree = buildTree(folders, cards)) {
  const out = [];
  walk(rules, tree, rootIds(tree), () => false, null, (card, included) => {
    if (included) out.push(card);
  });
  return out;
}

/** Number of included cards (same set as resolveMethodCards). */
export function countIncluded(rules, folders, cards, tree = buildTree(folders, cards)) {
  let n = 0;
  walk(rules, tree, rootIds(tree), () => false, null, (card, included) => {
    if (included) n++;
  });
  return n;
}

/**
 * Tri-state of a folder from the cards of its subtree: 'checked' (all included), 'unchecked'
 * (none) or 'partial'. A subtree without any card follows the folder's own resolved rule.
 */
export function folderState(rules, folderId, tree) {
  if (!tree.folderById.has(folderId)) return 'unchecked';
  let some = false;
  let all = true;
  let any = false;
  const inherited = (id) => resolveFolder(rules, parentOf(tree, id), tree);
  walk(rules, tree, [folderId], inherited, null, (card, included) => {
    any = true;
    if (included) some = true;
    else all = false;
    if (some && !all) return false; // partial: no need to look further
  });
  if (!any) return resolveFolder(rules, folderId, tree) ? 'checked' : 'unchecked';
  if (all) return 'checked';
  return some ? 'partial' : 'unchecked';
}

/** 'checked' | 'unchecked' for one card. */
export function cardState(rules, card, tree) {
  return isCardIncluded(rules, card, tree) ? 'checked' : 'unchecked';
}

/**
 * Toggle a node and return NEW rules (the input is never mutated).
 * node = { type: 'folder', id } | { type: 'card', id }.
 * target = (current state === 'checked') ? false : true; then
 *  1) delete the rules of every descendant (sub-folders and cards of the subtree),
 *  2) inherited = resolved value from the parent chain (excluding the node itself; default false),
 *  3) store the node's own rule only when it differs from the inherited value.
 * This keeps the rules minimal, so folders stay "live" for cards added later.
 */
export function toggleNode(rules, node, tree) {
  const next = { ...(rules || {}) };
  if (!node) return next;

  if (node.type === 'folder') {
    if (!tree.folderById.has(node.id)) return next;
    const target = folderState(rules, node.id, tree) !== 'checked';
    walk(null, tree, [node.id], () => false, (folder) => {
      if (folder.id !== node.id) delete next[folderKey(folder.id)];
    }, (card) => {
      delete next[cardKey(card.id)];
    });
    const inherited = resolveFolder(next, parentOf(tree, node.id), tree);
    const key = folderKey(node.id);
    if (inherited === target) delete next[key];
    else next[key] = target;
    return next;
  }

  if (node.type === 'card') {
    const card = tree.cardById.get(node.id);
    if (!card) return next;
    const target = !isCardIncluded(rules, card, tree);
    const inherited = resolveFolder(next, card.folderId, tree);
    const key = cardKey(card.id);
    if (inherited === target) delete next[key];
    else next[key] = target;
    return next;
  }

  return next;
}

/** NEW rules keeping only boolean rules whose folder / card still exists. */
export function cleanRules(rules, folders, cards) {
  const folderIds = new Set();
  for (const f of folders || []) if (f && f.id != null) folderIds.add(String(f.id));
  const cardIds = new Set();
  for (const c of cards || []) if (c && c.id != null) cardIds.add(String(c.id));

  const out = {};
  for (const [key, value] of Object.entries(rules || {})) {
    if (value !== true && value !== false) continue;
    const id = key.slice(2);
    if (key.startsWith('f:') ? folderIds.has(id) : key.startsWith('c:') && cardIds.has(id)) out[key] = value;
  }
  return out;
}
