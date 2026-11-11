/**
 * dashboardWidgets.js: each dashboard widget. A widget gets { db, options, today, refresh, timers,
 * state } and returns its card, or null when it has nothing to show. A widget with a little to
 * say stays as a one-line "All clear" card, so the layout doesn't jump around.
 *
 * Journal entries are private: the journal check-in only shows a prompt, a streak and today's
 * mood and energy buttons, and On this day only includes entries when its option says so.
 */
import {
  addDays, firstDayOfWeek, formatDay, relativeDay, toDateStr,
} from '../data/dates.js';
import { MOODS, fieldValue } from '../data/fieldKinds.js';
import { habitStreak, lastWeek } from '../data/habits.js';
import { entryDate, streaks } from '../data/journal.js';
import { donePatch, pickOne, pickerCandidates } from '../data/picker.js';
import { reviewQueue } from '../data/review.js';
import { dayAgenda, weekAgenda } from '../data/agenda.js';
import { weekEventEntries } from '../data/calendarTimetable.js';
import { eventEntries } from '../data/googleCalendar.js';
import { flatten } from '../data/tasks.js';
import { findDuplicateGroups, findEmptyNotes, findStaleNotes } from '../data/tidy.js';
import { displayTitle, summaryFields, tasksFields } from '../data/types.js';
import { completedTasks, weekStartOf } from '../data/weekly.js';
import { scheduleAt, startOfWeek, startsIn } from '../data/timetable.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { newNote, withUndo } from './actions.js';
import { collectCards } from './courseViews.js';
import { fieldDisplay } from './fieldWidgets.js';
import { openHabitsDialog } from './habitsDialog.js';
import { refreshWeekEvents } from './calendarConnection.js';
import { noteList } from './noteList.js';
import { homeForType } from './palette.js';
import { openQuiz } from './quiz.js';
import {
  agendaRow, allTaskNotes, collectDeadlines, collectTasks, globalBuckets, tickTask,
} from './tasksAgenda.js';
import { progressBar } from './tasksField.js';
import { calendarEventItems, loadOccurrences } from './timetable.js';
import { exportBackup } from './transfer.js';

// Fewer rows on a phone, so the first four widgets fit on the first screen.
const listLimit = () => (window.matchMedia('(max-width: 560px)').matches ? 3 : 5);
const PROMPTS = [
  'What is on your mind today?',
  'What made today different from yesterday?',
  'What are you looking forward to?',
  'What would make tomorrow easier?',
  'Who did you think about today?',
  'What did you learn this week?',
  'What are you putting off, and why?',
  'What felt good recently?',
  'What would you tell yourself a year ago?',
  'What do you want to remember about this week?',
];

export const card = (title, href, ...content) => h('section', { class: 'dash-card' },
  h('h2', { class: 'section-title' }, href ? h('a', { class: 'dash-title-link', href }, title) : title),
  content);

/** A widget with nothing to do today: one short line. */
const allClear = (title, href, text) => h('section', { class: 'dash-card dash-clear' },
  h('h2', { class: 'section-title' }, href ? h('a', { class: 'dash-title-link', href }, title) : title),
  h('p', { class: 'dash-clear-text' }, icon('check', 14), text));

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const inCollection = (db, note, collectionId) => {
  if (!collectionId) return true;
  if (note.collectionId === collectionId) return true;
  return db.getCollection(note.collectionId)?.parentId === collectionId;
};

const visible = (db) => {
  const showPrivate = db.getSettings().showPrivateOnHome === true;
  return db.listNotes().filter((note) => showPrivate || !note.private);
};

const noteLink = (db, note, extra) => h('a', { class: 'dash-note', href: `#/note/${encodeURIComponent(note.id)}`, dataset: { id: note.id } },
  h('span', { class: 'dash-note-title' }, displayTitle(note, db.getType(note.typeId)) || 'Untitled'),
  extra && h('span', { class: 'dash-note-meta' }, extra));

