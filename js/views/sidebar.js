/**
 * sidebar.js: the left navigation: Inbox, Home, Spaces and their Collections, Favorites,
 * Archive, Trash and Settings. Supports drag to reorder and nest. Everything that can be
 * dragged is also available from the "..." menu, for keyboard and touch use.
 */
import { app } from '../context.js';
import { RuleError } from '../data/schema.js';
import { markdownExport } from '../data/porting.js';
import { confirmDialog } from '../ui/dialog.js';
import { downloadBlob, fill, h, plural } from '../ui/dom.js';
import { dragging, endDrag, startDrag } from '../ui/drag.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { moveNotes, newNote, showError, withUndo } from './actions.js';
import { editCollectionDialog, editSpaceDialog, pickDestination } from './dialogs.js';
import { viewMenuItems } from './savedViews.js';
import { globalBuckets } from './tasksAgenda.js';

export function createSidebar() {
  const nav = h('nav', { class: 'sidebar-nav', 'aria-label': 'Main' });
  let activeRoute = '';

  const collapsed = () => app.db.getMeta('ui', {}).collapsed ?? {};

  function toggleCollapsed(id) {
    const ui = app.db.getMeta('ui', {});
    const next = { ...(ui.collapsed ?? {}) };
    if (next[id]) delete next[id];
    else next[id] = true;
    app.db.setMeta('ui', { ...ui, collapsed: next });
    render();
  }

  function link({ route, iconName, emoji, label, count, attention, focusKey }) {
    const current = activeRoute === route;
    return h('a', {
      class: `nav-link${current ? ' is-current' : ''}`,
      href: `#/${route}`,
      'aria-current': current ? 'page' : null,
      dataset: { focusKey },
      onClick: () => app.setSidebarOpen(false),
    },
    emoji ? h('span', { class: 'nav-emoji', 'aria-hidden': 'true' }, emoji) : iconName && icon(iconName),
    h('span', { class: 'nav-label' }, label),
    count > 0 && h('span', { class: `nav-count${attention ? ' nav-count-attention' : ''}` },
      h('span', { class: 'sr-only' }, ', '),
      count.toLocaleString(),
      h('span', { class: 'sr-only' }, count === 1 ? ' note' : ' notes')));
  }

  function moreButton(name, items, focusKey) {
    return h('button', {
      class: 'icon-btn nav-more',
      type: 'button',
      'aria-label': `Actions for ${name}`,
      'aria-haspopup': 'menu',
      dataset: { focusKey },
      onClick: (event) => {
        event.preventDefault();
        openMenu(event.currentTarget, items(), { label: `${name} actions` });
      },
    }, icon('more', 16));
  }

  // -- Menus -----------------------------------------------------------------------------

  function spaceMenu(space, index, total) {
    return [
      { label: 'New note here', icon: 'plus', onSelect: () => newNote({ spaceId: space.id }) },
      {
        label: 'New collection',
        icon: 'folder',
        onSelect: () => editCollectionDialog({ spaceId: space.id }),
      },
      { label: 'Edit space', icon: 'edit', onSelect: () => editSpaceDialog(space) },
      'separator',
      { label: 'Move up', icon: 'arrowUp', disabled: index === 0, onSelect: () => app.db.moveSpace(space.id, index - 1) },
      { label: 'Move down', icon: 'arrowDown', disabled: index === total - 1, onSelect: () => app.db.moveSpace(space.id, index + 1) },
      'separator',
      { label: 'Delete space', icon: 'trash', danger: true, onSelect: () => deleteSpace(space) },
    ];
  }

  async function deleteSpace(space) {
    const count = app.db.listNotes({ status: 'all', spaceId: space.id }).length;
    const collections = app.db.allCollections().filter((c) => c.spaceId === space.id).length;
    const ok = await confirmDialog({
      title: `Delete "${space.name}"?`,
      message: `${plural(collections, 'collection')} will be removed. ${count ? `${plural(count, 'note')} will move to the Inbox, so nothing is lost.` : 'It has no notes.'}`,
      confirmLabel: 'Delete space',
      danger: true,
    });
    if (ok) {
      if (activeRoute === `space/${space.id}` || isInSpace(space.id)) app.navigate('home');
      withUndo(`Deleted ${space.name}`, () => app.db.deleteSpace(space.id));
    }
  }

  function isInSpace(spaceId) {
    const id = activeRoute.startsWith('collection/') ? activeRoute.slice(11) : null;
    return id && app.db.getCollection(id)?.spaceId === spaceId;
  }

  function collectionMenu(col, index, total) {
    const nestedCount = app.db.listCollections(col.spaceId, col.id).length;
    return [
      { label: 'New note here', icon: 'plus', onSelect: () => newNote({ collectionId: col.id }) },
      !col.parentId && {
        label: 'New sub-collection',
        icon: 'folder',
        onSelect: () => editCollectionDialog({ spaceId: col.spaceId, parentId: col.id }),
      },
      { label: 'Edit collection', icon: 'edit', onSelect: () => editCollectionDialog({ collection: col }) },
      'separator',
      { label: 'Move up', icon: 'arrowUp', disabled: index === 0, onSelect: () => moveCollection(col, { spaceId: col.spaceId, parentId: col.parentId, index: index - 1 }) },
      { label: 'Move down', icon: 'arrowDown', disabled: index === total - 1, onSelect: () => moveCollection(col, { spaceId: col.spaceId, parentId: col.parentId, index: index + 1 }) },
      {
        label: 'Move to…',
        icon: 'move',
        onSelect: async () => {
          const target = await pickDestination({
            title: `Move "${col.name}" to`, includeInbox: false, nestable: true, excludeId: col.id,
          });
          if (target) {
            moveCollection(col, { spaceId: target.spaceId, parentId: target.collectionId }, `Moved ${col.name}`);
          }
        },
      },
      'separator',
      { label: 'Export as Markdown', icon: 'download', onSelect: () => exportCollection(col) },
      {
        label: 'Delete collection',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const count = app.db.listNotes({ status: 'all', collectionId: col.id }).length;
          const home = col.parentId ? app.db.getCollection(col.parentId)?.name : app.db.getSpace(col.spaceId)?.name;
          const parts = [];
          if (count) parts.push(`${plural(count, 'note')} will move up to ${home}.`);
          if (nestedCount) parts.push(`${plural(nestedCount, 'sub-collection')} will become top-level.`);
          const ok = await confirmDialog({
            title: `Delete "${col.name}"?`,
            message: parts.join(' ') || 'It is empty.',
            confirmLabel: 'Delete collection',
            danger: true,
          });
          if (ok) {
            if (activeRoute === `collection/${col.id}`) app.navigate(col.parentId ? `collection/${col.parentId}` : `space/${col.spaceId}`);
            withUndo(`Deleted ${col.name}`, () => app.db.deleteCollection(col.id));
          }
        },
      },
    ];
  }

  async function exportCollection(col) {
    try {
      const { blob, filename } = await markdownExport(app.db, { kind: 'collection', id: col.id });
      downloadBlob(blob, filename);
    } catch (error) {
      showError(error);
    }
  }

  function moveCollection(col, target, message) {
    try {
      if (message) withUndo(message, () => app.db.moveCollection(col.id, target));
      else app.db.moveCollection(col.id, target);
    } catch (error) {
      showError(error);
    }
  }

  // -- Drag and drop ---------------------------------------------------------------------

  function clearDropMarks() {
    for (const el of nav.querySelectorAll('[data-drop]')) delete el.dataset.drop;
  }

  /** Top and bottom edges mean "next to it", the middle means "into it". */
  function dropZone(event, el, allowInto) {
    const box = el.getBoundingClientRect();
    const y = (event.clientY - box.top) / box.height;
    if (!allowInto) return y < 0.5 ? 'before' : 'after';
    if (y < 0.28) return 'before';
    if (y > 0.72) return 'after';
    return 'into';
  }

  /** target: { zones(drag) => boolean allowInto or null to refuse, drop(drag, zone) } */
  function dropTarget(el, { accepts, intoAllowed, drop }) {
    el.addEventListener('dragover', (event) => {
      const drag = dragging();
      if (!drag || !accepts(drag)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      el.dataset.drop = dropZone(event, el, intoAllowed(drag));
    });
    el.addEventListener('dragleave', () => {
      delete el.dataset.drop;
    });
    el.addEventListener('drop', (event) => {
      const drag = dragging();
      if (!drag || !accepts(drag)) return;
      event.preventDefault();
      event.stopPropagation();
      const zone = el.dataset.drop ?? 'into';
      clearDropMarks();
      endDrag();
      try {
        drop(drag, zone);
      } catch (error) {
        if (!(error instanceof RuleError)) console.error(error);
        showError(error);
      }
    });
  }

  function makeDraggable(el, payload) {
    el.draggable = true;
    el.addEventListener('dragstart', (event) => {
      event.stopPropagation();
      startDrag(event, payload);
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => {
      endDrag();
      el.classList.remove('is-dragging');
      clearDropMarks();
    });
  }

  function spaceDropRules(space, index) {
    return {
      accepts: (drag) => drag.kind === 'note' || drag.kind === 'collection' || (drag.kind === 'space' && drag.id !== space.id),
      intoAllowed: (drag) => drag.kind !== 'space',
      drop: (drag, zone) => {
        if (drag.kind === 'note') {
          moveNotes([drag.id], { spaceId: space.id });
        } else if (drag.kind === 'collection') {
          moveCollection(app.db.getCollection(drag.id), { spaceId: space.id, parentId: null }, 'Collection moved');
        } else {
          const from = app.db.listSpaces().findIndex((s) => s.id === drag.id);
          let to = zone === 'before' ? index : index + 1;
          if (from < to) to -= 1;
          app.db.moveSpace(drag.id, to);
        }
      },
    };
  }

  function collectionDropRules(col, index) {
    const canNestInto = (drag) => drag.kind === 'collection'
      && !col.parentId
      && drag.id !== col.id
      && app.db.listCollections(app.db.getCollection(drag.id)?.spaceId, drag.id).length === 0;
    return {
      accepts: (drag) => drag.kind === 'note' || (drag.kind === 'collection' && drag.id !== col.id),
      intoAllowed: (drag) => drag.kind === 'note' || canNestInto(drag),
      drop: (drag, zone) => {
        if (drag.kind === 'note') {
          moveNotes([drag.id], { collectionId: col.id });
        } else if (zone === 'into') {
          moveCollection(app.db.getCollection(drag.id), { parentId: col.id }, `Moved into ${col.name}`);
        } else {
          const dragged = app.db.getCollection(drag.id);
          const sameLevel = dragged.spaceId === col.spaceId && dragged.parentId === col.parentId;
          const siblings = app.db.listCollections(col.spaceId, col.parentId);
          const from = sameLevel ? siblings.findIndex((c) => c.id === drag.id) : -1;
          let to = zone === 'before' ? index : index + 1;
          if (from !== -1 && from < to) to -= 1;
          app.db.moveCollection(drag.id, { spaceId: col.spaceId, parentId: col.parentId, index: to });
        }
      },
    };
  }

  // -- Rendering -------------------------------------------------------------------------

  function renderCollection(col, index, total, counts, depth) {
    const children = depth === 0 ? app.db.listCollections(col.spaceId, col.id) : [];
    const isCollapsed = collapsed()[col.id];
    const route = `collection/${col.id}`;
    const row = h('div', { class: 'nav-row nav-row-collection', cssVars: { '--depth': depth } },
      children.length
        ? h('button', {
          class: 'icon-btn nav-toggle',
          type: 'button',
          'aria-expanded': String(!isCollapsed),
          'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${col.name}`,
          dataset: { focusKey: `toggle-${col.id}` },
          onClick: () => toggleCollapsed(col.id),
        }, icon(isCollapsed ? 'chevronRight' : 'chevronDown', 14))
        : h('span', { class: 'nav-toggle-gap' }),
      link({
        route, label: col.name, count: counts.collections.get(col.id), focusKey: route,
      }),
      moreButton(col.name, () => collectionMenu(col, index, total), `more-${col.id}`));
    makeDraggable(row, { kind: 'collection', id: col.id, label: col.name });
    dropTarget(row, collectionDropRules(col, index));
    return h('li', null,
      row,
      children.length > 0 && !isCollapsed && h('ul', { class: 'nav-list' },
        children.map((child, i) => renderCollection(child, i, children.length, counts, depth + 1))));
  }

  function renderSpace(space, index, total, counts) {
    const cols = app.db.listCollections(space.id);
    const isCollapsed = collapsed()[space.id];
    const route = `space/${space.id}`;
    const row = h('div', { class: 'nav-row nav-row-space', dataset: { color: space.color } },
      h('button', {
        class: 'icon-btn nav-toggle',
        type: 'button',
        'aria-expanded': String(!isCollapsed),
        'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${space.name}`,
        dataset: { focusKey: `toggle-${space.id}` },
        onClick: () => toggleCollapsed(space.id),
      }, icon(isCollapsed ? 'chevronRight' : 'chevronDown', 14)),
      link({
        route, emoji: space.icon, label: space.name, count: counts.spaces.get(space.id), focusKey: route,
      }),
      moreButton(space.name, () => spaceMenu(space, index, total), `more-${space.id}`));
    makeDraggable(row, { kind: 'space', id: space.id, label: space.name });
    dropTarget(row, spaceDropRules(space, index));
    return h('li', { class: 'nav-space' },
      row,
      !isCollapsed && cols.length > 0 && h('ul', { class: 'nav-list' },
        cols.map((col, i) => renderCollection(col, i, cols.length, counts, 0))));
  }

  /** Tasks and deadlines due today or overdue. They live inside notes, so this needs its own count. */
  function dueCount() {
    const buckets = globalBuckets();
    return buckets.today.length + buckets.overdue.length;
  }

  let lastDue = 0;

  function render() {
    const { db } = app;
    lastDue = dueCount();
    const counts = db.counts();
    const focusKey = nav.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const spaces = db.listSpaces();

    const inboxRow = h('div', { class: 'nav-row' },
      link({
        route: 'inbox', iconName: 'inbox', label: 'Inbox', count: counts.inbox, attention: true, focusKey: 'inbox',
      }));
    dropTarget(inboxRow, {
      accepts: (drag) => drag.kind === 'note',
      intoAllowed: () => true,
      drop: (drag) => moveNotes([drag.id], { spaceId: null, collectionId: null }),
    });

    const views = db.listSavedViews();
    const pinnedViews = views.filter((view) => view.pinned);

    fill(nav,
      h('ul', { class: 'nav-list' },
        h('li', null, inboxRow),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'home', iconName: 'home', label: 'Dashboard', focusKey: 'home' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'today', iconName: 'calendar', label: 'Today', count: lastDue, focusKey: 'today' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'timetable', iconName: 'clock', label: 'Timetable', focusKey: 'timetable' })))),
      h('div', { class: 'nav-section-head' },
        h('h2', { class: 'nav-heading', id: 'nav-spaces' }, 'Spaces'),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'New space',
          title: 'New space',
          dataset: { focusKey: 'new-space' },
          onClick: () => editSpaceDialog(),
        }, icon('plus', 16))),
      spaces.length
        ? h('ul', { class: 'nav-list', 'aria-labelledby': 'nav-spaces' }, spaces.map((space, i) => renderSpace(space, i, spaces.length, counts)))
        : h('p', { class: 'nav-empty' }, 'No spaces yet. Add one for each big area of your life.'),
      pinnedViews.length > 0 && h('div', { class: 'nav-section-head' }, h('h2', { class: 'nav-heading', id: 'nav-views' }, 'Views')),
      pinnedViews.length > 0 && h('ul', { class: 'nav-list', 'aria-labelledby': 'nav-views' }, pinnedViews.map((view) => {
        const route = `view/${view.id}`;
        const index = views.indexOf(view);
        return h('li', null, h('div', { class: 'nav-row' },
          link({ route, emoji: view.icon, label: view.name, focusKey: route }),
          moreButton(view.name, () => viewMenuItems(view, index, views.length), `more-${view.id}`)));
      })),
      h('ul', { class: 'nav-list nav-list-bottom' },
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'tags', iconName: 'tag', label: 'Tags', focusKey: 'tags' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'views', iconName: 'bookmark', label: 'Saved views', focusKey: 'views' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'review', iconName: 'check', label: 'Weekly review', focusKey: 'review' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'favorites', iconName: 'star', label: 'Favorites', count: counts.favorites, focusKey: 'favorites' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'archive', iconName: 'archive', label: 'Archive', count: counts.archive, focusKey: 'archive' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'trash', iconName: 'trash', label: 'Trash', count: counts.trash, focusKey: 'trash' }))),
        h('li', null, h('div', { class: 'nav-row' }, link({ route: 'settings', iconName: 'settings', label: 'Settings', focusKey: 'settings' }))),
        db.storage.encrypted && h('li', null, h('div', { class: 'nav-row' },
          h('button', {
            class: 'nav-link nav-button', type: 'button', dataset: { focusKey: 'lock' }, onClick: () => app.lockNow(),
          }, icon('lock'), h('span', { class: 'nav-label' }, 'Lock now'))))),
    );

    if (focusKey) nav.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  return {
    el: nav,
    render,
    /** Ticking a task doesn't change the sidebar's structure, but it can change this one number. */
    refreshDue() {
      const count = dueCount();
      if (count !== lastDue) render();
    },
    setActive(route) {
      activeRoute = route;
      for (const anchor of nav.querySelectorAll('.nav-link')) {
        const current = anchor.getAttribute('href') === `#/${route}`;
        anchor.classList.toggle('is-current', current);
        if (current) anchor.setAttribute('aria-current', 'page');
        else anchor.removeAttribute('aria-current');
      }
    },
  };
}
