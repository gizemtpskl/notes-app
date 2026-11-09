/**
 * reminders.js: which timetable reminders are due right now, with no user interface.
 *
 * A browser can only remind while the app is open, so this is asked every half minute by
 * views/reminders.js. Each reminder is shown once: the keys already shown are passed in.
 */
import { toMinutes } from './timetable.js';

/**
 * Occurrences today whose reminder time has come and that haven't started yet:
 * [{ key, title, start, location, minutes }], minutes being how long until the start.
 */
export function dueReminders(occurrences, blocks, { date, time }, shown = new Set()) {
  const now = toMinutes(time);
  const due = [];
  for (const o of occurrences) {
    const block = blocks.get(o.blockId);
    if (!block?.reminder || o.cancelled || o.date !== date || shown.has(o.key)) continue;
    const start = toMinutes(o.start);
    if (start - block.reminder <= now && now < start) {
      due.push({
        key: o.key, title: o.title, start: o.start, location: o.location, minutes: start - now,
      });
    }
  }
  return due;
}
