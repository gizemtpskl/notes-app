/**
 * ops.js: what Claude can do with your notes. Each operation takes the app's NotesDb (see
 * notes.js) and plain arguments, and returns plain data for Claude to read. No deleting: a note
 * can be archived, which hides it but keeps it.
 *
 * Private notes never reach the server readable, and are skipped here as well, in case one does.
 * Problems Claude can fix (an unknown field, a status that isn't an option) throw ToolError with
 * a sentence saying what would work.
 */
import { addDays, isDateStr } from '../../js/data/dates.js';
import { FIELD_KINDS, fieldValue, isEmptyValue, normalizeValue, valueToText } from '../../js/data/fieldKinds.js';
import { htmlToMarkdown } from '../../js/data/html.js';
import { RuleError } from '../../js/data/schema.js';
import { searchNotes } from '../../js/data/search.js';
import {
  createTask, flatten, locate, toggleTask, updateTask,
} from '../../js/data/tasks.js';
import { BLOCK_TYPES, isTime, occurrencesBetween } from '../../js/data/timetable.js';
import {
  agendaTitle, displayTitle, dueIsOpen, summaryFields, tasksFields,
} from '../../js/data/types.js';
import { markdownToHtml } from './markdown.js';

export class ToolError extends Error {}

const MAX_TEXT = 100_000;
const visible = (note) => note && !note.private && !note.trashedAt;

// -- Describing things ---------------------------------------------------------------------

function placeOf(db, note) {
  if (!note.spaceId) return 'Inbox';
  const space = db.getSpace(note.spaceId)?.name ?? '';
  const col = db.getCollection(note.collectionId);
  if (!col) return space;
  const parent = col.parentId ? db.getCollection(col.parentId)?.name : '';
  return [space, parent, col.name].filter(Boolean).join(' / ');
}

function fieldsOf(note, type, { all = false } = {}) {
  const out = {};
  for (const field of all ? type.fields : summaryFields(type)) {
    if (field.kind === 'tasks' || field.kind === 'flashcards') continue;
    const value = fieldValue(note, field);
    if (!isEmptyValue(field, value)) out[field.name] = field.kind === 'number' || field.kind === 'checkbox' || field.kind === 'rating' ? value : valueToText(field, value);
  }
  return out;
}

function noteSummary(db, note) {
  const type = db.getType(note.typeId);
  return {
    id: note.id,
    title: displayTitle(note, type) || 'Untitled',
    type: type.name,
    where: placeOf(db, note),
    fields: fieldsOf(note, type),
    updated: new Date(note.updated).toISOString().slice(0, 16).replace('T', ' '),
    ...(note.archived ? { archived: true } : {}),
  };
}

function tasksOut(items) {
  return flatten(items).map(({ item, parent }) => ({
    id: item.id,
    text: item.text,
    done: item.done,
    ...(item.due ? { due: item.due } : {}),
    ...(item.time ? { time: item.time } : {}),
    ...(parent ? { subtaskOf: parent.id } : {}),
  }));
}

// -- Finding things ------------------------------------------------------------------------

function requireNote(db, id) {
  const note = db.getNote(String(id ?? ''));
  if (!visible(note)) throw new ToolError(`There's no note with id "${id}". Use search_notes to find its id.`);
  return note;
}

function findCollection(db, value) {
  if (!value) return null;
  const wanted = String(value).trim().toLowerCase();
  const all = db.allCollections();
  const col = all.find((c) => c.id === value) ?? all.find((c) => c.name.toLowerCase() === wanted);
  if (!col) throw new ToolError(`There's no collection "${value}". list_spaces shows them all.`);
  return col;
}

function findType(db, value) {
  if (!value) return null;
  const wanted = String(value).trim().toLowerCase();
  const types = db.listTypes();
  const type = types.find((t) => t.id === value) ?? types.find((t) => t.name.toLowerCase() === wanted);
  if (!type) throw new ToolError(`There's no note type "${value}". Types: ${types.map((t) => t.name).join(', ')}.`);
  return type;
}

function findField(type, key) {
  const wanted = String(key).trim().toLowerCase();
  const field = type.fields.find((f) => f.id === key) ?? type.fields.find((f) => f.name.toLowerCase() === wanted);
  if (!field) {
    const names = type.fields.filter((f) => f.kind !== 'tasks').map((f) => f.name);
    throw new ToolError(`A ${type.name} has no field "${key}".${names.length ? ` Its fields: ${names.join(', ')}.` : ' It has no fields.'}`);
  }
  return field;
}

