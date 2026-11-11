/**
 * types.js: note types. Built-in types are plain data in the same format as custom ones.
 *
 * NoteType:
 *   id, name, icon
 *   fields          [{ id, name, kind, options, creatable, default, summary, ... }]
 *                   kinds are defined in fieldKinds.js
 *                   summary: true shows the value on list rows and cards
 *                   default: a starting value, or 'today' for date fields
 *   defaultView     how a collection of these notes opens: see VIEWS
 *   privateByDefault  new notes stay off Home and out of search, unless you include them
 *   autoTitle       'date': the title follows the date field until you change it
 *   bodyLabel       heading above the rich text editor, when the type has other fields
 *   picker          settings for the random picker: see data/picker.js
 *   byLecture       true: offers the By lecture and By topic views
 *   focusOnNew      where the caret starts in a new note: 'title' (default) or 'body'
 *   collectionName  a name the New collection dialog suggests for a collection of these
 *   subtitleField   a field shown after the title in agendas, such as the company
 *
 * Field settings beyond kind and name:
 *   role: 'due'     a date field that's a deadline: it shows on Today and the dashboard
 *   dueLabel        what the deadline is called there ("Apply"), instead of the field's name
 *   openWhile       { field, values }: the deadline only counts while that field has one of them
 *   stamps          on a select: { option: dateFieldId }, choosing the option fills in today's date
 *   starter         on a task list: tasks every new note starts with
 *
 * Field values are stored by field id, so renaming a field keeps its data, and values survive
 * changing a note to another type and back.
 */
import { formatDay, toDateStr } from './dates.js';
import {
  emptyValue, fieldValue, FIELD_KINDS, cleanFieldDef, isEmptyValue, normalizeValue, valueToText,
} from './fieldKinds.js';
import { escapeHtml, isBodyEmpty } from './html.js';
import { DEFAULT_TYPE_ID, uid } from './schema.js';
import { createTask, earliestDue, flatten } from './tasks.js';
import { countWords, snippet } from './text.js';

export const VIEWS = Object.freeze({
  list: { label: 'List', icon: 'listBullet' },
  table: { label: 'Table', icon: 'table' },
  cards: { label: 'Cards', icon: 'grid' },
  kanban: { label: 'Kanban', icon: 'columns' },
  tasks: { label: 'Tasks', icon: 'listCheck' },
  journal: { label: 'Journal', icon: 'book' },
  calendar: { label: 'Calendar', icon: 'calendar' },
  timeline: { label: 'Timeline', icon: 'timeline' },
  lectures: { label: 'By lecture', icon: 'listNumber' },
  topics: { label: 'By topic', icon: 'tag' },
  exam: { label: 'Exam prep', icon: 'sparkle' },
});

const GENRES = ['Action', 'Comedy', 'Drama', 'Thriller', 'Horror', 'Sci-fi', 'Fantasy', 'Romance', 'Crime', 'Animation'];
const VIBES = ['Funny', 'Tense', 'Cozy', 'Emotional', 'Mind-bending', 'Light'];

function builtin(definition) {
  return Object.freeze({ builtin: true, created: 0, updated: 0, defaultView: 'list', ...definition });
}

