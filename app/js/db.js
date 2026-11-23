// IndexedDB persistence layer for Recto (database « recto », version 1).
//
// Conventions:
// - Every function is async and returns plain objects (Blob for media).
// - Write operations resolve only once their transaction has committed ('complete').
// - Inside a transaction we only ever await IndexedDB requests: awaiting anything else
//   (Blob → ArrayBuffer, fetch, timers…) would let the transaction auto-commit. Such work is
//   always done BEFORE the transaction is opened.

import { uid, arrayBufferToBase64, base64ToArrayBuffer } from './util.js';

const DB_NAME = 'recto';
const DB_VERSION = 1;
const STORES = ['folders', 'cards', 'media', 'methods', 'progress', 'meta'];
const CARD_CASCADE_STORES = ['folders', 'cards', 'media', 'progress', 'methods'];

let dbPromise = null;

/* ------------------------------------------------------------------------ */
/* Connection                                                               */
/* ------------------------------------------------------------------------ */

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const has = (name) => db.objectStoreNames.contains(name);
    if (!has('folders')) db.createObjectStore('folders', { keyPath: 'id' }).createIndex('parentId', 'parentId');
    if (!has('cards')) db.createObjectStore('cards', { keyPath: 'id' }).createIndex('folderId', 'folderId');
    if (!has('media')) db.createObjectStore('media', { keyPath: 'id' });
    if (!has('methods')) db.createObjectStore('methods', { keyPath: 'id' });
    if (!has('progress')) {
      const progress = db.createObjectStore('progress', { keyPath: 'id' });
      progress.createIndex('methodId', 'methodId');
      progress.createIndex('cardId', 'cardId');
    }
    if (!has('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  }
}

/** Open (once) the database. The connection is cached; it is dropped when another tab upgrades it. */
export async function openDB() {
  if (dbPromise) return dbPromise;
  const promise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('Stockage indisponible : ce navigateur ne permet pas d’enregistrer les données (navigation privée ?).'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        if (dbPromise === promise) dbPromise = null;
      };
      // Another tab wants a newer version: release our connection so it is not blocked.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // Unexpected close (storage cleared by the user / browser): reopen on next use.
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Impossible d’ouvrir la base de données.'));
    // 'blocked': an older connection in another tab has not closed yet. It closes itself on
    // 'versionchange', after which this request proceeds; nothing to do here.
    request.onblocked = () => {};
  });
  dbPromise = promise;
  promise.catch(() => {
    if (dbPromise === promise) dbPromise = null; // allow a retry later
  });
  return promise;
}

/* ------------------------------------------------------------------------ */
/* Request / transaction helpers                                            */
/* ------------------------------------------------------------------------ */

/** Promise for a single IDBRequest. */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Promise resolved when the transaction commits, rejected when it aborts. */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction annulée', 'AbortError'));
  });
}

async function newTransaction(storeNames, mode) {
  const db = await openDB();
  try {
    return db.transaction(storeNames, mode);
  } catch (err) {
    // The cached connection was closed (versionchange / storage cleared): reopen once.
    if (err && err.name === 'InvalidStateError') {
      dbPromise = null;
      return (await openDB()).transaction(storeNames, mode);
    }
    throw err;
  }
}

/**
 * Run `fn(tx)` inside a transaction and resolve with its result once the transaction completes.
 * `fn` must only await IndexedDB requests. If it throws, the transaction is aborted.
 */
async function withTx(storeNames, mode, fn) {
  const tx = await newTransaction(storeNames, mode);
  const done = txDone(tx);
  let result;
  try {
    result = await fn(tx);
  } catch (err) {
    done.catch(() => {});
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    throw err;
  }
  await done;
  return result;
}

function getAll(storeName) {
  return withTx([storeName], 'readonly', (tx) => req(tx.objectStore(storeName).getAll()));
}

async function getOne(storeName, key) {
  if (key == null) return null;
  const value = await withTx([storeName], 'readonly', (tx) => req(tx.objectStore(storeName).get(key)));
  return value ?? null;
}

/* ------------------------------------------------------------------------ */
/* Data helpers                                                             */
/* ------------------------------------------------------------------------ */

function orderOf(item) {
  return Number.isFinite(item.order) ? item.order : 0;
}

function byOrder(a, b) {
  return orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0);
}

