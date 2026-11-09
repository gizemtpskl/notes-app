/**
 * folder.js: the Space page and the Collection page.
 *
 * A collection opens in the view its default type asks for, then remembers the last view you
 * chose. Views are List, Table, Cards, Kanban, Calendar and Timeline, plus Tasks or Journal for
 * those types. The views themselves live in presenter.js.
 */
import { app } from '../context.js';
import { emptyFilter } from '../data/filters.js';
import { tasksFields, viewsFor } from '../data/types.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { newNote } from './actions.js';
import { editCollectionDialog } from './dialogs.js';
import { examPrepView, lecturesView, topicsView } from './courseViews.js';
import { journalView } from './journal.js';
import { emptyState, noteList } from './noteList.js';
import { openPicker } from './pickerDialog.js';
import { notesPresenter, sortSelect } from './presenter.js';
import { saveFilterAsView } from './savedViews.js';
import { createSelection } from './selection.js';
import { tasksAgendaView } from './tasksAgenda.js';
import { pickTemplateDialog } from './templatesPage.js';

function collectionCard(col) {
  const count = app.db.counts().collections.get(col.id) ?? 0;
  const type = app.db.getType(col.defaultTypeId);
  return h('a', { class: 'folder-card', href: `#/collection/${col.id}` },
    type.id === 'free' ? icon('folder', 18) : h('span', { class: 'folder-card-icon', 'aria-hidden': 'true' }, type.icon),
    h('span', { class: 'folder-card-name' }, col.name),
    h('span', { class: 'folder-card-count' }, plural(count, 'note')));
}

export function breadcrumbs(items) {
  return h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' },
    h('ol', null, items.map((item, index) => h('li', null,
      index === items.length - 1 && !item.href
        ? h('span', { 'aria-current': 'page' }, item.label)
        : h('a', { href: item.href }, item.label)))));
}

/** "New note" plus a menu for choosing another type. */
function newNoteButtons(target, type) {
  const { db } = app;
  const label = type.id === 'free' ? 'New note' : `New ${type.name.toLowerCase()}`;
  return h('div', { class: 'split-btn' },
    h('button', { class: 'btn btn-primary', type: 'button', onClick: () => newNote(target) }, icon('plus', 16), label),
    h('button', {
      class: 'btn btn-primary split-more',
      type: 'button',
      'aria-label': 'New note of another type',
      'aria-haspopup': 'menu',
      title: 'Choose a type',
      onClick: (event) => openMenu(event.currentTarget, [
        ...db.listTypes().map((t) => ({ label: `${t.icon}  ${t.name}`, onSelect: () => newNote({ ...target, typeId: t.id }) })),
        'separator',
        { label: 'From a template…', icon: 'template', onSelect: () => pickTemplateDialog(target) },
        { label: 'Manage types', icon: 'settings', onSelect: () => app.navigate('types') },
      ], { label: 'New note of type' }),
    }, icon('chevronDown', 14)));
}

