// Unit tests for app/js/srs.js (scheduling, queue, stats, Session).
// Run: node --test tests/unit/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERVALS,
  MAX_LEVEL,
  MASTERED_LEVEL,
  REINSERT_GAP,
  answer,
  buildQueue,
  remainingNewToday,
  methodStats,
  Session,
} from '../../app/js/srs.js';
import { addDays } from '../../app/js/util.js';

const TODAY = '2026-11-23';
const NOW = 1_795_000_000_000;

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cardsOf = (...ids) => ids.map((id) => ({ id, folderId: 'f' }));
const prog = (over) => ({
  level: 1,
  status: 'review',
  dueDay: TODAY,
  reps: 1,
  lapses: 0,
  lastDay: addDays(TODAY, -1),
  lastAnsweredAt: NOW - 86400000,
  ...over,
});

/** Answer the session's current card and return its id. */
function step(session, known) {
  const id = session.current;
  session.answer(known);
  return id;
}

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

describe('constants', () => {
  test('values match the spec', () => {
    assert.deepEqual([...INTERVALS], [0, 1, 3, 7, 14, 30, 60, 120]);
    assert.equal(MAX_LEVEL, 7);
    assert.equal(MASTERED_LEVEL, 4);
    assert.equal(REINSERT_GAP, 4);
    assert.equal(INTERVALS.length, MAX_LEVEL + 1);
  });
});

/* ------------------------------------------------------------------------ */
/* answer()                                                                 */
/* ------------------------------------------------------------------------ */

describe('answer()', () => {
  test('new card known → level 1, review, due tomorrow', () => {
    const r = answer(null, true, TODAY, NOW);
    assert.deepEqual(r, {
      level: 1,
      status: 'review',
      dueDay: '2026-11-24',
      reps: 1,
      lapses: 0,
      lastDay: TODAY,
      lastAnsweredAt: NOW,
    });
  });

  test('new card unknown → level 0, learning, due today, no lapse', () => {
    const r = answer(null, false, TODAY, NOW);
    assert.deepEqual(r, {
      level: 0,
      status: 'learning',
      dueDay: TODAY,
      reps: 1,
      lapses: 0,
      lastDay: TODAY,
      lastAnsweredAt: NOW,
    });
  });

  test('learning card known → level 1, review, due tomorrow', () => {
    const prev = prog({ level: 0, status: 'learning', reps: 3, lapses: 2 });
    const r = answer(prev, true, TODAY, NOW);
    assert.equal(r.level, 1);
    assert.equal(r.status, 'review');
    assert.equal(r.dueDay, addDays(TODAY, 1));
    assert.equal(r.reps, 4);
    assert.equal(r.lapses, 2);
  });

  test('learning card unknown → stays learning, no extra lapse', () => {
    const prev = prog({ level: 0, status: 'learning', reps: 2, lapses: 1 });
    const r = answer(prev, false, TODAY, NOW);
    assert.equal(r.level, 0);
    assert.equal(r.status, 'learning');
    assert.equal(r.dueDay, TODAY);
    assert.equal(r.reps, 3);
    assert.equal(r.lapses, 1);
  });

  test('review card unknown → back to learning and counts a lapse', () => {
    const prev = prog({ level: 5, status: 'review', reps: 7, lapses: 1, dueDay: '2026-11-20' });
    const r = answer(prev, false, TODAY, NOW);
    assert.equal(r.level, 0);
    assert.equal(r.status, 'learning');
    assert.equal(r.dueDay, TODAY);
    assert.equal(r.reps, 8);
    assert.equal(r.lapses, 2);
    assert.equal(r.lastDay, TODAY);
    assert.equal(r.lastAnsweredAt, NOW);
  });

  test('review card known climbs the full interval ladder and caps at MAX_LEVEL', () => {
    const expected = [
      [1, 1], // new → level 1 (+1 day)
      [2, 3],
      [3, 7],
      [4, 14],
      [5, 30],
      [6, 60],
      [7, 120],
      [7, 120], // capped
      [7, 120],
    ];
    let p = null;
    let day = TODAY;
    for (const [level, interval] of expected) {
      const r = answer(p, true, day, NOW);
      assert.equal(r.level, level);
      assert.equal(r.status, 'review');
      assert.equal(r.dueDay, addDays(day, interval));
      assert.equal(r.lapses, 0);
      p = r;
      day = r.dueDay; // answered exactly on the due day
    }
    assert.equal(p.reps, expected.length);
  });

  test('interval is counted from the answer day (late review)', () => {
    const prev = prog({ level: 2, status: 'review', dueDay: '2026-11-01' });
    const r = answer(prev, true, TODAY, NOW);
    assert.equal(r.level, 3);
    assert.equal(r.dueDay, addDays(TODAY, 7));
  });

  test('does not mutate prev and returns only the scheduling fields', () => {
    const prev = Object.freeze(prog({ id: 'm|c', methodId: 'm', cardId: 'c', level: 3 }));
    const r = answer(prev, true, TODAY, NOW);
    assert.equal(prev.level, 3);
    assert.deepEqual(Object.keys(r).sort(), ['dueDay', 'lapses', 'lastAnsweredAt', 'lastDay', 'level', 'reps', 'status']);
  });

  test('tolerates partial / odd progress records', () => {
    const r = answer({ status: 'review', level: 99 }, true, TODAY, NOW);
    assert.equal(r.level, MAX_LEVEL);
    assert.equal(r.reps, 1);
    assert.equal(r.lapses, 0);
    const r2 = answer({ status: 'review' }, false, TODAY, NOW);
    assert.equal(r2.lapses, 1);
  });

  test('month and year boundaries use calendar arithmetic', () => {
    assert.equal(answer(null, true, '2026-12-31', NOW).dueDay, '2027-01-01');
    assert.equal(answer(prog({ level: 6 }), true, '2026-12-31', NOW).dueDay, addDays('2026-12-31', 120));
  });
});

