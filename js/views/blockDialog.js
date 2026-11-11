/**
 * blockDialog.js: creating and editing timetable blocks, and the timetable's own settings
 * (visible hours and semesters).
 *
 * Opening one occurrence of a repeating series asks first what to change: this occurrence only,
 * or all of them. Changing one occurrence never touches the rest of the series.
 */
import { app } from '../context.js';
import { addDays, formatDay, toDateStr } from '../data/dates.js';
import { SPACE_COLORS, SPACE_COLOR_NAMES } from '../data/schema.js';
import { toggleTask } from '../data/tasks.js';
import {
  BLOCK_TYPES, REMINDERS, WEEK_RULES, blockProblem, changeFromSeries, conflictsWith, createTimeBlock, occurrencesBetween,
  sessionNumber, weekday,
} from '../data/timetable.js';
import { displayTitle } from '../data/types.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { focusTargetForBlock, startFocusDialog } from './focus.js';
import { pickDestination, pickNote } from './dialogs.js';
import { homeForType } from './palette.js';
import { findTask } from './timetableTools.js';

export const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 10, 8 + d)));
const WEEKDAY_SHORT = Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 10, 8 + d)));
const CONFLICT_WEEKS = 26;

export const weekdayName = (date) => WEEKDAY_NAMES[weekday(date)];

const typeLabel = (value) => BLOCK_TYPES.find((t) => t.value === value)?.label ?? 'Other';

function lookups(db) {
  return {
    semesters: new Map(db.listSemesters().map((s) => [s.id, s])),
    spaces: new Map(db.listSpaces().map((s) => [s.id, s])),
  };
}

/** Other blocks that overlap this draft over the coming weeks, as short lines. */
function conflictLines(db, draft, { blockId, originalDate, day = null }) {
  if (blockProblem(draft)) return [];
  const options = lookups(db);
  const from = day ?? draft.date;
  const to = day ?? addDays(draft.date, draft.repeat ? CONFLICT_WEEKS * 7 : 0);
  const id = blockId ?? '__draft';
  const mine = occurrencesBetween([{ ...createTimeBlock({ ...draft, id }), exceptions: draft.exceptions ?? {} }], from, to, options)
    .filter((o) => !originalDate || o.originalDate === originalDate);
  const others = occurrencesBetween(db.listBlocks().filter((b) => b.id !== blockId || originalDate), from, to, options)
    .filter((o) => !(originalDate && o.blockId === blockId && o.originalDate === originalDate));
  return conflictsWith(mine, others).map((o) => `${o.title}, ${formatDay(o.date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${o.start}–${o.end}`);
}

function describeLink(db, block) {
  const parts = [];
  const space = block.spaceId && db.getSpace(block.spaceId);
  const collection = block.collectionId && db.getCollection(block.collectionId);
  if (space) parts.push(`${space.icon} ${space.name}`);
  if (collection) parts.push(collection.name);
  return parts.join(' › ');
}

/** For a drag or resize of a repeating block: 'one', 'all', or null when cancelled. */
export function askScope(title, date) {
  return openDialog({
    title: `Move “${title}”`,
    build: (close) => h('div', null,
      h('p', { class: 'dialog-text' }, 'This block repeats. What should change?'),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn', type: 'button', onClick: () => close('all') }, 'All occurrences'),
        h('button', {
          class: 'btn btn-primary', type: 'button', autofocus: true, onClick: () => close('one'),
        }, `Only ${formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' })}`))),
  }).then((answer) => answer ?? null);
}

/**
 * Makes the note for one session of a block, such as a lecture: a course note for a class or
 * study session, with its date and lecture number, otherwise a plain note. It goes where the block
 * is linked to. Returns the note.
 */
