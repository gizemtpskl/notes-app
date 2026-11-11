/**
 * tasks.js: checklist logic. Every function is pure: it takes a list and returns a new one.
 *
 * A task: { id, text, done, doneAt, due, time, priority, repeat, anchorDay, lastDoneAt, history, children }
 *   due        "YYYY-MM-DD", or '' for none
 *   time       "HH:MM" on the due date, or '' for none
 *   priority   0 none, 1 low, 2 medium, 3 high
 *   repeat     null, 'daily', 'weekly' or 'monthly'
 *   anchorDay  the intended day of the month, so Jan 31 > Feb 28 > Mar 31 doesn't drift
 *   history    when a repeating task was completed, for the statistics page
 *   children   subtasks, one level deep
 *
 * Tasks live in a note field of kind "tasks", so any note type can have them.
 */
import { addDays, addMonths, isDateStr, parseDate } from './dates.js';
import { uid } from './schema.js';

export const PRIORITIES = Object.freeze([
  { value: 0, label: 'No priority' }, { value: 1, label: 'Low' }, { value: 2, label: 'Medium' }, { value: 3, label: 'High' },
]);
export const REPEATS = Object.freeze([
  { value: '', label: 'Does not repeat' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
]);
const HISTORY_LIMIT = 200;

export function createTask(text = '', props = {}) {
  return {
    id: uid(), text, done: false, doneAt: null, due: '', time: '', priority: 0, repeat: null, children: [], ...props,
  };
}

const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutesOf = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clockOfMinutes = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** The end a task should have once it starts at `time`, keeping its length; '' when it has none. */
export function movedEnd(item, time) {
  if (!item.end || !item.time || !time) return '';
  const length = minutesOf(item.end) - minutesOf(item.time);
  const end = minutesOf(time) + length;
  return length > 0 && end < 24 * 60 ? clockOfMinutes(end) : '';
}

/** "10:00–11:00", or just "10:00" for a task with no end. */
export function taskTimeLabel(item) {
  if (!item.time) return '';
  return item.end ? `${item.time}–${item.end}` : item.time;
}

/** Rebuilds a task list from untrusted data. Anything unusable is dropped or reset. */
export function normalizeTasks(raw, depth = 0, seen = new Set()) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      let id = typeof item.id === 'string' && item.id ? item.id : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      const nested = normalizeTasks(item.children, depth + 1, seen);
      const task = {
        id,
        text: typeof item.text === 'string' ? item.text : '',
        done: item.done === true,
        doneAt: Number.isFinite(item.doneAt) ? item.doneAt : null,
        due: isDateStr(item.due) ? item.due : '',
        time: isDateStr(item.due) && isTime(item.time) ? item.time : '',
        priority: [1, 2, 3].includes(item.priority) ? item.priority : 0,
        repeat: ['daily', 'weekly', 'monthly'].includes(item.repeat) ? item.repeat : null,
        children: depth === 0 ? nested : [],
      };
      // An end time, from "10:00-11:00": only with a start, and after it.
      if (task.time && isTime(item.end) && item.end > task.time) task.end = item.end;
      if (Number.isInteger(item.anchorDay)) task.anchorDay = item.anchorDay;
      if (Number.isFinite(item.lastDoneAt)) task.lastDoneAt = item.lastDoneAt;
      if (Array.isArray(item.history)) task.history = item.history.filter(Number.isFinite).slice(-HISTORY_LIMIT);
      clean.push(task);
      // Tasks nested too deeply are kept, one level up, rather than lost.
      if (depth > 0) clean.push(...nested);
    }
  }
  return clean;
}

/** Finds a task: { item, parent }, where parent is null at the top level. */
export function locate(items, id) {
  for (const item of items) {
    if (item.id === id) return { item, parent: null };
    for (const child of item.children) {
      if (child.id === id) return { item: child, parent: item };
    }
  }
  return null;
}

function replaceTask(items, id, fn) {
  return items.map((item) => {
    if (item.id === id) return fn(item);
    return item.children.some((c) => c.id === id)
      ? { ...item, children: replaceTask(item.children, id, fn) }
      : item;
  });
}

export function updateTask(items, id, patch) {
  return replaceTask(items, id, (item) => {
    const next = { ...item, ...patch };
    // A new due date is a new anchor for monthly repeats.
    if ('due' in patch) delete next.anchorDay;
    // A new start keeps the task's length, unless the change gives an end of its own.
    if ('time' in patch && !('end' in patch)) {
      const end = movedEnd(item, next.time);
      if (end) next.end = end;
      else delete next.end;
    }
    if (!next.end || !next.time || next.end <= next.time) delete next.end;
    return next;
  });
}

export function removeTask(items, id) {
  return items
    .filter((item) => item.id !== id)
    .map((item) => (item.children.some((c) => c.id === id)
      ? { ...item, children: item.children.filter((c) => c.id !== id) }
      : item));
}

function insertNear(items, targetId, task, position) {
  const index = items.findIndex((item) => item.id === targetId);
  if (index !== -1) {
    const next = [...items];
    next.splice(position === 'before' ? index : index + 1, 0, task);
    return next;
  }
  return items.map((item) => (item.children.some((c) => c.id === targetId)
    ? { ...item, children: insertNear(item.children, targetId, task, position) }
    : item));
}

export function insertTaskAfter(items, targetId, task) {
  return insertNear(items, targetId, task, 'after');
}

