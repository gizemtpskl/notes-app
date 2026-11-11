/**
 * operations.js: the tools Claude sees, with their descriptions and arguments. Each one runs in
 * the NotesStore (store.js) through ops.js. `writes` marks the ones that change your notes.
 */
import { z } from 'zod';
import {
  agenda, changeNote, changeTask, findNotes, listNoteTypes, listSpaces, newBlock, newNote, newTask, readNote,
} from './ops.js';

const date = z.string().describe('A date, YYYY-MM-DD');
const time = z.string().describe('A 24-hour time, HH:MM');
const fields = z.record(z.string(), z.unknown()).describe('Field names and values, e.g. {"Status": "Applied", "Deadline": "2026-12-01"}. list_note_types shows each type\'s fields and allowed options.');

export const OPERATIONS = {
  list_spaces: {
    title: 'List spaces and collections',
    description: 'Shows how the notes are organised: spaces, the collections inside them, what type of note each collection holds, and how many notes each has. Start here to find where things are.',
    schema: z.object({}),
    run: (db) => listSpaces(db),
  },
  list_note_types: {
    title: 'List note types',
    description: 'Shows each note type (such as Job application, PhD application, Checklist, Course note) with its fields, the options a select field allows, and which dates are deadlines.',
    schema: z.object({}),
    run: (db) => listNoteTypes(db),
  },
  search_notes: {
    title: 'Search notes',
    description: 'Finds notes by words in their title, text, fields or tags, or lists the notes in a collection or of a type. With no query it lists, most recently changed first. Returns ids to use with the other tools. Private notes are never included.',
    schema: z.object({
      query: z.string().optional().describe('Words to look for. Leave out to list.'),
      collection: z.string().optional().describe('A collection name or id, to look only there.'),
      type: z.string().optional().describe('A note type name or id, such as "Job application".'),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: (db, a) => findNotes(db, {
      query: a.query ?? '', collection: a.collection, type: a.type, includeArchived: a.include_archived, limit: a.limit,
    }),
  },
  read_note: {
    title: 'Read a note',
    description: 'Reads one note in full: its text as Markdown, every field, its tasks with their ids, tags and where it is.',
    schema: z.object({ id: z.string() }),
    run: (db, a) => readNote(db, { id: a.id }),
  },
  get_agenda: {
    title: 'Get the agenda',
    description: 'What\'s planned from one day to another: tasks that are due, deadlines (such as application deadlines and interviews) and timetable blocks, by day, plus overdue tasks. Defaults to today and the next six days, in the user\'s time zone.',
    schema: z.object({ from: date.optional(), to: date.optional() }),
    run: (db, a, { today }) => agenda(db, { from: a.from, to: a.to, today }),
  },
  create_note: {
    title: 'Create a note',
    writes: true,
    description: 'Makes a new note. In a collection it gets that collection\'s type unless you name another (a collection of job applications makes job applications). Without a collection it goes to the Inbox. Text is Markdown: headings, lists, "- [ ]" checklists, bold, italic and links.',
    schema: z.object({
      title: z.string(),
      collection: z.string().optional().describe('A collection name or id.'),
      type: z.string().optional().describe('A note type name or id.'),
      fields: fields.optional(),
      text: z.string().optional().describe('The note\'s text, in Markdown.'),
    }),
    run: (db, a) => newNote(db, a),
  },
  update_note: {
    title: 'Update a note',
    writes: true,
    description: 'Changes a note: its title, fields (such as moving an application to "Applied"), its text, where it is, or archives it. Only what you pass changes. Notes can\'t be deleted; archiving hides one and keeps it.',
    schema: z.object({
      id: z.string(),
      title: z.string().optional(),
      fields: fields.optional(),
      append_text: z.string().optional().describe('Markdown added at the end of the text.'),
      replace_text: z.string().optional().describe('Markdown that replaces the whole text. Prefer append_text unless asked to rewrite.'),
      move_to: z.string().optional().describe('A collection name or id, or "Inbox".'),
      archived: z.boolean().optional(),
    }),
    run: (db, a) => changeNote(db, {
      id: a.id, title: a.title, fields: a.fields, appendText: a.append_text, replaceText: a.replace_text, moveTo: a.move_to, archived: a.archived,
    }),
  },
  add_task: {
    title: 'Add a task',
    writes: true,
    description: 'Adds a task to a note that has a task list, such as a Checklist, or the To do list of a job application. A task with a date shows on Today; with a time as well it also shows on the timetable.',
    schema: z.object({
      note_id: z.string(),
      text: z.string(),
      due: date.optional(),
      time: time.optional(),
      list: z.string().optional().describe('Which task list, when a note has more than one.'),
    }),
    run: (db, a) => newTask(db, {
      noteId: a.note_id, text: a.text, due: a.due, time: a.time, list: a.list,
    }),
  },
  update_task: {
    title: 'Update a task',
    writes: true,
    description: 'Ticks or unticks a task, or changes its text, date or time. Use an empty string to clear a date or time. Ticking a repeating task moves it to its next date, as in the app.',
    schema: z.object({
      note_id: z.string(),
      task_id: z.string(),
      done: z.boolean().optional(),
      text: z.string().optional(),
      due: z.string().optional().describe('YYYY-MM-DD, or "" to clear'),
      time: z.string().optional().describe('HH:MM, or "" to clear'),
    }),
    run: (db, a, { today }) => changeTask(db, {
      noteId: a.note_id, taskId: a.task_id, done: a.done, text: a.text, due: a.due, time: a.time, today,
    }),
  },
  add_timetable_block: {
    title: 'Add a timetable block',
    writes: true,
    description: 'Adds a block to the timetable, once or every week on the same weekday. Kinds: class, work, appointment, study, personal, other.',
    schema: z.object({
      title: z.string(),
      date: date.describe('The day, or the first day of a weekly series'),
      start: time,
      end: time,
      repeat_weekly: z.boolean().optional(),
      until: date.optional().describe('The last day of a weekly series'),
      location: z.string().optional(),
      kind: z.enum(['class', 'work', 'appointment', 'study', 'personal', 'other']).optional(),
    }),
    run: (db, a) => newBlock(db, {
      title: a.title, date: a.date, start: a.start, end: a.end, repeatWeekly: a.repeat_weekly, until: a.until, location: a.location, kind: a.kind,
    }),
  },
};