export function createSessionNote(blockId, originalDate) {
  const { db } = app;
  const block = db.getBlock(blockId);
  const date = block.exceptions?.[originalDate]?.date ?? originalDate;
  const semesters = new Map(db.listSemesters().map((s) => [s.id, s]));
  const isCourse = ['class', 'study'].includes(block.type);
  const where = block.collectionId
    ? { collectionId: block.collectionId }
    : block.spaceId ? { spaceId: block.spaceId } : isCourse ? homeForType('course') : {};
  const title = `${block.title}, ${formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const { result: note, undo } = db.undoable(() => {
    let made;
    if (isCourse) {
      made = db.createFromTemplate('tpl-lecture-note', where);
      const number = sessionNumber(block, originalDate, semesters);
      made = db.updateNote(made.id, { title, fields: { ...made.fields, date, ...(number ? { lecture: number } : {}) } });
    } else {
      made = db.createNote({ title, ...where });
    }
    db.updateBlock(block.id, { sessions: { ...block.sessions, [originalDate]: made.id } });
    return made;
  });
  toast('Note made for this session', { undo });
  return note;
}

function duplicateDialog(block) {
  const { db } = app;
  return openDialog({
    title: `Copy “${block.title}” to another day`,
    build: (close) => {
      const date = h('input', { class: 'input', type: 'date', required: true, value: addDays(block.date, 1), autofocus: true });
      const error = h('p', { class: 'field-error', role: 'alert' });
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          try {
            const day = date.value;
            const { undo } = db.undoable(() => db.createBlock({
              ...block,
              id: undefined,
              date: day,
              repeat: block.repeat && { ...block.repeat, days: [weekday(day)] },
              exceptions: {},
              sessions: {},
              uid: '',
              task: null,
            }));
            toast(`Copied to ${formatDay(day, { weekday: 'long', month: 'short', day: 'numeric' })}`, { undo });
            close(day);
          } catch (problem) {
            error.textContent = problem.message;
          }
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, block.repeat ? 'First day of the copy (it repeats on that weekday)' : 'Day'), date),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Copy')));
    },
  });
}

function reminderHint() {
  if (!('Notification' in window)) return 'Reminders appear inside the app while it’s open. This browser can’t show notifications.';
  if (Notification.permission === 'denied') return 'Notifications are blocked for this site, so reminders appear inside the app only, while it’s open.';
  return 'Reminders appear while the app is open in a tab, as a notification if you allow it.';
}

/**
 * Opens the editor.
 *   openBlockDialog({ draft })                      a new block, with some values filled in
 *   openBlockDialog({ blockId, originalDate })       an existing block, at one occurrence
 */
export function openBlockDialog({ draft = null, blockId = null, originalDate = null }) {
  const { db } = app;
  const stored = blockId ? db.getBlock(blockId) : null;
  if (blockId && !stored) {
    toast('That block no longer exists.');
    return Promise.resolve();
  }
  const isSeries = Boolean(stored?.repeat);
  let scope = isSeries ? 'one' : 'all';

  return openDialog({
    title: stored ? 'Edit block' : 'New block',
    className: 'dialog-block',
    build: (close) => {
      const el = h('div');
      // The block as it will be saved, kept between switches of scope.
      const seriesDraft = stored
        ? structuredClone(stored)
        : createTimeBlock({
          date: toDateStr(), ...draft, title: draft?.title ?? '',
        });
      if (!stored && !draft?.title) seriesDraft.title = '';
      const exception = stored && originalDate ? stored.exceptions?.[originalDate] ?? null : null;
      const oneDraft = stored && originalDate ? {
        date: exception?.date ?? originalDate,
        start: exception?.start ?? stored.start,
        end: exception?.end ?? stored.end,
        title: exception?.title ?? stored.title,
        type: exception?.type ?? stored.type,
        location: exception?.location ?? stored.location,
        notes: exception?.notes ?? stored.notes,
      } : null;

      function render(focusSelector) {
        const editingOne = isSeries && scope === 'one';
        const values = editingOne ? oneDraft : seriesDraft;
        const error = h('p', { class: 'field-error', role: 'alert' });
        const conflicts = h('div', { class: 'block-conflicts', role: 'status' });

        const showConflicts = () => {
          const lines = editingOne
            ? conflictLines(db, { ...seriesDraft, exceptions: { [originalDate]: { ...oneDraft } } }, { blockId, originalDate, day: oneDraft.date })
            : conflictLines(db, seriesDraft, { blockId: stored?.id ?? null });
          fill(conflicts, lines.length > 0 && [
            h('p', { class: 'block-conflicts-title' }, icon('flag', 14), lines.length === 1 ? 'This overlaps with:' : `This overlaps ${plural(lines.length, 'time')}:`),
            h('ul', null, lines.slice(0, 3).map((line) => h('li', null, line))),
            lines.length > 3 && h('p', null, `and ${lines.length - 3} more.`),
          ]);
        };

        const input = (key, props = {}) => h('input', {
          class: 'input',
          value: values[key] ?? '',
          ...props,
          onInput: (event) => {
            values[key] = event.target.value;
            if (props.onInput) props.onInput(event);
          },
          onChange: () => showConflicts(),
        });

        const title = input('title', { type: 'text', maxlength: 300, placeholder: 'Deep Learning, German, Shift…', autofocus: true });
        const typeSelect = h('select', {
          class: 'select',
          onChange: (event) => {
            values.type = event.target.value;
          },
        }, BLOCK_TYPES.map((t) => h('option', { value: t.value, selected: t.value === values.type }, t.label)));

        const timeRow = h('div', { class: 'field-row block-time-row' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, editingOne || !seriesDraft.repeat ? 'Day' : 'Starts on'),
            input('date', { type: 'date', required: true })),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'From'), input('start', { type: 'time', step: 300, required: true })),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'To'), input('end', { type: 'time', step: 300, required: true })));

        const seriesFields = editingOne ? null : repeatFields();

        const linkLine = h('span', { class: 'block-link-text' });
        const noteLine = h('span', { class: 'block-link-text' });
        const drawLinks = () => {
          fill(linkLine, describeLink(db, seriesDraft) || 'None');
          const note = seriesDraft.noteId && db.getNote(seriesDraft.noteId);
          fill(noteLine, note
            ? h('a', { href: `#/note/${encodeURIComponent(note.id)}`, onClick: () => close() }, displayTitle(note, db.getType(note.typeId)) || 'Untitled')
            : 'None');
        };
        drawLinks();

        const extras = editingOne ? null : h('div', { class: 'block-links' },
          h('div', { class: 'block-link' },
            h('span', { class: 'field-label' }, 'Space or collection'), linkLine,
            h('button', {
              class: 'btn btn-small',
              type: 'button',
              onClick: async () => {
                const target = await pickDestination({ title: 'Link this block to', includeInbox: false });
                if (target) {
                  seriesDraft.spaceId = target.spaceId;
                  seriesDraft.collectionId = target.collectionId;
                  drawLinks();
                }
              },
            }, 'Choose'),
            (seriesDraft.spaceId || seriesDraft.collectionId) && h('button', {
              class: 'btn btn-small btn-quiet',
              type: 'button',
              onClick: (event) => {
                seriesDraft.spaceId = null;
                seriesDraft.collectionId = null;
                drawLinks();
                event.target.remove();
              },
            }, 'Clear')),
          h('div', { class: 'block-link' },
            h('span', { class: 'field-label' }, 'Note'), noteLine,
            h('button', {
              class: 'btn btn-small',
              type: 'button',
              onClick: async () => {
                const id = await pickNote({ title: 'Link a note to this block' });
                if (id) {
                  seriesDraft.noteId = id;
                  drawLinks();
                }
              },
            }, 'Choose')),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'),
            h('select', {
              class: 'select',
              onChange: (event) => {
                seriesDraft.color = event.target.value;
              },
            },
            h('option', { value: '', selected: !seriesDraft.color }, 'The space’s color'),
            SPACE_COLORS.map((color) => h('option', { value: color, selected: color === seriesDraft.color }, SPACE_COLOR_NAMES[color])))));

        function repeatFields() {
          const box = h('div', { class: 'block-repeat' });
          const drawRepeat = () => {
            const { repeat } = seriesDraft;
            const semesters = db.listSemesters();
            fill(box,
              h('label', { class: 'check-field' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(repeat),
                  onChange: (event) => {
                    seriesDraft.repeat = event.target.checked ? { days: [weekday(seriesDraft.date)], weeks: 'every', until: '' } : null;
                    drawRepeat();
                    showConflicts();
                    box.querySelector('input[type=checkbox]').focus();
                  },
                }), 'Repeats every week'),
              repeat && h('fieldset', { class: 'block-days' },
                h('legend', { class: 'field-label' }, 'On'),
                [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'day-toggle' },
                  h('input', {
                    type: 'checkbox',
                    checked: repeat.days.includes(d),
                    'aria-label': WEEKDAY_NAMES[d],
                    onChange: (event) => {
                      const days = new Set(repeat.days);
                      if (event.target.checked) days.add(d);
                      else days.delete(d);
                      repeat.days = [...days].sort();
                      showConflicts();
                    },
                  }),
                  h('span', { 'aria-hidden': 'true' }, WEEKDAY_SHORT[d])))),
              repeat && h('div', { class: 'field-row' },
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Weeks'),
                  h('select', {
                    class: 'select',
                    onChange: (event) => {
                      repeat.weeks = event.target.value;
                      showConflicts();
                    },
                  }, WEEK_RULES.map((rule) => h('option', { value: rule.value, selected: rule.value === repeat.weeks }, rule.label)))),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Semester'),
                  h('select', {
                    class: 'select',
                    onChange: (event) => {
                      seriesDraft.semesterId = event.target.value;
                      showConflicts();
                    },
                  },
                  h('option', { value: '', selected: !seriesDraft.semesterId }, 'None'),
                  semesters.map((s) => h('option', { value: s.id, selected: s.id === seriesDraft.semesterId }, `${s.name} (until ${formatDay(s.end)})`)))),
                h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Last day (optional)'),
                  h('input', {
                    class: 'input',
                    type: 'date',
                    value: repeat.until,
                    onChange: (event) => {
                      repeat.until = event.target.value;
                      showConflicts();
                    },
                  }))));
          };
          drawRepeat();
          return box;
        }

        const task = seriesDraft.task ? findTask(db, seriesDraft.task) : null;
        const taskSection = seriesDraft.task && h('div', { class: 'block-task' },
          task
            ? [
              h('label', { class: 'check-field' },
                h('input', {
                  type: 'checkbox',
                  checked: task.item.done,
                  onChange: () => db.updateTasks(seriesDraft.task.noteId, seriesDraft.task.fieldId, (items) => toggleTask(items, seriesDraft.task.taskId, { today: toDateStr() })),
                }), 'Task done'),
              h('span', { class: 'block-task-from' }, 'From ', h('a', { href: `#/note/${encodeURIComponent(task.note.id)}`, onClick: () => close() }, task.noteTitle))]
            : h('p', { class: 'settings-text' }, 'The task this block was for no longer exists.'));

        const sessionNote = stored && originalDate && stored.sessions?.[originalDate] && db.getNote(stored.sessions[originalDate]);
        const isCourse = ['class', 'study'].includes(stored?.type);
        const sessionSection = stored && originalDate && !stored.task && h('div', { class: 'block-session' },
          sessionNote
            ? h('a', { class: 'btn btn-small', href: `#/note/${encodeURIComponent(sessionNote.id)}`, onClick: () => close() }, icon('note', 15), isCourse ? 'Open the lecture note' : 'Open the note for this session')
            : h('button', {
              class: 'btn btn-small',
              type: 'button',
              onClick: () => {
                const note = createSessionNote(stored.id, originalDate);
                close(true);
                location.hash = `#/note/${encodeURIComponent(note.id)}`;
              },
            }, icon('note', 15), isCourse ? 'Write the lecture note' : 'Write a note for this session'));

        const reminderSection = !editingOne && h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Reminder'),
          h('select', {
            class: 'select',
            'aria-describedby': 'reminder-hint',
            onChange: (event) => {
              seriesDraft.reminder = event.target.value ? Number(event.target.value) : null;
              // Asked here, while there's a click to answer, and only once a reminder is wanted.
              if (seriesDraft.reminder && 'Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission().then(() => {
                  const hint = el.querySelector('#reminder-hint');
                  if (hint) hint.textContent = reminderHint();
                }).catch(() => {});
              }
            },
          },
          h('option', { value: '', selected: !seriesDraft.reminder }, 'None'),
          REMINDERS.map((minutes) => h('option', { value: minutes, selected: minutes === seriesDraft.reminder }, `${minutes} minutes before`))),
          h('span', { class: 'field-hint', id: 'reminder-hint' }, reminderHint()));

        const save = () => {
          error.textContent = '';
          try {
            if (editingOne) {
              const change = changeFromSeries(stored, originalDate, { ...oneDraft, title: oneDraft.title.trim() || stored.title });
              const problem = blockProblem({ ...stored, ...oneDraft, repeat: null });
              if (problem) throw new Error(problem);
              const { undo } = db.undoable(() => db.setOccurrence(stored.id, originalDate, Object.keys(change).length ? change : null));
              toast('This occurrence changed', { undo });
            } else {
              const values = { ...seriesDraft, title: seriesDraft.title.trim() };
              const problem = blockProblem(values);
              if (problem) throw new Error(problem);
              if (stored) {
                const { undo } = db.undoable(() => db.updateBlock(stored.id, values));
                toast(isSeries || values.repeat ? 'All occurrences changed' : 'Block saved', { undo });
              } else {
                const { undo } = db.undoable(() => db.createBlock(values));
                toast('Block added', { undo });
              }
            }
            close(true);
          } catch (problem) {
            error.textContent = problem.message;
          }
        };

        const actions = h('div', { class: 'dialog-actions block-actions' },
          stored && h('button', {
            class: 'btn',
            type: 'button',
            onClick: () => {
              close(false);
              startFocusDialog(focusTargetForBlock(stored));
            },
          }, icon('clock', 15), 'Start focus'),
          stored && editingOne && h('button', {
            class: 'btn btn-danger-quiet',
            type: 'button',
            onClick: () => {
              const { undo } = db.undoable(() => db.setOccurrence(stored.id, originalDate, exception?.cancelled ? null : { cancelled: true }));
              toast(exception?.cancelled ? 'This occurrence is back' : 'This occurrence is cancelled', { undo });
              close(true);
            },
          }, exception?.cancelled ? 'Restore this occurrence' : 'Cancel this occurrence'),
          stored && editingOne && exception && !exception.cancelled && h('button', {
            class: 'btn btn-quiet',
            type: 'button',
            onClick: () => {
              const { undo } = db.undoable(() => db.setOccurrence(stored.id, originalDate, null));
              toast('Back to the usual time', { undo });
              close(true);
            },
          }, 'Back to the usual time'),
          stored && !editingOne && !stored.task && h('button', {
            class: 'btn btn-quiet',
            type: 'button',
            onClick: async () => {
              close(false);
              await duplicateDialog(stored);
            },
          }, icon('copy', 15), 'Copy to another day'),
          stored && !editingOne && h('button', {
            class: 'btn btn-danger-quiet',
            type: 'button',
            onClick: async () => {
              if (stored.task) {
                const { undo } = db.undoable(() => db.deleteBlock(stored.id));
                toast('Back in your task list', { undo });
                close(true);
                return;
              }
              if (isSeries && !await confirmDialog({
                title: 'Delete every occurrence?', message: `“${stored.title}” disappears from every week.`, confirmLabel: 'Delete all', danger: true,
              })) return;
              const { undo } = db.undoable(() => db.deleteBlock(stored.id));
              toast(isSeries ? 'Series deleted' : 'Block deleted', { undo });
              close(true);
            },
          }, icon('trash', 15), stored?.task ? 'Unschedule' : isSeries ? 'Delete all' : 'Delete'),
          h('span', { class: 'block-actions-gap' }),
          h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'));

        fill(el, h('form', {
          onSubmit: (event) => {
            event.preventDefault();
            save();
          },
        },
        isSeries && h('fieldset', { class: 'block-scope' },
          h('legend', { class: 'field-label' }, 'Change'),
          [['one', `Only this occurrence (${formatDay(originalDate, { weekday: 'short', month: 'short', day: 'numeric' })})`], ['all', 'All occurrences']].map(([value, label]) => h('label', { class: 'check-field' },
            h('input', {
              type: 'radio',
              name: 'block-scope',
              value,
              checked: scope === value,
              onChange: () => {
                scope = value;
                render(`input[value="${value}"]`);
              },
            }), label))),
        exception?.cancelled && editingOne && h('p', { class: 'dialog-text block-cancelled-note' }, 'This occurrence is cancelled.'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
        h('div', { class: 'field-row' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Kind'), typeSelect),
          h('label', { class: 'field block-location' }, h('span', { class: 'field-label' }, 'Location'), input('location', { type: 'text', maxlength: 300 }))),
        taskSection,
        timeRow,
        seriesFields,
        reminderSection,
        sessionSection,
        extras,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Notes'),
          h('textarea', {
            class: 'input block-notes',
            rows: '2',
            onInput: (event) => {
              values.notes = event.target.value;
            },
          }, values.notes ?? '')),
        conflicts,
        error,
        actions));
        showConflicts();
        if (focusSelector) el.querySelector(focusSelector)?.focus();
      }

      render();
      return el;
    },
  });
}

