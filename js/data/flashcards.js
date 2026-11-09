/**
 * flashcards.js: flashcards and the quiz. Pure functions: they take a list and return a new one.
 *
 * A card: { id, term, def, review, right, wrong, lastSeen, box, due }
 *   review  true when it needs another look: you marked it, or missed it in a quiz
 *   right, wrong  how many times it went each way in a quiz
 *   box, due  when it should come back, for spaced repetition: see review.js
 */
import { isDateStr, toDateStr } from './dates.js';
import { nextReview } from './review.js';
import { uid } from './schema.js';

export function createCard(term = '', def = '') {
  return {
    id: uid(), term, def, review: false, right: 0, wrong: 0, lastSeen: null, box: 0, due: '',
  };
}

/** Rebuilds a card list from untrusted data. Anything unusable is dropped. */
export function normalizeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const cards = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      let id = typeof item.id === 'string' && item.id ? item.id : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      cards.push({
        id,
        term: typeof item.term === 'string' ? item.term : '',
        def: typeof item.def === 'string' ? item.def : '',
        review: item.review === true,
        right: Number.isInteger(item.right) && item.right >= 0 ? item.right : 0,
        wrong: Number.isInteger(item.wrong) && item.wrong >= 0 ? item.wrong : 0,
        lastSeen: Number.isFinite(item.lastSeen) ? item.lastSeen : null,
        box: Number.isInteger(item.box) && item.box >= 0 && item.box <= 5 ? item.box : 0,
        due: isDateStr(item.due) ? item.due : '',
      });
    }
  }
  return cards;
}

export const usableCards = (cards) => cards.filter((card) => card.term.trim() || card.def.trim());

/** Fisher-Yates. Takes the random source as an argument so tests are repeatable. */
export function shuffle(items, random = Math.random) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Records one answer on a card. Getting it right clears "needs review", missing it sets it, and
 * either way it's scheduled to come back (see review.js).
 */
export function recordAnswer(card, correct, now = Date.now()) {
  return {
    ...card,
    right: card.right + (correct ? 1 : 0),
    wrong: card.wrong + (correct ? 0 : 1),
    review: !correct,
    lastSeen: now,
    ...nextReview(card, correct, toDateStr(new Date(now))),
  };
}

/**
 * A quiz session over a list of entries ({ card, ... }). A missed card comes back later in the
 * same session, until it has been answered correctly. Cards marked for review go first.
 */
export function startQuiz(entries, random = Math.random) {
  const reviewFirst = (list) => [...list.filter((e) => e.card.review), ...list.filter((e) => !e.card.review)];
  return {
    queue: reviewFirst(shuffle(entries, random)),
    total: entries.length,
    done: 0,
    firstTry: 0,
    attempts: 0,
    missed: [],
    missedIds: new Set(),
  };
}

/** Applies an answer to the session and returns the next state. */
export function answerQuiz(session, correct) {
  const [current, ...rest] = session.queue;
  if (!current) return session;
  const next = {
    ...session,
    attempts: session.attempts + 1,
    missedIds: new Set(session.missedIds),
    missed: session.missed,
  };
  if (correct) {
    next.queue = rest;
    next.done = session.done + 1;
    if (!session.missedIds.has(current.card.id)) next.firstTry = session.firstTry + 1;
  } else {
    if (!next.missedIds.has(current.card.id)) {
      next.missedIds.add(current.card.id);
      next.missed = [...session.missed, current];
    }
    // Comes back after a few other cards, or last if there are few left.
    const at = Math.min(rest.length, 3);
    next.queue = [...rest.slice(0, at), current, ...rest.slice(at)];
  }
  return next;
}
