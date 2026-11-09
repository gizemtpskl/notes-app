/**
 * collectionViews.js: Table, Cards and Kanban. They work for any type, driven by its fields.
 * The List view is noteList.js and Calendar and Timeline are calendarViews.js. presenter.js picks
 * between them.
 */
import { app } from '../context.js';
import { fieldValue } from '../data/fieldKinds.js';
import { displayTitle, previewText, summaryFields, tableFields } from '../data/types.js';
import { snippet } from '../data/text.js';
import { h, shortDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { pointerDrag } from '../ui/pointerDrag.js';
import { withUndo } from './actions.js';
import { fieldDisplay } from './fieldWidgets.js';
import { noteMenuItems, tagChips } from './noteList.js';

const PAGE_SIZE = 100;

/** Adds rows in pages, so large collections open instantly. */
function paged(items, container, makeRow) {
  let shown = 0;
  const more = h('button', {
    class: 'btn btn-more',
    type: 'button',
    onClick: () => {
      showMore();
    },
  });
  function showMore() {
    const end = Math.min(shown + PAGE_SIZE, items.length);
    const fragment = document.createDocumentFragment();
    for (let i = shown; i < end; i += 1) fragment.append(makeRow(items[i]));
    container.append(fragment);
    shown = end;
    if (shown < items.length) more.textContent = `Show more (${(items.length - shown).toLocaleString()} left)`;
    else more.remove();
  }
  showMore();
  return shown < items.length ? more : null;
}

const titleOf = (note) => displayTitle(note, app.db.getType(note.typeId)) || 'Untitled';

/** A segmented control for choosing a view. */
export function viewSwitcher(modes, current, labels, onChoose) {
  return h('div', { class: 'view-switcher', role: 'group', 'aria-label': 'View' },
    modes.map((mode) => h('button', {
      class: 'view-btn',
      type: 'button',
      'aria-pressed': String(mode === current),
      title: labels[mode].label,
      onClick: () => onChoose(mode),
    }, icon(labels[mode].icon, 15), h('span', { class: 'view-btn-label' }, labels[mode].label))));
}

// -- Table --------------------------------------------------------------------------------

export function tableView(notes, type, { sort, onSort, selection }) {
  const selecting = selection?.isActive();
  const columns = [
    ...(selecting ? [{ key: 'select', label: '', sortable: false, cell: (note) => selection.checkbox(note, titleOf(note)) }] : []),
    { key: 'title', label: 'Title', cell: (note) => h('a', { class: 'table-title', href: `#/note/${encodeURIComponent(note.id)}` }, titleOf(note)) },
    ...tableFields(type).map((field) => ({
      key: `field:${field.id}`,
      label: field.name,
      cell: (note) => fieldDisplay(field, fieldValue(note, field), { db: app.db, compact: true }),
    })),
    {
      key: 'tags',
      label: 'Tags',
      sortable: false,
      cell: (note) => {
        const chips = tagChips(note);
        return chips.length ? h('span', { class: 'note-chips' }, chips) : null;
      },
    },
    { key: 'updated', label: 'Updated', cell: (note) => h('time', { class: 'date-display' }, shortDate(note.updated)) },
  ];

  const header = h('tr', null, columns.map((column) => {
    const active = sort.key === column.key;
    if (column.sortable === false) return h('th', { scope: 'col' }, h('span', { class: 'th-btn th-plain' }, column.label));
    return h('th', { scope: 'col', 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', {
        class: 'th-btn',
        type: 'button',
        onClick: () => {
          const descFirst = column.key === 'updated';
          let dir = descFirst ? 'desc' : 'asc';
          if (active) dir = sort.dir === 'asc' ? 'desc' : 'asc';
          onSort({ key: column.key, dir });
        },
      }, column.label, active && icon(sort.dir === 'asc' ? 'arrowUp' : 'arrowDown', 13)));
  }));

  const tbody = h('tbody');
  const more = paged(notes, tbody, (note) => h('tr', {
    class: selecting && selection.isSelected(note.id) ? 'is-selected' : null,
    dataset: { id: note.id },
    onClick: selecting ? (event) => {
      if (event.target.closest('.row-check')) return;
      event.preventDefault();
      selection.toggle(note.id, event);
    } : null,
  }, columns.map((column) => h('td', null, column.cell(note)))));

  return h('div', null,
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Notes table' },
      h('table', { class: `data-table${selecting ? ' is-selecting' : ''}` }, h('thead', null, header), tbody)),
    more);
}

// -- Cards --------------------------------------------------------------------------------

function cardBody(note, type) {
  const preview = snippet(previewText(note, type), 140);
  const title = titleOf(note);
  return [
    h('span', { class: 'card-title' },
      note.pinned && h('span', { class: 'note-flag', title: 'Pinned' }, icon('pin', 13)),
      note.favorite && h('span', { class: 'note-flag', title: 'Favorite' }, icon('star', 13)),
      h('span', { class: note.title || title !== 'Untitled' ? '' : 'is-untitled' }, title)),
    h('span', { class: 'card-fields' },
      summaryFields(type).map((field) => fieldDisplay(field, fieldValue(note, field), { db: app.db, compact: true })),
      tagChips(note)),
    preview && preview !== title && h('span', { class: 'card-preview' }, preview),
  ];
}

