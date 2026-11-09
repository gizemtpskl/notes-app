/**
 * mathDialog.js: writing a formula, with a live preview. Resolves with { source, display },
 * with source '' to delete it, or null when cancelled.
 */
import { mathProblem, renderMath } from '../editor/math.js';
import { h } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';

const PREVIEW_DELAY_MS = 120;

export function mathDialog({ source = '', display = false, isNew = true }) {
  return openDialog({
    title: isNew ? 'Add a formula' : 'Edit formula',
    className: 'dialog-math',
    build: (close) => {
      const preview = h('div', { class: 'math-preview', 'aria-live': 'polite' });
      const problem = h('p', { class: 'field-error', role: 'alert' });
      let timer = null;
      let current = display;

      const area = h('textarea', {
        class: 'input input-long math-source',
        rows: 3,
        value: source,
        autofocus: true,
        spellcheck: 'false',
        'aria-label': 'Formula in LaTeX',
        placeholder: '\\frac{a}{b} + \\sum_{i=1}^{n} x_i^2',
        onInput: () => {
          clearTimeout(timer);
          timer = setTimeout(draw, PREVIEW_DELAY_MS);
        },
        onKeydown: (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            done();
          }
        },
      });

      async function draw() {
        const text = area.value.trim();
        if (!text) {
          preview.replaceChildren();
          problem.textContent = '';
          return;
        }
        await renderMath(preview, text, current);
        problem.textContent = await mathProblem(text);
      }

      function done() {
        close({ source: area.value.trim(), display: current });
      }

      const block = h('input', {
        type: 'checkbox',
        checked: display,
        onChange: (event) => {
          current = event.target.checked;
          draw();
        },
      });

      draw();
      return h('div', null,
        area,
        problem,
        h('label', { class: 'check-field' }, block, 'Show on its own line'),
        h('div', { class: 'math-preview-wrap' }, h('span', { class: 'field-label' }, 'Preview'), preview),
        h('div', { class: 'dialog-actions' },
          !isNew && h('button', { class: 'btn btn-danger-quiet', type: 'button', onClick: () => close({ source: '', display: false }) }, 'Delete'),
          h('button', { class: 'btn', type: 'button', onClick: () => close(null) }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'button', onClick: done }, isNew ? 'Add' : 'Save')));
    },
  }).then((result) => result ?? null);
}
