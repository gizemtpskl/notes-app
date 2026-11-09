/**
 * journal.js: calculations for the journal page. Pure functions over journal notes.
 */
import { addDays, toDateStr } from './dates.js';
import { noteWords } from './types.js';

const MOOD_FIELD = { id: 'mood' };

/** An entry's date: its date field, or the day it was created if that is missing. */
export function entryDate(note) {
  const value = note.fields?.date;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : toDateStr(new Date(note.created));
}

export function entryMood(note) {
  const value = note.fields?.[MOOD_FIELD.id];
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 0;
}

/**
 * Streaks count consecutive days with an entry. The current streak survives until the end of
 * today: writing yesterday but not yet today still counts.
 */
export function streaks(notes, today = toDateStr()) {
  const days = new Set(notes.map(entryDate));
  let current = 0;
  let cursor = days.has(today) ? today : addDays(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const day of [...days].sort()) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest };
}

/** Entries from this calendar day in earlier years, newest first. Feb 29 also shows on Feb 28 in other years. */
export function onThisDay(notes, today = toDateStr()) {
  const monthDay = today.slice(5);
  const isLeapYear = (year) => new Date(Number(year), 1, 29).getMonth() === 1;
  return notes
    .filter((note) => {
      const date = entryDate(note);
      if (date.slice(0, 4) >= today.slice(0, 4)) return false;
      return date.slice(5) === monthDay || (monthDay === '02-28' && date.slice(5) === '02-29' && !isLeapYear(today.slice(0, 4)));
    })
    .sort((a, b) => entryDate(b).localeCompare(entryDate(a)));
}

/**
 * One point per day in the range, oldest first: { date, mood }. mood is null on days with no
 * mood recorded, so the chart can show a gap. Several entries in a day are averaged.
 */
export function moodSeries(notes, days, today = toDateStr()) {
  const byDay = new Map();
  for (const note of notes) {
    const mood = entryMood(note);
    if (mood) {
      const date = entryDate(note);
      const bucket = byDay.get(date) ?? [];
      bucket.push(mood);
      byDay.set(date, bucket);
    }
  }
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    const bucket = byDay.get(date);
    series.push({ date, mood: bucket ? bucket.reduce((a, b) => a + b, 0) / bucket.length : null });
  }
  return series;
}

export function averageMood(series) {
  const values = series.filter((p) => p.mood !== null).map((p) => p.mood);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function totalWords(notes, type) {
  return notes.reduce((sum, note) => sum + noteWords(note, type), 0);
}
