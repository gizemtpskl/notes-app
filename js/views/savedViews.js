/**
 * savedViews.js: filters you keep. A saved view holds a filter, a sort, a grouping and a view
 * mode. Pinned views appear in the sidebar.
 */
import { app } from '../context.js';
import { countConditions, emptyFilter, normalizeFilter, queryNotes } from '../data/filters.js';
import { unionType, viewsFor } from '../data/types.js';
import { fill, h, plural } from '../ui/dom.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { withUndo } from './actions.js';
import { emojiPicker } from './dialogs.js';
import { notFound } from './folder.js';
import { emptyState } from './noteList.js';
import { notesPresenter } from './presenter.js';

/** Names a view. Resolves with { name, icon }, or undefined. */
function viewNameDialog({ title, view, confirmLabel }) {
  return openDialog({
    title,
    build: (close) => {
      const name = h('input', {
        class: 'input', type: 'text', value: view?.name ?? '', required: true, autofocus: true, maxlength: 80, placeholder: 'Unwatched thrillers',
      });
      const emoji = h('input', { class: 'input input-emoji', type: 'text', value: view?.icon ?? '🔖', maxlength: 8, 'aria-label': 'Icon' });
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          if (name.value.trim()) close({ name: name.value.trim(), icon: emoji.value.trim() || '🔖' });
        },
      },
      h('div', { class: 'field-row' },
        h('label', { class: 'field field-narrow' }, h('span', { class: 'field-label' }, 'Icon'), emoji),
        h('label', { class: 'field field-grow' }, h('span', { class: 'field-label' }, 'Name'), name)),
      emojiPicker(emoji),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel)));
    },
  });
}

/** Saves a filter as a view and opens it. */
export async function saveFilterAsView(filter, viewSettings = {}) {
  const props = await viewNameDialog({ title: 'Save as view', confirmLabel: 'Save view' });
  if (!props) return;
  const { filter: _ignored, ...settings } = viewSettings ?? {};
  const saved = app.db.createSavedView({
    ...props,
    filter: normalizeFilter(filter),
    view: { sort: 'updated', dir: 'desc', mode: 'list', ...settings },
  });
  app.navigate(`view/${saved.id}`);
}

export async function createViewFlow() {
  const props = await viewNameDialog({ title: 'New view', confirmLabel: 'Create view' });
  if (!props) return;
  const saved = app.db.createSavedView({ ...props, filter: emptyFilter() });
  app.navigate(`view/${saved.id}?new`);
}

export async function renameView(view) {
  const props = await viewNameDialog({ title: 'Edit view', view, confirmLabel: 'Save' });
  if (props) app.db.updateSavedView(view.id, props);
}

export async function deleteView(view, { leave = false } = {}) {
  const ok = await confirmDialog({
    title: `Delete "${view.name}"?`,
    message: 'Only the view is deleted. Its notes stay where they are.',
    confirmLabel: 'Delete view',
    danger: true,
  });
  if (!ok) return;
  if (leave) app.navigate('views');
  withUndo(`Deleted ${view.name}`, () => app.db.deleteSavedView(view.id));
}

export function viewMenuItems(view, index, total) {
  const { db } = app;
  return [
    {
      label: view.pinned ? 'Remove from sidebar' : 'Show in sidebar',
      icon: 'pin',
      onSelect: () => db.updateSavedView(view.id, { pinned: !view.pinned }),
    },
    { label: 'Edit name and icon', icon: 'edit', onSelect: () => renameView(view) },
    'separator',
    { label: 'Move up', icon: 'arrowUp', disabled: index === 0, onSelect: () => db.moveSavedView(view.id, index - 1) },
    { label: 'Move down', icon: 'arrowDown', disabled: index === total - 1, onSelect: () => db.moveSavedView(view.id, index + 1) },
    'separator',
    { label: 'Delete view', icon: 'trash', danger: true, onSelect: () => deleteView(view, { leave: location.hash.includes(view.id) }) },
  ];
}

/** Starting points that show what views can do, fitted to the spaces and types that exist. */
export function addExampleViews() {
  const { db } = app;
  const school = db.listSpaces().find((space) => /school|study|university|okul/i.test(space.name));
  const base = emptyFilter();
  db.batch(() => {
    db.createSavedView({
      name: 'Unwatched thrillers',
      icon: '🎬',
      filter: {
        ...base,
        types: ['watchlist'],
        rules: [{ field: 'status', op: 'is', value: 'To watch' }, { field: 'genres', op: 'has', value: 'Thriller' }],
      },
      view: { sort: 'updated', dir: 'desc', mode: 'cards' },
    });
    db.createSavedView({
      name: school ? `Overdue ${school.name.toLowerCase()} tasks` : 'Overdue tasks',
      icon: '⏰',
      filter: {
        ...base,
        spaces: school ? [school.id] : [],
        date: {
          key: 'due', range: 'overdue', from: '', to: '',
        },
      },
      view: { sort: 'due', dir: 'asc', mode: 'list' },
    });
    db.createSavedView({
      name: 'Low-effort ideas under 30 minutes',
      icon: '💡',
      filter: {
        ...base,
        types: ['idea'],
        rules: [{ field: 'effort', op: 'is', value: 'Low' }, { field: 'minutes', op: 'lte', value: 30 }],
      },
      view: { sort: 'updated', dir: 'desc', mode: 'cards' },
    });
  });
}

