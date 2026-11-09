/**
 * presenter.js: shows a list of notes in whichever view is chosen, with sorting, grouping and
 * filters. Collection pages, saved views and tag pages all use it, so every list of notes can be
 * a List, Table, Cards, Kanban, Calendar or Timeline.
 */
import { app } from '../context.js';
import { FIELD_KINDS } from '../data/fieldKinds.js';
import { countConditions, normalizeFilter, queryNotes } from '../data/filters.js';
import { VIEWS, dateKeysFor, defaultGroupField, groupableFields, noteDate, tasksFields } from '../data/types.js';
import { fill, h } from '../ui/dom.js';
import { calendarView, timelineView } from './calendarViews.js';
import { cardsView, kanbanView, tableView, viewSwitcher } from './collectionViews.js';
import { filterBar } from './filterBar.js';
import { emptyState, noteList } from './noteList.js';
import { createSelection } from './selection.js';

const BASE_SORTS = [
  { value: 'updated:desc', label: 'Recently updated' },
  { value: 'created:desc', label: 'Newest first' },
  { value: 'created:asc', label: 'Oldest first' },
  { value: 'title:asc', label: 'Title A to Z' },
  { value: 'title:desc', label: 'Title Z to A' },
];

/** Good first direction per kind: best ratings and latest dates first, the rest ascending. */
function fieldSortOptions(type) {
  const options = [];
  if (tasksFields(type).length || type.fields.some((f) => f.role === 'due')) {
    options.push({ value: 'due:asc', label: 'By due date' });
  }
  for (const field of type.fields) {
    if (FIELD_KINDS[field.kind] && !['longtext', 'tasks', 'relation', 'url', 'multiselect', 'flashcards'].includes(field.kind)) {
      const descending = ['rating', 'mood', 'date', 'checkbox'].includes(field.kind);
      options.push({ value: `field:${field.id}:${descending ? 'desc' : 'asc'}`, label: `By ${field.name.toLowerCase()}` });
    }
  }
  return options;
}

export function sortSelect(view, type, onChange) {
  const current = `${view?.sort ?? 'updated'}:${view?.dir ?? 'desc'}`;
  const options = [...BASE_SORTS, ...fieldSortOptions(type)];
  // A table header can pick a direction the menu doesn't list, so it is added to stay accurate.
  if (!options.some((o) => o.value === current)) {
    const key = view?.sort ?? '';
    const field = key.startsWith('field:') ? type.fields.find((f) => f.id === key.slice(6)) : null;
    const name = field?.name ?? BASE_SORTS.find((o) => o.value.startsWith(`${key}:`))?.label ?? key;
    options.push({ value: current, label: `By ${name.toLowerCase()} (${view?.dir === 'asc' ? 'ascending' : 'descending'})` });
  }
  const select = h('select', {
    class: 'select',
    'aria-label': 'Sort notes',
    onChange: () => {
      const at = select.value.lastIndexOf(':');
      onChange({ sort: select.value.slice(0, at), dir: select.value.slice(at + 1) });
    },
  }, options.map((option) => h('option', { value: option.value, selected: option.value === current }, option.label)));
  return select;
}

/**
 * options:
 *   getType      () => the type giving columns and fields (a stand-in for mixed lists)
 *   getViews     () => view modes on offer
 *   getDefaultMode () => the mode when none was chosen yet
 *   getView      () => { mode, sort, dir, groupBy, dateKey, filter }
 *   setView      (patch) => save a change
 *   locked       a filter this page is tied to, such as one collection
 *   scope        'global' or 'scoped': see filterBar
 *   filterTypes  () => types offered for field conditions
 *   specials     { mode: () => { el, refresh, mounted, destroy } } for modes with their own page
 *   emptyContent () => what to show when there are no notes at all
 *   onNewOnDate  (date, dateKey) => create a note on a day from the Calendar
 *   onSaveView   (filter) => save the filter as a view
 *   showLocation show where each note lives
 */