export function addSubtask(items, parentId, task) {
  return replaceTask(items, parentId, (item) => ({ ...item, children: [...item.children, task] }));
}

/**
 * Moves a task next to another one. A task with subtasks stays at the top level, because
 * nesting is one level deep. Moving a task next to its own subtask does nothing.
 */
export function moveRelative(items, id, targetId, position) {
  if (id === targetId) return items;
  const moving = locate(items, id);
  const target = locate(items, targetId);
  if (!moving || !target || target.parent?.id === id) return items;
  const anchorId = target.parent && moving.item.children.length ? target.parent.id : targetId;
  return insertNear(removeTask(items, id), anchorId, moving.item, position);
}

/** Moves a task up or down among its siblings. */
export function shiftTask(items, id, step) {
  const found = locate(items, id);
  if (!found) return items;
  const siblings = found.parent ? found.parent.children : items;
  const index = siblings.findIndex((t) => t.id === id);
  const neighbor = siblings[index + step];
  return neighbor ? moveRelative(items, id, neighbor.id, step < 0 ? 'before' : 'after') : items;
}

/** Makes a task a subtask of the one above it. Does nothing if that would nest too deep. */
export function indentTask(items, id) {
  const index = items.findIndex((t) => t.id === id);
  if (index < 1 || items[index].children.length) return items;
  const task = items[index];
  return addSubtask(removeTask(items, id), items[index - 1].id, task);
}

/** Moves a subtask up to the top level, just after its parent. */
export function outdentTask(items, id) {
  const found = locate(items, id);
  if (!found?.parent) return items;
  return insertNear(removeTask(items, id), found.parent.id, found.item, 'after');
}

/** The next date a repeating task is due, always after today, however late it was completed. */
export function nextOccurrence(task, today) {
  const start = task.due || today;
  const anchorDay = task.anchorDay ?? parseDate(start).getDate();
  let next = start;
  do {
    if (task.repeat === 'daily') next = addDays(next, 1);
    else if (task.repeat === 'weekly') next = addDays(next, 7);
    else next = addMonths(next, 1, anchorDay);
  } while (next <= today);
  return next;
}

/**
 * Ticks or unticks a task.
 *   - A repeating task moves to its next date instead of staying done.
 *   - Ticking a task ticks its subtasks.
 *   - Unticking a subtask unticks a parent that was marked done.
 */
export function toggleTask(items, id, { today, now = Date.now() }) {
  const found = locate(items, id);
  if (!found) return items;
  const { item, parent } = found;
  let next;
  if (item.done) {
    next = replaceTask(items, id, (t) => ({ ...t, done: false, doneAt: null }));
    if (parent?.done) next = replaceTask(next, parent.id, (t) => ({ ...t, done: false, doneAt: null }));
    return next;
  }
  if (item.repeat) {
    return replaceTask(items, id, (t) => ({
      ...t,
      due: nextOccurrence(t, today),
      anchorDay: t.repeat === 'monthly' ? t.anchorDay ?? parseDate(t.due || today).getDate() : t.anchorDay,
      lastDoneAt: now,
      history: [...(t.history ?? []), now].slice(-HISTORY_LIMIT),
      children: t.children.map((c) => ({ ...c, done: false, doneAt: null })),
    }));
  }
  return replaceTask(items, id, (t) => ({
    ...t,
    done: true,
    doneAt: now,
    children: t.children.map((c) => (c.done ? c : { ...c, done: true, doneAt: now })),
  }));
}

/** Every task, subtasks included: [{ item, parent }]. */
export function flatten(items) {
  const list = [];
  for (const item of items) {
    list.push({ item, parent: null });
    for (const child of item.children) list.push({ item: child, parent: item });
  }
  return list;
}

/** Progress counts the real work: a task with subtasks counts as its subtasks. */
export function progress(items) {
  let done = 0;
  let total = 0;
  for (const item of items) {
    const units = item.children.length ? item.children : [item];
    for (const unit of units) {
      total += 1;
      if (unit.done) done += 1;
    }
  }
  return { done, total, ratio: total ? done / total : 0 };
}

export function earliestDue(items) {
  let earliest = '';
  for (const { item } of flatten(items)) {
    if (!item.done && item.due && (!earliest || item.due < earliest)) earliest = item.due;
  }
  return earliest;
}

/**
 * Sorts entries ({ item, ... }) into the agenda tabs.
 * Open tasks sort by date, then time, with timed tasks first, then priority. Done tasks show the
 * most recent first.
 */
export function agendaBuckets(entries, today) {
  const buckets = { today: [], upcoming: [], overdue: [], done: [] };
  for (const entry of entries) {
    const { due, done } = entry.item;
    if (done) buckets.done.push(entry);
    else if (due === today) buckets.today.push(entry);
    else if (due && due < today) buckets.overdue.push(entry);
    else if (due) buckets.upcoming.push(entry);
  }
  const byDate = (a, b) => a.item.due.localeCompare(b.item.due)
    || (a.item.time || '99').localeCompare(b.item.time || '99')
    || b.item.priority - a.item.priority;
  buckets.today.sort(byDate);
  buckets.upcoming.sort(byDate);
  buckets.overdue.sort(byDate);
  buckets.done.sort((a, b) => (b.item.doneAt ?? 0) - (a.item.doneAt ?? 0));
  return buckets;
}