/** A value from Claude for a field, checked and in the form the app stores. */
function fieldInput(db, type, field, raw) {
  const bad = (what) => new ToolError(`${field.name} needs ${what}.`);
  if (raw === null || raw === '') return normalizeValue(field, FIELD_KINDS[field.kind]?.empty ?? '');
  switch (field.kind) {
    case 'tasks': throw new ToolError(`${field.name} is a task list: use add_task and update_task for it.`);
    case 'flashcards': throw new ToolError(`${field.name} holds flashcards, which are edited in the app.`);
    case 'collection': throw new ToolError(`${field.name} is set by where the note is: use move_to in update_note.`);
    case 'date':
      if (!isDateStr(raw)) throw bad('a date written YYYY-MM-DD');
      return raw;
    case 'number': {
      const value = normalizeValue(field, raw);
      if (value === null) throw bad('a number');
      return value;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') throw bad('true or false');
      return raw;
    case 'rating':
    case 'mood': {
      const max = field.kind === 'mood' ? 5 : field.max ?? 5;
      if (!Number.isInteger(raw) || raw < 0 || raw > max) throw bad(`a whole number from 0 to ${max}`);
      return raw;
    }
    case 'select': {
      const value = String(raw);
      const option = (field.options ?? []).find((o) => o.toLowerCase() === value.trim().toLowerCase());
      if (option) return option;
      if (field.creatable) return value.trim().slice(0, 200);
      throw bad(`one of: ${(field.options ?? []).join(', ')}`);
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : [raw];
      return normalizeValue(field, list.map((item) => {
        const option = (field.options ?? []).find((o) => o.toLowerCase() === String(item).trim().toLowerCase());
        if (option) return option;
        if (field.creatable) return String(item).trim().slice(0, 200);
        throw bad(`values from: ${(field.options ?? []).join(', ')}`);
      }));
    }
    case 'relation':
      return requireNote(db, raw).id;
    default:
      if (typeof raw !== 'string' && typeof raw !== 'number') throw bad('text');
      return String(raw).slice(0, MAX_TEXT);
  }
}

function fieldsInput(db, type, given, current = {}) {
  if (given == null) return current;
  if (typeof given !== 'object' || Array.isArray(given)) throw new ToolError('fields needs an object of field names and values.');
  const values = { ...current };
  for (const [key, raw] of Object.entries(given)) {
    const field = findField(type, key);
    values[field.id] = fieldInput(db, type, field, raw);
  }
  return values;
}

const rule = (fn) => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RuleError) throw new ToolError(error.message);
    throw error;
  }
};

// -- Reading -------------------------------------------------------------------------------

export function listSpaces(db) {
  const counts = db.counts();
  const collection = (col) => ({
    id: col.id,
    name: col.name,
    notesAre: db.getType(col.defaultTypeId).name,
    notes: counts.collections.get(col.id) ?? 0,
    ...(db.listCollections(col.spaceId, col.id).length ? { inside: db.listCollections(col.spaceId, col.id).map(collection) } : {}),
  });
  return {
    inbox: counts.inbox,
    spaces: db.listSpaces().map((space) => ({
      id: space.id, name: space.name, notes: counts.spaces.get(space.id) ?? 0, collections: db.listCollections(space.id, null).map(collection),
    })),
  };
}

export function listNoteTypes(db) {
  return db.listTypes().map((type) => ({
    id: type.id,
    name: type.name,
    fields: type.fields.map((f) => ({
      name: f.name,
      kind: f.kind,
      ...(f.options?.length ? { options: f.options } : {}),
      ...(f.creatable ? { otherValuesAllowed: true } : {}),
      ...(f.role === 'due' ? { deadline: true } : {}),
    })),
  }));
}

export function findNotes(db, {
  query = '', collection, type, includeArchived = false, limit = 25,
} = {}) {
  const col = findCollection(db, collection);
  const noteType = findType(db, type);
  const max = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const status = includeArchived ? 'all' : 'active';
  let found;
  if (String(query).trim()) {
    found = searchNotes(db, String(query), {
      collectionId: col?.id, typeId: noteType?.id, status: includeArchived ? 'all' : 'active', limit: max * 2,
    }).filter((r) => visible(r.note)).map((r) => ({ ...noteSummary(db, r.note), ...(r.snippet ? { match: r.snippet } : {}) }));
  } else {
    found = db.listNotes({ status, collectionId: col?.id, includeChildren: true })
      .filter((note) => visible(note) && (!noteType || note.typeId === noteType.id))
      .map((note) => noteSummary(db, note));
  }
  return { count: found.length, notes: found.slice(0, max) };
}

