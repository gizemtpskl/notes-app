/**
 * noteList.js: the list of notes used everywhere. Renders in pages, so even a list of
 * thousands of notes opens instantly. Rows can be dragged onto the sidebar.
 */
import { app } from '../context.js';
import { fieldValue } from '../data/fieldKinds.js';
import { donePatch } from '../data/picker.js';
import { snippet } from '../data/text.js';
import { displayTitle, previewText, summaryFields } from '../data/types.js';
import { endDrag, startDrag } from '../ui/drag.js';
import { h, shortDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { archiveNotes, locationName, moveNotes, trashNotes, withUndo } from './actions.js';
import { pickDestination } from './dialogs.js';
import { fieldDisplay } from './fieldWidgets.js';

const PAGE_SIZE = 100;

export function noteMenuItems(note) {
  const type = app.db.getType(note.typeId);
  return [
    type.picker?.done && {
      label: 'Mark as done',
      icon: 'check',
      onSelect: () => withUndo('Marked as done', () => app.db.updateNote(note.id, donePatch(note, type))),
    },
    { label: note.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => app.db.setPinned(note.id, !note.pinned) },
    { label: note.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onSelect: () => app.db.setFavorite(note.id, !note.favorite) },
    {
      label: 'Move to…',
      icon: 'move',
      onSelect: async () => {
        const target = await pickDestination({ title: 'Move note to' });
        if (target) moveNotes([note.id], target);
      },
    },
    'separator',
    { label: 'Archive', icon: 'archive', onSelect: () => archiveNotes([note.id]) },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => trashNotes([note.id]) },
  ];
}

/** Small tag labels for rows and cards. */
export function tagChips(note, limit = 3) {
  const names = (note.tagIds ?? []).map((id) => app.db.getTag(id)?.name).filter(Boolean);
  const shown = names.slice(0, limit).map((name) => h('span', { class: 'tag-mini' }, `#${name}`));
  if (names.length > limit) shown.push(h('span', { class: 'tag-mini' }, `+${names.length - limit}`));
  return shown;
}

/**
 * options:
 *   showLocation  show where each note lives
 *   dateKey       which timestamp to show: 'updated' by default
 *   rowActions    (note) => elements, replaces the default menu
 *   empty         element shown for an empty list
 *   draggable     default true
 *   selection     from createSelection: while it is active, rows show check boxes
 */
export function noteList(notes, options = {}) {
  const {
    showLocation = false, dateKey = 'updated', rowActions, empty, draggable = true, selection,
  } = options;
  const selecting = selection?.isActive();
  if (!notes.length) return empty ?? h('p', { class: 'empty-line' }, 'No notes here yet.');

  const list = h('ul', { class: `note-list${selecting ? ' is-selecting' : ''}` });
  const wrap = h('div', { class: 'note-list-wrap' }, list);
  let shown = 0;

  const more = h('button', {
    class: 'btn btn-more',
    type: 'button',
    onClick: () => {
      const firstNew = shown;
      showMore();
      list.children[firstNew]?.querySelector('a')?.focus();
    },
  });

  function showMore() {
    const end = Math.min(shown + PAGE_SIZE, notes.length);
    const fragment = document.createDocumentFragment();
    for (let i = shown; i < end; i += 1) fragment.append(row(notes[i]));
    list.append(fragment);
    shown = end;
    if (shown < notes.length) {
      more.textContent = `Show more (${(notes.length - shown).toLocaleString()} left)`;
      if (!more.isConnected) wrap.append(more);
    } else {
      more.remove();
    }
  }

  function row(note) {
    const type = app.db.getType(note.typeId);
    const title = displayTitle(note, type);
    const preview = snippet(previewText(note, type), 120);
    const location = showLocation ? locationName(note) : null;
    const chips = [
      ...summaryFields(type).map((field) => fieldDisplay(field, fieldValue(note, field), { db: app.db, compact: true, note })),
      ...tagChips(note),
    ].filter(Boolean);
    return h('li', { class: `note-row${selecting && selection.isSelected(note.id) ? ' is-selected' : ''}`, dataset: { id: note.id } },
      selecting && selection.checkbox(note, title || 'Untitled'),
      h('a', {
        class: 'note-link',
        href: `#/note/${note.id}`,
        draggable: draggable && !selecting,
        onClick: selecting ? (event) => {
          event.preventDefault();
          selection.toggle(note.id, event);
        } : null,
        onDragstart: (event) => startDrag(event, { kind: 'note', id: note.id, label: title }),
        onDragend: endDrag,
      },
      h('span', { class: 'note-row-head' },
        note.pinned && h('span', { class: 'note-flag', title: 'Pinned' }, icon('pin', 13)),
        note.favorite && h('span', { class: 'note-flag', title: 'Favorite' }, icon('star', 13)),
        type.id !== 'free' && h('span', { class: 'note-type', title: type.name }, h('span', { 'aria-hidden': 'true' }, type.icon), h('span', { class: 'sr-only' }, `${type.name}: `)),
        note.private && h('span', { class: 'note-flag', title: 'Private' }, icon('lock', 13)),
        h('span', { class: `note-title${title ? '' : ' is-untitled'}` }, title || 'Untitled')),
      preview && preview !== title && h('span', { class: 'note-preview' }, preview),
      chips.length > 0 && h('span', { class: 'note-chips' }, chips),
      h('span', { class: 'note-meta' },
        location && h('span', { class: 'note-location' }, location),
        h('time', { datetime: new Date(note[dateKey] ?? note.updated).toISOString() }, shortDate(note[dateKey] ?? note.updated)))),
      !selecting && h('div', { class: 'note-row-actions' },
        rowActions ? rowActions(note) : h('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': `Actions for ${title || 'Untitled'}`,
          'aria-haspopup': 'menu',
          onClick: (event) => openMenu(event.currentTarget, noteMenuItems(note), { label: 'Note actions' }),
        }, icon('more'))));
  }

  showMore();
  return wrap;
}

/** Friendly empty state with a title, a hint and an optional action. */
export function emptyState({ emoji, title, text, action }) {
  return h('div', { class: 'empty-state' },
    emoji && h('div', { class: 'empty-emoji', 'aria-hidden': 'true' }, emoji),
    h('h2', { class: 'empty-title' }, title),
    text && h('p', { class: 'empty-text' }, text),
    action);
}