/** Order for a new item placed after `siblings`. */
function nextOrder(siblings) {
  let max = -1;
  for (const s of siblings) if (Number.isFinite(s.order) && s.order > max) max = s.order;
  return max + 1;
}

function cleanName(name, what) {
  const s = String(name ?? '').trim();
  if (!s) throw new Error(`Le nom ${what} ne peut pas être vide.`);
  return s;
}

function mediaRef(v) {
  return typeof v === 'string' && v ? v : null;
}

/** Normalise anything face-like ({text, imageId, audioId} or a string) into a Face. */
function normalizeFace(face) {
  const f = typeof face === 'string' ? { text: face } : face && typeof face === 'object' ? face : {};
  return {
    text: f.text == null ? '' : String(f.text),
    imageId: mediaRef(f.imageId),
    audioId: mediaRef(f.audioId),
  };
}

/** Face written by the app: normalised, text trimmed. */
function cleanFace(face) {
  const f = normalizeFace(face);
  f.text = f.text.trim();
  return f;
}

function mediaIdsOf(card) {
  return [card.front?.imageId, card.front?.audioId, card.back?.imageId, card.back?.audioId].filter(
    (id) => typeof id === 'string' && id,
  );
}

function isArrayBuffer(v) {
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

/** Blob / File / ArrayBuffer / typed array → ArrayBuffer (never called inside a transaction). */
async function toArrayBuffer(data) {
  if (isArrayBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer();
  if (typeof Blob !== 'undefined' && data instanceof Blob && typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(data);
    });
  }
  throw new Error('Format de média non pris en charge.');
}

/* ---- cascade helpers (run inside an open readwrite transaction) ---- */

/** Delete cards with their media and progress records. */
async function removeCardsInTx(tx, cards) {
  const cardStore = tx.objectStore('cards');
  const mediaStore = tx.objectStore('media');
  const progressIndex = tx.objectStore('progress').index('cardId');
  const progressStore = tx.objectStore('progress');
  for (const card of cards) {
    cardStore.delete(card.id);
    for (const id of mediaIdsOf(card)) mediaStore.delete(id);
  }
  const keyLists = await Promise.all(cards.map((c) => req(progressIndex.getAllKeys(c.id))));
  for (const keys of keyLists) for (const key of keys) progressStore.delete(key);
}

/** Remove rule keys (f:<id> / c:<id>) from every method. */
async function removeRuleKeysInTx(tx, ruleKeys) {
  if (!ruleKeys.length) return;
  const store = tx.objectStore('methods');
  const methods = await req(store.getAll());
  const now = Date.now();
  for (const method of methods) {
    const rules = method.rules || {};
    let changed = false;
    const next = { ...rules };
    for (const key of ruleKeys) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) store.put({ ...method, rules: next, updatedAt: now });
  }
}

/* ------------------------------------------------------------------------ */
/* Folders                                                                  */
/* ------------------------------------------------------------------------ */

export async function getFolders() {
  return getAll('folders');
}

export async function getFolder(id) {
  return getOne('folders', id);
}

export async function createFolder({ name, parentId = null } = {}) {
  const cleaned = cleanName(name, 'du dossier');
  const parent = parentId ?? null;
  return withTx(['folders'], 'readwrite', async (tx) => {
    const store = tx.objectStore('folders');
    let siblings;
    if (parent === null) {
      siblings = (await req(store.getAll())).filter((f) => (f.parentId ?? null) === null);
    } else {
      if (!(await req(store.get(parent)))) throw new Error('Le dossier parent est introuvable.');
      siblings = await req(store.index('parentId').getAll(parent));
    }
    const folder = { id: uid(), parentId: parent, name: cleaned, order: nextOrder(siblings), createdAt: Date.now() };
    store.add(folder);
    return folder;
  });
}

