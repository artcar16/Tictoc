// Unit tests for app/js/selection.js (tree helpers & method selection rules).
// Run: node --test tests/unit/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTree,
  courseOrder,
  isCardIncluded,
  resolveMethodCards,
  folderState,
  cardState,
  toggleNode,
  countIncluded,
  cleanRules,
  folderPath,
  descendantFolderIds,
} from '../../app/js/selection.js';

/* ------------------------------------------------------------------------ */
/* Fixture                                                                  */
/* ------------------------------------------------------------------------ */
//
//  Compta (order 0)
//    ├─ cards: k1
//    ├─ Chapitre 2 (order 1)      cards: c2a, c2b
//    ├─ Chapitre 10 (order 1)     cards: c10a      (same order → natural name sort: 2 < 10)
//    └─ Chapitre 1 (order 0)      cards: c1a, c1b, c1c (inserted out of order)
//         └─ Annexe (order 0)     cards: an1
//         └─ Vide   (order 1)     (no card)
//  Maths (order 1)                cards: m1

const F = (id, parentId, name, order) => ({ id, parentId, name, order, createdAt: 0 });
const C = (id, folderId, order) => ({ id, folderId, order, front: { text: id }, back: { text: id } });

function fixture() {
  const folders = [
    F('maths', null, 'Maths', 1),
    F('ch2', 'compta', 'Chapitre 2', 1),
    F('compta', null, 'Compta', 0),
    F('ch10', 'compta', 'Chapitre 10', 1),
    F('ch1', 'compta', 'Chapitre 1', 0),
    F('annexe', 'ch1', 'Annexe', 0),
    F('vide', 'ch1', 'Vide', 1),
  ];
  const cards = [
    C('c1c', 'ch1', 2),
    C('c1a', 'ch1', 0),
    C('m1', 'maths', 0),
    C('c2b', 'ch2', 1),
    C('c1b', 'ch1', 1),
    C('an1', 'annexe', 0),
    C('c2a', 'ch2', 0),
    C('c10a', 'ch10', 0),
    C('k1', 'compta', 0),
  ];
  return { folders, cards, tree: buildTree(folders, cards) };
}

const ids = (list) => list.map((x) => x.id);
const COURSE = ['k1', 'c1a', 'c1b', 'c1c', 'an1', 'c2a', 'c2b', 'c10a', 'm1'];

/** Sorted ids of the included cards. */
function included(rules, { folders, cards }) {
  return ids(resolveMethodCards(rules, folders, cards)).sort();
}

/* ------------------------------------------------------------------------ */
/* Tree helpers                                                             */
/* ------------------------------------------------------------------------ */

describe('buildTree()', () => {
  test('children sorted by order then natural name; cards by order', () => {
    const { tree } = fixture();
    assert.deepEqual(ids(tree.childrenOf.get(null)), ['compta', 'maths']);
    assert.deepEqual(ids(tree.childrenOf.get('compta')), ['ch1', 'ch2', 'ch10']);
    assert.deepEqual(ids(tree.childrenOf.get('ch1')), ['annexe', 'vide']);
    assert.deepEqual(ids(tree.childrenOf.get('vide')), []);
    assert.deepEqual(ids(tree.cardsOf.get('ch1')), ['c1a', 'c1b', 'c1c']);
    assert.deepEqual(ids(tree.cardsOf.get('vide')), []);
    assert.equal(tree.folderById.get('ch2').name, 'Chapitre 2');
    assert.equal(tree.folderById.size, 7);
  });

  test('does not mutate its inputs', () => {
    const { folders, cards } = fixture();
    const before = JSON.stringify({ folders, cards });
    buildTree(folders, cards);
    assert.equal(JSON.stringify({ folders, cards }), before);
  });

  test('tolerates broken parents and cycles (always a forest)', () => {
    const folders = [F('a', 'missing', 'A', 0), F('x', 'y', 'X', 0), F('y', 'x', 'Y', 1), F('s', 's', 'S', 2)];
    const cards = [C('ca', 'a', 0), C('cx', 'x', 0), C('cy', 'y', 0), C('cs', 's', 0), C('orphan', 'nope', 0)];
    const tree = buildTree(folders, cards);
    // Every folder reachable exactly once, no infinite loop.
    const all = descendantFolderIds(null, tree);
    assert.deepEqual([...all].sort(), ['a', 's', 'x', 'y']);
    assert.equal(new Set(all).size, 4);
    const order = ids(courseOrder(folders, cards, tree));
    assert.deepEqual([...order].sort(), ['ca', 'cs', 'cx', 'cy'], 'orphan cards are left out');
    assert.ok(folderPath('x', tree).length >= 1);
  });
});

