/**
 * timetable.js: the weekly timetable's logic, with no user interface.
 *
 *   Semester ──< TimeBlock ──> Space / Collection / Note (all optional)
 *
 * A TimeBlock is one block of time, or a series that repeats weekly:
 *   {
 *     id, title, type,
 *     date        "YYYY-MM-DD": the day of a single block, or the first day of a series
 *     start, end  "HH:MM", local wall-clock time on that day. end is after start.
 *     repeat      null, or { days: [0..6, Sunday is 0], weeks, until }
 *                   weeks  'every', 'alternate' (every 2 weeks from the first week),
 *                          'odd' or 'even' (ISO week numbers)
 *                   until  "YYYY-MM-DD", or '' to keep repeating
 *     semesterId  '' or a Semester. A series only runs between the semester's start and end.
 *     spaceId, collectionId, noteId   links, or null
 *     color       '' to use the space's color, or one of SPACE_COLORS
 *     location, notes
 *     exceptions  { originalDate: change }, for one occurrence of a series:
 *                   { cancelled: true }, or any of { date, start, end, title, type, location, notes }
 *     reminder    null, or minutes before the start to remind (5, 10, 15, 30 or 60)
 *     task        null, or { noteId, fieldId, taskId }: a task given a time on the timetable
 *     sessions    { originalDate: noteId }: notes written for one session, such as a lecture
 *     uid         '' or the id an imported calendar event had, so importing twice is noticed
 *   }
 *
 * A Semester is { id, name, start, end }.
 *
 * DAYLIGHT SAVING: everything here is calendar dates and wall-clock times as plain strings, and
 * day counting is done in UTC. A class at 09:00 stays at 09:00 on the day the clocks change, and
 * every-other-week series never slip by a day. Only toInstant() turns a time into a real moment.
 *
 * TO EXTEND: add the field to createTimeBlock() and cleanTimeBlock(). Backups pick it up from there.
 */
import { addDays, isDateStr, parseDate } from './dates.js';
import { SPACE_COLORS, uid } from './schema.js';

export const BLOCK_TYPES = Object.freeze([
  { value: 'class', label: 'Class' },
  { value: 'work', label: 'Work shift' },
  { value: 'appointment', label: 'Appointment' },
  { value: 'study', label: 'Study session' },
  { value: 'personal', label: 'Personal' },
  { value: 'other', label: 'Other' },
]);

export const WEEK_RULES = Object.freeze([
  { value: 'every', label: 'Every week' },
  { value: 'alternate', label: 'Every 2 weeks' },
  { value: 'odd', label: 'Odd weeks' },
  { value: 'even', label: 'Even weeks' },
]);

export const REMINDERS = Object.freeze([5, 10, 15, 30, 60]);

export const DAY_MINUTES = 1440;
const FAR_FUTURE = '9999-12-31';
const OVERRIDE_KEYS = ['date', 'start', 'end', 'title', 'type', 'location', 'notes'];

// -- Times and days ------------------------------------------------------------------------

