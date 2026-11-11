/**
 * taskText.js: turns messy typed text into tasks, using plain rules with no AI and no network.
 *
 *   "15.00 project meeting"    Project meeting, today at 15:00
 *   "dentist friday at 10:30"  Dentist, on the coming Friday at 10:30
 *   "call mum at 3"            Call mum, today at 15:00
 *
 * The rules stay cautious, because a wrong guess costs more than a missed one. A number needs a
 * clear sign that it's a time, so "read chapter 3.10" and "buy milk 2.50" stay as written. A day
 * only counts at the start or end of a line, so "watch Friday night lights" stays as written too.
 */
import { addDays, parseDate } from './dates.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_WORDS = `today|tonight|tomorrow|tmrw|${WEEKDAYS.join('|')}`;
const DATE_START = new RegExp(`^(?:(?:on|by|next)\\s+)?(${DAY_WORDS})(?=$|[\\s,:;-])`, 'i');
const DATE_END = new RegExp(`(?:^|[\\s,;-])(?:(?:on|by|next)\\s+)?(${DAY_WORDS})[.!]?$`, 'i');

const BEFORE = '(?:^|[\\s,(])';
const AFTER = '(?=[.,;)]?(?:\\s|$))';
const AT = '(?:(?:at|@)\\s*)?';
const UNTIL = '(?:\\s*[-–]\\s*\\d{1,2}[.:]\\d{2})?'; // An end the range below didn't accept is dropped.
const CLOCK = (name) => `(?<${name}Hour>\\d{1,2})(?:(?<${name}Sep>[.:])(?<${name}Minute>\\d{2}))?\\s*(?:(?<${name}Half>[ap])\\.?m\\.?)?`;
// "10:00-11:00", "10-11am", "9am to 10.30am", "15.00-16.00": a start and an end.
const RANGE = new RegExp(`${BEFORE}(?:from\\s+)?${AT}${CLOCK('from')}\\s*(?:-|–|—|to|until)\\s*${CLOCK('to')}${AFTER}`, 'i');

// Tried in this order, from the clearest sign to the least clear.
const TIME_PATTERNS = [
  new RegExp(`${BEFORE}${AT}(?<hour>\\d{1,2})(?:[.:](?<minute>\\d{2}))?\\s*(?<half>[ap])\\.?m\\.?${AFTER}`, 'i'), // 3pm, 3.30 pm
  new RegExp(`${BEFORE}${AT}(?<hour>\\d{1,2}):(?<minute>\\d{2})${UNTIL}${AFTER}`, 'i'), // 15:00
  new RegExp(`${BEFORE}(?:at|@)\\s*(?<hour>\\d{1,2})\\.(?<minute>\\d{2})${UNTIL}${AFTER}`, 'i'), // at 15.00
  new RegExp(`^(?<hour>\\d{1,2})\\.(?<minute>\\d{2})${UNTIL}${AFTER}`), // 15.00 at the start of a line
  new RegExp(`(?:^|\\s)(?<hour>\\d{2})\\.(?<minute>\\d{2})${UNTIL}[.!]?$`), // 15.00 at the end, with two digits
];
const BARE_HOUR = /(?:^|\s)(?:at|@)\s*(\d{1,2})[.!]?$/i; // "at 3", only at the end: not "look at 3 files"
const BULLET = /^\s*(?:[-*•–—]\s+)?(?:\[[ xX]?\]\s+)?(?:\d+[.)]\s+)?/;

const pad = (n) => String(n).padStart(2, '0');

function clockTime(hour, minute = 0, half = '') {
  if (minute > 59) return '';
  if (!half) return hour <= 23 ? `${pad(hour)}:${pad(minute)}` : '';
  if (hour < 1 || hour > 12) return '';
  const base = hour % 12;
  return `${pad(half.toLowerCase() === 'p' ? base + 12 : base)}:${pad(minute)}`;
}

const without = (line, match) => `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}`;

