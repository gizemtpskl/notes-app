/**
 * filterBar.js: the Filter button and its panel. Changes apply straight away.
 *
 * The panel is only rebuilt when its shape changes (a condition added or removed, or a field
 * changed). Typing in a value keeps its text box, so the caret never jumps.
 */
import { app } from '../context.js';
import {
  DATE_RANGES, OPS_BY_KIND, OP_LABELS, countConditions, describeFilter, emptyFilter, normalizeFilter, opNeedsValue,
} from '../data/filters.js';
import { fold } from '../data/text.js';
import { dateKeysFor } from '../data/types.js';
import { fill, h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const VALUE_DELAY_MS = 250;

/** A small multi-choice list: chips for what's chosen, a menu for adding more. */
function multiChoice({ label, options, selected, onChange }) {
  const box = h('div', { class: 'filter-multi' });
  function render() {
    const remaining = options.filter((option) => !selected.includes(option.value));
    fill(box,
      selected.map((value) => {
        const option = options.find((o) => o.value === value);
        return h('button', {
          class: 'chip chip-button chip-on',
          type: 'button',
          'aria-label': `Remove ${option?.label ?? value} from ${label}`,
          onClick: () => {
            selected = selected.filter((v) => v !== value);
            onChange(selected);
            render();
          },
        }, option?.label ?? value, icon('close', 11));
      }),
      remaining.length > 0 && h('select', {
        class: 'select',
        'aria-label': `Add to ${label}`,
        onChange: (event) => {
          if (!event.target.value) return;
          selected = [...selected, event.target.value];
          onChange(selected);
          render();
        },
      }, h('option', { value: '' }, selected.length ? 'Add…' : 'Any'), remaining.map((option) => h('option', { value: option.value }, option.label))));
  }
  render();
  return box;
}

/**
 * options:
 *   scope      'global' adds space, collection, type and status choices. 'scoped' is for a page
 *              tied to one collection or tag.
 *   getFilter  () => the current filter
 *   onChange   (filter) => save it
 *   getTypes   () => note types whose fields can be filtered on
 *   onSave     optional: (filter) => offer to save as a view
 */
export function filterBar({ scope = 'scoped', getFilter, onChange, getTypes, onSave }) {
  const { db } = app;
  let open = false;
  let filter = normalizeFilter(getFilter());
  let valueTimer = null;

  /** Waits for a pause in typing. Until then this copy of the filter is newer than the saved one. */
  function emitSoon() {
    clearTimeout(valueTimer);
    valueTimer = setTimeout(emit, VALUE_DELAY_MS);
  }

  const panel = h('div', { class: 'filter-panel', hidden: true, role: 'group', 'aria-label': 'Filter' });
  const summary = h('div', { class: 'filter-summary' });
  const badge = h('span', { class: 'filter-badge', hidden: true });
  const button = h('button', {
    class: 'btn btn-small filter-toggle',
    type: 'button',
    'aria-expanded': 'false',
    onClick: () => setOpen(!open),
  }, icon('filter', 15), 'Filter', badge);

  function emit() {
    clearTimeout(valueTimer);
    valueTimer = null;
    // A copy, because this working version keeps changing and saved records must not.
    onChange(structuredClone(filter));
    renderSummary();
  }

  function setOpen(next) {
    open = next;
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) renderPanel();
    renderSummary();
  }

  function renderSummary() {
    const count = countConditions(filter);
    badge.hidden = !count;
    badge.textContent = count;
    button.classList.toggle('is-on', count > 0);
    const parts = open ? [] : describeFilter(db, filter);
    fill(summary, parts.length > 0 && [
      h('span', { class: 'filter-summary-text' }, parts.join(' · ')),
      h('button', { class: 'btn-link', type: 'button', onClick: () => setOpen(true) }, 'Edit'),
      h('button', { class: 'btn-link', type: 'button', onClick: clear }, 'Clear'),
      onSave && h('button', { class: 'btn-link', type: 'button', onClick: () => onSave(filter) }, 'Save as view'),
    ]);
  }

  function clear() {
    filter = emptyFilter();
    emit();
    if (open) renderPanel();
  }

  /** Every field that can be filtered on, once. Options merge across types with the same field. */
  function fieldCatalog() {
    const types = filter.types.length ? filter.types.map((id) => db.getType(id)) : getTypes();
    const catalog = new Map();
    for (const type of types) {
      for (const field of type.fields) {
        if (!catalog.has(field.id)) catalog.set(field.id, { ...field, typeIds: [type.id] });
        else if (catalog.get(field.id).kind === field.kind) catalog.get(field.id).typeIds.push(type.id);
      }
    }
    return catalog;
  }

  function optionsFor(field) {
    const values = new Set(field.options ?? []);
    if (field.creatable) {
      for (const typeId of field.typeIds) for (const value of db.usedFieldValues(typeId, field.id)) values.add(value);
    }
    return [...values];
  }

  function valueInput(rule, field) {
    if (!opNeedsValue(rule.op)) return null;
    const set = (value) => {
      rule.value = value;
      emitSoon();
    };
    const aria = { 'aria-label': `Value for ${field?.name ?? 'condition'}` };
    if (field && (field.kind === 'select' || field.kind === 'multiselect')) {
      const options = optionsFor(field);
      return h('select', {
        class: 'select',
        ...aria,
        onChange: (event) => {
          rule.value = event.target.value;
          emit();
        },
      }, h('option', { value: '' }, 'Choose…'), [...new Set([...options, ...(rule.value ? [rule.value] : [])])].map((value) => h('option', { value, selected: value === rule.value }, value)));
    }
    if (field?.kind === 'date') {
      return h('input', {
        class: 'input input-small',
        type: 'date',
        value: rule.value,
        ...aria,
        onChange: (event) => {
          rule.value = event.target.value;
          emit();
        },
      });
    }
    const numeric = ['number', 'rating', 'mood'].includes(field?.kind);
    return h('input', {
      class: `input input-small${numeric ? ' filter-number' : ''}`,
      type: numeric ? 'number' : 'text',
      value: rule.value,
      ...aria,
      onInput: (event) => set(numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value),
    });
  }

  function ruleRow(rule, index, catalog) {
    const field = catalog.get(rule.field);
    const ops = OPS_BY_KIND[field?.kind] ?? OPS_BY_KIND.text;
    return h('div', { class: 'filter-rule' },
      h('select', {
        class: 'select',
        'aria-label': 'Field',
        onChange: (event) => {
          const next = catalog.get(event.target.value);
          rule.field = event.target.value;
          [rule.op] = OPS_BY_KIND[next?.kind] ?? OPS_BY_KIND.text;
          rule.value = '';
          emit();
          renderPanel();
        },
      },
      // A condition on a field the current types don't have stays visible, so it can be removed.
      !field && h('option', { value: rule.field, selected: true }, rule.field),
      [...catalog.values()].map((f) => h('option', { value: f.id, selected: f.id === rule.field }, f.name))),
      h('select', {
        class: 'select',
        'aria-label': 'Condition',
        onChange: (event) => {
          rule.op = event.target.value;
          emit();
          renderPanel();
        },
      }, ops.map((op) => h('option', { value: op, selected: op === rule.op }, OP_LABELS[op]))),
      valueInput(rule, field),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Remove this condition',
        title: 'Remove',
        onClick: () => {
          filter.rules.splice(index, 1);
          emit();
          renderPanel();
        },
      }, icon('close', 14)));
  }

  function row(label, ...content) {
    return h('div', { class: 'filter-row' }, h('span', { class: 'filter-label' }, label), h('div', { class: 'filter-control' }, content));
  }

  function dateRow() {
    const types = filter.types.length ? filter.types.map((id) => db.getType(id)) : getTypes();
    const keys = new Map();
    for (const type of types) for (const key of dateKeysFor(type)) if (!keys.has(key.key)) keys.set(key.key, key);
    const date = filter.date ?? { key: [...keys.keys()][0], range: '', from: '', to: '' };
    const apply = (patch) => {
      const next = { ...date, ...patch };
      filter.date = next.range ? next : null;
      emit();
      renderPanel();
    };
    return row('Date',
      h('select', {
        class: 'select', 'aria-label': 'Which date', onChange: (event) => apply({ key: event.target.value }),
      }, [...keys.values()].map((key) => h('option', { value: key.key, selected: key.key === date.key }, key.label))),
      h('select', {
        class: 'select', 'aria-label': 'Date range', onChange: (event) => apply({ range: event.target.value }),
      }, DATE_RANGES.map((range) => h('option', { value: range.value, selected: range.value === date.range }, range.label))),
      date.range === 'custom' && [
        h('input', {
          class: 'input input-small', type: 'date', value: date.from, 'aria-label': 'From', onChange: (event) => apply({ from: event.target.value }),
        }),
        h('input', {
          class: 'input input-small', type: 'date', value: date.to, 'aria-label': 'To', onChange: (event) => apply({ to: event.target.value }),
        }),
      ]);
  }

  function renderPanel() {
    const catalog = fieldCatalog();
    const tags = db.listTags();
    fill(panel,
      row('Contains', h('input', {
        class: 'input input-small',
        type: 'search',
        value: filter.text,
        placeholder: 'Words in the title or text',
        'aria-label': 'Words in the title or text',
        onInput: (event) => {
          filter.text = event.target.value;
          emitSoon();
        },
      })),
      scope === 'global' && row('Space', multiChoice({
        label: 'Space',
        options: db.listSpaces().map((space) => ({ value: space.id, label: space.name })),
        selected: filter.spaces,
        onChange: (next) => {
          filter.spaces = next;
          emit();
        },
      })),
      scope === 'global' && row('Collection', multiChoice({
        label: 'Collection',
        options: db.allCollections()
          .map((col) => ({ value: col.id, label: `${col.name} (${db.getSpace(col.spaceId)?.name ?? ''})` }))
          .sort((a, b) => fold(a.label).localeCompare(fold(b.label))),
        selected: filter.collections,
        onChange: (next) => {
          filter.collections = next;
          emit();
        },
      })),
      scope === 'global' && row('Type', multiChoice({
        label: 'Type',
        options: db.listTypes().map((type) => ({ value: type.id, label: `${type.icon} ${type.name}` })),
        selected: filter.types,
        onChange: (next) => {
          filter.types = next;
          emit();
          renderPanel();
        },
      })),
      tags.length > 0 && row('Tags',
        multiChoice({
          label: 'Tags',
          options: tags.map((tag) => ({ value: tag.id, label: tag.name })),
          selected: filter.tags,
          onChange: (next) => {
            filter.tags = next;
            emit();
            renderPanel();
          },
        }),
        filter.tags.length > 1 && h('select', {
          class: 'select',
          'aria-label': 'Match tags',
          onChange: (event) => {
            filter.tagMode = event.target.value;
            emit();
          },
        }, h('option', { value: 'any', selected: filter.tagMode === 'any' }, 'Any of these'), h('option', { value: 'all', selected: filter.tagMode === 'all' }, 'All of these'))),
      dateRow(),
      filter.rules.length > 0 && h('div', { class: 'filter-rules' }, filter.rules.map((rule, index) => ruleRow(rule, index, catalog))),
      h('div', { class: 'filter-actions' },
        catalog.size > 0 && h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            const first = [...catalog.values()][0];
            filter.rules.push({ field: first.id, op: OPS_BY_KIND[first.kind]?.[0] ?? 'contains', value: '' });
            renderPanel();
            emit();
          },
        }, icon('plus', 14), 'Add condition'),
        scope === 'global' && h('label', { class: 'inline-field' }, 'Show',
          h('select', {
            class: 'select',
            onChange: (event) => {
              filter.status = event.target.value;
              emit();
            },
          }, [['active', 'Active notes'], ['archived', 'Archived only'], ['all', 'Active and archived']].map(([value, label]) => h('option', { value, selected: filter.status === value }, label)))),
        scope === 'global' && h('label', { class: 'check-field filter-check' },
          h('input', {
            type: 'checkbox',
            checked: filter.includePrivate,
            onChange: (event) => {
              filter.includePrivate = event.target.checked;
              emit();
            },
          }), 'Include private notes'),
        h('span', { class: 'filter-spacer' }),
        h('button', { class: 'btn-link', type: 'button', onClick: clear }, 'Clear all'),
        onSave && h('button', { class: 'btn btn-small', type: 'button', onClick: () => onSave(filter) }, icon('bookmark', 14), 'Save as view')));
  }

  renderSummary();

  return {
    button,
    panel,
    summary,
    open: () => setOpen(true),
    /** Picks up a filter changed elsewhere, such as an undo or another tab. */
    sync() {
      const next = normalizeFilter(getFilter());
      if (valueTimer === null && JSON.stringify(next) !== JSON.stringify(filter)) {
        filter = next;
        if (open && !panel.contains(document.activeElement)) renderPanel();
      }
      renderSummary();
    },
  };
}
