#!/usr/bin/env node
// End-to-end test of Recto: a real user's journey on a phone-sized Chromium (Playwright).
//
//   node tests/e2e/run.mjs                 # run every flow, exit code 1 on the first failure
//   node tests/e2e/run.mjs --shots=<dir>   # also save the reference screenshots in <dir>
//   node tests/e2e/run.mjs --headed        # watch it run
//
// The script starts its own static server for ./app on a free port. Playwright is not a project
// dependency: it is resolved from the machine (global install / NODE_PATH). Any console error,
// page error or « Erreur : … » toast fails the run. Simulated days: an init script shifts Date by
// N days (N read from localStorage['__e2eDayOffset']); everything else is the real app.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';
import { FORMAT_EXAMPLE, buildAIPrompt } from '../../app/js/format.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright est introuvable (npm i -g playwright && npx playwright install chromium).');
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const SHOTS_DIR = (args.find((a) => a.startsWith('--shots=')) || '').slice('--shots='.length) || null;
const OUT_DIR = join(ROOT, 'test-results', 'e2e');
mkdirSync(OUT_DIR, { recursive: true });
if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Tiny test harness                                                   */
/* ------------------------------------------------------------------ */

const results = [];
const problems = []; // console errors, page errors, error toasts
const toasts = []; // every toast shown (printed when a step fails)
let page; // current page (for failure screenshots)

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    if (problems.length) throw new Error(`erreurs dans la page :\n    ${problems.join('\n    ')}`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err });
    console.log(`  ✗ ${name}\n    ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n    ')}`);
    if (toasts.length) console.log(`    derniers toasts : ${toasts.slice(-4).join(' | ')}`);
    if (page) {
      const file = join(OUT_DIR, `echec-${results.length}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => {});
      console.log(`    capture : ${file}`);
    }
    throw err;
  }
}

async function waitFor(fn, { timeout = 8000, interval = 60, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`délai dépassé : ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function shot(name) {
  if (!SHOTS_DIR) return;
  // Let transitions finish and transient toasts disappear (they are not part of the screen).
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 6000 }).catch(() => {});
  await settle(450);
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

/** Let screen fade-ins and overlay transitions finish. */
async function settle(ms = 260) {
  await page.waitForTimeout(ms);
}

/* ------------------------------------------------------------------ */
/* App helpers                                                         */
/* ------------------------------------------------------------------ */

/** Call a db.js function inside the page (same module instance as the app). */
function db(fn, ...params) {
  return page.evaluate(
    async ([fn, params]) => {
      const mod = await import(new URL('./js/db.js', location.href).href);
      const res = await mod[fn](...params);
      return res === undefined ? null : JSON.parse(JSON.stringify(res));
    },
    [fn, params],
  );
}

function today() {
  return page.evaluate(async () => (await import(new URL('./js/util.js', location.href).href)).studyDay());
}
function addDays(day, n) {
  return page.evaluate(async ([day, n]) => (await import(new URL('./js/util.js', location.href).href)).addDays(day, n), [day, n]);
}

async function folderId(name) {
  const folders = await db('getFolders');
  const f = folders.find((x) => x.name === name);
  assert(f, `dossier « ${name} » introuvable`);
  return f.id;
}
async function cardByFront(front) {
  const cards = await db('getCards');
  const c = cards.find((x) => x.front.text === front);
  assert(c, `carte « ${front} » introuvable`);
  return c;
}

async function go(hash, readySelector) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  if (readySelector) await page.locator(readySelector).first().waitFor();
  await settle(200);
}

const dialog = (name) => (name ? page.getByRole('dialog', { name, exact: true }) : page.getByRole('dialog').last());
const btn = (name, scope = page) => scope.getByRole('button', { name, exact: true });

async function confirmIn(name, label) {
  const d = dialog(name);
  await d.waitFor();
  await btn(label, d).click();
  await d.waitFor({ state: 'detached' }).catch(() => {});
}

async function prompt(title, value, label) {
  const d = dialog(title);
  await d.waitFor();
  await d.getByRole('textbox').fill(value);
  await btn(label, d).click();
}

async function tab(name) {
  await page.locator(`.tabbar [data-tab="${name}"]`).click();
  await settle(250);
}

async function pickFileVia(trigger, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await chooser.setFiles(file);
}

/** Text of the card currently asked in the study screen. */
async function question() {
  const q = page.locator('.flashcard .fc-q .face-text');
  return (await q.first().innerText()).trim();
}

/** Tap « Afficher la réponse ». A tap within 300 ms of an answer counts as a double tap and is
 *  ignored by the app, so retry like a user would. */
async function showAnswer() {
  for (let i = 0; i < 4; i++) {
    await btn('Afficher la réponse').click();
    try {
      await page.locator('.flashcard.is-revealed').waitFor({ timeout: 450 });
      return;
    } catch {
      /* swallowed as a double tap: tap again */
    }
  }
  throw new Error('la réponse ne s’affiche pas');
}

async function revealAndAnswer(known, how = 'button') {
  if (how === 'keys') {
    await page.keyboard.press('Space');
    await page.locator('.flashcard.is-revealed').waitFor();
    await page.keyboard.press(known ? 'ArrowRight' : '1');
    return;
  }
  await showAnswer();
  await btn(known ? 'Je sais' : 'Je ne sais pas').click();
}

async function remaining() {
  const t = (await page.locator('.study-counter').innerText()).trim();
  const m = /(\d+)/.exec(t);
  return m ? Number(m[1]) : 0;
}

/** Answer « je sais » until the end screen shows; returns the fronts seen. */
async function finishSession(how = 'keys') {
  const seen = [];
  for (let i = 0; i < 400; i++) {
    if (await page.locator('.end').count()) return seen;
    const before = await question();
    seen.push(before);
    await revealAndAnswer(true, how);
    await waitFor(async () => (await page.locator('.end').count()) > 0 || (await page.locator('.flashcard:not(.is-revealed)').count()) > 0, {
      message: 'carte suivante',
    });
  }
  throw new Error('session interminable');
}

/** Real touch swipe (CDP) on the revealed card. ratio > 0 = right. */
async function touchSwipe(ratio) {
  const card = page.locator('.flashcard');
  const box = await card.boundingBox();
  const x0 = box.x + box.width / 2;
  const y0 = box.y + Math.min(box.height / 2, 200);
  const dx = box.width * ratio;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 12, y: y0 + i }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Progress of a card once the app's ordered write queue has stored it (`ready(p)` true). */
async function settledProgress(cardId, ready) {
  let last = null;
  try {
    return await waitFor(async () => {
      last = await db('getProgress', ctx.method, cardId);
      return ready(last) ? last || true : null;
    }, { timeout: 4000 });
  } catch {
    return last; // the eq() assertions that follow report the actual value
  }
}

async function progressSnapshot(methodId) {
  const list = await db('getProgressForMethod', methodId);
  return JSON.stringify(list.sort((a, b) => a.id.localeCompare(b.id)));
}

async function summaryCells() {
  const cells = await page.locator('.preview-card .sum-cell').evaluateAll((els) =>
    els.map((e) => [e.querySelector('.sum-label').textContent.trim(), Number(e.querySelector('.sum-value').textContent)]),
  );
  return Object.fromEntries(cells);
}

