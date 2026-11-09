/**
 * quiz.js: quiz mode. See a term, think of the answer, reveal it, and say how it went. Missed
 * cards come back later in the session and are marked "needs review".
 */
import { app } from '../context.js';
import { answerQuiz, recordAnswer, startQuiz } from '../data/flashcards.js';
import { fieldValue } from '../data/fieldKinds.js';
import { fill, h, plural } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';

/** Saves one answer into the note that holds the card. */
function saveAnswer(entry, correct) {
  const { db } = app;
  const note = db.getNote(entry.noteId);
  if (!note) return;
  const field = db.getType(note.typeId).fields.find((f) => f.id === entry.fieldId);
  if (!field) return;
  const cards = fieldValue(note, field).map((card) => (card.id === entry.card.id ? recordAnswer(card, correct) : card));
  db.updateNote(note.id, { fields: { ...note.fields, [field.id]: cards } });
}

/** entries: [{ card, noteId, fieldId }] */
export function openQuiz({ entries, title = 'Quiz' }) {
  return openDialog({
    title,
    className: 'dialog-quiz',
    build: () => {
      let session = startQuiz(entries);
      let revealed = false;
      const stage = h('div', { class: 'quiz-stage' });

      const answer = (correct) => {
        const [current] = session.queue;
        saveAnswer(current, correct);
        session = answerQuiz(session, correct);
        revealed = false;
        render();
      };

      function render() {
        const [current] = session.queue;
        if (!current) {
          const missed = session.missed;
          fill(stage,
            h('div', { class: 'quiz-done', role: 'status' },
              h('p', { class: 'quiz-score' }, `${session.firstTry} of ${session.total}`),
              h('p', { class: 'quiz-score-label' }, 'right on the first try'),
              missed.length > 0 && h('div', { class: 'quiz-missed' },
                h('h3', { class: 'section-title' }, `To look at again (${missed.length})`),
                h('ul', null, missed.map((entry) => h('li', null, h('strong', null, entry.card.term), ` ${entry.card.def}`)))),
              h('div', { class: 'pick-actions' },
                h('button', {
                  class: 'btn btn-primary',
                  type: 'button',
                  autofocus: true,
                  onClick: () => {
                    session = startQuiz(entries);
                    render();
                  },
                }, 'Start again'),
                missed.length > 0 && h('button', {
                  class: 'btn',
                  type: 'button',
                  onClick: () => {
                    session = startQuiz(missed);
                    render();
                  },
                }, `Just the ${plural(missed.length, 'missed card', 'missed cards')}`))));
          stage.querySelector('[autofocus]')?.focus();
          return;
        }
        const remaining = session.queue.length;
        fill(stage,
          h('div', { class: 'review-progress' },
            h('div', { class: 'review-progress-bar', cssVars: { '--progress': `${Math.round((session.done / session.total) * 100)}%` } })),
          h('p', { class: 'quiz-count', 'aria-live': 'polite' }, `${plural(remaining, 'card')} to go`),
          h('div', { class: 'quiz-card' },
            h('p', { class: 'quiz-term' }, current.card.term || '(No term)'),
            revealed && h('p', { class: 'quiz-def', role: 'status' }, current.card.def || '(No definition)'),
            current.card.review && !revealed && h('span', { class: 'chip quiz-flag' }, icon('flag', 12), 'Needs review')),
          revealed
            ? h('div', { class: 'quiz-actions' },
              h('button', { class: 'btn btn-large quiz-miss', type: 'button', onClick: () => answer(false) }, 'Missed it ', h('kbd', null, '1')),
              h('button', { class: 'btn btn-large btn-primary quiz-got', type: 'button', onClick: () => answer(true) }, 'Got it ', h('kbd', null, '2')))
            : h('div', { class: 'quiz-actions' },
              h('button', {
                class: 'btn btn-large btn-primary quiz-reveal',
                type: 'button',
                autofocus: true,
                onClick: () => {
                  revealed = true;
                  render();
                },
              }, 'Show answer ', h('kbd', null, 'Space'))));
        stage.querySelector('.quiz-got, .quiz-reveal')?.focus();
      }

      stage.addEventListener('keydown', (event) => {
        if (!session.queue.length) return;
        if (revealed && event.key === '1') {
          event.preventDefault();
          answer(false);
        } else if (revealed && event.key === '2') {
          event.preventDefault();
          answer(true);
        }
      });

      render();
      return stage;
    },
  });
}