/** patch ⊆ {name, parentId, order}. Moving a folder places it at the end of its new parent. */
export async function updateFolder(id, patch = {}) {
  return withTx(['folders'], 'readwrite', async (tx) => {
    const store = tx.objectStore('folders');
    const folder = await req(store.get(id));
    if (!folder) throw new Error('Dossier introuvable.');
    const next = { ...folder, parentId: folder.parentId ?? null };

    if ('name' in patch) next.name = cleanName(patch.name, 'du dossier');

    if ('parentId' in patch && (patch.parentId ?? null) !== next.parentId) {
      const parentId = patch.parentId ?? null;
      const all = await req(store.getAll());
      if (parentId !== null) {
        const byId = new Map(all.map((f) => [f.id, f]));
        if (!byId.has(parentId)) throw new Error('Le dossier de destination est introuvable.');
        // The new parent must not be the folder itself or one of its descendants.
        const seen = new Set();
        for (let cur = parentId; cur != null && !seen.has(cur); cur = byId.get(cur)?.parentId ?? null) {
          if (cur === id) throw new Error('Impossible de déplacer un dossier dans lui-même ou dans un de ses sous-dossiers.');
          seen.add(cur);
        }
      }
      next.parentId = parentId;
      if (!('order' in patch)) {
        next.order = nextOrder(all.filter((f) => f.id !== id && (f.parentId ?? null) === parentId));
      }
    }

    if ('order' in patch) {
      if (!Number.isFinite(patch.order)) throw new Error('Ordre invalide.');
      next.order = patch.order;
    }

    store.put(next);
    return next;
  });
}

/** Delete a folder and its whole subtree (cards, media, progress, rule keys). → { folders, cards } */
export async function deleteFolder(id) {
  return withTx(CARD_CASCADE_STORES, 'readwrite', async (tx) => {
    const folderStore = tx.objectStore('folders');
    const all = await req(folderStore.getAll());
    if (!all.some((f) => f.id === id)) return { folders: 0, cards: 0 };

    // Collect the subtree.
    const childrenOf = new Map();
    for (const f of all) {
      const key = f.parentId ?? null;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(f.id);
    }
    const folderIds = [];
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const fid = stack.pop();
      if (seen.has(fid)) continue;
      seen.add(fid);
      folderIds.push(fid);
      stack.push(...(childrenOf.get(fid) || []));
    }

    const cardIndex = tx.objectStore('cards').index('folderId');
    const cards = (await Promise.all(folderIds.map((fid) => req(cardIndex.getAll(fid))))).flat();

    await removeCardsInTx(tx, cards);
    for (const fid of folderIds) folderStore.delete(fid);
    await removeRuleKeysInTx(tx, [...folderIds.map((fid) => `f:${fid}`), ...cards.map((c) => `c:${c.id}`)]);
    return { folders: folderIds.length, cards: cards.length };
  });
}

/* ------------------------------------------------------------------------ */
/* Cards                                                                    */
/* ------------------------------------------------------------------------ */

export async function getCards() {
  return getAll('cards');
}

export async function getCardsInFolder(folderId) {
  if (folderId == null) return [];
  const cards = await withTx(['cards'], 'readonly', (tx) => req(tx.objectStore('cards').index('folderId').getAll(folderId)));
  return cards.sort(byOrder);
}

export async function getCard(id) {
  return getOne('cards', id);
}

export async function createCard({ folderId, front, back } = {}) {
  if (folderId == null) throw new Error('Une carte doit être rangée dans un dossier.');
  return withTx(['folders', 'cards'], 'readwrite', async (tx) => {
    if (!(await req(tx.objectStore('folders').get(folderId)))) throw new Error('Dossier introuvable.');
    const store = tx.objectStore('cards');
    const siblings = await req(store.index('folderId').getAll(folderId));
    const now = Date.now();
    const card = {
      id: uid(),
      folderId,
      front: cleanFace(front),
      back: cleanFace(back),
      order: nextOrder(siblings),
      createdAt: now,
      updatedAt: now,
    };
    store.add(card);
    return card;
  });
}

/**
 * patch ⊆ {folderId, front, back, order}. Faces are merged into the current ones
 * (so { front: { text } } keeps the image). Moving to another folder ⇒ order = end of that folder.
 */
export async function updateCard(id, patch = {}) {
  return withTx(['folders', 'cards'], 'readwrite', async (tx) => {
    const store = tx.objectStore('cards');
    const card = await req(store.get(id));
    if (!card) throw new Error('Carte introuvable.');
    const next = { ...card, updatedAt: Date.now() };

    for (const side of ['front', 'back']) {
      if (side in patch) {
        const p = patch[side];
        const partial = typeof p === 'string' ? { text: p } : p && typeof p === 'object' ? p : {};
        next[side] = cleanFace({ ...normalizeFace(card[side]), ...partial });
      }
    }

    if ('folderId' in patch && patch.folderId !== card.folderId) {
      if (patch.folderId == null) throw new Error('Une carte doit être rangée dans un dossier.');
      if (!(await req(tx.objectStore('folders').get(patch.folderId)))) throw new Error('Dossier introuvable.');
      next.folderId = patch.folderId;
      if (!('order' in patch)) next.order = nextOrder(await req(store.index('folderId').getAll(patch.folderId)));
    }

    if ('order' in patch) {
      if (!Number.isFinite(patch.order)) throw new Error('Ordre invalide.');
      next.order = patch.order;
    }

    store.put(next);
    return next;
  });
}

