// Unit tests for app/js/importer.js (parseImport, planImport) and app/js/format.js.
// Run: node --test tests/unit/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseImport, planImport } from '../../app/js/importer.js';
import { FORMAT_EXAMPLE, FORMAT_HELP, buildAIPrompt } from '../../app/js/format.js';

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function ok(text) {
  const r = parseImport(text);
  assert.equal(r.ok, true, `expected ok, got: ${r.error}`);
  return r;
}

function fail(text) {
  const r = parseImport(text);
  assert.equal(r.ok, false, 'expected a parse failure');
  assert.equal(typeof r.error, 'string');
  return r.error;
}

/** In-memory equivalent of db.applyImportPlan, to chain imports in tests. */
function applyPlan(plan, state) {
  let seq = state.folders.length + state.cards.length;
  const ids = new Map();
  const resolve = (ref) => (ref == null ? null : ids.get(ref) ?? ref);
  for (const f of plan.newFolders) {
    const id = `f${++seq}`;
    ids.set(f.tempId, id);
    state.folders.push({ id, parentId: resolve(f.parentRef), name: f.name, order: f.order, createdAt: 0 });
  }
  for (const c of plan.newCards) {
    state.cards.push({
      id: `c${++seq}`,
      folderId: resolve(c.folderRef),
      front: { text: c.front, imageId: null, audioId: null },
      back: { text: c.back, imageId: null, audioId: null },
      order: c.order,
      createdAt: 0,
      updatedAt: 0,
    });
  }
  for (const u of plan.updatedCards) {
    const card = state.cards.find((c) => c.id === u.id);
    card.back = { ...card.back, text: u.back };
  }
  return state;
}

function importInto(state, json, targetFolderId = null) {
  const parsed = ok(typeof json === 'string' ? json : JSON.stringify(json));
  const plan = planImport(parsed.tree, { targetFolderId, folders: state.folders, cards: state.cards });
  applyPlan(plan, state);
  return plan;
}

const folderNamed = (state, name) => state.folders.find((f) => f.name === name);
const cardsIn = (state, folderId) =>
  state.cards.filter((c) => c.folderId === folderId).sort((a, b) => a.order - b.order);