export function notesPresenter({
  getType, getViews, getDefaultMode, getView, setView, locked = null, scope = 'scoped', filterTypes, specials = {}, emptyContent,
  onNewOnDate, onSaveView, showLocation = false,
}) {
  const { db } = app;
  const toolbar = h('div', { class: 'view-toolbar' });
  const notice = h('div');
  const body = h('div');
  let special = null;

  const selection = createSelection({
    getIds: () => {
      const view = getView();
      return currentNotes(view, currentMode(view) !== 'table').map((note) => note.id);
    },
    onMode: () => refresh(),
  });

  const bar = filterBar({
    scope,
    getFilter: () => getView().filter,
    onChange: (filter) => setView({ filter }),
    getTypes: filterTypes ?? (() => [getType()]),
    onSave: onSaveView,
  });

  function currentMode(view) {
    const available = getViews();
    const wanted = view.mode ?? getDefaultMode();
    if (available.includes(wanted)) return wanted;
    return available.includes(getDefaultMode()) ? getDefaultMode() : 'list';
  }

  /** The chosen date, or else the first one that any note here actually has. */
  function currentDateKey(view) {
    const keys = dateKeysFor(getType());
    if (keys.some((k) => k.key === view.dateKey)) return view.dateKey;
    const notes = queryNotes(db, normalizeFilter(view.filter), { locked });
    const used = keys.find(({ key }) => notes.some((note) => noteDate(note, db.getType(note.typeId), key)));
    return used?.key ?? keys[0].key;
  }

  function currentNotes(view, pinnedFirst = true) {
    return queryNotes(db, normalizeFilter(view.filter), {
      sort: { key: view.sort ?? 'updated', dir: view.dir ?? 'desc' },
      pinnedFirst,
      locked,
    });
  }

  function closeSpecial() {
    special?.instance.destroy?.();
    special = null;
  }

  function buildSpecial(mode) {
    if (specials[mode]) return specials[mode]();
    const getNotes = () => currentNotes(getView());
    const getDateKey = () => currentDateKey(getView());
    if (mode === 'calendar') {
      return calendarView({ getNotes, getDateKey, onNew: onNewOnDate && ((date) => onNewOnDate(date, getDateKey())) });
    }
    return timelineView({ getNotes, getDateKey });
  }

  function renderSpecial(mode) {
    if (special?.mode === mode) {
      special.instance.refresh();
      return;
    }
    closeSpecial();
    const instance = buildSpecial(mode);
    special = { mode, instance };
    fill(body, instance.el);
    if (body.isConnected) instance.mounted?.();
  }

  function renderList(mode, view) {
    closeSpecial();
    const type = getType();
    const sort = { key: view.sort ?? 'updated', dir: view.dir ?? 'desc' };
    const notes = currentNotes(view, mode !== 'table');
    if (!notes.length) {
      const filtered = countConditions(normalizeFilter(view.filter)) > 0;
      fill(body, filtered
        ? emptyState({
          emoji: '🔍',
          title: 'Nothing matches this filter',
          text: 'Try removing a condition.',
        })
        : emptyContent());
      return;
    }
    const scrollers = [...body.querySelectorAll('.kanban, .table-wrap')].map((el) => el.scrollLeft);
    const focusedId = body.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    let content;
    if (mode === 'table') {
      content = tableView(notes, type, { sort, onSort: ({ key, dir }) => setView({ sort: key, dir }), selection });
    } else if (mode === 'cards') {
      content = cardsView(notes, type, { selection });
    } else if (mode === 'kanban') {
      const group = groupableFields(type).find((f) => f.id === view.groupBy) ?? defaultGroupField(type);
      content = kanbanView(notes, type, group);
    } else {
      content = noteList(notes, { showLocation, selection });
    }
    fill(body, content);
    [...body.querySelectorAll('.kanban, .table-wrap')].forEach((el, i) => {
      el.scrollLeft = scrollers[i] ?? 0;
    });
    if (focusedId) body.querySelector(`[data-id="${CSS.escape(focusedId)}"] a`)?.focus();
  }

  function renderToolbar(mode, view) {
    const type = getType();
    const hasFilter = !specials[mode];
    const sortable = !specials[mode] && mode !== 'calendar' && mode !== 'timeline';
    const dated = mode === 'calendar' || mode === 'timeline';
    const groups = groupableFields(type);
    const available = getViews();
    const active = document.activeElement;
    const hadFocus = toolbar.contains(active);
    const focusKey = hadFocus ? active.dataset.focusKey ?? null : null;
    const pressed = hadFocus && active.classList.contains('view-btn');
    // The Filter button stays one element, so its state survives a refresh.
    fill(toolbar,
      available.length > 1 && viewSwitcher(available, mode, VIEWS, (next) => setView({ mode: next })),
      h('div', { class: 'view-toolbar-right' },
        ['list', 'table', 'cards'].includes(mode) && selection.button,
        hasFilter && bar.button,
        mode === 'kanban' && groups.length > 1 && h('label', { class: 'inline-field' },
          h('span', null, 'Group by'),
          h('select', {
            class: 'select',
            dataset: { focusKey: 'group' },
            onChange: (event) => setView({ groupBy: event.target.value }),
          }, groups.map((f) => h('option', {
            value: f.id,
            selected: f.id === (view.groupBy ?? defaultGroupField(type)?.id),
          }, f.name)))),
        dated && h('label', { class: 'inline-field' },
          h('span', null, 'Show by'),
          h('select', {
            class: 'select',
            dataset: { focusKey: 'date' },
            onChange: (event) => setView({ dateKey: event.target.value }),
          }, dateKeysFor(type).map((key) => h('option', { value: key.key, selected: key.key === currentDateKey(view) }, key.label)))),
        sortable && sortSelect(view, type, (next) => setView(next))));
    if (hadFocus) {
      if (pressed) toolbar.querySelector('.view-btn[aria-pressed="true"]')?.focus();
      else if (focusKey) toolbar.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
      else if (active === bar.button || active === selection.button) active.focus();
      else toolbar.querySelector('select[aria-label="Sort notes"]')?.focus();
    }
  }

  function refresh() {
    const view = getView();
    const mode = currentMode(view);
    const hasFilter = !specials[mode];
    if (selection.isActive() && !['list', 'table', 'cards'].includes(mode)) selection.stop();
    renderToolbar(mode, view);
    bar.sync();
    bar.panel.classList.toggle('is-off', !hasFilter);
    bar.summary.classList.toggle('is-off', !hasFilter);
    renderNotice?.(mode);
    if (specials[mode] || mode === 'calendar' || mode === 'timeline') renderSpecial(mode);
    else renderList(mode, view);
    selection.prune();
  }

  /** Lets a page show a note above the list, such as notes hidden by the current view. */
  let renderNotice = null;

  return {
    el: h('div', { class: 'presenter' }, toolbar, bar.panel, bar.summary, notice, body, selection.bar),
    notice,
    onNotice(fn) {
      renderNotice = fn;
    },
    refresh,
    openFilter: () => bar.open(),
    mounted: () => special?.instance.mounted?.(),
    destroy: () => {
      closeSpecial();
      selection.destroy();
    },
  };
}
