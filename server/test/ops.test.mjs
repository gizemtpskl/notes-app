// Run with: node --test test/   (from the server folder)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCopy, withCopy, copyOf, differs } from '../src/notes.js';
import {
  ToolError, agenda, changeNote, changeTask, findNotes, listNoteTypes, listSpaces, newBlock, newNote, newTask, readNote,
} from '../src/ops.js';
import { markdownToHtml } from '../src/markdown.js';
import { sealPrivate, openSealed, createSyncKey } from '../../js/data/sync.js';
import { snapshotOf } from '../../js/data/sync.js';

const TODAY = '2026-11-11';

/** A copy like a device would send: a Career space with Jobs, and a To-dos checklist. */
async function sample() {
  const { db } = await openCopy({ records: {}, deleted: {} });
  const career = db.createSpace({ name: 'Career', icon: '💼', color: 'amber' });
  const jobs = db.createCollection({ name: 'Job applications', spaceId: career.id, defaultTypeId: 'jobApplication' });
  const todos = db.createCollection({ name: 'To-dos', spaceId: career.id, defaultTypeId: 'checklist' });
  db.createNote({ collectionId: jobs.id, title: 'Data analyst', fields: { company: 'Spotify', deadline: '2026-11-14' }, body: '<p>Met them at the <strong>career fair</strong>.</p>' });
  db.createNote({ collectionId: todos.id, title: 'Errands', fields: { items: [{ id: 't1', text: 'Call the bank', due: '2026-11-12', time: '10:30', done: false, children: [] }] } });
  db.createNote({ title: 'Dear diary', body: '<p>secret</p>', private: true });
  db.createBlock({ title: 'German', date: '2026-11-11', start: '18:15', end: '20:00', repeat: { days: [], weeks: 'every' } });
  const copy = snapshotOf(db);
  db.close();
  return copy;
}

const run = async (copy, fn) => withCopy(copy, fn);
const throwsTool = async (promise, pattern) => {
  await assert.rejects(promise, (error) => error instanceof ToolError && pattern.test(error.message));
};

test('lists spaces with their collections and counts', async () => {
  const { result } = await run(await sample(), (db) => listSpaces(db));
  const career = result.spaces.find((s) => s.name === 'Career');
  assert.deepEqual(career.collections.map((c) => [c.name, c.notesAre, c.notes]), [['Job applications', 'Job application', 1], ['To-dos', 'Checklist', 1]]);
});

test('describes note types with their options', async () => {
  const { result } = await run(await sample(), (db) => listNoteTypes(db));
  const job = result.find((t) => t.name === 'Job application');
  assert.ok(job.fields.find((f) => f.name === 'Status').options.includes('Applied'));
  assert.ok(job.fields.find((f) => f.name === 'Deadline').deadline);
});

test('finds notes by words and by collection, never private ones', async () => {
  const copy = await sample();
  const byWord = (await run(copy, (db) => findNotes(db, { query: 'career fair' }))).result;
  assert.equal(byWord.notes[0].title, 'Data analyst');
  assert.equal(byWord.notes[0].where, 'Career / Job applications');
  assert.equal(byWord.notes[0].fields.Company, 'Spotify');
  const byPlace = (await run(copy, (db) => findNotes(db, { collection: 'job applications' }))).result;
  assert.equal(byPlace.count, 1);
  const secret = (await run(copy, (db) => findNotes(db, { query: 'secret' }))).result;
  assert.equal(secret.count, 0);
  const everything = (await run(copy, (db) => findNotes(db, {}))).result;
  assert.ok(everything.notes.every((n) => n.title !== 'Dear diary'));
});

test('reads a note as Markdown with all its fields and tasks', async () => {
  const copy = await sample();
  const id = Object.values(copy.records).find((r) => r.title === 'Data analyst').id;
  const { result } = await run(copy, (db) => readNote(db, { id }));
  assert.match(result.text, /\*\*career fair\*\*/);
  assert.equal(result.fields.Status, 'Interested');
  assert.deepEqual(result.tasks['To do'].map((t) => t.text), ['Tailor CV', 'Write cover letter', 'Send application']);
  const privateId = Object.values(copy.records).find((r) => r.title === 'Dear diary').id;
  await throwsTool(run(copy, (db) => readNote(db, { id: privateId })), /no note/);
});

test('the agenda has tasks, deadlines and classes, by day', async () => {
  const { result } = await run(await sample(), (db) => agenda(db, { today: TODAY }));
  const day = (date) => result.days.find((d) => d.date === date)?.items.map((i) => i.text) ?? [];
  assert.deepEqual(day('2026-11-11'), ['German']);
  assert.deepEqual(day('2026-11-12'), ['Call the bank']);
  assert.deepEqual(day('2026-11-14'), ['Apply: Data analyst · Spotify']);
  assert.deepEqual(day('2026-11-17'), []);
  assert.deepEqual(day('2026-11-16'), [], 'Monday: German is on Wednesdays');
});

test('makes a note in a collection, with its type, fields and text', async () => {
  const { result, copy, changed } = await run(await sample(), (db) => newNote(db, {
    title: 'ML engineer', collection: 'Job applications', fields: { Company: 'Zalando', Status: 'preparing', Deadline: '2026-12-01' }, text: '# Why\n\n- good team\n- **Berlin**\n\n- [ ] ask about visa',
  }));
  assert.ok(changed);
  assert.equal(result.type, 'Job application');
  assert.equal(result.fields.Status, 'Preparing', 'options match whatever the case');
  assert.equal(result.where, 'Career / Job applications');
  const stored = Object.values(copy.records).find((r) => r.title === 'ML engineer');
  assert.match(stored.body, /<h1>Why<\/h1>/);
  assert.match(stored.body, /data-checked="false"/);
  assert.ok(stored.syncAt > 0, 'stamped, so it wins the merge on devices');
});

