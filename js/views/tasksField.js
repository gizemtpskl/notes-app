/**
 * tasksField.js: the task list editor shown inside a note, for any field of kind "tasks".
 *
 * Keyboard: Enter adds a task below. Up and Down move between tasks. Backspace removes an empty
 * task. Alt+Up and Alt+Down reorder. Alt+Right makes a subtask and Alt+Left undoes that.
 */
import { relativeDay, toDateStr } from '../data/dates.js';
import {
  PRIORITIES, REPEATS, addSubtask, agendaBuckets, createTask, flatten, indentTask, insertTaskAfter, locate,
  moveRelative, outdentTask, progress, removeTask, shiftTask, taskTimeLabel, toggleTask, updateTask,
} from '../data/tasks.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pointerDrag } from '../ui/pointerDrag.js';
import { toast } from '../ui/toast.js';

export function progressBar({ done, total, ratio }, label = 'Progress') {
  return h('div', { class: 'progress' },
    h('div', {
      class: 'progress-track',
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': String(total),
      'aria-valuenow': String(done),
    }, h('div', { class: 'progress-fill', cssVars: { '--progress': `${ratio * 100}%` } })),
    h('span', { class: 'progress-text' }, `${done} of ${total}`));
}

/** Small labels for a task's date, priority and repeat. */
export function taskChips(item, today) {
  const chips = [];
  if (item.due) {
    const overdue = !item.done && item.due < today;
    chips.push(h('span', { class: `chip chip-date${overdue ? ' chip-overdue' : ''}${item.due === today ? ' chip-today' : ''}` },
      overdue && h('span', { class: 'sr-only' }, 'Overdue: '),
      relativeDay(item.due, today),
      item.time && ` ${taskTimeLabel(item)}`));
  }
  if (item.priority) {
    chips.push(h('span', { class: `chip chip-priority chip-priority-${item.priority}` }, icon('flag', 12), PRIORITIES.find((p) => p.value === item.priority).label));
  }
  if (item.repeat) {
    chips.push(h('span', { class: 'chip' }, icon('repeat', 12), REPEATS.find((r) => r.value === item.repeat).label));
  }
  return chips;
}

