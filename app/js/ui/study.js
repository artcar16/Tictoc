// Study screen (scheduled sessions) and free practice (« Entraînement libre »).
// mode: 'study' (#/study/<methodId>), 'practice-method' (#/practice/method/<id>),
//       'practice-folder' (#/practice/folder/<id>).

import * as db from '../db.js';
import * as srs from '../srs.js';
import * as sel from '../selection.js';
import { studyDay, shuffle, plural } from '../util.js';
import { h, isTypingTarget, prefersReducedMotion } from '../dom.js';
import { icon } from './icons.js';
import { iconButton, serialQueue, showError, toast, isOverlayOpen, guard, emptyState } from './components.js';
import { mountFace } from './face.js';
import { openCardEditor } from './editor.js';
import { navigate, back, replaceHashQuietly } from './router.js';
import { nextReviewText, countNew } from './stats.js';

const SWIPE_RATIO = 0.3; // fraction of the card width that commits a swipe
const DOUBLE_TAP_MS = 300; // a tap this soon after an answer is a double tap, not « show the answer »

function enc(id) {
  return encodeURIComponent(id);
}

export async function renderStudy(root, ctx, mode) {
  const id = ctx.params.id;
  const scheduled = mode === 'study';
  root.classList.add('study-screen');

  /* ---------------------------------------------------------------- */
  /* Load                                                              */
  /* ---------------------------------------------------------------- */
  const [folders, cards] = await Promise.all([db.getFolders(), db.getCards()]);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  let method = null;
  let methodCards = [];
  let progressByCard = new Map();
  let title = '';
  let closeHash = '#/';
  let direction = 'front';

  if (mode === 'practice-folder') {
    const tree = sel.buildTree(folders, cards);
    const folder = tree.folderById.get(id);
    if (!folder) {
      if (ctx.alive()) {
        toast('Dossier introuvable');
        navigate('#/cards', { replace: true });
      }
      return;
    }
    const ids = new Set(sel.descendantFolderIds(id, tree));
    methodCards = sel.courseOrder(folders, cards, tree).filter((c) => ids.has(c.folderId));
    title = folder.name;
    closeHash = `#/cards/${enc(id)}`;
  } else {
    method = await db.getMethod(id);
    if (!method) {
      if (ctx.alive()) {
        toast('Méthode introuvable');
        navigate('#/', { replace: true });
      }
      return;
    }
    methodCards = sel.resolveMethodCards(method.rules || {}, folders, cards);
    direction = method.direction || 'front';
    title = method.name;
    closeHash = `#/method/${enc(id)}`;
    if (scheduled) {
      const list = await db.getProgressForMethod(id);
      for (const p of list) progressByCard.set(p.cardId, p);
    }
  }
  if (!ctx.alive()) return;

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */
  const persist = serialQueue(showError); // scheduled mode only: ordered DB writes
  const S = {
    session: null,
    total: 0, // distinct cards in the current session
    revealed: false,
    undo: [], // [{ cardId, prev, wasNew, newDay, first }]
    firstAnswers: new Map(), // cardId → known on its first answer of the session
    dirs: new Map(), // cardId → 'front'|'back' (mixed direction is fixed for the session)
    views: [], // mounted faces to destroy
    busy: false, // a swipe animation is running
    answeredAt: 0, // performance.now() of the last answer (double-tap protection)
  };

  /* ---------------------------------------------------------------- */
  /* Static layout                                                     */
  /* ---------------------------------------------------------------- */
  const counter = h('div', { class: 'study-counter' });
  const undoBtn = iconButton('undo', 'Annuler la dernière réponse', (e) => {
    doUndo();
    // After a tap/click, release the focus so Space/Enter drive the card, not « undo » again.
    if (e.detail) undoBtn.blur();
  });
  const editBtn = iconButton('edit', 'Modifier la carte', null);
  editBtn.addEventListener('click', guard(() => doEdit(), { busy: [] }));
  const progressFill = h('div', { class: 'study-progress-fill' });
  const stage = h('div', { class: 'study-stage' });
  const actions = h('footer', { class: 'study-actions' });

  root.append(
    h(
      'header',
      { class: 'study-top' },
      iconButton('close', 'Fermer', () => leave()),
      h(
        'div',
        { class: 'study-titles' },
        h('div', { class: 'study-name ellipsis' }, scheduled ? title : `Entraînement libre · ${title}`),
        counter,
      ),
      undoBtn,
      editBtn,
    ),
    h('div', { class: 'study-progress', 'aria-hidden': 'true' }, progressFill),
    stage,
    actions,
  );

  /** Leave the screen once pending progress writes are done (the next screen reads them). */
  async function leave(hash = null) {
    await persist.idle();
    if (!ctx.alive()) return;
    if (hash) navigate(hash, { replace: true });
    else back(closeHash);
  }

  /* ---------------------------------------------------------------- */
  /* Session lifecycle                                                 */
  /* ---------------------------------------------------------------- */
  function scheduledQueue(extraNew = 0, onlyExtra = false) {
    const today = studyDay();
    let newLimit = srs.remainingNewToday(method, today);
    if (onlyExtra) newLimit = extraNew;
    else if (extraNew) newLimit += extraNew;
    return srs.buildQueue({
      cards: methodCards,
      progressByCard,
      today,
      newLimit,
      shuffleNew: !!method.shuffleNew,
    }).queue;
  }

  function practiceQueue() {
    return shuffle(methodCards.map((c) => c.id));
  }

  function start(queue) {
    S.session = new srs.Session(queue.filter((cid) => cardById.has(cid)));
    S.total = S.session.remaining;
    S.undo = [];
    S.firstAnswers = new Map();
    S.revealed = false;
    renderCurrent();
  }

  function directionFor(cardId) {
    if (direction !== 'mixed') return direction;
    if (!S.dirs.has(cardId)) S.dirs.set(cardId, Math.random() < 0.5 ? 'front' : 'back');
    return S.dirs.get(cardId);
  }

  function destroyViews() {
    for (const v of S.views) v.destroy();
    S.views = [];
  }

  function updateTop() {
    const s = S.session;
    const remaining = s ? s.remaining : 0;
    counter.textContent = s && !s.done ? plural(remaining, 'restante') : 'Terminé';
    const pct = S.total ? Math.round(((S.total - remaining) / S.total) * 100) : 100;
    progressFill.style.width = `${pct}%`;
    undoBtn.disabled = !(S.undo.length && s && s.canUndo);
    editBtn.disabled = !(s && !s.done);
  }

  /* ---------------------------------------------------------------- */
  /* Card rendering                                                    */
  /* ---------------------------------------------------------------- */
  let cardEl = null;
  let innerEl = null;
  let hintNo = null;
  let hintYes = null;

  function renderCurrent({ animate = true } = {}) {
    destroyViews();
    const s = S.session;
    // Skip cards deleted meanwhile (Session.remove clears its undo history, so do we).
    while (!s.done && !cardById.has(s.current)) {
      s.remove(s.current);
      S.undo = [];
    }
    updateTop();
    if (s.done) {
      renderEnd();
      return;
    }
    const card = cardById.get(s.current);
    const dir = directionFor(card.id);
    const qFace = dir === 'back' ? card.back : card.front;
    const qView = mountFace(qFace);
    S.views.push(qView);

    // Colour veils shown while swiping (left = « je ne sais pas », right = « je sais »).
    hintNo = h(
      'div',
      { class: 'swipe-hint is-no', 'aria-hidden': 'true' },
      h('span', { class: 'swipe-label' }, icon('close', { size: 16, strokeWidth: 2.6 }), 'Je ne sais pas'),
    );
    hintYes = h(
      'div',
      { class: 'swipe-hint is-yes', 'aria-hidden': 'true' },
      h('span', { class: 'swipe-label' }, 'Je sais', icon('check', { size: 16, strokeWidth: 2.6 })),
    );
    innerEl = h(
      'div',
      { class: 'fc-inner' },
      h('section', { class: 'fc-q' }, h('div', { class: 'fc-side' }, dir === 'back' ? 'Verso' : 'Recto'), qView.el),
    );
    cardEl = h(
      'div',
      {
        class: ['flashcard', animate && !prefersReducedMotion() && 'is-entering'],
        role: 'button',
        tabindex: '0',
        'aria-label': 'Carte : touche pour la retourner',
      },
      h('div', { class: 'flashcard-scroll' }, innerEl),
      hintNo,
      hintYes,
    );
    cardEl.addEventListener('click', (e) => {
      if (S.revealed || e.target.closest('button, a, audio') || isDoubleTap(e)) return;
      reveal();
    });
    attachSwipe(cardEl);
    stage.replaceChildren(cardEl);
    if (S.revealed) reveal({ force: true, animate: false });
    else renderActions();
  }

  /** A pointer tap right after an answer lands on the next card's button: ignore it. */
  function isDoubleTap(e) {
    return !!(e && e.detail) && performance.now() - S.answeredAt < DOUBLE_TAP_MS;
  }

  function reveal({ force = false, animate = true } = {}) {
    const s = S.session;
    if (!s || s.done || (S.revealed && !force)) return;
    S.revealed = true;
    const card = cardById.get(s.current);
    const dir = directionFor(card.id);
    const aFace = dir === 'back' ? card.front : card.back;
    const aView = mountFace(aFace);
    S.views.push(aView);
    innerEl.append(
      h('div', { class: 'fc-divider' }),
      h('section', { class: ['fc-a', animate && !prefersReducedMotion() && 'is-appearing'] }, h('div', { class: 'fc-side' }, dir === 'back' ? 'Recto' : 'Verso'), aView.el),
    );
    cardEl.classList.add('is-revealed');
    cardEl.setAttribute('aria-label', 'Carte retournée : glisse à droite si tu sais, à gauche sinon');
    renderActions();
  }

  function renderActions() {
    if (!S.revealed) {
      actions.replaceChildren(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-xl btn-block',
            onClick: (e) => {
              if (!isDoubleTap(e)) reveal();
            },
          },
          'Afficher la réponse',
        ),
      );
      return;
    }
    actions.replaceChildren(
      h(
        'div',
        { class: 'answer-row' },
        h(
          'button',
          { type: 'button', class: 'btn btn-answer is-no', onClick: () => doAnswer(false) },
          icon('close', { size: 20, strokeWidth: 2.2 }),
          'Je ne sais pas',
        ),
        h(
          'button',
          { type: 'button', class: 'btn btn-answer is-yes', onClick: () => doAnswer(true) },
          icon('check', { size: 20, strokeWidth: 2.2 }),
          'Je sais',
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Answer / undo                                                     */
  /* ---------------------------------------------------------------- */
  function doAnswer(known) {
    const s = S.session;
    if (!s || s.done || !S.revealed) return;
    const cardId = s.current;
    const entry = { cardId, first: !S.firstAnswers.has(cardId), prev: null, wasNew: false, newDay: null };
    if (entry.first) S.firstAnswers.set(cardId, known);

    if (scheduled) {
      const today = studyDay();
      const prev = progressByCard.get(cardId) || null;
      const next = {
        ...srs.answer(prev, known, today, Date.now()),
        id: `${method.id}|${cardId}`,
        methodId: method.id,
        cardId,
      };
      progressByCard.set(cardId, next);
      entry.prev = prev;
      entry.wasNew = !prev;
      if (!prev) {
        const nt = method.newToday && method.newToday.day === today ? method.newToday : { day: today, count: 0 };
        method.newToday = { day: today, count: nt.count + 1 };
        entry.newDay = today;
        const newToday = method.newToday;
        persist(async () => {
          await db.putProgress(next);
          await db.updateMethod(method.id, { newToday });
        });
      } else {
        persist(() => db.putProgress(next));
      }
    }

    S.undo.push(entry);
    s.answer(known);
    S.answeredAt = performance.now();
    S.revealed = false;
    renderCurrent();
  }

  function doUndo() {
    const s = S.session;
    if (!s || !S.undo.length || !s.canUndo || S.busy) return;
    const entry = S.undo.pop();
    if (scheduled) {
      const { cardId, prev } = entry;
      if (prev) progressByCard.set(cardId, prev);
      else progressByCard.delete(cardId);
      let newToday = null;
      if (entry.wasNew && method.newToday && method.newToday.day === entry.newDay) {
        method.newToday = { day: entry.newDay, count: Math.max(0, method.newToday.count - 1) };
        newToday = method.newToday;
      }
      persist(async () => {
        if (prev) await db.putProgress(prev);
        else await db.deleteProgress(method.id, cardId);
        if (newToday) await db.updateMethod(method.id, { newToday });
      });
    }
    if (entry.first) S.firstAnswers.delete(entry.cardId);
    s.undo();
    // Show the restored card with its answer, ready to be re-graded.
    S.revealed = true;
    renderCurrent({ animate: false });
  }

  /* ---------------------------------------------------------------- */
  /* Edit current card                                                 */
  /* ---------------------------------------------------------------- */
  async function doEdit() {
    const s = S.session;
    if (!s || s.done) return;
    const cardId = s.current;
    await openCardEditor({ cardId });
    if (!ctx.alive()) return;
    // Focus went back to the ✎ button: release it so Space/Enter drive the card again.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    const fresh = await db.getCard(cardId);
    if (!ctx.alive()) return;
    if (!fresh) {
      cardById.delete(cardId);
      s.remove(cardId);
      S.undo = []; // the undo history may reference the deleted card
      S.revealed = false;
      renderCurrent();
      return;
    }
    cardById.set(cardId, fresh);
    if (s.current === cardId) renderCurrent({ animate: false });
  }

  /* ---------------------------------------------------------------- */
  /* Swipe gestures (revealed card only)                               */
  /* ---------------------------------------------------------------- */
  function attachSwipe(el) {
    let pid = null;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let axis = null;

    const setDrag = (x) => {
      const w = el.offsetWidth || 1;
      el.style.transform = `translateX(${x}px) rotate(${(x / w) * 9}deg)`;
      const p = Math.min(1, Math.abs(x) / (w * SWIPE_RATIO));
      hintNo.style.opacity = x < 0 ? String(p) : '0';
      hintYes.style.opacity = x > 0 ? String(p) : '0';
      el.classList.toggle('armed-no', x < 0 && p >= 1);
      el.classList.toggle('armed-yes', x > 0 && p >= 1);
    };

    const reset = () => {
      el.classList.remove('is-dragging', 'armed-no', 'armed-yes');
      el.style.transform = '';
      hintNo.style.opacity = '0';
      hintYes.style.opacity = '0';
    };

    el.addEventListener('pointerdown', (e) => {
      if (!S.revealed || S.busy || pid !== null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, a, audio, input, textarea')) return;
      pid = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      axis = null;
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (axis === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (axis === 'y') {
          pid = null; // let the card scroll vertically
          return;
        }
        try {
          el.setPointerCapture(pid);
        } catch {
          /* ignore */
        }
        el.classList.add('is-dragging');
      }
      dx = mx;
      setDrag(dx);
    });

    const finish = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (axis !== 'x') return;
      const w = el.offsetWidth || 1;
      if (e.type !== 'pointercancel' && Math.abs(dx) >= w * SWIPE_RATIO) {
        const known = dx > 0;
        if (prefersReducedMotion()) {
          reset();
          doAnswer(known);
          return;
        }
        S.busy = true;
        el.classList.remove('is-dragging');
        el.classList.add('is-flying');
        el.style.transform = `translateX(${known ? 130 : -130}%) rotate(${known ? 16 : -16}deg)`;
        el.style.opacity = '0';
        setTimeout(() => {
          S.busy = false;
          if (ctx.alive()) doAnswer(known);
        }, 200);
      } else {
        el.classList.remove('is-dragging');
        el.classList.add('is-returning');
        reset();
        setTimeout(() => el.classList.remove('is-returning'), 220);
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  /* ---------------------------------------------------------------- */
  /* End screen                                                        */
  /* ---------------------------------------------------------------- */
  function renderEnd() {
    S.revealed = false;
    const s = S.session;
    const stats = s.stats;
    const empty = S.total === 0;
    let firstKnown = 0;
    for (const v of S.firstAnswers.values()) if (v) firstKnown++;

    const buttons = [];
    const body = h('div', { class: 'end' });

    if (empty && !methodCards.length) {
      body.append(
        emptyState({
          iconName: mode === 'practice-folder' ? 'folder' : 'list',
          title: mode === 'practice-folder' ? 'Ce dossier est vide' : 'Aucune carte sélectionnée',
          text:
            mode === 'practice-folder'
              ? "Ajoute des cartes dans ce dossier pour pouvoir t'entraîner."
              : 'Choisis les dossiers ou les cartes de cette méthode pour commencer.',
        }),
      );
      if (mode !== 'practice-folder') {
        buttons.push(h('a', { class: 'btn btn-primary btn-block btn-lg', href: `#/method/${enc(id)}/select` }, 'Choisir les cartes'));
      }
    } else {
      const titleText = empty && scheduled ? "Rien à réviser pour aujourd'hui" : 'Session terminée';
      body.append(
        h('div', { class: 'end-icon' }, icon('check', { size: 30, strokeWidth: 2.4 })),
        h('h2', { class: 'end-title' }, `${titleText} `, h('span', { class: 'end-check' }, '✓')),
      );
      if (!empty) {
        body.append(
          h(
            'div',
            { class: 'end-stats' },
            h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(stats.distinct)), h('div', { class: 'stat-label' }, stats.distinct > 1 ? 'cartes révisées' : 'carte révisée')),
            h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(firstKnown)), h('div', { class: 'stat-label' }, '« je sais » du premier coup')),
          ),
        );
      }
      if (scheduled) {
        const next = nextReviewText(method, methodCards, progressByCard, studyDay());
        if (next) body.append(h('p', { class: 'end-next' }, icon('calendar', { size: 18 }), next));
      } else {
        body.append(h('p', { class: 'end-next muted' }, "Entraînement libre : ton planning de révision n'a pas changé."));
      }

      if (scheduled) {
        const newLeft = countNew(methodCards, progressByCard);
        if (newLeft > 0) {
          const n = Math.min(10, newLeft);
          buttons.push(
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary btn-block btn-lg',
                onClick: () => start(scheduledQueue(10, true)),
              },
              icon('plus', { size: 20 }),
              `+${n} ${n > 1 ? 'nouvelles cartes' : 'nouvelle carte'}`,
            ),
          );
        }
        if (methodCards.length) {
          buttons.push(
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary btn-block',
                onClick: () => leave(`#/practice/method/${enc(id)}`),
              },
              icon('shuffle', { size: 20 }),
              'Entraînement libre',
            ),
          );
        }
      } else if (methodCards.length) {
        buttons.push(
          h(
            'button',
            { type: 'button', class: 'btn btn-primary btn-block btn-lg', onClick: () => start(practiceQueue()) },
            icon('reset', { size: 20 }),
            'Recommencer',
          ),
        );
      }
    }
    buttons.push(h('button', { type: 'button', class: 'btn btn-ghost btn-block', onClick: () => leave() }, 'Retour'));

    stage.replaceChildren(body);
    actions.replaceChildren(h('div', { class: 'end-actions' }, buttons));
    updateTop();
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */
  const onKey = (e) => {
    if (!ctx.alive() || isOverlayOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target) || !S.session) return;
    const k = e.key;
    const isUndo = k === 'Backspace' || k === 'z' || k === 'Z';
    if (isUndo) {
      e.preventDefault();
      doUndo();
      return;
    }
    if (S.session.done || S.busy) return;
    // Space/Enter on a focused control keep their native meaning (activate it).
    const onControl = e.target instanceof Element && e.target.closest('button, a, select') && !e.target.closest('.flashcard');
    if (!S.revealed && !onControl && (k === ' ' || k === 'Enter')) {
      e.preventDefault();
      reveal();
    } else if (S.revealed && (k === 'ArrowLeft' || k === '1')) {
      e.preventDefault();
      doAnswer(false);
    } else if (S.revealed && (k === 'ArrowRight' || k === '2')) {
      e.preventDefault();
      doAnswer(true);
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    destroyViews();
  });

  /* ---------------------------------------------------------------- */
  /* Go                                                                */
  /* ---------------------------------------------------------------- */
  if (scheduled) {
    const more = Math.max(0, Math.min(100, Number(ctx.query.get('more')) || 0));
    // One-shot: a reload (or « forward ») must not grant extra new cards again.
    if (ctx.query.has('more')) replaceHashQuietly(`#/study/${enc(id)}`);
    start(scheduledQueue(more));
  } else {
    start(practiceQueue());
  }
}
