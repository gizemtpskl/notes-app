/**
 * daily.js: where tasks typed on the Today page are kept.
 *
 * They go in an ordinary checklist note, one per month, so they can be opened, edited and moved
 * like any other list, and no single note keeps growing for years. A task is simply due on the day
 * it was added, unless the text says otherwise. Anything unfinished becomes overdue and stays on the
 * Today page, even after the month has moved on to a new note.
 */
import { parseDate, toDateStr } from './dates.js';
import { createTask } from './tasks.js';
import { parseTaskLine } from './taskText.js';

const TYPE_ID = 'checklist';
const FIELD_ID = 'items';
const META_KEY = 'dailyList';
const TO_DO_NAME = /to[- ]?do|task/i;

export function dailyListTitle(today) {
  const month = parseDate(today).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return `Daily to-dos, ${month}`;
}

/** This month's list, or null. A renamed or moved list is still found, while one in Trash or Archive isn't. */
function findList(db, today) {
  const saved = db.getMeta(META_KEY);
  if (saved?.month === today.slice(0, 7)) {
    const note = db.getNote(saved.noteId);
    if (note && note.typeId === TYPE_ID && !note.trashedAt && !note.archived) return note;
  }
  // Backups don't carry the pointer, so after a restore the list is found by its title.
  const title = dailyListTitle(today);
  return db.listNotes().find((note) => note.typeId === TYPE_ID && note.title === title) ?? null;
}

/** A to-do collection, then any checklist collection, then the first space, and the Inbox last. */
function listHome(db) {
  const lists = db.allCollections().filter((collection) => collection.defaultTypeId === TYPE_ID);
  const collection = lists.find((c) => TO_DO_NAME.test(c.name)) ?? lists[0];
  if (collection) return { collectionId: collection.id };
  const [space] = db.listSpaces();
  return space ? { spaceId: space.id } : {};
}

/** Adds tasks from drafts ({ text, time, due }) in one step. A draft with no date is due today. */
export function addDailyTasks(db, drafts, today = toDateStr()) {
  const tasks = drafts
    .filter((draft) => draft.text.trim())
    .map((draft) => createTask(draft.text.trim(), { due: draft.due || today, time: draft.time ?? '' }));
  if (!tasks.length) return tasks;
  const month = today.slice(0, 7);
  db.batch(() => {
    const existing = findList(db, today);
    if (existing) db.updateTasks(existing.id, FIELD_ID, (items) => [...items, ...tasks]);
    const noteId = existing?.id ?? db.createNote({
      title: dailyListTitle(today), typeId: TYPE_ID, ...listHome(db), fields: { [FIELD_ID]: tasks },
    }).id;
    const saved = db.getMeta(META_KEY);
    if (saved?.month !== month || saved.noteId !== noteId) db.setMeta(META_KEY, { month, noteId });
  });
  return tasks;
}

/** Reads a line of messy text and adds it. Returns the task, or null if the text is blank. */
export function addDailyTask(db, text, today = toDateStr()) {
  const draft = parseTaskLine(text, today);
  return draft ? addDailyTasks(db, [draft], today)[0] : null;
}
