/**
 * weeklyReview.js: a weekly walk through what needs attention: the Inbox, overdue tasks, notes
 * without a home or tags, what got done, and a moment of reflection.
 */
import { app } from '../context.js';
import { addDays, firstDayOfWeek, relativeDay, toDateStr } from '../data/dates.js';
import { blockMinutes } from '../data/timetable.js';
import { loadOccurrences } from './timetable.js';
import { weeklyReviewData } from '../data/weekly.js';
import { fill, fullDate, h, plural, shortDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { noteList } from './noteList.js';
import { createSelection } from './selection.js';
import { agendaRow, globalBuckets } from './tasksAgenda.js';
import { newFromTemplate } from './templatesPage.js';

const LIST_LIMIT = 15;

/** The coming seven days on the timetable: hours per day, so a heavy week is seen in time. */
function upcoming(today) {
  const { db } = app;
  const to = addDays(today, 6);
  const live = loadOccurrences(db, today, to).filter((o) => !o.cancelled);
  if (!live.length) return null;
  const hours = (list) => (list.reduce((sum, o) => sum + blockMinutes(o), 0) / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return h('section', { class: 'review-step-card' },
    h('h2', { class: 'review-step-title' }, h('span', { class: 'review-step-mark', 'aria-hidden': 'true' }), 'The coming week on your timetable',
      h('span', { class: 'review-step-count' }, `${hours(live)} h`)),
    h('ul', { class: 'review-load' }, Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((date) => {
      const day = live.filter((o) => o.date === date);
      return h('li', { class: 'review-load-day' },
        h('a', { href: `#/timetable?date=${date}&view=day` }, relativeDay(date, today)),
        h('span', { class: 'dash-stat' }, day.length ? `${plural(day.length, 'block')}, ${hours(day)} h` : 'Free'));
    })));
}

export function weeklyReviewView() {
  const { db } = app;
  const body = h('div');
  let shownIds = [];

  const selection = createSelection({ getIds: () => shownIds, onMode: () => refresh() });

  const data = () => weeklyReviewData(db, { weekStart: firstDayOfWeek(db.getSettings().weekStart) });

  const step = (title, count, done, ...content) => h('section', { class: `review-step-card${done ? ' is-clear' : ''}` },
    h('h2', { class: 'review-step-title' },
      h('span', { class: 'review-step-mark', 'aria-hidden': 'true' }, done ? icon('check', 14) : null),
      title,
      count !== null && h('span', { class: 'review-step-count' }, count.toLocaleString()),
      done && h('span', { class: 'sr-only' }, ', all clear')),
    content);

  const moreLine = (total) => total > LIST_LIMIT && h('p', { class: 'view-foot' }, `Showing ${LIST_LIMIT} of ${total.toLocaleString()}.`);

  function refresh() {
    const review = data();
    const today = toDateStr();
    const overdue = globalBuckets(today).overdue;
    const noCollection = review.noCollection.slice(0, LIST_LIMIT);
    const untagged = review.untagged.filter((note) => !noCollection.includes(note)).slice(0, LIST_LIMIT);
    shownIds = [...noCollection, ...untagged].map((note) => note.id);
    const last = db.getMeta('lastWeeklyReview');

    fill(body,
      step('Empty the Inbox', review.inboxCount, review.inboxCount === 0,
        review.inboxCount > 0
          ? h('a', { class: 'btn btn-primary btn-small', href: '#/inbox/review' }, icon('sparkle', 14), `Review ${plural(review.inboxCount, 'note')}`)
          : h('p', { class: 'empty-line' }, 'Nothing waiting.')),
      step('Overdue tasks', overdue.length, overdue.length === 0,
        overdue.length
          ? h('ul', { class: 'task-list agenda-list' }, overdue.map((entry) => agendaRow(entry, today)))
          : h('p', { class: 'empty-line' }, 'Nothing overdue.')),
      step('Notes without a collection', review.noCollection.length, review.noCollection.length === 0,
        noCollection.length
          ? [noteList(noCollection, { showLocation: true, selection }), moreLine(review.noCollection.length)]
          : h('p', { class: 'empty-line' }, 'Every note has a home.')),
      step('Untagged notes', review.untagged.length, review.untagged.length === 0,
        untagged.length
          ? [noteList(untagged, { showLocation: true, selection }), moreLine(review.untagged.length)]
          : h('p', { class: 'empty-line' }, review.untagged.length ? 'They are in the list above.' : 'Everything has a tag.')),
      step('Done this week', review.completed.length, false,
        review.completed.length
          ? h('ul', { class: 'done-list' }, review.completed.slice(0, 30).map((entry) => h('li', null,
            icon('check', 14),
            h('span', { class: 'done-text' }, entry.text || 'Task'),
            h('a', { class: 'task-source', href: `#/note/${encodeURIComponent(entry.noteId)}` }, entry.noteTitle || 'Untitled'),
            h('time', { class: 'date-display' }, relativeDay(toDateStr(new Date(entry.at)), today)))))
          : h('p', { class: 'empty-line' }, 'No tasks ticked off yet this week.')),
      upcoming(today),
      step('Reflect', null, false,
        h('p', { class: 'dash-prompt' }, 'What went well this week, and what would you change?'),
        h('p', { class: 'settings-text' }, review.journalDays
          ? `You wrote in your journal on ${plural(review.journalDays, 'day')} this week.`
          : 'No journal entries this week yet.'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => newFromTemplate('tpl-weekly-review') }, icon('edit', 14), 'Write a weekly reflection')),
      h('div', { class: 'review-finish' },
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onClick: () => {
            db.setMeta('lastWeeklyReview', Date.now());
            toast('Weekly review done. Nice work.');
            refresh();
          },
        }, icon('check', 16), 'Finish this review'),
        h('p', { class: 'settings-text' }, last ? `Last finished: ${fullDate(last)} (${shortDate(last)}).` : 'Not finished yet this time.')));
  }

  refresh();

  return {
    title: 'Weekly review',
    el: h('div', { class: 'page' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, 'Weekly review'),
          h('div', { class: 'page-actions' }, selection.button)),
        h('p', { class: 'page-sub' }, 'A few minutes to clear the decks. Use Select to move or tag several notes at once.')),
      body,
      selection.bar),
    update: (change) => {
      if (change.stores.has('notes')) {
        refresh();
        selection.prune();
      }
    },
    destroy: () => selection.destroy(),
  };
}