/* ------------------------------------------------------------------------ */
/* Multi-day scenario                                                       */
/* ------------------------------------------------------------------------ */

describe('simulated multi-day scenario', () => {
  test('lapses accounting and schedule over several days', () => {
    const d0 = '2026-11-23';
    // Day 0: new card, failed twice, then known.
    let p = answer(null, false, d0, NOW);
    p = answer(p, false, d0, NOW);
    assert.equal(p.lapses, 0, 'failing a learning card is not a lapse');
    p = answer(p, true, d0, NOW);
    assert.deepEqual([p.level, p.status, p.dueDay, p.reps], [1, 'review', '2026-11-24', 3]);

    // Day 1: known → level 2 (+3).
    p = answer(p, true, '2026-11-24', NOW);
    assert.deepEqual([p.level, p.dueDay], [2, '2026-11-27']);

    // Day 4: forgotten → lapse, learning, due the same day.
    p = answer(p, false, '2026-11-27', NOW);
    assert.deepEqual([p.level, p.status, p.dueDay, p.lapses], [0, 'learning', '2026-11-27', 1]);
    // Failed again the same day: still one lapse.
    p = answer(p, false, '2026-11-27', NOW);
    assert.equal(p.lapses, 1);
    // Known later that day → back to level 1, due tomorrow.
    p = answer(p, true, '2026-11-27', NOW);
    assert.deepEqual([p.level, p.status, p.dueDay], [1, 'review', '2026-11-28']);

    // Then the ladder again.
    p = answer(p, true, '2026-11-28', NOW);
    assert.deepEqual([p.level, p.dueDay], [2, '2026-12-01']);
    p = answer(p, true, '2026-12-01', NOW);
    assert.deepEqual([p.level, p.dueDay], [3, '2026-12-08']);
    p = answer(p, true, '2026-12-08', NOW);
    assert.deepEqual([p.level, p.dueDay], [4, '2026-12-22']);

    // Forgotten from level 4 → second lapse.
    p = answer(p, false, '2026-12-22', NOW);
    assert.equal(p.lapses, 2);
    assert.equal(p.reps, 11);
  });

  test('daily queues over a week with a mixed deck', () => {
    const cards = cardsOf('a', 'b', 'c', 'd', 'e', 'f');
    const progress = new Map();
    const method = { newPerDay: 2, newToday: { day: '', count: 0 } };
    let day = '2026-11-23';
    const seenNewByDay = [];

    for (let d = 0; d < 7; d++) {
      const newLimit = remainingNewToday(method, day);
      const { queue, newCount } = buildQueue({ cards, progressByCard: progress, today: day, newLimit, rng: seeded(d + 1) });
      seenNewByDay.push(newCount);
      const session = new Session(queue);
      // 'c' is always forgotten on first try each time it is asked, then known.
      const failedOnce = new Set();
      let guard = 0;
      while (!session.done && guard++ < 100) {
        const id = session.current;
        const known = !(id === 'c' && !failedOnce.has(id));
        if (!known) failedOnce.add(id);
        const prev = progress.get(id) || null;
        if (!prev) {
          if (method.newToday.day !== day) method.newToday = { day, count: 0 };
          method.newToday.count++;
        }
        progress.set(id, answer(prev, known, day, NOW));
        session.answer(known);
      }
      assert.ok(session.done);
      // Nothing is due any more today after a full session.
      assert.equal(buildQueue({ cards, progressByCard: progress, today: day, newLimit: 0 }).queue.length, 0);
      day = addDays(day, 1);
    }

    // 2 new cards per day: a+b on day 0, c+d on day 1, e+f on day 2, none afterwards.
    assert.deepEqual(seenNewByDay, [2, 2, 2, 0, 0, 0, 0]);
    // Every card has been seen and is in review.
    for (const c of cards) assert.equal(progress.get(c.id).status, 'review');
    // 'c' was forgotten on its first review (day 1 new → learning fail, no lapse), then on its
    // next review days (each a lapse).
    assert.ok(progress.get('c').lapses >= 1);
    assert.equal(progress.get('a').lapses, 0);
  });
});

