/**
 * focus.js: focus sessions, with no user interface. A session is time spent on one thing, logged
 * when the timer ends, so Stats and the dashboard can show where your hours went.
 *
 * A FocusSession: { id, label, start, minutes, date, blockId, noteId, collectionId, spaceId, created, updated }
 *   start         when it started, in ms
 *   date          its local day, "YYYY-MM-DD", so weeks can be counted without time zones
 *   blockId ...   what it was for: a timetable block, a note, a collection and its space. Any may be null.
 */
import { isDateStr } from './dates.js';
import { uid } from './schema.js';

export const FOCUS_LENGTHS = Object.freeze([25, 50, 90]);
export const MAX_FOCUS_MINUTES = 240;

const idOrNull = (value) => (typeof value === 'string' && value && value.length <= 128 ? value : null);

export function createFocusSession({
  id = uid(), label = '', start, minutes, date, blockId = null, noteId = null, collectionId = null, spaceId = null, now = Date.now(),
}) {
  return {
    id,
    label: String(label ?? '').trim().slice(0, 120),
    start,
    minutes: Math.max(1, Math.min(MAX_FOCUS_MINUTES, Math.round(minutes))),
    date,
    blockId: idOrNull(blockId),
    noteId: idOrNull(noteId),
    collectionId: idOrNull(collectionId),
    spaceId: idOrNull(spaceId),
    created: now,
    updated: now,
  };
}

export function cleanFocusSession(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !idOrNull(raw.id)) return null;
  if (!Number.isFinite(raw.start) || !Number.isFinite(raw.minutes) || raw.minutes < 1 || !isDateStr(raw.date)) return null;
  return {
    ...createFocusSession({ ...raw, label: typeof raw.label === 'string' ? raw.label : '', now }),
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}

/** Minutes spent between two dates, both included. */
export function focusMinutes(sessions, from, to) {
  let total = 0;
  for (const session of sessions) if (session.date >= from && session.date <= to) total += session.minutes;
  return total;
}

/**
 * Where the time went between two dates: [{ key, minutes }], most first. key is the collection,
 * or the space for a session without one, or '' for neither.
 */
export function focusByPlace(sessions, from, to) {
  const totals = new Map();
  for (const session of sessions) {
    if (session.date < from || session.date > to) continue;
    const key = session.collectionId ? `collection:${session.collectionId}` : session.spaceId ? `space:${session.spaceId}` : '';
    totals.set(key, (totals.get(key) ?? 0) + session.minutes);
  }
  return [...totals].map(([key, minutes]) => ({ key, minutes })).sort((a, b) => b.minutes - a.minutes);
}

/** "1 h 25 min", "45 min", "2 h". */
export function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}
