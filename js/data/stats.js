/**
 * stats.js: numbers for the statistics page. Pure functions over the database.
 */
import { addDays, addMonths, formatDay, toDateStr } from './dates.js';
import { fieldValue } from './fieldKinds.js';
import { weekStartOf, completedTasks } from './weekly.js';

/** Notes in each space, biggest first, with the Inbox as its own row when it has any. */
export function notesPerSpace(db) {
  const { spaces, inbox } = db.counts();
  const rows = db.listSpaces().map((space) => ({ id: space.id, label: `${space.icon} ${space.name}`, value: spaces.get(space.id) ?? 0 }));
  rows.sort((a, b) => b.value - a.value);
  if (inbox) rows.push({ id: 'inbox', label: '📥 Inbox', value: inbox });
  return rows;
}

/** Tasks completed per week, oldest first, including weeks with none. */
export function tasksPerWeek(db, { weeks = 12, today = toDateStr(), weekStart = 1 } = {}) {
  const current = weekStartOf(today, weekStart);
  const buckets = new Map();
  for (let i = weeks - 1; i >= 0; i -= 1) buckets.set(addDays(current, -7 * i), 0);
  for (const { at } of completedTasks(db.listNotes({ status: 'all' }).filter((n) => !n.trashedAt), db)) {
    const week = weekStartOf(toDateStr(new Date(at)), weekStart);
    if (buckets.has(week)) buckets.set(week, buckets.get(week) + 1);
  }
  return [...buckets].map(([date, value]) => ({
    date,
    value,
    label: formatDay(date, { month: 'short', day: 'numeric' }),
    detail: `Week of ${formatDay(date, { month: 'long', day: 'numeric' })}`,
  }));
}

/** Things marked watched per month, oldest first, including months with none. */
export function watchedPerMonth(db, { months = 12, today = toDateStr() } = {}) {
  const start = `${today.slice(0, 7)}-01`;
  const buckets = new Map();
  for (let i = months - 1; i >= 0; i -= 1) buckets.set(addMonths(start, -i).slice(0, 7), 0);
  const type = db.getType('watchlist');
  const dateField = type.fields.find((f) => f.id === 'dateWatched');
  const statusField = type.fields.find((f) => f.id === 'status');
  for (const note of db.listNotes({ status: 'all' })) {
    if (note.typeId === 'watchlist' && !note.trashedAt && fieldValue(note, statusField) === 'Watched') {
      const month = (fieldValue(note, dateField) || toDateStr(new Date(note.updated))).slice(0, 7);
      if (buckets.has(month)) buckets.set(month, buckets.get(month) + 1);
    }
  }
  return [...buckets].map(([month, value]) => ({
    date: month,
    value,
    label: formatDay(`${month}-01`, { month: 'short' }),
    detail: formatDay(`${month}-01`, { month: 'long', year: 'numeric' }),
  }));
}

/** A round top for a chart's axis, and its tick marks. */
export function niceScale(max, tickCount = 4) {
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const rough = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return { top, ticks };
}