/** The timetable's settings: which hours the grid shows, and the semesters. */
export function openTimetableSettings() {
  const { db } = app;
  return openDialog({
    title: 'Timetable settings',
    className: 'dialog-block',
    build: () => {
      const el = h('div');
      function render(focusSelector) {
        const settings = db.getSettings();
        const hours = { start: 7, end: 22, ...settings.timetableHours };
        const hourSelect = (key, label, min, max) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
          h('select', {
            class: 'select',
            dataset: { focusKey: key },
            onChange: (event) => {
              const next = { ...hours, [key]: Number(event.target.value) };
              if (next.end <= next.start) next[key === 'start' ? 'end' : 'start'] = key === 'start' ? next.start + 1 : next.end - 1;
              db.updateSettings({ timetableHours: next });
              render(`[data-focus-key="${key}"]`);
            },
          }, Array.from({ length: max - min + 1 }, (_, i) => min + i).map((hour) => h('option', { value: hour, selected: hour === hours[key] }, `${String(hour).padStart(2, '0')}:00`))));

        const name = h('input', { class: 'input', type: 'text', maxlength: 120, placeholder: 'Fall 2026', 'aria-label': 'Semester name' });
        const start = h('input', { class: 'input', type: 'date', 'aria-label': 'First day' });
        const end = h('input', { class: 'input', type: 'date', 'aria-label': 'Last day' });
        const error = h('p', { class: 'field-error', role: 'alert' });
        const semesters = db.listSemesters();

        fill(el,
          h('section', { class: 'settings-section' },
            h('h3', { class: 'section-title' }, 'Hours shown'),
            h('div', { class: 'field-row' }, hourSelect('start', 'From', 0, 22), hourSelect('end', 'To', 1, 24)),
            h('p', { class: 'field-hint' }, 'Blocks outside these hours still appear: the grid stretches to fit them.')),
          h('section', { class: 'settings-section' },
            h('h3', { class: 'section-title' }, 'Semesters'),
            h('p', { class: 'settings-text' }, 'A repeating block in a semester stops by itself when the semester ends.'),
            semesters.length > 0 && h('ul', { class: 'semester-list' }, semesters.map((s) => h('li', { class: 'semester-row' },
              h('span', { class: 'semester-name' }, s.name),
              h('span', { class: 'semester-dates' }, `${formatDay(s.start)} – ${formatDay(s.end)}`),
              h('button', {
                class: 'icon-btn',
                type: 'button',
                'aria-label': `Delete ${s.name}`,
                title: 'Delete',
                onClick: async () => {
                  if (!await confirmDialog({
                    title: `Delete ${s.name}?`,
                    message: 'Its repeating blocks keep their dates, and still stop on its last day.',
                    confirmLabel: 'Delete',
                    danger: true,
                  })) return;
                  const { undo } = db.undoable(() => db.deleteSemester(s.id));
                  toast('Semester deleted', { undo });
                  render('.semester-form input');
                },
              }, icon('trash', 15))))),
            h('form', {
              class: 'semester-form',
              onSubmit: (event) => {
                event.preventDefault();
                try {
                  db.createSemester({ name: name.value, start: start.value, end: end.value });
                  render('.semester-form input');
                } catch (problem) {
                  error.textContent = problem.message;
                }
              },
            },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
            h('div', { class: 'field-row' },
              h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'First day'), start),
              h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Last day'), end)),
            error,
            h('button', { class: 'btn', type: 'submit' }, icon('plus', 15), 'Add semester'))));
        if (focusSelector) el.querySelector(focusSelector)?.focus();
      }
      render();
      return el;
    },
  });
}

export { typeLabel };