describe('courseOrder()', () => {
  test('DFS: own cards first, then sub-folders, all by order', () => {
    const { folders, cards, tree } = fixture();
    assert.deepEqual(ids(courseOrder(folders, cards, tree)), COURSE);
    assert.deepEqual(ids(courseOrder(folders, cards)), COURSE, 'tree is optional');
  });

  test('empty inputs', () => {
    assert.deepEqual(courseOrder([], []), []);
  });
});

describe('folderPath() / descendantFolderIds()', () => {
  test('folderPath from root to folder', () => {
    const { tree } = fixture();
    assert.deepEqual(ids(folderPath('annexe', tree)), ['compta', 'ch1', 'annexe']);
    assert.deepEqual(ids(folderPath('maths', tree)), ['maths']);
    assert.deepEqual(folderPath('nope', tree), []);
    assert.deepEqual(folderPath(null, tree), []);
  });

  test('descendantFolderIds includes the folder itself, pre-order', () => {
    const { tree } = fixture();
    assert.deepEqual(descendantFolderIds('compta', tree), ['compta', 'ch1', 'annexe', 'vide', 'ch2', 'ch10']);
    assert.deepEqual(descendantFolderIds('ch1', tree), ['ch1', 'annexe', 'vide']);
    assert.deepEqual(descendantFolderIds('vide', tree), ['vide']);
    assert.deepEqual(descendantFolderIds('nope', tree), []);
    assert.equal(descendantFolderIds(null, tree).length, 7);
  });
});

/* ------------------------------------------------------------------------ */
/* Inclusion rules                                                          */
/* ------------------------------------------------------------------------ */

describe('inclusion (nearest rule wins)', () => {
  test('no rule ⇒ nothing included', () => {
    const fx = fixture();
    assert.deepEqual(included({}, fx), []);
    assert.equal(countIncluded({}, fx.folders, fx.cards), 0);
    for (const c of fx.cards) assert.equal(isCardIncluded({}, c, fx.tree), false);
  });

  test('a checked folder includes its whole subtree', () => {
    const fx = fixture();
    assert.deepEqual(included({ 'f:ch1': true }, fx), ['an1', 'c1a', 'c1b', 'c1c']);
    assert.deepEqual(ids(resolveMethodCards({ 'f:compta': true }, fx.folders, fx.cards)), COURSE.slice(0, 8), 'course order');
  });

  test('card excluded inside a checked folder', () => {
    const fx = fixture();
    const rules = { 'f:ch1': true, 'c:c1b': false };
    assert.deepEqual(included(rules, fx), ['an1', 'c1a', 'c1c']);
    assert.equal(cardState(rules, fx.tree.cardById.get('c1b'), fx.tree), 'unchecked');
    assert.equal(cardState(rules, fx.tree.cardById.get('c1a'), fx.tree), 'checked');
  });

  test('sub-folder excluded inside a checked folder', () => {
    const fx = fixture();
    const rules = { 'f:compta': true, 'f:ch1': false };
    assert.deepEqual(included(rules, fx), ['c10a', 'c2a', 'c2b', 'k1']);
  });

  test('card / folder included inside an unchecked (or excluded) folder', () => {
    const fx = fixture();
    assert.deepEqual(included({ 'c:c2a': true }, fx), ['c2a']);
    assert.deepEqual(included({ 'f:compta': true, 'f:ch1': false, 'f:annexe': true, 'c:c1a': true }, fx), [
      'an1',
      'c10a',
      'c1a',
      'c2a',
      'c2b',
      'k1',
    ]);
  });

  test('a card added later to a checked folder is included automatically', () => {
    const fx = fixture();
    const rules = { 'f:ch1': true, 'c:c1b': false };
    const cards = [...fx.cards, C('c1new', 'ch1', 3), C('an2', 'annexe', 1)];
    const folders = [...fx.folders, F('ch1sub', 'ch1', 'Nouveau', 5)];
    cards.push(C('subcard', 'ch1sub', 0));
    assert.deepEqual(ids(resolveMethodCards(rules, folders, cards)), ['c1a', 'c1c', 'c1new', 'an1', 'an2', 'subcard']);
    // Chapter 4 added later, then added to the same method: the method adapts.
    const withCh4 = [...folders, F('ch4', 'compta', 'Chapitre 4', 3)];
    const cards4 = [...cards, C('c4a', 'ch4', 0)];
    const tree4 = buildTree(withCh4, cards4);
    const rules4 = toggleNode(rules, { type: 'folder', id: 'ch4' }, tree4);
    assert.deepEqual(rules4, { 'f:ch1': true, 'c:c1b': false, 'f:ch4': true });
    assert.equal(countIncluded(rules4, withCh4, cards4), 7);
  });

  test('countIncluded matches resolveMethodCards; isCardIncluded matches both', () => {
    const fx = fixture();
    const rules = { 'f:compta': true, 'f:ch1': false, 'c:c1c': true, 'c:c10a': false, 'f:maths': true };
    const res = resolveMethodCards(rules, fx.folders, fx.cards);
    assert.equal(countIncluded(rules, fx.folders, fx.cards), res.length);
    assert.equal(countIncluded(rules, fx.folders, fx.cards, fx.tree), res.length);
    const set = new Set(ids(res));
    for (const c of fx.cards) assert.equal(isCardIncluded(rules, c, fx.tree), set.has(c.id), c.id);
  });

  test('non-boolean rule values are ignored', () => {
    const fx = fixture();
    assert.deepEqual(included({ 'f:ch2': 'yes', 'c:c2a': null, 'f:maths': 1 }, fx), []);
  });
});

