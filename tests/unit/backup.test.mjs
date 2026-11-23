// Unit tests for the backup file format of app/js/db.js (buildBackupFile / openBackupFile).
// Only the pure parts run here (no IndexedDB in Node); the real export → restore goes through the e2e run.
// Run: node --test tests/unit/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildBackupFile, openBackupFile } from '../../app/js/db.js';
import { arrayBufferToBase64 } from '../../app/js/util.js';

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                 */
/* ------------------------------------------------------------------------ */

function bytes(n, seed) {
  const a = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    a[i] = x >>> 24;
  }
  return a.buffer;
}

const SMALL = {
  folders: [{ id: 'f1', parentId: null, name: 'Chapitre 1 — éléments', order: 0, createdAt: 1 }],
  cards: [
    {
      id: 'c1',
      folderId: 'f1',
      front: { text: 'Bilan 📘', imageId: 'm1', audioId: null },
      back: { text: 'Photographie du patrimoine\nà une date donnée', imageId: null, audioId: 'm2' },
      order: 0,
      createdAt: 1,
      updatedAt: 2,
      imported: { front: 'Bilan', back: 'Photo' },
    },
  ],
  methods: [{ id: 'mt', name: 'Partiel', rules: { 'f:f1': true }, newPerDay: 20, shuffleNew: false, direction: 'front', newToday: { day: '', count: 0 }, createdAt: 1, updatedAt: 1 }],
  progress: [{ id: 'mt|c1', methodId: 'mt', cardId: 'c1', level: 1, status: 'review', dueDay: '2026-01-02', reps: 1, lapses: 0, lastDay: '2026-01-01', lastAnsweredAt: 5 }],
  meta: [{ key: 'lastBackupAt', value: 3 }],
};

const MEDIA = [
  { id: 'm1', type: 'image/jpeg', data: bytes(300_000, 1), size: 300_000, createdAt: 10 },
  { id: 'm2', type: 'audio/mp4', data: bytes(1_234, 2), size: 1_234, createdAt: 11 },
  { id: 'm3', type: 'image/png', data: bytes(0, 3), size: 0, createdAt: 12 },
];

async function build(media = MEDIA) {
  return buildBackupFile('recto-sauvegarde-test.json', SMALL, media);
}

function sameBytes(a, b) {
  return Buffer.from(a).equals(Buffer.from(b));
}