export function readNote(db, { id }) {
  const note = requireNote(db, id);
  const type = db.getType(note.typeId);
  const tasks = {};
  for (const field of tasksFields(type)) tasks[field.name] = tasksOut(fieldValue(note, field));
  return {
    ...noteSummary(db, note),
    fields: fieldsOf(note, type, { all: true }),
    ...(Object.keys(tasks).length ? { tasks } : {}),
    tags: note.tagIds.map((tagId) => db.getTag(tagId)?.name).filter(Boolean),
    text: htmlToMarkdown(note.body),
    created: new Date(note.created).toISOString().slice(0, 10),
  };
}

/** Tasks, deadlines and timetable blocks from one day to another, and overdue tasks before them. */
export function agenda(db, { from, to, today }) {
  const start = isDateStr(from) ? from : today;
  const end = isDateStr(to) ? to : addDays(start, 6);
  if (end < start) throw new ToolError('to is before from.');
  if (addDays(start, 92) < end) throw new ToolError('Ask for at most three months at a time.');
  const days = new Map();
  const add = (date, entry) => {
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(entry);
  };
  const overdue = [];
  for (const note of db.listNotes()) {
    if (!visible(note)) continue;
    const type = db.getType(note.typeId);
    for (const field of type.fields) {
      if (field.kind === 'tasks') {
        for (const { item } of flatten(fieldValue(note, field))) {
          if (!item.due || item.done) continue;
          const entry = {
            kind: 'task', text: item.text, ...(item.time ? { time: item.time } : {}), note: displayTitle(note, type) || 'Untitled', noteId: note.id, taskId: item.id,
          };
          if (item.due < start && item.due < today) overdue.push({ ...entry, due: item.due });
          else if (item.due >= start && item.due <= end) add(item.due, entry);
        }
      } else if (field.role === 'due' && dueIsOpen(note, type, field)) {
        const due = fieldValue(note, field);
        const progress = type.fields.find((f) => f.id === 'progress');
        if (!due || (progress && fieldValue(note, progress) >= 100)) continue;
        const entry = { kind: 'deadline', text: `${field.dueLabel ?? field.name}: ${agendaTitle(note, type)}`, noteId: note.id };
        if (due < start && due < today) overdue.push({ ...entry, due });
        else if (due >= start && due <= end) add(due, entry);
      }
    }
  }
  const lookups = {
    semesters: new Map(db.listSemesters().map((s) => [s.id, s])),
    spaces: new Map(db.listSpaces().map((s) => [s.id, s])),
  };
  for (const o of occurrencesBetween(db.listBlocks(), start, end, lookups)) {
    if (o.cancelled) continue;
    add(o.date, {
      kind: 'timetable', text: o.title, time: o.start, until: o.end, ...(o.location ? { place: o.location } : {}), blockId: o.blockId,
    });
  }
  const order = (a, b) => (a.time ?? '99').localeCompare(b.time ?? '99');
  return {
    today,
    from: start,
    to: end,
    ...(overdue.length ? { overdue: overdue.sort((a, b) => a.due.localeCompare(b.due)) } : {}),
    days: [...days.keys()].sort().map((date) => ({ date, items: days.get(date).sort(order) })),
  };
}

// -- Changing ------------------------------------------------------------------------------

export function newNote(db, {
  title = '', collection, type, fields, text,
}) {
  const col = findCollection(db, collection);
  const noteType = findType(db, type) ?? (col ? db.getType(col.defaultTypeId) : db.getType('free'));
  const values = fieldsInput(db, noteType, fields);
  const note = rule(() => db.createNote({
    title: String(title).slice(0, 300),
    collectionId: col?.id ?? null,
    typeId: noteType.id,
    fields: values,
    body: text ? markdownToHtml(String(text).slice(0, MAX_TEXT)) : '',
  }));
  if (note.private) {
    // A type that's private by default, such as a journal entry: Claude made it, so it stays readable.
    db.updateNote(note.id, { private: false });
  }
  return readNote(db, { id: note.id });
}

