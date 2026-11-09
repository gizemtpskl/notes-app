/**
 * filters.js: what a filter is, and which notes match it. Used by collection pages, saved
 * views and tag pages. Pure, apart from reading the database it is given.
 *
 * Filter:
 *   status       'active' | 'archived' | 'all' (all never includes the Trash)
 *   spaces       space ids (any of)
 *   collections  collection ids (any of), including their sub-collections unless exact is true
 *   types        note type ids (any of)
 *   tags         tag ids
 *   tagMode      'any' | 'all'
 *   text         words in the title or text
 *   date         { key, range, from, to }  key: 'due' | 'created' | 'updated' | 'field:<id>'
 *   rules        [{ field, op, value }]    all of them must match
 *   includePrivate  private notes stay out unless this is on, or a chosen type is private by default
 *
 * Example, "Low-effort ideas under 30 minutes":
 *   { types: ['idea'], rules: [{ field: 'effort', op: 'is', value: 'Low' }, { field: 'minutes', op: 'lte', value: 30 }] }
 */
import { addDays, isDateStr, toDateStr } from './dates.js';
import { fieldValue, isEmptyValue } from './fieldKinds.js';
import { progress } from './tasks.js';
import { fold } from './text.js';
import { noteDate } from './types.js';

const TEXT_OPS = ['contains', 'notContains', 'empty', 'notEmpty'];
const NUMBER_OPS = ['lte', 'gte', 'eq', 'empty', 'notEmpty'];

export const OPS_BY_KIND = Object.freeze({
  text: TEXT_OPS,
  longtext: TEXT_OPS,
  url: TEXT_OPS,
  select: ['is', 'isNot', 'empty', 'notEmpty'],
  multiselect: ['has', 'hasNot', 'empty', 'notEmpty'],
  number: NUMBER_OPS,
  rating: NUMBER_OPS,
  mood: NUMBER_OPS,
  checkbox: ['yes', 'no'],
  date: ['today', 'overdue', 'next7', 'last30', 'before', 'after', 'empty', 'notEmpty'],
  tasks: ['hasOpen', 'allDone', 'empty'],
  relation: ['empty', 'notEmpty'],
  flashcards: ['empty', 'notEmpty'],
  collection: ['empty', 'notEmpty'],
});

export const OP_LABELS = Object.freeze({
  contains: 'contains',
  notContains: 'does not contain',
  is: 'is',
  isNot: 'is not',
  has: 'includes',
  hasNot: 'does not include',
  lte: 'at most',
  gte: 'at least',
  eq: 'exactly',
  yes: 'is ticked',
  no: 'is not ticked',
  today: 'is today',
  overdue: 'is past',
  next7: 'is in the next 7 days',
  last30: 'is in the last 30 days',
  before: 'is before',
  after: 'is after',
  hasOpen: 'has open tasks',
  allDone: 'is all done',
  empty: 'is empty',
  notEmpty: 'is not empty',
});

const NEEDS_VALUE = new Set(['contains', 'notContains', 'is', 'isNot', 'has', 'hasNot', 'lte', 'gte', 'eq', 'before', 'after']);

export const opNeedsValue = (op) => NEEDS_VALUE.has(op);

export const DATE_RANGES = Object.freeze([
  { value: '', label: 'Any date' },
  { value: 'overdue', label: 'In the past' },
  { value: 'today', label: 'Today' },
  { value: 'next7', label: 'Next 7 days' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'none', label: 'No date' },
  { value: 'custom', label: 'Between dates' },
]);

export function emptyFilter() {
  return {
    status: 'active', spaces: [], collections: [], types: [], tags: [], tagMode: 'any', text: '', date: null, rules: [], includePrivate: false,
  };
}

const ids = (value) => (Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v))] : []);

