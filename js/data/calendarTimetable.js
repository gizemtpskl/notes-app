/**
 * calendarTimetable.js: the timetable's side of the Google Calendar link, with no user interface.
 *
 *   - Timetable blocks become events, one for each occurrence, from the start of this week to
 *     WEEKS_AHEAD weeks ahead. The window moves forward by itself as the days go by. Each
 *     occurrence gets its own event because odd and even weeks, moved and cancelled classes and
 *     semesters can't all be written as one repeating Google event, and this way each one is
 *     always exactly what the timetable shows.
 *   - Google events are read a week at a time and kept, so the timetable can show them, offline too.
 *
 * Nothing can bounce back and forth: every event this app writes carries a private mark
 * (notesApp), and events with that mark are skipped when reading.
 *
 * An event's id is worked out from the occurrence ("blockId:originalDate"), so two devices, or one
 * device after a restored backup, update the same event instead of making a copy. Occurrences in
 * the past are left alone in the calendar, as a record of what happened.
 */
import { addDays, toDateStr } from './dates.js';
import { occurrencesBetween, startOfWeek, toMinutes, fromMinutes } from './timetable.js';
import { CalendarAuthError } from './googleCalendar.js';

export const WEEKS_AHEAD = 8;
const BLOCK_LINKS_KEY = 'gcalBlockLinks';
const WEEKS_KEY = 'gcalWeeks';
const KEEP_WEEKS = 12;
export const WEEK_EVENTS_FRESH_MS = 10 * 60000;

