/**
 * courseViews.js: views for course notes: by lecture, by topic, and exam prep with every
 * flashcard and everything tagged confusing or needs review. They include sub-collections, so a
 * course's main collection shows all of its parts.
 */
import { app } from '../context.js';
import { formatDay, toDateStr } from '../data/dates.js';
import { reviewQueue } from '../data/review.js';
import { fieldValue } from '../data/fieldKinds.js';
import { usableCards } from '../data/flashcards.js';
import { fold } from '../data/text.js';
import { displayTitle, flashcardFields } from '../data/types.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState } from './noteList.js';
import { openQuiz } from './quiz.js';

const NEEDS_REVIEW_TAG = /confus|need.*review|review|unclear|anlamad/i;

const courseNotes = (collectionId) => app.db.listNotes({ collectionId, includeChildren: true })
  .filter((note) => flashcardFields(app.db.getType(note.typeId)).length || app.db.getType(note.typeId).byLecture);

const field = (note, id) => {
  const def = app.db.getType(note.typeId).fields.find((f) => f.id === id);
  return def ? fieldValue(note, def) : null;
};

const titleOf = (note) => displayTitle(note, app.db.getType(note.typeId)) || 'Untitled';

function cardCount(note) {
  return flashcardFields(app.db.getType(note.typeId)).reduce((sum, def) => sum + usableCards(fieldValue(note, def)).length, 0);
}

function lectureRow(note) {
  const number = field(note, 'lecture');
  const date = field(note, 'date');
  const topic = field(note, 'topic');
  const cards = cardCount(note);
  return h('li', { class: 'lecture-row', dataset: { id: note.id } },
    h('a', { class: 'lecture-link', href: `#/note/${encodeURIComponent(note.id)}` },
      h('span', { class: 'lecture-number', 'aria-label': number === null ? 'No lecture number' : `Lecture ${number}` }, number ?? '–'),
      h('span', { class: 'lecture-main' },
        h('span', { class: 'lecture-title' }, titleOf(note)),
        h('span', { class: 'lecture-meta' },
          topic && h('span', null, topic),
          date && h('time', { datetime: date }, formatDay(date)),
          cards > 0 && h('span', null, plural(cards, 'card'))))));
}

const emptyCourse = (onNew) => emptyState({
  emoji: '🎓',
  title: 'No lecture notes yet',
  text: 'Add a lecture number and a topic to each note, and they line up here.',
  action: onNew && h('button', { class: 'btn btn-primary', type: 'button', onClick: onNew }, icon('plus', 16), 'New course note'),
});

export function lecturesView({ collectionId, onNew }) {
  const el = h('div');
  function refresh() {
    const notes = courseNotes(collectionId).sort((a, b) => {
      const x = field(a, 'lecture');
      const y = field(b, 'lecture');
      // Notes without a number go last.
      if (x === null || y === null) return x === y ? b.updated - a.updated : Number(x === null) - Number(y === null);
      return x - y || (field(a, 'date') ?? '').localeCompare(field(b, 'date') ?? '');
    });
    fill(el, notes.length ? h('ol', { class: 'lecture-list' }, notes.map(lectureRow)) : emptyCourse(onNew));
  }
  refresh();
  return { el, refresh };
}

export function topicsView({ collectionId, onNew }) {
  const el = h('div');
  function refresh() {
    const notes = courseNotes(collectionId);
    const groups = new Map();
    for (const note of notes) {
      const raw = (field(note, 'topic') ?? '').trim();
      const key = fold(raw);
      if (!groups.has(key)) groups.set(key, { name: raw, notes: [] });
      groups.get(key).notes.push(note);
    }
    const ordered = [...groups.entries()].sort(([a, x], [b, y]) => {
      // The group without a topic goes last.
      if (!a || !b) return Number(!a) - Number(!b);
      return x.name.localeCompare(y.name);
    });
    fill(el, notes.length
      ? ordered.map(([, group]) => h('section', { class: 'section' },
        h('h2', { class: 'timeline-title' }, group.name || 'No topic', h('span', { class: 'kanban-count' }, ` · ${plural(group.notes.length, 'note')}`)),
        h('ol', { class: 'lecture-list' }, group.notes.sort((a, b) => (field(a, 'lecture') ?? Infinity) - (field(b, 'lecture') ?? Infinity)).map(lectureRow))))
      : emptyCourse(onNew));
  }
  refresh();
  return { el, refresh };
}

/** Every flashcard in these notes: [{ card, noteId, fieldId, noteTitle, topic }]. */
export function collectCards(notes) {
  const entries = [];
  for (const note of notes) {
    const type = app.db.getType(note.typeId);
    for (const def of flashcardFields(type)) {
      for (const card of usableCards(fieldValue(note, def))) {
        entries.push({
          card, noteId: note.id, fieldId: def.id, noteTitle: titleOf(note), topic: (field(note, 'topic') ?? '').trim(),
        });
      }
    }
  }
  return entries;
}