export function cardsView(notes, type, { selection } = {}) {
  const selecting = selection?.isActive();
  const grid = h('div', { class: `card-grid${selecting ? ' is-selecting' : ''}` });
  const more = paged(notes, grid, (note) => {
    const noteType = app.db.getType(note.typeId);
    return h('article', { class: `card${selecting && selection.isSelected(note.id) ? ' is-selected' : ''}`, dataset: { id: note.id } },
      selecting && selection.checkbox(note, titleOf(note)),
      h('a', {
        class: 'card-link',
        href: `#/note/${encodeURIComponent(note.id)}`,
        onClick: selecting ? (event) => {
          event.preventDefault();
          selection.toggle(note.id, event);
        } : null,
      }, cardBody(note, noteType.id === type.id ? type : noteType)),
      !selecting && h('button', {
        class: 'icon-btn card-menu',
        type: 'button',
        'aria-label': `Actions for ${titleOf(note)}`,
        'aria-haspopup': 'menu',
        onClick: (event) => openMenu(event.currentTarget, noteMenuItems(note), { label: 'Note actions' }),
      }, icon('more', 16)));
  });
  return h('div', null, grid, more);
}

// -- Kanban -------------------------------------------------------------------------------

/**
 * Board grouped by a select field. Cards move by dragging the grip (mouse or touch), with
 * Alt+Left and Alt+Right when focused, or through a card's menu.
 */
export function kanbanView(notes, type, groupField) {
  const columnsNames = [...(groupField.options ?? [])];
  for (const note of notes) {
    const value = fieldValue(note, groupField);
    if (value && !columnsNames.includes(value)) columnsNames.push(value);
  }
  const names = [...columnsNames, ''];
  const label = (name) => name || `No ${groupField.name.toLowerCase()}`;

  function moveTo(note, value) {
    if (fieldValue(note, groupField) === value) return;
    withUndo(`Moved to ${label(value)}`, () => app.db.updateNote(note.id, {
      fields: { ...note.fields, [groupField.id]: value },
    }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`.kanban-card[data-id="${CSS.escape(note.id)}"] .kanban-link`)?.focus();
    }));
  }

  function card(note) {
    const noteType = app.db.getType(note.typeId);
    const grip = h('button', {
      class: 'kanban-grip', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: 'Drag to another column',
    }, icon('grip', 14));
    const element = h('article', { class: 'kanban-card', dataset: { id: note.id } },
      grip,
      h('a', {
        class: 'kanban-link',
        href: `#/note/${encodeURIComponent(note.id)}`,
        onKeydown: (event) => {
          if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            const index = names.indexOf(fieldValue(note, groupField));
            const next = names[index + (event.key === 'ArrowRight' ? 1 : -1)];
            if (next !== undefined) moveTo(note, next);
          }
        },
      }, cardBody(note, { ...noteType, fields: noteType.fields.filter((f) => f.id !== groupField.id) })),
      h('button', {
        class: 'icon-btn card-menu',
        type: 'button',
        'aria-label': `Actions for ${titleOf(note)}`,
        'aria-haspopup': 'menu',
        onClick: (event) => openMenu(event.currentTarget, [
          ...names.filter((name) => name !== fieldValue(note, groupField)).map((name) => ({
            label: `Move to ${label(name)}`, icon: 'move', onSelect: () => moveTo(note, name),
          })),
          'separator',
          ...noteMenuItems(note),
        ], { label: 'Note actions' }),
      }, icon('more', 16)));
    attachCardDrag(grip, element, note);
    return element;
  }

  function attachCardDrag(grip, element, note) {
    let ghost = null;
    let targetColumn = null;
    const clear = () => {
      ghost?.remove();
      ghost = null;
      element.classList.remove('is-dragging');
      document.body.classList.remove('is-pointer-dragging');
      board.querySelectorAll('.is-drop-target').forEach((c) => c.classList.remove('is-drop-target'));
    };
    pointerDrag(grip, {
      start: () => {
        const box = element.getBoundingClientRect();
        ghost = element.cloneNode(true);
        ghost.classList.add('kanban-ghost');
        ghost.style.width = `${box.width}px`;
        document.body.append(ghost);
        element.classList.add('is-dragging');
        document.body.classList.add('is-pointer-dragging');
      },
      move: (event) => {
        ghost.style.transform = `translate(${event.clientX + 8}px, ${event.clientY + 8}px)`;
        const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('.kanban-column');
        if (under !== targetColumn) {
          targetColumn?.classList.remove('is-drop-target');
          under?.classList.add('is-drop-target');
          targetColumn = under ?? null;
        }
      },
      drop: () => {
        const value = targetColumn?.dataset.value;
        clear();
        if (value !== undefined) moveTo(note, value);
        targetColumn = null;
      },
      cancel: () => {
        clear();
        targetColumn = null;
      },
    });
  }

  const board = h('div', { class: 'kanban', tabindex: '0', role: 'region', 'aria-label': `Board by ${groupField.name}` },
    names.map((name) => {
      const rows = notes.filter((note) => fieldValue(note, groupField) === name);
      // An empty "no value" column would just be clutter.
      if (!name && !rows.length) return null;
      const list = h('div', { class: 'kanban-list' });
      const more = paged(rows, list, card);
      return h('section', { class: 'kanban-column', dataset: { value: name }, 'aria-label': label(name) },
        h('h2', { class: 'kanban-title' }, label(name), h('span', { class: 'kanban-count' }, rows.length)),
        list,
        more);
    }));
  return board;
}