/* ------------------------------------------------------------------------ */
/* buildQueue()                                                             */
/* ------------------------------------------------------------------------ */

describe('buildQueue()', () => {
  const cards = cardsOf('n1', 'r1', 'n2', 'l1', 'r2', 'n3', 'f1', 'n4');
  const progressByCard = new Map([
    ['r1', prog({ dueDay: '2026-11-20' })], // overdue
    ['r2', prog({ dueDay: TODAY })], // due today
    ['l1', prog({ level: 0, status: 'learning', dueDay: TODAY })], // failed earlier today
    ['f1', prog({ level: 3, dueDay: '2026-11-30' })], // future
  ]);

  test('due cards first (shuffled), then new cards in course order', () => {
    const r = buildQueue({ cards, progressByCard, today: TODAY, newLimit: Infinity, rng: seeded(42) });
    assert.equal(r.dueCount, 3);
    assert.equal(r.newCount, 4);
    assert.equal(r.newAvailable, 4);
    assert.deepEqual(r.queue.slice(0, 3).sort(), ['l1', 'r1', 'r2']);
    assert.deepEqual(r.queue.slice(3), ['n1', 'n2', 'n3', 'n4']);
    assert.ok(!r.queue.includes('f1'), 'future cards are not due');
  });

  test('deterministic with an injected rng; due order depends on it', () => {
    const a = buildQueue({ cards, progressByCard, today: TODAY, newLimit: Infinity, rng: seeded(7) });
    const b = buildQueue({ cards, progressByCard, today: TODAY, newLimit: Infinity, rng: seeded(7) });
    assert.deepEqual(a, b);
    const orders = new Set();
    for (let s = 1; s <= 30; s++) {
      orders.add(buildQueue({ cards, progressByCard, today: TODAY, newLimit: 0, rng: seeded(s) }).queue.join());
    }
    assert.ok(orders.size > 1, 'due cards are shuffled');
  });

  test('uses the rng exactly like util.shuffle (rng = () => 0)', () => {
    // Fisher–Yates with rng() = 0 always swaps a[i] with a[0]: [x, y, z] → [y, z, x].
    const r = buildQueue({ cards, progressByCard, today: TODAY, newLimit: 0, rng: () => 0 });
    assert.deepEqual(r.queue, ['l1', 'r2', 'r1']);
  });

  test('newLimit limits new cards but not due cards; newAvailable counts all new', () => {
    const r = buildQueue({ cards, progressByCard, today: TODAY, newLimit: 2, rng: seeded(1) });
    assert.equal(r.dueCount, 3);
    assert.equal(r.newCount, 2);
    assert.equal(r.newAvailable, 4);
    assert.deepEqual(r.queue.slice(3), ['n1', 'n2']);

    const zero = buildQueue({ cards, progressByCard, today: TODAY, newLimit: 0, rng: seeded(1) });
    assert.equal(zero.newCount, 0);
    assert.equal(zero.newAvailable, 4);
    assert.equal(zero.queue.length, 3);
  });

  test('shuffleNew picks new cards randomly among all new ones', () => {
    const many = cardsOf(...Array.from({ length: 20 }, (_, i) => `n${i}`));
    const r = buildQueue({ cards: many, progressByCard: new Map(), today: TODAY, newLimit: 5, shuffleNew: true, rng: seeded(3) });
    assert.equal(r.newCount, 5);
    assert.equal(r.newAvailable, 20);
    assert.equal(new Set(r.queue).size, 5);
    assert.notDeepEqual(r.queue, ['n0', 'n1', 'n2', 'n3', 'n4']);
    const again = buildQueue({ cards: many, progressByCard: new Map(), today: TODAY, newLimit: 5, shuffleNew: true, rng: seeded(3) });
    assert.deepEqual(again.queue, r.queue);
  });

  test('edge cases: empty input, missing map, odd limits, duplicate ids', () => {
    assert.deepEqual(buildQueue({ cards: [], progressByCard: new Map(), today: TODAY, newLimit: 10 }), {
      queue: [],
      dueCount: 0,
      newCount: 0,
      newAvailable: 0,
    });
    const noMap = buildQueue({ cards: cardsOf('a', 'b'), progressByCard: null, today: TODAY, newLimit: Infinity });
    assert.deepEqual(noMap.queue, ['a', 'b']);
    assert.equal(buildQueue({ cards: cardsOf('a', 'b'), today: TODAY, newLimit: null }).newCount, 2);
    assert.equal(buildQueue({ cards: cardsOf('a', 'b'), today: TODAY, newLimit: -3 }).newCount, 0);
    assert.equal(buildQueue({ cards: cardsOf('a', 'b'), today: TODAY, newLimit: 1.7 }).newCount, 1);
    const dup = buildQueue({ cards: cardsOf('a', 'a', 'b'), today: TODAY, newLimit: Infinity });
    assert.deepEqual(dup.queue, ['a', 'b']);
    // A progress record without due day is considered due (never silently lost).
    const odd = buildQueue({ cards: cardsOf('x'), progressByCard: new Map([['x', { level: 1, status: 'review' }]]), today: TODAY, newLimit: 0 });
    assert.deepEqual(odd.queue, ['x']);
  });
});

