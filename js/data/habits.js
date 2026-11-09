/**
 * habits.js: daily habits, with no user interface.
 *
 * A Habit: { id, name, icon, order, done, created, updated }
 *   done  { "YYYY-MM-DD": true } for each day it was done. Days not done are simply absent.
 */
import { addDays, isDateStr } from './dates.js';
import { uid } from './schema.js';

const HISTORY_DAYS = 800;

export function createHabit({
  id = uid(), name, icon = '', order = 0, done = {}, now = Date.now(),
}) {
  return {
    id, name: String(name ?? '').trim().slice(0, 80) || 'Habit', icon: String(icon ?? '').trim().slice(0, 8), order, done, created: now, updated: now,
  };
}

/** Ticks or unticks one day. Very old days are let go so a habit never grows without limit. */
export function toggleHabitDay(habit, date, now = Date.now()) {
  const done = { ...habit.done };
  if (done[date]) delete done[date];
  else done[date] = true;
  const oldest = addDays(date, -HISTORY_DAYS);
  for (const day of Object.keys(done)) if (day < oldest) delete done[day];
  return { ...habit, done, updated: now };
}

/**
 * { current, longest }. Like the journal streak, today not done yet doesn't break the current
 * streak: it counts up to yesterday until the day is over.
 */
export function habitStreak(habit, today) {
  let current = 0;
  let cursor = habit.done[today] ? today : addDays(today, -1);
  while (habit.done[cursor]) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const day of Object.keys(habit.done).sort()) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest };
}

/** The last seven days, oldest first: [{ date, done }]. */
export function lastWeek(habit, today) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    return { date, done: Boolean(habit.done[date]) };
  });
}

export function cleanHabit(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128 || typeof raw.name !== 'string') return null;
  const done = {};
  if (raw.done && typeof raw.done === 'object' && !Array.isArray(raw.done)) {
    for (const [day, value] of Object.entries(raw.done)) if (value === true && isDateStr(day)) done[day] = true;
  }
  return {
    ...createHabit({
      id: raw.id, name: raw.name, icon: typeof raw.icon === 'string' ? raw.icon : '', order: Number.isFinite(raw.order) ? raw.order : 0, done, now,
    }),
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}