/** Delete a card with its media, progress records and rule keys. → { cards } */
export async function deleteCard(id) {
  return withTx(CARD_CASCADE_STORES, 'readwrite', async (tx) => {
    const card = await req(tx.objectStore('cards').get(id));
    if (!card) return { cards: 0 };
    await removeCardsInTx(tx, [card]);
    await removeRuleKeysInTx(tx, [`c:${id}`]);
    return { cards: 1 };
  });
}

/* ------------------------------------------------------------------------ */
/* Media                                                                    */
/* ------------------------------------------------------------------------ */

/** Store a Blob (as ArrayBuffer + MIME type, for Safari robustness). → mediaId */
export async function putMedia(blob) {
  if (!blob) throw new Error('Aucun fichier à enregistrer.');
  const data = await toArrayBuffer(blob); // before opening the transaction
  const record = {
    id: uid(),
    type: (typeof blob.type === 'string' && blob.type) || 'application/octet-stream',
    data,
    size: data.byteLength,
    createdAt: Date.now(),
  };
  await withTx(['media'], 'readwrite', (tx) => {
    tx.objectStore('media').add(record);
  });
  return record.id;
}

/** → Blob | null */
export async function getMedia(id) {
  const record = await getOne('media', id);
  if (!record) return null;
  if (typeof Blob !== 'undefined' && record.data instanceof Blob) return record.data;
  return new Blob([record.data], { type: record.type || '' });
}

export async function deleteMedia(id) {
  if (id == null) return;
  await withTx(['media'], 'readwrite', (tx) => {
    tx.objectStore('media').delete(id);
  });
}

/* ------------------------------------------------------------------------ */
/* Methods                                                                  */
/* ------------------------------------------------------------------------ */

const METHOD_FIELDS = ['name', 'rules', 'newPerDay', 'shuffleNew', 'direction', 'newToday'];

