/**
 * fieldKinds.js: what each kind of field can hold.
 *
 * Note values are always read through normalizeValue. That keeps the app safe when values come
 * from an imported file, or when a custom type's field changed kind after notes were written.
 *
 * TO ADD A KIND: add an entry to FIELD_KINDS here and an editor and display in
 * views/fieldWidgets.js. Set inBuilder to offer it in the custom type builder.
 */
import { isDateStr } from './dates.js';
import { normalizeCards } from './flashcards.js';
import { flatten, normalizeTasks, progress } from './tasks.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const toStr = (value) => {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
};
const clampInt = (value, max) => (Number.isInteger(value) && value >= 1 && value <= max ? value : 0);

export const MOODS = Object.freeze([
  { value: 1, emoji: '😞', label: 'Awful' },
  { value: 2, emoji: '😕', label: 'Low' },
  { value: 3, emoji: '😐', label: 'Okay' },
  { value: 4, emoji: '🙂', label: 'Good' },
  { value: 5, emoji: '😄', label: 'Great' },
]);

function optionIndex(field, value) {
  const index = (field.options ?? []).indexOf(value);
  return index === -1 ? Infinity : index;
}

const textKind = {
  empty: '',
  normalize: toStr,
  toText: (value) => value,
  compare: (a, b) => collator.compare(a, b),
};
const numericCompare = (a, b) => a - b;

export const FIELD_KINDS = Object.freeze({
  text: { ...textKind, label: 'Text', inBuilder: true },
  longtext: { ...textKind, label: 'Long text', inBuilder: true },
  number: {
    label: 'Number',
    inBuilder: true,
    empty: null,
    normalize: (value) => {
      const number = typeof value === 'string' && value.trim() ? Number(value) : value;
      return typeof number === 'number' && Number.isFinite(number) ? number : null;
    },
    toText: (value) => (value === null ? '' : String(value)),
    compare: numericCompare,
  },
  date: {
    label: 'Date',
    inBuilder: true,
    empty: '',
    normalize: (value) => (isDateStr(value) ? value : ''),
    toText: (value) => value,
    compare: (a, b) => a.localeCompare(b),
  },
  select: {
    label: 'Select',
    inBuilder: true,
    hasOptions: true,
    empty: '',
    normalize: toStr,
    toText: (value) => value,
    compare: (a, b, field) => optionIndex(field, a) - optionIndex(field, b) || collator.compare(a, b),
  },
  multiselect: {
    label: 'Multi-select',
    inBuilder: true,
    hasOptions: true,
    empty: [],
    normalize: (value) => (Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v))] : []),
    toText: (value) => value.join(', '),
    compare: (a, b) => collator.compare(a.join(), b.join()),
  },
  checkbox: {
    label: 'Checkbox',
    inBuilder: true,
    empty: false,
    normalize: (value) => value === true,
    toText: (value) => (value ? 'Yes' : ''),
    compare: (a, b) => Number(a) - Number(b),
  },
  rating: {
    label: 'Rating',
    inBuilder: true,
    empty: 0,
    normalize: (value, field) => clampInt(value, field.max ?? 5),
    toText: (value, field) => (value ? `${value}/${field.max ?? 5}` : ''),
    compare: numericCompare,
  },
  url: {
    label: 'Web link',
    inBuilder: true,
    empty: '',
    normalize: toStr,
    toText: (value) => value,
    compare: (a, b) => collator.compare(a, b),
  },
  relation: {
    label: 'Link to a note',
    inBuilder: true,
    empty: '',
    normalize: toStr,
    toText: (value) => value,
    compare: () => 0,
  },
  tasks: {
    label: 'Task list',
    inBuilder: true,
    empty: [],
    normalize: (value) => normalizeTasks(value),
    toText: (value) => flatten(value).map(({ item }) => item.text).join('\n'),
    compare: (a, b) => progress(a).ratio - progress(b).ratio,
  },
  flashcards: {
    label: 'Flashcards',
    inBuilder: true,
    empty: [],
    normalize: (value) => normalizeCards(value),
    toText: (value) => value.map((card) => `${card.term}: ${card.def}`).join('\n'),
    compare: (a, b) => a.length - b.length,
  },
  collection: {
    label: 'Collection',
    empty: '',
    normalize: toStr,
    toText: (value) => value,
    compare: (a, b) => collator.compare(a, b),
  },
  mood: {
    label: 'Mood',
    empty: 0,
    normalize: (value) => clampInt(value, 5),
    toText: (value) => {
      const mood = MOODS.find((m) => m.value === value);
      return mood ? `${mood.emoji} ${mood.label}` : '';
    },
    compare: numericCompare,
  },
});

function kindOf(field) {
  return FIELD_KINDS[field.kind] ?? FIELD_KINDS.text;
}

export function normalizeValue(field, raw) {
  return kindOf(field).normalize(raw, field);
}

export function emptyValue(field) {
  const { empty } = kindOf(field);
  return Array.isArray(empty) ? [] : empty;
}

export function isEmptyValue(field, value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === kindOf(field).empty;
}

/** Plain text of a value, for Markdown and search. */
export function valueToText(field, value) {
  return kindOf(field).toText(value, field);
}

export function compareValues(field, a, b) {
  return kindOf(field).compare(a, b, field);
}

/** A note's current value for a field. */
export function fieldValue(note, field) {
  return normalizeValue(field, note.fields?.[field.id]);
}

/** Rebuilds a field definition from untrusted data, or returns null when it has no id. */
export function cleanFieldDef(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const kind = FIELD_KINDS[raw.kind] ? raw.kind : 'text';
  const clean = {
    id: raw.id.slice(0, 80),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 80) : 'Untitled field',
    kind,
  };
  if (FIELD_KINDS[kind].hasOptions) {
    clean.options = Array.isArray(raw.options) ? raw.options.filter((o) => typeof o === 'string' && o).slice(0, 100) : [];
    clean.creatable = raw.creatable === true;
  }
  if (kind === 'rating') clean.max = [3, 5, 10].includes(raw.max) ? raw.max : 5;
  if (raw.summary === true) clean.summary = true;
  return clean;
}
