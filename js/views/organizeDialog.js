/**
 * organizeDialog.js: paste a messy list, check how it was read, and add it. Nothing is added until
 * the list has been checked, and everything can be corrected on the way.
 *
 * Resolves with the drafts to add ({ text, time, due }), or null if cancelled.
 */
import { parseTaskList } from '../data/taskText.js';
import { openDialog } from '../ui/dialog.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

export function openOrganizeDialog({ text = '', today }) {
  return openDialog({
    title: 'Organize a list',
    className: 'organize-dialog',
    build: (close) => {
      const el = h('div');
      let raw = text;
      let drafts = [];

      const ready = () => drafts.filter((draft) => draft.text.trim());

      function showReview(focus = '.organize-row input') {
        const addButton = h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onClick: () => close(ready()),
        });
        const refreshAdd = () => {
          addButton.disabled = !ready().length;
          addButton.textContent = `Add ${plural(ready().length, 'task')}`;
        };
        refreshAdd();
        const rows = drafts.map((draft, index) => {
          const number = index + 1;
          const textInput = h('input', {
            class: 'input input-small organize-text',
            type: 'text',
            value: draft.text,
            'aria-label': `Task ${number}`,
            onInput: () => {
              draft.text = textInput.value;
              refreshAdd();
            },
          });
          const timeInput = h('input', {
            class: 'input input-small organize-time',
            type: 'time',
            value: draft.time,
            'aria-label': `Time of task ${number}`,
            onChange: () => {
              draft.time = timeInput.value;
            },
          });
          const dueInput = h('input', {
            class: 'input input-small organize-due',
            type: 'date',
            value: draft.due,
            'aria-label': `Date of task ${number}`,
            onChange: () => {
              draft.due = dueInput.value;
            },
          });
          return h('li', { class: 'organize-row' }, textInput, timeInput, dueInput,
            h('button', {
              class: 'icon-btn',
              type: 'button',
              title: 'Remove from this list',
              'aria-label': `Remove task ${number} from this list`,
              onClick: () => {
                drafts.splice(index, 1);
                if (drafts.length) showReview(`.organize-row:nth-child(${Math.min(number, drafts.length)}) input`);
                else showWrite();
              },
            }, icon('close', 15)));
        });
        fill(el,
          h('p', { class: 'dialog-text' }, 'Check how this was read, and change anything that’s wrong.'),
          h('ul', { class: 'organize-rows' }, rows),
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => showWrite() }, 'Back'),
            addButton));
        el.querySelector(focus)?.focus();
      }

      function showWrite() {
        const area = h('textarea', {
          class: 'input organize-area',
          rows: '8',
          value: raw,
          placeholder: '15.00 project meeting\ncook dinner\ndentist friday at 10:30',
          onInput: () => {
            raw = area.value;
            error.textContent = '';
          },
          onKeydown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              organize();
            }
          },
        });
        area.value = raw;
        const error = h('p', { class: 'field-error', role: 'alert' });
        function organize() {
          drafts = parseTaskList(raw, today);
          if (drafts.length) {
            showReview();
          } else {
            error.textContent = 'Write at least one task first.';
            area.focus();
          }
        }
        fill(el,
          h('label', { class: 'field' },
            h('span', { class: 'field-label' }, 'One task on each line'),
            area),
          h('p', { class: 'field-hint' }, 'Times like 15.00 or 3pm, and words like tomorrow or Friday, are picked up.'),
          error,
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
            h('button', { class: 'btn btn-primary', type: 'button', onClick: organize }, 'Organize')));
        area.focus();
      }

      // A pasted list is ready to check. Otherwise it still has to be written. Drawn once in the dialog.
      queueMicrotask(() => {
        drafts = parseTaskList(raw, today);
        if (drafts.length) showReview();
        else showWrite();
      });
      return el;
    },
  }).then((drafts) => drafts ?? null);
}
