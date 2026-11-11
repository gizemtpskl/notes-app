/**
 * run.js: data layer tests for /tests.html. Each test gets a fresh in-memory database, so your
 * real notes are never touched. The IndexedDB test uses its own separate, temporary database.
 * Results are also exposed as window.__testResults for automated runs.
 */
import { addDailyTask, addDailyTasks } from '../data/daily.js';
import { parseTaskLine, parseTaskList } from '../data/taskText.js';
import { blocksToIcs, eventToBlock, parseIcs, readDateTime } from '../data/ics.js';
import { INTERVALS, isDue, nextReview, reviewQueue } from '../data/review.js';
import { dayAgenda, weekAgenda } from '../data/agenda.js';
import {
  createSyncKey, latestChange, mergeSnapshots, openSyncKey, packSnapshot, peekSnapshot, snapshotOf, stampOf, unpackSnapshot,
} from '../data/sync.js';
import { cleanHabit, createHabit, habitStreak, lastWeek, toggleHabitDay } from '../data/habits.js';
import {
  WIDGETS, dashboardLayout, greeting, moveWidget, updateWidget,
} from '../data/dashboard.js';
import { dueReminders } from '../data/reminders.js';
import {
  sessionNumber, weekSummary, guessType,
} from '../data/timetable.js';
import {
  blockProblem, changeFromSeries, cleanTimeBlock, conflictsWith, createTimeBlock, findConflicts, freeSlots, isoWeek, layoutDay,
  occurrencesBetween, parseBlockText, scheduleAt, shiftSeriesDay, startOfWeek, startsIn, toInstant, weekday,
} from '../data/timetable.js';
import {
  CalendarAuthError, CalendarError, calendarConfig, createCalendarApi, eventBody, eventEntries, eventIdFor, isClientId, planSync, readEvent,
  removeAllEvents, runSync, saveEvents, syncLinks, syncableTasks, toggleEventDone, updateCalendarConfig,
} from '../data/googleCalendar.js';
import {
  blockEventBody, blockEventId, blockLinks, blockWindow, clearWeekEvents, readRangeEvents, removeAllBlockEvents, runBlockSync, saveWeekEvents,
  weekEventEntries, weekEvents,
} from '../data/calendarTimetable.js';
import { googleErrorReason } from '../data/googleErrors.js';
import { NotesDb } from '../data/db.js';
import { emptyModel, learn, suggest } from '../data/filing.js';
import { assetIds, htmlToMarkdown, htmlToText, isBodyEmpty, safeUrl, sanitizeHtml, textToHtml } from '../data/html.js';
import { applyImport, buildExport, markdownExport, noteToMarkdown, parseImport } from '../data/porting.js';
import { DAY_MS, EXPORT_FORMAT, RuleError, SCHEMA_VERSION, isSortKey } from '../data/schema.js';
import { addDays, addMonths, daysBetween, firstDayOfWeek, isDateStr, monthGrid, relativeDay, toDateStr } from '../data/dates.js';
import { compareValues, fieldValue, isEmptyValue, normalizeValue, valueToText } from '../data/fieldKinds.js';
import { averageMood, entryDate, moodSeries, onThisDay, streaks } from '../data/journal.js';
import { pickOne, pickerCandidates } from '../data/picker.js';
import {
  addSubtask, agendaBuckets, createTask, earliestDue, flatten, indentTask, insertTaskAfter, locate, moveRelative,
  nextOccurrence, normalizeTasks, outdentTask, progress, removeTask, shiftTask, toggleTask, updateTask,
} from '../data/tasks.js';
import {
  BUILTIN_TYPES, agendaTitle, autoTitleFor, cleanType, displayTitle, dueIsOpen, isBlankNote, noteDueDate, noteWords, viewsFor,
} from '../data/types.js';
import { IndexedDbAdapter, LocalStorageAdapter, MemoryAdapter } from '../data/storage.js';
import { fold, safeFileName, snippet, splitCapture, tokenize } from '../data/text.js';
import { crc32, createZip } from '../data/zip.js';
import { bodyLinkIds, collectLinks, renameLinkText } from '../data/links.js';
import {
  EncryptedAdapter, WrongPasscodeError, changePasscode, createLock, decryptValue, disableLock, enableLock, encryptValue, isCryptoAvailable, openLock, readLock,
} from '../data/crypto.js';
import { niceScale, notesPerSpace, tasksPerWeek, watchedPerMonth } from '../data/stats.js';
import { STORES } from '../data/schema.js';
import { answerQuiz, createCard, normalizeCards, recordAnswer, shuffle, startQuiz, usableCards } from '../data/flashcards.js';
import { donePatch } from '../data/picker.js';
import { BUILTIN_TEMPLATES, cleanTemplate, fillPlaceholders } from '../data/templates.js';
import { editDistance, findDuplicateGroups, findEmptyNotes, findStaleNotes, titlesLookAlike } from '../data/tidy.js';
import { completedTasks, completionTimes, weekStartOf, weeklyReviewData } from '../data/weekly.js';
import { detectLanguage, tokenize as tokenizeCode } from '../editor/highlight.js';
import { buildSnippet, findRanges, parseQuery, rememberSearch, searchNotes } from '../data/search.js';
import { compileFilter, countConditions, describeFilter, emptyFilter, normalizeFilter, queryNotes, testRule } from '../data/filters.js';

const groups = [];
let group = null;

function describe(name, define) {
  group = { name, tests: [] };
  groups.push(group);
  define();
}

function it(name, fn) {
  group.tests.push({ name, fn });
}

function assert(condition, message = 'Expected a true value') {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, label = 'value') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function throwsRule(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof RuleError) return;
    throw error;
  }
  throw new Error('Expected a RuleError');
}

async function freshDb() {
  const db = new NotesDb(new MemoryAdapter(), { channelName: `test-${Math.random()}` });
  await db.open();
  return db;
}

function seed(db) {
  const school = db.createSpace({ name: 'School', icon: '🎓', color: 'sky' });
  const fun = db.createSpace({ name: 'Fun', icon: '🎬', color: 'plum' });
  const course = db.createCollection({ name: 'DL-FS2026', spaceId: school.id });
  const lectures = db.createCollection({ name: 'Lecture notes', spaceId: school.id, parentId: course.id });
  const movies = db.createCollection({ name: 'Movies', spaceId: fun.id });
  return { school, fun, course, lectures, movies };
}

describe('Spaces', () => {
  it('creates spaces in order', async () => {
    const db = await freshDb();
    const { school, fun } = seed(db);
    equal(db.listSpaces().map((s) => s.id), [school.id, fun.id]);
  });

  it('reorders spaces', async () => {
    const db = await freshDb();
    const { school, fun } = seed(db);
    const third = db.createSpace({ name: 'Home' });
    db.moveSpace(third.id, 0);
    equal(db.listSpaces().map((s) => s.id), [third.id, school.id, fun.id]);
    db.moveSpace(third.id, 99);
    equal(db.listSpaces().map((s) => s.id), [school.id, fun.id, third.id]);
  });

  it('renames a space', async () => {
    const db = await freshDb();
    const { school } = seed(db);
    db.updateSpace(school.id, { name: 'University' });
    equal(db.getSpace(school.id).name, 'University');
  });

  it('deleting a space sends its notes to the Inbox and removes its collections', async () => {
    const db = await freshDb();
    const { school, course } = seed(db);
    const note = db.createNote({ title: 'Kept', collectionId: course.id });
    db.deleteSpace(school.id);
    const kept = db.getNote(note.id);
    equal([kept.spaceId, kept.collectionId], [null, null]);
    assert(!db.getCollection(course.id), 'collection should be removed');
    equal(db.listNotes({ inbox: true }).length, 1);
  });
});

describe('Collections', () => {
  it('nests one level deep only', async () => {
    const db = await freshDb();
    const { school, lectures } = seed(db);
    throwsRule(() => db.createCollection({ name: 'Too deep', spaceId: school.id, parentId: lectures.id }));
  });

  it('refuses nesting a collection that has sub-collections', async () => {
    const db = await freshDb();
    const { school, course } = seed(db);
    const other = db.createCollection({ name: 'Other', spaceId: school.id });
    throwsRule(() => db.moveCollection(course.id, { parentId: other.id }));
  });

  it('refuses nesting a collection inside itself', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    throwsRule(() => db.moveCollection(movies.id, { parentId: movies.id }));
  });

  it('reorders siblings', async () => {
    const db = await freshDb();
    const { fun, movies } = seed(db);
    const games = db.createCollection({ name: 'Games', spaceId: fun.id });
    db.moveCollection(games.id, { spaceId: fun.id, parentId: null, index: 0 });
    equal(db.listCollections(fun.id).map((c) => c.id), [games.id, movies.id]);
  });

  it('moving to another space brings sub-collections and notes along', async () => {
    const db = await freshDb();
    const { fun, course, lectures } = seed(db);
    const inCourse = db.createNote({ title: 'A', collectionId: course.id });
    const inLectures = db.createNote({ title: 'B', collectionId: lectures.id });
    db.moveCollection(course.id, { spaceId: fun.id });
    equal(db.getCollection(lectures.id).spaceId, fun.id);
    equal(db.getNote(inCourse.id).spaceId, fun.id);
    equal(db.getNote(inLectures.id).spaceId, fun.id);
  });

  it('deleting moves notes up a level and promotes sub-collections', async () => {
    const db = await freshDb();
    const { school, course, lectures } = seed(db);
    const inLectures = db.createNote({ title: 'L', collectionId: lectures.id });
    const inCourse = db.createNote({ title: 'C', collectionId: course.id });
    db.deleteCollection(lectures.id);
    equal(db.getNote(inLectures.id).collectionId, course.id);
    const another = db.createCollection({ name: 'Sub', spaceId: school.id, parentId: course.id });
    db.deleteCollection(course.id);
    equal(db.getNote(inCourse.id).collectionId, null);
    equal(db.getNote(inCourse.id).spaceId, school.id);
    equal(db.getCollection(another.id).parentId, null);
  });
});

describe('Notes', () => {
  it('a new note with no location lands in the Inbox', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Thought' });
    equal(db.listNotes({ inbox: true }).map((n) => n.id), [note.id]);
    equal(db.counts().inbox, 1);
  });

  it('moves between Inbox, space and collection', async () => {
    const db = await freshDb();
    const { fun, movies } = seed(db);
    const note = db.createNote({ title: 'Film' });
    db.moveNotes([note.id], { collectionId: movies.id });
    equal(db.getNote(note.id).spaceId, fun.id);
    equal(db.counts().collections.get(movies.id), 1);
    db.moveNotes([note.id], { spaceId: fun.id });
    equal(db.getNote(note.id).collectionId, null);
    db.moveNotes([note.id], {});
    equal(db.getNote(note.id).spaceId, null);
    equal(db.counts().inbox, 1);
  });

  it('refuses a collection and space that do not match', async () => {
    const db = await freshDb();
    const { school, movies } = seed(db);
    const note = db.createNote({ title: 'X' });
    throwsRule(() => db.moveNotes([note.id], { spaceId: school.id, collectionId: movies.id }));
    equal(db.getNote(note.id).spaceId, null);
  });

  it('counts a sub-collection note under its parent as well', async () => {
    const db = await freshDb();
    const { school, course, lectures } = seed(db);
    db.createNote({ collectionId: lectures.id, title: 'x' });
    const counts = db.counts();
    equal(counts.collections.get(lectures.id), 1);
    equal(counts.collections.get(course.id), 1);
    equal(counts.spaces.get(school.id), 1);
  });

  it('pinning does not change the updated time, editing does', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A' });
    db.updateNote(note.id, { pinned: true }, { now: note.updated + 5000 });
    equal(db.getNote(note.id).updated, note.updated);
    db.updateNote(note.id, { title: 'B' }, { now: note.updated + 5000 });
    equal(db.getNote(note.id).updated, note.updated + 5000);
  });

  it('archives and restores, hidden from normal lists', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Done' });
    db.archiveNotes([note.id]);
    equal(db.listNotes().length, 0);
    equal(db.listNotes({ status: 'archived' }).length, 1);
    equal(db.counts().archive, 1);
    db.unarchiveNotes([note.id]);
    equal(db.listNotes().length, 1);
  });

  it('trashes and restores to the original place', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    const note = db.createNote({ title: 'Film', collectionId: movies.id });
    db.trashNotes([note.id]);
    equal(db.listNotes({ collectionId: movies.id }).length, 0);
    equal(db.counts().trash, 1);
    db.restoreNotes([note.id]);
    equal(db.listNotes({ collectionId: movies.id }).length, 1);
  });

  it('removes trash after 30 days, and not before', async () => {
    const db = await freshDb();
    const old = db.createNote({ title: 'Old' });
    const recent = db.createNote({ title: 'Recent' });
    const now = Date.now();
    db.trashNotes([old.id], now - 31 * DAY_MS);
    db.trashNotes([recent.id], now - 29 * DAY_MS);
    equal(db.purgeExpiredTrash(now), 1);
    assert(!db.getNote(old.id));
    assert(db.getNote(recent.id));
  });

  it('sorts by title, created and updated', async () => {
    const db = await freshDb();
    const b = db.createNote({ title: 'beta', now: 2000 });
    const a = db.createNote({ title: 'Alpha', now: 3000 });
    const c = db.createNote({ title: 'çay', now: 1000 });
    equal(db.listNotes({ sort: { key: 'title', dir: 'asc' } }).map((n) => n.id), [a.id, b.id, c.id]);
    equal(db.listNotes({ sort: { key: 'title', dir: 'desc' } }).map((n) => n.id), [c.id, b.id, a.id]);
    equal(db.listNotes({ sort: { key: 'created', dir: 'asc' } }).map((n) => n.id), [c.id, b.id, a.id]);
    equal(db.listNotes({ sort: { key: 'updated', dir: 'desc' } }).map((n) => n.id), [a.id, b.id, c.id]);
  });

  it('keeps pinned notes on top when asked', async () => {
    const db = await freshDb();
    const first = db.createNote({ title: 'A' });
    db.createNote({ title: 'B' });
    db.setPinned(first.id, true);
    equal(db.listNotes({ sort: { key: 'title', dir: 'desc' }, pinnedFirst: true })[0].id, first.id);
  });

  it('always sanitizes bodies and keeps derived text current', async () => {
    const db = await freshDb();
    const note = db.createNote({ body: '<p>Hi</p><script>alert(1)</script>' });
    assert(!note.body.includes('script'));
    equal(note.text, 'Hi');
    const updated = db.updateNote(note.id, { body: '<p onclick="x()">Bye</p>' });
    equal(updated.body, '<p>Bye</p>');
    equal(updated.text, 'Bye');
  });
});

describe('Undo', () => {
  it('restores a deleted space, collections and note locations', async () => {
    const db = await freshDb();
    const { school, course } = seed(db);
    const note = db.createNote({ title: 'A', collectionId: course.id });
    const { undo } = db.undoable(() => db.deleteSpace(school.id));
    assert(!db.getSpace(school.id));
    undo();
    assert(db.getSpace(school.id));
    assert(db.getCollection(course.id));
    equal(db.getNote(note.id).collectionId, course.id);
  });

  it('removes a note created inside the undoable call', async () => {
    const db = await freshDb();
    const { result, undo } = db.undoable(() => db.createNote({ title: 'A' }));
    assert(db.getNote(result.id));
    undo();
    assert(!db.getNote(result.id));
  });

  it('undoing a move keeps text typed after the move', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    const note = db.createNote({ title: 'Draft' });
    const { undo } = db.undoable(() => db.moveNotes([note.id], { collectionId: movies.id }));
    db.updateNote(note.id, { title: 'Draft, edited', body: '<p>new text</p>' });
    undo();
    const after = db.getNote(note.id);
    equal([after.spaceId, after.collectionId], [null, null]);
    equal([after.title, after.body], ['Draft, edited', '<p>new text</p>']);
  });

  it('undoing a capture keeps the note if it was edited since', async () => {
    const db = await freshDb();
    const { result, undo } = db.undoable(() => db.createNote({ title: 'Quick' }));
    db.updateNote(result.id, { body: '<p>worth keeping</p>' });
    undo();
    assert(db.getNote(result.id));
  });

  it('restores the state before several changes to one note', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Original' });
    const { undo } = db.undoable(() => {
      db.updateNote(note.id, { title: 'Second' });
      db.updateNote(note.id, { title: 'Third' });
    });
    undo();
    equal(db.getNote(note.id).title, 'Original');
  });
});

describe('Change events', () => {
  it('a batch fires once', async () => {
    const db = await freshDb();
    let calls = 0;
    db.on(() => {
      calls += 1;
    });
    db.batch(() => {
      db.createNote({ title: 'A' });
      db.createNote({ title: 'B' });
    });
    equal(calls, 1);
  });

  it('typing is not structural, moving is', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    const note = db.createNote({ title: 'A' });
    const seen = [];
    db.on((change) => seen.push(change.structural));
    db.updateNote(note.id, { title: 'B' });
    db.moveNotes([note.id], { collectionId: movies.id });
    equal(seen, [false, true]);
  });

  it('a failed save is reported and retried', async () => {
    const db = await freshDb();
    const realCommit = db.storage.commit.bind(db.storage);
    let failures = 1;
    db.storage.commit = async (ops) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('Quota exceeded');
      }
      return realCommit(ops);
    };
    let reported = 0;
    db.onPersistError(() => {
      reported += 1;
    });
    const note = db.createNote({ title: 'Precious' });
    await db.flush();
    equal(reported, 1);
    assert(!(await db.storage.get('notes', note.id)), 'nothing stored yet');
    await db.flush();
    assert(await db.storage.get('notes', note.id), 'stored on retry');
  });
});

describe('Text helpers', () => {
  it('fold ignores case, accents and Turkish i variants', () => {
    equal(fold('İstanbul'), fold('istanbul'));
    equal(fold('ISPARTA'), fold('ısparta'));
    equal(fold('Çay Şöyle'), 'cay soyle');
  });

  it('tokenize drops stop words and duplicates', () => {
    equal(tokenize('The movie and the Movie night'), ['movie', 'night']);
  });

  it('splitCapture handles one line, several lines and a long line', () => {
    equal(splitCapture('Buy milk'), { title: 'Buy milk', bodyText: '' });
    equal(splitCapture('Title\nline two\nline three'), { title: 'Title', bodyText: 'line two\nline three' });
    const long = 'word '.repeat(60).trim();
    const split = splitCapture(long);
    assert(split.title.length <= 71, 'title is short');
    equal(split.bodyText, long);
  });

  it('snippet cuts at a word boundary', () => {
    equal(snippet('one two three four', 9), 'one two…');
  });

  it('safeFileName removes unsafe characters and keeps other alphabets', () => {
    equal(safeFileName('a/b:c?'), 'a b c');
    equal(safeFileName('Çalışma Notları'), 'Çalışma Notları');
    equal(safeFileName('...'), 'Untitled');
  });
});

describe('Sanitizer', () => {
  it('removes scripts, event handlers and dangerous links', () => {
    equal(sanitizeHtml('<p onclick="x()">a</p><script>x</script>'), '<p>a</p>');
    equal(sanitizeHtml('<a href="javascript:alert(1)">a</a>'), '<p>a</p>');
    equal(sanitizeHtml('<a href="java\nscript:alert(1)">a</a>'), '<p>a</p>');
    equal(sanitizeHtml('<img src=x onerror=alert(1)>'), '');
    equal(sanitizeHtml('<iframe src="https://x.test"></iframe><p>b</p>'), '<p>b</p>');
    equal(sanitizeHtml('<svg><script>x</script></svg><p>c</p>'), '<p>c</p>');
  });

  it('remote images become links, so notes never load external content', () => {
    const out = sanitizeHtml('<p><img src="https://x.test/a.png" alt="cat"></p>');
    assert(!out.includes('<img'), 'no image');
    assert(out.includes('href="https://x.test/a.png"'), 'link kept');
  });

  it('keeps allowed blocks and normalizes tags', () => {
    equal(sanitizeHtml('<b>a</b>'), '<p><strong>a</strong></p>');
    equal(sanitizeHtml('<h5>a</h5>'), '<h3>a</h3>');
    equal(sanitizeHtml('<div>a</div><div>b</div>'), '<p>a</p><p>b</p>');
    equal(sanitizeHtml('<ul><li>a<ul><li>b</li></ul></li></ul>'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
    equal(sanitizeHtml('<ul data-type="check"><li data-checked="true">a</li></ul>'), '<ul data-type="check"><li data-checked="true">a</li></ul>');
  });

  it('keeps tables and local images', () => {
    equal(sanitizeHtml('<table><tr><th>a</th><td>b</td></tr></table>'), '<table><tbody><tr><th>a</th><td>b</td></tr></tbody></table>');
    equal(sanitizeHtml('<p><img data-asset="abc-1" alt="x" src="data:image/png;base64,AA"></p>'), '<p><img data-asset="abc-1" alt="x"></p>');
  });

  it('keeps code exactly, including angle brackets', () => {
    equal(sanitizeHtml('<pre><code>if (a &lt; b) {\n  c();\n}</code></pre>'), '<pre>if (a &lt; b) {\n  c();\n}</pre>');
  });

  it('turns styled pastes into marks, and ignores the Google Docs wrapper', () => {
    equal(sanitizeHtml('<p><span style="font-weight:700">a</span></p>'), '<p><strong>a</strong></p>');
    equal(sanitizeHtml('<b style="font-weight:normal"><p>a</p></b>'), '<p>a</p>');
  });

  it('survives extremely deep nesting', () => {
    const deep = `${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}`;
    assert(sanitizeHtml(deep).includes('x'));
  });

  it('safeUrl adds a scheme to bare domains and refuses others', () => {
    equal(safeUrl('example.com/a'), 'https://example.com/a');
    equal(safeUrl('https://a.test'), 'https://a.test');
    equal(safeUrl('javascript:alert(1)'), null);
    equal(safeUrl('data:text/html,x'), null);
    equal(safeUrl('hello'), null);
  });

  it('extracts text with line breaks between blocks', () => {
    equal(htmlToText('<h1>A</h1><p>b <strong>c</strong></p><ul><li>d</li></ul>'), 'A\nb c\nd');
  });

  it('isBodyEmpty recognizes blank and non-blank bodies', () => {
    assert(isBodyEmpty(''));
    assert(isBodyEmpty('<p><br></p>'));
    assert(!isBodyEmpty('<hr>'));
    assert(!isBodyEmpty('<p>a</p>'));
    assert(!isBodyEmpty('<p><img data-asset="a" alt=""></p>'));
  });

  it('textToHtml escapes markup', () => {
    equal(textToHtml('a <b>\n\nc'), '<p>a &lt;b&gt;</p><p>c</p>');
  });

  it('assetIds finds referenced images', () => {
    equal(assetIds('<img data-asset="a"><img data-asset="b-2">'), ['a', 'b-2']);
  });
});

describe('Markdown', () => {
  it('converts headings, marks, lists and code', () => {
    const md = htmlToMarkdown('<h2>T</h2><p><strong>b</strong> <em>i</em> <code>c</code></p><ul><li>x<ul><li>y</li></ul></li></ul><ol><li>one</li><li>two</li></ol><pre>let a;\n</pre>');
    assert(md.includes('## T'), 'heading');
    assert(md.includes('**b** *i* `c`'), 'marks');
    assert(md.includes('- x\n  - y'), 'nested list');
    assert(md.includes('1. one\n2. two'), 'ordered list');
    assert(md.includes('```\nlet a;\n```'), 'code block');
  });

  it('converts check lists, quotes, links, tables and rules', () => {
    const md = htmlToMarkdown('<ul data-type="check"><li data-checked="true">a</li><li data-checked="false">b</li></ul><blockquote><p>q</p></blockquote><p><a href="https://a.test">l</a></p><table><tbody><tr><th>h</th></tr><tr><td>c|d</td></tr></tbody></table><hr>');
    assert(md.includes('- [x] a\n- [ ] b'), 'checks');
    assert(md.includes('> q'), 'quote');
    assert(md.includes('[l](https://a.test)'), 'link');
    assert(md.includes('| h |\n| --- |\n| c\\|d |'), 'table');
    assert(md.endsWith('---'), 'rule');
  });

  it('escapes characters that would change the meaning', () => {
    equal(htmlToMarkdown('<p>2 * 3 and [x]</p>'), '2 \\* 3 and \\[x\\]');
  });

  it('writes a header with location and dates', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    const note = db.createNote({ title: 'He said "hi"', body: '<p>Body</p>', collectionId: movies.id });
    const md = noteToMarkdown(note, db);
    assert(md.startsWith('---\ntitle: "He said \\"hi\\""\nspace: "Fun"\ncollection: "Movies"'), md);
    assert(md.endsWith('Body\n'));
  });
});

describe('ZIP', () => {
  it('computes a correct CRC-32', () => {
    equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  it('writes a valid archive structure with UTF-8 names', async () => {
    const bytes = new Uint8Array(await createZip([{ path: 'Çalışma/a.md', data: 'hello' }, { path: 'b.md', data: new Uint8Array([1, 2]) }]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    equal(view.getUint32(0, true), 0x04034b50, 'local header');
    equal(view.getUint16(6, true), 0x0800, 'utf-8 flag');
    const end = bytes.length - 22;
    equal(view.getUint32(end, true), 0x06054b50, 'end record');
    equal(view.getUint16(end + 10, true), 2, 'entry count');
    const centralStart = view.getUint32(end + 16, true);
    equal(view.getUint32(centralStart, true), 0x02014b50, 'central directory');
    const nameLength = view.getUint16(26, true);
    equal(new TextDecoder().decode(bytes.slice(30, 30 + nameLength)), 'Çalışma/a.md');
  });
});

describe('Markdown export scopes', () => {
  async function entryNames(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    let at = view.getUint32(end + 16, true);
    const names = [];
    for (let i = 0; i < view.getUint16(end + 10, true); i += 1) {
      const nameLen = view.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLen)));
      at += 46 + nameLen;
    }
    return names;
  }

  it('a single note without images is a plain .md file', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'One', body: '<p>x</p>' });
    const { filename, blob } = await markdownExport(db, { kind: 'note', id: note.id });
    equal(filename, 'One.md');
    assert((await blob.text()).includes('title: "One"'));
  });

  it('a collection zip includes sub-collections, in folders, with duplicate titles kept', async () => {
    const db = await freshDb();
    const { course, lectures } = seed(db);
    db.createNote({ title: 'Same', collectionId: course.id });
    db.createNote({ title: 'Same', collectionId: course.id });
    db.createNote({ title: 'Sub', collectionId: lectures.id });
    const trashed = db.createNote({ title: 'Gone', collectionId: course.id });
    db.trashNotes([trashed.id]);
    const { filename, blob } = await markdownExport(db, { kind: 'collection', id: course.id });
    equal(filename, 'DL-FS2026.zip');
    const names = (await entryNames(blob)).sort();
    equal(names, [
      'School/DL-FS2026/Lecture notes/Sub.md',
      'School/DL-FS2026/Same (2).md',
      'School/DL-FS2026/Same.md',
    ]);
  });

  it('exporting everything includes the Inbox, Archive and images', async () => {
    const db = await freshDb();
    await db.putAsset({ id: 'img1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    db.createNote({ title: 'Loose', body: '<p><img data-asset="img1" alt="pic"></p>' });
    const archived = db.createNote({ title: 'Old' });
    db.archiveNotes([archived.id]);
    const { blob } = await markdownExport(db, { kind: 'all' });
    const names = await entryNames(blob);
    assert(names.includes('Inbox/Loose.md'), names.join());
    assert(names.includes('Archive/Inbox/Old.md'), names.join());
    assert(names.includes('assets/img1.png'), names.join());
  });
});

describe('Import and export', () => {
  async function filled() {
    const db = await freshDb();
    const ids = seed(db);
    db.createNote({ title: 'Inbox thought', body: '<p>hello</p>' });
    db.createNote({ title: 'Film', body: '<h1>A</h1><ul data-type="check"><li data-checked="true">x</li></ul>', collectionId: ids.movies.id, pinned: true });
    const archived = db.createNote({ title: 'Old', spaceId: ids.school.id });
    db.archiveNotes([archived.id]);
    const trashed = db.createNote({ title: 'Trash', collectionId: ids.lectures.id });
    db.trashNotes([trashed.id]);
    await db.putAsset({ id: 'pic', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    return { db, ids };
  }

  const snapshot = (db) => ({
    spaces: [...db.data.spaces.values()].sort((a, b) => a.id.localeCompare(b.id)),
    collections: [...db.data.collections.values()].sort((a, b) => a.id.localeCompare(b.id)),
    notes: [...db.data.notes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  });

  it('round trip into an empty database is lossless', async () => {
    const { db } = await filled();
    const backup = JSON.stringify(await buildExport(db));
    const target = await freshDb();
    const parsed = parseImport(backup);
    assert(parsed.ok, parsed.error);
    await applyImport(target, parsed.data, 'merge');
    equal(snapshot(target), snapshot(db));
    equal((await target.getAsset('pic')).dataUrl, 'data:image/png;base64,AAAA');
  });

  it('merge keeps the newer version of a note and adds the rest', async () => {
    const { db } = await filled();
    const backup = await buildExport(db);
    const target = await freshDb();
    await applyImport(target, parseImport(JSON.stringify(backup)).data, 'merge');
    const film = target.listNotes().find((n) => n.title === 'Film');
    target.updateNote(film.id, { title: 'Film edited' }, { now: film.updated + 10000 });
    const local = target.createNote({ title: 'Local only' });
    await applyImport(target, parseImport(JSON.stringify(backup)).data, 'merge');
    equal(target.getNote(film.id).title, 'Film edited');
    assert(target.getNote(local.id));
    const older = { ...backup, data: { ...backup.data, notes: backup.data.notes.map((n) => (n.id === film.id ? { ...n, title: 'From file', updated: film.updated + 20000 } : n)) } };
    await applyImport(target, parseImport(JSON.stringify(older)).data, 'merge');
    equal(target.getNote(film.id).title, 'From file');
  });

  it('replace removes what was there, and undo brings it back', async () => {
    const { db } = await filled();
    const backup = await buildExport(db);
    const target = await freshDb();
    const local = target.createNote({ title: 'Local only' });
    const undo = await applyImport(target, parseImport(JSON.stringify(backup)).data, 'replace');
    assert(!target.getNote(local.id));
    equal(target.data.notes.size, 4);
    undo();
    assert(target.getNote(local.id));
    equal(target.data.notes.size, 1);
  });

  it('import never removes built-in types', async () => {
    const { db } = await filled();
    const target = await freshDb();
    await applyImport(target, parseImport(JSON.stringify(await buildExport(db))).data, 'replace');
    for (const type of BUILTIN_TYPES) assert(target.data.noteTypes.has(type.id), type.id);
  });

  it('rejects files that are not backups, with a clear reason', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"format":"other"}']) {
      const result = parseImport(bad);
      assert(!result.ok, `should reject: ${bad}`);
      assert(result.error.length > 10, 'has a message');
    }
    assert(!parseImport(JSON.stringify({ format: EXPORT_FORMAT })).ok, 'no version');
    assert(!parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1 })).ok, 'no data');
    assert(!parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, data: { notes: 'x' } })).ok, 'bad section');
  });

  it('rejects files from a newer version instead of damaging data', () => {
    const result = parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: SCHEMA_VERSION + 1, data: {} }));
    assert(!result.ok);
    assert(result.error.includes('newer'));
  });

  it('skips invalid records and reports them', () => {
    const result = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: {
        notes: [{ id: 'good', title: 'Good' }, { title: 'no id' }, 42, null, { id: 'n2', title: 123 }, { id: 'n3', body: {} }],
        spaces: [{ id: 's', name: 'S', color: 'neon' }, { id: 7 }],
        assets: [{ id: 'bad', dataUrl: 'data:text/html;base64,AAAA' }, { id: 'svg', dataUrl: 'data:image/svg+xml;base64,AAAA' }],
      },
    }));
    assert(result.ok);
    equal(result.data.notes.map((n) => n.id), ['good']);
    equal(result.data.spaces[0].color, 'slate');
    equal(result.data.assets.length, 0);
    assert(result.warnings.length >= 3, 'warnings reported');
  });

  it('sanitizes bodies from imported files', () => {
    const result = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: { notes: [{ id: 'x', body: '<img src=x onerror=alert(1)><script>bad()</script><p>safe</p>' }] },
    }));
    equal(result.data.notes[0].body, '<p>safe</p>');
    equal(result.data.notes[0].text, 'safe');
  });

  it('repairs broken references', async () => {
    const target = await freshDb();
    const parsed = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: {
        spaces: [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }],
        collections: [
          { id: 'orphan', name: 'No space', spaceId: 'missing' },
          { id: 'c1', name: 'Top', spaceId: 's1' },
          { id: 'c2', name: 'Self parent', spaceId: 's1', parentId: 'c2' },
          { id: 'c3', name: 'Child', spaceId: 's1', parentId: 'c1' },
          { id: 'c4', name: 'Too deep', spaceId: 's1', parentId: 'c3' },
          { id: 'c5', name: 'Other space parent', spaceId: 's2', parentId: 'c1' },
        ],
        notes: [
          { id: 'n1', title: 'Missing space', spaceId: 'nope' },
          { id: 'n2', title: 'Missing collection', spaceId: 's1', collectionId: 'gone' },
          { id: 'n3', title: 'Wrong space', spaceId: 's2', collectionId: 'c1' },
          { id: 'n4', title: 'In removed collection', spaceId: 's1', collectionId: 'orphan' },
        ],
      },
    }));
    await applyImport(target, parsed.data, 'merge');
    assert(!target.getCollection('orphan'));
    equal(target.getCollection('c2').parentId, null);
    equal(target.getCollection('c3').parentId, 'c1');
    equal(target.getCollection('c4').parentId, null);
    equal(target.getCollection('c5').parentId, null);
    equal([target.getNote('n1').spaceId, target.getNote('n1').collectionId], [null, null]);
    equal([target.getNote('n2').spaceId, target.getNote('n2').collectionId], ['s1', null]);
    equal(target.getNote('n3').spaceId, 's1');
    equal([target.getNote('n4').spaceId, target.getNote('n4').collectionId], ['s1', null]);
  });

  it('imports a very long note without trouble', async () => {
    const body = `<p>${'long text '.repeat(200000)}</p>`;
    const parsed = parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, data: { notes: [{ id: 'big', title: 'Big', body }] } }));
    assert(parsed.ok);
    const target = await freshDb();
    await applyImport(target, parsed.data, 'merge');
    assert(target.getNote('big').text.length > 1000000);
  });
});