/**
 * A range needs the same clear sign as one time: a colon, am/pm, or two-digit hours with a dot.
 * So "pages 10-11" and "chapter 3.10-3.20" stay as written.
 */
function takeRange(line) {
  const match = RANGE.exec(line);
  if (!match) return null;
  const g = match.groups;
  const colon = g.fromSep === ':' || g.toSep === ':';
  const half = Boolean(g.fromHalf || g.toHalf);
  const dots = g.fromSep === '.' && g.toSep === '.' && g.fromHour.length === 2 && g.toHour.length === 2;
  if (!colon && !half && !dots) return null;
  // "6-8pm": the start shares the end's half of the day, unless that would put it after the end.
  const fromHalf = g.fromHalf || (g.toHalf && Number(g.fromHour) <= Number(g.toHour) ? g.toHalf : '');
  const time = clockTime(Number(g.fromHour), Number(g.fromMinute ?? 0), fromHalf);
  const end = clockTime(Number(g.toHour), Number(g.toMinute ?? 0), g.toHalf);
  if (!time || !end || end <= time) return null;
  return { time, end, line: without(line, match) };
}

function takeTime(line) {
  const range = takeRange(line);
  if (range) return range;
  for (const pattern of TIME_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const { hour, minute, half } = match.groups;
      const time = clockTime(Number(hour), Number(minute ?? 0), half);
      if (time) return { time, line: without(line, match) };
    }
  }
  return null;
}

function takeDay(line, today) {
  const match = DATE_START.exec(line) ?? DATE_END.exec(line);
  if (!match) return null;
  const word = match[1].toLowerCase();
  if (word === 'today' || word === 'tonight') return { due: today, line: without(line, match) };
  if (word === 'tomorrow' || word === 'tmrw') return { due: addDays(today, 1), line: without(line, match) };
  // Always ahead: "friday" written on a Friday means next week, because today needs no word at all.
  const ahead = (WEEKDAYS.indexOf(word) - parseDate(today).getDay() + 7) % 7 || 7;
  return { due: addDays(today, ahead), line: without(line, match) };
}

function tidy(text) {
  const clean = text.replace(/\s+/g, ' ').replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, '');
  return clean ? clean[0].toLocaleUpperCase() + clean.slice(1) : '';
}

/**
 * Reads one line: { text, time, due }, or null if there's nothing on it. time is "HH:MM" or ''.
 * A range like "10:00-11:00" adds end: "HH:MM"; with no range there is no end.
 */
export function parseTaskLine(raw, today) {
  const original = raw.replace(BULLET, '').trim();
  if (!original) return null;
  let line = original;
  let time = '';
  let end = '';
  let due = '';
  // Twice, because each can be hiding the other: "meeting 15.00 tomorrow", "tomorrow 15.00 meeting".
  for (let pass = 0; pass < 2; pass += 1) {
    const day = due ? null : takeDay(line.trim(), today);
    if (day) ({ due, line } = day);
    const clock = time ? null : takeTime(line.trim());
    if (clock) ({ time, line, end = '' } = clock);
  }
  if (!time) {
    const match = BARE_HOUR.exec(line.trim());
    const hour = match ? Number(match[1]) : 0;
    // A meeting "at 3" is rarely at three in the morning, so 1 to 6 are read as the afternoon.
    const found = match && clockTime(hour >= 1 && hour <= 6 ? hour + 12 : hour);
    if (found) {
      time = found;
      line = without(line.trim(), match);
    }
  }
  const text = tidy(line);
  // A line that was only a time or a day is kept as written rather than lost.
  if (!text) return { text: tidy(original), time: '', due: today };
  return end ? { text, time, end, due: due || today } : { text, time, due: due || today };
}

/** Reads many lines into an organized list: soonest first, and timed tasks before the rest of their day. */
export function parseTaskList(text, today) {
  return text.split(/\r?\n/)
    .map((line) => parseTaskLine(line, today))
    .filter(Boolean)
    .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99'));
}