export function changeNote(db, {
  id, title, fields, appendText, replaceText, moveTo, archived,
}) {
  const note = requireNote(db, id);
  const type = db.getType(note.typeId);
  if (appendText != null && replaceText != null) throw new ToolError('Use append_text or replace_text, not both.');
  const patch = {};
  if (title != null) patch.title = String(title).slice(0, 300);
  if (fields != null) patch.fields = fieldsInput(db, type, fields, note.fields);
  if (replaceText != null) patch.body = markdownToHtml(String(replaceText).slice(0, MAX_TEXT));
  if (appendText != null) patch.body = `${note.body}${markdownToHtml(String(appendText).slice(0, MAX_TEXT))}`;
  if (archived != null) patch.archived = archived === true;
  rule(() => {
    db.batch(() => {
      if (Object.keys(patch).length) db.updateNote(note.id, patch);
      if (moveTo != null) {
        if (moveTo === 'Inbox' || moveTo === 'inbox') db.moveNotes([note.id], {});
        else db.moveNotes([note.id], { collectionId: findCollection(db, moveTo).id });
      }
    });
  });
  return readNote(db, { id: note.id });
}

function taskListOf(db, note, listName) {
  const type = db.getType(note.typeId);
  const lists = tasksFields(type);
  if (!lists.length) throw new ToolError(`"${displayTitle(note, type) || 'This note'}" has no task list. Add tasks to a checklist note, or make one with create_note and type Checklist.`);
  if (!listName) return lists[0];
  return lists.find((f) => f.id === listName || f.name.toLowerCase() === String(listName).toLowerCase())
    ?? (() => { throw new ToolError(`That note's task lists are: ${lists.map((f) => f.name).join(', ')}.`); })();
}

function checkWhen(due, time) {
  if (due != null && due !== '' && !isDateStr(due)) throw new ToolError('due needs a date written YYYY-MM-DD.');
  if (time != null && time !== '' && !isTime(time)) throw new ToolError('time needs a 24-hour time written HH:MM.');
  if (time && !due) throw new ToolError('A task with a time needs a due date too.');
}

export function newTask(db, {
  noteId, text, due, time, list,
}) {
  const note = requireNote(db, noteId);
  if (!String(text ?? '').trim()) throw new ToolError('A task needs some text.');
  checkWhen(due, time);
  const field = taskListOf(db, note, list);
  const task = createTask(String(text).trim().slice(0, 1000), { due: due || '', time: (due && time) || '' });
  db.updateTasks(note.id, field.id, (items) => [...items, task]);
  return { added: task.id, note: readNote(db, { id: note.id }) };
}

export function changeTask(db, {
  noteId, taskId, done, text, due, time, today,
}) {
  const note = requireNote(db, noteId);
  const type = db.getType(note.typeId);
  const field = tasksFields(type).find((f) => locate(fieldValue(note, f), taskId));
  if (!field) throw new ToolError(`That note has no task with id "${taskId}". read_note lists its tasks.`);
  const current = locate(fieldValue(note, field), taskId).item;
  const patch = {};
  if (text != null) patch.text = String(text).slice(0, 1000);
  if (due !== undefined) patch.due = due || '';
  if (time !== undefined) patch.time = time || '';
  checkWhen(patch.due ?? current.due, patch.time ?? current.time);
  db.batch(() => {
    if (Object.keys(patch).length) db.updateTasks(note.id, field.id, (items) => updateTask(items, taskId, patch));
    // Ticking goes through the app's own rule, so a repeating task moves to its next date.
    if (done != null && Boolean(done) !== current.done) db.updateTasks(note.id, field.id, (items) => toggleTask(items, taskId, { today }));
  });
  return { note: readNote(db, { id: note.id }) };
}

export function newBlock(db, {
  title, date, start, end, repeatWeekly = false, until, location, kind,
}) {
  if (!String(title ?? '').trim()) throw new ToolError('A block needs a title.');
  if (!isDateStr(date)) throw new ToolError('date needs to be written YYYY-MM-DD.');
  if (!isTime(start) || !isTime(end)) throw new ToolError('start and end need 24-hour times written HH:MM.');
  if (until != null && until !== '' && !isDateStr(until)) throw new ToolError('until needs to be written YYYY-MM-DD.');
  const block = rule(() => db.createBlock({
    title: String(title).trim().slice(0, 300),
    date,
    start,
    end,
    type: BLOCK_TYPES.some((t) => t.value === kind) ? kind : 'other',
    location: String(location ?? '').slice(0, 300),
    repeat: repeatWeekly ? { days: [], weeks: 'every', until: until || '' } : null,
  }));
  return {
    id: block.id, title: block.title, date: block.date, start: block.start, end: block.end, repeats: Boolean(block.repeat), location: block.location,
  };
}
