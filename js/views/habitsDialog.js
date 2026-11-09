/**
 * habitsDialog.js: adding, renaming, reordering and removing habits.
 */
import { app } from '../context.js';
import { habitStreak } from '../data/habits.js';
import { toDateStr } from '../data/dates.js';
import { openDialog } from '../ui/dialog.js';
import { fill, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

export function openHabitsDialog() {
  const { db } = app;
  return openDialog({
    title: 'Habits',
    className: 'dialog-block',
    build: () => {
      const el = h('div');
      function render(focusSelector) {
        const habits = db.listHabits();
        const today = toDateStr();
        const name = h('input', {
          class: 'input', type: 'text', maxlength: 80, placeholder: 'Read 20 pages, stretch, drink water…', 'aria-label': 'New habit', autofocus: true,
        });
        const emoji = h('input', {
          class: 'input input-emoji', type: 'text', maxlength: 8, placeholder: '🙂', 'aria-label': 'Icon (optional)',
        });
        const error = h('p', { class: 'field-error', role: 'alert' });
        fill(el,
          h('p', { class: 'dialog-text' }, 'Daily habits appear on your dashboard with a tick for today and a streak.'),
          habits.length > 0 && h('ul', { class: 'habit-manage' }, habits.map((habit, index) => {
            const rename = h('input', {
              class: 'input input-small',
              type: 'text',
              value: habit.name,
              maxlength: 80,
              'aria-label': `Name of ${habit.name}`,
              onChange: (event) => {
                try {
                  db.updateHabit(habit.id, { name: event.target.value });
                } catch (problem) {
                  event.target.value = habit.name;
                  toast(problem.message, { error: true });
                }
              },
            });
            const { longest } = habitStreak(habit, today);
            return h('li', { class: 'habit-manage-row', dataset: { id: habit.id } },
              h('span', { class: 'habit-icon', 'aria-hidden': 'true' }, habit.icon || '•'),
              rename,
              h('span', { class: 'dash-stat' }, `Best: ${longest}`),
              h('button', {
                class: 'icon-btn', type: 'button', 'aria-label': `Move ${habit.name} up`, disabled: index === 0, dataset: { dir: 'up' },
                onClick: () => {
                  db.moveHabit(habit.id, index - 1);
                  render(`[data-id="${habit.id}"] [data-dir="up"]:not(:disabled), [data-id="${habit.id}"] [data-dir="down"]`);
                },
              }, icon('arrowUp', 15)),
              h('button', {
                class: 'icon-btn', type: 'button', 'aria-label': `Move ${habit.name} down`, disabled: index === habits.length - 1, dataset: { dir: 'down' },
                onClick: () => {
                  db.moveHabit(habit.id, index + 1);
                  render(`[data-id="${habit.id}"] [data-dir="down"]:not(:disabled), [data-id="${habit.id}"] [data-dir="up"]`);
                },
              }, icon('arrowDown', 15)),
              h('button', {
                class: 'icon-btn', type: 'button', 'aria-label': `Delete ${habit.name}`,
                onClick: () => {
                  const { undo } = db.undoable(() => db.deleteHabit(habit.id));
                  toast(`${habit.name} deleted`, { undo });
                  render('.habit-form input:not(.input-emoji)');
                },
              }, icon('trash', 15)));
          })),
          h('form', {
            class: 'habit-form',
            onSubmit: (event) => {
              event.preventDefault();
              try {
                db.createHabit({ name: name.value, icon: emoji.value.trim() });
                render('.habit-form input:not(.input-emoji)');
              } catch (problem) {
                error.textContent = problem.message;
                name.focus();
              }
            },
          },
          h('div', { class: 'field-row' }, emoji, name, h('button', { class: 'btn', type: 'submit' }, icon('plus', 15), 'Add')),
          error));
        el.querySelector(focusSelector ?? '.habit-form input:not(.input-emoji)')?.focus();
      }
      render();
      return el;
    },
  });
}