/* ------------------------------------------------------------------------ */
/* remainingNewToday()                                                      */
/* ------------------------------------------------------------------------ */

describe('remainingNewToday()', () => {
  test('null newPerDay = unlimited', () => {
    assert.equal(remainingNewToday({ newPerDay: null, newToday: { day: TODAY, count: 50 } }, TODAY), Infinity);
    assert.equal(remainingNewToday({ newToday: { day: '', count: 0 } }, TODAY), Infinity);
  });

  test('counter of another day is ignored', () => {
    assert.equal(remainingNewToday({ newPerDay: 20, newToday: { day: '2026-11-22', count: 20 } }, TODAY), 20);
    assert.equal(remainingNewToday({ newPerDay: 20, newToday: { day: '', count: 0 } }, TODAY), 20);
    assert.equal(remainingNewToday({ newPerDay: 20 }, TODAY), 20);
  });

  test('counts down during the day and never goes negative', () => {
    assert.equal(remainingNewToday({ newPerDay: 20, newToday: { day: TODAY, count: 7 } }, TODAY), 13);
    assert.equal(remainingNewToday({ newPerDay: 20, newToday: { day: TODAY, count: 20 } }, TODAY), 0);
    assert.equal(remainingNewToday({ newPerDay: 10, newToday: { day: TODAY, count: 30 } }, TODAY), 0);
    assert.equal(remainingNewToday({ newPerDay: 0, newToday: { day: '', count: 0 } }, TODAY), 0);
  });
});

