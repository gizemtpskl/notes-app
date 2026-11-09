/**
 * selection.js: choosing several notes, and the bar of actions for them.
 *
 * Lists show check boxes while selecting. Clicking a row toggles it, and Shift-click selects a
 * range. "Select all" covers the whole list, including rows not loaded yet.
 */
import { app } from '../context.js';
import { fill, h, plural } from '../ui/dom.js';
import { openDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { archiveNotes, moveNotes, purgeNotes, restoreNotes, trashNotes, unarchiveNotes, withUndo } from './actions.js';
import { pickDestination } from './dialogs.js';

/** Asks for a tag, with suggestions. Resolves with a name, or undefined. */
function askTag(count) {
  return openDialog({
    title: `Tag ${plural(count, 'note')}`,
    build: (close) => {
      const list = h('datalist', { id: 'bulk-tags' }, app.db.listTags().map((tag) => h('option', { value: tag.name })));
      const input = h('input', {
        class: 'input', type: 'text', autofocus: true, required: true, list: 'bulk-tags', autocomplete: 'off', 'aria-label': 'Tag', placeholder: 'A new or existing tag',
      });
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          if (input.value.trim()) close(input.value.trim());
        },
      }, input, list,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add tag')));
    },
  });
}

/** The actions on offer, by what kind of list this is. */
function actionsFor(kind, ids, done) {
  const { db } = app;
  const run = (fn) => () => {
    const list = ids();
    if (list.length) {
      Promise.resolve(fn(list)).then((finished) => {
        if (finished !== false) done();
      });
    }
  };
  if (kind === 'trash') {
    return [
      { label: 'Restore', icon: 'restore', run: run((list) => restoreNotes(list)) },
      { label: 'Delete forever', icon: 'trash', danger: true, run: run((list) => purgeNotes(list)) },
    ];
  }
  if (kind === 'archived') {
    return [
      { label: 'Unarchive', icon: 'restore', run: run((list) => unarchiveNotes(list)) },
      { label: 'Delete', icon: 'trash', danger: true, run: run((list) => trashNotes(list)) },
    ];
  }
  return [
    {
      label: 'Move',
      icon: 'move',
      run: run(async (list) => {
        const target = await pickDestination({ title: `Move ${plural(list.length, 'note')} to` });
        if (!target) return false;
        moveNotes(list, target);
        return true;
      }),
    },
    {
      label: 'Tag',
      icon: 'tag',
      run: run(async (list) => {
        const name = await askTag(list.length);
        if (!name) return false;
        withUndo(`Tagged ${plural(list.length, 'note')} #${name}`, () => {
          const tag = db.ensureTag(name);
          db.addTagToNotes(list, tag.id);
        });
        return true;
      }),
    },
    {
      label: 'Change type',
      icon: 'edit',
      menu: () => db.listTypes().map((type) => ({
        label: `${type.icon}  ${type.name}`,
        onSelect: () => {
          const list = ids();
          withUndo(`Changed ${plural(list.length, 'note')} to ${type.name}`, () => db.batch(() => list.forEach((id) => db.setNoteType(id, type.id))));
          done();
        },
      })),
    },
    { label: 'Archive', icon: 'archive', run: run((list) => archiveNotes(list)) },
    { label: 'Delete', icon: 'trash', danger: true, run: run((list) => trashNotes(list)) },
  ];
}

/**
 * options:
 *   kind      'active' | 'archived' | 'trash'
 *   getIds    () => every note id in the current list, in order
 *   onMode    () => called when selecting starts or stops, to redraw the list
 */
export function createSelection({ kind = 'active', getIds, onMode }) {
  const selected = new Set();
  let active = false;
  let anchor = null;
  const count = h('span', { class: 'bulk-count', role: 'status' });
  const bar = h('div', { class: 'bulk-bar', role: 'toolbar', 'aria-label': 'Actions for selected notes', hidden: true });

  const button = h('button', {
    class: 'btn btn-small select-toggle',
    type: 'button',
    'aria-pressed': 'false',
    onClick: () => setActive(!active),
  }, icon('check', 15), 'Select');

  function setActive(next) {
    if (next === active) return;
    active = next;
    selected.clear();
    anchor = null;
    button.setAttribute('aria-pressed', String(active));
    document.body.classList.toggle('has-bulk', active);
    renderBar();
    onMode();
  }

  const finish = () => setActive(false);

  function renderBar() {
    bar.hidden = !active;
    if (!active) return;
    count.textContent = `${selected.size.toLocaleString()} selected`;
    const all = getIds();
    const hasAny = selected.size > 0;
    fill(bar,
      count,
      h('button', {
        class: 'btn-link',
        type: 'button',
        onClick: () => {
          if (selected.size === all.length) selected.clear();
          else all.forEach((id) => selected.add(id));
          syncRows();
          renderBar();
        },
      }, selected.size === all.length && all.length ? 'Select none' : `Select all (${all.length.toLocaleString()})`),
      h('span', { class: 'bulk-actions' },
        actionsFor(kind, () => [...selected], finish).map((action) => h('button', {
          class: `btn btn-small${action.danger ? ' btn-danger-quiet' : ''}`,
          type: 'button',
          disabled: !hasAny,
          'aria-haspopup': action.menu ? 'menu' : null,
          onClick: action.menu ? (event) => openMenu(event.currentTarget, action.menu(), { label: action.label }) : action.run,
        }, icon(action.icon, 15), action.label))),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Stop selecting', title: 'Stop selecting (Esc)', onClick: finish,
      }, icon('close', 16)));
  }

  /** Updates check boxes in place, so the list doesn't redraw or lose its scroll position. */
  function syncRows() {
    for (const row of document.querySelectorAll('.is-selecting [data-id]')) {
      const on = selected.has(row.dataset.id);
      row.classList.toggle('is-selected', on);
      const box = row.querySelector('.row-check');
      if (box) box.checked = on;
    }
  }

  function toggle(id, event) {
    if (event?.shiftKey && anchor) {
      const all = getIds();
      const from = all.indexOf(anchor);
      const to = all.indexOf(id);
      if (from !== -1 && to !== -1) {
        const on = !selected.has(id);
        for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
          if (on) selected.add(all[i]);
          else selected.delete(all[i]);
        }
      }
    } else if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }
    anchor = id;
    syncRows();
    renderBar();
  }

  /** Notes that left the list can no longer be acted on. */
  function prune() {
    if (!active) return;
    const all = new Set(getIds());
    for (const id of selected) if (!all.has(id)) selected.delete(id);
    renderBar();
  }

  const onKey = (event) => {
    if (event.key === 'Escape' && active && !document.querySelector('dialog[open]') && !document.querySelector('.menu')) {
      event.preventDefault();
      finish();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    button,
    bar,
    isActive: () => active,
    isSelected: (id) => selected.has(id),
    toggle,
    prune,
    stop: finish,
    destroy() {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-bulk');
    },
    /** A check box for a row. */
    checkbox(note, title) {
      return h('input', {
        class: 'row-check',
        type: 'checkbox',
        checked: selected.has(note.id),
        'aria-label': `Select ${title}`,
        onClick: (event) => {
          event.stopPropagation();
          toggle(note.id, event);
        },
      });
    },
  };
}