describe('Filing suggestions', () => {
  it('learns from past choices', () => {
    const spaces = [{ id: 's', name: 'Fun' }, { id: 't', name: 'School' }];
    const collections = [{ id: 'c', name: 'Movies', spaceId: 's' }];
    let model = emptyModel();
    model = learn(model, { title: 'Watch thriller tonight', text: '' }, 's', 'c');
    model = learn(model, { title: 'Another thriller film', text: '' }, 's', 'c');
    const [top] = suggest(model, { title: 'New thriller', text: '' }, spaces, collections);
    equal([top.spaceId, top.collectionId], ['s', 'c']);
  });

  it('matches collection names with no history', () => {
    const spaces = [{ id: 's', name: 'Fun' }];
    const collections = [{ id: 'c', name: 'Movies to watch', spaceId: 's' }];
    const [top] = suggest(emptyModel(), { title: 'Movies from Ana', text: '' }, spaces, collections);
    equal(top.collectionId, 'c');
  });

  it('never suggests a deleted destination', async () => {
    const db = await freshDb();
    const { movies, fun } = seed(db);
    const a = db.createNote({ title: 'Thriller film' });
    db.fileNote(a.id, { collectionId: movies.id });
    db.deleteCollection(movies.id);
    const b = db.createNote({ title: 'Thriller film again' });
    assert(db.suggestFiling(b).every((s) => s.collectionId !== movies.id));
    db.deleteSpace(fun.id);
    equal(db.suggestFiling(b).length, 0);
  });

  it('a word that is also a built-in property name is safe', async () => {
    const db = await freshDb();
    const { movies } = seed(db);
    const a = db.createNote({ title: 'constructor prototype hasownproperty' });
    db.fileNote(a.id, { collectionId: movies.id });
    const b = db.createNote({ title: 'constructor again' });
    assert(Array.isArray(db.suggestFiling(b)));
  });
});

describe('Backup reminder', () => {
  it('is due after 14 days without an export', async () => {
    const db = await freshDb();
    const start = Date.now();
    assert(!db.backupDue(start), 'not with no notes');
    db.createNote({ title: 'A' });
    db.setMeta('firstUsedAt', start);
    assert(!db.backupDue(start + 13 * DAY_MS), 'not at 13 days');
    assert(db.backupDue(start + 14 * DAY_MS), 'due at 14 days');
    db.markExported(start + 14 * DAY_MS);
    assert(!db.backupDue(start + 20 * DAY_MS), 'export resets');
    assert(db.backupDue(start + 28 * DAY_MS), 'due again');
  });

  it('can be snoozed', async () => {
    const db = await freshDb();
    db.createNote({ title: 'A' });
    const start = Date.now();
    db.setMeta('firstUsedAt', start - 30 * DAY_MS);
    assert(db.backupDue(start));
    db.snoozeBackup(start);
    assert(!db.backupDue(start + DAY_MS));
    assert(db.backupDue(start + 4 * DAY_MS));
  });

  it('backup dates are not part of a backup file', async () => {
    const db = await freshDb();
    db.markExported(123);
    const backup = await buildExport(db);
    assert(!backup.data.meta.some((m) => m.id === 'lastExportAt'));
  });
});

describe('Storage backends', () => {
  async function exercise(adapter) {
    await adapter.open();
    await adapter.clear();
    await adapter.commit([
      { store: 'notes', id: 'a', value: { id: 'a', title: 'A' } },
      { store: 'spaces', id: 's', value: { id: 's', name: 'S' } },
    ]);
    equal((await adapter.get('notes', 'a')).title, 'A');
    equal((await adapter.getAll('notes')).length, 1);
    equal(await adapter.keys('spaces'), ['s']);
    await adapter.commit([{ store: 'notes', id: 'a', value: null }]);
    equal(await adapter.get('notes', 'a'), undefined);
    await adapter.clear();
    equal((await adapter.getAll('spaces')).length, 0);
    adapter.close();
  }

  it('IndexedDB works and data survives reopening', async () => {
    const name = `personal-notes-test-${Date.now()}`;
    await exercise(new IndexedDbAdapter(name));
    const first = new NotesDb(new IndexedDbAdapter(name), { channelName: name });
    await first.storage.open();
    await first.open();
    const note = first.createNote({ title: 'Durable', body: '<p>kept</p>' });
    await first.flush();
    first.close();

    const second = new NotesDb(new IndexedDbAdapter(name), { channelName: name });
    await second.storage.open();
    await second.open();
    equal(second.getNote(note.id).title, 'Durable');
    second.close();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });
  });

  it('localStorage fallback works', async () => {
    await exercise(new LocalStorageAdapter(`personal-notes-test-${Date.now()}`));
  });

  it('memory backend works', async () => {
    await exercise(new MemoryAdapter());
  });

  it('other tabs receive changes', async () => {
    const channelName = `test-${Math.random()}`;
    const sharedStorage = new MemoryAdapter();
    const a = new NotesDb(sharedStorage, { channelName });
    const b = new NotesDb(sharedStorage, { channelName });
    await a.open();
    await b.open();
    const received = new Promise((resolve) => b.on((change) => {
      if (change.source === 'remote') resolve(change);
    }));
    const note = a.createNote({ title: 'From tab A' });
    await a.flush();
    const change = await received;
    assert(change.structural);
    equal(b.getNote(note.id).title, 'From tab A');
    a.close();
    b.close();
  });

  it('removes images no note uses, keeping recent ones', async () => {
    const db = await freshDb();
    const now = Date.now();
    await db.putAsset({ id: 'used', mime: 'image/png', dataUrl: 'x', created: now - 9 * DAY_MS });
    await db.putAsset({ id: 'unused', mime: 'image/png', dataUrl: 'x', created: now - 9 * DAY_MS });
    await db.putAsset({ id: 'recent', mime: 'image/png', dataUrl: 'x', created: now });
    db.createNote({ title: 'n', body: '<p><img data-asset="used" alt=""></p>' });
    equal(await db.collectOrphanAssets(now), 1);
    assert(await db.getAsset('used'));
    assert(!(await db.getAsset('unused')));
    assert(await db.getAsset('recent'));
  });
});

describe('Performance with 5,000 notes', () => {
  const LIMIT_MS = 100;

  async function bigDb() {
    const db = await freshDb();
    const { school, fun, course, lectures, movies } = seed(db);
    const places = [{}, { spaceId: school.id }, { collectionId: course.id }, { collectionId: lectures.id }, { spaceId: fun.id }, { collectionId: movies.id }];
    db.batch(() => {
      for (let i = 0; i < 5000; i += 1) {
        db.createNote({
          title: `Note number ${i}`,
          body: `<p>Paragraph of text for generated note ${i}, about nothing in particular.</p>`,
          now: i + 1,
          ...places[i % places.length],
        });
      }
    });
    return { db, movies, school };
  }

  async function timed(label, fn) {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    assert(ms < LIMIT_MS, `${label} took ${ms.toFixed(1)} ms (limit ${LIMIT_MS} ms)`);
    return result;
  }

  it(`lists, sorts, counts and moves within ${LIMIT_MS} ms`, async () => {
    const { db, movies, school } = await bigDb();
    equal(db.data.notes.size, 5000);
    equal((await timed('list all', () => db.listNotes())).length, 5000);
    await timed('sort by title', () => db.listNotes({ sort: { key: 'title', dir: 'asc' } }));
    await timed('filter by collection', () => db.listNotes({ collectionId: movies.id }));
    db._counts = null;
    const counts = await timed('count', () => db.counts());
    equal(counts.inbox + [...counts.spaces.values()].reduce((a, b) => a + b, 0), 5000);
    const ids = db.listNotes({ inbox: true }).map((n) => n.id);
    await timed('move many', () => db.moveNotes(ids, { spaceId: school.id }));
    equal(db.counts().inbox, 0);
  });

  it(`sorts typed notes by a field within ${LIMIT_MS} ms`, async () => {
    const db = await freshDb();
    db.batch(() => {
      for (let i = 0; i < 5000; i += 1) {
        db.createNote({ typeId: 'watchlist', title: `Film ${i}`, fields: { rating: i % 6, status: i % 2 ? 'Watched' : 'To watch' } });
      }
    });
    const sorted = await timed('sort by rating', () => db.listNotes({ sort: { key: 'field:rating', dir: 'desc' } }));
    equal(sorted[0].fields.rating, 5);
    equal(sorted.at(-1).fields.rating, 0, 'unrated last');
    await timed('sort by status', () => db.listNotes({ sort: { key: 'field:status', dir: 'asc' } }));
    await timed('sort by due date', () => db.listNotes({ sort: { key: 'due', dir: 'asc' } }));
  });

  it('exports and re-imports them all, correctly', async () => {
    const { db } = await bigDb();
    const text = JSON.stringify(await buildExport(db));
    const parsed = parseImport(text);
    assert(parsed.ok);
    const target = await freshDb();
    await applyImport(target, parsed.data, 'replace');
    equal(target.data.notes.size, 5000);
    const sample = target.listNotes({ sort: { key: 'created', dir: 'asc' } })[42];
    equal(sample.title, 'Note number 42');
  });
});

describe('Dates', () => {
  it('validates real calendar dates only', () => {
    assert(isDateStr('2026-02-28'));
    assert(!isDateStr('2026-02-30'));
    assert(!isDateStr('2026-2-8'));
    assert(!isDateStr(20260208));
    assert(!isDateStr(null));
  });

  it('adds days across months, years and daylight saving changes', () => {
    equal(addDays('2026-12-31', 1), '2027-01-01');
    equal(addDays('2026-03-01', -1), '2026-02-28');
    let day = '2026-01-01';
    for (let i = 0; i < 365; i += 1) day = addDays(day, 1);
    equal(day, '2027-01-01', 'a full year crosses both clock changes');
    equal(daysBetween('2026-01-01', '2027-01-01'), 365);
  });

  it('adds months without overflowing short months', () => {
    equal(addMonths('2026-01-31', 1), '2026-02-28');
    equal(addMonths('2024-01-31', 1), '2024-02-29');
    equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
    equal(addMonths('2026-12-15', 1), '2027-01-15');
  });

  it('describes nearby days in words', () => {
    equal(relativeDay('2026-05-10', '2026-05-10'), 'Today');
    equal(relativeDay('2026-05-11', '2026-05-10'), 'Tomorrow');
    equal(relativeDay('2026-05-09', '2026-05-10'), 'Yesterday');
  });

  it('builds a month grid of whole weeks from the chosen first weekday', () => {
    const monday = monthGrid(2026, 10, 1); // November 2026 starts on a Sunday
    equal(monday[0][0], '2026-10-26');
    equal(monday[0][6], '2026-11-01');
    assert(monday.flat().includes('2026-11-30'));
    assert(monday.every((week) => week.length === 7));
    equal(monthGrid(2026, 10, 0)[0][0], '2026-11-01');
    equal(firstDayOfWeek('sun'), 0);
    equal(firstDayOfWeek('mon'), 1);
  });
});

describe('Field kinds', () => {
  const number = { id: 'n', kind: 'number' };
  const rating = { id: 'r', kind: 'rating', max: 5 };
  const select = { id: 's', kind: 'select', options: ['To watch', 'Watching', 'Watched'] };

  it('turns unusable values into empty ones instead of failing', () => {
    equal(normalizeValue(number, 'abc'), null);
    equal(normalizeValue(number, '12.5'), 12.5);
    equal(normalizeValue(number, { x: 1 }), null);
    equal(normalizeValue(rating, 9), 0);
    equal(normalizeValue(rating, 'x'), 0);
    equal(normalizeValue({ kind: 'date' }, '2026-99-99'), '');
    equal(normalizeValue({ kind: 'multiselect' }, 'nope'), []);
    equal(normalizeValue({ kind: 'multiselect' }, ['a', 'a', 3, 'b']), ['a', 'b']);
    equal(normalizeValue({ kind: 'checkbox' }, 'true'), false);
    equal(normalizeValue({ kind: 'mood' }, 6), 0);
    equal(normalizeValue({ kind: 'tasks' }, 'nope'), []);
    equal(normalizeValue({ kind: 'text' }, { html: '<b>' }), '');
  });

  it('an unknown kind is treated as text', () => {
    equal(normalizeValue({ kind: 'alien' }, 'hello'), 'hello');
  });

  it('knows what counts as empty', () => {
    assert(isEmptyValue(number, null));
    assert(!isEmptyValue(number, 0));
    assert(isEmptyValue(rating, 0));
    assert(isEmptyValue({ kind: 'multiselect' }, []));
    assert(isEmptyValue({ kind: 'text' }, ''));
  });

  it('sorts select values by their option order, not alphabetically', () => {
    const sorted = ['Watched', 'To watch', 'Watching'].sort((a, b) => compareValues(select, a, b));
    equal(sorted, ['To watch', 'Watching', 'Watched']);
  });

  it('writes values as text', () => {
    equal(valueToText(rating, 4), '4/5');
    equal(valueToText({ kind: 'multiselect' }, ['a', 'b']), 'a, b');
    equal(valueToText({ kind: 'mood' }, 5), '😄 Great');
  });

  it('sort keys accept fields and refuse anything else', () => {
    assert(isSortKey('field:status'));
    assert(isSortKey('due'));
    assert(!isSortKey('field:'));
    assert(!isSortKey('constructor'));
    assert(!isSortKey(7));
  });
});

describe('Timetable: repeats', () => {
  // 2026-11-09 is a Monday. ISO week 46.
  const block = (props) => createTimeBlock({
    id: 'b', title: 'Deep Learning', date: '2026-11-10', start: '14:00', end: '16:00', ...props,
  });
  const dates = (blocks, from, to, options) => occurrencesBetween(blocks, from, to, options).map((o) => o.date);

  it('knows weekdays and ISO weeks, whatever the time zone', () => {
    equal(weekday('2026-11-09'), 1);
    equal(weekday('2026-11-15'), 0);
    equal(isoWeek('2026-11-09'), 46);
    equal(isoWeek('2026-01-01'), 1, 'a Thursday starts week 1');
    equal(isoWeek('2027-01-01'), 53, 'a Friday still belongs to the old year');
    equal(isoWeek('2024-12-30'), 1, 'a Monday can belong to the next year');
    equal(startOfWeek('2026-11-15', 1), '2026-11-09');
    equal(startOfWeek('2026-11-15', 0), '2026-11-15');
  });

  it('a single block happens once', () => {
    equal(dates([block()], '2026-11-01', '2026-11-30'), ['2026-11-10']);
  });

  it('repeats weekly on the chosen days, from its first day', () => {
    const b = block({ repeat: { days: [2, 4] } });
    equal(dates([b], '2026-11-01', '2026-11-22'), ['2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19']);
  });

  it('a series with no days repeats on the weekday of its first day', () => {
    equal(block({ repeat: { days: [] } }).repeat.days, [2]);
  });

  it('stops on its last day', () => {
    const b = block({ repeat: { days: [2], until: '2026-11-24' } });
    equal(dates([b], '2026-11-01', '2026-12-31'), ['2026-11-10', '2026-11-17', '2026-11-24']);
  });

  it('every 2 weeks counts from the first week, even across a new year', () => {
    const b = block({ date: '2026-12-15', repeat: { days: [2], weeks: 'alternate' } });
    equal(dates([b], '2026-12-01', '2027-01-31'), ['2026-12-15', '2026-12-29', '2027-01-12', '2027-01-26']);
  });

  it('every 2 weeks with two days keeps both in the same week', () => {
    const b = block({ date: '2026-11-09', repeat: { days: [1, 3], weeks: 'alternate' } });
    equal(dates([b], '2026-11-09', '2026-11-29'), ['2026-11-09', '2026-11-11', '2026-11-23', '2026-11-25']);
  });

  it('odd and even weeks follow ISO week numbers', () => {
    const odd = block({ date: '2026-11-02', repeat: { days: [1], weeks: 'odd' } });
    const even = block({ date: '2026-11-02', repeat: { days: [1], weeks: 'even' } });
    equal(dates([odd], '2026-11-02', '2026-11-30'), ['2026-11-02', '2026-11-16', '2026-11-30'], 'weeks 45, 47, 49');
    equal(dates([even], '2026-11-02', '2026-11-30'), ['2026-11-09', '2026-11-23'], 'weeks 46, 48');
  });

  it('stops when its semester ends, and waits for it to start', () => {
    const semesters = new Map([['s', { id: 's', start: '2026-11-16', end: '2026-12-01' }]]);
    const b = block({ semesterId: 's', repeat: { days: [2] } });
    equal(dates([b], '2026-11-01', '2026-12-31', { semesters }), ['2026-11-17', '2026-11-24', '2026-12-01']);
  });

  it('the earlier of its own last day and the semester end wins', () => {
    const semesters = new Map([['s', { id: 's', start: '2026-09-01', end: '2027-01-31' }]]);
    const b = block({ semesterId: 's', repeat: { days: [2], until: '2026-11-17' } });
    equal(dates([b], '2026-11-01', '2026-12-31', { semesters }), ['2026-11-10', '2026-11-17']);
  });

  it('a cancelled occurrence is kept, marked cancelled, and others go on', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-17': { cancelled: true } } });
    const list = occurrencesBetween([b], '2026-11-10', '2026-11-24');
    equal(list.map((o) => [o.date, o.cancelled]), [['2026-11-10', false], ['2026-11-17', true], ['2026-11-24', false]]);
    equal(findConflicts([...list, { ...list[1], key: 'other' }]), [], 'cancelled ones never conflict');
  });

  it('a moved occurrence appears on its new day and time only', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-17': { date: '2026-11-19', start: '10:00', end: '12:00' } } });
    const list = occurrencesBetween([b], '2026-11-10', '2026-11-24');
    equal(list.map((o) => [o.date, o.start, o.originalDate, o.changed]), [
      ['2026-11-10', '14:00', '2026-11-10', false],
      ['2026-11-19', '10:00', '2026-11-17', true],
      ['2026-11-24', '14:00', '2026-11-24', false],
    ]);
  });

  it('an occurrence moved into another week is found from either week', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-17': { date: '2026-11-27' } } });
    equal(dates([b], '2026-11-16', '2026-11-22'), [], 'gone from its own week');
    equal(dates([b], '2026-11-23', '2026-11-29'), ['2026-11-24', '2026-11-27'], 'and shown in the other');
  });

  it('a change on a day the series never fell on is ignored', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-18': { date: '2026-11-20' } } });
    equal(dates([b], '2026-11-16', '2026-11-22'), ['2026-11-17']);
  });

  it('moving a weekday of a series takes its changed weeks along', () => {
    const b = block({ date: '2026-11-10', repeat: { days: [2, 4] }, exceptions: { '2026-11-17': { start: '15:00' }, '2026-11-19': { cancelled: true } } });
    const patch = shiftSeriesDay(b, 2, 1);
    equal(patch.repeat.days, [3, 4]);
    equal(patch.exceptions, { '2026-11-18': { start: '15:00' }, '2026-11-19': { cancelled: true } });
    const moved = occurrencesBetween([{ ...b, ...patch }], '2026-11-16', '2026-11-22');
    equal(moved.map((o) => [o.date, o.start, o.cancelled]), [['2026-11-18', '15:00', false], ['2026-11-19', '14:00', true]]);
    equal(shiftSeriesDay(b, 2, -1).date, '2026-11-09', 'moving earlier keeps the first week');
  });

  it('only keeps what differs from the series when one occurrence changes', () => {
    const b = block({ repeat: { days: [2] } });
    equal(changeFromSeries(b, '2026-11-17', {
      date: '2026-11-17', start: '15:00', end: '16:00', title: 'Deep Learning', location: '',
    }), { start: '15:00' });
  });

  it('keeps wall-clock times across daylight saving changes', () => {
    // Clocks change in Europe on 2026-03-29 and 2026-10-25, and in the US on 2026-03-08 and 2026-11-01.
    const b = block({ date: '2026-03-01', start: '09:00', end: '10:30', repeat: { days: [0, 1] } });
    const list = occurrencesBetween([b], '2026-03-01', '2026-04-06');
    equal(list.map((o) => o.date), ['2026-03-01', '2026-03-02', '2026-03-08', '2026-03-09', '2026-03-15', '2026-03-16',
      '2026-03-22', '2026-03-23', '2026-03-29', '2026-03-30', '2026-04-05', '2026-04-06']);
    assert(list.every((o) => o.start === '09:00' && o.end === '10:30'));
    const autumn = occurrencesBetween([block({ date: '2026-10-18', repeat: { days: [0], weeks: 'alternate' } })], '2026-10-18', '2026-11-30');
    equal(autumn.map((o) => o.date), ['2026-10-18', '2026-11-01', '2026-11-15', '2026-11-29']);
  });

  it('turns a date and time into the right moment on a clock-change day', () => {
    for (const date of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01']) {
      const at = toInstant(date, '09:00');
      equal([at.getHours(), at.getMinutes()], [9, 0], date);
    }
  });

  it('checks a block before it is saved', () => {
    equal(blockProblem({ date: '2026-11-10', start: '10:00', end: '09:00' }), 'The end time needs to be after the start time.');
    equal(blockProblem({ date: '2026-11-10', start: '10:00', end: '10:00' }), 'The end time needs to be after the start time.');
    equal(blockProblem({ date: 'x', start: '10:00', end: '11:00' }), 'Choose a day.');
    equal(blockProblem({
      date: '2026-11-10', start: '10:00', end: '11:00', repeat: { days: [2], until: '2026-11-01' },
    }), 'The last day of the series is before its first day.');
    equal(blockProblem({ date: '2026-11-10', start: '10:00', end: '11:00' }), '');
  });

  it('cleans blocks from a backup, dropping what cannot be used', () => {
    equal(cleanTimeBlock({ id: 'x', date: '2026-11-10', start: '10:00', end: '09:00' }), null);
    equal(cleanTimeBlock({ id: 'x', date: 'nope', start: '10:00', end: '11:00' }), null);
    const clean = cleanTimeBlock({
      id: 'x',
      title: 'German',
      type: 'weird',
      date: '2026-11-10',
      start: '18:15',
      end: '20:00',
      color: 'neon',
      repeat: { days: [2, 9, 'x'], weeks: 'sometimes', until: '2020-01-01' },
      exceptions: { '2026-11-17': { cancelled: true }, bad: { cancelled: true }, '2026-11-24': { start: '21:00', end: '20:00' }, '2026-12-01': { title: 'Exam' } },
    });
    equal(clean.type, 'other');
    equal(clean.color, '');
    equal(clean.repeat, { days: [2], weeks: 'every', until: '' });
    equal(clean.exceptions, { '2026-11-17': { cancelled: true }, '2026-12-01': { title: 'Exam' } });
  });
});

describe('Timetable: conflicts and free time', () => {
  const occ = (key, date, start, end, extra = {}) => ({
    key, date, start, end, title: key, cancelled: false, ...extra,
  });

  it('finds overlapping blocks, but not ones that only touch', () => {
    const list = [occ('a', '2026-11-10', '09:00', '10:00'), occ('b', '2026-11-10', '10:00', '11:00'), occ('c', '2026-11-10', '10:30', '12:00'), occ('d', '2026-11-11', '10:30', '12:00')];
    equal(findConflicts(list).map(([x, y]) => `${x.key}${y.key}`), ['bc']);
  });

  it('finds a block that sits inside a longer one', () => {
    const list = [occ('long', '2026-11-10', '08:00', '18:00'), occ('a', '2026-11-10', '09:00', '10:00'), occ('b', '2026-11-10', '15:00', '16:00')];
    equal(findConflicts(list).length, 2);
  });

  it('checks a draft against everything else, leaving out itself', () => {
    const mine = [occ('m', '2026-11-10', '09:30', '10:30')];
    const others = [occ('m', '2026-11-10', '09:30', '10:30'), occ('x', '2026-11-10', '10:00', '11:00'), occ('y', '2026-11-10', '10:00', '11:00', { cancelled: true })];
    equal(conflictsWith(mine, others).map((o) => o.key), ['x']);
  });

  it('finds free slots of a minimum length within the chosen hours', () => {
    const list = [occ('a', '2026-11-10', '09:00', '10:00'), occ('b', '2026-11-10', '10:30', '12:00'), occ('c', '2026-11-10', '13:00', '19:30')];
    equal(freeSlots(list, {
      from: '2026-11-10', to: '2026-11-10', dayStart: '08:00', dayEnd: '20:00', minMinutes: 60,
    }).map((s) => `${s.start}-${s.end}`), ['08:00-09:00', '12:00-13:00']);
    equal(freeSlots(list, {
      from: '2026-11-10', to: '2026-11-10', dayStart: '08:00', dayEnd: '20:00', minMinutes: 30,
    }).map((s) => `${s.start}-${s.end}`), ['08:00-09:00', '10:00-10:30', '12:00-13:00', '19:30-20:00']);
  });

  it('a free day is one long slot, and cancelled blocks free their time', () => {
    const list = [occ('a', '2026-11-11', '09:00', '17:00', { cancelled: true })];
    equal(freeSlots(list, { from: '2026-11-11', to: '2026-11-11', dayStart: '09:00', dayEnd: '17:00' }), [{
      date: '2026-11-11', start: '09:00', end: '17:00', minutes: 480,
    }]);
  });

  it('handles overlapping busy blocks and blocks outside the hours', () => {
    const list = [occ('a', '2026-11-10', '07:00', '09:00'), occ('b', '2026-11-10', '08:30', '11:00'), occ('c', '2026-11-10', '10:00', '10:30'), occ('d', '2026-11-10', '19:00', '23:00')];
    equal(freeSlots(list, { from: '2026-11-10', to: '2026-11-10', dayStart: '08:00', dayEnd: '20:00' }).map((s) => `${s.start}-${s.end}`), ['11:00-19:00']);
  });

  it('skips time already past, and days not chosen', () => {
    const slots = freeSlots([], {
      from: '2026-11-09', to: '2026-11-11', dayStart: '08:00', dayEnd: '12:00', days: [1, 2], now: { date: '2026-11-09', time: '10:45' },
    });
    equal(slots.map((s) => `${s.date} ${s.start}-${s.end}`), ['2026-11-09 10:45-12:00', '2026-11-10 08:00-12:00']);
  });

  it('lays overlapping blocks side by side, and others full width', () => {
    const layout = layoutDay([occ('a', 'd', '09:00', '11:00'), occ('b', 'd', '10:00', '12:00'), occ('c', 'd', '11:00', '12:00'), occ('e', 'd', '13:00', '14:00')]);
    equal([...'abce'].map((k) => [layout.get(k).lane, layout.get(k).lanes]), [[0, 2], [1, 2], [0, 2], [0, 1]]);
  });

  it('says what is on now and what is next', () => {
    const list = [occ('a', 'd', '09:00', '10:00'), occ('b', 'd', '10:00', '11:00'), occ('c', 'd', '14:00', '15:00'), occ('x', 'd', '16:00', '17:00', { cancelled: true })];
    const at = scheduleAt(list, 'd', '10:20');
    equal([at.current?.key, at.next?.key, at.later.map((o) => o.key)], ['b', 'c', []]);
    equal(scheduleAt(list, 'd', '10:00').current.key, 'b', 'a block that just ended is not current');
    equal(scheduleAt(list, 'd', '18:00'), { current: null, next: null, later: [] });
    equal(startsIn('13:20', '14:00'), 'in 40 minutes');
    equal(startsIn('12:45', '14:00'), 'in 1 hour 15 minutes');
    equal(startsIn('13:00', '15:00'), 'in 2 hours');
    equal(startsIn('09:00', '18:15'), 'at 18:15');
  });
});

