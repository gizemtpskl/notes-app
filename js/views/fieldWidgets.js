/**
 * fieldWidgets.js: how each kind of field is edited and displayed. fieldForm builds the whole
 * form for a note from its type's field list, so a new custom type needs no code of its own.
 *
 * All values reach the page as text nodes or properties, never as markup, so a value from an
 * imported file can't inject anything.
 */
import { relativeDay, toDateStr } from '../data/dates.js';
import { MOODS, emptyValue, fieldValue, isEmptyValue, valueToText } from '../data/fieldKinds.js';
import { safeUrl } from '../data/html.js';
import { uid } from '../data/schema.js';
import { progress } from '../data/tasks.js';
import { displayTitle } from '../data/types.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pickNote } from './dialogs.js';
import { flashcardsEditor } from './flashcardsField.js';
import { progressBar, taskListField } from './tasksField.js';

function autoGrow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

/** A list of suggestions for a text box, from a field's options and values used before. */
function datalistFor(field, ctx) {
  const used = ctx.typeId ? ctx.db.usedFieldValues(ctx.typeId, field.id) : [];
  const values = [...new Set([...(field.options ?? []), ...used])];
  const list = h('datalist', { id: `list-${uid()}` }, values.map((value) => h('option', { value })));
  return { list, values };
}

function textEditor(id, field, value, onChange) {
  return h('input', {
    class: 'input', id, type: 'text', value, onInput: (event) => onChange(event.target.value),
  });
}

function longTextEditor(id, field, value, onChange) {
  const area = h('textarea', {
    class: 'input input-long',
    id,
    rows: 2,
    value,
    onInput: () => {
      autoGrow(area);
      onChange(area.value);
    },
  });
  // Runs once the page has the element, since an unattached element has no height.
  requestAnimationFrame(() => autoGrow(area));
  return area;
}

function numberEditor(id, field, value, onChange) {
  const input = h('input', {
    class: 'input input-number',
    id,
    type: 'number',
    inputmode: 'decimal',
    step: 'any',
    value: value ?? '',
    onInput: () => onChange(input.value === '' ? null : Number(input.value)),
  });
  return field.unit
    ? h('div', { class: 'input-unit' }, input, h('span', { class: 'field-unit' }, field.unit))
    : input;
}

function dateEditor(id, field, value, onChange) {
  return h('input', {
    class: 'input input-date', id, type: 'date', value, onChange: (event) => onChange(event.target.value),
  });
}

function selectEditor(id, field, value, onChange, ctx) {
  if (field.creatable) {
    const { list } = datalistFor(field, ctx);
    return h('div', null,
      h('input', {
        class: 'input', id, type: 'text', value, list: list.id, autocomplete: 'off', onInput: (event) => onChange(event.target.value),
      }),
      list);
  }
  const options = [...(field.options ?? [])];
  // A value that was removed from the options must stay visible, not silently vanish.
  if (value && !options.includes(value)) options.push(value);
  if (!options.length) return h('p', { class: 'field-hint' }, 'No options yet. Add some under Settings, Note types.');
  const select = h('select', {
    class: 'select select-field',
    id,
    onChange: () => onChange(select.value),
  },
  h('option', { value: '', selected: !value }, 'None'),
  options.map((option) => h('option', { value: option, selected: option === value }, option)));
  return select;
}

function multiSelectEditor(id, field, value, onChange, ctx) {
  let current = [...value];
  const chips = h('div', { class: 'choice-chips', role: 'group', 'aria-label': field.name });

  function render() {
    const names = [...new Set([...(field.options ?? []), ...current])];
    chips.replaceChildren(...names.map((name) => h('button', {
      class: 'choice-chip',
      type: 'button',
      'aria-pressed': String(current.includes(name)),
      onClick: () => {
        current = current.includes(name) ? current.filter((v) => v !== name) : [...current, name];
        onChange(current);
        render();
      },
    }, name)));
  }
  render();

  if (!field.creatable) {
    return (field.options ?? []).length || current.length
      ? chips
      : h('p', { class: 'field-hint' }, 'No options yet. Add some under Settings, Note types.');
  }
  const { list } = datalistFor(field, ctx);
  const add = h('input', {
    class: 'input input-small',
    id,
    type: 'text',
    list: list.id,
    autocomplete: 'off',
    placeholder: 'Add another…',
    'aria-label': `Add to ${field.name}`,
    onKeydown: (event) => {
      if ((event.key === 'Enter' || event.key === ',') && !event.isComposing) {
        event.preventDefault();
        const text = add.value.trim();
        if (text && !current.includes(text)) {
          current = [...current, text];
          onChange(current);
          render();
        }
        add.value = '';
      }
    },
  });
  return h('div', { class: 'multi-editor' }, chips, add, list);
}

function checkboxEditor(id, field, value, onChange) {
  return h('label', { class: 'check-field' },
    h('input', {
      id, type: 'checkbox', checked: value, onChange: (event) => onChange(event.target.checked),
    }),
    h('span', null, field.name));
}