export async function getMethods() {
  const methods = await getAll('methods');
  return methods.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function getMethod(id) {
  return getOne('methods', id);
}

export async function createMethod({ name } = {}) {
  const now = Date.now();
  const method = {
    id: uid(),
    name: cleanName(name, 'de la méthode'),
    rules: {},
    newPerDay: 20,
    shuffleNew: false,
    direction: 'front',
    newToday: { day: '', count: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await withTx(['methods'], 'readwrite', (tx) => {
    tx.objectStore('methods').add(method);
  });
  return method;
}

/** patch ⊆ {name, rules, newPerDay, shuffleNew, direction, newToday} → Method (updatedAt = now) */
export async function updateMethod(id, patch = {}) {
  return withTx(['methods'], 'readwrite', async (tx) => {
    const store = tx.objectStore('methods');
    const method = await req(store.get(id));
    if (!method) throw new Error('Méthode introuvable.');
    const next = { ...method };
    for (const field of METHOD_FIELDS) if (field in patch) next[field] = patch[field];
    if ('name' in patch) next.name = cleanName(patch.name, 'de la méthode');
    next.updatedAt = Date.now();
    store.put(next);
    return next;
  });
}

/** Delete a method and all its progress records. */
export async function deleteMethod(id) {
  await withTx(['methods', 'progress'], 'readwrite', async (tx) => {
    tx.objectStore('methods').delete(id);
    const store = tx.objectStore('progress');
    const keys = await req(store.index('methodId').getAllKeys(id));
    for (const key of keys) store.delete(key);
  });
}

/* ------------------------------------------------------------------------ */
/* Progress                                                                 */
/* ------------------------------------------------------------------------ */

function progressId(methodId, cardId) {
  return `${methodId}|${cardId}`;
}

export async function getProgressForMethod(methodId) {
  if (methodId == null) return [];
  return withTx(['progress'], 'readonly', (tx) => req(tx.objectStore('progress').index('methodId').getAll(methodId)));
}

export async function getProgress(methodId, cardId) {
  return getOne('progress', progressId(methodId, cardId));
}

/** Upsert a progress record (id computed when missing). → Progress */
export async function putProgress(p) {
  if (!p || p.methodId == null || p.cardId == null) throw new Error('Progression invalide.');
  const record = { ...p, id: p.id || progressId(p.methodId, p.cardId) };
  await withTx(['progress'], 'readwrite', (tx) => {
    tx.objectStore('progress').put(record);
  });
  return record;
}

export async function deleteProgress(methodId, cardId) {
  await withTx(['progress'], 'readwrite', (tx) => {
    tx.objectStore('progress').delete(progressId(methodId, cardId));
  });
}

/** Forget everything learnt in a method (progress + today's new-card counter). → Method|null */
export async function resetMethodProgress(methodId) {
  return withTx(['methods', 'progress'], 'readwrite', async (tx) => {
    const progress = tx.objectStore('progress');
    const keys = await req(progress.index('methodId').getAllKeys(methodId));
    for (const key of keys) progress.delete(key);
    const store = tx.objectStore('methods');
    const method = await req(store.get(methodId));
    if (!method) return null;
    const next = { ...method, newToday: { day: '', count: 0 }, updatedAt: Date.now() };
    store.put(next);
    return next;
  });
}

/* ------------------------------------------------------------------------ */
/* Meta                                                                     */
/* ------------------------------------------------------------------------ */

export async function getMeta(key, fallback = null) {
  const record = await getOne('meta', key);
  return record ? record.value : fallback;
}

export async function setMeta(key, value) {
  await withTx(['meta'], 'readwrite', (tx) => {
    tx.objectStore('meta').put({ key, value });
  });
}

/* ------------------------------------------------------------------------ */
/* Import                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Apply a plan from importer.planImport in one transaction (folders + cards).
 * Every imported card records the texts it came from (`card.imported = { front, back }`): a later
 * import only replaces a verso that still equals its imported text, never one corrected in the app.
 * → { foldersCreated, cardsCreated, cardsUpdated, cardsKept }
 */
export async function applyImportPlan(plan) {
  if (!plan || !Array.isArray(plan.newFolders) || !Array.isArray(plan.newCards) || !Array.isArray(plan.updatedCards)) {
    throw new Error('Plan d’import invalide.');
  }
  const idOf = new Map(plan.newFolders.map((f) => [f.tempId, uid()]));
  const resolve = (ref) => (ref == null ? null : idOf.get(ref) ?? ref);

  // Existing folders referenced by the plan: they must still exist when applying.
  const existingRefs = new Set();
  for (const f of plan.newFolders) if (f.parentRef != null && !idOf.has(f.parentRef)) existingRefs.add(f.parentRef);
  for (const c of plan.newCards) {
    if (c.folderRef == null) throw new Error('Plan d’import invalide : carte sans dossier.');
    if (!idOf.has(c.folderRef)) existingRefs.add(c.folderRef);
  }

  const now = Date.now();
  return withTx(['folders', 'cards'], 'readwrite', async (tx) => {
    const folderStore = tx.objectStore('folders');
    const cardStore = tx.objectStore('cards');

    const found = await Promise.all([...existingRefs].map((id) => req(folderStore.get(id))));
    if (found.some((f) => !f)) {
      throw new Error('Un dossier de destination n’existe plus. Relance l’analyse avant d’importer.');
    }

    for (const f of plan.newFolders) {
      folderStore.add({
        id: idOf.get(f.tempId),
        parentId: resolve(f.parentRef),
        name: String(f.name),
        order: Number.isFinite(f.order) ? f.order : 0,
        createdAt: now,
      });
    }
    for (const c of plan.newCards) {
      const front = cleanFace(c.front);
      const back = cleanFace(c.back);
      cardStore.add({
        id: uid(),
        folderId: resolve(c.folderRef),
        front,
        back,
        order: Number.isFinite(c.order) ? c.order : 0,
        createdAt: now,
        updatedAt: now,
        imported: { front: front.text, back: back.text },
      });
    }

    const current = await Promise.all(plan.updatedCards.map((u) => req(cardStore.get(u.id))));
    let cardsUpdated = 0;
    let cardsKept = Array.isArray(plan.keptCards) ? plan.keptCards.length : 0;
    current.forEach((card, i) => {
      if (!card) return; // deleted meanwhile
      // Last line of defence: never overwrite a verso the user typed (edited since the analysis,
      // or a card created in the app).
      const imp = card.imported;
      const untouched = imp && typeof imp.back === 'string' && String(card.back?.text ?? '').trim() === imp.back.trim();
      if (!untouched) {
        cardsKept++;
        return;
      }
      const text = String(plan.updatedCards[i].back ?? '').trim();
      const back = { ...normalizeFace(card.back), text };
      const front = typeof imp.front === 'string' ? imp.front : String(card.front?.text ?? '');
      cardStore.put({ ...card, back, updatedAt: now, imported: { front, back: text } });
      cardsUpdated++;
    });

    return { foldersCreated: plan.newFolders.length, cardsCreated: plan.newCards.length, cardsUpdated, cardsKept };
  });
}

/* ------------------------------------------------------------------------ */
/* Backup                                                                   */
/* ------------------------------------------------------------------------ */
//
// A backup is one JSON object (format v1, spec §7). Media can weigh hundreds of MB, so the file is
// never built or read as one big string: exportBackupFile writes ONE MEDIA PER LINE and the restore
// reads the file line by line. The layout stays plain JSON, readable by JSON.parse:
//
//   {"app":"recto","kind":"backup",…,"meta":[…],"media":[      ← line 1: everything but the media
//   {"id":"…","type":"image/jpeg","size":…,"createdAt":…,"data":"<base64>"},
//   {"id":"…",…}
//   ]}
//
// (A raw line break never occurs inside JSON.stringify output, nor inside a UTF-8 multi-byte sequence.)

const BACKUP_CHUNK = 4 * 1024 * 1024;
const MEDIA_OPEN = '"media":[';

function backupHead(small) {
  return {
    app: 'recto',
    kind: 'backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: small.folders,
    cards: small.cards,
    methods: small.methods,
    progress: small.progress,
    meta: small.meta,
  };
}

/** Media store record → backup entry (base64). */
async function mediaEntry(m) {
  const buffer = await toArrayBuffer(m.data);
  return { id: m.id, type: m.type || '', size: buffer.byteLength, createdAt: m.createdAt ?? 0, data: arrayBufferToBase64(buffer) };
}

/** Backup entry → media store record (validated, base64 decoded). */
function mediaRecord(m) {
  if (!hasStringId(m) || typeof m.data !== 'string') throw invalidBackup('média incomplet.');
  let data;
  try {
    data = base64ToArrayBuffer(m.data);
  } catch {
    throw invalidBackup('média illisible.');
  }
  return {
    id: m.id,
    type: typeof m.type === 'string' ? m.type : '',
    data,
    size: data.byteLength,
    createdAt: Number.isFinite(m.createdAt) ? m.createdAt : 0,
  };
}

/** Whole database as a JSON-serialisable object (media as base64). Small databases / tests only. */
export async function exportBackup() {
  const data = await withTx(STORES, 'readonly', async (tx) => {
    const lists = await Promise.all(STORES.map((name) => req(tx.objectStore(name).getAll())));
    return Object.fromEntries(STORES.map((name, i) => [name, lists[i]]));
  });
  // Encoding happens after the transaction (it may need async Blob reads for legacy records).
  const media = [];
  for (const m of data.media) media.push(await mediaEntry(m));
  return { ...backupHead(data), media };
}

/**
 * Assemble a backup File from the small stores and an (async) iterable of media records, holding
 * at most one media in memory at a time: each one becomes its own Blob part.
 */
export async function buildBackupFile(name, small, mediaRecords) {
  const head = JSON.stringify(backupHead(small));
  const parts = [`${head.slice(0, -1)},${MEDIA_OPEN}`];
  let sep = '\n';
  for await (const m of mediaRecords) {
    if (!m) continue; // deleted meanwhile
    parts.push(new Blob([sep + JSON.stringify(await mediaEntry(m))]));
    sep = ',\n';
  }
  parts.push('\n]}');
  return new File(parts, name, { type: 'application/json' });
}

/** Whole database as a backup File (see the layout above). */
export async function exportBackupFile(name) {
  const names = STORES.filter((n) => n !== 'media');
  const { small, mediaKeys } = await withTx(STORES, 'readonly', async (tx) => {
    const lists = await Promise.all(names.map((n) => req(tx.objectStore(n).getAll())));
    const keys = await req(tx.objectStore('media').getAllKeys());
    return { small: Object.fromEntries(names.map((n, i) => [n, lists[i]])), mediaKeys: keys };
  });
  async function* records() {
    for (const id of mediaKeys) yield await getOne('media', id); // one record in memory at a time
  }
  return buildBackupFile(name, small, records());
}

function invalidBackup(detail) {
  return new Error(`Sauvegarde invalide : ${detail}`);
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasStringId(v) {
  return isRecord(v) && typeof v.id === 'string' && v.id !== '';
}

/** Validate a backup object and convert it to store records (throws a French error). */
function prepareBackup(obj) {
  if (!isRecord(obj) || obj.app !== 'recto' || obj.kind !== 'backup') {
    throw invalidBackup('ce fichier n’est pas une sauvegarde de Recto.');
  }
  if (obj.version !== 1) throw invalidBackup(`version ${obj.version} non prise en charge.`);
  for (const name of STORES) {
    if (!Array.isArray(obj[name])) throw invalidBackup(`la liste « ${name} » est absente.`);
  }
  if (!obj.folders.every(hasStringId)) throw invalidBackup('dossier sans identifiant.');
  if (!obj.cards.every((c) => hasStringId(c) && typeof c.folderId === 'string')) throw invalidBackup('carte incomplète.');
  if (!obj.methods.every(hasStringId)) throw invalidBackup('méthode sans identifiant.');
  if (!obj.progress.every((p) => isRecord(p) && p.methodId != null && p.cardId != null && (p.id == null || typeof p.id === 'string'))) {
    throw invalidBackup('progression incomplète.');
  }
  if (!obj.meta.every((m) => isRecord(m) && typeof m.key === 'string')) throw invalidBackup('réglage sans clé.');
  if (!obj.media.every((m) => hasStringId(m) && typeof m.data === 'string')) throw invalidBackup('média incomplet.');

  return {
    folders: obj.folders.map((f) => ({ ...f, parentId: f.parentId ?? null })),
    cards: obj.cards.map((c) => ({ ...c, front: normalizeFace(c.front), back: normalizeFace(c.back) })),
    methods: obj.methods,
    progress: obj.progress.map((p) => ({ ...p, id: p.id || progressId(p.methodId, p.cardId) })),
    meta: obj.meta,
    media: obj.media.map(mediaRecord),
  };
}

/**
 * Lines of `file` from byte `start`, as { text, end } (end = byte offset just after the line break).
 * Reads `chunkSize` bytes at a time; a line may span several chunks.
 */
async function* fileLines(file, start, chunkSize) {
  const decoder = new TextDecoder();
  const decode = (pieces) => {
    if (pieces.length === 1) return decoder.decode(pieces[0]);
    const all = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) {
      all.set(p, at);
      at += p.length;
    }
    return decoder.decode(all);
  };
  let pieces = [];
  let pos = start;
  while (pos < file.size) {
    const bytes = new Uint8Array(await file.slice(pos, pos + chunkSize).arrayBuffer());
    if (!bytes.length) break;
    let from = 0;
    for (let nl = bytes.indexOf(10); nl !== -1; nl = bytes.indexOf(10, from)) {
      pieces.push(bytes.subarray(from, nl));
      yield { text: decode(pieces), end: pos + nl + 1 };
      pieces = [];
      from = nl + 1;
    }
    if (from < bytes.length) pieces.push(bytes.subarray(from));
    pos += bytes.length;
  }
  if (pieces.length) yield { text: decode(pieces), end: pos };
}

/** True when the file ends like exportBackupFile's layout ("\n]}"), checked without reading it all. */
async function hasLineLayout(file) {
  if (!file || typeof file.slice !== 'function' || !(file.size > 0)) return false;
  const tail = await file.slice(Math.max(0, file.size - 32)).text();
  return /\n\]\}\s*$/.test(tail);
}

/** Media lines of a line-layout backup, from byte `start` up to the closing "]}". */
async function readMediaLines(file, start, chunkSize) {
  const media = [];
  let closed = false;
  for await (const { text } of fileLines(file, start, chunkSize)) {
    const line = text.trim();
    if (!line) continue;
    if (closed) throw invalidBackup('contenu inattendu après la fin du fichier.');
    if (line === ']}') {
      closed = true;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line);
    } catch {
      throw invalidBackup('média illisible.');
    }
    media.push(mediaRecord(entry)); // only the decoded ArrayBuffer is kept, not the base64 text
  }
  if (!closed) throw invalidBackup('fichier incomplet (coupé pendant la copie ?).');
  return media;
}

