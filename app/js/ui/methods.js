// « Réviser » tab root: list of revision methods.

import * as db from '../db.js';
import { studyDay, plural } from '../util.js';
import { h } from '../dom.js';
import { icon } from './icons.js';
import { pageHead, emptyState, promptDialog, guard, isIOSBrowserTab, iosTabNotice } from './components.js';
import { navigate } from './router.js';
import { progressMap, summarizeMethod } from './stats.js';

const IOS_NOTICE_KEY = 'recto.iosNoticeHidden'; // per device: « Masquer » on the Safari-tab notice

function iosNoticeHidden() {
  try {
    return localStorage.getItem(IOS_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function hideIosNotice() {
  try {
    localStorage.setItem(IOS_NOTICE_KEY, '1');
  } catch {
    /* the notice comes back next time */
  }
}

function todayLabel() {
  try {
    const s = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return '';
  }
}

/** Ask for a name, create the method and open its card selection. */
export async function createMethodFlow() {
  const name = await promptDialog({
    title: 'Nouvelle méthode',
    label: 'Nom de la méthode',
    placeholder: 'Ex. Partiel de compta',
    confirmLabel: 'Créer',
  });
  if (!name) return;
  const method = await db.createMethod({ name });
  navigate(`#/method/${encodeURIComponent(method.id)}/select`);
}

function methodCard(method, summary) {
  const { stats, toReview } = summary;
  const pct = stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0;
  return h(
    'a',
    { class: 'method-card', href: `#/method/${encodeURIComponent(method.id)}` },
    h(
      'div',
      { class: 'method-card-top' },
      h('div', { class: 'method-card-name' }, method.name),
      icon('chevronRight', { size: 20, className: 'muted-icon' }),
    ),
    h(
      'div',
      { class: 'method-card-meta' },
      toReview > 0
        ? h('span', { class: 'pill pill-accent' }, `${toReview} à réviser`)
        : h('span', { class: 'pill' }, stats.total ? 'À jour' : 'Aucune carte'),
      h('span', { class: 'muted' }, plural(stats.total, 'carte')),
    ),
    h(
      'div',
      { class: 'method-card-progress' },
      h(
        'div',
        { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Cartes maîtrisées' },
        h('div', { class: 'bar-fill', style: { width: `${pct}%` } }),
      ),
      h('span', { class: 'bar-caption' }, `${stats.mastered}/${stats.total} maîtrisées`),
    ),
  );
}

export async function renderMethods(root, ctx) {
  const [methods, folders, cards] = await Promise.all([db.getMethods(), db.getFolders(), db.getCards()]);
  const progressLists = await Promise.all(methods.map((m) => db.getProgressForMethod(m.id)));
  if (!ctx.alive()) return;

  const today = studyDay();
  const newBtn = h(
    'button',
    { type: 'button', class: 'btn btn-primary btn-block btn-lg' },
    icon('plus', { size: 20 }),
    'Nouvelle méthode',
  );
  newBtn.addEventListener('click', guard(createMethodFlow));

  root.append(pageHead({ title: 'Réviser', subtitle: todayLabel() }));
  // Still in a Safari tab on iPhone: its data is separate from the installed app and can be erased.
  if (isIOSBrowserTab() && !iosNoticeHidden()) root.append(iosTabNotice({ hasCards: cards.length > 0, onDismiss: hideIosNotice }));

  if (!methods.length) {
    // No cards yet: importing them is the first step, so it is the main button.
    let actions = [newBtn];
    if (!cards.length) {
      newBtn.className = 'btn btn-secondary btn-block';
      actions = [h('a', { class: 'btn btn-primary btn-block btn-lg', href: '#/data' }, icon('upload', { size: 20 }), 'Importer des cartes'), newBtn];
    }
    root.append(
      emptyState({
        iconName: 'review',
        title: 'Aucune méthode de révision',
        text:
          'Une méthode = un ensemble de cartes à réviser (par exemple les chapitres 1 à 3). ' +
          "Tu pourras y ajouter d'autres chapitres plus tard : elle s'adapte." +
          (cards.length ? '' : " Commence par importer tes cartes dans l'onglet Données."),
        actions,
      }),
    );
    return;
  }

  const list = h('div', { class: 'method-list' });
  methods.forEach((m, i) => {
    const summary = summarizeMethod(m, folders, cards, progressMap(progressLists[i]), today);
    list.append(methodCard(m, summary));
  });
  newBtn.className = 'btn btn-dashed btn-block';
  root.append(list, newBtn);
  if (!cards.length) {
    root.append(
      h(
        'p',
        { class: 'hint center' },
        "Tu n'as encore aucune carte. ",
        h('a', { href: '#/data' }, 'Importer du JSON'),
      ),
    );
  }
}
