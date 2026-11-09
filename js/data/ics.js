/**
 * ics.js: the timetable as an iCalendar (.ics) file, and reading one back. No user interface.
 *
 * EXPORT: a weekly series becomes one repeating event (RRULE), with cancelled weeks left out
 * (EXDATE) and changed weeks written as their own events (RECURRENCE-ID), the way calendar apps
 * expect. Odd and even ISO weeks can't be said in an RRULE, because some years have 53 weeks, so
 * those series are written out week by week for up to a year. Times are local wall-clock times
 * ("floating"), so a class at 09:00 opens at 09:00 in whatever calendar reads the file.
 *
 * IMPORT: weekly and daily events, single events, cancelled and moved weeks are understood.
 * Times in UTC or a named time zone are turned into this device's local time. Anything the
 * timetable can't hold (all-day events, monthly repeats, events longer than a day) is listed with
 * the reason, rather than imported wrongly.
 */
import { addDays, isDateStr, toDateStr } from './dates.js';
import {
  BLOCK_TYPES, blockBounds, createTimeBlock, guessType, occurrencesBetween, occursOn, toMinutes, weekday,
} from './timetable.js';

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SEARCH_DAYS = 7 * 60;
const EXPAND_WEEKS = 52;
const encoder = new TextEncoder();

// -- Writing -------------------------------------------------------------------------------

