/**
 * weekly.js: what the weekly review looks at, and task counts for statistics. Pure.
 */
import { addDays, parseDate, toDateStr } from './dates.js';
import { fieldValue } from './fieldKinds.js';
import { flatten } from './tasks.js';
import { tasksFields } from './types.js';

/** The first day of the week containing a date. weekStart is 0 Sunday to 6 Saturday. */
export function weekStartOf(date, weekStart = 1) {
  const back = (parseDate(date).getDay() - weekStart + 7) % 7;
  return addDays(date, -back);
}

/**
 * When a task was completed: every time for a repeating one, and its finish date otherwise.
 * Returns timestamps.
 */
export function completionTimes(item) {
  const times = [...(item.history ?? [])];
  if (item.done && Number.isFinite(item.doneAt)) times.push(item.doneAt);
  return times;
}

/** Every completion in a list of notes: [{ at, text, noteId, noteTitle }]. */
export function completedTasks(notes, db) {
  const found = [];
  for (const note of notes) {
    const type = db.getType(note.typeId);
    for (const field of tasksFields(type)) {
      for (const { item } of flatten(fieldValue(note, field))) {
        for (const at of completionTimes(item)) {
          found.push({
            at, text: item.text, noteId: note.id, noteTitle: note.title,
          });
        }
      }
    }
  }
  return found.sort((a, b) => b.at - a.at);
}

/** Everything the review screen needs. */
export function weeklyReviewData(db, { now = Date.now(), weekStart = 1 } = {}) {
  const today = toDateStr(new Date(now));
  const start = weekStartOf(today, weekStart);
  const active = db.listNotes();
  // Journal entries and other private notes aren't filed or tagged by habit, so they don't nag here.
  const visible = active.filter((note) => !note.private);
  return {
    today,
    weekStartsOn: start,
    inboxCount: db.counts().inbox,
    noCollection: visible.filter((note) => note.spaceId && !note.collectionId),
    untagged: visible.filter((note) => note.spaceId && !note.tagIds.length),
    completed: completedTasks(active, db).filter((entry) => toDateStr(new Date(entry.at)) >= start),
    journalDays: new Set(active.filter((n) => n.typeId === 'journal').map((n) => n.fields?.date).filter((d) => d >= start)).size,
  };
}
