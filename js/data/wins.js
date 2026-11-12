/**
 * wins.js: what went well, with no user interface. Three things:
 *   - weekly goals on collections whose type fills in a date from a status, such as job
 *     applications ("Applied" fills Applied on): how many this week, against the goal
 *   - this week's wins for the dashboard: tasks done, focus time, journal and habit days,
 *     applications sent, notes written
 *   - milestones worth celebrating, each with a key that stays the same, so the app can celebrate
 *     each one once
 *
 * A collection's goal: collection.weeklyGoal, a whole number from 1 to MAX_WEEKLY_GOAL, or 0 for none.
 */
import { addDays, firstDayOfWeek, toDateStr } from './dates.js';
import { fieldValue } from './fieldKinds.js';
import { cleanFocusGoal, focusMinutes, formatMinutes } from './focus.js';
import { habitStreak } from './habits.js';
import { entryDate, streaks } from './journal.js';
import { flatten } from './tasks.js';
import { tasksFields } from './types.js';
import { completedTasks, weekStartOf } from './weekly.js';

export const MAX_WEEKLY_GOAL = 50;

/** The week's first day from the setting: Monday unless Settings names another day, like the timetable. */
export const weekStartFrom = (setting) => (!setting || setting === 'auto' ? 1 : firstDayOfWeek(setting));

const JOURNAL_STREAKS = [3, 7, 14, 30, 50, 100, 200, 365];
const HABIT_STREAKS = [7, 21, 30, 66, 100, 200, 365];
const SENT_COUNTS = [1, 5, 10, 25, 50, 100];
const FOCUS_HOURS = [1, 5, 10, 25, 50, 100, 250, 500];
const CLEAR_MIN_DONE = 3;

/** A type's name as a noun in a sentence: "job application", "PhD applications". */
export function typeNoun(name, count = 1) {
  // Only a plain capitalized first word is lowered, so PhD stays PhD.
  const word = /^[A-Z][a-z]*(\s|$)/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
  return count === 1 ? word : `${word}s`;
}

/** Keeps a goal to a whole number in range; anything else means no goal. */
export function cleanGoal(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WEEKLY_GOAL) : 0;
}

/**
 * The status option a type counts, and the date field it fills: { option, dateField, verb }, or
 * null for a type without one. Job applications: Applied, appliedOn, "sent".
 */
export function goalOf(type) {
  for (const field of type?.fields ?? []) {
    if (field.kind !== 'select' || !field.stamps) continue;
    for (const [option, dateId] of Object.entries(field.stamps)) {
      const dateField = type.fields.find((f) => f.id === dateId && f.kind === 'date');
      // "3 job applications applied" reads oddly, so Applied counts as sent.
      if (dateField) return { option, dateField, verb: option === 'Applied' ? 'sent' : option.toLowerCase() };
    }
  }
  return null;
}

/** Notes of a type whose stamped date falls between two dates, both included. */
function stampedBetween(notes, type, goal, from, to) {
  return notes.filter((note) => {
    if (note.typeId !== type.id || note.trashedAt) return false;
    const date = fieldValue(note, goal.dateField);
    return typeof date === 'string' && date >= from && date <= to;
  });
}

/**
 * A collection's progress this week: { goal, done, verb, from, to }, or null when its type
 * counts nothing. goal is 0 when none is set.
 */
export function goalProgress(db, collection, { today, weekStart = 1 }) {
  const type = db.getType(collection.defaultTypeId);
  const goal = goalOf(type);
  if (!goal) return null;
  const from = weekStartOf(today, weekStart);
  const to = addDays(from, 6);
  const notes = db.listNotes({ status: 'all', collectionId: collection.id });
  return {
    goal: cleanGoal(collection.weeklyGoal), done: stampedBetween(notes, type, goal, from, to).length, verb: goal.verb, from, to,
  };
}

/** This week's focus against the weekly focus goal: { goal, done, from, to }, in minutes. goal is 0 with none. */
export function focusGoalProgress(db, { today, weekStart = 1 }) {
  const from = weekStartOf(today, weekStart);
  const to = addDays(from, 6);
  return { goal: cleanFocusGoal(db.getSettings().focusGoal), done: focusMinutes(db.listFocusSessions(), from, to), from, to };
}