export function spaceView({ id }) {
  const { db } = app;
  const space = db.getSpace(id);
  if (!space) return notFound('This space no longer exists.');

  const body = h('div');
  const uiKey = `spaceSort:${id}`;
  const freeType = db.getType('free');
  const rootNotes = () => {
    const sort = db.getMeta('ui', {})[uiKey] ?? { sort: 'updated', dir: 'desc' };
    return db.listNotes({
      spaceId: id, rootOnly: true, sort: { key: sort.sort, dir: sort.dir }, pinnedFirst: true,
    });
  };
  const selection = createSelection({ getIds: () => rootNotes().map((n) => n.id), onMode: () => refresh() });

  function refresh() {
    const collections = db.listCollections(id);
    const sort = db.getMeta('ui', {})[uiKey] ?? { sort: 'updated', dir: 'desc' };
    const notes = rootNotes();
    const isEmpty = !collections.length && !notes.length;
    fill(body,
      collections.length > 0 && h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Collections'),
        h('div', { class: 'folder-grid' }, collections.map(collectionCard))),
      isEmpty && emptyState({
        emoji: space.icon,
        title: `${space.name} is empty`,
        text: 'Collections group related notes, like a project, a list or a notebook.',
        action: h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onClick: () => editCollectionDialog({ spaceId: id }),
        }, icon('folder', 16), 'Create a collection'),
      }),
      notes.length > 0 && h('section', { class: 'section' },
        h('div', { class: 'section-head' },
          h('h2', { class: 'section-title' }, collections.length ? 'Not in a collection' : 'Notes'),
          h('div', { class: 'view-toolbar-right' },
            selection.button,
            sortSelect(sort, freeType, (next) => {
              db.setMeta('ui', { ...db.getMeta('ui', {}), [uiKey]: next });
              refresh();
            }))),
        noteList(notes, { selection })),
    );
  }

  refresh();

  return {
    title: space.name,
    el: h('div', { class: 'page', dataset: { color: space.color } },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, h('span', { class: 'page-emoji', 'aria-hidden': 'true' }, space.icon), space.name),
          h('div', { class: 'page-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => editCollectionDialog({ spaceId: id }) }, icon('folder', 16), 'New collection'),
            newNoteButtons({ spaceId: id }, freeType)))),
      body,
      selection.bar),
    update: (change) => {
      if (change.structural || change.stores.has('notes')) {
        refresh();
        selection.prune();
      }
    },
    // The header is built once, so a rename needs a rebuild. Moving other spaces around does not.
    reloadIf: () => {
      const now = db.getSpace(id);
      return !now || now.name !== space.name || now.icon !== space.icon || now.color !== space.color;
    },
    newNoteTarget: { spaceId: id },
    destroy: () => selection.destroy(),
  };
}

