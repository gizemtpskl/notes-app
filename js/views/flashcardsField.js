/**
 * flashcardsField.js: editing a note's flashcards: a term and a definition per row. Enter in a
 * definition starts the next card.
 */
import { createCard, usableCards } from '../data/flashcards.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openQuiz } from './quiz.js';

export function flashcardsEditor(id, field, value, onChange, ctx) {
  let cards = [...value];
  const list = h('ol', { class: 'cards-edit' });
  const counter = h('span', { class: 'cards-count' });
  const quizButton = h('button', {
    class: 'btn btn-small',
    type: 'button',
    onClick: () => {
      const entries = usableCards(cards).map((card) => ({ card, noteId: ctx.noteId, fieldId: field.id }));
      if (entries.length) openQuiz({ entries, title: field.name });
    },
  }, icon('sparkle', 14), 'Quiz these');

  function emit() {
    onChange(cards);
    renderHead();
  }

  function renderHead() {
    const count = usableCards(cards).length;
    counter.textContent = count ? plural(count, 'card') : 'No cards yet';
    quizButton.hidden = !count || !ctx.noteId;
  }

  function addAfter(index) {
    const card = createCard();
    cards = [...cards.slice(0, index + 1), card, ...cards.slice(index + 1)];
    onChange(cards);
    render();
    list.querySelector(`[data-card="${card.id}"] .card-term`)?.focus();
  }

  function row(card, index) {
    const set = (patch) => {
      cards = cards.map((c) => (c.id === card.id ? { ...c, ...patch } : c));
      emit();
    };
    return h('li', { class: `card-row${card.review ? ' is-review' : ''}`, dataset: { card: card.id } },
      h('input', {
        class: 'input input-small card-term',
        type: 'text',
        value: card.term,
        placeholder: 'Term',
        'aria-label': `Term ${index + 1}`,
        onInput: (event) => set({ term: event.target.value }),
      }),
      h('input', {
        class: 'input input-small card-def',
        type: 'text',
        value: card.def,
        placeholder: 'Definition',
        'aria-label': `Definition ${index + 1}`,
        onInput: (event) => set({ def: event.target.value }),
        onKeydown: (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            addAfter(index);
          }
        },
      }),
      h('button', {
        class: `icon-btn card-flag${card.review ? ' is-on' : ''}`,
        type: 'button',
        'aria-pressed': String(card.review),
        'aria-label': `Needs review: ${card.term || `card ${index + 1}`}`,
        title: 'Needs review',
        onClick: (event) => {
          const on = !card.review;
          card = { ...card, review: on };
          set({ review: on });
          event.currentTarget.classList.toggle('is-on', on);
          event.currentTarget.setAttribute('aria-pressed', String(on));
          event.currentTarget.closest('.card-row').classList.toggle('is-review', on);
        },
      }, icon('flag', 15)),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Remove ${card.term || `card ${index + 1}`}`,
        title: 'Remove card',
        onClick: () => {
          cards = cards.filter((c) => c.id !== card.id);
          emit();
          render();
          list.querySelectorAll('.card-term')[Math.min(index, cards.length - 1)]?.focus();
        },
      }, icon('close', 14)));
  }

  function render() {
    fill(list, cards.map(row));
    renderHead();
  }

  render();

  return h('div', { class: 'cards-field' },
    h('div', { class: 'cards-head' }, counter, quizButton),
    list,
    h('button', {
      class: 'btn btn-small',
      id,
      type: 'button',
      onClick: () => addAfter(cards.length - 1),
    }, icon('plus', 14), 'Add card'));
}