/* ------------------------------------------------------------------------ */
/* Tri-state                                                                */
/* ------------------------------------------------------------------------ */

describe('folderState()', () => {
  test('checked / unchecked / partial from the subtree cards', () => {
    const { tree } = fixture();
    assert.equal(folderState({}, 'compta', tree), 'unchecked');
    assert.equal(folderState({ 'f:compta': true }, 'compta', tree), 'checked');
    assert.equal(folderState({ 'f:compta': true }, 'ch1', tree), 'checked', 'inherited');
    assert.equal(folderState({ 'f:ch1': true }, 'compta', tree), 'partial');
    assert.equal(folderState({ 'f:compta': true, 'c:an1': false }, 'compta', tree), 'partial');
    assert.equal(folderState({ 'f:compta': true, 'c:an1': false }, 'ch1', tree), 'partial');
    assert.equal(folderState({ 'f:compta': true, 'c:an1': false }, 'annexe', tree), 'unchecked');
    assert.equal(folderState({ 'f:compta': true, 'c:an1': false }, 'ch2', tree), 'checked');
    assert.equal(folderState({ 'c:an1': true }, 'ch1', tree), 'partial', 'deep card counts');
  });

  test('all cards included through individual rules ⇒ checked', () => {
    const { tree } = fixture();
    assert.equal(folderState({ 'c:c2a': true, 'c:c2b': true }, 'ch2', tree), 'checked');
  });

  test('empty subtree follows the resolved folder rule', () => {
    const { tree } = fixture();
    assert.equal(folderState({}, 'vide', tree), 'unchecked');
    assert.equal(folderState({ 'f:vide': true }, 'vide', tree), 'checked');
    assert.equal(folderState({ 'f:ch1': true }, 'vide', tree), 'checked', 'inherited from parent');
    assert.equal(folderState({ 'f:ch1': true, 'f:vide': false }, 'vide', tree), 'unchecked');
    // Empty folder rule does not affect the parent's (card-based) state.
    assert.equal(folderState({ 'f:ch1': true, 'f:vide': false }, 'ch1', tree), 'checked');
  });

  test('unknown folder ⇒ unchecked', () => {
    const { tree } = fixture();
    assert.equal(folderState({ 'f:x': true }, 'x', tree), 'unchecked');
  });
});

/* ------------------------------------------------------------------------ */
/* toggleNode()                                                             */
/* ------------------------------------------------------------------------ */