describe('Timetable: quick add', () => {
  const TODAY = '2026-11-09'; // Monday
  const read = (text) => parseBlockText(text, TODAY);

  it('reads the example from the request as a weekly class', () => {
    equal(read('German Tue 18:15-20:00'), {
      title: 'German', type: 'other', date: '2026-11-10', start: '18:15', end: '20:00', repeat: { days: [2], weeks: 'every', until: '' }, location: '',
    });
  });

  it('reads several days, other ways of writing times, and a place', () => {
    const r = read('Deep Learning lecture mon wed 14.00–16.00 @ Room 3.21');
    equal([r.title, r.type, r.date, r.start, r.end, r.repeat.days, r.location], ['Deep Learning lecture', 'class', TODAY, '14:00', '16:00', [1, 3], 'Room 3.21']);
    equal([read('gym fri 6-8pm').start, read('gym fri 6-8pm').end], ['18:00', '20:00']);
    equal([read('call 9am-10:30am thursday').start, read('call 9am-10:30am thursday').end], ['09:00', '10:30']);
  });

  it('reads alternating, odd and even weeks', () => {
    equal(read('Seminar thu 10:00-12:00 every 2 weeks').repeat.weeks, 'alternate');
    equal(read('Lab fri 10:00-12:00 odd weeks').repeat.weeks, 'odd');
    equal(read('Lab fri 10:00-12:00 biweekly').repeat.weeks, 'alternate');
  });

  it('today, tomorrow and once make a single block', () => {
    equal([read('Dentist tomorrow 15:30').date, read('Dentist tomorrow 15:30').start, read('Dentist tomorrow 15:30').end, read('Dentist tomorrow 15:30').repeat], ['2026-11-10', '15:30', '16:30', null]);
    equal(read('Workshop wed 10:00-12:00 once').repeat, null);
    equal(read('Workshop wed 10:00-12:00 once').date, '2026-11-11');
  });

  it('weekdays and daily', () => {
    equal(read('Standup weekdays 09:00-09:15').repeat.days, [1, 2, 3, 4, 5]);
    equal(read('Walk daily 07:00-07:30').repeat.days, [0, 1, 2, 3, 4, 5, 6]);
  });

  it('a weekday always means the next one, today included', () => {
    equal(read('German mon 18:00-19:00').date, TODAY);
    equal(read('German sun 18:00-19:00').date, '2026-11-15');
  });

  it('leaves a backwards range and number-like titles alone', () => {
    const r = read('Shift wed 20:00-18:00');
    equal([r.start, r.end], ['', '']);
    equal(read('Chapter 3.10 review tue').title, 'Chapter 3.10 review');
    equal([read('Monday.com demo').title, read('Monday.com demo').repeat], ['Monday.com demo', null]);
    equal(read('Rock and roll on Tue 20:00-22:00').title, 'Rock and roll');
    equal([read('Python on Mon and Wed 10:00-11:00').title, read('Python on Mon and Wed 10:00-11:00').repeat.days], ['Python', [1, 3]]);
    equal([read('15.30 dentist tomorrow').start, read('15.30 dentist tomorrow').title], ['15:30', 'Dentist']);
    equal(read('Sat at 3pm party').start, '15:00');
  });
});

describe('Your day and your week', () => {
  const TODAY = '2026-11-11'; // A Wednesday.
  const occ = (key, date, start, end, extra = {}) => ({
    key, date, start, end, title: key, cancelled: false, color: 'sky', ...extra,
  });
  const task = (id, due, extra = {}) => ({
    item: {
      id, text: id, due, time: '', done: false, ...extra,
    },
    noteId: 'n',
    noteTitle: 'List',
  });

  it('puts the day in time order, then what has no time, overdue first', () => {
    const { timed, untimed } = dayAgenda({
      occurrences: [occ('Lecture', TODAY, '14:00', '16:00'), occ('Gym', TODAY, '08:00', '09:00'), occ('Gone', TODAY, '10:00', '11:00', { cancelled: true }), occ('Other day', '2026-11-12', '09:00', '10:00')],
      entries: [task('Call', TODAY, { time: '11:30' }), task('Milk', TODAY), task('Rent', '2026-11-09'), task('Done before', '2026-11-08', { done: true }), task('Later', '2026-11-20'), task('Finished', TODAY, { done: true })],
    }, TODAY, '12:00');
    equal(timed.map((i) => [i.title, i.when ?? '']), [['Gym', 'past'], ['Call', 'past'], ['Lecture', 'next']]);
    equal(untimed.map((i) => [i.title, i.overdue, i.done]), [['Rent', true, false], ['Milk', false, false], ['Finished', false, true]]);
  });

  it('marks what is on now', () => {
    const { timed } = dayAgenda({ occurrences: [occ('Lecture', TODAY, '14:00', '16:00'), occ('Seminar', TODAY, '16:30', '17:00')], entries: [] }, TODAY, '15:10');
    equal(timed.map((i) => i.when), ['now', 'next']);
  });

  it('shows a task given a time on the timetable once, as its block', () => {
    const { all } = dayAgenda({ occurrences: [occ('Essay', TODAY, '09:00', '10:00', { task: { taskId: 'essay' } })], entries: [task('essay', TODAY)] }, TODAY, '08:00');
    equal(all.map((i) => i.kind), ['block']);
  });

  it('includes deadlines and calendar events', () => {
    const { all } = dayAgenda({
      occurrences: [],
      entries: [{ ...task('Ship it', TODAY), isDeadline: true }, { ...task('Lunch', TODAY, { time: '12:30' }), isEvent: true }],
    }, TODAY, '08:00');
    equal(all.map((i) => [i.kind, i.title]), [['event', 'Lunch'], ['deadline', 'Ship it']]);
  });

  it('lays out the week day by day, with totals', () => {
    const from = '2026-11-09';
    const { days, totals } = weekAgenda({
      occurrences: [occ('Mon class', '2026-11-09', '09:00', '11:00'), occ('Wed class', TODAY, '14:00', '15:30'), occ('Next week', '2026-11-16', '09:00', '10:00')],
      entries: [task('Done task', '2026-11-10', { done: true }), task('Open task', '2026-11-13'), { ...task('Goal', '2026-11-15'), isDeadline: true }, task('Old', '2026-11-02')],
    }, from, TODAY);
    equal(days.map((d) => d.items.map((i) => i.title)), [['Mon class'], ['Done task'], ['Wed class'], [], ['Open task'], [], ['Goal']]);
    equal(days.map((d) => d.minutes), [120, 0, 90, 0, 0, 0, 0]);
    equal(totals, {
      minutes: 210, blocks: 2, tasks: 2, tasksDone: 1, deadlines: 1,
    });
  });
});

describe('Sync between devices', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  const titles = (db) => db.listNotes().map((n) => n.title).sort();

  /** Two devices sharing one Drive copy, in memory: merge both ways, like driveSync.js does. */
  async function syncPair(a, b) {
    for (const [here, there] of [[a, b], [b, a], [a, b]]) {
      const result = mergeSnapshots(snapshotOf(here), snapshotOf(there), { since: here.lastSync ?? 0 });
      here.withSyncTimes(() => {
        for (const { store, record } of result.puts) here._put(store, record);
        for (const { store, id } of result.removes) here._remove(store, id);
        here.rebuildLinks();
      }, new Map(result.removes.map((r) => [`${r.store}:${r.id}`, r.at])));
      here.adoptTombstones(result.merged.deleted);
      here.lastSync = Date.now();
      await tick();
    }
  }

  it('stamps each change with when it happened, and keeps an import’s own times', async () => {
    const db = await freshDb();
    const before = Date.now();
    const note = db.createNote({ title: 'One' });
    assert(note.syncAt >= before, 'a new note is stamped now');
    await tick();
    const edited = db.updateNote(note.id, { title: 'Two' });
    assert(edited.syncAt > note.syncAt, 'an edit is stamped later');
    const copy = await freshDb();
    const backup = JSON.parse(JSON.stringify(await buildExport(db)));
    await applyImport(copy, parseImport(JSON.stringify(backup)).data, 'replace');
    equal(copy.getNote(note.id).syncAt, edited.syncAt, 'a restored backup keeps each change time');
    backup.data.notes[0].updated = 1000;
    delete backup.data.notes[0].syncAt;
    const older = await freshDb();
    await applyImport(older, parseImport(JSON.stringify(backup)).data, 'replace');
    equal(older.getNote(note.id).syncAt, 1000, 'a backup from before sync existed counts from its last edit');
  });

  it('remembers deletions, and forgets them when the record comes back', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Gone' });
    db.trashNotes([note.id]);
    db.purgeNotes([note.id]);
    assert(db.syncTombstones()[`notes:${note.id}`] > 0);
    const { undo } = db.undoable(() => db.createNote({ id: note.id, title: 'Back' }));
    equal(db.syncTombstones()[`notes:${note.id}`], undefined);
    undo();
    assert(db.syncTombstones()[`notes:${note.id}`] > 0, 'undoing brings the deletion back');
    db.pruneTombstones(Date.now() + 1);
    equal(db.syncTombstones(), {});
  });

  it('two devices end up with each other’s notes', async () => {
    const a = await freshDb();
    const b = await freshDb();
    a.createNote({ title: 'From the Mac' });
    b.createNote({ title: 'From the phone' });
    await syncPair(a, b);
    equal(titles(a), ['From the Mac', 'From the phone']);
    equal(titles(b), titles(a));
  });

  it('the newer edit wins, and the losing edit is reported', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const note = a.createNote({ title: 'Draft' });
    await syncPair(a, b);
    a.updateNote(note.id, { body: '<p>Mac version</p>' });
    await tick();
    b.updateNote(note.id, { body: '<p>Phone version</p>' });
    const result = mergeSnapshots(snapshotOf(a), snapshotOf(b), { since: a.lastSync });
    equal(result.conflicts.map((c) => c.record.text), ['Mac version'], 'the Mac’s unsynced edit lost, and is reported');
    const otherWay = mergeSnapshots(snapshotOf(b), snapshotOf(a), { since: b.lastSync });
    equal(otherWay.conflicts.map((c) => c.record.text), ['Mac version'], 'and reported on the phone too, where the newer edit won');
    await syncPair(a, b);
    equal(a.getNote(note.id).text, 'Phone version');
    equal(b.getNote(note.id).text, 'Phone version');
  });

  it('a deletion reaches the other device, and an older edit doesn’t undo it', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const note = a.createNote({ title: 'Old' });
    await syncPair(a, b);
    a.trashNotes([note.id]);
    a.purgeNotes([note.id]);
    await syncPair(a, b);
    equal(b.getNote(note.id), null);
    equal(titles(b), []);
  });

  it('an edit made after a deletion brings the note back', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const note = a.createNote({ title: 'Keep me' });
    await syncPair(a, b);
    a.purgeNotes([note.id]);
    await tick();
    b.updateNote(note.id, { title: 'Kept' });
    await syncPair(a, b);
    equal(a.getNote(note.id)?.title, 'Kept');
  });

  it('a third device learns about a deletion it never saw happen', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const c = await freshDb();
    const note = a.createNote({ title: 'Shared' });
    await syncPair(a, b);
    await syncPair(a, c);
    b.purgeNotes([note.id]);
    await syncPair(b, a);
    await syncPair(a, c);
    equal(c.getNote(note.id), null);
  });

  it('merging twice changes nothing, so syncing again sends nothing', async () => {
    const a = await freshDb();
    const b = await freshDb();
    a.createNote({ title: 'One' });
    await syncPair(a, b);
    const again = mergeSnapshots(snapshotOf(a), snapshotOf(b), { since: a.lastSync });
    equal([again.puts.length, again.removes.length, again.remoteChanged], [0, 0, false]);
  });

  it('settings sync, while device details stay behind', async () => {
    const a = await freshDb();
    const b = await freshDb();
    a.updateSettings({ theme: 'dark' });
    a.setMeta('driveSync', { on: true });
    await syncPair(a, b);
    equal(b.getSettings().theme, 'dark');
    equal(b.getMeta('driveSync'), null);
  });

  it('built-in note types are never part of the copy', async () => {
    const db = await freshDb();
    assert(!Object.keys(snapshotOf(db).records).some((k) => k === 'noteTypes:free'));
  });

  it('timetable blocks and habits sync too', async () => {
    const a = await freshDb();
    const b = await freshDb();
    a.createBlock({ title: 'German', date: '2026-11-10', start: '18:00', end: '19:00' });
    a.createHabit({ name: 'Stretch' });
    await syncPair(a, b);
    equal([b.listBlocks().length, b.listHabits().length], [1, 1]);
  });

  it('packs and unpacks a copy, and encrypts it with a passphrase', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Secret plan', body: '<p>Top secret</p>' });
    const plain = await packSnapshot(snapshotOf(db));
    assert(plain.includes('Secret plan'));
    equal(Object.keys((await unpackSnapshot(plain)).records).length, Object.keys(snapshotOf(db).records).length);
    const { key, lock } = await createSyncKey('correct horse battery');
    const sealed = await packSnapshot(snapshotOf(db), { key, lock });
    assert(!sealed.includes('Secret') && !sealed.includes('Top secret'), 'nothing readable in the encrypted file');
    equal(peekSnapshot(sealed).encrypted, true);
    let thrown = null;
    try {
      await unpackSnapshot(sealed);
    } catch (error) {
      thrown = error;
    }
    assert(thrown, 'opening without the key fails');
    const reopened = await openSyncKey(peekSnapshot(sealed).lock, 'correct horse battery');
    const back = await unpackSnapshot(sealed, { key: reopened });
    assert(Object.values(back.records).some((r) => r.title === 'Secret plan'));
    let wrong = null;
    try {
      await openSyncKey(peekSnapshot(sealed).lock, 'wrong passphrase');
    } catch (error) {
      wrong = error;
    }
    assert(wrong instanceof WrongPasscodeError);
  });

  it('refuses files that aren’t a copy, and ignores records it doesn’t know', async () => {
    let thrown = 0;
    for (const text of ['nope', '{"format":"other"}', '{"format":"notes-sync","version":99}']) {
      try {
        peekSnapshot(text);
      } catch {
        thrown += 1;
      }
    }
    equal(thrown, 3);
    const copy = await unpackSnapshot(JSON.stringify({
      format: 'notes-sync', version: 1, data: { records: { 'notes:a': { id: 'a', title: 'x' }, 'meta:lock': { id: 'lock' }, 'weird:b': { id: 'b' }, 'notes:c': { id: 'other' } }, deleted: { 'notes:z': 5, 'notes:y': 'bad' } },
    }));
    equal(Object.keys(copy.records), ['notes:a']);
    equal(copy.deleted, { 'notes:z': 5 });
  });

  it('knows the latest change in a copy', () => {
    equal(latestChange({ records: { a: { syncAt: 5 }, b: { updated: 9 } }, deleted: { c: 7 } }), 9);
    equal(stampOf({ created: 3 }), 3);
  });
});

describe('Spaced repetition', () => {
  const TODAY = '2026-11-09';

  it('right answers come back after 1, 3, 7, 14, then 30 days', () => {
    let card = createCard('term', 'def');
    const gaps = [];
    let day = TODAY;
    for (let i = 0; i < 7; i += 1) {
      const next = nextReview(card, true, day);
      gaps.push(daysBetween(day, next.due));
      card = { ...card, ...next };
      day = next.due;
    }
    equal(gaps, [1, 3, 7, 14, 30, 30, 30]);
    equal(INTERVALS, [1, 3, 7, 14, 30]);
  });

  it('a wrong answer starts over, due tomorrow', () => {
    equal(nextReview({ box: 4, due: '2026-12-01' }, false, TODAY), { box: 0, due: '2026-11-10' });
  });

  it('new cards are due, and so are cards due today or before', () => {
    assert(isDue({ due: '' }, TODAY));
    assert(isDue({ due: TODAY }, TODAY));
    assert(isDue({ due: '2026-11-01' }, TODAY));
    assert(!isDue({ due: '2026-11-10' }, TODAY));
  });

  it('builds the review queue with the new ones counted and the next date', () => {
    const entries = [{ card: { due: '' } }, { card: { due: '2026-11-08' } }, { card: { due: '2026-11-12' } }, { card: { due: '2026-11-11' } }];
    const queue = reviewQueue(entries, TODAY);
    equal([queue.due.length, queue.fresh, queue.next], [2, 1, '2026-11-11']);
  });

  it('a quiz answer schedules the card', () => {
    const card = recordAnswer(createCard('a', 'b'), true, new Date(2026, 10, 9, 15).getTime());
    equal([card.box, card.due, card.right], [1, '2026-11-10', 1]);
    const missed = recordAnswer(card, false, new Date(2026, 10, 10, 9).getTime());
    equal([missed.box, missed.due, missed.review], [0, '2026-11-11', true]);
  });

  it('cards saved before scheduling existed are new, and bad values are dropped', () => {
    equal(normalizeCards([{ id: 'a', term: 'x', def: 'y' }])[0].due, '');
    const [card] = normalizeCards([{ id: 'a', term: 'x', box: 9, due: 'soon' }]);
    equal([card.box, card.due], [0, '']);
    equal(normalizeCards([{ id: 'a', term: 'x', box: 3, due: '2026-11-12' }])[0].box, 3);
  });
});

describe('Habits', () => {
  const TODAY = '2026-11-09';
  const habit = (days) => createHabit({ id: 'h', name: 'Stretch', done: Object.fromEntries(days.map((d) => [d, true])) });

  it('ticks and unticks a day', () => {
    let h1 = createHabit({ name: '  Read  ' });
    equal(h1.name, 'Read');
    h1 = toggleHabitDay(h1, TODAY);
    equal(h1.done, { [TODAY]: true });
    equal(toggleHabitDay(h1, TODAY).done, {});
  });

  it('counts the streak, letting today wait until it is over', () => {
    equal(habitStreak(habit(['2026-11-07', '2026-11-08', TODAY]), TODAY).current, 3);
    equal(habitStreak(habit(['2026-11-07', '2026-11-08']), TODAY).current, 2, 'not done yet today');
    equal(habitStreak(habit(['2026-11-06', '2026-11-07']), TODAY).current, 0, 'yesterday missed');
    equal(habitStreak(habit(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-08']), TODAY).longest, 3);
  });

  it('streaks cross months and clock changes', () => {
    equal(habitStreak(habit(['2026-10-24', '2026-10-25', '2026-10-26']), '2026-10-26').current, 3);
    equal(habitStreak(habit(['2026-02-28', '2026-03-01']), '2026-03-01').current, 2);
  });

  it('shows the last seven days, oldest first', () => {
    equal(lastWeek(habit(['2026-11-03', TODAY]), TODAY).map((d) => d.done), [true, false, false, false, false, false, true]);
  });

  it('lets very old days go', () => {
    const old = toggleHabitDay(habit(['2020-01-01']), TODAY);
    equal(Object.keys(old.done), [TODAY]);
  });

  it('cleans habits from a backup', () => {
    equal(cleanHabit({ id: 'h' }), null);
    const clean = cleanHabit({ id: 'h', name: 'Run', done: { [TODAY]: true, bad: true, '2026-11-08': 'yes' } });
    equal(clean.done, { [TODAY]: true });
  });

  it('are stored, ordered, ticked and backed up', async () => {
    const db = await freshDb();
    const a = db.createHabit({ name: 'Read' });
    const b = db.createHabit({ name: 'Run', icon: '🏃' });
    throwsRule(() => db.createHabit({ name: '   ' }));
    db.moveHabit(b.id, 0);
    equal(db.listHabits().map((x) => x.name), ['Run', 'Read']);
    db.toggleHabit(a.id, TODAY);
    const copy = await freshDb();
    await applyImport(copy, parseImport(JSON.stringify(await buildExport(db))).data, 'replace');
    equal(copy.getHabit(a.id).done, { [TODAY]: true });
    const { undo } = db.undoable(() => db.deleteHabit(a.id));
    equal(db.listHabits().length, 1);
    undo();
    equal(db.listHabits().length, 2);
  });
});

describe('Dashboard layout', () => {
  it('starts in the order the spec gives, with extras switched off', () => {
    const layout = dashboardLayout({});
    equal(layout.filter((w) => w.on).map((w) => w.id), ['day', 'week', 'journal', 'inbox', 'course', 'habits', 'recent', 'pinned', 'bored', 'watch', 'onThisDay', 'nudge']);
    equal(layout.filter((w) => !w.on).map((w) => w.id), ['today', 'schedule', 'next7', 'progress', 'favorites', 'views']);
    equal([layout.find((w) => w.id === 'nudge').size, layout.find((w) => w.id === 'week').size], ['wide', 'wide']);
  });

  it('Your day and Your week take over from what they cover, once', () => {
    const before = dashboardLayout({ homeBlocks: [{ id: 'today', on: true }, { id: 'schedule', on: true }, { id: 'habits', on: true }] });
    const state = Object.fromEntries(before.map((w) => [w.id, w.on]));
    equal([state.day, state.week, state.today, state.schedule, state.habits], [true, true, false, false, true]);
    equal(before.slice(0, 2).map((w) => w.id), ['day', 'week'], 'at the top');
    const later = dashboardLayout({ homeBlocks: [{ id: 'day', on: true }, { id: 'today', on: true }] });
    assert(later.find((w) => w.id === 'today').on, 'switching one back on sticks');
  });

  it('keeps an older saved layout, adding new widgets after the ones they follow', () => {
    const layout = dashboardLayout({ homeBlocks: [{ id: 'day', on: true }, { id: 'inbox', on: true }, { id: 'today', on: false }, { id: 'favorites', on: true }, { id: 'gone', on: true }] });
    equal(layout.slice(0, 6).map((w) => [w.id, w.on]), [['day', true], ['week', true], ['journal', true], ['inbox', true], ['today', false], ['schedule', false]]);
    assert(layout.find((w) => w.id === 'favorites').on, 'a saved choice wins over the default');
    assert(!layout.some((w) => w.id === 'gone'));
    equal(layout.length, WIDGETS.length);
  });

  it('moves, resizes and sets options', () => {
    let layout = dashboardLayout({});
    layout = moveWidget(layout, 'habits', 0);
    equal(layout[0].id, 'habits');
    layout = moveWidget(layout, 'habits', 99);
    equal(layout.at(-1).id, 'habits');
    layout = updateWidget(layout, 'today', { size: 'wide', options: { collectionId: 'c1' } });
    layout = updateWidget(layout, 'today', { options: { other: 1 } });
    equal(layout.find((w) => w.id === 'today'), {
      id: 'today', on: false, size: 'wide', options: { collectionId: 'c1', other: 1 },
    });
  });

  it('greets by the time of day', () => {
    equal([greeting(6), greeting(13), greeting(19), greeting(2)], ['Good morning', 'Good afternoon', 'Good evening', 'Hello, night owl']);
  });
});

describe('Timetable: sessions, summary and reminders', () => {
  const block = (props) => createTimeBlock({
    id: 'b', title: 'Deep Learning', date: '2026-11-10', start: '14:00', end: '16:00', ...props,
  });

  it('numbers the sessions of a series, skipping cancelled ones', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-17': { cancelled: true } } });
    equal(sessionNumber(b, '2026-11-10'), 1);
    equal(sessionNumber(b, '2026-11-17'), null, 'a cancelled session has no number');
    equal(sessionNumber(b, '2026-11-24'), 2);
    equal(sessionNumber(b, '2026-11-25'), null, 'not a day of the series');
    equal(sessionNumber(block(), '2026-11-10'), null, 'a single block');
  });

  it('counts from the start of the semester', () => {
    const semesters = new Map([['s', { id: 's', start: '2026-11-16', end: '2027-01-31' }]]);
    equal(sessionNumber(block({ semesterId: 's', repeat: { days: [2] } }), '2026-11-24', semesters), 2);
  });

  it('sums the week by kind and by space, with free time counted once', () => {
    const occ = (date, start, end, type, spaceId, extra = {}) => ({
      key: `${date}${start}`, date, start, end, type, spaceId, cancelled: false, ...extra,
    });
    const list = [
      occ('2026-11-10', '09:00', '11:00', 'class', 'school'),
      occ('2026-11-10', '10:00', '12:00', 'study', 'school'),
      occ('2026-11-11', '09:00', '10:00', 'work', null),
      occ('2026-11-11', '13:00', '14:00', 'class', 'school', { cancelled: true }),
    ];
    const summary = weekSummary(list, {
      from: '2026-11-10', to: '2026-11-11', dayStart: '08:00', dayEnd: '12:00',
    });
    equal(summary.byType, [{ type: 'class', minutes: 120 }, { type: 'study', minutes: 120 }, { type: 'work', minutes: 60 }]);
    equal(summary.bySpace, [{ spaceId: 'school', minutes: 240 }, { spaceId: null, minutes: 60 }]);
    equal(summary.free, 60 + 180, 'Tuesday 08-09, Wednesday 08-09 and 10-12');
  });

  it('guesses a kind from the title', () => {
    equal(guessType('Deep Learning lecture'), 'class');
    equal(guessType('Dentist'), 'appointment');
    equal(guessType('German'), 'other');
  });

  it('a reminder is due from its time until the block starts, once', () => {
    const b = block({ reminder: 15 });
    const blocks = new Map([['b', b]]);
    const occurrences = occurrencesBetween([b], '2026-11-10', '2026-11-10');
    const at = (time, shown) => dueReminders(occurrences, blocks, { date: '2026-11-10', time }, shown).map((r) => r.minutes);
    equal(at('13:44'), []);
    equal(at('13:45'), [15]);
    equal(at('13:58'), [2]);
    equal(at('14:00'), [], 'not once it has started');
    equal(at('13:50', new Set(['b:2026-11-10'])), [], 'not twice');
    equal(dueReminders(occurrences, new Map([['b', block()]]), { date: '2026-11-10', time: '13:50' }), [], 'not without a reminder');
  });

  it('a moved or cancelled occurrence reminds at its own time, or not at all', () => {
    const b = block({ reminder: 10, repeat: { days: [2] }, exceptions: { '2026-11-10': { start: '15:00', end: '16:00' }, '2026-11-17': { cancelled: true } } });
    const blocks = new Map([['b', b]]);
    const moved = occurrencesBetween([b], '2026-11-10', '2026-11-10');
    equal(dueReminders(moved, blocks, { date: '2026-11-10', time: '13:55' }), []);
    equal(dueReminders(moved, blocks, { date: '2026-11-10', time: '14:55' }).length, 1);
    const cancelled = occurrencesBetween([b], '2026-11-17', '2026-11-17');
    equal(dueReminders(cancelled, blocks, { date: '2026-11-17', time: '13:55' }), []);
  });

  it('keeps reminders, tasks and session notes through a backup, and drops bad ones', () => {
    const clean = cleanTimeBlock({
      id: 'x', date: '2026-11-10', start: '09:00', end: '10:00', reminder: 7, task: { noteId: 'n' }, sessions: { '2026-11-10': 'note', bad: 'x' }, uid: 'abc@google.com',
    });
    equal([clean.reminder, clean.task, clean.sessions, clean.uid], [null, null, { '2026-11-10': 'note' }, 'abc@google.com']);
    const good = cleanTimeBlock({
      id: 'x', date: '2026-11-10', start: '09:00', end: '10:00', reminder: 15, task: { noteId: 'n', fieldId: 'items', taskId: 't' },
    });
    equal([good.reminder, good.task], [15, { noteId: 'n', fieldId: 'items', taskId: 't' }]);
  });

  it('a task block loses its task, and a block its session notes, when the notes are gone', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'List', typeId: 'checklist', fields: { items: [createTask('Write essay')] } });
    const taskId = note.fields.items[0].id;
    const b = db.createBlock({
      title: 'Write essay', date: '2026-11-10', start: '09:00', end: '10:00', task: { noteId: note.id, fieldId: 'items', taskId }, sessions: { '2026-11-10': note.id },
    });
    db.purgeNotes([note.id]);
    db.repairIntegrity();
    equal([db.getBlock(b.id).task, db.getBlock(b.id).sessions], [null, {}]);
  });
});

