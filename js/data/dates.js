/**
 * dates.js: calendar dates as local "YYYY-MM-DD" strings.
 *
 * A journal entry or due date is a calendar day, not a moment in time. Plain strings can't
 * shift across time zones or daylight saving, and they compare correctly with < and >.
 */

const pad = (n) => String(n).padStart(2, '0');

export function toDateStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(str) {
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function isDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toDateStr(parseDate(value)) === value;
}

export function addDays(str, days) {
  const date = parseDate(str);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

/** Adds months, keeping the day where possible: Jan 31 + 1 month is Feb 28 or 29. */
export function addMonths(str, months, anchorDay) {
  const date = parseDate(str);
  const day = anchorDay ?? date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return toDateStr(target);
}

/** Whole days from a to b. Calculated in UTC so daylight saving can't produce a fraction. */
export function daysBetween(a, b) {
  const utc = (str) => {
    const [y, m, d] = str.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86400000);
}

export function formatDay(str, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, options).format(parseDate(str));
}

/** "Today", "Tomorrow", "Yesterday", or a short date. The year only shows when it differs. */
export function relativeDay(str, today = toDateStr()) {
  const diff = daysBetween(today, str);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return str.slice(0, 4) === today.slice(0, 4)
    ? formatDay(str, { month: 'short', day: 'numeric' })
    : formatDay(str);
}

/** First day of the week: 0 Sunday, 1 Monday, 6 Saturday. 'auto' follows the browser's language. */
export function firstDayOfWeek(setting = 'auto') {
  if (setting === 'mon') return 1;
  if (setting === 'sun') return 0;
  if (setting === 'sat') return 6;
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // Older browsers lack week information, so the default below applies.
  }
  return 1;
}

/** Whole weeks covering a month, as arrays of 7 date strings. month is 0 to 11. */
export function monthGrid(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const back = (first.getDay() - weekStart + 7) % 7;
  let cursor = toDateStr(new Date(year, month, 1 - back));
  const lastDay = toDateStr(new Date(year, month + 1, 0));
  const weeks = [];
  while (cursor <= lastDay) {
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}