/** Days in a range, both included, up to today. */
function daysUpTo(from, to, today) {
  const days = [];
  for (let day = from; day <= to && day <= today; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * This week so far: { from, to, tasks, focus, journalDays, habitDays, habitPossible, sent, notes }.
 *   sent   [{ typeId, name, verb, count }] for each type with a goal, where something counted
 * Private notes count in the totals but are never named.
 */
export function weekWins(db, { today, weekStart = 1 }) {
  const from = weekStartOf(today, weekStart);
  const to = addDays(from, 6);
  const days = daysUpTo(from, to, today);
  const notes = db.listNotes({ status: 'all' }).filter((note) => !note.trashedAt);

  const tasks = completedTasks(notes, db).filter((entry) => {
    const date = toDateStr(new Date(entry.at));
    return date >= from && date <= to;
  }).length;

  const journalDays = new Set(notes.filter((note) => note.typeId === 'journal').map(entryDate).filter((date) => date >= from && date <= to)).size;

  const habits = db.listHabits();
  let habitDays = 0;
  for (const habit of habits) for (const day of days) if (habit.done[day]) habitDays += 1;

  const sent = [];
  for (const type of db.listTypes()) {
    const goal = goalOf(type);
    if (!goal) continue;
    const count = stampedBetween(notes, type, goal, from, to).length;
    if (count) sent.push({ typeId: type.id, name: type.name, verb: goal.verb, count });
  }

  const created = notes.filter((note) => {
    const date = toDateStr(new Date(note.created));
    return date >= from && date <= to && note.typeId !== 'journal';
  }).length;

  return {
    from,
    to,
    tasks,
    focus: focusMinutes(db.listFocusSessions(), from, to),
    journalDays,
    habitDays,
    habitPossible: habits.length * days.length,
    sent,
    notes: created,
  };
}

/** The first day of a streak that is `length` long and ends on `last`. */
const streakStart = (last, length) => addDays(last, 1 - length);

/**
 * Every milestone reached as of today: [{ key, kind, title, text, rank }]. A key names one
 * achievement for good, such as "a 7 day journal streak that started on 2026-11-05", so it
 * can be celebrated once. A new streak gets new keys. rank orders several at once, highest first.
 */
export function milestones(db, { today, weekStart = 1 }) {
  const found = [];
  const add = (key, kind, title, text, rank) => found.push({
    key, kind, title, text, rank,
  });
  const notes = db.listNotes({ status: 'all' }).filter((note) => !note.trashedAt);

  // Journal streak. It counts up to yesterday until today's entry is written, like the dashboard.
  const entries = notes.filter((note) => note.typeId === 'journal');
  const { current } = streaks(entries, today);
  if (current) {
    const last = entries.some((note) => entryDate(note) === today) ? today : addDays(today, -1);
    for (const length of JOURNAL_STREAKS) {
      if (current >= length) add(`journal:${length}:${streakStart(last, length)}`, 'journal', `${length} days of journaling in a row`, 'Showing up for yourself, day after day.', 40 + length / 10);
    }
  }

  // Habit streaks.
  for (const habit of db.listHabits()) {
    const { current: run } = habitStreak(habit, today);
    if (!run) continue;
    const last = habit.done[today] ? today : addDays(today, -1);
    for (const length of HABIT_STREAKS) {
      if (run >= length) add(`habit:${habit.id}:${length}:${streakStart(last, length)}`, 'habit', `${habit.icon ? `${habit.icon} ` : ''}${habit.name}: ${length} days in a row`, 'A habit in the making.', 35 + length / 10);
    }
  }

  // Everything due is done, after a day with real work in it.
  let open = 0;
  for (const note of notes) {
    if (note.archived) continue;
    for (const field of tasksFields(db.getType(note.typeId))) {
      for (const { item } of flatten(fieldValue(note, field))) if (!item.done && item.due && item.due <= today) open += 1;
    }
  }
  if (!open) {
    const doneToday = completedTasks(notes, db).filter((entry) => {
      return toDateStr(new Date(entry.at)) === today;
    }).length;
    if (doneToday >= CLEAR_MIN_DONE) add(`clear:${today}`, 'tasks', 'Everything due is done', `${doneToday} tasks finished today. Enjoy the rest of it.`, 30);
  }

  // Weekly goals reached.
  for (const collection of db.allCollections()) {
    if (!cleanGoal(collection.weeklyGoal)) continue;
    const progress = goalProgress(db, collection, { today, weekStart });
    if (progress && progress.done >= progress.goal) {
      add(`goal:${collection.id}:${progress.from}`, 'goal', `Weekly goal reached: ${progress.done} ${progress.verb}`, `${collection.name} is on track this week.`, 60);
    }
  }

  // Applications, and anything else with a stamped status, adding up.
  for (const type of db.listTypes()) {
    const goal = goalOf(type);
    if (!goal) continue;
    const total = notes.filter((note) => note.typeId === type.id && fieldValue(note, goal.dateField)).length;
    for (const count of SENT_COUNTS) {
      if (total >= count) {
        add(`sent:${type.id}:${count}`, 'sent', count === 1 ? `First ${typeNoun(type.name)} ${goal.verb}` : `${count} ${typeNoun(type.name, count)} ${goal.verb}`, count === 1 ? 'The first one is the hardest. Well done.' : 'Every one is a chance. Keep going.', 50 + count / 10);
      }
    }
  }

  // The weekly focus goal.
  const focusGoal = focusGoalProgress(db, { today, weekStart });
  if (focusGoal.goal && focusGoal.done >= focusGoal.goal) {
    add(`focusgoal:${focusGoal.from}`, 'focus', `Weekly focus goal reached: ${formatMinutes(focusGoal.done)}`, 'Deep work, week after week.', 58);
  }

  // Focus hours adding up.
  const hours = Math.floor(focusMinutes(db.listFocusSessions(), '0000-01-01', '9999-12-31') / 60);
  for (const count of FOCUS_HOURS) {
    if (hours >= count) add(`focus:${count}`, 'focus', count === 1 ? 'Your first hour of focus' : `${count} hours of focus`, 'Deep work, logged.', 45 + count / 100);
  }

  return found.sort((a, b) => b.rank - a.rank);
}