describe('Timetable: .ics files', () => {
  const block = (props) => createTimeBlock({
    id: 'b1', title: 'German, B1; evening', date: '2026-11-10', start: '18:15', end: '20:00', location: 'Room 3', ...props,
  });
  const lines = (text) => text.replace(/\r\n /g, '').split('\r\n');

  it('writes a weekly series as one repeating event', () => {
    const text = blocksToIcs([block({ repeat: { days: [2, 4], until: '2027-01-31' } })], { now: Date.UTC(2026, 10, 9) });
    const all = lines(text);
    assert(text.includes('\r\n') && text.endsWith('END:VCALENDAR\r\n'), 'CRLF line ends');
    assert(all.includes('DTSTART:20261110T181500'), all.join('|'));
    assert(all.includes('DTEND:20261110T200000'));
    assert(all.includes('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;WKST=MO;UNTIL=20270131T235959'), all.join('|'));
    assert(all.includes('SUMMARY:German\\, B1\\; evening'), 'commas and semicolons escaped');
    assert(all.includes('LOCATION:Room 3'));
    assert(all.includes('UID:b1@notes-timetable'));
  });

  it('starts the series on its first real day, and uses every 2 weeks', () => {
    const all = lines(blocksToIcs([block({ date: '2026-11-09', repeat: { days: [2], weeks: 'alternate' } })]));
    assert(all.includes('DTSTART:20261110T181500'), all.join('|'));
    assert(all.some((l) => l.startsWith('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')));
  });

  it('leaves out cancelled weeks and writes changed weeks on their own', () => {
    const b = block({ repeat: { days: [2] }, exceptions: { '2026-11-17': { cancelled: true }, '2026-11-24': { start: '17:00', end: '19:00' } } });
    const all = lines(blocksToIcs([b]));
    assert(all.includes('EXDATE:20261117T181500'), all.join('|'));
    assert(all.includes('RECURRENCE-ID:20261124T181500'));
    assert(all.includes('DTSTART:20261124T170000'));
  });

  it('writes odd and even weeks out one by one, for a year at most', () => {
    const all = lines(blocksToIcs([block({ date: '2026-11-02', repeat: { days: [1], weeks: 'odd' } })]));
    const starts = all.filter((l) => l.startsWith('DTSTART'));
    equal(starts.slice(0, 3), ['DTSTART:20261102T181500', 'DTSTART:20261116T181500', 'DTSTART:20261130T181500']);
    assert(starts.length >= 25 && starts.length <= 28, starts.length);
    assert(!all.some((l) => l.startsWith('RRULE')));
  });

  it('folds long lines at 75 bytes, even in the middle of other alphabets', () => {
    const text = blocksToIcs([block({ notes: 'Ödev ve sınav hazırlığı için çalışma notları: '.repeat(6) })]);
    for (const line of text.split('\r\n')) assert(new TextEncoder().encode(line).length <= 75, line);
    const back = parseIcs(text).events[0];
    equal(back.notes, 'Ödev ve sınav hazırlığı için çalışma notları: '.repeat(6).trim());
  });

  it('reads back what it writes', () => {
    const original = block({
      repeat: { days: [2, 4], weeks: 'alternate', until: '2027-01-31' },
      notes: 'Bring the book,\nand a pen',
      exceptions: { '2026-11-12': { cancelled: true }, '2026-11-24': { start: '17:00', end: '19:00', location: 'Room 9' } },
    });
    const parsed = parseIcs(blocksToIcs([original]));
    assert(parsed.ok);
    equal(parsed.events.length, 1);
    const [event] = parsed.events;
    equal(event.problem, '');
    equal([event.title, event.date, event.start, event.end, event.location, event.notes], ['German, B1; evening', '2026-11-10', '18:15', '20:00', 'Room 3', 'Bring the book,\nand a pen']);
    equal(event.repeat, { days: [2, 4], weeks: 'alternate', until: '2027-01-31' });
    equal(event.exceptions, { '2026-11-12': { cancelled: true }, '2026-11-24': { start: '17:00', end: '19:00', location: 'Room 9' } });
    const again = occurrencesBetween([createTimeBlock({ id: 'x', ...eventToBlock(event) })], '2026-11-01', '2027-02-28');
    const before = occurrencesBetween([original], '2026-11-01', '2027-02-28');
    equal(again.map((o) => [o.date, o.start, o.cancelled]), before.map((o) => [o.date, o.start, o.cancelled]));
  });

  const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const vevent = (...props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'];

  it('reads events from other apps: UTC, durations, counts and daily repeats', () => {
    const parsed = parseIcs(calendar(
      vevent('UID:a', 'SUMMARY:Gym', 'DTSTART:20261110T070000', 'DURATION:PT1H30M', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4'),
      vevent('UID:b', 'SUMMARY:Walk', 'DTSTART:20261110T063000', 'DTEND:20261110T070000', 'RRULE:FREQ=DAILY'),
      vevent('UID:c', 'SUMMARY:Lecture: Algorithms', 'DTSTART;TZID="Fake/Zone":20261111T100000', 'DTEND;TZID="Fake/Zone":20261111T120000'),
    ));
    const [gym, walk, lecture] = parsed.events;
    equal([gym.end, gym.repeat], ['08:30', { days: [2, 4], weeks: 'every', until: '2026-11-19' }]);
    equal(walk.repeat.days, [0, 1, 2, 3, 4, 5, 6]);
    equal([lecture.start, lecture.end, lecture.type], ['10:00', '12:00', 'class'], 'an unknown zone keeps the time as written');
  });

  it('turns UTC and named time zones into local time', () => {
    const utc = readDateTime('20261110T120000Z');
    const expected = new Date(Date.UTC(2026, 10, 10, 12, 0));
    equal(utc.time, `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`);
    const tokyo = readDateTime('20261110T210000', { TZID: 'Asia/Tokyo' });
    const fromTokyo = new Date(Date.UTC(2026, 10, 10, 12, 0));
    equal([tokyo.date, tokyo.time], [toDateStr(fromTokyo), `${String(fromTokyo.getHours()).padStart(2, '0')}:${String(fromTokyo.getMinutes()).padStart(2, '0')}`]);
    // A New York time on the day its clocks change.
    const ny = readDateTime('20261101T090000', { TZID: 'America/New_York' });
    const fromNy = new Date(Date.UTC(2026, 10, 1, 14, 0));
    equal(ny.time, `${String(fromNy.getHours()).padStart(2, '0')}:${String(fromNy.getMinutes()).padStart(2, '0')}`);
  });

  it('explains what it cannot import instead of guessing', () => {
    const parsed = parseIcs(calendar(
      vevent('UID:a', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261225'),
      vevent('UID:b', 'SUMMARY:Rent', 'DTSTART:20261101T090000', 'DTEND:20261101T091500', 'RRULE:FREQ=MONTHLY'),
      vevent('UID:c', 'SUMMARY:Night shift', 'DTSTART:20261110T220000', 'DTEND:20261111T060000'),
      vevent('UID:d', 'SUMMARY:Team', 'DTSTART:20261102T100000', 'DTEND:20261102T110000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO'),
      vevent('UID:e', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261102T100000', 'DTEND:20261102T110000'),
      vevent('UID:f', 'SUMMARY:No time'),
    ));
    const problems = Object.fromEntries(parsed.events.map((e) => [e.title, e.problem]));
    assert(problems.Holiday.includes('all-day'));
    assert(problems.Rent.includes('monthly'));
    assert(problems['Night shift'].includes('midnight'));
    assert(problems.Team.length > 0);
    assert(!('Gone' in problems), 'cancelled events are left out');
    assert(problems['No time'].includes('no start'));
  });

  it('attaches changed and cancelled weeks from other apps to their series', () => {
    const parsed = parseIcs(calendar(
      vevent('UID:s', 'SUMMARY:Seminar', 'DTSTART:20261109T100000', 'DTEND:20261109T110000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE:20261116T100000,20261123T100000'),
      vevent('UID:s', 'RECURRENCE-ID:20261130T100000', 'SUMMARY:Seminar (room change)', 'DTSTART:20261201T100000', 'DTEND:20261201T110000'),
      vevent('UID:s', 'RECURRENCE-ID:20261207T100000', 'STATUS:CANCELLED', 'DTSTART:20261207T100000', 'DTEND:20261207T110000'),
    ));
    equal(parsed.events.length, 1);
    equal(parsed.events[0].exceptions, {
      '2026-11-16': { cancelled: true },
      '2026-11-23': { cancelled: true },
      '2026-11-30': { date: '2026-12-01', title: 'Seminar (room change)' },
      '2026-12-07': { cancelled: true },
    });
  });

  it('unfolds lines, unescapes text, and ignores alarms inside events', () => {
    const text = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Long ti\n tle\\, with comma\nDTSTART:20261110T100000\nDTEND:20261110T110000\nBEGIN:VALARM\nSUMMARY:Alarm\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR';
    const [event] = parseIcs(text).events;
    equal(event.title, 'Long title, with comma');
  });

  it('refuses a file that is not a calendar', () => {
    equal(parseIcs('hello').ok, false);
    equal(parseIcs(calendar()).events, []);
  });
});

describe('Timetable: storage', () => {
  it('creates, edits, and refuses impossible times', async () => {
    const db = await freshDb();
    const b = db.createBlock({ title: 'German', date: '2026-11-10', start: '18:15', end: '20:00', repeat: { days: [2] } });
    equal(db.listBlocks().length, 1);
    db.updateBlock(b.id, { location: 'Room 1' });
    const space = db.createSpace({ name: 'School' });
    const col = db.createCollection({ name: 'Courses', spaceId: space.id });
    equal(db.createBlock({ date: '2026-11-10', start: '09:00', end: '10:00', collectionId: col.id }).spaceId, space.id, 'a collection brings its space');
    equal(db.getBlock(b.id).location, 'Room 1');
    equal(db.getBlock(b.id).repeat.days, [2], 'the series stays');
    throwsRule(() => db.createBlock({ date: '2026-11-10', start: '12:00', end: '11:00' }));
    throwsRule(() => db.updateBlock(b.id, { end: '18:00' }));
  });

  it('cancels, moves and restores one occurrence, with undo', async () => {
    const db = await freshDb();
    const b = db.createBlock({ title: 'German', date: '2026-11-10', start: '18:15', end: '20:00', repeat: { days: [2] } });
    db.setOccurrence(b.id, '2026-11-17', { cancelled: true });
    const { undo } = db.undoable(() => db.setOccurrence(b.id, '2026-11-24', { start: '17:00', end: '19:00' }));
    const list = occurrencesBetween(db.listBlocks(), '2026-11-16', '2026-11-30');
    equal(list.map((o) => [o.date, o.start, o.cancelled]), [['2026-11-17', '18:15', true], ['2026-11-24', '17:00', false]]);
    undo();
    equal(occurrencesBetween(db.listBlocks(), '2026-11-24', '2026-11-24')[0].start, '18:15');
    db.setOccurrence(b.id, '2026-11-17', null);
    equal(db.getBlock(b.id).exceptions, {});
    throwsRule(() => db.setOccurrence(b.id, '2026-11-24', { end: '17:00' }));
  });

  it('deleting a semester keeps its series ending on the same day', async () => {
    const db = await freshDb();
    const s = db.createSemester({ name: 'Fall', start: '2026-10-01', end: '2027-01-31' });
    const b = db.createBlock({
      title: 'DL', date: '2026-09-01', start: '14:00', end: '16:00', semesterId: s.id, repeat: { days: [2] },
    });
    const before = occurrencesBetween(db.listBlocks(), '2026-09-01', '2027-03-01', { semesters: new Map([[s.id, s]]) }).map((o) => o.date);
    db.deleteSemester(s.id);
    const after = occurrencesBetween(db.listBlocks(), '2026-09-01', '2027-03-01').map((o) => o.date);
    equal(after, before);
    equal(db.getBlock(b.id).repeat.until, '2027-01-31');
    throwsRule(() => db.createSemester({ name: 'Bad', start: '2026-10-01', end: '2026-09-01' }));
  });

  it('survives a backup, and an old backup without a timetable still imports', async () => {
    const db = await freshDb();
    const s = db.createSemester({ name: 'Fall', start: '2026-10-01', end: '2027-01-31' });
    const b = db.createBlock({
      title: 'German', date: '2026-11-10', start: '18:15', end: '20:00', semesterId: s.id, repeat: { days: [2], weeks: 'alternate' },
    });
    db.setOccurrence(b.id, '2026-11-24', { cancelled: true });
    const backup = await buildExport(db);
    const copy = await freshDb();
    const parsed = parseImport(JSON.stringify(backup));
    equal(parsed.summary.timeBlocks, 1);
    await applyImport(copy, parsed.data, 'replace');
    equal(copy.getBlock(b.id), db.getBlock(b.id));
    equal(copy.getSemester(s.id).name, 'Fall');
    const old = { ...backup, data: { ...backup.data } };
    delete old.data.timeBlocks;
    delete old.data.semesters;
    const third = await freshDb();
    const oldParsed = parseImport(JSON.stringify(old));
    assert(oldParsed.ok);
    await applyImport(third, oldParsed.data, 'merge');
    equal(third.listBlocks(), []);
  });

  it('clears links to things that are gone after an import', async () => {
    const db = await freshDb();
    const b = db.createBlock({
      title: 'x', date: '2026-11-10', start: '09:00', end: '10:00', spaceId: 'gone', noteId: 'gone', semesterId: 'gone',
    });
    db.repairIntegrity();
    const fixed = db.getBlock(b.id);
    equal([fixed.spaceId, fixed.noteId, fixed.semesterId], [null, null, '']);
  });

  it('a timetable change does not count as a change to the sidebar', async () => {
    const db = await freshDb();
    const seen = [];
    db.on((change) => seen.push(change.structural));
    db.createBlock({ title: 'x', date: '2026-11-10', start: '09:00', end: '10:00' });
    await db.flush();
    equal(seen.at(-1), false);
  });
});

describe('Google Calendar', () => {
  const TODAY = '2026-11-09';
  const ZONE = 'Europe/Istanbul';

  /** A pretend calendar: records each call, and can be told to fail. */
  function fakeApi(failOn = () => null) {
    const events = new Map();
    const calls = [];
    return {
      events,
      calls,
      async put(id, body) {
        calls.push(['put', id]);
        const failure = failOn('put', id, body);
        if (failure) throw failure;
        events.set(id, body);
      },
      async update(id, body) {
        calls.push(['update', id]);
        const failure = failOn('update', id, body);
        if (failure) throw failure;
        events.set(id, body);
      },
      async remove(id) {
        calls.push(['remove', id]);
        const failure = failOn('remove', id);
        if (failure) throw failure;
        events.delete(id);
      },
    };
  }

  async function dbWith(...lines) {
    const db = await freshDb();
    for (const line of lines) addDailyTask(db, line, TODAY);
    return db;
  }

  const summaries = (api) => [...api.events.values()].map((event) => event.summary);
  const list = (db) => db.listNotes().find((note) => note.title.startsWith('Daily to-dos'));
  const editTask = (db, text, patch) => db.updateTasks(list(db).id, 'items', (items) => updateTask(items, items.find((t) => t.text === text).id, patch));

  it('makes event ids Google accepts, the same every time', () => {
    for (const id of ['abc', '6f1e2d3c-aaaa-bbbb-cccc-0123456789ab', 'görev çok-özel/1', 't1']) {
      const eventId = eventIdFor(id);
      assert(/^[a-v0-9]{5,1024}$/.test(eventId), eventId);
      equal(eventIdFor(id), eventId);
    }
    assert(eventIdFor('t1') !== eventIdFor('t2'));
  });

  it('checks the shape of a Client ID', () => {
    assert(isClientId('123-abc.apps.googleusercontent.com'));
    assert(!isClientId('abc'));
    assert(!isClientId('https://evil.test/x.apps.googleusercontent.com'));
  });

  it('builds an event in the local time zone, half an hour long', () => {
    const body = eventBody({ text: 'Meeting', due: TODAY, time: '15:00', done: false }, ZONE);
    equal(body.summary, 'Meeting');
    equal(body.start, { dateTime: '2026-11-09T15:00:00', timeZone: ZONE });
    equal(body.end, { dateTime: '2026-11-09T15:30:00', timeZone: ZONE });
  });

  it('handles an event that runs past midnight or the end of the hour', () => {
    equal(eventBody({ text: 'x', due: TODAY, time: '23:45' }, ZONE).end.dateTime, '2026-11-10T00:15:00');
    equal(eventBody({ text: 'x', due: TODAY, time: '09:50' }, ZONE).end.dateTime, '2026-11-09T10:20:00');
  });

  it('marks a finished task on its event', () => {
    equal(eventBody({ text: 'Meeting', due: TODAY, time: '15:00', done: true }, ZONE).summary, '✓ Meeting');
  });

  it('only sends tasks with a time, and never from private, archived or trashed notes', async () => {
    const db = await dbWith('15.00 meeting', 'cook dinner');
    const secret = db.createNote({ title: 'Secret', typeId: 'checklist', private: true, fields: { items: [createTask('secret', { due: TODAY, time: '10:00' })] } });
    const shelved = db.createNote({ title: 'Old', typeId: 'checklist', fields: { items: [createTask('shelved', { due: TODAY, time: '11:00' })] } });
    db.archiveNotes([shelved.id]);
    const binned = db.createNote({ title: 'Bin', typeId: 'checklist', fields: { items: [createTask('binned', { due: TODAY, time: '12:00' })] } });
    db.trashNotes([binned.id]);
    assert(db.getNote(secret.id).private, 'the note is private');
    equal(syncableTasks(db).map((task) => task.text), ['Meeting']);
  });

  it('plans: new tasks are created, but not old or finished ones', () => {
    const plan = planSync([
      { id: 'new', text: 'a', due: TODAY, time: '10:00', done: false },
      { id: 'later', text: 'b', due: '2026-11-20', time: '10:00', done: false },
      { id: 'past', text: 'c', due: '2026-11-08', time: '10:00', done: false },
      { id: 'finished', text: 'd', due: TODAY, time: '10:00', done: true },
    ], {}, TODAY);
    equal(plan.create.map((task) => task.id), ['new', 'later']);
    equal(plan.update, []);
    equal(plan.remove, []);
  });

  it('syncs once, then does nothing until something changes', async () => {
    const db = await dbWith('15.00 meeting');
    const api = fakeApi();
    equal((await runSync(db, api, { today: TODAY, timeZone: ZONE })).created, 1);
    equal(summaries(api), ['Meeting']);
    api.calls.length = 0;
    const second = await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(second, {
      created: 0, updated: 0, removed: 0, failed: 0,
    });
    equal(api.calls, []);
  });

  it('updates the event when the task changes or is finished', async () => {
    const db = await dbWith('15.00 meeting');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    editTask(db, 'Meeting', { time: '16:00' });
    equal((await runSync(db, api, { today: TODAY, timeZone: ZONE })).updated, 1);
    equal([...api.events.values()][0].start.dateTime, '2026-11-09T16:00:00');
    editTask(db, 'Meeting', { done: true });
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(summaries(api), ['✓ Meeting']);
    equal(api.events.size, 1, 'the same event, not a copy');
  });

  it('keeps a task that is overdue in step, on its own date', async () => {
    const db = await dbWith('15.00 meeting');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    editTask(db, 'Meeting', { text: 'Renamed' });
    await runSync(db, api, { today: '2026-11-10', timeZone: ZONE });
    equal(summaries(api), ['Renamed']);
  });

  it('removes the event when the task is deleted, loses its time, or its note goes', async () => {
    const db = await dbWith('15.00 one', '16.00 two', '17.00 three');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 3);
    db.updateTasks(list(db).id, 'items', (items) => items.filter((t) => t.text !== 'One'));
    editTask(db, 'Two', { time: '' });
    equal((await runSync(db, api, { today: TODAY, timeZone: ZONE })).removed, 2);
    equal(summaries(api), ['Three']);
    db.trashNotes([list(db).id]);
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 0);
    equal(syncLinks(db), {});
  });

  it('removes the event when a note becomes private', async () => {
    const db = await dbWith('15.00 meeting');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    db.updateNote(list(db).id, { private: true });
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 0);
  });

  it('one failure does not stop the rest, and is tried again next time', async () => {
    const db = await dbWith('15.00 one', '16.00 two');
    let broken = true;
    const api = fakeApi((kind, id, body) => (broken && body?.summary === 'One' ? new CalendarError('No', 500) : null));
    const first = await runSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(first.created, 1);
    equal(first.failed, 1);
    equal(summaries(api), ['Two']);
    broken = false;
    equal((await runSync(db, api, { today: TODAY, timeZone: ZONE })).created, 1);
    equal(api.events.size, 2);
  });

  it('an expired sign-in stops the sync, and keeps what was done', async () => {
    const db = await dbWith('15.00 one', '16.00 two');
    let count = 0;
    const api = fakeApi(() => {
      count += 1;
      return count === 2 ? new CalendarAuthError('Sign in') : null;
    });
    let thrown = null;
    try {
      await runSync(db, api, { today: TODAY, timeZone: ZONE });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof CalendarAuthError, 'it reports the sign-in');
    equal(Object.keys(syncLinks(db)).length, 1);
    api.calls.length = 0;
    await runSync(db, fakeApi(), { today: TODAY, timeZone: ZONE });
    equal(Object.keys(syncLinks(db)).length, 2, 'the rest go next time');
  });

  it('removes everything it added, and only that', async () => {
    const db = await dbWith('15.00 one', '16.00 two');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    api.events.set('someone-elses-event', { summary: 'Not ours' });
    equal(await removeAllEvents(db, api), 0);
    equal(summaries(api), ['Not ours']);
    equal(syncLinks(db), {});
  });

  it('reads events: timed, all-day, and carried over from yesterday', () => {
    const at = (hour, day = 9) => new Date(2026, 10, day, hour, 30).toISOString();
    equal(readEvent({ id: 'a', summary: ' Lunch ', htmlLink: 'https://www.google.com/calendar/event?eid=a', start: { dateTime: at(12) } }, TODAY),
      { id: 'a', text: 'Lunch', time: '12:30', url: 'https://www.google.com/calendar/event?eid=a' });
    equal(readEvent({ id: 'b', summary: 'Holiday', start: { date: TODAY } }, TODAY).time, '');
    equal(readEvent({ id: 'c', summary: 'Trip', start: { dateTime: at(22, 8) } }, TODAY).time, '');
    equal(readEvent({ id: 'd', start: { date: TODAY } }, TODAY).text, 'Busy');
  });

  it('skips cancelled, declined, working location and its own events', () => {
    const base = { id: 'a', summary: 'x', start: { date: TODAY } };
    equal(readEvent({ ...base, status: 'cancelled' }, TODAY), null);
    equal(readEvent({ ...base, eventType: 'workingLocation' }, TODAY), null);
    equal(readEvent({ ...base, attendees: [{ self: true, responseStatus: 'declined' }] }, TODAY), null);
    equal(readEvent({ ...base, extendedProperties: { private: { notesApp: '1' } } }, TODAY), null);
    assert(readEvent({ ...base, attendees: [{ self: true, responseStatus: 'accepted' }, { responseStatus: 'declined' }] }, TODAY));
  });

  it('never keeps a link from Google that is not a web address', () => {
    equal(readEvent({ id: 'a', summary: 'x', htmlLink: 'javascript:alert(1)', start: { date: TODAY } }, TODAY).url, '');
  });

  it('shows events only on their day, and keeps ticks across a refresh', async () => {
    const db = await freshDb();
    const event = { id: 'e1', text: 'Lunch', time: '12:30', url: '' };
    saveEvents(db, TODAY, [event]);
    equal(eventEntries(db, TODAY)[0].item.done, false);
    equal(eventEntries(db, '2026-11-10'), []);
    toggleEventDone(db, 'e1', 123);
    equal(eventEntries(db, TODAY)[0].item.doneAt, 123);
    saveEvents(db, TODAY, [event, { id: 'e2', text: 'Gym', time: '', url: '' }]);
    equal(eventEntries(db, TODAY).map((entry) => entry.item.done), [true, false]);
    toggleEventDone(db, 'e1');
    equal(eventEntries(db, TODAY)[0].item.done, false);
    toggleEventDone(db, 'e1', 5);
    saveEvents(db, '2026-11-10', [event]);
    equal(eventEntries(db, '2026-11-10')[0].item.done, false, 'a new day starts fresh');
  });

  it('sorts events among tasks by time, and they count as due today', async () => {
    const db = await freshDb();
    saveEvents(db, TODAY, [{ id: 'e1', text: 'Lunch', time: '12:30', url: '' }]);
    const tasks = [createTask('morning', { due: TODAY, time: '09:00' }), createTask('afternoon', { due: TODAY, time: '15:00' }), createTask('any time', { due: TODAY })];
    const buckets = agendaBuckets([...flatten(tasks), ...eventEntries(db, TODAY)], TODAY);
    equal(buckets.today.map((entry) => entry.item.text), ['morning', 'Lunch', 'afternoon', 'any time']);
  });

  it('leaves everything about the link out of backups', async () => {
    const db = await dbWith('15.00 meeting');
    updateCalendarConfig(db, { clientId: 'x.apps.googleusercontent.com', on: true });
    await runSync(db, fakeApi(), { today: TODAY, timeZone: ZONE });
    saveEvents(db, TODAY, [{ id: 'e1', text: 'Private lunch', time: '12:30', url: '' }]);
    const backup = JSON.stringify(await buildExport(db));
    for (const word of ['gcal', 'googleusercontent', 'Private lunch']) assert(!backup.includes(word), word);
    const copy = await freshDb();
    await applyImport(copy, parseImport(backup).data, 'replace');
    equal(calendarConfig(copy).on, false, 'a restored backup never turns it on');
  });

  it('a restored backup finds the same event again rather than making a copy', async () => {
    const db = await dbWith('15.00 meeting');
    const api = fakeApi();
    await runSync(db, api, { today: TODAY, timeZone: ZONE });
    const copy = await freshDb();
    await applyImport(copy, parseImport(JSON.stringify(await buildExport(db))).data, 'replace');
    await runSync(copy, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 1);
  });

  const answer = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });

  it('sends the token, and turns a 401 into a sign-in', async () => {
    const seen = [];
    const api = createCalendarApi(() => 'tok', async (url, options) => {
      seen.push(options.headers.Authorization);
      return answer(401);
    });
    let thrown = null;
    try {
      await api.remove('abcde');
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof CalendarAuthError);
    equal(seen, ['Bearer tok']);
  });

  it('an id that exists is updated instead, and brought back if deleted', async () => {
    const calls = [];
    const api = createCalendarApi(() => 't', async (url, options) => {
      calls.push([options.method, url.split('/').pop(), JSON.parse(options.body).status]);
      return options.method === 'POST' ? answer(409) : answer(200, {});
    });
    await api.put('nabc12', eventBody({ text: 'x', due: TODAY, time: '10:00' }, ZONE));
    equal(calls, [['POST', 'events', 'confirmed'], ['PATCH', 'nabc12', 'confirmed']]);
  });

  it('removing an event that is already gone is fine, but other errors are not', async () => {
    const gone = createCalendarApi(() => 't', async () => answer(410));
    await gone.remove('abcde');
    const broken = createCalendarApi(() => 't', async () => answer(500));
    let thrown = null;
    try {
      await broken.remove('abcde');
    } catch (error) {
      thrown = error;
    }
    equal(thrown.status, 500);
  });

  it('reports why Google refused', async () => {
    const api = createCalendarApi(() => 't', async () => answer(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }));
    let thrown = null;
    try {
      await api.listDay(TODAY);
    } catch (error) {
      thrown = error;
    }
    equal(thrown.reason, 'apiOff');
  });

  it('recognises each way Google says an API is off, a box was unticked or a limit was hit', () => {
    const disabled = {
      error: {
        code: 403,
        message: 'Google Drive API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123456 then retry.',
        errors: [{ message: 'Google Drive API has not been used…', domain: 'usageLimits', reason: 'accessNotConfigured' }],
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
      },
    };
    equal(googleErrorReason(disabled), 'apiOff');
    equal(googleErrorReason({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }), 'apiOff');
    equal(googleErrorReason({ error: { code: 403, message: 'Google Calendar API has not been used in project 9 before or it is disabled.' } }), 'apiOff');
    equal(googleErrorReason({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'scope');
    equal(googleErrorReason({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }), 'rateLimit');
    equal(googleErrorReason({ error: { code: 403, errors: [{ reason: 'appNotAuthorizedToFile' }] } }), 'appNotAuthorizedToFile');
    equal(googleErrorReason({}), '');
    equal(googleErrorReason(null), '');
  });

  it('asks for exactly one local day of events', async () => {
    let asked = null;
    const api = createCalendarApi(() => 't', async (url) => {
      asked = new URL(url);
      return answer(200, { items: [{ id: 'a', summary: 'Lunch', start: { date: TODAY } }, { id: 'b', status: 'cancelled', start: { date: TODAY } }] });
    });
    equal((await api.listDay(TODAY)).map((event) => event.text), ['Lunch']);
    equal(new Date(asked.searchParams.get('timeMin')).getTime(), new Date(2026, 10, 9).getTime());
    equal(new Date(asked.searchParams.get('timeMax')).getTime(), new Date(2026, 10, 10).getTime());
    equal(asked.searchParams.get('singleEvents'), 'true');
  });
});