/** One row of Your day: time, what it is, and a checkbox for anything that can be ticked. */
function dayRow(db, item, today, refresh) {
  const entry = item.source;
  const tickable = item.kind === 'task' || item.kind === 'event';
  const href = item.kind === 'block'
    ? `#/timetable?date=${today}&view=day`
    : item.kind === 'event' ? entry.url || null : `#/note/${encodeURIComponent(entry.noteId)}`;
  const where = item.kind === 'block'
    ? [`until ${item.end}`, entry.location].filter(Boolean).join(' · ')
    : item.kind === 'event' ? 'Google Calendar' : entry.noteTitle;
  const tag = item.when === 'now' ? 'Now' : item.when === 'next' ? 'Next' : item.overdue ? `Overdue, ${relativeDay(item.date, today).toLowerCase()}` : item.kind === 'deadline' ? 'Deadline' : '';
  return h('li', { class: `day-row is-${item.kind}${item.done ? ' is-done' : ''}${item.when ? ` is-${item.when}` : ''}`, dataset: { id: item.key, ...(item.kind === 'block' ? { color: entry.color } : {}) } },
    h('span', { class: 'day-time' }, item.time || ''),
    tickable
      ? h('input', {
        class: 'task-check',
        type: 'checkbox',
        checked: item.done,
        'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
        onChange: () => {
          tickTask(entry, today);
          refresh(`[data-id="${CSS.escape(item.key)}"] input`);
        },
      })
      : h('span', { class: 'day-mark', 'aria-hidden': 'true', dataset: item.kind === 'block' ? { color: entry.color } : {} }, item.kind === 'deadline' ? icon('flag', 14) : null),
    h('span', { class: 'day-main' },
      href
        ? h('a', {
          class: 'day-title', href, ...(item.kind === 'event' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        }, item.title)
        : h('span', { class: 'day-title' }, item.title),
      where && h('span', { class: 'day-where' }, where)),
    tag && h('span', { class: `chip day-tag${item.overdue ? ' chip-overdue' : ''}` }, tag));
}

const agendaEntries = (db, today) => {
  const notes = allTaskNotes();
  return [...collectTasks(notes), ...collectDeadlines(notes), ...eventEntries(db, today)];
};

/** Monday to Sunday, unless Settings names another first day: the same week as the timetable. */
const weekFrom = (db, today) => {
  const setting = db.getSettings().weekStart;
  return startOfWeek(today, !setting || setting === 'auto' ? 1 : firstDayOfWeek(setting));
};

export const WIDGET_VIEWS = {
  day({ db, today, timers, refresh }) {
    const occurrences = loadOccurrences(db, today, today);
    const entries = agendaEntries(db, today);
    if (!dayAgenda({ occurrences, entries }, today, nowTime()).all.length) {
      return allClear('Your day', '#/today', 'Nothing planned for today.');
    }
    const box = h('div');
    const draw = () => {
      const { timed, untimed, all } = dayAgenda({ occurrences, entries }, today, nowTime());
      const limit = window.matchMedia('(max-width: 560px)').matches ? 4 : 9;
      // What's still ahead matters most: things already over make way when space is short.
      const ahead = timed.filter((i) => i.when !== 'past');
      const past = timed.filter((i) => i.when === 'past');
      const rows = [...(all.length > limit ? ahead : timed), ...untimed].slice(0, limit);
      const hidden = all.length - rows.length;
      const open = all.filter((i) => (i.kind === 'task' || i.kind === 'event') && !i.done).length;
      const blocks = all.filter((i) => i.kind === 'block').length;
      fill(box,
        h('p', { class: 'dash-stat day-summary' }, [blocks && plural(blocks, 'block'), open && `${plural(open, 'thing')} to do`].filter(Boolean).join(' · ') || 'All done for today'),
        h('ul', { class: 'day-list' }, rows.map((item) => dayRow(db, item, today, refresh))),
        hidden > 0 && h('a', { class: 'btn-link', href: '#/today' }, all.length > limit && past.length ? `${hidden} more, ${past.length} already over` : `${hidden} more`));
    };
    draw();
    timers.push(setInterval(draw, 60000));
    return card(`Your day · ${formatDay(today, { weekday: 'long' })}`, '#/today', box);
  },

  week({ db, today }) {
    const from = weekFrom(db, today);
    const to = addDays(from, 6);
    // Google Calendar's events for the rest of the week, as last read. Today's come with the day's own.
    refreshWeekEvents(from);
    const entries = [...agendaEntries(db, today), ...(calendarEventItems(db, from, to).length ? weekEventEntries(db, from, to, today) : [])];
    const { days, totals } = weekAgenda({ occurrences: loadOccurrences(db, from, to), entries }, from, today);
    const habits = db.listHabits();
    const elapsed = days.filter((d) => d.date <= today);
    const habitTicks = habits.reduce((sum, habit) => sum + elapsed.filter((d) => habit.done[d.date]).length, 0);
    const journalDays = new Set(db.listNotes().filter((n) => n.typeId === 'journal').map(entryDate).filter((d) => d >= from && d <= to)).size;
    if (!days.some((d) => d.items.length) && !habits.length && !journalDays) {
      return allClear('Your week', '#/timetable', 'Nothing planned this week yet.');
    }
    const hours = (minutes) => `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
    const mark = (item) => (item.kind === 'deadline' ? '⚑ ' : item.kind === 'block' || item.kind === 'event' ? '' : item.done ? '✓ ' : '○ ');
    const stat = (value, label) => h('div', { class: 'week-stat' }, h('span', { class: 'week-stat-value' }, value), h('span', { class: 'week-stat-label' }, label));
    return card(`Your week · ${formatDay(from, { month: 'short', day: 'numeric' })} – ${formatDay(to, { month: 'short', day: 'numeric' })}`, '#/timetable',
      h('ol', { class: 'week-days' }, days.map((day) => {
        const shown = day.items.slice(0, 4);
        const left = day.items.length - shown.length;
        const state = day.date === today ? ' is-today' : day.date < today ? ' is-past' : '';
        return h('li', { class: `week-day${state}` },
          h('a', { class: 'week-day-head', href: `#/timetable?date=${day.date}&view=day` },
            h('span', { class: 'week-day-name' }, formatDay(day.date, { weekday: 'short' })),
            h('span', { class: 'week-day-date' }, formatDay(day.date, { day: 'numeric' })),
            day.date === today && h('span', { class: 'sr-only' }, ', today'),
            h('span', { class: 'week-day-count' }, day.items.length ? String(day.items.length) : ''),
            h('span', { class: 'sr-only' }, day.items.length ? `, ${plural(day.items.length, 'thing')}` : ', nothing planned')),
          h('ul', { class: 'week-day-items' },
            shown.map((item) => h('li', { class: `week-item is-${item.kind}${item.done ? ' is-done' : ''}`, dataset: item.kind === 'block' ? { color: item.source.color } : {} },
              item.time && h('span', { class: 'week-item-time' }, item.time),
              h('span', { class: 'week-item-title' }, mark(item), item.title))),
            left > 0 && h('li', { class: 'week-item week-more' }, `+${left} more`),
            !day.items.length && h('li', { class: 'week-item week-free' }, 'Free')),
          day.minutes > 0 && h('span', { class: 'week-day-hours' }, hours(day.minutes)));
      })),
      h('div', { class: 'week-stats' },
        stat(hours(totals.minutes), 'on your timetable'),
        totals.tasks > 0 && stat(`${totals.tasksDone} of ${totals.tasks}`, 'tasks done'),
        totals.deadlines > 0 && stat(String(totals.deadlines), plural(totals.deadlines, 'deadline').replace(/^\d+ /, '')),
        habits.length > 0 && stat(`${Math.round((habitTicks / (habits.length * elapsed.length)) * 100)}%`, 'of habits ticked'),
        stat(`${journalDays} of ${elapsed.length}`, journalDays === 1 ? 'day in your journal' : 'days in your journal')));
  },


  today({ db, options, today }) {
    const buckets = globalBuckets(today);
    const keep = (entry) => !options.collectionId || inCollection(db, db.getNote(entry.noteId) ?? {}, options.collectionId);
    const rows = [...buckets.overdue, ...buckets.today].filter(keep);
    const overdue = buckets.overdue.filter(keep).length;
    const any = rows.length || buckets.upcoming.some(keep) || buckets.done.some(keep);
    if (!any) return null;
    if (!rows.length) return allClear('Today', '#/today', 'All clear. Nothing due today.');
    const limit = listLimit();
    return card(`Today · ${plural(rows.length, 'task')}${overdue ? `, ${overdue} overdue` : ''}`, '#/today',
      h('ul', { class: 'task-list agenda-list' }, rows.slice(0, limit).map((entry) => agendaRow(entry, today))),
      rows.length > limit && h('a', { class: 'btn-link', href: '#/today' }, `${rows.length - limit} more`));
  },

  schedule({ db, today, timers }) {
    const occurrences = loadOccurrences(db, today, today);
    if (!occurrences.some((o) => !o.cancelled)) return null;
    const box = h('div', { class: 'dash-schedule' });
    const draw = () => {
      const time = nowTime();
      const { current, next, later } = scheduleAt(occurrences, today, time);
      const row = (o, label) => h('a', {
        class: 'schedule-row', href: `#/timetable?date=${today}&view=day`, dataset: { color: o.color, id: o.key },
      },
      h('span', { class: 'schedule-label' }, label),
      h('span', { class: 'schedule-title' }, o.title),
      h('span', { class: 'schedule-time' }, `${o.start}–${o.end}${o.location ? ` · ${o.location}` : ''}`));
      fill(box,
        current && row(current, `Now, until ${current.end}`),
        next && row(next, `Next, ${startsIn(time, next.start)}`),
        !current && !next && h('p', { class: 'dash-clear-text' }, icon('check', 14), 'Nothing more on your timetable today.'),
        later.length > 0 && h('p', { class: 'schedule-later' }, `Later: ${later.map((o) => `${o.title} ${o.start}`).join(', ')}`));
    };
    draw();
    timers.push(setInterval(draw, 60000));
    return card('Schedule', '#/timetable', box);
  },

  journal({ db, today, refresh }) {
    const entries = db.listNotes().filter((note) => note.typeId === 'journal');
    const entry = entries.find((note) => entryDate(note) === today) ?? null;
    const { current } = streaks(entries, today);
    const type = db.getType('journal');
    const written = entry && (entry.text?.trim() || ['wentWell', 'wasHard', 'grateful'].some((id) => String(entry.fields?.[id] ?? '').trim()));
    const day = Math.floor(Date.now() / 86400000);

    // One tap sets today's mood or energy, making today's entry if there isn't one yet.
    const set = (fieldId, value) => {
      const now = entries.find((note) => entryDate(note) === today);
      if (now) {
        const next = now.fields?.[fieldId] === value ? null : value;
        db.updateNote(now.id, { fields: { ...now.fields, [fieldId]: next } });
      } else {
        db.createNote({ ...homeForType('journal'), typeId: 'journal', fields: { date: today, [fieldId]: value } });
      }
      refresh(`[data-check="${fieldId}-${value}"]`);
    };
    const mood = entry ? fieldValue(entry, type.fields.find((f) => f.id === 'mood')) : null;
    const energy = entry ? fieldValue(entry, type.fields.find((f) => f.id === 'energy')) : null;

    return card('Journal', null,
      h('p', { class: 'dash-prompt' }, written ? h('span', null, icon('check', 16), ' Written today') : PROMPTS[day % PROMPTS.length]),
      h('div', { class: 'checkin', role: 'group', 'aria-label': 'Mood today' },
        h('span', { class: 'checkin-label' }, 'Mood'),
        MOODS.map((m) => h('button', {
          class: 'checkin-btn',
          type: 'button',
          'aria-pressed': String(mood === m.value),
          'aria-label': `Mood: ${m.label}`,
          title: m.label,
          dataset: { check: `mood-${m.value}` },
          onClick: () => set('mood', m.value),
        }, m.emoji))),
      h('div', { class: 'checkin', role: 'group', 'aria-label': 'Energy today' },
        h('span', { class: 'checkin-label' }, 'Energy'),
        [1, 2, 3, 4, 5].map((n) => h('button', {
          class: 'checkin-btn checkin-num',
          type: 'button',
          'aria-pressed': String(energy === n),
          'aria-label': `Energy: ${n} of 5`,
          dataset: { check: `energy-${n}` },
          onClick: () => set('energy', n),
        }, String(n)))),
      h('div', { class: 'dash-row' },
        entry
          ? h('a', { class: 'btn btn-small', href: `#/note/${encodeURIComponent(entry.id)}` }, written ? 'Open today’s entry' : 'Write today’s entry')
          : h('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => newNote(homeForType('journal')) }, 'Write today’s entry'),
        h('span', { class: 'dash-stat' }, current > 0 ? `${plural(current, 'day')} in a row` : 'No streak yet')));
  },

  inbox({ db }) {
    const count = db.counts().inbox;
    if (!count) return allClear('Inbox', '#/inbox', 'All clear. Your Inbox is empty.');
    return h('a', { class: 'callout dash-inbox', href: '#/inbox/review' },
      icon('inbox'),
      h('span', { class: 'callout-text' }, `${plural(count, 'note')} waiting in your Inbox`),
      h('span', { class: 'callout-action' }, 'Review'));
  },

  next7({ db, today }) {
    const end = addDays(today, 7);
    const notes = visible(db);
    const items = [];
    const taskNotes = notes.filter((note) => db.getType(note.typeId).fields.some((f) => f.kind === 'tasks' || f.role === 'due'));
    for (const entry of [...collectTasks(taskNotes), ...collectDeadlines(taskNotes)]) {
      const { due, done } = entry.item;
      if (!done && due > today && due <= end) {
        items.push({
          date: due, time: entry.item.time ?? '', text: entry.item.text || 'Task', href: `#/note/${encodeURIComponent(entry.noteId)}`, kind: entry.isDeadline ? 'Deadline' : 'Task',
        });
      }
    }
    // One-off events: the weekly classes are in Schedule already.
    for (const o of loadOccurrences(db, addDays(today, 1), end)) {
      if (!o.cancelled && (!o.repeating || o.changed)) {
        items.push({
          date: o.date, time: o.start, text: o.title, href: `#/timetable?date=${o.date}&view=day`, kind: 'Event',
        });
      }
    }
    if (!items.length) return null;
    items.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'));
    const days = [...new Set(items.map((i) => i.date))];
    const shown = items.slice(0, 8);
    return card('Next 7 days', '#/today',
      h('div', { class: 'dash-days' }, days.filter((d) => shown.some((i) => i.date === d)).map((date) => h('div', { class: 'dash-day' },
        h('h3', { class: 'dash-day-title' }, relativeDay(date, today), date !== addDays(today, 1) && h('span', { class: 'dash-day-date' }, ` · ${formatDay(date, { weekday: 'short' })}`)),
        h('ul', { class: 'dash-day-list' }, shown.filter((i) => i.date === date).map((i) => h('li', null,
          h('a', { href: i.href, class: 'dash-day-item' },
            h('span', { class: 'dash-day-time' }, i.time || i.kind),
            h('span', null, i.text)))))))),
      items.length > shown.length && h('p', { class: 'dash-stat' }, `and ${items.length - shown.length} more`));
  },

  course({ db, options, today }) {
    const notes = db.listNotes().filter((note) => inCollection(db, note, options.collectionId));
    const entries = collectCards(notes);
    if (!entries.length) return null;
    const { due, fresh, next } = reviewQueue(entries, today);
    if (!due.length) {
      return allClear('Course review', null, `All clear. Next cards are due ${next ? relativeDay(next, today).toLowerCase() : 'later'}.`);
    }
    return card('Course review', null,
      h('p', { class: 'dash-big' }, plural(due.length, 'card'), h('span', { class: 'dash-stat' }, ` due today${fresh ? `, ${fresh} new` : ''}`)),
      h('button', {
        class: 'btn btn-small btn-primary',
        type: 'button',
        onClick: () => openQuiz({ entries: due, title: `Review: ${plural(due.length, 'card')} due` }),
      }, icon('sparkle', 14), 'Start'));
  },

  habits({ db, today, refresh }) {
    const habits = db.listHabits();
    if (!habits.length) {
      return card('Habits', null,
        h('p', { class: 'dash-stat' }, 'Tick off something you want to do every day, and watch the streak grow.'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: openHabitsDialog }, icon('plus', 14), 'Add a habit'));
    }
    return card('Habits', null,
      h('ul', { class: 'habit-list' }, habits.map((habit) => {
        const done = Boolean(habit.done[today]);
        const { current } = habitStreak(habit, today);
        return h('li', { class: 'habit-row', dataset: { id: habit.id } },
          h('button', {
            class: 'habit-toggle',
            type: 'button',
            'aria-pressed': String(done),
            onClick: () => {
              db.toggleHabit(habit.id, today);
              refresh(`[data-id="${habit.id}"] .habit-toggle`);
            },
          },
          h('span', { class: 'habit-check', 'aria-hidden': 'true' }, done ? icon('check', 14) : null),
          habit.icon && h('span', { class: 'habit-icon', 'aria-hidden': 'true' }, habit.icon),
          h('span', { class: 'habit-name' }, habit.name),
          done && h('span', { class: 'sr-only' }, ', done today')),
          h('span', { class: 'habit-week', 'aria-hidden': 'true' }, lastWeek(habit, today).map((d) => h('span', { class: `habit-dot${d.done ? ' is-done' : ''}`, title: formatDay(d.date, { weekday: 'short' }) }))),
          h('span', { class: 'habit-streak' }, current ? plural(current, 'day') : '–'));
      })),
      h('button', { class: 'btn-link', type: 'button', onClick: openHabitsDialog }, 'Manage habits'));
  },

  recent({ db }) {
    const notes = [...visible(db)].sort((a, b) => b.updated - a.updated).slice(0, 3);
    if (!notes.length) return null;
    return card('Continue', null, h('div', { class: 'dash-notes' }, notes.map((note) => noteLink(db, note, `Edited ${relativeDay(toDateStr(new Date(note.updated))).toLowerCase()}`))));
  },

  pinned({ db }) {
    const notes = visible(db).filter((n) => n.pinned);
    return notes.length > 0 && card('Pinned', null, noteList(notes.slice(0, 8), { showLocation: true }));
  },

  favorites({ db }) {
    const notes = visible(db).filter((n) => n.favorite && !n.pinned);
    return notes.length > 0 && card('Favorites', '#/favorites', noteList(notes.slice(0, 8), { showLocation: true }));
  },

  onThisDay({ db, options, today }) {
    const monthDay = today.slice(5);
    const year = today.slice(0, 4);
    const dateOf = (note) => (note.typeId === 'journal' ? entryDate(note) : toDateStr(new Date(note.created)));
    const notes = db.listNotes().filter((note) => {
      if (note.typeId === 'journal' ? !options.includeJournal : note.private) return false;
      const date = dateOf(note);
      return date.slice(5) === monthDay && date.slice(0, 4) < year;
    });
    return notes.length > 0 && card('On this day', null, h('div', { class: 'dash-notes' },
      notes.slice(0, 5).map((note) => noteLink(db, note, `${plural(Number(year) - Number(dateOf(note).slice(0, 4)), 'year')} ago`))));
  },

  bored({ db, options, state, refresh }) {
    const type = db.getType('idea');
    const ideas = visible(db).filter((n) => n.typeId === 'idea' && inCollection(db, n, options.collectionId));
    if (!ideas.length) return null;
    let pick = ideas.find((n) => n.id === state.bored);
    if (!pick) {
      pick = pickOne(ideas);
      state.bored = pick.id;
    }
    return card('Bored? Try this', null,
      h('a', { class: 'dash-idea', href: `#/note/${encodeURIComponent(pick.id)}` }, displayTitle(pick, type) || 'Untitled'),
      h('div', { class: 'card-fields' }, summaryFields(type).map((field) => fieldDisplay(field, fieldValue(pick, field), { db, compact: true }))),
      h('div', { class: 'dash-row dash-another' },
        ideas.length > 1 && h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            state.bored = pickOne(ideas, { excludeId: state.bored }).id;
            refresh('.dash-another button');
          },
        }, icon('shuffle', 14), 'Another one'),
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => withUndo('Marked as done. Enjoy!', () => db.updateNote(pick.id, donePatch(pick, type))),
        }, icon('check', 14), 'Mark as done')));
  },

  watch({ db, options, state, refresh }) {
    const type = db.getType('watchlist');
    if (!type?.picker) return null;
    const notes = visible(db).filter((n) => n.typeId === 'watchlist' && inCollection(db, n, options.collectionId));
    const candidates = pickerCandidates(notes, type);
    if (!candidates.length) return null;
    let pick = candidates.find((n) => n.id === state.watch);
    if (!pick) {
      pick = pickOne(candidates);
      state.watch = pick.id;
    }
    return card('Tonight’s watch', null,
      h('a', { class: 'dash-idea', href: `#/note/${encodeURIComponent(pick.id)}` }, displayTitle(pick, type) || 'Untitled'),
      h('div', { class: 'card-fields' }, summaryFields(type).map((field) => fieldDisplay(field, fieldValue(pick, field), { db, compact: true }))),
      candidates.length > 1 && h('div', { class: 'dash-row dash-another dash-watch-another' },
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            state.watch = pickOne(candidates, { excludeId: state.watch }).id;
            refresh('.dash-watch-another button');
          },
        }, icon('shuffle', 14), 'Another one')));
  },

  progress({ db, today }) {
    const start = weekStartOf(today, firstDayOfWeek(db.getSettings().weekStart));
    const end = addDays(start, 6);
    const notes = db.listNotes();
    // Planned: what was due this week. Done: whatever got done this week, planned or not.
    const planned = new Set();
    let doneCount;
    for (const note of notes) {
      for (const field of tasksFields(db.getType(note.typeId))) {
        for (const { item } of flatten(fieldValue(note, field))) {
          if (item.due >= start && item.due <= end) planned.add(item.id);
        }
      }
    }
    doneCount = completedTasks(notes, db).filter((entry) => {
      const date = toDateStr(new Date(entry.at));
      return date >= start && date <= end;
    }).length;
    const total = Math.max(planned.size, doneCount);
    if (!total) return null;
    return card('This week', '#/review',
      progressBar({ done: doneCount, total, ratio: Math.min(1, doneCount / total) }, 'Tasks done this week'),
      h('p', { class: 'dash-stat' }, `${plural(doneCount, 'task')} done, ${plural(planned.size, 'task')} planned for this week.`));
  },

  nudge({ db }) {
    const notes = db.listNotes();
    const getType = (id) => db.getType(id);
    const tidy = findDuplicateGroups(notes.filter((n) => !n.private), getType).length
      + findEmptyNotes(notes, getType).length
      + db.orphanTags().length;
    const stale = findStaleNotes(notes.filter((n) => !n.private), 180).length;
    const backup = db.backupDue();
    if (!tidy && !backup && stale < 10) return null;
    return h('section', { class: 'dash-nudge', 'aria-label': 'Reminders' },
      (tidy > 0 || stale >= 10) && h('p', { class: 'dash-nudge-line' }, icon('broom', 15),
        tidy > 0 ? `${plural(tidy, 'thing')} could use tidying.` : `${plural(stale, 'note')} not opened in six months.`,
        h('a', { class: 'btn-link', href: '#/tidy' }, 'Tidy up')),
      backup && h('p', { class: 'dash-nudge-line' }, icon('download', 15),
        `No backup since ${db.getMeta('lastExportAt') ? formatDay(toDateStr(new Date(db.getMeta('lastExportAt')))) : 'you started'}. Your notes exist only on this device.`,
        h('button', { class: 'btn-link', type: 'button', onClick: () => exportBackup() }, 'Download backup')));
  },

  views({ db }) {
    const views = db.listSavedViews();
    return views.length > 0 && card('Saved views', '#/views',
      h('div', { class: 'recent-searches' }, views.map((view) => h('a', { class: 'chip chip-link', href: `#/view/${encodeURIComponent(view.id)}` }, h('span', { 'aria-hidden': 'true' }, view.icon), view.name))));
  },
};
