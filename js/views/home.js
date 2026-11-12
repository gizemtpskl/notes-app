/**
 * home.js: the dashboard, the first screen: a greeting, quick capture, and widgets in two columns
 * on a wide screen and one on a phone, in the same order.
 *
 * "Edit dashboard" turns each widget into a frame that can be dragged to a new place (or moved
 * with buttons, from the keyboard), made wide or narrow, hidden, and given options. The widgets
 * themselves are in dashboardWidgets.js, and the layout rules in data/dashboard.js.
 *
 * Everything comes from local data, so it shows at once, with or without a connection.
 */
import { app } from '../context.js';
import {
  WIDGETS, WIDGET_TYPES, dashboardLayout, defaultLayout, greeting, moveWidget, updateWidget,
} from '../data/dashboard.js';
import { toDateStr } from '../data/dates.js';
import { openDialog } from '../ui/dialog.js';
import { fill, h, longDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pointerDrag } from '../ui/pointerDrag.js';
import { dashboardCaptureField } from './capture.js';
import { WIDGET_VIEWS } from './dashboardWidgets.js';
import { openHabitsDialog } from './habitsDialog.js';
import { emptyState } from './noteList.js';

const label = (id) => WIDGETS.find((w) => w.id === id)?.label ?? id;

/** Collections a "which list" option can point at: those made for the widget's note type. */
function collectionChoices(db, widgetId) {
  const typeId = WIDGET_TYPES[widgetId];
  return db.allCollections()
    .filter((c) => c.defaultTypeId === typeId || db.listCollections(c.spaceId, c.id).some((child) => child.defaultTypeId === typeId))
    .map((c) => {
      const space = db.getSpace(c.spaceId);
      const parent = c.parentId ? db.getCollection(c.parentId) : null;
      return { id: c.id, name: [space?.name, parent?.name, c.name].filter(Boolean).join(' › ') };
    });
}

function optionsDialog(widget, save) {
  const { db } = app;
  const known = WIDGETS.find((w) => w.id === widget.id);
  return openDialog({
    title: `${known.label}: options`,
    build: (close) => {
      const parts = [];
      if (known.options?.includes('collection')) {
        const choices = collectionChoices(db, widget.id);
        parts.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, widget.id === 'course' ? 'Which course' : 'Which list'),
          h('select', {
            class: 'select',
            autofocus: true,
            onChange: (event) => save({ options: { collectionId: event.target.value } }),
          },
          h('option', { value: '', selected: !widget.options.collectionId }, widget.id === 'course' ? 'All courses' : 'All of them'),
          choices.map((c) => h('option', { value: c.id, selected: c.id === widget.options.collectionId }, c.name)))));
      }
      if (known.options?.includes('includeJournal')) {
        parts.push(h('label', { class: 'check-field' },
          h('input', {
            type: 'checkbox',
            checked: widget.options.includeJournal === true,
            onChange: (event) => save({ options: { includeJournal: event.target.checked } }),
          }),
          'Include journal entries (their titles show on the dashboard)'));
      }
      if (known.options?.includes('habits')) {
        parts.push(h('button', {
          class: 'btn', type: 'button', onClick: () => { close(); openHabitsDialog(); },
        }, icon('edit', 15), 'Manage habits'));
      }
      return h('div', null, parts, h('div', { class: 'dialog-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close() }, 'Done')));
    },
  });
}