/**
 * Open a backup file without restoring it. → { head, read(), restore() }
 *  - head: the backup object without its media (for the confirmation: date, counts). It may be any
 *    JSON value: check head.app / head.kind before going further.
 *  - read(): validated store records (media decoded), ready to be written. Pure, no database.
 *  - restore(): read() then REPLACE everything with it in one transaction.
 * Backups made by exportBackupFile are read line by line, one media at a time; any other JSON
 * (older single-line backups) is parsed in one go. Throws a French error when it is not JSON.
 */
export async function openBackupFile(file, { chunkSize = BACKUP_CHUNK } = {}) {
  let backup = null;
  if (await hasLineLayout(file)) {
    let first = null;
    for await (const line of fileLines(file, 0, chunkSize)) {
      first = line;
      break;
    }
    const headText = first ? first.text.replace(/^\uFEFF/, '').trimEnd() : '';
    if (headText.endsWith(MEDIA_OPEN)) {
      let head = null;
      try {
        head = JSON.parse(`${headText}]}`);
      } catch {
        /* not our layout after all: parsed in one go below */
      }
      if (isRecord(head)) {
        delete head.media;
        backup = {
          head,
          read: async () => {
            const records = prepareBackup({ ...head, media: [] }); // validates the head before reading media
            records.media = await readMediaLines(file, first.end, chunkSize);
            return records;
          },
        };
      }
    }
  }
  if (!backup) {
    let obj;
    try {
      obj = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    } catch {
      throw invalidBackup('ce fichier n’est pas un JSON valide.');
    }
    backup = { head: obj, read: async () => prepareBackup(obj) };
  }
  backup.restore = async () => writeBackup(await backup.read());
  return backup;
}

