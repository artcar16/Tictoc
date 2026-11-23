// Method screen: launch a session, stats, card selection, settings.

import * as db from '../db.js';
import { studyDay, plural } from '../util.js';
import { h } from '../dom.js';
import { icon } from './icons.js';
import { topbar, confirmDialog, promptDialog, guard, toast, emptyState } from './components.js';
import { navigate, back } from './router.js';
import { progressMap, summarizeMethod, nextReviewText } from './stats.js';

const NEW_PER_DAY = [5, 10, 20, 30, 50, 100];

function enc(id) {
  return encodeURIComponent(id);
}

/** Row of the « actions » list. */
function linkRow({ href, iconName, title, subtitle }) {
  return h(
    'a',
    { class: 'row row-link', href },
    h('span', { class: 'row-icon' }, icon(iconName, { size: 20 })),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), subtitle ? h('span', { class: 'row-sub' }, subtitle) : null),
    icon('chevronRight', { size: 20, className: 'muted-icon' }),
  );
}

/** Settings row with a native <select>. */
function selectRow(label, options, value, onChange) {
  const id = `set-${Math.random().toString(36).slice(2, 8)}`;
  const select = h(
    'select',
    { id, class: 'select-inline' },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  select.addEventListener(
    'change',
    guard(async () => {
      select.disabled = true;
      try {
        await onChange(select.value);
      } finally {
        select.disabled = false;
      }
    }),
  );
  return h('div', { class: 'row' }, h('label', { class: 'row-main row-title', htmlFor: id }, label), select);
}

/** Thin stacked bar: new cards then levels 0..7. */
function levelBar(stats) {
  const total = stats.total || 1;
  const segs = [];
  if (stats.new) segs.push(h('span', { class: 'lv lv-new', style: { flexGrow: String(stats.new) }, title: `Nouvelles : ${stats.new}` }));
  (stats.byLevel || []).forEach((n, level) => {
    if (n) {
      segs.push(
        h('span', {
          class: `lv lv-${level}`,
          style: { flexGrow: String(n) },
          title: `Niveau ${level} : ${plural(n, 'carte')}`,
        }),
      );
    }
  });
  return h(
    'div',
    { class: 'level-wrap' },
    h('div', { class: 'level-bar', 'aria-hidden': 'true' }, segs.length ? segs : h('span', { class: 'lv lv-new', style: { flexGrow: String(total) } })),
    h('div', { class: 'level-legend' }, h('span', null, 'Nouvelles'), h('span', null, 'Niveau 0 → 7')),
  );
}

export async function renderMethod(root, ctx) {
  const id = ctx.params.id;
  const [method, folders, cards, progress] = await Promise.all([
    db.getMethod(id),
    db.getFolders(),
    db.getCards(),
    db.getProgressForMethod(id),
  ]);
  if (!ctx.alive()) return;
  if (!method) {
    toast('Méthode introuvable');
    navigate('#/', { replace: true });
    return;
  }

  const today = studyDay();
  const progressByCard = progressMap(progress);
  const summary = summarizeMethod(method, folders, cards, progressByCard, today);
  const { stats, toReview } = summary;

  root.append(topbar({ title: method.name, onBack: () => back('#/') }));

  /* --- Hero: start a session --- */
  const hero = h('section', { class: 'hero' });
  if (!stats.total) {
    hero.append(
      emptyState({
        iconName: 'list',
        title: 'Aucune carte sélectionnée',
        text: 'Choisis les dossiers (chapitres) ou les cartes à réviser avec cette méthode.',
        actions: [h('a', { class: 'btn btn-primary btn-block', href: `#/method/${enc(id)}/select` }, 'Choisir les cartes')],
      }),
    );
  } else if (toReview > 0) {
    hero.append(
      h(
        'a',
        { class: 'btn btn-primary btn-xl btn-block', href: `#/study/${enc(id)}` },
        icon('play', { size: 20 }),
        `Réviser (${toReview})`,
      ),
      h(
        'p',
        { class: 'hero-detail' },
        [stats.due ? `${stats.due} à revoir` : null, summary.newToday ? plural(summary.newToday, 'nouvelle', 'nouvelles') : null]
          .filter(Boolean)
          .join(' · '),
      ),
    );
  } else {
    const next = nextReviewText(method, summary.cards, progressByCard, today);
    hero.append(
      h(
        'div',
        { class: 'done-box' },
        h('div', { class: 'done-icon' }, icon('check', { size: 22, strokeWidth: 2.2 })),
        h('div', { class: 'done-title' }, "Rien à réviser pour aujourd'hui ✓"),
        next ? h('div', { class: 'done-sub' }, next) : null,
      ),
    );
    if (stats.new > 0) {
      const extra = Math.min(10, stats.new);
      hero.append(
        h(
          'a',
          { class: 'btn btn-secondary btn-block', href: `#/study/${enc(id)}?more=10` },
          icon('plus', { size: 20 }),
          `+${extra} ${extra > 1 ? 'nouvelles cartes' : 'nouvelle carte'}`,
        ),
      );
    }
  }
  root.append(hero);

  /* --- Stats --- */
  if (stats.total) {
    const enCours = Math.max(0, stats.total - stats.new - stats.mastered);
    const tile = (n, label) => h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(n)), h('div', { class: 'stat-label' }, label));
    root.append(
      h(
        'section',
        { class: 'section' },
        h('div', { class: 'stats-row' }, tile(stats.total, 'Cartes'), tile(stats.new, 'Nouvelles'), tile(enCours, 'En cours'), tile(stats.mastered, 'Maîtrisées')),
        levelBar(stats),
      ),
    );
  }

  /* --- Actions --- */
  root.append(
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'list' },
        linkRow({
          href: `#/method/${enc(id)}/select`,
          iconName: 'list',
          title: 'Choisir les cartes',
          subtitle: `${plural(stats.total, 'carte sélectionnée', 'cartes sélectionnées')}`,
        }),
        stats.total
          ? linkRow({
              href: `#/practice/method/${enc(id)}`,
              iconName: 'shuffle',
              title: 'Entraînement libre',
              subtitle: 'Toutes les cartes, sans effet sur le planning',
            })
          : null,
      ),
    ),
  );

  /* --- Settings --- */
  const save = async (patch) => {
    await db.updateMethod(id, patch);
    ctx.refresh();
  };
  const perDayOptions = NEW_PER_DAY.map((n) => ({ value: String(n), label: String(n) }));
  if (method.newPerDay != null && !NEW_PER_DAY.includes(method.newPerDay)) {
    perDayOptions.push({ value: String(method.newPerDay), label: String(method.newPerDay) });
    perDayOptions.sort((a, b) => Number(a.value) - Number(b.value));
  }
  perDayOptions.push({ value: 'null', label: 'Illimité' });
  root.append(
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, 'Réglages'),
      h(
        'div',
        { class: 'list' },
        selectRow('Nouvelles cartes par jour', perDayOptions, method.newPerDay == null ? 'null' : String(method.newPerDay), (v) =>
          save({ newPerDay: v === 'null' ? null : Number(v) }),
        ),
        selectRow(
          'Ordre des nouvelles cartes',
          [
            { value: 'course', label: 'Ordre du cours' },
            { value: 'random', label: 'Aléatoire' },
          ],
          method.shuffleNew ? 'random' : 'course',
          (v) => save({ shuffleNew: v === 'random' }),
        ),
        selectRow(
          'Sens',
          [
            { value: 'front', label: 'Recto → Verso' },
            { value: 'back', label: 'Verso → Recto' },
            { value: 'mixed', label: 'Mélangé' },
          ],
          method.direction || 'front',
          (v) => save({ direction: v }),
        ),
      ),
    ),
  );

  /* --- Footer: rename / reset / delete --- */
  const rename = guard(async () => {
    const name = await promptDialog({ title: 'Renommer la méthode', label: 'Nom', value: method.name, confirmLabel: 'Renommer' });
    if (!name || name === method.name) return;
    await db.updateMethod(id, { name });
    ctx.refresh();
  });
  const reset = guard(async () => {
    const ok = await confirmDialog({
      title: 'Réinitialiser la progression ?',
      message: 'Toutes les cartes de cette méthode redeviendront nouvelles. Les cartes elles-mêmes ne sont pas supprimées.',
      confirmLabel: 'Réinitialiser',
      danger: true,
    });
    if (!ok) return;
    await db.resetMethodProgress(id);
    toast('Progression réinitialisée');
    ctx.refresh();
  });
  const remove = guard(async () => {
    const ok = await confirmDialog({
      title: 'Supprimer la méthode ?',
      message: `« ${method.name} » et sa progression seront supprimées. Tes cartes restent intactes.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    await db.deleteMethod(id);
    toast('Méthode supprimée');
    back('#/');
  });
  root.append(
    h(
      'footer',
      { class: 'footer-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: rename }, 'Renommer'),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: reset }, 'Réinitialiser la progression'),
      h('button', { type: 'button', class: 'btn btn-ghost is-danger', onClick: remove }, 'Supprimer'),
    ),
  );
}
