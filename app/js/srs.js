// Spaced repetition: scheduling rules, daily queue, statistics and the in-memory study session.
// Pure ES module (no DOM, no IndexedDB): importable from Node for unit tests.

import { addDays, shuffle } from './util.js';

/** Interval in days for each level. Level 0 = learning (due again the same day). */
export const INTERVALS = Object.freeze([0, 1, 3, 7, 14, 30, 60, 120]);
export const MAX_LEVEL = 7;
/** A card whose level is >= MASTERED_LEVEL counts as « maîtrisée ». */
export const MASTERED_LEVEL = 4;
/** A failed card comes back after about this many other cards in the session. */
export const REINSERT_GAP = 4;

/* ------------------------------------------------------------------------ */
/* Small internal helpers                                                   */
/* ------------------------------------------------------------------------ */

/** Non-negative integer from an unknown value (fallback when not a finite number). */
function toCount(v, fallback = 0) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Level clamped to 0..MAX_LEVEL (unknown values count as 0). */
function clampLevel(v) {
  return Number.isFinite(v) ? Math.min(MAX_LEVEL, Math.max(0, Math.floor(v))) : 0;
}

/** Progress record of a card from a Map (null/undefined map = no progress at all). */
function progressOf(progressByCard, cardId) {
  return (progressByCard && progressByCard.get(cardId)) || null;
}

/** A reviewed card is due when its due day is today or earlier (a missing due day counts as due). */
function isDue(p, today) {
  return !p.dueDay || p.dueDay <= today;
}

/* ------------------------------------------------------------------------ */
/* Scheduling                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Pure transition after an answer.
 * prev: Progress|null (null = the card is new for this method).
 * Returns a NEW object { level, status, dueDay, reps, lapses, lastDay, lastAnsweredAt };
 * the caller adds id / methodId / cardId.
 */
export function answer(prev, known, today, nowMs) {
  const reps = toCount(prev?.reps) + 1;
  let lapses = toCount(prev?.lapses);
  let level;
  let status;
  let dueDay;

  if (!known) {
    // Unknown: back to learning, due again today. A lapse = forgetting a card already learned.
    if (prev?.status === 'review') lapses += 1;
    level = 0;
    status = 'learning';
    dueDay = today;
  } else if (!prev || prev.status !== 'review') {
    // New or learning card known: first real interval (tomorrow).
    level = 1;
    status = 'review';
    dueDay = addDays(today, INTERVALS[1]);
  } else {
    // Review card known: climb one level, the interval grows.
    level = Math.min(clampLevel(prev.level) + 1, MAX_LEVEL);
    status = 'review';
    dueDay = addDays(today, INTERVALS[level]);
  }

  return { level, status, dueDay, reps, lapses, lastDay: today, lastAnsweredAt: nowMs };
}

/**
 * Today's queue for a method.
 *  cards: Card[] in course order (already filtered to the method's selection)
 *  progressByCard: Map<cardId, Progress>
 *  newLimit: remaining new cards allowed today (Infinity or null = unlimited)
 * Returns { queue: cardId[], dueCount, newCount, newAvailable }:
 *  due cards (dueDay <= today) shuffled with `rng`, then new cards (course order, or shuffled
 *  when `shuffleNew`) limited to `newLimit`. newAvailable = number of new cards before the limit.
 */
export function buildQueue({ cards, progressByCard, today, newLimit, shuffleNew = false, rng = Math.random }) {
  const due = [];
  const fresh = [];
  const seen = new Set();
  for (const card of cards || []) {
    if (!card || card.id == null || seen.has(card.id)) continue; // ignore duplicates defensively
    seen.add(card.id);
    const p = progressOf(progressByCard, card.id);
    if (!p) fresh.push(card.id);
    else if (isDue(p, today)) due.push(card.id);
  }

  let limit;
  if (newLimit == null || newLimit === Infinity) limit = Infinity;
  else limit = toCount(newLimit, 0);

  const dueIds = shuffle(due, rng);
  const ordered = shuffleNew ? shuffle(fresh, rng) : fresh;
  const newIds = limit >= ordered.length ? ordered : ordered.slice(0, limit);

  return {
    queue: dueIds.concat(newIds),
    dueCount: dueIds.length,
    newCount: newIds.length,
    newAvailable: fresh.length,
  };
}

/** Remaining new cards allowed today for a method (Infinity when unlimited). */
export function remainingNewToday(method, today) {
  if (!method || method.newPerDay == null) return Infinity;
  const perDay = method.newPerDay === Infinity ? Infinity : toCount(method.newPerDay, 0);
  const nt = method.newToday;
  const used = nt && nt.day === today ? toCount(nt.count, 0) : 0;
  return Math.max(0, perDay - used);
}

/**
 * Statistics of a method over its (already filtered) cards.
 * → { total, new, learning, review, mastered, due, dueTomorrow, nextDueDay, byLevel[8] }
 */
export function methodStats({ cards, progressByCard, today }) {
  const tomorrow = addDays(today, 1);
  const byLevel = new Array(MAX_LEVEL + 1).fill(0);
  const stats = {
    total: 0,
    new: 0,
    learning: 0,
    review: 0,
    mastered: 0,
    due: 0,
    dueTomorrow: 0,
    nextDueDay: null,
    byLevel,
  };

  for (const card of cards || []) {
    if (!card) continue;
    stats.total++;
    const p = progressOf(progressByCard, card.id);
    if (!p) {
      stats.new++;
      continue;
    }
    const level = clampLevel(p.level);
    byLevel[level]++;
    if (p.status === 'review') stats.review++;
    else stats.learning++;
    if (level >= MASTERED_LEVEL) stats.mastered++;
    if (isDue(p, today)) stats.due++;
    else {
      if (p.dueDay === tomorrow) stats.dueTomorrow++;
      if (stats.nextDueDay === null || p.dueDay < stats.nextDueDay) stats.nextDueDay = p.dueDay;
    }
  }
  return stats;
}