describe('Google Calendar and the timetable', () => {
  const TODAY = '2026-11-11'; // a Wednesday
  const ZONE = 'Europe/Berlin';

  function fakeApi(failOn = () => null) {
    const events = new Map();
    const calls = [];
    return {
      events,
      calls,
      async put(id, body) {
        calls.push(['put', id]);
        const failure = failOn('put', id, body, calls.length);
        if (failure) throw failure;
        events.set(id, body);
      },
      async update(id, body) {
        calls.push(['update', id]);
        const failure = failOn('update', id, body, calls.length);
        if (failure) throw failure;
        events.set(id, body);
      },
      async remove(id) {
        calls.push(['remove', id]);
        events.delete(id);
      },
    };
  }

  async function withLecture() {
    const db = await freshDb();
    const block = db.createBlock({
      title: 'Lecture', date: '2026-11-09', start: '10:00', end: '12:00', repeat: { days: [1] }, location: 'Room 1', reminder: 15,
    });
    return { db, block };
  }

  const dates = (api) => [...api.events.values()].map((e) => e.start.dateTime.slice(0, 10)).sort();

  it('makes event ids Google accepts, never the same as a task’s', () => {
    const id = blockEventId('6f1e2d3c-aaaa:2026-11-09');
    assert(/^[a-v0-9]{5,1024}$/.test(id), id);
    equal(blockEventId('6f1e2d3c-aaaa:2026-11-09'), id);
    assert(id !== eventIdFor('6f1e2d3c-aaaa:2026-11-09'));
  });

  it('keeps this week and the next eight in the calendar', () => {
    equal(blockWindow(TODAY), { from: '2026-11-09', to: '2027-01-06' });
  });

  it('sends each class in the window as its own event, with its place and reminder', async () => {
    const { db } = await withLecture();
    const api = fakeApi();
    const result = await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(result.created, 9);
    equal(dates(api), ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28', '2027-01-04']);
    const first = [...api.events.values()].find((e) => e.start.dateTime.startsWith('2026-11-09'));
    equal(first.summary, 'Lecture');
    equal(first.location, 'Room 1');
    equal(first.start, { dateTime: '2026-11-09T10:00:00', timeZone: ZONE });
    equal(first.end, { dateTime: '2026-11-09T12:00:00', timeZone: ZONE });
    equal(first.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] });
    equal(first.extendedProperties.private.notesApp, '1');
  });

  it('a block without a reminder gets none in the calendar either', () => {
    equal(blockEventBody({ title: 'x', date: TODAY, start: '09:00', end: '10:00', location: '', reminder: null }, ZONE).reminders, { useDefault: false, overrides: [] });
  });

  it('sends nothing when nothing changed', async () => {
    const { db } = await withLecture();
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    api.calls.length = 0;
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.calls, []);
  });

  it('follows a renamed series, a cancelled class and a moved one', async () => {
    const { db, block } = await withLecture();
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    db.updateBlock(block.id, { title: 'Deep Learning' });
    db.setOccurrence(block.id, '2026-11-16', { cancelled: true });
    db.setOccurrence(block.id, '2026-11-23', { date: '2026-11-24', start: '14:00', end: '16:00' });
    api.calls.length = 0;
    const result = await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(result.removed, 1, 'the cancelled one');
    equal(result.updated, 8);
    assert(!dates(api).includes('2026-11-16'));
    const moved = api.events.get(blockEventId(`${block.id}:2026-11-23`));
    equal(moved.start.dateTime, '2026-11-24T14:00:00');
    assert([...api.events.values()].every((e) => e.summary === 'Deep Learning'));
  });

  it('moves the window on as days go by, and leaves past classes in the calendar', async () => {
    const { db } = await withLecture();
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    const result = await runBlockSync(db, api, { today: '2026-11-25', timeZone: ZONE });
    equal(result.created, 2);
    equal(result.removed, 0);
    assert(dates(api).includes('2026-11-09') && dates(api).includes('2027-01-18'));
    equal(Object.keys(blockLinks(db)).length, 9, 'past ones are forgotten, not deleted');
  });

  it('removes a deleted block, and everything when sending is turned off', async () => {
    const { db } = await withLecture();
    const one = db.createBlock({ title: 'Dentist', date: '2026-11-12', start: '08:00', end: '09:00' });
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 10);
    db.deleteBlock(one.id);
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    equal(api.events.size, 9);
    api.events.set('mine', { summary: 'Not from the app' });
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE, send: false });
    equal([...api.events.keys()], ['mine']);
    equal(blockLinks(db), {});
  });

  it('uses the title it is given, for a block that is a task', async () => {
    const { db } = await withLecture();
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE, titleFor: () => '✓ Read chapter 3' });
    assert([...api.events.values()].every((e) => e.summary === '✓ Read chapter 3'));
  });

  it('stops when Google asks to slow down, keeping what was done, and carries on next time', async () => {
    const { db } = await withLecture();
    const slow = new CalendarError('Google Calendar answered 403', 403, 'rateLimit');
    const api = fakeApi((kind, id, body, count) => (count > 3 ? slow : null));
    let thrown = null;
    try {
      await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    } catch (error) {
      thrown = error;
    }
    equal(thrown, slow);
    equal(Object.keys(blockLinks(db)).length, 3);
    const result = await runBlockSync(db, fakeApi(), { today: TODAY, timeZone: ZONE });
    equal(result.created, 6);
  });

  it('removes every block event it added', async () => {
    const { db } = await withLecture();
    const api = fakeApi();
    await runBlockSync(db, api, { today: TODAY, timeZone: ZONE });
    api.events.set('mine', {});
    equal(await removeAllBlockEvents(db, api), 0);
    equal([...api.events.keys()], ['mine']);
  });

  it('leaves out a task that has a block, so it isn’t in the calendar twice', async () => {
    const db = await freshDb();
    addDailyTask(db, '15.00 write essay', TODAY);
    addDailyTask(db, '16.00 call mum', TODAY);
    const essay = syncableTasks(db).find((t) => t.text === 'Write essay');
    equal(syncableTasks(db, new Set([essay.id])).map((t) => t.text), ['Call mum']);
  });

  // -- Reading events --------------------------------------------------------------------

  const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

  it('reads timed events in local time', () => {
    const pieces = readRangeEvents([
      { id: 'a', summary: ' Gym ', htmlLink: 'https://calendar.google.com/x', start: { dateTime: at(10, 18) }, end: { dateTime: at(10, 19, 30) } },
    ], '2026-11-09', '2026-11-15');
    equal(pieces, [{
      id: 'a', title: 'Gym', url: 'https://calendar.google.com/x', key: 'event:a:2026-11-10', date: '2026-11-10', start: '18:00', end: '19:30', allDay: false,
    }]);
  });

  it('splits an event that runs past midnight, and one that ends at midnight stays on its day', () => {
    const late = readRangeEvents([{ id: 'p', summary: 'Party', start: { dateTime: at(13, 22) }, end: { dateTime: at(14, 2) } }], '2026-11-09', '2026-11-15');
    equal(late.map((p) => [p.date, p.start, p.end]), [['2026-11-13', '22:00', '23:59'], ['2026-11-14', '00:00', '02:00']]);
    const midnight = readRangeEvents([{ id: 'm', start: { dateTime: at(12, 23) }, end: { dateTime: at(13, 0) } }], '2026-11-09', '2026-11-15');
    equal(midnight.map((p) => [p.date, p.start, p.end, p.title]), [['2026-11-12', '23:00', '23:59', 'Busy']]);
  });

  it('gives an event with no length a quarter of an hour, so it can be seen', () => {
    const pieces = readRangeEvents([{ id: 'z', start: { dateTime: at(10, 9) }, end: { dateTime: at(10, 9) } }], '2026-11-09', '2026-11-15');
    equal(pieces.map((p) => [p.start, p.end]), [['09:00', '09:15']]);
  });

  it('reads all-day events, several days long, only within the range', () => {
    const pieces = readRangeEvents([{ id: 'h', summary: 'Holiday', start: { date: '2026-11-07' }, end: { date: '2026-11-11' } }], '2026-11-09', '2026-11-15');
    equal(pieces.map((p) => [p.date, p.allDay]), [['2026-11-09', true], ['2026-11-10', true]]);
  });

  it('skips its own events, cancelled and declined ones, and unsafe links', () => {
    const base = { summary: 'x', start: { dateTime: at(10, 9) }, end: { dateTime: at(10, 10) } };
    const pieces = readRangeEvents([
      { ...base, id: 'own', extendedProperties: { private: { notesApp: '1' } } },
      { ...base, id: 'gone', status: 'cancelled' },
      { ...base, id: 'no', attendees: [{ self: true, responseStatus: 'declined' }] },
      { ...base, id: 'where', eventType: 'workingLocation' },
      { ...base, id: 'ok', htmlLink: 'javascript:alert(1)' },
    ], '2026-11-09', '2026-11-15');
    equal(pieces.map((p) => [p.id, p.url]), [['ok', '']]);
  });

  it('keeps weeks of events, newest twelve, and finds them by date', async () => {
    const db = await freshDb();
    const piece = (id, date) => ({ id, key: `event:${id}:${date}`, date, start: '09:00', end: '10:00', allDay: false, title: id, url: '' });
    saveWeekEvents(db, '2026-11-09', [piece('a', '2026-11-10'), piece('b', '2026-11-12')], 1);
    saveWeekEvents(db, '2026-11-16', [piece('c', '2026-11-17')], 2);
    equal(weekEvents(db, '2026-11-09', '2026-11-15').map((p) => p.id), ['a', 'b']);
    equal(weekEvents(db, '2026-11-12', '2026-11-17').map((p) => p.id), ['b', 'c']);
    saveWeekEvents(db, '2026-11-09', [piece('a', '2026-11-10')], 3);
    equal(weekEvents(db, '2026-11-09', '2026-11-15').map((p) => p.id), ['a'], 'a fresh read replaces the week');
    for (let i = 0; i < 14; i += 1) saveWeekEvents(db, `2027-0${1 + Math.floor(i / 5)}-0${1 + (i % 5)}`, [], 10 + i);
    equal(weekEvents(db, '2026-11-01', '2026-11-30'), [], 'the oldest weeks are forgotten');
    saveWeekEvents(db, '2026-11-09', [piece('a', '2026-11-10')], 99);
    equal(weekEventEntries(db, '2026-11-09', '2026-11-15', '2026-11-11').map((e) => [e.item.text, e.item.time, e.isEvent]), [['a', '09:00', true]]);
    equal(weekEventEntries(db, '2026-11-09', '2026-11-15', '2026-11-10'), [], 'today’s come from the Today page’s copy');
    clearWeekEvents(db);
    equal(weekEvents(db, '2026-11-01', '2027-12-31'), []);
  });

  it('updates an event directly, and makes it again if it was deleted for good', async () => {
    const seen = [];
    const answer = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });
    let gone = false;
    const api = createCalendarApi(() => 't', async (url, options) => {
      seen.push(options.method);
      if (options.method === 'PATCH') return gone ? answer(404, { error: { code: 404 } }) : answer(200, {});
      return answer(200, {});
    });
    await api.update('b1234', { summary: 'x' });
    equal(seen, ['PATCH'], 'one request, no failed create first');
    gone = true;
    await api.update('b1234', { summary: 'x' });
    equal(seen, ['PATCH', 'PATCH', 'POST']);
  });

  it('reads a range of events across pages', async () => {
    const asked = [];
    const answer = (body) => ({ ok: true, status: 200, json: async () => body });
    const api = createCalendarApi(() => 't', async (url) => {
      const u = new URL(url);
      asked.push(u);
      return answer(u.searchParams.get('pageToken') ? { items: [{ id: 'b' }] } : { items: [{ id: 'a' }], nextPageToken: 'next' });
    });
    equal((await api.listRange('2026-11-09', '2026-11-15')).map((e) => e.id), ['a', 'b']);
    equal(asked.length, 2);
    equal(new Date(asked[0].searchParams.get('timeMin')).getDate(), 9);
    equal(new Date(asked[0].searchParams.get('timeMax')).getDate(), 16);
    assert(asked[0].searchParams.get('fields').includes('extendedProperties/private'));
  });

  it('starts with the timetable sent and events shown, once connected', async () => {
    const db = await freshDb();
    const config = calendarConfig(db);
    equal([config.blocks, config.showEvents], [true, true]);
  });
});

describe('Reading messy task text', () => {
  const TODAY = '2026-11-09'; // A Monday.
  const read = (line) => parseTaskLine(line, TODAY);
  const reads = (line, text, time, due = TODAY) => equal(read(line), { text, time, due }, line);

  it('reads the example from the request', () => {
    equal(parseTaskList('15.00 project meeting\ncook dineer', TODAY), [
      { text: 'Project meeting', time: '15:00', due: TODAY },
      { text: 'Cook dineer', time: '', due: TODAY },
    ]);
  });

  it('reads each way of writing a time', () => {
    reads('15:00 project meeting', 'Project meeting', '15:00');
    reads('project meeting 15.00', 'Project meeting', '15:00');
    reads('project meeting at 15.00', 'Project meeting', '15:00');
    reads('meeting at 15.00 with Ana', 'Meeting with Ana', '15:00');
    reads('9.30 standup', 'Standup', '09:30');
    reads('call mum 3pm', 'Call mum', '15:00');
    reads('3:30 pm call', 'Call', '15:30');
    reads('call @ 3.30pm', 'Call', '15:30');
    reads('call mum at 3', 'Call mum', '15:00');
    reads('walk at 8', 'Walk', '08:00');
    reads('gym at 18', 'Gym', '18:00');
  });

  it('gets midnight and noon right', () => {
    reads('12am backup', 'Backup', '00:00');
    reads('12pm lunch', 'Lunch', '12:00');
  });

  it('keeps the start of a time range', () => {
    reads('15.00-16.00 meeting', 'Meeting', '15:00');
    reads('15:00 – 16:00 meeting', 'Meeting', '15:00');
  });

  it('leaves numbers that are not clearly times', () => {
    reads('read chapter 3.10', 'Read chapter 3.10', '');
    reads('buy milk 2.50', 'Buy milk 2.50', '');
    reads('look at 3 files', 'Look at 3 files', '');
    reads('15.11.2026 dentist', '15.11.2026 dentist', '');
    reads('pay 25:00 fee', 'Pay 25:00 fee', '');
    reads('13pm thing', '13pm thing', '');
    reads('call 555.1234', 'Call 555.1234', '');
    reads('see http://site.test:80', 'See http://site.test:80', '');
  });

  it('reads days at the start or end of a line', () => {
    reads('tomorrow dentist', 'Dentist', '', '2026-11-10');
    reads('dentist tomorrow', 'Dentist', '', '2026-11-10');
    reads('dentist on friday', 'Dentist', '', '2026-11-13');
    reads('Friday: pay rent', 'Pay rent', '', '2026-11-13');
    reads('report by wednesday', 'Report', '', '2026-11-11');
    reads('dentist tonight', 'Dentist', '');
  });

  it('a weekday is always ahead, never today', () => {
    reads('dentist monday', 'Dentist', '', '2026-11-16');
    reads('dentist sunday', 'Dentist', '', '2026-11-15');
  });

  it('leaves a day inside a title alone', () => {
    reads('watch Friday night lights', 'Watch Friday night lights', '');
    reads('watching tomorrowland', 'Watching tomorrowland', '');
  });

  it('reads a day and a time together, in any order', () => {
    reads('dentist friday at 10:30', 'Dentist', '10:30', '2026-11-13');
    reads('tomorrow 15.00 dentist', 'Dentist', '15:00', '2026-11-10');
    reads('15.00 tomorrow dentist', 'Dentist', '15:00', '2026-11-10');
    reads('meeting 15.00 tomorrow', 'Meeting', '15:00', '2026-11-10');
    reads('meeting at 3 tomorrow', 'Meeting', '15:00', '2026-11-10');
  });

  it('keeps a line that was only a time or a day', () => {
    reads('15.00', '15.00', '');
    reads('tomorrow', 'Tomorrow', '');
  });

  it('removes list markers and stray punctuation', () => {
    reads('- buy milk', 'Buy milk', '');
    reads('* buy milk', 'Buy milk', '');
    reads('• buy milk', 'Buy milk', '');
    reads('1. buy milk', 'Buy milk', '');
    reads('2) buy milk', 'Buy milk', '');
    reads('- [ ] buy milk', 'Buy milk', '');
    reads('[x] buy milk', 'Buy milk', '');
    reads('  15.00 - meeting,  ', 'Meeting', '15:00');
    reads('call   mum', 'Call mum', '');
  });

  it('skips blank lines and sorts by day, then time, with timed tasks first', () => {
    const list = parseTaskList('cook dinner\n\n   \n16.00 gym\r\ndentist tomorrow\n09.00 standup\ntomorrow 08.00 run', TODAY);
    equal(list.map((task) => task.text), ['Standup', 'Gym', 'Cook dinner', 'Run', 'Dentist']);
    equal(parseTaskList('  \n\n', TODAY), []);
  });

  it('keeps the order written when nothing separates two tasks', () => {
    equal(parseTaskList('b\na\nc', TODAY).map((task) => task.text), ['B', 'A', 'C']);
  });
});

describe('Task times', () => {
  it('sort within a day, timed tasks first, ahead of priority', () => {
    const today = '2026-11-09';
    const items = [
      createTask('no time, urgent', { due: today, priority: 3 }),
      createTask('late', { due: today, time: '16:00' }),
      createTask('early', { due: today, time: '09:00' }),
      createTask('no time', { due: today }),
    ];
    equal(agendaBuckets(flatten(items), today).today.map((e) => e.item.text), ['early', 'late', 'no time, urgent', 'no time']);
  });

  it('are kept when valid, and dropped when invalid or with no date', () => {
    const clean = (props) => normalizeTasks([{ id: 'a', text: 'x', ...props }])[0].time;
    equal(clean({ due: '2026-11-09', time: '15:00' }), '15:00');
    equal(clean({ due: '2026-11-09', time: '25:00' }), '');
    equal(clean({ due: '2026-11-09', time: 15 }), '');
    equal(clean({ time: '15:00' }), '');
    equal(clean({ due: '2026-11-09' }), '', 'tasks saved before times existed');
  });

  it('stay with a repeating task when it moves to its next date', () => {
    const task = createTask('standup', { due: '2026-11-09', time: '09:30', repeat: 'daily' });
    const [next] = toggleTask([task], task.id, { today: '2026-11-09' });
    equal(next.due, '2026-11-10');
    equal(next.time, '09:30');
  });

  it('survive a backup and appear in Markdown', async () => {
    const db = await freshDb();
    addDailyTask(db, '15.00 project meeting', '2026-11-09');
    const copy = await freshDb();
    await applyImport(copy, parseImport(JSON.stringify(await buildExport(db))).data, 'replace');
    const note = copy.listNotes().find((n) => n.title.startsWith('Daily to-dos'));
    equal(note.fields.items[0].time, '15:00');
    assert(noteToMarkdown(note, copy).includes('due 2026-11-09 15:00'), noteToMarkdown(note, copy));
  });
});

describe('Daily to-do list', () => {
  it('adds a messy line with its time and day', async () => {
    const db = await freshDb();
    const task = addDailyTask(db, 'dentist friday at 10:30', '2026-11-09');
    equal(task.text, 'Dentist');
    equal(task.time, '10:30');
    equal(task.due, '2026-11-13');
  });

  it('adds a whole list in one step, and one undo takes it all back', async () => {
    const db = await freshDb();
    const { undo } = db.undoable(() => addDailyTasks(db, [
      { text: 'One', time: '15:00', due: '2026-11-09' },
      { text: '  ', time: '', due: '2026-11-09' },
      { text: 'Two', time: '', due: '' },
    ], '2026-11-09'));
    const [note] = db.listNotes().filter((n) => n.title.startsWith('Daily to-dos'));
    equal(note.fields.items.map((t) => [t.text, t.time, t.due]), [['One', '15:00', '2026-11-09'], ['Two', '', '2026-11-09']]);
    undo();
    equal(db.listNotes().filter((n) => n.title.startsWith('Daily to-dos')).length, 0);
  });

  const listed = (db, noteId) => db.getNote(noteId).fields.items.map((task) => task.text);
  const dailyNotes = (db) => db.listNotes().filter((note) => note.title.startsWith('Daily to-dos'));

  it('adds tasks due today to one list, kept in a to-do collection', async () => {
    const db = await freshDb();
    const space = db.createSpace({ name: 'Personal' });
    db.createCollection({ name: 'Assignments', spaceId: space.id, defaultTypeId: 'checklist' });
    const todos = db.createCollection({ name: 'To-dos', spaceId: space.id, defaultTypeId: 'checklist' });
    const first = addDailyTask(db, '  Call the dentist  ', '2026-11-08');
    addDailyTask(db, 'Buy milk', '2026-11-09');
    equal(first.text, 'Call the dentist');
    equal(first.due, '2026-11-08');
    const notes = dailyNotes(db);
    equal(notes.length, 1);
    equal(notes[0].collectionId, todos.id);
    equal(notes[0].typeId, 'checklist');
    equal(listed(db, notes[0].id), ['Call the dentist', 'Buy milk']);
  });

  it('ignores blank text', async () => {
    const db = await freshDb();
    equal(addDailyTask(db, '   ', '2026-11-08'), null);
    equal(dailyNotes(db).length, 0);
  });

  it('never leaves the list in the Inbox when there is a space to put it in', async () => {
    const db = await freshDb();
    const space = db.createSpace({ name: 'Personal' });
    addDailyTask(db, 'One', '2026-11-08');
    equal(dailyNotes(db)[0].spaceId, space.id);
  });

  it('still works with no spaces at all', async () => {
    const db = await freshDb();
    addDailyTask(db, 'One', '2026-11-08');
    equal(dailyNotes(db)[0].spaceId, null);
  });

  it('starts a new list each month, and unfinished tasks carry over as overdue', async () => {
    const db = await freshDb();
    addDailyTask(db, 'From October', '2026-10-31');
    addDailyTask(db, 'From November', '2026-11-01');
    equal(dailyNotes(db).length, 2);
    const entries = dailyNotes(db).flatMap((note) => flatten(note.fields.items));
    const buckets = agendaBuckets(entries, '2026-11-01');
    equal(buckets.overdue.map((entry) => entry.item.text), ['From October']);
    equal(buckets.today.map((entry) => entry.item.text), ['From November']);
  });

  it('keeps using a list that was renamed', async () => {
    const db = await freshDb();
    addDailyTask(db, 'One', '2026-11-08');
    const [note] = dailyNotes(db);
    db.updateNote(note.id, { title: 'My list' });
    addDailyTask(db, 'Two', '2026-11-08');
    equal(listed(db, note.id), ['One', 'Two']);
    equal(dailyNotes(db).length, 0);
  });

  it('starts a new list rather than adding to one in Trash or Archive', async () => {
    const db = await freshDb();
    addDailyTask(db, 'One', '2026-11-08');
    const [trashed] = dailyNotes(db);
    db.trashNotes([trashed.id]);
    addDailyTask(db, 'Two', '2026-11-08');
    const [next] = dailyNotes(db);
    assert(next.id !== trashed.id, 'a new note');
    equal(listed(db, next.id), ['Two']);
    equal(listed(db, trashed.id), ['One'], 'the trashed note is untouched');
  });

  it('finds the list by its title after a restore, when the pointer is gone', async () => {
    const db = await freshDb();
    addDailyTask(db, 'One', '2026-11-08');
    const copy = await freshDb();
    const backup = await buildExport(db);
    await applyImport(copy, parseImport(JSON.stringify(backup)).data, 'replace');
    addDailyTask(copy, 'Two', '2026-11-08');
    equal(dailyNotes(copy).length, 1);
    equal(listed(copy, dailyNotes(copy)[0].id), ['One', 'Two']);
  });

  it('undo takes away a task added to a new list, note included', async () => {
    const db = await freshDb();
    const { undo } = db.undoable(() => addDailyTask(db, 'One', '2026-11-08'));
    equal(dailyNotes(db).length, 1);
    undo();
    equal(dailyNotes(db).length, 0);
    addDailyTask(db, 'Two', '2026-11-08');
    equal(listed(db, dailyNotes(db)[0].id), ['Two']);
  });
});

describe('Tasks', () => {
  const today = '2026-05-10';
  const list = (...texts) => texts.map((text) => createTask(text));

  it('rebuilds task lists from damaged data', () => {
    const clean = normalizeTasks([
      { id: 'a', text: 'ok', due: 'nonsense', priority: 9, repeat: 'hourly', done: 'yes', children: 'x' },
      'junk',
      null,
      { id: 'a', text: 'duplicate id' },
      { text: 'no id' },
    ]);
    equal(clean.length, 3);
    equal([clean[0].due, clean[0].priority, clean[0].repeat, clean[0].done, clean[0].children], ['', 0, null, false, []]);
    assert(clean[1].id !== 'a', 'duplicate id replaced');
    assert(clean[2].id, 'missing id added');
  });

  it('keeps tasks nested too deeply, one level up', () => {
    const clean = normalizeTasks([{ id: 'a', text: 'a', children: [{ id: 'b', text: 'b', children: [{ id: 'c', text: 'c' }] }] }]);
    equal(flatten(clean).map(({ item }) => item.text), ['a', 'b', 'c']);
    assert(flatten(clean).every(({ item }) => !item.children.length || item.id === 'a'));
  });

  it('adds, updates and removes', () => {
    const [a, b] = list('a', 'b');
    let items = [a];
    items = insertTaskAfter(items, a.id, b);
    equal(items.map((t) => t.text), ['a', 'b']);
    items = updateTask(items, b.id, { text: 'B' });
    equal(locate(items, b.id).item.text, 'B');
    items = removeTask(items, a.id);
    equal(items.map((t) => t.text), ['B']);
  });

  it('never changes the list it was given', () => {
    const [a] = list('a');
    const items = [a];
    toggleTask(items, a.id, { today });
    assert(!items[0].done);
    equal(items.length, 1);
  });

  it('indents under the task above, one level deep only', () => {
    const [a, b, c] = list('a', 'b', 'c');
    let items = [a, b, c];
    equal(indentTask(items, a.id), items, 'first task stays');
    items = indentTask(items, b.id);
    equal(items.map((t) => t.text), ['a', 'c']);
    equal(items[0].children.map((t) => t.text), ['b']);
    equal(indentTask(items, b.id), items, 'a subtask cannot go deeper');
    const withKids = [createTask('x'), { ...createTask('y'), children: [createTask('z')] }];
    equal(indentTask(withKids, withKids[1].id), withKids, 'a task with subtasks stays at the top');
  });

  it('outdents to just after the parent', () => {
    const [a, b, c] = list('a', 'b', 'c');
    let items = addSubtask([a, c], a.id, b);
    items = outdentTask(items, b.id);
    equal(items.map((t) => t.text), ['a', 'b', 'c']);
  });

  it('reorders by dragging and with the keyboard', () => {
    const [a, b, c] = list('a', 'b', 'c');
    let items = [a, b, c];
    items = moveRelative(items, c.id, a.id, 'before');
    equal(items.map((t) => t.text), ['c', 'a', 'b']);
    items = moveRelative(items, c.id, b.id, 'after');
    equal(items.map((t) => t.text), ['a', 'b', 'c']);
    items = shiftTask(items, c.id, -1);
    equal(items.map((t) => t.text), ['a', 'c', 'b']);
    equal(shiftTask(items, a.id, -1).map((t) => t.text), ['a', 'c', 'b'], 'already first');
  });

  it('a task with subtasks stays top-level when dropped among subtasks', () => {
    const child = createTask('child');
    const parent = { ...createTask('parent'), children: [child] };
    const other = { ...createTask('other'), children: [createTask('kid')] };
    const items = moveRelative([parent, other], other.id, child.id, 'before');
    equal(items.map((t) => t.text), ['other', 'parent']);
    equal(moveRelative([parent], parent.id, child.id, 'after').map((t) => t.text), ['parent'], 'not into its own subtask');
  });

  it('ticking a task ticks its subtasks, unticking a subtask unticks the parent', () => {
    const child = createTask('child');
    const parent = { ...createTask('parent'), children: [child] };
    let items = toggleTask([parent], parent.id, { today, now: 5 });
    assert(items[0].done);
    assert(items[0].children[0].done);
    equal(items[0].doneAt, 5);
    items = toggleTask(items, child.id, { today });
    assert(!items[0].done, 'parent reopened');
    assert(!items[0].children[0].done);
    equal(items[0].doneAt, null);
  });

  it('a repeating task moves to its next date instead of finishing', () => {
    const daily = createTask('water', { repeat: 'daily', due: today });
    const after = toggleTask([daily], daily.id, { today, now: 99 })[0];
    assert(!after.done);
    equal(after.due, '2026-05-11');
    equal(after.history, [99]);
    equal(after.lastDoneAt, 99);
  });

  it('a late repeating task jumps past today', () => {
    equal(nextOccurrence({ repeat: 'daily', due: '2026-05-01' }, today), '2026-05-11');
    equal(nextOccurrence({ repeat: 'weekly', due: '2026-05-05' }, today), '2026-05-12');
  });

  it('a repeating task done early still moves to the next date after its due date', () => {
    equal(nextOccurrence({ repeat: 'weekly', due: '2026-05-20' }, today), '2026-05-27');
  });

  it('a monthly task keeps its day of the month through short months', () => {
    let task = createTask('rent', { repeat: 'monthly', due: '2026-01-31' });
    task = toggleTask([task], task.id, { today: '2026-01-31' })[0];
    equal(task.due, '2026-02-28');
    task = toggleTask([task], task.id, { today: '2026-02-28' })[0];
    equal(task.due, '2026-03-31', 'back to the 31st');
  });

  it('repeating resets subtasks', () => {
    const task = { ...createTask('r', { repeat: 'daily', due: today }), children: [createTask('sub', { done: true, doneAt: 1 })] };
    const after = toggleTask([task], task.id, { today })[0];
    assert(!after.children[0].done);
  });

  it('progress counts subtasks instead of their parent', () => {
    const items = [
      createTask('a', { done: true }),
      createTask('b'),
      { ...createTask('c'), children: [createTask('d', { done: true }), createTask('e')] },
    ];
    equal(progress(items), { done: 2, total: 4, ratio: 0.5 });
    equal(progress([]), { done: 0, total: 0, ratio: 0 });
  });

  it('sorts tasks into Today, Upcoming, Overdue and Done', () => {
    const items = [
      createTask('no date'),
      createTask('today', { due: today }),
      createTask('late', { due: '2026-05-01' }),
      createTask('later', { due: '2026-06-01' }),
      createTask('soon', { due: '2026-05-11', priority: 1 }),
      createTask('soon, urgent', { due: '2026-05-11', priority: 3 }),
      createTask('finished', { due: '2026-05-01', done: true, doneAt: 3 }),
    ];
    const buckets = agendaBuckets(flatten(items), today);
    const names = (key) => buckets[key].map((e) => e.item.text);
    equal(names('today'), ['today']);
    equal(names('overdue'), ['late']);
    equal(names('upcoming'), ['soon, urgent', 'soon', 'later']);
    equal(names('done'), ['finished']);
  });

  it('finds the earliest open due date', () => {
    equal(earliestDue([createTask('a', { due: '2026-06-01' }), createTask('b', { due: '2026-05-01', done: true }), createTask('c', { due: '2026-05-20' })]), '2026-05-20');
    equal(earliestDue([createTask('a')]), '');
  });
});