/* ------------------------------------------------------------------------ */
/* methodStats()                                                            */
/* ------------------------------------------------------------------------ */

describe('methodStats()', () => {
  test('counts every category', () => {
    const tomorrow = addDays(TODAY, 1);
    const cards = cardsOf('n1', 'n2', 'l1', 'r1', 'r2', 'r3', 'r4', 'r5');
    const progressByCard = new Map([
      ['l1', prog({ level: 0, status: 'learning', dueDay: TODAY })],
      ['r1', prog({ level: 1, dueDay: '2026-11-22' })], // overdue
      ['r2', prog({ level: 2, dueDay: tomorrow })],
      ['r3', prog({ level: 4, dueDay: tomorrow })],
      ['r4', prog({ level: 7, dueDay: '2027-02-01' })],
      ['r5', prog({ level: 5, dueDay: '2026-12-10' })],
      ['ghost', prog({ level: 6 })], // progress of a card outside the method: ignored
    ]);
    const s = methodStats({ cards, progressByCard, today: TODAY });
    assert.deepEqual(s, {
      total: 8,
      new: 2,
      learning: 1,
      review: 5,
      mastered: 3,
      due: 2,
      dueTomorrow: 2,
      nextDueDay: tomorrow,
      byLevel: [1, 1, 1, 0, 1, 1, 0, 1],
    });
  });

  test('empty method and nothing scheduled in the future', () => {
    assert.deepEqual(methodStats({ cards: [], progressByCard: new Map(), today: TODAY }), {
      total: 0,
      new: 0,
      learning: 0,
      review: 0,
      mastered: 0,
      due: 0,
      dueTomorrow: 0,
      nextDueDay: null,
      byLevel: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    const s = methodStats({ cards: cardsOf('a'), progressByCard: new Map([['a', prog({ dueDay: TODAY })]]), today: TODAY });
    assert.equal(s.due, 1);
    assert.equal(s.nextDueDay, null);
  });

  test('nextDueDay is the smallest future due day', () => {
    const cards = cardsOf('a', 'b', 'c');
    const progressByCard = new Map([
      ['a', prog({ dueDay: '2026-12-15' })],
      ['b', prog({ dueDay: '2026-11-28' })],
      ['c', prog({ dueDay: '2026-12-01' })],
    ]);
    const s = methodStats({ cards, progressByCard, today: TODAY });
    assert.equal(s.nextDueDay, '2026-11-28');
    assert.equal(s.dueTomorrow, 0);
    assert.equal(s.due, 0);
  });
});

/* ------------------------------------------------------------------------ */
/* Session                                                                  */
/* ------------------------------------------------------------------------ */

describe('Session', () => {
  test('basic flow: all known', () => {
    const s = new Session(['a', 'b', 'c']);
    assert.equal(s.current, 'a');
    assert.equal(s.remaining, 3);
    assert.equal(s.done, false);
    assert.equal(s.canUndo, false);
    assert.equal(s.answer(true), 'a');
    assert.equal(s.current, 'b');
    s.answer(true);
    s.answer(true);
    assert.equal(s.done, true);
    assert.equal(s.current, null);
    assert.equal(s.remaining, 0);
    assert.deepEqual(s.stats, { answered: 3, known: 3, unknown: 0, distinct: 3 });
    assert.equal(s.answer(true), null, 'answering a finished session is a no-op');
    assert.deepEqual(s.stats, { answered: 3, known: 3, unknown: 0, distinct: 3 });
  });

  test('does not mutate the input queue', () => {
    const q = ['a', 'b'];
    const s = new Session(q);
    s.answer(false);
    s.answer(true);
    assert.deepEqual(q, ['a', 'b']);
  });

  test('a failed card comes back after `gap` other cards', () => {
    const s = new Session(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    s.answer(false); // a
    assert.deepEqual(s.queue, ['b', 'c', 'd', 'e', 'a', 'f', 'g']);
    assert.equal(s.remaining, 7, 'a failed card is still remaining');
    const order = [];
    while (!s.done) order.push(step(s, true));
    assert.deepEqual(order, ['b', 'c', 'd', 'e', 'a', 'f', 'g']);
  });

  test('a failed card goes to the end when fewer than `gap` cards remain', () => {
    const s = new Session(['a', 'b', 'c']);
    s.answer(false);
    assert.deepEqual(s.queue, ['b', 'c', 'a']);
  });

  test('the only card left comes back immediately, again and again until known', () => {
    const s = new Session(['a']);
    for (let i = 0; i < 5; i++) {
      assert.equal(s.answer(false), 'a');
      assert.equal(s.current, 'a');
      assert.equal(s.remaining, 1);
    }
    s.answer(true);
    assert.equal(s.done, true);
    assert.deepEqual(s.stats, { answered: 6, known: 1, unknown: 5, distinct: 1 });
  });

  test('repeated fails keep re-inserting the card', () => {
    const s = new Session(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    const asked = [];
    let guard = 0;
    while (!s.done && guard++ < 100) {
      const id = s.current;
      asked.push(id);
      // 'a' is failed 3 times before being known.
      const fails = asked.filter((x) => x === 'a').length;
      s.answer(!(id === 'a' && fails <= 3));
    }
    const positions = asked.map((x, i) => (x === 'a' ? i : -1)).filter((i) => i >= 0);
    // gap of 4 cards between occurrences; the third time only j is left, so a goes after it.
    assert.deepEqual(positions, [0, 5, 10, 12]);
    assert.equal(asked.length, 13);
    assert.deepEqual(s.stats, { answered: 13, known: 10, unknown: 3, distinct: 10 });
  });

  test('custom gap', () => {
    const s = new Session(['a', 'b', 'c', 'd'], { gap: 1 });
    s.answer(false);
    assert.deepEqual(s.queue, ['b', 'a', 'c', 'd']);
    const s0 = new Session(['a', 'b'], { gap: 0 });
    s0.answer(false);
    assert.equal(s0.current, 'a');
    assert.equal(new Session([], { gap: -2 }).gap, REINSERT_GAP);
  });

  test('remaining counts distinct ids', () => {
    const s = new Session(['a', 'b', 'a', 'c']);
    assert.equal(s.remaining, 3);
    s.answer(true); // first 'a'
    assert.equal(s.remaining, 3, "'a' is still queued once");
    s.answer(true); // b
    s.answer(true); // a
    assert.equal(s.remaining, 1);
    assert.equal(s.current, 'c');
  });

  test('undo after a known answer restores queue and stats exactly', () => {
    const s = new Session(['a', 'b', 'c']);
    const before = { queue: s.queue, stats: s.stats, remaining: s.remaining };
    s.answer(true);
    assert.equal(s.canUndo, true);
    assert.equal(s.undo(), 'a');
    assert.deepEqual({ queue: s.queue, stats: s.stats, remaining: s.remaining }, before);
    assert.equal(s.current, 'a');
    assert.equal(s.canUndo, false);
    assert.equal(s.undo(), null);
  });

  test('undo after an unknown answer restores queue and stats exactly', () => {
    const s = new Session(['a', 'b', 'c', 'd', 'e', 'f']);
    s.answer(true); // a
    const before = { queue: s.queue, stats: s.stats, remaining: s.remaining };
    s.answer(false); // b → reinserted
    assert.deepEqual(s.queue, ['c', 'd', 'e', 'f', 'b']);
    assert.equal(s.undo(), 'b');
    assert.deepEqual({ queue: s.queue, stats: s.stats, remaining: s.remaining }, before);
  });

  test('undo of a long mixed history replays back to the start', () => {
    const initial = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const s = new Session(initial);
    const rng = seeded(9);
    const states = [];
    for (let i = 0; i < 30 && !s.done; i++) {
      states.push({ queue: s.queue, stats: s.stats, remaining: s.remaining });
      s.answer(rng() < 0.6);
    }
    while (s.canUndo) {
      s.undo();
      assert.deepEqual({ queue: s.queue, stats: s.stats, remaining: s.remaining }, states.pop());
    }
    assert.equal(states.length, 0);
    assert.deepEqual(s.queue, initial);
    assert.deepEqual(s.stats, { answered: 0, known: 0, unknown: 0, distinct: 0 });
  });

  test('distinct counts cards answered at least once (undo-aware)', () => {
    const s = new Session(['a', 'b']);
    s.answer(false); // a
    s.answer(false); // b
    assert.equal(s.stats.distinct, 2);
    s.answer(false); // a again
    assert.equal(s.stats.distinct, 2);
    s.undo();
    assert.equal(s.stats.distinct, 2, 'a was answered before');
    s.undo();
    assert.equal(s.stats.distinct, 1);
    s.undo();
    assert.equal(s.stats.distinct, 0);
  });

  test('stats getter returns a copy', () => {
    const s = new Session(['a']);
    const st = s.stats;
    st.known = 99;
    assert.equal(s.stats.known, 0);
  });

  test('remove() drops every occurrence', () => {
    const s = new Session(['a', 'b', 'a', 'c', 'b']);
    assert.equal(s.remove('b'), true);
    assert.deepEqual(s.queue, ['a', 'a', 'c']);
    assert.equal(s.remaining, 2);
    assert.equal(s.remove('zzz'), false);
    assert.equal(s.remove('a'), true);
    assert.equal(s.current, 'c');
    assert.equal(s.remove('c'), true);
    assert.equal(s.done, true);
  });

  test('remove() of the current card / a re-inserted card mid-session', () => {
    const s = new Session(['a', 'b', 'c', 'd', 'e', 'f']);
    s.answer(false); // a → after e
    assert.equal(s.remove('a'), true);
    assert.deepEqual(s.queue, ['b', 'c', 'd', 'e', 'f']);
    assert.equal(s.canUndo, false, 'history referencing the removed card is cleared');
    s.answer(true); // b
    assert.equal(s.remove('b'), true, 'a card only present in the history is handled');
    assert.equal(s.canUndo, false);
    assert.deepEqual(s.queue, ['c', 'd', 'e', 'f']);
    assert.deepEqual(s.stats, { answered: 2, known: 1, unknown: 1, distinct: 2 }, 'stats keep what happened');
  });

  test('snapshot() / restore() round-trip, including undo history', () => {
    const s = new Session(['a', 'b', 'c', 'd', 'e', 'f'], { gap: 2 });
    s.answer(false);
    s.answer(true);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const t = new Session([]).restore(snap);
    assert.equal(t.gap, 2);
    assert.deepEqual(t.queue, s.queue);
    assert.deepEqual(t.stats, s.stats);
    assert.equal(t.remaining, s.remaining);
    assert.equal(t.undo(), 'b');
    assert.equal(t.undo(), 'a');
    assert.deepEqual(t.queue, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(t.stats, { answered: 0, known: 0, unknown: 0, distinct: 0 });
    // The original is unaffected.
    assert.deepEqual(s.stats, { answered: 2, known: 1, unknown: 1, distinct: 2 });
    assert.throws(() => new Session([]).restore(null));
  });

  test('empty session', () => {
    const s = new Session([]);
    assert.equal(s.done, true);
    assert.equal(s.current, null);
    assert.equal(s.remaining, 0);
    assert.equal(s.canUndo, false);
    assert.equal(s.undo(), null);
    assert.equal(new Session(undefined).done, true);
  });
});