/** Restore a backup File (see openBackupFile). → counts per store */
export async function restoreBackupFile(file, options) {
  return (await openBackupFile(file, options)).restore();
}

function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}

/** REPLACE all data with validated records, in one transaction (all-or-nothing). → counts per store */
async function writeBackup(records) {
  try {
    await withTx(STORES, 'readwrite', (tx) => {
      for (const name of STORES) {
        const store = tx.objectStore(name);
        store.clear();
        for (const record of records[name]) store.put(record);
      }
    });
  } catch (err) {
    // The transaction was rolled back: the previous data is intact.
    if (isQuotaError(err)) {
      throw new Error(
        'Restauration impossible, aucune donnée modifiée : plus assez d’espace de stockage sur ce téléphone (pendant la restauration, l’ancien et le nouveau contenu occupent la place en même temps). Libère de la place puis réessaie.',
      );
    }
    const why = err && err.name === 'UnknownError' ? 'erreur du stockage du navigateur, le téléphone manque peut-être d’espace' : (err && (err.message || err.name)) || err;
    throw new Error(`Restauration impossible, aucune donnée modifiée (${why}).`);
  }
  return Object.fromEntries(STORES.map((name) => [name, records[name].length]));
}

/**
 * Validate a backup (object or JSON string), then REPLACE all data with it in one transaction
 * (all-or-nothing). → counts per store
 */