describe('Note types', () => {
  it('every built-in type uses known kinds and unique field ids', () => {
    for (const type of BUILTIN_TYPES) {
      const ids = type.fields.map((f) => f.id);
      equal(new Set(ids).size, ids.length, `${type.id} field ids`);
      assert(viewsFor(type).includes(type.defaultView), `${type.id} default view ${type.defaultView}`);
      equal(cleanType({ ...type, id: 'x' }).fields.length, type.fields.length, `${type.id} fields survive cleaning`);
    }
  });

  it('every default collection in the setup data names a real type', async () => {
    const { spaces } = await (await fetch('data/defaults.json')).json();
    const known = new Set(BUILTIN_TYPES.map((t) => t.id));
    for (const space of spaces) {
      for (const col of space.collections) {
        assert(known.has(col.defaultTypeId), col.defaultTypeId);
        for (const child of col.children ?? []) assert(known.has(child.defaultTypeId), child.defaultTypeId);
      }
    }
  });

  it('a note in a collection gets that collection\'s type and starting values', async () => {
    const db = await freshDb();
    const space = db.createSpace({ name: 'Fun' });
    const col = db.createCollection({ name: 'Movies', spaceId: space.id, defaultTypeId: 'watchlist' });
    const note = db.createNote({ title: 'Heat', collectionId: col.id });
    equal(note.typeId, 'watchlist');
    equal(note.fields.status, 'To watch');
    equal(note.fields.mediaKind, 'Movie');
    equal(note.fields.genres, []);
  });

  it('a type that does not exist falls back to Free note', async () => {
    const db = await freshDb();
    const space = db.createSpace({ name: 'S' });
    const col = db.createCollection({ name: 'C', spaceId: space.id, defaultTypeId: 'gone' });
    equal(db.createNote({ collectionId: col.id }).typeId, 'free');
    equal(db.getType('gone').id, 'free');
  });

  it('a journal entry is private, dated today and titled from the date', async () => {
    const db = await freshDb();
    const note = db.createNote({ typeId: 'journal' });
    assert(note.private);
    equal(note.fields.date, toDateStr());
    equal(note.title, autoTitleFor(db.getType('journal'), note.fields));
    assert(note.title.length > 5);
  });

  it('changing type keeps values, and changing back restores them', async () => {
    const db = await freshDb();
    const note = db.createNote({ typeId: 'watchlist', title: 'Heat', fields: { rating: 5, review: 'Great' } });
    db.setNoteType(note.id, 'checklist');
    equal(db.getNote(note.id).fields.items, []);
    db.setNoteType(note.id, 'watchlist');
    const back = db.getNote(note.id);
    equal([back.fields.rating, back.fields.review, back.title], [5, 'Great', 'Heat']);
  });

  it('privacy follows the type when it changes', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'x' });
    assert(!note.private);
    db.setNoteType(note.id, 'journal');
    assert(db.getNote(note.id).private);
    db.setNoteType(note.id, 'free');
    assert(!db.getNote(note.id).private);
  });

  it('keeps a note private if it was made private by hand', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'x' });
    db.updateNote(note.id, { private: true });
    db.setNoteType(note.id, 'checklist');
    assert(db.getNote(note.id).private);
  });

  it('filing from the Inbox applies the type, its values and its privacy', async () => {
    const db = await freshDb();
    const space = db.createSpace({ name: 'Fun' });
    const col = db.createCollection({ name: 'Journal', spaceId: space.id, defaultTypeId: 'journal' });
    const a = db.createNote({ title: 'A thought' });
    db.fileNote(a.id, { collectionId: col.id });
    const filed = db.getNote(a.id);
    equal(filed.typeId, 'journal');
    assert(filed.private);
    equal(filed.title, 'A thought');
    equal(filed.fields.date, toDateStr());
    const b = db.createNote({ title: 'Another' });
    db.fileNote(b.id, { collectionId: col.id, typeId: 'quote' });
    equal(db.getNote(b.id).typeId, 'quote');
    const c = db.createNote({ title: 'Third' });
    db.fileNote(c.id, { spaceId: space.id });
    equal(db.getNote(c.id).typeId, 'free', 'a space has no default type');
  });

  it('built-in types cannot be changed or deleted', async () => {
    const db = await freshDb();
    throwsRule(() => db.updateType('journal', { name: 'Diary' }));
    throwsRule(() => db.deleteType('journal'));
    equal(db.getType('journal').name, 'Journal entry');
  });

  it('a custom type works like a built-in one', async () => {
    const db = await freshDb();
    const type = db.createType({
      name: 'Plant',
      fields: [
        { id: 'water', name: 'Watered', kind: 'date' },
        { id: 'light', name: 'Light', kind: 'select', options: ['Low', 'High'] },
        { id: 'tall', name: 'Height', kind: 'number' },
      ],
    });
    const space = db.createSpace({ name: 'Home' });
    const col = db.createCollection({ name: 'Plants', spaceId: space.id, defaultTypeId: type.id });
    const note = db.createNote({ title: 'Fern', collectionId: col.id, fields: { tall: 30 } });
    equal(note.typeId, type.id);
    assert(viewsFor(db.getType(type.id)).includes('kanban'), 'has a select field');
    equal(db.listTypes().at(-1).id, type.id);
    equal(db.typeUsage(type.id), 1);
  });

  it('renaming a field keeps its values, because they are stored by id', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'T', fields: [{ id: 'f1', name: 'Old', kind: 'text' }] });
    const note = db.createNote({ typeId: type.id, fields: { f1: 'kept' } });
    db.updateType(type.id, { fields: [{ id: 'f1', name: 'New', kind: 'text' }] });
    equal(fieldValue(db.getNote(note.id), db.getType(type.id).fields[0]), 'kept');
  });

  it('removing a field and undoing brings its values back', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'T', fields: [{ id: 'f1', name: 'Field', kind: 'text' }] });
    const note = db.createNote({ typeId: type.id, fields: { f1: 'kept' } });
    const { undo } = db.undoable(() => db.updateType(type.id, { fields: [] }));
    equal(db.getType(type.id).fields.length, 0);
    undo();
    equal(fieldValue(db.getNote(note.id), db.getType(type.id).fields[0]), 'kept');
  });

  it('changing a field\'s kind leaves old values unharmed', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'T', fields: [{ id: 'f1', name: 'F', kind: 'text' }] });
    const note = db.createNote({ typeId: type.id, fields: { f1: 'not a number' } });
    db.updateType(type.id, { fields: [{ id: 'f1', name: 'F', kind: 'number' }] });
    equal(fieldValue(db.getNote(note.id), db.getType(type.id).fields[0]), null);
    equal(db.getNote(note.id).fields.f1, 'not a number', 'kept in case the change is reversed');
  });

  it('deleting a type keeps its notes and writes their values into the text', async () => {
    const db = await freshDb();
    const type = db.createType({
      name: 'T',
      fields: [
        { id: 'f1', name: 'Where', kind: 'text' },
        { id: 'f2', name: 'Todo', kind: 'tasks' },
      ],
    });
    const space = db.createSpace({ name: 'S' });
    const col = db.createCollection({ name: 'C', spaceId: space.id, defaultTypeId: type.id });
    const note = db.createNote({
      collectionId: col.id, title: 'N', body: '<p>Body</p>', fields: { f1: '<b>Rome</b>', f2: [createTask('pack', { done: true })] },
    });
    const { undo } = db.undoable(() => db.deleteType(type.id));
    const after = db.getNote(note.id);
    equal(after.typeId, 'free');
    assert(after.text.includes('Where: <b>Rome</b>'), after.text);
    assert(after.text.includes('pack'), 'tasks kept');
    assert(after.text.includes('Body'), 'body kept');
    assert(!after.body.includes('<b>'), 'value is escaped');
    assert(after.body.includes('data-checked="true"'), 'task state kept');
    equal(db.getCollection(col.id).defaultTypeId, 'free');
    undo();
    equal(db.getNote(note.id).typeId, type.id);
    equal(db.getCollection(col.id).defaultTypeId, type.id);
    assert(!db.getNote(note.id).text.includes('Rome'));
  });

  it('duplicating a built-in makes an editable copy with the same field ids', async () => {
    const db = await freshDb();
    const copy = db.duplicateType('watchlist');
    assert(!copy.builtin);
    equal(copy.name, 'Watchlist item copy');
    db.updateType(copy.id, { name: 'Films' });
    equal(db.getType('watchlist').name, 'Watchlist item');
    const note = db.createNote({ typeId: 'watchlist', fields: { rating: 4 } });
    db.setNoteType(note.id, copy.id);
    equal(db.getNote(note.id).fields.rating, 4);
  });

  it('shows a field\'s text when a note has no title', async () => {
    const db = await freshDb();
    const note = db.createNote({ typeId: 'quote', fields: { quote: 'Stay curious' } });
    equal(displayTitle(note, db.getType('quote')), 'Stay curious');
    equal(displayTitle(db.createNote({}), db.getType('free')), '');
  });

  it('recognizes a new note nobody touched', async () => {
    const db = await freshDb();
    const blank = (note) => isBlankNote(note, db.getType(note.typeId));
    assert(blank(db.createNote({})));
    assert(blank(db.createNote({ typeId: 'journal' })), 'its automatic title and date do not count');
    assert(blank(db.createNote({ typeId: 'watchlist' })), 'its default status does not count');
    assert(!blank(db.createNote({ title: 'x' })));
    assert(!blank(db.createNote({ typeId: 'journal', fields: { mood: 3 } })));
    assert(!blank(db.createNote({ typeId: 'watchlist', fields: { status: 'Watched' } })));
    assert(!blank(db.createNote({ typeId: 'checklist', fields: { items: [createTask('t')] } })));
    assert(!blank(db.createNote({ body: '<p>x</p>' })));
  });

  it('counts words in the text and the long fields', async () => {
    const db = await freshDb();
    const note = db.createNote({ typeId: 'journal', body: '<p>one two</p>', fields: { wentWell: 'three four five' } });
    equal(noteWords(note, db.getType('journal')), 5);
  });

  it('sorts by field values, with empty ones last in either direction', async () => {
    const db = await freshDb();
    const a = db.createNote({ typeId: 'watchlist', title: 'a', fields: { rating: 2, status: 'Watched' } });
    const b = db.createNote({ typeId: 'watchlist', title: 'b', fields: { rating: 5, status: 'To watch' } });
    const c = db.createNote({ typeId: 'watchlist', title: 'c', fields: { status: 'Watching' } });
    const ids = (sort) => db.listNotes({ sort }).map((n) => n.title);
    equal(ids({ key: 'field:rating', dir: 'desc' }), ['b', 'a', 'c']);
    equal(ids({ key: 'field:rating', dir: 'asc' }), ['a', 'b', 'c']);
    equal(ids({ key: 'field:status', dir: 'asc' }), ['b', 'c', 'a'], 'in option order');
    assert(a && b && c);
  });

  it('sorts by due date using tasks and deadlines', async () => {
    const db = await freshDb();
    db.createNote({ typeId: 'checklist', title: 'later', fields: { items: [createTask('t', { due: '2026-09-01' })] } });
    const soon = db.createNote({ typeId: 'goal', title: 'soon', fields: { deadline: '2026-01-01' } });
    db.createNote({ typeId: 'checklist', title: 'none', fields: { items: [createTask('t')] } });
    equal(db.listNotes({ sort: { key: 'due', dir: 'asc' } }).map((n) => n.title), ['soon', 'later', 'none']);
    equal(noteDueDate(soon, db.getType('goal')), '2026-01-01');
  });

  it('updates a task list through the data layer', async () => {
    const db = await freshDb();
    const task = createTask('t');
    const note = db.createNote({ typeId: 'checklist', fields: { items: [task] } });
    db.updateTasks(note.id, 'items', (items) => toggleTask(items, task.id, { today: '2026-05-10' }));
    assert(db.getNote(note.id).fields.items[0].done);
    throwsRule(() => db.updateTasks(note.id, 'missing', (items) => items));
  });

  it('suggests values used before', async () => {
    const db = await freshDb();
    db.createNote({ typeId: 'watchlist', fields: { whereToWatch: 'Netflix', genres: ['Noir'] } });
    db.createNote({ typeId: 'watchlist', fields: { whereToWatch: 'Mubi' } });
    equal(db.usedFieldValues('watchlist', 'whereToWatch'), ['Mubi', 'Netflix']);
    equal(db.usedFieldValues('watchlist', 'genres'), ['Noir']);
    equal(db.usedFieldValues('watchlist', 'missing'), []);
  });
});

describe('Note types: import and export', () => {
  it('round trip keeps custom types, field values and privacy', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'Plant', icon: '🌱', fields: [{ id: 'light', name: 'Light', kind: 'select', options: ['Low'], creatable: true }] });
    const note = db.createNote({ typeId: type.id, fields: { light: 'Low' }, private: true });
    const journal = db.createNote({ typeId: 'journal', fields: { mood: 4 } });
    const list = db.createNote({ typeId: 'checklist', fields: { items: [createTask('t', { due: '2026-01-01', priority: 3 })] } });
    const target = await freshDb();
    await applyImport(target, parseImport(JSON.stringify(await buildExport(db))).data, 'merge');
    equal(target.getType(type.id).fields[0].options, ['Low']);
    assert(target.getType(type.id).fields[0].creatable);
    equal(target.getNote(note.id).fields.light, 'Low');
    assert(target.getNote(note.id).private);
    assert(target.getNote(journal.id).private);
    equal(target.getNote(journal.id).fields.mood, 4);
    equal(target.getNote(list.id).fields.items[0].priority, 3);
  });

  it('built-in types are not written to backups', async () => {
    const db = await freshDb();
    const backup = await buildExport(db);
    equal(backup.data.noteTypes.length, 0);
  });

  it('a file cannot replace or fake a built-in type', async () => {
    const target = await freshDb();
    const parsed = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: {
        noteTypes: [
          { id: 'journal', name: 'Hacked', fields: [] },
          { id: 'mine', name: 'Sneaky', builtin: true, fields: [] },
        ],
      },
    }));
    await applyImport(target, parsed.data, 'merge');
    equal(target.getType('journal').name, 'Journal entry');
    assert(target.getType('journal').builtin);
    assert(!target.getType('mine').builtin, 'cannot claim to be built-in');
    target.updateType('mine', { name: 'Editable' });
    equal(target.getType('mine').name, 'Editable');
  });

  it('cleans damaged type definitions', () => {
    equal(cleanType(null), null);
    equal(cleanType({ id: 'x' }), null);
    const type = cleanType({
      id: 'x',
      name: 'T',
      defaultView: 'nonsense',
      fields: [
        { id: 'a', name: 'A', kind: 'alien' },
        { name: 'no id' },
        { id: 'a', name: 'duplicate' },
        { id: 'b', name: 'B', kind: 'select', options: ['ok', 3, ''] },
        { id: 'c', kind: 'rating', max: 1000 },
        'junk',
      ],
    });
    equal(type.fields.map((f) => f.id), ['a', 'b', 'c']);
    equal(type.fields[0].kind, 'text');
    equal(type.fields[1].options, ['ok']);
    equal(type.fields[2].max, 5);
    equal(type.fields[2].name, 'Untitled field');
    equal(type.defaultView, 'list');
  });

  it('hostile field values cannot break a note', async () => {
    const parsed = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: { notes: [{ id: 'n', typeId: 'watchlist', title: 'T', private: 'yes', fields: { rating: '<img onerror=x>', status: { a: 1 }, genres: 'x', runtime: 'long' } }] },
    }));
    const target = await freshDb();
    await applyImport(target, parsed.data, 'merge');
    const note = target.getNote('n');
    const type = target.getType('watchlist');
    const value = (id) => fieldValue(note, type.fields.find((f) => f.id === id));
    equal([value('rating'), value('status'), value('genres'), value('runtime')], [0, '', [], null]);
    equal(note.private, false, 'only a real true counts');
    assert(Array.isArray(target.listNotes({ sort: { key: 'field:rating', dir: 'desc' } })));
  });

  it('a collection\'s saved view survives, and bad ones are dropped', () => {
    const parsed = parseImport(JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      data: {
        collections: [
          { id: 'a', name: 'A', spaceId: 's', view: { sort: 'field:rating', dir: 'desc', mode: 'kanban', groupBy: 'status' } },
          { id: 'b', name: 'B', spaceId: 's', view: { sort: 'hacked', dir: 'up' } },
        ],
      },
    }));
    equal(parsed.data.collections[0].view, { sort: 'field:rating', dir: 'desc', mode: 'kanban', groupBy: 'status' });
    equal(parsed.data.collections[1].view.sort, 'updated');
  });

  it('Markdown includes fields, sections and task details', async () => {
    const db = await freshDb();
    const note = db.createNote({
      typeId: 'watchlist', title: 'Heat', body: '<p>Saw it twice</p>', fields: { rating: 5, genres: ['Crime'], runtime: 170, review: 'Tense *and* long' },
    });
    const md = noteToMarkdown(note, db);
    assert(md.includes('"Rating": "5/5"'), md);
    assert(md.includes('"Genres": ["Crime"]'), md);
    assert(md.includes('"Runtime": 170'), md);
    assert(md.includes('## Short review\n\nTense \\*and\\* long'), md);
    assert(md.includes('## Notes\n\nSaw it twice'), md);
    const list = db.createNote({
      typeId: 'checklist',
      title: 'L',
      fields: { items: [{ ...createTask('a', { due: '2026-01-02', priority: 3, repeat: 'weekly' }), children: [createTask('b', { done: true })] }] },
    });
    const listMd = noteToMarkdown(list, db);
    assert(listMd.includes('- [ ] a (due 2026-01-02, high priority, weekly)'), listMd);
    assert(listMd.includes('  - [x] b'), listMd);
  });

  it('a relation exports as the other note\'s title, and tolerates deleted notes', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'T', fields: [{ id: 'r', name: 'Related', kind: 'relation' }] });
    const target = db.createNote({ title: 'Other' });
    const note = db.createNote({ typeId: type.id, title: 'N', fields: { r: target.id } });
    assert(noteToMarkdown(note, db).includes('"Related": "Other"'));
    db.purgeNotes([target.id]);
    assert(!noteToMarkdown(db.getNote(note.id), db).includes('Related'));
  });

  it('old backups with no type data still import', async () => {
    const parsed = parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, data: { notes: [{ id: 'old', title: 'Old note', body: '<p>x</p>' }] } }));
    const target = await freshDb();
    await applyImport(target, parsed.data, 'merge');
    equal(target.getNote('old').typeId, 'free');
    equal(target.getNote('old').private, false);
  });
});

describe('Journal', () => {
  const entry = (date, mood = 0, extra = {}) => ({ id: date, created: 0, fields: { date, mood }, text: '', ...extra });
  const today = '2026-05-10';

  it('counts the current streak, even before today\'s entry', () => {
    equal(streaks([entry('2026-05-10'), entry('2026-05-09'), entry('2026-05-07')], today).current, 2);
    equal(streaks([entry('2026-05-09'), entry('2026-05-08')], today).current, 2, 'today not written yet');
    equal(streaks([entry('2026-05-08')], today).current, 0, 'broken');
    equal(streaks([], today), { current: 0, longest: 0 });
  });

  it('finds the longest streak, across month ends, counting one entry a day once', () => {
    const notes = [entry('2026-01-30'), entry('2026-01-31'), entry('2026-02-01'), entry('2026-02-01'), entry('2026-04-01')];
    equal(streaks(notes, today).longest, 3);
  });

  it('finds this day in past years only', () => {
    const notes = [entry('2025-05-10'), entry('2023-05-10'), entry('2026-05-10'), entry('2025-05-11')];
    equal(onThisDay(notes, today).map(entryDate), ['2025-05-10', '2023-05-10']);
  });

  it('shows leap day entries on Feb 28 in other years', () => {
    equal(onThisDay([entry('2024-02-29')], '2026-02-28').length, 1);
    equal(onThisDay([entry('2024-02-29')], '2028-02-28').length, 0, '2028 has its own Feb 29');
  });

  it('builds a mood series with gaps and daily averages', () => {
    const notes = [entry('2026-05-10', 4), entry('2026-05-10', 2), entry('2026-05-08', 5), entry('2026-04-01', 1), entry('2026-05-09', 0)];
    const series = moodSeries(notes, 3, today);
    equal(series, [
      { date: '2026-05-08', mood: 5 },
      { date: '2026-05-09', mood: null },
      { date: '2026-05-10', mood: 3 },
    ]);
    equal(averageMood(series), 4);
    equal(averageMood(moodSeries([], 3, today)), null);
  });

  it('falls back to the created day when an entry has no date', () => {
    const created = new Date(2026, 4, 10, 15).getTime();
    equal(entryDate({ created, fields: {} }), '2026-05-10');
    equal(entryDate({ created, fields: { date: 12 } }), '2026-05-10');
  });
});

describe('Random picker', () => {
  const setup = async () => {
    const db = await freshDb();
    const make = (title, fields) => db.createNote({ typeId: 'watchlist', title, fields });
    const notes = [
      make('Short comedy', { genres: ['Comedy'], runtime: 80, vibe: ['Light'] }),
      make('Long drama', { genres: ['Drama'], runtime: 180, vibe: ['Emotional'] }),
      make('Unknown length', { genres: ['Comedy'] }),
      make('Already seen', { genres: ['Comedy'], runtime: 80, status: 'Watched' }),
    ];
    return { notes, type: db.getType('watchlist') };
  };
  const titles = (list) => list.map((n) => n.title).sort();

  it('only offers things still to watch', async () => {
    const { notes, type } = await setup();
    equal(titles(pickerCandidates(notes, type)), ['Long drama', 'Short comedy', 'Unknown length']);
  });

  it('filters by genre and mood', async () => {
    const { notes, type } = await setup();
    equal(titles(pickerCandidates(notes, type, { genres: 'Comedy' })), ['Short comedy', 'Unknown length']);
    equal(titles(pickerCandidates(notes, type, { vibe: 'Emotional' })), ['Long drama']);
    equal(titles(pickerCandidates(notes, type, { genres: 'Comedy', vibe: 'Emotional' })), []);
  });

  it('a time limit keeps things of unknown length', async () => {
    const { notes, type } = await setup();
    equal(titles(pickerCandidates(notes, type, { runtime: '90' })), ['Short comedy', 'Unknown length']);
  });

  it('blank filters mean any', async () => {
    const { notes, type } = await setup();
    equal(pickerCandidates(notes, type, { genres: '', runtime: '' }).length, 3);
  });

  it('avoids repeating the last pick when it can', async () => {
    const { notes } = await setup();
    const [a, b] = notes;
    for (let i = 0; i < 20; i += 1) equal(pickOne([a, b], { excludeId: a.id }).id, b.id);
    equal(pickOne([a], { excludeId: a.id }).id, a.id, 'the only option is still offered');
    equal(pickOne([]), null);
    equal(pickOne([a, b], { random: () => 0.99 }).id, b.id);
  });
});

// -- Runner -------------------------------------------------------------------------------


describe('Tags', () => {
  it('creates a tag once, ignoring case and accents', async () => {
    const db = await freshDb();
    const a = db.ensureTag('Thesis');
    equal(db.ensureTag('thesis').id, a.id, 'same tag');
    equal(db.ensureTag('#THESIS').id, a.id, 'hash ignored');
    equal(db.ensureTag('Öğrenci').id, db.ensureTag('ogrenci').id, 'accents ignored');
    equal(db.ensureTag('   '), null, 'blank name');
    equal(db.listTags().length, 2);
  });

  it('adds and removes tags on a note', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'One' });
    const tag = db.addTag(note.id, 'alpha');
    db.addTag(note.id, 'ALPHA');
    equal(db.getNote(note.id).tagIds, [tag.id], 'added once');
    assert(db.getNote(note.id).updated >= note.updated);
    db.removeTag(note.id, tag.id);
    equal(db.getNote(note.id).tagIds, []);
  });

  it('merges tags without duplicates', async () => {
    const db = await freshDb();
    const a = db.createNote({ title: 'A' });
    const b = db.createNote({ title: 'B' });
    const old = db.addTag(a.id, 'movies');
    const keep = db.addTag(a.id, 'films');
    db.addTag(b.id, 'movies');
    db.mergeTags([old.id], keep.id);
    equal(db.getNote(a.id).tagIds, [keep.id], 'note with both');
    equal(db.getNote(b.id).tagIds, [keep.id], 'note with the old tag');
    equal(db.getTag(old.id), null, 'old tag removed');
    equal(db.counts().tags.get(keep.id), 2, 'count');
  });

  it('renaming to an existing name merges', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A' });
    const a = db.addTag(note.id, 'one');
    const b = db.ensureTag('two');
    const kept = db.renameTag(a.id, 'TWO');
    equal(kept.id, b.id, 'kept the other tag');
    equal(db.getNote(note.id).tagIds, [b.id]);
    equal(db.listTags().length, 1);
  });

  it('renames plainly when the name is free, and refuses a blank one', async () => {
    const db = await freshDb();
    const tag = db.ensureTag('one');
    equal(db.renameTag(tag.id, 'uno').name, 'uno');
    throwsRule(() => db.renameTag(tag.id, '  '));
  });

  it('deleting a tag keeps notes, and undo brings it back', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A' });
    const tag = db.addTag(note.id, 'gone');
    const { undo } = db.undoable(() => db.deleteTag(tag.id));
    equal(db.getNote(note.id).tagIds, []);
    equal(db.getTag(tag.id), null);
    undo();
    equal(db.getNote(note.id).tagIds, [tag.id]);
    assert(db.getTag(tag.id));
  });

  it('finds orphan tags, counting trashed notes as unused', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A' });
    const used = db.addTag(note.id, 'used');
    const idle = db.ensureTag('idle');
    equal(db.orphanTags().map((t) => t.id), [idle.id]);
    db.trashNotes([note.id]);
    equal(db.orphanTags().length, 2);
    db.restoreNotes([note.id]);
    assert(!db.orphanTags().some((t) => t.id === used.id));
  });

  it('a note with only a tag is not blank', async () => {
    const db = await freshDb();
    const note = db.createNote({});
    assert(isBlankNote(note, db.getType('free')));
    db.addTag(note.id, 'keep');
    assert(!isBlankNote(db.getNote(note.id), db.getType('free')));
  });
});

describe('Links and backlinks', () => {
  const link = (note) => `<a href="#/note/${note.id}">${note.title}</a>`;

  it('reads links from a body', () => {
    equal(bodyLinkIds('<p><a href="#/note/a">x</a> and <a href="#/note/b">y</a> and <a href="#/note/a">z</a> <a href="https://e.com">w</a></p>'), ['a', 'b']);
    equal(bodyLinkIds(''), []);
  });

  it('links survive sanitizing', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Target' });
    const source = db.createNote({ title: 'Source', body: `<p>${link(target)}</p>` });
    assert(source.body.includes(`href="#/note/${target.id}"`), source.body);
    equal(source.links, [target.id]);
  });

  it('tracks backlinks as bodies change', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Target' });
    const source = db.createNote({ title: 'Source' });
    equal(db.backlinks(target.id), []);
    db.updateNote(source.id, { body: `<p>${link(target)}</p>` });
    equal(db.backlinks(target.id).map((n) => n.id), [source.id]);
    db.updateNote(source.id, { body: '<p>no more</p>' });
    equal(db.backlinks(target.id), []);
  });

  it('a note does not backlink itself', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Self' });
    db.updateNote(note.id, { body: `<p>${link(note)}</p>` });
    equal(db.getNote(note.id).links, []);
    equal(db.backlinks(note.id), []);
  });

  it('counts "Link to a note" fields as links', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Target' });
    const type = db.createType({ name: 'Linked', fields: [{ id: 'rel', name: 'Rel', kind: 'relation' }] });
    const source = db.createNote({ title: 'Source', typeId: type.id, fields: { rel: target.id } });
    equal(source.links, [target.id]);
    equal(db.backlinks(target.id).map((n) => n.id), [source.id]);
    equal(collectLinks({ id: 'x', body: '', fields: { rel: 'x' } }, type), [], 'itself');
  });

  it('hides trashed sources, and shows them again on restore', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Target' });
    const source = db.createNote({ title: 'Source', body: `<p>${link(target)}</p>` });
    db.trashNotes([source.id]);
    equal(db.backlinks(target.id), []);
    db.restoreNotes([source.id]);
    equal(db.backlinks(target.id).length, 1);
  });

  it('link text follows a renamed note, unless it was reworded', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Old & name' });
    const plain = db.createNote({ title: 'A', body: `<p><a href="#/note/${target.id}">Old &amp; name</a></p>` });
    const custom = db.createNote({ title: 'B', body: `<p><a href="#/note/${target.id}">my words</a></p>` });
    const before = db.getNote(plain.id).updated;
    db.updateNote(target.id, { title: 'New name' }, { now: Date.now() + 5000 });
    assert(db.getNote(plain.id).body.includes('>New name<'), db.getNote(plain.id).body);
    assert(db.getNote(plain.id).text.includes('New name'), 'text updated');
    equal(db.getNote(plain.id).updated, before, 'not counted as an edit');
    assert(db.getNote(custom.id).body.includes('>my words<'));
    equal(renameLinkText('<p>none</p>', 'x', 'a', 'b'), '<p>none</p>');
  });

  it('exports wiki links and tags to Markdown', async () => {
    const db = await freshDb();
    const target = db.createNote({ title: 'Target' });
    const source = db.createNote({ title: 'Source', body: `<p>See ${link(target)}.</p>` });
    db.addTag(source.id, 'one');
    const md = noteToMarkdown(db.getNote(source.id), db);
    assert(md.includes('See [[Target]].'), md);
    assert(md.includes('tags: ["one"]'), md);
  });

  it('suggests related notes by shared tags, rarest first', async () => {
    const db = await freshDb();
    const main = db.createNote({ title: 'Main' });
    db.addTag(main.id, 'common');
    db.addTag(main.id, 'rare');
    const commonOnly = db.createNote({ title: 'Common' });
    db.addTag(commonOnly.id, 'common');
    const another = db.createNote({ title: 'Another' });
    db.addTag(another.id, 'common');
    const rareOnly = db.createNote({ title: 'Rare' });
    db.addTag(rareOnly.id, 'rare');
    const related = db.relatedNotes(db.getNote(main.id));
    equal(related[0].id, rareOnly.id, 'rare first');
    equal(related.length, 3);
    equal(db.relatedNotes(db.createNote({ title: 'No tags' })), []);
  });

  it('keeps private notes out of suggestions for other notes', async () => {
    const db = await freshDb();
    const secret = db.createNote({ title: 'Secret', typeId: 'journal' });
    const open = db.createNote({ title: 'Open' });
    db.addTag(secret.id, 'x');
    db.addTag(open.id, 'x');
    equal(db.relatedNotes(db.getNote(open.id)), []);
    equal(db.relatedNotes(db.getNote(secret.id)).map((n) => n.id), [open.id]);
  });
});

