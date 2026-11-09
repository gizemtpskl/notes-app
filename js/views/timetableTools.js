/**
 * timetableTools.js: the timetable's extra tools: finding free time, the weekly summary,
 * .ics export and import, and the tasks that can be given a time.
 */
import { app } from '../context.js';
import { addDays, formatDay, toDateStr } from '../data/dates.js';
import { fieldValue } from '../data/fieldKinds.js';
import { blocksToIcs, eventToBlock, parseIcs } from '../data/ics.js';
import { locate } from '../data/tasks.js';
import {
  BLOCK_TYPES, WEEK_RULES, freeSlots, weekSummary,
} from '../data/timetable.js';
import { displayTitle } from '../data/types.js';
import { openDialog } from '../ui/dialog.js';
import { downloadBlob, fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { WEEKDAY_NAMES } from './blockDialog.js';
import { allTaskNotes, collectTasks } from './tasksAgenda.js';

const MAX_ICS_BYTES = 5 * 1024 * 1024;
export const TASK_LIMIT = 40;

const hoursText = (minutes) => {
  const hours = minutes / 60;
  return `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
};
const shortDay = (date) => formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' });
const lookups = (db) => ({
  semesters: new Map(db.listSemesters().map((s) => [s.id, s])),
  spaces: new Map(db.listSpaces().map((s) => [s.id, s])),
});
const nowParts = () => {
  const d = new Date();
  return { date: toDateStr(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
};

// -- Free time -----------------------------------------------------------------------------

/**
 * Lists gaps in the timetable. occurrencesFor(from, to) gives the blocks; onPick(slot) is
 * called when one is chosen, after the dialog closes.
 */
export function openFreeTimeDialog({ from, occurrencesFor, hours, onPick }) {
  const choices = { minMinutes: 60, dayStart: hours.start, dayEnd: Math.min(hours.end, 24), weekdaysOnly: false };
  return openDialog({
    title: 'Find free time',
    className: 'dialog-block',
    build: (close) => {
      const el = h('div');
      const results = h('div', { class: 'free-results', 'aria-live': 'polite' });

      function search() {
        const to = addDays(from, 6);
        const slots = freeSlots(occurrencesFor(from, to), {
          from,
          to,
          dayStart: `${String(choices.dayStart).padStart(2, '0')}:00`,
          dayEnd: choices.dayEnd >= 24 ? '23:59' : `${String(choices.dayEnd).padStart(2, '0')}:00`,
          minMinutes: choices.minMinutes,
          days: choices.weekdaysOnly ? [1, 2, 3, 4, 5] : null,
          now: nowParts(),
        });
        if (!slots.length) {
          fill(results, h('p', { class: 'empty-line' }, 'No gaps that long in these hours. Try shorter gaps or more hours.'));
          return;
        }
        const days = [...new Set(slots.map((s) => s.date))];
        fill(results,
          h('p', { class: 'settings-text' }, `${plural(slots.length, 'gap')} of ${choices.minMinutes} minutes or more, ${hoursText(slots.reduce((sum, s) => sum + s.minutes, 0))} in all.`),
          days.map((date) => h('section', { class: 'free-day' },
            h('h3', { class: 'section-title' }, formatDay(date, { weekday: 'long', month: 'short', day: 'numeric' })),
            h('ul', { class: 'free-list' }, slots.filter((s) => s.date === date).map((slot) => h('li', null,
              h('button', {
                class: 'free-slot',
                type: 'button',
                onClick: () => {
                  close(true);
                  onPick(slot);
                },
              },
              h('span', { class: 'free-time' }, slot.start, h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, ' to '), slot.end),
              h('span', { class: 'free-length' }, hoursText(slot.minutes)),
              h('span', { class: 'free-add' }, icon('plus', 14), 'Add a block here'))))))));
      }

      const select = (key, label, options) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
        h('select', {
          class: 'select',
          onChange: (event) => {
            choices[key] = Number(event.target.value);
            search();
          },
        }, options.map(([value, text]) => h('option', { value, selected: value === choices[key] }, text))));
      const hourOptions = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => [min + i, `${String(min + i).padStart(2, '0')}:00`]);

      fill(el,
        h('p', { class: 'settings-text' }, `${shortDay(from)} to ${shortDay(addDays(from, 6))}. Time already past isn’t counted.`),
        h('div', { class: 'field-row free-options' },
          select('minMinutes', 'At least', [[30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours']]),
          select('dayStart', 'From', hourOptions(0, 23)),
          select('dayEnd', 'To', hourOptions(1, 24))),
        h('label', { class: 'check-field' },
          h('input', {
            type: 'checkbox',
            onChange: (event) => {
              choices.weekdaysOnly = event.target.checked;
              search();
            },
          }), 'Monday to Friday only'),
        results);
      search();
      return el;
    },
  });
}

// -- Weekly summary ------------------------------------------------------------------------

function bars(rows) {
  const max = Math.max(1, ...rows.map((row) => row.minutes));
  return h('ul', { class: 'hbars' }, rows.map((row) => h('li', { class: 'hbar' },
    h('span', { class: 'hbar-label' }, row.label),
    h('span', { class: 'hbar-track' }, row.minutes > 0 && h('span', { class: 'hbar-fill', cssVars: { '--share': `${(row.minutes / max) * 100}%` } })),
    h('span', { class: 'hbar-value' }, hoursText(row.minutes)))));
}

/** Hours by kind, with free time, and hours by space. Every value is written next to its bar. */
export function weekSummaryView(occurrences, { from, to, hours }) {
  const { db } = app;
  const summary = weekSummary(occurrences, {
    from,
    to,
    dayStart: `${String(hours.start).padStart(2, '0')}:00`,
    dayEnd: hours.end >= 24 ? '23:59' : `${String(hours.end).padStart(2, '0')}:00`,
  });
  if (!summary.byType.length) return null;
  const typeRows = summary.byType.map((row) => ({ label: BLOCK_TYPES.find((t) => t.value === row.type)?.label ?? 'Other', minutes: row.minutes }));
  const booked = summary.byType.reduce((sum, row) => sum + row.minutes, 0);
  const range = `${String(hours.start).padStart(2, '0')}:00 to ${String(Math.min(hours.end, 24)).padStart(2, '0')}:00`;
  const stat = (value, label) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label));
  const spaceRows = summary.bySpace.map((row) => {
    const space = row.spaceId && db.getSpace(row.spaceId);
    return { label: space ? `${space.icon} ${space.name}` : 'No space', minutes: row.minutes };
  });
  return h('section', { class: 'section tt-week-summary' },
    h('h2', { class: 'section-title' }, 'This week'),
    // Free time is usually far larger than any kind of block, so it's a number, not a bar beside them.
    h('div', { class: 'stat-row tt-summary-stats' },
      stat(hoursText(booked), 'On the timetable'),
      stat(hoursText(summary.free), `Free, ${range}`)),
    h('div', { class: 'tt-summary-grid' },
      h('div', null, h('h3', { class: 'tt-summary-head' }, 'By kind'), bars(typeRows)),
      h('div', null, h('h3', { class: 'tt-summary-head' }, 'By space'), bars(spaceRows))));
}

// -- .ics export and import ----------------------------------------------------------------

export function exportIcs() {
  const { db } = app;
  const blocks = db.listBlocks();
  if (!blocks.length) {
    toast('There are no blocks to export yet.');
    return;
  }
  const text = blocksToIcs(blocks, { semesters: lookups(db).semesters });
  downloadBlob(new Blob([text], { type: 'text/calendar;charset=utf-8' }), `timetable-${toDateStr()}.ics`);
  toast(`Exported ${plural(blocks.length, 'block')}`);
}

function describeEvent(event) {
  if (!event.date) return '';
  const time = event.start && event.end ? `${event.start}–${event.end}` : '';
  if (!event.repeat) return `${shortDay(event.date)} ${time}`.trim();
  const days = event.repeat.days.length === 7 ? 'Every day' : event.repeat.days.map((d) => WEEKDAY_NAMES[d]).join(', ');
  const rule = event.repeat.weeks === 'every' ? '' : ` (${WEEK_RULES.find((r) => r.value === event.repeat.weeks).label.toLowerCase()})`;
  const until = event.repeat.until ? `, until ${formatDay(event.repeat.until)}` : '';
  return `${days}${rule} ${time}, from ${formatDay(event.date)}${until}`;
}

/** Asks for an .ics file, shows what's in it, and adds the events chosen. */
export function importIcs() {
  const input = h('input', { type: 'file', accept: '.ics,text/calendar', hidden: true });
  input.addEventListener('change', async () => {
    const [file] = input.files;
    input.remove();
    if (!file) return;
    if (file.size > MAX_ICS_BYTES) {
      toast('That file is too large for a timetable. Export just one calendar and try again.', { error: true });
      return;
    }
    const parsed = parseIcs(await file.text());
    if (!parsed.ok) {
      toast(parsed.error, { error: true });
      return;
    }
    openIcsPreview(parsed.events, file.name);
  });
  document.body.append(input);
  input.click();
}

export function openIcsPreview(events, fileName = 'the file') {
  const { db } = app;
  const existing = new Set(db.listBlocks().map((b) => b.uid).filter(Boolean));
  const rows = events.map((event) => ({
    event,
    duplicate: Boolean(event.uid) && existing.has(event.uid),
    chosen: !event.problem && !(event.uid && existing.has(event.uid)),
  }));
  return openDialog({
    title: 'Import from a calendar file',
    className: 'dialog-block',
    build: (close) => {
      const el = h('div');
      const count = () => rows.filter((r) => r.chosen).length;
      const addButton = h('button', { class: 'btn btn-primary', type: 'button' });
      const refresh = () => {
        addButton.textContent = `Import ${plural(count(), 'event')}`;
        addButton.disabled = count() === 0;
      };
      addButton.addEventListener('click', () => {
        const chosen = rows.filter((r) => r.chosen).map((r) => r.event);
        const { undo } = db.undoable(() => {
          for (const event of chosen) db.createBlock(eventToBlock(event));
        });
        toast(`Imported ${plural(chosen.length, 'event')}`, { undo });
        close(true);
      });
      const importable = rows.filter((r) => !r.event.problem).length;
      fill(el,
        h('p', { class: 'dialog-text' }, events.length
          ? `${fileName} has ${plural(events.length, 'event')}. Choose which to add to your timetable.`
          : `${fileName} has no events in it.`),
        importable > 1 && h('div', { class: 'settings-actions' },
          h('button', {
            class: 'btn btn-small',
            type: 'button',
            onClick: () => {
              for (const [i, r] of rows.entries()) {
                r.chosen = !r.event.problem;
                el.querySelectorAll('.ics-row input')[i].checked = r.chosen;
              }
              refresh();
            },
          }, 'Choose all'),
          h('button', {
            class: 'btn btn-small',
            type: 'button',
            onClick: () => {
              for (const [i, r] of rows.entries()) {
                r.chosen = false;
                el.querySelectorAll('.ics-row input')[i].checked = false;
              }
              refresh();
            },
          }, 'Choose none')),
        h('ul', { class: 'ics-list' }, rows.map((row) => h('li', { class: `ics-row${row.event.problem ? ' is-blocked' : ''}` },
          h('label', { class: 'ics-label' },
            h('input', {
              type: 'checkbox',
              checked: row.chosen,
              disabled: Boolean(row.event.problem),
              onChange: (event) => {
                row.chosen = event.target.checked;
                refresh();
              },
            }),
            h('span', { class: 'ics-main' },
              h('span', { class: 'ics-title' }, row.event.title),
              h('span', { class: 'ics-when' }, describeEvent(row.event), row.event.location && ` · ${row.event.location}`),
              row.event.problem && h('span', { class: 'ics-problem' }, `Can’t import: ${row.event.problem}`),
              row.duplicate && h('span', { class: 'ics-problem' }, 'Already in your timetable from an earlier import.')))))),
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
          addButton));
      refresh();
      return el;
    },
  });
}

// -- Tasks to give a time ------------------------------------------------------------------

/** The task a block refers to: { item, note, noteTitle }, or null if it's gone. */
export function findTask(db, ref) {
  if (!ref) return null;
  const note = db.getNote(ref.noteId);
  if (!note || note.trashedAt) return null;
  const type = db.getType(note.typeId);
  const field = type.fields.find((f) => f.id === ref.fieldId);
  if (!field) return null;
  const found = locate(fieldValue(note, field), ref.taskId);
  return found ? { item: found.item, note, noteTitle: displayTitle(note, type) || 'Untitled' } : null;
}

/**
 * Open tasks that don't have a time on the timetable today or later, soonest due first:
 * [{ item, noteId, fieldId, noteTitle }]. A task scheduled on a past day and not done comes back.
 */
export function tasksToSchedule(db, today = toDateStr()) {
  const scheduled = new Set(db.listBlocks().filter((b) => b.task && b.date >= today).map((b) => b.task.taskId));
  const all = collectTasks(allTaskNotes()).filter((entry) => !entry.item.done && !scheduled.has(entry.item.id));
  return all.sort((a, b) => (a.item.due || '9999').localeCompare(b.item.due || '9999') || (b.item.priority ?? 0) - (a.item.priority ?? 0));
}