export const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function fromMinutes(total) {
  const clamped = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(total)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

const utcDay = (str) => {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** 0 Sunday to 6 Saturday. Worked out in UTC, so no time zone can move it. */
export const weekday = (str) => utcDay(str).getUTCDay();

/** The first day of the week holding this date. weekStart is 0 Sunday to 6 Saturday. */
export function startOfWeek(str, weekStart = 1) {
  return addDays(str, -((weekday(str) - weekStart + 7) % 7));
}

/** The ISO week number: weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(str) {
  const date = utcDay(str);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday - yearStart) / 86400000 / 7) + 1;
}

const weeksApart = (a, b) => Math.round((utcDay(startOfWeek(b, 1)) - utcDay(startOfWeek(a, 1))) / (7 * 86400000));

/** The real moment a date and wall-clock time refer to, here. */
export function toInstant(date, time) {
  const day = parseDate(date);
  const [hours, minutes] = time.split(':').map(Number);
  day.setHours(hours, minutes, 0, 0);
  return day;
}

export const blockMinutes = ({ start, end }) => toMinutes(end) - toMinutes(start);

// -- Records -------------------------------------------------------------------------------

export function createTimeBlock({
  id = uid(), title = '', type = 'other', date, start = '09:00', end = '10:00', repeat = null, semesterId = '',
  spaceId = null, collectionId = null, noteId = null, color = '', location = '', notes = '', exceptions = {},
  reminder = null, task = null, sessions = {}, uid: importedUid = '', now = Date.now(),
}) {
  return {
    id,
    title: String(title).trim() || 'Untitled block',
    type,
    date,
    start,
    end,
    repeat: repeat ? { days: repeat.days?.length ? [...new Set(repeat.days)].sort() : [weekday(date)], weeks: repeat.weeks ?? 'every', until: repeat.until ?? '' } : null,
    semesterId,
    spaceId,
    collectionId,
    noteId,
    color,
    location,
    notes,
    exceptions,
    reminder,
    task,
    sessions,
    uid: importedUid,
    created: now,
    updated: now,
  };
}

export function createSemester({
  id = uid(), name, start, end, now = Date.now(),
}) {
  return {
    id, name: String(name ?? '').trim() || 'Semester', start, end, created: now, updated: now,
  };
}

/** Plain-English problems with a block, or '' when it's fine. */
export function blockProblem({
  date, start, end, repeat,
}) {
  if (!isDateStr(date)) return 'Choose a day.';
  if (!isTime(start) || !isTime(end)) return 'Choose a start and an end time.';
  if (toMinutes(end) <= toMinutes(start)) return 'The end time needs to be after the start time.';
  if (repeat?.until && repeat.until < date) return 'The last day of the series is before its first day.';
  return '';
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const asTime = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

function cleanChange(raw) {
  if (!isObject(raw)) return null;
  if (raw.cancelled === true) return { cancelled: true };
  const change = {};
  if (isDateStr(raw.date)) change.date = raw.date;
  if (isTime(raw.start)) change.start = raw.start;
  if (isTime(raw.end)) change.end = raw.end;
  if (typeof raw.title === 'string') change.title = raw.title.slice(0, 300);
  if (BLOCK_TYPES.some((t) => t.value === raw.type)) change.type = raw.type;
  if (typeof raw.location === 'string') change.location = raw.location.slice(0, 300);
  if (typeof raw.notes === 'string') change.notes = raw.notes.slice(0, 5000);
  if (change.start && change.end && toMinutes(change.end) <= toMinutes(change.start)) return null;
  return Object.keys(change).length ? change : null;
}

/** Rebuilds a block from untrusted data, such as a backup file. Returns null if it can't be used. */
export function cleanTimeBlock(raw, now = Date.now()) {
  if (!isObject(raw) || !isId(raw.id) || !isDateStr(raw.date) || !isTime(raw.start) || !isTime(raw.end)) return null;
  if (toMinutes(raw.end) <= toMinutes(raw.start)) return null;
  let repeat = null;
  if (isObject(raw.repeat)) {
    const days = Array.isArray(raw.repeat.days) ? raw.repeat.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    repeat = {
      days,
      weeks: WEEK_RULES.some((rule) => rule.value === raw.repeat.weeks) ? raw.repeat.weeks : 'every',
      until: isDateStr(raw.repeat.until) && raw.repeat.until >= raw.date ? raw.repeat.until : '',
    };
  }
  const exceptions = {};
  if (isObject(raw.exceptions)) {
    for (const [day, change] of Object.entries(raw.exceptions)) {
      const clean = isDateStr(day) ? cleanChange(change) : null;
      if (clean) exceptions[day] = clean;
    }
  }
  const task = isObject(raw.task) && isId(raw.task.noteId) && isId(raw.task.fieldId) && isId(raw.task.taskId)
    ? { noteId: raw.task.noteId, fieldId: raw.task.fieldId, taskId: raw.task.taskId }
    : null;
  const sessions = {};
  if (isObject(raw.sessions)) {
    for (const [day, noteId] of Object.entries(raw.sessions)) if (isDateStr(day) && isId(noteId)) sessions[day] = noteId;
  }
  return {
    ...createTimeBlock({
      id: raw.id,
      reminder: REMINDERS.includes(raw.reminder) ? raw.reminder : null,
      task,
      sessions,
      uid: text(raw.uid, 300),
      title: text(raw.title, 300),
      type: BLOCK_TYPES.some((t) => t.value === raw.type) ? raw.type : 'other',
      date: raw.date,
      start: raw.start,
      end: raw.end,
      repeat,
      semesterId: isId(raw.semesterId) ? raw.semesterId : '',
      spaceId: isId(raw.spaceId) ? raw.spaceId : null,
      collectionId: isId(raw.collectionId) ? raw.collectionId : null,
      noteId: isId(raw.noteId) ? raw.noteId : null,
      color: SPACE_COLORS.includes(raw.color) ? raw.color : '',
      location: text(raw.location, 300),
      notes: text(raw.notes, 5000),
      exceptions,
      now,
    }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

export function cleanSemester(raw, now = Date.now()) {
  if (!isObject(raw) || !isId(raw.id) || !isDateStr(raw.start) || !isDateStr(raw.end) || raw.end < raw.start) return null;
  return {
    ...createSemester({
      id: raw.id, name: text(raw.name, 120), start: raw.start, end: raw.end, now,
    }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

// -- Occurrences ---------------------------------------------------------------------------

/** The first and last day a block can happen on, taking its semester into account. */
export function blockBounds(block, semesters = new Map()) {
  let first = block.date;
  let last = block.repeat ? (block.repeat.until || FAR_FUTURE) : block.date;
  const semester = block.repeat && block.semesterId ? semesters.get(block.semesterId) : null;
  if (semester) {
    if (semester.start > first) first = semester.start;
    if (semester.end < last) last = semester.end;
  }
  return { first, last };
}

/** Whether a series has an occurrence on this date, before any exception. */
export function occursOn(block, date, semesters = new Map()) {
  const { first, last } = blockBounds(block, semesters);
  if (date < first || date > last) return false;
  if (!block.repeat) return date === block.date;
  if (!block.repeat.days.includes(weekday(date))) return false;
  switch (block.repeat.weeks) {
    case 'alternate': return weeksApart(block.date, date) % 2 === 0;
    case 'odd': return isoWeek(date) % 2 === 1;
    case 'even': return isoWeek(date) % 2 === 0;
    default: return true;
  }
}

function occurrence(block, originalDate, change, spaces) {
  const own = change && !change.cancelled ? change : {};
  return {
    key: `${block.id}:${originalDate}`,
    blockId: block.id,
    originalDate,
    date: own.date ?? originalDate,
    start: own.start ?? block.start,
    end: own.end ?? block.end,
    title: own.title ?? block.title,
    type: own.type ?? block.type,
    location: own.location ?? block.location,
    notes: own.notes ?? block.notes,
    color: block.color || spaces?.get(block.spaceId)?.color || 'slate',
    spaceId: block.spaceId,
    collectionId: block.collectionId,
    noteId: block.noteId,
    repeating: Boolean(block.repeat),
    task: block.task ?? null,
    sessionNoteId: block.sessions?.[originalDate] ?? null,
    cancelled: change?.cancelled === true,
    changed: Boolean(change) && !change.cancelled,
  };
}

/**
 * Every occurrence between two dates, inclusive: [{ key, blockId, originalDate, date, start, end, ... }],
 * sorted by date, then time. An occurrence moved to another day appears on its new day.
 * Cancelled ones are included with cancelled: true, so they can be shown and brought back.
 */
export function occurrencesBetween(blocks, from, to, { semesters = new Map(), spaces = new Map() } = {}) {
  const list = [];
  for (const block of blocks) {
    const { first, last } = blockBounds(block, semesters);
    const exceptions = block.exceptions ?? {};
    // Days in range that keep their place, or are cancelled.
    const begin = first > from ? first : from;
    const finish = last < to ? last : to;
    for (let day = begin; day <= finish; day = addDays(day, 1)) {
      if (occursOn(block, day, semesters)) {
        const change = exceptions[day];
        const moved = change?.date && change.date !== day;
        if (!moved) list.push(occurrence(block, day, change, spaces));
      }
    }
    // Occurrences moved onto a day in range, from anywhere.
    for (const [original, change] of Object.entries(exceptions)) {
      if (change.date && change.date !== original && !change.cancelled && change.date >= from && change.date <= to && occursOn(block, original, semesters)) {
        list.push(occurrence(block, original, change, spaces));
      }
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/** The occurrence of a block that started on originalDate, or null. */
export function findOccurrence(block, originalDate, options = {}) {
  if (!occursOn(block, originalDate, options.semesters)) return null;
  return occurrence(block, originalDate, block.exceptions?.[originalDate], options.spaces);
}

/**
 * Moves one weekday of a series by `delta` days, for every week, such as Tuesdays to Wednesdays.
 * Weeks changed on their own move along with it, so they keep their changes. Returns the patch.
 */
export function shiftSeriesDay(block, fromDay, delta) {
  const toDay = (fromDay + delta + 7) % 7;
  const days = [...new Set(block.repeat.days.map((d) => (d === fromDay ? toDay : d)))].sort();
  const exceptions = {};
  for (const [original, change] of Object.entries(block.exceptions ?? {})) {
    exceptions[weekday(original) === fromDay ? addDays(original, delta) : original] = change;
  }
  // A first day that moves earlier would otherwise lose the first week.
  const date = weekday(block.date) === fromDay && delta < 0 ? addDays(block.date, delta) : block.date;
  return { date, repeat: { ...block.repeat, days }, exceptions };
}

/** The part of a change that differs from the series. An empty result means "same as the series". */
export function changeFromSeries(block, originalDate, values) {
  const series = {
    date: originalDate, start: block.start, end: block.end, title: block.title, type: block.type, location: block.location, notes: block.notes,
  };
  const change = {};
  for (const key of OVERRIDE_KEYS) {
    if (key in values && values[key] !== series[key]) change[key] = values[key];
  }
  return change;
}

// -- Conflicts and free time ---------------------------------------------------------------

const overlaps = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end;

/** Pairs of occurrences that overlap: [[a, b]]. Cancelled ones never conflict. */
export function findConflicts(occurrences) {
  const pairs = [];
  const live = occurrences.filter((o) => !o.cancelled);
  const byDay = new Map();
  for (const o of live) {
    if (!byDay.has(o.date)) byDay.set(o.date, []);
    byDay.get(o.date).push(o);
  }
  for (const day of byDay.values()) {
    day.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < day.length; i += 1) {
      for (let j = i + 1; j < day.length && day[j].start < day[i].end; j += 1) {
        if (overlaps(day[i], day[j])) pairs.push([day[i], day[j]]);
      }
    }
  }
  return pairs;
}

/** Occurrences among `others` that overlap any of `mine`, leaving out the same occurrences. */
export function conflictsWith(mine, others) {
  const own = new Set(mine.map((o) => o.key));
  const found = [];
  for (const other of others) {
    if (!other.cancelled && !own.has(other.key) && mine.some((o) => !o.cancelled && overlaps(o, other))) found.push(other);
  }
  return found;
}

/**
 * Gaps of at least minMinutes between dayStart and dayEnd on each date from `from` to `to`:
 * [{ date, start, end, minutes }]. With `now` ({ date, time }), time already past doesn't count.
 */
export function freeSlots(occurrences, {
  from, to, dayStart = '08:00', dayEnd = '20:00', minMinutes = 60, days = null, now = null,
}) {
  const slots = [];
  const open = toMinutes(dayStart);
  const close = toMinutes(dayEnd);
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (days && !days.includes(weekday(date))) continue;
    let cursor = open;
    if (now && date < now.date) continue;
    if (now && date === now.date) cursor = Math.max(cursor, toMinutes(now.time));
    const busy = occurrences
      .filter((o) => o.date === date && !o.cancelled)
      .map((o) => [toMinutes(o.start), toMinutes(o.end)])
      .sort((a, b) => a[0] - b[0]);
    for (const [start, end] of [...busy, [close, close]]) {
      const gapEnd = Math.min(start, close);
      if (gapEnd - cursor >= minMinutes) {
        slots.push({
          date, start: fromMinutes(cursor), end: fromMinutes(gapEnd), minutes: gapEnd - cursor,
        });
      }
      cursor = Math.max(cursor, end);
      if (cursor >= close) break;
    }
  }
  return slots;
}

/** Lays out one day's overlapping occurrences side by side: Map(key => { lane, lanes }). */
export function layoutDay(occurrences) {
  const placed = new Map();
  const sorted = [...occurrences].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  let group = [];
  let groupEnd = '';
  const close = () => {
    const lanes = Math.max(...group.map((o) => placed.get(o.key).lane)) + 1;
    for (const o of group) placed.get(o.key).lanes = lanes;
    group = [];
  };
  for (const o of sorted) {
    if (group.length && o.start >= groupEnd) close();
    const taken = new Set(group.filter((g) => g.end > o.start).map((g) => placed.get(g.key).lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.set(o.key, { lane, lanes: 1 });
    group.push(o);
    if (group.length === 1 || o.end > groupEnd) groupEnd = o.end;
  }
  if (group.length) close();
  return placed;
}

/**
 * Which session of a series this is, counting the ones not cancelled from the first: the lecture
 * number for a class. null for a block that doesn't repeat.
 */
export function sessionNumber(block, originalDate, semesters = new Map()) {
  if (!block.repeat || !occursOn(block, originalDate, semesters)) return null;
  const { first } = blockBounds(block, semesters);
  let count = 0;
  for (let day = first; day <= originalDate; day = addDays(day, 1)) {
    if (occursOn(block, day, semesters) && !block.exceptions?.[day]?.cancelled) count += 1;
  }
  return block.exceptions?.[originalDate]?.cancelled ? null : count;
}

/**
 * Hours in a range, for the weekly summary: { byType: [{ type, minutes }], bySpace: [{ spaceId, minutes }],
 * free }. free is the time between dayStart and dayEnd not taken by any block, overlaps counted once.
 */
export function weekSummary(occurrences, {
  from, to, dayStart = '08:00', dayEnd = '20:00',
}) {
  const live = occurrences.filter((o) => !o.cancelled && o.date >= from && o.date <= to);
  const add = (map, key, minutes) => map.set(key, (map.get(key) ?? 0) + minutes);
  const byType = new Map();
  const bySpace = new Map();
  for (const o of live) {
    add(byType, o.type, blockMinutes(o));
    add(bySpace, o.spaceId ?? null, blockMinutes(o));
  }
  const free = freeSlots(live, {
    from, to, dayStart, dayEnd, minMinutes: 1,
  }).reduce((sum, slot) => sum + slot.minutes, 0);
  const sorted = (map, key) => [...map.entries()].map(([k, minutes]) => ({ [key]: k, minutes })).sort((a, b) => b.minutes - a.minutes);
  return { byType: sorted(byType, 'type'), bySpace: sorted(bySpace, 'spaceId'), free };
}

/** A block's kind guessed from its title, such as "Deep Learning lecture" being a class. */
export function guessType(title) {
  return TYPE_WORDS.find(([, pattern]) => pattern.test(title))?.[0] ?? 'other';
}

// -- Right now -----------------------------------------------------------------------------

/**
 * Today's schedule as seen at one moment: { current, next, later }. current is the block under way
 * (the one that started last, if several are), next the first one still to start.
 */
export function scheduleAt(occurrences, date, time) {
  const today = occurrences.filter((o) => o.date === date && !o.cancelled).sort((a, b) => a.start.localeCompare(b.start));
  const running = today.filter((o) => o.start <= time && time < o.end);
  const upcoming = today.filter((o) => o.start > time);
  return { current: running.at(-1) ?? null, next: upcoming[0] ?? null, later: upcoming.slice(1) };
}

/** "in 40 minutes", "in 1 hour 15 minutes", or "at 18:15" when it's hours away. */
export function startsIn(fromTime, toTime) {
  const minutes = toMinutes(toTime) - toMinutes(fromTime);
  if (minutes <= 1) return 'now';
  if (minutes < 60) return `in ${minutes} minutes`;
  if (minutes >= 180) return `at ${toTime}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
}

// -- Quick add -----------------------------------------------------------------------------

const DAY_NAMES = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'],
  ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat'],
];
const TYPE_WORDS = [
  ['class', /\b(class|lecture|seminar|lab|tutorial|course)\b/i],
  ['work', /\b(shift|work)\b/i],
  ['study', /\b(study|revision|revise|homework)\b/i],
  ['appointment', /\b(appointment|dentist|doctor|meeting|interview)\b/i],
];
const CLOCK = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*([ap])?\\.?m?\\.?';
const RANGE = new RegExp(`(?:^|\\s)(?:from\\s+)?${CLOCK}\\s*(?:-|–|—|to|until)\\s*${CLOCK}(?=\\s|$|,)`, 'i');
const END = '(?=\\s|$|,)';
// One time, which needs a clear sign it's a time: "15:30", "at 3", "3pm", or "15.30" opening the line.
const SINGLES = [
  new RegExp(`(?:^|\\s)(?:at\\s+)?(\\d{1,2}):(\\d{2})\\s*(?:([ap])\\.?m\\.?)?${END}`, 'i'),
  new RegExp(`(?:^|\\s)at\\s+(\\d{1,2})(?:[.:](\\d{2}))?\\s*(?:([ap])\\.?m\\.?)?${END}`, 'i'),
  new RegExp(`(?:^|\\s)(\\d{1,2})(?:[.:](\\d{2}))?\\s*([ap])\\.?m\\.?${END}`, 'i'),
  new RegExp(`^\\s*(\\d{1,2})\\.(\\d{2})${END}`),
];

function clock(hours, minutes, half) {
  let h = Number(hours);
  const m = Number(minutes ?? 0);
  if (m > 59) return null;
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half.toLowerCase() === 'p' ? 12 : 0);
  }
  return h <= 23 ? h * 60 + m : null;
}

/**
 * Reads text like "German every Tue 18:15-20:00" into a draft block:
 * { title, type, date, start, end, repeat, location }. One day name means the next such day, once.
 * It repeats only when asked: "every", "each", "weekly", "daily", "weekdays", every other week,
 * or more than one day. today is "YYYY-MM-DD".
 */
export function parseBlockText(input, today) {
  let rest = ` ${input.trim()} `;
  const take = (match) => {
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  };

  let location = '';
  const at = /\s@\s*(.+?)\s*$/.exec(rest);
  if (at) {
    location = at[1].trim();
    take(at);
  }

  let start = null;
  let end = null;
  const range = RANGE.exec(rest);
  if (range) {
    const [, h1, m1, half1, h2, m2, half2] = range;
    // "6-8pm": the first time shares the second one's half of the day.
    start = clock(h1, m1, half1 || (half2 && Number(h1) <= Number(h2) ? half2 : ''));
    end = clock(h2, m2, half2);
    if (start !== null && end !== null && end > start) take(range);
    else start = end = null;
  }
  for (const pattern of SINGLES) {
    if (start !== null) break;
    const single = pattern.exec(rest);
    if (single) {
      start = clock(single[1], single[2], single[3]);
      if (start !== null) {
        end = Math.min(start + 60, DAY_MINUTES - 1);
        take(single);
      }
    }
  }

  let weeks = 'every';
  const rule = /\b(every\s*(?:2|two|other)\s*weeks?|biweekly|fortnightly|alternate\s+weeks|odd\s+weeks|even\s+weeks)\b/i.exec(rest);
  if (rule) {
    const words = rule[1].toLowerCase();
    weeks = words.startsWith('odd') ? 'odd' : words.startsWith('even') ? 'even' : 'alternate';
    take(rule);
  }

  // Asked for in words. "weekly" stays in the title: "Weekly review Sun" is still a weekly review.
  let asked = Boolean(rule) || /(?<![\w-])(every|each|weekly)(?![\w-])/i.test(rest);
  const days = new Set();
  let date = '';
  let once = false;
  // A day word stands alone: "Monday.com" is a name, not a day.
  const dayWord = new RegExp(`(?<=^|[\\s,])(${DAY_NAMES.flat().join('|')}|weekdays|daily|every\\s+day|today|tomorrow|once)(?=[\\s,]|$),?`, 'i');
  for (let match = dayWord.exec(rest); match; match = dayWord.exec(rest)) {
    const word = match[1].toLowerCase().replace(/\s+/g, ' ');
    if (word === 'today') date = today;
    else if (word === 'tomorrow') date = addDays(today, 1);
    else if (word === 'once') once = true;
    else if (word === 'weekdays') {
      [1, 2, 3, 4, 5].forEach((d) => days.add(d));
      asked = true;
    } else if (word === 'daily' || word === 'every day') {
      [0, 1, 2, 3, 4, 5, 6].forEach((d) => days.add(d));
      asked = true;
    } else days.add(DAY_NAMES.findIndex((names) => names.includes(word)));
    take(match);
  }
  // Words left over from "on Tue and Thu" at either end, but never inside the title.
  let title = rest.replace(/\s+/g, ' ').trim();
  for (let before = ''; before !== title;) {
    before = title;
    title = title.replace(/^(?:on|every|each|and)\s+/i, '').replace(/\s+(?:on|every|each|and|from|at)$/i, '').replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '');
  }
  const type = guessType(input);
  const sortedDays = [...days].sort();
  if (!date) {
    // The next of the chosen days, today included.
    const ahead = sortedDays.length ? Math.min(...sortedDays.map((d) => (d - weekday(today) + 7) % 7)) : 0;
    date = addDays(today, ahead);
  }
  // Two days or more can only be a series. One day is a single block unless a repeat was asked for.
  const repeats = sortedDays.length > 0 && !once && (asked || sortedDays.length > 1);
  return {
    title: title ? title[0].toLocaleUpperCase() + title.slice(1) : '',
    type,
    date,
    start: start === null ? '' : fromMinutes(start),
    end: end === null ? '' : fromMinutes(end),
    repeat: repeats ? { days: sortedDays, weeks, until: '' } : null,
    location,
  };
}
