/**
 * lists.js: Favorites, Archive and Trash.
 */
import { app } from '../context.js';
import { TRASH_DAYS, DAY_MS } from '../data/schema.js';
import { h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { emptyState, noteList } from './noteList.js';
import { purgeNotes, restoreNotes, trashNotes, unarchiveNotes } from './actions.js';
import { createSelection } from './selection.js';

function listPage({ title, sub, actions, body }) {
  return h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('div', { class: 'page-title-row' },
        h('h1', { class: 'page-title', tabindex: '-1' }, title),
        actions && h('div', { class: 'page-actions' }, actions)),
      sub && h('p', { class: 'page-sub' }, sub)),
    h('section', { class: 'section' }, body));
}

export function favoritesView() {
  const body = h('div');
  const selection = createSelection({
    getIds: () => app.db.listNotes({ favorite: true }).map((n) => n.id),
    onMode: () => refresh(),
  });
  const refresh = () => body.replaceChildren(noteList(app.db.listNotes({ favorite: true }), {
    showLocation: true,
    selection,
    empty: emptyState({
      emoji: '⭐',
      title: 'No favorites yet',
      text: 'Press the star on any note to keep it close at hand.',
    }),
  }));
  refresh();
  return {
    title: 'Favorites',
    el: listPage({ title: 'Favorites', actions: selection.button, body: [body, selection.bar] }),
    update: (change) => {
      if (change.structural) {
        refresh();
        selection.prune();
      }
    },
    destroy: () => selection.destroy(),
  };
}

export function archiveView() {
  const body = h('div');
  const selection = createSelection({
    kind: 'archived',
    getIds: () => app.db.listNotes({ status: 'archived' }).map((n) => n.id),
    onMode: () => refresh(),
  });
  const refresh = () => body.replaceChildren(noteList(app.db.listNotes({ status: 'archived' }), {
    showLocation: true,
    selection,
    rowActions: (note) => [
      h('button', {
        class: 'btn btn-small', type: 'button', 'aria-label': `Unarchive ${note.title || 'Untitled'}`, onClick: () => unarchiveNotes([note.id]),
      }, icon('restore', 15), 'Unarchive'),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `Delete ${note.title || 'Untitled'}`, title: 'Delete', onClick: () => trashNotes([note.id]),
      }, icon('trash')),
    ],
    empty: emptyState({
      emoji: '🗄️',
      title: 'Archive is empty',
      text: 'Finished things can rest here. Archived notes keep their place but stay out of your lists.',
    }),
  }));
  refresh();
  return {
    title: 'Archive',
    el: listPage({
      title: 'Archive', sub: 'Hidden from your lists, but kept and restorable.', actions: selection.button, body: [body, selection.bar],
    }),
    update: (change) => {
      if (change.structural) {
        refresh();
        selection.prune();
      }
    },
    destroy: () => selection.destroy(),
  };
}

export function trashView() {
  const { db } = app;
  const body = h('div');
  const emptyButton = h('button', {
    class: 'btn btn-danger-quiet',
    type: 'button',
    onClick: async () => {
      const ids = db.listNotes({ status: 'trash' }).map((n) => n.id);
      const ok = await confirmDialog({
        title: `Delete ${plural(ids.length, 'note')} forever?`,
        message: 'Everything in the Trash will be permanently deleted. This cannot be undone.',
        confirmLabel: 'Empty Trash',
        danger: true,
      });
      if (ok) {
        db.purgeNotes(ids);
        toast('Trash emptied');
      }
    },
  }, 'Empty Trash');

  const selection = createSelection({
    kind: 'trash',
    getIds: () => db.listNotes({ status: 'trash', sort: { key: 'trashedAt', dir: 'desc' } }).map((n) => n.id),
    onMode: () => refresh(),
  });

  function daysLeft(note) {
    return Math.max(0, Math.ceil((note.trashedAt + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
  }

  function refresh() {
    const notes = db.listNotes({ status: 'trash', sort: { key: 'trashedAt', dir: 'desc' } });
    emptyButton.hidden = !notes.length;
    selection.button.hidden = !notes.length;
    body.replaceChildren(noteList(notes, {
      showLocation: true,
      selection,
      dateKey: 'trashedAt',
      draggable: false,
      rowActions: (note) => [
        h('span', { class: 'note-days-left' }, `${plural(daysLeft(note), 'day')} left`),
        h('button', {
          class: 'btn btn-small', type: 'button', 'aria-label': `Restore ${note.title || 'Untitled'}`, onClick: () => restoreNotes([note.id]),
        }, icon('restore', 15), 'Restore'),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Delete ${note.title || 'Untitled'} forever`, title: 'Delete forever', onClick: () => purgeNotes([note.id]),
        }, icon('close')),
      ],
      empty: emptyState({
        emoji: '🧹',
        title: 'Trash is empty',
        text: `Deleted notes stay here for ${TRASH_DAYS} days, so you can change your mind.`,
      }),
    }));
  }

  refresh();
  return {
    title: 'Trash',
    el: listPage({
      title: 'Trash', sub: `Notes are permanently deleted ${TRASH_DAYS} days after you delete them.`, actions: [selection.button, emptyButton], body: [body, selection.bar],
    }),
    update: (change) => {
      if (change.structural) {
        refresh();
        selection.prune();
      }
    },
    destroy: () => selection.destroy(),
  };
}