const COURSE = {
  dossiers: [
    {
      nom: 'Comptabilité',
      dossiers: [
        {
          nom: 'Chapitre 1',
          cartes: [
            { recto: 'Bilan', verso: 'Photographie du patrimoine' },
            { recto: 'Actif', verso: 'Ce que possède l’entreprise' },
          ],
        },
        {
          nom: 'Chapitre 2',
          cartes: [{ recto: 'Résultat net', verso: 'Produits - Charges' }],
        },
      ],
    },
  ],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------------------------ */
/* format.js                                                                */
/* ------------------------------------------------------------------------ */

describe('format.js', () => {
  test('FORMAT_EXAMPLE is valid JSON matching the canonical example', () => {
    const data = JSON.parse(FORMAT_EXAMPLE);
    assert.equal(data.dossiers.length, 1);
    assert.equal(data.dossiers[0].nom, 'Comptabilité');
    assert.deepEqual(
      data.dossiers[0].dossiers.map((d) => d.nom),
      ['Chapitre 1 - Le bilan', 'Chapitre 2 - Le compte de résultat'],
    );
    assert.equal(
      data.dossiers[0].dossiers[1].cartes[0].verso,
      'Résultat net = Total des produits - Total des charges',
    );
    assert.match(FORMAT_EXAMPLE, /^\{\n {2}"dossiers": \[\n {4}\{/); // 2-space indentation
  });

  test('FORMAT_EXAMPLE parses into 1 root folder / 2 sub-folders / 3 cards', () => {
    const r = ok(FORMAT_EXAMPLE);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.tree.folders.length, 1);
    assert.equal(r.tree.cards.length, 0);
    const root = r.tree.folders[0];
    assert.equal(root.name, 'Comptabilité');
    assert.equal(root.folders.length, 2);
    assert.equal(root.cards.length, 0);
    const cardCount = root.folders.reduce((n, f) => n + f.cards.length, 0);
    assert.equal(cardCount, 3);
    assert.deepEqual(r.stats, { folders: 3, cards: 3 });
    assert.deepEqual(root.folders[0].cards[0], {
      front: 'Bilan',
      back: "Photographie du patrimoine de l'entreprise à une date donnée",
    });
  });

  test('FORMAT_HELP is a short French text', () => {
    assert.equal(typeof FORMAT_HELP, 'string');
    assert.match(FORMAT_HELP, /recto/);
    assert.match(FORMAT_HELP, /verso/);
    assert.ok(FORMAT_HELP.split('\n').length <= 8);
  });

  test('buildAIPrompt asks for JSON only and embeds the example', () => {
    const prompt = buildAIPrompt();
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.includes(FORMAT_EXAMPLE));
    assert.match(prompt, /UNIQUEMENT/);
    assert.match(prompt, /JSON/);
    assert.match(prompt, /chapitre/i);
    assert.match(prompt, /LaTeX/);
    assert.ok(prompt.includes('\\n'), 'mentions the \\n escape literally');
    assert.match(prompt, /même recto/);
  });
});

/* ------------------------------------------------------------------------ */
/* parseImport — root shapes                                                */
/* ------------------------------------------------------------------------ */

describe('parseImport — root shapes', () => {
  test('object with folder list', () => {
    const r = ok(JSON.stringify(COURSE));
    assert.equal(r.tree.folders.length, 1);
    assert.equal(r.tree.folders[0].folders[0].cards.length, 2);
    assert.deepEqual(r.stats, { folders: 3, cards: 3 });
  });

  test('object with cards only ⇒ root-level cards', () => {
    const r = ok('{"cartes": [{"recto": "A", "verso": "1"}, {"recto": "B", "verso": "2"}]}');
    assert.deepEqual(r.tree.folders, []);
    assert.deepEqual(r.tree.cards, [
      { front: 'A', back: '1' },
      { front: 'B', back: '2' },
    ]);
  });

  test('object with both folders and cards at the root', () => {
    const r = ok('{"cartes": [{"recto": "A", "verso": "1"}], "dossiers": [{"nom": "D"}]}');
    assert.equal(r.tree.cards.length, 1);
    assert.equal(r.tree.folders.length, 1);
    assert.equal(r.tree.folders[0].name, 'D');
  });

  test('object that is itself a folder ⇒ one root folder', () => {
    const r = ok('{"nom": "Droit", "cartes": [{"recto": "Contrat", "verso": "Accord de volontés"}]}');
    assert.equal(r.tree.folders.length, 1);
    assert.equal(r.tree.folders[0].name, 'Droit');
    assert.equal(r.tree.folders[0].cards.length, 1);
    assert.deepEqual(r.tree.cards, []);
  });

  test('array of folders', () => {
    const r = ok('[{"nom": "Ch1", "cartes": [{"recto": "a", "verso": "b"}]}, {"nom": "Ch2", "dossiers": [{"nom": "Sub"}]}]');
    assert.deepEqual(
      r.tree.folders.map((f) => f.name),
      ['Ch1', 'Ch2'],
    );
    assert.equal(r.tree.folders[1].folders[0].name, 'Sub');
    assert.deepEqual(r.stats, { folders: 3, cards: 1 });
  });

  test('array of cards ⇒ root-level cards', () => {
    const r = ok('[{"recto": "a", "verso": "b"}, {"front": "c", "back": "d"}]');
    assert.deepEqual(r.tree.folders, []);
    assert.deepEqual(r.tree.cards, [
      { front: 'a', back: 'b' },
      { front: 'c', back: 'd' },
    ]);
  });

  test('deep nesting is unlimited', () => {
    let node = { nom: 'N6', cartes: [{ recto: 'deep', verso: 'card' }] };
    for (let i = 5; i >= 1; i--) node = { nom: `N${i}`, dossiers: [node] };
    const r = ok(JSON.stringify({ dossiers: [node] }));
    let f = r.tree.folders[0];
    for (let i = 1; i < 6; i++) f = f.folders[0];
    assert.equal(f.name, 'N6');
    assert.deepEqual(f.cards, [{ front: 'deep', back: 'card' }]);
    assert.deepEqual(r.stats, { folders: 6, cards: 1 });
  });

  test('a folder may hold cards and sub-folders, order preserved', () => {
    const r = ok(
      JSON.stringify({
        dossiers: [{ nom: 'A', cartes: [{ recto: '1', verso: 'x' }, { recto: '2', verso: 'y' }], dossiers: [{ nom: 'B' }, { nom: 'C' }] }],
      }),
    );
    const a = r.tree.folders[0];
    assert.deepEqual(a.cards.map((c) => c.front), ['1', '2']);
    assert.deepEqual(a.folders.map((f) => f.name), ['B', 'C']);
  });

  test('a single card object at the root', () => {
    const r = ok('{"recto": "a", "verso": "b"}');
    assert.deepEqual(r.tree.cards, [{ front: 'a', back: 'b' }]);
  });

  test('flat card list with a chapter field keeps the cards', () => {
    const r = ok('[{"chapitre": "1", "recto": "a", "verso": "b"}, {"chapitre": "2", "question": "c", "reponse": "d"}]');
    assert.deepEqual(r.tree.cards, [
      { front: 'a', back: 'b' },
      { front: 'c', back: 'd' },
    ]);
  });

  test('cards misplaced in a folder list / folders misplaced in a card list are recovered', () => {
    const r = ok('{"nom": "A", "dossiers": [{"recto": "a", "verso": "b"}, {"nom": "B"}], "cartes": [{"nom": "C", "cartes": [{"recto": "c", "verso": "d"}]}]}');
    const a = r.tree.folders[0];
    assert.deepEqual(a.cards, [{ front: 'a', back: 'b' }]);
    assert.deepEqual(a.folders.map((f) => f.name), ['C', 'B']);
    assert.deepEqual(a.folders[0].cards, [{ front: 'c', back: 'd' }]);
  });

  test('object maps are accepted for folders and cards', () => {
    const r = ok('{"dossiers": {"Chapitre 1": {"cartes": {"Bilan": "Photographie", "Actif": "Biens"}}, "Chapitre 2": [{"recto": "x", "verso": "y"}]}}');
    assert.deepEqual(r.tree.folders.map((f) => f.name), ['Chapitre 1', 'Chapitre 2']);
    assert.deepEqual(r.tree.folders[0].cards, [
      { front: 'Bilan', back: 'Photographie' },
      { front: 'Actif', back: 'Biens' },
    ]);
    assert.deepEqual(r.tree.folders[1].cards, [{ front: 'x', back: 'y' }]);
  });

  test('cards given as [recto, verso] pairs', () => {
    const r = ok('{"nom": "A", "cartes": [["Bilan", "Photographie"], ["Actif", ["Biens", "Droits"]]]}');
    assert.deepEqual(r.tree.folders[0].cards, [
      { front: 'Bilan', back: 'Photographie' },
      { front: 'Actif', back: 'Biens\nDroits' },
    ]);
  });

  test('folders without cards are accepted', () => {
    const r = ok('{"dossiers": [{"nom": "Vide"}]}');
    assert.deepEqual(r.stats, { folders: 1, cards: 0 });
  });
});

/* ------------------------------------------------------------------------ */
/* parseImport — aliases & values                                           */
/* ------------------------------------------------------------------------ */

describe('parseImport — aliases and text values', () => {
  test('English aliases', () => {
    const r = ok('{"folders": [{"name": "F", "cards": [{"front": "a", "back": "b"}], "subfolders": [{"title": "S", "flashcards": [{"term": "t", "answer": "u"}]}]}]}');
    const f = r.tree.folders[0];
    assert.equal(f.name, 'F');
    assert.deepEqual(f.cards, [{ front: 'a', back: 'b' }]);
    assert.equal(f.folders[0].name, 'S');
    assert.deepEqual(f.folders[0].cards, [{ front: 't', back: 'u' }]);
  });

  test('uppercase and accented keys', () => {
    const r = ok('{"DOSSIERS": [{"Nom": "F", "Fiches": [{"Question": "a", "Réponse": "b"}, {"TERME": "c", "DÉFINITION": "d"}, {"Notion": "e", "Formule": "f"}]}]}');
    assert.deepEqual(r.tree.folders[0].cards, [
      { front: 'a', back: 'b' },
      { front: 'c', back: 'd' },
      { front: 'e', back: 'f' },
    ]);
  });

  test('reponse / definition without accents, q / a', () => {
    const r = ok('[{"question": "a", "reponse": "b"}, {"notion": "c", "definition": "d"}, {"q": "e", "a": "f"}]');
    assert.deepEqual(r.tree.cards, [
      { front: 'a', back: 'b' },
      { front: 'c', back: 'd' },
      { front: 'e', back: 'f' },
    ]);
  });

  test('sub-folder aliases: sous_dossiers, sousdossiers, chapitres, chapters, sections, children', () => {
    for (const key of ['sous_dossiers', 'sousdossiers', 'Sous_Dossiers', 'chapitres', 'Chapters', 'sections', 'children']) {
      const r = ok(JSON.stringify({ nom: 'Root', [key]: [{ titre: 'Sub', cartes: [{ recto: 'a', verso: 'b' }] }] }));
      assert.equal(r.tree.folders[0].folders[0].name, 'Sub', key);
      assert.equal(r.tree.folders[0].folders[0].cards.length, 1, key);
    }
  });

  test('folder name aliases: nom, name, titre, title, dossier, chapitre', () => {
    for (const key of ['nom', 'name', 'titre', 'Title', 'dossier', 'Chapitre']) {
      const r = ok(JSON.stringify({ dossiers: [{ [key]: 'Nommé', cartes: [{ recto: 'a', verso: 'b' }] }] }));
      assert.equal(r.tree.folders[0].name, 'Nommé', key);
      assert.deepEqual(r.warnings, [], key);
    }
  });

  test('text values: trimmed, inner line breaks kept, numbers and booleans stringified', () => {
    const r = ok(JSON.stringify([
      { recto: '  Bilan  ', verso: '  ligne 1\nligne 2  ' },
      { recto: 2024, verso: true },
    ]));
    assert.deepEqual(r.tree.cards, [
      { front: 'Bilan', back: 'ligne 1\nligne 2' },
      { front: '2024', back: 'true' },
    ]);
  });

  test('arrays of strings are joined with \\n', () => {
    const r = ok(JSON.stringify([{ recto: ['Résultat', 'net'], verso: ['Produits', '- Charges', '= Résultat'] }]));
    assert.deepEqual(r.tree.cards, [{ front: 'Résultat\nnet', back: 'Produits\n- Charges\n= Résultat' }]);
  });

  test('CRLF line breaks are normalised', () => {
    const r = ok(JSON.stringify([{ recto: 'a', verso: 'x\r\ny' }]));
    assert.equal(r.tree.cards[0].back, 'x\ny');
  });

  test('unknown keys are ignored silently', () => {
    const r = ok(JSON.stringify({ version: 3, auteur: 'moi', dossiers: [{ nom: 'A', couleur: 'bleu', cartes: [{ recto: 'a', verso: 'b', difficulte: 2 }] }] }));
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.tree.folders[0].cards, [{ front: 'a', back: 'b' }]);
  });

  test('a leading BOM is ignored', () => {
    const r = ok('\uFEFF[{"recto": "a", "verso": "b"}]');
    assert.equal(r.tree.cards.length, 1);
  });

  test('accepts an already parsed object', () => {
    const r = ok(clone(COURSE));
    assert.deepEqual(r.stats, { folders: 3, cards: 3 });
  });
});

/* ------------------------------------------------------------------------ */
/* parseImport — repairs                                                    */
/* ------------------------------------------------------------------------ */

describe('parseImport — fences and repairs', () => {
  test('```json fence with prose around', () => {
    const text = 'Voici ton JSON :\n\n```json\n{"cartes": [{"recto": "a", "verso": "b"}]}\n```\n\nBonne révision !';
    assert.deepEqual(ok(text).tree.cards, [{ front: 'a', back: 'b' }]);
  });

  test('plain ``` fence', () => {
    const text = '```\n[{"recto": "a", "verso": "b"}]\n```';
    assert.deepEqual(ok(text).tree.cards, [{ front: 'a', back: 'b' }]);
  });

  test('unclosed fence (truncated copy)', () => {
    const text = '```json\n[{"recto": "a", "verso": "b"}]\n';
    assert.equal(ok(text).tree.cards.length, 1);
  });

  test('prose around raw JSON without fence', () => {
    const text = 'Voici le résultat : {"cartes": [{"recto": "a", "verso": "b"}]} Bon courage.';
    assert.equal(ok(text).tree.cards.length, 1);
  });

  test('trailing commas are tolerated', () => {
    const text = '{\n  "dossiers": [\n    {\n      "nom": "A",\n      "cartes": [\n        {"recto": "a", "verso": "b",},\n      ],\n    },\n  ],\n}';
    const r = ok(text);
    assert.equal(r.tree.folders[0].cards.length, 1);
  });

  test('a comma inside a string is not touched by the trailing-comma repair', () => {
    const r = ok('[{"recto": "a", "verso": "x, ]"},]');
    assert.equal(r.tree.cards[0].back, 'x, ]');
  });

  test('comments are tolerated', () => {
    const r = ok('[\n  // chapitre 1\n  {"recto": "a", "verso": "http://exemple.fr"} /* fin */\n]');
    assert.equal(r.tree.cards[0].back, 'http://exemple.fr');
  });

  test('typographic quotes used as JSON delimiters are repaired', () => {
    const r = ok('{“cartes”: [{“recto”: “Bilan”, “verso”: “Photographie”}]}');
    assert.deepEqual(r.tree.cards, [{ front: 'Bilan', back: 'Photographie' }]);
  });

  test('typographic quotes inside valid strings are kept', () => {
    const r = ok('[{"recto": "Citation", "verso": "Il a dit “bonjour”, puis est parti"}]');
    assert.equal(r.tree.cards[0].back, 'Il a dit “bonjour”, puis est parti');
  });
});

/* ------------------------------------------------------------------------ */
/* parseImport — errors & warnings                                          */
/* ------------------------------------------------------------------------ */

describe('parseImport — errors and warnings', () => {
  test('invalid JSON reports line and column in French', () => {
    const text = '{\n  "cartes": [\n    {"recto": "a", "verso": "b"}\n    {"recto": "c", "verso": "d"}\n  ]\n}';
    const error = fail(text);
    assert.match(error, /^JSON invalide \(ligne 4, colonne 5\) : /);
    assert.match(error, /virgule/);
  });

  test('missing colon is located precisely', () => {
    const error = fail('{\n  "cartes" [\n  ]\n}');
    assert.match(error, /ligne 2, colonne 12/);
    assert.match(error, /« : »/);
  });

  test('unterminated JSON reports the end of the text', () => {
    const error = fail('{\n  "cartes": [\n    {"recto": "a", "verso": "b"}\n');
    assert.match(error, /^JSON invalide \(ligne 3, colonne 33\)/); // just after the last character
    assert.match(error, /fin du texte/);
  });

  test('raw line break inside a string', () => {
    const error = fail('[{"recto": "a", "verso": "ligne 1\nligne 2"}]');
    assert.match(error, /ligne 1, colonne 34/);
    assert.match(error, /\\n/);
  });

  test('line numbers refer to the pasted text even with a fence', () => {
    const text = 'Voici :\n```json\n[\n  {"recto": "a" "verso": "b"}\n]\n```';
    const error = fail(text);
    assert.match(error, /ligne 4, colonne 17/);
  });

  test('French guillemets as delimiters give a helpful message', () => {
    const error = fail('[{«recto»: «a», «verso»: «b»}]');
    assert.match(error, /guillemet/);
    assert.match(error, /ligne 1, colonne 3/);
  });

  test('missing verso / recto ⇒ card skipped with a readable path', () => {
    const r = ok(
      JSON.stringify({
        dossiers: [
          {
            nom: 'Comptabilité',
            dossiers: [
              {
                nom: 'Chapitre 1',
                cartes: [
                  { recto: 'ok', verso: 'ok' },
                  { recto: 'a', verso: 'b' },
                  { recto: 'Sans verso' },
                  { verso: 'Sans recto' },
                  { recto: '   ', verso: '' },
                  'texte seul',
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(r.warnings, [
      'Comptabilité › Chapitre 1 › carte n°3 : verso manquant',
      'Comptabilité › Chapitre 1 › carte n°4 : recto manquant',
      'Comptabilité › Chapitre 1 › carte n°5 : recto et verso manquants',
      'Comptabilité › Chapitre 1 › carte n°6 : format de carte non reconnu, ignorée',
    ]);
    assert.equal(r.tree.folders[0].folders[0].cards.length, 2);
    assert.deepEqual(r.stats, { folders: 2, cards: 2 });
  });

  test('root-level card warnings have no folder prefix', () => {
    const r = ok('[{"recto": "a", "verso": "b"}, {"recto": "c"}]');
    assert.deepEqual(r.warnings, ['Carte n°2 : verso manquant']);
  });

  test('folder without a name ⇒ « Sans nom » + warning', () => {
    const r = ok('{"dossiers": [{"nom": "A", "dossiers": [{"cartes": [{"recto": "a", "verso": "b"}]}]}]}');
    const sub = r.tree.folders[0].folders[0];
    assert.equal(sub.name, 'Sans nom');
    assert.equal(sub.cards.length, 1);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^A › dossier n°1 : nom manquant/);
    assert.match(r.warnings[0], /Sans nom/);
  });

  test('paths of cards under an unnamed folder use « Sans nom »', () => {
    const r = ok('{"dossiers": [{"cartes": [{"recto": "a"}]}]}');
    assert.ok(r.warnings.includes('Sans nom › carte n°1 : verso manquant'));
  });

  test('duplicate recto in a folder is reported (but kept)', () => {
    const r = ok('{"nom": "A", "cartes": [{"recto": "Bilan", "verso": "1"}, {"recto": " bilan ", "verso": "2"}]}');
    assert.equal(r.tree.folders[0].cards.length, 2);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /A › carte n°2 : recto en double/);
  });

  test('duplicate recto among root-level cards is reported too', () => {
    const r = ok('[{"recto": "a", "verso": "1"}, {"recto": "A", "verso": "2"}]');
    assert.deepEqual(r.warnings, ['Carte n°2 : recto en double « A »']);
  });

  test('backup files are detected', () => {
    const backup = { app: 'recto', kind: 'backup', version: 1, folders: [], cards: [], methods: [], progress: [], meta: [], media: [] };
    const expected = 'Ce fichier est une sauvegarde complète : utilise « Restaurer une sauvegarde ».';
    assert.equal(fail(JSON.stringify(backup)), expected);
    assert.equal(fail(JSON.stringify({ kind: 'backup' })), expected);
    assert.equal(fail(JSON.stringify({ app: 'recto', media: [], dossiers: [] })), expected);
  });

  test('empty inputs', () => {
    for (const text of ['', '   \n ', null, undefined]) {
      assert.equal(parseImport(text).ok, false);
    }
    for (const text of ['{}', '[]', '{"dossiers": []}', '{"cartes": []}', '{"foo": "bar"}', '42', '"texte"']) {
      assert.match(fail(text), /^Aucune carte trouvée/, text);
    }
  });

  test('only invalid cards ⇒ « Aucune carte trouvée »', () => {
    assert.match(fail('[{"recto": "a"}, {"verso": "b"}]'), /^Aucune carte trouvée/);
  });
});

/* ------------------------------------------------------------------------ */
/* planImport                                                               */
/* ------------------------------------------------------------------------ */

describe('planImport', () => {
  test('fresh import into the root', () => {
    const parsed = ok(JSON.stringify(COURSE));
    const plan = planImport(parsed.tree, { targetFolderId: null, folders: [], cards: [] });
    assert.equal(plan.target, null);
    assert.deepEqual(plan.summary, { foldersNew: 3, foldersReused: 0, cardsNew: 3, cardsUpdated: 0, cardsUnchanged: 0 });
    assert.deepEqual(plan.updatedCards, []);

    const [root, ch1, ch2] = plan.newFolders;
    assert.deepEqual(
      plan.newFolders.map((f) => f.name),
      ['Comptabilité', 'Chapitre 1', 'Chapitre 2'],
    );
    assert.equal(root.parentRef, null);
    assert.equal(ch1.parentRef, root.tempId);
    assert.equal(ch2.parentRef, root.tempId);
    assert.ok(ch1.order < ch2.order);
    assert.equal(new Set(plan.newFolders.map((f) => f.tempId)).size, 3);

    assert.deepEqual(
      plan.newCards.map((c) => [c.folderRef, c.front, c.back]),
      [
        [ch1.tempId, 'Bilan', 'Photographie du patrimoine'],
        [ch1.tempId, 'Actif', 'Ce que possède l’entreprise'],
        [ch2.tempId, 'Résultat net', 'Produits - Charges'],
      ],
    );
    assert.ok(plan.newCards[0].order < plan.newCards[1].order);
  });

  test('parents always come before their children', () => {
    const state = { folders: [], cards: [] };
    const plan = importInto(state, { dossiers: [{ nom: 'A', dossiers: [{ nom: 'B', dossiers: [{ nom: 'C' }] }, { nom: 'D' }] }] });
    const seen = new Set([null]);
    for (const f of plan.newFolders) {
      assert.ok(seen.has(f.parentRef), `${f.name} after its parent`);
      seen.add(f.tempId);
    }
  });

  test('re-importing the identical file changes nothing', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const plan = importInto(state, COURSE);
    assert.deepEqual(plan.newFolders, []);
    assert.deepEqual(plan.newCards, []);
    assert.deepEqual(plan.updatedCards, []);
    assert.deepEqual(plan.summary, { foldersNew: 0, foldersReused: 3, cardsNew: 0, cardsUpdated: 0, cardsUnchanged: 3 });
    assert.equal(state.folders.length, 3);
    assert.equal(state.cards.length, 3);
  });

  test('matching ignores case, extra spaces and NFC/NFD differences', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const variant = clone(COURSE);
    variant.dossiers[0].nom = '  comptabilite\u0301 '; // NFD é, lower case, spaces
    variant.dossiers[0].dossiers[0].nom = 'CHAPITRE   1';
    variant.dossiers[0].dossiers[0].cartes[0].recto = ' bilan ';
    const plan = importInto(state, variant);
    assert.deepEqual(plan.summary, { foldersNew: 0, foldersReused: 3, cardsNew: 0, cardsUpdated: 0, cardsUnchanged: 3 });
  });

  test('re-import with one more chapter adds only the new chapter', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const enriched = clone(COURSE);
    enriched.dossiers[0].dossiers.push({
      nom: 'Chapitre 3',
      cartes: [
        { recto: 'Trésorerie', verso: 'Disponibilités' },
        { recto: 'BFR', verso: 'Besoin en fonds de roulement' },
      ],
    });
    const root = folderNamed(state, 'Comptabilité');
    const plan = importInto(state, enriched);
    assert.deepEqual(plan.summary, { foldersNew: 1, foldersReused: 3, cardsNew: 2, cardsUpdated: 0, cardsUnchanged: 3 });
    assert.equal(plan.newFolders.length, 1);
    assert.equal(plan.newFolders[0].name, 'Chapitre 3');
    assert.equal(plan.newFolders[0].parentRef, root.id); // existing folder id
    const ch2 = folderNamed(state, 'Chapitre 2');
    assert.ok(plan.newFolders[0].order > ch2.order, 'new chapter after the existing ones');
    assert.ok(plan.newCards.every((c) => c.folderRef === plan.newFolders[0].tempId));
    assert.deepEqual(cardsIn(state, folderNamed(state, 'Chapitre 3').id).map((c) => c.front.text), ['Trésorerie', 'BFR']);
  });

  test('new cards in an existing folder are appended after the existing ones, in JSON order', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const ch1 = folderNamed(state, 'Chapitre 1');
    // Simulate a manually reordered folder with a gap.
    cardsIn(state, ch1.id)[1].order = 10;
    const enriched = clone(COURSE);
    enriched.dossiers[0].dossiers[0].cartes.push({ recto: 'Passif', verso: 'Dettes + capitaux propres' }, { recto: 'Capitaux propres', verso: 'Actif - Dettes' });
    const plan = importInto(state, enriched);
    assert.deepEqual(plan.newCards.map((c) => [c.front, c.order]), [['Passif', 11], ['Capitaux propres', 12]]);
    assert.ok(plan.newCards.every((c) => c.folderRef === ch1.id));
  });

  test('a changed verso is an update of the existing card', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const actif = state.cards.find((c) => c.front.text === 'Actif');
    actif.back.imageId = 'img-1'; // media must be kept by the update
    const changed = clone(COURSE);
    changed.dossiers[0].dossiers[0].cartes[1].verso = 'Ressources contrôlées par l’entreprise';
    const plan = importInto(state, changed);
    assert.deepEqual(plan.summary, { foldersNew: 0, foldersReused: 3, cardsNew: 0, cardsUpdated: 1, cardsUnchanged: 2 });
    assert.deepEqual(plan.updatedCards, [{ id: actif.id, back: 'Ressources contrôlées par l’entreprise' }]);
    assert.equal(state.cards.length, 3);
  });

  test('verso differing only by case/spaces is unchanged', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const variant = clone(COURSE);
    variant.dossiers[0].dossiers[1].cartes[0].verso = 'produits   -  charges';
    const plan = importInto(state, variant);
    assert.equal(plan.summary.cardsUnchanged, 3);
    assert.deepEqual(plan.updatedCards, []);
  });

  test('duplicate rectos: each existing card is matched at most once', () => {
    const json = { nom: 'Dup', cartes: [{ recto: 'Bilan', verso: 'définition' }, { recto: 'Bilan', verso: 'formule' }] };
    const state = { folders: [], cards: [] };
    const first = importInto(state, json);
    assert.equal(first.summary.cardsNew, 2);

    // Identical re-import: both matched, nothing new.
    const again = importInto(state, json);
    assert.deepEqual(again.summary, { foldersNew: 0, foldersReused: 1, cardsNew: 0, cardsUpdated: 0, cardsUnchanged: 2 });

    // Reordered duplicates: exact (recto + verso) matches win, still unchanged.
    const reordered = { nom: 'Dup', cartes: [json.cartes[1], json.cartes[0]] };
    const third = importInto(state, reordered);
    assert.deepEqual(third.summary, { foldersNew: 0, foldersReused: 1, cardsNew: 0, cardsUpdated: 0, cardsUnchanged: 2 });

    // A third card with the same recto is new.
    const more = { nom: 'Dup', cartes: [...json.cartes, { recto: 'Bilan', verso: 'exemple' }] };
    const fourth = importInto(state, more);
    assert.deepEqual(fourth.summary, { foldersNew: 0, foldersReused: 1, cardsNew: 1, cardsUpdated: 0, cardsUnchanged: 2 });
    assert.equal(state.cards.length, 3);
  });

  test('duplicate recto against a single existing card: one match, one update-free new card', () => {
    const state = { folders: [], cards: [] };
    importInto(state, { nom: 'A', cartes: [{ recto: 'X', verso: '1' }] });
    const plan = importInto(state, { nom: 'A', cartes: [{ recto: 'X', verso: '2' }, { recto: 'X', verso: '1' }] });
    // The exact match (X → 1) is unchanged; the other X is new (the existing card is already taken).
    assert.deepEqual(plan.summary, { foldersNew: 0, foldersReused: 1, cardsNew: 1, cardsUpdated: 0, cardsUnchanged: 1 });
    assert.deepEqual(plan.newCards.map((c) => c.back), ['2']);
  });

  test('cards are matched only within the same folder', () => {
    const state = { folders: [], cards: [] };
    importInto(state, { dossiers: [{ nom: 'A', cartes: [{ recto: 'X', verso: '1' }] }] });
    const plan = importInto(state, { dossiers: [{ nom: 'B', cartes: [{ recto: 'X', verso: '1' }] }] });
    assert.deepEqual(plan.summary, { foldersNew: 1, foldersReused: 0, cardsNew: 1, cardsUpdated: 0, cardsUnchanged: 0 });
  });

  test('folders are matched only under the same parent', () => {
    const state = { folders: [], cards: [] };
    importInto(state, { dossiers: [{ nom: 'Maths', dossiers: [{ nom: 'Chapitre 1' }] }] });
    const plan = importInto(state, { dossiers: [{ nom: 'Chapitre 1', cartes: [{ recto: 'a', verso: 'b' }] }] });
    assert.equal(plan.summary.foldersNew, 1);
    assert.equal(plan.newFolders[0].parentRef, null);
  });

  test('duplicate folder names in the same JSON parent are merged', () => {
    const plan = planImport(
      ok('{"dossiers": [{"nom": "A", "cartes": [{"recto": "1", "verso": "x"}]}, {"nom": "a", "cartes": [{"recto": "2", "verso": "y"}]}]}').tree,
      { targetFolderId: null, folders: [], cards: [] },
    );
    assert.equal(plan.newFolders.length, 1);
    assert.equal(plan.summary.foldersNew, 1);
    assert.deepEqual(plan.newCards.map((c) => [c.front, c.order]), [['1', 0], ['2', 1]]);
  });

  test('import into a nested target folder', () => {
    const state = { folders: [], cards: [] };
    importInto(state, { dossiers: [{ nom: 'Cours', dossiers: [{ nom: 'Partie 1', dossiers: [{ nom: 'Chapitre 1', cartes: [{ recto: 'a', verso: 'b' }] }] }] }] });
    // A root folder with the same name as a chapter must NOT be reused when importing into « Partie 1 ».
    importInto(state, { dossiers: [{ nom: 'Chapitre 2' }] });
    const partie = folderNamed(state, 'Partie 1');
    const chapitre1 = folderNamed(state, 'Chapitre 1');

    const plan = importInto(
      state,
      [
        { nom: 'Chapitre 1', cartes: [{ recto: 'a', verso: 'b' }, { recto: 'c', verso: 'd' }] },
        { nom: 'Chapitre 2', cartes: [{ recto: 'e', verso: 'f' }] },
      ],
      partie.id,
    );
    assert.equal(plan.target, partie.id);
    assert.deepEqual(plan.summary, { foldersNew: 1, foldersReused: 1, cardsNew: 2, cardsUpdated: 0, cardsUnchanged: 1 });
    assert.equal(plan.newFolders[0].name, 'Chapitre 2');
    assert.equal(plan.newFolders[0].parentRef, partie.id);
    assert.equal(plan.newFolders[0].order, chapitre1.order + 1);
    assert.equal(plan.newCards[0].folderRef, chapitre1.id);
    assert.equal(plan.newCards[1].folderRef, plan.newFolders[0].tempId);
  });

  test('root-level cards go into a new « Import » folder when the target is the root', () => {
    const parsed = ok('[{"recto": "a", "verso": "b"}, {"recto": "c", "verso": "d"}]');
    const existing = [{ id: 'x', parentId: null, name: 'Autre', order: 4, createdAt: 0 }];
    const plan = planImport(parsed.tree, { targetFolderId: null, folders: existing, cards: [] });
    assert.equal(plan.newFolders.length, 1);
    assert.deepEqual(
      { name: plan.newFolders[0].name, parentRef: plan.newFolders[0].parentRef, order: plan.newFolders[0].order },
      { name: 'Import', parentRef: null, order: 5 },
    );
    assert.ok(plan.newCards.every((c) => c.folderRef === plan.newFolders[0].tempId));
    assert.equal(plan.summary.cardsNew, 2);
  });

  test('root-level cards reuse an existing root « Import » folder', () => {
    const state = { folders: [], cards: [] };
    importInto(state, '[{"recto": "a", "verso": "b"}]');
    assert.equal(state.folders.length, 1);
    assert.equal(state.folders[0].name, 'Import');
    const plan = importInto(state, '[{"recto": "a", "verso": "b"}, {"recto": "c", "verso": "d"}]');
    assert.deepEqual(plan.newFolders, []);
    assert.deepEqual(plan.summary, { foldersNew: 0, foldersReused: 1, cardsNew: 1, cardsUpdated: 0, cardsUnchanged: 1 });
    assert.equal(plan.newCards[0].folderRef, state.folders[0].id);
  });

  test('root-level cards go directly into the target folder when there is one', () => {
    const folders = [{ id: 'T', parentId: null, name: 'Cible', order: 0, createdAt: 0 }];
    const cards = [{ id: 'k', folderId: 'T', front: { text: 'a' }, back: { text: 'b' }, order: 7, createdAt: 0 }];
    const parsed = ok('[{"recto": "a", "verso": "b"}, {"recto": "c", "verso": "d"}]');
    const plan = planImport(parsed.tree, { targetFolderId: 'T', folders, cards });
    assert.deepEqual(plan.newFolders, []);
    assert.deepEqual(plan.newCards, [{ folderRef: 'T', front: 'c', back: 'd', order: 8 }]);
    assert.equal(plan.summary.cardsUnchanged, 1);
  });

  test('existing cards without recto text are never matched', () => {
    const folders = [{ id: 'T', parentId: null, name: 'Cible', order: 0, createdAt: 0 }];
    const cards = [{ id: 'k', folderId: 'T', front: { text: '', imageId: 'img' }, back: { text: 'b' }, order: 0, createdAt: 0 }];
    const plan = planImport(ok('{"nom": "Cible", "cartes": [{"recto": "a", "verso": "b"}]}').tree, { targetFolderId: null, folders, cards });
    assert.equal(plan.summary.cardsNew, 1);
    assert.equal(plan.summary.foldersReused, 1);
  });

  test('unknown target folder throws', () => {
    assert.throws(() => planImport({ folders: [], cards: [] }, { targetFolderId: 'nope', folders: [], cards: [] }), /introuvable/);
  });

  test('planImport does not mutate its inputs', () => {
    const state = { folders: [], cards: [] };
    importInto(state, COURSE);
    const snapshot = clone(state);
    const parsed = ok(JSON.stringify(COURSE));
    const treeSnapshot = clone(parsed.tree);
    planImport(parsed.tree, { targetFolderId: null, folders: state.folders, cards: state.cards });
    assert.deepEqual(state, snapshot);
    assert.deepEqual(parsed.tree, treeSnapshot);
  });

  test('scales to large imports', () => {
    const big = { dossiers: [] };
    for (let ch = 0; ch < 20; ch++) {
      big.dossiers.push({ nom: `Chapitre ${ch}`, cartes: Array.from({ length: 250 }, (_, i) => ({ recto: `Notion ${ch}.${i}`, verso: `Déf ${i}` })) });
    }
    const state = { folders: [], cards: [] };
    importInto(state, big);
    const t0 = Date.now();
    const plan = importInto(state, big);
    assert.equal(plan.summary.cardsUnchanged, 5000);
    assert.ok(Date.now() - t0 < 2000);
  });
});