export function homeView() {
  const { db } = app;
  const grid = h('div', { class: 'dash-grid' });
  const timers = [];
  const state = {};
  let editing = false;

  const layout = () => dashboardLayout(db.getSettings());
  const saveLayout = (next) => db.updateSettings({ homeBlocks: next });

  function view(widget, today) {
    try {
      return WIDGET_VIEWS[widget.id]({
        db, options: widget.options, today, timers, state, refresh,
      }) || null;
    } catch (error) {
      // One broken widget shouldn't take the whole dashboard with it.
      console.error(`Widget ${widget.id}:`, error);
      return null;
    }
  }

  // -- Edit mode -------------------------------------------------------------------------

  function editFrame(widget, index, all) {
    const known = WIDGETS.find((w) => w.id === widget.id);
    const save = (patch) => {
      saveLayout(updateWidget(layout(), widget.id, patch));
    };
    const grip = h('span', { class: 'dash-grip', 'aria-hidden': 'true', title: 'Drag to move' }, icon('grip', 16));
    const frame = h('section', {
      class: `dash-frame${widget.on ? '' : ' is-hidden'}${widget.size === 'wide' ? ' is-wide' : ''}`,
      dataset: { widget: widget.id },
      'aria-label': known.label,
    },
    h('div', { class: 'dash-frame-head' },
      grip,
      h('h2', { class: 'dash-frame-title' }, known.label, !widget.on && h('span', { class: 'tt-tag' }, 'Hidden')),
      h('div', { class: 'dash-frame-actions' },
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${known.label} earlier`, disabled: index === 0, dataset: { act: 'up' },
          onClick: () => { saveLayout(moveWidget(layout(), widget.id, index - 1)); refresh(`[data-widget="${widget.id}"] [data-act="up"]:not(:disabled), [data-widget="${widget.id}"] [data-act="down"]`); },
        }, icon('arrowUp', 15)),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${known.label} later`, disabled: index === all.length - 1, dataset: { act: 'down' },
          onClick: () => { saveLayout(moveWidget(layout(), widget.id, index + 1)); refresh(`[data-widget="${widget.id}"] [data-act="down"]:not(:disabled), [data-widget="${widget.id}"] [data-act="up"]`); },
        }, icon('arrowDown', 15)),
        h('button', {
          class: 'btn btn-small', type: 'button', 'aria-pressed': String(widget.size === 'wide'), dataset: { act: 'size' },
          onClick: () => { save({ size: widget.size === 'wide' ? 'normal' : 'wide' }); refresh(`[data-widget="${widget.id}"] [data-act="size"]`); },
        }, 'Wide'),
        known.options && h('button', {
          class: 'btn btn-small', type: 'button', dataset: { act: 'options' },
          onClick: () => optionsDialog(widget, save),
        }, 'Options'),
        h('button', {
          class: 'btn btn-small', type: 'button', dataset: { act: 'show' },
          onClick: () => { save({ on: !widget.on }); refresh(`[data-widget="${widget.id}"] [data-act="show"]`); },
        }, widget.on ? 'Hide' : 'Show'))),
    // A preview only: inert, so its links and buttons can't be reached while arranging.
    h('div', { class: 'dash-frame-body', inert: '' }, widget.on ? view(widget, toDateStr()) ?? h('p', { class: 'dash-stat' }, 'Hidden on its own until there’s something to show.') : null));

    // Dragging a frame onto another puts it before or after that one, by which half it's over.
    let marker = null;
    let target = null;
    pointerDrag(grip, {
      start: () => {
        frame.classList.add('is-dragged');
        marker = h('div', { class: 'dash-drop-marker', 'aria-hidden': 'true' });
      },
      move: (event) => {
        const over = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el.classList?.contains('dash-frame') && el !== frame);
        if (!over) return;
        const rect = over.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        target = { id: over.dataset.widget, after };
        over.insertAdjacentElement(after ? 'afterend' : 'beforebegin', marker);
      },
      drop: () => {
        frame.classList.remove('is-dragged');
        marker?.remove();
        if (!target) return;
        const current = layout();
        const without = current.filter((w) => w.id !== widget.id);
        const at = without.findIndex((w) => w.id === target.id) + (target.after ? 1 : 0);
        saveLayout(moveWidget(current, widget.id, at));
        target = null;
        refresh();
      },
      cancel: () => {
        frame.classList.remove('is-dragged');
        marker?.remove();
        target = null;
      },
    });
    return frame;
  }

  // -- Drawing ---------------------------------------------------------------------------

  function refresh(focusSelector) {
    timers.splice(0).forEach(clearInterval);
    const today = toDateStr();
    const active = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusId = active?.closest('[data-id]')?.dataset.id;
    const focusWidget = active?.closest('[data-widget]')?.dataset.widget;
    // A change saved by a click redraws everything: these find the same control again.
    const again = active && (active.dataset.act
      ? `[data-widget="${active.closest('[data-widget]')?.dataset.widget}"] [data-act="${active.dataset.act}"]`
      : active.dataset.check && `[data-check="${active.dataset.check}"]`);
    const all = layout();
    if (editing) {
      fill(grid, all.map((widget, index) => editFrame(widget, index, all)));
    } else {
      const built = all.filter((w) => w.on).map((widget) => {
        const content = view(widget, today);
        return content && h('div', { class: `dash-item${widget.size === 'wide' ? ' is-wide' : ''}`, dataset: { widget: widget.id } }, content);
      }).filter(Boolean);
      fill(grid,
        built,
        db.listNotes().length === 0 && h('div', { class: 'dash-item is-wide' }, emptyState({
          emoji: '🌱',
          title: 'Your notes will show up here',
          text: 'Type above and press Enter to capture your first thought. You can organize it later.',
        })));
    }
    if (focusSelector) grid.querySelector(focusSelector)?.focus();
    else if (again) grid.querySelector(again)?.focus();
    else if (focusId || focusWidget) {
      // A ticked task leaves its list: focus stays in the same widget rather than being lost.
      const same = focusId && grid.querySelector(`[data-id="${CSS.escape(focusId)}"] input, [data-id="${CSS.escape(focusId)}"] a, [data-id="${CSS.escape(focusId)}"] button`);
      (same ?? grid.querySelector(`[data-widget="${focusWidget}"] :is(input, a[href], button)`))?.focus();
    }
    fill(editBar, editing && [
      h('p', { class: 'dash-edit-hint' }, 'Drag a widget by its handle, or use the arrows. Wide widgets take both columns on a wide screen.'),
      h('button', {
        class: 'btn btn-small',
        type: 'button',
        onClick: () => { saveLayout(defaultLayout()); refresh(); },
      }, 'Reset to default')]);
    editButton.textContent = editing ? 'Done' : 'Edit dashboard';
    editButton.classList.toggle('btn-primary', editing);
    editButton.setAttribute('aria-pressed', String(editing));
  }

  const editBar = h('div', { class: 'dash-edit-bar' });
  const editButton = h('button', {
    class: 'btn btn-small',
    type: 'button',
    onClick: () => {
      editing = !editing;
      refresh();
      editButton.focus();
    },
  });

  const title = h('h1', { class: 'page-title', tabindex: '-1' }, greeting(new Date().getHours()));
  refresh();

  return {
    title: 'Dashboard',
    el: h('div', { class: 'page page-wide dashboard' },
      h('header', { class: 'page-head' },
        h('p', { class: 'page-eyebrow' }, longDate(Date.now())),
        h('div', { class: 'page-title-row' }, title, h('div', { class: 'page-actions' }, editButton))),
      dashboardCaptureField(),
      editBar,
      grid),
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('spaces') || change.stores.has('collections') || change.stores.has('savedViews')
        || change.stores.has('timeBlocks') || change.stores.has('semesters') || change.stores.has('habits') || change.stores.has('focus')
        || change.ids.has('settings') || change.ids.has('gcalEvents') || change.ids.has('gcalWeeks') || change.ids.has('lastExportAt')) refresh();
    },
    destroy: () => timers.splice(0).forEach(clearInterval),
  };
}