describe('toggleNode()', () => {
  const folder = (id) => ({ type: 'folder', id });
  const card = (id) => ({ type: 'card', id });

  test('checking a folder sets a single rule and returns new rules', () => {
    const { tree } = fixture();
    const rules = {};
    const next = toggleNode(rules, folder('ch1'), tree);
    assert.deepEqual(next, { 'f:ch1': true });
    assert.deepEqual(rules, {}, 'input not mutated');
    assert.notEqual(next, rules);
  });

  test('unchecking a checked folder removes its rule (inherited false)', () => {
    const { tree } = fixture();
    assert.deepEqual(toggleNode({ 'f:ch1': true }, folder('ch1'), tree), {});
  });

  test('unchecking a folder inside a checked parent stores an exclusion', () => {
    const { tree } = fixture();
    assert.deepEqual(toggleNode({ 'f:compta': true }, folder('ch1'), tree), { 'f:compta': true, 'f:ch1': false });
    // and checking it back removes the now useless rule
    assert.deepEqual(toggleNode({ 'f:compta': true, 'f:ch1': false }, folder('ch1'), tree), { 'f:compta': true });
  });

  test('a partial folder becomes checked and its descendant rules are cleared', () => {
    const fx = fixture();
    const rules = { 'f:ch1': true, 'c:c1b': false, 'f:annexe': false, 'c:k1': true, 'c:c2a': true };
    assert.equal(folderState(rules, 'compta', fx.tree), 'partial');
    const next = toggleNode(rules, folder('compta'), fx.tree);
    assert.deepEqual(next, { 'f:compta': true });
    assert.equal(folderState(next, 'compta', fx.tree), 'checked');
    assert.equal(countIncluded(next, fx.folders, fx.cards), 8);
  });

  test('cards: exclude inside a checked folder, re-include, include inside an unchecked folder', () => {
    const { tree } = fixture();
    const r1 = toggleNode({ 'f:ch1': true }, card('c1b'), tree);
    assert.deepEqual(r1, { 'f:ch1': true, 'c:c1b': false });
    const r2 = toggleNode(r1, card('c1b'), tree);
    assert.deepEqual(r2, { 'f:ch1': true });
    const r3 = toggleNode({}, card('c2a'), tree);
    assert.deepEqual(r3, { 'c:c2a': true });
    assert.deepEqual(toggleNode(r3, card('c2a'), tree), {});
  });

  test('toggling an empty folder', () => {
    const { tree } = fixture();
    const r1 = toggleNode({}, folder('vide'), tree);
    assert.deepEqual(r1, { 'f:vide': true });
    assert.equal(folderState(r1, 'vide', tree), 'checked');
    assert.deepEqual(toggleNode(r1, folder('vide'), tree), {});
    // Inside a checked parent: unchecking stores an exclusion.
    assert.deepEqual(toggleNode({ 'f:ch1': true }, folder('vide'), tree), { 'f:ch1': true, 'f:vide': false });
  });

  test('toggle twice restores the resolved state (from checked or unchecked)', () => {
    const fx = fixture();
    const scenarios = [
      {},
      { 'f:compta': true },
      { 'f:compta': true, 'f:ch1': false },
      { 'f:compta': true, 'f:ch1': false, 'f:annexe': true },
      { 'c:c2a': true, 'f:maths': true },
      { 'f:ch1': true, 'c:c1b': false },
    ];
    const nodes = [
      ...fx.folders.map((f) => folder(f.id)),
      ...fx.cards.map((c) => card(c.id)),
    ];
    for (const rules of scenarios) {
      for (const node of nodes) {
        const state =
          node.type === 'folder' ? folderState(rules, node.id, fx.tree) : cardState(rules, fx.tree.cardById.get(node.id), fx.tree);
        if (state === 'partial') continue; // partial → checked → unchecked by design
        const twice = toggleNode(toggleNode(rules, node, fx.tree), node, fx.tree);
        assert.deepEqual(included(twice, fx), included(rules, fx), `${JSON.stringify(rules)} / ${node.type}:${node.id}`);
        const stateAfter =
          node.type === 'folder' ? folderState(twice, node.id, fx.tree) : cardState(twice, fx.tree.cardById.get(node.id), fx.tree);
        assert.equal(stateAfter, state);
      }
    }
  });

  test('after a toggle the node state is the target and only the subtree changed', () => {
    const fx = fixture();
    const rules = { 'f:compta': true, 'f:ch1': false, 'c:c1a': true, 'c:m1': true };
    const next = toggleNode(rules, folder('ch1'), fx.tree);
    assert.equal(folderState(next, 'ch1', fx.tree), 'checked');
    // Outside the subtree nothing changed.
    const sub = new Set(['c1a', 'c1b', 'c1c', 'an1']);
    const before = new Set(included(rules, fx));
    const after = new Set(included(next, fx));
    for (const c of fx.cards) if (!sub.has(c.id)) assert.equal(after.has(c.id), before.has(c.id), c.id);
    assert.deepEqual(next, { 'f:compta': true, 'c:m1': true });
  });

  test('unknown nodes leave the rules unchanged (as a copy)', () => {
    const { tree } = fixture();
    const rules = { 'f:ch1': true };
    assert.deepEqual(toggleNode(rules, folder('nope'), tree), rules);
    assert.deepEqual(toggleNode(rules, card('nope'), tree), rules);
    assert.deepEqual(toggleNode(rules, null, tree), rules);
    assert.deepEqual(toggleNode(undefined, folder('ch2'), tree), { 'f:ch2': true });
  });
});