export function collectionView({ id }) {
  const { db } = app;
  const col = db.getCollection(id);
  if (!col) return notFound('This collection no longer exists.');
  const space = db.getSpace(col.spaceId);
  const parent = db.getCollection(col.parentId);
  const type = db.getType(col.defaultTypeId);
  const target = { collectionId: id };

  const childrenEl = h('div');

  function setView(patch) {
    const current = db.getCollection(id);
    db.updateCollection(id, { view: { ...current.view, ...patch } });
  }

  const presenter = notesPresenter({
    getType: () => type,
    getViews: () => viewsFor(type),
    getDefaultMode: () => type.defaultView,
    getView: () => db.getCollection(id)?.view ?? {},
    setView,
    locked: { ...emptyFilter(), collections: [id], exact: true },
    filterTypes: () => {
      const seen = new Map([[type.id, type]]);
      for (const note of db.listNotes({ collectionId: id })) seen.set(note.typeId, db.getType(note.typeId));
      return [...seen.values()];
    },
    specials: {
      journal: () => journalView({ collectionId: id, type, target }),
      tasks: () => tasksAgendaView({
        getNotes: () => db.listNotes({ collectionId: id, sort: { key: 'updated', dir: 'desc' }, pinnedFirst: true })
          .filter((note) => tasksFields(db.getType(note.typeId)).length),
        onNew: () => newNote(target),
      }),
      lectures: () => lecturesView({ collectionId: id, onNew: () => newNote(target) }),
      topics: () => topicsView({ collectionId: id, onNew: () => newNote(target) }),
      exam: () => examPrepView({ collectionId: id }),
    },
    onNewOnDate: (date, dateKey) => newNote({ ...target, fields: { [dateKey.slice(6)]: date } }),
    onSaveView: (filter) => saveFilterAsView({ ...filter, collections: [id], includePrivate: true }, db.getCollection(id)?.view),
    emptyContent: () => {
      const current = db.getCollection(id);
      return db.listCollections(current.spaceId, id).length > 0
        ? h('p', { class: 'empty-line' }, 'No notes directly in this collection.')
        : emptyState({
          emoji: type.icon,
          title: 'Nothing here yet',
          text: `New notes in ${current.name} will appear here. Press Shift+N to add one quickly.`,
          action: h('button', { class: 'btn btn-primary', type: 'button', onClick: () => newNote(target) }, icon('plus', 16), type.id === 'free' ? 'New note' : `New ${type.name.toLowerCase()}`),
        });
    },
  });

  /** Journal and Tasks only show their own kind of note, so nothing else may seem to have vanished. */
  presenter.onNotice((mode) => {
    let hidden = 0;
    if (mode === 'journal' || mode === 'tasks') {
      for (const note of db.listNotes({ collectionId: id })) {
        const shown = mode === 'journal' ? note.typeId === type.id : tasksFields(db.getType(note.typeId)).length > 0;
        if (!shown) hidden += 1;
      }
    }
    fill(presenter.notice, hidden > 0 && h('div', { class: 'view-notice' },
      h('span', null, `${plural(hidden, 'other note')} in this collection ${hidden === 1 ? 'isn’t' : 'aren’t'} shown in this view.`),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => setView({ mode: 'list' }) }, 'Show in List')));
  });

  function refresh() {
    const current = db.getCollection(id);
    if (!current) return;
    const children = db.listCollections(current.spaceId, id);
    fill(childrenEl, children.length > 0 && h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Sub-collections'),
      h('div', { class: 'folder-grid' }, children.map(collectionCard))));
    presenter.refresh();
  }

  refresh();

  return {
    title: col.name,
    el: h('div', { class: 'page page-wide', dataset: { color: space?.color ?? 'slate' } },
      h('header', { class: 'page-head' },
        breadcrumbs([
          { label: `${space?.icon ?? ''} ${space?.name ?? ''}`.trim(), href: `#/space/${col.spaceId}` },
          parent && { label: parent.name, href: `#/collection/${parent.id}` },
          { label: col.name },
        ].filter(Boolean)),
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, col.name),
          h('div', { class: 'page-actions' },
            type.picker && h('button', {
              class: `btn${type.picker.big ? ' btn-primary btn-surprise' : ''}`,
              type: 'button',
              onClick: () => openPicker(db.listNotes({ collectionId: id }).filter((n) => n.typeId === type.id), type),
            }, icon('shuffle', 16), type.picker.button),
            h('button', {
              class: 'icon-btn',
              type: 'button',
              'aria-label': 'Edit collection',
              title: 'Edit collection',
              onClick: () => editCollectionDialog({ collection: db.getCollection(id) }),
            }, icon('edit', 17)),
            !col.parentId && h('button', {
              class: 'icon-btn',
              type: 'button',
              'aria-label': 'New sub-collection',
              title: 'New sub-collection',
              onClick: () => editCollectionDialog({ spaceId: col.spaceId, parentId: id }),
            }, icon('folder', 17)),
            newNoteButtons(target, type)))),
      childrenEl,
      presenter.el),
    mounted: presenter.mounted,
    update: (change) => {
      if (change.structural || change.stores.has('notes') || change.stores.has('collections')) refresh();
    },
    // The header is built once, so a rename, move or new default type needs a rebuild.
    reloadIf: () => {
      const now = db.getCollection(id);
      return !now || now.name !== col.name || now.spaceId !== col.spaceId || now.parentId !== col.parentId
        || now.defaultTypeId !== col.defaultTypeId
        || db.getSpace(col.spaceId)?.name !== space?.name || db.getCollection(col.parentId)?.name !== parent?.name;
    },
    newNoteTarget: target,
    destroy: presenter.destroy,
  };
}

export function notFound(message) {
  return {
    title: 'Not found',
    el: h('div', { class: 'page' },
      emptyState({
        emoji: '🧭',
        title: message,
        text: 'It may have been deleted or moved.',
        action: h('a', { class: 'btn', href: '#/home' }, 'Go to Home'),
      })),
  };
}