export function taskListField({ field, value, onChange, readOnly = false }) {
  let items = value;
  let tab = 'list';
  let openId = null; // the task whose date and priority controls are showing
  let completedOpen = false;
  let focusAfter = null; // { id, caret }

  const el = h('div', { class: 'tasks' });
  const today = () => toDateStr();

  function commit(next, { silent = false } = {}) {
    items = next;
    onChange(items);
    if (!silent) render();
  }

  function toggle(id) {
    const before = locate(items, id)?.item;
    const next = toggleTask(items, id, { today: today() });
    commit(next);
    if (before?.repeat && !before.done) {
      toast(`Done. Next due ${relativeDay(locate(next, id).item.due, today())}.`);
    }
  }

  function focusRow(id, caret = 'end') {
    const input = el.querySelector(`.task-row[data-id="${CSS.escape(id)}"] > .task-main .task-text`);
    if (input) {
      input.focus();
      const at = caret === 'end' ? input.value.length : caret;
      input.setSelectionRange(at, at);
    }
  }

  function visibleIds() {
    return [...el.querySelectorAll('.task-row[data-id]')].map((row) => row.dataset.id);
  }

  function neighbor(id, step) {
    const ids = visibleIds();
    return ids[ids.indexOf(id) + step] ?? null;
  }

  function onTextKey(event, item) {
    const input = event.currentTarget;
    if (event.isComposing) return;
    if (event.altKey) {
      const moves = {
        ArrowUp: () => shiftTask(items, item.id, -1),
        ArrowDown: () => shiftTask(items, item.id, 1),
        ArrowRight: () => indentTask(items, item.id),
        ArrowLeft: () => outdentTask(items, item.id),
      };
      if (moves[event.key]) {
        event.preventDefault();
        focusAfter = { id: item.id, caret: input.selectionStart };
        commit(moves[event.key]());
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const parent = locate(items, item.id)?.parent;
      // Enter on an empty subtask moves it out, the way lists work in text editors.
      if (parent && !input.value) {
        focusAfter = { id: item.id };
        commit(outdentTask(items, item.id));
        return;
      }
      const fresh = createTask();
      focusAfter = { id: fresh.id };
      commit(insertTaskAfter(items, item.id, fresh));
    } else if (event.key === 'Backspace' && !input.value) {
      event.preventDefault();
      const previous = neighbor(item.id, -1);
      focusAfter = previous ? { id: previous } : null;
      commit(removeTask(items, item.id));
      if (!previous) el.querySelector('.task-add')?.focus();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const target = neighbor(item.id, event.key === 'ArrowUp' ? -1 : 1);
      if (target) {
        event.preventDefault();
        focusRow(target);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        el.querySelector('.task-add')?.focus();
      }
    }
  }

  // -- Dragging --------------------------------------------------------------------------

  function attachDrag(handle, row, item) {
    let marker = null;
    let target = null;

    const clearMark = () => {
      marker?.remove();
      marker = null;
      target = null;
    };

    pointerDrag(handle, {
      start: () => {
        row.classList.add('is-dragging');
        document.body.classList.add('is-pointer-dragging');
      },
      move: (event) => {
        const rows = [...el.querySelectorAll('.tasks-open .task-row')].filter((r) => r !== row && !row.contains(r));
        let best = null;
        for (const candidate of rows) {
          const box = candidate.querySelector(':scope > .task-main').getBoundingClientRect();
          if (event.clientY >= box.top - 4 && event.clientY <= box.bottom + 4) {
            best = { row: candidate, box, position: event.clientY < box.top + box.height / 2 ? 'before' : 'after' };
          }
        }
        if (!best) return;
        target = { id: best.row.dataset.id, position: best.position };
        marker ??= h('div', { class: 'task-drop-marker' });
        const host = el.getBoundingClientRect();
        el.append(marker);
        marker.style.top = `${(best.position === 'before' ? best.box.top : best.box.bottom) - host.top}px`;
        marker.style.left = `${best.box.left - host.left}px`;
        marker.style.width = `${best.box.width}px`;
      },
      drop: () => {
        row.classList.remove('is-dragging');
        document.body.classList.remove('is-pointer-dragging');
        const chosen = target;
        clearMark();
        if (chosen) commit(moveRelative(items, item.id, chosen.id, chosen.position));
      },
      cancel: () => {
        row.classList.remove('is-dragging');
        document.body.classList.remove('is-pointer-dragging');
        clearMark();
      },
    });
  }

  // -- Rows ------------------------------------------------------------------------------

  function detailsPanel(item, parent) {
    const dueInput = h('input', {
      class: 'input input-small',
      type: 'date',
      value: item.due,
      // A time means nothing without a date.
      onChange: () => commit(updateTask(items, item.id, dueInput.value ? { due: dueInput.value } : { due: '', time: '' })),
    });
    const timeInput = h('input', {
      class: 'input input-small',
      type: 'time',
      value: item.time ?? '',
      onChange: () => {
        const patch = { time: timeInput.value };
        if (patch.time && !item.due) patch.due = today();
        commit(updateTask(items, item.id, patch));
      },
    });
    const prioritySelect = h('select', {
      class: 'select',
      onChange: () => commit(updateTask(items, item.id, { priority: Number(prioritySelect.value) })),
    }, PRIORITIES.map((p) => h('option', { value: p.value, selected: p.value === item.priority }, p.label)));
    const repeatSelect = h('select', {
      class: 'select',
      onChange: () => {
        const patch = { repeat: repeatSelect.value || null };
        // A repeat needs a date to count from.
        if (patch.repeat && !item.due) patch.due = today();
        commit(updateTask(items, item.id, patch));
      },
    }, REPEATS.map((r) => h('option', { value: r.value, selected: r.value === (item.repeat ?? '') }, r.label)));

    return h('div', { class: 'task-details' },
      h('label', { class: 'task-detail' }, h('span', null, 'Due'), dueInput),
      h('label', { class: 'task-detail' }, h('span', null, 'Time'), timeInput),
      h('label', { class: 'task-detail' }, h('span', null, 'Priority'), prioritySelect),
      h('label', { class: 'task-detail' }, h('span', null, 'Repeat'), repeatSelect),
      h('div', { class: 'task-detail-actions' },
        !parent && h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            const fresh = createTask();
            focusAfter = { id: fresh.id };
            commit(addSubtask(items, item.id, fresh));
          },
        }, icon('plus', 14), 'Subtask'),
        h('button', {
          class: 'btn btn-small btn-danger-quiet',
          type: 'button',
          onClick: () => {
            openId = null;
            commit(removeTask(items, item.id));
          },
        }, icon('trash', 14), 'Delete')));
  }

  function row(item, parent) {
    const name = item.text || 'task';
    const handle = h('button', {
      class: 'task-grip',
      type: 'button',
      tabindex: '-1',
      'aria-hidden': 'true',
      title: 'Drag to reorder',
    }, icon('grip', 14));
    const element = h('li', { class: `task-row${item.done ? ' is-done' : ''}`, dataset: { id: item.id } },
      h('div', { class: 'task-main' },
        !readOnly && handle,
        h('input', {
          class: 'task-check',
          type: 'checkbox',
          checked: item.done,
          disabled: readOnly,
          'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${name}`,
          onChange: () => {
            focusAfter = null;
            toggle(item.id);
          },
        }),
        h('input', {
          class: 'task-text',
          type: 'text',
          value: item.text,
          placeholder: 'New task',
          'aria-label': 'Task',
          readOnly,
          onInput: (event) => commit(updateTask(items, item.id, { text: event.target.value }), { silent: true }),
          onKeydown: (event) => onTextKey(event, item),
        }),
        h('div', { class: 'task-chips' }, taskChips(item, today())),
        !readOnly && h('button', {
          class: 'icon-btn task-more',
          type: 'button',
          'aria-label': `Details for ${name}`,
          'aria-expanded': String(openId === item.id),
          title: 'Date, priority and repeat',
          onClick: () => {
            openId = openId === item.id ? null : item.id;
            render();
          },
        }, icon('more', 16))),
      openId === item.id && !readOnly && detailsPanel(item, parent),
      item.children.length > 0 && h('ul', { class: 'task-list task-sublist' }, item.children.map((child) => row(child, item))));
    if (!readOnly) attachDrag(handle, element, item);
    return element;
  }

  function agendaRow({ item, parent }) {
    return h('li', { class: `task-row${item.done ? ' is-done' : ''}` },
      h('div', { class: 'task-main' },
        h('input', {
          class: 'task-check',
          type: 'checkbox',
          checked: item.done,
          disabled: readOnly,
          'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${item.text || 'task'}`,
          onChange: () => toggle(item.id),
        }),
        h('span', { class: 'task-label' },
          item.text || 'New task',
          parent && h('span', { class: 'task-parent' }, ` · ${parent.text || 'Task'}`)),
        h('div', { class: 'task-chips' }, taskChips(item, today()))));
  }

  // -- Rendering -------------------------------------------------------------------------

  function render() {
    const focused = el.contains(document.activeElement) && document.activeElement.classList.contains('task-add');
    const stats = progress(items);
    const entries = flatten(items);
    const buckets = agendaBuckets(entries, today());
    const open = items.filter((item) => !item.done);
    const done = items.filter((item) => item.done);
    const withTabs = field.primary;

    const tabs = [
      ['list', 'List', open.length],
      ['today', 'Today', buckets.today.length],
      ['upcoming', 'Upcoming', buckets.upcoming.length],
      ['overdue', 'Overdue', buckets.overdue.length],
      ['done', 'Done', buckets.done.length],
    ];

    const addInput = h('input', {
      class: 'task-add',
      type: 'text',
      placeholder: `Add ${field.primary ? 'a task' : field.name.toLowerCase()} and press Enter`,
      'aria-label': `Add to ${field.name}`,
      onKeydown: (event) => {
        if (event.key === 'Enter' && !event.isComposing && addInput.value.trim()) {
          event.preventDefault();
          const text = addInput.value.trim();
          addInput.value = '';
          commit([...items, createTask(text)]);
          el.querySelector('.task-add')?.focus();
        } else if (event.key === 'ArrowUp') {
          const ids = visibleIds();
          if (ids.length) {
            event.preventDefault();
            focusRow(ids.at(-1));
          }
        }
      },
    });

    let body;
    if (tab === 'list') {
      body = [
        open.length > 0 && h('ul', { class: 'task-list tasks-open' }, open.map((item) => row(item, null))),
        !readOnly && h('div', { class: 'task-add-row' }, icon('plus', 16), addInput),
        done.length > 0 && h('details', {
          class: 'tasks-done',
          open: completedOpen,
          onToggle: (event) => {
            completedOpen = event.currentTarget.open;
          },
        },
        h('summary', null, `Completed (${done.length})`),
        h('ul', { class: 'task-list' }, done.map((item) => row(item, null)))),
      ];
    } else {
      const rows = buckets[tab];
      body = rows.length
        ? h('ul', { class: 'task-list' }, rows.map(agendaRow))
        : h('p', { class: 'empty-line' }, {
          today: 'Nothing due today.', upcoming: 'No upcoming dates.', overdue: 'Nothing overdue.', done: 'Nothing completed yet.',
        }[tab]);
    }

    fill(el,
      stats.total > 0 && progressBar(stats, `${field.name} progress`),
      withTabs && h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter tasks' },
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

    if (focused) el.querySelector('.task-add')?.focus();
    if (focusAfter) {
      const { id, caret } = focusAfter;
      focusAfter = null;
      focusRow(id, caret ?? 'end');
    }
  }

  render();

  return {
    el,
    setValue(next) {
      items = next;
      render();
    },
    focus: () => el.querySelector('.task-add')?.focus(),
    summary: () => plural(progress(items).total, 'task'),
  };
}
