/**
 * today.js: the Today page: a daily to-do list. Tasks can be added right here, one at a time or as
 * a messy list to organize, and it also gathers every task and deadline due from all notes, with
 * what's overdue first.
 */
import { app } from '../context.js';
import { addDailyTask, addDailyTasks } from '../data/daily.js';
import { relativeDay, toDateStr } from '../data/dates.js';
import { h, longDate, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { calendarStatusLine } from './calendarSettings.js';
import { openOrganizeDialog } from './organizeDialog.js';
import { allTaskNotes, tasksAgendaView } from './tasksAgenda.js';

export function todayView() {
  const agenda = tasksAgendaView({
    getNotes: allTaskNotes,
    initialTab: 'today',
    showLists: false,
    includeDeadlines: true,
    dayList: true,
  });

  async function organize(text) {
    const today = toDateStr();
    const drafts = await openOrganizeDialog({ text, today });
    if (!drafts) return;
    input.value = '';
    const { undo } = app.db.undoable(() => addDailyTasks(app.db, drafts, today));
    toast(`Added ${plural(drafts.length, 'task')}`, { undo });
    agenda.showToday();
  }

  const calendarLine = calendarStatusLine();

  // Outside the agenda, so refreshing the list never takes away what's being typed.
  const input = h('input', {
    class: 'task-add',
    type: 'text',
    placeholder: 'Add a task, like 15.00 project meeting',
    'aria-label': 'Add a task for today. A time or a day in the text is picked up.',
    autocomplete: 'off',
    enterkeyhint: 'done',
    onKeydown: (event) => {
      if (event.key !== 'Enter' || event.isComposing || !input.value.trim()) return;
      event.preventDefault();
      const today = toDateStr();
      const { result: task, undo } = app.db.undoable(() => addDailyTask(app.db, input.value, today));
      input.value = '';
      agenda.showToday();
      // It won't appear in the list below, so say where it went.
      if (task.due !== today) toast(`Added for ${relativeDay(task.due, today)}`, { undo });
    },
    // A single line input would flatten a pasted list into one long task.
    onPaste: (event) => {
      const pasted = event.clipboardData?.getData('text') ?? '';
      if (!pasted.trim().includes('\n')) return;
      event.preventDefault();
      organize(input.value.trim() ? `${input.value}\n${pasted}` : pasted);
    },
  });

  return {
    title: 'Today',
    el: h('div', { class: 'page' },
      h('header', { class: 'page-head' },
        h('p', { class: 'page-eyebrow' }, longDate(Date.now())),
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Today')),
      h('div', { class: 'today-add' },
        h('div', { class: 'task-add-row today-add-row' }, icon('plus', 16), input),
        h('button', {
          class: 'btn today-organize',
          type: 'button',
          title: 'Paste a messy list and organize it',
          'aria-label': 'Organize a list',
          onClick: () => organize(input.value),
        }, icon('listCheck', 16), h('span', { class: 'today-organize-label' }, 'Organize a list'))),
      calendarLine.el,
      agenda.el),
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('noteTypes') || change.ids.has('gcalEvents')) agenda.refresh();
    },
    destroy: calendarLine.destroy,
  };
}
