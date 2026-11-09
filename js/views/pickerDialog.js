/**
 * pickerDialog.js: "Pick something for tonight". Choose filters, get one random suggestion.
 */
import { app } from '../context.js';
import { fieldValue } from '../data/fieldKinds.js';
import { donePatch, pickOne, pickerCandidates } from '../data/picker.js';
import { displayTitle, summaryFields } from '../data/types.js';
import { fill, h, plural } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { withUndo } from './actions.js';
import { fieldDisplay } from './fieldWidgets.js';

/** Options offered for a filter: only values that exist in this list, so nothing leads to nothing. */
function filterOptions(notes, field) {
  const values = new Set();
  for (const note of notes) {
    const value = fieldValue(note, field);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item) values.add(item);
    }
  }
  const order = field.options ?? [];
  const rank = (value) => {
    const index = order.indexOf(value);
    return index === -1 ? Infinity : index;
  };
  return [...values].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function openPicker(notes, type) {
  const { picker } = type;
  return openDialog({
    title: picker.title,
    className: 'dialog-picker-random',
    build: (close) => {
      const filters = {};
      let currentId = null;
      const result = h('div', { class: 'pick-result', 'aria-live': 'polite' });

      const pool = pickerCandidates(notes, type);

      function showPick() {
        const candidates = pickerCandidates(notes, type, filters);
        const pick = pickOne(candidates, { excludeId: currentId });
        currentId = pick?.id ?? null;
        if (!pick) {
          fill(result, h('p', { class: 'pick-empty' }, pool.length
            ? 'Nothing matches those filters. Try loosening one.'
            : picker.from ? `Nothing with status "${picker.from.join(' or ')}" in this list yet.` : 'Nothing in this list yet. Add a few, then come back when you need one.'));
          return;
        }
        fill(result,
          h('p', { class: 'pick-count' }, `One of ${plural(candidates.length, 'match', 'matches')}`),
          h('h3', { class: 'pick-title' }, displayTitle(pick, type) || 'Untitled'),
          h('div', { class: 'card-fields' }, summaryFields(type)
            .filter((f) => f.id !== picker.field)
            .map((field) => fieldDisplay(field, fieldValue(pick, field), { db: app.db, compact: true }))),
          h('div', { class: 'pick-actions' },
            h('button', { class: 'btn', type: 'button', onClick: showPick, disabled: candidates.length < 2 }, icon('shuffle', 15), 'Another one'),
            picker.done && h('button', {
              class: 'btn',
              type: 'button',
              onClick: () => {
                withUndo('Marked as done. Enjoy!', () => app.db.updateNote(pick.id, donePatch(pick, type)));
                close();
              },
            }, icon('check', 15), 'Mark as done'),
            picker.moveTo && h('button', {
              class: 'btn',
              type: 'button',
              onClick: () => {
                withUndo(`Moved to ${picker.moveTo}`, () => app.db.updateNote(pick.id, { fields: { ...pick.fields, [picker.field]: picker.moveTo } }));
                close();
              },
            }, `Mark as ${picker.moveTo}`),
            h('a', { class: 'btn btn-primary', href: `#/note/${encodeURIComponent(pick.id)}`, onClick: () => close() }, 'Open')));
      }

      const controls = picker.filters.map((filter) => {
        const field = type.fields.find((f) => f.id === filter.field);
        if (!field) return null;
        const options = filter.choices
          ? filter.choices.map((value) => ({ value: String(value), label: `Up to ${value} ${filter.unit ?? ''}`.trim() }))
          : filterOptions(pool, field).map((value) => ({ value, label: value }));
        if (!options.length) return null;
        const select = h('select', {
          class: 'select',
          onChange: () => {
            filters[field.id] = select.value;
            showPick();
          },
        }, h('option', { value: '' }, 'Any'), options.map((option) => h('option', { value: option.value }, option.label)));
        return h('label', { class: 'pick-filter' }, h('span', { class: 'field-label' }, filter.label), select);
      });

      showPick();
      return h('div', null, h('div', { class: 'pick-filters' }, controls), result);
    },
  });
}
