/**
 * dialogs.js: shared dialogs for organizing: edit space, edit collection, and "move to".
 */
import { app } from '../context.js';
import { SOFT_MAX_SPACES, SPACE_COLORS } from '../data/schema.js';
import { fold, snippet } from '../data/text.js';
import { displayTitle } from '../data/types.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { showError } from './actions.js';

export const SPACE_EMOJI = ['🎓', '🌿', '🎬', '💼', '🏠', '📚', '💡', '🧘', '🏃', '🎨', '🎵', '🍳', '✈️', '💰', '❤️', '🧪', '🛠️', '🌍', '📝', '🎮', '📁', '⭐'];

export function emojiPicker(input) {
  return h('div', { class: 'emoji-row', role: 'group', 'aria-label': 'Choose an icon' },
    SPACE_EMOJI.map((emoji) => h('button', {
      class: 'emoji-btn',
      type: 'button',
      'aria-label': `Use ${emoji}`,
      onClick: () => {
        input.value = emoji;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    }, emoji)));
}

export function colorPicker(selected, onPick) {
  let current = selected;
  const buttons = SPACE_COLORS.map((name) => {
    const button = h('button', {
      class: 'swatch',
      type: 'button',
      role: 'radio',
      'aria-label': name,
      'aria-checked': String(name === current),
      dataset: { color: name },
      onClick: () => {
        current = name;
        for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.color === name));
        onPick(name);
      },
    }, icon('check', 14));
    return button;
  });
  return h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' }, buttons);
}

/** Creates a space, or edits one. Resolves with the saved space, or undefined if cancelled. */
export function editSpaceDialog(space = null) {
  return openDialog({
    title: space ? 'Edit space' : 'New space',
    build: (close) => {
      let color = space?.color ?? SPACE_COLORS[app.db.listSpaces().length % SPACE_COLORS.length];
      const name = h('input', {
        class: 'input', type: 'text', value: space?.name ?? '', required: true, autofocus: true, maxlength: 60, placeholder: 'School, Personal, Fun…',
      });
      const emoji = h('input', { class: 'input input-emoji', type: 'text', value: space?.icon ?? '📁', maxlength: 8, 'aria-label': 'Icon' });
      const over = !space && app.db.listSpaces().length >= SOFT_MAX_SPACES;
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          const props = { name: name.value.trim(), icon: emoji.value.trim() || '📁', color };
          if (!props.name) return;
          try {
            close(space ? app.db.updateSpace(space.id, props) : app.db.createSpace(props));
          } catch (error) {
            showError(error);
          }
        },
      },
      over && h('p', { class: 'dialog-note' }, `You already have ${SOFT_MAX_SPACES} or more spaces. Fewer top-level areas stay easier to scan. A collection might fit better.`),
      h('div', { class: 'field-row' },
        h('label', { class: 'field field-narrow' }, h('span', { class: 'field-label' }, 'Icon'), emoji),
        h('label', { class: 'field field-grow' }, h('span', { class: 'field-label' }, 'Name'), name)),
      emojiPicker(emoji),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Color'),
        colorPicker(color, (next) => {
          color = next;
        })),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, space ? 'Save' : 'Create space')));
    },
  });
}

/** Creates a collection, or renames one. */
export function editCollectionDialog({ collection = null, spaceId, parentId = null } = {}) {
  const parent = app.db.getCollection(parentId);
  const startType = collection?.defaultTypeId ?? parent?.defaultTypeId ?? 'free';
  let title = 'New collection';
  if (collection) title = 'Edit collection';
  else if (parent) title = `New sub-collection in ${parent.name}`;
  return openDialog({
    title,
    build: (close) => {
      const name = h('input', {
        class: 'input', type: 'text', value: collection?.name ?? '', required: true, autofocus: true, maxlength: 80, placeholder: 'A project, list or notebook',
      });
      // Picking a type like "Job application" suggests a name, until one is typed in.
      let suggested = '';
      const typeSelect = h('select', {
        class: 'select select-field',
        id: 'collection-type',
        onChange: () => {
          if (collection || (name.value.trim() && name.value !== suggested)) return;
          suggested = app.db.getType(typeSelect.value).collectionName ?? '';
          name.value = suggested;
        },
      }, app.db.listTypes().map((type) => h('option', { value: type.id, selected: type.id === startType }, `${type.icon}  ${type.name}`)));
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          const value = name.value.trim();
          if (!value) return;
          try {
            close(collection
              ? app.db.updateCollection(collection.id, { name: value, defaultTypeId: typeSelect.value })
              : app.db.createCollection({ name: value, spaceId, parentId, defaultTypeId: typeSelect.value }));
          } catch (error) {
            showError(error);
          }
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'collection-type' }, 'New notes here are'),
        typeSelect,
        h('p', { class: 'field-hint' }, 'This also decides how the collection looks. Other types can still live here.')),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, collection ? 'Save' : 'Create collection')));
    },
  });
}

