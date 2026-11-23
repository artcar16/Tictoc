// Unit tests for the pure text helpers of the UI (app/js/dom.js) and the importer's handling of
// big / backup files (app/js/importer.js).
// Run: node --test tests/unit/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { frSpaces } from '../../app/js/dom.js';
import { parseImport, isBackupObject } from '../../app/js/importer.js';

const NBSP = ' ';

describe('frSpaces (French typography)', () => {
  test('non-breaking space inside guillemets and before ? ! : ;', () => {
    assert.equal(frSpaces('Supprimer « Chapitre 3 - Les SIG » ?'), `Supprimer «${NBSP}Chapitre 3 - Les SIG${NBSP}»${NBSP}?`);
    assert.equal(frSpaces('Erreur : oups ; encore !'), `Erreur${NBSP}: oups${NBSP}; encore${NBSP}!`);
  });

  test('other spaces stay breakable, text without these signs is unchanged', () => {
    assert.equal(frSpaces('Tout effacer'), 'Tout effacer');
    assert.equal(frSpaces('a - b, c (d)'), 'a - b, c (d)');
    assert.equal(frSpaces('http://exemple.fr?x=1'), 'http://exemple.fr?x=1');
  });

  test('accepts any value', () => {
    assert.equal(frSpaces(null), '');
    assert.equal(frSpaces(undefined), '');
    assert.equal(frSpaces(3), '3');
  });
});

describe('importer: backups and big files', () => {
  test('isBackupObject recognises Recto backups only', () => {
    assert.equal(isBackupObject({ app: 'recto', kind: 'backup', media: [] }), true);
    assert.equal(isBackupObject({ app: 'recto', media: [] }), true);
    assert.equal(isBackupObject({ kind: 'backup' }), true);
    assert.equal(isBackupObject({ dossiers: [] }), false);
    assert.equal(isBackupObject([{ recto: 'a', verso: 'b' }]), false);
    assert.equal(isBackupObject(null), false);
    assert.equal(isBackupObject('backup'), false);
  });

  test('a big backup text is refused at about the cost of JSON.parse (no repaired copies)', () => {
    const photo = 'A'.repeat(300_000); // base64 photo
    const backup = { app: 'recto', kind: 'backup', version: 1, folders: [], cards: [], methods: [], progress: [], meta: [], media: [] };
    for (let i = 0; i < 80; i++) backup.media.push({ id: `m${i}`, type: 'image/jpeg', data: photo });
    const text = JSON.stringify(backup); // ~24 MB
    JSON.parse(text); // warm-up
    let t0 = performance.now();
    JSON.parse(text);
    const parseMs = performance.now() - t0;
    t0 = performance.now();
    const r = parseImport(text);
    const ms = performance.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error, /sauvegarde complète/);
    // Valid JSON is parsed as is: the repairs (a copy of the text per attempt, scanned character
    // by character) only run when it fails. They used to run first: ~20 × JSON.parse.
    assert.ok(ms < 8 * parseMs + 60, `trop lent : ${Math.round(ms)} ms (JSON.parse : ${Math.round(parseMs)} ms)`);
  });

  test('repairs keep positions: an error after a comment and a trailing comma is located exactly', () => {
    const text = '{\n  // chapitre 1\n  "dossiers": [\n    { "nom": "A", "cartes": [{"recto": "a", "verso": "b"},] }\n    { "nom": "B" }\n  ]\n}';
    const r = parseImport(text);
    assert.equal(r.ok, false);
    assert.match(r.error, /^JSON invalide \(ligne 5, colonne 5\)/);
  });

  test('a long text with comments everywhere is repaired', () => {
    const items = [];
    for (let i = 0; i < 2000; i++) items.push(`  // carte ${i}\n  {"recto": "r${i}", "verso": "v${i}, ]"}, /* ok */`);
    const r = parseImport(`[\n${items.join('\n')}\n]`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tree.cards.length, 2000);
    assert.equal(r.tree.cards[1999].back, 'v1999, ]');
  });
});