const escapeText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes continue on the next line, starting with a space. */
function fold(line) {
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const stamp = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function eventLines({
  uid, title, date, start, end, location, notes, type, now, extra = [],
}) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${stamp(date, start)}`,
    `DTEND:${stamp(date, end)}`,
    `SUMMARY:${escapeText(title)}`,
    location && `LOCATION:${escapeText(location)}`,
    notes && `DESCRIPTION:${escapeText(notes)}`,
    `CATEGORIES:${escapeText(BLOCK_TYPES.find((t) => t.value === type)?.label ?? 'Other')}`,
    ...extra,
    'END:VEVENT',
  ].filter(Boolean);
}

/** The first day a block really happens, or null if it never does. */
function firstOccurrence(block, semesters) {
  const { first, last } = blockBounds(block, semesters);
  for (let day = first, i = 0; day <= last && i < SEARCH_DAYS; day = addDays(day, 1), i += 1) {
    if (occursOn(block, day, semesters)) return day;
  }
  return null;
}

/** The whole timetable as the text of an .ics file. */
export function blocksToIcs(blocks, { semesters = new Map(), now = Date.now() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Notes//Timetable//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Timetable'];
  for (const block of blocks) {
    const uid = block.uid || `${block.id}@notes-timetable`;
    const base = {
      uid, title: block.title, location: block.location, notes: block.notes, type: block.type, now,
    };
    const first = firstOccurrence(block, semesters);
    if (!first) continue;
    const { last } = blockBounds(block, semesters);
    const weeks = block.repeat?.weeks;

    if (block.repeat && (weeks === 'odd' || weeks === 'even')) {
      const until = last === '9999-12-31' ? addDays(first, EXPAND_WEEKS * 7) : last;
      for (const o of occurrencesBetween([block], first, until, { semesters })) {
        if (!o.cancelled) {
          lines.push(...eventLines({
            ...base, uid: `${o.originalDate.replaceAll('-', '')}-${uid}`, title: o.title, date: o.date, start: o.start, end: o.end, location: o.location, notes: o.notes, type: o.type,
          }));
        }
      }
      continue;
    }

    if (!block.repeat) {
      const [o] = occurrencesBetween([block], block.date, '9999-12-31', { semesters });
      if (o && !o.cancelled) lines.push(...eventLines({ ...base, ...o, uid }));
      continue;
    }

    const rule = [
      'FREQ=WEEKLY',
      weeks === 'alternate' && 'INTERVAL=2',
      `BYDAY=${block.repeat.days.map((d) => BYDAY[d]).join(',')}`,
      'WKST=MO',
      last !== '9999-12-31' && `UNTIL=${stamp(last, '23:59').slice(0, -2)}59`,
    ].filter(Boolean).join(';');
    const exdates = [];
    const overrides = [];
    for (const [original, change] of Object.entries(block.exceptions ?? {})) {
      if (!occursOn(block, original, semesters)) continue;
      if (change.cancelled) exdates.push(stamp(original, block.start));
      else {
        const [o] = occurrencesBetween([{ ...block, exceptions: { [original]: change } }], change.date ?? original, change.date ?? original, { semesters })
          .filter((x) => x.originalDate === original);
        if (o) overrides.push(o);
      }
    }
    lines.push(...eventLines({
      ...base,
      date: first,
      start: block.start,
      end: block.end,
      extra: [`RRULE:${rule}`, ...exdates.sort().map((d) => `EXDATE:${d}`)],
    }));
    // A changed week shares the series' UID and names the start it replaces.
    for (const o of overrides) {
      lines.push(...eventLines({
        ...base,
        title: o.title,
        date: o.date,
        start: o.start,
        end: o.end,
        location: o.location,
        notes: o.notes,
        type: o.type,
        extra: [`RECURRENCE-ID:${stamp(o.originalDate, block.start)}`],
      }));
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// -- Reading -------------------------------------------------------------------------------

const unescapeText = (value) => value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** One content line: { name, params, value }. Colons inside quoted parameters don't end the name. */
function parseLine(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      const [name, ...rawParams] = line.slice(0, i).split(';');
      const params = {};
      for (const param of rawParams) {
        const at = param.indexOf('=');
        if (at > 0) params[param.slice(0, at).toUpperCase()] = param.slice(at + 1).replace(/^"|"$/g, '');
      }
      return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

/** How far a time zone is ahead of UTC at an instant, in minutes. Throws for an unknown zone. */
function zoneOffset(timeZone, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - ms) / 60000);
}

const pad = (n) => String(n).padStart(2, '0');
const localParts = (ms) => {
  const d = new Date(ms);
  return { date: toDateStr(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};

/** A DATE or DATE-TIME value as local { date, time, allDay }, or null. */
export function readDateTime(value, params = {}) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, , utc] = match;
  const date = `${y}-${mo}-${d}`;
  if (!isDateStr(date)) return null;
  if (h === undefined || params.VALUE === 'DATE') return { date, time: '', allDay: true };
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (utc) return { ...localParts(wall), allDay: false };
  if (params.TZID) {
    try {
      // The offset depends on the instant, which depends on the offset: two rounds settle it.
      let instant = wall - zoneOffset(params.TZID, wall) * 60000;
      instant = wall - zoneOffset(params.TZID, instant) * 60000;
      return { ...localParts(instant), allDay: false };
    } catch {
      // A zone this browser doesn't know, such as a Windows name: the time is kept as written.
    }
  }
  return { date, time: `${h}:${mi}`, allDay: false };
}

function readDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, w, d, h, m] = match;
  const minutes = (Number(w ?? 0) * 7 + Number(d ?? 0)) * 1440 + Number(h ?? 0) * 60 + Number(m ?? 0);
  return sign === '-' ? null : minutes;
}

function readRule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const [key, val] = part.split('=');
    if (key && val !== undefined) rule[key.toUpperCase()] = val.toUpperCase();
  }
  return rule;
}

/** Turns an RRULE into the timetable's repeat, or explains why it can't. */
function toRepeat(rule, start, dateParams) {
  const interval = Number(rule.INTERVAL ?? 1);
  const freq = rule.FREQ;
  const days = rule.BYDAY ? rule.BYDAY.split(',') : [];
  if (days.some((d) => !BYDAY.includes(d))) return { problem: 'Repeats on days like “the first Monday”, which the timetable can’t.' };
  if (rule.BYMONTH || rule.BYMONTHDAY || rule.BYSETPOS || rule.BYYEARDAY || rule.BYWEEKNO) return { problem: 'Repeats in a way the timetable can’t.' };
  let repeat;
  if (freq === 'WEEKLY' && (interval === 1 || interval === 2)) {
    repeat = { days: days.length ? days.map((d) => BYDAY.indexOf(d)) : [weekday(start.date)], weeks: interval === 2 ? 'alternate' : 'every', until: '' };
  } else if (freq === 'DAILY' && interval === 1) {
    repeat = { days: days.length ? days.map((d) => BYDAY.indexOf(d)) : [0, 1, 2, 3, 4, 5, 6], weeks: 'every', until: '' };
  } else {
    const label = { DAILY: 'every few days', MONTHLY: 'monthly', YEARLY: 'yearly', WEEKLY: 'every few weeks' }[freq] ?? 'in a way';
    return { problem: `Repeats ${label}, which the timetable can’t.` };
  }
  if (rule.UNTIL) {
    const until = readDateTime(rule.UNTIL, dateParams.VALUE === 'DATE' ? { VALUE: 'DATE' } : {});
    if (until) repeat.until = until.date;
  }
  if (rule.COUNT) {
    // The date of the last one, counting the way the rule does.
    const count = Number(rule.COUNT);
    const probe = createTimeBlock({
      id: 'probe', date: start.date, start: '00:00', end: '00:01', repeat,
    });
    let seen = 0;
    for (let day = start.date, i = 0; i < 366 * 5; day = addDays(day, 1), i += 1) {
      if (occursOn(probe, day)) {
        seen += 1;
        if (seen === count) {
          repeat.until = day;
          break;
        }
      }
    }
  }
  return { repeat };
}

/**
 * Reads an .ics file. Returns { ok: true, events } or { ok: false, error }. Each event is
 *   { uid, title, location, notes, type, date, start, end, repeat, exceptions, problem }
 * where problem says, in plain words, why the event can't be imported ('' when it can).
 */
export function parseIcs(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) {
    return { ok: false, error: 'This isn’t a calendar file. Choose a file that ends in .ics.' };
  }
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const raw = [];
  let current = null;
  let depth = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.name === 'BEGIN') {
      if (parsed.value.toUpperCase() === 'VEVENT' && depth === 0) current = { props: [] };
      else if (current) depth += 1;
    } else if (parsed.name === 'END') {
      if (parsed.value.toUpperCase() === 'VEVENT' && current && depth === 0) {
        raw.push(current);
        current = null;
      } else if (current && depth > 0) depth -= 1;
    } else if (current && depth === 0) {
      current.props.push(parsed);
    }
  }

  const events = [];
  const overrides = [];
  for (const { props } of raw) {
    const get = (name) => props.find((p) => p.name === name);
    const all = (name) => props.filter((p) => p.name === name);
    const startProp = get('DTSTART');
    const uid = get('UID')?.value.trim() ?? '';
    const title = unescapeText(get('SUMMARY')?.value ?? '').trim() || 'Untitled event';
    const event = {
      uid,
      title,
      location: unescapeText(get('LOCATION')?.value ?? '').trim(),
      notes: unescapeText(get('DESCRIPTION')?.value ?? '').trim().slice(0, 5000),
      type: guessType(title),
      date: '',
      start: '',
      end: '',
      repeat: null,
      exceptions: {},
      cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
      problem: '',
    };
    const start = startProp && readDateTime(startProp.value, startProp.params);
    if (!start) {
      event.problem = 'Has no start time.';
      events.push(event);
      continue;
    }
    event.date = start.date;
    event.start = start.time;
    if (start.allDay) event.problem = 'An all-day event. The timetable only holds blocks with times.';

    const endProp = get('DTEND');
    const end = endProp ? readDateTime(endProp.value, endProp.params) : null;
    const duration = get('DURATION') ? readDuration(get('DURATION').value) : null;
    if (!start.allDay) {
      if (end && !end.allDay) {
        if (end.date === start.date) event.end = end.time;
        else if (end.date === addDays(start.date, 1) && end.time === '00:00') event.end = '23:59';
      } else if (duration !== null) {
        const finish = toMinutes(start.time) + duration;
        if (finish < 1440) event.end = `${pad(Math.floor(finish / 60))}:${pad(finish % 60)}`;
        else if (finish === 1440) event.end = '23:59';
      } else {
        const finish = Math.min(toMinutes(start.time) + 60, 1439);
        event.end = `${pad(Math.floor(finish / 60))}:${pad(finish % 60)}`;
      }
      if (!event.end && !event.problem) event.problem = 'Lasts past midnight, which a timetable block can’t.';
      if (event.end && toMinutes(event.end) <= toMinutes(event.start) && !event.problem) event.problem = 'Ends before it starts.';
    }

    const recurrence = get('RECURRENCE-ID');
    if (recurrence) {
      const original = readDateTime(recurrence.value, recurrence.params);
      if (original) overrides.push({ uid, original: original.date, event });
      continue;
    }

    const ruleProp = get('RRULE');
    if (ruleProp && !event.problem) {
      const { repeat, problem } = toRepeat(readRule(ruleProp.value), start, startProp.params);
      if (problem) event.problem = problem;
      else event.repeat = repeat;
    }
    for (const ex of all('EXDATE')) {
      for (const value of ex.value.split(',')) {
        const day = readDateTime(value, ex.params);
        if (day) event.exceptions[day.date] = { cancelled: true };
      }
    }
    if (!event.cancelled) events.push(event);
  }

  // A changed or cancelled week of a series belongs to the series it came from.
  for (const { uid, original, event } of overrides) {
    const master = events.find((e) => e.uid === uid && e.repeat);
    if (!master) {
      if (!event.cancelled) events.push(event);
      continue;
    }
    if (event.cancelled) {
      master.exceptions[original] = { cancelled: true };
    } else if (!event.problem) {
      const change = {};
      if (event.date !== original) change.date = event.date;
      if (event.start !== master.start) change.start = event.start;
      if (event.end !== master.end) change.end = event.end;
      if (event.title !== master.title) change.title = event.title;
      if (event.location !== master.location) change.location = event.location;
      master.exceptions[original] = change;
      if (!Object.keys(change).length) delete master.exceptions[original];
    }
  }
  return { ok: true, events: events.map(({ cancelled: _cancelled, ...event }) => event) };
}

/** The block a parsed event becomes. */
export function eventToBlock(event) {
  return {
    title: event.title,
    type: event.type,
    date: event.date,
    start: event.start,
    end: event.end,
    repeat: event.repeat,
    location: event.location,
    notes: event.notes,
    exceptions: event.exceptions,
    uid: event.uid,
  };
}