function checkRecords(records, media = MEDIA) {
  assert.deepEqual(records.folders, SMALL.folders);
  assert.deepEqual(records.cards, SMALL.cards); // extra fields (card.imported) survive
  assert.deepEqual(records.methods, SMALL.methods);
  assert.deepEqual(records.progress, SMALL.progress);
  assert.deepEqual(records.meta, SMALL.meta);
  assert.equal(records.media.length, media.length);
  records.media.forEach((m, i) => {
    assert.equal(m.id, media[i].id);
    assert.equal(m.type, media[i].type);
    assert.equal(m.createdAt, media[i].createdAt);
    assert.equal(m.size, media[i].data.byteLength);
    assert.ok(m.data instanceof ArrayBuffer);
    assert.ok(sameBytes(m.data, media[i].data), `bytes of ${m.id}`);
  });
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                    */
/* ------------------------------------------------------------------------ */

describe('backup file', () => {
  test('the exported file is a plain backup v1 JSON, one media per line', async () => {
    const file = await build();
    assert.equal(file.name, 'recto-sauvegarde-test.json');
    assert.equal(file.type, 'application/json');
    const text = await file.text();
    const obj = JSON.parse(text);
    assert.equal(obj.app, 'recto');
    assert.equal(obj.kind, 'backup');
    assert.equal(obj.version, 1);
    assert.ok(!Number.isNaN(Date.parse(obj.exportedAt)));
    assert.deepEqual(obj.cards, SMALL.cards);
    assert.deepEqual(
      obj.media.map((m) => [m.id, m.type, m.size, m.createdAt]),
      MEDIA.map((m) => [m.id, m.type, m.data.byteLength, m.createdAt]),
    );
    assert.equal(obj.media[1].data, arrayBufferToBase64(MEDIA[1].data));
    const lines = text.split('\n');
    assert.equal(lines.length, MEDIA.length + 2);
    assert.ok(lines[0].endsWith('"media":['));
    assert.equal(lines.at(-1), ']}');
  });

  test('round trip: head first, then every record, whatever the chunk size', async () => {
    const file = await build();
    for (const chunkSize of [1, 3, 7, 64, 4096, undefined]) {
      const backup = await openBackupFile(file, chunkSize ? { chunkSize } : {});
      assert.equal(backup.head.app, 'recto');
      assert.equal(backup.head.kind, 'backup');
      assert.equal('media' in backup.head, false, 'the head does not hold the media');
      assert.equal(backup.head.cards.length, 1);
      assert.equal(typeof backup.restore, 'function');
      checkRecords(await backup.read(), MEDIA);
    }
  });

  test('a media line split across many chunks (multi-byte characters included)', async () => {
    const file = await build([{ id: 'big', type: 'audio/webm', data: bytes(2_000_000, 7), createdAt: 1 }]);
    const backup = await openBackupFile(file, { chunkSize: 65_537 });
    const records = await backup.read();
    assert.equal(records.cards[0].front.text, 'Bilan 📘');
    assert.ok(sameBytes(records.media[0].data, bytes(2_000_000, 7)));
  });

  test('no media at all', async () => {
    const file = await build([]);
    assert.deepEqual(JSON.parse(await file.text()).media, []);
    const backup = await openBackupFile(file, { chunkSize: 5 });
    checkRecords(await backup.read(), []);
  });

  test('a single-line backup made by the previous version still restores', async () => {
    const legacy = {
      app: 'recto',
      kind: 'backup',
      version: 1,
      exportedAt: '2026-01-01T10:00:00.000Z',
      ...SMALL,
      media: MEDIA.map((m) => ({ id: m.id, type: m.type, size: m.data.byteLength, createdAt: m.createdAt, data: arrayBufferToBase64(m.data) })),
    };
    for (const text of [JSON.stringify(legacy), `﻿${JSON.stringify(legacy, null, 2)}\n`]) {
      const backup = await openBackupFile(new File([text], 'ancienne.json'), { chunkSize: 16 });
      assert.equal(backup.head.exportedAt, '2026-01-01T10:00:00.000Z');
      checkRecords(await backup.read(), MEDIA);
    }
  });

  test('BOM and Windows line breaks (file edited or re-saved) are tolerated', async () => {
    const text = await (await build()).text();
    const file = new File([`﻿${text.replace(/\n/g, '\r\n')}\r\n`], 'b.json');
    const backup = await openBackupFile(file, { chunkSize: 9 });
    assert.equal('media' in backup.head, false, 'read line by line');
    checkRecords(await backup.read(), MEDIA);
  });

  test('a truncated file is refused (nothing to restore)', async () => {
    const text = await (await build()).text();
    // Cut inside the last media line, then keep a valid-looking ending.
    const cut = text.slice(0, text.lastIndexOf('\n'));
    await assert.rejects(async () => (await openBackupFile(new File([cut], 'b.json'))).read(), /Sauvegarde invalide|JSON valide/);
    const lines = text.split('\n');
    const missingLine = [...lines.slice(0, 2), lines.at(-1)].join('\n').replace(/,\n\]\}$/, '\n]}');
    const ok = await (await openBackupFile(new File([missingLine], 'b.json'))).read();
    assert.equal(ok.media.length, 1); // a complete file with fewer media is still valid
    const broken = text.replace(/\n\]\}$/, '');
    await assert.rejects(async () => (await openBackupFile(new File([`${broken}\n]}x`], 'b.json'))).read(), /JSON valide|Sauvegarde invalide/);
  });

  test('a damaged media line is refused', async () => {
    const text = await (await build()).text();
    const cut = text.split('\n');
    cut[2] = cut[2].slice(0, 40); // second media line cut short
    await assert.rejects(async () => (await openBackupFile(new File([cut.join('\n')], 'b.json'))).read(), /média illisible/);
    const bad = text.split('\n');
    bad[1] = bad[1].replace(/"data":"[^"]*"/, '"data":"@@@"');
    await assert.rejects(async () => (await openBackupFile(new File([bad.join('\n')], 'b.json'))).read(), /média illisible/);
  });

  test('anything that is not a Recto backup', async () => {
    await assert.rejects(() => openBackupFile(new File(['pas du JSON'], 'a.json')), /pas un JSON valide/);
    await assert.rejects(() => openBackupFile(new File([''], 'a.json')), /pas un JSON valide/);
    const other = await openBackupFile(new File(['{"dossiers": []}'], 'a.json'));
    assert.equal(other.head.app, undefined); // the UI says « pas une sauvegarde Recto »
    await assert.rejects(() => other.read(), /pas une sauvegarde de Recto/);
    // Line layout but a head that is not ours.
    const fake = await openBackupFile(new File(['{"app":"autre","media":[\n{"id":"x","data":""}\n]}'], 'a.json'));
    assert.equal(fake.head.app, 'autre');
    await assert.rejects(() => fake.read(), /pas une sauvegarde de Recto/);
  });
});
