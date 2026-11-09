/**
 * searchPage.js: search with filters: space, collection, type, tag, date range and archived.
 * Journal entries and other private notes stay out unless included.
 */
import { app } from '../context.js';
import { findRanges, queryTerms, rememberSearch, searchNotes } from '../data/search.js';
import { displayTitle } from '../data/types.js';
import { snippet } from '../data/text.js';
import { fill, h, plural, shortDate } from '../ui/dom.js';
import { locationName } from './actions.js';
import { emptyState } from './noteList.js';
import { highlighted } from './palette.js';

const PAGE_LIMIT = 200;
const TYPE_DELAY_MS = 120;
const REMEMBER_DELAY_MS = 1500;

export function searchPageView({ query = '' }) {
  const { db } = app;
  const params = new URLSearchParams(query);
  const options = {
    spaceId: '', collectionId: '', typeId: '', tagId: '', from: '', to: '', status: 'active', includePrivate: params.get('private') === '1',
  };
  const body = h('div', { class: 'search-results' });
  const count = h('p', { class: 'search-count', role: 'status' });
  let typeTimer = null;
  let rememberTimer = null;

  const input = h('input', {
    class: 'input search-input',
    type: 'search',
    value: params.get('q') ?? '',
    placeholder: 'Search titles, text, fields and tags…',
    'aria-label': 'Search',
    autocomplete: 'off',
    onInput: () => {
      clearTimeout(typeTimer);
      typeTimer = setTimeout(run, TYPE_DELAY_MS);
    },
  });

  function remember(text) {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (text) db.setMeta('recentSearches', rememberSearch(db.getMeta('recentSearches', []), text));
    }, REMEMBER_DELAY_MS);
  }

  function row(result, terms) {
    const { note } = result;
    const type = db.getType(note.typeId);
    const title = snippet(displayTitle(note, type) || 'Untitled', 120);
    return h('li', { class: 'search-row', dataset: { id: note.id } },
      h('a', { class: 'search-link', href: `#/note/${encodeURIComponent(note.id)}` },
        h('span', { class: 'search-title' },
          h('span', { 'aria-hidden': 'true' }, type.icon),
          ' ',
          highlighted(title, findRanges(title, terms))),
        result.fieldName && h('span', { class: 'search-field' }, result.fieldName),
        result.snippet.text && h('span', { class: 'search-snippet' }, highlighted(result.snippet.text, result.snippet.ranges)),
        h('span', { class: 'note-meta' },
          h('span', { class: 'note-location' }, locationName(note)),
          h('time', null, shortDate(note.updated)),
          note.archived && h('span', null, 'Archived'),
          note.private && h('span', null, 'Private'))));
  }

  function run() {
    const text = input.value.trim();
    history.replaceState(null, '', `#/search${text ? `?q=${encodeURIComponent(text)}` : ''}`);
    const narrowed = {
      ...options,
      spaceId: options.spaceId || undefined,
      collectionId: options.collectionId || undefined,
      typeId: options.typeId || undefined,
      tagId: options.tagId || undefined,
      from: options.from || undefined,
      to: options.to || undefined,
      limit: PAGE_LIMIT,
    };
    const results = searchNotes(db, text, narrowed);
    const terms = queryTerms(text);
    const anything = text || options.spaceId || options.collectionId || options.typeId || options.tagId || options.from || options.to || options.status !== 'active';
    remember(text);
    if (!anything) {
      count.textContent = '';
      const recent = db.getMeta('recentSearches', []);
      fill(body, recent.length > 0
        ? h('section', { class: 'section' },
          h('h2', { class: 'section-title' }, 'Recent searches'),
          h('div', { class: 'recent-searches' },
            recent.map((item) => h('button', {
              class: 'chip chip-button',
              type: 'button',
              onClick: () => {
                input.value = item;
                run();
              },
            }, item)),
            h('button', {
              class: 'btn-link',
              type: 'button',
              onClick: () => {
                db.setMeta('recentSearches', []);
                run();
              },
            }, 'Clear')))
        : emptyState({
          emoji: '🔍',
          title: 'Search everything',
          text: 'Try words from a title or a note. You can also use tag:thesis, type:journal, in:school, before:2026-01-31 or "an exact phrase".',
        }));
      return;
    }
    count.textContent = results.length >= PAGE_LIMIT ? `Showing the best ${PAGE_LIMIT} results` : plural(results.length, 'result');
    fill(body, results.length
      ? h('ul', { class: 'search-list' }, results.map((result) => row(result, terms)))
      : emptyState({
        emoji: '🧐',
        title: 'Nothing found',
        text: options.includePrivate ? 'Try fewer words, or remove a filter.' : 'Try fewer words, or remove a filter. Journal entries and private notes are only searched when included.',
      }));
  }

  const select = (key, label, choices) => h('label', { class: 'search-filter' },
    h('span', { class: 'field-label' }, label),
    h('select', {
      class: 'select',
      onChange: (event) => {
        options[key] = event.target.value;
        run();
      },
    }, choices.map(([value, name]) => h('option', { value, selected: options[key] === value }, name))));

  const date = (key, label) => h('label', { class: 'search-filter' },
    h('span', { class: 'field-label' }, label),
    h('input', {
      class: 'input input-small',
      type: 'date',
      onChange: (event) => {
        options[key] = event.target.value;
        run();
      },
    }));

  const filters = h('div', { class: 'search-filters' },
    select('spaceId', 'Space', [['', 'Any'], ...db.listSpaces().map((s) => [s.id, s.name])]),
    select('collectionId', 'Collection', [['', 'Any'], ...db.allCollections().map((c) => [c.id, c.name])]),
    select('typeId', 'Type', [['', 'Any'], ...db.listTypes().map((t) => [t.id, `${t.icon} ${t.name}`])]),
    select('tagId', 'Tag', [['', 'Any'], ...db.listTags().map((t) => [t.id, t.name])]),
    date('from', 'Changed from'),
    date('to', 'Changed until'),
    select('status', 'Show', [['active', 'Active notes'], ['all', 'Active and archived'], ['archived', 'Archived only']]),
    h('label', { class: 'check-field search-private' },
      h('input', {
        type: 'checkbox',
        checked: options.includePrivate,
        onChange: (event) => {
          options.includePrivate = event.target.checked;
          run();
        },
      }), 'Include journal and private notes'));

  run();

  return {
    title: 'Search',
    keepsFocus: true,
    el: h('div', { class: 'page page-wide' },
      h('header', { class: 'page-head' }, h('h1', { class: 'page-title', tabindex: '-1' }, 'Search')),
      input,
      h('details', { class: 'search-more', open: true },
        h('summary', null, 'Filters'),
        filters),
      count,
      body),
    mounted: () => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    update: (change) => {
      // Results stay as they are while another tab changes things, unless notes were removed here.
      if (change.source === 'remote' || change.structural) run();
    },
    destroy() {
      clearTimeout(typeTimer);
      clearTimeout(rememberTimer);
    },
  };
}