/** No horizontal scroll and nothing hidden under the tab bar on the current screen. */
async function checkLayout(label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const out = { overflowX: doc.scrollWidth - window.innerWidth, wide: [] };
    for (const el of document.querySelectorAll('#view *')) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.right > window.innerWidth + 1 || b.left < -1) && getComputedStyle(el).position !== 'fixed') {
        if (!el.closest('pre, .code-block, .flashcard.is-flying')) out.wide.push(`${el.tagName.toLowerCase()}.${el.className}`);
      }
    }
    window.scrollTo(0, doc.scrollHeight);
    const tabbar = document.getElementById('tabbar');
    const screen = document.querySelector('#view > .screen');
    const tb = tabbar && !tabbar.hidden ? tabbar.getBoundingClientRect().top : window.innerHeight;
    let lowest = 0;
    for (const el of screen ? screen.querySelectorAll('*') : []) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || el.closest('.fab')) continue;
      const b = el.getBoundingClientRect();
      if (b.height && b.width && cs.visibility !== 'hidden') lowest = Math.max(lowest, b.bottom);
    }
    out.hiddenUnderTabbar = lowest - tb;
    window.scrollTo(0, 0);
    return out;
  });
  assert(r.overflowX <= 0, `${label} : défilement horizontal (${r.overflowX}px)`);
  assert(!r.wide.length, `${label} : éléments qui dépassent : ${r.wide.slice(0, 5).join(', ')}`);
  assert(r.hiddenUnderTabbar <= 0, `${label} : contenu caché sous la barre d’onglets (${r.hiddenUnderTabbar}px)`);
}

/* ------------------------------------------------------------------ */
/* Test data                                                           */
/* ------------------------------------------------------------------ */

const CHAPTERS = ['Les bases', 'Le bilan', 'Le compte de résultat', 'Les amortissements', 'Les provisions', 'La trésorerie', 'Les ratios'];

function course({ chapters = 6, changed = false } = {}) {
  const dossiers = [];
  for (let c = 1; c <= chapters; c++) {
    const cartes = [];
    for (let i = 1; i <= 15; i++) {
      const n = `${c}.${String(i).padStart(2, '0')}`;
      let verso = `Définition ${n} : explication de la notion numéro ${i} du chapitre ${c}.`;
      if (changed && n === '2.05') verso = 'Définition 2.05 : nouvelle version enrichie.';
      cartes.push({ recto: `Notion ${n}`, verso });
    }
    const chapter = { nom: `Chapitre ${c} - ${CHAPTERS[c - 1]}`, cartes };
    if (c === 3) {
      chapter.dossiers = [
        {
          nom: 'Exercices 3',
          cartes: [1, 2, 3, 4, 5].map((i) => ({ recto: `Exercice 3.${i}`, verso: `Corrigé de l'exercice 3.${i}\nÉtape 1 puis étape 2.` })),
        },
      ];
    }
    dossiers.push(chapter);
  }
  return JSON.stringify({ dossiers: [{ nom: 'Gestion', dossiers }] }, null, 2);
}

function makeWav(seconds = 0.6, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

async function makePhoto() {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1200;
    const x = c.getContext('2d');
    x.fillStyle = '#f1f3f5';
    x.fillRect(0, 0, 1600, 1200);
    x.fillStyle = '#364fc7';
    x.fillRect(120, 120, 1360, 180);
    x.fillStyle = '#ffffff';
    x.font = 'bold 110px sans-serif';
    x.fillText('BILAN', 620, 250);
    x.fillStyle = '#495057';
    x.font = '64px sans-serif';
    ['Actif', 'Immobilisations', 'Stocks', 'Créances'].forEach((t, i) => x.fillText(t, 170, 450 + i * 150));
    ['Passif', 'Capitaux propres', 'Dettes', 'Provisions'].forEach((t, i) => x.fillText(t, 860, 450 + i * 150));
    x.strokeStyle = '#868e96';
    x.lineWidth = 8;
    x.beginPath();
    x.moveTo(800, 360);
    x.lineTo(800, 1080);
    x.stroke();
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const server = await startServer({ port: 0, host: '127.0.0.1', root: join(ROOT, 'app') });
const BASE = `http://127.0.0.1:${server.port}/`;
const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  acceptDownloads: true,
});
context.setDefaultTimeout(10000);
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
// Simulated days: shift Date by N days (N stored by the test in localStorage).
await context.addInitScript(() => {
  let days = 0;
  try {
    days = Number(localStorage.getItem('__e2eDayOffset')) || 0;
  } catch {
    /* opaque origin */
  }
  if (!days) return;
  const shift = days * 86400000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...a) {
      if (a.length) super(...a);
      else super(RealDate.now() + shift);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate;
});

function watch(p) {
  p.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') problems.push(`console.error: ${text}`);
    else if (msg.type() === 'warning' && text.startsWith('[recto]')) problems.push(`console.warn: ${text}`);
  });
  p.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
}
page = await context.newPage();
watch(page);
// Error toasts (« Erreur : … ») are reported by a MutationObserver.
await page.exposeFunction('__e2eToast', (text) => {
  toasts.push(text);
  // The journey never opens a missing item on purpose: « … introuvable » means a navigation bug.
  if (/^Erreur|introuvable/.test(text)) problems.push(`toast: ${text}`);
});
await context.addInitScript(() => {
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.classList && n.classList.contains('toast')) window.__e2eToast?.(n.textContent);
  }).observe(document, { childList: true, subtree: true });
});

const ctx = {}; // ids shared between flows
let failed = false;
const t0 = Date.now();
console.log(`Recto E2E — ${BASE}`);