const TEXT = new TextEncoder();
const hex = (value) => [...TEXT.encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Occurrence key to event id. 'b' keeps these apart from task events, which start with 'n'. */
export const blockEventId = (key) => `b${hex(key)}`;

/** The days whose blocks are kept in the calendar: { from, to }. */
export function blockWindow(today) {
  return { from: startOfWeek(today, 1), to: addDays(today, WEEKS_AHEAD * 7) };
}

/** { occurrenceKey: { print, date } } for each block event this app has made. */
export const blockLinks = (db) => db.getMeta(BLOCK_LINKS_KEY) ?? {};

// -- Blocks to events ----------------------------------------------------------------------

/**
 * The occurrences to send, each with what its event says: [{ key, date, start, end, title,
 * location, reminder }]. titleFor(occurrence) can replace the title, for a block that's a task.
 */
export function blocksToSend(db, window, titleFor = (o) => o.title) {
  const blocks = db.listBlocks();
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const lookups = {
    semesters: new Map(db.listSemesters().map((s) => [s.id, s])),
    spaces: new Map(db.listSpaces().map((s) => [s.id, s])),
  };
  return occurrencesBetween(blocks, window.from, window.to, lookups)
    .filter((o) => !o.cancelled)
    .map((o) => ({
      key: o.key,
      date: o.date,
      start: o.start,
      end: o.end,
      title: titleFor(o) || 'Block',
      location: o.location || '',
      reminder: byId.get(o.blockId)?.reminder ?? null,
    }));
}

const print = (o) => JSON.stringify([o.title, o.date, o.start, o.end, o.location, o.reminder]);

/**
 * What needs doing: { create, update, remove, forget }. An event for an occurrence that's gone is
 * removed, unless its day is already before the window: those are forgotten, not deleted.
 */
export function planBlockSync(wanted, links, window) {
  const create = [];
  const update = [];
  for (const o of wanted) {
    if (!(o.key in links)) create.push(o);
    else if (links[o.key].print !== print(o)) update.push(o);
  }
  const present = new Set(wanted.map((o) => o.key));
  const remove = [];
  const forget = [];
  for (const [key, link] of Object.entries(links)) {
    if (present.has(key)) continue;
    if (link.date < window.from) forget.push(key);
    else remove.push(key);
  }
  return {
    create, update, remove, forget,
  };
}

export function blockEventBody(o, timeZone) {
  return {
    summary: o.title,
    location: o.location,
    start: { dateTime: `${o.date}T${o.start}:00`, timeZone },
    end: { dateTime: `${o.date}T${o.end}:00`, timeZone },
    status: 'confirmed',
    // The block's own reminder, and no other: a class without one in the app stays quiet here too.
    reminders: { useDefault: false, overrides: o.reminder ? [{ method: 'popup', minutes: o.reminder }] : [] },
    extendedProperties: { private: { notesApp: '1' } },
  };
}

/** Errors that end a whole run: a sign-in that ran out, or Google asking to slow down. */
export const stopsTheRun = (error) => error instanceof CalendarAuthError || error?.reason === 'rateLimit' || error?.status === 429;

/**
 * Brings the calendar's block events up to date. With send off, every block event this app made
 * is removed again. Returns { created, updated, removed, failed }.
 */
export async function runBlockSync(db, api, {
  today, timeZone, send = true, titleFor,
}) {
  const window = blockWindow(today);
  const links = { ...blockLinks(db) };
  const plan = planBlockSync(send ? blocksToSend(db, window, titleFor) : [], links, window);
  const result = {
    created: 0, updated: 0, removed: 0, failed: 0,
  };
  for (const key of plan.forget) delete links[key];
  const attempt = async (work, count) => {
    try {
      await work();
      result[count] += 1;
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      console.warn('Calendar sync:', error);
      result.failed += 1;
    }
  };
  try {
    for (const [list, count, method] of [[plan.create, 'created', 'put'], [plan.update, 'updated', 'update']]) {
      for (const o of list) {
        await attempt(async () => {
          await api[method](blockEventId(o.key), blockEventBody(o, timeZone));
          links[o.key] = { print: print(o), date: o.date };
        }, count);
      }
    }
    for (const key of plan.remove) {
      await attempt(async () => {
        await api.remove(blockEventId(key));
        delete links[key];
      }, 'removed');
    }
  } finally {
    if (result.created || result.updated || result.removed || plan.forget.length) db.setMeta(BLOCK_LINKS_KEY, links);
  }
  return result;
}

/** Removes every block event this app has added. Returns how many failed. */
export async function removeAllBlockEvents(db, api) {
  const links = { ...blockLinks(db) };
  let failed = 0;
  try {
    for (const key of Object.keys(links)) {
      try {
        await api.remove(blockEventId(key));
        delete links[key];
      } catch (error) {
        if (error instanceof CalendarAuthError) throw error;
        console.warn('Calendar removal:', error);
        failed += 1;
      }
    }
  } finally {
    db.setMeta(BLOCK_LINKS_KEY, links);
  }
  return failed;
}

// -- Events to the timetable ---------------------------------------------------------------

const clockOf = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** Should this event from Google be shown at all? */
function wanted(raw) {
  if (!raw || raw.status === 'cancelled' || raw.eventType === 'workingLocation') return false;
  if (raw.extendedProperties?.private?.notesApp) return false; // One of ours: it's already here.
  if (raw.attendees?.some((person) => person.self && person.responseStatus === 'declined')) return false;
  return true;
}

/**
 * Google's events, as pieces for the days from `from` to `to`: one piece per day an event touches.
 *   { key, id, date, start, end, allDay, title, url }
 * start and end are "HH:MM" on that day ('' for all-day). An event running past midnight ends at
 * 23:59 on its first day and carries on from 00:00 on the next.
 */
export function readRangeEvents(items, from, to) {
  const pieces = [];
  for (const raw of items ?? []) {
    if (!wanted(raw)) continue;
    const base = {
      id: String(raw.id),
      title: raw.summary?.trim() || 'Busy',
      url: typeof raw.htmlLink === 'string' && raw.htmlLink.startsWith('https://') ? raw.htmlLink : '',
    };
    if (raw.start?.date) {
      const last = addDays(raw.end?.date ?? addDays(raw.start.date, 1), -1);
      for (let day = raw.start.date > from ? raw.start.date : from; day <= last && day <= to; day = addDays(day, 1)) {
        pieces.push({
          ...base, key: `event:${base.id}:${day}`, date: day, start: '', end: '', allDay: true,
        });
      }
      continue;
    }
    const begins = new Date(raw.start?.dateTime);
    const ends = new Date(raw.end?.dateTime ?? raw.start?.dateTime);
    if (Number.isNaN(begins.getTime()) || Number.isNaN(ends.getTime())) continue;
    const firstDay = toDateStr(begins);
    // An event ending exactly at midnight belongs to the day before.
    const lastDay = ends > begins ? toDateStr(new Date(ends.getTime() - 1)) : firstDay;
    for (let day = firstDay > from ? firstDay : from; day <= lastDay && day <= to; day = addDays(day, 1)) {
      const start = day === firstDay ? clockOf(begins) : '00:00';
      let end = day === lastDay ? clockOf(ends) : '23:59';
      if (end === '00:00' && ends > begins) end = '23:59';
      if (toMinutes(end) <= toMinutes(start)) end = fromMinutes(Math.min(toMinutes(start) + 15, 1439));
      pieces.push({
        ...base, key: `event:${base.id}:${day}`, date: day, start, end, allDay: false,
      });
    }
  }
  return pieces;
}

/** Keeps one week of events, and forgets the weeks looked at longest ago. */
export function saveWeekEvents(db, weekFrom, pieces, now = Date.now()) {
  const weeks = { ...db.getMeta(WEEKS_KEY), [weekFrom]: { at: now, items: pieces } };
  const keep = Object.entries(weeks).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_WEEKS);
  db.setMeta(WEEKS_KEY, Object.fromEntries(keep));
}

/** When a week was last read from Google, or 0. */
export const weekEventsAt = (db, weekFrom) => db.getMeta(WEEKS_KEY)?.[weekFrom]?.at ?? 0;

/** The kept events between two dates, from every week read so far. */
export function weekEvents(db, from, to) {
  const found = new Map();
  for (const week of Object.values(db.getMeta(WEEKS_KEY) ?? {})) {
    for (const piece of week.items ?? []) {
      if (piece.date >= from && piece.date <= to && !found.has(piece.key)) found.set(piece.key, piece);
    }
  }
  return [...found.values()].sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}

export function clearWeekEvents(db) {
  db.setMeta(WEEKS_KEY, null);
}

/**
 * Kept events as agenda entries, for days other than `today` (whose events come with their ticks
 * from the Today page's own copy).
 */
export function weekEventEntries(db, from, to, today) {
  return weekEvents(db, from, to).filter((piece) => piece.date !== today).map((piece) => ({
    item: {
      id: piece.key, text: piece.title, due: piece.date, time: piece.start, done: false, doneAt: null, priority: 0, children: [],
    },
    parent: null,
    noteTitle: 'Google Calendar',
    url: piece.url,
    isEvent: true,
  }));
}
