// Helpers turning srs/selection results into the numbers & sentences shown in the UI.

import * as srs from '../srs.js';
import * as sel from '../selection.js';
import { addDays, plural } from '../util.js';
import { formatDayFr } from '../dom.js';

/** Map cardId → Progress from a progress list. */
export function progressMap(list) {
  const map = new Map();
  for (const p of list || []) map.set(p.cardId, p);
  return map;
}

/**
 * Everything the methods list / method screen need for one method.
 * Returns { cards, stats, newLimit, newToday, toReview }.
 */
export function summarizeMethod(method, folders, cards, progressByCard, today) {
  const methodCards = sel.resolveMethodCards(method.rules || {}, folders, cards);
  const stats = srs.methodStats({ cards: methodCards, progressByCard, today });
  const newLimit = srs.remainingNewToday(method, today);
  const newToday = Math.min(stats.new, newLimit);
  return { cards: methodCards, stats, newLimit, newToday, toReview: stats.due + newToday };
}

/** Number of NEW cards (no progress) among the given cards. */
export function countNew(cards, progressByCard) {
  let n = 0;
  for (const c of cards) if (!progressByCard.has(c.id)) n++;
  return n;
}

/**
 * « Prochaine révision : demain (k cartes) » / « … : le jeudi 26 novembre (k cartes) », or null.
 * Counts tomorrow's new cards too (they will be introduced tomorrow).
 */
export function nextReviewText(method, methodCards, progressByCard, today) {
  const stats = srs.methodStats({ cards: methodCards, progressByCard, today });
  const perDay = method.newPerDay == null ? Infinity : method.newPerDay;
  const tomorrowCount = stats.dueTomorrow + Math.min(stats.new, perDay);
  if (tomorrowCount > 0) return `Prochaine révision : demain (${plural(tomorrowCount, 'carte')})`;
  if (stats.nextDueDay) {
    let k = 0;
    for (const c of methodCards) {
      const p = progressByCard.get(c.id);
      if (p && p.dueDay === stats.nextDueDay) k++;
    }
    const tomorrow = addDays(today, 1);
    const when = stats.nextDueDay === tomorrow ? 'demain' : `le ${formatDayFr(stats.nextDueDay)}`;
    return `Prochaine révision : ${when} (${plural(k, 'carte')})`;
  }
  return null;
}