try {
  /* ================================================================ */
  /* Données: format, AI prompt, imports                               */
  /* ================================================================ */
  await step('Démarrage : écran vide, aucune erreur', async () => {
    await page.goto(BASE);
    await page.getByText('Aucune méthode de révision').waitFor();
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.goto(`${BASE}#/route/inconnue`);
    await waitFor(() => new URL(page.url()).hash === '#/', { message: 'route inconnue → #/' });
    await page.getByText('Aucune méthode de révision').waitFor();
  });

  await step('Données : copier le format et le prompt IA', async () => {
    await tab('data');
    await page.getByRole('heading', { name: 'Importer des cartes (JSON)' }).waitFor();
    await shot('11-donnees');
    await btn('Copier le format').click();
    await page.locator('.toast', { hasText: 'Copié' }).waitFor();
    eq(await page.evaluate(() => navigator.clipboard.readText()), FORMAT_EXAMPLE, 'presse-papiers (format)');
    await btn('Copier le prompt pour une IA').click();
    await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())) === buildAIPrompt(), { message: 'prompt copié' });
    const code = await page.locator('pre.code-block').innerText();
    eq(code.trim(), FORMAT_EXAMPLE.trim(), 'exemple affiché');
  });

  await step('Données : JSON invalide → erreur en français avec ligne/colonne', async () => {
    await page.locator('#imp-text').fill('{\n  "dossiers": [\n    { "nom": "A" "cartes": [] }\n  ]\n}');
    await btn('Analyser').click();
    const err = page.locator('.import-preview .notice.is-error');
    await err.waitFor();
    const text = await err.innerText();
    assert(/JSON invalide \(ligne 3, colonne \d+\)/.test(text), `message d'erreur inattendu : ${text}`);
  });

  await step('Données : import de l’exemple (aperçu puis import)', async () => {
    await page.locator('#imp-text').fill(FORMAT_EXAMPLE);
    await btn('Analyser').click();
    await page.locator('.preview-card').waitFor();
    const s = await summaryCells();
    eq(s['dossiers créés'], 3, 'dossiers créés');
    eq(s['cartes nouvelles'], 3, 'cartes nouvelles');
    await btn('Importer').click();
    await page.locator('.notice.is-success').waitFor();
    eq(await page.getByRole('link', { name: 'Voir les cartes' }).getAttribute('href'), '#/cards', 'lien Voir les cartes');
    eq((await db('getCards')).length, 3, 'cartes en base');
  });

  await step('Données : réimport identique → tout inchangé', async () => {
    await page.locator('#imp-text').fill(FORMAT_EXAMPLE);
    await btn('Analyser').click();
    await page.locator('.preview-card').waitFor();
    const s = await summaryCells();
    eq(s['dossiers réutilisés'], 3, 'dossiers réutilisés');
    eq(s['inchangées'], 3, 'cartes inchangées');
    await page.getByText('Rien de nouveau').waitFor();
    assert(await btn('Importer').isDisabled(), 'Importer devrait être désactivé');
  });

  await step('Données : import d’un cours (6 chapitres × 15 cartes + sous-sous-dossier)', async () => {
    await page.locator('#imp-text').fill(course());
    await btn('Analyser').click();
    await page.locator('.preview-card').waitFor();
    const s = await summaryCells();
    eq(s['dossiers créés'], 8, 'dossiers créés');
    eq(s['cartes nouvelles'], 95, 'cartes nouvelles');
    await btn('Importer').click();
    await page.locator('.notice.is-success').waitFor();
    eq((await db('getCards')).length, 98, 'cartes en base');
    eq((await db('getFolders')).length, 11, 'dossiers en base');
  });

  await step('Données : réimport avec un chapitre de plus et un verso modifié', async () => {
    await page.locator('#imp-text').fill(course({ chapters: 7, changed: true }));
    await btn('Analyser').click();
    await page.locator('.preview-card').waitFor();
    const s = await summaryCells();
    eq(s['dossier créé'], 1, 'dossier créé');
    eq(s['dossiers réutilisés'], 8, 'dossiers réutilisés');
    eq(s['cartes nouvelles'], 15, 'cartes nouvelles');
    eq(s['mise à jour'], 1, 'mise à jour');
    eq(s['inchangées'], 94, 'inchangées');
    await btn('Importer').click();
    await page.locator('.notice.is-success').waitFor();
    eq((await cardByFront('Notion 2.05')).back.text, 'Définition 2.05 : nouvelle version enrichie.', 'verso mis à jour');
    eq((await db('getCards')).length, 113, 'cartes en base');
  });

  await step('Données : import dans un dossier choisi (depuis le dossier)', async () => {
    ctx.compta = await folderId('Comptabilité');
    await tab('cards');
    await page.getByRole('link', { name: /Comptabilité/ }).click();
    await page.getByRole('heading', { name: 'Comptabilité' }).waitFor();
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await btn('Importer du JSON ici', dialog()).click();
    await page.locator('#imp-dest').waitFor();
    await settle();
    eq(await page.locator('#imp-dest').inputValue(), ctx.compta, 'destination présélectionnée');
    await page.locator('#imp-text').fill('[{"recto": "Passif", "verso": "Ensemble des ressources : capitaux propres et dettes"}]');
    await btn('Analyser').click();
    await page.locator('.preview-card').waitFor();
    await btn('Importer').click();
    const link = page.getByRole('link', { name: 'Voir les cartes' });
    await link.waitFor();
    eq(await link.getAttribute('href'), `#/cards/${ctx.compta}`, 'lien vers la destination');
    const passif = await cardByFront('Passif');
    eq(passif.folderId, ctx.compta, 'carte importée dans Comptabilité');
    await link.click();
    await page.locator('.card-row', { hasText: 'Passif' }).waitFor();
  });

  /* ================================================================ */
  /* Cartes: navigation, search, editor, media, folders                */
  /* ================================================================ */
  await step('Cartes : navigation, fil d’Ariane, recherche', async () => {
    await go('#/cards', '.page-title');
    await shot('07-bibliotheque');
    await page.getByRole('link', { name: /Gestion/ }).click();
    await page.getByRole('heading', { name: 'Gestion' }).waitFor();
    await page.getByRole('link', { name: /Chapitre 3 - Le compte de résultat/ }).click();
    await page.getByRole('heading', { name: 'Chapitre 3 - Le compte de résultat' }).waitFor();
    await page.getByRole('link', { name: /Exercices 3/ }).click();
    await page.getByRole('heading', { name: 'Exercices 3' }).waitFor();
    const crumbs = await page.locator('.breadcrumb').innerText();
    assert(/Cartes\s*›\s*Gestion\s*›\s*Chapitre 3/.test(crumbs), `fil d’Ariane : ${crumbs}`);
    await page.locator('.breadcrumb').getByRole('link', { name: 'Gestion' }).click();
    await page.getByRole('heading', { name: 'Gestion' }).waitFor();
    await tab('cards');
    await tab('cards'); // tapping the active tab goes back to its root
    await page.locator('.search-input').waitFor();
    await page.locator('.search-input').fill('resultat net');
    const row = page.locator('.card-row', { hasText: 'Résultat net (formule)' });
    await row.waitFor();
    await row.click();
    await dialog('Éditeur de carte').waitFor();
    eq(await page.locator('#ed-front').inputValue(), 'Résultat net (formule)', 'recto dans l’éditeur');
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    await dialog('Éditeur de carte').waitFor({ state: 'detached' }).catch(() => {});
    await page.locator('.search-input').fill('');
    await settle(200);
  });

  await step('Cartes : modifier une carte, photo (Galerie + recadrage) et audio (fichier)', async () => {
    await go(`#/cards/${await folderId('Chapitre 1 - Les bases')}`, '.card-row');
    await shot('08-dossier');
    await page.locator('.card-row', { hasText: 'Notion 1.01' }).click();
    const editor = dialog('Éditeur de carte');
    await editor.waitFor();
    await page.locator('#ed-front').fill('Notion 1.01 : le patrimoine');
    // Photo on the verso via « Galerie », then crop by dragging a corner.
    const photo = await makePhoto();
    const verso = editor.locator('.editor-face').nth(1);
    await pickFileVia(() => btn('Galerie', verso).click(), { name: 'bilan.png', mimeType: 'image/png', buffer: photo });
    const cropper = dialog('Recadrer la photo');
    await cropper.waitFor();
    await settle(300);
    // Frame the drawing: drag the top-left corner in a little, then the bottom-right one.
    const drag = async (from, dx, dy) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
      await page.mouse.up();
    };
    const box = await page.locator('.mc-box').boundingBox();
    await drag({ x: box.x + 3, y: box.y + 3 }, box.width * 0.05, box.height * 0.06);
    const mid = await page.locator('.mc-box').boundingBox();
    assert(mid.x > box.x + 5 && mid.y > box.y + 5 && mid.width < box.width - 5, 'le coin haut-gauche n’a pas recadré');
    await drag({ x: mid.x + mid.width - 3, y: mid.y + mid.height - 3 }, -box.width * 0.04, -box.height * 0.08);
    const after = await page.locator('.mc-box').boundingBox();
    assert(after.width < mid.width - 5 && after.height < mid.height - 5, 'le coin bas-droit n’a pas recadré');
    await shot('10-recadrage');
    await btn('Valider', cropper).click();
    await cropper.waitFor({ state: 'detached' });
    const thumb = editor.locator('img.media-thumb');
    await thumb.waitFor();
    await waitFor(() => thumb.evaluate((img) => img.complete && img.naturalWidth > 0), { message: 'miniature décodée' });
    const ratio = await thumb.evaluate((img) => img.naturalWidth / img.naturalHeight);
    assert(Math.abs(ratio - 4 / 3) > 0.02, `le recadrage n’a pas changé les proportions (${ratio})`);
    // Audio on the recto via the recorder's file import.
    const recto = editor.locator('.editor-face').nth(0);
    await btn('Audio', recto).click();
    const recorder = dialog('Enregistrer un audio');
    await recorder.waitFor();
    await pickFileVia(() => btn('Importer un fichier audio', recorder).click(), { name: 'prononciation.wav', mimeType: 'audio/wav', buffer: makeWav() });
    await waitFor(async () => (await recorder.getAttribute('data-phase')) === 'preview', { message: 'aperçu audio' }).catch(async () => {
      await recorder.locator('.mr-preview').waitFor();
    });
    await btn('Valider', recorder).click();
    await recorder.waitFor({ state: 'detached' });
    await recto.locator('.media-audio .media-audio-btn').waitFor();
    await settle(300);
    await shot('09-editeur-image');
    await btn('Enregistrer', editor).click();
    await editor.waitFor({ state: 'detached' });
    const row = page.locator('.card-row', { hasText: 'Notion 1.01 : le patrimoine' });
    await row.waitFor();
    eq(await row.locator('.card-badges svg').count(), 2, 'badges image + audio');
    const card = await cardByFront('Notion 1.01 : le patrimoine');
    assert(card.back.imageId && card.front.audioId, 'médias enregistrés sur la carte');
    eq((await db('exportBackup')).media.length, 2, 'médias en base');
  });

  await step('Cartes : la photo et l’audio persistent après rechargement', async () => {
    await page.reload();
    await page.locator('.card-row', { hasText: 'Notion 1.01 : le patrimoine' }).click();
    const editor = dialog('Éditeur de carte');
    await editor.waitFor();
    const thumb = editor.locator('img.media-thumb');
    await thumb.waitFor();
    await waitFor(() => thumb.evaluate((img) => img.complete && img.naturalWidth > 100), { message: 'miniature rechargée' });
    await editor.locator('.media-audio-btn').waitFor();
    await editor.locator('.media-audio-btn').click(); // play (no error expected)
    await settle(300);
    // Re-crop the saved photo (rotate it), then close without saving: confirmation, nothing written.
    const imageId = (await cardByFront('Notion 1.01 : le patrimoine')).back.imageId;
    await btn('Recadrer', editor).click();
    const cropper = dialog('Recadrer la photo');
    await cropper.waitFor();
    await btn('Pivoter', cropper).click();
    await btn('Valider', cropper).click();
    await cropper.waitFor({ state: 'detached' });
    await waitFor(() => editor.locator('img.media-thumb').evaluate((img) => img.complete && img.naturalHeight > img.naturalWidth), {
      message: 'miniature pivotée',
    });
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    await confirmIn('Abandonner les modifications ?', 'Abandonner');
    await editor.waitFor({ state: 'detached' });
    eq((await cardByFront('Notion 1.01 : le patrimoine')).back.imageId, imageId, 'image inchangée après abandon');
    eq((await db('exportBackup')).media.length, 2, 'aucun média orphelin');
  });

  await step('Cartes : déplacer une carte vers un autre dossier', async () => {
    const ch5 = await folderId('Chapitre 5 - Les provisions');
    const ch6 = await folderId('Chapitre 6 - La trésorerie');
    await go(`#/cards/${ch5}`, '.card-row');
    await page.locator('.card-row', { hasText: 'Notion 5.15' }).click();
    const editor = dialog('Éditeur de carte');
    await editor.waitFor();
    await page.locator('#ed-folder').selectOption(ch6);
    await btn('Enregistrer', editor).click();
    await editor.waitFor({ state: 'detached' });
    await waitFor(async () => (await page.locator('.card-row', { hasText: 'Notion 5.15' }).count()) === 0, { message: 'carte partie' });
    eq((await cardByFront('Notion 5.15')).folderId, ch6, 'dossier de la carte');
  });

  await step('Cartes : créer dossier, sous-dossier et cartes à la main', async () => {
    await go('#/cards', '.page-title');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await btn('Nouveau dossier', dialog()).click();
    await prompt('Nouveau dossier', 'Brouillon', 'Créer');
    await page.getByRole('heading', { name: 'Brouillon' }).waitFor();
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await btn('Nouveau sous-dossier', dialog()).click();
    await prompt('Nouveau sous-dossier', 'Notes', 'Créer');
    await page.getByRole('heading', { name: 'Notes' }).waitFor();
    await page.getByRole('button', { name: 'Ajouter' }).click();
    await btn('Nouvelle carte', dialog()).click();
    const editor = dialog('Éditeur de carte');
    await editor.waitFor();
    await page.locator('#ed-front').fill('Carte manuelle 1');
    await btn('Enregistrer', editor).click();
    await editor.locator('.form-error').waitFor();
    assert(/verso est vide/.test(await editor.locator('.form-error').innerText()), 'validation du verso vide');
    await page.locator('#ed-back').fill('Verso 1');
    await btn('Enregistrer et nouvelle', editor).click();
    await waitFor(async () => (await page.locator('#ed-front').inputValue()) === '', { message: 'formulaire vidé' });
    await page.locator('#ed-front').fill('Carte manuelle 2');
    await page.locator('#ed-back').fill('Une ligne\nDeux lignes');
    await btn('Enregistrer', editor).click();
    await editor.waitFor({ state: 'detached' });
    await waitFor(async () => (await page.locator('.card-row').count()) === 2, { message: '2 cartes dans Notes' });
    eq((await cardByFront('Carte manuelle 2')).back.text, 'Une ligne\nDeux lignes', 'retour à la ligne conservé');
  });

  await step('Cartes : renommer, déplacer puis supprimer un dossier (cascade)', async () => {
    await page.getByRole('button', { name: 'Options du dossier' }).click();
    await btn('Renommer', dialog()).click();
    await prompt('Renommer le dossier', 'Notes perso', 'Renommer');
    await page.getByRole('heading', { name: 'Notes perso' }).waitFor();
    // Move into Comptabilité (itself is disabled in the picker).
    await page.getByRole('button', { name: 'Options du dossier' }).click();
    await btn('Déplacer', dialog()).click();
    const picker = dialog('Déplacer « Notes perso » vers…');
    await picker.waitFor();
    assert(await picker.getByRole('button', { name: /^Notes perso/ }).isDisabled(), 'le dossier lui-même doit être désactivé');
    await picker.getByRole('button', { name: /Comptabilité/ }).click();
    await page.locator('.toast', { hasText: 'Dossier déplacé' }).waitFor();
    eq((await db('getFolder', await folderId('Notes perso'))).parentId, ctx.compta, 'nouveau parent');
    // Move it back under Brouillon.
    await page.getByRole('button', { name: 'Options du dossier' }).click();
    await btn('Déplacer', dialog()).click();
    await dialog('Déplacer « Notes perso » vers…').getByRole('button', { name: /Brouillon/ }).click();
    await page.locator('.toast', { hasText: 'Dossier déplacé' }).last().waitFor();
    // Up to the parent through the breadcrumb (a forward navigation to the previous screen).
    await page.locator('.breadcrumb').getByRole('link', { name: 'Brouillon' }).click();
    await page.getByRole('heading', { name: 'Brouillon' }).waitFor();
    await page.locator('.folder-row').waitFor();
    await page.getByRole('button', { name: 'Options du dossier' }).click();
    await btn('Supprimer', dialog()).click();
    const confirm = dialog('Supprimer « Brouillon » ?');
    await confirm.waitFor();
    const msg = await confirm.innerText();
    assert(/2 dossiers et 2 cartes seront supprimés/.test(msg), `message de suppression : ${msg}`);
    await btn('Supprimer', confirm).click();
    await page.locator('.toast', { hasText: 'Dossier supprimé' }).waitFor();
    await page.locator('.page-title', { hasText: 'Cartes' }).waitFor();
    eq((await db('getCards')).length, 114, 'cartes après suppression');
    assert(!(await db('getFolders')).some((f) => f.name === 'Brouillon' || f.name === 'Notes perso'), 'dossiers supprimés');
  });

  /* ================================================================ */
  /* Réviser: method, selection, study                                 */
  /* ================================================================ */
  await step('Réviser : créer une méthode et choisir les chapitres 1 à 3 (tri-état)', async () => {
    await tab('review');
    await btn('Nouvelle méthode').click();
    await prompt('Nouvelle méthode', 'Partiel de gestion', 'Créer');
    await page.getByRole('heading', { name: 'Cartes de la méthode' }).waitFor();
    ctx.method = /#\/method\/([^/]+)\/select/.exec(page.url())[1];
    eq((await page.locator('.select-count').innerText()).trim(), '0 carte sélectionnée', 'compteur initial');
    await page.getByRole('button', { name: 'Déplier Gestion' }).click();
    for (const c of [1, 2, 3]) {
      await page.getByRole('checkbox', { name: `Sélectionner le dossier Chapitre ${c} - ${CHAPTERS[c - 1]}` }).click();
    }
    eq((await page.locator('.select-count').innerText()).trim(), '50 cartes sélectionnées', 'compteur après 3 chapitres');
    eq(await page.getByRole('checkbox', { name: 'Sélectionner le dossier Gestion' }).getAttribute('aria-checked'), 'mixed', 'Gestion partiel');
    // Uncheck one card inside chapter 1.
    await page.getByRole('button', { name: 'Déplier Chapitre 1 - Les bases' }).click();
    await page.getByRole('checkbox', { name: 'Sélectionner la carte Notion 1.15' }).click();
    eq((await page.locator('.select-count').innerText()).trim(), '49 cartes sélectionnées', 'compteur après décochage');
    eq(await page.getByRole('checkbox', { name: 'Sélectionner le dossier Chapitre 1 - Les bases' }).getAttribute('aria-checked'), 'mixed', 'Chapitre 1 partiel');
    eq(await page.getByRole('checkbox', { name: 'Sélectionner le dossier Chapitre 3 - Le compte de résultat' }).getAttribute('aria-checked'), 'true', 'Chapitre 3 coché');
    await shot('03-selection');
    const done = btn('Terminé');
    const tb = await page.locator('#tabbar').boundingBox();
    const db0 = await done.boundingBox();
    assert(db0.y + db0.height <= tb.y + 1, '« Terminé » doit rester au-dessus de la barre d’onglets');
    await done.click();
    await page.getByRole('link', { name: /Réviser \(20\)/ }).waitFor();
    const m = await db('getMethod', ctx.method);
    eq(m.rules[`f:${await folderId('Chapitre 1 - Les bases')}`], true, 'règle du chapitre 1');
    eq(m.rules[`c:${(await cardByFront('Notion 1.15')).id}`], false, 'règle de la carte décochée');
  });

  await step('Réviser : liste et écran de la méthode (stats, Réviser (N))', async () => {
    const stats = await page.locator('.stats-row').innerText();
    assert(/49\s*Cartes/.test(stats) && /49\s*Nouvelles/.test(stats), `stats : ${stats}`);
    await shot('02-methode');
    await tab('review');
    await tab('review');
    const card = page.locator('.method-card', { hasText: 'Partiel de gestion' });
    await card.waitFor();
    assert(/20 à réviser/.test(await card.innerText()), 'pastille « 20 à réviser »');
    await shot('01-methodes');
    await card.click();
    await page.getByRole('link', { name: /Réviser \(20\)/ }).click();
    await page.locator('.flashcard').waitFor();
  });

  await step('Étude : afficher, « Je ne sais pas » revient 4 cartes plus tard, « Je sais » sort', async () => {
    eq(await remaining(), 20, 'restantes au départ');
    const a = await question();
    eq(a, 'Notion 1.01 : le patrimoine', 'première carte (ordre du cours)');
    await page.locator('.flashcard .fc-q .media-audio-btn').waitFor();
    await shot('04-etude-question');
    await showAnswer();
    await waitFor(() => page.locator('.flashcard .fc-a img.face-img').evaluate((img) => img.complete && img.naturalWidth > 0), { message: 'image du verso' });
    await shot('05-etude-reponse');
    await btn('Je ne sais pas').click();
    eq(await remaining(), 20, 'la carte ratée reste dans la file');
    for (let i = 0; i < 4; i++) {
      const q = await question();
      assert(q !== a, `la carte ratée est revenue trop tôt (après ${i} cartes)`);
      await revealAndAnswer(true);
      eq(await remaining(), 19 - i, 'restantes après « je sais »');
    }
    eq(await question(), a, 'la carte ratée revient après 4 cartes');
    await revealAndAnswer(true);
    eq(await remaining(), 15, 'restantes');
    const p = await settledProgress((await cardByFront(a)).id, (x) => x && x.status === 'review');
    eq(p.status, 'review', 'statut après « je sais »');
    eq(p.level, 1, 'niveau');
    eq(p.dueDay, await addDays(await today(), 1), 'revient demain');
  });

  await step('Étude : annuler restaure la progression et newToday', async () => {
    const x = await question();
    const id = (await cardByFront(x)).id;
    await waitFor(async () => (await db('getMethod', ctx.method)).newToday.count === 5, { message: 'newToday = 5' });
    await revealAndAnswer(true);
    await waitFor(async () => (await db('getProgress', ctx.method, id)) && (await db('getMethod', ctx.method)).newToday.count === 6, {
      message: 'réponse écrite',
    });
    await page.getByRole('button', { name: 'Annuler la dernière réponse' }).click();
    eq(await question(), x, 'carte restaurée');
    assert(await page.locator('.flashcard.is-revealed').count(), 'carte restaurée retournée');
    await waitFor(async () => !(await db('getProgress', ctx.method, id)) && (await db('getMethod', ctx.method)).newToday.count === 5, {
      message: 'annulation écrite',
    });
    eq(await remaining(), 15, 'restantes après annulation');
    assert(await page.getByRole('button', { name: 'Annuler la dernière réponse' }).isEnabled(), 'encore une annulation possible');
    await btn('Je sais').click();
  });

  await step('Étude : glisser à droite (je sais) et à gauche (je ne sais pas) au doigt', async () => {
    const r0 = await remaining();
    let q = await question();
    await showAnswer();
    await touchSwipe(0.45);
    await waitFor(async () => (await question()) !== q, { message: 'carte suivante après glissement' });
    eq(await remaining(), r0 - 1, 'glisser à droite = je sais');
    q = await question();
    await showAnswer();
    await touchSwipe(-0.45);
    await waitFor(async () => (await question()) !== q, { message: 'carte suivante après glissement' });
    eq(await remaining(), r0 - 1, 'glisser à gauche = je ne sais pas');
    const p = await settledProgress((await cardByFront(q)).id, (x) => x && x.status === 'learning');
    eq(p && p.status, 'learning', 'carte ratée en apprentissage');
    // A double tap on « Je sais » must not reveal the next card's answer.
    await showAnswer();
    await page.evaluate(() => {
      document.querySelector('.answer-row .is-yes').click();
      document.querySelector('.study-actions .btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    });
    assert(!(await page.locator('.flashcard.is-revealed').count()), 'un double tap a affiché la réponse suivante');
    // A short drag does not answer.
    const q2 = await question();
    await showAnswer();
    await touchSwipe(0.1);
    await settle(300);
    eq(await question(), q2, 'un petit glissement ne répond pas');
    await btn('Je sais').click();
  });

  await step('Étude : raccourcis clavier (Espace, →, 1, Z)', async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const r0 = await remaining();
    const q = await question();
    await page.keyboard.press('Space');
    await page.locator('.flashcard.is-revealed').waitFor();
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => (await question()) !== q, { message: '→' });
    eq(await remaining(), r0 - 1, '→ = je sais');
    await page.keyboard.press('z');
    await waitFor(async () => (await question()) === q, { message: 'Z = annuler' });
    eq(await remaining(), r0, 'Z restaure');
    await page.keyboard.press('2');
    await waitFor(async () => (await question()) !== q, { message: '2' });
    const q3 = await question();
    await page.keyboard.press('Enter');
    await page.locator('.flashcard.is-revealed').waitFor();
    await page.keyboard.press('1');
    await waitFor(async () => (await question()) !== q3, { message: '1 = je ne sais pas' });
  });

  await step('Étude : modifier la carte en cours depuis la séance', async () => {
    await showAnswer();
    const q = await question();
    await page.getByRole('button', { name: 'Modifier la carte' }).click();
    const editor = dialog('Éditeur de carte');
    await editor.waitFor();
    await page.locator('#ed-back').fill('Verso corrigé pendant la séance');
    await btn('Enregistrer', editor).click();
    await editor.waitFor({ state: 'detached' });
    await page.locator('.flashcard .fc-a', { hasText: 'Verso corrigé pendant la séance' }).waitFor();
    eq(await question(), q, 'même carte après modification');
    await btn('Je sais').click();
  });

  await step('Étude : fin de séance, « +10 nouvelles cartes »', async () => {
    await finishSession('keys');
    const end = page.locator('.end');
    await end.waitFor();
    const text = await end.innerText();
    assert(/Session terminée ✓/.test(text), `titre de fin : ${text}`);
    assert(/20\s*cartes révisées/.test(text), `cartes révisées : ${text}`);
    assert(/Prochaine révision : demain/.test(text), `prochaine révision : ${text}`);
    const geo = await page.evaluate(() => {
      const b = document.querySelector('.end-actions .btn').getBoundingClientRect();
      return { left: b.left, right: innerWidth - b.right, scroll: document.querySelector('.screen').scrollLeft };
    });
    assert(geo.scroll === 0 && Math.abs(geo.left - geo.right) < 1, `écran de fin décalé : ${JSON.stringify(geo)}`);
    await shot('06-fin-de-seance');
    // The last answer is written asynchronously (ordered write queue): wait for it.
    await waitFor(async () => (await db('getMethod', ctx.method)).newToday.count === 20, { message: 'newToday = 20' });
    eq((await db('getMethod', ctx.method)).newToday.day, await today(), 'jour de newToday');
    await waitFor(async () => (await db('getProgressForMethod', ctx.method)).filter((p) => p.level === 1).length === 20, {
      timeout: 4000,
    }).catch(() => {});
    const progress = await db('getProgressForMethod', ctx.method);
    eq(progress.length, 20, 'progressions');
    assert(progress.every((p) => p.status === 'review' && p.level === 1), 'toutes connues → niveau 1');
    await btn('+10 nouvelles cartes').click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 10, 'séance de 10 nouvelles cartes');
    ctx.failedB = await question();
    await revealAndAnswer(false);
    await revealAndAnswer(true);
    await revealAndAnswer(true);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.locator('.hero').waitFor();
    await waitFor(async () => (await db('getMethod', ctx.method)).newToday.count === 23, { message: 'newToday = 23' });
  });

  await step('Réviser : rouvrir le même jour → seulement la carte ratée', async () => {
    await page.getByRole('link', { name: /Réviser \(1\)/ }).click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 1, 'une seule carte');
    eq(await question(), ctx.failedB, 'la carte ratée');
    await revealAndAnswer(true);
    await page.locator('.end').waitFor();
    await btn('+10 nouvelles cartes').waitFor();
    await btn('Retour').click();
    await page.getByText("Rien à réviser pour aujourd'hui ✓").waitFor();
    const next = await page.locator('.done-sub').innerText();
    assert(/Prochaine révision : demain \(\d+ cartes\)/.test(next), `prochaine révision : ${next}`);
    // « +10 nouvelles cartes » from the method screen; the extra is one-shot (URL cleaned).
    await page.getByRole('link', { name: '+10 nouvelles cartes' }).click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 10, 'séance +10 depuis l’écran de la méthode');
    assert(!page.url().includes('more='), `l’URL garde « more » : ${page.url()}`);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.getByText("Rien à réviser pour aujourd'hui ✓").waitFor();
    await page.goForward();
    await page.locator('.end').waitFor();
    assert(/Rien à réviser pour aujourd'hui/.test(await page.locator('.end').innerText()), 'pas de cartes en plus au retour en avant');
    await btn('Retour').click();
    await page.getByText("Rien à réviser pour aujourd'hui ✓").waitFor();
    eq((await db('getMethod', ctx.method)).newToday.count, 23, 'newToday inchangé');
  });

  await step('Réviser : ajouter le chapitre 4 à la même méthode → elle s’adapte', async () => {
    await page.getByRole('link', { name: /Choisir les cartes/ }).click();
    await page.getByRole('heading', { name: 'Cartes de la méthode' }).waitFor();
    await page.getByRole('button', { name: 'Déplier Gestion' }).click();
    await page.getByRole('checkbox', { name: 'Sélectionner le dossier Chapitre 4 - Les amortissements' }).click();
    eq((await page.locator('.select-count').innerText()).trim(), '64 cartes sélectionnées', 'compteur avec le chapitre 4');
    await btn('Terminé').click();
    await page.locator('.stats-row').waitFor();
    const stats = await page.locator('.stats-row').innerText();
    assert(/64\s*Cartes/.test(stats) && /41\s*Nouvelles/.test(stats), `stats : ${stats}`);
  });

  /* ================================================================ */
  /* Practice never writes                                             */
  /* ================================================================ */
  await step('Entraînement libre (méthode) : aucune écriture', async () => {
    const before = await progressSnapshot(ctx.method);
    const nt = JSON.stringify((await db('getMethod', ctx.method)).newToday);
    await page.getByRole('link', { name: /Entraînement libre/ }).click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 64, 'toutes les cartes');
    await revealAndAnswer(false);
    await revealAndAnswer(true);
    await revealAndAnswer(true, 'keys');
    await settle(200);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.locator('.hero').waitFor();
    eq(await progressSnapshot(ctx.method), before, 'progression inchangée');
    eq(JSON.stringify((await db('getMethod', ctx.method)).newToday), nt, 'newToday inchangé');
  });

  await step('Entraînement libre (dossier) : aucune écriture, « Recommencer »', async () => {
    const before = await progressSnapshot(ctx.method);
    await go(`#/cards/${ctx.compta}`, '.card-row');
    await page.getByRole('button', { name: 'Options du dossier' }).click();
    await btn("S'entraîner", dialog()).click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 4, 'cartes du dossier et sous-dossiers');
    await finishSession('button');
    await btn('Recommencer').click();
    eq(await remaining(), 4, 'recommencer');
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.getByRole('heading', { name: 'Comptabilité' }).waitFor();
    eq(await progressSnapshot(ctx.method), before, 'progression inchangée');
  });

  /* ================================================================ */
  /* Next days                                                         */
  /* ================================================================ */
  const day0 = await today();
  const known0 = (await cardByFront('Notion 1.02')).id;

  await step('Jour +1 : les cartes connues hier reviennent', async () => {
    await page.evaluate(() => localStorage.setItem('__e2eDayOffset', '1'));
    await page.reload();
    eq(await today(), await addDays(day0, 1), 'date simulée');
    await go(`#/method/${ctx.method}`, '.hero');
    await page.getByRole('link', { name: /Réviser \(43\)/ }).waitFor(); // 23 dues + 20 nouvelles
    await page.getByRole('link', { name: /Réviser \(43\)/ }).click();
    await page.locator('.flashcard').waitFor();
    eq(await remaining(), 43, 'file du jour +1');
    await finishSession('keys');
    const p = await settledProgress(known0, (x) => x && x.level === 2);
    eq(p.level, 2, 'niveau 2');
    eq(p.dueDay, await addDays(day0, 1 + 3), 'revient 3 jours plus tard');
    await btn('Retour').click();
    await page.getByText("Rien à réviser pour aujourd'hui ✓").waitFor();
  });

  await step('Jour +2 : « Illimité » fait entrer le chapitre 4, sens Verso → Recto', async () => {
    await page.evaluate(() => localStorage.setItem('__e2eDayOffset', '2'));
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.getByLabel('Nouvelles cartes par jour').selectOption('null');
    await page.getByRole('link', { name: /Réviser \(41\)/ }).waitFor(); // 20 dues + 21 nouvelles
    eq((await db('getMethod', ctx.method)).newPerDay, null, 'newPerDay illimité');
    await page.getByLabel('Sens').selectOption('back');
    await waitFor(async () => (await db('getMethod', ctx.method)).direction === 'back', { message: 'sens enregistré' });
    await page.getByRole('link', { name: /Réviser \(41\)/ }).click();
    await page.locator('.flashcard').waitFor();
    eq((await page.locator('.flashcard .fc-q .fc-side').innerText()).trim().toLowerCase(), 'verso', 'question = verso');
    assert(/^(Définition|Corrigé|Verso)/.test(await question()), `la question devrait être un verso : ${await question()}`);
    const seen = [];
    for (let i = 0; i < 60 && !(await page.locator('.end').count()); i++) {
      await page.keyboard.press('Space');
      await page.locator('.flashcard.is-revealed').waitFor();
      seen.push((await page.locator('.flashcard .fc-a .face-text').first().innerText()).trim());
      await page.keyboard.press('ArrowRight');
      await waitFor(async () => (await page.locator('.end').count()) > 0 || (await page.locator('.flashcard:not(.is-revealed)').count()) > 0);
    }
    await page.locator('.end').waitFor();
    assert(seen.includes('Notion 4.01'), 'les cartes du chapitre 4 sont apparues');
    eq(seen.length, 41, 'cartes vues');
    await btn('Retour').click();
    await page.locator('.hero').waitFor();
    await page.getByLabel('Sens').selectOption('front');
    await page.getByLabel('Nouvelles cartes par jour').selectOption('20');
    await waitFor(async () => (await db('getMethod', ctx.method)).newPerDay === 20, { message: 'newPerDay = 20' });
  });

  await step('Jour +4 : les cartes du jour 0 reviennent (intervalle 3 j) puis partent à 7 j', async () => {
    await page.evaluate(() => localStorage.setItem('__e2eDayOffset', '4'));
    await page.reload();
    await page.locator('.hero').waitFor();
    const day4 = await today();
    const due = (await db('getProgressForMethod', ctx.method)).filter((p) => p.dueDay <= day4).length;
    eq(due, 44, 'cartes dues au jour +4 (23 du jour 0 + 21 du jour +2)');
    await page.getByRole('link', { name: `Réviser (${due})` }).waitFor();
    await page.getByRole('link', { name: /Réviser \(\d+\)/ }).click();
    await page.locator('.flashcard').waitFor();
    await finishSession('keys');
    const p = await settledProgress(known0, (x) => x && x.level === 3);
    eq(p.level, 3, 'niveau 3');
    eq(p.dueDay, await addDays(day0, 4 + 7), 'revient 7 jours plus tard');
    await btn('Retour').click();
    await page.locator('.hero').waitFor();
  });

  await step('Réglages : par jour, ordre, sens mélangé, renommer', async () => {
    await page.evaluate(() => localStorage.setItem('__e2eDayOffset', '5'));
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.getByLabel('Nouvelles cartes par jour').selectOption('5');
    await waitFor(async () => (await db('getMethod', ctx.method)).newPerDay === 5, { message: 'newPerDay = 5' });
    await page.getByLabel('Ordre des nouvelles cartes').selectOption('random');
    await waitFor(async () => (await db('getMethod', ctx.method)).shuffleNew === true, { message: 'shuffleNew' });
    await page.getByLabel('Sens').selectOption('mixed');
    await waitFor(async () => (await db('getMethod', ctx.method)).direction === 'mixed', { message: 'mélangé' });
    eq(await page.getByLabel('Nouvelles cartes par jour').inputValue(), '5', 'réglage affiché après rafraîchissement');
    await page.getByRole('link', { name: /Entraînement libre/ }).click();
    await page.locator('.flashcard').waitFor();
    const sides = new Set();
    for (let i = 0; i < 16; i++) {
      sides.add((await page.locator('.flashcard .fc-q .fc-side').innerText()).trim().toLowerCase());
      await revealAndAnswer(true, 'keys');
    }
    assert(sides.has('recto') && sides.has('verso'), `sens mélangé : ${[...sides]}`);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.locator('.hero').waitFor();
    await page.getByLabel('Sens').selectOption('front');
    await waitFor(async () => (await db('getMethod', ctx.method)).direction === 'front', { message: 'sens recto' });
    await btn('Renommer').click();
    await prompt('Renommer la méthode', 'Partiel du 15 janvier', 'Renommer');
    await page.getByRole('heading', { name: 'Partiel du 15 janvier' }).waitFor();
  });

  /* ================================================================ */
  /* Backup → wipe → restore                                           */
  /* ================================================================ */
  await step('Sauvegarde : exporter, tout effacer, restaurer', async () => {
    const before = await db('exportBackup');
    await go(`#/cards/${await folderId('Chapitre 1 - Les bases')}`, '.card-row'); // remembered by the Cartes tab
    await tab('data');
    await btn('Exporter une sauvegarde').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), btn('Exporter une sauvegarde').click()]);
    assert(/^recto-sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `nom du fichier : ${download.suggestedFilename()}`);
    const file = join(OUT_DIR, download.suggestedFilename());
    await download.saveAs(file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    eq(saved.media.length, 2, 'médias dans la sauvegarde');
    await btn('Tout effacer').click();
    await confirmIn('Tout effacer ?', 'Continuer');
    await confirmIn('Vraiment tout effacer ?', 'Tout effacer');
    await page.locator('.toast', { hasText: 'Toutes les données ont été effacées' }).waitFor();
    eq((await db('getCards')).length, 0, 'plus de cartes');
    eq((await db('getMethods')).length, 0, 'plus de méthodes');
    await tab('cards'); // must open the (empty) root, not the deleted folder it remembered
    await page.getByText("Aucune carte pour l'instant").waitFor();
    await tab('data');
    await pickFileVia(() => btn('Restaurer une sauvegarde').click(), file);
    await confirmIn('Restaurer cette sauvegarde ?', 'Tout remplacer');
    await page.locator('.toast', { hasText: 'Sauvegarde restaurée' }).waitFor();
    const after = await db('exportBackup');
    for (const k of ['folders', 'cards', 'methods', 'progress', 'media']) {
      const sort = (l) => JSON.stringify([...l].sort((a, b) => String(a.id).localeCompare(String(b.id))));
      eq(sort(after[k]), sort(before[k]), `${k} identiques après restauration`);
    }
    await go(`#/method/${ctx.method}`, '.hero');
    await page.getByRole('heading', { name: 'Partiel du 15 janvier' }).waitFor();
    await go('#/cards', '.page-title');
    await page.locator('.search-input').fill('patrimoine');
    await page.locator('.card-row', { hasText: 'Notion 1.01 : le patrimoine' }).click();
    const editor = dialog('Éditeur de carte');
    await waitFor(() => editor.locator('img.media-thumb').evaluate((img) => img.complete && img.naturalWidth > 100), { message: 'image restaurée' });
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    await editor.waitFor({ state: 'detached' });
    await page.locator('.search-input').fill('');
  });

  /* ================================================================ */
  /* Offline, dark mode, phone layout                                  */
  /* ================================================================ */
  await step('Hors ligne : l’app se recharge et fonctionne', async () => {
    await context.setOffline(true);
    await page.reload();
    await page.locator('.page-title', { hasText: 'Cartes' }).waitFor();
    await tab('review');
    await page.locator('.method-card').first().click();
    await page.getByRole('link', { name: /Entraînement libre/ }).click();
    await page.locator('.flashcard').waitFor();
    await revealAndAnswer(true);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.locator('.hero').waitFor();
    await context.setOffline(false);
  });

  await step('Mode sombre : couleurs sombres sur l’écran d’étude', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('link', { name: /Entraînement libre/ }).click();
    await page.locator('.flashcard').waitFor();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    eq(bg, 'rgb(17, 17, 19)', 'fond sombre');
    const cardBg = await page.locator('.flashcard').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(cardBg !== 'rgb(255, 255, 255)', 'carte sombre');
    await showAnswer();
    await shot('12-etude-sombre');
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.locator('.hero').waitFor();
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('Téléphone 360 px : pas de défilement horizontal, rien sous la barre d’onglets', async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    // A very long card to check wrapping.
    const ch1 = await folderId('Chapitre 1 - Les bases');
    await db('createCard', {
      folderId: ch1,
      front: { text: 'Anticonstitutionnellementanticonstitutionnellementanticonstitutionnellement' },
      back: { text: 'Texte très long. '.repeat(120) },
    });
    const screens = [
      ['#/', '.method-card'],
      [`#/method/${ctx.method}`, '.hero'],
      [`#/method/${ctx.method}/select`, '.tree-row'],
      ['#/cards', '.folder-row'],
      [`#/cards/${ch1}`, '.card-row'],
      ['#/data', '#imp-text'],
    ];
    for (const [hash, sel] of screens) {
      await go(hash, sel);
      await checkLayout(hash);
    }
    await go(`#/practice/folder/${ch1}`, '.flashcard');
    for (let i = 0; i < 30; i++) {
      if ((await question()).startsWith('Anticonstitutionnellement')) break;
      await revealAndAnswer(true, 'keys');
    }
    await showAnswer();
    const study = await page.evaluate(() => {
      const card = document.querySelector('.flashcard');
      const scroll = document.querySelector('.flashcard-scroll');
      const actions = document.querySelector('.study-actions').getBoundingClientRect();
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        cardRight: card.getBoundingClientRect().right,
        scrolls: scroll.scrollHeight > scroll.clientHeight,
        actionsBottom: actions.bottom,
      };
    });
    assert(study.overflowX <= 0 && study.cardRight <= 360, 'carte longue : dépassement horizontal');
    assert(study.scrolls, 'carte longue : le contenu doit défiler dans la carte');
    assert(study.actionsBottom <= 740, 'boutons de réponse visibles');
    await btn('Je sais').waitFor();
    await page.getByRole('button', { name: 'Fermer' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('Méthode : réinitialiser la progression puis supprimer', async () => {
    await go(`#/method/${ctx.method}`, '.hero');
    await btn('Réinitialiser la progression').click();
    await confirmIn('Réinitialiser la progression ?', 'Réinitialiser');
    await page.locator('.toast', { hasText: 'Progression réinitialisée' }).waitFor();
    eq((await db('getProgressForMethod', ctx.method)).length, 0, 'progression effacée');
    await waitFor(async () => /65\s*Nouvelles/.test(await page.locator('.stats-row').innerText()), { message: 'toutes nouvelles' });
    await btn('Supprimer').click();
    await confirmIn('Supprimer la méthode ?', 'Supprimer');
    await page.getByText('Aucune méthode de révision').waitFor();
    eq((await db('getMethods')).length, 0, 'méthode supprimée');
    eq((await db('getCards')).length, 115, 'les cartes restent');
  });
} catch {
  failed = true;
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} étapes réussies en ${((Date.now() - t0) / 1000).toFixed(1)} s${failed ? ' — ÉCHEC' : ''}`);
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results.map(({ error, ...r }) => ({ ...r, error: error && String(error.message) })), null, 2));
process.exit(failed ? 1 : 0);
