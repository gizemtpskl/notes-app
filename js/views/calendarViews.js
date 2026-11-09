/**
 * calendarViews.js: the Calendar and Timeline views, laid out by any date a note has.
 * They work for every type and every list of notes, so collections and saved views share them.
 */
import { app } from '../context.js';
import { firstDayOfWeek, formatDay, monthGrid, parseDate, relativeDay, toDateStr } from '../data/dates.js';
import { fieldValue } from '../data/fieldKinds.js';
import { displayTitle, noteDate, summaryFields } from '../data/types.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fieldDisplay } from './fieldWidgets.js';

const TIMELINE_PAGE = 60;
const DAY_LIMIT = 3;

const titleOf = (note) => displayTitle(note, app.db.getType(note.typeId)) || 'Untitled';

function byDate(notes, getKey) {
  const days = new Map();
  let undated = 0;
  const key = getKey();
  for (const note of notes) {
    const date = noteDate(note, app.db.getType(note.typeId), key);
    if (date) {
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(note);
    } else {
      undated += 1;
    }
  }
  return { days, undated };
}

const undatedLine = (count, key) => count > 0 && h('p', { class: 'view-foot' },
  `${plural(count, 'note')} without ${key.startsWith('field:') || key === 'due' ? 'this date' : 'a date'} ${count === 1 ? 'isn’t' : 'aren’t'} shown.`);

/**
 * options:
 *   getNotes    () => the notes to lay out
 *   getDateKey  () => a key from dateKeysFor
 *   onNew       optional (date) => create a note on that day. Offered when the key is a field.
 */
export function calendarView({ getNotes, getDateKey, onNew }) {
  const start = parseDate(toDateStr());
  let year = start.getFullYear();
  let month = start.getMonth();
  let selected = null;
  const el = h('div', { class: 'month-view' });

  function move(step) {
    const next = new Date(year, month + step, 1);
    year = next.getFullYear();
    month = next.getMonth();
    selected = null;
    render();
    el.querySelector(step < 0 ? '[data-move="prev"]' : '[data-move="next"]')?.focus();
  }

  function render() {
    const key = getDateKey();
    const today = toDateStr();
    const { days, undated } = byDate(getNotes(), getDateKey);
    const weeks = monthGrid(year, month, firstDayOfWeek(app.db.getSettings().weekStart));
    const canCreate = onNew && key.startsWith('field:');
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.day : null;

    const dayCell = (date) => {
      const notes = days.get(date) ?? [];
      const outside = parseDate(date).getMonth() !== month;
      return h('td', {
        class: `mcal-cell${outside ? ' is-outside' : ''}${date === today ? ' is-today' : ''}${date === selected ? ' is-selected' : ''}`,
      },
      h('button', {
        class: 'mcal-day',
        type: 'button',
        dataset: { day: date },
        'aria-pressed': String(date === selected),
        'aria-label': `${formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${plural(notes.length, 'note')}`,
        onClick: () => {
          selected = selected === date ? null : date;
          render();
        },
      }, h('span', { class: 'mcal-num' }, parseDate(date).getDate())),
      h('div', { class: 'mcal-notes' },
        notes.slice(0, DAY_LIMIT).map((note) => h('a', {
          class: 'mcal-note', href: `#/note/${encodeURIComponent(note.id)}`, dataset: { color: app.db.getSpace(note.spaceId)?.color ?? 'slate' }, title: titleOf(note),
        }, titleOf(note))),
        notes.length > DAY_LIMIT && h('span', { class: 'mcal-more' }, `+${notes.length - DAY_LIMIT} more`)),
      // Phones only have room for a count.
      notes.length > 0 && h('span', { class: 'mcal-count', 'aria-hidden': 'true' }, notes.length));
    };

    const selectedNotes = selected ? days.get(selected) ?? [] : [];
    const weekHead = weeks[0].map((date) => h('th', { scope: 'col' }, h('abbr', { title: formatDay(date, { weekday: 'long' }) }, formatDay(date, { weekday: 'short' }))));

    fill(el,
      h('div', { class: 'cal-head' },
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', dataset: { move: 'prev' }, onClick: () => move(-1),
        }, icon('chevronLeft', 18)),
        h('h2', { class: 'cal-title', 'aria-live': 'polite' }, new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1))),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Next month', dataset: { move: 'next' }, onClick: () => move(1),
        }, icon('chevronRight', 18)),
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            const now = parseDate(toDateStr());
            year = now.getFullYear();
            month = now.getMonth();
            selected = null;
            render();
          },
        }, 'Today')),
      h('table', { class: 'mcal' },
        h('thead', null, h('tr', null, weekHead)),
        h('tbody', null, weeks.map((week) => h('tr', null, week.map(dayCell))))),
      selected && h('section', { class: 'mcal-selected', 'aria-label': formatDay(selected) },
        h('div', { class: 'section-head' },
          h('h3', { class: 'section-title' }, relativeDay(selected, today), ' · ', plural(selectedNotes.length, 'note')),
          canCreate && h('button', { class: 'btn btn-small', type: 'button', onClick: () => onNew(selected) }, icon('plus', 14), 'New note on this day')),
        selectedNotes.length > 0 && h('ul', { class: 'mcal-list' }, selectedNotes.map((note) => h('li', null,
          h('a', { class: 'mcal-list-link', href: `#/note/${encodeURIComponent(note.id)}` }, h('span', { 'aria-hidden': 'true' }, app.db.getType(note.typeId).icon), titleOf(note)))))),
      undatedLine(undated, key));

    if (focused) el.querySelector(`[data-day="${CSS.escape(focused)}"]`)?.focus();
  }

  render();
  return { el, refresh: render };
}

