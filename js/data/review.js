/**
 * review.js: spaced repetition for flashcards. Pure functions.
 *
 * Each card sits in a box, from 0 (new or just missed) up to 5. Answering right moves it up a box,
 * and it comes back after 1, 3, 7, 14, then 30 days. Missing it puts it back in box 0, due
 * tomorrow. A card that has never been reviewed is due straight away.
 *
 *   card.box  0 to 5
 *   card.due  "YYYY-MM-DD", or '' for a card never reviewed
 */
import { addDays } from './dates.js';

export const INTERVALS = Object.freeze([1, 3, 7, 14, 30]);

/** The box and due date after one answer. */
export function nextReview(card, correct, today) {
  if (!correct) return { box: 0, due: addDays(today, 1) };
  const box = Math.min((card.box ?? 0) + 1, INTERVALS.length);
  return { box, due: addDays(today, INTERVALS[box - 1]) };
}

export const isNew = (card) => !card.due;
export const isDue = (card, today) => !card.due || card.due <= today;

/**
 * What a list of entries ({ card, ... }) needs today: { due, fresh, next }. due holds every entry
 * due today, new ones included; fresh counts the new ones; next is the soonest later date, or ''.
 */
export function reviewQueue(entries, today) {
  const due = entries.filter((entry) => isDue(entry.card, today));
  const later = entries.map((entry) => entry.card.due).filter((d) => d && d > today).sort();
  return { due, fresh: due.filter((entry) => isNew(entry.card)).length, next: later[0] ?? '' };
}