/** Radio buttons, so arrow keys work. Clicking the current value again clears it. */
function scaleEditor(field, value, onChange, { max, render }) {
  let current = value;
  const name = uid();
  const labels = [];
  const update = () => labels.forEach((label, i) => {
    label.classList.toggle('is-on', render.isOn(i + 1, current));
    label.querySelector('input').checked = current === i + 1;
  });
  for (let i = 1; i <= max; i += 1) {
    const input = h('input', {
      class: 'sr-only',
      type: 'radio',
      name,
      value: String(i),
      'aria-label': render.label(i),
      onClick: () => {
        current = current === i ? 0 : i;
        onChange(current);
        update();
      },
    });
    labels.push(h('label', { class: `scale-option ${render.className}`, title: render.label(i) }, input, render.face(i)));
  }
  update();
  return h('div', {
    class: 'scale',
    role: 'radiogroup',
    'aria-label': field.name,
    onKeydown: (event) => {
      if (event.key === 'Delete' || event.key === 'Backspace' || event.key === '0') {
        event.preventDefault();
        current = 0;
        onChange(0);
        update();
      }
    },
  }, labels);
}

function ratingEditor(id, field, value, onChange) {
  const symbol = field.symbol ?? 'star';
  return scaleEditor(field, value, onChange, {
    max: field.max ?? 5,
    render: {
      className: 'scale-rating',
      isOn: (i, current) => i <= current,
      label: (i) => `${i} of ${field.max ?? 5}`,
      face: () => icon(symbol, 20),
    },
  });
}

function moodEditor(id, field, value, onChange) {
  return scaleEditor(field, value, onChange, {
    max: 5,
    render: {
      className: 'scale-mood',
      isOn: (i, current) => i === current,
      label: (i) => MOODS[i - 1].label,
      face: (i) => h('span', { 'aria-hidden': 'true' }, MOODS[i - 1].emoji),
    },
  });
}

function urlEditor(id, field, value, onChange) {
  const open = h('a', {
    class: 'icon-btn', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open link', title: 'Open link',
  }, icon('external', 16));
  const refresh = (text) => {
    const safe = safeUrl(text);
    open.hidden = !safe;
    if (safe) open.href = safe;
  };
  refresh(value);
  return h('div', { class: 'input-with-button' },
    h('input', {
      class: 'input',
      id,
      type: 'url',
      inputmode: 'url',
      value,
      placeholder: 'https://',
      onInput: (event) => {
        refresh(event.target.value);
        onChange(event.target.value);
      },
    }),
    open);
}