describe('Filters', () => {
  function world(db) {
    const { school, fun, course, lectures, movies } = seed(db);
    const today = toDateStr();
    const thriller = db.createNote({ title: 'Heat', collectionId: movies.id, typeId: 'watchlist', fields: { status: 'To watch', genres: ['Thriller'], runtime: 170 } });
    const comedy = db.createNote({ title: 'Airplane', collectionId: movies.id, typeId: 'watchlist', fields: { status: 'Watched', genres: ['Comedy'], rating: 5 } });
    const low = db.createNote({ title: 'Walk', spaceId: fun.id, typeId: 'idea', fields: { effort: 'Low', minutes: 20 } });
    const high = db.createNote({ title: 'Bake', spaceId: fun.id, typeId: 'idea', fields: { effort: 'Low', minutes: 90 } });
    const list = db.createNote({
      title: 'School list',
      collectionId: lectures.id,
      typeId: 'checklist',
      fields: { items: [{ id: 't', text: 'Late', due: addDays(today, -2) }] },
    });
    const diary = db.createNote({ title: 'Diary', typeId: 'journal' });
    return { school, fun, course, lectures, movies, thriller, comedy, low, high, list, diary, today };
  }
  const titles = (notes) => notes.map((n) => n.title).sort();
  const run = (db, patch, options) => queryNotes(db, { ...emptyFilter(), ...patch }, options);

  it('finds unwatched thrillers', async () => {
    const db = await freshDb();
    world(db);
    equal(titles(run(db, { types: ['watchlist'], rules: [{ field: 'status', op: 'is', value: 'To watch' }, { field: 'genres', op: 'has', value: 'Thriller' }] })), ['Heat']);
  });

  it('finds low-effort ideas under 30 minutes', async () => {
    const db = await freshDb();
    world(db);
    equal(titles(run(db, { types: ['idea'], rules: [{ field: 'effort', op: 'is', value: 'Low' }, { field: 'minutes', op: 'lte', value: 30 }] })), ['Walk']);
  });

  it('finds overdue tasks in a space', async () => {
    const db = await freshDb();
    const { school, fun } = world(db);
    const date = { key: 'due', range: 'overdue', from: '', to: '' };
    equal(titles(run(db, { spaces: [school.id], date })), ['School list']);
    equal(run(db, { spaces: [fun.id], date }).length, 0);
  });

  it('a collection includes its sub-collections, unless exact', async () => {
    const db = await freshDb();
    const { course } = world(db);
    equal(titles(run(db, { collections: [course.id] })), ['School list']);
    equal(run(db, { collections: [course.id], exact: true }).length, 0);
  });

  it('matches tags in any or all mode', async () => {
    const db = await freshDb();
    const { thriller, comedy } = world(db);
    const a = db.addTag(thriller.id, 'a');
    const b = db.addTag(thriller.id, 'b');
    db.addTag(comedy.id, 'a');
    equal(titles(run(db, { tags: [a.id, b.id], tagMode: 'any' })), ['Airplane', 'Heat']);
    equal(titles(run(db, { tags: [a.id, b.id], tagMode: 'all' })), ['Heat']);
  });

  it('keeps private notes out unless asked for', async () => {
    const db = await freshDb();
    world(db);
    assert(!titles(run(db, {})).includes('Diary'), 'hidden by default');
    assert(titles(run(db, { includePrivate: true })).includes('Diary'), 'when included');
    assert(titles(run(db, { types: ['journal'] })).includes('Diary'), 'when its type is chosen');
    assert(titles(run(db, {}, { locked: { ...emptyFilter() } })).includes('Diary'), 'inside a scoped page');
  });

  it('respects archived status and never shows the Trash', async () => {
    const db = await freshDb();
    const { thriller, comedy } = world(db);
    db.archiveNotes([thriller.id]);
    db.trashNotes([comedy.id]);
    assert(!titles(run(db, {})).includes('Heat'));
    equal(titles(run(db, { status: 'archived' })), ['Heat']);
    assert(titles(run(db, { status: 'all' })).includes('Heat'));
    assert(!titles(run(db, { status: 'all' })).includes('Airplane'));
  });

  it('matches words in any order, ignoring case and accents', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Çalışma planı', body: '<p>Haftalık Program</p>' });
    equal(run(db, { text: 'program calisma' }).length, 1);
    equal(run(db, { text: 'program yok' }).length, 0);
  });

  it('filters by a date range', async () => {
    const db = await freshDb();
    const today = toDateStr();
    db.createNote({ title: 'Recent', typeId: 'meeting', fields: { date: addDays(today, -3) } });
    db.createNote({ title: 'Old', typeId: 'meeting', fields: { date: addDays(today, -60) } });
    db.createNote({ title: 'None', typeId: 'meeting', fields: { date: '' } });
    const on = (range, extra = {}) => titles(run(db, { types: ['meeting'], date: { key: 'field:date', range, from: '', to: '', ...extra } }));
    equal(on('last7'), ['Recent']);
    equal(on('none'), ['None']);
    equal(on('custom', { from: addDays(today, -70), to: addDays(today, -50) }), ['Old']);
  });

  it('a rule on a field the type lacks does not match', async () => {
    const db = await freshDb();
    world(db);
    equal(titles(run(db, { rules: [{ field: 'effort', op: 'isNot', value: 'High' }] })), ['Bake', 'Walk']);
  });

  it('tests rules by kind', () => {
    const num = { id: 'n', kind: 'number' };
    assert(!testRule(num, null, { op: 'lte', value: 5 }), 'unknown number is not under a limit');
    assert(testRule(num, 3, { op: 'lte', value: 5 }));
    assert(testRule({ kind: 'text' }, 'Déjà vu', { op: 'contains', value: 'deja' }));
    assert(testRule({ kind: 'checkbox' }, true, { op: 'yes' }));
    assert(testRule({ kind: 'date' }, '2020-01-01', { op: 'overdue' }, '2026-01-01'));
    assert(!testRule({ kind: 'date' }, '', { op: 'overdue' }, '2026-01-01'));
    assert(testRule({ kind: 'tasks' }, [{ done: false, children: [] }], { op: 'hasOpen' }));
    assert(testRule({ kind: 'tasks' }, [{ done: true, children: [] }], { op: 'allDone' }));
    assert(testRule({ kind: 'select' }, '', { op: 'empty' }));
  });

  it('normalizes junk into a usable filter', () => {
    const clean = normalizeFilter({
      status: 'nope', tags: ['a', 'a', 3], rules: [{ field: 'x', op: 'bogus' }, { field: 'y', op: 'is', value: { bad: 1 } }, 'junk'], date: { key: 'due', range: 'never' }, text: 5,
    });
    equal(clean.status, 'active');
    equal(clean.tags, ['a']);
    equal(clean.rules, [{ field: 'y', op: 'is', value: '' }]);
    equal(clean.date, null);
    equal(clean.text, '');
    equal(normalizeFilter(null).rules, []);
    equal(countConditions(emptyFilter()), 0);
  });

  it('describes a filter in words', async () => {
    const db = await freshDb();
    const tag = db.ensureTag('x');
    const words = describeFilter(db, { ...emptyFilter(), tags: [tag.id], types: ['idea'], rules: [{ field: 'effort', op: 'is', value: 'Low' }] });
    assert(words.join().includes('Tagged x') && words.join().includes('Idea') && words.join().includes('Effort is Low'), words.join());
  });

  it('stays fast on 5,000 notes', async () => {
    const db = await freshDb();
    db.batch(() => {
      for (let i = 0; i < 5000; i += 1) db.createNote({ title: `Note ${i}`, typeId: 'idea', fields: { effort: i % 2 ? 'Low' : 'High', minutes: i % 60 } });
    });
    const started = performance.now();
    const found = run(db, { types: ['idea'], rules: [{ field: 'effort', op: 'is', value: 'Low' }, { field: 'minutes', op: 'lte', value: 30 }] });
    assert(found.length > 0);
    assert(performance.now() - started < 200, `took ${performance.now() - started} ms`);
    assert(compileFilter(db, emptyFilter())(found[0]));
  });
});

describe('Saved views', () => {
  it('creates, renames, reorders and deletes', async () => {
    const db = await freshDb();
    const a = db.createSavedView({ name: 'A', filter: emptyFilter() });
    const b = db.createSavedView({ name: 'B', filter: emptyFilter() });
    equal(db.listSavedViews().map((v) => v.id), [a.id, b.id]);
    db.moveSavedView(b.id, 0);
    equal(db.listSavedViews().map((v) => v.id), [b.id, a.id]);
    db.updateSavedView(a.id, { name: 'Renamed', pinned: false });
    equal(db.getSavedView(a.id).name, 'Renamed');
    db.deleteSavedView(b.id);
    equal(db.listSavedViews().length, 1);
    throwsRule(() => db.deleteSavedView(b.id));
  });

  it('round-trips through a backup, with cleaned filters', async () => {
    const db = await freshDb();
    const tag = db.ensureTag('kept');
    const note = db.createNote({ title: 'Tagged' });
    db.addTag(note.id, 'kept');
    const target = db.createNote({ title: 'Target' });
    db.updateNote(note.id, { body: `<p><a href="#/note/${target.id}">Target</a></p>` });
    db.createSavedView({ name: 'V', filter: { ...emptyFilter(), tags: [tag.id] }, view: { sort: 'title', dir: 'asc', mode: 'cards' } });
    const backup = JSON.parse(JSON.stringify(await buildExport(db)));
    const parsed = parseImport(JSON.stringify(backup));
    assert(parsed.ok, parsed.error);
    const other = await freshDb();
    await applyImport(other, parsed.data, 'merge');
    equal(other.listTags().map((t) => t.name), ['kept']);
    equal(other.listSavedViews()[0].view.mode, 'cards');
    equal(other.listSavedViews()[0].filter.tags, [tag.id]);
    equal(other.backlinks(target.id).map((n) => n.id), [note.id], 'backlinks rebuilt');
  });

  it('merging a backup joins tags with the same name', async () => {
    const source = await freshDb();
    const note = source.createNote({ title: 'From file' });
    source.addTag(note.id, 'Shared');
    const backup = await buildExport(source);
    const db = await freshDb();
    const mine = db.ensureTag('shared');
    const parsed = parseImport(JSON.stringify(backup));
    await applyImport(db, parsed.data, 'merge');
    equal(db.listTags().length, 1);
    equal(db.getNote(note.id).tagIds, [mine.id]);
  });

  it('imports drop bad tags and tags that do not exist', async () => {
    const db = await freshDb();
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: SCHEMA_VERSION,
      data: {
        tags: [{ id: 't1', name: 'Good' }, { id: 't2', name: 'good' }, { id: 't3', name: '   ' }, { id: 5 }],
        notes: [{ id: 'n1', title: 'N', tagIds: ['t1', 't2', 'missing'], links: ['fake'] }],
        savedViews: [{ id: 'v1', name: 'V', filter: 'junk' }, { name: 'no id' }],
      },
    });
    const parsed = parseImport(text);
    assert(parsed.ok, parsed.error);
    assert(parsed.warnings.length > 0);
    await applyImport(db, parsed.data, 'merge');
    equal(db.getNote('n1').tagIds, ['t1']);
    equal(db.getNote('n1').links, [], 'links are derived, not trusted');
    equal(db.getSavedView('v1').filter.rules, []);
  });
});


describe('Search', () => {
  const titles = (results) => results.map((r) => r.note.title);

  it('finds words in titles, bodies, fields and tags', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Quantum notes' });
    db.createNote({ title: 'Body match', body: '<p>All about quantum things</p>' });
    db.createNote({ title: 'Field match', typeId: 'watchlist', fields: { review: 'A quantum thriller' } });
    const tagged = db.createNote({ title: 'Tag match' });
    db.addTag(tagged.id, 'quantum-physics');
    db.createNote({ title: 'Nothing related' });
    equal(titles(searchNotes(db, 'quantum')).sort(), ['Body match', 'Field match', 'Quantum notes', 'Tag match']);
  });

  it('ranks title over tag over field over body', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Body', body: '<p>zebra</p>' });
    db.createNote({ title: 'Field', typeId: 'watchlist', fields: { review: 'zebra' } });
    const tagged = db.createNote({ title: 'Tag' });
    db.addTag(tagged.id, 'zebra');
    db.createNote({ title: 'A zebra here' });
    db.createNote({ title: 'zebra' });
    equal(titles(searchNotes(db, 'zebra')), ['zebra', 'A zebra here', 'Tag', 'Field', 'Body']);
  });

  it('needs every word, in any order', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Machine learning', body: '<p>gradient descent</p>' });
    db.createNote({ title: 'Machine shop' });
    equal(titles(searchNotes(db, 'descent machine')), ['Machine learning']);
    equal(searchNotes(db, 'machine zzz'), []);
  });

  it('ignores case and accents, including Turkish letters', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Çalışma İstanbul' });
    db.createNote({ title: 'Déjà vu' });
    equal(titles(searchNotes(db, 'calisma')), ['Çalışma İstanbul']);
    equal(titles(searchNotes(db, 'ISTANBUL')), ['Çalışma İstanbul']);
    equal(titles(searchNotes(db, 'deja')), ['Déjà vu']);
  });

  it('matches exact phrases', async () => {
    const db = await freshDb();
    db.createNote({ title: 'A', body: '<p>the quick brown fox</p>' });
    db.createNote({ title: 'B', body: '<p>quick and brown</p>' });
    equal(titles(searchNotes(db, '"quick brown"')), ['A']);
  });

  it('keeps private notes out unless included', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Secret diary', typeId: 'journal' });
    equal(searchNotes(db, 'secret'), [], 'hidden by default');
    equal(titles(searchNotes(db, 'secret', { includePrivate: true })), ['Secret diary'], 'when included');
    equal(titles(searchNotes(db, 'secret is:private')), ['Secret diary'], 'when asked for');
    equal(titles(searchNotes(db, 'secret type:journal')), ['Secret diary'], 'by type');
    equal(titles(searchNotes(db, 'secret', { typeId: 'journal' })), ['Secret diary'], 'by the type filter');
  });

  it('leaves out archived notes and the Trash, unless asked', async () => {
    const db = await freshDb();
    const a = db.createNote({ title: 'Word archived' });
    const b = db.createNote({ title: 'Word trashed' });
    db.createNote({ title: 'Word active' });
    db.archiveNotes([a.id]);
    db.trashNotes([b.id]);
    equal(titles(searchNotes(db, 'word')), ['Word active']);
    equal(titles(searchNotes(db, 'word', { status: 'archived' })), ['Word archived']);
    equal(titles(searchNotes(db, 'word', { status: 'all' })).sort(), ['Word active', 'Word archived']);
    equal(titles(searchNotes(db, 'word is:archived')), ['Word archived']);
  });

  it('filters by space, collection, type, tag and dates', async () => {
    const db = await freshDb();
    const { school, fun, course, lectures } = seed(db);
    const a = db.createNote({ title: 'Item a', spaceId: school.id });
    const b = db.createNote({ title: 'Item b', collectionId: lectures.id, typeId: 'course' });
    db.createNote({ title: 'Item c', spaceId: fun.id, now: Date.parse('2020-06-15T12:00:00') });
    const tag = db.addTag(a.id, 'mark');
    equal(titles(searchNotes(db, 'item', { spaceId: fun.id })), ['Item c']);
    equal(titles(searchNotes(db, 'item', { collectionId: course.id })), ['Item b'], 'includes sub-collections');
    equal(titles(searchNotes(db, 'item', { typeId: 'course' })), ['Item b']);
    equal(titles(searchNotes(db, 'item', { tagId: tag.id })), ['Item a']);
    equal(titles(searchNotes(db, 'item', { to: '2021-01-01' })), ['Item c']);
    equal(titles(searchNotes(db, 'item', { from: '2021-01-01' })).sort(), ['Item a', 'Item b']);
    assert(b);
  });

  it('understands operators in the query', async () => {
    const db = await freshDb();
    const { school, course } = seed(db);
    const a = db.createNote({ title: 'One', collectionId: course.id });
    db.createNote({ title: 'Two', spaceId: school.id });
    db.addTag(a.id, 'thesis');
    db.setPinned(a.id, true);
    equal(titles(searchNotes(db, 'tag:thesis')), ['One']);
    equal(titles(searchNotes(db, 'in:dl-fs')), ['One']);
    equal(titles(searchNotes(db, 'in:school')).sort(), ['One', 'Two']);
    equal(titles(searchNotes(db, 'is:pinned')), ['One']);
    equal(searchNotes(db, 'tag:missing'), [], 'an unknown tag finds nothing');
    equal(searchNotes(db, 'in:nowhere'), []);
    equal(searchNotes(db, '   '), [], 'blank');
  });

  it('parses a query', () => {
    const parsed = parseQuery('hello "big World" tag:x type:journal in:school after:2026-01-01 before:nope is:archived');
    equal(parsed.terms, ['hello', 'big world', 'before:nope'], 'a bad date stays a plain word');
    equal(parsed.tags, ['x']);
    equal(parsed.types, ['journal']);
    equal(parsed.places, ['school']);
    equal(parsed.after, '2026-01-01');
    equal(parsed.before, '');
    assert(parsed.flags.has('archived'));
  });

  it('builds highlighted snippets around the match', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Long', body: `<p>${'word '.repeat(60)}needle ${'word '.repeat(60)}</p>` });
    const [result] = searchNotes(db, 'needle');
    assert(result.snippet.text.includes('needle'), result.snippet.text);
    assert(result.snippet.text.startsWith('…') && result.snippet.text.endsWith('…'), result.snippet.text);
    assert(result.snippet.text.length < 200);
    const [from, to] = result.snippet.ranges[0];
    equal(result.snippet.text.slice(from, to), 'needle');
  });

  it('marks text with accents correctly', () => {
    equal(findRanges('Çalışma', ['calis']), [[0, 5]]);
    equal(findRanges('a Déjà b déjà', ['deja']), [[2, 6], [9, 13]]);
    equal(findRanges('abcabc', ['abc', 'bca']), [[0, 6]], 'overlaps merge');
    equal(findRanges('', ['x']), []);
    const text = 'école';
    const [[start, end]] = findRanges(text, ['ecole']);
    equal(text.slice(start, end), text, 'combining marks stay inside');
    assert(buildSnippet('short', ['short']).ranges.length === 1);
  });

  it('remembers recent searches without repeats', () => {
    equal(rememberSearch(['a', 'b'], 'b'), ['b', 'a']);
    equal(rememberSearch(['a'], '  '), ['a']);
    equal(rememberSearch(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
  });

  it('sees edits, and field changes after a type changes', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Original' });
    equal(searchNotes(db, 'original').length, 1);
    db.updateNote(note.id, { title: 'Changed' });
    equal(searchNotes(db, 'original').length, 0);
    equal(searchNotes(db, 'changed').length, 1);
    const custom = db.createType({ name: 'T', fields: [{ id: 'f', name: 'F', kind: 'text' }] });
    db.setNoteType(note.id, custom.id);
    db.updateNote(note.id, { fields: { ...db.getNote(note.id).fields, f: 'fieldword' } });
    equal(searchNotes(db, 'fieldword').length, 1);
    db.updateType(custom.id, { fields: [] });
    equal(searchNotes(db, 'fieldword').length, 0, 'removed field no longer searched');
  });

  it('survives regular expression characters and huge bodies', async () => {
    const db = await freshDb();
    db.createNote({ title: 'C++ (notes) [draft]', body: `<p>${'x'.repeat(500000)} tail</p>` });
    equal(searchNotes(db, 'c++').length, 1);
    equal(searchNotes(db, '(notes)').length, 1);
    equal(searchNotes(db, '.*').length, 0);
    const started = performance.now();
    const [hit] = searchNotes(db, 'tail');
    assert(hit.snippet.text.includes('tail'));
    assert(performance.now() - started < 300, `${performance.now() - started} ms`);
  });

  it('stays fast on 5,000 notes', async () => {
    const db = await freshDb();
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
    db.batch(() => {
      for (let i = 0; i < 5000; i += 1) {
        const body = Array.from({ length: 60 }, (_, j) => words[(i + j * 7) % 10]).join(' ');
        db.createNote({ title: `Note ${i} ${words[i % 10]}`, body: `<p>${body}</p>` });
      }
    });
    const first = performance.now();
    assert(searchNotes(db, 'gamma kappa').length > 0);
    const firstMs = performance.now() - first;
    const second = performance.now();
    assert(searchNotes(db, 'delta zeta').length > 0);
    const secondMs = performance.now() - second;
    assert(firstMs < 800, `first search took ${firstMs} ms`);
    assert(secondMs < 100, `later search took ${secondMs} ms`);
  });
});


describe('Flashcards and quiz', () => {
  it('cleans cards from anywhere', () => {
    const cards = normalizeCards([{ id: 'a', term: 'T', def: 'D', review: true, right: 2 }, { id: 'a', term: 'dup' }, 'junk', null, { term: 5, right: -1 }]);
    equal(cards.length, 3);
    assert(cards[1].id !== 'a', 'duplicate id replaced');
    equal(cards[0].right, 2);
    equal(cards[2].term, '');
    equal(cards[2].right, 0);
    equal(normalizeCards('nope'), []);
  });

  it('skips blank cards when studying', () => {
    equal(usableCards([createCard('a', ''), createCard('', ''), createCard('  ', ' ')]).length, 1);
  });

  it('shuffles without losing cards', () => {
    const items = [1, 2, 3, 4, 5];
    equal(shuffle(items, () => 0.5).slice().sort(), items);
    equal(items, [1, 2, 3, 4, 5], 'the original is untouched');
  });

  it('records answers and the review flag', () => {
    const missed = recordAnswer(createCard('t', 'd'), false, 100);
    equal([missed.wrong, missed.review, missed.lastSeen], [1, true, 100]);
    const got = recordAnswer(missed, true);
    equal([got.right, got.wrong, got.review], [1, 1, false]);
  });

  it('brings missed cards back until answered', () => {
    const entries = ['a', 'b', 'c'].map((term) => ({ card: { ...createCard(term, 'x') } }));
    let session = startQuiz(entries, () => 0.999);
    const first = session.queue[0].card.term;
    session = answerQuiz(session, false);
    equal(session.queue.length, 3, 'still three to go');
    equal(session.queue.at(-1).card.term, first, 'it comes back later');
    session = answerQuiz(session, true);
    session = answerQuiz(session, true);
    session = answerQuiz(session, true);
    equal(session.queue.length, 0, 'finished');
    equal(session.firstTry, 2, 'the missed one does not count as first try');
    equal(session.missed.length, 1);
    equal(session.done, 3);
    equal(answerQuiz(session, true), session, 'nothing left to answer');
  });

  it('asks cards needing review first', () => {
    const entries = [{ card: { ...createCard('a'), review: false } }, { card: { ...createCard('b'), review: true } }];
    equal(startQuiz(entries).queue[0].card.term, 'b');
  });

  it('survive as a field, in search and in Markdown', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'Lecture', typeId: 'course', fields: { cards: [createCard('Neuron', 'Basic unit')] } });
    equal(searchNotes(db, 'neuron').length, 1);
    assert(noteToMarkdown(db.getNote(note.id), db).includes('**Neuron**: Basic unit'));
    const type = db.getType('course');
    assert(viewsFor(type).includes('exam') && viewsFor(type).includes('lectures') && viewsFor(type).includes('topics'));
  });

  it('a course note starts linked to its top-level collection', async () => {
    const db = await freshDb();
    const { course, lectures } = seed(db);
    equal(db.createNote({ typeId: 'course', collectionId: lectures.id }).fields.course, course.id, 'sub-collection');
    equal(db.createNote({ typeId: 'course', collectionId: course.id }).fields.course, course.id);
    equal(db.createNote({ typeId: 'course' }).fields.course, '', 'no collection');
    const md = noteToMarkdown(db.createNote({ title: 'L', typeId: 'course', collectionId: lectures.id }), db);
    assert(md.includes('"Course": "DL-FS2026"'), md);
  });
});

describe('Math and code in notes', () => {
  it('keeps formulas through sanitizing, dropping what was drawn', () => {
    const html = sanitizeHtml('<p>A <span data-math="x^2" data-drawn="1" contenteditable="false" onclick="bad()"><span class="katex"><script>bad()</script>drawn</span></span> b</p>');
    equal(html, '<p>A <span data-math="x^2">x^2</span> b</p>');
    const block = sanitizeHtml('<p><span data-math="\\frac{a}{b}" data-display="true">junk</span></p>');
    assert(block.includes('data-display="true"') && block.includes('>\\frac{a}{b}<'), block);
  });

  it('escapes formulas and removes empty ones', () => {
    equal(sanitizeHtml('<p><span data-math="a&quot;><img src=x onerror=y>b"></span></p>'), '<p><span data-math="a&quot;&gt;&lt;img src=x onerror=y&gt;b">a&quot;&gt;&lt;img src=x onerror=y&gt;b</span></p>');
    equal(sanitizeHtml('<p>x<span data-math="  "></span></p>'), '<p>x</p>');
  });

  it('leaves other spans alone, as before', () => {
    equal(sanitizeHtml('<p><span class="x">hi</span></p>'), '<p>hi</p>');
  });

  it('math reads as text, and as LaTeX in Markdown', () => {
    const html = '<p>See <span data-math="x^2">x^2</span></p><p><span data-math="y" data-display="true">y</span></p>';
    assert(htmlToText(html).includes('x^2'));
    const md = htmlToMarkdown(html);
    assert(md.includes('$x^2$') && md.includes('$$y$$'), md);
    assert(!isBodyEmpty('<p><span data-math="x">x</span></p>'));
  });

  it('keeps a code block language, but only a sensible one', () => {
    equal(sanitizeHtml('<pre data-lang="python">x = 1</pre>'), '<pre data-lang="python">x = 1</pre>');
    equal(sanitizeHtml('<pre data-lang="a b<c">x</pre>'), '<pre>x</pre>');
    assert(htmlToMarkdown('<pre data-lang="python">x = 1</pre>').startsWith('```python\n'));
  });

  it('finds the colored parts of code', () => {
    const kinds = (code, lang) => tokenizeCode(code, lang).map((t) => [t.type, code.slice(t.start, t.end)]);
    equal(kinds('def f(x): # note\n  return "a" + 1', 'python'), [
      ['keyword', 'def'], ['function', 'f'], ['comment', '# note'], ['keyword', 'return'], ['string', '"a"'], ['number', '1'],
    ]);
    equal(kinds('const a = `t`; /* c */ g(2)', 'javascript'), [
      ['keyword', 'const'], ['string', '`t`'], ['comment', '/* c */'], ['function', 'g'], ['number', '2'],
    ]);
    equal(kinds('SELECT 1 from t', 'sql'), [['keyword', 'SELECT'], ['number', '1'], ['keyword', 'from']]);
    equal(kinds('<div class="a">', 'html'), [['keyword', '<div'], ['string', '"a"']]);
    equal(kinds('\\frac{1}', 'latex'), [['keyword', '\\frac'], ['number', '1']]);
  });

  it('copes with half-typed code', () => {
    const tokens = tokenizeCode('x = "never closed\ny = 2 /* open', 'javascript');
    assert(tokens.every((t) => t.end > t.start));
    assert(tokens.some((t) => t.type === 'number'), 'the string ends with its line');
  });

  it('guesses a language', () => {
    equal(detectLanguage('def f(x):\n  return x'), 'python');
    equal(detectLanguage('SELECT a FROM b'), 'sql');
    equal(detectLanguage('const a = 1'), 'javascript');
    equal(detectLanguage('#include <stdio.h>'), 'c');
  });
});

describe('Surprise me', () => {
  const idea = (db, title, fields) => db.createNote({ title, typeId: 'idea', fields });

  it('filters by time, energy, mood and place', async () => {
    const db = await freshDb();
    const type = db.getType('idea');
    const notes = [
      idea(db, 'Walk', { minutes: 20, effort: 'Low', category: 'Outside', setting: 'Outdoors' }),
      idea(db, 'Read', { minutes: 60, effort: 'Low', category: 'Cozy', setting: 'Indoors' }),
      idea(db, 'Either', { minutes: 30, effort: 'Medium', setting: 'Either' }),
      idea(db, 'Unknown', {}),
    ];
    const names = (filters) => pickerCandidates(notes, type, filters).map((n) => n.title).sort();
    equal(names({}), ['Either', 'Read', 'Unknown', 'Walk']);
    equal(names({ minutes: '30' }), ['Either', 'Unknown', 'Walk'], 'unknown time stays in');
    equal(names({ effort: 'Low' }), ['Read', 'Walk']);
    equal(names({ setting: 'Indoors' }), ['Either', 'Read', 'Unknown'], '"Either" and unknown fit indoors');
    equal(names({ setting: 'Outdoors', effort: 'Low' }), ['Walk']);
  });

  it('mark as done counts up and dates it', async () => {
    const db = await freshDb();
    const type = db.getType('idea');
    const note = idea(db, 'Walk', { timesDone: 2 });
    const when = Date.parse('2026-03-04T12:00:00');
    const patch = donePatch(note, type, when);
    equal(patch.fields.timesDone, 3);
    equal(patch.fields.lastDone, '2026-03-04');
    equal(donePatch(idea(db, 'New', {}), type, when).fields.timesDone, 1);
  });
});