/** Rebuilds a filter from anything, including an imported file. Always returns a usable filter. */
export function normalizeFilter(raw) {
  const clean = emptyFilter();
  if (!raw || typeof raw !== 'object') return clean;
  if (raw.status === 'archived' || raw.status === 'all') clean.status = raw.status;
  clean.spaces = ids(raw.spaces);
  clean.collections = ids(raw.collections);
  clean.types = ids(raw.types);
  clean.tags = ids(raw.tags);
  clean.tagMode = raw.tagMode === 'all' ? 'all' : 'any';
  clean.text = typeof raw.text === 'string' ? raw.text.slice(0, 200) : '';
  clean.includePrivate = raw.includePrivate === true;
  if (raw.exact === true) clean.exact = true;
  if (raw.date && typeof raw.date === 'object' && typeof raw.date.key === 'string' && DATE_RANGES.some((r) => r.value === raw.date.range && r.value)) {
    clean.date = {
      key: raw.date.key,
      range: raw.date.range,
      from: isDateStr(raw.date.from) ? raw.date.from : '',
      to: isDateStr(raw.date.to) ? raw.date.to : '',
    };
  }
  if (Array.isArray(raw.rules)) {
    clean.rules = raw.rules
      .filter((rule) => rule && typeof rule.field === 'string' && typeof rule.op === 'string' && OP_LABELS[rule.op])
      .slice(0, 20)
      .map((rule) => ({
        field: rule.field,
        op: rule.op,
        value: typeof rule.value === 'string' || typeof rule.value === 'number' ? rule.value : '',
      }));
  }
  return clean;
}

/** How many separate conditions are set, for the badge on the Filter button. */
export function countConditions(filter) {
  return (filter.status !== 'active' ? 1 : 0) + (filter.spaces.length ? 1 : 0) + (filter.collections.length ? 1 : 0)
    + (filter.types.length ? 1 : 0) + (filter.tags.length ? 1 : 0) + (filter.text ? 1 : 0) + (filter.date ? 1 : 0)
    + (filter.includePrivate ? 1 : 0) + filter.rules.length;
}

function inRange(value, { range, from, to }, today) {
  if (range === 'none') return !value;
  if (!value) return false;
  switch (range) {
    case 'overdue': return value < today;
    case 'today': return value === today;
    case 'next7': return value >= today && value <= addDays(today, 7);
    case 'last7': return value <= today && value >= addDays(today, -7);
    case 'last30': return value <= today && value >= addDays(today, -30);
    case 'custom': return (!from || value >= from) && (!to || value <= to);
    default: return true;
  }
}

/** Whether a value passes a rule. A note whose type has no such field never passes. */
export function testRule(field, value, rule, today = toDateStr()) {
  if (rule.op === 'empty') return isEmptyValue(field, value);
  if (rule.op === 'notEmpty') return !isEmptyValue(field, value);
  switch (rule.op) {
    case 'contains': return fold(value).includes(fold(rule.value));
    case 'notContains': return !fold(value).includes(fold(rule.value));
    case 'is': return value === rule.value;
    case 'isNot': return value !== rule.value;
    case 'has': return Array.isArray(value) && value.includes(rule.value);
    case 'hasNot': return Array.isArray(value) && !value.includes(rule.value);
    case 'lte': return !isEmptyValue(field, value) && value <= Number(rule.value);
    case 'gte': return !isEmptyValue(field, value) && value >= Number(rule.value);
    case 'eq': return !isEmptyValue(field, value) && value === Number(rule.value);
    case 'yes': return value === true;
    case 'no': return value === false;
    case 'today': return value === today;
    case 'overdue': return Boolean(value) && value < today;
    case 'next7': return Boolean(value) && value >= today && value <= addDays(today, 7);
    case 'last30': return Boolean(value) && value <= today && value >= addDays(today, -30);
    case 'before': return Boolean(value) && value < rule.value;
    case 'after': return Boolean(value) && value > rule.value;
    case 'hasOpen': {
      const stats = progress(value);
      return stats.total > stats.done;
    }
    case 'allDone': {
      const stats = progress(value);
      return stats.total > 0 && stats.total === stats.done;
    }
    default: return true;
  }
}