test('refuses values the app wouldn\'t take, with what would work', async () => {
  const copy = await sample();
  await throwsTool(run(copy, (db) => newNote(db, { title: 'x', collection: 'Job applications', fields: { Status: 'Ghosted' } })), /one of: Interested/);
  await throwsTool(run(copy, (db) => newNote(db, { title: 'x', collection: 'Job applications', fields: { Deadline: 'next friday' } })), /YYYY-MM-DD/);
  await throwsTool(run(copy, (db) => newNote(db, { title: 'x', collection: 'Job applications', fields: { Colour: 'red' } })), /no field "Colour"/);
  await throwsTool(run(copy, (db) => newNote(db, { title: 'x', collection: 'Nowhere' })), /no collection/);
});

test('moving an application to Applied fills in Applied on', async () => {
  const copy = await sample();
  const id = Object.values(copy.records).find((r) => r.title === 'Data analyst').id;
  const { result } = await run(copy, (db) => changeNote(db, { id, fields: { Status: 'Applied' } }));
  assert.equal(result.fields.Status, 'Applied');
  assert.match(result.fields['Applied on'], /^\d{4}-\d\d-\d\d$/);
});

test('appends text, moves and archives, but never deletes', async () => {
  const copy = await sample();
  const id = Object.values(copy.records).find((r) => r.title === 'Data analyst').id;
  const { result, copy: after } = await run(copy, (db) => changeNote(db, {
    id, appendText: 'Follow up on Friday.', moveTo: 'To-dos', archived: true,
  }));
  assert.match(result.text, /career fair[\s\S]*Follow up on Friday/);
  assert.equal(result.where, 'Career / To-dos');
  assert.equal(result.archived, true);
  assert.ok(after.records[`notes:${id}`], 'still there');
  await throwsTool(run(copy, (db) => changeNote(db, { id, appendText: 'a', replaceText: 'b' })), /not both/);
});

test('adds, ticks and reschedules tasks', async () => {
  let copy = await sample();
  const errands = Object.values(copy.records).find((r) => r.title === 'Errands').id;
  let step = await run(copy, (db) => newTask(db, { noteId: errands, text: 'Post the letter', due: '2026-11-13', time: '09:00' }));
  copy = step.copy;
  const added = step.result.added;
  step = await run(copy, (db) => changeTask(db, { noteId: errands, taskId: added, done: true, today: TODAY }));
  assert.ok(step.result.note.tasks.Tasks.find((t) => t.id === added).done);
  step = await run(step.copy, (db) => changeTask(db, { noteId: errands, taskId: 't1', due: '2026-11-20', today: TODAY }));
  assert.equal(step.result.note.tasks.Tasks.find((t) => t.id === 't1').due, '2026-11-20');
  const job = Object.values(copy.records).find((r) => r.title === 'Data analyst').id;
  await throwsTool(run(copy, (db) => newTask(db, { noteId: job, text: 'x', time: '10:00' })), /needs a due date/);
  await throwsTool(run(copy, (db) => changeTask(db, { noteId: errands, taskId: 'nope', done: true, today: TODAY })), /no task/);
});

test('adds timetable blocks, with the app\'s checks', async () => {
  const copy = await sample();
  const { result } = await run(copy, (db) => newBlock(db, {
    title: 'Gym', date: '2026-11-13', start: '07:00', end: '08:00', repeatWeekly: true, kind: 'personal',
  }));
  assert.equal(result.repeats, true);
  await throwsTool(run(copy, (db) => newBlock(db, { title: 'x', date: '2026-11-13', start: '09:00', end: '08:00' })), /end time/);
});

test('sealed private notes pass through untouched, and stay unreadable', async () => {
  const { key } = await createSyncKey('correct horse battery');
  const sealed = await sealPrivate(await sample(), key);
  const diary = Object.entries(sealed.records).find(([, r]) => r.sealed);
  assert.ok(diary, 'the diary is sealed');
  assert.ok(!JSON.stringify(sealed).includes('secret'));
  const { copy } = await run(sealed, (db) => newNote(db, { title: 'New', text: 'hi' }));
  assert.deepEqual(copy.records[diary[0]], diary[1]);
  const opened = await openSealed(copy, key);
  assert.equal(opened.records[diary[0]].title, 'Dear diary');
});

test('reading changes nothing', async () => {
  const copy = await sample();
  for (const fn of [(db) => listSpaces(db), (db) => findNotes(db, { query: 'bank' }), (db) => agenda(db, { today: TODAY })]) {
    const { changed } = await run(copy, fn);
    assert.equal(changed, false);
  }
});

test('Markdown becomes the editor\'s HTML, safely', () => {
  assert.equal(markdownToHtml('Hello **you** and *me*'), '<p>Hello <strong>you</strong> and <em>me</em></p>');
  assert.equal(markdownToHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(markdownToHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.doesNotMatch(markdownToHtml('[bad](javascript:alert(1))'), /href|javascript/);
  assert.match(markdownToHtml('[site](https://example.com)'), /href="https:\/\/example.com"/);
});

test('copies compare by content, not order', () => {
  assert.equal(differs({ records: { a: 1, b: 2 }, deleted: {} }, { records: { b: 2, a: 1 }, deleted: {} }), false);
  assert.equal(differs({ records: { a: 1 }, deleted: {} }, { records: { a: 2 }, deleted: {} }), true);
  assert.ok(copyOf);
});