describe('Templates', () => {
  it('has the five built-ins, which cannot be changed', async () => {
    const db = await freshDb();
    const names = db.listTemplates().map((t) => t.name);
    for (const name of ['Daily journal', 'Weekly review', 'Lecture note', 'Project plan', 'Movie night']) assert(names.includes(name), name);
    assert(BUILTIN_TEMPLATES.every((t) => db.getType(t.typeId).id === t.typeId), 'every built-in points at a real type');
    throwsRule(() => db.deleteTemplate('tpl-project-plan'));
    throwsRule(() => db.updateTemplate('tpl-project-plan', { name: 'x' }));
  });

  it('makes a note, filling in the date', async () => {
    const db = await freshDb();
    const { course } = seed(db);
    const when = Date.parse('2026-03-04T12:00:00');
    const note = db.createFromTemplate('tpl-weekly-review', {}, when);
    assert(note.title.startsWith('Weekly review, ') && note.title.includes('2026'), note.title);
    assert(note.body.includes('What went well'));
    const lecture = db.createFromTemplate('tpl-lecture-note', { collectionId: course.id }, when);
    equal(lecture.typeId, 'course');
    equal(lecture.collectionId, course.id);
    assert(fillPlaceholders('{{weekday}}', when).length > 3);
    throwsRule(() => db.createFromTemplate('nope'));
  });

  it('gives each note its own task ids', async () => {
    const db = await freshDb();
    const a = db.createFromTemplate('tpl-movie-night');
    const b = db.createFromTemplate('tpl-movie-night');
    equal(a.fields.items.length, 3);
    assert(a.fields.items[0].id !== b.fields.items[0].id);
    assert(a.fields.items.every((t) => !t.done));
  });

  it('saves a note as a template', async () => {
    const db = await freshDb();
    const source = db.createNote({
      title: 'My plan', body: '<p>Steps</p>', typeId: 'checklist', fields: { items: [{ id: 'x', text: 'One', done: true, doneAt: 1, children: [] }] },
    });
    db.addTag(source.id, 'kept');
    const template = db.saveNoteAsTemplate(source.id, { name: 'Plan' });
    const note = db.createFromTemplate(template.id);
    equal(note.title, 'My plan');
    equal(note.typeId, 'checklist');
    equal(note.tagIds, db.getNote(source.id).tagIds, 'tags come along');
    assert(!note.fields.items[0].done, 'tasks start unticked');
    assert(note.fields.items[0].id !== 'x');
    equal(db.listTemplates().filter((t) => !t.builtin).length, 1);
  });

  it('leaves dates out of a saved template', async () => {
    const db = await freshDb();
    const source = db.createNote({ title: 'M', typeId: 'meeting', fields: { date: '2020-01-01', attendees: ['A'] } });
    const template = db.saveNoteAsTemplate(source.id, { name: 'T' });
    assert(!('date' in template.fields));
    equal(template.fields.attendees, ['A']);
  });

  it('copes with a deleted type and deleted tags', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'Temp', fields: [] });
    const source = db.createNote({ title: 'S', typeId: type.id });
    const tag = db.addTag(source.id, 'gone');
    const template = db.saveNoteAsTemplate(source.id, { name: 'T' });
    db.deleteType(type.id);
    db.deleteTag(tag.id);
    const note = db.createFromTemplate(template.id);
    equal(note.typeId, 'free');
    equal(note.tagIds, []);
  });

  it('round-trips through a backup, refusing fake built-ins', async () => {
    const db = await freshDb();
    const source = db.createNote({ title: 'S', body: '<p>B<script>x</script></p>' });
    db.saveNoteAsTemplate(source.id, { name: 'Mine' });
    const backup = JSON.parse(JSON.stringify(await buildExport(db)));
    backup.data.templates.push({ id: 'tpl-project-plan', name: 'Fake', body: 'x' }, { name: 'no id' }, { id: 't9', name: 'Bad', body: '<img src=x onerror=y>' });
    const parsed = parseImport(JSON.stringify(backup));
    assert(parsed.ok);
    const other = await freshDb();
    await applyImport(other, parsed.data, 'merge');
    const own = other.listTemplates().filter((t) => !t.builtin).map((t) => t.name).sort();
    equal(own, ['Bad', 'Mine']);
    assert(!other.getTemplate('t9').body.includes('onerror'));
    equal(other.getTemplate('tpl-project-plan').name, 'Project plan');
    equal(cleanTemplate(null), null);
  });
});

describe('Tidy up', () => {
  const types = { getType: () => ({ fields: [] }) };

  it('measures edit distance', () => {
    equal(editDistance('kitten', 'sitting'), 3);
    equal(editDistance('same', 'same'), 0);
    assert(editDistance('abc', 'xyzzzzzz', 2) > 2, 'stops early');
  });

  it('knows which titles look alike', () => {
    assert(titlesLookAlike('meetingnotes', 'meetingnote'));
    assert(titlesLookAlike('abc', 'abc'), 'short titles must match exactly');
    assert(!titlesLookAlike('abc', 'abd'));
    assert(!titlesLookAlike('lecture3', 'lecture4'), 'different numbers');
    assert(!titlesLookAlike('groceries', 'philosophy'));
  });

  it('groups near-duplicate notes, newest first', async () => {
    const db = await freshDb();
    db.createNote({ title: 'Meeting notes', now: 1000 });
    const newest = db.createNote({ title: 'meeting notes!', now: 3000 });
    db.createNote({ title: 'Meeting note', now: 2000 });
    db.createNote({ title: 'Lecture 3' });
    db.createNote({ title: 'Lecture 4' });
    db.createNote({ title: '' });
    db.createNote({ title: '' });
    const groups = findDuplicateGroups(db.listNotes(), (id) => db.getType(id));
    equal(groups.length, 1);
    equal(groups[0].length, 3);
    equal(groups[0][0].id, newest.id);
  });

  it('ignores titles made by a type, such as journal dates', async () => {
    const db = await freshDb();
    db.createNote({ typeId: 'journal', fields: { date: '2026-01-01' } });
    db.createNote({ typeId: 'journal', fields: { date: '2026-01-02' } });
    equal(findDuplicateGroups(db.listNotes(), (id) => db.getType(id)), []);
  });

  it('finds empty notes but not ones with only a title', async () => {
    const db = await freshDb();
    const empty = db.createNote({});
    db.createNote({ title: 'Just a title' });
    db.createNote({ body: '<p>Text</p>' });
    const found = findEmptyNotes(db.listNotes(), (id) => db.getType(id));
    equal(found.map((n) => n.id), [empty.id]);
    assert(types);
  });

  it('finds notes not opened for a long time, sparing pinned and favorite ones', async () => {
    const db = await freshDb();
    const now = Date.parse('2026-06-01T12:00:00');
    const old = now - 400 * DAY_MS;
    const stale = db.createNote({ title: 'Old', now: old });
    const pinned = db.createNote({ title: 'Pinned', now: old });
    db.setPinned(pinned.id, true);
    const fav = db.createNote({ title: 'Fav', now: old });
    db.setFavorite(fav.id, true);
    db.createNote({ title: 'New', now });
    equal(findStaleNotes(db.listNotes(), 365, now).map((n) => n.id), [stale.id]);
    equal(findStaleNotes(db.listNotes(), 500, now), []);
  });

  it('stays fast on 5,000 notes', async () => {
    const db = await freshDb();
    db.batch(() => {
      for (let i = 0; i < 5000; i += 1) db.createNote({ title: `Note about topic ${i % 700} part ${i}` });
    });
    const started = performance.now();
    findDuplicateGroups(db.listNotes(), (id) => db.getType(id));
    assert(performance.now() - started < 1500, `${performance.now() - started} ms`);
  });
});

describe('Application trackers', () => {
  it('opens job and PhD applications as a board by status', async () => {
    const db = await freshDb();
    for (const id of ['jobApplication', 'phdApplication']) {
      const type = db.getType(id);
      equal(type.defaultView, 'kanban');
      assert(viewsFor(type).includes('kanban') && viewsFor(type).includes('table') && viewsFor(type).includes('calendar'), id);
      equal(type.groupBy, 'status');
    }
  });

  it('starts each application with its own checklist', async () => {
    const db = await freshDb();
    const a = db.createNote({ typeId: 'phdApplication', title: 'PhD in ML' });
    const b = db.createNote({ typeId: 'phdApplication', title: 'PhD in NLP' });
    const tasks = (note) => flatten(fieldValue(note, db.getType('phdApplication').fields.find((f) => f.id === 'documents'))).map(({ item }) => item);
    equal(tasks(a).map((t) => t.text).slice(0, 3), ['CV', 'Research proposal', 'Motivation letter']);
    const ids = [...tasks(a), ...tasks(b)].map((t) => t.id);
    equal(new Set(ids).size, ids.length, 'task ids are never shared between notes');
    equal(fieldValue(a, db.getType('phdApplication').fields.find((f) => f.id === 'status')), 'Researching');
  });

  it('counts an untouched application as blank, and a ticked one as not', async () => {
    const db = await freshDb();
    const type = db.getType('jobApplication');
    const note = db.createNote({ typeId: 'jobApplication' });
    assert(isBlankNote(note, type), 'untouched');
    const [first] = fieldValue(note, type.fields.find((f) => f.id === 'todo'));
    db.updateTasks(note.id, 'todo', (items) => updateTask(items, first.id, { done: true }));
    assert(!isBlankNote(db.getNote(note.id), type), 'ticked');
  });

  it('only keeps a deadline while it still matters', async () => {
    const db = await freshDb();
    const type = db.getType('jobApplication');
    const deadline = type.fields.find((f) => f.id === 'deadline');
    const interview = type.fields.find((f) => f.id === 'interview');
    const note = db.createNote({ typeId: 'jobApplication', title: 'Analyst', fields: { deadline: '2026-11-20', interview: '2026-12-01' } });
    assert(dueIsOpen(note, type, deadline) && !dueIsOpen(note, type, interview), 'interested: the deadline counts');
    equal(noteDueDate(note, type), '2026-11-20');
    const applied = db.updateNote(note.id, { fields: { ...note.fields, status: 'Applied' } });
    assert(!dueIsOpen(applied, type, deadline) && dueIsOpen(applied, type, interview), 'applied: the interview counts');
    equal(noteDueDate(applied, type), '2026-12-01');
    const rejected = db.updateNote(note.id, { fields: { ...applied.fields, status: 'Rejected' } });
    equal(noteDueDate(rejected, type), '', 'nothing left to do');
    assert(dueIsOpen(db.createNote({ typeId: 'goal' }), db.getType('goal'), db.getType('goal').fields.find((f) => f.id === 'deadline')), 'other deadlines always count');
  });

  it('fills in the date when an application is sent, once', async () => {
    const db = await freshDb();
    const note = db.createNote({ typeId: 'jobApplication', title: 'Analyst' });
    const applied = db.updateNote(note.id, { fields: { ...note.fields, status: 'Applied' } }, { now: new Date(2026, 10, 11, 9).getTime() });
    equal(applied.fields.appliedOn, '2026-11-11');
    const moved = db.updateNote(note.id, { fields: { ...applied.fields, status: 'Interviewing' } }, { now: new Date(2026, 10, 20, 9).getTime() });
    const back = db.updateNote(note.id, { fields: { ...moved.fields, status: 'Applied' } }, { now: new Date(2026, 10, 21, 9).getTime() });
    equal(back.fields.appliedOn, '2026-11-11', 'a date already there is kept');
    const phd = db.createNote({ typeId: 'phdApplication', fields: { status: 'Submitted', submittedOn: '2026-10-01' } });
    equal(db.updateNote(phd.id, { fields: { ...phd.fields, status: 'Submitted' } }).fields.submittedOn, '2026-10-01', 'no change, no stamp');
    const other = db.updateNote(phd.id, { fields: { ...phd.fields, status: 'Preparing' } });
    const submitted = db.updateNote(phd.id, { fields: { ...other.fields, submittedOn: '', status: 'Submitted' } }, { now: new Date(2026, 10, 12, 9).getTime() });
    equal(submitted.fields.submittedOn, '2026-11-12');
  });

  it('names an application with its company in agendas', async () => {
    const db = await freshDb();
    const type = db.getType('jobApplication');
    equal(agendaTitle(db.createNote({ typeId: 'jobApplication', title: 'Data analyst', fields: { company: 'Spotify' } }), type), 'Data analyst · Spotify');
    equal(agendaTitle(db.createNote({ typeId: 'jobApplication', title: 'Data analyst' }), type), 'Data analyst');
    equal(agendaTitle(db.createNote({ typeId: 'goal', title: 'Run' }), db.getType('goal')), 'Run');
  });

  it('keeps the tracker settings in a copied type, also through a backup', async () => {
    const db = await freshDb();
    const copy = db.duplicateType('jobApplication');
    const cleaned = cleanType(JSON.parse(JSON.stringify(copy)));
    const field = (id) => cleaned.fields.find((f) => f.id === id);
    equal(field('deadline').role, 'due');
    equal(field('deadline').openWhile, { field: 'status', values: ['', 'Interested', 'Preparing'] });
    equal(field('deadline').dueLabel, 'Apply');
    equal(field('status').stamps, { Applied: 'appliedOn' });
    equal(field('status').default, 'Interested');
    equal(field('todo').starter, ['Tailor CV', 'Write cover letter', 'Send application']);
    const junk = cleanType({ id: 'x', name: 'x', fields: [{ id: 'd', kind: 'text', role: 'due', openWhile: 'nope', starter: [1] }, { id: 's', kind: 'select', stamps: [1] }] });
    assert(!junk.fields[0].role && !junk.fields[0].openWhile && !junk.fields[0].starter && !junk.fields[1].stamps, 'junk is dropped');
  });
});

describe('Weekly review data', () => {
  it('finds the first day of a week', () => {
    equal(weekStartOf('2026-11-08', 1), '2026-11-02', 'Sunday, weeks from Monday');
    equal(weekStartOf('2026-11-08', 0), '2026-11-08', 'Sunday, weeks from Sunday');
    equal(weekStartOf('2026-11-09', 1), '2026-11-09');
  });

  it('counts each completion of repeating tasks', () => {
    equal(completionTimes({ done: true, doneAt: 5 }), [5]);
    equal(completionTimes({ done: false, history: [1, 2] }), [1, 2]);
    equal(completionTimes({ done: false }), []);
  });

  it('gathers what needs attention', async () => {
    const db = await freshDb();
    const { school, course } = seed(db);
    const now = Date.parse('2026-11-08T12:00:00');
    db.createNote({ title: 'Inbox one' });
    const root = db.createNote({ title: 'No collection', spaceId: school.id });
    const tagged = db.createNote({ title: 'Tagged', collectionId: course.id });
    db.addTag(tagged.id, 'x');
    db.createNote({ title: 'Secret', spaceId: school.id, typeId: 'journal', fields: { date: '2026-11-07' } });
    db.createNote({
      title: 'List',
      collectionId: course.id,
      fields: {},
      typeId: 'checklist',
      now,
    });
    const list = db.listNotes().find((n) => n.title === 'List');
    db.updateNote(list.id, {
      fields: {
        items: [
          { id: 'a', text: 'Done this week', done: true, doneAt: Date.parse('2026-11-06T09:00:00'), children: [] },
          { id: 'b', text: 'Done long ago', done: true, doneAt: Date.parse('2026-01-06T09:00:00'), children: [] },
          { id: 'c', text: 'Repeats', history: [Date.parse('2026-11-07T09:00:00')], repeat: 'daily', due: '2026-11-09', children: [] },
        ],
      },
    });
    const data = weeklyReviewData(db, { now, weekStart: 1 });
    equal(data.inboxCount, 1);
    equal(data.noCollection.map((n) => n.id), [root.id], 'private notes do not nag');
    assert(data.untagged.some((n) => n.id === root.id) && !data.untagged.some((n) => n.id === tagged.id));
    equal(data.completed.map((c) => c.text).sort(), ['Done this week', 'Repeats']);
    equal(data.journalDays, 1);
    equal(completedTasks([db.getNote(list.id)], db).length, 3);
  });
});

describe('Version history', () => {
  it('keeps versions, newest first, without repeats', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'One', body: '<p>a</p>' });
    await db.snapshotNote(note.id, null, 100);
    equal(await db.snapshotNote(note.id, null, 200), false, 'same content is not stored twice');
    db.updateNote(note.id, { title: 'Two' });
    await db.snapshotNote(note.id, null, 300);
    equal((await db.listVersions(note.id)).map((v) => v.title), ['Two', 'One']);
  });

  it('keeps only the last 20', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'v0' });
    for (let i = 1; i <= 25; i += 1) {
      db.updateNote(note.id, { title: `v${i}` });
      await db.snapshotNote(note.id, null, i);
    }
    const versions = await db.listVersions(note.id);
    equal(versions.length, 20);
    equal(versions[0].title, 'v25');
    equal(versions.at(-1).title, 'v6');
  });

  it('restores a version, keeping what it replaces', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'First', body: '<p>old</p>' });
    await db.snapshotNote(note.id, null, 100);
    db.updateNote(note.id, { title: 'Second', body: '<p>new</p>' });
    await db.restoreVersion(note.id, 100);
    const restored = db.getNote(note.id);
    equal(restored.title, 'First');
    equal(restored.body, '<p>old</p>');
    equal(restored.text, 'old');
    assert((await db.listVersions(note.id)).some((v) => v.title === 'Second'), 'the replaced state is kept');
    let refused = false;
    await db.restoreVersion(note.id, 999).catch((error) => { refused = error instanceof RuleError; });
    assert(refused, 'a missing version is refused');
  });

  it('restore handles a deleted tag and type', async () => {
    const db = await freshDb();
    const type = db.createType({ name: 'T', fields: [] });
    const note = db.createNote({ title: 'A', typeId: type.id });
    const tag = db.addTag(note.id, 'gone');
    await db.snapshotNote(note.id, null, 100);
    db.deleteTag(tag.id);
    db.deleteType(type.id);
    await db.restoreVersion(note.id, 100);
    equal(db.getNote(note.id).typeId, 'free');
    equal(db.getNote(note.id).tagIds, []);
  });

  it('deleting forever removes versions too', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A' });
    await db.snapshotNote(note.id);
    db.purgeNotes([note.id]);
    await db.flush();
    equal(await db.listVersions(note.id), []);
  });

  it('cleans up versions of notes that are gone', async () => {
    const db = await freshDb();
    await db.storage.commit([{ store: 'versions', id: 'ghost', value: { id: 'ghost', items: [] } }]);
    const note = db.createNote({ title: 'A' });
    await db.snapshotNote(note.id);
    await db.flush();
    equal(await db.collectOrphanVersions(), 1);
    equal(await db.storage.keys('versions'), [note.id]);
  });

  it('images in old versions and templates are not cleaned up', async () => {
    const db = await freshDb();
    const png = 'data:image/png;base64,AAAA';
    const old = Date.now() - 10 * DAY_MS;
    await db.putAsset({ id: 'inversion', mime: 'image/png', dataUrl: png, created: old });
    await db.putAsset({ id: 'intemplate', mime: 'image/png', dataUrl: png, created: old });
    await db.putAsset({ id: 'unused', mime: 'image/png', dataUrl: png, created: old });
    const note = db.createNote({ title: 'A', body: '<p><img data-asset="inversion" alt=""></p>' });
    await db.snapshotNote(note.id);
    db.updateNote(note.id, { body: '<p>gone</p>' });
    const other = db.createNote({ title: 'B', body: '<p><img data-asset="intemplate" alt=""></p>' });
    db.saveNoteAsTemplate(other.id, { name: 'T' });
    db.updateNote(other.id, { body: '' });
    await db.flush();
    await db.collectOrphanAssets();
    assert(await db.getAsset('inversion'), 'kept for the old version');
    assert(await db.getAsset('intemplate'), 'kept for the template');
    assert(!await db.getAsset('unused'), 'really unused images go');
  });

  it('round-trips through a backup, sanitizing old bodies', async () => {
    const db = await freshDb();
    const note = db.createNote({ title: 'A', body: '<p>v1</p>' });
    await db.snapshotNote(note.id, null, 100);
    await db.flush();
    const backup = JSON.parse(JSON.stringify(await buildExport(db)));
    backup.data.versions[0].items.push({ at: 200, title: 'Evil', body: '<img src=x onerror=y><script>z</script>' }, 'junk');
    backup.data.versions.push({ id: 'x', items: 'nope' });
    const parsed = parseImport(JSON.stringify(backup));
    assert(parsed.ok);
    const other = await freshDb();
    await applyImport(other, parsed.data, 'merge');
    const versions = await other.listVersions(note.id);
    equal(versions.length, 2);
    assert(!versions[0].body.includes('onerror') && !versions[0].body.includes('script'), versions[0].body);
  });
});


describe('Passcode lock', () => {
  const SECRET = 'my very private words';

  async function lockedWorld() {
    const inner = new MemoryAdapter();
    const db = new NotesDb(inner, { channelName: `lock-${Math.random()}` });
    await db.open();
    const note = db.createNote({ title: SECRET, body: `<p>${SECRET}</p>` });
    await db.putAsset({ id: 'img1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    await db.snapshotNote(note.id);
    await db.flush();
    return { inner, db, note };
  }
  const rawText = async (inner) => {
    const parts = [];
    for (const store of STORES) {
      for (const record of await inner.getAll(store)) {
        parts.push(JSON.stringify(record, (key, value) => (value instanceof Uint8Array ? `bytes:${value.length}` : value)));
      }
    }
    return parts.join('\n');
  };

  it('is available in this browser', () => assert(isCryptoAvailable()));

  it('encrypts and decrypts values, as bytes or text', async () => {
    const { key } = await createLock('secret-code');
    const value = { id: 'x', text: 'héllo 🌿', list: [1, 2] };
    equal(await decryptValue(key, await encryptValue(key, value)), value);
    equal(await decryptValue(key, await encryptValue(key, value, { asText: true })), value);
    const a = await encryptValue(key, value);
    const b = await encryptValue(key, value);
    assert(a.join() !== b.join(), 'the same value encrypts differently every time');
  });

  it('refuses a wrong passcode', async () => {
    const { record } = await createLock('right-code');
    let refused = false;
    await openLock(record, 'wrong-code').catch((error) => { refused = error instanceof WrongPasscodeError; });
    assert(refused);
    assert(await openLock(record, 'right-code'));
  });

  it('leaves no readable text in storage', async () => {
    const { inner, db } = await lockedWorld();
    assert((await rawText(inner)).includes(SECRET), 'readable before');
    db.storage = await enableLock(inner, STORES, 'right-code');
    const raw = await rawText(inner);
    assert(!raw.includes(SECRET), 'note text is gone from storage');
    assert(!raw.includes('data:image'), 'image data is gone from storage');
    assert(!raw.includes('body'), 'field names are gone too');
    assert(await readLock(inner), 'the lock record is there');
  });

  it('never stores the passcode', async () => {
    const { inner } = await lockedWorld();
    await enableLock(inner, STORES, 'distinctive-passcode');
    assert(!(await rawText(inner)).includes('distinctive-passcode'));
  });

  it('opens everything again with the passcode', async () => {
    const { inner, db, note } = await lockedWorld();
    await enableLock(inner, STORES, 'right-code');
    db.close();
    const key = await openLock(await readLock(inner), 'right-code');
    const reopened = new NotesDb(new EncryptedAdapter(inner, key), { channelName: `lock-${Math.random()}` });
    await reopened.open();
    equal(reopened.getNote(note.id).title, SECRET);
    equal((await reopened.getAsset('img1')).dataUrl, 'data:image/png;base64,AAAA');
    equal((await reopened.listVersions(note.id)).length, 1);
    reopened.updateNote(note.id, { title: 'Changed', body: '<p>new private</p>' });
    await reopened.flush();
    assert(!(await rawText(inner)).includes('new private'), 'new edits are encrypted as well');
    const again = new NotesDb(new EncryptedAdapter(inner, key), { channelName: `lock-${Math.random()}` });
    await again.open();
    equal(again.getNote(note.id).title, 'Changed');
  });

  it('the wrong key reads nothing', async () => {
    const { inner } = await lockedWorld();
    await enableLock(inner, STORES, 'right-code');
    const { key: other } = await createLock('other-code');
    const db = new NotesDb(new EncryptedAdapter(inner, other), { channelName: `lock-${Math.random()}` });
    await db.open();
    equal(db.data.notes.size, 0, 'unreadable records are skipped, not shown as junk');
  });

  it('turning it off restores plain storage', async () => {
    const { inner, db, note } = await lockedWorld();
    db.storage = await enableLock(inner, STORES, 'right-code');
    db.storage = await disableLock(db.storage, STORES);
    equal(await readLock(inner), undefined);
    assert((await rawText(inner)).includes(SECRET));
    const again = new NotesDb(inner, { channelName: `lock-${Math.random()}` });
    await again.open();
    equal(again.getNote(note.id).title, SECRET);
  });

  it('changing the passcode keeps the notes', async () => {
    const { inner, db, note } = await lockedWorld();
    const adapter = await enableLock(inner, STORES, 'old-code');
    db.close();
    let refused = false;
    await changePasscode(adapter, 'not-it', 'new-code').catch((error) => { refused = error instanceof WrongPasscodeError; });
    assert(refused, 'needs the current passcode');
    await changePasscode(adapter, 'old-code', 'new-code');
    let oldFails = false;
    await openLock(await readLock(inner), 'old-code').catch(() => { oldFails = true; });
    assert(oldFails, 'the old passcode stops working');
    const key = await openLock(await readLock(inner), 'new-code');
    const reopened = new NotesDb(new EncryptedAdapter(inner, key), { channelName: `lock-${Math.random()}` });
    await reopened.open();
    equal(reopened.getNote(note.id).title, SECRET);
  });

  it('works over localStorage too', async () => {
    const name = `lock-test-${Date.now()}`;
    const inner = new LocalStorageAdapter(name);
    await inner.open();
    const db = new NotesDb(inner, { channelName: name });
    await db.open();
    const note = db.createNote({ title: SECRET });
    await db.flush();
    await enableLock(inner, STORES, 'right-code');
    const key = await openLock(await readLock(inner), 'right-code');
    const reopened = new NotesDb(new EncryptedAdapter(inner, key), { channelName: `${name}-2` });
    await reopened.open();
    equal(reopened.getNote(note.id).title, SECRET);
    const stored = Object.keys(localStorage).filter((k) => k.startsWith(name)).map((k) => localStorage.getItem(k)).join();
    assert(!stored.includes(SECRET));
    await inner.clear();
  });

  it('a backup from a locked app can be imported into a plain one', async () => {
    const { inner, db, note } = await lockedWorld();
    db.storage = await enableLock(inner, STORES, 'right-code');
    const backup = await buildExport(db);
    const parsed = parseImport(JSON.stringify(backup));
    assert(parsed.ok);
    const other = await freshDb();
    await applyImport(other, parsed.data, 'replace');
    equal(other.getNote(note.id).title, SECRET);
  });
});

describe('Statistics', () => {
  it('counts notes per space, biggest first, with the Inbox last', async () => {
    const db = await freshDb();
    const { school, fun } = seed(db);
    db.createNote({ spaceId: fun.id, title: 'a' });
    db.createNote({ spaceId: fun.id, title: 'b' });
    db.createNote({ spaceId: school.id, title: 'c' });
    db.createNote({ title: 'inbox' });
    const rows = notesPerSpace(db);
    equal(rows.map((r) => r.value), [2, 1, 1]);
    assert(rows[0].label.includes('Fun'));
    assert(rows.at(-1).label.includes('Inbox'));
  });

  it('counts tasks per week, including empty weeks and repeats', async () => {
    const db = await freshDb();
    const today = '2026-11-08';
    db.createNote({
      title: 'L',
      typeId: 'checklist',
      fields: {
        items: [
          { id: 'a', text: 'a', done: true, doneAt: Date.parse('2026-11-05T10:00:00'), children: [] },
          { id: 'b', text: 'b', repeat: 'daily', due: '2026-11-09', history: [Date.parse('2026-11-04T10:00:00'), Date.parse('2026-10-20T10:00:00')], children: [] },
          { id: 'c', text: 'old', done: true, doneAt: Date.parse('2020-01-01T10:00:00'), children: [] },
          { id: 'd', text: 'open', children: [] },
        ],
      },
    });
    const rows = tasksPerWeek(db, { today, weekStart: 1, weeks: 12 });
    equal(rows.length, 12);
    equal(rows.at(-1).date, '2026-11-02');
    equal(rows.at(-1).value, 2, 'this week');
    equal(rows.find((r) => r.date === '2026-10-19').value, 1, 'a repeat counts each time');
    equal(rows.reduce((sum, r) => sum + r.value, 0), 3, 'the old one is outside the range');
  });

  it('counts watched titles per month', async () => {
    const db = await freshDb();
    const mk = (fields) => db.createNote({ title: 't', typeId: 'watchlist', fields });
    mk({ status: 'Watched', dateWatched: '2026-11-02' });
    mk({ status: 'Watched', dateWatched: '2026-03-02' });
    mk({ status: 'To watch', dateWatched: '2026-11-02' });
    const rows = watchedPerMonth(db, { today: '2026-11-08', months: 12 });
    equal(rows.length, 12);
    equal(rows.at(-1).value, 1);
    equal(rows.find((r) => r.date === '2026-03').value, 1);
    equal(rows[0].date, '2025-12');
  });

  it('chooses clean axis numbers', () => {
    equal(niceScale(0).top, 4);
    equal(niceScale(1).ticks, [0, 1]);
    equal(niceScale(7).top, 8);
    assert(niceScale(37).ticks.every((t) => t % 5 === 0 || t % 10 === 0));
    assert(niceScale(1234).top >= 1234);
  });
});

describe('Offline files', () => {
  it('lists every file the service worker should keep, and they all exist', async () => {
    const source = await (await fetch('../sw.js'.replace('../', ''))).text();
    const files = [...source.slice(source.indexOf('const FILES'), source.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert(files.length > 100, `only ${files.length} files`);
    for (const file of files) {
      const response = await fetch(file);
      assert(response.ok, `${file} is missing`);
    }
  });
});

async function run() {
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  let passed = 0;
  const failures = [];

  for (const { name, tests } of groups) {
    const list = document.createElement('ul');
    const heading = document.createElement('h2');
    heading.textContent = name;
    results.append(heading, list);
    for (const test of tests) {
      const item = document.createElement('li');
      const start = performance.now();
      try {
        await test.fn();
        passed += 1;
        item.className = 'ok';
        item.textContent = test.name;
      } catch (error) {
        failures.push({ group: name, test: test.name, error: String(error?.message ?? error) });
        item.className = 'bad';
        item.textContent = test.name;
        const detail = document.createElement('pre');
        detail.textContent = String(error?.stack ?? error);
        item.append(detail);
      }
      const ms = document.createElement('span');
      ms.className = 'ms';
      ms.textContent = ` ${Math.round(performance.now() - start)} ms`;
      item.append(ms);
      list.append(item);
    }
  }

  const total = passed + failures.length;
  summary.textContent = failures.length
    ? `${failures.length} of ${total} tests failed`
    : `All ${total} tests passed`;
  summary.classList.add(failures.length ? 'fail' : 'pass');
  window.__testResults = { passed, failed: failures.length, failures };
}

run();