function relationEditor(id, field, value, onChange, ctx) {
  const box = h('div', { class: 'relation' });
  let current = value;
  function render() {
    const target = current ? ctx.db.getNote(current) : null;
    box.replaceChildren(
      ...(target
        ? [
          h('a', { class: 'chip chip-link', href: `#/note/${encodeURIComponent(target.id)}` }, displayTitle(target, ctx.db.getType(target.typeId)) || 'Untitled'),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Remove link in ${field.name}`,
            onClick: () => {
              current = '';
              onChange('');
              render();
            },
          }, icon('close', 14)),
        ]
        : []),
      h('button', {
        class: 'btn btn-small',
        id,
        type: 'button',
        onClick: async () => {
          const chosen = await pickNote({ title: `Choose a note for ${field.name}`, excludeId: ctx.noteId });
          if (chosen) {
            current = chosen;
            onChange(chosen);
            render();
          }
        },
      }, icon('link', 14), current ? 'Change' : 'Choose a note'),
    );
  }
  render();
  return box;
}

/** Links a note to a collection. An old typed-in name stays visible until something is chosen. */
function collectionEditor(id, field, value, onChange, ctx) {
  const collections = ctx.db.allCollections().sort((a, b) => a.name.localeCompare(b.name));
  const known = collections.some((col) => col.id === value);
  const select = h('select', {
    class: 'select select-field',
    id,
    onChange: () => onChange(select.value),
  },
  h('option', { value: '', selected: !value }, 'None'),
  value && !known && h('option', { value, selected: true }, value),
  collections.map((col) => h('option', { value: col.id, selected: col.id === value }, col.name)));
  return select;
}

const EDITORS = {
  flashcards: flashcardsEditor,
  collection: collectionEditor,
  text: textEditor,
  longtext: longTextEditor,
  number: numberEditor,
  date: dateEditor,
  select: selectEditor,
  multiselect: multiSelectEditor,
  checkbox: checkboxEditor,
  rating: ratingEditor,
  mood: moodEditor,
  url: urlEditor,
  relation: relationEditor,
};

/** The editable form for a note's fields. */
export function fieldForm({ note, type, db, onChange = () => {}, readOnly = false, preview = false }) {
  const values = {};
  const tasksWidgets = new Map();
  const form = h('fieldset', { class: 'field-form', disabled: readOnly });
  const ctx = { db, noteId: note?.id ?? null, typeId: preview ? null : type.id };

  const valueOf = (field) => (note ? fieldValue(note, field) : emptyValue(field));

  function build() {
    const rows = type.fields.map((field) => {
      values[field.id] = valueOf(field);
      const id = `field-${uid()}`;
      const set = (value) => {
        values[field.id] = value;
        onChange(field.id);
      };
      if (field.kind === 'tasks') {
        const widget = taskListField({ field, value: values[field.id], onChange: set, readOnly });
        tasksWidgets.set(field.id, widget);
        return h('div', { class: 'ff ff-wide ff-tasks' },
          !field.primary && h('h3', { class: 'ff-label' }, field.name),
          widget.el);
      }
      const editor = (EDITORS[field.kind] ?? textEditor)(id, field, values[field.id], set, ctx);
      const wide = ['longtext', 'multiselect', 'url', 'mood', 'flashcards'].includes(field.kind);
      const groupKind = ['rating', 'mood', 'multiselect'].includes(field.kind);
      return h('div', { class: `ff${wide ? ' ff-wide' : ''}` },
        field.kind !== 'checkbox' && (groupKind && !field.creatable
          ? h('span', { class: 'ff-label' }, field.name)
          : h('label', { class: 'ff-label', for: id }, field.name)),
        editor);
    });
    form.replaceChildren(...rows);
  }

  build();

  return {
    el: form,
    values: () => ({ ...values }),
    /** Shows values changed elsewhere, such as in another tab. */
    reload(nextNote) {
      note = nextNote;
      build();
    },
    /** Focuses the main task list, when the type has one. */
    focusPrimary() {
      const primary = type.fields.find((f) => f.primary);
      if (primary) tasksWidgets.get(primary.id)?.focus();
      return Boolean(primary);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Read-only display, for tables, cards and list rows
// ---------------------------------------------------------------------------------------

function stars(value, field) {
  const max = field.max ?? 5;
  const symbol = field.symbol ?? 'star';
  return h('span', { class: 'rating-display', role: 'img', 'aria-label': `${value} of ${max}` },
    Array.from({ length: max }, (_, i) => h('span', { class: i < value ? 'is-on' : '' }, icon(symbol, 13))));
}

/** A value as an element, or null when empty. */
export function fieldDisplay(field, value, { db, compact = false } = {}) {
  if (isEmptyValue(field, value)) return null;
  switch (field.kind) {
    case 'rating': return stars(value, field);
    case 'mood': {
      const mood = MOODS[value - 1];
      return h('span', { class: 'mood-display', title: mood.label }, h('span', { 'aria-hidden': 'true' }, mood.emoji), h('span', { class: 'sr-only' }, mood.label));
    }
    case 'select': return h('span', { class: 'pill', dataset: { tone: toneFor(field, value) } }, value);
    case 'multiselect': return h('span', { class: 'pill-group' }, value.map((v) => h('span', { class: 'pill' }, v)));
    case 'checkbox': return h('span', { class: 'check-display', role: 'img', 'aria-label': field.name }, icon('check', 14));
    case 'date': {
      const today = toDateStr();
      return h('time', { class: `date-display${field.role === 'due' && value < today ? ' is-overdue' : ''}`, datetime: value }, relativeDay(value, today));
    }
    case 'number': return h('span', { class: 'num-display' }, `${value.toLocaleString()}${field.unit ? ` ${field.unit}` : ''}`);
    case 'url': {
      const safe = safeUrl(value);
      if (!safe) return h('span', null, value);
      let label = value;
      try {
        label = new URL(safe).hostname.replace(/^www\./, '');
      } catch {
        // Unusual addresses just show in full.
      }
      return h('a', {
        class: 'url-display', href: safe, target: '_blank', rel: 'noopener noreferrer', onClick: (event) => event.stopPropagation(),
      }, label);
    }
    case 'flashcards': return value.length ? h('span', { class: 'num-display' }, `${value.length} ${value.length === 1 ? 'card' : 'cards'}`) : null;
    case 'collection': {
      const col = db?.getCollection(value);
      return col ? h('span', { class: 'pill' }, col.name) : h('span', { class: 'pill' }, value);
    }
    case 'relation': {
      const target = db?.getNote(value);
      return target
        ? h('a', { class: 'url-display', href: `#/note/${encodeURIComponent(target.id)}` }, displayTitle(target, db.getType(target.typeId)) || 'Untitled')
        : h('span', { class: 'is-untitled' }, 'Deleted note');
    }
    case 'tasks': {
      const stats = progress(value);
      return compact
        ? h('span', { class: 'num-display' }, `${stats.done}/${stats.total}`)
        : progressBar(stats, field.name);
    }
    default: return h('span', null, valueToText(field, value));
  }
}

/** Consistent soft colors for select options, by position, not by alphabet. */
export function toneFor(field, value) {
  const index = (field.options ?? []).indexOf(value);
  return index === -1 ? 'none' : String(index % 6);
}