/* ------------------------------------------------------------------------ */
/* cleanRules()                                                             */
/* ------------------------------------------------------------------------ */

describe('cleanRules()', () => {
  test('drops keys pointing to missing ids and malformed entries', () => {
    const { folders, cards } = fixture();
    const rules = {
      'f:ch1': true,
      'f:gone': true,
      'c:c1b': false,
      'c:gone': true,
      'x:ch1': true,
      junk: true,
      'f:ch2': 'yes',
    };
    const out = cleanRules(rules, folders, cards);
    assert.deepEqual(out, { 'f:ch1': true, 'c:c1b': false });
    assert.equal(rules['f:gone'], true, 'input not mutated');
    assert.deepEqual(cleanRules(undefined, folders, cards), {});
  });

  test('a folder id is not accepted as a card id and vice versa', () => {
    const { folders, cards } = fixture();
    assert.deepEqual(cleanRules({ 'c:ch1': true, 'f:c1a': true }, folders, cards), {});
  });
});

/* ------------------------------------------------------------------------ */
/* Performance                                                              */
/* ------------------------------------------------------------------------ */

describe('performance', () => {
  test('5000 cards / 300 folders stays well under 200 ms', () => {
    // 10 subjects × 5 chapters × 5 sections (+ 10 + 50 parents = 310 folders), 5000 cards in the leaves.
    const folders = [];
    const leaves = [];
    for (let s = 0; s < 10; s++) {
      folders.push(F(`s${s}`, null, `Matière ${s}`, s));
      for (let c = 0; c < 5; c++) {
        folders.push(F(`s${s}c${c}`, `s${s}`, `Chapitre ${c}`, c));
        for (let k = 0; k < 5; k++) {
          const id = `s${s}c${c}k${k}`;
          folders.push(F(id, `s${s}c${c}`, `Section ${k}`, k));
          leaves.push(id);
        }
      }
    }
    const cards = [];
    for (let i = 0; i < 5000; i++) cards.push(C(`card${i}`, leaves[i % leaves.length], i));
    // A realistic method: a few chapters, some exclusions, some single cards.
    const rules = { 'f:s0': true, 'f:s1c2': true, 'f:s0c1': false, 'f:s0c1k3': true, 'c:card7': false, 'c:card4999': true };

    const t0 = performance.now();
    const tree = buildTree(folders, cards);
    const order = courseOrder(folders, cards, tree);
    const res = resolveMethodCards(rules, folders, cards);
    const n = countIncluded(rules, folders, cards);
    let checked = 0;
    for (const card of cards) if (isCardIncluded(rules, card, tree)) checked++;
    for (const f of folders) folderState(rules, f.id, tree);
    const r2 = toggleNode(rules, { type: 'folder', id: 's2' }, tree);
    countIncluded(r2, folders, cards, tree);
    cleanRules(rules, folders, cards);
    const elapsed = performance.now() - t0;

    assert.equal(order.length, 5000);
    assert.equal(res.length, n);
    assert.equal(checked, n);
    assert.ok(n > 0);
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  });
});