/** Turns a filter into a fast test for one note. */
export function compileFilter(db, filter, { today = toDateStr(), allowPrivate = false } = {}) {
  const spaces = filter.spaces.length ? new Set(filter.spaces) : null;
  const types = filter.types.length ? new Set(filter.types) : null;
  let collections = null;
  if (filter.collections.length) {
    collections = new Set(filter.collections);
    if (!filter.exact) {
      for (const id of filter.collections) {
        const col = db.getCollection(id);
        if (col) for (const child of db.listCollections(col.spaceId, id)) collections.add(child.id);
      }
    }
  }
  const tags = filter.tags.length ? filter.tags : null;
  const words = filter.text ? fold(filter.text).split(/\s+/).filter(Boolean) : null;
  const seesPrivate = allowPrivate || filter.includePrivate || filter.types.some((id) => db.getType(id).privateByDefault);

  return (note) => {
    if (note.trashedAt) return false;
    if (filter.status === 'active' ? note.archived : filter.status === 'archived' && !note.archived) return false;
    if (note.private && !seesPrivate) return false;
    if (spaces && !spaces.has(note.spaceId)) return false;
    if (collections && !collections.has(note.collectionId)) return false;
    if (types && !types.has(note.typeId)) return false;
    if (tags) {
      const has = (id) => note.tagIds.includes(id);
      if (filter.tagMode === 'all' ? !tags.every(has) : !tags.some(has)) return false;
    }
    if (words) {
      const haystack = fold(`${note.title}\n${note.text}`);
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    if (filter.date || filter.rules.length) {
      const type = db.getType(note.typeId);
      if (filter.date && !inRange(noteDate(note, type, filter.date.key), filter.date, today)) return false;
      for (const rule of filter.rules) {
        const field = type.fields.find((f) => f.id === rule.field);
        if (!field || !testRule(field, fieldValue(note, field), rule, today)) return false;
      }
    }
    return true;
  };
}

/**
 * Runs a filter over every note.
 *   locked  a second filter that must also match, for pages tied to one collection or tag.
 *           Everything inside such a page is shown, including private notes.
 */
export function queryNotes(db, filter, { sort = { key: 'updated', dir: 'desc' }, pinnedFirst = false, locked = null, today } = {}) {
  const test = compileFilter(db, filter, { today, allowPrivate: Boolean(locked) });
  const lockedTest = locked ? compileFilter(db, { ...locked, status: 'all' }, { today, allowPrivate: true }) : null;
  const found = [];
  for (const note of db.data.notes.values()) {
    if (test(note) && (!lockedTest || lockedTest(note))) found.push(note);
  }
  return db.sortNotes(found, sort, pinnedFirst);
}

/** Plain words for a filter, shown when its panel is closed. */
export function describeFilter(db, filter) {
  const parts = [];
  const names = (list, get) => list.map((id) => get(id)?.name).filter(Boolean).join(', ');
  if (filter.status === 'archived') parts.push('Archived only');
  if (filter.status === 'all') parts.push('Including archived');
  if (filter.spaces.length) parts.push(`In ${names(filter.spaces, (id) => db.getSpace(id))}`);
  if (filter.collections.length) parts.push(`In ${names(filter.collections, (id) => db.getCollection(id))}`);
  if (filter.types.length) parts.push(names(filter.types, (id) => db.getType(id)));
  if (filter.tags.length) parts.push(`Tagged ${names(filter.tags, (id) => db.getTag(id))}`);
  if (filter.text) parts.push(`Contains "${filter.text}"`);
  if (filter.date) parts.push(DATE_RANGES.find((r) => r.value === filter.date.range)?.label ?? '');
  if (filter.includePrivate) parts.push('Including private notes');
  const fieldName = (id) => {
    for (const type of db.listTypes()) {
      const field = type.fields.find((f) => f.id === id);
      if (field) return field.name;
    }
    return id;
  };
  for (const rule of filter.rules) {
    parts.push(`${fieldName(rule.field)} ${OP_LABELS[rule.op]}${opNeedsValue(rule.op) ? ` ${rule.value}` : ''}`);
  }
  return parts.filter(Boolean);
}