/** Searchable list of notes. Resolves with a note id, or undefined. */
export function pickNote({ title, excludeId = null }) {
  const { db } = app;
  const all = db.listNotes().filter((note) => note.id !== excludeId).map((note) => {
    const name = displayTitle(note, db.getType(note.typeId)) || 'Untitled';
    return { id: note.id, name, key: fold(name) };
  });
  const LIMIT = 40;
  return openDialog({
    title,
    className: 'dialog-picker',
    build: (close) => {
      const list = h('div', { class: 'picker-list', role: 'listbox', 'aria-label': 'Notes' });
      let matches = [];
      let active = 0;
      const render = () => {
        list.replaceChildren(...matches.map((item, index) => h('button', {
          class: `picker-item${index === active ? ' is-active' : ''}`,
          type: 'button',
          role: 'option',
          'aria-selected': String(index === active),
          tabindex: '-1',
          onClick: () => close(item.id),
        }, h('span', { class: 'picker-icon' }, icon('note', 16)), h('span', { class: 'picker-label' }, snippet(item.name, 70)))));
        if (!matches.length) list.append(h('p', { class: 'picker-empty' }, 'No matching notes.'));
        list.children[active]?.scrollIntoView?.({ block: 'nearest' });
      };
      const apply = () => {
        const q = fold(input.value.trim());
        matches = (q ? all.filter((item) => item.key.includes(q)) : all).slice(0, LIMIT);
        active = 0;
        render();
      };
      const input = h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Type to filter…',
        'aria-label': 'Filter notes',
        autofocus: true,
        onInput: apply,
        onKeydown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length) {
              active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
              render();
            }
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (matches[active]) close(matches[active].id);
          }
        },
      });
      apply();
      return h('div', null, input, list);
    },
  });
}

/** All destinations in display order, for a searchable picker. */
function destinations({ includeInbox, includeCollections = true, nestable = false, excludeId = null }) {
  const { db } = app;
  const list = [];
  if (includeInbox) list.push({ label: 'Inbox', detail: 'Decide later', icon: '📥', target: { spaceId: null, collectionId: null } });
  for (const space of db.listSpaces()) {
    list.push({ label: space.name, icon: space.icon, target: { spaceId: space.id, collectionId: null }, color: space.color });
    if (!includeCollections) continue;
    for (const col of db.listCollections(space.id)) {
      if (col.id !== excludeId) {
        list.push({ label: col.name, detail: space.name, depth: 1, target: { spaceId: space.id, collectionId: col.id } });
      }
      if (nestable) continue;
      for (const child of db.listCollections(space.id, col.id)) {
        list.push({ label: child.name, detail: `${space.name} › ${col.name}`, depth: 2, target: { spaceId: space.id, collectionId: child.id } });
      }
    }
  }
  return list;
}

/**
 * Searchable destination picker. Resolves with { spaceId, collectionId }, or undefined.
 * nestable: only destinations a collection may move into (spaces and top-level collections).
 */
export function pickDestination({ title, includeInbox = true, nestable = false, excludeId = null }) {
  const all = destinations({ includeInbox, nestable, excludeId });
  return openDialog({
    title,
    className: 'dialog-picker',
    build: (close) => {
      const list = h('div', { class: 'picker-list', role: 'listbox', 'aria-label': 'Destinations' });
      let matches = all;
      let active = 0;
      const render = () => {
        list.replaceChildren(...matches.map((item, index) => h('button', {
          class: `picker-item${index === active ? ' is-active' : ''}`,
          type: 'button',
          role: 'option',
          'aria-selected': String(index === active),
          tabindex: '-1',
          cssVars: { '--depth': item.depth ?? 0 },
          onClick: () => close(item.target),
        },
        h('span', { class: 'picker-icon' }, item.icon ?? icon('folder', 16)),
        h('span', { class: 'picker-label' }, item.label),
        item.detail && h('span', { class: 'picker-detail' }, item.detail))));
        if (!matches.length) list.append(h('p', { class: 'picker-empty' }, 'No matching place.'));
        list.children[active]?.scrollIntoView?.({ block: 'nearest' });
      };
      const input = h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Type to filter…',
        'aria-label': 'Filter destinations',
        autofocus: true,
        onInput: () => {
          const q = fold(input.value.trim());
          matches = q ? all.filter((item) => fold(`${item.label} ${item.detail ?? ''}`).includes(q)) : all;
          active = 0;
          render();
        },
        onKeydown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length) {
              active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
              render();
            }
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (matches[active]) close(matches[active].target);
          }
        },
      });
      render();
      return h('div', null, input, list);
    },
  });
}
