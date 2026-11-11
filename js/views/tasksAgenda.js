/**
 * tasksAgenda.js: tasks across many notes. Tabs for each list, Today, Upcoming, Overdue and Done.
 * Used on checklist collections and on the global Today page.
 */
import { app } from '../context.js';
import { relativeDay, toDateStr } from '../data/dates.js';
import { fieldValue } from '../data/fieldKinds.js';
import { eventEntries, toggleEventDone } from '../data/googleCalendar.js';
import { agendaBuckets, flatten, locate, progress, removeTask, toggleTask } from '../data/tasks.js';
import { agendaTitle, displayTitle, dueIsOpen, tasksFields } from '../data/types.js';
import { fill, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { emptyState } from './noteList.js';
import { progressBar, taskChips } from './tasksField.js';

/** Every task in the given notes: [{ item, parent, noteId, fieldId, noteTitle }]. */
export function collectTasks(notes) {
  const entries = [];
  for (const note of notes) {
    const type = app.db.getType(note.typeId);
    for (const field of tasksFields(type)) {
      for (const entry of flatten(fieldValue(note, field))) {
        entries.push({
          ...entry, noteId: note.id, fieldId: field.id, noteTitle: displayTitle(note, type) || 'Untitled',
        });
      }
    }
  }
  return entries;
}

/** Every active note that has a task list or a deadline, across all spaces. */
export function allTaskNotes() {
  return app.db.listNotes().filter((note) => {
    const type = app.db.getType(note.typeId);
    return type.fields.some((f) => f.kind === 'tasks' || f.role === 'due');
  });
}

/** Deadlines such as a goal's, shown like tasks. They are finished in the note itself. */
export function collectDeadlines(notes) {
  const entries = [];
  for (const note of notes) {
    const type = app.db.getType(note.typeId);
    for (const field of type.fields) {
      if (field.role === 'due') {
        const due = fieldValue(note, field);
        const progressField = type.fields.find((f) => f.id === 'progress');
        const finished = (progressField && fieldValue(note, progressField) >= 100) || !dueIsOpen(note, type, field);
        if (due && !finished) {
          const title = displayTitle(note, type) || 'Untitled';
          entries.push({
            item: {
              id: `${note.id}:${field.id}`, text: `${field.dueLabel ?? field.name}: ${agendaTitle(note, type)}`, due, done: false, priority: 0, children: [],
            },
            parent: null,
            noteId: note.id,
            noteTitle: title,
            isDeadline: true,
          });
        }
      }
    }
  }
  return entries;
}

/** Everything with a date across all notes, sorted into the agenda's lists. */
export function globalBuckets(today = toDateStr()) {
  const notes = allTaskNotes();
  return agendaBuckets([...collectTasks(notes), ...collectDeadlines(notes), ...eventEntries(app.db, today)], today);
}

export function tickTask(entry, today = toDateStr()) {
  if (entry.isEvent) {
    toggleEventDone(app.db, entry.item.id);
    return;
  }
  let next;
  app.db.updateTasks(entry.noteId, entry.fieldId, (items) => {
    next = toggleTask(items, entry.item.id, { today });
    return next;
  });
  if (entry.item.repeat && !entry.item.done) {
    toast(`Done. Next due ${relativeDay(locate(next, entry.item.id).item.due, today)}.`);
  }
}

export function deleteTask(entry) {
  const { undo } = app.db.undoable(() => app.db.updateTasks(entry.noteId, entry.fieldId, (items) => removeTask(items, entry.item.id)));
  toast('Task deleted', { undo });
}

function eventSource(entry) {
  return entry.url
    ? h('a', {
      class: 'task-source', href: entry.url, target: '_blank', rel: 'noopener noreferrer',
    }, entry.noteTitle)
    : h('span', { class: 'task-source' }, entry.noteTitle);
}

export function agendaRow(entry, today, { onDelete } = {}) {
  const { item, parent } = entry;
  return h('li', { class: `task-row${item.done ? ' is-done' : ''}`, dataset: { id: item.id } },
    h('div', { class: 'task-main' },
      entry.isDeadline
        ? h('span', { class: 'task-deadline', title: 'Deadline' }, icon('flag', 15))
        : h('input', {
          class: 'task-check',
          type: 'checkbox',
          checked: item.done,
          'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${item.text || 'task'}`,
          onChange: () => tickTask(entry, today),
        }),
      h('span', { class: 'task-label' },
        item.text || 'New task',
        parent && h('span', { class: 'task-parent' }, ` · ${parent.text || 'Task'}`),
        entry.isEvent
          ? eventSource(entry)
          : h('a', { class: 'task-source', href: `#/note/${encodeURIComponent(entry.noteId)}` }, entry.noteTitle)),
      h('div', { class: 'task-chips' }, taskChips(item, today)),
      // Deadlines and calendar events are changed where they live, so they only keep the column lined up.
      onDelete && (entry.isDeadline || entry.isEvent) && h('span', { class: 'task-more-slot' }),
      onDelete && !entry.isDeadline && !entry.isEvent && h('button', {
        class: 'icon-btn task-more',
        type: 'button',
        'aria-label': `Delete task: ${item.text || 'task'}`,
        title: 'Delete task',
        onClick: () => onDelete(entry),
      }, icon('trash', 15))));
}

/**
 * getNotes returns the current notes, so a refresh always shows fresh data.
 *   initialTab        which tab opens first
 *   showLists         offer the tab listing each checklist
 *   includeDeadlines  also list deadlines such as a goal's
 *   dayList           works as a to-do list: tasks can be deleted, and those finished today stay in view
 * With no Lists tab, Today also shows anything overdue, since that needs doing first.
 */
export function tasksAgendaView({
  getNotes, onNew, initialTab = 'lists', showLists = true, includeDeadlines = false, dayList = false,
}) {
  let tab = initialTab;
  let focusAfterDelete = null;
  const el = h('div', { class: 'agenda' });

  function onDelete(entry) {
    // Keeps keyboard users in the list: the next row takes over, or the tabs if it was the last.
    const row = el.querySelector(`[data-id="${CSS.escape(entry.item.id)}"]`);
    const neighbor = row?.nextElementSibling ?? row?.previousElementSibling;
    focusAfterDelete = neighbor?.dataset.id ?? '';
    deleteTask(entry);
  }

  function render() {
    const notes = getNotes();
    const today = toDateStr();
    const entries = [...collectTasks(notes), ...(includeDeadlines ? [...collectDeadlines(notes), ...eventEntries(app.db, today)] : [])];
    const buckets = agendaBuckets(entries, today);
    const focusedId = el.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;

    const tabs = [
      ...(showLists ? [['lists', 'Lists', notes.length]] : []),
      ['today', 'Today', buckets.today.length + (showLists ? 0 : buckets.overdue.length)],
      ['upcoming', 'Upcoming', buckets.upcoming.length],
      ['overdue', 'Overdue', buckets.overdue.length],
      ['done', 'Done', buckets.done.length],
    ];

    let body;
    if (tab === 'lists') {
      body = notes.length
        ? h('ul', { class: 'list-cards' }, notes.map((note) => {
          const type = app.db.getType(note.typeId);
          const items = tasksFields(type).flatMap((field) => fieldValue(note, field));
          return h('li', { class: 'list-card', dataset: { id: note.id } },
            h('a', { class: 'list-card-link', href: `#/note/${encodeURIComponent(note.id)}` },
              h('span', { class: 'card-title' }, displayTitle(note, type) || 'Untitled'),
              items.length
                ? progressBar(progress(items), 'Progress')
                : h('span', { class: 'card-preview' }, 'No tasks yet')));
        }))
        : emptyState({
          emoji: '✅',
          title: 'No lists yet',
          text: 'Make a list for each project or area, and its tasks show up in Today, Upcoming and Overdue here.',
          action: h('button', { class: 'btn btn-primary', type: 'button', onClick: onNew }, 'New list'),
        });
    } else {
      const overdueFirst = !showLists && tab === 'today';
      const rows = overdueFirst ? [...buckets.overdue, ...buckets.today] : buckets[tab];
      const doneToday = dayList && tab === 'today' ? buckets.done.filter((entry) => entry.item.doneAt && toDateStr(entry.item.doneAt) === today) : [];
      const options = dayList ? { onDelete } : {};
      const list = (items) => h('ul', { class: 'task-list agenda-list' }, items.map((entry) => agendaRow(entry, today, options)));
      let open;
      if (rows.length) open = list(rows);
      else if (doneToday.length) open = h('p', { class: 'empty-line' }, 'All done for today.');
      else {
        open = emptyState({
          title: {
            today: 'Nothing due today', upcoming: 'No upcoming dates', overdue: 'Nothing overdue', done: 'Nothing completed yet',
          }[tab],
          text: {
            today: dayList ? 'Type a task above and press Enter. Anything due today in your other lists appears here too.' : '',
            done: 'Completed tasks appear here.',
          }[tab] || 'Tasks with a due date appear here. Open a task’s details to set one.',
        });
      }
      body = [open, doneToday.length > 0 && h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Done today'),
        list(doneToday))];
    }

    fill(el,
      h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter tasks' },
        tabs.map(([id, label, count]) => h('button', {
          class: 'tab',
          type: 'button',
          'aria-pressed': String(tab === id),
          onClick: () => {
            tab = id;
            render();
          },
        }, label, count > 0 && h('span', { class: `tab-count${id === 'overdue' ? ' tab-count-alert' : ''}` }, count)))),
      body);

    if (focusAfterDelete !== null) {
      const target = focusAfterDelete ? el.querySelector(`[data-id="${CSS.escape(focusAfterDelete)}"] input, [data-id="${CSS.escape(focusAfterDelete)}"] a`) : null;
      (target ?? el.querySelector('.tab'))?.focus();
      focusAfterDelete = null;
    } else if (focusedId) el.querySelector(`[data-id="${CSS.escape(focusedId)}"] input, [data-id="${CSS.escape(focusedId)}"] a`)?.focus();
  }

  render();
  return {
    el,
    refresh: render,
    showToday: () => {
      tab = 'today';
      render();
    },
  };
}