export const BUILTIN_TYPES = Object.freeze([
  builtin({ id: DEFAULT_TYPE_ID, name: 'Free note', icon: '📝', fields: [] }),

  builtin({
    id: 'journal',
    name: 'Journal entry',
    icon: '📔',
    defaultView: 'journal',
    privateByDefault: true,
    autoTitle: 'date',
    focusOnNew: 'body',
    bodyLabel: 'Free writing',
    fields: [
      { id: 'date', name: 'Date', kind: 'date', default: 'today' },
      { id: 'mood', name: 'Mood', kind: 'mood', summary: true },
      { id: 'energy', name: 'Energy', kind: 'rating', symbol: 'bolt', summary: true },
      {
        id: 'weather', name: 'Weather', kind: 'select', creatable: true, options: ['☀️ Sunny', '⛅ Cloudy', '🌧️ Rainy', '❄️ Snowy', '💨 Windy'],
      },
      { id: 'wentWell', name: 'What went well?', kind: 'longtext' },
      { id: 'wasHard', name: 'What was hard?', kind: 'longtext' },
      { id: 'grateful', name: 'Grateful for', kind: 'longtext' },
    ],
  }),

  builtin({
    id: 'checklist',
    name: 'Checklist',
    icon: '✅',
    defaultView: 'tasks',
    bodyLabel: 'Notes',
    fields: [{ id: 'items', name: 'Tasks', kind: 'tasks', primary: true, summary: true }],
  }),

  builtin({
    id: 'watchlist',
    name: 'Watchlist item',
    icon: '🎬',
    defaultView: 'cards',
    groupBy: 'status',
    bodyLabel: 'Notes',
    picker: {
      button: 'Pick for tonight',
      title: 'Pick something for tonight',
      field: 'status',
      from: ['To watch'],
      moveTo: 'Watching',
      filters: [
        { field: 'genres', label: 'Genre' },
        { field: 'vibe', label: 'Mood' },
        { field: 'runtime', label: 'Time you have', choices: [45, 90, 120, 150], unit: 'min' },
      ],
    },
    fields: [
      { id: 'status', name: 'Status', kind: 'select', options: ['To watch', 'Watching', 'Watched', 'Dropped'], default: 'To watch', summary: true },
      { id: 'mediaKind', name: 'Type', kind: 'select', options: ['Movie', 'Series', 'Documentary'], default: 'Movie', summary: true },
      { id: 'rating', name: 'Rating', kind: 'rating', summary: true },
      { id: 'genres', name: 'Genres', kind: 'multiselect', creatable: true, options: GENRES, summary: true },
      { id: 'vibe', name: 'Mood', kind: 'multiselect', creatable: true, options: VIBES },
      { id: 'runtime', name: 'Runtime', kind: 'number', unit: 'min' },
      { id: 'whereToWatch', name: 'Where to watch', kind: 'select', creatable: true, options: [] },
      { id: 'recommendedBy', name: 'Recommended by', kind: 'select', creatable: true, options: [] },
      { id: 'dateWatched', name: 'Date watched', kind: 'date' },
      { id: 'review', name: 'Short review', kind: 'longtext', preview: true },
    ],
  }),

  builtin({
    id: 'media',
    name: 'Media list item',
    icon: '📚',
    defaultView: 'cards',
    groupBy: 'status',
    bodyLabel: 'Notes',
    picker: {
      button: 'Pick something',
      title: 'Pick something',
      field: 'status',
      from: ['To try'],
      moveTo: 'In progress',
      filters: [
        { field: 'category', label: 'Category' },
        { field: 'genres', label: 'Genre' },
        { field: 'vibe', label: 'Mood' },
      ],
    },
    fields: [
      {
        id: 'category', name: 'Category', kind: 'select', creatable: true, options: ['Book', 'Game', 'Podcast', 'Restaurant', 'Album'], summary: true,
      },
      { id: 'status', name: 'Status', kind: 'select', options: ['To try', 'In progress', 'Finished', 'Dropped'], default: 'To try', summary: true },
      { id: 'rating', name: 'Rating', kind: 'rating', summary: true },
      { id: 'genres', name: 'Genres', kind: 'multiselect', creatable: true, options: [] },
      { id: 'vibe', name: 'Mood', kind: 'multiselect', creatable: true, options: VIBES },
      { id: 'whereToFind', name: 'Where to find it', kind: 'select', creatable: true, options: [] },
      { id: 'recommendedBy', name: 'Recommended by', kind: 'select', creatable: true, options: [] },
      { id: 'dateFinished', name: 'Date finished', kind: 'date' },
      { id: 'review', name: 'Short review', kind: 'longtext', preview: true },
    ],
  }),

  builtin({
    id: 'idea',
    name: 'Idea',
    icon: '💡',
    defaultView: 'cards',
    groupBy: 'category',
    bodyLabel: 'Notes',
    picker: {
      button: 'Surprise me',
      title: 'Surprise me',
      big: true,
      filters: [
        { field: 'minutes', label: 'Time you have', choices: [15, 30, 60, 120], unit: 'min' },
        { field: 'effort', label: 'Energy' },
        { field: 'category', label: 'Mood' },
        {
          field: 'setting', label: 'Where', also: { Indoors: ['Either'], Outdoors: ['Either'] }, emptyPasses: true,
        },
      ],
      done: { count: 'timesDone', date: 'lastDone' },
    },
    fields: [
      {
        id: 'category', name: 'Category', kind: 'select', creatable: true, options: ['Creative', 'Active', 'Social', 'Cozy', 'Learning', 'Outside'], summary: true,
      },
      { id: 'effort', name: 'Effort', kind: 'select', options: ['Low', 'Medium', 'High'], summary: true },
      { id: 'minutes', name: 'Time needed', kind: 'number', unit: 'min', summary: true },
      { id: 'cost', name: 'Cost', kind: 'text' },
      { id: 'setting', name: 'Indoors or outdoors', kind: 'select', options: ['Indoors', 'Outdoors', 'Either'] },
      { id: 'lastDone', name: 'Last done', kind: 'date' },
      { id: 'timesDone', name: 'Times done', kind: 'number' },
    ],
  }),

  builtin({
    id: 'course',
    name: 'Course note',
    icon: '🎓',
    defaultView: 'lectures',
    byLecture: true,
    bodyLabel: 'Lecture notes',
    fields: [
      { id: 'course', name: 'Course', kind: 'collection', summary: true },
      { id: 'lecture', name: 'Lecture number', kind: 'number', summary: true },
      { id: 'date', name: 'Lecture date', kind: 'date', default: 'today' },
      { id: 'topic', name: 'Topic', kind: 'text', summary: true },
      { id: 'concepts', name: 'Key concepts', kind: 'longtext' },
      { id: 'questions', name: 'Questions to ask', kind: 'longtext' },
      { id: 'summary', name: 'Summary', kind: 'longtext', preview: true },
      { id: 'cards', name: 'Flashcards', kind: 'flashcards', summary: true },
    ],
  }),

  builtin({
    id: 'quote',
    name: 'Quote or snippet',
    icon: '💬',
    defaultView: 'cards',
    bodyLabel: 'Notes',
    fields: [
      { id: 'quote', name: 'Quote', kind: 'longtext', preview: true },
      { id: 'author', name: 'Author', kind: 'select', creatable: true, options: [], summary: true },
      { id: 'source', name: 'Source', kind: 'text', summary: true },
    ],
  }),

  builtin({
    id: 'link',
    name: 'Link or resource',
    icon: '🔗',
    defaultView: 'table',
    groupBy: 'readStatus',
    bodyLabel: 'Notes',
    fields: [
      { id: 'url', name: 'Web address', kind: 'url', summary: true },
      { id: 'readStatus', name: 'Status', kind: 'select', options: ['To read', 'Reading', 'Read'], default: 'To read', summary: true },
      { id: 'why', name: 'Why I saved it', kind: 'longtext', preview: true },
    ],
  }),

  builtin({
    id: 'goal',
    name: 'Goal',
    icon: '🎯',
    defaultView: 'cards',
    bodyLabel: 'Notes',
    fields: [
      { id: 'target', name: 'Target', kind: 'text', summary: true },
      { id: 'deadline', name: 'Deadline', kind: 'date', role: 'due', summary: true },
      { id: 'progress', name: 'Progress', kind: 'number', unit: '%', summary: true },
      { id: 'milestones', name: 'Milestones', kind: 'tasks' },
    ],
  }),

  builtin({
    id: 'jobApplication',
    name: 'Job application',
    collectionName: 'Job applications',
    icon: '💼',
    defaultView: 'kanban',
    groupBy: 'status',
    bodyLabel: 'Notes',
    subtitleField: 'company',
    fields: [
      { id: 'company', name: 'Company', kind: 'text', summary: true },
      {
        id: 'status',
        name: 'Status',
        kind: 'select',
        options: ['Interested', 'Preparing', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'],
        default: 'Interested',
        summary: true,
        stamps: { Applied: 'appliedOn' },
      },
      {
        id: 'deadline', name: 'Deadline', kind: 'date', role: 'due', dueLabel: 'Apply', openWhile: { field: 'status', values: ['', 'Interested', 'Preparing'] }, summary: true,
      },
      {
        id: 'interview', name: 'Next interview', kind: 'date', role: 'due', dueLabel: 'Interview', openWhile: { field: 'status', values: ['Applied', 'Interviewing'] }, summary: true,
      },
      { id: 'location', name: 'Location', kind: 'text' },
      { id: 'workMode', name: 'Work mode', kind: 'select', options: ['On-site', 'Hybrid', 'Remote'] },
      { id: 'salary', name: 'Salary', kind: 'text' },
      { id: 'posting', name: 'Job posting', kind: 'url' },
      {
        id: 'foundVia', name: 'Found through', kind: 'select', creatable: true, options: ['LinkedIn', 'Company website', 'Job board', 'Referral', 'Career fair'],
      },
      { id: 'contact', name: 'Contact person', kind: 'text' },
      { id: 'appliedOn', name: 'Applied on', kind: 'date' },
      { id: 'excitement', name: 'How much I want it', kind: 'rating' },
      {
        id: 'todo', name: 'To do', kind: 'tasks', starter: ['Tailor CV', 'Write cover letter', 'Send application'],
      },
    ],
  }),

  builtin({
    id: 'phdApplication',
    name: 'PhD application',
    collectionName: 'PhD applications',
    icon: '🎓',
    defaultView: 'kanban',
    groupBy: 'status',
    bodyLabel: 'Notes',
    subtitleField: 'university',
    fields: [
      { id: 'university', name: 'University', kind: 'text', summary: true },
      {
        id: 'status',
        name: 'Status',
        kind: 'select',
        options: ['Researching', 'Contacted supervisor', 'Preparing', 'Submitted', 'Interview', 'Offer', 'Rejected', 'Withdrawn'],
        default: 'Researching',
        summary: true,
        stamps: { Submitted: 'submittedOn' },
      },
      {
        id: 'deadline', name: 'Deadline', kind: 'date', role: 'due', dueLabel: 'Apply', openWhile: { field: 'status', values: ['', 'Researching', 'Contacted supervisor', 'Preparing'] }, summary: true,
      },
      {
        id: 'interview', name: 'Interview', kind: 'date', role: 'due', dueLabel: 'Interview', openWhile: { field: 'status', values: ['Submitted', 'Interview'] }, summary: true,
      },
      { id: 'supervisor', name: 'Supervisor', kind: 'text' },
      { id: 'group', name: 'Research group', kind: 'text' },
      { id: 'country', name: 'Country', kind: 'select', creatable: true, options: [] },
      { id: 'funding', name: 'Funding', kind: 'select', options: ['Fully funded', 'Partly funded', 'Not funded', 'Unknown'] },
      { id: 'stipend', name: 'Stipend', kind: 'text' },
      { id: 'startDate', name: 'Start date', kind: 'date' },
      { id: 'page', name: 'Programme page', kind: 'url' },
      { id: 'contactedOn', name: 'Supervisor contacted on', kind: 'date' },
      { id: 'submittedOn', name: 'Submitted on', kind: 'date' },
      { id: 'fit', name: 'How much I want it', kind: 'rating' },
      {
        id: 'documents',
        name: 'Documents',
        kind: 'tasks',
        starter: ['CV', 'Research proposal', 'Motivation letter', 'Reference letter 1', 'Reference letter 2', 'Transcripts and certificates', 'Language certificate'],
      },
    ],
  }),

  builtin({
    id: 'meeting',
    name: 'Meeting or call',
    icon: '🗓️',
    bodyLabel: 'Notes',
    fields: [
      { id: 'date', name: 'Date', kind: 'date', default: 'today', summary: true },
      { id: 'attendees', name: 'Attendees', kind: 'multiselect', creatable: true, options: [], summary: true },
      { id: 'decisions', name: 'Decisions', kind: 'longtext', preview: true },
      { id: 'actions', name: 'Action items', kind: 'tasks' },
    ],
  }),
]);

/** Starting values for a new note. A task list's `starter` gives it fresh tasks to tick off. */
export function defaultFieldValues(type, now = Date.now()) {
  const values = {};
  for (const field of type.fields) {
    if (field.kind === 'tasks' && field.starter?.length) values[field.id] = field.starter.map((text) => createTask(text));
    else if (field.default === 'today') values[field.id] = toDateStr(new Date(now));
    else if (field.default !== undefined) values[field.id] = field.default;
    else values[field.id] = emptyValue(field);
  }
  return values;
}

/** The title a type gives a note on its own, or '' when it has none. */
export function autoTitleFor(type, values) {
  if (type.autoTitle !== 'date' || !values.date) return '';
  return formatDay(values.date, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** Views a collection of this type can show. */
export function viewsFor(type) {
  const views = [];
  if (type.fields.some((f) => f.kind === 'mood')) views.push('journal');
  if (type.fields.some((f) => f.kind === 'tasks')) views.push('tasks');
  if (type.byLecture) views.push('lectures', 'topics');
  if (type.fields.some((f) => f.kind === 'flashcards')) views.push('exam');
  views.push('list', 'table', 'cards');
  if (groupableFields(type).length) views.push('kanban');
  views.push('calendar', 'timeline');
  return views;
}

/** The dates a Calendar or Timeline can be laid out by. */
export function dateKeysFor(type) {
  const keys = type.fields.filter((f) => f.kind === 'date').map((f) => ({ key: `field:${f.id}`, label: f.name }));
  if (type.fields.some((f) => f.kind === 'tasks' || f.role === 'due')) keys.push({ key: 'due', label: 'Next due date' });
  keys.push({ key: 'created', label: 'Created' }, { key: 'updated', label: 'Last updated' });
  return keys;
}

/** A note's date for a key from dateKeysFor, or '' when it has none. */
export function noteDate(note, type, key) {
  if (key === 'created' || key === 'updated') return toDateStr(new Date(note[key]));
  if (key === 'due') return noteDueDate(note, type);
  const field = type.fields.find((f) => `field:${f.id}` === key);
  return field && field.kind === 'date' ? fieldValue(note, field) : '';
}

/**
 * A stand-in type for a list of notes of different types, as in a saved view: the short fields
 * they have in common by id, so Table and Kanban have columns to show.
 */
export function unionType(types) {
  if (types.length === 1) return types[0];
  const fields = new Map();
  for (const type of types) {
    for (const field of summaryFields(type)) {
      if (!fields.has(field.id)) fields.set(field.id, field);
    }
  }
  return { id: '__mixed', name: 'Mixed', icon: '📄', fields: [...fields.values()].filter((f) => f.kind !== 'tasks'), defaultView: 'list' };
}

export function groupableFields(type) {
  return type.fields.filter((f) => f.kind === 'select');
}

export function defaultGroupField(type) {
  const fields = groupableFields(type);
  return fields.find((f) => f.id === type.groupBy) ?? fields[0] ?? null;
}

/** Fields shown on rows and cards. Without any marked, the first few short fields are used. */
export function summaryFields(type) {
  const marked = type.fields.filter((f) => f.summary);
  if (marked.length) return marked;
  return type.fields.filter((f) => !['longtext', 'tasks'].includes(f.kind)).slice(0, 3);
}

export function tableFields(type) {
  return type.fields.filter((f) => f.kind !== 'longtext');
}

export function flashcardFields(type) {
  return type.fields.filter((f) => f.kind === 'flashcards');
}

export function tasksFields(type) {
  return type.fields.filter((f) => f.kind === 'tasks');
}

/**
 * Whether a deadline field still matters. A field with openWhile only counts while another field
 * (a status) has one of the listed values: an application deadline stops mattering once it's sent.
 */
export function dueIsOpen(note, type, field) {
  const rule = field.openWhile;
  if (!rule) return true;
  const by = type.fields.find((f) => f.id === rule.field);
  return !by || rule.values.includes(fieldValue(note, by));
}

/**
 * Field changes that follow from a patch: a select whose `stamps` names a date field for the new
 * value fills that date with today, when it's still empty. { fieldId: value }, often empty.
 */
export function stampedFields(type, before, after, today) {
  const extra = {};
  for (const field of type.fields) {
    const target = field.kind === 'select' ? field.stamps?.[normalizeValue(field, after[field.id])] : null;
    if (!target || normalizeValue(field, before[field.id]) === normalizeValue(field, after[field.id])) continue;
    const dateField = type.fields.find((f) => f.id === target && f.kind === 'date');
    if (dateField && !normalizeValue(dateField, after[target])) extra[target] = today;
  }
  return extra;
}

/** The name an agenda shows for a note: its title, and its subtitle field (a company) when set. */
export function agendaTitle(note, type) {
  const title = displayTitle(note, type) || 'Untitled';
  const field = type.subtitleField && type.fields.find((f) => f.id === type.subtitleField);
  const extra = field ? String(fieldValue(note, field) ?? '').trim() : '';
  return extra && extra !== title ? `${title} · ${extra}` : title;
}

/** The next date a note needs attention: its earliest open task, or its deadline. */
export function noteDueDate(note, type) {
  let due = '';
  for (const field of type.fields) {
    if (field.kind === 'tasks') {
      const next = earliestDue(fieldValue(note, field));
      if (next && (!due || next < due)) due = next;
    } else if (field.role === 'due' && dueIsOpen(note, type, field)) {
      const value = fieldValue(note, field);
      if (value && (!due || value < due)) due = value;
    }
  }
  return due;
}

/** The name to show for a note: its title, or else its first field with text. */
export function displayTitle(note, type) {
  if (note.title) return note.title;
  for (const field of type.fields) {
    if (field.kind === 'text' || field.kind === 'longtext') {
      const value = fieldValue(note, field);
      if (value) return snippet(value, 80);
    }
  }
  return '';
}

/** Words the person wrote: the body plus all long text fields. */
export function noteWords(note, type) {
  let total = countWords(note.text);
  for (const field of type.fields) {
    if (field.kind === 'longtext') total += countWords(fieldValue(note, field));
  }
  return total;
}

/** True when a new note was left untouched, so it can be removed instead of cluttering lists. */
export function isBlankNote(note, type, defaults = defaultFieldValues(type, note.created)) {
  if (note.title && note.title !== autoTitleFor(type, defaults)) return false;
  if (note.tagIds?.length) return false;
  if (!isBodyEmpty(note.body)) return false;
  return type.fields.every((field) => {
    const value = fieldValue(note, field);
    // Starter tasks get new ids each time, so they're compared by what they say.
    if (field.kind === 'tasks' && field.starter?.length) {
      return flatten(value).every(({ item }) => !item.done && !item.due) && JSON.stringify(flatten(value).map(({ item }) => item.text)) === JSON.stringify(field.starter);
    }
    return isEmptyValue(field, value) || JSON.stringify(value) === JSON.stringify(defaults[field.id]);
  });
}

/** Field values as HTML. Used to keep the data readable when a type is deleted. */
export function fieldsToHtml(note, type, collectionName = (id) => id) {
  let html = '';
  for (const field of type.fields) {
    const value = fieldValue(note, field);
    if (!isEmptyValue(field, value)) {
      if (field.kind === 'tasks') {
        const items = flatten(value).map(({ item }) => `<li data-checked="${item.done}">${escapeHtml(item.text) || '<br>'}</li>`).join('');
        html += `<p><strong>${escapeHtml(field.name)}</strong></p><ul data-type="check">${items}</ul>`;
      } else if (field.kind === 'collection') {
        html += `<p><strong>${escapeHtml(field.name)}:</strong> ${escapeHtml(collectionName(value))}</p>`;
      } else {
        html += `<p><strong>${escapeHtml(field.name)}:</strong> ${escapeHtml(valueToText(field, value))}</p>`;
      }
    }
  }
  return html;
}

export function createCustomType({ id = uid(), name = 'New type', icon = '📄', fields = [], now = Date.now() } = {}) {
  return {
    id, name, icon, builtin: false, fields, defaultView: 'list', privateByDefault: false, bodyLabel: 'Notes', created: now, updated: now,
  };
}

/** Rebuilds a custom type from untrusted data. A type can't pretend to be built-in. */
export function cleanType(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) return null;
  if (typeof raw.name !== 'string') return null;
  const seen = new Set();
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).map(cleanFieldDef).filter((field) => {
    if (!field || seen.has(field.id)) return false;
    seen.add(field.id);
    return true;
  });
  const type = {
    ...createCustomType({ id: raw.id, name: raw.name.slice(0, 80) || 'Untitled type', icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 16) : '📄', fields, now }),
    privateByDefault: raw.privateByDefault === true,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
  if (viewsFor(type).includes(raw.defaultView)) type.defaultView = raw.defaultView;
  if (typeof raw.bodyLabel === 'string') type.bodyLabel = raw.bodyLabel.slice(0, 80);
  return type;
}

/** Text for the preview on a card: the field marked for it, or else the note's text. */
export function previewText(note, type) {
  for (const field of type.fields) {
    if (field.preview) {
      const value = fieldValue(note, field);
      if (value) return String(value);
    }
  }
  return note.text ?? '';
}

/** Kinds offered in the custom type builder, in menu order. */
export const BUILDER_KINDS = Object.freeze(Object.entries(FIELD_KINDS).filter(([, kind]) => kind.inBuilder).map(([id, kind]) => ({ id, label: kind.label })));