export async function restoreBackup(obj) {
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj.replace(/^\uFEFF/, ''));
    } catch {
      throw invalidBackup('ce fichier n’est pas un JSON valide.');
    }
  }
  return writeBackup(prepareBackup(obj)); // validation + base64 decoding happen before the transaction
}

/** Delete every record of every store. */
export async function clearAll() {
  await withTx(STORES, 'readwrite', (tx) => {
    for (const name of STORES) tx.objectStore(name).clear();
  });
}

/* ------------------------------------------------------------------------ */
/* Storage                                                                  */
/* ------------------------------------------------------------------------ */

function storageManager() {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

/** → { usage, quota, persisted } (null when unknown) */
export async function storageInfo() {
  const info = { usage: null, quota: null, persisted: null };
  const storage = storageManager();
  if (!storage) return info;
  try {
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      info.usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
      info.quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
    }
  } catch {
    /* unsupported */
  }
  try {
    if (typeof storage.persisted === 'function') info.persisted = Boolean(await storage.persisted());
  } catch {
    /* unsupported */
  }
  return info;
}

/** Ask the browser not to evict our data. → true when storage is (now) persistent. */
export async function requestPersistence() {
  const storage = storageManager();
  if (!storage) return false;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    if (typeof storage.persist === 'function') return Boolean(await storage.persist());
  } catch {
    /* unsupported / denied */
  }
  return false;
}