export function examPrepView({ collectionId }) {
  const { db } = app;
  let topic = '';
  let onlyReview = false;
  const el = h('div', { class: 'exam' });

  function refresh() {
    const notes = courseNotes(collectionId);
    const all = collectCards(notes);
    const topics = [...new Set(all.map((entry) => entry.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (topic && !topics.includes(topic)) topic = '';
    const scoped = all.filter((entry) => !topic || entry.topic === topic);
    const shown = scoped.filter((entry) => !onlyReview || entry.card.review);
    const review = scoped.filter((entry) => entry.card.review);
    const { due: dueToday } = reviewQueue(scoped, toDateStr());
    const flagged = db.listNotes({ collectionId, includeChildren: true }).filter((note) => note.tagIds.some((id) => NEEDS_REVIEW_TAG.test(db.getTag(id)?.name ?? '')));

    const stat = (value, label) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value.toLocaleString()), h('span', { class: 'stat-label' }, label));

    fill(el,
      h('div', { class: 'stat-row' },
        stat(scoped.length, 'Flashcards'),
        stat(dueToday.length, 'Due today'),
        stat(review.length, 'Need review'),
        stat(flagged.length, 'Notes tagged confusing')),
      h('div', { class: 'exam-actions' },
        h('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: !dueToday.length,
          onClick: () => openQuiz({ entries: dueToday, title: `Review: ${plural(dueToday.length, 'card')} due` }),
        }, icon('sparkle', 16), `Review ${dueToday.length} due`),
        h('button', {
          class: 'btn',
          type: 'button',
          disabled: !scoped.length,
          onClick: () => openQuiz({ entries: scoped, title: topic ? `Quiz: ${topic}` : 'Quiz: all cards' }),
        }, `Quiz all ${scoped.length}`),
        h('button', {
          class: 'btn',
          type: 'button',
          disabled: !review.length,
          onClick: () => openQuiz({ entries: review, title: 'Quiz: cards needing review' }),
        }, `Quiz ${review.length} needing review`),
        topics.length > 0 && h('label', { class: 'inline-field' }, 'Topic',
          h('select', {
            class: 'select',
            dataset: { focusKey: 'topic' },
            onChange: (event) => {
              topic = event.target.value;
              refresh();
              el.querySelector('[data-focus-key="topic"]')?.focus();
            },
          }, h('option', { value: '' }, 'All topics'), topics.map((name) => h('option', { value: name, selected: name === topic }, name)))),
        h('label', { class: 'check-field exam-only' },
          h('input', {
            type: 'checkbox',
            checked: onlyReview,
            dataset: { focusKey: 'only' },
            onChange: (event) => {
              onlyReview = event.target.checked;
              refresh();
              el.querySelector('[data-focus-key="only"]')?.focus();
            },
          }), 'Only cards needing review')),
      flagged.length > 0 && h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Tagged confusing or needs review'),
        h('ul', { class: 'link-rows' }, flagged.map((note) => h('li', null,
          h('a', { class: 'link-row', href: `#/note/${encodeURIComponent(note.id)}` },
            h('span', { class: 'link-row-title' }, titleOf(note)),
            h('span', { class: 'link-row-where' }, note.tagIds.map((id) => db.getTag(id)?.name).filter((name) => NEEDS_REVIEW_TAG.test(name ?? '')).map((name) => `#${name}`).join(' '))))))),
      h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, onlyReview ? 'Cards needing review' : 'All flashcards'),
        shown.length
          ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Flashcards' },
            h('table', { class: 'data-table exam-table' },
              h('thead', null, h('tr', null,
                h('th', { scope: 'col' }, h('span', { class: 'th-btn th-plain' }, 'Term')),
                h('th', { scope: 'col' }, h('span', { class: 'th-btn th-plain' }, 'Definition')),
                h('th', { scope: 'col' }, h('span', { class: 'th-btn th-plain' }, 'From')))),
              h('tbody', null, shown.map((entry) => h('tr', { class: entry.card.review ? 'is-review' : null },
                h('td', null, entry.card.review && h('span', { class: 'exam-flag', title: 'Needs review' }, icon('flag', 13)), h('strong', null, entry.card.term)),
                h('td', null, entry.card.def),
                h('td', null, h('a', { class: 'url-display', href: `#/note/${encodeURIComponent(entry.noteId)}` }, entry.noteTitle)))))))
          : h('p', { class: 'empty-line' }, all.length ? 'Nothing needs review here.' : 'Add flashcards to your course notes, and they all gather here for studying.')));
  }

  refresh();
  return { el, refresh };
}