/** Every note by date, newest first, grouped by month, or oldest first at the reader's choice. */
export function timelineView({ getNotes, getDateKey }) {
  let shown = TIMELINE_PAGE;
  let newestFirst = true;
  const el = h('div', { class: 'timeline-view' });

  function render() {
    const key = getDateKey();
    const { days, undated } = byDate(getNotes(), getDateKey);
    const rows = [];
    for (const [date, notes] of days) for (const note of notes) rows.push({ date, note });
    // Notes on the same day follow when they were made, so flipping the order flips everything.
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.note.created - b.note.created);
    if (newestFirst) rows.reverse();
    const visible = rows.slice(0, shown);

    const months = new Map();
    for (const row of visible) {
      const month = row.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(row);
    }

    const entry = ({ date, note }) => {
      const type = app.db.getType(note.typeId);
      const chips = summaryFields(type).map((field) => fieldDisplay(field, fieldValue(note, field), { db: app.db, compact: true })).filter(Boolean);
      return h('li', { class: 'tl-entry', dataset: { id: note.id, color: app.db.getSpace(note.spaceId)?.color ?? 'slate' } },
        h('time', { class: 'tl-date', datetime: date }, formatDay(date, { month: 'short', day: 'numeric' })),
        h('a', { class: 'tl-card', href: `#/note/${encodeURIComponent(note.id)}` },
          h('span', { class: 'tl-title' }, h('span', { 'aria-hidden': 'true' }, type.icon), ' ', titleOf(note)),
          chips.length > 0 && h('span', { class: 'note-chips' }, chips)));
    };

    fill(el,
      rows.length > 0 && h('div', { class: 'tl-controls' },
        h('button', {
          class: 'btn-link',
          type: 'button',
          onClick: () => {
            newestFirst = !newestFirst;
            render();
          },
        }, icon(newestFirst ? 'arrowDown' : 'arrowUp', 14), newestFirst ? 'Newest first' : 'Oldest first')),
      rows.length === 0 && h('p', { class: 'empty-line' }, 'No notes with this date yet.'),
      [...months.entries()].map(([month, entries]) => h('section', { class: 'tl-month' },
        h('h2', { class: 'timeline-title' }, formatDay(`${month}-01`, { month: 'long', year: 'numeric' })),
        h('ol', { class: 'tl-list' }, entries.map(entry)))),
      rows.length > shown && h('button', {
        class: 'btn btn-more',
        type: 'button',
        onClick: () => {
          shown += TIMELINE_PAGE;
          render();
        },
      }, `Show more (${(rows.length - shown).toLocaleString()} left)`),
      undatedLine(undated, key));
  }

  render();
  return { el, refresh: render };
}