/* ------------------------------------------------------------------------ */
/* Study session                                                            */
/* ------------------------------------------------------------------------ */

/**
 * In-memory study session over a queue of card ids (scheduled study and free practice).
 * - answer(true): the current card leaves the queue.
 * - answer(false): the current card is re-inserted `gap` cards later (or at the end when fewer
 *   cards remain; immediately when it is the only card left), again and again until known.
 * - undo(): restores the queue and the stats exactly as before the last answer().
 * Undo is implemented with exact inverse operations, so history entries stay small.
 */
export class Session {
  constructor(queue, { gap = REINSERT_GAP } = {}) {
    this._gap = Number.isFinite(gap) && gap >= 0 ? Math.floor(gap) : REINSERT_GAP;
    this._reset(Array.isArray(queue) ? queue.filter((id) => id != null) : []);
  }

  /** (Re)initialise the state from a queue. */
  _reset(queue) {
    this._queue = queue.slice();
    this._counts = new Map(); // cardId → occurrences in the queue (for `remaining`)
    for (const id of this._queue) this._counts.set(id, (this._counts.get(id) || 0) + 1);
    this._answeredIds = new Set(); // cards answered at least once
    this._answered = 0;
    this._known = 0;
    this._unknown = 0;
    this._history = []; // [{ cardId, insertedAt, firstTime, answered, known, unknown }]
  }

  /** Card id currently asked, or null when the session is over. */
  get current() {
    return this._queue.length ? this._queue[0] : null;
  }

  /** Number of DISTINCT card ids still in the queue. */
  get remaining() {
    return this._counts.size;
  }

  get done() {
    return this._queue.length === 0;
  }

  /** Copy of the current queue (front first). */
  get queue() {
    return this._queue.slice();
  }

  get gap() {
    return this._gap;
  }

  /** { answered, known, unknown, distinct } — distinct = cards answered at least once. */
  get stats() {
    return {
      answered: this._answered,
      known: this._known,
      unknown: this._unknown,
      distinct: this._answeredIds.size,
    };
  }

  get canUndo() {
    return this._history.length > 0;
  }

  /** Grade the current card. Returns the answered card id (null if the session is over). */
  answer(known) {
    if (!this._queue.length) return null;
    const cardId = this._queue.shift();
    const entry = {
      cardId,
      insertedAt: -1,
      firstTime: !this._answeredIds.has(cardId),
      answered: this._answered,
      known: this._known,
      unknown: this._unknown,
    };

    this._answered++;
    this._answeredIds.add(cardId);
    if (known) {
      this._known++;
      const n = this._counts.get(cardId) - 1;
      if (n > 0) this._counts.set(cardId, n);
      else this._counts.delete(cardId);
    } else {
      this._unknown++;
      // Comes back "a bit later": after `gap` other cards, or at the end of a shorter queue.
      const at = Math.min(this._gap, this._queue.length);
      this._queue.splice(at, 0, cardId);
      entry.insertedAt = at;
    }
    this._history.push(entry);
    return cardId;
  }

  /** Undo the last answer(). Returns the restored (current) card id, or null if nothing to undo. */
  undo() {
    const entry = this._history.pop();
    if (!entry) return null;
    const { cardId } = entry;
    if (entry.insertedAt >= 0) {
      this._queue.splice(entry.insertedAt, 1); // occurrence count unchanged (removed then put back)
    } else {
      this._counts.set(cardId, (this._counts.get(cardId) || 0) + 1);
    }
    this._queue.unshift(cardId);
    this._answered = entry.answered;
    this._known = entry.known;
    this._unknown = entry.unknown;
    if (entry.firstTime) this._answeredIds.delete(cardId);
    return cardId;
  }

  /**
   * Drop every occurrence of a card (e.g. deleted mid-session). The undo history is cleared when
   * it could reference the card, because it would no longer be exact. Returns true if anything changed.
   */
  remove(cardId) {
    const inQueue = this._counts.has(cardId);
    const inHistory = this._history.some((h) => h.cardId === cardId);
    if (!inQueue && !inHistory) return false;
    if (inQueue) {
      this._queue = this._queue.filter((id) => id !== cardId);
      this._counts.delete(cardId);
    }
    this._history = [];
    return true;
  }

  /** Plain, JSON-serialisable copy of the whole state (queue, stats and undo history). */
  snapshot() {
    return {
      gap: this._gap,
      queue: this._queue.slice(),
      answeredIds: [...this._answeredIds],
      answered: this._answered,
      known: this._known,
      unknown: this._unknown,
      history: this._history.map((h) => ({ ...h })),
    };
  }

  /** Restore a state produced by snapshot(). */
  restore(s) {
    if (!s || !Array.isArray(s.queue)) throw new Error('Instantané de session invalide');
    if (Number.isFinite(s.gap) && s.gap >= 0) this._gap = Math.floor(s.gap);
    this._reset(s.queue.filter((id) => id != null));
    this._answeredIds = new Set(Array.isArray(s.answeredIds) ? s.answeredIds : []);
    this._answered = toCount(s.answered);
    this._known = toCount(s.known);
    this._unknown = toCount(s.unknown);
    this._history = Array.isArray(s.history) ? s.history.map((h) => ({ ...h })) : [];
    return this;
  }
}
