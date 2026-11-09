/**
 * tags.js: tags on a note with autocomplete, the tag manager (rename, merge, delete), and the
 * page for one tag.
 */
import { app } from '../context.js';
import { unionType } from '../data/types.js';
import { emptyFilter } from '../data/filters.js';
import { fold } from '../data/text.js';
import { fill, h, plural } from '../ui/dom.js';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { showError, withUndo } from './actions.js';
import { notFound } from './folder.js';
import { emptyState } from './noteList.js';
import { notesPresenter } from './presenter.js';

const SUGGESTION_LIMIT = 8;

export const tagHref = (id) => `#/tag/${encodeURIComponent(id)}`;

/**
 * Tags of one note. The text box stays the same element while chips change, so adding several
 * tags in a row keeps the caret.
 */
export function tagEditor({ noteId, readOnly = false }) {
  const { db } = app;
  const chips = h('span', { class: 'tag-chips' });
  const list = h('div', { class: 'tag-suggest', role: 'listbox', 'aria-label': 'Tag suggestions', id: `tag-list-${noteId}`, hidden: true });
  let matches = [];
  let active = -1;

  const input = h('input', {
    class: 'tag-input',
    type: 'text',
    placeholder: 'Add tag',
    autocomplete: 'off',
    role: 'combobox',
    'aria-label': 'Add a tag',
    'aria-expanded': 'false',
    'aria-controls': list.id,
    'aria-autocomplete': 'list',
    onInput: () => suggest(),
    onFocus: () => suggest(),
    onBlur: () => setTimeout(close, 120),
    onKeydown: (event) => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!matches.length) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + matches.length) % matches.length;
        renderList();
      } else if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        add(matches[active]?.name ?? input.value);
      } else if (event.key === 'Tab' && active >= 0) {
        event.preventDefault();
        add(matches[active].name);
      } else if (event.key === 'Backspace' && !input.value) {
        const note = db.getNote(noteId);
        const last = note?.tagIds.at(-1);
        if (last) db.removeTag(noteId, last);
      } else if (event.key === 'Escape' && !list.hidden) {
        event.stopPropagation();
        close();
      }
    },
  });

  function add(name) {
    if (name?.trim()) {
      try {
        db.addTag(noteId, name);
      } catch (error) {
        showError(error);
      }
    }
    input.value = '';
    close();
    render();
  }

  function close() {
    list.hidden = true;
    matches = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function suggest() {
    const note = db.getNote(noteId);
    if (!note) return;
    const q = fold(input.value.trim().replace(/^#+/, ''));
    const mine = new Set(note.tagIds);
    const { tags } = db.counts();
    const others = db.listTags().filter((tag) => !mine.has(tag.id));
    const found = q
      ? others.filter((tag) => fold(tag.name).includes(q)).sort((a, b) => Number(fold(b.name).startsWith(q)) - Number(fold(a.name).startsWith(q)))
      : others.sort((a, b) => (tags.get(b.id) ?? 0) - (tags.get(a.id) ?? 0));
    matches = found.slice(0, SUGGESTION_LIMIT).map((tag) => ({ name: tag.name, count: tags.get(tag.id) ?? 0 }));
    const exact = q && db.findTagByName(input.value);
    if (q && !exact) matches.push({ name: input.value.trim().replace(/^#+/, ''), isNew: true });
    active = q ? 0 : -1;
    renderList();
  }

  function renderList() {
    fill(list, matches.map((match, index) => h('button', {
      class: `tag-option${index === active ? ' is-active' : ''}`,
      id: `${list.id}-${index}`,
      type: 'button',
      role: 'option',
      tabindex: '-1',
      'aria-selected': String(index === active),
      onMousedown: (event) => {
        event.preventDefault();
        add(match.name);
      },
    }, match.isNew ? `Create "${match.name}"` : match.name, !match.isNew && h('span', { class: 'tag-option-count' }, match.count))));
    list.hidden = !matches.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    const note = db.getNote(noteId);
    if (!note) return;
    fill(chips, note.tagIds.map((id) => db.getTag(id)).filter(Boolean).map((tag) => h('span', { class: 'chip tag-chip', dataset: { tag: tag.name } },
      h('a', { class: 'tag-link', href: tagHref(tag.id) }, h('span', { 'aria-hidden': 'true' }, '#'), tag.name),
      !readOnly && h('button', {
        class: 'tag-remove',
        type: 'button',
        'aria-label': `Remove tag ${tag.name}`,
        title: 'Remove tag',
        onClick: () => db.removeTag(noteId, tag.id),
      }, icon('close', 11)))));
  }

  render();

  return {
    el: h('div', { class: 'note-tags' }, chips, !readOnly && h('span', { class: 'tag-input-wrap' }, input, list)),
    render,
    focus: () => input.focus(),
  };
}

/** Chooses a tag from a list. Resolves with its id, or undefined. */
function pickTag({ title, excludeId }) {
  const { db } = app;
  return openDialog({
    title,
    build: (close) => {
      const select = h('select', { class: 'select select-field', 'aria-label': 'Tag', autofocus: true },
        db.listTags().filter((tag) => tag.id !== excludeId).map((tag) => h('option', { value: tag.id }, tag.name)));
      return h('form', {
        onSubmit: (event) => {
          event.preventDefault();
          close(select.value);
        },
      }, select,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Merge')));
    },
  });
}

async function renameTag(tag) {
  const name = await promptDialog({
    title: `Rename #${tag.name}`,
    label: 'New name',
    value: tag.name,
    confirmLabel: 'Rename',
    validate: (text) => (text.replace(/^#+/, '').trim() ? '' : 'A tag needs a name.'),
  });
  if (!name || name === tag.name) return;
  const other = app.db.findTagByName(name);
  const merges = other && other.id !== tag.id;
  if (merges && !await confirmDialog({
    title: `Merge with #${other.name}?`,
    message: `A tag called "${other.name}" already exists. Notes tagged #${tag.name} will get #${other.name} instead.`,
    confirmLabel: 'Merge',
  })) return;
  withUndo(merges ? `Merged into #${other.name}` : `Renamed to #${name}`, () => app.db.renameTag(tag.id, name));
}

async function mergeTag(tag) {
  const { db } = app;
  if (db.listTags().length < 2) return;
  const targetId = await pickTag({ title: `Merge #${tag.name} into`, excludeId: tag.id });
  if (targetId) withUndo(`Merged into #${db.getTag(targetId).name}`, () => db.mergeTags([tag.id], targetId));
}

async function deleteTag(tag, count) {
  const ok = await confirmDialog({
    title: `Delete #${tag.name}?`,
    message: count ? `It will be removed from ${plural(count, 'note')}. The notes themselves stay.` : 'No notes use it.',
    confirmLabel: 'Delete tag',
    danger: true,
  });
  if (ok) withUndo(`Deleted #${tag.name}`, () => app.db.deleteTag(tag.id));
}

export function tagsPageView() {
  const { db } = app;
  const body = h('div');
  const orphanButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => {
      const orphans = db.orphanTags();
      withUndo(`Deleted ${plural(orphans.length, 'unused tag')}`, () => orphans.forEach((tag) => db.deleteTag(tag.id)));
    },
  });

  function refresh() {
    const tags = db.listTags();
    const { tags: counts } = db.counts();
    const orphans = db.orphanTags();
    orphanButton.hidden = !orphans.length;
    orphanButton.textContent = `Delete ${plural(orphans.length, 'unused tag')}`;
    const focusKey = body.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    fill(body, tags.length
      ? h('ul', { class: 'tag-rows' }, tags.map((tag) => {
        const count = counts.get(tag.id) ?? 0;
        return h('li', { class: 'tag-row', dataset: { id: tag.id } },
          h('a', { class: 'tag-row-link', href: tagHref(tag.id) },
            h('span', { class: 'tag-row-name' }, h('span', { 'aria-hidden': 'true' }, '#'), tag.name),
            h('span', { class: 'tag-row-count' }, count ? plural(count, 'note') : 'Unused')),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Actions for ${tag.name}`,
            'aria-haspopup': 'menu',
            onClick: (event) => openMenu(event.currentTarget, [
              { label: 'Rename', icon: 'edit', onSelect: () => renameTag(tag) },
              { label: 'Merge into…', icon: 'move', disabled: tags.length < 2, onSelect: () => mergeTag(tag) },
              'separator',
              { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteTag(tag, count) },
            ], { label: `${tag.name} actions` }),
          }, icon('more')));
      }))
      : emptyState({
        emoji: '🏷️',
        title: 'No tags yet',
        text: 'Tags cut across spaces and collections. Add one under any note\'s title, and it appears here.',
      }));
    if (focusKey) body.querySelector(`[data-id="${CSS.escape(focusKey)}"] a`)?.focus();
  }

  refresh();
  return {
    title: 'Tags',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, 'Tags'),
          h('div', { class: 'page-actions' }, orphanButton)),
        h('p', { class: 'page-sub' }, 'Rename, merge or delete tags. Renaming a tag to an existing name merges them.')),
      body),
    update: (change) => {
      if (change.structural) refresh();
    },
  };
}

export function tagView({ id }) {
  const { db } = app;
  const tag = db.getTag(id);
  if (!tag) return notFound('This tag no longer exists.');
  const uiKey = `tagView:${id}`;

  const notesWithTag = () => db.listNotes().filter((note) => note.tagIds.includes(id));
  const typeList = () => {
    const seen = new Map();
    for (const note of notesWithTag()) seen.set(note.typeId, db.getType(note.typeId));
    return seen.size ? [...seen.values()] : [db.getType('free')];
  };
  const getType = () => unionType(typeList());

  const presenter = notesPresenter({
    getType,
    getViews: () => {
      const type = getType();
      return ['list', 'table', 'cards', ...(type.fields.some((f) => f.kind === 'select') ? ['kanban'] : []), 'calendar', 'timeline'];
    },
    getDefaultMode: () => 'list',
    getView: () => db.getMeta('ui', {})[uiKey] ?? { sort: 'updated', dir: 'desc', mode: 'list' },
    setView: (patch) => {
      const ui = db.getMeta('ui', {});
      db.setMeta('ui', { ...ui, [uiKey]: { sort: 'updated', dir: 'desc', ...ui[uiKey], ...patch } });
    },
    locked: { ...emptyFilter(), tags: [id] },
    filterTypes: typeList,
    showLocation: true,
    emptyContent: () => emptyState({
      emoji: '🏷️',
      title: `Nothing tagged #${tag.name}`,
      text: 'Add this tag under any note\'s title.',
    }),
  });
  presenter.refresh();

  return {
    title: `#${tag.name}`,
    el: h('div', { class: 'page page-wide' },
      h('header', { class: 'page-head' },
        h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, h('li', null, h('a', { href: '#/tags' }, 'Tags')), h('li', null, h('span', { 'aria-current': 'page' }, tag.name)))),
        h('div', { class: 'page-title-row' },
          h('h1', { class: 'page-title', tabindex: '-1' }, `#${tag.name}`),
          h('div', { class: 'page-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => renameTag(db.getTag(id)) }, icon('edit', 16), 'Rename')))),
      presenter.el),
    mounted: presenter.mounted,
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('meta') || change.stores.has('tags')) presenter.refresh();
    },
    reloadIf: () => {
      const now = db.getTag(id);
      return !now || now.name !== tag.name;
    },
    destroy: presenter.destroy,
  };
}