export function savedViewsPageView() {
  const { db } = app;
  const body = h('div');

  function refresh() {
    const views = db.listSavedViews();
    fill(body, views.length
      ? h('ul', { class: 'type-list' }, views.map((view, index) => {
        const count = queryNotes(db, normalizeFilter(view.filter)).length;
        return h('li', { class: 'tag-row', dataset: { id: view.id } },
          h('a', { class: 'tag-row-link', href: `#/view/${encodeURIComponent(view.id)}` },
            h('span', { class: 'tag-row-name' }, h('span', { class: 'view-row-icon', 'aria-hidden': 'true' }, view.icon), view.name),
            h('span', { class: 'tag-row-count' }, plural(count, 'note'))),
          view.pinned && h('span', { class: 'note-flag', title: 'In the sidebar' }, icon('pin', 13)),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Actions for ${view.name}`,
            'aria-haspopup': 'menu',
            onClick: (event) => openMenu(event.currentTarget, viewMenuItems(view, index, views.length), { label: `${view.name} actions` }),
          }, icon('more')));
      }))
      : emptyState({
        emoji: '🔖',
        title: 'No saved views yet',
        text: 'A view is a question you ask often, such as "unwatched thrillers" or "overdue school tasks". It stays up to date by itself.',
        action: h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onClick: createViewFlow }, icon('plus', 16), 'New view'),
          h('button', { class: 'btn', type: 'button', onClick: addExampleViews }, 'Add three examples')),
      }));
  }

  refresh();
  return {
    title: 'Saved views',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, 'Saved views'),
          h('div', { class: 'page-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: createViewFlow }, icon('plus', 16), 'New view')))),
      body),
    update: (change) => {
      if (change.stores.has('savedViews') || change.structural) refresh();
    },
  };
}

export function savedView({ id, isNew = false }) {
  const { db } = app;
  const initial = db.getSavedView(id);
  if (!initial) return notFound('This view no longer exists.');

  const current = () => db.getSavedView(id) ?? initial;
  const chosenTypes = () => {
    const filter = normalizeFilter(current().filter);
    if (filter.types.length) return filter.types.map((typeId) => db.getType(typeId));
    const seen = new Map();
    for (const note of queryNotes(db, filter)) seen.set(note.typeId, db.getType(note.typeId));
    return seen.size ? [...seen.values()] : [db.getType('free')];
  };
  const getType = () => unionType(chosenTypes());

  const presenter = notesPresenter({
    getType,
    getViews: () => viewsFor(getType()).filter((mode) => mode !== 'journal' && mode !== 'tasks'),
    getDefaultMode: () => 'list',
    getView: () => ({ ...current().view, filter: current().filter }),
    setView: ({ filter, ...patch }) => db.updateSavedView(id, {
      ...(filter ? { filter } : {}),
      view: { ...current().view, ...patch },
    }),
    scope: 'global',
    filterTypes: () => (normalizeFilter(current().filter).types.length ? chosenTypes() : db.listTypes()),
    showLocation: true,
    emptyContent: () => emptyState({
      emoji: '🔖',
      title: countConditions(normalizeFilter(current().filter)) ? 'Nothing here right now' : 'Choose what this view shows',
      text: 'Add conditions with the Filter button.',
    }),
  });
  presenter.refresh();

  return {
    title: initial.name,
    el: h('div', { class: 'page page-wide' },
      h('header', { class: 'page-head' },
        h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, h('li', null, h('a', { href: '#/views' }, 'Saved views')), h('li', null, h('span', { 'aria-current': 'page' }, initial.name)))),
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, h('span', { class: 'page-emoji', 'aria-hidden': 'true' }, initial.icon), initial.name),
          h('div', { class: 'page-actions' },
            h('button', {
              class: 'icon-btn',
              type: 'button',
              'aria-label': 'View actions',
              'aria-haspopup': 'menu',
              onClick: (event) => {
                const views = db.listSavedViews();
                openMenu(event.currentTarget, viewMenuItems(current(), views.findIndex((v) => v.id === id), views.length), { label: 'View actions' });
              },
            }, icon('more'))))),
      presenter.el),
    mounted: () => {
      presenter.mounted();
      if (isNew) presenter.openFilter();
    },
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('savedViews') || change.stores.has('tags')) presenter.refresh();
    },
    reloadIf: () => {
      const now = db.getSavedView(id);
      return !now || now.name !== initial.name || now.icon !== initial.icon;
    },
    destroy: presenter.destroy,
  };
}
